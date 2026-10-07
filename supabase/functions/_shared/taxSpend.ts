// The paid Avalara lookup, as the two builder-facing paths run it (2026-09-17): the Verify
// button (portal-settings `verify_tax`) and the informational invoice-time check
// (portal-settings `send_invoice`). What each path decides before it spends, the ONE function
// allowed to spend, and what a caller does with the answer. The reads, the quote write, the PDF
// and the email stay in portal-settings.
//
// THE ONLY `allowLookup: true` IN THE FUNCTIONS TREE is in paidLookup below. Every automatic
// path passes false (submit, resubmit, change orders, a sales-location change) and the wiring
// tests pin that. A second copy of the "count, record, call, close" sequence would be the copy
// that forgets the cap, so both spenders call this one.
//
// THE ORDER paidLookup FOLLOWS, and why each step is where it is:
//   1. the claim (taxLookups.ts claimLookup → claim_tax_lookup): the daily cap, the Verify
//      button's per-minute cap and the ledger row, in ONE locked database step, BEFORE the
//      request. Anything but a written row refuses: an unreadable count or an unwritable row is
//      an uncapped run billed to the account, and a lookup with no row is one nothing counts;
//   2. the request (resolveRate, opted in);
//   3. the row closed with what came back. Best-effort, because the request already happened,
//      and an in-flight row still counts toward the cap.
// The cap cannot be overshot by a parallel burst. The claim for one tenant waits on the lock
// until the previous claim's row is committed, then counts it. This replaced a count read here
// and an insert made afterwards, which let every press in a burst at 99 through, plus a
// separate fail-open per-minute counter.
//
// ONE CHARGE PER LEDGER ROW, AND ONLY FOR A RATE THAT CAME BACK. chargeLookup keys the charge on
// the row id (taxMeter's ledger key), so a deliberate second press is a second charge and a
// retried charge for the same row collapses. A failed lookup is never charged: the builder got
// nothing, and a delivered figure with no charge is the acceptable direction, never the reverse.
// Both meters are disarmed, so today every charge is a no-op that reports `inactive`.
//
// REFUSE THE BUTTON, NEVER THE INVOICE (plan v2, the empty-wallet rule; built 2026-10-05). The
// charge posts after the fact and lets the balance go negative (taxMeter.ts says why), so the
// wallet is checked BEFORE the spend, and only for the Verify button: verifyWalletRefusal runs
// after verify_tax's confirmations and before paidLookup, so a press the wallet cannot cover
// writes no ledger row and makes no call. A press is discretionary and refusing it costs the
// customer nothing. An invoice is already promised, so send_invoice's check never asks the
// wallet: an empty wallet still gets its invoice sent, checked, and charged into the negative.
// The check is a read, not a hold: two presses at the same moment can both pass on the last
// ten cents and take the wallet one charge below zero. Holds are what the invoice path cannot
// use (taxMeter.ts, "WHY DIRECT-POST"), and one lookup's overshoot is not worth a second scheme.
//
// ⚠️ Bundled per function like every _shared module. Importer today: portal-settings. Derive
// them before a deploy rather than trusting this line:
//     find supabase/functions -name '*.ts' ! -name '*.test.ts' ! -path '*_test_stubs*' -print0 \
//       | xargs -0 -I{} perl -0777 -ne 'print "$ARGV\n" if m{import[^;]*?from\s+"[^"]*taxSpend\.ts"}s' {}

import { subtotalsFromSnapshot } from "./estimateLines.ts";
import { ratePct } from "./locationTax.ts";
import {
  type AvalaraFailure,
  type AvalaraResult,
  isConfigured,
  resolveRate,
  sane,
  stateCode,
  type TaxAddress,
  taxable,
} from "./salesTax.ts";
import { stampTax } from "./taxChain.ts";
import { claimLookup, DAILY_TAX_LOOKUP_CAP, finishLookup, TAX_LOOKUP_MINUTE_WINDOW_SECONDS } from "./taxLookups.ts";
import { chargeTaxCalculation, type TaxChargeResult, type TaxMeterKind } from "./taxMeter.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

