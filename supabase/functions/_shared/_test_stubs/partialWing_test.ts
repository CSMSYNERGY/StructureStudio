// A WING ALONG PART OF ITS WALL (roof.wingList[i].lengthFt / offsetFt) — tested against BOTH SHIPPED designer twins.
//
// Carolyn, Q3 (2026-10-06): "yes, a wing can cover part of a side (e.g. 20 ft of a 40 ft wall)". The wing stays
// inside the building's size, as every wing does, so the outline from above becomes an L (or a T, the wing in the
// middle of its wall) inside the same W x L, with OPEN GROUND at the corners beside the wing. Only the outermost
// wing on a side wall can do it, and not beside end wings (wingList_test pins the massing's part fields and the
// "inner" / "ends" refusals). Here, the pure answers everything else reads:
//   d3WingNotches      the open ground, in plan feet: one notch per end the wing stops short of
//   d3WallSpanFt       the stretch of each footprint wall left to doors, windows, slabs and wall devices
//   d3InNotch          whether a plan rectangle reaches into the open ground (every floor placement's refusal)
//   d3OutlinePoly      the outline with the notches cut out (the floor slab), and d3OutlineRects (the shade)
//   d3WallTops         the wing's wall over its stretch only; a gable wall without the wing's band where a notch is
//   d3LeanTosOffWing   the lean-tos left with nothing to hang on, which d3LeanTosGeom leaves out
//   d3WingListBlocksPorch  no projecting porch on a side wall carrying a part-wall wing
// Lifted by the wingList_test anchors and run; each lifted region is asserted byte-identical across the twins.
// The meshes, the plan and the page are proved on the compiled bundle (tests/harness/wingList.mjs case P,
// partialWingPlan.mjs).

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `partialWing_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_CASE_F =", "// Built-in 3D appearance per building style"],
  ["function d3RoofAxes(", "function d3FtIn("],
  ["function ssVentSpan(", "function buildFixtureTools("],
  ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  ["function d3PorchGeom(", "function d3PorchReadout("],
  ["function d3PorchReadout(", "// A dimensioned end-elevation of the style"],
];
const blocks = REGIONS.map(([a, b]) => ({ a, cmp: lift(CMP, "structure-studio.component.js", a, b), jsx: lift(JSX, "StructureStudio.jsx", a, b) }));

Deno.test("every lifted region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const NAMES = ["D3", "d3RoofAxes", "d3Massing", "d3WallTops", "d3WallTopFt", "d3WingListDeep", "d3WingRun", "d3WingNotches", "d3WallSpanFt", "d3InNotch",
  "d3OutlinePoly", "d3OutlineRects", "d3LeanTosGeom", "d3LeanTosOffWing", "d3CornerJoins", "d3WingListBlocksPorch", "d3ProjectingPorch", "d3ListEndStair", "D3_WINGLIST_ENDS"];
const F = new Function(`const isVentItem = (it) => !!(it && it.isVent);\n${blocks.map((b) => b.cmp).join("\n")}; return { ${NAMES.join(", ")} };`)() as Record<string, Any>;

const near = (a: number, b: number, msg: string, e = 1e-9) => assertAlmostEquals(a, b, e, msg);
const G = { type: "gable", pitch: 0.5, overhang: 1, eave: "fascia" };
const T = 0.3;   // D3.WALL_T, asserted below
const WALLS = ["north", "south", "east", "west"];
const L20 = (extra: Record<string, unknown> = {}) => ({ ...G, wingList: [{ wall: "left", widthFt: 8, lengthFt: 20, ...extra }] });
const shoelace = (pts: number[][]) => Math.abs(pts.reduce((s, p, k) => { const q = pts[(k + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const rectArea = (rs: number[][]) => rs.reduce((s, r) => s + (r[1] - r[0]) * (r[3] - r[2]), 0);

Deno.test("the wall thickness these tests use is the renderer's", () => assertEquals(F.D3.WALL_T, T));

// ── THE OPEN GROUND ──────────────────────────────────────────────────────────────────────────

Deno.test("portrait: 20 ft of a 24 x 40's left wall, centred, leaves a notch at each end of the wing, in plan feet", () => {
  const n = F.d3WingNotches(L20(), 24, 40, 9);
  assertEquals(n, [{ i: 0, side: -1, wall: "west", x0: 0, x1: 8, y0: 0, y1: 10 }, { i: 0, side: -1, wall: "west", x0: 0, x1: 8, y0: 30, y1: 40 }]);
  // At the back end of the wall (toward the back is minus on the left wall): one notch, at the front.
  assertEquals(F.d3WingNotches(L20({ offsetFt: -10 }), 24, 40, 9), [{ i: 0, side: -1, wall: "west", x0: 0, x1: 8, y0: 20, y1: 40 }]);
  // Held at the front end: one notch, at the back.
  assertEquals(F.d3WingNotches(L20({ offsetFt: 30 }), 24, 40, 9), [{ i: 0, side: -1, wall: "west", x0: 0, x1: 8, y0: 0, y1: 20 }]);
  // The right wall: the notch runs in from the east wall.
  assertEquals(F.d3WingNotches({ ...G, wingList: [{ wall: "right", widthFt: 6, lengthFt: 30, offsetFt: 5 }] }, 24, 40, 9),
    [{ i: 0, side: 1, wall: "east", x0: 18, x1: 24, y0: 0, y1: 10 }]);
  // A whole wing, a length at least the wall, a junk length, no list: no notch.
  for (const roof of [{ ...G, wingList: [{ wall: "left", widthFt: 8 }] }, L20({ lengthFt: 40 }), L20({ lengthFt: "" }), G, { ...G, wingWidthFt: 8 }]) {
    assertEquals(F.d3WingNotches(roof, 24, 40, 9), null, JSON.stringify(roof));
  }
});

Deno.test("landscape: a front wing on a 40 x 24 runs along x, plan x = L - z, and toward the RIGHT is plus", () => {
  // The long walls are front and back; the profile spans the 24 ft depth (u = y - 12), the ridge runs along x.
  const roof = { ...G, wingList: [{ wall: "front", widthFt: 8, lengthFt: 20, offsetFt: 6 }] };
  const m = F.d3Massing(roof, 40, 24, 9);
  assertEquals(m.uAxisIsX, false);
  const g = m.wings[0];
  assertEquals([g.wall, g.side, g.z0, g.z1, g.off], ["south", 1, 4, 24, 6]);
  // Its middle at x 26, 6 ft right of the wall's middle: the wing covers x 16..36, the notches either side.
  assertEquals(F.d3WingNotches(roof, 40, 24, 9), [
    { i: 0, side: 1, wall: "south", x0: 36, x1: 40, y0: 16, y1: 24 },
    { i: 0, side: 1, wall: "south", x0: 0, x1: 16, y0: 16, y1: 24 },
  ]);
  // The back wall's wing, toward the left (minus): x 4..24.
  assertEquals(F.d3WingNotches({ ...G, wingList: [{ wall: "back", widthFt: 5, lengthFt: 20, offsetFt: -6 }] }, 40, 24, 9), [
    { i: 0, side: -1, wall: "north", x0: 24, x1: 40, y0: 0, y1: 5 },
    { i: 0, side: -1, wall: "north", x0: 0, x1: 4, y0: 0, y1: 5 },
  ]);
});

Deno.test("a T and an L: a part-wall wing on each side, and one on a wing", () => {
  const both = { ...G, wingList: [{ wall: "left", widthFt: 8, lengthFt: 20 }, { wall: "right", widthFt: 6, lengthFt: 30, offsetFt: -5 }] };
  const n = F.d3WingNotches(both, 30, 40, 9);
  assertEquals(n.map((q: Any) => [q.wall, q.x0, q.x1, q.y0, q.y1]), [["west", 0, 8, 0, 10], ["west", 0, 8, 30, 40], ["east", 24, 30, 30, 40]]);
  // A part-wall wing outside a whole one: the notch covers only its own band.
  const stack = { ...G, wingList: [{ wall: "left", widthFt: 6 }, { wall: "left", widthFt: 4, lengthFt: 24 }] };
  assertEquals(F.d3WingNotches(stack, 30, 40, 9).map((q: Any) => [q.x0, q.x1, q.y0, q.y1]), [[0, 4, 0, 8], [0, 4, 32, 40]]);
});

Deno.test("the outline: the floor's area is W x L less w x (L - len), and the perimeter is the rectangle's", () => {
  const cases: Array<[Any, number, number, number]> = [
    [L20(), 24, 40, 24 * 40 - 8 * 20],
    [L20({ offsetFt: 30 }), 24, 40, 24 * 40 - 8 * 20],
    [{ ...G, wingList: [{ wall: "front", widthFt: 8, lengthFt: 20, offsetFt: 6 }] }, 40, 24, 40 * 24 - 8 * 20],
    [{ ...G, wingList: [{ wall: "left", widthFt: 8, lengthFt: 20 }, { wall: "right", widthFt: 6, lengthFt: 30, offsetFt: -5 }] }, 30, 40, 30 * 40 - 8 * 20 - 6 * 10],
  ];
  for (const [roof, W, L, want] of cases) {
    const n = F.d3WingNotches(roof, W, L, 9);
    const poly = F.d3OutlinePoly(n, W, L, 0);
    near(shoelace(poly), want, `${JSON.stringify(roof.wingList)}: polygon area`);
    near(rectArea(F.d3OutlineRects(n, W, L, 0)), want, `${JSON.stringify(roof.wingList)}: rectangles' area`);
    const per = poly.reduce((s: number, p: number[], k: number) => { const q = poly[(k + 1) % poly.length]; return s + Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]); }, 0);
    near(per, 2 * (W + L), "a corner notch keeps the perimeter");
    // Alternating across and down, every corner a right angle.
    poly.forEach((p: number[], k: number) => { const q = poly[(k + 1) % poly.length]; assert((p[0] === q[0]) !== (p[1] === q[1]), `edge ${k} is square: ${JSON.stringify(poly)}`); });
  }
  // Padded: the rim moves every edge out, an inside corner into the notch.
  const p = F.d3OutlinePoly(F.d3WingNotches(L20(), 24, 40, 9), 24, 40, 0.1);
  assertEquals(p.map((q: number[]) => q.map((v) => Math.round(v * 100) / 100)), [[-0.1, 9.9], [7.9, 9.9], [7.9, -0.1], [24.1, -0.1], [24.1, 40.1], [7.9, 40.1], [7.9, 30.1], [-0.1, 30.1]]);
  near(rectArea(F.d3OutlineRects(F.d3WingNotches(L20(), 24, 40, 9), 24, 40, 0.15)), shoelace(F.d3OutlinePoly(F.d3WingNotches(L20(), 24, 40, 9), 24, 40, 0.15)), "the padded rectangles are the padded polygon");
  // No notch: the rectangle.
  assertEquals(F.d3OutlinePoly(null, 12, 16, 0), [[0, 0], [12, 0], [12, 16], [0, 16]]);
  assertEquals(F.d3OutlineRects(null, 12, 16, 0), [[0, 12, 0, 16]]);
});

