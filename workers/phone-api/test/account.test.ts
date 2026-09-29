// /health, CORS, /settings/me, /devices, /devices/signout-all, /log, /turn, /calls/:id/events,
// /voicemails/:id/audio.
import { describe, expect, it } from "vitest";
import {
  Auth, BASE, BUSINESS_NUMBER, CLIENT, CUSTOMER, FakeNet, USER_A, USER_B,
  appRequest, call, callerCtx, filter, jsonRes, makeEnv,
} from "./helpers";

async function setup(ctx: Record<string, unknown> | null = callerCtx()) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  net.rpc("phone_caller_context", () => ctx);
  net.rest("POST", "app_errors", () => []);
  return { net, auth, token: await auth.token(USER_A), env: makeEnv() };
}

describe("/health and CORS", () => {
  it("reports the version", async () => {
    new FakeNet().install();
    const { json } = await call(makeEnv({ CF_VERSION_METADATA: { id: "ver-1" } }), new Request(`${BASE}/health`));
    expect(json).toEqual({ ok: true, version: "0.1.0", deployment: "ver-1" });
  });

  it("keep-warm: /health?warm=1 makes one tiny DB read and reports it", async () => {
    const net = new FakeNet().install();
    net.rest("GET", "sms_numbers", () => [{ id: "x" }]);
    const { json } = await call(makeEnv(), new Request(`${BASE}/health?warm=1`));
    expect(json.warm).toBe(true);
    expect(json.db).toBe(true);
    expect(net.reads("sms_numbers")).toHaveLength(1);
  });

  it("answers preflight for the extension ids and the portal hosts only", async () => {
    new FakeNet().install();
    const env = makeEnv();
    const pre = (origin: string) => call(env, new Request(`${BASE}/sms/send`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } }));
    const ext = await pre("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    expect(ext.res.status).toBe(204);
    expect(ext.res.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    expect(ext.res.headers.get("access-control-allow-headers")).toContain("authorization");
    expect((await pre("https://app.structurestudiosuite.com")).res.headers.get("access-control-allow-origin")).toBe("https://app.structurestudiosuite.com");
    expect((await pre("chrome-extension://someoneelsesextensionid")).res.headers.get("access-control-allow-origin")).toBeNull();
    expect((await pre("https://evil.example.test")).res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("puts CORS on errors too, so the extension can read the reason", async () => {
    await setup();
    const res = (await call(makeEnv(), appRequest("GET", "/calls", null, undefined, { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }))).res;
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
  });

  it("a malformed path escape is a bad request, not a fault", async () => {
    const { token, env } = await setup();
    const { res, json } = await call(env, appRequest("GET", "/threads/%E0%A4%A", token));
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("bad_request");
  });

  it("unknown paths and methods are JSON errors", async () => {
    new FakeNet().install();
    expect((await call(makeEnv(), new Request(`${BASE}/nope`))).json.error.code).toBe("not_found");
    expect((await call(makeEnv(), new Request(`${BASE}/token`))).res.status).toBe(405);
  });
});

describe("POST /settings/me", () => {
  it("saves DND and a forwarding cell (upsert on user_id) and returns them", async () => {
    const { net, token, env } = await setup();
    net.rest("POST", "phone_user_settings", (s) => [{ dnd: s.json.dnd, dnd_until: null, forward_to_cell: s.json.forward_to_cell }]);
    const { json } = await call(env, appRequest("POST", "/settings/me", token, { dnd: true, forward_to_cell: "(555) 555-0177" }));
    expect(json).toEqual({ ok: true, settings: { dnd: true, dnd_until: null, forward_to_cell: "+15555550177" } });
    const w = net.writes("phone_user_settings")[0];
    expect(w.json).toMatchObject({ user_id: USER_A, client_id: CLIENT, dnd: true, forward_to_cell: "+15555550177" });
    expect(w.url.searchParams.get("on_conflict")).toBe("user_id");
    expect(w.headers.get("prefer")).toContain("resolution=merge-duplicates");
  });

  it.each([
    [{ dnd: "yes" }, "Do Not Disturb must be on or off."],
    [{ dnd: true, dnd_until: "2000-01-01T00:00:00Z" }, "Pick an end time for Do Not Disturb within the next 30 days."],
    [{ forward_to_cell: "12" }, "That cell number isn't a US or Canadian number."],
    [{ forward_to_cell: BUSINESS_NUMBER }, "That's your business number. Enter your own cell phone."],
  ])("refuses %j", async (body, message) => {
    const { token, env } = await setup();
    const { json } = await call(env, appRequest("POST", "/settings/me", token, body));
    expect(json.error).toEqual({ code: "bad_request", message });
  });
});

describe("POST /devices", () => {
  it("registers a phone's push token, releasing it from anyone else who used this device", async () => {
    const { net, token, env } = await setup();
    net.rest("DELETE", "phone_devices", () => []);
    net.rest("POST", "phone_devices", () => []);
    const { json } = await call(env, appRequest("POST", "/devices", token, { platform: "android", build_type: "prod", push_token: "fcm:tok_123", push_kind: "fcm", app_version: "1.0.0" }));
    expect(json).toEqual({ ok: true });
    const del = net.writes("phone_devices", "DELETE")[0];
    expect(filter(del, "push_token")).toBe("fcm:tok_123");
    expect(del.url.searchParams.get("user_id")).toBe(`neq.${USER_A}`);
    const up = net.writes("phone_devices", "POST")[0];
    expect(up.url.searchParams.get("on_conflict")).toBe("user_id,platform,push_token");
    expect(up.json).toMatchObject({ user_id: USER_A, client_id: CLIENT, platform: "android", push_kind: "fcm", build_type: "prod" });
  });

  it("keeps one row per person for the extension (no token)", async () => {
    const { net, token, env } = await setup();
    net.rest("GET", "phone_devices", () => [{ id: "d1" }]);
    net.rest("PATCH", "phone_devices", () => []);
    await call(env, appRequest("POST", "/devices", token, { platform: "chrome", build_type: "prod", push_token: null, push_kind: null, app_version: "0.1" }));
    expect(filter(net.writes("phone_devices", "PATCH")[0], "id")).toBe("d1");
  });

  it("refuses a token that doesn't match the platform", async () => {
    const { token, env } = await setup();
    const { json } = await call(env, appRequest("POST", "/devices", token, { platform: "ios", build_type: "prod", push_token: "abc", push_kind: "fcm", app_version: "1" }));
    expect(json.error.code).toBe("bad_request");
  });
});

describe("POST /devices/signout-all", () => {
  it("bumps the generation (compare-and-swap), forgets devices, and signs out every session", async () => {
    const { net, token, env } = await setup();
    net.rest("GET", "phone_user_settings", () => [{ device_generation: 3 }]);
    net.rest("PATCH", "phone_user_settings", () => [{ user_id: USER_A }]);
    net.rest("DELETE", "phone_devices", () => []);
    net.on("POST", (u) => u.pathname === "/auth/v1/logout", () => new Response(null, { status: 204 }));
    const { json } = await call(env, appRequest("POST", "/devices/signout-all", token, {}));
    expect(json).toEqual({ ok: true });
    const bump = net.writes("phone_user_settings", "PATCH")[0];
    expect(bump.json.device_generation).toBe(4);
    expect(bump.url.searchParams.get("device_generation")).toBe("eq.3");
    expect(filter(net.writes("phone_devices", "DELETE")[0], "user_id")).toBe(USER_A);
    const logout = net.to(/\/auth\/v1\/logout/)[0];
    expect(logout.url.searchParams.get("scope")).toBe("global");
    expect(logout.headers.get("authorization")).toBe(`Bearer ${token}`);
  });

  it("works even after phone access was removed (the lost-phone lock must not depend on it)", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "none" }));
    net.rest("GET", "phone_user_settings", () => [{ device_generation: 1 }]);
    net.rest("PATCH", "phone_user_settings", () => [{ user_id: USER_A }]);
    net.rest("DELETE", "phone_devices", () => []);
    net.on("POST", (u) => u.pathname === "/auth/v1/logout", () => new Response(null, { status: 204 }));
    expect((await call(env, appRequest("POST", "/devices/signout-all", token, {}))).json).toEqual({ ok: true });
  });

  it("says so when the session sign-out fails", async () => {
    const { net, token, env } = await setup();
    net.rest("GET", "phone_user_settings", () => [{ device_generation: 1 }]);
    net.rest("PATCH", "phone_user_settings", () => [{ user_id: USER_A }]);
    net.rest("DELETE", "phone_devices", () => []);
    net.on("POST", (u) => u.pathname === "/auth/v1/logout", () => jsonRes({ msg: "down" }, 500));
    const { json } = await call(env, appRequest("POST", "/devices/signout-all", token, {}));
    expect(json.error.code).toBe("internal");
    expect(json.error.message).toContain("couldn't sign out your other sessions");
  });
});

