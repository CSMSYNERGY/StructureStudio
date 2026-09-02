// Wall-slab overlap rules, tested against the SHIPPED designer source.
//
// Why lift the code instead of copying it: this logic decides whether a shelf may sit above a
// workbench and whether a door may be dragged onto either. Every failure mode here is SILENT —
// you do not get an error, you get a plan with two things occupying the same wall, rasterised
// into the PDF and sent to the shop. A copied-out copy would happily keep passing while the
// shipped file drifted, which is the one thing a test of this kind must not do. Same technique
// preflight already uses for my-quotes.html: extract the real block, run it, assert on it.
//
// The extraction is a plain slice between two stable anchors. If either moves, this fails loudly
// rather than testing nothing — see the explicit guard below.

import { assert, assertEquals, assertFalse } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../../../structure-studio.component.js", import.meta.url),
);

const START = "const SS_SLAB_BANDS = {";
const END = "function parseSize(";
const i = SRC.indexOf(START);
const j = SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  throw new Error(
    "wallSlab_test: could not find the slab block in structure-studio.component.js " +
      `(start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`,
  );
}
const BLOCK = SRC.slice(i, j);

// Sanity: the slice must actually contain the four things we are about to exercise. Without
// this, a bad anchor yields an empty block and every assertion below passes vacuously.
for (const name of ["ssSlabModel", "ssSlabBand", "ssBandsOverlap", "checkWallSlabOverlap", "slabDepthFt"]) {
  assert(BLOCK.includes(name), `extracted block is missing ${name}`);
}

// snapToWallInterior lives ABOVE the slab block, so it is lifted separately — the geometry
// assertion below needs the real one, not a re-implementation of it.
const SNAP_START = "function snapToWallInterior(";
const SNAP_END = "// Always returns a wall";
const si = SRC.indexOf(SNAP_START), sj = SRC.indexOf(SNAP_END, si);
if (si < 0 || sj < 0) throw new Error(`wallSlab_test: snapToWallInterior anchors moved (${si}, ${sj})`);
const snapToWallInterior = new Function(`${SRC.slice(si, sj)}; return snapToWallInterior;`)() as (
  wall: string, cx: number, cy: number, iW: number, iH: number, pW: number, pH: number, mgX: number, mgY: number,
) => { x: number; y: number; rotation: number; wall: string };

const factory = new Function(`${BLOCK}; return { ssSlabModel, ssSlabBand, ssBandsOverlap, checkWallSlabOverlap, slabDepthFt };`);
const { ssSlabModel, ssSlabBand, checkWallSlabOverlap, slabDepthFt } = factory() as {
  slabDepthFt: (cfg: Record<string, unknown> | null, it?: Record<string, unknown>) => number;
  ssSlabModel: (t: string, m: Record<string, unknown>) => string | null;
  ssSlabBand: (it: Record<string, unknown>, m: Record<string, unknown>) => number[] | null;
  ssBandsOverlap: (a: number[], b: number[]) => boolean;
  checkWallSlabOverlap: (
    sn: Record<string, unknown>,
    widthFtPx: number,
    existing: Record<string, unknown>[],
    itemTypes: Record<string, unknown>,
    sc: number,
    cand?: Record<string, unknown>,
  ) => boolean;
};

// A config as get_config emits it AFTER migration 171.
const ITEMS = {
  workbench: { wallSnap: true, modelKey: "wallBench", width: 4, height: 2, heightOffFloorIn: 36 },
  shelf: { wallSnap: true, modelKey: "wallShelf", width: 4, height: 1, heightOffFloorIn: 48 },
  doubleShelf: { wallSnap: true, modelKey: "wallShelfDouble", width: 4, height: 1, heightOffFloorIn: 48 },
  outlet: { wallSnap: true, modelKey: "outlet", width: 0.5, height: 0.3, heightOffFloorIn: 16 },
  singleDoor: { wallOnly: true, width: 3, height: 0.5 },
};
// The SAME config as a tenant whose row has not been regenerated: wallSnap, but no modelKey.
const LEGACY = { workbench: { wallSnap: true, width: 4, height: 2 } };

const SC = 20; // px per foot
const at = (x: number) => ({ wall: "north", x, y: 0 });

Deno.test("legacy config (no modelKey) still enforces the workbench rule", () => {
  // The regression that matters most: shipping the browser change before the migration must not
  // quietly stop enforcing overlap for every tenant on the old config shape.
  assertEquals(ssSlabModel("workbench", LEGACY), "legacy");
  assertEquals(ssSlabBand({ type: "workbench" }, LEGACY), [0, 1e4]);
  const bench = { type: "workbench", wall: "north", x: 100, y: 0, widthFt: 4 };
  assert(checkWallSlabOverlap(at(100), 4 * SC, [bench], LEGACY, SC));
});

