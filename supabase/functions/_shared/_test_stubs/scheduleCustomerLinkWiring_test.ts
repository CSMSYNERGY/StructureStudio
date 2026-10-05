// The customer behind a schedule row (Carolyn 2026-08-28: "If I click on this card ... it takes it
// now to a ... view of that contact ... the same kind of structure from both the build schedule
// and the delivery schedule"), driven through the SHIPPED portal-schedule handler: resolveTenant,
// the GATES table, and the build_board and loads branches with their own reads.
//
//   1. build_board: an ORDER job whose design exists carries customer_link { code, contactId };
//      contactId is null for a design with no customer. Nothing else links: an order job whose
//      design was deleted, an inventory spec build (even a legacy one carrying its master code), a
//      manual job and a repair. The key is ABSENT, not null, on those rows, so an older portal
//      reads the payload it always did. The read asks only for the order codes, on this tenant
//      (another builder's design with the same code links nothing).
//   2. loads: an order stop and a sold unit's SALE stop (the buyer's code) link; the shop-to-lot
//      haul, a repair stop, a manual stop and an order stop whose design is gone do not.
//   3. contacts:'own' (an override on someone who can see the boards) keeps only the customers
//      they own, through crm_visible_contact_ids; a design with no customer is dropped too
//      (crm_record refuses those for 'own'). Nobody else pays for that call.
//   4. never fatal: a failed 'own' check, or a failed designs read, costs the links (and is
//      logged to app_errors) and the board still opens. A failed check never shows everyone's.
//   5. it writes nothing: the only insert is the app_errors row in 4.
//   6. a busy board asks for its codes in slices of 200 (they ride in the URL, and one read
//      answers at most 1000 rows), and every job still gets its link.
//
// HOW. crmInboxWiring_test's idiom: Deno.serve is stubbed while the handler is imported, the import
// map swaps supabase-js for supabase_stub.ts, and its stubDb/stubRpc hooks route every read into
// ONE in-memory database below. The fake applies the filters the code really put on each query,
// pages with .range() the way fetchAll does, and refuses a column the table does not have
// (PostgREST's 42703; the column lists are the live schema's, read 2026-10-05). No network.
//
// Builders, people and designs are made up. The repo is public.

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
const OTHER = "00000000-0000-4000-8000-00000000a002";
const uid = (p: string, n: number) => `00000000-0000-4000-8000-${p}${String(n).padStart(12 - p.length, "0")}`;
const C1 = uid("c", 1), C2 = uid("c", 2), C9 = uid("c", 9);
const U1 = uid("u", 1), U2 = uid("u", 2);
const L1 = uid("l", 1);

// ─── One in-memory database ────────────────────────────────────────────────────────────────────
type Row = Record<string, any>;

// The live schema's columns for the tables whose projections this feature writes or reads.
const COLUMNS: Record<string, string[]> = {
  designs: ["id", "short_code", "client_id", "contact", "selections", "paint_colors", "items", "custom_options", "ro_dimensions", "bldg_w",
    "bldg_h", "image_url", "status", "created_at", "updated_at", "ghl_contact_id", "ghl_estimate_id", "ghl_estimate_number", "ghl_opportunity_id",
    "estimate_lines", "inventory_unit_id", "delivered_at", "ss_quote_number", "ss_quote_pdf_url", "ss_quote_sent_at", "accepted_at",
    "plan_image_url", "view3d_image_url", "contact_id", "ss_invoice_sent_at", "accepted_snapshot", "expected_close_date", "total_cents",
    "created_by_user_id", "updated_by_user_id", "ss_invoice_requested_at", "sales_location_id"],
  build_jobs: ["id", "client_id", "stage_id", "position", "source", "design_short_code", "order_id", "inventory_unit_id", "repair_id", "serial",
    "title", "customer_name", "building_label", "width_ft", "length_ft", "scheduled_start", "due_date", "completed_at", "assignee_user_id",
    "notes", "created_by", "created_at", "updated_at", "roof_type", "roof_color", "body_color", "trim_color", "roof_color_hex", "body_color_hex",
    "trim_color_hex", "crew_id", "changed_at", "changed_co_no", "changed_summary"],
  delivery_stops: ["id", "client_id", "load_id", "stop_order", "source", "build_job_id", "design_short_code", "inventory_unit_id", "repair_id",
    "serial", "customer_name", "customer_phone", "building_label", "width_ft", "length_ft", "pickup", "dest_street", "dest_city", "dest_state",
    "dest_zip", "territory_id", "lat", "lng", "leg_miles", "time_window", "site_notes", "delivered_at", "created_at", "updated_at"],
  inventory_units: ["id", "client_id", "serial", "design_short_code", "location_id", "asking_price_cents", "sold_design_short_code", "created_at",
    "updated_at", "sale_state", "sold_at", "sold_by", "sold_first_name", "sale_released_at", "sale_released_from"],
};

