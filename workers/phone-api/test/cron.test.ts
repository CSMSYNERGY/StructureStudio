import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { recordingSweep } from "../src/cron/sweep";
import { retention } from "../src/cron/retention";
import { chargeMonthlyLineFees, lineFeeIdem, utcMonth } from "../src/cron/lineFee";
import { chargeMonthlyNumberFees, numberFeeIdem, numberFeeMemo, numberPeriod } from "../src/cron/numberFee";
import { previousUtcDay } from "../src/cron/usageCharge";
import { adminClient } from "../src/db";
import { installDenoShim } from "../src/env";
import { BUSINESS_NUMBER, CLIENT, CUSTOMER, FakeCtx, FakeNet, NUMBER_ID, SUPABASE_URL, filter, jsonRes, makeEnv, routeInfo, type Seen } from "./helpers";

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
    net.rest("GET", "usage_prices", () => []);
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
    // PHONE_USAGE_METERS is off, so the line fee reads nothing. The number fee's one switch is
    // its own meter (cron/numberFee.ts), so it reads that row, and only that row, every day.
    expect(net.reads("usage_prices").map((s) => filter(s, "kind"))).toEqual(["sms_number_monthly"]);
    expect(net.reads("sms_numbers")).toHaveLength(0);
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
    // Workstream 2, phase 7: the parent's own usage only, on migration 298's key.
    expect(q.get("IncludeSubaccounts")).toBe("false");
    const up = net.writes("twilio_usage_daily", "POST")[0];
    expect(up.url.searchParams.get("on_conflict")).toBe("day,account_sid,category");
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

