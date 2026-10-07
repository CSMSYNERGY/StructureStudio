// A RECESSED PORCH'S DEPTH FROM POINTS (2026-10-07): measure.porch, porchDepthFromMeasure, how a read
// takes it (applyMeasuredPitches, readDraftReply, draftReadSample), the five-read consensus over it,
// and the self-check's lock on a depth the reads measured (measuredPorchLock, selfCheckPrompt,
// applySelfCheck). aiSelfCheckPorchLockWiring_test runs the lock through the shipped handler.
//
// Deliberately dependency-free (no jsr:/npm: imports), the rule the other _shared tests follow.
// deno test --allow-read supabase/functions/_shared/porchDepthPoints.test.ts

import {
  applyMeasuredPitches, applySelfCheck, consensusDrafts, draftReadSample, measuredPorchLock, parseMeasure, parseModelSpec,
  parseSelfCheck, porchDepthFromMeasure, porchDepthReading, porchPointsApply, readDraftReply, sanitizeD3Spec,
  selfCheckPrompt, selfCheckRequest, videoShapePrompt, combinedShapePrompt, SELF_CHECK_VIEWPOINTS,
  MEASURE_PORCH_MAX_LEAN, MEASURE_PORCH_MIN_DEPTH_FT, MEASURE_PORCH_MIN_SPAN, MEASURE_PORCH_ROOM_FT,
  MEASURED_PORCH_LOCK_MIN_READS, MEASURED_PORCH_LOCK_TOLERANCE,
} from "./styleD3.ts";
import type { D3Spec, KnownDims, PorchRefusal } from "./styleD3.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
const lf = (s: string) => s.replace(/\r\n/g, "\n");

// ─── The camera ───────────────────────────────────────────────────────────────────────────────
// A pinhole camera looking at one long side of an L ft deep building (x from the BACK corner, y up,
// the wall in the plane z = 0), turned `yawDeg` about the vertical, `distFt` out from the wall,
// `camXFt` along it and `camYFt` up. The porch takes the last D ft of the side; the fascia's bottom
// edge runs H ft up and `ovFt` out from the wall (the overhang, toward the camera). Returns the five
// measure.porch points, to the nearest pixel, in a 1600 by 900 frame centred on the side.
type PorchScene = { L: number; D: number; H: number; ovFt: number; yawDeg: number; distFt: number; camXFt: number; camYFt?: number; backOnRight?: boolean };
type Pt = [number, number];
type PorchBlock = { size: Pt; backBase: Pt; porchBase: Pt; frontBase: Pt; porchFascia: Pt; frontFascia: Pt };
const W = 1600, HPX = 900;
const porchShot = (sc: PorchScene): PorchBlock => {
  const f = 900, cy = sc.camYFt ?? 5;
  const yaw = sc.yawDeg * Math.PI / 180;
  // The back corner on the right of the frame: the camera sees x running right to left.
  const sx = sc.backOnRight ? -1 : 1;
  const proj = (x: number, y: number, z: number): Pt => {
    const X = sx * (x - sc.camXFt), Y = y - cy, Z = sc.distFt + z;
    const xc = X * Math.cos(yaw) + Z * Math.sin(yaw), zc = Z * Math.cos(yaw) - X * Math.sin(yaw);
    return [W / 2 + f * xc / zc, HPX / 2 - f * Y / zc];
  };
  // Centred on the side: a shifted principal point is a crop of a wider frame, which moves every
  // point alike and changes no ratio.
  const dx = W / 2 - (proj(0, 0, 0)[0] + proj(sc.L, 0, 0)[0]) / 2;
  const at = (x: number, y: number, z = 0): Pt => {
    const [u, v] = proj(x, y, z);
    return [Math.round(u + dx), Math.round(v)];
  };
  const S = sc.L - sc.D;
  return {
    size: [W, HPX],
    backBase: at(0, 0), porchBase: at(S, 0), frontBase: at(sc.L, 0),
    porchFascia: at(S, sc.H, -sc.ovFt), frontFascia: at(sc.L, sc.H, -sc.ovFt),
  };
};
const inFrame = (b: PorchBlock) => [b.backBase, b.porchBase, b.frontBase, b.porchFascia, b.frontFascia]
  .every(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= HPX);
// The 14x40 building: a 6 ft porch, a 7.75 ft wall, a 1 ft overhang.
const CABIN: PorchScene = { L: 40, D: 6, H: 7.75, ovFt: 1, yawDeg: 0, distFt: 45, camXFt: 20 };
// What reading the side as a plain share of the base line says: the live error.
const plainShare = (b: PorchBlock, L: number) => {
  const len = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  return L * (1 - len(b.backBase, b.porchBase) / len(b.backBase, b.frontBase));
};

