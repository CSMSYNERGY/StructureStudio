/**
 * Unit tests for the SMS registration self-check rule engine.
 *
 * WHY THESE EXIST. This module decides whether a builder is allowed to press a button that
 * spends real money on a carrier registration, and it does so by reading somebody else's web
 * page. Both halves of that are dangerous in opposite directions:
 *
 *  - too strict, and a compliant builder is blocked by a Cloudflare challenge or a PDF policy
 *    they were perfectly entitled to publish. That is the failure this module is designed
 *    around, so the "no page-derived fail" test below is the most important one in the file;
 *  - too loose, and the builder pays for a submission that comes straight back.
 *
 * The wording rules are the fiddly part and the part most likely to be "tidied" by a future
 * reader into a verbatim substring match. The three canonical non-sharing wordings are pinned
 * here precisely so that tidy-up fails the gate instead of failing our builders.
 *
 * Run: deno test --allow-env --allow-read --node-modules-dir=none supabase/functions/_shared/smsComplianceCheck.test.ts
 * (the pre-push gate discovers _shared/*.test.ts automatically — see scripts/preflight.mjs)
 *
 * The module does NO I/O, so there is no fetch to stub and nothing to restore. If a future
 * change to it makes a stub necessary, that change is itself the bug.
 */

import {
  consistencyChecks,
  optInPageChecks,
  policyPageChecks,
  registrableDomain,
  type Check,
  type Declared,
} from "./smsComplianceCheck.ts";
import type { PageFetch } from "./safeFetchText.ts";

// Local assertions rather than jsr:@std/assert, deliberately. The pre-push gate runs this
// file with no --allow-net and no import map, and a gate that needs a registry fetch fails
// closed on an offline machine.
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

/**
 * Mirrors what `safeFetchText.ts`'s `visibleText` promises: script and style CONTENT dropped,
 * tags stripped, whitespace collapsed, lowercased.
 *
 * ⚠️ KEEP THIS IN STEP WITH THE REAL ONE. Building fixtures through it rather than typing the
 * collapsed string by hand is the only way the "a phrase inside a <script> does not count"
 * test means anything — if the fixture were hand-written, that test would only be proving
 * that a string we chose not to type is absent.
 */
