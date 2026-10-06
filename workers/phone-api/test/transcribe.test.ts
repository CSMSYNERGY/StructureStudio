// Call transcripts and summaries (src/cron/transcribe.ts): nova-3's answer to labelled lines, the
// queue (claim, back off, give up), the summary request, and the rule that no transcript text ever
// reaches a log. Workers AI, Twilio and the edge function are stubs; every value is made up.
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { adminClient } from "../src/db";
import { installDenoShim } from "../src/env";
import {
  MAX_ATTEMPTS, requestCallSummary, runTranscriptions, sttCostMicros, transcriptOf, utterancesOf, utterancesToKeep,
} from "../src/cron/transcribe";
import { CLIENT, FakeCtx, FakeNet, SUPABASE_URL, jsonRes, makeEnv, type Seen } from "./helpers";

const REC_ID = "00000000-0000-4000-8000-0000000ae001";
const CALL_ID = "00000000-0000-4000-8000-0000000ca777";
const REC_SID = "RE" + "0".repeat(31) + "7";
const NOW = new Date("2026-10-04T12:00:00Z");
const SECRET_WORDS = "the gate code is 4321";

const env = makeEnv({ CALL_RECORDING: "on", CALL_TRANSCRIBE: "on" });

/** nova-3's multichannel answer with words: channel 0 the customer, channel 1 the team. */
function novaWords() {
  const w = (word: string, start: number) => ({ word: word.toLowerCase(), punctuated_word: word, start, end: start + 0.4 });
  return {
    results: {
      channels: [
        { alternatives: [{ transcript: "", words: [w("Hi,", 0.5), w("is", 0.9), w("the", 1.3), w("12x24", 1.7), w("ready?", 2.1), w("Also", 9), w(SECRET_WORDS + ".", 9.4)] }] },
        { alternatives: [{ transcript: "", words: [w("Yes,", 3.5), w("Friday.", 3.9)] }] },
      ],
    },
  };
}

class FakeAi {
  calls: { model: string; input: Record<string, unknown> }[] = [];
  constructor(private answer: unknown | (() => unknown)) {}
  async run(model: string, input: Record<string, unknown>) {
    this.calls.push({ model, input });
    return typeof this.answer === "function" ? (this.answer as () => unknown)() : this.answer;
  }
}

const claimed = (over: Record<string, unknown> = {}) => ({
  id: REC_ID, call_id: CALL_ID, client_id: CLIENT, recording_sid: REC_SID, duration_s: 125, channel_map: { 0: "customer", 1: "team" }, attempts: 1, ...over,
});