/** A refusal, ready for `json(r.body, r.status)`. Every body carries `error` + `reason`. */
export interface SpendRefusal {
  status: number;
  body: { error: string; reason: string } & Record<string, unknown>;
}

const refuse = (status: number, reason: string, error: string, extra: Record<string, unknown> = {}): SpendRefusal =>
  ({ status, body: { error, reason, ...extra } });

const text = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s || null;
};

// ── verify_tax: the refusals before any spend ──────────────────────────────────────────────

/** verify_tax's payload: { shortCode, confirmResend?, confirmVerify?, quotedPriceCents? }. The two
 *  confirmations are true only when literally `true`: a "yes" string from a mis-built request is
 *  not consent. `quotedPriceCents` is the price the builder's confirm stated (2026-10-05): a
 *  whole number of cents, or null when the confirm named none (absent, null, or anything that is
 *  not a whole non-negative number: a price nobody can read was not shown). */
export function parseVerifyTax(
  payload: unknown,
):
  | { ok: true; value: { shortCode: string; confirmResend: boolean; confirmVerify: boolean; quotedPriceCents: number | null } }
  | { ok: false; refusal: SpendRefusal } {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const shortCode = text(p.shortCode)?.slice(0, 64) ?? null;
  if (!shortCode) return { ok: false, refusal: refuse(400, "bad_request", "shortCode is required.") };
  const q = p.quotedPriceCents;
  const quotedPriceCents = typeof q === "number" && Number.isInteger(q) && q >= 0 ? q : null;
  return { ok: true, value: { shortCode, confirmResend: p.confirmResend === true, confirmVerify: p.confirmVerify === true, quotedPriceCents } };
}

/**
 * May this tenant make a lookup at all? The per-tenant switch (migration 244), then StructureStudio
 * paperwork (a CRM-mode tenant has no quote of ours to stamp), then platform credentials. All
 * three are `lookup_disabled`: to the person pressing, each means the same thing — not here, not
 * now — and the sentence says which.
 */
export function lookupSwitchRefusal(input: { lookupEnabled: boolean; ssMode: boolean; configured: boolean }): SpendRefusal | null {
  if (input.lookupEnabled !== true) {
    return refuse(403, "lookup_disabled", "Verified tax lookups aren't switched on for this account. The estimate keeps its current tax rate.");
  }
  if (input.ssMode !== true) {
    return refuse(403, "lookup_disabled", "This account's estimates come from the CRM, so there's no StructureStudio estimate to verify tax on.");
  }
  if (input.configured !== true) {
    return refuse(403, "lookup_disabled", "Verified tax lookups aren't available right now. The estimate keeps its current tax rate.");
  }
  return null;
}

/**
 * What the quote itself has to be before a lookup is worth paying for, in the order refusals
 * are reported:
 *   no_quote          nothing to stamp: no snapshot, no tax on it, or lines that price to no
 *                     pools. A first tax stamp is submit-estimate's job, so "issue the quote
 *                     first" — and this comes BEFORE the ledger, so a press on a draft costs
 *                     nothing;
 *   no_address        a lookup needs a ZIP and a state stateCode() can turn into a region code.
 *                     Asking anyway buys a wrong answer or a billed refusal;
 *   confirm_operator  a platform operator in view-as is spending a builder's allowance, so it
 *                     takes an explicit confirmation in the body — the portal's dialog is a
 *                     courtesy, not a control (send_invoice's confirmSend precedent).
 */
export function verifyQuoteRefusal(input: {
  snap: unknown;
  address: TaxAddress;
  operator: boolean;
  confirmVerify: boolean;
}): SpendRefusal | null {
  const s = input.snap as Record<string, unknown> | null | undefined;
  if (!s || typeof s !== "object" || !s.tax || typeof s.tax !== "object" || !subtotalsFromSnapshot(s)) {
    return refuse(409, "no_quote", "This design has no estimate yet — issue the estimate first, then verify its tax.");
  }
  if (!taxable(input.address)) {
    return refuse(400, "no_address", "Add the customer's state and ZIP code to the delivery address first — the tax rate is looked up for that address.");
  }
  if (input.operator && input.confirmVerify !== true) {
    return refuse(409, "confirm_operator", "You're viewing this account as an operator, and verifying tax is a paid lookup on the builder's account. Confirm to go ahead (confirmVerify).");
  }
  return null;
}

