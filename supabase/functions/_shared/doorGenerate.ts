// ─── DOOR LOOKS FROM A PHOTO: ONE GENERATE PRESS, FROM THE PHOTO TO A CLEANED DRAFT (2026-10-26) ─────
// Phase P4 of "door looks from a photo" (the plan of 2026-10-24, sections 4 and 8). Everything a press
// does between "the money is held" and "here is the draft": Stage A's three reads, the close-ups, the
// agreement check and Stage B, each bounded by the press's time and by the $3.00 ceiling. The money, the
// ledger and the gates are portal-settings' (portal-settings/doorGenerate.ts); this file never touches
// a database.
//
// PURE APART FROM `deps`: the model is called only through deps.fetch, the photo is cut only through
// deps.cut, the clock is deps.now. So the same code runs in the edge function (Deno), in the wiring
// tests with the model stubbed, in the local path where Claude Code stands in for the API
// (scripts/doorLookLocal.mjs runs doorDraftFromReads, below) and in the sim's live mode (Node). Only
// erasable TypeScript, and only relative imports of other pure modules, so Node can import it.
//
// ⚠️ THE MODEL ANSWERS IN POINTS; doorLook.ts DOES THE MATHS. Nothing here turns a point into a number:
// stageADoorLook, settleCloseUps and keepStageBParts (P1) are the maths, and they are the same functions
// whether the reads came from the API a moment ago or from a file a person saved.

import {
  cleanDoorLook,
  DOOR_LOOK_BASE_DEFAULTS,
  DOOR_REFUSALS,
  type DoorCloseUpAnswer,
  type DoorCloseUps,
  type DoorConsensus,
  type DoorLook,
  type DoorLookBase,
  doorLookFromMeasure,
  type DoorMeasureCtx,
  type DoorRefuseCode,
  type DoorWarning,
  keepStageBParts,
  settleCloseUps,
  stageADoorLook,
  type RGB,
  type XY,
} from "./doorLook.ts";
import {
  doorAnswerOf,
  type DoorCloseUpAsk,
  type DoorCloseUpKind,
  doorCloseUpPrompt,
  type DoorImageSource,
  DOOR_LOOK_PROMPT_ID,
  doorRequestBody,
  doorStageAPrompt,
  doorStageBPrompt,
} from "./doorLookPrompt.ts";
import {
  AI_MODEL_LIST_USD_PER_MTOK,
  AI_MODEL_V2,
  DRAFT_READ_RETRY,
  type DraftCall,
  draftUpstreamFailure,
  type DraftMoney,
  modelReplyText,
  runDraftCalls,
  streamedDraftBudgetMs,
} from "./styleD3.ts";
import { closeUpWindow, type CloseUpWindow } from "./closeUp.ts";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const API_URL = "https://api.anthropic.com/v1/messages";

// ─── THE PRESS'S TIME ─────────────────────────────────────────────────────────────────────────────
// ONE clock bounds a press: 8 minutes from its key's first ledger row, the lean retry, recovery and
// every self-check round included. No server call for the key is given more than what is left of it,
// less 15 s to answer, so every call has ended before the clock runs out.
export const DOOR_PRESS_CLOCK_MS = 480_000;
export const DOOR_ANSWER_MARGIN_MS = 15_000;
// A lean retry starts only with this much of the press clock left; otherwise the press ends with what
// it has (section 4, Retries).
export const DOOR_LEAN_MIN_LEFT_MS = 150_000;
// A self-check round (P5) is a 5 s render plus a 140 s wait: it starts only while one still fits.
export const DOOR_SELF_CHECK_ROUND_MS = 145_000;
// A ledger row younger than this still marked running is a generation in flight (step 5 and the recount).
export const DOOR_RUNNING_FRESH_MS = 6 * 60_000;
// Presses per rolling 24 hours when client_settings.ai_door_daily_cap is null; 0 there is unlimited.
export const DOOR_DEFAULT_DAILY_CAP = 10;
// A key owns its first try and one lean retry, never more (a third press under it is a 409).
export const DOOR_KEY_MAX_ROWS = 2;
// The press clock from its start: what is left for a server call, the answer's margin already taken.
export const doorPressLeftMs = (pressStartMs: number, nowMs: number) => pressStartMs + DOOR_PRESS_CLOCK_MS - DOOR_ANSWER_MARGIN_MS - nowMs;
// When a try's model work must end (epoch ms), from `t0`, the moment it starts: the building draft's own
// budget (streamed: streamedDraftBudgetMs, at most 300 s and 75 s before the worker's end; not streamed:
// 125 s inside the gateway's 150 s), and never past what is left of the press clock. A lean retry
// therefore gets only what is left of the 8 minutes.
export function doorWorkDeadline(x: { t0: number; requestStartMs: number; workerBornMs: number; streamed: boolean; pressStartMs: number }): number {
  const budget = x.streamed
    ? streamedDraftBudgetMs({ t0: x.t0, requestStartMs: x.requestStartMs, workerBornMs: x.workerBornMs })
    : Math.max(60_000, Math.min(125_000, 145_000 - (x.t0 - x.requestStartMs)));
  return x.t0 + Math.max(0, Math.min(budget, doorPressLeftMs(x.pressStartMs, x.t0)));
}

// ─── WHAT A PRESS MAY COST US: THE $3.00 CEILING (section 8) ──────────────────────────────────────
// Before each model call the server adds that call's WORST case (its max_tokens at the output price,
// plus its input) to the worst case of every call still running and to what the press has already
// recorded. A call that would take the total past $3.00 is skipped, and the step it belonged to falls
// back with a warning. Once a call answers, its reservation becomes what it really cost; a call whose
// cost cannot be known (a body that broke off, our own abort mid-reply) keeps its worst case.
export const DOOR_PRESS_CEILING_CENTS = 300;
const RATE = AI_MODEL_LIST_USD_PER_MTOK[AI_MODEL_V2];
// Cents, from tokens at the v2 model's list price ($4 / $20 per million). Our cost basis, never a price.
export const doorCostCents = (input: number, output: number) => Math.round((input * RATE.input + output * RATE.output) / 10_000 * 10_000) / 10_000;
// An image inside the photo limits (doorLookPrompt.ts) is at most about 1,600 tokens (width x height /
// 750); text at 3 characters a token is the generous side of the API's own count.
export const DOOR_IMAGE_TOKENS = 1600;
export const doorInputTokensEst = (text: string, images: number) => Math.ceil(text.length / 3) + images * DOOR_IMAGE_TOKENS + 64;
export const doorCallWorstCents = (maxTokens: number, inputTokens: number) => doorCostCents(inputTokens, maxTokens);

