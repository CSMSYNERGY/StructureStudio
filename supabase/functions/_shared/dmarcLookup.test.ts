// The existing-DMARC check behind Settings → Email Settings (2026-10-05). The DNS table used to
// advise "publish v=DMARC1; p=none at _dmarc.<domain>" for every domain without looking, and
// following it where a record exists either adds a second record (receivers then ignore both) or
// replaces the builder's own policy with none. This pins the DNS-over-HTTPS read that now comes
// first: what counts as a record, how a TXT record split into several strings is joined, what a
// subdomain inherits from its parent, and that every doubt answers null (the screen then says
// nothing) instead of "none" (the screen would then advise p=none).
//
// Nothing here reaches the network: every lookup is handed a fetch stub through `fetchImpl`.
// Only jsr:@std/assert is imported, because the pre-push gate runs _shared/*.test.ts with no
// import map. Domains are made up (.test); the repo is public.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  dmarcDomainOf, dmarcNamesFor, dmarcPolicy, dmarcRecordsOf, dmarcTag, isDmarcRecord, lookupExistingDmarc, txtData,
} from "./dmarcLookup.ts";

// ── The answer, as Cloudflare's JSON resolver gives it ────────────────────────────────────
const TXT = 16, CNAME = 5;
/** One TXT row in Cloudflare's presentation form: each string quoted, strings space-separated. */
const quoted = (...parts: string[]) => parts.map((p) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(" ");
const answer = (name: string, ...rows: { type: number; data: string }[]) => ({
  Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false,
  Question: [{ name, type: TXT }],
  Answer: rows.map((r) => ({ name, TTL: 300, ...r })),
});
const NXDOMAIN = (name: string) => ({ Status: 3, Question: [{ name, type: TXT }], Authority: [{ name: "test", type: 6, TTL: 900, data: "ns.test. hostmaster.test. 1 1800 900 604800 900" }] });
const NODATA = (name: string) => ({ Status: 0, Question: [{ name, type: TXT }] });

type Seen = { url: URL; init: RequestInit };
/** A fetch stub that answers per _dmarc name from `by`, and records every request. A function
 *  value is called with the request's init (for the timeout case); a missing name is a 404. */
function dohStub(by: Record<string, unknown | ((init: RequestInit) => Promise<Response>)>) {
  const seen: Seen[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, init: init ?? {} });
    const name = url.searchParams.get("name") ?? "";
    const v = by[name];
    if (typeof v === "function") return (v as (i: RequestInit) => Promise<Response>)(init ?? {});
    if (v === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    if (v instanceof Response) return Promise.resolve(v);
    return Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/dns-json" } }));
  }) as typeof fetch;
  return { impl, seen };
}

// ── Reading a TXT answer ──────────────────────────────────────────────────────────────────

Deno.test("txtData: one quoted string, strings split at 255 joined with nothing, escapes, and Google's unquoted form", () => {
  assertEquals(txtData(`"v=DMARC1; p=none; rua=mailto:info@acmesheds.test"`), "v=DMARC1; p=none; rua=mailto:info@acmesheds.test");
  assertEquals(txtData(`"v=DMARC1; p=" "reject; rua=mailto:dmarc@acmesheds.test"`), "v=DMARC1; p=reject; rua=mailto:dmarc@acmesheds.test",
    "a record split into strings reads as one, with no space added at the split");
  assertEquals(txtData(`"v=DMARC1\\059 p=quarantine"`), "v=DMARC1; p=quarantine", "\\DDD is a decimal byte (059 is ;)");
  assertEquals(txtData(`"say \\"hi\\" \\\\ there"`), `say "hi" \\ there`, "\\\" and \\\\");
  assertEquals(txtData("v=DMARC1; p=none"), "v=DMARC1; p=none", "Google's resolver gives the joined text with no quotes");
  assertEquals(txtData(quoted("v=DMARC1; ", "p=none")), "v=DMARC1; p=none");
});

Deno.test("isDmarcRecord: only TXT text that starts with v=DMARC1 is a DMARC record", () => {
  for (const yes of ["v=DMARC1; p=none", "V=dmarc1;p=reject", "v = DMARC1 ; p=quarantine", "  v=DMARC1", "v=DMARC1"]) assert(isDmarcRecord(yes), yes);
  for (const no of ["v=spf1 include:example.test -all", "google-site-verification=abc", "p=none; v=DMARC1", "v=DMARC10; p=none", "v=DMARC", ""]) assert(!isDmarcRecord(no), no);
});

