/**
 * Unit tests for GHL hosted document links.
 *
 * WHY THESE EXIST. These URLs go in front of customers (estimate emails, invoice links), and
 * the two failure shapes are both silent: a missing id turns into ".../estimate/undefined"
 * that 200s and renders a not-found SPA state, and a validity probe that trusts the status
 * code reports every link healthy forever. The module can only be exercised end-to-end
 * against a live GHL location, so the string discipline is pinned here instead — no network.
 *
 * Run: deno test --node-modules-dir=none ghlLinks.test.ts   (from _shared/)
 * (the pre-push gate runs this for you — see scripts/preflight.mjs)
 */

import {
  DEFAULT_PAYMENTS_HOST,
  estimateUrl,
  invoiceUrl,
  pageLooksValid,
} from "./ghlLinks.ts";

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

// ── Missing ids produce null, never a broken link ──────────────────────────────────────────

Deno.test("null / undefined / empty / whitespace ids all return null, both kinds", () => {
  const empties: Array<string | null | undefined> = [null, undefined, "", "   ", "\t\n"];
  for (const id of empties) {
    assertEquals(estimateUrl(id), null, `estimateUrl(${JSON.stringify(id)})`);
    assertEquals(invoiceUrl(id), null, `invoiceUrl(${JSON.stringify(id)})`);
  }
});

// ── The happy path, on the default host ────────────────────────────────────────────────────

Deno.test("a plain id lands on the default payments host with the right path", () => {
  assertEquals(
    estimateUrl("68989bcadb7c2467a0a2b0e2"),
    `${DEFAULT_PAYMENTS_HOST}/estimate/68989bcadb7c2467a0a2b0e2`,
  );
  assertEquals(
    invoiceUrl("68989bcadb7c2467a0a2b0e2"),
    `${DEFAULT_PAYMENTS_HOST}/invoice/68989bcadb7c2467a0a2b0e2`,
  );
});

Deno.test("surrounding whitespace on a real id is trimmed, not encoded", () => {
  assertEquals(
    estimateUrl("  abc123  "),
    `${DEFAULT_PAYMENTS_HOST}/estimate/abc123`,
  );
});

// ── Hostile ids cannot rewrite the link ────────────────────────────────────────────────────

Deno.test("a hostile id is percent-encoded — no path traversal, no injected query", () => {
  const url = estimateUrl("../invoice/evil?x=1#frag");
  assertEquals(
    url,
    `${DEFAULT_PAYMENTS_HOST}/estimate/..%2Finvoice%2Fevil%3Fx%3D1%23frag`,
  );
  // The load-bearing property, stated directly: the raw separators never survive.
  assert(url !== null && !url.includes("/../"), "traversal segment survived encoding");
  assert(url !== null && !url.includes("?"), "query separator survived encoding");
  assert(url !== null && !url.includes("#"), "fragment separator survived encoding");
});

// ── Host override (the location-configurable domain) ───────────────────────────────────────

Deno.test("a host override replaces the default for both kinds", () => {
  assertEquals(
    estimateUrl("abc", "https://pay.example.com"),
    "https://pay.example.com/estimate/abc",
  );
  assertEquals(
    invoiceUrl("abc", "https://pay.example.com"),
    "https://pay.example.com/invoice/abc",
  );
});

Deno.test("a trailing slash on the host does not double the separator", () => {
  assertEquals(
    estimateUrl("abc", "https://pay.example.com/"),
    "https://pay.example.com/estimate/abc",
  );
  assertEquals(
    estimateUrl("abc", "https://pay.example.com///"),
    "https://pay.example.com/estimate/abc",
    "multiple trailing slashes",
  );
});

// ── pageLooksValid: the 200-for-bogus-ids caveat ───────────────────────────────────────────

Deno.test("a page carrying the document number reads as valid", () => {
  const html = `<html><body><div class="doc-header">Estimate EST-49</div></body></html>`;
  assertEquals(pageLooksValid(html, "EST-49"), true);
});

Deno.test("the SPA's not-found state (a 200!) reads as invalid", () => {
  // What a bogus id actually gets: HTTP 200, a rendered page, no document number anywhere.
  const html = `<html><body><div>This document is no longer available.</div></body></html>`;
  assertEquals(pageLooksValid(html, "EST-49"), false);
});

Deno.test("an empty or whitespace docNumber is false, not true-by-vacuity", () => {
  const html = `<html><body>anything at all</body></html>`;
  assertEquals(pageLooksValid(html, ""), false);
  assertEquals(pageLooksValid(html, "   "), false);
});