export class DoorCeiling {
  limitCents: number;
  spentCents: number;
  skipped = 0;
  held = new Map<number, number>();
  nextId = 1;
  constructor(spentCents = 0, limitCents = DOOR_PRESS_CEILING_CENTS) {
    this.spentCents = Math.max(0, Number.isFinite(spentCents) ? spentCents : 0);
    this.limitCents = limitCents;
  }
  committedCents(): number {
    let n = this.spentCents;
    for (const v of this.held.values()) n += v;
    return n;
  }
  // A hold for one call's worst case, or null (and counted as a skip) when it would pass the ceiling.
  reserve(worstCents: number): number | null {
    if (this.committedCents() + worstCents > this.limitCents + 1e-9) {
      this.skipped++;
      return null;
    }
    const id = this.nextId++;
    this.held.set(id, worstCents);
    return id;
  }
  // The call's real cost, or null to keep its worst case (a cost we cannot know).
  settle(id: number | null, actualCents: number | null): void {
    if (id === null || !this.held.has(id)) return;
    const worst = this.held.get(id)!;
    this.held.delete(id);
    this.spentCents += actualCents === null ? worst : Math.max(0, actualCents);
  }
  // A cost found after the fact (a send that threw and was sent again: the first may have been billed).
  charge(cents: number): void {
    if (Number.isFinite(cents) && cents > 0) this.spentCents += cents;
  }
}

// What a press's earlier ledger rows (a lean retry's first try) and self-check rounds already count
// against the ceiling: each row's own `tokens.ceilingCents` (what it recorded, worst cases kept), else
// its `tokens.costCents`, plus each self-check round's (P5 records rounds as
// `self_check_rounds: [{ceilingCents | costCents, ...}]`). An unreadable number counts as nothing.
export function doorPressSpentCents(rows: readonly unknown[]): number {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  let sum = 0;
  for (const row of rows) {
    if (!isRec(row)) continue;
    const t = isRec(row.tokens) ? row.tokens : {};
    sum += n(t.ceilingCents) || n(t.costCents);
    for (const r of Array.isArray(row.self_check_rounds) ? row.self_check_rounds : []) {
      if (isRec(r)) sum += n(r.ceilingCents) || n(r.costCents);
    }
  }
  return sum;
}

// ─── THE CALLS' SETTINGS (section 4) ──────────────────────────────────────────────────────────────
export const DOOR_READS = 3;
export const DOOR_READ_QUORUM = 2;
export const DOOR_READ_MAX_TOKENS = 12000;
// Once two reads have drafted, the third gets this long and is then cut off: the consensus needs two.
export const DOOR_READ_GRACE_MS = 60_000;
// Each read is sent again once on a transient upstream failure (a 429, a 5xx, a 529, the API's "timed
// out while trying to download the file" 400, a send that threw): DRAFT_READ_RETRY with one delay.
export const DOOR_READ_RETRY = Object.freeze({ ...DRAFT_READ_RETRY, delaysMs: Object.freeze([1_500]) });
export const DOOR_CLOSEUP_ASKS = 3;
export const DOOR_CLOSEUP_MAX_TOKENS = 4000;
export const DOOR_CLOSEUP_CALL_MS = 40_000;
export const DOOR_CLOSEUP_MIN_LEFT_MS = 45_000;
export const DOOR_CLOSEUP_DIV = 6; // a hinge or handle crop: 1/6 of the photo each way
export const DOOR_MEET_DIV = 8; // a meeting-edge strip: 1/8 of the door's width
export const DOOR_CLOSEUP_ZOOM = 6;
export const DOOR_STAGEB_MAX_TOKENS = 12000;
export const DOOR_STAGEB_MIN_LEFT_MS = 120_000;
export const DOOR_MAX_GAPS = 8;

// ─── WARNINGS P4 ADDS ─────────────────────────────────────────────────────────────────────────────
// doorLook.ts's DOOR_WARNINGS cover the reads and the close-ups. These cover what a press itself did.
export const DOOR_SIX_PANEL_TEXT = "This door's look isn't fully supported yet, so we drew the closest match. Check it against your photo before you save.";
export const DOOR_PRESS_WARNINGS = {
  stageb_skipped: "We didn't get a second look at everything we saw in your photo. Check the door's parts against it before you save.",
  six_panel: DOOR_SIX_PANEL_TEXT,
  draft_unsaved: "We couldn't keep this draft in your Door looks list. Save it now so you don't lose it. You haven't been charged.",
} as const;
const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const quoted = (xs: string[]) => andList(xs.map((x) => `"${x}"`));
const pressWarning = (code: keyof typeof DOOR_PRESS_WARNINGS): DoorWarning => ({ code, text: DOOR_PRESS_WARNINGS[code] });
const mismatchWarning = (xs: string[]): DoorWarning => ({
  code: "observed_mismatch",
  text: `We saw ${quoted(xs)} in your photo but couldn't place ${xs.length === 1 ? "it" : "them"} on the door. Check ${xs.length === 1 ? "it" : "them"} before you save.`,
});
const gapWarning = (xs: string[]): DoorWarning => ({ code: "vocab_gap", text: `We can't draw ${quoted(xs)} yet. We've noted it so we can add it.` });
function pushWarning(list: DoorWarning[], w: DoorWarning) {
  if (!list.some((x) => x.code === w.code)) list.push(w);
}

// ─── THE AGREEMENT CHECK (section 4) ──────────────────────────────────────────────────────────────
// The reads' own words (`observed`) against the draft itself: "Z brace" in observed with no Z brace, no
// Z fill and no diagonal board is a mismatch. The server does not rely on the model's `unexplained`
// alone. Only the construction is checked; the hardware is the close-ups' to decide and they warn.
type Feature = "brace_z" | "brace_x" | "fill_z" | "fill_x" | "pickets" | "lite" | "vent" | "raised" | "diamond" | "split" | "board_diag" | "board_gusset";
// Short corner gussets: doorLook.ts drafts a short diagonal as a board part, and a diamond's octagon is
// four of them. Checked first, and its words are taken out before the other rules read the phrase, so
// "corner cross braces" asks for gussets alone and "a Z brace with corner gussets" for both.
// "Corner-to-corner" is how a whole Z or X runs, never a gusset.
export const DOOR_GUSSET = /\b(gussets?|gusseted|(?<!\bto[- ])corner[- ](cross[- ]?)?brac(e|es|ed|ing)|(cross[- ]?)?braced corners?)\b/i;
const DOOR_GUSSET_ALL = new RegExp(DOOR_GUSSET.source, "gi");
const OBSERVED_RULES: { re: RegExp; any: Feature[] }[] = [
  { re: DOOR_GUSSET, any: ["board_gusset", "diamond"] },
  { re: /\bz[- ]?brac/i, any: ["brace_z", "fill_z", "board_diag"] },
  { re: /\b(x[- ]?(brac|shape|pattern)|an x\b|crossbuck|cross[- ]?brac)/i, any: ["brace_x", "fill_x", "board_diag"] },
  { re: /\b(pickets?|spindles?|balusters?)\b/i, any: ["pickets"] },
  { re: /\b(windows?|glazed|glazing|lites?|panes?)\b|(?<![a-z])glass\b/i, any: ["lite"] },
  { re: /\b(vents?|louv(er|re)s?|louv(er|re)d)\b/i, any: ["vent"] },
  { re: /\braised[- ]panels?\b/i, any: ["raised"] },
  { re: /\b(diamond|octagon)/i, any: ["diamond"] },
  { re: /\b(split|opens? in two|two halves)\b/i, any: ["split"] },
];
const NEGATED = /\b(no|not|without|none|zero|never)\b/i;
// A 6-panel door has no look of its own in v1: it is drafted as six raised parts on a basic slab, and
// that is a known gap (Ahsan, 2026-10-26), never a reason for Stage B.
export const DOOR_SIX_PANEL = /\b(6|six)[- ]?panel/i;
export const DOOR_SIX_PANEL_GAP = "6-panel";

