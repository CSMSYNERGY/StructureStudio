// The interior wall's settings (278's partition wall, given its own tab by 313), driven through the
// SHIPPED portal-settings handler.
//
// WHAT IS PINNED:
//   1. The catalog read tells the card which items stay out of the customer's palette until priced
//      (hiddenUntilPriced), and an UNPRICED partition wall is listed only for a read that asks
//      (withUnpriced). It also carries the Interior walls tab's two reads (313).
//   2. save_layout_pricing never writes the partition wall any more (313: it is priced on the
//      Interior walls tab). A row sent back unchanged is passed over quietly; a change is refused in
//      words that say where the price lives now; everything else in the Save still saves.
//   3. A pricing sheet's Partition Wall column writes no inclusion: a wall is never part of a size's price.
//   4. save_interior_walls: the method is per lineal ft or per sq ft ONLY ('each' refused), the
//      standard stud's rate required, other blanks NULL, a rafters standard needs rafters offered, the
//      two tick lists written column-only and tenant-scoped (malformed ids dropped), and NOTHING
//      written to the 278 rows (layout_item_pricing / client_layout_items): no mirror since
//      2026-10-17, and those rows are never deleted either.
//   5. save_interior_wall_coverings: validated whole before any write, upsert by id scoped to the
//      tenant, 409 on a duplicate name, rows not sent back deleted.
//   6. save_electrical_items and save_fixture pass interior_wall_ok / in_partition through, and only
//      when sent (an older card leaves the builder's tick alone).
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
type World = { priced?: { item_key: string; rate: number }[]; clash?: boolean };
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
    if (world.clash && table === "interior_wall_coverings" && verb !== "delete") return { data: null, error: { code: "23505", message: "duplicate key" } };
    // A write that asks for its row back gets an id: the one it was scoped to, or a new one.
    return { data: has(ops, "select") ? { id: eqOf(ops, "id") ?? "00000000-0000-4000-8000-00000000c0de" } : null, error: null };
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
    case "layout_item_pricing": {
      const all = (world.priced ?? [{ item_key: "shelf", rate: 18 }]).map((p, i) => ({ id: `lp-${i}`, item_key: p.item_key, pricing_method: "lineal_ft", rate: p.rate, image_url: null, style_id: null }));
      const k = eqOf(ops, "item_key");
      return rows(k ? all.filter((r) => r.item_key === k) : all);
    }
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
const writesTo = (t: Trace, table: string) => t.writes.filter((w) => w.table === table);
const save = (rows: Record<string, unknown>[], world?: World) => call({ action: "save_layout_pricing", rows }, world);
// The beta card from before 313 sent partitionAware; it buys nothing now.
const saveAware = (rows: Record<string, unknown>[], world?: World) => call({ action: "save_layout_pricing", rows, partitionAware: true }, world);

