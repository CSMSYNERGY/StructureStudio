// A small in-memory database and storage for the door-look wiring tests (doorLookSaveWiring_test.ts,
// doorLookActionsWiring_test.ts), which drive the SHIPPED portal-settings handler. Same idiom as
// portalSettingsDoorWindowAt_test: Deno.serve is stubbed while portal-settings/index.ts is imported,
// the import map swaps supabase-js for supabase_stub.ts (the real _shared/doorLook.ts loads, since P1 is
// merged), and every table is answered from here. No --allow-net. Tenants and users are made up; the repo is
// public.
//
// Unlike that test's fake, this one FILTERS (eq, neq, in, not is null) and keeps state across the calls
// of one test, because the door-look rules are about which builder's row a read finds. Tables a test
// does not seed read as empty. A "database without 343" is modelled by naming its columns and tables
// as missing: a select or write that names one answers 42703 / 42P01 / PGRST204, as PostgREST does.

// deno-lint-ignore-file no-explicit-any
import { stubAuth, stubDb, stubRpc, stubStorage } from "./supabase_stub.ts";

export type Row = Record<string, any>;
export type Write = { table: string; verb: string; row: any; filters: any[][] };

export const OWN = "acme-sheds";
export const OTHER = "bravo-barns";
export const USER_ID = "00000000-0000-4000-8000-0000000000b9";

