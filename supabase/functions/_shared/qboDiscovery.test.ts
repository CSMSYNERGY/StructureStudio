/**
 * Unit tests for Intuit OAuth endpoint discovery.
 *
 * WHY THESE EXIST. `token_endpoint` is where we send
 * `Authorization: Basic base64(client_id:client_secret)`. If a malformed or hostile discovery
 * document could move that URL, the document becomes a credential-exfiltration primitive — and
 * the whole module can only be exercised against live Intuit by connecting a real QuickBooks
 * company, which is exactly the step that is blocked on a human click. So the validation and the
 * fallback are pinned here instead, with `fetch` stubbed: no network, no Intuit, no waiting.
 *
 * Run: deno test --allow-env supabase/functions/_shared/qboDiscovery.test.ts
 * (the pre-push gate runs this for you — see scripts/preflight.mjs)
 */

import { _resetQboDiscoveryCache, qboEndpoints, withParams } from "./qboDiscovery.ts";

// Local assertions rather than jsr:@std/assert, deliberately. The pre-push gate runs this file,
// and a gate that needs a registry fetch fails closed on an offline machine — which is the one
// thing scripts/preflight.mjs promises never to do. Three helpers is cheaper than that risk.
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      + (msg ? ` — ${msg}` : ""));
  }
}
function assertNotEquals<T>(actual: T, unexpected: T, msg = ""): void {
  if (actual === unexpected) {
    throw new Error(`Expected NOT ${JSON.stringify(unexpected)}${msg ? ` — ${msg}` : ""}`);
  }
}

const PINNED = {
  authorize: "https://appcenter.intuit.com/connect/oauth2",
  token: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revoke: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
};

const GOOD_DOC = {
  authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2",
  token_endpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revocation_endpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
};

const realFetch = globalThis.fetch;

/** Stub fetch and record every URL asked for. */
function stub(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setup() {
  _resetQboDiscoveryCache();
  // logEdgeError bails out without these, so the failure paths stay offline.
  Deno.env.delete("SUPABASE_URL");
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
}

function teardown() {
  globalThis.fetch = realFetch;
  _resetQboDiscoveryCache();
  Deno.env.delete("QBO_API_BASE");
}

// ── The happy path ─────────────────────────────────────────────────────────────────────────

Deno.test("a valid document is used, and is marked discovered", async () => {
  setup();
  try {
    stub(() => jsonResponse(GOOD_DOC));
    const ep = await qboEndpoints();
    assertEquals(ep.authorize, GOOD_DOC.authorization_endpoint);
    assertEquals(ep.token, GOOD_DOC.token_endpoint);
    assertEquals(ep.revoke, GOOD_DOC.revocation_endpoint);
    assertEquals(ep.discovered, true);
  } finally { teardown(); }
});

Deno.test("Intuit moving to a NEW intuit.com subdomain is honoured — the point of the module", async () => {
  setup();
  try {
    stub(() => jsonResponse({
      ...GOOD_DOC,
      token_endpoint: "https://oauth2.newhost.intuit.com/v9/tokens/bearer",
    }));
    const ep = await qboEndpoints();
    assertEquals(ep.token, "https://oauth2.newhost.intuit.com/v9/tokens/bearer");
    assertEquals(ep.discovered, true);
    assertNotEquals(ep.token, PINNED.token);
  } finally { teardown(); }
});

// ── Every failure must land on the pinned endpoints ────────────────────────────────────────

const FAILURES: Array<[string, () => Response | Promise<Response>]> = [
  ["a non-200 response", () => jsonResponse({}, 503)],
  ["a 404 on the metadata path", () => jsonResponse({}, 404)],
  ["a body that is not JSON", () => new Response("<html>maintenance</html>", { status: 200 })],
  ["an empty JSON object", () => jsonResponse({})],
  ["JSON null", () => jsonResponse(null)],
  ["a JSON array instead of an object", () => jsonResponse([1, 2, 3])],
  ["a network error", () => { throw new TypeError("network unreachable"); }],
];

for (const [label, handler] of FAILURES) {
  Deno.test(`falls back to the pinned endpoints on ${label}`, async () => {
    setup();
    try {
      stub(handler);
      const ep = await qboEndpoints();
      assertEquals(ep.authorize, PINNED.authorize);
      assertEquals(ep.token, PINNED.token);
      assertEquals(ep.revoke, PINNED.revoke);
      assertEquals(ep.discovered, false, "a fallback must never claim to be discovered");
    } finally { teardown(); }
  });
}

Deno.test("falls back when the fetch times out, and does not hang", async () => {
  setup();
  try {
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        // Mimic what a real hung host does: reject when the caller's AbortSignal fires.
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Signal timed out.", "TimeoutError"));
        });
      })) as typeof fetch;
    const started = Date.now();
    const ep = await qboEndpoints();
    const elapsed = Date.now() - started;
    assertEquals(ep.token, PINNED.token);
    assertEquals(ep.discovered, false);
    assert(elapsed < 8000, `should abort near the 4s cap, took ${elapsed}ms`);
    assert(
      // The signal must actually be plumbed through — a missing timeout would resolve instantly
      // via some other path and this bound would be meaningless.
      elapsed >= 3000,
      `expected the ~4s timeout to be what ended it, took ${elapsed}ms`,
    );
  } finally { teardown(); }
});

