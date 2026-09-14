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
for (const name of ["ssGableEndWalls", "ssGableVentFit", "ssGableVentPlace", "ssVentGableDefault", "ssIsGableVent", "d3ProfSpanAt", "ssPorchTrussWall", "reflowItems", "d3ScopeForItemsChange",
  "ssVentWhere", "ssVentAt", "ssVentDragZone", "ssVentRefusal", "ssVentNudge", "ssVentSetZone"]) {
  assert(BLOCK.includes(`function ${name}(`), `extracted block is missing ${name}`);
}

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(`${BLOCK}; return { ssGableEndWalls, ssGableVentFit, ssGableVentPlace, ssVentGableDefault, ssIsGableVent, d3ProfSpanAt,
  d3RoofAxes, d3RoofProfile, ssVentSpan, ssItemVBand, checkDoorCollision, wallSlabBlocker, checkWallSlabOverlap, reflowItems, pageGeom,
  d3ScopeForItemsChange, SS_GABLE_TOO_SMALL, SS_GABLE_VENT_MIN_RISE,
  ssVentWhere, ssVentAt, ssVentDragZone, ssVentNudge, ssVentSetZone, SS_REFUSE_WALL, SS_REFUSE_SLAB,
  SS_VENT_NO_GABLE, SS_VENT_NO_ROOM, SS_VENT_TOP_GABLE, SS_VENT_BOTTOM_GABLE, SS_VENT_TOP_WALL, SS_VENT_TOP_WALL_GABLE, SS_VENT_FLOOR };`)() as Record<string, Any>;

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

// ── Moving a vent up and down (2026-09-15, plan 1.10) ────────────────────────────────────────────
// The 3D drag, the plan's ▲/▼ and its "In the gable" / "On the wall" chips all go through
// ssVentAt / ssVentNudge / ssVentSetZone. Each case below is a place the customer can put a vent,
// or a sentence they are told when they cannot.
const TOP_SILL = H - 0.35 - 8 / 12;   // a Standard Vent's bottom edge at today's under-plate spot

Deno.test("a vent moved down the wall: ssVentSpan honours a variable sill, clamps it, and ignores a sill on a fixed vent", () => {
  const vh = 8 / 12;
  const lowered = { isVent: true, heightIn: 8, sillFt: 3, sillMode: "variable" };
  assertEquals(F.ssVentSpan(lowered, H), [3, 3 + vh]);
  assertEquals(F.ssItemVBand(lowered, { wallOnly: true }, ITEMS, H), { bottomFt: 3, topFt: 3 + vh });
  // Never through the plate, never under 6 in.
  assertAlmostEquals(F.ssVentSpan({ ...lowered, sillFt: 7.4 }, H)[1], H - 0.35, 1e-9);
  assertEquals(F.ssVentSpan({ ...lowered, sillFt: 0 }, H)[0], 0.5);
  // "fixed" is today's spot whatever a stray sillFt says, and the gable zone wins over a leftover sill.
  assertAlmostEquals(F.ssVentSpan({ ...lowered, sillMode: "fixed" }, H)[0], TOP_SILL, 1e-9);
  assertAlmostEquals(F.ssVentSpan({ ...lowered, ventZone: "gable", ventRiseFt: 0.5 }, H)[0], H + 0.5, 1e-9);
});

Deno.test("ssVentAt: the wall's top spot is FIXED (it follows the plate), anything lower is a variable sill, and the gable writes the sill off", () => {
  const g = geo(12, 32);
  const v = vent(g, "east", 10);
  const at = { wall: v.wall, x: v.x, y: v.y };
  assertEquals(F.ssVentAt(GABLE, 12, 32, H, v, at, g.scale, g.mgX, g.mgY, "wall", null), { ...at, ventZone: null, ventRiseFt: null, sillFt: null, sillMode: "fixed" });
  assertEquals(F.ssVentAt(GABLE, 12, 32, H, v, at, g.scale, g.mgX, g.mgY, "wall", 99).sillMode, "fixed");
  const low = F.ssVentAt(GABLE, 12, 32, H, v, at, g.scale, g.mgX, g.mgY, "wall", TOP_SILL - 0.25);
  assertEquals(low.sillMode, "variable");
  assertAlmostEquals(low.sillFt, TOP_SILL - 0.25, 1e-9);
  assertEquals(F.ssVentAt(GABLE, 12, 32, H, v, at, g.scale, g.mgX, g.mgY, "wall", -3).sillFt, 0.5);
  // No gable above an eave wall; on the south end a rise, and the sill pair back to fixed.
  assertEquals(F.ssVentAt(GABLE, 12, 32, H, v, at, g.scale, g.mgX, g.mgY, "gable", H + 1), null);
  const s = vent(g, "south", 6, { sillFt: 3, sillMode: "variable" });
  const up = F.ssVentAt(GABLE, 12, 32, H, s, { wall: "south", x: s.x, y: s.y }, g.scale, g.mgX, g.mgY, "gable", H + 1);
  assertEquals([up.ventZone, up.sillFt, up.sillMode], ["gable", null, "fixed"]);
  assertAlmostEquals(up.ventRiseFt, 1, 1e-9);
});