// What the spec draws: its own keys, the base's where it says nothing.
export function doorLookFeatures(spec: DoorLook): Set<Feature> {
  const base = spec.base as DoorLookBase;
  const def = DOOR_LOOK_BASE_DEFAULTS[base] ?? DOOR_LOOK_BASE_DEFAULTS.plank;
  const out = new Set<Feature>();
  const frame = isRec(spec.frame) ? spec.frame : {};
  const rails = Array.isArray(frame.rails) ? frame.rails : def.rails;
  const own = Array.isArray(spec.panels) ? spec.panels : [];
  for (let i = 0; i <= rails.length; i++) {
    const p = own[i];
    const fill = isRec(p) && typeof p.fill === "string" ? p.fill : def.panels[i] ?? "none";
    if (fill === "z") out.add("fill_z");
    if (fill === "x") out.add("fill_x");
    if (fill === "pickets") out.add("pickets");
    if (fill === "lite") out.add("lite");
    if (fill === "vent") out.add("vent");
    if (fill === "raised") out.add("raised");
    if (fill === "diamond") out.add("diamond");
  }
  const brace = isRec(spec.brace) && typeof spec.brace.t === "string" ? spec.brace.t : def.brace;
  if (brace === "z") out.add("brace_z");
  if (brace === "x") out.add("brace_x");
  for (const part of Array.isArray(spec.parts) ? spec.parts : []) {
    if (!isRec(part)) continue;
    if (part.t === "board") {
      // A long diagonal board, and one across a corner: it rises 0.3 of the door or less, at a real slope
      // (a level or plumb board read a little off is neither). A large gusset is both.
      const du = Math.abs(Number(part.u1) - Number(part.u0)), dv = Math.abs(Number(part.v1) - Number(part.v0));
      if (du > 0.1 && dv > 0.1) out.add("board_diag");
      if (du > 0.02 && dv > 0.02 && dv <= 0.3 && du / dv >= 0.4 && du / dv <= 6) out.add("board_gusset");
    }
    if (part.t === "lite" || part.t === "vent" || part.t === "raised" || part.t === "split") out.add(part.t as Feature);
  }
  return out;
}

