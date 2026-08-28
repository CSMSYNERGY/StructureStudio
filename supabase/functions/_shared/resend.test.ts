/**
 * Unit tests for the Resend transport (the DARK Postmark fallback — see resend.ts's header).
 *
 * WHY THESE EXIST. The module can only otherwise be exercised against live Resend — which
 * needs a real API key, makes real DNS-provisioning calls, and (for the send path) sends
 * real email. So the error taxonomy, the not-configured guard, the RsDomain/record
 * normalization and the tag sanitizer are pinned here with `fetch` stubbed: no network, no
 * Resend, no waiting. The permanent/transient verdicts matter most — the future caller
 * (emailSend.ts, once switched) branches on them, and a wrong verdict either strands a
 * retryable email or offers a Retry that can never work. Pinning all of this NOW, while the
 * module is dark, is the point: the day the Postmark appeal fails is not the day to be
 * discovering the fallback's bugs.
 *
 * Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/resend.test.ts
 * (the pre-push gate discovers _shared/*.test.ts automatically — see scripts/preflight.mjs)
 */

import {
  resendConfigured,
  ResendApiError,
  ResendNotConfigured,
  rsCreateDomain,
  rsDeleteDomain,
  rsDomainVerified,
  rsGetDomain,
  rsInboundReady,
  rsInboundRecords,
  rsReceivingEnabled,
  rsSendEmail,
  rsVerifyDomain,
  type RsDomain,
} from "./resend.ts";

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

/** Await fn and hand back the ResendApiError it threw — anything else fails the test. */
async function expectApiError(fn: () => Promise<unknown>, label: string): Promise<ResendApiError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ResendApiError) return e;
    throw new Error(`${label}: threw ${(e as Error)?.name ?? typeof e}, expected ResendApiError`);
  }
  throw new Error(`${label}: did not throw`);
}

async function expectNotConfigured(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ResendNotConfigured) return;
    throw new Error(`${label}: threw ${(e as Error)?.name ?? typeof e}, expected ResendNotConfigured`);
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

const API_KEY = "re_test_key_123";

function setup() {
  Deno.env.set("RESEND_API_KEY", API_KEY);
}
function teardown() {
  globalThis.fetch = realFetch;
  Deno.env.delete("RESEND_API_KEY");
}

const SEND = {
  from: "info@mail.example.com",
  to: "lead@example.net",
  subject: "Your estimate",
  html: "<p>Hi</p>",
};

const DOMAIN_ID = "d91cd9bd-1176-453e-8fc1-35364d380206";

// Resend's domain shape as its API returns it: RELATIVE record names ("send",
// "resend._domainkey"), a per-record `status`, and `priority` only on the MX row. Field
// names are Resend's own — the whole point of the normalizer.
const UNVERIFIED_DOMAIN = {
  object: "domain",
  id: DOMAIN_ID,
  name: "mail.example.com",
  status: "not_started",
  created_at: "2026-08-14T12:00:00.000Z",
  region: "us-east-1",
  records: [
    {
      record: "SPF",
      name: "send",
      type: "MX",
      ttl: "Auto",
      status: "not_started",
      value: "feedback-smtp.us-east-1.amazonses.com",
      priority: 10,
    },
    {
      record: "SPF",
      name: "send",
      type: "TXT",
      ttl: "Auto",
      status: "not_started",
      value: "v=spf1 include:amazonses.com ~all",
    },
    {
      record: "DKIM",
      name: "resend._domainkey",
      type: "TXT",
      ttl: "Auto",
      status: "not_started",
      value: "p=TESTKEY",
    },
  ],
};

const VERIFIED_DOMAIN = {
  ...UNVERIFIED_DOMAIN,
  status: "verified",
  records: UNVERIFIED_DOMAIN.records.map((r) => ({ ...r, status: "verified" })),
};

// ── Configuration guard ────────────────────────────────────────────────────────────────────

Deno.test("resendConfigured requires the ONE key", () => {
  teardown();
  try {
    assertEquals(resendConfigured(), false, "no key set");
    Deno.env.set("RESEND_API_KEY", API_KEY);
    assertEquals(resendConfigured(), true, "key set");
    Deno.env.set("RESEND_API_KEY", "");
    assertEquals(resendConfigured(), false, "an empty key is not configured");
  } finally {
    teardown();
  }
});

