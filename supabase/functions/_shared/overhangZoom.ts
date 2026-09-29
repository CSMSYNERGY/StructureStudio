// ─── HOW FAR THE EAVES OVERHANG, READ FROM TWO CLOSE-UPS (2026-09-29) ─────────────────────────────
// The v2 draft read roof.overhang (asked as overhangIn) at 6 in on two gable buildings whose measured
// eaves stand 12 in and 16 in past the walls: 3 reads of 3 at 0.50 ft on a 14x40 gable cabin with a
// recessed front porch (truth 1.3 ft) and on a 37x22 raised-centre house with side wings (truth
// 1.0 ft). Every other shape field on both was right. In the square-on gable frame the overhang is
// 57 to 71 px on a 1280 px frame at best, and the reads judged it rather than measured it.
//
// THE ROOF STEP'S TRICK (stepZoom.ts) SETTLES IT. Each read already marks, in measure.pitch, the two
// TIPS of the gable's sloping top edge in the frame most square-on to a gable end, and the overhang is
// exactly there: the roof's end stands out past the wall corner below it. So the draft cuts a sixth of
// that frame each way around each tip, enlarges both 6 times, and asks, in ONE question with both
// close-ups, where the roof's end and the gable wall's corner are in each. The two wall corners are
// also the scale: they are the gable's width apart, so the overhang each side is its gap over that
// span times the gable's width. No camera model and no scale from the reads.
//
// WHAT THE PROBE MEASURED (263 calls, about $11, 2026-09-29; this variant is "c6p" with prompt v4).
// Fifteen fresh asks per building: the cabin 1.421-1.433 ft (median 1.427, +0.13), the house
// 1.027-1.153 (median 1.051, +0.05), every ask kept. Grouped as five drafts of three asks, the cabin
// read 1.423 to 1.43 and the house 1.029 to 1.057, which round to 17 in and 12 to 13 in. An ask is
// about 3,300 input tokens, 560-1,400 output and 11-20 s, so about $0.13 a draft. What the prompt's
// wording and the guards below are for:
//   * THE SIDE WALL BESIDE THE CORNER. In a frame taken a little off square, the centre section's
//     side wall and its eave show beside the corner, and the first prompts put the wall corner on the
//     lit edge of that side eave's fascia (up to 4 asks in 5), which reads that side at about 0. The
//     prompt's paragraph on the "narrow strip" fixed it (0 of 15), and the LOPSIDED check drops an ask
//     that still does it: valid asks gave the smaller side 0.64-0.94 of the larger, the failure 0.07
//     or less.
//   * THE DRIP EDGE. "The outermost point of the roof" is the thin metal lip past the fascia board,
//     which read both buildings about 0.15 ft long. The prompt asks for the board's own face.
//   * A SMALLER WINDOW (an eighth at 8x) lost the corner's context: the side-wall mistake came back,
//     and on the porch the model took the dark end of the header box over the post for the post.
//   * A CORNER OUT OF THE FRAME is garbage (the roof's end put on the frame's border, or on something
//     inside), and the border check with the lopsided one rejected every such ask. A tip just inside
//     the border is fine: the window moves inside the frame, as the step's does.
//   * A ROOF END INSIDE ITS WALL is a point on the wrong thing: an eave cannot stand in from the wall
//     under it. In the probe only 2 asks put a side below 0 (-0.05 and -0.12 ft), each beside a large
//     other side, so the lopsided check dropped them; but that check alone keeps a side at -1.4 ft
//     beside one at 0.04 (the larger under 0.25 ft), and such an ask beside one good one would set the
//     cabin at 4 in. So a side more than 0.1 ft inside its wall drops the ask (a flush eave's trim may
//     read a hair in); it drops no ask the probe kept.
//   * WHAT IS LEFT is a bias of +0.13 ft on the cabin, whose fascia ends stand about a foot in front of
//     the porch posts, which magnifies them a little in the frame; the truth allowed for that and this
//     does not. Well inside the 0.25 ft the old reads missed by twice over.
//
// ONLY A GABLE, and only what the builder did not measure. portal-settings asks only on a v2 consensus
// that is a gable, when at least one read gave usable pitch points and the builder left overhangIn
// empty (a measured overhang always wins). A shed has no pitch points, and the prompt leaves them out on
// a gambrel, and not beside a lean-to (overhangGableWidthFt). When nothing usable comes back, the
// consensus's overhang stands exactly as it was.
//
// ⚠️ THE IMAGE LIBRARY is closeUp.ts's lazy import, never a static one (see there).
import { askCloseUps, closeUpUsage, closeUpWindow, cutCloseUps, fetchFrame, isXY, median } from "./closeUp.ts";
import type { CloseUpWindow, XY } from "./closeUp.ts";

