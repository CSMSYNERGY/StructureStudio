// A LEAN-TO THAT MEETS THE PORCH — tested against BOTH SHIPPED designer twins.
//
// Carolyn's wrap-around (10-01), with a projecting porch on one wall and a lean-to on the wall beside it: one
// roof round the corner with a hip. A shed-roofed porch is an end-wall lean-to in all but name, so
// d3PorchJoins pairs it with each lean-to that runs to a corner of the porch's wall -- joined only when the
// builder asks (the lean-to's meetPorch, its card's "Meet the porch") and the two already match: their roofs'
// TOPS meet the walls at one height and fall at one pitch. A porch's height is its roof's top at the wall's
// face; a lean-to's, its slab's underside on its wall line, so the lean-to's number for the match is the porch
// roof's top over the wall's line less the slab's thickness there (ya), and its outer edge that line as far out
// as it is wide. Otherwise a near-miss with its reason and numbers, and the lean-to's card says what its own
// boxes would read to match (d3LeanTosReadout's porchCorner). Joined, the porch is built from its readout's
// numbers and the clearance scan does not lower it, so those numbers already sit under the main roof's eave
// corners (d3PorchEaveCornerCapFt), and any other lean-to left over the porch stops the join. Pure module-scope
// code, lifted by the
// same anchors as leanToCorners_test and run; every lifted region is asserted byte-identical across the two
// hand-mirrored twins. The meshes (the porch's members run on round the corner and cut on the hip, the corner
// post, the headers) are proved on the compiled bundle by tests/harness/leanTos.mjs case M and porchProbe.mjs.
//
// The promise tested hardest: NOTHING IS NUDGED, NOTHING JOINS UNASKED, AND WITHOUT A JOIN NOTHING CHANGES.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `leanToPorch_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_CASE_F =", "// Built-in 3D appearance per building style"],
  // d3RoofAxes, d3Massing, the lean-to list, d3CornerJoins, d3PorchJoins, d3PorchToRoot.
  ["function d3RoofAxes(", "function d3FtIn("],
  // d3ProjectingPorch, d3PorchSpan.
  ["function ssVentSpan(", "function buildFixtureTools("],
  ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  ["function d3PorchGeom(", "function d3PorchReadout("],
  // d3PorchReadout, d3LeanTosReadout.
  ["function d3PorchReadout(", "// A dimensioned end-elevation of the style"],
];
const blocks = REGIONS.map(([a, b]) => ({ a, cmp: lift(CMP, "structure-studio.component.js", a, b), jsx: lift(JSX, "StructureStudio.jsx", a, b) }));

Deno.test("every lifted region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `const isVentItem = (it) => !!(it && it.isVent);\n${blocks.map((b) => b.cmp).join("\n")}; ` +
    `return { D3, d3RoofAxes, d3LeanTosGeom, d3LeanTosReadout, d3CornerJoins, d3PorchJoins, d3PorchReadout, d3PorchToRoot, d3PorchCapFt, d3PorchEaveCornerCapFt, D3_LT_CORNER_TOL };`,
)() as Record<string, Any>;

const H = 8;
// A 12x16 with its front a gable end, and a projecting porch across it, 8 ft deep, hung at 7' 6" and asked 2 in
// 12 -- which the 6 ft under its beam lowers to about 1.15 in 12 (d3PorchGeom).
const PORCH = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, porchOutFt: 8, porchAttachFt: 7.5, porchPitch: 2 / 12 };
const spec = (roof: Any, h = H) => ({ roof, wallHeightFt: h });
const porchOf = (roof: Any, size = "12x16", h = H) => F.d3PorchReadout(spec(roof, h), size);
const rdOf = (roof: Any, size = "12x16", h = H) => F.d3LeanTosReadout(spec(roof, h), size);
const sizeOf = (size: string) => size.split("x").map(Number) as [number, number];
const joinsOf = (roof: Any, size = "12x16", h = H) => F.d3PorchJoins(roof, ...sizeOf(size), h);
// The lean-to's own boxes, as its card says to set them to match the porch (porchCorner.fix).
const matched = (roof: Any, size = "12x16", h = H) => {
  const rs = rdOf(roof, size, h);
  return { ...roof, leanTos: roof.leanTos.map((e: Any, i: number) => {
    const r = rs.find((x: Any) => x.i === i);
    const f = r && r.porchCorner && r.porchCorner.fix;
    return f ? { ...e, attach: f.attach || undefined, attachFt: f.attach ? f.attachFt : undefined, dropFt: f.dropFt } : e;
  }) };
};
const P0 = porchOf(PORCH);
// The lean-to's own number for the match: the porch roof's top over the wall's line (7' 6" at the wall's face, 0.15 ft
// out), less a 0.2 ft lean-to slab's thickness there -- about 7' 3.8".
const YA = P0.yHigh + P0.pitch * P0.dWall - 0.1 * (1 + Math.sqrt(1 + P0.pitch * P0.pitch));
// The right lean-to, 8 ft out, met that far down its wall, its outer edge on the porch roof's slope 8 ft out from there.
const RIGHT = { wall: "right", widthFt: 8, attach: "wall", attachFt: 8 - YA, dropFt: 8 - YA + P0.pitch * 8 };
// A building corner in the world (front +z, right +x), through the roof group's own placement: u along x
// with z - L/2 down the ridge, or turned a quarter, x = L/2 - z (the renderer's rgRoot, no wings).
const world = (roof: Any, W: number, L: number, u: number, z: number) => {
  const ax = F.d3RoofAxes(roof, W, L);
  return ax.uAxisIsX ? [u, z - ax.L / 2] : [ax.L / 2 - z, u];
};

