/**
 * Tenant SMS send — the orchestration layer over twilioSms.ts, mirroring emailSend.ts.
 *
 * Same shape and the same reasons: dark guards that touch nothing when the feature is not
 * configured, a LEDGER ROW CLAIMED BEFORE the provider call, and an outcome recorded on
 * that row afterwards. It never throws; callers branch on the returned verdict.
 *
 * ⚠️ DEPLOYING THIS CHANGES NOTHING ON ITS OWN. Every path below goes dark unless the
 * platform secrets exist AND the tenant's client_settings.sms_status is 'active' with a
 * number. That is deliberate: the code can ship, be reviewed and be tested while the A2P
 * campaign is still in carrier review, and no tenant sees a text until a human flips them
 * on. The email side works the same way and for the same reason.
 */

import { logEdgeError } from "./logError.ts";
import {
  sendSms, smsE164US, smsPhoneKey, isDamagedPhoneKey, SmsApiError,
} from "./twilioSms.ts";
import { quietHoursVerdict } from "./smsQuietHours.ts";
import { checkUsageGate, keepAlive, requestAutoTopup } from "./usageGate.ts";
// Which Twilio account the tenant's number lives in (Workstream 2): the parent from the
// environment while TWILIO_SUBACCOUNTS is not "on" (no lookup), else the tenant's own sub-account.
// A zero-import leaf, so the phone-api Worker, which bundles this file, bundles it too.
import { resolveTwilioAccount, TwilioAccountError, type TwilioAccount } from "./twilioAccount.ts";

export type SmsOutcome = {
  sent: boolean;
  /** not_active: the feature is off for this deployment or this tenant — the caller should
   *  say "not switched on", never "failed". opted_out / bad_number / failed are real
   *  refusals with something to tell the user. wallet_empty (migration 259): the prepaid
   *  wallet is under the usage floor while the SMS meter is armed; `error` says either that a
   *  top-up is on its way or where to add funds, and is meant to be shown as-is. */
  reason?: "not_active" | "opted_out" | "no_consent" | "bad_number" | "damaged_number" | "quiet_hours" | "wallet_empty" | "failed";
  error?: string;
  id?: string;
};

export type TenantSms = {
  /** The customer's number as stored on crm_contacts.phone — display text, not normalized. */
  toPhone: string;
  body: string;
  contactId?: string | null;
  shortCode?: string | null;
  /** The signed-in human, for attribution on the ledger row. */
  sentBy?: string | null;
  /** Twilio posts delivery updates here. Omitted → no callback, and the row stays 'sent'. */
  statusCallback?: string | null;
  /** A person pressing a button that sends THIS one text to THIS one customer (the record
   *  page's Send, text_sign_link) is not what quiet hours exist to stop. Set for those; never
   *  for automation. Pinned by _test_stubs/smsQuietHoursWiring_test.ts. */
  bypassQuietHours?: boolean;
  /** Keeps background work alive past the caller's response — today only the automatic top-up
   *  a wallet_empty refusal asks for. The Worker passes its ctx.waitUntil; an edge function can
   *  omit it (EdgeRuntime.waitUntil is used). Without either, the request is sent and may be
   *  cut off when the response ends. */
  waitUntil?: ((p: Promise<unknown>) => void) | null;
  /** The business number to send FROM, E.164, when it is not the main texting number
   *  (client_settings.sms_number): a reply goes out from the number the customer last used
   *  (replyFromNumber below, migration 266). It must be one of THIS business's live numbers,
   *  registered for texting, in the business's own Messaging Service; anything else is refused
   *  with a sentence, never quietly sent from another number (an unregistered US send dies at
   *  the carrier with 30034 and nobody sees it). Absent, or the main number itself = the main
   *  number, exactly as before. Automatic texts never set it. */
  fromNumber?: string | null;
};

/** fromNumber is not a live number of this business (another builder's, released, or made up). */
export const FROM_NOT_OURS = "That number isn't one of your business's numbers any more, so the text wasn't sent. Reload and try again.";
/** fromNumber is ours but can't text yet (not registered, or outside the texting setup). */
export const FROM_NOT_READY = "That number isn't set up for texting yet, so the text wasn't sent. It can text once the carriers approve it.";

