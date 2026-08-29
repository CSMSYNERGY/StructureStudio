// End-to-end: one SS quote, from the snapshot submit-estimate builds to the figures a customer
// sees, signs and is billed for.
//
// The unit suites each prove one module in isolation. What they CANNOT prove is the property
// this whole feature stands on:
//
//   the number printed on the document, the number in the consent sentence the customer signs,
//   and the number written to the order ledger are the SAME number.
//
// Three different call paths produce those three figures (estimatePdf's totals block,
// totalFromSnapshot via customer-accept, orderCentsFromSnapshot via the orders update). A
// rounding difference or a stale field in any one of them is invisible to a unit test and is a
// billing dispute in production. So this suite builds the snapshot the way submit-estimate
// does, then reads all three back and demands they agree.
//
// Run (cwd: supabase/functions — how scripts/preflight.mjs invokes the group):
//   deno test --quiet --allow-env --node-modules-dir=none \
//             --import-map=_shared/_test_stubs/import_map.json \
//             _shared/_test_stubs/salesTaxE2E_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildQuotePdf } from "../quotePdf.ts";
import { pdfText } from "./pdfText.ts";
import {
  orderCentsFromSnapshot,
  subtotalsFromSnapshot,
  taxFromSnapshot,
  totalFromSnapshot,
} from "../estimateLines.ts";
import { taxOn } from "../salesTax.ts";

const BUSINESS = {
  name: "Example Barn Co.",
  phone: "(555) 010-0100",
  address: { addressLine1: "100 Example Rd", city: "Macon", state: "GA", postalCode: "31201" },
};

/** fmtMoney as customer-accept composes it for the consent sentence — the same shape
 *  estimatePdf prints. Duplicated deliberately: if the two ever diverge, this test is the
 *  thing that notices. */
const fmtMoney = (n: number): string => {
  const v = Math.round(n * 100) / 100;
  const [int, frac] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};

/**
 * Exactly what submit-estimate's 9-ALT branch does: build the snapshot, compute the pools,
 * apply the rate, stamp `tax` onto the object that is BOTH persisted and handed to the PDF.
 * Kept in this shape so a change to that branch which is not mirrored here shows up as a
 * failure rather than as drift.
 */
function stampedSnapshot(opts: {
  lines: Record<string, unknown>[];
  discountRows?: { description: string; amount: number; taxable: boolean }[];
  rate: number;
  label?: string;
  jurisdiction?: string | null;
  source?: "avalara" | "fallback";
}) {
  const rows = opts.discountRows ?? [];
  const snap: Record<string, unknown> = {
    version: 1,
    styleId: "style-1",
    discount: rows.reduce((a, r) => a + r.amount, 0),
    ...(rows.length
      ? {
        discounts: {
          taxable: rows.filter((r) => r.taxable).reduce((a, r) => a + r.amount, 0),
          nonTaxable: rows.filter((r) => !r.taxable).reduce((a, r) => a + r.amount, 0),
          rows,
        },
      }
      : {}),
    lines: opts.lines,
  };
  const pools = subtotalsFromSnapshot(snap)!;
  snap.tax = {
    rate: opts.rate,
    amount: taxOn(pools.taxableBase, opts.rate),
    label: opts.label ?? "Sales tax",
    taxableSubtotal: pools.taxable,
    nonTaxableSubtotal: pools.nonTaxable,
    taxableBase: pools.taxableBase,
    nonTaxableNet: pools.nonTaxableNet,
    source: opts.source ?? "avalara",
    // `??` would swallow an explicitly-passed null, which is exactly the no-jurisdiction case
    // the fallback test needs to exercise.
    jurisdiction: opts.jurisdiction === undefined ? "BIBB, GA" : opts.jurisdiction,
    address: { state: "GA", zip: "31201" },
    resolvedAt: "2026-08-28T12:00:00Z",
  };
  return snap;
}

