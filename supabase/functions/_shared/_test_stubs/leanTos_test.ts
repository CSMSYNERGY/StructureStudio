// AS MANY LEAN-TOS AS THEY WANT, EACH WHERE THEY WANT — tested against BOTH SHIPPED designer twins.
//
// roof.leanTos (2026-09-29, Carolyn: "they can add a lean-to and specify where they want it, and add
// another one and specify where they want it ... as many lean-tos ... wherever they want"): a list of up
// to six, each on a building wall (front is south, left is west, the renderer's frame), with its own
// width, drop, attach, run along the wall and walls. Everything about it that is not a mesh is pure
// module-scope code: d3LeanToList / d3HasLeanTos / d3AnyLeanTo, d3LeanToWall (which wall is an eave and
// which a gable end, in the roof's own frame), d3LeanToRun (how much of the wall, and where),
// d3LeanTosGeom (each one's numbers at a size), d3LeanTosReadout (the Advanced page's cards), and the
// readers that change beside a list: d3LeanToGeom (the single lean-to, which a list replaces),
// d3RoofStep (refused beside any lean-to) and d3RoofLands (a lean-to up the roof covers a dormer). They
// are lifted by stable anchors and run, the wingsMassing_test technique, and each lifted region is
// asserted byte-identical across the two hand-mirrored twins. The meshes are proved on the compiled
// bundle by tests/harness/leanTos.mjs.
//
// The promise tested hardest: WITHOUT A DRAWABLE LIST, NOTHING MOVES.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `leanTos_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_CASE_F =", "// Built-in 3D appearance per building style"],
  // d3RoofAxes, d3Massing, d3LeanToGeom, the lean-to list, d3RoofStep, d3RoofLands, d3DormerCovered.
  ["function d3RoofAxes(", "function d3FtIn("],
  // ssPorchTrussWall, d3ProjectingPorch, d3PorchSpan.
  ["function ssVentSpan(", "function buildFixtureTools("],
  // d3EaveFinishDrop, which the eave-wall readout hangs the roof edge's boards at.
  ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  ["function d3PorchGeom(", "function d3PorchReadout("],
  // d3LeanToReadout, d3LeanToFascia, d3LeanTosReadout.
  ["function d3PorchReadout(", "// A dimensioned end-elevation of the style"],
];
const blocks = REGIONS.map(([a, b]) => ({ a, cmp: lift(CMP, "structure-studio.component.js", a, b), jsx: lift(JSX, "StructureStudio.jsx", a, b) }));

Deno.test("every lifted lean-to region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `const isVentItem = (it) => !!(it && it.isVent);\n${blocks.map((b) => b.cmp).join("\n")}; return { D3, d3RoofAxes, d3Massing, d3LeanToGeom, d3LeanToList, d3HasLeanTos, d3AnyLeanTo, ` +
    `d3LeanToWall, d3LeanToRun, d3LeanTosGeom, d3LeanTosReadout, d3LeanToReadout, d3RoofStep, d3RoofLands, d3DormerCovered, d3PorchReadout, D3_LEANTOS_MAX };`,
)() as Record<string, Any>;

const H = 8;
const GABLE = { type: "gable", pitch: 0.4, overhang: 0.6 };
const SINGLE = { leanToWidthFt: 8, leanToDropFt: 2, leanToSide: "left" };
const specOf = (roof: Record<string, unknown>) => ({ roof, wallHeightFt: H });

// ── ONE: no list, no change ─────────────────────────────────────────────────────────────────