export async function sendTenantSms(
  admin: any,
  clientId: string,
  msg: TenantSms,
): Promise<SmsOutcome> {
  try {
    // ── Dark guards (zero network, zero ledger) ───────────────────────────────────────
    // Platform secrets first: an unconfigured deployment skips even the settings read.
    // Platform CREDENTIALS only now: under the ISV model the Messaging Service belongs
    // to the tenant, read below, so it is no longer part of this question.
    //
    // RESOLVED ONCE, HERE, and handed to sendSms below as a value (Workstream 2). With
    // TWILIO_SUBACCOUNTS not "on" this is the environment check it always was (the parent's
    // credentials, or null = not configured) and touches nothing: no lookup, no network. With it
    // on, a tenant with a sub-account sends from it; a sub that is not active yet is "not
    // switched on"; a lookup that fails stops THIS tenant's text and nobody else's.
    let account: TwilioAccount | null;
    try {
      account = await resolveTwilioAccount(admin, clientId, (k) => Deno.env.get(k));
    } catch (e) {
      if (e instanceof TwilioAccountError && e.kind === "not_ready") return { sent: false, reason: "not_active" };
      await logEdgeError({
        fn: "sms-send",
        clientId,
        code: "twilio_account_lookup_failed",
        message: `The tenant's Twilio account could not be resolved, so the text was not sent: ${(e as Error)?.message ?? "unknown"}`,
      }).catch(() => {});
      return { sent: false, reason: "failed", error: "The text could not be sent. Try again." };
    }
    if (!account) return { sent: false, reason: "not_active" };

    const { data: s } = await admin.from("client_settings")
      .select("sms_number, sms_status")
      .eq("client_id", clientId).maybeSingle();
    // A missing row or a read error both land here and go dark: without settings we cannot
    // know this tenant is registered, and an unregistered US send fails at the carrier
    // (30034) rather than merely erroring.
    if (!s || s.sms_status !== "active" || !s.sms_number) return { sent: false, reason: "not_active" };

    // ── The tenant's OWN registration ─────────────────────────────────────
    // ⚠️ TWO SEPARATE FACTS, both required, and neither implies the other:
    //   1. the registration is 'active'  — this builder's campaign passed carrier review
    //   2. THIS NUMBER's registration_status is 'registered' — the per-number A2P step,
    //      which completes SEPARATELY and later, and has no polling API.
    // A number attached to an approved campaign but not itself registered still dies at
    // the carrier with 30034, so checking only the campaign sends into a black hole.
    const { data: reg } = await admin.from("sms_registrations")
      .select("status, messaging_service_sid")
      .eq("client_id", clientId).maybeSingle();
    if (!reg || reg.status !== "active" || !reg.messaging_service_sid) {
      return { sent: false, reason: "not_active" };
    }
    // ── WHICH of the business's numbers (migration 266) ─────────────────────────────────
    // The main texting number unless the caller names another. Another must pass FOUR checks,
    // each of which alone would otherwise send into a black hole or out of someone else's line:
    // it is THIS business's (client_id), live (not released), registered for texting, and in the
    // business's own Messaging Service (the service Twilio sends through, below). A failed read
    // refuses too: guessing is how a text leaves from a number nobody chose.
    const from = msg.fromNumber ? String(msg.fromNumber).trim() : String(s.sms_number);
    if (from !== String(s.sms_number)) {
      const { data: alt, error: altErr } = await admin.from("sms_numbers")
        .select("registration_status, messaging_service_sid")
        .eq("client_id", clientId).eq("phone_number", from)
        .is("released_at", null).maybeSingle();
      if (altErr) return { sent: false, reason: "failed", error: "The text could not be sent. Try again." };
      if (!alt) return { sent: false, reason: "not_active", error: FROM_NOT_OURS };
      if (alt.registration_status !== "registered" || alt.messaging_service_sid !== reg.messaging_service_sid) {
        return { sent: false, reason: "not_active", error: FROM_NOT_READY };
      }
    } else {
      const { data: num } = await admin.from("sms_numbers")
        .select("registration_status")
        .eq("client_id", clientId).eq("phone_number", s.sms_number)
        .is("released_at", null).maybeSingle();
      if (!num || num.registration_status !== "registered") {
        return {
          sent: false,
          reason: "not_active",
          error: "This number is still being registered with the carriers. Texting switches on by itself once that clears.",
        };
      }
    }

    // ── The number, derived server-side ──────────────────────────────────────────────
    // ⚠️ NEVER trust a number from the browser. The caller passes ids; this reads the
    // stored phone and normalizes it the same way public.crm_phone_key does in SQL, so the
    // three definitions (resolver, backfill, sender) cannot disagree.
    const key = smsPhoneKey(msg.toPhone);
    if (isDamagedPhoneKey(key)) {
      // Ten digits starting with 1 is not a NANP number. It is the fingerprint of the
      // formatter that truncated +1 numbers and destroyed the last digit (fixed 08-25).
      // Refusing here, by name, beats a Twilio 21211 that reads as "this customer's phone
      // does not work".
      return {
        sent: false,
        reason: "damaged_number",
        error: "This phone number looks damaged — its last digit was lost when it was first saved. Re-enter it on the contact, then try again.",
      };
    }
    const to = smsE164US(key);
    if (!to) return { sent: false, reason: "bad_number", error: "That is not a US mobile number we can text." };

    // ── Opt-out, checked BEFORE the provider ─────────────────────────────────────────
    // Twilio's Advanced Opt-Out blocks the send anyway (21610), but finding out from a
    // provider error costs a round trip and reads as a system fault rather than as the
    // customer's own instruction. STOP is a legal instruction; say so plainly.
    // ⚠️ KEYED ON THE PHONE, not the contact row. Consent belongs to the person and must
    // survive their contact being merged, renamed or re-created — a fresh contact row for a
    // number that said STOP must not inherit a clean slate. crm_contacts is still checked
    // below for the pre-165 rows that only ever recorded it there.
    const { data: oo } = await admin.from("sms_opt_outs")
      .select("reason").eq("client_id", clientId).eq("phone_digits", key).maybeSingle();
    if (oo) {
      return {
        sent: false,
        reason: "opted_out",
        error: "This customer asked not to be texted. They can reply START to that same number to opt back in.",
      };
    }

    // ── Consent, REQUIRED ────────────────────────────────────────────
    // ⚠️ THIS REFUSES ANYONE WITHOUT A POSITIVE CONSENT RECORD, including every contact
    // captured before consent existed. That is the point and it was Ahsan's explicit call:
    // the TCPA needs prior express consent, and "we have their number" is not consent.
    //
    // Consent comes from sms_consent_log. Three ways to get it:
    //   web_form    the designer gate's checkbox
    //   sms_inbound they texted this builder first, which is consent to that conversation
    //   operator    a human recorded it (portal-sms set_opt_out with optedOut:false)
    //
    // ⚠️ THIS ASKS "IS THERE A GRANT?", NOT "IS THE NEWEST ROW A GRANT?" — and that is a
    // correctness fix, not a shortcut. `created_at` defaults to now(), which in Postgres is
    // TRANSACTION time, so two rows written together carry the SAME timestamp and
    // `order by created_at desc limit 1` picks between them arbitrarily. Ordering on it made
    // revocation depend on a coin flip, and the losing side of that flip is texting someone
    // who said STOP.
    //
    // REVOCATION IS OWNED BY sms_opt_outs, checked above, which holds current state: a STOP
    // writes the row, a START deletes it. That check has already returned by the time we get
    // here, so this one only has to establish that permission was ever given. One fact per
    // table, no ordering, nothing to tie.
    //
    // ⚠️ NOT keyed on the contact row — on the PHONE, for the same reason the opt-out is:
    // consent belongs to the person and must survive a merge, a rename or a re-creation.
    const { data: consentRow } = await admin.from("sms_consent_log")
      .select("action")
      .eq("client_id", clientId).eq("phone_digits", key).eq("action", "granted")
      .limit(1).maybeSingle();
    if (!consentRow) {
      return {
        sent: false,
        reason: "no_consent",
        // The builder can act on this, which a bare "not permitted" cannot be. Naming the two
        // routes matters: most of the back catalogue has no record, and the fix is usually
        // that the customer texts them first, not paperwork.
        // ⚠️ Do NOT add "or record it yourself" here. portal-sms CAN write an operator grant,
        // but no screen exposes it, and an error that names a control the reader cannot find
        // is worse than one that names only what they can actually do.
        // Reaching here means no grant has EVER been recorded — a revocation would have been
        // refused by the opt-out check above, with its own sentence.
        error: "We don't have this customer's permission to text them yet. They can tick the texting box on your design link, or text you first — either one switches it on.",
      };
    }

    // ── Quiet hours ───────────────────────────────────────────────────
    // TCPA: no marketing texts outside 8am–9pm in the RECIPIENT'S local time. A person
    // pressing send on one text to one customer is exempt (bypassQuietHours).
    if (!msg.bypassQuietHours) {
      const quiet = quietHoursVerdict(key);
      if (!quiet.allowed) return { sent: false, reason: "quiet_hours", error: quiet.reason };
    }

    if (msg.contactId) {
      const { data: c } = await admin.from("crm_contacts")
        .select("sms_opt_out_at").eq("client_id", clientId).eq("id", msg.contactId).maybeSingle();
      if (c && c.sms_opt_out_at) {
        return {
          sent: false,
          reason: "opted_out",
          error: "This customer replied STOP, so we cannot text them. They can reply START to that same number to opt back in.",
        };
      }
    }

    const body = String(msg.body ?? "").trim().slice(0, 1600);
    if (!body) return { sent: false, reason: "failed", error: "The message is empty." };

    // ── The wallet floor (migration 259) ─────────────────────────────────────────────
    // LAST of the refusals, deliberately: a text that would have been refused anyway (STOP, no
    // consent, quiet hours) is answered with that reason, never with "top up your wallet" —
    // paying would not have sent it. And BEFORE the claim row, so a refused text leaves no
    // ledger row, costs nothing and is never billed by the usage cron.
    //
    // DISARMED unless PHONE_USAGE_METERS is "on" in this runtime's env (zero network when off)
    // AND the database says the sms_segment meter is armed for this tenant. FAILS OPEN: an
    // error answers allow, and is logged here so a broken gate is visible rather than free.
    // Nothing is charged here; the Worker's usage cron charges the sent text afterwards from
    // Twilio's own price.
    const gate = await checkUsageGate(admin, clientId, "sms_segment");
    if (gate.reason === "error") {
      await logEdgeError({
        fn: "sms-send",
        clientId,
        code: "usage_gate_failed",
        message: `Wallet floor check failed, the text was allowed: ${gate.error ?? "unknown"}`,
      });
    }
    if (!gate.allow) {
      if (gate.autoTopupEnabled) {
        // Ask for the top-up, do not wait for it: the card sale can take 30 s and this answer
        // should not. wallet-autotopup applies the threshold and the hour's cooldown itself, so
        // a builder pressing Send five times is five requests and at most one charge. A request
        // that never got a 200 is logged; a decline is logged by wallet-autotopup itself.
        keepAlive(requestAutoTopup(clientId).then(async (r) => {
          if (r.status !== 200) {
            await logEdgeError({
              fn: "sms-send",
              clientId,
              code: "auto_topup_request_failed",
              message: `The automatic top-up request after a wallet_empty refusal did not get a 200 from wallet-autotopup: ${r.reason ?? "unknown"}`,
              context: { status: r.status, requested: r.requested },
            });
          }
        }), msg.waitUntil);
        return { sent: false, reason: "wallet_empty", error: "Your wallet is being topped up. Try again in a minute." };
      }
      return { sent: false, reason: "wallet_empty", error: "Your wallet is empty. Add funds in Settings, Billing." };
    }

    // ── Ledger first: claim the send before touching the provider ────────────────────
    const { data: row, error: insErr } = await admin.from("sms_messages").insert({
      client_id: clientId,
      contact_id: msg.contactId ?? null,
      short_code: msg.shortCode ?? null,
      direction: "out",
      from_number: from,
      to_number: to,
      body,
      status: "claimed",
      sent_by: msg.sentBy ?? null,
    }).select("id").single();

    if (insErr || !row?.id) {
      // No claim row → no send. A message the customer received and the builder cannot see
      // is worse than a message that did not go. The raw Postgres text can echo the row
      // (which holds the number), so it goes to app_errors, not to the browser.
      await logEdgeError({
        fn: "sms-send",
        clientId,
        code: "sms_ledger_insert_failed",
        message: `sms_messages claim row could not be written: ${insErr?.message ?? "insert returned no id"}`,
        context: { contactId: msg.contactId ?? null, shortCode: msg.shortCode ?? null },
      });
      return { sent: false, reason: "failed", error: "sms ledger write failed" };
    }
    const rowId = row.id;

    // ── Send, then record the outcome on the claimed row ─────────────────────────────
    try {
      const out = await sendSms({
        to,
        from,
        messagingServiceSid: String(reg.messaging_service_sid),
        body,
        statusCallback: msg.statusCallback ?? null,
        creds: account,
      });
      const { error: upErr } = await admin.from("sms_messages").update({
        status: "sent",
        provider_sid: out.sid || null,
        num_segments: out.segments,
        updated_at: new Date().toISOString(),
      }).eq("id", rowId);
      if (upErr) {
        // SENT BUT NOT RECORDED. The message is with the customer, so the verdict stays
        // `sent: true` — reporting a failure would invite a resend and text them twice.
        // The gap is logged instead. Same asymmetry as emailSend.
        await logEdgeError({
          fn: "sms-send",
          clientId,
          code: "sms_ledger_update_failed",
          message: `sms_messages row ${rowId} sent but not updated: ${upErr.message}`,
          context: { rowId },
        });
      }
      return { sent: true, id: rowId };
    } catch (e) {
      const err = e as SmsApiError;
      const code = typeof err.code === "number" ? err.code : 0;
      await admin.from("sms_messages").update({
        status: "failed",
        error_code: code ? String(code) : null,
        updated_at: new Date().toISOString(),
      }).eq("id", rowId);

      // 21610 is Twilio telling us the recipient opted out through a route we did not see
      // (a STOP to a different number on the same service, or one our webhook missed).
      // Record it on the contact so the composer stops offering, and answer in the
      // customer's terms rather than with a provider code.
      if (code === 21610) {
        // Twilio saw an opt-out we did not. Record it where the send path actually looks,
        // keyed on the phone, so it survives whatever happens to the contact row.
        await admin.from("sms_opt_outs").upsert({
          client_id: clientId, phone_digits: key, reason: "sms_stop",
          note: "Recorded from Twilio error 21610 — the opt-out reached Twilio by a route our webhook did not see.",
        }, { onConflict: "client_id,phone_digits" });
        if (msg.contactId) {
          await admin.from("crm_contacts")
            .update({ sms_opt_out_at: new Date().toISOString() })
            .eq("client_id", clientId).eq("id", msg.contactId);
        }
        return { sent: false, reason: "opted_out", error: "This customer has opted out of texts from this number." };
      }
      if (code === 30034) {
        return {
          sent: false,
          reason: "not_active",
          error: "Texting is not switched on for this account yet — the number is still with the carriers for approval.",
        };
      }
      return {
        sent: false,
        reason: "failed",
        error: `The text could not be sent${code ? ` (carrier code ${code})` : ""}. Try again, or call them instead.`,
      };
    }
  } catch (e) {
    // Belt and braces: this function must never throw into a request handler.
    await logEdgeError({
      fn: "sms-send",
      clientId,
      code: "sms_send_unhandled",
      message: `unhandled: ${(e as Error).message}`,
    }).catch(() => {});
    return { sent: false, reason: "failed", error: "The text could not be sent." };
  }
}

