// THE ROLLOUT GATE for the v2 generation prompt (2026-09-24), read off the SHIPPED portal-settings
// source and the SHIPPED portal shell.
//
// WHY IT EXISTS. Beta and production share one set of edge functions, and an edge deploy is live
// for both at once. Production runs an OLDER browser bundle that already sends `dims`, typed
// against a card that says the width is "across the gable end". The v2 prompt reads the same
// numbers in the NEW frame (the width is the FRONT wall's), so handing it to that bundle would
// state a builder's measurements in a frame they were not typed in. The gate is one key: the new
// portal shell sends `frame: "front"`, and only a request carrying it AND dims gets v2. Everything
// else takes exactly the prompt it took before v2 — styleD3.test.ts pins those bytes by hash.
//
// What is pinned here, because each is a one-word edit away from silently undoing the gate:
//   1. the decision is `wantsV2Prompt(payload.frame, dims)` — RUN, not regex-read;
//   2. BOTH shape-first prompt calls pass it (a combined set and a walk on its own);
//   3. the wings agreement check is composed only when it is true — the legacy prompts never ask
//      observed.wings, so ungated every legacy draft would come back amber;
//   4. the new portal shell's onDraftFromCombined really sends `frame: "front"` — RUN against a
//      stand-in supabase client, on the first press and on the lean retry alike.
//
// HOW: the aiDraftRetryWiring_test idiom — lift the shipped text between stable anchors.

import { assert, assertEquals } from "jsr:@std/assert";
import { wantsV2Prompt } from "../styleD3.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const PORTAL = await read("../../portal-settings/index.ts");
const SHELL = await read("../../../../portal/12-shell.jsx");

