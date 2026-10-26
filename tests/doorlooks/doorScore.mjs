// doorScore.mjs — how close did a generated door look come to the real door? (Door looks from a
// photo, plan of 2026-10-24, section 9; phase P7.)
//
// One verdict per section 9 bar, plus the per-field table it is built from. No dependencies, no
// network, nothing live. Node 24 (it imports the P1 spec module, a .ts file, by type stripping).
//
//   node tests/doorlooks/doorScore.mjs --corpus <dir> --runs <runs.jsonl | dir> [--set holdout] [--source catalog] [--json]
//
// The corpus (photos and the hand-made `<id>.truth.json` files) lives OUTSIDE this repo, which is
// public: builders' catalog photos and their names never come in here. tests/doorlooks/doorSim.mjs is
// the runner that puts runs in front of this file; it imports scoreCorpus and formatReport rather than
// reimplementing them, so every number anyone quotes comes from one place.
//
// ─── WHAT A RUN IS ────────────────────────────────────────────────────────────────────────────────
// One Generate press on one photo, as the ledger (ai_door_calls) will record it once P4 exists:
//   { case, run, outcome: "draft" | "refused" | "failed",
//     spec,                 the FINAL spec (after the self-check), for a draft
//     preCheck?,            the spec before the self-check, to count what the check made better or worse
//     refuse?: {code, reason?}, error?,
//     warnings: [{code, text} | "code"], sideFrom?: "hinges"|"brace"|"handle"|"latch"|"default"|"given",
//     vocabGaps?: [phrase], ms?, costCents?,
//     skipped?: {leanRetryClock?, selfCheckClock?, ceiling?}, edgeF1?, rayMisses? }
//
// ─── THE THREE THINGS THIS GETS RIGHT THAT A NAIVE DIFF DOES NOT ─────────────────────────────────
// 1. IT SCORES WHAT IS DRAWN, NOT WHAT IS STORED. An absent key means "today's rule" (the spec's own
//    contract, doorLook.ts), so a truth that leaves the frame to the rule and a run that writes 3.5 in
//    are the same door. drawnDoorLook resolves both sides through the renderer's rules, read off the
//    designer twins (DOOR_RENDER_RULES, which doorScore.test.mjs greps for in both twins), and through
//    the row's real size: the leaf a look is drawn on is the CATALOG ROW's, single or double.
// 2. A BAR IT CANNOT SCORE IS "na", NEVER A PASS. A missing size ("needs size"), a field the truth
//    marks unscored (the photo cannot say), a hinge position when the counts already differ: each is
//    counted and shown, and a bar with nothing scored says "no data", not "pass".
// 3. ONE PHOTO CAN HAVE TWO RIGHT ANSWERS. A 9-lite steel door is a lite PART over one panel, or a
//    lock rail with a lite FILL above it; the vocabulary allows both. A truth file lists the second
//    in `alts` (whole specs) or `accept` (other values one field may take), and a run is scored
//    against whichever it is closer to. The truth files say why, for Ahsan's sign-off.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanDoorLook, DOOR_LOOK_BASE_DEFAULTS, DOOR_PLANK_FAMILY } from "../../supabase/functions/_shared/doorLook.ts";

// ─── renderer mirrors ─────────────────────────────────────────────────────────────────────────────
// Today's rules, copied from the designer twins (StructureStudio.jsx and structure-studio.component.js).
// If the renderer moves, these move: doorScore.test.mjs fails when a needle is no longer in BOTH twins
// (P2 replaces the hinge code with doorHardware and will have to re-anchor these).
export const DOOR_RENDER_RULES = [
  { name: "TRIM_F", needle: "return Math.min(0.29, w * 0.16, h * 0.09);" },
  { name: "TRIM_MID", needle: "mid = h * 0.42;" },
  { name: "TRIM_SILL", needle: "SS_TRIM_DOOR_SILL_FT = 0.2," },
  { name: "TRIM_STRAP", needle: "const sLen = Math.min(w * 0.3, 0.85);" },
  { name: "TRIM_HINGES", needle: "(h >= 5 ? [y0 + F / 2, midY, hTop] : [y0 + F / 2, hTop])" },
  { name: "PLANK_F", needle: "const F = Math.min(0.3, w * 0.16, h * 0.09);" },
  { name: "PLANK_MID", needle: "const midY = y0 + h * 0.55, midH = Math.min(0.26, h * 0.06);" },
  { name: "PLANK_STRAP", needle: "const sLen = Math.min(w * 0.5, 1.15);" },
  { name: "PLANK_HINGES", needle: "(h >= 5 ? [y0 + h * 0.13, midY, hTop(0.13)] : [y0 + h * 0.18, hTop(0.18)])" },
  { name: "STRAP_START", needle: "iron(0.11 + sLen * 0.55, 0.11 + sLen," },
  { name: "LEAF_X", needle: '[[o.a0 + 0.05, o.a - 0.03, "a0", false], [o.a + 0.03, o.a1 - 0.05, "a1", true]]' },
  { name: "LEAF_Y", needle: "const y0d = o.y0 + 0.05, y1d = o.y1 - 0.05;" },
];
const FT = 12;
const TRIM_SILL_FT = 0.2;
const PLANK_HINGES = { 2: [0.18, 0.82], 3: [0.13, 0.55, 0.87] }; // h < 5 ft hangs 2, else 3
// The plan's caps on what a spec asks for (section 3): the frame is never wider than 20% of the leaf's
// width or 12% of its height, and a strap is drawn at most 0.7 of the leaf's width.
const FRAME_CAP_W = 0.2, FRAME_CAP_H = 0.12, STRAP_CAP_W = 0.7;

