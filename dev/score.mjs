// score.mjs — how close did a generated d3 spec come to the real building?
//
// One number a person can argue with, plus the per-field table that number is built from.
// No dependencies, no network, nothing live. Node 18+.
//
//   node dev/score.mjs dev/score-corpus/lofted-barn-porch.json [...]
//   node dev/score.mjs dev/score-corpus/*.json --json > out.json
//
// The scoring ENGINE lives here. dev/score-generator.mjs is the runner that puts drafts in
// front of it — live generations, replayed ledger rows, or the runs pinned in the corpus —
// and it imports scoreRun and the table printers from this file rather than reimplementing
// them, so every number anyone quotes comes from one place.
//
// ─── THE THREE THINGS THIS GETS RIGHT THAT A NAIVE DIFF DOES NOT ────────────────────────
//
// 1. IT SCORES WHAT THE BUILDER ENDS UP LOOKING AT, NOT THE MODEL'S REPLY.
//    The browser's applyDraftedShape merges the draft OVER the style's current spec, so a
//    key the model omits does not mean "no value" — it means the builder's existing number
//    survives. Scoring the reply alone would call a silent omission a miss when the render
//    is right, and call it a pass when the render is stale. So every run is scored on
//    merge(prior, draft), and `prior` is a declared input, not an assumption.
//
//    ⚠️ The corollary is the reason the 2026-09-18 baseline needs care: those three runs
//    were fired at a style whose d3 had ALREADY been hand-corrected to the truth an hour
//    earlier. With prior == truth, every omission merges to the right answer and the score
//    flatters the model. Measure a generator the way a builder meets it: prior = a fresh
//    style. This file scores both and prints them side by side.
//
// 2. IT SCORES WHAT RENDERS, NOT WHAT IS STORED.
//    A spec that says "gambrel" with its two slopes two degrees apart DRAWS as a plain
//    gable — that is the defect that cost a day on 2026-09-16. So roof type is scored on a
//    derived `renders_as`, using the same arithmetic and the same `|| default` quirks as
//    gambrelRoofWarning in _shared/styleD3.ts. Keep the two in step — RENDERER_CONSTANTS
//    below is greppable, and dev/score-generator.mjs --preflight fails loudly on drift.
//
// 3. INERT FIELDS LEAVE THE DENOMINATOR.
//    `pitch` on a gambrel is never read by d3RoofProfile. `tailSpacingIn` on a fascia eave
//    is never drawn. `siding` is not even in VIDEO_SHAPE_PROMPT. Scoring those as misses
//    punishes the model for answers nobody sees; scoring them as passes inflates every
//    building with fewer features. They are dropped from both sides of the fraction and
//    reported separately, so a wasted answer is visible without being charged for.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

// ─── renderer mirrors ───────────────────────────────────────────────────────────────────
// Every constant below is copied from structure-studio.component.js (and one from
// _shared/styleD3.ts). If the renderer moves, these move. They are repeated rather than
// imported because that file is a 23k-line browser bundle and this script has to run
// anywhere — so `grep` is the only thing holding the copy to the original, and
// RENDERER_CONSTANTS carries the exact text to grep for. Nine constants, one list, one
// preflight: `node dev/score-generator.mjs --preflight`.
export const RENDERER_CONSTANTS = [
  { name: "OVERHANG", value: 0.6, file: "structure-studio.component.js", needle: "OVERHANG: 0.6," },
  { name: "WALL_H", value: 8, file: "structure-studio.component.js", needle: "(spec && spec.wallHeightFt) || 8" },
  { name: "KNEE_U", value: 0.55, file: "structure-studio.component.js", needle: "cfg.kneeU || 0.55" },
  { name: "KNEE_RISE", value: 0.55, file: "structure-studio.component.js", needle: "cfg.kneeRise || 0.55" },
  { name: "RIDGE_RISE", value: 0.8, file: "structure-studio.component.js", needle: "cfg.ridgeRise || 0.8" },
  { name: "PITCH_SHED", value: 0.25, file: "structure-studio.component.js", needle: "cfg.pitch || 0.25" },
  { name: "PITCH_PEAK", value: 0.4, file: "structure-studio.component.js", needle: "cfg.pitch || 0.4" },
  { name: "WOOD", value: "#C4965A", file: "structure-studio.component.js", needle: 'wood: "#C4965A",' },
  { name: "GAMBREL_MIN_BEND_DEG", value: 15, file: "supabase/functions/_shared/styleD3.ts", needle: "export const GAMBREL_MIN_BEND_DEG = 15;" },
];
const R = Object.fromEntries(RENDERER_CONSTANTS.map((c) => [c.name, c.value]));

// The sanitiser's own bands, from _shared/styleD3.ts CLAMPS. Used only to spot a value
// sitting exactly ON a bound — see clampEdges below for why that is the most a post-
// sanitise reply can tell us.
const CLAMPS = {
  pitch: [0, 2], ridgeOffset: [-0.35, 0.35], overhang: [0, 3],
  kneeU: [0, 1], kneeRise: [0, 1], ridgeRise: [0, 1.5], tailSpacingIn: [8, 96],
  leanToWidthFt: [0, 16], leanToDropFt: [0, 6],
  dormerWidthFt: [0, 12], dormerRiseFt: [0, 6], dormerOffsetU: [-1, 1],
  porchDepthFt: [0, 12], porchOutFt: [0, 12],
};
const WALL_CLAMP = [5, 14];   // styleD3.ts: min(14, max(5, wh)), after the 3..20 accept gate

const num = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const deg = (rad) => (rad * 180) / Math.PI;

// What the engine actually draws for this roof. Mirrors gambrelRoofWarning INCLUDING its
// `||` defaults: a stored 0 or an absent kneeU draws at 0.55, so it is judged at 0.55.
export function rendersAs(roof) {
  const r = roof || {};
  if (r.type !== "gambrel") return r.type === "shed" ? "shed" : "gable";
  const kneeU = Number(r.kneeU) || R.KNEE_U;
  const kneeRise = Number(r.kneeRise) || R.KNEE_RISE;
  const ridgeRise = Number(r.ridgeRise) || R.RIDGE_RISE;
  if (ridgeRise <= kneeRise) return "broken";     // ridge at or below the knee: inside-out
  const lower = deg(Math.atan2(kneeRise, 1 - kneeU));
  const upper = deg(Math.atan2(ridgeRise - kneeRise, kneeU));
  return lower - upper >= R.GAMBREL_MIN_BEND_DEG ? "gambrel" : "gable";
}

