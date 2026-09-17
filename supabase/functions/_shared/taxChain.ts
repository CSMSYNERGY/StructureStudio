// The tax rate a quote is stamped with when nobody is paying for a lookup, and when a rate
// somebody DID pay for survives a resubmit (2026-09-17).
//
// Since 2026-09-16 no automatic path calls Avalara (salesTax.ts, `allowLookup`). A submit, a
// resubmit and a change order stamp a free default instead, from a chain:
//
//   0. a SIGNED order carries the tax the customer AGREED to, whatever it was — agreedTax. The
//      chain below is for quotes nobody has signed;
//   1. a VERIFIED rate already on the quote (tax.source "avalara"), carried over — carryDecision;
//   2. the rate of the quote's sales location (designs.sales_location_id → builder_locations,
//      migration 245), when that location is this tenant's, active, and carries a rate;
//   3. when the quote has NO location and a signed-in staff member is issuing it for the FIRST
//      time: their home lot's rate (client_users.location_id, migration 234) — and that lot is
//      then recorded as the quote's location, so the next resubmit, by anyone, lands on the same
//      rate (homeLotApplies);
//   4. the company rate (client_settings.ss_tax_rate);
//   5. nothing — the caller refuses rather than issue an untaxed bill.
// Links 2-4 are chooseDefaultRate. A location rate is the builder's LOCAL rate: right in an
// origin-sourced state, a guess across a state line. That is what the paid lookup is for.
//
// WHY THE HOME LOT IS A FIRST-ISSUE RULE (review, 2026-09-17). An issued quote with no location
// is either one that never had a lot or one staff deliberately CLEARED (set_design_sales_location
// with null, or a deleted lot). The two are indistinguishable on the row, and re-applying the home
// lot on every resubmit put a cleared location straight back, at that lot's rate, the next time
// anyone on staff pressed Submit. So link 3 answers only before the quote has a number.
//
// WHY A SIGNED ORDER CARRIES EVERY AGREED RATE (review, 2026-09-17). Carry-over used to be for a
// verified rate only, so a change order on an order signed at a LOCATION rate re-ran the chain:
// a lot deleted or its rate edited since the signature priced the change at a different rate,
// and the change order put a tax-rate line in front of the customer that nobody chose. The rate
// on a signed order changes only by a deliberate future feature, never as a side effect.
//
// WHY CARRY-OVER IS GATED ON THE CALLER. The delivery address arrives in the request body, and
// submit-estimate is reachable with the public anon key. If an address change invalidated a
// verified rate for anyone, a shopper could edit the ZIP on their own designer link, resubmit,
// and choose the cheaper default for their own bill after the builder paid for the real one. So
// a shopper's resubmit always carries the verified rate; only staff can invalidate it, and only
// by moving the delivery state or ZIP.
//
// THE SNAPSHOT SHAPE (designs.estimate_lines.tax) is additive. Every field a reader used before
// stays, with the same meaning, and four arrive:
//   basis        "avalara" | "location" | "company" — which link priced it;
//   locationId   the builder_locations id whose rate applied, when basis is "location";
//   locationName that location's name at the time, for display;
//   verifiedAt   ISO time of the lookup, when basis is "avalara"; null otherwise.
// `source` keeps its two values ("avalara" | "fallback"): taxFreeze and the
// design_acceptances.tax_source CHECK pin exactly those, so which DEFAULT applied lives in
// `basis`, never in a widened `source`. changeOrderDiff compares only `rate` and `amount`, so a
// quote re-stamped at the same rate under a different basis or location raises no change order.
//
// PURE: no network, no database, no clock unless the caller omits `now`. The callers do the
// reads (both edge functions) and hand the rows in.
//
// ⚠️ Bundled per function like every _shared module. Importers today: submit-estimate and
// portal-settings. Derive them before a deploy rather than trusting this line:
//     find supabase/functions -name '*.ts' ! -name '*.test.ts' ! -path '*_test_stubs*' -print0 \
//       | xargs -0 -I{} perl -0777 -ne 'print "$ARGV\n" if m{import[^;]*?from\s+"[^"]*taxChain\.ts"}s' {}

import { sane, stateCode, taxOn } from "./salesTax.ts";

export type TaxBasis = "avalara" | "location" | "company";

/** The reason a staff resubmit gives up a verified rate. Telemetry — never shown to a customer. */
export const ADDRESS_CHANGED = "address changed — re-verify";

/** The builder_locations columns a caller selects for taxChain. */
export const TAX_LOCATION_COLUMNS = "id, client_id, name, active, tax_rate, tax_label";

/** A sales location as the chain uses it. `rate` is already a sane fraction or null. */
export interface TaxLocation {
  id: string;
  name: string | null;
  rate: number | null;
  label: string | null;
}

/** The pools subtotalsFromSnapshot returns, as far as a tax stamp needs them. */
export interface TaxPools {
  taxable: number;
  nonTaxable: number;
  taxableBase: number;
  nonTaxableNet: number;
}

