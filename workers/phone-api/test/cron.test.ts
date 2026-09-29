import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { recordingSweep } from "../src/cron/sweep";
import { retention } from "../src/cron/retention";
import { chargeMonthlyLineFees, debitDailyUsage, lineFeeIdem, previousUtcDay, utcDays, utcMonth, voiceMinuteIdem } from "../src/cron/usageDebit";
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
        { sid: RE(1), call_sid: CA(1), status: "completed", duration: "12", date_created: "Tue, 29 Sep 2026 11:50:00 +0000" }, // already filed
        { sid: RE(2), call_sid: CA(2), status: "completed", duration: "20", date_created: "Tue, 29 Sep 2026 11:40:00 +0000" }, // missed, row exists
        { sid: RE(3), call_sid: CA(3), status: "completed", duration: "8", date_created: "Tue, 29 Sep 2026 11:30:00 +0000" }, // fallback: no row
        { sid: RE(4), call_sid: CA(4), status: "completed", duration: "8", date_created: "Tue, 29 Sep 2026 11:20:00 +0000" }, // not our number
        { sid: RE(5), call_sid: CA(5), status: "completed", duration: "0", date_created: "Tue, 29 Sep 2026 11:10:00 +0000" }, // a hang-up
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
        { sid: RE(1), call_sid: CA(1), status: "completed", duration: "14", date_created: "Tue, 29 Sep 2026 11:50:00 +0000" },
        { sid: RE(2), call_sid: CA(2), status: "completed", duration: "9", date_created: "Tue, 29 Sep 2026 11:40:00 +0000" },
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