class FakeDb {
  tables: Record<string, Row[]>;
  log: { table: string; ops: any[][] }[] = [];
  /** A read of `table` fails; with `select`, only a read projecting exactly that. */
  fails: { table: string; select?: string }[] = [];
  rpcFails = false;
  constructor(seed: Record<string, Row[]>) { this.tables = structuredClone(seed); }
  rows(t: string): Row[] { return (this.tables[t] ??= []); }
  from(table: string): any { return chain(this, table, []); }
  rpc(fn: string, args?: any): any { return chain(this, `rpc:${fn}`, [["args", args]]); }
  reads(table: string) { return this.log.filter((l) => l.table === table && l.ops.some((o) => o[0] === "select")); }
  inserts() { return this.log.filter((l) => l.ops.some((o) => ["insert", "update", "upsert", "delete"].includes(o[0]))); }
}

function matches(r: Row, ops: any[][]): boolean {
  for (const o of ops) {
    const [op, col, v, w] = o;
    if (op === "eq" && !(r[col] != null && r[col] === v)) return false;
    if (op === "is" && v === null && r[col] != null) return false;
    if (op === "not" && v === "is" && w === null && r[col] == null) return false;
    if (op === "in" && !(v as unknown[]).includes(r[col])) return false;
  }
  return true;
}
const cmp = (a: any, b: any) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1
  : typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));

function run(db: FakeDb, table: string, ops: any[][]): any {
  if (table.startsWith("rpc:")) {
    const fn = table.slice(4), args = ops[0][1];
    if (fn === "crm_visible_contact_ids") {
      if (db.rpcFails) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      // 193's predicate, cut down: the caller owns the customer.
      const mine = db.rows("crm_contacts").filter((x) => x.client_id === args.p_client_id && x.owner_user_id === args.p_user_id).map((x) => x.id);
      return { data: (args.p_ids as string[]).filter((id) => mine.includes(id)), error: null };
    }
    throw new Error(`the fake database has no rpc ${fn}`);
  }
  const verb = ops.find((o) => ["select", "insert", "update", "upsert", "delete"].includes(o[0])) ?? ["select", "*"];
  if (verb[0] === "insert") {
    for (const r of [verb[1]].flat()) db.rows(table).push({ ...r });
    return { data: null, error: null };
  }
  if (verb[0] !== "select") throw new Error(`TEST FAILURE: ${verb[0]} on ${table} — these reads must not write`);
  const sel = String(verb[1]);
  if (db.fails.some((f) => f.table === table && (f.select === undefined || f.select === sel))) {
    return { data: null, error: { code: "08006", message: "connection lost" } };
  }
  const filters = ops.filter((o) => o[0] !== "select");
  const plain = sel === "*" ? null : sel.split(",").map((s) => s.trim());
  const named = [...(plain ?? []), ...filters.filter((o) => ["eq", "is", "not", "in", "order"].includes(o[0])).map((o) => o[1])];
  const cols = COLUMNS[table];
  const bad = cols ? named.filter((n) => !cols.includes(n)) : [];
  if (bad.length) return { data: null, error: { code: "42703", message: `column ${table}.${bad[0]} does not exist` } };
  let out = db.rows(table).filter((r) => matches(r, filters));
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
  const projected = out.map((r) => (plain ? Object.fromEntries(plain.map((k) => [k, r[k] ?? null])) : { ...r }));
  if (filters.some((o) => o[0] === "maybeSingle")) return { data: projected[0] ?? null, error: null };
  return { data: projected, error: null };
}

function chain(db: FakeDb, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(db, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "upsert", "delete", "eq", "is", "not", "in", "order", "range", "limit", "maybeSingle", "single"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    db.log.push({ table, ops });
    return Promise.resolve().then(() => run(db, table, ops)).then(ok, bad);
  };
  return q;
}

// ─── The world one call runs in ────────────────────────────────────────────────────────────────
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

