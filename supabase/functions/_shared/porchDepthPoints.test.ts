// A RECESSED PORCH'S DEPTH FROM POINTS (2026-10-07): measure.porch, porchDepthFromMeasure, how a read
// takes it (applyMeasuredPitches, readDraftReply, draftReadSample), the five-read consensus over it,
// and the self-check's lock on a depth the reads measured (measuredPorchLock, selfCheckPrompt,
// applySelfCheck). aiSelfCheckPorchLockWiring_test runs the lock through the shipped handler.
//
// Deliberately dependency-free (no jsr:/npm: imports), the rule the other _shared tests follow.
// deno test --allow-read supabase/functions/_shared/porchDepthPoints.test.ts

import {
  applyMeasuredPitches, applySelfCheck, consensusDrafts, consensusOfCalls, draftReadSample, measuredPorchLock, parseMeasure, parseModelSpec,
  parseSelfCheck, porchDepthFromMeasure, porchDepthReading, porchPointsApply, readDraftReply, sanitizeD3Spec,
  selfCheckPrompt, selfCheckRequest, videoShapePrompt, combinedShapePrompt, SELF_CHECK_VIEWPOINTS,
  MEASURE_PORCH_MAX_LEAN, MEASURE_PORCH_MIN_DEPTH_FT, MEASURE_PORCH_MIN_EAVE_RUN, MEASURE_PORCH_MIN_SPAN, MEASURE_PORCH_ROOM_FT,
  MEASURED_PORCH_LOCK_MIN_READS, MEASURED_PORCH_LOCK_TOLERANCE,
} from "./styleD3.ts";
import type { D3Spec, DraftCall, DraftReading, KnownDims, PorchRefusal } from "./styleD3.ts";

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
// `camXFt` along it and `camYFt` up. The porch takes the last D ft of the side; the roof's lower edge
// runs H ft up and `ovFt` out from the wall (the overhang, toward the camera). Returns the five
// measure.porch points, to the nearest pixel, in a 1600 by 900 frame centred on the side: frontEave on
// that edge above the front post, and backEave on it `eaveBackFt` from the back (0, above backBase,
// unless a roof step ends the front section's edge sooner).
type PorchScene = { L: number; D: number; H: number; ovFt: number; yawDeg: number; distFt: number; camXFt: number; camYFt?: number; backOnRight?: boolean; eaveBackFt?: number };
type Pt = [number, number];
type PorchBlock = { size: Pt; backBase: Pt; porchBase: Pt; frontBase: Pt; backEave: Pt; frontEave: Pt };
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
    backEave: at(sc.eaveBackFt ?? 0, sc.H, -sc.ovFt), frontEave: at(sc.L, sc.H, -sc.ovFt),
  };
};
const inFrame = (b: PorchBlock) => [b.backBase, b.porchBase, b.frontBase, b.backEave, b.frontEave]
  .every(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= HPX);
// The 14x40 building: a 6 ft porch, the roof's edge 8.25 ft up (a 7.75 ft wall and its fascia), a 1 ft overhang.
const CABIN: PorchScene = { L: 40, D: 6, H: 8.25, ovFt: 1, yawDeg: 0, distFt: 45, camXFt: 20 };
// Every camera the first test tries, whose frame holds all five points.
const cameras = (sc: PorchScene) => {
  const out: { what: string; m: PorchBlock }[] = [];
  for (const yawDeg of [-35, -25, -15, -5, 5, 15, 25, 35]) {
    for (const camXFt of [5, 20, 35]) {
      for (const camYFt of [4, 6]) {
        for (const backOnRight of [false, true]) {
          const m = porchShot({ ...sc, yawDeg, camXFt, camYFt, backOnRight });
          // A camera whose frame cuts a corner off is not a frame the paragraph asks for.
          if (inFrame(m)) out.push({ what: `yaw ${yawDeg}, ${camXFt} ft along, ${camYFt} ft up${backOnRight ? ", mirrored" : ""}`, m });
        }
      }
    }
  }
  return out;
};
// What reading the side as a plain share of the base line says: the live error.
const plainShare = (b: PorchBlock, L: number) => {
  const len = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  return L * (1 - len(b.backBase, b.porchBase) / len(b.backBase, b.frontBase));
};