// ── ONE: without a join, nothing changes ────────────────────────────────────────────────────

Deno.test("⚠️ no porch, no list, or no lean-to that runs to a corner of the porch's wall: null, and no card or porch readout gains a key", () => {
  assertEquals(joinsOf(PORCH), null, "a porch alone");
  assertEquals(joinsOf({ ...PORCH, leanToWidthFt: 8, leanToSide: "right" }), null, "the single lean-to");
  assertEquals(joinsOf({ ...PORCH, porchOutFt: 0, leanTos: [{ ...RIGHT, meetPorch: true }] }), null, "no porch");
  assertEquals(joinsOf({ ...PORCH, porchOutFt: undefined, porchDepthFt: 6, leanTos: [{ ...RIGHT, meetPorch: true }] }), null, "a recessed porch");
  const away = [
    [{ wall: "front", widthFt: 6, meetPorch: true }],                       // on the porch's own wall
    [{ wall: "back", widthFt: 6, meetPorch: true }],                        // the far end wall
    [{ ...RIGHT, lengthFt: 8, meetPorch: true }],                           // stops 4 ft short of the front
    [{ ...RIGHT, lengthFt: 8, offsetFt: -4, meetPorch: true }],             // slid to the back
  ];
  for (const leanTos of away) {
    const roof = { ...PORCH, leanTos };
    assertEquals(joinsOf(roof), null, JSON.stringify(leanTos));
    for (const r of rdOf(roof)) assert(!("porchCorner" in r), `no porchCorner on ${JSON.stringify(leanTos)}`);
    const p = porchOf(roof);
    assert(!("meets" in p) && !("edgeOver" in p) && p.atMost === true, "the porch reads as it always did");
    // And the asked key changes nothing at all.
    const plain = { ...roof, leanTos: leanTos.map(({ meetPorch: _m, ...e }) => e) };
    assertEquals(JSON.stringify(porchOf(roof)), JSON.stringify(porchOf(plain)), "porch readout, key for key");
    assertEquals(JSON.stringify(rdOf(roof)), JSON.stringify(rdOf(plain)), "lean-to cards, key for key");
  }
});

// ── TWO: the join itself ────────────────────────────────────────────────────────────────────

