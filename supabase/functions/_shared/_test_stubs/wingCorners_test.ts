// WING ROOFS THAT MEET AT A CORNER (roof.wingCornersMeet) — tested against BOTH SHIPPED designer twins.
//
// Carolyn, 10-01, on her photo of a side wing whose roof steps up over the end wing's: she wants the two to run
// as ONE roof around the corner. Beside end wings a side wing's outside wall rises so its roof passes over
// theirs (d3MassingList step 7). With the switch on, a side wing and an end wing that match exactly -- each
// alone on its wall, both Automatic, as wide and as steep, the side wing's outside wall not asked away from the
// building's -- keep their outside walls at H, and the two roofs cross on the hip. d3WingCornerPairs finds the
// pairs before the solve, d3MassingList keeps a joined side wing at H and writes the corners, and d3WingCorners
// answers "what would meet" for the Advanced page's switch. All of it is pure module-scope code, lifted by the
// wingList_test anchors and run; each lifted region is asserted byte-identical across the two twins. The
// meshes (bodies, slabs, fascias and soffits cut on the hip, the hip cap, the end wing's clerestory stopping at
// the side wing's) are proved on the compiled bundle by tests/harness/wingList.mjs case J.
//
// The promises tested hardest:
//   1. WITHOUT THE SWITCH (absent, false, or anything but true) EVERY MASSING IS THE ONE IT WAS.
//   2. NOTHING IS NUDGED TO MAKE A CORNER MEET: a pair a hair apart is a near-miss, with its numbers, and the
//      building is drawn exactly as it is without the switch.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `wingCorners_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_CASE_F =", "// Built-in 3D appearance per building style"],
  // d3RoofAxes, d3Massing and the wing list block (d3MassingList, d3WingCornerPairs, d3WingCorners), the wall tops.
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
const F = new Function(
  `const isVentItem = (it) => !!(it && it.isVent);\n${blocks.map((b) => b.cmp).join("\n")}; return { D3, d3RoofAxes, d3Massing, d3WallTops, d3WallTopFt, d3CeilingFt, d3MassingTopAt, d3ModelTopFt, d3FrameHeightFt, d3LeanTosGeom, d3WingCorners, d3WingCornerPairs, d3ListEndStair, D3_WL_CORNER_TOL, D3_WINGLIST_ENDS };`,
)() as Record<string, Any>;

const near = (a: number, b: number, msg: string, e = 1e-9) => assertAlmostEquals(a, b, e, msg);
const nearAll = (got: number[][] | null, want: number[][], msg: string) => {
  assert(got, `${msg}: no pieces`);
  assertEquals(got!.length, want.length, `${msg}: ${JSON.stringify(got)}`);
  got!.forEach((p, k) => p.forEach((v, q) => near(v, want[k][q], `${msg} ${k}.${q}: ${JSON.stringify(got)}`)));
};
const G = { type: "gable", pitch: 0.5, overhang: 1, eave: "fascia" };
const W = (wall: string, extra: Record<string, unknown> = {}) => ({ wall, widthFt: 8, ...extra });
// Case T (wingList_test): the Tri Home's two side wings and a front end wing, 24x28, H 9, the middle at 17.
const T = { ...G, centerEaveFt: 17, wingList: [W("left"), W("right"), W("front")] };
const ON = (roof: Any) => ({ ...roof, wingCornersMeet: true });
const WALLS = ["north", "south", "east", "west"];
const strip = (m: Any) => JSON.parse(JSON.stringify(m, (k, v) => (k === "corners" || k === "hipEnds" || k === "hipSides" ? undefined : v)));
const side = (m: Any, s: number) => m.wings.find((g: Any) => g.side === s);

Deno.test("the end wings are drawn (the switch has something to meet) and the tolerance is a plain number", () => {
  assertEquals(F.D3_WINGLIST_ENDS, true);
  assertEquals(F.D3_WL_CORNER_TOL, 0.01);
  assert(/const D3_WL_CORNER_TOL = 0\.01;/.test(CMP), "a literal, so shedProfile_test can evaluate the region alone");
});

// ── ONE: without the switch nothing moves ────────────────────────────────────────────────────