Deno.test("what is left of each footprint wall, and what reaches into the open ground", () => {
  const n = F.d3WingNotches(L20({ offsetFt: 3 }), 24, 40, 9);   // the wing over y 13..33
  assertEquals(WALLS.map((w) => F.d3WallSpanFt(n, w, 24, 40)), [[8, 24], [8, 24], [0, 40], [13, 33]]);
  assertEquals(WALLS.map((w) => F.d3WallSpanFt(null, w, 24, 40)), [[0, 24], [0, 24], [0, 40], [0, 40]]);
  const ln = F.d3WingNotches({ ...G, wingList: [{ wall: "front", widthFt: 8, lengthFt: 20, offsetFt: 6 }] }, 40, 24, 9);
  assertEquals(WALLS.map((w) => F.d3WallSpanFt(ln, w, 40, 24)), [[0, 40], [16, 36], [0, 16], [0, 16]]);
  // A loft over the notch, one beside it, a hair into it, and a bench against the wing's own wall.
  assertEquals(F.d3InNotch(n, 2, 2, 6, 6), true);
  assertEquals(F.d3InNotch(n, 8, 0, 24, 4), false, "flush against the face it meets");
  assertEquals(F.d3InNotch(n, 7.995, 0, 24, 4), false, "within a hair");
  assertEquals(F.d3InNotch(n, 7.9, 0, 24, 4), true);
  assertEquals(F.d3InNotch(n, 0, 14, 2, 30), false, "inside the wing");
  assertEquals(F.d3InNotch(n, 0, 12, 2, 20), true, "past the wing's end");
  assertEquals(F.d3InNotch(null, 0, 0, 24, 40), false);
});

