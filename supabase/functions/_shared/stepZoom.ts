// ─── WHICH WAY THE ROOF STEPS, READ FROM A CLOSE-UP (2026-09-29) ─────────────────────────────
// A roof built in two sections steps at the joint by a few inches (rearStepFt / rearEaveRiseFt in
// styleD3.ts). Live, on a building whose rear section stands about 0.6 ft HIGHER, the v2 draft
// found the step every time and gave its direction backwards: 15 reads of 15 before the step's
// points were asked for, and still most reads after, their own points placing the rear fascia
// lower. The step is 6 to 16 px in a 1280 px walk frame, at the edge of what the model resolves
// there, and the rest of the draft's work pulls its attention off it (a standalone question about
// the same frames did better, but only 2 to 3 in 5 once worded for production).
//
// A CLOSE-UP SETTLES IT. The same joint cropped out of the frame and enlarged 8 times was read the
// right way 10 times in 10 (two frames, five asks each, 11-14 s and about $0.03 an ask), with the
// fascia bottoms placed 80 and 145 px apart in the enlarged images, 10 and 18 px in the frames.
//
// So when the v2 consensus draws a step, the draft (portal-settings) crops the joint out of the
// frame the reads marked it in (their measure.step points, kept on each reading as `stepPoints`),
// enlarges it, asks STEP_ZOOM_ASKS times in parallel and takes the majority's direction. The
// height comes from the same answers: the gap between the two fascia bottoms, over the wall's
// height at the joint in that frame, times the builder's wall height. When nothing usable comes
// back, the consensus's step stands exactly as it was.
//
// ⚠️ THE IMAGE LIBRARY IS IMPORTED ONLY WHEN A CLOSE-UP IS CUT (cutCloseUps in closeUp.ts). Its JPEG
// and zlib modules fetch their WebAssembly from deno.land as they load, so a static import would put
// that fetch on every cold start of portal-settings, and an unreachable deno.land would fail requests
// that never draw a step.
//
// The cutting, the frame's fetch and the asks are closeUp.ts's since the eave overhang got a close-up
// of its own (overhangZoom.ts, 2026-09-29); what is sent and what comes back are unchanged.
import { askCloseUps, closeUpUsage, closeUpWindow, cutCloseUps, fetchFrame, isXY, median } from "./closeUp.ts";
import type { XY } from "./closeUp.ts";

export const STEP_ZOOM = 8;
export const STEP_ZOOM_ASKS = 3;
// The close-up is 1/STEP_ZOOM of the frame each way, so an enlarged close-up is the frame's size.
export const STEP_ZOOM_MIN_LEFT_MS = 45_000;
export const STEP_ZOOM_CALL_MS = 40_000;
export const STEP_ZOOM_MAX_TOKENS = 4000;

// Where to crop: the joint as the reads marked it. `frame` is 1-based, `size` the reads' own
// [width, height] for that frame (the points are in those units), `joint` the front fascia's bottom
// at the joint, `wallPx` the wall's height there (jointBase.y - jointFront.y), and `frontOnLeft`
// which way the building runs in that frame.
export type StepZoomPlan = { frame: number; size: XY; joint: XY; wallPx: number; frontOnLeft: boolean };

// From the reads' measure.step blocks: the most common frame (ties to the lowest index), and the
// medians of the reads that used it. Null with no usable block.
export function stepZoomPlan(blocks: readonly unknown[]): StepZoomPlan | null {
  const ok: { frame: number; size: XY; jf: XY; jb: XY; fb: XY; bb: XY }[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object" || Array.isArray(b)) continue;
    const o = b as Record<string, unknown>;
    const frame = typeof o.frame === "number" && Number.isInteger(o.frame) && o.frame >= 1 ? o.frame : null;
    if (frame === null || !isXY(o.size) || !isXY(o.jointFront) || !isXY(o.jointBase) || !isXY(o.frontBase) || !isXY(o.backBase)) continue;
    if (!(o.size[0] > 0 && o.size[1] > 0) || !(o.jointBase[1] > o.jointFront[1])) continue;
    ok.push({ frame, size: o.size, jf: o.jointFront, jb: o.jointBase, fb: o.frontBase, bb: o.backBase });
  }
  if (!ok.length) return null;
  const count = new Map<number, number>();
  for (const r of ok) count.set(r.frame, (count.get(r.frame) ?? 0) + 1);
  const frame = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const same = ok.filter((r) => r.frame === frame);
  const left = same.filter((r) => r.fb[0] < r.bb[0]).length;
  return {
    frame,
    size: same[0].size,
    joint: [median(same.map((r) => r.jf[0])), median(same.map((r) => r.jf[1]))],
    wallPx: median(same.map((r) => r.jb[1] - r.jf[1])),
    frontOnLeft: left * 2 >= same.length,
  };
}

