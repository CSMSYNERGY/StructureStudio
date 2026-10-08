// Workstream 2, phase 5: every Twilio REST call, and every Voice token, in the account of the
// business it is for (src/twilioAccount.ts envForClient / callerTwilioEnv / webhookEnv /
// cronAccounts).
//
// What is pinned:
//   * /token: a business on its own sub-account gets a token signed with the SUB's key, for the
//     SUB's TwiML App and the SUB's push credential (all three from one account, or Twilio refuses
//     it: error 31203); what the sub lacks is left out, never borrowed from the parent; the setup
//     test stays on the parent (its Echo app is the parent's); a business on the parent and the
//     switch off are exactly today's token; a sub still being set up is refused;
//   * app routes run as the caller's business (one read, cached); webhooks as the account that
//     sent them, with the SID + auth token the signature check already holds (no lookup);
//   * crons: the sweep lists the parent AND each active sub, each with its own credentials, and a
//     sub's run files only its own business's recordings; retention and the backstop delete or
//     list in the row's business's account; switch off, not one extra request anywhere.
// Every SID, key and token below is made up.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { b64urlDecodeJson } from "../src/b64";
import { adminClient } from "../src/db";
import { installDenoShim } from "../src/env";
import { recordingSweep } from "../src/cron/sweep";
import { retention } from "../src/cron/retention";
import { recordingBackstop } from "../src/recording";
import { updateCall } from "../src/twilioRest";
import { cronAccounts, envForClient, webhookEnv, type WebhookAccount } from "../src/twilioAccount";
import {
  Auth, BASE, BUSINESS_NUMBER, CLIENT, CUSTOMER, FakeNet, USER_A, appRequest, call, callerCtx, filter, jsonRes, makeEnv, routeInfo,
} from "./helpers";

const PARENT = "AC" + "0".repeat(32);
const PARENT_KEY = "SK" + "0".repeat(32);
const SUB = "AC" + "5".repeat(32);
const SUB_KEY = "SK" + "5".repeat(32);
const SUB_APP = "AP" + "5".repeat(32);
const SUB_FCM = "CR" + "5".repeat(31) + "3";
const SUB_SECRET = "subkeysecret" + "x".repeat(20);
const SUB_TOKEN = "subauthtoken" + "y".repeat(20);
const OTHER = "other-builder";
const OTHER_SUB = "AC" + "6".repeat(32);
const OTHER_KEY = "SK" + "6".repeat(32);
const OTHER_SECRET = "otherkeysecret" + "z".repeat(18);
const HEX_A = USER_A.replace(/-/g, "");

const on = () => makeEnv({ TWILIO_SUBACCOUNTS: "on" });
const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;

function subRow(over: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT, kind: "sub", account_sid: SUB, status: "active",
    api_key_sid: SUB_KEY, api_secret: SUB_SECRET, auth_token: SUB_TOKEN,
    twiml_app_sid: SUB_APP, push_apns_dev_sid: null, push_apns_prod_sid: null, push_fcm_sid: SUB_FCM,
    ...over,
  };
}
const otherRow = () => ({
  client_id: OTHER, kind: "sub", account_sid: OTHER_SUB, status: "active", api_key_sid: OTHER_KEY, api_secret: OTHER_SECRET,
  auth_token: "othertoken" + "o".repeat(22), twiml_app_sid: null, push_apns_dev_sid: null, push_apns_prod_sid: null, push_fcm_sid: null,
});

function decode(jwt: string) {
  const [h, p, s] = jwt.split(".");
  return { payload: b64urlDecodeJson<any>(p), signed: `${h}.${p}`, sig: s };
}