Deno.test("the catalog tells the card which items stay hidden until priced", async () => {
  const r = await call({ action: "catalog", withUnpriced: true });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.items.map((i: any) => [i.key, i.hiddenUntilPriced]));
  assertEquals(by, { workbench: false, shelf: true, partitionWall: true });
  // The Interior walls tab's reads (313): nothing on file yet.
  assertEquals([r.body.interiorWalls, r.body.interiorWallCoverings], [null, []]);
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

Deno.test("save_layout_pricing never writes a partition wall (313); the rest of the Save still saves", async () => {
  const world: World = { priced: [{ item_key: "partitionWall", rate: 35 }] };
  for (const send of [save, saveAware]) {
    const r = await send([
      { item_key: "workbench", pricing_method: "each", rate: 0, imageUrl: null },
      { item_key: "partitionWall", pricing_method: "lineal_ft", rate: 50, imageUrl: null },
    ], world);
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.saved, 1);
    assertEquals(r.body.skipped, ["Interior wall: its price is set on Settings → Options → Interior walls"]);
    assertEquals(pricingWrites(r.trace).map((w) => w.row.item_key), ["workbench"], "no row is written for the partition wall");
  }
  // Sent back unchanged (production's Interior items card lists a priced one): passed over quietly.
  const same = await save([{ item_key: "partitionWall", pricing_method: "lineal_ft", rate: 35, imageUrl: null }], world);
  assertEquals([same.body.saved, same.body.skipped, pricingWrites(same.trace).length], [0, [], 0]);
  // Never priced: a first price is refused too, never inserted.
  const first = await save([{ item_key: "partitionWall", pricing_method: "lineal_ft", rate: 22, imageUrl: null }]);
  assertEquals([first.body.saved, pricingWrites(first.trace).length], [0, 0]);
  assert(!JSON.stringify(first.body).includes("price above"), "it is never asked to set a price there");
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

// ── save_interior_walls (313) ─────────────────────────────────────────────────────────────
const DOOR_ID = "00000000-0000-4000-8000-0000000000d1";
const WIN_ID = "00000000-0000-4000-8000-0000000000a1";
const FAN_ID = "00000000-0000-4000-8000-0000000000f1";
const OUTLET_ID = "00000000-0000-4000-8000-0000000000f2";
const walls = (over: Record<string, unknown> = {}, world?: World) => call({
  action: "save_interior_walls", standardStud: "2x4", method: "lineal_ft", rate2x4: "35", rate2x6: "",
  standardHeight: "plate", allowRafters: true, allowRo: true, taxable: true, internalOnly: false, ...over,
}, world);

Deno.test("save_interior_walls refuses what a wall cannot be, and writes nothing", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ rate2x4: "" }, /Enter a rate for a 2x4 wall/],
    [{ standardStud: "2x6", rate2x4: "35", rate2x6: "  " }, /Enter a rate for a 2x6 wall/],
    [{ standardStud: "2x8" }, /2x4 or 2x6/],
    [{ method: "sqft_building" }, /per lineal foot of wall or per square foot of wall/],
    [{ method: "each" }, /per lineal foot of wall or per square foot of wall/],
    [{ method: "" }, /per lineal foot of wall or per square foot of wall/],
    [{ rate2x6: "TBD" }, /has to be a number/],
    [{ rate2x4: "-5" }, /has to be a number/],
    [{ standardHeight: "rafters", allowRafters: false }, /To the rafters/],
    [{ standardHeight: "attic" }, /standard wall height/],
    [{ inPartition: [DOOR_ID] }, /didn't come through/],
  ];
  for (const [over, re] of cases) {
    const r = await walls(over);
    assertEquals(r.status, 400, JSON.stringify(over));
    assert(re.test(r.body.error), `${JSON.stringify(over)} → ${r.body.error}`);
    assertEquals(r.trace.writes.length, 0, `${JSON.stringify(over)}: nothing written`);
    assert(!/quote/i.test(r.body.error), "estimate, never quote");
  }
});

