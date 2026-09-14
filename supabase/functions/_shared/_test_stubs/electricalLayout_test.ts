// The electrical package's auto-LAYOUT, tested against the SHIPPED designer source.
//
// electrical_test pins the COUNTS (a pricing input both sides compute). This pins WHERE the
// devices land, which is not a pricing input but is what the customer sees the moment they tick
// the package, and what is rasterised into the plan the shop builds from.
//
// Carolyn's rule, 2026-09-02: "with a workbench they go above the workbench." Until 2026-09-15
// the layout tried an outlet at ONE height over a slab — the builder's outletAboveBenchIn — and
// silently dropped it if anything was still in the way there (her own catalog mounts shelves at
// 36", so a shelf at 42" or a double over a bench was enough). The heights are a list now.
//
// Same lift-the-real-code technique as wallSlab_test: slice the functions out of
// structure-studio.component.js by stable anchors and run them. Every anchor is guarded, so a
// moved one fails loudly instead of testing an empty block.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../../../structure-studio.component.js", import.meta.url),
);

function lift(start: string, end: string) {
  const a = SRC.indexOf(start), b = SRC.indexOf(end, a);
  if (a < 0 || b < 0) {
    throw new Error(`electricalLayout_test: anchors moved for ${start} (${a}, ${b}). Re-point them rather than deleting this test.`);
  }
  return SRC.slice(a, b);
}
const IS_VENT = /const isVentItem = [^\n]*\n/.exec(SRC);
if (!IS_VENT) throw new Error("electricalLayout_test: isVentItem moved — re-point it");

const PARTS = [
  IS_VENT[0],
  lift("function snapToWallInterior(", "// Always returns a wall"),
  lift("function d3OpeningDefaults(", "// Resolve a palette value"),
  // checkDoorCollision, the slab bands, wallSlabBlocker and checkWallSlabOverlap in one slice.
  lift("function checkDoorCollision(", "function parseSize("),
  lift("function ssItemVBand(", "// A flat wall-face elevation"),
  // The electrical helpers through electricalAutoItems and electricalBenchWall.
  lift("const ELECTRICAL_DEVICES = [", "function wallHeightFitsWidth("),
];
const BLOCK = PARTS.join("\n");
for (const name of ["electricalAutoItems", "electricalBenchWall", "wallSlabBlocker", "ssItemVBand", "snapToWallInterior"]) {
  assert(BLOCK.includes(`function ${name}(`), `extracted block is missing ${name}`);
}

type Item = Record<string, unknown> & { type: string; wall?: string; x: number; y: number; heightOffFloorIn?: number };
const { electricalAutoItems, electricalBenchWall, snapToWallInterior } = new Function(
  `${BLOCK}; return { electricalAutoItems, electricalBenchWall, snapToWallInterior };`,
)() as {
  electricalAutoItems: (cfg: unknown, o: Record<string, unknown>) => Item[];
  electricalBenchWall: (existing: Item[], itemTypes: unknown, wall: string, xFt: number, yFt: number, o: Record<string, unknown>) => boolean;
  snapToWallInterior: (wall: string, cx: number, cy: number, iW: number, iH: number, pW: number, pH: number, mgX: number, mgY: number) => { x: number; y: number; rotation: number; wall: string };
};

// A 12x24 on a 20 px/ft plan: 72 ft of perimeter at 6 ft spacing is 12 outlets, and the walk
// puts two on the north wall at 3 ft and 9 ft from the north-west corner.
const SC = 20, MGX = 100, MGY = 100, W = 12, L = 24;
const GEO = { widthFt: W, lengthFt: L, scale: SC, mgX: MGX, mgY: MGY, pW: W * SC, pH: L * SC, frontWall: "south", startId: 1000 };

