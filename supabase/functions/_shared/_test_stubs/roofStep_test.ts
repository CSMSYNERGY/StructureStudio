// THE ROOF STEP — two roof sections along the ridge, tested against BOTH SHIPPED designer twins.
//
// roof.rearStepFt / roof.rearEaveRiseFt (2026-09-28): the rear section's roof starts at a joint
// rearStepFt from the BACK wall, its eave (wall plate and fascia) stands rearEaveRiseFt higher (or,
// negative, lower) than the front's, and the two ridges stay level. Everything about it that is not
// a mesh is pure module-scope code: d3RoofStep (whether there is a step on this building at this
// size, where, and the rear section's own pitch), d3WallTops / d3WallTopFt (the walls under the rear
// section stand at its eave), d3CeilingFt (a light hangs from the rear section's plate) and
// ssGableVentFit (a vent on the back wall fits the rear section's gable). They are lifted out of the
// source by stable anchors and run, the wingsMassing_test technique, and each lifted region is
// asserted byte-identical across the two hand-mirrored twins. The meshes themselves are proved on
// the compiled bundle by tests/harness/roofStep.mjs.
//
// The promise tested hardest: WITHOUT BOTH KEYS, NOTHING MOVES. Every function answers exactly what
// it answers for the same roof with the keys taken off, on every roof and size.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `roofStep_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  // d3RoofAxes, d3FrontKind, d3RoofProfile, d3MakeProfYAt, d3ProfSpanAt, d3Massing, d3RoofStep,
  // d3WallTops, d3WallTopFt, d3CeilingFt.
  ["function d3RoofAxes(", "function d3FtIn("],
  // ssGableEndWalls, ssPorchTrussWall, d3ProjectingPorch, ssGableVentFit and the vent constants.
  ["function ssVentSpan(", "function buildFixtureTools("],
];
const blocks = REGIONS.map(([a, b]) => ({ a, cmp: lift(CMP, "structure-studio.component.js", a, b), jsx: lift(JSX, "StructureStudio.jsx", a, b) }));

Deno.test("every lifted roof-step region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `const isVentItem = (it) => !!(it && it.isVent);\n${blocks.map((b) => b.cmp).join("\n")}; return { D3, d3RoofAxes, d3RoofProfile, d3RoofStep, ` +
    `d3WallTops, d3WallTopFt, d3CeilingFt, ssGableVentFit };`,
)() as Record<string, Any>;

// The Black Cabin, as measured: 14 ft wide by 40 ft deep, a gable front with a recessed 6 ft porch,
// 5:12 (0.41), 7.75 ft walls; the rear 14 ft has its own roof with its eave 0.6 ft higher.
const CABIN = { type: "gable", front: "gable", pitch: 0.41, overhang: 1.3, eave: "fascia", porchDepthFt: 6, porchEnd: "front", porchTruss: true };
const STEP = { rearStepFt: 14, rearEaveRiseFt: 0.6 };
const H = 7.75;
const peakOf = (dedup: number[][]) => dedup.reduce((m, p) => Math.max(m, p[1]), -Infinity);
const WALLS = ["north", "south", "east", "west"];

// ── ONE: no keys, no change ───────────────────────────────────────────────────────────────