Deno.test("⚠️ without a drawable list every reader answers exactly what the roof without one answers", () => {
  const roofs = [GABLE, { ...GABLE, ...SINGLE }, { ...GABLE, ...SINGLE, leanToAttach: "roof", leanToAttachFt: 1 }, { type: "shed", highSide: "left", pitch: 0.25, ...SINGLE, leanToSide: "right" },
    { type: "gable", front: "gable", pitch: 0.41, rearStepFt: 12, rearEaveRiseFt: 0.4 }, { type: "gambrel", wingWidthFt: 6, wingAttach: "roof", wingAttachFt: 1, dormerWidthFt: 4, dormerType: "transom", dormerOffsetU: 0.6 }];
  const junk = [undefined, null, [], "left", [{ wall: "top", widthFt: 8 }], [{ wall: "left" }], [{ wall: "left", widthFt: 0.5 }], [null, 3]];
  for (const roof of roofs) {
    for (const leanTos of junk) {
      const withKey = { ...roof, leanTos };
      assertEquals(F.d3HasLeanTos(withKey), false, JSON.stringify(leanTos));
      for (const [W, L] of [[12, 16], [16, 12], [14, 40]]) {
        assertEquals(F.d3LeanTosGeom(withKey, W, L, H), null);
        assertEquals(F.d3LeanToGeom(withKey, W, L, H), F.d3LeanToGeom(roof, W, L, H), "the single lean-to");
        // (Its rearCfg is the roof spread, so it carries the junk key along; the step itself is compared.)
        const stepOf = (st: Any) => st && [st.stepFt, st.rise, st.Hf, st.Hb, st.pitch, st.pitchB];
        assertEquals(stepOf(F.d3RoofStep(withKey, W, L, H)), stepOf(F.d3RoofStep(roof, W, L, H)), "the roof step");
        const m = F.d3Massing(roof, W, L, H);
        assertEquals(F.d3RoofLands(withKey, F.d3Massing(withKey, W, L, H), W, L, H), F.d3RoofLands(roof, m, W, L, H), "the roof lands");
        assertEquals(F.d3LeanToReadout(specOf(withKey), `${W}x${L}`), F.d3LeanToReadout(specOf(roof), `${W}x${L}`), "the single lean-to's readout");
        assertEquals(F.d3LeanTosReadout(specOf(withKey), `${W}x${L}`), null);
      }
    }
  }
  assertEquals(F.d3AnyLeanTo({ ...GABLE, ...SINGLE }), true, "the single lean-to is a lean-to");
  assertEquals(F.d3AnyLeanTo(GABLE), false);
});

Deno.test("a drawable list replaces the single lean-to: its keys describe nothing beside it", () => {
  const roof = { ...GABLE, ...SINGLE, leanToAttach: "roof", leanToAttachFt: 1, leanTos: [{ wall: "front", widthFt: 6 }] };
  assertEquals(F.d3LeanToGeom(roof, 12, 16, H), null);
  assertEquals(F.d3LeanToReadout(specOf(roof), "12x16"), null);
  assertEquals(F.d3AnyLeanTo({ ...GABLE, leanTos: [{ wall: "front", widthFt: 6 }] }), true);
  // Six at most are read; the index is the entry's place in the stored list, junk entries skipped.
  const many = Array.from({ length: 8 }, (_, i) => ({ wall: "left", widthFt: 2 + i }));
  assertEquals(F.d3LeanToList({ leanTos: many }).map((x: Any) => x.i), [0, 1, 2, 3, 4, 5]);
  assertEquals(F.d3LeanToList({ leanTos: [{ wall: "x", widthFt: 4 }, { wall: "back", widthFt: 4 }] }).map((x: Any) => x.i), [1]);
});

// ── TWO: which wall is which ────────────────────────────────────────────────────────────────

Deno.test("each wall is the one standing in front of the front wall names, on every footprint and frame", () => {
  // 12x16, the old frame: the ridge runs north-south (u = world x), so left/right are eave walls.
  const a = F.d3RoofAxes(GABLE, 12, 16);
  assertEquals(F.d3LeanToWall(a, "left"), { kind: "eave", dir: -1, along: 1, wallLen: 16 });
  assertEquals(F.d3LeanToWall(a, "right"), { kind: "eave", dir: 1, along: 1, wallLen: 16 });
  assertEquals(F.d3LeanToWall(a, "front"), { kind: "gable", atL: true, sz: 1, along: 1, wallLen: 12 });
  assertEquals(F.d3LeanToWall(a, "back"), { kind: "gable", atL: false, sz: -1, along: 1, wallLen: 12 });
  // 16x12: the ridge runs east-west (u = world z, the roof group turned a quarter: world x = L/2 - z).
  const b = F.d3RoofAxes(GABLE, 16, 12);
  assertEquals(F.d3LeanToWall(b, "front"), { kind: "eave", dir: 1, along: -1, wallLen: 16 });
  assertEquals(F.d3LeanToWall(b, "back"), { kind: "eave", dir: -1, along: -1, wallLen: 16 });
  assertEquals(F.d3LeanToWall(b, "right"), { kind: "gable", atL: false, sz: -1, along: 1, wallLen: 12 });
  assertEquals(F.d3LeanToWall(b, "left"), { kind: "gable", atL: true, sz: 1, along: 1, wallLen: 12 });
  // The new frame names it: a long-side front turns the eave walls to the front and back.
  const c = F.d3RoofAxes({ ...GABLE, front: "eave" }, 12, 16);
  assertEquals(F.d3LeanToWall(c, "front").kind, "eave");
  assertEquals(F.d3LeanToWall(c, "left").kind, "gable");
  // A shed's high and low walls are its eave walls.
  const s = F.d3RoofAxes({ type: "shed", highSide: "front", pitch: 0.25 }, 12, 16);
  assertEquals([F.d3LeanToWall(s, "front").kind, F.d3LeanToWall(s, "back").kind, F.d3LeanToWall(s, "left").kind], ["eave", "eave", "gable"]);
});

