// GROUND THAT FALLS AWAY (top-level gradeFallFt / gradeFallToward, 2026-09-28), tested against BOTH
// SHIPPED designer twins.
//
// Carolyn, 09-28, on the Tri Home: "these piers are, like, deeper here". floorHeightFt stays the height
// at the FRONT (the uphill side); gradeFallFt is how much LOWER the ground is at the far side of the
// footprint, toward gradeFallToward (back, left or right; absent is back), so the supports there stand
// that much taller. d3GradeAt is the depth of the ground anywhere, and everything that stands on the
// ground reads it: the supports, the porch's deck supports and steps (d3PorchStepsGradeFt, through
// d3PorchToRoot), a lean-to's posts, a ramp, the cameras (d3GradeLiftFt, from the deepest ground).
// Each pure piece is lifted out of the source by stable anchors and run (the raisedFloor_test
// technique), and every lifted region is asserted byte-identical across the two hand-mirrored twins.
// The meshes are checked in tests/harness/gradeFall.mjs, which also holds level ground to the
// previous designer's scene node for node.
//
// The other half is the promise that makes it safe to ship: without a fall -- every row stored before
// today, a fall of 0, a fall on a slab -- every number here is exactly d3GradeFt's.

import { assert, assertAlmostEquals, assertEquals, assertStringIncludes } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `gradeFall_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const RENDER: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_STYLE_DEFAULTS = {", "// ── CLADDING ──"],
  // D3_CLADDING and d3CladdingFor: the corner boards' face the recessed porch's posts stand on (2026-10-07).
  ["const D3_CLADDING = {", "// ── METAL ROOF PROFILE"],
  ["function d3RoofAxes(", "function d3FtIn("],
  ["function ssPorchTrussWall(", "// Where a vent sits in the gable above"],
  ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  ["function d3PorchGeom(", "function d3PorchReadout("],
  ["function d3PorchReadout(", "// A dimensioned end-elevation of the style"],
  ["function d3ResolveStyleSpec(", "// Carolyn (2026-07-02): horizontal lap siding"],
  ["function d3DefaultShotCamera(", "// A default 3/4 view of the building"],
  ["const SS_SHOT = {", "// Render the draft the builder just paid for"],
];
// The calibration panel's pure half: "What we drew" and the shot signature.
const PANEL: Array<[string, string]> = [
  ["function d3FtIn(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  ["const SS_RENDER_MS =", "// Upload a list with BOUNDED CONCURRENCY"],
];
// The panel's tidy-up and the video draft's merge, which live inside the component.
const CAL: Array<[string, string]> = [
  ["const CAL_RAISED_ONLY = ", "  const calSetFoundation"],
  ["const calFloorFromFront = ", "  const applyDraftedShape"],
];
const liftAll = (regions: Array<[string, string]>) => regions.map(([a, b]) => ({
  a,
  cmp: lift(CMP, "structure-studio.component.js", a, b),
  jsx: lift(JSX, "StructureStudio.jsx", a, b),
}));
const renderBlocks = liftAll(RENDER), panelBlocks = liftAll(PANEL), calBlocks = liftAll(CAL);

Deno.test("every lifted ground-fall region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of [...renderBlocks, ...panelBlocks, ...calBlocks]) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `${renderBlocks.map((b) => b.cmp).join("\n")}; return { D3, D3_GRADE_FALL_TOWARD, d3GradeFt, d3GradeLiftFt, d3GradeMaxFt, d3GradeFall, d3GradeFallAxis, ` +
    `d3GradeFallBlendFt, d3GradeAt, d3FrameHeightFt, d3PorchToRoot, d3PorchStepsGradeFt, d3PorchStepsGeom, d3PorchGeom, d3PorchFraming, ` +
    `d3PorchReadout, d3ResolveStyleSpec, d3DefaultShotCamera, ssSelfCheckCameras, D3_FOUNDATIONS, d3RaisedFoundation, ` +
    `d3FloorHeightFromFront, d3FrontGableWall, SS_SHOT, d3PorchBlankStepCount, d3PorchAutoStepCount, ` +
    `D3_GRADE_CORNERS, d3GradeCornersGiven, d3GradeCorners, d3GradeDropAt, d3GradeEaseFt, d3SlopeFoundation, d3PorchStepsOnGround, ` +
    `d3RecessedPorch, d3RecessedPorchFrame, d3RecessedPorchToRoot, d3RecessedStepsOnGround, d3RecessedPorchReadout, D3_PORCH_SIDE_STEPS_MIN_FT, ` +
    `D3_RECESSED_SIDE_STEPS_MIN_FT, d3CornerFaceFt };`,
)() as Record<string, Any>;
// "What we drew" reads the porch region's shallowest deck for a side flight (2026-10-04), and its shallowest
// recessed porch for one off an open side (2026-10-07), handed in here.
const P = new Function(
  `const D3_PORCH_SIDE_STEPS_MIN_FT = ${F.D3_PORCH_SIDE_STEPS_MIN_FT};\nconst D3_RECESSED_SIDE_STEPS_MIN_FT = ${F.D3_RECESSED_SIDE_STEPS_MIN_FT};\n` +
    `${panelBlocks.map((b) => b.cmp).join("\n")}; return { ssDrewWords, ssShotSig };`,
)() as Record<string, Any>;
// calDraftRoof is the roof half of the merge (calDraftRoof_test's); a plain spread stands in for it.
// bldgW x bldgH is the calibration preview's footprint, the component's own state.
const C = new Function(
  "calDraftRoof", "D3_FOUNDATIONS", "d3RaisedFoundation", "d3GradeFall", "d3FloorHeightFromFront", "bldgW", "bldgH", "d3GradeCorners",
  `${calBlocks.map((b) => b.cmp).join("\n")}; return { calTidyFloor, calShapeMerged, CAL_RAISED_ONLY };`,
)((s: Any, d: Any) => ({ ...(s || {}), ...(d || {}) }), F.D3_FOUNDATIONS, F.d3RaisedFoundation, F.d3GradeFall, F.d3FloorHeightFromFront, 16, 24, F.d3GradeCorners) as Record<string, Any>;

const PIERS = { roof: { type: "gable", pitch: 0.4 }, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5 };
const W = 16, L = 24;
// A lattice over the footprint and well past it.
const LATTICE: Array<[number, number]> = [];
for (let x = -30; x <= 30; x += 2.5) for (let z = -30; z <= 30; z += 2.5) LATTICE.push([x, z]);

// ── LEVEL GROUND IS d3GradeFt, EXACTLY ─────────────────────────────────────────────────────

Deno.test("no fall: d3GradeAt is d3GradeFt at every point, and the cameras' lift is what it was", () => {
  const specs = [
    undefined, null, {}, { foundation: "slab" }, { foundation: "skids" }, PIERS, { ...PIERS, foundation: "blocks", floorHeightFt: 1.1 },
    // A fall that is not one: 0, negative, junk, and on a floor that is not raised.
    { ...PIERS, gradeFallFt: 0 }, { ...PIERS, gradeFallFt: -2 }, { ...PIERS, gradeFallFt: "abc" }, { ...PIERS, gradeFallFt: null },
    { ...PIERS, gradeFallToward: "left" }, { foundation: "slab", gradeFallFt: 2, gradeFallToward: "back" }, { gradeFallFt: 3 },
  ];
  for (const spec of specs) {
    assertEquals(F.d3GradeFall(spec), null, JSON.stringify(spec));
    for (const [x, z] of LATTICE) assertEquals(F.d3GradeAt(spec, W, L, x, z), F.d3GradeFt(spec), `${JSON.stringify(spec)} at ${x}, ${z}`);
    assertEquals(F.d3GradeMaxFt(spec), F.d3GradeFt(spec));
    assertEquals(F.d3GradeLiftFt(spec), F.d3GradeFt(spec) - F.D3.FLOOR_T);
  }
  // raisedFloor_test's numbers, through the new path.
  assertEquals(F.d3GradeLiftFt({ foundation: "slab" }), 0);
  assertAlmostEquals(F.d3GradeLiftFt({ foundation: "blocks", floorHeightFt: 1.1 }), 0.75, 1e-12);
});

// ── THE SHAPE OF THE GROUND ───────────────────────────────────────────────────────────────────

Deno.test("d3GradeAt: the front grade along the uphill edge, the fall along the far edge, a straight line between", () => {
  const cases: Array<[string, (t: number, c: number) => [number, number], number]> = [
    // [toward, (t down the fall from the uphill edge in feet, c across) -> (x, z), extent]
    ["back", (t, c) => [c, L / 2 - t], L],
    ["left", (t, c) => [W / 2 - t, c], W],
    ["right", (t, c) => [t - W / 2, c], W],
  ];
  for (const [toward, at, D] of cases) {
    const spec = { ...PIERS, gradeFallFt: 2, gradeFallToward: toward };
    assertEquals(F.d3GradeFall(spec), { fallFt: 2, toward });
    for (const c of [-7, 0, 3.3, 12]) {
      assertEquals(F.d3GradeAt(spec, W, L, ...at(0, c)), 1.5, `${toward}: the uphill edge is the front grade`);
      assertAlmostEquals(F.d3GradeAt(spec, W, L, ...at(D, c)), 3.5, 1e-12, `${toward}: the far edge is the grade plus the fall`);
      for (const t of [0.5, D / 4, D / 2, 0.9 * D]) {
        assertAlmostEquals(F.d3GradeAt(spec, W, L, ...at(t, c)), 1.5 + (2 * t) / D, 1e-12, `${toward}: straight at ${t}`);
      }
    }
    // Level past the blend, either side, and the ease a hair over and under the edge grades.
    const B = F.d3GradeFallBlendFt(2, D);
    assertEquals(B, 2);
    const before = F.d3GradeAt(spec, W, L, ...at(-B - 0.001, 0)), after = F.d3GradeAt(spec, W, L, ...at(D + B + 0.001, 0));
    for (const t of [-B - 1, -B - 10, -40]) assertEquals(F.d3GradeAt(spec, W, L, ...at(t, 5)), before, `${toward}: level in front at ${t}`);
    for (const t of [D + B + 1, D + B + 10, D + 40]) assertEquals(F.d3GradeAt(spec, W, L, ...at(t, -5)), after, `${toward}: level past the far side at ${t}`);
    assertAlmostEquals(before, 1.5 - (2 * B) / (2 * D), 1e-12);
    assertAlmostEquals(after, 3.5 + (2 * B) / (2 * D), 1e-12);
    // No crease: the slope runs smoothly from 0 to fall / D across each blend, never jumping.
    const slope = (t: number) => (F.d3GradeAt(spec, W, L, ...at(t + 1e-5, 0)) - F.d3GradeAt(spec, W, L, ...at(t - 1e-5, 0))) / 2e-5;
    for (const e of [0, D]) assertAlmostEquals(slope(e), 2 / D, 1e-6, `${toward}: the slope at the edge ${e} is the footprint's`);
    for (const e of [-B, D + B]) assertAlmostEquals(slope(e), 0, 1e-6, `${toward}: level where the blend ends (${e})`);
    let prev = -Infinity, prevSlope = slope(-B - 1);
    for (let t = -B - 1; t <= D + B + 1; t += 0.05) {
      const y = F.d3GradeAt(spec, W, L, ...at(t, 0)), s = slope(t);
      assert(y >= prev - 1e-12, `${toward}: never rises going down the fall (${t})`);
      assert(Math.abs(s - prevSlope) < 0.01, `${toward}: the slope changes gradually (${t})`);
      prev = y; prevSlope = s;
    }
  }
});

