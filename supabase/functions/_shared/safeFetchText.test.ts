/**
 * Unit tests for safeFetchText — the guarded fetcher for tenant-supplied URLs.
 *
 * WHY THESE EXIST. This is the only code in the repo that opens a URL a stranger typed, from
 * inside an isolate that holds our service-role key. There is no staging environment where a
 * mistake here shows up as a broken page: a hole in this guard is silent, and the first
 * evidence would be somebody else's. So the guard is pinned as a TABLE of hostile addresses —
 * the shape matters as much as the cases, because the day someone finds a bypass, the fix
 * should be one line added to a list that already has 40 friends, not an argument about how to
 * write the test.
 *
 * The single most important case in this file is "a 302 to a numeric address is refused AND
 * fetch ran exactly once". That is the proof that redirect:"manual" is still in place. If
 * somebody ever "simplifies" it to redirect:"follow", every other test here still passes and
 * the guard is silently gone — the built-in follower would chase the Location header itself and
 * guardUrl would never see the second URL.
 *
 * Run: deno test --allow-env --allow-read --node-modules-dir=none supabase/functions/_shared/safeFetchText.test.ts
 * (the pre-push gate discovers _shared/*.test.ts automatically — see scripts/preflight.mjs)
 */

import { fetchPage, guardUrl, visibleText } from "./safeFetchText.ts";