const isTrim = (base) => !DOOR_PLANK_FAMILY.includes(base);
const isRec = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// One leaf of a door of this catalog size, in feet, as the renderer cuts it: 0.05 ft off each jamb and
// 0.03 ft either side of a double's centre; a trim look stands on its 0.2 ft threshold, a plank leaf
// 0.05 ft off the floor, both 0.05 ft under the head. null without a size.
export function doorLeafFt(sizeIn, leaves, base) {
  if (!Array.isArray(sizeIn) || !(sizeIn[0] > 0) || !(sizeIn[1] > 0)) return null;
  const dw = sizeIn[0] / FT, dh = sizeIn[1] / FT;
  return { w: leaves === 2 ? dw / 2 - 0.08 : dw - 0.1, h: isTrim(base) ? dh - 0.05 - TRIM_SILL_FT : dh - 0.1 };
}

// Today's hinge positions "on the rails": the bottom rail's centre, the mid rails, the top rail's
// centre. Two hinges take the outer two, three add the mid rail nearest half way, four add the next;
// a count the rails cannot seat is spread evenly between the outer two.
function railHinges(count, rails, fFt, hFt) {
  if (!count) return [];
  const lo = fFt / 2 / hFt, hi = 1 - lo;
  if (count === 1) return [0.5];
  const mids = [...rails].sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5)).slice(0, count - 2);
  if (mids.length === count - 2) return [lo, ...mids, hi].sort((a, b) => a - b);
  return Array.from({ length: count }, (_, i) => lo + ((hi - lo) * i) / (count - 1));
}

// What a cleaned spec DRAWS on a catalog row of this size and leaf count: every key resolved through
// today's rule when the spec leaves it out. Inch values are null when they need the size and it is not
// known; so are hinge positions "on the rails".
export function drawnDoorLook(spec, { sizeIn = null, leaves = null } = {}) {
  const base = spec.base, trim = isTrim(base), def = DOOR_LOOK_BASE_DEFAULTS[base];
  const rowLeaves = leaves ?? spec.src.leaves;
  const leaf = doorLeafFt(sizeIn, rowLeaves, base);
  const frame = isRec(spec.frame) ? spec.frame : {};
  const ruleF = leaf ? Math.min(trim ? 0.29 : 0.3, leaf.w * 0.16, leaf.h * 0.09) * FT : null;
  const fIn = num(frame.fIn) !== null ? (leaf ? Math.min(frame.fIn, leaf.w * FT * FRAME_CAP_W, leaf.h * FT * FRAME_CAP_H) : frame.fIn) : ruleF;
  const railHIn = num(frame.railHIn) !== null
    ? (leaf ? Math.min(frame.railHIn, leaf.h * FT * FRAME_CAP_H) : frame.railHIn)
    : trim ? fIn : leaf ? Math.min(0.26, leaf.h * 0.06) * FT : null;
  const rails = Array.isArray(frame.rails) ? [...frame.rails] : [...def.rails];
  const own = Array.isArray(spec.panels) ? spec.panels : [];
  const panels = Array.from({ length: rails.length + 1 }, (_, i) => {
    const p = isRec(own[i]) ? own[i] : { fill: def.panels[i] ?? "none" };
    return p.fill === "z" ? { ...p, zFrom: p.zFrom ?? "hinge" } : { ...p };
  });
  const braceT = (isRec(spec.brace) && spec.brace.t) || def.brace;
  const h = isRec(spec.hinges) ? spec.hinges : {};
  const type = h.type ?? "tstrap";
  const count = num(h.count) ?? (leaf ? (leaf.h >= 5 ? 3 : 2) : null);
  let at = null;
  if (count === 0) at = [];
  else if (Array.isArray(h.at)) at = [...h.at].sort((a, b) => a - b);
  else if (count !== null && (h.at === "rails" || (h.at === undefined && trim))) {
    at = leaf && fIn !== null ? railHinges(count, rails, fIn / FT, leaf.h) : null;
  } else if (count !== null) {
    at = PLANK_HINGES[count] ?? Array.from({ length: count }, (_, i) => (count === 1 ? 0.5 : 0.13 + (0.74 * i) / (count - 1)));
  }
  let lenIn = null;
  if (count !== 0 && type !== "hidden") {
    if (num(h.lenIn) !== null) lenIn = leaf ? Math.min(h.lenIn, leaf.w * FT * STRAP_CAP_W) : h.lenIn;
    else if (leaf) lenIn = (0.11 + (trim ? Math.min(leaf.w * 0.3, 0.85) : Math.min(leaf.w * 0.5, 1.15))) * FT;
  }
  const handle = isRec(spec.handle) ? spec.handle : {};
  const meet = isRec(spec.meet) ? spec.meet : {};
  const colors = isRec(spec.colors) ? spec.colors : {};
  const frameRole = colors.frame ?? "trim";
  return {
    leaves: spec.src.leaves,
    base,
    hinge: spec.src.hinge,
    fIn,
    railHIn,
    rails: rails.sort((a, b) => a - b),
    fieldDir: (isRec(spec.field) && spec.field.dir) || (trim ? "grooved" : "v"),
    brace: { t: braceT, from: braceT === "z" ? (spec.brace?.from ?? "hinge") : null },
    panels,
    parts: Array.isArray(spec.parts) ? spec.parts : [],
    hinges: { type, count, at, lenIn, finish: h.finish ?? "black" },
    handle: { type: handle.type ?? "barn", v: handle.v ?? "rail" },
    meet: rowLeaves === 2 ? { type: meet.type ?? "astragal", wIn: meet.wIn ?? 1.5 } : null,
    colors: { infill: colors.infill ?? "door", frame: frameRole, members: colors.members ?? frameRole },
  };
}

