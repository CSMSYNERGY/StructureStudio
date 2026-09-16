// Per-location tax rates and a quote's sales location, as portal-settings reads and writes them
// (migration 243, 2026-09-17). The pure half: payload parsing, the percent <-> fraction
// round-trip, whether a location can carry a rate at all, and the decision a re-stamp of an
// issued quote has to make before it writes anything. The database, the PDF and the email stay
// in portal-settings.
//
// WHY A RATE NEEDS AN ADDRESS. A location rate is the builder's LOCAL rate, and the only thing
// that makes a number local is the place it belongs to. The live location rows arrived with
// every failure a free-text address can have: active lots with no state or ZIP at all, a state
// name where a code belongs, the same state spelled two ways. A rate on a lot with no usable
// state + ZIP is a number nobody can check against anything, so save_location_tax refuses it,
// and `taxReady` tells the settings card which lots are ready. The state goes through
// stateCode() for the same reason the lookup does: "Ohio", "oh" and "OH" are one state.
//
// WHY A RE-STAMP ASKS BEFORE IT RE-SENDS. An issued quote's PDF lives at a fixed path and the
// customer's quote page renders live, so re-pricing a quote that was already emailed changes the
// total in front of a customer who was never told. When the total moves on an emailed quote, the
// caller must say so (confirmResend) and the quote is sent again; a re-stamp that leaves the
// total where it was sends nothing.
//
// Importer: portal-settings only. Derive it before a deploy rather than trusting this line:
//     find supabase/functions -name '*.ts' ! -name '*.test.ts' ! -path '*_test_stubs*' -print0 \
//       | xargs -0 -I{} perl -0777 -ne 'print "$ARGV\n" if m{import[^;]*?from\s+"[^"]*locationTax\.ts"}s' {}

import { designTotalCents } from "./estimateLines.ts";
import { sane, stateCode } from "./salesTax.ts";

/** The builder_locations columns the tax settings read. */
export const LOCATION_TAX_COLUMNS = "id, client_id, name, city, state, zip, active, tax_rate, tax_label";

/** The designs columns a quote re-stamp reads and guards on. */
export const RESTAMP_DESIGN_COLUMNS =
  "short_code, status, accepted_at, updated_at, estimate_lines, total_cents, ss_quote_number, ss_quote_sent_at, image_url";

/** Printed on the customer's document; the same cap as ss_tax_label and migration 243's CHECK. */
export const TAX_LABEL_MAX = 40;

/** Design statuses that mean the customer already agreed (migration 197's save_design guard). */
const AGREED_STATUSES = new Set(["accepted", "invoiced", "delivered"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s || null;
};

/** A stored fraction as the percent a settings card shows: 0.0725 -> 7.25. The same rounding the
 *  `status` action uses for the company rate, so both cards read a rate back identically. */
export function ratePct(rate: unknown): number | null {
  const r = sane(rate);
  return r == null ? null : Math.round(r * 1000000) / 10000;
}

/** Can this location carry a tax rate? A ZIP, and a state stateCode() can turn into a code. */
export function locationTaxReady(row: unknown): boolean {
  const r = (row ?? {}) as { state?: unknown; zip?: unknown };
  return !!(text(r.zip) && stateCode(r.state));
}

export interface LocationTaxView {
  id: string;
  name: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  active: boolean;
  taxRatePct: number | null;
  taxLabel: string | null;
  taxReady: boolean;
}

/** A builder_locations row in the shape tax_settings and save_location_tax return. */
export function locationTaxView(row: unknown): LocationTaxView {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    name: text(r.name),
    city: text(r.city),
    state: text(r.state),
    zip: text(r.zip),
    active: r.active === true,
    taxRatePct: ratePct(r.tax_rate),
    taxLabel: text(r.tax_label),
    taxReady: locationTaxReady(r),
  };
}

export type Refusal = { ok: false; status: number; reason: string; error: string };
type Parsed<T> = { ok: true; value: T } | Refusal;

const refuse = (status: number, reason: string, error: string): Refusal => ({ ok: false, status, reason, error });

/**
 * A rate typed as a PERCENT, stored as a FRACTION. Blank ("", null, undefined, whitespace)
 * clears it; an explicit 0 is a real rate and survives. A number or a numeric string, 0-25,
 * rounded to five places to match numeric(7,5) — rounded here so the stored value is the one
 * the card reads back, not a float that redisplays as 7.249999. Anything else is refused rather
 * than coerced: Number(true) is 1, and 1% is not what anybody typed.
 */
export function parseTaxRatePct(raw: unknown): { ok: true; rate: number | null } | Refusal {
  if (raw == null || (typeof raw === "string" && !raw.trim())) return { ok: true, rate: null };
  const bad = refuse(400, "bad_rate", "The tax rate must be a percentage between 0 and 25 — for example 7.25. Leave it blank to use the company rate.");
  if (typeof raw !== "number" && typeof raw !== "string") return bad;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 25) return bad;
  // `+ 0` folds a -0 (from "-0") into 0.
  return { ok: true, rate: Math.round((pct / 100) * 100000) / 100000 + 0 };
}

/** The label a location's tax row prints under. Blank means "use the company's label". */
export function parseTaxLabel(raw: unknown): string | null {
  if (raw == null) return null;
  return String(raw).trim().slice(0, TAX_LABEL_MAX).trim() || null;
}

/**
 * save_location_tax's payload: { locationId, taxRatePct, taxLabel? }. taxRatePct is REQUIRED
 * (blank or null clears) so a request that forgot the field cannot read as "clear my rate".
 * An absent taxLabel leaves the stored label alone (`label` undefined); null or blank clears it.
 */
