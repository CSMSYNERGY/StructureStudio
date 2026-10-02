// cron/usageCharge.ts: every call and text, one wallet line each, at Twilio's cost × the markup.
// The database half (migration 259's RPCs and tables) is stubbed on the fake network; Twilio's
// call, recording and message resources are served from small in-memory fixtures.
//
// ⚠️ PUBLIC REPO: every number, SID and id here is fake (555-01xx, zero-padded SIDs).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffMinutes, callBillability, chargeFor, DEFAULT_SETTINGS, displayNumber, runUsageCharges, settingsFrom, smsMemo,
  type ChargeRow,
} from "../src/cron/usageCharge";
import { fetchCallCost, listUsageDaily, priceMicros } from "../src/twilioRest";
import { adminClient } from "../src/db";
import { installDenoShim, type Env } from "../src/env";
import { BUSINESS_NUMBER, CLIENT, CUSTOMER, FakeNet, SUPABASE_URL, filter, jsonRes, makeEnv, type Seen } from "./helpers";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const CA = (n: number) => "CA" + String(n).padStart(32, "0");
const SM = (n: number) => "SM" + String(n).padStart(32, "0");
const RE = (n: number) => "RE" + String(n).padStart(32, "0");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const APP = "client:u_00000000000040008000000000000a1_g1";
const TEAMMATE = "client:u_00000000000040008000000000000b2_g1";
const OTHER = "tenant-b";
const PILOT = "tenant-pilot";

const ARMED_AT = "2026-10-01T00:00:00.000Z";
const SETTINGS = { markup: 2, armed_at: ARMED_AT };

// ── Fixtures ────────────────────────────────────────────────────────────────────────

interface Leg {
  sid: string;
  status: string;
  duration: number | null;
  price: string | null;
  parent?: string | null;
  direction: string;
  from: string;
  to: string;
}

function rawLeg(l: Leg) {
  return {
    sid: l.sid, status: l.status, duration: l.duration === null ? null : String(l.duration), price: l.price, price_unit: "USD",
    parent_call_sid: l.parent ?? null, direction: l.direction, from: l.from, to: l.to,
  };
}

function callRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, client_id: CLIENT, direction: "out", from_e164: BUSINESS_NUMBER, to_e164: CUSTOMER,
    twilio_call_sid: null, client_call_sid: null, transfer_state: null, status: "completed",
    started_at: ago(14), answered_at: ago(13), ended_at: ago(10), duration_s: 150, cost_cents: null, error_code: null,
    phone_voicemails: null, ...over,
  };
}

function smsRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, client_id: CLIENT, direction: "out", status: "delivered", from_number: BUSINESS_NUMBER, to_number: CUSTOMER,
    provider_sid: SM(1), num_segments: 2, created_at: ago(10), ...over,
  };
}

let nextId = 1;
function charge(source: "call" | "sms", sourceId: string, over: Partial<ChargeRow> = {}): ChargeRow {
  return {
    id: nextId++, source, source_id: sourceId, client_id: CLIENT, direction: "out", occurred_at: ago(14),
    state: "pending", attempts: 1, ...over,
  };
}

interface World {
  queue: ChargeRow[];
  calls?: Record<string, unknown>[];
  events?: { call_id: string; type: string; data: Record<string, unknown> | null }[];
  sms?: Record<string, unknown>[];
  settings?: Record<string, unknown> | null;
  legs?: Leg[];
  recordings?: { sid: string; duration: number; price: string | null }[];
  messages?: { sid: string; status: string; num_segments: number; price: string | null; direction?: string }[];
  meteredExempt?: string[];
  billingExempt?: string[];
  armed?: (clientId: string, meter: string) => boolean;
  wallets?: Record<string, unknown>[];
  debitFails?: boolean;
  replayed?: boolean;
  /** wallet_transactions lines already posted (an earlier attempt's debit whose reply was lost). */
  ledger?: LedgerFixture[];
  /** The debit RPC replays this ORIGINAL line, whatever the call passes (migration 259). */
  replayOf?: { tx_id: number; amount_exact_micros: number; cost_micros: number | null };
}

interface LedgerFixture {
  id: number;
  client_id?: string;
  idempotency_key: string;
  amount_exact_micros: number;
  cost_micros: number | null;
  state?: string;
  memo?: string | null;
  usage?: Record<string, unknown> | null;
}

const inFilter = (s: Seen, col: string): string[] | null => {
  const v = s.url.searchParams.get(col);
  if (!v) return null;
  const m = /^in\.\((.*)\)$/.exec(v);
  return m ? m[1].split(",").map((x) => x.replace(/^"|"$/g, "")) : null;
};

function world(w: World) {
  const net = new FakeNet().install();
  const queue = [...w.queue];
  net.rpc("usage_charges_enqueue", () => queue.length);
  net.rest("GET", "phone_billing_settings", () => (w.settings === null ? [] : [{ ...DEFAULT_ROW, ...(w.settings ?? SETTINGS) }]));
  net.rpc("usage_charges_claim", (s) => queue.splice(0, Number(s.json.p_limit)));
  net.rest("GET", "phone_calls", (s) => {
    const ids = inFilter(s, "id");
    return (w.calls ?? []).filter((c) => !ids || ids.includes(String(c.id)));
  });
  net.rest("GET", "phone_call_events", (s) => {
    const ids = inFilter(s, "call_id");
    return (w.events ?? []).filter((e) => !ids || ids.includes(e.call_id));
  });
  net.rest("GET", "sms_messages", (s) => {
    const ids = inFilter(s, "id");
    return (w.sms ?? []).filter((m) => !ids || ids.includes(String(m.id)));
  });
  net.rest("GET", "wallet_accounts", (s) => {
    const ids = inFilter(s, "client_id") ?? [];
    if ((s.url.searchParams.get("select") ?? "").includes("auto_topup")) return (w.wallets ?? []).filter((r) => ids.includes(String(r.client_id)));
    return ids.map((id) => ({ client_id: id, metered_exempt: (w.meteredExempt ?? []).includes(id) }));
  });
  net.rest("GET", "client_settings", (s) => (inFilter(s, "client_id") ?? []).map((id) => ({ client_id: id, billing_exempt: (w.billingExempt ?? []).includes(id) })));
  net.rpc("phone_usage_armed", (s) => (w.armed ? w.armed(s.json.p_client_id, s.json.p_meter) : true));
  net.rest("GET", "wallet_transactions", (s) => {
    const keys = inFilter(s, "idempotency_key") ?? [];
    const clients = inFilter(s, "client_id") ?? [];
    return (w.ledger ?? [])
      .map((l) => ({ client_id: CLIENT, state: "posted", memo: null, usage: null, ...l }))
      .filter((l) => keys.includes(l.idempotency_key) && clients.includes(l.client_id) && l.state !== "released");
  });
  let tx = 7000;
  net.rpc("wallet_usage_debit", (s) => (w.debitFails
    ? new Response(JSON.stringify({ code: "P0001", message: "boom" }), { status: 400, headers: { "content-type": "application/json" } })
    : w.replayOf
      ? [{ tx_id: w.replayOf.tx_id, amount_cents: -3, balance_after_cents: 1000, replayed: true, amount_exact_micros: w.replayOf.amount_exact_micros, cost_micros: w.replayOf.cost_micros }]
      : [{
        tx_id: ++tx, amount_cents: -1, balance_after_cents: 1000, replayed: w.replayed === true,
        amount_exact_micros: -Number(s.json.p_charge_micros), cost_micros: s.json.p_cost_micros,
      }]));
  net.rest("PATCH", "usage_charges", () => []);
  net.rest("PATCH", "phone_calls", () => []);
  net.rest("POST", "app_errors", () => []);
  net.on("POST", (u) => u.href === `${SUPABASE_URL}/functions/v1/wallet-autotopup`, () => jsonRes({ fired: true, ok: true }));

  // Twilio
  const legs = w.legs ?? [];
  net.on("GET", /\/Calls\/CA[0-9a-f]+\.json$/i, (s) => {
    const sid = /Calls\/(CA[0-9a-f]+)\.json$/i.exec(s.url.pathname)![1];
    const leg = legs.find((l) => l.sid === sid);
    return leg ? jsonRes(rawLeg(leg)) : jsonRes({ code: 20404 }, 404);
  });
  net.on("GET", /\/Calls\.json\?/, (s) => {
    const parent = s.url.searchParams.get("ParentCallSid");
    return jsonRes({ calls: legs.filter((l) => l.parent === parent).map(rawLeg) });
  });
  net.on("GET", /\/Recordings\/RE[0-9a-f]+\.json$/i, (s) => {
    const sid = /Recordings\/(RE[0-9a-f]+)\.json$/i.exec(s.url.pathname)![1];
    const r = (w.recordings ?? []).find((x) => x.sid === sid);
    return r ? jsonRes({ sid: r.sid, duration: String(r.duration), price: r.price }) : jsonRes({ code: 20404 }, 404);
  });
  net.on("GET", /\/Messages\/SM[0-9a-f]+\.json$/i, (s) => {
    const sid = /Messages\/(SM[0-9a-f]+)\.json$/i.exec(s.url.pathname)![1];
    const m = (w.messages ?? []).find((x) => x.sid === sid);
    return m ? jsonRes({ sid: m.sid, status: m.status, num_segments: String(m.num_segments), price: m.price, price_unit: "USD", direction: m.direction ?? "outbound-api" }) : jsonRes({ code: 20404 }, 404);
  });
  return net;
}