Deno.test("a run: the whole wall, or lengthFt centred offsetFt from the middle and held inside the wall", () => {
  assertEquals(F.d3LeanToRun({}, 16), { whole: true, len: 16, off: 0, room: 0 });
  assertEquals(F.d3LeanToRun({ lengthFt: 20 }, 16).whole, true, "longer than the wall is the whole wall");
  assertEquals(F.d3LeanToRun({ lengthFt: 6, offsetFt: 3 }, 16), { whole: false, len: 6, off: 3, room: 5, offHeld: false });
  assertEquals(F.d3LeanToRun({ lengthFt: 6, offsetFt: -9 }, 16), { whole: false, len: 6, off: -5, room: 5, offHeld: true });
  assertEquals(F.d3LeanToRun({ lengthFt: 1, offsetFt: 0 }, 16).len, 2, "at least 2 ft");
});

// ── THREE: what each one builds ─────────────────────────────────────────────────────────────

Deno.test("on an eave wall a listed lean-to is the single lean-to's geometry exactly, whatever its attach", () => {
  for (const [side, wall] of [["left", "left"], ["right", "right"]]) {
    for (const att of [{ attach: "wall", attachFt: 1 }, { attach: "roof", attachFt: 1.5 }]) {
      const legacy = F.d3LeanToGeom({ ...GABLE, leanToWidthFt: 8, leanToDropFt: 2, leanToSide: side, leanToAttach: (att as Any).attach, leanToAttachFt: (att as Any).attachFt }, 12, 16, H);
      const q = F.d3LeanTosGeom({ ...GABLE, leanTos: [{ wall, widthFt: 8, dropFt: 2, ...att }] }, 12, 16, H)[0];
      for (const k of ["dir", "u0", "u1", "ua", "ya", "y1", "E", "k", "drop", "d", "at", "mode", "pitch", "clamped", "flat", "noRoof", "cuts"]) assertEquals(q[k], legacy[k], `${wall} ${JSON.stringify(att)} ${k}`);
      assertEquals([q.kind, q.a0, q.a1, q.whole, q.attach], ["eave", 0, 16, true, (att as Any).attach || null]);
    }
  }
  // Absent attach is at the eave: the plate, as today's lean-to hangs, on a gable roof.
  const q = F.d3LeanTosGeom({ ...GABLE, leanTos: [{ wall: "left", widthFt: 8 }] }, 12, 16, H)[0];
  assertEquals([q.ua, q.ya, q.y1, q.at], [-6, 8, 7, 0]);
  assertAlmostEquals(q.pitch, 1 / 8, 1e-12);
});

