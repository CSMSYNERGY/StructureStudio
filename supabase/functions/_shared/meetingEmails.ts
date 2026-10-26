// meetingEmails.ts — the four emails a booking sends. Migration 327, phase 2 of
// MEETINGS_SCOPE.md.
//
//   booked       the confirmation, carrying the calendar invite
//   rescheduled  it moved: the new time, and what it moved from
//   cancelled    it is off, carrying the invite's cancellation
//   reminder     the day before (or whenever the tenant asked)
//
// PURE, like meetingIcs.ts and meetingAvailability.ts: no clients, no clock of its own. The
// whole module is "given these facts, what does the customer read", which is exactly the part
// worth pinning in a test — see meetingEmails.test.ts.
//
// ── TWO RULES THIS FILE EXISTS TO HOLD ───────────────────────────────────────────────────
//
// 1. THE TIME IS RENDERED IN THE CUSTOMER'S OWN ZONE, the one they were looking at when they
//    booked (meetings.booked_time_zone), and the zone is NAMED beside it. A confirmation that
//    says "1:00 PM" without saying whose 1pm is the single most expensive ambiguity in this
//    feature: somebody drives to a lot an hour early, or an hour late.
//
// 2. "ESTIMATE", NEVER "QUOTE", wherever a person reads it (Carolyn 2026-10-06, Q12).
//    scripts/preflight.mjs' checkEstimateWording fails a push that puts the word back.
import { esc, htmlShell, ctaButton, detailRow, FONT } from "./emailTemplates.ts";

export type MeetingMailFacts = {
  /** The business, for the card's header and footer. */
  businessName: string;
  logoUrl?: string | null;
  businessPhone?: string | null;
  businessWebsite?: string | null;
  /** Who the customer is meeting. */
  hostName: string;
  /** What kind of meeting, e.g. "Lot walkthrough". */
  typeName: string;
  /** ISO instants. */
  startsAt: string;
  endsAt: string;
  /** The zone the CUSTOMER saw when booking (meetings.booked_time_zone). */
  timeZone: string;
  customerName: string;
  locationKind: "in_person" | "phone" | "video" | "custom";
  locationDetail?: string | null;
  /** What the customer typed when booking. */
  customerNotes?: string | null;
  /** Where they can cancel or move it. Absent only if a tenant has no public page. */
  manageUrl?: string | null;
  /** For the "it moved" email: where it was before. */
  previousStartsAt?: string | null;
  /** Hours before the start, for a reminder's wording ("tomorrow" vs "in 2 hours"). */
  reminderHours?: number | null;
  /** The video join link this booking was made with (migrations 328/329), and whatever else
   *  is needed to get in — a passcode, a dial-in number. Both come off the MEETING rather
   *  than the type, so a builder changing their room link next month never silently moves a
   *  meeting that is already confirmed with the old one. */
  conferenceUrl?: string | null;
  conferenceNote?: string | null;
  /** A fresh link was asked for (333) but could not be made, and there was no room link to
   *  fall back on. Say plainly that one is coming, rather than leaving a video meeting with no
   *  way in and no word about it. Ignored when conferenceUrl is set. */
  conferencePending?: boolean;
};

const PENDING_LINK = "Your video link will follow by email.";

export type MeetingMailBody = { subject: string; html: string; text: string };

/** "Friday 23 October, 9:00 AM CDT" — the whole point of this module. The zone is rendered as
 *  its short name where the platform knows one, and falls back to the IANA name, which is
 *  ugly but never wrong. */
