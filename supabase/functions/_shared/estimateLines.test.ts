/**
 * Unit tests for the amendment half of estimateLines — what is actually owed once change
 * orders are acknowledged.
 *
 * WHY THESE EXIST. The bug they pin was found in production behaviour, not in review: the
 * invoice was built from the estimate_lines snapshot alone, so a MANUAL change order — which
 * moves only the total and never rewrites the priced lines — never reached the bill. A CO
 * acknowledged eighteen seconds before the invoice was issued left the PDF, the customer's
 * card and the sentence they signed all reading $3,400 while the order read $4,050, and
 * "Regenerate & resend" reproduced it exactly. Nothing was stale; the document was built
 * from the wrong source, which is why no timestamp guard could have caught it.
 *
 * So the properties worth pinning are not "the arithmetic adds up" but: the order total wins,
 * the printed lines always foot to it under the PDF's own summing rule, and a bill can
 * never silently disagree with the books.
 *
 * Run (from supabase/functions/_shared/):
 *   deno test --allow-env --node-modules-dir=none estimateLines.test.ts
 * (the pre-push gate runs this for you — see scripts/preflight.mjs)
 */

import {
  amendedInvoiceDocument,
  amountOwed,
  changeOrderDelta,
  orderCentsFromSnapshot,
  round2,
  subtotalsFromSnapshot,
  taxFromSnapshot,
  totalFromSnapshot,
} from "./estimateLines.ts";

