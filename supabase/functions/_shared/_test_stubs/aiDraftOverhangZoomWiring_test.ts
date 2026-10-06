// The eave overhang read from close-ups (2026-09-29), in calibrate_style_ai's wiring, RUN, not regex-read.
//
// WHY THIS EXISTS. The v2 reads judged a gable's overhang at 6 in where the eaves stand 12 and 16 in
// past the walls. overhangZoom.ts cuts the gable's two corners out of the frame the reads marked them
// in (measure.pitch, kept on each reading as `pitchPoints`), enlarges them and asks about them; its
// own tests pin the method. What only the handler can get wrong, and what this pins:
//
//   1. The close-up runs on a v2 CONSENSUS whose roof is a gable, and only when the builder left the
//      overhang to be read (dims.overhangIn): never on a shed or a gambrel, a legacy request, the lean
//      retry's single read, or a builder-measured eave, which stands as the builder typed it.
//   2. It is handed every read's pitch points in call order, the frames, the consensus's roof and the
//      builder's width and depth, the draft's own budget and signal, and the v2 model.
//   3. Its overhang replaces the consensus's through the sanitiser, before the consensus takes the
//      lead's place; an answer of null leaves the overhang exactly as it was.
//   4. What it did is kept in draft_tokens.overhangZoom, and its tokens join the summed usage that
//      becomes the capture's cost basis, as the roof step's close-up does.
//   5. It runs BESIDE the roof step's close-up, not after it: a draft that needs both waits for the
//      slower of the two, and both land.
//
// HOW: aiDraftMeasureWiring_test's idiom. The handler's block from the abort signal to the end of the
// parse-failure exit is lifted and run as an async function against stand-ins for the fetch, the hold,
// the logger and the ledger, with the real styleD3 functions; the two close-ups are stand-ins that
// record what they were handed (overhangZoom.test.ts and stepZoom.test.ts run the real ones).

import { assert, assertEquals } from "jsr:@std/assert";
import {
  aiDraftCostCents, aiModelFields, combinedShapePrompt, consensusOfCalls, draftCallCount, draftCallsUsage, draftReadSample,
  parseModelSpec, readDraftReply, runDraftCalls, sanitizeD3Spec, SPEC_PROMPT, videoShapePrompt, DRAFT_CONSENSUS_GRACE_MS,
  DRAFT_READ_RETRY, draftUpstreamFailure,
} from "../styleD3.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SOURCE = await read("../../portal-settings/index.ts");

function lift(start: string, end: string, what: string): string {
  const i = SOURCE.indexOf(start);
  const j = i < 0 ? -1 : SOURCE.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `aiDraftOverhangZoomWiring_test: could not find ${what} in portal-settings/index.ts (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return SOURCE.slice(i, j);
}

const CALL_BLOCK = lift("    const aiSignal = AbortSignal.timeout(draftAbortMs);", "    // ── HOW THE OVERHANG IS FRAMED", "the draft call block");
for (const must of [
  'const overhangAsked = !!zoomRoof && zoomRoof.type === "gable" && !!dims && (dims.overhangIn === undefined || dims.overhangIn === null);',
  "const [stepZoom, overhangZoom] = await Promise.all([",
  "blocks: calls.map((c) => c.reading?.pitchPoints ?? null), photoUrls, roof: zoomRoof,",
  "callsUsage.tokens.overhangZoom = overhangZoom.record;",
  "if (consensus) drafted.d3 = consensus.d3;",
]) {
  assert(CALL_BLOCK.includes(must), `the lifted call block is missing ${must} — re-point the anchors`);
}
// The close-up's own model calls live in closeUp.ts: the handler keeps its two (aiDraftFrameGateWiring_test).
assertEquals(SOURCE.split('fetch("https://api.anthropic.com/v1/messages"').length - 1, 2, "no new model call in portal-settings");

// ─── The stand-ins ─────────────────────────────────────────────────────────────────────────────
type Plan = { body: string; delayMs?: number };
type Sent = { url: string; init: RequestInit & { signal: AbortSignal; body: string } };
type Row = Record<string, unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const PARAMS = [
  "AbortSignal", "draftAbortMs", "aiModelFields", "v2Prompt", "lean", "photoUrls", "combined", "combinedShapePrompt",
  "videoCount", "dims", "fromVideo", "videoShapePrompt", "SPEC_PROMPT", "apiKey", "draftCallCount", "runDraftCalls",
  "DRAFT_CONSENSUS_GRACE_MS", "fetch", "readDraftReply", "consensusOfCalls", "draftCallsUsage", "recordDraftUsage",
  "releaseHold", "logEdgeError", "req", "clientId", "t0", "requestStartMs", "aiSource", "json", "filedAtReturnSite",
  "parseModelSpec", "streamed", "draftEffort", "draftReadSample", "DRAFT_READ_RETRY", "draftUpstreamFailure",
  "runStepZoom", "runOverhangZoom", "sanitizeD3Spec",
];
const RUN = new AsyncFunction(
  ...PARAMS,
  `${CALL_BLOCK}\nreturn { answered: null, drafted, lead, consensus, callsUsage, text, calls, aiSignal };`,
);

// A 14 ft wide, 40 ft deep gable cabin with a 7.75 ft wall, and twelve walk frames.
const DIMS = { widthFt: 14, lengthFt: 40, wallHeightFt: 7.75 };
const FRAMES = Array.from({ length: 12 }, (_, i) => `https://example.test/walk/f${i + 1}.jpg`);

// The close-ups, as stand-ins: each records what it was handed and when, waits `ms`, and answers `result`.
type Zoom = { overhangFt?: number | null; riseFt?: number | null; record: Row | null; input: number; output: number };
const NOTHING: Zoom = { overhangFt: null, riseFt: null, record: null, input: 0, output: 0 };
function closeUps(o: { step?: Zoom; overhang?: Zoom; ms?: number } = {}) {
  const log: { name: "step" | "overhang"; args: Row; start: number; end: number }[] = [];
  let inFlight = 0, most = 0;
  const make = (name: "step" | "overhang", result: Zoom | undefined) => async (args: Row) => {
    const entry = { name, args, start: Date.now(), end: 0 };
    log.push(entry);
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, o.ms ?? 1));
    inFlight--;
    entry.end = Date.now();
    return result ?? NOTHING;
  };
  return { step: make("step", o.step), overhang: make("overhang", o.overhang), log, most: () => most };
}

