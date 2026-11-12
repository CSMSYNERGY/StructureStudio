// THE SERVER HALF OF PLANS AS DATA (_shared/accessEnforce.ts, migrations 386 to 388), and the one
// place it is enforced, driven through the SHIPPED portal-schedule and portal-settings handlers.
//
// For a company named in access_config.enforce.server_clients the edge functions refuse an action
// whose tab the company has not got. For one named in server_report they refuse nothing and write
// down what they would have refused. For everyone else, and whenever the database cannot answer,
// nothing changes. This file holds all three, and the paid-feature check's half:
//
//   1. the answer reader: anything that is not a clean { mode, modules } is null (the old rules);
//   2. block: an action on a tab the company lacks is 403 `module_off`; one on a tab it has, and
//      one with no tab at all, go through; "locked" is refused;
//   3. report: nothing is refused, and one info row per action is filed;
//   4. not named / failed read / malformed: exactly the old answer;
//   5. hasPaidFeature and usableFeatureSet answer by the map in block mode only.
//
// HOW. The phoneOnlyAccount_test idiom: Deno.serve is stubbed while a function's index.ts is
// imported, so a request goes through withErrorLog, resolveTenant and the real branches; the import
// map swaps supabase-js for supabase_stub.ts. Tenants are made up (public repo).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubPlanRead, stubRpc } from "./supabase_stub.ts";
import { anyModuleOn, firstReport, MODULE_REFUSAL, serverAccess, serverAccessFromAnswer, serverModules } from "../accessEnforce.ts";
import { hasPaidFeature, usableFeatureSet } from "../featureCheck.ts";

// ── 1. the answer reader ────────────────────────────────────────────────────────────────────
Deno.test("a clean answer comes back; anything else is null", () => {
  assertEquals(serverAccessFromAnswer({ mode: "block", modules: { contacts: "on", jack: "hidden" } }), { mode: "block", modules: { contacts: "on", jack: "hidden" } });
  assertEquals(serverAccessFromAnswer({ mode: "report", modules: { contacts: "locked" } }), { mode: "report", modules: { contacts: "locked" } });
  for (const bad of [
    null, undefined, "block", 7, [], {}, { mode: "block" }, { modules: { contacts: "on" } },
    { mode: "enforce", modules: { contacts: "on" } }, { mode: "block", modules: null }, { mode: "block", modules: [] },
    { mode: "block", modules: {} }, { mode: "block", modules: { contacts: "yes" } }, { mode: "block", modules: { contacts: true } },
    { mode: "block", modules: { "Customer Hub": "on" } }, { mode: "block", modules: { contacts: "on", jack: null } },
  ]) assertEquals(serverAccessFromAnswer(bad), null, JSON.stringify(bad));
});

Deno.test("serverAccess never throws; serverModules is the map in BLOCK mode only", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const ok = (a: unknown) => ({ rpc: () => Promise.resolve({ data: a, error: null }) });
    assertEquals(await serverAccess(ok({ mode: "block", modules: { contacts: "on" } }), "a"), { mode: "block", modules: { contacts: "on" } });
    assertEquals(await serverModules(ok({ mode: "block", modules: { contacts: "on" } }), "a"), { contacts: "on" });
    assertEquals(await serverModules(ok({ mode: "report", modules: { contacts: "on" } }), "a"), null);
    assertEquals(await serverAccess(ok(null), "a"), null);
    assertEquals(await serverAccess({ rpc: () => Promise.resolve({ data: null, error: { message: "no function" } }) }, "a"), null);
    assertEquals(await serverAccess({ rpc: () => { throw new Error("network"); } }, "a"), null);
    assertEquals(await serverAccess({ rpc: () => Promise.reject(new Error("timeout")) }, "a"), null);
    assertEquals(await serverAccess({}, "a"), null);
    assertEquals(await serverAccess(null, "a"), null);
    let asked = false;
    assertEquals(await serverAccess({ rpc: () => { asked = true; return Promise.resolve({ data: null, error: null }); } }, ""), null);
    assert(!asked, "an empty company id must not reach the database");
    const calls: unknown[] = [];
    await serverAccess({ rpc: (fn: string, args: unknown) => { calls.push([fn, args]); return Promise.resolve({ data: null, error: null }); } }, "acme-sheds");
    assertEquals(calls, [["access_for_server", { p_client_id: "acme-sheds" }]]);
  } finally {
    console.error = quiet;
  }
});