async function call(db: FakeDb, payload: Row, user = ME) {
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((u: unknown) => Promise.reject(new Error(`TEST FAILURE: unexpected fetch ${String(u)}`))) as typeof fetch;
  stubAuth.user = { id: user, email: "person@example.test" };
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
const design = (code: string, contactId: string | null, extra: Row = {}): Row => ({
  id: `d-${code}`, short_code: code, client_id: TENANT, contact_id: contactId, contact: { name: `Buyer of ${code}` },
  selections: { style: "gable", size: "10x12" }, status: "invoiced", inventory_unit_id: null, ...extra,
});
const job = (id: string, source: string, code: string | null, extra: Row = {}): Row => ({
  id, client_id: TENANT, stage_id: "st-queue", position: Number(id.replace(/\D/g, "")), source, design_short_code: code,
  inventory_unit_id: null, repair_id: null, serial: null, title: null, customer_name: `Customer on ${id}`, building_label: "Gable 10x12",
  width_ft: 10, length_ft: 12, due_date: "2026-10-07", crew_id: null, ...extra,
});
const stop = (id: string, source: string, code: string | null, extra: Row = {}): Row => ({
  id, client_id: TENANT, load_id: L1, stop_order: Number(id.replace(/\D/g, "")), source, build_job_id: null, design_short_code: code,
  inventory_unit_id: null, repair_id: null, serial: null, customer_name: `Customer on ${id}`, building_label: "Gable 10x12", width_ft: 10,
  length_ft: 12, delivered_at: null, ...extra,
});

function world(opts: { role?: string; title?: string | null; access?: Row | null } = {}): FakeDb {
  return new FakeDb({
    client_users: [
      { user_id: ME, client_id: TENANT, role: opts.role ?? "owner", title: opts.title ?? null, access: opts.access ?? null, full_name: "Pat Owner" },
      { user_id: OTHER, client_id: TENANT, role: "user", title: "sales_rep", access: null, full_name: "Sam Rep" },
    ],
    schedule_stages: [
      { id: "st-queue", client_id: TENANT, name: "Queue", kind: "queue", sort_order: 0, color: "#94A3B8" },
      { id: "st-done", client_id: TENANT, name: "Built", kind: "done", sort_order: 1, color: "#22C55E" },
    ],
    crm_contacts: [
      { id: C1, client_id: TENANT, name: "Alex Tester", owner_user_id: ME, merged_into: null },
      { id: C2, client_id: TENANT, name: "Blair Example", owner_user_id: OTHER, merged_into: null },
      { id: C9, client_id: BYSTANDER, name: "Someone Else's Customer", owner_user_id: null, merged_into: null },
    ],
    designs: [
      design("ORD1", C1),
      design("ORD2", C2),
      design("ORDNC", null),                                        // no phone, no email: no customer
      design("MASTER1", null, { status: "draft" }),                 // the builder's own lot design
      design("BUY1", C1, { status: "accepted" }),                   // the buyer of lot building #1001
      design("TRAY1", C1),                                          // sold, not on the board yet: the tray
      { ...design("GONE1", C9), client_id: BYSTANDER },             // GONE1 on THIS tenant was deleted
    ],
    build_jobs: [
      job("j1", "order", "ORD1"),
      job("j2", "order", "GONE1"),
      job("j3", "inventory", null, { inventory_unit_id: U1, customer_name: null }),
      job("j4", "manual", null, { title: "Shop sign" }),
      job("j5", "repair", null, { repair_id: "r-1" }),
      job("j6", "order", "ORDNC"),
      job("j7", "order", "ORD2"),
      job("j8", "inventory", "MASTER1", { inventory_unit_id: U2, customer_name: null }),   // a legacy row carrying the master code
    ],
    inventory_units: [
      { id: U1, client_id: TENANT, serial: "1001", design_short_code: "MASTER1", sold_design_short_code: "BUY1", sale_state: "sold", sold_first_name: "Alex", asking_price_cents: 650000 },
      { id: U2, client_id: TENANT, serial: "1002", design_short_code: "MASTER1", sold_design_short_code: null, sale_state: "available", sold_first_name: null, asking_price_cents: 650000 },
    ],
    repairs: [],
    build_crews: [],
    orders: [],
    delivery_loads: [{ id: L1, client_id: TENANT, load_no: 7, load_date: "2026-10-08", status: "planned", driver_id: null }],
    delivery_stops: [
      stop("s1", "order", "ORD1", { build_job_id: "j1" }),
      stop("s2", "inventory", "BUY1", { inventory_unit_id: U1, serial: "1001" }),   // the sale delivery
      stop("s3", "inventory", null, { inventory_unit_id: U2, serial: "1002" }),     // shop to lot
      stop("s4", "repair", null, { repair_id: "r-1" }),
      stop("s5", "manual", null),
      stop("s6", "order", "GONE1"),
      stop("s7", "order", "ORD2", { build_job_id: "j7" }),
    ],
    driver_profiles: [],
    delivery_territories: [],
    app_errors: [],
    admin_audit: [],
  });
}
const linksOf = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.id, "customer_link" in r ? r.customer_link : "absent"]));
/** The designs reads this feature made (the tray's and the masters' project other columns). */
const linkReads = (db: FakeDb) => db.reads("designs").filter((l) => l.ops.some((o) => o[0] === "select" && o[1] === "short_code, contact_id"));

