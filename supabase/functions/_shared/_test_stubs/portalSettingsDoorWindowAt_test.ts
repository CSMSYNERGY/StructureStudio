// Where in a door a window goes (fixture_items.door_window_at, 2026-10-21: the TRANSOM), driven
// through the SHIPPED portal-settings handler.
//
// WHAT IS PINNED:
//   1. The catalog read selects door_window_at beside in_door (the migration is applied first).
//   2. save_fixture writes it as the column's check allows: 'top' only on a window that goes in a
//      door; a window sent "not in a door" is reset to 'panel' in the same write (so unticking it
//      can never trip the check); anything but the exact "top" is 'panel'; a door, ramp or vent is
//      always 'panel'; a new line with neither key is 'panel'.
//   3. "As a transom" with no inDoor key beside it means the window goes in doors (the catalog asks
//      both in one select).
//   4. Presence-guarded: an older portal or a sheet that sends neither key leaves the stored position
//      alone, on a save and on an import.
//
// HOW. portalSettingsPartitionWiring_test's idiom: Deno.serve is stubbed while portal-settings/index.ts
// is imported, the import map swaps supabase-js for supabase_stub.ts, and every table is answered from
// the fake below. No --allow-net. Tenants and users are made up; the repo is public.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";

const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-settings did not hand Deno.serve a handler");
const SETTINGS = handler as (req: Request) => Promise<Response>;

const OWN = "acme-sheds";
const USER_ID = "00000000-0000-4000-8000-0000000000b9";
const WIN_ID = "00000000-0000-4000-8000-0000000000a2";
type Trace = { writes: { table: string; verb: string; row: any; ops: any[][] }[]; reads: { table: string; ops: any[][] }[] };
const has = (ops: any[][], op: string) => ops.some((o) => o[0] === op);
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);
const eqOf = (ops: any[][], col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];

function answer(trace: Trace, table: string, ops: any[][]): any {
  const verb = ["insert", "update", "upsert", "delete"].find((v) => has(ops, v));
  if (verb && table !== "admin_audit" && table !== "app_errors") {
    trace.writes.push({ table, verb, row: argOf(ops, verb)[0], ops });
    return { data: has(ops, "select") ? { id: eqOf(ops, "id") ?? "00000000-0000-4000-8000-00000000c0de" } : null, error: null, count: 1 };
  }
  trace.reads.push({ table, ops });
  const one = has(ops, "single") || has(ops, "maybeSingle");
  const rows = (r: any[]) => ({ data: one ? (r[0] ?? null) : r, error: null });
  switch (table) {
    case "client_users": return rows([{ client_id: OWN, role: "owner", title: "owner", access: null, user_id: USER_ID, location_id: null, prefs: null }]);
    case "app_operators": return rows([]);
    case "client_configs": return rows([{ client_id: OWN }]);
    case "admin_audit": case "app_errors": return { data: null, error: null };
    case "fixture_items": return rows(has(ops, "eq") && eqOf(ops, "category") === "window" ? [{ id: WIN_ID, sort_order: 0 }] : []);
    default: return rows([]);
  }
}
function chain(trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "not", "or", "limit", "order", "single", "maybeSingle", "range"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => answer(trace, table, ops)).then(ok, bad);
  return q;
}

const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
async function call(body: Record<string, unknown>) {
  const trace: Trace = { writes: [], reads: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(trace, table, []);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`TEST FAILURE: unexpected fetch to ${url}`));
  }) as typeof fetch;
  try {
    const res = await SETTINGS(new Request("https://stub.supabase.co/functions/v1/portal-settings", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(body),
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
const written = (t: Trace, verb: string) => t.writes.filter((w) => w.table === "fixture_items" && w.verb === verb).map((w) => w.row);
const LINE = { name: "Transom Windows", widthIn: 29, heightIn: 10, price: "81" };
/** What save_fixture writes for one new line: [in_door, door_window_at]. */
async function insertOf(category: string, extra: Record<string, unknown>) {
  const r = await call({ action: "save_fixture", category, ...LINE, ...extra });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const row = written(r.trace, "insert")[0];
  return [row.in_door, row.door_window_at];
}

Deno.test("the catalog read selects door_window_at beside in_door", async () => {
  const r = await call({ action: "catalog" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const sel = r.trace.reads.filter((x) => x.table === "fixture_items").map((x) => String(argOf(x.ops, "select")[0] ?? ""));
  assert(sel.some((s) => /\bin_door, door_window_at,/.test(s)), JSON.stringify(sel));
});

Deno.test("save_fixture: a transom is stored only on a window that goes in a door", async () => {
  assertEquals(await insertOf("window", { inDoor: true, doorWindowAt: "top" }), [true, "top"]);
  assertEquals(await insertOf("window", { inDoor: true, doorWindowAt: "panel" }), [true, "panel"]);
  assertEquals(await insertOf("window", { inDoor: false, doorWindowAt: "top" }), [false, "panel"], "an explicit 'not in a door' wins");
  assertEquals(await insertOf("window", { inDoor: true, doorWindowAt: "TOP" }), [true, "panel"], "anything but the exact 'top' is the panel");
  assertEquals(await insertOf("window", { inDoor: true, doorWindowAt: "side" }), [true, "panel"]);
  assertEquals(await insertOf("window", {}), [false, "panel"], "a new line with neither key: the column's defaults");
  assertEquals(await insertOf("window", { doorWindowAt: "top" }), [true, "top"], "'as a transom' alone means in a door");
  for (const c of ["door", "ramp", "vent"]) assertEquals(await insertOf(c, { inDoor: true, doorWindowAt: "top" }), [false, "panel"], c);
});

Deno.test("save_fixture on a saved line: unticking resets the position in the same write; sending neither key leaves it alone", async () => {
  const off = await call({ action: "save_fixture", category: "window", id: WIN_ID, ...LINE, inDoor: false });
  assertEquals(written(off.trace, "update").map((r) => [r.in_door, r.door_window_at]), [[false, "panel"]]);
  const tick = await call({ action: "save_fixture", category: "window", id: WIN_ID, ...LINE, inDoor: true });
  const row = written(tick.trace, "update")[0];
  assertEquals(row.in_door, true);
  assert(!("door_window_at" in row), "an older portal's save (inDoor only) leaves a stored transom a transom");
  const neither = await call({ action: "save_fixture", category: "window", id: WIN_ID, ...LINE });
  assert(!("door_window_at" in written(neither.trace, "update")[0]) && !("in_door" in written(neither.trace, "update")[0]));
});

Deno.test("import_fixtures: a sheet without the columns leaves the position alone; one with them writes it", async () => {
  const r = await call({ action: "import_fixtures", category: "window", rows: [
    { id: WIN_ID, ...LINE },
    { ...LINE, name: "New transom", inDoor: true, doorWindowAt: "top" },
  ] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const up = written(r.trace, "update")[0], ins = written(r.trace, "insert").flat()[0];
  assert(up && !("door_window_at" in up), JSON.stringify(up));
  assertEquals([ins.in_door, ins.door_window_at], [true, "top"]);
});