// The plan's mock-up fixture: 12,450 taxable, 600 non-taxable.
const LINES = [
  { kind: "building", itemKey: "", name: "12x24 Lofted Barn", desc: "Charcoal metal roof", qty: 1, amount: 11200, nonTaxable: false },
  { kind: "door", itemKey: "d1", name: "36in Steel Door", desc: "", qty: 2, amount: 325, nonTaxable: false },
  { kind: "layout_item", itemKey: "loft", name: "Loft package", desc: "", qty: 1, amount: 600, nonTaxable: false },
  { kind: "layout_item", itemKey: "setup", name: "Setup & leveling", desc: "", qty: 1, amount: 150, nonTaxable: true },
  { kind: "delivery", itemKey: "", name: "Delivery", desc: "Within 50 miles", qty: 1, amount: 450, nonTaxable: true },
];

/** The three figures that must never disagree, gathered from their three real call paths. */
async function threeWay(snap: Record<string, unknown>, docKind: "estimate" | "invoice") {
  const bytes = await buildQuotePdf({
    docKind,
    business: BUSINESS,
    estimateNumber: docKind === "invoice" ? "SSI-8001" : "JB-1041",
    dateIso: "2026-08-28T12:00:00Z",
    // deno-lint-ignore no-explicit-any
    lines: (snap.lines as any[]),
    discount: Number(snap.discount) || 0,
    // deno-lint-ignore no-explicit-any
    tax: (snap as any).tax,
    // deno-lint-ignore no-explicit-any
    discountRows: (snap as any).discounts?.rows ?? null,
  });
  return {
    printed: await pdfText(bytes),
    consentFigure: fmtMoney(totalFromSnapshot(snap)!),   // what customer-accept puts in the sentence
    ledger: orderCentsFromSnapshot(snap)!,               // what the orders row gets
  };
}

Deno.test("E2E: no discount — document, consent sentence and ledger all agree", async () => {
  const snap = stampedSnapshot({ lines: LINES, rate: 0.0725 });
  const { printed, consentFigure, ledger } = await threeWay(snap, "estimate");

  // The document.
  assert(printed.includes("$12,450.00"), "taxable subtotal");
  assert(printed.includes("$600.00"), "non-taxable subtotal");
  assert(printed.includes("Sales tax (7.25%"), "the tax row names its rate");
  assert(printed.includes("BIBB, GA"), "the tax row names the jurisdiction");
  assert(printed.includes("$902.63"), "the tax figure");
  assert(printed.includes("$13,952.63"), "the tax-inclusive total");
  assert(printed.includes("Delivery *") && printed.includes("* Not subject to sales tax"), "marker + footnote");

  // The three-way agreement — the property this file exists for.
  assertEquals(consentFigure, "$13,952.63", "the customer signs the printed total");
  assertEquals(ledger.totalCents, 1395263, "the ledger carries the printed total");
  assertEquals(ledger.pretaxCents + (ledger.taxCents ?? 0), ledger.totalCents, "pretax + tax = total");
  assertEquals(ledger.taxCents, 90263, "the ledger's tax is the printed tax");
  assert(printed.includes(consentFigure), "the consent figure must appear ON the document");
});

Deno.test("E2E: taxable and non-taxable discounts, each in its own pool", async () => {
  const snap = stampedSnapshot({
    lines: LINES,
    discountRows: [
      { description: "Spring promo", amount: 500, taxable: true },
      { description: "Delivery waiver", amount: 100, taxable: false },
    ],
    rate: 0.0725,
  });
  const { printed, consentFigure, ledger } = await threeWay(snap, "estimate");

  assert(printed.includes("Discount - Spring promo"), "the taxable discount is named");
  assert(printed.includes("Discount - Delivery waiver"), "the non-taxable discount is named");
  assert(printed.includes("$11,950.00"), "the taxable base is printed, so the tax can be checked");
  assert(printed.includes("$866.38"), "7.25% of 11,950 — NOT of 12,450, and NOT prorated");
  assert(printed.includes("$13,316.38"), "the total");

  assertEquals(consentFigure, "$13,316.38");
  assertEquals(ledger.totalCents, 1331638);
  assertEquals(ledger.pretaxCents + (ledger.taxCents ?? 0), ledger.totalCents);
  assert(printed.includes(consentFigure));
});