/** Every pure reader's answer for one roof at one size, as one string (wingList_test's dig, trimmed). */
const dig = (roof: Any, Wd: number, D: number, H: number) => {
  const m = F.d3Massing(roof, Wd, D, H);
  return JSON.stringify({
    m,
    tops: WALLS.map((w) => F.d3WallTops(roof, Wd, D, H, w)),
    topFt: WALLS.map((w) => [0, 3, 7.5, 11].map((a) => F.d3WallTopFt(roof, Wd, D, H, w, a, a + 2))),
    ceil: [-0.45, -0.2, 0, 0.2, 0.45].flatMap((fx) => [-0.45, -0.2, 0, 0.2, 0.45].map((fz) => F.d3CeilingFt(roof, Wd, D, H, fx * Wd, fz * D))),
    topAt: [-0.6, -0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6].map((f) => F.d3MassingTopAt(m, f * m.S)),
    lts: F.d3LeanTosGeom(roof, Wd, D, H),
    frame: F.d3FrameHeightFt({ roof, wallHeightFt: H }, Wd, D),
    top: F.d3ModelTopFt({ roof, wallHeightFt: H }, Wd, D),
  });
};
// Seeded lists: side and end wings, stacks, attaches, asked outside walls, both frames.
const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = <X>(r: () => number, a: X[]): X => a[Math.floor(r() * a.length)];
const randomList = (r: () => number) => {
  const n = 1 + Math.floor(r() * 5), out: Any[] = [];
  for (let k = 0; k < n; k++) {
    const e: Any = { wall: pick(r, ["left", "right", "front", "back", "left", "front"]), widthFt: pick(r, [5, 6, 7, 8, 8, 8, 10]) };
    if (r() < 0.6) e.pitch = pick(r, [0.25, 0.25, 1 / 3, 0.5, 0.2]);
    if (r() < 0.15) { e.attach = pick(r, ["wall", "roof"]); e.attachFt = pick(r, [0.5, 1, 2]); }
    if (r() < 0.15) e.eaveFt = pick(r, [9, 10, 12]);
    out.push(e);
  }
  return out;
};
const SIZES = [[24, 28], [28, 24], [20, 32], [30, 30], [16, 20], [37, 22]];

Deno.test("⚠️ without the switch -- absent, false, or anything but true -- every reader answers what it did", () => {
  const r = rng(20261005);
  let n = 0;
  for (let k = 0; k < 160; k++) {
    const list = randomList(r);
    for (const front of [undefined, "gable", "eave"]) {
      const roof: Any = { ...G, ...(front ? { front } : {}), ...(r() < 0.4 ? { centerEaveFt: pick(r, [13, 15, 17]) } : {}), wingList: list };
      const [Wd, D] = pick(r, SIZES), H = pick(r, [8, 9, 10]);
      const base = dig(roof, Wd, D, H);
      for (const v of [false, "true", 1, null, {}, [true]]) {
        assertEquals(dig({ ...roof, wingCornersMeet: v }, Wd, D, H), base, `${JSON.stringify(roof)} ${Wd}x${D} H${H} with ${JSON.stringify(v)}`);
        n++;
      }
      const m = F.d3Massing(roof, Wd, D, H);
      assert(!("corners" in m) && m.wings.every((g: Any) => !("hipEnds" in g)) && (m.ends || []).every((t: Any) => !("hipSides" in t)), "no corner field without the switch");
    }
  }
  assert(n > 2500, String(n));
});

Deno.test("⚠️ with the switch but no pair (no end wing, no side wing, or a style without a list) nothing moves either", () => {
  const cases: Any[] = [
    { ...G, wingList: [W("left"), W("right")] },                               // side wings only
    { ...G, wingList: [W("front"), W("back", { widthFt: 6 })] },               // end wings only
    { ...G, wingSide: "both", wingWidthFt: 8, wingPitch: 0.25, centerEaveFt: 17 }, // legacy wings
    { type: "gable", pitch: 0.4 },
    { type: "shed", pitch: 0.25, highSide: "front", wingList: [W("left"), W("front")] },
  ];
  for (const roof of cases) {
    for (const [Wd, D] of SIZES) {
      assertEquals(dig(ON(roof), Wd, D, 9), dig(roof, Wd, D, 9), `${JSON.stringify(roof)} ${Wd}x${D}`);
      assertEquals(F.d3WingCorners(roof, Wd, D, 9), null, `${JSON.stringify(roof)} ${Wd}x${D}: no pair`);
    }
  }
});

