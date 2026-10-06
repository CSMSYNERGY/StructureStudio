// The compare step's arithmetic, and the one place the browser and the server have to agree.
//
// Everything the builder is shown after a generation — the two roof sliders, the roof read
// back in feet, the "What the check changed" list — is pure, lives in both hand-mirrored
// twins, and is lifted out and run here.
//
// THE LOAD-BEARING TEST IS THE FIRST ONE. The roof fix panel exists because a drafted gambrel
// came back with its two slopes two degrees apart and rendered as a plain gable; the server
// flags that with `gambrelRoofWarning`. A pair of sliders that could put a builder back into
// the state they opened the panel to escape would be worse than no panel, so the real
// gambrelRoofWarning — imported, not re-implemented — is run over the whole slider grid.
//
// The other reason this file exists: the change list's field names are the SERVER'S
// allow-list. A field the server can correct and the browser has no words for would reach the
// builder as `roof.tailSpacingIn`, so the two lists are compared directly.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  flagObservedNotes, frameKeyWarning, gambrelRoofWarning, knownDimsNote, porchAgreementWarning, SELF_CHECK_ALLOW,
  SELF_CHECK_BUDGET, wingsAgreementWarning,
} from "../styleD3.ts";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));
// The host whose onSelfCheck owns the check's real abort (the component only budgets with it).
const SHELL = await Deno.readTextFile(new URL("../../../../portal/12-shell.jsx", import.meta.url));