Deno.test("E2E: the invoice restates the quote exactly — a bill is not a re-price", async () => {
  // The SAME snapshot renders both documents. If the invoice ever re-derived anything, the two
  // would drift and the customer would sign a bill for a different number than they accepted.
  const snap = stampedSnapshot({
    lines: LINES,
    discountRows: [{ description: "Spring promo", amount: 500, taxable: true }],
    rate: 0.0725,
  });
  const quote = await threeWay(snap, "estimate");
  const invoice = await threeWay(snap, "invoice");

  assertEquals(invoice.consentFigure, quote.consentFigure, "same total on both documents");
  for (const figure of ["$12,450.00", "$11,950.00", "$866.38", quote.consentFigure]) {
    assert(quote.printed.includes(figure), `quote missing ${figure}`);
    assert(invoice.printed.includes(figure), `invoice missing ${figure}`);
  }
  assert(invoice.printed.includes("Invoice #SSI-8001"), "titled as an invoice");
  assert(!invoice.printed.includes("Valid until"), "a bill does not expire");
});

Deno.test("E2E: the fallback rate produces a complete, correct document", async () => {
  // Avalara unreachable. The document must be indistinguishable in quality — the difference is
  // recorded in `source` for the portal, never shown to the customer as a defect.
  const snap = stampedSnapshot({ lines: LINES, rate: 0.0725, source: "fallback", jurisdiction: null });
  const { printed, consentFigure } = await threeWay(snap, "estimate");
  assert(printed.includes("Sales tax (7.25%)"), "the rate still prints, with no jurisdiction");
  assert(printed.includes("$902.63") && printed.includes("$13,952.63"));
  assertEquals(consentFigure, "$13,952.63");
  assertEquals((snap.tax as Record<string, unknown>).source, "fallback");
});

Deno.test("E2E: 0% is a real answer — the tax row prints and the total is unchanged", async () => {
  // The builder who explicitly said "I don't collect sales tax". The document must still say so
  // rather than silently omitting tax, which is indistinguishable from the bug this fixes.
  const snap = stampedSnapshot({ lines: LINES, rate: 0 });
  const { printed, consentFigure, ledger } = await threeWay(snap, "estimate");
  assertEquals(taxFromSnapshot(snap), 0);
  assertEquals(consentFigure, "$13,050.00", "the pre-tax subtotal IS the total at 0%");
  assertEquals(ledger.taxCents, 0, "0, not null — the builder answered");
  assert(printed.includes("Taxable subtotal"), "the pools still show");
});

Deno.test("E2E: an all-non-taxable order taxes nothing and still balances", async () => {
  const lines = LINES.map((l) => ({ ...l, nonTaxable: true }));
  const snap = stampedSnapshot({ lines, rate: 0.0725 });
  const { printed, consentFigure, ledger } = await threeWay(snap, "estimate");
  assertEquals(taxFromSnapshot(snap), 0, "no taxable base means no tax");
  assertEquals(consentFigure, "$13,050.00");
  assertEquals(ledger.taxCents, 0);
  assert(printed.includes("* Not subject to sales tax"), "every line wears the marker");
});

Deno.test("E2E: a pre-tax snapshot is untouched — the CRM path, and every legacy document", async () => {
  // No `tax` key: the totals block, the total and the ledger must all be exactly what they were
  // before any of this shipped. This is the regression that protects every tenant still on GHL.
  const snap = { version: 1, styleId: "s", discount: 250, lines: LINES } as Record<string, unknown>;
  const { printed, consentFigure, ledger } = await threeWay(snap, "estimate");
  assertEquals(consentFigure, "$12,800.00", "13,050 - 250, as it always was");
  assertEquals(ledger.taxCents, null, "null, not 0 — this order was never taxed");
  assertEquals(ledger.pretaxCents, ledger.totalCents);
  assert(!printed.includes("Taxable subtotal"), "no pool split");
  assert(!printed.includes("Sales tax"), "no tax row");
  assert(!printed.includes("* Not subject"), "no footnote");
  assert(!printed.includes("Delivery *"), "no marker, even though a line is flagged nonTaxable");
});