// Short phrases, trimmed, at most 80 characters, each once (case aside), at most DOOR_MAX_GAPS. MODEL-WRITTEN
// TEXT: it reaches the builder's warnings, the Stage B prompt and app_errors, and a photo can carry printed
// words the model copies (a sign on a door). So only plain words survive: letters, digits, spaces and
// , . ' - / ( ), everything else becomes a space.
export function doorPhrases(v: unknown): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(v) ? v.slice(0, 40) : []) {
    if (typeof s !== "string") continue;
    const t = s.replace(/[^A-Za-z0-9 ,.'()/-]/g, " ").trim().replace(/\s+/g, " ").slice(0, 80).trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= DOOR_MAX_GAPS) break;
  }
  return out;
}

export function doorObservedMismatches(observed: readonly string[], spec: DoorLook): string[] {
  const have = doorLookFeatures(spec);
  const out: string[] = [];
  for (const phrase of doorPhrases(observed)) {
    if (NEGATED.test(phrase) || DOOR_SIX_PANEL.test(phrase)) continue;
    // Gussets first (OBSERVED_RULES[0]); the other rules read what is left, so every brace a phrase names
    // is checked.
    const gusset = DOOR_GUSSET.test(phrase) ? OBSERVED_RULES[0] : undefined;
    const rest = gusset ? phrase.replace(DOOR_GUSSET_ALL, " ") : phrase;
    const rule = OBSERVED_RULES.slice(1).find((r) => r.re.test(rest));
    if ([gusset, rule].some((r) => r && !r.any.some((f) => have.has(f)))) out.push(phrase);
  }
  return out;
}

// The unexplained phrases that are still open: not the 6-panel's known gap, and not short corner gussets
// once the draft holds them (the reads call them unexplained because the prompt has no word for them, but
// the maths drafts each as a board part).
function openGaps(phrases: string[], spec: DoorLook): string[] {
  const have = doorLookFeatures(spec), gussets = have.has("board_gusset") || have.has("diamond");
  return phrases.filter((s) => !DOOR_SIX_PANEL.test(s) && !(gussets && DOOR_GUSSET.test(s)));
}

// What Stage B would be asked about: the mismatches, and the unexplained phrases that are not a gap we
// already know cannot be closed. `knownGaps` are filed whatever Stage B says.
export type DoorStageBWanted = { needed: boolean; missing: string[]; unexplained: string[]; knownGaps: string[] };
export function doorStageBWanted(c: Pick<DoorConsensus, "observed" | "unexplained">, spec: DoorLook): DoorStageBWanted {
  const said = [...c.observed, ...c.unexplained];
  const knownGaps = said.some((s) => DOOR_SIX_PANEL.test(s)) ? [DOOR_SIX_PANEL_GAP] : [];
  const missing = doorObservedMismatches(c.observed, spec);
  const unexplained = openGaps(doorPhrases(c.unexplained), spec);
  return { needed: missing.length > 0 || unexplained.length > 0, missing, unexplained, knownGaps };
}

// ─── AFTER THE CLOSE-UPS: STAGE B'S PARTS, THE CHECK AGAIN, THE GAPS ──────────────────────────────
// The one finishing step, shared by the live press and by reads read back from files. `stageB` is its
// answer when it ran, or why it did not; null when it was not needed.
export type DoorStageBResult = { status: "ok"; answer: unknown } | { status: "skipped" | "failed"; reason: string };
export type DoorFinished = {
  spec: DoorLook;
  warnings: DoorWarning[];
  vocabGaps: string[];
  mismatches: string[];
  unexplained: string[];
  stageBAdded: number;
};
export function finishDoorDraft(c: DoorConsensus, spec: DoorLook, warnings: readonly DoorWarning[], ctx: DoorMeasureCtx, wanted: DoorStageBWanted, stageB: DoorStageBResult | null): DoorFinished {
  let out = spec;
  const ws = [...warnings];
  let unexplained = wanted.unexplained;
  let stageBAdded = 0;
  if (stageB && stageB.status === "ok") {
    const kept = keepStageBParts(c, out, stageB.answer, ctx);
    out = kept.spec;
    stageBAdded = kept.added;
    for (const w of kept.warnings) pushWarning(ws, w);
    // Stage B's own list is the latest word on what our vocabulary cannot say.
    if (isRec(stageB.answer) && Array.isArray(stageB.answer.unexplained)) {
      unexplained = openGaps(doorPhrases(stageB.answer.unexplained), out);
    }
  } else if (wanted.needed) pushWarning(ws, pressWarning("stageb_skipped"));
  const mismatches = doorObservedMismatches(c.observed, out);
  if (mismatches.length) pushWarning(ws, mismatchWarning(mismatches));
  if (wanted.knownGaps.includes(DOOR_SIX_PANEL_GAP)) pushWarning(ws, pressWarning("six_panel"));
  if (unexplained.length) pushWarning(ws, gapWarning(unexplained));
  const vocabGaps = doorPhrases([...wanted.knownGaps, ...unexplained]);
  return { spec: out, warnings: ws, vocabGaps, mismatches, unexplained, stageBAdded };
}

// ─── ONE PRESS'S RESULT ───────────────────────────────────────────────────────────────────────────
export type DoorFailureKind = "timeout" | "cutoff" | "unparseable" | "upstream" | "ceiling" | "spec";
export type DoorFailure = { kind: DoorFailureKind; code: string; retryable: boolean; message: string; detail?: string };
// What the builder reads, by failure (section 4's table). A cut-off reply and an unreadable one read the
// same; only the first is retryable.
export const DOOR_FAILURE_TEXT = {
  timeout: "This took too long. Please try again. You haven't been charged.",
  unparseable: "We couldn't read this door. Try a straight-on photo of the closed door.",
  upstream: "The AI service had a problem just now. Please press Generate again. You haven't been charged.",
  busy: "The AI service is busy right now. Please press Generate again. You haven't been charged.",
  unavailable: "Making door looks is unavailable right now. Try again later.",
} as const;
export type DoorCloseUpRecord = { status: "ok" | "skipped" | "failed"; reason?: string; asks?: number; votes?: unknown[] };
export type DoorReadRecord = {
  i: number;
  attempts: number;
  ms: number;
  status: number | null;
  threw: boolean;
  aborted: string | null;
  stop: string | null;
  input: number | null;
  output: number | null;
  answer?: Rec | null;
};
export type DoorDraftResult = {
  outcome: "draft" | "refused" | "failed";
  spec: DoorLook | null;
  warnings: DoorWarning[];
  vocabGaps: string[];
  refuse: { reason: DoorRefuseCode; code: string; text: string; leaves?: number } | null;
  failure: DoorFailure | null;
  sideFrom: string | null;
  baseSplit: boolean;
  consensus: Rec | null;
  reads: DoorReadRecord[];
  closeUps: Partial<Record<DoorCloseUpAsk, DoorCloseUpRecord>>;
  stageB: { status: "not_needed" | "ok" | "skipped" | "failed"; reason?: string; added?: number; input?: number | null; output?: number | null };
  observed: string[];
  unexplained: string[];
  mismatches: string[];
  usage: { input: number; output: number };
  costCents: number; // what the calls with a known cost cost
  ceilingCents: number; // what counts against the ceiling: the known costs plus the worst cases kept
  // What the press's limits cost it, as P7's scorer counts them: a call the ceiling skipped, Stage B or a
  // close-up the time or the ceiling skipped, and (set by the server) a lean retry the press clock refused.
  skipped: { ceiling?: boolean; stageB?: string; closeUps?: string[]; leanRetryClock?: boolean };
  effort: "low" | "high";
  model: string;
  prompt: string;
  ms: number;
};

// ─── READS FROM FILES: THE LOCAL PATH AND THE SIM'S RECORDED MODE ─────────────────────────────────
// The real server maths over answers someone saved: Stage A's consensus, the close-ups given (every one
// missing is skipped, with its warning), the agreement check, and Stage B's answer when one is given
// (skipped, with its warning, when it was wanted and none is). What the press would have drafted from
// the same answers, minus the calls a file cannot make.
export type DoorFromReads = {
  outcome: "draft" | "refused" | "failed";
  spec?: DoorLook;
  warnings: DoorWarning[];
  vocabGaps: string[];
  sideFrom?: string;
  refuse?: { code: string; reason: DoorRefuseCode; text: string; leaves?: number };
  error?: string;
  stageB?: DoorStageBWanted;
  consensus?: DoorConsensus;
};
export function doorDraftFromReads(answers: readonly unknown[], ctx: DoorMeasureCtx, x: { closeUps?: DoorCloseUps; stageB?: unknown } = {}): DoorFromReads {
  const c = stageADoorLook(answers.map((a) => (typeof a === "string" ? doorAnswerOf(a) : a)), ctx, DOOR_READ_QUORUM);
  if (!c.ok) {
    if ("refuse" in c) {
      const r = DOOR_REFUSALS[c.refuse];
      return { outcome: "refused", warnings: [], vocabGaps: [], refuse: { code: r.code, reason: c.refuse, text: r.text, ...(c.leaves ? { leaves: c.leaves } : {}) } };
    }
    return { outcome: "failed", warnings: [], vocabGaps: [], error: "ai_door_unparseable" };
  }
  const ups: DoorCloseUps = { hinges: { status: "skipped" }, handle: { status: "skipped" }, meet: { status: "skipped" }, ...(x.closeUps ?? {}) };
  const settled = settleCloseUps(c, ups);
  if (!settled.ok) return { outcome: "failed", warnings: settled.warnings, vocabGaps: [], error: `ai_door_unparseable:${settled.error}`, sideFrom: c.sideFrom };
  const wanted = doorStageBWanted(c, settled.spec);
  const stageB: DoorStageBResult | null = x.stageB !== undefined && x.stageB !== null
    ? { status: "ok", answer: typeof x.stageB === "string" ? doorAnswerOf(x.stageB) : x.stageB }
    : wanted.needed ? { status: "skipped", reason: "local" } : null;
  const f = finishDoorDraft(c, settled.spec, settled.warnings, ctx, wanted, stageB);
  return { outcome: "draft", spec: f.spec, warnings: f.warnings, vocabGaps: f.vocabGaps, sideFrom: c.sideFrom, stageB: wanted, consensus: c };
}

// ─── ONE MODEL CALL ───────────────────────────────────────────────────────────────────────────────
export type DoorDeps = {
  // The Messages API, called with (url, init). Never anything else.
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  apiKey: string;
  now?: () => number;
  // The close-ups' crops: each window of the straightened photo enlarged `zoom` times, as base64 JPEG,
  // in the order given. Absent, or throwing: those close-ups fail (with their warnings).
  cut?: (windows: CloseUpWindow[], zoom: number, signal: AbortSignal) => Promise<string[]>;
  // The 5 x 5 median at a photo pixel (doorLook.ts samplePatch over the decoded photo). Absent: no colour roles.
  colorAt?: (p: XY) => RGB | null;
  random?: () => number;
};
const headers = (apiKey: string) => ({ "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" });
function usageOf(data: unknown): { input: number; output: number } | null {
  const u = isRec(data) && isRec(data.usage) ? data.usage : null;
  if (!u) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  return { input, output: n(u.output_tokens) };
}
export type DoorReading = { drafted: boolean; data: Rec | null; stop: string | null; answer: Rec | null; usage: { input: number; output: number } | null };
export function readDoorReply(body: string): DoorReading {
  let data: unknown = null;
  try { data = JSON.parse(body); } catch { data = null; }
  const d = isRec(data) ? data : null;
  const reply = modelReplyText(d);
  const answer = reply.stopReason === "refusal" ? null : doorAnswerOf(reply.text);
  return { drafted: answer !== null, data: d, stop: reply.stopReason, answer, usage: usageOf(d) };
}
type AskResult = { status: number | null; threw: boolean; answer: Rec | null; stop: string | null; usage: { input: number; output: number } | null; ms: number };
async function askDoor(deps: DoorDeps, body: string, callMs: number): Promise<AskResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  try {
    const res = await deps.fetch(API_URL, { method: "POST", headers: headers(deps.apiKey), body, signal: AbortSignal.timeout(Math.max(1, Math.floor(callMs))) });
    const text = await res.text();
    if (!res.ok) return { status: res.status, threw: false, answer: null, stop: null, usage: null, ms: now() - t0 };
    const r = readDoorReply(text);
    return { status: res.status, threw: false, answer: r.answer, stop: r.stop, usage: r.usage, ms: now() - t0 };
  } catch {
    return { status: null, threw: true, answer: null, stop: null, usage: null, ms: now() - t0 };
  }
}
// What a finished call cost, or null when it cannot be known (it threw after it was sent).
const callCost = (a: { status: number | null; threw: boolean; usage: { input: number; output: number } | null }) =>
  a.threw ? null : a.status !== null && a.status >= 200 && a.status < 300 ? (a.usage ? doorCostCents(a.usage.input, a.usage.output) : null) : 0;