function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `selfCheckPanel_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  // d3FtIn, which every "in feet" line is written through.
  ["function d3FtIn(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  // The whole of the compare step's pure half.
  ["const SS_RENDER_MS =", "// Upload a list with BOUNDED CONCURRENCY"],
];
const blocks = REGIONS.map(([a, b]) => ({
  a,
  cmp: lift(CMP, "structure-studio.component.js", a, b),
  jsx: lift(JSX, "StructureStudio.jsx", a, b),
}));

Deno.test("every lifted compare-step region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `${blocks.map((b) => b.cmp).join("\n")}; return { SS_CHECKS, SS_VIEW_WORDS, SS_SPIN_STEP_DEG, SS_RENDER_MS, SS_CHECK_MS, ` +
    `SS_GAMBREL_BEND_DEG, ssGambrelFromSliders, ssGambrelSliders, ssRoofInFeet, ssChangeLine, SS_CHANGE_WORDS, ` +
    `SS_DRAFT_SERVER_MS, SS_CHECK_ROUNDS, SS_FLOW_MAX_MS, SS_SLOW_MS, ssCheckNext, ssMergeChanges, ssDrewWords, ssShotSig };`,
)() as Record<string, Any>;

// ── The sliders cannot build the roof the warning was written for ─────────────────────────

Deno.test("⚠️ NO PAIR OF SLIDER POSITIONS CAN PRODUCE A ROOF gambrelRoofWarning REFUSES", () => {
  // The real function, imported from the server's own module. Re-implementing the rule here
  // would let the two drift apart in exactly the direction that matters — the panel would
  // keep passing its own copy while the builder's save kept being flagged.
  let checked = 0;
  for (let bend = 0; bend <= 100; bend += 2) {
    for (let steep = 0; steep <= 100; steep += 2) {
      const roof = { type: "gambrel", ...F.ssGambrelFromSliders(bend, steep) };
      const warn = gambrelRoofWarning(roof);
      assert(warn === null, `bend ${bend} steep ${steep} -> ${JSON.stringify(roof)}: ${warn}`);
      checked++;
    }
  }
  assertEquals(checked, 51 * 51);
});

Deno.test("the derived peak is always above the bend, and inside the sanitiser's band", () => {
  for (let bend = 0; bend <= 100; bend += 5) {
    for (let steep = 0; steep <= 100; steep += 5) {
      const g = F.ssGambrelFromSliders(bend, steep);
      assert(g.ridgeRise > g.kneeRise, `${bend}/${steep}: ${JSON.stringify(g)}`);
      // sanitizeD3Spec's own clamps: kneeU 0..1, kneeRise 0..1, ridgeRise 0..1.5. A slider
      // that produced something outside them would be silently clamped on save into a roof
      // the builder never chose.
      assert(g.kneeU >= 0 && g.kneeU <= 1, String(g.kneeU));
      assert(g.kneeRise >= 0 && g.kneeRise <= 1, String(g.kneeRise));
      assert(g.ridgeRise >= 0 && g.ridgeRise <= 1.5, String(g.ridgeRise));
    }
  }
});

Deno.test("junk slider input still lands on a drawable roof", () => {
  // The value comes off a DOM range as a string, and a builder dragging past either stop is
  // the browser's business, not this function's.
  for (const pair of [["0", "0"], ["100", "100"], [NaN, 50], [-40, 400], ["x", "y"], [null, undefined]]) {
    const g = F.ssGambrelFromSliders(pair[0], pair[1]);
    assert(isFinite(g.kneeU) && isFinite(g.kneeRise) && isFinite(g.ridgeRise), JSON.stringify(pair));
    assertEquals(gambrelRoofWarning({ type: "gambrel", ...g }), null, JSON.stringify(pair));
  }
});

Deno.test("the sliders read back where a roof already is, including the drawn default", () => {
  // Mirrors d3RoofProfile's `||` defaults on purpose: a 0 or absent kneeU DRAWS at 0.55, so
  // the slider has to show 0.55 rather than the stop. gambrelRoofWarning reads it the same
  // way, and a panel that disagreed with the warning about where a roof IS would be arguing
  // with the message that opened it.
  const mid = F.ssGambrelSliders({});
  assertEquals(mid, F.ssGambrelSliders({ type: "gambrel", kneeU: 0.55, kneeRise: 0.55 }));
  assertEquals(F.ssGambrelSliders({ kneeU: 0.45, kneeRise: 0.25 }), { bendPct: 0, steepPct: 0 });
  assertEquals(F.ssGambrelSliders({ kneeU: 0.95, kneeRise: 0.95 }), { bendPct: 100, steepPct: 100 });
  // Out of the slider's own band is pinned to the stop rather than reported as a negative,
  // which would make the thumb jump off the track.
  assertEquals(F.ssGambrelSliders({ kneeU: 0.1, kneeRise: 2 }), { bendPct: 0, steepPct: 100 });
});

Deno.test("a slider round trip does not move a roof that was already in band", () => {
  for (const kneeU of [0.5, 0.6, 0.72, 0.9]) {
    for (const kneeRise of [0.3, 0.5, 0.72, 0.9]) {
      const back = F.ssGambrelFromSliders(...Object.values(F.ssGambrelSliders({ kneeU, kneeRise })) as [number, number]);
      // Within one slider step of 100, which is what the integer percentage costs.
      assert(Math.abs(back.kneeU - kneeU) <= 0.006, `${kneeU} -> ${back.kneeU}`);
      assert(Math.abs(back.kneeRise - kneeRise) <= 0.008, `${kneeRise} -> ${back.kneeRise}`);
    }
  }
});

// ── The roof, in feet, for a person holding a tape ────────────────────────────────────────

Deno.test("the confirm line reads a gambrel back in feet and inches", () => {
  // The one measured roof in the corpus, on a 16 ft span: the bend 0.28 of the half-span in from the
  // wall (2 ft 3 in), 0.72 of it up (5 ft 9 in), the peak 1.0 of it up (8 ft).
  const line = F.ssRoofInFeet({ type: "gambrel", kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1.0 }, 16);
  assertStringIncludes(line, "2 ft 3 in");
  assertStringIncludes(line, "5 ft 9 in");
  assertStringIncludes(line, "8 ft");
  // No ratios reach the screen. 0.72 is meaningless against a building, and the whole reason
  // the prompt is allowed to keep asking for ratios is that this line exists.
  assert(!/0\.\d/.test(line), line);
});

Deno.test("a gable and a shed each get their own sentence, and neither borrows the gambrel's", () => {
  const gable = F.ssRoofInFeet({ type: "gable", pitch: 0.5 }, 16);
  assertStringIncludes(gable, "4 ft");
  assert(!gable.includes("bend"), gable);
  const shed = F.ssRoofInFeet({ type: "shed", pitch: 0.25 }, 16);
  assertStringIncludes(shed, "4 ft");
  assertStringIncludes(shed, "high side");
  // An absent pitch draws at the renderer's own default rather than at nothing.
  assert(F.ssRoofInFeet({ type: "gable" }, 16).length > 0);
  assert(F.ssRoofInFeet(null, 16).length > 0);
});

Deno.test("with wings the roof sentence is the middle section's roof, above the middle section's walls", () => {
  // A raised centre 12 ft across under 0.67: its peak is 4 ft above ITS walls. Measured across the
  // whole 28 ft it read 9 ft 5 in "above the wall", and the builder checks this line against the video.
  const centre = F.ssRoofInFeet({ type: "gable", pitch: 0.67, wingSide: "both", wingWidthFt: 8 }, 12, true);
  assertEquals(centre, "The peak is 4 ft above the middle section's walls.");
  const gambrel = F.ssRoofInFeet({ type: "gambrel", kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1.0 }, 16, true);
  assertStringIncludes(gambrel, "back from the middle section's walls");
  assertStringIncludes(gambrel, "above them; the peak is 8 ft above the middle section's walls.");
  // Without wings, the sentence it always was.
  assertEquals(F.ssRoofInFeet({ type: "gable", pitch: 0.5 }, 16), "The peak is 4 ft above the wall.");
  assertEquals(F.ssRoofInFeet({ type: "gable", pitch: 0.5 }, 16, false), F.ssRoofInFeet({ type: "gable", pitch: 0.5 }, 16));
});

// ── The change list is written in the same words the panel uses ───────────────────────────

Deno.test("⚠️ every field the SERVER may correct has words the builder can read", () => {
  // The server's allow-list is the complete set of things that can appear in `changed[]`. A
  // field missing from here reaches a builder as `roof.tailSpacingIn` in the one list they
  // are meant to read item by item.
  const missing = (SELF_CHECK_ALLOW as readonly string[]).filter((f) => !(f in F.SS_CHANGE_WORDS));
  assertEquals(missing, [], `no builder-readable words for: ${missing.join(", ")}`);
});

Deno.test("the overhang is reported in INCHES, which is the whole point of reporting it", () => {
  // 1.0 ft against a 0.15 ft truth reads as a rounding. 12 in against 2 in is obviously wrong
  // at a glance. Same number, same clamp, different boundary — and this is the field the
  // model has never once got right in nineteen recorded generations.
  const line = F.ssChangeLine({ field: "roof.overhang", from: 1.0, to: 0.15, why: "" });
  assertEquals(line.label, "How far the roof sticks out past the wall");
  assertEquals(line.text, "12 in → 2 in");
});

Deno.test("a ratio is reported as a direction, never as a number", () => {
  // There is no builder-readable value for kneeU, so the line says which way it moved. A
  // number here would be the one thing the fix panel refuses to show, printed anyway.
  const up = F.ssChangeLine({ field: "roof.kneeU", from: 0.55, to: 0.75, why: "" });
  assertEquals(up.label, "Where the barn roof's bend sits");
  assertEquals(up.text, "increased");
  assertEquals(F.ssChangeLine({ field: "roof.kneeRise", from: 0.7, to: 0.4, why: "" }).text, "reduced");
  // A non-numeric pair cannot be read as a direction and says so rather than inventing one.
  assertEquals(F.ssChangeLine({ field: "roof.dormerOffsetU", from: null, to: "x", why: "" }).text, "changed");
});

Deno.test("a roof type is named the way the fix panel's tiles name it", () => {
  assertEquals(F.ssChangeLine({ field: "roof.type", from: "gable", to: "gambrel", why: "" }).text,
    "two straight slopes → a barn roof with a bend");
  assertEquals(F.ssChangeLine({ field: "roof.porchEnd", from: "front", to: "back", why: "" }).text,
    "the end you filmed first → the other end");
});

Deno.test("an unknown field still produces a line rather than an empty bullet", () => {
  // Nothing outside the allow-list can reach here today, and a field ADDED to the server's
  // list before this file learns the words for it must still render as something.
  const line = F.ssChangeLine({ field: "roof.somethingNew", from: 1, to: 2, why: "" });
  assertEquals(line.label, "roof.somethingNew");
  assertEquals(line.text, "increased");
});

// ── The four questions, and the clocks ────────────────────────────────────────────────────

Deno.test("the four questions are the measured failure list, in order", () => {
  assertEquals(F.SS_CHECKS.map((c: Any) => c[0]), ["roof", "porch", "walls", "colours"]);
  for (const [, question, hint] of F.SS_CHECKS) {
    assert(question.endsWith("?"), question);
    assert(hint.length > 10, hint);
    // Stated as things on a building, never as fields. A question naming a spec key is a
    // question only the person who wrote the spec can answer.
    assert(!/[a-z][A-Z]/.test(question + hint), `${question} / ${hint} reads like a field name`);
  }
});

Deno.test("⚠️ the clocks: the first round always fits, and no LATER round runs past eight minutes", () => {
  // THE BUDGET MOVED ON 2026-09-24, deliberately. This test used to pin 110 + 5 + 60 <= 180 s:
  // one round inside three minutes. The draft now has 125 s (max_tokens 8000 -> 12000) and the
  // check runs up to three rounds, so the rule is restated rather than loosened: the FIRST
  // round always fits inside SS_FLOW_MAX_MS, and a later round only starts while a whole round
  // still fits. call 1 is still deliberately NOT aborted here: abandoning a call that has
  // already taken the hold is how a slow generation becomes a lost $20.
  assertEquals(F.SS_CHECK_ROUNDS, 3);
  assert(F.SS_DRAFT_SERVER_MS + F.SS_RENDER_MS + F.SS_CHECK_MS <= F.SS_FLOW_MAX_MS,
    `${F.SS_DRAFT_SERVER_MS} + ${F.SS_RENDER_MS} + ${F.SS_CHECK_MS} is over ${F.SS_FLOW_MAX_MS}`);
  // EIGHT MINUTES since 2026-09-25: the draft is streamed and thinks at effort "high" inside the
  // server's 300 s (it was 125 s, capped by the gateway's 150 s of silence, and five minutes; then
  // 230 s and seven minutes, until live reads kept reaching 230 s).
  assertEquals(F.SS_DRAFT_SERVER_MS, 300000, "the streamed draft's model budget, portal-settings' 300 s");
  assertEquals(F.SS_FLOW_MAX_MS, 480000, "eight minutes is the ceiling this was designed to");
  assertEquals(F.SS_SLOW_MS, 360000, "\"Still going\" at six minutes, the end of the card's four to six");
  // A slow set-up can push the streamed draft's end to 330 s after the request (the server's rule is
  // 300 s or what is left of 330 s); the first round still fits after that.
  assert(330000 + F.SS_RENDER_MS + F.SS_CHECK_MS <= F.SS_FLOW_MAX_MS, "the first round fits after the latest streamed draft");
  // 140 s a round since 2026-09-26 (it was 100): the v2 check thinks at effort "high" inside the
  // server's 125 s.
  assertEquals(F.SS_CHECK_MS, 140000, "the check's client abort");
  assertEquals(F.SS_DRAFT_SERVER_MS + F.SS_RENDER_MS + F.SS_CHECK_MS, 445000, "300 + 5 + 140 = 445 s < 480 s");
  assertEquals(330000 + F.SS_RENDER_MS + F.SS_CHECK_MS, 475000, "330 + 5 + 140 = 475 s < 480 s");
  // The worst ordinary press: the slowest draft, then every round at its own ceiling, each one
  // started only when ssCheckNext allows it. Modelled as the loop runs: the draft is rendered once,
  // each round that corrects is RESHOT before ssCheckNext decides, so the first decision comes after
  // the first render, the first check and its reshoot.
  const worst = (draftMs: number) => {
    let t = draftMs + F.SS_RENDER_MS + F.SS_CHECK_MS + F.SS_RENDER_MS;
    let rounds = 1;
    for (let round = 0; ; round++) {
      const next = F.ssCheckNext({ verdict: "corrections", d3: {}, changed: [{ field: "roof.pitch" }] }, round, [], "b" + round, t);
      if (next) return { t, rounds, stop: next };
      t += F.SS_RENDER_MS + F.SS_CHECK_MS;
      rounds++;
    }
  };
  const one = worst(F.SS_DRAFT_SERVER_MS);
  assert(one.t <= F.SS_FLOW_MAX_MS, `the worst ordinary press ends at ${one.t}`);
  // A draft that used its whole 300 s leaves no room for a second round at the ceiling timings
  // (445 + 145 > 480). That is the budget working, not a regression: a later round only starts
  // when it can finish inside eight minutes. A draft that answers in a minute still gets a second
  // look even when every check runs to its abort, and a ceiling draft whose first check answered
  // inside half a minute does too.
  assertEquals(one.rounds, 1);
  assertEquals(one.stop, "time");
  const minute = worst(60000);
  assert(minute.t <= F.SS_FLOW_MAX_MS, `a one-minute draft's press ends at ${minute.t}`);
  assert(minute.rounds >= 2, `a one-minute draft still gets a second look (${minute.rounds} rounds, stopped on ${minute.stop})`);
  // The draft on Opus 5.5 (2026-09-26) usually answers in 40-90 s. With every check and every render
  // at its ceiling, a 90 s draft still gets two rounds and a 40 s one all three
  // (40 + 5 + 3 x 145 = 480 s); a 45 s one gets two, since its third would end at 485 s. Each press
  // still ends inside eight minutes.
  for (const [draftMs, rounds] of [[40000, 3], [45000, 2], [60000, 2], [90000, 2]]) {
    const w = worst(draftMs);
    assertEquals(w.rounds, rounds, `a ${draftMs / 1000} s draft at ceiling checks: ${w.rounds} rounds, stopped on ${w.stop}`);
    assert(w.t <= F.SS_FLOW_MAX_MS, `a ${draftMs / 1000} s draft's press ends at ${w.t}`);
  }
  const quickCheck = F.SS_DRAFT_SERVER_MS + F.SS_RENDER_MS + 30000;
  assertEquals(F.ssCheckNext({ verdict: "corrections", d3: {}, changed: [{ field: "roof.pitch" }] }, 0, [], "b", quickCheck), null,
    "a ceiling draft whose first check took 30 s goes round again");
  assertEquals(F.ssCheckNext({ verdict: "corrections", d3: {}, changed: [{ field: "roof.pitch" }] }, 0, [], "b", quickCheck + 1), "time",
    "and one whose first check took a moment longer stops: 335 s is the last start that finishes by 480 s");
  // THE RETRY PATH: the streamed draft at its ceiling, then the lean retry, which is NOT streamed and
  // keeps the old 125 s. It is the one path past eight minutes, and it takes no second round --
  // which is what keeps it to one check's worth past the ceiling. (Two streamed drafts would stop
  // the same way: the bound below holds for any retry at least as long.)
  for (const retry of [125000, F.SS_DRAFT_SERVER_MS]) {
    const retried = worst(F.SS_DRAFT_SERVER_MS + retry);
    assertEquals(retried.rounds, 1);
    assertEquals(retried.stop, "time");
  }
  // And the check's client abort has to sit ABOVE the server's own abort for the v2 check
  // (SELF_CHECK_BUDGET.v2, read from the server's module), with room for the renders' upload and
  // the reply to travel, or a server that answered in time would never be heard.
  assert(F.SS_CHECK_MS >= SELF_CHECK_BUDGET.v2.abortMs + 10000, `${F.SS_CHECK_MS} vs the server's ${SELF_CHECK_BUDGET.v2.abortMs}`);
  // "Still going" must not fire on an ordinary press that is merely on its second round.
  assert(F.SS_SLOW_MS > F.SS_DRAFT_SERVER_MS + F.SS_RENDER_MS + 30000, String(F.SS_SLOW_MS));
});