// ── Which number a person's reply goes out from (migration 266) ─────────────────────────────
//
// Carolyn 2026-09-30: a business can have more than one number, and a number can be one
// person's. A customer who texted the sales line, or Mike's own number, expects the answer from
// that same number; a reply from another one reads as a stranger. So a text a PERSON sends to a
// customer (the record page's Send, the apps' Send) goes out from, in order:
//   1. the business number of the newest text in that customer's thread (the number they texted,
//      or the one we last texted them from);
//   2. failing that, the sender's own number (sms_numbers.assigned_user_id);
//   3. failing that, the main number (null: sendTenantSms's own default).
// A candidate is used only if it can text right now: live, registered, and in the business's
// Messaging Service. One that can't (a calling-only number, one still with the carriers, one
// released since) is skipped for the next, so a reply that worked before this change still goes
// out, from the main number, rather than being refused. The main number itself answers null, so
// that path stays byte for byte what it was. Every read failure answers null too: replying from
// the main number is what every text did before.
//
// Automatic texts (submit-estimate's quote text, text_sign_link) never ask: they stay on the main
// number, the one the business registered and advertises.

export type ReplyThreadRow = { direction: string | null; from_number: string | null; to_number: string | null };
export type ReplyNumberRow = {
  phone_number: string;
  registration_status: string | null;
  messaging_service_sid: string | null;
  assigned_user_id?: string | null;
};

