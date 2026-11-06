// node --test tests/doorlooks/  (scripts/doorScore.test.mjs runs this file in the pre-push gate)
//
// Every section 9 bar, shown to trigger: a run just inside its bar passes and one just outside fails.
// Synthetic doors only: no corpus photo, truth file or builder name comes into this public repo.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkTruthCase, DOOR_RENDER_RULES, DOOR_SCORE_BARS, doorLeafFt, drawnDoorLook, formatReport, scoreCorpus, scoreRun,
} from "./doorScore.mjs";
import { insideRepo, liveGate, liveGenerate, main, recordedRuns, REPO_ROOT, runFromDoorLedgerRows, truthRuns } from "./doorSim.mjs";
import { fakeModel } from "../../supabase/functions/_shared/_test_stubs/doorModel.ts";

// ─── synthetic doors ──────────────────────────────────────────────────────────────────────────────
const ZDOOR = {
  v: 1,
  base: "zbrace",
  src: { leaves: 1, hinge: "left" },
  frame: { fIn: 5.5, railHIn: 4, rails: [0.5] },
  field: { dir: "v", pitchIn: 5.5 },
  brace: { t: "z", from: "hinge" },
  panels: [{ fill: "none" }, { fill: "none" }],
  hinges: { type: "tstrap", count: 3, at: [0.12, 0.5, 0.88], lenIn: 16, finish: "black" },
  handle: { type: "barn", v: "rail", finish: "black" },
  colors: { infill: "door", frame: "trim", members: "trim" },
};
const LITES = {
  v: 1,
  base: "basic",
  src: { leaves: 2, hinge: "right" },
  frame: { rails: [0.42] },
  panels: [{ fill: "z", zFrom: "hinge" }, { fill: "none" }],
  parts: [{ t: "lite", u0: 0.2, v0: 0.6, u1: 0.8, v1: 0.9, rows: 2, cols: 2 }, { t: "board", u0: 0.1, v0: 0.1, u1: 0.3, v1: 0.3, wIn: 3, role: "members" }],
  hinges: { type: "strap", count: 2, at: [0.2, 0.8], lenIn: 12 },
  handle: { type: "lever", v: 0.45 },
  meet: { type: "overlap", wIn: 2 },
  colors: { infill: "door", frame: "trim", members: "door" },
};
const tcase = (id, spec, more = {}) => ({
  id, status: "pending Ahsan's sign-off", set: "tune", source: "video", leaves: spec.src.leaves, sizeIn: [36, 80],
  expect: "draft", spec, hingesVisible: true, unscored: {}, vocabGaps: [], ...more,
});
const REFUSE = (id) => ({ id, status: "pending", set: "refuse", source: "catalog", leaves: 1, sizeIn: [108, 84], expect: "refuse", refuse: { reason: "unsupported", code: "ai_door_unsupported" } });

// A copy of `spec` with `path` ("hinges.at", "panels[0].fill") set to `value` (undefined deletes it).
function edit(spec, path, value) {
  const s = structuredClone(spec);
  const keys = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let o = s;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  if (value === undefined) delete o[keys.at(-1)];
  else o[keys.at(-1)] = value;
  return s;
}
const draft = (c, spec, run = 1, more = {}) => ({ case: c, run, outcome: "draft", spec, warnings: [], ...more });
const bar = (res, key) => res.bars.find((b) => b.key === key);
// n runs of one photo: the first `bad` carry `badSpec`, the rest the truth.
function score(truthCase, badSpec, bad, n = 20, more = {}) {
  const runs = Array.from({ length: n }, (_, i) => draft(truthCase.id, i < bad ? badSpec : truthCase.spec, i + 1, more));
  return scoreCorpus([truthCase], runs);
}

// ─── what is drawn ────────────────────────────────────────────────────────────────────────────────
test("drawnDoorLook resolves an absent key through today's rule, at the row's real size", () => {
  const trim = drawnDoorLook({ v: 1, base: "american", src: { leaves: 2, hinge: "right" } }, { sizeIn: [72, 76], leaves: 2 });
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
  close(trim.fIn, 3.48); // ssTrimDoorBoardFt: 0.29 ft
  close(trim.railHIn, 3.48);
  assert.deepEqual(trim.rails, [0.42]);
  assert.deepEqual(trim.panels.map((p) => p.fill), ["pickets", "none"]);
  assert.equal(trim.hinges.count, 3);
  assert.equal(trim.hinges.at[1], 0.42); // on the mid rail
  assert.ok(Math.abs(trim.hinges.at[0] - 0.0240) < 1e-3); // the bottom rail's centre
  close(trim.hinges.lenIn, (0.11 + 2.92 * 0.15) * 12); // the plate + 15% of a 2.92 ft leaf (shortened 2026-10-26)
  assert.deepEqual(trim.colors, { infill: "door", frame: "trim", members: "trim" });
  assert.deepEqual(trim.meet, { type: "astragal", wIn: 1.5 });

  const plank = drawnDoorLook({ v: 1, base: "zbrace", src: { leaves: 1, hinge: "left" } }, { sizeIn: [36, 80], leaves: 1 });
  close(plank.fIn, 3.6); // 0.3 ft
  assert.deepEqual(plank.hinges.at, [0.13, 0.55, 0.87]);
  // P2 hangs a board door's middle hinge on its own mid rail, wherever the spec puts it.
  assert.deepEqual(drawnDoorLook({ v: 1, base: "zbrace", src: { leaves: 1, hinge: "left" }, frame: { rails: [0.48] } }, { sizeIn: [36, 80], leaves: 1 }).hinges.at, [0.13, 0.48, 0.87]);
  close(plank.hinges.lenIn, (0.11 + 1.15) * 12);
  assert.deepEqual(plank.brace, { t: "z", from: "hinge" });
  assert.equal(plank.meet, null);

  const unsized = drawnDoorLook({ v: 1, base: "basic", src: { leaves: 2, hinge: "left" } }, { sizeIn: null, leaves: 2 });
  assert.equal(unsized.fIn, null);
  assert.equal(unsized.hinges.count, null);
  assert.equal(unsized.hinges.lenIn, null);

  // A spec's own frame is capped as the plan says (20% of the leaf's width).
  assert.ok(drawnDoorLook({ ...ZDOOR, frame: { fIn: 8 } }, { sizeIn: [24, 80], leaves: 1 }).fIn < 8);
  const leaf = doorLeafFt([72, 76], 2, "basic");
  close(leaf.w, 2.92);
  close(leaf.h, 76 / 12 - 0.25);
});