// Local assertions rather than jsr:@std/assert, deliberately. The pre-push gate runs this file
// with no import map and no --allow-net, and a gate that needs a registry fetch fails closed on
// an offline machine — the one thing scripts/preflight.mjs promises never to do.
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  if (actual !== expected) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` +
        (msg ? ` — ${msg}` : ""),
    );
  }
}

const realFetch = globalThis.fetch;

type Call = { url: string; method: string; headers: Headers; redirect: string | undefined };

/** Stub fetch and record every request. Restored in a `finally` by every test that calls it. */
function stub(handler: (call: Call, n: number) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: Call = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers ?? {}),
      redirect: init?.redirect,
    };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length));
  }) as typeof fetch;
  return calls;
}

function restore() {
  globalThis.fetch = realFetch;
}

function html(body: string, init?: { status?: number; type?: string; length?: number }): Response {
  const headers: Record<string, string> = { "content-type": init?.type ?? "text/html; charset=utf-8" };
  if (init?.length !== undefined) headers["content-length"] = String(init.length);
  return new Response(body, { status: init?.status ?? 200, headers });
}

function redirectTo(location: string, status = 302): Response {
  // 302 is a null-body status, so the body must be null — same as a real redirect on the wire.
  return new Response(null, { status, headers: { location } });
}

const OK_PAGE = `
<!doctype html><html><head><title>Privacy</title>
<style>.hide{display:none}</style>
</head><body><h1>Privacy&nbsp;Policy</h1>
<p>We only text customers who have asked us to. Reply STOP to opt out.</p>
</body></html>`;

// ── The hostile table ────────────────────────────────────────────────────────────────────────
// Every row is an address a tenant could type (or a compromised site could redirect to) that we
// must refuse WITHOUT opening a socket. Add a line when you find a new one; never delete one.

type Row = { url: string; why: string };

const MUST_REFUSE: Row[] = [
  // --- scheme: an ALLOWLIST of https, because of these two in particular
  { url: "http://example.com/privacy", why: "plain http — cleartext, and the usual first hop of a downgrade" },
  { url: "file:///proc/self/environ", why: "⚠️ THE ONE THAT MATTERS: Deno fetch reads file: — this is our SUPABASE_SERVICE_ROLE_KEY" },
  { url: "file:///etc/passwd", why: "file: again, in the shape every scanner tries first" },
  { url: "data:text/html,we%20honour%20all%20opt-out%20requests", why: "a policy that passes every content rule by simply asserting itself" },
  { url: "javascript:alert(1)", why: "not a fetchable scheme, but it must not reach the parser's mercy either" },
  { url: "ftp://example.com/terms.txt", why: "any other scheme at all" },
  { url: "blob:https://example.com/2f7a", why: "https appears INSIDE the string — a substring check would pass this" },
  { url: "gopher://example.com/", why: "the classic protocol-smuggling scheme" },
  { url: "//example.com/privacy", why: "protocol-relative: no scheme at all, so it never parses" },

  // --- credentials in the URL
  { url: "https://user:pass@example.com/", why: "credentials we would present to whatever answers" },
  { url: "https://:pass@example.com/", why: "password only — username is empty, so check BOTH fields" },
  { url: "https://admin@example.com/", why: "username only" },

  // --- an explicit port: a port scanner with a timing side channel
  { url: "https://example.com:8080/privacy", why: "a port at all" },
  { url: "https://example.com:22/", why: "probing ssh by timing the failure" },
  { url: "https://example.com:80/", why: "80 is NOT the default for https, so it survives parsing as a real port" },
  { url: "https://example.com:5432/", why: "the Postgres port, which is the whole point of asking" },

  // --- IP literals, in every notation. Most of these are already dead on the name-shape rule;
  //     that is exactly the claim being tested — novel encodings fail by construction.
  { url: "https://127.0.0.1/", why: "loopback, dotted quad" },
  { url: "https://2130706433/", why: "loopback as a decimal dword — parser normalises it to 127.0.0.1" },
  { url: "https://0x7f000001/", why: "loopback in hex" },
  { url: "https://0177.0.0.1/", why: "loopback in octal" },
  { url: "https://[::1]/", why: "loopback in IPv6" },
  { url: "https://[::ffff:169.254.169.254]/", why: "the metadata address wearing an IPv6 costume" },
  { url: "https://169.254.169.254/latest/meta-data/", why: "the cloud metadata service, said plainly" },
  { url: "https://10.0.0.5/privacy", why: "private range" },
  { url: "https://192.168.1.1/", why: "the router on somebody's desk" },
  { url: "https://172.16.4.9/", why: "the private range people forget" },

  // --- reserved names that only resolve inside a network
  { url: "https://localhost/privacy", why: "ourselves" },
  { url: "https://api.localhost/", why: "*.localhost also resolves to loopback" },
  { url: "https://printer.local/", why: "mDNS" },
  { url: "https://vault.internal/", why: "the private-network convention" },
  { url: "https://metadata.google.internal/computeMetadata/v1/", why: "GCP's credential vending machine, named on purpose" },
  { url: "https://instance-data/", why: "AWS's alias for the same thing, named on purpose" },
  { url: "https://router.home.arpa/", why: "home routers" },
  { url: "https://abcdefgh1234.onion/", why: "Tor" },
  { url: "https://shed.test/", why: "RFC-reserved" },
  { url: "https://shed.invalid/", why: "RFC-reserved" },

  // --- name shape
  { url: "https://example/", why: "no dot: not a public name" },
  { url: "https://example.c/", why: "a one-character final label is not a public suffix" },
  { url: "https://example.123/", why: "a numeric final label is an address in disguise" },
  { url: "https://-example.com/", why: "leading hyphen" },
  { url: "https://example-.com/", why: "trailing hyphen" },
  { url: "https://example..com/", why: "empty label" },
  { url: "https://example.com./", why: "trailing dot leaves an empty final label" },
  { url: "https://exam_ple.com/", why: "underscore — the parser allows it, DNS names do not" },
  { url: "https://exa mple.com/", why: "a space: fails parsing outright" },

  // --- junk
  { url: "", why: "empty" },
  { url: "   ", why: "whitespace only" },
  { url: "not a url at all", why: "prose" },
  { url: "https://", why: "a scheme and nothing else" },
  { url: `https://example.com/${"a".repeat(2100)}`, why: "over the 2048-character cap" },
];

Deno.test("guardUrl refuses every address in the hostile table", () => {
  for (const row of MUST_REFUSE) {
    const v = guardUrl(row.url);
    assertEquals(v.ok, false, `MUST REFUSE ${JSON.stringify(row.url)} — ${row.why}`);
    if (!v.ok) {
      assert(
        typeof v.reason === "string" && v.reason.length > 0,
        `refusal for ${row.url} must carry an authored sentence`,
      );
      // The reason is ours, not the runtime's. A leaked parser message would name the host.
      assert(
        !v.reason.includes("Invalid URL"),
        `refusal for ${row.url} leaked the runtime's own error text`,
      );
    }
  }
});

