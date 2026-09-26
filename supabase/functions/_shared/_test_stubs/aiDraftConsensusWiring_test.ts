// Consensus drafting's wiring in calibrate_style_ai (2026-09-25), RUN, not regex-read.
//
// WHY THIS EXISTS. Live v2 runs of one video kept the shape and let the numbers wander (a raised
// centre's eave 15, 14 and 12.5 ft; the pitch 0.37 to 0.7; 3 posts or 4), so the v2 draft now sends
// its request five times in parallel (three until 2026-09-26) and combines the reads
// (consensusDrafts, styleD3.test.ts). The pure half is tested there. What only the handler can get
// wrong, and what this pins:
//
//   1. v2 sends FIVE identical request bodies, in parallel, streamed or not; every legacy request and
//      the lean retry send ONE, byte-for-byte the request the single call always sent, on the
//      deadline signal itself.
//   2. Three reads of five are the quorum: once they are in, the other two get the grace and are
//      cut off, and the answer is the consensus of whatever drafted -- one, two, three, four or five.
//   3. When no read drafts, the builder gets exactly the error a single call would have given for
//      the FIRST call sent (not the first to come back): the same status, code, `retryable` and
//      hold release, whatever the other four did.
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
  videoShapePrompt, wingsAgreementWarning, DRAFT_CONSENSUS_GRACE_MS, draftReadSample,
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
  "parseModelSpec", "streamed", "draftEffort",
  // 2026-09-26: the single read's record names where its pitches came from (draftReadSample).
  "draftReadSample",
];
const RUN = new AsyncFunction(
  ...PARAMS,
  `${CALL_BLOCK}\nreturn { answered: null, drafted, lead, consensus, callsUsage, text, aiSignal, calls };`,
);