Deno.test("d3GradeAt: absent direction is back; the fall held to 6 ft; a steep fall levels off within 3 in", () => {
  const noDir = { ...PIERS, gradeFallFt: 2 };
  assertEquals(F.d3GradeFall(noDir), { fallFt: 2, toward: "back" });
  assertEquals(F.d3GradeFall({ ...noDir, gradeFallToward: "Back" }).toward, "back", "junk is back too");
  assertAlmostEquals(F.d3GradeAt(noDir, W, L, 0, -L / 2), 3.5, 1e-12, "the north (back) edge");
  assertEquals(F.d3GradeFall({ ...PIERS, gradeFallFt: 9 }).fallFt, 6);
  assertEquals(F.d3GradeFall({ ...PIERS, gradeFallFt: "2.5" }).fallFt, 2.5);
  assertEquals([...F.D3_GRADE_FALL_TOWARD], ["back", "left", "right"], "the sanitiser's D3_GRADE_FALL_TOWARD");
  // 6 ft over an 8 ft width: the blend shortens so the ease stays within 3 in of the edge grades.
  const steep = { ...PIERS, gradeFallFt: 6, gradeFallToward: "right" };
  const B = F.d3GradeFallBlendFt(6, 8);
  assertAlmostEquals(B, 2 / 3, 1e-12);
  assertAlmostEquals(F.d3GradeAt(steep, 8, 12, -20, 0), 1.5 - 0.25, 1e-12);
  assertAlmostEquals(F.d3GradeAt(steep, 8, 12, 20, 0), 1.5 + 6 + 0.25, 1e-12);
  // Blocks fall the same way from their own front height.
  const blocks = { foundation: "blocks", floorHeightFt: 1.1, gradeFallFt: 1.5, gradeFallToward: "left" };
  assertAlmostEquals(F.d3GradeAt(blocks, 16, 10, -8, 0), 2.6, 1e-12);
  assertAlmostEquals(F.d3GradeMaxFt(blocks), 2.6, 1e-12);
});

// ── THE CAMERAS FRAME FROM THE DEEPEST GROUND ───────────────────────────────────────────────

Deno.test("the cameras: a fall is framed as a building raised to its deepest ground", () => {
  const fall = { ...PIERS, gradeFallFt: 2, gradeFallToward: "back" };
  const deep = { ...PIERS, floorHeightFt: 3.5 };
  assertAlmostEquals(F.d3GradeLiftFt(fall), 3.5 - 0.35, 1e-12);
  assertEquals(F.d3FrameHeightFt(fall, W, L), F.d3FrameHeightFt(deep, W, L));
  assertEquals(JSON.stringify(F.d3DefaultShotCamera({ bldgW: W, bldgH: L, frontWall: "south", style3d: fall })),
    JSON.stringify(F.d3DefaultShotCamera({ bldgW: W, bldgH: L, frontWall: "south", style3d: deep })));
});

// The review of 2026-09-29: the self-check's eye came down by the DEEPEST ground too, so a phone
// filming from the uphill side was drawn feet too low, and on a 6 ft fall under the grass (0.6 ft
// below it). Its eye is the phone's: SS_SHOT.EYE_FT over y = -FLOOR_T on level ground, which is
// EYE_FT + FLOOR_T over the grass, and on falling ground that is measured from the grass the camera
// stands on. The framing (the aim, the base points) stays on the deepest ground.
const WALK_MAP = {
  front: { frame: 1, azimuthDeg: 0 }, side: { frame: 2, azimuthDeg: 90 }, corner: { frame: 3, azimuthDeg: 45 },
  back: { frame: 4, azimuthDeg: 180 }, otherSide: { frame: 5, azimuthDeg: 270 }, eaveCorner: { frame: 6, azimuthDeg: 30 },
};
const eyeOverGrass = (spec: Any, w: number, l: number, c: Any) => c.eye[1] + F.d3GradeAt(spec, w, l, c.eye[0], c.eye[2]);

Deno.test("the self-check's eye stands EYE_FT over the grass under it, uphill and downhill, on every fall", () => {
  const want = F.SS_SHOT.EYE_FT + F.D3.FLOOR_T;
  // Level ground: the numbers they always were (eye = EYE_FT - lift), EYE_FT + FLOOR_T over the grass.
  for (const spec of [PIERS, { ...PIERS, gradeFallFt: 0, gradeFallToward: "left" }, { foundation: "slab", gradeFallFt: 3 }]) {
    const cams = F.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: spec }, WALK_MAP);
    assertEquals(cams.length, 6);
    for (const c of cams.filter((q: Any) => q.viewpoint !== "eaveCorner")) {
      assertEquals(c.eye[1], F.SS_SHOT.EYE_FT - F.d3GradeLiftFt(spec), `${JSON.stringify(spec)} ${c.viewpoint}`);
      assertAlmostEquals(eyeOverGrass(spec, W, L, c), want, 1e-12);
    }
  }
  assertEquals(JSON.stringify(F.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: { ...PIERS, gradeFallFt: 0 } }, WALK_MAP)),
    JSON.stringify(F.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: PIERS }, WALK_MAP)), "a fall of 0 is level ground, byte for byte");
  // Falling ground, every direction, up to the sanitiser's 6 ft, on big, small and landscape footprints.
  for (const [w, l] of [[16, 24], [8, 12], [24, 12]]) {
    for (const toward of ["back", "left", "right"]) {
      for (const fallFt of [0.5, 2, 4, 6]) {
        const spec = { ...PIERS, gradeFallFt: fallFt, gradeFallToward: toward };
        const cams = F.ssSelfCheckCameras({ bldgW: w, bldgH: l, style3d: spec }, WALK_MAP);
        const level = F.ssSelfCheckCameras({ bldgW: w, bldgH: l, style3d: PIERS }, WALK_MAP);
        const lf = F.d3GradeLiftFt(spec), lf0 = F.d3GradeLiftFt(PIERS);
        const tag = `${w}x${l} ${fallFt} ft ${toward}`;
        assertEquals(cams.length, 6, tag);
        for (const [i, c] of cams.entries()) {
          if (c.viewpoint === "eaveCorner") {
            assertEquals(JSON.stringify(c), JSON.stringify(level[i]), `${tag}: the eave close-up never read the ground`);
            continue;
          }
          assertAlmostEquals(eyeOverGrass(spec, w, l, c), want, 1e-5, `${tag} ${c.viewpoint}: the eye over the grass under it`);
          // The aim is the deepest ground's: 0.45 of the way up from it, the same peak as on level ground.
          assertAlmostEquals((c.at[1] + lf) / 0.45 - lf, (level[i].at[1] + lf0) / 0.45 - lf0, 1e-9, `${tag} ${c.viewpoint}: the same peak framed`);
          assert(c.at[1] < level[i].at[1], `${tag} ${c.viewpoint}: aimed lower than on level ground`);
        }
      }
    }
  }
  // The reviewer's case: 6 ft falling to the back, filmed from the front (uphill), where the eye was
  // 0.6 ft UNDER the grass. It is the phone's height over the level ground in front now.
  const steep = { ...PIERS, gradeFallFt: 6, gradeFallToward: "back" };
  const front = F.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: steep }, WALK_MAP).find((c: Any) => c.viewpoint === "front");
  assert(front.eye[2] > L / 2 + 2, "the front camera stands past the uphill edge's blend");
  assertAlmostEquals(front.eye[1], F.SS_SHOT.EYE_FT - (F.d3GradeAt(steep, W, L, 0, 1000) - F.D3.FLOOR_T), 1e-5);
  assert(front.eye[1] > F.SS_SHOT.EYE_FT - F.d3GradeLiftFt(steep) + 5, "about the fall higher than the deepest ground's eye");
});

// ── THE PORCH'S FRAME AND ITS STEPS ─────────────────────────────────────────────────────────

Deno.test("d3PorchToRoot: the porch's frame (x to the viewer's right, d out from the wall) in the building's", () => {
  assertEquals(F.d3PorchToRoot({ type: "gable", pitch: 0.4 }, W, L), null, "no porch");
  const near = (a: number[], b: number[]) => assert(Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12, `${a} vs ${b}`);
  // New frame, gable end in front: the porch on the south wall, or the north with porchEnd back.
  const south = F.d3PorchToRoot({ type: "gable", front: "gable", porchOutFt: 6 }, W, L);
  near(south(0, 0), [0, 12]); near(south(1, 0), [1, 12]); near(south(0, 2), [0, 14]);
  const north = F.d3PorchToRoot({ type: "gable", front: "gable", porchOutFt: 6, porchEnd: "back" }, W, L);
  near(north(0, 0), [0, -12]); near(north(1, 0), [-1, -12]); near(north(0, 2), [0, -14]);
  // An eave wall in front (a shed's high side): the south wall of a 16x10, its middle.
  const eave = F.d3PorchToRoot({ type: "shed", highSide: "front", porchOutFt: 4 }, 16, 10);
  near(eave(0, 0), [0, 5]); near(eave(2, 1), [2, 6]);
  // The old frame on a landscape gable: "front" is the WEST end wall; the viewer's right is +z.
  const west = F.d3PorchToRoot({ type: "gable", pitch: 0.4, porchOutFt: 5 }, 24, 12);
  near(west(0, 0), [-12, 0]); near(west(1, 0), [-12, 1]); near(west(0, 3), [-15, 0]);
  const east = F.d3PorchToRoot({ type: "gable", pitch: 0.4, porchOutFt: 5, porchEnd: "back" }, 24, 12);
  near(east(1, 2), [14, -1]);
});

Deno.test("d3PorchStepsGradeFt: d3GradeFt on level ground; with a fall, the deepest ground under the flight", () => {
  const roof = { type: "gable", front: "gable", pitch: 0.4, porchOutFt: 6, porchSteps: "center" };
  const readout = (spec: Any) => F.d3PorchReadout(spec, `${W}x${L}`);
  // Level: exactly the grade, whatever stepsAt would say.
  for (const spec of [{ ...PIERS, roof }, { ...PIERS, roof, gradeFallFt: 0 }, { roof, foundation: "slab", gradeFallFt: 2 }]) {
    assertEquals(F.d3PorchStepsGradeFt(spec, W, L, () => { throw new Error("not asked on level ground"); }), F.d3GradeFt(spec));
    assertEquals(readout(spec).steps.grade, -F.d3GradeFt(spec));
  }
  // The porch on the back wall and the ground falling to the back: past the far edge, the lower level.
  const back = { ...PIERS, roof: { ...roof, porchEnd: "back" }, gradeFallFt: 2, gradeFallToward: "back" };
  const rb = readout(back);
  const h = -rb.steps.grade;
  assert(h > 3.5 && h <= 3.5 + 0.25 + 1e-12, `deeper than the far edge, by no more than the ease: ${h}`);
  assertEquals(rb.steps.count, Math.max(1, Math.ceil(h / 0.625 - 1e-9)));
  assert(rb.steps.rise <= 7.5 / 12 + 1e-12);
  // It is its own answer: the deepest ground under the flight it sets.
  const toRoot = F.d3PorchToRoot(back.roof, W, L);
  const s = rb.steps;
  let deep = -Infinity;
  for (const x of [s.x - s.w / 2, s.x + s.w / 2]) for (const d of [s.d0, s.d0 + s.count * s.tread]) deep = Math.max(deep, F.d3GradeAt(back, W, L, ...toRoot(x, d)));
  assertAlmostEquals(deep, h, 1e-12);
  // The porch on the FRONT, uphill: the ground in front is level, a hair above the front grade.
  const front = { ...PIERS, roof, gradeFallFt: 2, gradeFallToward: "back" };
  const hf = -readout(front).steps.grade;
  assert(hf < 1.5 && hf >= 1.5 - 0.25, `uphill steps: ${hf}`);
  // Across the fall: steps on the downhill side of a front porch stand deeper than those uphill.
  const leftSteps = { ...PIERS, roof: { ...roof, porchSteps: "left" }, gradeFallFt: 2, gradeFallToward: "left" };
  const rightSteps = { ...leftSteps, roof: { ...roof, porchSteps: "right" } };
  assert(-readout(leftSteps).steps.grade > -readout(rightSteps).steps.grade + 0.5, "left steps, falling left: deeper");
  // Nothing else in the readout moves: the porch's roof and posts are measured from the floor.
  const flat = readout({ ...PIERS, roof: { ...roof, porchEnd: "back" } });
  for (const k of ["pitch", "yHigh", "postH", "posts", "D", "wall", "S"]) assertEquals(rb[k], flat[k], k);
});