describe("POST /log", () => {
  it("records app errors with the severity the app chose", async () => {
    const { net, token, env } = await setup();
    const { json } = await call(env, appRequest("POST", "/log", token, {
      source: "sss-phone-extension", severity: "warn", code: "mic_denied", message: "Microphone blocked", context: { step: "welcome" }, app_version: "0.3.1",
    }, { "user-agent": "TestAgent/1" }));
    expect(json).toEqual({ ok: true });
    const row = net.writes("app_errors")[0].json;
    expect(row).toMatchObject({
      source: "sss-phone-extension", severity: "warn", code: "mic_denied", message: "Microphone blocked", client_id: CLIENT,
      user_agent: "TestAgent/1", context: { step: "welcome", app_version: "0.3.1", user_id: USER_A },
    });
  });

  it("refuses any other source (the apps cannot write as edge functions)", async () => {
    const { token, env } = await setup();
    const { json } = await call(env, appRequest("POST", "/log", token, { source: "edge:phone-api", message: "x" }));
    expect(json.error.code).toBe("bad_request");
  });
});

describe("GET /turn", () => {
  it("returns Twilio NTS ice servers", async () => {
    const { net, token, env } = await setup();
    net.on("POST", /Tokens\.json$/, () => jsonRes({ ice_servers: [{ urls: "turn:global.turn.example.test:443?transport=tcp", username: "u", credential: "c" }] }, 201));
    const { json } = await call(env, appRequest("GET", "/turn", token));
    expect(json.ice_servers).toHaveLength(1);
    expect(new URLSearchParams(net.to(/Tokens\.json$/)[0].body).get("Ttl")).toBe("3600");
  });
});

