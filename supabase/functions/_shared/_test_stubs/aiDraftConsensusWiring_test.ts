// Consensus drafting's wiring in calibrate_style_ai (2026-09-25), RUN, not regex-read.
//
// WHY THIS EXISTS. Live v2 runs of one video kept the shape and let the numbers wander (a raised
// centre's eave 15, 14 and 12.5 ft; the pitch 0.37 to 0.7; 3 posts or 4), so the v2 draft now sends
// its request three times in parallel and combines the reads (consensusDrafts, styleD3.test.ts). The
// pure half is tested there. What only the handler can get wrong, and what this pins:
//
//   1. v2 sends THREE identical request bodies, in parallel; every legacy request and the lean retry
//      send ONE, byte-for-byte the request the single call always sent, on the deadline signal itself.
//   2. Two reads of three are enough: the answer is their consensus, and a straggler is cut off.
//   3. When no read drafts, the builder gets exactly the error a single call would have given for
//      the FIRST call sent (not the first to come back): the same status, code, `retryable` and
//      hold release, whatever the other two did.
//   4. Every call's usage is summed, for draft_tokens and for the capture's cost basis.
//
// HOW: the aiDraftUsageWiring_test idiom. The handler's block from the abort signal to the end of the
// parse-failure exit is lifted between stable anchors and run as an async function against a stand-in
// fetch, hold, logger and ledger, with the real styleD3 functions. It has no type annotations, which
// is what lets it run as JavaScript.

import { assert, assertEquals } from "jsr:@std/assert";
import {
  aiDraftCostCents, aiModelFields, combinedShapePrompt, consensusOfCalls, consensusSplitWarning,
  draftCallCount, draftCallsUsage, flagObservedNotes, frameKeyWarning, gambrelRoofWarning, knownDimsNote,
  parseModelSpec, parseObservedNotes, porchAgreementWarning, readDraftReply, runDraftCalls, SPEC_PROMPT,
  videoShapePrompt, wingsAgreementWarning, DRAFT_CONSENSUS_GRACE_MS,
} from "../styleD3.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SOURCE = await read("../../portal-settings/index.ts");