// ── THE WALLS ────────────────────────────────────────────────────────────────────────────────

Deno.test("wall tops: the wing's wall over its stretch only; the end walls without the wing's band where a notch is", () => {
  const roof = L20();
  const m = F.d3Massing(roof, 24, 40, 9);
  assertEquals(F.d3WingListDeep(m), true);
  assertEquals(F.d3WallTops(roof, 24, 40, 9, "west"), [[10, 30, 9]], "the wing's outside wall, 10..30");
  assertEquals(F.d3WallTops(roof, 24, 40, 9, "east"), [[0, 40, m.Hc]], "the middle's own wall, as with a whole wing");
  // The end walls: the middle from the face the wing meets (its outer face, u0 - T/2) to the east wall.
  const b = m.wings[0].u0 - T / 2 + 12;
  for (const w of ["north", "south"]) assertEquals(F.d3WallTops(roof, 24, 40, 9, w), [[b, 24, m.Hc]], w);
  // The same wing whole: the stair with the wing's band (today's).
  const whole = { ...G, wingList: [{ wall: "left", widthFt: 8 }] };
  assertEquals(F.d3WallTops(whole, 24, 40, 9, "north"), [[0, b, 9], [b, 24, m.Hc]]);
  // Reaching the back wall: the north wall keeps the band, the south wall loses it.
  const back = L20({ offsetFt: -10 });
  assertEquals(F.d3WallTops(back, 24, 40, 9, "north"), [[0, b, 9], [b, 24, m.Hc]]);
  assertEquals(F.d3WallTops(back, 24, 40, 9, "south"), [[b, 24, m.Hc]]);
  assertEquals(F.d3WallTops(back, 24, 40, 9, "west"), [[0, 20, 9]]);
  // The stair without `at` is today's (the end wing's clerestory reads it so).
  assertEquals(F.d3ListEndStair(m), [[0, b, 9], [b, 24, m.Hc]]);
  assertEquals(F.d3ListEndStair(m, 0), [[b, 24, m.Hc]]);
  // Landscape: the wing's wall in the plan's frame, x = L - z.
  const land = { ...G, wingList: [{ wall: "front", widthFt: 8, lengthFt: 20, offsetFt: 6 }] };
  assertEquals(F.d3WallTops(land, 40, 24, 9, "south"), [[16, 36, 9]]);
  const ml = F.d3Massing(land, 40, 24, 9), bl = ml.wings[0].u0 + T / 2 + 12;
  assertEquals(F.d3WallTops(land, 40, 24, 9, "east"), [[0, bl, ml.Hc]], "the east end (z 0) is cut: the wing stops 4 ft short of it");
  assertEquals(F.d3WallTops(land, 40, 24, 9, "west"), [[0, bl, ml.Hc]], "and the west end (z L)");
  // The tops reach every usable stretch: each wall's span lies inside its pieces.
  for (const [r, W, L] of [[roof, 24, 40], [back, 24, 40], [land, 40, 24]] as Array<[Any, number, number]>) {
    const n = F.d3WingNotches(r, W, L, 9);
    for (const w of WALLS) {
      const tops = F.d3WallTops(r, W, L, 9, w), sp = F.d3WallSpanFt(n, w, W, L);
      if (!tops) continue;
      assert(tops[0][0] <= sp[0] + 1e-9 && tops[tops.length - 1][1] >= sp[1] - 1e-9, `${w}: ${JSON.stringify(tops)} covers ${JSON.stringify(sp)}`);
      for (let k = 1; k < tops.length; k++) near(tops[k][0], tops[k - 1][1], `${w} no gap`);
    }
  }
});