const DEFAULT_ROW = {
  markup: null, floor_cents: 500, carrier_fee_out_micros: 4500, carrier_fee_in_micros: 3500, fallback_out_min_micros: 14000,
  fallback_in_min_micros: 8500, fallback_client_min_micros: 4000, fallback_sms_seg_micros: 8300, fallback_after_hours: 6,
  ceiling_min_micros: null, ceiling_seg_micros: null, bill_unanswered_calls: false, armed_at: null,
};

const ON = makeEnv({ PHONE_USAGE_METERS: "on", PHONE_USAGE_COST_CAPTURE: "on" });

async function runIt(env: Env = ON, opts: { requestCap?: number } = {}) {
  installDenoShim(env);
  return runUsageCharges(env, adminClient(env), NOW, opts);
}

/** The final patch written for a usage_charges row. */
function rowPatch(net: FakeNet, id: number): Record<string, any> {
  const patches = net.writes("usage_charges", "PATCH").filter((s) => filter(s, "id") === String(id));
  expect(patches.length).toBe(1);
  expect(filter(patches[0], "state")).toBe("pending"); // never overwrites a final state
  return patches[0].json;
}
const debits = (net: FakeNet) => net.rpcCalls("wallet_usage_debit").map((s) => s.json);
/** Every outside request the run made is one it counted against the cap (app_errors aside: logging). */
const countedAll = (net: FakeNet, out: unknown) =>
  expect(net.seen.filter((s) => !s.url.pathname.endsWith("/app_errors")).length).toBe((out as { requests: number }).requests);
const twilioGets = (net: FakeNet) => net.to(/api\.twilio\.com/).map((s) => `${s.url.pathname.replace(/^.*\/Accounts\/AC0+/, "")}${s.url.search}`);

beforeEach(() => {
  nextId = 1;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

// ── Pure pieces ─────────────────────────────────────────────────────────────────────

describe("pricing arithmetic", () => {
  it("Twilio prices: negative decimal strings become positive micros, rounded half up; null stays null", () => {
    expect(priceMicros("-0.01400")).toBe(14000);
    expect(priceMicros("-0.0083")).toBe(8300);
    expect(priceMicros("0.0000005")).toBe(1); // half up, exactly (floating point would give 0)
    expect(priceMicros("-0.0000004")).toBe(0);
    expect(priceMicros("12.34")).toBe(12_340_000);
    expect(priceMicros("-1")).toBe(1_000_000);
    expect(priceMicros(null)).toBeNull();
    expect(priceMicros("")).toBeNull();
    expect(priceMicros("n/a")).toBeNull();
  });

  it("charge = round(cost × markup) half up; a ceiling caps it at ceiling × units", () => {
    expect(chargeFor(4150, 1.5, null, 1)).toBe(6225);
    expect(chargeFor(3333, 2.5, null, 1)).toBe(8333); // 8332.5 → up
    expect(chargeFor(1, 1.5, null, 1)).toBe(2); // 1.5 → up
    expect(chargeFor(46000, 2, null, 3)).toBe(92000);
    expect(chargeFor(46000, 2, 20000, 3)).toBe(60000); // ceiling 3 × 20,000
    expect(chargeFor(46000, 2, 40000, 3)).toBe(92000); // under the ceiling: untouched
    expect(chargeFor(1000, 1.333, null, 1)).toBe(1333);
    expect(chargeFor(0, 3, null, 1)).toBe(0);
  });

  it("backoff by attempts: 3, 10, 30, 60, 120, then 240 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMinutes)).toEqual([3, 10, 30, 60, 120, 240, 240, 240]);
  });

  it("line wording: (555) 123-4567 for +1, E.164 as-is otherwise, singular segment", () => {
    expect(displayNumber("+15551234567")).toBe("(555) 123-4567");
    expect(displayNumber("+447700900123")).toBe("+447700900123");
    expect(displayNumber("Anonymous")).toBe("Anonymous");
    expect(smsMemo("out", "+15551234567", 1)).toBe("Text to (555) 123-4567 · 1 segment");
    expect(smsMemo("in", "+15551234567", 3)).toBe("Text from (555) 123-4567 · 3 segments");
  });

  it("settings: defaults fill gaps, a markup outside 1–10 is no markup, numerics may be text", () => {
    expect(settingsFrom(null)).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom({ markup: "2.500", ceiling_min_micros: "30000", armed_at: ARMED_AT, bill_unanswered_calls: true })).toMatchObject({
      markup: 2.5, ceilingMinMicros: 30000, armedAt: ARMED_AT, billUnansweredCalls: true, floorCents: 500, fallbackAfterHours: 6,
    });
    expect(settingsFrom({ markup: 0.5 }).markup).toBeNull();
    expect(settingsFrom({ markup: 11 }).markup).toBeNull();
  });

  it("billable calls: talk or voicemail; never refused or zero-talk; unanswered only when the setting is on", () => {
    const s = DEFAULT_SETTINGS;
    const on = { ...s, billUnansweredCalls: true };
    expect(callBillability({ status: "completed", duration_s: 61, error_code: null }, null, s)).toMatchObject({ billable: true, units: 2 });
    expect(callBillability({ status: "completed", duration_s: 0, error_code: null }, null, s)).toMatchObject({ billable: false });
    expect(callBillability({ status: "completed", duration_s: null, error_code: null }, null, s)).toMatchObject({ billable: false });
    expect(callBillability({ status: "failed", duration_s: null, error_code: "wallet_empty" }, null, on)).toMatchObject({ billable: false });
    expect(callBillability({ status: "completed", duration_s: 90, error_code: "minute_cap" }, null, s)).toMatchObject({ billable: false });
    expect(callBillability({ status: "voicemail", duration_s: null, error_code: null }, 75, s)).toMatchObject({ billable: true, units: 2 });
    for (const status of ["missed", "no_answer", "busy", "failed"]) {
      expect(callBillability({ status, duration_s: null, error_code: null }, null, s)).toMatchObject({ billable: false });
      expect(callBillability({ status, duration_s: null, error_code: null }, null, on)).toMatchObject({ billable: true, units: 1 });
    }
  });
});

// ── Calls: collecting the legs ──────────────────────────────────────────────────────

