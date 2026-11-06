// One shop serial per BUILDING (Carolyn 2026-10-06, question 14: "one per building"), driven through
// the SHIPPED portal-schedule handler: resolveTenant, the GATES table, and the create_job, delete_job,
// add_stop and create_repair branches with their own reads and writes (migration 284 put the number
// on orders.shop_serial).
//
//   1. the first create_job for an order building mints ONCE: one take_next_serial() call, the number
//      written to its order (conditionally, `.is(shop_serial, null)`) BEFORE the job is inserted, and
//      the job carries it;
//   2. delete_job, then create_job again: no new number, the same one, the counter untouched;
//   3. a building that already has a number (a warranty rebuild of a delivered building) mints nothing;
//   4. a rejected payload spends no number and writes no order: not invoiced, an inventory sale, a
//      duplicate job, a design that is not ours;
//   5. a lost race (someone else numbered the building between our read and our write) keeps the
//      winner's number; ours is a gap, never a second number on the building;
//   6. an invoiced design with no orders row still gets a job and a number, and one app_errors row
//      ('serial_no_order'), written once the job exists and naming it, says the number is not kept;
//      a refused insert logs nothing;
//  6b. the building's number reaches its OPEN order stop that was added from the design code with
//      none (first number or kept one), before the job insert; a delivered stop and a building
//      with no order are left alone;
//   7. a customer's two buildings get two numbers;
//   8. add_stop from a bare design code shows the building's number: the order's, the old code's job
//      number in the deploy window, a lot building's unit number (both ways a sale is linked), and
//      none for a building that never had one, with nothing minted;
//   9. add_stop from a build job is unchanged: the job's number, and the order is not even read;
//  10. another builder's order with the same design code is never read, let alone used;
//  11. repair intake: a typed number that belongs to an order building links its design, a typed
//      design code fills the building's number, a unit number still links the unit, and "not one
//      of ours" stays legal. Nothing is minted for a repair.
//
// HOW. scheduleCustomerLinkWiring_test's idiom: Deno.serve is stubbed while the handler is imported,
// the import map swaps supabase-js for supabase_stub.ts, and its stubDb/stubRpc hooks route every
// call into ONE in-memory database below. This fake also WRITES (insert / update / delete with the
// filters the code really put on them, `.select()` returning what changed), enforces the partial
// unique indexes the code leans on (087, 090, 284), and refuses a column the table does not have
// (PostgREST's 42703; the column lists are the live schema's, read 2026-10-07, plus 284's
// orders.shop_serial). Every call is numbered, so "the order before the job" is checked, not assumed.
// No network.
//
// Builders, people, codes and numbers are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";