// ─── every bar triggers ───────────────────────────────────────────────────────────────────────────
test("leaves: 100% exact, so one wrong run in twenty fails", () => {
  const c = tcase("z", ZDOOR);
  const two = edit(ZDOOR, "src.leaves", 2);
  assert.equal(bar(score(c, two, 0), "leaves").ok, true);
  assert.equal(bar(score(c, two, 1), "leaves").ok, false);
});

test("base, hinge side, hinge count: 95% exact (19 of 20 passes, 18 fails)", () => {
  const c = tcase("z", ZDOOR);
  for (const [key, bad] of [["base", edit(ZDOOR, "base", "plank")], ["hingeSide", edit(ZDOOR, "src.hinge", "right")], ["hingeCount", edit(edit(ZDOOR, "hinges.count", 2), "hinges.at", [0.2, 0.8])]]) {
    assert.equal(bar(score(c, bad, 1), key).ok, true, `${key} at 95%`);
    assert.equal(bar(score(c, bad, 2), key).ok, false, `${key} at 90%`);
  }
});

test("hinge type: 85% exact (17 of 20 passes, 16 fails)", () => {
  const c = tcase("z", ZDOOR), bad = edit(ZDOOR, "hinges.type", "butt");
  assert.equal(bar(score(c, bad, 3), "hingeType").ok, true);
  assert.equal(bar(score(c, bad, 4), "hingeType").ok, false);
});

test("hinge side guessed with no warning: any one fails; the warning or a read side clears it", () => {
  const c = tcase("z", ZDOOR);
  const runs = (more) => scoreCorpus([c], [draft("z", ZDOOR, 1, more)]);
  assert.equal(bar(runs({ sideFrom: "handle" }), "sideGuessNoWarn").ok, false);
  assert.equal(bar(runs({ sideFrom: "handle", warnings: [{ code: "hinge_side_handle", text: "..." }] }), "sideGuessNoWarn").ok, true);
  assert.equal(bar(runs({ sideFrom: "hinges" }), "sideGuessNoWarn").ok, true);
  // No sideFrom on the run: a photo whose hinges do not show makes any side a guess.
  const hidden = tcase("h", ZDOOR, { hingesVisible: false });
  assert.equal(bar(scoreCorpus([hidden], [draft("h", ZDOOR)]), "sideGuessNoWarn").value, 1);
  assert.equal(bar(scoreCorpus([hidden], [draft("h", ZDOOR, 1, { warnings: ["hinge_side_default"] })]), "sideGuessNoWarn").value, 0);
});

test("hinge type or count wrong with no warning: counted unless a hinge warning names it", () => {
  const c = tcase("z", ZDOOR), bad = edit(ZDOOR, "hinges.type", "strap");
  assert.equal(bar(scoreCorpus([c], [draft("z", bad)]), "hingeNoWarn").value, 1);
  assert.equal(bar(scoreCorpus([c], [draft("z", bad, 1, { warnings: ["closeup_hinges"] })]), "hingeNoWarn").value, 0);
  const fewer = edit(edit(ZDOOR, "hinges.count", 2), "hinges.at", [0.2, 0.8]);
  assert.equal(bar(scoreCorpus([c], [draft("z", fewer)]), "hingeNoWarn").value, 1);
  assert.equal(bar(scoreCorpus([c], [draft("z", fewer, 1, { warnings: ["hinge_count_split"] })]), "hingeNoWarn").value, 0);
});

// The four measured-number bars are twice their first values (Ahsan 2026-10-26), so each test also shows
// a miss past the old bar now passing.
test("hinge positions: within 10% of the leaf height; a different count is not scored twice", () => {
  const c = tcase("z", ZDOOR);
  assert.equal(bar(score(c, edit(ZDOOR, "hinges.at", [0.171, 0.5, 0.88]), 20), "hingeAt").ok, true); // past the old 5%
  assert.equal(bar(score(c, edit(ZDOOR, "hinges.at", [0.219, 0.5, 0.88]), 20), "hingeAt").ok, true);
  assert.equal(bar(score(c, edit(ZDOOR, "hinges.at", [0.221, 0.5, 0.88]), 1), "hingeAt").ok, false);
  const r = score(c, edit(edit(ZDOOR, "hinges.count", 2), "hinges.at", [0.2, 0.8]), 20);
  assert.equal(bar(r, "hingeAt").ok, null); // no data: the count bar carries it
  assert.equal(bar(r, "hingeCount").ok, false);
});

test("hinge length: within 4 in", () => {
  const c = tcase("z", ZDOOR);
  assert.equal(bar(score(c, edit(ZDOOR, "hinges.lenIn", 18.1), 20), "hingeLen").ok, true); // past the old 2 in
  assert.equal(bar(score(c, edit(ZDOOR, "hinges.lenIn", 19.9), 20), "hingeLen").ok, true);
  assert.equal(bar(score(c, edit(ZDOOR, "hinges.lenIn", 20.1), 1), "hingeLen").ok, false);
  assert.equal(bar(score(c, edit(ZDOOR, "hinges.lenIn", 11.9), 1), "hingeLen").ok, false);
});