// ── /token ───────────────────────────────────────────────────────────────────────────────────
describe("POST /token per account", () => {
  async function setup(env = on(), creds: (s: { json: any }) => unknown = () => [subRow()]) {
    const net = new FakeNet().install();
    const auth = await new Auth().init();
    auth.serve(net);
    net.rpc("phone_caller_context", () => callerCtx());
    net.rest("GET", "phone_user_settings", () => []);
    net.rpc("twilio_account_creds", creds);
    return { net, env, token: await auth.token(USER_A) };
  }

  it("a business on its own sub: signed with the SUB's key, for the SUB's app and push credential (31203: one account)", async () => {
    const { net, env, token } = await setup();
    const { json } = await call(env, appRequest("POST", "/token", token, { platform: "android", build_type: "prod" }));
    expect(json.ok).toBe(true);
    const { payload, signed, sig } = decode(json.token);
    expect(payload).toMatchObject({
      iss: SUB_KEY, sub: SUB,
      grants: { identity: `u_${HEX_A}_g1`, voice: { incoming: { allow: true }, outgoing: { application_sid: SUB_APP }, push_credential_sid: SUB_FCM } },
    });
    expect(sig).toBe(createHmac("sha256", SUB_SECRET).update(signed).digest("base64url"));
    expect(json.incoming_push).toBe(true);
    expect(net.rpcCalls("twilio_account_creds").map((s) => s.json)).toEqual([{ p_client_id: CLIENT }]);
  });

  it("a push credential the sub lacks is left out, never the parent's: the token still signs in, incoming_push false", async () => {
    const { env, token } = await setup();
    const { json } = await call(env, appRequest("POST", "/token", token, { platform: "ios", build_type: "prod" }));
    const { payload } = decode(json.token);
    expect(payload.iss).toBe(SUB_KEY);
    expect(payload.grants.voice.push_credential_sid).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(env.TWILIO_PUSH_CREDENTIAL_APNS_PROD!);
    expect(json.incoming_push).toBe(false);
  });

  it("the setup test stays on the parent: the parent's key and Echo app, and the account is not even looked up", async () => {
    const { net, env, token } = await setup();
    const { json } = await call(env, appRequest("POST", "/token", token, { platform: "android", build_type: "prod", preflight: true }));
    const { payload, signed, sig } = decode(json.token);
    expect(payload).toMatchObject({ iss: PARENT_KEY, sub: PARENT, grants: { voice: { outgoing: { application_sid: env.TWILIO_ECHO_APP_SID } } } });
    expect(sig).toBe(createHmac("sha256", "test-api-secret").update(signed).digest("base64url"));
    expect(net.rpcCalls("twilio_account_creds")).toHaveLength(0);
  });

  it("a business on the parent (switch on): today's token, after one lookup; switch off: today's token, no lookup", async () => {
    for (const [env, lookups] of [[on(), 1], [makeEnv(), 0]] as const) {
      const { net, token } = await setup(env, () => []);
      const { json } = await call(env, appRequest("POST", "/token", token, { platform: "android", build_type: "prod" }));
      const { payload } = decode(json.token);
      expect(payload).toMatchObject({ iss: PARENT_KEY, sub: PARENT, grants: { voice: { outgoing: { application_sid: env.TWILIO_TWIML_APP_SID }, push_credential_sid: env.TWILIO_PUSH_CREDENTIAL_FCM } } });
      expect(net.rpcCalls("twilio_account_creds")).toHaveLength(lookups);
    }
  });

  it("a sub still being set up: refused with a sentence, no token", async () => {
    const { env, token } = await setup(on(), () => [subRow({ status: "provisioning" })]);
    const { res, json } = await call(env, appRequest("POST", "/token", token, { platform: "android", build_type: "prod" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(json.error).toMatchObject({ code: "twilio_error", message: "Your phone account is still being set up. Try again in a few minutes." });
    expect(json.token).toBeUndefined();
  });

  it("a sub with no key yet: not configured (logged), never signed with the parent's key", async () => {
    const { net, env, token } = await setup(on(), () => [subRow({ api_key_sid: null, api_secret: null })]);
    net.rest("POST", "app_errors", () => []);
    const { json } = await call(env, appRequest("POST", "/token", token, { platform: "android", build_type: "prod" }));
    expect(json.ok).toBe(false);
    expect(json.token).toBeUndefined();
    const row = net.writes("app_errors").map((s) => s.json).find((r) => r.code === "token_not_configured");
    expect(row).toMatchObject({ client_id: CLIENT });
    expect(String(row.message)).toContain("sub-account");
  });
});

// ── App routes ───────────────────────────────────────────────────────────────────────────────
describe("app routes run as the caller's business", () => {
  const VM_ID = "00000000-0000-4000-8000-00000000f001";
  const CALL_ID = "00000000-0000-4000-8000-00000000ca11";
  async function vm(env = on()) {
    const net = new FakeNet().install();
    const auth = await new Auth().init();
    auth.serve(net);
    net.rpc("phone_caller_context", () => callerCtx({ phone_level: "view" }));
    net.rpc("twilio_account_creds", () => [subRow()]);
    net.rest("GET", "phone_voicemails", () => [{ id: VM_ID, call_id: CALL_ID, client_id: CLIENT, recording_sid: "RE" + "0".repeat(32), deleted_at: null, listened_at: null }]);
    net.rest("GET", "phone_calls", () => [{
      id: CALL_ID, client_id: CLIENT, number_id: null, contact_id: null, direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER,
      twilio_call_sid: null, client_call_sid: null, placed_by: null, answered_by: null, rang_user_ids: [USER_A], transferred_from: null,
      transfer_state: null, status: "voicemail", started_at: new Date().toISOString(), answered_at: null, ended_at: null, duration_s: null,
      error_code: null, is_emergency: false,
    }]);
    net.rest("PATCH", "phone_voicemails", () => []);
    net.on("GET", /Recordings\/RE0+\.mp3$/, () => new Response("ID3audio", { status: 200, headers: { "content-type": "audio/mpeg" } }));
    return { net, env, token: await auth.token(USER_A) };
  }

  it("a voicemail of a business on a sub is fetched from the SUB, with the sub's key", async () => {
    const { net, env, token } = await vm();
    const { res } = await call(env, appRequest("GET", `/voicemails/${VM_ID}/audio`, token));
    expect(res.status).toBe(200);
    const tw = net.to(/Recordings\/RE0+\.mp3$/);
    expect(tw[0].url.pathname).toBe(`/2010-04-01/Accounts/${SUB}/Recordings/RE${"0".repeat(32)}.mp3`);
    expect(tw[0].headers.get("authorization")).toBe(basic(SUB_KEY, SUB_SECRET));
  });

  it("switch off: the parent's, and twilio_account_creds is never asked", async () => {
    const { net, env, token } = await vm(makeEnv());
    await call(env, appRequest("GET", `/voicemails/${VM_ID}/audio`, token));
    expect(net.to(/Recordings\/RE0+\.mp3$/)[0].url.pathname).toBe(`/2010-04-01/Accounts/${PARENT}/Recordings/RE${"0".repeat(32)}.mp3`);
    expect(net.rpcCalls("twilio_account_creds")).toHaveLength(0);
  });

  it("the account is resolved once per isolate (cached), not once per request", async () => {
    const { net, env, token } = await vm();
    await call(env, appRequest("GET", `/voicemails/${VM_ID}/audio`, token));
    await call(env, appRequest("GET", `/voicemails/${VM_ID}/audio`, token));
    expect(net.rpcCalls("twilio_account_creds")).toHaveLength(1);
  });

  it("every app route that calls Twilio resolves the caller's account right after the login check", async () => {
    const routes: Record<string, string[]> = {
      "calls.ts": ["transfer", "voicemailAudio"], "conference.ts": ["hold", "resume", "warmTransfer"],
      "greeting.ts": ["recordGreeting", "myGreetingAudio", "clearGreeting"], "handoff.ts": ["startHandoff", "cancelHandoff"],
      "media.ts": ["mediaFile"], "recordings.ts": ["recordingAudio"],
    };
    for (const [file, fns] of Object.entries(routes)) {
      const src = readFileSync(resolve(process.cwd(), `src/routes/${file}`), "utf8").replace(/\r\n/g, "\n");
      for (const fn of fns) {
        const m = new RegExp(`export async function ${fn}\\([^)]*\\)[^{]*\\{\\n(?:  //[^\\n]*\\n)*  const c = await requireCaller\\([^\\n]*\\n(?:  //[^\\n]*\\n)*  env = await callerTwilioEnv\\(env, c\\);`).test(src);
        expect(m, `${file} ${fn}`).toBe(true);
      }
    }
    // NTS stays the parent's: /turn does not resolve an account.
    const me = readFileSync(resolve(process.cwd(), "src/routes/me.ts"), "utf8");
    expect(me).not.toContain("callerTwilioEnv");
  });
});

// ── Webhooks ─────────────────────────────────────────────────────────────────────────────────
describe("a webhook runs as the account that sent it", () => {
  it("a sub's webhook: its handler's REST calls go to the sub with the SID + token the signature was checked with, no lookup", async () => {
    const net = new FakeNet().install();
    net.on("POST", /api\.twilio\.com/, () => jsonRes({ sid: "CA" + "1".repeat(32) }));
    const sub: WebhookAccount = { source: "sub", accountSid: SUB, clientId: CLIENT, authToken: SUB_TOKEN };
    const env = webhookEnv(on(), sub);
    expect(env.TWILIO_WEBHOOK_ACCOUNT).toEqual(sub);
    expect(env.TWILIO_TWIML_APP_SID).toBeUndefined();
    expect(env.TWILIO_ECHO_APP_SID).toBe(makeEnv().TWILIO_ECHO_APP_SID);
    await updateCall(env, "CA" + "1".repeat(32), { Status: "completed" });
    const tw = net.to(/api\.twilio\.com/)[0];
    expect(tw.url.pathname).toBe(`/2010-04-01/Accounts/${SUB}/Calls/CA${"1".repeat(32)}.json`);
    expect(tw.headers.get("authorization")).toBe(basic(SUB, SUB_TOKEN));
    expect(net.rpcCalls("twilio_account_creds")).toHaveLength(0);
  });

  it("the parent's webhook: the parent's credentials, as today", async () => {
    const net = new FakeNet().install();
    net.on("POST", /api\.twilio\.com/, () => jsonRes({}));
    const env = webhookEnv(on(), { source: "parent", accountSid: PARENT, clientId: null, authToken: "test-auth-token" });
    await updateCall(env, "CA" + "1".repeat(32), { Status: "completed" });
    expect(net.to(/api\.twilio\.com/)[0].url.pathname).toBe(`/2010-04-01/Accounts/${PARENT}/Calls/CA${"1".repeat(32)}.json`);
    expect(net.to(/api\.twilio\.com/)[0].headers.get("authorization")).toBe(basic(PARENT_KEY, "test-api-secret"));
  });
});

// ── Crons ────────────────────────────────────────────────────────────────────────────────────
describe("crons per account", () => {
  const RE = (n: number) => "RE" + String(n).padStart(32, "0");
  const CA = (n: number) => "CA" + String(n).padStart(32, "0");

  it("cronAccounts: off, the parent alone and nothing read; on, the parent and every active sub, each scoped", async () => {
    const net = new FakeNet().install();
    const off = makeEnv();
    expect((await cronAccounts(off, adminClient(off))).map((a) => a.clientId)).toEqual([null]);
    expect(net.seen).toHaveLength(0);
    net.rest("GET", "twilio_accounts", (s) => {
      expect(filter(s, "kind")).toBe("sub");
      expect(filter(s, "status")).toBe("active");
      return [{ client_id: CLIENT }, { client_id: OTHER }, { client_id: "broken" }];
    });
    net.rpc("twilio_account_creds", (s) => (s.json.p_client_id === CLIENT ? [subRow()] : s.json.p_client_id === OTHER ? [otherRow()] : jsonRes({ code: "57014" }, 500)));
    net.rest("POST", "app_errors", () => []);
    const env = on();
    const accts = await cronAccounts(env, adminClient(env));
    expect(accts.map((a) => [a.clientId, a.env.TWILIO_ACCOUNT_SID])).toEqual([[null, PARENT], [CLIENT, SUB], [OTHER, OTHER_SUB]]);
    expect(accts[0].env).toBe(env);
  });

  it("the sweep lists the parent and each sub with its own credentials, and a sub files only its own business's", async () => {
    const net = new FakeNet().install();
    const env = on();
    installDenoShim(env);
    const now = new Date("2026-09-29T12:00:00Z");
    net.rest("GET", "twilio_accounts", () => [{ client_id: CLIENT }, { client_id: OTHER }]);
    net.rpc("twilio_account_creds", (s) => (s.json.p_client_id === CLIENT ? [subRow()] : [otherRow()]));
    const rec = (n: number) => ({ sid: RE(n), call_sid: CA(n), source: "RecordVerb", status: "completed", duration: "12", date_created: "Tue, 29 Sep 2026 11:50:00 +0000" });
    net.on("GET", (u) => u.pathname === `/2010-04-01/Accounts/${PARENT}/Recordings.json`, () => jsonRes({ recordings: [], next_page_uri: null }));
    net.on("GET", (u) => u.pathname === `/2010-04-01/Accounts/${SUB}/Recordings.json`, () => jsonRes({ recordings: [rec(1)], next_page_uri: null }));
    // OTHER's sub lists a recording whose number routes to CLIENT: never filed by OTHER's run.
    net.on("GET", (u) => u.pathname === `/2010-04-01/Accounts/${OTHER_SUB}/Recordings.json`, () => jsonRes({ recordings: [rec(2)], next_page_uri: null }));
    net.on("GET", /\/Calls\/CA0+[12]\.json$/, (s) => jsonRes({ sid: s.url.pathname.includes("CA" + "0".repeat(31) + "1") ? CA(1) : CA(2), from: CUSTOMER, to: BUSINESS_NUMBER, direction: "inbound", status: "completed", start_time: null }));
    net.rpc("phone_route_for_number", () => routeInfo());
    net.rest("GET", "phone_voicemails", () => []);
    net.rest("GET", "phone_user_settings", () => []);
    let inserted: Record<string, unknown> | null = null;
    net.rest("GET", "phone_calls", (s) => (inserted && filter(s, "id") === inserted.id ? [{ ...inserted, rang_user_ids: [], transfer_state: null }] : []));
    net.rest("GET", "crm_contacts", () => []);
    net.rest("POST", "phone_calls", (s) => { inserted = s.json; return []; });
    net.rest("POST", "phone_voicemails", () => []);
    net.rest("PATCH", "phone_calls", () => []);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);
    const out = await recordingSweep(env, now);
    expect(out.filed).toBe(1);
    const lists = net.to(/Recordings\.json/);
    expect(lists.map((s) => [s.url.pathname.split("/")[3], s.headers.get("authorization")])).toEqual([
      [PARENT, basic(PARENT_KEY, "test-api-secret")], [SUB, basic(SUB_KEY, SUB_SECRET)], [OTHER_SUB, basic(OTHER_KEY, OTHER_SECRET)],
    ]);
    expect(net.to(/\/Calls\/CA0+1\.json$/)[0].url.pathname.startsWith(`/2010-04-01/Accounts/${SUB}/`)).toBe(true);
    expect(net.writes("phone_voicemails").map((s) => s.json.recording_sid)).toEqual([RE(1)]);
  });

  it("the sweep with the switch off: the parent alone, no twilio_accounts read", async () => {
    const net = new FakeNet().install();
    const env = makeEnv();
    installDenoShim(env);
    net.on("GET", /Recordings\.json/, () => jsonRes({ recordings: [], next_page_uri: null }));
    await recordingSweep(env, new Date());
    expect(net.reads("twilio_accounts")).toHaveLength(0);
    expect(net.rpcCalls("twilio_account_creds")).toHaveLength(0);
    expect(net.to(/Recordings\.json/).map((s) => s.url.pathname.split("/")[3])).toEqual([PARENT]);
  });

  it("retention deletes each recording in its business's account; a sub that cannot be resolved fails that row only", async () => {
    const net = new FakeNet().install();
    const env = on();
    net.rest("GET", "phone_voicemails", () => [
      { id: "v1", recording_sid: RE(1), client_id: CLIENT }, { id: "v2", recording_sid: RE(2), client_id: "parent-builder" },
      { id: "v3", recording_sid: RE(3), client_id: "broken" },
    ]);
    net.rpc("twilio_account_creds", (s) => (s.json.p_client_id === CLIENT ? [subRow()] : s.json.p_client_id === "broken" ? jsonRes({ code: "57014" }, 500) : []));
    net.on("DELETE", /Recordings\/RE/, () => new Response(null, { status: 204 }));
    net.rest("PATCH", "phone_voicemails", () => []);
    net.rest("POST", "app_errors", () => []);
    const out = await retention(env, new Date("2027-12-01T00:00:00Z"));
    expect(out).toEqual({ deleted: 2, failed: 1 });
    expect(net.to(/Recordings\/RE/).map((s) => [s.url.pathname.split("/")[3], s.headers.get("authorization")])).toEqual([
      [SUB, basic(SUB_KEY, SUB_SECRET)], [PARENT, basic(PARENT_KEY, "test-api-secret")],
    ]);
  });

  it("the recording backstop lists a call's recordings in its business's account", async () => {
    const net = new FakeNet().install();
    const env = on();
    net.rest("GET", "phone_call_recordings", () => [{
      id: "r1", call_id: "c1", client_id: CLIENT, recording_sid: null, status: "recording", created_at: "2026-09-29T10:00:00Z",
      phone_calls: { twilio_call_sid: CA(7), ended_at: "2026-09-29T10:05:00Z" },
    }]);
    net.rpc("twilio_account_creds", () => [subRow()]);
    net.on("GET", /\/Calls\/CA0+7\/Recordings\.json/, () => jsonRes({ recordings: [] }));
    await recordingBackstop(env, adminClient(env), new Date("2026-09-29T12:00:00Z"));
    const tw = net.to(/\/Calls\/CA0+7\/Recordings\.json/)[0];
    expect(tw.url.pathname.startsWith(`/2010-04-01/Accounts/${SUB}/`)).toBe(true);
    expect(tw.headers.get("authorization")).toBe(basic(SUB_KEY, SUB_SECRET));
  });

  it("transcription fetches each call's audio from its business's account", async () => {
    const net = new FakeNet().install();
    const REC_SID = "RE" + "0".repeat(31) + "9";
    net.rpc("phone_recordings_claim", () => [{ id: "r1", call_id: "c1", client_id: CLIENT, recording_sid: REC_SID, duration_s: 60, channel_map: { 0: "customer", 1: "team" }, attempts: 1 }]);
    net.rest("GET", "client_settings", () => [{ client_id: CLIENT, phone_transcribe_calls: true }]);
    net.rpc("twilio_account_creds", () => [subRow()]);
    net.on("GET", (u) => u.pathname.endsWith(`/Recordings/${REC_SID}.mp3`), () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    net.rest("PATCH", "phone_call_recordings", () => [{ id: "r1" }]);
    net.rest("GET", "phone_call_recordings", () => []);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);
    const env = { ...makeEnv({ TWILIO_SUBACCOUNTS: "on", CALL_RECORDING: "on", CALL_TRANSCRIBE: "on" }), AI: { run: async () => ({ results: { channels: [] } }) } as unknown as Ai };
    installDenoShim(env);
    const { runTranscriptions } = await import("../src/cron/transcribe");
    const out = await runTranscriptions(env, adminClient(env), new Date("2026-10-04T12:00:00Z"));
    expect(out.done).toBe(1);
    const tw = net.to(/Recordings\/RE0+9\.mp3/)[0];
    expect(tw.url.pathname.startsWith(`/2010-04-01/Accounts/${SUB}/`)).toBe(true);
    expect(tw.headers.get("authorization")).toBe(basic(SUB_KEY, SUB_SECRET));
  });

  it("envForClient: off is the same env with no lookup; a parent tenant is cached 30 s, a sub 60 s; failures are not kept", async () => {
    const net = new FakeNet().install();
    const off = makeEnv();
    expect(await envForClient(off, adminClient(off), CLIENT)).toBe(off);
    expect(net.seen).toHaveLength(0);
    let n = 0;
    net.rpc("twilio_account_creds", () => (++n === 1 ? jsonRes({ code: "57014" }, 500) : [subRow()]));
    const env = on();
    const t0 = 1_000_000;
    await expect(envForClient(env, adminClient(env), CLIENT, t0)).rejects.toThrow();
    expect((await envForClient(env, adminClient(env), CLIENT, t0)).TWILIO_ACCOUNT_SID).toBe(SUB);
    expect((await envForClient(env, adminClient(env), CLIENT, t0 + 59_000)).TWILIO_ACCOUNT_SID).toBe(SUB);
    expect(n).toBe(2);
    await envForClient(env, adminClient(env), CLIENT, t0 + 61_000);
    expect(n).toBe(3);
  });
});

describe("source wiring", () => {
  it("the webhook router hands its handlers webhookEnv's Env; the greeting audio and the usage charges resolve per business", async () => {
    const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
    expect(read("src/index.ts")).toContain("const env = webhookEnv(envIn, check.account);");
    const greeting = read("src/greeting.ts");
    expect(greeting).toContain("const acct = on ? await envForClient(env, admin, String(row.client_id ?? \"\")) : env;");
    expect(greeting).toContain("media = await recordingMedia(acct, sid, req.headers.get(\"range\"));");
    const usage = read("src/cron/usageCharge.ts");
    expect(usage).toContain("const r = subaccountsOnFor(run.env) ? { ...run, env: await envForClient(run.env, run.admin, row.client_id) } : run;");
    for (const f of ["chargeCall(r,", "chargeSms(r,", "chargeRecording(r,", "chargeTranscription(r,"]) expect(usage).toContain(f);
    expect(read("src/cron/transcribe.ts")).toContain("recordingMedia(await envForClient(env, admin, row.client_id), row.recording_sid, null, 2)");
    // The base URL constant is only here to keep helpers' imports used.
    expect(BASE).toMatch(/^https:/);
  });
});