// ─── 1. build_board ────────────────────────────────────────────────────────────────────────────
Deno.test("build_board: an order job whose design exists links to its customer; nothing else links", async () => {
  const db = world();
  const r = await call(db, { action: "build_board" });
  assertEquals(r.status, 200, r.text);
  assertEquals(linksOf(r.body.jobs), {
    j1: { code: "ORD1", contactId: C1 },
    j2: "absent",                                   // the design was deleted (another builder's GONE1 is not it)
    j3: "absent",                                   // a spec build
    j4: "absent",
    j5: "absent",
    j6: { code: "ORDNC", contactId: null },         // a design with no customer: the portal opens the design
    j7: { code: "ORD2", contactId: C2 },
    j8: "absent",                                   // an inventory job, even carrying a code
  });
  // The rest of each job is untouched (the value the calendar totals read is still there).
  const j1 = r.body.jobs.find((j: Row) => j.id === "j1");
  assertEquals([j1.customer_name, j1.design_short_code, "valueCents" in j1], ["Customer on j1", "ORD1", true]);
  // One read, of this tenant's designs, for the ORDER codes only.
  const reads = linkReads(db);
  assertEquals(reads.length, 1, JSON.stringify(reads));
  assert(reads[0].ops.some((o) => o[0] === "eq" && o[1] === "client_id" && o[2] === TENANT), "the designs read isn't scoped to the tenant");
  assertEquals([...reads[0].ops.find((o) => o[0] === "in")![2]].sort(), ["GONE1", "ORD1", "ORD2", "ORDNC"]);
  assertEquals(db.log.filter((l) => l.table === "rpc:crm_visible_contact_ids").length, 0, "an owner paid for the 'own' check");
  assertEquals(db.inserts().length, 0, JSON.stringify(db.inserts()));
});

