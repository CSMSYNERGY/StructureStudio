import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeTwilioSignature, verifyTwilioRequest } from "../src/twilioSignature";
import { AUTH_TOKEN, BASE, FakeNet, WEBHOOK_KEY, call, makeEnv, twilioPost } from "./helpers";

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