test("rails: within 8% of the leaf height; a different rail count fails", () => {
  const c = tcase("z", ZDOOR);
  assert.equal(bar(score(c, edit(ZDOOR, "frame.rails", [0.541]), 20), "rails").ok, true); // past the old 4%
  assert.equal(bar(score(c, edit(ZDOOR, "frame.rails", [0.579]), 20), "rails").ok, true);
  assert.equal(bar(score(c, edit(ZDOOR, "frame.rails", [0.581]), 1), "rails").ok, false);
  assert.equal(bar(score(c, edit(ZDOOR, "frame.rails", [0.3, 0.5]), 1), "rails").ok, false);
});

test("frame width: within 2 in, the stiles and the rail height both", () => {
  const c = tcase("z", ZDOOR);
  // fIn keeps one decimal in the cleaner, so the steps are 0.1 in.
  assert.equal(bar(score(c, edit(ZDOOR, "frame.fIn", 6.6), 20), "frame").ok, true); // past the old 1 in
  assert.equal(bar(score(c, edit(ZDOOR, "frame.fIn", 3.6), 20), "frame").ok, true);
  assert.equal(bar(score(c, edit(ZDOOR, "frame.fIn", 3.4), 1), "frame").ok, false);
  assert.equal(bar(score(c, edit(ZDOOR, "frame.railHIn", 6.1), 1), "frame").ok, false);
  // An absent fIn is today's rule: 3.6 in on this door, 1.9 in off the truth's 5.5, inside the bar.
  assert.equal(bar(score(c, edit(ZDOOR, "frame.fIn", undefined), 20), "frame").ok, true);
  assert.equal(bar(score(c, edit(edit(ZDOOR, "frame.fIn", undefined), "frame.railHIn", undefined), 1), "frame").ok, true);
});

test("brace direction: the leaf's Z and a panel's Z, 95% exact", () => {
  const c = tcase("z", ZDOOR);
  assert.equal(bar(score(c, edit(ZDOOR, "brace.from", "strike"), 1), "braceDir").ok, true);
  assert.equal(bar(score(c, edit(ZDOOR, "brace.from", "strike"), 2), "braceDir").ok, false);
  const d = tcase("d", LITES);
  assert.equal(bar(score(d, edit(LITES, "panels[0].zFrom", "strike"), 2), "braceDir").ok, false);
});

test("panel fills (and the leaf brace): 90% exact", () => {
  const c = tcase("z", ZDOOR);
  // 2 fills + the brace = 3 rows a run: 6 bad rows of 60 is 90%, 7 is not.
  const bad = edit(ZDOOR, "panels[1].fill", "lite");
  assert.equal(bar(score(c, bad, 6), "panelFills").ok, true);
  assert.equal(bar(score(c, bad, 7), "panelFills").ok, false);
  assert.equal(bar(score(c, edit(ZDOOR, "brace.t", "x"), 7), "panelFills").ok, false);
});

test("parts: F1 at least 0.8, matched by type and overlap", () => {
  const d = tcase("d", LITES);
  const nudged = edit(edit(LITES, "parts[0].u0", 0.25), "parts[1].u1", 0.35); // IoU > 0.5, board ends within 0.08
  assert.equal(bar(scoreCorpus([d], [draft("d", nudged)]), "parts").value, 1);
  const moved = edit(LITES, "parts[0]", { t: "lite", u0: 0.2, v0: 0.1, u1: 0.8, v1: 0.4 }); // same type, no overlap
  const r = scoreCorpus([d], [draft("d", moved)]);
  assert.equal(bar(r, "parts").value, 0.5); // 1 matched, 1 missed, 1 extra
  assert.equal(bar(r, "parts").ok, false);
  const retyped = edit(LITES, "parts[0].t", "vent");
  assert.equal(bar(scoreCorpus([d], [draft("d", retyped)]), "parts").ok, false);
});

test("handle type and meet: 90% exact", () => {
  const d = tcase("d", LITES);
  // handle + meet = 2 rows a run: 4 bad of 40 is 90%, 5 is not.
  assert.equal(bar(score(d, edit(LITES, "handle.type", "pull"), 4), "handleMeet").ok, true);
  assert.equal(bar(score(d, edit(LITES, "meet.type", "astragal"), 5), "handleMeet").ok, false);
});

test("colour roles: 90% exact; an absent members role follows the frame", () => {
  const d = tcase("d", LITES);
  // 3 roles a run: 6 bad of 60 is 90%, 7 is not.
  assert.equal(bar(score(d, edit(LITES, "colors.members", "trim"), 6), "colorRoles").ok, true);
  assert.equal(bar(score(d, edit(LITES, "colors.members", undefined), 7), "colorRoles").ok, false);
});

test("refusals: the refusal set refused with the right code; a draft or another code fails", () => {
  const r = REFUSE("g");
  const ok = { case: "g", run: 1, outcome: "refused", refuse: { code: "ai_door_unsupported", reason: "unsupported" } };
  assert.equal(bar(scoreCorpus([r], [ok]), "refusals").ok, true);
  assert.equal(bar(scoreCorpus([r], [{ ...ok, refuse: { code: "ai_door_refused", reason: "not_door" } }]), "refusals").ok, false);
  assert.equal(bar(scoreCorpus([r], [{ ...ok, refuse: { code: "ai_door_unsupported", reason: "leaves" } }]), "refusals").ok, false);
  assert.equal(bar(scoreCorpus([r], [draft("g", ZDOOR)]), "refusals").ok, false);
});