const DIMS = { widthFt: 30, lengthFt: 20, wallHeightFt: 8 };
const FRAMES = Array.from({ length: 12 }, (_, i) => `https://example.test/walk/f${i + 1}.jpg`);
// `streamed` (2026-09-25) is the branch's parameter: true only for the new shell's v2 press, which
// answers behind a heartbeat and thinks at effort "high" (aiDraftStreamWiring_test). Every case here
// that does not name it is a request that is not streamed, so it pins the plain request unchanged.
type Scenario = { v2: boolean; lean?: boolean; streamed?: boolean; source?: "video" | "combined" | "photos"; videoCount?: number; photoUrls?: string[]; graceMs?: number; abortMs?: number };

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
      filed, parseModelSpec, s.streamed ?? false,
      // The branch's own draftEffort, declared above the lifted block (aiDraftRetryWiring_test pins
      // its expression): "low" when lean, "high" when streamed, else "medium".
      s.lean ? "low" : s.streamed ? "high" : "medium",
      draftReadSample,
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
function expectedBody(r: Awaited<ReturnType<typeof run>>, v2: boolean, lean: boolean, videoCount: number, streamed = false) {
  return JSON.stringify({
    model: v2 ? "claude-opus-5-5" : "claude-sonnet-5",
    // 12000 on every read (20000 on a streamed draft from 2026-09-25 to 2026-09-26, while Opus 5 thought
    // past 12000 at effort high; Opus 5.5's reads use 2,000-7,000).
    max_tokens: 12000,
    thinking: { type: "adaptive" },
    output_config: { effort: lean ? "low" : streamed ? "high" : "medium" },
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

const FIVE = (p: Plan): Plan[] => [p, p, p, p, p];

Deno.test("a v2 press sends FIVE identical requests, all before any answer comes back", async () => {
  const r = await run({ v2: true }, FIVE(GOOD()));
  assertEquals(r.sent.length, 5);
  assertEquals(r.sentWhenFirstAnswered, 5, "in parallel: all five were out before the first reply landed");
  const want = expectedBody(r, true, false, 0);
  for (const { url, init } of r.sent) {
    assertEquals(url, "https://api.anthropic.com/v1/messages");
    assertEquals(init.headers, HEADERS);
    assertEquals(init.body, want, "the same bytes each time: Opus, medium effort, the v2 prompt");
    assert(init.signal !== r.out.aiSignal, "each on its own signal, which the one deadline aborts");
  }
  assertEquals(new Set(r.sent.map((x) => x.init.signal)).size, 5);
  assertEquals(r.out.consensus.report.n, 5);
  assert(Object.values(r.out.consensus.report.discreteAgreement).every((a) => a === "5/5"), "five alike, 5/5 on everything");
});

Deno.test("a STREAMED v2 press sends the same five requests at effort high with 12000 tokens, and nothing else changes", async () => {
  const plain = await run({ v2: true }, FIVE(GOOD()));
  const r = await run({ v2: true, streamed: true }, FIVE(GOOD()));
  assertEquals(r.sent.length, 5);
  assertEquals(r.sentWhenFirstAnswered, 5, "still in parallel");
  const want = expectedBody(r, true, false, 0, true);
  for (const { init } of r.sent) {
    assertEquals(init.headers, HEADERS);
    assertEquals(init.body, want, "Opus, the v2 prompt, effort high, 12000 tokens");
    assertEquals(JSON.parse(init.body).output_config, { effort: "high" });
    assertEquals(JSON.parse(init.body).max_tokens, 12000);
  }
  // The only difference from the plain v2 request is the effort.
  assertEquals(JSON.parse(plain.sent[0].init.body).max_tokens, 12000, "the plain v2 request keeps 12000");
  assertEquals(JSON.parse(r.sent[0].init.body), { ...JSON.parse(plain.sent[0].init.body), output_config: { effort: "high" } });
  assertEquals(r.out.drafted.d3, plain.out.drafted.d3, "the same reads, the same draft");
});

// ─── 2. Three of five is the quorum; any number that drafted is combined ───────────────────────
Deno.test("five reads, two failing (one overloaded, one dropped): the consensus of the three that drafted, and every call's usage", async () => {
  const r = await run({ v2: true }, [
    GOOD({ centerEaveFt: 15, pitch: 0.4 }, { out: 7000 }), OVERLOADED, GOOD({ centerEaveFt: 13, pitch: 0.5 }, { out: 9000 }),
    { throws: "connection reset" }, GOOD({ centerEaveFt: 14, pitch: 0.45 }, { out: 8000 }),
  ]);
  assertEquals(r.answered, null, "no error reply");
  assertEquals(r.released, [], "the hold is not released: this press is charged");
  assertEquals(r.logged, []);
  assertEquals(r.out.drafted.d3.roof.centerEaveFt, 14, "the median of the three reads");
  assertEquals(r.out.drafted.d3.roof.pitch, 0.45);
  assertEquals(r.out.consensus.report.n, 3);
  assert(r.out.lead === r.out.calls[0], "the lead is the medoid's call, whose notes and frame map the response carries");
  assertEquals(r.out.text, JSON.stringify(spec({ centerEaveFt: 15, pitch: 0.4 })));
  // One usage write, the summed record: the overloaded and the dropped call reported no usage.
  assertEquals(r.usage.length, 1);
  const tokens = r.usage[0] as Record<string, unknown>;
  assertEquals([tokens.model, tokens.input, tokens.output, tokens.stopReason], ["claude-opus-5-5", 63000, 24000, "end_turn"]);
  assertEquals((tokens.calls as Record<string, unknown>[]).map((c) => [c.ok, c.output, c.stopReason, c.aborted]), [
    [true, 7000, "end_turn", null], [false, null, null, null], [true, 9000, "end_turn", null], [false, null, null, null], [true, 8000, "end_turn", null],
  ]);
  assertEquals((tokens.samples as Record<string, unknown>[]).map((x) => x.centerEaveFt), [15, 13, 14]);
  assertEquals((tokens.agreement as Record<string, unknown>).n, 3);
  assertEquals(r.out.callsUsage.usage, { input_tokens: 63000, output_tokens: 24000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, calls: 5 });
});

Deno.test("two reads of five, three failing: no quorum, nothing cut, and the answer is the consensus of the two", async () => {
  const r = await run({ v2: true, graceMs: 5 }, [TRUNCATED, GOOD({ centerEaveFt: 15 }), UNPARSEABLE, OVERLOADED, GOOD({ centerEaveFt: 12.5 })]);
  assertEquals(r.answered, null);
  assertEquals(r.out.consensus.report.n, 2);
  assertEquals(r.out.drafted.d3.roof.centerEaveFt, 13.75, "an even count: the midpoint of its middle two");
  const calls = (r.usage[0] as Record<string, unknown>).calls as Record<string, unknown>[];
  assertEquals(calls.map((c) => [c.ok, c.aborted]), [[false, null], [true, null], [false, null], [false, null], [true, null]]);
});

Deno.test("three reads in, the other two are cut off after the grace, and the answer does not wait for the deadline", async () => {
  const r = await run({ v2: true, graceMs: 40, abortMs: 5_000 }, [GOOD({ centerEaveFt: 15 }), { hang: true }, GOOD({ centerEaveFt: 12.5 }), { hang: true }, GOOD({ centerEaveFt: 14 })]);
  assertEquals(r.answered, null);
  assertEquals(r.out.consensus.report.n, 3);
  assertEquals(r.out.drafted.d3.roof.centerEaveFt, 14);
  const calls = (r.usage[0] as Record<string, unknown>).calls as Record<string, unknown>[];
  assertEquals(calls.map((c) => [c.ok, c.aborted]), [[true, null], [false, "quorum"], [true, null], [false, "quorum"], [true, null]]);
  assert(r.ms < 1_000, `answered ${r.ms} ms after the press, well inside the 5 s deadline`);
});

Deno.test("a fourth read that lands inside the grace joins the consensus; the fifth, still out, is cut", async () => {
  const r = await run({ v2: true, graceMs: 200, abortMs: 5_000 }, [
    GOOD({ centerEaveFt: 15 }), GOOD({ centerEaveFt: 13 }), GOOD({ centerEaveFt: 14 }),
    { ...GOOD({ centerEaveFt: 12 }), delayMs: 30 }, { hang: true },
  ]);
  assertEquals(r.answered, null);
  assertEquals(r.out.consensus.report.n, 4);
  assertEquals(r.out.drafted.d3.roof.centerEaveFt, 13.5, "the median of four: the midpoint of 13 and 14");
  const calls = (r.usage[0] as Record<string, unknown>).calls as Record<string, unknown>[];
  assertEquals(calls.map((c) => [c.ok, c.aborted]), [[true, null], [true, null], [true, null], [true, null], [false, "quorum"]]);
  assert(r.ms >= 200 && r.ms < 2_000, `the grace ran out before the answer: ${r.ms} ms`);
});

Deno.test("one read of five is enough to answer: the consensus of one read is that read", async () => {
  const r = await run({ v2: true }, [TRUNCATED, GOOD({ centerEaveFt: 15 }), UNPARSEABLE, REFUSED, OVERLOADED]);
  assertEquals(r.answered, null);
  assertEquals(r.out.drafted.d3, specOf(JSON.stringify(spec({ centerEaveFt: 15 })), DIMS));
  assert(r.out.lead === r.out.calls[1]);
  assertEquals(consensusSplitWarning(r.out.consensus.report), null, "one read cannot split");
  const tokens = r.usage[0] as Record<string, unknown>;
  assertEquals(tokens.output, 12000 + 7000 + 7000 + 7000, "the failures that answered cost money too; the 529 reported nothing");
});

// ─── 3. None of five: today's error, for the FIRST call sent ───────────────────────────────────
// Each case runs the SAME first-call outcome twice: alone as a legacy single call (today's handling,
// unchanged) and as the first of five failing v2 calls. The builder must get the same answer.
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
    // The other four fail differently, and more slowly: the first call SENT decides, not the first back.
    const others: Plan[] = what === "the deadline"
      ? [UNPARSEABLE, REFUSED, OVERLOADED, TRUNCATED]
      : [{ hang: true }, { ...TRUNCATED, delayMs: 20 }, { ...REFUSED, delayMs: 10 }, { throws: "connection reset" }];
    const five = await run({ v2: true, abortMs: 60 }, [first, ...others]);
    for (const [label, r] of [["single", single], ["v2 five", five]] as const) {
      assert(r.answered !== null, `${label}: an error reply`);
      assertEquals(r.answered!.status, want.status, `${label}: status`);
      assertEquals(r.answered!.body.retryable === true, want.retryable, `${label}: retryable`);
      assertEquals(r.released, [want.release], `${label}: the hold is released once, for this reason`);
      assertEquals(r.logged.map((l) => l.code), want.code ? [want.code] : [], `${label}: the coded row`);
      assertEquals(r.filed.has(r.answered), want.code !== null, `${label}: filed at the return site exactly when coded`);
    }
    assertEquals(five.answered!.body, single.answered!.body, "the builder reads the same sentence");
    assertEquals(five.sent.length, 5);
    // Usage: the single call records today's shape; five calls record all five.
    const one = single.usage[0] as Record<string, unknown> | null;
    if (first.throws || first.hang) assertEquals(one, null, "no reply, no usage, as before");
    else if (first.status) assertEquals(one, null);
    else assert(one !== null && !("calls" in one), "the single call's own record");
    const all = five.usage[0] as Record<string, unknown>;
    assertEquals((all.calls as unknown[]).length, 5, "every call is on the record, even with no draft");
    assertEquals(all.agreement, null);
  });
}

