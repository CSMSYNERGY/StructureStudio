// STACKABLE WINGS (roof.wingList) — tested against BOTH SHIPPED designer twins.
//
// roof.wingList (2026-10-01, from the 09-29 call: a core building, then a wing wherever they want it, and
// a wing on a wing, as many as fit) is an ordered list of wings, each standing on a building wall. A wing's
// parent is the previous entry on the same wall, or the middle section. Everything about it that is not a
// mesh is pure module-scope code: d3WingListEntries / d3WingListOn (the structural rule, shared with the
// sanitiser's sanitizeWingList), d3Massing's list path (d3MassingList: the room share, the chains, the push
// and meet rules, the end wings behind D3_WINGLIST_ENDS), the readers that follow it (d3WallTops,
// d3CeilingFt, d3MassingTopAt, d3LeanTosGeom, d3ProjectingPorch, d3DormerBlocked), and the two page helpers
// (d3WingListFallback for the older designer, d3WingListFromLegacy for the first list edit). They are lifted
// by stable anchors and run, the wingsMassing_test technique, and each lifted region is asserted
// byte-identical across the two hand-mirrored twins.
//
// Two evaluators: F is the source as it ships; FE is the same text with the end-wing flag line forced to
// `true`, so the end-wing numbers are pinned before that flag is flipped.
//
// The promises tested hardest:
//   1. NO STRUCTURAL LIST, NO CHANGE. Every reader answers exactly what the roof without the key answers.
//   2. A legacy style converted to a list draws the same building (the mirror).
//   3. The sanitiser and the renderer agree on which entries are structural (the fuzz).

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import { D3_WINGLIST_MAX, D3_WINGLIST_WALLS, sanitizeWingList } from "../styleD3.ts";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `wingList_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_CASE_F =", "// Built-in 3D appearance per building style"],
  // d3RoofAxes, d3Massing and the whole wing list block, the lean-to list, d3RoofStep, the wall tops.
  ["function d3RoofAxes(", "function d3FtIn("],
  // ssPorchTrussWall, d3ProjectingPorch, d3PorchSpan.
  ["function ssVentSpan(", "function buildFixtureTools("],
  ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  ["function d3PorchGeom(", "function d3PorchReadout("],
  ["function d3PorchReadout(", "// A dimensioned end-elevation of the style"],
];
const blocks = REGIONS.map(([a, b]) => ({ a, cmp: lift(CMP, "structure-studio.component.js", a, b), jsx: lift(JSX, "StructureStudio.jsx", a, b) }));

Deno.test("every lifted wing list region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// The end-wing flag is one literal line (the anchor the integrator flips for the second push).
const FLAG_OFF = "const D3_WINGLIST_ENDS = false;", FLAG_ON = "const D3_WINGLIST_ENDS = true;";
const flagOff = CMP.split(FLAG_OFF).length - 1, flagOn = CMP.split(FLAG_ON).length - 1;

// deno-lint-ignore no-explicit-any
type Any = any;
const NAMES = [
  "D3", "d3RoofAxes", "d3RoofProfile", "d3Massing", "d3MassingTopAt", "d3WallTops", "d3WallTopFt", "d3CeilingFt", "d3PorchSpanWings",
  "d3LeanTosGeom", "d3LeanToGeom", "d3RoofStep", "d3ProjectingPorch", "d3FrameHeightFt", "d3ModelTopFt", "d3RoofLands", "d3WingHcFloor",
  "d3WlNum", "d3WingListEntries", "d3WingListOn", "d3WingsOn", "d3WingListDeep", "d3ListEndStair", "d3DormerBlocked", "d3WingListBlocksPorch",
  "d3WingListFallback", "d3WingListFromLegacy", "D3_WINGLIST_MAX", "D3_WINGLIST_WALLS", "D3_WINGLIST_ENDS",
];
const build = (cmp: string) => {
  const text = REGIONS.map(([a, b]) => lift(cmp, "structure-studio.component.js", a, b)).join("\n");
  return new Function(`const isVentItem = (it) => !!(it && it.isVent);\n${text}; return { ${NAMES.join(", ")} };`)() as Record<string, Any>;
};
const F = build(CMP);
const FE = flagOn ? F : build(CMP.replace(FLAG_OFF, FLAG_ON));

Deno.test("the end-wing flag is one literal line, and FE is the source with it on", () => {
  assertEquals(flagOff + flagOn, 1, `${FLAG_OFF} or ${FLAG_ON} must appear exactly once (found ${flagOff} and ${flagOn})`);
  assertEquals(F.D3_WINGLIST_ENDS, flagOn === 1);
  assertEquals(FE.D3_WINGLIST_ENDS, true);
});

const G = { type: "gable", pitch: 0.5, overhang: 1 };
const TRI = { type: "gable", pitch: 0.5, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 8, wingPitch: 0.25, centerEaveFt: 17 };
const TRI37 = { type: "gable", front: "gable", overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 12, wingPitch: 0.333, centerEaveFt: 14 };
const CABIN = { type: "gable", front: "gable", pitch: 0.41, overhang: 1.3, eave: "fascia", porchDepthFt: 6, porchEnd: "front", porchTruss: true };
const STEP = { rearStepFt: 14, rearEaveRiseFt: 0.6 };
const LEGACY: Record<string, Any> = {
  TRI,
  triLeft: { ...TRI, wingSide: "left" },
  triBlank: { ...TRI, centerEaveFt: undefined },
  wingSidesMixed: { ...TRI, wingSides: { left: { widthFt: 6, pitch: 0.5, attach: "wall", attachFt: 1 }, right: { widthFt: 10, attach: "roof", attachFt: 2 } } },
  attachWall: { ...TRI, wingAttach: "wall", wingAttachFt: 1.5 },
  attachRoof: { ...TRI, centerEaveFt: 11, wingAttach: "roof", wingAttachFt: 1 },
  tri37Cannot: { ...TRI37, pitch: 5 / 12, wingAttach: "roof", wingAttachFt: 1 },
  gambrel: { type: "gambrel", wingSide: "both", wingWidthFt: 7, wingPitch: 0.3 },
  frontEave: { ...TRI, front: "eave" },
  plain: { type: "gable", pitch: 0.4 },
  shed: { type: "shed", highSide: "front", pitch: 0.25 },
  cabinStep: { ...CABIN, ...STEP },
  leanTos: { type: "gable", pitch: 0.4, leanTos: [{ wall: "left", widthFt: 6, attach: "roof", attachFt: 1 }, { wall: "front", widthFt: 5, enclosed: true }] },
  leanOffWing: { ...TRI, leanTos: [{ wall: "left", widthFt: 8, dropFt: 1, enclosed: true }] },
  porchOut: { type: "gable", pitch: 0.5, porchOutFt: 6, porchWidthFt: 12 },
  dormer: { type: "gable", pitch: 0.6, dormerWidthFt: 6, dormerType: "transom" },
};
// Nothing structural: not an array, empty, or entries that are not objects, have no wall word, or no width
// over half a foot.
const JUNK: Any[] = [undefined, null, [], "left", {}, [null], [{ wall: "top", widthFt: 8 }], [{ wall: "left" }], [{ wall: "left", widthFt: 0.5 }], [null, 3]];
const SIZES = [[24, 28], [37, 22], [20, 28], [12, 14], [28, 20]];
const HS = [8, 9, 12];
const WALLS = ["north", "south", "east", "west"];

/** The roof step hands back the config it drew the rear with, a copy of the roof: the key rides along, unread. */
const stepOf = (L: Record<string, Any>, roof: Any, W: number, D: number, H: number) => {
  const st = L.d3RoofStep(roof, W, D, H);
  if (st && st.rearCfg) delete st.rearCfg.wingList;
  return st;
};
/** Every pure reader's answer for one roof at one size, as one string. */
const dig = (L: Record<string, Any>, roof: Any, W: number, D: number, H: number) => {
  const spec = { roof, wallHeightFt: H };
  const m = L.d3Massing(roof, W, D, H);
  return JSON.stringify({
    m,
    tops: WALLS.map((w) => L.d3WallTops(roof, W, D, H, w)),
    topFt: WALLS.map((w) => [0, 3, 7.5, 11].map((a) => L.d3WallTopFt(roof, W, D, H, w, a, a + 2))),
    ceil: [-0.45, -0.2, 0, 0.2, 0.45].flatMap((fx) => [-0.45, -0.2, 0, 0.2, 0.45].map((fz) => L.d3CeilingFt(roof, W, D, H, fx * W, fz * D))),
    topAt: [-0.6, -0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6].map((f) => L.d3MassingTopAt(m, f * m.S)),
    span: L.d3PorchSpanWings(roof, W, D, H),
    lts: L.d3LeanTosGeom(roof, W, D, H),
    lt: L.d3LeanToGeom(roof, W, D, H),
    step: stepOf(L, roof, W, D, H),
    porch: L.d3ProjectingPorch(roof, W, D),
    frame: L.d3FrameHeightFt(spec, W, D),
    top: L.d3ModelTopFt(spec, W, D),
    lands: L.d3RoofLands(roof, m, W, D, H),
  });
};
const near = (a: number, b: number, msg: string) => assertAlmostEquals(a, b, 1e-9, msg);
const nearAll = (got: number[][], want: number[][], msg: string) => {
  assertEquals(got.length, want.length, `${msg}: ${JSON.stringify(got)}`);
  got.forEach((p, k) => p.forEach((v, q) => near(v, want[k][q], `${msg} ${k}.${q}: ${JSON.stringify(got)}`)));
};
const pick = (o: Any, ks: string[]) => Object.fromEntries(ks.map((k) => [k, o[k]]));
const tier = (m: Any, side: number, t: number) => m.wings.find((g: Any) => g.side === side && g.tier === t);

// ── ONE: no structural list, no change ───────────────────────────────────────────────────────

Deno.test("⚠️ without a structural list every reader answers exactly what the roof without the key answers, flag off and on", () => {
  let n = 0;
  for (const [name, roof] of Object.entries(LEGACY)) {
    for (const [W, D] of SIZES) {
      for (const H of HS) {
        const base = dig(F, roof, W, D, H);
        assertEquals(dig(FE, roof, W, D, H), base, `${name} ${W}x${D} H${H}: the flag moves a style with no list`);
        const m0 = F.d3Massing(roof, W, D, H);
        for (const k of ["list", "ends", "zA", "zB", "listDropped", "E", "hcRaisedBy"]) assert(!(k in m0), `${name} ${W}x${D}: a legacy massing gained ${k}`);
        for (const junk of JUNK) {
          const r = { ...roof, wingList: junk }, tag = `${name} + ${JSON.stringify(junk)} ${W}x${D} H${H}`;
          assertEquals(dig(F, r, W, D, H), base, tag);
          assertEquals(dig(FE, r, W, D, H), base, `FE ${tag}`);
          assertEquals(F.d3WingListOn(r), false, tag);
          assertEquals(F.d3DormerBlocked(r, W, D, H), null, tag);
          assertEquals(FE.d3DormerBlocked(r, W, D, H), null, tag);
          n++;
        }
        assertEquals(F.d3DormerBlocked(roof, W, D, H), null);
        // A shed never has a list: a valid one is invisible there.
        if (roof.type === "shed") assertEquals(dig(FE, { ...roof, wingList: [{ wall: "left", widthFt: 8 }, { wall: "front", widthFt: 6 }] }, W, D, H), base);
      }
    }
  }
  assert(n === Object.keys(LEGACY).length * SIZES.length * HS.length * JUNK.length, String(n));
});

// ── TWO: the mirror ──────────────────────────────────────────────────────────────────────────
// The page's first list edit converts the legacy wings (d3WingListFromLegacy at the page's size). The
// converted style must draw the same building at every size whose ridge runs the same way.

Deno.test("⚠️ mirror: a legacy wing style converted to a list draws the same building", () => {
  const WING = ["TRI", "triLeft", "triBlank", "wingSidesMixed", "attachWall", "attachRoof", "tri37Cannot", "gambrel", "frontEave", "leanOffWing"];
  const SZ = [...SIZES, [30, 32], [16, 24], [10, 12]];
  const TOP = ["Sc", "uc", "Hc", "ya", "hcRaised", "hcLow", "attach", "prof"];
  const WF = ["side", "wall", "w", "pitch", "u1", "u0", "ye", "ya", "uIn", "run", "attach", "attachFt", "k", "clamped", "cuts", "meets", "meetFt"];
  let n = 0;
  for (const name of WING) {
    const roof = LEGACY[name];
    for (const [W0, D0] of SZ) {
      for (const H of HS) {
        const list = F.d3WingListFromLegacy(roof, W0, D0, H);
        if (!list.length) continue;
        const conv: Any = { ...roof, wingList: list };
        delete conv.wingSides; delete conv.wingAttach; delete conv.wingAttachFt;
        const ux0 = F.d3RoofAxes(roof, W0, D0).uAxisIsX;
        for (const [W, D] of SZ) {
          if (F.d3RoofAxes(roof, W, D).uAxisIsX !== ux0) continue;
          const a = F.d3Massing(roof, W, D, H), b = F.d3Massing(conv, W, D, H);
          const tag = `${name} converted at ${W0}x${D0}, drawn at ${W}x${D} H${H}`;
          assertEquals(b.list, true, tag);
          assertEquals(pick(b, TOP), pick(a, TOP), tag);
          assertEquals(b.wings.map((g: Any) => pick(g, WF)), a.wings.map((g: Any) => pick(g, WF)), tag);
          assertEquals(F.d3WingListDeep(b), false, tag);
          for (const w of WALLS) assertEquals(F.d3WallTops(conv, W, D, H, w), F.d3WallTops(roof, W, D, H, w), `${tag} ${w}`);
          for (const fx of [-0.45, -0.2, 0, 0.2, 0.45]) {
            for (const fz of [-0.45, -0.2, 0, 0.2, 0.45]) {
              assertEquals(F.d3CeilingFt(conv, W, D, H, fx * W, fz * D), F.d3CeilingFt(roof, W, D, H, fx * W, fz * D), `${tag} ceiling ${fx},${fz}`);
            }
          }
          for (const f of [-0.6, -0.45, -0.3, -0.1, 0, 0.1, 0.3, 0.45, 0.6]) assertEquals(F.d3MassingTopAt(b, f * b.S), F.d3MassingTopAt(a, f * a.S), `${tag} top ${f}`);
          assertEquals(F.d3PorchSpanWings(conv, W, D, H), F.d3PorchSpanWings(roof, W, D, H), tag);
          n++;
        }
      }
    }
  }
  assert(n > 500, `only ${n} mirror comparisons`);
});

Deno.test("the conversion writes the asked width, the clamped pitch and the attach, and nothing for a style without wings", () => {
  assertEquals(F.d3WingListFromLegacy(TRI, 24, 28, 9), [{ wall: "left", widthFt: 8, pitch: 0.25 }, { wall: "right", widthFt: 8, pitch: 0.25 }]);
  assertEquals(F.d3WingListFromLegacy({ ...TRI, wingAttach: "wall", wingAttachFt: 1.5 }, 24, 28, 9).map((e: Any) => [e.attach, e.attachFt]), [["wall", 1.5], ["wall", 1.5]]);
  // A 20 ft ask is asked as 16 (the legacy clamp), and the room share shrinks it at the size, as legacy does.
  assertEquals(F.d3WingListFromLegacy({ ...TRI, wingWidthFt: 20, wingSide: "left" }, 24, 28, 9), [{ wall: "left", widthFt: 16, pitch: 0.25 }]);
  for (const roof of [LEGACY.plain, LEGACY.shed, { ...TRI, wingWidthFt: 0.4 }, {}]) assertEquals(F.d3WingListFromLegacy(roof, 24, 28, 9), []);
});

// ── THREE: the worked numbers (design §3.7; H 9, a 6:12 gable with a 1 ft overhang) ────────────

Deno.test("Case S: a side stack, two wings on the left and one on the right", () => {
  const roof = { ...G, wingList: [{ wall: "left", widthFt: 8 }, { wall: "left", widthFt: 6 }, { wall: "right", widthFt: 8 }] };
  const m = F.d3Massing(roof, 30, 32, 9);
  assertEquals(m.listDropped, []);
  assertEquals(m.wings.map((g: Any) => [g.i, g.tier, g.side, g.outer, g.wall, g.bwall]),
    [[0, 1, -1, false, "west", "left"], [2, 1, 1, true, "east", "right"], [1, 2, -1, true, "west", "left"]]);
  const [l1, r1, l2] = m.wings;
  near(l2.u1, -15, "left 2 u1"); near(l2.u0, -9, "left 2 u0"); near(l2.ye, 9, "left 2 ye"); near(l2.ya, 10.5, "left 2 ya");
  near(l1.u1, -9, "left 1 u1"); near(l1.u0, -1, "left 1 u0"); near(l1.ye, 11.5, "left 1 ye"); near(l1.ya, 13.5, "left 1 ya");
  assertEquals(l1.raised, false);
  near(l1.top, 16.5, "left 1 meets the middle"); near(l2.top, 11.5, "left 2 meets left 1's wall");
  near(r1.u1, 15, "right u1"); near(r1.u0, 7, "right u0"); near(r1.ye, 9, "right ye"); near(r1.ya, 11, "right ya");
  assert(!l1.shrunk && !l2.shrunk && !r1.shrunk);
  near(m.Sc, 8, "Sc"); near(m.uc, 3, "uc"); near(m.Hc, 16.5, "Hc"); assertEquals(m.hcRaised, false);
  near(F.d3ModelTopFt({ roof, wallHeightFt: 9 }, 30, 32), 18.5, "ridge");
  assertEquals(F.d3WingListDeep(m), true);
  const south = F.d3WallTops(roof, 30, 32, 9, "south");
  nearAll(south, [[0, 5.85, 9], [5.85, 13.85, 11.5], [13.85, 22.15, 16.5], [22.15, 30, 9]], "south");
  assertEquals(F.d3WallTops(roof, 30, 32, 9, "north"), south);
  assertEquals(F.d3WallTops(roof, 30, 32, 9, "west"), null);
  assertEquals(F.d3WallTops(roof, 30, 32, 9, "east"), null);
  near(F.d3MassingTopAt(m, -12), 9.75, "top at -12"); near(F.d3MassingTopAt(m, -5), 12.5, "top at -5");
  near(F.d3CeilingFt(roof, 30, 32, 9, -12, 0), 9, "ceiling -12"); near(F.d3CeilingFt(roof, 30, 32, 9, -5, 0), 11.5, "ceiling -5");
  near(F.d3CeilingFt(roof, 30, 32, 9, 3, 0), 16.5, "ceiling 3"); near(F.d3CeilingFt(roof, 30, 32, 9, 10, 0), 9, "ceiling 10");
  assertEquals(F.d3WingListFallback(roof, 30, 32, 9), { wingSide: "both", wingWidthFt: 14, wingPitch: 0.32142857142857145 });
  // No end wall in the list: the flag changes nothing.
  assertEquals(JSON.stringify(FE.d3Massing(roof, 30, 32, 9)), JSON.stringify(m));
});

Deno.test("Case E: one end wing on the front (flag on)", () => {
  const roof = { ...G, wingList: [{ wall: "front", widthFt: 8 }] };
  const m = FE.d3Massing(roof, 24, 32, 9);
  assertEquals([m.ends.length, m.wings.length, m.listDropped.length], [1, 0, 0]);
  const t = m.ends[0];
  assertEquals([t.i, t.wall, t.bwall, t.at, t.sz, t.tier, t.outer], [0, "south", "front", 1, 1, 1, true]);
  near(t.zO, 32, "zO"); near(t.zI, 24, "zI"); near(t.ye, 9, "ye"); near(t.ya, 11, "ya"); near(t.pitch, 0.25, "pitch");
  near(m.zA, 0, "zA"); near(m.zB, 24, "zB");
  near(m.Hc, 12.13, "Hc (blank: the least that clears)"); assertEquals(m.hcRaised, false);
  near(m.E["-1"], 12.13, "E west"); near(m.E["1"], 12.13, "E east"); near(t.top, 12.13, "top");
  near(FE.d3ModelTopFt({ roof, wallHeightFt: 9 }, 24, 32), 18.13, "ridge");
  nearAll(FE.d3WallTops(roof, 24, 32, 9, "west"), [[0, 24.15, 12.13], [24.15, 32, 9]], "west");
  nearAll(FE.d3WallTops(roof, 24, 32, 9, "east"), [[0, 24.15, 12.13], [24.15, 32, 9]], "east");
  assertEquals(FE.d3WallTops(roof, 24, 32, 9, "south"), null);
  nearAll(FE.d3WallTops(roof, 24, 32, 9, "north"), [[0, 24, 12.13]], "north");
  nearAll(FE.d3ListEndStair(m), [[0, 24, 12.13]], "the end clerestory's tops");
  near(FE.d3CeilingFt(roof, 24, 32, 9, 0, 14), 9, "ceiling under the end wing");
  near(FE.d3CeilingFt(roof, 24, 32, 9, 0, 0), 12.13, "ceiling under the middle");
  assertEquals(FE.d3WingListFallback(roof, 24, 32, 9), { drop: true });
  assertEquals(FE.d3WingListDeep(m), true);
});

Deno.test("Case T: the Tri Home plus a front end wing (flag on)", () => {
  const roof = { ...G, centerEaveFt: 17, wingList: [{ wall: "left", widthFt: 8 }, { wall: "right", widthFt: 8 }, { wall: "front", widthFt: 8 }] };
  const m = FE.d3Massing(roof, 24, 28, 9);
  assertEquals(m.ends.length, 1);
  const t = m.ends[0];
  near(t.zO, 28, "zO"); near(t.zI, 20, "zI"); near(m.zB, 20, "zB"); near(t.ye, 9, "end ye"); near(t.ya, 11, "end ya");
  assertEquals(m.wings.map((g: Any) => [g.i, g.side, g.tier]), [[0, -1, 1], [1, 1, 1]]);
  for (const g of m.wings) {
    near(g.ye, 12, `side ${g.side} ye`); near(g.ya, 14, `side ${g.side} ya`);
    assertEquals([g.raised, g.raisedFrom, g.raisedBy], [true, 9, [2]], `side ${g.side}`);
  }
  near(m.E["-1"], 12, "E west"); near(m.E["1"], 12, "E east");
  near(m.Sc, 8, "Sc"); near(m.uc, 0, "uc"); near(m.Hc, 17, "Hc (asked)"); assertEquals(m.hcRaised, false);
  near(FE.d3ModelTopFt({ roof, wallHeightFt: 9 }, 24, 28), 19, "ridge");
  nearAll(FE.d3WallTops(roof, 24, 28, 9, "west"), [[0, 20.15, 12], [20.15, 28, 9]], "west");
  nearAll(FE.d3WallTops(roof, 24, 28, 9, "north"), [[0, 7.85, 12], [7.85, 16.15, 17], [16.15, 24, 12]], "north");
  assertEquals(FE.d3WallTops(roof, 24, 28, 9, "south"), null);
  // The side wings' own fallback: one wing per side, the end wing missing (honest).
  assertEquals(FE.d3WingListFallback(roof, 24, 28, 9), { wingSide: "both", wingWidthFt: 8, wingPitch: (14 - 9) / 8 });
});

// ── FOUR: push and meet ──────────────────────────────────────────────────────────────────────

Deno.test("push: an Automatic wing on a wing raises the wall it meets above that wall's ask, and says by whom and from what", () => {
  const m = F.d3Massing({ ...G, wingList: [{ wall: "left", widthFt: 8, eaveFt: 11 }, { wall: "left", widthFt: 6, pitch: 1 }] }, 30, 32, 9);
  const t1 = tier(m, -1, 1), t2 = tier(m, -1, 2);
  assertEquals([t1.raised, t1.raisedBy, t1.raisedFrom, t1.ask, t1.askIgnored], [true, [1], 11, 11, false]);
  near(t2.ya, 15, "tier 2's roof top: 9 + 6 at 12:12");
  near(t1.ye, 16, "pushed to 1 ft over it (its own slope 0.25 is under 1, so the 1 ft rule rules)");
  // The outermost wing's outside wall is the building's: an eaveFt there is stored and ignored.
  assertEquals([t2.ask, t2.askIgnored, t2.ye], [null, true, 9]);
});

Deno.test("meet: a wing on a wing 'On the wall' meets that wall where asked, and never pushes it", () => {
  let m = F.d3Massing({ ...G, wingList: [{ wall: "left", widthFt: 8, eaveFt: 13 }, { wall: "left", widthFt: 6, attach: "wall", attachFt: 1 }] }, 30, 32, 9);
  let t1 = tier(m, -1, 1), t2 = tier(m, -1, 2);
  near(t1.ye, 13, "the asked wall, exactly");
  near(t2.pitch, (12 - 9) / 6, "its pitch follows");
  near(t2.ya, 12, "1 ft under the wall's top");
  assertEquals([t2.attach, t2.meets, t2.meetFt, t2.clamped, t2.cuts], ["wall", "wall", 1, false, false]);
  assertEquals(t1.raised, false);
  // Asked lower than 1 ft over the wing's own wall: held there, and said (low).
  m = F.d3Massing({ ...G, wingList: [{ wall: "left", widthFt: 8, eaveFt: 9.5 }, { wall: "left", widthFt: 6, attach: "wall", attachFt: 1 }] }, 30, 32, 9);
  t1 = tier(m, -1, 1); t2 = tier(m, -1, 2);
  assertEquals(t1.low, true); near(t1.ye, 10, "held 1 ft over tier 2's wall");
  near(t2.ya, 9, "1 ft under a 10 ft wall is its own wall's top: a flat roof"); near(t2.pitch, 0, "flat");
  assertEquals([t2.meetFt, t2.clamped, t2.cuts], [1, false, false]);
  // "On the roof" is only for a wing against the middle: on a wing on a wing it is built Automatic.
  m = F.d3Massing({ ...G, wingList: [{ wall: "left", widthFt: 8 }, { wall: "left", widthFt: 6, attach: "roof", attachFt: 2 }] }, 30, 32, 9);
  t2 = tier(m, -1, 2);
  assertEquals([t2.roofIgnored, "attach" in t2, t2.pitch], [true, false, 0.25]);
  near(t2.ya, 10.5, "Automatic at its own pitch");
  // Against the middle it is honoured.
  m = F.d3Massing({ ...G, wingList: [{ wall: "left", widthFt: 6, attach: "roof", attachFt: 1 }, { wall: "left", widthFt: 5 }, { wall: "right", widthFt: 6 }] }, 30, 40, 9);
  t1 = tier(m, -1, 1);
  assertEquals([t1.attach, t1.roofIgnored, m.attach], ["roof", false, "roof"]);
  assert(t1.uIn != null && t1.meets != null, JSON.stringify(t1));
});

Deno.test("a 3-deep chain with attached tiers settles: no wing is left under a face below its floor", () => {
  const a = D3A();
  for (const wingList of [
    [{ wall: "left", widthFt: 6 }, { wall: "left", widthFt: 5, attach: "wall", attachFt: 1 }, { wall: "left", widthFt: 4, pitch: 0.5 }],
    [{ wall: "left", widthFt: 6, attach: "wall", attachFt: 1 }, { wall: "left", widthFt: 5, attach: "wall", attachFt: 1 }, { wall: "left", widthFt: 4, pitch: 0.5 }],
    [{ wall: "right", widthFt: 5, attach: "wall", attachFt: 2 }, { wall: "right", widthFt: 5, pitch: 1.2, attach: "wall", attachFt: 0.2 }, { wall: "right", widthFt: 4, pitch: 0.9 }],
  ]) {
    const m = F.d3Massing({ ...G, wingList }, 30, 40, 9);
    assertEquals(m.wings.length, 3);
    assert(m.wings.every((g: Any) => !g.tight), JSON.stringify(m.wings.map((g: Any) => [g.i, g.tight])));
    const s = m.wings[0].side;
    for (let k = 2; k <= 3; k++) {
      const child = tier(m, s, k), parent = tier(m, s, k - 1);
      if (child.attach) near(child.ya, parent.ye - child.meetFt, `tier ${k} meets its face where it says`);
      else assert(parent.ye >= child.ya + Math.max(1, a + Math.max(0, parent.pitch - child.pitch) * 1) - 1e-9, `tier ${k} ${JSON.stringify(m.wings)}`);
    }
  }
});
function D3A() { return F.D3.ROOF_T + 0.43; }

// ── FIVE: room ────────────────────────────────────────────────────────────────────────────────

Deno.test("room: the middle keeps 4 ft; equal asks share evenly, others in proportion; a sliver is listed, not drawn, and stays stored", () => {
  let m = F.d3Massing({ ...G, wingList: [{ wall: "left", widthFt: 10 }, { wall: "left", widthFt: 10 }, { wall: "right", widthFt: 10 }] }, 24, 28, 9);
  assertEquals(m.wings.length, 3);
  m.wings.forEach((g: Any) => { near(g.w, Math.min(10, 20 / 3), "equal asks"); assertEquals([g.want, g.shrunk], [10, true]); });
  near(m.Sc, 4, "the middle keeps 4 ft");
  m = F.d3Massing({ ...G, wingList: [{ wall: "left", widthFt: 10 }, { wall: "left", widthFt: 8 }, { wall: "right", widthFt: 10 }] }, 24, 28, 9);
  m.wings.forEach((g: Any) => near(g.w, g.want * 20 / 28, `proportional, entry ${g.i}`));
  near(m.Sc, 4, "the middle keeps 4 ft");
  // 19.8 is asked as 16, so at 24 wide (room 20) both fit as asked; at 16 wide (room 12) the 0.6 ft wing gets
  // 0.6 * 12 / 16.6 = 0.434 ft and is not drawn, but it is still in the list the sanitiser keeps.
  const sliver = [{ wall: "left", widthFt: 19.8 }, { wall: "left", widthFt: 0.6 }];
  m = F.d3Massing({ ...G, wingList: sliver }, 24, 28, 9);
  assertEquals([m.listDropped, m.wings.map((g: Any) => g.w)], [[], [16, 0.6]]);
  m = F.d3Massing({ ...G, wingList: sliver }, 16, 24, 9);
  assertEquals(m.listDropped, [{ i: 1, why: "room" }]);
  assertEquals(m.wings.map((g: Any) => [g.i, g.tier, g.outer]), [[0, 1, true]]);
  near(m.wings[0].w, 16 * 12 / 16.6, "the other keeps its proportional share");
  assertEquals(sanitizeWingList(sliver), [{ wall: "left", widthFt: 16 }, { wall: "left", widthFt: 0.6 }]);
  // The end pool (flag on): a 10 x 12 portrait has L - 4 = 8 for both ends.
  m = FE.d3Massing({ ...G, wingList: [{ wall: "front", widthFt: 8 }, { wall: "back", widthFt: 8 }] }, 10, 12, 9);
  assertEquals(m.ends.length, 2);
  m.ends.forEach((t: Any) => { near(t.w, 4, "equal share of the end pool"); assertEquals(t.shrunk, true); });
  near(m.zB - m.zA, 4, "the middle keeps 4 ft along the ridge");
});

// ── SIX: chains ───────────────────────────────────────────────────────────────────────────────

Deno.test("chains: removing the inner wing moves the next one in; swapping two swaps their tiers", () => {
  const L3 = [{ wall: "left", widthFt: 5, pitch: 0.3 }, { wall: "left", widthFt: 4, pitch: 0.4 }, { wall: "left", widthFt: 3 }];
  const full = F.d3Massing({ ...G, wingList: L3 }, 30, 40, 9);
  assertEquals(full.wings.map((g: Any) => [g.i, g.tier]), [[0, 1], [1, 2], [2, 3]]);
  const removed = F.d3Massing({ ...G, wingList: L3.slice(1) }, 30, 40, 9);
  const t1 = tier(removed, -1, 1);
  assertEquals([t1.i, t1.w, t1.pitch, t1.top], [0, 4, 0.4, removed.Hc]);
  assertEquals(removed.wings.map((g: Any) => g.tier), [1, 2]);
  const swapped = F.d3Massing({ ...G, wingList: [L3[1], L3[0], L3[2]] }, 30, 40, 9);
  assertEquals(swapped.wings.map((g: Any) => [g.tier, g.w]), [[1, 4], [2, 5], [3, 3]]);
  // Different walls never chain: a right wing between two left ones leaves them tiers 1 and 2.
  const mixed = F.d3Massing({ ...G, wingList: [L3[0], { wall: "right", widthFt: 6 }, L3[1]] }, 30, 40, 9);
  assertEquals(mixed.wings.map((g: Any) => [g.i, g.side, g.tier]), [[0, -1, 1], [1, 1, 1], [2, -1, 2]]);
});

// ── SEVEN / EIGHT: the end gate and the old frame's turn ─────────────────────────────────────

Deno.test("the end gate: with the flag off an end wing is stored, not drawn; with it on it is Case E", () => {
  const roof = { ...G, wingList: [{ wall: "front", widthFt: 8 }] };
  const m = F.d3Massing(roof, 24, 32, 9);
  if (F.D3_WINGLIST_ENDS) {
    assertEquals(m.ends.length, 1);
  } else {
    assertEquals([m.ends, m.listDropped, m.wings], [[], [{ i: 0, why: "end" }], []]);
    assertEquals([m.Hc, m.Sc, m.uc, m.zA, m.zB], [9, 24, 0, 0, 32]);
    assertEquals(F.d3WingListDeep(m), false);
    for (const w of WALLS) assertEquals(F.d3WallTops(roof, 24, 32, 9, w), null, w);
    assertEquals(F.d3ModelTopFt({ roof, wallHeightFt: 9 }, 24, 32), F.d3ModelTopFt({ roof: G, wallHeightFt: 9 }, 24, 32));
    // Still a list: the roof step is refused beside it.
    assertEquals(F.d3WingListOn(roof), true);
  }
  const me = FE.d3Massing(roof, 24, 32, 9);
  assertEquals([me.ends.length, me.listDropped.length], [1, 0]);
  near(me.zB, 24, "Case E");
});

Deno.test("an older style with no front turns: a left wing is a side wing at 24x28 and an end wing at 28x20", () => {
  const roof = { ...G, wingList: [{ wall: "left", widthFt: 8 }] };
  const side = FE.d3Massing(roof, 24, 28, 9);
  assertEquals([side.wings.length, side.ends.length, side.wings[0].wall], [1, 0, "west"]);
  const end = FE.d3Massing(roof, 28, 20, 9);
  assertEquals([end.wings.length, end.ends.length], [0, 1]);
  assertEquals([end.ends[0].wall, end.ends[0].bwall], ["west", "left"]);
  // With the flag off the turned wing is kept and listed as an end wing.
  if (!F.D3_WINGLIST_ENDS) assertEquals(F.d3Massing(roof, 28, 20, 9).listDropped, [{ i: 0, why: "end" }]);
});

// ── NINE: invariants at every size ───────────────────────────────────────────────────────────

const LISTS: Array<[string, Any]> = [
  ["S", { ...G, wingList: [{ wall: "left", widthFt: 8 }, { wall: "left", widthFt: 6 }, { wall: "right", widthFt: 8 }] }],
  ["E", { ...G, wingList: [{ wall: "front", widthFt: 8 }] }],
  ["T", { ...G, centerEaveFt: 17, wingList: [{ wall: "left", widthFt: 8 }, { wall: "right", widthFt: 8 }, { wall: "front", widthFt: 8 }] }],
  ["deep", { ...G, wingList: ["left", "right", "front", "back"].flatMap((w) => [{ wall: w, widthFt: 4 }, { wall: w, widthFt: 3, pitch: 0.5 }, { wall: w, widthFt: 3, attach: "wall", attachFt: 1 }]) }],
  ["C", { ...G, wingList: [{ wall: "left", widthFt: 8 }, { wall: "left", widthFt: 6 }, { wall: "right", widthFt: 8 }, { wall: "front", widthFt: 6 }, { wall: "back", widthFt: 5 }, { wall: "back", widthFt: 4 }] }],
  ["mix16", {
    ...G,
    wingList: Array.from({ length: 16 }, (_, k) => ({
      wall: ["left", "right", "front", "back"][k % 4], widthFt: 2 + (k % 5), pitch: 0.1 * (k % 7),
      ...(k % 3 === 0 ? { attach: "wall", attachFt: k % 4 } : {}), ...(k % 5 === 0 ? { eaveFt: 10 + k } : {}),
    })),
  }],
];
const INV_SIZES = [[8, 10], [10, 12], [12, 16], [16, 24], [24, 28], [37, 22], [28, 20], [60, 40], [16, 12]];

Deno.test("⚠️ invariants at every size, both frames, flag off and on: finite, room kept, clearances met, wall tops whole", () => {
  const a = D3A(), ov = 1;
  let n = 0, tight = 0;
  for (const [Lname, L] of [["F", F], ["FE", FE]] as const) {
    for (const [name, base] of LISTS) {
      for (const [W, D] of INV_SIZES) {
        for (const front of [undefined, "gable", "eave"]) {
          const roof = { ...base, ...(front ? { front } : {}) };
          const tag = `${Lname} ${name} ${W}x${D} front ${front}`;
          const m = L.d3Massing(roof, W, D, 9);
          const bad = JSON.stringify(m, (_k, v) => (typeof v === "number" && !isFinite(v) ? "NONFINITE" : v));
          assert(!bad.includes("NONFINITE"), `${tag}: a number that is not finite`);
          // Every structural entry is drawn exactly once or listed as not drawn, with why.
          const ids = [...m.wings, ...m.ends, ...m.listDropped].map((r: Any) => r.i).sort((p: number, q: number) => p - q);
          assertEquals(ids, L.d3WingListEntries(roof).map((x: Any) => x.i), `${tag}: every entry drawn or listed once`);
          assert(m.listDropped.every((d: Any) => d.why === "room" || (d.why === "end" && !L.D3_WINGLIST_ENDS)), `${tag}: ${JSON.stringify(m.listDropped)}`);
          // The middle keeps 4 ft each way.
          if (m.wings.length) assert(m.Sc >= 4 - 1e-9, `${tag}: Sc ${m.Sc}`);
          assert(m.zA <= m.zB && m.zB - m.zA >= 4 - 1e-9, `${tag}: z run ${m.zA}..${m.zB}`);
          // Every child roof at least the margin below the face it stands under (or met on the wall where it says).
          const bySide = (s: number) => m.wings.filter((g: Any) => g.side === s).sort((p: Any, q: Any) => p.tier - q.tier);
          const byEnd = (at: number) => m.ends.filter((t: Any) => t.at === at).sort((p: Any, q: Any) => p.tier - q.tier);
          const floorOf = L.d3WingHcFloor(roof, m.Sc, m.tallNeg);
          for (const ch of [bySide(-1), bySide(1), byEnd(0), byEnd(1)]) {
            ch.forEach((g: Any, k: number) => {
              assertEquals(g.tier, k + 1, tag); assertEquals(g.outer, k === ch.length - 1, tag);
              if (g.tight) { tight++; return; }
              const face = k ? ch[k - 1].ye : g.top;
              if (k) near(g.top, face, `${tag} i${g.i}: top is the next wing in's wall`);
              if (g.meets === "wall") { near(g.ya, g.top - g.meetFt, `${tag} i${g.i}: met on the wall`); assert(g.ya <= g.top + 1e-9, tag); }
              else if (g.meets === "roof") { /* up the middle's roof: wingsMassing_test pins it */ }
              else if (k) assert(face >= g.ya + Math.max(1, a + Math.max(0, ch[k - 1].pitch - g.pitch) * ov) - 1e-9, `${tag} i${g.i}: ya ${g.ya} under ${face}`);
              else if ("side" in g) assert(m.Hc >= floorOf(g) - 1e-9, `${tag} i${g.i}: Hc ${m.Hc} under the wing's floor ${floorOf(g)}`);
              else assert(g.ya < g.top - 0.99, `${tag} end i${g.i}: ya ${g.ya} top ${g.top}`);
            });
          }
          // Beside end wings every face on an end wing's inner line clears the Automatic end roofs.
          if (m.ends.length) {
            const c = L.d3RoofProfile(roof, m.Sc, 0, m.tallNeg).dedup;
            const slope = (p: number[], q: number[]) => (Math.abs(q[0] - p[0]) > 1e-9 ? Math.abs((q[1] - p[1]) / (q[0] - p[0])) : 0);
            const kc = c.length > 1 ? Math.max(slope(c[0], c[1]), slope(c[c.length - 2], c[c.length - 1])) : 0;
            const T1e = m.ends.filter((t: Any) => t.tier === 1 && !t.attach);
            const floorEnd = (k: number) => T1e.reduce((y: number, t: Any) => Math.max(y, t.ya + Math.max(1, a + k * ov)), -Infinity);
            assert(m.Hc >= floorEnd(kc) - 1e-9, `${tag}: Hc ${m.Hc} under the end roofs ${floorEnd(kc)}`);
            for (const g of m.wings) if (!g.tight) assert(g.ye >= floorEnd(g.pitch) - 1e-9, `${tag} i${g.i}: ye ${g.ye} under the end roofs ${floorEnd(g.pitch)}`);
          }
          // Each wall's tops cover the wall from end to end with no gap or overlap.
          for (const wall of WALLS) {
            const tops = L.d3WallTops(roof, W, D, 9, wall);
            if (!tops) continue;
            const len = wall === "north" || wall === "south" ? W : D;
            assert(tops.flat().every((v: number) => isFinite(v)), `${tag} ${wall}: ${JSON.stringify(tops)}`);
            assert(Math.abs(tops[0][0]) < 1e-9 && Math.abs(tops[tops.length - 1][1] - len) < 1e-9, `${tag} ${wall} ends: ${JSON.stringify(tops)}`);
            for (let k = 1; k < tops.length; k++) assert(Math.abs(tops[k][0] - tops[k - 1][1]) < 1e-9, `${tag} ${wall} gap: ${JSON.stringify(tops)}`);
            tops.forEach((p: number[]) => assert(p[1] > p[0] - 1e-9 && p[2] >= 9 - 1e-9, `${tag} ${wall} piece: ${JSON.stringify(tops)}`));
          }
          n++;
        }
      }
    }
  }
  assertEquals(n, 2 * LISTS.length * INV_SIZES.length * 3);
  // A wing left tight is drawn and flagged (design §3.6 step 9); the next test keeps the everyday lists free of it.
  console.log(`invariants: ${n} massings, ${tight} tight wings (all in the 16-entry mix)`);
});

