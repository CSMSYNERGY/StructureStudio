// meetingSend.ts — the ONE place a meeting email is sent from. Migration 327, phase 2 of
// MEETINGS_SCOPE.md.
//
// THREE CALLERS, ONE PATH: book-public (a customer booking, moving or cancelling their own),
// portal-meetings (a rep doing it for them) and meeting-reminders (the cron). Each of them
// would otherwise need to load the same seven things, build the same invite, and remember to
// bump the same sequence — which is three chances to get the SEQUENCE rule wrong and leave a
// customer holding a stale time in their calendar.
//
// This mirrors why book_meeting() is the single write path: the same reasoning, one layer up.
//
// ── IT IS ALWAYS BEST-EFFORT, AND THAT IS A DECISION ─────────────────────────────────────
// Nothing here throws at the caller. A booking must not fail because an email did: the
// customer did their part, the slot is theirs, and a lost confirmation is a far smaller
// problem than a lost booking. Every failure is logged to app_errors and reported in the
// return value, so the page can tell the customer the truth about what was sent.
//
// ⚠️ THE COROLLARY, and it is the trap: a caller must NOT treat `sent: false` as a reason to
// undo anything. It means "no email went", never "it did not happen".
import { sendTenantEmail } from "./emailSend.ts";
import { logEdgeError } from "./logError.ts";
import { bookManageUrl } from "./customerPortalUrl.ts";
import { buildMeetingIcs, icsBase64 } from "./meetingIcs.ts";
import {
  meetingBookedEmail,
  meetingCancelledEmail,
  meetingReminderEmail,
  meetingRescheduledEmail,
  type MeetingMailFacts,
} from "./meetingEmails.ts";

export type MeetingMailWhich = "booked" | "rescheduled" | "cancelled" | "reminder";

export type MeetingSendResult = {
  sent: boolean;
  /** Why not, when not — for the response, never for a retry decision. */
  reason?: string;
};

/** The From name/address a calendar invite's ORGANIZER carries.
 *
 *  ⚠️ NOT a person's own email. The invite is from the BUSINESS: a host's personal address
 *  would be published to every customer who books, and replies to it would bypass the CRM
 *  entirely. emailSend.ts owns the real From; this only fills ORGANIZER, which is what the
 *  customer's calendar shows as the organiser. */
const ORGANIZER_FALLBACK = "no-reply@mail.structurestudiosuite.com";

const KIND: Record<MeetingMailWhich, "meeting_booked" | "meeting_rescheduled" | "meeting_cancelled" | "meeting_reminder"> = {
  booked: "meeting_booked",
  rescheduled: "meeting_rescheduled",
  cancelled: "meeting_cancelled",
  reminder: "meeting_reminder",
};

/**
 * Load everything one email needs, build it, send it.
 *
 * `reminderHours` is only read for `which === "reminder"`, and is what makes its wording
 * relative ("tomorrow" rather than a date).
 */