describe("calls: every leg is found and priced", () => {
  const CALL = uuid(101);

  it("outbound: the app leg and its dialed child; charged at cost × markup, keyed usage:call:<id>", async () => {
    const row = charge("call", CALL);
    const net = world({
      queue: [row],
      calls: [callRow(CALL, { client_call_sid: CA(1), twilio_call_sid: CA(2) })],
      events: [{ call_id: CALL, type: "ended", data: { leg: "pstn", sid: CA(2) } }],
      legs: [
        { sid: CA(1), status: "completed", duration: 152, price: "-0.00400", direction: "inbound", from: APP, to: CUSTOMER },
        { sid: CA(2), parent: CA(1), status: "completed", duration: 150, price: "-0.04200", direction: "outbound-dial", from: BUSINESS_NUMBER, to: CUSTOMER },
      ],
    });
    const out = await runIt();
    expect(out).toMatchObject({ ran: true, enqueued: 1, claimed: 1, charged: 1, deferred: 0 });
    expect(debits(net)).toEqual([{
      p_client_id: CLIENT, p_meter_kind: "voice_minute", p_charge_micros: 92000, p_cost_micros: 46000,
      p_ref_type: "phone_call", p_ref_id: CALL, p_memo: "Outbound call to (555) 555-0142 · 3 min",
      p_usage: { units: 3, unit: "minute", direction: "out" }, p_idem: `usage:call:${CALL}`,
    }]);
    const p = rowPatch(net, row.id);
    expect(p).toMatchObject({
      state: "charged", wallet_tx_id: 7001, cost_micros: 46000, cost_source: "twilio", charge_micros: 92000, markup: 2,
      units: 3, unit: "minute", memo: "Outbound call to (555) 555-0142 · 3 min", lease_until: null, last_error: null,
    });
    expect(p.cost_detail.legs.map((l: { sid: string; kind: string; price_micros: number }) => [l.sid, l.kind, l.price_micros])).toEqual([
      [CA(1), "client", 4000], [CA(2), "pstn_out", 42000],
    ]);
    // The app leg first: its child came from listing, never a fetch of its own.
    expect(twilioGets(net)).toEqual([
      `/Calls/${CA(1)}.json`, `/Calls.json?ParentCallSid=${CA(1)}&PageSize=50`, `/Calls.json?ParentCallSid=${CA(2)}&PageSize=50`,
    ]);
    // phone_calls.cost_cents (server-only) = round(46,000 / 10,000).
    expect(net.writes("phone_calls", "PATCH").map((s) => s.json)).toEqual([{ cost_cents: 5 }]);
    // Shadow-free: the phone_usage_armed check was asked about this tenant and meter.
    expect(net.rpcCalls("phone_usage_armed").map((s) => s.json)).toEqual([{ p_client_id: CLIENT, p_meter: "voice_minute" }]);
    countedAll(net, out);
  });

  it("inbound, many legs rung: only the connected ones cost; unanswered legs with no price do not hold it up", async () => {
    const row = charge("call", CALL, { direction: "in" });
    const net = world({
      queue: [row],
      calls: [callRow(CALL, { direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER, twilio_call_sid: CA(10), client_call_sid: CA(11), duration_s: 180 })],
      events: [11, 12, 13].map((n) => ({ call_id: CALL, type: "ringing", data: { leg: "client", sid: CA(n) } })),
      legs: [
        { sid: CA(10), status: "completed", duration: 200, price: "-0.01700", direction: "inbound", from: CUSTOMER, to: BUSINESS_NUMBER },
        { sid: CA(11), parent: CA(10), status: "completed", duration: 180, price: "-0.00400", direction: "outbound-dial", from: CUSTOMER, to: APP },
        { sid: CA(12), parent: CA(10), status: "canceled", duration: 0, price: null, direction: "outbound-dial", from: CUSTOMER, to: TEAMMATE },
        { sid: CA(13), parent: CA(10), status: "no-answer", duration: 0, price: null, direction: "outbound-dial", from: CUSTOMER, to: TEAMMATE },
        { sid: CA(14), parent: CA(10), status: "canceled", duration: 0, price: null, direction: "outbound-dial", from: BUSINESS_NUMBER, to: "+15555550177" },
      ],
    });
    const out = await runIt();
    expect(out).toMatchObject({ charged: 1, pending: 0 });
    expect(debits(net)[0]).toMatchObject({
      p_meter_kind: "voice_minute_in", p_cost_micros: 21000, p_charge_micros: 42000, p_memo: "Incoming call from (555) 555-0142 · 3 min",
      p_usage: { units: 3, unit: "minute", direction: "in" },
    });
    const legs = rowPatch(net, row.id).cost_detail.legs;
    expect(legs).toHaveLength(5);
    expect(legs.find((l: { sid: string }) => l.sid === CA(12)).price_micros).toBe(0);
    // One fetch (the customer's leg), one child list, and one for the cell leg (it is a number);
    // the app legs being rung are never asked for children.
    expect(twilioGets(net)).toEqual([
      `/Calls/${CA(10)}.json`, `/Calls.json?ParentCallSid=${CA(10)}&PageSize=50`, `/Calls.json?ParentCallSid=${CA(14)}&PageSize=50`,
    ]);
  });

  it("cold transfer of an outbound call: the teammate leg is a GRANDCHILD of the app leg, found by listing two levels down", async () => {
    const row = charge("call", CALL);
    const net = world({
      queue: [row],
      calls: [callRow(CALL, { client_call_sid: CA(20), twilio_call_sid: CA(21), duration_s: 90 })],
      events: [{ call_id: CALL, type: "transfer", data: { from: "x", to: "y" } }],
      legs: [
        { sid: CA(20), status: "completed", duration: 30, price: "-0.00100", direction: "inbound", from: APP, to: CUSTOMER },
        { sid: CA(21), parent: CA(20), status: "completed", duration: 90, price: "-0.02800", direction: "outbound-dial", from: BUSINESS_NUMBER, to: CUSTOMER },
        { sid: CA(22), parent: CA(21), status: "completed", duration: 60, price: "-0.00200", direction: "outbound-dial", from: BUSINESS_NUMBER, to: TEAMMATE },
      ],
    });
    await runIt();
    expect(debits(net)[0]).toMatchObject({ p_cost_micros: 31000, p_charge_micros: 62000 });
    expect(rowPatch(net, row.id).cost_detail.legs.map((l: { sid: string }) => l.sid)).toEqual([CA(20), CA(21), CA(22)]);
  });

  it("cold transfer after the teammate answered (client_call_sid moved on): the original app leg is found by walking UP", async () => {
    const row = charge("call", CALL);
    const net = world({
      queue: [row],
      calls: [callRow(CALL, { client_call_sid: CA(22), twilio_call_sid: CA(21), duration_s: 90 })],
      events: [{ call_id: CALL, type: "ended", data: { leg: "pstn", sid: CA(21) } }],
      legs: [
        { sid: CA(20), status: "completed", duration: 30, price: "-0.00100", direction: "inbound", from: APP, to: CUSTOMER },
        { sid: CA(21), parent: CA(20), status: "completed", duration: 90, price: "-0.02800", direction: "outbound-dial", from: BUSINESS_NUMBER, to: CUSTOMER },
        { sid: CA(22), parent: CA(21), status: "completed", duration: 60, price: "-0.00200", direction: "outbound-dial", from: BUSINESS_NUMBER, to: TEAMMATE },
      ],
    });
    await runIt();
    expect(debits(net)[0]).toMatchObject({ p_cost_micros: 31000 });
    expect(new Set(rowPatch(net, row.id).cost_detail.legs.map((l: { sid: string }) => l.sid))).toEqual(new Set([CA(20), CA(21), CA(22)]));
  });

  it("warm transfer: the teammate's leg comes from the events (it has no parent), plus the conference estimate ('mixed'); app marks are ignored", async () => {
    const row = charge("call", CALL, { direction: "in" });
    const net = world({
      queue: [row],
      calls: [callRow(CALL, { direction: "in", from_e164: CUSTOMER, twilio_call_sid: CA(30), client_call_sid: CA(31), duration_s: 280, transfer_state: null })],
      events: [
        { call_id: CALL, type: "hold", data: { user: "u", moved: true } },
        { call_id: CALL, type: "warm_transfer", data: { from: "u", to: "v", sid: CA(32), moved: false } },
        { call_id: CALL, type: "answered", data: { leg: "warm", sid: CA(32) } },
        // The apps post marks into the same table; never trusted for a SID.
        { call_id: CALL, type: "warm_transfer", data: { sid: CA(99), source: "app" } },
      ],
      legs: [
        { sid: CA(30), status: "completed", duration: 300, price: "-0.04250", direction: "inbound", from: CUSTOMER, to: BUSINESS_NUMBER },
        { sid: CA(31), parent: CA(30), status: "completed", duration: 280, price: "-0.02000", direction: "outbound-dial", from: CUSTOMER, to: APP },
        { sid: CA(32), status: "completed", duration: 120, price: "-0.00800", direction: "outbound-api", from: BUSINESS_NUMBER, to: TEAMMATE },
        { sid: CA(99), status: "completed", duration: 999, price: "-9.00000", direction: "outbound-api", from: BUSINESS_NUMBER, to: TEAMMATE },
      ],
    });
    const out = await runIt();
    countedAll(net, out);
    // Legs 42,500 + 20,000 + 8,000; conference (5 + 5 + 2 minutes) × 1,800 = 21,600.
    expect(debits(net)[0]).toMatchObject({ p_cost_micros: 92100, p_charge_micros: 184200 });
    const p = rowPatch(net, row.id);
    expect(p.cost_source).toBe("mixed");
    expect(p.cost_detail.conference).toEqual({ participant_legs: 3, micros: 21600, estimated: true });
    expect(twilioGets(net).some((u) => u.includes(CA(99)))).toBe(false);
    // The REST-created teammate leg is never asked for children.
    expect(twilioGets(net)).not.toContain(`/Calls.json?ParentCallSid=${CA(32)}&PageSize=50`);
  });

  it("voicemail: the recording's own price is added; the line says so", async () => {
    const row = charge("call", CALL, { direction: "in" });
    const net = world({
      queue: [row],
      calls: [callRow(CALL, {
        direction: "in", from_e164: CUSTOMER, status: "voicemail", answered_at: null, duration_s: null, twilio_call_sid: CA(40),
        phone_voicemails: { recording_sid: RE(1), duration_s: 25 },
      })],
      legs: [
        { sid: CA(40), status: "completed", duration: 45, price: "-0.00850", direction: "inbound", from: CUSTOMER, to: BUSINESS_NUMBER },
        { sid: CA(41), parent: CA(40), status: "no-answer", duration: 0, price: null, direction: "outbound-dial", from: CUSTOMER, to: APP },
      ],
      recordings: [{ sid: RE(1), duration: 25, price: "-0.00250" }],
    });
    countedAll(net, await runIt());
    expect(debits(net)[0]).toMatchObject({
      p_meter_kind: "voice_minute_in", p_cost_micros: 11000, p_charge_micros: 22000, p_memo: "Missed call from (555) 555-0142 · voicemail 1 min",
      p_usage: { units: 1, unit: "minute", direction: "in" },
    });
    expect(rowPatch(net, row.id).cost_detail.recording).toEqual({ sid: RE(1), duration_s: 25, price_micros: 2500 });
  });

  // A device switch (src/handoff.ts) on a PLAIN call. By the time a call is charged its
  // transfer_state is NULL again (/voice/status clears it when the customer's leg ends), so the
  // conference estimate cannot come from the row. A lost or unverified conference-start callback
  // leaves no conference_started either: the Worker's own device_switch 'done' is what says the
  // call ran in its conference, as 'hold' and 'warm_transfer' do for theirs.
  it("a call moved to the phone: the REST ring leg and the old leg priced, an earlier unanswered ring costs 0 and holds nothing up, and the move brings the conference estimate", async () => {
    const row = charge("call", CALL, { direction: "in" });
    const net = world({
      queue: [row],
      calls: [callRow(CALL, {
        direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER, twilio_call_sid: CA(50), client_call_sid: CA(52),
        duration_s: 280, transfer_state: null,
      })],
      events: [
        { call_id: CALL, type: "answered", data: { leg: "client", status: "in-progress", sid: CA(51) } },
        { call_id: CALL, type: "device_switch", data: { phase: "offered", to: "mobile", held: false, user: "u" } },
        { call_id: CALL, type: "ended", data: { leg: "handoff", status: "no-answer", sid: CA(53) } },
        { call_id: CALL, type: "device_switch", data: { phase: "missed", to: "mobile", sid: CA(53), status: "no-answer" } },
        { call_id: CALL, type: "device_switch", data: { phase: "offered", to: "mobile", held: false, user: "u" } },
        { call_id: CALL, type: "device_switch", data: { phase: "done", to: "mobile", from_sid: CA(51), sid: CA(52), ms: 2100 } },
        { call_id: CALL, type: "ended", data: { leg: "client", status: "completed", sid: CA(51) } },
      ],
      legs: [
        { sid: CA(50), status: "completed", duration: 300, price: "-0.04250", direction: "inbound", from: CUSTOMER, to: BUSINESS_NUMBER },
        { sid: CA(51), parent: CA(50), status: "completed", duration: 120, price: "-0.00400", direction: "outbound-dial", from: CUSTOMER, to: APP },
        // The rings the Worker placed over REST to the person's own identity: no parent.
        { sid: CA(52), status: "completed", duration: 170, price: "-0.01200", direction: "outbound-api", from: BUSINESS_NUMBER, to: APP },
        { sid: CA(53), status: "no-answer", duration: 0, price: null, direction: "outbound-api", from: BUSINESS_NUMBER, to: APP },
      ],
    });
    const out = await runIt();
    countedAll(net, out);
    expect(out).toMatchObject({ charged: 1, pending: 0 });
    // Legs 42,500 + 4,000 + 12,000 + 0; conference (5 + 2 + 3 minutes) × 1,800 = 18,000.
    expect(debits(net)[0]).toMatchObject({
      p_meter_kind: "voice_minute_in", p_cost_micros: 76500, p_charge_micros: 153000, p_memo: "Incoming call from (555) 555-0142 · 5 min",
    });
    const p = rowPatch(net, row.id);
    expect(p.cost_source).toBe("mixed");
    expect(p.cost_detail.conference).toEqual({ participant_legs: 3, micros: 18000, estimated: true });
    expect(p.cost_detail.legs.map((l: { sid: string; kind: string; price_micros: number }) => [l.sid, l.kind, l.price_micros])).toEqual([
      [CA(50), "pstn_in", 42500], [CA(51), "client", 4000], [CA(52), "client", 12000], [CA(53), "client", 0],
    ]);
    // REST-created legs never ran a <Dial>: never asked for children.
    expect(twilioGets(net).filter((u) => u.includes("ParentCallSid") && (u.includes(CA(52)) || u.includes(CA(53))))).toEqual([]);
  });

  it("an outbound call moved to the computer: the device.connect leg comes from the move's event, the old app leg by walking up, and the move brings the conference estimate", async () => {
    const row = charge("call", CALL);
    const net = world({
      queue: [row],
      calls: [callRow(CALL, { client_call_sid: CA(72), twilio_call_sid: CA(71), duration_s: 200, transfer_state: null })],
      events: [
        { call_id: CALL, type: "device_switch", data: { phase: "offered", to: "chrome", held: false, user: "u" } },
        { call_id: CALL, type: "device_switch", data: { phase: "done", to: "chrome", from_sid: CA(70), sid: CA(72), ms: 1800 } },
      ],
      legs: [
        { sid: CA(70), status: "completed", duration: 90, price: "-0.00400", direction: "inbound", from: APP, to: CUSTOMER },
        { sid: CA(71), parent: CA(70), status: "completed", duration: 200, price: "-0.05600", direction: "outbound-dial", from: BUSINESS_NUMBER, to: CUSTOMER },
        { sid: CA(72), status: "completed", duration: 130, price: "-0.01200", direction: "inbound", from: APP, to: "" },
      ],
    });
    const out = await runIt();
    countedAll(net, out);
    // Legs 4,000 + 56,000 + 12,000; conference (2 + 4 + 3 minutes) × 1,800 = 16,200.
    expect(debits(net)[0]).toMatchObject({ p_meter_kind: "voice_minute", p_cost_micros: 88200, p_charge_micros: 176400 });
    const p = rowPatch(net, row.id);
    expect(new Set(p.cost_detail.legs.map((l: { sid: string }) => l.sid))).toEqual(new Set([CA(70), CA(71), CA(72)]));
    expect(p.cost_detail.conference).toEqual({ participant_legs: 3, micros: 16200, estimated: true });
  });

  it("a move that only rang (missed, canceled) or failed is no conference by itself", async () => {
    const row = charge("call", CALL, { direction: "in" });
    const net = world({
      queue: [row],
      calls: [callRow(CALL, { direction: "in", from_e164: CUSTOMER, twilio_call_sid: CA(80), client_call_sid: CA(81), duration_s: 60 })],
      events: [
        { call_id: CALL, type: "device_switch", data: { phase: "missed", to: "mobile", sid: CA(82), status: "no-answer" } },
        { call_id: CALL, type: "device_switch", data: { phase: "canceled", to: "chrome", sid: null, reason: "declined" } },
        { call_id: CALL, type: "device_switch", data: { phase: "failed", to: "mobile", reason: "ring_failed" } },
        // An app's own mark is never trusted, whatever it says.
        { call_id: CALL, type: "device_switch", data: { phase: "done", sid: CA(83), source: "app" } },
      ],
      legs: [
        { sid: CA(80), status: "completed", duration: 60, price: "-0.00850", direction: "inbound", from: CUSTOMER, to: BUSINESS_NUMBER },
        { sid: CA(81), parent: CA(80), status: "completed", duration: 55, price: "-0.00400", direction: "outbound-dial", from: CUSTOMER, to: APP },
        { sid: CA(82), status: "canceled", duration: 0, price: null, direction: "outbound-api", from: BUSINESS_NUMBER, to: APP },
      ],
    });
    await runIt();
    expect(debits(net)[0]).toMatchObject({ p_cost_micros: 12500 });
    const p = rowPatch(net, row.id);
    expect(p.cost_source).toBe("twilio");
    expect(p.cost_detail.conference).toBeUndefined();
    expect(twilioGets(net).some((u) => u.includes(CA(83)))).toBe(false);
  });
});