Deno.test("the everyday lists never leave a wing tight at any size", () => {
  for (const [name, roof] of LISTS.filter(([n]) => n !== "mix16")) {
    for (const [W, D] of INV_SIZES) {
      for (const L of [F, FE]) {
        const m = L.d3Massing(roof, W, D, 9);
        assert([...m.wings, ...m.ends].every((g: Any) => !g.tight), `${name} ${W}x${D}: ${JSON.stringify([...m.wings, ...m.ends].filter((g: Any) => g.tight))}`);
      }
    }
  }
});

// ── TEN: refusals ─────────────────────────────────────────────────────────────────────────────

Deno.test("refusals: no roof step beside any structural list; no porch where an end wing rules it out; no dormer over an end wing", () => {
  const CAB = { ...CABIN, ...STEP };
  assert(F.d3RoofStep(CAB, 14, 40, 8) != null, "the cabin draws its step");
  for (const wingList of [[{ wall: "left", widthFt: 6 }], [{ wall: "front", widthFt: 6 }], [{ wall: "back", widthFt: 1 }], [null, { wall: "right", widthFt: "4" }]]) {
    for (const L of [F, FE]) assertEquals(L.d3RoofStep({ ...CAB, wingList }, 14, 40, 8), null, JSON.stringify(wingList));
  }
  for (const junk of JUNK) assertEquals(JSON.stringify(stepOf(F, { ...CAB, wingList: junk }, 14, 40, 8)), JSON.stringify(F.d3RoofStep(CAB, 14, 40, 8)));
  // Porch (flag on): the front is Case T's end wing; the back is free; an eave wall beside an end wing is not.
  const T = LISTS[2][1];
  assertEquals(FE.d3ProjectingPorch({ ...T, porchOutFt: 6 }, 24, 28), null);
  assertEquals(FE.d3ProjectingPorch({ ...T, porchOutFt: 6, porchEnd: "back" }, 24, 28), { D: 6, wall: "north" });
  const eaveFront = { ...G, front: "eave", wingList: [{ wall: "left", widthFt: 6 }], porchOutFt: 6 };
  assertEquals(FE.d3Massing(eaveFront, 24, 28, 9).ends.length, 1);
  assertEquals(FE.d3ProjectingPorch(eaveFront, 24, 28), null, "an eave wall while an end wing exists");
  assertEquals(FE.d3WingListBlocksPorch(eaveFront, 24, 28, "south"), true);
  // Side wings alone never block a porch, and neither does an end wing the flag keeps off.
  assertEquals(FE.d3ProjectingPorch({ ...LISTS[0][1], porchOutFt: 6 }, 30, 32), { D: 6, wall: "south" });
  if (!F.D3_WINGLIST_ENDS) assertEquals(F.d3ProjectingPorch({ ...T, porchOutFt: 6 }, 24, 28), { D: 6, wall: "south" });
  // Dormer: it must stay half a foot inside the middle stretch (Case T: z 0..20 of 28, the dormer centred at 14).
  assertEquals(FE.d3DormerBlocked({ ...T, dormerWidthFt: 14 }, 24, 28, 9), "end");
  assertEquals(FE.d3DormerBlocked({ ...T, dormerWidthFt: 12 }, 24, 28, 9), "end", "14 + 6 = 20 reaches past 20 - 0.5");
  assertEquals(FE.d3DormerBlocked({ ...T, dormerWidthFt: 11 }, 24, 28, 9), null, "14 + 5.5 = 19.5 stays inside");
  assertEquals(FE.d3DormerBlocked({ ...LISTS[0][1], dormerWidthFt: 30 }, 30, 32, 9), null, "side wings never block a dormer here");
});

