// TWO LEAN-TOS THAT MEET AT A CORNER — tested against BOTH SHIPPED designer twins.
//
// Carolyn, 10-01: "if the two heights match each other and the pitch match each other, that it'll do it
// like this" -- a lean-to on a side wall and one on an end wall that reach the same outside corner run as
// ONE roof around it, with a hip where the two slopes meet (her wrap-around porch). d3CornerJoins finds the
// pairs from d3LeanTosGeom's records -- joined on an exact match of the height at the wall, the outer edge
// and the width, and otherwise a near-miss with its reason and numbers -- and d3LeanTosReadout hands each
// card its own pairs. Both are pure module-scope code, lifted by the same stable anchors as leanTos_test and
// run; each lifted region is asserted byte-identical across the two hand-mirrored twins. The meshes (the
// slabs cut along the hip, the cap, the corner post, the butted headers and walls) are proved on the
// compiled bundle by tests/harness/leanTos.mjs case J.
//
// The promise tested hardest: NOTHING IS NUDGED TO MAKE A JOIN, AND WITHOUT A PAIR NOTHING CHANGES.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `leanToCorners_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_CASE_F =", "// Built-in 3D appearance per building style"],
  // d3RoofAxes, d3Massing, the lean-to list, d3CornerJoins.
  ["function d3RoofAxes(", "function d3FtIn("],
  ["function ssVentSpan(", "function buildFixtureTools("],
  ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  ["function d3PorchGeom(", "function d3PorchReadout("],
  // d3LeanTosReadout.
  ["function d3PorchReadout(", "// A dimensioned end-elevation of the style"],
];
const blocks = REGIONS.map(([a, b]) => ({ a, cmp: lift(CMP, "structure-studio.component.js", a, b), jsx: lift(JSX, "StructureStudio.jsx", a, b) }));

Deno.test("every lifted region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `const isVentItem = (it) => !!(it && it.isVent);\n${blocks.map((b) => b.cmp).join("\n")}; return { D3, d3RoofAxes, d3Massing, d3LeanTosGeom, d3LeanTosReadout, d3CornerJoins, D3_LT_CORNER_TOL };`,
)() as Record<string, Any>;

const H = 8;
const GABLE = { type: "gable", pitch: 0.4, overhang: 0.6 };
const lt = (wall: string, extra: Record<string, unknown> = {}) => ({ wall, widthFt: 8, ...extra });
const joinsOf = (roof: Any, W = 12, L = 16, h = H) => F.d3CornerJoins(roof, W, L, h);
const readout = (roof: Any, size = "12x16") => F.d3LeanTosReadout({ roof, wallHeightFt: H }, size);
// A building corner in the world (front +z, right +x), through the roof group's own placement: u along x
// with z - L/2 down the ridge, or turned a quarter, x = L/2 - z (the renderer's rgRoot, no wings).
const world = (roof: Any, W: number, L: number, u: number, z: number) => {
  const ax = F.d3RoofAxes(roof, W, L);
  return ax.uAxisIsX ? [u, z - ax.L / 2] : [ax.L / 2 - z, u];
};

// ── ONE: no pair, no change ─────────────────────────────────────────────────────────────────