test("good photos refused: at most 5%", () => {
  const c = tcase("z", ZDOOR);
  const runs = (k) => Array.from({ length: 20 }, (_, i) => (i < k ? { case: "z", run: i + 1, outcome: "refused", refuse: { code: "ai_door_refused", reason: "blocked" } } : draft("z", ZDOOR, i + 1)));
  assert.equal(bar(scoreCorpus([c], runs(1)), "goodRefused").ok, true);
  assert.equal(bar(scoreCorpus([c], runs(2)), "goodRefused").ok, false);
  // A refused good photo is not also charged to the field bars.
  assert.equal(bar(scoreCorpus([c], runs(2)), "base").detail, "18/18 pass");
});

test("edge-map F1: every run at or above its own photo's bar", () => {
  const c = tcase("z", ZDOOR, { edgeF1Bar: 0.6 });
  assert.equal(bar(scoreCorpus([c], [draft("z", ZDOOR, 1, { edgeF1: 0.6 })]), "edgeF1").ok, true);
  assert.equal(bar(scoreCorpus([c], [draft("z", ZDOOR, 1, { edgeF1: 0.59 })]), "edgeF1").ok, false);
  assert.equal(bar(scoreCorpus([tcase("z", ZDOOR)], [draft("z", ZDOOR)]), "edgeF1").ok, null);
});

test("time per press: p50 at most 6 minutes, none past 8; cost: none past $3.00", () => {
  const c = tcase("z", ZDOOR);
  const at = (ms, cents = 100) => ms.map((m, i) => draft("z", ZDOOR, i + 1, { ms: m, costCents: cents }));
  assert.equal(bar(scoreCorpus([c], at([300_000, 360_000, 400_000])), "timeP50").ok, true);
  assert.equal(bar(scoreCorpus([c], at([300_000, 360_001, 400_000])), "timeP50").ok, false);
  assert.equal(bar(scoreCorpus([c], at([480_000])), "timeMax").ok, true);
  assert.equal(bar(scoreCorpus([c], at([480_001])), "timeMax").ok, false);
  assert.equal(bar(scoreCorpus([c], at([1000], 300)), "costMax").ok, true);
  assert.equal(bar(scoreCorpus([c], at([1000], 301)), "costMax").ok, false);
  const lost = scoreCorpus([c], [draft("z", ZDOOR, 1, { ms: 1, skipped: { selfCheckClock: true, ceiling: true }, costCents: 1 })]);
  assert.match(bar(lost, "timeMax").detail, /^1\/1 presses lost/);
  assert.match(bar(lost, "costMax").detail, /^1\/1 presses had a call skipped/);
});

test("see-through rays and vocabulary gaps: zero", () => {
  const c = tcase("z", ZDOOR);
  assert.equal(bar(scoreCorpus([c], [draft("z", ZDOOR, 1, { rayMisses: 0 })]), "rayMisses").ok, true);
  assert.equal(bar(scoreCorpus([c], [draft("z", ZDOOR, 1, { rayMisses: 1 })]), "rayMisses").ok, false);
  assert.equal(bar(scoreCorpus([c], [draft("z", ZDOOR, 1, { vocabGaps: [] })]), "vocabGaps").ok, true);
  assert.equal(bar(scoreCorpus([c], [draft("z", ZDOOR, 1, { vocabGaps: ["arched top"] })]), "vocabGaps").ok, false);
});

test("the bar table is section 9's (plus the hardware finish, 10-27), one row a bar", () => {
  assert.deepEqual(DOOR_SCORE_BARS.map((b) => b.key), [
    "leaves", "base", "hingeSide", "sideGuessNoWarn", "hingeCount", "hingeType", "hingeNoWarn", "hingeAt", "hingeLen",
    "rails", "frame", "braceDir", "panelFills", "parts", "handleMeet", "hardwareFinish", "colorRoles", "refusals", "goodRefused", "edgeF1",
    "timeP50", "timeMax", "costMax", "rayMisses", "vocabGaps",
  ]);
});

// ─── what the photo cannot say ────────────────────────────────────────────────────────────────────
test("unscored fields, other accepted values and alternative specs never count as wrong", () => {
  const bad = edit(ZDOOR, "handle.type", "ring");
  assert.equal(bar(score(tcase("z", ZDOOR, { unscored: { "handle.type": "not in the photo" } }), bad, 20), "handleMeet").ok, null);
  const hidden = edit(edit(ZDOOR, "hinges.type", "hidden"), "hinges.count", 0);
  const r = score(tcase("z", ZDOOR, { accept: { "hinges.type": ["hidden"], "hinges.count": [0] } }), edit(hidden, "hinges.at", undefined), 20);
  assert.equal(bar(r, "hingeType").ok, true);
  assert.equal(bar(r, "hingeCount").ok, true);
  assert.equal(bar(r, "hingeAt").ok, null); // no hinges to place
  // A lite part, or a lock rail with a lite fill: whichever the run is closer to.
  const part = { ...LITES, src: { leaves: 1, hinge: "left" }, frame: { rails: [] }, panels: [{ fill: "none" }], parts: [LITES.parts[0]] };
  const fill = { ...part, frame: { rails: [0.55] }, panels: [{ fill: "none" }, { fill: "lite", rows: 2, cols: 2 }], parts: [] };
  const both = tcase("s", part, { alts: [fill] });
  const res = scoreCorpus([both], [draft("s", fill)]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.perCase[0].matched, ["alts[0]"]);
  assert.equal(scoreCorpus([tcase("s", part)], [draft("s", fill)]).ok, false);
});

test("a door with no size leaves its inch bars unscored, never passed", () => {
  const c = tcase("z", edit(ZDOOR, "frame.fIn", undefined), { sizeIn: null });
  const r = scoreCorpus([c], [draft("z", ZDOOR)]);
  assert.equal(bar(r, "frame").detail.includes("not scored"), true);
  assert.deepEqual(r.needsSize, ["z"]);
  assert.equal(bar(r, "rails").ok, true); // fractions need no size
});

