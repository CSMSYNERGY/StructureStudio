// QuickBooks reconnect and company switch (migration 265), driven through the SHIPPED code: the
// invoice push, the OAuth callback and portal-settings' QuickBooks actions.
//
// WHY THIS EXISTS. The Bugs board card "QuickBooks disconnect/reconnect never tested" (Carolyn,
// 2026-09-08: "this one should be fixed, you know, by this week"). A live different-company test
// needs a second production QuickBooks company, and none is on file, so these cases carry that
// path until one exists. What each one pins:
//
//   1. THE PUSH bills only from the connected company's mappings. A row stamped with another
//      company, or with none, is NOT MAPPED: the push stops with "unmapped … then Retry" before a
//      single request reaches QuickBooks. A row for the connected company still bills, and the
//      invoice row records which company it went into (create and adopt alike). Only an invoice
//      under the same number AND for the same customer is adopted (283): another customer's is
//      refused as `rejected:` and listed for Retry. A layout item
//      with no row of its own goes to the fallback (the dead `layout_item||` step is gone). A
//      mapping read that fails says so, rather than reading as every line unmapped.
//   2. THE CALLBACK clears, after the connection saves, every row not stamped with the company
//      just connected. That includes the case the old "did the realm change?" compare could not
//      see: a tenant with NO realm on file (taken over, or cleared by hand) whose map survived,
//      now connecting a different company. A same-company reconnect keeps every row, and stamps
//      an unstamped one rather than dropping it. A failed tidy-up lands on item_map_stale and
//      still audits the connect; a failed save touches nothing. Another tenant's rows are never
//      touched, including on a takeover, and a takeover that also cleared the taker's rows says
//      both.
//   3. PORTAL-SETTINGS: qbo_status counts, and list_item_map shows, only the company's rows (and
//      never hands the browser the realm id); save_item_map stamps the company, re-stamps a slot
//      left by another company instead of tripping the unique index, refuses a mapping when no
//      company is on file, and refuses a save from a page loaded before a company switch (the
//      companyTag list_item_map hands out); retry_qbo_push says otherCompany for an invoice that
//      went to the company before a switch, and pushes nothing; qbo_status counts those invoices.
//   4. THE NEWER LINE KINDS (the mapping chore that answers "not going into QuickBooks", Carolyn
//      2026-09-10), on a tenant shaped like the live one: before the chore those lines bill as the
//      Fallback; save_item_map takes the grid's eleven rows, stamped; after it each line bills from
//      its own row while Delivery keeps the Fallback and its non-taxable code; a row saved with no
//      company falls to the stamped Fallback instead of aborting the push.
//
// HOW. The idioms of foundingAnnualOnly_test and aiDraftStreamWiring_test: Deno.serve is stubbed
// while each handler is imported, the import map swaps supabase-js for supabase_stub.ts, and its
// stubDb/stubRpc hooks route every read and write into ONE in-memory database below. That fake
// applies the filters the code really put on each query, with SQL's NULL rules (PostgREST's `neq`
// never matches a NULL, which is why the callback's wipe is two deletes), refuses a column the
// table does not have (PostgREST's 400) and enforces the unique indexes that matter here.
// fetch is "Intuit" and nothing else, on made-up hosts, and no --allow-net is granted.
//
// Tenants, realm ids and item ids are made up. The repo is public: no real client id belongs in
// a fixture.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";
import { pushQboInvoice } from "../qboInvoice.ts";

// ─── The real handlers ─────────────────────────────────────────────────────────────────────────
// ⚠️ Computed specifiers, as in aiDraftStreamWiring_test: a literal one would type-check these
// entrypoints against the stub's partial client. preflight's `deno check` types them for real.
async function importHandler(fn: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: any) => { handler = h; return { finished: Promise.resolve() }; };
  try {
    await import(new URL(`../../${fn}/index.ts`, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${fn} did not hand Deno.serve a handler`);
  return handler;
}
const CALLBACK = await importHandler("qbo-oauth-callback");
const SETTINGS = await importHandler("portal-settings");

// ─── Made-up identities ────────────────────────────────────────────────────────────────────────
const TENANT = "acme-sheds";
const BYSTANDER = "bystander-barns";
const BOOKS_A = "4620000000000000001";   // the company the tenant mapped first
const BOOKS_B = "4620000000000000002";   // the company it switches to
const BOOKS_C = "4620000000000000003";   // the bystander's company
const USER_ID = "00000000-0000-4000-8000-00000000a001";
const STYLE_BARN = "00000000-0000-4000-8000-0000000000b1";
const API = "https://qbo-api.example.test";

// ─── One in-memory database ────────────────────────────────────────────────────────────────────
type Row = Record<string, any>;
type Fail = { table: string; verb: string; error: { message: string; code?: string } };

// The columns PostgREST knows for the tables these paths name (after 265). A read or write naming
// any other column answers like PostgREST: an error, no data.
const COLUMNS: Record<string, string[]> = {
  qbo_item_map: ["id", "client_id", "line_kind", "item_key", "style_id", "qbo_item_id", "qbo_item_name", "realm_id", "created_at", "updated_at"],
  invoice_sends: ["client_id", "short_code", "invoice_number", "status", "qbo_invoice_id", "qbo_doc_number", "qbo_pushed_at",
    "qbo_error", "qbo_attempts", "qbo_tid", "qbo_realm_id", "updated_at", "issued_by"],
  client_settings: ["client_id", "qbo_realm_id", "qbo_company_name", "qbo_connected_at", "qbo_refresh_error",
    "qbo_refresh_token_expires_at", "qbo_disconnect_reason", "qbo_oauth_state", "qbo_oauth_state_expires_at",
    "qbo_access_token", "qbo_access_token_expires_at", "qbo_refresh_token", "qbo_token_refreshed_at", "qbo_refreshing_at",
    "internal_account", "billing_exempt"],
};

const UNIQUE: Record<string, { name: string; key: (r: Row) => string | null }> = {
  qbo_item_map: {
    name: "qbo_item_map_default_uniq",
    key: (r) => `${r.client_id}|${r.line_kind}|${r.item_key}|${r.style_id ?? ""}`,
  },
  client_settings: { name: "client_settings_qbo_realm_uniq", key: (r) => (r.qbo_realm_id ? String(r.qbo_realm_id) : null) },
};

class FakeDb {
  tables: Record<string, Row[]>;
  log: any[][] = [];
  fails: Fail[] = [];
  seq = 0;
  constructor(seed: Record<string, Row[]>) {
    this.tables = structuredClone(seed);
    // A seed the real indexes would refuse describes a database that cannot exist.
    for (const t of Object.keys(UNIQUE)) {
      const dup = uniqueViolation(this, t);
      if (dup) throw new Error(`the seed breaks ${t}'s unique index: ${dup.message}`);
    }
  }
  rows(t: string): Row[] {
    return (this.tables[t] ??= []);
  }
  from(table: string): any {
    return chain(this, table, []);
  }
  rpc(fn: string, args?: any): any {
    return chain(this, `rpc:${fn}`, [["args", args]]);
  }
}

const VERBS = new Set(["select", "insert", "update", "delete", "upsert"]);

function matches(r: Row, ops: any[][]): boolean {
  for (const o of ops) {
    const [op, c, v, w] = o;
    if (op === "eq" && !(r[c] != null && r[c] === v)) return false;
    if (op === "neq" && !(r[c] != null && r[c] !== v)) return false;     // SQL `<>`: NULL never matches
    if (op === "is" && v === null && r[c] != null) return false;
    if (op === "not" && v === "is" && w === null && r[c] == null) return false;
    if (op === "in" && !(v as unknown[]).includes(r[c])) return false;
  }
  return true;
}

function unknownColumns(table: string, names: string[]): string[] {
  const cols = COLUMNS[table];
  return cols ? names.filter((n) => !cols.includes(n)) : [];
}

function uniqueViolation(db: FakeDb, table: string): { message: string; code: string } | null {
  const u = UNIQUE[table];
  if (!u) return null;
  const seen = new Set<string>();
  for (const r of db.rows(table)) {
    const k = u.key(r);
    if (k === null) continue;
    if (seen.has(k)) return { code: "23505", message: `duplicate key value violates unique constraint "${u.name}"` };
    seen.add(k);
  }
  return null;
}