export function stepZoomPrompt(frontOnLeft: boolean, heightPx: number): string {
  const [front, back] = frontOnLeft ? ["LEFT", "RIGHT"] : ["RIGHT", "LEFT"];
  return `This image is a close-up, enlarged ${STEP_ZOOM} times, of one small place on a portable building's roof edge, seen from one of its long sides. The building's roof is built in two sections, and the close-up is centred on the joint where the two sections meet, where there is a small step between the two roof edges (the fascia boards along the eave).

The FRONT of the building is to the ${front} of the joint and the BACK is to the ${back}.

At the joint, whose fascia board sits higher in the image, the one on the FRONT side of the joint or the one on the BACK side? Which section's roof ends in a visible end face at the joint, and which section's roof runs in underneath it? Give the pixel y of the bottom edge of each fascia board right beside the joint (y down from the top of the image, ${Math.round(heightPx)} pixels tall).

Reply with only a JSON object: {"higher": "front" | "back", "frontFasciaBottomY": <y>, "backFasciaBottomY": <y>, "why": "<one short sentence>"}`;
}

// The crop window in the frame's own pixels, for a frame `actual` pixels in size: 1/STEP_ZOOM of the
// frame each way, centred on the joint (scaled from the reads' units) and moved inside the frame.
export function stepZoomWindow(plan: StepZoomPlan, actual: XY): { x: number; y: number; w: number; h: number; sx: number; sy: number } {
  const sx = actual[0] / plan.size[0], sy = actual[1] / plan.size[1];
  return { ...closeUpWindow([plan.joint[0] * sx, plan.joint[1] * sy], actual, STEP_ZOOM), sx, sy };
}

// The direction and height from the asks' reply texts. `wallPxActual` is the wall's height at the
// joint in the frame's own pixels and `zoomY` the enlargement's vertical scale. The direction is the
// strict majority of the answers that name one (at least two); the height is the median over the
// answers that agree with it and whose own two numbers agree with it too, clamped away when it
// is under 0.05 ft or over 1.5 ft. Null when there is no majority.
export type StepZoomVerdict = { higher: "front" | "back"; votes: { front: number; back: number }; riseFt: number | null };
export function stepZoomVerdict(texts: readonly (string | null)[], wallPxActual: number, zoomY: number, wallFt: number): StepZoomVerdict | null {
  const answers: { higher: "front" | "back"; gap: number | null }[] = [];
  for (const t of texts) {
    const m = String(t ?? "").match(/\{[\s\S]*\}/);
    if (!m) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(m[0]); } catch { continue; }
    if (j.higher !== "front" && j.higher !== "back") continue;
    const f = j.frontFasciaBottomY, b = j.backFasciaBottomY;
    // y DOWN: the back fascia higher in the image has the smaller y, a positive gap.
    const gap = typeof f === "number" && typeof b === "number" && Number.isFinite(f) && Number.isFinite(b) ? f - b : null;
    answers.push({ higher: j.higher, gap });
  }
  const votes = { front: answers.filter((a) => a.higher === "front").length, back: answers.filter((a) => a.higher === "back").length };
  if (answers.length < 2 || votes.front === votes.back) return null;
  const higher = votes.back > votes.front ? "back" : "front";
  const sign = higher === "back" ? 1 : -1;
  const rises = answers
    .filter((a) => a.higher === higher && a.gap !== null && a.gap * sign > 0)
    .map((a) => (Math.abs(a.gap as number) / zoomY) / wallPxActual * wallFt);
  let riseFt: number | null = null;
  if (rises.length && wallPxActual > 0 && zoomY > 0) {
    const r = Math.round(median(rises) * 100) / 100;
    if (r >= 0.05 && r <= 1.5) riseFt = sign * r;
  }
  return { higher, votes, riseFt };
}