test("wrong with no warning is reported for every field", () => {
  const c = tcase("z", ZDOOR);
  const r = scoreCorpus([c], [draft("z", edit(ZDOOR, "base", "plank")), draft("z", edit(ZDOOR, "base", "xbrace"), 2, { warnings: ["base_split"] })]);
  assert.deepEqual(r.wrongNoWarning.base, { wrong: 2, noWarning: 1 });
  assert.match(formatReport(r), /base: 2 wrong, 1 with no warning/);
});

// ─── flips, the self-check, bad specs ─────────────────────────────────────────────────────────────
test("flips: a field whose answer changes between the 3 runs of one photo", () => {
  const c = tcase("z", ZDOOR);
  const r = scoreCorpus([c], [draft("z", ZDOOR, 1), draft("z", edit(ZDOOR, "base", "plank"), 2), draft("z", edit(ZDOOR, "frame.rails", [0.52]), 3)]);
  assert.deepEqual(r.flips.base, { flipped: 1, cases: 1 });
  assert.deepEqual(r.flips["frame.rails"], { flipped: 0, cases: 1 }); // 0.02 apart: inside the rails bar
  const o = scoreCorpus([c], [draft("z", ZDOOR, 1), { case: "z", run: 2, outcome: "failed", error: "ai_door_timeout" }]);
  assert.deepEqual(o.flips.outcome, { flipped: 1, cases: 1 });
});

test("the self-check: fields it made better and fields it made worse", () => {
  const c = tcase("z", ZDOOR);
  const better = draft("z", ZDOOR, 1, { preCheck: edit(ZDOOR, "base", "xbrace") });
  const worse = draft("z", edit(ZDOOR, "panels[0].fill", "x"), 2, { preCheck: ZDOOR });
  const r = scoreCorpus([c], [better, worse]);
  assert.deepEqual(r.selfCheck, { runs: 2, better: { base: 1 }, worse: { "panels[0].fill": 1 } });
});

test("a spec the cleaner refuses is a failed press, not a scored one", () => {
  const c = tcase("z", ZDOOR);
  const r = scoreCorpus([c], [draft("z", edit(ZDOOR, "src.leaves", 3))]);
  assert.equal(r.perCase[0].outcomes[0], "failed");
  assert.equal(bar(r, "leaves").ok, null);
});

test("checkTruthCase: a truth file must clean, keep every key, and say its status", () => {
  assert.deepEqual(checkTruthCase(tcase("z", ZDOOR)), []);
  assert.deepEqual(checkTruthCase(REFUSE("g")), []);
  assert.match(checkTruthCase(tcase("z", edit(ZDOOR, "frame.fIn", 99))).join(), /loses keys/);
  assert.match(checkTruthCase(tcase("z", edit(ZDOOR, "base", "slab"))).join(), /does not clean/);
  assert.match(checkTruthCase({ ...tcase("z", ZDOOR), status: undefined }).join(), /no status/);
  assert.match(checkTruthCase({ ...REFUSE("g"), refuse: { code: "nope" } }).join(), /refuse.code/);
});

// ─── the renderer's rules, read off both twins ────────────────────────────────────────────────────
test("every renderer rule the scorer mirrors is still in BOTH designer twins", () => {
  for (const f of ["StructureStudio.jsx", "structure-studio.component.js"]) {
    const src = readFileSync(join(REPO_ROOT, f), "utf8");
    for (const r of DOOR_RENDER_RULES) assert.ok(src.includes(r.needle), `${r.name} is gone from ${f}: re-anchor DOOR_RENDER_RULES and drawnDoorLook`);
  }
});

// ─── the sim harness ──────────────────────────────────────────────────────────────────────────────
// A synthetic corpus in the system temp folder: one single basic door, one refusal, and three recorded
// Stage A answers for the door, in pixel points on a 360 x 800 photo of a 36 x 80 in door.
const BASIC = {
  v: 1, base: "basic", src: { leaves: 1, hinge: "left" }, frame: { fIn: 3.5, railHIn: 3.5, rails: [0.42] },
  panels: [{ fill: "none" }, { fill: "none" }], hinges: { type: "tstrap", count: 3, at: [0.06, 0.42, 0.94], lenIn: 11.5, finish: "black" },
  handle: { type: "barn", v: "rail", finish: "black" }, colors: { infill: "door", frame: "trim" },
};
const READ = {
  measure: {
    size: [360, 800],
    leaves: [[[0, 0], [360, 0], [360, 800], [0, 800]]],
    rails: [
      { top: [[0, 0], [360, 0]], bottom: [[0, 35], [360, 35]] },
      { top: [[0, 446.5], [360, 446.5]], bottom: [[0, 481.5], [360, 481.5]] },
      { top: [[0, 765], [360, 765]], bottom: [[0, 800], [360, 800]] },
    ],
    stiles: [{ inner: [[35, 0], [35, 800]] }, { inner: [[325, 0], [325, 800]] }],
    braces: [],
    hinges: [752, 464, 48].map((y) => ({ pivot: [2, y], tip: [117, y] })),
    handle: [345, 464],
  },
  refuse: null, base: "basic", leaves: 1, field: "grooved", brace: "none", panels: ["none", "none"],
  hinges: { type: "tstrap" }, handle: { type: "barn" }, observed: ["a mid rail"], unexplained: [],
};
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
function synthCorpus() {
  const dir = mkdtempSync(join(tmpdir(), "doorsim-"));
  made.push(dir);
  writeFileSync(join(dir, "a.truth.json"), JSON.stringify(tcase("a", BASIC)));
  writeFileSync(join(dir, "g.truth.json"), JSON.stringify(REFUSE("g")));
  mkdirSync(join(dir, "reads"));
  writeFileSync(join(dir, "reads", "a.json"), JSON.stringify({ photo: [360, 800], runs: [0, 1, 2].map(() => ({ reads: [READ, READ, READ], ms: 200_000, costCents: 110 })) }));
  writeFileSync(join(dir, "reads", "g.json"), JSON.stringify({ photo: [360, 800], runs: [{ reads: [{ refuse: "unsupported" }, { refuse: "unsupported" }, { refuse: "unsupported" }] }] }));
  return dir;
}