Deno.test("a first call that failed on its own is not relabelled a timeout by the other four running out the clock", async () => {
  // The single call's catch read aiSignal.aborted when IT threw. With five calls the deadline has
  // usually fired by the time all five settle, so it is read per call, the moment each one threw.
  const r = await run({ v2: true, abortMs: 40 }, [{ throws: "connection reset" }, { hang: true }, { hang: true }, { hang: true }, { hang: true }]);
  assertEquals(r.answered!.status, 502);
  assertEquals(r.answered!.body.error, "Could not reach the AI service: connection reset");
  assertEquals(r.released, ["fetch failed"]);
  assertEquals(((r.usage[0] as Record<string, unknown>).calls as Record<string, unknown>[]).map((c) => c.aborted), [null, "deadline", "deadline", "deadline", "deadline"]);
});

// ─── 4. The capture and the flags ──────────────────────────────────────────────────────────────
Deno.test("the capture's cost basis is the summed usage of every call", () => {
  const stmt = lift("      const u = callsUsage ? callsUsage.usage : (data?.usage ?? null);", "      const { data: bal", "the capture's cost basis");
  const cost = (callsUsage: unknown, data: unknown, v2Prompt: boolean) =>
    new Function("callsUsage", "data", "v2Prompt", "aiDraftCostCents", `${stmt}\nreturn [u, costCents];`)(callsUsage, data, v2Prompt, aiDraftCostCents);
  const summed = { input_tokens: 105000, output_tokens: 35000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, calls: 5 };
  const lead = { usage: { input_tokens: 21000, output_tokens: 7000 } };
  assertEquals(cost({ usage: summed }, lead, true), [summed, aiDraftCostCents(true, 105000, 35000)], "five calls: five calls' cost");
  assertEquals(cost(null, lead, false), [lead.usage, aiDraftCostCents(false, 21000, 7000)], "one call: exactly as before");
  // A typical five-read press on Opus 5.5, $4 / $20 per million tokens (2026-09-26): 5 x 21,000 =
  // 105,000 x 4 / 10,000 = 42 cents in, plus 5 x 7,000 = 35,000 x 20 / 10,000 = 70 cents out, is 112.
  // (Three reads were 25.2 + 42 = 67.2.)
  assertEquals(aiDraftCostCents(true, 105000, 35000), 112, "5 x 21k in and 5 x 7k out on Opus 5.5 is 112 cents");
  assertEquals(aiDraftCostCents(true, 63000, 21000), 67.2, "3 x 21k in and 3 x 7k out was 67.2 cents");
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
  // Five reads: three of five is a majority and says nothing; two of five is not.
  assertEquals(flags({ report: { n: 5, medoid: 0, discreteAgreement: { porch: "3/5" }, spread: {} } }).confidence, "medium", "a 3-of-5 majority says nothing");
  const plural = flags({ report: { n: 5, medoid: 0, discreteAgreement: { porch: "2/5" }, spread: {} } });
  assertEquals(plural.confidence, "low");
  assert(plural.roofNote.startsWith("Check the porch before saving: we read the video five times"), plural.roofNote);
});

