/**
 * Unit tests for the Postmark transport.
 *
 * WHY THESE EXIST. The module can only otherwise be exercised against live Postmark — which
 * needs a real account token, makes real DNS-provisioning calls, and (for the send path)
 * sends real email. So the error taxonomy, the not-configured guard and the PmDomain
 * normalization are pinned here with `fetch` stubbed: no network, no Postmark, no waiting.
 * The permanent/transient verdicts matter most — emailSend.ts and the portal's remediation
 * UI branch on them, and a wrong verdict either strands a retryable email or offers a Retry
 * that can never work.
 *
 * Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/postmark.test.ts
 * (the pre-push gate runs this for you with exactly those flags — see scripts/preflight.mjs)
 */

import {
  pmCreateDomain,
  pmDeleteDomain,
  pmGetDomain,
  pmSendEmail,
  pmVerifyDomain,
  postmarkConfigured,
  PostmarkApiError,
  PostmarkNotConfigured,
} from "./postmark.ts";

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

/** Await fn and hand back the PostmarkApiError it threw — anything else fails the test. */
async function expectApiError(fn: () => Promise<unknown>, label: string): Promise<PostmarkApiError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof PostmarkApiError) return e;
    throw new Error(`${label}: threw ${(e as Error)?.name ?? typeof e}, expected PostmarkApiError`);
  }
  throw new Error(`${label}: did not throw`);
}

async function expectNotConfigured(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof PostmarkNotConfigured) return;
    throw new Error(`${label}: threw ${(e as Error)?.name ?? typeof e}, expected PostmarkNotConfigured`);
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

const ACCOUNT_TOKEN = "test-account-token";
const SERVER_TOKEN = "test-server-token";

function setup() {
  Deno.env.set("POSTMARK_ACCOUNT_TOKEN", ACCOUNT_TOKEN);
  Deno.env.set("POSTMARK_SERVER_TOKEN", SERVER_TOKEN);
}
function teardown() {
  globalThis.fetch = realFetch;
  Deno.env.delete("POSTMARK_ACCOUNT_TOKEN");
  Deno.env.delete("POSTMARK_SERVER_TOKEN");
}

const SEND = {
  From: "info@mail.example.com",
  To: "lead@example.net",
  Subject: "Your estimate",
  HtmlBody: "<p>Hi</p>",
};

// Postmark's PRE-verify domain shape: the DKIM record lives in the Pending pair and the
// verified pair is EMPTY. Field names are Postmark's own — the whole point of toPmDomain.
const PRE_VERIFY_DOMAIN = {
  ID: 1234,
  Name: "mail.example.com",
  DKIMVerified: false,
  WeakDKIM: false,
  DKIMHost: "",
  DKIMTextValue: "",
  DKIMPendingHost: "20260810._domainkey.mail.example.com",
  DKIMPendingTextValue: "k=rsa; p=TESTKEY",
  DKIMRevokedHost: "",
  DKIMRevokedTextValue: "",
  SafeToRemoveRevokedKeyFromDNS: false,
  DKIMUpdateStatus: "Pending",
  ReturnPathDomain: "pm-bounces.mail.example.com",
  ReturnPathDomainVerified: false,
  ReturnPathDomainCNAMEValue: "pm.mtasv.net",
};

// POST-verify: the SAME record has moved to DKIMHost/DKIMTextValue and the Pending pair is
// empty. A normalizer reading only one naming convention returns blanks for the other side.
const POST_VERIFY_DOMAIN = {
  ...PRE_VERIFY_DOMAIN,
  DKIMVerified: true,
  DKIMHost: "20260810._domainkey.mail.example.com",
  DKIMTextValue: "k=rsa; p=TESTKEY",
  DKIMPendingHost: "",
  DKIMPendingTextValue: "",
  DKIMUpdateStatus: "Verified",
  ReturnPathDomainVerified: true,
};

// ── Configuration guard ────────────────────────────────────────────────────────────────────