// ── ELEVEN: lean-tos ──────────────────────────────────────────────────────────────────────────

Deno.test("lean-tos: one off a stack hangs from the outermost wing; an attached one across an end wing's stretch hangs at H", () => {
  const roof = { ...G, wingList: [{ wall: "left", widthFt: 8 }, { wall: "left", widthFt: 6 }], leanTos: [{ wall: "left", widthFt: 5, attach: "wall", attachFt: 1 }] };
  const m = F.d3Massing(roof, 30, 32, 9);
  const out = tier(m, -1, 2);
  const q = F.d3LeanTosGeom(roof, 30, 32, 9)[0];
  near(q.u0, -15, "on the building's wall line, -S/2"); near(q.E, out.ye, "under the outermost wing's eave"); near(q.k, out.pitch, "that wing's slope");
  assert(!("endCross" in q));
  const r2 = { ...G, wingList: [{ wall: "front", widthFt: 8 }], leanTos: [{ wall: "left", widthFt: 5, attach: "wall", attachFt: 1 }] };
  const q2 = FE.d3LeanTosGeom(r2, 24, 32, 9)[0];
  assertEquals([q2.endCross, q2.mode], [true, null]);
  near(q2.ya, 9, "hung at the wall height");
  // With the flag off the end wing is not drawn, so nothing crosses.
  if (!F.D3_WINGLIST_ENDS) assert(!("endCross" in F.d3LeanTosGeom(r2, 24, 32, 9)[0]));
});