function setup(opts: { rows?: unknown[]; wants?: boolean; media?: Response; due?: unknown[]; summaryStatus?: number } = {}) {
  const net = new FakeNet().install();
  net.rpc("phone_recordings_claim", () => opts.rows ?? [claimed()]);
  net.rest("GET", "client_settings", () => [{ client_id: CLIENT, phone_transcribe_calls: opts.wants !== false }]);
  net.on("GET", (u) => u.pathname.endsWith(`/Recordings/${REC_SID}.mp3`), () => opts.media?.clone() ?? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
  net.rest("PATCH", "phone_call_recordings", () => [{ id: REC_ID }]);
  net.rest("GET", "phone_call_recordings", () => opts.due ?? []);
  net.rest("POST", "phone_call_events", () => []);
  net.rest("POST", "app_errors", () => []);
  net.on("POST", (u) => u.href === `${SUPABASE_URL}/functions/v1/phone-call-summary`, () => (opts.summaryStatus ? jsonRes({ error: "x" }, opts.summaryStatus) : jsonRes({ ok: true })));
  return net;
}

const run = (e = env, ai: FakeAi | null = new FakeAi(novaWords())) => {
  const full = { ...e, AI: (ai ?? undefined) as unknown as Ai };
  installDenoShim(full);
  return runTranscriptions(full, adminClient(full), NOW);
};
const recPatches = (net: FakeNet) => net.writes("phone_call_recordings", "PATCH").map((s) => s.json);

describe("from nova-3's answer to labelled lines", () => {
  it("words split where someone paused, in time order, labelled by the row's channel map", () => {
    const us = utterancesOf(novaWords(), { 0: "customer", 1: "team" });
    expect(us.map((u) => [u.who, u.text])).toEqual([
      ["customer", "Hi, is the 12x24 ready?"],
      ["team", "Yes, Friday."],
      ["customer", `Also ${SECRET_WORDS}.`],
    ]);
    expect(transcriptOf(us)).toBe(`Customer: Hi, is the 12x24 ready?\nTeam: Yes, Friday.\nCustomer: Also ${SECRET_WORDS}.`);
  });

  it("nova-3's own utterances when it gives them; one person's run joined into one line", () => {
    const out = { results: { utterances: [
      { channel: 1, start: 4, end: 5, transcript: "Sure." },
      { channel: 0, start: 0, end: 2, transcript: "Hello." },
      { channel: 0, start: 2.5, end: 3, transcript: "Can you hear me?" },
    ] } };
    expect(transcriptOf(utterancesOf(out, null))).toBe("Customer: Hello. Can you hear me?\nTeam: Sure.");
  });

  it("a map that says the channels the other way round is followed (a correction never relabels old rows)", () => {
    expect(transcriptOf(utterancesOf(novaWords(), { 0: "team", 1: "customer" })).split("\n")[0]).toBe("Team: Hi, is the 12x24 ready?");
  });

  it("whole-channel transcripts when there are no words; silence is empty", () => {
    const out = { results: { channels: [{ alternatives: [{ transcript: "Just me." }] }, { alternatives: [{ transcript: "" }] }] } };
    expect(transcriptOf(utterancesOf(out, null))).toBe("Customer: Just me.");
    expect(transcriptOf(utterancesOf({ results: { channels: [] } }, null))).toBe("");
    expect(utterancesOf(null, null)).toEqual([]);
  });

  it("the cap cuts at a line, never mid-line, and the kept utterances fit the same cap", () => {
    const us = Array.from({ length: 30 }, (_, i) => ({ who: (i % 2 ? "team" : "customer") as "team" | "customer", start: i, end: i + 0.5, text: "x".repeat(40) }));
    const t = transcriptOf(us, 200);
    expect(t.length).toBeLessThanOrEqual(200);
    expect(t.endsWith("x")).toBe(true);
    expect(t.split("\n").every((l) => /^(Customer|Team): x{40}$/.test(l))).toBe(true);
    expect(utterancesToKeep(us, 200)).toHaveLength(5);
  });

  it("the cost: whole minutes, rounded up, both channels, at nova-3's rate", () => {
    expect(sttCostMicros(125)).toBe(3 * 5200 * 2);
    expect(sttCostMicros(0)).toBe(5200 * 2);
  });
});

describe("the queue", () => {
  it("off: claims nothing, reads nothing", async () => {
    const net = setup();
    expect(await run(makeEnv({ CALL_TRANSCRIBE: "off" }))).toMatchObject({ ran: false, reason: "switched_off" });
    expect(net.seen).toEqual([]);
  });

  it("on without the ai binding: says so once, transcribes nothing", async () => {
    const net = setup();
    expect(await run(env, null)).toMatchObject({ ran: false, reason: "not_configured" });
    expect(net.rpcCalls("phone_recordings_claim")).toEqual([]);
    expect(net.writes("app_errors").map((s) => s.json.code)).toEqual(["call_transcribe_not_configured"]);
  });

  it("transcribes: both channels from Twilio, nova-3 multichannel (not for its model improvement), labelled lines stored with the cost, the summary due", async () => {
    const net = setup();
    const ai = new FakeAi(novaWords());
    const out = await run(env, ai);
    expect(out).toMatchObject({ ran: true, claimed: 1, done: 1 });
    expect(net.rpcCalls("phone_recordings_claim")[0].json).toEqual({ p_limit: 2, p_lease_s: 300 });
    const media = net.to(/Recordings\/RE0+7\.mp3/)[0];
    expect(media.url.searchParams.get("RequestedChannels")).toBe("2");
    expect(ai.calls[0].model).toBe("@cf/deepgram/nova-3");
    expect(ai.calls[0].input).toMatchObject({ multichannel: true, utterances: true, smart_format: true, punctuate: true, mip_opt_out: true });
    expect((ai.calls[0].input.audio as { contentType: string }).contentType).toBe("audio/mpeg");
    const done = net.writes("phone_call_recordings", "PATCH")[0];
    expect(done.json).toMatchObject({
      transcript: `Customer: Hi, is the 12x24 ready?\nTeam: Yes, Friday.\nCustomer: Also ${SECRET_WORDS}.`,
      transcript_status: "done", stt_cost_micros: 31200, summary_status: "pending", summary_next_at: NOW.toISOString(), lease_until: null,
    });
    expect(done.json.transcript_json).toHaveLength(3);
    expect(done.url.searchParams.get("transcript_status")).toBe("eq.working");
    // The mark on the call says how much, never what.
    const mark = net.writes("phone_call_events")[0].json;
    expect(mark).toMatchObject({ call_id: CALL_ID, type: "call_transcribed", data: { chars: done.json.transcript.length, lines: 3 } });
  });

  it("a business that turned transcripts off since the call gets none: no audio fetched, nothing sent to Workers AI", async () => {
    const net = setup({ wants: false });
    const ai = new FakeAi(novaWords());
    expect(await run(env, ai)).toMatchObject({ off: 1 });
    expect(ai.calls).toEqual([]);
    expect(net.to(/\.mp3/)).toEqual([]);
    expect(recPatches(net)[0]).toMatchObject({ transcript_status: "off", summary_status: "off" });
  });

  it("silence is a finished transcript with nothing to summarise", async () => {
    const net = setup();
    await run(env, new FakeAi({ results: { channels: [{ alternatives: [{ transcript: "", words: [] }] }] } }));
    expect(recPatches(net)[0]).toMatchObject({ transcript: null, transcript_status: "done", summary_status: "off", summary_next_at: null });
  });

  it("a Workers AI error backs off (1 minute after the first try) and says so without any words of the call", async () => {
    const net = setup();
    const out = await run(env, new FakeAi(() => { throw new Error("AiError: 3010: upstream timeout"); }));
    expect(out).toMatchObject({ retried: 1 });
    expect(recPatches(net)[0]).toMatchObject({
      transcript_status: "pending", next_try_at: new Date(NOW.getTime() + 60_000).toISOString(), last_error: "AiError: 3010: upstream timeout",
    });
    expect(net.writes("app_errors")[0].json).toMatchObject({ code: "call_transcribe_retry", severity: "warn" });
  });

  it(`gives up after ${MAX_ATTEMPTS} attempts, and at once when Twilio no longer has the audio`, async () => {
    let net = setup({ rows: [claimed({ attempts: MAX_ATTEMPTS })] });
    await run(env, new FakeAi(() => { throw new Error("boom"); }));
    expect(recPatches(net)[0]).toMatchObject({ transcript_status: "failed", summary_status: "off" });
    expect(net.writes("app_errors")[0].json.code).toBe("call_transcribe_failed");
    net = setup({ media: jsonRes({ code: 20404 }, 404) });
    const ai = new FakeAi(novaWords());
    await run(env, ai);
    expect(ai.calls).toEqual([]);
    expect(recPatches(net)[0]).toMatchObject({ transcript_status: "failed", last_error: "Twilio no longer has the recording" });
  });

  it("NO TRANSCRIPT TEXT IN ANY LOG: not in app_errors, not on the console, even when the write after it fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const net = setup();
    net.rest("PATCH", "phone_call_recordings", () => new Response(JSON.stringify({ code: "23514", message: "new row violates check constraint", details: `Failing row contains (${SECRET_WORDS})` }), { status: 400, headers: { "content-type": "application/json" } }));
    await run(env, new FakeAi(novaWords()));
    const logged = [
      ...net.writes("app_errors").map((s) => s.body),
      ...warn.mock.calls.map((c) => c.join(" ")),
      ...log.mock.calls.map((c) => c.join(" ")),
      ...net.writes("phone_call_events").map((s) => s.body),
    ].join("\n");
    expect(net.writes("app_errors").length).toBeGreaterThan(0);
    expect(logged).not.toContain(SECRET_WORDS);
    expect(logged).not.toContain("4321");
    expect(logged).not.toContain("12x24");
  });
});

