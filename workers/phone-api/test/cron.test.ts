import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { recordingSweep } from "../src/cron/sweep";
import { retention } from "../src/cron/retention";
import { chargeMonthlyLineFees, lineFeeIdem, utcMonth } from "../src/cron/lineFee";
import { previousUtcDay } from "../src/cron/usageCharge";
import { adminClient } from "../src/db";
import { installDenoShim } from "../src/env";
import { BUSINESS_NUMBER, CLIENT, CUSTOMER, FakeCtx, FakeNet, NUMBER_ID, filter, jsonRes, makeEnv, routeInfo } from "./helpers";

const RE = (n: number) => "RE" + String(n).padStart(32, "0");
const CA = (n: number) => "CA" + String(n).padStart(32, "0");
const KNOWN_CALL = "00000000-0000-4000-8000-0000000ca555";

describe("recording sweep (*/15)", () => {
  it("files recordings the webhooks missed, creating the call row for ones taken by the fallback", async () => {
    const net = new FakeNet().install();
    const env = makeEnv();
    installDenoShim(env);
    const now = new Date("2026-09-29T12:00:00Z");
    net.on("GET", /\/Recordings\.json\?/, () => jsonRes({
      recordings: [
        { sid: RE(1), call_sid: CA(1), source: "RecordVerb", status: "completed", duration: "12", date_created: "Tue, 29 Sep 2026 11:50:00 +0000" }, // already filed
        { sid: RE(2), call_sid: CA(2), source: "RecordVerb", status: "completed", duration: "20", date_created: "Tue, 29 Sep 2026 11:40:00 +0000" }, // missed, row exists
        { sid: RE(3), call_sid: CA(3), source: "RecordVerb", status: "completed", duration: "8", date_created: "Tue, 29 Sep 2026 11:30:00 +0000" }, // fallback: no row
        { sid: RE(4), call_sid: CA(4), source: "RecordVerb", status: "completed", duration: "8", date_created: "Tue, 29 Sep 2026 11:20:00 +0000" }, // not our number
        { sid: RE(5), call_sid: CA(5), source: "RecordVerb", status: "completed", duration: "0", date_created: "Tue, 29 Sep 2026 11:10:00 +0000" }, // a hang-up
      ],
      next_page_uri: null,
    }));
    net.rest("GET", "phone_voicemails", () => [{ recording_sid: RE(1) }]);
    let inserted: Record<string, unknown> | null = null;
    net.rest("GET", "phone_calls", (s) => {
      const id = filter(s, "id");
      if (id === KNOWN_CALL) return [{ id: KNOWN_CALL, client_id: CLIENT, rang_user_ids: [], transfer_state: null }];
      if (inserted && id === inserted.id) return [{ ...inserted, rang_user_ids: [], transfer_state: null }];
      if (s.url.searchParams.get("twilio_call_sid")?.startsWith("in.")) return [{ id: KNOWN_CALL, twilio_call_sid: CA(2) }];
      return [];
    });
    net.on("GET", /\/Calls\/CA0+3\.json$/, () => jsonRes({ sid: CA(3), from: CUSTOMER, to: BUSINESS_NUMBER, direction: "inbound", status: "completed", start_time: "Tue, 29 Sep 2026 11:29:00 +0000" }));
    net.on("GET", /\/Calls\/CA0+4\.json$/, () => jsonRes({ sid: CA(4), from: CUSTOMER, to: "+15555550111", direction: "inbound", status: "completed", start_time: null }));
    net.rpc("phone_route_for_number", (s) => (s.json.p_e164 === BUSINESS_NUMBER ? routeInfo() : null));
    net.rest("GET", "crm_contacts", () => []);
    net.rest("POST", "phone_calls", (s) => { inserted = s.json; return []; });
    net.rest("POST", "phone_voicemails", () => []);
    net.rest("PATCH", "phone_calls", () => []);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);

    const out = await recordingSweep(env, now);
    expect(out).toEqual({ checked: 4, filed: 2 });
    expect(net.to(/Recordings\.json/)[0].url.searchParams.get("DateCreated>")).toBe("2026-09-28");
    const vms = net.writes("phone_voicemails").map((s) => s.json);
    expect(vms).toEqual([
      { call_id: KNOWN_CALL, client_id: CLIENT, recording_sid: RE(2), duration_s: 20 },
      { call_id: inserted!.id, client_id: CLIENT, recording_sid: RE(3), duration_s: 8 },
    ]);
    expect(inserted).toMatchObject({ client_id: CLIENT, number_id: NUMBER_ID, direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER, twilio_call_sid: CA(3) });
  });

  it("a voicemail row a transcript created (recording, no duration) is still filed: the call becomes 'voicemail'", async () => {
    // fileTranscript's fallback writes {call_id, recording_sid, transcript} when the transcript
    // beats the voicemail. Counting that row as filed hid the call from its only repair job.
    const net = new FakeNet().install();
    const env = makeEnv();
    installDenoShim(env);
    net.on("GET", /\/Recordings\.json\?/, () => jsonRes({
      recordings: [
        { sid: RE(1), call_sid: CA(1), source: "RecordVerb", status: "completed", duration: "14", date_created: "Tue, 29 Sep 2026 11:50:00 +0000" },
        { sid: RE(2), call_sid: CA(2), source: "RecordVerb", status: "completed", duration: "9", date_created: "Tue, 29 Sep 2026 11:40:00 +0000" },
      ],
      next_page_uri: null,
    }));
    net.rest("GET", "phone_voicemails", () => [{ recording_sid: RE(1), duration_s: null }, { recording_sid: RE(2), duration_s: 9 }]);
    net.rest("GET", "phone_calls", (s) => {
      if (filter(s, "id") === KNOWN_CALL) return [{ id: KNOWN_CALL, client_id: CLIENT, rang_user_ids: [], transfer_state: null }];
      return [{ id: KNOWN_CALL, twilio_call_sid: CA(1) }];
    });
    net.rest("POST", "phone_voicemails", () => []);
    net.rest("PATCH", "phone_calls", () => []);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);

    expect(await recordingSweep(env, new Date("2026-09-29T12:00:00Z"))).toEqual({ checked: 2, filed: 1 });
    expect(net.reads("phone_voicemails")[0].url.searchParams.get("select")).toContain("duration_s");
    const vm = net.writes("phone_voicemails").map((s) => s.json);
    expect(vm).toEqual([{ call_id: KNOWN_CALL, client_id: CLIENT, recording_sid: RE(1), duration_s: 14 }]); // no transcript key: the upsert keeps it
    expect(net.writes("phone_calls", "PATCH").map((s) => s.json)).toContainEqual({ status: "voicemail" });
  });

  it("does nothing without Twilio credentials", async () => {
    const net = new FakeNet().install();
    expect(await recordingSweep(makeEnv({ TWILIO_API_KEY: undefined, TWILIO_AUTH_TOKEN: undefined }))).toEqual({ checked: 0, filed: 0 });
    expect(net.seen).toEqual([]);
  });

  it("never files a call recording (or any recording that isn't <Record>) as a voicemail, even on a known call", async () => {
    const net = new FakeNet().install();
    const env = makeEnv();
    installDenoShim(env);
    net.on("GET", /\/Recordings\.json\?/, () => jsonRes({
      recordings: [
        // A recorded conversation on a call we know: the case that would have flipped it to 'voicemail'.
        { sid: RE(7), call_sid: CA(2), source: "StartCallRecordingAPI", status: "completed", duration: "95", date_created: "Tue, 29 Sep 2026 11:45:00 +0000" },
        { sid: RE(8), call_sid: CA(2), source: "DialVerb", status: "completed", duration: "40", date_created: "Tue, 29 Sep 2026 11:44:00 +0000" },
        { sid: RE(9), call_sid: CA(2), status: "completed", duration: "40", date_created: "Tue, 29 Sep 2026 11:43:00 +0000" }, // no source: not proven a voicemail
      ],
      next_page_uri: null,
    }));
    net.rest("GET", "phone_calls", () => [{ id: KNOWN_CALL, twilio_call_sid: CA(2) }]);
    net.rest("POST", "app_errors", () => []);

    expect(await recordingSweep(env, new Date("2026-09-29T12:00:00Z"))).toEqual({ checked: 0, filed: 0 });
    expect(net.writes("phone_voicemails")).toEqual([]);
    expect(net.writes("phone_calls")).toEqual([]);
    expect(net.reads("phone_voicemails")).toEqual([]);
  });

  it("never files a voicemail GREETING (migration 264): a <Record> on the ring the Worker placed (outbound-api) is not a voicemail", async () => {
    const net = new FakeNet().install();
    const env = makeEnv();
    installDenoShim(env);
    net.on("GET", /\/Recordings\.json\?/, () => jsonRes({
      recordings: [
        { sid: RE(11), call_sid: CA(11), source: "RecordVerb", status: "completed", duration: "9", date_created: "Tue, 29 Sep 2026 11:45:00 +0000" },
      ],
      next_page_uri: null,
    }));
    net.rest("GET", "phone_voicemails", () => []);
    net.rest("GET", "phone_calls", () => []); // the ring has no phone_calls row
    // From the business number To the person's own app, placed through the REST API.
    net.on("GET", /\/Calls\/CA0+11\.json$/, () => jsonRes({
      sid: CA(11), from: BUSINESS_NUMBER, to: "client:u_000000000000400080000000000000a1_g1", direction: "outbound-api", status: "completed", start_time: null,
    }));
    net.rpc("phone_route_for_number", () => routeInfo());
    net.rest("POST", "app_errors", () => []);

    expect(await recordingSweep(env, new Date("2026-09-29T12:00:00Z"))).toEqual({ checked: 1, filed: 0 });
    expect(net.writes("phone_voicemails")).toEqual([]);
    expect(net.writes("phone_calls")).toEqual([]);
    expect(net.rpcCalls("phone_route_for_number")).toEqual([]);
  });

  it("stored greetings never take the per-run slots: a missed voicemail behind 60 newer greetings is still filed", async () => {
    const net = new FakeNet().install();
    const env = makeEnv();
    installDenoShim(env);
    // 60 people's stored greetings (more than MAX_PER_RUN), newest first, then one missed voicemail.
    const greets = Array.from({ length: 60 }, (_, i) => (
      { sid: RE(2000 + i), call_sid: CA(2000 + i), source: "RecordVerb", status: "completed", duration: "9", date_created: "Tue, 29 Sep 2026 11:59:00 +0000" }
    ));
    net.on("GET", /\/Recordings\.json\?/, () => jsonRes({
      recordings: [...greets, { sid: RE(2), call_sid: CA(2), source: "RecordVerb", status: "completed", duration: "20", date_created: "Tue, 29 Sep 2026 11:40:00 +0000" }],
      next_page_uri: null,
    }));
    net.rest("GET", "phone_voicemails", () => []);
    net.rest("GET", "phone_user_settings", () => greets.map((g) => ({ greeting_recording_sid: g.sid })));
    net.rest("GET", "phone_calls", (s) => (filter(s, "id") === KNOWN_CALL
      ? [{ id: KNOWN_CALL, client_id: CLIENT, rang_user_ids: [], transfer_state: null }]
      : [{ id: KNOWN_CALL, twilio_call_sid: CA(2) }]));
    net.rest("POST", "phone_voicemails", () => []);
    net.rest("PATCH", "phone_calls", () => []);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);

    expect(await recordingSweep(env, new Date("2026-09-29T12:00:00Z"))).toEqual({ checked: 61, filed: 1 });
    expect(net.writes("phone_voicemails").map((s) => s.json)).toEqual([{ call_id: KNOWN_CALL, client_id: CLIENT, recording_sid: RE(2), duration_s: 20 }]);
    expect(net.reads("phone_user_settings")[0].url.searchParams.get("select")).toBe("greeting_recording_sid");
    expect(net.to(/\/Calls\/CA[0-9]+\.json$/)).toEqual([]); // no Twilio call lookups spent on greetings
  });

  it("reads the list to the end, past the old 200 cap: a voicemail behind 250 call recordings is still filed", async () => {
    const net = new FakeNet().install();
    const env = makeEnv();
    installDenoShim(env);
    const calls = (from: number, n: number) => Array.from({ length: n }, (_, i) => (
      { sid: RE(1000 + from + i), call_sid: CA(500 + from + i), source: "StartCallRecordingAPI", status: "completed", duration: "60", date_created: "Tue, 29 Sep 2026 11:59:00 +0000" }
    ));
    const pages: Record<string, unknown>[] = [
      { recordings: calls(0, 100), next_page_uri: "/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings.json?PageSize=100&Page=1&PageToken=PA1" },
      { recordings: calls(100, 100), next_page_uri: "/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings.json?PageSize=100&Page=2&PageToken=PA2" },
      {
        recordings: [...calls(200, 50), { sid: RE(2), call_sid: CA(2), source: "RecordVerb", status: "completed", duration: "20", date_created: "Tue, 29 Sep 2026 11:40:00 +0000" }],
        next_page_uri: null,
      },
    ];
    let page = 0;
    net.on("GET", /\/Recordings\.json\?/, () => jsonRes(pages[page++]));
    net.rest("GET", "phone_voicemails", () => []);
    net.rest("GET", "phone_calls", (s) => (filter(s, "id") === KNOWN_CALL
      ? [{ id: KNOWN_CALL, client_id: CLIENT, rang_user_ids: [], transfer_state: null }]
      : [{ id: KNOWN_CALL, twilio_call_sid: CA(2) }]));
    net.rest("POST", "phone_voicemails", () => []);
    net.rest("PATCH", "phone_calls", () => []);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);

    expect(await recordingSweep(env, new Date("2026-09-29T12:00:00Z"))).toEqual({ checked: 1, filed: 1 });
    expect(net.to(/Recordings\.json/)).toHaveLength(3);
    expect(net.writes("phone_voicemails").map((s) => s.json)).toEqual([{ call_id: KNOWN_CALL, client_id: CLIENT, recording_sid: RE(2), duration_s: 20 }]);
  });
});

