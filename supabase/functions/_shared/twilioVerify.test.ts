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
  _resetBrandRefusedForTests,
  toE164US,
  twCheckVerification,
  twilioConfigured,
  TwilioApiError,
  TwilioNotConfigured,
  twSanitizeBrand,
  twStartFailureKind,
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
  _resetBrandRefusedForTests();
  Deno.env.set("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
  Deno.env.set("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
  Deno.env.set("TWILIO_VERIFY_SERVICE_SID", VERIFY_SID);
}
function teardown() {
  globalThis.fetch = realFetch;
  _resetBrandRefusedForTests();
  Deno.env.delete("TWILIO_ACCOUNT_SID");
  Deno.env.delete("TWILIO_AUTH_TOKEN");
  Deno.env.delete("TWILIO_API_KEY");
  Deno.env.delete("TWILIO_API_SECRET");
  Deno.env.delete("TWILIO_VERIFY_SERVICE_SID");
}

// API-key pair (the Twilio CLI's env-var profile shape; landed 2026-08-12 after the
// deployment's TWILIO_AUTH_TOKEN arrived as an EMPTY string because the operator's shell
// only held the key pair).
const API_KEY = "SKtestapikeysid";
const API_SECRET = "test-api-secret";

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

// ── 60204: the brand refusal ───────────────────────────────────────────────────────────────
// Twilio refuses every send carrying CustomFriendlyName (HTTP 403, code 60204) until Twilio
// Sales enables "Custom Company Name" on the service. Every branded login text from 2026-08-26
// to 2026-09-16 died this way behind a "try again" answer. The transport now resends ONCE
// without the name. What these pin: exactly how many requests go out (an extra successful
// request is a second text to a real phone), what the resend carries, when the fallback is
// remembered, and that nothing except a 403/60204 on a BRANDED send is ever resent.

const BRAND = "Example Barns";
const UNBRANDED_BODY = "To=%2B15005550006&Channel=sms";

const refused = () => twilioError(60204, "Service does not support this feature", 403);
const pending = () => jsonResponse(PENDING_VERIFICATION, 201);

/** Answer each request from `responses` in order. A request past the end is answered 599 so
 *  it cannot pass as a send, and the calls.length assertions name it. */
function sequence(responses: Array<() => Response>): Call[] {
  let i = 0;
  return stub(() => {
    const next = responses[i++];
    return next ? next() : new Response("unexpected extra request", { status: 599 });
  });
}

function friendlyName(call: Call): string | null {
  return new URLSearchParams(call.body ?? "").get("CustomFriendlyName");
}

Deno.test("an accepted brand goes out as CustomFriendlyName in ONE request", async () => {
  setup();
  try {
    const calls = sequence([pending]);
    const out = await twStartVerification(PHONE_E164, "Example's Barns & Sheds, LLC");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].body, `${UNBRANDED_BODY}&CustomFriendlyName=Example+s+Barns+Sheds+LLC`);
    assertEquals(out.status, "pending");
    assertEquals(out.brandRefused, false);
  } finally {
    teardown();
  }
});

Deno.test("403/60204 on a BRANDED send resends once without the name: one code goes out", async () => {
  setup();
  try {
    const calls = sequence([refused, pending]);
    const out = await twStartVerification(PHONE_E164, BRAND);
    assertEquals(calls.length, 2, "exactly one refused request and one resend");
    assertEquals(friendlyName(calls[0]), BRAND, "the first request carries the brand");
    assertEquals(calls[1].body, UNBRANDED_BODY, "the resend is To + Channel only");
    assertEquals(out.status, "pending");
    assertEquals(out.sid, "VEtestverificationsid");
    assertEquals(out.brandRefused, true, "the call that fell back says so, so the caller can log it");

    // Same isolate, the next customer: the brand is not offered again and nothing is re-reported.
    const next = sequence([pending]);
    const out2 = await twStartVerification(PHONE_E164, "Summit Sheds");
    assertEquals(next.length, 1, "a remembered refusal costs no second round trip");
    assertEquals(next[0].body, UNBRANDED_BODY);
    assertEquals(out2.brandRefused, false, "only the call that discovered the refusal reports it");
  } finally {
    teardown();
  }
});