test("sim, truth mode: the truth answered exactly passes every bar it can score", async () => {
  const dir = synthCorpus();
  const runs = truthRuns([tcase("a", BASIC), REFUSE("g")]);
  assert.equal(runs.length, 6);
  const { out, result } = await main(["--corpus", dir, "--out", join(dir, "out")]);
  assert.equal(result.ok, true);
  for (const f of ["runs.jsonl", "score.json", "report.txt", "sheet.html"]) assert.ok(existsSync(join(out, f)), f);
  assert.match(readFileSync(join(out, "sheet.html"), "utf8"), /Door looks sim: PASS/);
});

test("sim, recorded mode: the server's own maths over recorded answers come back within the bars", async () => {
  const dir = synthCorpus();
  const { runs, skipped } = recordedRuns([tcase("a", BASIC), REFUSE("g")], dir);
  assert.deepEqual(skipped, []);
  assert.equal(runs.length, 4);
  assert.deepEqual(runs.at(-1).refuse, { code: "ai_door_unsupported", reason: "unsupported" });
  const res = scoreCorpus([tcase("a", BASIC), REFUSE("g")], runs);
  assert.equal(res.ok, true, formatReport(res));
  assert.equal(bar(res, "timeP50").value, 200_000);
  // No size, no measuring: the points are pixels until the size turns them into inches.
  assert.deepEqual(recordedRuns([tcase("a", BASIC, { sizeIn: null })], dir).skipped, ["a: needs size"]);
  const { result } = await main(["--corpus", dir, "--mode", "recorded", "--out", join(dir, "rec")]);
  assert.equal(result.ok, true);
});

test("sim, replay mode: scores a runs file", async () => {
  const dir = synthCorpus();
  writeFileSync(join(dir, "runs.jsonl"), [draft("a", edit(BASIC, "base", "dutch")), draft("a", BASIC, 2)].map((r) => JSON.stringify(r)).join("\n"));
  const { result } = await main(["--corpus", dir, "--mode", "replay", "--runs", join(dir, "runs.jsonl"), "--out", join(dir, "rp")]);
  assert.equal(bar(result, "base").value, 0.5);
});

test("sim: the corpus and every output must live outside the repo", async () => {
  const dir = synthCorpus();
  assert.equal(insideRepo(join(REPO_ROOT, "tests")), true);
  assert.equal(insideRepo(dir), false);
  await assert.rejects(main(["--corpus", join(REPO_ROOT, "tests")]), /outside the repo/);
  await assert.rejects(main(["--corpus", dir, "--out", join(REPO_ROOT, "tmp-door-sim")]), /outside the repo/);
});

test("sim, live mode: refused without a named batch, Ahsan's yes for it, a budget, and an API key", async () => {
  const dir = synthCorpus();
  assert.throws(() => liveGate({ presses: 3, env: {} }), /needs --batch/);
  assert.throws(() => liveGate({ batch: "b1", presses: 3, maxDollars: 100, env: {} }), /DOOR_SIM_LIVE_BATCH is not "b1"/);
  assert.throws(() => liveGate({ batch: "b1", presses: 3, maxDollars: 8, env: { DOOR_SIM_LIVE_BATCH: "b1" } }), /up to \$9\.00/);
  assert.doesNotThrow(() => liveGate({ batch: "b1", presses: 3, maxDollars: 9, env: { DOOR_SIM_LIVE_BATCH: "b1" } }));
  await assert.rejects(liveGenerate(tcase("a", BASIC), 1, { corpusDir: dir, env: {} }), /needs ANTHROPIC_API_KEY/);
  await assert.rejects(main(["--corpus", dir, "--mode", "live", "--out", join(dir, "lv")], {}), /needs --batch/);
  await assert.rejects(main(["--corpus", dir, "--mode", "live", "--batch", "b1", "--max-dollars", "100", "--out", join(dir, "lv")], { DOOR_SIM_LIVE_BATCH: "b1" }), /needs ANTHROPIC_API_KEY/);
});

// The browser's image work, stood in for: a "photo" is any file, sized 360 x 800 (the synthetic READ's frame).
const fakeOps = () => ({
  size: async () => [360, 800],
  render: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  pixels: async () => ({ w: 360, h: 800, rgba: new Uint8Array(360 * 800 * 4).fill(128) }),
  crop: async ({ windows }) => windows.map(() => "Y3JvcA=="),
  close: async () => {},
});
test("sim, live mode: one press through P4's pipeline (the model stubbed), its ledger row mapped to a run", async () => {
  const dir = synthCorpus();
  const t = tcase("a", BASIC, { photo: { file: "a.jpg" } });
  writeFileSync(join(dir, "a.jpg"), "x");
  const m = fakeModel({ stageA: [READ, READ, READ], hinges: { type: "tstrap", finish: "black" }, handle: { type: "barn", finish: "black" } });
  const run = await liveGenerate(t, 2, { corpusDir: dir, env: { ANTHROPIC_API_KEY: "test" }, fetchImpl: m.fetch, makeOps: async () => fakeOps() });
  assert.equal(run.outcome, "draft", JSON.stringify(run));
  assert.deepEqual([run.case, run.run, run.mode, run.spec.base, run.tries], ["a", 2, "live", "basic", 1]);
  assert.ok(run.costCents > 0 && run.ms >= 0);
  assert.equal(run.note, "not straightened (no photo.quad)");
  assert.equal(m.count("stageA"), 3);
  const sent = m.sent.find((x) => x.kind === "stageA").body.messages[0].content[0];
  assert.deepEqual(sent.source.type, "base64", "the fitted photo itself, never a URL");
  const res = scoreCorpus([t], [run]);
  assert.ok(res.bars.find((b) => b.key === "base")?.ok !== false, formatReport(res));
  // A cut-off first try gets its one lean retry, at effort low.
  const cut = fakeModel({ stageA: (i) => (i < 3 ? "cutoff" : READ), hinges: { type: "tstrap" }, handle: { type: "barn" } });
  const retried = await liveGenerate(t, 1, { corpusDir: dir, env: { ANTHROPIC_API_KEY: "test" }, fetchImpl: cut.fetch, makeOps: async () => fakeOps() });
  assert.deepEqual([retried.outcome, retried.tries], ["draft", 2]);
  assert.deepEqual(cut.sent.filter((x) => x.kind === "stageA").map((x) => x.body.output_config.effort), ["high", "high", "high", "low", "low", "low"]);
});

