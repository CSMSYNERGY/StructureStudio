// set_color_prices and set_electrical_prices (Jack, 2026-11-10), driven through the SHIPPED portal-settings
// handler. save_colors and save_electrical_items save a whole list and delete what's left out; these two
// change only price columns, by id, inside the tenant.
//
// WHAT IS PINNED:
//   1. Only the price columns (and updated_at) are written, by update, scoped to the tenant AND the id.
//      Nothing is inserted, nothing deleted, no other table touched.
//   2. An expected price makes it a compare and set: the update carries the filter, and a row that no
//      longer matches comes back in notSaved while the others save.
//   3. Electrical: a blank is NULL ("not offered that way"), and an expected NULL is an `is` filter.
//      Colours: a blank is refused (both columns are NOT NULL).
//   4. Every row is checked before anything is written: a bad id, a bad price, a row with no price, the
//      same id twice, or more than 100 rows is a 400 with no write at all.
//
// HOW. portalSettingsPartitionWiring_test's idiom: Deno.serve is stubbed while portal-settings/index.ts is
// imported, the import map swaps supabase-js for supabase_stub.ts, and every table is answered from the
// fake below. Tenants and ids are made up; the repo is public.

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
const C1 = "00000000-0000-4000-8000-0000000c0001";
const C2 = "00000000-0000-4000-8000-0000000c0002";
const E1 = "00000000-0000-4000-8000-0000000e0001";
type World = { stale?: string[] };
type Write = { table: string; verb: string; row: any; ops: any[][] };
const has = (ops: any[][], op: string) => ops.some((o) => o[0] === op);
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);
const eqOf = (ops: any[][], col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];

function answer(world: World, writes: Write[], table: string, ops: any[][]): any {
  const verb = ["insert", "update", "upsert", "delete"].find((v) => has(ops, v));
  if (verb && table !== "admin_audit" && table !== "app_errors") {
    writes.push({ table, verb, row: argOf(ops, verb)[0], ops });
    const id = eqOf(ops, "id");
    // A compare and set whose row moved on matches nothing.
    if ((world.stale ?? []).includes(id)) return { data: [], error: null };
    return { data: has(ops, "select") ? [{ id }] : null, error: null };
  }
  const one = has(ops, "single") || has(ops, "maybeSingle");
  const rows = (r: any[]) => ({ data: one ? (r[0] ?? null) : r, error: null });
  switch (table) {
    case "client_users": return rows([{ client_id: OWN, role: "owner", title: "owner", access: null, user_id: USER_ID, location_id: null, prefs: null }]);
    case "client_configs": return rows([{ client_id: OWN }]);
    default: return rows([]);
  }
}
function chain(world: World, writes: Write[], table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, writes, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "not", "or", "limit", "order", "single", "maybeSingle", "range"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => answer(world, writes, table, ops)).then(ok, bad);
  return q;
}

const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
async function call(body: Record<string, unknown>, world: World = {}) {
  const writes: Write[] = [];
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, writes, table, []);
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
    return { status: res.status, body: await res.json(), writes };
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
const without = (row: Record<string, unknown>, k: string) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== k));

Deno.test("set_color_prices writes only the two price columns, by update, scoped to the tenant and the id", async () => {
  const r = await call({ action: "set_color_prices", rows: [{ id: C1, rate: 50, expectRate: 0 }, { id: C2, doorRate: "75", expectDoorRate: 60 }] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body, { ok: true, saved: 2, savedIds: [C1, C2], notSaved: [] });
  assertEquals(r.writes.map((w) => [w.table, w.verb]), [["colors", "update"], ["colors", "update"]]);
  const [a, b] = r.writes;
  assertEquals(without(a.row, "updated_at"), { rate: 50 });
  assertEquals(without(b.row, "updated_at"), { door_rate: 75 });
  for (const w of r.writes) {
    assert(typeof w.row.updated_at === "string");
    assertEquals(eqOf(w.ops, "client_id"), OWN);
  }
  assertEquals([eqOf(a.ops, "id"), eqOf(a.ops, "rate")], [C1, 0]);
  assertEquals([eqOf(b.ops, "id"), eqOf(b.ops, "door_rate")], [C2, 60]);
});

Deno.test("a price that moved since is left alone and named; the rest save", async () => {
  const r = await call({ action: "set_color_prices", rows: [{ id: C1, rate: 50, expectRate: 0 }, { id: C2, rate: 40, expectRate: 10 }] }, { stale: [C2] });
  assertEquals(r.status, 200);
  assertEquals(r.body, { ok: true, saved: 1, savedIds: [C1], notSaved: [C2] });
});

Deno.test("set_electrical_prices: a blank is not offered (NULL), and an expected NULL is an is-filter", async () => {
  const r = await call({ action: "set_electrical_prices", rows: [{ id: E1, priceWithPackage: "", expectWithPackage: 30, priceStandalone: 95, expectStandalone: null }] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.writes.length, 1);
  const w = r.writes[0];
  assertEquals([w.table, w.verb], ["electrical_items", "update"]);
  assertEquals(without(w.row, "updated_at"), { price_with_package: null, price_standalone: 95 });
  assertEquals(eqOf(w.ops, "client_id"), OWN);
  assertEquals(eqOf(w.ops, "price_with_package"), 30);
  assert(w.ops.some((o) => o[0] === "is" && o[1] === "price_standalone" && o[2] === null));
});

Deno.test("anything wrong in any row is a 400 before a single write", async () => {
  const bad: [string, Record<string, unknown>][] = [
    ["set_color_prices", { rows: [] }],
    ["set_color_prices", { rows: [{ id: "c1", rate: 5 }] }],
    ["set_color_prices", { rows: [{ id: C1, rate: "" }] }],
    ["set_color_prices", { rows: [{ id: C1, rate: 5 }, { id: C2, rate: -1 }] }],
    ["set_color_prices", { rows: [{ id: C1, rate: 5 }, { id: C1, doorRate: 5 }] }],
    ["set_color_prices", { rows: [{ id: C1, label: "Red" }] }],
    ["set_color_prices", { rows: [{ id: C1, rate: 5, expectRate: "abc" }] }],
    ["set_electrical_prices", { rows: [{ id: E1, priceStandalone: "ten" }] }],
    ["set_electrical_prices", { rows: Array.from({ length: 101 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, priceStandalone: 1 })) }],
  ];
  for (const [action, body] of bad) {
    const r = await call({ action, ...body });
    assertEquals(r.status, 400, `${action} ${JSON.stringify(body).slice(0, 80)} -> ${JSON.stringify(r.body)}`);
    assertEquals(r.writes.length, 0, `${action}: nothing may be written`);
  }
});

Deno.test("no other column can ride along: names, flags and sort order are ignored", async () => {
  const r = await call({ action: "set_color_prices", rows: [{ id: C1, rate: 5, label: "Renamed", active: false, siding: false, code: "ZZ", sortOrder: 9 }] });
  assertEquals(r.status, 200);
  assertEquals(Object.keys(r.writes[0].row).sort(), ["rate", "updated_at"]);
  const e = await call({ action: "set_electrical_prices", rows: [{ id: E1, priceStandalone: 5, name: "Renamed", active: false, mount: "ceiling" }] });
  assertEquals(e.status, 200);
  assertEquals(Object.keys(e.writes[0].row).sort(), ["price_standalone", "updated_at"]);
});