Deno.test("d3FloorHeightFromFront: a reading at the front wall's middle, as the uphill edge's height", () => {
  const at = (roof: Any, toward: Any, w: number, l: number, fh = 3) =>
    F.d3FloorHeightFromFront({ ...PIERS, roof, gradeFallFt: 2, ...(toward ? { gradeFallToward: toward } : {}) }, w, l, fh);
  const nf = { type: "gable", front: "gable", pitch: 0.4 };
  // Level ground and a slab: the reading, exactly.
  for (const spec of [PIERS, { ...PIERS, gradeFallFt: 0 }, { foundation: "slab", gradeFallFt: 2, gradeFallToward: "left" }]) {
    assertEquals(F.d3FloorHeightFromFront(spec, W, L, 2.37), 2.37);
  }
  // New frame: the front is the south wall, the uphill edge of a back fall and across a left or right one.
  assertEquals(F.d3FrontGableWall(nf, W, L), "south");
  assertEquals(at(nf, "back", W, L), 3);
  assertEquals(at(nf, undefined, W, L), 3);
  assertEquals(at(nf, "left", W, L), 2);
  assertEquals(at(nf, "right", W, L), 2);
  // An old-frame landscape gable (24 x 12): its front is the WEST end wall. A left fall ends there (the
  // whole fall down), a right fall starts there (the uphill edge), a back fall crosses it.
  const of = { type: "gable", pitch: 0.4 };
  assertEquals(F.d3FrontGableWall(of, 24, 12), "west");
  assertEquals(at(of, "left", 24, 12), 1);
  assertEquals(at(of, "right", 24, 12), 3);
  assertEquals(at(of, "back", 24, 12), 2);
  // The inverse of the renderer: the ground d3GradeAt puts under the front wall's middle is the reading.
  for (const [roof, w, l] of [[nf, W, L], [of, 24, 12], [of, 12, 16]] as Array<[Any, number, number]>) {
    for (const toward of ["back", "left", "right"]) {
      const spec = { ...PIERS, roof, gradeFallFt: 2, gradeFallToward: toward };
      const fh = F.d3FloorHeightFromFront(spec, w, l, 3.2);
      const n = ({ south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0] } as Any)[F.d3FrontGableWall(roof, w, l)];
      assertAlmostEquals(F.d3GradeAt({ ...spec, floorHeightFt: fh }, w, l, (n[0] * w) / 2, (n[1] * l) / 2), 3.2, 1e-9, `${w}x${l} ${toward}`);
    }
  }
  assertEquals(at(nf, "left", W, L, 0.8), 0.3, "held at 0.3");
  assertEquals(F.d3FloorHeightFromFront({ ...PIERS, gradeFallFt: 2, gradeFallToward: "left" }, 0, L, 3), 3, "no footprint: the reading");
});

Deno.test("d3PorchStepsOnGround: one flight measured and drawn, the builder's step count passed to every call", () => {
  const src = lift(CMP, "structure-studio.component.js", "function d3PorchStepsOnGround(", "\n}\n") + "\n}\n";
  assertEquals(lift(JSX, "StructureStudio.jsx", "function d3PorchStepsOnGround(", "\n}\n") + "\n}\n", src);
  const calls: Any[] = [];
  const make = () => new Function("d3PorchStepsGeom", "d3PorchStepsGradeFt", `${src}; return d3PorchStepsOnGround;`)(
    (...a: Any[]) => { calls.push(a); return { grade: -a[3] }; },
    (_s: Any, w: number, l: number, at: Any) => { assertEquals([w, l], [16, 24]); at(1.5); at(2); return 2.25; },
  );
  assertEquals(make()({ roof: { porchStepCount: 4 } }, 16, 24, "g", 6, "center"), { grade: -2.25 });
  assertEquals(calls, [["g", 6, "center", 1.5, 4], ["g", 6, "center", 2, 4], ["g", 6, "center", 2.25, 4]]);
  calls.length = 0;
  make()(null, 16, 24, "g", 6, "left");
  assert(calls.length === 3 && calls.every((c: Any) => c.length === 5 && c[4] === undefined), "no roof: no count");
  // Both call sites go through it, the readout's and the renderer's, and nothing else calls d3PorchStepsGeom
  // but a recessed porch's own (d3RecessedStepsOnGround, 2026-10-03), which the same two make.
  for (const t of [CMP, JSX]) {
    assertStringIncludes(t, "framing, steps: d3PorchStepsOnGround(spec, w, d, g, porch.D, framing.steps) };");
    assertStringIncludes(t, "const stepsGeom = d3PorchStepsOnGround(p.styleSpec, bldgW, bldgH, geom, D, framing.steps);");
    assertStringIncludes(t, "return { wall: g.wall, onEave: g.onEave, posts: g.posts, steps: d3RecessedStepsOnGround(spec, w, d) };");
    assertStringIncludes(t, "const recessedStepsGeom = porchOn ? d3RecessedStepsOnGround(p.styleSpec, bldgW, bldgH) : null;");
    assertEquals(t.split("d3PorchStepsGeom(").length - 1, 3, "the definition and the two ...OnGround calls");
    assertEquals(t.split("d3RecessedStepsOnGround(").length - 1, 3, "its definition, the readout's call and the renderer's");
  }
});

// ── STEPS OFF AN END OF THE DECK, AND A RECESSED PORCH'S STEPS (2026-10-03) ────────────────────
// A side flight is d3PorchStepsGeom's in its own frame, turned a quarter onto the deck's end; the ground
// under it is read through that same turn. A recessed porch's flight stands off the footprint's edge, read
// through d3RecessedPorchToRoot. Each lands on the deepest ground under it, exactly as a front flight does.

/** The deepest ground under a flight, through its porch's map, turned when it leaves a deck end. */
const groundUnder = (spec: Any, toRoot: Any, s: Any) => {
  let deep = -Infinity;
  for (const x of [s.x - s.w / 2, s.x + s.w / 2]) {
    for (const d of [s.d0, s.d0 + s.count * s.tread]) {
      const q = s.turn ? toRoot(s.edgeX + s.turn * d, s.atD - s.turn * x) : toRoot(x, d);
      deep = Math.max(deep, F.d3GradeAt(spec, W, L, q[0], q[1]));
    }
  }
  return deep;
};

Deno.test("a flight off an end of the deck: turned onto that end, on the deepest ground under it", () => {
  const roof = { type: "gable", front: "gable", pitch: 0.4, porchOutFt: 6, porchSteps: "leftSide" };
  const readout = (spec: Any) => F.d3PorchReadout(spec, `${W}x${L}`);
  // Level: the grade, the count it always was, and the flight centred along the end between the wall
  // and the corner post, its first tread at the deck's side.
  const flat = readout({ ...PIERS, roof }).steps;
  const g = readout({ ...PIERS, roof });
  assertEquals([flat.where, flat.turn, flat.x, flat.d0, -flat.grade], ["leftSide", -1, 0, 0, F.d3GradeFt(PIERS)]);
  assertAlmostEquals(flat.edgeX, -g.side, 1e-12);
  assertAlmostEquals(flat.atD, (g.dWall + 0.1 + g.D - 1) / 2, 1e-12);
  assertEquals(flat.w, 3.5, "a 6 ft deck has room for the whole 3.5 ft");
  assertEquals(flat.count, readout({ ...PIERS, roof: { ...roof, porchSteps: "center" } }).steps.count, "level: the front flight's count");
  // The ground falling to the left: the left flight stands on the deepest ground under it, through the turn,
  // and deeper than one off the right end; the porch's own numbers do not move.
  const spec = { ...PIERS, roof, gradeFallFt: 2, gradeFallToward: "left" };
  const toRoot = F.d3PorchToRoot(roof, W, L);
  const s = readout(spec).steps;
  assertAlmostEquals(-s.grade, groundUnder(spec, toRoot, s), 1e-12, "its own ground");
  assert(s.count >= Math.ceil(-s.grade / 0.625 - 1e-9) && s.rise <= 7.5 / 12 + 1e-12, JSON.stringify(s));
  const right = readout({ ...spec, roof: { ...roof, porchSteps: "rightSide" } }).steps;
  assertEquals([right.turn, right.edgeX], [1, -s.edgeX]);
  assertAlmostEquals(-right.grade, groundUnder(spec, toRoot, right), 1e-12);
  assert(-s.grade > -right.grade + 1, `off the downhill end, deeper (${-s.grade} vs ${-right.grade})`);
  // Read unturned it would be the wrong ground: the map is what puts it on its end.
  assert(Math.abs(-s.grade - groundUnder(spec, toRoot, { ...s, turn: 0 })) > 0.5, "the turn matters");
  for (const k of ["pitch", "yHigh", "postH", "posts", "D", "wall", "S"]) assertEquals(readout(spec)[k], readout({ ...PIERS, roof })[k], k);
  // A deck under 2.5 ft draws no flight off its end (2026-10-04), level or over a fall, and the readout
  // says none; deepened to 2.5 ft it is back. A builder's count is the count.
  assertEquals(readout({ ...PIERS, roof: { ...roof, porchOutFt: 1.5 } }).steps, null);
  assertEquals(readout({ ...spec, roof: { ...roof, porchOutFt: 2 } }).steps, null, "over a fall too");
  assertEquals(readout({ ...PIERS, roof: { ...roof, porchOutFt: 2.5 } }).steps.where, "leftSide");
  assertEquals(readout({ ...PIERS, roof: { ...roof, porchStepCount: 5 } }).steps.count, 5);
});