// ── WHAT A PART-WALL WING RULES OUT ──────────────────────────────────────────────────────────

Deno.test("lean-tos: one on the wing's wall inside its stretch is drawn off the wing; one past it, or into a notch, is not", () => {
  const roof = (lt: Any) => ({ ...L20(), leanTos: [lt] });
  // Inside the 10..30 stretch: drawn, hung off the wing's outer wall as today.
  const inside = roof({ wall: "left", widthFt: 6, lengthFt: 12, offsetFt: 2 });
  assertEquals(F.d3LeanTosOffWing(inside, 24, 40, 9), null);
  const g = F.d3LeanTosGeom(inside, 24, 40, 9);
  assertEquals(g.length, 1);
  near(g[0].u0, -12, "on the wing's outer wall");
  // The whole wall, or past the wing's end: not drawn, and said.
  for (const lt of [{ wall: "left", widthFt: 6 }, { wall: "left", widthFt: 6, lengthFt: 12, offsetFt: 6 }, { wall: "left", widthFt: 6, lengthFt: 22 }]) {
    assertEquals(F.d3LeanTosOffWing(roof(lt), 24, 40, 9), [{ i: 0, kind: "eave", wing: 0, len: 20 }], JSON.stringify(lt));
    assertEquals(F.d3LeanTosGeom(roof(lt), 24, 40, 9), [], JSON.stringify(lt));
  }
  // On an end wall: clear of the notch it is drawn; across it, not.
  assertEquals(F.d3LeanTosGeom(roof({ wall: "back", widthFt: 5, lengthFt: 10, offsetFt: 5 }), 24, 40, 9).length, 1, "back, clear of the notch (u 0..10)");
  assertEquals(F.d3LeanTosOffWing(roof({ wall: "back", widthFt: 5 }), 24, 40, 9), [{ i: 0, kind: "gable", wing: 0, len: 20 }]);
  assertEquals(F.d3LeanTosOffWing(roof({ wall: "front", widthFt: 5, lengthFt: 10, offsetFt: -6 }), 24, 40, 9), [{ i: 0, kind: "gable", wing: 0, len: 20 }], "front, over u -11..-1");
  // A notch at the back only: the front end wall is clear.
  assertEquals(F.d3LeanTosOffWing({ ...L20({ offsetFt: 10 }), leanTos: [{ wall: "front", widthFt: 5 }] }, 24, 40, 9), null);
  // The other side wall: untouched.
  assertEquals(F.d3LeanTosOffWing(roof({ wall: "right", widthFt: 6 }), 24, 40, 9), null);
  // The corner joins see only what is drawn: a back lean-to and a left one that would meet at the back-left corner.
  const pair = { ...L20(), leanTos: [{ wall: "left", widthFt: 6 }, { wall: "back", widthFt: 6 }] };
  assertEquals(F.d3CornerJoins(pair, 24, 40, 9), null);
  // A whole-wall wing keeps every lean-to it had.
  const wholeLt = { ...G, wingList: [{ wall: "left", widthFt: 8 }], leanTos: [{ wall: "left", widthFt: 6 }, { wall: "back", widthFt: 5 }] };
  assertEquals(F.d3LeanTosOffWing(wholeLt, 24, 40, 9), null);
  assertEquals(F.d3LeanTosGeom(wholeLt, 24, 40, 9).length, 2);
});