Deno.test("a missing key throws ResendNotConfigured BEFORE any fetch", async () => {
  teardown();
  const calls = stub(() => jsonResponse({}));
  try {
    await expectNotConfigured(() => rsCreateDomain("mail.example.com"), "rsCreateDomain");
    await expectNotConfigured(() => rsGetDomain(DOMAIN_ID), "rsGetDomain");
    await expectNotConfigured(() => rsVerifyDomain(DOMAIN_ID), "rsVerifyDomain");
    await expectNotConfigured(() => rsDeleteDomain(DOMAIN_ID), "rsDeleteDomain");
    await expectNotConfigured(() => rsSendEmail(SEND), "rsSendEmail");
    assertEquals(calls.length, 0, "a not-configured call must never reach the network");
  } finally {
    teardown();
  }
});

// ── Error taxonomy: permanent vs transient ─────────────────────────────────────────────────

Deno.test("400 validation_error is PERMANENT — an identical retry fails identically", async () => {
  setup();
  try {
    stub(() => jsonResponse({ statusCode: 400, name: "validation_error", message: "Invalid `from` field." }, 400));
    const err = await expectApiError(() => rsSendEmail(SEND), "400/validation_error");
    assertEquals(err.status, 400);
    assertEquals(err.name_, "validation_error");
    assertEquals(err.permanent, true);
    assert(err.message.includes("400"), "the message should carry the HTTP status");
    assert(err.message.includes("validation_error"), "the message should carry the error name");
  } finally {
    teardown();
  }
});

Deno.test("a 400 WITHOUT the validation_error name stays TRANSIENT — no positive evidence", async () => {
  setup();
  try {
    stub(() => jsonResponse({ statusCode: 400, name: "invalid_idempotency_key", message: "nope" }, 400));
    const err = await expectApiError(() => rsSendEmail(SEND), "400/other");
    assertEquals(err.permanent, false, "ambiguous failures must stay retryable");
  } finally {
    teardown();
  }
});

Deno.test("403 is PERMANENT — the key may not do this, and a retry loop cannot unblock it", async () => {
  setup();
  try {
    stub(() => jsonResponse({ statusCode: 403, name: "validation_error", message: "nope" }, 403));
    const err = await expectApiError(() => rsSendEmail(SEND), "403");
    assertEquals(err.status, 403);
    assertEquals(err.permanent, true);
  } finally {
    teardown();
  }
});

Deno.test("404 not_found is PERMANENT", async () => {
  setup();
  try {
    stub(() => jsonResponse({ statusCode: 404, name: "not_found", message: "Domain not found" }, 404));
    const err = await expectApiError(() => rsGetDomain("missing-id"), "404/not_found");
    assertEquals(err.status, 404);
    assertEquals(err.name_, "not_found");
    assertEquals(err.permanent, true);
  } finally {
    teardown();
  }
});

Deno.test("422 is PERMANENT — the request must change to succeed", async () => {
  setup();
  try {
    stub(() => jsonResponse({ statusCode: 422, name: "missing_required_field", message: "nope" }, 422));
    const err = await expectApiError(() => rsSendEmail(SEND), "422");
    assertEquals(err.status, 422);
    assertEquals(err.permanent, true);
  } finally {
    teardown();
  }
});