// ── Calls: not priced yet ───────────────────────────────────────────────────────────

describe("a price Twilio has not filled in yet", () => {
  const CALL = uuid(201);
  const legs = (price: string | null): Leg[] => [
    { sid: CA(1), status: "completed", duration: 62, price: "-0.00100", direction: "inbound", from: APP, to: CUSTOMER },
    { sid: CA(2), parent: CA(1), status: "completed", duration: 60, price, direction: "outbound-dial", from: BUSINESS_NUMBER, to: CUSTOMER },
  ];

  it.each([
    [1, 3], [2, 10], [3, 30], [4, 60], [5, 120], [6, 240], [9, 240],
  ])("attempt %i: stays pending, next try in %i minutes, nothing charged", async (attempts, minutes) => {
    const row = charge("call", CALL, { attempts });
    const net = world({ queue: [row], calls: [callRow(CALL, { client_call_sid: CA(1), twilio_call_sid: CA(2), ended_at: ago(30), duration_s: 60 })], legs: legs(null) });
    const out = await runIt();
    expect(out).toMatchObject({ pending: 1, charged: 0 });
    const p = rowPatch(net, row.id);
    expect(p.state).toBeUndefined();
    expect(p.next_try_at).toBe(new Date(NOW.getTime() + minutes * 60_000).toISOString());
    expect(p.last_error).toContain("not priced yet");
    expect(debits(net)).toEqual([]);
    expect(net.writes("phone_calls", "PATCH")).toEqual([]);
  });

  it("after fallback_after_hours: the missing leg is estimated at the fallback rate, cost_source 'estimate'", async () => {
    const row = charge("call", CALL, { attempts: 7, occurred_at: ago(7 * 60 + 5) });
    const net = world({ queue: [row], calls: [callRow(CALL, { client_call_sid: CA(1), twilio_call_sid: CA(2), started_at: ago(7 * 60 + 5), ended_at: ago(7 * 60), duration_s: 60 })], legs: legs(null) });
    await runIt();
    // App leg 1,000 (priced) + 1 minute × fallback_out_min_micros 14,000.
    expect(debits(net)[0]).toMatchObject({ p_cost_micros: 15000, p_charge_micros: 30000 });
    const p = rowPatch(net, row.id);
    expect(p).toMatchObject({ state: "charged", cost_source: "estimate" });
    expect(p.cost_detail.legs[1]).toMatchObject({ sid: CA(2), price_micros: 14000, estimated: true });
  });

  it("the fallback hours come from the settings", async () => {
    const row = charge("call", CALL, { attempts: 3 });
    const net = world({
      queue: [row], settings: { ...SETTINGS, fallback_after_hours: 0, fallback_out_min_micros: 20000 },
      calls: [callRow(CALL, { client_call_sid: CA(1), twilio_call_sid: CA(2), ended_at: ago(30), duration_s: 60 })], legs: legs(null),
    });
    await runIt();
    expect(debits(net)[0]).toMatchObject({ p_cost_micros: 21000 });
  });

  it("Twilio failing is a retry too, and after the fallback hours the whole call is estimated from its row", async () => {
    const row = charge("call", CALL, { attempts: 2 });
    const net = world({ queue: [row], calls: [callRow(CALL, { client_call_sid: CA(1), twilio_call_sid: CA(2), ended_at: ago(30), duration_s: 60 })] });
    net.on("GET", /\/Calls\/CA/, () => jsonRes({ code: 20500 }, 500));
    await runIt();
    expect(rowPatch(net, row.id)).toMatchObject({ last_error: "Twilio fetch call failed (HTTP 500, code 20500)" });
    expect(debits(net)).toEqual([]);

    const late = charge("call", CALL, { attempts: 8 });
    const net2 = world({ queue: [late], calls: [callRow(CALL, { client_call_sid: CA(1), twilio_call_sid: CA(2), ended_at: ago(8 * 60), duration_s: 60 })] });
    net2.on("GET", /\/Calls\/CA/, () => jsonRes({ code: 20500 }, 500));
    await runIt();
    // 1 minute × (out 14,000 + client 4,000).
    expect(debits(net2)[0]).toMatchObject({ p_cost_micros: 18000 });
    expect(rowPatch(net2, late.id)).toMatchObject({ state: "charged", cost_source: "estimate" });
  });

  it("a call that ended moments ago is left to settle (a missed call can still become a voicemail), with no Twilio request", async () => {
    const row = charge("call", CALL);
    const net = world({ queue: [row], calls: [callRow(CALL, { client_call_sid: CA(1), ended_at: ago(0.5) })], legs: legs("-0.01") });
    await runIt();
    expect(rowPatch(net, row.id)).toEqual(expect.objectContaining({ next_try_at: new Date(Date.parse(ago(0.5)) + 120_000).toISOString() }));
    expect(twilioGets(net)).toEqual([]);
  });

  it("a MISSED call waits out a whole recording sweep (20 minutes): a voicemail the sweep files late must still be billed", async () => {
    const missed = { direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER, status: "missed", answered_at: null, duration_s: null, twilio_call_sid: CA(1) };
    const row = charge("call", CALL, { direction: "in" });
    const net = world({ queue: [row], calls: [callRow(CALL, { ...missed, ended_at: ago(5) })], legs: legs("-0.01") });
    await runIt();
    expect(rowPatch(net, row.id)).toEqual(expect.objectContaining({ next_try_at: new Date(Date.parse(ago(5)) + 20 * 60_000).toISOString() }));
    expect(rowPatch(net, row.id).state).toBeUndefined();
    expect(twilioGets(net)).toEqual([]);

    // The sweep filed it in the meantime: billed as the voicemail it is.
    const filed = charge("call", CALL, { direction: "in", attempts: 2 });
    const net2 = world({
      queue: [filed],
      calls: [callRow(CALL, { ...missed, status: "voicemail", ended_at: ago(21), phone_voicemails: { recording_sid: RE(1), duration_s: 25 } })],
      legs: [{ sid: CA(1), status: "completed", duration: 45, price: "-0.00850", direction: "inbound", from: CUSTOMER, to: BUSINESS_NUMBER }],
      recordings: [{ sid: RE(1), duration: 25, price: "-0.00250" }],
    });
    await runIt();
    expect(debits(net2)[0]).toMatchObject({ p_memo: "Missed call from (555) 555-0142 · voicemail 1 min", p_cost_micros: 11000 });

    // Still missed after the window: settled as before (not billable with the setting off).
    const later = charge("call", CALL, { direction: "in", attempts: 2 });
    const net3 = world({ queue: [later], calls: [callRow(CALL, { ...missed, ended_at: ago(21) })], legs: legs("-0.01") });
    await runIt();
    expect(rowPatch(net3, later.id)).toMatchObject({ state: "not_billable" });
  });
});