Deno.test("⚠️ no list, the single lean-to, or a list with no pair at a corner: null, and no card carries a corner", () => {
  for (const roof of [GABLE, { ...GABLE, leanToWidthFt: 8, leanToSide: "left" }, { ...GABLE, front: "eave" }]) {
    for (const [W, L] of [[12, 16], [16, 12], [24, 30]]) assertEquals(joinsOf(roof, W, L), null);
  }
  const lists = [
    [lt("left")],
    [lt("front")],
    [lt("left"), lt("right")],               // two side walls: no corner between them
    [lt("front"), lt("back")],               // two end walls
    [lt("right", { lengthFt: 8 }), lt("front")],   // the side one stops 4 ft short of the front
    [lt("right"), lt("front", { lengthFt: 6, offsetFt: -3 })],   // the end one stops at the middle
    [lt("left", { lengthFt: 6, offsetFt: -2 }), lt("back", { lengthFt: 4 })],
  ];
  for (const leanTos of lists) {
    const roof = { ...GABLE, leanTos };
    assertEquals(joinsOf(roof), null, JSON.stringify(leanTos));
    for (const r of readout(roof)) assert(!("corner" in r), `no corner on ${JSON.stringify(leanTos)}`);
  }
  // A list with a pair: the lean-to in neither keeps today's record exactly, key for key.
  const rs = readout({ ...GABLE, leanTos: [lt("right"), lt("front"), lt("left", { lengthFt: 6 })] });
  assert(!("corner" in rs[2]), "the left one reaches no corner");
  assertEquals(Object.keys(rs[2]).sort(), Object.keys(readout({ ...GABLE, leanTos: [lt("left", { lengthFt: 6 })] })[0]).sort());
});

// ── TWO: the join itself ────────────────────────────────────────────────────────────────────

Deno.test("12x16, front a gable end: the right and front lean-tos, 8 ft out and 1 ft down, join at the front-right corner", () => {
  const roof = { ...GABLE, front: "gable", leanTos: [lt("right", { dropFt: 1 }), lt("front", { dropFt: 1 })] };
  const r = joinsOf(roof);
  assertEquals(r.joins.length, 1);
  assertEquals(r.near, []);
  const J = r.joins[0];
  assertEquals([J.i, J.j, J.at, J.dir, J.sz, J.uC, J.zC, J.w, J.ya, J.y1], [0, 1, "front-right", 1, 1, 6, 16, 8, 8, 7]);
  assertAlmostEquals(J.pitch, 1 / 8, 1e-12);
  const ovh = 0.6 / Math.sqrt(1 + 1 / 64);
  assertAlmostEquals(J.ovh, ovh, 1e-12);
  assertEquals(J.hip[0], [6, 16, 8], "the hip starts at the building's corner, at the height both meet their walls");
  assertAlmostEquals(J.hip[1][0], 14 + ovh, 1e-9);
  assertAlmostEquals(J.hip[1][1], 24 + ovh, 1e-9);
  assertAlmostEquals(J.hip[1][2], 7 - ovh / 8, 1e-9, "on the roof line, past the outer corner by the overhang");
  assertEquals(J.post, [14, 24], "the outer corner, where the one post stands");
  assertEquals(J.enc, [false, false]);
  assertEquals(r.ends, { 0: { a1: 0 }, 1: { a1: 0 } });
  // Each card hears of the other, joined.
  const rs = readout(roof);
  assertEquals(rs[0].corner, [{ with: 1, at: "front-right", joined: true, why: [] }]);
  assertEquals(rs[1].corner, [{ with: 0, at: "front-right", joined: true, why: [] }]);
  // Enclosed is carried for the renderer's walls.
  assertEquals(joinsOf({ ...roof, leanTos: [lt("right", { enclosed: true }), lt("front")] }).joins[0].enc, [true, false]);
});

