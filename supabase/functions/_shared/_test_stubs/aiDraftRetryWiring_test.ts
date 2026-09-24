// The draft call's v2 budget and its one automatic retry (2026-09-24), read off the SHIPPED
// portal-settings source.
//
// WHAT CHANGED, and why each piece is pinned rather than trusted:
//
//   1. max_tokens 8000 → 12000 and the abort 110 s → 125 s. One 09-21 generation in twelve was cut
//      off at 8000, and the v2 prompt asks for more. The abort stays under the gateway's 150 s so
//      the hold is still released and the failure still named.
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
//   5. The wings agreement check runs only on a v2 (dims) generation: the legacy prompt never asks
//      observed.wings, so ungated it would turn every legacy draft amber.
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
const DRAFT = lift(PORTAL, 'if (action === "calibrate_style_ai") {', "// ── THE FREE SECOND PASS", "the calibrate_style_ai branch");

type Reply = { body: Record<string, unknown>; status: number };
const json = (body: Record<string, unknown>, status = 200): Reply => ({ body, status });

Deno.test("the draft call has the v2 budget: 12000 tokens, a 125 s abort, effort low only when lean", () => {
  assert(DRAFT.includes("max_tokens: 12000,"), "max_tokens is 12000");
  assert(!DRAFT.includes("max_tokens: 8000"), "and the old 8000 is gone");
  assert(DRAFT.includes("const aiSignal = AbortSignal.timeout(125_000);"), "the abort is 125 s, still under the gateway's 150");
  assert(DRAFT.includes('output_config: { effort: lean ? "low" : "medium" },'), "lean thinks less; everyone else as before");
  // Only a real boolean: "true", 1 and an absent key all leave an older browser on "medium".
  const decl = DRAFT.split("\n").find((l) => l.includes("const lean =")) ?? "";
  assertEquals(decl.trim(), "const lean = payload.lean === true;");
  const lean = (payload: Record<string, unknown>) => new Function("payload", `${decl}; return lean;`)(payload);
  assertEquals([lean({ lean: true }), lean({ lean: "true" }), lean({ lean: 1 }), lean({})], [true, false, false, false]);
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
  const branch = lift(DRAFT, "if (aiSignal.aborted) {", "return timedOut;", "the abort branch");
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

Deno.test("the wings check is composed only on a v2 (dims) generation, beside the other three", () => {
  const call = DRAFT.split("\n").find((l) => l.includes("flagObservedNotes(observedRead,")) ?? "";
  assert(call.includes("gambrelRoofWarning(drafted.d3.roof)"), "the gambrel check stays");
  assert(call.includes("porchAgreementWarning(drafted.d3.roof, observedRead)"), "the porch check stays");
  assert(call.includes("dims ? wingsAgreementWarning(drafted.d3.roof, observedRead) : null"), "the wings check, gated on dims");
  assert(call.includes("knownDimsNote(dims)"), "the clamp note stays");
});
