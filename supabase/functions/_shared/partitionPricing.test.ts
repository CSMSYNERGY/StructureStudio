// Interior (partition) walls on the estimate (migration 278; v2 geometry and wall height, 2026-10-17):
// the server's reading of itemSummary.partitions, its rates and its charge rule. Dependency-free, so
// this file belongs to the `_shared/*.test.ts` group and runs without an import map. The same rule, end
// to end through submit-estimate and against the designer's own Details rows, is
// submitEstimatePartitionWiring_test.ts.

import { assertEquals } from "jsr:@std/assert@1";
import {
  ftIn, interiorWallRates, interiorWallTableMissing, PARTITION_MAX, PARTITION_OPENINGS_MAX, partitionCharge, partitionDescription, partitionMaxRiseFt,
  partitionOpeningDescription, partitionsFromPayload, partitionStud, RISE_CAP_FT,
} from "./partitionPricing.ts";

// A 12 x 32 building with 8 ft walls: an axis-x wall can be at most 12 ft long, an axis-y one 32, and a
// v2 wall at most the diagonal.
const B = { widthFt: 12, lengthFt: 32 };

// ── v1 (the legacy shape is still read) ─────────────────────────────────────────────────────────
Deno.test("v1: a length is clamped to the building's inside run, by axis", () => {
  const got = partitionsFromPayload([
    { id: "1", axis: "x", lengthFt: 40 },
    { id: "2", axis: "y", lengthFt: 40 },
    { id: "3", axis: "x", lengthFt: 11.5 },
    { id: "4", lengthFt: 40 },             // no axis: the longer run
  ], B, 8);
  assertEquals(got.map((p) => p.lengthFt), [12, 32, 11.5, 32]);
});

Deno.test("v1: a height is clamped to the wall the estimate prices; missing or silly is stud wall height", () => {
  const got = partitionsFromPayload([
    { id: "1", axis: "x", lengthFt: 10, heightIn: 90 },
    { id: "2", axis: "x", lengthFt: 10, heightIn: 200 },
    { id: "3", axis: "x", lengthFt: 10, heightIn: null },
    { id: "4", axis: "x", lengthFt: 10, heightIn: -5 },
    { id: "5", axis: "x", lengthFt: 10, heightIn: "abc" },
  ], B, 8.5);
  assertEquals(got.map((p) => [p.heightFt, p.heightMode]), [[7.5, "custom"], [8.5, "plate"], [8.5, "plate"], [8.5, "plate"], [8.5, "plate"]]);
});

// ── v2: the ends ────────────────────────────────────────────────────────────────────────────────
Deno.test("v2: the length is the distance between the ends, each clamped into the building, never past its diagonal", () => {
  const got = partitionsFromPayload([
    { id: "1", x1Ft: 0, y1Ft: 0, x2Ft: 6, y2Ft: 8, lengthFt: 10 },
    { id: "2", x1Ft: 0, y1Ft: 0, x2Ft: 6, y2Ft: 8, lengthFt: 400 },          // a claimed length that disagrees with the ends
    { id: "3", x1Ft: -50, y1Ft: -50, x2Ft: 500, y2Ft: 500 },                   // ends far outside: the building's corners
    { id: "4", x1Ft: 1, y1Ft: 10, x2Ft: 9.25, y2Ft: 10, lengthFt: 8.25 },
    { id: "5", x1Ft: 0, y1Ft: 0, x2Ft: 7.0711, y2Ft: 7.0711, lengthFt: 10 },   // the designer's own rounding is kept
    { id: "6", x1Ft: 3, y1Ft: 3, x2Ft: 3, y2Ft: 3 },                           // no length at all: dropped
    { id: "7", axis: "x", x1Ft: 0, y1Ft: 0, x2Ft: 6, y2Ft: 8, lengthFt: 12 },  // ends win over a v1 axis
  ], B, 8);
  assertEquals(got.map((p) => [p.id, p.lengthFt]), [["1", 10], ["2", 10], ["3", 34.18], ["4", 8.25], ["5", 10], ["7", 10]]);
});

