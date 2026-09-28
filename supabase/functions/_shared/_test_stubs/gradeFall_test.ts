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
  ["const calShapeMerged = (spec, d3) => calTidyFloor({", "  const applyDraftedShape"],
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
    `d3PorchReadout, d3ResolveStyleSpec, d3DefaultShotCamera, ssSelfCheckCameras, D3_FOUNDATIONS, d3RaisedFoundation };`,
)() as Record<string, Any>;
const P = new Function(`${panelBlocks.map((b) => b.cmp).join("\n")}; return { ssDrewWords, ssShotSig };`)() as Record<string, Any>;
// calDraftRoof is the roof half of the merge (calDraftRoof_test's); a plain spread stands in for it.
const C = new Function(
  "calDraftRoof", "D3_FOUNDATIONS", "d3RaisedFoundation",
  `${calBlocks.map((b) => b.cmp).join("\n")}; return { calTidyFloor, calShapeMerged, CAL_RAISED_ONLY };`,
)((s: Any, d: Any) => ({ ...(s || {}), ...(d || {}) }), F.D3_FOUNDATIONS, F.d3RaisedFoundation) as Record<string, Any>;

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
  const frameMap = { front: { frame: 1, azimuthDeg: 0 }, back: { frame: 5, azimuthDeg: 180 } };
  assertEquals(JSON.stringify(F.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: fall }, frameMap)),
    JSON.stringify(F.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: deep }, frameMap)));
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
  // Both call sites go through it, the readout's and the renderer's, and nothing else calls d3PorchStepsGeom.
  for (const t of [CMP, JSX]) {
    assertStringIncludes(t, "framing, steps: d3PorchStepsOnGround(spec, w, d, g, porch.D, framing.steps) };");
    assertStringIncludes(t, "const stepsGeom = d3PorchStepsOnGround(p.styleSpec, bldgW, bldgH, geom, D, framing.steps);");
    assertEquals(t.split("d3PorchStepsGeom(").length - 1, 2, "the definition and d3PorchStepsOnGround's own call");
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
  assertEquals([...C.CAL_RAISED_ONLY], ["floorHeightFt", "gradeFallFt", "gradeFallToward"]);
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
  for (const extra of [{}, { gradeFallFt: 0 }, { gradeFallToward: "left" }]) {
    assertEquals(P.ssDrewWords({ ...base, ...extra }), P.ssDrewWords(base), JSON.stringify(extra));
  }
  assertEquals(P.ssDrewWords({ roof: base.roof, foundation: "slab", gradeFallFt: 2 }), P.ssDrewWords({ roof: base.roof, foundation: "slab" }), "not raised: not said");
});