test("a press's ledger rows to its run record: the last row decides, costs and times add up, a self-check round is the final spec", () => {
  const at = (s) => `2026-10-26T12:00:${String(s).padStart(2, "0")}Z`;
  const failed = { created_at: at(0), status: "failed", drafted: null, warnings: [], draft_ms: 150_000, tokens: { costCents: 40, failure: { code: "ai_door_unparseable" }, skipped: {} } };
  const done = { created_at: at(30), status: "done", drafted: BASIC, warnings: [{ code: "closeup_meet" }], draft_ms: 100_000, tokens: { costCents: 60, vocabGaps: ["a knob"], sideFrom: "hinges", skipped: { ceiling: true } } };
  const r = runFromDoorLedgerRows([done, failed], { case: "a", run: 3 });
  assert.deepEqual([r.outcome, r.spec, r.costCents, r.ms, r.tries, r.sideFrom, r.vocabGaps, r.skipped], ["draft", BASIC, 100, 250_000, 2, "hinges", ["a knob"], { ceiling: true }]);
  const checked = runFromDoorLedgerRows([{ ...done, self_check_rounds: [{ spec: ZDOOR, costCents: 13 }] }], { case: "a", run: 1 });
  assert.deepEqual([checked.spec, checked.preCheck, checked.costCents], [ZDOOR, BASIC, 73]);
  const refused = runFromDoorLedgerRows([{ ...failed, tokens: { refuse: { code: "ai_door_unsupported", reason: "unsupported" } } }], { case: "g", run: 1 });
  assert.deepEqual([refused.outcome, refused.refuse], ["refused", { code: "ai_door_unsupported", reason: "unsupported" }]);
  assert.deepEqual([runFromDoorLedgerRows([failed], { case: "a", run: 1 }).error, runFromDoorLedgerRows([], { case: "a", run: 1 }).error], ["ai_door_unparseable", "no_row"]);
  assert.equal(runFromDoorLedgerRows([{ ...failed, tokens: { ...failed.tokens, skipped: { leanRetryClock: true } } }], { case: "a", run: 1 }).skipped.leanRetryClock, true);
});

// ─── the hardware's finish ────────────────────────────────────────────────────────────────────────
test("the hinge and handle finish is barred: black iron drafted as bronze fails it, and a finish warning covers it", () => {
  const c = tcase("z", ZDOOR);
  assert.equal(bar(score(c, edit(ZDOOR, "hinges.finish", "bronze"), 1), "hardwareFinish").ok, true, "1 of 20 is within 0.9");
  assert.equal(bar(score(c, edit(edit(ZDOOR, "hinges.finish", "bronze"), "handle.finish", "bronze"), 10), "hardwareFinish").ok, false);
  const run = draft("z", edit(ZDOOR, "handle.finish", "bronze"), 1, { warnings: [{ code: "handle_finish_unsure" }] });
  const row = scoreRun(c, run).rows.find((r) => r.path === "handle.finish");
  assert.deepEqual([row.status, row.warned], ["fail", true]);
  // Hidden hinges have no finish to score.
  const hidden = edit(edit(ZDOOR, "hinges.type", "hidden"), "hinges.count", 0);
  const rows = scoreRun(tcase("h", hidden), draft("h", hidden)).rows;
  assert.equal(rows.some((r) => r.path === "hinges.finish"), false);
});

// ─── what P2 draws for hidden and butt hinges, and the guards on its rules ───────────────────────
test("hidden hinges draw none whatever count Stage A left; butt hinges draw no strap, so no length is scored", () => {
  const hiddenRun = edit(edit(ZDOOR, "hinges.type", "hidden"), "hinges.count", 3);
  const drawn = drawnDoorLook(hiddenRun, { sizeIn: [36, 80], leaves: 1 }).hinges;
  assert.deepEqual([drawn.count, drawn.at, drawn.lenIn], [0, [], null]);
  const hiddenTruth = edit(edit(ZDOOR, "hinges.type", "hidden"), "hinges.count", 0);
  const res = score(tcase("h", hiddenTruth), hiddenRun, 20);
  assert.deepEqual([bar(res, "hingeCount").ok, bar(res, "hingeNoWarn").ok], [true, true]);
  // Butt: no strap is drawn, with or without lenIn, so the length row is "na" either way round.
  const butt = edit(ZDOOR, "hinges.type", "butt");
  assert.equal(drawnDoorLook(butt, { sizeIn: [36, 80], leaves: 1 }).hinges.lenIn, null);
  for (const lenIn of [3, 12, 30]) {
    const row = scoreRun(tcase("b", butt), draft("b", edit(butt, "hinges.lenIn", lenIn))).rows.find((r) => r.path === "hinges.lenIn");
    assert.equal(row.status, "na", `lenIn ${lenIn}`);
  }
  const rows = scoreRun(tcase("z", ZDOOR), draft("z", butt)).rows;
  assert.deepEqual([rows.find((r) => r.path === "hinges.lenIn").status, rows.find((r) => r.path === "hinges.type").status], ["na", "fail"]);
});

