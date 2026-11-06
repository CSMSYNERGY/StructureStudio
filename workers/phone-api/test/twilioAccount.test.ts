// Workstream 2: which Twilio account a request runs in (src/twilioAccount.ts, over the shared
// supabase/functions/_shared/twilioAccount.ts). Phase 2: the scoped Env twilioRest.ts runs with.
// Phase 4: the account a webhook came from, and the tenant it may touch.
//
// The switch is TWILIO_SUBACCOUNTS. Off (the default, unset), every case here must be exactly the
// Worker before sub-accounts: the same env object, and not one request to the database.
// Every SID and secret below is made up.
import { describe, expect, it } from "vitest";
import { adminClient } from "../src/db";
import { updateCall } from "../src/twilioRest";
import {
  scopedTwilioEnv, tenantMatchesWebhook, TwilioAccountError, twilioEnvFor, webhookEnv, type WebhookAccount,
} from "../src/twilioAccount";
import { CLIENT, FakeNet, jsonRes, makeEnv } from "./helpers";

const PARENT = "AC" + "0".repeat(32);
const SUB = "AC" + "5".repeat(32);
const SUB_KEY = "SK" + "5".repeat(32);
const SUB_APP = "AP" + "5".repeat(32);
const SUB_FCM = "CR" + "5".repeat(31) + "3";
const SUB_SECRET = "subkeysecret" + "x".repeat(20);
const SUB_TOKEN = "subauthtoken" + "y".repeat(20);

const on = () => makeEnv({ TWILIO_SUBACCOUNTS: "on" });

/** twilio_account_creds' row for an active sub of CLIENT (migration 292). */
function subRow(over: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT, kind: "sub", account_sid: SUB, status: "active",
    api_key_sid: SUB_KEY, api_secret: SUB_SECRET, auth_token: SUB_TOKEN,
    twiml_app_sid: SUB_APP, push_apns_dev_sid: null, push_apns_prod_sid: null, push_fcm_sid: SUB_FCM,
    ...over,
  };
}