Deno.test("the refusal a builder reads names the thing they must change", () => {
  // Pinned individually because these four are the ones a real builder actually hits, and a
  // reason that does not tell them what to fix turns into a support call to Carolyn.
  const scheme = guardUrl("http://example.com/privacy");
  assert(!scheme.ok && scheme.reason.includes("https://"), "http refusal must name https");
  const creds = guardUrl("https://u:p@example.com/");
  assert(!creds.ok && creds.reason.includes("password"), "credentials refusal must name the password");
  const port = guardUrl("https://example.com:8080/");
  assert(!port.ok && port.reason.includes("port"), "port refusal must name the port");
  const long = guardUrl(`https://example.com/${"a".repeat(2100)}`);
  assert(!long.ok && long.reason.includes("too long"), "length refusal must say too long");
});

Deno.test("guardUrl allows ordinary builder websites", () => {
  const allowed = [
    "https://example.com",
    "https://www.shedco.co.uk/privacy-policy",
    "https://sub.domain.example.com/legal/terms?v=2#top",
    "https://EXAMPLE.COM/Privacy", // the parser lowercases the host for us
    "https://example.com:443/", // :443 is the https default, so the parser drops it — not "a port"
    "https://xn--80ak6aa92e.com/", // punycode is fine as long as the TLD is alphabetic
  ];
  for (const url of allowed) {
    const v = guardUrl(url);
    assertEquals(v.ok, true, `MUST ALLOW ${url}`);
  }
  const norm = guardUrl("https://EXAMPLE.COM/Privacy");
  assert(norm.ok && norm.url.hostname === "example.com", "host is normalised to lowercase");
});

// ── fetchPage: the network contract ──────────────────────────────────────────────────────────

Deno.test("a refused URL never opens a socket", async () => {
  const calls = stub(() => html(OK_PAGE));
  try {
    const r = await fetchPage("file:///proc/self/environ");
    assertEquals(calls.length, 0, "the guard must run BEFORE fetch, not after");
    assertEquals(r.ok, false);
    assertEquals(r.status, 0, "no answer was ever received");
    assertEquals(r.text, "", "nothing to read");
    assertEquals(r.finalUrl, null);
    assert(r.refusal !== null, "a refusal always says why");
    assertEquals(r.requested, "file:///proc/self/environ", "the URL is echoed back as given");
  } finally {
    restore();
  }
});

Deno.test("200 text/html reads, strips and lowercases the page", async () => {
  stub(() => html(OK_PAGE));
  try {
    const r = await fetchPage("https://shedco.example/privacy");
    assertEquals(r.ok, true);
    assertEquals(r.status, 200);
    assertEquals(r.html, true);
    assertEquals(r.truncated, false);
    assertEquals(r.refusal, null);
    assertEquals(r.finalUrl, "https://shedco.example/privacy");
    assert(r.bytes > 0, "bytes read is reported");
    assert(r.text.includes("reply stop to opt out"), "prose survives, lowercased");
    assert(r.text.includes("privacy policy"), "&nbsp; decoded to a space");
    assert(!r.text.includes("<h1>"), "tags are gone");
    assert(!r.text.includes("display:none"), "style contents are gone");
  } finally {
    restore();
  }
});

Deno.test("404 is not ok and carries the status", async () => {
  stub(() => html("<h1>not found</h1>", { status: 404 }));
  try {
    const r = await fetchPage("https://shedco.example/privacy");
    assertEquals(r.ok, false);
    assertEquals(r.status, 404, "the status is what tells the builder their link is dead");
    assertEquals(r.text, "", "a failed fetch yields no text, ever");
    assert(r.refusal !== null, "and an authored reason");
  } finally {
    restore();
  }
});

Deno.test("a PDF policy is reachable but not readable prose", async () => {
  stub(() => html("%PDF-1.7 binary junk", { type: "application/pdf" }));
  try {
    const r = await fetchPage("https://shedco.example/privacy.pdf");
    assertEquals(r.html, false, "html:false is how the caller says 'that is a PDF, not a page'");
    assertEquals(r.status, 200, "and status 200 distinguishes it from a dead link");
    assertEquals(r.ok, false);
    assertEquals(r.text, "");
  } finally {
    restore();
  }
});