// ─── THE BARS (section 9) ─────────────────────────────────────────────────────────────────────────
// kind "rate": the share of scored rows that pass must reach `min`. The plan gives no share for the
// numeric bars ("within +/-5%"), so they are read literally: every scored value (min 1).
// kind "max": a total (or a single worst value) must not pass `max`. kind "f1": parts.
export const DOOR_SCORE_BARS = [
  { key: "leaves", label: "Leaves", kind: "rate", min: 1 },
  { key: "base", label: "Base", kind: "rate", min: 0.95 },
  { key: "hingeSide", label: "Hinge side", kind: "rate", min: 0.95 },
  { key: "sideGuessNoWarn", label: "Hinge side guessed with no warning", kind: "max", max: 0 },
  { key: "hingeCount", label: "Hinge count", kind: "rate", min: 0.95 },
  { key: "hingeType", label: "Hinge type", kind: "rate", min: 0.85 },
  { key: "hingeNoWarn", label: "Hinge type or count wrong with no warning", kind: "max", max: 0 },
  { key: "hingeAt", label: "Hinge positions (+/-5% of leaf height)", kind: "rate", min: 1, tol: 0.05 },
  { key: "hingeLen", label: "Hinge length (+/-2 in)", kind: "rate", min: 1, tol: 2 },
  { key: "rails", label: "Rails (+/-4% of leaf height)", kind: "rate", min: 1, tol: 0.04 },
  { key: "frame", label: "Frame width (+/-1 in)", kind: "rate", min: 1, tol: 1 },
  { key: "braceDir", label: "Brace direction", kind: "rate", min: 0.95 },
  { key: "panelFills", label: "Panel fills (and the leaf brace)", kind: "rate", min: 0.9 },
  { key: "parts", label: "Parts F1", kind: "f1", min: 0.8 },
  { key: "handleMeet", label: "Handle type, meet", kind: "rate", min: 0.9 },
  { key: "colorRoles", label: "Colour roles", kind: "rate", min: 0.9 },
  { key: "refusals", label: "Refusal set refused with the right code", kind: "rate", min: 1 },
  { key: "goodRefused", label: "Good photos refused", kind: "share", max: 0.05 },
  { key: "edgeF1", label: "Edge-map F1 at or above the photo's bar", kind: "rate", min: 1 },
  { key: "timeP50", label: "Time per press, p50 (ms)", kind: "max", max: 6 * 60_000 },
  { key: "timeMax", label: "Time per press, worst (ms)", kind: "max", max: 8 * 60_000 },
  { key: "costMax", label: "Cost per press, worst (cents)", kind: "max", max: 300 },
  { key: "rayMisses", label: "See-through rays", kind: "max", max: 0 },
  { key: "vocabGaps", label: "Vocabulary-gap rows", kind: "max", max: 0 },
];
const BAR = Object.fromEntries(DOOR_SCORE_BARS.map((b) => [b.key, b]));

// The warnings (doorLook.ts DOOR_WARNINGS, plus base_split / leaves_typed / stageb_part) that tell the
// builder to check a field. A field that is wrong with none of these is "wrong with no warning".
export const DOOR_WARNING_COVERS = {
  "src.leaves": ["leaves_typed"],
  base: ["base_split"],
  "src.hinge": ["hinge_side_brace", "hinge_side_handle", "hinge_side_default", "latch_leaf_default"],
  "hinges.count": ["hinge_count_split"],
  "hinges.type": ["hinge_type_split", "closeup_hinges"],
  "handle.type": ["closeup_handle"],
  "meet.type": ["closeup_meet"],
  "brace.t": ["base_split"],
  "brace.from": ["base_split", "hinge_side_brace"],
  "panels.fill": ["base_split"],
  "panels.zFrom": ["base_split"],
  parts: ["stageb_part"],
};
const SIDE_GUESSES = ["brace", "handle", "latch", "default"];
const coverKey = (path) => path.replace(/\[\d+\]/g, "");

// ─── PARTS ────────────────────────────────────────────────────────────────────────────────────────
// One part matched to another as doorLook.ts's consensus matches them (samePart): the same type, boxes
// overlapping by more than half (IoU), boards with both ends within 0.08 either way round, split lines
// within 0.04. Kept in step with doorLook.ts by hand: it does not export samePart.
const box = (p) => [p.u0 ?? 0, p.v0 ?? 0, p.u1 ?? 0, p.v1 ?? 0];
function iou(a, b) {
  const [a0, b0, a1, b1] = box(a), [c0, d0, c1, d1] = box(b);
  const iw = Math.max(0, Math.min(a1, c1) - Math.max(a0, c0)), ih = Math.max(0, Math.min(b1, d1) - Math.max(b0, d0));
  const inter = iw * ih, union = (a1 - a0) * (b1 - b0) + (c1 - c0) * (d1 - d0) - inter;
  return union > 0 ? inter / union : 0;
}
export function samePart(a, b) {
  if (a.t !== b.t) return false;
  if (a.t === "split") return Math.abs((a.v ?? 0) - (b.v ?? 0)) <= 0.04 + 1e-9;
  if (a.t === "board") {
    const near = (u, v, s, w) => Math.abs(u - s) <= 0.08 + 1e-9 && Math.abs(v - w) <= 0.08 + 1e-9;
    const [u0, v0, u1, v1] = box(a), [s0, w0, s1, w1] = box(b);
    return (near(u0, v0, s0, w0) && near(u1, v1, s1, w1)) || (near(u0, v0, s1, w1) && near(u1, v1, s0, w0));
  }
  return iou(a, b) > 0.5;
}
export function matchParts(truth, got) {
  const free = got.map(() => true);
  let tp = 0;
  for (const t of truth) {
    const j = got.findIndex((g, k) => free[k] && samePart(t, g));
    if (j >= 0) [free[j], tp] = [false, tp + 1];
  }
  return { tp, fn: truth.length - tp, fp: got.length - tp };
}

