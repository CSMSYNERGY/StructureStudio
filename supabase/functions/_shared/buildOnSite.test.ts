// Build-on-site pricing rules (migration 183). Dependency-free, so this file belongs to the
// `_shared/*.test.ts` group and runs without an import map.
//
// Imported directly rather than sliced from source: this module exists precisely so the rule
// has one authority, and a test that re-implements it would defeat that.

import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { bosBasisOf, bosQtyFor, bosUnitSuffix, bosCharges } from "./buildOnSite.ts";

// A 12x24 building: 288 sq ft of floor, 72 lineal feet of perimeter. The same worked example
// the Settings screen shows a builder, so a change here shows up as a contradiction there.
const AREA = 288;
const PERIM = 72;

Deno.test("bosBasisOf: the three known bases pass through", () => {
  assertEquals(bosBasisOf("each"), "each");
  assertEquals(bosBasisOf("sqft_building"), "sqft_building");
  assertEquals(bosBasisOf("perimeter_building"), "perimeter_building");
});

Deno.test("bosBasisOf: NULL and junk read as a flat fee, never as a dimensional one", () => {
  // Defaulting the OTHER way would silently multiply a flat call-out by the building's area.
  assertEquals(bosBasisOf(null), "each");
  assertEquals(bosBasisOf(undefined), "each");
  assertEquals(bosBasisOf(""), "each");
  assertEquals(bosBasisOf("   "), "each");
  assertEquals(bosBasisOf("perimeter"), "each");
  assertEquals(bosBasisOf("sqft"), "each");
  assertEquals(bosBasisOf(42), "each");
});

Deno.test("bosQtyFor: a flat fee is quantity ONE, not the building's size", () => {
  // The bug this exists to prevent: $500 flat becoming $144,000 on a 12x24.
  assertStrictEquals(bosQtyFor("each", AREA, PERIM), 1);
});

Deno.test("bosQtyFor: dimensional bases take the geometry submit-estimate already has", () => {
  assertStrictEquals(bosQtyFor("sqft_building", AREA, PERIM), 288);
  assertStrictEquals(bosQtyFor("perimeter_building", AREA, PERIM), 72);
});

Deno.test("bosQtyFor: missing geometry is 0, which stops the line rather than pricing it wrong", () => {
  assertStrictEquals(bosQtyFor("sqft_building", NaN, PERIM), 0);
  assertStrictEquals(bosQtyFor("perimeter_building", AREA, NaN), 0);
  // A flat fee needs no geometry at all, so it survives both.
  assertStrictEquals(bosQtyFor("each", NaN, NaN), 1);
});

Deno.test("bosUnitSuffix: a flat fee reads as a fee, not as a rate per nothing", () => {
  assertEquals(bosUnitSuffix("each"), "");
  assertEquals(bosUnitSuffix("sqft_building"), " / sq ft");
  assertEquals(bosUnitSuffix("perimeter_building"), " / ft");
});

Deno.test("bosCharges: a flagged increase with a real fee charges", () => {
  assertStrictEquals(bosCharges(true, 500, 1), true);
  assertStrictEquals(bosCharges(true, 2.5, 288), true);
});

Deno.test("bosCharges: a flagged increase with NO fee is a builder who absorbs it", () => {
  // Deliberately NOT an error. The building is still stamped built-on-site upstream of this;
  // all that is skipped is the charge line.
  assertStrictEquals(bosCharges(true, null, 1), false);
  assertStrictEquals(bosCharges(true, undefined, 1), false);
  assertStrictEquals(bosCharges(true, 0, 1), false);
});

Deno.test("bosCharges: an unflagged increase never charges, whatever the fee column holds", () => {
  // A stale fee left on a row someone later unticked must not resurrect the line.
  assertStrictEquals(bosCharges(false, 500, 1), false);
  assertStrictEquals(bosCharges(null, 500, 1), false);
  assertStrictEquals(bosCharges(undefined, 500, 1), false);
  // Truthy-but-not-true is refused too: the column is boolean and the guard reads it strictly.
  assertStrictEquals(bosCharges("true", 500, 1), false);
  assertStrictEquals(bosCharges(1, 500, 1), false);
});

Deno.test("bosCharges: a negative or unusable fee never charges", () => {
  assertStrictEquals(bosCharges(true, -100, 1), false);
  assertStrictEquals(bosCharges(true, "abc", 1), false);
  assertStrictEquals(bosCharges(true, Infinity, 1), false);
});

Deno.test("bosCharges: zero quantity means no line even with a real rate", () => {
  // Reached when a dimensional basis meets missing geometry — see bosQtyFor above. Charging
  // rate x 0 would push a $0.00 line onto the customer's estimate for no reason.
  assertStrictEquals(bosCharges(true, 2.5, 0), false);
});

Deno.test("worked example: the numbers the Settings screen promises a builder", () => {
  // Flat: one $500 call-out.
  assertStrictEquals(500 * bosQtyFor(bosBasisOf("each"), AREA, PERIM), 500);
  // Per sq ft: 288 sq ft at $1.50.
  assertStrictEquals(1.5 * bosQtyFor(bosBasisOf("sqft_building"), AREA, PERIM), 432);
  // Per lineal ft: 72 ft at $8.00 — the same perimeter the wall-height increase is charged on,
  // so the two lines on one estimate agree about the building they describe.
  assertStrictEquals(8 * bosQtyFor(bosBasisOf("perimeter_building"), AREA, PERIM), 576);
});