async function importHandler(fn: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: any) => { handler = h; return { finished: Promise.resolve() }; };
  try {
    // Computed, so this file is not type-checked against the stub's partial client.
    await import(new URL(`../../${fn}/index.ts`, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${fn} did not hand Deno.serve a handler`);
  return handler;
}
const SCHEDULE = await importHandler("portal-schedule");

// ─── Made-up identities ────────────────────────────────────────────────────────────────────────
const TENANT = "acme-sheds";
const BYSTANDER = "bystander-barns";
const ME = "00000000-0000-4000-8000-00000000a001";
const uid = (p: string, n: number) => `00000000-0000-4000-8000-${p}${String(n).padStart(12 - p.length, "0")}`;
const STAGE_Q = uid("5", 1), STAGE_D = uid("5", 2);
const L1 = uid("1", 1);
const U1 = uid("e", 1), U2 = uid("e", 2);
const OLD = "2026-09-01T10:00:00.000Z";

// ─── One in-memory database that also writes ───────────────────────────────────────────────────
type Row = Record<string, any>;

// The live schema's columns for every table these branches read or write a projection of.
const COLUMNS: Record<string, string[]> = {
  designs: ["id", "short_code", "client_id", "contact", "selections", "paint_colors", "items", "custom_options", "ro_dimensions", "bldg_w",
    "bldg_h", "image_url", "status", "created_at", "updated_at", "ghl_contact_id", "ghl_estimate_id", "ghl_estimate_number", "ghl_opportunity_id",
    "estimate_lines", "inventory_unit_id", "delivered_at", "ss_quote_number", "ss_quote_pdf_url", "ss_quote_sent_at", "accepted_at",
    "plan_image_url", "view3d_image_url", "contact_id", "ss_invoice_sent_at", "accepted_snapshot", "expected_close_date", "total_cents",
    "created_by_user_id", "updated_by_user_id", "ss_invoice_requested_at", "sales_location_id"],
  orders: ["id", "client_id", "short_code", "order_no", "total_cents", "currency", "total_source", "ordered_at", "notes", "created_at",
    "updated_at", "submitter_user_id", "pretax_subtotal_cents", "tax_cents", "building_serial",
    "shop_serial"], // 284
  build_jobs: ["id", "client_id", "stage_id", "position", "source", "design_short_code", "order_id", "inventory_unit_id", "repair_id", "serial",
    "title", "customer_name", "building_label", "width_ft", "length_ft", "scheduled_start", "due_date", "completed_at", "assignee_user_id",
    "notes", "created_by", "created_at", "updated_at", "roof_type", "roof_color", "body_color", "trim_color", "roof_color_hex", "body_color_hex",
    "trim_color_hex", "crew_id", "changed_at", "changed_co_no", "changed_summary"],
  delivery_stops: ["id", "client_id", "load_id", "stop_order", "source", "build_job_id", "design_short_code", "inventory_unit_id", "repair_id",
    "serial", "customer_name", "customer_phone", "building_label", "width_ft", "length_ft", "pickup", "dest_street", "dest_city", "dest_state",
    "dest_zip", "territory_id", "lat", "lng", "leg_miles", "time_window", "site_notes", "delivered_at", "created_at", "updated_at"],
  inventory_units: ["id", "client_id", "serial", "design_short_code", "location_id", "asking_price_cents", "sold_design_short_code", "created_at",
    "updated_at", "sale_state", "sold_at", "sold_by", "sold_first_name", "sale_released_at", "sale_released_from"],
  repairs: ["id", "client_id", "repair_no", "customer_name", "phone", "email", "design_short_code", "inventory_unit_id", "serial", "description",
    "status", "quote_cents", "notes", "requested_at", "completed_at", "created_by", "created_at", "updated_at", "street", "city", "state", "zip",
    "order_id"],
};
// The partial unique indexes these branches lean on: one job and one stop per design (087, 090), one
// order per design, and one building per number per builder (284).
const UNIQUE: Record<string, string[][]> = {
  build_jobs: [["client_id", "design_short_code"]],
  delivery_stops: [["client_id", "design_short_code"]],
  orders: [["client_id", "short_code"], ["client_id", "shop_serial"]],
};
const WRITES = ["insert", "update", "upsert", "delete"];
const FILTERS = ["eq", "neq", "is", "not", "in", "order", "range", "limit"];

type Call = { seq: number; table: string; ops: any[][] };

class FakeDb {
  tables: Record<string, Row[]>;
  /** take_next_serial()'s counter per tenant, i.e. client_settings.next_serial. */
  counters: Record<string, number>;
  log: Call[] = [];
  seq = 0;
  /** Runs just before a write reaches the table: how a test lets "someone else" win a race. */
  beforeWrite: ((table: string, ops: any[][]) => void) | null = null;
  constructor(seed: Record<string, Row[]>, counters: Record<string, number>) {
    this.tables = structuredClone(seed);
    this.counters = { ...counters };
  }
  rows(t: string): Row[] { return (this.tables[t] ??= []); }
  from(table: string): any { return chain(this, table, []); }
  rpc(fn: string, args?: any): any { return chain(this, `rpc:${fn}`, [["args", args]]); }
  calls(table: string, verb?: string) {
    return this.log.filter((l) => l.table === table && (!verb || verbOf(l.ops) === verb));
  }
  mints() { return this.log.filter((l) => l.table === "rpc:take_next_serial"); }
  order(code: string, tenant = TENANT) { return this.rows("orders").find((o) => o.client_id === tenant && o.short_code === code); }
}
const verbOf = (ops: any[][]) => (ops.find((o) => WRITES.includes(o[0])) ?? ["select"])[0];

function matches(r: Row, ops: any[][]): boolean {
  for (const [op, col, v, w] of ops) {
    if (op === "eq" && !(r[col] != null && r[col] === v)) return false;
    if (op === "neq" && r[col] === v) return false;
    if (op === "is" && v === null && r[col] != null) return false;
    if (op === "not" && v === "is" && w === null && r[col] == null) return false;
    if (op === "in" && !(v as unknown[]).includes(r[col])) return false;
  }
  return true;
}
const cmp = (a: any, b: any) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1
  : typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));
const project = (r: Row, sel: string) => (sel === "*" ? structuredClone(r)
  : Object.fromEntries(sel.split(",").map((s) => s.trim()).map((k) => [k, structuredClone(r[k] ?? null)])));
const missing = (table: string, names: string[]) => {
  const cols = COLUMNS[table];
  const bad = cols ? names.filter((n) => !cols.includes(n)) : [];
  return bad.length ? { data: null, error: { code: "42703", message: `column ${table}.${bad[0]} does not exist` } } : null;
};
function uniqueClash(db: FakeDb, table: string, candidate: Row, self: Row | null): boolean {
  for (const key of UNIQUE[table] ?? []) {
    if (key.some((k) => candidate[k] == null)) continue;
    if (db.rows(table).some((o) => o !== self && key.every((k) => o[k] === candidate[k]))) return true;
  }
  return false;
}
const DUPE = { code: "23505", message: "duplicate key value violates unique constraint" };

function run(db: FakeDb, table: string, ops: any[][]): any {
  if (table.startsWith("rpc:")) {
    const fn = table.slice(4), args = ops[0][1];
    if (fn === "take_next_serial") {
      const n = db.counters[args.p_client_id] ?? 1;
      db.counters[args.p_client_id] = n + 1;
      return { data: n, error: null };
    }
    throw new Error(`TEST FAILURE: the fake database has no rpc ${fn}`);
  }
  const write = ops.find((o) => WRITES.includes(o[0]));
  const selOp = ops.find((o) => o[0] === "select");
  const sel = selOp ? String(selOp[1] ?? "*") : "*";
  const filters = ops.filter((o) => FILTERS.includes(o[0]));
  const named = [
    ...(sel === "*" ? [] : sel.split(",").map((s) => s.trim())),
    ...filters.filter((o) => ["eq", "neq", "is", "not", "in", "order"].includes(o[0])).map((o) => o[1]),
    ...(write && write[0] !== "delete" ? [write[1]].flat().flatMap((r: Row) => Object.keys(r)) : []),
  ];
  const bad = missing(table, named);
  if (bad) return bad;
  const now = new Date().toISOString();
  let out: Row[];

  if (write?.[0] === "insert") {
    const fresh = [write[1]].flat().map((r: Row) => ({
      id: crypto.randomUUID(), created_at: now, updated_at: now,
      ...(table === "repairs" ? { repair_no: db.rows("repairs").length + 101, status: "requested" } : {}),
      ...r,
    }));
    for (const r of fresh) {
      if (uniqueClash(db, table, r, null)) return { data: null, error: DUPE };
      db.rows(table).push(r);
    }
    out = fresh;
  } else if (write?.[0] === "update") {
    const target = db.rows(table).filter((r) => matches(r, filters));
    for (const r of target) if (uniqueClash(db, table, { ...r, ...write[1] }, r)) return { data: null, error: DUPE };
    for (const r of target) Object.assign(r, structuredClone(write[1]));
    out = target;
  } else if (write?.[0] === "delete") {
    const gone = db.rows(table).filter((r) => matches(r, filters));
    db.tables[table] = db.rows(table).filter((r) => !gone.includes(r));
    // 090: delivery_stops.build_job_id references build_jobs ON DELETE SET NULL.
    if (table === "build_jobs") {
      for (const s of db.rows("delivery_stops")) if (gone.some((g) => g.id === s.build_job_id)) s.build_job_id = null;
    }
    out = gone;
  } else if (write) {
    throw new Error(`TEST FAILURE: ${write[0]} on ${table} is not something these branches do`);
  } else {
    out = db.rows(table).filter((r) => matches(r, filters));
    const opts = selOp?.[2];
    if (opts?.head) return { data: null, count: out.length, error: null };
  }

  if (write && !selOp) return { data: null, error: null };
  const orders = filters.filter((o) => o[0] === "order");
  if (orders.length) {
    out = [...out].sort((a, b) => {
      for (const o of orders) {
        const d = cmp(a[o[1]], b[o[1]]) * (o[2] && o[2].ascending === false ? -1 : 1);
        if (d) return d;
      }
      return 0;
    });
  }
  const range = filters.find((o) => o[0] === "range");
  if (range) out = out.slice(range[1], range[2] + 1);
  const lim = filters.find((o) => o[0] === "limit");
  if (lim) out = out.slice(0, lim[1]);
  const projected = out.map((r) => project(r, sel));
  if (ops.some((o) => o[0] === "maybeSingle")) {
    if (projected.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
    return { data: projected[0] ?? null, error: null };
  }
  if (ops.some((o) => o[0] === "single")) {
    if (projected.length !== 1) return { data: null, error: { code: "PGRST116", message: `${projected.length} rows` } };
    return { data: projected[0], error: null };
  }
  return { data: projected, error: null };
}

function chain(db: FakeDb, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(db, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", ...WRITES, ...FILTERS, "maybeSingle", "single"]) q[m] = (...a: unknown[]) => next([m, ...a]);
  q.then = (ok: any, bad: any) => {
    const seq = ++db.seq;
    db.log.push({ seq, table, ops });
    return Promise.resolve().then(() => {
      if (WRITES.includes(verbOf(ops)) && db.beforeWrite) db.beforeWrite(table, ops);
      return run(db, table, ops);
    }).then(ok, bad);
  };
  return q;
}

// ─── The world one call runs in ────────────────────────────────────────────────────────────────
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

async function call(db: FakeDb, payload: Row) {
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((u: unknown) => Promise.reject(new Error(`TEST FAILURE: unexpected fetch ${String(u)}`))) as typeof fetch;
  stubAuth.user = { id: ME, email: "person@example.test" };
  stubAuth.error = null;
  stubDb.from = (t: string) => db.from(t);
  stubRpc.rpc = (fn: string, args?: unknown) => db.rpc(fn, args);
  try {
    const res = await SCHEDULE(new Request("https://stub.supabase.co/functions/v1/portal-schedule", {
      method: "POST",
      headers: { "authorization": "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(payload),
    }));
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, text };
  } finally {
    globalThis.fetch = realFetch;
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
const design = (code: string, extra: Row = {}): Row => ({
  id: `d-${code}`, short_code: code, client_id: TENANT, contact: { name: `Buyer of ${code}` }, contact_id: null,
  selections: { style: "gable", size: "10x12" }, paint_colors: {}, status: "invoiced", inventory_unit_id: null, ...extra,
});
let orderNo = 5000;
const order = (code: string, extra: Row = {}): Row => ({
  id: `o-${code}`, client_id: TENANT, short_code: code, order_no: ++orderNo, total_cents: 650000,
  building_serial: null, shop_serial: null, updated_at: OLD, ...extra,
});
const job = (id: string, code: string | null, serial: number | null, extra: Row = {}): Row => ({
  id, client_id: TENANT, stage_id: STAGE_Q, position: 1, source: "order", design_short_code: code, inventory_unit_id: null,
  repair_id: null, serial, title: null, customer_name: `Buyer of ${code}`, building_label: "Gable 10x12", width_ft: 10, length_ft: 12,
  completed_at: null, updated_at: OLD, ...extra,
});
const J_WINDOW = uid("c", 1), J_ONBOARD = uid("c", 2);

function world(): FakeDb {
  return new FakeDb({
    client_users: [{ user_id: ME, client_id: TENANT, role: "owner", title: null, access: null, full_name: "Pat Owner" }],
    schedule_stages: [
      { id: STAGE_Q, client_id: TENANT, name: "Queue", kind: "queue", sort_order: 0, color: "#94A3B8", archived: false },
      { id: STAGE_D, client_id: TENANT, name: "Built", kind: "done", sort_order: 1, color: "#22C55E", archived: false },
    ],
    designs: [
      design("SS-NEW001"),                                   // sold, never on the board: no number yet
      design("SS-NEW002"),                                   // the same customer's second building
      design("SS-KEPT01", { status: "delivered" }),          // on the board before: holds #1500 (a warranty rebuild)
      design("SS-NOTINV", { status: "accepted" }),           // not invoiced yet
      design("SS-LOTBUY", { inventory_unit_id: U1 }),        // the sale of lot building #1400
      design("SS-SOLDTO"),                                   // lot building #1401 sold to it, linked from the unit's side only
      design("SS-NOORDR"),                                   // invoiced, but no orders row
      design("SS-BARE01"),                                   // delivered straight from a design code: never numbered
      design("SS-WINDOW"),                                   // numbered by the OLD code (job #1520), order not told yet
      design("SS-ONBRD1"),                                   // on the board now, #1510
      { ...design("SS-NEW001"), id: "d-bystander", client_id: BYSTANDER },
    ],
    orders: [
      order("SS-NEW001"), order("SS-NEW002"), order("SS-KEPT01", { shop_serial: 1500 }), order("SS-NOTINV"),
      order("SS-LOTBUY"), order("SS-SOLDTO"), order("SS-BARE01"), order("SS-WINDOW"), order("SS-ONBRD1", { shop_serial: 1510 }),
      // Another builder's order for a design with the SAME code, already numbered. Never ours.
      { ...order("SS-NEW001", { shop_serial: 7777 }), id: "o-bystander", client_id: BYSTANDER },
    ],
    build_jobs: [job(J_WINDOW, "SS-WINDOW", 1520), job(J_ONBOARD, "SS-ONBRD1", 1510)],
    inventory_units: [
      { id: U1, client_id: TENANT, serial: 1400, design_short_code: "SS-LOTMASTER", sold_design_short_code: "SS-LOTBUY", sale_state: "sold", location_id: null },
      { id: U2, client_id: TENANT, serial: 1401, design_short_code: "SS-LOTMASTER", sold_design_short_code: "SS-SOLDTO", sale_state: "sold", location_id: null },
    ],
    delivery_loads: [{ id: L1, client_id: TENANT, load_no: 7, status: "planned", max_width_ft: null, driver_id: null, driver_user_id: null, permit_status: "not_needed" }],
    delivery_stops: [],
    repairs: [],
    colors: [],
    build_crews: [],
    schedule_activity: [],
    app_errors: [],
    admin_audit: [],
  }, { [TENANT]: 2000, [BYSTANDER]: 9000 });
}

const createJob = (db: FakeDb, code: string) => call(db, { action: "create_job", source: "order", designShortCode: code });
const ordersWrites = (db: FakeDb) => db.log.filter((l) => l.table === "orders" && WRITES.includes(verbOf(l.ops)));
const jobInserts = (db: FakeDb) => db.calls("build_jobs", "insert");
const has = (ops: any[][], ...want: any[]) => ops.some((o) => JSON.stringify(o) === JSON.stringify(want));
const activity = (db: FakeDb) => db.rows("schedule_activity").map((a) => `${a.action}: ${a.detail ?? ""}`);
/** Every read or write of `orders` this world saw is scoped to the tenant. */
function ordersScoped(db: FakeDb) {
  const unscoped = db.calls("orders").filter((l) => !has(l.ops, "eq", "client_id", TENANT));
  assertEquals(unscoped.length, 0, `an orders call without the tenant: ${JSON.stringify(unscoped)}`);
  assertEquals(db.order("SS-NEW001", BYSTANDER)!.shop_serial, 7777, "the other builder's order moved");
}

// ─── 1. The first time on the board ────────────────────────────────────────────────────────────
Deno.test("first create_job: one number, kept on the order BEFORE the job is inserted", async () => {
  const db = world();
  const r = await createJob(db, "SS-NEW001");
  assertEquals(r.status, 200, r.text);
  assertEquals(r.body.job.serial, 2000);
  assertEquals(db.mints().length, 1);
  assertEquals(db.mints()[0].ops[0][1], { p_client_id: TENANT });
  assertEquals(db.counters[TENANT], 2001);

  const writes = ordersWrites(db);
  assertEquals(writes.length, 1, JSON.stringify(writes));
  const w = writes[0].ops;
  assertEquals(w[0][0], "update");
  assertEquals(w[0][1].shop_serial, 2000);
  assert(has(w, "eq", "id", "o-SS-NEW001") && has(w, "eq", "client_id", TENANT), JSON.stringify(w));
  assert(has(w, "is", "shop_serial", null), "the keep-write is not conditional: it could overwrite a number already printed");
  const insert = jobInserts(db);
  assertEquals(insert.length, 1);
  assert(writes[0].seq < insert[0].seq, "the job was inserted before the order kept its number");
  assert(db.mints()[0].seq < writes[0].seq);

  assertEquals(db.order("SS-NEW001")!.shop_serial, 2000);
  assert(db.order("SS-NEW001")!.updated_at !== OLD, "the order's updated_at did not move with the write");
  assertEquals(db.rows("build_jobs").find((j) => j.design_short_code === "SS-NEW001")!.serial, 2000);
  assertEquals(activity(db), ["created: order · serial #2000"]);
  assertEquals(db.rows("app_errors").length, 0, JSON.stringify(db.rows("app_errors")));
  ordersScoped(db);
});

// ─── 2. Off the board and back on ──────────────────────────────────────────────────────────────
Deno.test("delete_job, then create_job again: the same number, nothing minted", async () => {
  const db = world();
  const first = await createJob(db, "SS-NEW001");
  assertEquals(first.status, 200, first.text);
  const del = await call(db, { action: "delete_job", jobId: first.body.job.id });
  assertEquals(del.status, 200, del.text);
  assertEquals(db.rows("build_jobs").filter((j) => j.design_short_code === "SS-NEW001").length, 0, "delete_job no longer deletes");

  const again = await createJob(db, "SS-NEW001");
  assertEquals(again.status, 200, again.text);
  assertEquals(again.body.job.serial, 2000);
  assert(again.body.job.id !== first.body.job.id);
  assertEquals(db.mints().length, 1, "the second create_job minted");
  assertEquals(db.counters[TENANT], 2001, "the counter moved");
  assertEquals(ordersWrites(db).length, 1, "the order was written twice");
  assertEquals(activity(db).at(-1), "created: order · serial #2000 (kept)");
  ordersScoped(db);
});

// ─── 3. A building that already has a number ───────────────────────────────────────────────────
Deno.test("a warranty rebuild of a delivered building keeps its number and mints nothing", async () => {
  const db = world();
  const r = await createJob(db, "SS-KEPT01");
  assertEquals(r.status, 200, r.text);
  assertEquals(r.body.job.serial, 1500);
  assertEquals(db.mints().length, 0);
  assertEquals(ordersWrites(db).length, 0);
  assertEquals(db.order("SS-KEPT01")!.updated_at, OLD);
  assertEquals(activity(db), ["created: order · serial #1500 (kept)"]);
});

// ─── 4. Refusals spend nothing ─────────────────────────────────────────────────────────────────
Deno.test("a rejected create_job spends no number and writes no order", async () => {
  const cases: [string, number, RegExp][] = [
    ["SS-NOTINV", 409, /isn't invoiced yet/],
    ["SS-LOTBUY", 409, /building #1400, which is already on your lot/],
    ["SS-ONBRD1", 409, /already on the build schedule/],
    ["SS-NOPE99", 404, /isn't in your account/],
  ];
  for (const [code, status, msg] of cases) {
    const db = world();
    const before = structuredClone(db.rows("orders"));
    const r = await createJob(db, code);
    assertEquals(r.status, status, `${code}: ${r.text}`);
    assert(msg.test(r.body.error), `${code}: ${r.body.error}`);
    assertEquals(db.mints().length, 0, `${code} minted a number`);
    assertEquals(ordersWrites(db).length, 0, `${code} wrote an order`);
    assertEquals(jobInserts(db).length, 0, `${code} inserted a job`);
    assertEquals(db.rows("orders"), before, `${code} moved an order`);
    assertEquals(db.counters[TENANT], 2000);
  }
});

// ─── 5. The race ───────────────────────────────────────────────────────────────────────────────
Deno.test("a lost race: the building keeps the winner's number, ours is only a gap", async () => {
  const db = world();
  let fired = false;
  db.beforeWrite = (table, ops) => {
    // Someone else's create_job for the same building commits between our read and our write.
    if (table === "orders" && verbOf(ops) === "update" && !fired) {
      fired = true;
      db.order("SS-NEW001")!.shop_serial = 1999;
    }
  };
  const r = await createJob(db, "SS-NEW001");
  assertEquals(r.status, 200, r.text);
  assert(fired, "the race never happened");
  assertEquals(r.body.job.serial, 1999);
  assertEquals(db.order("SS-NEW001")!.shop_serial, 1999, "the winner's number was overwritten");
  assertEquals(db.mints().length, 1);
  assertEquals(db.counters[TENANT], 2001, "our 2000 is spent (a gap), never put on the building");
  // The re-read came after the losing write, and asked for this order on this tenant.
  const reads = db.calls("orders", "select");
  const loss = ordersWrites(db)[0];
  const reread = reads.find((l) => l.seq > loss.seq);
  assert(reread && has(reread.ops, "eq", "id", "o-SS-NEW001") && has(reread.ops, "eq", "client_id", TENANT), JSON.stringify(reads));
  assertEquals(activity(db), ["created: order · serial #1999 (kept)"]);
  assertEquals(db.rows("app_errors").length, 0);
});

// ─── 6. No order row ───────────────────────────────────────────────────────────────────────────
Deno.test("an invoiced design with no order: the job is numbered as before, and app_errors says so", async () => {
  const db = world();
  const r = await createJob(db, "SS-NOORDR");
  assertEquals(r.status, 200, r.text);
  assertEquals(r.body.job.serial, 2000);
  assertEquals(db.mints().length, 1);
  assertEquals(ordersWrites(db).length, 0);
  const errs = db.rows("app_errors");
  assertEquals(errs.length, 1, JSON.stringify(errs));
  assertEquals([errs[0].source, errs[0].code, errs[0].client_id, errs[0].severity], ["edge:portal-schedule", "serial_no_order", TENANT, "error"]);
  assert(/SS-NOORDR has no order, so serial #2000 is kept on the job only/.test(errs[0].message), errs[0].message);
  assertEquals(errs[0].context?.jobId, r.body.job.id, "the row does not name the job it is about");
  const logged = db.calls("app_errors", "insert")[0], inserted = jobInserts(db)[0];
  assert(inserted.seq < logged.seq, "the row was written before the job existed");
});

Deno.test("no order, and the job insert is refused (the race): no app_errors row about a job that never was", async () => {
  const db = world();
  db.beforeWrite = (table, ops) => {
    // Someone else's create_job for the same building inserts its job between our check and ours.
    if (table === "build_jobs" && verbOf(ops) === "insert" && !db.rows("build_jobs").some((j) => j.design_short_code === "SS-NOORDR")) {
      db.rows("build_jobs").push(job(uid("c", 9), "SS-NOORDR", 1999));
    }
  };
  const r = await createJob(db, "SS-NOORDR");
  assertEquals(r.status, 409, r.text);
  assertEquals(db.mints().length, 1, "the check before the insert should have let this one through to mint");
  assertEquals(db.rows("app_errors").length, 0, JSON.stringify(db.rows("app_errors")));
});

// ─── 6b. A stop that went on a load before the building had a number ───────────────────────────
const stopRow = (code: string, serial: number | null, extra: Row = {}): Row => ({
  id: `s-${code}`, client_id: TENANT, load_id: L1, stop_order: 1, source: "order", build_job_id: null,
  design_short_code: code, inventory_unit_id: null, repair_id: null, serial, delivered_at: null, updated_at: OLD, ...extra,
});

Deno.test("the first number reaches the building's open stop that had none; a delivered one is history", async () => {
  // SS-NEW001: added to a load from its design code before it was ever on the board (no number).
  // SS-NEW002: the same, but already delivered. SS-NOORDR: no order, so no building number to give.
  const db = world();
  db.rows("delivery_stops").push(
    stopRow("SS-NEW001", null),
    stopRow("SS-NEW002", null, { delivered_at: "2026-09-20T15:00:00.000Z" }),
    stopRow("SS-NOORDR", null),
  );
  const a = await createJob(db, "SS-NEW001");
  const b = await createJob(db, "SS-NEW002");
  const c = await createJob(db, "SS-NOORDR");
  assertEquals([a.status, b.status, c.status], [200, 200, 200], a.text + b.text + c.text);
  assertEquals([a.body.job.serial, b.body.job.serial, c.body.job.serial], [2000, 2001, 2002]);
  const s = (code: string) => db.rows("delivery_stops").find((x) => x.design_short_code === code)!;
  assertEquals(s("SS-NEW001").serial, 2000, "the open stop still shows no number");
  assert(s("SS-NEW001").updated_at !== OLD, "the open stop's updated_at did not move with its number");
  assertEquals([s("SS-NEW002").serial, s("SS-NEW002").updated_at], [null, OLD], "a delivered stop was rewritten");
  assertEquals([s("SS-NOORDR").serial, s("SS-NOORDR").updated_at], [null, OLD], "a building with no order handed its job-only number to a stop");

  // The write: this tenant, this building's ORDER stops, open, with no number; and before the job.
  const writes = db.calls("delivery_stops", "update");
  assertEquals(writes.length, 2, JSON.stringify(writes));
  const w = writes[0].ops;
  for (const f of [["eq", "client_id", TENANT], ["eq", "design_short_code", "SS-NEW001"], ["eq", "source", "order"],
    ["is", "delivered_at", null], ["is", "serial", null]]) assert(has(w, ...f), `the stop write is missing ${JSON.stringify(f)}: ${JSON.stringify(w)}`);
  assert(writes[0].seq < jobInserts(db)[0].seq, "the stop got its number after the job was inserted");
  assertEquals(db.mints().length, 3);
});

Deno.test("a numbered building back on the board: an open stop left with no number gets it too", async () => {
  // The old code's window: a stop added from the design code carried no number, though the
  // building had one.
  const db = world();
  db.rows("delivery_stops").push(stopRow("SS-KEPT01", null), stopRow("SS-ONBRD1", 1510));
  const r = await createJob(db, "SS-KEPT01");
  assertEquals(r.status, 200, r.text);
  assertEquals(db.rows("delivery_stops").map((x) => [x.design_short_code, x.serial]), [["SS-KEPT01", 1500], ["SS-ONBRD1", 1510]]);
  assertEquals(db.mints().length, 0);
  assertEquals(ordersWrites(db).length, 0);
});

// ─── 7. Two buildings, two numbers ─────────────────────────────────────────────────────────────
Deno.test("a customer's two buildings get two numbers", async () => {
  const db = world();
  const a = await createJob(db, "SS-NEW001");
  const b = await createJob(db, "SS-NEW002");
  assertEquals([a.status, b.status], [200, 200], a.text + b.text);
  assertEquals([a.body.job.serial, b.body.job.serial], [2000, 2001]);
  assertEquals([db.order("SS-NEW001")!.shop_serial, db.order("SS-NEW002")!.shop_serial], [2000, 2001]);
  assertEquals(db.mints().length, 2);
});

// ─── 8. A stop from a bare design code ─────────────────────────────────────────────────────────
const bareStop = (db: FakeDb, code: string) => call(db, { action: "add_stop", loadId: L1, source: "order", designShortCode: code });

Deno.test("add_stop from a design code shows the building's number, and mints none", async () => {
  const cases: [string, number | null, string][] = [
    ["SS-KEPT01", 1500, "the order's number"],
    ["SS-WINDOW", 1520, "the old code's job number (the deploy window)"],
    ["SS-LOTBUY", 1400, "a lot building's number, through the buyer's design"],
    ["SS-SOLDTO", 1401, "a lot building's number, through the unit sold to that code"],
    ["SS-BARE01", null, "none: never on the build board"],
    ["SS-NEW001", null, "none: another builder's #7777 for the same code is not ours"],
  ];
  for (const [code, want, why] of cases) {
    const db = world();
    const r = await bareStop(db, code);
    assertEquals(r.status, 200, `${code}: ${r.text}`);
    assertEquals(r.body.stop.serial, want, `${code}: ${why}`);
    assertEquals(r.body.stop.design_short_code, code);
    assertEquals(db.mints().length, 0, `${code}: add_stop minted`);
    assertEquals(ordersWrites(db).length, 0, `${code}: add_stop wrote an order`);
    for (const t of ["orders", "build_jobs", "designs", "inventory_units"]) {
      const unscoped = db.calls(t).filter((l) => !has(l.ops, "eq", "client_id", TENANT));
      assertEquals(unscoped.length, 0, `${code}: a ${t} call without the tenant: ${JSON.stringify(unscoped)}`);
    }
    ordersScoped(db);
  }
});

// ─── 9. A stop from a build job ────────────────────────────────────────────────────────────────
Deno.test("add_stop from a build job is unchanged: the job's number, the order not read", async () => {
  const db = world();
  const r = await call(db, { action: "add_stop", loadId: L1, source: "order", buildJobId: J_ONBOARD });
  assertEquals(r.status, 200, r.text);
  assertEquals([r.body.stop.serial, r.body.stop.build_job_id, r.body.stop.design_short_code], [1510, J_ONBOARD, "SS-ONBRD1"]);
  assertEquals(db.calls("orders").length, 0, JSON.stringify(db.calls("orders")));
  assertEquals(db.mints().length, 0);
});

// ─── 10. Delivery after the build board, end to end ────────────────────────────────────────────
Deno.test("on the board, off it, and onto a load by its design code: one number throughout", async () => {
  const db = world();
  const made = await createJob(db, "SS-NEW001");
  await call(db, { action: "delete_job", jobId: made.body.job.id });
  const s = await bareStop(db, "SS-NEW001");
  assertEquals(s.status, 200, s.text);
  assertEquals([made.body.job.serial, s.body.stop.serial], [2000, 2000]);
  assertEquals(db.mints().length, 1);
  ordersScoped(db);
});

// ─── 11. Repair intake ─────────────────────────────────────────────────────────────────────────
Deno.test("repair intake: a typed number or design code finds the building; anything else stays legal", async () => {
  const cases: [string, number | null, string | null, string | null, string][] = [
    ["1500", 1500, "SS-KEPT01", null, "an order building's number links its design"],
    ["#1510", 1510, "SS-ONBRD1", null, "with a # typed in front"],
    ["1400", 1400, "SS-LOTMASTER", U1, "a lot building's number still links the unit"],
    ["ss-kept01", 1500, "SS-KEPT01", null, "a design code fills the building's number"],
    ["SS-WINDOW", 1520, "SS-WINDOW", null, "the deploy window's job number"],
    ["SS-BARE01", null, "SS-BARE01", null, "a building that never had a number: none"],
    ["7777", 7777, null, null, "not one of ours (another builder's number): kept as typed, linked to nothing"],
    ["SS-OTHER9", null, null, null, "a code that is not ours: nothing"],
  ];
  for (const [ref, serial, code, unit, why] of cases) {
    const db = world();
    const r = await call(db, { action: "create_repair", customerName: "Alex Tester", description: "Door sticks", buildingRef: ref });
    assertEquals(r.status, 200, `${ref}: ${r.text}`);
    assertEquals([r.body.repair.serial, r.body.repair.design_short_code, r.body.repair.inventory_unit_id ?? null], [serial, code, unit], `${ref}: ${why}`);
    assertEquals(db.mints().length, 0, `${ref}: a repair minted a number`);
    assertEquals(ordersWrites(db).length, 0);
    ordersScoped(db);
  }
});