Deno.test("postmarkConfigured requires BOTH tokens", () => {
  teardown();
  try {
    assertEquals(postmarkConfigured(), false, "neither token set");
    Deno.env.set("POSTMARK_ACCOUNT_TOKEN", ACCOUNT_TOKEN);
    assertEquals(postmarkConfigured(), false, "the account token alone is not configured");
    Deno.env.set("POSTMARK_SERVER_TOKEN", SERVER_TOKEN);
    assertEquals(postmarkConfigured(), true, "both tokens set");
    Deno.env.delete("POSTMARK_ACCOUNT_TOKEN");
    assertEquals(postmarkConfigured(), false, "the server token alone is not configured");
  } finally {
    teardown();
  }
});

Deno.test("missing secrets throw PostmarkNotConfigured BEFORE any fetch", async () => {
  teardown();
  const calls = stub(() => jsonResponse({}));
  try {
    await expectNotConfigured(() => pmCreateDomain("mail.example.com"), "pmCreateDomain");
    await expectNotConfigured(() => pmGetDomain(1), "pmGetDomain");
    await expectNotConfigured(() => pmVerifyDomain(1), "pmVerifyDomain");
    await expectNotConfigured(() => pmDeleteDomain(1), "pmDeleteDomain");
    await expectNotConfigured(() => pmSendEmail(SEND), "pmSendEmail");
    assertEquals(calls.length, 0, "a not-configured call must never reach the network");
  } finally {
    teardown();
  }
});

Deno.test("each API needs ITS OWN token — the other one alone does not unlock it", async () => {
  teardown();
  const calls = stub(() => jsonResponse({}));
  try {
    Deno.env.set("POSTMARK_SERVER_TOKEN", SERVER_TOKEN);
    await expectNotConfigured(
      () => pmCreateDomain("mail.example.com"),
      "pmCreateDomain with only the server token",
    );
    Deno.env.delete("POSTMARK_SERVER_TOKEN");
    Deno.env.set("POSTMARK_ACCOUNT_TOKEN", ACCOUNT_TOKEN);
    await expectNotConfigured(() => pmSendEmail(SEND), "pmSendEmail with only the account token");
    assertEquals(calls.length, 0);
  } finally {
    teardown();
  }
});

// ── Error taxonomy: permanent vs transient ─────────────────────────────────────────────────

Deno.test("HTTP 422 with ErrorCode 300 is PERMANENT — an identical retry fails identically", async () => {
  setup();
  try {
    stub(() => jsonResponse({ ErrorCode: 300, Message: "Invalid email request." }, 422));
    const err = await expectApiError(() => pmSendEmail(SEND), "422/300");
    assertEquals(err.status, 422);
    assertEquals(err.errorCode, 300);
    assertEquals(err.permanent, true);
    assert(err.message.includes("422"), "the message should carry the HTTP status");
    assert(err.message.includes("300"), "the message should carry the ErrorCode");
  } finally {
    teardown();
  }
});

for (const code of [400, 401, 405, 406]) {
  Deno.test(`ErrorCode ${code} is PERMANENT`, async () => {
    setup();
    try {
      stub(() => jsonResponse({ ErrorCode: code, Message: "nope" }, 422));
      const err = await expectApiError(() => pmSendEmail(SEND), `422/${code}`);
      assertEquals(err.errorCode, code);
      assertEquals(err.permanent, true);
    } finally {
      teardown();
    }
  });
}

Deno.test("HTTP 429 is TRANSIENT — retrying a rate limit is the correct response", async () => {
  setup();
  try {
    stub(() => jsonResponse({ ErrorCode: 429, Message: "Rate limit exceeded" }, 429));
    const err = await expectApiError(() => pmSendEmail(SEND), "429");
    assertEquals(err.status, 429);
    assertEquals(err.permanent, false);
  } finally {
    teardown();
  }
});