Deno.test("429 rate_limit_exceeded is TRANSIENT — retrying a rate limit is the correct response", async () => {
  setup();
  try {
    stub(() => jsonResponse({ statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" }, 429));
    const err = await expectApiError(() => rsSendEmail(SEND), "429");
    assertEquals(err.status, 429);
    assertEquals(err.name_, "rate_limit_exceeded");
    assertEquals(err.permanent, false);
  } finally {
    teardown();
  }
});

Deno.test("HTTP 500 is TRANSIENT, even with an unparsable body", async () => {
  setup();
  try {
    stub(() => new Response("<html>Internal Server Error</html>", { status: 500 }));
    const err = await expectApiError(() => rsGetDomain(DOMAIN_ID), "500");
    assertEquals(err.status, 500);
    assertEquals(err.name_, "");
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
    const err = await expectApiError(() => rsSendEmail(SEND), "network error");
    assertEquals(err.status, 0);
    assertEquals(err.name_, "");
    assertEquals(err.permanent, false);
  } finally {
    teardown();
  }
});

Deno.test("a 401 (bad/missing key) stays TRANSIENT — a key rotation fixes it, not code", async () => {
  setup();
  try {
    stub(() => jsonResponse({ statusCode: 401, name: "missing_api_key", message: "Missing API key" }, 401));
    const err = await expectApiError(() => rsSendEmail(SEND), "401");
    assertEquals(err.status, 401);
    assertEquals(err.permanent, false, "ambiguous failures must stay retryable");
  } finally {
    teardown();
  }
});

Deno.test("the raw provider body is NEVER surfaced — Resend's message can echo recipient addresses", async () => {
  setup();
  try {
    stub(() => jsonResponse({
      statusCode: 403,
      name: "validation_error",
      message: "You can only send testing emails to your own email address (lead@example.net).",
    }, 403));
    const err = await expectApiError(() => rsSendEmail(SEND), "testing-mode 403");
    assertEquals(err.name_, "validation_error");
    assertEquals(err.permanent, true);
    assert(!err.message.includes("lead@example.net"), "a recipient address leaked into the error message");
    assert(!err.message.includes("your own email"), "Resend's message text leaked into the error message");
  } finally {
    teardown();
  }
});

Deno.test("a `name` that is not enum-shaped is DROPPED, not surfaced", async () => {
  setup();
  try {
    // A body field that fails the lowercase-snake gate could carry anything — including an
    // address — so it must never reach the thrown message or name_.
    stub(() => jsonResponse({ statusCode: 422, name: "Rejected: lead@example.net", message: "x" }, 422));
    const err = await expectApiError(() => rsSendEmail(SEND), "non-enum name");
    assertEquals(err.name_, "");
    assertEquals(err.permanent, true, "the 422 verdict must not depend on the dropped name");
    assert(!err.message.includes("lead@example.net"), "a non-enum name leaked into the error message");
  } finally {
    teardown();
  }
});

// ── RsDomain / record normalization ────────────────────────────────────────────────────────

Deno.test("normalizes records: relative name → fqdn, purpose/type/value carried, MX priority kept", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse(UNVERIFIED_DOMAIN));
    const d = await rsGetDomain(DOMAIN_ID);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "GET");
    assertEquals(calls[0].url, `https://api.resend.com/domains/${DOMAIN_ID}`);
    assertEquals(calls[0].headers.get("Authorization"), `Bearer ${API_KEY}`);
    assertEquals(d.id, DOMAIN_ID);
    assertEquals(d.status, "not_started");
    assertEquals(d.records.length, 3);

    const [mx, spf, dkim] = d.records;
    assertEquals(mx.purpose, "SPF");
    assertEquals(mx.host, "send", "host keeps Resend's relative name");
    assertEquals(mx.fqdn, "send.mail.example.com", "fqdn appends the domain HERE, not in the UI");
    assertEquals(mx.type, "MX");
    assertEquals(mx.value, "feedback-smtp.us-east-1.amazonses.com");
    assertEquals(mx.priority, 10, "an MX without its priority cannot be created");
    assertEquals(mx.verified, false);

    assertEquals(spf.type, "TXT");
    assertEquals(spf.fqdn, "send.mail.example.com");
    assertEquals(spf.priority, undefined, "priority only exists on the MX record");

    assertEquals(dkim.purpose, "DKIM");
    assertEquals(dkim.host, "resend._domainkey");
    assertEquals(dkim.fqdn, "resend._domainkey.mail.example.com");
    assertEquals(dkim.value, "p=TESTKEY");
  } finally {
    teardown();
  }
});

Deno.test("record `verified` maps from per-record status; only \"verified\" counts", async () => {
  setup();
  try {
    stub(() => jsonResponse({
      ...UNVERIFIED_DOMAIN,
      records: [
        { ...UNVERIFIED_DOMAIN.records[1], status: "verified" },
        { ...UNVERIFIED_DOMAIN.records[2], status: "pending" },
      ],
    }));
    const d = await rsGetDomain(DOMAIN_ID);
    assertEquals(d.records[0].verified, true);
    assertEquals(d.records[1].verified, false, "\"pending\" is not verified");
  } finally {
    teardown();
  }
});