Deno.test("⚠️ the host's real abort on the check IS SS_CHECK_MS, above the server's own", () => {
  // The component only budgets the press with SS_CHECK_MS; the abort that ends the wait is the
  // shell's onSelfCheck signal. Two numbers that must agree, so they are read and compared.
  const fn = lift(SHELL, "portal/12-shell.jsx", "onSelfCheck: async (", "\n    // Frames the browser cut out of a walk-around video.");
  const aborts = [...fn.matchAll(/AbortSignal\.timeout\(([\d_]+)\)/g)].map((m) => Number(m[1].replace(/_/g, "")));
  assertEquals(aborts, [F.SS_CHECK_MS], "one abort in onSelfCheck, and it is the component's number");
  assert(aborts[0] >= SELF_CHECK_BUDGET.v2.abortMs + 10000, `the host waits ${aborts[0]} for a server that gives up at ${SELF_CHECK_BUDGET.v2.abortMs}`);
});

// ── More than one round ───────────────────────────────────────────────────────────────────

const CORR = (changed: unknown[] = [{ field: "roof.pitch", from: 0.42, to: 0.3, why: "" }]) =>
  ({ verdict: "corrections", d3: { roof: { type: "shed" } }, changed });

Deno.test("⚠️ the loop stops on every verdict that is not a correction, naming it", () => {
  for (const v of ["matches", "skipped", "failed", "rejected_too_many"]) {
    assertEquals(F.ssCheckNext({ verdict: v, d3: null, changed: [] }, 0, [], "x", 1000), v);
  }
  // No answer at all is a failure, never a reason to go round again.
  assertEquals(F.ssCheckNext(null, 0, [], "x", 1000), "failed");
  assertEquals(F.ssCheckNext({}, 0, [], "x", 1000), "failed");
});