// ── TWO: the worked numbers ──────────────────────────────────────────────────────────────────

Deno.test("Case T: both side wings meet the front end wing; nothing steps up, the middle keeps its asked 17 ft", () => {
  const off = F.d3Massing(T, 24, 28, 9), m = F.d3Massing(ON(T), 24, 28, 9);
  // Off: today's step-up (wingList_test Case T).
  for (const s of [-1, 1]) { near(side(off, s).ye, 12, `off ${s} ye`); assertEquals(side(off, s).raised, true); }
  assertEquals(m.corners, {
    joins: [{ name: "front-left", s: -1, at: 1, i: 0, j: 2, w: 8, pitch: 0.25, ye: 9, ya: 11 }, { name: "front-right", s: 1, at: 1, i: 1, j: 2, w: 8, pitch: 0.25, ye: 9, ya: 11 }],
    near: [],
  });
  for (const s of [-1, 1]) {
    const g = side(m, s);
    near(g.ye, 9, `${s} ye`); near(g.ya, 11, `${s} ya`); near(g.pitch, 0.25, `${s} pitch`);
    assertEquals([g.raised, g.raisedFrom, g.raisedBy, g.tight, g.hipEnds], [false, null, [], false, [1]], `side ${s}`);
    near(g.top, 17, `${s} meets the middle`);
  }
  const t = m.ends[0];
  near(t.ye, 9, "end ye"); near(t.ya, 11, "end ya"); near(t.pitch, 0.25, "end pitch");
  assertEquals([t.hipSides, t.tight, t.raised], [[-1, 1], false, false]);
  near(m.Hc, 17, "Hc as asked"); assertEquals(m.hcRaised, false);
  near(m.E["-1"], 9, "E west"); near(m.E["1"], 9, "E east");
  // The long walls are the wings' and the end wing's outside walls: H end to end.
  assertEquals(F.d3WallTops(ON(T), 24, 28, 9, "west"), null);
  assertEquals(F.d3WallTops(ON(T), 24, 28, 9, "east"), null);
  assertEquals(F.d3WallTops(ON(T), 24, 28, 9, "south"), null);
  // The back gable: each side wing's gable end at H, the middle at 17.
  nearAll(F.d3WallTops(ON(T), 24, 28, 9, "north"), [[0, 7.85, 9], [7.85, 16.15, 17], [16.15, 24, 9]], "north");
  near(F.d3WallTopFt(ON(T), 24, 28, 9, "west", 22, 24), 9, "the west wall at the corner");
  near(F.d3CeilingFt(ON(T), 24, 28, 9, -10, 12), 9, "ceiling in the corner square");
  near(F.d3CeilingFt(ON(T), 24, 28, 9, 0, 0), 17, "ceiling under the middle");
  near(F.d3ModelTopFt({ roof: ON(T), wallHeightFt: 9 }, 24, 28), 19, "the ridge did not move");
  // The end wing meets the middle's end wall over the middle and the hips beside it: its face is the middle's.
  near(t.top, 17, "the end wing's face"); near(off.ends[0].top, 12, "off: the stepped long walls");
  // Everything else but the side walls' heights is the massing without the switch: the end wing, the middle's run.
  assertEquals(JSON.stringify({ ...strip(m.ends)[0], top: 0 }), JSON.stringify({ ...off.ends[0], top: 0 }));
  for (const k of ["Sc", "uc", "Hc", "zA", "zB", "prof", "listDropped"]) assertEquals(m[k], off[k], k);
});

Deno.test("Case T with a blank middle: the middle's least height follows the side wings down, and still clears every roof", () => {
  const roof = { ...T, centerEaveFt: undefined };
  const off = F.d3Massing(roof, 24, 28, 9), m = F.d3Massing(ON(roof), 24, 28, 9);
  near(off.Hc, 17, "off: 3 ft over the raised wings' 14");
  // On: 3 ft over the wings' 11, above both floors (the side wings' 12 and the end wing's 12.13).
  near(m.Hc, 14, "on: 3 ft over 11");
  const a = F.D3.ROOF_T + 0.43;
  near(Math.max(11 + Math.max(1, a + (0.5 - 0.25) * 1), 11 + Math.max(1, a + 0.5 * 1)), 12.13, "the floors");
  assert(m.Hc >= 12.13 - 1e-9 && !m.hcRaised);
});