describe("twilioEnvFor: the scoped Env (phase 2)", () => {
  it("switch OFF: the same env object, and nothing is asked of the database", async () => {
    const net = new FakeNet().install();
    for (const sub of [undefined, "off", "ON", "true"]) {
      const env = makeEnv({ TWILIO_SUBACCOUNTS: sub });
      expect(await twilioEnvFor(env, adminClient(env), { clientId: CLIENT })).toBe(env);
      expect(await twilioEnvFor(env, adminClient(env), { accountSid: SUB })).toBe(env);
    }
    expect(net.seen).toHaveLength(0);
  });

  it("switch on, a tenant with no row (or a parent row): the env itself, after one lookup", async () => {
    const net = new FakeNet().install();
    net.rpc("twilio_account_creds", (s) => (s.json?.p_client_id === CLIENT ? [] : [{ client_id: "pinned", kind: "parent", account_sid: null, status: "active" }]));
    const env = on();
    expect(await twilioEnvFor(env, adminClient(env), { clientId: CLIENT })).toBe(env);
    expect(await twilioEnvFor(env, adminClient(env), { clientId: "pinned" })).toBe(env);
    expect(net.rpcCalls("twilio_account_creds").map((s) => s.json)).toEqual([{ p_client_id: CLIENT }, { p_client_id: "pinned" }]);
  });

  it("switch on, an active sub: every account value is the sub's; what the sub lacks is CLEARED, never the parent's", async () => {
    const net = new FakeNet().install();
    net.rpc("twilio_account_creds", () => [subRow()]);
    const env = on();
    const scoped = await twilioEnvFor(env, adminClient(env), { clientId: CLIENT });
    expect(scoped).not.toBe(env);
    expect(scoped).toMatchObject({
      TWILIO_ACCOUNT_SID: SUB, TWILIO_API_KEY: SUB_KEY, TWILIO_API_SECRET: SUB_SECRET, TWILIO_AUTH_TOKEN: SUB_TOKEN,
      TWILIO_TWIML_APP_SID: SUB_APP, TWILIO_PUSH_CREDENTIAL_FCM: SUB_FCM,
    });
    // A token signed with the sub's key for the parent's push credential is Twilio error 31203.
    expect(scoped.TWILIO_PUSH_CREDENTIAL_APNS_DEV).toBeUndefined();
    expect(scoped.TWILIO_PUSH_CREDENTIAL_APNS_PROD).toBeUndefined();
    // Not the account's: the setup test, the webhook secret and Supabase stay as they are.
    expect(scoped.TWILIO_ECHO_APP_SID).toBe(env.TWILIO_ECHO_APP_SID);
    expect(scoped.PHONE_WEBHOOK_SECRET).toBe(env.PHONE_WEBHOOK_SECRET);
    expect(scoped.SUPABASE_URL).toBe(env.SUPABASE_URL);
    // The caller's env is untouched (it is the isolate's, shared with every other request).
    expect(env.TWILIO_ACCOUNT_SID).toBe(PARENT);
  });

  it("twilioRest.ts runs as the scoped account: the sub's path and the sub's key, nothing of the parent's", async () => {
    const net = new FakeNet().install();
    net.rpc("twilio_account_creds", () => [subRow()]);
    net.on("POST", /api\.twilio\.com/, () => jsonRes({ sid: "CA" + "1".repeat(32) }));
    const env = on();
    await updateCall(await twilioEnvFor(env, adminClient(env), { clientId: CLIENT }), "CA" + "1".repeat(32), { Status: "completed" });
    const tw = net.to(/api\.twilio\.com/);
    expect(tw).toHaveLength(1);
    expect(tw[0].url.pathname).toBe(`/2010-04-01/Accounts/${SUB}/Calls/CA${"1".repeat(32)}.json`);
    expect(tw[0].headers.get("authorization")).toBe(`Basic ${btoa(`${SUB_KEY}:${SUB_SECRET}`)}`);
    // And with the switch off, the parent's, exactly as before.
    const net2 = new FakeNet().install();
    net2.on("POST", /api\.twilio\.com/, () => jsonRes({ sid: "CA" + "1".repeat(32) }));
    const off = makeEnv();
    await updateCall(await twilioEnvFor(off, adminClient(off), { clientId: CLIENT }), "CA" + "1".repeat(32), { Status: "completed" });
    expect(net2.to(/api\.twilio\.com/)[0].url.pathname).toBe(`/2010-04-01/Accounts/${PARENT}/Calls/CA${"1".repeat(32)}.json`);
    expect(net2.to(/api\.twilio\.com/)[0].headers.get("authorization")).toBe(`Basic ${btoa(`SK${"0".repeat(32)}:test-api-secret`)}`);
  });

  it("a sub with only its auth token (no key yet) runs as AccountSid:token", () => {
    const scoped = scopedTwilioEnv(makeEnv(), {
      accountSid: SUB, user: SUB, pass: SUB_TOKEN, source: "sub", clientId: CLIENT, authToken: SUB_TOKEN,
      twimlAppSid: null, pushApnsDevSid: null, pushApnsProdSid: null, pushFcmSid: null,
    });
    expect(scoped.TWILIO_API_KEY).toBeUndefined();
    expect(scoped.TWILIO_API_SECRET).toBeUndefined();
    expect(scoped.TWILIO_AUTH_TOKEN).toBe(SUB_TOKEN);
    expect(scoped.TWILIO_TWIML_APP_SID).toBeUndefined();
  });

  it.each([
    ["provisioning", "not_ready"], ["suspended", "not_ready"], ["closed", "not_ready"], ["failed", "not_ready"],
  ])("a sub that is %s is refused (%s), never run as the parent", async (status, kind) => {
    const net = new FakeNet().install();
    net.rpc("twilio_account_creds", () => [subRow({ status })]);
    const env = on();
    const err = await twilioEnvFor(env, adminClient(env), { clientId: CLIENT }).catch((e) => e);
    expect(err).toBeInstanceOf(TwilioAccountError);
    expect(err.kind).toBe(kind);
    expect(net.to(/api\.twilio\.com/)).toHaveLength(0);
  });

  it("a lookup that fails is refused for that tenant (fail closed), with no secret in the message", async () => {
    const net = new FakeNet().install();
    net.rpc("twilio_account_creds", () => jsonRes({ code: "42883", message: "function does not exist" }, 404));
    const env = on();
    const err = await twilioEnvFor(env, adminClient(env), { clientId: CLIENT }).catch((e) => e);
    expect(err).toBeInstanceOf(TwilioAccountError);
    expect(err.kind).toBe("lookup_failed");
    expect(String(err.message)).toContain("42883");
  });

  it("by AccountSid: the parent's is the env itself (no lookup); a sub's is its scoped env; a stranger's is refused", async () => {
    const net = new FakeNet().install();
    net.rpc("twilio_account_creds", (s) => (s.json?.p_account_sid === SUB || s.json?.p_client_id === CLIENT ? [subRow()] : []));
    const env = on();
    expect(await twilioEnvFor(env, adminClient(env), { accountSid: PARENT })).toBe(env);
    expect(net.seen).toHaveLength(0);
    expect((await twilioEnvFor(env, adminClient(env), { accountSid: SUB })).TWILIO_ACCOUNT_SID).toBe(SUB);
    const err = await twilioEnvFor(env, adminClient(env), { accountSid: "AC" + "9".repeat(32) }).catch((e) => e);
    expect(err).toBeInstanceOf(TwilioAccountError);
  });
});