Deno.test("all four corners, in the new frame, the old frame both ways round and with a long-side front: named for where they stand", () => {
  const frames: Array<[string, Any, number, number]> = [
    ["front a gable end", { ...GABLE, front: "gable" }, 12, 16],
    ["the old frame, 12x16", GABLE, 12, 16],
    ["the old frame, 16x12 (the roof turned)", GABLE, 16, 12],
    ["a long-side front", { ...GABLE, front: "eave" }, 12, 16],
  ];
  for (const [what, base, W, L] of frames) {
    const roof = { ...base, leanTos: [lt("left", { widthFt: 6 }), lt("right", { widthFt: 6 }), lt("front", { widthFt: 6 }), lt("back", { widthFt: 6 })] };
    const r = joinsOf(roof, W, L);
    assertEquals(r.joins.map((J: Any) => J.at).sort(), ["back-left", "back-right", "front-left", "front-right"], what);
    assertEquals(r.near, [], what);
    const ax = F.d3RoofAxes(roof, W, L);
    const gs = F.d3LeanTosGeom(roof, W, L, H);
    for (const J of r.joins) {
      const e = gs.find((q: Any) => q.i === J.i), g = gs.find((q: Any) => q.i === J.j);
      assertEquals([e.kind, g.kind], ["eave", "gable"], `${what} ${J.at}: i the side-wall one, j the end-wall one`);
      assertEquals(J.at.split("-").sort(), [e.wall, g.wall].sort(), `${what} ${J.at}: named for its two walls`);
      assertEquals([J.uC, J.zC], [J.dir * ax.S / 2, J.sz > 0 ? ax.L : 0], `${what} ${J.at}: the corner`);
      assertEquals(J.post, [J.uC + J.dir * 6, J.zC + J.sz * 6], `${what} ${J.at}: the outer corner`);
      // Where it stands in the world agrees with its name: front +z, right +x.
      const [x, z] = world(roof, W, L, J.uC, J.zC);
      assertEquals([Math.sign(z), Math.sign(x)], [J.at.startsWith("front") ? 1 : -1, J.at.endsWith("right") ? 1 : -1], `${what} ${J.at}: at ${x}, ${z}`);
    }
    // Every lean-to joined at both its ends: a wrap round all four sides.
    for (const i of [0, 1, 2, 3]) assertEquals(Object.keys(r.ends[i]).sort(), ["a0", "a1"], `${what}: lean-to ${i + 1}`);
  }
});

// ── THREE: exact, never nudged ──────────────────────────────────────────────────────────────

Deno.test("a quarter foot of drop or height, or half a foot of width, is a near-miss with its numbers; float noise still joins", () => {
  const pair = (front: Record<string, unknown>, right: Record<string, unknown> = {}) => ({ ...GABLE, leanTos: [lt("right", right), lt("front", front)] });
  const cases: Array<[string, Any, string[], number, number, number]> = [
    ["3 in more drop", pair({ dropFt: 1.25 }), ["drop"], 0, -0.25, 0],
    ["6 in wider", pair({ widthFt: 8.5 }), ["width"], 0, 0, 0.5],
    ["met 3 in down its wall", pair({ attach: "wall", attachFt: 0.25 }), ["height"], -0.25, 0, 0],
    ["met 3 in down its wall and 3 in more drop", pair({ attach: "wall", attachFt: 0.25, dropFt: 1.25 }), ["height", "drop"], -0.25, -0.25, 0],
  ];
  for (const [what, roof, why, dy, d1, dw] of cases) {
    const gs = F.d3LeanTosGeom(roof, 12, 16, H);
    const before = JSON.stringify(gs);
    const r = F.d3CornerJoins(roof, 12, 16, H, gs);
    assertEquals(JSON.stringify(gs), before, `${what}: nothing is moved to make it meet`);
    assertEquals(r.joins, [], what);
    assertEquals(r.near.length, 1, what);
    const N = r.near[0];
    assertEquals([N.i, N.j, N.at, N.why], [0, 1, "front-right", why], what);
    assertAlmostEquals(N.dy, dy, 1e-12, what);
    assertAlmostEquals(N.d1, d1, 1e-12, what);
    assertAlmostEquals(N.dw, dw, 1e-12, what);
    assertEquals(r.ends, {}, what);
    // Each card reads the other's difference from its own side.
    const rs = readout(roof);
    assertEquals([rs[0].corner[0].with, rs[0].corner[0].joined, rs[0].corner[0].why], [1, false, why], what);
    assertAlmostEquals(rs[0].corner[0].d1, d1, 1e-12);
    assertAlmostEquals(rs[1].corner[0].d1, -d1, 1e-12);
    assertAlmostEquals(rs[1].corner[0].dy, -dy, 1e-12);
    assertAlmostEquals(rs[1].corner[0].dw, -dw, 1e-12);
    assert(!Object.is(rs[1].corner[0].dw, -0), "never a -0 where they agree");
  }
  // A hair apart from float arithmetic is the same number: it joins.
  assertEquals(joinsOf(pair({ widthFt: 8 + 1e-9, dropFt: 1 + 1e-9 })).joins.length, 1);
  assertEquals(F.D3_LT_CORNER_TOL, 0.01);
});