Deno.test("v2: plate, custom and rafters; a wall to the rafters' face is held between the wall's and the roof's", () => {
  const got = partitionsFromPayload([
    { id: "1", x1Ft: 0, y1Ft: 10, x2Ft: 12, y2Ft: 10, heightMode: "plate", heightIn: 70 },
    { id: "2", x1Ft: 0, y1Ft: 10, x2Ft: 12, y2Ft: 10, heightMode: "custom", heightIn: 90 },
    { id: "3", x1Ft: 0, y1Ft: 10, x2Ft: 12, y2Ft: 10, heightMode: "custom", heightIn: 120 },
    { id: "4", x1Ft: 0, y1Ft: 10, x2Ft: 12, y2Ft: 10, heightMode: "rafters", faceAreaSqFt: 110.4 },
    { id: "5", x1Ft: 0, y1Ft: 10, x2Ft: 12, y2Ft: 10, heightMode: "rafters", faceAreaSqFt: 9999 },
    { id: "6", x1Ft: 0, y1Ft: 10, x2Ft: 12, y2Ft: 10, heightMode: "rafters", faceAreaSqFt: 3 },
    { id: "7", x1Ft: 0, y1Ft: 10, x2Ft: 12, y2Ft: 10, heightMode: "rafters" },
  ], B, 8, { maxRiseFt: 4 });
  assertEquals(got.map((p) => [p.heightMode, p.heightFt, p.faceAreaSqFt]), [
    ["plate", 8, 96], ["custom", 7.5, 90], ["plate", 8, 96],
    ["rafters", 8, 110.4], ["rafters", 8, 144], ["rafters", 8, 96], ["rafters", 8, 96],
  ]);
  // Not offered by the builder: a wall to the rafters is a stud wall height one.
  const off = partitionsFromPayload([{ id: "4", x1Ft: 0, y1Ft: 10, x2Ft: 12, y2Ft: 10, heightMode: "rafters", faceAreaSqFt: 110.4 }], B, 8, { allowRafters: false });
  assertEquals([off[0].heightMode, off[0].faceAreaSqFt], ["plate", 96]);
  // No rise given: RISE_CAP_FT.
  const cap = partitionsFromPayload([{ id: "5", x1Ft: 0, y1Ft: 10, x2Ft: 12, y2Ft: 10, heightMode: "rafters", faceAreaSqFt: 1e6 }], B, 8);
  assertEquals(cap[0].faceAreaSqFt, 12 * (8 + RISE_CAP_FT));
});

Deno.test("the roof's greatest rise: gable, gambrel and single slope from the style, the cap when unknown", () => {
  assertEquals(partitionMaxRiseFt({ roof: { type: "gable", pitch: 0.5 } }, 12, 20), 10 * 0.5 + 2.5);
  assertEquals(partitionMaxRiseFt({ roof: { type: "shed", pitch: 0.25 } }, 10, 12), 12 * 0.25 + 2.5);
  assertEquals(partitionMaxRiseFt({ roof: { type: "gambrel", kneeRise: 0.55, ridgeRise: 0.8 } }, 12, 16), 8 * 0.8 + 2.5);
  assertEquals(partitionMaxRiseFt({ roof: { type: "gable" } }, 12, 20), RISE_CAP_FT, "no pitch");
  assertEquals(partitionMaxRiseFt({ wallHeightFt: 8 }, 12, 20), RISE_CAP_FT, "no roof");
  assertEquals(partitionMaxRiseFt({ roof: { type: "gable", pitch: 0.5 } }, 0, 0), RISE_CAP_FT, "no size");
  assertEquals(partitionMaxRiseFt({ roof: { type: "gable", pitch: 0.5, wingWidthFt: 6 } }, 12, 20), RISE_CAP_FT, "wings");
  assertEquals(partitionMaxRiseFt(null, 12, 20), RISE_CAP_FT);
});