function visible(html: string): string {
  return html
    .toLowerCase()
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/g, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/g, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A successful fetch of some HTML. */
function page(html: string, over: Partial<PageFetch> = {}): PageFetch {
  const text = visible(html);
  return {
    requested: "https://example.com/privacy",
    ok: true,
    status: 200,
    finalUrl: "https://example.com/privacy",
    html: true,
    bytes: html.length,
    truncated: false,
    text,
    refusal: null,
    ...over,
  };
}

function keyed(rows: Check[], key: string): Check {
  const hit = rows.find((r) => r.key === key);
  if (!hit) throw new Error(`no row with key ${key} — got: ${rows.map((r) => r.key).join(", ")}`);
  return hit;
}
function verdictOf(rows: Check[], key: string): string {
  return keyed(rows, key).verdict;
}
/** Map of key → verdict, so a "did exactly one row change?" comparison is one line. */
function verdicts(rows: Check[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.verdict;
  return out;
}
function changedKeys(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}

const OK_PRIVACY_URL = "https://example.com/privacy";
const OK_TERMS_URL = "https://example.com/terms";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PRIVACY_TEXTING = `<p>Text messaging: if you tick the box on our designer, we may send you SMS updates about your quote.</p>`;
const PRIVACY_NO_SHARING = `<p>No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.</p>`;
const PRIVACY_HEAD = `<h1>Privacy Policy</h1><p>We collect your name, email address and phone number when you ask us for a quote on a building.</p>`;
const PRIVACY_OK = PRIVACY_HEAD + PRIVACY_TEXTING + PRIVACY_NO_SHARING;

const TERMS_HEAD = `<h1>Terms</h1><p>By joining our text message programme you agree to these terms.</p>`;
const TERMS_FREQ = `<p>Message frequency varies.</p>`;
const TERMS_RATES = `<p>Message and data rates may apply.</p>`;
const TERMS_STOP = `<p>Reply STOP to cancel at any time.</p>`;
const TERMS_HELP = `<p>Reply HELP for assistance, or call us on 555 0100.</p>`;
const TERMS_OK = TERMS_HEAD + TERMS_FREQ + TERMS_RATES + TERMS_STOP + TERMS_HELP;

// ─────────────────────────────────────────────────────────────────────────────
// Content rules — compliant fixtures, then one phrase removed at a time
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("privacy: a compliant page passes every row", () => {
  const rows = policyPageChecks("privacy", OK_PRIVACY_URL, page(PRIVACY_OK));
  for (const r of rows) assertEquals(r.verdict, "pass", `row ${r.key}`);
  assert(rows.length >= 5, "expected url, reachable, readable, texting, no_sharing");
});

Deno.test("terms: a compliant page passes every row", () => {
  const rows = policyPageChecks("terms", OK_TERMS_URL, page(TERMS_OK));
  for (const r of rows) assertEquals(r.verdict, "pass", `row ${r.key}`);
  assert(rows.length >= 7, "expected url, reachable, readable, texting, stop, help, freq, rates");
});

Deno.test("privacy: removing one phrase flips exactly one key", () => {
  const base = verdicts(policyPageChecks("privacy", OK_PRIVACY_URL, page(PRIVACY_OK)));

  const noSharing = verdicts(policyPageChecks(
    "privacy",
    OK_PRIVACY_URL,
    page(PRIVACY_HEAD + PRIVACY_TEXTING),
  ));
  assertEquals(changedKeys(base, noSharing).join(","), "page.privacy.no_sharing");
  assertEquals(noSharing["page.privacy.no_sharing"], "warn");

  const noTexting = verdicts(policyPageChecks(
    "privacy",
    OK_PRIVACY_URL,
    page(PRIVACY_HEAD + PRIVACY_NO_SHARING),
  ));
  assertEquals(changedKeys(base, noTexting).join(","), "page.privacy.texting");
  assertEquals(noTexting["page.privacy.texting"], "warn");
});

Deno.test("terms: removing one phrase flips exactly one key", () => {
  const base = verdicts(policyPageChecks("terms", OK_TERMS_URL, page(TERMS_OK)));
  const cases: Array<[string, string]> = [
    ["page.terms.frequency", TERMS_HEAD + TERMS_RATES + TERMS_STOP + TERMS_HELP],
    ["page.terms.rates", TERMS_HEAD + TERMS_FREQ + TERMS_STOP + TERMS_HELP],
    ["page.terms.stop", TERMS_HEAD + TERMS_FREQ + TERMS_RATES + TERMS_HELP],
    ["page.terms.help", TERMS_HEAD + TERMS_FREQ + TERMS_RATES + TERMS_STOP],
  ];
  for (const [expectedKey, html] of cases) {
    const got = verdicts(policyPageChecks("terms", OK_TERMS_URL, page(html)));
    assertEquals(changedKeys(base, got).join(","), expectedKey, `dropping ${expectedKey}`);
    assertEquals(got[expectedKey], "warn", expectedKey);
  }
});

Deno.test("privacy: all three canonical non-sharing wordings are accepted", () => {
  // ⚠️ These are the wordings actually in circulation, including the one Twilio's own guidance
  // produces. A substring match on any single one of them would warn at the other two — i.e.
  // at the builders most likely to have done this properly.
  const wordings = [
    "No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.",
    "We do not share, sell, or provide your mobile phone number or messaging consent data to third parties or affiliates for marketing or promotional purposes.",
    "All of the above categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties.",
  ];
  for (const w of wordings) {
    const rows = policyPageChecks(
      "privacy",
      OK_PRIVACY_URL,
      page(PRIVACY_HEAD + PRIVACY_TEXTING + `<p>${w}</p>`),
    );
    assertEquals(verdictOf(rows, "page.privacy.no_sharing"), "pass", w.slice(0, 40));
  }
});

Deno.test("terms: rates wording is matched however it is capitalised or punctuated", () => {
  for (
    const w of [
      "Message & Data Rates May Apply",
      "MESSAGE AND DATA RATES MAY APPLY.",
      "Msg & data rates may apply",
      "Standard message and data rates apply.",
    ]
  ) {
    const rows = policyPageChecks(
      "terms",
      OK_TERMS_URL,
      page(TERMS_HEAD + TERMS_FREQ + TERMS_STOP + TERMS_HELP + `<p>${w}</p>`),
    );
    assertEquals(verdictOf(rows, "page.terms.rates"), "pass", w);
  }
});

Deno.test("wording hidden inside a <script> does not count", () => {
  // The fixture's text is built by visible(), the same way safeFetchText builds it, so the
  // sentence genuinely never reaches page.text — which is the point being pinned.
  const html = PRIVACY_HEAD + PRIVACY_TEXTING +
    `<script>var policy = "No mobile information will be shared with third parties or affiliates.";</script>`;
  const p = page(html);
  assert(!p.text.includes("third part"), "fixture leaked script content into visible text");
  assertEquals(
    verdictOf(policyPageChecks("privacy", OK_PRIVACY_URL, p), "page.privacy.no_sharing"),
    "warn",
  );
});

Deno.test("rates and frequency are NEVER checked on the privacy page", () => {
  // ⚠️ This is the "getting it backwards would fail correct builders" guard. Our own privacy
  // page carries no rates or frequency language and is right not to — that language belongs
  // beside the sign-up control and in the programme terms. A privacy page without it must
  // come back clean.
  const rows = policyPageChecks("privacy", OK_PRIVACY_URL, page(PRIVACY_OK));
  assert(!PRIVACY_OK.toLowerCase().includes("rates"), "fixture must not contain rates wording");
  assert(
    !rows.some((r) => /rate|frequen/.test(r.key)),
    `privacy emitted a rates/frequency row: ${rows.map((r) => r.key).join(", ")}`,
  );
  for (const r of rows) assertEquals(r.verdict, "pass", `row ${r.key}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE INVARIANT: nothing page-derived may ever fail
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("no page-derived reason ever produces a fail", () => {
  // Every way a fetch can disappoint us: refused before we started, no answer at all, an
  // error status, a challenge page, a PDF, an empty body, a body cut off by the size cap.
  const broken: Array<PageFetch | null> = [
    null,
    page("", { ok: false, status: 0, finalUrl: null, html: false, bytes: 0, text: "", refusal: "no answer" }),
    page("", { ok: false, status: 403, html: true, text: "", refusal: "http 403" }),
    page("", { ok: false, status: 503, html: true, text: "", refusal: "http 503" }),
    page("<h1>Just a moment...</h1>", { ok: true, status: 200 }),
    page("", { ok: true, status: 200, html: false, bytes: 90000, text: "", refusal: null }),
    page(PRIVACY_HEAD, { truncated: true }),
    page("", { ok: true, status: 200, html: true, text: "" }),
  ];
  for (const p of broken) {
    for (const kind of ["privacy", "terms"] as const) {
      const url = kind === "privacy" ? OK_PRIVACY_URL : OK_TERMS_URL;
      const rows = policyPageChecks(kind, url, p);
      assert(
        rows.every((r) => r.verdict !== "fail"),
        `${kind} produced a fail for a page-derived reason: ` +
          rows.filter((r) => r.verdict === "fail").map((r) => r.key).join(", "),
      );
      assert(rows.length > 0, `${kind} produced no rows at all`);
    }
    // The opt-in group, with a perfectly good business name so the one allowed fail is off.
    const rows = optInPageChecks(p, "Structure Studio");
    assert(
      rows.every((r) => r.verdict !== "fail"),
      "optin produced a fail for a page-derived reason: " +
        rows.filter((r) => r.verdict === "fail").map((r) => r.key).join(", "),
    );
  }
});

Deno.test("no rule quotes the fetched page back at the builder", () => {
  // ⚠️ EXFILTRATION INVARIANT. If a reason or hint ever interpolated page.text, any web page
  // on the internet could put arbitrary words on our portal. The marker below only exists in
  // the fetched bytes.
  const marker = "zzmarkerzz-injected-by-a-stranger";
  const p = page(`<h1>Privacy</h1><p>${marker}</p>`);
  const rows = [
    ...policyPageChecks("privacy", OK_PRIVACY_URL, p),
    ...policyPageChecks("terms", OK_TERMS_URL, p),
    ...optInPageChecks(p, "Structure Studio"),
  ];
  for (const r of rows) {
    assert(!r.reason.includes(marker), `reason of ${r.key} quoted the page`);
    assert(!r.hint.includes(marker), `hint of ${r.key} quoted the page`);
    assert(!r.label.includes(marker), `label of ${r.key} quoted the page`);
  }
});

Deno.test("passing rows never carry a hint", () => {
  const rows = [
    ...policyPageChecks("privacy", OK_PRIVACY_URL, page(PRIVACY_OK)),
    ...policyPageChecks("terms", OK_TERMS_URL, page(TERMS_OK)),
    ...optInPageChecks(page(PRIVACY_OK), "Structure Studio"),
    ...consistencyChecks(goodDeclared()),
  ];
  for (const r of rows) {
    if (r.verdict === "pass") assertEquals(r.hint, "", `${r.key} passed but carries a hint`);
    else assert(r.hint.length > 0, `${r.key} is ${r.verdict} but tells the builder nothing`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The two allowed fails — both deterministic, both about our own database rows
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("a missing or insecure policy link is the one page-group fail", () => {
  for (const bad of ["", "   ", "http://example.com/privacy", "example.com/privacy", "not a url"]) {
    const rows = policyPageChecks("privacy", bad, page(PRIVACY_OK));
    assertEquals(rows.length, 1, `expected a single row for ${JSON.stringify(bad)}`);
    assertEquals(rows[0].key, "page.privacy.url");
    assertEquals(rows[0].verdict, "fail", JSON.stringify(bad));
  }
  assertEquals(
    verdictOf(policyPageChecks("terms", OK_TERMS_URL, page(TERMS_OK)), "page.terms.url"),
    "pass",
  );
});

Deno.test("an unnamed consent box is the one opt-in fail", () => {
  // "this builder" is the literal fallback smsConsentSentence() substitutes, so this is not a
  // blank on screen — it is a live sentence reading "this builder may send you text messages".
  for (const bad of ["", "   ", "this builder", "This Builder"]) {
    assertEquals(
      verdictOf(optInPageChecks(page("<h1>Loading…</h1>"), bad), "optin.company_name"),
      "fail",
      JSON.stringify(bad),
    );
  }
  assertEquals(
    verdictOf(optInPageChecks(page("<h1>Loading…</h1>"), "Structure Studio"), "optin.company_name"),
    "pass",
  );
});

Deno.test("the opt-in group does not claim to have read the consent wording", () => {
  // ⚠️ Our own tick box is React-rendered and only mounts after a visitor works the design
  // canvas; a fetch of that page returns a loading shell with zero occurrences of the consent
  // sentence — measured. A row asserting the wording was found would be a green tick beside
  // something untrue, so there must not be one.
  const rows = optInPageChecks(page("<title>Loading…</title>"), "Structure Studio");
  assertEquals(rows.length, 2, "expected exactly the two honest rows");
  assertEquals(rows.map((r) => r.key).sort().join(","), "optin.company_name,optin.page.reachable");
});

// ─────────────────────────────────────────────────────────────────────────────
// Consistency
// ─────────────────────────────────────────────────────────────────────────────

function goodDeclared(over: Partial<Declared> = {}): Declared {
  return {
    websiteUrl: "https://structurestudiosuite.com/",
    privacyPolicyUrl: "https://structurestudiosuite.com/privacy",
    termsUrl: "https://structurestudiosuite.com/terms",
    settingsWebsite: "https://structurestudiosuite.com",
    legalBusinessName: "CSM Capital LLC DBA Structure Studio Suite",
    consentCompanyName: "Structure Studio",
    messageSamples: ["Structure Studio: your quote is ready. Reply STOP to opt out."],
    hasEmbeddedLinks: false,
    ...over,
  };
}

Deno.test("a tidy tenant passes every consistency row", () => {
  const rows = consistencyChecks(goodDeclared());
  for (const r of rows) assertEquals(r.verdict, "pass", `row ${r.key}: ${r.reason}`);
});

Deno.test("a trading name is not a mismatch", () => {
  // ⚠️ "Structure Studio" against "CSM Capital LLC DBA Structure Studio Suite" is one real,
  // correctly registered business. Warning at it would send a builder off to "fix" something
  // that is already right, so this exact pair is pinned.
  const rows = consistencyChecks(goodDeclared({
    consentCompanyName: "Structure Studio",
    legalBusinessName: "CSM Capital LLC DBA Structure Studio Suite",
  }));
  assertEquals(verdictOf(rows, "match.business_name"), "pass");

  // Two genuinely unrelated names still only warn — never fail.
  const unrelated = consistencyChecks(goodDeclared({
    consentCompanyName: "Bob's Sheds",
    legalBusinessName: "Northfield Holdings Ltd",
  }));
  assertEquals(verdictOf(unrelated, "match.business_name"), "warn");
});

Deno.test("the two unsynced website fields are compared normalised", () => {
  // ⚠️ This is the live finding on the only real tenant: the pre-rebrand domain in one field,
  // the current one in the other.
  const stale = consistencyChecks(goodDeclared({
    settingsWebsite: "www.structurestudioapp.com",
    websiteUrl: "https://structurestudiosuite.com/",
  }));
  assertEquals(verdictOf(stale, "match.website"), "warn");

  // Scheme, www. and a trailing slash are noise, not a mismatch.
  for (
    const [a, b] of [
      ["https://structurestudiosuite.com/", "www.structurestudiosuite.com"],
      ["https://www.example.com", "http://example.com/"],
      ["EXAMPLE.com/", "https://example.com"],
    ]
  ) {
    const rows = consistencyChecks(goodDeclared({
      websiteUrl: a,
      settingsWebsite: b,
      privacyPolicyUrl: "https://example.com/privacy",
      termsUrl: "https://example.com/terms",
    }));
    assertEquals(verdictOf(rows, "match.website"), "pass", `${a} vs ${b}`);
  }
});

Deno.test("a policy hosted elsewhere warns, and says why that is often fine", () => {
  const rows = consistencyChecks(goodDeclared({
    privacyPolicyUrl: "https://sites.google.com/view/ss-privacy",
  }));
  const r = keyed(rows, "match.privacy_domain");
  assertEquals(r.verdict, "warn");
  assert(/often perfectly fine/.test(r.hint), "the hint must not imply the builder is wrong");
  assertEquals(verdictOf(rows, "match.terms_domain"), "pass");
});

Deno.test("message samples must name the business and declare their links", () => {
  const unnamed = consistencyChecks(goodDeclared({
    messageSamples: ["Your quote is ready. Reply STOP to opt out."],
  }));
  assertEquals(verdictOf(unnamed, "match.samples.name"), "warn");

  const linked = consistencyChecks(goodDeclared({
    messageSamples: ["Structure Studio: your quote is ready at https://structurestudiosuite.com/q/12"],
    hasEmbeddedLinks: false,
  }));
  assertEquals(verdictOf(linked, "match.samples.links"), "warn");

  const declared = consistencyChecks(goodDeclared({
    messageSamples: ["Structure Studio: your quote is ready at https://structurestudiosuite.com/q/12"],
    hasEmbeddedLinks: true,
  }));
  assertEquals(verdictOf(declared, "match.samples.links"), "pass");
  assertEquals(verdictOf(declared, "match.samples.name"), "pass");

  const none = consistencyChecks(goodDeclared({ messageSamples: [] }));
  assertEquals(verdictOf(none, "match.samples.name"), "warn");
});

Deno.test("consistency never fails, whatever it is handed", () => {
  const nasty: Declared[] = [
    goodDeclared({ websiteUrl: "", privacyPolicyUrl: "", termsUrl: "", settingsWebsite: "" }),
    goodDeclared({ legalBusinessName: "", consentCompanyName: "" }),
    goodDeclared({ websiteUrl: "nonsense", privacyPolicyUrl: "also nonsense" }),
    goodDeclared({ messageSamples: ["", "   "] }),
  ];
  for (const d of nasty) {
    const rows = consistencyChecks(d);
    assert(
      rows.every((r) => r.verdict !== "fail"),
      "consistency produced a fail: " +
        rows.filter((r) => r.verdict === "fail").map((r) => r.key).join(", "),
    );
    assertEquals(rows.length, 6, "every consistency row must be emitted every time");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// registrableDomain
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("registrableDomain", () => {
  const cases: Array<[string, string]> = [
    ["a.b.example.co.uk", "example.co.uk"],
    ["www.example.com", "example.com"],
    ["example.com", "example.com"],
    ["EXAMPLE.COM", "example.com"],
    ["example.com.", "example.com"],
    ["example.com:443", "example.com"],
    ["shop.example.com.au", "example.com.au"],
    ["deep.sub.example.org", "example.org"],
    ["localhost", "localhost"],
    ["", ""],
    ["192.168.0.1", "192.168.0.1"],
  ];
  for (const [input, expected] of cases) assertEquals(registrableDomain(input), expected, input);
});

// ─────────────────────────────────────────────────────────────────────────────
// Keys
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("every key is unique across the whole module", () => {
  // A collision means two different findings render as one row in the portal, and the second
  // one silently disappears — the builder is then told about a problem they do not have and
  // not told about one they do.
  const sources: Array<[string, Check[]]> = [
    ["policy:privacy", policyPageChecks("privacy", OK_PRIVACY_URL, page(PRIVACY_OK))],
    ["policy:privacy:empty-url", policyPageChecks("privacy", "", null)],
    ["policy:privacy:unreachable", policyPageChecks("privacy", OK_PRIVACY_URL, null)],
    ["policy:privacy:pdf", policyPageChecks("privacy", OK_PRIVACY_URL, page("", { html: false }))],
    ["policy:terms", policyPageChecks("terms", OK_TERMS_URL, page(TERMS_OK))],
    ["policy:terms:empty-url", policyPageChecks("terms", "", null)],
    ["policy:terms:unreachable", policyPageChecks("terms", OK_TERMS_URL, null)],
    ["optin", optInPageChecks(page("<h1>Loading…</h1>"), "Structure Studio")],
    ["optin:unnamed", optInPageChecks(null, "")],
    ["consistency", consistencyChecks(goodDeclared())],
    ["consistency:empty", consistencyChecks(goodDeclared({ websiteUrl: "", legalBusinessName: "" }))],
  ];

  const owner = new Map<string, string>();
  for (const [label, rows] of sources) {
    const seen = new Set<string>();
    for (const r of rows) {
      assert(!seen.has(r.key), `${label} returned duplicate key ${r.key} in one call`);
      seen.add(r.key);
      const prev = owner.get(r.key);
      // Two calls of the same source may legitimately share keys; two different sources
      // never may.
      const source = label.split(":")[0] + ":" + (label.startsWith("policy") ? label.split(":")[1] : "");
      if (prev !== undefined) assertEquals(prev, source, `key ${r.key} is claimed twice`);
      else owner.set(r.key, source);

      assert(r.key.length > 0 && !/\s/.test(r.key), `key ${JSON.stringify(r.key)} is not a slug`);
      assert(r.label.length > 0, `${r.key} has no label`);
      assert(r.reason.length > 0, `${r.key} has no reason`);
    }
  }
});

Deno.test("user-facing strings stay out of telecoms jargon", () => {
  // The reader is a shed builder. If any of these words reach the portal, the row has stopped
  // being useful to the only person who can act on it.
  const banned = /\b(a2p|10dlc|tcr|campaign|vetting|brand registration|throughput|sms api)\b/i;
  const rows = [
    ...policyPageChecks("privacy", OK_PRIVACY_URL, page("")),
    ...policyPageChecks("privacy", "", null),
    ...policyPageChecks("terms", OK_TERMS_URL, page("")),
    ...policyPageChecks("terms", OK_TERMS_URL, null),
    ...optInPageChecks(null, ""),
    ...optInPageChecks(page("<h1>ok</h1>"), "Structure Studio"),
    ...consistencyChecks(goodDeclared({ settingsWebsite: "www.structurestudioapp.com" })),
    ...consistencyChecks(goodDeclared({ websiteUrl: "", legalBusinessName: "" })),
  ];
  for (const r of rows) {
    for (const s of [r.label, r.reason, r.hint]) {
      assert(!banned.test(s), `${r.key} uses jargon: ${JSON.stringify(s)}`);
    }
  }
});