Deno.test("a recessed porch's steps: off the footprint's edge, on the deepest ground under them", () => {
  // Portrait gable, the porch cut into the front (south) end.
  const roof = { type: "gable", pitch: 0.4, porchDepthFt: 4, porchSteps: "left" };
  const rr = (spec: Any, size = `${W}x${L}`) => F.d3RecessedPorchReadout(spec, size);
  const toRoot = F.d3RecessedPorchToRoot(roof, W, L);
  const near = (a: number[], b: number[]) => assert(Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12, `${a} vs ${b}`);
  near(toRoot(0, 0), [0, 12]); near(toRoot(1, 0), [1, 12]); near(toRoot(0, 2), [0, 14]);
  // Level ground: the grade, and the flight 0.15 ft out from the footprint's edge.
  const flat = rr({ ...PIERS, roof }).steps;
  assertEquals([flat.where, flat.d0, -flat.grade, flat.turn], ["left", F.D3.WALL_T / 2, F.d3GradeFt(PIERS), undefined]);
  assertEquals(flat.count, Math.max(1, Math.ceil(1.5 / 0.625 - 1e-9)));
  // On a slab at grade: the one step a slab's porch has always had.
  assertEquals(rr({ ...SLAB, roof }).steps.count, 1);
  // The ground falling to the left: the left flight on its own ground, deeper than the right one.
  const spec = { ...PIERS, roof, gradeFallFt: 2, gradeFallToward: "left" };
  const s = rr(spec).steps;
  assertAlmostEquals(-s.grade, groundUnder(spec, toRoot, s), 1e-12, "its own ground");
  const right = rr({ ...spec, roof: { ...roof, porchSteps: "right" } }).steps;
  assert(-s.grade > -right.grade + 0.5, `the downhill flight is deeper (${-s.grade} vs ${-right.grade})`);
  // Corners: the flight follows them through the same map.
  const gc = { ...PIERS, roof: { ...roof, porchSteps: "center" }, gradeCornersFt: { fl: 2.5, fr: 0, bl: 0, br: 0 } };
  const sc = rr(gc).steps;
  assertAlmostEquals(-sc.grade, groundUnder(gc, toRoot, sc), 1e-12);
  assert(-sc.grade > F.d3GradeFt(gc) + 0.5, JSON.stringify(sc));
  // No recessed porch, no steps: no depth, wings, or a projecting porch beside it. A side word (2026-10-07)
  // is a flight off that open side, below; on a porch too shallow for one, none.
  assertEquals(rr({ ...PIERS, roof: { ...roof, porchDepthFt: 3.5, porchSteps: "leftSide" } }).steps, null);
  assertEquals(rr({ ...PIERS, roof: { type: "gable", pitch: 0.4, porchSteps: "left" } }), null);
  assertEquals(rr({ ...PIERS, roof: { ...roof, porchOutFt: 6 } }), null);
  assertEquals(rr({ ...PIERS, roof: { ...roof, wingSide: "both", wingWidthFt: 6 } }), null);
  assertEquals(F.d3RecessedStepsOnGround({ ...PIERS, roof: { ...roof, porchOutFt: 6 } }, W, L), null);
});

// ── A RECESSED PORCH'S FLIGHT OFF AN OPEN SIDE (2026-10-07) ─────────────────────────────────────
// The projecting deck's end flight, turned a quarter onto the recessed porch's open side, centred along it,
// and on the deepest ground under it through d3RecessedPorchToRoot and the same turn.
Deno.test("a recessed porch's flight off an open side: turned onto it, on the deepest ground under it", () => {
  const roof = { type: "gable", pitch: 0.4, overhang: 0.6, porchDepthFt: 6, porchSteps: "leftSide" };
  const rr = (spec: Any) => F.d3RecessedPorchReadout(spec, `${W}x${L}`).steps;
  const toRoot = F.d3RecessedPorchToRoot(roof, W, L);
  const g = F.d3RecessedPorchFrame(roof, W, L, 8, F.d3CornerFaceFt(null));
  // Level: the grade and the front flight's count, off the west side line (the wall's face) of a south porch.
  const flat = rr({ ...PIERS, roof });
  const front = rr({ ...PIERS, roof: { ...roof, porchSteps: "left" } });
  assertEquals([flat.where, flat.turn, flat.x, flat.d0, -flat.grade, flat.count, flat.rise], ["leftSide", -1, 0, 0, F.d3GradeFt(PIERS), front.count, front.rise]);
  assertAlmostEquals(flat.edgeX, -(W / 2 + F.D3.WALL_T / 2), 1e-12);
  assertAlmostEquals(flat.atD, (g.face - 6 + g.face - 0.29) / 2, 1e-12);
  const q = toRoot(flat.edgeX, flat.atD);
  assertAlmostEquals(q[0], -W / 2 - F.D3.WALL_T / 2, 1e-12);
  assert(q[1] > L / 2 - 6 && q[1] < L / 2, `the flight's middle beside the porch: z ${q[1]}`);
  // The ground falling to the left: the left flight on its own ground through the turn, deeper than the right.
  const spec = { ...PIERS, roof, gradeFallFt: 2, gradeFallToward: "left" };
  const s = rr(spec);
  assertAlmostEquals(-s.grade, groundUnder(spec, toRoot, s), 1e-12, "its own ground");
  assert(s.count >= Math.ceil(-s.grade / 0.625 - 1e-9) && s.rise <= 7.5 / 12 + 1e-12, JSON.stringify(s));
  const right = rr({ ...spec, roof: { ...roof, porchSteps: "rightSide" } });
  assertEquals([right.turn, right.edgeX], [1, -s.edgeX]);
  assertAlmostEquals(-right.grade, groundUnder(spec, toRoot, right), 1e-12);
  assert(-s.grade > -right.grade + 1, `off the downhill side, deeper (${-s.grade} vs ${-right.grade})`);
  // Toward the back: the ground under the flight's back end (nearer the set-back wall) is what it stands on.
  const back = { ...PIERS, roof, gradeCornersFt: { fl: 0, fr: 0, bl: 2, br: 0 } };
  const sb = rr(back);
  assertAlmostEquals(-sb.grade, groundUnder(back, toRoot, sb), 1e-12);
  assert(Math.abs(-sb.grade - groundUnder(back, toRoot, { ...sb, turn: 0 })) > 1e-6, "the turn matters");
});

Deno.test("What we drew: steps off a side of the deck, and a recessed porch's steps, in plain words", () => {
  const deck = { type: "gable", front: "gable", pitch: 0.4, porchOutFt: 6 };
  assertStringIncludes(P.ssDrewWords({ roof: { ...deck, porchSteps: "leftSide" } }), "It has steps off its left side.");
  assertStringIncludes(P.ssDrewWords({ roof: { ...deck, porchSteps: "rightSide", porchStepCount: 2 } }), "It has 2 steps off its right side.");
  // The front words are what they were.
  assertStringIncludes(P.ssDrewWords({ roof: { ...deck, porchSteps: "center" } }), "It has steps in the middle.");
  const cut = { type: "gable", pitch: 0.4, porchDepthFt: 4 };
  assertEquals(P.ssDrewWords({ roof: cut }), "The porch is cut 4 ft into the front end.", "no steps: the sentence it always was");
  assertEquals(P.ssDrewWords({ roof: { ...cut, porchSteps: "center" } }), "The porch is cut 4 ft into the front end. It has steps in the middle.");
  // On a raised floor the count is said, the recessed readout's.
  const raised = { ...PIERS, roof: { ...cut, porchSteps: "left" } };
  const n = F.d3RecessedPorchReadout(raised, `${W}x${L}`).steps.count;
  assertStringIncludes(P.ssDrewWords(raised, F.d3RecessedPorchReadout(raised, `${W}x${L}`)), `It has ${n} steps on the left.`);
  // A side word on a recessed porch (2026-10-07) is a flight off that open side, said where it is drawn: a porch
  // 4 ft deep, or the readout's flight. Too shallow, or refused by the readout (a lean-to there), it says nothing.
  assertEquals(P.ssDrewWords({ roof: { ...cut, porchSteps: "leftSide" } }), "The porch is cut 4 ft into the front end. It has steps off its left side.");
  const sideRaised = { ...PIERS, roof: { ...cut, porchSteps: "rightSide" } };
  const nSide = F.d3RecessedPorchReadout(sideRaised, `${W}x${L}`).steps.count;
  assertStringIncludes(P.ssDrewWords(sideRaised, F.d3RecessedPorchReadout(sideRaised, `${W}x${L}`)), `It has ${nSide} steps off its right side.`);
  assertEquals(P.ssDrewWords({ roof: { ...cut, porchDepthFt: 3.5, porchSteps: "leftSide" } }), "The porch is cut 3 ft 6 in into the front end.");
  const leaned = { roof: { ...cut, porchSteps: "leftSide", leanTos: [{ wall: "left", widthFt: 8 }] } };
  assertEquals(F.d3RecessedPorchReadout(leaned, `${W}x${L}`).steps, null, "a lean-to on that side: no flight");
  assert(!/steps? off its/.test(P.ssDrewWords(leaned, F.d3RecessedPorchReadout(leaned, `${W}x${L}`))), "and nothing said");
  // ⚠️ Nor on a deck under 2.5 ft (2026-10-04), where none is drawn: with the readout or without one.
  const shallow = { ...PIERS, roof: { ...deck, porchOutFt: 2, porchSteps: "rightSide", porchStepCount: 2 } };
  for (const said of [P.ssDrewWords(shallow), P.ssDrewWords(shallow, F.d3PorchReadout(shallow, `${W}x${L}`))]) {
    assert(!/steps? off its/.test(said) && said.includes("The porch stands 2 ft out from the front wall."), said);
  }
  assertStringIncludes(P.ssDrewWords({ roof: { ...deck, porchOutFt: 2.5, porchSteps: "rightSide" } }), "It has steps off its right side.");
});

Deno.test("What we drew: on a slab whose ground falls away, the porch steps' count is said (2026-10-04)", () => {
  // At grade there is one step and it is never said; over the lower ground at a slab's back corners the
  // flight climbs further, and the count drawn is said, as on a raised floor.
  const roof = { type: "gable", front: "gable", pitch: 0.4, porchOutFt: 6, porchEnd: "back", porchSteps: "center" };
  const sloped = { foundation: "slab", gradeCornersFt: { fl: 0, fr: 0, bl: 2, br: 2 }, roof };
  const n = F.d3PorchReadout(sloped, "12x16").steps.count;
  assert(n > 1, `${n} steps down to the lower ground`);
  assertStringIncludes(P.ssDrewWords(sloped, F.d3PorchReadout(sloped, "12x16")), `It has ${n} steps in the middle.`);
  // The recessed porch's the same.
  const cut = { foundation: "slab", gradeCornersFt: { fl: 0, fr: 0, bl: 2, br: 2 }, roof: { type: "gable", pitch: 0.4, porchDepthFt: 4, porchEnd: "back", porchSteps: "center" } };
  const nIn = F.d3RecessedPorchReadout(cut, "12x16").steps.count;
  assert(nIn > 1, `${nIn} steps down to the lower ground`);
  assertStringIncludes(P.ssDrewWords(cut, F.d3RecessedPorchReadout(cut, "12x16")), `It has ${nIn} steps in the middle.`);
  // A level slab draws one, and says none, as it always did.
  const level = { foundation: "slab", roof };
  assertEquals(F.d3PorchReadout(level, "12x16").steps.count, 1);
  assertStringIncludes(P.ssDrewWords(level, F.d3PorchReadout(level, "12x16")), "It has steps in the middle.");
  const levelCut = { foundation: "slab", roof: cut.roof };
  assertStringIncludes(P.ssDrewWords(levelCut, F.d3RecessedPorchReadout(levelCut, "12x16")), "It has steps in the middle.");
});

// ── "blank = N": THE COUNT A BLANK STEP BOX DRAWS (review, 2026-09-29) ──────────────────────────
// Both placeholders said d3PorchAutoStepCount(d3GradeFt(spec)), the count at the FRONT's height, while
// the renderer counts the flight on the ground under it: "blank = 3" beside six drawn steps on a back
// porch over 2 ft of fall. d3PorchBlankStepCount is the readout's flight with the builder's count left out.