// ── Not billable ────────────────────────────────────────────────────────────────────

describe("not billable: the cost is recorded, nothing is charged", () => {
  const CALL = uuid(301);
  const appLeg: Leg = { sid: CA(1), status: "completed", duration: 3, price: "-0.00050", direction: "inbound", from: APP, to: CUSTOMER };

  it("a call refused before it was placed (error_code), even with unanswered billing on", async () => {
    const row = charge("call", CALL);
    const net = world({
      queue: [row], settings: { ...SETTINGS, bill_unanswered_calls: true },
      calls: [callRow(CALL, { status: "failed", error_code: "wallet_empty", answered_at: null, duration_s: null, client_call_sid: CA(1) })],
      legs: [appLeg],
    });
    expect(await runIt()).toMatchObject({ not_billable: 1, charged: 0 });
    expect(rowPatch(net, row.id)).toMatchObject({ state: "not_billable", cost_micros: 500, charge_micros: null, markup: null });
    expect(debits(net)).toEqual([]);
    expect(net.rpcCalls("phone_usage_armed")).toEqual([]);
  });

  it("an answered call with zero talk time", async () => {
    const row = charge("call", CALL);
    const net = world({ queue: [row], calls: [callRow(CALL, { duration_s: 0, client_call_sid: CA(1) })], legs: [appLeg] });
    await runIt();
    expect(rowPatch(net, row.id)).toMatchObject({ state: "not_billable" });
    expect(debits(net)).toEqual([]);
  });

  it("but a completed call whose 'answered' write was lost (answered_at empty) IS billed for its talk time", async () => {
    // The 'completed' callback's filter takes a 'ringing' row, so it lands without answered_at;
    // Twilio's completed means the leg connected, and Twilio billed it.
    const row = charge("call", CALL);
    const net = world({ queue: [row], calls: [callRow(CALL, { answered_at: null, duration_s: 240, client_call_sid: CA(1) })], legs: [appLeg] });
    expect(await runIt()).toMatchObject({ charged: 1, not_billable: 0 });
    expect(debits(net)[0]).toMatchObject({ p_memo: "Outbound call to (555) 555-0142 · 4 min", p_usage: { units: 4, unit: "minute", direction: "out" } });
  });

  it("a missed / unanswered call while bill_unanswered_calls is off; billed when it is on", async () => {
    const legsNA: Leg[] = [appLeg, { sid: CA(2), parent: CA(1), status: "no-answer", duration: 0, price: null, direction: "outbound-dial", from: BUSINESS_NUMBER, to: CUSTOMER }];
    const a = charge("call", CALL);
    const net = world({ queue: [a], calls: [callRow(CALL, { status: "no_answer", answered_at: null, duration_s: null, client_call_sid: CA(1) })], legs: legsNA });
    await runIt();
    expect(rowPatch(net, a.id)).toMatchObject({ state: "not_billable", cost_micros: 500 });

    const b = charge("call", CALL);
    const net2 = world({
      queue: [b], settings: { ...SETTINGS, bill_unanswered_calls: true },
      calls: [callRow(CALL, { status: "no_answer", answered_at: null, duration_s: null, client_call_sid: CA(1) })], legs: legsNA,
    });
    await runIt();
    expect(debits(net2)[0]).toMatchObject({ p_cost_micros: 500, p_charge_micros: 1000, p_memo: "Outbound call to (555) 555-0142 · 1 min" });
  });

  it.each([["failed"], ["undelivered"]])("a %s text (Twilio's status wins over a stale 'sent' on our row)", async (status) => {
    const id = uuid(302);
    const row = charge("sms", id);
    const net = world({ queue: [row], sms: [smsRow(id, { status: "sent" })], messages: [{ sid: SM(1), status, num_segments: 1, price: null }] });
    await runIt();
    expect(rowPatch(net, row.id)).toMatchObject({ state: "not_billable", cost_micros: 0 });
    expect(debits(net)).toEqual([]);
  });
});

// ── Texts ───────────────────────────────────────────────────────────────────────────

