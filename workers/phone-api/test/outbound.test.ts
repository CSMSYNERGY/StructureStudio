import { describe, expect, it } from "vitest";
import {
  BUSINESS_NUMBER, CALL_SID, CLIENT, CONTACT_1, CUSTOMER, FakeNet, NUMBER_ID, USER_A,
  attr, call, callerCtx, filter, makeEnv, numbersIn, twilioPost,
} from "./helpers";

const IDENTITY_A = `client:u_${USER_A.replace(/-/g, "")}_g1`;

function setup(ctx: Record<string, unknown> | null = callerCtx(), opts: { contacts?: unknown[]; used?: unknown[] } = {}) {
  const net = new FakeNet().install();
  net.rpc("phone_caller_context", () => ctx);
  net.rest("GET", "crm_contacts", () => opts.contacts ?? []);
  net.rest("GET", "phone_calls", () => opts.used ?? []);
  // The wallet floor's reads: the voice_minute meter is disarmed here (wallet.test.ts arms it).
  net.rest("GET", "usage_prices", () => []);
  net.rest("GET", "wallet_accounts", () => []);
  net.rest("GET", "client_settings", () => []);
  net.rest("POST", "phone_calls", () => []);
  net.rest("POST", "phone_call_events", () => []);
  net.rest("POST", "app_errors", () => []);
  return net;
}

async function dialOut(env = makeEnv(), params: Record<string, string> = {}) {
  return call(env, await twilioPost(env, "/voice/outbound", {
    CallSid: CALL_SID, From: IDENTITY_A, To: CUSTOMER, Direction: "inbound", ...params,
  }));
}