// One porch, one kind. Projecting wins, which is the sanitiser's own order.
export function porchKind(roof) {
  const r = roof || {};
  if ((num(r.porchOutFt) || 0) > 0.5) return "projecting";
  if ((num(r.porchDepthFt) || 0) > 0.5) return "recessed";
  return "none";
}

// ─── the merge the browser performs ─────────────────────────────────────────────────────
// Mirrors calDraftRoof + applyDraftedShape (the SHAPE path, which is what the video and
// combined sources use). Two things it deliberately does NOT do on that path, because the
// browser does not: it never applies `siding` (VIDEO_SHAPE_PROMPT does not ask, and
// sanitizeD3Spec always emits null, so applying it would wipe the builder's cladding), and
// it never applies a gableVent whose widthFrac is 0 or absent.
//
// THE TWO MERGES ARE DIFFERENT FUNCTIONS IN THE BROWSER AND THEY ARE DIFFERENT HERE.
// `video` and `combined` land in applyDraftedShape; `photos` lands in applyDraftedSpec.
// Scoring a photo run through the shape merge would credit it with a roofMaterial and a
// foundation the photo path never applies, and would drop the siding the photo path is the
// only one that DOES apply. Same reply, two different buildings on screen.
// The wing keys calDraftRoof clears as one set (the browser's CAL_WING_KEYS).
const WING_KEYS = ["wingSide", "wingWidthFt", "wingPitch", "centerEaveFt"];
export function mergeDraft(prior, draft, source = "video") {
  const p = prior || {}, d = draft || {};
  const dr = d.roof || {};

  if (source === "photos") {
    // applyDraftedSpec: a plain roof spread (NO porch-kind clearing — calDraftRoof is not on
    // this path), siding applied because SPEC_PROMPT asks for it, and gableVent / foundation /
    // roofMaterial untouched because SPEC_PROMPT never mentions them.
    return {
      roof: { ...(p.roof || {}), ...dr },
      colors: { ...(p.colors || {}), ...(d.colors || {}) },
      siding: d.siding !== undefined ? d.siding : (p.siding ?? null),
      wallHeightFt: d.wallHeightFt || p.wallHeightFt,
      gableVent: p.gableVent,
      foundation: p.foundation,
      roofMaterial: p.roofMaterial,
    };
  }

  // calDraftRoof's clearing rules, 2026-09-24 keys included: whatever the draft is the authority
  // on, it is the only source of. A reported porch brings its own attach height and width or
  // none; a recessed porch has neither. A draft that reports a roof type decides the wings (no
  // wingWidthFt over 0 = no wings) and the frame (roof.front / roof.highSide), so a stored one
  // cannot turn the scored building a quarter turn away from what the draft measured.
  const roof = { ...(p.roof || {}), ...dr };
  if ((dr.porchOutFt || 0) > 0.5) {
    delete roof.porchDepthFt; delete roof.porchTruss;
    if (!("porchAttachFt" in dr)) delete roof.porchAttachFt;
    if (!("porchWidthFt" in dr)) delete roof.porchWidthFt;
  } else if ((dr.porchDepthFt || 0) > 0.5) {
    delete roof.porchOutFt; delete roof.porchAttachFt; delete roof.porchWidthFt;
  }
  if (dr.type) {
    if (!((Number(dr.wingWidthFt) || 0) > 0)) {
      for (const k of WING_KEYS) delete roof[k];
    }
    if (!("front" in dr)) delete roof.front;
    if (!("highSide" in dr)) delete roof.highSide;
  }
  return {
    roof,
    colors: { ...(p.colors || {}), ...(d.colors || {}) },
    siding: p.siding ?? null,
    wallHeightFt: d.wallHeightFt || p.wallHeightFt,
    gableVent: (d.gableVent && d.gableVent.widthFrac > 0) ? d.gableVent : p.gableVent,
    foundation: (d.foundation === "skids" || d.foundation === "slab") ? d.foundation : p.foundation,
    roofMaterial: (d.roofMaterial === "shingle" || d.roofMaterial === "metal") ? d.roofMaterial : p.roofMaterial,
  };
}

