// Execute migration 284 for real in PGlite (Postgres compiled to WASM, in memory) on top of orders,
// build_jobs, delivery_stops, inventory_units and client_settings as they are live, then check what
// the file promises:
//   * orders.shop_serial arrives as a nullable bigint with its comment, 199's table comment names it,
//     and a partial unique index allows one building per number per builder (another builder may
//     use the same number; any number of orders may have none);
//   * the fill: from the building's ORDER build job; for a building with no order job, from its one
//     ORDER stop; nothing for an inventory sale (the unit owns that number, even when the sale's
//     order stop carries it, linked either way), a counter sale with no design, a building that
//     never had a number, or another tenant's order with the same code;
//   * the realign: an UNDELIVERED order stop takes its building's number (a stale one, and one that
//     had none); a DELIVERED stop is history and keeps its number and its updated_at;
//   * nothing else moves: no build job, no other order column (updated_at included);
//   * the browser still cannot UPDATE the column, service_role can, and the edge function's
//     conditional write is a no-op on a building that already has a number;
//   * THE RECORD, the one row `supabase db query` prints, read back as the apply shows it; a re-apply
//     changes nothing and prints zeros; it is also the post-deploy read-back: an order job the OLD
//     code created in the window is recorded, and a job it re-created on a numbered building is
//     refused until the job is put back on the building's number;
//   * a dry run (last commit; swapped for rollback;) prints the same record and leaves nothing;
//     a Windows (CRLF) checkout applies the same; the header's ROLLBACK runs as written;
//   * broken shapes are refused with the WHOLE file rolled back (mutants): two buildings on one
//     number, a number a lot building holds, a counter at or below a held number, a file that
//     touches delivered stops, skips the realign, bumps orders.updated_at or writes build jobs,
//     a fill that numbers an inventory sale (each half of its guard), a non-unique index, and
//     orders UPDATE-able from the browser.
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants, codes and numbers are made up. The repo is public: no real client id or serial belongs
// in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration284.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
// LF, whatever the checkout: the mutants below splice LF-only text, and on a CRLF checkout
// (core.autocrlf) they would not find their anchors. The CRLF check builds its own copy.
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/284_building_shop_serial.sql"), "utf8").replace(/\r/g, "");

// 199's comment on orders, lifted from 199 itself so the stub and the rollback check compare
// against the real text and not a copy that could drift.
const COMMENT_199 = (() => {
  const src = fs.readFileSync(path.join(WT, "supabase/migrations/199_orders_update_column_grant.sql"), "utf8");
  const m = src.match(/comment on table public\.orders is\s*\r?\n\s*('(?:[^']|'')*');/);
  if (!m) throw new Error("199's orders comment moved; re-point COMMENT_199");
  return m[1];
})();
const unquote = (lit) => lit.slice(1, -1).replace(/''/g, "'");

// The live shapes (information_schema / pg_indexes / pg_constraint / pg_class.relacl, 2026-10-07),
// cut to what 284 reads or writes. orders: RLS on, authenticated with table-level SELECT and INSERT
// but UPDATE only on 199's three columns, service_role everything. build_jobs, delivery_stops and
// inventory_units: the one-per-design / one-per-unit / one-serial-per-tenant uniques 284 leans on.
// designs: only what the fill's inventory-sale guard reads (short_code is unique across tenants
// live, designs_short_code_key). client_settings: service-role only. No trigger on build_jobs or delivery_stops (live has none);
// orders' BEFORE INSERT order_no trigger is left out, the seeds give order_no themselves.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);
insert into supabase_migrations.schema_migrations (version, name) values ('284', '284_building_shop_serial');

create table public.client_settings (
  client_id text primary key, next_serial bigint, updated_at timestamptz not null default now()
);
alter table public.client_settings enable row level security;
grant all on public.client_settings to service_role;

create table public.orders (
  id uuid primary key default gen_random_uuid(), client_id text not null, short_code text, order_no integer,
  total_cents integer, currency text not null default 'USD', total_source text not null default 'pending',
  ordered_at timestamptz not null default now(), notes text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), submitter_user_id uuid, pretax_subtotal_cents integer,
  tax_cents integer, building_serial text,
  constraint orders_client_id_short_code_key unique (client_id, short_code),
  constraint orders_client_id_order_no_key unique (client_id, order_no),
  constraint orders_id_client_uniq unique (id, client_id)
);
create unique index orders_building_serial_uniq on public.orders (client_id, building_serial) where building_serial is not null;
alter table public.orders enable row level security;
create policy orders_owner_select on public.orders for select to authenticated using (true);
grant select, insert, references, trigger on public.orders to authenticated;
grant update (total_cents, total_source, updated_at) on public.orders to authenticated;
grant all on public.orders to service_role;
comment on table public.orders is ${COMMENT_199};

create table public.inventory_units (
  id uuid primary key default gen_random_uuid(), client_id text not null, serial bigint not null,
  design_short_code text not null, sold_design_short_code text, sale_state text not null default 'unsold',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint inventory_units_client_id_serial_key unique (client_id, serial)
);
create unique index inventory_units_one_sale_per_design on public.inventory_units (client_id, sold_design_short_code) where sold_design_short_code is not null;