// ─── THE PRESS ────────────────────────────────────────────────────────────────────────────────────
export type DoorDraftInput = {
  widthIn: number;
  heightIn: number;
  leaves: 1 | 2;
  photo: XY; // the straightened front photo's size in pixels
  front: DoorImageSource;
  builder?: Partial<Record<DoorCloseUpKind, DoorImageSource>>; // the builder's own close-ups
  lean: boolean; // the one automatic retry: effort low, no Stage B
  deadlineAt: number; // epoch ms: no call of this press's work runs past it
  ceiling: DoorCeiling;
  model?: string;
  graceMs?: number; // DOOR_READ_GRACE_MS unless a test shortens it
};
const CLOSEUP_OF: Record<DoorCloseUpAsk, DoorCloseUpKind> = { hinges: "hinge", handle: "handle", meet: "meet" };

export async function runDoorDraft(deps: DoorDeps, input: DoorDraftInput): Promise<DoorDraftResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const model = input.model ?? AI_MODEL_V2;
  const effort: "low" | "high" = input.lean ? "low" : "high";
  const ctx: DoorMeasureCtx = { widthIn: input.widthIn, heightIn: input.heightIn, leaves: input.leaves, photo: input.photo, ...(deps.colorAt ? { colorAt: deps.colorAt } : {}) };
  const usage = { input: 0, output: 0 };
  let known = 0;
  const count = (a: { usage: { input: number; output: number } | null }) => {
    if (!a.usage) return;
    usage.input += a.usage.input;
    usage.output += a.usage.output;
    known += doorCostCents(a.usage.input, a.usage.output);
  };
  const leftMs = () => input.deadlineAt - now();
  // What the press had spent before this row: the row records only its own spend, so the rows of a key
  // add up to the press's (doorPressSpentCents) without counting a first try twice.
  const spentBefore = input.ceiling.spentCents;
  const result: DoorDraftResult = {
    outcome: "failed", spec: null, warnings: [], vocabGaps: [], refuse: null, failure: null, sideFrom: null, baseSplit: false,
    consensus: null, reads: [], closeUps: {}, stageB: { status: "not_needed" }, observed: [], unexplained: [], mismatches: [],
    usage, costCents: 0, ceilingCents: 0, skipped: {}, effort, model, prompt: DOOR_LOOK_PROMPT_ID, ms: 0,
  };
  const done = (r: Partial<DoorDraftResult>): DoorDraftResult => {
    Object.assign(result, r);
    result.costCents = Math.round(known * 10_000) / 10_000;
    result.ceilingCents = Math.round((input.ceiling.spentCents - spentBefore) * 10_000) / 10_000;
    if (input.ceiling.skipped) result.skipped.ceiling = true;
    result.ms = now() - t0;
    return result;
  };
  const fail = (kind: DoorFailureKind, retryable: boolean, message: string, detail?: string) =>
    done({ outcome: "failed", failure: { kind, code: kind === "timeout" ? "ai_door_timeout" : kind === "upstream" ? "ai_door_upstream" : kind === "ceiling" ? "ai_door_ceiling" : "ai_door_unparseable", retryable, message, ...(detail ? { detail } : {}) } });

  // ── STAGE A: three reads, a quorum of two ─────────────────────────────────────────────────────
  const ups = (["hinge", "handle", "meet"] as const).filter((k) => input.builder?.[k] && (k !== "meet" || input.leaves === 2));
  const text = doorStageAPrompt({ widthIn: input.widthIn, heightIn: input.heightIn, leaves: input.leaves, photo: input.photo, closeUps: [...ups] });
  const images = [input.front, ...ups.map((k) => input.builder![k]!)];
  const body = JSON.stringify(doorRequestBody({ model, maxTokens: DOOR_READ_MAX_TOKENS, effort, images, text }));
  const worst = doorCallWorstCents(DOOR_READ_MAX_TOKENS, doorInputTokensEst(text, images.length));
  const holds: (number | null)[] = [];
  for (let i = 0; i < DOOR_READS; i++) holds.push(input.ceiling.reserve(worst));
  // Stage A always fits under the ceiling (section 8: three reads are about $0.81 at worst, and a lean
  // retry follows a first try whose Stage A failed). Should it ever not, nothing is sent.
  if (holds.some((h) => h === null)) {
    for (const h of holds) input.ceiling.settle(h, 0);
    return fail("ceiling", false, DOOR_FAILURE_TEXT.unavailable, "stage A does not fit under the ceiling");
  }
  if (leftMs() <= 0) {
    for (const h of holds) input.ceiling.settle(h, 0);
    return fail("timeout", true, DOOR_FAILURE_TEXT.timeout, "no time left before Stage A");
  }
  const stageA = new AbortController();
  const timer = setTimeout(() => stageA.abort(), leftMs());
  let drafted = 0, graceFired = false, netThrows = 0;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let calls: DraftCall<DoorReading>[];
  // A read counts toward the quorum (and starts the grace) only when doorLook.ts can use it: it measures,
  // or it refuses. One that parses but is dropped (its size echo off the photo, no size) does not.
  const usable = (answer: Rec | null) => {
    if (!answer) return false;
    const m = doorLookFromMeasure(answer, ctx);
    return m.ok || "refuse" in m;
  };
  try {
    calls = await runDraftCalls<DoorReading>({
      count: DOOR_READS,
      deadline: stageA.signal,
      graceMs: 0,
      retry: { ...DOOR_READ_RETRY, delaysMs: [...DOOR_READ_RETRY.delaysMs], deadlineAt: input.deadlineAt, ...(deps.random ? { random: deps.random } : {}) },
      send: async (signal) => {
        try {
          return await deps.fetch(API_URL, { method: "POST", headers: headers(deps.apiKey), body, signal });
        } catch (e) {
          if (!signal.aborted) netThrows++;
          throw e;
        }
      },
      read: (b) => {
        const r = readDoorReply(b);
        if (usable(r.answer) && ++drafted === DOOR_READ_QUORUM && DOOR_READ_QUORUM < DOOR_READS) {
          grace = setTimeout(() => {
            graceFired = true;
            stageA.abort();
          }, input.graceMs ?? DOOR_READ_GRACE_MS);
        }
        return r;
      },
    });
  } finally {
    clearTimeout(timer);
    if (grace !== undefined) clearTimeout(grace);
  }
  calls.forEach((c, i) => {
    const reading = c.httpOk ? c.reading : null;
    if (reading) count(reading);
    // Never sent costs nothing; a non-2xx is not billed; a throw after the send may have been.
    input.ceiling.settle(holds[i], c.attempts === 0 ? 0 : c.threw ? null : reading ? (reading.usage ? doorCostCents(reading.usage.input, reading.usage.output) : null) : 0);
  });
  // A send that threw on the network and was sent again: its cost, if any, is unknown, so its worst case
  // counts too (a final throw already kept its own above).
  const finalThrows = calls.filter((c) => c.threw && c.attempts > 0 && c.aborted === null && !c.replied).length;
  input.ceiling.charge(Math.max(0, netThrows - finalThrows) * worst);
  result.reads = calls.map((c) => ({
    i: c.index, attempts: c.attempts, ms: c.ms, status: c.status, threw: c.threw, aborted: c.threw ? (graceFired && c.aborted === "deadline" ? "quorum" : c.aborted) : null,
    stop: c.httpOk ? c.reading.stop : null, input: c.httpOk ? c.reading.usage?.input ?? null : null, output: c.httpOk ? c.reading.usage?.output ?? null : null,
    answer: c.httpOk ? c.reading.answer : null,
  }));
  const answers = calls.map((c) => (c.httpOk && c.reading.drafted ? c.reading.answer : null));
  const cons = stageADoorLook(answers, ctx, DOOR_READ_QUORUM);
  if (!cons.ok) {
    if ("refuse" in cons) {
      const r = DOOR_REFUSALS[cons.refuse];
      return done({ outcome: "refused", refuse: { reason: cons.refuse, code: r.code, text: r.text, ...(cons.leaves ? { leaves: cons.leaves } : {}) } });
    }
    const parsed = answers.filter(Boolean).length;
    if (parsed < DOOR_READ_QUORUM && calls.some((c) => c.threw && c.aborted === "deadline" && !graceFired)) {
      return fail("timeout", true, DOOR_FAILURE_TEXT.timeout, `${parsed} of ${DOOR_READS} reads drafted before the deadline`);
    }
    // The API failed the reads that would have made the quorum (all of them, or two of three): its failure,
    // retryable when it was transient, never "we couldn't read this door".
    const failed = calls.filter((c) => !c.httpOk && c.attempts > 0 && !(c.threw && c.aborted !== null));
    if (failed.length && parsed + failed.length >= DOOR_READ_QUORUM && parsed < DOOR_READ_QUORUM) {
      const f = draftUpstreamFailure(failed[0], calls);
      return fail("upstream", f.transient, f.kind === "overloaded" ? DOOR_FAILURE_TEXT.busy : DOOR_FAILURE_TEXT.upstream, f.message.slice(0, 300));
    }
    if (calls.some((c) => c.httpOk && !c.reading.drafted && c.reading.stop === "max_tokens")) {
      return fail("cutoff", true, DOOR_FAILURE_TEXT.unparseable, "a read was cut off at max_tokens");
    }
    // Our own grace cut a read and the rest did not agree: another try may.
    if (graceFired) return fail("unparseable", true, DOOR_FAILURE_TEXT.unparseable, `the grace cut a read; dropped: ${JSON.stringify(cons.dropped).slice(0, 200)}`);
    return fail("unparseable", false, DOOR_FAILURE_TEXT.unparseable, `dropped: ${JSON.stringify(cons.dropped).slice(0, 200)}`);
  }
  const c = cons;
  result.sideFrom = c.sideFrom;
  result.baseSplit = c.split.base;
  result.observed = c.observed;
  result.unexplained = c.unexplained;
  result.consensus = { side: c.side, sideFrom: c.sideFrom, leaves: c.leaves, meetX: c.meetX, closeUpAt: c.closeUpAt, used: c.used, dropped: c.dropped, best: c.best, split: c.split };

  // ── CLOSE-UPS: hinges first, then the handle, then the meeting edge ──────────────────────────
  // Each needs Stage A's points, so they come after it. Each starts only with 45 s of the work left
  // and only when its three asks fit under the ceiling; the three run side by side.
  const ups2: DoorCloseUps = {};
  type Plan = { ask: DoorCloseUpAsk; windows: CloseUpWindow[]; builder?: DoorImageSource; holds: (number | null)[]; crops: string[] };
  const plans: Plan[] = [];
  const asks: DoorCloseUpAsk[] = c.leaves === 2 ? ["hinges", "handle", "meet"] : ["hinges", "handle"];
  for (const ask of asks) {
    const windows = ask === "hinges"
      ? c.closeUpAt.hinges.slice(0, 4).map((p) => closeUpWindow(p, input.photo, DOOR_CLOSEUP_DIV))
      : ask === "handle"
      ? (c.closeUpAt.handle ? [closeUpWindow(c.closeUpAt.handle, input.photo, DOOR_CLOSEUP_DIV)] : [])
      : c.closeUpAt.meet.map((p) => closeUpWindow(p, input.photo, DOOR_MEET_DIV));
    const builder = input.builder?.[CLOSEUP_OF[ask]];
    const skip = (reason: string) => {
      ups2[ask] = { status: "skipped" };
      result.closeUps[ask] = { status: "skipped", reason };
      if (reason !== "nothing") (result.skipped.closeUps ??= []).push(`${ask}:${reason}`);
    };
    if (!windows.length && !builder) { skip("nothing"); continue; }
    if (leftMs() < DOOR_CLOSEUP_MIN_LEFT_MS) { skip("time"); continue; }
    const prompt = doorCloseUpPrompt(ask, { crops: windows.length, builderPhoto: !!builder, widthIn: input.widthIn });
    const w = doorCallWorstCents(DOOR_CLOSEUP_MAX_TOKENS, doorInputTokensEst(prompt, windows.length + (builder ? 1 : 0)));
    const hs: (number | null)[] = [];
    for (let k = 0; k < DOOR_CLOSEUP_ASKS; k++) hs.push(input.ceiling.reserve(w));
    if (hs.some((h) => h === null)) {
      for (const h of hs) input.ceiling.settle(h, 0);
      skip("ceiling");
      continue;
    }
    plans.push({ ask, windows, ...(builder ? { builder } : {}), holds: hs, crops: [] });
  }
  if (plans.length) {
    const wins = plans.flatMap((p) => p.windows);
    let crops: string[] | null = wins.length ? null : [];
    if (wins.length && deps.cut) {
      try {
        crops = await deps.cut(wins, DOOR_CLOSEUP_ZOOM, AbortSignal.timeout(Math.max(1_000, leftMs())));
        if (!Array.isArray(crops) || crops.length !== wins.length) crops = null;
      } catch {
        crops = null;
      }
    }
    let at = 0;
    for (const p of plans) {
      p.crops = crops ? crops.slice(at, at + p.windows.length) : [];
      at += p.windows.length;
    }
    // The cut took time: the 45 s rule again before any ask goes.
    const late = leftMs() < DOOR_CLOSEUP_MIN_LEFT_MS;
    await Promise.all(plans.map(async (p) => {
      if (late) {
        for (const h of p.holds) input.ceiling.settle(h, 0);
        ups2[p.ask] = { status: "skipped" };
        result.closeUps[p.ask] = { status: "skipped", reason: "time" };
        (result.skipped.closeUps ??= []).push(`${p.ask}:time`);
        return;
      }
      const imgs: DoorImageSource[] = [...p.crops.map((b) => ({ base64: b, mediaType: "image/jpeg" })), ...(p.builder ? [p.builder] : [])];
      if (!imgs.length || (!p.crops.length && p.windows.length && !p.builder)) {
        for (const h of p.holds) input.ceiling.settle(h, 0);
        ups2[p.ask] = { status: "failed" };
        result.closeUps[p.ask] = { status: "failed", reason: "cut" };
        return;
      }
      const prompt = doorCloseUpPrompt(p.ask, { crops: p.crops.length, builderPhoto: !!p.builder, widthIn: input.widthIn });
      const askBody = JSON.stringify(doorRequestBody({ model, maxTokens: DOOR_CLOSEUP_MAX_TOKENS, effort: "high", images: imgs, text: prompt }));
      const callMs = Math.min(DOOR_CLOSEUP_CALL_MS, leftMs());
      const answers = await Promise.all(p.holds.map(() => askDoor(deps, askBody, callMs)));
      answers.forEach((a, k) => {
        count(a);
        input.ceiling.settle(p.holds[k], callCost(a));
      });
      const votes = answers.map((a) => a.answer);
      const ans: DoorCloseUpAnswer = votes.some(Boolean) ? { status: "ok", votes } : { status: "failed" };
      ups2[p.ask] = ans;
      result.closeUps[p.ask] = ans.status === "ok" ? { status: "ok", asks: answers.length, votes } : { status: "failed", reason: "asks", asks: answers.length };
    }));
  }
  const settled = settleCloseUps(c, ups2);
  if (!settled.ok) return fail("spec", false, DOOR_FAILURE_TEXT.unparseable, `${settled.error} at ${settled.path}`);

  // ── THE AGREEMENT CHECK AND STAGE B ────────────────────────────────────────────────────────────
  const wanted = doorStageBWanted(c, settled.spec);
  let stageB: DoorStageBResult | null = null;
  if (wanted.needed) {
    const skipB = (reason: string) => {
      stageB = { status: "skipped", reason };
      result.stageB = { status: "skipped", reason };
      result.skipped.stageB = reason;
    };
    const textB = doorStageBPrompt({ photo: input.photo, widthIn: input.widthIn, heightIn: input.heightIn, spec: settled.spec, missing: wanted.missing, unexplained: wanted.unexplained });
    if (input.lean) skipB("lean");
    else if (leftMs() < DOOR_STAGEB_MIN_LEFT_MS) skipB("time");
    else {
      const h = input.ceiling.reserve(doorCallWorstCents(DOOR_STAGEB_MAX_TOKENS, doorInputTokensEst(textB, 1)));
      if (h === null) skipB("ceiling");
      else {
        const a = await askDoor(deps, JSON.stringify(doorRequestBody({ model, maxTokens: DOOR_STAGEB_MAX_TOKENS, effort: "high", images: [input.front], text: textB })), leftMs());
        count(a);
        input.ceiling.settle(h, callCost(a));
        stageB = a.answer ? { status: "ok", answer: a.answer } : { status: "failed", reason: a.threw ? "threw" : `status ${a.status}` };
        result.stageB = { status: stageB.status, ...(stageB.status === "failed" ? { reason: stageB.reason } : {}), input: a.usage?.input ?? null, output: a.usage?.output ?? null };
      }
    }
  }
  const f = finishDoorDraft(c, settled.spec, settled.warnings, ctx, wanted, stageB);
  if (result.stageB.status === "ok") result.stageB.added = f.stageBAdded;
  const clean = cleanDoorLook(f.spec);
  if (!clean.ok) return fail("spec", false, DOOR_FAILURE_TEXT.unparseable, `${clean.error} at ${clean.path}`);
  return done({ outcome: "draft", spec: clean.spec, warnings: f.warnings, vocabGaps: f.vocabGaps, mismatches: f.mismatches, unexplained: f.unexplained });
}