Deno.test("text/plain terms are readable", async () => {
  stub(() => html("Reply STOP to opt out.", { type: "text/plain" }));
  try {
    const r = await fetchPage("https://shedco.example/terms.txt");
    assertEquals(r.ok, true);
    assertEquals(r.html, true, "text/plain counts as readable prose");
    assert(r.text.includes("reply stop"), "");
  } finally {
    restore();
  }
});

Deno.test("⚠️ a 302 to a numeric address is refused, and fetch ran EXACTLY ONCE", async () => {
  // THE case. One call means we saw the Location ourselves and stopped. Two (or one that
  // "succeeded") means redirect:"manual" was dropped and the runtime followed it for us — at
  // which point the guard is decorative and the metadata address was fetched.
  const calls = stub((_c, n) => {
    if (n === 1) return redirectTo("http://169.254.169.254/latest/meta-data/");
    return html("SHOULD NEVER BE REACHED");
  });
  try {
    const r = await fetchPage("https://shedco.example/privacy");
    assertEquals(calls.length, 1, "redirect:\"manual\" is gone — the runtime followed the hop for us");
    assertEquals(calls[0].redirect, "manual", "the request itself must ask for manual redirects");
    assertEquals(r.ok, false);
    assertEquals(r.text, "");
    assert(r.refusal !== null, "");
    assert(
      !r.refusal!.includes("169.254"),
      "the refusal must not echo where the site forwarded to",
    );
  } finally {
    restore();
  }
});

Deno.test("every redirect hop is re-guarded, including a relative Location", async () => {
  const calls = stub((_c, n) => {
    if (n === 1) return redirectTo("/legal/privacy"); // relative — must resolve against current
    if (n === 2) return redirectTo("https://www.shedco.example/legal/privacy");
    return html(OK_PAGE);
  });
  try {
    const r = await fetchPage("https://shedco.example/privacy");
    assertEquals(calls.length, 3, "two hops followed, then the real page");
    assertEquals(calls[1].url, "https://shedco.example/legal/privacy", "relative Location resolved");
    assertEquals(r.ok, true);
    assertEquals(r.finalUrl, "https://www.shedco.example/legal/privacy", "finalUrl is where we ended up");
  } finally {
    restore();
  }
});

Deno.test("a 3-hop chain is refused at the cap, after exactly 3 requests", async () => {
  const calls = stub((_c, n) => redirectTo(`https://shedco.example/hop${n}`));
  try {
    const r = await fetchPage("https://shedco.example/privacy");
    assertEquals(calls.length, 3, "two hops followed; the third redirect is refused, not chased");
    assertEquals(r.ok, false);
    assert(r.refusal !== null && r.refusal.includes("forwarding"), "reason names the forwarding");
  } finally {
    restore();
  }
});

Deno.test("a redirect with no Location is refused, not retried", async () => {
  const calls = stub(() => new Response(null, { status: 302 }));
  try {
    const r = await fetchPage("https://shedco.example/privacy");
    assertEquals(calls.length, 1);
    assertEquals(r.ok, false);
    assertEquals(r.status, 302);
  } finally {
    restore();
  }
});

Deno.test("a 2 MB body is capped at 256 KiB and reported as truncated", async () => {
  // No content-length header: the chunked case, where the only defence is the streaming cap.
  const big = "<html><body>" + "policy text ".repeat(180_000) + "</body></html>";
  assert(big.length > 2_000_000, "the fixture really is ~2 MB");
  stub(() => html(big));
  try {
    const r = await fetchPage("https://shedco.example/privacy");
    assertEquals(r.ok, true, "a fat page is still usable — we read the top of it");
    assert(r.bytes <= 262144, `read cap breached: ${r.bytes} bytes`);
    assertEquals(r.truncated, true, "and the caller is told the read stopped early");
    assert(r.text.includes("policy text"), "the part we did read is intact");
  } finally {
    restore();
  }
});

