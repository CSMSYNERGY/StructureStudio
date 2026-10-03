import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintAccessToken, pushCredentialFor } from "../src/accessToken";
import { b64urlDecodeJson } from "../src/b64";
import { Auth, FakeNet, SUPABASE_URL, USER_A, appRequest, call, callerCtx, jsonRes, makeEnv } from "./helpers";

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

  it("refuses a missing or bad login", async () => {
    const { env } = await setup();
    const none = await call(env, appRequest("POST", "/token", null, { platform: "chrome", build_type: "prod" }));
    expect(none.res.status).toBe(401);
    const junk = await call(env, appRequest("POST", "/token", "not.a.jwt", { platform: "chrome", build_type: "prod" }));
    expect(junk.json.error.code).toBe("unauthorized");
  });
});