const CALL_ID = "00000000-0000-4000-8000-0000000ca444";
const VM_ID = "00000000-0000-4000-8000-0000000fe001";
function callRow(over: Record<string, unknown> = {}) {
  return {
    id: CALL_ID, client_id: CLIENT, number_id: null, contact_id: null, direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER,
    twilio_call_sid: null, client_call_sid: null, placed_by: null, answered_by: null, rang_user_ids: [USER_A],
    transferred_from: null, transfer_state: null, status: "voicemail", started_at: new Date().toISOString(),
    answered_at: null, ended_at: null, duration_s: null, error_code: null, is_emergency: false, ...over,
  };
}

describe("POST /calls/:id/events", () => {
  it("records a timing mark on a call the caller took part in", async () => {
    const { net, token, env } = await setup();
    net.rest("GET", "phone_calls", () => [callRow({ placed_by: USER_A, direction: "out" })]);
    net.rest("POST", "phone_call_events", () => []);
    const at = Date.now() - 500;
    const { json } = await call(env, appRequest("POST", `/calls/${CALL_ID}/events`, token, { type: "connect", at_ms: at, data: { ms: 42 } }));
    expect(json).toEqual({ ok: true });
    expect(net.writes("phone_call_events")[0].json).toEqual({ call_id: CALL_ID, type: "connect", at: new Date(at).toISOString(), data: { ms: 42, source: "app", user: USER_A } });
  });

  it("refuses someone else's call", async () => {
    const { net, token, env } = await setup();
    net.rest("GET", "phone_calls", () => [callRow({ rang_user_ids: [USER_B], answered_by: USER_B })]);
    expect((await call(env, appRequest("POST", `/calls/${CALL_ID}/events`, token, { type: "connect", at_ms: Date.now() }))).json.error.code).toBe("not_found");
  });
});

describe("GET /voicemails/:id/audio", () => {
  async function vmSetup(callOver: Record<string, unknown>, ctx = callerCtx()) {
    const s = await setup(ctx);
    s.net.rest("GET", "phone_voicemails", () => [{ id: VM_ID, call_id: CALL_ID, client_id: CLIENT, recording_sid: "RE" + "0".repeat(32), deleted_at: null, listened_at: null }]);
    s.net.rest("GET", "phone_calls", () => [callRow(callOver)]);
    s.net.rest("PATCH", "phone_voicemails", () => []);
    s.net.on("GET", /Recordings\/RE0+\.mp3$/, () => new Response("ID3audio", { status: 200, headers: { "content-type": "audio/mpeg", "content-length": "8" } }));
    return s;
  }

  it("streams the recording with the Worker's own Twilio credentials (?access_token=, still taken for extension builds from before 2026-09-29) and marks it heard", async () => {
    const { net, token, env } = await vmSetup({});
    const { res, text } = await call(env, new Request(`${BASE}/voicemails/${VM_ID}/audio?access_token=${token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(text).toBe("ID3audio");
    expect(net.to(/Recordings\/RE0+\.mp3$/)[0].headers.get("authorization")).toMatch(/^Basic /);
    const heard = net.writes("phone_voicemails", "PATCH")[0];
    expect(heard.json).toMatchObject({ listened_by: USER_A });
    expect(heard.url.searchParams.get("listened_at")).toBe("is.null");
  });

  it("refuses a voicemail that isn't the caller's (own level, rang someone else)", async () => {
    const { net, token, env } = await vmSetup({ rang_user_ids: [USER_B] });
    const { res } = await call(env, appRequest("GET", `/voicemails/${VM_ID}/audio`, token));
    expect(res.status).toBe(404);
    expect(net.to(/Recordings/)).toEqual([]);
  });

  it("team level may play the team's voicemails", async () => {
    const { token, env } = await vmSetup({ rang_user_ids: [USER_B] }, callerCtx({ phone_level: "view" }));
    expect((await call(env, appRequest("GET", `/voicemails/${VM_ID}/audio`, token))).res.status).toBe(200);
  });

  it("refuses a voicemail on another tenant", async () => {
    const { net, token, env } = await vmSetup({});
    net.rest("GET", "phone_voicemails", () => [{ id: VM_ID, call_id: CALL_ID, client_id: "other-tenant", recording_sid: "RE" + "0".repeat(32), deleted_at: null, listened_at: null }]);
    expect((await call(env, appRequest("GET", `/voicemails/${VM_ID}/audio`, token))).res.status).toBe(404);
  });
});

describe("the query-string token is only for audio", () => {
  it("other endpoints ignore ?access_token=", async () => {
    const { token, env } = await setup();
    expect((await call(env, new Request(`${BASE}/calls?access_token=${token}`))).res.status).toBe(401);
  });
});