// ── The security-relevant rejections ──────────────────────────────────────────────────────

const HOSTILE: Array<[string, string]> = [
  ["plain http", "http://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"],
  ["an off-domain host", "https://evil.example.net/oauth2/v1/tokens/bearer"],
  ["a suffix-lookalike domain", "https://intuit.com.evil.example.net/tokens/bearer"],
  ["a prefix-lookalike domain", "https://notintuit.com/tokens/bearer"],
  ["a hyphen-lookalike domain", "https://oauth-intuit.com/tokens/bearer"],
  ["intuit.com only in the query string", "https://evil.example.net/?next=https://oauth.platform.intuit.com"],
  ["intuit.com only in userinfo", "https://oauth.platform.intuit.com@evil.example.net/tokens"],
  ["a protocol-relative URL", "//oauth.platform.intuit.com/oauth2/v1/tokens/bearer"],
  ["a relative path", "/oauth2/v1/tokens/bearer"],
  ["a javascript: URL", "javascript:alert(1)"],
  ["a data: URL", "data:text/plain,hello"],
  ["an empty string", ""],
];

for (const [label, hostileToken] of HOSTILE) {
  Deno.test(`REFUSES a token_endpoint using ${label}`, async () => {
    setup();
    try {
      stub(() => jsonResponse({ ...GOOD_DOC, token_endpoint: hostileToken }));
      const ep = await qboEndpoints();
      // The credential sink must be the pinned URL, never the supplied one.
      assertEquals(ep.token, PINNED.token, `token_endpoint accepted ${label}`);
      assertEquals(ep.discovered, false);
    } finally { teardown(); }
  });
}

// The loop above only ever varies token_endpoint. Validation could be deleted for the other two
// fields and every one of those tests would still pass — so pin each field independently.
// authorization_endpoint matters most of the three: it is where the CUSTOMER is sent.
for (const field of ["authorization_endpoint", "revocation_endpoint"] as const) {
  Deno.test(`REFUSES an off-domain ${field} (not just token_endpoint)`, async () => {
    setup();
    try {
      stub(() => jsonResponse({ ...GOOD_DOC, [field]: "https://evil.example.net/phish" }));
      const ep = await qboEndpoints();
      assertEquals(ep.discovered, false, `${field} was not validated`);
      assertEquals(ep.authorize, PINNED.authorize);
      assertEquals(ep.token, PINNED.token);
      assertEquals(ep.revoke, PINNED.revoke);
    } finally { teardown(); }
  });
}

// ── Fragments and query strings (RFC 6749 §3.1) ───────────────────────────────────────────