Deno.test("porchDepthFromMeasure: a 6 ft porch on a 14x40 reads 6 (+/- 0.5) from every camera, where a plain share is feet out", () => {
  let tried = 0, worstPlain = 0;
  for (const yawDeg of [-35, -25, -15, -5, 5, 15, 25, 35]) {
    for (const camXFt of [5, 20, 35]) {
      for (const camYFt of [4, 6]) {
        for (const backOnRight of [false, true]) {
          const m = porchShot({ ...CABIN, yawDeg, camXFt, camYFt, backOnRight });
          // A camera whose frame cuts a corner off is not a frame the paragraph asks for.
          if (!inFrame(m)) continue;
          tried++;
          const what = `yaw ${yawDeg}, ${camXFt} ft along, ${camYFt} ft up${backOnRight ? ", mirrored" : ""}`;
          const r = porchDepthReading(m, 40);
          assert(r.depthFt !== null, `${what}: refused (${r.refused})`);
          assert(Math.abs(r.depthFt! - 6) <= 0.5, `${what}: ${r.depthFt}`);
          assertEquals(porchDepthFromMeasure(m, 40), r.depthFt, `${what}: the two agree`);
          worstPlain = Math.max(worstPlain, Math.abs(plainShare(m, 40) - 6));
        }
      }
    }
  }
  assert(tried >= 80, `the simulation covers enough cameras (${tried})`);
  // The perspective the cross-ratio undoes: a plain share of the same frames is up to feet out.
  assert(worstPlain > 2, `a plain share is ${worstPlain.toFixed(1)} ft out at worst`);
  // Deep when the FRONT end stands nearer the camera: 8 for a 6, the live misread, at 25 degrees.
  const near = porchShot({ ...CABIN, yawDeg: 25, camXFt: 20 });
  assert(plainShare(near, 40) > 8, `front nearer: a plain share reads ${plainShare(near, 40).toFixed(2)}`);
  assertEquals(porchDepthFromMeasure(near, 40), 6, "and the points read 6");
});

Deno.test("porchDepthFromMeasure: other buildings and porches, and the camera's height, read true too", () => {
  for (const [L, D] of [[24, 4], [28, 5], [32, 8], [20, 6], [60, 12]]) {
    for (const yawDeg of [-20, 0, 20]) {
      for (const backOnRight of [false, true]) {
        const m = porchShot({ ...CABIN, L, D, yawDeg, distFt: L * 1.15, camXFt: L / 2, backOnRight });
        const r = porchDepthReading(m, L);
        assert(r.depthFt !== null && Math.abs(r.depthFt - D) <= 0.5, `${D} ft on ${L}, yaw ${yawDeg}: ${r.depthFt} (${r.refused})`);
      }
    }
  }
});

Deno.test("porchDepthFromMeasure: a square-on frame, whose two lines never meet, is a plain share of the base line", () => {
  // Hand-made, both lines exactly level: 960 px of 1200 from the back corner is 0.8 of a 40 ft side,
  // so the porch is the last 8 ft. The back corner on either side of the frame reads the same.
  const flat = { size: [1600, 900], backBase: [1400, 600], porchBase: [440, 600], frontBase: [200, 600], porchFascia: [440, 300], frontFascia: [200, 300] };
  const r = porchDepthReading(flat, 40);
  assertEquals([r.depthFt, r.refused, Math.round(r.share! * 1e9) / 1e9, Math.round(r.rawDepthFt! * 1e9) / 1e9], [8, null, 0.8, 8]);
  const mirrored = { ...flat, backBase: [200, 600], porchBase: [1160, 600], frontBase: [1400, 600], porchFascia: [1160, 300], frontFascia: [1400, 300] };
  assertEquals(porchDepthFromMeasure(mirrored, 40), 8);
  // Rounded to half a foot: 0.85 of 40 is 6, and 0.86 (5.6 ft) is 5.5.
  assertEquals(porchDepthFromMeasure({ ...flat, porchBase: [380, 600], porchFascia: [380, 300] }, 40), 6);
  assertEquals(porchDepthFromMeasure({ ...flat, porchBase: [368, 600], porchFascia: [368, 300] }, 40), 5.5);
  // A camera square to the side gives the same answer as the arithmetic.
  for (const camXFt of [5, 20, 35]) assertEquals(porchDepthFromMeasure(porchShot({ ...CABIN, camXFt }), 40), 6, `${camXFt} ft along`);
  // A size is not required (the base line's span is then not held to the image's width).
  const { size: _size, ...noSize } = flat;
  assertEquals(porchDepthFromMeasure(noSize, 40), 8);
});