Deno.test("up the roof or beside end wings: a near-miss with that reason, never a join", () => {
  const roofUp = { ...GABLE, leanTos: [lt("right", { attach: "roof", attachFt: 1 }), lt("front")] };
  const a = joinsOf(roofUp);
  assertEquals([a.joins, a.near.map((n: Any) => n.why)], [[], [["roof"]]]);
  // End wings (roof.wingList on an end wall): the side wall's eave steps where they stand.
  const G = { type: "gable", pitch: 0.5, overhang: 1 };
  const ends = { ...G, wingList: [{ wall: "front", widthFt: 8 }], leanTos: [lt("right", { widthFt: 5 }), lt("front", { widthFt: 5 })] };
  const b = F.d3CornerJoins(ends, 24, 32, 9);
  assertEquals([b.joins, b.near.map((n: Any) => [n.at, n.why])], [[], [["front-right", ["endWings"]]]]);
  // An attached one across an end wing's stretch (endCross) says the same.
  const cross = { ...ends, leanTos: [lt("right", { widthFt: 5, attach: "wall", attachFt: 1 }), lt("front", { widthFt: 5 })] };
  assert(F.d3LeanTosGeom(cross, 24, 32, 9)[0].endCross);
  assertEquals(F.d3CornerJoins(cross, 24, 32, 9).near.map((n: Any) => n.why), [["endWings"]]);
});

Deno.test("a run short of the corner is no pair; slid all the way to the end, it joins", () => {
  const roof = (e: Record<string, unknown>) => ({ ...GABLE, leanTos: [lt("right", e), lt("front")] });
  assertEquals(joinsOf(roof({ lengthFt: 8 })), null, "centred, 4 ft short of the front");
  assertEquals(joinsOf(roof({ lengthFt: 8, offsetFt: 3.5 })), null, "half a foot short");
  const r = joinsOf(roof({ lengthFt: 8, offsetFt: 4 }));
  assertEquals([r.joins.length, r.joins[0].at], [1, "front-right"], "slid the whole 4 ft of room toward the front");
  // The end-wall one slid to the right end of the front wall joins too.
  const f = joinsOf({ ...GABLE, leanTos: [lt("right"), lt("front", { lengthFt: 6, offsetFt: 3 })] });
  assertEquals(f.joins.map((J: Any) => J.at), ["front-right"]);
});

// ── FOUR: more than two ─────────────────────────────────────────────────────────────────────

Deno.test("a wrap round three sides: the front lean-to joins at both its ends", () => {
  const r = joinsOf({ ...GABLE, leanTos: [lt("left"), lt("front"), lt("right")] });
  assertEquals(r.joins.map((J: Any) => [J.at, J.i, J.j]), [["front-left", 0, 1], ["front-right", 2, 1]]);
  assertEquals(r.ends, { 0: { a1: 0 }, 1: { a0: 0, a1: 1 }, 2: { a1: 1 } });
  assertEquals(r.joins.map((J: Any) => J.post), [[-14, 24], [14, 24]]);
  const rs = readout({ ...GABLE, leanTos: [lt("left"), lt("front"), lt("right")] });
  assertEquals(rs[1].corner.map((c: Any) => [c.with, c.at, c.joined]), [[0, "front-left", true], [2, "front-right", true]]);
});

Deno.test("two overlapping on one wall that both reach the corner: the first in the list joins, and the other is no near-miss", () => {
  const a = joinsOf({ ...GABLE, leanTos: [lt("right"), lt("right", { lengthFt: 10, offsetFt: 3 }), lt("front")] });
  assertEquals([a.joins.map((J: Any) => [J.i, J.j]), a.near], [[[0, 2]], []]);
  // A first one that does not match leaves the corner to the next that does.
  const b = joinsOf({ ...GABLE, leanTos: [lt("right", { widthFt: 6 }), lt("right"), lt("front")] });
  assertEquals([b.joins.map((J: Any) => [J.i, J.j]), b.near], [[[1, 2]], []]);
});