Deno.test("a shelf hangs above a workbench on the same span", () => {
  const bench = { type: "workbench", wall: "north", x: 100, y: 0, widthFt: 4, heightOffFloorIn: 36 };
  const shelf = { type: "shelf", heightOffFloorIn: 48 };
  // Bench occupies 0..36 in; a 48 in shelf occupies 48..50. No overlap, so this is allowed —
  // this is the whole point of the height band.
  assertFalse(checkWallSlabOverlap(at(100), 4 * SC, [bench], ITEMS, SC, shelf));
});

Deno.test("a shelf BELOW the workbench top is refused", () => {
  const bench = { type: "workbench", wall: "north", x: 100, y: 0, widthFt: 4, heightOffFloorIn: 36 };
  const lowShelf = { type: "shelf", heightOffFloorIn: 30 }; // 30..32 sits inside 0..36
  assert(checkWallSlabOverlap(at(100), 4 * SC, [bench], ITEMS, SC, lowShelf));
});

Deno.test("two shelves at the same height on the same span collide", () => {
  const first = { type: "shelf", wall: "north", x: 100, y: 0, widthFt: 4, heightOffFloorIn: 48 };
  const second = { type: "shelf", heightOffFloorIn: 48 };
  assert(checkWallSlabOverlap(at(100), 4 * SC, [first], ITEMS, SC, second));
  // …and clear of each other along the wall, they do not.
  assertFalse(checkWallSlabOverlap(at(300), 4 * SC, [first], ITEMS, SC, second));
});

Deno.test("a double shelf's upper board blocks what a single one would not", () => {
  // wallShelfDouble spans heightOffFloor..+20in, so a 60in shelf lands inside a 48in double.
  const dbl = { type: "doubleShelf", wall: "north", x: 100, y: 0, widthFt: 4, heightOffFloorIn: 48 };
  assert(checkWallSlabOverlap(at(100), 4 * SC, [dbl], ITEMS, SC, { type: "shelf", heightOffFloorIn: 60 }));
  const single = { type: "shelf", wall: "north", x: 100, y: 0, widthFt: 4, heightOffFloorIn: 48 };
  assertFalse(checkWallSlabOverlap(at(100), 4 * SC, [single], ITEMS, SC, { type: "shelf", heightOffFloorIn: 60 }));
});

Deno.test("a door blocks against every slab regardless of height", () => {
  // A wallOnly caller passes no `cand` and therefore blocks the full height — a doorway cannot
  // have a shelf across it however high the shelf is mounted.
  const shelf = { type: "shelf", wall: "north", x: 100, y: 0, widthFt: 4, heightOffFloorIn: 48 };
  assert(checkWallSlabOverlap(at(100), 3 * SC, [shelf], ITEMS, SC));
});

Deno.test("electrical devices are wallSnap but are NOT slabs", () => {
  // The reason the predicate reads modelKey rather than wallSnap: an outlet must never block a
  // door or a shelf, or the auto-layout in a later slice would make walls unusable.
  assertEquals(ssSlabModel("outlet", ITEMS), null);
  const outlet = { type: "outlet", wall: "north", x: 100, y: 0, widthFt: 0.5, heightOffFloorIn: 16 };
  assertFalse(checkWallSlabOverlap(at(100), 3 * SC, [outlet], ITEMS, SC));
  assertEquals(ssSlabModel("singleDoor", ITEMS), null); // wallOnly is not a slab either
});

Deno.test("slabs on different walls never interact", () => {
  const bench = { type: "workbench", wall: "south", x: 100, y: 0, widthFt: 4, heightOffFloorIn: 36 };
  assertFalse(checkWallSlabOverlap(at(100), 4 * SC, [bench], ITEMS, SC, { type: "workbench", heightOffFloorIn: 36 }));
});

// ── Depth: what is SNAPPED must equal what is DRAWN ────────────────────────────────────────
// The regression this pins put every wall-mounted item half outside its wall, in 2D and
// straight through it in 3D. The cause was one number read two ways: the item was positioned
// using the layout type's own `height` while being drawn at the BUILDER's `depthIn`. It only
// appeared once a builder set a depth bigger than the type default, which is why it survived
// the first round of testing — so the invariant, not the symptom, is what is asserted here.