async function run(s: { v2: boolean; lean?: boolean; dims?: Row }, plans: Plan[], zooms = closeUps()) {
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
  const usage: Row[] = [];
  const t0 = Date.now();
  try {
    const out = await RUN(
      fakeAbortSignal, 5_000, aiModelFields, s.v2, s.lean ?? false, FRAMES, false, combinedShapePrompt,
      0, s.dims ?? DIMS, true, videoShapePrompt, SPEC_PROMPT, "test-key", draftCallCount, runDraftCalls,
      DRAFT_CONSENSUS_GRACE_MS, fetch, readDraftReply, consensusOfCalls, draftCallsUsage,
      // deno-lint-ignore require-await
      async (tokens: Row) => { usage.push(tokens); },
      // deno-lint-ignore require-await
      async (reason: string) => { released.push(reason); },
      // deno-lint-ignore require-await
      async (e: { code: string }) => { logged.push(e.code); },
      null, "harness-tenant", t0, t0 - 1_000, "video",
      (body: Row, status = 200) => ({ body, status }),
      new Set(), parseModelSpec, false, s.lean ? "low" : "medium", draftReadSample,
      { ...DRAFT_READ_RETRY, staggerMs: 0 }, draftUpstreamFailure,
      zooms.step, zooms.overhang, sanitizeD3Spec,
    );
    return { out, sent, released, logged, usage, t0 };
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}

// ─── Replies ───────────────────────────────────────────────────────────────────────────────────
// A gable read at 6 in of overhang, and the gable's points in a 1280 x 720 frame (generic numbers,
// the shape the v2 reply gives them in).
const PITCH = (dy = 0) => ({ frame: 2, size: [1280, 720], left: [248, 226 + dy], peak: [645, 108], right: [975, 268 + dy] });
function replyText(roof: Row = {}, pitch?: Row) {
  return JSON.stringify({
    ...(pitch ? { measure: { pitch } } : {}),
    roof: { type: "gable", front: "gable", pitch: 0.5, overhangIn: 6, eave: "fascia", ...roof },
    colors: { body: "#333333", trim: "#222222", roof: "#1a1a1a" },
    roofMaterial: "metal",
    observed: { roofNote: "a gable cabin", porch: "none", wings: "none", confidence: "medium" },
    frameMap: { front: { frame: 1, azimuthDeg: 0 } },
  });
}
const body = (text: string) => JSON.stringify({
  content: [{ type: "thinking", thinking: "" }, { type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 21000, output_tokens: 7000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const plan = (text: string, delayMs = 2): Plan => ({ body: body(text), delayMs });
// Five gable reads, four of them with the gable's points.
const FIVE = (roof: Row = {}) => [
  plan(replyText(roof, PITCH(0))), plan(replyText(roof, PITCH(2))), plan(replyText(roof)),
  plan(replyText(roof, PITCH(-2))), plan(replyText(roof, PITCH(0))),
];
const MEASURED: Zoom = {
  overhangFt: 17 / 12,
  record: { frame: 2, gableFt: 14, before: 0.5, tips: { left: [248, 226], right: [975, 268] }, asks: [], used: 3, after: 17 / 12, ms: 14000, usage: { input: 9900, output: 2700 } },
  input: 9900, output: 2700,
};

// ─── 1 to 4 ────────────────────────────────────────────────────────────────────────────────────
Deno.test("⚠️ a v2 gable consensus: the close-up is handed every read's pitch points, and its overhang lands", async () => {
  const zooms = closeUps({ overhang: MEASURED });
  const r = await run({ v2: true }, FIVE(), zooms);
  assertEquals([r.sent.length, r.out.answered, r.released, r.logged], [5, null, [], []], "a five-read draft, charged");
  assertEquals(zooms.log.map((z) => z.name), ["overhang"], "the overhang's close-up alone: this roof has no step");
  const args = zooms.log[0].args;
  assertEquals(args.blocks, [PITCH(0), PITCH(2), null, PITCH(-2), PITCH(0)], "each read's own points, in call order");
  assertEquals([args.photoUrls, args.widthFt, args.lengthFt, args.apiKey, args.model], [FRAMES, 14, 40, "test-key", { model: "claude-opus-5-5" }]);
  assertEquals((args.roof as Row).type, "gable");
  assertEquals((args.roof as Row).overhang, 0.5, "the consensus's roof, before the close-up");
  assert(args.signal === r.out.aiSignal, "the draft's own signal");
  assert(typeof args.leftMs === "number" && args.leftMs > 0 && args.leftMs <= 5_000, `the draft's budget left: ${args.leftMs}`);
  // It lands, through the sanitiser, and the consensus carries it into the draft.
  assertEquals(r.out.drafted.d3.roof.overhang, 17 / 12);
  assertEquals(r.out.consensus.d3.roof.overhang, 17 / 12);
  assertEquals(r.out.drafted.d3.roof.pitch, r.out.consensus.d3.roof.pitch, "and nothing else moved");
  // Kept in draft_tokens, and its tokens join the cost basis, not the reads' own sums.
  assertEquals(r.out.callsUsage.tokens.overhangZoom, MEASURED.record);
  assertEquals(r.usage.length, 1);
  assertEquals(r.usage[0].overhangZoom, MEASURED.record, "the usage write carries it");
  assertEquals([r.out.callsUsage.usage.input_tokens, r.out.callsUsage.usage.output_tokens], [5 * 21000 + 9900, 5 * 7000 + 2700]);
  assertEquals([r.out.callsUsage.tokens.input, r.out.callsUsage.tokens.output], [5 * 21000, 5 * 7000], "the reads' own sums stand");
  // The capture prices exactly that summed usage.
  const stmt = lift("      const u = callsUsage ? callsUsage.usage : (data?.usage ?? null);", "      const { data: bal", "the capture's cost basis");
  const [u, costCents] = new Function("callsUsage", "data", "v2Prompt", "aiDraftCostCents", `${stmt}\nreturn [u, costCents];`)(r.out.callsUsage, null, true, aiDraftCostCents);
  assertEquals(u.input_tokens, 5 * 21000 + 9900);
  assertEquals(costCents, aiDraftCostCents(true, 5 * 21000 + 9900, 5 * 7000 + 2700));
});

Deno.test("a close-up that measured nothing leaves the consensus's overhang, and is still recorded and counted", async () => {
  const none: Zoom = { overhangFt: null, record: { frame: 2, before: 0.5, used: 1, after: null, usage: { input: 3300, output: 900 } }, input: 3300, output: 900 };
  const r = await run({ v2: true }, FIVE(), closeUps({ overhang: none }));
  assertEquals(r.out.drafted.d3.roof.overhang, 0.5, "6 in, as the reads said");
  assertEquals(r.out.callsUsage.tokens.overhangZoom, none.record);
  assertEquals(r.out.callsUsage.usage.input_tokens, 5 * 21000 + 3300);
  // Not tried at all (no usable points, too little time): nothing recorded, nothing counted.
  const q = await run({ v2: true }, FIVE(), closeUps());
  assertEquals([q.out.drafted.d3.roof.overhang, "overhangZoom" in q.out.callsUsage.tokens, q.out.callsUsage.usage.input_tokens], [0.5, false, 5 * 21000]);
});

Deno.test("⚠️ the builder's measured overhang always wins: no close-up, and their number stands", async () => {
  const zooms = closeUps({ overhang: MEASURED });
  const r = await run({ v2: true, dims: { ...DIMS, overhangIn: 16 } }, FIVE(), zooms);
  assertEquals(zooms.log, [], "never asked");
  assertEquals(r.out.drafted.d3.roof.overhang, 16 / 12, "the builder's 16 in");
  assert(!("overhangZoom" in r.out.callsUsage.tokens), "nothing recorded");
  // A measured 0 is a measurement too (a flush eave).
  const flush = closeUps({ overhang: MEASURED });
  const f = await run({ v2: true, dims: { ...DIMS, overhangIn: 0 } }, FIVE(), flush);
  assertEquals([flush.log.length, f.out.drafted.d3.roof.overhang], [0, 0]);
});

Deno.test("no close-up on a shed, a gambrel, a legacy request or the lean retry's single read", async () => {
  const cases: [string, { v2: boolean; lean?: boolean }, Plan[]][] = [
    ["a shed", { v2: true }, FIVE({ type: "shed", front: undefined, highSide: "front", pitch: 0.2 })],
    ["a gambrel", { v2: true }, FIVE({ type: "gambrel", kneeU: 0.78, kneeRise: 0.7, ridgeRise: 1.0 })],
    ["legacy", { v2: false }, [plan(replyText({}, PITCH()))]],
    ["the lean retry", { v2: true, lean: true }, [plan(replyText({}, PITCH()))]],
  ];
  for (const [name, s, plans] of cases) {
    const zooms = closeUps({ overhang: MEASURED });
    const r = await run(s, plans, zooms);
    assertEquals(r.out.answered, null, `${name}: it drafted`);
    assertEquals(zooms.log, [], `${name}: no close-up`);
    assertEquals(r.out.drafted.d3.roof.overhang, 0.5, `${name}: the reads' own overhang`);
  }
});

// ─── 5. Beside the roof step's ─────────────────────────────────────────────────────────────────
Deno.test("⚠️ with a roof step too, the two close-ups run SIDE BY SIDE and both land", async () => {
  const step: Zoom = { riseFt: 0.39, record: { frame: 5, before: -0.25, votes: { front: 0, back: 3 }, after: 0.39, usage: { input: 4500, output: 1200 } }, input: 4500, output: 1200 };
  const zooms = closeUps({ step, overhang: MEASURED, ms: 300 });
  const r = await run({ v2: true }, FIVE({ rearStepFt: 12, rearEaveRiseFt: -0.25 }), zooms);
  assertEquals(zooms.log.map((z) => z.name).sort(), ["overhang", "step"]);
  assertEquals(zooms.most(), 2, "both in flight at once");
  const [a, b] = zooms.log;
  assert(b.start < a.end && a.start < b.end, "each started before the other finished");
  const waited = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  assert(waited < 550, `the slower of two 300 ms close-ups, not the two added up: ${waited} ms`);
  // Each is handed its own: the step its rise, the overhang the gable's points.
  const stepArgs = zooms.log.find((z) => z.name === "step")!.args;
  assertEquals([stepArgs.rise0, stepArgs.wallFt, (stepArgs.blocks as unknown[]).length], [-0.25, 7.75, 5]);
  assertEquals(stepArgs.leftMs, zooms.log.find((z) => z.name === "overhang")!.args.leftMs, "one budget reading for both");
  // Both land, both are kept, and both are counted.
  assertEquals([r.out.drafted.d3.roof.rearEaveRiseFt, r.out.drafted.d3.roof.overhang], [0.39, 17 / 12]);
  assertEquals([r.out.callsUsage.tokens.stepZoom, r.out.callsUsage.tokens.overhangZoom], [step.record, MEASURED.record]);
  assertEquals([r.out.callsUsage.usage.input_tokens, r.out.callsUsage.usage.output_tokens], [5 * 21000 + 4500 + 9900, 5 * 7000 + 1200 + 2700]);
  // The step's close-up alone, when the builder measured the eave: exactly as before this change.
  const alone = closeUps({ step, overhang: MEASURED });
  const s = await run({ v2: true, dims: { ...DIMS, overhangIn: 12 } }, FIVE({ rearStepFt: 12, rearEaveRiseFt: -0.25 }), alone);
  assertEquals(alone.log.map((z) => z.name), ["step"]);
  assertEquals([s.out.drafted.d3.roof.rearEaveRiseFt, s.out.drafted.d3.roof.overhang], [0.39, 1]);
  assert(!("overhangZoom" in s.out.callsUsage.tokens), "only the step's record");
});