Deno.test("12x16, front porch 8 ft deep, right lean-to 8 ft out asked to meet it: one join at the front-right corner, the porch's numbers", () => {
  const roof = { ...PORCH, leanTos: [{ ...RIGHT, meetPorch: true }] };
  const r = joinsOf(roof);
  assertEquals([r.joins.length, r.near], [1, []]);
  const J = r.joins[0], p = P0.pitch;
  assertEquals([J.i, J.j, J.at, J.lt, J.dir, J.sz, J.uC, J.zC, J.js, J.w], [0, "porch", "front-right", "eave", 1, 1, 6, 16, 1, 8]);
  assertAlmostEquals(p, 0.0962222086, 1e-9, "2 in 12 lowered to leave 6 ft under the beam");
  assertAlmostEquals(YA, 7.3139714622, 1e-9, "the lean-to's number: 7' 6\" less the slab, 2.24 in");
  assertEquals([J.pitch, J.eP, J.dPost], [p, P0.dEnd, P0.dPost]);
  assertAlmostEquals(J.ya, YA, 1e-12);
  assertEquals([P0.dWall, P0.dPost, P0.dEnd], [0.15, 7.77, 8.3]);
  assertAlmostEquals(J.hdrIn, 7.77 - 0.29 / 2, 1e-12, "the porch header's inner face");
  // The lean-to on the porch roof's plane, at its own numbers: its top over its wall line where the porch roof's
  // would be over the porch's, so the two tops cross on the hip -- and it is built exactly where its card says.
  const Y0 = 7.5 + p * 0.15, lift0 = (0.2 / 2) * (1 + Math.sqrt(1 + p * p));
  assertAlmostEquals(J.y0, Y0 - lift0, 1e-12);
  assertAlmostEquals(J.y1, Y0 - lift0 - p * 8, 1e-12);
  const g0 = F.d3LeanTosGeom(roof, 12, 16, H)[0];
  assertAlmostEquals(J.y0, g0.ya, 1e-12, "built at its own height at the wall");
  assertAlmostEquals(J.y1, g0.y1, 1e-12, "...and its own outer edge");
  const ovh = 0.6 / Math.sqrt(1 + p * p);
  assertAlmostEquals(J.eL, 8 + ovh, 1e-12, "the lean-to's eave");
  // The hip: from the building's corner at the porch roof's top over it, out to the nearer eave (the porch's front
  // edge, 8.3 ft out, before the lean-to's 8.6).
  assertEquals(J.hip[0], [6, 16, Y0]);
  assertAlmostEquals(J.hip[1][0], 14.3, 1e-12);
  assertAlmostEquals(J.hip[1][1], 24.3, 1e-12);
  assertAlmostEquals(J.hip[1][2], Y0 - p * 8.3, 1e-12);
  assertEquals(J.post, [14, 23.77], "one corner post, where the lean-to's posts' line (u 14) crosses the porch's (7.77 out)");
  assertEquals(J.enc, [false, false]);
  assertEquals(r.ends, { 0: { a1: 0 } });
  const { cap, ya, ...porch } = r.porch;
  assertEquals(porch, { wall: "south", kind: "gable", yHigh: 7.5, pitch: p, dWall: 0.15, dPost: 7.77, dEnd: 8.3, hw: 6 });
  assertAlmostEquals(ya, YA, 1e-12);
  // Its ceiling: the right eave's corner 0.6 ft out, less the rake board's bottom corner there, less 0.03 -- over the
  // 7' 6" it is hung at, so it holds nothing here.
  assertAlmostEquals(cap, 8 - (0.6 * 0.4 + 0.14) / Math.sqrt(1.16) - 0.03, 1e-12);
  // The card says it; the porch's readout names it and is no longer "at most".
  assertEquals(rdOf(roof)[0].porchCorner, { at: "front-right", asked: true, joined: true, why: [] });
  const pj = porchOf(roof);
  assertEquals([pj.meets, pj.atMost, pj.edgeOver, P0.atMost], [[{ i: 0, at: "front-right" }], false, false, true]);
  // ...and its numbers are the same porch, the ones the lean-to matched.
  for (const k of ["yHigh", "pitch", "postH", "hdrTop", "posts", "dPost", "dEnd"]) assertEquals(pj[k], P0[k], k);
  // Enclosed is carried for the renderer's walls, the side-wall one's first.
  assertEquals(joinsOf({ ...roof, leanTos: [{ ...RIGHT, enclosed: true, meetPorch: true }] }).joins[0].enc, [true, false]);
});

Deno.test("never unasked: the same matching lean-to without meetPorch is offered, not joined, and the porch is untouched", () => {
  const roof = { ...PORCH, leanTos: [RIGHT] };
  const r = joinsOf(roof);
  assertEquals([r.joins, r.ends], [[], {}]);
  assertEquals(r.near.map((N: Any) => [N.i, N.at, N.asked, N.why]), [[0, "front-right", false, []]], "it would join if asked");
  const pc = rdOf(roof)[0].porchCorner;
  assertEquals([pc.asked, pc.joined, pc.why], [false, false, []]);
  const pj = porchOf(roof);
  assert(!("meets" in pj) && pj.atMost === true);
});

// ── THREE: exact, never nudged ──────────────────────────────────────────────────────────────

Deno.test("a near-miss at the wall, at the outer edge or both says by how much; nothing moves; the card's own numbers make it join", () => {
  const cases: Array<[string, Any, string[], number, number]> = [
    ["met at the eave, its outer edge where the match's is", { wall: "right", widthFt: 8, dropFt: RIGHT.dropFt }, ["height"], YA - 8, 0],
    ["3 in more drop", { ...RIGHT, dropFt: RIGHT.dropFt + 0.25 }, ["pitch"], 0, 0.25],
    ["met 3 in lower, the same drop", { ...RIGHT, attachFt: RIGHT.attachFt + 0.25 }, ["height"], 0.25, 0],
    ["met 3 in lower and 3 in more drop", { ...RIGHT, attachFt: RIGHT.attachFt + 0.25, dropFt: RIGHT.dropFt + 0.25 }, ["height", "pitch"], 0.25, 0.25],
    ["a quarter in 12 steeper", { ...RIGHT, dropFt: RIGHT.dropFt + (0.25 / 12) * 8 }, ["pitch"], 0, 1 / 6],
    // Met where the porch roof's TOP meets the wall (7' 6"), the porch's own printed number: its slab's top would
    // stand a slab's thickness over the porch roof's, so it is a near-miss by that, not a join.
    ["met at the porch's printed 7' 6\", the porch's slope from there", { ...RIGHT, attachFt: 0.5, dropFt: 0.5 + P0.pitch * 8 }, ["height", "pitch"], YA - 7.5, YA - 7.5],
  ];
  for (const [what, e, why, dy, d1] of cases) {
    const roof = { ...PORCH, leanTos: [{ ...e, meetPorch: true }] };
    const gs = F.d3LeanTosGeom(roof, 12, 16, H);
    const before = JSON.stringify(gs);
    const r = F.d3PorchJoins(roof, 12, 16, H, gs);
    assertEquals(JSON.stringify(gs), before, `${what}: nothing is moved to make it meet`);
    assertEquals([r.joins, r.ends], [[], {}], what);
    const N = r.near[0];
    assertEquals([N.i, N.at, N.asked, N.why], [0, "front-right", true, why], what);
    assertAlmostEquals(N.dy, dy, 1e-9, what);
    assertAlmostEquals(N.d1, d1, 1e-9, what);
    const pc = rdOf(roof)[0].porchCorner;
    assertEquals([pc.joined, pc.why, pc.porch.yHigh, pc.porch.pitch], [false, why, 7.5, P0.pitch], what);
    assertAlmostEquals(pc.porch.ya, YA, 1e-12, what);
    assertAlmostEquals(pc.dy, dy, 1e-9);
    assertAlmostEquals(pc.d1, d1, 1e-9);
    // The fix: on the wall at the match's height, the outer edge 8 x pitch under that -- and typed as the card
    // prints it, to the hundredth of a foot, it joins.
    assertEquals(pc.fix.attach, "wall", what);
    assertAlmostEquals(pc.fix.attachFt, RIGHT.attachFt, 1e-9, what);
    assertAlmostEquals(pc.fix.dropFt, RIGHT.dropFt, 1e-9, what);
    const typed = { ...roof, leanTos: [{ ...roof.leanTos[0], attach: "wall", attachFt: Number(pc.fix.attachFt.toFixed(2)), dropFt: Number(pc.fix.dropFt.toFixed(2)) }] };
    assertEquals(joinsOf(typed).joins.length, 1, `${what}: the card's numbers join`);
  }
  assertEquals(F.D3_LT_CORNER_TOL, 0.01);
});

