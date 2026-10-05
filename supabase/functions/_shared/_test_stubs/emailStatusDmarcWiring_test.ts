// Settings → Email Settings asks public DNS whether the sending domain already has a DMARC record
// before it advises one (2026-10-05), driven through the SHIPPED portal-settings email_status.
//
// The screen's advisory row says "publish v=DMARC1; p=none at _dmarc.<domain>". Where a record
// already exists, following it adds a second one (receivers then ignore both) or replaces the
// builder's own policy with none. email_status now carries existingDmarc, and this file pins:
//
//   1. the name asked is _dmarc.<the domain in the DKIM host Resend returned>, NOT our stored
//      string: a row stored as www.<domain> (the 2026-08-26 split brain) still asks the apex;
//   2. the answer reaches the screen as { present, policy, count, host }: none, one, two;
//   3. a failed lookup is existingDmarc null and the rest of the screen's answer is unchanged:
//      a DNS outage never costs the builder their Email Settings;
//   4. a tenant with no records yet (not connected) asks DNS nothing;
//   5. the lookup is started before the recent-sends read, so it costs no extra round trip;
//   6. the screen builds its advisory row only from a "none" about that same name, and the
//      webmaster email from the same rows (read from the shipped JSX), and the compiled portal
//      carries the change.
//
// HOW. paperworkDefaultWiring_test's idiom: Deno.serve is stubbed while index.ts is imported, so a
// request runs through withErrorLog and every step as it does live; supabase-js is the import map's
// stub with stubDb routing every table into the fake below, and fetch answers the resolver locally.
// No --allow-net is granted, so nothing leaves the box. The DoH parse itself is pinned in
// _shared/dmarcLookup.test.ts.
//
// Tenants and domains are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";

