// Vents in the GABLE, tested against the SHIPPED designer source.
//
// Carolyn, 2026-09-14, placing a Standard Vent: it landed on the front wall beside the door, low,
// and every vent she sells goes up in the gable. From 2026-09-15 a vent placed on a gable end is
// fitted into the gable triangle (ventZone "gable", ventRiseFt above the plate), and it is REFUSED
// a gable too small for it rather than drawn smaller than the size on the estimate.
//
// Every rule here fails silently when it is wrong: a vent drawn through a rake, a priced vent
// quietly shrunk, a shelf refused by a vent the plate is between, two vents in one gable. So the
// real functions are lifted out of structure-studio.component.js by stable anchors and run, the
// wallSlab_test technique. Every anchor is guarded, so a moved one fails loudly.

import { assert, assertAlmostEquals, assertEquals, assertFalse } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));
const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));

function lift(start: string, end: string) {
  const a = SRC.indexOf(start), b = SRC.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`ventGable_test: anchors moved for ${start} (${a}, ${b}). Re-point them rather than deleting this test.`);
  return SRC.slice(a, b);
}
// Up to the doc comment that opens `endMarker`'s block, so the slice never ends inside a comment.
function liftToComment(start: string, endMarker: string) {
  const a = SRC.indexOf(start), m = SRC.indexOf(endMarker, a);
  const b = m < 0 ? -1 : SRC.lastIndexOf("/**", m);
  if (a < 0 || b <= a) throw new Error(`ventGable_test: anchors moved for ${start} (${a}, ${b})`);
  return SRC.slice(a, b);
}
const oneLine = (re: RegExp) => {
  const m = re.exec(SRC);
  if (!m) throw new Error(`ventGable_test: ${re} moved — re-point it`);
  return m[0];
};

