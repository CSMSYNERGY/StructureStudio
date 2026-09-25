// Measured pitches in calibrate_style_ai's wiring (2026-09-26), RUN, not regex-read.
//
// WHY THIS EXISTS. Live three-read v2 drafts JUDGED the slope: a raised centre's 0.41 gable came back
// 0.45 to 0.8. The v2 reply now carries `measure`, the pixel points a gable's pitch is read from, and
// styleD3.ts works the slope out (pitchFromMeasure; styleD3.test.ts pins the arithmetic). Only a
// gable is ever worked out: a shed's and a gambrel's pitch, and every porch pitch, stay the model's.
// What only the handler can get wrong, and what this pins:
//
//   1. On a v2 press each gable read's pitch is replaced by its OWN points' BEFORE the consensus, so
//      the median is over measured numbers; a read whose points fail keeps the model's number.
//   2. draft_tokens.samples records, per read, which source won and the model's own number when the
//      points replaced it, on the three-read record and on the lean retry's single read alike.
//   3. The lean retry's single read is drafted with its measured pitch too.
//   4. A legacy request (production's older designer) is untouched: its reply's points, if any, are
//      ignored, its request bytes are what they were, and its usage record has no samples.
//
// HOW: aiDraftConsensusWiring_test's idiom. The handler's block from the abort signal to the end of
// the parse-failure exit is lifted between the same anchors and run as an async function against a
// stand-in fetch, hold, logger and ledger, with the real styleD3 functions.

import { assert, assertEquals } from "jsr:@std/assert";
import {
  aiModelFields, combinedShapePrompt, consensusOfCalls, draftCallCount, draftCallsUsage, draftReadSample,
  parseModelSpec, readDraftReply, runDraftCalls, SPEC_PROMPT, videoShapePrompt, DRAFT_CONSENSUS_GRACE_MS,
} from "../styleD3.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SOURCE = await read("../../portal-settings/index.ts");

