/**
 * The SMS consent sentence, in one place.
 *
 * ⚠️ THIS IS EVIDENCE, NOT COPY. Whatever a customer ticked is stored verbatim in
 * `sms_consent_log.disclosure_text` by `capture-lead`, and the same words are what the
 * carriers are shown as proof of how permission was obtained. If the sentence on the
 * customer's screen and the sentence on the disclosure page ever differ, the disclosure page
 * is a misrepresentation — which is worse than not having one.
 *
 * ⚠️ MIRRORED, BECAUSE IT CANNOT BE IMPORTED. `LeadGate` lives in `StructureStudio.jsx` and
 * its `structure-studio.component.js` twin, which are browser files with no module loader —
 * the same reason `access.ts` is mirrored into the portal. Change this and you MUST change
 * both of those, in the same commit. Search for "may send you text messages about" to find
 * every copy.
 *
 * Every clause is load-bearing and none of them is ours to trim:
 *  - the business name       — a reviewer must see WHO is texting; "this builder" fails
 *  - "text messages about your quote and your building" — the message CATEGORY
 *  - "Message frequency varies."          — required by CTIA in the call-to-action
 *  - "Message and data rates may apply."  — required, and required HERE rather than only
 *                                           inside a linked policy (Twilio error 30924)
 *  - "Reply STOP to opt out at any time." — the mandatory stop instruction
 */
export function smsConsentSentence(companyName: string): string {
  const co = String(companyName || "").trim() || "this builder";
  return (
    "By checking this box, you agree that " + co + " may send you text messages about " +
    "your quote and your building. Message frequency varies. Message and data rates may apply. " +
    "Reply STOP to opt out at any time."
  );
}

/** Where the disclosure page for a tenant lives.
 *
 *  Served by the `sms-optin-disclosure` edge function rather than the marketing site, because
 *  it has to render the tenant's OWN registered details from the database and it has to be
 *  readable by a machine with no JavaScript — the two things the designer page is not. */
export function optInDisclosureUrl(clientId: string): string {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  return `${base}/functions/v1/sms-optin-disclosure?client=${encodeURIComponent(clientId)}`;
}