describe("tenantMatchesWebhook: a webhook may only touch its own account's tenants (phase 4)", () => {
  const parent: WebhookAccount = { source: "parent", accountSid: PARENT, clientId: null, authToken: "t" };
  const sub: WebhookAccount = { source: "sub", accountSid: SUB, clientId: CLIENT, authToken: SUB_TOKEN };

  it("switch off, or no account on the env: true with no lookup", async () => {
    const net = new FakeNet().install();
    const off = makeEnv({ TWILIO_WEBHOOK_ACCOUNT: sub });
    expect(await tenantMatchesWebhook(off, adminClient(off), "someone-else")).toBe(true);
    const bare = on();
    expect(await tenantMatchesWebhook(bare, adminClient(bare), "someone-else")).toBe(true);
    expect(webhookEnv(bare, undefined)).toBe(bare);
    expect(net.seen).toHaveLength(0);
  });

  it("a sub's webhook: its own tenant only, answered from the account row (no lookup)", async () => {
    const net = new FakeNet().install();
    const env = webhookEnv(on(), sub);
    expect(await tenantMatchesWebhook(env, adminClient(env), CLIENT)).toBe(true);
    expect(await tenantMatchesWebhook(env, adminClient(env), "another-builder")).toBe(false);
    expect(net.seen).toHaveLength(0);
  });

  it("the parent's webhook: only a tenant with no sub-account; a failed read refuses", async () => {
    const net = new FakeNet().install();
    net.rest("GET", "twilio_accounts", (s) => (s.url.searchParams.get("client_id") === `eq.${CLIENT}` ? [{ kind: "sub", account_sid: SUB }] : []));
    const env = webhookEnv(on(), parent);
    expect(await tenantMatchesWebhook(env, adminClient(env), "parent-builder")).toBe(true);
    expect(await tenantMatchesWebhook(env, adminClient(env), CLIENT)).toBe(false);
    const down = new FakeNet().install();
    down.rest("GET", "twilio_accounts", () => jsonRes({ code: "57014", message: "timeout" }, 500));
    expect(await tenantMatchesWebhook(env, adminClient(env), "uncached-builder")).toBe(false);
  });
});