export interface DefaultRate {
  rate: number;
  basis: "location" | "company";
  /** What the tax row is called: the location's own label, else the company's. */
  label: string;
  locationId: string | null;
  locationName: string | null;
  /** Set only when the home lot's rate was used: the id to record as the quote's location. */
  recordLocationId: string | null;
}

const text = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s || null;
};

/**
 * A builder_locations row as a TaxLocation, or null when it may not price this tenant's quote:
 * missing, another tenant's, or inactive. A location with no rate is still a location — it
 * comes back with `rate: null`, so a quote that names it does not borrow a staff member's home
 * lot instead.
 */
export function taxLocationFrom(row: unknown, clientId: string): TaxLocation | null {
  const r = row as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object") return null;
  const id = text(r.id);
  if (!id || !clientId || String(r.client_id ?? "") !== clientId) return null;
  if (r.active !== true) return null;
  return { id, name: text(r.name), rate: sane(r.tax_rate), label: text(r.tax_label) };
}

/**
 * Links 2-4 of the chain. Null means no link has a rate: the caller refuses.
 *
 * `salesLocationId` is the design's stored column, passed separately from the row because the
 * two can disagree: a location that was deactivated (or a read of it that found nothing) still
 * means the quote HAS a location, so a staff member's home lot must not replace it.
 * `homeLot` is only honoured when the quote has no location; callers pass it only for a
 * signed-in staff member issuing a quote nobody has signed.
 */
export function chooseDefaultRate(input: {
  salesLocationId: string | null;
  location: TaxLocation | null;
  homeLot: TaxLocation | null;
  companyRate: unknown;
  companyLabel: string | null;
}): DefaultRate | null {
  const companyLabel = text(input.companyLabel) ?? "Sales tax";
  // Only reached after sane(loc.rate) != null below, so the assertion holds.
  const fromLocation = (loc: TaxLocation, record: boolean): DefaultRate => ({
    rate: sane(loc.rate)!,
    basis: "location",
    label: text(loc.label) ?? companyLabel,
    locationId: loc.id,
    locationName: loc.name,
    recordLocationId: record ? loc.id : null,
  });

  const salesLocationId = text(input.salesLocationId);
  const loc = input.location;
  if (salesLocationId) {
    if (loc && loc.id === salesLocationId && sane(loc.rate) != null) return fromLocation(loc, false);
  } else {
    const home = input.homeLot;
    if (home && sane(home.rate) != null) return fromLocation(home, true);
  }

  const company = sane(input.companyRate);
  if (company == null) return null;
  return { rate: company, basis: "company", label: companyLabel, locationId: null, locationName: null, recordLocationId: null };
}

/**
 * May link 3 run? Only for a staff member signed in as a user (the home lot belongs to a user),
 * on a quote with no location, issued for the FIRST time (no quote number before this submit),
 * that nobody has signed. See the header for why a resubmit never qualifies.
 */
export function homeLotApplies(input: {
  salesLocationId: string | null;
  staffCaller: boolean;
  callerUserId: string | null;
  firstIssue: boolean;
  signed: boolean;
}): boolean {
  return !text(input.salesLocationId) && input.staffCaller === true && !!text(input.callerUserId) &&
    input.firstIssue === true && input.signed !== true;
}

/** The first five characters of a ZIP, trimmed: "63090-1234" and "63090" are one place. */
const zip5 = (zip: unknown): string => String(zip ?? "").trim().slice(0, 5);

/** Same state (through stateCode, so "Ohio", "oh" and "OH" agree) and same five-digit ZIP.
 *  An address missing either on either side is NOT the same place. */
export function sameTaxAddress(a: unknown, b: unknown): boolean {
  const x = (a ?? {}) as { state?: unknown; zip?: unknown };
  const y = (b ?? {}) as { state?: unknown; zip?: unknown };
  const sx = stateCode(x.state), sy = stateCode(y.state);
  const zx = zip5(x.zip), zy = zip5(y.zip);
  return !!(sx && zx && sx === sy && zx === zy);
}

export type CarryDecision = { carry: true } | { carry: false; reason: string | null };

/**
 * Does the tax already on the quote survive this re-stamp?
 *   - not a verified rate (no tax, a default, or a rate that fails `sane`) → no, and no reason:
 *     the chain simply runs;
 *   - a shopper (not staff) → yes, whatever the address says (see the header);
 *   - staff → yes while the stored delivery state + ZIP match the new ones, otherwise no, with
 *     ADDRESS_CHANGED, so the portal can say the verified rate needs verifying again.
 */
export function carryDecision(input: { staffCaller: boolean; storedTax: unknown; address: unknown }): CarryDecision {
  const t = input.storedTax as Record<string, unknown> | null | undefined;
  if (!t || typeof t !== "object" || t.source !== "avalara" || sane(t.rate) == null) {
    return { carry: false, reason: null };
  }
  if (!input.staffCaller) return { carry: true };
  return sameTaxAddress(t.address, input.address) ? { carry: true } : { carry: false, reason: ADDRESS_CHANGED };
}

const taxObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) && sane((v as Record<string, unknown>).rate) != null
    ? v as Record<string, unknown>
    : null;