// ─── 2. loads ──────────────────────────────────────────────────────────────────────────────────
Deno.test("loads: an order stop and a sold unit's sale stop link; the haul, repair, manual and a deleted design do not", async () => {
  const db = world();
  const r = await call(db, { action: "loads" });
  assertEquals(r.status, 200, r.text);
  assertEquals(linksOf(r.body.stops), {
    s1: { code: "ORD1", contactId: C1 },
    s2: { code: "BUY1", contactId: C1 },            // the buyer, through the sale stop's code
    s3: "absent",
    s4: "absent",
    s5: "absent",
    s6: "absent",
    s7: { code: "ORD2", contactId: C2 },
  });
  const reads = linkReads(db);
  assertEquals(reads.length, 1);
  assert(reads[0].ops.some((o) => o[0] === "eq" && o[1] === "client_id" && o[2] === TENANT));
  assertEquals([...reads[0].ops.find((o) => o[0] === "in")![2]].sort(), ["BUY1", "GONE1", "ORD1", "ORD2"]);
  // The rest of the payload is the same shape it always was.
  assertEquals(Object.keys(r.body).sort(), ["buildByJob", "drivers", "loads", "stops", "team", "territories", "unitLifecycle"]);
  assertEquals(r.body.stops.map((s: Row) => s.id), ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
  assertEquals(db.inserts().length, 0, JSON.stringify(db.inserts()));
});

Deno.test("an empty board asks nothing about designs", async () => {
  const db = world();
  db.tables.build_jobs = [];
  db.tables.delivery_stops = [];
  const b = await call(db, { action: "build_board" });
  const l = await call(db, { action: "loads" });
  assertEquals([b.status, l.status], [200, 200]);
  assertEquals(linkReads(db).length, 0);
});

Deno.test("a busy board asks in slices, and every order job still gets its link", async () => {
  const db = world();
  const many = Array.from({ length: 450 }, (_, i) => `BIG${String(i).padStart(4, "0")}`);
  db.tables.designs.push(...many.map((code) => design(code, C1)));
  db.tables.build_jobs = many.map((code, i) => job(`j${1000 + i}`, "order", code));
  const r = await call(db, { action: "build_board" });
  assertEquals(r.status, 200, r.text);
  assertEquals(r.body.jobs.filter((j: Row) => j.customer_link?.contactId === C1).length, 450);
  const sizes = linkReads(db).map((l) => l.ops.find((o) => o[0] === "in")![2].length);
  assertEquals(sizes, [200, 200, 50]);
});

// ─── 3. contacts:'own' ─────────────────────────────────────────────────────────────────────────
const OWN = { role: "user", title: "sales_rep", access: { contacts: "own", build_schedule: "view", delivery_schedule: "view" } };

Deno.test("contacts:'own' links only their own customers, through crm_visible_contact_ids", async () => {
  const db = world(OWN);
  const b = await call(db, { action: "build_board" });
  assertEquals(b.status, 200, b.text);
  const jobs = linksOf(b.body.jobs);
  assertEquals([jobs.j1, jobs.j6, jobs.j7], [{ code: "ORD1", contactId: C1 }, "absent", "absent"]);
  const rpc = db.log.filter((l) => l.table === "rpc:crm_visible_contact_ids");
  assertEquals(rpc.length, 1);
  assertEquals([rpc[0].ops[0][1].p_client_id, rpc[0].ops[0][1].p_user_id, [...rpc[0].ops[0][1].p_ids].sort()], [TENANT, ME, [C1, C2].sort()]);

  const l = await call(db, { action: "loads" });
  assertEquals(l.status, 200, l.text);
  const stops = linksOf(l.body.stops);
  assertEquals([stops.s1, stops.s2, stops.s7], [{ code: "ORD1", contactId: C1 }, { code: "BUY1", contactId: C1 }, "absent"]);
});

// ─── 4. Never fatal ────────────────────────────────────────────────────────────────────────────
Deno.test("a failed 'own' check shows nobody's link, logs it, and the board still opens", async () => {
  const db = world(OWN);
  db.rpcFails = true;
  const b = await call(db, { action: "build_board" });
  assertEquals(b.status, 200, b.text);
  assertEquals(b.body.jobs.filter((j: Row) => "customer_link" in j).length, 0, "a failed check still linked someone");
  assertEquals(b.body.jobs.length, 8, "the board lost jobs");
  const logged = db.rows("app_errors");
  assertEquals(logged.length, 1, JSON.stringify(logged));
  assert(/crm_visible_contact_ids failed/.test(logged[0].message), logged[0].message);
  assertEquals([logged[0].source, logged[0].client_id, logged[0].severity], ["edge:portal-schedule", TENANT, "error"]);

  const l = await call(db, { action: "loads" });
  assertEquals(l.status, 200, l.text);
  assertEquals(l.body.stops.filter((s: Row) => "customer_link" in s).length, 0);
});

Deno.test("a failed designs read costs only the links", async () => {
  const db = world();
  db.fails.push({ table: "designs", select: "short_code, contact_id" });
  const b = await call(db, { action: "build_board" });
  assertEquals(b.status, 200, b.text);
  assertEquals(b.body.jobs.filter((j: Row) => "customer_link" in j).length, 0);
  assertEquals(b.body.jobs.length, 8);
  assertEquals(b.body.tray.orders.length > 0, true, "the tray's own designs read was affected");
  const l = await call(db, { action: "loads" });
  assertEquals(l.status, 200, l.text);
  assertEquals(l.body.stops.length, 7);
  assertEquals(l.body.stops.filter((s: Row) => "customer_link" in s).length, 0);
  const logged = db.rows("app_errors");
  assertEquals(logged.length, 2, JSON.stringify(logged));
  assert(logged.every((e) => /customer links: designs read failed/.test(e.message)), JSON.stringify(logged));
});

// ─── The gates did not move ────────────────────────────────────────────────────────────────────
Deno.test("the gates are unchanged: no build_schedule access, no board", async () => {
  const r = await call(world({ role: "user", title: "driver", access: null }), { action: "build_board" });
  assertEquals(r.status, 403, r.text);
  const d = await call(world({ role: "user", title: "crew_member", access: null }), { action: "loads" });
  assertEquals(d.status, 403, d.text);
});