// ─── ONE RUN AGAINST ONE TRUTH SPEC ───────────────────────────────────────────────────────────────
const pass = (path, bar, truth, got) => ({ path, bar, truth, got, status: "pass" });
const fail = (path, bar, truth, got, why) => ({ path, bar, truth, got, status: "fail", ...(why ? { why } : {}) });
const na = (path, bar, truth, got, why) => ({ path, bar, truth, got, status: "na", why });
const near = (a, b, tol) => Math.abs(a - b) <= tol + 1e-9;

function exact(path, bar, t, g, accept) {
  return t === g || (accept?.[path] ?? []).includes(g) ? pass(path, bar, t, g) : fail(path, bar, t, g);
}
function numeric(path, bar, t, g, tol) {
  if (t === null || g === null) return na(path, bar, t, g, "needs size");
  return near(t, g, tol) ? pass(path, bar, t, g) : fail(path, bar, t, g, `off by ${Math.abs(t - g).toFixed(3)}`);
}
function list(path, bar, t, g, tol) {
  if (t === null || g === null) return na(path, bar, t, g, "needs size");
  if (t.length !== g.length) return fail(path, bar, t, g, `${g.length} not ${t.length}`);
  const worst = Math.max(0, ...t.map((x, i) => Math.abs(x - g[i])));
  return worst <= tol + 1e-9 ? pass(path, bar, t, g) : fail(path, bar, t, g, `off by ${worst.toFixed(3)}`);
}

// Every row for one draft against one truth spec. `truthCase` gives the row's size and leaves, what the
// photo cannot say (`unscored`) and the other values a field may take (`accept`).
export function scoreSpec(truthCase, truthSpec, gotSpec) {
  const opts = { sizeIn: truthCase.sizeIn ?? null, leaves: truthCase.leaves ?? truthSpec.src.leaves };
  const T = drawnDoorLook(truthSpec, opts), G = drawnDoorLook(gotSpec, opts);
  const acc = truthCase.accept ?? {};
  const rows = [];
  const add = (r) => rows.push(r);
  add(exact("src.leaves", "leaves", T.leaves, G.leaves, acc));
  add(exact("base", "base", T.base, G.base, acc));
  add(exact("src.hinge", "hingeSide", T.hinge, G.hinge, acc));
  // A count left to today's rule needs the leaf's height (3 hinges from 5 ft up).
  const sized = T.hinges.count !== null && G.hinges.count !== null;
  add(sized ? exact("hinges.count", "hingeCount", T.hinges.count, G.hinges.count, acc) : na("hinges.count", "hingeCount", T.hinges.count, G.hinges.count, "needs size"));
  add(exact("hinges.type", "hingeType", T.hinges.type, G.hinges.type, acc));
  const none = sized && (!T.hinges.count || !G.hinges.count);
  if (!sized) add(na("hinges.at", "hingeAt", T.hinges.at, G.hinges.at, "needs size"));
  else if (none) add(na("hinges.at", "hingeAt", T.hinges.at, G.hinges.at, "no hinges to place"));
  else if (T.hinges.count !== G.hinges.count) add(na("hinges.at", "hingeAt", T.hinges.at, G.hinges.at, "hinge count differs (scored there)"));
  else add(list("hinges.at", "hingeAt", T.hinges.at, G.hinges.at, BAR.hingeAt.tol));
  if (none || T.hinges.type === "hidden" || G.hinges.type === "hidden") add(na("hinges.lenIn", "hingeLen", T.hinges.lenIn, G.hinges.lenIn, "no visible hinges"));
  else add(numeric("hinges.lenIn", "hingeLen", T.hinges.lenIn, G.hinges.lenIn, BAR.hingeLen.tol));
  add(list("frame.rails", "rails", T.rails, G.rails, BAR.rails.tol));
  add(numeric("frame.fIn", "frame", T.fIn, G.fIn, BAR.frame.tol));
  add(numeric("frame.railHIn", "frame", T.railHIn, G.railHIn, BAR.frame.tol));
  add(exact("brace.t", "panelFills", T.brace.t, G.brace.t, acc));
  if (T.brace.t === "z") add(exact("brace.from", "braceDir", T.brace.from, G.brace.from, acc));
  T.panels.forEach((p, i) => {
    const g = G.panels[i];
    add(exact(`panels[${i}].fill`, "panelFills", p.fill, g?.fill ?? null, acc));
    if (p.fill === "z") add(exact(`panels[${i}].zFrom`, "braceDir", p.zFrom, g?.fill === "z" ? g.zFrom : null, acc));
  });
  const m = matchParts(T.parts, G.parts);
  const partRow = m.fp || m.fn ? fail("parts", "parts", T.parts.length, G.parts.length, `${m.fn} missed, ${m.fp} extra`) : pass("parts", "parts", T.parts.length, G.parts.length);
  if (T.parts.length || G.parts.length) add({ ...partRow, ...m });
  add(exact("handle.type", "handleMeet", T.handle.type, G.handle.type, acc));
  if (T.meet) add(exact("meet.type", "handleMeet", T.meet.type, G.meet.type, acc));
  for (const k of ["infill", "frame", "members"]) add(exact(`colors.${k}`, "colorRoles", T.colors[k], G.colors[k], acc));
  // Reported, with no bar of their own.
  add({ ...exact("field.dir", null, T.fieldDir, G.fieldDir, acc), bar: null });
  add({ ...exact("hinges.finish", null, T.hinges.finish, G.hinges.finish, acc), bar: null });
  add({ ...exact("handle.v", null, T.handle.v, G.handle.v, acc), bar: null });

  // What the photo cannot say is not scored, whatever the run answered.
  const un = truthCase.unscored ?? {};
  return rows.map((r) => {
    const key = Object.keys(un).find((k) => r.path === k || r.path.startsWith(`${k}.`) || r.path.startsWith(`${k}[`));
    return key ? { ...r, status: "na", why: `unscored: ${un[key]}` } : r;
  });
}