// Review, 2026-09-30: converting a style's single lean-to into the list moved it 3 ft up on a shed's high
// side (and 8 ft beside a single wing), because an absent attach was read as "on the wall, 0 ft below the
// EAVE" while the single lean-to hangs at the PLATE. Absent attach is now the single lean-to's own lines.
Deno.test("with no attach it hangs at wall height, line for line the single lean-to without one, wherever the eave is", () => {
  // buildShed3DModel's lines for the single lean-to without an attach: from the wall line at the plate H, its
  // outer edge the drop under that, the drop held to H - 1.5 and never lifted to a sliver of slope.
  const lines = (roof: Any, W: number, L: number, dropFt: number, side: string) => {
    const m = F.d3Massing(roof, W, L, H);
    const dir = side === "left" ? -1 : 1;
    const drop = Math.min(dropFt, H - 1.5);
    return { u0: dir * (m.S / 2), ya: H, y1: H - drop };
  };
  const cases: Array<[string, Any, number, number, string, number, number | null]> = [
    ["a plain gable", { ...GABLE }, 12, 16, "left", 2, 0],
    ["a shed's high side", { type: "shed", highSide: "left", pitch: 0.25 }, 12, 16, "left", 1.5, 3],
    ["the centre's own wall beside a single wing", { ...GABLE, front: "gable", pitch: 0.5, wingSide: "left", wingWidthFt: 6, wingPitch: 0.25 }, 24, 16, "right", 1, null],
    ["a drop past the cap", { ...GABLE }, 12, 16, "right", 9, 0],
    ["no drop at all", { ...GABLE }, 12, 16, "left", 0, 0],
  ];
  for (const [what, roof, W, L, side, drop, gap] of cases) {
    const q = F.d3LeanTosGeom({ ...roof, leanTos: [{ wall: side, widthFt: 8, dropFt: drop }] }, W, L, H)[0];
    const want = lines(roof, W, L, drop, side);
    assertEquals([q.kind, q.u0, q.ua, q.ya, q.y1, q.mode, q.flat, q.cuts, q.clamped], ["eave", want.u0, want.u0, want.ya, want.y1, null, false, false, false], what);
    assertAlmostEquals(q.pitch, (want.ya - want.y1) / 8, 1e-12, what);
    // `at` is how far under the eave it meets, what the card and the End view print.
    assertAlmostEquals(q.at, q.E - H, 1e-12, what);
    if (gap !== null) assertAlmostEquals(q.at, gap, 1e-9, what);
    else assert(q.E > H + 0.01, `${what}: the eave stands above the plate (${q.E})`);
  }
  // Its card reads it the same way: no roof-edge warning where it always hung (the single lean-to had none).
  const r = F.d3LeanTosReadout({ roof: { type: "shed", highSide: "left", pitch: 0.25, leanTos: [{ wall: "left", widthFt: 8, dropFt: 1.5 }] }, wallHeightFt: H }, "12x16")[0];
  assertEquals([r.mode, r.fasciaCuts, r.openTop, r.ya], [null, false, null, H]);
  assertAlmostEquals(r.at, 3, 1e-9);
});

Deno.test("off a wing: it hangs from the wing's outer wall at its eave -- a wing on a wing", () => {
  const roof = { ...GABLE, front: "gable", wingSide: "both", wingWidthFt: 6, wingPitch: 0.25, leanTos: [{ wall: "left", widthFt: 8, dropFt: 1, enclosed: true }] };
  const q = F.d3LeanTosGeom(roof, 24, 30, H)[0];
  assertEquals([q.u0, q.u1, q.E, q.enclosed], [-12, -20, H, true]);
  assertAlmostEquals(q.k, 0.25, 1e-12, "the wing roof's slope is the leg above it");
});

Deno.test("on a gable end: at wall height, or d down the wall; On the roof is ignored, never switched", () => {
  const at = (e: Record<string, unknown>) => F.d3LeanTosGeom({ ...GABLE, leanTos: [{ wall: "front", widthFt: 6, dropFt: 1.5, ...e }] }, 12, 16, H)[0];
  const q = at({});
  assertEquals([q.kind, q.zW, q.zO, q.ya, q.y1, q.at, q.roofIgnored], ["gable", 16, 22, 8, 6.5, 0, false]);
  assertAlmostEquals(q.pitch, 1.5 / 6, 1e-12);
  assertEquals([q.a0, q.a1], [-6, 6], "the whole end wall, across the span");
  const w = at({ attach: "wall", attachFt: 1 });
  assertEquals([w.ya, w.at, w.mode], [7, 1, "wall"]);
  const r = at({ attach: "roof", attachFt: 2 });
  assertEquals([r.ya, r.at, r.roofIgnored, r.mode], [8, 0, true, null]);
  const flat = at({ attach: "wall", attachFt: 3 });
  assertEquals([flat.flat, flat.ya], [true, 6.55], "not below its own outer edge: a sliver of slope, flagged");
  const back = F.d3LeanTosGeom({ ...GABLE, leanTos: [{ wall: "back", widthFt: 4 }] }, 12, 16, H)[0];
  assertEquals([back.zW, back.zO, back.sz], [0, -4, -1]);
});

Deno.test("a partial run lands where the builder slid it, toward the front or the right, in the roof's own axes", () => {
  // 12x16: the left wall runs along z (world z = z - 8); +3 toward the front is z 8+3 = 11.
  const l = F.d3LeanTosGeom({ ...GABLE, leanTos: [{ wall: "left", widthFt: 6, lengthFt: 6, offsetFt: 3 }] }, 12, 16, H)[0];
  assertEquals([l.a0, l.a1, l.len, l.off, l.whole], [8, 14, 6, 3, false]);
  // The front gable end runs along u = world x: +2 toward the right is u = 2.
  const f = F.d3LeanTosGeom({ ...GABLE, leanTos: [{ wall: "front", widthFt: 6, lengthFt: 4, offsetFt: 2 }] }, 12, 16, H)[0];
  assertEquals([f.a0, f.a1], [0, 4]);
  // 16x12: the front is an eave wall running along z with world x = L/2 - z, so toward the right is -z.
  const g = F.d3LeanTosGeom({ ...GABLE, leanTos: [{ wall: "front", widthFt: 6, lengthFt: 4, offsetFt: 2 }] }, 16, 12, H)[0];
  assertEquals([g.kind, g.a0, g.a1], ["eave", 4, 8]);
});

