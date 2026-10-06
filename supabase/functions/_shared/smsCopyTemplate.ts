/**
 * Suggested texting-registration wording for a builder who has not written any yet.
 *
 * Carolyn, 2026-09-17: once one registration was approved, "I want it to basically prefill for
 * them" — and she narrowed it to the messages builders say they send. The example messages and
 * the opt-in answer are what keep getting refused, so those are what this fills in. The portal
 * shows it in the Text Messaging form with a line saying so and a "Start blank" link; it is
 * never submitted by itself, and it never replaces anything the builder typed or saved
 * (portal-sms only offers it while the stored copy is empty, and the form only takes it while
 * it is untouched).
 *
 * THE RECIPE IS THE ONE THE CARRIERS APPROVED (2026-09-22), not one we made up:
 *  - the description names the business, who is texted, what about, and how they agreed;
 *  - the opt-in answer quotes the tick-box sentence WORD FOR WORD, says the box is unticked and
 *    optional, points at the public disclosure page with the policy links, and says each tick
 *    is kept with the customer's record;
 *  - every example starts "<Business>:", writes [Name] instead of a customer, and ends with how
 *    to stop.
 *
 * ⚠️ EVERY SENTENCE HAS TO BE TRUE FOR THIS BUILDER, or the suggestion IS the rejection. So it is
 * built only from facts the server holds — the business name customers see, the designer's own
 * tick-box sentence, the designer and disclosure addresses, the two policy addresses — and it
 * returns null rather than guess:
 *  - no business name: the box would read "this builder", which reads as a refusal;
 *  - the tick box switched off (client_settings.lead_sms_consent_box, migration 242): the
 *    designer shows no box, so "customers tick the box" would be false. That builder declares
 *    some other opt-in, and only they can describe it;
 *  - a designer or disclosure address that is not a web address.
 * Two opt-in routes are deliberately NOT described: permission a staff member records by hand,
 * and customers who text first. The approved recipe never proved them, and a reviewer who
 * cannot see them on a page counts them against the builder.
 *
 * ⚠️ THE SENTENCE IS IMPORTED, NEVER RETYPED. smsConsentSentence() is the one copy the
 * designer's box mirrors byte for byte; a retyped copy here would drift and quote the carriers
 * a sentence the customer never saw.
 *
 * ⚠️ PUBLIC REPO. No business name, number or address may appear in this file: the only names in
 * the output are the ones passed in at runtime.
 *
 * Pure and dependency-free apart from smsConsentText.ts (no jsr:, no npm:, no I/O), so the
 * pre-push gate runs its test with no import map and no network.
 */

import { smsConsentSentence } from "./smsConsentText.ts";

export type SuggestedCopy = {
  description: string;
  messageFlow: string;
  messageSamples: string[];
};

export type SuggestedCopyInput = {
  /** client_configs.company_name — the name the designer's tick box shows. */
  companyName: string;
  /** designerUrl(clientId) — where customers tick the box. */
  designerUrl: string;
  /** optInDisclosureUrl(clientId) — the public page with the same wording. */
  disclosureUrl: string;
  /** sms_registrations.privacy_policy_url / terms_url — each named only when present. */
  privacyUrl?: string | null;
  termsUrl?: string | null;
  /** client_settings.lead_sms_consent_box. Anything but true means no suggestion. */
  consentBoxOn: boolean;
};

/** A web address, trimmed, or "" — so a blank or malformed one is simply left out. */
function webAddress(raw: unknown): string {
  const s = String(raw ?? "").trim();
  return /^https?:\/\/\S+$/i.test(s) ? s : "";
}

export function suggestedCampaignCopy(i: SuggestedCopyInput): SuggestedCopy | null {
  // Trimmed the way smsConsentSentence and the disclosure page trim it, so the quoted sentence
  // and the names around it are the same bytes.
  const co = String(i?.companyName ?? "").trim();
  if (!co || i?.consentBoxOn !== true) return null;
  const designer = webAddress(i.designerUrl);
  const disclosure = webAddress(i.disclosureUrl);
  if (!designer || !disclosure) return null;
  const privacy = webAddress(i.privacyUrl);
  const terms = webAddress(i.termsUrl);

  const links = privacy && terms
    ? `, with links to our Privacy Policy (${privacy}) and Terms (${terms}),`
    : privacy ? `, with a link to our Privacy Policy (${privacy}),`
    : terms ? `, with a link to our Terms (${terms}),`
    : "";

  // ⚠️ NOT "Every message names <Company> and says how to opt out" (the first wording, 2026-10-05
  // review): a text someone types on the record page or in the app goes out as typed, with no
  // business name and no STOP line (sendTenantSms adds neither), so that sentence was false for
  // every builder. What IS true of every text: a STOP reply ends them, because Twilio honours it
  // on every number in the Messaging Service and refuses later sends to that customer.
  return {
    description:
      `${co} texts customers who request a quote with the online designer at ${designer} and ` +
      `tick the texting box. Messages cover their quote, order, delivery and build updates and ` +
      `customer support. Customers can reply STOP to any message to stop getting texts.`,
    messageFlow:
      `Customers opt in on the quote form of our online designer at ${designer}. ` +
      `The texting box is not ticked for them and is not required to get a quote. ` +
      `It reads: "${smsConsentSentence(co)}" ` +
      `The same wording${links} is published at ${disclosure}. ` +
      `Each tick is stored with the customer's record.`,
    messageSamples: [
      `${co}: Hi [Name], your quote for your [Building] is ready. Reply here with any questions. Reply STOP to opt out.`,
      `${co}: Hi [Name], your building is scheduled for delivery on [Date]. Reply HELP for help or STOP to opt out.`,
    ],
  };
}

/** The sms_registrations columns this file reads. */
export type RegistrationCopyRow = {
  campaign_description?: unknown;
  campaign_message_flow?: unknown;
  campaign_message_samples?: unknown;
  privacy_policy_url?: unknown;
  terms_url?: unknown;
};

/** True when a registration row holds no wording at all — the only time a suggestion is offered.
 *  All three fields, because a builder who wrote only a description has started, and their start
 *  must not sit beside our examples as though they wrote those too. */
export function campaignCopyIsEmpty(reg: RegistrationCopyRow | null | undefined): boolean {
  const blank = (v: unknown) => !String(v ?? "").trim();
  const raw = reg?.campaign_message_samples;
  const samples: unknown[] = Array.isArray(raw) ? raw : [];
  return blank(reg?.campaign_description) && blank(reg?.campaign_message_flow) && samples.every(blank);
}

/** portal-sms's `suggestedCopy` for one registration row: null once the row holds any wording,
 *  otherwise the suggestion built with the row's own policy addresses (the ones the details
 *  screen saved, and the ones the disclosure page prints). */
export function suggestedCopyForRow(
  reg: RegistrationCopyRow | null | undefined,
  ctx: { companyName: string; consentBoxOn: boolean; designerUrl: string; disclosureUrl: string },
): SuggestedCopy | null {
  if (!campaignCopyIsEmpty(reg)) return null;
  return suggestedCampaignCopy({
    ...ctx,
    privacyUrl: String(reg?.privacy_policy_url ?? ""),
    termsUrl: String(reg?.terms_url ?? ""),
  });
}