/** The pure half of replyFromNumber: the rows in, the number out (null = the main number). */
export function pickReplyNumber(o: {
  thread: ReplyThreadRow | null;
  numbers: ReplyNumberRow[];
  mainNumber: string | null;
  serviceSid: string | null;
  userId?: string | null;
}): string | null {
  if (!o.serviceSid) return null;
  const live = new Map((o.numbers ?? []).map((n) => [String(n.phone_number), n] as [string, ReplyNumberRow]));
  const canText = (e164: string) => {
    const n = live.get(e164);
    return !!n && n.registration_status === "registered" && !!n.messaging_service_sid && n.messaging_service_sid === o.serviceSid;
  };
  const ours = o.thread
    ? (o.thread.direction === "in" ? o.thread.to_number : o.thread.direction === "out" ? o.thread.from_number : null)
    : null;
  const me = String(o.userId ?? "").toLowerCase();
  const mine = me ? (o.numbers ?? []).find((n) => String(n.assigned_user_id ?? "").toLowerCase() === me)?.phone_number ?? null : null;
  for (const c of [ours, mine]) {
    if (!c) continue;
    if (o.mainNumber && c === o.mainNumber) return null;
    if (canText(c)) return c;
  }
  return null;
}

const E164_US = /^\+1[2-9]\d{9}$/;

