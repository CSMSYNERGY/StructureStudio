// No-EIN texting (Twilio's Sole Proprietor A2P tier, 2026-10-27): the plain "Needs attention"
// sentences a sole proprietor's registration can carry, the mapping from Twilio's sole-prop
// rejection codes to them, and the rule for clearing them. Two functions write these notes,
// portal-sms (its poll and its stages, through portal-sms/soleProp.ts, which re-exports all of
// this so its imports did not move) and twilio-events (the Event Streams echo of the same
// verdicts). They live here because one function may not import another's files: a function is
// deployed alone, with _shared, and a cross-function import breaks the day either side moves.
//
// ⚠️ PURE. No database, no Twilio, no Deno APIs: twilio-events runs this inside its five-second
// budget, and _shared/smsSoleProprietorNotes.test.ts drives it with no import map.
//
// ⚠️ NOTHING HERE TOUCHES AN EIN BUILDER. Every caller asks for these only on a row whose
// brand_tier is "sole_proprietor"; the EIN tiers keep the sentences they had, written where they
// always were.

// ── The step notes: a stage that refused, or a wait that ran long ─────────────────────────────

/** ready / profile_pending, while the operator's switch (client_settings.sms_sole_prop) reads off. */
export const SOLE_PROP_OFF_NOTE =
  "Texting without an EIN isn't switched on for this account yet, so nothing was sent to the carriers and nothing was charged. Contact support.";
/** ready: the recorded customer profile is not a Starter one (readySoleProprietor). */
export const SOLE_PROP_NOT_STARTER_NOTE =
  "This account already has business details at Twilio that were made for a business with an EIN, so they can't be used to register without one. Nothing was charged. Contact support so we can sort it out with you.";
/** ready: the recorded trust product is not a Sole Proprietor one (readySoleProprietor). */
export const SOLE_PROP_TRUST_PRODUCT_NOTE =
  "This account already has a texting profile at Twilio that was made for a business with an EIN, so it can't be used to register without one. Nothing was charged. Contact support so we can sort it out with you.";
/** brand_approved: Twilio did not offer the SOLE_PROPRIETOR use case, so no campaign was made. */
export const SOLE_PROP_NO_USE_CASE_NOTE =
  "The carriers did not offer the sole proprietor campaign for this registration, so no campaign was sent. Contact support so we can look at it with you.";
/** brand_pending: approved, and the owner's YES still has not come 30 days after the brand. */
export const SOLE_PROP_LATE_NOTE =
  "Twilio is still waiting for your YES reply to its text, and it has been more than 30 days since this registration was sent. Twilio may expire it. Contact support so we can help.";
/** brand_pending → brand_failed: TCR expired the brand because the YES never came. */
export const SOLE_PROP_EXPIRED_NOTE =
  "Twilio expired this registration because the YES reply to its text did not arrive within 30 days. It has to be removed and sent again. Contact support.";

// ── Clearing them ─────────────────────────────────────────────────────────────────────────────

/**
 * The notes that stop being true the moment the registration moves on: the switch was off, the
 * recorded profile was not a Starter one, the use case was missing, the YES was late. Each says
 * "nothing was sent" or "still waiting", and until 2026-10-27's review nothing cleared them on the
 * normal path, so a builder whose YES landed on day 31 read "Twilio is still waiting for your YES"
 * over the campaign card for the whole of its review, and the row stayed in the operators'
 * needs_attention list.
 *
 * NOT in the list, on purpose:
 *   * SOLE_PROP_TRUST_PRODUCT_NOTE: the row that carries it is still at `ready`, and the only way
 *     on from there is readySoleProprietor, which clears every note itself when it succeeds;
 *   * SOLE_PROP_EXPIRED_NOTE and the code sentences below: they describe a FAILED brand or
 *     campaign, and the resubmit that answers each one already clears its note;
 *   * anything not written by this file. Another note (a refused number, a suspended brand, an
 *     operator's own) is someone else's to clear, and wiping it would hide it.
 */
export const SOLE_PROP_STEP_NOTES: readonly string[] = Object.freeze([
  SOLE_PROP_LATE_NOTE,
  SOLE_PROP_NO_USE_CASE_NOTE,
  SOLE_PROP_OFF_NOTE,
  SOLE_PROP_NOT_STARTER_NOTE,
]);

/** Is this attention_note one of the step notes above, word for word? */
export function isSoleProprietorStepNote(note: unknown): boolean {
  return typeof note === "string" && SOLE_PROP_STEP_NOTES.includes(note);
}