// Local assertions rather than jsr:@std/assert, matching customerSession.test.ts: the gate
// runs this group with no import map, and a registry fetch would fail closed offline.
let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) {
    failures++;
    throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** The PDF's own totals arithmetic (estimatePdf.ts): sum(qty × amount), minus the
 *  discount, clamped at zero. Reimplemented here on purpose — if the document builder and
 *  this helper ever diverge, these tests must fail rather than agree with themselves. */
function printedTotal(doc: { lines: any[]; discount: number }): number {
  let subtotal = 0;
  for (const li of doc.lines) subtotal += round2((Number(li?.qty) || 0) * (Number(li?.amount) || 0));
  return Math.max(0, round2(round2(subtotal) - doc.discount));
}

const snap = (lines: Array<[string, number, number]>, discount = 0) => ({
  version: 1,
  discount,
  lines: lines.map(([name, qty, amount]) => ({ kind: "item", itemKey: name, name, desc: "", qty, amount })),
});

/** The live case, in the amounts it actually happened in. */
const CABIN = snap([["Cabin (8x12)", 1, 3400]]);
const CO1 = { co_no: 1, description: "Added a 4' side door, $250", total_before_cents: 340000, total_after_cents: 365000 };
const CO2 = { co_no: 2, description: "Upgraded to a metal roof, $400", total_before_cents: 365000, total_after_cents: 405000 };

Deno.test("changeOrderDelta: signed dollars from the cents columns", () => {
  eq("CO-1 adds 250", changeOrderDelta(CO1), 250);
  eq("a credit is negative", changeOrderDelta({ total_before_cents: 100000, total_after_cents: 90000 }), -100);
  eq("missing columns are zero, not NaN", changeOrderDelta({}), 0);
});

Deno.test("THE BUG: an acknowledged change order reaches the bill", () => {
  // Before the fix this returned 3400 — the number the customer signed for while the
  // order, the balance card and the amendment trail all said 4050.
  eq("owed after two acknowledged COs", amountOwed(CABIN, [CO1, CO2], 405000), 4050);
  eq("the snapshot alone still reads the old figure", totalFromSnapshot(CABIN), 3400);
});

Deno.test("the invoice's lines FOOT to the amount owed", () => {
  const doc = amendedInvoiceDocument(CABIN, [CO1, CO2], 405000);
  eq("total", doc.total, 4050);
  // The property that matters on paper: a customer adding up the rows gets the total.
  eq("lines sum to the printed total", printedTotal(doc), 4050);
  eq("one row per change order", doc.lines.length, 3);
  eq("CO-1 is named", doc.lines[1].name, "Change order CO-1");
  eq("and carries its reason", doc.lines[1].desc, "Added a 4' side door, $250");
  eq("CO-1's amount is the delta", doc.lines[1].amount, 250);
  eq("CO-2's amount is the delta", doc.lines[2].amount, 400);
});

Deno.test("change orders print in co_no order however they arrive", () => {
  const doc = amendedInvoiceDocument(CABIN, [CO2, CO1], 405000);
  eq("CO-1 first", doc.lines[1].name, "Change order CO-1");
  eq("CO-2 second", doc.lines[2].name, "Change order CO-2");
});

Deno.test("the ORDER's total wins, and the difference is named not hidden", () => {
  // A hand-set total on the order that the change orders do not explain. The document must
  // still print the order's number — and must not do it by quietly overriding the Total row
  // while the line items say something else.
  const doc = amendedInvoiceDocument(CABIN, [CO1], 400000);
  eq("total follows the order", doc.total, 4000);
  eq("lines still foot", printedTotal(doc), 4000);
  const adj = doc.lines[doc.lines.length - 1];
  eq("an explicit adjustment row carries the difference", adj.name, "Order adjustment");
  eq("of exactly the unexplained amount", adj.amount, 350);
});

Deno.test("no amendments: byte-for-byte the old behaviour", () => {
  const doc = amendedInvoiceDocument(CABIN, [], 340000);
  eq("total unchanged", doc.total, 3400);
  eq("no rows added", doc.lines.length, 1);
  eq("amountOwed agrees with the snapshot", amountOwed(CABIN, [], 340000), totalFromSnapshot(CABIN));
});

Deno.test("a zero-cost change order is recorded but prints no row", () => {
  // "Swapped the door to the other wall, no charge" — a $0.00 line on a bill reads as an error.
  const free = { co_no: 1, description: "Moved the door, no charge", total_before_cents: 340000, total_after_cents: 340000 };
  const doc = amendedInvoiceDocument(CABIN, [free], 340000);
  eq("no row", doc.lines.length, 1);
  eq("total unchanged", doc.total, 3400);
});

Deno.test("discounts survive amendment", () => {
  // The discount is subtracted AFTER the change orders, which is why the reconciliation has
  // to work in subtotal space — doing it in total space puts the adjustment out by the discount.
  const discounted = snap([["Cabin (8x12)", 1, 3400]], 200);
  eq("snapshot total", totalFromSnapshot(discounted), 3200);
  const doc = amendedInvoiceDocument(discounted, [CO1], 345000);
  eq("owed", doc.total, 3450);
  eq("lines foot through the discount", printedTotal(doc), 3450);
  eq("no adjustment row was needed", doc.lines.length, 2);
});

Deno.test("a credit change order reduces the bill", () => {
  const credit = { co_no: 1, description: "Dropped the loft", total_before_cents: 340000, total_after_cents: 315000 };
  const doc = amendedInvoiceDocument(CABIN, [credit], 315000);
  eq("total", doc.total, 3150);
  eq("negative line", doc.lines[1].amount, -250);
  eq("still foots", printedTotal(doc), 3150);
});

Deno.test("missing inputs stay honest rather than inventing a number", () => {
  eq("no snapshot and no order = unknown", amountOwed(null, [], null), null);
  eq("no snapshot but an order total = the order's", amountOwed(null, [], 405000), 4050);
  eq("snapshot but no order row = snapshot + deltas", amountOwed(CABIN, [CO1], null), 3650);
  eq("null change-order list is not a crash", amountOwed(CABIN, null, 340000), 3400);
});

Deno.test("cents never become a rounding drift", () => {
  const odd = snap([["Shed", 3, 1066.67]]); // 3200.01
  const co = { co_no: 1, description: "Trim", total_before_cents: 320001, total_after_cents: 333334 };
  const doc = amendedInvoiceDocument(odd, [co], 333334);
  eq("total to the cent", doc.total, 3333.34);
  eq("and the lines agree to the cent", printedTotal(doc), 3333.34);
});

if (failures) throw new Error(`${failures} assertion(s) failed`);


// ═══════════════════════════════════════════════════════════════════════════════════════════
// The SALES TAX half (migration 148) — the two pools, per-discount taxability, and the order
// ledger's three money columns. Kept in this file rather than a sibling because it exercises
// the same module and the same snapshot shape as the amendment suite above; the two halves
// share a subject, and a reader chasing "what does estimateLines guarantee" should find both
// in one place. Local assertions, same reason as above: this group runs with no import map.
// ═══════════════════════════════════════════════════════════════════════════════════════════

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}

