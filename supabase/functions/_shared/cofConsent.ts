// _shared/cofConsent.ts — what a builder agrees to when StructureStudio keeps their card (317).
//
// The Visa/Mastercard stored-credential framework asks for three things before a card on file is
// charged again: tell the cardholder how it will be used, get their agreement, and keep a record
// of it. This module is the one place the sentences live. portal-billing sends the templates to
// the browser in `status` (so the Billing tab never carries its own copy of the wording), renders
// them again itself with the amounts IT computed, and stores that rendering on billing_consents.
//
// ⚠️ ONE RENDERER, TWO COPIES. The browser fills the same {placeholders} with renderCofConsent in
// portal/03-catalog.jsx. Both sides format money the same way (cofMoney here, fmt$ there) and
// _shared/cofConsent.test.ts lifts the browser's function out of the shipped JSX and checks the two
// agree on every template. Change a rule here and that test tells you to change the other.
//
// CHANGING A SENTENCE means bumping COF_CONSENT_VERSION in the same commit. A stored agreement is
// evidence of what someone saw; two different sentences under one version make it worthless.

export const COF_CONSENT_VERSION = "2026-10-20.1";

/** At most this many automatic top-ups in any rolling 24 hours (on top of the hourly cooldown).
 *  Stated in the auto top-up sentence, enforced in walletTopup.ts autoTopupDecision. */
export const AUTO_TOPUP_DAILY_MAX = 5;

export const COF_CONSENT_TEMPLATES = {
  // Subscribe. Every new subscription is a new recurring agreement, card on file or not.
  subscription:
    "I agree that CSM Synergy may keep {card} on file, charge {today}, and charge {recurring} automatically at each renewal until I cancel. I can cancel any feature in Billing, and it stays on until the end of the period I have paid for.",
  // The builder's first top-up: a new card, or the first time a stored card pays for top-ups.
  // It names every later use of the card for top-ups, the operator's included: a top-up CSM
  // Synergy adds without the builder asking at that moment is merchant-initiated, and a
  // merchant-initiated charge must be one the stored agreement disclosed (see
  // consentCoversOperatorTopups below, which portal-billing checks before such a charge).
  topup:
    "I agree that CSM Synergy may keep {card} on file, charge {amount} now to add funds to my wallet, and charge it again only when I add funds, when automatic top-ups I switch on are due, or when CSM Synergy adds funds to my wallet for me. I will get an email receipt for every top-up I do not make myself. I can turn automatic top-ups off at any time in Billing.",
  // Switching automatic top-ups on (or changing their amounts).
  autoTopup:
    "I agree that CSM Synergy may charge {card} {amount} whenever my available wallet balance falls below {threshold}, at most once an hour and no more than {dailyMax} times in 24 hours. I will get an email receipt for each charge, and I can change or turn off automatic top-ups at any time in Billing.",
  // Replacing the card on file.
  cardUpdate:
    "I agree that CSM Synergy may keep this card on file in place of my current one and use it for my subscription renewals, top-ups I make, top-ups CSM Synergy adds to my wallet for me, and any automatic top-ups I have switched on. I will get an email receipt for every top-up I do not make myself. I can cancel or turn these off at any time in Billing.",
} as const;

/** The first sentence version whose top-up and card-replacement wording discloses top-ups CSM
 *  Synergy adds without the builder asking. Versions are dated, so they compare as strings.
 *  An operator's "the owner did not ask" top-up is refused unless the agreement behind the card's
 *  current unscheduled initial is at least this version. */
export const OPERATOR_TOPUPS_DISCLOSED_SINCE = "2026-10-20.1";
export function consentCoversOperatorTopups(version: unknown): boolean {
  return typeof version === "string" && /^\d{4}-\d{2}-\d{2}\.\d+$/.test(version) && version >= OPERATOR_TOPUPS_DISCLOSED_SINCE;
}

export type CofConsentKind = keyof typeof COF_CONSENT_TEMPLATES;

/** billing_consents.kind for each template. */
export const CONSENT_ROW_KIND: Record<CofConsentKind, string> = {
  subscription: "subscription_card",
  topup: "topup_card",
  autoTopup: "auto_topup",
  cardUpdate: "card_update",
};

/** Money exactly as the Billing tab prints it (its fmt$): whole dollars without cents. */
export function cofMoney(cents: number): string {
  const c = Math.round(Number(cents) || 0);
  return "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0 });
}

