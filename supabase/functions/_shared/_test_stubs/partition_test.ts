// Partition walls (migration 278; v2 geometry and wall height, 2026-10-17): the designer's pure rules,
// LIFTED from both shipped twins and run.
//
// Every rule here fails silently when it is wrong. A wall placed along the long span, an end that does
// not land on the wall it was dragged to, a 44 degree wall that should have snapped to 45, a door slid
// through the end of its wall, a wall-to-wall partition left short after the building grew, two walls
// stacked on one line and charged twice, a charge worked out on a different length or face than the
// server's — none of them throws; each draws a plan the shop builds from or prices an estimate the
// customer signs. So the block is sliced out of structure-studio.component.js AND StructureStudio.jsx
// (which must agree byte for byte, the mirror rule) and exercised as it ships — wallSlab_test's
// technique — never a copy that keeps passing while the twins drift.
//
// The block has no JSX and no outside names (its header says so); if either marker moves, re-point it
// here rather than deleting the test.

import { assert, assertAlmostEquals, assertEquals, assertStrictEquals } from "jsr:@std/assert";

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
  "ssPartitionAt", "ssPartitionTranslate", "ssPartitionClash", "ssPartitionMoveEnd", "ssPartitionCenterRange",
  "ssPartitionOpeningOk", "ssPartitionSeatOpening", "ssPartitionReflow", "ssPartitionHit", "ssPartitionOpeningAt",
  "ssPartitionPieces", "ssPartitionFtIn", "ssPartitionSize", "ssPartitionPlanLabel", "ssPartitionCharge", "ssPartitionSummary",
  "ssPartitionHeightFt", "ssPartitionMinHeightIn", "ssPartitionLenFt", "ssIsPartition", "ssPartitionNormalize",
  "ssPartitionThicknessFt", "ssPartitionStud", "ssPartitionTopFt", "ssPartitionFaceAreaSqFt", "ssPartitionValid",
  "ssPartitionAngleDeg", "ssPartitionAlongFt", "ssPartitionSnapDir",
];
const P: Record<string, Any> = new Function(`${BLOCK}; return { ${NAMES.join(", ")} };`)();

// A 12 x 32 building: the short span is the 12 ft width, so a clicked wall runs west to east.
const W = 12, H = 32;
const wall = (o: Record<string, unknown> = {}) => ({
  id: 1, type: "partitionWall", wall: null, x1Ft: 0, y1Ft: 10, x2Ft: 12, y2Ft: 10,
  heightMode: "plate", heightIn: null, stud: null, covers: { a: null, b: null }, openings: [], ...o,
});
const at = (y: number, o: Record<string, unknown> = {}) => wall({ y1Ft: y, y2Ft: y, ...o });
const door = (o: Record<string, unknown> = {}) => ({ id: 1, kind: "door", widthIn: 36, heightIn: 80, centerFt: 6, ...o });
const ends = (p: Any) => [p.x1Ft, p.y1Ft, p.x2Ft, p.y2Ft];

// ── The stored shape ────────────────────────────────────────────────────────────────────────────
Deno.test("a v1 wall opens as the same wall in v2: endpoints, openings from end 1, plate or custom", () => {
  const x = P.ssPartitionNormalize({ id: 3, type: "partitionWall", wall: null, axis: "x", atFt: 10, fromFt: 2, toFt: 11, heightIn: null,
    openings: [{ id: 1, kind: "door", centerFt: 6, swing: "out" }] });
  assertEquals(x, { id: 3, type: "partitionWall", wall: null, x1Ft: 2, y1Ft: 10, x2Ft: 11, y2Ft: 10, heightMode: "plate", heightIn: null,
    stud: null, covers: { a: null, b: null }, openings: [{ id: 1, kind: "door", centerFt: 4, swing: "out" }] });
  const y = P.ssPartitionNormalize({ id: 4, type: "partitionWall", wall: null, axis: "y", atFt: 4, fromFt: 0, toFt: 6.5, heightIn: 90, openings: [] });
  assertEquals([ends(y), y.heightMode, y.heightIn, "axis" in y, "atFt" in y], [[4, 0, 4, 6.5], "custom", 90, false, false]);
  // A v1 axis-y wall ran north to south and its door's "out" swung east; v2's side a (left of the
  // line from end 1 to end 2) of a wall running south is east, so the swing is unchanged.
  assertEquals(P.ssPartitionAngleDeg(y), 90);
  const v2 = wall();
  assertStrictEquals(P.ssPartitionNormalize(v2), v2, "a v2 wall is handed back as it is");
  assert(P.ssIsPartition(v2) && P.ssIsPartition({ type: "partitionWall", axis: "x" }));
  // A plain rectangle of this type (no run) is not a partition: the generic paths keep drawing it.
  assert(!P.ssIsPartition({ id: 3, type: "partitionWall", x: 400, y: 260, widthFt: 4, heightFt: 0.375 }));
});