// The worked example from the plan's mock-ups, so the tests and the document a customer
// receives are demonstrably the same arithmetic.
//   taxable lines    11,200 + (2 x 325) + 600 = 12,450.00
//   non-taxable      150 (setup) + 450 (delivery) =  600.00
const LINES = [
  { kind: "building", name: "12x24 Lofted Barn", qty: 1, amount: 11200 },
  { kind: "door", name: "36\" Steel Door", qty: 2, amount: 325 },   // unit price: line total 650
  { kind: "layout_item", name: "Loft package", qty: 1, amount: 600 },
  { kind: "layout_item", name: "Setup & leveling", qty: 1, amount: 150, nonTaxable: true },
  { kind: "delivery", name: "Delivery", qty: 1, amount: 450, nonTaxable: true },
];

// ── The pools ────────────────────────────────────────────────────────────────────────────

Deno.test("subtotals split the lines by their per-item nonTaxable flag", () => {
  const s = subtotalsFromSnapshot({ lines: LINES })!;
  assertEquals([s.taxable, s.nonTaxable, s.subtotal], [12450, 600, 13050]);
});

Deno.test("a discount lands in the pool the rep chose, and never prorates", () => {
  // Mock-up 3: $500 off the taxable pool, $100 off the non-taxable one.
  const s = subtotalsFromSnapshot({
    lines: LINES,
    discount: 600,
    discounts: {
      rows: [
        { description: "Spring promo", amount: 500, taxable: true },
        { description: "Delivery waiver", amount: 100, taxable: false },
      ],
    },
  })!;
  assertEquals(
    [s.taxableDiscount, s.nonTaxableDiscount, s.taxableBase, s.nonTaxableNet, s.subtotal],
    [500, 100, 11950, 500, 12450],
  );
});

Deno.test("a discount row with no taxable key counts as taxable", () => {
  // The designer's default for a new row. Reading it the other way would quietly remove
  // money from the tax base.
  const s = subtotalsFromSnapshot({ lines: LINES, discounts: { rows: [{ amount: 500 }] } })!;
  assertEquals([s.taxableDiscount, s.nonTaxableDiscount], [500, 0]);
});

Deno.test("an over-sized discount zeroes its own pool and does not spill into the other", () => {
  // Spilling would move money across the tax boundary, which is the one thing the split exists
  // to prevent: the non-taxable pool is untouched at its full 600.
  const s = subtotalsFromSnapshot({
    lines: LINES,
    discounts: { rows: [{ amount: 99999, taxable: true }] },
  })!;
  assertEquals([s.taxableBase, s.nonTaxableNet, s.subtotal], [0, 600, 600]);
});

Deno.test("legacy snapshots — a collapsed discount with no rows is treated as taxable", () => {
  const s = subtotalsFromSnapshot({ lines: LINES, discount: 500 })!;
  assertEquals([s.taxableDiscount, s.nonTaxableDiscount, s.taxableBase], [500, 0, 11950]);
});

Deno.test("subtotalsFromSnapshot returns null with no snapshot", () => {
  assertEquals(subtotalsFromSnapshot(null), null);
  assertEquals(subtotalsFromSnapshot({}), null);
});

// ── The tax figure ───────────────────────────────────────────────────────────────────────

Deno.test("tax is READ from the snapshot, never recomputed from the rate", () => {
  // A stored amount that disagrees with rate x base is returned AS STORED: it is what the
  // customer signed for. Recomputing here is how the invoice comes to differ from the quote.
  assertEquals(taxFromSnapshot({ tax: { rate: 0.0725, amount: 866.38, taxableBase: 11950 } }), 866.38);
  assertEquals(taxFromSnapshot({ tax: { rate: 0.0725, amount: 1.11, taxableBase: 11950 } }), 1.11);
});

Deno.test("taxFromSnapshot is null when the snapshot carries no tax", () => {
  assertEquals(taxFromSnapshot({ lines: LINES }), null);
  assertEquals(taxFromSnapshot({ lines: LINES, tax: {} }), null);
  assertEquals(taxFromSnapshot(null), null);
});

// ── The total ────────────────────────────────────────────────────────────────────────────

Deno.test("the total is tax-inclusive — the mock-up 2 figures", () => {
  const snap = { lines: LINES, tax: { rate: 0.0725, amount: 902.63 } };
  assertEquals(totalFromSnapshot(snap), 13952.63);
});

Deno.test("the total is tax-inclusive with discounts — the mock-up 3 figures", () => {
  const snap = {
    lines: LINES,
    discount: 600,
    discounts: {
      rows: [
        { description: "Spring promo", amount: 500, taxable: true },
        { description: "Delivery waiver", amount: 100, taxable: false },
      ],
    },
    tax: { rate: 0.0725, amount: 866.38 },
  };
  assertEquals(totalFromSnapshot(snap), 13316.38);
});

