// AUTOMATIONS STOP SENDING WHEN THE AUTOMATIONS TAB IS TAKEN AWAY (plans as data, stage D), driven
// through the SHIPPED crm-rules-tick handler against a fake database and a fake Resend.
//
// WHY THIS EXISTS. A company on the tab map without the Automations tab cannot open the page or
// call its actions, but its rules kept firing, and this tick kept sending the messages they queued:
// texts and emails to customers from a page the builder can no longer reach to switch them off.
// The outbox loop now asks _shared/accessCheck.ts beside its paused-rule check. A mistake here is
// either every automation of every builder silently stopped, or the hole left open, so this pins:
//
//   1. not named, a failed read, a malformed answer: the message goes out exactly as before;
//   2. block without the tab ("hidden", "locked", "off"): nothing goes out, and the row is settled
//      the way a paused rule's row is: skipped, lease cleared, never retried, a reason that says
//      the tab is not part of the account;
//   3. block WITH the tab: it goes out;
//   4. report: it goes out, and one info row says it would have been stopped;
//   5. every kind of rule action is stopped, not only email;
//   6. a paused rule keeps its own reason, and the map is asked once per company per run.
//
// HOW. The emailRetryWiring_test idiom: Deno.serve is stubbed while the function is imported, the
// import map swaps supabase-js for supabase_stub.ts, and fetch is a fake Resend. No --allow-net.
// Tenants, people and ids are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubDb, stubPlanRead, stubRpc } from "./supabase_stub.ts";

const SERVICE = "stub-service-key";
Deno.env.set("SUPABASE_URL", "https://stub.supabase.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
Deno.env.set("RESEND_API_KEY", "re_stub");

async function load(rel: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  await import(new URL(rel, import.meta.url).href);
  (Deno as any).serve = realServe;
  if (!handler) throw new Error(`${rel} did not hand Deno.serve a handler`);
  return handler;
}
const TICK = await load("../../crm-rules-tick/index.ts");

type Q = { table: string; op: "select" | "update" | "insert"; cols: string; payload: any; calls: [string, unknown[]][] };
function fakeDb(answer: (q: Q) => { data: any; error: any }) {
  const log: Q[] = [];
  const from = (table: string) => {
    const q: Q = { table, op: "select", cols: "", payload: null, calls: [] };
    log.push(q);
    const b: any = {};
    for (const m of ["eq", "neq", "lt", "lte", "gt", "gte", "in", "is", "not", "or", "order", "limit", "contains", "range"]) {
      b[m] = (...a: unknown[]) => { q.calls.push([m, a]); return b; };
    }
    b.select = (cols: string) => { if (q.op === "select") q.cols = cols; return b; };
    b.update = (p: any) => { q.op = "update"; q.payload = p; return b; };
    b.insert = (p: any) => { q.op = "insert"; q.payload = p; return b; };
    b.maybeSingle = () => Promise.resolve(answer(q));
    b.single = () => Promise.resolve(answer(q));
    b.then = (res: any, rej: any) => Promise.resolve(answer(q)).then(res, rej);
    return b;
  };
  return { from, log };
}
const eqArg = (q: Q, col: string) => q.calls.find(([n, a]) => n === "eq" && a[0] === col)?.[1][1];

/** Everything the tick sends anywhere: Resend emails and anything else it fetches (a webhook). */
function fakeNet() {
  const emails: any[] = [];
  const other: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.resend.com/emails")) {
      emails.push(JSON.parse(String(init?.body ?? "{}")));
      return Promise.resolve(new Response(JSON.stringify({ id: `em_${emails.length}` }), { status: 200 }));
    }
    other.push(url);
    return Promise.resolve(new Response("[]", { status: 201 }));
  }) as typeof fetch;
  return { emails, other };
}
const realFetch = globalThis.fetch;
const reset = () => { globalThis.fetch = realFetch; stubDb.from = null; stubRpc.rpc = null; stubPlanRead.on = false; };

const CONTACT = "33333333-3333-4333-8333-333333333333";
const RULE = "55555555-5555-4555-8555-555555555555";
const SETTINGS = {
  email_provider: "resend", email_domain_status: "verified", email_domain: "mail.acme-sheds.test",
  email_from_local: "info", email_from_name: "Acme Sheds", business_name: "Acme Sheds",
  beta_mode: false, beta_email: null, invoice_in_ghl: true,
};

type Row = { id: number; client: string; kind?: string; params?: Record<string, unknown>; contact?: string | null };
type World = {
  rows: Row[];
  /** access_for_server's answer per company. A company not listed is not named (null). */
  plans?: Record<string, unknown>;
  /** Make the map read fail for everyone. */
  planReadFails?: boolean;
  rule?: Record<string, unknown> | null;
};