Deno.test("⚠️ without both keys every function answers exactly what the roof without them answers", () => {
  const roofs = [CABIN, { type: "gable", pitch: 0.4 }, { type: "gambrel", front: "gable" }, { type: "shed", highSide: "front", pitch: 0.25 },
    { type: "gable", front: "eave", pitch: 0.5 }, { type: "gable", ridgeOffset: 0.2, plateBand: true }, { type: "gable", wingSide: "both", wingWidthFt: 6 }];
  const partial = [{}, { rearStepFt: 14 }, { rearEaveRiseFt: 0.6 }, { rearStepFt: 0, rearEaveRiseFt: 0.6 }, { rearStepFt: 14, rearEaveRiseFt: 0 },
    { rearStepFt: 0.4, rearEaveRiseFt: 1 }, { rearStepFt: "x", rearEaveRiseFt: 0.6 }, { rearStepFt: 14, rearEaveRiseFt: null }];
  let n = 0;
  for (const roof of roofs) {
    for (const keys of partial) {
      const withKeys = { ...roof, ...keys };
      for (const [W, L] of [[14, 40], [12, 16], [24, 12], [10, 8]]) {
        assertEquals(F.d3RoofStep(withKeys, W, L, H), null, `${JSON.stringify(withKeys)} ${W}x${L}`);
        for (const wall of WALLS) {
          assertEquals(F.d3WallTops(withKeys, W, L, H, wall), F.d3WallTops(roof, W, L, H, wall), `${wall} tops`);
          assertEquals(F.d3WallTopFt(withKeys, W, L, H, wall, 1, 3), F.d3WallTopFt(roof, W, L, H, wall, 1, 3));
          const vent = { widthIn: 12, heightIn: 8, widthFt: 1 };
          assertEquals(F.ssGableVentFit(withKeys, W, L, wall, H, vent, null, null), F.ssGableVentFit(roof, W, L, wall, H, vent, null, null), `${wall} vent`);
        }
        assertEquals(F.d3CeilingFt(withKeys, W, L, H, 0, -L / 2 + 1), F.d3CeilingFt(roof, W, L, H, 0, -L / 2 + 1));
        n++;
      }
    }
  }
  assert(n > 200, String(n));
});

Deno.test("⚠️ both keys draw no step where the renderer cannot: shed, gambrel, eave front, side-to-side ridge, wings, lean-to, back porch, no room", () => {
  const none: Array<[string, Record<string, unknown>, number, number]> = [
    ["a shed", { type: "shed", highSide: "front", pitch: 0.25, ...STEP }, 14, 40],
    ["a gambrel", { type: "gambrel", front: "gable", ...STEP }, 14, 40],
    ["an eave front", { ...CABIN, front: "eave", ...STEP }, 14, 40],
    ["an old-frame landscape size (the ridge runs side to side)", { type: "gable", pitch: 0.4, ...STEP }, 40, 14],
    ["wings", { ...CABIN, wingSide: "both", wingWidthFt: 4, ...STEP }, 14, 40],
    ["a lean-to", { ...CABIN, leanToWidthFt: 8, ...STEP }, 14, 40],
    ["a recessed porch at the back", { ...CABIN, porchEnd: "back", ...STEP }, 14, 40],
    ["a projecting porch at the back", { type: "gable", front: "gable", pitch: 0.4, porchOutFt: 6, porchEnd: "back", ...STEP }, 14, 40],
    ["no room for 4 ft each side of the joint", { ...CABIN, ...STEP }, 14, 13],
    ["no type at all", { pitch: 0.4, ...STEP }, 14, 40],
  ];
  for (const [what, roof, W, L] of none) {
    assertEquals(F.d3RoofStep(roof, W, L, H), null, what);
    for (const wall of WALLS) {
      const bare = { ...roof };
      delete bare.rearStepFt; delete bare.rearEaveRiseFt;
      assertEquals(F.d3WallTops(roof, W, L, H, wall), F.d3WallTops(bare, W, L, H, wall), `${what}: ${wall}`);
    }
  }
});

// ── TWO: the Black Cabin's numbers ────────────────────────────────────────────────────────

