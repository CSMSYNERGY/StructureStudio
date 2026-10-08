// The company sales tax rate and the "Use tax codes" switch, as portal-settings reads and writes
// them (Settings → Company → Tax, 2026-10-09). The pure half: payload parsing, the refusals the
// save_company_tax action makes before it writes, and the shape the Tax tab reads back. The
// database stays in portal-settings.
//
// WHERE THE RATE IS SET. client_settings.ss_tax_rate / ss_tax_label / ss_tax_delivery (migration
// 158) were only editable on CRM Connection → Estimates & Invoices, where `save` takes them with
// the rest of that card. The Tax tab now owns them through save_company_tax. `save` still takes
// them too, because production's page still posts them there: parseCompanyTax is the parser that
// lived inline in `save`, MOVED HERE WORD FOR WORD so both actions read a rate the same way.
// companyTax.test.ts holds a frozen copy of the old inline code and compares the two over a table
// of inputs; if that parity test fails, production's Estimates & Invoices save has changed.
// It is deliberately NOT locationTax.parseTaxRatePct: that one has a different sentence and
// refuses non-string, non-number values, and production's save must not change behaviour.
//
// WHAT THE RATE DOES. Nothing here changes tax. Every taxable line already gets the one rate the
// chain picks (_shared/taxChain.ts: a verified rate, else the sales location's own, else this
// company rate), and a catalog item marked not taxable is never taxed. The future per-line rule,
// recorded so it is not reinvented: a taxable line with no code uses the chain's rate, a
// non-taxable one is 0, and tax_codes_enabled = false means codes are ignored altogether. No
// quote, PDF or invoice reads tax_codes_enabled today; it only decides whether the Tax tab shows
// the code editor (migration 290 turned it on for every builder who already had codes).
//
// Importers: portal-settings only. Derive them before a deploy rather than trusting this line:
//     find supabase/functions -name '*.ts' ! -name '*.test.ts' ! -path '*_test_stubs*' -print0 \
//       | xargs -0 -I{} perl -0777 -ne 'print "$ARGV\n" if m{import[^;]*?from\s+"[^"]*companyTax\.ts"}s' {}

import { ratePct, TAX_LABEL_MAX } from "./locationTax.ts";

/** The client_settings columns a company-tax save may write. Nothing else, ever: not
 *  invoice_in_ghl, not a ghl_* column, not a numbering counter. */
export type CompanyTaxUpdates = {
  ss_tax_rate?: number | null;
  ss_tax_label?: string;
  ss_tax_delivery?: boolean;
  tax_codes_enabled?: boolean;
};

export type Refusal = { ok: false; status: number; reason: string; error: string };

const refuse = (status: number, reason: string, error: string): Refusal => ({ ok: false, status, reason, error });

/** The refusal `save` has always answered for a rate out of range. Kept word for word. */
export const BAD_RATE = "The sales tax rate must be a percentage between 0 and 25 — for example 7.25.";

/** save_company_tax's refusal when a save would leave paperwork-mode estimates with no rate. */
export const RATE_REQUIRED = "Your estimates need a sales tax rate. Enter 0 if you don't collect sales tax.";

/**
 * The company rate, its label and the delivery switch, as `save` has always read them. Each key
 * is read only when present. The rate is entered as a PERCENT and stored as a FRACTION: blank
 * clears it back to "not set" (null), which the paperwork guards refuse to leave a paperwork-mode
 * builder with; an explicit 0 is a real answer and must survive, hence the blank/zero
 * distinction rather than falsiness. Anything but a number from 0 to 25 is refused with BAD_RATE.
 */