Deno.test("an absurd declared content-length is refused before the transfer", async () => {
  stub(() => html("<html>irrelevant</html>", { length: 50_000_000 }));
  try {
    const r = await fetchPage("https://shedco.example/privacy");
    assertEquals(r.ok, false);
    assertEquals(r.bytes, 0, "we hung up rather than pulling 50 MB into the isolate");
    assertEquals(r.status, 200, "the page answered; it is just unreadable");
  } finally {
    restore();
  }
});

Deno.test("a page that merely declares more than the read cap is still read", async () => {
  // The counterpart to the test above. A 400 KB page with inlined CSS is an ordinary Wix
  // privacy policy — refusing it would tell a compliant builder their live page is missing.
  stub(() => html(`<html><body>reply stop to opt out</body></html>`, { length: 400_000 }));
  try {
    const r = await fetchPage("https://shedco.example/privacy");
    assertEquals(r.ok, true, "a large-but-plausible page must not be refused outright");
    assert(r.text.includes("reply stop"), "");
  } finally {
    restore();
  }
});

Deno.test("a fetch that throws never rejects and never leaks the error text", async () => {
  stub(() => {
    throw new TypeError("error sending request for url (https://10.0.0.7/): connection refused");
  });
  try {
    const r = await fetchPage("https://shedco.example/privacy");
    assertEquals(r.ok, false);
    assertEquals(r.status, 0, "no answer was received");
    assertEquals(r.text, "");
    assertEquals(r.bytes, 0);
    assert(r.refusal !== null && !r.refusal.includes("10.0.0.7"), "the resolved address must not escape");
  } finally {
    restore();
  }
});

Deno.test("a timeout is reported as a timeout, not as unreachable", async () => {
  stub(() => {
    const e = new Error("timed out");
    e.name = "TimeoutError";
    throw e;
  });
  try {
    const r = await fetchPage("https://shedco.example/privacy", { timeoutMs: 50 });
    assertEquals(r.ok, false);
    assertEquals(r.status, 0);
    assert(r.refusal !== null && r.refusal.includes("too long"), "the builder is told it was slow");
  } finally {
    restore();
  }
});

Deno.test("the request identifies us honestly and asks for a page", async () => {
  const calls = stub(() => html(OK_PAGE));
  try {
    await fetchPage("https://shedco.example/privacy");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "GET", "never HEAD: plenty of sites 405 it, and we need the body");
    assertEquals(calls[0].headers.get("accept"), "text/html,application/xhtml+xml");
    assertEquals(
      calls[0].headers.get("user-agent"),
      "StructureStudio-ComplianceCheck/1.0 (+https://app.structurestudiosuite.com)",
      "⚠️ never spoof a browser UA — a spoofed crawler is what gets us WAF-blocked for every tenant at once",
    );
  } finally {
    restore();
  }
});

// ── visibleText ──────────────────────────────────────────────────────────────────────────────

Deno.test("⚠️ a phrase inside <script> does NOT survive", () => {
  // The false-pass case. Analytics and consent snippets are full of strings like these; if they
  // counted, a site with no policy text at all would pass the check and we would tell a builder
  // they are fine right up until a carrier disagrees.
  const page = `<html><head><script>
      var banner = {text: "we honour every opt-out request", url: "/privacy-policy"};
    </script></head><body><p>Sheds built to order.</p></body></html>`;
  const t = visibleText(page);
  assert(!t.includes("opt-out"), `script text leaked into the visible prose: ${t}`);
  assert(!t.includes("privacy-policy"), "script attribute values leaked too");
  assert(t.includes("sheds built to order"), "the real body text is still there");
});

Deno.test("style contents and comments do not survive either", () => {
  const t = visibleText(
    `<style>body:after{content:"consent given"}</style><!-- terms of service --><p>Hello</p>`,
  );
  assertEquals(t, "hello");
});

Deno.test("an unclosed script (a truncated page) still strips to the end", () => {
  // What a 256 KiB cut through a page's inline JavaScript actually looks like.
  const t = visibleText(`<p>Real text.</p><script>var s = "we never send marketing texts`);
  assert(t.includes("real text."), "");
  assert(!t.includes("marketing texts"), "an unterminated script must not leak its contents");
});

