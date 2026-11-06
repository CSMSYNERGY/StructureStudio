// THE LOFT'S HEIGHT — on the top plate by default, a rep's own height on request, tested against BOTH
// SHIPPED designer twins.
//
// Carolyn, 2026-10-06: by default the loft sits on the top plate of the wall, following the design's
// own wall height, and a rep can change it per design. Before this every loft was a fixed 5'6"
// (D3.LOFT_ELEV) that nothing could change. The placed loft now carries `onPlate: true` (the plate
// over its footprint, whatever the walls are) or `elevationFt` (a height a rep set, never above the
// plate), never both; a loft with neither is one saved before the change and draws where it always did.
//
// Everything about it that is not a mesh is pure module-scope code inside the lifted roof region
// (ssLoftPlateFt, ssLoftElevFt, ssLoftWithHeight between the LOFT HEIGHT markers, after d3CeilingFt),
// plus the renderer's one closure that turns those into a drawn height (loftElevOf, which the viewer's
// highlight box and drag plane read through model.loftElevFt). They are lifted by stable anchors and
// run, the roofStep_test technique, and every lifted region is asserted byte-identical across the two
// hand-mirrored twins. The meshes and the toolbar are proved on the compiled bundle by
// tests/harness/loftHeight.mjs.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const JSX = await read("../../../../StructureStudio.jsx");
const CMP = await read("../../../../structure-studio.component.js");

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `loftHeight_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  // d3RoofAxes .. d3CeilingFt, and the LOFT HEIGHT block right after it.
  ["function d3RoofAxes(", "function d3FtIn("],
  // d3ProjectingPorch and the porch helpers the roof step asks (a porch end shortens the step's room).
  ["function ssVentSpan(", "function buildFixtureTools("],
  // fmtFtIn and fmtDimFtIn: the notes' feet and inches.
  ["function fmtFtIn(", "// How far a placed item's two ends sit"],
];
const blocks = REGIONS.map(([a, b]) => ({ a, cmp: lift(CMP, "structure-studio.component.js", a, b), jsx: lift(JSX, "StructureStudio.jsx", a, b) }));
const LOFT = ["// ── LOFT HEIGHT ──", "// ── END LOFT HEIGHT ──"];
const loftCmp = lift(CMP, "structure-studio.component.js", LOFT[0], LOFT[1]);
const loftJsx = lift(JSX, "StructureStudio.jsx", LOFT[0], LOFT[1]);
// The renderer's closure, lifted out of buildShed3DModel.
const ELEV = ["  const loftElevOf = (it) => {", "  const buildInterior = (itemsNow)"];
const elevCmp = lift(CMP, "structure-studio.component.js", ELEV[0], ELEV[1]);
const elevJsx = lift(JSX, "StructureStudio.jsx", ELEV[0], ELEV[1]);

// buildElectrical3D's ceiling read (UNDER A LOFT): the local ceiling, lowered to the underside of a loft
// whose floor reaches the fitting. From the cH0 read to the fan/disc split that uses its cH.
const UNDER = ["      const cH0 = d3CeilingFt(", "      if (fan) {"];
const underCmp = lift(CMP, "structure-studio.component.js", UNDER[0], UNDER[1]);
const underJsx = lift(JSX, "StructureStudio.jsx", UNDER[0], UNDER[1]);

Deno.test("every lifted loft region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
  assertEquals(loftJsx, loftCmp, "twins differ in the LOFT HEIGHT block");
  assertEquals(elevJsx, elevCmp, "twins differ in buildShed3DModel's loftElevOf");
  assertEquals(underJsx, underCmp, "twins differ in buildElectrical3D's ceiling read under a loft");
});

Deno.test("the LOFT HEIGHT block sits INSIDE the lifted roof region, after d3CeilingFt", () => {
  const roof = blocks[1].cmp;
  const at = roof.indexOf(LOFT[0]), ceil = roof.indexOf("function d3CeilingFt(");
  assert(ceil >= 0 && at > ceil, "the block must come after d3CeilingFt, inside function d3RoofAxes( .. function d3FtIn(");
  assert(roof.indexOf(LOFT[1]) > at, "its end marker is inside the region too");
  // Literals only at the top level: shedProfile_test, ventGable_test and porchGeom_test evaluate the
  // region with nothing in scope, so a top-level statement that CALLED something would break them.
  const top = loftCmp.split("\n").filter((l) => /^(const|let|var) /.test(l));
  assertEquals(top, ["const SS_LOFT_MIN_IN = 48;", "const D3_LOFT_PLATE_GAP = 0.02;"]);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `const isVentItem = (it) => !!(it && it.isVent);\n${blocks.map((b) => b.cmp).join("\n")}; return { D3, d3CeilingFt, d3RoofStep, d3Massing, ` +
    `ssLoftPlateFt, ssLoftElevFt, ssLoftWithHeight, fmtDimFtIn, SS_LOFT_MIN_IN, D3_LOFT_PLATE_GAP };`,
)() as Record<string, Any>;

// The renderer's loftElevOf with the closure it reads handed in: page px are feet (scale 1, no margin).
// `H` is the wall PLATE here. Since the roof raised by the rafter (roof.seat, 2026-10-06) the renderer
// has two heights, H the shell and Hplate the plate, and a loft reads only Hplate; `shell` (default: the
// plate, every building without a raised roof) is handed in as the renderer's H to prove it is not read.
function drawnElev(roofCfg: Any, W: number, L: number, H: number, shell: number = H) {
  const fn = new Function(
    "ssLoftPlateFt", "ssLoftElevFt", "D3_LOFT_PLATE_GAP", "itemTypes", "roofCfg", "bldgW", "bldgH", "H", "Hplate", "ftX", "ftZ",
    `${elevCmp}; return loftElevOf;`,
  );
  return fn(F.ssLoftPlateFt, F.ssLoftElevFt, F.D3_LOFT_PLATE_GAP, { loft: { width: 6, height: 4 } }, roofCfg, W, L, shell, H,
    (px: number) => px - W / 2, (py: number) => py - L / 2) as (it: Any) => number;
}
// A wall-to-wall loft at depth z (feet from the north wall), 4 ft deep, as a 2D or 3D click places it.
const loftAt = (W: number, zFt: number, extra: Any = {}) => ({ id: 1, type: "loft", x: W / 2, y: zFt, rotation: 0, wall: null, widthFt: W, heightFt: 4, ...extra });

const GABLE = { type: "gable", pitch: 0.4, overhang: 0.6 };

// ── (a) on the plate ────────────────────────────────────────────────────────────────────────

Deno.test("(a) a plate loft on a plain 12x24 gable sits on the 8 ft plate, and on 9 ft after a +12 in wall upgrade", () => {
  for (const H of [8, 9]) {
    const plate = F.ssLoftPlateFt(GABLE, 12, 24, H, 0, 0, 12, 4);
    assertEquals(plate, H);
    assertEquals(F.ssLoftElevFt({ onPlate: true }, plate), H);
    // Drawn a hair under, so it never shares the wall tops' plane.
    assertAlmostEquals(drawnElev(GABLE, 12, 24, H)(loftAt(12, 12, { onPlate: true })), H - 0.02, 1e-9);
  }
  assertEquals(F.D3_LOFT_PLATE_GAP, 0.02);
});

Deno.test("(a) shed and gambrel roofs: the plate loft is on the wall plate, H", () => {
  for (const roof of [{ type: "shed", pitch: 0.25 }, { type: "shed", highSide: "front", pitch: 0.25 }, { type: "gambrel" }, { type: "gambrel", front: "gable" }]) {
    for (const z of [2, 12, 22]) {
      assertEquals(F.ssLoftPlateFt(roof, 12, 24, 8, 0, z - 12, 12, 4), 8, `${JSON.stringify(roof)} z ${z}`);
      assertAlmostEquals(drawnElev(roof, 12, 24, 8)(loftAt(12, z, { onPlate: true })), 8 - 0.02, 1e-9);
    }
  }
});

// ── (b) legacy and custom ───────────────────────────────────────────────────────────────────

Deno.test("(b) a loft saved before the change stays at 5'6\", stamped or not; a custom height is kept, capped at the plate", () => {
  assertEquals(F.D3.LOFT_ELEV, 5.5);
  assertEquals(F.ssLoftElevFt({}, 8), 5.5, "neither key: the 26 unstamped lofts");
  assertEquals(F.ssLoftElevFt({ elevationFt: 5.5 }, 8), 5.5, "stamped 5.5: the 17 stamped lofts");
  assertEquals(F.ssLoftElevFt({ elevationFt: 7 }, 8), 7);
  assertEquals(F.ssLoftElevFt({ elevationFt: 9 }, 8), 8, "never above the plate");
  assertEquals(F.ssLoftElevFt({ elevationFt: 7.5 }, 7), 7, "a wall upgrade taken off brings it down with the walls");
  assertEquals(F.ssLoftElevFt({ elevationFt: 0 }, 8), 5.5, "a zero is no height (the old `|| D3.LOFT_ELEV`)");
  // Drawn exactly where the old renderer drew them: `it.elevationFt || D3.LOFT_ELEV`, no gap.
  const draw = drawnElev(GABLE, 12, 24, 8);
  assertEquals(draw(loftAt(12, 6)), 5.5);
  assertEquals(draw(loftAt(12, 6, { elevationFt: 5.5 })), 5.5);
  assertEquals(draw(loftAt(12, 6, { elevationFt: 7 })), 7);
  // A custom height AT the plate is drawn as the plate loft is: a hair under.
  assertAlmostEquals(draw(loftAt(12, 6, { elevationFt: 8 })), 7.98, 1e-9);
  assertAlmostEquals(draw(loftAt(12, 6, { elevationFt: 9 })), 7.98, 1e-9);
});

// ── (c) the roof step ───────────────────────────────────────────────────────────────────────

Deno.test("(c) a LOWER rear section: a loft reaching under it drops to that section's plate; one clear of it stays on H", () => {
  // The Black Cabin, 14 x 40 on 7.75 ft walls, with its rear 12 ft section's eave 0.75 ft LOWER.
  const CABIN = { type: "gable", front: "gable", pitch: 0.41, overhang: 1.3, eave: "fascia", porchDepthFt: 6, porchEnd: "front", porchTruss: true };
  const roof = { ...CABIN, rearStepFt: 12, rearEaveRiseFt: -0.75 };
  const H = 7.75, Hb = H - 0.75;
  assert(F.d3RoofStep(roof, 14, 40, H), "the step is on at this size");
  // Wholly under the rear section (z from the north wall 2..6), straddling the joint (10..14), clear (20..24).
  assertAlmostEquals(F.ssLoftPlateFt(roof, 14, 40, H, 0, 4 - 20, 14, 4), Hb, 1e-9);
  assertAlmostEquals(F.ssLoftPlateFt(roof, 14, 40, H, 0, 12 - 20, 14, 4), Hb, 1e-9, "a loft reaching INTO the lower rear rests on its plate");
  assertEquals(F.ssLoftPlateFt(roof, 14, 40, H, 0, 22 - 20, 14, 4), H);
  // An edge exactly on the joint reads the section it covers (the corner inset): 12..16 is clear of it.
  assertEquals(F.ssLoftPlateFt(roof, 14, 40, H, 0, 14 - 20, 14, 4), H);
  const draw = drawnElev(roof, 14, 40, H);
  assertAlmostEquals(draw(loftAt(14, 12, { onPlate: true })), Hb - 0.02, 1e-9);
  assertAlmostEquals(draw(loftAt(14, 22, { onPlate: true })), H - 0.02, 1e-9);
  // A custom 7'6" loft that reaches under the lower rear comes down to its plate, never into its roof.
  assertAlmostEquals(draw(loftAt(14, 12, { elevationFt: 7.5 })), Hb - 0.02, 1e-9);
  // A HIGHER rear section never lifts a loft that also covers the front: the lowest plate wins.
  const up = { ...CABIN, rearStepFt: 14, rearEaveRiseFt: 0.6 };
  assertEquals(F.ssLoftPlateFt(up, 14, 40, H, 0, 14 - 20, 14, 4), H);
  assertAlmostEquals(F.ssLoftPlateFt(up, 14, 40, H, 0, 3 - 20, 14, 4), H + 0.6, 1e-9, "wholly under the higher rear: its plate");
});

// ── (d) raised-centre wings ─────────────────────────────────────────────────────────────────

Deno.test("(d) a raised centre: a loft wholly under it sits on the centre's plate; one spanning into a wing on the wing's", () => {
  // wingsMassing_test's TRI: 24 x 28 on 9 ft walls, 8 ft wings each side, the centre's eave at 17 ft.
  const TRI = { type: "gable", pitch: 0.5, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 8, wingPitch: 0.25, centerEaveFt: 17 };
  const m = F.d3Massing(TRI, 24, 28, 9);
  assertEquals(m.Hc, 17);
  assertEquals(F.ssLoftPlateFt(TRI, 24, 28, 9, 0, 0, 8, 4), 17, "wall to wall across the centre's own 8 ft");
  assertEquals(F.ssLoftPlateFt(TRI, 24, 28, 9, 0, 0, 6, 4), 17);
  assertEquals(F.ssLoftPlateFt(TRI, 24, 28, 9, 0, 0, 24, 4), 9, "wall to wall across the whole building reaches the wings");
  assertEquals(F.ssLoftPlateFt(TRI, 24, 28, 9, 3, 0, 6, 4), 9, "one foot into a wing is into the wing");
  assertEquals(F.ssLoftPlateFt(TRI, 24, 28, 9, -8, 0, 8, 4), 9, "wholly under a wing");
  const draw = drawnElev(TRI, 24, 28, 9);
  assertAlmostEquals(draw({ id: 1, type: "loft", x: 12, y: 14, widthFt: 8, heightFt: 4, onPlate: true }), 17 - 0.02, 1e-9);
  assertAlmostEquals(draw({ id: 1, type: "loft", x: 12, y: 14, widthFt: 24, heightFt: 4, onPlate: true }), 9 - 0.02, 1e-9);
});

// ── (e) the rep's height pick ───────────────────────────────────────────────────────────────

Deno.test("(e) ssLoftWithHeight: null is the plate; at or over the plate is the plate with a note; under 4' is raised to 4'", () => {
  const base = { id: 7, type: "loft", x: 100, y: 80, widthFt: 12, heightFt: 4 };
  let r = F.ssLoftWithHeight({ ...base, elevationFt: 7 }, null, 8);
  assertEquals(r.item, { ...base, onPlate: true });
  assert(!("elevationFt" in r.item), "no elevationFt key on a plate loft");
  assertEquals(r.note, null);
  r = F.ssLoftWithHeight(base, 96, 8);
  assertEquals(r.item, { ...base, onPlate: true });
  assertEquals(r.note, "The walls are 8' tall, so the loft sits on the plate.");
  r = F.ssLoftWithHeight(base, 120, 7.5);
  assertEquals(r.item, { ...base, onPlate: true });
  assertEquals(r.note, "The walls are 7'6\" tall, so the loft sits on the plate.");
  r = F.ssLoftWithHeight({ ...base, onPlate: true }, 30, 8);
  assertEquals(r.item, { ...base, elevationFt: 4 });
  assert(!("onPlate" in r.item), "no onPlate key on a custom loft");
  assertEquals(r.note, "A loft floor is at least 4' off the floor.");
  r = F.ssLoftWithHeight({ ...base, onPlate: true }, 84, 8);
  assertEquals(r.item, { ...base, elevationFt: 7 });
  assert(!("onPlate" in r.item));
  assertEquals(r.note, null);
  r = F.ssLoftWithHeight(base, 90.4, 8);
  assertEquals(r.item.elevationFt, 7.5, "whole inches");
  assertEquals(F.SS_LOFT_MIN_IN, 48);
  // A NEW object, every time, and never both keys, whatever came in.
  const both = { ...base, onPlate: true, elevationFt: 6 };
  for (const h of [null, 30, 48, 60, 84, 95, 96, 200, "abc", NaN]) {
    const out = F.ssLoftWithHeight(both, h, 8);
    assert(out.item !== both);
    assert(!("onPlate" in out.item && "elevationFt" in out.item), `both keys for ${h}`);
    assert(out.item.onPlate === true || out.item.elevationFt > 0, `one key for ${h}`);
  }
  assertEquals(both.elevationFt, 6, "the loft handed in is not touched");
});

// ── (f) a ceiling fitting under a loft ──────────────────────────────────────────────────────

// The ceiling height buildElectrical3D hangs a fitting from (its cH), at plan feet (xFt, zFt) among
// `items`. The light's disc is drawn at cH - 0.06, 0.08 tall: cH - 0.10 .. cH - 0.02.
// `H` is the wall plate (Hplate in the renderer) and `shell` the renderer's H, as in drawnElev.
function hungAt(roofCfg: Any, W: number, L: number, H: number, shell: number = H) {
  const fn = new Function(
    "name", "g", "itemsNow", "itemTypes", "ftX", "ftZ", "loftElevOf", "D3", "d3CeilingFt", "roofCfg", "bldgW", "bldgH", "H", "Hplate",
    `${underCmp}; return cH;`,
  );
  const loftElevOf = drawnElev(roofCfg, W, L, H, shell);
  return (name: string, xFt: number, zFt: number, items: Any) =>
    fn(name, { position: { x: xFt - W / 2, z: zFt - L / 2 } }, items, { loft: { width: 6, height: 4 } },
      (px: number) => px - W / 2, (py: number) => py - L / 2, loftElevOf, F.D3, F.d3CeilingFt, roofCfg, W, L, shell, H) as number;
}

Deno.test("(f) a light under a plate loft hangs under the loft's floor, not inside it; a saved 5'6\" loft leaves it where it was", () => {
  const LOFT_T = F.D3.LOFT_T;
  for (const H of [8, 9]) {
    const hang = hungAt(GABLE, 12, 24, H);
    // A wall-to-wall plate loft over the north 4 ft (plan z 0..4), its floor top at the plate less 0.02.
    const plate = loftAt(12, 2, { onPlate: true });
    const top = H - 0.02, under = top - LOFT_T;
    const cH = hang("Light", 3, 2, [plate]);
    assertAlmostEquals(cH, under, 1e-9, `H ${H}: the light hangs from the loft's underside`);
    assert(cH - 0.02 <= top - LOFT_T + 1e-9, `H ${H}: the disc's top is at or under the platform's bottom`);
    assertAlmostEquals(hang("Ceiling Fan", 3, 2, [plate]), under, 1e-9, `H ${H}: so does a fan, its rod no longer through the floor`);
    // Clear of the loft: the plate, as before.
    assertEquals(hang("Light", 3, 12, [plate]), H, "a light under no loft");
    assertEquals(hang("Light", 3, 12, []), H, "no items at all");
    assertEquals(hang("Light", 3, 2, undefined), H, "no list handed in");
  }
  const hang = hungAt(GABLE, 12, 24, 8);
  // SAVED LOFTS DO NOT MOVE A LIGHT: one with no height, one stamped 5.5, both at 5'6".
  assertEquals(hang("Light", 3, 2, [loftAt(12, 2)]), 8);
  assertEquals(hang("Light", 3, 2, [loftAt(12, 2, { elevationFt: 5.5 })]), 8);
  assertEquals(hang("Ceiling Fan", 3, 2, [loftAt(12, 2, { elevationFt: 5.5 })]), 8);
  // A rep's 7'6" loft: under the light's disc (8 - 0.12), so the light stays at the plate over it; but
  // inside the fan's 0.75 ft, so the fan comes down under it.
  assertEquals(hang("Light", 3, 2, [loftAt(12, 2, { elevationFt: 7.5 })]), 8);
  assertAlmostEquals(hang("Ceiling Fan", 3, 2, [loftAt(12, 2, { elevationFt: 7.5 })]), 7.5 - LOFT_T, 1e-9);
  // The loft's edge: a light within its disc's 0.45 ft radius of it is under it, one further off is not;
  // a fan only by its rod.
  assertAlmostEquals(hang("Light", 3, 4.3, [loftAt(12, 2, { onPlate: true })]), 7.98 - LOFT_T, 1e-9);
  assertEquals(hang("Light", 3, 4.6, [loftAt(12, 2, { onPlate: true })]), 8);
  assertEquals(hang("Ceiling Fan", 3, 4.3, [loftAt(12, 2, { onPlate: true })]), 8);
  // Another item type is never a loft.
  assertEquals(hang("Light", 3, 2, [{ ...loftAt(12, 2, { onPlate: true }), type: "workbench" }]), 8);
});