function run(db: FakeDb, table: string, ops: any[][]): any {
  if (table.startsWith("rpc:")) return runRpc(db, table.slice(4), ops[0][1]);
  const verbOp = ops.find((o) => VERBS.has(o[0])) ?? ["select", "*"];
  const verb = verbOp[0];
  const fail = db.fails.find((f) => f.table === table && f.verb === verb);
  if (fail) return { data: null, error: fail.error, count: null };
  const filters = ops.filter((o) => !VERBS.has(o[0]));

  if (verb === "insert") {
    const add = (Array.isArray(verbOp[1]) ? verbOp[1] : [verbOp[1]]).map((r: Row) => ({ ...r }));
    const bad = unknownColumns(table, add.flatMap((r: Row) => Object.keys(r)));
    if (bad.length) return { data: null, error: { code: "PGRST204", message: `Could not find the '${bad[0]}' column of '${table}' in the schema cache` } };
    const before = [...db.rows(table)];
    for (const r of add) {
      if (table === "qbo_item_map") {
        r.id ??= `map-${++db.seq}`;
        r.item_key ??= "";
        r.style_id ??= null;
        r.realm_id ??= null;
      }
      db.rows(table).push(r);
    }
    const dup = uniqueViolation(db, table);
    if (dup) { db.tables[table] = before; return { data: null, error: dup }; }
    return { data: null, error: null };
  }

  if (verb === "update") {
    const patch = verbOp[1] as Row;
    const bad = unknownColumns(table, Object.keys(patch));
    if (bad.length) return { data: null, error: { code: "PGRST204", message: `Could not find the '${bad[0]}' column of '${table}' in the schema cache` } };
    const before = db.rows(table).map((r) => ({ ...r }));
    let n = 0;
    for (const r of db.rows(table)) if (matches(r, filters)) { Object.assign(r, patch); n++; }
    const dup = uniqueViolation(db, table);
    if (dup) { db.tables[table] = before; return { data: null, error: dup }; }
    return { data: null, error: null, count: n };
  }

  if (verb === "delete") {
    const keep: Row[] = [];
    let n = 0;
    for (const r of db.rows(table)) { if (matches(r, filters)) n++; else keep.push(r); }
    db.tables[table] = keep;
    const counted = verbOp[1] && verbOp[1].count === "exact";
    return { data: null, error: null, count: counted ? n : null };
  }

  // select
  const colsArg = String(verbOp[1] ?? "*");
  const opts = verbOp[2] ?? {};
  const cols = colsArg === "*" ? null : colsArg.split(",").map((c) => c.trim()).filter(Boolean);
  const named = [...(cols ?? []), ...filters.filter((o) => ["eq", "neq", "is", "not", "in"].includes(o[0])).map((o) => o[1])];
  const bad = unknownColumns(table, named);
  if (bad.length) return { data: null, error: { code: "42703", message: `column ${table}.${bad[0]} does not exist` }, count: null };
  let out = db.rows(table).filter((r) => matches(r, filters));
  for (const o of filters) {
    if (o[0] === "order") {
      const asc = !(o[2] && o[2].ascending === false);
      out = [...out].sort((a, b) => (a[o[1]] < b[o[1]] ? -1 : a[o[1]] > b[o[1]] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (o[0] === "limit") out = out.slice(0, o[1]);
  }
  const count = opts.count === "exact" ? out.length : null;
  if (opts.head) return { data: null, error: null, count };
  const projected = out.map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c] ?? null])) : { ...r }));
  if (filters.some((o) => o[0] === "maybeSingle")) {
    if (projected.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
    return { data: projected[0] ?? null, error: null };
  }
  if (filters.some((o) => o[0] === "single")) {
    if (projected.length !== 1) return { data: null, error: { code: "PGRST116", message: "not exactly one row" } };
    return { data: projected[0], error: null };
  }
  return { data: projected, error: null, count };
}

function runRpc(db: FakeDb, fn: string, args: any): any {
  if (fn === "qbo_claim_token_refresh") return { data: { outcome: "fresh", token: "harness-access" }, error: null };
  if (fn === "qbo_displace_realm") {
    // 084's semantics: clear the company off whoever else holds it, KEEP their map, audit it.
    const held = db.rows("client_settings").find((r) => r.qbo_realm_id === args.p_realm_id && r.client_id !== args.p_new_client_id);
    if (!held) return { data: null, error: null };
    Object.assign(held, {
      qbo_realm_id: null, qbo_access_token: null, qbo_refresh_token: null, qbo_connected_at: null,
      qbo_disconnect_reason: "That QuickBooks company was connected to a different StructureStudio account.",
    });
    db.rows("admin_audit").push({ action: "qbo_realm_displaced", target_client_id: held.client_id });
    return { data: held.client_id, error: null };
  }
  throw new Error(`the fake database has no rpc ${fn}`);
}

function chain(db: FakeDb, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(db, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "not", "in", "gt", "gte", "lt", "order", "limit", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    db.log.push([table, ...ops]);
    return Promise.resolve().then(() => run(db, table, ops)).then(ok, bad);
  };
  return q;
}

// ─── "Intuit" ──────────────────────────────────────────────────────────────────────────────────
type Intuit = {
  calls: { method: string; url: string; body: any }[];
  companyName?: string;
  existingInvoiceId?: string | null;   // the DocNumber idempotency query finds this one
  existingCustomerId?: string;         // …made for this customer (default: the one the lookup finds, "77")
  // Automated Sales Tax, as Preferences reports it. On (the default, as for most US companies)
  // the push sends no line-level tax codes; off is the one case delivery's NON code is sent.
  automatedSalesTax?: boolean;
};

function intuitFetch(w: Intuit): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    let body: any = null;
    if (init?.body) { try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); } }
    w.calls.push({ method, url, body });
    const u = new URL(url);
    const ok = (o: unknown) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { "intuit_tid": "harness-tid" } }));
    if (u.hostname === "developer.api.intuit.com" && u.pathname.startsWith("/.well-known/")) {
      return ok({
        authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2",
        token_endpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        revocation_endpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
      });
    }
    if (u.hostname === "oauth.platform.intuit.com") {
      return ok({ access_token: "harness-access", refresh_token: "harness-refresh", expires_in: 3600, x_refresh_token_expires_in: 8726400 });
    }
    if (u.origin === API) {
      const m = u.pathname.match(/^\/v3\/company\/([^/]+)\/(.+)$/);
      if (m) {
        const rest = m[2];
        if (rest.startsWith("companyinfo/")) return ok({ CompanyInfo: { CompanyName: w.companyName ?? "Harness Books" } });
        if (rest === "query") {
          const q = u.searchParams.get("query") ?? "";
          if (/from Customer/i.test(q)) return ok({ QueryResponse: { Customer: [{ Id: "77" }] } });
          if (/from Invoice/i.test(q)) {
            return ok({ QueryResponse: w.existingInvoiceId
              ? { Invoice: [{ Id: w.existingInvoiceId, DocNumber: "INV-1", TotalAmt: 100, CustomerRef: { value: w.existingCustomerId ?? "77" } }] }
              : {} });
          }
          if (/from Preferences/i.test(q)) return ok({ QueryResponse: { Preferences: [{ TaxPrefs: { PartnerTaxEnabled: w.automatedSalesTax !== false } }] } });
        }
        if (rest === "invoice" && method === "POST") {
          const total = (body?.Line ?? []).reduce((s: number, l: any) => s + (Number(l.Amount) || 0), 0);
          return ok({ Invoice: { Id: "9001", DocNumber: body?.DocNumber ?? null, TotalAmt: total } });
        }
      }
    }
    return Promise.reject(new Error(`TEST FAILURE: unexpected fetch ${method} ${url}`));
  }) as typeof fetch;
}
const apiCalls = (w: Intuit) => w.calls.filter((c) => c.url.startsWith(API));

// ─── The world one call runs in ────────────────────────────────────────────────────────────────
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
  QBO_CLIENT_ID: "harness-client",
  QBO_CLIENT_SECRET: "harness-secret",
  QBO_API_BASE: API,
};

