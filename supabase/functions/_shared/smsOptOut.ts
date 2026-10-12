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
// ⚠️ A LEAF, ON PURPOSE: zero imports. smsSend.ts imports this, and smsSend.ts is bundled into the
// phone-api Worker (Cloudflare), which cannot resolve a jsr: or https: import.

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
    }, { onConflict: "client_id,phone_digits" });
    if (error) failed = `sms_opt_outs: ${error.code ?? "write failed"}`;
  } catch {
    failed = "sms_opt_outs: threw";
  }
  if (contactId) {
    try {
      const { error } = await admin.from("crm_contacts")
        .update({ sms_opt_out_at: new Date().toISOString() })
        .eq("client_id", clientId).eq("id", contactId);
      if (error && !failed) failed = `crm_contacts: ${error.code ?? "write failed"}`;
    } catch {
      if (!failed) failed = "crm_contacts: threw";
    }
  }
  return failed;
}