const BLOCK = [
  oneLine(/const isVentItem = [^\n]*\n/),
  oneLine(/const SS_PAGE = \{[^\n]*\n/),
  lift("const D3 = {", "// The casing reveal every opening"),
  lift("function snapToWall(", "// Always returns a wall"),
  // checkDoorCollision, the slab bands, ssIsGableVent, wallSlabBlocker, checkWallSlabOverlap.
  lift("function checkDoorCollision(", "function parseSize("),
  lift("function pageGeom(", "// Where a ramp sits"),
  lift("function rampPosFor(", "// Items the customer sizes"),
  lift("const SS_RO_KEYS = [", "// Plan/PDF label"),
  lift("const SS_SHRINKABLE = {", "function reflowItems("),
  lift("function reflowItems(", "// Point on a note box's border"),
  // ssVentSpan, the gable constants and helpers, ventStamps.
  lift("function ssVentSpan(", "function buildFixtureTools("),
  lift("function ssItemVBand(", "// A flat wall-face elevation"),
  lift("function d3RoofAxes(", "// Everything about a transom dormer"),
  lift("function d3OpeningDefaults(", "// Resolve a palette value"),
  liftToComment("function d3ScopeForItemsChange(", "Structure3DPanel — the 3D docked"),
].join("\n");
for (const name of ["ssGableEndWalls", "ssGableVentFit", "ssGableVentPlace", "ssVentGableDefault", "ssIsGableVent", "d3ProfSpanAt", "ssPorchTrussWall", "reflowItems", "d3ScopeForItemsChange"]) {
  assert(BLOCK.includes(`function ${name}(`), `extracted block is missing ${name}`);
}

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(`${BLOCK}; return { ssGableEndWalls, ssGableVentFit, ssGableVentPlace, ssVentGableDefault, ssIsGableVent, d3ProfSpanAt,
  d3RoofAxes, d3RoofProfile, ssVentSpan, ssItemVBand, checkDoorCollision, wallSlabBlocker, checkWallSlabOverlap, reflowItems, pageGeom,
  d3ScopeForItemsChange, SS_GABLE_TOO_SMALL, SS_GABLE_VENT_MIN_RISE };`)() as Record<string, Any>;

const GABLE = { type: "gable", pitch: 0.42 };                        // the Cabin's pitch
const H = 7.5;
const VENT = { widthIn: 12, heightIn: 8, widthFt: 1 };               // Standard Vent
const MIN_RISE = 2 / 12;

// A plan the way the designer lays one out, so x/y are real page pixels.
const geo = (w: number, l: number) => F.pageGeom(w, l) as { scale: number; pW: number; pH: number; mgX: number; mgY: number };
const ITEMS = {
  window: { wallOnly: true, width: 2, height: 0.5 },
  singleDoor: { wallOnly: true, width: 3, height: 0.5 },
  doubleShelf: { wallSnap: true, modelKey: "wallShelfDouble", width: 4, height: 1, heightOffFloorIn: 60 },
};
const vent = (g: ReturnType<typeof geo>, wall: string, alongFt: number, extra: Record<string, unknown> = {}) => ({
  id: Math.random(), type: "window", isVent: true, ...VENT, wall,
  x: wall === "north" || wall === "south" ? g.mgX + alongFt * g.scale : (wall === "west" ? g.mgX : g.mgX + g.pW),
  y: wall === "west" || wall === "east" ? g.mgY + alongFt * g.scale : (wall === "north" ? g.mgY : g.mgY + g.pH),
  rotation: wall === "west" || wall === "east" ? 90 : 0, ...extra,
});

Deno.test("a 12x32 gable: north and south are its gable ends, and a 12x8 vent fits centred under the ridge", () => {
  assertEquals(F.ssGableEndWalls(GABLE, 12, 32), ["north", "south"]);
  const fit = F.ssGableVentFit(GABLE, 12, 32, "south", H, VENT, null, null);
  assert(fit, "the Standard Vent must fit a 12 ft Cabin gable");
  assertAlmostEquals(fit.alongFt, 6, 1e-9);
  assertAlmostEquals(fit.riseFt, MIN_RISE, 1e-9);
  assert(fit.y0 > H, "the louvre's bottom is above the plate");
  assertAlmostEquals(fit.y1 - fit.y0, 8 / 12, 1e-9);
  assertEquals(fit.w, 1);
  // An eave wall has no gable above it.
  assertEquals(F.ssGableVentFit(GABLE, 12, 32, "east", H, VENT, null, null), null);
});

Deno.test("a landscape footprint's gable ends are west and east", () => {
  assertEquals(F.ssGableEndWalls(GABLE, 32, 12), ["west", "east"]);
  const fit = F.ssGableVentFit(GABLE, 32, 12, "west", H, VENT, null, null);
  assert(fit);
  assertAlmostEquals(fit.alongFt, 6, 1e-9);
  assertEquals(F.ssGableVentFit(GABLE, 32, 12, "south", H, VENT, null, null), null);
});

Deno.test("a single slant has no gable to put a vent in; a gambrel does", () => {
  assertEquals(F.ssGableEndWalls({ type: "shed", pitch: 0.25 }, 10, 16), []);
  assertEquals(F.ssGableEndWalls({ type: "gambrel" }, 10, 16), ["north", "south"]);
  assert(F.ssGableVentFit({ type: "gambrel" }, 10, 16, "north", H, VENT, null, null));
});

Deno.test("8 ft wide at 3:12 cannot hold a 24 in vent: null, never a smaller vent", () => {
  const shallow = { type: "gable", pitch: 0.25 };
  assertEquals(F.ssGableVentFit(shallow, 8, 12, "south", H, { widthIn: 24, heightIn: 12, widthFt: 2 }, null, null), null);
  // The same building at 6:12 does take a 12 in vent — the refusal is about room, not the roof type.
  assert(F.ssGableVentFit({ type: "gable", pitch: 0.5 }, 8, 12, "south", H, VENT, null, null));
});

Deno.test("along is clamped inside the rakes, and the frame's top corners keep 3 in clear", () => {
  const fit = F.ssGableVentFit(GABLE, 12, 32, "south", H, VENT, 0.2, null);
  assert(fit && fit.alongFt > 0.2, `slid in from the corner (got ${fit && fit.alongFt})`);
  const ax = F.d3RoofAxes(GABLE, 12, 32);
  const sp = F.d3ProfSpanAt(F.d3RoofProfile(GABLE, ax.S, H, ax.tallNeg).dedup, fit.y1 + fit.F);
  assert(fit.u - fit.w / 2 - fit.F >= sp[0] + 0.25 - 1e-6, "left frame corner inside the rake");
  const far = F.ssGableVentFit(GABLE, 12, 32, "south", H, VENT, 11.9, null);
  assert(far.u + far.w / 2 + far.F <= -sp[0] - 0.25 + 1e-6, "right frame corner inside the rake");
});

Deno.test("a rise too high for the gable is lowered until it fits, and the vent keeps its size", () => {
  const fit = F.ssGableVentFit(GABLE, 12, 32, "south", H, VENT, null, 2.3);   // the peak is 2.52 up
  assert(fit && fit.riseFt < 2.3 && fit.riseFt >= MIN_RISE, `rise ${fit && fit.riseFt}`);
  assertEquals(fit.w, 1);
  assertAlmostEquals(fit.h, 8 / 12, 1e-9);
  // A rise that fits is kept exactly.
  assertAlmostEquals(F.ssGableVentFit(GABLE, 12, 32, "south", H, VENT, null, 0.5).riseFt, 0.5, 1e-12);
});

Deno.test("over a porch's king-post truss the sill clears the brace feet; the far end keeps the 2 in sill", () => {
  const porch = { ...GABLE, porchTruss: true, porchDepthFt: 6 };
  assert(F.ssGableVentFit(porch, 12, 32, "south", H, VENT, null, null).riseFt >= 0.42 - 1e-9);
  assertAlmostEquals(F.ssGableVentFit(porch, 12, 32, "north", H, VENT, null, null).riseFt, MIN_RISE, 1e-9);
});

Deno.test("ssVentSpan and ssItemVBand put a gable vent above the plate and say so", () => {
  const it = { isVent: true, heightIn: 8, ventZone: "gable", ventRiseFt: 0.5 };
  const s = F.ssVentSpan(it, H);
  assertAlmostEquals(s[0], 8.0, 1e-9);
  assertAlmostEquals(s[1], 8.0 + 8 / 12, 1e-9);
  const band = F.ssItemVBand(it, { wallOnly: true }, ITEMS, H);
  assertEquals(band.gable, true);
  // A vent placed before the zone existed is exactly where it always was: under the plate.
  const old = F.ssVentSpan({ isVent: true, heightIn: 8 }, H);
  assertAlmostEquals(old[1], H - 0.35, 1e-9);
  assertEquals(F.ssItemVBand({ isVent: true, heightIn: 8 }, { wallOnly: true }, ITEMS, H).gable, undefined);
});

Deno.test("a gable vent over a door is not refused, in either order", () => {
  const g = geo(12, 32);
  const door = { id: 1, type: "singleDoor", wall: "south", x: g.mgX + 6 * g.scale, y: g.mgY + g.pH, widthFt: 3 };
  const gv = vent(g, "south", 6, { ventZone: "gable", ventRiseFt: MIN_RISE });
  assertFalse(F.checkDoorCollision(gv, { width: 1 }, [door], ITEMS, g.scale));
  assertFalse(F.checkDoorCollision({ ...door, id: 2 }, { width: 3 }, [gv], ITEMS, g.scale));
  // The rule is not simply off: a window driven through that door is still refused.
  assert(F.checkDoorCollision({ id: 3, type: "window", wall: "south", x: door.x, y: door.y, widthFt: 2 }, { width: 2 }, [door], ITEMS, g.scale));
});

Deno.test("two gable vents at one spot are refused; apart along the wall they are not", () => {
  const g = geo(12, 32);
  const a = vent(g, "south", 6, { ventZone: "gable", ventRiseFt: MIN_RISE });
  assert(F.checkDoorCollision(vent(g, "south", 6.3, { ventZone: "gable", ventRiseFt: 1.2 }), { width: 1 }, [a], ITEMS, g.scale));
  assertFalse(F.checkDoorCollision(vent(g, "south", 3.5, { ventZone: "gable", ventRiseFt: MIN_RISE }), { width: 1 }, [a], ITEMS, g.scale));
  // Nor does one on the other gable end.
  assertFalse(F.checkDoorCollision(vent(g, "north", 6, { ventZone: "gable", ventRiseFt: MIN_RISE }), { width: 1 }, [a], ITEMS, g.scale));
});

Deno.test("a 60 in double shelf and a gable vent never refuse each other", () => {
  const g = geo(12, 32);
  const shelf = { id: 9, type: "doubleShelf", wall: "south", x: g.mgX + 6 * g.scale, y: g.mgY + g.pH - 0.5 * g.scale, widthFt: 4, heightOffFloorIn: 60 };
  const gv = vent(g, "south", 6, { ventZone: "gable", ventRiseFt: MIN_RISE });
  // Placing the vent over the shelf (the slab check), and the shelf under the vent (the opening check).
  assertEquals(F.wallSlabBlocker(gv, 1 * g.scale, [shelf], ITEMS, g.scale, gv), null);
  assertFalse(F.checkDoorCollision({ ...shelf, id: 10 }, { ...ITEMS.doubleShelf, width: 4 }, [gv], ITEMS, g.scale));
  // Contrast: a WALL vent at the same spot is inside that double shelf's 60-122 in band, and refused.
  const wv = vent(g, "south", 6);
  assert(F.wallSlabBlocker(wv, 1 * g.scale, [shelf], ITEMS, g.scale, wv), "a wall vent inside the shelf band must still be refused");
});

Deno.test("the placement default: into the gable on a gable end, untouched on an eave, and told why on a small gable", () => {
  const g = geo(12, 32);
  const onEnd = F.ssVentGableDefault(GABLE, 12, 32, H, vent(g, "south", 2), [], ITEMS, g.scale, g.mgX, g.mgY);
  assertEquals(onEnd.note, null);
  assertEquals(onEnd.ni.ventZone, "gable");
  assertAlmostEquals(onEnd.ni.ventRiseFt, MIN_RISE, 1e-9);
  assertAlmostEquals((onEnd.ni.x - g.mgX) / g.scale, 6, 1e-9);            // under the ridge, not where it was clicked

  const eave = vent(g, "east", 10);
  const onEave = F.ssVentGableDefault(GABLE, 12, 32, H, eave, [], ITEMS, g.scale, g.mgX, g.mgY);
  assertEquals(onEave, { ni: eave, note: null });

  const g8 = geo(8, 12);
  const big = { ...vent(g8, "south", 4), widthIn: 24, heightIn: 12, widthFt: 2 };
  const small = F.ssVentGableDefault({ type: "gable", pitch: 0.25 }, 8, 12, H, big, [], ITEMS, g8.scale, g8.mgX, g8.mgY);
  assertEquals(small.ni, big);
  assertEquals(small.note, F.SS_GABLE_TOO_SMALL);

  // The centre already holds a gable vent: the second goes where it was clicked, clamped under the rake.
  const taken = { ...onEnd.ni, id: 77 };
  const second = F.ssVentGableDefault(GABLE, 12, 32, H, vent(g, "south", 3), [taken], ITEMS, g.scale, g.mgX, g.mgY);
  assertEquals(second.ni.ventZone, "gable");
  const along = (second.ni.x - g.mgX) / g.scale;
  assert(along < 4.5 && along >= 3 - 1e-9, `second vent at ${along}`);
  assertFalse(F.checkDoorCollision(second.ni, { width: 1 }, [taken], ITEMS, g.scale));
});

Deno.test("the docked 3D rebuilds everything when a gable vent changes, and only its wall for a wall vent", () => {
  const g = geo(12, 32);
  const gv = vent(g, "south", 6, { id: 5, ventZone: "gable", ventRiseFt: MIN_RISE });
  assertEquals(F.d3ScopeForItemsChange([gv], [{ ...gv, x: gv.x + 10 }], ITEMS), { full: true });
  // A vent LEAVING the gable takes its cap drawing with it, so that is full too.
  assertEquals(F.d3ScopeForItemsChange([gv], [{ ...gv, ventZone: null }], ITEMS), { full: true });
  const wv = vent(g, "south", 6, { id: 6 });
  assertEquals(F.d3ScopeForItemsChange([wv], [{ ...wv, x: wv.x + 10 }], ITEMS), { walls: ["south"], interior: false });
});

Deno.test("a size change re-fits a gable vent, brings it down where the new size has no gable, and a reload keeps it", () => {
  const A = geo(12, 32);
  const gv = vent(A, "south", 6, { id: 11, ventZone: "gable", ventRiseFt: 0.5 });
  const placer = (next: { w: number; h: number }) => (cand: Any, sn: Any, B: Any) =>
    F.ssGableVentPlace(GABLE, next.w, next.h, H, cand, sn, B.scale, B.mgX, B.mgY,
      ((sn.wall === "north" || sn.wall === "south") ? sn.x - B.mgX : sn.y - B.mgY) / B.scale, cand.ventRiseFt);

  // 12x32 -> 12x24: still a gable end, same rise, still centred.
  const shorter = F.reflowItems([gv], { w: 12, h: 32 }, { w: 12, h: 24 }, ITEMS, placer({ w: 12, h: 24 })).items[0];
  assertEquals(shorter.ventZone, "gable");
  assertAlmostEquals(shorter.ventRiseFt, 0.5, 1e-12);

  // 12x32 -> 32x12: south is an eave now, so the vent comes down to the wall.
  const turned = F.reflowItems([gv], { w: 12, h: 32 }, { w: 32, h: 12 }, ITEMS, placer({ w: 32, h: 12 })).items[0];
  assertEquals(turned.wall, "south");
  assertEquals(turned.ventZone, null);
  assertEquals(turned.ventRiseFt, null);

  // repairLoaded passes no placer: a saved gable vent is left exactly as saved.
  const loaded = F.reflowItems([gv], { w: 12, h: 32 }, { w: 12, h: 32 }, ITEMS).items[0];
  assertEquals(loaded.ventZone, "gable");
  assertAlmostEquals(loaded.ventRiseFt, 0.5, 1e-12);
});

Deno.test("both twins wire the gable vent into the 3D model and both placement paths", () => {
  for (const [name, text] of [["component.js", SRC], ["jsx", JSX]] as const) {
    // model.rebuildWalls must not tear down a gable vent's group (the roof builder owns it) ...
    assert(/\.filter\(\(g\) => g\.userData && g\.userData\.wall === wname && !g\.userData\.gable\)/.test(text), `${name}: rebuildWalls skips gable groups`);
    // ... buildOneWall must not cut a hole in the wall for one ...
    assert(text.includes("it.wall === wname && !gableVentFitOf(it)"), `${name}: buildOneWall skips vents drawn in the gable`);
    // ... it is drawn pickable, tagged, and the style's vent gives way on its end.
    assert(text.includes("vg.userData = { itemId: v.it.id, wallItem: true, wall: v.it.wall, gable: true };"), `${name}: placed gable vent group`);
    assert(text.includes("!(end === END0 ? gableVentAt0 : gableVentAtL)"), `${name}: style vent suppressed on an end with a placed vent`);
    // The 2D included chip and the 3D placeFixture3 both call the one default.
    assertEquals((text.match(/= ssVentGableDefault\(/g) || []).length, 2, `${name}: both placement paths call ssVentGableDefault`);
  }
});