describe("/voice/outbound", () => {
  it("dials with the builder's number as caller ID, answerOnBridge, and a status callback on the <Number>", async () => {
    const net = setup(undefined, { contacts: [{ id: CONTACT_1 }] });
    const { res, text } = await dialOut(makeEnv(), { ContactId: CONTACT_1, ClickAt: String(Date.now() - 80) });
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(attr(text, "Dial", "callerId")).toBe(BUSINESS_NUMBER);
    expect(attr(text, "Dial", "answerOnBridge")).toBe("true");
    expect(numbersIn(text)).toEqual([CUSTOMER]);
    // The action lets hold and warm transfer move the call into a conference (plan 9C design b).
    expect(attr(text, "Dial", "action")).toMatch(/^https:\/\/phone\.example\.test\/voice\/after-dial\?call=[0-9a-f-]{36}&stage=out&key=test-webhook-key$/);
    const cb = attr(text, "Number", "statusCallback")!;
    expect(cb).toMatch(/^https:\/\/phone\.example\.test\/voice\/status\?call=[0-9a-f-]{36}&leg=pstn&key=test-webhook-key$/);
    expect(attr(text, "Number", "statusCallbackEvent")).toBe("initiated ringing answered completed");
    expect(text).not.toMatch(/record=/i);

    // The row, written in the background with the id the callback names.
    const row = net.writes("phone_calls", "POST")[0].json;
    expect(row).toMatchObject({
      client_id: CLIENT, number_id: NUMBER_ID, contact_id: CONTACT_1, direction: "out",
      from_e164: BUSINESS_NUMBER, to_e164: CUSTOMER, client_call_sid: CALL_SID, placed_by: USER_A, status: "ringing",
    });
    expect(cb).toContain(`call=${row.id}`);
    expect(attr(text, "Dial", "action")).toContain(`call=${row.id}`);
    // A disarmed meter is not an error: nothing was logged.
    expect(net.writes("app_errors")).toEqual([]);
    const types = net.writes("phone_call_events").map((s) => s.json.type);
    expect(types).toEqual(["click", "twiml_served"]);
  });

  it("re-checks the tenant for the contact id", async () => {
    const net = setup(undefined, { contacts: [] });
    const { text } = await dialOut(makeEnv(), { ContactId: CONTACT_1 });
    expect(text).toContain("That contact isn't in your account.");
    expect(text).toContain("<Hangup/>");
    const lookup = net.reads("crm_contacts")[0];
    expect(filter(lookup, "client_id")).toBe(CLIENT);
    expect(net.writes("phone_calls", "POST")[0].json).toMatchObject({ status: "failed", error_code: "not_your_customer" });
  });

  it.each(["911", "933", "112", "9-1-1"])("blocks %s with the cell-phone message and records emergency_blocked", async (to) => {
    const net = setup();
    const { text } = await dialOut(makeEnv(), { To: to });
    expect(text).toContain("<Say language=\"en-US\">For emergencies, call 9 1 1 from your cell phone.</Say><Hangup/>");
    expect(text).not.toContain("<Dial");
    const row = net.writes("phone_calls", "POST")[0].json;
    expect(row).toMatchObject({ status: "failed", error_code: "emergency_blocked", is_emergency: false, placed_by: USER_A });
  });

  it("with EMERGENCY_MODE=allow, 911 passes as plain digits and skips every block", async () => {
    // Off switch, over the cap: neither matters for 911.
    const net = setup(callerCtx({ phone_status: "off" }), { used: [{ duration_s: 999_999 }] });
    const { text } = await dialOut(makeEnv({ EMERGENCY_MODE: "allow" }), { To: "911" });
    expect(numbersIn(text)).toEqual(["911"]);
    expect(attr(text, "Dial", "callerId")).toBe(BUSINESS_NUMBER);
    // 911 is never moved into a conference, so its Dial has no action; and no wallet read.
    expect(attr(text, "Dial", "action")).toBeNull();
    expect(net.reads("usage_prices")).toEqual([]);
    expect(net.writes("phone_calls", "POST")[0].json).toMatchObject({ is_emergency: true, to_e164: "911" });
  });

  it.each([
    ["no phone access", callerCtx({ phone_level: "none" }), "doesn't have phone access"],
    ["removed from the team", null, "doesn't have phone access"],
    ["a retired device (old generation)", callerCtx({ device_generation: 2 }), "This device was signed out"],
    ["the switch off", callerCtx({ phone_status: "off" }), "isn't switched on"],
    ["no number", callerCtx({ number: null }), "doesn't have a phone number"],
  ])("refuses %s", async (_l, ctx, words) => {
    setup(ctx as Record<string, unknown> | null);
    const { text } = await dialOut();
    expect(text).toContain(words);
    expect(text).toContain("<Hangup/>");
    expect(text).not.toContain("<Dial");
  });

  it("refuses when today's minutes reach DAILY_MINUTE_CAP (rounded up per call)", async () => {
    // 5 calls of 61 s = 10 billable minutes.
    const net = setup(undefined, { used: Array.from({ length: 5 }, () => ({ duration_s: 61, answered_at: null, ended_at: null })) });
    const { text } = await dialOut(makeEnv({ DAILY_MINUTE_CAP: "10" }));
    expect(text).toContain("Today's calling limit is reached");
    const q = net.reads("phone_calls")[0];
    expect(filter(q, "client_id")).toBe(CLIENT);
    expect(filter(q, "direction")).toBe("out");
    expect(net.writes("phone_calls", "POST")[0].json.error_code).toBe("minute_cap");
  });

  it("allows the call just under the cap", async () => {
    setup(undefined, { used: [{ duration_s: 540, answered_at: null, ended_at: null }] });
    const { text } = await dialOut(makeEnv({ DAILY_MINUTE_CAP: "10" }));
    expect(text).toContain("<Dial");
  });

  it.each([["+15555", "can't be dialed. Check it"], ["+19005550100", "can't be dialed from SSS Phone"], ["client:someone", "can't be dialed. Check it"]])(
    "refuses a bad or premium number %s", async (to, words) => {
      setup();
      const { text } = await dialOut(makeEnv(), { To: to });
      expect(text).toContain(words);
    },
  );

  it("refuses an identity that isn't one of ours", async () => {
    setup();
    const { text } = await dialOut(makeEnv(), { From: "client:somebody" });
    expect(text).toContain("isn't signed in correctly");
  });
});
