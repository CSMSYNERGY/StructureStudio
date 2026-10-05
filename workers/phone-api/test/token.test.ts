import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintAccessToken, pushCredentialFor } from "../src/accessToken";
import { b64urlDecodeJson } from "../src/b64";
import { Auth, FakeNet, NUMBER_ID, SUPABASE_URL, USER_A, USER_C, appRequest, call, callerCtx, filter, jsonRes, makeEnv } from "./helpers";
import { businessNumbersOf } from "../src/db";

const HEX_A = USER_A.replace(/-/g, "");

function decode(jwt: string) {
  const [h, p, s] = jwt.split(".");
  return { header: b64urlDecodeJson(h), payload: b64urlDecodeJson<any>(p), signed: `${h}.${p}`, sig: s };
}

describe("Twilio Access Token", () => {
  it("has Twilio's header, claims and a valid HS256 signature over the API key secret", async () => {
    const jwt = await mintAccessToken({
      accountSid: "AC" + "0".repeat(32),
      apiKeySid: "SK" + "0".repeat(32),
      apiKeySecret: "test-api-secret",
      identity: `u_${HEX_A}_g3`,
      ttlSeconds: 3600,
      nowSeconds: 1_900_000_000,
      voice: { incoming: { allow: true }, outgoing: { application_sid: "AP" + "0".repeat(32) }, push_credential_sid: "CR" + "0".repeat(32) },
    });
    const { header, payload, signed, sig } = decode(jwt);
    expect(header).toEqual({ typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" });
    expect(payload).toMatchObject({
      jti: `SK${"0".repeat(32)}-1900000000`,
      iss: "SK" + "0".repeat(32),
      sub: "AC" + "0".repeat(32),
      iat: 1_900_000_000,
      exp: 1_900_003_600,
      grants: {
        identity: `u_${HEX_A}_g3`,
        voice: {
          incoming: { allow: true },
          outgoing: { application_sid: "AP" + "0".repeat(32) },
          push_credential_sid: "CR" + "0".repeat(32),
        },
      },
    });
    expect(sig).toBe(createHmac("sha256", "test-api-secret").update(signed).digest("base64url"));
  });

  it("picks the push credential by platform and build", () => {
    const env = makeEnv();
    expect(pushCredentialFor(env, "ios", "dev")).toBe(env.TWILIO_PUSH_CREDENTIAL_APNS_SANDBOX);
    expect(pushCredentialFor(env, "ios", "prod")).toBe(env.TWILIO_PUSH_CREDENTIAL_APNS_PROD);
    expect(pushCredentialFor(env, "android", "dev")).toBe(env.TWILIO_PUSH_CREDENTIAL_FCM);
    expect(pushCredentialFor(env, "android", "prod")).toBe(env.TWILIO_PUSH_CREDENTIAL_FCM);
    expect(pushCredentialFor(env, "chrome", "prod")).toBeUndefined();
  });
});

describe("POST /token", () => {
  async function setup(ctx: Record<string, unknown> | null = callerCtx({ device_generation: 4 }), settings: unknown[] = []) {
    const net = new FakeNet().install();
    const auth = await new Auth().init();
    auth.serve(net);
    net.rpc("phone_caller_context", () => ctx);
    net.rest("GET", "phone_user_settings", () => settings);
    return { net, auth, env: makeEnv() };
  }

  it("mints a 1-hour token with the current generation, the TwiML App and the build's push credential", async () => {
    const { auth, env } = await setup(undefined, [{ dnd: true, dnd_until: null, forward_to_cell: "+15555550177" }]);
    const { res, json } = await call(env, appRequest("POST", "/token", await auth.token(USER_A), { platform: "ios", build_type: "prod", app_version: "1.0.0" }));
    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      ok: true, identity: `u_${HEX_A}_g4`, ttl: 3600, edge: "roaming",
      user: { user_id: USER_A, client_id: "demo-tenant", phone_level: "own", own_contacts_only: false, can_text_contacts: true },
      number: { e164: "+15555550100" },
      settings: { dnd: true, forward_to_cell: "+15555550177" },
    });
    const { payload } = decode(json.token);
    expect(payload.grants.identity).toBe(`u_${HEX_A}_g4`);
    expect(payload.grants.voice).toEqual({
      incoming: { allow: true },
      outgoing: { application_sid: env.TWILIO_TWIML_APP_SID },
      push_credential_sid: env.TWILIO_PUSH_CREDENTIAL_APNS_PROD,
    });
    expect(payload.exp - payload.iat).toBe(3600);
  });

  // can_text_contacts is /sms/send's first check for a saved contact (scope.ts maySendToContacts):
  // a view-only login sees customers but cannot text them, so the apps hide the composer there.
  it.each([
    ["contacts edit", callerCtx({ contacts_level: "edit" }), true],
    ["contacts own (writes, narrowed per row)", callerCtx({ contacts_level: "own", own_contacts_only: true }), true],
    ["contacts view only", callerCtx({ contacts_level: "view" }), false],
    ["no contacts access", callerCtx({ contacts_level: "none" }), false],
  ])("can_text_contacts with %s", async (_l, ctx, can) => {
    const { auth, env } = await setup(ctx);
    const { res, json } = await call(env, appRequest("POST", "/token", await auth.token(USER_A), { platform: "android", build_type: "prod", app_version: "1" }));
    expect(res.status).toBe(200);
    expect(json.user.can_text_contacts).toBe(can);
  });

  it("adds _dev only for iPhone development-profile builds, with the sandbox credential", async () => {
    const { auth, env } = await setup();
    const ios = await call(env, appRequest("POST", "/token", await auth.token(USER_A), { platform: "ios", build_type: "dev", app_version: "1" }));
    expect(ios.json.identity).toBe(`u_${HEX_A}_g4_dev`);
    expect(decode(ios.json.token).payload.grants.voice.push_credential_sid).toBe(env.TWILIO_PUSH_CREDENTIAL_APNS_SANDBOX);
    const android = await call(env, appRequest("POST", "/token", await auth.token(USER_A), { platform: "android", build_type: "dev", app_version: "1" }));
    expect(android.json.identity).toBe(`u_${HEX_A}_g4`);
    const chrome = await call(env, appRequest("POST", "/token", await auth.token(USER_A), { platform: "chrome", build_type: "prod", app_version: "1" }));
    expect(decode(chrome.json.token).payload.grants.voice.push_credential_sid).toBeUndefined();
  });

  it("incoming_push: true when a phone's token carries its push credential, null where push isn't involved", async () => {
    const { auth, env } = await setup();
    const ask = async (body: Record<string, unknown>) =>
      (await call(env, appRequest("POST", "/token", await auth.token(USER_A), { app_version: "1", ...body }))).json.incoming_push;
    expect(await ask({ platform: "ios", build_type: "prod" })).toBe(true);
    expect(await ask({ platform: "ios", build_type: "dev" })).toBe(true);
    expect(await ask({ platform: "android", build_type: "prod" })).toBe(true);
    expect(await ask({ platform: "chrome", build_type: "prod" })).toBeNull();
    expect(await ask({ platform: "ios", build_type: "prod", preflight: true })).toBeNull();
  });

  it.each([
    ["ios", "prod", "TWILIO_PUSH_CREDENTIAL_APNS_PROD"],
    ["ios", "dev", "TWILIO_PUSH_CREDENTIAL_APNS_SANDBOX"],
    ["android", "prod", "TWILIO_PUSH_CREDENTIAL_FCM"],
  ] as const)("%s %s with %s unset still signs in: a token without a push credential, incoming_push false, one warning", async (platform, build_type, secret) => {
    const { net, auth } = await setup();
    net.rest("POST", "app_errors", () => []);
    const env = makeEnv({ [secret]: undefined });
    const req = async () => appRequest("POST", "/token", await auth.token(USER_A), { platform, build_type, app_version: "1" });
    const { res, json } = await call(env, await req());
    expect(res.status).toBe(200);
    expect(json.incoming_push).toBe(false);
    const voice = decode(json.token).payload.grants.voice;
    expect(voice).toEqual({ incoming: { allow: true }, outgoing: { application_sid: env.TWILIO_TWIML_APP_SID } });
    // Named by its secret, as a warning, and once (throttled) however often phones ask.
    await call(env, await req());
    const logs = net.writes("app_errors").map((s) => s.json);
    expect(logs.map((l) => [l.code, l.severity])).toEqual([[`token_no_${secret.toLowerCase()}`, "warn"]]);
    expect(logs[0].message).toMatch(new RegExp(`^${secret} is not set`));
  });

  it("a push credential SID pasted with a newline is used without it", async () => {
    const { auth } = await setup();
    const env = makeEnv({ TWILIO_PUSH_CREDENTIAL_APNS_PROD: `CR${"0".repeat(31)}2\r\n` });
    const { json } = await call(env, appRequest("POST", "/token", await auth.token(USER_A), { platform: "ios", build_type: "prod", app_version: "1" }));
    expect(decode(json.token).payload.grants.voice.push_credential_sid).toBe(`CR${"0".repeat(31)}2`);
    expect(pushCredentialFor({ TWILIO_PUSH_CREDENTIAL_FCM: "   " }, "android", "prod")).toBeUndefined();
  });

  it("preflight mode uses the echo TwiML App with incoming calls off and a short life", async () => {
    const { auth, env } = await setup();
    const { json } = await call(env, appRequest("POST", "/token", await auth.token(USER_A), { platform: "chrome", build_type: "prod", app_version: "1", preflight: true }));
    const voice = decode(json.token).payload.grants.voice;
    expect(voice).toEqual({ incoming: { allow: false }, outgoing: { application_sid: env.TWILIO_ECHO_APP_SID } });
    expect(json.ttl).toBeLessThan(3600);
  });

  it.each([
    ["no phone access", callerCtx({ phone_level: "none" }), 403, "no_phone_access"],
    ["off the team", null, 403, "no_phone_access"],
    ["the switch off", callerCtx({ phone_status: "off" }), 403, "phone_off"],
  ])("refuses with %s", async (_l, ctx, status, code) => {
    const { auth, env } = await setup(ctx as Record<string, unknown> | null);
    const { res, json } = await call(env, appRequest("POST", "/token", await auth.token(USER_A), { platform: "chrome", build_type: "prod", app_version: "1" }));
    expect(res.status).toBe(status);
    expect(json.error.code).toBe(code);
  });

  it("refuses a login whose session was signed out everywhere (the lost phone)", async () => {
    const { net, auth, env } = await setup();
    net.on("GET", (u) => u.href === `${SUPABASE_URL}/auth/v1/user`, () => jsonRes({ code: "session_not_found" }, 403));
    const { res, json } = await call(env, appRequest("POST", "/token", await auth.token(USER_A), { platform: "ios", build_type: "prod", app_version: "1" }));
    expect(res.status).toBe(401);
    expect(json.error.code).toBe("unauthorized");
  });

  it("still issues a token when Auth itself is down (fails open, and logs it)", async () => {
    const { net, auth, env } = await setup();
    net.on("GET", (u) => u.href === `${SUPABASE_URL}/auth/v1/user`, () => jsonRes({}, 503));
    net.rest("POST", "app_errors", () => []);
    const { res } = await call(env, appRequest("POST", "/token", await auth.token(USER_A), { platform: "chrome", build_type: "prod", app_version: "1" }));
    expect(res.status).toBe(200);
    expect(net.writes("app_errors")[0].json.code).toBe("session_check_unavailable");
  });

  describe("wallet (the app banner)", () => {
    const tokenReq = async (auth: Auth) => appRequest("POST", "/token", await auth.token(USER_A), { platform: "ios", build_type: "prod", app_version: "1" });
    const gate = (allow: boolean, reason: string, available: number, auto = false) =>
      ({ allow, reason, available_cents: available, floor_cents: 500, auto_topup_enabled: auto });

    it("PHONE_USAGE_METERS off (how it ships): ok, and the wallet is not even asked", async () => {
      const { net, auth, env } = await setup();
      const { json } = await call(env, await tokenReq(auth));
      expect(json.wallet).toEqual({ state: "ok", topping_up: false });
      expect(net.rpcCalls("wallet_usage_gate")).toEqual([]);
    });

    it.each([
      ["above twice the floor", gate(true, "above_floor", 1000), { state: "ok", topping_up: false }],
      ["above the floor but under twice it", gate(true, "above_floor", 999), { state: "low", topping_up: false }],
      ["exempt with nothing in it", gate(true, "exempt", 0), { state: "ok", topping_up: false }],
      ["below the floor, auto top-up off", gate(false, "below_floor", 10), { state: "blocked", topping_up: false }],
    ])("meters on, %s", async (_l, g, wallet) => {
      const { net, auth } = await setup();
      net.rpc("wallet_usage_gate", () => g);
      const env = makeEnv({ PHONE_USAGE_METERS: "on" });
      const { res, json } = await call(env, await tokenReq(auth));
      expect(res.status).toBe(200);
      expect(json.wallet).toEqual(wallet);
      expect(net.rpcCalls("wallet_usage_gate")[0].json).toEqual({ p_client_id: "demo-tenant", p_meter: "voice_minute" });
      expect(net.to(/wallet-autotopup/)).toEqual([]);
    });

    it("blocked with auto top-up on: topping_up, and a top-up is asked for", async () => {
      const { net, auth } = await setup();
      net.rpc("wallet_usage_gate", () => gate(false, "below_floor", 10, true));
      net.on("POST", (u) => u.href === `${SUPABASE_URL}/functions/v1/wallet-autotopup`, () => jsonRes({ fired: true, ok: true }));
      const { json } = await call(makeEnv({ PHONE_USAGE_METERS: "on" }), await tokenReq(auth));
      expect(json.wallet).toEqual({ state: "blocked", topping_up: true });
      expect(net.to(/wallet-autotopup/).map((s) => s.json)).toEqual([{ client_id: "demo-tenant" }]);
      expect(json.token).toBeTruthy(); // the line still works: incoming calls ring
    });

    it("a gate that fails reads ok, and the token is still issued", async () => {
      const { net, auth } = await setup();
      net.rpc("wallet_usage_gate", () => jsonRes({ message: "down" }, 500));
      const { res, json } = await call(makeEnv({ PHONE_USAGE_METERS: "on" }), await tokenReq(auth));
      expect(res.status).toBe(200);
      expect(json.wallet).toEqual({ state: "ok", topping_up: false });
    });
  });

  it("says whether this business's calls are recorded: the owner's choice AND the Worker's CALL_RECORDING rail", async () => {
    const on = { on: true, notice: true, notice_text: null, transcribe: true };
    const req = async (auth: Auth) => appRequest("POST", "/token", await auth.token(USER_A), { platform: "android", build_type: "prod", app_version: "1" });
    const s = await setup(callerCtx({ recording: on }));
    expect((await call(makeEnv({ CALL_RECORDING: "on" }), await req(s.auth))).json).toMatchObject({ recording: { on: true }, features: { recordings: true } });
    expect((await call(makeEnv(), await req(s.auth))).json.recording).toEqual({ on: false });
    s.net.rpc("phone_caller_context", () => callerCtx({ recording: { ...on, on: false } }));
    expect((await call(makeEnv({ CALL_RECORDING: "on" }), await req(s.auth))).json.recording).toEqual({ on: false });
    s.net.rpc("phone_caller_context", () => callerCtx()); // a database before 263
    expect((await call(makeEnv({ CALL_RECORDING: "on" }), await req(s.auth))).json.recording).toEqual({ on: false });
  });

  // Migration 264: the apps show who rings in your place while you're away from this answer.
  it("settings carry the cover (null when none is chosen), read from the caller's own row", async () => {
    const req = async (auth: Auth) => appRequest("POST", "/token", await auth.token(USER_A), { platform: "chrome", build_type: "prod", app_version: "1" });
    const s = await setup(undefined, [{ dnd: true, dnd_until: null, forward_to_cell: null, dnd_cover_user_id: USER_C }]);
    const { json } = await call(s.env, await req(s.auth));
    expect(json.settings).toEqual({ dnd: true, forward_to_cell: null, dnd_cover_user_id: USER_C, ring_hours: null, ring_hours_tz: null, greeting: { set: false, updated_at: null } });
    expect(s.net.reads("phone_user_settings")[0].url.searchParams.get("select")).toContain("dnd_cover_user_id");
    expect(filter(s.net.reads("phone_user_settings")[0], "user_id")).toBe(USER_A);
    const none = await setup(undefined, []);
    expect((await call(none.env, await req(none.auth))).json.settings).toEqual({ dnd: false, forward_to_cell: null, dnd_cover_user_id: null, ring_hours: null, ring_hours_tz: null, greeting: { set: false, updated_at: null } });
  });

  // Migration 264: the apps show the hours your phone rings (they're changed in Structure Studio).
  it("settings carry your own hours and their zone", async () => {
    const req = async (auth: Auth) => appRequest("POST", "/token", await auth.token(USER_A), { platform: "ios", build_type: "prod", app_version: "1" });
    const hours = { mon: [["08:00", "17:00"]], fri: [["08:00", "15:00"]] };
    const s = await setup(undefined, [{ dnd: false, dnd_until: null, forward_to_cell: null, dnd_cover_user_id: null, ring_hours: hours, ring_hours_tz: "America/Denver" }]);
    const { json } = await call(s.env, await req(s.auth));
    expect(json.settings).toMatchObject({ ring_hours: hours, ring_hours_tz: "America/Denver" });
    expect(s.net.reads("phone_user_settings")[0].url.searchParams.get("select")).toContain("ring_hours_tz");
    // Anything but an object (a database fault, say) reads as always.
    const odd = await setup(undefined, [{ dnd: false, ring_hours: [["08:00", "17:00"]], ring_hours_tz: null }]);
    expect((await call(odd.env, await req(odd.auth))).json.settings).toMatchObject({ ring_hours: null, ring_hours_tz: null });
  });

  // Migration 264: the apps offer Record, Play and "Use the standard greeting" from this answer.
  it("settings say whether you recorded your own greeting and when, never its sid", async () => {
    const req = async (auth: Auth) => appRequest("POST", "/token", await auth.token(USER_A), { platform: "android", build_type: "prod", app_version: "1" });
    const SID = "RE" + "0".repeat(31) + "4";
    const s = await setup(undefined, [{ dnd: false, dnd_until: null, forward_to_cell: null, greeting_recording_sid: SID, greeting_updated_at: "2026-10-05T15:01:00Z" }]);
    const { json, text } = await call(s.env, await req(s.auth));
    expect(json.settings.greeting).toEqual({ set: true, updated_at: "2026-10-05T15:01:00Z" });
    expect(text).not.toContain(SID);
    expect(s.net.reads("phone_user_settings")[0].url.searchParams.get("select")).toContain("greeting_recording_sid");
    // A time with no recording is not a greeting.
    const stray = await setup(undefined, [{ dnd: false, greeting_recording_sid: null, greeting_updated_at: "2026-10-05T15:01:00Z" }]);
    expect((await call(stray.env, await req(stray.auth))).json.settings.greeting).toEqual({ set: false, updated_at: null });
  });

  it("refuses a missing or bad login", async () => {
    const { env } = await setup();
    const none = await call(env, appRequest("POST", "/token", null, { platform: "chrome", build_type: "prod" }));
    expect(none.res.status).toBe(401);
    const junk = await call(env, appRequest("POST", "/token", "not.a.jwt", { platform: "chrome", build_type: "prod" }));
    expect(junk.json.error.code).toBe("unauthorized");
  });
});

