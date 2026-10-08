import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { computeTwilioSignature, verifyTwilioRequest } from "../src/twilioSignature";
import { adminClient } from "../src/db";
import { webhookAccountLookup } from "../src/twilioAccount";
import { AUTH_TOKEN, BASE, CLIENT, FakeNet, USER_A, WEBHOOK_KEY, call, jsonRes, makeEnv, routeInfo, twilioPost } from "./helpers";

const ACCOUNT = "AC" + "0".repeat(32);

describe("X-Twilio-Signature", () => {
  it("matches Twilio's published example vector", async () => {
    // The example from Twilio's webhook-security docs and the twilio-node test suite (auth
    // token 12345; the numbers are Twilio's own fictional sample numbers).
    const sig = await computeTwilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", [
      ["CallSid", "CA1234567890ABCDE"],
      ["Caller", "+14158675309"],
      ["Digits", "1234"],
      ["From", "+14158675309"],
      ["To", "+18005551212"],
    ]);
    expect(sig).toBe("RSOYDt4T1cUTdK1PDd93/VVr8B8=");
  });

  it("agrees with an independent HMAC-SHA1 over the full URL (query kept) and sorted params", async () => {
    const url = `${BASE}/voice/after-dial?call=abc&transfer=1&key=${WEBHOOK_KEY}`;
    const params: [string, string][] = [["To", "+15555550100"], ["From", "+15555550142"], ["CallSid", "CA0"], ["DialBridged", "false"]];
    const data = url + [...params].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + v).join("");
    const reference = createHmac("sha1", AUTH_TOKEN).update(data).digest("base64");
    expect(await computeTwilioSignature(AUTH_TOKEN, url, params)).toBe(reference);
  });

  it("the query string is part of what is signed", async () => {
    const a = await computeTwilioSignature(AUTH_TOKEN, `${BASE}/voice/after-dial?transfer=1`, []);
    const b = await computeTwilioSignature(AUTH_TOKEN, `${BASE}/voice/after-dial?transfer=0`, []);
    expect(a).not.toBe(b);
  });

  it("accepts a correctly signed request with the right key", async () => {
    const env = makeEnv();
    const req = await twilioPost(env, "/voice/status", { CallSid: "CA1", CallStatus: "ringing" }, { leg: "pstn" });
    const out = await verifyTwilioRequest(env, req);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.params.CallStatus).toBe("ringing");
  });

  it.each([
    ["a wrong ?key=", { key: "nope" }, "bad_key"],
    ["a signature made with another token", { signWith: "another-token" }, "bad_signature"],
    ["a parameter changed after signing", { tamper: true }, "bad_signature"],
  ] as const)("refuses %s", async (_label, opts, reason) => {
    const env = makeEnv();
    const req = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", To: "+15555550100", From: "+15555550142" }, {}, opts);
    const out = await verifyTwilioRequest(env, req);
    expect(out).toEqual({ ok: false, reason });
  });

  it("refuses a request with no signature header", async () => {
    const env = makeEnv();
    const req = new Request(`${BASE}/voice/inbound?key=${WEBHOOK_KEY}`, { method: "POST", body: "CallSid=CA1" });
    expect(await verifyTwilioRequest(env, req)).toEqual({ ok: false, reason: "no_signature" });
  });

  it("with a token, a request is signed-checked and reported as signed", async () => {
    const env = makeEnv();
    const out = await verifyTwilioRequest(env, await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: ACCOUNT }));
    expect(out).toMatchObject({ ok: true, signed: true });
  });

  it("with a token, BOTH locks are required: the right key with a bad signature, and a good signature with the wrong key, are refused", async () => {
    const env = makeEnv();
    const badSig = await twilioPost(env, "/voice/inbound", { CallSid: "CA1" }, {}, { signWith: "another-token" });
    expect(await verifyTwilioRequest(env, badSig)).toEqual({ ok: false, reason: "bad_signature" });
    const badKey = await twilioPost(env, "/voice/inbound", { CallSid: "CA1" }, {}, { key: "nope" });
    expect(await verifyTwilioRequest(env, badKey)).toEqual({ ok: false, reason: "bad_key" });
  });

  describe("without TWILIO_AUTH_TOKEN (Twilio's API cannot hand it out)", () => {
    const noToken = () => makeEnv({ TWILIO_AUTH_TOKEN: "" });

    it("accepts a webhook on ?key= alone, reported as unsigned", async () => {
      const req = await twilioPost(makeEnv(), "/voice/status", { CallSid: "CA1", CallStatus: "ringing", AccountSid: ACCOUNT });
      const out = await verifyTwilioRequest(noToken(), req);
      expect(out).toEqual({ ok: true, signed: false, params: { CallSid: "CA1", CallStatus: "ringing", AccountSid: ACCOUNT } });
    });

    it("does not care what the signature header says (there is nothing to check it with)", async () => {
      const req = await twilioPost(makeEnv(), "/voice/status", { CallSid: "CA1", AccountSid: ACCOUNT }, {}, { signWith: "garbage" });
      expect(await verifyTwilioRequest(noToken(), req)).toMatchObject({ ok: true, signed: false });
      const bare = new Request(`${BASE}/voice/status?key=${WEBHOOK_KEY}`, { method: "POST", body: `CallSid=CA1&AccountSid=${ACCOUNT}` });
      expect(await verifyTwilioRequest(noToken(), bare)).toMatchObject({ ok: true, signed: false });
    });

    it("still refuses a wrong or missing ?key=", async () => {
      const wrong = await twilioPost(makeEnv(), "/voice/inbound", { CallSid: "CA1", AccountSid: ACCOUNT }, {}, { key: "nope" });
      expect(await verifyTwilioRequest(noToken(), wrong)).toEqual({ ok: false, reason: "bad_key" });
      const none = new Request(`${BASE}/voice/inbound`, { method: "POST", body: `CallSid=CA1&AccountSid=${ACCOUNT}` });
      expect(await verifyTwilioRequest(noToken(), none)).toEqual({ ok: false, reason: "bad_key" });
    });

    it("requires the AccountSid to be present AND ours", async () => {
      const missing = await twilioPost(makeEnv(), "/voice/inbound", { CallSid: "CA1" });
      expect(await verifyTwilioRequest(noToken(), missing)).toEqual({ ok: false, reason: "wrong_account" });
      const other = await twilioPost(makeEnv(), "/voice/inbound", { CallSid: "CA1", AccountSid: "AC" + "9".repeat(32) });
      expect(await verifyTwilioRequest(noToken(), other)).toEqual({ ok: false, reason: "wrong_account" });
    });

    it("still refuses everything when PHONE_WEBHOOK_SECRET is unset too", async () => {
      const req = await twilioPost(makeEnv(), "/voice/inbound", { CallSid: "CA1", AccountSid: ACCOUNT });
      expect(await verifyTwilioRequest(makeEnv({ TWILIO_AUTH_TOKEN: "", PHONE_WEBHOOK_SECRET: "" }), req)).toEqual({ ok: false, reason: "no_webhook_secret" });
    });

    it("the Worker serves the request and logs twilio_signature_skipped at warn ONCE per isolate", async () => {
      const net = new FakeNet().install();
      net.rest("POST", "app_errors", () => []);
      net.rest("GET", "phone_calls", () => []);
      const env = makeEnv({ TWILIO_AUTH_TOKEN: undefined });
      for (let i = 0; i < 3; i++) {
        const { res } = await call(env, await twilioPost(makeEnv(), "/voice/status", { CallSid: "CA1", CallStatus: "ringing", AccountSid: ACCOUNT }, { leg: "pstn" }));
        expect(res.status).toBe(204);
      }
      const logs = net.writes("app_errors").map((s) => s.json);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ code: "twilio_signature_skipped", severity: "warn", source: "edge:phone-api" });
    });
  });

  it("refuses when the webhook secret is unset", async () => {
    const signed = await twilioPost(makeEnv(), "/voice/inbound", { CallSid: "CA1" });
    expect(await verifyTwilioRequest(makeEnv({ PHONE_WEBHOOK_SECRET: "" }), signed)).toEqual({ ok: false, reason: "no_webhook_secret" });
  });

  it("refuses another account's request", async () => {
    const env = makeEnv();
    const req = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: "AC" + "9".repeat(32) });
    expect(await verifyTwilioRequest(env, req)).toEqual({ ok: false, reason: "wrong_account" });
  });

  it("the Worker answers 403 to a bad signature and 503 without the webhook secret, touching nothing else", async () => {
    const net = new FakeNet().install();
    const env = makeEnv();
    const bad = await call(env, await twilioPost(env, "/voice/inbound", { CallSid: "CA1" }, {}, { signWith: "x" }));
    expect(bad.res.status).toBe(403);
    const off = await call(makeEnv({ PHONE_WEBHOOK_SECRET: undefined }), await twilioPost(env, "/voice/inbound", { CallSid: "CA1" }));
    expect(off.res.status).toBe(503);
    const offLog = net.writes("app_errors").map((s) => s.json).find((l) => l.code === "twilio_no_webhook_secret");
    expect(offLog).toMatchObject({ severity: "error" });
    // Only the fault log may have been written; no route lookup, no call rows.
    expect(net.seen.filter((s) => !s.url.pathname.endsWith("/app_errors"))).toEqual([]);
    expect(net.writes("app_errors").length).toBeGreaterThan(0);
  });
});