Deno.test("d3PorchBlankStepCount: the drawn automatic count, on the ground under the flight", () => {
  const roof = { type: "gable", front: "gable", pitch: 0.4, porchOutFt: 6, porchSteps: "center" };
  const auto = (spec: Any, size = `${W}x${L}`) => F.d3PorchReadout({ ...spec, roof: { ...spec.roof, porchStepCount: undefined } }, size).steps.count;
  // Level ground: exactly the old placeholder, on every foundation and height, the builder's count or not.
  for (const f of [undefined, "slab", "skids", "blocks", "piers"]) {
    for (const h of [undefined, 0.3, 0.75, 1.1, 1.5, 3, 6]) {
      for (const n of [undefined, 1, 4, 12]) {
        const spec = { roof: { ...roof, porchStepCount: n }, foundation: f, floorHeightFt: h };
        assertEquals(F.d3PorchBlankStepCount(spec, `${W}x${L}`), F.d3PorchAutoStepCount(F.d3GradeFt(spec)), JSON.stringify(spec));
      }
    }
  }
  // A fall of 0 and a fall on a slab are level ground.
  for (const spec of [{ ...PIERS, roof, gradeFallFt: 0 }, { roof, foundation: "slab", gradeFallFt: 2 }]) {
    assertEquals(F.d3PorchBlankStepCount(spec, `${W}x${L}`), F.d3PorchAutoStepCount(F.d3GradeFt(spec)));
  }
  // THE REVIEW'S CASE (gradeFall.mjs K): a back porch, 2 ft of fall to the back. The front's height gives 3,
  // the flight is drawn with 6, and the blank now says 6.
  const k = { ...PIERS, roof: { ...roof, porchEnd: "back" }, gradeFallFt: 2, gradeFallToward: "back" };
  assertEquals(F.d3PorchAutoStepCount(F.d3GradeFt(k)), 3, "the old placeholder");
  assertEquals(F.d3PorchReadout(k, `${W}x${L}`).steps.count, 6, "drawn");
  assertEquals(F.d3PorchBlankStepCount(k, `${W}x${L}`), 6);
  // A count the builder typed does not move it: it is what blank WOULD draw, on the ground under that flight.
  for (const n of [1, 4, 12, "3", ""]) assertEquals(F.d3PorchBlankStepCount({ ...k, roof: { ...k.roof, porchStepCount: n } }, `${W}x${L}`), 6, String(n));
  // The sanitiser's steepest fall: 13 drawn, past the 12 a typed count may be.
  assertEquals(F.d3PorchBlankStepCount({ ...k, gradeFallFt: 6 }, `${W}x${L}`), 13);
  // Across the fall and uphill, at other sizes: always the readout's own automatic count.
  for (const [end, steps, toward, size] of [["front", "left", "left", "16x24"], ["front", "right", "left", "16x24"], ["back", "left", "back", "12x16"],
    ["front", "center", "back", "12x16"], ["back", "right", "right", "20x30"]] as Array<[string, string, string, string]>) {
    const spec = { ...PIERS, roof: { ...roof, porchEnd: end, porchSteps: steps }, gradeFallFt: 3, gradeFallToward: toward };
    assertEquals(F.d3PorchBlankStepCount(spec, size), auto(spec, size), `${end} ${steps} ${toward} ${size}`);
  }
  // The old frame's landscape gable (gradeFall.mjs O): the porch on the west end, the ground falling to it.
  const o = { ...PIERS, roof: { type: "gable", pitch: 0.4, porchOutFt: 5, porchSteps: "left" }, gradeFallFt: 2, gradeFallToward: "left" };
  assertEquals(F.d3PorchBlankStepCount(o, "24x12"), auto(o, "24x12"));
  assert(F.d3PorchBlankStepCount(o, "24x12") > F.d3PorchAutoStepCount(F.d3GradeFt(o)), "more than the front's height gives");
  // No projecting porch, or no steps: the front's height, as before.
  for (const r of [{ type: "gable", pitch: 0.4 }, { ...roof, porchSteps: undefined }, { type: "gable", pitch: 0.4, porchDepthFt: 4, porchSteps: "left" }]) {
    const spec = { ...PIERS, roof: r, gradeFallFt: 2 };
    assertEquals(F.d3PorchBlankStepCount(spec, `${W}x${L}`), F.d3PorchAutoStepCount(F.d3GradeFt(spec)), JSON.stringify(r));
  }
  assertEquals(F.d3PorchBlankStepCount(null, "12x16"), F.d3PorchAutoStepCount(F.d3GradeFt(null)));
});

Deno.test("both step boxes' placeholders say d3PorchBlankStepCount, in both twins", () => {
  for (const t of [CMP, JSX]) {
    assertStringIncludes(t, "placeholder={`blank = ${d3PorchBlankStepCount(adminCal && adminCal.spec, `${calReadoutW}x${calReadoutL}`)}`}");
    assertStringIncludes(t, "const autoSteps = d3PorchBlankStepCount(adminCal.spec, sel.size);");
    assertEquals(t.split("d3PorchAutoStepCount(d3GradeFt(adminCal").length - 1, 0, "the front-height placeholder is gone");
    // Past the box's 12 the grid's hint says what blank draws, and that a typed count stops at 12.
    assertStringIncludes(t, "const pastBox = autoSteps > 12 && !(Number(roof.porchStepCount) >= 1);");
    assertStringIncludes(t, "${pastBox ? ` Left blank, it draws ${autoSteps} steps; a number typed here can be 12 at most.` : \"\"}");
  }
});

// ── THE KEYS ROUND-TRIP; NOTHING IS INVENTED ─────────────────────────────────────────────────

Deno.test("d3ResolveStyleSpec names both keys beside blocks or piers, and never defaults them", () => {
  const res = (d3: Any) => F.d3ResolveStyleSpec({ d3 }, "harness", 8);
  const both = res({ ...PIERS, gradeFallFt: 2, gradeFallToward: "left" });
  assertEquals([both.gradeFallFt, both.gradeFallToward], [2, "left"]);
  assertEquals(res({ ...PIERS, gradeFallFt: "1.5" }).gradeFallFt, 1.5);
  // Absent stays absent: not undefined-valued, not defaulted.
  for (const d3 of [PIERS, { ...PIERS, gradeFallFt: 0 }, { ...PIERS, gradeFallFt: -1, gradeFallToward: "down" }]) {
    const r = res(d3);
    assert(!("gradeFallFt" in r) && !("gradeFallToward" in r), JSON.stringify(r));
  }
  // The direction is kept on its own (the sanitiser remembers it), but only beside a raised floor.
  assertEquals(res({ ...PIERS, gradeFallToward: "right" }).gradeFallToward, "right");
  for (const f of [undefined, "slab", "skids"]) {
    const r = res({ roof: PIERS.roof, foundation: f, gradeFallFt: 2, gradeFallToward: "back" });
    assert(!("gradeFallFt" in r) && !("gradeFallToward" in r), String(f));
  }
});

Deno.test("the panel's tidy-up and the video draft's merge: the fall goes with the raised floor", () => {
  const stored = { ...PIERS, colors: {}, gradeFallFt: 2, gradeFallToward: "left" };
  assertEquals([...C.CAL_RAISED_ONLY], ["floorHeightFt", "gradeFallFt", "gradeFallToward", "gradeCornersFt"]);
  assertEquals(C.calTidyFloor(stored), stored, "raised: untouched, the same object");
  const skids = C.calTidyFloor({ ...stored, foundation: "skids" });
  assert(!("gradeFallFt" in skids) && !("gradeFallToward" in skids) && !("floorHeightFt" in skids));
  const plain = { roof: {}, foundation: "slab" };
  assertEquals(C.calTidyFloor(plain), plain, "nothing to take off: the same object");
  // A regenerated draft that still stands on blocks or piers keeps the builder's fall; one that reads a
  // slab or skids takes it off, as Save would; a draft that says nothing about the foundation keeps it.
  for (const f of ["piers", "blocks", undefined]) {
    const m = C.calShapeMerged(stored, { roof: { type: "gable" }, ...(f ? { foundation: f } : {}) });
    assertEquals([m.gradeFallFt, m.gradeFallToward], [2, "left"], String(f));
  }
  for (const f of ["slab", "skids"]) {
    const m = C.calShapeMerged(stored, { roof: { type: "gable" }, foundation: f });
    assert(!("gradeFallFt" in m) && !("gradeFallToward" in m), f);
  }
  // A DRAFT'S FLOOR HEIGHT IS READ AT THE FRONT WALL'S MIDDLE; floorHeightFt is the uphill edge's. The
  // preview here is 16x24 in the new frame (front = south): a left or right fall puts the front wall's
  // middle half the fall down the slope, so the reading comes back up by that much; a back fall's
  // front wall IS the uphill edge, and level ground keeps the reading exactly.
  const draft = (fh: number) => ({ roof: { type: "gable", front: "gable" }, foundation: "piers", floorHeightFt: fh });
  assertEquals(C.calShapeMerged(stored, draft(2.5)).floorHeightFt, 1.5, "left 2 ft: 2.5 at the door is 1.5 on the right side");
  assertEquals(C.calShapeMerged({ ...stored, gradeFallToward: "right" }, draft(2.5)).floorHeightFt, 1.5, "right");
  assertEquals(C.calShapeMerged({ ...stored, gradeFallToward: "back" }, draft(2.5)).floorHeightFt, 2.5, "back: the front is uphill");
  assertEquals(C.calShapeMerged({ ...stored, gradeFallToward: undefined }, draft(2.5)).floorHeightFt, 2.5, "absent is back");
  assertEquals(C.calShapeMerged({ ...PIERS, colors: {} }, draft(2.5)).floorHeightFt, 2.5, "level: the reading");
  assertEquals(C.calShapeMerged(stored, draft(1)).floorHeightFt, 0.3, "never under the sanitiser's 0.3");
  assertEquals(C.calShapeMerged(stored, { roof: { type: "gable" }, foundation: "piers" }).floorHeightFt, 1.5, "no reading: the stored height");
  const slabDraft = C.calShapeMerged(stored, { ...draft(2.5), foundation: "slab" });
  assert(!("floorHeightFt" in slabDraft) && !("gradeFallFt" in slabDraft), "a slab draft: neither");
  // Level ground is the merge it has always been: the same keys, in the same order.
  assertEquals(Object.keys(C.calShapeMerged({ ...PIERS, colors: {} }, draft(2.5))),
    ["roof", "wallHeightFt", "foundation", "floorHeightFt", "colors", "gableVent", "roofMaterial"]);
  // A draft never brings a fall of its own: the video cannot see one.
  const fromDraft = C.calShapeMerged({ ...PIERS, colors: {} }, { roof: { type: "gable" }, foundation: "piers", gradeFallFt: 3, gradeFallToward: "right" });
  assert(!("gradeFallFt" in fromDraft) && !("gradeFallToward" in fromDraft));
});

// ── THE PANEL'S WORDS AND THE SHOT SIGNATURE ─────────────────────────────────────────────────