async function inWorld<T>(db: FakeDb, w: Intuit, body: () => Promise<T>): Promise<T> {
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  // Discovery's 4 s AbortSignal.timeout would outlive the test as a live timer; nothing here waits.
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: () => new AbortController().signal });
  globalThis.fetch = intuitFetch(w);
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (t: string) => db.from(t);
  stubRpc.rpc = (fn: string, args?: unknown) => db.rpc(fn, args);
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: realTimeout });
    stubDb.from = null;
    stubRpc.rpc = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

// ─── Seeds ─────────────────────────────────────────────────────────────────────────────────────
const map = (client_id: string, line_kind: string, qbo_item_id: string, realm_id: string | null, extra: Row = {}): Row =>
  ({ id: `${client_id}-${line_kind}-${extra.item_key ?? ""}-${extra.style_id ?? ""}`, client_id, line_kind, item_key: "", style_id: null,
     qbo_item_id, qbo_item_name: `Item ${qbo_item_id}`, realm_id, ...extra });

function settings(client_id: string, realm: string | null, connected: boolean, extra: Row = {}): Row {
  return {
    client_id, qbo_realm_id: realm, qbo_company_name: realm ? `Books ${realm.slice(-1)}` : null,
    qbo_connected_at: connected ? "2026-08-06T09:55:00Z" : null, qbo_refresh_error: null,
    qbo_refresh_token_expires_at: null, qbo_disconnect_reason: null, qbo_oauth_state: null, qbo_oauth_state_expires_at: null,
    qbo_access_token: connected ? "old-access" : null, qbo_refresh_token: connected ? "old-refresh" : null,
    internal_account: false, billing_exempt: true, ...extra,
  };
}

/** A design with the given estimate lines, a sent invoice not yet in QuickBooks, and the map. */
function pushWorld(realmOnFile: string, maps: Row[], lines: Row[], styleId: string | null = null): FakeDb {
  return new FakeDb({
    client_settings: [settings(TENANT, realmOnFile, true)],
    designs: [{
      client_id: TENANT, short_code: "SS-HARNESS01",
      estimate_lines: { lines, styleId, discount: 0 },
      contact: { firstName: "Pat", lastName: "Example", email: "pat@example.test" },
    }],
    invoice_sends: [{ client_id: TENANT, short_code: "SS-HARNESS01", invoice_number: "INV-1", status: "sent", qbo_invoice_id: null,
      qbo_doc_number: null, qbo_pushed_at: null, qbo_error: null, qbo_attempts: 0, qbo_tid: null, qbo_realm_id: null, updated_at: null }],
    qbo_item_map: maps,
    app_errors: [],
  });
}
const LINES = [
  { kind: "building", itemKey: "", name: "10x12 Barn", qty: 1, amount: 5000 },
  { kind: "door", itemKey: "", name: "Single door", qty: 1, amount: 300 },
  { kind: "layout_item", itemKey: "loft", name: "Loft", qty: 1, amount: 200 },
];
const ledger = (db: FakeDb) => db.rows("invoice_sends").find((r) => r.short_code === "SS-HARNESS01")!;
const push = (db: FakeDb, w: Intuit) =>
  inWorld(db, w, () => pushQboInvoice(db, TENANT, { shortCode: "SS-HARNESS01", docNumber: "INV-1", ghlTotal: 5500 }));

// ─── 1. The push ───────────────────────────────────────────────────────────────────────────────
Deno.test("push: another company's mappings are NOT MAPPED, and QuickBooks is never called", async () => {
  // The tenant mapped every kind against company A, then connected company B: the old bug billed
  // all three lines as whatever B has under A's ids.
  const db = pushWorld(BOOKS_B, [
    map(TENANT, "building", "11", BOOKS_A), map(TENANT, "door", "12", BOOKS_A), map(TENANT, "fallback", "16", BOOKS_A),
  ], LINES);
  const w: Intuit = { calls: [] };
  await push(db, w);
  const row = ledger(db);
  assert(String(row.qbo_error).startsWith("unmapped: building (10x12 Barn), door (Single door), layout_item:loft (Loft)"), row.qbo_error);
  assert(String(row.qbo_error).endsWith("map these under Settings → QuickBooks, then Retry"), row.qbo_error);
  assertEquals(row.qbo_invoice_id, null);
  assertEquals(row.qbo_realm_id, null, "nothing was pushed, so no company is recorded");
  assertEquals(apiCalls(w), [], "a QuickBooks request was made with mappings from another company");
});

Deno.test("push: an unstamped mapping is nobody's, so it is not mapped either", async () => {
  const db = pushWorld(BOOKS_A, [map(TENANT, "fallback", "16", null)], LINES);
  const w: Intuit = { calls: [] };
  await push(db, w);
  assert(String(ledger(db).qbo_error).startsWith("unmapped: building"), ledger(db).qbo_error);
  assertEquals(apiCalls(w), []);
});

Deno.test("push: an old company's fallback cannot catch a line the new company left unmapped", async () => {
  // Building mapped for B, the fallback still A's: the door and the loft have nowhere to go.
  const db = pushWorld(BOOKS_B, [map(TENANT, "building", "21", BOOKS_B), map(TENANT, "fallback", "16", BOOKS_A)], LINES);
  const w: Intuit = { calls: [] };
  await push(db, w);
  assert(String(ledger(db).qbo_error).startsWith("unmapped: door (Single door), layout_item:loft (Loft)"), ledger(db).qbo_error);
  assertEquals(apiCalls(w), []);
});

Deno.test("push: the connected company's mappings bill, and the invoice records that company", async () => {
  const db = pushWorld(BOOKS_B, [
    map(TENANT, "building", "11", BOOKS_A, { style_id: STYLE_BARN }),         // A's barn override: ignored
    map(TENANT, "building", "21", BOOKS_B, { id: "b-default" }),
    map(TENANT, "door", "23", BOOKS_B),
    map(TENANT, "fallback", "29", BOOKS_B),
  ], LINES, STYLE_BARN);
  const w: Intuit = { calls: [] };
  await push(db, w);
  const row = ledger(db);
  assertEquals(row.qbo_error, null, "a clean push");
  assertEquals(row.qbo_invoice_id, "9001");
  assertEquals(row.qbo_realm_id, BOOKS_B, "the invoice row names the company it went into");
  // Every request went to company B, and the lines carry B's items: the building takes B's
  // default because A's barn override is not B's, the door is B's, and the loft goes through B's
  // fallback (no kind-level layout_item step exists to try first).
  assert(apiCalls(w).length > 0 && apiCalls(w).every((c) => c.url.startsWith(`${API}/v3/company/${BOOKS_B}/`)), "a request went to another company");
  const created = apiCalls(w).find((c) => c.method === "POST" && /\/invoice\?/.test(c.url));
  assert(created, "no invoice was created");
  assertEquals(created!.body.Line.map((l: any) => l.SalesItemLineDetail.ItemRef.value), ["21", "23", "29"]);
});

Deno.test("push: an invoice adopted after a crashed run records its company too", async () => {
  const db = pushWorld(BOOKS_B, [map(TENANT, "fallback", "29", BOOKS_B)], LINES);
  const w: Intuit = { calls: [], existingInvoiceId: "4444" };
  await push(db, w);
  const row = ledger(db);
  assertEquals(row.qbo_invoice_id, "4444");
  assertEquals(row.qbo_realm_id, BOOKS_B);
  assert(!apiCalls(w).some((c) => c.method === "POST"), "an adopted invoice was created a second time");
});

// Since 283 a blank invoice start numbers from 1000, so a company connected later (or whose own
// numbering began at 1001) can already hold an UNRELATED invoice under the same number. Adopted on
// its Id alone, it was linked to ours, nothing reached the books and qbo_error stayed empty.
Deno.test("push: an invoice with the same number for ANOTHER customer is not adopted, and the push is listed for Retry", async () => {
  const db = pushWorld(BOOKS_B, [map(TENANT, "fallback", "29", BOOKS_B)], LINES);
  const w: Intuit = { calls: [], existingInvoiceId: "4444", existingCustomerId: "12" };
  await push(db, w);
  const row = ledger(db);
  assertEquals(row.qbo_invoice_id, null, "someone else's QuickBooks invoice was linked to this one");
  assertEquals(row.qbo_realm_id, null);
  assert(String(row.qbo_error).startsWith("rejected: QuickBooks already has an invoice numbered INV-1 for a different customer"), row.qbo_error);
  assert(String(row.qbo_error).length <= 300, "qbo_pending shows 300 characters");
  assertEquals(row.qbo_attempts, 1);
  assert(!apiCalls(w).some((c) => c.method === "POST" && /\/invoice\?/.test(c.url)), "an invoice was created under a number QuickBooks already uses");
});