export function formatWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const fmt = (opts: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).format(d);
    } catch {
      // An unknown zone must not lose the time entirely: fall back to UTC and say so.
      return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(d) + " UTC";
    }
  };
  const day = fmt({ weekday: "long", day: "numeric", month: "long" });
  const time = fmt({ hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return `${day}, ${time}`;
}

/** The duration in words, for the summary row. */
export function formatLength(startsAt: string, endsAt: string): string {
  const mins = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60000);
  if (!Number.isFinite(mins) || mins <= 0) return "";
  if (mins < 60) return `${mins} minutes`;
  if (mins % 60 === 0) return mins === 60 ? "1 hour" : `${mins / 60} hours`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** What to call the place. `locationDetail` is the builder's own words and wins. */
export function formatWhere(f: Pick<MeetingMailFacts, "locationKind" | "locationDetail">): string {
  const detail = (f.locationDetail ?? "").trim();
  if (detail) return detail;
  if (f.locationKind === "phone") return "Phone call";
  if (f.locationKind === "video") return "Video call";
  if (f.locationKind === "in_person") return "In person";
  return "";
}

/** "tomorrow" / "in 2 hours" / "soon" — for a reminder's subject line. */
export function reminderLead(hours?: number | null): string {
  const h = Math.round(Number(hours));
  if (!Number.isFinite(h) || h <= 0) return "coming up";
  if (h === 1) return "in an hour";
  if (h < 24) return `in ${h} hours`;
  if (h < 48) return "tomorrow";
  const days = Math.round(h / 24);
  return `in ${days} days`;
}

function shell(f: MeetingMailFacts, preheader: string, bodyHtml: string): string {
  return htmlShell({
    businessName: f.businessName,
    logoUrl: f.logoUrl ?? null,
    phone: f.businessPhone ?? null,
    website: f.businessWebsite ?? null,
    // No terms on a meeting email: quote terms belong on paperwork, and this is an
    // appointment. Passing them would put an estimate's small print under "see you Friday".
    quoteTerms: null,
    preheader,
    bodyHtml,
  });
}

function summary(f: MeetingMailFacts): string {
  const where = formatWhere(f);
  const length = formatLength(f.startsAt, f.endsAt);
  // ⚠️ The join link is rendered as a LINK whose TEXT is the URL, not the word "here": a
  // customer forwarding this to a colleague, or reading it in a client that strips anchors,
  // still has something to copy. The href is the stored value, which the database has already
  // constrained to https (328) — this column lands in an href in a stranger's mail client, so
  // the scheme check belongs at the column and not only here.
  const join = (f.conferenceUrl ?? "").trim();
  const rows = [
    detailRow("What", esc(f.typeName)),
    detailRow("When", `${esc(formatWhen(f.startsAt, f.timeZone))}`),
    length ? detailRow("How long", esc(length)) : "",
    // A video meeting's "where" IS the link; printing both "Where: Video call" and the link
    // says the same thing twice.
    join
      ? detailRow("Join", `<a href="${esc(join)}" target="_blank" style="color:#2B4C7E;text-decoration:underline;word-break:break-all;">${esc(join)}</a>`)
      : f.conferencePending
        ? detailRow("Join", esc(PENDING_LINK))
        : (where ? detailRow("Where", esc(where)) : ""),
    join && f.conferenceNote ? detailRow("To get in", esc(f.conferenceNote)) : "",
    detailRow("Who", esc(f.hostName)),
  ].filter(Boolean).join("\n");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
  style="margin:18px 0 6px 0;border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;">
${rows}
</table>`;
}

function para(html: string): string {
  return `<p style="margin:0 0 14px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#1F2937;">${html}</p>`;
}

function manageLine(f: MeetingMailFacts): string {
  if (!f.manageUrl) return "";
  return `<p style="margin:16px 0 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:#64748B;">
Need to change it? <a href="${esc(f.manageUrl)}" target="_blank" style="color:#2B4C7E;text-decoration:underline;">Reschedule or cancel</a> &mdash; no sign-in needed.
</p>`;
}

/** The plain-text twin. Not an afterthought: a text part is what a watch, a screen reader and
 *  a spam filter read, and a meeting's facts are exactly the kind that must survive without
 *  HTML. Every email here has one. */
function textOf(headline: string, f: MeetingMailFacts, extra: string[] = []): string {
  const where = formatWhere(f);
  const length = formatLength(f.startsAt, f.endsAt);
  const join = (f.conferenceUrl ?? "").trim();
  return [
    headline,
    "",
    `What:     ${f.typeName}`,
    `When:     ${formatWhen(f.startsAt, f.timeZone)}`,
    length ? `How long: ${length}` : "",
    join ? `Join:     ${join}` : f.conferencePending ? `Join:     ${PENDING_LINK}` : (where ? `Where:    ${where}` : ""),
    join && f.conferenceNote ? `To get in: ${f.conferenceNote}` : "",
    `Who:      ${f.hostName}`,
    ...extra,
    "",
    f.manageUrl ? `Reschedule or cancel: ${f.manageUrl}` : "",
    "",
    f.businessName,
    f.businessPhone ? String(f.businessPhone) : "",
  ].filter((l) => l !== "").join("\n");
}

// ── booked ───────────────────────────────────────────────────────────────────────────────

export function meetingBookedEmail(f: MeetingMailFacts): MeetingMailBody {
  const when = formatWhen(f.startsAt, f.timeZone);
  const notes = (f.customerNotes ?? "").trim();
  const body = [
    para(`Hi ${esc(f.customerName.split(/\s+/)[0] || f.customerName)},`),
    para(`You're booked in with <strong>${esc(f.hostName)}</strong>. We've attached a calendar invite so it lands in whatever calendar you use.`),
    summary(f),
    notes
      ? para(`<span style="color:#64748B;font-size:13px;">You told us: &ldquo;${esc(notes)}&rdquo;</span>`)
      : "",
    // On a VIDEO meeting the join button wins over the manage button: on the day, getting in
    // is the only thing this email is for. Changing it is still one tap away, on the line below.
    f.conferenceUrl
      ? ctaButton(f.conferenceUrl, "Join the video call")
      : (f.manageUrl ? ctaButton(f.manageUrl, "View or change this meeting") : ""),
    manageLine(f),
  ].filter(Boolean).join("\n");
  return {
    subject: `You're booked: ${f.typeName} on ${when}`,
    html: shell(f, `${f.typeName} with ${f.hostName} — ${when}`, body),
    text: textOf(`You're booked in with ${f.hostName}.`, f, notes ? ["", `You told us: "${notes}"`] : []),
  };
}