Deno.test("ssShotSig: the signature it always was without the keys, and a new one when the fall changes", () => {
  const a = { roof: { type: "gable" }, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5 };
  assertEquals(P.ssShotSig(a), JSON.stringify([a.roof, 8, null, null, "piers", null, null, 1.5]), "the 2026-09-25 signature, byte for byte");
  const f2 = { ...a, gradeFallFt: 2 };
  assert(P.ssShotSig(f2) !== P.ssShotSig(a), "a fall");
  assert(P.ssShotSig({ ...f2, gradeFallFt: 3 }) !== P.ssShotSig(f2), "a deeper fall");
  assert(P.ssShotSig({ ...f2, gradeFallToward: "left" }) !== P.ssShotSig(f2), "another direction");
});

Deno.test("What we drew: the fall is said where there is one, and nothing else changes", () => {
  const base = { roof: { type: "gable", pitch: 0.5 }, foundation: "piers", floorHeightFt: 1.5 };
  assertStringIncludes(P.ssDrewWords({ ...base, gradeFallFt: 2, gradeFallToward: "left" }),
    "The ground falls 2 ft toward the left, so the piers on that side stand taller.");
  assertStringIncludes(P.ssDrewWords({ ...base, foundation: "blocks", gradeFallFt: 1.5 }),
    "The ground falls 1 ft 6 in toward the back, so the blocks on that side stand taller.");
  // The floor height is the uphill edge's, in the panel's words: the front, or the other side.
  assertStringIncludes(P.ssDrewWords({ ...base, gradeFallFt: 2, gradeFallToward: "left" }), "its floor 1 ft 6 in off the ground on the right side.");
  assertStringIncludes(P.ssDrewWords({ ...base, gradeFallFt: 2, gradeFallToward: "right" }), "its floor 1 ft 6 in off the ground on the left side.");
  assertStringIncludes(P.ssDrewWords({ ...base, gradeFallFt: 2 }), "its floor 1 ft 6 in off the ground at the front.");
  assertStringIncludes(P.ssDrewWords({ roof: base.roof, foundation: "piers", gradeFallFt: 2, gradeFallToward: "right" }),
    "no floor height is given, so its floor is drawn 1 ft 6 in off the ground on the left side.");
  for (const extra of [{}, { gradeFallFt: 0 }, { gradeFallToward: "left" }]) {
    assertEquals(P.ssDrewWords({ ...base, ...extra }), P.ssDrewWords(base), JSON.stringify(extra));
  }
  assertEquals(P.ssDrewWords({ roof: base.roof, foundation: "slab", gradeFallFt: 2 }), P.ssDrewWords({ roof: base.roof, foundation: "slab" }), "not raised: not said");
});

Deno.test("What we drew: the fall sentence says where the porch is when it stands on the side the ground falls to, or away from it", () => {
  // Review, 2026-09-29: back, left and right are the building's (d3GradeFall), never the porch's. On an
  // old-frame landscape gable the porch's "front end" is the WEST wall, the side a fall toward the left
  // falls to, so "The porch stands 5 ft out from the front end ... falls 2 ft toward the left" read as
  // two different walls. The sentence now names the porch where the two meet.
  const o = { roof: { type: "gable", pitch: 0.4, porchOutFt: 5, porchSteps: "left" }, foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 2, gradeFallToward: "left" };
  const ro = F.d3PorchReadout(o, "24x12");
  assertEquals(ro.wall, "west");
  const said = P.ssDrewWords(o, ro);
  assertStringIncludes(said, "The porch stands 5 ft out from the front end.");
  assertStringIncludes(said, "The ground falls 2 ft toward the left, where the porch is, so the piers on that side stand taller.");
  // Falling the other way, away from it.
  const away = { ...o, gradeFallToward: "right" };
  assertStringIncludes(P.ssDrewWords(away, F.d3PorchReadout(away, "24x12")), "The ground falls 2 ft toward the right, away from the porch, so the piers on that side stand taller.");
  // Carolyn's Tri Home (gradeFall.mjs K): a back porch, the ground falling to the back.
  const k = { ...PIERS, roof: { type: "gable", front: "gable", pitch: 0.4, porchOutFt: 6, porchEnd: "back", porchSteps: "center" }, gradeFallFt: 2, gradeFallToward: "back" };
  assertStringIncludes(P.ssDrewWords(k, F.d3PorchReadout(k, "16x24")), "The ground falls 2 ft toward the back, where the porch is, so the piers on that side stand taller.");
  // A front porch on a back fall stands uphill, away from it; a front porch across a left fall is neither.
  const front = { ...k, roof: { ...k.roof, porchEnd: "front" } };
  assertStringIncludes(P.ssDrewWords(front, F.d3PorchReadout(front, "16x24")), "The ground falls 2 ft toward the back, away from the porch, so the piers");
  const across = { ...front, gradeFallToward: "left" };
  assertStringIncludes(P.ssDrewWords(across, F.d3PorchReadout(across, "16x24")), "The ground falls 2 ft toward the left, so the piers on that side stand taller.");
  // No readout (none yet, or no projecting porch): the sentence it has always been.
  assertStringIncludes(P.ssDrewWords(o), "The ground falls 2 ft toward the left, so the piers on that side stand taller.");
  assertStringIncludes(P.ssDrewWords(o, null), "The ground falls 2 ft toward the left, so the piers on that side stand taller.");
  // Level ground says nothing about the fall, with or without the porch.
  const level = { ...o, gradeFallFt: undefined, gradeFallToward: undefined };
  assert(!/ground falls|where the porch is|away from the porch/.test(P.ssDrewWords(level, F.d3PorchReadout(level, "24x12"))));
});

Deno.test("the height box's hint and the fall's Toward note: plain words, the level sentence untouched", () => {
  for (const t of [CMP, JSX]) {
    // Level ground keeps the sentence and the number it always had.
    assertStringIncludes(t, "` Porch steps climb the whole height, and a ramp a customer adds is drawn ${grade > 0.75 ? ssFtInWords(4 * grade) : \"3 ft\"} long so it reaches the ground.`");
    // With a fall no one length is right, so it gives the renderer's rule (rampOnGround's 4 ft per foot).
    assertStringIncludes(t, "\" Porch steps and any ramp a customer adds reach down to the ground where they stand, so on the low side they are taller and longer: a ramp runs 4 ft for every foot it drops.\"");
    // The directions are the 3D Views menu's, for every direction, and never the porch's.
    assertStringIncludes(t, "{` Front, back, left and right are the sides the 3D's Views menu calls F, B, L and R${calPorchKind(spec.roof) !== \"none\" ? \", wherever the porch is.\" : \".\"}`}");
    assertEquals(t.split("Left and right are as you face the front.").length - 1, 0);
  }
});

// ── THE GROUND AT EACH CORNER (top-level gradeCornersFt, 2026-09-29) ─────────────────────────────
// Carolyn, 09-29, on the Advanced page: "we need to be able to put in where the zero is ... put in four
// points". { fl, fr, bl, br }, each how many feet LOWER the ground is at that corner; the HIGHEST corner
// is the zero and floorHeightFt the floor's height over it. d3GradeAt is a bilinear surface over the
// footprint, eased level outside it the fall's way; a stored fall is the same surface read as corners.

// The single-plane fall as it was written before the corners (d3GradeAt at 5fb622a), for the bit-for-bit check.
const oldFallAt = (spec: Any, W: number, L: number, x: number, z: number) => {
  const grade = F.d3GradeFt(spec);
  const f = F.d3GradeFall(spec);
  if (!f) return grade;
  const ax = F.d3GradeFallAxis(f.toward, Number(W) || 0, Number(L) || 0);
  const D = Math.max(1, ax.ext);
  const B = F.d3GradeFallBlendFt(f.fallFt, D);
  const d = x * ax.dir[0] + z * ax.dir[1] + D / 2;
  const s = d <= -B ? -B / 2
    : d < 0 ? ((d + B) * (d + B)) / (2 * B) - B / 2
      : d <= D ? d
        : d < D + B ? D + B / 2 - ((D + B - d) * (D + B - d)) / (2 * B)
          : D + B / 2;
  return grade + (f.fallFt * s) / D;
};
const CORNER_AT = (w: number, l: number) => ({ fl: [-w / 2, l / 2], fr: [w / 2, l / 2], bl: [-w / 2, -l / 2], br: [w / 2, -l / 2] }) as Record<string, [number, number]>;

Deno.test("corners: absent, zeros, all equal, junk, skids or no foundation is level ground, exactly d3GradeFt", () => {
  assertEquals([...F.D3_GRADE_CORNERS], ["fl", "fr", "bl", "br"]);
  const level = [
    { ...PIERS, gradeCornersFt: { fl: 0, fr: 0, bl: 0, br: 0 } }, { ...PIERS, gradeCornersFt: {} }, { ...PIERS, gradeCornersFt: null },
    { ...PIERS, gradeCornersFt: { fl: 2, fr: 2, bl: 2, br: 2 } }, { ...PIERS, gradeCornersFt: { fl: -1, fr: "x", bl: null } }, { ...PIERS, gradeCornersFt: [2, 2] },
    // Skids and no foundation at all sit on level ground (a slab does not, since 2026-10-03: below).
    { foundation: "skids", gradeCornersFt: { fl: 0, br: 2 } }, { roof: PIERS.roof, gradeCornersFt: { br: 3 } },
    { foundation: "slab", gradeCornersFt: { fl: 1, fr: 1, bl: 1, br: 1 } }, { foundation: "slab", gradeCornersFt: null },
    // Corners replace the fall: an object beside a fall, even a level one, is what is drawn.
    { ...PIERS, gradeFallFt: 2, gradeFallToward: "left", gradeCornersFt: { fl: 0, fr: 0, bl: 0, br: 0 } },
  ];
  for (const spec of level) {
    assertEquals(F.d3GradeCorners(spec), null, JSON.stringify(spec));
    for (const [x, z] of LATTICE) assertEquals(F.d3GradeAt(spec, W, L, x, z), F.d3GradeFt(spec), `${JSON.stringify(spec)} at ${x}, ${z}`);
    assertEquals(F.d3GradeMaxFt(spec), F.d3GradeFt(spec));
    assertEquals(F.d3GradeLiftFt(spec), F.d3GradeFt(spec) - F.D3.FLOOR_T);
  }
  assertEquals(F.d3GradeFall({ ...PIERS, gradeFallFt: 2, gradeCornersFt: { br: 1 } }), null, "beside corners there is no fall");
  assertEquals(F.d3GradeCornersGiven({ ...PIERS, gradeCornersFt: { fl: "1.5", br: 9, bl: -2 } }), { fl: 1.5, fr: 0, bl: 0, br: 6 }, "held to 0..6, a string read as its number");
});

Deno.test("⚠️ a fall read as corners is the single plane it always was, to the last bit", () => {
  for (const [w, l] of [[16, 24], [8, 12], [24, 12], [0.5, 3]]) {
    for (const toward of [undefined, "back", "left", "right"]) {
      for (const fallFt of [0.5, 2, 6, 9]) {
        const spec = { ...PIERS, gradeFallFt: fallFt, gradeFallToward: toward };
        const want = toward === "left" ? { fl: 1, fr: 0, bl: 1, br: 0 } : toward === "right" ? { fl: 0, fr: 1, bl: 0, br: 1 } : { fl: 0, fr: 0, bl: 1, br: 1 };
        const v = Math.min(6, fallFt);
        assertEquals(F.d3GradeCorners(spec), { fl: want.fl * v, fr: want.fr * v, bl: want.bl * v, br: want.br * v });
        for (let x = -30; x <= 30; x += 0.7) {
          for (let z = -30; z <= 30; z += 0.9) assertEquals(F.d3GradeAt(spec, w, l, x, z), oldFallAt(spec, w, l, x, z), `${w}x${l} ${toward} ${fallFt} at ${x},${z}`);
        }
        assertEquals(F.d3GradeMaxFt(spec), F.d3GradeFt(spec) + v);
      }
    }
  }
});