Deno.test("push: a mapping read that FAILS says so, and is never reported as unmapped lines", async () => {
  // What a schema out of step with the functions looks like (265 rolled back before them, or the
  // functions live first): the select names realm_id and PostgREST refuses it. Swallowed, every
  // line read as "unmapped", and the owner was told to map lines that were mapped.
  const db = pushWorld(BOOKS_A, [map(TENANT, "fallback", "16", BOOKS_A)], LINES);
  db.fails.push({ table: "qbo_item_map", verb: "select", error: { message: "column qbo_item_map.realm_id does not exist", code: "42703" } });
  const w: Intuit = { calls: [] };
  await push(db, w);
  const row = ledger(db);
  assertEquals(row.qbo_error, "couldn't read your QuickBooks item mappings — Retry in a minute");
  assertEquals(row.qbo_invoice_id, null);
  assertEquals(row.qbo_attempts, 1, "the attempt was not recorded");
  assertEquals(errorsOf(db, "qbo_item_map_read_failed").length, 1, "the failed read was not filed");
  assertEquals(apiCalls(w), [], "QuickBooks was called without a mapping");
});

// ─── 2. The callback ───────────────────────────────────────────────────────────────────────────
const NONCE = "harness-nonce-0123456789";
const state = (cid: string) =>
  btoa(JSON.stringify({ cid, n: NONCE, rt: "beta.structurestudiosuite.com" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const armed = (r: Row): Row => ({ ...r, qbo_oauth_state: NONCE, qbo_oauth_state_expires_at: new Date(Date.now() + 600_000).toISOString() });

async function connect(db: FakeDb, cid: string, realm: string) {
  const w: Intuit = { calls: [], companyName: `Books ${realm.slice(-1)}` };
  const res = await inWorld(db, w, () => CALLBACK(new Request(
    `https://stub.supabase.co/functions/v1/qbo-oauth-callback?code=harness-code&realmId=${realm}&state=${state(cid)}`,
    { headers: { "user-agent": "harness/1.0" } },
  )));
  assertEquals(res.status, 302);
  const loc = new URL(res.headers.get("Location")!);
  assertEquals(loc.pathname, "/portal/settings/quickbooks");
  return { landed: Object.fromEntries(loc.searchParams), w };
}

const mapsOf = (db: FakeDb, cid: string) =>
  db.rows("qbo_item_map").filter((r) => r.client_id === cid).map((r) => `${r.line_kind}:${r.qbo_item_id}@${r.realm_id ?? "none"}`).sort();
const audits = (db: FakeDb, action: string) => db.rows("admin_audit").filter((r) => r.action === action);
const errorsOf = (db: FakeDb, code: string) => db.rows("app_errors").filter((r) => r.code === code);

/** The tenant's A map (and a bystander's), with the tenant's settings as given. */
function callbackWorld(tenantSettings: Row, tenantMaps?: Row[]): FakeDb {
  return new FakeDb({
    client_settings: [armed(tenantSettings), settings(BYSTANDER, BOOKS_C, true)],
    qbo_item_map: [
      ...(tenantMaps ?? [map(TENANT, "building", "11", BOOKS_A), map(TENANT, "door", "12", BOOKS_A), map(TENANT, "fallback", "16", BOOKS_A)]),
      map(BYSTANDER, "fallback", "16", BOOKS_C), map(BYSTANDER, "door", "12", BOOKS_A),
    ],
    admin_audit: [],
    app_errors: [],
  });
}
const BYSTANDER_MAPS = ["door:12@" + BOOKS_A, "fallback:16@" + BOOKS_C].sort();

Deno.test("callback: reconnecting the SAME company keeps every mapping (disconnect tombstone on file)", async () => {
  const db = callbackWorld(settings(TENANT, BOOKS_A, false));
  const { landed } = await connect(db, TENANT, BOOKS_A);
  assertEquals(landed, { connected: "1" });
  assertEquals(mapsOf(db, TENANT), ["building:11@" + BOOKS_A, "door:12@" + BOOKS_A, "fallback:16@" + BOOKS_A]);
  assertEquals(mapsOf(db, BYSTANDER), BYSTANDER_MAPS);
  const cs = db.rows("client_settings").find((r) => r.client_id === TENANT)!;
  assertEquals(cs.qbo_realm_id, BOOKS_A);
  assert(cs.qbo_connected_at, "the connection saved");
  assertEquals(audits(db, "qbo_connected").map((a) => a.note), ["Connected to Books 1"]);
});

Deno.test("callback: reconnecting the same company after the realm was cleared by hand keeps the mappings", async () => {
  // Realm NULL on file: the old code read this as a first connect. It still is harmless when the
  // company is the same, because the rows say which company they name.
  const db = callbackWorld(settings(TENANT, null, false));
  const { landed } = await connect(db, TENANT, BOOKS_A);
  assertEquals(landed, { connected: "1" });
  assertEquals(mapsOf(db, TENANT).length, 3);
});

Deno.test("callback: switching company clears the old company's mappings and says why", async () => {
  const db = callbackWorld(settings(TENANT, BOOKS_A, true));
  const { landed } = await connect(db, TENANT, BOOKS_B);
  assertEquals(landed, { connected: "1", reason: "company_changed" });
  assertEquals(mapsOf(db, TENANT), []);
  assertEquals(mapsOf(db, BYSTANDER), BYSTANDER_MAPS, "another tenant's rows were touched");
  assertEquals(audits(db, "qbo_connected").map((a) => a.note), ["Connected to Books 2 — cleared 3 item mappings not for this company"]);
});

Deno.test("callback: THE BUG — no realm on file (taken over earlier) and a DIFFERENT company now: the old map is cleared", async () => {
  // 084 took company A off this tenant (realm NULL, map kept on purpose). It now connects B. The
  // old "did the realm change?" compare saw no previous realm, wiped nothing, and A's item ids
  // billed every line in B's books.
  const db = callbackWorld(settings(TENANT, null, false, { qbo_disconnect_reason: "taken over" }));
  const { landed } = await connect(db, TENANT, BOOKS_B);
  assertEquals(landed, { connected: "1", reason: "company_changed" });
  assertEquals(mapsOf(db, TENANT), [], "company A's item ids survived a connect to company B");
  assertEquals(mapsOf(db, BYSTANDER), BYSTANDER_MAPS);
  assertEquals(db.rows("client_settings").find((r) => r.client_id === TENANT)!.qbo_disconnect_reason, null);
});

Deno.test("callback: an unstamped row on a reconnect of the company on file is KEPT and stamped", async () => {
  // Saved by a portal-settings without 265 (a rollback, or a deploy from a branch cut before it)
  // while this same company was on file, so its item id is this company's. Deleting it lost a
  // working mapping on a routine reconnect under the plain "connected" banner.
  const db = callbackWorld(settings(TENANT, BOOKS_A, false), [map(TENANT, "building", "11", BOOKS_A), map(TENANT, "door", "12", null)]);
  const { landed } = await connect(db, TENANT, BOOKS_A);
  assertEquals(landed, { connected: "1" });
  assertEquals(mapsOf(db, TENANT), ["building:11@" + BOOKS_A, "door:12@" + BOOKS_A], "a same-company reconnect lost or skipped a row");
  assertEquals(mapsOf(db, BYSTANDER), BYSTANDER_MAPS);
  assert(!db.log.some((op) => op[0] === "qbo_item_map" && op.some((o: any) => o[0] === "delete") && op.some((o: any) => o[0] === "is")),
    "an IS NULL delete ran on a same-company reconnect");
  assertEquals(audits(db, "qbo_connected").map((a) => a.note), ["Connected to Books 1 — stamped 1 unstamped item mapping with this company"]);
});

Deno.test("callback: an unstamped row goes when a DIFFERENT company (or none) was on file, without claiming a switch", async () => {
  // Nobody can say which company it named. `neq` alone would keep it (NULL never matches); the
  // IS NULL delete is what clears it.
  for (const onFile of [BOOKS_B, null]) {
    const db = callbackWorld(settings(TENANT, onFile, false), [map(TENANT, "door", "12", null)]);
    const { landed } = await connect(db, TENANT, BOOKS_A);
    assertEquals(landed, { connected: "1" }, "an unstamped row is not a company switch");
    assertEquals(mapsOf(db, TENANT), [], `realm on file ${onFile}`);
    assertEquals(mapsOf(db, BYSTANDER), BYSTANDER_MAPS);
    assertEquals(audits(db, "qbo_connected").map((a) => a.note), ["Connected to Books 1 — cleared 1 item mapping not for this company"]);
  }
});

Deno.test("callback: a same-company reconnect whose tidy-up fails keeps every row and lands on item_map_stale", async () => {
  const db = callbackWorld(settings(TENANT, BOOKS_A, true), [map(TENANT, "building", "11", BOOKS_A), map(TENANT, "door", "12", null)]);
  db.fails.push({ table: "qbo_item_map", verb: "update", error: { message: "harness: the stamp timed out", code: "57014" } });
  const { landed } = await connect(db, TENANT, BOOKS_A);
  assertEquals(landed, { connected: "1", reason: "item_map_stale" });
  assertEquals(mapsOf(db, TENANT), ["building:11@" + BOOKS_A, "door:12@none"], "a failed stamp deleted something");
  assertEquals(errorsOf(db, "57014").length, 1);
  assertEquals(audits(db, "qbo_connected").map((a) => a.note), ["Connected to Books 1 — leftover item mappings NOT tidied up"]);
});

Deno.test("callback: a wipe that fails lands on item_map_stale, files the fault, and still audits the connect", async () => {
  const db = callbackWorld(settings(TENANT, BOOKS_A, true));
  db.fails.push({ table: "qbo_item_map", verb: "delete", error: { message: "harness: the delete timed out", code: "57014" } });
  const { landed } = await connect(db, TENANT, BOOKS_B);
  assertEquals(landed, { connected: "1", reason: "item_map_stale" });
  assertEquals(db.rows("client_settings").find((r) => r.client_id === TENANT)!.qbo_realm_id, BOOKS_B, "the connection itself saved");
  assertEquals(errorsOf(db, "57014").length, 1, "the failed wipe was not filed");
  assertEquals(audits(db, "qbo_connected").map((a) => a.note), ["Connected to Books 2 — leftover item mappings NOT tidied up"]);
  // What is left behind is company A's, and since 265 nothing reads it for company B.
  assertEquals(mapsOf(db, TENANT).every((m) => m.endsWith("@" + BOOKS_A)), true);
});

Deno.test("callback: a save that fails clears nothing", async () => {
  const db = callbackWorld(settings(TENANT, BOOKS_A, true));
  // Every client_settings update fails, the nonce burn included (its result is not checked, as
  // live), so the connection save is what reports it.
  db.fails.push({ table: "client_settings", verb: "update", error: { message: "harness: the save failed", code: "08006" } });
  const { landed } = await connect(db, TENANT, BOOKS_B);
  assertEquals(landed, { connected: "0", reason: "save" });
  assertEquals(db.rows("client_settings").find((r) => r.client_id === TENANT)!.qbo_realm_id, BOOKS_A, "the connection moved");
  assertEquals(mapsOf(db, TENANT).length, 3, "a failed connect destroyed the mapping");
  assert(!db.log.some((op) => op[0] === "qbo_item_map" && op.some((o: any) => o[0] === "delete")), "a delete was attempted");
});

Deno.test("callback: taking a company over from another tenant clears only the taker's other-company rows", async () => {
  // The bystander holds company C. The tenant (mapped against A) connects C: 084 hands C over,
  // the bystander keeps its map untouched (it may take C back), and the tenant's A rows go.
  const db = callbackWorld(settings(TENANT, BOOKS_A, true));
  const { landed } = await connect(db, TENANT, BOOKS_C);
  // Both things happened, so both are said: displaced_other alone left the emptied grid unexplained.
  assertEquals(landed, { connected: "1", reason: "displaced_company_changed" });
  assertEquals(mapsOf(db, TENANT), []);
  assertEquals(mapsOf(db, BYSTANDER), BYSTANDER_MAPS, "the displaced tenant's map must be kept");
  assertEquals(db.rows("client_settings").find((r) => r.client_id === BYSTANDER)!.qbo_realm_id, null);
  assertEquals(audits(db, "qbo_connected").map((a) => a.note), [`Connected to Books 3 — took over from ${BYSTANDER} — cleared 3 item mappings not for this company`]);
});

Deno.test("callback: a takeover by a tenant with nothing else mapped says only that", async () => {
  const db = callbackWorld(settings(TENANT, null, false), []);
  const { landed } = await connect(db, TENANT, BOOKS_C);
  assertEquals(landed, { connected: "1", reason: "displaced_other" });
  assertEquals(mapsOf(db, BYSTANDER), BYSTANDER_MAPS);
});

// ─── 3. portal-settings ────────────────────────────────────────────────────────────────────────
// `extra` replaces whole tables (section 4 seeds a tenant shaped like the live one).
function settingsWorld(realm: string | null, connected = true, maps?: Row[], sends: Row[] = [], extra: Record<string, Row[]> = {}): FakeDb {
  return new FakeDb({
    client_users: [{ user_id: USER_ID, client_id: TENANT, role: "owner", title: null, access: null }],
    client_settings: [settings(TENANT, realm, connected)],
    billing_plans: [],
    client_layout_items: [{ client_id: TENANT, item_key: "loft", label_override: null, active: true, sort_order: 1 }],
    building_styles: [{ id: STYLE_BARN, client_id: TENANT, label: "Barn", active: true }],
    layout_item_types: [{ item_key: "loft", label: "Loft" }],
    // One row per slot, as the unique index allows: two left from company A (a wipe that failed),
    // two made for company B, one nobody stamped, and another tenant's.
    qbo_item_map: maps ?? [
      map(TENANT, "roof", "11", BOOKS_A, { id: "a-roof" }),
      map(TENANT, "door", "12", BOOKS_A, { id: "a-door" }),
      map(TENANT, "building", "21", BOOKS_B, { id: "b-building" }),
      map(TENANT, "layout_item", "26", BOOKS_B, { id: "b-loft", item_key: "loft" }),
      map(TENANT, "fallback", "16", null, { id: "unstamped" }),
      map(BYSTANDER, "fallback", "16", BOOKS_B, { id: "bystander" }),
    ],
    invoice_sends: sends,
    admin_audit: [],
    app_errors: [],
    ...extra,
  });
}

async function call(db: FakeDb, payload: Row) {
  const w: Intuit = { calls: [] };
  const res = await inWorld(db, w, () => SETTINGS(new Request("https://stub.supabase.co/functions/v1/portal-settings", {
    method: "POST",
    headers: { "authorization": "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
    body: JSON.stringify(payload),
  })));
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, w };
}

Deno.test("qbo_status counts only the connected company's mappings", async () => {
  const r = await call(settingsWorld(BOOKS_B), { action: "qbo_status" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.connected, true);
  assertEquals(r.body.mappedCount, 2, "A's two rows, the unstamped row or the bystander's were counted");
  const none = await call(settingsWorld(null, false), { action: "qbo_status" });
  assertEquals(none.body.mappedCount, 0, "no company on file, no mappings");
});

Deno.test("list_item_map shows only the connected company's rows, without the realm id", async () => {
  const r = await call(settingsWorld(BOOKS_B), { action: "list_item_map" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.mappings.map((m: Row) => m.id).sort(), ["b-building", "b-loft"]);
  assert(r.body.mappings.every((m: Row) => !("realm_id" in m)), "the realm id reached the browser");
  assert(!JSON.stringify(r.body).includes(BOOKS_B), "the realm id reached the browser");
  // Everything else the grid needs is unchanged.
  assertEquals(r.body.layoutItems, [{ item_key: "loft", label: "Loft", active: true }]);
  assertEquals(r.body.styles.map((s: Row) => s.id), [STYLE_BARN]);
});

Deno.test("save_item_map stamps the company, and re-stamps a slot another company's row still holds", async () => {
  const db = settingsWorld(BOOKS_B);
  const r = await call(db, {
    action: "save_item_map",
    rows: [
      { lineKind: "door", itemKey: "", styleId: null, qboItemId: "23", qboItemName: "Doors" },        // A's slot
      { lineKind: "wall_height", itemKey: "", styleId: null, qboItemId: "24", qboItemName: "Options" }, // new
      { lineKind: "building", itemKey: "", styleId: null, qboItemId: "25", qboItemName: "Buildings" },  // B's own
    ],
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals([r.body.saved, r.body.deleted, r.body.skipped], [3, 0, []]);
  const rows = db.rows("qbo_item_map").filter((m) => m.client_id === TENANT);
  const door = rows.filter((m) => m.line_kind === "door");
  assertEquals(door.length, 1, "a second door row was inserted beside the old company's");
  assertEquals([door[0].id, door[0].qbo_item_id, door[0].realm_id], ["a-door", "23", BOOKS_B]);
  const wall = rows.find((m) => m.line_kind === "wall_height")!;
  assertEquals([wall.qbo_item_id, wall.realm_id], ["24", BOOKS_B]);
  assertEquals(rows.find((m) => m.id === "b-building")!.realm_id, BOOKS_B);
  assertEquals(db.rows("qbo_item_map").find((m) => m.id === "bystander")!.realm_id, BOOKS_B, "another tenant's row moved");
  // And the grid now reads back what the push will use.
  const list = await call(db, { action: "list_item_map" });
  assertEquals(list.body.mappings.map((m: Row) => `${m.line_kind}:${m.qbo_item_id}`).sort(), ["building:25", "door:23", "layout_item:26", "wall_height:24"]);
});

Deno.test("save_item_map keeps the company of a disconnected tenant (the tombstone), so a same-company reconnect keeps it", async () => {
  const db = settingsWorld(BOOKS_B, false);
  const r = await call(db, { action: "save_item_map", rows: [{ lineKind: "paint", qboItemId: "27", qboItemName: "Paint" }] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(db.rows("qbo_item_map").find((m) => m.line_kind === "paint")!.realm_id, BOOKS_B);
});

Deno.test("save_item_map refuses a mapping with no company on file, before writing anything", async () => {
  const db = settingsWorld(null, false);
  const before = JSON.stringify(db.rows("qbo_item_map"));
  const r = await call(db, {
    action: "save_item_map",
    rows: [{ lineKind: "paint", qboItemId: "27" }, { lineKind: "door", qboItemId: "" }],
  });
  assertEquals(r.status, 409, JSON.stringify(r.body));
  assertEquals(r.body.error, "Connect QuickBooks first, then pick your items.");
  assertEquals(JSON.stringify(db.rows("qbo_item_map")), before, "a refused save wrote something");
  // Clearing needs no company: a blank-only save still goes through.
  const clear = await call(db, { action: "save_item_map", rows: [{ lineKind: "door", qboItemId: "" }] });
  assertEquals(clear.status, 200, JSON.stringify(clear.body));
  assertEquals(clear.body.deleted, 1);
  assert(!db.rows("qbo_item_map").some((m) => m.id === "a-door"));
});

Deno.test("retry_qbo_push: an invoice in the company before a switch says so, and is not pushed again", async () => {
  const sends = [
    { client_id: TENANT, short_code: "SS-OLDBOOKS1", invoice_number: "INV-7", status: "sent", qbo_invoice_id: "501", qbo_realm_id: BOOKS_A },
    { client_id: TENANT, short_code: "SS-NEWBOOKS1", invoice_number: "INV-8", status: "sent", qbo_invoice_id: "601", qbo_realm_id: BOOKS_B },
    { client_id: TENANT, short_code: "SS-UNKNOWN01", invoice_number: "INV-9", status: "sent", qbo_invoice_id: "701", qbo_realm_id: null },
  ];
  for (const [code, other] of [["SS-OLDBOOKS1", true], ["SS-NEWBOOKS1", false], ["SS-UNKNOWN01", false]] as const) {
    const db = settingsWorld(BOOKS_B, true, undefined, sends.map((s) => ({ ...s })));
    const r = await call(db, { action: "retry_qbo_push", shortCode: code });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals([r.body.ok, r.body.alreadyPushed, r.body.otherCompany], [true, true, other], code);
    assertEquals(apiCalls(r.w), [], `${code} was pushed again`);
    assert(!db.log.some((op) => op[0] === "invoice_sends" && op.some((o: any) => o[0] === "update")), `${code}'s ledger row was rewritten`);
  }
});

/** settingsWorld plus a design whose invoice is sent and not yet in QuickBooks, so one database
 *  serves the grid, the push and the callback. The tenant's row is armed for a connect. */
function switchWorld(maps: Row[]): FakeDb {
  const db = settingsWorld(BOOKS_A, true, maps, [{
    client_id: TENANT, short_code: "SS-HARNESS01", invoice_number: "INV-1", status: "sent", qbo_invoice_id: null,
    qbo_doc_number: null, qbo_pushed_at: null, qbo_error: null, qbo_attempts: 0, qbo_tid: null, qbo_realm_id: null, updated_at: null,
  }], {
    designs: [{
      client_id: TENANT, short_code: "SS-HARNESS01",
      estimate_lines: { lines: LINES, styleId: null, discount: 0 },
      contact: { firstName: "Pat", lastName: "Example", email: "pat@example.test" },
    }],
  });
  Object.assign(db.rows("client_settings").find((r) => r.client_id === TENANT)!, armed({}));
  return db;
}

Deno.test("save_item_map refuses a save from a page loaded before a company switch, and writes nothing", async () => {
  const db = switchWorld([map(TENANT, "building", "11", BOOKS_A, { id: "a-building" }), map(TENANT, "door", "12", BOOKS_A, { id: "a-door" })]);
  // Tab 1 opens Settings → QuickBooks on company A.
  const loaded = await call(db, { action: "list_item_map" });
  const tagA = loaded.body.companyTag;
  assert(typeof tagA === "string" && /^[0-9a-f]{12}$/.test(tagA), `list_item_map's tag: ${tagA}`);
  assert(!JSON.stringify(loaded.body).includes(BOOKS_A), "the realm id reached the browser");
  // Tab 2 connects company B: A's rows go.
  const { landed } = await connect(db, TENANT, BOOKS_B);
  assertEquals(landed, { connected: "1", reason: "company_changed" });
  assertEquals(mapsOf(db, TENANT), []);
  // Tab 1, still showing A's items, saves Doors as A's item 11 and clears Building.
  const stale = await call(db, {
    action: "save_item_map", companyTag: tagA,
    rows: [{ lineKind: "door", qboItemId: "11", qboItemName: "Doors" }, { lineKind: "building", qboItemId: "" }],
  });
  assertEquals(stale.status, 409, JSON.stringify(stale.body));
  assertEquals(stale.body.error, "Your QuickBooks company changed since this page loaded. Reload the page, then pick your items.");
  assertEquals(mapsOf(db, TENANT), [], "a refused save wrote something");
  // So A's item 11 can never bill as B's: the push still reads every line as not mapped.
  const w: Intuit = { calls: [] };
  await push(db, w);
  assert(String(ledger(db).qbo_error).startsWith("unmapped: building (10x12 Barn), door (Single door)"), ledger(db).qbo_error);
  assertEquals(apiCalls(w), []);
  // Reloaded, the page carries B's tag and the same save goes through, stamped with B.
  const fresh = await call(db, { action: "list_item_map" });
  assert(fresh.body.companyTag && fresh.body.companyTag !== tagA, "the tag did not follow the company");
  const ok = await call(db, {
    action: "save_item_map", companyTag: fresh.body.companyTag,
    rows: [{ lineKind: "door", qboItemId: "23", qboItemName: "Doors" }],
  });
  assertEquals(ok.status, 200, JSON.stringify(ok.body));
  assertEquals(mapsOf(db, TENANT), ["door:23@" + BOOKS_B]);
  // A disconnect keeps the company on file (the tombstone), so the tag, and a page open across
  // it, stay good.
  db.rows("client_settings").find((r) => r.client_id === TENANT)!.qbo_connected_at = null;
  const afterDisconnect = await call(db, {
    action: "save_item_map", companyTag: fresh.body.companyTag,
    rows: [{ lineKind: "paint", qboItemId: "27", qboItemName: "Paint" }],
  });
  assertEquals(afterDisconnect.status, 200, JSON.stringify(afterDisconnect.body));
});

Deno.test("qbo_status counts the invoices that stayed in the company before a switch", async () => {
  // Carolyn's open question on the reconnect card: "what should happen to invoices that were
  // already sent to the OLD one?" They stay there, and this is where the owner is told. Driven
  // from what the push and the callback actually record, not a seeded answer.
  const db = switchWorld([map(TENANT, "fallback", "16", BOOKS_A)]);
  await push(db, { calls: [] });
  assertEquals([ledger(db).qbo_invoice_id, ledger(db).qbo_realm_id], ["9001", BOOKS_A]);
  // Another tenant's invoice in company A is none of this tenant's business.
  db.rows("invoice_sends").push({ client_id: BYSTANDER, short_code: "SS-BYSTAND1", invoice_number: "INV-3", status: "sent", qbo_invoice_id: "333", qbo_realm_id: BOOKS_A });
  // One pushed before 265 could say where (NULL) is not claimed for either company.
  db.rows("invoice_sends").push({ client_id: TENANT, short_code: "SS-UNKNOWN01", invoice_number: "INV-0", status: "sent", qbo_invoice_id: "100", qbo_realm_id: null });
  assertEquals((await call(db, { action: "qbo_status" })).body.otherCompanyInvoices, 0, "before the switch");
  await connect(db, TENANT, BOOKS_B);
  const status = await call(db, { action: "qbo_status" });
  assertEquals(status.status, 200, JSON.stringify(status.body));
  assertEquals([status.body.connected, status.body.mappedCount, status.body.otherCompanyInvoices], [true, 0, 1]);
  // Retry never offers it: the pending list is for invoices that reached no company at all.
  assertEquals((await call(db, { action: "qbo_pending" })).body.pending, []);
  // No company on file, nothing to compare against.
  assertEquals((await call(settingsWorld(null, false), { action: "qbo_status" })).body.otherCompanyInvoices, 0);
});

Deno.test("the browser's copy knows every landing reason the callback can send", async () => {
  // A reason the grid does not know falls back to the plain "connected" banner: harmless, but
  // the owner would then never hear why their mappings emptied.
  const src = (await Deno.readTextFile(new URL("../../qbo-oauth-callback/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const grid = (await Deno.readTextFile(new URL("../../../../portal/08-integrations.jsx", import.meta.url))).replace(/\r\n/g, "\n");
  const sent = [...new Set([...src.matchAll(/reason:\s*"([a-z_]+)"/g)].map((m) => m[1]))];
  for (const r of ["company_changed", "item_map_stale", "displaced_other", "displaced_company_changed"]) {
    assert(sent.includes(r), `the callback no longer sends ${r}`);
  }
  const start = grid.indexOf("const QBO_REASONS = {");
  const end = grid.indexOf("\n};", start);
  assert(start >= 0 && end > start, "QBO_REASONS moved — re-point this test");
  const known = [...grid.slice(start, end).matchAll(/^\s*([a-z_]+):\s*"/gm)].map((m) => m[1]);
  for (const r of sent) assert(known.includes(r), `the callback sends reason "${r}" but the grid has no words for it`);
  // item_map_stale is reached on a SAME-company reconnect too (the tidy-up runs on every connect),
  // so its words must not talk about an old company that may not exist.
  const stale = grid.slice(start, end).match(/^\s*item_map_stale:\s*"([^"]*)"/m);
  assert(stale && !/old company/i.test(stale[1]), `item_map_stale speaks of an old company: ${stale && stale[1]}`);
});

// ─── 4. The newer line kinds, delivery and the shelves ─────────────────────────────────────────
// Carolyn, 2026-09-10: "a lot of options in here that are not going into QuickBooks", and a few
// with "nothing over here to map them with". The code landed 09-17; what is left is a chore on the
// live tenant: the seven newer kinds and four layout items (Single Shelf, Double Shelf, Rough
// Opening (Door), Rough Opening (Window)) to the catch-all Options item, Delivery left on the
// Fallback on purpose. These hold the shipped code to what that chore needs, on a tenant SHAPED
// like the live one (its 21 rows and seven active layout items; every id here is made up):
//   - before the chore every one of those lines bills as the Fallback, and Delivery keeps its
//     non-taxable code
//   - save_item_map takes the eleven rows the grid posts (tests/harness/qboItemGrid.mjs drives the
//     grid that posts them) and stamps each with the company: 32 rows after
//   - after it each line bills from its OWN row, so the keys the grid saves are the keys
//     submit-estimate tags lines with; Delivery still goes to the Fallback, still non-taxable
//   - a row saved with no company (the old save_item_map, between migration 265 and the new
//     portal-settings) is ignored, and its line falls to the stamped Fallback, not to an abort
const OPTIONS = "29";
const LIVE_STYLES = [STYLE_BARN, ...[2, 3, 4, 5, 6, 7].map((n) => `00000000-0000-4000-8000-0000000000b${n}`)];
const liveShapedMaps = (realm: string | null): Row[] => [
  ...LIVE_STYLES.map((s, i) => map(TENANT, "building", String(41 + i), realm, { style_id: s })),
  map(TENANT, "custom_option", OPTIONS, realm),
  map(TENANT, "door", "22", realm),
  map(TENANT, "fallback", OPTIONS, realm),
  ...([["doubleDoor", "22"], ["loft", OPTIONS], ["ramp", "24"], ["roughOpening", OPTIONS], ["singleDoor", "22"], ["window", "23"], ["workbench", OPTIONS]] as const)
    .map(([k, id]) => map(TENANT, "layout_item", id, realm, { item_key: k })),
  map(TENANT, "paint", "26", realm),
  map(TENANT, "ramp", "24", realm),
  map(TENANT, "roof", "25", realm),
  map(TENANT, "window", "23", realm),
];
const LIVE_LAYOUT = [
  ["doubleShelf", "Double Shelf"], ["loft", "Loft Area"], ["roughOpening", "Rough Opening"],
  ["roughOpeningDoor", "Rough Opening (Door)"], ["roughOpeningWindow", "Rough Opening (Window)"],
  ["shelf", "Single Shelf"], ["workbench", "Workbench"],
] as const;
const CHORE_KINDS = ["wall_height", "build_on_site", "cladding", "insulation", "electrical", "electrical_item", "foundation"] as const;
const CHORE_LAYOUT = ["shelf", "doubleShelf", "roughOpeningDoor", "roughOpeningWindow"] as const;
// Exactly what the grid posts for the chore (the harness pins the grid to this shape).
const choreRows = (idFor: (kind: string, key: string) => string = () => OPTIONS) => [
  ...CHORE_KINDS.map((k) => ({ lineKind: k, itemKey: "", styleId: null, qboItemId: idFor(k, ""), qboItemName: "Options" })),
  ...CHORE_LAYOUT.map((k) => ({ lineKind: "layout_item", itemKey: k, styleId: null, qboItemId: idFor("layout_item", k), qboItemName: "Options" })),
];
// One line of each, kinded and keyed the way submit-estimate tags them (qboLineKinds.test.ts holds
// submit-estimate to the kinds; the layout keys are client_layout_items' own).
const CHORE_LINES = [
  { kind: "building", itemKey: "", name: "10x16 Barn", qty: 1, amount: 6000 },
  { kind: "wall_height", itemKey: "", name: "Taller walls (+1 ft)", qty: 1, amount: 400 },
  { kind: "build_on_site", itemKey: "", name: "Built on site", qty: 1, amount: 900 },
  { kind: "cladding", itemKey: "", name: "Board and batten siding", qty: 1, amount: 700 },
  { kind: "insulation", itemKey: "", name: "Insulation (walls)", qty: 1, amount: 650 },
  { kind: "electrical", itemKey: "", name: "Electrical package", qty: 1, amount: 1200 },
  { kind: "electrical_item", itemKey: "", name: "Extra outlet", qty: 2, amount: 85 },
  { kind: "foundation", itemKey: "", name: "Gravel pad", qty: 1, amount: 800 },
  { kind: "layout_item", itemKey: "shelf", name: "Single Shelf", qty: 2, amount: 60 },
  { kind: "layout_item", itemKey: "doubleShelf", name: "Double Shelf", qty: 1, amount: 110 },
  { kind: "layout_item", itemKey: "roughOpeningDoor", name: "Rough Opening (Door)", qty: 1, amount: 150 },
  { kind: "layout_item", itemKey: "roughOpeningWindow", name: "Rough Opening (Window)", qty: 1, amount: 90 },
  { kind: "layout_item", itemKey: "loft", name: "Loft", qty: 1, amount: 300 },
  { kind: "delivery", itemKey: "", name: "Delivery", qty: 1, amount: 150, nonTaxable: true },
];
const CHORE_TOTAL = CHORE_LINES.reduce((s, l) => s + l.qty * l.amount, 0);

/** The live-shaped tenant: settingsWorld's owner and connection, plus a design with CHORE_LINES
 *  whose invoice is sent and not yet in QuickBooks, so the same database serves save and push. */
function choreWorld(maps: Row[]): FakeDb {
  return settingsWorld(BOOKS_A, true, maps, [{
    client_id: TENANT, short_code: "SS-HARNESS02", invoice_number: "INV-2", status: "sent", qbo_invoice_id: null,
    qbo_doc_number: null, qbo_pushed_at: null, qbo_error: null, qbo_attempts: 0, qbo_tid: null, qbo_realm_id: null, updated_at: null,
  }], {
    client_layout_items: LIVE_LAYOUT.map(([k], i) => ({ client_id: TENANT, item_key: k, label_override: null, active: true, sort_order: i })),
    layout_item_types: LIVE_LAYOUT.map(([k, label]) => ({ item_key: k, label })),
    building_styles: LIVE_STYLES.map((id, i) => ({ id, client_id: TENANT, label: `Style ${i + 1}`, active: true })),
    designs: [{
      client_id: TENANT, short_code: "SS-HARNESS02",
      estimate_lines: { lines: CHORE_LINES, styleId: STYLE_BARN, discount: 0 },
      contact: { firstName: "Pat", lastName: "Example", email: "pat@example.test" },
    }],
  });
}
async function pushChore(db: FakeDb, w: Intuit) {
  await inWorld(db, w, () => pushQboInvoice(db, TENANT, { shortCode: "SS-HARNESS02", docNumber: "INV-2", ghlTotal: CHORE_TOTAL }));
  const row = db.rows("invoice_sends").find((r) => r.short_code === "SS-HARNESS02")!;
  const created = apiCalls(w).find((c) => c.method === "POST" && /\/invoice\?/.test(c.url));
  // Each invoice line as "name → item [tax code]", in estimate order.
  const billed = created
    ? created.body.Line.map((l: any) => `${l.Description} → ${l.SalesItemLineDetail.ItemRef.value}${l.SalesItemLineDetail.TaxCodeRef ? ` [${l.SalesItemLineDetail.TaxCodeRef.value}]` : ""}`)
    : null;
  return { row, billed };
}

Deno.test("line kinds: before the chore, the newer kinds, the shelves and delivery all bill as the Fallback", async () => {
  const db = choreWorld(liveShapedMaps(BOOKS_A));
  // Automated Sales Tax off, the one case the push sends delivery's line-level NON code.
  const { row, billed } = await pushChore(db, { calls: [], automatedSalesTax: false });
  assertEquals(row.qbo_error, null, "a clean push");
  assertEquals(row.qbo_realm_id, BOOKS_A);
  assertEquals(billed, [
    "10x16 Barn → 41",
    ...CHORE_LINES.slice(1, -1).map((l) => `${l.name} → ${OPTIONS}`),
    `Delivery → ${OPTIONS} [NON]`,
  ]);
});

Deno.test("line kinds: save_item_map takes the eleven rows the grid posts, each stamped with the company", async () => {
  const db = choreWorld(liveShapedMaps(BOOKS_A));
  const r = await call(db, { action: "save_item_map", rows: choreRows() });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  // The grid's banner reads "Mappings updated (11 saved)." from exactly these three.
  assertEquals([r.body.saved, r.body.deleted, r.body.skipped], [11, 0, []]);
  const rows = db.rows("qbo_item_map").filter((m) => m.client_id === TENANT);
  assertEquals(rows.length, 32, "the live read-back after the chore is 32 rows");
  assertEquals(rows.filter((m) => m.realm_id !== BOOKS_A), [], "a saved row is not stamped with the company");
  for (const k of CHORE_KINDS) assert(rows.some((m) => m.line_kind === k && m.item_key === "" && m.qbo_item_id === OPTIONS), `${k} was not saved`);
  for (const k of CHORE_LAYOUT) assert(rows.some((m) => m.line_kind === "layout_item" && m.item_key === k && m.qbo_item_id === OPTIONS), `${k} was not saved`);
  assert(!rows.some((m) => m.line_kind === "delivery"), "delivery is left on the Fallback");
  // What the owner then sees: the grid reads all 32 back, every chore row under its own label.
  const list = await call(db, { action: "list_item_map" });
  assertEquals(list.body.mappings.length, 32);
  const labels = Object.fromEntries(list.body.layoutItems.map((li: Row) => [li.item_key, li.label]));
  assertEquals(CHORE_LAYOUT.map((k) => labels[k]), ["Single Shelf", "Double Shelf", "Rough Opening (Door)", "Rough Opening (Window)"]);
  assertEquals((await call(db, { action: "qbo_status" })).body.mappedCount, 32);
});

Deno.test("line kinds: after the chore each line bills from its own row; delivery still takes the Fallback, non-taxable", async () => {
  const db = choreWorld(liveShapedMaps(BOOKS_A));
  // A DIFFERENT made-up item per row, so a line that reached its own row cannot pass for one that
  // fell through to the Fallback (the real chore maps all eleven to the Fallback's own item).
  const slots: string[] = [...CHORE_KINDS, ...CHORE_LAYOUT];
  const own = (kind: string, key: string) => String(100 + slots.indexOf(key || kind));
  const saved = await call(db, { action: "save_item_map", rows: choreRows(own) });
  assertEquals([saved.body.saved, saved.body.skipped], [11, []]);
  const { row, billed } = await pushChore(db, { calls: [], automatedSalesTax: false });
  assertEquals(row.qbo_error, null, "a clean push");
  assertEquals(billed, [
    "10x16 Barn → 41",
    ...CHORE_LINES.slice(1, 12).map((l) => `${l.name} → ${own(l.kind, l.itemKey)}`),
    `Loft → ${OPTIONS}`,
    `Delivery → ${OPTIONS} [NON]`,
  ]);
});

Deno.test("line kinds: a row saved with no company is ignored, and its line falls to the stamped Fallback", async () => {
  // The window the deploy order guards: the chore run through the OLD save_item_map after migration
  // 265's backfill, before the new portal-settings. The rows land unstamped; nothing aborts, the
  // lines bill as the Fallback (the very item the chore picks), and re-running 265's backfill
  // UPDATE stamps them.
  const unstamped = choreRows(() => "99").map((r) => map(TENANT, r.lineKind, r.qboItemId, null, { item_key: r.itemKey }));
  const db = choreWorld([...liveShapedMaps(BOOKS_A), ...unstamped]);
  const { row, billed } = await pushChore(db, { calls: [] });
  assertEquals(row.qbo_error, null, "an unstamped chore row aborted the push");
  assertEquals(billed, [
    "10x16 Barn → 41",
    ...CHORE_LINES.slice(1, -1).map((l) => `${l.name} → ${OPTIONS}`),
    `Delivery → ${OPTIONS}`,   // Automated Sales Tax on: no line-level code at all
  ]);
  // And the grid shows them as not mapped, which is what the push did with them.
  assertEquals((await call(db, { action: "list_item_map" })).body.mappings.length, 21);
});
