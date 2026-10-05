// Partition walls (migration 278): the designer's pure rules, LIFTED from both shipped twins and run.
//
// Every rule here fails silently when it is wrong. A partition placed along the long span, an end that
// does not land on the wall it was dragged to, a door slid through the end of its wall, a wall-to-wall
// partition left short after the building grew, a charge worked out on a different length than the
// server's — none of them throws; each draws a plan the shop builds from or prices a quote the customer
// signs. So the block is sliced out of structure-studio.component.js AND StructureStudio.jsx (which
// must agree byte for byte, the mirror rule) and exercised as it ships — wallSlab_test's technique —
// never a copy that keeps passing while the twins drift.
//
// The block has no JSX and no outside names (its header says so); if either marker moves, re-point it
// here rather than deleting the test.

import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const CMP = await read("../../../../structure-studio.component.js");
const JSX = await read("../../../../StructureStudio.jsx");
const START = "// ── PARTITION WALLS ──\n", END = "// ── END PARTITION WALLS ──\n";
const lift = (src: string, file: string) => {
  const i = src.indexOf(START), j = i < 0 ? -1 : src.indexOf(END, i);
  if (i < 0 || j < 0) throw new Error(`partition_test: the PARTITION WALLS block moved in ${file} (${i}, ${j}). Re-point the markers.`);
  return src.slice(i, j + END.length);
};
const BLOCK = lift(CMP, "structure-studio.component.js");