// ─── colour distance ────────────────────────────────────────────────────────────────────
// sRGB -> Lab -> CIE76 delta-E. Not 2000: the extra hundred lines buy accuracy in a region
// (saturated blues) that shed paint does not live in, and a builder's complaint threshold is
// far coarser than the difference between the two formulas.
function hexToLab(hex) {
  const s = String(hex || "").trim().replace("#", "");
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const lin = (u) => { const c = u / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const r = lin(parseInt(full.slice(0, 2), 16)), g = lin(parseInt(full.slice(2, 4), 16)), b = lin(parseInt(full.slice(4, 6), 16));
  // sRGB D65 -> XYZ, then XYZ -> Lab against the D65 white point.
  const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const Y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.0;
  const Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function deltaE(a, b) {
  const la = hexToLab(a), lb = hexToLab(b);
  if (!la || !lb) return null;
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

// ─── the shape of a per-field score ─────────────────────────────────────────────────────
// A number field is scored on ABSOLUTE error in its own unit, with a deadband, not on
// relative error. Relative error on an overhang of 0.15 ft turns a 0.85 ft miss into 567%
// and swamps every other field; absolute error in feet is what a builder's eye measures.
//   |err| <= full  -> 1.0   (nobody would argue)
//   |err| >= zero  -> 0.0   (plainly the wrong building)
//   between        -> linear
const band = (err, full, zero) => {
  const e = Math.abs(err);
  if (e <= full) return 1;
  if (e >= zero) return 0;
  return 1 - (e - full) / (zero - full);
};

// THE SILENCE PENALTY. A key the model never returned cannot score better than half of what
// the same number would score if it had been stated.
//
// Why a penalty at all, when the merge already scores the value the builder ends up with:
// a STATED wrong number lands in the panel, moves a control, and is visible to review. An
// ABSENT key leaves a stale value with no signal that it was never read — which is exactly
// how a projecting porch went missing three times out of three with the prompt paragraph
// live. Silent wrongness costs more support than loud wrongness, so it scores worse.
//
// Not applied when the merged value is RIGHT: if the builder's existing number is already
// the truth, the render is correct and the builder does nothing. Punishing that would be
// scoring the reply rather than the building.
const SILENCE = 0.5;

// ─── the field table ────────────────────────────────────────────────────────────────────
// `w` is the visual weight. `live` decides whether this field is scoreable for THIS truth;
// a false `live` drops the field from both the numerator and the denominator.
// `stated` decides whether the model's own reply carried the key.
const G = { SHAPE: "shape", PORCH: "porch", EAVE: "eave", LOOK: "look" };

const roofOf = (s) => (s && s.roof) || {};
const hasProjecting = (t) => porchKind(roofOf(t)) === "projecting";

const FIELDS = [
  // ── A. silhouette: what makes it the wrong building from the road ────────────────────
  {
    id: "roof.renders_as", group: G.SHAPE, w: 18, kind: "cat",
    note: "the roof the engine DRAWS, not the roof the spec claims",
    get: (s) => rendersAs(roofOf(s)),
    stated: (d) => roofOf(d).type != null,
  },
  { id: "roof.kneeU",     group: G.SHAPE, w: 5, kind: "num", full: 0.03, zero: 0.20,
    live: (t) => roofOf(t).type === "gambrel",
    get: (s) => num(roofOf(s).kneeU) ?? R.KNEE_U, stated: (d) => roofOf(d).kneeU != null },
  { id: "roof.kneeRise",  group: G.SHAPE, w: 5, kind: "num", full: 0.03, zero: 0.20,
    live: (t) => roofOf(t).type === "gambrel",
    get: (s) => num(roofOf(s).kneeRise) ?? R.KNEE_RISE, stated: (d) => roofOf(d).kneeRise != null },
  { id: "roof.ridgeRise", group: G.SHAPE, w: 5, kind: "num", full: 0.05, zero: 0.30,
    live: (t) => roofOf(t).type === "gambrel",
    get: (s) => num(roofOf(s).ridgeRise) ?? R.RIDGE_RISE, stated: (d) => roofOf(d).ridgeRise != null },
  // Inert on a gambrel: d3RoofProfile's gambrel branch never reads pitch. Reported anyway,
  // because a model spending an answer on an unread field is worth seeing.
  { id: "roof.pitch",     group: G.SHAPE, w: 10, kind: "num", full: 0.05, zero: 0.35,
    live: (t) => roofOf(t).type !== "gambrel",
    get: (s) => num(roofOf(s).pitch) ?? (roofOf(s).type === "shed" ? R.PITCH_SHED : R.PITCH_PEAK),
    stated: (d) => roofOf(d).pitch != null },
  { id: "roof.ridgeOffset", group: G.SHAPE, w: 4, kind: "num", full: 0.03, zero: 0.25,
    live: (t) => roofOf(t).type === "gable",
    get: (s) => num(roofOf(s).ridgeOffset) ?? 0, stated: (d) => roofOf(d).ridgeOffset != null },
  // WALL HEIGHT IS ASSERTED, NOT SCORED, THE DAY THE BUILDER TYPES IT.
  // `live` is false whenever the run declares `dims.wallHeightFt`, so the field leaves both
  // sides of the fraction and moves to the assertion block below. Leaving it scored would
  // report a fake improvement worth about 12 weighted points on a gambrel the moment the
  // dimensions card ships — an error of zero BY CONSTRUCTION is not a measurement of a
  // generator. See also `shape_no_wall`, which is the headline for any before/after that
  // straddles that change.
  { id: "wallHeightFt", group: G.SHAPE, w: 12, kind: "num", full: 0.25, zero: 2.0,
    owner: (ctx) => (ctx.dimsWall == null ? "model" : "given"),
    live: (t, ctx) => ctx.dimsWall == null,
    get: (s) => num(s.wallHeightFt) ?? R.WALL_H, stated: (d) => d.wallHeightFt != null },

  // ── B. porch: one block, because a porch of the wrong KIND is 100% wrong ─────────────
  // The kind carries most of the weight and the depth only counts once the kind matches.
  // Scoring depth against a mismatched kind would compare a recess to a projection, which
  // is not a smaller error, it is a different building.
  {
    id: "porch.kind", group: G.PORCH, w: 12, kind: "cat",
    get: (s) => porchKind(roofOf(s)),
    stated: (d) => roofOf(d).porchOutFt != null || roofOf(d).porchDepthFt != null,
  },
  {
    id: "porch.depthFt", group: G.PORCH, w: 6, kind: "num", full: 0.5, zero: 3.0,
    live: (t, ctx) => porchKind(roofOf(t)) !== "none" && ctx.kindMatches,
    get: (s) => {
      const r = roofOf(s);
      return porchKind(r) === "projecting" ? (num(r.porchOutFt) ?? 0) : (num(r.porchDepthFt) ?? 0);
    },
    stated: (d) => roofOf(d).porchOutFt != null || roofOf(d).porchDepthFt != null,
  },
  { id: "porch.end", group: G.PORCH, w: 2, kind: "cat",
    live: (t, ctx) => porchKind(roofOf(t)) !== "none" && ctx.kindMatches,
    get: (s) => roofOf(s).porchEnd || "front", stated: (d) => roofOf(d).porchEnd != null },
  // Only a recessed porch has a gable above it to fill; the sanitiser deletes the key on a
  // projecting one.
  { id: "roof.porchTruss", group: G.PORCH, w: 2, kind: "cat",
    live: (t, ctx) => porchKind(roofOf(t)) === "recessed" && ctx.kindMatches,
    get: (s) => (roofOf(s).porchTruss === true ? "yes" : "no"), stated: (d) => typeof roofOf(d).porchTruss === "boolean" },

  // ── C. eave and trim ─────────────────────────────────────────────────────────────────
  // AND THE EAVE, THE SAME WAY, THE DAY THE BUILDER PRESSES AN OVERHANG CHIP. Since the chip
  // shipped, `dims.overhangIn` is applied by applyKnownDims BEFORE sanitizeD3Spec, the prompt
  // is told not to touch it and applySelfCheck drops it from the allow-list -- so the number
  // in `drafted` is the builder's tape, not the model's answer, exactly as wall height is.
  // Scoring it credited the tape to the generator: on a --replay over rows with the chip
  // pressed, run 1 of the measured building went from MATCH 60 to 78.4 and hard.overhang
  // flipped to true on a reply that still said 1.0 ft. `live` false takes it out of the score,
  // out of `coverage` and out of `stated_only` (a builder's number read back is not the model
  // having answered), and the assertion below is what checks it instead.
  { id: "roof.overhang", group: G.EAVE, w: 6, kind: "num", full: 0.1, zero: 0.75,
    owner: (ctx) => (ctx.dimsEave == null ? "model" : "given"),
    live: (t, ctx) => ctx.dimsEave == null,
    get: (s) => num(roofOf(s).overhang) ?? R.OVERHANG, stated: (d) => roofOf(d).overhang != null },
  { id: "roof.eave", group: G.EAVE, w: 2, kind: "cat",
    get: (s) => (roofOf(s).eave === "open" ? "open" : "fascia"), stated: (d) => roofOf(d).eave != null },
  { id: "roof.tailSpacingIn", group: G.EAVE, w: 1, kind: "num", full: 2, zero: 16,
    live: (t) => roofOf(t).eave === "open",
    get: (s) => num(roofOf(s).tailSpacingIn) ?? 24, stated: (d) => roofOf(d).tailSpacingIn != null },
  { id: "roof.plateBand", group: G.EAVE, w: 2, kind: "cat",
    get: (s) => (roofOf(s).plateBand === true ? "yes" : "no"), stated: (d) => typeof roofOf(d).plateBand === "boolean" },

  // ── D. materials and colour ──────────────────────────────────────────────────────────
  { id: "roofMaterial", group: G.LOOK, w: 5, kind: "cat",
    get: (s) => s.roofMaterial || "unset", stated: (d) => d.roofMaterial != null },
  { id: "foundation", group: G.LOOK, w: 3, kind: "cat",
    get: (s) => s.foundation || "slab", stated: (d) => d.foundation != null },
  { id: "gableVent.widthFrac", group: G.LOOK, w: 2, kind: "num", full: 0.03, zero: 0.15,
    live: (t) => !!(t.gableVent && t.gableVent.widthFrac > 0),
    get: (s) => num(s.gableVent && s.gableVent.widthFrac) ?? 0,
    stated: (d) => !!(d.gableVent && d.gableVent.widthFrac > 0) },
  // NOT ASKED on the video/combined path: VIDEO_SHAPE_PROMPT dropped `siding` on 2026-08-25
  // on purpose, and applyDraftedShape never applies it. Live only when the corpus entry says
  // the run used the photo prompt.
  { id: "siding", group: G.LOOK, w: 4, kind: "cat",
    live: (t, ctx) => ctx.source === "photos",
    get: (s) => s.siding || "panel", stated: (d) => d.siding != null },
  { id: "colors.body", group: G.LOOK, w: 3, kind: "color", full: 6, zero: 30,
    get: (s) => (s.colors || {}).body, stated: (d) => !!(d.colors || {}).body },
  { id: "colors.trim", group: G.LOOK, w: 2, kind: "color", full: 6, zero: 30,
    get: (s) => (s.colors || {}).trim, stated: (d) => !!(d.colors || {}).trim },
  { id: "colors.roof", group: G.LOOK, w: 2, kind: "color", full: 6, zero: 30,
    get: (s) => (s.colors || {}).roof, stated: (d) => !!(d.colors || {}).roof },
  // Porch lumber. Only visible when there is a projecting porch to build out of it, and its
  // renderer fallback is a real colour rather than nothing, so an absent key can be right.
  { id: "colors.wood", group: G.LOOK, w: 2, kind: "color", full: 6, zero: 30,
    live: (t) => hasProjecting(t),
    get: (s) => (s.colors || {}).wood || R.WOOD, stated: (d) => !!(d.colors || {}).wood },
];

// PHANTOMS. Geometry the draft invents that the building does not have. No truth field
// covers it — the truth simply has no lean-to — so it is a flat deduction off the total
// rather than a weighted field. A generator told to "look harder" is exactly the kind of
// change that starts inventing dormers, and this is what catches it.
const PHANTOMS = [
  { id: "leanTo", w: 6, on: (s) => (num(roofOf(s).leanToWidthFt) || 0) > 0 },
  { id: "dormer", w: 6, on: (s) => (num(roofOf(s).dormerWidthFt) || 0) > 0 },
  { id: "porch",  w: 6, on: (s) => porchKind(roofOf(s)) !== "none" },
];

// ─── AGREEMENT: does the model's prose match its own numbers? ────────────────────────────
// `observed.porch` is the model saying in words what it saw; `roof.porchOutFt` /
// `roof.porchDepthFt` are the same claim as geometry. The 2026-09-17 run-2 case is the one
// this exists for: the notes said the door was "under the porch" and the roof reported no
// porch at all. That run is not a measurement problem — nothing it was asked was ambiguous —
// it is the reply contradicting itself, and no per-field error can see it.
//
// Reported, never folded into MATCH. It grades the REPLY, not the building, and mixing the
// two would let a self-consistent wrong answer outscore an inconsistent right one.
export function porchAgreement(draft, observed) {
  const o = observed || {};
  const said = String(o.porch || "").trim().toLowerCase();
  const kind = porchKind(roofOf(draft || {}));
  if (said) {
    if (!["projecting", "recessed", "none"].includes(said)) return "unparseable";
    if (said === "none") return kind === "none" ? "agrees" : "contradicts";
    return said === kind ? "agrees" : "contradicts";
  }
  // TRANSITIONAL, and it disappears the day `observed.porch` is mandatory. Until then the
  // only porch the model states in words is the one it mentions in passing — "under the
  // porch overhang" in `doors` — and that is exactly the 2026-09-17 run-2 case: the notes
  // put the door under a porch while the roof reported no porch at all. Scoring the history
  // without this reads that run as merely silent, when it is the reply contradicting itself.
  // A bare word match, on the model's own prose, for one word. Nothing else is inferred.
  const prose = ["roofNote", "doors", "eave", "windows", "vents"].map((k) => String(o[k] || "")).join(" ");
  if (!/\bporch\b/i.test(prose)) return kind === "none" ? "silent_both" : "not_answered";
  return kind === "none" ? "contradicts_prose" : "agrees_prose";
}

// ─── CLAMP EDGES: the trace a clamp leaves behind ───────────────────────────────────────
// ⚠️ READ THIS BEFORE QUOTING THE NUMBER. Everything this file ever sees — a live reply, a
// replayed `ai_style_calls.drafted`, a pinned corpus run — has ALREADY been through
// sanitizeD3Spec, so a clamped value is indistinguishable from a value that happened to be
// the bound. What is still visible is the FOOTPRINT: a number sitting exactly on a CLAMPS
// bound. That is what this counts, and it is an upper bound on clamping, not a count of it.
//
// It earns its place anyway. A generator that starts answering `overhang: 3` or
// `kneeRise: 1` is one whose numbers have left the range real buildings live in, and the
// count rising between two prompt versions is a signal worth chasing even when each
// individual hit is innocent.
export function clampEdges(draft) {
  const hits = [];
  const r = roofOf(draft || {});
  for (const [k, [lo, hi]] of Object.entries(CLAMPS)) {
    const v = num(r[k]);
    if (v === null) continue;
    if (v === lo) hits.push(`roof.${k}=${lo} (low bound)`);
    else if (v === hi) hits.push(`roof.${k}=${hi} (high bound)`);
  }
  const wh = num((draft || {}).wallHeightFt);
  if (wh !== null && (wh === WALL_CLAMP[0] || wh === WALL_CLAMP[1])) hits.push(`wallHeightFt=${wh} (bound)`);
  return hits;
}

// ─── scoring one run ────────────────────────────────────────────────────────────────────
// `dims` is what the BUILDER typed — the dimensions card's width, length and wall height.
// Its only effect here is to move wall height out of the score and into an assertion; the
// width and length are recorded so a run's provenance is complete, and nothing scores them
// (the renderer takes the size from the customer's pick, not from the style).
export function scoreRun({ truth, prior, draft, source = "video", dims = null, observed = null, provenance = "asserted" }) {
  const merged = mergeDraft(prior, draft, source);
  const dimsWall = dims && num(dims.wallHeightFt) !== null ? num(dims.wallHeightFt) : null;
  // IN FEET, because that is what the spec key holds and what the truth is stated in. The chip
  // is in inches and applyKnownDims divides by 12; comparing the two in different units is how
  // an assertion passes on a building whose eave is a foot out.
  const dimsEave = dims && num(dims.overhangIn) !== null ? num(dims.overhangIn) / 12 : null;
  const ctx = {
    source, dimsWall, dimsEave,
    kindMatches: porchKind(roofOf(truth)) === porchKind(roofOf(merged)),
  };

  const rows = [];
  for (const f of FIELDS) {
    const tv = f.get(truth);
    const mv = f.get(merged);
    const live = f.live ? !!f.live(truth, ctx) : true;
    const stated = f.stated ? !!f.stated(draft) : false;

    let raw = null, err = null;
    if (f.kind === "cat") raw = String(tv) === String(mv) ? 1 : 0;
    else if (f.kind === "color") {
      const de = deltaE(tv, mv);
      err = de;
      raw = de == null ? 0 : band(de, f.full, f.zero);
    } else {
      err = (num(mv) ?? 0) - (num(tv) ?? 0);
      raw = band(err, f.full, f.zero);
    }

    // The silence penalty, and the one case it does not apply: the merge already lands on
    // the right answer, so the building renders correctly and the builder does nothing.
    const silenced = !stated && raw < 1;
    const s = silenced ? raw * SILENCE : raw;

    rows.push({
      id: f.id, group: f.group, w: f.w, live, stated,
      owner: typeof f.owner === "function" ? f.owner(ctx) : (f.owner || "model"),
      truth: tv, got: mv, err, raw: round(raw), score: round(s), silenced,
      inert: !live,
    });
  }

  // Phantoms: asserted by the DRAFT, absent from the TRUTH.
  const phantoms = [];
  for (const p of PHANTOMS) {
    if (!p.on(truth) && p.on(mergeDraft({}, draft, source))) phantoms.push({ id: p.id, w: p.w });
  }
  const phantomPenalty = phantoms.reduce((a, p) => a + p.w, 0);

  const agg = (pred) => {
    const live = rows.filter((r) => r.live && pred(r));
    const den = live.reduce((a, r) => a + r.w, 0);
    const numr = live.reduce((a, r) => a + r.w * r.score, 0);
    return den ? round2(100 * numr / den) : null;
  };
  const aggStated = (pred) => {
    const live = rows.filter((r) => r.live && r.stated && pred(r));
    const den = live.reduce((a, r) => a + r.w, 0);
    const numr = live.reduce((a, r) => a + r.w * r.raw, 0);
    return den ? round2(100 * numr / den) : null;
  };

  const all = () => true;
  const match = Math.max(0, round2((agg(all) ?? 0) - phantomPenalty));
  const liveRows = rows.filter((r) => r.live);
  const coverage = liveRows.length
    ? round2(100 * liveRows.filter((r) => r.stated).reduce((a, r) => a + r.w, 0) / liveRows.reduce((a, r) => a + r.w, 0))
    : null;

  // THE WALL-HEIGHT ASSERTION. With dims live this is a yes/no about whether the number the
  // builder typed is the number that ended up on screen — the server writes it in before
  // sanitizeD3Spec, so the existing 5–14 clamp can still move it, and a clamped 30 landing
  // as 14 is exactly the failure this catches. Without dims there is nothing to assert and
  // the field is scored as before.
  const mergedWall = num(merged.wallHeightFt) ?? R.WALL_H;
  const wallAssert = dimsWall == null ? null : {
    typed: dimsWall, got: mergedWall, ok: Math.abs(mergedWall - dimsWall) < 1e-9,
    // ⚠️ AND AGAINST THE TAPE, because `ok` on its own is only plumbing. It says the number
    // that was typed is the number that ended up on screen, which a TYPO satisfies exactly as
    // well as a measurement: typed 13 on a 9 ft building gives ok:true, MATCH 100 and "wall
    // ASSERTED OK 13 vs 13" for a building four feet too tall. This is the half that knows.
    errVsTruth: round(mergedWall - (num(truth.wallHeightFt) ?? R.WALL_H)),
  };
  // THE EAVE ASSERTION, the same two halves. `ok` is plumbing -- did the inches the builder
  // pressed survive applyKnownDims, the sanitiser's 0..3 ft clamp and the self-check's
  // allow-list -- and errVsTruth is the half that knows whether the builder measured it right.
  // A chip pressed at 12 in on a building whose eave is 2 in gives ok:true and errVsTruth
  // +0.83, which is a wrong building nobody would otherwise be told about.
  const mergedEave = num((merged.roof || {}).overhang) ?? R.OVERHANG;
  const eaveAssert = dimsEave == null ? null : {
    typed: round(dimsEave), got: mergedEave, ok: Math.abs(mergedEave - dimsEave) < 1e-9,
    errVsTruth: round(mergedEave - (num(roofOf(truth).overhang) ?? R.OVERHANG)),
  };

  // The four fields that decide whether a builder would accept the model without touching
  // it. A run that misses any of them has failed however good the average looks.
  const wallRow = rows.find((r) => r.id === "wallHeightFt");
  const hard = {
    roof: rows.find((r) => r.id === "roof.renders_as").score === 1,
    porchKind: rows.find((r) => r.id === "porch.kind").score === 1,
    // ON A MEASURED TRUTH THE TAPE GATES TOO. Without this the +10 MATCH the dimensions card
    // buys cannot be told apart from a mistyped number, and bar 5 of the brief ("exactly 9.0
    // in 5/5") is unreachable through the instrument that is supposed to answer it — 9.0 is
    // the measurement, not "whatever was typed". Where the truth is an accepted draft or was
    // asserted from memory there is no tape to answer to, so the plumbing check is all there
    // is and errVsTruth is printed rather than enforced.
    wall: wallAssert
      ? (wallAssert.ok && (provenance !== "measured" || Math.abs(wallAssert.errVsTruth) <= 0.5))
      : Math.abs(wallRow.err) <= 0.5,
    // SAME RULE AS THE WALL. Read off the merged error, bar 4 ("roof.overhang <= 0.35 ft in
    // >=4/5") kept reporting itself satisfied on the builder's own chip value -- an error of
    // zero by construction, on the one field the whole prompt rewrite is judged by, with
    // nothing in the table to prompt a second look. Where the eave was GIVEN this asserts it
    // instead: the typed value has to survive, and on a measured truth it has to be right.
    overhang: eaveAssert
      ? (eaveAssert.ok && (provenance !== "measured" || Math.abs(eaveAssert.errVsTruth) <= 0.35))
      : Math.abs(rows.find((r) => r.id === "roof.overhang").err) <= 0.35,
  };
  const shape = agg((r) => r.group !== G.LOOK);
  // THE HEADLINE FOR ANY BEFORE/AFTER THAT STRADDLES THE DIMENSIONS CARD. Wall height is a
  // prediction before it and a given after it, so the same building's `shape` jumps for a
  // reason that has nothing to do with the generator. This number excludes it on BOTH sides
  // and is the only shape figure the two eras can be compared on.
  const shapeNoWall = agg((r) => r.group !== G.LOOK && r.id !== "wallHeightFt");
  // AND THE ONE THAT EXCLUDES BOTH BUILDER-OWNED FIELDS. shape_no_wall was enough while wall
  // height was the only number the builder typed; the overhang chip makes it two, and a
  // pre-chip run against a post-chip run compares a generator answering the eave with one
  // being handed it. This is the figure those two eras can be compared on. It equals
  // shape_no_wall whenever no chip was pressed.
  const shapeNoGiven = agg((r) => r.group !== G.LOOK && r.id !== "wallHeightFt" && r.id !== "roof.overhang");
  const pass = shape >= 85 && Object.values(hard).every(Boolean) && phantoms.length === 0;

  return {
    match, shape, shape_no_wall: shapeNoWall, shape_no_given: shapeNoGiven, look: agg((r) => r.group === G.LOOK),
    stated_only: aggStated(all), coverage,
    phantoms: phantoms.map((p) => p.id), phantomPenalty,
    agreement: porchAgreement(draft, observed), clamped: clampEdges(draft),
    wallAssert, eaveAssert, hard, pass, rows, merged,
  };
}

const round = (n) => (n == null ? null : Math.round(n * 1000) / 1000);
const round2 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// ─── the table ──────────────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const lpad = (s, n) => String(s).padStart(n);
const fmt = (v) => (v == null ? "-" : typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v));

// VARIANCE, BESIDE THE ERROR AND NEVER INSTEAD OF IT. A field that answers the same number
// in every run is either measured or defaulted, and the two look identical in a mean. Flat
// AND wrong is the signature of the prompt's old "use a typical value" instruction — wall
// height 7 in 3 of 3, overhang 1.0 in 3 of 3 — so that combination gets its own mark.
function spreadOf(results, i) {
  const vals = results.map((res) => res.rows[i]).filter((r) => r.live).map((r) => num(r.got));
  if (vals.length < 2 || vals.some((v) => v === null)) return null;
  return round(Math.max(...vals) - Math.min(...vals));
}

export function printBuilding({ file, entry, priorName, priorSpec, priorIndex, runs }) {
  const source = entry.source || "video";
  const provenance = entry.truth_provenance || "asserted";
  const results = runs.map((r) => scoreRun({
    truth: entry.truth, prior: priorSpec, draft: r.drafted,
    source: r.source || source, dims: r.dims || entry.dims || null, observed: r.observed || null,
    provenance,
  }));

  // ⚠️ PROVENANCE IS PART OF THE SCORE, so it is printed beside it.
  //   measured        a human read the number off a frame with a ruler, or off the tape
  //                   measure on site. The only kind that can gate a release.
  //   accepted-draft  the truth is a generation somebody eyeballed and saved. CIRCULAR: the
  //                   model is being graded against its own homework, and it will score in
  //                   the nineties whatever it does. Useful for spotting VARIANCE between
  //                   runs and nothing else.
  //   asserted        somebody typed it from memory. Weakest of the three.
  const prov = provenance;
  console.log("");
  console.log(`━━ ${entry.name || basename(file)}  ·  prior = ${priorName}  ·  ${runs.length} run(s)  ·  truth: ${prov}${prov === "measured" ? "" : "  ⚠️ NOT A GATE"}`);
  if (entry.note) console.log(`   ${entry.note}`);
  console.log("");

  // ⚠️ THE SECOND PASS, SCORED AGAINST THE SAME TRUTH. Acceptance bar 2 is "no run scores
  // below its own first pass", it is BLOCKING and it outranks the mean — because the measured
  // A/B says a check that corrects an already-good draft scores 70.5 against the 74.3 of not
  // checking at all. Nothing in dev/ could compute it: scoreRun took one draft, and the replay
  // select did not read the self-check columns. A run carries `after` when there is one; every
  // mode that has none prints nothing extra and the table is exactly as it was.
  const afterResults = runs.map((r) => (r.after
    ? scoreRun({
      truth: entry.truth, prior: priorSpec, draft: r.after,
      source: r.source || source, dims: r.dims || entry.dims || null, observed: r.observed || null,
      provenance,
    })
    : null));
  const checked = afterResults.filter(Boolean).length;
  const regressions = afterResults.filter((a, i) => a && a.match < results[i].match).length;

  const head = `${pad("field", 22)}${lpad("w", 3)}  ${pad("truth", 12)}${runs.map((r, i) => pad(r.label || `run ${i + 1}`, 22)).join("")}${lpad("spread", 8)}`;
  console.log(head);
  console.log("─".repeat(head.length));
  for (let i = 0; i < results[0].rows.length; i++) {
    const r0 = results[0].rows[i];
    const cells = results.map((res) => {
      const r = res.rows[i];
      if (!r.live) return pad(r.owner === "given" ? "· asserted" : "· inert", 22);
      const mark = r.score === 1 ? "OK " : r.score >= 0.6 ? "~  " : "X  ";
      // "inherited" and "silent" are the SAME event — the model returned nothing — shown
      // apart because one of them is currently rendering the right building and the other
      // is not. A reviewer needs to see both: an inherited pass is a pass the generator did
      // not earn, and it will stop passing on a style nobody has corrected yet.
      const tag = r.stated ? "" : (r.score === 1 ? " (inh)" : " (sil)");
      return pad(`${mark}${fmt(r.got)}${tag}`, 22);
    }).join("");
    const sp = spreadOf(results, i);
    const flatWrong = sp === 0 && results.every((res) => res.rows[i].live && res.rows[i].score < 1);
    console.log(`${pad(r0.id, 22)}${lpad(r0.w, 3)}  ${pad(fmt(r0.truth), 12)}${cells}${lpad(sp == null ? "-" : (flatWrong ? `${sp} flat!` : String(sp)), 8)}`);
  }
  console.log("─".repeat(head.length));
  const line = (label, pick) => console.log(`${pad(label, 22)}${lpad("", 3)}  ${pad("", 12)}${results.map((r, i) => pad(pick(r, i), 22)).join("")}`);
  line("MATCH /100", (r) => r.match);
  line("  shape", (r) => r.shape);
  line("  shape, no wall", (r) => r.shape_no_wall);
  // ALWAYS, because its whole job is to be quotable ACROSS tables. On a run where the eave
  // was given it equals shape_no_wall (the field is already out of the aggregate); on a run
  // from before the chip it is lower, and the difference between those two numbers is the
  // only honest way to read the two eras against each other.
  line("  shape, no given", (r) => r.shape_no_given);
  line("  look", (r) => r.look);
  line("  stated-only", (r) => r.stated_only);
  line("  coverage %", (r) => r.coverage);
  line("  porch agreement", (r) => r.agreement);
  line("  clamp edges", (r) => r.clamped.length);
  if (results.some((r) => r.eaveAssert)) {
    line("  eave ASSERTED", (r) => (r.eaveAssert
      ? `${r.eaveAssert.ok ? "OK" : "FAIL"} ${Math.round(r.eaveAssert.got * 12)}/${Math.round(r.eaveAssert.typed * 12)}in tape ${r.eaveAssert.errVsTruth > 0 ? "+" : ""}${r.eaveAssert.errVsTruth}`
      : "-"));
  }
  if (results.some((r) => r.wallAssert)) {
    // ⚠️ errVsTruth IS PRINTED, not merely recorded. It was computed here from the first
    // day with a comment saying it exists "so a builder typing the WRONG number is not read
    // as the feature working" — and then nothing read it: not the table, not hard.wall, not
    // pass. A reviewer looking at "wall ASSERTED OK 13 vs 13" beside "truth 9" six rows above
    // had to do the subtraction themselves.
    line("  wall ASSERTED", (r) => (r.wallAssert
      ? `${r.wallAssert.ok ? "OK" : "FAIL"} ${r.wallAssert.got} vs ${r.wallAssert.typed} tape ${r.wallAssert.errVsTruth > 0 ? "+" : ""}${r.wallAssert.errVsTruth}`
      : "-"));
  }
  line("PASS?", (r) => (r.pass ? "PASS" : "FAIL"));
  if (checked) {
    console.log("");
    line("AFTER THE CHECK", (r, i) => (afterResults[i] ? String(afterResults[i].match) : "· not checked"));
    line("  verdict", (r, i) => (runs[i].verdict || (afterResults[i] ? "corrections" : "·")));
    // The blocking comparison, per run, with its own word. A mean that improves while one run
    // went backwards is the exact shape variant G measured, and it is invisible in an average.
    line("  vs its first pass", (r, i) => {
      const a = afterResults[i];
      if (!a) return "-";
      const d = round2(a.match - r.match);
      return `${d > 0 ? "+" : ""}${d}${d < 0 ? "  REGRESSED" : ""}`;
    });
  }
  console.log("");
  // Per-run detail that does not fit a column. `wasted` is the answers the model spent on
  // fields nothing reads: free today (a gambrel's pitch changes no pixel) but they are prompt
  // weight and thinking tokens, and the day one stops being inert it is a silent wrong number.
  results.forEach((r, i) => {
    const missed = Object.entries(r.hard).filter(([, v]) => !v).map(([k]) => k);
    const wasted = r.rows.filter((x) => !x.live && x.stated && x.owner !== "given").map((x) => x.id.replace("roof.", ""));
    const silent = r.rows.filter((x) => x.live && !x.stated).map((x) => x.id.replace("roof.", ""));
    console.log(`   ${runs[i].label || "run " + (i + 1)}: ${r.pass ? "PASS" : "FAIL on " + (missed.join(", ") || "shape<85")}`
      + `${r.phantoms.length ? "  | phantom " + r.phantoms.join(",") : ""}`
      + `${/^contradicts/.test(r.agreement) ? "  | PORCH DISAGREES with its own notes" : ""}`
      + `${r.clamped.length ? "  | on a clamp bound: " + r.clamped.join(", ") : ""}`
      + `${silent.length ? "  | never answered: " + silent.join(", ") : ""}`
      + `${wasted.length ? "  | wasted: " + wasted.join(", ") : ""}`);
  });
  const mean = round2(results.reduce((a, r) => a + r.match, 0) / results.length);
  const worst = round2(Math.min(...results.map((r) => r.match)));
  console.log("");
  console.log(`   mean MATCH ${mean}   worst ${worst}   spread ${round2(Math.max(...results.map((r) => r.match)) - worst)}   passed ${results.filter((r) => r.pass).length}/${results.length}`);
  // `headline` marks the ONE reading per building that the footer is allowed to average:
  // the first declared prior, which every corpus entry declares as the fresh style. The
  // other priors are diagnostics — scoring the same runs twice and averaging both would
  // count each building once for every prior somebody happened to add.
  return {
    file, name: entry.name, prior: priorName, headline: priorIndex === 0, provenance: prov,
    gates: prov === "measured", mean, worst, results,
    checked, regressions, afterResults,
  };
}

// ─── THE HEADLINE ───────────────────────────────────────────────────────────────────────
// One number for the whole set, and it is built ONLY from the buildings whose truth was
// measured. A mean that quietly folds in an accepted-draft truth would rise every time
// somebody added another building the model graded itself on, which is the exact failure
// mode this footer exists to prevent. Non-gating rows are still printed — variance between
// runs is real information — they just do not move the number anybody quotes.
// The bar is stated as a MEDIAN over five runs ("median MATCH >= 85 and >= 3/5 PASS") and this
// printed a mean. On five runs those are different numbers, and the one anybody quotes has to
// be the one the bar is written in. The mean stays beside it — it is what every earlier run was
// recorded as, and dropping it would break the comparison this instrument exists for.
const medianOf = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return round2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};

export function printFooter(out) {
  if (!out.length) return null;
  const gating = out.filter((b) => b.gates && b.headline);
  console.log("");
  console.log("═".repeat(84));
  console.log(`${pad("building", 48)}  ${pad("prior", 14)}${lpad("mean", 7)}${lpad("worst", 7)}${lpad("pass", 6)}`);
  for (const b of out) {
    const p = b.results.filter((r) => r.pass).length;
    console.log(`${pad((b.gates ? "" : "· ") + (b.name || basename(b.file)), 48)}  ${pad(b.prior, 14)}${lpad(b.mean, 7)}${lpad(b.worst, 7)}${lpad(`${p}/${b.results.length}`, 6)}`);
  }
  console.log("═".repeat(84));
  let headline = null;
  if (gating.length) {
    const runs = gating.flatMap((b) => b.results);
    const mean = round2(runs.reduce((a, r) => a + r.match, 0) / runs.length);
    const median = medianOf(runs.map((r) => r.match));
    const worst = round2(Math.min(...runs.map((r) => r.match)));
    const passed = runs.filter((r) => r.pass).length;
    const checked = gating.reduce((a, b) => a + (b.checked || 0), 0);
    const regressions = gating.reduce((a, b) => a + (b.regressions || 0), 0);
    headline = { mean, median, worst, passed, total: runs.length, buildings: gating.length, checked, regressions };
    console.log(`GATING SCORE  ${median} median · ${mean} mean · ${worst} worst · ${passed}/${runs.length} runs would ship unedited`
      + `   (${gating.length} measured building${gating.length === 1 ? "" : "s"}, first-declared prior)`);
    // ⚠️ THE BLOCKING GATE, SAID OUT LOUD OR SAID TO BE MISSING. Bar 2 outranks the mean, so a
    // green table that never evaluated it is worse than a red one: it reads as the bar being
    // met. Either this instrument saw the second pass and can answer, or it says it could not.
    if (!checked) {
      console.log("   ⚠️ BAR 2 NOT MEASURED: no run in this table carried a self_check_after, so");
      console.log('      "no run scores below its own first pass" is unanswered. Only --replay over');
      console.log("      real portal generations can answer it; --recorded and a live pass cannot.");
    } else if (regressions) {
      console.log(`   ⛔ BLOCKING: ${regressions} of ${checked} checked run(s) scored BELOW their own first pass.`);
      console.log("      Bar 2 outranks the mean. One regression across five runs blocks the ship.");
    } else {
      console.log(`   ✓ bar 2: ${checked} checked run(s), none below its own first pass.`);
    }
  } else {
    console.log("GATING SCORE  none — no building in this set has a MEASURED truth, so nothing here gates a release.");
  }
  const indicative = out.filter((b) => !b.gates).length;
  if (indicative) console.log(`   · ${indicative} row(s) marked · are indicative only (truth is not measured) and are excluded from the number above.`);
  console.log("");
  return headline;
}

// Every corpus entry declares its priors. `fresh` is the honest one — what a builder meets
// on a style nobody has calibrated. Any other prior is a second reading, never the headline.
export function scoreEntry(file, entry, runs) {
  const priors = Object.entries(entry.priors || { "fresh style": {} });
  return priors.map(([priorName, priorSpec], i) =>
    printBuilding({ file, entry, priorName, priorSpec, priorIndex: i, runs }));
}

// ─── CLI ────────────────────────────────────────────────────────────────────────────────
// Only when this file IS the command. dev/score-generator.mjs imports it, and a module that
// scores its arguments on import would run the whole corpus twice.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const files = args.filter((a) => !a.startsWith("--"));
  if (!files.length) {
    console.error("usage: node dev/score.mjs dev/score-corpus/<building>.json [...] [--json]");
    process.exit(2);
  }
  const out = [];
  for (const file of files) {
    const entry = JSON.parse(readFileSync(file, "utf8"));
    out.push(...scoreEntry(file, entry, entry.runs || []));
  }
  printFooter(out);
  if (asJson) console.log(JSON.stringify(out, null, 1));
}