export async function sendMeetingEmail(
  // deno-lint-ignore no-explicit-any
  admin: any,
  opts: {
    meetingId: string;
    which: MeetingMailWhich;
    reminderHours?: number | null;
    /** For the host rule on the manage link: a confirmation sent from beta points at beta. */
    req?: Request | null;
    /** Already-bumped sequence, when the caller bumped it as part of its own write. Omit and
     *  this reads whatever is on the row. */
    sequence?: number | null;
  },
): Promise<MeetingSendResult> {
  const { meetingId, which, req } = opts;
  try {
    // One read for the meeting and everything hanging off it. `!inner` on type and host
    // because a meeting cannot exist without them (both are ON DELETE RESTRICT).
    const { data: m, error } = await admin.from("meetings")
      .select(
        "id, client_id, starts_at, ends_at, booked_time_zone, status, customer_name, customer_email, " +
          "customer_notes, cancel_token, rescheduled_from, ics_sequence, " +
          "conference_provider, conference_url, conference_note, conference_status, calendar_invited, " +
          "meeting_types!inner(name, location_kind, location_detail), " +
          "meeting_hosts!inner(public_name)",
      )
      .eq("id", meetingId).maybeSingle();
    if (error) throw error;
    if (!m) return { sent: false, reason: "no_meeting" };

    // No address, no email. Not a failure worth logging: a booking taken over the phone with
    // only a number is a supported thing, and phase 2 is email only (an SMS reminder needs
    // portal-sms' consent rules and is a separate decision).
    if (!m.customer_email) return { sent: false, reason: "no_email" };

    const [{ data: cfg }, { data: settings }, { data: pageSettings }] = await Promise.all([
      admin.from("client_configs").select("company_name, logo_url").eq("client_id", m.client_id).maybeSingle(),
      admin.from("client_settings")
        .select("business_name, business_phone, business_website").eq("client_id", m.client_id).maybeSingle(),
      admin.from("meeting_settings").select("send_confirmation").eq("client_id", m.client_id).maybeSingle(),
    ]);

    // The tenant's own switch. It governs the CUSTOMER-FACING mail a booking generates —
    // confirmations, moves and cancellations. A REMINDER is deliberately not gated on it:
    // reminder_hours being non-empty is already that opt-in, and a tenant who turned
    // confirmations off while asking for reminders meant what they said.
    if (which !== "reminder" && pageSettings && pageSettings.send_confirmation === false) {
      return { sent: false, reason: "tenant_off" };
    }

    const businessName = (settings?.business_name || cfg?.company_name || m.client_id) as string;
    const manageUrl = m.cancel_token ? bookManageUrl(m.cancel_token, req ?? null) : null;

    const facts: MeetingMailFacts = {
      businessName,
      logoUrl: cfg?.logo_url ?? null,
      businessPhone: settings?.business_phone ?? null,
      businessWebsite: settings?.business_website ?? null,
      hostName: m.meeting_hosts?.public_name ?? businessName,
      typeName: m.meeting_types?.name ?? "Meeting",
      startsAt: m.starts_at,
      endsAt: m.ends_at,
      timeZone: m.booked_time_zone,
      customerName: m.customer_name,
      locationKind: m.meeting_types?.location_kind ?? "custom",
      locationDetail: m.meeting_types?.location_detail ?? null,
      customerNotes: m.customer_notes ?? null,
      // A cancellation's link offers "book another time", so it is still useful; the email
      // module decides the wording.
      manageUrl,
      previousStartsAt: m.rescheduled_from ?? null,
      reminderHours: opts.reminderHours ?? null,
      // Off the MEETING, not the type — see the column comment on meetings.conference_url:
      // a builder changing their room link must not move a meeting already confirmed.
      conferenceUrl: m.conference_url ?? null,
      conferenceNote: m.conference_note ?? null,
      // 333: asked for a fresh link, none could be made, no room link either.
      conferencePending: !m.conference_url && (m.conference_status === "failed" || m.conference_status === "pending"),
      // 341: the host's Google / Outlook event has the customer as a guest — the provider sent
      // the invite, so ours would be a second one.
      inviteFromHost: !!m.calendar_invited,
    };

    const body = which === "booked"
      ? meetingBookedEmail(facts)
      : which === "rescheduled"
      ? meetingRescheduledEmail(facts)
      : which === "cancelled"
      ? meetingCancelledEmail(facts)
      : meetingReminderEmail(facts);

    // ── The invite ───────────────────────────────────────────────────────────────────────
    // A REMINDER carries none: the event is already in their calendar, and re-sending the
    // same UID at the same sequence does nothing useful while a bumped one would look like a
    // change that did not happen.
    // ⚠️ AND NONE WHEN THE HOST'S CALENDAR SENT IT (341, Carolyn 2026-10-26: "We want to send it
    // only once"). The customer is a guest on the host's own Google / Outlook event, which put it
    // in their calendar and carries Accept / Decline; a second invite from us would be a second,
    // unlinked copy of the same meeting in their calendar.
    const attachments = which === "reminder" || m.calendar_invited ? undefined : [{
      // "invite.ics" rather than the meeting's name: a filename with a customer's words in
      // it is a filename with their punctuation in it.
      filename: "invite.ics",
      content: icsBase64(buildMeetingIcs({
        id: m.id,
        startsAt: m.starts_at,
        endsAt: m.ends_at,
        title: `${facts.typeName} with ${facts.hostName}`,
        description: [
          `${facts.typeName} with ${facts.hostName}.`,
          // Repeated in the body as well as in LOCATION below: clients differ about which of
          // the two they show, and a passcode has nowhere else to go at all.
          facts.conferenceUrl ? `Join: ${facts.conferenceUrl}` : "",
          facts.conferenceNote ? `To get in: ${facts.conferenceNote}` : "",
          facts.customerNotes ? `You told us: ${facts.customerNotes}` : "",
        ].filter(Boolean).join("\n"),
        // ⚠️ FOR A VIDEO MEETING THE LINK *IS* THE LOCATION, and that is not cosmetic: every
        // calendar client turns a URL in LOCATION into its own Join button, which is how a
        // customer gets in from their phone's lock screen without finding the email again.
        // "Video call" would be true there and useless.
        location: facts.conferenceUrl || facts.locationDetail || null,
        organizerName: businessName,
        organizerEmail: ORGANIZER_FALLBACK,
        attendeeName: m.customer_name,
        attendeeEmail: m.customer_email,
        manageUrl,
        sequence: opts.sequence ?? m.ics_sequence ?? 0,
        method: which === "cancelled" ? "cancel" : "request",
      })),
      // Without this a .ics lands as application/octet-stream and several clients show a
      // download rather than an invite the calendar offers to add.
      contentType: "text/calendar; charset=utf-8; method=" + (which === "cancelled" ? "CANCEL" : "REQUEST"),
    }];

    const out = await sendTenantEmail(admin, m.client_id, {
      kind: KIND[which],
      to: m.customer_email,
      subject: body.subject,
      html: body.html,
      text: body.text,
      attachments,
    });

    if (!out.sent) {
      // `not_active` is the ordinary state of a tenant who has not set up sending — dark by
      // design, not a fault, and must not fill app_errors.
      if (out.reason !== "not_active") {
        await logEdgeError({
          fn: "meetingSend",
          clientId: m.client_id,
          code: "meeting_mail_failed",
          message: `${which} email for meeting ${m.id} was not sent: ${out.reason}${out.error ? ` (${out.error})` : ""}`,
        });
      }
      return { sent: false, reason: out.reason };
    }
    return { sent: true };
  } catch (e) {
    // Never throws at the caller — see the header.
    await logEdgeError({
      fn: "meetingSend",
      code: "meeting_mail_threw",
      message: `${which} email for meeting ${meetingId} threw: ${(e as Error)?.message ?? String(e)}`,
    });
    return { sent: false, reason: "threw" };
  }
}

