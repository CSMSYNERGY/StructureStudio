// THE PORCH ON A SIDE WALL — tested against BOTH SHIPPED designer twins.
//
// The 09-28 call @5:13, on a single slant's porch end: "your front and back is right, but we may actually
// also need to be able to have it on the sides", and the door wall stays the front. So in the new frame
// (roof.front or roof.highSide set) roof.porchEnd takes "left" and "right" too, the west and east walls as
// seen from the front; outside it they read as "front", which is what production's `!== "back"` draws.
// ONE pure answer, d3PorchWall (with d3PorchEnd and d3PorchOnEave), is read by everything that places a
// porch: the projecting porch and its span, the recessed porch and its posts, the truss, the roof step,
// the lean-to readout and the panels. Pure module-scope code, lifted by stable anchors and run; every
// lifted region is asserted byte-identical across the two hand-mirrored twins. The meshes are proved on
// the compiled bundle by tests/harness/porchProbe.mjs (cases P*, PS*, PJ9/PJ10).
//
// The promise tested hardest: FRONT, BACK AND ABSENT COME OUT EXACTLY AS THEY DID, and outside the frame
// a side is the front, everywhere.

import { assert, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `porchSides_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_CASE_F =", "// Built-in 3D appearance per building style"],
  // d3RoofAxes, d3NewFrame, d3PorchEnd / d3PorchWall / d3PorchOnEave, d3Massing, the lean-to list,
  // d3PorchJoins, d3RoofStep, d3PorchToRoot, d3RecessedPorchToRoot, d3RecessedLostWords.
  ["function d3RoofAxes(", "function d3FtIn("],
  // ssPorchTrussWall, d3ProjectingPorch, d3PorchSpan.
  ["function ssVentSpan(", "function buildFixtureTools("],
  ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  // d3PorchGeom, d3RecessedPorch, d3RecessedPorchFrame, d3PorchCapFt.
  ["function d3PorchGeom(", "function d3PorchReadout("],
  // d3PorchReadout, d3RecessedPorchReadout, d3LeanTosReadout.
  ["function d3PorchReadout(", "// A dimensioned end-elevation of the style"],
];
const blocks = REGIONS.map(([a, b]) => ({ a, cmp: lift(CMP, "structure-studio.component.js", a, b), jsx: lift(JSX, "StructureStudio.jsx", a, b) }));
// The words the builder reads (ssDrewWords, SS_CHANGE_WORDS), the compare step's pure half.
// d3FtIn first, which every "in feet" line is written through (selfCheckPanel_test's two regions).
const WORDS: Array<[string, string]> = [["function d3FtIn(", "// ── THE PROJECTING PORCH'S NUMBERS"], ["const SS_RENDER_MS =", "// Upload a list with BOUNDED CONCURRENCY"]];
const words = WORDS.map(([a, b]) => ({ a, cmp: lift(CMP, "structure-studio.component.js", a, b), jsx: lift(JSX, "StructureStudio.jsx", a, b) }));

Deno.test("every lifted region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
  for (const { a, cmp, jsx } of words) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `const isVentItem = (it) => !!(it && it.isVent);\n${blocks.map((b) => b.cmp).join("\n")}; ` +
    `return { D3, d3RoofAxes, d3NewFrame, d3PorchEnd, d3PorchWall, d3PorchOnEave, d3Massing, d3WingsOn, d3ProjectingPorch, d3PorchSpan, ` +
    `d3RecessedPorch, d3RecessedPorchFrame, d3RecessedPorchReadout, d3PorchReadout, ssPorchTrussWall, d3RoofStep, d3PorchToRoot, ` +
    `d3RecessedPorchToRoot, d3PorchCapFt, d3PorchWallTopFt, d3LeanTosReadout, d3RecessedLostWords, d3WingListBlocksPorch, d3PorchJoins };`,
)() as Record<string, Any>;
const Wd = new Function(`${words.map((w) => w.cmp).join("\n")}; return { ssDrewWords, SS_CHANGE_WORDS };`)() as Record<string, Any>;

const H = 8;
const ENDS = [undefined, "front", "back", "left", "right"] as const;
const SIZES: Array<[number, number]> = [[12, 16], [16, 12], [10, 20], [14, 14]];
// Every roof kind in and out of the frame.
const FRAMED: Array<[string, Any]> = [
  ["gable, front a gable end", { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6 }],
  ["gable, front a long side", { type: "gable", front: "eave", pitch: 0.4, overhang: 0.6 }],
  ["gambrel, front a gable end", { type: "gambrel", front: "gable", pitch: 1.2, overhang: 0.4, kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1 }],
  ["gambrel, front a long side", { type: "gambrel", front: "eave", pitch: 1.2, overhang: 0.4, kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1 }],
  ...(["front", "back", "left", "right"] as const).map((hs): [string, Any] => [`shed, high side ${hs}`, { type: "shed", highSide: hs, pitch: 0.25, overhang: 0.6 }]),
];
const OLD: Array<[string, Any]> = [
  ["gable, no front", { type: "gable", pitch: 0.4, overhang: 0.6 }],
  ["gambrel, no front", { type: "gambrel", pitch: 1.2, overhang: 0.4, kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1 }],
  ["shed, no high side", { type: "shed", pitch: 0.25, overhang: 0.6 }],
  // Keys the sanitiser would drop count as absent: a front on a shed, a high side on a gable.
  ["shed with a stray front", { type: "shed", front: "gable", pitch: 0.25 }],
  ["gable with a stray high side", { type: "gable", highSide: "left", pitch: 0.4 }],
];
const COMPASS: Record<string, string> = { front: "south", back: "north", left: "west", right: "east" };
const withEnd = (roof: Any, end: string | undefined) => (end === undefined ? { ...roof } : { ...roof, porchEnd: end });
const json = (v: unknown) => JSON.stringify(v);
// The same, blind to porchEnd itself: a roof the answer carries (d3RoofStep's rearCfg) holds the key it was given.
const jsonNoEnd = (v: unknown) => JSON.stringify(v, (k, x) => (k === "porchEnd" ? undefined : x));

// The rules every caller wrote inline before 2026-10-05, restated from the source they replaced: the
// projecting porch's wall, the recessed porch, and the truss.
const old = {
  wall(cfg: Any, W: number, L: number) {
    const front = (cfg.porchEnd || "front") !== "back";
    return F.d3NewFrame(cfg) ? (front ? "south" : "north") : F.d3RoofAxes(cfg, W, L).uAxisIsX ? (front ? "south" : "north") : (front ? "west" : "east");
  },
  recessed(cfg: Any, W: number, L: number, h: number) {
    if (F.d3ProjectingPorch(cfg, W, L)) return null;
    const ax = F.d3RoofAxes(cfg, W, L);
    const frontBack = F.d3NewFrame(cfg) || ax.uAxisIsX;
    const depth = Math.max(0, Math.min(Number(cfg.porchDepthFt) || 0, (frontBack ? L : W) - 4));
    if (!(depth > 0.5)) return null;
    if (F.d3WingsOn(F.d3Massing(cfg, W, L, h || F.D3.WALL_H))) return null;
    const front = (cfg.porchEnd || "front") !== "back";
    return { wall: frontBack ? (front ? "south" : "north") : (front ? "west" : "east"), depth, onEave: F.d3NewFrame(cfg) && !ax.uAxisIsX };
  },
  truss(cfg: Any, W: number, L: number) {
    if (!cfg.porchTruss || (cfg.type || "gable") !== "gable") return null;
    if (F.d3ProjectingPorch(cfg, W, L)) return null;
    if (F.d3WingsOn(F.d3Massing(cfg, W, L, F.D3.WALL_H))) return null;
    const ax = F.d3RoofAxes(cfg, W, L);
    const depth = Math.max(0, Math.min(Number(cfg.porchDepthFt) || 0, (ax.uAxisIsX ? L : W) - 4));
    if (!(depth > 0.5)) return null;
    const front = (cfg.porchEnd || "front") !== "back";
    if (F.d3NewFrame(cfg)) return ax.uAxisIsX ? (front ? "south" : "north") : null;
    return ax.uAxisIsX ? (front ? "south" : "north") : (front ? "west" : "east");
  },
};

// ── ONE: the one answer ─────────────────────────────────────────────────────────────────────

Deno.test("d3PorchWall: in the frame each end is its own wall, whatever kind; outside it the old rule, a side read as the front", () => {
  for (const [W, L] of SIZES) {
    for (const [what, roof] of FRAMED) {
      for (const end of ENDS) {
        const cfg = withEnd(roof, end);
        assert(F.d3NewFrame(cfg), what);
        assertEquals(F.d3PorchEnd(cfg), end || "front", `${what} ${end}`);
        assertEquals(F.d3PorchWall(cfg, W, L), COMPASS[end || "front"], `${what} ${end} at ${W}x${L}`);
        // An eave wall is one the ridge runs along: the profile's ends, west/east when the span runs along x.
        const ax = F.d3RoofAxes(cfg, W, L), wall = COMPASS[end || "front"];
        assertEquals(F.d3PorchOnEave(cfg, W, L), ax.uAxisIsX ? wall === "west" || wall === "east" : wall === "south" || wall === "north", `${what} ${end}`);
      }
    }
    for (const [what, roof] of OLD) {
      for (const end of ENDS) {
        const cfg = withEnd(roof, end);
        assert(!F.d3NewFrame(cfg), what);
        assertEquals(F.d3PorchEnd(cfg), end === "back" ? "back" : "front", `${what} ${end}`);
        assertEquals(F.d3PorchWall(cfg, W, L), old.wall(cfg, W, L), `${what} ${end} at ${W}x${L}`);
        assertEquals(F.d3PorchOnEave(cfg, W, L), false, `${what}: never an eave wall outside the frame`);
      }
    }
  }
  // Junk is the front, as `!== "back"` always read it.
  for (const junk of ["Left", "west", "side", "", 0, null]) assertEquals(F.d3PorchEnd({ type: "gable", front: "gable", porchEnd: junk }), "front", String(junk));
  assertEquals([F.d3PorchEnd(null), F.d3PorchEnd(undefined), F.d3PorchWall(null, 12, 16), F.d3PorchOnEave(null, 12, 16)], ["front", "front", "south", false]);
});

Deno.test("⚠️ byte-equal: front, back, absent and junk give every porch function exactly what the inline rules gave", () => {
  const ends = [undefined, "front", "back", "sideways"];
  const porches: Any[] = [{ porchOutFt: 6 }, { porchOutFt: 0.4 }, { porchDepthFt: 5, porchTruss: true }, { porchDepthFt: 0.4 }, { porchDepthFt: 30, porchTruss: true },
    { porchDepthFt: 5, porchTruss: true, wingSide: "both", wingWidthFt: 4 }, { porchOutFt: 6, porchDepthFt: 5, porchTruss: true }, {}];
  let n = 0;
  for (const [W, L] of SIZES) {
    for (const [what, roof] of [...FRAMED, ...OLD]) {
      for (const p of porches) {
        for (const end of ends) {
          const cfg = withEnd({ ...roof, ...p }, end);
          const tag = `${what} ${json(p)} ${end} at ${W}x${L}`;
          const pj = F.d3ProjectingPorch(cfg, W, L);
          if (pj) assertEquals(pj.wall, old.wall(cfg, W, L), `projecting: ${tag}`);
          assertEquals(json(F.d3RecessedPorch(cfg, W, L, H)), json(old.recessed(cfg, W, L, H)), `recessed: ${tag}`);
          assertEquals(F.ssPorchTrussWall(cfg, W, L), old.truss(cfg, W, L), `truss: ${tag}`);
          n++;
        }
      }
    }
  }
  assert(n > 1000, `${n} cases`);
});

Deno.test("⚠️ outside the frame a side IS the front: every reader gives a left or right porch exactly the front one's answer", () => {
  const porches: Any[] = [{ porchOutFt: 6 }, { porchOutFt: 5, porchWidthFt: 8, porchAttachFt: 7.5, porchSteps: "leftSide" }, { porchDepthFt: 5, porchTruss: true, porchSteps: "center" },
    { porchDepthFt: 4, rearStepFt: 8, rearEaveRiseFt: 0.4 }, { porchOutFt: 6, rearStepFt: 8, rearEaveRiseFt: 0.4 }];
  for (const [W, L] of SIZES) {
    const size = `${W}x${L}`;
    for (const [what, roof] of OLD) {
      for (const p of porches) {
        const front = { ...roof, ...p, porchEnd: "front" };
        for (const end of ["left", "right"]) {
          const side = { ...roof, ...p, porchEnd: end };
          const tag = `${what} ${json(p)} ${end} at ${size}`;
          assertEquals(json(F.d3ProjectingPorch(side, W, L)), json(F.d3ProjectingPorch(front, W, L)), tag);
          assertEquals(json(F.d3PorchSpan(side, W, L)), json(F.d3PorchSpan(front, W, L)), tag);
          assertEquals(json(F.d3RecessedPorchFrame(side, W, L, H)), json(F.d3RecessedPorchFrame(front, W, L, H)), tag);
          assertEquals(F.ssPorchTrussWall(side, W, L), F.ssPorchTrussWall(front, W, L), tag);
          assertEquals(jsonNoEnd(F.d3RoofStep(side, W, L, H)), jsonNoEnd(F.d3RoofStep(front, W, L, H)), tag);
          assertEquals(json(F.d3PorchReadout({ roof: side, wallHeightFt: H }, size)), json(F.d3PorchReadout({ roof: front, wallHeightFt: H }, size)), tag);
          assertEquals(json(F.d3RecessedPorchReadout({ roof: side, wallHeightFt: H }, size)), json(F.d3RecessedPorchReadout({ roof: front, wallHeightFt: H }, size)), tag);
          const a = F.d3PorchToRoot(side, W, L), b = F.d3PorchToRoot(front, W, L);
          assertEquals(json(a && a(1.5, 2)), json(b && b(1.5, 2)), tag);
        }
      }
    }
  }
});

// ── TWO: a side porch, wall by wall ─────────────────────────────────────────────────────────

Deno.test("a front gable's side walls are EAVE walls: the porch runs down the ridge, no truss, recessed posts every 10 ft or less", () => {
  const roof = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6 };
  for (const [end, wall] of [["left", "west"], ["right", "east"]]) {
    const out = { ...roof, porchEnd: end, porchOutFt: 6 };
    assertEquals(F.d3ProjectingPorch(out, 12, 24), { D: 6, wall });
    assertEquals(F.d3PorchSpan(out, 12, 24), { span: 24, centerU: 0, onCap: false, full: 24 }, "the whole 24 ft side");
    assertEquals(F.d3PorchSpan({ ...out, porchWidthFt: 10 }, 12, 24), { span: 10, centerU: 0, onCap: false, full: 24 });
    const rec = { ...roof, porchEnd: end, porchDepthFt: 5, porchTruss: true };
    assertEquals(F.d3RecessedPorch(rec, 12, 24, H), { wall, depth: 5, onEave: true });
    // Held to leave 4 ft of the 12 ft width behind it, the run a side porch eats into.
    assertEquals(F.d3RecessedPorch({ ...rec, porchDepthFt: 30 }, 12, 24, H).depth, 8);
    assertEquals(F.ssPorchTrussWall(rec, 12, 24), null, "no gable over an eave wall: no truss");
    const fr = F.d3RecessedPorchFrame(rec, 12, 24, H);
    assertEquals([fr.bays, fr.posts, fr.side], [3, 4, 12 - 0.4], "24 ft of eave: three bays, a post every 8 ft");
    assertEquals(F.d3RecessedPorchFrame({ ...rec, porchSteps: "center" }, 12, 20, H).posts, 4, "two bays and centre steps: one more, so no post stands at the top of them");
  }
});

Deno.test("a long-side front's side walls are GABLE ends: the porch runs across the profile, with the truss", () => {
  const roof = { type: "gable", front: "eave", pitch: 0.4, overhang: 0.6 };
  for (const [end, wall] of [["left", "west"], ["right", "east"]]) {
    const out = { ...roof, porchEnd: end, porchOutFt: 6 };
    // 24 ft along the front, 12 deep: the gable end is the 12 ft depth.
    assertEquals(F.d3PorchSpan(out, 24, 12), { span: 12, centerU: 0, onCap: true, full: 12 });
    const rec = { ...roof, porchEnd: end, porchDepthFt: 5, porchTruss: true };
    assertEquals(F.d3RecessedPorch(rec, 24, 12, H), { wall, depth: 5, onEave: false });
    assertEquals(F.d3RecessedPorch({ ...rec, porchDepthFt: 30 }, 24, 12, H).depth, 20, "the 24 ft run, less 4");
    assertEquals(F.ssPorchTrussWall(rec, 24, 12), wall, "a gable end: the truss stands in it");
    assertEquals(F.ssPorchTrussWall({ ...rec, type: "gambrel" }, 24, 12), null, "gable roofs only, as ever");
    const fr = F.d3RecessedPorchFrame(rec, 24, 12, H);
    assertEquals([fr.bays, fr.posts], [1, 2], "two corner posts across a gable end");
  }
  // The front and back are the eave walls now: no truss there, as before.
  assertEquals(F.ssPorchTrussWall({ ...roof, porchEnd: "front", porchDepthFt: 5, porchTruss: true }, 24, 12), null);
});

Deno.test("a single slant: a side porch on the high wall, the low wall or a sloped end, each read as that wall", () => {
  // High side LEFT: the span runs across the width, the west wall is the high eave wall and the east the low one.
  const left = { type: "shed", highSide: "left", pitch: 0.25, overhang: 0.6 };
  const hiL = { ...left, porchEnd: "left", porchOutFt: 5 };
  assertEquals(F.d3PorchSpan(hiL, 12, 16).onCap, false);
  assertEquals(F.d3PorchWallTopFt(hiL, 12, 16, H), H + 12 * 0.25, "the high eave wall's top");
  assertEquals(F.d3RecessedPorch({ ...left, porchEnd: "left", porchDepthFt: 4 }, 12, 16, H), { wall: "west", depth: 4, onEave: true });
  assertEquals(F.d3PorchWallTopFt({ ...left, porchEnd: "right", porchOutFt: 5 }, 12, 16, H), H, "the low side: the plate");
  // High side FRONT: the side walls are the sloped ends.
  const front = { type: "shed", highSide: "front", pitch: 0.25, overhang: 0.6 };
  assertEquals(F.d3PorchSpan({ ...front, porchEnd: "right", porchOutFt: 5 }, 16, 12).onCap, true);
  assertEquals(F.d3RecessedPorch({ ...front, porchEnd: "right", porchDepthFt: 4 }, 16, 12, H), { wall: "east", depth: 4, onEave: false });
  assertEquals(F.ssPorchTrussWall({ ...front, porchEnd: "right", porchDepthFt: 4, porchTruss: true }, 16, 12), null, "no truss on a single slant");
});

Deno.test("⚠️ a side porch is the SAME porch as a front one on that building turned a quarter: every number but its wall", () => {
  // A 12x16 front gable's left wall is a 16 ft eave wall over a 12 ft span; so is a 16x12 long-side front's front wall.
  const pairs: Array<[string, Any, string, Any, string]> = [
    ["front gable, left eave wall", { type: "gable", front: "gable", porchEnd: "left" }, "12x16", { type: "gable", front: "eave", porchEnd: "front" }, "16x12"],
    ["front gable, right eave wall", { type: "gable", front: "gable", porchEnd: "right" }, "12x16", { type: "gable", front: "eave", porchEnd: "back" }, "16x12"],
    ["long-side front, left gable end", { type: "gable", front: "eave", porchEnd: "left" }, "16x12", { type: "gable", front: "gable", porchEnd: "front" }, "12x16"],
    ["single slant high left, the high wall", { type: "shed", highSide: "left", porchEnd: "left" }, "12x16", { type: "shed", highSide: "front", porchEnd: "front" }, "16x12"],
    ["single slant high left, the low wall", { type: "shed", highSide: "left", porchEnd: "right" }, "12x16", { type: "shed", highSide: "front", porchEnd: "back" }, "16x12"],
  ];
  const kinds: Any[] = [{ porchOutFt: 6 }, { porchOutFt: 5, porchAttachFt: 7.5, porchPitch: 0.15, porchPosts: 3, porchSteps: "center" },
    { porchOutFt: 4, porchWidthFt: 8, porchSteps: "rightSide" }, { porchDepthFt: 5, porchSteps: "left" }];
  const shape = { pitch: 0.4, overhang: 0.6, eave: "fascia" };
  const noWall = (r: Any) => (r ? json({ ...r, wall: undefined, steps: r.steps ? { ...r.steps, wall: undefined } : r.steps }) : json(r));
  for (const [what, a, sa, b, sb] of pairs) {
    for (const k of kinds) {
      const ra = { ...shape, ...(a.type === "shed" ? { pitch: 0.25 } : {}), ...a, ...k }, rb = { ...shape, ...(b.type === "shed" ? { pitch: 0.25 } : {}), ...b, ...k };
      const tag = `${what} ${json(k)}`;
      const pa = F.d3PorchReadout({ roof: ra, wallHeightFt: H }, sa), pb = F.d3PorchReadout({ roof: rb, wallHeightFt: H }, sb);
      assertEquals(noWall(pa), noWall(pb), `projecting: ${tag}`);
      const qa = F.d3RecessedPorchReadout({ roof: ra, wallHeightFt: H }, sa), qb = F.d3RecessedPorchReadout({ roof: rb, wallHeightFt: H }, sb);
      assertEquals(noWall(qa), noWall(qb), `recessed: ${tag}`);
      assert(!!(pa || qa), `${tag}: something was built`);
    }
  }
});

Deno.test("the porch's own frame (d3PorchToRoot, d3RecessedPorchToRoot) stands out of its side wall, x to the right of someone facing it", () => {
  const roof = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6 };
  // Outside the west wall facing east, the right hand points south (+z); outside the east wall, north.
  const L = F.d3PorchToRoot({ ...roof, porchEnd: "left", porchOutFt: 6 }, 12, 16), R = F.d3PorchToRoot({ ...roof, porchEnd: "right", porchOutFt: 6 }, 12, 16);
  assertEquals([L(0, 5), L(2, 0)], [[-11, 0], [-6, 2]]);
  assertEquals([R(0, 5), R(2, 0)], [[11, 0], [6, -2]]);
  const RL = F.d3RecessedPorchToRoot({ ...roof, porchEnd: "left", porchDepthFt: 4 }, 12, 16, H);
  assertEquals([RL(0, 1), RL(3, 0)], [[-7, 0], [-6, 3]]);
});

Deno.test("d3RoofStep: refused beside a porch on a side wall, recessed or projecting; kept with the end but no porch", () => {
  const roof = { type: "gable", front: "gable", pitch: 0.4, overhang: 1, rearStepFt: 10, rearEaveRiseFt: 0.4 };
  assert(F.d3RoofStep(roof, 16, 30, H) !== null, "the step alone is drawn");
  assert(F.d3RoofStep({ ...roof, porchEnd: "front", porchOutFt: 6 }, 16, 30, H) !== null, "beside a front porch");
  for (const end of ["left", "right", "back"]) {
    assertEquals(F.d3RoofStep({ ...roof, porchEnd: end, porchOutFt: 6 }, 16, 30, H), null, `${end}, projecting`);
    assertEquals(F.d3RoofStep({ ...roof, porchEnd: end, porchDepthFt: 5 }, 16, 30, H), null, `${end}, recessed`);
    assert(F.d3RoofStep({ ...roof, porchEnd: end }, 16, 30, H) !== null, `${end} with no porch`);
  }
});

Deno.test("a lean-to on the same side wall as a porch is flagged on its card; one beside it meets the porch, unless one is over it", () => {
  const roof = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, porchEnd: "left", porchDepthFt: 4, leanTos: [{ wall: "left", widthFt: 8 }, { wall: "front", widthFt: 6 }] };
  const rd = F.d3LeanTosReadout({ roof, wallHeightFt: H }, "12x16");
  assertEquals(rd.map((r: Any) => [r.wall, r.porch]), [["left", "recessed"], ["front", null]]);
  // The porch projecting on the left wall (an eave wall), a lean-to on the front wall (an end wall) running to its
  // corner: d3PorchJoins pairs them at the front-left corner, and set to its card's numbers it joins.
  const pj = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, porchEnd: "left", porchOutFt: 6, porchAttachFt: 7.5 };
  const asked = { ...pj, leanTos: [{ wall: "front", widthFt: 6, meetPorch: true }] };
  const beside = F.d3PorchJoins(asked, 12, 16, H);
  assertEquals([beside.porch.wall, beside.porch.kind, beside.near.map((N: Any) => N.at)], ["west", "eave", ["front-left"]]);
  const fix = F.d3LeanTosReadout({ roof: asked, wallHeightFt: H }, "12x16")[0].porchCorner.fix;
  const matched = { ...asked, leanTos: [{ ...asked.leanTos[0], attach: fix.attach || undefined, attachFt: fix.attach ? fix.attachFt : undefined, dropFt: fix.dropFt }] };
  const met = F.d3PorchJoins(matched, 12, 16, H);
  assertEquals(met.joins.map((J: Any) => [J.i, J.at, J.lt]), [[0, "front-left", "gable"]], json(met.near));
  // ...and a lean-to on the porch's own side wall, over the porch, stops it, said by its index.
  const over = F.d3PorchJoins({ ...matched, leanTos: [...matched.leanTos, { wall: "left", widthFt: 8 }] }, 12, 16, H);
  assert(over.joins.length === 0 && over.near[0].why.includes("underLeanTo") && over.near[0].over === 1, json(over.near));
  assertEquals(F.d3LeanTosReadout({ roof: { ...matched, leanTos: [...matched.leanTos, { wall: "left", widthFt: 8 }] }, wallHeightFt: H }, "12x16")[1].porch, "projecting");
});

Deno.test("a recessed porch lost to an end wing points at a side wall with no end wing, in the frame", () => {
  // A long-side front: the left and right walls are the gable ends. An end wing on the left leaves the right.
  const roof = { type: "gable", front: "eave", pitch: 0.4, overhang: 0.6, porchDepthFt: 4, wingList: [{ wall: "left", widthFt: 6 }] };
  const m = F.d3Massing(roof, 24, 12, H);
  assert(m.list && m.ends && m.ends.length === 1, "an end wing on the left gable end");
  assertEquals(F.d3WingListBlocksPorch(roof, 24, 12, "east"), false);
  const w = F.d3RecessedLostWords(roof, 24, 12);
  assert(/Use a projecting porch on the right wall, the end with no end wing\./.test(w), w);
  // With no front there is no side to offer: the old sentence.
  assert(!/left|right/.test(F.d3RecessedLostWords({ ...roof, front: undefined }, 24, 12)), "no side offered without a front");
});

// ── THREE: what the builder reads ───────────────────────────────────────────────────────────

Deno.test("the drawn words name the side in the frame, and the front without it", () => {
  const said = (roof: Any) => String(Wd.ssDrewWords({ roof })).split(/(?<=\.) /).filter((x) => /^The porch/.test(x));
  assertEquals(said({ type: "gable", front: "gable", porchOutFt: 6, porchEnd: "left" }), ["The porch stands 6 ft out from the left side wall."]);
  assertEquals(said({ type: "shed", highSide: "front", porchDepthFt: 5, porchEnd: "right" }), ["The porch is cut 5 ft into the right side wall."]);
  assertEquals(said({ type: "gable", porchOutFt: 6, porchEnd: "left" }), ["The porch stands 6 ft out from the front end."], "no front: the front end");
  assertEquals(said({ type: "gable", front: "gable", porchOutFt: 6, porchEnd: "back" }), ["The porch stands 6 ft out from the back wall."]);
  assertEquals(said({ type: "gable", front: "gable", porchOutFt: 6 }), ["The porch stands 6 ft out from the front wall."]);
  const [, say] = Wd.SS_CHANGE_WORDS["roof.porchEnd"];
  assertEquals(["left", "right", "back", "front"].map(say), ["the left side", "the right side", "the other end", "the end you filmed first"]);
});
