/**
 * Unit tests for the Twilio Verify transport.
 *
 * WHY THESE EXIST. The module can only otherwise be exercised against live Twilio — which
 * needs real account credentials, consumes paid verification attempts, and texts real
 * phones. So the error taxonomy, the not-configured guard, the expired-check mapping and
 * the E.164 normalizer are pinned here with `fetch` stubbed: no network, no Twilio, no
 * waiting. The permanent/transient verdicts matter most — callers branch on them, and a
 * wrong verdict either strands a retryable verification or offers a Retry that can never
 * work. The no-phone-in-errors tests matter just as much: Twilio echoes the number into
 * `message`, and these prove it never reaches a thrown error.
 *
 * Run: deno test --allow-env --node-modules-dir=none twilioVerify.test.ts   (from _shared/)
 * (the pre-push gate runs this for you with exactly those flags — see scripts/preflight.mjs)
 */

import {
  toE164US,
  twCheckVerification,
  twilioConfigured,
  TwilioApiError,
  TwilioNotConfigured,
  twStartVerification,
} from "./twilioVerify.ts";

// Local assertions rather than jsr:@std/assert, deliberately. The pre-push gate runs this
// file, and a gate that needs a registry fetch fails closed on an offline machine — which is
// the one thing scripts/preflight.mjs promises never to do.
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      + (msg ? ` — ${msg}` : ""));
  }
}

/** Await fn and hand back the TwilioApiError it threw — anything else fails the test. */
async function expectApiError(fn: () => Promise<unknown>, label: string): Promise<TwilioApiError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof TwilioApiError) return e;
    throw new Error(`${label}: threw ${(e as Error)?.name ?? typeof e}, expected TwilioApiError`);
  }
  throw new Error(`${label}: did not throw`);
}

async function expectNotConfigured(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof TwilioNotConfigured) return;
    throw new Error(`${label}: threw ${(e as Error)?.name ?? typeof e}, expected TwilioNotConfigured`);
  }
  throw new Error(`${label}: did not throw`);
}

const realFetch = globalThis.fetch;

type Call = { url: string; method: string; headers: Headers; body: string | null };

/** Stub fetch and record every request (url, method, headers, body). */
function stub(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: Call = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers ?? {}),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Clearly-fake credentials (this repo is PUBLIC): too short to match Twilio's real
// AC/VA + 32-hex shapes, so no secret scanner — or human — mistakes them for live values.
const ACCOUNT_SID = "ACtestaccountsid";
const AUTH_TOKEN = "test-auth-token";
const VERIFY_SID = "VAtestservicesid";

// Twilio's own magic test number, in the two shapes the module deals in.
const PHONE_DIGITS = "5005550006";
const PHONE_E164 = "+15005550006";

function setup() {
  Deno.env.set("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
  Deno.env.set("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
  Deno.env.set("TWILIO_VERIFY_SERVICE_SID", VERIFY_SID);
}
function teardown() {
  globalThis.fetch = realFetch;
  Deno.env.delete("TWILIO_ACCOUNT_SID");
  Deno.env.delete("TWILIO_AUTH_TOKEN");
  Deno.env.delete("TWILIO_VERIFY_SERVICE_SID");
}

// Twilio's success shapes, trimmed to the fields the module reads plus a few it must ignore.
const PENDING_VERIFICATION = {
  sid: "VEtestverificationsid",
  service_sid: VERIFY_SID,
  to: PHONE_E164,
  channel: "sms",
  status: "pending",
  valid: false,
};
const APPROVED_CHECK = {
  sid: "VEtestverificationsid",
  to: PHONE_E164,
  channel: "sms",
  status: "approved",
  valid: true,
};

// Twilio's error body shape — `message` ECHOES THE PHONE NUMBER, which is exactly what the
// no-leak tests below pin against.
function twilioError(code: number, message: string, status: number): Response {
  return jsonResponse({ code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status }, status);
}

// ── Configuration guard ────────────────────────────────────────────────────────────────────

Deno.test("twilioConfigured requires ALL THREE secrets", () => {
  teardown();
  try {
    assertEquals(twilioConfigured(), false, "nothing set");
    Deno.env.set("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
    assertEquals(twilioConfigured(), false, "the account SID alone is not configured");
    Deno.env.set("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
    assertEquals(twilioConfigured(), false, "SID + token without the Verify service is not configured");
    Deno.env.set("TWILIO_VERIFY_SERVICE_SID", VERIFY_SID);
    assertEquals(twilioConfigured(), true, "all three set");
    Deno.env.delete("TWILIO_AUTH_TOKEN");
    assertEquals(twilioConfigured(), false, "dropping any one de-configures it");
  } finally {
    teardown();
  }
});

Deno.test("missing secrets throw TwilioNotConfigured BEFORE any fetch", async () => {
  teardown();
  const calls = stub(() => jsonResponse({}));
  try {
    await expectNotConfigured(() => twStartVerification(PHONE_E164), "twStartVerification");
    await expectNotConfigured(() => twCheckVerification(PHONE_E164, "123456"), "twCheckVerification");
    // Partially configured is still not configured — two of three must not unlock a call.
    Deno.env.set("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
    Deno.env.set("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
    await expectNotConfigured(
      () => twStartVerification(PHONE_E164),
      "twStartVerification without the Verify service SID",
    );
    assertEquals(calls.length, 0, "a not-configured call must never reach the network");
  } finally {
    teardown();
  }
});

// ── Request shape: form encoding + Basic auth ──────────────────────────────────────────────

Deno.test("twStartVerification POSTs form-encoded To+Channel with Basic auth", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse(PENDING_VERIFICATION));
    const out = await twStartVerification(PHONE_E164);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].url, `https://verify.twilio.com/v2/Services/${VERIFY_SID}/Verifications`);
    assertEquals(calls[0].headers.get("Content-Type"), "application/x-www-form-urlencoded");
    assertEquals(
      calls[0].headers.get("Authorization"),
      `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`,
      "Basic auth must be base64(ACCOUNT_SID:AUTH_TOKEN)",
    );
    assertEquals(calls[0].body, "To=%2B15005550006&Channel=sms",
      "the + must be percent-encoded, the channel pinned to sms");
    assertEquals(out.status, "pending");
    assertEquals(out.sid, "VEtestverificationsid");
  } finally {
    teardown();
  }
});

Deno.test("twCheckVerification POSTs form-encoded To+Code to VerificationCheck", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse(APPROVED_CHECK));
    await twCheckVerification(PHONE_E164, "123456");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].url, `https://verify.twilio.com/v2/Services/${VERIFY_SID}/VerificationCheck`);
    assertEquals(calls[0].headers.get("Content-Type"), "application/x-www-form-urlencoded");
    assertEquals(calls[0].headers.get("Authorization"), `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`);
    assertEquals(calls[0].body, "To=%2B15005550006&Code=123456");
  } finally {
    teardown();
  }
});

