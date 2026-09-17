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

/** verify_tax's payload: { shortCode, confirmResend?, confirmVerify? }. The two confirmations
 *  are true only when literally `true`: a "yes" string from a mis-built request is not consent. */
export function parseVerifyTax(
  payload: unknown,
): { ok: true; value: { shortCode: string; confirmResend: boolean; confirmVerify: boolean } } | { ok: false; refusal: SpendRefusal } {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const shortCode = text(p.shortCode)?.slice(0, 64) ?? null;
  if (!shortCode) return { ok: false, refusal: refuse(400, "bad_request", "shortCode is required.") };
  return { ok: true, value: { shortCode, confirmResend: p.confirmResend === true, confirmVerify: p.confirmVerify === true } };
}

/**
 * May this tenant make a lookup at all? The per-tenant switch (migration 244), then StructureStudio
 * paperwork (a CRM-mode tenant has no quote of ours to stamp), then platform credentials. All
 * three are `lookup_disabled`: to the person pressing, each means the same thing — not here, not
 * now — and the sentence says which.
 */
export function lookupSwitchRefusal(input: { lookupEnabled: boolean; ssMode: boolean; configured: boolean }): SpendRefusal | null {
  if (input.lookupEnabled !== true) {
    return refuse(403, "lookup_disabled", "Verified tax lookups aren't switched on for this account. The quote keeps its current tax rate.");
  }
  if (input.ssMode !== true) {
    return refuse(403, "lookup_disabled", "This account's quotes come from the CRM, so there's no StructureStudio quote to verify tax on.");
  }
  if (input.configured !== true) {
    return refuse(403, "lookup_disabled", "Verified tax lookups aren't available right now. The quote keeps its current tax rate.");
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
    return refuse(409, "no_quote", "This design has no quote yet — issue the quote first, then verify its tax.");
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
    "The customer already has this quote, and verifying the tax may change its total. If it does, we email them the updated quote, or tell you to let them know if we can't. Confirm to go ahead.",
    { quoteNumber: input.quoteNumber ?? null, totalCents: input.totalCents });
}

/** Our own per-minute limit on Verify presses (claim_tax_lookup's `rate_limited`). 429, apart
 *  from Avalara's own 429, which is a 502 `lookup_failed` with failure `rate_limited`. */
export function rateLimitedRefusal(): SpendRefusal {
  return refuse(429, "rate_limited", "Too many tax lookups in the last minute. Nothing was looked up — wait a minute and try again. The quote keeps its current tax rate.",
    { retryAfterSeconds: TAX_LOOKUP_MINUTE_WINDOW_SECONDS });
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
  const keeps = "The quote keeps its current tax rate.";
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