/**
 * Mark the confirmation as sent, exactly once.
 *
 * ⚠️ The guard is `confirmation_sent_at is null` in the UPDATE itself, not a read-then-write:
 * two overlapping callers (a retry, a double-submitted form) would both see null and both
 * send. Returns whether THIS caller won the claim, so only the winner sends.
 */
// deno-lint-ignore no-explicit-any
export async function claimConfirmation(admin: any, meetingId: string): Promise<boolean> {
  const { data, error } = await admin.from("meetings")
    .update({ confirmation_sent_at: new Date().toISOString() })
    .eq("id", meetingId).is("confirmation_sent_at", null)
    .select("id").maybeSingle();
  if (error) return false;
  return !!data;
}

/**
 * Bump the invite's SEQUENCE and return the new value.
 *
 * Required before every reschedule and cancellation: a calendar client ignores an update
 * whose sequence has not increased, so without this a moved meeting silently keeps its old
 * time in the customer's calendar. Returns null when the row could not be updated, and the
 * caller then sends with whatever is on the row rather than nothing.
 */
// deno-lint-ignore no-explicit-any
export async function bumpIcsSequence(admin: any, meetingId: string): Promise<number | null> {
  const { data: row, error: readErr } = await admin.from("meetings")
    .select("ics_sequence").eq("id", meetingId).maybeSingle();
  if (readErr || !row) return null;
  const next = (Number(row.ics_sequence) || 0) + 1;
  const { error } = await admin.from("meetings")
    .update({ ics_sequence: next }).eq("id", meetingId);
  if (error) return null;
  return next;
}