Deno.test("the tolerance absorbs float noise and typing to the hundredth, nothing more", () => {
  const at = (e: Any) => joinsOf({ ...PORCH, leanTos: [{ ...RIGHT, ...e, meetPorch: true }] });
  assertEquals(at({}).joins.length, 1);
  assertEquals(at({ attachFt: RIGHT.attachFt + 1e-9 }).joins.length, 1, "float noise");
  assertEquals(at({ attachFt: RIGHT.attachFt + 0.005, dropFt: RIGHT.dropFt + 0.005 }).joins.length, 1, "half a hundredth off at both");
  assertEquals(at({ attachFt: RIGHT.attachFt + 0.02 }).near[0].why, ["height"], "a fifth of an inch at the wall");
  assertEquals(at({ dropFt: RIGHT.dropFt + 0.02 }).near[0].why, ["pitch"], "...or at the outer edge");
});

// ── FOUR: why not ───────────────────────────────────────────────────────────────────────────

Deno.test("up the roof, beside wings, a porch short of the corner, a corner already joined, a corner already taken: each says so", () => {
  const ask = (e: Any) => ({ ...e, meetPorch: true });
  const whys = (roof: Any, size = "12x16") => joinsOf(roof, size).near.map((N: Any) => [N.i, N.why]);
  // Up the roof: it lands on the roof, not at the corner.
  assertEquals(whys({ ...PORCH, leanTos: [ask({ wall: "right", widthFt: 8, attach: "roof", attachFt: 1 })] }), [[0, ["roof"]]]);
  // Side wings: the porch stands in front of the middle (d3PorchSpanWings), so it is short of the corner too.
  const winged = { ...PORCH, wingSide: "both", wingWidthFt: 6, wingPitch: 0.25 };
  assertEquals(whys({ ...winged, leanTos: [ask(RIGHT)] }, "24x30"), [[0, ["wings", "porchWidth"]]]);
  // A porch narrower than its wall, centred: it stops short of both corners.
  assertEquals(whys({ ...PORCH, porchWidthFt: 8, leanTos: [ask(RIGHT)] }), [[0, ["porchWidth"]]]);
  // An end-wall lean-to on the porch's own wall that the right one meets round the corner (d3CornerJoins).
  const both = { ...PORCH, leanTos: [ask(RIGHT), { wall: "front", widthFt: 8, attach: "wall", attachFt: RIGHT.attachFt, dropFt: RIGHT.dropFt }] };
  assertEquals(F.d3CornerJoins(both, 12, 16, H).joins.map((J: Any) => [J.i, J.j, J.at]), [[0, 1, "front-right"]]);
  assertEquals(whys(both), [[0, ["leanTo"]]]);
  // Two on the right wall that both run to the corner and match. Flush (no overhang runs past the porch's wall),
  // the first in the list meets the porch and the second is "taken"; a first that does not match leaves the
  // corner to the next that does.
  const flush = { ...PORCH, overhang: 0 };
  const two = { ...flush, leanTos: [ask(RIGHT), ask({ ...RIGHT, lengthFt: 10, offsetFt: 3 })] };
  const t = joinsOf(two);
  assertEquals([t.joins.map((J: Any) => J.i), t.near.map((N: Any) => [N.i, N.why])], [[0], [[1, ["taken"]]]]);
  const t2 = joinsOf({ ...flush, leanTos: [ask({ ...RIGHT, dropFt: 2 }), ask({ ...RIGHT, lengthFt: 10, offsetFt: 3 })] });
  assertEquals([t2.joins.map((J: Any) => J.i), t2.near.map((N: Any) => [N.i, N.why])], [[1], [[0, ["pitch"]]]]);
  // With the 0.6 ft overhang, the one left unjoined runs its roof out over the porch beside the other, under the
  // porch roof's top: neither meets it, each says so with the other's number.
  const t3 = joinsOf({ ...two, overhang: 0.6 });
  assertEquals([t3.joins, t3.near.map((N: Any) => [N.i, N.why, N.edge.i, N.edge.at])], [[], [[0, ["edge"], 1, "front-right"], [1, ["edge"], 0, "front-right"]]]);
  const t4 = joinsOf({ ...two, overhang: 0.6, leanTos: [ask({ ...RIGHT, dropFt: 2 }), ask({ ...RIGHT, lengthFt: 10, offsetFt: 3 })] });
  assertEquals([t4.joins, t4.near.map((N: Any) => [N.i, N.why])], [[], [[0, ["pitch"]], [1, ["edge"]]]]);
});