Deno.test("dmarcTag: p and sp, case and spaces ignored, null without the tag", () => {
  assertEquals(dmarcTag("v=DMARC1; p=Reject; sp=none", "p"), "reject");
  assertEquals(dmarcTag("v=DMARC1;p=quarantine;sp=REJECT", "sp"), "reject");
  assertEquals(dmarcTag("v=DMARC1 ; p = none ; rua=mailto:a@acmesheds.test", "p"), "none");
  assertEquals(dmarcTag("v=DMARC1; rua=mailto:a@acmesheds.test", "p"), null);
  assertEquals(dmarcTag("v=DMARC1; p=", "p"), null, "an empty value is no value");
  assertEquals(dmarcTag("v=DMARC1; np=reject; p=none", "p"), "none", "np= is not p=");
  assertEquals(["none", "quarantine", "reject", "rejct", "none<b>", "", null].map((v) => dmarcPolicy(v)),
    ["none", "quarantine", "reject", null, null, null, null], "only the three real policies are ever shown");
});

Deno.test("dmarcRecordsOf: none, one, split strings, two, a CNAME to a hosted service, and stray TXT", () => {
  const n = "_dmarc.acmesheds.test";
  assertEquals(dmarcRecordsOf(NXDOMAIN(n)), [], "NXDOMAIN: no record");
  assertEquals(dmarcRecordsOf(NODATA(n)), [], "NOERROR with no answer: no record");
  assertEquals(dmarcRecordsOf(answer(n, { type: TXT, data: quoted("v=DMARC1; p=quarantine") })), ["v=DMARC1; p=quarantine"]);
  assertEquals(dmarcRecordsOf(answer(n, { type: TXT, data: quoted("v=DMARC1; p=reject; rua=mailto:", "dmarc@acmesheds.test") })),
    ["v=DMARC1; p=reject; rua=mailto:dmarc@acmesheds.test"]);
  assertEquals(dmarcRecordsOf(answer(n,
    { type: TXT, data: quoted("v=DMARC1; p=none") },
    { type: TXT, data: quoted("v=DMARC1; p=reject") },
  )), ["v=DMARC1; p=none", "v=DMARC1; p=reject"], "two records at one name are both counted");
  assertEquals(dmarcRecordsOf({
    Status: 0,
    Answer: [
      { name: n, type: CNAME, TTL: 300, data: "acmesheds.dmarc-host.test." },
      { name: "acmesheds.dmarc-host.test", type: TXT, TTL: 300, data: quoted("v=DMARC1; p=quarantine") },
    ],
  }), ["v=DMARC1; p=quarantine"], "a CNAME'd _dmarc reads the target's TXT");
  assertEquals(dmarcRecordsOf(answer(n,
    { type: TXT, data: quoted("v=spf1 include:example.test -all") },
    { type: TXT, data: quoted("some-verification=abc123") },
  )), [], "TXT that is not v=DMARC1 does not count as a record");
});

Deno.test("dmarcRecordsOf: anything that is not a usable answer is null (unknown), never an empty list", () => {
  for (const bad of [null, undefined, "nope", 42, {}, { Status: 2 }, { Status: 5, Answer: [] }, { Status: "0" }, { Status: 0, Answer: "x" }]) {
    assertEquals(dmarcRecordsOf(bad), null, JSON.stringify(bad));
  }
});

// ── Which domain, and which names ─────────────────────────────────────────────────────────

Deno.test("dmarcDomainOf: the domain in the DKIM host Resend returned, then its SPF host, never a guess", () => {
  const dkim = { type: "TXT", host: "resend._domainkey.acmesheds.test", value: "p=MIGf", verified: true };
  const spfMx = { type: "MX", host: "send.acmesheds.test", value: "feedback-smtp.example.test", verified: true, priority: 10 };
  const links = { type: "CNAME", host: "links.acmesheds.test", value: "links1.example.test", verified: false, tracking: true };
  assertEquals(dmarcDomainOf([spfMx, dkim, links]), "acmesheds.test");
  assertEquals(dmarcDomainOf([{ ...dkim, host: "resend._domainkey.MAIL.AcmeSheds.test." }]), "mail.acmesheds.test", "case and a trailing dot");
  assertEquals(dmarcDomainOf([spfMx, links]), "acmesheds.test", "no DKIM row: the SPF host");
  assertEquals(dmarcDomainOf([links]), null, "the tracking CNAME alone is not enough");
  assertEquals(dmarcDomainOf([]), null);
  assertEquals(dmarcDomainOf(null), null);
  assertEquals(dmarcDomainOf("resend._domainkey.acmesheds.test"), null);
  assertEquals(dmarcDomainOf([{ host: "resend._domainkey.bad host.test" }]), null, "not a hostname");
  assertEquals(dmarcDomainOf([{ host: "resend._domainkey.localhost" }]), null, "a single label is not a domain");
});