Deno.test("porchDepthFromMeasure: a 6 ft porch on a 14x40 reads 6 (+/- 0.5) from every camera, where a plain share is feet out", () => {
  let worstPlain = 0;
  const shots = cameras(CABIN);
  for (const { what, m } of shots) {
    const r = porchDepthReading(m, 40);
    assert(r.depthFt !== null, `${what}: refused (${r.refused})`);
    assert(Math.abs(r.depthFt! - 6) <= 0.5, `${what}: ${r.depthFt}`);
    assertEquals(porchDepthFromMeasure(m, 40), r.depthFt, `${what}: the two agree`);
    worstPlain = Math.max(worstPlain, Math.abs(plainShare(m, 40) - 6));
  }
  assert(shots.length >= 80, `the simulation covers enough cameras (${shots.length})`);
  // The perspective the cross-ratio undoes: a plain share of the same frames is up to feet out.
  assert(worstPlain > 2, `a plain share is ${worstPlain.toFixed(1)} ft out at worst`);
  // Deep when the FRONT end stands nearer the camera: 8 for a 6, the live misread, at 25 degrees.
  const near = porchShot({ ...CABIN, yawDeg: 25, camXFt: 20 });
  assert(plainShare(near, 40) > 8, `front nearer: a plain share reads ${plainShare(near, 40).toFixed(2)}`);
  assertEquals(porchDepthFromMeasure(near, 40), 6, "and the points read 6");
});

// ⚠️ THE EAVE POINTS ARE WHERE A READ'S PIXELS GO WRONG (review, 2026-10-07): an edge that does not
// show cleanly, placed a pixel or two off. Only the edge's direction is used, so the further apart its
// two points the less a pixel moves it. 2 px on either point, either way, on an edge the side's whole
// length (or the front section's, up to a roof step 16 ft from the back) keeps a 6 a 6 (or within half
// a foot), from every camera. Two points the porch's width apart, the first paragraph's, are refused:
// the same 2 px there came to 1.25 ft.
Deno.test("⚠️ porchDepthFromMeasure: 2 px on either eave point, either way, leaves the depth within a fraction of a foot", () => {
  for (const [eaveBackFt, rawWithin, roundedWithin] of [[0, 0.25, 0], [16, 0.35, 0.5]] as const) {
    const shots = cameras({ ...CABIN, eaveBackFt });
    assert(shots.length >= 80, `the simulation covers enough cameras (${shots.length})`);
    let worst = 0;
    for (const { what, m } of shots) {
      for (const db of [-2, -1, 0, 1, 2]) {
        for (const df of [-2, -1, 0, 1, 2]) {
          const r = porchDepthReading({ ...m, backEave: [m.backEave[0], m.backEave[1] + db], frontEave: [m.frontEave[0], m.frontEave[1] + df] }, 40);
          const at = `edge from ${eaveBackFt} ft, ${what}, back eave ${db} px, front eave ${df} px`;
          assert(r.depthFt !== null, `${at}: refused (${r.refused})`);
          worst = Math.max(worst, Math.abs(r.rawDepthFt! - 6));
          assert(Math.abs(r.depthFt! - 6) <= roundedWithin, `${at}: ${r.depthFt}`);
        }
      }
    }
    assert(worst <= rawWithin, `edge from ${eaveBackFt} ft: ${worst.toFixed(2)} ft at worst`);
  }
  // The first paragraph's two points, straight above porchBase and frontBase: too short an edge.
  for (const { what, m } of cameras({ ...CABIN, eaveBackFt: 34 })) assertEquals(porchDepthReading(m, 40).refused, "run", what);
});