// ── FOUR+: what else hangs over the porch ───────────────────────────────────────────────────

Deno.test("a lean-to over the porch on its own wall, or one beside it hung lower than its roof, stops every join; asked too and matched, the other side meets as well", () => {
  const ask = (e: Any) => ({ ...e, meetPorch: true });
  // On the porch's own wall, over its left end: the porch is drawn under it, so nothing meets the porch.
  const under = { ...PORCH, leanTos: [ask(RIGHT), { wall: "front", widthFt: 4, lengthFt: 4, offsetFt: -3 }] };
  const u = joinsOf(under);
  assertEquals([u.joins, u.near.map((N: Any) => [N.i, N.why, N.over])], [[], [[0, ["underLeanTo"], 1]]]);
  assertEquals(rdOf(under)[0].porchCorner.over, 1, "the card names it");
  // Beside it on the left, met a foot down the wall with 2 ft of drop: its overhang runs out over the porch's left end
  // 0.26 ft past its wall line, its underside there 7' 0" less its pitch over that, less the slab's thickness on
  // the slope and the scan's 0.03 -- under the porch roof's 7' 6".
  const low = { wall: "left", widthFt: 8, attach: "wall", attachFt: 1, dropFt: 2 };
  const e = joinsOf({ ...PORCH, leanTos: [ask(RIGHT), low] });
  const N = e.near.find((x: Any) => x.i === 0);
  assertEquals([e.joins, N.why, N.edge.i, N.edge.at], [[], ["edge"], 1, "front-left"]);
  assertAlmostEquals(N.edge.by, 7.5 - (7 - 0.125 * (0.18 + 0.08) - 0.1 * (Math.sqrt(1 + 0.125 * 0.125) - 1) - 0.03), 1e-12);
  const pc = rdOf({ ...PORCH, leanTos: [ask(RIGHT), low] })[0].porchCorner;
  assertEquals([pc.why, pc.edge], [["edge"], N.edge], "the card has it");
  // Hung at the plate with its 1 ft drop it stays over the porch roof: no matter.
  assertEquals(joinsOf({ ...PORCH, leanTos: [ask(RIGHT), { wall: "left", widthFt: 8 }] }).joins.length, 1);
  // Flush, its overhang never reaches past the porch's wall: no matter either.
  assertEquals(joinsOf({ ...PORCH, overhang: 0, leanTos: [ask(RIGHT), low] }).joins.length, 1);
  // Matched on the left but not asked: it runs past the porch, so it stops the right one, and its own card says it
  // would join; asked too, both meet.
  const left = { ...RIGHT, wall: "left" };
  const m1 = joinsOf({ ...PORCH, leanTos: [ask(RIGHT), left] });
  assertEquals([m1.joins, m1.near.map((x: Any) => [x.i, x.asked, x.why])], [[], [[0, true, ["edge"]], [1, false, []]]]);
  const m2 = joinsOf({ ...PORCH, leanTos: [ask(RIGHT), ask(left)] });
  assertEquals([m2.joins.map((J: Any) => J.at), m2.near], [["front-right", "front-left"], []]);
});

Deno.test("\"On the roof\" on a shed's high side meets at the eave: judged as on the wall at 0, by its numbers, not refused as up the roof", () => {
  // A shed falling to the left, its porch on the front end: the right wall is the high side, with no roof above it.
  const shed = { type: "shed", highSide: "right", pitch: 0.25, overhang: 0.6, porchOutFt: 6, porchPitch: 0.1 };
  const ask = (e: Any) => ({ ...e, meetPorch: true });
  const roof = { ...shed, leanTos: [ask({ wall: "right", widthFt: 8, attach: "roof", attachFt: 1 })] };
  const g = F.d3LeanTosGeom(roof, 12, 16, H)[0];
  assert(g.mode === "roof" && g.noRoof, "the high side: built at the eave");
  const r = joinsOf(roof);
  const N = r.near[0];
  // 11 ft up at the high eave against the porch's 7' 6": said by its numbers, about 3' 6" over.
  assertEquals([N.i, N.at, N.why], [0, "front-right", ["height", "pitch"]]);
  assertAlmostEquals(N.dy, r.porch.ya - 11, 1e-12);
  assertEquals(rdOf(roof)[0].porchCorner.why, ["height", "pitch"]);
});