/**
 * A quote the customer already holds needs confirmResend BEFORE the lookup, not after it.
 * Whether the total moves is only known once the rate is back, and by then the call is paid
 * for, so the confirmation covers "it may change, and if it does the customer has to hear the
 * new total". After the lookup, restampQuoteTax re-sends only when the total really moved, and
 * only by email; a customer it cannot email is named back to the rep to tell.
 *
 * `inCustomerHands` is locationTax.ts' quoteInCustomerHands: emailed, or issued and handed over
 * some other way (a text, a print). The sentence does not say how the customer got it.
 */
export function quoteSentRefusal(input: {
  inCustomerHands: boolean;
  confirmResend: boolean;
  quoteNumber: unknown;
  totalCents: number | null;
}): SpendRefusal | null {
  if (!input.inCustomerHands || input.confirmResend === true) return null;
  return refuse(409, "quote_sent",
    "The customer already has this estimate, and verifying the tax may change its total. If it does, we email them the updated estimate, or tell you to let them know if we can't. Confirm to go ahead.",
    { quoteNumber: input.quoteNumber ?? null, totalCents: input.totalCents });
}

/** Our own per-minute limit on Verify presses (claim_tax_lookup's `rate_limited`). 429, apart
 *  from Avalara's own 429, which is a 502 `lookup_failed` with failure `rate_limited`. */
export function rateLimitedRefusal(): SpendRefusal {
  return refuse(429, "rate_limited", "Too many tax lookups in the last minute. Nothing was looked up — wait a minute and try again. The estimate keeps its current tax rate.",
    { retryAfterSeconds: TAX_LOOKUP_MINUTE_WINDOW_SECONDS });
}

// ── verify_tax: the wallet, the last refusal before the spend (2026-10-05) ───────────────────

/** The meter a Verify press is charged on: chargeLookup's kind in verify_tax, and the price row
 *  the wallet check and tax_settings read. One name, so the check cannot read another meter's
 *  price than the one the charge posts to. */
export const VERIFY_TAX_METER: TaxMeterKind = "tax_lookup";

/**
 * What verifyWalletRefusal decides on. A `null` field is a read that failed; verifyWalletFrom
 * builds this from the rows. The two exemptions are chargeTaxCalculation's: the wallet's
 * metered_exempt and the account's billing_exempt.
 */
export interface VerifyWallet {
  /** usage_prices(tax_lookup).active. A missing row is false: the charge reports unknown_meter. */
  armed: boolean | null;
  priceCents: number | null;
  exempt: boolean | null;
  balanceCents: number | null;
  heldCents: number | null;
}

const finiteCents = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/**
 * The rows verify_tax read, as a VerifyWallet. A read that failed is null in every field it
 * would have filled, so a check that needs it refuses. A wallet with no row is a tenant never
 * charged for anything: balance 0, nothing held, not exempt (wallet_credit creates the row on
 * the first charge). A balance that is not a number counts as unread, not as zero and not as
 * "enough": `NaN < price` is false, and that is a free lookup on an armed meter.
 */
export function verifyWalletFrom(input: {
  price: { data: unknown; error: unknown };
  wallet: { data: unknown; error: unknown };
  billingExempt: boolean;
}): VerifyWallet {
  const priceRead = !input.price?.error;
  const walletRead = !input.wallet?.error;
  const p = (priceRead ? input.price?.data ?? null : null) as Record<string, unknown> | null;
  const w = (walletRead ? input.wallet?.data ?? null : null) as Record<string, unknown> | null;
  return {
    armed: priceRead ? p?.active === true : null,
    // A missing price row is a meter that charges nothing: 0, not unread.
    priceCents: priceRead ? (p ? finiteCents(p.price_cents) : 0) : null,
    exempt: input.billingExempt === true ? true : walletRead ? w?.metered_exempt === true : null,
    balanceCents: walletRead ? (w ? finiteCents(w.balance_cents) : 0) : null,
    heldCents: walletRead ? (w ? finiteCents(w.held_cents ?? 0) : 0) : null,
  };
}