describe("texts", () => {
  it("out: message price + the carrier-fee estimate per segment; in: the inbound fee", async () => {
    const out = uuid(401);
    const inn = uuid(402);
    const r1 = charge("sms", out);
    const r2 = charge("sms", inn, { direction: "in" });
    const net = world({
      queue: [r1, r2],
      sms: [smsRow(out), smsRow(inn, { direction: "in", status: "received", from_number: CUSTOMER, to_number: BUSINESS_NUMBER, provider_sid: SM(2), num_segments: 1 })],
      messages: [
        { sid: SM(1), status: "delivered", num_segments: 2, price: "-0.01660" },
        { sid: SM(2), status: "received", num_segments: 1, price: "-0.00790", direction: "inbound" },
      ],
    });
    expect(await runIt()).toMatchObject({ charged: 2 });
    expect(debits(net)).toEqual([
      {
        p_client_id: CLIENT, p_meter_kind: "sms_segment", p_charge_micros: 51200, p_cost_micros: 25600, p_ref_type: "sms_message", p_ref_id: out,
        p_memo: "Text to (555) 555-0142 · 2 segments", p_usage: { units: 2, unit: "segment", direction: "out" }, p_idem: `usage:sms:${out}`,
      },
      {
        p_client_id: CLIENT, p_meter_kind: "sms_in", p_charge_micros: 22800, p_cost_micros: 11400, p_ref_type: "sms_message", p_ref_id: inn,
        p_memo: "Text from (555) 555-0142 · 1 segment", p_usage: { units: 1, unit: "segment", direction: "in" }, p_idem: `usage:sms:${inn}`,
      },
    ]);
    expect(rowPatch(net, r1.id).cost_detail).toMatchObject({ segments: 2, price_micros: 16600, carrier_fee_micros: 9000 });
    expect(net.writes("phone_calls", "PATCH")).toEqual([]);
  });

  it("a segment ceiling caps the charge", async () => {
    const id = uuid(403);
    const row = charge("sms", id);
    const net = world({ queue: [row], settings: { ...SETTINGS, ceiling_seg_micros: 20000 }, sms: [smsRow(id)], messages: [{ sid: SM(1), status: "delivered", num_segments: 2, price: "-0.01660" }] });
    await runIt();
    expect(debits(net)[0]).toMatchObject({ p_cost_micros: 25600, p_charge_micros: 40000 });
  });

  it("no price yet: retried; after the fallback hours, fallback_sms_seg_micros per segment", async () => {
    const id = uuid(404);
    const row = charge("sms", id, { attempts: 1 });
    const net = world({ queue: [row], sms: [smsRow(id)], messages: [{ sid: SM(1), status: "delivered", num_segments: 2, price: null }] });
    await runIt();
    expect(rowPatch(net, row.id)).toMatchObject({ next_try_at: new Date(NOW.getTime() + 3 * 60_000).toISOString() });
    expect(debits(net)).toEqual([]);

    const late = charge("sms", id, { attempts: 7 });
    const net2 = world({ queue: [late], sms: [smsRow(id, { created_at: ago(6 * 60 + 1) })], messages: [{ sid: SM(1), status: "delivered", num_segments: 2, price: null }] });
    await runIt();
    // 2 × 8,300 + 2 × 4,500 carrier fee.
    expect(debits(net2)[0]).toMatchObject({ p_cost_micros: 25600 });
    expect(rowPatch(net2, late.id)).toMatchObject({ state: "charged", cost_source: "estimate" });
  });

  it("a text Twilio is still sending waits", async () => {
    const id = uuid(405);
    const row = charge("sms", id, { attempts: 2 });
    const net = world({ queue: [row], sms: [smsRow(id, { status: "sent" })], messages: [{ sid: SM(1), status: "sending", num_segments: 1, price: null }] });
    await runIt();
    expect(rowPatch(net, row.id)).toMatchObject({ last_error: "the text is still being sent", next_try_at: new Date(NOW.getTime() + 10 * 60_000).toISOString() });
  });
});

// ── Shadow, pilot, exempt ───────────────────────────────────────────────────────────

describe("shadow (cost capture), pilot and exempt", () => {
  const SMS_ID = uuid(501);
  const basic = (over: Partial<World> = {}, rowOver: Partial<ChargeRow> = {}) => {
    const row = charge("sms", SMS_ID, rowOver);
    const net = world({ queue: [row], sms: [smsRow(SMS_ID)], messages: [{ sid: SM(1), status: "delivered", num_segments: 2, price: "-0.01660" }], ...over });
    return { row, net };
  };

  it("PHONE_USAGE_METERS off (how it ships), cost capture on by default: shadow with the would-be charge, nothing charged", async () => {
    const { row, net } = basic();
    const out = await runIt(makeEnv({ PHONE_USAGE_METERS: "off", PHONE_USAGE_COST_CAPTURE: undefined }));
    expect(out).toMatchObject({ ran: true, shadow: 1, charged: 0 });
    expect(rowPatch(net, row.id)).toMatchObject({ state: "shadow", cost_micros: 25600, cost_source: "twilio", charge_micros: 51200, markup: 2 });
    expect(debits(net)).toEqual([]);
    expect(net.rpcCalls("phone_usage_armed")).toEqual([]);
  });

  it("no markup set yet: shadow with charge null", async () => {
    const { row, net } = basic({ settings: { markup: null, armed_at: null } });
    await runIt();
    expect(rowPatch(net, row.id)).toMatchObject({ state: "shadow", cost_micros: 25600, charge_micros: null, markup: null });
    expect(debits(net)).toEqual([]);
  });

  it("no settings row at all: shadow, charge null", async () => {
    const { row, net } = basic({ settings: null });
    await runIt();
    expect(rowPatch(net, row.id)).toMatchObject({ state: "shadow", charge_micros: null });
  });

  it("the meter not armed for this tenant (phone_usage_armed false): shadow", async () => {
    const { row, net } = basic({ armed: () => false });
    await runIt();
    expect(rowPatch(net, row.id)).toMatchObject({ state: "shadow", charge_micros: 51200 });
    expect(net.rpcCalls("phone_usage_armed").map((s) => s.json)).toEqual([{ p_client_id: CLIENT, p_meter: "sms_segment" }]);
    expect(debits(net)).toEqual([]);
  });

  it("before armed_at: shadow, without even asking whether the meter is armed", async () => {
    const { row, net } = basic({}, { occurred_at: "2026-09-30T23:59:59.000Z" });
    await runIt();
    expect(rowPatch(net, row.id)).toMatchObject({ state: "shadow" });
    expect(net.rpcCalls("phone_usage_armed")).toEqual([]);
  });

  it("pilot: the database arms only the pilot tenant; the other is shadow, and each pair is asked once per run", async () => {
    const ids = [uuid(511), uuid(512), uuid(513)];
    const rows = [charge("sms", ids[0], { client_id: PILOT }), charge("sms", ids[1], { client_id: OTHER }), charge("sms", ids[2], { client_id: PILOT })];
    const net = world({
      queue: rows,
      sms: [smsRow(ids[0], { client_id: PILOT }), smsRow(ids[1], { client_id: OTHER }), smsRow(ids[2], { client_id: PILOT })],
      messages: [{ sid: SM(1), status: "delivered", num_segments: 2, price: "-0.01660" }],
      armed: (c) => c === PILOT,
    });
    expect(await runIt()).toMatchObject({ charged: 2, shadow: 1 });
    expect(debits(net).map((d) => d.p_client_id)).toEqual([PILOT, PILOT]);
    expect(rowPatch(net, rows[1].id).state).toBe("shadow");
    expect(net.rpcCalls("phone_usage_armed").map((s) => s.json.p_client_id)).toEqual([PILOT, OTHER]);
  });

  it.each([
    ["metered_exempt", { meteredExempt: [CLIENT] }],
    ["billing_exempt (non-billable account)", { billingExempt: [CLIENT] }],
  ])("exempt (%s): cost and would-be charge recorded, no wallet line", async (_l, over) => {
    const { row, net } = basic(over as Partial<World>);
    expect(await runIt()).toMatchObject({ exempt: 1, charged: 0 });
    expect(rowPatch(net, row.id)).toMatchObject({ state: "exempt", cost_micros: 25600, charge_micros: 51200, markup: 2 });
    expect(debits(net)).toEqual([]);
  });

  it("cost capture off AND meters off: does nothing, reads nothing", async () => {
    const net = new FakeNet().install();
    expect(await runIt(makeEnv({ PHONE_USAGE_METERS: "off", PHONE_USAGE_COST_CAPTURE: "off" }))).toEqual({ ran: false, reason: "switched_off" });
    expect(net.seen).toEqual([]);
  });

  it("meters on with cost capture off still charges (cost-plus needs the cost)", async () => {
    const { net } = basic();
    expect(await runIt(makeEnv({ PHONE_USAGE_METERS: "on", PHONE_USAGE_COST_CAPTURE: "off" }))).toMatchObject({ charged: 1 });
    expect(debits(net)).toHaveLength(1);
  });
});

// ── Idempotency and failures ────────────────────────────────────────────────────────