Deno.test("thickness: the stud's depth plus half an inch a covered face; null is the builder's standard", () => {
  assertAlmostEquals(P.ssPartitionThicknessFt(wall(), "2x4"), 3.5 / 12);
  assertAlmostEquals(P.ssPartitionThicknessFt(wall(), "2x6"), 5.5 / 12);
  assertAlmostEquals(P.ssPartitionThicknessFt(wall({ stud: "2x6" }), "2x4"), 5.5 / 12, 1e-9, "a rep's override wins");
  assertAlmostEquals(P.ssPartitionThicknessFt(wall({ covers: { a: "c1", b: "c2" } }), "2x4"), 4.5 / 12);
  assertAlmostEquals(P.ssPartitionThicknessFt(wall({ covers: { a: "c1", b: null } }), undefined), 4 / 12);
  assertEquals([P.ssPartitionStud(wall(), undefined), P.ssPartitionStud(wall({ stud: "2x4" }), "2x6")], ["2x4", "2x4"]);
});

// ── Placing ────────────────────────────────────────────────────────────────────────────────────
Deno.test("a click places a wall ACROSS the short span, wall to wall, at the click to the inch", () => {
  assertEquals(P.ssPartitionAt(5, 10.04, W, H), { x1Ft: 0, y1Ft: 10, x2Ft: 12, y2Ft: 10 });
  assertEquals(P.ssPartitionAt(5, 10.5, W, H).y1Ft, 10.5);
  // The same building turned round (32 wide, 12 deep): now it runs north to south, at the click's x.
  assertEquals(P.ssPartitionAt(20.25, 3, 32, 12), { x1Ft: 20.25, y1Ft: 0, x2Ft: 20.25, y2Ft: 12 });
  // A square building takes the west-east run.
  const sq = P.ssPartitionAt(3, 4, 10, 10);
  assertEquals(sq.y1Ft, sq.y2Ft);
  assertEquals(P.ssPartitionAt(5, 0.2, W, H).y1Ft, 1, "never closer than a foot to an outside wall");
  assertEquals(P.ssPartitionAt(5, 31.9, W, H).y1Ft, 31);
  assertEquals(P.ssPartitionAt(1, 0.5, 1.5, 1), null, "no room, no wall");
});

// ── Moving the whole wall ────────────────────────────────────────────────────────────────────────
Deno.test("a wall moved as a whole: wall to wall stays wall to wall, a foot off a wall it runs along, to the inch", () => {
  assertEquals(P.ssPartitionTranslate(wall(), 0, -14, W, H), { x1Ft: 0, y1Ft: 1, x2Ft: 12, y2Ft: 1 });
  assertEquals(P.ssPartitionTranslate(wall(), 0, 30, W, H), { x1Ft: 0, y1Ft: 31, x2Ft: 12, y2Ft: 31 });
  assertEquals(P.ssPartitionTranslate(wall(), 0, 4.49, W, H).y1Ft, 14.5);
  assertEquals(P.ssPartitionTranslate(wall(), 3, 0, W, H), { x1Ft: 0, y1Ft: 10, x2Ft: 12, y2Ft: 10 }, "along itself it goes nowhere");
  assertEquals(P.ssPartitionTranslate(wall({ x1Ft: 2, x2Ft: 8 }), 3, 0, W, H), { x1Ft: 5, y1Ft: 10, x2Ft: 11, y2Ft: 10 });
  // A diagonal from the west wall to the middle of the floor moves across itself only: its wall end
  // slides along the wall's own line to stay on the wall, and the door in it keeps its place on the floor.
  const d = wall({ x1Ft: 0, y1Ft: 4, x2Ft: 6, y2Ft: 10, openings: [door({ centerFt: 4 })] });
  const m = P.ssPartitionTranslate(d, 1, -1, W, H);
  assertAlmostEquals(m.x1Ft, 0); assertAlmostEquals(m.y1Ft, 2); assertEquals([m.x2Ft, m.y2Ft], [7, 9]);
  assertAlmostEquals(m.openings[0].centerFt, 4 + Math.SQRT2, 1e-9);
  const along = P.ssPartitionTranslate(d, 1, 1, W, H);
  assertEquals([along.x1Ft, along.y1Ft, along.x2Ft, along.y2Ft, along.openings], [0, 4, 6, 10, undefined], "along itself it goes nowhere");
  // A wall standing free on the floor follows the pointer.
  assertEquals(P.ssPartitionTranslate(wall({ x1Ft: 2, y1Ft: 4, x2Ft: 6, y2Ft: 8 }), 1, 2, W, H), { x1Ft: 3, y1Ft: 6, x2Ft: 7, y2Ft: 10 });
});