/**
 * Link 0: the tax a SIGNED order carries, or null for a design nobody has signed (the chain
 * runs) and for a signed one with no usable tax anywhere (a pre-tax agreement, which the chain
 * then prices as it always did).
 *
 * Signed means accepted_at is set, or the accepted snapshot carries a tax — the second arm
 * because accepted_snapshot is the agreement even where accepted_at reads null (a promote that
 * failed after the acceptance froze it). The agreed tax is the accepted snapshot's (153: moved
 * forward only by an acknowledged change order), else the design's own stamped tax — the same
 * order changeOrderDiff's agreedBaseline reads the lines in, for designs signed before
 * accepted_snapshot existed.
 *
 * Callers pass it to carriedTax: rate, label, source, jurisdiction, basis, location, address and
 * the lookup times verbatim; the amount and pools recomputed for the new lines. Whatever happened
 * to the lot or the company rate since the signature, and whoever amends it, staff or not.
 */
export function agreedTax(design: unknown): Record<string, unknown> | null {
  const d = (design ?? {}) as { accepted_at?: unknown; accepted_snapshot?: unknown; estimate_lines?: unknown };
  const snap = d.accepted_snapshot as { estimateLines?: { tax?: unknown } } | null | undefined;
  const fromAgreement = taxObject(snap?.estimateLines?.tax);
  const signed = d.accepted_at != null || fromAgreement != null;
  if (!signed) return null;
  return fromAgreement ?? taxObject((d.estimate_lines as { tax?: unknown } | null | undefined)?.tax);
}

/**
 * A tax moved onto re-priced lines: a verified rate a resubmit keeps (carryDecision), or the
 * rate a signed order was agreed at (agreedTax). The rate, jurisdiction, label, address, source,
 * basis, location and times are carried VERBATIM; what is recomputed is what the lines decide —
 * the amount (through taxOn, at the carried rate) and the four pool figures. The pools cannot be
 * carried: the quote PDF prints its Total from `taxableBase + nonTaxableNet + amount`, so stale
 * pools would print a total for lines the quote no longer has.
 *
 * A stamp from before `basis` existed gains one: "avalara" for a verified rate, and "company"
 * for a default — every default stamped before the chain was the company rate. verifiedAt is
 * the lookup time for a verified rate (its resolvedAt on an old stamp), null otherwise.
 */
export function carriedTax(storedTax: Record<string, unknown>, pools: TaxPools): Record<string, unknown> {
  const verified = storedTax.source === "avalara";
  const basis = verified ? "avalara"
    : storedTax.basis === "location" || storedTax.basis === "company" ? storedTax.basis
    : "company";
  return {
    ...storedTax,
    amount: taxOn(pools.taxableBase, Number(storedTax.rate)),
    taxableSubtotal: pools.taxable,
    nonTaxableSubtotal: pools.nonTaxable,
    taxableBase: pools.taxableBase,
    nonTaxableNet: pools.nonTaxableNet,
    basis,
    locationId: storedTax.locationId ?? null,
    locationName: storedTax.locationName ?? null,
    verifiedAt: verified ? (storedTax.verifiedAt ?? storedTax.resolvedAt ?? null) : null,
  };
}

/**
 * The tax object a caller stamps onto estimate_lines — the fields submit-estimate always wrote,
 * plus the four above. The amount comes from taxOn, once, here, so the stored figure and the
 * printed one are the same computation.
 *
 * `resolved` is what resolveRate returned for `choice.rate`. On the automatic paths that is
 * always a fallback; should a lookup ever answer, the basis is "avalara" whatever `choice` said,
 * because the rate on the document is then Avalara's. `reason` overrides resolved.reason (the
 * ADDRESS_CHANGED case).
 */
export function stampTax(input: {
  pools: TaxPools;
  resolved: { rate: number; source: "avalara" | "fallback"; jurisdiction: string | null; reason: string | null };
  choice: Pick<DefaultRate, "basis" | "label" | "locationId" | "locationName">;
  address: { state: string | null; zip: string | null };
  reason?: string | null;
  now?: string;
}): Record<string, unknown> {
  const { pools, resolved, choice } = input;
  const now = input.now ?? new Date().toISOString();
  const verified = resolved.source === "avalara";
  const reason = input.reason ?? resolved.reason;
  return {
    rate: resolved.rate,
    amount: taxOn(pools.taxableBase, resolved.rate),
    label: choice.label,
    taxableSubtotal: pools.taxable,
    nonTaxableSubtotal: pools.nonTaxable,
    taxableBase: pools.taxableBase,
    nonTaxableNet: pools.nonTaxableNet,
    source: resolved.source,
    jurisdiction: resolved.jurisdiction,
    address: { state: input.address.state, zip: input.address.zip },
    resolvedAt: now,
    ...(reason ? { reason } : {}),
    basis: verified ? "avalara" : choice.basis,
    locationId: verified || choice.basis !== "location" ? null : choice.locationId,
    locationName: verified || choice.basis !== "location" ? null : choice.locationName,
    verifiedAt: verified ? now : null,
  };
}
