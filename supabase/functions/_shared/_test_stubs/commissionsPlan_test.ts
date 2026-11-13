// portal-commissions OBEYS A COMPANY'S TAB MAP (plans as data, stage D), driven through the SHIPPED
// handler.
//
// The function signs its own callers in, so it never passes through resolveTenant and stage C's plan
// check never covered it: a company whose map has no Commissions tab could still run its ledger with
// a hand-made request. Its handler now asks _shared/accessCheck.ts, with two lists saying which
// actions are the ledger (tab `commissions`) and which are the Team screen (every account's, no tab).
// A wrong list is a company refused its own team page, or a ledger left open, so this file pins:
//
//   1. every `case` in the handler's switch is on exactly one of the two lists, and neither list
//      names an action the switch has not got: adding an action without deciding fails the push;
//   2. block: a ledger action is 403 module_off before anything is read for it; a Team action is
//      never refused and never reads the map; "locked" is not "on";
//   3. report: nothing is refused, and one info row is filed per action;
//   4. not named, a failed read, a malformed answer: exactly the answer from before;
//   5. the function's own refusals still come first, in their own words;
//   6. it does not declare a `GATES: GateTable`, which would enrol it in preflight's cross-check.
//
// HOW. The accessEnforce_test idiom: Deno.serve is stubbed while index.ts is imported, and the
// import map swaps supabase-js for supabase_stub.ts. Tenants and people are made up (public repo).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubPlanRead, stubRpc } from "./supabase_stub.ts";
import { MODULE_REFUSAL } from "../accessEnforce.ts";

const SRC = (await Deno.readTextFile(new URL("../../portal-commissions/index.ts", import.meta.url))).replace(/\r\n/g, "\n");