// ── FIVE: other buildings ───────────────────────────────────────────────────────────────────

Deno.test("a Tri Home with lean-tos off its wings' walls: the join is at the full width's corner", () => {
  const TRI = { type: "gable", front: "gable", pitch: 0.5, overhang: 0.6, wingSide: "both", wingWidthFt: 6, wingPitch: 0.25 };
  const r = joinsOf({ ...TRI, leanTos: [lt("right"), lt("front")] }, 24, 30);
  assertEquals(r.joins.map((J: Any) => [J.at, J.uC, J.zC, J.post, J.ya]), [["front-right", 12, 30, [20, 38], 8]]);
});

Deno.test("a shed: one off its high side at wall height and one off an end wall join", () => {
  const r = joinsOf({ type: "shed", highSide: "left", pitch: 0.25, leanTos: [lt("left"), lt("front")] });
  assertEquals(r.joins.map((J: Any) => [J.at, J.ya, J.y1]), [["front-left", 8, 7]]);
});

Deno.test("a shed's high side: \"On the roof\" there meets at the eave, so it is judged by its numbers, not refused as up the roof", () => {
  // 12x16 falling to the left: the high eave on the right is 11 ft up, with no roof above it to meet.
  const roof = { type: "shed", highSide: "right", pitch: 0.25, leanTos: [lt("right", { attach: "roof", attachFt: 1 }), lt("front"), lt("back")] };
  const g = F.d3LeanTosGeom(roof, 12, 16, H)[0];
  assert(g.mode === "roof" && g.noRoof && g.ya === 11, JSON.stringify(g));
  const r = joinsOf(roof);
  assertEquals([r.joins, r.near.map((n: Any) => [n.at, n.why, n.dy, n.d1])], [[], [["front-right", ["height", "drop"], -3, -3], ["back-right", ["height", "drop"], -3, -3]]]);
  // Its card's corner lines carry those numbers, not "meets the roof".
  assertEquals(readout(roof)[0].corner.map((c: Any) => [c.with, c.why]), [[1, ["height", "drop"]], [2, ["height", "drop"]]]);
});

// ── SIX: whatever the list ──────────────────────────────────────────────────────────────────

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