function lift(start: string, end: string, what: string): string {
  const i = SOURCE.indexOf(start);
  const j = i < 0 ? -1 : SOURCE.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `aiDraftConsensusWiring_test: could not find ${what} in portal-settings/index.ts (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return SOURCE.slice(i, j);
}

// From the abort signal to the first line after the parse-failure exit: the request, the calls, the
// consensus, every failure exit, and the consensus taking the lead's place.
const CALL_BLOCK = lift("    const aiSignal = AbortSignal.timeout(draftAbortMs);", "    // ── HOW THE OVERHANG IS FRAMED", "the draft call block");
for (const must of ["runDraftCalls(", "consensusOfCalls(", "if (consensus) drafted.d3 = consensus.d3;", "return failed;", "return timedOut;"]) {
  assert(CALL_BLOCK.includes(must), `the lifted call block is missing ${must} — re-point the anchors`);
}

// ─── The stand-ins ─────────────────────────────────────────────────────────────────────────────
type Plan = { status?: number; body?: string; delayMs?: number; hang?: boolean; throws?: string };
type Sent = { url: string; init: RequestInit & { signal: AbortSignal; body: string } };
type Reply = { body: Record<string, unknown>; status: number };

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const PARAMS = [
  "AbortSignal", "draftAbortMs", "aiModelFields", "v2Prompt", "lean", "photoUrls", "combined", "combinedShapePrompt",
  "videoCount", "dims", "fromVideo", "videoShapePrompt", "SPEC_PROMPT", "apiKey", "draftCallCount", "runDraftCalls",
  "DRAFT_CONSENSUS_GRACE_MS", "fetch", "readDraftReply", "consensusOfCalls", "draftCallsUsage", "recordDraftUsage",
  "releaseHold", "logEdgeError", "req", "clientId", "t0", "requestStartMs", "aiSource", "json", "filedAtReturnSite",
  "parseModelSpec",
];
const RUN = new AsyncFunction(
  ...PARAMS,
  `${CALL_BLOCK}\nreturn { answered: null, drafted, lead, consensus, callsUsage, text, aiSignal, calls };`,
);

const DIMS = { widthFt: 30, lengthFt: 20, wallHeightFt: 8 };
const FRAMES = Array.from({ length: 12 }, (_, i) => `https://example.test/walk/f${i + 1}.jpg`);
type Scenario = { v2: boolean; lean?: boolean; source?: "video" | "combined" | "photos"; videoCount?: number; photoUrls?: string[]; graceMs?: number; abortMs?: number };

async function run(s: Scenario, plans: Plan[]) {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const fakeAbortSignal = {
    timeout: (ms: number) => {
      const c = new AbortController();
      timers.push(setTimeout(() => c.abort(new DOMException("Signal timed out.", "TimeoutError")), ms));
      return c.signal;
    },
  };
  const sent: Sent[] = [];
  let sentWhenFirstAnswered = -1;
  const pending: ReturnType<typeof setTimeout>[] = [];
  const fetch = (url: string, init: Sent["init"]): Promise<Response> => {
    const plan = plans[sent.length] ?? { hang: true };
    sent.push({ url, init });
    return new Promise((resolve, reject) => {
      if (plan.throws) { reject(new TypeError(plan.throws)); return; }
      const signal = init.signal;
      let t: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => { if (t !== undefined) clearTimeout(t); reject(new DOMException("The signal has been aborted", "AbortError")); };
      if (!plan.hang) {
        t = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          if (sentWhenFirstAnswered < 0) sentWhenFirstAnswered = sent.length;
          resolve(new Response(plan.body ?? "", { status: plan.status ?? 200 }));
        }, plan.delayMs ?? 1);
        pending.push(t!);
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const released: string[] = [];
  const logged: { code: string; context?: Record<string, unknown> }[] = [];
  const usage: unknown[] = [];
  const filed = new Set<unknown>();
  const source = s.source ?? "video";
  const photoUrls = s.photoUrls ?? FRAMES;
  const combined = source === "combined";
  const fromVideo = source === "video";
  const dims = source === "photos" ? null : DIMS;
  const t0 = Date.now();
  try {
    const out = await RUN(
      fakeAbortSignal, s.abortMs ?? 2_000, aiModelFields, s.v2, s.lean ?? false, photoUrls, combined, combinedShapePrompt,
      s.videoCount ?? (combined ? 8 : 0), dims, fromVideo, videoShapePrompt, SPEC_PROMPT, "test-key", draftCallCount, runDraftCalls,
      s.graceMs ?? DRAFT_CONSENSUS_GRACE_MS, fetch, readDraftReply, consensusOfCalls, draftCallsUsage,
      // deno-lint-ignore require-await
      async (tokens: unknown) => { usage.push(tokens); },
      // deno-lint-ignore require-await
      async (reason: string) => { released.push(reason); },
      // deno-lint-ignore require-await
      async (e: { code: string; context?: Record<string, unknown> }) => { logged.push({ code: e.code, context: e.context }); },
      null, "harness-tenant", t0, t0 - 1_000, source,
      (body: Record<string, unknown>, status = 200): Reply => ({ body, status }),
      filed, parseModelSpec,
    );
    // A return from inside the block is a Reply; falling off its end is the success object.
    const answered = out && "status" in out && "body" in out ? out as Reply : null;
    return { out, answered, sent, sentWhenFirstAnswered, released, logged, usage, filed, ms: Date.now() - t0, dims, photoUrls, combined, fromVideo };
  } finally {
    for (const t of timers) clearTimeout(t);
    for (const t of pending) clearTimeout(t);
  }
}

// ─── Replies ───────────────────────────────────────────────────────────────────────────────────
const SPEC = {
  roof: {
    type: "gable", front: "gable", pitch: 0.5, overhangIn: 6, eave: "fascia",
    wingSide: "both", wingWidthFt: 9, wingPitch: 0.25, centerEaveFt: 14,
    porchOutFt: 6, porchEnd: "front", porchAttachFt: 10, porchPosts: 4, porchPitch: 0.2, porchSteps: "center",
  },
  colors: { body: "#333333", trim: "#222222", roof: "#1a1a1a", corner: "#333333", fascia: "#1a1a1a" },
  roofMaterial: "metal",
  observed: { roofNote: "raised gable centre, a wing each side", porch: "projecting", wings: "both", confidence: "medium" },
  frameMap: { front: { frame: 1, azimuthDeg: 0 }, back: { frame: 7, azimuthDeg: 180 } },
};
const spec = (roof: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ ...SPEC, ...extra, roof: { ...SPEC.roof, ...roof } });
// What the handler's own parse makes of a reply text: the single call's spec.
function specOf(text: string, dims: typeof DIMS | null) {
  const p = parseModelSpec(text, dims);
  if (!p.ok) throw new Error(`fixture does not parse: ${p.error}`);
  return p.d3;
}
function body(text: string, o: { stop?: string; out?: number; inp?: number; category?: string } = {}) {
  return JSON.stringify({
    content: [{ type: "thinking", thinking: "" }, { type: "text", text }],
    stop_reason: o.stop ?? "end_turn",
    ...(o.category ? { stop_details: { category: o.category } } : {}),
    usage: { input_tokens: o.inp ?? 21000, output_tokens: o.out ?? 7000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}
const GOOD = (roof: Record<string, unknown> = {}, o: { out?: number } = {}): Plan => ({ body: body(JSON.stringify(spec(roof)), o), delayMs: 2 });
const TRUNCATED: Plan = { body: body('{"roof":{"type":"gable","pit', { stop: "max_tokens", out: 12000 }), delayMs: 2 };
const UNPARSEABLE: Plan = { body: body("I could not tell what this building is."), delayMs: 2 };
const REFUSED: Plan = { body: body("", { stop: "refusal", category: "cyber" }), delayMs: 2 };
const OVERLOADED: Plan = { status: 529, body: '{"type":"error","error":{"type":"overloaded_error"}}', delayMs: 2 };

// The request the single call has always sent, built HERE, independently of the handler, key for key.
function expectedBody(r: Awaited<ReturnType<typeof run>>, v2: boolean, lean: boolean, videoCount: number) {
  return JSON.stringify({
    model: v2 ? "claude-opus-5" : "claude-sonnet-5",
    max_tokens: 12000,
    thinking: { type: "adaptive" },
    output_config: { effort: lean ? "low" : (v2 ? "high" : "medium") },
    messages: [{
      role: "user",
      content: [
        ...r.photoUrls.map((url) => ({ type: "image", source: { type: "url", url } })),
        {
          type: "text",
          text: r.combined ? combinedShapePrompt(videoCount, r.photoUrls.length - videoCount, r.dims, v2)
            : r.fromVideo ? videoShapePrompt(r.dims, v2) : SPEC_PROMPT,
        },
      ],
    }],
  });
}
const HEADERS = { "content-type": "application/json", "x-api-key": "test-key", "anthropic-version": "2023-06-01" };

// ─── 1. How many calls, and what they send ─────────────────────────────────────────────────────
Deno.test("legacy requests and the lean retry send ONE call: today's request, byte for byte, on the deadline signal itself", async () => {
  const cases: [string, Scenario][] = [
    ["legacy walk-around (production's older designer)", { v2: false }],
    ["legacy combined set", { v2: false, source: "combined", videoCount: 8, photoUrls: FRAMES.slice(0, 10) }],
    ["the photos source", { v2: false, source: "photos", photoUrls: FRAMES.slice(0, 4) }],
    ["the v2 lean retry", { v2: true, lean: true }],
    ["a lean legacy request", { v2: false, lean: true }],
  ];
  for (const [what, s] of cases) {
    const r = await run(s, [GOOD()]);
    assertEquals(r.sent.length, 1, `${what}: one call`);
    const { url, init } = r.sent[0];
    assertEquals(url, "https://api.anthropic.com/v1/messages", what);
    assertEquals(init.method, "POST", what);
    assertEquals(init.headers, HEADERS, what);
    assertEquals(init.body, expectedBody(r, s.v2, s.lean ?? false, s.videoCount ?? 0), `${what}: the bytes`);
    assert(init.signal === r.out.aiSignal, `${what}: sent on aiSignal itself, not a signal of its own`);
    assertEquals(r.out.consensus, null, `${what}: no consensus`);
    assertEquals(r.out.callsUsage, null, `${what}: usage recorded the single call's way`);
    assertEquals(r.answered, null, `${what}: it drafted`);
    assertEquals(r.out.drafted.d3, specOf(JSON.stringify(spec()), r.dims), `${what}: the reply's own spec`);
  }
});

Deno.test("a v2 press sends THREE identical requests, all before any answer comes back", async () => {
  const r = await run({ v2: true }, [GOOD(), GOOD(), GOOD()]);
  assertEquals(r.sent.length, 3);
  assertEquals(r.sentWhenFirstAnswered, 3, "in parallel: all three were out before the first reply landed");
  const want = expectedBody(r, true, false, 0);
  for (const { url, init } of r.sent) {
    assertEquals(url, "https://api.anthropic.com/v1/messages");
    assertEquals(init.headers, HEADERS);
    assertEquals(init.body, want, "the same bytes each time: Opus, medium effort, the v2 prompt");
    assert(init.signal !== r.out.aiSignal, "each on its own signal, which the one deadline aborts");
  }
  assertEquals(new Set(r.sent.map((x) => x.init.signal)).size, 3);
});

// ─── 2. Two of three is enough ─────────────────────────────────────────────────────────────────
Deno.test("2 of 3: the answer is the consensus of the two that drafted, and the usage is every call's", async () => {
  const r = await run({ v2: true }, [GOOD({ centerEaveFt: 15, pitch: 0.4 }, { out: 7000 }), OVERLOADED, GOOD({ centerEaveFt: 13, pitch: 0.5 }, { out: 9000 })]);
  assertEquals(r.answered, null, "no error reply");
  assertEquals(r.released, [], "the hold is not released: this press is charged");
  assertEquals(r.logged, []);
  assertEquals(r.out.drafted.d3.roof.centerEaveFt, 14, "the midpoint of the two reads");
  assertEquals(r.out.drafted.d3.roof.pitch, 0.45);
  assertEquals(r.out.consensus.report.n, 2);
  assert(r.out.lead === r.out.calls[0], "the lead is the medoid's call, whose notes and frame map the response carries");
  assertEquals(r.out.text, JSON.stringify(spec({ centerEaveFt: 15, pitch: 0.4 })));
  // One usage write, the summed record.
  assertEquals(r.usage.length, 1);
  const tokens = r.usage[0] as Record<string, unknown>;
  assertEquals([tokens.model, tokens.input, tokens.output, tokens.stopReason], ["claude-opus-5", 42000, 16000, "end_turn"]);
  assertEquals((tokens.calls as Record<string, unknown>[]).map((c) => [c.ok, c.output, c.stopReason]), [[true, 7000, "end_turn"], [false, null, null], [true, 9000, "end_turn"]]);
  assertEquals((tokens.samples as Record<string, unknown>[]).map((x) => x.centerEaveFt), [15, 13]);
  assertEquals((tokens.agreement as Record<string, unknown>).n, 2);
  assertEquals(r.out.callsUsage.usage, { input_tokens: 42000, output_tokens: 16000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, calls: 3 });
});

Deno.test("two reads in, the third is cut off after the grace, and the answer does not wait for the deadline", async () => {
  const r = await run({ v2: true, graceMs: 40, abortMs: 5_000 }, [GOOD({ centerEaveFt: 15 }), { hang: true }, GOOD({ centerEaveFt: 12.5 })]);
  assertEquals(r.answered, null);
  assertEquals(r.out.drafted.d3.roof.centerEaveFt, 13.75);
  const calls = (r.usage[0] as Record<string, unknown>).calls as Record<string, unknown>[];
  assertEquals(calls.map((c) => [c.ok, c.aborted]), [[true, null], [false, "quorum"], [true, null]]);
  assert(r.ms < 1_000, `answered ${r.ms} ms after the press, well inside the 5 s deadline`);
});

Deno.test("one read of three is enough to answer: the consensus of one read is that read", async () => {
  const r = await run({ v2: true }, [TRUNCATED, GOOD({ centerEaveFt: 15 }), UNPARSEABLE]);
  assertEquals(r.answered, null);
  assertEquals(r.out.drafted.d3, specOf(JSON.stringify(spec({ centerEaveFt: 15 })), DIMS));
  assert(r.out.lead === r.out.calls[1]);
  assertEquals(consensusSplitWarning(r.out.consensus.report), null, "one read cannot split");
  const tokens = r.usage[0] as Record<string, unknown>;
  assertEquals(tokens.output, 12000 + 7000 + 7000, "the two failures cost money too");
});

// ─── 3. None of three: today's error, for the FIRST call sent ──────────────────────────────────
// Each case runs the SAME first-call outcome twice: alone as a legacy single call (today's handling,
// unchanged) and as the first of three failing v2 calls. The builder must get the same answer.
const FAILURES: [string, Plan, { status: number; code: string | null; retryable: boolean; release: string }][] = [
  ["a reply cut off at max_tokens", TRUNCATED, { status: 502, code: "ai_spec_truncated", retryable: true, release: "reply truncated" }],
  ["an unparseable reply", UNPARSEABLE, { status: 502, code: "ai_spec_unparseable", retryable: false, release: "unparseable spec" }],
  ["a refusal", REFUSED, { status: 502, code: "ai_spec_refused", retryable: false, release: "model refused" }],
  ["an overloaded API", OVERLOADED, { status: 502, code: null, retryable: false, release: "upstream 529" }],
  ["a dropped connection", { throws: "connection reset" }, { status: 502, code: null, retryable: false, release: "fetch failed" }],
  ["the deadline", { hang: true }, { status: 504, code: "ai_call_timeout", retryable: true, release: "model timeout" }],
];
for (const [what, first, want] of FAILURES) {
  Deno.test(`no read drafts, the first call was ${what}: today's ${want.status}${want.code ? ` ${want.code}` : ""}, hold released`, async () => {
    const single = await run({ v2: false, abortMs: 60 }, [first]);
    // The other two fail differently, and more slowly: the first call SENT decides, not the first back.
    const others: Plan[] = what === "the deadline" ? [UNPARSEABLE, REFUSED] : [{ hang: true }, { ...TRUNCATED, delayMs: 20 }];
    const triple = await run({ v2: true, abortMs: 60 }, [first, ...others]);
    for (const [label, r] of [["single", single], ["v2 triple", triple]] as const) {
      assert(r.answered !== null, `${label}: an error reply`);
      assertEquals(r.answered!.status, want.status, `${label}: status`);
      assertEquals(r.answered!.body.retryable === true, want.retryable, `${label}: retryable`);
      assertEquals(r.released, [want.release], `${label}: the hold is released once, for this reason`);
      assertEquals(r.logged.map((l) => l.code), want.code ? [want.code] : [], `${label}: the coded row`);
      assertEquals(r.filed.has(r.answered), want.code !== null, `${label}: filed at the return site exactly when coded`);
    }
    assertEquals(triple.answered!.body, single.answered!.body, "the builder reads the same sentence");
    assertEquals(triple.sent.length, 3);
    // Usage: the single call records today's shape; three calls record all three.
    const one = single.usage[0] as Record<string, unknown> | null;
    if (first.throws || first.hang) assertEquals(one, null, "no reply, no usage, as before");
    else if (first.status) assertEquals(one, null);
    else assert(one !== null && !("calls" in one), "the single call's own record");
    const three = triple.usage[0] as Record<string, unknown>;
    assertEquals((three.calls as unknown[]).length, 3, "every call is on the record, even with no draft");
    assertEquals(three.agreement, null);
  });
}

Deno.test("a first call that failed on its own is not relabelled a timeout by the other two running out the clock", async () => {
  // The single call's catch read aiSignal.aborted when IT threw. With three calls the deadline has
  // usually fired by the time all three settle, so it is read per call, the moment each one threw.
  const r = await run({ v2: true, abortMs: 40 }, [{ throws: "connection reset" }, { hang: true }, { hang: true }]);
  assertEquals(r.answered!.status, 502);
  assertEquals(r.answered!.body.error, "Could not reach the AI service: connection reset");
  assertEquals(r.released, ["fetch failed"]);
  assertEquals(((r.usage[0] as Record<string, unknown>).calls as Record<string, unknown>[]).map((c) => c.aborted), [null, "deadline", "deadline"]);
});

// ─── 4. The capture and the flags ──────────────────────────────────────────────────────────────
Deno.test("the capture's cost basis is the summed usage of every call", () => {
  const stmt = lift("      const u = callsUsage ? callsUsage.usage : (data?.usage ?? null);", "      const { data: bal", "the capture's cost basis");
  const cost = (callsUsage: unknown, data: unknown, v2Prompt: boolean) =>
    new Function("callsUsage", "data", "v2Prompt", "aiDraftCostCents", `${stmt}\nreturn [u, costCents];`)(callsUsage, data, v2Prompt, aiDraftCostCents);
  const summed = { input_tokens: 63000, output_tokens: 21000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, calls: 3 };
  const lead = { usage: { input_tokens: 21000, output_tokens: 7000 } };
  assertEquals(cost({ usage: summed }, lead, true), [summed, aiDraftCostCents(true, 63000, 21000)], "three calls: three calls' cost");
  assertEquals(cost(null, lead, false), [lead.usage, aiDraftCostCents(false, 21000, 7000)], "one call: exactly as before");
  assertEquals(aiDraftCostCents(true, 63000, 21000), 84, "3 x 21k in and 3 x 7k out on Opus is 84 cents");
});

Deno.test("the split check rides the flags only with a consensus, and turns the draft low-confidence", () => {
  const line = SOURCE.split("\n").find((l) => l.includes("flagObservedNotes(observedRead,")) ?? "";
  assert(line.includes("consensus ? consensusSplitWarning(consensus.report) : null, knownDimsNote(dims))"), "composed, before the clamp note");
  const call = line.trim().replace(/^\? /, "");
  const flags = (consensus: unknown) => new Function(
    "observedRead", "v2Prompt", "frameKeyWarning", "drafted", "gambrelRoofWarning", "porchAgreementWarning", "wingsAgreementWarning",
    "consensus", "consensusSplitWarning", "knownDimsNote", "dims", "flagObservedNotes",
    `return ${call};`,
  )(
    parseObservedNotes(JSON.stringify(SPEC)), true, frameKeyWarning, parseModelSpec(JSON.stringify(SPEC), DIMS), gambrelRoofWarning,
    porchAgreementWarning, wingsAgreementWarning, consensus, consensusSplitWarning, knownDimsNote, DIMS, flagObservedNotes,
  );
  assertEquals(flags(null).confidence, "medium", "no consensus (a single call): nothing added");
  const agreed = flags({ report: { n: 3, medoid: 0, discreteAgreement: { porch: "2/3" }, spread: {} } });
  assertEquals(agreed.confidence, "medium", "a 2-of-3 majority says nothing");
  const split = flags({ report: { n: 3, medoid: 0, discreteAgreement: { porchSteps: "1/3" }, spread: {} } });
  assertEquals(split.confidence, "low");
  assert(split.roofNote.startsWith("Check where the porch steps are before saving: we read the video three times"), split.roofNote);
  assert(split.roofNote.endsWith("The model's own reading: raised gable centre, a wing each side"), "the medoid's own note is kept after it");
});

Deno.test("the combined spec is what the ledger, the flags and the response read, and it replaces the lead's only after every exit", () => {
  const swap = SOURCE.indexOf("    if (consensus) drafted.d3 = consensus.d3;");
  assert(swap > SOURCE.indexOf("      return failed;\n    }"), "after the parse-failure exit");
  assert(swap < SOURCE.indexOf("    // ── CAPTURE ─────"), "before the capture");
  assert(swap < SOURCE.indexOf("        drafted: drafted.d3,"), "before the ledger write");
  assert(swap < SOURCE.indexOf("return json({ ok: true, d3: drafted.d3,"), "before the response");
  assertEquals(SOURCE.split("drafted.d3 = ").length - 1, 1, "and nowhere else");
});