// Crops the joint out of a frame's JPEG bytes and enlarges it STEP_ZOOM times. Returns the close-up
// as base64 JPEG, its height, the vertical enlargement and the wall's height at the joint in the
// frame's own pixels.
export async function stepZoomCrop(bytes: Uint8Array, plan: StepZoomPlan): Promise<{ base64: string; heightPx: number; zoomY: number; wallPxActual: number }> {
  let sy = 1;
  const { closeUps: [c] } = await cutCloseUps(bytes, (actual) => {
    const win = stepZoomWindow(plan, actual);
    sy = win.sy;
    return [win];
  }, STEP_ZOOM);
  return { base64: c.base64, heightPx: c.height, zoomY: c.height / c.win.h, wallPxActual: plan.wallPx * sy };
}

// The whole close-up, for the v2 draft (portal-settings): plan the crop from the reads' blocks, fetch
// the frame, cut and enlarge the joint, ask STEP_ZOOM_ASKS times in parallel and judge. `riseFt` is
// the new rearEaveRiseFt, or null to keep the consensus's: the verdict's own height, else the
// consensus's height with the verdict's direction. `record` is what draft_tokens.stepZoom keeps,
// null when no close-up was tried (no usable points, no such frame, or under STEP_ZOOM_MIN_LEFT_MS
// of the draft's budget left); `input` and `output` are the asks' tokens. Never throws.
export async function runStepZoom(o: {
  blocks: readonly unknown[];
  photoUrls: readonly string[];
  rise0: number;
  wallFt: number;
  leftMs: number;
  apiKey: string;
  model: Record<string, unknown>;
  signal: AbortSignal;
  fetchFn?: typeof fetch;
}): Promise<{ riseFt: number | null; record: Record<string, unknown> | null; input: number; output: number }> {
  const f = o.fetchFn ?? fetch;
  const plan = stepZoomPlan(o.blocks);
  const frameUrl = plan ? o.photoUrls[plan.frame - 1] : undefined;
  if (!plan || !frameUrl || o.leftMs < STEP_ZOOM_MIN_LEFT_MS) return { riseFt: null, record: null, input: 0, output: 0 };
  const t0 = Date.now();
  const record: Record<string, unknown> = { frame: plan.frame, before: o.rise0 };
  let input = 0, output = 0, riseFt: number | null = null;
  try {
    const crop = await stepZoomCrop(await fetchFrame(f, frameUrl, o.signal), plan);
    const callMs = Math.min(STEP_ZOOM_CALL_MS, o.leftMs - 5_000 - (Date.now() - t0));
    const asks = await askCloseUps({
      f, apiKey: o.apiKey, model: o.model, maxTokens: STEP_ZOOM_MAX_TOKENS, images: [crop.base64],
      prompt: stepZoomPrompt(plan.frontOnLeft, crop.heightPx), asks: STEP_ZOOM_ASKS, callMs, signal: o.signal,
    });
    [input, output] = closeUpUsage(asks);
    record.usage = { input, output };
    const verdict = stepZoomVerdict(asks.map((a) => a.text), crop.wallPxActual, crop.zoomY, o.wallFt);
    record.votes = verdict ? verdict.votes : null;
    if (verdict) {
      const sign = verdict.higher === "back" ? 1 : -1;
      riseFt = verdict.riseFt ?? (Math.abs(o.rise0) >= 0.05 ? sign * Math.abs(o.rise0) : null);
    }
  } catch (e) {
    record.error = String(e instanceof Error ? e.message : e).slice(0, 160);
  }
  record.after = riseFt;
  record.ms = Date.now() - t0;
  return { riseFt, record, input, output };
}