describe("monthly number fee (sms_number_monthly, daily cron, months 2 and on)", () => {
  const T2 = "tenant-two";
  const EXEMPT = "exempt-tenant";
  const BILLING_EXEMPT = "billing-exempt-tenant";
  const GONE = "deleted-tenant";
  const num = (n: number) => `00000000-0000-4000-8000-00000000a${String(n).padStart(3, "0")}`;
  const N2 = num(2);

  interface Num { id: string; client_id: string; purchased_at: string; released_at?: string | null }
  interface Wallet { balance_cents?: number; held_cents?: number; auto_topup_enabled?: boolean; auto_topup_threshold_cents?: number | null }

  /** The values of an `in.(...)` filter, as postgrest-js writes them. */
  function inList(s: Seen, col: string): string[] {
    const m = /^in\.\((.*)\)$/.exec(s.url.searchParams.get(col) ?? "");
    return m ? m[1].split(",").map((x) => x.replace(/^"|"$/g, "")) : [];
  }

  /**
   * A fake database that remembers what it charged: wallet_credit writes its key to the ledger
   * (and a replayed key is a no-op, as in 244), and the ledger read honours the keys asked for.
   */
  function setup(opts: { price?: unknown[]; numbers: Num[]; charged?: string[]; wallets?: Record<string, Wallet>; failFor?: string } ) {
    const net = new FakeNet().install();
    const ledger = new Set(opts.charged ?? []);
    const debits: string[] = [];
    net.rest("GET", "usage_prices", (s) => (filter(s, "kind") === "sms_number_monthly" ? (opts.price ?? [{ price_cents: 2900, active: true }]) : []));
    // Honours released_at=is.null, so a query that forgot it would charge the released row.
    net.rest("GET", "sms_numbers", (s) => opts.numbers
      .filter((n) => (s.url.searchParams.get("released_at") === "is.null" ? !n.released_at : true))
      .map(({ released_at: _r, ...row }) => row));
    net.rest("GET", "wallet_transactions", (s) => inList(s, "idempotency_key").filter((k) => ledger.has(k)).map((k) => ({ idempotency_key: k })));
    net.rest("GET", "client_configs", (s) => inList(s, "client_id").filter((c) => c !== GONE).map((c) => ({ client_id: c })));
    net.rest("GET", "client_settings", (s) => inList(s, "client_id").map((c) => ({ client_id: c, billing_exempt: c === BILLING_EXEMPT })));
    net.rest("GET", "wallet_accounts", (s) => inList(s, "client_id").map((c) => ({
      client_id: c, metered_exempt: c === EXEMPT, balance_cents: 10_000, held_cents: 0, auto_topup_enabled: false, auto_topup_threshold_cents: null,
      ...(opts.wallets?.[c] ?? {}),
    })));
    net.rpc("wallet_credit", (s) => {
      if (opts.failFor && s.json.p_client_id === opts.failFor) {
        return new Response(JSON.stringify({ code: "P0001", message: "boom" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      if (!ledger.has(s.json.p_idem)) { ledger.add(s.json.p_idem); debits.push(s.json.p_idem); }
      return 7100;
    });
    net.on("POST", (u) => u.href === `${SUPABASE_URL}/functions/v1/wallet-autotopup`, () => jsonRes({ fired: true, ok: true }));
    net.rest("POST", "app_errors", () => []);
    return { net, ledger, debits };
  }
  const run = (iso: string) => { const env = makeEnv(); return chargeMonthlyNumberFees(env, adminClient(env), new Date(iso)); };

  it("keys, memos and periods: the purchase day each month (UTC), clamped to the month's last day", () => {
    expect(numberFeeIdem(NUMBER_ID, 1)).toBe(`sms_number_monthly:${NUMBER_ID}:m1`);
    expect(numberFeeIdem(NUMBER_ID, 12)).toBe(`sms_number_monthly:${NUMBER_ID}:m12`);
    expect(numberFeeMemo(1)).toBe("Phone number fee, month 2");
    const at = (purchased: string, day: string) => numberPeriod(purchased, new Date(`${day}T09:00:00Z`));
    expect(at("2026-09-15T17:30:00Z", "2026-09-15")).toBe(0); // the purchase day, even before the purchase's hour
    expect(at("2026-09-15T17:30:00Z", "2026-10-14")).toBe(0);
    expect(at("2026-09-15T17:30:00Z", "2026-10-15")).toBe(1);
    expect(at("2026-09-15T17:30:00Z", "2027-09-15")).toBe(12);
    expect(at("2026-12-10T00:00:00Z", "2027-01-10")).toBe(1); // across the year
    // Bought on the 31st: Feb 28 (29 in a leap year), then Mar 31, Apr 30. The clamp never drifts.
    expect(at("2027-01-31T12:00:00Z", "2027-02-27")).toBe(0);
    expect(at("2027-01-31T12:00:00Z", "2027-02-28")).toBe(1);
    expect(at("2027-01-31T12:00:00Z", "2027-03-01")).toBe(1);
    expect(at("2027-01-31T12:00:00Z", "2027-03-30")).toBe(1);
    expect(at("2027-01-31T12:00:00Z", "2027-03-31")).toBe(2);
    expect(at("2027-01-31T12:00:00Z", "2027-04-30")).toBe(3);
    expect(at("2028-01-31T12:00:00Z", "2028-02-28")).toBe(0);
    expect(at("2028-01-31T12:00:00Z", "2028-02-29")).toBe(1);
    expect(at("2026-11-30T12:00:00Z", "2027-02-27")).toBe(2);
    expect(at("2026-11-30T12:00:00Z", "2027-02-28")).toBe(3);
    // Before the purchase, or a date that does not parse: never a chargeable period.
    expect(at("2026-10-05T00:00:00Z", "2026-10-04")).toBe(-1);
    expect(numberPeriod("not a date", new Date())).toBeNaN();
  });

  it("the key is never the purchase's: month 1 stays with the purchase hold (sms_num:<client>:<number>)", () => {
    const key = numberFeeIdem(NUMBER_ID, 1);
    expect(key.startsWith("sms_num:")).toBe(false);
    expect(key).not.toContain(BUSINESS_NUMBER);
    // Both purchases still hold the first month on this meter under that other key.
    const src = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");
    expect(src("../../supabase/functions/portal-sms/index.ts")).toMatch(/takeHold\(admin, clientId, "sms_number_monthly", `sms_num:\$\{clientId\}:\$\{wanted\}`/);
    expect(src("../../supabase/functions/portal-settings/phoneNumber.ts")).toContain("return `sms_num:${clientId}:${e164}`");
  });

  it.each([
    ["no meter row", [], "unknown_meter"],
    ["the meter inactive (as it ships)", [{ price_cents: 2900, active: false }], "inactive"],
    ["the meter priced at zero", [{ price_cents: 0, active: true }], "unpriced"],
  ] as const)("does nothing while disarmed (%s): one price read, no numbers read, no charge", async (_l, price, reason) => {
    const { net } = setup({ price: [...price], numbers: [{ id: NUMBER_ID, client_id: CLIENT, purchased_at: "2026-01-10T00:00:00Z" }] });
    expect(await run("2026-10-10T09:00:00Z")).toEqual({ ran: false, reason });
    expect(net.reads("usage_prices")).toHaveLength(1);
    expect(net.reads("sms_numbers")).toEqual([]);
    expect(net.rpcCalls("wallet_credit")).toEqual([]);
  });

  it("when armed it needs no env switch: each live number is charged on its own day, current month only; first-month, already-charged, exempt, deleted and released numbers are not", async () => {
    const { net } = setup({
      numbers: [
        { id: num(1), client_id: CLIENT, purchased_at: "2026-08-20T15:00:00Z" },         // period 2 today: charged
        { id: N2, client_id: T2, purchased_at: "2026-10-01T10:00:00Z" },                  // its purchase month
        { id: num(3), client_id: T2, purchased_at: "2026-09-20T10:00:00Z" },              // period 1, already on the ledger
        { id: num(4), client_id: EXEMPT, purchased_at: "2026-01-05T10:00:00Z" },
        { id: num(5), client_id: BILLING_EXEMPT, purchased_at: "2026-02-05T10:00:00Z" },
        { id: num(6), client_id: GONE, purchased_at: "2026-03-05T10:00:00Z" },
        { id: num(7), client_id: CLIENT, purchased_at: "2026-01-01T10:00:00Z", released_at: "2026-05-01T00:00:00Z" },
      ],
      charged: [numberFeeIdem(num(3), 1)],
    });
    // makeEnv() has PHONE_USAGE_METERS "off": the meter row is the only switch, as for month 1.
    const out = await run("2026-10-20T09:00:00Z");
    expect(out).toEqual({ ran: true, tenants: 5, numbers: 6, firstMonth: 1, charged: 1, already: 1, exempt: 2, gone: 1, failed: 0, topups: 0 });
    expect(net.rpcCalls("wallet_credit").map((s) => s.json)).toEqual([{
      p_client_id: CLIENT, p_amount_cents: -2900, p_kind: "debit", p_ref_type: "sms_number", p_ref_id: num(1),
      p_memo: "Phone number fee, month 3", p_idem: `sms_number_monthly:${num(1)}:m2`, p_actor: null, p_meter_kind: "sms_number_monthly",
    }]);
    expect(net.reads("sms_numbers")[0].url.searchParams.get("released_at")).toBe("is.null");
    // One ledger read for every number due, narrowed by tenant as well (wallet_tx_idem).
    const ledgerRead = net.reads("wallet_transactions");
    expect(ledgerRead).toHaveLength(1);
    expect(inList(ledgerRead[0], "client_id").sort()).toEqual([BILLING_EXEMPT, CLIENT, GONE, EXEMPT, T2].sort());
    expect(inList(ledgerRead[0], "idempotency_key")).toHaveLength(5);
    // The deleted tenant's number is a warning to release it, not a charge and not an error.
    expect(net.writes("app_errors").map((s) => [s.json.code, s.json.severity, s.json.client_id])).toEqual([["sms_number_fee_no_tenant", "warn", GONE]]);
  });

  it("the purchase month is never charged here; the first run on the anniversary charges month 2", async () => {
    const { net, debits } = setup({ numbers: [{ id: NUMBER_ID, client_id: CLIENT, purchased_at: "2026-09-15T17:30:00Z" }] });
    expect(await run("2026-09-16T09:00:00Z")).toMatchObject({ ran: true, firstMonth: 1, charged: 0 });
    expect(await run("2026-10-14T09:00:00Z")).toMatchObject({ ran: true, firstMonth: 1, charged: 0 });
    expect(net.rpcCalls("wallet_credit")).toEqual([]);
    expect(await run("2026-10-15T09:00:00Z")).toMatchObject({ ran: true, firstMonth: 0, charged: 1 });
    expect(debits).toEqual([`sms_number_monthly:${NUMBER_ID}:m1`]);
  });

  it("the day clamp: bought Jan 31, charged Feb 28, not again on Mar 1, then Mar 31", async () => {
    const { debits } = setup({ numbers: [{ id: NUMBER_ID, client_id: CLIENT, purchased_at: "2027-01-31T20:00:00Z" }] });
    for (const day of ["2027-02-27", "2027-02-28", "2027-03-01", "2027-03-30", "2027-03-31"]) await run(`${day}T09:00:00Z`);
    expect(debits).toEqual([`sms_number_monthly:${NUMBER_ID}:m1`, `sms_number_monthly:${NUMBER_ID}:m2`]);
  });

  it("every daily run of a month charges once: the ledger read skips it, and a replay reuses the same key", async () => {
    const { net, debits } = setup({ numbers: [{ id: NUMBER_ID, client_id: CLIENT, purchased_at: "2026-09-15T10:00:00Z" }] });
    for (let d = 0; d < 31; d++) await run(new Date(Date.parse("2026-10-15T09:00:00Z") + d * 86_400_000).toISOString());
    expect(debits).toEqual([`sms_number_monthly:${NUMBER_ID}:m1`]);
    expect(net.rpcCalls("wallet_credit")).toHaveLength(1);
    await run("2026-11-15T09:00:00Z");
    expect(debits).toEqual([`sms_number_monthly:${NUMBER_ID}:m1`, `sms_number_monthly:${NUMBER_ID}:m2`]);

    // Two runs racing past the ledger read send the SAME key, so 244's replay check (and the
    // unique (client_id, idempotency_key) index) makes the second a no-op, never a second debit.
    const race = setup({ numbers: [{ id: NUMBER_ID, client_id: CLIENT, purchased_at: "2026-09-15T10:00:00Z" }] });
    await Promise.all([run("2026-10-20T09:00:00Z"), run("2026-10-20T09:00:00Z")]);
    const keys = race.net.rpcCalls("wallet_credit").map((s) => s.json.p_idem);
    expect(new Set(keys)).toEqual(new Set([`sms_number_monthly:${NUMBER_ID}:m1`]));
    expect(race.debits).toHaveLength(1);
  });

  it("arming late charges only the current month, never the months before", async () => {
    const { net } = setup({ numbers: [{ id: NUMBER_ID, client_id: CLIENT, purchased_at: "2026-01-10T10:00:00Z" }] });
    expect(await run("2026-06-20T09:00:00Z")).toMatchObject({ ran: true, charged: 1 });
    expect(net.rpcCalls("wallet_credit").map((s) => [s.json.p_idem, s.json.p_memo])).toEqual([
      [`sms_number_monthly:${NUMBER_ID}:m5`, "Phone number fee, month 6"],
    ]);
  });

  it("a failed charge is logged and retried by the next run (same key); the other numbers are still charged", async () => {
    const { net } = setup({
      numbers: [
        { id: NUMBER_ID, client_id: CLIENT, purchased_at: "2026-09-15T10:00:00Z" },
        { id: N2, client_id: T2, purchased_at: "2026-09-16T10:00:00Z" },
      ],
      failFor: CLIENT,
    });
    expect(await run("2026-10-20T09:00:00Z")).toMatchObject({ ran: true, charged: 1, failed: 1 });
    const errs = net.writes("app_errors").map((s) => s.json);
    expect(errs.map((e) => [e.code, e.severity, e.client_id])).toEqual([["sms_number_fee_failed", "error", CLIENT]]);
    expect(errs[0].context).toMatchObject({ number_id: NUMBER_ID, period: 1 });
    await run("2026-10-21T09:00:00Z");
    expect(net.rpcCalls("wallet_credit").filter((s) => s.json.p_client_id === CLIENT).map((s) => s.json.p_idem))
      .toEqual([`sms_number_monthly:${NUMBER_ID}:m1`, `sms_number_monthly:${NUMBER_ID}:m1`]);
  });

  it("a failed read charges nobody that run, and is logged", async () => {
    const { net } = setup({ numbers: [{ id: NUMBER_ID, client_id: CLIENT, purchased_at: "2026-09-15T10:00:00Z" }] });
    net.rest("GET", "client_settings", () => new Response(JSON.stringify({ message: "down" }), { status: 500 }));
    expect(await run("2026-10-20T09:00:00Z")).toEqual({ ran: false, reason: "error" });
    expect(net.rpcCalls("wallet_credit")).toEqual([]);
    expect(net.writes("app_errors").map((s) => s.json.code)).toEqual(["sms_number_fee_failed"]);
  });

  it("a balance the fee leaves under the auto top-up threshold asks for a top-up, once per tenant", async () => {
    const { net } = setup({
      numbers: [
        { id: NUMBER_ID, client_id: CLIENT, purchased_at: "2026-09-15T10:00:00Z" },
        { id: num(8), client_id: CLIENT, purchased_at: "2026-08-15T10:00:00Z" },
        { id: N2, client_id: T2, purchased_at: "2026-09-15T10:00:00Z" },
      ],
      wallets: {
        [CLIENT]: { balance_cents: 400, held_cents: 0, auto_topup_enabled: true, auto_topup_threshold_cents: 1000 },
        [T2]: { balance_cents: 5000, held_cents: 0, auto_topup_enabled: true, auto_topup_threshold_cents: 1000 },
      },
    });
    expect(await run("2026-10-20T09:00:00Z")).toMatchObject({ ran: true, charged: 3, topups: 1 });
    expect(net.to(/\/functions\/v1\/wallet-autotopup$/).map((s) => s.json)).toEqual([{ client_id: CLIENT }]);
  });

  it("the daily cron runs it after the line fee, on the tick's clock; no other minute reads its meter", async () => {
    const index = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
    const daily = index.slice(index.indexOf("if (dailyDue) {"), index.indexOf("if (tick && callTranscribeOn(env))"));
    expect(daily).toContain('await job("number_fee", () => chargeMonthlyNumberFees(env, adminClient(env), at));');
    expect(daily.indexOf('job("number_fee"')).toBeGreaterThan(daily.indexOf('job("line_fee"'));

    const { net, debits } = setup({ numbers: [{ id: NUMBER_ID, client_id: CLIENT, purchased_at: "2026-09-20T10:00:00Z" }] });
    net.rest("GET", "phone_voicemails", () => []);
    net.on("GET", /\/Recordings\.json\?/, () => jsonRes({ recordings: [], next_page_uri: null }));
    net.on("GET", /\/health\?warm=1/, () => jsonRes({ ok: true, warm: true }));
    const tick = async (iso: string) => {
      const c = new FakeCtx();
      await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.parse(iso), noRetry() {} } as ScheduledController, makeEnv(), c as unknown as ExecutionContext);
      await c.settle();
    };
    await tick("2026-10-20T10:00:00Z");
    expect(net.reads("usage_prices")).toEqual([]);
    await tick("2026-10-20T09:00:00Z");
    expect(debits).toEqual([`sms_number_monthly:${NUMBER_ID}:m1`]);
  });
});