// The truth spec (or alt) this run is closest to: the most passes, then the fewest fails, then the first.
function bestOf(truthCase, gotSpec) {
  const specs = [truthCase.spec, ...(truthCase.alts ?? [])];
  let best = null;
  specs.forEach((s, i) => {
    const rows = scoreSpec(truthCase, s, gotSpec);
    const p = rows.filter((r) => r.bar && r.status === "pass").length, f = rows.filter((r) => r.bar && r.status === "fail").length;
    if (!best || p > best.p || (p === best.p && f < best.f)) best = { rows, p, f, matched: i === 0 ? "spec" : `alts[${i - 1}]` };
  });
  return best;
}

const warnCodes = (run) => new Set((run.warnings ?? []).map((w) => (typeof w === "string" ? w : w?.code)).filter(Boolean));

// A run's spec as the pipeline would hand it on: cleaned by P1's cleaner, or null when it cannot be.
function cleanRunSpec(spec) {
  const r = cleanDoorLook(spec);
  return r.ok ? r.spec : null;
}

// One run, scored. Field rows only for a draft of a photo that should be drafted.
export function scoreRun(truthCase, run) {
  const out = { case: truthCase.id, run: run.run ?? null, outcome: run.outcome, rows: [], notes: [] };
  const warned = warnCodes(run);
  if (truthCase.expect === "refuse") {
    const ok = run.outcome === "refused" && run.refuse?.code === truthCase.refuse.code &&
      (!run.refuse?.reason || !truthCase.refuse.reason || run.refuse.reason === truthCase.refuse.reason);
    out.refusal = { want: truthCase.refuse, got: run.refuse ?? null, ok };
    return out;
  }
  if (run.outcome !== "draft") {
    out.goodRefused = run.outcome === "refused";
    return out;
  }
  const spec = cleanRunSpec(run.spec);
  if (!spec) {
    out.outcome = "failed";
    out.notes.push("spec_invalid: the run's spec does not clean");
    return out;
  }
  const best = bestOf(truthCase, spec);
  out.matched = best.matched;
  out.rows = best.rows.map((r) => {
    if (r.status !== "fail") return r;
    const covers = DOOR_WARNING_COVERS[coverKey(r.path)] ?? [];
    return { ...r, warned: covers.some((c) => warned.has(c)) };
  });
  // A side the run did not read off hinge points is a guess, and a guess must warn. Without the run's
  // own sideFrom, a photo whose hinges do not show (hingesVisible false) makes any side a guess.
  const guessed = run.sideFrom ? SIDE_GUESSES.includes(run.sideFrom) : truthCase.hingesVisible === false;
  out.sideGuessNoWarn = guessed && !DOOR_WARNING_COVERS["src.hinge"].some((c) => warned.has(c));
  if (run.preCheck) {
    const pre = cleanRunSpec(run.preCheck);
    if (pre) {
      const before = new Map(bestOf(truthCase, pre).rows.map((r) => [r.path, r.status]));
      out.selfCheck = { better: [], worse: [] };
      for (const r of out.rows) {
        const b = before.get(r.path);
        if (b === "fail" && r.status === "pass") out.selfCheck.better.push(r.path);
        if (b === "pass" && r.status === "fail") out.selfCheck.worse.push(r.path);
      }
    }
  }
  return out;
}