async function captureHandler(rel: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  try {
    await import(new URL(rel, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${rel} did not hand Deno.serve a handler`);
  return handler;
}
const SETTINGS_HANDLER = await captureHandler("../../portal-settings/index.ts");

const T = "acme-sheds";
const PROJECT = "https://stub.supabase.co";
const ENV: Record<string, string> = {
  SUPABASE_URL: PROJECT,
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

const DKIM = { type: "TXT", host: "resend._domainkey.acmesheds.test", value: "p=MIGfMA0GCSqGSIb3DQEB", verified: false };
const SPF_MX = { type: "MX", host: "send.acmesheds.test", value: "feedback-smtp.example.test", verified: false, priority: 10 };
const SPF_TXT = { type: "TXT", host: "send.acmesheds.test", value: "v=spf1 include:example.test ~all", verified: false };
/** Connected and waiting on DNS. Stored as www.<domain>: the shape Resend silently normalised. */
const PENDING = {
  client_id: T, email_provider: "ghl", email_domain: "www.acmesheds.test", email_from_local: "info", email_from_name: "Acme Sheds",
  email_domain_status: "pending", email_dns_records: [DKIM, SPF_MX, SPF_TXT], email_verified_at: null, email_last_error: null,
  email_template_copy: null, inbound_domain: null, inbound_status: "off", inbound_dns_records: null, inbound_verified_at: null, inbound_last_error: null,
};
const NOT_CONNECTED = { ...PENDING, email_domain: null, email_domain_status: "not_configured", email_dns_records: null };

type Trace = { events: string[]; asked: string[] };

function chain(row: Record<string, unknown> | null, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(row, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    const has = (op: string) => ops.some((o) => o[0] === op);
    const answer = () => {
      if (table === "client_users") return { data: [{ client_id: T, role: "owner", title: null, access: null, user_id: "u1", prefs: null }], error: null };
      if (table === "client_settings") return { data: row, error: null };
      if (table === "email_sends") {
        trace.events.push("sends-read");
        return { data: [{ id: "s1", kind: "test", to_email: "someone@example.test", status: "sent", error: null, bounce_reason: null, created_at: "2026-10-05T12:00:00Z", opened_at: null, complained_at: null }], error: null };
      }
      return { data: has("maybeSingle") || has("single") ? null : [], error: null };
    };
    return Promise.resolve().then(answer).then(ok, bad);
  };
  return q;
}

/** The resolver: `by` maps a _dmarc name to a DoH JSON answer, or to "fail" (a network error). */
async function emailStatus(row: Record<string, unknown> | null, by: Record<string, unknown>) {
  const trace: Trace = { events: [], asked: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(row, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "cloudflare-dns.com") return Promise.reject(new Error(`unexpected fetch: ${url.href}`));
    const name = url.searchParams.get("name") ?? "";
    trace.events.push("doh");
    trace.asked.push(name);
    const v = by[name];
    if (v === "fail" || v === undefined) return Promise.reject(new TypeError("error sending request"));
    return Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/dns-json" } }));
  }) as typeof fetch;
  try {
    const res = await SETTINGS_HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action: "email_status" }),
    }));
    return { status: res.status, body: await res.json(), trace };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const NAME = "_dmarc.acmesheds.test";
const txt = (...records: string[]) => ({ Status: 0, Answer: records.map((r) => ({ name: NAME, type: 16, TTL: 300, data: `"${r}"` })) });

Deno.test("email_status asks DNS about the domain Resend registered (the DKIM host), not the stored www. string", async () => {
  const { status, body, trace } = await emailStatus(PENDING, { [NAME]: { Status: 3 } });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(trace.asked, [NAME], "one question, at the apex from resend._domainkey.<domain>");
  assert(!trace.asked.some((n) => n.includes("www.")), "never _dmarc.www.<domain>");
  assertEquals(body.existingDmarc, { present: false, policy: null, count: 0, host: NAME });
});

Deno.test("email_status hands the screen none, one and two records as existingDmarc", async () => {
  const cases: [unknown, unknown][] = [
    [{ Status: 3 }, { present: false, policy: null, count: 0, host: NAME }],
    [txt("v=DMARC1; p=reject; rua=mailto:dmarc@acmesheds.test"), { present: true, policy: "reject", count: 1, host: NAME }],
    [{ Status: 0, Answer: [{ name: NAME, type: 16, TTL: 300, data: `"v=DMARC1; p=" "quarantine"` }] }, { present: true, policy: "quarantine", count: 1, host: NAME }],
    [txt("v=DMARC1; p=none", "v=DMARC1; p=reject"), { present: true, policy: null, count: 2, host: NAME }],
  ];
  for (const [doh, want] of cases) {
    const { status, body } = await emailStatus(PENDING, { [NAME]: doh });
    assertEquals(status, 200);
    assertEquals(body.existingDmarc, want, JSON.stringify(doh));
  }
});

Deno.test("a failed lookup is existingDmarc null, and the rest of Email Settings' answer is unchanged", async () => {
  const ok = await emailStatus(PENDING, { [NAME]: { Status: 3 } });
  for (const doh of ["fail", { Status: 2 }]) {
    const { status, body } = await emailStatus(PENDING, { [NAME]: doh });
    assertEquals(status, 200, `${JSON.stringify(doh)}: ${JSON.stringify(body)}`);
    assertEquals(body.existingDmarc, null, JSON.stringify(doh));
    const { existingDmarc: _a, ...rest } = body;
    const { existingDmarc: _b, ...restOk } = ok.body;
    assertEquals(rest, restOk, "everything else is the same answer");
    assertEquals(rest.dnsRecords.length, 3);
    assertEquals(rest.recentSends.length, 1);
  }
});

Deno.test("a tenant with no records yet asks DNS nothing", async () => {
  for (const row of [NOT_CONNECTED, null, { ...PENDING, email_dns_records: [] }, { ...PENDING, email_dns_records: [{ type: "CNAME", host: "links.acmesheds.test", value: "x", verified: false, tracking: true }] }]) {
    const { status, body, trace } = await emailStatus(row, {});
    assertEquals(status, 200, JSON.stringify(body));
    assertEquals(trace.asked, [], JSON.stringify(row?.email_dns_records ?? null));
    assertEquals(body.existingDmarc, null);
  }
});

Deno.test("the DNS question is asked before the recent-sends read, not after it", async () => {
  const { trace } = await emailStatus(PENDING, { [NAME]: { Status: 3 } });
  assertEquals(trace.events, ["doh", "sends-read"]);
});

// ── The screen's half, read from the SHIPPED source (tests/harness/dmarcAdvisory.mjs drives it) ──
const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const INTEG = await read("../../../../portal/08-integrations.jsx");
const COMPILED = await read("../../../../portal.app.compiled.js");

Deno.test("Email Settings builds the advisory row only from DNS's \"none\" about this domain, and the email from the same rows", () => {
  assert(INTEG.includes(`const dmarcNone = !!dmarc && dmarc.present === false && !!dnsApex && dmarcHost === "_dmarc." + dnsApex;`),
    "\"none\" counts only when it is about _dmarc.<the DKIM host's domain>");
  assert(INTEG.includes("const dnsAdvisory = dns.length > 0 && dnsApex && dmarcNone\n"), "no \"none\", no row: unknown shows nothing");
  assert(INTEG.includes("const dnsRows = dns.concat(inboundRows, dnsAdvisory);"), "the table and the webmaster email share the rows");
  assert(INTEG.includes("const lines = listOf(dnsRows);"), "the email lists exactly those rows");
  assert(/dnsAdvisory\.length > 0\s*\? `Note on the DMARC record/.test(INTEG), "and its DMARC note goes with the row");
});

Deno.test("the compiled portal carries the DMARC check (npm run compile was run)", () => {
  for (const s of ["existingDmarc", "You already have a DMARC record", "Leave it as it is", "Two records cancel each other out", "keep one and delete the rest"]) {
    assert(COMPILED.includes(s), `portal.app.compiled.js is stale (no "${s}"): run npm run compile`);
  }
});