function lift(start: string, end: string, what: string): string {
  const i = SOURCE.indexOf(start);
  const j = i < 0 ? -1 : SOURCE.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `aiDraftMeasureWiring_test: could not find ${what} in portal-settings/index.ts (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return SOURCE.slice(i, j);
}

const CALL_BLOCK = lift("    const aiSignal = AbortSignal.timeout(draftAbortMs);", "    // ── HOW THE OVERHANG IS FRAMED", "the draft call block");
for (const must of [
  "read: (body) => readDraftReply(body, dims, v2Prompt),",
  "const drafted = parseModelSpec(text, dims, v2Prompt);",
  "...(lead.reading.pitch ? { samples: [draftReadSample(lead.reading)] } : {}),",
  "if (consensus) drafted.d3 = consensus.d3;",
]) {
  assert(CALL_BLOCK.includes(must), `the lifted call block is missing ${must} — re-point the anchors`);
}

// ─── The stand-ins (aiDraftConsensusWiring_test's, trimmed to what this file drives) ─────────────
type Plan = { body: string; delayMs?: number };
type Sent = { url: string; init: RequestInit & { signal: AbortSignal; body: string } };
type Reply = { body: Record<string, unknown>; status: number };

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const PARAMS = [
  "AbortSignal", "draftAbortMs", "aiModelFields", "v2Prompt", "lean", "photoUrls", "combined", "combinedShapePrompt",
  "videoCount", "dims", "fromVideo", "videoShapePrompt", "SPEC_PROMPT", "apiKey", "draftCallCount", "runDraftCalls",
  "DRAFT_CONSENSUS_GRACE_MS", "fetch", "readDraftReply", "consensusOfCalls", "draftCallsUsage", "recordDraftUsage",
  "releaseHold", "logEdgeError", "req", "clientId", "t0", "requestStartMs", "aiSource", "json", "filedAtReturnSite",
  "parseModelSpec", "streamed", "draftEffort", "draftReadSample",
];
const RUN = new AsyncFunction(
  ...PARAMS,
  `${CALL_BLOCK}\nreturn { answered: null, drafted, lead, consensus, callsUsage, text, calls };`,
);

const DIMS = { widthFt: 30, lengthFt: 20, wallHeightFt: 8 };
const FRAMES = Array.from({ length: 12 }, (_, i) => `https://example.test/walk/f${i + 1}.jpg`);

async function run(s: { v2: boolean; lean?: boolean }, plans: Plan[]) {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const fakeAbortSignal = {
    timeout: (ms: number) => {
      const c = new AbortController();
      timers.push(setTimeout(() => c.abort(new DOMException("Signal timed out.", "TimeoutError")), ms));
      return c.signal;
    },
  };
  const sent: Sent[] = [];
  const fetch = (url: string, init: Sent["init"]): Promise<Response> => {
    const plan = plans[sent.length];
    sent.push({ url, init });
    return new Promise((resolve) => {
      timers.push(setTimeout(() => resolve(new Response(plan.body, { status: 200 })), plan.delayMs ?? 1));
    });
  };
  const released: string[] = [];
  const logged: string[] = [];
  const usage: Record<string, unknown>[] = [];
  const t0 = Date.now();
  try {
    const out = await RUN(
      fakeAbortSignal, 2_000, aiModelFields, s.v2, s.lean ?? false, FRAMES, false, combinedShapePrompt,
      0, DIMS, true, videoShapePrompt, SPEC_PROMPT, "test-key", draftCallCount, runDraftCalls,
      DRAFT_CONSENSUS_GRACE_MS, fetch, readDraftReply, consensusOfCalls, draftCallsUsage,
      // deno-lint-ignore require-await
      async (tokens: Record<string, unknown>) => { usage.push(tokens); },
      // deno-lint-ignore require-await
      async (reason: string) => { released.push(reason); },
      // deno-lint-ignore require-await
      async (e: { code: string }) => { logged.push(e.code); },
      null, "harness-tenant", t0, t0 - 1_000, "video",
      (body: Record<string, unknown>, status = 200): Reply => ({ body, status }),
      new Set(), parseModelSpec, false, s.lean ? "low" : "medium", draftReadSample,
    );
    return { out, sent, released, logged, usage };
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}

// ─── Replies ───────────────────────────────────────────────────────────────────────────────────
// A gable with a projecting porch. Its own numbers are pitch `pitch` and porch pitch `porch`; the
// points in `measure` say otherwise. Generic points in a 1600 x 900 frame, never a test building's.
const SIZE = [1600, 900];
// A gable whose rakes rise `risePx` over 400 px each side: pitch risePx / 400.
const gable = (risePx: number) => ({ frame: 2, size: SIZE, left: [400, 600], peak: [800, 600 - risePx], right: [1200, 600] });
// The same with y read UP by mistake: the peak below its ends, which the server refuses.
const gableYUp = { frame: 2, size: SIZE, left: [400, 300], peak: [800, 500], right: [1200, 300] };
// The porch-roof and shed points an earlier draft of the v2 prompt asked for (taken out the same day).
// A reply that still gives them must change nothing.
const oldPorch = { frame: 4, size: SIZE, wall: [700, 400], edge: [1200, 550], postTop: [1200, 550], postBottom: [1200, 750] };
const oldShed = { frame: 5, size: SIZE, tallTop: [300, 200], tallBottom: [300, 700], shortTop: [1100, 440], shortBottom: [1100, 700] };

function replyText(own: { pitch: number; porch: number }, measure?: Record<string, unknown>) {
  return JSON.stringify({
    roof: { type: "gable", front: "gable", pitch: own.pitch, overhangIn: 6, eave: "fascia", porchOutFt: 6, porchEnd: "front", porchPosts: 4, porchPitch: own.porch },
    colors: { body: "#333333", trim: "#222222", roof: "#1a1a1a" },
    roofMaterial: "metal",
    observed: { roofNote: "a gable with a porch in front", porch: "projecting", wings: "none", confidence: "medium" },
    frameMap: { front: { frame: 1, azimuthDeg: 0 } },
    ...(measure ? { measure } : {}),
  });
}
function body(text: string) {
  return JSON.stringify({
    content: [{ type: "thinking", thinking: "" }, { type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 21000, output_tokens: 7000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}
const plan = (text: string, delayMs = 2): Plan => ({ body: body(text), delayMs });

// ─── 1 and 2. Three reads ─────────────────────────────────────────────────────────────────────
Deno.test("v2, three reads: each gable read's pitch is its points' BEFORE the median, and a read with bad points keeps the model's", async () => {
  const r = await run({ v2: true }, [
    // The model said 0.8; its points say 0.4. It also gives the old porch points, which are not read.
    plan(replyText({ pitch: 0.8, porch: 0.15 }, { pitch: gable(160), porchPitch: oldPorch })),
    // The model said 0.6; its points say 0.42.
    plan(replyText({ pitch: 0.6, porch: 0.12 }, { pitch: gable(168) })),
    // The model said 0.5; its points are y-up, which is refused.
    plan(replyText({ pitch: 0.5, porch: 0.2 }, { pitch: gableYUp })),
  ]);
  assertEquals(r.sent.length, 3, "a v2 press is still three reads");
  assertEquals(r.out.answered, null, "it drafted");
  assertEquals(r.released, [], "and is charged");
  assertEquals(r.logged, []);
  // The median of 0.4, 0.42 and 0.5 is 0.42. Of the model's own 0.8, 0.6 and 0.5 it would be 0.6.
  assertEquals(r.out.drafted.d3.roof.pitch, 0.42);
  // The porch roof is the median of the model's own 0.15, 0.12 and 0.2: points never touch it.
  assertEquals(r.out.drafted.d3.roof.porchPitch, 0.15);
  assertEquals(r.out.consensus.report.spread.pitch, [0.4, 0.5]);
  assert(!JSON.stringify(r.out.drafted.d3).includes("measure"), "the points never reach the spec");
  // One usage write: the three-read record, a sample per read saying which source won.
  assertEquals(r.usage.length, 1);
  const samples = r.usage[0].samples as Record<string, unknown>[];
  assertEquals(samples.map((x) => [x.pitch, x.pitchSource, x.modelPitch ?? null, x.pitchRejected ?? null]), [
    [0.4, "points", 0.8, null],
    [0.42, "points", 0.6, null],
    [0.5, "model", null, true],
  ]);
  assertEquals(samples.map((x) => [x.porchPitch, "porchPitchSource" in x]), [[0.15, false], [0.12, false], [0.2, false]]);
  assert(samples.every((x) => x.type === "gable" && x.porchOutFt === 6), "each sample is still the read's roof");
});

Deno.test("v2, three reads with no points at all: the model's numbers, exactly as before, and every sample says so", async () => {
  const r = await run({ v2: true }, [
    plan(replyText({ pitch: 0.8, porch: 0.15 })),
    plan(replyText({ pitch: 0.6, porch: 0.12 })),
    plan(replyText({ pitch: 0.5, porch: 0.2 })),
  ]);
  assertEquals([r.out.drafted.d3.roof.pitch, r.out.drafted.d3.roof.porchPitch], [0.6, 0.15]);
  const samples = r.usage[0].samples as Record<string, unknown>[];
  assertEquals(samples.map((x) => x.pitchSource), ["model", "model", "model"]);
  assert(samples.every((x) => !("pitchRejected" in x) && !("modelPitch" in x)), "no points given is not a rejection");
});

// ─── 3. The lean retry ────────────────────────────────────────────────────────────────────────
Deno.test("v2 lean retry: its one read is drafted with its measured pitch, and its record carries that read's sample", async () => {
  const r = await run({ v2: true, lean: true }, [plan(replyText({ pitch: 0.8, porch: 0.15 }, { pitch: gable(160) }))]);
  assertEquals(r.sent.length, 1, "one read");
  assertEquals(r.out.consensus, null, "no consensus");
  assertEquals(r.out.callsUsage, null, "the single call's own record");
  assertEquals([r.out.drafted.d3.roof.pitch, r.out.drafted.d3.roof.porchPitch], [0.4, 0.15]);
  const tokens = r.usage[0];
  assertEquals(tokens.model, "claude-opus-5");
  assertEquals((tokens.samples as Record<string, unknown>[]).map((x) => [x.pitch, x.pitchSource, x.modelPitch, x.porchPitch]),
    [[0.4, "points", 0.8, 0.15]]);
  // The rest of the single call's record is what it always was.
  for (const k of ["input", "output", "cache_read", "cache_creation", "stopReason", "textChars", "blockTypes"]) assert(k in tokens, `${k} is still recorded`);
});

// ─── 4. Legacy is untouched ───────────────────────────────────────────────────────────────────
Deno.test("legacy: a reply's points are ignored, the request bytes are unchanged, and the record has no samples", async () => {
  // A legacy reply never has points (the legacy prompts do not ask), but if one did, nothing reads them.
  const text = replyText({ pitch: 0.8, porch: 0.15 }, { pitch: gable(160) });
  const r = await run({ v2: false }, [plan(text)]);
  assertEquals(r.sent.length, 1);
  const want = parseModelSpec(text, DIMS);
  assert(want.ok, "fixture");
  assertEquals(r.out.drafted.d3, want.ok ? want.d3 : null, "the reply's own spec, as parseModelSpec has always made it");
  assertEquals(r.out.drafted.d3.roof.pitch, 0.8);
  assert(!("samples" in r.usage[0]), "no samples on a legacy record");
  assert(!("pitch" in r.out.lead.reading), "a legacy reading carries no sources");
  // The request is the legacy one: Sonnet, the frozen prompt with the old ruler, no measure asked for.
  const sentBody = JSON.parse(r.sent[0].init.body);
  assertEquals(sentBody.model, "claude-sonnet-5");
  const prompt = sentBody.messages[0].content.at(-1).text as string;
  assertEquals(prompt, videoShapePrompt(DIMS, false));
  assert(!prompt.includes('"measure"'), "the legacy prompt asks for no points");
  // And the v2 request asks for them.
  const v2 = await run({ v2: true, lean: true }, [plan(text)]);
  assert((JSON.parse(v2.sent[0].init.body).messages[0].content.at(-1).text as string).includes('"measure": {'), "v2 asks");
});

Deno.test("a gambrel or a shed read keeps its own pitch whatever points it gives, and they are not counted as rejected", async () => {
  const other = (roof: Record<string, unknown>, pitch: Record<string, unknown>) => JSON.stringify({
    roof: { front: "gable", overhangIn: 6, ...roof },
    colors: {},
    observed: { porch: "none", wings: "none", confidence: "medium" },
    measure: { pitch },
  });
  for (const [name, text, own] of [
    // A gambrel's pitch key is not a rake slope.
    ["a gambrel given gable points", other({ type: "gambrel", pitch: 0.7, kneeU: 0.75, kneeRise: 0.72, ridgeRise: 1.03 }, gable(160)), 0.7],
    // A shed's slope from its wall edges read far off in a yawed frame, so it is never worked out.
    ["a shed given its wall edges", other({ type: "shed", front: undefined, highSide: "front", pitch: 0.2 }, oldShed), 0.2],
    ["a shed given gable points", other({ type: "shed", front: undefined, highSide: "front", pitch: 0.2 }, gable(160)), 0.2],
  ] as const) {
    const r = await run({ v2: true, lean: true }, [plan(text)]);
    assertEquals(r.out.drafted.d3.roof.pitch, own, name);
    const s = (r.usage[0].samples as Record<string, unknown>[])[0];
    assertEquals([s.pitchSource, "pitchRejected" in s, "porchPitchSource" in s], ["model", false, false], name);
  }
});