async function tick(w: World) {
  const net = fakeNet();
  const planReads: string[] = [];
  const db = fakeDb((q) => {
    if (q.table === "crm_rule_outbox" && q.op === "select" && q.cols.startsWith("id, rule_id")) {
      return { data: w.rows.map((r) => ({
        id: r.id, rule_id: RULE, client_id: r.client, deal_id: null, contact_id: r.contact === undefined ? CONTACT : r.contact,
        kind: r.kind ?? "send_email", params: r.params ?? { subject: "An update from {{business}}", body: "Hi {{first_name}}" },
        attempts: 0, queued_at: "2026-11-13T10:00:00Z", hold_until: null,
      })), error: null };
    }
    if (q.table === "crm_rule_outbox" && q.op === "update" && "attempts" in (q.payload ?? {})) return { data: [{ id: eqArg(q, "id") }], error: null };
    if (q.table === "crm_rules") return { data: "rule" in w ? w.rule : { id: RULE, name: "Follow up", enabled: true, archived_at: null }, error: null };
    if (q.table === "crm_contacts") return { data: { id: CONTACT, name: "Sam Lee", company: "", phone: "", email: "sam@example.test", labels: [], dnd_all_at: null, dnd_email_at: null }, error: null };
    if (q.table === "client_settings") return { data: SETTINGS, error: null };
    if (q.table === "email_sends" && q.op === "insert") return { data: { id: "es-1" }, error: null };
    return { data: [], error: null };
  });
  stubDb.from = db.from;
  stubPlanRead.on = true;
  stubRpc.rpc = (name: string, args?: any) => {
    if (name === "access_for_server") {
      planReads.push(String(args?.p_client_id));
      if (w.planReadFails) return Promise.resolve({ data: null, error: { code: "57014", message: "statement timeout" } });
      return Promise.resolve({ data: w.plans?.[String(args?.p_client_id)] ?? null, error: null });
    }
    return Promise.resolve({ data: 0, error: null });
  };
  const quiet = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    const res = await TICK(new Request("https://stub.supabase.test/functions/v1/crm-rules-tick", { method: "POST", headers: { authorization: `Bearer ${SERVICE}` }, body: "{}" }));
    const body = await res.json();
    /** How each outbox row ended: the last write to it that says so. */
    const outcome = (id: number) => db.log.filter((q) => q.table === "crm_rule_outbox" && q.op === "update" && eqArg(q, "id") === id && ("state" in (q.payload ?? {}) || "last_error" in (q.payload ?? {}))).pop()?.payload;
    return {
      status: res.status, body, outcome, planReads, emails: net.emails, fetched: net.other,
      ruleReads: db.log.filter((q) => q.table === "crm_rules").length,
      reports: db.log.filter((q) => q.table === "app_errors" && q.op === "insert" && q.payload?.code === "module_would_refuse").map((q) => q.payload),
    };
  } finally {
    [console.error, console.warn] = quiet;
    reset();
  }
}

const block = (modules: Record<string, string>) => ({ mode: "block", modules });
const report = (modules: Record<string, string>) => ({ mode: "report", modules });
const HUB_NO_RULES = { contacts: "on", conversations: "on", email: "on", automations: "hidden" };

// ── 1 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("a company that is not named sends exactly as before", async () => {
  const r = await tick({ rows: [{ id: 41, client: "acme-sheds" }] });
  assertEquals([r.status, r.emails.length, r.body.sent, r.body.skipped], [200, 1, 1, 0], JSON.stringify(r.body));
  assertEquals(r.outcome(41)?.state, "sent");
  assertEquals(r.reports.length, 0);
});

Deno.test("a map that cannot be read, or comes back malformed, stops nothing", async () => {
  const failed = await tick({ rows: [{ id: 41, client: "acme-sheds" }], planReadFails: true });
  assertEquals([failed.emails.length, failed.outcome(41)?.state], [1, "sent"]);
  for (const bad of [{ mode: "block", modules: {} }, { mode: "blok", modules: HUB_NO_RULES }, { modules: HUB_NO_RULES }, { mode: "block", modules: { automations: "nope" } }]) {
    const r = await tick({ rows: [{ id: 41, client: "acme-sheds" }], plans: { "acme-sheds": bad } });
    assertEquals([r.emails.length, r.outcome(41)?.state, r.reports.length], [1, "sent", 0], JSON.stringify(bad));
  }
});