// ── FIVE: every corner, every frame ─────────────────────────────────────────────────────────

Deno.test("every corner in every frame: named for where it stands, and the porch's own frame (js) lands on the same corner post and hip", () => {
  const frames: Array<[string, Any, string, number]> = [
    ["front a gable end", { ...PORCH }, "12x16", 8],
    ["the old frame, 12x16", { ...PORCH, front: undefined }, "12x16", 8],
    ["the old frame, 16x12 (the roof turned: the porch on the left end)", { ...PORCH, front: undefined }, "16x12", 8],
    ["a long-side front: the porch on an eave wall", { ...PORCH, front: "eave", porchAttachFt: 8 }, "16x12", 9],
    ["a shed, high side at the back", { type: "shed", highSide: "back", pitch: 0.25, overhang: 0.6, porchOutFt: 6, porchAttachFt: 7, porchPitch: 0.1 }, "12x16", 9],
  ];
  for (const [what, base, size, h] of frames) {
    const [W, L] = sizeOf(size);
    for (const porchEnd of ["front", "back"]) {
      const b = { ...base, porchEnd };
      const ax = F.d3RoofAxes(b, W, L);
      // The two walls beside the porch's.
      const pw = F.d3PorchJoins({ ...b, leanTos: [{ wall: "left", widthFt: 6 }] }, W, L, h);
      const pWall = F.d3PorchReadout(spec(b, h), size).wall;
      const beside = pWall === "south" || pWall === "north" ? ["left", "right"] : ["front", "back"];
      const roof = matched({ ...b, leanTos: beside.map((wall) => ({ wall, widthFt: 6, meetPorch: true })) }, size, h);
      const r = joinsOf(roof, size, h);
      assert(pw === null || pw.porch.wall === pWall, what);
      assertEquals(r.joins.length, 2, `${what}, porch ${porchEnd}: both sides join (${JSON.stringify(r.near)})`);
      const toRoot = F.d3PorchToRoot(roof, W, L);
      for (const J of r.joins) {
        const lw = roof.leanTos[J.i].wall;
        assertEquals(J.at.split("-").sort(), [lw, { south: "front", north: "back", west: "left", east: "right" }[pWall as "south"]].sort(), `${what} ${J.at}`);
        // Where it stands in the world agrees with its name: front +z, right +x.
        const [x, z] = world(roof, W, L, J.uC, J.zC);
        assertEquals([Math.sign(z), Math.sign(x)], [J.at.includes("front") ? 1 : -1, J.at.includes("right") ? 1 : -1], `${what} ${J.at}: at ${x}, ${z}`);
        // The corner post and the hip's far end, through the roof group's frame and through the porch's own.
        const hw = r.porch.hw, h1 = Math.min(J.eL, J.eP);
        const [px, pz] = world(roof, W, L, J.post[0], J.post[1]), [qx, qz] = toRoot(J.js * (hw + J.w), J.dPost);
        assertAlmostEquals(px, qx, 1e-9, `${what} ${J.at}: the corner post in x`);
        assertAlmostEquals(pz, qz, 1e-9, `${what} ${J.at}: the corner post in z`);
        const [hx, hz] = world(roof, W, L, J.hip[1][0], J.hip[1][1]), [kx, kz] = toRoot(J.js * (hw + h1), h1);
        assertAlmostEquals(hx, kx, 1e-9, `${what} ${J.at}: the hip's end in x`);
        assertAlmostEquals(hz, kz, 1e-9, `${what} ${J.at}: the hip's end in z`);
        assertEquals(J.lt, ax.uAxisIsX === (pWall === "south" || pWall === "north") ? "eave" : "gable", `${what}: a porch on an end wall meets a side-wall lean-to`);
      }
      assertEquals(r.joins.map((J: Any) => J.js).sort(), [-1, 1], `${what}: one on each side of the porch`);
    }
  }
});

// ── SIX: with the other joins ───────────────────────────────────────────────────────────────

Deno.test("a wrap round the back too: the lean-to that meets the porch also meets a back lean-to (d3CornerJoins), and both stand", () => {
  const roof = { ...PORCH, leanTos: [{ ...RIGHT, meetPorch: true }, { ...RIGHT, wall: "back" }] };
  const cj = F.d3CornerJoins(roof, 12, 16, H);
  assertEquals(cj.joins.map((J: Any) => [J.i, J.j, J.at]), [[0, 1, "back-right"]]);
  const r = joinsOf(roof);
  assertEquals([r.joins.map((J: Any) => [J.i, J.at]), r.ends], [[[0, "front-right"]], { 0: { a1: 0 } }]);
  const rs = rdOf(roof);
  assertEquals([rs[0].corner.map((c: Any) => [c.with, c.joined]), rs[0].porchCorner.joined], [[[1, true]], true]);
  assert(!("porchCorner" in rs[1]), "the back one reaches no corner of the porch's wall");
  // Both are built on the porch roof's plane (the renderer's ltLine: the joined one's line, carried round to the back
  // one), which is each one's own numbers: the doors-and-windows limit on each card keeps 0.2 ft under its roof.
  const J = r.joins[0];
  for (const x of rs) {
    assertAlmostEquals(x.ya, J.y0, 1e-12, `lean-to ${x.i + 1} at the wall`);
    assert(x.openTop != null && x.openTop <= J.y0 - 0.2 + 1e-9, `lean-to ${x.i + 1}: openings under ${x.openTop}, its roof at ${J.y0}`);
  }
});