Deno.test("the Black Cabin: the rear 14 ft steps 0.6 ft up at 0.324, and its ridge meets the front's", () => {
  const st = F.d3RoofStep({ ...CABIN, ...STEP }, 14, 40, H);
  assert(st, "a step");
  assertEquals(st.stepFt, 14);
  assertEquals(st.rise, 0.6);
  assertEquals(st.Hf, H);
  assertAlmostEquals(st.Hb, 8.35, 1e-12);
  assertAlmostEquals(st.pitchB, 0.41 - 0.6 / 7, 1e-12);
  assertEquals(st.rearCfg.pitch, st.pitchB);
  assertEquals(st.rearCfg.porchTruss, true, "the rest of the roof rides along");
  // ⚠️ THE RIDGES ARE LEVEL, whatever the rise, the width or a saltbox's offset ridge.
  for (const [roof, W, L, rise] of [[CABIN, 14, 40, 0.6], [CABIN, 14, 40, -1.2], [{ type: "gable", front: "gable", pitch: 0.5, ridgeOffset: 0.2 }, 20, 36, 1.1], [{ type: "gable", pitch: 0.33 }, 10, 24, 0.4]] as const) {
    const s = F.d3RoofStep({ ...roof, rearStepFt: 10, rearEaveRiseFt: rise }, W, L, H);
    const ax = F.d3RoofAxes(roof, W, L);
    const front = F.d3RoofProfile(roof, ax.S, H, ax.tallNeg).dedup, rear = F.d3RoofProfile(s.rearCfg, ax.S, s.Hb, ax.tallNeg).dedup;
    assertAlmostEquals(peakOf(rear), peakOf(front), 1e-9, `${JSON.stringify(roof)} rise ${rise}`);
    // Same ridge line, same span: the rear profile's eave points are the rise up (or down).
    assertAlmostEquals(rear[0][1] - front[0][1], rise, 1e-12);
    assertAlmostEquals(rear[1][0], front[1][0], 1e-12);
  }
});

Deno.test("the walls under the rear section stand at its eave, one plane with the front walls", () => {
  const roof = { ...CABIN, ...STEP };
  // Along each long wall from its north end: the rear eave for the back 14 ft, H in front of it.
  for (const wall of ["west", "east"]) assertEquals(F.d3WallTops(roof, 14, 40, H, wall), [[0, 14, H + 0.6], [14, 40, H]]);
  assertEquals(F.d3WallTops(roof, 14, 40, H, "north"), [[0, 14, H + 0.6]], "the back gable wall, end to end");
  assertEquals(F.d3WallTops(roof, 14, 40, H, "south"), null, "the front wall is H");
  // What an opening may reach, and what a corner board stands to.
  assertEquals(F.d3WallTopFt(roof, 14, 40, H, "west", 3, 6), H + 0.6);
  assertEquals(F.d3WallTopFt(roof, 14, 40, H, "west", 20, 23), H);
  assertEquals(F.d3WallTopFt(roof, 14, 40, H, "west", 12, 16), H, "a window across the joint stays under the lower plate");
  assertEquals(F.d3WallTopFt(roof, 14, 40, H, "west", 0, 0), H + 0.6, "the back corner");
  assertEquals(F.d3WallTopFt(roof, 14, 40, H, "west", 40, 40), H, "the front corner");
  assertEquals(F.d3WallTopFt(roof, 14, 40, H, "north"), H + 0.6);
  // A lower rear: the walls step DOWN behind the joint.
  assertEquals(F.d3WallTops({ ...CABIN, rearStepFt: 12, rearEaveRiseFt: -0.75 }, 14, 40, H, "east"), [[0, 12, H - 0.75], [12, 40, H]]);
  // A light hangs from the plate over it.
  assertEquals(F.d3CeilingFt(roof, 14, 40, H, 0, -20 + 13.9), H + 0.6);
  assertEquals(F.d3CeilingFt(roof, 14, 40, H, 0, -20 + 14.1), H);
});