describe("idempotency and failures", () => {
  const SMS_ID = uuid(601);

  it("the debit is keyed usage:sms:<id>, so a rerun replays (the RPC's replay answer is taken as charged)", async () => {
    for (const replayed of [false, true]) {
      const row = charge("sms", SMS_ID);
      const net = world({ queue: [row], sms: [smsRow(SMS_ID)], messages: [{ sid: SM(1), status: "delivered", num_segments: 2, price: "-0.01660" }], replayed });
      await runIt();
      expect(debits(net).map((d) => d.p_idem)).toEqual([`usage:sms:${SMS_ID}`]);
      expect(rowPatch(net, row.id)).toMatchObject({ state: "charged", wallet_tx_id: 7001 });
    }
  });

  it("a debit that fails is not charged: pending with the backoff, logged, and the same key next time", async () => {
    const row = charge("sms", SMS_ID, { attempts: 3 });
    const net = world({ queue: [row], sms: [smsRow(SMS_ID)], messages: [{ sid: SM(1), status: "delivered", num_segments: 2, price: "-0.01660" }], debitFails: true });
    expect(await runIt()).toMatchObject({ charged: 0, pending: 1 });
    const p = rowPatch(net, row.id);
    expect(p.state).toBeUndefined();
    expect(p.next_try_at).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
    expect(p.last_error).toContain("wallet_usage_debit failed");
    expect(net.writes("app_errors").map((s) => s.json.code)).toContain("usage_charge_retry");
  });

  it("after MAX_ATTEMPTS a failing row gives up: failed, logged as an error", async () => {
    const row = charge("sms", SMS_ID, { attempts: 30 });
    const net = world({ queue: [row], sms: [smsRow(SMS_ID)], messages: [{ sid: SM(1), status: "delivered", num_segments: 2, price: "-0.01660" }], debitFails: true });
    expect(await runIt()).toMatchObject({ failed: 1 });
    expect(rowPatch(net, row.id)).toMatchObject({ state: "failed" });
    expect(net.writes("app_errors").map((s) => s.json)).toContainEqual(expect.objectContaining({ code: "usage_charge_gave_up", severity: "error" }));
  });

  it("a source row that is gone is failed, not retried forever", async () => {
    const row = charge("call", uuid(699));
    const net = world({ queue: [row], calls: [] });
    expect(await runIt()).toMatchObject({ failed: 1 });
    expect(rowPatch(net, row.id)).toMatchObject({ state: "failed", last_error: "the call row is gone" });
  });

  it("the queue RPC missing (migration 259 not applied): the run stops, logged and throttled", async () => {
    const net = new FakeNet().install();
    net.rpc("usage_charges_enqueue", () => new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function" }), { status: 404, headers: { "content-type": "application/json" } }));
    net.rest("POST", "app_errors", () => []);
    expect(await runIt()).toMatchObject({ ran: false, reason: "error" });
    await runIt();
    expect(net.writes("app_errors").map((s) => s.json.code)).toEqual(["usage_charge_failed"]);
  });

  it("asks for at most 40 rows a run, ten at a time, with a 240 s lease; three days back, 500 at most", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => uuid(700 + i));
    const rows = ids.map((id) => charge("sms", id, { client_id: OTHER }));
    const net = world({
      queue: rows, sms: ids.map((id) => smsRow(id, { client_id: OTHER })),
      messages: [{ sid: SM(1), status: "delivered", num_segments: 1, price: "-0.00830" }], armed: () => false,
    });
    const out = await runIt(ON, { requestCap: 10_000 });
    expect(out).toMatchObject({ claimed: 40, shadow: 40 });
    expect(net.rpcCalls("usage_charges_claim").map((s) => s.json)).toEqual(Array(4).fill({ p_limit: 10, p_lease_s: 240 }));
    expect(net.rpcCalls("usage_charges_enqueue")[0].json).toEqual({ p_since: "2026-09-29T12:00:00.000Z", p_limit: 500 });
  });
});

// ── A debit posted by an earlier attempt: the ledger wins ───────────────────────────
//
// wallet_usage_debit commits, its reply is lost (postgrest-js resolves {error}, so decide()
// throws and the row stays pending), and the retry minutes or hours later meets changed
// settings or a re-priced call. usage_charges must then say what the LEDGER says.

describe("a debit an earlier attempt posted (lost reply): the queue row records the ledger", () => {
  const SMS_ID = uuid(651);
  const KEY = `usage:sms:${SMS_ID}`;
  // The earlier attempt's line: 2 segments at 25,600 micros of cost, markup 2.
  const LINE: LedgerFixture = {
    id: 6500, idempotency_key: KEY, amount_exact_micros: -51200, cost_micros: 25600,
    memo: "Text to (555) 555-0142 · 2 segments", usage: { units: 2, unit: "segment", direction: "out" },
  };
  const retry = (over: Partial<World> = {}, rowOver: Partial<ChargeRow> = {}) => {
    const row = charge("sms", SMS_ID, { attempts: 2, ...rowOver });
    const net = world({
      queue: [row], sms: [smsRow(SMS_ID)], messages: [{ sid: SM(1), status: "delivered", num_segments: 2, price: "-0.01660" }],
      ledger: [LINE], ...over,
    });
    return { row, net };
  };

  it.each([
    ["the panic button was pressed (armed_at cleared)", { settings: { markup: 2, armed_at: null } }, ON, "shadow"],
    ["the env rail was turned off", {}, makeEnv({ PHONE_USAGE_METERS: "off", PHONE_USAGE_COST_CAPTURE: "on" }), "shadow"],
    ["the tenant was made metered_exempt", { meteredExempt: [CLIENT] }, ON, "exempt"],
    ["the tenant was made billing_exempt", { billingExempt: [CLIENT] }, ON, "exempt"],
    ["the text now reads undelivered", { messages: [{ sid: SM(1), status: "undelivered", num_segments: 2, price: null }] }, ON, "not_billable"],
  ])("%s: settled 'charged' with the line's id and figures; a warning names what this run would have decided", async (_l, over, env, instead) => {
    const { row, net } = retry(over as Partial<World>);
    const out = await runIt(env as Env);
    expect(out).toMatchObject({ charged: 1, shadow: 0, exempt: 0, not_billable: 0 });
    expect(debits(net)).toEqual([]); // nothing is posted again
    expect(rowPatch(net, row.id)).toMatchObject({ state: "charged", wallet_tx_id: 6500, charge_micros: 51200, cost_micros: 25600, last_error: null });
    expect(net.writes("app_errors").map((s) => s.json)).toContainEqual(expect.objectContaining({
      code: "usage_charge_kept_from_ledger", severity: "warn", context: expect.objectContaining({ wallet_tx_id: 6500, instead }),
    }));
    // One ledger read for the batch: this tenant, this key, released lines excluded.
    const reads = net.reads("wallet_transactions");
    expect(reads).toHaveLength(1);
    expect(filter(reads[0], "idempotency_key")).toBe(`(${KEY})`);
    expect(filter(reads[0], "client_id")).toBe(`(${CLIENT})`);
    expect(reads[0].url.searchParams.get("state")).toBe("neq.released");
    countedAll(net, out);
  });

  it("a released line does not count: the row settles as this run decides", async () => {
    const { row, net } = retry({ settings: { markup: 2, armed_at: null }, ledger: [{ ...LINE, state: "released" }] });
    expect(await runIt()).toMatchObject({ shadow: 1, charged: 0 });
    expect(rowPatch(net, row.id)).toMatchObject({ state: "shadow", charge_micros: 51200 });
    expect(rowPatch(net, row.id).wallet_tx_id).toBeUndefined();
  });

  it("a first attempt cannot have posted anything: the ledger is not read", async () => {
    const { row, net } = retry({ settings: { markup: 2, armed_at: null } }, { attempts: 1 });
    await runIt();
    expect(rowPatch(net, row.id)).toMatchObject({ state: "shadow" });
    expect(net.reads("wallet_transactions")).toEqual([]);
  });

  it("re-priced since (the first attempt estimated it): the replay's ORIGINAL charge and cost are recorded, this attempt's kept beside them", async () => {
    // The first attempt, past the fallback hours with Twilio unpriced, charged 2 × 8,300 + fees
    // at markup 2; Twilio has priced it since (25,600 now, which would charge 51,200).
    const { row, net } = retry({ replayOf: { tx_id: 6400, amount_exact_micros: -51800, cost_micros: 25900 }, ledger: [] });
    expect(await runIt()).toMatchObject({ charged: 1 });
    expect(debits(net)).toHaveLength(1); // the replay itself is the same key, so it moves nothing
    const p = rowPatch(net, row.id);
    expect(p).toMatchObject({
      state: "charged", wallet_tx_id: 6400, charge_micros: 51800, cost_micros: 25900,
      markup: 2, // 25,900 × 2 = 51,800: today's markup is the one that made it
      cost_source: null, // how THIS attempt priced it no longer describes cost_micros
    });
    expect(p.cost_detail.ledger).toEqual({ wallet_tx_id: 6400, recomputed_cost_micros: 25600, recomputed_charge_micros: 51200 });
    expect(net.writes("app_errors").map((s) => s.json.code)).not.toContain("usage_charge_kept_from_ledger");
  });

  it("the markup was edited since: the line's charge stands, and the row does not claim today's markup made it", async () => {
    const { row, net } = retry({ settings: { markup: 3, armed_at: ARMED_AT }, replayOf: { tx_id: 6500, amount_exact_micros: -51200, cost_micros: 25600 } });
    await runIt();
    const p = rowPatch(net, row.id);
    expect(p).toMatchObject({ state: "charged", wallet_tx_id: 6500, charge_micros: 51200, cost_micros: 25600, markup: null, cost_source: "twilio" });
    expect(p.cost_detail.ledger).toEqual({ wallet_tx_id: 6500, recomputed_cost_micros: 25600, recomputed_charge_micros: 76800 });
  });

  it("a plain replay with the same figures records them unchanged (no ledger note)", async () => {
    const { row, net } = retry({ replayOf: { tx_id: 6500, amount_exact_micros: -51200, cost_micros: 25600 } });
    await runIt();
    const p = rowPatch(net, row.id);
    expect(p).toMatchObject({ state: "charged", wallet_tx_id: 6500, charge_micros: 51200, cost_micros: 25600, markup: 2, cost_source: "twilio" });
    expect(p.cost_detail.ledger).toBeUndefined();
  });

  it("the text row is gone since: charged from the line alone (its memo and units), not failed", async () => {
    const { row, net } = retry({ sms: [] });
    expect(await runIt()).toMatchObject({ charged: 1, failed: 0 });
    expect(rowPatch(net, row.id)).toMatchObject({
      state: "charged", wallet_tx_id: 6500, charge_micros: 51200, cost_micros: 25600, units: 2, unit: "segment",
      memo: "Text to (555) 555-0142 · 2 segments", cost_detail: { ledger: { wallet_tx_id: 6500 } },
    });
    expect(net.writes("app_errors").map((s) => s.json.code)).toEqual(["usage_charge_kept_from_ledger"]);
  });

  it("a call: the same key shape (usage:call:<id>), and a lost reply under the panic button is still charged", async () => {
    const CALL = uuid(652);
    const row = charge("call", CALL, { attempts: 3 });
    const net = world({
      queue: [row], settings: { markup: 2, armed_at: null },
      calls: [callRow(CALL, { client_call_sid: CA(1), twilio_call_sid: CA(2) })],
      legs: [
        { sid: CA(1), status: "completed", duration: 152, price: "-0.00400", direction: "inbound", from: APP, to: CUSTOMER },
        { sid: CA(2), parent: CA(1), status: "completed", duration: 150, price: "-0.04200", direction: "outbound-dial", from: BUSINESS_NUMBER, to: CUSTOMER },
      ],
      ledger: [{ id: 6600, idempotency_key: `usage:call:${CALL}`, amount_exact_micros: -92000, cost_micros: 46000 }],
    });
    await runIt();
    expect(rowPatch(net, row.id)).toMatchObject({ state: "charged", wallet_tx_id: 6600, charge_micros: 92000, cost_micros: 46000, markup: 2, cost_source: "twilio" });
    expect(debits(net)).toEqual([]);
  });
});