// ── SIX+: under the main roof's edge ────────────────────────────────────────────────────────

Deno.test("a gable-end porch under its own rule (no attach): joined, its ceiling takes the main roof's eave corners, the height the scan builds it at unjoined", () => {
  // The three the 3D measured (porchProbe PJ6, PJ7 and one at 0.5 pitch): unjoined, the scan lowers the porch to clear
  // the rake and eave boards hanging out over its corners, to 7.617, 7.469 and 7.576 ft. Joined, nothing is scanned,
  // so its own numbers must already say the same -- and d3PorchCapFt, which every other porch reads, does not move.
  const base = { type: "gable", front: "gable", eave: "fascia", porchOutFt: 8, porchPitch: 2 / 12 };
  const cases: Array<[string, Any, string, number]> = [
    ["0.6 ft overhang", { ...base, pitch: 0.4 }, "right", 7.617],
    ["1 ft overhang", { ...base, pitch: 0.4, overhang: 1 }, "right", 7.469],
    ["a 6 in 12 roof", { ...base, pitch: 0.5 }, "left", 7.576],
  ];
  for (const [what, b, wall, scan] of cases) {
    const roof = matched({ ...b, leanTos: [{ wall, widthFt: 8, meetPorch: true }] });
    const r = joinsOf(roof);
    assertEquals(r.joins.length, 1, `${what}: ${JSON.stringify(r.near)}`);
    assertAlmostEquals(r.porch.cap, scan, 5e-4, `${what}: the join's ceiling`);
    assertAlmostEquals(r.porch.yHigh, r.porch.cap, 1e-12, `${what}: hung under it`);
    assertAlmostEquals(F.d3PorchEaveCornerCapFt(roof, 12, 16, H), r.porch.cap, 1e-12, what);
    assertEquals(F.d3PorchCapFt(roof, 12, 16, H, 0.18), 7.8, `${what}: d3PorchCapFt as it was`);
    // The readout is that porch, said exactly, and says what holds it there; without the ask, it reads as always.
    const pj = porchOf(roof), plain = porchOf({ ...roof, leanTos: roof.leanTos.map(({ meetPorch: _m, ...e }: Any) => e) });
    assertEquals([pj.yHigh, pj.pitch, pj.atMost, pj.edgeOver], [r.porch.yHigh, r.porch.pitch, false, true], what);
    assertEquals([plain.yHigh, plain.atMost, "edgeOver" in plain], [7.8, true, false], what);
  }
  // Off a gable end (a long-side front: the porch on an eave wall, d3PorchCapFt's own eave branch) and flush, none.
  assertEquals(F.d3PorchEaveCornerCapFt({ ...base, front: "eave", pitch: 0.4 }, 16, 12, 9), Infinity);
  assertEquals(F.d3PorchEaveCornerCapFt({ ...base, pitch: 0.4, overhang: 0 }, 12, 16, H), Infinity);
  // A porch 8 ft wide in the middle of a 12 ft end reaches neither corner.
  assertEquals(F.d3PorchEaveCornerCapFt({ ...base, pitch: 0.4, porchWidthFt: 8 }, 12, 16, H), Infinity);
});

// ── SEVEN: whatever the list ────────────────────────────────────────────────────────────────