// ── Clashes and joins ──────────────────────────────────────────────────────────────────────────
Deno.test("in line and closer than 6 in, two walls clash; apart, crossing, a T, an L or end to end they do not", () => {
  const a = at(10);
  assert(P.ssPartitionClash(at(10.25, { id: 2 }), [a]));
  assert(!P.ssPartitionClash(at(10.5, { id: 2 }), [a]));
  assert(!P.ssPartitionClash(wall({ id: 2, x1Ft: 6, y1Ft: 0, x2Ft: 6, y2Ft: 32 }), [a]), "crossing (an X)");
  assert(!P.ssPartitionClash(wall({ id: 2, x1Ft: 6, y1Ft: 10, x2Ft: 6, y2Ft: 20 }), [a]), "a T");
  assert(!P.ssPartitionClash(wall({ id: 2, x1Ft: 12, y1Ft: 10, x2Ft: 12, y2Ft: 20 }), [a]), "an L");
  assert(!P.ssPartitionClash(a, [a]), "not with itself");
  assert(!P.ssPartitionClash(at(10, { id: 2 }), [{ ...a, id: 9, type: "loft" }]), "only partitions count");
  const c = wall({ id: 1, x1Ft: 0, y1Ft: 6, x2Ft: 4, y2Ft: 6 });
  assert(!P.ssPartitionClash(wall({ id: 2, x1Ft: 4, y1Ft: 6, x2Ft: 10, y2Ft: 6 }), [c]), "end to end");
  assert(P.ssPartitionClash(wall({ id: 2, x1Ft: 3, y1Ft: 6, x2Ft: 10, y2Ft: 6 }), [c]), "sharing a foot");
  // On a diagonal too.
  const g = wall({ id: 1, x1Ft: 0, y1Ft: 0, x2Ft: 6, y2Ft: 6 });
  assert(P.ssPartitionClash(wall({ id: 2, x1Ft: 3, y1Ft: 3, x2Ft: 9, y2Ft: 9 }), [g]));
  assert(!P.ssPartitionClash(wall({ id: 2, x1Ft: 6, y1Ft: 6, x2Ft: 9, y2Ft: 9 }), [g]));
  assert(!P.ssPartitionClash(wall({ id: 2, x1Ft: 0, y1Ft: 6, x2Ft: 6, y2Ft: 0 }), [g]), "two diagonals crossing");
});

// ── Moving one end ─────────────────────────────────────────────────────────────────────────────
Deno.test("an end lands on the outside wall, keeps 2 ft, and never cuts into a door's framing", () => {
  const p = wall();
  assertEquals(P.ssPartitionMoveEnd(p, "to", 8.04, 10, W, H, []), { x2Ft: 8, y2Ft: 10 });
  assertEquals(P.ssPartitionMoveEnd(p, "to", 11.6, 10, W, H, []), { x2Ft: 12, y2Ft: 10 }, "within 6 in of the wall: on it");
  assertEquals(P.ssPartitionMoveEnd(p, "to", 1, 10, W, H, []), { x2Ft: 2, y2Ft: 10 }, "never shorter than 2 ft");
  assertEquals(P.ssPartitionMoveEnd(p, "from", -3, 10, W, H, []), { x1Ft: 0, y1Ft: 10 });
  // A 3 ft door centred 6 ft from end 1 keeps 3 in of wall on each side of it, and moving end 1 keeps
  // the door where it is on the floor (its centerFt is measured from end 1).
  const d = wall({ openings: [door({ centerFt: 6 })] });
  assertEquals(P.ssPartitionMoveEnd(d, "to", 4, 10, W, H, []), { x2Ft: 7.75, y2Ft: 10 });
  const f = P.ssPartitionMoveEnd(d, "from", 9, 10, W, H, []);
  assertEquals([f.x1Ft, f.y1Ft, f.openings[0].centerFt], [4.25, 10, 1.75]);
});