Deno.test("four end-and-side corners, both frames: each name is where the corner stands", () => {
  // World: x east, z south (front); a portrait building's ridge runs along z, a landscape one's along x.
  for (const [Wd, D, front] of [[24, 28, undefined], [28, 24, undefined], [24, 28, "gable"], [28, 24, "gable"], [24, 28, "eave"], [30, 30, "gable"]] as const) {
    const ax = F.d3RoofAxes({ ...G, ...(front ? { front } : {}) }, Wd, D);
    const eave = ax.uAxisIsX ? ["left", "right"] : ["back", "front"], gab = ax.uAxisIsX ? ["back", "front"] : ["right", "left"];
    const roof = ON({ ...G, ...(front ? { front } : {}), centerEaveFt: 17, wingList: [W(eave[0]), W(eave[1]), W(gab[0]), W(gab[1])] });
    const m = F.d3Massing(roof, Wd, D, 9), tag = `${Wd}x${D} front ${front}`;
    assertEquals(m.corners.joins.length, 4, `${tag}: ${JSON.stringify(m.corners)}`);
    assertEquals(m.corners.near, [], tag);
    for (const J of m.corners.joins) {
      const g = m.wings.find((q: Any) => q.i === J.i), t = m.ends.find((q: Any) => q.i === J.j);
      const u = g.u1, z = t.zO;   // the building's corner: the side wing's outside line, the end wing's
      const x = ax.uAxisIsX ? u : m.L / 2 - z, zw = ax.uAxisIsX ? z - m.L / 2 : u;
      const want = `${zw > 0 ? "front" : "back"}-${x > 0 ? "right" : "left"}`;
      assertEquals(J.name, want, `${tag}: ${J.name} stands at x ${x}, z ${zw}`);
      assert(J.name.split("-").includes(g.bwall) && J.name.split("-").includes(t.bwall), `${tag}: ${J.name} names ${g.bwall} and ${t.bwall}`);
      assertEquals([J.s, J.at], [g.side, t.at], tag);
      assert(g.hipEnds.includes(t.at) && t.hipSides.includes(g.side), `${tag}: both records carry the join`);
    }
    for (const g of m.wings) { near(g.ye, 9, `${tag} side ${g.side} at H`); assertEquals(g.hipEnds, [0, 1], tag); }
    for (const t of m.ends) assertEquals(t.hipSides, [-1, 1], tag);
    // Wrapped all round: every exterior wall is H.
    for (const w of WALLS) assertEquals(F.d3WallTops(roof, Wd, D, 9, w), null, `${tag} ${w}`);
  }
});

// ── THREE: near-misses, with their numbers, and never a nudge ──────────────────────────────────

const nearOf = (roof: Any, Wd = 24, D = 28, H = 9) => {
  const m = F.d3Massing(ON(roof), Wd, D, H);
  return { m, c: m.corners, off: F.d3Massing(roof, Wd, D, H) };
};
/** A near-miss builds exactly the building without the switch. */
const asOff = (m: Any, off: Any, tag: string) => assertEquals(JSON.stringify(strip(m)), JSON.stringify(off), `${tag}: drawn as without the switch`);

Deno.test("width: a 6 ft side wing beside an 8 ft end wing is a near-miss, dw 2, and steps up as before", () => {
  const roof = { ...T, wingList: [W("left", { widthFt: 6 }), W("front")] };
  const { m, c, off } = nearOf(roof);
  assertEquals(c.joins, []);
  assertEquals(c.near, [{ name: "front-left", s: -1, at: 1, i: 0, j: 1, why: ["width"], dw: 2, dp: 0, dy: 0 }]);
  asOff(m, off, "width");
  assert(side(m, -1).ye > 9 && side(m, -1).raised, "still stepped up");
});