Deno.test("60204 on an UNBRANDED send is not retried and is a permanent config fault", async () => {
  setup();
  try {
    const calls = sequence([refused]);
    const err = await expectApiError(() => twStartVerification(PHONE_E164), "unbranded 60204");
    assertEquals(calls.length, 1, "no brand to drop, so nothing to retry");
    assertEquals(err.status, 403);
    assertEquals(err.code, 60204);
    assertEquals(err.permanent, true, "only Twilio can enable the feature; a retry fails identically");
    assertEquals(twStartFailureKind(err), "config");

    // A brand that sanitizes to nothing is the same as no brand.
    const blank = sequence([refused]);
    await expectApiError(() => twStartVerification(PHONE_E164, "!!!"), "blank-brand 60204");
    assertEquals(blank.length, 1);
    assertEquals(friendlyName(blank[0]), null);
  } finally {
    teardown();
  }
});

Deno.test("60204 on the resend too: two requests, a permanent refusal, and the brand is NOT written off", async () => {
  setup();
  try {
    const calls = sequence([refused, refused]);
    const err = await expectApiError(() => twStartVerification(PHONE_E164, BRAND), "60204 twice");
    assertEquals(calls.length, 2, "one resend, never a loop");
    assertEquals(friendlyName(calls[1]), null);
    assertEquals(err.code, 60204);
    // permanent is what makes customer-auth hand the three send slots back: nothing was sent.
    assertEquals(err.permanent, true);
    assertEquals(twStartFailureKind(err), "config");

    // The unbranded send never worked, so the brand is not the proven cause and is offered again.
    const next = sequence([pending]);
    const out = await twStartVerification(PHONE_E164, BRAND);
    assertEquals(next.length, 1);
    assertEquals(friendlyName(next[0]), BRAND);
    assertEquals(out.brandRefused, false);
  } finally {
    teardown();
  }
});

Deno.test("a transient failure on the RESEND is rethrown unchanged: still transient, no third request", async () => {
  setup();
  try {
    const cases: Array<[string, () => Response, number]> = [
      ["429", () => twilioError(20429, "Too Many Requests", 429), 429],
      ["500", () => new Response("<html>Internal Server Error</html>", { status: 500 }), 500],
    ];
    for (const [label, second, status] of cases) {
      _resetBrandRefusedForTests();
      const calls = sequence([refused, second]);
      const err = await expectApiError(() => twStartVerification(PHONE_E164, BRAND), `resend ${label}`);
      assertEquals(calls.length, 2, `${label}: no third request`);
      assertEquals(err.status, status, `${label}: the resend's own error comes back`);
      // transient keeps customer-auth's slots claimed: a send may have gone out.
      assertEquals(err.permanent, false, `${label}: must stay retryable`);
      assertEquals(twStartFailureKind(err), "transient");
    }

    _resetBrandRefusedForTests();
    let n = 0;
    const calls = stub(() => {
      n++;
      if (n === 1) return refused();
      throw new TypeError("network unreachable");
    });
    const netErr = await expectApiError(() => twStartVerification(PHONE_E164, BRAND), "resend network");
    assertEquals(calls.length, 2);
    assertEquals(netErr.status, 0);
    assertEquals(netErr.permanent, false);

    // None of those proved the brand was the problem, so it is still offered.
    const next = sequence([pending]);
    await twStartVerification(PHONE_E164, BRAND);
    assertEquals(friendlyName(next[0]), BRAND);
  } finally {
    teardown();
  }
});