Deno.test("HTTP 500 is TRANSIENT, even with an unparsable body", async () => {
  setup();
  try {
    stub(() => new Response("<html>Internal Server Error</html>", { status: 500 }));
    const err = await expectApiError(() => pmGetDomain(1234), "500");
    assertEquals(err.status, 500);
    assertEquals(err.errorCode, 0);
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
    const err = await expectApiError(() => pmSendEmail(SEND), "network error");
    assertEquals(err.status, 0);
    assertEquals(err.errorCode, 0);
    assertEquals(err.permanent, false);
  } finally {
    teardown();
  }
});

Deno.test("a bad token (ErrorCode 10) stays TRANSIENT — a secret rotation fixes it, not code", async () => {
  setup();
  try {
    stub(() => jsonResponse({ ErrorCode: 10, Message: "No Account or Server API tokens..." }, 401));
    const err = await expectApiError(() => pmSendEmail(SEND), "401/10");
    assertEquals(err.errorCode, 10);
    assertEquals(err.permanent, false, "ambiguous failures must stay retryable");
  } finally {
    teardown();
  }
});

Deno.test("the raw provider body is NEVER surfaced — Postmark echoes recipient addresses", async () => {
  setup();
  try {
    stub(() => jsonResponse({
      ErrorCode: 406,
      Message: "You tried to send to recipient(s) that have been marked as inactive: lead@example.net",
    }, 422));
    const err = await expectApiError(() => pmSendEmail(SEND), "inactive recipient");
    assertEquals(err.errorCode, 406);
    assertEquals(err.permanent, true);
    assert(!err.message.includes("lead@example.net"), "a recipient address leaked into the error message");
    assert(!err.message.includes("inactive"), "Postmark's Message text leaked into the error message");
  } finally {
    teardown();
  }
});

// ── PmDomain normalization ─────────────────────────────────────────────────────────────────

Deno.test("normalizes the PRE-verify shape (record still under the DKIMPending* names)", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse(PRE_VERIFY_DOMAIN));
    const d = await pmGetDomain(1234);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "GET");
    assertEquals(calls[0].url, "https://api.postmarkapp.com/domains/1234");
    assertEquals(calls[0].headers.get("X-Postmark-Account-Token"), ACCOUNT_TOKEN);
    assertEquals(calls[0].headers.get("X-Postmark-Server-Token"), null,
      "domain calls must not carry the server token");
    assertEquals(d.id, 1234);
    assertEquals(d.dkimHost, "20260810._domainkey.mail.example.com");
    assertEquals(d.dkimValue, "k=rsa; p=TESTKEY");
    assertEquals(d.dkimVerified, false);
    assertEquals(d.returnPathHost, "pm-bounces.mail.example.com");
    assertEquals(d.returnPathValue, "pm.mtasv.net");
    assertEquals(d.returnPathVerified, false);
  } finally {
    teardown();
  }
});

Deno.test("normalizes the POST-verify shape (record moved to DKIMHost/DKIMTextValue)", async () => {
  setup();
  try {
    stub(() => jsonResponse(POST_VERIFY_DOMAIN));
    const d = await pmGetDomain(1234);
    assertEquals(d.id, 1234);
    assertEquals(d.dkimHost, "20260810._domainkey.mail.example.com",
      "the verified-name field must be read once the pending pair empties");
    assertEquals(d.dkimValue, "k=rsa; p=TESTKEY");
    assertEquals(d.dkimVerified, true);
    assertEquals(d.returnPathHost, "pm-bounces.mail.example.com");
    assertEquals(d.returnPathValue, "pm.mtasv.net");
    assertEquals(d.returnPathVerified, true);
  } finally {
    teardown();
  }
});

// ── Domain lifecycle calls ─────────────────────────────────────────────────────────────────

Deno.test("pmCreateDomain posts Name + the pm-bounces Return-Path in ONE request", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse(PRE_VERIFY_DOMAIN));
    const d = await pmCreateDomain("mail.example.com");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].url, "https://api.postmarkapp.com/domains");
    const body = JSON.parse(calls[0].body ?? "{}");
    assertEquals(body.Name, "mail.example.com");
    assertEquals(body.ReturnPathDomain, "pm-bounces.mail.example.com",
      "the custom Return-Path must be requested at creation, not patched in later");
    assertEquals(d.id, 1234);
    assertEquals(d.dkimVerified, false);
  } finally {
    teardown();
  }
});