Deno.test("fqdn building is defensive: apex/empty → domain, already-absolute not double-appended", async () => {
  setup();
  try {
    stub(() => jsonResponse({
      ...UNVERIFIED_DOMAIN,
      records: [
        { ...UNVERIFIED_DOMAIN.records[1], name: "@" },
        { ...UNVERIFIED_DOMAIN.records[1], name: "" },
        { ...UNVERIFIED_DOMAIN.records[1], name: "send.mail.example.com" },
      ],
    }));
    const d = await rsGetDomain(DOMAIN_ID);
    assertEquals(d.records[0].fqdn, "mail.example.com", "@ means the apex");
    assertEquals(d.records[1].fqdn, "mail.example.com", "an empty name means the apex");
    assertEquals(d.records[2].fqdn, "send.mail.example.com", "an absolute name must not double-append");
  } finally {
    teardown();
  }
});

Deno.test("rsDomainVerified is true ONLY on \"verified\"", () => {
  const at = (status: string): RsDomain => ({ id: DOMAIN_ID, status, records: [] });
  assertEquals(rsDomainVerified(at("verified")), true);
  assertEquals(rsDomainVerified(at("not_started")), false);
  assertEquals(rsDomainVerified(at("pending")), false);
  assertEquals(rsDomainVerified(at("failed")), false);
  assertEquals(rsDomainVerified(at("temporary_failure")), false,
    "a previously-passing domain that failed a re-check is NOT usable");
});

Deno.test("rsReceivingEnabled answers a DIFFERENT question from rsDomainVerified", () => {
  const d = (status: string, receiving?: string): RsDomain => ({
    id: DOMAIN_ID, status, records: [],
    ...(receiving ? { capabilities: { sending: "enabled", receiving } } : {}),
  });
  assertEquals(rsReceivingEnabled(d("verified", "enabled")), true);
  // THE PAIR THAT MATTERS. A domain can pass DNS verification and still not be switched on
  // for mail — treating "verified" as "can receive" would advertise a reply address over a
  // mailbox that does not exist, and the customer's reply would bounce back at the customer.
  assertEquals(rsReceivingEnabled(d("verified", "disabled")), false);
  assertEquals(rsDomainVerified(d("verified", "disabled")), true, "sending is a separate verdict");
  // A response with no capabilities block at all must not read as enabled.
  assertEquals(rsReceivingEnabled(d("verified")), false);
});

/** The LIVE shape of a domain with BOTH capabilities on, captured 2026-08-28 from
 *  reply.csmsynergy.com. The two MX rows are the whole point of this fixture. */
const BOTH_CAPS_RECORDS = [
  { purpose: "DKIM", host: "resend._domainkey.reply", fqdn: "", type: "TXT", value: "p=MIGf", verified: false },
  { purpose: "SPF", host: "send.reply", fqdn: "", type: "MX", value: "feedback-smtp.us-east-1.amazonses.com", verified: true, priority: 10 },
  { purpose: "SPF", host: "send.reply", fqdn: "", type: "TXT", value: "v=spf1 include:amazonses.com ~all", verified: false },
  { purpose: "Receiving", host: "reply", fqdn: "", type: "MX", value: "inbound-smtp.us-east-1.amazonaws.com", verified: false, priority: 10 },
];

Deno.test("rsInboundRecords picks the RECEIVING MX, not the return-path MX", () => {
  // ⚠️ THE BUG THIS PINS, found against a live response. A domain with sending AND receiving
  // enabled returns TWO MX rows: the `send.reply` bounce return-path and the `reply` inbound
  // host. A `type === "MX"` filter returns both, and a builder who publishes the wrong one
  // gets mail bouncing while the DNS table insists it is correct.
  const d: RsDomain = { id: DOMAIN_ID, status: "not_started", records: BOTH_CAPS_RECORDS };
  const got = rsInboundRecords(d);
  assertEquals(got.length, 1, "exactly one — never the return-path row");
  assertEquals(got[0].value, "inbound-smtp.us-east-1.amazonaws.com");
  assertEquals(got[0].priority, 10, "an MX without its priority cannot be created");
  // ⚠️ EMPTY, NOT A GUESS. The caller must fail loudly rather than render a hardcoded host.
  assertEquals(rsInboundRecords({ ...d, records: [] }).length, 0);
  assertEquals(rsInboundRecords({ ...d, records: [BOTH_CAPS_RECORDS[1]] }).length, 0,
    "a lone return-path MX is not an inbound record");
});