// The live frames the review's three stand-in reads marked (1280 by 720, a 40 ft side, the porch 6 ft):
// their own base points, and the roof's lower edge fitted along the front section up to its step
// (walk-05 y = -0.03772 x + 328.68, walk-04 y = 0.05449 x + 221.39, 0.7 and 0.4 px of scatter).
Deno.test("porchDepthFromMeasure: the live frames read 6 on the roof's edge, and their fascia points over the porch are refused", () => {
  const w5 = (x: number) => Math.round((-0.03772 * x + 328.68) * 10) / 10;
  const w4 = (x: number) => Math.round((0.05449 * x + 221.39) * 10) / 10;
  for (const [name, base, edge, backX, fascia] of [
    ["walk-05, stand-in 1", { backBase: [1161, 485], porchBase: [295, 560], frontBase: [111, 572] }, w5, 810, { backEave: [293, 336], frontEave: [111, 341] }],
    ["walk-04, stand-in 2", { backBase: [1137, 440], porchBase: [496, 505], frontBase: [290, 525] }, w4, 915, { backEave: [496, 263], frontEave: [290, 256] }],
    ["walk-05, stand-in 3", { backBase: [1160, 484], porchBase: [295, 554], frontBase: [112, 568] }, w5, 810, { backEave: [292, 330], frontEave: [112, 337] }],
  ] as const) {
    const onEdge = { size: [1280, 720], ...base, backEave: [backX, edge(backX)], frontEave: [base.frontBase[0], edge(base.frontBase[0])] };
    const r = porchDepthReading(onEdge, 40);
    assertEquals(r.depthFt, 6, `${name}: ${r.rawDepthFt?.toFixed(2)} (${r.refused})`);
    assert(Math.abs(r.rawDepthFt! - 6) < 0.2, `${name}: ${r.rawDepthFt!.toFixed(2)} ft before rounding`);
    // What the stand-ins marked under the first paragraph: the fascia's bottom edge above the porch
    // corner and the post, 182 to 206 px apart. They read 5.5, 6.5 and 6; now they are refused.
    assertEquals(porchDepthReading({ size: [1280, 720], ...base, ...fascia }, 40).refused, "run", name);
  }
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
  const flat = { size: [1600, 900], backBase: [1400, 600], porchBase: [440, 600], frontBase: [200, 600], backEave: [1400, 300], frontEave: [200, 300] };
  const r = porchDepthReading(flat, 40);
  assertEquals([r.depthFt, r.refused, Math.round(r.share! * 1e9) / 1e9, Math.round(r.rawDepthFt! * 1e9) / 1e9], [8, null, 0.8, 8]);
  const mirrored = { ...flat, backBase: [200, 600], porchBase: [1160, 600], frontBase: [1400, 600], backEave: [200, 300], frontEave: [1400, 300] };
  assertEquals(porchDepthFromMeasure(mirrored, 40), 8);
  // Only the edge's direction counts: anywhere along it, past either corner, reads the same.
  assertEquals(porchDepthFromMeasure({ ...flat, backEave: [900, 300], frontEave: [150, 300] }, 40), 8);
  // Rounded to half a foot: 0.85 of 40 is 6, and 0.86 (5.6 ft) is 5.5.
  assertEquals(porchDepthFromMeasure({ ...flat, porchBase: [380, 600] }, 40), 6);
  assertEquals(porchDepthFromMeasure({ ...flat, porchBase: [368, 600] }, 40), 5.5);
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
  // The wall's height in the frame at the front post, which the lean is held to.
  const wall = m.frontBase[1] - m.frontEave[1];
  // points: a point missing, not a number, not finite, outside the size, or a size that is no size.
  const { backEave: _gone, ...four } = m;
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
    return { size: m.size, backBase: c(m.backBase), porchBase: c(m.porchBase), frontBase: c(m.frontBase), backEave: c(m.backEave), frontEave: c(m.frontEave) };
  };
  const spanOf = (b: PorchBlock) => Math.hypot(b.frontBase[0] - b.backBase[0], b.frontBase[1] - b.backBase[1]);
  const k = (MEASURE_PORCH_MIN_SPAN * W * 0.95) / spanOf(m);
  assertEquals(why(shrink(k)), "span");
  // across: a base line steeper than 45 degrees.
  assertEquals(why({ size: [1600, 900], backBase: [800, 100], porchBase: [705, 760], frontBase: [700, 800], backEave: [700, 100], frontEave: [590, 800] }), "across");
  // between: porchBase past the front corner, or behind the back one.
  const alongBase = (t: number): Pt => [
    Math.round(m.backBase[0] + t * (m.frontBase[0] - m.backBase[0])), Math.round(m.backBase[1] + t * (m.frontBase[1] - m.backBase[1])),
  ];
  assertEquals(why({ ...m, porchBase: alongBase(1.02) }), "between");
  assertEquals(why({ ...m, porchBase: alongBase(-0.02) }), "between");
  // eave: either eave point below the base line.
  assertEquals(why({ ...m, backEave: [m.backEave[0], m.backBase[1] + 20] }), "eave");
  assertEquals(why({ ...m, frontEave: [m.frontEave[0], m.frontBase[1] + 20] }), "eave");
  // run: the two eave points on one pixel, swapped, or closer than MEASURE_PORCH_MIN_EAVE_RUN of the base
  // line apart along it: the porch's width, as the first paragraph asked, is too close.
  const eaveAt = (t: number): Pt => [
    Math.round(m.frontEave[0] + t * (m.backEave[0] - m.frontEave[0])), Math.round(m.frontEave[1] + t * (m.backEave[1] - m.frontEave[1])),
  ];
  assertEquals(why({ ...m, backEave: m.frontEave }), "run");
  assertEquals(why({ ...m, backEave: m.frontEave, frontEave: m.backEave }), "run");
  assertEquals(why({ ...m, backEave: porchShot({ ...CABIN, yawDeg: 20, camXFt: 26, eaveBackFt: 34 }).backEave }), "run");
  const runOf = (b: PorchBlock) => (b.frontEave[0] - b.backEave[0]) / (b.frontBase[0] - b.backBase[0]);
  const short = { ...m, backEave: eaveAt(MEASURE_PORCH_MIN_EAVE_RUN * 0.95 / runOf(m)) };
  const long = { ...m, backEave: eaveAt(MEASURE_PORCH_MIN_EAVE_RUN * 1.05 / runOf(m)) };
  assertEquals(why(short), "run", `a run of ${runOf(short).toFixed(3)}`);
  assertEquals(why(long), null, `a run of ${runOf(long).toFixed(3)}`);
  // lean: porchBase off the base line by more than a quarter of the wall's height at the post.
  assertEquals(why({ ...m, porchBase: [m.porchBase[0], Math.round(m.porchBase[1] - (MEASURE_PORCH_MAX_LEAN + 0.05) * wall)] }), "lean");
  assert(why({ ...m, porchBase: [m.porchBase[0], Math.round(m.porchBase[1] - (MEASURE_PORCH_MAX_LEAN - 0.1) * wall)] }) !== "lean", "inside the lean is not refused for it");
  // vanishing: an eave line that meets the base line between the corners is no camera's (its back
  // point halfway along and only a few pixels above the floor line).
  const half = alongBase(0.5);
  assertEquals(why({ ...m, backEave: [half[0], half[1] - 6] }), "vanishing");
  // front: the corners read the wrong way round (and the eave's two ends with them) put the porch
  // corner nearer the back.
  assertEquals(why({ ...m, backBase: m.frontBase, frontBase: m.backBase, backEave: m.frontEave, frontEave: m.backEave }), "front");
  // shallow: a porch corner a few inches from the post.
  const flat = { size: [1600, 900], backBase: [1400, 600], porchBase: [440, 600], frontBase: [200, 600], backEave: [1400, 300], frontEave: [200, 300] };
  const at = (share: number) => ({ ...flat, porchBase: [Math.round(1400 - 1200 * share), 600] });
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

// Each read as consensusOfCalls hands it over: its spec, and whether its depth came from its points.
const consensusRead = (text: string) => {
  const r = readDraftReply(bodyOf(text), DIMS, true);
  return { d3: r.d3!, observed: null, frameMap: null, ...(r.pitch?.porchSource === "points" ? { porchMeasured: true } : {}) };
};
Deno.test("⚠️ the five-read consensus takes a recessed porch's depth from the MEASURED reads when two or more measured it", () => {
  const read = consensusRead;
  const measured = REPLY({ porchDepthFt: 8 }, POINTS), judged = REPLY({ porchDepthFt: 8 }), seven = REPLY({ porchDepthFt: 7 });
  const other = REPLY({ porchDepthFt: 8 }, porchShot({ ...CABIN, yawDeg: -15, camXFt: 30, backOnRight: true }));
  assertEquals([read(other).d3.roof.porchDepthFt, read(other).porchMeasured], [6, true], "a second frame measures 6 as well");
  assertEquals("porchMeasured" in read(judged), false, "a judged read is not a measured one");
  // Three reads measured 6, two judged 8: 6, and the spread still reports every read.
  const c = consensusDrafts([read(judged), read(measured), read(other), read(judged), read(measured)]);
  assertEquals(c.d3.roof.porchDepthFt, 6);
  assertEquals(c.report.spread.porchDepthFt, [6, 8]);
  // Two measured beside three judged (review, 2026-10-07): over all five that was 7 (6, 6, 7, 8, 8)
  // or 8 (three judged 8s), a judged number the lock then refused. The measured reads alone give 6,
  // and the self-check is told it was measured.
  const two = consensusDrafts([read(judged), read(measured), read(judged), read(judged), read(other)]);
  assertEquals(two.d3.roof.porchDepthFt, 6);
  assertEquals(two.report.spread.porchDepthFt, [6, 8]);
  assertEquals(consensusDrafts([read(judged), read(measured), read(seven), read(judged), read(other)]).d3.roof.porchDepthFt, 6);
  const tokens = { samples: [judged, measured, judged, judged, other].map((t) => draftReadSample(readDraftReply(bodyOf(t), DIMS, true))) };
  assert(measuredPorchLock(tokens, two.d3), "and locked");
  // ONE measured read is one set of points: every read's depth votes, as before.
  assertEquals(consensusDrafts([read(judged), read(measured), read(judged), read(seven), read(judged)]).d3.roof.porchDepthFt, 8);
  assertEquals(consensusDrafts([read(seven), read(measured), read(seven)]).d3.roof.porchDepthFt, 7);
  // A consensus whose porch the points are not for (the front voted to the eave wall) takes every
  // read's depth too: the two measured reads looked at a different building.
  const eave = REPLY({ front: "eave", porchDepthFt: 8 });
  assertEquals(consensusDrafts([read(eave), read(measured), read(eave), read(other), read(eave)]).d3.roof.porchDepthFt, 8);
  // A flag on a read whose own porch the points are not for counts for nothing.
  assertEquals(consensusDrafts([read(judged), { ...read(eave), porchMeasured: true }, read(judged), read(measured), read(judged)]).d3.roof.porchDepthFt, 8);
});

Deno.test("consensusOfCalls hands each read's measured porch over to the consensus", () => {
  const call = (index: number, text: string, measure = true): DraftCall<DraftReading> => ({
    index, ms: 1000, attempts: 1, threw: false, error: null, aborted: null, status: 200, httpOk: true,
    body: bodyOf(text), reading: readDraftReply(bodyOf(text), DIMS, measure),
  });
  const judged = REPLY({ porchDepthFt: 8 }), measured = REPLY({ porchDepthFt: 8 }, POINTS);
  const other = REPLY({ porchDepthFt: 8 }, porchShot({ ...CABIN, yawDeg: -15, camXFt: 30, backOnRight: true }));
  const five = [judged, measured, judged, other, judged];
  const c = consensusOfCalls(five.map((t, i) => call(i, t)), 12);
  assertEquals(c?.d3.roof.porchDepthFt, 6, "two measured 6s beside three judged 8s");
  // Read without its measure (every legacy reader), nothing is measured and the 8s carry it.
  assertEquals(consensusOfCalls(five.map((t, i) => call(i, t, false)), 12)?.d3.roof.porchDepthFt, 8);
});

// ─── The prompt asks for it ───────────────────────────────────────────────────────────────────
const PORCH_SCHEMA = '    "porch": { "frame": <1-based index of the image you marked the recessed porch in>, "size": [<that image\'s width in pixels>, <its height in pixels>], "backBase": [<x>, <y>], "porchBase": [<x>, <y>], "frontBase": [<x>, <y>], "backEave": [<x>, <y>], "frontEave": [<x>, <y>] }\n  },';
Deno.test("v2 prompt: the recessed porch asks for measure.porch, beside a porchDepthFt on a gable-end front, and its example reads true", () => {
  for (const [name, p] of [
    ["video", videoShapePrompt(DIMS, true)],
    ["combined", combinedShapePrompt(12, 2, DIMS, true)],
  ] as const) {
    const text = lf(p);
    assert(text.includes(PORCH_SCHEMA), `${name}: the schema's measure block ends with the porch's`);
    assert(text.includes("Omit both keys if the building has no porch. PORCH POINTS, measure.porch, only when you give porchDepthFt on a building whose front is a gable end: we work the porch's depth out from these points, so mark them rather than judge it."), `${name}: asked for only with a recessed porch`);
    for (const k of ["backBase", "porchBase", "frontBase"]) assert(text.includes(`${k}, the foot`), `${name}: ${k} is described`);
    // The eave's two points: on whichever roof edge shows crisply, as far apart as it runs, and never
    // tied to porchBase (review, 2026-10-07: the fascia's bottom edge above it was the guess).
    for (const words of [
      "two points on ONE straight edge of the roof along that side, whichever edge shows crisply all the way along, usually the roof's own lower edge against the fascia below it",
      "frontEave, on that edge above the front corner post, and backEave, on the same edge as far back as it runs, above backBase, or just in front of the step when the roof steps (both on the FRONT section's edge then).",
      "Only that edge's direction is used, so put its two points as far apart as it goes; neither has to be above porchBase.",
    ]) assert(text.includes(words), `${name}: ${words.slice(0, 40)}`);
    const para = text.slice(text.indexOf("PORCH POINTS")).split("\n")[0];
    for (const gone of ["porchFascia", "frontFascia", "straight above porchBase"]) assert(!para.includes(gone), `${name}: no ${gone}`);
  }
  // The example is a frame of a real camera: on a 28 ft deep building it reads 5.
  const ex = lf(videoShapePrompt(DIMS, true)).match(/For example, a side in a 1600 by 900 image might read backBase (\[[^\]]+\]), porchBase (\[[^\]]+\]), frontBase (\[[^\]]+\]), backEave (\[[^\]]+\]), frontEave (\[[^\]]+\])\./);
  assert(ex, "the worked example is there");
  const [backBase, porchBase, frontBase, backEave, frontEave] = ex!.slice(1).map((s) => JSON.parse(s));
  assertEquals(porchDepthFromMeasure({ size: [1600, 900], backBase, porchBase, frontBase, backEave, frontEave }, 28), 5);
  // ...from the camera that made it: a 28 ft side, the porch 5 ft, the roof's edge 8.5 ft up and 1 ft
  // out, seen 12 degrees off square from 34 ft away.
  const cam = porchShot({ L: 28, D: 5, H: 8.5, ovFt: 1, yawDeg: 12, distFt: 34, camXFt: 14, backOnRight: true });
  assertEquals([backBase, porchBase, frontBase, backEave, frontEave], [cam.backBase, cam.porchBase, cam.frontBase, cam.backEave, cam.frontEave]);
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
  // A spec at 8 beside two measured 6s (a later round's, judged by eye) is a judged number, not a measured one.
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
  // A gambrel keeping the gable-end front and the recess is still the porch the points measured.
  const gambrel = applySelfCheck(DRAFTED, checkRead({ roof: { type: "gambrel", kneeU: 0.75, kneeRise: 0.7, ridgeRise: 1, porchDepthFt: 8 } },
    [{ field: "roof.type" }, { field: "roof.kneeU" }, { field: "roof.kneeRise" }, { field: "roof.ridgeRise" }, { field: "roof.porchDepthFt" }]), CHECK_DIMS, "v2", false, false, true);
  assert(gambrel.ok && gambrel.d3.roof.type === "gambrel" && gambrel.d3.roof.porchDepthFt === 6, "a gambrel keeps the measured depth");
  // A depth the points are not for is never locked, whatever the caller says.
  const eave = draftAt(6, { front: "eave" });
  const e = applySelfCheck(eave, checkRead({ roof: { porchDepthFt: 8 } }, [{ field: "roof.porchDepthFt" }]), CHECK_DIMS, "v2", false, false, true);
  assert(e.ok && e.d3.roof.porchDepthFt === 8, "an eave front's depth is the check's");
});