// ─── THE LEDGER ROW A PRESS LEAVES (ai_door_calls, 337) ───────────────────────────────────────────
// The columns the server writes when a press's work ends, from its result. The spec, the warnings and
// the money are what recover and the P7 scorer read back (tests/doorlooks/doorSim.mjs's
// runFromDoorLedgerRow); the points, the reads and the notes stay here and never reach a shopper.
// Every string made jsonb-safe: Postgres refuses a \u0000 and a lone surrogate in jsonb, and the model's
// raw answers ride in `reads`, so one stray character would otherwise fail the whole ledger write.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export function doorJsonSafe<T>(v: T): T {
  if (typeof v === "string") return v.replace(/\u0000/g, "").replace(LONE_SURROGATE, "�") as T;
  if (Array.isArray(v)) return v.map((x) => doorJsonSafe(x)) as T;
  if (isRec(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [doorJsonSafe(k), doorJsonSafe(x)])) as T;
  return v;
}
export function doorLedgerFields(r: DoorDraftResult): Rec {
  return doorJsonSafe(doorLedgerRaw(r));
}
// The money and the outcome alone (numbers and our own codes): what a ledger write that failed whole
// still records, so a retry under the key can never start with a fresh ceiling.
export function doorLedgerCore(fields: Rec): Rec {
  const t = isRec(fields.tokens) ? fields.tokens : {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const failure = isRec(t.failure) ? { code: String(t.failure.code ?? ""), message: String(t.failure.message ?? ""), retryable: t.failure.retryable === true } : null;
  return {
    // The cleaned spec holds only numbers, enums and hex: safe to keep, and what recover answers with.
    status: fields.status, draft_ms: n(fields.draft_ms), drafted: isRec(fields.drafted) ? fields.drafted : null,
    tokens: { costCents: n(t.costCents), ceilingCents: n(t.ceilingCents) ?? DOOR_PRESS_CEILING_CENTS, outcome: typeof t.outcome === "string" ? t.outcome : null, failure },
  };
}
function doorLedgerRaw(r: DoorDraftResult): Rec {
  return {
    status: r.outcome === "draft" ? "done" : "failed",
    drafted: r.spec,
    measure: r.consensus,
    reads: r.reads,
    observed: { observed: r.observed, unexplained: r.unexplained, mismatches: r.mismatches },
    warnings: r.warnings,
    zoom: { closeUps: r.closeUps, stageB: r.stageB },
    tokens: {
      prompt: r.prompt, model: r.model, effort: r.effort, input: r.usage.input, output: r.usage.output,
      costCents: r.costCents, ceilingCents: r.ceilingCents, outcome: r.outcome, refuse: r.refuse, failure: r.failure,
      vocabGaps: r.vocabGaps, skipped: r.skipped, sideFrom: r.sideFrom, baseSplit: r.baseSplit,
    },
    draft_ms: r.ms,
  };
}

// ─── PICKING A DRAFT UP AFTER A DROPPED STREAM (generate_door_look_recover) ──────────────────────
// The newest ledger row under the press's key answers, by its status; the money sentence comes from the
// press's own wallet rows (styleD3.ts draftMoneyState), never from a clock.
//   done      the draft, with the Draft look's id (the server wrote that row before any capture)
//   failed    not charged (or, if the wallet says captured, charged once and the draft is in the list)
//   running   still working, until the press clock (plus a minute) says its worker is gone
//   no row    not answered at once: the press's insert may not have landed (the browser keeps asking)
export type DoorRecoverRow = { id: string; created_at: unknown; status: unknown; drafted: unknown; warnings: unknown; tokens: unknown; dims?: unknown };
export const DOOR_RECOVER_COLUMNS = "id, created_at, status, drafted, warnings, tokens, dims";
// When a press started: its first try's request, kept on each of its rows (dims.pressStartedAt), else the
// row's own created_at (a row written before that key existed).
export function doorPressStartOf(row: { created_at?: unknown; dims?: unknown } | null | undefined): number {
  const d = row && isRec(row.dims) ? row.dims : {};
  const ms = msOf(d.pressStartedAt);
  return Number.isFinite(ms) ? ms : msOf(row?.created_at);
}
export const DOOR_RECOVER_STALE_MS = DOOR_PRESS_CLOCK_MS + 60_000;
export const DOOR_RECOVER_TEXT = {
  notCharged: "We couldn't pick your door look up: it didn't finish, so you haven't been charged. Press Generate to try again.",
  chargedInList: "This door look was charged once, and its draft is in your Door looks list. Reload the page to see it.",
  unsure: "We couldn't pick your door look up. A door look is only ever charged once. Reload the page before pressing Generate again.",
  inList: "Your door look's draft is in your Door looks list. Reload the page to see it.",
} as const;
export type DoorRecoverAnswer =
  | { kind: "draft"; code: string; severity: "info"; body: Rec }
  | { kind: "pending"; body: { ok: true; pending: true } }
  | { kind: "lost"; code: string; severity: "info" | "error"; why: string; body: { ok: true; pending: false; reason: string; message: string; code?: string; retryable?: true } };
function msOf(v: unknown): number {
  const ms = Date.parse(String(v ?? ""));
  return Number.isFinite(ms) ? ms : NaN;
}
export function pickDoorRecoverRow(rows: readonly DoorRecoverRow[] | null | undefined): DoorRecoverRow | null {
  const list = (Array.isArray(rows) ? rows : []).filter((r): r is DoorRecoverRow => isRec(r));
  if (!list.length) return null;
  return [...list].sort((a, b) => (msOf(b.created_at) || 0) - (msOf(a.created_at) || 0))[0];
}
export function recoverDoorAnswer(row: DoorRecoverRow | null, money: DraftMoney, nowMs: number, lookId: string | null): DoorRecoverAnswer {
  const moneySaid = (): { message: string; severity: "info" | "error" } =>
    money.kind === "captured" ? { message: DOOR_RECOVER_TEXT.chargedInList, severity: "info" }
    : money.kind === "released" || money.kind === "none" ? { message: DOOR_RECOVER_TEXT.notCharged, severity: "info" }
    : { message: DOOR_RECOVER_TEXT.unsure, severity: "error" };
  const lost = (why: string, said = moneySaid(), code?: string, retryable = false): DoorRecoverAnswer => ({
    kind: "lost", code: "ai_door_recover_none", severity: said.severity, why,
    body: { ok: true, pending: false, reason: why, message: said.message, ...(code ? { code } : {}), ...(retryable ? { retryable: true as const } : {}) },
  });
  if (!row) return lost("no_row");
  const tokens = isRec(row.tokens) ? row.tokens : {};
  if (row.status === "done") {
    const clean = cleanDoorLook(row.drafted);
    // A done row whose draft did not reach the ledger: the Draft look is the answer when it exists (the
    // server writes it before any capture), and the money's sentence otherwise.
    if (!clean.ok) return lookId ? lost("in_list", { message: DOOR_RECOVER_TEXT.inList, severity: "info" }) : lost("unreadable", { message: moneySaid().message, severity: "error" });
    return {
      kind: "draft", code: "ai_door_recovered", severity: "info",
      body: {
        ok: true, recovered: true, lookId, spec: clean.spec,
        warnings: Array.isArray(row.warnings) ? row.warnings : [], checkId: row.id,
        pressStartedAt: Number.isFinite(doorPressStartOf(row)) ? new Date(doorPressStartOf(row)).toISOString() : null,
      },
    };
  }
  if (row.status === "failed") {
    // The failure's own sentence when the money agrees with it (nothing taken); the money's otherwise.
    const failure = isRec(tokens.failure) ? tokens.failure : isRec(tokens.refuse) ? tokens.refuse : null;
    const own = failure && typeof failure.message === "string" ? failure.message : failure && typeof failure.text === "string" ? failure.text : null;
    const code = failure && typeof failure.code === "string" ? failure.code : undefined;
    // A retryable failure keeps its one lean retry after a dropped stream too, while the press clock has
    // 150 s for it.
    const retryable = isRec(tokens.failure) && tokens.failure.retryable === true && doorPressStartOf(row) + DOOR_PRESS_CLOCK_MS - nowMs >= DOOR_LEAN_MIN_LEFT_MS;
    if (own && (money.kind === "released" || money.kind === "none")) return lost("failed", { message: own, severity: "info" }, code, retryable);
    return lost("failed", moneySaid(), code);
  }
  const age = nowMs - msOf(row.created_at);
  if (Number.isFinite(age) && age < DOOR_RECOVER_STALE_MS) return { kind: "pending", body: { ok: true, pending: true } };
  // Still marked running past the press clock and a minute: its worker was ended under it.
  return lost("stale", { message: moneySaid().message, severity: "error" });
}

// ─── A PHOTO'S SIZE FROM ITS HEADER ───────────────────────────────────────────────────────────────
// The server checks the photo's type and limits before anything is held or charged, without the image
// library (which loads its WebAssembly from the network): JPEG (the first SOF marker), PNG (IHDR) and
// WebP (VP8, VP8L, VP8X). Null for anything else.
export type ImageHead = { type: "jpeg" | "png" | "webp"; width: number; height: number };
export function imageHeadOf(b: Uint8Array): ImageHead | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const le24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const ok = (type: ImageHead["type"], width: number, height: number): ImageHead | null => (width > 0 && height > 0 ? { type, width, height } : null);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
    const be32 = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    return ok("png", be32(16), be32(20));
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = u16(i + 2);
      // SOF0-SOF15, but not DHT (C4), JPG (C8) or DAC (CC).
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok("jpeg", u16(i + 7), u16(i + 5));
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  if (b.length >= 30 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    if (chunk === "VP8 ") return ok("webp", le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return ok("webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === "VP8X") return ok("webp", le24(24) + 1, le24(27) + 1);
  }
  return null;
}
