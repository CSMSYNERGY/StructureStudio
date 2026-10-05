// The partition wall's price, as Settings → Options → Interior items saves it (migration 278), driven
// through the SHIPPED portal-settings handler.
//
// WHAT IS PINNED:
//   1. The catalog read tells the card which items stay out of the customer's palette until priced
//      (hiddenUntilPriced), which is how the card knows to start their rate blank. An UNPRICED partition
//      wall is listed only for a read that asks (withUnpriced, which this portal sends on every catalog
//      read): production's portal from before 278 never sees one, so it never asks for a price.
//   2. Only the card that knows a partition wall (partitionAware) may price one. A body without the flag
//      never writes it, whatever the rate, and its message never asks for a price; a priced one that
//      card sends back unchanged is passed over quietly.
//   3. A partition wall with no price yet is only given one ABOVE $0, so a 0 typed for it cannot put it
//      on every customer's designer, free; everything else in the Save still saves.
//   4. A real price is saved, per foot; a partition already priced can be changed, to $0 included.
//   5. It is priced each, per foot or per square foot of wall: the other four methods are refused for it
//      and nothing else.
//   6. A pricing sheet's Partition Wall column (one exported before 278 has it) writes no inclusion: a
//      wall is never part of a size's price.
//
// HOW. advancedModeSwitch_test's idiom: Deno.serve is stubbed while portal-settings/index.ts is
// imported, the import map swaps supabase-js for supabase_stub.ts, and every table is answered from the
// fake below. No --allow-net. Tenants and users are made up; the repo is public.
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
const USER_ID = "00000000-0000-4000-8000-0000000000b8";
type World = { priced?: { item_key: string; rate: number }[] };
type Trace = { writes: { table: string; verb: string; row: any; ops: any[][] }[] };
const has = (ops: any[][], op: string) => ops.some((o) => o[0] === op);
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);
const eqOf = (ops: any[][], col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];

const TYPES = [
  { item_key: "workbench", label: "Workbench", wall_snap: true, depth_in: null, height_off_floor_in: 36, hidden_until_priced: false },
  { item_key: "shelf", label: "Single Shelf", wall_snap: true, depth_in: 12, height_off_floor_in: 48, hidden_until_priced: true },
  { item_key: "partitionWall", label: "Partition Wall", wall_snap: false, depth_in: null, height_off_floor_in: null, hidden_until_priced: true },
];
const CLI = TYPES.map((t, i) => ({ client_id: OWN, item_key: t.item_key, label_override: null, active: true, archived: false, internal_only: false, sort_order: i, taxable: true, depth_in: null, height_off_floor_in: null }));

function answer(world: World, trace: Trace, table: string, ops: any[][]): any {
  const verb = ["insert", "update", "upsert", "delete"].find((v) => has(ops, v));
  if (verb && table !== "admin_audit" && table !== "app_errors") {
    trace.writes.push({ table, verb, row: argOf(ops, verb)[0], ops });
    return { data: null, error: null };
  }
  const one = has(ops, "single") || has(ops, "maybeSingle");
  const rows = (r: any[]) => ({ data: one ? (r[0] ?? null) : r, error: null });
  switch (table) {
    case "client_users": return rows([{ client_id: OWN, role: "owner", title: "owner", access: null, user_id: USER_ID, location_id: null, prefs: null }]);
    case "app_operators": return rows([]);
    case "client_configs": return rows([{ client_id: OWN }]);
    case "admin_audit": case "app_errors": return { data: null, error: null };
    case "client_layout_items": return rows(CLI);
    case "layout_item_types": return rows(TYPES);
    case "building_styles": return rows([{ id: "st-1", key: "utility", label: "Utility" }]);
    case "building_sizes": return rows([{ id: "sz-1", style_id: "st-1", width_ft: 10, length_ft: 12, sort_order: 0 }]);
    case "layout_item_pricing": return rows((world.priced ?? [{ item_key: "shelf", rate: 18 }]).map((p, i) => ({ id: `lp-${i}`, item_key: p.item_key, pricing_method: "lineal_ft", rate: p.rate, image_url: null, style_id: null })));
    default: return rows([]);   // the rest of the catalog read: nothing on file
  }
}
function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "not", "or", "limit", "order", "single", "maybeSingle", "range"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  return q;
}