// A sixth of the frame each way, enlarged 6 times: 213 x 120 px of a 1280 x 720 frame, 1278 x 720 once
// enlarged. The wall corner was always inside it (the cabin's overhang is 57-71 px, the window's half
// width 107).
export const OVERHANG_ZOOM = 6;
export const OVERHANG_ZOOM_ASKS = 3;
// The roof step's budget rule (STEP_ZOOM_MIN_LEFT_MS): no close-up with under 45 s of the draft left.
// The two run side by side, so neither adds to the other's time.
export const OVERHANG_ZOOM_MIN_LEFT_MS = 45_000;
export const OVERHANG_ZOOM_CALL_MS = 40_000;
export const OVERHANG_ZOOM_MAX_TOKENS = 4000;
// An ask is LOPSIDED, and dropped, when its larger side is at least 0.25 ft and its smaller side is
// under half of it.
export const OVERHANG_LOPSIDED_MIN_FT = 0.25;
export const OVERHANG_LOPSIDED_RATIO = 0.5;
// ...and INSIDE THE WALL, and dropped, when either side's roof end stands more than 0.1 ft (about an
// inch) in from its wall corner.
export const OVERHANG_INSIDE_MAX_FT = 0.1;
// At least two asks must survive, or the consensus's overhang stands.
export const OVERHANG_ZOOM_MIN_KEPT = 2;
// CLAMPS.overhang in styleD3.ts.
export const OVERHANG_MAX_FT = 3;

// ── WHERE TO CUT ──────────────────────────────────────────────────────────────────────────────────
// The reads' measure.pitch blocks: `frame` (1-based), the image's `size` and three points on the
// gable's sloping top edge, `left` and `right` its outer tips. A block counts when its frame is a whole
// number from 1, its size is two numbers above 0, every point lies inside that size (0..width by
// 0..height, the pitch's own rule in styleD3's measurePoints), and its points make a gable: left, peak
// and right run left to right and the peak stands above both tips (a smaller y).
//
// The frame is the one most reads used (ties to the lowest), and each tip is the median of those
// reads' own, x and y apart. Each read's points are taken as shares of its OWN size, so a read that
// gave a different size still lands in the same place; with one size on every read, the usual case,
// that is simply the median of their pixels, scaled to the frame. Null with no usable block.
export type OverhangZoomPlan = { frame: number; left: XY; right: XY };
export function overhangZoomPlan(blocks: readonly unknown[]): OverhangZoomPlan | null {
  const ok: { frame: number; left: XY; right: XY }[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object" || Array.isArray(b)) continue;
    const o = b as Record<string, unknown>;
    const frame = typeof o.frame === "number" && Number.isInteger(o.frame) && o.frame >= 1 ? o.frame : null;
    if (frame === null || !isXY(o.size) || !isXY(o.left) || !isXY(o.peak) || !isXY(o.right)) continue;
    const [w, h] = o.size, l = o.left, p = o.peak, r = o.right;
    if (!(w > 0 && h > 0)) continue;
    if ([l, p, r].some(([x, y]) => x < 0 || x > w || y < 0 || y > h)) continue;
    if (!(l[0] < p[0] && p[0] < r[0] && p[1] < l[1] && p[1] < r[1])) continue;
    ok.push({ frame, left: [l[0] / w, l[1] / h], right: [r[0] / w, r[1] / h] });
  }
  if (!ok.length) return null;
  const count = new Map<number, number>();
  for (const r of ok) count.set(r.frame, (count.get(r.frame) ?? 0) + 1);
  const frame = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const same = ok.filter((r) => r.frame === frame);
  const at = (pick: (r: (typeof same)[number]) => XY): XY => [median(same.map((r) => pick(r)[0])), median(same.map((r) => pick(r)[1]))];
  return { frame, left: at((r) => r.left), right: at((r) => r.right) };
}

// The two windows in the frame's own pixels, for a frame `actual` in size: a sixth of it each way,
// each centred on its tip and moved inside the frame (closeUpWindow, the step's rule). `tipL` and
// `tipR` are the tips in the frame's pixels, for the record.
export type OverhangWindows = { left: CloseUpWindow; right: CloseUpWindow; tipL: XY; tipR: XY };
export function overhangZoomWindows(plan: OverhangZoomPlan, actual: XY): OverhangWindows {
  const tipL: XY = [plan.left[0] * actual[0], plan.left[1] * actual[1]];
  const tipR: XY = [plan.right[0] * actual[0], plan.right[1] * actual[1]];
  return {
    left: closeUpWindow(tipL, actual, OVERHANG_ZOOM),
    right: closeUpWindow(tipR, actual, OVERHANG_ZOOM),
    tipL, tipR,
  };
}