// ─── FLIPS ACROSS RUNS ────────────────────────────────────────────────────────────────────────────
// Each photo runs 3 times. A field flips when its drawn answer differs between runs: a choice that
// changes, a number whose spread passes its bar's tolerance, a list whose length changes or whose
// spread does, parts that do not match one to one. The outcome itself flips too (drafted once, refused
// once).
function flipped(values, tol) {
  const xs = values.filter((v) => v !== undefined);
  if (xs.length < 2) return false;
  if (xs.every((x) => typeof x === "number")) return Math.max(...xs) - Math.min(...xs) > (tol ?? 0) + 1e-9;
  if (xs.every(Array.isArray)) {
    if (new Set(xs.map((x) => x.length)).size > 1) return true;
    return xs[0].some((_, i) => flipped(xs.map((x) => x[i]), tol));
  }
  return new Set(xs.map((x) => JSON.stringify(x))).size > 1;
}
export function flipsOf(caseRuns) {
  const out = {};
  const mark = (path, did) => {
    out[path] ??= { flipped: 0, cases: 0 };
    out[path].cases += 1;
    if (did) out[path].flipped += 1;
  };
  for (const { truthCase, runs } of caseRuns) {
    if (runs.length < 2) continue;
    mark("outcome", flipped(runs.map((r) => r.outcome)));
    const drafts = runs.map((r) => (r.outcome === "draft" ? cleanRunSpec(r.spec) : null)).filter(Boolean);
    if (drafts.length < 2 || truthCase.expect !== "draft") continue;
    const opts = { sizeIn: truthCase.sizeIn ?? null, leaves: truthCase.leaves };
    const ds = drafts.map((s) => drawnDoorLook(s, opts));
    const tolOf = (bar) => BAR[bar]?.tol;
    mark("src.leaves", flipped(ds.map((d) => d.leaves)));
    mark("base", flipped(ds.map((d) => d.base)));
    mark("src.hinge", flipped(ds.map((d) => d.hinge)));
    mark("hinges.count", flipped(ds.map((d) => d.hinges.count)));
    mark("hinges.type", flipped(ds.map((d) => d.hinges.type)));
    mark("hinges.at", flipped(ds.map((d) => d.hinges.at ?? undefined), tolOf("hingeAt")));
    mark("hinges.lenIn", flipped(ds.map((d) => d.hinges.lenIn ?? undefined), tolOf("hingeLen")));
    mark("frame.rails", flipped(ds.map((d) => d.rails), tolOf("rails")));
    mark("frame.fIn", flipped(ds.map((d) => d.fIn ?? undefined), tolOf("frame")));
    mark("brace", flipped(ds.map((d) => d.brace)));
    mark("panels.fill", flipped(ds.map((d) => d.panels.map((p) => p.fill))));
    mark("parts", ds.some((d, i) => i > 0 && (() => {
      const m = matchParts(ds[0].parts, d.parts);
      return m.fp > 0 || m.fn > 0;
    })()));
    mark("handle.type", flipped(ds.map((d) => d.handle.type)));
    if (ds[0].meet) mark("meet.type", flipped(ds.map((d) => d.meet?.type)));
    mark("colors", flipped(ds.map((d) => d.colors)));
  }
  return out;
}