Deno.test("an end snaps to another wall: its end first, then its body (a T); one out of reach is no magnet", () => {
  const p = wall();
  // A wall crossing this one's line at x = 7 (it spans y 0..20): the end lands on it.
  const cross = wall({ id: 2, x1Ft: 7, y1Ft: 0, x2Ft: 7, y2Ft: 20 });
  assertEquals(P.ssPartitionMoveEnd(p, "to", 7.3, 10, W, H, [cross]), { x2Ft: 7, y2Ft: 10 });
  assertEquals(P.ssPartitionMoveEnd(p, "to", 7.3, 10, W, H, [{ ...cross, y2Ft: 9 }]), { x2Ft: 88 / 12, y2Ft: 10 },
    "one that does not reach this line is no magnet: 7'4\" to the inch");
  // Another wall's END within 6 in: on it, whatever the angle.
  const stub = wall({ id: 2, x1Ft: 8, y1Ft: 0, x2Ft: 8, y2Ft: 6 });
  assertEquals(P.ssPartitionMoveEnd(p, "to", 8.3, 6.2, W, H, [stub]), { x2Ft: 8, y2Ft: 6 });
  // In line with another wall, the end goes where it is put, and the clash is the caller's refusal...
  const c = wall({ id: 1, x1Ft: 0, y1Ft: 6, x2Ft: 4, y2Ft: 6 }), d = wall({ id: 2, x1Ft: 6, y1Ft: 6, x2Ft: 10, y2Ft: 6 });
  assert(P.ssPartitionClash({ ...d, ...P.ssPartitionMoveEnd(d, "from", 2, 6, 10, 12, [c]) }, [c]));
  // ...and near the other's end it meets it, end to end, which is legal.
  const met = { ...d, ...P.ssPartitionMoveEnd(d, "from", 4.3, 6, 10, 12, [c]) };
  assertEquals([met.x1Ft, met.y1Ft], [4, 6]);
  assert(!P.ssPartitionClash(met, [c]));
});

Deno.test("the angle snaps to 0/45/90/135 within 5 degrees, unless Shift or Free angle", () => {
  const p = wall({ x1Ft: 2, y1Ft: 2, x2Ft: 4, y2Ft: 2 });
  assertEquals(P.ssPartitionMoveEnd(p, "to", 8.1, 7.9, W, H, []), { x2Ft: 8, y2Ft: 8 }, "44 degrees is 45");
  assertEquals(P.ssPartitionMoveEnd(p, "to", 8.1, 7.9, W, H, [], true), { x2Ft: 2 + 73 / 12, y2Ft: 2 + 71 / 12 }, "free: where it was put, to the inch");
  assertEquals(P.ssPartitionMoveEnd(p, "to", 8, 6.5, W, H, []), { x2Ft: 8, y2Ft: 6.5 }, "37 degrees is nowhere near a snap");
  assertEquals(P.ssPartitionMoveEnd(p, "to", 2.3, 9, W, H, []), { x2Ft: 2, y2Ft: 9 }, "nearly plumb is plumb");
  // Snapped to 45 near an outside wall: along the snapped line to where it meets that wall.
  const w45 = P.ssPartitionMoveEnd(p, "to", 11.7, 12.1, W, H, []);
  assertEquals(w45.x2Ft, 12);
  assertAlmostEquals(w45.y2Ft, 12, 1e-9);
  assertEquals(P.ssPartitionSnapDir(0, 0, 5, -0.2, false), [1, 0]);
  assertEquals(P.ssPartitionSnapDir(0, 0, -5, 4.8, false), [-Math.SQRT1_2, Math.SQRT1_2]);
  assertEquals(P.ssPartitionSnapDir(0, 0, 5, -0.2, true), null);
});

// ── Doors and windows in it ────────────────────────────────────────────────────────────────────
Deno.test("doors and windows: inside the wall with 3 in of framing, never over each other", () => {
  const p = wall({ openings: [door({ id: 1, centerFt: 3 })] });
  assert(P.ssPartitionOpeningOk(p, door({ id: 1, centerFt: 3 })), "where it is");
  assert(!P.ssPartitionOpeningOk(p, door({ id: 1, centerFt: 1.7 })), "through the end");
  assert(P.ssPartitionOpeningOk(p, door({ id: 1, centerFt: 1.75 })), "flush to the framing");
  assert(!P.ssPartitionOpeningOk(p, door({ id: 2, centerFt: 6 })), "a second 3 ft door 3 ft along overlaps it");
  assert(!P.ssPartitionOpeningOk(p, door({ id: 2, centerFt: 6.25 })), "...and 3 in clear is still too close for two casings");
  assert(P.ssPartitionOpeningOk(p, door({ id: 2, centerFt: 6.375 })), "...4.5 in clear of it is fine");
  assert(P.ssPartitionOpeningOk(p, { id: 2, kind: "window", widthIn: 24, centerFt: 9 }));
  assertEquals(P.ssPartitionCenterRange(wall({ x2Ft: 3 }), 3), null, "a 3 ft door does not fit a 3 ft wall");
  // A diagonal 10 ft wall (6 across, 8 down) takes the same rules along its own length.
  assert(P.ssPartitionOpeningOk(wall({ x1Ft: 0, y1Ft: 0, x2Ft: 6, y2Ft: 8 }), door({ centerFt: 8.25 })));
  assert(!P.ssPartitionOpeningOk(wall({ x1Ft: 0, y1Ft: 0, x2Ft: 6, y2Ft: 8 }), door({ centerFt: 8.3 })));
  assert(P.ssPartitionValid(p) && !P.ssPartitionValid(wall({ x2Ft: 1.5 })) && !P.ssPartitionValid(wall({ x2Ft: 3, openings: [door({ centerFt: 1.5 })] })));
});