/** Cents as dollars for a sentence: 10 → "$0.10", -30 → "-$0.30". */
const usd = (cents: number): string => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/**
 * Does the wallet cover one more verified lookup? The same test wallet_hold makes (balance minus
 * what is held, against the price), asked only when a press would really be charged, i.e. when
 * chargeTaxCalculation would post a debit:
 *   exempt (metered_exempt or billing_exempt) → no check, and asked FIRST: an exempt tenant is
 *     never charged, so a price read that failed cannot make its press unsafe;
 *   disarmed, unknown or priced at zero → no check (the charge is a no-op; the live state today);
 *   a read the answer depends on that failed → 503 meter_unavailable. Fail closed, like
 *     wallet_hold: an unreadable wallet on an armed meter is a charge nobody can say is covered;
 *   less available than the price → 402 insufficient_funds, naming both;
 *   otherwise null, and the lookup goes ahead.
 * `balanceCents` on the 402 is what the sentence states: the balance less anything held.
 */
export function verifyWalletRefusal(w: VerifyWallet): SpendRefusal | null {
  // Plain words for a builder: what they can act on is their wallet, not our meter.
  const unavailable = refuse(503, "meter_unavailable",
    "We couldn't check your wallet balance just now, so nothing was looked up. Try again in a minute. The estimate keeps its current tax rate.");
  if (w.exempt === true) return null;
  if (w.armed === null) return unavailable;
  if (w.armed !== true) return null;
  const price = finiteCents(w.priceCents);
  if (price === null) return unavailable;
  if (price <= 0) return null;
  const balance = finiteCents(w.balanceCents), held = finiteCents(w.heldCents);
  if (w.exempt !== false || balance === null || held === null) return unavailable;
  const available = balance - held;
  if (available >= price) return null;
  return refuse(402, "insufficient_funds",
    `A verified tax lookup costs ${usd(price)} and your wallet has ${usd(available)}. Add funds in Settings → Billing. The estimate keeps its current tax rate.`,
    { code: "insufficient_funds", priceCents: price, balanceCents: available });
}

/**
 * What one press will really cost the wallet: the price when chargeTaxCalculation would post a
 * debit (not exempt, armed, priced above zero), otherwise 0. Read it only after
 * verifyWalletRefusal has passed, when every read it depends on succeeded.
 */
export function verifyChargeCents(w: VerifyWallet): number {
  if (w.exempt === true || w.armed !== true) return 0;
  const price = finiteCents(w.priceCents);
  return price !== null && price > 0 ? price : 0;
}

/**
 * Did the confirm the builder said yes to state what this press costs? (2026-10-05.) tax_settings
 * is read once, when the card opens, and its price is null when that read failed, so a portal left
 * open while the meter was armed, or a card whose price read failed, would otherwise charge a
 * figure the dialog never showed. A press that will be charged is refused 409 price_changed, before
 * any spend, whenever the price it carries (quotedPriceCents) is not the charge. The body names the
 * price, and the portal asks again with that figure and repeats the press carrying it. A press that
 * costs nothing is never refused, whatever the dialog said: the builder agreed to pay at least that.
 * Run after verifyWalletRefusal, so a wallet that cannot cover the price hears that first.
 */
export function verifyPriceRefusal(w: VerifyWallet, quotedPriceCents: number | null): SpendRefusal | null {
  const cents = verifyChargeCents(w);
  if (cents <= 0 || quotedPriceCents === cents) return null;
  return refuse(409, "price_changed",
    `A verified tax lookup costs ${usd(cents)} from your wallet. Nothing was looked up, and the estimate keeps its current tax rate. Reload the page to verify at that price.`,
    { priceCents: cents });
}

