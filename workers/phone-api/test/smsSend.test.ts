// /sms/send through the REAL shared sendTenantSms (supabase/functions/_shared/smsSend.ts),
// bundled through the jsr alias and reading its secrets through the Deno.env shim.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Auth, BUSINESS_NUMBER, CLIENT, CONTACT_1, CUSTOMER, FakeNet, SUPABASE_URL, USER_A, appRequest, call, callerCtx, filter, jsonRes, makeEnv,
} from "./helpers";
import { mapSmsRefusal } from "../src/routes/sms";
import type { SmsOutcome } from "../../../supabase/functions/_shared/smsSend.ts";

const MSG_ID = "00000000-0000-4000-8000-00000000e002";
const SERVICE = "MG" + "0".repeat(32);

async function setup(opts: { optedOut?: boolean; consent?: boolean; twilioCode?: number } = {}) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  net.rpc("phone_caller_context", () => callerCtx());
  net.rest("GET", "crm_contacts", (s) => (s.url.searchParams.get("select")?.includes("sms_opt_out_at")
    ? [{ sms_opt_out_at: null }]
    : [{ id: CONTACT_1, phone: CUSTOMER, phone_digits: "5555550142" }]));
  net.rest("GET", "client_settings", () => [{ sms_number: BUSINESS_NUMBER, sms_status: "active" }]);
  net.rest("GET", "sms_registrations", () => [{ status: "active", messaging_service_sid: SERVICE }]);
  net.rest("GET", "sms_numbers", () => [{ registration_status: "registered" }]);
  net.rest("GET", "sms_opt_outs", () => (opts.optedOut ? [{ reason: "sms_stop" }] : []));
  net.rest("GET", "sms_consent_log", () => (opts.consent === false ? [] : [{ action: "granted" }]));
  net.rest("POST", "sms_messages", () => [{ id: MSG_ID }]);
  net.rest("PATCH", "sms_messages", () => []);
  net.rest("POST", "app_errors", () => []);
  net.on("POST", /api\.twilio\.com\/2010-04-01\/Accounts\/AC0+\/Messages\.json$/, () =>
    opts.twilioCode ? jsonRes({ code: opts.twilioCode, message: "echoes +15555550142" }, 400) : jsonRes({ sid: "SM" + "0".repeat(32), num_segments: "1", status: "queued" }, 201));
  return { net, token: await auth.token(USER_A), env: makeEnv() };
}

const send = (token: string) => appRequest("POST", "/sms/send", token, { to_e164: CUSTOMER, contact_id: CONTACT_1, body: "On our way", client_temp_id: "tmp-9" });

describe("/sms/send with the shared send rules", () => {
  it("claims the row, sends from the builder's number on their Messaging Service, then tags the row", async () => {
    const { net, token, env } = await setup();
    const { res, json } = await call(env, send(token));
    expect(res.status).toBe(200);
    expect(json.message).toEqual({ id: MSG_ID, client_temp_id: "tmp-9", status: "sent" });

    const claim = net.writes("sms_messages", "POST")[0].json;
    expect(claim).toMatchObject({ client_id: CLIENT, contact_id: CONTACT_1, direction: "out", from_number: BUSINESS_NUMBER, to_number: CUSTOMER, status: "claimed", sent_by: USER_A });

    const tw = net.to(/Messages\.json$/)[0];
    const form = new URLSearchParams(tw.body);
    expect(form.get("From")).toBe(BUSINESS_NUMBER);
    expect(form.get("To")).toBe(CUSTOMER);
    expect(form.get("MessagingServiceSid")).toBe(SERVICE);
    expect(form.get("StatusCallback")).toContain("/functions/v1/sms-status?key=");
    // Twilio auth is the API key pair from the Worker's env, read through the Deno shim.
    expect(tw.headers.get("authorization")).toBe(`Basic ${btoa(`SK${"0".repeat(32)}:test-api-secret`)}`);

    const patches = net.writes("sms_messages", "PATCH").map((s) => s.json);
    expect(patches[0]).toMatchObject({ status: "sent" });
    expect(patches[1]).toEqual({ client_temp_id: "tmp-9", sent_via: "mobile" });
    expect(filter(net.writes("sms_messages", "PATCH")[1], "id")).toBe(MSG_ID);
  });

  it("goes out at any hour: the consent and STOP checks still refuse", async () => {
    const stop = await setup({ optedOut: true });
    const r1 = await call(stop.env, send(stop.token));
    expect(r1.json.error.code).toBe("opted_out");
    expect(stop.net.to(/Messages\.json$/)).toEqual([]);

    const none = await setup({ consent: false });
    const r2 = await call(none.env, send(none.token));
    expect(r2.json.error.code).toBe("no_consent");
    expect(r2.json.error.message).toContain("permission to text them");
  });

  it("a carrier opt-out Twilio reports (21610) reads as opted_out, never as a system fault", async () => {
    const { token, env } = await setup({ twilioCode: 21610 });
    const { res, json } = await call(env, send(token));
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("opted_out");
    expect(json.error.message).not.toContain("+1555");
  });

  it("any other Twilio refusal is twilio_error with the carrier code, no number echoed", async () => {
    const { token, env } = await setup({ twilioCode: 21211 });
    const { res, json } = await call(env, send(token));
    expect(res.status).toBe(502);
    expect(json.error).toEqual({ code: "twilio_error", message: "The text could not be sent (carrier code 21211). Try again, or call them instead." });
  });
});