Deno.test("⚠️ applySelfCheck: a change the gates drop or put back leaves the porch as it was, and the lock holds", () => {
  // Review, 2026-10-07: the lock was decided off the DECLARED roof keys, before the gates read them. A
  // side wall (always dropped), a roof type or front nobody draws (dropped before the merge, or put
  // back after it) each let go of it, and the same answer's porchDepthFt 8 landed on the unchanged
  // gable-front porch. It is now decided on the spec the answer builds.
  for (const [name, corr, fields] of [
    ["a side wall", { roof: { porchEnd: "left", porchDepthFt: 8 } }, ["roof.porchEnd", "roof.porchDepthFt"]],
    ["the other side wall", { roof: { porchEnd: "right", porchDepthFt: 8 } }, ["roof.porchEnd", "roof.porchDepthFt"]],
    ["a roof type nobody draws", { roof: { type: "hip", porchDepthFt: 8 } }, ["roof.type", "roof.porchDepthFt"]],
    ["a front nobody draws", { roof: { front: "side", porchDepthFt: 8 } }, ["roof.front", "roof.porchDepthFt"]],
    ["no front", { roof: { front: null, porchDepthFt: 8 } }, ["roof.front", "roof.porchDepthFt"]],
    ["the same front", { roof: { front: "gable", porchDepthFt: 8 } }, ["roof.front", "roof.porchDepthFt"]],
  ] as const) {
    const read = checkRead(corr as Record<string, unknown>, fields.map((field) => ({ field })));
    const a = applySelfCheck(DRAFTED, read, CHECK_DIMS, "v2", false, false, true);
    assert(a.ok, `${name}: applied`);
    if (!a.ok) return;
    const r = a.d3.roof;
    assertEquals([r.type, r.front, r.porchEnd, r.porchDepthFt], ["gable", "gable", "front", 6], `${name}: the porch the points measured, at their depth`);
    assertEquals(a.changed, [], `${name}: nothing reported as changed`);
    assert(a.dropped.includes("roof.porchDepthFt"), `${name}: the depth reported as not applied`);
    // The fixture is one the lock matters for: unlocked, the 8 lands.
    const b = applySelfCheck(DRAFTED, read, CHECK_DIMS, "v2");
    assert(b.ok && b.d3.roof.porchDepthFt === 8, `${name}: unlocked, the 8 lands`);
  }
});