function lift(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `aiDraftFrameGateWiring_test: could not find ${what} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

// The whole generation branch, and nothing past it. One function of `streamed` since 2026-09-25
// (draftAnswer; aiDraftStreamWiring_test).
const DRAFT = lift(PORTAL, 'if (action === "calibrate_style_ai") return await draftAnswer(', "// ── THE FREE SECOND PASS", "the calibrate_style_ai branch");
const DIMS = { widthFt: 16, lengthFt: 10, wallHeightFt: 7 };

Deno.test("the draft branch decides v2 with wantsV2Prompt(payload.frame, dims), and only frame \"front\" with dims passes", () => {
  const decl = DRAFT.split("\n").find((l) => l.includes("const v2Prompt =")) ?? "";
  assertEquals(decl.trim(), "const v2Prompt = wantsV2Prompt(payload.frame, dims);");
  // After dims is settled (a photos-only source has dims null, so it can never be v2).
  assert(DRAFT.indexOf("const v2Prompt =") > DRAFT.indexOf("const dims = shapeFirst ? dimsRead.dims : null;"), "decided after dims");
  const v2 = (payload: Record<string, unknown>, dims: unknown) =>
    new Function("wantsV2Prompt", "payload", "dims", `${decl}; return v2Prompt;`)(wantsV2Prompt, payload, dims) as boolean;
  assertEquals(v2({ frame: "front" }, DIMS), true, "the new designer");
  assertEquals(v2({}, DIMS), false, "production's older bundle: dims and no frame");
  assertEquals(v2({ frame: "FRONT" }, DIMS), false);
  assertEquals(v2({ frame: true }, DIMS), false);
  assertEquals(v2({ frame: "front" }, null), false, "no dims");
});

Deno.test("both shape-first prompt calls carry the gate, and nothing else chooses a prompt", () => {
  const line = DRAFT.split("\n").find((l) => l.includes('{ type: "text", text: combined ?')) ?? "";
  assert(line.includes("combinedShapePrompt(videoCount, photoUrls.length - videoCount, dims, v2Prompt)"), "the combined set");
  assert(line.includes("videoShapePrompt(dims, v2Prompt)"), "a walk on its own");
  assert(line.includes(": SPEC_PROMPT)"), "the photo path is untouched");
  // Exactly one prompt line, so there is no second, ungated call somewhere else in the branch.
  assertEquals(DRAFT.split("\n").filter((l) => /(video|combined)ShapePrompt\(/.test(l) && !l.trim().startsWith("//")).length, 1);
});

Deno.test("the wings agreement check is composed only on the v2 path", () => {
  const call = DRAFT.split("\n").find((l) => l.includes("flagObservedNotes(observedRead,")) ?? "";
  assert(call.includes("v2Prompt ? wingsAgreementWarning(drafted.d3.roof, observedRead) : null"), "gated on the v2 prompt, not merely on dims");
  assert(!call.includes("dims ? wingsAgreementWarning"), "the old dims-only gate is gone");
  assert(call.includes("knownDimsNote(dims)"), "the clamp note is for every dims request, as before");
  // The frame-key check (fix 2026-09-24): a v2 draft that names no roof.front / roof.highSide is
  // drawn the old way round, so it is flagged FIRST -- and only on the v2 path, whose prompt is the
  // only one that asks for either key.
  assert(call.includes("flagObservedNotes(observedRead, v2Prompt ? frameKeyWarning(drafted.d3.roof) : null, gambrelRoofWarning("),
    "the frame-key check leads, gated on the v2 prompt");
  assertEquals(call.split("frameKeyWarning(").length - 1, 1, "and it is composed once");
});

Deno.test("the new portal shell sends frame \"front\" on every draft, the lean retry included", async () => {
  const fn = lift(SHELL, "onDraftFromCombined: async (", "\n    /* THE FREE SECOND PASS", "onDraftFromCombined").trim().replace(/,$/, "");
  const src = fn.replace(/^onDraftFromCombined:\s*/, "");
  const sent: Record<string, unknown>[] = [];
  const sb = {
    functions: {
      invoke: (_name: string, opts: { body: Record<string, unknown> }) => {
        sent.push(opts.body);
        return Promise.resolve({ data: { ok: true, d3: { roof: { type: "shed" } } }, error: null });
      },
    },
  };
  const draft = new Function("sb", `return (${src});`)(sb) as (...a: unknown[]) => Promise<unknown>;
  const urls = ["https://example.test/f1.jpg", "https://example.test/f2.jpg"];
  await draft(urls, "farm", 2, "key-1", DIMS);
  await draft(urls, "farm", 2, "key-1", DIMS, { lean: true });
  assertEquals(sent.length, 2);
  for (const b of sent) {
    assertEquals(b.frame, "front", "the gate's key");
    assertEquals(b.dims, DIMS, "beside the dims it vouches for");
    assertEquals(b.action, "calibrate_style_ai");
  }
  assertEquals(sent[1].lean, true, "and the retry is still lean");
});

// 5. The MODEL follows the same gate (2026-09-24): the draft call's body spreads
//    aiModelFields(v2Prompt) — Opus for the new designer, Sonnet for every legacy request — and
//    names no model of its own, so the legacy draft is the request it always was.
Deno.test("the draft call takes its model from aiModelFields(v2Prompt) and names none itself", () => {
  // Built once since consensus drafting (2026-09-25), and sent by every call as { ...draftInit, signal }.
  const call = lift(PORTAL, "const draftInit = {", "// ── CONSENSUS DRAFTING", "the draft request");
  assert(call.includes("...aiModelFields(v2Prompt),"), "the draft body spreads aiModelFields(v2Prompt)");
  assert(!/model:\s*"claude-/.test(call), "no hard-coded model id in the draft call");
  assert(PORTAL.includes('send: (signal) => fetch("https://api.anthropic.com/v1/messages", { ...draftInit, signal }),'),
    "every draft call sends that one request");
  assertEquals(PORTAL.split('fetch("https://api.anthropic.com/v1/messages"').length - 1, 2,
    "two Anthropic call sites in the file: the draft's and the self-check's");
});