/**
 * The reads behind pickReplyNumber, in parallel (one round trip): the thread's newest text, the
 * business's live numbers, the main number and the Messaging Service. `contactId` names a saved
 * customer's thread; without one, `customerE164` names an unknown number's (its texts carry no
 * contact). Never throws; null = the main number.
 */
// deno-lint-ignore no-explicit-any
export async function replyFromNumber(admin: any, clientId: string, o: {
  contactId?: string | null;
  customerE164?: string | null;
  userId?: string | null;
}): Promise<string | null> {
  try {
    const e164 = o.customerE164 && E164_US.test(o.customerE164) ? o.customerE164 : null;
    const threadQ = o.contactId
      ? admin.from("sms_messages").select("direction, from_number, to_number")
        .eq("client_id", clientId).eq("contact_id", o.contactId)
        .order("created_at", { ascending: false }).limit(1)
      : e164
      ? admin.from("sms_messages").select("direction, from_number, to_number")
        .eq("client_id", clientId).is("contact_id", null)
        .or(`from_number.eq.${e164},to_number.eq.${e164}`)
        .order("created_at", { ascending: false }).limit(1)
      : Promise.resolve({ data: [], error: null });
    const [thread, nums, cs, reg] = await Promise.all([
      threadQ,
      admin.from("sms_numbers").select("phone_number, registration_status, messaging_service_sid, assigned_user_id")
        .eq("client_id", clientId).is("released_at", null).limit(50),
      admin.from("client_settings").select("sms_number").eq("client_id", clientId).maybeSingle(),
      admin.from("sms_registrations").select("messaging_service_sid").eq("client_id", clientId).maybeSingle(),
    ]);
    // Before migration 266 (no assigned_user_id) or any failed read of the numbers: the main number.
    if (nums.error || reg.error || cs.error) return null;
    return pickReplyNumber({
      thread: thread.error ? null : ((thread.data ?? [])[0] ?? null),
      numbers: (nums.data ?? []) as ReplyNumberRow[],
      mainNumber: (cs.data as { sms_number?: string | null } | null)?.sms_number ?? null,
      serviceSid: (reg.data as { messaging_service_sid?: string | null } | null)?.messaging_service_sid ?? null,
      userId: o.userId ?? null,
    });
  } catch {
    return null;
  }
}