Deno.test("the builder's depth is what gets drawn AND what gets snapped", () => {
  const shelf = { wallSnap: true, modelKey: "wallShelf", width: 4, height: 1, depthIn: 24 };
  assertEquals(slabDepthFt(shelf), 2, "24 in must read as 2 ft, not the 1 ft type default");
  const bench = { wallSnap: true, modelKey: "wallBench", width: 4, height: 2, depthIn: 36 };
  assertEquals(slabDepthFt(bench), 3);
});

Deno.test("no depth set falls back to the type's own height", () => {
  // Every item that predates depthIn — and every wallOnly door/window, which never has one —
  // must keep snapping exactly as it always did.
  assertEquals(slabDepthFt({ wallSnap: true, height: 2 }), 2);
  assertEquals(slabDepthFt({ wallOnly: true, height: 0.5 }), 0.5);
  assertEquals(slabDepthFt(null), 2);
  assertEquals(slabDepthFt({ height: 0 }), 2, "a zero height would snap onto the wall line");
});

Deno.test("an already-placed item keeps its own depth", () => {
  // Re-pricing a shelf's depth must never move one already sitting on somebody's saved plan.
  const cfg = { wallSnap: true, modelKey: "wallShelf", width: 4, height: 1, depthIn: 24 };
  assertEquals(slabDepthFt(cfg, { heightFt: 1 }), 1);
  assertEquals(slabDepthFt(cfg, {}), 2, "an item with no stored depth takes the current one");
});

// ── The bug Carolyn saw: items standing half outside their wall, and through it in 3D ──────
// The failure was ONE NUMBER READ TWO WAYS: the item was SNAPPED using the layout type's own
// `height` while being DRAWN at the builder's `depthIn`. So the assertion has to model both
// depths independently — a test that uses the same number for each is self-consistent and
// would have passed straight through the bug (this one did, until it was rewritten).

const SCALE2 = 20, MGX = 100, MGY = 100, PW = 12 * SCALE2, PH = 24 * SCALE2;

// How far a rectangle DRAWN at drawFt pokes past the wall it was SNAPPED against at snapFt,
// in feet. Zero means flush inside; positive means it is hanging through the wall.
function outsideByFt(snapFt: number, drawFt: number, wall: string, widthFt = 4) {
  const sn = snapToWallInterior(
    wall, MGX + PW / 2, MGY + PH / 2, widthFt * SCALE2, snapFt * SCALE2, PW, PH, MGX, MGY,
  );
  const halfDraw = (drawFt * SCALE2) / 2;
  const over =
    wall === "north" ? MGY - (sn.y - halfDraw)
    : wall === "south" ? (sn.y + halfDraw) - (MGY + PH)
    : wall === "west" ? MGX - (sn.x - halfDraw)
    : (sn.x + halfDraw) - (MGX + PW);
  return Math.round((over / SCALE2) * 1000) / 1000;
}

const WALLS = ["north", "south", "east", "west"];

Deno.test("snapping at the drawn depth puts the item flush inside its wall", () => {
  // Carolyn's real catalog when she hit this: 24 in shelves on a 1 ft type default and a 36 in
  // bench on a 2 ft one, plus a door, which has no depthIn at all.
  for (const cfg of [
    { wallSnap: true, modelKey: "wallShelf", width: 4, height: 1, depthIn: 24 },
    { wallSnap: true, modelKey: "wallShelfDouble", width: 4, height: 1, depthIn: 24 },
    { wallSnap: true, modelKey: "wallBench", width: 4, height: 2, depthIn: 36 },
    { wallSnap: true, modelKey: "wallBench", width: 4, height: 2 },
    { wallOnly: true, width: 3, height: 0.5 },
  ]) {
    const d = slabDepthFt(cfg);
    for (const wall of WALLS) {
      assertEquals(outsideByFt(d, d, wall, Number(cfg.width)), 0, `${cfg.modelKey || "door"} on ${wall}`);
    }
  }
});

Deno.test("snapping at the TYPE height while drawing the builder's depth hangs outside", () => {
  // This is the shipped bug, reproduced. It is here so the test above cannot quietly become a
  // tautology again: if someone re-points a snap call at cfg.height, this is the size of the
  // overhang they are choosing — half the difference, on every wall.
  const shelf = { wallSnap: true, modelKey: "wallShelf", width: 4, height: 1, depthIn: 24 };
  for (const wall of WALLS) {
    assertEquals(outsideByFt(Number(shelf.height), slabDepthFt(shelf), wall), 0.5);
  }
  const bench = { wallSnap: true, modelKey: "wallBench", width: 4, height: 2, depthIn: 36 };
  for (const wall of WALLS) {
    assertEquals(outsideByFt(Number(bench.height), slabDepthFt(bench), wall), 0.5);
  }
});