describe("retention (daily)", () => {
  it("deletes recordings older than the retention period at Twilio, then stamps deleted_at", async () => {
    const net = new FakeNet().install();
    const env = makeEnv({ VOICEMAIL_RETENTION_DAYS: "365" });
    installDenoShim(env);
    net.rest("GET", "phone_voicemails", () => [
      { id: "v1", recording_sid: RE(1), client_id: CLIENT },
      { id: "v2", recording_sid: RE(2), client_id: CLIENT },
      { id: "v3", recording_sid: RE(3), client_id: CLIENT },
    ]);
    net.on("DELETE", /Recordings\/RE0+1\.json$/, () => new Response(null, { status: 204 }));
    net.on("DELETE", /Recordings\/RE0+2\.json$/, () => jsonRes({ code: 20404 }, 404)); // already gone
    net.on("DELETE", /Recordings\/RE0+3\.json$/, () => jsonRes({ code: 20500 }, 500));
    net.rest("PATCH", "phone_voicemails", () => []);
    net.rest("POST", "app_errors", () => []);
    const now = new Date("2026-09-29T09:00:00Z");
    expect(await retention(env, now)).toEqual({ deleted: 2, failed: 1 });
    const q = net.reads("phone_voicemails")[0];
    expect(q.url.searchParams.get("created_at")).toBe(`lt.${new Date(now.getTime() - 365 * 86_400_000).toISOString()}`);
    expect(q.url.searchParams.get("deleted_at")).toBe("is.null");
    expect(net.writes("phone_voicemails", "PATCH").map((s) => filter(s, "id"))).toEqual(["v1", "v2"]);
    expect(net.writes("app_errors")[0].json.code).toBe("voicemail_retention_failed");
  });
});