Deno.test("REFUSES an authorization_endpoint carrying a fragment", async () => {
  setup();
  try {
    // RFC 6749 §3.1: the authorization endpoint MUST NOT include a fragment. A fragment is never
    // sent to a server, so appending our parameters after it would lose ALL of them.
    stub(() => jsonResponse({
      ...GOOD_DOC,
      authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2#frag",
    }));
    const ep = await qboEndpoints();
    assertEquals(ep.discovered, false, "a fragment must be treated as a malformed document");
    assertEquals(ep.authorize, PINNED.authorize);
  } finally { teardown(); }
});

Deno.test("ACCEPTS an authorization_endpoint carrying a query, as the RFC requires", async () => {
  setup();
  try {
    // The same RFC clause permits a query component and requires clients to RETAIN it. Rejecting
    // it would be over-strict; the caller is responsible for appending correctly.
    stub(() => jsonResponse({
      ...GOOD_DOC,
      authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2?locale=en",
    }));
    const ep = await qboEndpoints();
    assertEquals(ep.discovered, true, "a query component is legal on the authorize endpoint");
    assertEquals(ep.authorize, "https://appcenter.intuit.com/connect/oauth2?locale=en");
  } finally { teardown(); }
});

// Exercises the REAL helper qbo-oauth-connect calls. An earlier version of this test re-implemented
// the composition inline, which meant it would keep passing if the call site reverted to string
// concatenation — testing a copy of the logic proves nothing about the logic in use.
const AUTH_PARAMS = {
  client_id: "CLIENTID",
  response_type: "code",
  scope: "com.intuit.quickbooks.accounting",
  redirect_uri: "https://example.test/cb",
  state: "STATE",
};

Deno.test("withParams retains a discovered query AND lands every parameter", () => {
  const built = withParams("https://appcenter.intuit.com/connect/oauth2?locale=en", AUTH_PARAMS);
  const parsed = new URL(built);
  assertEquals(parsed.searchParams.get("locale"), "en", "Intuit's own query param must survive");
  assertEquals(parsed.searchParams.get("client_id"), "CLIENTID", "client_id must not be swallowed");
  assertEquals(parsed.searchParams.get("response_type"), "code");
  assertEquals(parsed.searchParams.get("scope"), AUTH_PARAMS.scope);
  assertEquals(parsed.searchParams.get("redirect_uri"), AUTH_PARAMS.redirect_uri);
  assertEquals(parsed.searchParams.get("state"), "STATE");
  assert(!built.includes("?locale=en?"), "must not emit a second '?'");
  assertEquals(built.split("?").length, 2, "exactly one '?' in the composed URL");
});

Deno.test("withParams works on a bare endpoint with no existing query", () => {
  const built = withParams("https://appcenter.intuit.com/connect/oauth2", AUTH_PARAMS);
  const parsed = new URL(built);
  assertEquals(parsed.origin + parsed.pathname, "https://appcenter.intuit.com/connect/oauth2");
  assertEquals(parsed.searchParams.get("client_id"), "CLIENTID");
  assertEquals(parsed.searchParams.get("state"), "STATE");
  assertEquals(built.split("?").length, 2);
});

Deno.test("withParams percent-encodes values rather than breaking the URL", () => {
  const built = withParams("https://appcenter.intuit.com/connect/oauth2", {
    // state is base64url in production, but a '&', '=' or '#' in any value must not be able to
    // inject an extra parameter or truncate the query.
    state: "a&b=c#d",
    redirect_uri: "https://example.test/cb?x=1",
  });
  const parsed = new URL(built);
  assertEquals(parsed.searchParams.get("state"), "a&b=c#d");
  assertEquals(parsed.searchParams.get("redirect_uri"), "https://example.test/cb?x=1");
  assertEquals(parsed.hash, "", "a '#' in a value must not become a real fragment");
});