const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
async function call(body: Record<string, unknown>, world: World = {}) {
  const trace: Trace = { writes: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
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
const pricingWrites = (t: Trace) => t.writes.filter((w) => w.table === "layout_item_pricing");
// The card that ships with 278 sends partitionAware on every Save (03-catalog.jsx LayoutPricing.save).
const save = (rows: Record<string, unknown>[], world?: World) => call({ action: "save_layout_pricing", rows, partitionAware: true }, world);
// The card from before 278, still production's until the promotion.
const saveOld = (rows: Record<string, unknown>[], world?: World) => call({ action: "save_layout_pricing", rows }, world);

Deno.test("the catalog tells the card which items stay hidden until priced", async () => {
  const r = await call({ action: "catalog", withUnpriced: true });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.items.map((i: any) => [i.key, i.hiddenUntilPriced]));
  assertEquals(by, { workbench: false, shelf: true, partitionWall: true });
});

Deno.test("an unpriced partition wall is listed only for a read that asks; a priced one always is", async () => {
  const old = await call({ action: "catalog" });
  assertEquals(old.status, 200, JSON.stringify(old.body));
  assertEquals(old.body.items.map((i: any) => i.key), ["workbench", "shelf"], "production's old card never lists it, so never asks for a price");
  const priced = await call({ action: "catalog" }, { priced: [{ item_key: "partitionWall", rate: 22 }] });
  assertEquals(priced.body.items.map((i: any) => i.key), ["workbench", "shelf", "partitionWall"]);
  // Only the partition wall: an unpriced shelf (171) stays listed as it always was.
  const noShelf = await call({ action: "catalog" }, { priced: [] });
  assertEquals(noShelf.body.items.map((i: any) => i.key), ["workbench", "shelf"]);
});

Deno.test("a Save without partitionAware (the card before 278) never prices a partition wall, and never asks for one", async () => {
  const r = await saveOld([
    { item_key: "workbench", pricing_method: "each", rate: 0, imageUrl: null },
    { item_key: "partitionWall", pricing_method: "lineal_ft", rate: 50, imageUrl: null },
  ]);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.saved, 1);
  assertEquals(r.body.skipped, ["Partition Wall: opens with the next app update, nothing to set yet"]);
  assertEquals(pricingWrites(r.trace).map((w) => w.row.item_key), ["workbench"], "no row is written for the partition wall");
  assert(!JSON.stringify(r.body).includes("price above"), "the old card is never told to set a price");
  // Already priced (on the new card): sent back unchanged it is passed over quietly; changed, it is refused.
  const world: World = { priced: [{ item_key: "partitionWall", rate: 22 }] };
  const same = await saveOld([{ item_key: "partitionWall", pricing_method: "lineal_ft", rate: 22, imageUrl: null }], world);
  assertEquals([same.body.saved, same.body.skipped, pricingWrites(same.trace).length], [0, [], 0]);
  const changed = await saveOld([{ item_key: "partitionWall", pricing_method: "lineal_ft", rate: 30, imageUrl: null }], world);
  assertEquals([changed.body.saved, changed.body.skipped, pricingWrites(changed.trace).length],
    [0, ["Partition Wall: its price can be changed after the next app update"], 0]);
  // The same row from the new card is written.
  const aware = await save([{ item_key: "partitionWall", pricing_method: "lineal_ft", rate: 50, imageUrl: null }]);
  assertEquals([aware.body.saved, aware.body.skipped], [1, []]);
  assertEquals(pricingWrites(aware.trace).map((w) => [w.verb, w.row.item_key, w.row.rate]), [["insert", "partitionWall", 50]]);
});

Deno.test("a first partition price of $0 is skipped; the rest saves", async () => {
  const r = await save([
    { item_key: "workbench", pricing_method: "each", rate: 0, imageUrl: null },
    { item_key: "shelf", pricing_method: "lineal_ft", rate: 20, imageUrl: null },
    { item_key: "partitionWall", pricing_method: "each", rate: 0, imageUrl: null },
  ]);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.saved, 2);
  assertEquals(r.body.skipped, ["partitionWall: not offered until it has a price above $0"]);
  const keys = pricingWrites(r.trace).map((w) => w.verb === "insert" ? w.row.item_key : `update:${eqOf(w.ops, "id")}`);
  assertEquals(keys, ["workbench", "update:lp-0"], "no row is written for the partition wall");
});

Deno.test("a real price is saved, per foot; an already-priced partition can be changed, to $0 too", async () => {
  const r = await save([{ item_key: "partitionWall", pricing_method: "lineal_ft", rate: 22, imageUrl: null }]);
  assertEquals([r.body.saved, r.body.skipped], [1, []]);
  const [w] = pricingWrites(r.trace);
  assertEquals([w.verb, w.row.item_key, w.row.pricing_method, w.row.rate], ["insert", "partitionWall", "lineal_ft", 22]);
  const again = await save([{ item_key: "partitionWall", pricing_method: "sqft_option", rate: 0, imageUrl: null }], { priced: [{ item_key: "partitionWall", rate: 22 }] });
  assertEquals([again.body.saved, again.body.skipped], [1, []]);
  const [u] = pricingWrites(again.trace);
  assertEquals([u.verb, u.row.pricing_method, u.row.rate], ["update", "sqft_option", 0]);
});

Deno.test("a partition wall is priced each, per foot or per square foot of wall — nothing else", async () => {
  for (const method of ["sqft_building", "perimeter_building", "pct_building_price", "pct_estimate_total"]) {
    const r = await save([{ item_key: "partitionWall", pricing_method: method, rate: 10, imageUrl: null },
      { item_key: "shelf", pricing_method: method, rate: 10, imageUrl: null }]);
    assertEquals(r.body.saved, 1, method);
    assert(r.body.skipped.length === 1 && r.body.skipped[0].startsWith("partitionWall: a partition wall is priced each"), JSON.stringify(r.body.skipped));
    assertEquals(pricingWrites(r.trace).length, 1, `${method}: only the shelf's price is written`);
  }
});

Deno.test("a pricing sheet's Partition Wall column writes no inclusion; the other columns still do", async () => {
  const r = await call({ action: "import_pricing_csv", rows: [
    { style: "Utility", width: 10, length: 12, price: 3000, inclusions: { partitionWall: "x", workbench: "1" } },
  ] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.skipped, []);
  const inc = r.trace.writes.filter((w) => w.table === "building_size_inclusions");
  assertEquals(inc.map((w) => [w.verb, w.row?.item_key]), [["upsert", "workbench"]]);
});