Deno.test("the clamps: 4 ft each side of the joint (4 ft of room in front of a recessed porch), a rise of 1.5 ft and a rear pitch of 0.02", () => {
  const at = (roof: Record<string, unknown>, W: number, L: number) => F.d3RoofStep(roof, W, L, H);
  assertEquals(at({ ...CABIN, rearStepFt: 2, rearEaveRiseFt: 0.6 }, 14, 40).stepFt, 4, "4 ft behind the joint");
  assertEquals(at({ ...CABIN, rearStepFt: 50, rearEaveRiseFt: 0.6 }, 14, 40).stepFt, 30, "40 less the 6 ft porch less 4 ft of room");
  assertEquals(at({ type: "gable", front: "gable", pitch: 0.41, rearStepFt: 50, rearEaveRiseFt: 0.6 }, 14, 40).stepFt, 36, "no porch: 40 less 4");
  assertEquals(at({ type: "gable", front: "gable", pitch: 0.41, rearStepFt: 50, rearEaveRiseFt: 0.6, porchOutFt: 6 }, 14, 40).stepFt, 36, "a projecting porch takes none of the depth");
  assertEquals(at({ type: "gable", front: "gable", pitch: 0.41, rearStepFt: 5, rearEaveRiseFt: 0.6 }, 14, 8).stepFt, 4, "an 8 ft building: 4 and 4");
  assertEquals(at({ ...CABIN, rearStepFt: 14, rearEaveRiseFt: 3 }, 14, 40).rise, 1.5);
  assertEquals(at({ ...CABIN, rearStepFt: 14, rearEaveRiseFt: -3 }, 14, 40).rise, -1.5);
  // A shallow roof cannot carry a big rise at its own pitch: cut back to leave the rear roof 0.02.
  const flat = at({ type: "gable", front: "gable", pitch: 0.1, rearStepFt: 10, rearEaveRiseFt: 1 }, 14, 30);
  assertAlmostEquals(flat.rise, (0.1 - 0.02) * 7, 1e-12);
  assertAlmostEquals(flat.pitchB, 0.02, 1e-12);
  // ...but never turned round, and a lower rear on the same roof is untouched.
  assertEquals(at({ type: "gable", front: "gable", pitch: 0.01, rearStepFt: 10, rearEaveRiseFt: 1 }, 14, 30), null);
  assertEquals(at({ type: "gable", front: "gable", pitch: 0.1, rearStepFt: 10, rearEaveRiseFt: -1 }, 14, 30).rise, -1);
  // The new frame's gable front runs the ridge front to back on a WIDE front too.
  assertEquals(at({ type: "gable", front: "gable", pitch: 0.4, rearStepFt: 10, rearEaveRiseFt: 0.5 }, 40, 24).stepFt, 10);
});

Deno.test("a vent on the back wall is fitted to the rear section's gable, on its plate", () => {
  const roof = { ...CABIN, ...STEP };
  const vent = { widthIn: 12, heightIn: 8, widthFt: 1 };
  const back = F.ssGableVentFit(roof, 14, 40, "north", H, vent, null, null);
  const bare = F.ssGableVentFit(CABIN, 14, 40, "north", H, vent, null, null);
  assert(back && bare, "both fit");
  assertAlmostEquals(back.y0 - bare.y0, 0.6, 1e-12, "the rise up");
  // The front wall's gable is the front section's, exactly as before.
  assertEquals(F.ssGableVentFit(roof, 14, 40, "south", H, vent, null, null), F.ssGableVentFit(CABIN, 14, 40, "south", H, vent, null, null));
  // The rear gable is the smaller one when the rear eave is higher, so a vent that fits the front's
  // can fail to fit the rear's, and says so (null) rather than poking through a rake.
  const big = { widthIn: 24, heightIn: 8, widthFt: 2 };
  const steep = { type: "gable", front: "gable", pitch: 0.3, rearStepFt: 10, rearEaveRiseFt: 1.2 };
  assert(F.ssGableVentFit({ type: "gable", front: "gable", pitch: 0.3 }, 14, 30, "north", H, big, null, null), "fits the full gable");
  assertEquals(F.ssGableVentFit(steep, 14, 30, "north", H, big, null, null), null);
});