// ── 1. the two lists against the switch ─────────────────────────────────────────────────────
const listOf = (name: string): string[] => {
  const m = new RegExp(`const ${name}: ReadonlySet<string> = new Set\\(\\[([^\\]]*)\\]\\);`).exec(SRC);
  assert(m, `portal-commissions no longer declares ${name} as a Set of action names. Re-point this test.`);
  return [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
};
const LEDGER = listOf("LEDGER_ACTIONS");
const TEAM = listOf("TEAM_ACTIONS");
const switchBody = (() => {
  const a = SRC.indexOf("switch (action) {");
  const b = SRC.indexOf("default:\n        return json({ error: `Unknown action: ${action}` }, 400);", a);
  assert(a > 0 && b > a, "the handler's switch on the action was not found. Re-point this test.");
  return SRC.slice(a, b);
})();
// Top-level cases only: the handler's own are indented six spaces (an inner switch would be deeper).
const CASES = [...switchBody.matchAll(/^ {6}case "([a-z_]+)":/gm)].map((m) => m[1]);

Deno.test("every action in the switch is on exactly one of the two lists, and neither list is stale", () => {
  assert(CASES.length >= 21, `only ${CASES.length} cases read: ${CASES.join(", ")}`);
  assertEquals(new Set(CASES).size, CASES.length, "an action has two cases");
  for (const a of CASES) {
    const n = (LEDGER.includes(a) ? 1 : 0) + (TEAM.includes(a) ? 1 : 0);
    assertEquals(n, 1, `"${a}" is on ${n} of LEDGER_ACTIONS / TEAM_ACTIONS: decide whether it is the Commissions tab or the Team screen`);
  }
  assertEquals([...LEDGER, ...TEAM].filter((a) => !CASES.includes(a)), [], "a list names an action the switch no longer has");
  assertEquals(new Set([...LEDGER, ...TEAM]).size, LEDGER.length + TEAM.length, "an action is listed twice");
});

Deno.test("the ledger is the Commissions tab; the Team screen is every account's", () => {
  assertEquals([...LEDGER].sort(), [
    "adjust_amount", "approve_period", "assign_earner", "cancel_order", "clawback", "compute", "delete_entry", "list_entries",
    "mark_paid", "reset_order", "set_excluded", "split_entry", "split_order", "unapprove_period",
  ]);
  assertEquals([...TEAM].sort(), ["add_user", "list", "remove_user", "set_access", "set_grants", "set_home_location", "set_rate"]);
});

Deno.test("the check comes after the function's own refusals and before the switch, and it is not a gate table", () => {
  const target = SRC.indexOf("Commissions are per-builder and cannot be changed on another account's behalf.");
  const check = SRC.indexOf('if (await moduleVerdict(admin, clientId, "portal-commissions", String(action ?? ""), tabsForAction(action), req) === "refuse") {');
  const refusal = SRC.indexOf('return json({ error: MODULE_REFUSAL, code: "module_off" }, 403);');
  const sw = SRC.indexOf("switch (action) {");
  assert(target > 0 && check > target && refusal > check && sw > refusal, "the plan check moved: it must sit after the targetClientId refusal and before the switch");
  // preflight's checkGateTable enrols any index.ts that declares this, and then demands a gate per case.
  assert(!/const GATES: GateTable/.test(SRC), "portal-commissions must not declare a GATES: GateTable");
});

// ── the real handler ────────────────────────────────────────────────────────────────────────
const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
async function load(): Promise<(req: Request) => Promise<Response>> {
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
  try {
    await import(new URL("../../portal-commissions/index.ts", import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
  if (!handler) throw new Error("portal-commissions did not hand Deno.serve a handler");
  return handler as (req: Request) => Promise<Response>;
}
const HANDLER = await load();

type World = { answer?: unknown; rpcError?: boolean; role?: string; access?: Record<string, string> | null };

/** A database that answers the handler's sign-in reads and gives every other table an empty, healthy
 *  answer: enough for `list_entries` to come back 200 with no lines. Every table touched is recorded. */
function chain(table: string, tenant: string, world: World, touched: string[], inserted: any[]): any {
  const q: any = {};
  let op = "select";
  let payload: unknown = null;
  touched.push(table);
  for (const m of ["select", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "not", "or", "limit", "order", "range"]) q[m] = () => q;
  q.insert = (row: unknown) => { op = "insert"; payload = row; return q; };
  const answer = (one: boolean) => {
    if (table === "client_users") {
      const me = { client_id: tenant, role: world.role ?? "owner", title: null, access: world.access ?? null, user_id: "00000000-0000-4000-8000-00000000c001", full_name: "Pat Builder" };
      return { data: one ? me : [me], error: null };
    }
    if (table === "app_errors" && op === "insert") inserted.push(payload);
    return { data: one ? null : [], error: null };
  };
  q.maybeSingle = () => Promise.resolve(answer(true));
  q.single = () => Promise.resolve(answer(true));
  q.then = (ok: any, bad: any) => Promise.resolve(answer(false)).then(ok, bad);
  return q;
}

async function call(tenant: string, action: string, world: World, extra: Record<string, unknown> = {}) {
  const touched: string[] = [];
  const inserted: any[] = [];
  const rpcCalls: string[] = [];
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const quiet = [console.error, console.warn, console.log];
  console.error = console.warn = console.log = () => {};
  stubAuth.user = { id: "00000000-0000-4000-8000-00000000c001", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(table, tenant, world, touched, inserted);
  stubPlanRead.on = true;
  stubRpc.rpc = (name: string) => {
    rpcCalls.push(name);
    if (name === "access_for_server") {
      if (world.rpcError) return Promise.resolve({ data: null, error: { code: "42883", message: "function does not exist" } });
      return Promise.resolve({ data: world.answer ?? null, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/portal-commissions", {
      method: "POST",
      headers: { "authorization": "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action, ...extra }),
    }));
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    const refusedByPlan = res.status === 403 && body && body.code === "module_off";
    return {
      status: res.status, body, refusedByPlan, touched,
      planReads: rpcCalls.filter((n) => n === "access_for_server").length,
      reports: inserted.filter((r) => r && r.code === "module_would_refuse"),
    };
  } finally {
    [console.error, console.warn, console.log] = quiet;
    stubDb.from = null;
    stubRpc.rpc = null;
    stubPlanRead.on = false;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

const NO_COMMISSIONS = { commissions: "hidden", designer: "on", orders: "on" };
const block = (modules: Record<string, string>) => ({ mode: "block", modules });
const report = (modules: Record<string, string>) => ({ mode: "report", modules });

// ── 2. block ────────────────────────────────────────────────────────────────────────────────
Deno.test("block: every ledger action is refused with module_off before anything is read for it", async () => {
  for (const action of LEDGER) {
    const r = await call("acme-sheds", action, { answer: block(NO_COMMISSIONS) });
    assertEquals([r.status, r.body.code, r.body.error], [403, "module_off", MODULE_REFUSAL], action);
    assertEquals(r.planReads, 1, action);
    // Only the sign-in reads ran: nothing of the ledger was read or written for a refused call.
    for (const t of r.touched) assert(["client_users", "client_settings", "commission_members"].includes(t), `${action} touched ${t} before it was refused`);
  }
});

Deno.test("block: with the Commissions tab on the ledger answers as before; locked is refused like hidden", async () => {
  const has = await call("acme-sheds", "list_entries", { answer: block({ ...NO_COMMISSIONS, commissions: "on" }) });
  assertEquals([has.status, has.body.ok, has.refusedByPlan], [200, true, false], JSON.stringify(has.body));
  const locked = await call("acme-sheds", "list_entries", { answer: block({ ...NO_COMMISSIONS, commissions: "locked" }) });
  assertEquals(locked.refusedByPlan, true);
});

Deno.test("block: the Team screen's actions are never refused by a plan, and never read the map", async () => {
  for (const action of TEAM) {
    const r = await call("acme-sheds", action, { answer: block(NO_COMMISSIONS) });
    assertEquals(r.refusedByPlan, false, `${action}: ${JSON.stringify(r.body)}`);
    assertEquals(r.planReads, 0, `${action} read the map though it has no tab`);
  }
  const list = await call("acme-sheds", "list", { answer: block(NO_COMMISSIONS) });
  assertEquals(list.status, 200, JSON.stringify(list.body));
});

Deno.test("block: an unknown action is still an unknown action, not a plan refusal", async () => {
  const r = await call("acme-sheds", "no_such_action", { answer: block(NO_COMMISSIONS) });
  assertEquals([r.status, r.refusedByPlan, r.planReads], [400, false, 0]);
  assert(String(r.body.error).startsWith("Unknown action"), r.body.error);
  const none = await call("acme-sheds", undefined as unknown as string, { answer: block(NO_COMMISSIONS) });
  assertEquals([none.status, none.refusedByPlan, none.planReads], [400, false, 0]);
});

// ── 3. report ───────────────────────────────────────────────────────────────────────────────
Deno.test("report: nothing is refused, and what would have been is filed once per action", async () => {
  const w = { answer: report(NO_COMMISSIONS) };
  const first = await call("report-sheds", "list_entries", w);
  assertEquals([first.status, first.body.ok, first.refusedByPlan], [200, true, false], JSON.stringify(first.body));
  assertEquals(first.reports.length, 1, JSON.stringify(first.reports));
  const row = first.reports[0];
  assertEquals([row.severity, row.source, row.client_id, row.code], ["info", "edge:portal-commissions", "report-sheds", "module_would_refuse"]);
  assertEquals(row.message, "Report only: list_entries would be refused (needs commissions).");
  assertEquals(row.context, { action: "list_entries", tabs: ["commissions"], states: { commissions: "hidden" } });
  const second = await call("report-sheds", "list_entries", w);
  assertEquals([second.status, second.reports.length], [200, 0], "the same action from the same isolate is not filed twice");
  const team = await call("report-sheds", "list", w);
  assertEquals([team.status, team.reports.length, team.planReads], [200, 0, 0]);
  const fine = await call("report-sheds-two", "list_entries", { answer: report({ ...NO_COMMISSIONS, commissions: "on" }) });
  assertEquals([fine.status, fine.reports.length], [200, 0]);
});

// ── 4. not named, or the database cannot answer ─────────────────────────────────────────────
Deno.test("not named, a failed read, a malformed answer: the answer from before, nothing refused, nothing filed", async () => {
  const before = await call("acme-sheds", "list_entries", { answer: null });
  assertEquals([before.status, before.body.ok], [200, true], JSON.stringify(before.body));
  for (const world of [
    { answer: null }, { rpcError: true }, { answer: { mode: "block", modules: {} } }, { answer: { mode: "blok", modules: NO_COMMISSIONS } },
    { answer: { modules: NO_COMMISSIONS } }, { answer: { mode: "block", modules: { commissions: "nope" } } },
  ] as World[]) {
    const r = await call("acme-sheds", "list_entries", world);
    assertEquals([r.refusedByPlan, r.status, r.reports.length], [false, 200, 0], JSON.stringify(world));
    assertEquals(JSON.stringify(r.body), JSON.stringify(before.body), JSON.stringify(world));
  }
});

// ── 5. the function's own refusals come first ───────────────────────────────────────────────
Deno.test("a call aimed at another account hears that refusal, and the map is never read for it", async () => {
  const r = await call("acme-sheds", "list_entries", { answer: block(NO_COMMISSIONS) }, { targetClientId: "someone-else" });
  assertEquals([r.status, r.refusedByPlan, r.planReads], [403, false, 0]);
  assert(String(r.body.error).includes("cannot be changed on another account's behalf"), r.body.error);
});

Deno.test("with the tab on, a person without the Commissions area is still refused in the function's own words", async () => {
  const r = await call("acme-sheds", "list_entries", { answer: block({ ...NO_COMMISSIONS, commissions: "on" }), role: "user", access: { commissions: "none" } });
  assertEquals([r.status, r.refusedByPlan], [403, false]);
  assertEquals(r.body.error, "You don't have access to commissions.");
});