// ── (g) a roof raised by the rafter (roof.seat, 2026-10-06) ─────────────────────────────────────
// The renderer's H becomes the SHELL, a rafter above the plate. A loft and a ceiling fitting stand on the
// walls, so both stay where they were: the shell handed in as H must not move either of them.
Deno.test("(g) under a roof raised by the rafter the loft and the ceiling light stay on the PLATE, not the shell", () => {
  const RAISED = { ...GABLE, seat: "raised", rafterDepthIn: 5.5 };
  const shell = 8 + 5.5 / 12;
  const elev = drawnElev(RAISED, 12, 24, 8, shell);
  assertAlmostEquals(elev(loftAt(12, 2, { onPlate: true })), 8 - F.D3_LOFT_PLATE_GAP, 1e-9, "a plate loft is on the 8 ft plate");
  assertAlmostEquals(elev(loftAt(12, 2, { elevationFt: 9 })), 8 - F.D3_LOFT_PLATE_GAP, 1e-9, "a set height is still capped at the plate, not the shell");
  const hang = hungAt(RAISED, 12, 24, 8, shell);
  assertEquals(hang("Light", 3, 12, []), 8, "the ceiling is the top of the walls");
});

Deno.test("(f) under a loft on a raised centre's plate, and under one that drops to a lower rear section", () => {
  const TRI = { type: "gable", pitch: 0.5, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 8, wingPitch: 0.25, centerEaveFt: 17 };
  const tri = hungAt(TRI, 24, 28, 9);
  const centre = { id: 1, type: "loft", x: 12, y: 14, widthFt: 8, heightFt: 4, onPlate: true };
  assertAlmostEquals(tri("Light", 12, 14, [centre]), 17 - 0.02 - F.D3.LOFT_T, 1e-9);
  assertEquals(tri("Light", 12, 24, [centre]), 17, "the same centre, clear of the loft");
  // The Black Cabin's lower rear: a loft straddling the joint rests on the rear plate (7 ft) everywhere.
  // Under its REAR half the light's own ceiling is that plate, so it hangs under the loft. Under its
  // FRONT half the ceiling is H, 0.77 ft over the loft's floor: the light stays up there, clear of the
  // floor (it lights the loft), and is never drawn inside the platform.
  const CABIN = { type: "gable", front: "gable", pitch: 0.41, overhang: 1.3, eave: "fascia", porchDepthFt: 6, porchEnd: "front", porchTruss: true, rearStepFt: 12, rearEaveRiseFt: -0.75 };
  const cab = hungAt(CABIN, 14, 40, 7.75);
  const straddle = [loftAt(14, 12, { onPlate: true })], floorTop = 7 - 0.02;
  assertAlmostEquals(cab("Light", 7, 10.5, straddle), floorTop - F.D3.LOFT_T, 1e-9, "under the rear half");
  const front = cab("Light", 7, 13.5, straddle);
  assertEquals(front, 7.75, "under the front half");
  assert(front - 0.10 > floorTop, "the disc's bottom is over the loft's floor");
});