/**
 * The price a Verify confirm states, for tax_settings: the charge per press, or null when a press
 * costs nothing (disarmed, unpriced, or an exempt tenant: metered_exempt or billing_exempt, the
 * two chargeTaxCalculation skips) or the price is not shown (visible false, the redaction the
 * catalog's wallet payload and portal-billing apply). Null also covers a read that failed, so a
 * dialog that cannot know the price says nothing about one rather than a wrong one; verify_tax
 * then names it (verifyPriceRefusal) before a press is charged.
 */
export function lookupPriceCents(row: unknown, exempt = false): number | null {
  const r = row && typeof row === "object" ? row as Record<string, unknown> : null;
  if (exempt === true || !r || r.active !== true || r.visible === false) return null;
  const cents = finiteCents(r.price_cents);
  return cents != null && cents > 0 ? cents : null;
}

// ── The spend ──────────────────────────────────────────────────────────────────────────────

/** Why a paid lookup produced no rate: Avalara's answer, or one of ours before any request.
 *  `minute_cap` is OUR per-minute Verify limit; `rate_limited` stays Avalara's 429. */
export type PaidLookupFailure = AvalaraFailure | "not_configured" | "daily_cap" | "minute_cap" | "ledger_unavailable";

export type PaidLookup =
  | { ok: true; lookupId: string; rate: number; jurisdiction: string | null; ledgerClosed: boolean }
  /** `lookupId` is null when no row was written (a cap refused the claim, or it failed). */
  | { ok: false; failure: PaidLookupFailure; lookupId: string | null; ledgerClosed: boolean };

/**
 * The one paid lookup. See the header for the order. NEVER THROWS: every outcome is a value,
 * and none of them has touched a quote or a wallet.
 *
 * `fallbackRate` only satisfies resolveRate's signature. On a failure resolveRate hands it back,
 * and no caller here writes it: the Verify button leaves the quote as it was, and the invoice
 * check changes nothing either way.
 */
export async function paidLookup(admin: Admin, input: {
  clientId: string;
  kind: "verify" | "invoice";
  address: TaxAddress;
  fallbackRate: unknown;
  shortCode?: string | null;
  invoiceNumber?: string | number | null;
  actorUserId?: string | null;
  operator?: boolean;
}): Promise<PaidLookup> {
  try {
    const claim = await claimLookup(admin, {
      clientId: input.clientId,
      kind: input.kind,
      shortCode: input.shortCode ?? null,
      invoiceNumber: input.invoiceNumber ?? null,
      actorUserId: input.actorUserId ?? null,
      operator: input.operator === true,
      region: stateCode(input.address?.state) || null,
      postalCode: input.address?.zip ?? null,
    });
    if (!claim.ok) {
      const failure: PaidLookupFailure = claim.refused === "rate_limited" ? "minute_cap" : claim.refused;
      return { ok: false, failure, lookupId: null, ledgerClosed: true };
    }
    const lookupId = claim.id;

    // An object rather than two `let`s: the callback writes these, and TypeScript would narrow a
    // `let reached = false` to `false` straight through the await.
    const seen = { reached: false, closed: false };
    const resolved = await resolveRate(input.address, sane(input.fallbackRate) ?? 0, {
      allowLookup: true,
      onResult: async (hit) => {
        seen.reached = true;
        seen.closed = await finishLookup(admin, lookupId, hit);
      },
    });

    if (!seen.reached) {
      // No request left: the credentials went missing after the caller checked, or the address
      // was not one resolveRate would ask about. The row still has to close, or it sits in flight
      // counting against the cap for 24 hours.
      const configured = isConfigured();
      const unasked: AvalaraResult | "not_configured" = configured
        ? { ok: false, rate: null, jurisdiction: null, httpStatus: null, attempts: 0, failure: "bad_address" }
        : "not_configured";
      const closed = await finishLookup(admin, lookupId, unasked);
      return { ok: false, failure: configured ? "bad_address" : "not_configured", lookupId, ledgerClosed: closed };
    }
    if (resolved.source !== "avalara") {
      return { ok: false, failure: resolved.failure ?? "network", lookupId, ledgerClosed: seen.closed };
    }
    return { ok: true, lookupId, rate: resolved.rate, jurisdiction: resolved.jurisdiction, ledgerClosed: seen.closed };
  } catch {
    // Nothing above throws by contract; if something does, no rate came back and nothing is
    // charged. The row, if written, stays in flight and keeps counting — the safe direction.
    return { ok: false, failure: "network", lookupId: null, ledgerClosed: false };
  }
}

