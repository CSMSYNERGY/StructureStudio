// The order document's totals, tested against the SHIPPED portal source AND against the
// server function it claims to mirror.
//
// Why this test exists: `ssSnapTotals` in portal/04-orders.jsx carries the comment "MUST match
// _shared/estimateLines.ts `totalFromSnapshot`" and, from migration 158b until 2026-09-02, did
// not — it implemented the pre-tax branch only. Nothing failed. The order document simply
// printed a total short by exactly the tax, and `baselineDriftCents` compared that short figure
// against a tax-inclusive orders.total_cents, so the drift banner fired on every taxed accepted
// order and `stage()` refused, blaming a discarded designer revision for arithmetic. A comment
// is not a test; this is the test.
//
// It does NOT re-implement the rule. It lifts the real block out of the shipped .jsx and asserts
// the two agree on the same snapshot, so the next drift fails the push instead of the customer's
// paperwork. Same technique as wallSlab_test / wallHeight_test: slice between stable anchors,
// guard loudly if they move.

import { assert, assertEquals } from "jsr:@std/assert";
import { totalFromSnapshot } from "../estimateLines.ts";

const SRC = await Deno.readTextFile(
  new URL("../../../../portal/04-orders.jsx", import.meta.url),
);

// The slice is deliberately bounded to the plain-JS money helpers — no JSX crosses it, which is
// what lets `new Function` take it verbatim rather than through a transform that could mask a
// difference between what is tested and what ships.
const START = "const ssRound2 = (n) =>";
const END = "const ssUsd = (n) =>";
const i = SRC.indexOf(START);
const j = SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  throw new Error(
    "orderTotals_test: could not find the totals block in portal/04-orders.jsx " +
      `(start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`,
  );
}
const BLOCK = SRC.slice(i, j);

// Sanity: a bad anchor yields a block that still evaluates but exercises nothing, and every
// assertion below would pass vacuously.
for (const name of ["ssRound2", "ssPoolOf", "ssSnapTotals"]) {
  assert(BLOCK.includes(name), `extracted block is missing ${name}`);
}
assert(BLOCK.includes("snap.tax"), "extracted block never reads snap.tax — this is the bug the test exists for");

type Totals = {
  subtotal: number;
  discount: number;
  tax: number | null;
  taxLabel: string | null;
  total: number;
};
const factory = new Function(`${BLOCK}; return { ssSnapTotals };`);
const { ssSnapTotals } = factory() as { ssSnapTotals: (snap: unknown) => Totals };

// deno-lint-ignore no-explicit-any
const line = (qty: number, amount: number, nonTaxable = false): any =>
  nonTaxable ? { qty, amount, nonTaxable: true } : { qty, amount };

/** The property the whole file is about: the browser and the server must agree to the penny. */
// deno-lint-ignore no-explicit-any
function assertAgrees(snap: any, label: string) {
  const mine = ssSnapTotals(snap).total;
  const theirs = totalFromSnapshot(snap);
  assertEquals(mine, theirs, `${label}: browser ${mine} vs server ${theirs}`);
}

Deno.test("untaxed: unchanged from the pre-tax behaviour", () => {
  const snap = { lines: [line(2, 100), line(1, 50.5)] };
  const t = ssSnapTotals(snap);
  assertEquals(t.subtotal, 250.5);
  assertEquals(t.tax, null);
  assertEquals(t.taxLabel, null);
  assertEquals(t.total, 250.5);
  assertAgrees(snap, "untaxed plain");
});

Deno.test("untaxed: a flat discount still comes off the total", () => {
  const snap = { lines: [line(1, 1000)], discount: 150 };
  const t = ssSnapTotals(snap);
  assertEquals(t.subtotal, 1000);
  assertEquals(t.discount, 150);
  assertEquals(t.total, 850);
  assertAgrees(snap, "untaxed discounted");
});

Deno.test("untaxed: a discount larger than the subtotal clamps at zero, never negative", () => {
  const snap = { lines: [line(1, 100)], discount: 500 };
  assertEquals(ssSnapTotals(snap).total, 0);
  assertAgrees(snap, "untaxed over-discounted");
});

Deno.test("taxed: tax is added to the total — the regression this file exists for", () => {
  const snap = {
    lines: [line(1, 10000)],
    tax: { amount: 725, rate: 0.0725, label: "Sales tax", jurisdiction: "Bibb County, GA" },
  };
  const t = ssSnapTotals(snap);
  assertEquals(t.subtotal, 10000);
  assertEquals(t.tax, 725);
  assertEquals(t.total, 10725);
  assertAgrees(snap, "taxed plain");
});