Deno.test("a 'correction' that moved nothing is not a reason to look again", () => {
  assertEquals(F.ssCheckNext({ verdict: "corrections", d3: null, changed: [{ field: "roof.pitch" }] }, 0, [], "x", 1000), "unchanged");
  assertEquals(F.ssCheckNext(CORR([]), 0, [], "x", 1000), "unchanged");
  assertEquals(F.ssCheckNext({ verdict: "corrections", d3: {}, changed: "roof.pitch" }, 0, [], "x", 1000), "unchanged");
});

Deno.test("⚠️ at most three rounds, 0-based like the server's own counter", () => {
  assertEquals(F.ssCheckNext(CORR(), 0, ["a"], "b", 1000), null);
  assertEquals(F.ssCheckNext(CORR(), 1, ["a", "b"], "c", 1000), null);
  assertEquals(F.ssCheckNext(CORR(), 2, ["a", "b", "c"], "d", 1000), "rounds");
});

Deno.test("⚠️ OSCILLATION STOPS THE LOOP: a building already checked is never checked again", () => {
  // Round 2 turning round 1's building back into the draft would have round 3 re-judge the
  // draft and undo round 2, forever. The signature is ssShotSig's, the same one the compare
  // pairs are keyed on, so "the same building" means the same thing in both places.
  const draft = F.ssShotSig({ roof: { type: "gable", pitch: 0.42 }, wallHeightFt: 7 });
  const shed = F.ssShotSig({ roof: { type: "shed", pitch: 0.3 }, wallHeightFt: 7 });
  assertEquals(F.ssCheckNext(CORR(), 1, [draft, shed], draft, 1000), "repeat");
  // And a correction that reproduces the building it just judged is the same case.
  assertEquals(F.ssCheckNext(CORR(), 0, [draft], draft, 1000), "repeat");
  assertEquals(F.ssCheckNext(CORR(), 0, [draft], shed, 1000), null);
});

Deno.test("a later round only starts while a whole round still fits", () => {
  const room = F.SS_FLOW_MAX_MS - F.SS_RENDER_MS - F.SS_CHECK_MS;
  assertEquals(F.ssCheckNext(CORR(), 0, [], "b", room), null);
  assertEquals(F.ssCheckNext(CORR(), 0, [], "b", room + 1), "time");
  assertEquals(F.ssCheckNext(CORR(), 0, [], "b", NaN), "time");
});

Deno.test("one list however many rounds ran: first `from`, last `to`, latest reason", () => {
  const r1 = [
    { field: "roof.type", from: "gable", to: "shed", why: "one plane" },
    { field: "roof.pitch", from: 0.42, to: 0.3, why: "shallower" },
  ];
  const r2 = [
    { field: "roof.pitch", from: 0.3, to: 0.25, why: "shallower still" },
    { field: "roof.highSide", from: null, to: "front", why: "the porch wall is the tall one" },
  ];
  const merged = F.ssMergeChanges(F.ssMergeChanges([], r1), r2);
  assertEquals(merged.map((c: Any) => c.field), ["roof.type", "roof.pitch", "roof.highSide"]);
  assertEquals(merged[1], { field: "roof.pitch", from: 0.42, to: 0.25, why: "shallower still" });
  // A field that went round and came back where it started is no line at all.
  const back = F.ssMergeChanges(r1, [{ field: "roof.pitch", from: 0.3, to: 0.42, why: "" }]);
  assertEquals(back.map((c: Any) => c.field), ["roof.type"]);
  // Junk in a round's list is skipped, never a bullet with no label.
  assertEquals(F.ssMergeChanges([], [null, {}, { field: "" }]), []);
});

Deno.test("every viewpoint the server knows has a name the builder can read", () => {
  for (const v of ["front", "side", "eaveCorner", "corner", "back", "otherSide"]) {
    assert(typeof F.SS_VIEW_WORDS[v] === "string" && F.SS_VIEW_WORDS[v].length > 3, v);
    assert(F.SS_VIEW_WORDS[v] !== v, `${v} is shown to a builder as its own key`);
  }
});