/** "this card" for a card being entered now, else the stored one by its last 4 when we know it. */
export function cofCardPhrase(isNewCard: boolean, last4: string | null | undefined): string {
  if (isNewCard) return "this card";
  return /^\d{4}$/.test(String(last4 ?? "")) ? `my card ending ${last4}` : "my card on file";
}

/** "nothing today" or "$X today": a fully credited upgrade charges nothing, and saying "$0" reads like a bug. */
export function cofTodayPhrase(cents: number): string {
  return cents > 0 ? `${cofMoney(cents)} today` : "nothing today";
}

/** What renews: "$12,000 a year", "$500 a month", or both joined by "plus". */
export function cofRecurringPhrase(yearlyCents: number, monthlyCents: number): string {
  const parts: string[] = [];
  if (yearlyCents > 0) parts.push(`${cofMoney(yearlyCents)} a year`);
  if (monthlyCents > 0) parts.push(`${cofMoney(monthlyCents)} a month`);
  return parts.join(" plus ") || "the renewal price shown";
}

/** Fill {placeholders}. An unknown placeholder renders as itself, so a missing value is visible. */
export function renderCofConsent(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

/** What the browser is told, inside `status`. */
export function cofConsentForBrowser() {
  return { version: COF_CONSENT_VERSION, templates: COF_CONSENT_TEMPLATES, autoTopupDailyMax: AUTO_TOPUP_DAILY_MAX };
}

export const CONSENT_REQUIRED_MESSAGE =
  "Please tick the box to agree to how your card will be charged, then try again.";
export const CONSENT_STALE_MESSAGE =
  "The wording of the card agreement changed. Refresh the page, read it again and tick the box.";

/** Why a request's consent (`consent: { version, accepted: true }`) is refused, or null when it is fine. */
export function consentProblem(payload: unknown): string | null {
  const c = (payload as { consent?: { version?: unknown; accepted?: unknown } } | null)?.consent;
  if (!c || c.accepted !== true) return CONSENT_REQUIRED_MESSAGE;
  if (c.version !== COF_CONSENT_VERSION) return CONSENT_STALE_MESSAGE;
  return null;
}

/** The card details the browser read off Collect.js's callback. Only a well-formed last 4 survives. */
export function cardFromPayload(payload: unknown): { last4: string | null; brand: string | null } {
  const card = (payload as { card?: { last4?: unknown; brand?: unknown } } | null)?.card;
  const last4 = typeof card?.last4 === "string" && /^\d{4}$/.test(card.last4) ? card.last4 : null;
  const brand = typeof card?.brand === "string" && /^[a-z ]{2,20}$/i.test(card.brand.trim()) ? card.brand.trim().toLowerCase() : null;
  return { last4, brand };
}

// deno-lint-ignore no-explicit-any
type Admin = any;

/**
 * Write one agreement row. Returns its id, or throws: a money path calls this BEFORE the charge
 * and refuses to charge when it cannot be written (the auditStrict rule — if we cannot record
 * what the cardholder agreed to, we do not charge them).
 */
export async function recordConsent(admin: Admin, row: {
  clientId: string;
  kind: CofConsentKind;
  wording: string;
  terms: Record<string, unknown>;
  userId: string | null;
  userEmail: string | null;
  cardLast4: string | null;
  req: Request | null;
}): Promise<number> {
  const h = row.req?.headers;
  const ip = (h?.get("x-forwarded-for") ?? "").split(",")[0].trim() || h?.get("cf-connecting-ip") || null;
  const { data, error } = await admin.from("billing_consents").insert({
    client_id: row.clientId,
    kind: CONSENT_ROW_KIND[row.kind],
    wording_version: COF_CONSENT_VERSION,
    wording: row.wording,
    terms: row.terms,
    user_id: row.userId,
    user_email: row.userEmail,
    card_last4: row.cardLast4,
    ip: ip ? ip.slice(0, 64) : null,
    user_agent: (h?.get("user-agent") ?? "").slice(0, 300) || null,
  }).select("id").maybeSingle();
  if (error || !data?.id) throw new Error("We couldn't record your card agreement, so nothing was charged. Try again in a moment.");
  return Number(data.id);
}

/** Stamp the approved transaction onto the agreement it backs. Best-effort: the money already moved. */
export async function stampConsent(admin: Admin, consentId: number | null, txn: string | null): Promise<void> {
  if (!consentId || !txn) return;
  await admin.from("billing_consents").update({ transaction_id: txn }).eq("id", consentId)
    .then(() => undefined, () => undefined);
}