Deno.test("the roof step is refused beside a listed lean-to", () => {
  const step = { type: "gable", front: "gable", pitch: 0.41, rearStepFt: 12, rearEaveRiseFt: 0.4 };
  assert(F.d3RoofStep(step, 14, 40, H), "alone it is drawn");
  assertEquals(F.d3RoofStep({ ...step, leanTos: [{ wall: "back", widthFt: 4, lengthFt: 4 }] }, 14, 40, H), null);
});

// ── FOUR: the cards' readouts ───────────────────────────────────────────────────────────────

Deno.test("the readout says overlaps, a porch behind one, how high openings go, and never moves anything", () => {
  const roof = { ...GABLE, porchOutFt: 6, porchEnd: "front", leanTos: [
    { wall: "left", widthFt: 8, lengthFt: 8, offsetFt: -2 },
    { wall: "left", widthFt: 6, lengthFt: 8, offsetFt: 3 },
    { wall: "front", widthFt: 5 },
    { wall: "right", widthFt: 8, dropFt: 2, attach: "wall", attachFt: 1 },
  ] };
  const rs = F.d3LeanTosReadout(specOf(roof), "12x16");
  assertEquals(rs.map((r: Any) => r.i), [0, 1, 2, 3]);
  assertEquals(rs[0].overlaps, [1], "lean-tos 1 and 2 share 3 ft of the left wall");
  assertEquals(rs[1].overlaps, [0]);
  assertEquals([rs[2].overlaps, rs[3].overlaps], [[], []]);
  assertEquals(rs[2].porch, "projecting", "the front lean-to stands where the porch is");
  assertEquals([rs[0].porch, rs[3].porch], [null, null]);
  assertEquals(rs[3].openTop, Math.floor((7 - 0.2) * 12 + 1e-6) / 12, "on the wall 1 ft down: openings under its line");
  assertEquals(rs[0].openTop, null, "at the eave: the wall's own rule");
  // Nothing was moved to dodge: each is built where it was put.
  assertEquals([rs[0].a0, rs[0].a1, rs[1].a0, rs[1].a1], [2, 10, 7, 15]);
  // An eave lean-to up the roof reports the roof it cuts, as the single one does.
  const steep = F.d3LeanTosReadout(specOf({ type: "shed", highSide: "left", pitch: 0.25, leanTos: [{ wall: "right", widthFt: 8, dropFt: 2, attach: "roof", attachFt: 1 }] }), "12x16")[0];
  assertEquals(steep.cuts, true);
  assert(steep.dropMax != null && steep.widthMin != null, "with the drop and the width that fix it");
  // The porch readout knows a lean-to is there, as it does the single one.
  assertEquals(F.d3PorchReadout(specOf({ ...GABLE, front: "eave", porchOutFt: 6, leanTos: [{ wall: "back", widthFt: 4 }] }), "12x16").atMost, true);
});

Deno.test("a lean-to up the roof covers a dormer only where its run reaches the dormer", () => {
  const base = { ...GABLE, dormerWidthFt: 4, dormerType: "gable", dormerOffsetU: -0.45 };
  const m = F.d3Massing(base, 12, 16, H);
  const whole = { ...base, leanTos: [{ wall: "left", widthFt: 8, dropFt: 1, attach: "roof", attachFt: 2 }] };
  const lands = F.d3RoofLands(whole, m, 12, 16, H);
  assertAlmostEquals(lands[-1], -6 + 2 / 0.4, 1e-9, "it lands 2 ft up, 5 ft in");
  const aside = { ...base, leanTos: [{ wall: "left", widthFt: 8, dropFt: 1, attach: "roof", attachFt: 2, lengthFt: 4, offsetFt: 6 }] };
  assertEquals(F.d3RoofLands(aside, m, 12, 16, H), null, "a short one at the front end is not over the dormer");
  const dc = F.d3DormerCovered(specOf(whole), "12x16");
  assertEquals(dc && [dc.dir, dc.by], [-1, "lean-to"]);
});