// Each check, refused for its own reason, from a frame that otherwise reads 6.
Deno.test("porchDepthFromMeasure: every check refuses on its own, and names itself", () => {
  const m = porchShot({ ...CABIN, yawDeg: 20, camXFt: 26 });
  assertEquals(porchDepthFromMeasure(m, 40), 6, "the frame the refusals start from reads 6");
  const why = (block: unknown, L: unknown = 40): PorchRefusal | null => {
    const r = porchDepthReading(block, L);
    assertEquals(r.depthFt === null, r.refused !== null, "a depth or a refusal, never both");
    return r.refused;
  };
  const wall = m.porchBase[1] - m.porchFascia[1];
  // points: a point missing, not a number, not finite, outside the size, or a size that is no size.
  const { porchFascia: _gone, ...four } = m;
  assertEquals(why(four), "points");
  assertEquals(why({ ...m, porchBase: ["530", 578] }), "points");
  assertEquals(why({ ...m, porchBase: [Number.NaN, 578] }), "points");
  assertEquals(why({ ...m, frontBase: [m.frontBase[0], 901] }), "points");
  assertEquals(why({ ...m, size: [0, 900] }), "points");
  assertEquals(why(null), "points");
  assertEquals(why([m]), "points");
  // length: the building's depth is not known.
  for (const L of [null, 0, -40, "forty", Number.POSITIVE_INFINITY]) assertEquals(why(m, L), "length", `length ${String(L)}`);
  // span: a base line under a quarter of the frame's width.
  const shrink = (k: number) => {
    const c = (p: Pt): Pt => [Math.round(800 + (p[0] - 800) * k), Math.round(450 + (p[1] - 450) * k)];
    return { size: m.size, backBase: c(m.backBase), porchBase: c(m.porchBase), frontBase: c(m.frontBase), porchFascia: c(m.porchFascia), frontFascia: c(m.frontFascia) };
  };
  const spanOf = (b: PorchBlock) => Math.hypot(b.frontBase[0] - b.backBase[0], b.frontBase[1] - b.backBase[1]);
  const k = (MEASURE_PORCH_MIN_SPAN * W * 0.95) / spanOf(m);
  assertEquals(why(shrink(k)), "span");
  // across: a base line steeper than 45 degrees.
  assertEquals(why({ size: [1600, 900], backBase: [800, 100], porchBase: [705, 760], frontBase: [700, 800], porchFascia: [600, 760], frontFascia: [590, 800] }), "across");
  // between: porchBase past the front corner, or behind the back one.
  const alongBase = (t: number): Pt => [
    Math.round(m.backBase[0] + t * (m.frontBase[0] - m.backBase[0])), Math.round(m.backBase[1] + t * (m.frontBase[1] - m.backBase[1])),
  ];
  assertEquals(why({ ...m, porchBase: alongBase(1.02) }), "between");
  assertEquals(why({ ...m, porchBase: alongBase(-0.02) }), "between");
  // fascia: either fascia point below the base line, or the two on one pixel.
  assertEquals(why({ ...m, porchFascia: [m.porchFascia[0], m.porchBase[1] + 20] }), "fascia");
  assertEquals(why({ ...m, frontFascia: [m.frontFascia[0], m.frontBase[1] + 20] }), "fascia");
  assertEquals(why({ ...m, frontFascia: m.porchFascia }), "fascia");
  // lean: porchBase off the base line by more than a quarter of the wall's height in the frame.
  assertEquals(why({ ...m, porchBase: [m.porchBase[0], Math.round(m.porchBase[1] - (MEASURE_PORCH_MAX_LEAN + 0.05) * wall)] }), "lean");
  assert(why({ ...m, porchBase: [m.porchBase[0], Math.round(m.porchBase[1] - (MEASURE_PORCH_MAX_LEAN - 0.1) * wall)] }) !== "lean", "inside the lean is not refused for it");
  // vanishing: a fascia line that meets the base line between the corners is no camera's.
  assertEquals(why({ ...m, porchFascia: [m.porchFascia[0], m.porchBase[1] - 40] }), "vanishing");
  // front: the corners read the wrong way round put the porch corner nearer the back.
  assertEquals(why({ ...m, backBase: m.frontBase, frontBase: m.backBase }), "front");
  // shallow: a porch corner a few inches from the post.
  const flat = { size: [1600, 900], backBase: [1400, 600], porchBase: [440, 600], frontBase: [200, 600], porchFascia: [440, 300], frontFascia: [200, 300] };
  const at = (share: number) => {
    const x = Math.round(1400 - 1200 * share);
    return { ...flat, porchBase: [x, 600], porchFascia: [x, 300] };
  };
  assertEquals(why(at(0.985)), "shallow");
  assertEquals(porchDepthFromMeasure(at(1 - MEASURE_PORCH_MIN_DEPTH_FT / 40), 40), 1, "a foot is the shallowest");
  // deep: past CLAMPS.porchDepthFt's 12, which is never clamped down to it.
  assertEquals(why(at(0.8), 80), "deep");
  assertEquals(porchDepthFromMeasure(at(0.8), 60), 12, "12 is the deepest");
  // room: on a 7 ft building a 3.5 ft porch leaves less than the renderer's 4 ft behind it.
  assertEquals(why(at(0.53), 7), "room");
  assertEquals(porchDepthFromMeasure(at(0.53), 7 + 0.5), 3.5, `${MEASURE_PORCH_ROOM_FT} ft behind it is enough`);
});