export function parseSaveLocationTax(payload: unknown): Parsed<{ locationId: string; rate: number | null; label?: string | null }> {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const locationId = text(p.locationId);
  // A malformed id names no location: the same 404 as another tenant's, so neither is told apart.
  if (!locationId || !UUID.test(locationId)) return refuse(404, "location_not_found", "Location not found.");
  if (!("taxRatePct" in p)) return refuse(400, "bad_rate", "taxRatePct is required — send a blank to clear the rate.");
  const rate = parseTaxRatePct(p.taxRatePct);
  if (!rate.ok) return rate;
  const value: { locationId: string; rate: number | null; label?: string | null } = { locationId, rate: rate.rate };
  if ("taxLabel" in p) value.label = parseTaxLabel(p.taxLabel);
  return { ok: true, value };
}

/**
 * set_design_sales_location's payload: { shortCode, locationId: string | null, confirmResend? }.
 * locationId is REQUIRED as a key: null (or blank) clears the quote's location, and a request
 * that simply omitted it must not do that — clearing re-prices the quote at the company rate.
 * confirmResend is true only when it is literally `true`.
 */
export function parseSetSalesLocation(payload: unknown): Parsed<{ shortCode: string; locationId: string | null; confirmResend: boolean }> {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const shortCode = text(p.shortCode)?.slice(0, 64) ?? null;
  if (!shortCode) return refuse(400, "bad_request", "shortCode is required.");
  if (!("locationId" in p)) return refuse(400, "bad_request", "locationId is required — send null to clear the quote's location.");
  const locationId = text(p.locationId);
  if (locationId && !UUID.test(locationId)) return refuse(404, "location_not_found", "Location not found.");
  return { ok: true, value: { shortCode, locationId, confirmResend: p.confirmResend === true } };
}

/** Has the customer agreed to this design? accepted_at is the durable fact; the status ladder is
 *  checked too because sync-design-status re-projects it — migration 197's rule, both arms. */
export function isAgreedDesign(d: unknown): boolean {
  const r = (d ?? {}) as { accepted_at?: unknown; status?: unknown };
  return r.accepted_at != null || AGREED_STATUSES.has(String(r.status ?? ""));
}

/** A tax somebody paid Avalara for — the same test taxChain's carryDecision starts from. */
export function isVerifiedTax(t: unknown): boolean {
  const r = t as Record<string, unknown> | null | undefined;
  return !!r && typeof r === "object" && r.source === "avalara" && sane(r.rate) != null;
}

export type RestampPlan =
  | { ok: false; reason: "no_quote" }
  | { ok: false; reason: "quote_sent"; previousTotalCents: number; totalCents: number }
  | {
    ok: true;
    snap: Record<string, unknown>;
    previousTotalCents: number;
    totalCents: number;
    changed: boolean;
    /** The quote was emailed and its total moved: send it again. */
    resend: boolean;
  };

/**
 * What putting `tax` onto an issued quote does, before anything is written.
 *   - no issued quote (no snapshot, no tax on it, or a total that cannot be computed): no_quote —
 *     there is nothing to re-price, and inventing a first tax stamp is submit-estimate's job;
 *   - emailed, the total moves, and the caller did not confirm: quote_sent, with both totals so
 *     the confirmation can name them;
 *   - otherwise the new snapshot (every key kept, `tax` replaced), both totals, and whether the
 *     quote must be sent again (only when it was emailed AND the total moved).
 * Totals are compared as designTotalCents computes them, from the snapshot on both sides, never
 * against the stored total_cents column — an old row whose column lags its snapshot must not
 * read as "the total moved" and trigger a re-send over nothing.
 */
export function restampPlan(input: {
  snap: unknown;
  tax: Record<string, unknown>;
  sent: boolean;
  confirmResend: boolean;
}): RestampPlan {
  const s = input.snap as Record<string, unknown> | null | undefined;
  if (!s || typeof s !== "object" || !s.tax || typeof s.tax !== "object") return { ok: false, reason: "no_quote" };
  if (!input.tax || typeof input.tax !== "object") return { ok: false, reason: "no_quote" };
  const snap = { ...s, tax: input.tax };
  const previousTotalCents = designTotalCents(s);
  const totalCents = designTotalCents(snap);
  if (previousTotalCents == null || totalCents == null) return { ok: false, reason: "no_quote" };
  const changed = totalCents !== previousTotalCents;
  if (input.sent && changed && !input.confirmResend) {
    return { ok: false, reason: "quote_sent", previousTotalCents, totalCents };
  }
  return { ok: true, snap, previousTotalCents, totalCents, changed, resend: input.sent && changed };
}

/**
 * After a re-stamp is written: does the quote go back out to the customer, and if not, what is
 * the rep told? Only a plan that says `resend` sends anything. It sends only when the quote PDF
 * was rebuilt. That PDF sits at a fixed path the email links to. When the rebuild failed
 * (upload error, render error), the file still prints the OLD total. An email sent anyway puts
 * the new total in its body and links a document with the old one, so the customer gets two
 * totals in one message. Holding the send back leaves the old email and the old PDF agreeing
 * with each other. The rep gets `resent: false` and a reason, and can resend once the PDF
 * rebuilds. A quote with no number cannot be emailed at all (resend_quote_email refuses it), so
 * that case is named on its own rather than blamed on the PDF.
 */
export function restampResend(input: {
  resend: boolean;
  quoteNumber: unknown;
  quotePdfUrl: string | null;
}): { send: true } | { send: false; reason: string | null } {
  if (!input.resend) return { send: false, reason: null };
  if (!input.quoteNumber) return { send: false, reason: "the quote couldn't be emailed from here" };
  if (!input.quotePdfUrl) return { send: false, reason: "the quote PDF couldn't be rebuilt, so it wasn't emailed again" };
  return { send: true };
}