Deno.test("dmarcNamesFor: the domain, then each parent above the TLD, at most five", () => {
  assertEquals(dmarcNamesFor("acmesheds.test"), ["acmesheds.test"], "an apex asks once; _dmarc.<tld> is never asked");
  assertEquals(dmarcNamesFor("mail.acmesheds.test"), ["mail.acmesheds.test", "acmesheds.test"]);
  assertEquals(dmarcNamesFor("a.b.c.d.e.f.acmesheds.test").length, 5);
});

// ── The lookup ────────────────────────────────────────────────────────────────────────────

Deno.test("lookupExistingDmarc: none, one, split strings and two records, from a stubbed resolver", async () => {
  const n = "_dmarc.acmesheds.test";
  const cases: [unknown, unknown][] = [
    [NXDOMAIN(n), { present: false, policy: null, count: 0, host: n }],
    [NODATA(n), { present: false, policy: null, count: 0, host: n }],
    [answer(n, { type: TXT, data: quoted("v=spf1 -all") }), { present: false, policy: null, count: 0, host: n }],
    [answer(n, { type: TXT, data: quoted("v=DMARC1; p=quarantine; rua=mailto:dmarc@acmesheds.test") }), { present: true, policy: "quarantine", count: 1, host: n }],
    [answer(n, { type: TXT, data: quoted("v=DMARC1; p=", "reject; rua=mailto:dmarc@acmesheds.test") }), { present: true, policy: "reject", count: 1, host: n }],
    [answer(n, { type: TXT, data: quoted("v=DMARC1; rua=mailto:dmarc@acmesheds.test") }), { present: true, policy: null, count: 1, host: n }],
    [answer(n, { type: TXT, data: quoted("v=DMARC1; p=rejct") }), { present: true, policy: null, count: 1, host: n }],
    [answer(n, { type: TXT, data: quoted("v=DMARC1; p=none") }, { type: TXT, data: quoted("v=DMARC1; p=reject") }),
      { present: true, policy: null, count: 2, host: n }],
  ];
  for (const [doh, want] of cases) {
    const { impl } = dohStub({ [n]: doh });
    assertEquals(await lookupExistingDmarc("acmesheds.test", { fetchImpl: impl }), want, JSON.stringify(doh));
  }
});

Deno.test("lookupExistingDmarc: asks Cloudflare's JSON resolver for TXT at _dmarc.<domain>, with a timeout", async () => {
  const { impl, seen } = dohStub({ "_dmarc.acmesheds.test": NXDOMAIN("_dmarc.acmesheds.test") });
  await lookupExistingDmarc("AcmeSheds.test.", { fetchImpl: impl });
  assertEquals(seen.length, 1);
  assertEquals(seen[0].url.origin + seen[0].url.pathname, "https://cloudflare-dns.com/dns-query");
  assertEquals(seen[0].url.searchParams.get("name"), "_dmarc.acmesheds.test", "lower-cased, trailing dot dropped");
  assertEquals(seen[0].url.searchParams.get("type"), "TXT");
  assertEquals(new Headers(seen[0].init.headers).get("accept"), "application/dns-json");
  assert(seen[0].init.signal instanceof AbortSignal, "every request carries a timeout");
});

Deno.test("lookupExistingDmarc: any doubt is null, never \"none\" (the screen would then advise p=none)", async () => {
  const n = "_dmarc.acmesheds.test";
  const failures: [string, unknown][] = [
    ["HTTP 500", new Response("oops", { status: 500 })],
    ["HTTP 429", new Response("slow down", { status: 429 })],
    ["not JSON", new Response("<html>", { status: 200 })],
    ["SERVFAIL", { Status: 2, Question: [{ name: n, type: TXT }] }],
    ["REFUSED", { Status: 5 }],
    ["network", () => Promise.reject(new TypeError("error sending request"))],
  ];
  for (const [label, v] of failures) {
    const { impl } = dohStub({ [n]: v });
    assertEquals(await lookupExistingDmarc("acmesheds.test", { fetchImpl: impl }), null, label);
  }
  const thrower = (() => { throw new Error("synchronous throw"); }) as unknown as typeof fetch;
  assertEquals(await lookupExistingDmarc("acmesheds.test", { fetchImpl: thrower }), null, "a fetch that throws outright");
});

Deno.test("lookupExistingDmarc: a resolver that never answers is given up on at the timeout", async () => {
  const n = "_dmarc.acmesheds.test";
  const hang = (init: RequestInit) => new Promise<Response>((_res, rej) => {
    init.signal?.addEventListener("abort", () => rej(init.signal?.reason ?? new Error("aborted")));
  });
  const { impl } = dohStub({ [n]: hang });
  const t0 = Date.now();
  assertEquals(await lookupExistingDmarc("acmesheds.test", { fetchImpl: impl, timeoutMs: 40 }), null);
  assert(Date.now() - t0 < 2_000, "it did not wait for the resolver");
});

