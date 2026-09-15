// Foundation item rules (2026-09-14). Dependency-free beyond ./buildOnSite.ts, so this file
// belongs to the `_shared/*.test.ts` group and runs without an import map.
//
// Imported directly rather than sliced from source: this module exists so submit-estimate and
// the designer's hand-mirrored copy (`foundationQtyOf`) have ONE rule to agree with, and a test
// that re-implemented it would be a third copy.

import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { BOS_BASES, bosAmountFor, bosQtyFor } from "./buildOnSite.ts";
import {
  FOUNDATION_COUNT_CAP, FOUNDATION_IDS, FOUNDATION_LABEL, FOUNDATION_QTY_CAP,
  foundationDesc, foundationNeedsQty, foundationQtyFor, isFoundationId,
} from "./foundation.ts";

// A 12x24 building: 288 sq ft of floor, 72 lineal feet of perimeter — the same worked example
// buildOnSite.test.ts and the Settings screen use, so the two modules describe one building.
const AREA = 288;
const PERIM = 72;
const GEOM = { area: AREA, perimeter: PERIM };

Deno.test("isFoundationId: exactly the four items, and every one has a label", () => {
  assertEquals(FOUNDATION_IDS.length, 4);
  for (const id of FOUNDATION_IDS) {
    assertStrictEquals(isFoundationId(id), true);
    assertStrictEquals(typeof FOUNDATION_LABEL[id], "string");
  }
  assertStrictEquals(isFoundationId("slab"), false);
  assertStrictEquals(isFoundationId(""), false);
  assertStrictEquals(isFoundationId(null), false);
  assertStrictEquals(isFoundationId(undefined), false);
  assertStrictEquals(isFoundationId(42), false);
  assertStrictEquals(isFoundationId(["piers"]), false);
});

Deno.test("foundationNeedsQty: the three option-shaped bases ask the customer; the rest read the building", () => {
  assertEquals(BOS_BASES.filter(foundationNeedsQty), ["each", "lineal_ft", "sqft_option"]);
  assertStrictEquals(foundationNeedsQty("sqft_building"), false);
  assertStrictEquals(foundationNeedsQty("perimeter_building"), false);
  assertStrictEquals(foundationNeedsQty("pct_building_price"), false);
  assertStrictEquals(foundationNeedsQty("pct_estimate_total"), false);
});

Deno.test("each: blank is ONE of the thing; a whole number in range is honoured", () => {
  assertEquals(foundationQtyFor("each", null, GEOM), { qty: 1, error: null });
  assertEquals(foundationQtyFor("each", undefined, GEOM), { qty: 1, error: null });
  assertEquals(foundationQtyFor("each", "", GEOM), { qty: 1, error: null });
  assertEquals(foundationQtyFor("each", "   ", GEOM), { qty: 1, error: null });
  // Numeric strings are what an <input> yields.
  assertEquals(foundationQtyFor("each", "3", GEOM), { qty: 3, error: null });
  assertEquals(foundationQtyFor("each", 3, GEOM), { qty: 3, error: null });
  assertEquals(foundationQtyFor("each", FOUNDATION_COUNT_CAP, GEOM), { qty: 1000, error: null });
});

Deno.test("each: a fraction, zero or an oversized count is REFUSED, never rounded or clamped", () => {
  const err = "enter a whole number of units (1–1000)";
  assertEquals(foundationQtyFor("each", 2.5, GEOM), { qty: 0, error: err });
  assertEquals(foundationQtyFor("each", "2.5", GEOM), { qty: 0, error: err });
  assertEquals(foundationQtyFor("each", 0, GEOM), { qty: 0, error: err });
  assertEquals(foundationQtyFor("each", "0", GEOM), { qty: 0, error: err });
  assertEquals(foundationQtyFor("each", 1001, GEOM), { qty: 0, error: err });
  assertEquals(foundationQtyFor("each", -1, GEOM), { qty: 0, error: err });
  assertEquals(foundationQtyFor("each", "abc", GEOM), { qty: 0, error: err });
  assertEquals(foundationQtyFor("each", true, GEOM), { qty: 0, error: err });
});