Deno.test("porch: no projecting porch on a side wall carrying a part-wall wing; an end-wall porch stays", () => {
  const roof = { ...L20(), front: "gable" };
  assertEquals(F.d3WingListBlocksPorch(roof, 24, 40, "west"), true);
  assertEquals(F.d3WingListBlocksPorch(roof, 24, 40, "east"), false);
  assertEquals(F.d3WingListBlocksPorch(roof, 24, 40, "south"), false);
  assertEquals(F.d3ProjectingPorch({ ...roof, porchOutFt: 6, porchEnd: "left" }, 24, 40), null, "the side porch is not drawn");
  assertEquals(F.d3ProjectingPorch({ ...roof, porchOutFt: 6, porchEnd: "front" }, 24, 40), { D: 6, wall: "south" }, "the front porch is");
  // A whole wing on that wall never blocked one.
  assertEquals(F.d3WingListBlocksPorch({ ...G, front: "gable", wingList: [{ wall: "left", widthFt: 8 }] }, 24, 40, "west"), false);
});

// ── EVERY SIZE ───────────────────────────────────────────────────────────────────────────────

Deno.test("⚠️ every size, both frames: the notches sit at corners inside the building, the outline's area is the formula, the tops cover what is left", () => {
  const LISTS: Array<[string, Any]> = [
    ["left20", L20()],
    ["leftEnd", L20({ offsetFt: -40 })],
    ["two", { ...G, wingList: [{ wall: "left", widthFt: 8, lengthFt: 20 }, { wall: "right", widthFt: 6, lengthFt: 12, offsetFt: 4 }] }],
    ["stack", { ...G, wingList: [{ wall: "left", widthFt: 6 }, { wall: "left", widthFt: 4, lengthFt: 10, offsetFt: 2 }, { wall: "right", widthFt: 5, lengthFt: 14 }] }],
    ["front", { ...G, wingList: [{ wall: "front", widthFt: 7, lengthFt: 9, offsetFt: -3 }, { wall: "back", widthFt: 6, lengthFt: 11 }] }],
    ["withEnds", { ...G, wingList: [{ wall: "left", widthFt: 8, lengthFt: 10 }, { wall: "front", widthFt: 6 }] }],
  ];
  const SIZES = [[8, 10], [10, 12], [12, 16], [16, 24], [24, 28], [24, 40], [37, 22], [28, 20], [60, 40], [16, 12]];
  let n = 0, notched = 0;
  for (const [name, base] of LISTS) {
    for (const [W, L] of SIZES) {
      for (const front of [undefined, "gable", "eave"]) {
        const roof = { ...base, ...(front ? { front } : {}) };
        const tag = `${name} ${W}x${L} front ${front}`;
        const m = F.d3Massing(roof, W, L, 9), ns = F.d3WingNotches(roof, W, L, 9);
        const parts = m.wings.filter((g: Any) => g.part);
        if (m.ends.length) assert(!parts.length, `${tag}: no part-wall wing beside end wings`);
        parts.forEach((g: Any) => { assert(g.outer, tag); assert(g.len >= 4 - 1e-9 && g.len < m.L, tag); assert(g.z0 >= -1e-9 && g.z1 <= m.L + 1e-9, tag); });
        assertEquals(!!ns, parts.length > 0 && parts.some((g: Any) => g.z0 > 1e-6 || g.z1 < m.L - 1e-6), tag);
        let cut = 0;
        (ns || []).forEach((q: Any) => {
          assert(q.x0 >= -1e-9 && q.x1 <= W + 1e-9 && q.y0 >= -1e-9 && q.y1 <= L + 1e-9 && q.x1 > q.x0 && q.y1 > q.y0, `${tag}: ${JSON.stringify(q)}`);
          const corner = (q.x0 < 1e-6 || q.x1 > W - 1e-6) && (q.y0 < 1e-6 || q.y1 > L - 1e-6);
          assert(corner, `${tag}: a notch at a corner ${JSON.stringify(q)}`);
          cut += (q.x1 - q.x0) * (q.y1 - q.y0);
        });
        near(shoelace(F.d3OutlinePoly(ns, W, L, 0)), W * L - cut, `${tag}: outline area`);
        near(rectArea(F.d3OutlineRects(ns, W, L, 0)), W * L - cut, `${tag}: rectangles`);
        for (const w of WALLS) {
          const sp = F.d3WallSpanFt(ns, w, W, L), tops = F.d3WallTops(roof, W, L, 9, w);
          assert(sp[1] - sp[0] > 0.5, `${tag} ${w}: a wall left ${JSON.stringify(sp)}`);
          if (tops) assert(tops[0][0] <= sp[0] + 1e-9 && tops[tops.length - 1][1] >= sp[1] - 1e-9, `${tag} ${w}: ${JSON.stringify(tops)} covers ${JSON.stringify(sp)}`);
        }
        if (ns) notched++;
        n++;
      }
    }
  }
  assert(notched > 40, `only ${notched} notched massings`);
  console.log(`part-wall sweep: ${n} massings, ${notched} with open ground`);
});