// ── The 2026-09-24 keys, in words ─────────────────────────────────────────────────────────

Deno.test("⚠️ every new roof key the check may correct has words, ahead of the allow-list", () => {
  // The allow-list test above only sees the keys the server's SELF_CHECK_ALLOW holds on THIS
  // branch. The contract adds these eight; the words exist before the list does, so the merge
  // cannot put a raw key in front of a builder in the gap between the two.
  const keys = ["roof.front", "roof.highSide", "roof.porchAttachFt", "roof.porchWidthFt",
    "roof.wingSide", "roof.wingWidthFt", "roof.wingPitch", "roof.centerEaveFt"];
  for (const k of keys) {
    assert(k in F.SS_CHANGE_WORDS, `${k} has no words`);
    const line = F.ssChangeLine({ field: k, from: null, to: null, why: "" });
    assert(line.label !== k && !/[a-z][A-Z]/.test(line.label), `${k} is shown as ${line.label}`);
  }
  assertEquals(F.ssChangeLine({ field: "roof.highSide", from: "left", to: "front", why: "" }).text, "the left side → the front");
  assertEquals(F.ssChangeLine({ field: "roof.front", from: "gable", to: "eave", why: "" }).text,
    "a gable end, under the roof triangle → a long side, under the roof edge");
  assertEquals(F.ssChangeLine({ field: "roof.porchAttachFt", from: 9, to: 7.5, why: "" }).text, "9 ft up → 7 ft 6 in up");
  assertEquals(F.ssChangeLine({ field: "roof.wingPitch", from: 0.25, to: 0.5, why: "" }).text, "3 in 12 → 6 in 12");
  assertEquals(F.ssChangeLine({ field: "roof.wingWidthFt", from: null, to: 5, why: "" }).text, "not set → 5 ft");
  assertEquals(F.ssChangeLine({ field: "roof.wingSide", from: "left", to: "both", why: "" }).text, "the left side → both sides");
});

Deno.test("the porch's posts, pitch and steps (2026-09-25) read in the porch controls' words", () => {
  assertEquals(F.ssChangeLine({ field: "roof.porchPosts", from: 3, to: 4, why: "" }).text, "3 posts → 4 posts");
  assertEquals(F.ssChangeLine({ field: "roof.porchPitch", from: null, to: 0.25, why: "" }).text, "not set → 3 in 12");
  assertEquals(F.ssChangeLine({ field: "roof.porchSteps", from: "left", to: "center", why: "" }).text, "on the left → in the middle");
  for (const k of ["roof.porchPosts", "roof.porchPitch", "roof.porchSteps"]) {
    const line = F.ssChangeLine({ field: k, from: null, to: null, why: "" });
    assert(line.label !== k && !/[a-z][A-Z]/.test(line.label), `${k} is shown as ${line.label}`);
  }
  // 'What we drew' says them only where the style gives them.
  const farm = F.ssDrewWords({ roof: { type: "shed", highSide: "front", porchOutFt: 4, porchPosts: 3, porchPitch: 0.2, porchSteps: "right" } });
  assertStringIncludes(farm, "It has 3 posts, a roof sloping 2.4 in 12 and steps on the right.");
  assertStringIncludes(F.ssDrewWords({ roof: { type: "shed", porchOutFt: 4, porchSteps: "center" } }), "It has steps in the middle.");
  assert(!/It has/.test(F.ssDrewWords({ roof: { type: "shed", highSide: "front", porchOutFt: 4 } })), "nothing said where nothing is given");
});

Deno.test("'What we drew' names the high side, the front, the wings and the porch wall", () => {
  // Farmstand: a one-slant roof high at the front, a porch on that wall meeting it low.
  const farm = F.ssDrewWords({ roof: { type: "shed", highSide: "front", porchOutFt: 4, porchEnd: "front", porchAttachFt: 7.5, porchWidthFt: 16 } });
  assertStringIncludes(farm, "The high side is the front.");
  assertStringIncludes(farm, "The porch stands 4 ft out from the front wall, 16 ft wide, and its roof meets the wall 7 ft 6 in up.");
  // Tri Home: gable end to the front, wings on both sides, a tall middle.
  const tri = F.ssDrewWords({ roof: { type: "gable", front: "gable", wingSide: "both", wingWidthFt: 8, centerEaveFt: 16, porchOutFt: 6 } });
  assertStringIncludes(tri, "The front is a gable end");
  assertStringIncludes(tri, "A lower wing 8 ft wide runs along each side under its own roof, and the middle section's walls rise to 16 ft.");
  assertStringIncludes(tri, "out from the front wall");
  // No ratio reaches the line, ever.
  assert(!/0\.\d/.test(farm + tri), farm + tri);
});

Deno.test("⚠️ 'What we drew' never describes a key the spec does not have", () => {
  // An older style says nothing about which way it faces, and saying "the front is a gable end"
  // for it would be a claim we did not make. Its porch is still on an END, in its own words.
  assertEquals(F.ssDrewWords({ roof: { type: "gable", pitch: 0.5 } }), "");
  assertEquals(F.ssDrewWords(null), "");
  assertEquals(F.ssDrewWords({ roof: { type: "gambrel", porchDepthFt: 5 } }), "The porch is cut 5 ft into the front end.");
  // A shed never has a "front is a gable end", and a highSide on a gable is not described.
  assertEquals(F.ssDrewWords({ roof: { type: "shed", front: "gable" } }), "");
  assertEquals(F.ssDrewWords({ roof: { type: "gable", highSide: "front" } }), "");
  // Wings are off at zero, and a shed never has them.
  assertEquals(F.ssDrewWords({ roof: { type: "gable", wingSide: "both", wingWidthFt: 0 } }), "");
  assertEquals(F.ssDrewWords({ roof: { type: "shed", wingSide: "both", wingWidthFt: 6 } }), "");
});

// ── THE WARNING BANNER KNOWS EVERY OPENING THE SERVER WRITES (fix, 2026-09-25) ──────────────
// The panel promotes a machine warning out of the grey "What the model saw" text into a banner
// with a button that opens the right fix panel, by matching the note's FIRST sentence. The v2
// generation added frameKeyWarning (composed FIRST) and wingsAgreementWarning, and the banner's
// pattern knew neither: a frame-key warning got no banner, and neither did the porch or wall-height
// warning composed behind it. So the two lines are lifted from both twins and run over every
// warning the server's own functions write, composed the way portal-settings composes them.
const WARN_A = "const calWarnBanner =", WARN_B = "// ⚠️ FOUR ANSWERS BEFORE SAVE";
const warnJsx = lift(JSX, "StructureStudio.jsx", WARN_A, WARN_B);
const warnCmp = lift(CMP, "structure-studio.component.js", WARN_A, WARN_B);
const warn = new Function("calRoofNote", `${warnCmp}; return { banner: calWarnBanner, question: calWarnQuestion };`) as
  (note: string) => { banner: string | null; question: string | null };