Deno.test("lineal_ft: blank is an error — nothing on the building is 'the fence'", () => {
  const blank = "enter how many feet";
  assertEquals(foundationQtyFor("lineal_ft", null, GEOM), { qty: 0, error: blank });
  assertEquals(foundationQtyFor("lineal_ft", undefined, GEOM), { qty: 0, error: blank });
  assertEquals(foundationQtyFor("lineal_ft", "", GEOM), { qty: 0, error: blank });
  assertEquals(foundationQtyFor("lineal_ft", "  ", GEOM), { qty: 0, error: blank });
});

Deno.test("lineal_ft: a positive number of feet is honoured; junk is refused", () => {
  const bad = "enter the feet as a number greater than 0";
  assertEquals(foundationQtyFor("lineal_ft", "120", GEOM), { qty: 120, error: null });
  assertEquals(foundationQtyFor("lineal_ft", 120, GEOM), { qty: 120, error: null });
  // Fractional feet are a real measurement.
  assertEquals(foundationQtyFor("lineal_ft", "12.5", GEOM), { qty: 12.5, error: null });
  assertEquals(foundationQtyFor("lineal_ft", FOUNDATION_QTY_CAP, GEOM), { qty: 100000, error: null });
  assertEquals(foundationQtyFor("lineal_ft", -5, GEOM), { qty: 0, error: bad });
  assertEquals(foundationQtyFor("lineal_ft", 0, GEOM), { qty: 0, error: bad });
  assertEquals(foundationQtyFor("lineal_ft", 100001, GEOM), { qty: 0, error: bad });
  assertEquals(foundationQtyFor("lineal_ft", "abc", GEOM), { qty: 0, error: bad });
  assertEquals(foundationQtyFor("lineal_ft", Infinity, GEOM), { qty: 0, error: bad });
});

Deno.test("sqft_option: blank is the building footprint; a typed area overrides it; junk is refused", () => {
  const bad = "enter the square feet as a number greater than 0";
  assertEquals(foundationQtyFor("sqft_option", null, GEOM), { qty: 288, error: null });
  assertEquals(foundationQtyFor("sqft_option", "", GEOM), { qty: 288, error: null });
  // The footprint default is rounded — a pad is sold in whole square feet.
  assertEquals(foundationQtyFor("sqft_option", "", { area: 287.6, perimeter: PERIM }), { qty: 288, error: null });
  assertEquals(foundationQtyFor("sqft_option", "240", GEOM), { qty: 240, error: null });
  assertEquals(foundationQtyFor("sqft_option", 240, GEOM), { qty: 240, error: null });
  assertEquals(foundationQtyFor("sqft_option", "abc", GEOM), { qty: 0, error: bad });
  assertEquals(foundationQtyFor("sqft_option", 0, GEOM), { qty: 0, error: bad });
  assertEquals(foundationQtyFor("sqft_option", -10, GEOM), { qty: 0, error: bad });
  assertEquals(foundationQtyFor("sqft_option", 100001, GEOM), { qty: 0, error: bad });
  assertEquals(foundationQtyFor("sqft_option", NaN, GEOM), { qty: 0, error: bad });
});

Deno.test("whole-building bases read the building and ignore whatever was typed", () => {
  for (const raw of [null, undefined, "", "999", 999, "abc", -1, 2.5]) {
    assertEquals(foundationQtyFor("sqft_building", raw, GEOM), { qty: 288, error: null }, `sqft_building with ${raw}`);
    assertEquals(foundationQtyFor("perimeter_building", raw, GEOM), { qty: 72, error: null }, `perimeter_building with ${raw}`);
    assertEquals(foundationQtyFor("pct_building_price", raw, GEOM), { qty: 1, error: null }, `pct_building_price with ${raw}`);
    assertEquals(foundationQtyFor("pct_estimate_total", raw, GEOM), { qty: 1, error: null }, `pct_estimate_total with ${raw}`);
  }
  // Rounded geometry, same as sqft_option's default.
  assertEquals(foundationQtyFor("sqft_building", null, { area: 287.6, perimeter: 71.5 }), { qty: 288, error: null });
  assertEquals(foundationQtyFor("perimeter_building", null, { area: 287.6, perimeter: 71.5 }), { qty: 72, error: null });
});

