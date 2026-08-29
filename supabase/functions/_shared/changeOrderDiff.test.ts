// Unit tests for the sales-tax sentence in changeOrderDescription (migration 158).
//
// WHY THESE EXIST. totalFromSnapshot is tax-inclusive now, and change orders re-resolve the
// rate — so a CO can move the Total with no line and no discount behind it. The customer is
// being asked to APPROVE that number. "Total: $12,000.00 → $12,050.00" with nothing else on
// the page reads as a mistake, and a customer who reads it as a mistake either refuses or
// calls; either way the builder pays for the silence. So the property pinned here is not the
// arithmetic but that a moved total always carries its own explanation.
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
import { changeOrderDescription } from "./changeOrderDiff.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; throw new Error(`${name}${detail ? `: ${detail}` : ""}`); }
}
function has(name: string, text: string | null, needle: string) {
  check(name, !!text && text.includes(needle), `expected to contain ${JSON.stringify(needle)}, got ${JSON.stringify(text)}`);
}
function lacks(name: string, text: string | null, needle: string) {
  check(name, !text || !text.includes(needle), `expected NOT to contain ${JSON.stringify(needle)}, got ${JSON.stringify(text)}`);
}

const LINES = [
  { kind: "building", itemKey: "", name: "12x24 Lofted Barn", desc: "", qty: 1, amount: 11200 },
  { kind: "delivery", itemKey: "", name: "Delivery", desc: "", qty: 1, amount: 450, nonTaxable: true },
];
/** A snapshot at a given rate, with the tax stamped the way submit-estimate stamps it. */
const snap = (rate: number, amount: number, lines = LINES) => ({
  version: 1, discount: 0, lines,
  tax: { rate, amount, label: "Sales tax", taxableSubtotal: 11200, nonTaxableSubtotal: 450,
         taxableBase: 11200, nonTaxableNet: 450, source: "avalara" },
});

Deno.test("a rate change with no line change is NAMED, not left as a bare Total", () => {
  // The case this file exists for: nothing moved except the jurisdiction's rate.
  const text = changeOrderDescription(snap(0.07, 784), snap(0.0725, 812));
  has("names the rate move", text, "Sales tax rate: 7% → 7.25%");
  has("shows the money", text, "$784.00 → $812.00");
  has("still states the total", text, "Total:");
});

Deno.test("tax that moves because the LINES moved says so without claiming a rate change", () => {
  const bigger = [...LINES, { kind: "layout_item", itemKey: "loft", name: "Loft", desc: "", qty: 1, amount: 600 }];
  const text = changeOrderDescription(snap(0.0725, 812), snap(0.0725, 855.5, bigger));
  has("the added line is named", text, "Added: Loft");
  has("the tax move is named", text, "Sales tax: $812.00 → $855.50");
  lacks("but NOT as a rate change — the rate held", text, "rate:");
});

Deno.test("an unchanged rate and unchanged tax says nothing about tax at all", () => {
  const text = changeOrderDescription(snap(0.0725, 812), snap(0.0725, 812));
  check("no change at all yields no description", text === null, `got ${JSON.stringify(text)}`);
});

Deno.test("rates are compared at STORED precision, not at display precision", () => {
  // 7.2500% vs 7.2504% both render "7.25%" to two decimals. Comparing the formatted string
  // would call these identical and say nothing, while the customer's total visibly moved.
  const text = changeOrderDescription(snap(0.07250, 812), snap(0.07254, 812.45));
  has("the sub-display-precision move is still reported", text, "Sales tax rate:");
});

Deno.test("the builder's own label is used, not a hardcoded 'Sales tax'", () => {
  const a = { ...snap(0.05, 560), tax: { ...snap(0.05, 560).tax, label: "GST" } };
  const b = { ...snap(0.06, 672), tax: { ...snap(0.06, 672).tax, label: "GST" } };
  has("uses GST", changeOrderDescription(a, b), "GST rate: 5% → 6%");
});

Deno.test("a pre-tax pair is untouched — no tax sentence appears", () => {
  // Every CRM-mode design and every SS design issued before tax shipped. The description
  // must read exactly as it did before this shipped.
  const before = { version: 1, discount: 0, lines: LINES };
  const after = { version: 1, discount: 0, lines: [...LINES, { kind: "layout_item", itemKey: "loft", name: "Loft", desc: "", qty: 1, amount: 600 }] };
  const text = changeOrderDescription(before, after);
  has("the line diff still works", text, "Added: Loft");
  lacks("no tax sentence", text, "Sales tax");
});

Deno.test("tax appearing for the first time is reported rather than sliding in silently", () => {
  // A design quoted pre-tax, then re-issued once the builder set a rate. The total jumps and
  // the customer is owed a reason.
  const before = { version: 1, discount: 0, lines: LINES };
  const text = changeOrderDescription(before, snap(0.0725, 812));
  has("names it", text, "Sales tax rate: 0% → 7.25%");
});

if (failures) throw new Error(`${failures} failed`);