// ─── A read takes it ──────────────────────────────────────────────────────────────────────────
const DIMS: KnownDims = { widthFt: 14, lengthFt: 40, wallHeightFt: 7.75 };
const POINTS = porchShot({ ...CABIN, yawDeg: 25, camXFt: 18 });
const REPLY = (roof: Record<string, unknown>, porch?: unknown, more: Record<string, unknown> = {}) => JSON.stringify({
  ...(porch ? { measure: { porch, ...more } } : more && Object.keys(more).length ? { measure: more } : {}),
  roof: { type: "gable", front: "gable", pitch: 0.4, overhangIn: 12, eave: "fascia", porchEnd: "front", porchTruss: true, ...roof },
  siding: "batten", colors: { body: "#555555" },
});
const specOf = (text: string): D3Spec => {
  const r = parseModelSpec(text, DIMS);
  if (!r.ok) throw new Error(r.error);
  return r.d3;
};
const bodyOf = (text: string) => JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn" });

Deno.test("parseMeasure: the porch block is read beside the others, and alone", () => {
  assertEquals(parseMeasure(REPLY({ porchDepthFt: 8 }, POINTS))?.porch, POINTS);
  assertEquals(Object.keys(parseMeasure(REPLY({ porchDepthFt: 8 }, POINTS, { pitch: { left: [1, 2] } })) ?? {}), ["pitch", "porch"]);
  assertEquals(parseMeasure(REPLY({ porchDepthFt: 8 }, null, { porch: [1, 2] })), null, "an array is no block");
});

Deno.test("applyMeasuredPitches: a recessed porch takes its points' depth and says so; readDraftReply and draft_tokens agree", () => {
  assertEquals(plainShare(POINTS, 40) > 7.5, true, "the frame is one a plain share reads deep");
  const text = REPLY({ porchDepthFt: 8 }, POINTS);
  const r = applyMeasuredPitches(specOf(text), text, 40);
  assertEquals(r.d3.roof.porchDepthFt, 6, "the live misread, set right by its points");
  assertEquals([r.sources.porchSource, r.sources.modelPorchDepth, "porchRejected" in r.sources], ["points", 8, false]);
  assertEquals(r.d3.roof.porchTruss, true, "the rest of the porch is the read's own");
  // The single call (parseModelSpec with measure on) and the consensus's reading both take it.
  const single = parseModelSpec(text, DIMS, true);
  assert(single.ok && single.d3.roof.porchDepthFt === 6, "parseModelSpec(measure)");
  const reading = readDraftReply(bodyOf(text), DIMS, true);
  assertEquals(reading.d3?.roof.porchDepthFt, 6);
  const sample = draftReadSample(reading)!;
  assertEquals([sample.porchDepthFt, sample.porchSource, sample.modelPorchDepth], [6, "points", 8], "draft_tokens records where it came from");
  // Off (every legacy reader), the points are never looked at.
  assertEquals(readDraftReply(bodyOf(text), DIMS, false).d3?.roof.porchDepthFt, 8);
  // Beside the gable's own points, both land.
  const both = REPLY({ porchDepthFt: 8, pitch: 0.6 }, POINTS, { pitch: { size: [1600, 900], left: [400, 560], peak: [800, 400], right: [1200, 560] } });
  const b = applyMeasuredPitches(specOf(both), both, 40);
  assertEquals([b.d3.roof.pitch, b.d3.roof.porchDepthFt, b.sources.pitchSource, b.sources.porchSource], [0.4, 6, "points", "points"]);
});

Deno.test("applyMeasuredPitches: refused points keep the model's depth and say so; no points is plain 'model'; no porch records nothing", () => {
  const bad = REPLY({ porchDepthFt: 8 }, { ...POINTS, backBase: POINTS.frontBase, frontBase: POINTS.backBase });
  const b = applyMeasuredPitches(specOf(bad), bad, 40);
  assertEquals([b.d3.roof.porchDepthFt, b.sources.porchSource, b.sources.porchRejected, "modelPorchDepth" in b.sources], [8, "model", true, false]);
  const plain = REPLY({ porchDepthFt: 8 });
  const p = applyMeasuredPitches(specOf(plain), plain, 40);
  assertEquals([p.d3.roof.porchDepthFt, p.sources.porchSource, "porchRejected" in p.sources], [8, "model", false]);
  // Nothing replaced: the very object it went in as.
  const pd = specOf(plain);
  assert(applyMeasuredPitches(pd, plain, 40).d3 === pd, "the same object");
  // No known depth: no measure, and the points were still asked for, so they are refused.
  const noL = applyMeasuredPitches(specOf(REPLY({ porchDepthFt: 8 }, POINTS)), REPLY({ porchDepthFt: 8 }, POINTS), null);
  assertEquals([noL.d3.roof.porchDepthFt, noL.sources.porchRejected], [8, true]);
  // No porch, or a projecting one: the points never make or move one, and nothing is recorded.
  for (const roof of [{}, { porchOutFt: 6 }, { porchDepthFt: 0.5 }]) {
    const t = REPLY(roof, POINTS);
    const n = applyMeasuredPitches(specOf(t), t, 40);
    assertEquals(n.d3.roof.porchDepthFt, specOf(t).roof.porchDepthFt, JSON.stringify(roof));
    assert(!((n.d3.roof.porchDepthFt as number ?? 0) > 0.5), `${JSON.stringify(roof)}: no recessed porch`);
    assert(!("porchSource" in n.sources), `${JSON.stringify(roof)}: no porch source`);
  }
});