Deno.test("the banner's two lines are byte-identical in the two twins", () => {
  assertEquals(warnJsx, warnCmp);
});

Deno.test("⚠️ every warning the server writes gets its banner, and arms the panel that fixes it", () => {
  const shedNoSide = frameKeyWarning({ type: "shed", pitch: 0.25 });
  const gableNoFront = frameKeyWarning({ type: "gable", pitch: 0.5 });
  const wings = wingsAgreementWarning({ type: "gable", pitch: 0.5, front: "gable" }, { wings: "both" });
  const wingsUnsaid = wingsAgreementWarning({ type: "gable", pitch: 0.5, front: "gable" }, {});
  const porch = porchAgreementWarning({ type: "gable", porchOutFt: 6 }, { porch: "none" });
  const gambrel = gambrelRoofWarning({ type: "gambrel", kneeU: 0.6, kneeRise: 0.9, ridgeRise: 0.9 });
  // deno-lint-ignore no-explicit-any
  const walls = knownDimsNote({ widthFt: 16, lengthFt: 10, wallHeightFt: 3 } as any);
  const cases: Array<[string, string | null, string]> = [
    ["shed with no high side", shedNoSide, "roof"],
    ["two-slope roof with no front", gableNoFront, "roof"],
    ["wings the reading contradicts", wings, "roof"],
    ["wings the reading never named", wingsUnsaid, "roof"],
    ["porch", porch, "porch"],
    ["gambrel", gambrel, "roof"],
    ["wall height", walls, "walls"],
  ];
  for (const [what, text, question] of cases) {
    assert(text, `${what}: the server wrote no warning for this fixture`);
    const noted = flagObservedNotes({ roofNote: "Shed roof, porch on the long wall." }, text)!.roofNote!;
    const w = warn(noted);
    assertEquals(w.banner, noted, `${what}: no banner for "${text!.slice(0, 50)}"`);
    assertEquals(w.question, question, `${what}: arms ${w.question}`);
  }
  // THE FINDING: the frame-key warning is composed first. With a porch warning behind it, the note
  // still gets a banner (the whole note, both warnings) and arms the roof panel the first one names.
  const both = flagObservedNotes(null, shedNoSide, null, porch, null, walls)!.roofNote!;
  assertEquals(warn(both), { banner: both, question: "roof" });
  assertStringIncludes(warn(both).banner!, "Check the porch before saving");
  assertStringIncludes(warn(both).banner!, "Check the wall height before saving");
  // And the model's own sentence alone is never a banner.
  assertEquals(warn("Shed roof, porch on the long wall."), { banner: null, question: null });
  assertEquals(warn(""), { banner: null, question: null });
});

Deno.test("⚠️ 'What we drew' says the porch's pitch and posts as BUILT when the panel hands it the readout", () => {
  // Found 2026-09-25: d3PorchGeom lowers a given pitch where it would leave under 6 ft under the
  // beam and caps the posts at what fits, and the line said the stored numbers, so the builder
  // was asked to check "3 in 12" against a render drawn at 0.6 in 12.
  const roof = { type: "gable", front: "gable", porchOutFt: 6, porchPitch: 0.25, porchPosts: 8 };
  const lowered = { posts: 5, pitch: 0.05, pitchClamped: true };
  assertStringIncludes(F.ssDrewWords({ roof }, lowered),
    "It has 5 posts (the most that fit) and a roof sloping 0.6 in 12 (lowered from 3 in 12 to leave headroom under the beam).");
  // Built as asked: exactly the words it always said.
  assertEquals(F.ssDrewWords({ roof }, { posts: 8, pitch: 0.25, pitchClamped: false }), F.ssDrewWords({ roof }));
  // Still nothing about posts or pitch the style does not give, whatever the readout holds.
  assert(!/It has/.test(F.ssDrewWords({ roof: { type: "shed", porchOutFt: 4 } }, { posts: 3, pitch: 0.1, pitchClamped: true })));
  // A readout without numbers (no porch at that size) is ignored rather than printed as NaN.
  assertEquals(F.ssDrewWords({ roof }, {}), F.ssDrewWords({ roof }));
});

// Where the wing roofs meet (roof.wingAttach, 2026-09-28) is said as BUILT once the panel hands over the
// massing it drew (review, 2026-09-29): a distance moved down to clear the eave, a wing roof that cannot
// reach the roof and meets the wall under it, a middle held 1 ft over the walls.
Deno.test("'What we drew' says a wing attach as built when it has the massing, as stored without it", () => {
  const roof = { type: "gable", front: "gable", wingSide: "both", wingWidthFt: 12, centerEaveFt: 14, wingAttach: "wall", wingAttachFt: 0.25 };
  assertStringIncludes(F.ssDrewWords({ roof }), "meets the middle section's wall 0 ft 3 in below its eave, and the middle section's walls rise to 14 ft.");
  const clamped = { attach: "wall", Hc: 14, wings: [{ meets: "wall", meetFt: 13 / 12 }] };
  assertStringIncludes(F.ssDrewWords({ roof }, null, undefined, clamped), "meets the middle section's wall 1 ft 1 in below its eave, and the middle section's walls rise to 14 ft.");
  const up = { ...roof, wingAttach: "roof", wingAttachFt: 1 };
  const cannot = { attach: "roof", Hc: 14, wings: [{ meets: "wall", meetFt: 0.5 }] };
  assertStringIncludes(F.ssDrewWords({ roof: up }, null, undefined, cannot), "under its own roof that meets the middle section's wall 0 ft 6 in below its eave");
  const low = { attach: "roof", Hc: 11, wings: [{ meets: "roof", meetFt: 1 }] };
  assertStringIncludes(F.ssDrewWords({ roof: { ...up, centerEaveFt: 10 } }, null, undefined, low), "runs up onto the middle section's roof, 1 ft above its eave, and the middle section's walls rise to 11 ft.");
  // Without an attach, a massing changes nothing (today's sentence, the stored centre).
  const { wingAttach: _a, wingAttachFt: _b, ...plain } = roof;
  assertEquals(F.ssDrewWords({ roof: plain }, null, undefined, { Hc: 15, wings: [{}] }), F.ssDrewWords({ roof: plain }));
  // A massing for another mode than the style's (a stale one) is not used.
  assertEquals(F.ssDrewWords({ roof }, null, undefined, cannot), F.ssDrewWords({ roof }));
});