// ── rescheduled ──────────────────────────────────────────────────────────────────────────

export function meetingRescheduledEmail(f: MeetingMailFacts): MeetingMailBody {
  const when = formatWhen(f.startsAt, f.timeZone);
  // Naming the OLD time is the whole value of this email: "your meeting moved" with only the
  // new time leaves the reader unsure whether they misremembered.
  const was = f.previousStartsAt ? formatWhen(f.previousStartsAt, f.timeZone) : null;
  const body = [
    para(`Hi ${esc(f.customerName.split(/\s+/)[0] || f.customerName)},`),
    para(was
      ? `Your ${esc(f.typeName.toLowerCase())} has moved. It was ${esc(was)}; it's now <strong>${esc(when)}</strong>.`
      : `Your ${esc(f.typeName.toLowerCase())} has moved. It's now <strong>${esc(when)}</strong>.`),
    summary(f),
    para(`<span style="color:#64748B;font-size:13px;">The attached invite updates the one already in your calendar &mdash; you shouldn't end up with two.</span>`),
    f.manageUrl ? ctaButton(f.manageUrl, "View or change this meeting") : "",
    manageLine(f),
  ].filter(Boolean).join("\n");
  return {
    subject: `Moved: ${f.typeName} is now ${when}`,
    html: shell(f, `Your ${f.typeName.toLowerCase()} is now ${when}`, body),
    text: textOf(
      was ? `Your ${f.typeName.toLowerCase()} has moved. It was ${was}.` : `Your ${f.typeName.toLowerCase()} has moved.`,
      f,
    ),
  };
}

// ── cancelled ────────────────────────────────────────────────────────────────────────────

export function meetingCancelledEmail(f: MeetingMailFacts): MeetingMailBody {
  const when = formatWhen(f.startsAt, f.timeZone);
  const body = [
    para(`Hi ${esc(f.customerName.split(/\s+/)[0] || f.customerName)},`),
    para(`Your ${esc(f.typeName.toLowerCase())} on <strong>${esc(when)}</strong> has been cancelled, and we've taken it out of your calendar.`),
    para(`If that wasn't meant to happen, ${f.manageUrl ? "book a new time below" : "just get in touch"} and we'll sort it out.`),
    f.manageUrl ? ctaButton(f.manageUrl, "Book another time") : "",
  ].filter(Boolean).join("\n");
  return {
    subject: `Cancelled: ${f.typeName} on ${when}`,
    html: shell(f, `Your ${f.typeName.toLowerCase()} on ${when} is cancelled`, body),
    // Deliberately NOT textOf: that one offers "reschedule or cancel" on a meeting that is
    // already off, and prints a When for something that is not happening.
    text: [
      `Your ${f.typeName.toLowerCase()} on ${when} has been cancelled.`,
      "",
      "If that wasn't meant to happen, get in touch and we'll sort it out.",
      f.manageUrl ? `Book another time: ${f.manageUrl}` : "",
      "",
      f.businessName,
      f.businessPhone ? String(f.businessPhone) : "",
    ].filter((l) => l !== "").join("\n"),
  };
}

// ── reminder ─────────────────────────────────────────────────────────────────────────────

export function meetingReminderEmail(f: MeetingMailFacts): MeetingMailBody {
  const when = formatWhen(f.startsAt, f.timeZone);
  const lead = reminderLead(f.reminderHours);
  const where = formatWhere(f);
  const body = [
    para(`Hi ${esc(f.customerName.split(/\s+/)[0] || f.customerName)},`),
    para(`A reminder that you're seeing <strong>${esc(f.hostName)}</strong> ${esc(lead)} &mdash; ${esc(when)}.`),
    summary(f),
    f.locationKind === "in_person" && where
      ? para(`<span style="color:#64748B;font-size:13px;">We're at ${esc(where)}.</span>`)
      : "",
    // A reminder for a video call exists mostly to put the link in front of them at the
    // moment they actually need it.
    f.conferenceUrl ? ctaButton(f.conferenceUrl, "Join the video call") : "",
    manageLine(f),
  ].filter(Boolean).join("\n");
  return {
    subject: `Reminder: ${f.typeName} ${lead}`,
    html: shell(f, `${f.typeName} with ${f.hostName} — ${when}`, body),
    text: textOf(`A reminder that you're seeing ${f.hostName} ${lead}.`, f),
  };
}