Deno.test("applyMeasuredPitches: points beside a porch they are not asked for are never used, and never rejected", () => {
  for (const [name, roof] of [
    ["an eave front", { front: "eave", porchDepthFt: 8 }],
    ["a back porch", { porchDepthFt: 8, porchEnd: "back" }],
    ["side wings", { porchDepthFt: 8, wingSide: "both", wingWidthFt: 4, wingPitch: 0.25, centerEaveFt: 12 }],
    ["a gambrel with no front", { type: "gambrel", front: undefined, kneeU: 0.75, kneeRise: 0.7, ridgeRise: 1, porchDepthFt: 8 }],
    ["a shed", { type: "shed", front: undefined, highSide: "left", porchDepthFt: 8 }],
  ] as const) {
    const t = REPLY(roof as Record<string, unknown>, POINTS);
    const spec = specOf(t);
    assert((spec.roof.porchDepthFt as number) === 8, `${name}: the fixture keeps its porch`);
    assert(!porchPointsApply(spec.roof), `${name}: not a porch the points are for`);
    const n = applyMeasuredPitches(spec, t, 40);
    assertEquals([n.d3.roof.porchDepthFt, n.sources.porchSource, "porchRejected" in n.sources], [8, "model", false], name);
  }
  // ...while a gambrel with a gable-end front is one.
  const g = REPLY({ type: "gambrel", kneeU: 0.75, kneeRise: 0.7, ridgeRise: 1, porchDepthFt: 8 }, POINTS);
  assertEquals(applyMeasuredPitches(specOf(g), g, 40).d3.roof.porchDepthFt, 6, "a gambrel with a gable-end front");
});

Deno.test("the five-read consensus takes the median of the measured depths, as it always took the reads'", () => {
  const read = (text: string) => ({ d3: readDraftReply(bodyOf(text), DIMS, true).d3!, observed: null, frameMap: null });
  const measured = REPLY({ porchDepthFt: 8 }, POINTS), judged = REPLY({ porchDepthFt: 8 }), seven = REPLY({ porchDepthFt: 7 });
  const other = REPLY({ porchDepthFt: 8 }, porchShot({ ...CABIN, yawDeg: -15, camXFt: 30, backOnRight: true }));
  assertEquals(read(other).d3.roof.porchDepthFt, 6, "a second frame measures 6 as well");
  // Three reads measured 6, two judged 8: the median is 6.
  const c = consensusDrafts([read(judged), read(measured), read(other), read(judged), read(measured)]);
  assertEquals(c.d3.roof.porchDepthFt, 6);
  assertEquals(c.report.spread.porchDepthFt, [6, 8]);
  // Two measured beside three judged: still the median of the five, which is then a judged number
  // (7 between a 6, 6, 7, 8, 8; 8 with three judged 8s), and so not a measured depth (the lock below).
  assertEquals(consensusDrafts([read(judged), read(measured), read(seven), read(judged), read(other)]).d3.roof.porchDepthFt, 7);
  assertEquals(consensusDrafts([read(judged), read(measured), read(judged), read(judged), read(other)]).d3.roof.porchDepthFt, 8);
});

// ─── The prompt asks for it ───────────────────────────────────────────────────────────────────
const PORCH_SCHEMA = '    "porch": { "frame": <1-based index of the image you marked the recessed porch in>, "size": [<that image\'s width in pixels>, <its height in pixels>], "backBase": [<x>, <y>], "porchBase": [<x>, <y>], "frontBase": [<x>, <y>], "porchFascia": [<x>, <y>], "frontFascia": [<x>, <y>] }\n  },';
Deno.test("v2 prompt: the recessed porch asks for measure.porch, beside a porchDepthFt on a gable-end front, and its example reads true", () => {
  for (const [name, p] of [
    ["video", videoShapePrompt(DIMS, true)],
    ["combined", combinedShapePrompt(12, 2, DIMS, true)],
  ] as const) {
    const text = lf(p);
    assert(text.includes(PORCH_SCHEMA), `${name}: the schema's measure block ends with the porch's`);
    assert(text.includes("Omit both keys if the building has no porch. PORCH POINTS, measure.porch, only when you give porchDepthFt on a building whose front is a gable end: we work the porch's depth out from these points, so mark them rather than judge it."), `${name}: asked for only with a recessed porch`);
    for (const k of ["backBase", "porchBase", "frontBase", "porchFascia", "frontFascia"]) assert(text.includes(`${k}, the`) || text.includes(`${k}, the foot`), `${name}: ${k} is described`);
    assert(text.includes("When the roof steps, put both fascia points on the FRONT section's fascia."), `${name}: the front section's fascia`);
  }
  // The example is a frame of a real camera: on a 28 ft deep building it reads 5.
  const ex = lf(videoShapePrompt(DIMS, true)).match(/For example, a side in a 1600 by 900 image might read backBase (\[[^\]]+\]), porchBase (\[[^\]]+\]), frontBase (\[[^\]]+\]), porchFascia (\[[^\]]+\]), frontFascia (\[[^\]]+\])\./);
  assert(ex, "the worked example is there");
  const [backBase, porchBase, frontBase, porchFascia, frontFascia] = ex!.slice(1).map((s) => JSON.parse(s));
  assertEquals(porchDepthFromMeasure({ size: [1600, 900], backBase, porchBase, frontBase, porchFascia, frontFascia }, 28), 5);
  // The legacy prompts are frozen (their SHA-256 is pinned in styleD3.test.ts) and never ask.
  for (const p of [videoShapePrompt(DIMS), videoShapePrompt(null), combinedShapePrompt(12, 2, DIMS)]) assert(!p.includes("measure.porch"), "legacy");
});