Deno.test("a new door seats at the free spot nearest the middle, or nowhere", () => {
  assertEquals(P.ssPartitionSeatOpening(wall(), door({ id: 1 }), 6), 6);
  const one = wall({ openings: [door({ id: 1, centerFt: 6 })] });
  // The middle is taken: a legal centre is 3'4½" away (half of each door plus 4½ in), so the nearest
  // one on the inch is 3'5" away, at 2'7".
  assertEquals(P.ssPartitionSeatOpening(one, door({ id: 2 }), 6), 6 - 41 / 12);
  assertEquals(P.ssPartitionSeatOpening(wall({ x2Ft: 4, openings: [door({ id: 1, centerFt: 2 })] }), door({ id: 2 }), 2), null);
});

// ── A new building size ────────────────────────────────────────────────────────────────────────
Deno.test("a new building size: wall to wall stays wall to wall, the rest is clamped or refused", () => {
  const p = at(20, { openings: [door({ centerFt: 6 })] });
  const grow = P.ssPartitionReflow(p, { w: 12, h: 32 }, { w: 14, h: 32 });
  assertEquals([...ends(grow.item), grow.kind], [0, 20, 14, 20, null]);
  assertEquals(grow.item.openings[0].centerFt, 6, "the door keeps its place");
  const shrink = P.ssPartitionReflow(p, { w: 12, h: 32 }, { w: 10, h: 16 });
  assertEquals([...ends(shrink.item), shrink.kind], [0, 15, 10, 15, null], "it keeps its distance, clamped a foot inside");
  // A partial wall from 2 to 11 ft on a building going down to 8 wide: clamped, and the customer told.
  const part = P.ssPartitionReflow(wall({ x1Ft: 2, x2Ft: 11 }), { w: 12, h: 32 }, { w: 8, h: 32 });
  assertEquals([part.item.x1Ft, part.item.x2Ft, part.kind], [2, 8, "resized"]);
  // A diagonal from the west wall to the east wall stays on both as the building widens.
  const diag = P.ssPartitionReflow(wall({ x1Ft: 0, y1Ft: 4, x2Ft: 12, y2Ft: 16 }), { w: 12, h: 32 }, { w: 16, h: 32 });
  assertEquals([...ends(diag.item), diag.kind], [0, 4, 16, 16, null]);
  // A door that no longer fits refuses the size change rather than vanishing.
  const tight = P.ssPartitionReflow(wall({ x1Ft: 6, x2Ft: 12, openings: [door({ centerFt: 3 })] }), { w: 12, h: 32 }, { w: 9, h: 32 });
  assertEquals(tight.kind, "blocked");
  assertEquals(P.ssPartitionReflow(wall({ x1Ft: 6, x2Ft: 12 }), { w: 12, h: 32 }, { w: 7, h: 32 }).kind, "blocked", "under 2 ft");
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
const ITEMS_CFG = { partitionWall: { label: "Interior wall", width: 4, height: 0.375 } };

for (const [file, src] of [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]] as const) {
  const reflow = reflowOf(src, file);
  Deno.test(`${file}: a size change that would stack two partitions on one line is blocked`, () => {
    // 10 x 12, walls 11 ft and 9 ft from the north wall: both legal. At 10 x 10 the first is clamped
    // to 9 ft, onto the second.
    const a = at(11, { id: 1, x2Ft: 10 }), b = at(9, { id: 2, x2Ft: 10 });
    const r = reflow([a, b], { w: 10, h: 12 }, { w: 10, h: 10 }, ITEMS_CFG);
    assertEquals(r.events.map((e: Any) => [e.id, e.kind]), [[2, "blocked"]]);
    // 11 and 10.5 on a 10 x 12 going to 10 x 11: both clamp to 10 ft.
    const c = at(11, { id: 3, x2Ft: 10 }), d = at(10.5, { id: 4, x2Ft: 10 });
    assertEquals(reflow([c, d], { w: 10, h: 12 }, { w: 10, h: 11 }, ITEMS_CFG).events.map((e: Any) => e.kind), ["blocked"]);
  });
  Deno.test(`${file}: two walls that stay apart reflow with no event`, () => {
    const a = at(11, { id: 1, x2Ft: 10 }), b = at(6, { id: 2, x2Ft: 10 });
    const grow = reflow([a, b], { w: 10, h: 12 }, { w: 12, h: 14 }, ITEMS_CFG);
    assertEquals(grow.events, []);
    assertEquals(grow.items.map((i: Any) => [i.y1Ft, i.x2Ft]), [[11, 12], [6, 12]]);
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

// ── How tall ───────────────────────────────────────────────────────────────────────────────────
Deno.test("height: stud wall height is the wall; a custom height never goes above it; a cut-down wall clears its doors", () => {
  assertEquals(P.ssPartitionHeightFt(wall(), 8), 8);
  assertEquals(P.ssPartitionHeightFt(wall({ heightMode: "custom", heightIn: 90 }), 8), 7.5);
  assertEquals(P.ssPartitionHeightFt(wall({ heightMode: "custom", heightIn: 120 }), 8), 8);
  assertEquals(P.ssPartitionHeightFt({ type: "partitionWall", axis: "x", atFt: 1, fromFt: 0, toFt: 4, heightIn: 0 }, 8), 8, "a nonsense v1 height is the plate");
  assertEquals(P.ssPartitionMinHeightIn(wall()), 24);
  assertEquals(P.ssPartitionMinHeightIn(wall({ openings: [door({ heightIn: 80 })] })), 83);
  assertEquals(P.ssPartitionMinHeightIn(wall({ openings: [{ id: 2, kind: "window", heightIn: 36, sillIn: 42 }] })), 81);
});

// A gable over the 12 ft width: 8 ft at the walls, 10.4 ft at the ridge in the middle.
const gable = (x: number) => 8 + 0.4 * (6 - Math.abs(x - 6));
Deno.test("to the rafters: the top follows the roof along the wall, and its face is the area under it", () => {
  const r = wall({ heightMode: "rafters" });
  const roofAt = (x: number, _y: number) => gable(x);
  assertAlmostEquals(P.ssPartitionTopFt(r, 8, roofAt, 0), 8);
  assertAlmostEquals(P.ssPartitionTopFt(r, 8, roofAt, 6), 10.4);
  assertAlmostEquals(P.ssPartitionTopFt(r, 8, roofAt, 3), 9.2);
  assertAlmostEquals(P.ssPartitionFaceAreaSqFt(r, 8, roofAt), 96 + 14.4, 1e-9, "the rectangle and the gable's triangle, exactly");
  // A wall running the length of the building (north to south) under that roof is flat at its height.
  const along = wall({ heightMode: "rafters", x1Ft: 3, y1Ft: 0, x2Ft: 3, y2Ft: 32 });
  assertAlmostEquals(P.ssPartitionFaceAreaSqFt(along, 8, roofAt), 32 * 9.2, 1e-9);
  // Under a loft, the roof function stops at the loft's floor framing: the wall top follows it.
  const loft = (x: number, y: number) => (x < 4 ? Math.min(gable(x), 7.5) : gable(x));
  assertAlmostEquals(P.ssPartitionTopFt(r, 8, loft, 2), 7.5);
  // No roof to ask (or not to the rafters) is flat at the wall.
  assertEquals(P.ssPartitionFaceAreaSqFt(r, 8, null), 96);
  assertEquals(P.ssPartitionFaceAreaSqFt(wall(), 8, roofAt), 96);
});

Deno.test("how a wall is charged: per lineal foot or per square foot of its face; there is no each", () => {
  const p = wall({ x2Ft: 11.5, heightMode: "custom", heightIn: 90 });
  assertEquals(P.ssPartitionCharge(p, "lineal_ft", 8), { qty: 11.5, per: "per ft", method: "lineal_ft" });
  assertEquals(P.ssPartitionCharge(p, "sqft_option", 8), { qty: 86.25, per: "per sq ft", method: "sqft_option" });
  assertEquals(P.ssPartitionCharge(wall(), "sqft_option", 8.5), { qty: 102, per: "per sq ft", method: "sqft_option" }, "stud wall height is the priced wall");
  assertEquals(P.ssPartitionCharge(p, "each", 8), { qty: 11.5, per: "per ft", method: "lineal_ft" }, "never one wall at the rate");
  assertEquals(P.ssPartitionCharge(p, "pct_estimate_total", 8), { qty: 11.5, per: "per ft", method: "lineal_ft" });
  assertEquals(P.ssPartitionCharge(p, undefined, 8).qty, 11.5);
  // To the rafters, per square foot: the face under the roof, never less than the wall's own.
  const r = wall({ heightMode: "rafters" });
  assertEquals(P.ssPartitionCharge(r, "sqft_option", 8, (x: number) => gable(x)).qty, 110.4);
  assertEquals(P.ssPartitionCharge(r, "sqft_option", 8, () => 7).qty, 96, "under a low loft it is still the wall's");
  assertEquals(P.ssPartitionCharge(r, "sqft_option", 8, null).qty, 96, "no roof to ask: the wall's");
  assertEquals(P.ssPartitionCharge(r, "lineal_ft", 8, (x: number) => gable(x)).qty, 12, "height means nothing per foot");
  // A diagonal 10 ft wall is 10 ft, whatever its angle.
  assertEquals(P.ssPartitionCharge(wall({ x1Ft: 0, y1Ft: 0, x2Ft: 6, y2Ft: 8 }), "lineal_ft", 8).qty, 10);
});

Deno.test("the estimate's summary: ends, sizes, framing and catalog ids, every partition and nothing else", () => {
  const items = [
    { id: 5, type: "loft", x: 1, y: 1 },
    wall({ id: 7, x1Ft: 1, x2Ft: 9.25, heightMode: "custom", heightIn: 90, stud: "2x6",
      openings: [door({ id: 1, fixtureItemId: "fx-1", name: "Barn Door", price: 450, swing: "in", operation: "right" })] }),
  ];
  assertEquals(P.ssPartitionSummary(items, 8), [{
    id: "7", x1Ft: 1, y1Ft: 10, x2Ft: 9.25, y2Ft: 10, lengthFt: 8.25, stud: "2x6", covers: { a: null, b: null },
    heightMode: "custom", heightIn: 90, heightFt: 7.5, faceAreaSqFt: 61.88,
    openings: [{ id: "1", kind: "door", fixtureItemId: "fx-1", name: "Barn Door", widthIn: 36, heightIn: 80, swing: "in", operation: "right", price: 450 }],
  }]);
  const [r] = P.ssPartitionSummary([wall({ heightMode: "rafters" })], 8, (x: number) => gable(x));
  assertEquals([r.heightMode, r.heightIn, r.heightFt, r.faceAreaSqFt], ["rafters", null, 8, 110.4]);
  // A v1 wall goes out in v2's words.
  const [v1] = P.ssPartitionSummary([{ id: 2, type: "partitionWall", wall: null, axis: "y", atFt: 4, fromFt: 0, toFt: 6.5, heightIn: null, openings: [] }], 8);
  assertEquals([v1.x1Ft, v1.y1Ft, v1.x2Ft, v1.y2Ft, v1.lengthFt, v1.heightMode], [4, 0, 4, 6.5, 6.5, "plate"]);
  assertEquals(P.ssPartitionSummary([{ id: 1, type: "shelf" }], 8), []);
  assertEquals(P.ssPartitionSummary([{ id: 3, type: "partitionWall", x: 400, y: 260 }], 8), []);
});

Deno.test("the plan's pieces and hit test: solid stretches round the openings, along the wall, at any angle", () => {
  const p = wall({ openings: [door({ id: 2, centerFt: 9 }), door({ id: 1, centerFt: 3 })] });
  const pc = P.ssPartitionPieces(p);
  assertEquals(pc.solid, [[0, 1.5], [4.5, 7.5], [10.5, 12]]);
  assertEquals(pc.holes.map((h: Any) => h.o.id), [1, 2]);
  // Page geometry: 20 px a foot, the plan's corner at (100, 50). The wall is the line y = 50 + 10 x 20.
  assertEquals(P.ssPartitionHit(p, 100 + 3 * 20, 250 + 4, 100, 50, 20, 6), 3);
  assertEquals(P.ssPartitionHit(p, 100 + 3 * 20, 250 + 9, 100, 50, 20, 6), null);
  assertEquals(P.ssPartitionOpeningAt(p, 3.4).id, 1);
  assertEquals(P.ssPartitionOpeningAt(p, 6), null);
  // A diagonal (0,0) -> (6,8): 5 ft along is (3,4); 0.1 ft off its line is still on it, 0.5 ft is not.
  const d = wall({ x1Ft: 0, y1Ft: 0, x2Ft: 6, y2Ft: 8 });
  assertAlmostEquals(P.ssPartitionHit(d, 100 + (3 + 0.08) * 20, 50 + (4 - 0.06) * 20, 100, 50, 20, 6), 5, 1e-9);
  assertEquals(P.ssPartitionHit(d, 100 + (3 + 0.4) * 20, 50 + (4 - 0.3) * 20, 100, 50, 20, 6), null);
  assertAlmostEquals(P.ssPartitionAlongFt(d, 3, 4), 5);
});

Deno.test("sizes and labels read the way a builder writes them", () => {
  assertEquals(P.ssPartitionFtIn(12), "12'");
  assertEquals(P.ssPartitionFtIn(7.5), "7'6\"");
  assertEquals(P.ssPartitionFtIn(0.25), "3\"");
  assertEquals(P.ssPartitionSize(wall(), 8), "12' long, stud wall height (8')");
  assertEquals(P.ssPartitionSize(wall({ heightMode: "custom", heightIn: 90 }), 8), "12' long, 7'6\" tall");
  assertEquals(P.ssPartitionSize(wall({ heightMode: "rafters" }), 8), "12' long, to the rafters");
  assertEquals(P.ssPartitionPlanLabel(wall({ heightMode: "custom", heightIn: 90 }), 8, "2x4"), "INTERIOR 12' · 2x4 · 7'6\" tall");
  assertEquals(P.ssPartitionPlanLabel(wall({ heightMode: "rafters", stud: "2x6" }), 8, "2x4"), "INTERIOR 12' · 2x6 · to rafters");
  assertEquals(P.ssPartitionPlanLabel(wall(), 7.5, "2x6"), "INTERIOR 12' · 2x6 · 7'6\" tall");
});

// ── The builder's setup (ssInteriorWallCfg, outside the block; lifted from both twins) ─────────────
// Each builder sets interior walls up on the tab (2026-10-17, no seed). get_config's interiorWalls:
// an object = the tab; null = not set up (no wall offered, $0); ABSENT = a get_config from before 312
// (the 278 layout row, as before; the server reads it in exactly that case: the table missing).
const liftFn = (src: string, name: string, file: string) => {
  const i = src.indexOf(`function ${name}(`), j = i < 0 ? -1 : src.indexOf("\n}\n", i);
  if (i < 0 || j < 0) throw new Error(`partition_test: ${name} moved in ${file}`);
  return src.slice(i, j + 3);
};
const CFG_SRC = liftFn(CMP, "ssInteriorWallCfg", "structure-studio.component.js");
const iwCfg: (C: Any, layoutRate?: Any) => Any = new Function(`${CFG_SRC}; return ssInteriorWallCfg;`)();

Deno.test("ssInteriorWallCfg is the same in both twins", () => {
  assertStrictEquals(liftFn(JSX, "ssInteriorWallCfg", "StructureStudio.jsx"), CFG_SRC);
});

Deno.test("an unconfigured builder (interiorWalls null) is offered no wall and prices nothing, whatever the 278 row says", () => {
  const c = iwCfg({ interiorWalls: null, showPricing: true }, { rate: 35, method: "lineal_ft" });
  assertEquals([c.offered, c.studs, c.source], [false, { "2x4": null, "2x6": null }, "none"]);
});

Deno.test("the tab: per lineal ft or per sq ft; 'each' or a standard with no rate is not offered", () => {
  const tab = (o: Any) => iwCfg({ showPricing: true, interiorWalls: { offered: true, standardStud: "2x4", studs: { "2x4": { rate: 30 } }, method: "lineal_ft", ...o } });
  assertEquals([tab({}).offered, tab({}).method, tab({}).studs["2x4"]], [true, "lineal_ft", 30]);
  assertEquals([tab({ method: "sqft_option" }).offered, tab({ method: "sqft_option" }).method], [true, "sqft_option"]);
  assertEquals([tab({ method: "each" }).offered, tab({ method: "each" }).studs["2x4"]], [false, null]);
  assertEquals(tab({ offered: false }).offered, false);
  assertEquals(tab({ internalOnly: true }).internalOnly, true);
});

Deno.test("no interiorWalls key at all (before 312): the 278 row, as before; a non-wall method prices nothing", () => {
  const legacy = iwCfg({ showPricing: true }, { rate: 35, method: "lineal_ft" });
  assertEquals([legacy.offered, legacy.studs["2x4"], legacy.method, legacy.source], [true, 35, "lineal_ft", "layout"]);
  assertEquals(iwCfg({ showPricing: true }, { rate: 400, method: "each" }).studs["2x4"], null);
});
