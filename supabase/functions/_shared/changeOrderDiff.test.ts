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
import { effectiveRoofProfile, roofLineDesc } from "./roofProfile.ts";

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

Deno.test("the rate chain's bookkeeping keys never raise a change order on their own", () => {
  // 2026-09-17: every re-stamp gains basis / locationId / locationName / verifiedAt, and every
  // snapshot already on a signed order predates them. The first resubmit after that ships must
  // not ask a customer to approve a "change" that is nothing but new bookkeeping — only `rate`
  // and `amount` are money. Also covered: a different label, source, reason, jurisdiction,
  // address and resolvedAt at the same rate and amount.
  const legacy = snap(0.0725, 812);
  const restamped = {
    ...legacy,
    tax: {
      ...legacy.tax, source: "fallback", label: "County tax", reason: "not requested", jurisdiction: null,
      address: { state: "GA", zip: "31201" }, resolvedAt: "2026-09-17T08:00:00Z",
      basis: "location", locationId: "3f0c2b1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c", locationName: "Main lot", verifiedAt: null,
    },
  };
  check("legacy → chain stamp at the same money is not a change", changeOrderDescription(legacy, restamped) === null,
    `got ${JSON.stringify(changeOrderDescription(legacy, restamped))}`);
  const otherLot = { ...restamped, tax: { ...restamped.tax, basis: "company", locationId: null, locationName: null } };
  check("a different basis and location at the same money is not a change", changeOrderDescription(restamped, otherLot) === null,
    `got ${JSON.stringify(changeOrderDescription(restamped, otherLot))}`);
  // And the control: the same bookkeeping move WITH a rate move is still named.
  const moved = { ...otherLot, tax: { ...otherLot.tax, rate: 0.0825, amount: 924 } };
  has("a real rate move is still reported", changeOrderDescription(restamped, moved), "County tax rate: 7.25% → 8.25%");
});

Deno.test("a rep's own price reads as an ordinary price change, and its list amount never shows (migration 277)", () => {
  // submit-estimate keeps the catalog amount a rep replaced as listAmount on the line (for audit).
  // The change order a customer is asked to approve must read the PRICE they are charged, never
  // the list it replaced, and a line that only gained the bookkeeping key is not a change at all.
  const before = { version: 1, discount: 0, lines: [{ kind: "building", itemKey: "", name: "12x24 Lofted Barn", desc: "", qty: 1, amount: 11200 }] };
  const after = { version: 1, discount: 0, lines: [{ kind: "building", itemKey: "", name: "12x24 Lofted Barn", desc: "", qty: 1, amount: 10500, listAmount: 11200 }] };
  const text = changeOrderDescription(before, after);
  has("the price move is named", text, "12x24 Lofted Barn: price $11,200.00 → $10,500.00");
  has("and the total follows it", text, "Total: $11,200.00 → $10,500.00");
  // Re-priced again on a later resubmit: list unchanged, the agreed price is the baseline.
  const again = { ...after, lines: [{ ...after.lines[0], amount: 10800 }] };
  has("a second re-price is measured from the first", changeOrderDescription(after, again), "price $10,500.00 → $10,800.00");
  // Same money, list amount added or moved: nothing for the customer to approve.
  const stamped = { ...before, lines: [{ ...before.lines[0], listAmount: 11200 }] };
  check("a listAmount alone is not a change", changeOrderDescription(before, stamped) === null,
    `got ${JSON.stringify(changeOrderDescription(before, stamped))}`);
  const relisted = { ...after, lines: [{ ...after.lines[0], listAmount: 12000 }] };
  check("a moved list behind the same price is not a change", changeOrderDescription(after, relisted) === null,
    `got ${JSON.stringify(changeOrderDescription(after, relisted))}`);
  lacks("no sentence ever names a list figure the customer was not charged", changeOrderDescription(before, relisted), "12,000");
});

// ── The metal roof profile, per design (2026-10-06) ───────────────────────────────────────────
// A design's Roof line now comes from roofLineDesc. What must hold for the 9 metal designs on the
// platform (none standing seam, none with a pick): resubmitting one, or recolouring it on the order
// screen, regenerates a Roof line identical to the one the customer signed, so no change order.
const roofSnap = (desc: string, amount = 300) => ({
  version: 1, discount: 0, lines: [
    { kind: "building", itemKey: "", name: "10x12 Deluxe Gable", desc: "", qty: 1, amount: 9000 },
    { kind: "roof", itemKey: "", name: "Roof", desc, qty: 1, amount },
  ],
});
/** The Roof line's words exactly as both writers built them before 2026-10-06. */
const legacyRoof = (t: string, c: string) => (!t ? "No roof selected" : c ? `${t} — ${c}` : `${t} — (color TBD)`);

Deno.test("an AG Panel design signed before the profile existed regenerates its Roof line exactly: no change order", () => {
  for (const [t, c] of [["Metal", "Black"], ["Metal", ""], ["Shingle", "Weathered Wood"], ["", ""]]) {
    // Every way a design is "AG Panel": no pick on a style that says nothing, an explicit AG Panel
    // pick, an empty pick, a junk pick, and a standing seam pick on a SHINGLE roof.
    for (const [pick, d3] of [[undefined, {}], [undefined, null], ["agpanel", { roofProfile: "standingseam" }], ["", {}], ["shiny", {}]] as const) {
      const signed = roofSnap(legacyRoof(t, c));
      const regenerated = roofSnap(roofLineDesc(t, c, effectiveRoofProfile(pick, d3)));
      const text = changeOrderDescription(signed, regenerated);
      check(`${JSON.stringify([t, c, pick, d3])}: no change order`, text === null, `got ${JSON.stringify(text)}`);
    }
  }
  const shingle = changeOrderDescription(roofSnap(legacyRoof("Shingle", "X")), roofSnap(roofLineDesc("Shingle", "X", effectiveRoofProfile("standingseam", {}))));
  check("a standing seam pick on a shingle roof changes nothing", shingle === null, `got ${JSON.stringify(shingle)}`);
});

Deno.test("AG Panel → Standing Seam on a signed order is exactly \"Roof: options updated\", with no price sentence", () => {
  const signed = roofSnap(roofLineDesc("Metal", "Black", effectiveRoofProfile(undefined, {})));
  const after = roofSnap(roofLineDesc("Metal", "Black", effectiveRoofProfile("standingseam", {})));
  const text = changeOrderDescription(signed, after);
  const lines = (text ?? "").split("\n");
  check("the Roof line is named as updated", lines[0] === "Roof: options updated", JSON.stringify(text));
  check("and nothing else moved: only the unchanged Total follows", lines.length === 2 && lines[1] === "Total: $9,300.00 → $9,300.00", JSON.stringify(text));
  lacks("no price sentence: v1 adds no charge", text, "price");
  // And back again reads the same way.
  check("Standing Seam → AG Panel likewise", changeOrderDescription(after, signed) === text, JSON.stringify(changeOrderDescription(after, signed)));
});

if (failures) throw new Error(`${failures} failed`);