// (review, 2026-09-29) On the roof at 0 the wing roof meets the middle section AT its eave -- it does not run
// up onto its roof -- and two wings that meet it differently (an off-centre ridge) are said one by one.
Deno.test("'What we drew' says a wing roof at 0 meets the middle at its eave, and two different wings each", () => {
  const up = { type: "gable", wingSide: "both", wingWidthFt: 6, centerEaveFt: 10, wingAttach: "roof", wingAttachFt: 0 };
  const at0 = F.ssDrewWords({ roof: up });
  assertStringIncludes(at0, "A lower wing 6 ft wide runs along each side under its own roof that meets the middle section at its eave, and the middle section's walls rise to 10 ft.");
  assert(!/runs up onto/.test(at0), at0);
  const built0 = { attach: "roof", Hc: 10, wings: [{ wall: "west", meets: "roof", meetFt: 0 }, { wall: "east", meets: "roof", meetFt: 0 }] };
  assertEquals(F.ssDrewWords({ roof: up }, null, undefined, built0), at0);
  // The wall at 0 keeps its own words.
  assertStringIncludes(F.ssDrewWords({ roof: { ...up, wingAttach: "wall" } }), "meets the middle section's wall at its eave");
  // Two wings built differently: the one sentence, then each by its wall.
  const odd = { attach: "roof", Hc: 10, wings: [{ wall: "west", meets: "roof", meetFt: 2.5 }, { wall: "east", meets: "wall", meetFt: 1 / 12 }] };
  const two = F.ssDrewWords({ roof: { ...up, wingAttachFt: 2.5 } }, null, undefined, odd);
  assertStringIncludes(two, "A lower wing 6 ft wide runs along each side under its own roof, and the middle section's walls rise to 10 ft. " +
    "The left wing has a roof that runs up onto the middle section's roof, 2 ft 6 in above its eave; the right wing has a roof that meets the middle section's wall 0 ft 1 in below its eave.");
  // Two wings built alike are one sentence, as before.
  const same = { attach: "roof", Hc: 10, wings: [{ wall: "west", meets: "roof", meetFt: 2.5 }, { wall: "east", meets: "roof", meetFt: 2.5 }] };
  assertStringIncludes(F.ssDrewWords({ roof: { ...up, wingAttachFt: 2.5 } }, null, undefined, same), "under its own roof that runs up onto the middle section's roof, 2 ft 6 in above its eave, and the middle section's walls rise to 10 ft.");
  assert(!/The left wing/.test(F.ssDrewWords({ roof: { ...up, wingAttachFt: 2.5 } }, null, undefined, same)));
});

// STACKABLE WINGS (roof.wingList, 2026-10-01). A list style also carries the older designer's one-wing-per-side
// approximation (wingSide / wingWidthFt / wingPitch), which is not the building drawn here. Once the panel
// hands over the list massing it drew, 'What we drew' says the list in one sentence and nothing from those
// keys; with nothing drawn at that size it says nothing about wings.
Deno.test("⚠️ 'What we drew' says a wing list in one sentence from the massing, never the fallback keys", () => {
  const roof = { type: "gable", pitch: 0.5, wingSide: "both", wingWidthFt: 14, wingPitch: 0.32142857142857145,
    wingList: [{ wall: "left", widthFt: 8 }, { wall: "left", widthFt: 6 }, { wall: "right", widthFt: 8 }] };
  assertEquals(F.ssDrewWords({ roof }, null, undefined, { Hc: 16.5, list: true, wings: [{}, {}, {}], ends: [] }),
    "3 wings, set on the Advanced page, with the middle section's walls at 16 ft 6 in.");
  assertEquals(F.ssDrewWords({ roof }, null, undefined, { Hc: 12, list: true, wings: [{}], ends: [] }),
    "1 wing, set on the Advanced page, with the middle section's walls at 12 ft.");
  assertEquals(F.ssDrewWords({ roof }, null, undefined, { Hc: 17, list: true, wings: [{}, {}], ends: [{}] }),
    "3 wings, set on the Advanced page, with the middle section's walls at 17 ft.");
  const none = F.ssDrewWords({ roof }, null, undefined, { Hc: 9, list: true, wings: [], ends: [] });
  assert(!/wing/i.test(none), none);
  // Beside the other features the sentence stands alone for the wings.
  const porch = F.ssDrewWords({ roof: { ...roof, front: "gable", porchOutFt: 6 } }, null, undefined, { Hc: 16.5, list: true, wings: [{}, {}, {}], ends: [] });
  assertStringIncludes(porch, "3 wings, set on the Advanced page, with the middle section's walls at 16 ft 6 in.");
  assert(!/lower wing/i.test(porch), porch);
});

// WING ROOFS THAT MEET AT A CORNER (roof.wingCornersMeet, 2026-10-05): the corners the massing joined, said after
// the list's sentence, as built; a near-miss is drawn as before and says nothing more.
Deno.test("'What we drew' names the corners a wing list's roofs run around, as built", () => {
  const roof = { type: "gable", pitch: 0.5, centerEaveFt: 17, wingCornersMeet: true,
    wingList: [{ wall: "left", widthFt: 8 }, { wall: "right", widthFt: 8 }, { wall: "front", widthFt: 8 }] };
  const built = (joins: string[], near: string[] = []) => ({ Hc: 17, list: true, wings: [{}, {}], ends: [{}],
    corners: { joins: joins.map((name) => ({ name })), near: near.map((name) => ({ name, why: ["width"] })) } });
  assertEquals(F.ssDrewWords({ roof }, null, undefined, built(["front-left", "front-right"])),
    "3 wings, set on the Advanced page, with the middle section's walls at 17 ft. Their roofs run around the front-left and front-right corners as one, with a hip.");
  assertEquals(F.ssDrewWords({ roof }, null, undefined, built(["front-right"], ["front-left"])),
    "3 wings, set on the Advanced page, with the middle section's walls at 17 ft. Their roofs run around the front-right corner as one, with a hip.");
  assertEquals(F.ssDrewWords({ roof }, null, undefined, built(["back-left", "back-right", "front-left"])),
    "3 wings, set on the Advanced page, with the middle section's walls at 17 ft. Their roofs run around the back-left, back-right and front-left corners as one, with a hip.");
  // A near-miss only, or no corners at all (the switch off): the list's sentence alone.
  for (const b of [built([], ["front-left"]), { Hc: 17, list: true, wings: [{}, {}], ends: [{}] }]) {
    assertEquals(F.ssDrewWords({ roof }, null, undefined, b), "3 wings, set on the Advanced page, with the middle section's walls at 17 ft.");
  }
});