Deno.test("fuzz: every join reaches and matches, sits on both lean-tos' ends and starts at the corner; every near-miss says why", () => {
  const rand = rng(20261004);
  const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
  const roofs = [GABLE, { ...GABLE, front: "gable" }, { ...GABLE, front: "eave" }, { type: "shed", highSide: "front", pitch: 0.25 }, { type: "gambrel", pitch: 0.5 }];
  const sizes: Array<[number, number]> = [[12, 16], [16, 12], [10, 20], [24, 30], [14, 14]];
  const tol = F.D3_LT_CORNER_TOL;
  let joined = 0, missed = 0;
  for (let n = 0; n < 600; n++) {
    const [W, L] = pick(sizes);
    const leanTos = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => {
      const e: Any = { wall: pick(["left", "right", "front", "back"]), widthFt: pick([4, 6, 8]), dropFt: pick([0.5, 1, 1.5]) };
      if (rand() < 0.25) { e.attach = pick(["wall", "roof"]); e.attachFt = pick([0.25, 0.5, 1]); }
      if (rand() < 0.3) { e.lengthFt = pick([4, 8, 12]); e.offsetFt = pick([-6, -2, 0, 2, 6]); }
      if (rand() < 0.3) e.enclosed = true;
      return e;
    });
    const roof = { ...pick(roofs), leanTos };
    const gs = F.d3LeanTosGeom(roof, W, L, H);
    const r = F.d3CornerJoins(roof, W, L, H, gs);
    if (!r) continue;
    const ax = F.d3RoofAxes(roof, W, L);
    const reach = (e: Any, g: Any) => (g.sz > 0 ? e.a1 >= ax.L - tol : e.a0 <= tol) && (e.dir > 0 ? g.a1 >= ax.S / 2 - tol : g.a0 <= -ax.S / 2 + tol);
    const at = new Set<string>();
    r.joins.forEach((J: Any, k: number) => {
      const e = gs.find((q: Any) => q.i === J.i), g = gs.find((q: Any) => q.i === J.j);
      const why = JSON.stringify({ roof, W, L, J });
      assert(e.kind === "eave" && g.kind === "gable" && reach(e, g), why);
      assert(Math.abs(e.ya - g.ya) <= tol && Math.abs(e.y1 - g.y1) <= tol && Math.abs(e.w - g.w) <= tol && (e.mode !== "roof" || e.noRoof), why);
      assertEquals(r.ends[J.i][g.sz > 0 ? "a1" : "a0"], k, why);
      assertEquals(r.ends[J.j][e.dir > 0 ? "a1" : "a0"], k, why);
      assertEquals(J.hip[0], [e.dir * ax.S / 2, g.sz > 0 ? ax.L : 0, e.ya], why);
      assert(!at.has(`${J.dir}:${J.sz}`), `one join a corner: ${why}`);
      at.add(`${J.dir}:${J.sz}`);
      joined++;
    });
    r.near.forEach((N: Any) => {
      const e = gs.find((q: Any) => q.i === N.i), g = gs.find((q: Any) => q.i === N.j);
      assert(N.why.length > 0 && reach(e, g) && !at.has(`${e.dir}:${g.sz}`), JSON.stringify({ roof, W, L, N }));
      missed++;
    });
    assertEquals(gs, F.d3LeanTosGeom(roof, W, L, H), "the records are left as they were");
  }
  assert(joined > 20 && missed > 20, `the fuzz reached both: ${joined} joined, ${missed} near`);
});

// ── SEVEN: what is stored today stays unjoined ──────────────────────────────────────────────

Deno.test("the lists other suites pin build no join", () => {
  const TRI = { type: "gable", front: "gable", pitch: 0.5, overhang: 0.6, wingSide: "both", wingWidthFt: 6, wingPitch: 0.25 };
  const fixtures: Array<[string, Any, number, number]> = [
    // tests/harness/leanTos.mjs S1: 6 ft at 1.5 ft drop on the front, 8 ft at 1 ft on the left.
    ["leanTos.mjs S1", { ...TRI, leanTos: [{ wall: "front", widthFt: 6, dropFt: 1.5 }, { wall: "left", widthFt: 8, dropFt: 1, enclosed: true }, { wall: "right", widthFt: 6, dropFt: 1.5, lengthFt: 10, offsetFt: 5 }] }, 24, 30],
    // leanTos_test's readout fixture.
    ["leanTos_test readout", { ...GABLE, porchOutFt: 6, porchEnd: "front", leanTos: [{ wall: "left", widthFt: 8, lengthFt: 8, offsetFt: -2 }, { wall: "left", widthFt: 6, lengthFt: 8, offsetFt: 3 }, { wall: "front", widthFt: 5 }, { wall: "right", widthFt: 8, dropFt: 2, attach: "wall", attachFt: 1 }] }, 12, 16],
    // wingList_test and calDraftRoof_test.
    ["wingList_test", { type: "gable", pitch: 0.4, leanTos: [{ wall: "left", widthFt: 6, attach: "roof", attachFt: 1 }, { wall: "front", widthFt: 5, enclosed: true }] }, 12, 16],
    ["calDraftRoof_test", { type: "gable", leanTos: [{ wall: "left", widthFt: 8 }, { wall: "front", widthFt: 5, enclosed: true }] }, 12, 16],
  ];
  for (const [what, roof, W, L] of fixtures) {
    const r = joinsOf(roof, W, L);
    assert(!r || r.joins.length === 0, `${what}: ${JSON.stringify(r)}`);
  }
});