// ── Check outcomes ─────────────────────────────────────────────────────────────────────────

Deno.test("an approved check maps to {approved: true}", async () => {
  setup();
  try {
    stub(() => jsonResponse(APPROVED_CHECK));
    const out = await twCheckVerification(PHONE_E164, "123456");
    assertEquals(out.approved, true);
    assertEquals(out.status, "approved");
  } finally {
    teardown();
  }
});

Deno.test("a wrong code comes back status=pending and approved MUST be false", async () => {
  setup();
  try {
    stub(() => jsonResponse({ ...APPROVED_CHECK, status: "pending", valid: false }));
    const out = await twCheckVerification(PHONE_E164, "000000");
    assertEquals(out.approved, false, "only status === 'approved' may verify a phone");
    assertEquals(out.status, "pending");
  } finally {
    teardown();
  }
});

Deno.test("an expired/consumed check (404 code 20404) returns {approved:false, status:'expired'} — no throw", async () => {
  setup();
  try {
    stub(() => twilioError(20404, `The requested resource /Services/${VERIFY_SID}/VerificationCheck was not found`, 404));
    const out = await twCheckVerification(PHONE_E164, "123456");
    assertEquals(out.approved, false);
    assertEquals(out.status, "expired",
      "the normal wrong-flow case must be a value callers can message on, not an error");
  } finally {
    teardown();
  }
});

Deno.test("the SAME 404/20404 on the START path stays a thrown PERMANENT error", async () => {
  setup();
  try {
    stub(() => twilioError(20404, "The requested resource was not found", 404));
    const err = await expectApiError(() => twStartVerification(PHONE_E164), "start 404/20404");
    assertEquals(err.status, 404);
    assertEquals(err.code, 20404);
    assertEquals(err.permanent, true,
      "a missing Verify service is not something a retry will find");
  } finally {
    teardown();
  }
});

// ── Error taxonomy: permanent vs transient ─────────────────────────────────────────────────

Deno.test("code 60200 (invalid number) is PERMANENT — an identical retry fails identically", async () => {
  setup();
  try {
    stub(() => twilioError(60200, `Invalid parameter \`To\`: ${PHONE_E164}`, 400));
    const err = await expectApiError(() => twStartVerification(PHONE_E164), "400/60200");
    assertEquals(err.status, 400);
    assertEquals(err.code, 60200);
    assertEquals(err.permanent, true);
    assert(err.message.includes("400"), "the message should carry the HTTP status");
    assert(err.message.includes("60200"), "the message should carry the code");
  } finally {
    teardown();
  }
});

Deno.test("code 60205 (landline) is PERMANENT", async () => {
  setup();
  try {
    stub(() => twilioError(60205, "SMS is not supported by landline phone number", 403));
    const err = await expectApiError(() => twStartVerification(PHONE_E164), "403/60205");
    assertEquals(err.code, 60205);
    assertEquals(err.permanent, true);
  } finally {
    teardown();
  }
});