Deno.test("REFUSES a non-string endpoint (type confusion)", async () => {
  setup();
  try {
    stub(() => jsonResponse({ ...GOOD_DOC, token_endpoint: { href: PINNED.token } }));
    const ep = await qboEndpoints();
    assertEquals(ep.token, PINNED.token);
    assertEquals(ep.discovered, false);
  } finally { teardown(); }
});

// ── All-or-nothing ────────────────────────────────────────────────────────────────────────

Deno.test("ONE bad endpoint discards the whole document — no mixing sources", async () => {
  setup();
  try {
    stub(() => jsonResponse({
      // Two perfectly good values, one hostile. A per-field fallback would keep the good two and
      // silently mix a discovered authorize URL with a pinned token URL.
      authorization_endpoint: "https://appcenter.newhost.intuit.com/connect/oauth2",
      token_endpoint: "https://evil.example.net/tokens",
      revocation_endpoint: "https://developer.newhost.intuit.com/v2/oauth2/tokens/revoke",
    }));
    const ep = await qboEndpoints();
    assertEquals(ep.authorize, PINNED.authorize, "the good authorize URL must be discarded too");
    assertEquals(ep.token, PINNED.token);
    assertEquals(ep.revoke, PINNED.revoke);
    assertEquals(ep.discovered, false);
  } finally { teardown(); }
});

Deno.test("a missing revocation_endpoint alone discards the document", async () => {
  setup();
  try {
    const { revocation_endpoint: _drop, ...partial } = GOOD_DOC;
    stub(() => jsonResponse(partial));
    const ep = await qboEndpoints();
    assertEquals(ep.discovered, false);
    assertEquals(ep.token, PINNED.token);
  } finally { teardown(); }
});

// ── Caching ───────────────────────────────────────────────────────────────────────────────

Deno.test("concurrent callers share ONE fetch, and later callers are served from cache", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse(GOOD_DOC));
    const [a, b, c] = await Promise.all([qboEndpoints(), qboEndpoints(), qboEndpoints()]);
    assertEquals(calls.length, 1, "concurrent callers must not stampede Intuit");
    assertEquals(a.token, GOOD_DOC.token_endpoint);
    assertEquals(b.token, GOOD_DOC.token_endpoint);
    assertEquals(c.token, GOOD_DOC.token_endpoint);

    await qboEndpoints();
    await qboEndpoints();
    assertEquals(calls.length, 1, "a warm cache must not refetch");
  } finally { teardown(); }
});

Deno.test("a FAILED lookup is cached too, so an outage cannot cost 4s per request", async () => {
  setup();
  try {
    const calls = stub(() => jsonResponse({}, 500));
    const first = await qboEndpoints();
    const second = await qboEndpoints();
    assertEquals(calls.length, 1, "a failed lookup must be cached, not retried every request");
    assertEquals(first.discovered, false);
    assertEquals(second.token, PINNED.token);
  } finally { teardown(); }
});

Deno.test("the cache EXPIRES: a lookup after the TTL refetches", async () => {
  setup();
  const realNow = Date.now;
  try {
    const calls = stub(() => jsonResponse(GOOD_DOC));
    await qboEndpoints();
    assertEquals(calls.length, 1);

    // Without this test a cache that never expired would pass every other case in this file —
    // the TTL would be dead code and a rotated endpoint would never be picked up by a long-lived
    // isolate. Advance the clock past the 6h TTL rather than waiting for it.
    Date.now = () => realNow() + 7 * 60 * 60 * 1000;
    await qboEndpoints();
    assertEquals(calls.length, 2, "a lookup past the TTL must refetch");

    // ...and the fresh result is cached again rather than refetching every call.
    await qboEndpoints();
    assertEquals(calls.length, 2, "the refreshed value must be cached");
  } finally {
    Date.now = realNow;
    teardown();
  }
});

