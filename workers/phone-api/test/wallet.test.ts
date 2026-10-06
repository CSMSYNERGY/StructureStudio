// The wallet floor: outbound calls only, only with PHONE_USAGE_METERS on, and the verdict is
// the database's (wallet_usage_gate, migration 259), stubbed here.
import { describe, expect, it } from "vitest";
import {
  BUSINESS_NUMBER, CALL_SID, CLIENT, CUSTOMER, FakeNet, SUPABASE_URL, USER_A, call, callerCtx, jsonRes, makeEnv, numbersIn, routeInfo, twilioPost,
} from "./helpers";
import type { Env } from "../src/env";
import { adminClient } from "../src/db";
import { ERROR_TEXT } from "../src/http";
import { requestAutoTopup, walletFloorCheck, walletStateOf, WALLET_WORDS } from "../src/wallet";

const IDENTITY_A = `client:u_${USER_A.replace(/-/g, "")}_g1`;
const ON = makeEnv({ PHONE_USAGE_METERS: "on" });

type Gate = Record<string, unknown> | Response | null;
const gate = (allow: boolean, reason: string, available: number | string = 0, floor: number | string = 500, auto = false) =>
  ({ allow, reason, available_cents: available, floor_cents: floor, auto_topup_enabled: auto });

function setup(opts: { gate?: Gate } = {}) {
  const net = new FakeNet().install();
  net.rpc("phone_caller_context", () => callerCtx());
  net.rest("GET", "crm_contacts", () => []);
  net.rest("GET", "phone_calls", () => []);
  net.rpc("wallet_usage_gate", () => (opts.gate === undefined ? gate(true, "above_floor", 900) : opts.gate));
  net.rest("POST", "phone_calls", () => []);
  net.rest("POST", "phone_call_events", () => []);
  net.rest("POST", "app_errors", () => []);
  net.rpc("phone_route_for_number", () => routeInfo());
  net.on("POST", (u) => u.href === `${SUPABASE_URL}/functions/v1/wallet-autotopup`, () => jsonRes({ fired: true, ok: true }));
  return net;
}

async function dialOut(env: Env = ON, to = CUSTOMER) {
  return call(env, await twilioPost(env, "/voice/outbound", { CallSid: CALL_SID, From: IDENTITY_A, To: to, Direction: "inbound" }));
}

const topups = (net: FakeNet) => net.to(/\/functions\/v1\/wallet-autotopup$/);

describe("wallet floor on /voice/outbound", () => {
  it("below the floor, auto top-up off: refused in plain words, recorded as wallet_empty, no top-up asked for", async () => {
    const net = setup({ gate: gate(false, "below_floor", 499) });
    const { text } = await dialOut();
    expect(text).toContain("Your wallet is empty. Add funds in Structure Studio under Settings, Billing.");
    expect(text).toContain("<Hangup/>");
    expect(text).not.toContain("<Dial");
    expect(net.writes("phone_calls", "POST")[0].json).toMatchObject({ status: "failed", error_code: "wallet_empty" });
    expect(net.rpcCalls("wallet_usage_gate").map((s) => s.json)).toEqual([{ p_client_id: CLIENT, p_meter: "voice_minute" }]);
    const log = net.writes("app_errors").map((s) => s.json).find((l) => l.code === "wallet_empty");
    expect(log).toMatchObject({ severity: "info" });
    expect(log.message).toContain("499 cents is below the floor of 500");
    expect(topups(net)).toEqual([]);
  });

  it("below the floor with auto top-up on: asks wallet-autotopup once (service role) and says to try again in a minute", async () => {
    const net = setup({ gate: gate(false, "below_floor", 120, 500, true) });
    const { text } = await dialOut();
    expect(text).toContain("Your wallet is being topped up. Try again in a minute.");
    expect(text).not.toContain("<Dial");
    expect(net.writes("phone_calls", "POST")[0].json).toMatchObject({ status: "failed", error_code: "wallet_empty" });
    const req = topups(net);
    expect(req).toHaveLength(1);
    expect(req[0].json).toEqual({ client_id: CLIENT });
    expect(req[0].headers.get("authorization")).toBe("Bearer test-service-key");
  });

  it.each([
    ["above the floor", gate(true, "above_floor", 500)],
    ["exempt", gate(true, "exempt", 0)],
    ["disarmed in the database", gate(true, "disarmed", 0)],
    ["a reason this Worker does not know yet", gate(true, "something_new", 0)],
  ])("dials when the gate allows (%s)", async (_l, g) => {
    const net = setup({ gate: g });
    expect(numbersIn((await dialOut()).text)).toEqual([CUSTOMER]);
    expect(net.writes("app_errors")).toEqual([]);
  });

  it("PHONE_USAGE_METERS off (how it ships): never refuses, and never even asks the database", async () => {
    const net = setup({ gate: gate(false, "below_floor", 0) });
    expect(numbersIn((await dialOut(makeEnv())).text)).toEqual([CUSTOMER]);
    expect(net.rpcCalls("wallet_usage_gate")).toEqual([]);
  });

  it.each([
    ["the RPC failing", new Response(JSON.stringify({ message: "down" }), { status: 500, headers: { "content-type": "application/json" } })],
    ["the RPC missing (migration not applied)", new Response(JSON.stringify({ code: "PGRST202", message: "not found" }), { status: 404, headers: { "content-type": "application/json" } })],
    ["no verdict in the answer", null],
  ])("fails OPEN on %s (the call goes through) and logs it at warn", async (_l, g) => {
    const net = setup({ gate: g });
    expect(numbersIn((await dialOut()).text)).toEqual([CUSTOMER]);
    const log = net.writes("app_errors").map((s) => s.json).find((l) => l.code === "wallet_floor_check_failed");
    expect(log).toMatchObject({ severity: "warn" });
  });

  it("911 (EMERGENCY_MODE=allow) is never refused, and never reads the wallet", async () => {
    const net = setup({ gate: gate(false, "below_floor", 0) });
    const { text } = await dialOut(makeEnv({ PHONE_USAGE_METERS: "on", EMERGENCY_MODE: "allow" }), "911");
    expect(numbersIn(text)).toEqual(["911"]);
    expect(net.rpcCalls("wallet_usage_gate")).toEqual([]);
  });

  it("inbound calls are never refused, and never read the wallet", async () => {
    const net = setup({ gate: gate(false, "below_floor", 0) });
    const { text } = await call(ON, await twilioPost(ON, "/voice/inbound", { CallSid: CALL_SID, From: CUSTOMER, To: BUSINESS_NUMBER, Direction: "inbound" }));
    expect(text).toContain("<Client");
    expect(net.rpcCalls("wallet_usage_gate")).toEqual([]);
  });
});