Deno.test("pitch: 4 in 12 beside 3 in 12 is a near-miss with dp, and a hair's pitch (inside 0.01 ft at the top) joins", () => {
  const { m, c, off } = nearOf({ ...T, wingList: [W("left", { pitch: 4 / 12 }), W("front", { pitch: 0.25 })] });
  assertEquals(c.near.map((p: Any) => [p.name, p.why]), [["front-left", ["pitch"]]]);
  near(c.near[0].dp, 0.25 - 4 / 12, "dp, the end wing's less the side wing's");
  asOff(m, off, "pitch");
  // 0.001 of pitch over 8 ft is 0.008 ft at the top: float noise, joined. 0.002 is 0.016 ft: a near-miss.
  assertEquals(nearOf({ ...T, wingList: [W("left", { pitch: 0.251 }), W("front", { pitch: 0.25 })] }).c.joins.length, 1);
  assertEquals(nearOf({ ...T, wingList: [W("left", { pitch: 0.252 }), W("front", { pitch: 0.25 })] }).c.near[0].why, ["pitch"]);
});

Deno.test("width tolerance: 0.005 ft apart joins, 0.02 ft apart is a near-miss", () => {
  assertEquals(nearOf({ ...T, wingList: [W("left", { widthFt: 8.005 }), W("front")] }).c.joins.length, 1);
  const { c } = nearOf({ ...T, wingList: [W("left", { widthFt: 8.02 }), W("front")] });
  assertEquals(c.near[0].why, ["width"]);
  near(c.near[0].dw, -0.02, "dw");
});

Deno.test("height: a side wing whose outside wall is asked at 12 ft is a near-miss, dy 3; asked at the wall's own 9 it joins", () => {
  const { m, c, off } = nearOf({ ...T, wingList: [W("left", { eaveFt: 12 }), W("front")] });
  assertEquals(c.near.map((p: Any) => [p.why, p.dy]), [[["height"], 3]]);
  asOff(m, off, "height");
  near(side(m, -1).ye, 12, "its ask, as before");
  const j = nearOf({ ...T, wingList: [W("left", { eaveFt: 9 }), W("front")] });
  assertEquals(j.c.joins.length, 1);
  near(side(j.m, -1).ye, 9, "joined at 9");
});

Deno.test("attach: a side or end wing set to meet the middle on the wall (or up its roof) is a near-miss, and keeps its attach", () => {
  for (const [list, tag] of [
    [[W("left", { attach: "wall", attachFt: 1 }), W("front")], "side on the wall"],
    [[W("left", { attach: "roof", attachFt: 1 }), W("front")], "side on the roof"],
    [[W("left"), W("front", { attach: "wall", attachFt: 1 })], "end on the wall"],
  ] as const) {
    const { m, c, off } = nearOf({ ...T, wingList: list });
    assertEquals(c.near.map((p: Any) => p.why), [["attach"]], tag);
    asOff(m, off, tag);
  }
  // "On the roof" on an end wing is built Automatic (roofIgnored): no attach, so it joins.
  assertEquals(nearOf({ ...T, wingList: [W("left"), W("front", { attach: "roof", attachFt: 1 })] }).c.joins.length, 1);
});

Deno.test("stack: a wing on a wing, on either wall, is a near-miss; the outermost pair is named", () => {
  for (const [list, i, j] of [
    [[W("left"), W("left", { widthFt: 6 }), W("front")], 1, 2],
    [[W("left"), W("front"), W("front", { widthFt: 5 })], 0, 2],
  ] as const) {
    const { m, c, off } = nearOf({ ...T, wingList: list }, 30, 32);
    assertEquals(c.near.map((p: Any) => [p.why, p.i, p.j]), [[["stack"], i, j]], JSON.stringify(list));
    asOff(m, off, JSON.stringify(list));
  }
});