describe("usage debit (release 2, disabled unless the meters are active)", () => {
  it("does nothing, and reads nothing, while PHONE_USAGE_METERS is off", async () => {
    const net = new FakeNet().install();
    const env = makeEnv();
    expect(await debitDailyUsage(env, adminClient(env))).toEqual({ ran: false, reason: "switched_off" });
    expect(net.seen).toEqual([]);
  });

  it("does nothing while the voice_minute meter is disarmed", async () => {
    const net = new FakeNet().install();
    const env = makeEnv({ PHONE_USAGE_METERS: "on" });
    net.rest("GET", "usage_prices", () => [{ price_cents: 2, active: false }]);
    expect(await debitDailyUsage(env, adminClient(env))).toEqual({ ran: false, reason: "inactive" });
    expect(net.rpcCalls("wallet_credit")).toEqual([]);
  });

  /**
   * An armed meter over a fake ledger. `ledger` holds the idempotency keys already charged;
   * the earliest phone_minutes day is derived from them, as the Worker reads it.
   */
  function armed(opts: { calls: { client_id: string; started_at: string; duration_s: number }[]; ledger?: string[]; failFor?: string[] }) {
    const net = new FakeNet().install();
    const ledger = new Set(opts.ledger ?? []);
    net.rest("GET", "usage_prices", () => [{ price_cents: 2, active: true }]);
    net.rest("GET", "phone_calls", (s) => {
      const [gte, lt] = s.url.searchParams.getAll("started_at").map((v) => v.slice(v.indexOf(".") + 1));
      return opts.calls.filter((c) => c.started_at >= gte && c.started_at < lt);
    });
    net.rest("GET", "wallet_transactions", (s) => {
      if (filter(s, "ref_type") === "phone_minutes") {
        const days = [...ledger].map((k) => k.split(":").pop()!).sort();
        return days.length ? [{ ref_id: days[0] }] : [];
      }
      const asked = (s.url.searchParams.get("idempotency_key") ?? "").replace(/^in\.\(|\)$/g, "").split(",").map((k) => k.replace(/"/g, ""));
      return asked.filter((k) => ledger.has(k)).map((k) => ({ idempotency_key: k }));
    });
    net.rest("GET", "wallet_accounts", (s) => (filter(s, "client_id") === "exempt-tenant" ? [{ metered_exempt: true }] : [{ metered_exempt: false }]));
    net.rest("GET", "client_settings", () => [{ billing_exempt: false }]);
    net.rpc("wallet_credit", (s) => {
      if ((opts.failFor ?? []).includes(s.json.p_idem)) {
        return new Response(JSON.stringify({ code: "P0001", message: "boom" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      ledger.add(s.json.p_idem);
      return 900;
    });
    net.rest("POST", "app_errors", () => []);
    return { net, ledger };
  }
  const credits = (net: FakeNet) => net.rpcCalls("wallet_credit").map((s) => s.json.p_idem);

  it("when armed: one debit per tenant per day, keyed so a rerun cannot charge twice; exempt tenants skipped", async () => {
    const { net } = armed({
      ledger: ["voice_minute:demo-tenant:2026-09-27"], // the job has run before
      calls: [
        { client_id: CLIENT, started_at: "2026-09-28T10:00:00.000Z", duration_s: 61 }, { client_id: CLIENT, started_at: "2026-09-28T11:00:00.000Z", duration_s: 30 }, // 2 + 1 minutes
        { client_id: "exempt-tenant", started_at: "2026-09-28T12:00:00.000Z", duration_s: 600 },
      ],
    });
    const env = makeEnv({ PHONE_USAGE_METERS: "on" });
    const out = await debitDailyUsage(env, adminClient(env), new Date("2026-09-29T09:00:00Z"));
    expect(out).toEqual({ ran: true, days: ["2026-09-27", "2026-09-28"], tenants: 2, charged: 1, already: 0, exempt: 1, failed: 0 });
    expect(net.rpcCalls("wallet_credit").map((s) => s.json)).toEqual([{
      p_client_id: CLIENT, p_amount_cents: -6, p_kind: "debit", p_ref_type: "phone_minutes", p_ref_id: "2026-09-28",
      p_memo: "3 call minutes on 2026-09-28", p_idem: "voice_minute:demo-tenant:2026-09-28", p_actor: null, p_meter_kind: "voice_minute",
    }]);
    const q = net.reads("phone_calls")[0];
    expect(q.url.searchParams.getAll("started_at")).toEqual(["gte.2026-09-27T00:00:00.000Z", "lt.2026-09-29T00:00:00.000Z"]);
  });

  it("a day whose charge FAILED is charged by the next run (plan 17: retried, never dropped)", async () => {
    const calls = [
      { client_id: CLIENT, started_at: "2026-09-27T10:00:00.000Z", duration_s: 60 },
      { client_id: CLIENT, started_at: "2026-09-28T10:00:00.000Z", duration_s: 120 },
      { client_id: CLIENT, started_at: "2026-09-29T10:00:00.000Z", duration_s: 180 },
    ];
    const env = makeEnv({ PHONE_USAGE_METERS: "on" });
    // Day D = 09-28 fails in the run of 09-29.
    const first = armed({ calls, ledger: ["voice_minute:demo-tenant:2026-09-27"], failFor: ["voice_minute:demo-tenant:2026-09-28"] });
    const a = await debitDailyUsage(env, adminClient(env), new Date("2026-09-29T09:00:00Z"));
    expect(a).toMatchObject({ ran: true, charged: 0, already: 1, failed: 1 });
    expect(first.net.writes("app_errors").map((s) => s.json.code)).toEqual(["phone_usage_debit_failed"]);

    // The D+1 run charges D as well as its own yesterday; the day already on the ledger is skipped.
    const second = armed({ calls, ledger: [...first.ledger] });
    const b = await debitDailyUsage(env, adminClient(env), new Date("2026-09-30T09:00:00Z"));
    expect(b).toMatchObject({ ran: true, days: ["2026-09-27", "2026-09-28", "2026-09-29"], charged: 2, already: 1, failed: 0 });
    expect(credits(second.net)).toEqual(["voice_minute:demo-tenant:2026-09-28", "voice_minute:demo-tenant:2026-09-29"]);
  });

  it("a whole run that never happened is caught up too, up to a week back", async () => {
    const calls = [3, 5, 9].map((d) => ({ client_id: CLIENT, started_at: `2026-09-${String(20 + d).padStart(2, "0")}T10:00:00.000Z`, duration_s: 60 }));
    const { net } = armed({ calls, ledger: ["voice_minute:demo-tenant:2026-09-20"] });
    const env = makeEnv({ PHONE_USAGE_METERS: "on" });
    const out = await debitDailyUsage(env, adminClient(env), new Date("2026-09-30T09:00:00Z"));
    // The window is 09-23..09-29 (7 days); the 09-20 row only proves the job ran before.
    expect(out).toMatchObject({ ran: true, days: ["2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"], charged: 3 });
    expect(credits(net)).toEqual(["voice_minute:demo-tenant:2026-09-23", "voice_minute:demo-tenant:2026-09-25", "voice_minute:demo-tenant:2026-09-29"]);
  });

  it("the first run after the meter is armed charges only yesterday, never the calls made while it was off", async () => {
    const calls = [
      { client_id: CLIENT, started_at: "2026-09-25T10:00:00.000Z", duration_s: 600 },
      { client_id: CLIENT, started_at: "2026-09-28T10:00:00.000Z", duration_s: 60 },
    ];
    const { net } = armed({ calls });
    const env = makeEnv({ PHONE_USAGE_METERS: "on" });
    const out = await debitDailyUsage(env, adminClient(env), new Date("2026-09-29T09:00:00Z"));
    expect(out).toMatchObject({ ran: true, days: ["2026-09-28"], charged: 1 });
    expect(credits(net)).toEqual(["voice_minute:demo-tenant:2026-09-28"]);
  });

  it("keys and days", () => {
    expect(voiceMinuteIdem("demo-tenant", "2026-09-28")).toBe("voice_minute:demo-tenant:2026-09-28");
    expect(previousUtcDay(new Date("2026-03-01T00:30:00Z"))).toBe("2026-02-28");
    expect(utcDays("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });
});

describe("scheduled()", () => {
  it("runs the sweep on */15 and retention + debit on the daily cron", async () => {
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
  });
});

describe("the single every-minute tick", () => {
  const tick = (iso: string) => ({ cron: "* * * * *", scheduledTime: Date.parse(iso), noRetry() {} }) as ScheduledController;
  it("keep-warms every minute, sweeps on :00/:15/:30/:45, runs the daily jobs at 09:00 UTC", async () => {
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

  it("the daily cron runs it after retention and the minute debit; a retention failure does not skip billing", async () => {
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