/** The failure a Verify press reports. The quote is unchanged in every case. */
export function verifyLookupRefusal(failure: PaidLookupFailure): SpendRefusal {
  const keeps = "The estimate keeps its current tax rate.";
  switch (failure) {
    case "daily_cap":
      return refuse(429, "daily_cap",
        `This account has used its ${DAILY_TAX_LOOKUP_CAP} verified tax lookups for the last 24 hours. Nothing was looked up. ${keeps}`,
        { dailyCap: DAILY_TAX_LOOKUP_CAP });
    case "minute_cap":
      return rateLimitedRefusal();
    case "ledger_unavailable":
      return refuse(503, "ledger_unavailable", `Couldn't record the tax lookup, so nothing was looked up. Try again in a minute. ${keeps}`);
    case "not_configured":
      return refuse(403, "lookup_disabled", `Verified tax lookups aren't available right now. ${keeps}`);
    case "bad_address":
      return refuse(400, "bad_address", `The tax service couldn't find a rate for this delivery address. Check the street, city, state and ZIP, then try again. ${keeps}`);
    case "credentials_rejected":
      return refuse(502, "lookup_failed", `The tax service didn't accept our account details. ${keeps} Tell CSM Synergy.`, { failure });
    case "subscription":
      return refuse(502, "lookup_failed", `Our tax service account isn't set up for rate lookups yet. ${keeps} Tell CSM Synergy.`, { failure });
    case "rate_limited":
      return refuse(502, "lookup_failed", `The tax service is busy right now. Wait a minute and try again. ${keeps}`, { failure });
    case "timeout":
      return refuse(502, "lookup_failed", `The tax service took too long to answer. Try again. ${keeps}`, { failure });
    case "malformed":
      return refuse(502, "lookup_failed", `The tax service sent back an answer we couldn't read. ${keeps} Tell CSM Synergy if it keeps happening.`, { failure });
    case "network":
    default:
      return refuse(502, "lookup_failed", `Couldn't reach the tax service. Try again. ${keeps}`, { failure: "network" });
  }
}

/**
 * The quote's new `tax`, from a lookup that came back. Through taxChain's stampTax, so the
 * amount is computed once, the same way every other stamp computes it, and the object has the
 * same shape: basis "avalara", verifiedAt now, no location, and no stale `reason` (a staff
 * resubmit's "address changed — re-verify" is answered by this). The label the quote already
 * prints is kept, UNLESS it came from a sales location: "KC sales tax" names a lot's local rate,
 * and printing it over a rate verified for a delivery address in another county or state is
 * wrong (seen live 2026-09-17 on a Minnesota address). A location label, or no label, gives way
 * to the company's. Null when the lines price to no pools (verifyQuoteRefusal has already
 * refused that case).
 */
export function verifiedTax(input: {
  snap: unknown;
  lookup: { rate: number; jurisdiction: string | null };
  companyLabel: unknown;
  address: TaxAddress;
  now?: string;
}): Record<string, unknown> | null {
  const s = input.snap as Record<string, unknown> | null | undefined;
  const pools = subtotalsFromSnapshot(s);
  if (!s || !pools) return null;
  const stored = (s.tax && typeof s.tax === "object" ? s.tax : {}) as Record<string, unknown>;
  const keptLabel = stored.basis === "location" ? null : text(stored.label);
  return stampTax({
    pools,
    resolved: { rate: input.lookup.rate, source: "avalara", jurisdiction: input.lookup.jurisdiction, reason: null },
    choice: { basis: "company", label: keptLabel ?? text(input.companyLabel) ?? "Sales tax", locationId: null, locationName: null },
    address: { state: input.address?.state ?? null, zip: input.address?.zip ?? null },
    now: input.now,
  });
}