// ── Rates by stud size ──────────────────────────────────────────────────────────────────────────
Deno.test("rates: the Interior walls tab's row; no row = not set up; the layout row only when the table is missing", () => {
  const tab = interiorWallRates({ standard_stud: "2x6", pricing_method: "lineal_ft", rate_2x4: 30, rate_2x6: "38.5", allow_rafters: false, taxable: false }, { method: "lineal_ft", rate: 99 });
  assertEquals(tab, { offered: true, standardStud: "2x6", method: "lineal_ft", rates: { "2x4": 30, "2x6": 38.5 }, allowRafters: false, taxable: false, source: "interior_wall_settings" });
  const sq = interiorWallRates({ standard_stud: "2x4", pricing_method: "sqft_option", rate_2x4: 4.25, rate_2x6: null }, null);
  assertEquals([sq.offered, sq.method, sq.rates], [true, "sqft_option", { "2x4": 4.25, "2x6": null }]);
  // UNCONFIGURED (no row, the table there): nothing offered, nothing charged, even with a 278 row priced.
  const unset = interiorWallRates(null, { method: "lineal_ft", rate: 35 });
  assertEquals(unset, { offered: false, standardStud: "2x4", method: "lineal_ft", rates: { "2x4": null, "2x6": null }, allowRafters: true, taxable: null, source: "none" });
  assertEquals(interiorWallRates(undefined, undefined).source, "none");
  // The table missing (a database before 313): the 278 row is the standard 2x4 rate, as before 313.
  const legacy = interiorWallRates(null, { method: "lineal_ft", rate: 35 }, { tableMissing: true });
  assertEquals(legacy, { offered: true, standardStud: "2x4", method: "lineal_ft", rates: { "2x4": 35, "2x6": null }, allowRafters: true, taxable: null, source: "layout_item_pricing" });
  assertEquals(interiorWallRates(null, null, { tableMissing: true }).offered, false, "no 278 row either: nothing");
  assertEquals(interiorWallRates(null, { method: "each", rate: 400 }, { tableMissing: true }).offered, false, "a 278 'each' row is not a wall method");
  // 'each' is not a wall method, even in a row the CHECK would have refused.
  const each = interiorWallRates({ standard_stud: "2x4", pricing_method: "each", rate_2x4: 400 }, null);
  assertEquals([each.offered, each.rates], [false, { "2x4": null, "2x6": null }]);
  // A standard stud with no rate: not offered.
  assertEquals(interiorWallRates({ standard_stud: "2x6", pricing_method: "lineal_ft", rate_2x4: 30, rate_2x6: null }, null).offered, false);
  // A size the builder does not offer (no rate) prices at the standard.
  const only4 = interiorWallRates({ standard_stud: "2x4", pricing_method: "lineal_ft", rate_2x4: 400, rate_2x6: null }, null);
  assertEquals([partitionStud({ stud: "2x6" }, only4), partitionStud({ stud: null }, only4), partitionStud({ stud: "2x6" }, tab), partitionStud({ stud: "2x4" }, tab)], ["2x4", "2x4", "2x6", "2x4"]);
});

Deno.test("nonsense is dropped, never refused, and the list is capped", () => {
  assertEquals(partitionsFromPayload("nope", B, 8), []);
  assertEquals(partitionsFromPayload([null, 7, { lengthFt: 0 }, { lengthFt: "x" }, { lengthFt: -3 }], B, 8), []);
  const many = Array.from({ length: PARTITION_MAX + 5 }, (_, k) => ({ id: String(k), axis: "x", lengthFt: 4 }));
  assertEquals(partitionsFromPayload(many, B, 8).length, PARTITION_MAX);
  const ops = Array.from({ length: PARTITION_OPENINGS_MAX + 3 }, (_, k) => ({ id: String(k), kind: "door", fixtureItemId: "fx" }));
  assertEquals(partitionsFromPayload([{ id: "1", axis: "x", lengthFt: 12, openings: ops }], B, 8)[0].openings.length, PARTITION_OPENINGS_MAX);
  assertEquals(partitionsFromPayload([{ id: "1", x1Ft: 0, y1Ft: 1, x2Ft: 4, y2Ft: 1, stud: "2x8" }], B, 8)[0].stud, null, "a size that is not one");
});