Deno.test("otherEnd: a side wing that matches the front end wing but not the back one meets neither, said on both", () => {
  const { m, c, off } = nearOf({ ...T, wingList: [W("left"), W("front"), W("back", { widthFt: 6 })] });
  assertEquals(c.joins, []);
  assertEquals(c.near.map((p: Any) => [p.name, p.why]), [["back-left", ["width"]], ["front-left", ["otherEnd"]]]);
  asOff(m, off, "otherEnd");
  // Each side on its own: the right wing meets both ends while the left steps up over both.
  const two = nearOf({ ...T, wingList: [W("left"), W("right"), W("front"), W("back", { widthFt: 6 })] });
  assertEquals(two.c.joins.map((p: Any) => p.name), []);
  const both = nearOf({ ...T, wingList: [W("left", { widthFt: 6 }), W("right"), W("front"), W("back")] });
  assertEquals(both.c.joins.map((p: Any) => p.name), ["back-right", "front-right"]);
  assertEquals(both.c.near.map((p: Any) => [p.name, p.why]), [["back-left", ["width"]], ["front-left", ["width"]]]);
  near(side(both.m, 1).ye, 9, "the right wing at H");
  assert(side(both.m, -1).ye > 9 && side(both.m, -1).raised, "the left wing still steps up");
  // The east wall is H end to end; the west one still steps where the left wing rises.
  assertEquals(F.d3WallTops(ON({ ...T, wingList: [W("left", { widthFt: 6 }), W("right"), W("front"), W("back")] }), 24, 28, 9, "east"), null);
  assert(F.d3WallTops(ON({ ...T, wingList: [W("left", { widthFt: 6 }), W("right"), W("front"), W("back")] }), 24, 28, 9, "west").some((p: number[]) => p[2] > 9));
});

Deno.test("d3WingCorners: the corners as if the switch were on, on or off; null without a pair", () => {
  for (const roof of [T, ON(T), { ...T, wingList: [W("left", { widthFt: 6 }), W("front")] }]) {
    assertEquals(F.d3WingCorners(roof, 24, 28, 9), F.d3Massing(ON(roof), 24, 28, 9).corners, JSON.stringify(roof));
  }
  assertEquals(F.d3WingCorners({ ...T, wingList: [W("left"), W("right")] }, 24, 28, 9), null, "no end wing");
  assertEquals(F.d3WingCorners({ type: "gable", pitch: 0.4 }, 24, 28, 9), null, "no list");
  // A size where the room rule drops the end wing: no pair there.
  assertEquals(F.d3WingCorners({ ...T, wingList: [W("left"), W("front", { widthFt: 16 })] }, 24, 10, 9), F.d3Massing(ON({ ...T, wingList: [W("left"), W("front", { widthFt: 16 })] }), 24, 10, 9).corners || null);
});

// PART OF A WALL (lengthFt / offsetFt, 2026-10-07) is ignored beside end wings (partIgnored "ends"), so a length on
// the side wing changes no corner: the same joins and near-misses, the same massing but for that one flag.
Deno.test("⚠️ a length on a side wing beside end wings changes no corner, on or off", () => {
  const lenOf = (roof: Any) => ({ ...roof, wingList: roof.wingList.map((e: Any) => (e.wall === "left" || e.wall === "right" ? { ...e, lengthFt: 10, offsetFt: 3 } : e)) });
  const cases = [T, { ...T, wingList: [W("left", { widthFt: 6 }), W("right"), W("front")] }, { ...T, wingList: [W("left"), W("front"), W("back")] }];
  for (const base of cases) {
    for (const [w, d] of [[24, 28], [30, 40], [37, 22]]) {
      for (const roof of [base, ON(base)]) {
        const a = F.d3Massing(roof, w, d, 9), b = F.d3Massing(lenOf(roof), w, d, 9);
        const tag = `${JSON.stringify(roof.wingList)} ${w}x${d} ${roof.wingCornersMeet ? "on" : "off"}`;
        assertEquals(b.corners, a.corners, tag);
        assertEquals(F.d3WingCorners(lenOf(roof), w, d, 9), F.d3WingCorners(roof, w, d, 9), tag);
        const drop = (m: Any) => JSON.parse(JSON.stringify(m, (k, v) => (k === "partIgnored" ? undefined : v)));
        assertEquals(drop(b), drop(a), tag);
        assert(b.wings.every((g: Any) => !g.part), tag);
        if (b.ends.length) assert(b.wings.every((g: Any) => (lenOf(roof).wingList[g.i].lengthFt != null) === (g.partIgnored === "ends")), tag);
      }
    }
  }
});

// ── FOUR: the fuzz ───────────────────────────────────────────────────────────────────────────