// ── 2 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("block without the Automations tab: nothing goes out, and the row ends exactly as a paused rule's does", async () => {
  // What a paused rule's row looks like when it is settled, from the same handler.
  const paused = await tick({ rows: [{ id: 41, client: "acme-sheds" }], rule: { enabled: false, archived_at: null } });
  const pausedEnd = paused.outcome(41);
  assertEquals(pausedEnd?.state, "skipped");

  for (const state of ["hidden", "locked", "off"]) {
    const r = await tick({ rows: [{ id: 41, client: "acme-sheds" }], plans: { "acme-sheds": block({ ...HUB_NO_RULES, automations: state }) } });
    assertEquals([r.emails.length, r.fetched.length], [0, 0], `nothing leaves for a company whose Automations tab is ${state}`);
    const end = r.outcome(41);
    assertEquals(end?.state, "skipped", `ended, not failed and not retried (${state})`);
    assert(String(end?.last_error).includes("isn't part of this account's plan"), end?.last_error);
    // The same bookkeeping as the paused rule: the same columns written, the lease cleared.
    assertEquals(Object.keys(end).sort(), Object.keys(pausedEnd).sort());
    assertEquals(end.leased_until, null);
    assertEquals([r.body.skipped, r.body.sent, r.body.failed], [1, 0, 0], JSON.stringify(r.body));
    assertEquals(r.reports.length, 0, "block refuses; it does not also file a report row");
  }
  // A map that does not mention the tab at all: not had.
  const missing = await tick({ rows: [{ id: 41, client: "acme-sheds" }], plans: { "acme-sheds": block({ contacts: "on" }) } });
  assertEquals([missing.emails.length, missing.outcome(41)?.state], [0, "skipped"]);
});

// ── 3 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("block with the Automations tab on: the message goes out", async () => {
  const r = await tick({ rows: [{ id: 41, client: "acme-sheds" }], plans: { "acme-sheds": block({ ...HUB_NO_RULES, automations: "on" }) } });
  assertEquals([r.emails.length, r.outcome(41)?.state, r.body.sent], [1, "sent", 1]);
});

// ── 4 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("report: the message goes out, and one info row says it would have been stopped", async () => {
  const r = await tick({ rows: [{ id: 41, client: "report-barns" }, { id: 42, client: "report-barns" }], plans: { "report-barns": report(HUB_NO_RULES) } });
  assertEquals([r.emails.length, r.outcome(41)?.state, r.outcome(42)?.state], [2, "sent", "sent"]);
  assertEquals(r.reports.length, 1, JSON.stringify(r.reports));
  const row = r.reports[0];
  assertEquals([row.source, row.severity, row.client_id], ["edge:crm-rules-tick", "info", "report-barns"]);
  assertEquals(row.message, "Report only: send would be refused (needs automations).");
  assertEquals(row.context, { action: "send", tabs: ["automations"], states: { automations: "hidden" } });
  // The next tick of the same isolate sends again and files nothing more.
  const again = await tick({ rows: [{ id: 43, client: "report-barns" }], plans: { "report-barns": report(HUB_NO_RULES) } });
  assertEquals([again.emails.length, again.reports.length], [1, 0]);
});

// ── 5 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("every kind of rule action is stopped, not only an email to the customer", async () => {
  const rows: Row[] = [
    { id: 51, client: "acme-sheds", kind: "send_sms", params: { body: "Hi {{first_name}}" } },
    { id: 52, client: "acme-sheds", kind: "notify_team", params: { subject: "A lead", body: "Call them" }, contact: null },
    { id: 53, client: "acme-sheds", kind: "webhook", params: { url: "https://hooks.example.test/in" }, contact: null },
    { id: 54, client: "acme-sheds", kind: "ghl_push", params: { tags: ["hot"] } },
  ];
  const r = await tick({ rows, plans: { "acme-sheds": block(HUB_NO_RULES) } });
  assertEquals([r.emails.length, r.fetched.length], [0, 0], `something left the building: ${r.fetched.join(", ")}`);
  for (const row of rows) assertEquals(r.outcome(row.id)?.state, "skipped", row.kind);
  assertEquals(r.body.skipped, 4);
});

// ── 6 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("a paused rule keeps its own reason, and its rule is still read only once", async () => {
  const r = await tick({ rows: [{ id: 41, client: "acme-sheds" }], rule: { enabled: false, archived_at: null }, plans: { "acme-sheds": block(HUB_NO_RULES) } });
  assert(String(r.outcome(41)?.last_error).includes("paused or removed"), r.outcome(41)?.last_error);
  assertEquals([r.ruleReads, r.planReads.length], [1, 0], "a row its paused rule already stopped never asks the map");
});

Deno.test("the map is asked once per company per run, and each company gets its own answer", async () => {
  const rows: Row[] = [
    { id: 61, client: "acme-sheds" }, { id: 62, client: "bolt-barns" }, { id: 63, client: "acme-sheds" },
    { id: 64, client: "bolt-barns" }, { id: 65, client: "cedar-cabins" },
  ];
  const r = await tick({ rows, plans: { "acme-sheds": block(HUB_NO_RULES), "bolt-barns": block({ ...HUB_NO_RULES, automations: "on" }) } });
  assertEquals(r.planReads, ["acme-sheds", "bolt-barns", "cedar-cabins"]);
  assertEquals(rows.map((x) => r.outcome(x.id)?.state), ["skipped", "sent", "skipped", "sent", "sent"]);
  assertEquals([r.emails.length, r.body.sent, r.body.skipped], [3, 3, 2]);
  assertEquals(r.ruleReads, rows.length, "one rule read per row, as before");
});