Deno.test("lookupExistingDmarc: a bad domain asks nothing", async () => {
  for (const d of ["", "localhost", "bad host.test", "-acme.test", "a".repeat(64) + ".test", "x".repeat(250) + ".test"]) {
    const { impl, seen } = dohStub({});
    assertEquals(await lookupExistingDmarc(d, { fetchImpl: impl }), null, d);
    assertEquals(seen.length, 0, d);
  }
});

Deno.test("lookupExistingDmarc: a sending subdomain is covered by its parent's record (sp=, else p=), closest first", async () => {
  const own = "_dmarc.mail.acmesheds.test", parent = "_dmarc.acmesheds.test";
  // The parent says p=none for itself and sp=reject for subdomains: the subdomain gets reject.
  {
    const { impl, seen } = dohStub({ [own]: NXDOMAIN(own), [parent]: answer(parent, { type: TXT, data: quoted("v=DMARC1; p=none; sp=reject") }) });
    assertEquals(await lookupExistingDmarc("mail.acmesheds.test", { fetchImpl: impl }), { present: true, policy: "reject", count: 1, host: parent });
    assertEquals(seen.map((s) => s.url.searchParams.get("name")).sort(), [parent, own].sort(), "both names asked");
  }
  {
    const { impl } = dohStub({ [own]: NODATA(own), [parent]: answer(parent, { type: TXT, data: quoted("v=DMARC1; p=quarantine") }) });
    assertEquals(await lookupExistingDmarc("mail.acmesheds.test", { fetchImpl: impl }), { present: true, policy: "quarantine", count: 1, host: parent },
      "no sp=: the parent's p=");
  }
  {
    const { impl } = dohStub({
      [own]: answer(own, { type: TXT, data: quoted("v=DMARC1; p=none") }),
      [parent]: answer(parent, { type: TXT, data: quoted("v=DMARC1; p=reject; sp=reject") }),
    });
    assertEquals(await lookupExistingDmarc("mail.acmesheds.test", { fetchImpl: impl }), { present: true, policy: "none", count: 1, host: own },
      "the subdomain's own record wins over its parent's");
  }
  {
    const { impl } = dohStub({ [own]: NXDOMAIN(own), [parent]: answer(parent, { type: TXT, data: quoted("v=DMARC1; p=reject; sp=bogus") }) });
    assertEquals((await lookupExistingDmarc("mail.acmesheds.test", { fetchImpl: impl }))?.policy, "reject", "an unreadable sp= falls back to p=");
  }
  {
    const { impl } = dohStub({ [own]: answer(own, { type: TXT, data: quoted("v=DMARC1; p=none") }), [parent]: new Response("down", { status: 503 }) });
    assertEquals((await lookupExistingDmarc("mail.acmesheds.test", { fetchImpl: impl }))?.host, own, "a parent's failure does not matter once the closer name answered");
  }
  {
    const { impl } = dohStub({ [own]: NXDOMAIN(own), [parent]: NXDOMAIN(parent) });
    assertEquals(await lookupExistingDmarc("mail.acmesheds.test", { fetchImpl: impl }), { present: false, policy: null, count: 0, host: own },
      "none anywhere: \"none\" is about the sending domain itself");
  }
  {
    const { impl } = dohStub({ [own]: new Response("down", { status: 503 }), [parent]: answer(parent, { type: TXT, data: quoted("v=DMARC1; p=reject") }) });
    assertEquals(await lookupExistingDmarc("mail.acmesheds.test", { fetchImpl: impl }), null,
      "the subdomain's own lookup failed: its own record may be the one that applies, so unknown");
  }
  {
    const { impl } = dohStub({ [own]: NXDOMAIN(own), [parent]: new Response("down", { status: 503 }) });
    assertEquals(await lookupExistingDmarc("mail.acmesheds.test", { fetchImpl: impl }), null,
      "nothing on the subdomain and the parent unknown: unknown, not \"none\"");
  }
});

Deno.test("lookupExistingDmarc: every name is asked at once, not one after another", async () => {
  let inFlight = 0, most = 0;
  const slow = (body: unknown) => () => {
    inFlight++;
    most = Math.max(most, inFlight);
    return new Promise<Response>((res) => setTimeout(() => { inFlight--; res(new Response(JSON.stringify(body))); }, 15));
  };
  const own = "_dmarc.mail.acmesheds.test", parent = "_dmarc.acmesheds.test";
  const { impl } = dohStub({ [own]: slow(NXDOMAIN(own)), [parent]: slow(NXDOMAIN(parent)) });
  await lookupExistingDmarc("mail.acmesheds.test", { fetchImpl: impl });
  assertEquals(most, 2);
});