Deno.test("d3GradeAt on four corners: the highest is the zero, each corner's drop at its corner, straight along every edge", () => {
  const spec = { ...PIERS, gradeCornersFt: { fl: 0.5, fr: 2.5, bl: 1, br: 4.5 } };
  const drop = { fl: 0, fr: 2, bl: 0.5, br: 4 };
  assertEquals(F.d3GradeCorners(spec), drop, "normalised to the highest (front-left) corner");
  const at = CORNER_AT(W, L);
  for (const k of ["fl", "fr", "bl", "br"]) assertAlmostEquals(F.d3GradeAt(spec, W, L, ...at[k]), 1.5 + (drop as Any)[k], 1e-12, k);
  // Bilinear: straight along each edge and along every line parallel to one, the centre the corners' mean.
  const bil = (x: number, z: number) => {
    const u = (x + W / 2) / W, v = (z + L / 2) / L;
    return 1.5 + drop.bl * (1 - u) * (1 - v) + drop.br * u * (1 - v) + drop.fl * (1 - u) * v + drop.fr * u * v;
  };
  for (let x = -W / 2; x <= W / 2; x += W / 8) for (let z = -L / 2; z <= L / 2; z += L / 12) assertAlmostEquals(F.d3GradeAt(spec, W, L, x, z), bil(x, z), 1e-9, `${x},${z}`);
  assertAlmostEquals(F.d3GradeAt(spec, W, L, 0, 0), 1.5 + (0 + 2 + 0.5 + 4) / 4, 1e-12);
  assertAlmostEquals(F.d3GradeMaxFt(spec), 5.5, 1e-12, "the deepest corner");
  assertAlmostEquals(F.d3GradeLiftFt(spec), 5.5 - 0.35, 1e-12);
  // The cameras frame it as a building raised to its deepest corner, like a fall that deep.
  assertEquals(F.d3FrameHeightFt(spec, W, L), F.d3FrameHeightFt({ ...PIERS, floorHeightFt: 5.5 }, W, L));
  // Any corner can be the zero, and only the differences matter: +1 on every corner is the same ground.
  const up = { ...PIERS, gradeCornersFt: { fl: 1.5, fr: 3.5, bl: 2, br: 5.5 } };
  for (const [x, z] of LATTICE) assertAlmostEquals(F.d3GradeAt(up, W, L, x, z), F.d3GradeAt(spec, W, L, x, z), 1e-12);
  const back = { ...PIERS, gradeCornersFt: { fl: 2, fr: 1, bl: 0, br: 0.25 } };
  assertEquals(F.d3GradeCorners(back), { fl: 2, fr: 1, bl: 0, br: 0.25 });
  assertEquals(F.d3GradeAt(back, W, L, ...at.bl), 1.5, "the back-left zero stands at the floor height");
});

Deno.test("d3GradeAt on four corners: eased level outside the footprint, no crease, monotone, within the ease of the edges", () => {
  const spec = { ...PIERS, gradeCornersFt: { fl: 0, fr: 1, bl: 2, br: 3 } };
  const g = (x: number, z: number) => F.d3GradeAt(spec, W, L, x, z);
  // Far from the building each quadrant is level.
  assertAlmostEquals(g(-40, 40), g(-60, 55), 1e-12);
  assertAlmostEquals(g(40, -40), g(55, -60), 1e-12);
  // Past a corner by any distance: within the two eases (3 in each) of the corner's own ground.
  const at = CORNER_AT(W, L);
  for (const k of ["fl", "fr", "bl", "br"]) {
    const [x, z] = at[k];
    const far = g(x * 3, z * 3), c = g(x, z);
    assert(Math.abs(far - c) <= 0.5 + 1e-9, `${k}: ${far} vs ${c}`);
  }
  // No crease: the slope along x and along z changes gradually, and never turns back (monotone rows).
  for (const z of [-20, -L / 2, 0, 5, L / 2, 20]) {
    let prev = -Infinity, prevS = NaN;
    for (let x = -30; x <= 30; x += 0.05) {
      const y = g(x, z), s = (g(x + 1e-5, z) - g(x - 1e-5, z)) / 2e-5;
      assert(y >= prev - 1e-12, `rising toward the right along z=${z} at ${x}`);
      if (isFinite(prevS)) assert(Math.abs(s - prevS) < 0.01, `x slope continuous along z=${z} at ${x}`);
      prev = y; prevS = s;
    }
  }
  for (const x of [-20, -W / 2, 0, W / 2, 20]) {
    let prev = -Infinity, prevS = NaN;
    for (let z = 30; z >= -30; z -= 0.05) {
      const y = g(x, z), s = (g(x, z + 1e-5) - g(x, z - 1e-5)) / 2e-5;
      assert(y >= prev - 1e-12, `falling toward the back along x=${x} at ${z}`);
      if (isFinite(prevS)) assert(Math.abs(s - prevS) < 0.01, `z slope continuous along x=${x} at ${z}`);
      prev = y; prevS = s;
    }
  }
  // d3GradeEaseFt is the fall's ease, symmetric about the footprint.
  for (const d of [-5, -1, -0.3, 0, 2, 7.5, 16, 16.4, 17, 30]) assertAlmostEquals(F.d3GradeEaseFt(d, 16, 2) + F.d3GradeEaseFt(16 - d, 16, 2), 16, 1e-12, String(d));
});

Deno.test("corners: past the footprint the ground stays within 3 in of the highest and the deepest corner, even on a saddle", () => {
  // Review 2026-09-30: the two eases compounded past a corner, ~0.55 ft over the zero corner on a saddle,
  // through a floor at its lowest height. Held to the fall's own bound; every sample, 3000 random corners.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const low = { ...PIERS, floorHeightFt: 0.3 };
  for (let i = 0; i < 3000; i++) {
    const c = { fl: rnd() * 6, fr: rnd() * 6, bl: rnd() * 6, br: rnd() * 6 };
    if (i % 3 === 0) Object.assign(c, { fl: 0, br: 0, fr: 6, bl: 6 });
    const spec = { ...low, gradeCornersFt: c };
    const g0 = F.d3GradeFt(spec), deep = F.d3GradeMaxFt(spec);
    for (const [x, z] of [[-W, -L], [W, L], [-W, L], [W, -L], [0, -L], [W, 0], [-W / 2 - 1, L / 2 + 1], [7, -18]]) {
      const y = F.d3GradeAt(spec, W, L, x, z);
      assert(y >= g0 - 0.25 - 1e-6 && y <= deep + 0.25 + 1e-6, `${JSON.stringify(c)} at ${x},${z}: ${y} not in [${g0 - 0.25}, ${deep + 0.25}]`);
      assert(y > 0, `the grass stays under the floor's top: ${JSON.stringify(c)} at ${x},${z}: ${y}`);
    }
  }
  // Inside the footprint nothing is clamped: a bilinear surface is between its corners.
  const sad = { ...low, gradeCornersFt: { fl: 0, fr: 6, bl: 6, br: 0 } };
  assertAlmostEquals(F.d3GradeAt(sad, W, L, 0, 0), 0.35 + 3, 1e-12);
});

Deno.test("corners: the steps, the floor read at the front and the self-check's eye all follow the corners", () => {
  // A back porch; the ground lowest at the back-right corner. Its steps stand on the deepest ground under the
  // flight. "left" is the left of someone facing the porch from behind the building: the back-right (east) end.
  const roof = { type: "gable", front: "gable", pitch: 0.4, porchOutFt: 6, porchSteps: "left", porchEnd: "back" };
  const spec = { ...PIERS, roof, gradeCornersFt: { fl: 0, fr: 0, bl: 1, br: 3 } };
  const s = F.d3PorchReadout(spec, `${W}x${L}`).steps;
  const toRoot = F.d3PorchToRoot(roof, W, L);
  let deep = -Infinity;
  for (const x of [s.x - s.w / 2, s.x + s.w / 2]) for (const d of [s.d0, s.d0 + s.count * s.tread]) deep = Math.max(deep, F.d3GradeAt(spec, W, L, ...toRoot(x, d)));
  assertAlmostEquals(-s.grade, deep, 1e-12, "the flight's own ground");
  const other = F.d3PorchReadout({ ...spec, roof: { ...roof, porchSteps: "right" } }, `${W}x${L}`).steps;
  assert(-s.grade > -other.grade + 0.5, `steps toward the low corner stand deeper (${-s.grade} vs ${-other.grade})`);
  // A video's floor height, read at the front wall's middle, comes back up to the highest corner.
  const nf = { type: "gable", front: "gable", pitch: 0.4 };
  const fs = { ...PIERS, roof: nf, gradeCornersFt: { fl: 1, fr: 2, bl: 0, br: 0 } };
  assertEquals(F.d3FloorHeightFromFront(fs, W, L, 3), 1.5, "the front's middle is 1.5 ft below the back corners");
  assertAlmostEquals(F.d3GradeAt({ ...fs, floorHeightFt: 1.5 }, W, L, 0, L / 2), 3, 1e-12);
  assertEquals(F.d3FloorHeightFromFront({ ...fs, gradeCornersFt: { fl: 0, fr: 0, bl: 2, br: 1 } }, W, L, 2.37), 2.37, "the front at the highest ground: the reading");
  // The self-check's phone stands EYE_FT + FLOOR_T over the ground under it.
  const want = F.SS_SHOT.EYE_FT + F.D3.FLOOR_T;
  const sc = { ...PIERS, gradeCornersFt: { fl: 0, fr: 1, bl: 2.5, br: 4 } };
  const cams = F.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: sc }, WALK_MAP).filter((c: Any) => c.viewpoint !== "eaveCorner");
  assertEquals(cams.length, 5);
  for (const c of cams) assertAlmostEquals(eyeOverGrass(sc, W, L, c), want, 1e-5, c.viewpoint);
});