// The tools as the designer builds them: the slabs from get_config (Carolyn's catalog shape), the
// devices exactly as elecToolsFor emits them since 2026-09-15.
const elecTool = (id: string, h: number, ceiling = false) => ({
  label: id, wallSnap: !ceiling, modelKey: "electrical", width: ceiling ? 0.8 : 0.5, height: ceiling ? 0.8 : 0.3,
  heightOffFloorIn: h, noPalette: true, electricalItemId: id,
});
const T = {
  workbench: { wallSnap: true, modelKey: "wallBench", width: 4, height: 2, depthIn: 36, heightOffFloorIn: 36 },
  shelf: { wallSnap: true, modelKey: "wallShelf", width: 4, height: 1, depthIn: 24, heightOffFloorIn: 36 },
  doubleShelf: { wallSnap: true, modelKey: "wallShelfDouble", width: 4, height: 1, depthIn: 24, heightOffFloorIn: 36 },
  legacyBench: { wallSnap: true, width: 4, height: 2 },
  fixtureDoor: { wallOnly: true, width: 3, height: 0.5 },
  OUT: elecTool("OUT", 24), SW: elecTool("SW", 48), LT: elecTool("LT", 96, true),
};
const CFG = {
  outletSpacingFt: 6, lightSpacingFt: 10, outletItemId: "OUT", switchItemId: "SW", lightItemId: "LT",
  outletHeightIn: 24, outletAboveBenchIn: 42, switchHeightIn: 48,
};

// A slab placed the way the 2D click places it: snapped at its drawn depth, centred at xFt on
// the north wall.
function onNorth(type: keyof typeof T, xFt: number, extra: Record<string, unknown> = {}): Item {
  const c = T[type] as { width: number; height: number; depthIn?: number };
  const depth = c.depthIn ? c.depthIn / 12 : c.height;
  const sn = snapToWallInterior("north", MGX + xFt * SC, MGY, c.width * SC, depth * SC, W * SC, L * SC, MGX, MGY);
  return { id: Math.random(), type, ...sn, widthFt: c.width, heightFt: depth, ...extra } as Item;
}
const layout = (existing: Item[], cfg = CFG) => electricalAutoItems(cfg, { ...GEO, itemTypes: T, existing });
const outlets = (out: Item[]) => out.filter((i) => i.type === "OUT");
// The north-wall outlet nearest xFt, which is the one sitting over a slab centred there.
const northOutletAt = (out: Item[], xFt: number) =>
  outlets(out).filter((i) => i.wall === "north").sort((a, b) => Math.abs(a.x - (MGX + xFt * SC)) - Math.abs(b.x - (MGX + xFt * SC)))[0];

Deno.test("an empty 12x24 lays out the full standard at the builder's heights", () => {
  const out = layout([]);
  assertEquals(outlets(out).length, 12);
  assert(outlets(out).every((i) => i.heightOffFloorIn === 24), "every outlet at outletHeightIn");
  assertEquals(out.filter((i) => i.type === "LT").length, 2);
  assertEquals(out.filter((i) => i.type === "SW").map((i) => i.heightOffFloorIn), [48]);
});

Deno.test("a workbench raises the outlet over it to outletAboveBenchIn and keeps the count", () => {
  const out = layout([onNorth("workbench", 3, { heightOffFloorIn: 36 })]);
  assertEquals(outlets(out).length, 12, "a bench must never cost the customer an outlet");
  assertEquals(northOutletAt(out, 3).heightOffFloorIn, 42);
  assertEquals(northOutletAt(out, 9).heightOffFloorIn, 24, "the outlet clear of the bench is untouched");
});

Deno.test("a shelf at 42in pushes the outlet to the shelf's top + 6in", () => {
  // The shelf's band is 42..44, so outletAboveBenchIn (42) lands inside it. This is the case
  // that was silently SKIPPED before 2026-09-15: count 11, and nothing said why.
  const withBench = layout([onNorth("workbench", 3, { heightOffFloorIn: 36 }), onNorth("shelf", 3, { heightOffFloorIn: 42 })]);
  assertEquals(outlets(withBench).length, 12);
  assertEquals(northOutletAt(withBench, 3).heightOffFloorIn, 50);
  // A shelf on its own counts as the thing to go above, too.
  const shelfOnly = layout([onNorth("shelf", 3, { heightOffFloorIn: 42 })]);
  assertEquals(outlets(shelfOnly).length, 12);
  assertEquals(northOutletAt(shelfOnly, 3).heightOffFloorIn, 50);
});