/**
 * Charge for a lookup — only one that came back with a rate, and keyed on its ledger row. The
 * caller runs this AFTER the document is written (Verify) or the invoice is recorded (invoice
 * check). Never throws; `no_rate` means nothing was attempted.
 */
export async function chargeLookup(
  admin: Admin,
  lookup: PaidLookup,
  opts: { clientId: string; kind: TaxMeterKind; refType: string; refId: string | null; memo?: string | null; actorUserId?: string | null },
): Promise<TaxChargeResult | { charged: false; reason: "no_rate" }> {
  if (!lookup.ok) return { charged: false, reason: "no_rate" };
  return await chargeTaxCalculation(admin, { ...opts, lookupId: lookup.lookupId });
}

// ── send_invoice: the informational check ──────────────────────────────────────────────────

/** What send_invoice reports about the tax on the invoice it just issued. Additive on the
 *  response. It never says anything about the invoice's totals, which it never changes. */
export type InvoiceTaxCheck =
  /** No lookup was made: the switch is off (or no credentials), this send re-issued an invoice
   *  already checked when it was first issued, or the agreed paperwork carries no tax rate. */
  | { status: "skipped"; reason: "lookup_disabled" | "reissue" | "no_tax" }
  | { status: "failed"; failure: PaidLookupFailure | "no_address"; agreedRatePct: number | null }
  | { status: "matched" | "differs"; verifiedRatePct: number; agreedRatePct: number; jurisdiction: string | null };

/**
 * Whether an invoice send makes its one lookup. A re-send of an issued invoice (a recovered
 * number) does not: the builder would pay again for the same document every time the email is
 * retried. No agreed rate means nothing to compare, so nothing to pay for. An address with no
 * usable state + ZIP is a check that could not run, reported as failed without a request.
 */
export function invoiceTaxCheckPlan(input: {
  lookupEnabled: boolean;
  configured: boolean;
  reissue: boolean;
  agreedTax: unknown;
  address: TaxAddress;
}): { lookup: false; taxCheck: InvoiceTaxCheck } | { lookup: true; agreedRate: number } {
  if (input.lookupEnabled !== true || input.configured !== true) {
    return { lookup: false, taxCheck: { status: "skipped", reason: "lookup_disabled" } };
  }
  if (input.reissue) return { lookup: false, taxCheck: { status: "skipped", reason: "reissue" } };
  const t = input.agreedTax as Record<string, unknown> | null | undefined;
  const agreedRate = t && typeof t === "object" ? sane(t.rate) : null;
  if (agreedRate == null) return { lookup: false, taxCheck: { status: "skipped", reason: "no_tax" } };
  if (!taxable(input.address)) {
    return { lookup: false, taxCheck: { status: "failed", failure: "no_address", agreedRatePct: ratePct(agreedRate) } };
  }
  return { lookup: true, agreedRate };
}

/** The check's answer: the verified rate beside the one the customer agreed, compared at the
 *  five places both are stored to. */
export function invoiceTaxCheck(agreedRate: number, lookup: PaidLookup): InvoiceTaxCheck {
  const agreedPct = ratePct(agreedRate);
  if (!lookup.ok) return { status: "failed", failure: lookup.failure, agreedRatePct: agreedPct };
  const verifiedPct = ratePct(lookup.rate);
  if (verifiedPct == null || agreedPct == null) return { status: "failed", failure: "malformed", agreedRatePct: agreedPct };
  return {
    status: sane(lookup.rate) === sane(agreedRate) ? "matched" : "differs",
    verifiedRatePct: verifiedPct,
    agreedRatePct: agreedPct,
    jurisdiction: lookup.jurisdiction,
  };
}