describe("an empty wallet (wallet_empty, migration 259)", () => {
  const gate = (auto: boolean) => ({ allow: false, reason: "below_floor", available_cents: 120, floor_cents: 500, auto_topup_enabled: auto });

  it("402 with the Worker's sentence, and no claim row, no Twilio send", async () => {
    const { net, token } = await setup();
    net.rpc("wallet_usage_gate", () => gate(false));
    const env = makeEnv({ PHONE_USAGE_METERS: "on" });
    const { res, json } = await call(env, send(token));
    expect(res.status).toBe(402);
    expect(json.error).toEqual({ code: "wallet_empty", message: "Your wallet is empty. Add funds in Structure Studio under Settings, Billing." });
    expect(net.rpcCalls("wallet_usage_gate")[0].json).toEqual({ p_client_id: CLIENT, p_meter: "sms_segment" });
    expect(net.writes("sms_messages", "POST")).toEqual([]);
    expect(net.to(/Messages\.json$/)).toEqual([]);
    expect(net.to(/wallet-autotopup/)).toEqual([]);
  });

  it("auto top-up on: 402 saying it is being topped up, and the top-up request is kept alive (waitUntil)", async () => {
    const { net, token } = await setup();
    net.rpc("wallet_usage_gate", () => gate(true));
    net.on("POST", (u) => u.href === `${SUPABASE_URL}/functions/v1/wallet-autotopup`, () => jsonRes({ fired: true, ok: true }));
    const env = makeEnv({ PHONE_USAGE_METERS: "on" });
    const { res, json } = await call(env, send(token));
    expect(res.status).toBe(402);
    expect(json.error).toEqual({ code: "wallet_empty", message: "Your wallet is being topped up. Try again in a minute." });
    expect(net.to(/wallet-autotopup/).map((s) => s.json)).toEqual([{ client_id: CLIENT }]);
    expect(net.writes("sms_messages", "POST")).toEqual([]);
  });

  it("PHONE_USAGE_METERS off: the gate is never asked and the text goes", async () => {
    const { net, token, env } = await setup();
    net.rpc("wallet_usage_gate", () => gate(false));
    const { res } = await call(env, send(token));
    expect(res.status).toBe(200);
    expect(net.rpcCalls("wallet_usage_gate")).toEqual([]);
  });

  it("mapSmsRefusal: the two wallet sentences, from smsSend's portal wording", () => {
    const out = (error: string) => ({ sent: false, reason: "wallet_empty", error }) as unknown as SmsOutcome;
    expect(mapSmsRefusal(out("Your wallet is empty. Add funds in Settings, Billing."))).toEqual({
      code: "wallet_empty", status: 402, message: "Your wallet is empty. Add funds in Structure Studio under Settings, Billing.",
    });
    expect(mapSmsRefusal(out("Your wallet is being topped up. Try again in a minute."))).toEqual({
      code: "wallet_empty", status: 402, message: "Your wallet is being topped up. Try again in a minute.",
    });
    expect(mapSmsRefusal({ sent: false, reason: "wallet_empty" } as unknown as SmsOutcome).status).toBe(402);
  });
});

describe("wiring", () => {
  it("every sendTenantSms call in the Worker states bypassQuietHours: true (typed texts only)", () => {
    const src = readFileSync(resolve(process.cwd(), "src/routes/sms.ts"), "utf8")
      .replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    const calls = [...src.matchAll(/sendTenantSms\(([\s\S]*?)\}\);/g)].filter((m) => !/import/.test(src.slice(Math.max(0, m.index! - 40), m.index)));
    expect(calls.length).toBe(1);
    for (const m of calls) expect(m[1]).toMatch(/bypassQuietHours:\s*true/);
  });
});