// ⚠️ An edit to the wing list is an edit to the roof: it clears an unfixed roof "No" (calQuestionSig).
Deno.test("⚠️ the roof question's slice holds the wing list", () => {
  const [a, b] = ["  const calQuestionSig = (key) => {", "  // ⚠️ ANSWERED IS NOT AGREED."];
  const sigFor = new Function("adminCal", `${lift(CMP, "structure-studio.component.js", a, b)}; return calQuestionSig;`) as (cal: unknown) => (key: string) => string;
  const sig = (spec: Record<string, unknown>, key: string) => sigFor({ spec })(key);
  const roof = { type: "gable", front: "gable", pitch: 0.5, overhang: 1 };
  const base = { roof, wallHeightFt: 9, colors: { body: "#3a3d3f" }, roofMaterial: "metal" };
  const one = { ...base, roof: { ...roof, wingList: [{ wall: "left", widthFt: 8 }] } };
  for (const [what, from, to] of [
    ["a list added", base, one],
    ["a wing added on a wing", one, { ...base, roof: { ...roof, wingList: [{ wall: "left", widthFt: 8 }, { wall: "left", widthFt: 6 }] } }],
    ["a wing's width changed", one, { ...base, roof: { ...roof, wingList: [{ wall: "left", widthFt: 7 }] } }],
    ["the list taken off", one, base],
    ["the corners switch turned on", one, { ...base, roof: { ...roof, wingList: [{ wall: "left", widthFt: 8 }], wingCornersMeet: true } }],
  ] as const) {
    assert(sig(from, "roof") !== sig(to, "roof"), `${what}: the roof's slice moves`);
    for (const k of ["porch", "walls", "colours"]) assertEquals(sig(from, k), sig(to, k), `${what}: the ${k} question's slice does not`);
  }
});

// ── The roof step (2026-09-28), in words ──────────────────────────────────────────────────

Deno.test("the roof step reads in the words of its panel controls, and 'What we drew' says it", () => {
  assertEquals(F.ssChangeLine({ field: "roof.rearStepFt", from: null, to: 12, why: "" }).text, "not set → 12 ft");
  assertEquals(F.ssChangeLine({ field: "roof.rearEaveRiseFt", from: 0.42, to: -0.25, why: "" }).text, "5 in → 3 in lower");
  for (const k of ["roof.rearStepFt", "roof.rearEaveRiseFt"]) {
    const line = F.ssChangeLine({ field: k, from: null, to: null, why: "" });
    assert(line.label !== k && !/[a-z][A-Z]/.test(line.label), `${k} is shown as ${line.label}`);
  }
  const cabin = F.ssDrewWords({ roof: { type: "gable", front: "gable", rearStepFt: 12, rearEaveRiseFt: 0.42 } });
  assertStringIncludes(cabin, "The roof steps 12 ft from the back wall: behind the step its edge sits 5 in higher, and the two ridges line up.");
  assertStringIncludes(F.ssDrewWords({ roof: { type: "gable", rearStepFt: 9, rearEaveRiseFt: -0.5 } }), "its edge sits 6 in lower");
  // Only what the renderer can draw: never on a shed, a gambrel or an eave front, never with one key.
  for (const roof of [
    { type: "shed", rearStepFt: 12, rearEaveRiseFt: 0.42 },
    { type: "gambrel", rearStepFt: 12, rearEaveRiseFt: 0.42 },
    { type: "gable", front: "eave", rearStepFt: 12, rearEaveRiseFt: 0.42 },
    { type: "gable", rearStepFt: 12 },
    { type: "gable", rearStepFt: 0, rearEaveRiseFt: 0.42 },
  ]) {
    assert(!/steps/.test(F.ssDrewWords({ roof })), JSON.stringify(roof));
  }
  assert(!/0\.\d/.test(cabin), "no ratio reaches the line");
});

// ⚠️ A "No" ON THE ROOF IS CLEARED BY FIXING THE STEP. calQuestionSig is the slice of the spec each
// question is about: a "No" whose slice has not moved since it was given is named under Save as
// unfixed. The step is set in the roof's fields, so its two keys are in the ROOF's slice; left out,
// a builder who answered the roof "No" and fixed only the step would still be told nothing had
// changed. Lifted from StructureStudioInner (both twins, byte-identical) and run on a stub adminCal.
Deno.test("⚠️ the roof question's slice holds the roof step: an edit to the step alone clears an unfixed roof 'No'", () => {
  const [a, b] = ["  const calQuestionSig = (key) => {", "  // ⚠️ ANSWERED IS NOT AGREED."];
  const cmp = lift(CMP, "structure-studio.component.js", a, b), jsx = lift(JSX, "StructureStudio.jsx", a, b);
  assertEquals(jsx, cmp, "the two twins' calQuestionSig");
  const sigFor = new Function("adminCal", `${cmp}; return calQuestionSig;`) as (cal: unknown) => (key: string) => string;
  const sig = (spec: Record<string, unknown>, key: string) => sigFor({ spec })(key);
  const roof = { type: "gable", front: "gable", pitch: 0.41, overhang: 1.3, eave: "fascia", porchDepthFt: 6, porchEnd: "front" };
  const base = { roof, wallHeightFt: 7.75, colors: { body: "#3a3d3f" }, roofMaterial: "metal" };
  const stepped = { ...base, roof: { ...roof, rearStepFt: 12, rearEaveRiseFt: 0.5 } };
  for (const [what, from, to] of [
    ["a step added", base, stepped],
    ["the joint moved", stepped, { ...base, roof: { ...roof, rearStepFt: 14, rearEaveRiseFt: 0.5 } }],
    ["the rise changed", stepped, { ...base, roof: { ...roof, rearStepFt: 12, rearEaveRiseFt: -0.25 } }],
    ["the step taken off", stepped, base],
  ] as const) {
    assert(sig(from, "roof") !== sig(to, "roof"), `${what}: the roof's slice moves, so its "No" is no longer unfixed`);
    for (const k of ["porch", "walls", "colours"]) assertEquals(sig(from, k), sig(to, k), `${what}: the ${k} question's slice does not`);
  }
});