Deno.test("a double shelf over a bench climbs above its top board", () => {
  // 36in double: boards at 36 and 72, band 36..74. 42 is inside it; 74 + 6 = 80 clears.
  const out = layout([onNorth("workbench", 3, { heightOffFloorIn: 36 }), onNorth("doubleShelf", 3, { heightOffFloorIn: 36 })]);
  assertEquals(outlets(out).length, 12);
  assertEquals(northOutletAt(out, 3).heightOffFloorIn, 80);
});

Deno.test("a low shelf under outletAboveBenchIn leaves the outlet at 42in", () => {
  const out = layout([onNorth("shelf", 3, { heightOffFloorIn: 24 })]); // 24..26
  assertEquals(northOutletAt(out, 3).heightOffFloorIn, 42);
});

Deno.test("an outlet past the END of a bench, but still overlapping it, climbs too", () => {
  // Put the bench so the 9 ft outlet's own half-width (8.75..9.25) overlaps the bench's end
  // without the outlet's centre being over it: electricalBenchWall says no, wallSlabBlocker says
  // yes, and it must climb, not drop. The overlap is 0.15 ft = 3 px, deliberately more than
  // wallSlabBlocker's 2 px touching tolerance (a 1 px overlap is "flush" and correctly ignored).
  const bench = onNorth("workbench", 9 - 2 - 0.1, { heightOffFloorIn: 36 }); // spans 4.9..8.9
  assertEquals(electricalBenchWall([bench], T, "north", 9, 0, GEO), false);
  const out = layout([bench]);
  assertEquals(outlets(out).length, 12);
  assertEquals(northOutletAt(out, 9).heightOffFloorIn, 42, "36in bench top + 6in");
});

Deno.test("a doorway is still the one thing that skips an outlet", () => {
  const door = { id: 1, type: "fixtureDoor", wall: "north", x: MGX + 3 * SC, y: MGY, widthFt: 3, heightIn: 80 } as Item;
  const out = layout([door]);
  assertEquals(outlets(out).length, 11);
  assertEquals(outlets(out).filter((i) => i.wall === "north").length, 1);
});

Deno.test("a legacy bench (no modelKey) still skips — its band is a blocker, not a height", () => {
  // [0, 1e4] has no "top" to climb above. Climbing to 1e4 + 6 would put an outlet in the sky.
  const out = layout([onNorth("legacyBench", 3)]);
  assertEquals(outlets(out).length, 11);
  assert(outlets(out).every((i) => Number(i.heightOffFloorIn) < 100));
});

Deno.test("a hand-placed outlet is not a bench: it neither raises nor drops the auto one", () => {
  // Before 2026-09-15 an electrical device read as a legacy slab, so electricalBenchWall called a
  // placed outlet a workbench and the layout skipped the spot beside it.
  const mine = { id: 1, type: "OUT", wall: "north", x: MGX + 3.2 * SC, y: MGY, widthFt: 0.5, heightOffFloorIn: 24, electricalItemId: "OUT" } as Item;
  assertEquals(electricalBenchWall([mine], T, "north", 3.2, 0, GEO), false);
  const out = layout([mine]);
  assertEquals(outlets(out).length, 12);
  assertEquals(northOutletAt(out, 3).heightOffFloorIn, 24);
});

Deno.test("no outletAboveBenchIn set: the outlet climbs off the bench it is behind", () => {
  const { outletAboveBenchIn: _drop, ...noAbove } = CFG;
  const out = layout([onNorth("workbench", 3, { heightOffFloorIn: 36 })], noAbove as typeof CFG);
  assertEquals(outlets(out).length, 12);
  assertEquals(northOutletAt(out, 3).heightOffFloorIn, 42, "24 is behind the bench; 36 + 6 clears it");
});