create table public.designs (
  id uuid primary key default gen_random_uuid(), short_code text not null, client_id text not null,
  status text not null default 'invoiced', inventory_unit_id uuid references public.inventory_units(id) on delete set null,
  constraint designs_short_code_key unique (short_code)
);

create table public.build_jobs (
  id uuid primary key default gen_random_uuid(), client_id text not null, stage_id uuid not null,
  position numeric not null default 0,
  source text not null check (source = any (array['order', 'inventory', 'repair', 'manual'])),
  design_short_code text, order_id uuid, inventory_unit_id uuid references public.inventory_units(id) on delete set null,
  repair_id uuid, serial bigint, title text, customer_name text, completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index build_jobs_one_per_design on public.build_jobs (client_id, design_short_code) where design_short_code is not null;
create unique index build_jobs_one_per_unit on public.build_jobs (client_id, inventory_unit_id) where inventory_unit_id is not null;

create table public.delivery_stops (
  id uuid primary key default gen_random_uuid(), client_id text not null, load_id uuid not null,
  stop_order integer not null default 1,
  source text not null check (source = any (array['order', 'inventory', 'repair', 'manual'])),
  build_job_id uuid references public.build_jobs(id) on delete set null, design_short_code text,
  inventory_unit_id uuid references public.inventory_units(id) on delete set null, repair_id uuid, serial bigint,
  customer_name text, delivered_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index delivery_stops_one_per_design on public.delivery_stops (client_id, design_short_code) where design_short_code is not null;

alter table public.build_jobs enable row level security;
alter table public.delivery_stops enable row level security;
alter table public.inventory_units enable row level security;
grant select on public.build_jobs, public.delivery_stops, public.inventory_units to anon;
grant all on public.build_jobs, public.delivery_stops, public.inventory_units to authenticated, service_role;
`;

// Fixed ids, so the record's per-stop detail reads the same on every run.
const id = (p, n) => `00000000-0000-4000-8000-${p}${String(n).padStart(12 - p.length, "0")}`;
const STAGE = id("5", 1), LOAD = id("10", 1);   // hex prefixes only: these are uuids
const OLD = "2026-09-01 10:00+00";

// Two made-up builders. acme-sheds is the live mix in miniature; bravo-barns uses the SAME numbers
// and one of the SAME design codes, to prove the tenant is part of every join.
//   A1  order + job #1001                                    -> 1001 from the job
//   A2  order, job deleted, its stop still carries #1002      -> 1002 from the stop (stop unchanged)
//   A3  order + job #1010, OPEN stop carrying stale #1003     -> 1010, the stop realigned to 1010
//   A4  order + job #1011, DELIVERED stop carrying #1004      -> 1011, the delivered stop untouched
//   A5  inventory sale of lot building #1005 (sale stop)      -> null, the unit owns it
//   A6  counter sale, no design code                          -> null
//   A7  order, never on a board                               -> null
//   A8  order, bare-code stop with no number                  -> null, the stop untouched
//   A9  inventory sale of lot building #1007, linked by the buyer's design; its ORDER stop (added
//       from the buyer's code) carries #1007                   -> null, the stop untouched
//   A10 inventory sale of lot building #1008, linked by the unit's sold-to code; the same kind of
//       stop carrying #1008                                     -> null, the stop untouched
//   plus a spec build of lot building #1006 and a manual job, neither touched.
//   B1  order + job #1001 (the same number as A1)             -> 1001
//   B3  order SS-ACME0003 (A3's code) + job #1020, open stop #1020 -> 1020, nothing to realign
//   B4  order + job #1030, OPEN stop with no number           -> 1030, the stop realigned to 1030
const SEED = `
insert into public.client_settings (client_id, next_serial) values ('acme-sheds', 1100), ('bravo-barns', 1050);

insert into public.orders (id, client_id, short_code, order_no, total_cents, updated_at, building_serial) values
  ('${id("a", 1)}', 'acme-sheds',  'SS-ACME0001', 5001, 650000, '${OLD}', null),
  ('${id("a", 2)}', 'acme-sheds',  'SS-ACME0002', 5002, 720000, '${OLD}', null),
  ('${id("a", 3)}', 'acme-sheds',  'SS-ACME0003', 5003, 810000, '${OLD}', '0901TST1016RDWHBKS5003'),
  ('${id("a", 4)}', 'acme-sheds',  'SS-ACME0004', 5004, 455000, '${OLD}', '0815TST0812RDWHBKM5004'),
  ('${id("a", 5)}', 'acme-sheds',  'SS-ACME0005', 5005, 399000, '${OLD}', null),
  ('${id("a", 6)}', 'acme-sheds',  null,          5006, 120000, '${OLD}', null),
  ('${id("a", 7)}', 'acme-sheds',  'SS-ACME0007', 5007, 500000, '${OLD}', null),
  ('${id("a", 8)}', 'acme-sheds',  'SS-ACME0008', 5008, 610000, '${OLD}', null),
  ('${id("a", 9)}', 'acme-sheds',  'SS-ACME0009', 5009, 410000, '${OLD}', null),
  ('${id("a", 10)}', 'acme-sheds', 'SS-ACME0010', 5010, 420000, '${OLD}', null),
  ('${id("b", 1)}', 'bravo-barns', 'SS-BRAV0001', 7001, 300000, '${OLD}', null),
  ('${id("b", 3)}', 'bravo-barns', 'SS-ACME0003', 7003, 300000, '${OLD}', null),
  ('${id("b", 4)}', 'bravo-barns', 'SS-BRAV0004', 7004, 300000, '${OLD}', null);

insert into public.inventory_units (id, client_id, serial, design_short_code, sold_design_short_code, sale_state) values
  ('${id("e", 1)}', 'acme-sheds', 1005, 'SS-ACMELOT1', 'SS-ACME0005', 'sold'),
  ('${id("e", 2)}', 'acme-sheds', 1006, 'SS-ACMELOT1', null, 'unsold'),
  ('${id("e", 3)}', 'acme-sheds', 1007, 'SS-ACMELOT1', null, 'unsold'),
  ('${id("e", 4)}', 'acme-sheds', 1008, 'SS-ACMELOT1', 'SS-ACME0010', 'sold');

-- Only the designs the guard has to tell apart: a plain order's (no unit) and A9's (the unit).
insert into public.designs (short_code, client_id, inventory_unit_id) values
  ('SS-ACME0001', 'acme-sheds', null),
  ('SS-ACME0009', 'acme-sheds', '${id("e", 3)}');

insert into public.build_jobs (id, client_id, stage_id, source, design_short_code, inventory_unit_id, serial, title, updated_at) values
  ('${id("c", 1)}', 'acme-sheds',  '${STAGE}', 'order',     'SS-ACME0001', null,             1001, null,        '${OLD}'),
  ('${id("c", 3)}', 'acme-sheds',  '${STAGE}', 'order',     'SS-ACME0003', null,             1010, null,        '${OLD}'),
  ('${id("c", 4)}', 'acme-sheds',  '${STAGE}', 'order',     'SS-ACME0004', null,             1011, null,        '${OLD}'),
  ('${id("c", 5)}', 'acme-sheds',  '${STAGE}', 'inventory', null,          '${id("e", 2)}', 1006, null,        '${OLD}'),
  ('${id("c", 6)}', 'acme-sheds',  '${STAGE}', 'manual',    null,          null,             null, 'Shop sign', '${OLD}'),
  ('${id("cb", 1)}', 'bravo-barns', '${STAGE}', 'order',     'SS-BRAV0001', null,             1001, null,        '${OLD}'),
  ('${id("cb", 3)}', 'bravo-barns', '${STAGE}', 'order',     'SS-ACME0003', null,             1020, null,        '${OLD}'),
  ('${id("cb", 4)}', 'bravo-barns', '${STAGE}', 'order',     'SS-BRAV0004', null,             1030, null,        '${OLD}');

insert into public.delivery_stops (id, client_id, load_id, source, build_job_id, design_short_code, inventory_unit_id, serial, delivered_at, updated_at) values
  ('${id("d", 2)}', 'acme-sheds',  '${LOAD}', 'order',     null,             'SS-ACME0002', null,             1002, null,                   '${OLD}'),
  ('${id("d", 3)}', 'acme-sheds',  '${LOAD}', 'order',     '${id("c", 3)}', 'SS-ACME0003', null,             1003, null,                   '${OLD}'),
  ('${id("d", 4)}', 'acme-sheds',  '${LOAD}', 'order',     '${id("c", 4)}', 'SS-ACME0004', null,             1004, '2026-09-20 15:00+00', '${OLD}'),
  ('${id("d", 5)}', 'acme-sheds',  '${LOAD}', 'inventory', null,             'SS-ACME0005', '${id("e", 1)}', 1005, null,                   '${OLD}'),
  ('${id("d", 8)}', 'acme-sheds',  '${LOAD}', 'order',     null,             'SS-ACME0008', null,             null, null,                   '${OLD}'),
  ('${id("d", 9)}', 'acme-sheds',  '${LOAD}', 'order',     null,             'SS-ACME0009', null,             1007, null,                   '${OLD}'),
  ('${id("d", 10)}', 'acme-sheds', '${LOAD}', 'order',     null,             'SS-ACME0010', null,             1008, null,                   '${OLD}'),
  ('${id("db", 3)}', 'bravo-barns', '${LOAD}', 'order',     '${id("cb", 3)}', 'SS-ACME0003', null,             1020, null,                   '${OLD}'),
  ('${id("db", 4)}', 'bravo-barns', '${LOAD}', 'order',     null,             'SS-BRAV0004', null,             null, null,                   '${OLD}');
`;

const EXPECT_SERIALS = {
  [id("a", 1)]: "1001", [id("a", 2)]: "1002", [id("a", 3)]: "1010", [id("a", 4)]: "1011",
  [id("a", 5)]: null, [id("a", 6)]: null, [id("a", 7)]: null, [id("a", 8)]: null, [id("a", 9)]: null, [id("a", 10)]: null,
  [id("b", 1)]: "1001", [id("b", 3)]: "1020", [id("b", 4)]: "1030",
};
const EXPECT_RECORD = {
  migration: "284", filled_from_jobs: 6, filled_from_stops: 1, stops_realigned: 2,
  stops_realigned_detail: `${id("d", 3)}: 1003 -> 1010, ${id("db", 4)}: none -> 1030`,
  orders_with_shop_serial: 7, order_jobs_mismatched: 0, open_stops_mismatched: 0,
};

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

async function fresh() {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(SEED);
  return db;
}
async function apply(db, sql = MIG_TEXT()) {
  const notices = [];
  const results = await db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
  // THE RECORD: what `supabase db query` prints is the rows of the last statement that returns any.
  const last = [...results].reverse().find((r) => r.rows && r.rows.length);
  notices.record = last ? last.rows[0] : null;
  return notices;
}
// The file as a dry run: its last `commit;` swapped for `rollback;`.
const DRY_RUN = () => {
  const t = MIG_TEXT();
  const i = t.lastIndexOf("\ncommit;");
  return t.slice(0, i) + "\nrollback;" + t.slice(i + "\ncommit;".length);
};
// The header's ROLLBACK block, exactly as a human would copy it out: the indented statement lines
// between "── ROLLBACK" and the paragraph that follows them, with the comment marker taken off.
const ROLLBACK_SQL = () => {
  const lines = MIG_TEXT().split("\n");
  const start = lines.findIndex((l) => /^-- ── ROLLBACK/.test(l));
  if (start < 0) throw new Error("the ROLLBACK heading moved");
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (!/^--   /.test(l)) break;
    out.push(l.replace(/^--   /, ""));
  }
  return out.join("\n");
};

const hasColumn = async (db) => !!(await one(db, `select 1 as x from information_schema.columns
  where table_schema = 'public' and table_name = 'orders' and column_name = 'shop_serial'`));
const serials = async (db) => Object.fromEntries((await rows(db, "select id, shop_serial::text as s from public.orders order by id"))
  .map((r) => [r.id, r.s]));
// Everything 284 could touch, as text, for "did anything move" comparisons.
const snapshot = async (db) => JSON.stringify({
  orders: await rows(db, `select (to_jsonb(o) - 'shop_serial')::text as r from public.orders o order by id`),
  jobs: await rows(db, "select id, serial::text, updated_at::text from public.build_jobs order by id"),
  stops: await rows(db, "select id, serial::text, updated_at::text from public.delivery_stops order by id"),
  units: await rows(db, "select id, serial::text from public.inventory_units order by id"),
  counters: await rows(db, "select client_id, next_serial::text from public.client_settings order by client_id"),
});
// `untouched`: updated_at is still the seed's (compared as a timestamp, so the machine's zone is moot).
const stop = async (db, n) => one(db, `select serial::text as serial, updated_at = '${OLD}'::timestamptz as untouched
  from public.delivery_stops where id = $1`, [n]);
const tableComment = async (db) => (await one(db, "select obj_description('public.orders'::regclass, 'pg_class') as c")).c;
const columnComment = async (db) => (await one(db, `select col_description('public.orders'::regclass,
  (select attnum from pg_attribute where attrelid = 'public.orders'::regclass and attname = 'shop_serial')) as c`)).c;

// A statement run as a given role, in its own transaction: the error message, or null.
async function as(db, role, sql, params) {
  await db.exec("begin");
  await db.exec(`set local role ${role}`);
  let err = null, res = null;
  try { res = await db.query(sql, params); } catch (e) { err = e.message; }
  await db.exec(err ? "rollback" : "commit");
  return { err, rows: res ? res.rows : null };
}

// Did the apply fail with `re`, and leave nothing behind?
async function refused(db, sql, re) {
  const before = await snapshot(db);
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e.message; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  return {
    err, matched: !!err && re.test(err),
    columnGone: !(await hasColumn(db)),
    rowsKept: (await snapshot(db)) === before,
  };
}

(async () => {
  // ── 1. The apply on the live shape ──────────────────────────────────────────────────────────
  console.log("migration 284: applies on the live shape; each building gets the number it already had");
  {
    const db = await fresh();
    const before = await rows(db, "select id, (to_jsonb(o))::text as r from public.orders o order by id");
    const jobsBefore = await rows(db, "select id, serial::text, updated_at::text from public.build_jobs order by id");
    let notices = [];
    try { notices = await apply(db); ok(true, "284 applied cleanly, its own checks included"); }
    catch (e) { ok(false, "284 applied", e.message); }
    ok(notices.some((n) => /284: checks hold; 6 filled from build jobs, 1 from stops, 2 open stop\(s\) realigned; 7 building\(s\) hold a shop serial$/.test(n)),
      "its own checks held, and the notice carries the counts", notices.join(" | "));
    ok(JSON.stringify(notices.record) === JSON.stringify(EXPECT_RECORD),
      "THE RECORD, the row the CLI prints: 6 from jobs, 1 from a stop, 2 open stops realigned (each listed old -> new), 7 numbered, nothing mismatched",
      JSON.stringify(notices.record));

    const got = await serials(db);
    ok(JSON.stringify(got) === JSON.stringify(EXPECT_SERIALS), "each order holds exactly the number its building already had", JSON.stringify(got));
    ok(got[id("a", 5)] === null, "the inventory sale stays empty: lot building #1005 keeps its number on the unit");
    ok(got[id("a", 9)] === null && got[id("a", 10)] === null,
      "an inventory sale whose ORDER stop carries the unit's number stays empty too, linked by the design or by the unit");
    ok(got[id("a", 1)] === "1001" && got[id("b", 1)] === "1001", "two builders may each have a #1001");
    ok(got[id("a", 3)] === "1010" && got[id("b", 3)] === "1020", "the same design code on two tenants: each order takes its own tenant's job");

    const s3 = await stop(db, id("d", 3)), s4 = await stop(db, id("d", 4)), t4 = await stop(db, id("db", 4));
    ok(s3.serial === "1010" && s3.untouched === false,
      "the open stop with a stale number now shows the build board's, and its updated_at moved", JSON.stringify(s3));
    ok(t4.serial === "1030", "an open stop with no number gets its building's", JSON.stringify(t4));
    ok(s4.serial === "1004" && s4.untouched === true, "the DELIVERED stop keeps the number that went out the door, and its updated_at", JSON.stringify(s4));
    for (const [n, want] of [[id("d", 2), "1002"], [id("d", 5), "1005"], [id("d", 8), null], [id("d", 9), "1007"], [id("d", 10), "1008"], [id("db", 3), "1020"]]) {
      const s = await stop(db, n);
      ok(s.serial === want && s.untouched === true, `stop ${n.slice(-3)} untouched (${want ?? "no number"})`, JSON.stringify(s));
    }

    const after = await rows(db, "select id, (to_jsonb(o) - 'shop_serial')::text as r from public.orders o order by id");
    const norm = (list) => JSON.stringify(list.map((r) => JSON.parse(r.r)));
    ok(norm(after) === norm(before),
      "every other order column is what it was, updated_at and building_serial included");
    ok(JSON.stringify(await rows(db, "select id, serial::text, updated_at::text from public.build_jobs order by id")) === JSON.stringify(jobsBefore),
      "no build job moved");

    const col = await one(db, `select data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'orders' and column_name = 'shop_serial'`);
    ok(col && col.data_type === "bigint" && col.is_nullable === "YES" && col.column_default === null, "shop_serial is a nullable bigint with no default", JSON.stringify(col));
    const cc = await columnComment(db);
    ok(/SHOP SERIAL/.test(cc || "") && /issued ONCE/.test(cc || "") && /building_serial \(163\)/.test(cc || "") && /inventory sale/.test(cc || ""),
      "the column comment names the shop counter and says it is not the tag code", cc);
    const tc = await tableComment(db);
    ok(tc === unquote(COMMENT_199).replace("building_serial, submitter_user_id", "building_serial, shop_serial, submitter_user_id")
      .replace("the first two are the commission base.", "the first two are the commission base, and shop_serial (284) is a number printed on a building."),
      "199's table comment, with shop_serial added to the service-role-written list", tc);
    ok((await one(db, "select to_regclass('pg_temp.m284_orders_before') is null and to_regclass('pg_temp.m284_jobs_before') is null and to_regclass('pg_temp.m284_delivered_before') is null as gone")).gone,
      "the snapshot tables went with the commit");

    // ── 2. The index ──
    let err = null;
    try { await db.query("update public.orders set shop_serial = 1001 where id = $1", [id("a", 7)]); } catch (e) { err = e.message; }
    ok(/duplicate key value violates unique constraint "orders_shop_serial_uniq"/.test(err || ""), "a second building on #1001 at acme-sheds is refused", err);
    err = null;
    try { await db.query("update public.orders set shop_serial = 1010 where id = $1", [id("b", 4)]); } catch (e) { err = e.message; }
    ok(!err, "bravo-barns may hold #1010 even though acme-sheds does", err);
    await db.query("update public.orders set shop_serial = 1030 where id = $1", [id("b", 4)]);
    ok((await one(db, "select count(*)::int n from public.orders where shop_serial is null")).n === 6, "any number of orders may have none");

    // ── 3. Who can write it ──
    let r = await as(db, "authenticated", "update public.orders set shop_serial = 9999 where id = $1", [id("a", 1)]);
    ok(/permission denied/.test(r.err || ""), "the browser (authenticated) cannot UPDATE shop_serial", r.err);
    r = await as(db, "authenticated", "update public.orders set total_cents = 650100 where id = $1", [id("a", 1)]);
    ok(!r.err, "and still can UPDATE total_cents, as 199 left it", r.err);
    r = await as(db, "authenticated", "select shop_serial from public.orders where id = $1", [id("a", 1)]);
    ok(!r.err && r.rows.length === 1 && String(r.rows[0].shop_serial) === "1001", "the Orders tab can read it", r.err || JSON.stringify(r.rows));
    r = await as(db, "anon", "select shop_serial from public.orders limit 1");
    ok(/permission denied/.test(r.err || ""), "anon reads nothing", r.err);
    // portal-schedule's create_job write, as supabase-js sends it (service role): a no-op on a
    // building that already has a number, a write on one that has none.
    r = await as(db, "service_role", "update public.orders set shop_serial = $1, updated_at = now() where id = $2 and client_id = $3 and shop_serial is null returning shop_serial", [1100, id("a", 1), "acme-sheds"]);
    ok(!r.err && r.rows.length === 0, "the edge function's keep-write changes nothing on a numbered building (0 rows: it re-reads the winner)", r.err || JSON.stringify(r.rows));
    r = await as(db, "service_role", "update public.orders set shop_serial = $1, updated_at = now() where id = $2 and client_id = $3 and shop_serial is null returning shop_serial", [1100, id("a", 7), "acme-sheds"]);
    ok(!r.err && r.rows.length === 1 && String(r.rows[0].shop_serial) === "1100", "and records a first number on one that has none", r.err || JSON.stringify(r.rows));
    r = await as(db, "service_role", "update public.orders set shop_serial = $1 where id = $2 and client_id = $3 and shop_serial is null returning shop_serial", [1101, id("a", 7), "bravo-barns"]);
    ok(!r.err && r.rows.length === 0, "and never touches another tenant's order with that id", r.err || JSON.stringify(r.rows));
    await db.close();
  }

  // ── 4. Re-apply, and the post-deploy read-back ──────────────────────────────────────────────
  console.log("migration 284: a re-apply changes nothing; as the post-deploy read-back it catches the old code's window");
  {
    const db = await fresh();
    await apply(db);
    const now = await snapshot(db);
    const serialsNow = await serials(db);
    let re = null;
    try { re = (await apply(db)).record; ok(true, "a re-apply runs clean"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok((await snapshot(db)) === now && JSON.stringify(await serials(db)) === JSON.stringify(serialsNow), "and moves no row");
    ok(JSON.stringify(re) === JSON.stringify({ ...EXPECT_RECORD, filled_from_jobs: 0, filled_from_stops: 0, stops_realigned: 0, stops_realigned_detail: "(none)" }),
      "its record prints zeros and the same 7", JSON.stringify(re));

    // The OLD portal-schedule, between this file and the deploy: it numbers a new order job without
    // telling the order. The read-back records it.
    await db.exec(`update public.client_settings set next_serial = 1101 where client_id = 'acme-sheds';
      insert into public.build_jobs (id, client_id, stage_id, source, design_short_code, serial) values ('${id("c", 7)}', 'acme-sheds', '${STAGE}', 'order', 'SS-ACME0007', 1100);`);
    try { re = (await apply(db)).record; } catch (e) { re = { err: e.message }; }
    ok(re && re.filled_from_jobs === 1 && re.orders_with_shop_serial === 8 && (await serials(db))[id("a", 7)] === "1100",
      "an order job the old code created in the window: the read-back records its number on the order", JSON.stringify(re));

    // The OLD code deleting and re-creating a job for a building that already has a number: refused,
    // naming the job, until the job is put back on the building's number (ORDER step 4).
    await db.exec(`delete from public.build_jobs where id = '${id("c", 1)}';
      update public.client_settings set next_serial = 1102 where client_id = 'acme-sheds';
      insert into public.build_jobs (id, client_id, stage_id, source, design_short_code, serial) values ('${id("c", 8)}', 'acme-sheds', '${STAGE}', 'order', 'SS-ACME0001', 1101);`);
    const rr = await refused(db, MIG_TEXT(), new RegExp(`an order build job disagrees with its building: job ${id("c", 8)} carries #1101, its order holds #1001$`));
    ok(rr.matched && rr.rowsKept && !rr.columnGone, "a job re-created on a numbered building: the read-back refuses, naming it, and changes nothing", JSON.stringify(rr));
    await db.exec(`update public.build_jobs set serial = 1001, updated_at = now() where id = '${id("c", 8)}'`);
    try { re = (await apply(db)).record; } catch (e) { re = { err: e.message }; }
    ok(re && re.order_jobs_mismatched === 0 && re.filled_from_jobs === 0, "after the fix the header gives, it passes", JSON.stringify(re));
    await db.close();
  }

  // ── 5. A CRLF checkout of the file applies the same ─────────────────────────────────────────
  console.log("migration 284: a Windows (CRLF) checkout applies the same");
  {
    const crlf = await fresh();
    let err = null, rec = null;
    try { rec = (await apply(crlf, MIG_TEXT().replace(/\n/g, "\r\n"))).record; } catch (e) { err = e.message; }
    ok(!err && JSON.stringify(rec) === JSON.stringify(EXPECT_RECORD), "the CRLF copy applies and prints the same record", err || JSON.stringify(rec));
    ok(JSON.stringify(await serials(crlf)) === JSON.stringify(EXPECT_SERIALS), "and fills the same numbers");
    await crlf.close();
  }

  // ── 6. The dry run: the same record, nothing left behind ────────────────────────────────────
  console.log("migration 284: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const db = await fresh();
    const before = await snapshot(db);
    const dry = DRY_RUN();
    ok((dry.match(/\ncommit;/g) || []).length === 0 && (dry.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = [];
    try { notices = await apply(db, dry); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(JSON.stringify(notices.record) === JSON.stringify(EXPECT_RECORD), "it prints the same record the apply would", JSON.stringify(notices.record));
    ok(!(await hasColumn(db)), "and leaves no column");
    ok((await snapshot(db)) === before, "and no row moved (the realigned stops included)");
    ok((await tableComment(db)) === unquote(COMMENT_199), "and 199's table comment in place");
    await db.close();
  }

  // ── 7. The header's ROLLBACK, as written ────────────────────────────────────────────────────
  console.log("migration 284: the header's ROLLBACK takes the column, the index and the comment back");
  {
    const db = await fresh();
    await apply(db);
    const sql = ROLLBACK_SQL();
    ok(/drop index if exists public\.orders_shop_serial_uniq;/.test(sql) && /drop column if exists shop_serial;/.test(sql)
      && /comment on table public\.orders is/.test(sql) && /delete from supabase_migrations\.schema_migrations where version = '284';/.test(sql),
      "the ROLLBACK block has the index, the column, the comment and the ledger row", sql);
    ok(!/portal-schedule|shop_serial reads|git /.test(sql), "and stops at the SQL: none of the steps below it is extracted", sql);
    // The steps after the block: the function comes off the column on BETA first (a forward commit,
    // deployed from fresh beta), never by redeploying an old copy, and the block runs last.
    const lines = MIG_TEXT().split("\n");
    const tail = lines.slice(lines.findIndex((l) => /^-- ── ROLLBACK/.test(l)) + 1);
    const after = tail.slice(0, tail.findIndex((l) => !/^--/.test(l))).filter((l) => !/^--   /.test(l)).join("\n");
    ok(/Run the block above LAST/.test(after) && /forward commit/.test(after) && /Never redeploy a saved pre-284 copy/.test(after)
      && /no `shop_serial` anywhere/.test(after) && /4\. Only then run the block above/.test(after),
      "the steps before it: take the reads out on beta, deploy from fresh beta, grep the live copy, then drop", after);
    let err = null;
    try { await db.exec(sql); } catch (e) { err = e.message; }
    ok(!err, "it runs as written", err);
    ok(!(await hasColumn(db)), "the column is gone");
    ok(!(await one(db, "select 1 as x from pg_indexes where indexname = 'orders_shop_serial_uniq'")), "the index is gone");
    ok((await tableComment(db)) === unquote(COMMENT_199), "the table comment is 199's again", await tableComment(db));
    ok((await one(db, "select count(*)::int n from supabase_migrations.schema_migrations where version = '284'")).n === 0, "the ledger row is gone");
    ok((await stop(db, id("d", 3))).serial === "1010", "a realigned stop keeps its new number (the record lists it for a restore)");
    await db.close();
  }

  // ── 8. Mutants: broken shapes are refused, and nothing is left behind ───────────────────────
  console.log("migration 284: refuses what it cannot prove");
  {
    // Two buildings on one number: A7 given a job carrying A1's #1001.
    let db = await fresh();
    await db.exec(`insert into public.build_jobs (client_id, stage_id, source, design_short_code, serial) values ('acme-sheds', '${STAGE}', 'order', 'SS-ACME0007', 1001)`);
    let r = await refused(db, MIG_TEXT(), /two or more buildings would share a shop serial: acme-sheds #1001\./);
    ok(r.matched && r.columnGone && r.rowsKept, "two buildings on #1001: refused, naming it, the whole file rolled back", JSON.stringify(r));
    await db.close();

    // An order building on a lot building's number.
    db = await fresh();
    await db.exec(`insert into public.build_jobs (client_id, stage_id, source, design_short_code, serial) values ('acme-sheds', '${STAGE}', 'order', 'SS-ACME0007', 1006)`);
    r = await refused(db, MIG_TEXT(), /an order building holds the same shop serial as an inventory unit: acme-sheds #1006$/);
    ok(r.matched && r.columnGone && r.rowsKept, "an order on lot building #1006's number: refused", JSON.stringify(r));
    await db.close();

    // The counter at or below a number a building holds: take_next_serial() would hand it out again.
    db = await fresh();
    await db.exec("update public.client_settings set next_serial = 1011 where client_id = 'acme-sheds'");
    r = await refused(db, MIG_TEXT(), /next_serial is at or below a number a building already holds, for: acme-sheds\./);
    ok(r.matched && r.columnGone && r.rowsKept, "acme-sheds' counter at #1011 while a building holds #1011: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    await db.exec("delete from public.client_settings where client_id = 'bravo-barns'");
    r = await refused(db, MIG_TEXT(), /next_serial is at or below a number a building already holds, for: bravo-barns\./);
    ok(r.matched && r.columnGone && r.rowsKept, "a tenant with numbers but no counter row: refused", JSON.stringify(r));
    await db.close();

    // A file whose realign forgets that delivered stops are history.
    db = await fresh();
    const UPDATE_TAIL = /(update public\.delivery_stops s\n     set serial = o\.shop_serial, updated_at = now\(\)\n[\s\S]*?)     and s\.delivered_at is null\n/;
    const touchDelivered = MIG_TEXT().replace(UPDATE_TAIL, "$1");
    ok(touchDelivered !== MIG_TEXT(), "(mutant built: the realign without its delivered_at guard)");
    r = await refused(db, touchDelivered, new RegExp(`delivered stops changed during the apply \\(they are history\\): ${id("d", 4)}$`));
    ok(r.matched && r.columnGone && r.rowsKept, "a realign that rewrites a delivered stop: refused, naming it", JSON.stringify(r));
    await db.close();

    // A file that fills the orders but never realigns the stops.
    db = await fresh();
    const noRealign = MIG_TEXT().replace("set serial = o.shop_serial, updated_at = now()", "set updated_at = s.updated_at");
    ok(noRealign !== MIG_TEXT(), "(mutant built: no realign)");
    r = await refused(db, noRealign, new RegExp(`undelivered order stops still disagree with their building: ${id("d", 3)}, ${id("db", 4)}$`));
    ok(r.matched && r.columnGone && r.rowsKept, "open stops left on a stale number: refused", JSON.stringify(r));
    await db.close();

    // A fill that also stamps orders.updated_at (the Orders tab and every sync would see 11 edits).
    db = await fresh();
    const bumpOrders = MIG_TEXT().replace("     set shop_serial = j.serial\n", "     set shop_serial = j.serial, updated_at = now()\n");
    ok(bumpOrders !== MIG_TEXT(), "(mutant built: the fill bumps orders.updated_at)");
    r = await refused(db, bumpOrders, /orders changed beyond shop_serial during the apply: /);
    ok(r.matched && r.columnGone && r.rowsKept, "a fill that touches another order column: refused", JSON.stringify(r));
    await db.close();

    // A file that "realigns" the build jobs too.
    db = await fresh();
    const writeJobs = MIG_TEXT().replace("-- ── PART 4:", "update public.build_jobs set updated_at = now() where source = 'order';\n\n-- ── PART 4:");
    ok(writeJobs !== MIG_TEXT(), "(mutant built: a build_jobs write)");
    r = await refused(db, writeJobs, /build jobs changed during the apply: /);
    ok(r.matched && r.columnGone && r.rowsKept, "a file that writes build jobs: refused", JSON.stringify(r));
    await db.close();

    // A fill that numbers an inventory sale: each half of the guard, taken out of BOTH fills. A9's
    // and A10's order stops carry their unit's number; copied onto the order, it is a number with
    // two owners, and the lot-building check names it.
    const DESIGN_GUARD = "\n     and not exists (select 1 from public.designs d\n                      where d.client_id = o.client_id and d.short_code = o.short_code and d.inventory_unit_id is not null)";
    const UNIT_GUARD = "\n     and not exists (select 1 from public.inventory_units u\n                      where u.client_id = o.client_id and u.sold_design_short_code = o.short_code)";
    for (const [guard, label, n] of [[DESIGN_GUARD, "the buyer's design", "1007"], [UNIT_GUARD, "the unit's sold-to code", "1008"]]) {
      const parts = MIG_TEXT().split(guard);
      ok(parts.length === 3, `(mutant built: both fills without the inventory-sale guard's check on ${label})`, String(parts.length - 1));
      db = await fresh();
      r = await refused(db, parts.join(""), new RegExp(`an order building holds the same shop serial as an inventory unit: acme-sheds #${n}$`));
      ok(r.matched && r.columnGone && r.rowsKept, `a fill that numbers a sale linked by ${label}: refused, naming #${n}`, JSON.stringify(r));
      await db.close();
    }

    // A plain index where the unique one belongs.
    db = await fresh();
    const plainIndex = MIG_TEXT().replace("create unique index if not exists orders_shop_serial_uniq", "create index if not exists orders_shop_serial_uniq");
    ok(plainIndex !== MIG_TEXT(), "(mutant built: a non-unique index)");
    r = await refused(db, plainIndex, /orders_shop_serial_uniq is missing or not the unique/);
    ok(r.matched && r.columnGone && r.rowsKept, "a non-unique index: refused", JSON.stringify(r));
    await db.close();

    // orders UPDATE-able from the browser again (199's column-scoped grant undone).
    db = await fresh();
    await db.exec("grant update on public.orders to authenticated");
    r = await refused(db, MIG_TEXT(), /authenticated holds UPDATE on orders\.shop_serial; 199's column-scoped grant is gone/);
    ok(r.matched && r.columnGone && r.rowsKept, "orders UPDATE-able by authenticated: refused", JSON.stringify(r));
    await db.close();

    // service_role unable to write it: create_job could not keep the number.
    db = await fresh();
    await db.exec("revoke update on public.orders from service_role");
    r = await refused(db, MIG_TEXT(), /service_role lacks UPDATE on orders\.shop_serial/);
    ok(r.matched && r.columnGone && r.rowsKept, "service_role without UPDATE: refused", JSON.stringify(r));
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