Deno.test("five real reads: a 3-2 split is the three's and silent; a 2-2 split of four (one read lost) is the best-ranked read's and named", async () => {
  const steps = (where: string) => GOOD({ porchSteps: where });
  const three = await run({ v2: true }, [steps("center"), steps("right"), steps("center"), steps("right"), steps("center")]);
  assertEquals(three.out.drafted.d3.roof.porchSteps, "center");
  assertEquals(three.out.consensus.report.discreteAgreement.porchSteps, "3/5");
  assertEquals(consensusSplitWarning(three.out.consensus.report), null);
  // One read overloaded: four left, two and two. Every read disagrees with two others, so send order
  // ranks them, and the first read's answer is drawn.
  const tie = await run({ v2: true }, [steps("right"), steps("center"), OVERLOADED, steps("right"), steps("center")]);
  assertEquals(tie.out.consensus.report.n, 4);
  assertEquals(tie.out.drafted.d3.roof.porchSteps, "right");
  assertEquals(tie.out.consensus.report.discreteAgreement.porchSteps, "2/4");
  assert(tie.out.lead === tie.out.calls[0], "the medoid's call leads");
  const w = consensusSplitWarning(tie.out.consensus.report)!;
  assert(w.startsWith("Check where the porch steps are before saving: we read the video four times"), w);
});

Deno.test("the combined spec is what the ledger, the flags and the response read, and it replaces the lead's only after every exit", () => {
  const swap = SOURCE.indexOf("    if (consensus) drafted.d3 = consensus.d3;");
  assert(swap > SOURCE.indexOf("      return failed;\n    }"), "after the parse-failure exit");
  assert(swap < SOURCE.indexOf("    // ── CAPTURE ─────"), "before the capture");
  assert(swap < SOURCE.indexOf("        drafted: drafted.d3,"), "before the ledger write");
  assert(swap < SOURCE.indexOf("return json({ ok: true, d3: drafted.d3,"), "before the response");
  assertEquals(SOURCE.split("drafted.d3 = ").length - 1, 1, "and nowhere else");
});