// ── the wiring, in BOTH twins ───────────────────────────────────────────────────────────────

Deno.test("every placement writes onPlate and no number; every reader goes through the one computation", () => {
  for (const [name, src] of [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]] as const) {
    // The 2D click and the 3D palette both place a loft on the plate.
    const placed = src.match(/type: "loft", x: [^\n]*heightFt: loftH, ([a-zA-Z]+): ([^ }]+) \}/g) || [];
    assertEquals(placed.length, 2, `${name}: two loft creation sites`);
    for (const p of placed) assert(p.endsWith("onPlate: true }"), `${name}: ${p}`);
    assert(!src.includes("elevationFt: D3.LOFT_ELEV"), `${name}: no placement stamps the legacy number any more`);
    // D3.LOFT_ELEV is read in exactly one place in code: ssLoftElevFt's legacy branch.
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assertEquals((code.match(/D3\.LOFT_ELEV\b/g) || []).length, 1, `${name}: D3.LOFT_ELEV readers`);
    assert(!/it\.elevationFt \|\| D3/.test(src), `${name}: the old per-site fallback is gone`);
    // The renderer draws the platform at loftElevOf, and publishes it to the viewer.
    assert(src.includes("const elev = loftElevOf(it);"), `${name}: the platform`);
    assert(src.includes("model.loftElevFt = loftElevOf;"), `${name}: model.loftElevFt`);
    // The highlight box and the drag plane both read it. The drag takes it ONCE per gesture (the vent's
    // grab): a plate loft crossing a raised centre's or a roof step's line changes height, and a plane
    // re-read on every move flipped the loft back and forth across that line.
    assertEquals((src.match(/const elev = e\.model\.loftElevFt\(it\);/g) || []).length, 1, `${name}: the highlight`);
    assert(/if \(dragging3\.loftY == null\) dragging3\.loftY = e\.model\.loftElevFt\(it\);\n\s*dragPlane\.set\(new THREE\.Vector3\(0, 1, 0\), -dragging3\.loftY\);/.test(src),
      `${name}: the drag plane at the platform, taken once per gesture`);
    // A ceiling device is drawn with the whole list in hand, so it can hang under a loft.
    assertEquals((src.match(/if \(it\.electricalItemId\) \{ buildElectrical3D\(it, c, itemsNow\); return; \}/g) || []).length, 1, `${name}: buildInterior hands buildElectrical3D the items`);
    // The plan's toolbar: the rep designer only, beside the partition bar, reading the same plate.
    assert(src.includes('{selectedId && !planLocked && embedded && (() => {\n            const si = items.find((i) => i.id === selectedId);\n            if (!si || si.type !== "loft") return null;'), `${name}: the loft bar's gate`);
    // The PLATE, not the shell (roof.seat, 2026-10-06): ventRoof2D's Hplate and the renderer's Hplate.
    assert(src.includes("ssLoftPlateFt(vr.roof, bldgW, bldgH, vr.Hplate,"), `${name}: the plan's plate read`);
    assert(src.includes("ssLoftPlateFt(roofCfg, bldgW, bldgH, Hplate, ftX(it.x), ftZ(it.y),"), `${name}: the renderer's plate read`);
    assert(src.includes('data-ss-loft-height="1"'), `${name}: the inch field`);
  }
});