describe("summaries", () => {
  it("each due summary is moved 2 minutes on (only if no other tick did), then asked for with the service key", async () => {
    const net = setup({ rows: [], due: [{ id: REC_ID, client_id: CLIENT, summary_next_at: "2026-10-04T11:59:00.000Z", completed_at: "2026-10-04T11:50:00.000Z" }] });
    const out = await run(env);
    expect(out.summaries).toBe(1);
    const due = net.reads("phone_call_recordings")[0].url.searchParams;
    expect(due.get("transcript_status")).toBe("eq.done");
    expect(due.get("summary_status")).toBe("in.(pending,working)");
    expect(due.get("summary_next_at")).toBe(`lte.${NOW.toISOString()}`);
    const bump = net.writes("phone_call_recordings", "PATCH")[0];
    expect(bump.json).toEqual({ summary_next_at: "2026-10-04T12:02:00.000Z" });
    expect(bump.url.searchParams.get("summary_next_at")).toBe("eq.2026-10-04T11:59:00.000Z");
    const ask = net.to(/functions\/v1\/phone-call-summary/)[0] as Seen;
    expect(ask.headers.get("authorization")).toBe("Bearer test-service-key");
    expect(ask.headers.get("apikey")).toBe("test-service-key");
    expect(ask.json).toEqual({ recording_id: REC_ID });
  });

  it("another tick moved it first: not asked twice", async () => {
    const net = setup({ rows: [], due: [{ id: REC_ID, client_id: CLIENT, summary_next_at: "2026-10-04T11:59:00.000Z", completed_at: "2026-10-04T11:50:00.000Z" }] });
    net.rest("PATCH", "phone_call_recordings", () => []);
    expect((await run(env)).summaries).toBe(0);
    expect(net.to(/phone-call-summary/)).toEqual([]);
  });

  it("a summary still not written a day after the recording is given up", async () => {
    const net = setup({ rows: [], due: [{ id: REC_ID, client_id: CLIENT, summary_next_at: "2026-10-04T11:59:00.000Z", completed_at: "2026-10-03T10:00:00.000Z" }] });
    await run(env);
    expect(recPatches(net)[0]).toMatchObject({ summary_status: "failed" });
    expect(net.to(/phone-call-summary/)).toEqual([]);
  });

  it("a refused request logs the HTTP status only, and never throws", async () => {
    const net = setup({ summaryStatus: 401 });
    expect(await requestCallSummary(env, REC_ID)).toBe(false);
    expect(net.writes("app_errors")[0].json).toMatchObject({ code: "call_summary_request_failed", message: "phone-call-summary answered HTTP 401." });
  });
});

describe("the minute tick", () => {
  const tick = (iso: string) => ({ cron: "* * * * *", scheduledTime: Date.parse(iso), noRetry() {} }) as ScheduledController;
  it("transcribes on every tick while CALL_TRANSCRIBE is on, and never while it is off", async () => {
    const net = new FakeNet().install();
    net.on("GET", /\/health\?warm=1/, () => jsonRes({ ok: true }));
    net.rpc("phone_recordings_claim", () => []);
    net.rest("GET", "phone_call_recordings", () => []);
    const go = async (e: ReturnType<typeof makeEnv>) => {
      const c = new FakeCtx();
      await worker.scheduled(tick("2026-10-04T10:07:00Z"), { ...e, AI: new FakeAi({}) as unknown as Ai }, c as unknown as ExecutionContext);
      await c.settle();
    };
    await go(makeEnv());
    expect(net.rpcCalls("phone_recordings_claim")).toHaveLength(0);
    await go(env);
    await go(env);
    expect(net.rpcCalls("phone_recordings_claim")).toHaveLength(2);
  });
});