Deno.test("corners: the resolver names them, the tidy-up takes them off skids (a slab keeps them), and a draft never brings them", () => {
  const res = (d3: Any) => F.d3ResolveStyleSpec({ d3 }, "harness", 8);
  assertEquals(res({ ...PIERS, gradeCornersFt: { fl: 0, br: "2" } }).gradeCornersFt, { fl: 0, fr: 0, bl: 0, br: 2 });
  for (const d3 of [PIERS, { ...PIERS, gradeCornersFt: { fl: 0, fr: 0, bl: 0, br: 0 } }, { roof: PIERS.roof, foundation: "skids", gradeCornersFt: { br: 2 } }, { roof: PIERS.roof, gradeCornersFt: { br: 2 } }]) {
    assert(!("gradeCornersFt" in res(d3)), JSON.stringify(d3));
  }
  // A slab names them too (2026-10-03): its stem wall goes down to them.
  assertEquals(res({ roof: PIERS.roof, foundation: "slab", gradeCornersFt: { br: "2" } }).gradeCornersFt, { fl: 0, fr: 0, bl: 0, br: 2 });
  const stored = { ...PIERS, colors: {}, gradeCornersFt: { fl: 0, fr: 1, bl: 0, br: 2 } };
  assertEquals(C.calTidyFloor(stored), stored, "raised: untouched");
  assert(!("gradeCornersFt" in C.calTidyFloor({ ...stored, foundation: "skids" })));
  const kept = C.calShapeMerged(stored, { roof: { type: "gable" }, foundation: "piers" });
  assertEquals(kept.gradeCornersFt, stored.gradeCornersFt, "a regenerated draft keeps the builder's corners");
  // A slab draft keeps them (2026-10-03: a slab's ground can fall away too) and drops the floor height.
  const onSlab = C.calShapeMerged(stored, { roof: { type: "gable" }, foundation: "slab" });
  assertEquals([onSlab.foundation, onSlab.gradeCornersFt, "floorHeightFt" in onSlab], ["slab", stored.gradeCornersFt, false], "a slab draft keeps them");
  assert(!("gradeCornersFt" in C.calShapeMerged(stored, { roof: { type: "gable" }, foundation: "skids" })), "a skids draft takes them off");
  const fromDraft = C.calShapeMerged({ ...PIERS, colors: {} }, { roof: { type: "gable" }, foundation: "piers", gradeCornersFt: { fl: 0, br: 3 } });
  assert(!("gradeCornersFt" in fromDraft), "the video cannot see the corners");
  // A draft's floor height at the front wall's middle comes back to the highest corner here too.
  const draft = { roof: { type: "gable", front: "gable" }, foundation: "piers", floorHeightFt: 2.5 };
  assertEquals(C.calShapeMerged({ ...stored, gradeCornersFt: { fl: 1, fr: 1, bl: 0, br: 0 } }, draft).floorHeightFt, 1.5);
});

Deno.test("corners: What we drew says each corner in plain words, and the shot signature changes only where they are", () => {
  const base = { roof: { type: "gable", pitch: 0.5 }, foundation: "piers", floorHeightFt: 1.5 };
  const said = P.ssDrewWords({ ...base, gradeCornersFt: { fl: 0, fr: 1.5, bl: 0, br: 2 } });
  assertStringIncludes(said, "its floor 1 ft 6 in off the ground at its highest corner.");
  assertStringIncludes(said, "The ground is highest at the front-left and back-left corners, and 1 ft 6 in lower at the front-right and 2 ft lower at the back-right, so the piers stand taller where it is lower.");
  assertStringIncludes(P.ssDrewWords({ ...base, foundation: "blocks", gradeCornersFt: { fl: 1, fr: 1, bl: 1, br: 0 } }),
    "The ground is highest at the back-right corner, and 1 ft lower at the front-left, 1 ft lower at the front-right and 1 ft lower at the back-left, so the blocks stand taller where it is lower.");
  // Corners replace the fall's sentence; level corners say nothing; a slab says nothing.
  const withFall = P.ssDrewWords({ ...base, gradeFallFt: 2, gradeFallToward: "left", gradeCornersFt: { fl: 0, fr: 0, bl: 1, br: 1 } });
  assert(!withFall.includes("The ground falls"), withFall);
  for (const gc of [{ fl: 0, fr: 0, bl: 0, br: 0 }, { fl: 2, fr: 2, bl: 2, br: 2 }]) assertEquals(P.ssDrewWords({ ...base, gradeCornersFt: gc }), P.ssDrewWords(base), JSON.stringify(gc));
  // A slab with corners (2026-10-03) says its own sentence; level corners on it, skids or nothing said say nothing.
  assertStringIncludes(P.ssDrewWords({ roof: base.roof, foundation: "slab", gradeCornersFt: { br: 2, bl: 0.5 } }),
    "It sits on a concrete slab. The ground is highest at the front-left and front-right corners, and 6 in lower at the back-left and 2 ft lower at the back-right, so more of the slab's concrete edge shows where it is lower.");
  assertEquals(P.ssDrewWords({ roof: base.roof, foundation: "slab", gradeCornersFt: { fl: 1, fr: 1, bl: 1, br: 1 } }), P.ssDrewWords({ roof: base.roof, foundation: "slab" }));
  assertEquals(P.ssDrewWords({ roof: base.roof, foundation: "skids", gradeCornersFt: { br: 2 } }), P.ssDrewWords({ roof: base.roof, foundation: "skids" }));
  assertEquals(P.ssDrewWords({ roof: base.roof, gradeCornersFt: { br: 2 } }), P.ssDrewWords({ roof: base.roof }));
  assertEquals(P.ssDrewWords(null), "", "no spec, no words");
  assertStringIncludes(P.ssDrewWords({ roof: base.roof, foundation: "piers", gradeCornersFt: { br: 2 } }), "no floor height is given, so its floor is drawn 1 ft 6 in off the ground at its highest corner.");
  // The signature: byte for byte without the key, a new one with it and for every change of it.
  const a = { roof: { type: "gable" }, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5 };
  assertEquals(P.ssShotSig(a), JSON.stringify([a.roof, 8, null, null, "piers", null, null, 1.5]));
  const c1 = { ...a, gradeCornersFt: { fl: 0, fr: 0, bl: 1, br: 2 } };
  assert(P.ssShotSig(c1) !== P.ssShotSig(a));
  assert(P.ssShotSig({ ...c1, gradeCornersFt: { fl: 0, fr: 0, bl: 1, br: 2.5 } }) !== P.ssShotSig(c1));
});

Deno.test("corners: both panels draw a box per corner with its own attribute, and the fall's two boxes are gone", () => {
  for (const t of [CMP, JSX]) {
    assertStringIncludes(t, "data-ss-grade-corners={idPrefix}");
    assertStringIncludes(t, "data-ss-grade-corner={k}");
    assertStringIncludes(t, "data-ss-adv-corner={k}");
    assertStringIncludes(t, "0 is the highest corner. Floor height is measured there.");
    assertEquals(t.split("data-ss-grade-fall=").length - 1, 0, "the fall's box");
    assertEquals(t.split("data-ss-grade-fall-toward=").length - 1, 0, "the fall's Toward");
    assertEquals(t.split('label: "Ground falls away (ft)"').length - 1, 0, "the Advanced page's fall slider");
  }
});

// ── THE GROUND AT EACH CORNER UNDER A CONCRETE SLAB (2026-10-03) ─────────────────────────────────────
// Ahsan, 10-03: the corners under a slab too. A slab keeps no floor height and no fall; its highest corner
// is the floor band's own depth (D3.FLOOR_T), where the ground has always been drawn, and the renderer's
// stem wall carries the pour down to the lower ground (tests/harness/gradeFall.mjs measures it).
const SLAB = { roof: { type: "gable", front: "gable", pitch: 0.4 }, wallHeightFt: 8, foundation: "slab" };

Deno.test("slab corners: d3GradeFt stays the band's depth, the lift is the deepest drop, and there is still no fall", () => {
  const spec = { ...SLAB, gradeCornersFt: { fl: 0, fr: 5 / 12, bl: 8 / 12, br: 1.5 } };
  assertEquals(F.d3SlopeFoundation(spec), "slab");
  assertEquals([F.d3SlopeFoundation({ foundation: "piers" }), F.d3SlopeFoundation({ foundation: "skids" }), F.d3SlopeFoundation({}), F.d3SlopeFoundation(null)], ["piers", null, null, null]);
  assertEquals(F.d3RaisedFoundation(spec), null, "a slab is not raised");
  assertEquals(F.d3GradeFt(spec), F.D3.FLOOR_T, "the highest corner is where the slab meets the ground");
  assertEquals(F.d3GradeCorners(spec), { fl: 0, fr: 5 / 12, bl: 8 / 12, br: 1.5 });
  const at = CORNER_AT(W, L);
  for (const k of ["fl", "fr", "bl", "br"]) assertAlmostEquals(F.d3GradeAt(spec, W, L, ...at[k]), F.D3.FLOOR_T + (spec.gradeCornersFt as Any)[k], 1e-12, k);
  assertAlmostEquals(F.d3GradeMaxFt(spec), F.D3.FLOOR_T + 1.5, 1e-12);
  assertAlmostEquals(F.d3GradeLiftFt(spec), 1.5, 1e-12, "the cameras frame down to the deepest corner");
  // A slab carries no fall, with or without corners beside one.
  assertEquals(F.d3GradeFall({ ...SLAB, gradeFallFt: 2, gradeFallToward: "back" }), null);
  assertEquals(F.d3GradeFall({ ...spec, gradeFallFt: 2 }), null);
  // A floor height beside a slab means nothing: the highest corner stays at the band.
  assertEquals(F.d3GradeFt({ ...spec, floorHeightFt: 3 }), F.D3.FLOOR_T);
});

Deno.test("slab corners: the porch steps reach the ground under the flight", () => {
  const roof = { type: "gable", front: "gable", pitch: 0.4, porchOutFt: 6, porchSteps: "center", porchEnd: "front" };
  const level = { ...SLAB, roof };
  const spec = { ...level, gradeCornersFt: { fl: 2, fr: 2, bl: 0, br: 0 } };
  const r0 = F.d3PorchReadout(level, `${W}x${L}`).steps, r1 = F.d3PorchReadout(spec, `${W}x${L}`).steps;
  assertEquals([r0.count, -r0.grade], [1, F.D3.FLOOR_T], "level: the one step a slab always had");
  const toRoot = F.d3PorchToRoot(roof, W, L);
  let deep = -Infinity;
  for (const x of [r1.x - r1.w / 2, r1.x + r1.w / 2]) for (const d of [r1.d0, r1.d0 + r1.count * r1.tread]) deep = Math.max(deep, F.d3GradeAt(spec, W, L, ...toRoot(x, d)));
  assertAlmostEquals(-r1.grade, deep, 1e-12, "the flight stands on the ground under it");
  assert(-r1.grade > 2.3 && r1.count >= 4 && r1.rise <= 7.5 / 12 + 1e-9, JSON.stringify(r1));
  // d3PorchStepsOnGround is the one call the readout and the renderer both make.
  const g = F.d3PorchGeom(W, 6, 6, 0.18, Infinity, 8, F.d3PorchFraming(roof));
  assertEquals(F.d3PorchStepsOnGround(level, W, L, g, 6, "center").count, 1);
  assert(-F.d3PorchStepsOnGround(spec, W, L, g, 6, "center").grade > 2.3);
});

Deno.test("slab corners: the tidy-up keeps them on a slab and hands back the same object when nothing goes", () => {
  const gc = { fl: 0, fr: 1, bl: 0, br: 2 };
  const slab = { ...SLAB, colors: {}, gradeCornersFt: gc };
  assert(C.calTidyFloor(slab) === slab, "a slab with corners: the same object, untouched");
  const extra = C.calTidyFloor({ ...slab, floorHeightFt: 1.5, gradeFallFt: 2, gradeFallToward: "left" });
  assertEquals([extra.gradeCornersFt, "floorHeightFt" in extra, "gradeFallFt" in extra, "gradeFallToward" in extra], [gc, false, false, false], "only the corners stay");
  assertEquals([...C.CAL_RAISED_ONLY], ["floorHeightFt", "gradeFallFt", "gradeFallToward", "gradeCornersFt"]);
  for (const f of ["skids", undefined]) assert(!("gradeCornersFt" in C.calTidyFloor({ ...slab, foundation: f })), `${String(f)}: no corners`);
  const bare = { ...SLAB, colors: {} };
  assert(C.calTidyFloor(bare) === bare, "nothing to drop: the same object");
});