Deno.test("a failure that later recovers re-arms the failure reporter", async () => {
  setup();
  const realNow = Date.now;
  try {
    // First cycle fails. loggedFailure is now set for this isolate.
    stub(() => jsonResponse({}, 500));
    assertEquals((await qboEndpoints()).discovered, false);

    // TTL rolls over and Intuit recovers — a successful load must clear the flag, otherwise a
    // LATER outage in the same isolate would never be reported and the flag's comment is false.
    Date.now = () => realNow() + 7 * 60 * 60 * 1000;
    stub(() => jsonResponse(GOOD_DOC));
    assertEquals((await qboEndpoints()).discovered, true);

    // Third cycle fails again. Nothing observable to assert without a DB, so assert the fallback
    // still behaves — the flag reset is verified by the module's own state, not by a log row.
    Date.now = () => realNow() + 14 * 60 * 60 * 1000;
    stub(() => jsonResponse({}, 503));
    const third = await qboEndpoints();
    assertEquals(third.discovered, false);
    assertEquals(third.token, PINNED.token);
  } finally {
    Date.now = realNow;
    teardown();
  }
});

Deno.test("a thrown fetch does not wedge the memo — the next TTL cycle still succeeds", async () => {
  setup();
  const realNow = Date.now;
  try {
    stub(() => { throw new TypeError("boom"); });
    // Must RESOLVE, not reject: load() catches internally, so a rejection could never reach the
    // memo. If it ever could, `inFlight` would stay non-null and every later call would reject.
    assertEquals((await qboEndpoints()).discovered, false);
    // A second call in the same cycle must still resolve from cache rather than hit a dead memo.
    assertEquals((await qboEndpoints()).discovered, false);

    // Roll the TTL rather than calling _resetQboDiscoveryCache(): the reset seam nulls `inFlight`
    // itself, so using it here would make this test pass even if a rejection HAD wedged the memo.
    // That is exactly what an earlier version of this test did, and it proved nothing.
    Date.now = () => realNow() + 7 * 60 * 60 * 1000;
    stub(() => jsonResponse(GOOD_DOC));
    const ep = await qboEndpoints();
    assertEquals(ep.discovered, true, "a previous failure must not permanently pin the endpoints");
    assertEquals(ep.token, GOOD_DOC.token_endpoint);
  } finally {
    Date.now = realNow;
    teardown();
  }
});

// ── Environment selection ─────────────────────────────────────────────────────────────────

Deno.test("QBO_API_BASE picks the sandbox metadata document", async () => {
  setup();
  try {
    Deno.env.set("QBO_API_BASE", "https://sandbox-quickbooks.api.intuit.com");
    const calls = stub(() => jsonResponse(GOOD_DOC));
    await qboEndpoints();
    assertEquals(calls.length, 1);
    assert(
      calls[0].endsWith("/.well-known/openid_sandbox_configuration"),
      `expected the sandbox document, asked for ${calls[0]}`,
    );
  } finally { teardown(); }
});

Deno.test("production (and an unset QBO_API_BASE) picks the production document", async () => {
  setup();
  try {
    Deno.env.set("QBO_API_BASE", "https://quickbooks.api.intuit.com");
    let calls = stub(() => jsonResponse(GOOD_DOC));
    await qboEndpoints();
    assert(calls[0].endsWith("/.well-known/openid_configuration"), `asked for ${calls[0]}`);

    _resetQboDiscoveryCache();
    Deno.env.delete("QBO_API_BASE");
    calls = stub(() => jsonResponse(GOOD_DOC));
    await qboEndpoints();
    assert(
      calls[0].endsWith("/.well-known/openid_configuration"),
      `an unset base must default to production, asked for ${calls[0]}`,
    );
  } finally { teardown(); }
});

Deno.test("the discovery fetch carries no Authorization header", async () => {
  setup();
  try {
    let sawAuth = true;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      sawAuth = headers.has("authorization");
      return Promise.resolve(jsonResponse(GOOD_DOC));
    }) as typeof fetch;
    await qboEndpoints();
    assertEquals(sawAuth, false, "metadata lookup must never send credentials");
  } finally { teardown(); }
});
