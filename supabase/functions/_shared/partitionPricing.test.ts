// Partition walls on the estimate (migration 278): the server's reading of itemSummary.partitions and
// its charge rule. Dependency-free, so this file belongs to the `_shared/*.test.ts` group and runs
// without an import map. The same rule, end to end through submit-estimate and against the designer's
// own Details rows, is submitEstimatePartitionWiring_test.ts.

import { assertEquals } from "jsr:@std/assert@1";
import {
  ftIn, PARTITION_MAX, PARTITION_OPENINGS_MAX, partitionCharge, partitionDescription, partitionOpeningDescription,
  partitionsFromPayload,
} from "./partitionPricing.ts";

// A 12 x 32 building with 8 ft walls: an axis-x wall can be at most 12 ft long, an axis-y one 32.
const B = { widthFt: 12, lengthFt: 32 };

Deno.test("a length is clamped to the building's inside run, by axis", () => {
  const got = partitionsFromPayload([
    { id: "1", axis: "x", lengthFt: 40 },
    { id: "2", axis: "y", lengthFt: 40 },
    { id: "3", axis: "x", lengthFt: 11.5 },
    { id: "4", lengthFt: 40 },             // no axis: the longer run
  ], B, 8);
  assertEquals(got.map((p) => p.lengthFt), [12, 32, 11.5, 32]);
});

Deno.test("a height is clamped to the wall the estimate prices; missing or silly is full height", () => {
  const got = partitionsFromPayload([
    { id: "1", axis: "x", lengthFt: 10, heightIn: 90 },
    { id: "2", axis: "x", lengthFt: 10, heightIn: 200 },
    { id: "3", axis: "x", lengthFt: 10, heightIn: null },
    { id: "4", axis: "x", lengthFt: 10, heightIn: -5 },
    { id: "5", axis: "x", lengthFt: 10, heightIn: "abc" },
  ], B, 8.5);
  assertEquals(got.map((p) => [p.heightFt, p.fullHeight]), [[7.5, false], [8.5, true], [8.5, true], [8.5, true], [8.5, true]]);
});

Deno.test("nonsense is dropped, never refused, and the list is capped", () => {
  assertEquals(partitionsFromPayload("nope", B, 8), []);
  assertEquals(partitionsFromPayload([null, 7, { lengthFt: 0 }, { lengthFt: "x" }, { lengthFt: -3 }], B, 8), []);
  const many = Array.from({ length: PARTITION_MAX + 5 }, (_, k) => ({ id: String(k), axis: "x", lengthFt: 4 }));
  assertEquals(partitionsFromPayload(many, B, 8).length, PARTITION_MAX);
  const ops = Array.from({ length: PARTITION_OPENINGS_MAX + 3 }, (_, k) => ({ id: String(k), kind: "door", fixtureItemId: "fx" }));
  assertEquals(partitionsFromPayload([{ id: "1", axis: "x", lengthFt: 12, openings: ops }], B, 8)[0].openings.length, PARTITION_OPENINGS_MAX);
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

Deno.test("the charge: per foot, per square foot of wall, each; anything else is each", () => {
  const p = { lengthFt: 11.5, heightFt: 7.5 };
  assertEquals(partitionCharge(p, "lineal_ft"), { qty: 11.5, method: "lineal_ft" });
  assertEquals(partitionCharge(p, "sqft_option"), { qty: 86.25, method: "sqft_option" });
  assertEquals(partitionCharge(p, "each"), { qty: 1, method: "each" });
  assertEquals(partitionCharge(p, "pct_building_price"), { qty: 1, method: "each" });
  assertEquals(partitionCharge(p, undefined), { qty: 1, method: "each" });
});

Deno.test("descriptions say the size and what is in the wall", () => {
  const [full, low] = partitionsFromPayload([
    { id: "1", axis: "x", lengthFt: 12, openings: [{ kind: "door" }, { kind: "window" }, { kind: "window" }] },
    { id: "2", axis: "x", lengthFt: 9.5, heightIn: 90 },
  ], B, 8);
  assertEquals(partitionDescription(full), "12' long, full height (8') · with a door and 2 windows");
  assertEquals(partitionDescription(low), "9'6\" long, 7'6\" tall");
  assertEquals(partitionOpeningDescription({ ...full.openings[0], operation: "double" }, 60, 80), "5'×6'8\" · double · in partition wall");
  assertEquals(partitionOpeningDescription(full.openings[1], 24, 36), "2'×3' · in partition wall");
  assertEquals(ftIn(0), "0\"");
});