Deno.test("rsInboundReady fails neither OPEN on a pending domain nor CLOSED on a receiving-only one", () => {
  const caps = { sending: "disabled", receiving: "enabled" };
  const withReceiving = (verified: boolean, status = "not_started"): RsDomain => ({
    id: DOMAIN_ID, status, capabilities: caps,
    records: [{ ...BOTH_CAPS_RECORDS[3], verified }],
  });

  // ⚠️ THE REGRESSION THIS PINS, from live data 2026-08-28. reply.csmsynergy.com looked
  // exactly like this while its inbound store had received ZERO messages — two sends to it
  // reported "delivered" (which per Resend's KB only means the MTA returned 250) and nothing
  // arrived. The first rsInboundReady returned TRUE here, which would flip a tenant to
  // 'active' and start advertising a reply address that swallows every customer reply.
  assertEquals(rsInboundReady({
    id: DOMAIN_ID, status: "pending",
    capabilities: { sending: "enabled", receiving: "enabled" },
    records: [BOTH_CAPS_RECORDS[0], BOTH_CAPS_RECORDS[1], BOTH_CAPS_RECORDS[2],
      { ...BOTH_CAPS_RECORDS[3], verified: true }],
  }), false, "a verified receiving record over a wholly-pending domain is NOT proof of delivery");

  // ⚠️ THE OPPOSITE FAILURE, equally silent. Resend's domain-level "verified" means verified
  // FOR SENDING, so gating on rsDomainVerified alone would permanently block the
  // receiving-only subdomain our own portal creates. partially_verified is Resend's
  // documented status for "one capability verified while the other is pending".
  assertEquals(rsInboundReady(withReceiving(true, "verified")), true);
  assertEquals(rsInboundReady(withReceiving(true, "partially_verified")), true);
  assertEquals(rsInboundReady(withReceiving(true, "partially_failed")), true,
    "the OTHER capability failing is not our problem");
  assertEquals(rsInboundReady(withReceiving(true, "pending")), false);
  assertEquals(rsInboundReady(withReceiving(true)), false, "not_started is never ready");

  assertEquals(rsInboundReady(withReceiving(false, "verified")), false, "record not seen in DNS yet");
  // Receiving switched off is never ready, however green the record looks.
  assertEquals(rsInboundReady({ ...withReceiving(true, "verified"), capabilities: { receiving: "disabled" } }), false);
  // No receiving record at all must never read as ready.
  assertEquals(rsInboundReady({ id: DOMAIN_ID, status: "verified", capabilities: caps, records: [] }), false);
  // A verified return-path MX must not satisfy it either.
  assertEquals(rsInboundReady({
    id: DOMAIN_ID, status: "verified", capabilities: caps, records: [BOTH_CAPS_RECORDS[1]],
  }), false);
});

// ── Domain lifecycle calls ─────────────────────────────────────────────────────────────────

Deno.test("rsCreateDomain asks for receiving ONLY when told to", async () => {
  setup();
  try {
    // A sending domain must not quietly start accepting mail: with no opts the request body
    // is byte-identical to what it was before receiving existed.
    let calls = stub(() => jsonResponse(UNVERIFIED_DOMAIN));
    await rsCreateDomain("mail.example.com");
    assert(!("capabilities" in JSON.parse(calls[0].body ?? "{}")), "omitted, not disabled");

    calls = stub(() => jsonResponse(UNVERIFIED_DOMAIN));
    await rsCreateDomain("reply.example.com", { receiving: true });
    // Sending is asked to be DISABLED. With it on, Resend returns DKIM + SPF rows for the
    // subdomain too, so the builder must publish FOUR records instead of ONE — on a
    // subdomain we never send from. Stringified because this file's assertEquals is a `!==`
    // check, so two structurally identical objects would always "fail".
    assertEquals(
      JSON.stringify(JSON.parse(calls[0].body ?? "{}").capabilities),
      JSON.stringify({ sending: "disabled", receiving: "enabled" }),
    );
  } finally {
    teardown();
  }
});