export function parseCompanyTax(payload: Record<string, unknown>): { ok: true; updates: CompanyTaxUpdates } | { ok: false; error: string } {
  const updates: CompanyTaxUpdates = {};
  // The sales tax rate, entered as a PERCENT and stored as a FRACTION. Blank clears it back
  // to "not set", which the guard below then refuses to leave SS mode with. An explicit 0 is
  // a real answer and must survive — hence the blank/zero distinction rather than falsiness.
  if ("ssTaxRate" in payload) {
    const raw = String(payload.ssTaxRate ?? "").trim();
    if (!raw) updates.ss_tax_rate = null;
    else {
      const pct = Number(raw);
      if (!Number.isFinite(pct) || pct < 0 || pct > 25) {
        return { ok: false, error: BAD_RATE };
      }
      // 5dp, matching numeric(7,5): 7.25% -> 0.0725. Rounded here so the stored value is the
      // one the card will read back, rather than a float that redisplays as 7.249999.
      updates.ss_tax_rate = Math.round((pct / 100) * 100000) / 100000;
    }
  }
  if ("ssTaxLabel" in payload) {
    // Printed on the customer's document, so bounded like the numbering prefixes are.
    const l = String(payload.ssTaxLabel ?? "").trim().slice(0, TAX_LABEL_MAX);
    updates.ss_tax_label = l || "Sales tax";
  }
  if ("ssTaxDelivery" in payload) updates.ss_tax_delivery = Boolean(payload.ssTaxDelivery);
  return { ok: true, updates };
}

/**
 * The "Use tax codes" switch: absent (undefined), or a real boolean. Anything else is refused
 * with a sentence rather than coerced, the quoteCornerViews rule: a stray "false" string is
 * truthy, and a switch must never turn on because of one.
 */
export function parseCodesSwitch(payload: Record<string, unknown>): { ok: true; value: boolean | undefined } | Refusal {
  if (!("taxCodesEnabled" in payload)) return { ok: true, value: undefined };
  if (typeof payload.taxCodesEnabled !== "boolean") {
    return refuse(400, "bad_switch", "The tax codes setting has to be on or off.");
  }
  return { ok: true, value: payload.taxCodesEnabled };
}

/** Does save_company_tax need the stored row to decide? Only when no usable rate was sent: a
 *  real rate is allowed in every mode and for a builder with no row (the save creates it). */
export function companyTaxNeedsRow(updates: CompanyTaxUpdates): boolean {
  return !("ss_tax_rate" in updates) || updates.ss_tax_rate == null;
}

/**
 * Why save_company_tax must refuse what it parsed, or null. `row` is the stored client_settings
 * row (only invoice_in_ghl is read) and null when the builder has none.
 *   1. Nothing to save: no key this action knows was sent.
 *   2. No row and no rate: the save would CREATE the row, and since migration 280 a new row starts
 *      in paperwork mode, which needs a rate before its first estimate. `save`'s guard comment
 *      describes this as the case it exists to prevent; a label or the codes switch alone must not
 *      land that row.
 *   3. A blank rate in paperwork mode (invoice_in_ghl exactly false, the same reading as `save`'s
 *      guard): every estimate whose sales location has no rate of its own would be refused. A CRM
 *      mode builder may clear it; their CRM works out the tax. 0 is never refused.
 */
export function companyTaxRefusal(updates: CompanyTaxUpdates, row: { invoice_in_ghl?: unknown } | null): Refusal | null {
  if (!Object.keys(updates).length) {
    return refuse(400, "nothing_to_save", "There's nothing to save — send a sales tax rate, label, delivery setting or the tax codes switch.");
  }
  if (!companyTaxNeedsRow(updates)) return null;
  if (!row) return refuse(400, "rate_required", RATE_REQUIRED);
  // `cur ? cur.invoice_in_ghl !== false : false` is `save`'s reading of the mode; with a row in
  // hand that is: paperwork mode exactly when the column is false.
  if ("ss_tax_rate" in updates && row.invoice_in_ghl === false) return refuse(400, "rate_required", RATE_REQUIRED);
  return null;
}

/** The company rate as the Tax tab reads it, in tax_settings' shapes (ratePct, a label that
 *  falls back to "Sales tax"). A tenant with no row reads as no rate, the default label, no tax
 *  on delivery. */
export function companyTaxView(row: unknown): { companyRatePct: number | null; companyLabel: string; ssTaxDelivery: boolean } {
  const r = (row ?? {}) as { ss_tax_rate?: unknown; ss_tax_label?: unknown; ss_tax_delivery?: unknown };
  return {
    companyRatePct: ratePct(r.ss_tax_rate),
    companyLabel: (r.ss_tax_label as string | null | undefined) ?? "Sales tax",
    ssTaxDelivery: r.ss_tax_delivery === true,
  };
}
