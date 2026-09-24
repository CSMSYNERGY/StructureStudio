// The projecting porch's numbers, tested against BOTH SHIPPED designer twins.
//
// A projecting porch (roof.porchOutFt, 2026-09-17) is a deck, posts and a low roof of its own in
// front of one gable end. Everything about its shape that is not a mesh lives in three pure
// functions the renderer and the calibration panel both call: d3ProjectingPorch (which end, how
// deep), d3PorchGeom (pitch, headroom, posts, where the roof meets the wall) and d3PorchReadout (the
// panel's size-label front end). Every one of these fails silently when wrong: a porch on the side
// of the building, a roof that dives through the header, three posts on an 8 ft porch. So they are
// lifted out of the source by stable anchors and run, the wallSlab_test technique, and each lifted
// region is asserted byte-identical across the two hand-mirrored twins.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `porchGeom_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  // D3.WALL_T and D3.WALL_H: the porch's wall face and the readout's default wall height.
  ["const D3 = {", "// The casing reveal every opening"],
  // d3RoofAxes, d3RoofProfile and d3MakeProfYAt: which ends are gable ends, and the span.
  ["function d3RoofAxes(", "function d3FtIn("],
  // ssPorchTrussWall and d3ProjectingPorch.
  ["function ssPorchTrussWall(", "// Where a vent sits in the gable above"],
  // The eave finish (d3EaveFinishDrop and the framing choice it reads), which d3PorchCapFt hangs an
  // eave-wall porch under.
  ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  // d3PorchGeom and d3PorchCapFt.
  ["function d3PorchGeom(", "function d3PorchReadout("],
  ["function d3PorchReadout(", "// A dimensioned end-elevation of the style"],
];
const blocks = REGIONS.map(([a, b]) => {
  const cmp = lift(CMP, "structure-studio.component.js", a, b);
  const jsx = lift(JSX, "StructureStudio.jsx", a, b);
  return { a, cmp, jsx };
});