// ─── The self-check's lock ────────────────────────────────────────────────────────────────────
const cleanSpec = (raw: unknown): D3Spec => {
  const r = sanitizeD3Spec(raw);
  if (!r.ok) throw new Error(`the fixture is not a valid spec: ${r.error}`);
  return r.d3;
};
const ROOF = { type: "gable", front: "gable", pitch: 0.42, overhang: 1, eave: "fascia", porchDepthFt: 6, porchEnd: "front", porchTruss: true };
const DRAFTED = cleanSpec({ roof: ROOF, siding: "batten", colors: { body: "#7a1f1f", trim: "#f0f0f0", roof: "#2a2a2a" }, wallHeightFt: 7.75 });
const sampleOf = (depth: number, source: "points" | "model", extra: Record<string, unknown> = {}) =>
  ({ ...ROOF, porchDepthFt: depth, pitchSource: "model", porchSource: source, ...extra });
const tokensOf = (...samples: unknown[]) => ({ model: "claude-opus-5-5", input: 3, output: 3, effort: "high", streamed: true, samples });
const draftAt = (depth: number, roof: Record<string, unknown> = {}) => cleanSpec({ ...DRAFTED, roof: { ...DRAFTED.roof, porchDepthFt: depth, ...roof } });

Deno.test("measuredPorchLock: two reads that MEASURED a depth near the drafted one lock it, counted, not as a share", () => {
  assertEquals([MEASURED_PORCH_LOCK_MIN_READS, MEASURED_PORCH_LOCK_TOLERANCE], [2, 0.5]);
  assert(measuredPorchLock(tokensOf(sampleOf(6, "points"), sampleOf(6, "points"), sampleOf(8, "model")), DRAFTED), "two of three");
  assert(measuredPorchLock(tokensOf(sampleOf(6, "points"), sampleOf(6.5, "points"), sampleOf(8, "model"), sampleOf(8, "model"), sampleOf(8, "model")), draftAt(6.5)), "two of five");
  assert(measuredPorchLock(tokensOf(sampleOf(6, "points"), sampleOf(7, "points")), draftAt(6.5)), "a median between two measured reads");
  assert(measuredPorchLock(JSON.parse(JSON.stringify(tokensOf(sampleOf(6, "points"), sampleOf(6, "points")))), JSON.parse(JSON.stringify(DRAFTED))), "after JSON");
});

Deno.test("measuredPorchLock: one measured read, a judged consensus, or a porch the points are not for is not locked", () => {
  assert(!measuredPorchLock(tokensOf(sampleOf(6, "points"), sampleOf(8, "model"), sampleOf(8, "model")), DRAFTED), "one measured read");
  // Two measured 6s beside three judged 8s draft at 8: that is the judged number, not a measured one.
  assert(!measuredPorchLock(tokensOf(sampleOf(6, "points"), sampleOf(8, "model"), sampleOf(6, "points"), sampleOf(8, "model"), sampleOf(8, "model")), draftAt(8)), "the judged reads' 8");
  assert(!measuredPorchLock(tokensOf(sampleOf(6, "points"), sampleOf(6, "points")), draftAt(6.75)), "0.75 from the nearer");
  assert(!measuredPorchLock(tokensOf(sampleOf(6, "model", { porchRejected: true }), sampleOf(6, "points")), DRAFTED), "a refused read is not a measured one");
  // The drafted porch, or the measured reads', not one the points are for.
  for (const [name, roof] of [["projecting", { porchDepthFt: undefined, porchTruss: undefined, porchOutFt: 6 }], ["eave front", { front: "eave" }], ["back", { porchEnd: "back" }], ["no porch", { porchDepthFt: undefined }]] as const) {
    assert(!measuredPorchLock(tokensOf(sampleOf(6, "points"), sampleOf(6, "points")), draftAt(6, roof as Record<string, unknown>)), `a drafted ${name}`);
  }
  assert(!measuredPorchLock(tokensOf(sampleOf(6, "points", { front: "eave" }), sampleOf(6, "points")), DRAFTED), "a measured sample on an eave front does not count");
  // Anything malformed is false, and nothing throws.
  for (const tokens of [null, undefined, 1, "x", [], {}, { samples: null }, { samples: {} }, { samples: [null, 1, "x"] }]) {
    assert(!measuredPorchLock(tokens, DRAFTED), `tokens ${JSON.stringify(tokens)}`);
  }
  for (const drafted of [null, 1, "x", [], {}, { roof: null }, { roof: { ...ROOF, porchDepthFt: "6" } }]) {
    assert(!measuredPorchLock(tokensOf(sampleOf(6, "points"), sampleOf(6, "points")), drafted), `drafted ${JSON.stringify(drafted)}`);
  }
});