// ─── THE CORPUS ───────────────────────────────────────────────────────────────────────────────────
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Every bar's verdict over a set of truth cases and their runs. `filter` narrows the cases
// ({set: "holdout"}, {source: "catalog"}).
export function scoreCorpus(truthCases, runs, { filter = {} } = {}) {
  const cases = truthCases.filter((c) => Object.entries(filter).every(([k, v]) => v == null || c[k] === v));
  const byCase = new Map(cases.map((c) => [c.id, { truthCase: c, runs: [] }]));
  const unknown = [];
  for (const r of runs) {
    if (byCase.has(r.case)) byCase.get(r.case).runs.push(r);
    else if (!truthCases.some((c) => c.id === r.case)) unknown.push(r.case);
  }
  const scored = [...byCase.values()].flatMap(({ truthCase, runs }) => runs.map((r) => ({ truthCase, run: r, s: scoreRun(truthCase, r) })));
  const rows = scored.flatMap((x) => x.s.rows.map((row) => ({ ...row, case: x.truthCase.id, run: x.run.run ?? null })));

  const tally = (bar) => {
    const rs = rows.filter((r) => r.bar === bar);
    return { pass: rs.filter((r) => r.status === "pass").length, fail: rs.filter((r) => r.status === "fail").length, na: rs.filter((r) => r.status === "na").length };
  };
  const result = [];
  const verdictMin = (value, min) => (value === null ? null : value >= min - 1e-9);
  const verdictMax = (value, max) => (value === null ? null : value <= max + 1e-9);
  for (const b of DOOR_SCORE_BARS) {
    let value = null, n = 0, detail = "";
    if (b.kind === "rate" && !["refusals", "edgeF1"].includes(b.key)) {
      const t = tally(b.key);
      n = t.pass + t.fail;
      value = n ? t.pass / n : null;
      detail = `${t.pass}/${n} pass${t.na ? `, ${t.na} not scored` : ""}`;
    } else if (b.key === "refusals") {
      const rs = scored.filter((x) => x.s.refusal);
      n = rs.length;
      value = n ? rs.filter((x) => x.s.refusal.ok).length / n : null;
      const bad = rs.filter((x) => !x.s.refusal.ok).map((x) => `${x.truthCase.id}#${x.run.run ?? "?"}:${x.run.outcome}${x.run.refuse?.code ? `/${x.run.refuse.code}` : ""}`);
      detail = `${n - bad.length}/${n} right${bad.length ? `; wrong: ${bad.join(", ")}` : ""}`;
    } else if (b.key === "goodRefused") {
      const good = scored.filter((x) => x.truthCase.expect === "draft");
      n = good.length;
      const k = good.filter((x) => x.s.goodRefused).length;
      value = n ? k / n : null;
      detail = `${k}/${n} good presses refused`;
    } else if (b.key === "edgeF1") {
      const rs = scored.filter((x) => num(x.run.edgeF1) !== null && num(x.truthCase.edgeF1Bar) !== null);
      n = rs.length;
      value = n ? rs.filter((x) => x.run.edgeF1 >= x.truthCase.edgeF1Bar - 1e-9).length / n : null;
      detail = n ? `${Math.round((value ?? 0) * n)}/${n} at or above the photo's bar` : "not measured (needs the studio renders, P2/P6)";
    } else if (b.key === "parts") {
      const rs = rows.filter((r) => r.bar === "parts" && r.status !== "na");
      const tp = rs.reduce((a, r) => a + r.tp, 0), fp = rs.reduce((a, r) => a + r.fp, 0), fn = rs.reduce((a, r) => a + r.fn, 0);
      n = rs.length;
      value = tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : null;
      detail = `${tp} matched, ${fn} missed, ${fp} extra over ${n} runs`;
    } else if (b.key === "sideGuessNoWarn" || b.key === "hingeNoWarn") {
      const drafts = scored.filter((x) => x.s.rows.length);
      n = drafts.length;
      const hits = b.key === "sideGuessNoWarn"
        ? drafts.filter((x) => x.s.sideGuessNoWarn).map((x) => `${x.truthCase.id}#${x.run.run ?? "?"}`)
        : rows.filter((r) => (r.path === "hinges.type" || r.path === "hinges.count") && r.status === "fail" && !r.warned).map((r) => `${r.case}#${r.run ?? "?"}:${r.path}`);
      value = n ? hits.length : null;
      detail = hits.length ? hits.join(", ") : n ? "none" : "";
    } else if (b.key === "timeP50" || b.key === "timeMax") {
      const ms = scored.map((x) => num(x.run.ms)).filter((v) => v !== null);
      n = ms.length;
      value = n ? (b.key === "timeP50" ? median(ms) : Math.max(...ms)) : null;
      if (b.key === "timeMax" && n) {
        const lost = scored.filter((x) => x.run.skipped?.leanRetryClock || x.run.skipped?.selfCheckClock).length;
        detail = `${lost}/${scored.length} presses lost a lean retry or a self-check round to the clock`;
      }
    } else if (b.key === "costMax") {
      const c = scored.map((x) => num(x.run.costCents)).filter((v) => v !== null);
      n = c.length;
      value = n ? Math.max(...c) : null;
      if (n) detail = `${scored.filter((x) => x.run.skipped?.ceiling).length}/${scored.length} presses had a call skipped by the $3.00 ceiling`;
    } else if (b.key === "rayMisses") {
      const v = scored.map((x) => num(x.run.rayMisses)).filter((v) => v !== null);
      n = v.length;
      value = n ? v.reduce((a, x) => a + x, 0) : null;
      if (!n) detail = "not measured here (harness block N, tests/harness/doorLooks.mjs)";
    } else if (b.key === "vocabGaps") {
      const drafted = scored.filter((x) => x.run.outcome === "draft");
      n = drafted.length;
      const gaps = drafted.flatMap((x) => (x.run.vocabGaps ?? []).map((g) => `${x.truthCase.id}: ${g}`));
      value = n ? gaps.length : null;
      detail = [...new Set(gaps)].join("; ");
    }
    const ok = b.kind === "rate" || b.kind === "f1" ? verdictMin(value, b.min) : verdictMax(value, b.max);
    result.push({ key: b.key, label: b.label, target: b.min ?? b.max, kind: b.kind, value, n, ok, detail });
  }

  // Wrong with no warning, every field (section 9 reports it per field).
  const noWarn = {};
  for (const r of rows.filter((r) => r.status === "fail" && r.bar)) {
    const k = coverKey(r.path);
    noWarn[k] ??= { wrong: 0, noWarning: 0 };
    noWarn[k].wrong += 1;
    if (!r.warned) noWarn[k].noWarning += 1;
  }
  const self = { runs: 0, better: {}, worse: {} };
  for (const x of scored.filter((x) => x.s.selfCheck)) {
    self.runs += 1;
    for (const p of x.s.selfCheck.better) self.better[p] = (self.better[p] ?? 0) + 1;
    for (const p of x.s.selfCheck.worse) self.worse[p] = (self.worse[p] ?? 0) + 1;
  }
  const needsSize = [...new Set(rows.filter((r) => r.status === "na" && r.why === "needs size").map((r) => r.case))];
  const perCase = [...byCase.values()].map(({ truthCase, runs }) => {
    const mine = scored.filter((x) => x.truthCase === truthCase);
    return {
      id: truthCase.id,
      set: truthCase.set,
      source: truthCase.source,
      expect: truthCase.expect,
      runs: runs.length,
      outcomes: mine.map((x) => x.s.outcome),
      matched: mine.map((x) => x.s.matched).filter(Boolean),
      fails: [...new Set(mine.flatMap((x) => x.s.rows.filter((r) => r.status === "fail" && r.bar).map((r) => r.path)))],
      refusalOk: truthCase.expect === "refuse" ? mine.every((x) => x.s.refusal?.ok) : null,
    };
  });
  const scoredBars = result.filter((b) => b.ok !== null);
  return {
    filter,
    cases: cases.length,
    runs: scored.length,
    bars: result,
    ok: scoredBars.length > 0 && scoredBars.every((b) => b.ok),
    noData: result.filter((b) => b.ok === null).map((b) => b.key),
    wrongNoWarning: noWarn,
    flips: flipsOf([...byCase.values()]),
    selfCheck: self,
    needsSize,
    unknownCases: [...new Set(unknown)],
    perCase,
    rows,
  };
}