// ── Workstream 2, phase 4: the token is picked by the request's AccountSid ─────────────────────
// Only while TWILIO_SUBACCOUNTS is "on". Every SID and token below is made up.
describe("per-account signatures (TWILIO_SUBACCOUNTS on)", () => {
  const SUB = "AC" + "5".repeat(32);
  const SUB_TOKEN = "subauthtoken" + "y".repeat(20);
  const SUB_CLIENT = "sub-builder";
  const on = (over: Parameters<typeof makeEnv>[0] = {}) => makeEnv({ TWILIO_SUBACCOUNTS: "on", ...over });
  const lookupFrom = (net: FakeNet, rows: (sid: string) => unknown[]) => {
    net.rpc("twilio_account_creds", (s) => rows(String(s.json?.p_account_sid ?? "")));
    return (env: ReturnType<typeof makeEnv>) => webhookAccountLookup(env, () => adminClient(env));
  };
  const subRow = (status = "active") => [{ client_id: SUB_CLIENT, kind: "sub", account_sid: SUB, status, auth_token: SUB_TOKEN }];

  it("good: a known active sub, signed with ITS token, is accepted and named", async () => {
    const net = new FakeNet().install();
    const lookup = lookupFrom(net, (sid) => (sid === SUB ? subRow() : []));
    const env = on();
    const req = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: SUB }, {}, { signWith: SUB_TOKEN });
    const out = await verifyTwilioRequest(env, req, { accountBySid: lookup(env) });
    expect(out).toMatchObject({ ok: true, signed: true, account: { source: "sub", accountSid: SUB, clientId: SUB_CLIENT } });
  });

  it("bad: a sub's request signed with the PARENT's token (or anything else) is refused", async () => {
    const net = new FakeNet().install();
    const lookup = lookupFrom(net, (sid) => (sid === SUB ? subRow() : []));
    const env = on();
    for (const signWith of [AUTH_TOKEN, "garbage"]) {
      const req = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: SUB }, {}, { signWith });
      expect(await verifyTwilioRequest(env, req, { accountBySid: lookup(env) })).toEqual({ ok: false, reason: "bad_signature" });
    }
  });

  it("a sub's signature is MANDATORY, even on a Worker with no parent token", async () => {
    const net = new FakeNet().install();
    const lookup = lookupFrom(net, (sid) => (sid === SUB ? subRow() : []));
    const env = on({ TWILIO_AUTH_TOKEN: "" });
    const bare = new Request(`${BASE}/voice/inbound?key=${WEBHOOK_KEY}`, { method: "POST", body: `CallSid=CA1&AccountSid=${SUB}` });
    expect(await verifyTwilioRequest(env, bare, { accountBySid: lookup(env) })).toEqual({ ok: false, reason: "no_signature" });
  });

  it("unknown: an AccountSid that is not ours, or a sub that is not active, is wrong_account", async () => {
    const net = new FakeNet().install();
    const lookup = lookupFrom(net, (sid) => (sid === SUB ? subRow("suspended") : []));
    const env = on();
    for (const acct of ["AC" + "9".repeat(32), SUB]) {
      const req = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: acct }, {}, { signWith: SUB_TOKEN });
      expect(await verifyTwilioRequest(env, req, { accountBySid: lookup(env) })).toEqual({ ok: false, reason: "wrong_account" });
    }
  });

  it("a lookup that fails refuses the request (account_lookup_failed): the Worker answers 503 and logs an error", async () => {
    const net = new FakeNet().install();
    net.rpc("twilio_account_creds", () => jsonRes({ code: "57014", message: "timeout" }, 500));
    net.rest("POST", "app_errors", () => []);
    const env = on();
    const req = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: SUB }, {}, { signWith: SUB_TOKEN });
    const { res } = await call(env, req);
    expect(res.status).toBe(503);
    expect(net.writes("app_errors").map((s) => s.json)).toEqual([expect.objectContaining({ code: "twilio_account_lookup_failed", severity: "error" })]);
  });

  it("the parent: its own token, signature mandatory, and no lookup", async () => {
    const net = new FakeNet().install();
    const lookup = lookupFrom(net, () => []);
    const env = on();
    const good = await twilioPost(env, "/voice/status", { CallSid: "CA1", AccountSid: ACCOUNT });
    expect(await verifyTwilioRequest(env, good, { accountBySid: lookup(env) })).toMatchObject({ ok: true, signed: true, account: { source: "parent" } });
    const noSid = await twilioPost(env, "/voice/status", { CallSid: "CA1" });
    expect(await verifyTwilioRequest(env, noSid, { accountBySid: lookup(env) })).toMatchObject({ ok: true, signed: true, account: { source: "parent" } });
    const badSig = await twilioPost(env, "/voice/status", { CallSid: "CA1", AccountSid: ACCOUNT }, {}, { signWith: SUB_TOKEN });
    expect(await verifyTwilioRequest(env, badSig, { accountBySid: lookup(env) })).toEqual({ ok: false, reason: "bad_signature" });
    const bare = new Request(`${BASE}/voice/status?key=${WEBHOOK_KEY}`, { method: "POST", body: `CallSid=CA1&AccountSid=${ACCOUNT}` });
    expect(await verifyTwilioRequest(env, bare, { accountBySid: lookup(env) })).toEqual({ ok: false, reason: "no_signature" });
    expect(net.rpcCalls("twilio_account_creds")).toHaveLength(0);
  });

  it("the parent with NO token: refused once sub-accounts are on (parent_token_missing, 503, an error), never key-only", async () => {
    // Key-only naming the parent's AccountSid would otherwise reach a sub's business through any
    // callback that does not check the tenant (every one but /voice/inbound and /voice/outbound).
    const net = new FakeNet().install();
    const lookup = lookupFrom(net, () => []);
    net.rest("POST", "app_errors", () => []);
    const noToken = on({ TWILIO_AUTH_TOKEN: "" });
    for (const params of [{ CallSid: "CA1", AccountSid: ACCOUNT }, { CallSid: "CA1" }] as Record<string, string>[]) {
      const req = await twilioPost(noToken, "/voice/status", params);
      expect(await verifyTwilioRequest(noToken, req, { accountBySid: lookup(noToken) })).toEqual({ ok: false, reason: "parent_token_missing" });
    }
    const { res } = await call(noToken, await twilioPost(noToken, "/voice/recording", { CallSid: "CA1", AccountSid: ACCOUNT }));
    expect(res.status).toBe(503);
    expect(net.writes("app_errors").map((s) => s.json)).toEqual([expect.objectContaining({ code: "twilio_parent_token_missing", severity: "error" })]);
    // Switch off, the same Worker keeps today's key-only acceptance (DEVIATIONS 30).
    const off = makeEnv({ TWILIO_AUTH_TOKEN: "" });
    expect(await verifyTwilioRequest(off, await twilioPost(off, "/voice/status", { CallSid: "CA1", AccountSid: ACCOUNT }), { accountBySid: lookup(off) }))
      .toMatchObject({ ok: true, signed: false });
  });

  it("a rotated sub token: the cached one fails, the account is asked once more, and the new token is accepted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
      const NEW_TOKEN = "subauthtoken" + "z".repeat(20);
      let vaultToken = SUB_TOKEN;
      const net = new FakeNet().install();
      net.rpc("twilio_account_creds", (s) => (String(s.json?.p_account_sid ?? "") === SUB
        ? [{ client_id: SUB_CLIENT, kind: "sub", account_sid: SUB, status: "active", auth_token: vaultToken }] : []));
      const env = on();
      const lookup = webhookAccountLookup(env, () => adminClient(env));
      const first = await twilioPost(env, "/voice/status", { CallSid: "CA1", AccountSid: SUB }, {}, { signWith: SUB_TOKEN });
      expect(await verifyTwilioRequest(env, first, { accountBySid: lookup })).toMatchObject({ ok: true });
      vaultToken = NEW_TOKEN; // twilio_account_secret_put rotated it
      vi.setSystemTime(new Date("2026-10-09T12:00:20Z")); // still inside the cache's minute
      const second = await twilioPost(env, "/voice/status", { CallSid: "CA2", AccountSid: SUB }, {}, { signWith: NEW_TOKEN });
      expect(await verifyTwilioRequest(env, second, { accountBySid: lookup })).toMatchObject({ ok: true, account: { authToken: NEW_TOKEN } });
      expect(net.rpcCalls("twilio_account_creds")).toHaveLength(2);
      // A forger's bad signature right after costs no further lookup (one per 15 s at most).
      const forged = await twilioPost(env, "/voice/status", { CallSid: "CA3", AccountSid: SUB }, {}, { signWith: "garbage" });
      expect(await verifyTwilioRequest(env, forged, { accountBySid: lookup })).toEqual({ ok: false, reason: "bad_signature" });
      expect(net.rpcCalls("twilio_account_creds")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("911: a callback inside the hour is rung even from an account the business does not live in, and logged", async () => {
    const net = new FakeNet().install();
    lookupFrom(net, (sid) => (sid === SUB ? subRow() : []));
    net.rpc("phone_route_for_number", () => routeInfo({ recent_emergency_user: USER_A })); // CLIENT's number, not the sub's
    net.rest("GET", "crm_contacts", () => []);
    net.rest("GET", "phone_user_settings", () => []);
    net.rest("POST", "phone_calls", () => []);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);
    const env = on();
    const req = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: SUB, To: "+15555550100", From: "+15555550142" }, {}, { signWith: SUB_TOKEN });
    const { text } = await call(env, req);
    expect(text).toContain("<Client");
    expect(text).toMatch(/stage=er/);
    expect(text).not.toContain("can't take calls right now");
    expect(net.writes("app_errors").map((s) => s.json)).toEqual([
      expect.objectContaining({ code: "twilio_account_mismatch", severity: "error", client_id: CLIENT }),
    ]);
  });

  it("911: a callback is rung even when the account check could not be read", async () => {
    const net = new FakeNet().install();
    net.rpc("phone_route_for_number", () => routeInfo({ recent_emergency_user: USER_A }));
    net.rest("GET", "twilio_accounts", () => jsonRes({ code: "57014", message: "timeout" }, 500));
    net.rest("GET", "crm_contacts", () => []);
    net.rest("GET", "phone_user_settings", () => []);
    net.rest("POST", "phone_calls", () => []);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);
    const env = on();
    const req = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: ACCOUNT, To: "+15555550100", From: "+15555550142" });
    const { text } = await call(env, req);
    expect(text).toContain("<Client");
    expect(net.writes("app_errors").map((s) => s.json)).toEqual([expect.objectContaining({ code: "twilio_account_mismatch" })]);
  });

  it("switch OFF: a sub-signed request is refused exactly as today, and the lookup is never consulted", async () => {
    const net = new FakeNet().install();
    const lookup = lookupFrom(net, (sid) => (sid === SUB ? subRow() : []));
    const env = makeEnv();
    const req = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: SUB }, {}, { signWith: SUB_TOKEN });
    expect(await verifyTwilioRequest(env, req, { accountBySid: lookup(env) })).toEqual({ ok: false, reason: "bad_signature" });
    const parentSigned = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: SUB });
    expect(await verifyTwilioRequest(env, parentSigned, { accountBySid: lookup(env) })).toEqual({ ok: false, reason: "wrong_account" });
    expect(net.seen).toHaveLength(0);
  });

  it("mismatch: a sub's inbound call for a number of ANOTHER business is refused (account_mismatch), never rung", async () => {
    const net = new FakeNet().install();
    lookupFrom(net, (sid) => (sid === SUB ? subRow() : []));
    net.rpc("phone_route_for_number", () => routeInfo()); // the number is CLIENT's, not the sub's business
    net.rest("POST", "app_errors", () => []);
    net.rest("POST", "phone_calls", () => []);
    const env = on();
    const req = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: SUB, To: "+15555550100", From: "+15555550142" }, {}, { signWith: SUB_TOKEN });
    const { text } = await call(env, req);
    expect(text).toContain("this number can't take calls right now");
    expect(text).not.toContain("<Client");
    expect(net.writes("phone_calls")).toHaveLength(0);
    expect(net.writes("app_errors").map((s) => s.json)).toEqual([expect.objectContaining({ code: "twilio_account_mismatch", severity: "error", client_id: CLIENT })]);
  });

  it("match: the same call for the sub's own business rings as usual", async () => {
    const net = new FakeNet().install();
    lookupFrom(net, (sid) => (sid === SUB ? subRow() : []));
    net.rpc("phone_route_for_number", () => routeInfo({ client_id: SUB_CLIENT }));
    net.rest("GET", "crm_contacts", () => []);
    net.rest("POST", "phone_calls", () => []);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);
    const env = on();
    const req = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: SUB, To: "+15555550100", From: "+15555550142" }, {}, { signWith: SUB_TOKEN });
    const { text } = await call(env, req);
    expect(text).toContain("<Client");
    expect(net.writes("phone_calls", "POST")[0].json).toMatchObject({ client_id: SUB_CLIENT });
  });

  it("the parent's inbound call for a business that lives in a sub is refused too", async () => {
    const net = new FakeNet().install();
    net.rpc("phone_route_for_number", () => routeInfo({ client_id: SUB_CLIENT }));
    net.rest("GET", "twilio_accounts", () => [{ kind: "sub", account_sid: SUB }]);
    net.rest("POST", "app_errors", () => []);
    const env = on();
    const req = await twilioPost(env, "/voice/inbound", { CallSid: "CA1", AccountSid: ACCOUNT, To: "+15555550100", From: "+15555550142" });
    const { text } = await call(env, req);
    expect(text).toContain("this number can't take calls right now");
    expect(net.writes("app_errors").map((s) => s.json)).toEqual([expect.objectContaining({ code: "twilio_account_mismatch" })]);
  });
});