describe("walletFloorCheck / walletStateOf / requestAutoTopup", () => {
  it("maps the gate's answer onto the verdict, numbers included", async () => {
    setup({ gate: gate(false, "below_floor", "130", "500", true) }); // bigint as text
    expect(await walletFloorCheck(ON, adminClient(ON), CLIENT)).toEqual({ refuse: true, reason: "below_floor", availableCents: 130, floorCents: 500, autoTopupEnabled: true });
    setup({ gate: gate(true, "exempt", -40) });
    expect(await walletFloorCheck(ON, adminClient(ON), CLIENT)).toEqual({ refuse: false, reason: "exempt", availableCents: -40, floorCents: 500, autoTopupEnabled: false });
  });

  it("asks about the meter it is given", async () => {
    const net = setup();
    await walletFloorCheck(ON, adminClient(ON), CLIENT, "sms_segment");
    expect(net.rpcCalls("wallet_usage_gate")[0].json).toEqual({ p_client_id: CLIENT, p_meter: "sms_segment" });
  });

  it("the app banner: blocked, low (under twice the floor), ok", () => {
    expect(walletStateOf({ refuse: true, reason: "below_floor", availableCents: 0, floorCents: 500, autoTopupEnabled: true })).toEqual({ state: "blocked", topping_up: true });
    expect(walletStateOf({ refuse: true, reason: "below_floor", availableCents: 0, floorCents: 500 })).toEqual({ state: "blocked", topping_up: false });
    expect(walletStateOf({ refuse: false, reason: "above_floor", availableCents: 999, floorCents: 500 })).toEqual({ state: "low", topping_up: false });
    expect(walletStateOf({ refuse: false, reason: "above_floor", availableCents: 1000, floorCents: 500 })).toEqual({ state: "ok", topping_up: false });
    expect(walletStateOf({ refuse: false, reason: "exempt", availableCents: 0, floorCents: 500 })).toEqual({ state: "ok", topping_up: false });
    expect(walletStateOf({ refuse: false, reason: "error" })).toEqual({ state: "ok", topping_up: false });
    expect(walletStateOf({ refuse: false, reason: "disarmed" })).toEqual({ state: "ok", topping_up: false });
  });

  it("requestAutoTopup never throws: an error answer or an unreachable function is logged and reads false", async () => {
    const net = setup();
    net.on("POST", (u) => u.href === `${SUPABASE_URL}/functions/v1/wallet-autotopup`, () => jsonRes({ error: "nope" }, 500));
    expect(await requestAutoTopup(ON, CLIENT)).toBe(false);
    expect(net.writes("app_errors").map((s) => s.json.code)).toEqual(["wallet_autotopup_request_failed"]);
    net.on("POST", (u) => u.href === `${SUPABASE_URL}/functions/v1/wallet-autotopup`, () => { throw new Error("socket closed"); });
    expect(await requestAutoTopup(ON, CLIENT)).toBe(false);
    net.on("POST", (u) => u.href === `${SUPABASE_URL}/functions/v1/wallet-autotopup`, () => jsonRes({ fired: false, ok: true, reason: "cooling down" }));
    expect(await requestAutoTopup(ON, CLIENT)).toBe(true);
    expect(await requestAutoTopup(makeEnv({ SUPABASE_SERVICE_ROLE_KEY: "" }), CLIENT)).toBe(false); // no key, no request
  });

  it("the two sentences", () => {
    expect(WALLET_WORDS).toEqual({
      empty: "Your wallet is empty. Add funds in Structure Studio under Settings, Billing.",
      toppingUp: "Your wallet is being topped up. Try again in a minute.",
    });
    // An ApiError("wallet_empty") thrown without a message says the same thing.
    expect(ERROR_TEXT.wallet_empty).toBe(WALLET_WORDS.empty);
  });
});