Deno.test("every lifted porch region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(`${blocks.map((b) => b.cmp).join("\n")}; return { d3ProjectingPorch, d3PorchGeom, d3PorchReadout, d3PorchCapFt, ssPorchTrussWall, d3RoofAxes, d3PorchSpan, d3WallTopFt, d3WallTops, d3PorchWallTopFt, d3NewFrame, d3Massing, d3EaveFinishDrop };`)() as Record<string, Any>;

const PANEL_TRIM = 0.18;   // trimFace on panel cladding: T/2 + 0.03

Deno.test("Barnstead's porch at 16x24, 9 ft walls: a 2:12 roof under the band, three posts, 7 ft clear", () => {
  const g = F.d3PorchGeom(16, 9, 6.5, PANEL_TRIM, Infinity);
  assertAlmostEquals(g.pitch, 1 / 6, 1e-12);
  assertEquals(g.pitchClamped, false);
  assertAlmostEquals(g.yHigh, 8.8, 1e-12);
  assertAlmostEquals(g.postH, 7.02, 0.02);
  assertEquals(g.bays, 2);
  assertEquals(g.posts, 3);
  assertEquals(g.nRaf, 9);
  assertEquals(g.short, false);
  // The frame the renderer builds in: wall face, post centres, roof edge, side planes.
  assertAlmostEquals(g.dWall, 0.15, 1e-12);
  assertAlmostEquals(g.dPost, 6.5 - 0.23, 1e-12);
  assertAlmostEquals(g.dEnd, 6.8, 1e-12);
  assertAlmostEquals(g.side, 8.18, 1e-12);
  // Everything stacks the right way up: rafters under the roof at the wall, header on the posts.
  assert(g.ceilWall < g.yHigh && g.ceilWall > g.hdrTop, `ceilWall ${g.ceilWall} yHigh ${g.yHigh} hdrTop ${g.hdrTop}`);
  assertAlmostEquals(g.hdrTop - g.postH, g.sizes.HDR_H, 1e-12);
});

Deno.test("an 8 ft wall lowers the pitch until 6'8\" stands under the header", () => {
  const g = F.d3PorchGeom(16, 8, 6.5, PANEL_TRIM, Infinity);
  assertAlmostEquals(g.pitch, 0.058, 0.001);
  assertEquals(g.pitchClamped, true);
  assertAlmostEquals(g.postH, 6.67, 0.01);
  assertEquals(g.short, false);
});

Deno.test("a 7 ft wall stops at pitch 0.05 and says the porch is short, without refusing it", () => {
  const g = F.d3PorchGeom(16, 7, 6.5, PANEL_TRIM, Infinity);
  assertEquals(g.pitch, 0.05);
  assertEquals(g.pitchClamped, true);
  assertEquals(g.short, true);
  assert(g.postH < 6.66 && g.postH > 5, `postH ${g.postH}`);
  // The suggestion is a wall that WOULD clear at 2:12.
  assert(g.hNeeded > 8.6 && g.hNeeded < 8.7, `hNeeded ${g.hNeeded}`);
  const at = F.d3PorchGeom(16, g.hNeeded + 1e-6, 6.5, PANEL_TRIM, Infinity);
  assertEquals(at.pitchClamped, false);
  assert(at.postH >= 6.67 - 1e-6, `postH at hNeeded ${at.postH}`);
});

Deno.test("capY from the main roof lowers the high edge; it never raises it past H - 0.2", () => {
  assertAlmostEquals(F.d3PorchGeom(16, 9, 6.5, PANEL_TRIM, 8.4).yHigh, 8.4, 1e-12);
  assertAlmostEquals(F.d3PorchGeom(16, 9, 6.5, PANEL_TRIM, 20).yHigh, 8.8, 1e-12);
});

Deno.test("posts: one at each corner and every 8.5 ft or less, counted off the span, whatever the cladding", () => {
  const want: Array<[number, number]> = [[8, 2], [10, 3], [12, 3], [16, 3], [17, 3], [18, 4], [24, 4]];
  for (const [S, posts] of want) {
    for (const trimFace of [0.18, 0.35]) {
      const g = F.d3PorchGeom(S, 9, 6, trimFace, Infinity);
      assertEquals(g.posts, posts, `S ${S} trimFace ${trimFace}`);
      assertEquals(g.bays + 1, g.posts);
    }
  }
});

Deno.test("d3ProjectingPorch: on above 0.5 ft, clamped to 12, and absent means none", () => {
  assertEquals(F.d3ProjectingPorch({ type: "gable", porchOutFt: 0.5 }, 12, 24), null);
  assertEquals(F.d3ProjectingPorch({ type: "gable", porchOutFt: 0 }, 12, 24), null);
  assertEquals(F.d3ProjectingPorch({ type: "gable" }, 12, 24), null);
  assertEquals(F.d3ProjectingPorch(null, 12, 24), null);
  assertEquals(F.d3ProjectingPorch({ type: "gable", porchOutFt: "junk" }, 12, 24), null);
  assertEquals(F.d3ProjectingPorch({ type: "gable", porchOutFt: 40 }, 12, 24).D, 12);
  assertEquals(F.d3ProjectingPorch({ type: "gambrel", porchOutFt: 6.5 }, 16, 24), { D: 6.5, wall: "south" });
});

Deno.test("d3ProjectingPorch takes the end the recessed porch would take", () => {
  // Gable roofs: the truss wall IS the recessed porch's wall, so the two must agree end for end.
  for (const [w, l] of [[12, 32], [32, 12]]) {
    for (const porchEnd of ["front", "back"]) {
      const recessed = F.ssPorchTrussWall({ type: "gable", porchTruss: true, porchDepthFt: 6, porchEnd }, w, l);
      const projecting = F.d3ProjectingPorch({ type: "gable", porchOutFt: 6, porchEnd }, w, l);
      assert(recessed, `a truss on ${w}x${l} ${porchEnd}`);
      assertEquals(projecting.wall, recessed, `${w}x${l} ${porchEnd}`);
    }
  }
  assertEquals(F.d3ProjectingPorch({ type: "gable", porchOutFt: 6 }, 12, 32).wall, "south");
  assertEquals(F.d3ProjectingPorch({ type: "gable", porchOutFt: 6, porchEnd: "back" }, 12, 32).wall, "north");
  // A shed roof has no truss to compare with. It takes the landscape branch of buildShed3DModel's
  // porchWall rule because d3RoofAxes swaps its axes: west for front, east for back.
  assertEquals(F.d3RoofAxes({ type: "shed" }, 12, 20).uAxisIsX, false);
  assertEquals(F.d3ProjectingPorch({ type: "shed", porchOutFt: 6 }, 12, 20).wall, "west");
  assertEquals(F.d3ProjectingPorch({ type: "shed", porchOutFt: 6, porchEnd: "back" }, 12, 20).wall, "east");
  // And with both kinds in raw data, the truss is gone.
  assertEquals(F.ssPorchTrussWall({ type: "gable", porchTruss: true, porchDepthFt: 6, porchOutFt: 6 }, 12, 32), null);
});

Deno.test("d3PorchReadout reads a size label the way the dormer readout does", () => {
  const spec = { roof: { type: "gambrel", kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1, porchOutFt: 6.5, porchEnd: "front" }, wallHeightFt: 9 };
  const r = F.d3PorchReadout(spec, "16x24");
  assertEquals(r.S, 16);
  assertEquals(r.H, 9);
  assertEquals(r.D, 6.5);
  assertEquals(r.wall, "south");
  assertEquals(r.posts, 3);
  assertAlmostEquals(r.pitch, 1 / 6, 1e-12);
  assertAlmostEquals(r.yHigh, 8.8, 1e-12);
  // The same numbers the renderer gets for that building.
  assertEquals(r.postH, F.d3PorchGeom(16, 9, 6.5, PANEL_TRIM, Infinity).postH);
  // The Unicode times sign, and a short wall.
  const low = F.d3PorchReadout({ ...spec, wallHeightFt: 7 }, "12×16");
  assertEquals(low.S, 12);
  assertEquals(low.short, true);
  assertEquals(low.pitch, 0.05);
  // No wall height falls back to the renderer's default wall.
  assertEquals(F.d3PorchReadout({ roof: spec.roof }, "16x24").H, 8);
  // No projecting porch, no readout.
  assertEquals(F.d3PorchReadout({ roof: { type: "gable", porchDepthFt: 6 } }, "12x16"), null);
  assertEquals(F.d3PorchReadout(null, "12x16"), null);
});

// ── THE NEW FRAME (roof.front / roof.highSide, 2026-09-24) ──────────────────────────────────────
// FRONT is the south wall. With a frame key on the style, porchEnd "front"/"back" name the south and
// north walls whatever kind of wall they are; without one, every answer above stands.
const FARM = { type: "shed", highSide: "front", pitch: 0.3, overhang: 1, porchOutFt: 5, porchEnd: "front" };

Deno.test("new frame: the porch takes the front (south) or back (north) wall, gable end or eave", () => {
  assertEquals(F.d3ProjectingPorch(FARM, 16, 10), { D: 5, wall: "south" });
  assertEquals(F.d3ProjectingPorch({ ...FARM, porchEnd: "back" }, 16, 10).wall, "north");
  for (const hs of ["front", "back", "left", "right"]) {
    assertEquals(F.d3ProjectingPorch({ ...FARM, highSide: hs }, 10, 16).wall, "south", `highSide ${hs}`);
  }
  for (const front of ["gable", "eave"]) {
    for (const [w, l] of [[28, 20], [12, 32]]) {
      assertEquals(F.d3ProjectingPorch({ type: "gable", front, porchOutFt: 6 }, w, l).wall, "south", `${front} ${w}x${l}`);
    }
  }
  // Without a key, today's rule: a landscape gable's porch is on its WEST gable end.
  assertEquals(F.d3ProjectingPorch({ type: "gable", porchOutFt: 6 }, 32, 12).wall, "west");
});

Deno.test("d3PorchSpan: a cap end spans S, an eave wall L, porchWidthFt narrows it; absent is today", () => {
  // Farmstand: the south wall is an EAVE wall (the slope runs front to back), 16 ft long.
  assertEquals(F.d3PorchSpan(FARM, 16, 10), { span: 16, centerU: 0, onCap: false, full: 16 });
  assertEquals(F.d3PorchSpan({ ...FARM, porchWidthFt: 10 }, 16, 10).span, 10);
  assertEquals(F.d3PorchSpan({ ...FARM, porchWidthFt: 40 }, 16, 10).span, 16, "never wider than its wall");
  assertEquals(F.d3PorchSpan({ ...FARM, porchWidthFt: 2 }, 16, 10).span, 4, "the sanitizer's floor");
  // highSide left: the slope runs across W, so the south wall is a sloped cap end.
  assertEquals(F.d3PorchSpan({ ...FARM, highSide: "left" }, 16, 10).onCap, true);
  // A gable-front 28x20: the porch on the gable end spans the profile, 28.
  assertEquals(F.d3PorchSpan({ type: "gable", front: "gable", porchOutFt: 6, porchWidthFt: 12 }, 28, 20), { span: 12, centerU: 0, onCap: true, full: 28 });
  assertEquals(F.d3PorchSpan({ type: "gable", front: "eave", porchOutFt: 6 }, 28, 20), { span: 28, centerU: 0, onCap: false, full: 28 });
  // No key: the gable end, S, exactly the span the renderer always passed d3PorchGeom.
  for (const [w, l] of [[12, 32], [32, 12], [16, 24]]) {
    const cfg = { type: "gambrel", porchOutFt: 6 };
    assertEquals(F.d3PorchSpan(cfg, w, l).span, F.d3RoofAxes(cfg, w, l).S);
    assertEquals(F.d3PorchSpan(cfg, w, l).onCap, true);
  }
  assertEquals(F.d3PorchSpan({ type: "gable" }, 12, 16), null);
});

Deno.test("porchAttachFt replaces H - 0.2 and is still held under capY; absent is today", () => {
  assertAlmostEquals(F.d3PorchGeom(16, 10, 5, PANEL_TRIM, Infinity, 8).yHigh, 8, 1e-12);
  assertAlmostEquals(F.d3PorchGeom(16, 10, 5, PANEL_TRIM, 7.5, 8).yHigh, 7.5, 1e-12);
  assertEquals(F.d3PorchGeom(16, 9, 6.5, PANEL_TRIM, Infinity, 0), F.d3PorchGeom(16, 9, 6.5, PANEL_TRIM, Infinity));
  assertEquals(F.d3PorchGeom(16, 9, 6.5, PANEL_TRIM, Infinity, undefined), F.d3PorchGeom(16, 9, 6.5, PANEL_TRIM, Infinity));
});

Deno.test("d3WallTopFt: only a new-frame shed's HIGH wall stands above H", () => {
  // No run = the wall's tallest top; a run = the lowest over it. One run on a shed, so both agree.
  const tops = (cfg: Any, w: number, l: number) => ["north", "south", "west", "east"].map((wall) => F.d3WallTopFt(cfg, w, l, 7, wall));
  const mids = (cfg: Any, w: number, l: number) => ["north", "south", "west", "east"].map((wall) => F.d3WallTopFt(cfg, w, l, 7, wall, 1, 3));
  assertEquals(tops(FARM, 16, 10), [7, 10, 7, 7]);
  assertEquals(tops({ ...FARM, highSide: "back" }, 16, 10), [10, 7, 7, 7]);
  assertEquals(tops({ ...FARM, highSide: "left" }, 16, 10), [7, 7, 7 + 16 * 0.3, 7]);
  assertEquals(tops({ ...FARM, highSide: "right" }, 16, 10), [7, 7, 7, 7 + 16 * 0.3]);
  assertEquals(mids(FARM, 16, 10), [7, 10, 7, 7]);
  assertEquals(F.d3WallTops(FARM, 16, 10, 7, "south"), [[0, 16, 10]], "one run, the whole front wall");
  // Set back by a recessed porch, it stops at H under the roof.
  assertEquals(F.d3WallTopFt(FARM, 16, 10, 7, "south", null, null, true), 7);
  assertEquals(F.d3WallTops(FARM, 16, 10, 7, "south", true), null);
  // No key: every wall is H, on every roof.
  for (const cfg of [{ type: "shed", pitch: 0.3 }, { type: "gable", front: "eave" }, { type: "gable" }]) {
    assertEquals(tops(cfg, 16, 10), [7, 7, 7, 7], JSON.stringify(cfg));
  }
});

Deno.test("the truss stands in a gable: none on an eave-wall front, the south gable on a gable front", () => {
  assertEquals(F.ssPorchTrussWall({ type: "gable", front: "eave", porchTruss: true, porchDepthFt: 4 }, 24, 12), null);
  assertEquals(F.ssPorchTrussWall({ type: "gable", front: "gable", porchTruss: true, porchDepthFt: 4 }, 24, 12), "south");
  assertEquals(F.ssPorchTrussWall({ type: "gable", front: "gable", porchTruss: true, porchDepthFt: 4, porchEnd: "back" }, 24, 12), "north");
});

Deno.test("d3PorchReadout reads the high wall and the attach height the renderer builds with", () => {
  const r = F.d3PorchReadout({ roof: { ...FARM, porchAttachFt: 8 }, wallHeightFt: 7 }, "16x10");
  assertEquals([r.wall, r.S, r.H, r.wallTop, r.attachFt], ["south", 16, 7, 10, 8]);
  assertAlmostEquals(r.yHigh, 8, 1e-12);
  assertAlmostEquals(r.attachNeeded, r.hNeeded - 0.2, 1e-12);
  // No attach: just under the HIGH wall's top, not under H.
  assertAlmostEquals(F.d3PorchReadout({ roof: FARM, wallHeightFt: 7 }, "16x10").yHigh, 9.8, 1e-12);
  assertEquals(F.d3PorchReadout({ roof: { ...FARM, porchWidthFt: 10 }, wallHeightFt: 7 }, "16x10").S, 10);
});

// ── THE CEILING THE BUILDING PUTS OVER THE PORCH (d3PorchCapFt, 2026-09-24 review) ─────────────────
// The renderer's clearance scan only sees members that reach past the wall's face, so on a flush roof
// an attach height above the wall floated the porch roof over the eave; and the readout, with no roof
// to measure, was feet off on eave-wall porches and under wings. One ceiling for both now.

Deno.test("⚠️ every stored style's porch: the ceiling is exactly H - 0.2, where its porch already sits", () => {
  const shapes: Array<[Any, number, number, number]> = [
    [{ type: "gable", pitch: 0.4, overhang: 0.6, porchOutFt: 6 }, 16, 24, 9],
    [{ type: "gable", pitch: 0.33, overhang: 1, eave: "open", porchOutFt: 6 }, 14, 20, 8],
    [{ type: "gambrel", pitch: 1.2, overhang: 0.15, kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1, porchOutFt: 6.5 }, 16, 24, 9],
    [{ type: "gambrel", overhang: 0.15, porchOutFt: 6, porchEnd: "back" }, 12, 16, 7],
    [{ type: "shed", pitch: 0.25, overhang: 0.6, porchOutFt: 6 }, 12, 20, 8],
    [{ type: "shed", pitch: 0.23, overhang: 1, porchOutFt: 4, eave: "open" }, 10, 16, 7],
    [{ type: "gable", pitch: 0.4, overhang: 0.5, porchOutFt: 6.5, leanToWidthFt: 8, leanToSide: "left" }, 16, 24, 9],
    [{ type: "gable", pitch: 0.4, overhang: 0, porchOutFt: 6 }, 32, 12, 8],
  ];
  for (const [cfg, w, l, H] of shapes) {
    for (const trim of [PANEL_TRIM, 0.26]) assertEquals(F.d3PorchCapFt(cfg, w, l, H, trim), H - 0.2, JSON.stringify(cfg));
    // And so the readout says what it always said.
    assertEquals(F.d3PorchReadout({ roof: cfg, wallHeightFt: H }, `${w}x${l}`).yHigh, H - 0.2, JSON.stringify(cfg));
  }
  assertEquals(F.d3PorchCapFt({ type: "gable", porchDepthFt: 6 }, 12, 16, 8, PANEL_TRIM), Infinity);
});

Deno.test("⚠️ a flush roof holds a high attach height under the wall's own outline (it floated over the eave)", () => {
  // Gable front, overhang 0, 10 ft walls, attach 12: nothing reaches past the wall, and the porch roof
  // hung 2 ft above the eaves across all 28 ft. Held under the wall's corners now.
  const F28 = { type: "gable", front: "gable", pitch: 0.5, overhang: 0, porchOutFt: 6, porchAttachFt: 12 };
  assertAlmostEquals(F.d3PorchReadout({ roof: F28, wallHeightFt: 10 }, "28x20").yHigh, 9.8, 1e-12);
  // A narrow porch in the middle of that gable may go up into it, under the rake line over its sheet.
  const narrow = F.d3PorchReadout({ roof: { ...F28, porchWidthFt: 8, porchAttachFt: 13 }, wallHeightFt: 10 }, "28x20");
  assertAlmostEquals(narrow.yHigh, 13, 1e-12);
  const high = F.d3PorchReadout({ roof: { ...F28, porchWidthFt: 8, porchAttachFt: 24 }, wallHeightFt: 10 }, "28x20");
  assertAlmostEquals(high.yHigh, 10 + (14 - (4 + PANEL_TRIM + 0.08)) * 0.5 - 0.2, 1e-9);
  // A shed's LOW wall with a flush roof: attach 8.5 on a 7 ft wall ran into the main roof slab.
  const E = { type: "shed", highSide: "front", pitch: 0.3, overhang: 0, porchOutFt: 5, porchEnd: "back", porchAttachFt: 8.5 };
  assertAlmostEquals(F.d3PorchReadout({ roof: E, wallHeightFt: 7 }, "16x10").yHigh, 6.8, 1e-12);
});

Deno.test("an eave-wall porch hangs under the eave over it, as the renderer measures it", () => {
  // 24x14, front "eave", pitch 0.5, overhang 1.5, 8 ft walls: the panel said 7' 10" while the 3D hung
  // the porch roof under the eave finish at 7.27.
  const roof = { type: "gable", front: "eave", pitch: 0.5, overhang: 1.5, porchOutFt: 6 };
  const k = 0.5, ny = 1 / Math.sqrt(1 + k * k);
  const eaveY = 8 - 1.5 * k * ny;
  const r = F.d3PorchReadout({ roof, wallHeightFt: 8 }, "24x14");
  assertAlmostEquals(r.yHigh, eaveY - F.d3EaveFinishDrop(roof, ny) - 0.03, 1e-12);
  assertAlmostEquals(r.yHigh, 7.267, 0.001);
  assertEquals(r.atMost, false);
  assertEquals(r.pitchClamped, true, "the porch roof is pushed to its flattest pitch, and the panel now says so");
  // An open eave's tails hang lower than a notched soffit.
  assert(F.d3PorchReadout({ roof: { ...roof, eave: "open" }, wallHeightFt: 8 }, "24x14").yHigh < r.yHigh);
  // A shed's HIGH wall with open tails: under the tails where they cross the wall face.
  const farm = { type: "shed", highSide: "front", pitch: 0.3, overhang: 1, eave: "open", porchOutFt: 5 };
  const top = 7 + 10 * 0.3;
  assertAlmostEquals(F.d3PorchReadout({ roof: farm, wallHeightFt: 7 }, "16x10").yHigh,
    top + 0.3 * 0.155 - (3.5 / 12 - 0.02) * Math.sqrt(1.09) - 0.03, 1e-12);
});

Deno.test("with wings a centre porch hangs under the wing roofs its sheet reaches under", () => {
  // 28x20 gable front, both wings 8 ft at 0.2, centre eave 15, 9 ft walls: the panel said 14' 10" with
  // 13' 1" posts; the 3D hangs the porch roof at about 10.36, under the wing roofs.
  const roof = { type: "gable", front: "gable", pitch: 0.67, overhang: 1, wingSide: "both", wingWidthFt: 8, wingPitch: 0.2, centerEaveFt: 15, porchOutFt: 6 };
  const r = F.d3PorchReadout({ roof, wallHeightFt: 9 }, "28x20");
  const edge = 6 + PANEL_TRIM + 0.08;                 // the sheet's edge, just past the centre wall line
  assertAlmostEquals(r.yHigh, 9 + (14 - edge) * 0.2 - 0.2, 1e-9);
  assert(r.yHigh > 10.3 && r.yHigh < 10.4, String(r.yHigh));
  assertEquals(r.wallTop, 15);
  // Wider than the centre: under the wing roofs further out, so lower still, and never above H.
  const wide = F.d3PorchReadout({ roof: { ...roof, porchWidthFt: 20 }, wallHeightFt: 9 }, "28x20");
  assertAlmostEquals(wide.yHigh, 9 + (14 - (10 + PANEL_TRIM + 0.08)) * 0.2 - 0.2, 1e-9);
  const full = F.d3PorchReadout({ roof: { ...roof, porchWidthFt: 28, porchAttachFt: 14 }, wallHeightFt: 9 }, "28x20");
  assertAlmostEquals(full.yHigh, 9 - 0.2, 1e-12);
  // A gable-end porch whose roof reaches out past the wall: the renderer measures that, the panel says "at most".
  assertEquals(r.atMost, true);
  assertEquals(F.d3PorchReadout({ roof: { ...roof, overhang: 0 }, wallHeightFt: 9 }, "28x20").atMost, false);
});