Deno.test("an id that could not be a row key gets none; an opening keeps only what it may say", () => {
  const [p] = partitionsFromPayload([{
    id: "7:open:9", axis: "x", lengthFt: 10,
    openings: [
      { id: 1, kind: "door", fixtureItemId: "fx-1", name: "  Barn   Door ", swing: "in", operation: "right", widthIn: 36, heightIn: 80, price: 1 },
      { id: "2", kind: "skylight", fixtureItemId: "fx-2" },
      { id: "x y", kind: "window", fixtureItemId: null },
    ],
  }], B, 8);
  assertEquals(p.id, null, "a colon would let one key spell another");
  assertEquals(p.openings, [
    { id: "1", kind: "door", fixtureItemId: "fx-1", name: "Barn Door", widthIn: 36, heightIn: 80, swing: "in", operation: "right" },
    { id: null, kind: "window", fixtureItemId: null, name: "Window", widthIn: null, heightIn: null, swing: null, operation: null },
  ]);
  assertEquals("price" in p.openings[0], false, "a body price is never read");
});

Deno.test("which failed reads mean the table is missing (the only case the 278 row prices)", () => {
  assertEquals(interiorWallTableMissing({ code: "PGRST205", message: "Could not find the table 'public.interior_wall_settings' in the schema cache" }), true);
  assertEquals(interiorWallTableMissing({ code: "42P01", message: "relation \"public.interior_wall_settings\" does not exist" }), true);
  assertEquals(interiorWallTableMissing({ code: "", message: "relation \"public.interior_wall_settings\" does not exist" }), true);
  assertEquals(interiorWallTableMissing({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assertEquals(interiorWallTableMissing({ message: "fetch failed" }), false);
  assertEquals(interiorWallTableMissing(null), false);
});

Deno.test("the charge: per lineal foot or per square foot of its face; there is no each", () => {
  const p = { lengthFt: 11.5, heightFt: 7.5 };
  assertEquals(partitionCharge(p, "lineal_ft"), { qty: 11.5, method: "lineal_ft" });
  assertEquals(partitionCharge(p, "sqft_option"), { qty: 86.25, method: "sqft_option" });
  assertEquals(partitionCharge(p, "each"), { qty: 11.5, method: "lineal_ft" }, "never one wall at the rate");
  assertEquals(partitionCharge(p, "pct_building_price"), { qty: 11.5, method: "lineal_ft" });
  assertEquals(partitionCharge(p, undefined), { qty: 11.5, method: "lineal_ft" });
  const r = { lengthFt: 12, heightFt: 8, heightMode: "rafters" as const, faceAreaSqFt: 110.39999 };
  assertEquals(partitionCharge(r, "sqft_option"), { qty: 110.4, method: "sqft_option" });
  assertEquals(partitionCharge({ ...r, faceAreaSqFt: 50 }, "sqft_option").qty, 96, "never less than the wall's own face");
  assertEquals(partitionCharge(r, "lineal_ft").qty, 12);
});

Deno.test("descriptions say the size, the framing and what is in the wall", () => {
  const [plate, low, raft] = partitionsFromPayload([
    { id: "1", axis: "x", lengthFt: 12, openings: [{ kind: "door" }, { kind: "window" }, { kind: "window" }] },
    { id: "2", axis: "x", lengthFt: 9.5, heightIn: 90 },
    { id: "3", x1Ft: 0, y1Ft: 0, x2Ft: 6, y2Ft: 8, heightMode: "rafters", faceAreaSqFt: 100 },
  ], B, 8);
  assertEquals(partitionDescription(plate), "12' long, stud wall height (8') · with a door and 2 windows");
  assertEquals(partitionDescription(low, "2x4"), "9'6\" long, 7'6\" tall · 2x4 framing");
  assertEquals(partitionDescription(raft, "2x6"), "10' long, to the rafters · 2x6 framing");
  assertEquals(partitionOpeningDescription({ ...plate.openings[0], operation: "double" }, 60, 80), "5'×6'8\" · double · in interior wall");
  assertEquals(partitionOpeningDescription(plate.openings[1], 24, 36), "2'×3' · in interior wall");
  assertEquals(ftIn(0), "0\"");
});