// ── The legacy branch, pinned ────────────────────────────────────────────────────────────
// Every pre-tax snapshot in the database goes through this branch. It is the ORIGINAL body,
// and these cases exist so a later tidy-up cannot quietly re-express it through the pools —
// which is NOT equivalent, as the over-discount case below shows.

/** The pre-2026-08-27 implementation, inlined verbatim as the oracle. */
function legacyTotal(snap: { lines: { qty?: number; amount?: number }[]; discount?: number }) {
  let subtotal = 0;
  for (const li of snap.lines) subtotal += round2((Number(li?.qty) || 0) * (Number(li?.amount) || 0));
  subtotal = round2(subtotal);
  const discount = Number(snap.discount) || 0;
  if (discount > 0) subtotal = round2(subtotal - discount);
  return Math.max(0, subtotal);
}

Deno.test("a snapshot with no tax key returns exactly the pre-tax number it always did", () => {
  for (const snap of [
    { lines: LINES },
    { lines: LINES, discount: 500 },
    { lines: LINES, discount: 0 },
    { lines: [{ qty: 3, amount: 33.335 }] },        // per-line rounding
    { lines: [{ qty: 1, amount: 100 }], discount: 250 }, // clamped at 0
  ]) {
    assertEquals(totalFromSnapshot(snap), legacyTotal(snap), JSON.stringify(snap));
  }
});

Deno.test("the legacy single clamp is NOT the pool clamp — why that branch is kept verbatim", () => {
  // 100 taxable + 50 non-taxable, discounted by 200. The old code subtracts from the combined
  // subtotal and clamps once: 0. The pools clamp separately and keep the non-taxable 50.
  // Both are defensible; only one is what every existing row already returns.
  const snap = { lines: [{ qty: 1, amount: 100 }, { qty: 1, amount: 50, nonTaxable: true }], discount: 200 };
  assertEquals(totalFromSnapshot(snap), 0);
  assertEquals(subtotalsFromSnapshot(snap)!.subtotal, 50);
});

Deno.test("totalFromSnapshot returns null with no snapshot", () => {
  assertEquals(totalFromSnapshot(null), null);
  assertEquals(totalFromSnapshot({}), null);
  assertEquals(totalFromSnapshot({ lines: "nope" }), null);
});

// ── The order ledger's three columns ─────────────────────────────────────────────────────
// These exist because orders.total_cents became tax-inclusive, and portal-commissions reads it
// as a PRE-TAX base (its base_type is called 'pretax_subtotal'). Getting this wrong pays a rep
// commission on sales tax the builder only collects for the state.

Deno.test("a taxed order splits into pretax + tax = total", () => {
  const m = orderCentsFromSnapshot({ lines: LINES, tax: { rate: 0.0725, amount: 902.63 } })!;
  assertEquals([m.pretaxCents, m.taxCents, m.totalCents], [1305000, 90263, 1395263]);
  assertEquals(m.pretaxCents + (m.taxCents ?? 0), m.totalCents, "the three must reconcile exactly");
});

Deno.test("a taxed order with discounts still reconciles", () => {
  const m = orderCentsFromSnapshot({
    lines: LINES,
    discount: 600,
    discounts: { rows: [{ amount: 500, taxable: true }, { amount: 100, taxable: false }] },
    tax: { rate: 0.0725, amount: 866.38 },
  })!;
  assertEquals([m.pretaxCents, m.taxCents, m.totalCents], [1245000, 86638, 1331638]);
  assertEquals(m.pretaxCents + (m.taxCents ?? 0), m.totalCents);
});

Deno.test("an untaxed order reports NULL tax, not zero — and pretax equals the total", () => {
  // NULL is what lets portal-commissions tell "not taxed" from "taxed at 0%", which is the
  // difference between safely falling back to total_cents and silently over-paying.
  const m = orderCentsFromSnapshot({ lines: LINES, discount: 250 })!;
  assertEquals(m.taxCents, null);
  assertEquals([m.pretaxCents, m.totalCents], [1280000, 1280000]);
});

Deno.test("a 0% tax reports 0, NOT null — an explicit no-tax answer is still an answer", () => {
  const m = orderCentsFromSnapshot({ lines: LINES, tax: { rate: 0, amount: 0 } })!;
  assertEquals(m.taxCents, 0);
});

Deno.test("orderCentsFromSnapshot returns null with no snapshot", () => {
  assertEquals(orderCentsFromSnapshot(null), null);
  assertEquals(orderCentsFromSnapshot({}), null);
});
