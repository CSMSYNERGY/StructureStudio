// The draft call's v2 budget and its one automatic retry (2026-09-24), read off the SHIPPED
// portal-settings source.
//
// WHAT CHANGED, and why each piece is pinned rather than trusted:
//
//   1. max_tokens 8000 → 12000 and the abort 110 s → 125 s. One 09-21 generation in twelve was cut
//      off at 8000, and the v2 prompt asks for more. The abort stays under the gateway's 150 s so
//      the hold is still released and the failure still named. Since the fix of the same day the
//      abort is also bounded by the GATEWAY's clock, which started with the request: 145 s from the
//      request, never more than 125 s for the model, never under 60 s (2026-09-25: the first cut
//      took the set-up out of the model's 125 s, which cut every legacy reply short by it too).
//   2. A cut-off or timed-out reply now answers `retryable: true`. The new browser retries ONCE on
//      that field, with `lean: true` under the same idempotency key — the failed attempt released
//      its hold, and 248 made a released key reusable. An UNPARSEABLE reply is deliberately NOT
//      retryable: the same frames tend to fail the same way, and an automatic second call on a
//      known failure is spend with nothing to show for it.
//   3. `lean: true` maps to effort "low", and ONLY a real boolean does: an older browser never
//      sends it and must keep effort "medium".
//   4. A walk-around's frames are capped at WALK_FRAME_MAX (12) EVERYWHERE they are read or kept —
//      the generation and both save paths — because the self-check pairs a frame with a render
//      only if the style stores that frame. One leftover `8` would quietly drop four views.
//   5. The wings agreement check runs only on a v2 generation — since the rollout gate, one whose
//      request says frame "front" and sends dims (aiDraftFrameGateWiring_test): the legacy prompts
//      never ask observed.wings, so ungated it would turn every legacy draft amber.
//
// HOW: the same idiom as aiDraftUsageWiring_test — lift the shipped text between stable anchors.
// The two reply statements are RUN against a stand-in `json`, so what is asserted is what the
// handler returns, not what a regex thinks it says.

import { assert, assertEquals } from "jsr:@std/assert";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const PORTAL = await read("../../portal-settings/index.ts");
const ADMIN = await read("../../admin-save-settings/index.ts");