Deno.test("the 3D drag's zone has a quarter foot of hysteresis either side of the plate", () => {
  assertEquals(F.ssVentDragZone("wall", H + 0.2, H), "wall");
  assertEquals(F.ssVentDragZone("wall", H + 0.3, H), "gable");
  assertEquals(F.ssVentDragZone("gable", H - 0.2, H), "gable");
  assertEquals(F.ssVentDragZone("gable", H - 0.3, H), "wall");
});

Deno.test("▲/▼ in the gable: 3 in a press, refused with a sentence at the sill and under the peak, never shrunk", () => {
  const g = geo(12, 32);
  let v: Any = vent(g, "south", 6, { id: 1, ventZone: "gable", ventRiseFt: MIN_RISE });
  assertEquals(F.ssVentNudge(GABLE, 12, 32, H, v, -1, [], ITEMS, g.scale, g.mgX, g.mgY).refuse, F.SS_VENT_BOTTOM_GABLE);
  assertAlmostEquals(F.ssVentNudge(GABLE, 12, 32, H, v, 1, [], ITEMS, g.scale, g.mgX, g.mgY).patch.ventRiseFt, MIN_RISE + 0.25, 1e-9);
  let n = 0, last: Any = null;
  for (; n < 20; n++) {
    last = F.ssVentNudge(GABLE, 12, 32, H, v, 1, [], ITEMS, g.scale, g.mgX, g.mgY);
    if (last.refuse) break;
    v = { ...v, ...last.patch };
  }
  assertEquals(last.refuse, F.SS_VENT_TOP_GABLE);
  assert(n >= 3 && n < 12, `pressed ${n} times before the gable stopped it`);
  assert(v.ventRiseFt > MIN_RISE + 0.5 && v.ventRiseFt < 2.52, `top rise ${v.ventRiseFt}`);
  assertEquals(v.widthFt, 1);
  assert(F.ssGableVentFit(GABLE, 12, 32, "south", H, v, (v.x - g.mgX) / g.scale, v.ventRiseFt), "the top it stopped at still fits");
});

Deno.test("▲/▼ on the wall: a variable sill down to the floor, back up to the FIXED top spot, and the top says where to go next", () => {
  const g = geo(12, 32);
  const south = vent(g, "south", 6, { id: 2 });
  assertEquals(F.ssVentNudge(GABLE, 12, 32, H, south, 1, [], ITEMS, g.scale, g.mgX, g.mgY).refuse, F.SS_VENT_TOP_WALL_GABLE);
  const east = vent(g, "east", 10, { id: 3 });
  assertEquals(F.ssVentNudge(GABLE, 12, 32, H, east, 1, [], ITEMS, g.scale, g.mgX, g.mgY).refuse, F.SS_VENT_TOP_WALL);
  const d1 = F.ssVentNudge(GABLE, 12, 32, H, east, -1, [], ITEMS, g.scale, g.mgX, g.mgY).patch;
  assertEquals(d1.sillMode, "variable");
  assertAlmostEquals(d1.sillFt, TOP_SILL - 0.25, 1e-9);
  const back = F.ssVentNudge(GABLE, 12, 32, H, { ...east, ...d1 }, 1, [], ITEMS, g.scale, g.mgX, g.mgY).patch;
  assertEquals([back.sillFt, back.sillMode], [null, "fixed"]);
  assertEquals(F.ssVentNudge(GABLE, 12, 32, H, { ...east, sillFt: 0.5, sillMode: "variable" }, -1, [], ITEMS, g.scale, g.mgX, g.mgY).refuse, F.SS_VENT_FLOOR);
});

Deno.test("▼ refuses what a drag would: onto a window below, into a shelf's band", () => {
  const g = geo(12, 32);
  // A window whose head is 1 in under the vent's bottom edge.
  const win = { id: 20, type: "window", wall: "east", x: g.mgX + g.pW, y: g.mgY + 10 * g.scale, widthFt: 2, rotation: 90, sillFt: TOP_SILL - 1 / 12 - 3, openingHeightFt: 3 };
  const v = vent(g, "east", 10, { id: 21 });
  assertEquals(F.ssVentNudge(GABLE, 12, 32, H, v, -1, [win], ITEMS, g.scale, g.mgX, g.mgY).refuse, F.SS_REFUSE_WALL);
  // A double shelf low on the wall: the vent comes down until the next press would enter its band.
  const shelf = { id: 22, type: "doubleShelf", wall: "east", x: g.mgX + g.pW - 0.5 * g.scale, y: g.mgY + 10 * g.scale, widthFt: 4, rotation: 90, heightOffFloorIn: 12 };
  const shelfTop = F.ssItemVBand(shelf, ITEMS.doubleShelf, ITEMS).topFt;
  assert(shelfTop < TOP_SILL, `the shelf (top ${shelfTop}) sits below the vent's top spot`);
  let cur: Any = v, last: Any = null;
  for (let k = 0; k < 40; k++) {
    last = F.ssVentNudge(GABLE, 12, 32, H, cur, -1, [shelf], ITEMS, g.scale, g.mgX, g.mgY);
    if (last.refuse) break;
    cur = { ...cur, ...last.patch };
  }
  assertEquals(last.refuse, F.SS_REFUSE_SLAB);
  assert(cur.sillFt >= shelfTop - 1e-9 && cur.sillFt - 0.25 < shelfTop, `stopped at ${cur.sillFt} over a shelf top of ${shelfTop}`);
});