// ── More than one number (migration 266) ────────────────────────────────────────────────────
describe("POST /token with more than one business number", () => {
  async function tokenFor(ctx: Record<string, unknown>) {
    const net = new FakeNet().install();
    const auth = await new Auth().init();
    auth.serve(net);
    net.rpc("phone_caller_context", () => ctx);
    net.rest("GET", "phone_user_settings", () => []);
    return call(makeEnv(), appRequest("POST", "/token", await auth.token(USER_A), { platform: "chrome", build_type: "prod" }));
  }

  it("`number` is the caller's own (the RPC's pick); `numbers` is every number of the business", async () => {
    const own = { id: "00000000-0000-4000-8000-00000000a002", e164: "+15555550102", voice_enabled: true, registration_status: "pending_registration" };
    const { res, json } = await tokenFor(callerCtx({ number: own, numbers: ["+15555550100", "+15555550101", "+15555550102"] }));
    expect(res.status).toBe(200);
    expect(json.number).toEqual({ e164: "+15555550102" });
    expect(json.numbers).toEqual(["+15555550100", "+15555550101", "+15555550102"]);
  });

  it("a database before 266 (no `numbers`): the one number; no number at all: none", async () => {
    const before = await tokenFor(callerCtx());
    expect(before.json.numbers).toEqual(["+15555550100"]);
    const none = await tokenFor(callerCtx({ number: null }));
    expect(none.json.number).toBeNull();
    expect(none.json.numbers).toEqual([]);
  });

  it("businessNumbersOf keeps E.164 strings only, once each, at most 50, with `number` always in it", () => {
    expect(businessNumbersOf(["+15555550100", "+15555550100", "nope", 7, null, " +15555550101 "], "+15555550100")).toEqual(["+15555550100", "+15555550101"]);
    expect(businessNumbersOf(["+15555550101"], "+15555550100")).toEqual(["+15555550100", "+15555550101"]);
    expect(businessNumbersOf("+15555550100", null)).toEqual([]);
    expect(businessNumbersOf(undefined, "+15555550100")).toEqual(["+15555550100"]);
    expect(businessNumbersOf(Array.from({ length: 80 }, (_, i) => `+1555555${String(1000 + i)}`), null)).toHaveLength(50);
    expect(NUMBER_ID).toMatch(/^[0-9a-f-]{36}$/);
  });
});