function lift(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `aiDraftRetryWiring_test: could not find ${what} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

// The whole generation branch, and nothing past it: the self-check below has its own budget.
// The branch has been one function of `streamed` since 2026-09-25 (draftAnswer; aiDraftStreamWiring_test).
const DRAFT = lift(PORTAL, 'if (action === "calibrate_style_ai") return await draftAnswer(', "// ── THE FREE SECOND PASS", "the calibrate_style_ai branch");

type Reply = { body: Record<string, unknown>; status: number };
const json = (body: Record<string, unknown>, status = 200): Reply => ({ body, status });

Deno.test("the draft call has the v2 budget: 12000 tokens (20000 streamed), a 125 s abort unless streamed, effort low only when lean", () => {
  // 20000 on a STREAMED draft only (2026-09-25): at effort "high" a read can think past 12000 and be
  // cut off with most of its 300 s left. Every other request keeps 12000.
  const mt = DRAFT.split("\n").find((l) => l.includes("max_tokens:")) ?? "";
  assertEquals(mt.trim(), "max_tokens: streamed ? 20000 : 12000,");
  const maxTokens = (streamed: boolean) => new Function("streamed", `return {${mt.trim()}}.max_tokens;`)(streamed) as number;
  assertEquals([maxTokens(false), maxTokens(true)], [12000, 20000]);
  assert(!DRAFT.includes("max_tokens: 8000"), "and the old 8000 is gone");
  assert(DRAFT.includes("const aiSignal = AbortSignal.timeout(draftAbortMs);"), "the abort is the request-measured budget below");
  // Lean is "low"; a STREAMED draft (the new shell's v2 press, which outlives the gateway) is "high";
  // everything else -- legacy, and a v2 request that is not streamed -- stays "medium" (2026-09-25).
  // Decided once, as draftEffort, which the request sends and draft_tokens records.
  const eff = DRAFT.split("\n").find((l) => l.includes("output_config: { effort:")) ?? "";
  assertEquals(eff.trim(), "output_config: { effort: draftEffort },");
  const effDecl = DRAFT.split("\n").find((l) => l.includes("const draftEffort =")) ?? "";
  assertEquals(effDecl.trim(), 'const draftEffort = lean ? "low" : streamed ? "high" : "medium";');
  const effort = (lean: boolean, streamed: boolean) =>
    new Function("lean", "streamed", `${effDecl.trim()}\nreturn {${eff.trim()}}.output_config.effort;`)(lean, streamed) as string;
  assertEquals([effort(false, false), effort(true, false), effort(false, true)], ["medium", "low", "high"]);
  // Only a real boolean: "true", 1 and an absent key all leave an older browser on "medium".
  const decl = DRAFT.split("\n").find((l) => l.includes("const lean =")) ?? "";
  assertEquals(decl.trim(), "const lean = payload.lean === true;");
  const lean = (payload: Record<string, unknown>) => new Function("payload", `${decl}; return lean;`)(payload);
  assertEquals([lean({ lean: true }), lean({ lean: "true" }), lean({ lean: 1 }), lean({})], [true, false, false, false]);
});

Deno.test("⚠️ the model keeps its 125 s, and the gateway's 150 s is measured from the REQUEST", () => {
  // money-rails (low), 2026-09-24: the abort used to start after the wallet hold AND the inline
  // auto top-up (nmiPost's 30 s timeout). A 20 s top-up plus a 120 s reply crossed the gateway's
  // 150 s: the builder got a bare 504 with no `retryable`, while the function captured the $20.
  // prod-safety (low), 2026-09-25: the first fix, max(60 s, 125 s - set-up), charged the set-up to
  // the MODEL, so production's older designer (no lean retry) lost its own set-up time on every
  // press and up to 30 s after a top-up, and a 103 s legacy reply that ended inside 150 s was cut.
  const start = PORTAL.indexOf("const requestStartMs = Date.now();");
  assert(start > 0 && start < PORTAL.indexOf('if (req.method === "OPTIONS")'), "the clock starts on the handler's first line");
  // Since 2026-09-25 the declaration has a streamed arm (aiDraftStreamWiring_test pins it). The rule
  // every request that is NOT streamed gets is the second arm, character for character as before.
  const decl = lift(DRAFT, "const draftAbortMs =", ";\n", "the draft budget") + ";";
  assertEquals(decl.split("\n").map((l) => l.trim()).join(" "),
    "const draftAbortMs = streamed ? Math.max(60_000, Math.min(300_000, 330_000 - (t0 - requestStartMs))) : Math.max(60_000, Math.min(125_000, 145_000 - (t0 - requestStartMs)));");
  assert(DRAFT.indexOf("const draftAbortMs =") > DRAFT.indexOf("autoTopupDecision("), "measured after the top-up has run");
  assert(DRAFT.indexOf("const draftAbortMs =") < DRAFT.indexOf("const aiSignal ="), "and before the call it bounds");
  const budget = (spentMs: number) => new Function("t0", "requestStartMs", "streamed", `${decl}; return draftAbortMs;`)(1_000_000 + spentMs, 1_000_000, false) as number;
  assertEquals(budget(0), 125_000, "no set-up: the whole 125 s");
  assertEquals(budget(2_500), 125_000, "an ordinary press keeps the whole 125 s: its set-up is not the model's to pay");
  assertEquals(budget(20_000), 125_000, "up to 20 s of set-up still leaves the model 125 s");
  assertEquals(budget(32_000), 113_000, "a 30 s top-up: what is left of 145 s");
  assertEquals(budget(90_000), 60_000, "never under 60 s");
  // THE LEGACY REPLY THE FIRST CUT KILLED: 3 s of set-up and a 103 s reply is inside the budget.
  assert(103_000 <= budget(3_000), "a 103 s legacy reply after an ordinary set-up is not cut");
  // THE BOUND: every press whose pre-call work fits the top-up's 30 s (+ 5 s of set-up) has its
  // model abort by 145 s after the request, which leaves the release, the log row and the reply
  // inside the gateway's 150.
  for (let spent = 0; spent <= 35_000; spent += 500) {
    assert(spent + budget(spent) <= 145_000, `spent ${spent} ms`);
    assert(budget(spent) === Math.min(125_000, 145_000 - spent), `spent ${spent} ms: the model gets all the gateway can spare`);
  }
  // The timeout row says which clock fired.
  assert(DRAFT.includes("requestMs: Date.now() - requestStartMs, abortMs: draftAbortMs"), "the row carries both clocks");
});

Deno.test("a cut-off reply is retryable; an unparseable one is not", () => {
  const stmt = lift(DRAFT, "const failed = json(truncated", ", 502);", "the failed-draft reply") + ", 502);";
  const run = (truncated: boolean) =>
    new Function("json", "truncated", "drafted", `${stmt}\nreturn failed;`)(json, truncated, { error: "The model returned malformed JSON." }) as Reply;
  const cut = run(true);
  assertEquals(cut.status, 502);
  assertEquals(cut.body.retryable, true, "the new browser retries this once, lean");
  assertEquals(cut.body.error, "The AI ran out of room before finishing - please try again.", "and an older one still reads the same sentence");
  const junk = run(false);
  assertEquals(junk.status, 502);
  assert(!("retryable" in junk.body), "a reply that did not parse is not retried automatically");
  assertEquals(junk.body.error, "The model returned malformed JSON.");
});

Deno.test("a timed-out reply is retryable, and its hold is released before it answers", () => {
  const stmt = lift(DRAFT, "const timedOut = json(", ", 504);", "the timeout reply") + ", 504);";
  const out = new Function("json", `${stmt}\nreturn timedOut;`)(json) as Reply;
  assertEquals(out.status, 504);
  assertEquals(out.body.retryable, true);
  assertEquals(out.body.error, "The AI took too long to answer - please try again.");
  // The retry reuses the SAME idempotency key, which is only safe because the hold was released.
  // Consensus drafting (2026-09-25): whether the deadline stopped THIS call, read the moment it
  // threw (runDraftCalls), which on a single call is the aiSignal.aborted this branch read before.
  const branch = lift(DRAFT, 'if (lead.aborted === "deadline") {', "return timedOut;", "the abort branch");
  assert(branch.indexOf('await releaseHold("model timeout");') > -1, "the hold is released on a timeout");
  assert(branch.indexOf('await releaseHold("model timeout");') < branch.indexOf("const timedOut = json("), "before the reply is built");
  const trunc = lift(DRAFT, "const truncated = reply.stopReason", "return failed;", "the truncation branch");
  assert(trunc.includes('await releaseHold(truncated ? "reply truncated" : "unparseable spec");'), "and on a cut-off reply");
});

Deno.test("every walk-around frame path takes WALK_FRAME_MAX, and no 8 is left behind", () => {
  assert(DRAFT.includes("sanitizePhotoUrls(payload.photoUrls, combined ? 12 : fromVideo ? WALK_FRAME_MAX : 4)"), "the generation's video cap");
  assert(PORTAL.includes("sanitizePhotoUrls(payload.d3VideoFrames, WALK_FRAME_MAX);"), "save_style_d3's stored frames");
  assert(PORTAL.includes("patch.d3_video_frames = sanitizePhotoUrls(payload.d3VideoFrames, WALK_FRAME_MAX);"), "save_style_media's stored frames");
  assert(ADMIN.includes("sanitizePhotoUrls(d3VideoFrames, WALK_FRAME_MAX);"), "the operator save's stored frames");
  for (const [name, src] of [["portal-settings", PORTAL], ["admin-save-settings", ADMIN]] as const) {
    assert(!/sanitizePhotoUrls\([^)]*,\s*8\)/.test(src), `${name}: no frame path still caps at 8`);
  }
});

Deno.test("the wings check is composed only on a v2 generation, beside the other three", () => {
  const call = DRAFT.split("\n").find((l) => l.includes("flagObservedNotes(observedRead,")) ?? "";
  assert(call.includes("gambrelRoofWarning(drafted.d3.roof)"), "the gambrel check stays");
  assert(call.includes("porchAgreementWarning(drafted.d3.roof, observedRead)"), "the porch check stays");
  assert(call.includes("v2Prompt ? wingsAgreementWarning(drafted.d3.roof, observedRead) : null"), "the wings check, gated on the v2 prompt");
  assert(call.includes("knownDimsNote(dims)"), "the clamp note stays");
});