Deno.test("the PARTITION WALLS block is byte-identical in both designer twins", () => {
  assertStrictEquals(lift(JSX, "StructureStudio.jsx"), BLOCK);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const NAMES = [
  "ssPartitionAt", "ssPartitionMoveAcross", "ssPartitionClash", "ssPartitionMoveEnd", "ssPartitionCenterRange",
  "ssPartitionOpeningOk", "ssPartitionSeatOpening", "ssPartitionReflow", "ssPartitionHit", "ssPartitionOpeningAt",
  "ssPartitionPieces", "ssPartitionFtIn", "ssPartitionSize", "ssPartitionCharge", "ssPartitionSummary",
  "ssPartitionHeightFt", "ssPartitionMinHeightIn", "ssPartitionLenFt", "ssIsPartition",
];
const P: Record<string, Any> = new Function(`${BLOCK}; return { ${NAMES.join(", ")} };`)();

// A 12 x 32 building: the short span is the 12 ft width, so a partition runs west to east (axis x).
const W = 12, H = 32;
const wall = (o: Record<string, unknown> = {}) => ({ id: 1, type: "partitionWall", wall: null, axis: "x", atFt: 10, fromFt: 0, toFt: 12, heightIn: null, openings: [], ...o });
const door = (o: Record<string, unknown> = {}) => ({ id: 1, kind: "door", widthIn: 36, heightIn: 80, centerFt: 6, ...o });

Deno.test("a click places a wall ACROSS the short span, wall to wall, at the click to the inch", () => {
  assertEquals(P.ssPartitionAt(5, 10.04, W, H), { axis: "x", atFt: 10, fromFt: 0, toFt: 12 });
  assertEquals(P.ssPartitionAt(5, 10.5, W, H).atFt, 10.5);
  // The same building turned round (32 wide, 12 deep): now it runs north to south, at the click's x.
  assertEquals(P.ssPartitionAt(20.25, 3, 32, 12), { axis: "y", atFt: 20.25, fromFt: 0, toFt: 12 });
  // A square building takes the x run.
  assertEquals(P.ssPartitionAt(3, 4, 10, 10).axis, "x");
});

Deno.test("never closer than a foot to an outside wall, and no wall at all where there is no room", () => {
  assertEquals(P.ssPartitionAt(5, 0.2, W, H).atFt, 1);
  assertEquals(P.ssPartitionAt(5, 31.9, W, H).atFt, 31);
  assertEquals(P.ssPartitionMoveAcross(wall(), -4, W, H), 1);
  assertEquals(P.ssPartitionMoveAcross(wall(), 40, W, H), 31);
  assertEquals(P.ssPartitionMoveAcross(wall(), 14.49, W, H), 14.5);
  assertEquals(P.ssPartitionAt(1, 0.5, 1.5, 1), null);
});

Deno.test("two parallel walls closer than 6 in clash; apart, crossing or end to end they do not", () => {
  const a = wall({ id: 1, atFt: 10 });
  assert(P.ssPartitionClash(wall({ id: 2, atFt: 10.25 }), [a]));
  assert(!P.ssPartitionClash(wall({ id: 2, atFt: 10.5 }), [a]));
  assert(!P.ssPartitionClash(wall({ id: 2, atFt: 10.25, fromFt: 12, toFt: 12 }), [a]), "no shared run");
  assert(!P.ssPartitionClash(wall({ id: 2, axis: "y", atFt: 10, fromFt: 0, toFt: 32 }), [a]), "crossing");
  assert(!P.ssPartitionClash(a, [a]), "not with itself");
  assert(!P.ssPartitionClash(wall({ id: 2, atFt: 10 }), [{ id: 9, type: "loft", axis: "x", atFt: 10, fromFt: 0, toFt: 12 }]), "only partitions count");
});

Deno.test("an end lands on the wall or a crossing partition, and never cuts into a door's framing", () => {
  const p = wall({ fromFt: 0, toFt: 12 });
  assertEquals(P.ssPartitionMoveEnd(p, "to", 8.04, W, H, []), { toFt: 8 });
  assertEquals(P.ssPartitionMoveEnd(p, "to", 11.6, W, H, []), { toFt: 12 }, "within 6 in of the wall: on it");
  assertEquals(P.ssPartitionMoveEnd(p, "to", 1, W, H, []), { toFt: 2 }, "never shorter than 2 ft");
  assertEquals(P.ssPartitionMoveEnd(p, "from", -3, W, H, []), { fromFt: 0 });
  // A partition crossing this one at x = 7 (it spans y 0..20, and this wall is at y 10): a magnet.
  const cross = wall({ id: 2, axis: "y", atFt: 7, fromFt: 0, toFt: 20 });
  assertEquals(P.ssPartitionMoveEnd(p, "to", 7.3, W, H, [cross]), { toFt: 7 });
  assertEquals(P.ssPartitionMoveEnd(p, "to", 7.3, W, H, [{ ...cross, toFt: 9 }]), { toFt: 88 / 12 }, "one that does not reach this wall is no magnet: 7'4\" to the inch");
  // A 3 ft door centred at 6 ft keeps 3 in of wall on each side of it.
  const d = wall({ openings: [door({ centerFt: 6 })] });
  assertEquals(P.ssPartitionMoveEnd(d, "to", 4, W, H, []), { toFt: 7.75 });
  assertEquals(P.ssPartitionMoveEnd(d, "from", 9, W, H, []), { fromFt: 4.25 });
});

Deno.test("an end stops at a partition in line with it: they can meet, never overlap and be charged twice", () => {
  // The split-round-a-door layout on a 10 x 12: C runs 0..4 and D 6..10, both 6 ft from the north wall.
  const c = wall({ id: 1, atFt: 6, fromFt: 0, toFt: 4 });
  const d = wall({ id: 2, atFt: 6, fromFt: 6, toFt: 10 });
  assertEquals(P.ssPartitionMoveEnd(d, "from", 2, 10, 12, [c]), { fromFt: 4 }, "D's west end stops at C's east end");
  assertEquals(P.ssPartitionMoveEnd(c, "to", 8, 10, 12, [d]), { toFt: 6 }, "C's east end stops at D's west end");
  assertEquals(P.ssPartitionMoveEnd(d, "from", 5, 10, 12, [c]), { fromFt: 5 }, "short of it, the end goes where it is put");
  assert(!P.ssPartitionClash({ ...d, fromFt: 4 }, [c]), "ends that only touch do not clash");
  // Close enough to clash (3 in off the line) is a stop too; a wall 6 in or more away is not.
  assertEquals(P.ssPartitionMoveEnd(d, "from", 2, 10, 12, [{ ...c, atFt: 6.25 }]), { fromFt: 4 });
  assertEquals(P.ssPartitionMoveEnd(d, "from", 2, 10, 12, [{ ...c, atFt: 6.5 }]), { fromFt: 2 });
  // The one behind the moving end is the stop, not one beyond the other end.
  assertEquals(P.ssPartitionMoveEnd(c, "from", 0, 10, 12, [d]), { fromFt: 0 });
});

Deno.test("doors and windows: inside the wall with 3 in of framing, never over each other", () => {
  const p = wall({ openings: [door({ id: 1, centerFt: 3 })] });
  assert(P.ssPartitionOpeningOk(p, door({ id: 1, centerFt: 3 })), "where it is");
  assert(!P.ssPartitionOpeningOk(p, door({ id: 1, centerFt: 1.7 })), "through the end");
  assert(P.ssPartitionOpeningOk(p, door({ id: 1, centerFt: 1.75 })), "flush to the framing");
  assert(!P.ssPartitionOpeningOk(p, door({ id: 2, centerFt: 6 })), "a second 3 ft door 3 ft along overlaps it");
  assert(!P.ssPartitionOpeningOk(p, door({ id: 2, centerFt: 6.25 })), "...and 3 in clear is still too close for two casings");
  assert(P.ssPartitionOpeningOk(p, door({ id: 2, centerFt: 6.375 })), "...4.5 in clear of it is fine");
  assert(P.ssPartitionOpeningOk(p, { id: 2, kind: "window", widthIn: 24, centerFt: 9 }));
  assertEquals(P.ssPartitionCenterRange(wall({ toFt: 3 }), 3), null, "a 3 ft door does not fit a 3 ft wall");
});

Deno.test("a new door seats at the free spot nearest the middle, or nowhere", () => {
  const empty = wall();
  assertEquals(P.ssPartitionSeatOpening(empty, door({ id: 1 }), 6), 6);
  const one = wall({ openings: [door({ id: 1, centerFt: 6 })] });
  // The middle is taken: a legal centre is 3'4½" away (half of each door plus 4½ in), so the nearest
  // one on the inch is 3'5" away, at 2'7".
  assertEquals(P.ssPartitionSeatOpening(one, door({ id: 2 }), 6), 6 - 41 / 12);
  const full = wall({ toFt: 4, openings: [door({ id: 1, centerFt: 2 })] });
  assertEquals(P.ssPartitionSeatOpening(full, door({ id: 2 }), 2), null);
});

Deno.test("a new building size: wall to wall stays wall to wall, the rest is clamped or refused", () => {
  const p = wall({ atFt: 20, openings: [door({ centerFt: 6 })] });
  const grow = P.ssPartitionReflow(p, { w: 12, h: 32 }, { w: 14, h: 32 });
  assertEquals([grow.item.fromFt, grow.item.toFt, grow.item.atFt, grow.kind], [0, 14, 20, null]);
  assertEquals(grow.item.openings[0].centerFt, 6, "the door keeps its place");
  const shrink = P.ssPartitionReflow(p, { w: 12, h: 32 }, { w: 10, h: 16 });
  assertEquals([shrink.item.fromFt, shrink.item.toFt, shrink.item.atFt, shrink.kind], [0, 10, 15, null], "it keeps its distance, clamped a foot inside");
  // A partial wall from 2 to 11 ft on a building going down to 8 wide: clamped, and the customer told.
  const part = P.ssPartitionReflow(wall({ fromFt: 2, toFt: 11 }), { w: 12, h: 32 }, { w: 8, h: 32 });
  assertEquals([part.item.fromFt, part.item.toFt, part.kind], [2, 8, "resized"]);
  // A door that no longer fits refuses the size change rather than vanishing.
  const tight = P.ssPartitionReflow(wall({ fromFt: 6, toFt: 12, openings: [door({ centerFt: 9 })] }), { w: 12, h: 32 }, { w: 9, h: 32 });
  assertEquals(tight.kind, "blocked");
  assertEquals(P.ssPartitionReflow(wall({ fromFt: 6, toFt: 12 }), { w: 12, h: 32 }, { w: 7, h: 32 }).kind, "blocked", "under 2 ft");
});

// reflowItems itself, lifted from each twin with what a plan of partitions alone reaches (pageGeom and
// SS_PAGE), so the rule BETWEEN walls is tested where it lives: each wall is clamped on its own by
// ssPartitionReflow, and only reflowItems sees two of them land on one line.
const liftBetween = (src: string, file: string, a: string, b: string) => {
  const i = src.indexOf(a), j = i < 0 ? -1 : src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error(`partition_test: anchors moved for ${a} in ${file} (${i}, ${j}). Re-point them.`);
  return src.slice(i, j);
};
const reflowOf = (src: string, file: string) => {
  const page = /const SS_PAGE = \{[^\n]*\n/.exec(src);
  if (!page) throw new Error(`partition_test: SS_PAGE moved in ${file}`);
  const body = [page[0], liftBetween(src, file, "function pageGeom(", "// Where a ramp sits"), lift(src, file),
    liftBetween(src, file, "function reflowItems(", "// Point on a note box's border")].join("\n");
  return new Function(`${body}; return reflowItems;`)() as (items: Any[], prev: Any, next: Any, ITEMS: Any) => { items: Any[]; events: Any[] };
};
const ITEMS_CFG = { partitionWall: { label: "Partition Wall", width: 4, height: 0.375 } };

for (const [file, src] of [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]] as const) {
  const reflow = reflowOf(src, file);
  Deno.test(`${file}: a size change that would stack two partitions on one line is blocked`, () => {
    // 10 x 12, walls 11 ft and 9 ft from the north wall: both legal. At 10 x 10 the first is clamped
    // to 9 ft, onto the second.
    const a = wall({ id: 1, atFt: 11, fromFt: 0, toFt: 10 }), b = wall({ id: 2, atFt: 9, fromFt: 0, toFt: 10 });
    const r = reflow([a, b], { w: 10, h: 12 }, { w: 10, h: 10 }, ITEMS_CFG);
    assertEquals(r.events.map((e: Any) => [e.id, e.kind]), [[2, "blocked"]]);
    // 11 and 10.5 on a 10 x 12 going to 10 x 11: both clamp to 10 ft.
    const c = wall({ id: 3, atFt: 11, fromFt: 0, toFt: 10 }), d = wall({ id: 4, atFt: 10.5, fromFt: 0, toFt: 10 });
    assertEquals(reflow([c, d], { w: 10, h: 12 }, { w: 10, h: 11 }, ITEMS_CFG).events.map((e: Any) => e.kind), ["blocked"]);
  });
  Deno.test(`${file}: two walls that stay apart reflow with no event`, () => {
    const a = wall({ id: 1, atFt: 11, fromFt: 0, toFt: 10 }), b = wall({ id: 2, atFt: 6, fromFt: 0, toFt: 10 });
    const grow = reflow([a, b], { w: 10, h: 12 }, { w: 12, h: 14 }, ITEMS_CFG);
    assertEquals(grow.events, []);
    assertEquals(grow.items.map((i: Any) => [i.atFt, i.toFt]), [[11, 12], [6, 12]]);
    // Unchanged dimensions (repairLoaded) hand every wall back as it was.
    const same = reflow([a, b], { w: 10, h: 12 }, { w: 10, h: 12 }, ITEMS_CFG);
    assertStrictEquals(same.items[0], a);
    assertEquals(same.events, []);
  });
}

Deno.test("an unchanged building hands back the SAME object (repairLoaded runs this on every load)", () => {
  const p = wall({ openings: [door()] });
  const r = P.ssPartitionReflow(p, { w: 12, h: 32 }, { w: 12, h: 32 });
  assertStrictEquals(r.item, p);
  assertEquals(r.kind, null);
});

Deno.test("height: full is the wall; a stated height never goes above it; a cut-down wall clears its doors", () => {
  assertEquals(P.ssPartitionHeightFt(wall(), 8), 8);
  assertEquals(P.ssPartitionHeightFt(wall({ heightIn: 90 }), 8), 7.5);
  assertEquals(P.ssPartitionHeightFt(wall({ heightIn: 120 }), 8), 8);
  assertEquals(P.ssPartitionHeightFt(wall({ heightIn: 0 }), 8), 8, "a nonsense height is full height");
  assertEquals(P.ssPartitionMinHeightIn(wall()), 24);
  assertEquals(P.ssPartitionMinHeightIn(wall({ openings: [door({ heightIn: 80 })] })), 83);
  assertEquals(P.ssPartitionMinHeightIn(wall({ openings: [{ id: 2, kind: "window", heightIn: 36, sillIn: 42 }] })), 81);
});

Deno.test("how a wall is charged: per foot, per square foot of wall, each — anything else is each", () => {
  const p = wall({ fromFt: 0, toFt: 11.5, heightIn: 90 });
  assertEquals(P.ssPartitionCharge(p, "lineal_ft", 8), { qty: 11.5, per: "per ft", method: "lineal_ft" });
  assertEquals(P.ssPartitionCharge(p, "sqft_option", 8), { qty: 86.25, per: "per sq ft", method: "sqft_option" });
  assertEquals(P.ssPartitionCharge(wall(), "sqft_option", 8.5), { qty: 102, per: "per sq ft", method: "sqft_option" }, "full height is the priced wall");
  assertEquals(P.ssPartitionCharge(p, "each", 8), { qty: 1, per: "each", method: "each" });
  assertEquals(P.ssPartitionCharge(p, "pct_estimate_total", 8), { qty: 1, per: "each", method: "each" });
  assertEquals(P.ssPartitionCharge(p, undefined, 8).qty, 1);
});

Deno.test("the estimate's summary: sizes and catalog ids, every partition and nothing else", () => {
  const items = [
    { id: 5, type: "loft", x: 1, y: 1 },
    wall({ id: 7, fromFt: 1, toFt: 9.25, heightIn: 90, openings: [door({ id: 1, fixtureItemId: "fx-1", name: "Barn Door", price: 450, swing: "in", operation: "right" })] }),
  ];
  assertEquals(P.ssPartitionSummary(items, 8), [{
    id: "7", axis: "x", lengthFt: 8.25, heightIn: 90, heightFt: 7.5,
    openings: [{ id: "1", kind: "door", fixtureItemId: "fx-1", name: "Barn Door", widthIn: 36, heightIn: 80, swing: "in", operation: "right", price: 450 }],
  }]);
  assertEquals(P.ssPartitionSummary([{ id: 1, type: "shelf" }], 8), []);
  // A plain rectangle of this type (no run) is not a partition: the generic paths keep drawing it.
  assert(!P.ssIsPartition({ id: 3, type: "partitionWall", x: 400, y: 260, widthFt: 4, heightFt: 0.375 }));
  assertEquals(P.ssPartitionSummary([{ id: 3, type: "partitionWall", x: 400, y: 260 }], 8), []);
});

Deno.test("the plan's pieces and hit test: solid stretches round the openings, along the run", () => {
  const p = wall({ openings: [door({ id: 2, centerFt: 9 }), door({ id: 1, centerFt: 3 })] });
  const pc = P.ssPartitionPieces(p);
  assertEquals(pc.solid, [[0, 1.5], [4.5, 7.5], [10.5, 12]]);
  assertEquals(pc.holes.map((h: Any) => h.o.id), [1, 2]);
  // Page geometry: 20 px a foot, the plan's corner at (100, 50). The wall is the line y = 50 + 10 x 20.
  assertEquals(P.ssPartitionHit(p, 100 + 3 * 20, 250 + 4, 100, 50, 20, 6), 3);
  assertEquals(P.ssPartitionHit(p, 100 + 3 * 20, 250 + 9, 100, 50, 20, 6), null);
  assertEquals(P.ssPartitionOpeningAt(p, 3.4).id, 1);
  assertEquals(P.ssPartitionOpeningAt(p, 6), null);
});

Deno.test("sizes read the way a builder writes them", () => {
  assertEquals(P.ssPartitionFtIn(12), "12'");
  assertEquals(P.ssPartitionFtIn(7.5), "7'6\"");
  assertEquals(P.ssPartitionFtIn(0.25), "3\"");
  assertEquals(P.ssPartitionSize(wall(), 8), "12' long, full height (8')");
  assertEquals(P.ssPartitionSize(wall({ heightIn: 90 }), 8), "12' long, 7'6\" tall");
});