// ── Auto top-up and the request cap ─────────────────────────────────────────────────

describe("after the batch: auto top-up", () => {
  it("one request per tenant charged this run that is now under its threshold with auto top-up on; never for the others", async () => {
    const T_LOW = "tenant-low";
    const T_FINE = "tenant-fine";
    const T_OFF = "tenant-off";
    const T_HELD = "tenant-held";
    const ids = [uuid(801), uuid(802), uuid(803), uuid(804), uuid(805)];
    const owners = [T_LOW, T_LOW, T_FINE, T_OFF, T_HELD];
    const net = world({
      queue: ids.map((id, i) => charge("sms", id, { client_id: owners[i] })),
      sms: ids.map((id, i) => smsRow(id, { client_id: owners[i] })),
      messages: [{ sid: SM(1), status: "delivered", num_segments: 1, price: "-0.00830" }],
      wallets: [
        { client_id: T_LOW, balance_cents: 1500, held_cents: 0, auto_topup_enabled: true, auto_topup_threshold_cents: 2000 },
        { client_id: T_FINE, balance_cents: 5000, held_cents: 0, auto_topup_enabled: true, auto_topup_threshold_cents: 2000 },
        { client_id: T_OFF, balance_cents: 100, held_cents: 0, auto_topup_enabled: false, auto_topup_threshold_cents: null },
        // Spendable is what counts (autoTopupDecision's measure): 2,500 − 1,000 held = 1,500.
        { client_id: T_HELD, balance_cents: "2500", held_cents: "1000", auto_topup_enabled: true, auto_topup_threshold_cents: "2000" },
      ],
    });
    const out = await runIt();
    expect(out).toMatchObject({ charged: 5, topups: 2 });
    const req = net.to(/\/functions\/v1\/wallet-autotopup$/);
    expect(req.map((s) => s.json.client_id).sort()).toEqual([T_HELD, T_LOW]);
    expect(req[0].headers.get("authorization")).toBe("Bearer test-service-key");
    expect(filter(net.reads("wallet_accounts").at(-1)!, "client_id")).toBe(`(${[T_LOW, T_FINE, T_OFF, T_HELD].join(",")})`);
  });

  it("nobody charged (shadow only): no wallet read, no request", async () => {
    const id = uuid(811);
    const net = world({ queue: [charge("sms", id)], sms: [smsRow(id)], messages: [{ sid: SM(1), status: "delivered", num_segments: 1, price: "-0.00830" }], armed: () => false });
    await runIt();
    expect(net.reads("wallet_accounts").filter((s) => (s.url.searchParams.get("select") ?? "").includes("auto_topup"))).toEqual([]);
    expect(net.to(/wallet-autotopup/)).toEqual([]);
  });

  it("a top-up request that fails is logged, never thrown", async () => {
    const id = uuid(821);
    const net = world({
      queue: [charge("sms", id)], sms: [smsRow(id)], messages: [{ sid: SM(1), status: "delivered", num_segments: 1, price: "-0.00830" }],
      wallets: [{ client_id: CLIENT, balance_cents: 0, held_cents: 0, auto_topup_enabled: true, auto_topup_threshold_cents: 2000 }],
    });
    net.on("POST", (u) => u.href === `${SUPABASE_URL}/functions/v1/wallet-autotopup`, () => jsonRes({ error: "down" }, 503));
    expect(await runIt()).toMatchObject({ ran: true, charged: 1, topups: 1 });
    expect(net.writes("app_errors").map((s) => s.json.code)).toContain("wallet_autotopup_request_failed");
  });
});

describe("the request cap", () => {
  it("stops before the cap: the rows it cannot finish are released for the next run, and that is logged", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => uuid(900 + i));
    const net = world({
      queue: ids.map((id) => charge("sms", id)), sms: ids.map((id) => smsRow(id)),
      messages: [{ sid: SM(1), status: "delivered", num_segments: 1, price: "-0.00830" }],
    });
    const out = await runIt(ON, { requestCap: 30 });
    expect(out).toMatchObject({ ran: true, claimed: 10, charged: 2, deferred: 8 });
    expect((out as { requests: number }).requests).toBeLessThanOrEqual(30);
    // One claim only: the cap stopped the loop.
    expect(net.rpcCalls("usage_charges_claim")).toHaveLength(1);
    const release = net.writes("usage_charges", "PATCH").find((s) => s.json && "lease_until" in s.json && Object.keys(s.json).length === 1)!;
    expect(release.json).toEqual({ lease_until: null });
    expect(filter(release, "id")).toBe(`(${Array.from({ length: 8 }, (_, i) => i + 3).join(",")})`);
    expect(filter(release, "state")).toBe("pending");
    expect(net.writes("app_errors").map((s) => s.json)).toContainEqual(expect.objectContaining({ code: "usage_charge_deferred", severity: "warn" }));
    countedAll(net, out);
  });

  it("a call whose legs run past the cap mid-collection is released, not half-priced", async () => {
    const CALL = uuid(950);
    const many: Leg[] = [{ sid: CA(1), status: "completed", duration: 600, price: "-0.01", direction: "inbound", from: CUSTOMER, to: BUSINESS_NUMBER }];
    for (let i = 2; i <= 12; i++) many.push({ sid: CA(i), parent: CA(i - 1), status: "completed", duration: 60, price: "-0.001", direction: "outbound-dial", from: CUSTOMER, to: "+15555550177" });
    const row = charge("call", CALL, { direction: "in" });
    const net = world({ queue: [row], calls: [callRow(CALL, { direction: "in", twilio_call_sid: CA(1), from_e164: CUSTOMER })], legs: many });
    const out = await runIt(ON, { requestCap: 20 });
    expect(out).toMatchObject({ deferred: 1, charged: 0 });
    expect(debits(net)).toEqual([]);
    expect(net.writes("usage_charges", "PATCH").map((s) => s.json)).toEqual([{ lease_until: null }]);
  });
});

// ── Twilio REST shapes ──────────────────────────────────────────────────────────────

describe("twilioRest additions", () => {
  it("fetchCallCost reads price, duration, status, parent and direction off the call resource", async () => {
    const net = world({ queue: [], legs: [{ sid: CA(5), parent: CA(4), status: "completed", duration: 61, price: "-0.01400", direction: "outbound-dial", from: BUSINESS_NUMBER, to: CUSTOMER }] });
    expect(await fetchCallCost(ON, CA(5))).toEqual({
      sid: CA(5), status: "completed", duration: 61, price: 14000, priceUnit: "USD", parentCallSid: CA(4), direction: "outbound-dial", from: BUSINESS_NUMBER, to: CUSTOMER,
    });
    expect(await fetchCallCost(ON, CA(6))).toBeNull(); // 404
    expect(net.to(/Calls\/CA/)[0].headers.get("authorization")).toMatch(/^Basic /);
  });

  it("listUsageDaily keeps the call, text, recording and conference categories, follows pages", async () => {
    const net = new FakeNet().install();
    net.on("GET", /Usage\/Records\/Daily\.json\?.*StartDate/, () => jsonRes({
      usage_records: [
        { category: "calls-inbound", count: "3", usage: "7", price: "0.06", price_unit: "usd" },
        { category: "totalprice", count: "1", usage: "9", price: "9.00", price_unit: "usd" },
      ],
      next_page_uri: "/2010-04-01/Accounts/AC00000000000000000000000000000000/Usage/Records/Daily.json?Page=1&PageToken=x",
    }));
    net.on("GET", /Usage\/Records\/Daily\.json\?Page=1/, () => jsonRes({
      usage_records: [{ category: "calls-globalconference", count: "1", usage: "4", price: null, price_unit: "usd" }],
      next_page_uri: null,
    }));
    expect(await listUsageDaily(ON, "2026-10-01")).toEqual([
      { category: "calls-inbound", count: 3, usage: 7, priceMicros: 60000, priceUnit: "usd" },
      { category: "calls-globalconference", count: 1, usage: 4, priceMicros: null, priceUnit: "usd" },
    ]);
  });
});