Deno.test("the zone chips: into the gable at the sill keeping its place along, onto the wall at the top, and each refusal says why", () => {
  const g = geo(12, 32);
  const wallVent = vent(g, "south", 4, { id: 30, sillFt: 3, sillMode: "variable" });
  const up = F.ssVentSetZone(GABLE, 12, 32, H, wallVent, "gable", [], ITEMS, g.scale, g.mgX, g.mgY).patch;
  assertEquals([up.ventZone, up.sillFt, up.sillMode], ["gable", null, "fixed"]);
  assertAlmostEquals(up.ventRiseFt, MIN_RISE, 1e-9);
  assertAlmostEquals((up.x - g.mgX) / g.scale, 4, 1e-9);                 // not recentred
  assertEquals(F.ssVentSetZone(GABLE, 12, 32, H, { ...wallVent, ...up }, "gable", [], ITEMS, g.scale, g.mgX, g.mgY), { patch: null });
  const down = F.ssVentSetZone(GABLE, 12, 32, H, { ...wallVent, ...up }, "wall", [], ITEMS, g.scale, g.mgX, g.mgY).patch;
  assertEquals([down.ventZone, down.ventRiseFt, down.sillFt, down.sillMode], [null, null, null, "fixed"]);
  assertEquals(F.ssVentSetZone(GABLE, 12, 32, H, vent(g, "east", 10), "wall", [], ITEMS, g.scale, g.mgX, g.mgY), { patch: null });

  assertEquals(F.ssVentSetZone(GABLE, 12, 32, H, vent(g, "east", 10), "gable", [], ITEMS, g.scale, g.mgX, g.mgY).refuse, F.SS_VENT_NO_GABLE);
  const g8 = geo(8, 12);
  const big = { ...vent(g8, "south", 4), widthIn: 24, heightIn: 12, widthFt: 2 };
  assertEquals(F.ssVentSetZone({ type: "gable", pitch: 0.25 }, 8, 12, H, big, "gable", [], ITEMS, g8.scale, g8.mgX, g8.mgY).refuse, F.SS_VENT_NO_ROOM);
  // Another vent holds that spot in the gable; another item holds the wall's top spot.
  const holder = vent(g, "south", 4, { id: 31, ventZone: "gable", ventRiseFt: MIN_RISE });
  assertEquals(F.ssVentSetZone(GABLE, 12, 32, H, wallVent, "gable", [holder], ITEMS, g.scale, g.mgX, g.mgY).refuse, F.SS_REFUSE_WALL);
  assertEquals(F.ssVentSetZone(GABLE, 12, 32, H, holder, "wall", [vent(g, "south", 4, { id: 32 })], ITEMS, g.scale, g.mgX, g.mgY).refuse, F.SS_REFUSE_WALL);
});

Deno.test("a gable vent whose gable is gone (the style became a single slant) reads as on the wall, and On the wall writes the stale key off", () => {
  const g = geo(12, 32);
  const shed = { type: "shed", pitch: 0.25 };
  const stale = vent(g, "south", 6, { id: 40, ventZone: "gable", ventRiseFt: MIN_RISE });
  const w = F.ssVentWhere(shed, 12, 32, H, stale, g.scale, g.mgX, g.mgY);
  assertEquals(w.zone, "wall");
  assertAlmostEquals(w.bottomFt, TOP_SILL, 1e-9);
  assertEquals(F.ssVentSetZone(shed, 12, 32, H, stale, "wall", [], ITEMS, g.scale, g.mgX, g.mgY).patch.ventZone, null);
});

Deno.test("both twins move vents vertically in 3D and give the plan its zone chips and arrows", () => {
  for (const [name, text] of [["component.js", SRC], ["jsx", JSX]] as const) {
    assert(text.includes("const zone = ssVentDragZone(now.zone, want, Hv);"), `${name}: the 3D drag decides the zone with hysteresis`);
    assert(text.includes('it.type === "window" && !isVentItem(it) && it.sillMode === "variable"'), `${name}: the window's vertical branch excludes vents`);
    assert(text.includes("sillFt: moved.sillFt != null ? moved.sillFt : null, sillMode:"), `${name}: drag end sends the vent's sill pair`);
    assert(text.includes("= ssVentSetZone(") && text.includes("= ssVentNudge("), `${name}: plan handlers`);
    assert(text.includes(">In the gable</button>") && text.includes(">On the wall</button>"), `${name}: zone chips`);
  }
});