Deno.test("pmVerifyDomain triggers BOTH checks then reports one consolidated read", async () => {
  setup();
  try {
    const calls = stub((c) => {
      // The PUTs answer with the stale pre-verify shape; only the final GET has the
      // post-verify truth. The returned PmDomain proves which response was used.
      if (c.url.endsWith("/verifyDkim") || c.url.endsWith("/verifyReturnPath")) {
        return jsonResponse(PRE_VERIFY_DOMAIN);
      }
      return jsonResponse(POST_VERIFY_DOMAIN);
    });
    const d = await pmVerifyDomain(1234);
    assertEquals(calls.length, 3);
    assertEquals(calls[0].method, "PUT");
    assertEquals(calls[0].url, "https://api.postmarkapp.com/domains/1234/verifyDkim");
    assertEquals(calls[1].method, "PUT");
    assertEquals(calls[1].url, "https://api.postmarkapp.com/domains/1234/verifyReturnPath");
    assertEquals(calls[2].method, "GET");
    assertEquals(calls[2].url, "https://api.postmarkapp.com/domains/1234");
    assertEquals(d.dkimVerified, true, "the result must come from the final GET, not a PUT");
    assertEquals(d.returnPathVerified, true);
    assertEquals(d.dkimHost, "20260810._domainkey.mail.example.com");
  } finally {
    teardown();
  }
});

Deno.test("pmDeleteDomain issues a DELETE and resolves", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse({ ErrorCode: 0, Message: "Domain removed." }));
    await pmDeleteDomain(1234);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "DELETE");
    assertEquals(calls[0].url, "https://api.postmarkapp.com/domains/1234");
  } finally {
    teardown();
  }
});

// ── Sending ────────────────────────────────────────────────────────────────────────────────

Deno.test("pmSendEmail returns the MessageID and defaults MessageStream to outbound", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse({
      To: "lead@example.net",
      SubmittedAt: "2026-08-10T12:00:00.000Z",
      MessageID: "a8c1040e-db1c-4e18-a4d9-77e3f47f0d5e",
      ErrorCode: 0,
      Message: "OK",
    }));
    const out = await pmSendEmail({
      ...SEND,
      Tag: "tenant-1",
      Metadata: { client_id: "tenant-1", short_code: "SS-TEST123456", kind: "estimate" },
    });
    assertEquals(out.MessageID, "a8c1040e-db1c-4e18-a4d9-77e3f47f0d5e");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].url, "https://api.postmarkapp.com/email");
    assertEquals(calls[0].headers.get("X-Postmark-Server-Token"), SERVER_TOKEN);
    assertEquals(calls[0].headers.get("X-Postmark-Account-Token"), null,
      "sends must not carry the account token");
    const body = JSON.parse(calls[0].body ?? "{}");
    assertEquals(body.From, SEND.From);
    assertEquals(body.To, SEND.To);
    assertEquals(body.Subject, SEND.Subject);
    assertEquals(body.HtmlBody, SEND.HtmlBody);
    assertEquals(body.MessageStream, "outbound", "the default stream must be outbound");
    assertEquals(body.Tag, "tenant-1");
    assertEquals(body.Metadata.client_id, "tenant-1");
    assertEquals(body.Metadata.kind, "estimate");
  } finally {
    teardown();
  }
});

Deno.test("a caller-specified MessageStream overrides the default", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse({ MessageID: "m-1", ErrorCode: 0, Message: "OK" }));
    await pmSendEmail({ ...SEND, MessageStream: "broadcast" });
    const body = JSON.parse(calls[0].body ?? "{}");
    assertEquals(body.MessageStream, "broadcast");
  } finally {
    teardown();
  }
});