Deno.test("foundationDesc: the exact sentence the customer reads, per basis", () => {
  assertStrictEquals(foundationDesc("each", 6, 150), "6 at $150.00 each");
  assertStrictEquals(foundationDesc("lineal_ft", 120, 4), "120 ft at $4.00 per foot");
  assertStrictEquals(foundationDesc("sqft_option", 240, 2.5), "240 sq ft at $2.50 per sq ft");
  assertStrictEquals(foundationDesc("sqft_building", 288, 1.5), "288 sq ft of building at $1.50 per sq ft");
  assertStrictEquals(foundationDesc("perimeter_building", 72, 8), "72 ft of perimeter at $8.00 per foot");
  // Percent rates print as typed — "10%", never "10.00%".
  assertStrictEquals(foundationDesc("pct_building_price", 1, 10), "10% of the building price");
  assertStrictEquals(foundationDesc("pct_estimate_total", 1, 7.5), "7.5% of the rest of this quote");
  // A dollar rate always shows cents, even when typed as a whole number.
  assertStrictEquals(foundationDesc("each", 1, 1.5), "1 at $1.50 each");
  // qty is printed as-is: a fractional measurement is not rounded away in the description.
  assertStrictEquals(foundationDesc("lineal_ft", 12.5, 4), "12.5 ft at $4.00 per foot");
});

Deno.test("worked example: every basis, qty x rate, on the 12x24 the Settings screen shows", () => {
  // Piers: six at $150.
  const piers = foundationQtyFor("each", "6", GEOM);
  assertStrictEquals(piers.error, null);
  assertStrictEquals(piers.qty * bosAmountFor("each", 150, 5000), 900);
  // Fence removal: 120 ft at $4.
  const fence = foundationQtyFor("lineal_ft", "120", GEOM);
  assertStrictEquals(fence.error, null);
  assertStrictEquals(fence.qty * bosAmountFor("lineal_ft", 4, 5000), 480);
  // Gravel pad: nothing typed, so the 288 sq ft footprint, at $2.50.
  const pad = foundationQtyFor("sqft_option", "", GEOM);
  assertStrictEquals(pad.error, null);
  assertStrictEquals(pad.qty * bosAmountFor("sqft_option", 2.5, 5000), 720);
  // Concrete slab priced on the building's sq ft: 288 at $1.50.
  const slab = foundationQtyFor("sqft_building", null, GEOM);
  assertStrictEquals(slab.qty * bosAmountFor("sqft_building", 1.5, 5000), 432);
  // Perimeter: 72 ft at $8.
  const perim = foundationQtyFor("perimeter_building", null, GEOM);
  assertStrictEquals(perim.qty * bosAmountFor("perimeter_building", 8, 5000), 576);
  // Percent of a $5,000 building: 10% resolves now.
  const pctB = foundationQtyFor("pct_building_price", null, GEOM);
  assertStrictEquals(pctB.qty * bosAmountFor("pct_building_price", 10, 5000), 500);
  // Percent of the estimate defers to step 7a — goes out at 0 and is registered, as cladding does.
  const pctE = foundationQtyFor("pct_estimate_total", null, GEOM);
  assertStrictEquals(pctE.qty * bosAmountFor("pct_estimate_total", 10, 5000), 0);
});

Deno.test("the two modules agree: a validated foundation qty fed to bosQtyFor comes back unchanged", () => {
  // submit-estimate validates with foundationQtyFor and then prices through the same bosQtyFor
  // build-on-site uses. The explicit quantity must survive that hand-off for the three bases
  // that carry one, and the whole-building bases must land on the building's own numbers.
  for (const b of BOS_BASES) {
    const raw = b === "each" ? "6" : b === "lineal_ft" ? "120" : b === "sqft_option" ? "240" : null;
    const v = foundationQtyFor(b, raw, GEOM);
    assertStrictEquals(v.error, null, b);
    // Foundation items have no wall area; the option-shaped bases carry their own quantity.
    assertStrictEquals(bosQtyFor(b, AREA, PERIM, 0, v.qty), v.qty, b);
  }
  // A refused value (qty 0) does NOT sneak through as "explicit": it falls back to the
  // whole-building reading, which is why the caller must check `error` before pricing at all.
  const refused = foundationQtyFor("each", "2.5", GEOM);
  assertStrictEquals(refused.qty, 0);
  assertStrictEquals(bosQtyFor("each", AREA, PERIM, 0, refused.qty), 1);
});