/** Tables resolveTenant reads: answered as the owner of OWN whatever the filters say. */
const FIXED: Record<string, Row[]> = {
  client_users: [{ client_id: OWN, role: "owner", title: "owner", access: null, user_id: USER_ID, location_id: null, prefs: null }],
  app_operators: [],
  client_configs: [{ client_id: OWN }],
};
const DEFAULTS: Record<string, () => Row> = {
  door_looks: () => ({ status: "draft", spec_version: 1, version: 1, thumb_url: null, ai_call_id: null, created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  ai_door_calls: () => ({ status: "running", created_at: new Date().toISOString(), self_check_round: 0, self_check_rounds: null, tokens: null }),
};

export class FakeDb {
  tables: Record<string, Row[]> = {};
  writes: Write[] = [];
  reads: { table: string; cols: string; filters: any[][] }[] = [];
  storage: { bucket: string; op: string; path: string }[] = [];
  missingColumns = new Set<string>();   // "table.column"
  missingTables = new Set<string>();
  failing = new Set<string>();          // "table" or "table.select" / "table.update": a generic error
  // The door press (P4): app_errors rows filed, objects in storage ("bucket/path" -> bytes), and the
  // wallet's database functions, answered by `rpcAnswer` (default: the meter is inactive).
  errors: Row[] = [];
  files: Record<string, Uint8Array> = {};
  rpcCalls: { fn: string; args: any }[] = [];
  rpcAnswer: (fn: string, args: any) => { data: any; error: any } = (fn) =>
    fn === "wallet_hold" ? { data: { hold_id: null, price_cents: 0, balance_after: null, err: "meter_inactive" }, error: null } : { data: null, error: null };
  // Called after each insert lands (a test's stand-in for another request racing this one).
  afterInsert: ((table: string, row: Row) => void) | null = null;
  rpc(fn: string, args: any) {
    this.rpcCalls.push({ fn, args });
    this.writes.push({ table: `rpc:${fn}`, verb: "rpc", row: args, filters: [] });
    const answer = () => Promise.resolve().then(() => this.rpcAnswer(fn, args));
    return { maybeSingle: answer, single: answer, then: (ok: any, bad: any) => answer().then(ok, bad) };
  }
  errorCodes() { return this.errors.map((e) => e.code); }
  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables[t] = rows.map((r) => ({ ...r }));
  }
  rows(table: string): Row[] { return (this.tables[table] ??= []); }
  writesTo(table: string, verb?: string) { return this.writes.filter((w) => w.table === table && (!verb || w.verb === verb)); }
  readsOf(table: string) { return this.reads.filter((r) => r.table === table); }
  from(table: string) { return new Query(this, table); }
}

class Query {
  verb: "select" | "insert" | "update" | "delete" | null = null;
  cols = "*";
  after: string | null = null;
  payload: any = null;
  wantCount = false;
  filters: any[][] = [];
  one: "single" | "maybe" | null = null;
  lim: number | null = null;
  constructor(private db: FakeDb, private table: string) {}
  select(cols = "*") { if (this.verb === null) { this.verb = "select"; this.cols = cols; } else this.after = cols; return this; }
  insert(row: any) { this.verb = "insert"; this.payload = row; return this; }
  update(patch: any, opts?: { count?: string }) { this.verb = "update"; this.payload = patch; this.wantCount = !!opts?.count; return this; }
  upsert(row: any) { this.verb = "insert"; this.payload = row; return this; }
  delete(opts?: { count?: string }) { this.verb = "delete"; this.wantCount = !!opts?.count; return this; }
  eq(c: string, v: unknown) { this.filters.push(["eq", c, v]); return this; }
  neq(c: string, v: unknown) { this.filters.push(["neq", c, v]); return this; }
  in(c: string, v: unknown[]) { this.filters.push(["in", c, v]); return this; }
  is(c: string, v: unknown) { this.filters.push(["is", c, v]); return this; }
  not(c: string, op: string, v: unknown) { this.filters.push(["not", c, op, v]); return this; }
  gt(c: string, v: unknown) { this.filters.push(["gt", c, v]); return this; }
  gte(c: string, v: unknown) { this.filters.push(["gte", c, v]); return this; }
  lt(c: string, v: unknown) { this.filters.push(["lt", c, v]); return this; }
  lte(c: string, v: unknown) { this.filters.push(["lte", c, v]); return this; }
  or() { return this; } range() { return this; }
  orders: [string, boolean][] = [];
  order(c: string, o?: { ascending?: boolean }) { this.orders.push([c, o?.ascending !== false]); return this; }
  limit(n: number) { this.lim = n; return this; }
  single() { this.one = "single"; return this; }
  maybeSingle() { this.one = "maybe"; return this; }
  then(ok: any, bad: any) { return Promise.resolve().then(() => this.run()).then(ok, bad); }

  private match(r: Row) {
    return this.filters.every((f) => {
      const [op, c, v] = f;
      if (op === "eq") return String(r[c]) === String(v);
      if (op === "neq") return String(r[c]) !== String(v);
      if (op === "in") return (v as unknown[]).map(String).includes(String(r[c]));
      if (op === "is") return v === null ? r[c] == null : r[c] === v;
      if (op === "not") return f[2] === "is" && f[3] === null ? r[c] != null : true;
      // Timestamps compare as ISO strings, numbers as numbers; a row without the column never matches.
      if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
        if (r[c] === undefined || r[c] === null) return false;
        const a = typeof v === "number" ? Number(r[c]) : String(r[c]), b = typeof v === "number" ? v : String(v);
        return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
      }
      return true;
    });
  }
  private named(cols: string | null, payload?: any): string | null {
    const names = new Set<string>();
    for (const c of String(cols ?? "").split(",").map((s) => s.trim()).filter(Boolean)) names.add(c);
    for (const f of this.filters) names.add(f[1]);
    if (payload && typeof payload === "object") for (const k of Object.keys(Array.isArray(payload) ? payload[0] ?? {} : payload)) names.add(k);
    for (const n of names) if (this.db.missingColumns.has(`${this.table}.${n}`)) return n;
    return null;
  }
  private run(): any {
    const db = this.db, t = this.table;
    if (t === "app_errors" && this.verb === "insert") db.errors.push(...(Array.isArray(this.payload) ? this.payload : [this.payload]));
    if (t === "app_errors" || t === "admin_audit") return { data: null, error: null };
    if (FIXED[t]) {
      const rows = FIXED[t];
      return { data: this.one ? rows[0] ?? null : rows, error: null };
    }
    if (db.missingTables.has(t)) return { data: null, error: { code: "42P01", message: `relation "public.${t}" does not exist` } };
    if (db.failing.has(t) || db.failing.has(`${t}.${this.verb}`) || db.failing.has(`${t}.${this.verb}:${this.cols}`)) return { data: null, error: { code: "08006", message: "connection lost" } };
    const missing = this.named(this.verb === "select" ? this.cols : this.after, this.verb === "insert" || this.verb === "update" ? this.payload : undefined);
    if (missing) {
      const write = this.verb === "insert" || this.verb === "update";
      return { data: null, error: write ? { code: "PGRST204", message: `Could not find the '${missing}' column` } : { code: "42703", message: `column ${t}.${missing} does not exist` } };
    }
    const all = db.rows(t);
    // A plain column list is projected, as PostgREST does; "*" (and anything fancier) is not.
    const project = (r: Row): Row => {
      const names = this.cols.split(",").map((s) => s.trim());
      if (this.cols.trim() === "*" || names.some((n) => !/^[a-z_][a-z0-9_]*$/.test(n))) return { ...r };
      return Object.fromEntries(names.filter((n) => n in r).map((n) => [n, r[n]]));
    };
    if (this.verb === "select") {
      db.reads.push({ table: t, cols: this.cols, filters: this.filters });
      let rows = all.filter((r) => this.match(r));
      // Sorted as asked (stable; rows missing the column keep their order).
      if (this.orders.length) {
        rows = [...rows].sort((x, y) => {
          for (const [c, asc] of this.orders) {
            if (x[c] === undefined || y[c] === undefined || x[c] === y[c]) continue;
            return (x[c] < y[c] ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
      }
      rows = rows.map(project);
      if (this.lim !== null) rows = rows.slice(0, this.lim);
      if (this.one === "single" && rows.length !== 1) return { data: null, error: { code: "PGRST116", message: "not one row" } };
      return { data: this.one ? rows[0] ?? null : rows, error: null };
    }
    if (this.verb === "insert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const made = list.map((p: Row) => ({ id: crypto.randomUUID(), ...(DEFAULTS[t]?.() ?? {}), ...p }));
      for (const m of made) { all.push(m); db.writes.push({ table: t, verb: "insert", row: { ...this.payload }, filters: [] }); db.afterInsert?.(t, m); }
      if (this.after !== null) return { data: this.one ? { ...made[0] } : made.map((m: Row) => ({ ...m })), error: null };
      return { data: null, error: null };
    }
    if (this.verb === "update") {
      const hit = all.filter((r) => this.match(r));
      for (const r of hit) Object.assign(r, this.payload);
      db.writes.push({ table: t, verb: "update", row: { ...this.payload }, filters: this.filters });
      if (this.after !== null) {
        const out = hit.map((r) => ({ ...r }));
        return { data: this.one ? out[0] ?? null : out, error: null, count: hit.length };
      }
      return { data: null, error: null, count: hit.length };
    }
    if (this.verb === "delete") {
      const keep = all.filter((r) => !this.match(r));
      const n = all.length - keep.length;
      db.tables[t] = keep;
      db.writes.push({ table: t, verb: "delete", row: null, filters: this.filters });
      return { data: null, error: null, count: n };
    }
    return { data: null, error: null };
  }
}

const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
// ⚠️ COMPUTED SPECIFIER ON PURPOSE (see aiDraftStreamWiring_test): the module is loaded once per test
// process, after Deno.serve is stubbed.
await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-settings did not hand Deno.serve a handler");
const SETTINGS = handler as (req: Request) => Promise<Response>;

const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };

/** One POST to portal-settings as the owner of OWN, answered from `db`. `opts.env` adds to the stub
 *  environment for this call (DOOR_LOOK_AI_ENABLED, ANTHROPIC_API_KEY); `opts.fetch` answers the model's
 *  URL (any other fetch still fails the test). */
export async function call(
  db: FakeDb,
  body: Record<string, unknown>,
  opts: { env?: Record<string, string>; fetch?: (url: string, init: RequestInit) => Promise<Response>; raw?: boolean } = {},
): Promise<{ status: number; body: any; text?: string }> {
  const env = { ...ENV, ...(opts.env ?? {}) };
  const savedEnv = Object.fromEntries([...Object.keys(env), "DOOR_LOOK_AI_ENABLED", "ANTHROPIC_API_KEY"].map((k) => [k, Deno.env.get(k)]));
  for (const k of ["DOOR_LOOK_AI_ENABLED", "ANTHROPIC_API_KEY"]) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => db.from(table);
  stubRpc.rpc = (fn: string, args?: any) => db.rpc(fn, args);
  stubStorage.from = (bucket: string) => ({
    download: (path: string) => {
      db.storage.push({ bucket, op: "download", path });
      const b = db.files[`${bucket}/${path}`];
      return Promise.resolve(b ? { data: new Blob([b as BlobPart]), error: null } : { data: null, error: { message: "Object not found" } });
    },
    createSignedUrl: (path: string, seconds: number) => {
      if (db.failing.has("storage:sign")) return Promise.reject(new Error("storage went away"));
      db.storage.push({ bucket, op: `sign-read-${seconds}`, path });
      return Promise.resolve({ data: { signedUrl: `https://stub.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=read` }, error: null });
    },
    createSignedUploadUrl: (path: string) => {
      db.storage.push({ bucket, op: "sign-upload", path });
      return Promise.resolve({ data: { path, token: `tok-${db.storage.length}`, signedUrl: `https://stub.supabase.co/storage/v1/object/upload/sign/${bucket}/${path}?token=tok` }, error: null });
    },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://stub.supabase.co/storage/v1/object/public/${bucket}/${path}` } }),
  });
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (opts.fetch && url === "https://api.anthropic.com/v1/messages") return opts.fetch(url, init ?? {});
    return Promise.reject(new Error(`TEST FAILURE: unexpected fetch to ${url}`));
  }) as typeof fetch;
  try {
    const res = await SETTINGS(new Request("https://stub.supabase.co/functions/v1/portal-settings", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: res.status, body: parsed, ...(opts.raw ? { text } : {}) };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubRpc.rpc = null;
    stubStorage.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}