Deno.test("⚠️ fuzz: every join is an exact match of two lone Automatic wings at H; every side wing that meets meets every end wing it runs to; no join means today's massing", () => {
  const r = rng(1005), tol = F.D3_WL_CORNER_TOL;
  let joins = 0, nears = 0, checked = 0;
  for (let k = 0; k < 1500; k++) {
    // Mostly lone matched pairs, so joins are common, with every kind of near-miss mixed in.
    const list = r() < 0.6
      ? [W(pick(r, ["left", "right"])), W(pick(r, ["front", "back"])), ...(r() < 0.5 ? [W(pick(r, ["left", "right", "front", "back"]), r() < 0.5 ? { widthFt: pick(r, [6, 8, 8.005, 8.5]) } : { pitch: pick(r, [0.25, 0.26, 1 / 3]) })] : [])]
      : randomList(r);
    const roof: Any = { ...G, ...(r() < 0.5 ? { front: pick(r, ["gable", "eave"]) } : {}), ...(r() < 0.3 ? { centerEaveFt: pick(r, [12, 15, 17]) } : {}), wingList: list };
    const [Wd, D] = pick(r, SIZES), H = pick(r, [8, 9, 10]);
    const m = F.d3Massing(ON(roof), Wd, D, H), off = F.d3Massing(roof, Wd, D, H), tag = `${JSON.stringify(roof)} ${Wd}x${D} H${H}`;
    const all = [...m.wings, ...(m.ends || [])];
    assert(all.every((q: Any) => [q.ye, q.ya, q.pitch, q.w].every(Number.isFinite)) && Number.isFinite(m.Hc), `${tag}: finite`);
    if (!m.corners) { assertEquals(JSON.stringify(m), JSON.stringify(off), `${tag}: no pair, no change`); continue; }
    checked++;
    if (!m.corners.joins.length) asOff(m, off, tag);
    for (const J of m.corners.joins) {
      joins++;
      const g = m.wings.find((q: Any) => q.i === J.i), t = m.ends.find((q: Any) => q.i === J.j);
      assert(g.outer && g.tier === 1 && t.outer && t.tier === 1, `${tag}: both alone on their walls`);
      assert(!g.attach && !t.attach, `${tag}: both Automatic`);
      assert(Math.abs(g.w - t.w) <= tol && Math.abs(g.pitch - t.pitch) * Math.max(g.w, t.w) <= tol, `${tag}: as wide and as steep`);
      assertEquals([g.ye, t.ye], [H, H], `${tag}: both at H`);
      assert(Math.abs(g.ya - t.ya) <= tol + 1e-9, `${tag}: one height where they meet the middle`);
      assert(!g.raised && !g.tight && !t.tight, `${tag}: nothing raised, nothing tight`);
      // Every end wing this side wing runs to is joined with it.
      for (const e of m.ends.filter((q: Any) => q.outer)) assert(m.corners.joins.some((q: Any) => q.i === g.i && q.j === e.i), `${tag}: ${g.i} meets ${e.i} too`);
      // The middle still clears both roofs by the floors it always kept.
      assert(m.Hc >= g.ya + 1 - 1e-9 && m.Hc >= t.ya + 1 - 1e-9, `${tag}: the middle stands over both`);
    }
    for (const p of m.corners.near) {
      nears++;
      assert(p.why.length > 0 && p.why.every((w: string) => ["stack", "attach", "height", "width", "pitch", "otherEnd"].includes(w)), `${tag}: ${p.why}`);
      const g = m.wings.find((q: Any) => q.i === p.i);
      assert(!g.hipEnds || m.corners.joins.some((q: Any) => q.i === g.i), `${tag}: a near-miss side wing is not hipped`);
    }
    // A side wing not joined is exactly the side wing without the switch.
    for (const g of m.wings.filter((q: Any) => !q.hipEnds)) {
      const o = off.wings.find((q: Any) => q.i === g.i);
      for (const f of ["ye", "ya", "pitch", "raised", "w", "u0", "u1"]) assertEquals(g[f], o[f], `${tag}: unjoined ${g.i} ${f}`);
    }
  }
  assert(joins > 300 && nears > 300 && checked > 900, `joins ${joins}, near-misses ${nears}, with pairs ${checked}`);
});