// ── THE GABLE'S WIDTH ─────────────────────────────────────────────────────────────────────────────
// The wall corners the close-ups find are the gable's width apart, so that width is the ruler. It is
// the width the RENDERER draws the gable at (d3RoofAxes and d3Massing in StructureStudio.jsx):
//   * the span: the front wall's width when roof.front is "gable", the depth when it is "eave", and
//     without a front the old rule's, the width when the depth is at least the width;
//   * less the wings, when the drawing has any: wingSide "both" (or none given) is both eave sides,
//     a named side only when it IS an eave side ("left"/"right" on a gable front, "front"/"back" on
//     an eave front), each wing wingWidthFt wide (at most 16), and never so wide that the centre
//     keeps under 4 ft; a wing of half a foot or less is not drawn.
// So the raised-centre house, 37 ft wide with 11.5 ft wings on both sides, is a 14 ft gable, and the
// cabin 14 ft. `wings` says whether the gable is a centre section's, for the prompt. Null on anything
// but a gable, or without a real width and depth, and NULL BESIDE A LEAN-TO (leanToWidthFt over half a
// foot, the renderer's own test): the renderer draws it outside the footprint off an eave side, so the
// gable-end frame shows the roof running on past one wall, a tip or a corner may land on the lean-to's
// end, and this ruler knows nothing of it (a good 1 ft eave beside an 8 ft lean-to on a 12 ft gable
// would read about 0.6). None of the probed buildings had one; the roof step's close-up refuses them too.
export function overhangGableWidthFt(roof: Record<string, unknown> | null | undefined, widthFt: number, lengthFt: number): { gableFt: number; wings: boolean } | null {
  if (!roof || roof.type !== "gable") return null;
  if (Number(roof.leanToWidthFt) > 0.5) return null;
  if (!(Number.isFinite(widthFt) && widthFt > 0 && Number.isFinite(lengthFt) && lengthFt > 0)) return null;
  const front = roof.front === "gable" || roof.front === "eave" ? roof.front : null;
  const acrossWidth = front ? front === "gable" : lengthFt >= widthFt;
  const span = acrossWidth ? widthFt : lengthFt;
  const want = Math.min(16, Number(roof.wingWidthFt) || 0);
  if (!(want > 0.5)) return { gableFt: span, wings: false };
  const side = typeof roof.wingSide === "string" ? roof.wingSide : "both";
  const eaveSides = acrossWidth ? ["left", "right"] : ["front", "back"];
  const count = side === "both" ? 2 : eaveSides.includes(side) ? 1 : 0;
  const w = count ? Math.min(want, (span - 4) / count) : 0;
  if (!(w > 0.5)) return { gableFt: span, wings: false };
  return { gableFt: span - count * w, wings: true };
}

// ── THE QUESTION ──────────────────────────────────────────────────────────────────────────────────
// The probe's prompt v4, word for word (built with explicit line breaks, so the model is sent the
// same text whatever line endings this file is checked out with). `wings` adds the sentence about the
// centre section, only when the gable is one; `w` and `h` are each close-up's size.
const OVERHANG_WING_SENTENCE = " This building has lower side wings: the gable is the taller CENTRE section's, so the wall you want is the centre section's own wall where it rises above the wing roof, and the roof edge is the centre roof's, never the lower wing roof's edge.";
export function overhangZoomPrompt(wings: boolean, w: number, h: number): string {
  return [
    `These two images are close-ups, each enlarged ${OVERHANG_ZOOM} times, cut from ONE photo of a portable building taken square-on, or nearly, to one of its gable ends (the end wall under the triangle of the roof's two slopes). The FIRST shows the gable's LEFT eave corner and the SECOND its RIGHT eave corner: where the roof's sloping edge (the rake) comes down to the eave, beside the top of the wall under it. The rest of the gable end lies between them, to the right of the first and to the left of the second.${wings ? OVERHANG_WING_SENTENCE : ""}`,
    "",
    `In EACH close-up find two places and give each as [x, y] in that close-up's own pixels (x counts to the RIGHT and y DOWN from its top-left corner; each close-up is ${Math.round(w)} pixels wide and ${Math.round(h)} tall):`,
    "1. roofEdge: the end of the roof at this corner, its outermost part (the leftmost in the LEFT close-up, the rightmost in the RIGHT one): the outer face of the fascia or rake board where the roof's end drops down at the corner, taken at the bottom of that board. Use the board's own face, not the thin metal drip edge that may jut a little past it along the top. If the eave along the building's side also shows, running away from the camera, stop at its near end: the end is at the gable end, never further back along the side.",
    "2. wallFace: the corner of the GABLE-END wall (the wall facing the camera, under the gable's triangle) at the very top of that wall, where it meets the underside of the roof: the wall's outside face there, or the outer edge of its corner trim. When the photo is a little off square, the building's side wall also shows beside that corner as a narrow strip running away from the camera, and the eave along that side shows beyond it as a sloping band that ends at the rake tip. Then the corner you want is where the gable-end wall's flat face ends and that strip begins, the corner nearer the middle of the gable: never the far edge of the side-wall strip, and never the edge of the side eave's fascia, which is part of the roof. If this end of the building is an open porch under the main roof, with a post at the corner, use that post's outer face instead. The boxed end of the eave (a flat board closing the eave's end, below the fascia) is part of the roof, not the wall. Never a shadow, a bracket under the eave, a lower roof, or anything behind the building.",
    "",
    'Reply with only a JSON object: {"left": {"roofEdge": [x, y], "wallFace": [x, y], "wallFaceIs": "wall corner" | "porch post" | "not in view"}, "right": { the same three keys }, "why": "<one short sentence>"}',
  ].join("\n");
}