Deno.test("save_interior_walls saves the row, blanks as NULL, and the ticks column-only, scoped to the tenant", async () => {
  const r = await walls({
    rate2x6: "", standardHeight: "rafters", allowRafters: true, allowRo: false, taxable: false, internalOnly: true,
    inPartition: { [DOOR_ID]: false, [WIN_ID]: true, "not-a-uuid": false },
    interiorWallOk: { [FAN_ID]: false, [OUTLET_ID]: true },
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const [up] = writesTo(r.trace, "interior_wall_settings");
  assertEquals(up.verb, "upsert");
  const { updated_at: _u, ...row } = up.row;
  assertEquals(row, { client_id: OWN, standard_stud: "2x4", pricing_method: "lineal_ft", rate_2x4: 35, rate_2x6: null,
    standard_height: "rafters", allow_rafters: true, allow_rough_openings: false, taxable: false, internal_only: true });
  assertEquals(argOf(up.ops, "upsert")[1], { onConflict: "client_id" });
  const fix = writesTo(r.trace, "fixture_items");
  assertEquals(fix.map((w) => [w.row, argOf(w.ops, "in").length ? w.ops.filter((o) => o[0] === "in").map((o) => [o[1], o[2]]) : null, eqOf(w.ops, "client_id")]), [
    [{ in_partition: true }, [["category", ["door", "window"]], ["id", [WIN_ID]]], OWN],
    [{ in_partition: false }, [["category", ["door", "window"]], ["id", [DOOR_ID]]], OWN],
  ], "the malformed id is dropped; doors and windows only; this tenant only");
  const el = writesTo(r.trace, "electrical_items");
  assertEquals(el.map((w) => [w.row, (w.ops.find((o) => o[0] === "in") ?? [])[2], eqOf(w.ops, "client_id")]), [
    [{ interior_wall_ok: true }, [OUTLET_ID], OWN],
    [{ interior_wall_ok: false }, [FAN_ID], OWN],
  ]);
  // No mirror (2026-10-17): the 278 rows are neither written nor deleted.
  assertEquals([pricingWrites(r.trace).length, writesTo(r.trace, "client_layout_items").length], [0, 0]);
});

Deno.test("save_interior_walls saves per sq ft, and leaves an existing 278 row untouched", async () => {
  const r = await walls({ standardStud: "2x6", method: "sqft_option", rate2x4: "30", rate2x6: "0" }, { priced: [{ item_key: "shelf", rate: 18 }, { item_key: "partitionWall", rate: 35 }] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const [up] = writesTo(r.trace, "interior_wall_settings");
  assertEquals([up.row.pricing_method, up.row.rate_2x4, up.row.rate_2x6, up.row.standard_stud], ["sqft_option", 30, 0, "2x6"], "0 is a real rate (included), not a blank");
  assertEquals(pricingWrites(r.trace).length, 0, "the 278 row is not touched: no mirror, no delete");
  assertEquals(writesTo(r.trace, "client_layout_items").length, 0);
  // No tick lists sent: neither catalog is touched.
  assertEquals([writesTo(r.trace, "fixture_items").length, writesTo(r.trace, "electrical_items").length], [0, 0]);
  // And per lineal ft is the other one.
  const ft = await walls({ method: "lineal_ft" });
  assertEquals([ft.status, writesTo(ft.trace, "interior_wall_settings")[0].row.pricing_method], [200, "lineal_ft"]);
});

// ── save_interior_wall_coverings (313) ────────────────────────────────────────────────────
const COVER_ID = "00000000-0000-4000-8000-0000000000c1";
const covers = (rows: Record<string, unknown>[], world?: World) => call({ action: "save_interior_wall_coverings", rows }, world);

Deno.test("save_interior_wall_coverings: update by id (tenant-scoped), insert by name, sweep the rest", async () => {
  const r = await covers([
    { id: COVER_ID, name: " Drywall ", method: "sqft_option", rate: "2.5", taxable: true, internalOnly: false, sortOrder: 10 },
    { id: "", name: "OSB", method: "each", rate: "", taxable: false, internalOnly: true, sortOrder: 20 },
    { id: "", name: "   ", method: "each", rate: "1" },
  ]);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.saved, 2, "a nameless row is skipped");
  const w = writesTo(r.trace, "interior_wall_coverings");
  assertEquals(w.map((x) => x.verb), ["update", "upsert", "delete"]);
  const strip = (row: any) => { const { updated_at: _u, ...rest } = row; return rest; };
  assertEquals([strip(w[0].row), eqOf(w[0].ops, "id"), eqOf(w[0].ops, "client_id")], [
    { client_id: OWN, name: "Drywall", pricing_method: "sqft_option", rate: 2.5, taxable: true, internal_only: false, active: true, sort_order: 10 }, COVER_ID, OWN]);
  assertEquals(strip(w[1].row), { client_id: OWN, name: "OSB", pricing_method: "each", rate: null, taxable: false, internal_only: true, active: true, sort_order: 20 }, "blank = not offered = NULL");
  assertEquals(argOf(w[1].ops, "upsert")[1], { onConflict: "client_id,name" });
  assertEquals([eqOf(w[2].ops, "client_id"), argOf(w[2].ops, "not")], [OWN, ["id", "in", `("${COVER_ID}","00000000-0000-4000-8000-00000000c0de")`]]);
});

Deno.test("save_interior_wall_coverings refuses a bad list before writing any of it", async () => {
  const dup = await covers([{ name: "Drywall", method: "sqft_option", rate: "2" }, { name: "drywall ", method: "each", rate: "1" }]);
  assertEquals([dup.status, dup.trace.writes.length], [409, 0]);
  assert(/two wall coverings called/.test(dup.body.error), dup.body.error);
  const bad = await covers([{ name: "Drywall", method: "sqft_option", rate: "2" }, { name: "OSB", method: "sqft_option", rate: "cheap" }]);
  assertEquals([bad.status, bad.trace.writes.length], [400, 0]);
  const meth = await covers([{ name: "Drywall", method: "pct_building_price", rate: "2" }]);
  assertEquals([meth.status, meth.trace.writes.length], [400, 0]);
  // A clash the database finds (a rename onto a name another session saved) is a 409 in words.
  const clash = await covers([{ id: COVER_ID, name: "Drywall", method: "sqft_option", rate: "2" }], { clash: true });
  assertEquals(clash.status, 409, JSON.stringify(clash.body));
  assert(/already have a wall covering called "Drywall"/.test(clash.body.error), clash.body.error);
});

Deno.test("an empty covering list deletes every covering", async () => {
  const r = await covers([]);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const w = writesTo(r.trace, "interior_wall_coverings");
  assertEquals(w.map((x) => [x.verb, argOf(x.ops, "not")]), [["delete", ["id", "in", '("00000000-0000-0000-0000-000000000000")']]]);
});

// ── The pass-throughs (313) ───────────────────────────────────────────────────────────────
Deno.test("save_electrical_items writes interior_wall_ok only when the row carries it", async () => {
  const r = await call({ action: "save_electrical_items", rows: [
    { id: FAN_ID, name: "Ceiling fan", priceWithPackage: "150", priceStandalone: "250", interiorWallOk: false },
    { id: OUTLET_ID, name: "Outlet", priceWithPackage: "25", priceStandalone: "60" },
  ] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const w = writesTo(r.trace, "electrical_items").filter((x) => x.verb === "update");
  assertEquals(w.map((x) => [eqOf(x.ops, "id"), x.row.interior_wall_ok]), [[FAN_ID, false], [OUTLET_ID, undefined]]);
  assert(!("interior_wall_ok" in w[1].row), "an older card's row leaves the tick alone");
});

Deno.test("save_fixture writes in_partition for doors and windows when sent, and a new one defaults true", async () => {
  const line = { name: "Walk door", widthIn: 36, heightIn: 80, price: "300" };
  const door = await call({ action: "save_fixture", category: "door", ...line, inPartition: false });
  assertEquals(door.status, 200, JSON.stringify(door.body));
  assertEquals(writesTo(door.trace, "fixture_items").find((w) => w.verb === "insert")!.row.in_partition, false);
  const unsent = await call({ action: "save_fixture", category: "window", ...line, name: "Window" });
  assertEquals(writesTo(unsent.trace, "fixture_items").find((w) => w.verb === "insert")!.row.in_partition, true, "the column's default");
  const vent = await call({ action: "save_fixture", category: "vent", ...line, name: "Vent", inPartition: false });
  assertEquals(writesTo(vent.trace, "fixture_items").find((w) => w.verb === "insert")!.row.in_partition, true, "a vent's tick is never taken from the body");
});
