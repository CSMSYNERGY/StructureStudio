// _shared/smsOptOut.ts — Twilio error 21610, recorded the one way, whenever it arrives.
//
// 21610 is Twilio telling us the recipient opted out through a route we did not see (a STOP to a
// different number on the same Messaging Service, or one our webhook missed). It arrives two ways:
//   * at send time, when Twilio's API refuses the send outright (smsSend.ts sendTenantSms);
//   * later, in a delivery status (sms-status), when the Messaging Service took the text and then
//     failed it with 21610. Until 2026-10-13 this second one only marked the text failed, so the
//     composer kept offering a number Twilio would never deliver to (asked 2026-10-12: "Can we
//     see if a customer has opted out?").
// Both callers record it through recordTwilioOptOut, so the two can never write it differently.
//
// It is also where the screens READ an opt-out the way the send path does: readSmsOptOut, then
// smsOptOutFacts, and smsOptOutRefusal to word a refusal. The portal's contact record and its
// "Customer agreed to texts" (portal-settings crm_record and crm_record_consent) and the phone
// apps' thread (phone-api GET /threads/:key `sms`) all read it so.
//
// ⚠️ A LEAF, ON PURPOSE: zero imports. smsSend.ts imports this, and smsSend.ts is bundled into the
// phone-api Worker (Cloudflare), which cannot resolve a jsr: or https: import.
//
// IMPORTERS, for a redeploy after a change here: portal-settings, sms-status, every importer of
// smsSend.ts, and the phone-api Worker, which bundles it twice over (through smsSend.ts, and
// directly in src/routes/reads.ts). The Worker is deployed by hand (workers/phone-api/README.md).

/** Twilio's "the recipient has opted out" error code. */
export const TWILIO_OPTED_OUT = 21610;

export const TWILIO_OPT_OUT_NOTE =
  "Recorded from Twilio error 21610 — the opt-out reached Twilio by a route our webhook did not see.";

/**
 * Record Twilio's 21610 where the send path actually looks, keyed on the phone so it survives
 * whatever happens to the contact row: an sms_opt_outs row (reason sms_stop, a STOP by another
 * route), and, for a text to a saved contact, crm_contacts.sms_opt_out_at, so the composer stops
 * offering. A START from the customer deletes the sms_opt_outs row (sms-inbound).
 *
 * ADDS, NEVER REWRITES. A number already opted out keeps its row as it is: the reason, the note
 * and effective_at are the business's revocation record (migration 164: the FCC's clock), and an
 * operator's or an import's must not turn into a 21610 because a text sent before it failed later.
 * The contact's flag keeps its first time the same way. Twilio can send a failed status more than
 * once, so this can run more than once for one text, and the second time changes nothing.
 *
 * `phoneKey` is the 10-digit key (twilioSms.ts smsPhoneKey / public.crm_phone_key). Never throws:
 * what failed first comes back (null when both went through), for the caller to log under its own
 * name, so this file stays a leaf. It names the table and the database's code, never the
 * database's message, which can quote the row (the phone number).
 */
// deno-lint-ignore no-explicit-any
export async function recordTwilioOptOut(admin: any, clientId: string, phoneKey: string, contactId?: string | null): Promise<string | null> {
  let failed: string | null = null;
  try {
    const { error } = await admin.from("sms_opt_outs").upsert({
      client_id: clientId, phone_digits: phoneKey, reason: "sms_stop", note: TWILIO_OPT_OUT_NOTE,
    }, { onConflict: "client_id,phone_digits", ignoreDuplicates: true });
    if (error) failed = `sms_opt_outs: ${error.code ?? "write failed"}`;
  } catch {
    failed = "sms_opt_outs: threw";
  }
  if (contactId) {
    try {
      const { error } = await admin.from("crm_contacts")
        .update({ sms_opt_out_at: new Date().toISOString() })
        .eq("client_id", clientId).eq("id", contactId).is("sms_opt_out_at", null);
      if (error && !failed) failed = `crm_contacts: ${error.code ?? "write failed"}`;
    } catch {
      if (!failed) failed = "crm_contacts: threw";
    }
  }
  return failed;
}

// ── Reading it: the screens ask what the send path asks ───────────────────────────────────────

/**
 * Why a number can't be texted, in the screens' three words: a STOP (or Twilio's 21610, recorded
 * as one) is `stop`, an opt-out the team recorded (`operator`, the SMS settings' opt-out list) is
 * `team`, and anything else is `other`: an import's do-not-disturb, a web form, or only the
 * contact's older flag. phone-core's smsOptOutText words the phone apps' banner from the same three.
 */
export type SmsOptOutReason = "stop" | "team" | "other";

/** sms_opt_outs.reason (migration 164: sms_stop | operator | web_form | import) as the screens read it. */
export function smsOptOutReasonOf(reason: string | null | undefined): SmsOptOutReason {
  return reason === "sms_stop" ? "stop" : reason === "operator" ? "team" : "other";
}

export interface SmsOptOutFacts {
  optedOut: boolean;
  /** The row's effective_at, else the contact's flag; null when not opted out. */
  at: string | null;
  /** Null when not opted out. */
  reason: SmsOptOutReason | null;
}

/**
 * The number's sms_opt_outs row, THIS business's, read on its 10 digits as smsSend.ts reads it:
 * `{ data, error }` as supabase-js answers (data null when there is none). No number, nothing to
 * ask: `{ data: null, error: null }` without a read. Each caller keeps its own posture on an error.
 */
// deno-lint-ignore no-explicit-any
export function readSmsOptOut(admin: any, clientId: string, phoneKey: string | null | undefined): Promise<{
  data: { reason: string | null; effective_at: string | null } | null;
  error: { code?: string; message?: string } | null;
}> {
  if (!phoneKey) return Promise.resolve({ data: null, error: null });
  return admin.from("sms_opt_outs").select("reason, effective_at")
    .eq("client_id", clientId).eq("phone_digits", phoneKey).maybeSingle();
}

/**
 * The send path's opt-out from its two records (smsSend.ts refuses on either): the NUMBER's
 * sms_opt_outs row, this business's, read on its 10 digits, and the contact's older
 * crm_contacts.sms_opt_out_at. Pass the row as read (null when there is none).
 */
export function smsOptOutFacts(
  row: { reason?: string | null; effective_at?: string | null } | null | undefined,
  contactOptOutAt?: string | null,
): SmsOptOutFacts {
  const optedOut = !!row || !!contactOptOutAt;
  return {
    optedOut,
    at: optedOut ? row?.effective_at ?? contactOptOutAt ?? null : null,
    reason: row ? smsOptOutReasonOf(row.reason) : optedOut ? "other" : null,
  };
}

/**
 * Why "Customer agreed to texts" can't be recorded for an opted-out number (portal-settings
 * crm_record_consent, 409): an opt-out outranks a colleague's attestation, and the customer's
 * START lifts it. Worded by reason, as the phone apps' banner is.
 */
export function smsOptOutRefusal(reason: SmsOptOutReason | null): string {
  if (reason === "stop") return "This customer replied STOP. Only they can undo that, by replying START to that number.";
  if (reason === "team") return "Your team recorded that this customer doesn't want texts. They can opt back in by replying START to that number.";
  return "This customer opted out of texts. They can opt back in by replying START to that number.";
}