describe("the daily combined minute debit is gone (calls are charged one by one now)", () => {
  it("no source file defines or schedules debitDailyUsage any more", () => {
    const src = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");
    expect(existsSync(resolve(process.cwd(), "src/cron/usageDebit.ts"))).toBe(false);
    expect(src("src/index.ts")).not.toMatch(/debitDailyUsage|usage_debit/);
    expect(src("src/cron/lineFee.ts")).not.toMatch(/debitDailyUsage|phone_minutes/);
  });

  it("previousUtcDay", () => {
    expect(previousUtcDay(new Date("2026-03-01T00:30:00Z"))).toBe("2026-02-28");
  });
});

describe("scheduled()", () => {
  it("runs the sweep on */15 and retention + the line fee on the daily cron", async () => {
    const net = new FakeNet().install();
    net.on("GET", /\/Recordings\.json\?/, () => jsonRes({ recordings: [], next_page_uri: null }));
    net.rest("GET", "phone_voicemails", () => []);
    const env = makeEnv();
    const ctx = new FakeCtx();
    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, ctx as unknown as ExecutionContext);
    await ctx.settle();
    expect(net.to(/Recordings\.json/)).toHaveLength(1);
    expect(net.reads("phone_voicemails")).toHaveLength(0);

    const daily = new FakeCtx();
    await worker.scheduled({ cron: "0 9 * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, daily as unknown as ExecutionContext);
    await daily.settle();
    expect(net.reads("phone_voicemails")).toHaveLength(1);
    expect(net.reads("usage_prices")).toHaveLength(0); // PHONE_USAGE_METERS is off
    expect(net.to(/Usage\/Records/)).toHaveLength(0); // and so is cost capture (helpers)
  });

  it("with cost capture on, the daily cron stores yesterday's Twilio usage totals", async () => {
    const net = new FakeNet().install();
    net.rest("GET", "phone_voicemails", () => []);
    net.on("GET", /\/Usage\/Records\/Daily\.json\?/, () => jsonRes({
      usage_records: [
        { category: "calls-outbound", count: "12", usage: "31", price: "0.43400", price_unit: "usd" },
        { category: "sms-messages-carrierfees", count: "40", usage: "40", price: "0.18000", price_unit: "usd" },
        { category: "phonenumbers", count: "1", usage: "1", price: "1.15", price_unit: "usd" }, // not kept
      ],
      next_page_uri: null,
    }));
    net.rest("POST", "twilio_usage_daily", () => []);
    const env = makeEnv({ PHONE_USAGE_COST_CAPTURE: "on" });
    const ctx = new FakeCtx();
    await worker.scheduled({ cron: "0 9 * * *", scheduledTime: Date.parse("2026-10-02T09:00:00Z"), noRetry() {} } as ScheduledController, env, ctx as unknown as ExecutionContext);
    await ctx.settle();
    const q = net.to(/Usage\/Records/)[0].url.searchParams;
    expect([q.get("StartDate"), q.get("EndDate")]).toEqual(["2026-10-01", "2026-10-01"]);
    const up = net.writes("twilio_usage_daily", "POST")[0];
    expect(up.url.searchParams.get("on_conflict")).toBe("day,category");
    expect(up.json).toEqual([
      { day: "2026-10-01", category: "calls-outbound", count: 12, usage: 31, price_micros: 434000, fetched_at: "2026-10-02T09:00:00.000Z" },
      { day: "2026-10-01", category: "sms-messages-carrierfees", count: 40, usage: 40, price_micros: 180000, fetched_at: "2026-10-02T09:00:00.000Z" },
    ]);
  });
});

describe("the single every-minute tick", () => {
  const tick = (iso: string) => ({ cron: "* * * * *", scheduledTime: Date.parse(iso), noRetry() {} }) as ScheduledController;
  it("keep-warms every minute, sweeps on :00/:15/:30/:45, charges usage on minute % 5 == 2, runs the daily jobs at 09:00 UTC", async () => {
    const net = new FakeNet().install();
    net.on("GET", /\/health\?warm=1/, () => jsonRes({ ok: true, warm: true }));
    net.on("GET", /\/Recordings\.json\?/, () => jsonRes({ recordings: [], next_page_uri: null }));
    net.rest("GET", "phone_voicemails", () => []);
    const env = makeEnv();
    const run = async (iso: string) => { const c = new FakeCtx(); await worker.scheduled(tick(iso), env, c as unknown as ExecutionContext); await c.settle(); };

    await run("2026-09-29T10:07:00Z");
    expect(net.to(/\/health\?warm=1/)).toHaveLength(1);
    expect(net.to(/Recordings\.json/)).toHaveLength(0);
    expect(net.reads("phone_voicemails")).toHaveLength(0);

    await run("2026-09-29T10:15:00Z");
    expect(net.to(/\/health\?warm=1/)).toHaveLength(2);
    expect(net.to(/Recordings\.json/)).toHaveLength(1);
    expect(net.reads("phone_voicemails")).toHaveLength(0);

    await run("2026-09-29T09:00:00Z");
    expect(net.to(/Recordings\.json/)).toHaveLength(2); // 09:00 is also a sweep minute
    expect(net.reads("phone_voicemails")).toHaveLength(1); // retention ran
    expect(net.rpcCalls("usage_charges_enqueue")).toHaveLength(0); // cost capture off (helpers)
  });

  it("the usage charges run on :02, :07, :12 ... and on no other minute", async () => {
    const net = new FakeNet().install();
    net.on("GET", /\/health\?warm=1/, () => jsonRes({ ok: true, warm: true }));
    net.on("GET", /\/Recordings\.json\?/, () => jsonRes({ recordings: [], next_page_uri: null }));
    net.rpc("usage_charges_enqueue", () => 0);
    net.rest("GET", "phone_billing_settings", () => []);
    net.rpc("usage_charges_claim", () => []);
    const env = makeEnv({ PHONE_USAGE_COST_CAPTURE: "on" });
    const run = async (iso: string) => { const c = new FakeCtx(); await worker.scheduled(tick(iso), env, c as unknown as ExecutionContext); await c.settle(); };
    for (const m of [0, 1, 3, 4, 5, 15, 30]) await run(`2026-09-29T10:${String(m).padStart(2, "0")}:00Z`);
    expect(net.rpcCalls("usage_charges_enqueue")).toHaveLength(0);
    await run("2026-09-29T10:02:00Z");
    await run("2026-09-29T10:07:00Z");
    await run("2026-09-29T10:57:00Z");
    expect(net.rpcCalls("usage_charges_enqueue")).toHaveLength(3);
    // The run's clock is the tick's: three days back from it.
    expect(net.rpcCalls("usage_charges_enqueue")[0].json).toEqual({ p_since: "2026-09-26T10:02:00.000Z", p_limit: 500 });
  });
});

describe("monthly line fee (phone_line_monthly, daily cron)", () => {
  const T2 = "tenant-two";
  const T3 = "tenant-three";
  const EXEMPT = "exempt-tenant";

  function setup(opts: { price?: unknown[]; charged?: string[] } = {}) {
    const net = new FakeNet().install();
    net.rest("GET", "usage_prices", (s) => (filter(s, "kind") === "phone_line_monthly" ? (opts.price ?? [{ price_cents: 2500, active: true }]) : []));
    net.rest("GET", "client_settings", (s) => {
      if (filter(s, "phone_status") === "on") return [{ client_id: CLIENT }, { client_id: T2 }, { client_id: T3 }, { client_id: EXEMPT }];
      return [{ billing_exempt: false }];
    });
    // T3 has the switch on but no voice number: no line, no fee.
    net.rest("GET", "sms_numbers", () => [{ client_id: CLIENT }, { client_id: T2 }, { client_id: EXEMPT }, { client_id: T2 }]);
    net.rest("GET", "wallet_transactions", () => (opts.charged ?? []).map((k) => ({ idempotency_key: k })));
    net.rest("GET", "wallet_accounts", (s) => (filter(s, "client_id") === EXEMPT ? [{ metered_exempt: true }] : [{ metered_exempt: false }]));
    net.rpc("wallet_credit", () => 1000);
    net.rest("POST", "app_errors", () => []);
    return net;
  }

  it("does nothing, and reads nothing, while PHONE_USAGE_METERS is off", async () => {
    const net = new FakeNet().install();
    const env = makeEnv();
    expect(await chargeMonthlyLineFees(env, adminClient(env))).toEqual({ ran: false, reason: "switched_off" });
    expect(net.seen).toEqual([]);
  });

  it.each([
    ["no meter row", [], "unknown_meter"],
    ["the meter inactive", [{ price_cents: 2500, active: false }], "inactive"],
    ["the meter priced at zero", [{ price_cents: 0, active: true }], "unpriced"],
  ] as const)("does nothing while disarmed (%s)", async (_l, price, reason) => {
    const net = setup({ price: [...price] });
    const env = makeEnv({ PHONE_USAGE_METERS: "on" });
    expect(await chargeMonthlyLineFees(env, adminClient(env))).toEqual({ ran: false, reason });
    expect(net.rpcCalls("wallet_credit")).toEqual([]);
  });

  it("when armed: once per tenant with a line per UTC month, keyed tenant + YYYY-MM; already-charged and exempt tenants skipped", async () => {
    const net = setup({ charged: [lineFeeIdem(T2, "2026-09")] });
    const env = makeEnv({ PHONE_USAGE_METERS: "on" });
    const out = await chargeMonthlyLineFees(env, adminClient(env), new Date("2026-09-29T09:00:00Z"));
    expect(out).toEqual({ ran: true, month: "2026-09", tenants: 3, charged: 1, already: 1, exempt: 1, failed: 0 });
    expect(net.rpcCalls("wallet_credit").map((s) => s.json)).toEqual([{
      p_client_id: CLIENT, p_amount_cents: -2500, p_kind: "debit", p_ref_type: "phone_line", p_ref_id: "2026-09",
      p_memo: "Phone line for 2026-09", p_idem: "phone_line_monthly:demo-tenant:2026-09", p_actor: null, p_meter_kind: "phone_line_monthly",
    }]);
    // A line is the switch on AND a voice-enabled number still held.
    const nums = net.reads("sms_numbers")[0];
    expect(nums.url.searchParams.get("voice_enabled")).toBe("eq.true");
    expect(nums.url.searchParams.get("released_at")).toBe("is.null");
  });

  it("a failed charge is logged and retried by the next run (same key), never dropped", async () => {
    const net = setup();
    net.rpc("wallet_credit", () => new Response(JSON.stringify({ code: "P0001", message: "boom" }), { status: 400, headers: { "content-type": "application/json" } }));
    const env = makeEnv({ PHONE_USAGE_METERS: "on" });
    const out = await chargeMonthlyLineFees(env, adminClient(env), new Date("2026-10-01T09:00:00Z"));
    expect(out).toMatchObject({ ran: true, month: "2026-10", charged: 0, failed: 2 });
    expect(net.writes("app_errors").map((s) => s.json.code)).toEqual(["phone_line_fee_failed", "phone_line_fee_failed"]);
  });

  it("keys and months", () => {
    expect(lineFeeIdem("demo-tenant", "2026-09")).toBe("phone_line_monthly:demo-tenant:2026-09");
    expect(utcMonth(new Date("2026-09-30T23:59:59Z"))).toBe("2026-09");
    expect(utcMonth(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10");
  });

  it("the daily cron runs it after retention; a retention failure does not skip billing", async () => {
    const net = setup();
    net.rest("GET", "phone_voicemails", () => new Response(JSON.stringify({ message: "down" }), { status: 500 }));
    const env = makeEnv({ PHONE_USAGE_METERS: "on" });
    const ctx = new FakeCtx();
    await worker.scheduled({ cron: "0 9 * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, ctx as unknown as ExecutionContext);
    await ctx.settle();
    expect(net.writes("app_errors").map((s) => s.json.context?.job)).toContain("retention");
    expect(net.rpcCalls("wallet_credit").length).toBeGreaterThan(0);
  });
});