Deno.test("entities decode, and &amp; decodes last", () => {
  assertEquals(visibleText("<p>Terms &amp; Conditions</p>"), "terms & conditions");
  assertEquals(visibleText("<p>a&nbsp;b</p>"), "a b");
  assertEquals(visibleText("<p>&quot;stop&quot; &#39;stop&#39;</p>"), `"stop" 'stop'`);
  // ⚠️ The one that catches a wrong decode order: decoding &amp; first would turn this into a
  // real tag AFTER tag-stripping has already run.
  assertEquals(visibleText("<p>&amp;lt;script&amp;gt;</p>"), "&lt;script&gt;");
});

Deno.test("tags vanish and whitespace collapses", () => {
  const t = visibleText(
    "<div class='a'>\n  <h1>Privacy</h1>\n\n  <p>Reply <b>STOP</b> to opt out.</p>\n</div>",
  );
  assertEquals(t, "privacy reply stop to opt out.");
});

Deno.test("visibleText is total: junk in, empty or harmless out", () => {
  assertEquals(visibleText(""), "");
  assertEquals(visibleText("plain words"), "plain words");
  // Malformed angle brackets leave stray ">" characters behind, and that is the right outcome:
  // the tag-strip consumes "<...>" greedily from the left, so what survives can never be a tag.
  // The invariant worth pinning is that no "<" ever comes out the other side.
  assert(!visibleText("<<<>>>").includes("<"), "no opening bracket survives the strip");
  assert(!visibleText("<p<b>hi</p").includes("<"), "no opening bracket survives the strip");
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions from the 2026-09-03 adversarial review. Each of these passed the
// original suite and was wrong anyway.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("a hostname that CARRIES an IP address is refused — nip.io and friends", () => {
  // The shape allowlist is strong against IP *encodings* and was blind to a perfectly
  // well-formed name that a free public wildcard resolver points at the metadata address.
  // No nameserver to run, no race to win, no rebinding: just a URL.
  for (const u of [
    "https://169.254.169.254.nip.io/latest/meta-data/",
    "https://127.0.0.1.nip.io/",
    "https://10.0.0.1.sslip.io/",
    "https://192.168.0.1.example.com/",
  ]) {
    assertEquals(guardUrl(u).ok, false, `must refuse ${u}`);
  }
  // And a normal name with numbers in it is still fine — the rule is four dotted numbers,
  // not "contains a digit".
  assertEquals(guardUrl("https://shed4u.example.com/privacy").ok, true, "shed4u is a real name");
  assertEquals(guardUrl("https://24x7sheds.co.uk/terms").ok, true, "24x7 is a real name");
});

Deno.test("a nonsense option returns a PageFetch instead of throwing", async () => {
  // AbortSignal.timeout() is constructed before the try block and throws on a negative or NaN
  // argument, so "this function never rejects" was true of the network and false of the
  // arguments — and a caller computing "time left in this request" is exactly where a negative
  // number comes from.
  globalThis.fetch = (() => Promise.reject(new Error("should not be reached"))) as typeof fetch;
  try {
    for (const opts of [{ timeoutMs: -1 }, { timeoutMs: NaN }, { timeoutMs: 1e30 }, { maxBytes: -1 }]) {
      const r = await fetchPage("https://169.254.169.254.nip.io/", opts);
      assertEquals(r.ok, false, `must report, not throw, for ${JSON.stringify(opts)}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("an unclosed <template> does not leak unrendered boilerplate", () => {
  // <template> content is never shown to a visitor, and consent-banner tools ship exactly this
  // sentence inside one. Without the companion pattern a truncated body let it satisfy a
  // content rule — which also breaks the promise the rules module leans on when `truncated`
  // is true: "anything we found in the part we read is really on the page".
  const leaked = visibleText("<p>real.</p><template>we never share your mobile number with third parties");
  assert(!leaked.includes("third parties"), `template content leaked: ${leaked}`);
  const leaked2 = visibleText("<p>real.</p><noscript>we never share your mobile number with third parties");
  assert(!leaked2.includes("third parties"), `noscript content leaked: ${leaked2}`);
});
