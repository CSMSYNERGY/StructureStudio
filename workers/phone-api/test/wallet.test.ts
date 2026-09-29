// The wallet floor (plan section 17): outbound calls only, and only while voice_minute is armed.
import { describe, expect, it } from "vitest";
import {
  BUSINESS_NUMBER, CALL_SID, CUSTOMER, FakeNet, USER_A, call, callerCtx, filter, makeEnv, numbersIn, routeInfo, twilioPost,
} from "./helpers";
import type { Env } from "../src/env";

const IDENTITY_A = `client:u_${USER_A.replace(/-/g, "")}_g1`;
const ARMED = [{ price_cents: 2, active: true }];

function setup(opts: { price?: unknown[]; wallet?: unknown[]; settings?: unknown[]; priceStatus?: number } = {}) {
  const net = new FakeNet().install();
  net.rpc("phone_caller_context", () => callerCtx());
  net.rest("GET", "crm_contacts", () => []);
  net.rest("GET", "phone_calls", () => []);
  net.rest("GET", "usage_prices", () => (opts.priceStatus ? new Response(JSON.stringify({ message: "down" }), { status: opts.priceStatus }) : opts.price ?? ARMED));
  net.rest("GET", "wallet_accounts", () => opts.wallet ?? []);
  net.rest("GET", "client_settings", () => opts.settings ?? [{ billing_exempt: false }]);
  net.rest("POST", "phone_calls", () => []);
  net.rest("POST", "phone_call_events", () => []);
  net.rest("POST", "app_errors", () => []);
  net.rpc("phone_route_for_number", () => routeInfo());
  return net;
}

async function dialOut(env: Env = makeEnv(), to = CUSTOMER) {
  return call(env, await twilioPost(env, "/voice/outbound", { CallSid: CALL_SID, From: IDENTITY_A, To: to, Direction: "inbound" }));
}

const wallet = (balance: number, held = 0, exempt = false) => [{ balance_cents: balance, held_cents: held, metered_exempt: exempt }];

describe("wallet floor on /voice/outbound", () => {
  it("armed and below the floor (default 500): refused in plain words, recorded as wallet_empty", async () => {
    const net = setup({ wallet: wallet(499) });
    const { text } = await dialOut();
    expect(text).toContain("Your Structure Studio wallet is empty. Top up in Settings, Billing.");
    expect(text).toContain("<Hangup/>");
    expect(text).not.toContain("<Dial");
    expect(net.writes("phone_calls", "POST")[0].json).toMatchObject({ status: "failed", error_code: "wallet_empty" });
    expect(filter(net.reads("usage_prices")[0], "kind")).toBe("voice_minute");
    expect(filter(net.reads("wallet_accounts")[0], "client_id")).toBe("demo-tenant");
    const log = net.writes("app_errors").map((s) => s.json).find((l) => l.code === "wallet_empty");
    expect(log).toMatchObject({ severity: "info" });
  });

  it("no wallet row at all is a balance of zero", async () => {
    setup({ wallet: [] });
    expect((await dialOut()).text).toContain("wallet is empty");
  });

  it("money on hold for another meter does not count: balance 600 with 200 held is 400, below 500", async () => {
    setup({ wallet: wallet(600, 200) });
    expect((await dialOut()).text).toContain("wallet is empty");
  });

  it("armed and at or above the floor: dials", async () => {
    setup({ wallet: wallet(500) });
    expect(numbersIn((await dialOut()).text)).toEqual([CUSTOMER]);
  });

  it("WALLET_FLOOR_CENTS sets the floor", async () => {
    setup({ wallet: wallet(0) });
    expect(numbersIn((await dialOut(makeEnv({ WALLET_FLOOR_CENTS: "0" }))).text)).toEqual([CUSTOMER]);
    setup({ wallet: wallet(-1) });
    expect((await dialOut(makeEnv({ WALLET_FLOOR_CENTS: "0" }))).text).toContain("wallet is empty");
    setup({ wallet: wallet(900) });
    expect((await dialOut(makeEnv({ WALLET_FLOOR_CENTS: "1000" }))).text).toContain("wallet is empty");
  });

  it.each([
    ["no voice_minute row", []],
    ["the meter inactive", [{ price_cents: 2, active: false }]],
    ["the meter priced at zero", [{ price_cents: 0, active: true }]],
  ])("never refuses while the meter is disarmed (%s), even with an empty wallet", async (_l, price) => {
    const net = setup({ price, wallet: wallet(0) });
    expect(numbersIn((await dialOut()).text)).toEqual([CUSTOMER]);
    expect(net.writes("app_errors")).toEqual([]);
  });

  it.each([
    ["metered_exempt", wallet(0, 0, true), [{ billing_exempt: false }]],
    ["billing_exempt (non-billable account)", wallet(0), [{ billing_exempt: true }]],
  ])("never refuses an exempt tenant (%s)", async (_l, w, settings) => {
    setup({ wallet: w, settings });
    expect(numbersIn((await dialOut()).text)).toEqual([CUSTOMER]);
  });

  it("a failed read fails OPEN (the call goes through) and is logged at warn", async () => {
    const net = setup({ priceStatus: 500, wallet: wallet(0) });
    expect(numbersIn((await dialOut()).text)).toEqual([CUSTOMER]);
    const log = net.writes("app_errors").map((s) => s.json).find((l) => l.code === "wallet_floor_check_failed");
    expect(log).toMatchObject({ severity: "warn" });
  });

  it("911 (EMERGENCY_MODE=allow) is never refused, and never reads the wallet", async () => {
    const net = setup({ wallet: wallet(0) });
    const { text } = await dialOut(makeEnv({ EMERGENCY_MODE: "allow" }), "911");
    expect(numbersIn(text)).toEqual(["911"]);
    expect(net.reads("usage_prices")).toEqual([]);
    expect(net.reads("wallet_accounts")).toEqual([]);
  });

  it("inbound calls are never refused, and never read the wallet", async () => {
    const net = setup({ wallet: wallet(0) });
    const env = makeEnv();
    const { text } = await call(env, await twilioPost(env, "/voice/inbound", { CallSid: CALL_SID, From: CUSTOMER, To: BUSINESS_NUMBER, Direction: "inbound" }));
    expect(text).toContain("<Client");
    expect(net.reads("usage_prices")).toEqual([]);
  });
});