Deno.test("rsCreateDomain posts name + the pinned region in ONE request", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse(UNVERIFIED_DOMAIN));
    const d = await rsCreateDomain("mail.example.com");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].url, "https://api.resend.com/domains");
    assertEquals(calls[0].headers.get("Authorization"), `Bearer ${API_KEY}`);
    assertEquals(calls[0].headers.get("Content-Type"), "application/json");
    const body = JSON.parse(calls[0].body ?? "{}");
    assertEquals(body.name, "mail.example.com");
    assertEquals(body.region, "us-east-1", "the region is pinned — it is baked into the SPF value");
    assertEquals(d.id, DOMAIN_ID);
    assertEquals(d.status, "not_started");
    assertEquals(d.records[2].fqdn, "resend._domainkey.mail.example.com",
      "create must return the same normalized shape as get");
  } finally {
    teardown();
  }
});

Deno.test("rsVerifyDomain POSTs the check then GETs the fresh full shape", async () => {
  setup();
  try {
    const calls = stub((c) => {
      // The verify POST acknowledges with only {object, id} — no records, no status. The
      // returned RsDomain proves the result came from the follow-up GET.
      if (c.method === "POST") return jsonResponse({ object: "domain", id: DOMAIN_ID });
      return jsonResponse(VERIFIED_DOMAIN);
    });
    const d = await rsVerifyDomain(DOMAIN_ID);
    assertEquals(calls.length, 2);
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].url, `https://api.resend.com/domains/${DOMAIN_ID}/verify`);
    assertEquals(calls[1].method, "GET");
    assertEquals(calls[1].url, `https://api.resend.com/domains/${DOMAIN_ID}`);
    assertEquals(d.status, "verified", "the result must come from the GET, not the verify ack");
    assertEquals(rsDomainVerified(d), true);
    assertEquals(d.records[0].verified, true);
    assertEquals(d.records[0].fqdn, "send.mail.example.com");
  } finally {
    teardown();
  }
});

Deno.test("rsDeleteDomain issues a DELETE and resolves", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse({ object: "domain", id: DOMAIN_ID, deleted: true }));
    await rsDeleteDomain(DOMAIN_ID);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "DELETE");
    assertEquals(calls[0].url, `https://api.resend.com/domains/${DOMAIN_ID}`);
  } finally {
    teardown();
  }
});

// ── Sending ────────────────────────────────────────────────────────────────────────────────

Deno.test("rsSendEmail posts the full body shape and returns the id", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse({ id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }));
    const out = await rsSendEmail({
      ...SEND,
      text: "Hi",
      replyTo: "owner@example.com",
      tags: [
        { name: "client_id", value: "tenant-1" },
        { name: "kind", value: "estimate" },
      ],
    });
    assertEquals(out.id, "4ef9a417-02e9-4d39-ad75-9611e0fcc33c");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].url, "https://api.resend.com/emails");
    assertEquals(calls[0].headers.get("Authorization"), `Bearer ${API_KEY}`);
    const body = JSON.parse(calls[0].body ?? "{}");
    assertEquals(body.from, SEND.from);
    assertEquals(body.to, SEND.to);
    assertEquals(body.subject, SEND.subject);
    assertEquals(body.html, SEND.html);
    assertEquals(body.text, "Hi");
    assertEquals(body.reply_to, "owner@example.com", "replyTo must map to Resend's reply_to");
    assertEquals(body.tags.length, 2);
    assertEquals(body.tags[0].name, "client_id");
    assertEquals(body.tags[0].value, "tenant-1");
    assertEquals(body.tags[1].value, "estimate");
  } finally {
    teardown();
  }
});

Deno.test("omitted optional fields never appear on the wire", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse({ id: "m-1" }));
    await rsSendEmail(SEND);
    const body = JSON.parse(calls[0].body ?? "{}");
    assert(!("text" in body), "an omitted text must not appear as null/undefined");
    assert(!("reply_to" in body), "an omitted replyTo must not appear");
    assert(!("tags" in body), "omitted tags must not appear");
  } finally {
    teardown();
  }
});