// ── TWELVE / THIRTEEN: the sanitiser and the renderer agree ─────────────────────────────────────

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

Deno.test("⚠️ fuzz: sanitizeWingList keeps exactly the entries the renderer draws from, in order", () => {
  const rnd = rng(0x5eed2026);
  const one = (a: Any[]) => a[Math.floor(rnd() * a.length)];
  const WALLW = ["left", "right", "front", "back", "top", "Left", "", " left", undefined, 3, ["left"], { wall: "left" }];
  const WIDTH = [8, 16, 20, 0.5, 0.51, 0.49, 0.5000001, "8", "0.6", "", " ", "x", "1e1", -3, 0, null, undefined, NaN, Infinity, -Infinity, true, [8], {}];
  const OPT = [0.3, "", " ", "0.5", 2, -1, "x", null, NaN, 99];
  let kept = 0, n = 0;
  for (; n < 500; n++) {
    const len = Math.floor(rnd() * 25);
    const raw = Array.from({ length: len }, () => {
      const r = rnd();
      if (r < 0.1) return one([null, 3, "left", [], [{ wall: "left", widthFt: 8 }], true, undefined]);
      if (r < 0.55) return { wall: one(["left", "right", "front", "back"]), widthFt: one([4, 6, 8, 12, "7", 15.5]) };
      const e: Any = { wall: one(WALLW), widthFt: one(WIDTH) };
      if (rnd() < 0.5) e.pitch = one(OPT);
      if (rnd() < 0.4) e.attach = one(["roof", "wall", "up", "auto", ["roof"], ""]);
      if (rnd() < 0.4) e.attachFt = one(OPT);
      if (rnd() < 0.4) e.eaveFt = one([...OPT, 3, 40]);
      if (rnd() < 0.2) e.color = "red";
      return e;
    });
    const san = sanitizeWingList(raw);
    const ent = F.d3WingListEntries({ wingList: raw });
    const tag = JSON.stringify(raw);
    assertEquals(ent ? ent.length : 0, san ? san.length : 0, tag);
    assertEquals(ent === null, san === null, tag);
    (ent || []).forEach((x: Any, k: number) => {
      assertEquals(x.e.wall, san![k].wall, tag);
      assertEquals(Math.min(16, F.d3WlNum(x.e.widthFt)), san![k].widthFt, tag);
      assertEquals(x.e, raw[x.i], "the renderer reads the raw entry by its raw index");
    });
    assertEquals(F.d3WingListOn({ type: "gable", wingList: raw }), san !== null, tag);
    assertEquals(F.d3WingListOn({ type: "gambrel", wingList: raw }), san !== null, tag);
    assertEquals(F.d3WingListOn({ type: "shed", wingList: raw }), false, tag);
    // A sanitised list is its own fixed point, and the renderer reads it the same way.
    if (san) {
      assertEquals(sanitizeWingList(san), san, tag);
      assertEquals(F.d3WingListEntries({ wingList: san }).map((x: Any) => x.i), san.map((_e, i) => i), tag);
    }
    kept += san ? san.length : 0;
  }
  assert(kept > 1000, `the fuzz kept only ${kept} entries: it is not exercising the cap`);
  // Over the cap: the first 16 structural, in order, junk skipped.
  const over = Array.from({ length: 24 }, (_, k) => (k % 3 === 1 ? { wall: "top", widthFt: 8 } : { wall: "left", widthFt: 1 + k }));
  const s = sanitizeWingList(over)!, e = F.d3WingListEntries({ wingList: over });
  assertEquals(s.length, 16); assertEquals(e.length, 16);
  assertEquals(e.map((x: Any) => x.i), over.map((x, i) => (x.wall === "left" ? i : -1)).filter((i) => i >= 0).slice(0, 16));
});

Deno.test("the constants agree with the sanitiser's", () => {
  assertEquals(F.D3_WINGLIST_MAX, D3_WINGLIST_MAX);
  assertEquals([...F.D3_WINGLIST_WALLS], [...D3_WINGLIST_WALLS]);
  assertEquals(FE.D3_WINGLIST_MAX, D3_WINGLIST_MAX);
  // The number rule: blanks are not 0, numeric strings are numbers.
  assertEquals(["", " ", "8", "x", 8, NaN, Infinity, null, undefined, true].map((v) => F.d3WlNum(v)), [null, null, 8, null, 8, null, null, null, null, null]);
  // "Wings exist": side wings, or end wings drawn; the legacy record has no ends key.
  assertEquals(F.d3WingsOn(F.d3Massing(TRI, 24, 28, 9)), true);
  assertEquals(F.d3WingsOn(F.d3Massing(G, 24, 28, 9)), false);
  assertEquals(FE.d3WingsOn(FE.d3Massing(LISTS[1][1], 24, 32, 9)), true);
  assertEquals(F.d3WingsOn(F.d3Massing(LISTS[1][1], 24, 32, 9)), F.D3_WINGLIST_ENDS);
});