Deno.test("only 403/60204 triggers the resend: other failures on a branded send go out ONCE", async () => {
  setup();
  try {
    const cases: Array<[string, () => Response]> = [
      ["429/20429", () => twilioError(20429, "Too Many Requests", 429)],
      ["500", () => new Response("<html>Internal Server Error</html>", { status: 500 })],
      ["400/60200", () => twilioError(60200, `Invalid parameter \`To\`: ${PHONE_E164}`, 400)],
      ["400/60204 (not a 403)", () => twilioError(60204, "Service does not support this feature", 400)],
    ];
    for (const [label, only] of cases) {
      const calls = sequence([only, pending]);
      await expectApiError(() => twStartVerification(PHONE_E164, BRAND), label);
      assertEquals(calls.length, 1, `${label}: must not be resent`);
    }
    const net = stub(() => {
      throw new TypeError("network unreachable");
    });
    await expectApiError(() => twStartVerification(PHONE_E164, BRAND), "network");
    assertEquals(net.length, 1, "a network error is never resent: the first request may have landed");
  } finally {
    teardown();
  }
});

Deno.test("twStartFailureKind: every permanent start code has a meaning, everything else is transient", async () => {
  setup();
  try {
    const table: Array<[number, number, string]> = [
      [60203, 429, "locked"],
      [60202, 429, "locked"],
      [60204, 403, "config"],
      [20404, 404, "config"],
      [60200, 400, "number"],
      [60205, 403, "number"],
      [20429, 429, "transient"],
      [60299, 400, "transient"],
    ];
    for (const [code, status, kind] of table) {
      stub(() => twilioError(code, "whatever", status));
      const err = await expectApiError(() => twStartVerification(PHONE_E164), `${status}/${code}`);
      assertEquals<string>(twStartFailureKind(err), kind, `${status}/${code}`);
    }
    stub(() => new Response("<html>Internal Server Error</html>", { status: 500 }));
    assertEquals(twStartFailureKind(await expectApiError(() => twStartVerification(PHONE_E164), "500")), "transient");
    stub(() => {
      throw new TypeError("network unreachable");
    });
    assertEquals(twStartFailureKind(await expectApiError(() => twStartVerification(PHONE_E164), "net")), "transient");
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

Deno.test("API-key pair configures WITHOUT an auth token, and wins the Basic header when both exist", async () => {
  teardown();
  try {
    // Key pair + verify SID, NO auth token: configured.
    Deno.env.set("TWILIO_API_KEY", API_KEY);
    Deno.env.set("TWILIO_API_SECRET", API_SECRET);
    Deno.env.set("TWILIO_VERIFY_SERVICE_SID", VERIFY_SID);
    assertEquals(twilioConfigured(), true, "key pair alone must satisfy the guard");

    // The Basic header carries the KEY pair — and keeps carrying it when SID+TOKEN also
    // exist, because keys are the preferred credential.
    Deno.env.set("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
    Deno.env.set("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
    const calls = stub(() => jsonResponse(PENDING_VERIFICATION, 201));
    await twStartVerification(PHONE_E164);
    assertEquals(calls.length, 1);
    assertEquals(
      calls[0].headers.get("Authorization"),
      `Basic ${btoa(`${API_KEY}:${API_SECRET}`)}`,
      "API key pair must win over SID:token",
    );
  } finally {
    teardown();
  }
});

Deno.test("empty-string TWILIO_AUTH_TOKEN does not configure (the 2026-08-11 incident shape)", () => {
  teardown();
  try {
    Deno.env.set("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
    Deno.env.set("TWILIO_AUTH_TOKEN", "");
    Deno.env.set("TWILIO_VERIFY_SERVICE_SID", VERIFY_SID);
    assertEquals(twilioConfigured(), false, "an empty token is absent, not present");
  } finally {
    teardown();
  }
});

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

// ── twSanitizeBrand ────────────────────────────────────────────────────────────────────
// This runs on a string the BUILDER typed into a settings box, and its output goes to
// Twilio as CustomFriendlyName. A name Twilio cannot take must not become a rejected send,
// because that means the builder's CUSTOMER cannot log in to see their quote. So the
// interesting cases here are all "ugly input must not become a failed login".

Deno.test("twSanitizeBrand: an ordinary business name passes through", () => {
  assertEquals(twSanitizeBrand("ExampleBarns"), "ExampleBarns");
  assertEquals(twSanitizeBrand("Summit Sheds"), "Summit Sheds");
});

Deno.test("twSanitizeBrand: punctuation real businesses actually use is stripped, not rejected", () => {
  // The whole point: "Example's Barns & Sheds, LLC" is a name someone will type.
  assertEquals(twSanitizeBrand("Example's Barns & Sheds, LLC"), "Example s Barns Sheds LLC");
  assertEquals(twSanitizeBrand("A+B  Structures"), "A B Structures");
});

Deno.test("twSanitizeBrand: capped at Twilio's 30 chars with no trailing space", () => {
  const out = twSanitizeBrand("Abcdefghij Klmnopqrst Uvwxyz Abcdefghij");
  assertEquals(out, "Abcdefghij Klmnopqrst Uvwxyz A", "a long name is cut at exactly 30");
  assertEquals(out.length, 30);
  // Character 30 is a space here: the cut must not hand Twilio a trailing space.
  const cutAtSpace = twSanitizeBrand("Abcdefghij Klmnopqrst Uvwxyza Bcd");
  assertEquals(cutAtSpace, "Abcdefghij Klmnopqrst Uvwxyza");
  assertEquals(cutAtSpace, cutAtSpace.trim(), "a cap must never leave a trailing space");
});

Deno.test("twSanitizeBrand: nothing usable returns empty, so the caller omits the override", () => {
  // Empty is the SAFE answer, not a failure: the send goes out on Twilio's service default,
  // which is exactly the behaviour before this parameter existed.
  assertEquals(twSanitizeBrand(""), "");
  assertEquals(twSanitizeBrand("   "), "");
  assertEquals(twSanitizeBrand("!!!"), "");
  assertEquals(twSanitizeBrand(null), "");
  assertEquals(twSanitizeBrand(undefined), "");
  assertEquals(twSanitizeBrand(12345), "");
});

// ── Verify may live on its own Twilio account (the seam added 2026-08-30) ────────────────
// Each credential reader prefers TWILIO_VERIFY_* and falls back to the shared TWILIO_*.
// Getting the fallback wrong is SILENT: Verify would authenticate against the messaging
// account and the login-code path would 401 with a message blaming the Verify service rather
// than the credentials.

function withEnv(vars: Record<string, string | null>, fn: () => void) {
  const keep: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) keep[k] = Deno.env.get(k);
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === null) Deno.env.delete(k); else Deno.env.set(k, v);
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
    }
  }
}

Deno.test("Verify falls back to the shared platform credentials when no override is set", () => {
  withEnv({
    TWILIO_VERIFY_ACCOUNT_SID: null, TWILIO_VERIFY_API_KEY: null, TWILIO_VERIFY_API_SECRET: null,
    TWILIO_ACCOUNT_SID: "ACshared", TWILIO_API_KEY: "SKshared", TWILIO_API_SECRET: "sharedsecret",
    TWILIO_VERIFY_SERVICE_SID: "VAshared",
  }, () => {
    assert(twilioConfigured(), "shared credentials alone must still satisfy the config check");
  });
});

Deno.test("Verify runs on its OWN account credentials once the overrides are set", () => {
  withEnv({
    TWILIO_ACCOUNT_SID: "ACmessaging", TWILIO_API_KEY: "SKmessaging", TWILIO_API_SECRET: "msgsecret",
    TWILIO_VERIFY_ACCOUNT_SID: "ACverify", TWILIO_VERIFY_API_KEY: "SKverify",
    TWILIO_VERIFY_API_SECRET: "verifysecret", TWILIO_VERIFY_SERVICE_SID: "VAverify",
  }, () => {
    assert(twilioConfigured(), "the override pair must satisfy the config check on its own");
  });
});

Deno.test("Verify is NOT configured when neither the overrides nor the shared pair exist", () => {
  withEnv({
    TWILIO_ACCOUNT_SID: null, TWILIO_API_KEY: null, TWILIO_API_SECRET: null, TWILIO_AUTH_TOKEN: null,
    TWILIO_VERIFY_ACCOUNT_SID: null, TWILIO_VERIFY_API_KEY: null, TWILIO_VERIFY_API_SECRET: null,
    TWILIO_VERIFY_SERVICE_SID: "VAxxx",
  }, () => {
    assert(!twilioConfigured(), "with no credentials at all this must report NOT configured");
  });
});