const CHECK_DIMS: KnownDims = { widthFt: 14, lengthFt: 40, wallHeightFt: 7.75 };
const LOCKED_WORDS = `If you change the kind, give the new key and leave
   the other one out entirely.
   THE PORCH'S DEPTH (roof.porchDepthFt, currently 6 ft) WAS MEASURED: it was worked
   out from points marked on the builder's own frames, not judged by eye. It is not yours to
   change: a correction to roof.porchDepthFt will be thrown away. Leave it alone even where the
   porch looks deeper or shallower in a frame than in the render - a side seen from an angle
   stretches the end nearer the camera and squeezes the far one. The KIND of porch is still
   yours to check, above.
   Then, where both show a porch,`;
Deno.test("⚠️ a porch-locked check prompt says the depth was MEASURED and lists it, and changes nothing else", () => {
  const unlocked = lf(selfCheckPrompt({ dims: CHECK_DIMS, draft: DRAFTED, viewpoints: SELF_CHECK_VIEWPOINTS }));
  const locked = lf(selfCheckPrompt({ dims: CHECK_DIMS, draft: DRAFTED, viewpoints: SELF_CHECK_VIEWPOINTS, porchLocked: true }));
  assert(locked.includes(LOCKED_WORDS), "step 3 says it was measured");
  assert(locked.includes("Never return wallHeightFt, sizeFt, colors or siding or roof.porchDepthFt. They are not yours"), "and the rules list it");
  // Exactly those two places: put them back and it is the unlocked prompt byte for byte.
  const back = locked.replace(LOCKED_WORDS, LOCKED_WORDS.replace(/\n   THE PORCH'S DEPTH[\s\S]*?yours to check, above\./, ""))
    .replace("siding or roof.porchDepthFt.", "siding.");
  assertEquals(back, unlocked, "nothing else moved");
  // Beside the other locks, in their order.
  const all = lf(selfCheckPrompt({ dims: CHECK_DIMS, draft: DRAFTED, viewpoints: SELF_CHECK_VIEWPOINTS, pitchLocked: true, overhangLocked: true, porchLocked: true }));
  assert(all.includes("Never return wallHeightFt, sizeFt, colors or siding or roof.overhang or roof.pitch or roof.porchDepthFt."), "all three listed");
  // Only `true` locks, and only beside a porch the points are for.
  for (const junk of [false, undefined, 1, "true", null]) {
    assertEquals(lf(selfCheckPrompt({ dims: CHECK_DIMS, draft: DRAFTED, viewpoints: SELF_CHECK_VIEWPOINTS, porchLocked: junk as unknown as boolean })), unlocked, `porchLocked ${JSON.stringify(junk)}`);
  }
  const eave = draftAt(6, { front: "eave" });
  assertEquals(lf(selfCheckPrompt({ dims: CHECK_DIMS, draft: eave, viewpoints: SELF_CHECK_VIEWPOINTS, porchLocked: true })),
    lf(selfCheckPrompt({ dims: CHECK_DIMS, draft: eave, viewpoints: SELF_CHECK_VIEWPOINTS })), "an eave front says nothing");
  // The request builder passes it to the v2 prompt and never to the frozen legacy one.
  const PAIRS = [{ viewpoint: "front" as const, frameUrl: "https://bucket.test/f1.jpg", base64: "AAAA" }];
  const textOf = (r: { body: Record<string, unknown> }) => lf(String(((r.body.messages as { content: { text: string }[] }[])[0].content[0]).text));
  assertEquals(textOf(selfCheckRequest({ mode: "v2", dims: CHECK_DIMS, draft: DRAFTED, pairs: PAIRS, round: 0, porchLocked: true })),
    lf(selfCheckPrompt({ dims: CHECK_DIMS, draft: DRAFTED, viewpoints: ["front"], round: 0, porchLocked: true })));
  assert(!textOf(selfCheckRequest({ mode: "legacy", dims: CHECK_DIMS, draft: DRAFTED, pairs: PAIRS, round: 0, porchLocked: true })).includes("WAS MEASURED"), "legacy");
});

const checkRead = (corrections: Record<string, unknown>, changed: { field: string }[]) => {
  const r = parseSelfCheck(JSON.stringify({
    verdict: "corrections", corrections, changed: changed.map((c) => ({ from: null, to: null, why: "by eye", ...c })),
    checked: { massing: "ok", overhang: "ok", porch: "changed", roofProfile: "ok", eave: "changed" }, note: "",
  }));
  if (!r) throw new Error("the fixture reply has to parse");
  return r;
};
Deno.test("⚠️ applySelfCheck: a locked depth's correction is dropped while the same answer's others land; unlocked it lands", () => {
  const read = checkRead({ roof: { porchDepthFt: 8, eave: "open" } }, [{ field: "roof.porchDepthFt" }, { field: "roof.eave" }]);
  const locked = applySelfCheck(DRAFTED, read, CHECK_DIMS, "v2", false, false, true);
  assert(locked.ok, "applied");
  if (!locked.ok) return;
  assertEquals([locked.d3.roof.porchDepthFt, locked.d3.roof.eave], [6, "open"], "the measured 6 stands, the eave opens");
  assertEquals(locked.changed.map((c) => c.field), ["roof.eave"]);
  assertEquals(locked.dropped, ["roof.porchDepthFt"]);
  const open = applySelfCheck(DRAFTED, read, CHECK_DIMS, "v2");
  assert(open.ok && open.d3.roof.porchDepthFt === 8 && open.dropped.length === 0, "without the lock the 8 lands, as it always did");
  // The other locks leave the porch alone, and this one leaves the pitch alone.
  const pitchOnly = applySelfCheck(DRAFTED, read, CHECK_DIMS, "v2", true, true, false);
  assert(pitchOnly.ok && pitchOnly.d3.roof.porchDepthFt === 8, "the pitch and overhang locks do not hold the porch");
  const p = applySelfCheck(DRAFTED, checkRead({ roof: { pitch: 0.6 } }, [{ field: "roof.pitch" }]), CHECK_DIMS, "v2", false, false, true);
  assert(p.ok && p.d3.roof.pitch === 0.6, "nor this one the pitch");
});

Deno.test("⚠️ applySelfCheck: the lock lets go when the answer leaves no porch the points measured", () => {
  // Projecting instead: the new key lands and the recess goes, exactly as an unlocked check's swap.
  for (const changed of [[{ field: "roof.porchOutFt" }], [{ field: "roof.porchOutFt" }, { field: "roof.porchDepthFt" }]]) {
    const corr = changed.length === 2 ? { roof: { porchOutFt: 6, porchDepthFt: 0 } } : { roof: { porchOutFt: 6 } };
    const swap = applySelfCheck(DRAFTED, checkRead(corr, changed), CHECK_DIMS, "v2", false, false, true);
    const ref = applySelfCheck(DRAFTED, checkRead(corr, changed), CHECK_DIMS, "v2");
    assert(swap.ok && ref.ok, "applied");
    if (!swap.ok || !ref.ok) return;
    assertEquals([swap.d3.roof.porchOutFt, swap.d3.roof.porchDepthFt], [6, undefined], `${changed.length} declared`);
    assertEquals([swap.changed, swap.dropped], [ref.changed, ref.dropped], `${changed.length} declared: reported as an unlocked check reports it`);
  }
  // No porch at all, a front turned to the eave wall, a shed, or wings: each lands as it always did.
  for (const [name, corr, fields] of [
    ["no porch", { roof: { porchDepthFt: 0 } }, ["roof.porchDepthFt"]],
    ["an eave front", { roof: { front: "eave", porchDepthFt: 8 } }, ["roof.front", "roof.porchDepthFt"]],
    ["a shed", { roof: { type: "shed", highSide: "front", porchDepthFt: 8 } }, ["roof.type", "roof.highSide", "roof.porchDepthFt"]],
    ["wings", { roof: { wingSide: "both", wingWidthFt: 4, porchDepthFt: 8 } }, ["roof.wingSide", "roof.wingWidthFt", "roof.porchDepthFt"]],
  ] as const) {
    const read = checkRead(corr as Record<string, unknown>, fields.map((field) => ({ field })));
    const a = applySelfCheck(DRAFTED, read, CHECK_DIMS, "v2", false, false, true);
    const b = applySelfCheck(DRAFTED, read, CHECK_DIMS, "v2");
    assert(a.ok && b.ok, `${name}: applied`);
    assertEquals(a, b, `${name}: exactly the unlocked answer`);
  }
  // A depth the points are not for is never locked, whatever the caller says.
  const eave = draftAt(6, { front: "eave" });
  const e = applySelfCheck(eave, checkRead({ roof: { porchDepthFt: 8 } }, [{ field: "roof.porchDepthFt" }]), CHECK_DIMS, "v2", false, false, true);
  assert(e.ok && e.d3.roof.porchDepthFt === 8, "an eave front's depth is the check's");
});
