// Settings → Company → Payments (workstream 1 phase 4): portal-settings payments_status, driven through
// the SHIPPED handler.
//
// WHY THIS EXISTS. The card is read-only and the action is small, so every mistake worth pinning here
// is a quiet one:
//   1. the answer is on/off, "live"/"test", the merchant id's LAST FOUR and the brand, and never the
//      whole merchant id (it names the builder's bank account to anyone who can read Settings);
//   2. "on" means the charge path would take a card: switched on with no merchant id reads OFF;
//   3. it is gated settings_branding:view, the Company area: an owner, office staff and a granted
//      viewer read it; a sales rep (no Branding) is refused by resolveTenant before any read;
//   4. a database WITHOUT migration 296 reads as test (the tolerant read), a builder with no settings
//      row reads off, and any other read failure is the authored dbFail sentence, not a guess;
//   5. it writes nothing (no client_settings write of any kind).
//
// HOW. companyTaxWiring_test's idiom: Deno.serve is stubbed while portal-settings/index.ts is
// imported, so a request runs through withErrorLog, resolveTenant and the branch as it does live. The
// import map swaps supabase-js for supabase_stub.ts, whose stubDb routes every table call into the
// fake below. No --allow-net is granted, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test).
//
// Tenants, people and merchant ids are made up. The repo is public.

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
const HANDLER = await captureHandler("../../portal-settings/index.ts");

const T = "acme-sheds";
const PROJECT = "https://stub.supabase.co";
const ENV: Record<string, string> = { SUPABASE_URL: PROJECT, SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
const MID = "100200300400";

type World = {
  row?: Record<string, unknown> | null;
  no296?: boolean;
  readFails?: boolean;
  member?: { role: string; title: string | null; access: Record<string, string> | null };
};
type Trace = { reads: string[]; writes: string[]; errors: Record<string, unknown>[] };

function answer(world: World, trace: Trace, table: string, ops: any[][]) {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
  for (const op of ["insert", "update", "upsert", "delete"]) if (has(op) && table !== "admin_audit") trace.writes.push(`${op} ${table}`);
  if (table === "client_users") {
    const m = world.member ?? { role: "owner", title: null, access: null };
    return { data: [{ client_id: T, role: m.role, title: m.title, access: m.access, user_id: "u1", prefs: null }], error: null };
  }
  if (table === "client_settings") {
    const cols = String(arg("select") ?? "");
    trace.reads.push(cols);
    if (world.readFails) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    if (world.no296 && /\bcardpointe_env\b/.test(cols)) return { data: null, error: { code: "42703", message: "column client_settings.cardpointe_env does not exist" } };
    const row = world.row === undefined ? { payments_online_enabled: true, cardpointe_merchid: MID, cardpointe_env: "prod" } : world.row;
    if (!row) return { data: null, error: null };
    const out: Record<string, unknown> = {};
    for (const c of cols.split(",").map((s) => s.trim())) out[c] = row[c] ?? null;
    return { data: out, error: null };
  }
  return { data: has("maybeSingle") || has("single") ? null : [], error: null, count: 0 };
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle", "ilike"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    if (table === "app_errors") {
      trace.errors.push((ops.find((o) => o[0] === "insert") ?? [])[1]);
      return Promise.resolve({ error: null }).then(ok, bad);
    }
    return Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  };
  return q;
}

async function status(world: World = {}) {
  const trace: Trace = { reads: [], writes: [], errors: [] };
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action: "payments_status" }),
    }));
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text), trace };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("1. on, live, the last four and the brand, and never the whole merchant id", async () => {
  const r = await status();
  assertEquals(r.status, 200, r.text);
  assertEquals(r.body, { ok: true, enabled: true, env: "live", midLast4: "0400", credentialsOnFile: false, brand: "Structure Studio Payments" });
  assert(!r.text.includes(MID), `the whole MID went to the page: ${r.text}`);
  // Test mode reads "test", never the system's own name.
  const t = await status({ row: { payments_online_enabled: true, cardpointe_merchid: MID, cardpointe_env: "uat" } });
  assertEquals([t.body.enabled, t.body.env], [true, "test"], t.text);
  assert(!/uat|prod/i.test(t.text), t.text);
});

Deno.test("2. switched on with no merchant id reads OFF; switched off reads off with its last four", async () => {
  for (const mid of [null, "", "  "]) {
    const r = await status({ row: { payments_online_enabled: true, cardpointe_merchid: mid, cardpointe_env: "prod" } });
    assertEquals([r.status, r.body.enabled, r.body.midLast4], [200, false, null], r.text);
  }
  const off = await status({ row: { payments_online_enabled: false, cardpointe_merchid: MID, cardpointe_env: "uat" } });
  assertEquals([off.body.enabled, off.body.env, off.body.midLast4], [false, "test", "0400"], off.text);
});

Deno.test("3. gated settings_branding:view: owner, office staff and a granted viewer read it; a sales rep is refused before any read", async () => {
  for (const member of [
    { role: "owner", title: "owner", access: null },
    { role: "user", title: "office_staff", access: null },
    { role: "user", title: "sales_rep", access: { settings_branding: "view" } },
  ]) {
    const r = await status({ member });
    assertEquals(r.status, 200, `${member.title}: ${r.text}`);
  }
  const rep = await status({ member: { role: "user", title: "sales_rep", access: null } });
  assertEquals(rep.status, 403, rep.text);
  assertEquals(rep.trace.reads, [], "client_settings was read for a caller the gate refuses");
});

Deno.test("4. without 296 it reads as test; no settings row reads off; any other failure is the authored sentence", async () => {
  const old = await status({ no296: true, row: { payments_online_enabled: true, cardpointe_merchid: MID } });
  assertEquals(old.status, 200, old.text);
  assertEquals([old.body.enabled, old.body.env, old.body.midLast4], [true, "test", "0400"]);
  assertEquals(old.trace.reads.length, 2, "asked again without the column");
  const none = await status({ row: null });
  assertEquals([none.status, none.body.enabled, none.body.env, none.body.midLast4], [200, false, "test", null], none.text);
  const broken = await status({ readFails: true });
  assertEquals(broken.status, 500, broken.text);
  assert(/^Couldn't load your payment settings\./.test(broken.body.error), broken.text);
  assert(!("enabled" in broken.body), "a failed read must not answer a status");
});

Deno.test("5. it writes nothing", async () => {
  for (const world of [{}, { no296: true }, { row: null }] as World[]) {
    const r = await status(world);
    assertEquals(r.trace.writes, [], JSON.stringify(r.trace.writes));
  }
});