Deno.test("tags are sanitized to Resend's charset — the send survives a dotted slug", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse({ id: "m-2" }));
    await rsSendEmail({
      ...SEND,
      tags: [
        { name: "client id", value: "tenant-1.v2" },
        { name: "short_code", value: "SS-ABC123" },
        { name: "reply", value: "lead@example.net" },
      ],
    });
    const body = JSON.parse(calls[0].body ?? "{}");
    assertEquals(body.tags[0].name, "client-id", "a space is outside the charset");
    assertEquals(body.tags[0].value, "tenant-1-v2", "a dot would 422 the whole send");
    assertEquals(body.tags[1].name, "short_code", "underscores and dashes pass through untouched");
    assertEquals(body.tags[1].value, "SS-ABC123");
    assertEquals(body.tags[2].value, "lead-example-net", "an address-shaped value is de-fanged too");
  } finally {
    teardown();
  }
});

// ── Regression: the ZONE-APEX-relative record names Resend actually returns ──────────
//
// ⚠️ The UNVERIFIED_DOMAIN fixture above models a sending domain of mail.example.com whose
// records come back as "send" and "resend._domainkey" — i.e. relative to the SENDING
// DOMAIN. That was an assumption, and it is WRONG. A real create-domain call for
// mail.structurestudiosuite.com on 2026-08-21 returned "send.mail" and
// "resend._domainkey.mail" — relative to the ZONE APEX, which is what a DNS panel's Name
// field wants.
//
// The distinction is invisible on a root domain (no overlap to strip) and only bites on a
// SUBDOMAIN — which is both what our own platform domain is and what Resend explicitly
// recommends builders use. Under the original toFqdn this produced
// "resend._domainkey.mail.mail.structurestudiosuite.com": a doubled label, and a record the
// tenant would dutifully paste at the wrong node.
//
// This fixture is copied from that live response. Do not "simplify" it back to relative
// names — the doubling is exactly what it exists to catch.
const REAL_SUBDOMAIN_DOMAIN = {
  object: "domain",
  id: "89addcb7-d5cc-4ef6-a0ba-572543d8c849",
  name: "mail.structurestudiosuite.com",
  status: "not_started",
  records: [
    {
      record: "DKIM",
      name: "resend._domainkey.mail",
      value: "p=REALKEY",
      type: "TXT",
      status: "not_started",
    },
    {
      record: "SPF",
      name: "send.mail",
      type: "MX",
      status: "not_started",
      value: "feedback-smtp.us-east-1.amazonses.com",
      priority: 10,
    },
    {
      record: "SPF",
      name: "send.mail",
      value: "v=spf1 include:amazonses.com ~all",
      type: "TXT",
      status: "not_started",
    },
  ],
};

Deno.test("a SUBDOMAIN sending domain does not double its label (live-captured shape)", async () => {
  setup();
  try {
    stub(() => jsonResponse(REAL_SUBDOMAIN_DOMAIN));
    const d = await rsGetDomain("89addcb7-d5cc-4ef6-a0ba-572543d8c849");

    const [dkim, mx, spf] = d.records;
    assertEquals(
      dkim.fqdn,
      "resend._domainkey.mail.structurestudiosuite.com",
      "the 'mail' label must appear ONCE, not twice",
    );
    assertEquals(mx.fqdn, "send.mail.structurestudiosuite.com");
    assertEquals(spf.fqdn, "send.mail.structurestudiosuite.com");
    assertEquals(mx.priority, 10, "an MX without its priority cannot be created");

    // The relative name is preserved untouched: a DNS panel's Name field wants it, and only
    // the fqdn is derived.
    assertEquals(dkim.host, "resend._domainkey.mail");
    assertEquals(mx.host, "send.mail");
  } finally {
    teardown();
  }
});

Deno.test("a ROOT sending domain is unaffected by the overlap strip", async () => {
  setup();
  try {
    stub(() =>
      jsonResponse({
        object: "domain",
        id: "root-1",
        name: "juniorbarns.com",
        status: "not_started",
        records: [
          { record: "DKIM", name: "resend._domainkey", value: "p=K", type: "TXT", status: "not_started" },
          { record: "SPF", name: "send", value: "v=spf1 include:amazonses.com ~all", type: "TXT", status: "not_started" },
        ],
      })
    );
    const d = await rsGetDomain("root-1");
    assertEquals(d.records[0].fqdn, "resend._domainkey.juniorbarns.com");
    assertEquals(d.records[1].fqdn, "send.juniorbarns.com");
  } finally {
    teardown();
  }
});