Deno.test("taxed: designPricedCents matches a tax-inclusive orders.total_cents", () => {
  // This is `baselineDriftCents` in the order document, spelled out. Before the fix the left
  // side was 1000000 against a right side of 1072500 and the drift banner fired on every
  // taxed accepted order.
  const snap = {
    lines: [line(1, 10000)],
    tax: { amount: 725, rate: 0.0725, label: "Sales tax" },
  };
  const designPricedCents = Math.round(ssSnapTotals(snap).total * 100);
  const orderTotalCents = 1000000 + 72500; // pretax_subtotal_cents + tax_cents, per 158b
  assertEquals(designPricedCents, orderTotalCents);
  assertEquals(orderTotalCents - designPricedCents, 0, "baselineDriftCents must be zero");
});

Deno.test("taxed: non-taxable lines stay out of the taxable pool but inside the subtotal", () => {
  const snap = {
    lines: [line(1, 1000), line(1, 200, true)],
    tax: { amount: 72.5, rate: 0.0725 },
  };
  const t = ssSnapTotals(snap);
  assertEquals(t.subtotal, 1200);
  assertEquals(t.total, 1272.5);
  assertAgrees(snap, "taxed mixed pools");
});

Deno.test("taxed: a flat discount nets into the subtotal, not a second deduction", () => {
  const snap = {
    lines: [line(1, 1000)],
    discount: 100,
    tax: { amount: 65.25, rate: 0.0725 },
  };
  const t = ssSnapTotals(snap);
  // Subtotal is already net — the caller must NOT subtract `discount` again.
  assertEquals(t.subtotal, 900);
  assertEquals(t.discount, 100);
  assertEquals(t.total, 965.25);
  assertAgrees(snap, "taxed flat discount");
});

Deno.test("taxed: discount rows split by pool, and an absent flag reads as taxable", () => {
  const snap = {
    lines: [line(1, 1000), line(1, 500, true)],
    discounts: {
      rows: [
        { description: "Spring promo", amount: 100 }, // no flag => taxable
        { description: "Delivery credit", amount: 50, taxable: false },
      ],
    },
    tax: { amount: 65.25, rate: 0.0725 },
  };
  const t = ssSnapTotals(snap);
  assertEquals(t.subtotal, 1350); // (1000-100) + (500-50)
  assertEquals(t.discount, 150);
  assertEquals(t.total, 1415.25);
  assertAgrees(snap, "taxed split discounts");
});

Deno.test("taxed: a pool discounted past zero clamps that pool, not the whole document", () => {
  const snap = {
    lines: [line(1, 100), line(1, 900, true)],
    discounts: { rows: [{ amount: 400 }] }, // taxable pool is only 100
    tax: { amount: 0, rate: 0 },
  };
  const t = ssSnapTotals(snap);
  assertEquals(t.subtotal, 900); // max(0, 100-400) + 900
  assertAgrees(snap, "taxed pool clamp");
});

Deno.test("tax label carries the rate and jurisdiction, exactly as the PDF prints them", () => {
  const t = ssSnapTotals({
    lines: [line(1, 100)],
    tax: { amount: 7.25, rate: 0.0725, label: "Sales tax", jurisdiction: "Bibb County, GA" },
  });
  assertEquals(t.taxLabel, "Sales tax (7.25% · Bibb County, GA)");
});

Deno.test("tax label falls back when the tenant set no label, and drops an empty paren", () => {
  assertEquals(
    ssSnapTotals({ lines: [line(1, 100)], tax: { amount: 7.25, rate: 0.0725 } }).taxLabel,
    "Sales tax (7.25%)",
  );
  assertEquals(
    ssSnapTotals({ lines: [line(1, 100)], tax: { amount: 7.25 } }).taxLabel,
    "Sales tax",
  );
  assertEquals(
    ssSnapTotals({ lines: [line(1, 100)], tax: { amount: 5, rate: 0.05, label: "GST" } }).taxLabel,
    "GST (5%)",
  );
});

Deno.test("a snapshot with no usable tax amount reads as untaxed, never as zero tax", () => {
  // `tax: {}` and a non-finite amount are both "this document was never taxed". Reading either
  // as 0 would switch the document to the taxed layout and hide the Discount row.
  for (const bad of [{}, { amount: null }, { amount: "abc" }]) {
    const snap = { lines: [line(1, 100)], discount: 10, tax: bad };
    const t = ssSnapTotals(snap);
    assertEquals(t.tax, null, `tax ${JSON.stringify(bad)} should read as untaxed`);
    assertEquals(t.total, 90);
    assertAgrees(snap, `untaxed via ${JSON.stringify(bad)}`);
  }
});

Deno.test("a negative stored tax is clamped, matching taxFromSnapshot", () => {
  const snap = { lines: [line(1, 100)], tax: { amount: -5 } };
  assertEquals(ssSnapTotals(snap).tax, 0);
  assertAgrees(snap, "negative tax");
});

Deno.test("an empty or malformed snapshot does not throw", () => {
  assertEquals(ssSnapTotals({ lines: [] }).total, 0);
  assertEquals(ssSnapTotals({}).total, 0);
  assertEquals(ssSnapTotals(null).total, 0);
});