/** mulberry32: a fixed seed, so a failure names its case and repeats. */
function rng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Deno.test("fuzz: every join was asked, reaches the corner and matches; one join a corner; nothing moved; the porch only changes when one joins", () => {
  const rand = rng(20261005);
  const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
  const roofs = [PORCH, { ...PORCH, front: undefined }, { ...PORCH, front: "eave", porchAttachFt: 8 }, { type: "shed", highSide: "front", pitch: 0.25, porchOutFt: 6 },
    { type: "gambrel", pitch: 0.5, porchOutFt: 5, porchAttachFt: 7.25 }, { ...PORCH, porchAttachFt: undefined, porchPitch: undefined }];
  const sizes = ["12x16", "16x12", "10x20", "14x14"];
  const tol = F.D3_LT_CORNER_TOL;
  let joined = 0, missed = 0;
  for (let n = 0; n < 500; n++) {
    const size = pick(sizes), [W, L] = sizeOf(size);
    const base = { ...pick(roofs), porchEnd: pick(["front", "back"]) };
    let leanTos = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => {
      const e: Any = { wall: pick(["left", "right", "front", "back"]), widthFt: pick([3, 6, 8, 10]), dropFt: pick([0.5, 1, 1.5]) };
      if (rand() < 0.4) { e.attach = pick(["wall", "wall", "roof"]); e.attachFt = pick([0.25, 0.5, 1]); }
      if (rand() < 0.25) { e.lengthFt = pick([4, 8, 12]); e.offsetFt = pick([-6, -2, 0, 2, 6]); }
      if (rand() < 0.3) e.enclosed = true;
      if (rand() < 0.7) e.meetPorch = true;
      return e;
    });
    // Half the time, set each to what its card says to match.
    if (rand() < 0.5) leanTos = matched({ ...base, leanTos }, size).leanTos;
    const roof = { ...base, leanTos };
    const gs = F.d3LeanTosGeom(roof, W, L, H);
    if (!gs) continue;
    const before = JSON.stringify(gs);
    const cj = F.d3CornerJoins(roof, W, L, H, gs);
    const r = F.d3PorchJoins(roof, W, L, H, gs, cj);
    assertEquals(JSON.stringify(gs), before, "the records are left as they were");
    const plain = { ...roof, leanTos: leanTos.map(({ meetPorch: _m, ...e }: Any) => e) };
    if (!r || !r.joins.length) {
      assertEquals(JSON.stringify(porchOf(roof, size)), JSON.stringify(porchOf(plain, size)), "no join: the porch reads exactly as without the asks");
      if (r) missed += r.near.filter((N: Any) => N.asked).length;
      continue;
    }
    const at = new Set<string>();
    r.joins.forEach((J: Any, k: number) => {
      const q = gs.find((x: Any) => x.i === J.i);
      const why = JSON.stringify({ roof, size, J });
      assert(leanTos[J.i].meetPorch === true, `asked: ${why}`);
      assert(Math.abs(q.ya - r.porch.ya) <= tol && Math.abs(q.y1 - (r.porch.ya - r.porch.pitch * q.w)) <= tol && (q.mode !== "roof" || q.noRoof), `matched: ${why}`);
      // Built on its own numbers: the porch roof's plane is its line to the tolerance.
      assert(Math.abs(J.y0 - q.ya) <= tol && Math.abs(J.y1 - q.y1) <= tol, `on its own line: ${why}`);
      assert(!(cj && cj.ends[J.i] && cj.ends[J.i][Object.keys(r.ends[J.i])[0]] != null), `not in a lean-to join at that end: ${why}`);
      assertEquals(Object.values(r.ends[J.i]), [k], why);
      assert(!at.has(J.at), `one join a corner: ${why}`);
      at.add(J.at);
      assertAlmostEquals(J.y0 + (0.1) * (1 + Math.sqrt(1 + J.pitch * J.pitch)), r.porch.yHigh + J.pitch * r.porch.dWall, 1e-9, `on the porch roof's plane: ${why}`);
      joined++;
    });
    r.near.forEach((N: Any) => assert(!N.asked || N.why.length > 0, JSON.stringify({ roof, size, N })));
    assertEquals(porchOf(roof, size).meets.length, r.joins.length);
  }
  assert(joined > 30 && missed > 30, `the fuzz reached both: ${joined} joined, ${missed} asked and near`);
});

// ── EIGHT: what is stored today ─────────────────────────────────────────────────────────────

Deno.test("the porch styles other suites pin, and the lean-to lists, build no porch join", () => {
  const fixtures: Array<[string, Any, string]> = [
    // porchProbe.mjs I0 / I / J: a porch and the single lean-to beside it.
    ["porchProbe I", { type: "gable", pitch: 0.4, overhang: 0.5, eave: "fascia", porchOutFt: 6.5, porchEnd: "front", plateBand: true, leanToWidthFt: 8, leanToDropFt: 1.5, leanToSide: "left" }, "16x24"],
    // leanTos_test's readout fixture: a porch and a list, nothing asked.
    ["leanTos_test readout", { type: "gable", pitch: 0.4, overhang: 0.6, porchOutFt: 6, porchEnd: "front", leanTos: [{ wall: "left", widthFt: 8, lengthFt: 8, offsetFt: -2 }, { wall: "left", widthFt: 6, lengthFt: 8, offsetFt: 3 }, { wall: "front", widthFt: 5 }, { wall: "right", widthFt: 8, dropFt: 2, attach: "wall", attachFt: 1 }] }, "12x16"],
    // leanTos.mjs J6: a porch and a pair joined at the back.
    ["leanTos.mjs J6", { type: "gable", pitch: 0.4, overhang: 0.6, porchOutFt: 6, porchEnd: "front", leanTos: [{ wall: "right", widthFt: 8 }, { wall: "back", widthFt: 8 }] }, "12x16"],
  ];
  for (const [what, roof, size] of fixtures) {
    const r = joinsOf(roof, size);
    assert(!r || r.joins.length === 0, `${what}: ${JSON.stringify(r)}`);
    assert(!("meets" in porchOf(roof, size)), what);
  }
});