/** The patch that drops a step note once its step has moved on: needs_attention off and the note
 *  gone when the row's current note is one of them, else nothing at all (`{}`, so a spread of it
 *  leaves the caller's update exactly what it was). */
export function clearSoleProprietorStepNote(attentionNote: unknown): Record<string, unknown> {
  return isSoleProprietorStepNote(attentionNote) ? { needs_attention: false, attention_note: null } : {};
}

// ── Twilio's sole-prop rejection codes, in plain words ────────────────────────────────────────

/** The sole-prop brand codes (Twilio's sole-proprietor brand troubleshooting page, 2026-07-21). */
const BRAND_NOTES: Record<number, string> = {
  30701: "The carriers couldn't confirm the email address or the street address on this registration. Use your own working email and a real US or Canadian street address (a P.O. box is fine), then contact support to send it again.",
  30793: "Twilio received the two parts of this registration the wrong way round. It has to be removed and made again on Twilio's side. Contact support.",
  30791: "The carriers' registry had a temporary problem with this registration. Press Resubmit to try again.",
};
/** The sole-prop campaign codes (Twilio's "Campaign Registration Rejected" article). */
const CAMPAIGN_NOTES: Record<number, string> = {
  30903: "The carriers turned this down as a sole proprietor registration: either the business has a tax ID (an EIN), or the name, email, address or mobile on it couldn't be confirmed. Contact support before sending it again.",
  30914: "The carriers want the campaign to name you, the sole proprietor, exactly as you registered. Start the description and each example message with your own first and last name, then send it again.",
  30915: "The carriers say this business is a registered company (an LLC, a corporation or similar), so it can't text as a sole proprietor. It has to register with its EIN instead, which is a new registration. Contact support.",
};

/** Twilio's rejection codes out of an errors array, whichever vocabulary carried them: REST
 *  (`error_code`, or `code`) or Event Streams (`registrationerrorcode`). */
export function errorCodesOf(errors: unknown): number[] {
  const list = Array.isArray(errors) ? errors : [];
  const out: number[] = [];
  for (const e of list) {
    const r = (e ?? {}) as Record<string, unknown>;
    const n = Number(r.error_code ?? r.code ?? r.registrationerrorcode ?? r.registrationErrorCode ?? NaN);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The attention note for a sole proprietor's failed brand: the first code with a sentence, else
 *  `fallback` (the sentence every tier gets today, from whichever function is writing it). */
export function soleProprietorBrandNote(errors: unknown, fallback: string): string {
  for (const c of errorCodesOf(errors)) if (BRAND_NOTES[c]) return BRAND_NOTES[c];
  return fallback;
}

/** ...and for a sole proprietor's rejected campaign. */
export function soleProprietorCampaignNote(errors: unknown, fallback: string): string {
  for (const c of errorCodesOf(errors)) if (CAMPAIGN_NOTES[c]) return CAMPAIGN_NOTES[c];
  return fallback;
}

// ── A brand-failure EVENT's errors, in the shape the portal reads ─────────────────────────────

/** One entry of sms_registrations.last_errors as the portal reads it (portal/11-sms.jsx: the status
 *  card's short list and SmsErrorList read `error_code`, `description` and `fields`), which is the
 *  shape Twilio's REST BrandRegistration and campaign resources already answer in. */
export type PortalRegistrationError = { error_code: number | null; description: string; fields: string[] };

/**
 * Event Streams' `brandregistrationerrors[]` (each `registrationerrorcode`,
 * `registrationerrordescription`, `registrationerrorfields`; Twilio's brand event schemas, read
 * 2026-10-27) mapped onto that REST shape, so a sole proprietor's brand refused by event shows the
 * same reasons the poll would have stored. An entry already in the REST shape passes through. Not
 * an array: null, and the caller writes nothing (an event with no list must not wipe one the poll
 * stored). Capped at 20 entries: it is a note for a person, not an archive of the payload.
 */
export function brandEventErrors(raw: unknown): PortalRegistrationError[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PortalRegistrationError[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const n = Number(r.registrationerrorcode ?? r.registrationErrorCode ?? r.error_code ?? r.code ?? NaN);
    const fields = r.registrationerrorfields ?? r.registrationErrorFields ?? r.fields;
    out.push({
      error_code: Number.isInteger(n) && n > 0 ? n : null,
      description: String(r.registrationerrordescription ?? r.registrationErrorDescription ?? r.description ?? "").trim(),
      fields: Array.isArray(fields) ? fields.map((f) => String(f)) : [],
    });
    if (out.length >= 20) break;
  }
  return out;
}