// ─── PRINTING ─────────────────────────────────────────────────────────────────────────────────────
const fmt = (b) => {
  if (b.value === null) return "-";
  if (b.kind === "rate" || b.kind === "share") return `${(b.value * 100).toFixed(1)}%`;
  if (b.kind === "f1") return b.value.toFixed(3);
  return String(Math.round(b.value * 1000) / 1000);
};
const tgt = (b) => (b.kind === "rate" || b.kind === "f1" ? `>= ${b.kind === "f1" ? b.target : `${b.target * 100}%`}` : b.kind === "share" ? `<= ${b.target * 100}%` : `<= ${b.target}`);
export function formatReport(res, title = "Door looks score") {
  const lines = [];
  const f = Object.entries(res.filter).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(" ");
  lines.push(`${title}${f ? ` (${f})` : ""}: ${res.cases} photos, ${res.runs} runs. Verdict: ${res.ok ? "PASS" : "NOT PASSING"}${res.noData.length ? ` (no data: ${res.noData.join(", ")})` : ""}`);
  lines.push("");
  const w = Math.max(...res.bars.map((b) => b.label.length));
  for (const b of res.bars) {
    const v = b.ok === null ? "no data" : b.ok ? "pass" : "FAIL";
    lines.push(`  ${b.label.padEnd(w)}  ${fmt(b).padStart(9)}  ${tgt(b).padEnd(10)}  ${v.padEnd(7)}  ${b.detail}`);
  }
  const nw = Object.entries(res.wrongNoWarning);
  if (nw.length) {
    lines.push("", "Wrong, and how often with no warning:");
    for (const [k, v] of nw) lines.push(`  ${k}: ${v.wrong} wrong, ${v.noWarning} with no warning`);
  }
  const fl = Object.entries(res.flips).filter(([, v]) => v.flipped);
  lines.push("", fl.length ? "Flips across runs (photos whose answer changed between runs):" : "Flips across runs: none.");
  for (const [k, v] of fl) lines.push(`  ${k}: ${v.flipped}/${v.cases}`);
  if (res.selfCheck.runs) {
    lines.push("", `Self-check over ${res.selfCheck.runs} runs: made better ${JSON.stringify(res.selfCheck.better)}, made worse ${JSON.stringify(res.selfCheck.worse)}`);
  }
  if (res.needsSize.length) lines.push("", `Not scored until the size is known: ${res.needsSize.join(", ")}`);
  if (res.unknownCases.length) lines.push("", `Runs for cases with no truth file: ${res.unknownCases.join(", ")}`);
  lines.push("", "Per photo:");
  for (const c of res.perCase) {
    const what = c.expect === "refuse" ? (c.runs ? (c.refusalOk ? "refused right" : "NOT refused right") : "no runs") : c.fails.length ? `wrong: ${c.fails.join(", ")}` : c.runs ? "all scored fields right" : "no runs";
    lines.push(`  ${c.id.padEnd(10)} ${String(c.set).padEnd(8)} ${String(c.runs).padStart(2)} runs  ${what}${c.matched.some((m) => m !== "spec") ? `  (matched ${[...new Set(c.matched)].join("/")})` : ""}`);
  }
  return lines.join("\n");
}

// ─── LOADING ──────────────────────────────────────────────────────────────────────────────────────
// Truth files: every <id>.truth.json in the corpus folder.
export function loadTruth(dir) {
  return readdirSync(dir).filter((f) => f.endsWith(".truth.json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}
// Runs: a .jsonl file (one run a line), a .json file (an array), or a folder of either.
export function loadRuns(path) {
  if (statSync(path).isDirectory()) return readdirSync(path).filter((f) => /\.jsonl?$/.test(f)).sort().flatMap((f) => loadRuns(join(path, f)));
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".jsonl")) return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const v = JSON.parse(text);
  return Array.isArray(v) ? v : [v];
}

// What a truth file must hold before it can be scored against. Returns the problems, [] when none.
export function checkTruthCase(t) {
  const bad = [];
  if (!t || typeof t.id !== "string") return ["no id"];
  if (!t.status) bad.push(`${t.id}: no status (truth files stay "pending Ahsan's sign-off" until he signs them)`);
  if (t.leaves !== 1 && t.leaves !== 2) bad.push(`${t.id}: leaves must be 1 or 2`);
  if (t.sizeIn !== null && !(Array.isArray(t.sizeIn) && t.sizeIn.length === 2 && t.sizeIn.every((x) => x > 0))) bad.push(`${t.id}: sizeIn must be [w, h] inches or null`);
  if (t.expect === "refuse") {
    if (!["ai_door_refused", "ai_door_unsupported"].includes(t.refuse?.code)) bad.push(`${t.id}: refuse.code must be ai_door_refused or ai_door_unsupported`);
  } else if (t.expect === "draft") {
    for (const [i, s] of [t.spec, ...(t.alts ?? [])].entries()) {
      const r = cleanDoorLook(s);
      if (!r.ok) bad.push(`${t.id}: ${i ? `alts[${i - 1}]` : "spec"} does not clean (${r.error} at ${r.path})`);
      else if (r.dropped.length || r.clamped.length) bad.push(`${t.id}: ${i ? `alts[${i - 1}]` : "spec"} loses keys in the cleaner (${[...r.dropped, ...r.clamped].join(", ")})`);
      else if (r.spec.src.leaves !== t.leaves) bad.push(`${t.id}: the spec's leaves are not the photo's`);
    }
  } else bad.push(`${t.id}: expect must be "draft" or "refuse"`);
  return bad;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────────────────────
function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const corpus = arg(argv, "--corpus"), runsPath = arg(argv, "--runs");
  if (!corpus || !runsPath) {
    console.error("usage: node tests/doorlooks/doorScore.mjs --corpus <dir> --runs <runs.jsonl|dir> [--set tune|holdout|refuse] [--source video|catalog] [--json]");
    process.exit(2);
  }
  const truth = loadTruth(corpus);
  const problems = truth.flatMap(checkTruthCase);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  const res = scoreCorpus(truth, loadRuns(runsPath), { filter: { set: arg(argv, "--set"), source: arg(argv, "--source") } });
  if (argv.includes("--json")) console.log(JSON.stringify(res, null, 2));
  else console.log(formatReport(res));
  process.exitCode = res.ok ? 0 : 1;
}