Deno.test("anyModuleOn: on is the only yes", () => {
  const m = { a: "on", b: "locked", c: "hidden", d: "off" };
  assertEquals(anyModuleOn(m, ["a"]), true);
  assertEquals(anyModuleOn(m, ["b", "c", "d", "missing"]), false);
  assertEquals(anyModuleOn(m, ["c", "a"]), true);
  assertEquals(anyModuleOn(m, []), false);
});

Deno.test("report mode files a would-be refusal once per company, function and action", () => {
  assertEquals(firstReport("co-one", "portal-schedule", "build_board"), true);
  assertEquals(firstReport("co-one", "portal-schedule", "build_board"), false);
  assertEquals(firstReport("co-one", "portal-schedule", "job_activity"), true);
  assertEquals(firstReport("co-two", "portal-schedule", "build_board"), true);
});

// ── the real handlers ───────────────────────────────────────────────────────────────────────
const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
async function load(fn: string): Promise<(req: Request) => Promise<Response>> {
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
  try {
    await import(new URL(`../../${fn}/index.ts`, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
  if (!handler) throw new Error(`${fn} did not hand Deno.serve a handler`);
  return handler as (req: Request) => Promise<Response>;
}
const SCHEDULE = await load("portal-schedule");

const TENANT = "harness-builder";
type World = { answer?: unknown; rpcError?: boolean; rpcMissing?: boolean };

/** A database that answers resolveTenant's own reads and then FAILS every other table with a marker,
 *  so "the request got past the gate" is visible as that marker instead of needing a whole schema. */
const PAST_THE_GATE = "harness: past the gate";
function chain(table: string, inserted: any[]): any {
  const q: any = {};
  let op = "select";
  let payload: unknown = null;
  for (const m of ["select", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "not", "or", "limit", "order", "range", "single", "maybeSingle", "contains", "ilike", "match"]) {
    q[m] = () => q;
  }
  q.insert = (row: unknown) => { op = "insert"; payload = row; return q; };
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => {
    if (table === "client_users") return { data: [{ client_id: TENANT, role: "owner", title: null, access: null }], error: null };
    if (table === "app_operators") return { data: null, error: null };
    if (table === "client_configs") return { data: { client_id: TENANT }, error: null };
    if (table === "client_settings") return { data: null, error: null };
    if (table === "app_errors") { if (op === "insert") inserted.push(payload); return { data: null, error: null }; }
    return { data: null, error: { code: "XX000", message: PAST_THE_GATE } };
  }).then(ok, bad);
  return q;
}

async function call(handler: (req: Request) => Promise<Response>, fn: string, action: string, world: World) {
  const inserted: any[] = [];
  const rpcCalls: string[] = [];
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const quiet = [console.error, console.warn, console.log];
  console.error = console.warn = console.log = () => {};
  stubAuth.user = { id: "00000000-0000-4000-8000-00000000f001", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(table, inserted);
  stubPlanRead.on = true;
  stubRpc.rpc = world.rpcMissing ? null : (name: string) => {
    rpcCalls.push(name);
    if (name === "access_for_server") {
      if (world.rpcError) return Promise.resolve({ data: null, error: { code: "42883", message: "function does not exist" } });
      return Promise.resolve({ data: world.answer ?? null, error: null });
    }
    return Promise.resolve({ data: null, error: { code: "XX000", message: PAST_THE_GATE } });
  };
  try {
    const res = await handler(new Request(`https://stub.supabase.co/functions/v1/${fn}`, {
      method: "POST",
      headers: { "authorization": "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action }),
    }));
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    // Report rows are written without awaiting: give them a turn of the loop.
    await new Promise((r) => setTimeout(r, 5));
    const refusedByPlan = res.status === 403 && body && body.code === "module_off";
    return { status: res.status, body, refusedByPlan, rpcCalls, reports: inserted.filter((r) => r && r.code === "module_would_refuse") };
  } finally {
    [console.error, console.warn, console.log] = quiet;
    stubDb.from = null;
    stubRpc.rpc = null;
    stubPlanRead.on = false;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

const ALL_HIDDEN = { build_schedule: "hidden", delivery_schedule: "hidden", repairs: "hidden", designer: "on", contacts: "on" };

// ── 2. block ────────────────────────────────────────────────────────────────────────────────
Deno.test("block: an action on a tab the company lacks is refused with module_off; one it has goes through", async () => {
  const lacks = await call(SCHEDULE, "portal-schedule", "build_board", { answer: { mode: "block", modules: ALL_HIDDEN } });
  assertEquals([lacks.status, lacks.body.code, lacks.body.error], [403, "module_off", MODULE_REFUSAL]);
  const has = await call(SCHEDULE, "portal-schedule", "build_board", { answer: { mode: "block", modules: { ...ALL_HIDDEN, build_schedule: "on" } } });
  assertEquals(has.refusedByPlan, false, JSON.stringify(has.body));
  assert(has.status !== 403, `past the plan check the handler should have run: ${has.status} ${JSON.stringify(has.body)}`);
});

Deno.test("block: locked is refused too, and an unknown action is still an unknown action", async () => {
  const lockedTab = await call(SCHEDULE, "portal-schedule", "build_board", { answer: { mode: "block", modules: { ...ALL_HIDDEN, build_schedule: "locked" } } });
  assertEquals(lockedTab.refusedByPlan, true);
  const unknown = await call(SCHEDULE, "portal-schedule", "no_such_action", { answer: { mode: "block", modules: ALL_HIDDEN } });
  assertEquals(unknown.refusedByPlan, false);
  assert(unknown.status === 400 || unknown.status === 403, String(unknown.status));
  assertEquals(unknown.rpcCalls.includes("access_for_server"), false, "an action with no gate must be refused before the map is ever read");
});

// ── 3. report ───────────────────────────────────────────────────────────────────────────────
Deno.test("report: nothing is refused, and what would have been is filed once as an info row", async () => {
  const w = { answer: { mode: "report", modules: ALL_HIDDEN } };
  const first = await call(SCHEDULE, "portal-schedule", "job_activity", w);
  assertEquals(first.refusedByPlan, false);
  assertEquals(first.reports.length, 1, JSON.stringify(first.reports));
  const row = first.reports[0];
  assertEquals([row.severity, row.source, row.client_id], ["info", "edge:portal-schedule", TENANT]);
  assert(String(row.message).includes("job_activity") && String(row.message).includes("build_schedule"), row.message);
  assertEquals(row.context.tabs, ["build_schedule"]);
  // The same action again from the same isolate: allowed again, not filed again.
  const second = await call(SCHEDULE, "portal-schedule", "job_activity", w);
  assertEquals([second.refusedByPlan, second.reports.length], [false, 0]);
  // A tab the company has is not reported at all.
  const fine = await call(SCHEDULE, "portal-schedule", "build_board", { answer: { mode: "report", modules: { ...ALL_HIDDEN, build_schedule: "on" } } });
  assertEquals(fine.reports.length, 0);
});

// ── 4. not named, or the database cannot answer ─────────────────────────────────────────────
Deno.test("not named, a failed read, a missing function, a malformed answer: the old rules, nothing refused, nothing filed", async () => {
  const before = await call(SCHEDULE, "portal-schedule", "build_board", { answer: null });
  for (const world of [
    { answer: null }, { rpcError: true }, { rpcMissing: true },
    { answer: { mode: "block", modules: {} } }, { answer: { mode: "blok", modules: ALL_HIDDEN } }, { answer: { modules: ALL_HIDDEN } },
    { answer: { mode: "block", modules: { build_schedule: "nope" } } },
  ] as World[]) {
    const r = await call(SCHEDULE, "portal-schedule", "build_board", world);
    assertEquals([r.refusedByPlan, r.status, r.reports.length], [false, before.status, 0], JSON.stringify(world));
  }
});

// ── 5. the paid-feature checks ──────────────────────────────────────────────────────────────
const billingAdmin = (rpcAnswer: unknown, settings: Record<string, unknown> | null = null) => ({
  rpc: () => Promise.resolve({ data: rpcAnswer, error: null }),
  from: (t: string) => {
    const q: any = {};
    for (const m of ["select", "eq", "in"]) q[m] = () => q;
    q.maybeSingle = () => Promise.resolve({ data: t === "client_settings" ? settings : null, error: null });
    q.then = (ok: any, bad: any) => Promise.resolve({ data: [], error: null }).then(ok, bad);
    return q;
  },
});

Deno.test("hasPaidFeature: by the map in block mode; by billing otherwise", async () => {
  const blockWith = (m: Record<string, string>) => billingAdmin({ mode: "block", modules: m });
  // A plan gives the contact list with no Customer Hub subscription: the feature check must not refuse it.
  assertEquals(await hasPaidFeature(blockWith({ contacts: "on" }), "co", "crm"), true);
  assertEquals(await hasPaidFeature(blockWith({ contacts: "locked", pipelines: "hidden" }), "co", "crm"), false);
  assertEquals(await hasPaidFeature(blockWith({ quickbooks: "on" }), "co", "quickbooks_sync"), true);
  assertEquals(await hasPaidFeature(blockWith({ rtp: "off" }), "co", "on_demand_pricing"), false);
  // On the map, Non-billable no longer answers for a tab the map says is off.
  assertEquals(await hasPaidFeature(billingAdmin({ mode: "block", modules: { rtp: "off" } }, { billing_exempt: true }), "co", "on_demand_pricing"), false);
  // Report mode and not named: billing decides, exactly as before (no subscriptions here = false; Non-billable = true).
  assertEquals(await hasPaidFeature(billingAdmin({ mode: "report", modules: { contacts: "on" } }), "co", "crm"), false);
  assertEquals(await hasPaidFeature(billingAdmin(null), "co", "crm"), false);
  assertEquals(await hasPaidFeature(billingAdmin(null, { billing_exempt: true }), "co", "crm"), true);
  // A feature with no tabs is never answered by the map.
  assertEquals(await hasPaidFeature(billingAdmin({ mode: "block", modules: { contacts: "on" } }, { internal_account: true }), "co", "smartbuild_sync"), true);
});

Deno.test("usableFeatureSet: mapped features by the map, the rest by billing, merged", async () => {
  const set = async (admin: unknown, f: string[]) => [...(await usableFeatureSet(admin, "co", f))].sort();
  const block = billingAdmin({ mode: "block", modules: { contacts: "on", quickbooks: "hidden", rtp: "on" } });
  assertEquals(await set(block, ["crm", "quickbooks_sync", "on_demand_pricing", "smartbuild_sync"]), ["crm", "on_demand_pricing"]);
  // Ours: the unmapped feature comes from billing's "everything", the mapped ones still from the map.
  const ours = billingAdmin({ mode: "block", modules: { contacts: "on", quickbooks: "hidden" } }, { internal_account: true });
  assertEquals(await set(ours, ["crm", "quickbooks_sync", "smartbuild_sync"]), ["crm", "smartbuild_sync"]);
  // Not named: unchanged.
  assertEquals(await set(billingAdmin(null, { billing_exempt: true }), ["crm", "quickbooks_sync"]), ["crm", "quickbooks_sync"]);
  assertEquals(await set(billingAdmin(null), ["crm"]), []);
});