test("the needles catch a renderer that hangs hinges on another mid rail, or draws another finish by default", () => {
  const mutate = (src, from, to) => {
    const out = src.replace(from, to);
    assert.notEqual(out, src, `the mutation found nothing to change: ${from}`);
    return out;
  };
  for (const f of ["StructureStudio.jsx", "structure-studio.component.js"]) {
    const src = readFileSync(join(REPO_ROOT, f), "utf8");
    const lowestFirst = mutate(src, "const byMid = mids.slice().sort((p, q) => Math.abs(p - (y0 + h / 2)) - Math.abs(q - (y0 + h / 2)));", "const byMid = mids.slice().sort((p, q) => p - q);");
    assert.ok(DOOR_RENDER_RULES.some((r) => !lowestFirst.includes(r.needle)), `${f}: reordering the mid rails passes every needle`);
    const galv = mutate(src, 'SS_DOOR_FINISH_HEX[f.finish || "black"]', 'SS_DOOR_FINISH_HEX[f.finish || "galv"]');
    assert.ok(DOOR_RENDER_RULES.some((r) => !galv.includes(r.needle)), `${f}: another default finish passes every needle`);
    const sixFt = mutate(src, "const count = hs.count != null ? hs.count : h >= 5 ? 3 : 2;", "const count = hs.count != null ? hs.count : h >= 6 ? 3 : 2;");
    assert.ok(DOOR_RENDER_RULES.some((r) => !sixFt.includes(r.needle)), `${f}: another hinge-count rule passes every needle`);
  }
  // The scorer's half of the finish rule: its own finish, else black.
  const fin = drawnDoorLook({ v: 1, base: "zbrace", src: { leaves: 1, hinge: "left" }, hinges: { finish: "galv" }, handle: { type: "lever" } }, { sizeIn: [36, 80], leaves: 1 });
  assert.deepEqual([fin.hinges.finish, fin.handle.finish], ["galv", "black"]);
});

test("hinge rows are held on the leaf as P2 holds them: by the reach of the piece drawn", () => {
  // A basic single 36 x 80 with a 1.5 in frame: butt hinges at the table's 0.01 / 0.99 are drawn a knuckle's
  // half-height (0.16 ft) in from the leaf's ends, a pintle's pin 1.2 plates (0.075 ft); a strap's plate
  // (half the frame board, 0.0625 ft) is under 1% of the leaf, so a strap at 0.01 stays.
  const base = { v: 1, base: "basic", src: { leaves: 1, hinge: "left" }, frame: { fIn: 1.5 } };
  const drawnAt = (hinges) => drawnDoorLook({ ...base, hinges }, { sizeIn: [36, 80], leaves: 1 }).hinges.at;
  const leafH = doorLeafFt([36, 80], 1, "basic").h;
  const butt = drawnAt({ type: "butt", count: 2, at: [0.01, 0.99] });
  assert.ok(Math.abs(butt[0] - 0.16 / leafH) < 1e-9 && Math.abs(butt[1] - (1 - 0.16 / leafH)) < 1e-9, JSON.stringify(butt));
  const pintle = drawnAt({ type: "pintle", count: 2, at: [0.01, 0.99] });
  assert.ok(Math.abs(pintle[0] - 0.075 / leafH) < 1e-9, JSON.stringify(pintle));
  assert.deepEqual(drawnAt({ type: "strap", count: 2, at: [0.01, 0.99] }), [0.01, 0.99]);
  assert.deepEqual(drawnAt({ type: "tstrap", count: 3, at: [0.2, 0.5, 0.8] }), [0.2, 0.5, 0.8]);
  // A short board door: a scroll's curl (1.65 x 0.8 x 0.085 ft) reaches past a plate of 3% of a 3.7 ft leaf.
  const short = drawnDoorLook({ v: 1, base: "plank", src: { leaves: 1, hinge: "left" }, hinges: { type: "scroll", count: 2, at: [0.01, 0.99] } }, { sizeIn: [24, 46], leaves: 1 });
  const sh = doorLeafFt([24, 46], 1, "plank").h;
  assert.ok(Math.abs(short.hinges.at[0] - (1.65 * 0.8 * 0.085) / sh) < 1e-9, JSON.stringify(short.hinges.at));
  // The renderer's halves of these rules are pinned: changing them breaks a needle.
  for (const f of ["StructureStudio.jsx", "structure-studio.component.js"]) {
    const src = readFileSync(join(REPO_ROOT, f), "utf8");
    for (const [from, to] of [
      [': type === "scroll" ? sw0 * 1.65 : 0);', ': 0);'],
      ['const reachH = Math.max(plateH, type === "butt" ? Math.min(0.16, h * 0.05)', 'const reachH = Math.max(plateH, type === "butt" ? plateH'],
      ['SS_DOOR_FINISH_HEX[f.finish || "black"]) : null;', 'SS_DOOR_FINISH_HEX[f.finish || "black"]) : SS_DOOR_FINISH_HEX.galv;'],
      ["2 * bh, 12), hingeMat, wf, he, cy, 0.172), tagH);\n        return;", "2 * bh, 12), hingeMat, wf, he, cy, 0.172), tagH);"],
    ]) {
      const out = src.split(from).join(to);
      assert.notEqual(out, src, `${f}: the mutation found nothing to change: ${from.slice(0, 40)}`);
      assert.ok(DOOR_RENDER_RULES.some((r) => !out.includes(r.needle)), `${f}: "${to.slice(0, 40)}" passes every needle`);
    }
  }
});
