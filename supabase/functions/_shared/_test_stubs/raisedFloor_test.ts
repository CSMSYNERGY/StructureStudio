// A RAISED FLOOR (foundation "blocks" | "piers" + floorHeightFt, 2026-09-25), tested against BOTH
// SHIPPED designer twins.
//
// Every building filmed so far sits up off the ground on concrete blocks or piers. The renderer keeps
// the floor at y = 0 -- doors, electrical heights, drag planes, interior items and the porch deck are
// all measured from it -- and LOWERS THE GRADE instead: d3GradeFt is how far below the floor's top
// the ground is drawn. Everything that assumed the ground sits just under the floor reads it: the
// porch steps' climb, the quote's camera, the self-check's eye and framing, and the orbit cameras'
// frame height. Each of those is pure, so it is lifted out of the source by stable anchors and run
// (the porchGeom_test / selfCheckShots_test technique), and every lifted region is asserted
// byte-identical across the two hand-mirrored twins.
//
// The other half of this file is the promise that makes the feature safe to ship: on a slab, on
// skids, and with no foundation at all -- every row stored before today -- every one of these
// numbers is EXACTLY what it was. The meshes themselves are checked in tests/harness/foundation.mjs.

import { assert, assertAlmostEquals, assertEquals, assertStringIncludes } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `raisedFloor_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

// The renderer's pure half: the porchGeom_test and selfCheckShots_test regions, together.
const RENDER: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  // d3RoofAxes .. d3FrameHeightFt, and d3GradeFt / d3GradeLiftFt between them.
  ["function d3RoofAxes(", "function d3FtIn("],
  ["function ssPorchTrussWall(", "// Where a vent sits in the gable above"],
  ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  ["function d3PorchGeom(", "function d3PorchReadout("],
  ["function d3PorchReadout(", "// A dimensioned end-elevation of the style"],
  ["function d3DefaultShotCamera(", "// A default 3/4 view of the building"],
  ["const SS_SHOT = {", "// Render the draft the builder just paid for"],
];
// The calibration panel's pure half: "What we drew", the change lines and the shot signature.
const PANEL: Array<[string, string]> = [
  ["function d3FtIn(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  ["const SS_RENDER_MS =", "// Upload a list with BOUNDED CONCURRENCY"],
];
const liftAll = (regions: Array<[string, string]>) => regions.map(([a, b]) => ({
  a,
  cmp: lift(CMP, "structure-studio.component.js", a, b),
  jsx: lift(JSX, "StructureStudio.jsx", a, b),
}));
const renderBlocks = liftAll(RENDER), panelBlocks = liftAll(PANEL);

Deno.test("every lifted raised-floor region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of [...renderBlocks, ...panelBlocks]) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `${renderBlocks.map((b) => b.cmp).join("\n")}; return { D3, D3_FOUNDATIONS, D3_RAISED_FOUNDATIONS, D3_FLOOR_HEIGHT_DEFAULT_FT, ` +
    `d3RaisedFoundation, d3GradeFt, d3GradeLiftFt, d3FrameHeightFt, d3ModelTopFt, d3PorchGeom, d3PorchFraming, d3PorchStepsGeom, ` +
    `d3PorchReadout, d3DefaultShotCamera, SS_SHOT, ssFitDistance, ssSelfCheckCameras };`,
)() as Record<string, Any>;
const P = new Function(
  `${panelBlocks.map((b) => b.cmp).join("\n")}; return { SS_CHANGE_WORDS, ssChangeLine, ssDrewWords, ssShotSig };`,
)() as Record<string, Any>;

const PANEL_TRIM = 0.18;   // trimFace on panel cladding: T/2 + 0.03
const FARM = { type: "shed", highSide: "front", pitch: 0.22, overhang: 0.8, eave: "fascia", porchOutFt: 4, porchAttachFt: 8, porchPosts: 4, porchPitch: 0.25, porchSteps: "center" };

// ── THE GRADE ────────────────────────────────────────────────────────────────────────────────

Deno.test("d3GradeFt: at grade (D3.FLOOR_T) unless blocks or piers raise it", () => {
  assertEquals(F.D3.FLOOR_T, 0.35);
  assertEquals([...F.D3_FOUNDATIONS], ["skids", "slab", "blocks", "piers"]);
  assertEquals([...F.D3_RAISED_FOUNDATIONS], ["blocks", "piers"]);
  // Every stored style: no foundation, a slab, skids, junk, or a floor height with none of them.
  for (const spec of [undefined, null, {}, { foundation: "slab" }, { foundation: "skids" }, { foundation: "Blocks" },
                      { foundation: "slab", floorHeightFt: 3 }, { foundation: "skids", floorHeightFt: 2 }, { floorHeightFt: 4 }]) {
    assertEquals(F.d3GradeFt(spec), 0.35, JSON.stringify(spec));
    assertEquals(F.d3GradeLiftFt(spec), 0, `${JSON.stringify(spec)}: no lift, so every camera is the one it was`);
    assertEquals(F.d3RaisedFoundation(spec), null);
  }
  // Raised: the height given, else the kind's default.
  assertEquals(F.d3GradeFt({ foundation: "blocks", floorHeightFt: 1.1 }), 1.1);
  assertEquals(F.d3GradeFt({ foundation: "piers", floorHeightFt: 1.5 }), 1.5);
  assertEquals(F.d3GradeFt({ foundation: "piers", floorHeightFt: "2.25" }), 2.25);
  assertEquals(F.d3GradeFt({ foundation: "blocks" }), 1);
  assertEquals(F.d3GradeFt({ foundation: "piers" }), 1.5);
  assertEquals(F.d3GradeFt({ foundation: "piers", floorHeightFt: 0 }), 1.5, "0 is no height");
  // The sanitiser's band: 0.3..6, and past 8 a unit error the sanitiser drops (so the default).
  assertEquals(F.d3GradeFt({ foundation: "blocks", floorHeightFt: 7 }), 6);
  assertEquals(F.d3GradeFt({ foundation: "blocks", floorHeightFt: 13 }), 1);
  // Never less than the floor band itself: a 0.3 ft floor draws the ground where it always was.
  assertEquals(F.d3GradeFt({ foundation: "blocks", floorHeightFt: 0.3 }), 0.35);
  assertAlmostEquals(F.d3GradeLiftFt({ foundation: "blocks", floorHeightFt: 1.1 }), 0.75, 1e-12);
});

// ── THE PORCH STEPS CLIMB THE WHOLE HEIGHT ───────────────────────────────────────────────────

Deno.test("porch steps on a raised floor: risers of 7.5 in or less, 11 in treads, landing on the grass", () => {
  const g = F.d3PorchGeom(16, 10, 4, PANEL_TRIM, Infinity, 8, F.d3PorchFraming(FARM));
  // At grade, exactly as before: one step, 2.1 in up, whether the grade is passed or not.
  for (const grade of [undefined, 0, 0.35]) {
    const s = F.d3PorchStepsGeom(g, 4, "center", grade);
    assertEquals([s.count, s.grade], [1, -0.35]);
    assertAlmostEquals(s.rise, 0.175, 1e-12);
  }
  for (const [h, count] of [[0.6, 1], [0.8, 2], [1.1, 2], [1.5, 3], [2, 4], [3, 5], [6, 10]] as const) {
    const s = F.d3PorchStepsGeom(g, 4, "center", h);
    assertEquals([s.count, s.grade], [count, -h], `${h} ft`);
    assertAlmostEquals(s.rise * (s.count + 1), h, 1e-12, `${h} ft: the risers climb from the grass to the deck exactly`);
    assert(s.rise <= 7.5 / 12 + 1e-12, `${h} ft: no riser tops 7.5 in (${(s.rise * 12).toFixed(2)} in)`);
    assertAlmostEquals(s.tread, 11 / 12, 1e-12);
    // Where they stand does not move with the height.
    assertEquals([s.x, s.w, s.d0], [F.d3PorchStepsGeom(g, 4, "center").x, F.d3PorchStepsGeom(g, 4, "center").w, 4]);
  }
  // Farmstand, 1.1 ft on blocks: two steps and three 4.4 in risers. Tri Home, 1.5 ft on piers: three
  // steps, as its porch has.
  assertAlmostEquals(F.d3PorchStepsGeom(g, 4, "center", 1.1).rise * 12, 4.4, 1e-9);
  assertEquals(F.d3PorchStepsGeom(g, 4, "right", 1.5).count, 3);
});

Deno.test("the panel's porch readout counts the steps at the style's own grade", () => {
  const at = F.d3PorchReadout({ roof: FARM, wallHeightFt: 7.3 }, "16x10");
  assertEquals([at.steps.count, at.steps.grade], [1, -0.35], "no foundation: as before");
  for (const f of ["slab", "skids"]) assertEquals(F.d3PorchReadout({ roof: FARM, wallHeightFt: 7.3, foundation: f }, "16x10").steps.count, 1, f);
  const blocks = F.d3PorchReadout({ roof: FARM, wallHeightFt: 7.3, foundation: "blocks", floorHeightFt: 1.1 }, "16x10");
  assertEquals([blocks.steps.count, blocks.steps.grade], [2, -1.1]);
  const piers = F.d3PorchReadout({ roof: FARM, wallHeightFt: 7.3, foundation: "piers" }, "16x10");
  assertEquals([piers.steps.count, piers.steps.grade], [3, -1.5], "piers with no height: the 1.5 ft default");
  // Nothing else in the readout moves: the porch's roof and posts are measured from the floor.
  for (const k of ["pitch", "yHigh", "postH", "posts", "D", "wall", "S"]) assertEquals(blocks[k], at[k], k);
});

// ── THE ORBIT CAMERAS AND THE QUOTE'S SHOT ───────────────────────────────────────────────────

// Where a world point lands on a pinhole camera's film, in [-1, 1] on each axis when it is in frame.
function project(cam: { eye: number[]; at: number[]; fov: number }, aspect: number, p: number[]) {
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: number[]) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const f = norm(sub(cam.at, cam.eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
  const d = sub(p, cam.eye), z = dot(d, f);
  const t = Math.tan((cam.fov / 2) * Math.PI / 180);
  return { x: dot(d, r) / (z * t * aspect), y: dot(d, u) / (z * t), z };
}
const inFrame = (q: { x: number; y: number; z: number }, m = 1) => q.z > 0 && Math.abs(q.x) <= m && Math.abs(q.y) <= m;

Deno.test("d3FrameHeightFt and the quote's shot: unchanged at grade, lowered with the ground when raised", () => {
  const farm = { roof: FARM, wallHeightFt: 7.3 };
  const raised = { ...farm, foundation: "blocks", floorHeightFt: 1.1 };
  // Every stored style keeps its frame height and its camera, number for number.
  for (const f of [undefined, "slab", "skids"]) {
    const spec = f ? { ...farm, foundation: f } : farm;
    assertEquals(F.d3FrameHeightFt(spec, 16, 10), F.d3FrameHeightFt(farm, 16, 10));
    assertEquals(JSON.stringify(F.d3DefaultShotCamera({ bldgW: 16, bldgH: 10, frontWall: "south", style3d: spec })),
      JSON.stringify(F.d3DefaultShotCamera({ bldgW: 16, bldgH: 10, frontWall: "south", style3d: farm })));
  }
  const q0 = F.d3DefaultShotCamera({ bldgW: 16, bldgH: 10, frontWall: "south", style3d: farm })[0];
  const q1 = F.d3DefaultShotCamera({ bldgW: 16, bldgH: 10, frontWall: "south", style3d: raised })[0];
  // A farmstand 0.75 ft further off the ground is framed as a building 0.75 ft taller, from its
  // grass: the frame height starts at D3.WALL_H + 0.75, and the eye and the aim come down 0.75 ft
  // from where that frame puts them. Same lens, same side of the building.
  assertEquals(F.d3FrameHeightFt(farm, 16, 10), F.D3.WALL_H);
  const fH1 = F.d3FrameHeightFt(raised, 16, 10);
  assertAlmostEquals(fH1, F.D3.WALL_H + 0.75, 1e-9);
  const dist1 = (8 + fH1) * 3.66;
  assertAlmostEquals(q1.eye[1], dist1 * 0.5 - 0.75, 1e-9);
  assertAlmostEquals(q1.at[1], fH1 * 0.45 - 0.75, 1e-9);
  assertEquals(q1.fov, q0.fov);
  assert(Math.abs(Math.atan2(q1.eye[0], q1.eye[2]) - Math.atan2(q0.eye[0], q0.eye[2])) < 1e-12, "the same side of the building");
  // ...and the grass under every corner, the supports' feet, is in the quote's 1200 x 900 frame.
  for (const x of [-8, 8]) for (const z of [-5, 5 + 4]) {
    assert(inFrame(project(q1, 1200 / 900, [x, -1.1, z])), `the ground at ${x}, ${z} is in shot`);
  }
  // A building on tall piers frames more, never less: its frame height counts the lift.
  const tall = { roof: { type: "gable", pitch: 1, overhang: 1 }, wallHeightFt: 14 };
  const tallRaised = { ...tall, foundation: "piers", floorHeightFt: 6 };
  assert(F.d3FrameHeightFt(tallRaised, 12, 12) > F.d3FrameHeightFt(tall, 12, 12), "the lift is framed");
  const qt = F.d3DefaultShotCamera({ bldgW: 12, bldgH: 12, frontWall: "south", style3d: tallRaised })[0];
  const top = F.d3ModelTopFt(tallRaised, 12, 12);
  for (const x of [-6, 6]) for (const z of [-6, 6]) {
    assert(inFrame(project(qt, 1200 / 900, [x, -6, z])), `tall piers: the ground at ${x}, ${z} is in shot`);
  }
  assert(inFrame(project(qt, 1200 / 900, [0, top, 0])), "and so is the ridge");
});

Deno.test("the self-check: the eye stays at chest height above the GRASS, and the supports are framed", () => {
  const frameMap = {
    front: { frame: 1, azimuthDeg: 0 }, side: { frame: 2, azimuthDeg: 90 }, eaveCorner: { frame: 3, azimuthDeg: 45 },
    corner: { frame: 4, azimuthDeg: 45 }, back: { frame: 5, azimuthDeg: 180 }, otherSide: { frame: 6, azimuthDeg: 270 },
  };
  const farm = { roof: FARM, wallHeightFt: 7.3 };
  const at = F.ssSelfCheckCameras({ bldgW: 16, bldgH: 10, style3d: farm }, frameMap);
  // Stored styles: byte-for-byte the cameras they had.
  for (const f of ["slab", "skids"]) {
    assertEquals(JSON.stringify(F.ssSelfCheckCameras({ bldgW: 16, bldgH: 10, style3d: { ...farm, foundation: f } }, frameMap)), JSON.stringify(at), f);
  }
  for (const c of at) if (c.viewpoint !== "eaveCorner") assertEquals(c.eye[1], F.SS_SHOT.EYE_FT);
  const raised = F.ssSelfCheckCameras({ bldgW: 16, bldgH: 10, style3d: { ...farm, foundation: "blocks", floorHeightFt: 1.1 } }, frameMap);
  assertEquals(raised.map((c: Any) => c.viewpoint), at.map((c: Any) => c.viewpoint));
  for (let i = 0; i < raised.length; i++) {
    const c = raised[i];
    if (c.viewpoint === "eaveCorner") {
      // The eave close-up is aimed at the eave, which a raised floor does not move.
      assertEquals(JSON.stringify(c), JSON.stringify(at[i]));
      continue;
    }
    // 5.3 ft above where the ground always was (0.35 under the floor) is 5.65; on the raised floor's
    // grass (1.1 under it) that is still 5.65 above the grass.
    assertAlmostEquals(c.eye[1] - -1.1, F.SS_SHOT.EYE_FT + 0.35, 1e-9, `${c.viewpoint}: eye above the grass`);
    // The footprint's corners on the grass are in the 896 x 672 frame.
    for (const x of [-8, 8]) for (const z of [-5, 5]) {
      const q = project(c, F.SS_SHOT.W / F.SS_SHOT.H, [x, -1.1, z]);
      assert(inFrame(q), `${c.viewpoint}: the grass at ${x}, ${z} is in the frame (${q.x.toFixed(2)}, ${q.y.toFixed(2)})`);
    }
  }
  // ssFitDistance with no base is the one it always was: base 0.
  const f = { depthHalf: 5, crossHalf: 8, peak: 10, eyeY: 5.3, lookY: 4.5, fovDeg: 60 };
  assertEquals(F.ssFitDistance(f), F.ssFitDistance({ ...f, base: 0 }));
  assert(F.ssFitDistance({ ...f, base: -2 }) >= F.ssFitDistance(f), "a lower base never brings the camera closer");
});

// ── THE PANEL'S WORDS ───────────────────────────────────────────────────────────────────────

Deno.test("the change lines say what it stands on and how high", () => {
  assertEquals(P.ssChangeLine({ field: "foundation", from: "skids", to: "blocks" }).text, "runners → concrete blocks");
  assertEquals(P.ssChangeLine({ field: "foundation", from: "slab", to: "piers" }).text, "a slab → concrete piers");
  assertEquals(P.ssChangeLine({ field: "foundation", from: null, to: "skids" }).text, "not set → runners");
  const fh = P.ssChangeLine({ field: "floorHeightFt", from: 1, to: 1.5 });
  assertEquals([fh.label, fh.text], ["How high the floor stands off the ground", "1 ft → 1 ft 6 in"]);
});

Deno.test("What we drew: a raised floor is said, with its height or the one drawn; nothing else changes", () => {
  const farm = { roof: FARM };
  assertStringIncludes(P.ssDrewWords({ ...farm, foundation: "blocks", floorHeightFt: 1.1 }),
    "It stands on stacked concrete blocks, its floor 1 ft 1 in off the ground at the front.");
  assertStringIncludes(P.ssDrewWords({ ...farm, foundation: "piers" }),
    "It stands on concrete piers; no floor height is given, so its floor is drawn 1 ft 6 in off the ground.");
  // A slab, skids or nothing: not a word more than before.
  for (const f of [undefined, "slab", "skids"]) {
    assertEquals(P.ssDrewWords({ ...farm, foundation: f, floorHeightFt: 2 }), P.ssDrewWords(farm), String(f));
  }
  assertEquals(P.ssDrewWords({ roof: { type: "gable", pitch: 0.5 }, foundation: "skids" }), "");
  // With the readout's steps, a raised floor says how many; at grade it is always one and never said.
  const built = { posts: 4, pitch: 0.25, pitchClamped: false, steps: { count: 2 } };
  assertStringIncludes(P.ssDrewWords({ ...farm, foundation: "blocks", floorHeightFt: 1.1 }, built), "2 steps in the middle");
  assertStringIncludes(P.ssDrewWords(farm, { ...built, steps: { count: 1 } }), "steps in the middle");
  assert(!/\d steps/.test(P.ssDrewWords(farm, { ...built, steps: { count: 1 } })), "at grade no count");
});

Deno.test("the compare shots are re-taken when the floor height changes", () => {
  const a = { roof: FARM, wallHeightFt: 7.3, foundation: "blocks", floorHeightFt: 1.1 };
  assert(P.ssShotSig(a) !== P.ssShotSig({ ...a, floorHeightFt: 1.5 }), "height");
  assert(P.ssShotSig(a) !== P.ssShotSig({ ...a, foundation: "piers" }), "kind");
});