// ── ONE ANSWER, IN FEET ───────────────────────────────────────────────────────────────────────────
// The first {...} in the reply (the model sometimes fences it). Each point goes back to the frame's
// pixels, X = the window's x + the close-up's x / OVERHANG_ZOOM, and then, with the two wall corners
// `span` apart and the gable `gableFt` wide:
//     left  = (left wall X - left roof X) / span x gableFt
//     right = (right roof X - right wall X) / span x gableFt
// and the answer is their mean. REJECTED, with the reason, when: it does not parse or a point is
// missing, or lies outside its close-up; either wallFaceIs is "not in view"; the span is not above 0;
// a roof end sits on the frame's border (the left one within 1 px of x 0, the right within 2 px of
// its width: the corner is cut off by the frame); either side is INSIDE THE WALL; or the answer is
// LOPSIDED (both above). Those last two keep both sides for the record.
export type OverhangAsk =
  | { ft: number; left: number; right: number }
  | { why: "unparsed" | "no point" | "not in view" | "no span" | "at the border" | "inside the wall" | "lopsided"; left?: number; right?: number };
const r3 = (n: number) => Math.round(n * 1000) / 1000;
export function overhangAskFeet(text: string | null, wins: Pick<OverhangWindows, "left" | "right">, frameW: number, gableFt: number): OverhangAsk {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return { why: "unparsed" };
  let j: Record<string, unknown>;
  try { j = JSON.parse(m[0]); } catch { return { why: "unparsed" }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { why: "unparsed" };
  const side = (k: "left" | "right") => {
    const s = j[k];
    if (!s || typeof s !== "object" || Array.isArray(s)) return null;
    const o = s as Record<string, unknown>;
    const win = wins[k], cw = win.w * OVERHANG_ZOOM, ch = win.h * OVERHANG_ZOOM;
    const inside = (p: unknown): p is XY => isXY(p) && p[0] >= 0 && p[0] <= cw && p[1] >= 0 && p[1] <= ch;
    if (!inside(o.roofEdge) || !inside(o.wallFace)) return null;
    return { roof: win.x + o.roofEdge[0] / OVERHANG_ZOOM, wall: win.x + o.wallFace[0] / OVERHANG_ZOOM, seen: o.wallFaceIs !== "not in view" };
  };
  const L = side("left"), R = side("right");
  if (!L || !R) return { why: "no point" };
  if (!L.seen || !R.seen) return { why: "not in view" };
  const span = R.wall - L.wall;
  if (!(span > 0)) return { why: "no span" };
  if (L.roof <= 1 || R.roof >= frameW - 2) return { why: "at the border" };
  const left = (L.wall - L.roof) / span * gableFt, right = (R.roof - R.wall) / span * gableFt;
  const big = Math.max(left, right), small = Math.min(left, right);
  if (small < -OVERHANG_INSIDE_MAX_FT) return { why: "inside the wall", left: r3(left), right: r3(right) };
  if (big >= OVERHANG_LOPSIDED_MIN_FT && small < OVERHANG_LOPSIDED_RATIO * big) return { why: "lopsided", left: r3(left), right: r3(right) };
  return { ft: (left + right) / 2, left: r3(left), right: r3(right) };
}

// The answers together: with at least OVERHANG_ZOOM_MIN_KEPT kept, the median of their feet, rounded
// to the nearest inch and held to 0..3 ft; otherwise null, which keeps the consensus's overhang.
export function overhangZoomVerdict(texts: readonly (string | null)[], wins: Pick<OverhangWindows, "left" | "right">, frameW: number, gableFt: number): { overhangFt: number | null; asks: OverhangAsk[]; kept: number } {
  const asks = texts.map((t) => overhangAskFeet(t, wins, frameW, gableFt));
  const feet = asks.flatMap((a) => ("ft" in a ? [a.ft] : []));
  if (feet.length < OVERHANG_ZOOM_MIN_KEPT) return { overhangFt: null, asks, kept: feet.length };
  const inches = Math.round(median(feet) * 12);
  return { overhangFt: Math.min(OVERHANG_MAX_FT, Math.max(0, inches / 12)), asks, kept: feet.length };
}

// ── THE WHOLE CLOSE-UP, for the v2 draft (portal-settings) ───────────────────────────────────────
// Plan the cut from the reads' blocks, fetch that frame, cut and enlarge both corners, ask
// OVERHANG_ZOOM_ASKS times in parallel and judge. `overhangFt` is the new roof.overhang in feet, or
// null to keep the consensus's. `record` is what draft_tokens.overhangZoom keeps: the frame, the tips
// in its pixels, the gable's width, the overhang before and after, each ask's two sides in feet (or
// why it was dropped), how many were used, the time and the tokens; null when no close-up was tried
// (not a gable, a lean-to, no usable points, no such frame, or under OVERHANG_ZOOM_MIN_LEFT_MS of the
// draft's budget left). `input` and `output` are the asks' tokens. Never throws, and never holds the
// draft past its signal: a fetch, cut or ask the signal cut short is recorded as the error.
export async function runOverhangZoom(o: {
  blocks: readonly unknown[];
  photoUrls: readonly string[];
  roof: Record<string, unknown>;
  widthFt: number;
  lengthFt: number;
  leftMs: number;
  apiKey: string;
  model: Record<string, unknown>;
  signal: AbortSignal;
  fetchFn?: typeof fetch;
}): Promise<{ overhangFt: number | null; record: Record<string, unknown> | null; input: number; output: number }> {
  const f = o.fetchFn ?? fetch;
  const plan = overhangZoomPlan(o.blocks);
  const gable = overhangGableWidthFt(o.roof, o.widthFt, o.lengthFt);
  const frameUrl = plan ? o.photoUrls[plan.frame - 1] : undefined;
  if (!plan || !gable || !frameUrl || o.leftMs < OVERHANG_ZOOM_MIN_LEFT_MS) return { overhangFt: null, record: null, input: 0, output: 0 };
  const t0 = Date.now();
  const before = typeof o.roof.overhang === "number" && Number.isFinite(o.roof.overhang) ? o.roof.overhang : null;
  const record: Record<string, unknown> = { frame: plan.frame, gableFt: r3(gable.gableFt), before };
  let input = 0, output = 0, overhangFt: number | null = null;
  try {
    const cut = await cutCloseUps(await fetchFrame(f, frameUrl, o.signal), (actual) => {
      const w = overhangZoomWindows(plan, actual);
      return [w.left, w.right];
    }, OVERHANG_ZOOM, o.signal);
    // The same windows again, from the frame's real size: pure, so they are the ones just cut.
    const placed = overhangZoomWindows(plan, cut.frame);
    const [cl, cr] = cut.closeUps;
    record.tips = { left: placed.tipL.map((v) => Math.round(v)), right: placed.tipR.map((v) => Math.round(v)) };
    const callMs = Math.min(OVERHANG_ZOOM_CALL_MS, o.leftMs - 5_000 - (Date.now() - t0));
    const asks = await askCloseUps({
      f, apiKey: o.apiKey, model: o.model, maxTokens: OVERHANG_ZOOM_MAX_TOKENS, images: [cl.base64, cr.base64],
      prompt: overhangZoomPrompt(gable.wings, cl.width, cl.height), asks: OVERHANG_ZOOM_ASKS, callMs, signal: o.signal,
    });
    [input, output] = closeUpUsage(asks);
    record.usage = { input, output };
    const verdict = overhangZoomVerdict(asks.map((a) => a.text), placed, cut.frame[0], gable.gableFt);
    record.asks = verdict.asks.map((a) => ("ft" in a ? { ...a, ft: r3(a.ft) } : a));
    record.used = verdict.kept;
    overhangFt = verdict.overhangFt;
  } catch (e) {
    record.error = String(e instanceof Error ? e.message : e).slice(0, 160);
  }
  record.after = overhangFt;
  record.ms = Date.now() - t0;
  return { overhangFt, record, input, output };
}