Deno.test("60203/60202 (max attempts) are PERMANENT but keep the code for 'try later' messaging", async () => {
  setup();
  try {
    stub(() => twilioError(60203, `Max send attempts reached for ${PHONE_E164}`, 429));
    const sendErr = await expectApiError(() => twStartVerification(PHONE_E164), "429/60203");
    assertEquals(sendErr.code, 60203, "callers key 'too many attempts' messaging on this code");
    assertEquals(sendErr.permanent, true, "an immediate identical retry fails identically");

    stub(() => twilioError(60202, "Max check attempts reached", 429));
    const checkErr = await expectApiError(() => twCheckVerification(PHONE_E164, "123456"), "429/60202");
    assertEquals(checkErr.code, 60202);
    assertEquals(checkErr.permanent, true);
  } finally {
    teardown();
  }
});

Deno.test("HTTP 429 (code 20429) is TRANSIENT — retrying a rate limit is the correct response", async () => {
  setup();
  try {
    stub(() => twilioError(20429, "Too Many Requests", 429));
    const err = await expectApiError(() => twStartVerification(PHONE_E164), "429/20429");
    assertEquals(err.status, 429);
    assertEquals(err.code, 20429);
    assertEquals(err.permanent, false);
  } finally {
    teardown();
  }
});

Deno.test("HTTP 500 is TRANSIENT, even with an unparsable body", async () => {
  setup();
  try {
    stub(() => new Response("<html>Internal Server Error</html>", { status: 500 }));
    const err = await expectApiError(() => twStartVerification(PHONE_E164), "500");
    assertEquals(err.status, 500);
    assertEquals(err.code, 0);
    assertEquals(err.permanent, false);
  } finally {
    teardown();
  }
});

Deno.test("a network error is TRANSIENT and reports status 0", async () => {
  setup();
  try {
    stub(() => {
      throw new TypeError("network unreachable");
    });
    const err = await expectApiError(() => twCheckVerification(PHONE_E164, "123456"), "network error");
    assertEquals(err.status, 0);
    assertEquals(err.code, 0);
    assertEquals(err.permanent, false);
  } finally {
    teardown();
  }
});

Deno.test("an UNKNOWN code stays TRANSIENT — permanence is claimed only on positive evidence", async () => {
  setup();
  try {
    stub(() => twilioError(60299, "Some future Verify error", 400));
    const err = await expectApiError(() => twStartVerification(PHONE_E164), "400/unknown");
    assertEquals(err.code, 60299);
    assertEquals(err.permanent, false, "ambiguous failures must stay retryable");
  } finally {
    teardown();
  }
});

// ── The phone number never reaches a thrown error ──────────────────────────────────────────

Deno.test("the raw provider body is NEVER surfaced — Twilio echoes the phone number in `message`", async () => {
  setup();
  try {
    stub(() => twilioError(60200, `Invalid parameter \`To\`: ${PHONE_E164}`, 400));
    const startErr = await expectApiError(() => twStartVerification(PHONE_E164), "start leak check");
    assert(!startErr.message.includes(PHONE_DIGITS), "the phone number leaked into the start error message");
    assert(!startErr.message.includes("Invalid parameter"), "Twilio's message text leaked into the error");

    stub(() => twilioError(60202, `Max check attempts reached for ${PHONE_E164}`, 429));
    const checkErr = await expectApiError(() => twCheckVerification(PHONE_E164, "123456"), "check leak check");
    assert(!checkErr.message.includes(PHONE_DIGITS), "the phone number leaked into the check error message");
    assert(!checkErr.message.includes("Max check"), "Twilio's message text leaked into the error");
  } finally {
    teardown();
  }
});

// ── toE164US ───────────────────────────────────────────────────────────────────────────────

Deno.test("toE164US: exactly 10 digits gains +1", () => {
  assertEquals(toE164US(PHONE_DIGITS), PHONE_E164);
  assertEquals(toE164US("2025551234"), "+12025551234");
});

Deno.test("toE164US: 11 digits starting with 1 gains +", () => {
  assertEquals(toE164US("1" + PHONE_DIGITS), PHONE_E164);
  assertEquals(toE164US("12025551234"), "+12025551234");
});

Deno.test("toE164US: everything else is null — the caller strips formatting, this takes digits ONLY", () => {
  assertEquals(toE164US("500555000"), null, "9 digits is not a US phone");
  assertEquals(toE164US("25005550006"), null, "11 digits not starting with 1");
  assertEquals(toE164US("150055500067"), null, "12 digits");
  assertEquals(toE164US("(500) 555-0006"), null, "formatted input must be stripped by the caller first");
  assertEquals(toE164US("+15005550006"), null, "already-E.164 input is not digits");
  assertEquals(toE164US("500555000a"), null, "a stray letter");
  assertEquals(toE164US(""), null, "empty");
});
