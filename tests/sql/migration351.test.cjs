// Execute migrations 350 and then 351 (the sizes table's Delete for priced sizes) for real in PGlite
// (Postgres compiled to WASM, in memory), on migration350.test.cjs's cut-down schema plus the four
// places saved work names a size: designs.selections, design_versions.selections,
// designs.accepted_snapshot and change_orders.snapshot_before (live column names, 2026-10-31).
// Then check what 351's header promises (plan §4.1 and §6.1):
//   * THE RECORD and the grants: none of the three functions is executable by a browser role,
//     service_role can execute all three, and used_check reads 'ran' on a seed with a size in use;
//   * ss_size_norm reads " 10 × 12 ", "10X12" and NULL as the re-pricing code does, and strips a
//     U+FEFF as JavaScript's \s does (Postgres's \s keeps it), in the in-use read and the Delete too;
//   * pricing_sizes_in_use: one uuid[] (no set, so no row cap: 1,200 sizes come back whole), '{}' for
//     a tenant with no designs, every source counted (a design, only a version, only an accepted
//     snapshot, only a change order, leftovers whose design row is gone), the style by key or label,
//     the size however it is spaced or cased, a blank size matching nothing, and another builder's
//     design naming the same style key, label and size counting for nothing;
//   * the Delete (an object remove {id, base}): a priced, edited size with boxes goes, its boxes
//     cascade, and the answer carries its row and boxes as they were; a size in use is refused
//     "used" (each source alone) and stays; a stale base is "changed"; BOM lines are "bom"; another
//     builder's id is gone and their row stays; a resend is gone; any other error is "error"; a
//     serialization failure inside it fails the whole call; the answer's id is the uuid string;
//   * string removes keep 350's rule and answers word for word (350's own cases, run here against
//     351's body), with no code on a refusal; a string and an object in one call each get their own
//     rule; 51 mixed entries are refused whole;
//   * the lock list locks an object remove's size (its xmax, after the call) and names the object
//     arm (pg_get_functiondef: PGlite has one connection, so it cannot race);
//   * pg_get_functiondef of 351's pricing_cells_apply equals 350's outside the three marked sections;
//   * the apply-time checks: a seed with a size in use runs the live refusal check ('ran'); a seed
//     with none still applies, with 'skipped' and the notice; the file re-applies;
//   * mutants, each failing a check: the client_id filter dropped from each of the four arms of
//     pricing_sizes_in_use, the used check dropped (the apply-time check refuses the file too), the
//     version check dropped (so too), the lock list without its object arm, and the boxes read after
//     the delete instead of before.
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants, styles, sizes and design codes are made up. The repo is public: no real client id
// belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration351.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of 351 (e.g. a deliberately broken one, or 350 itself to see
// which checks 350 alone fails).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r/g, "");
const MIG350 = () => read(path.join(WT, "supabase/migrations/350_pricing_cells_apply.sql"));
const MIG = () => read(process.env.MIG_FILE || path.join(WT, "supabase/migrations/351_pricing_sizes_delete.sql"));

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create or replace function public.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.building_styles (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  key text not null,
  label text not null,
  code text,
  active boolean not null default true,
  sort_order int not null default 0
);
-- As live: built as building_sizes_new (011) and renamed, so these two keep the old prefix.
create table public.building_sizes_new (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  style_id uuid not null references public.building_styles (id) on delete cascade,
  label text not null,
  width_ft numeric not null,
  length_ft numeric not null,
  base_price numeric,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  manual_base_price numeric,
  unique (style_id, label)
);
alter table public.building_sizes_new rename to building_sizes;
alter table public.building_sizes add constraint building_sizes_client_style_dims_uniq unique (client_id, style_id, width_ft, length_ft);
create trigger building_sizes_set_updated_at before update on public.building_sizes
  for each row execute function public.set_updated_at();
create or replace function public.enforce_size_pricing() returns trigger language plpgsql set search_path = '' as $ef$
begin
  if new.base_price is null then new.active := false; end if;
  return new;
end;
$ef$;
create trigger building_sizes_enforce_pricing before insert or update on public.building_sizes
  for each row execute function public.enforce_size_pricing();

create table public.building_size_inclusions (
  client_id text not null,
  size_id uuid not null references public.building_sizes (id) on delete cascade,
  item_key text not null,
  included boolean not null default true,
  qty int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (size_id, item_key)
);
create trigger building_size_inclusions_set_updated_at before update on public.building_size_inclusions
  for each row execute function public.set_updated_at();

create table public.client_layout_items (client_id text not null, item_key text not null,
  active boolean not null default true, archived boolean not null default false, sort_order int not null default 0,
  primary key (client_id, item_key));
create table public.fixture_items (id uuid primary key default gen_random_uuid(), client_id text not null,
  category text not null default 'door', name text not null, width_in numeric not null default 36, height_in numeric not null default 80,
  active boolean not null default true, archived boolean not null default false);
create table public.client_settings (client_id text primary key, rtp_enabled boolean not null default false);
create table public.rtp_bom_lines (id uuid primary key default gen_random_uuid(), client_id text not null,
  size_id uuid not null references public.building_sizes (id) on delete cascade, material_id uuid not null default gen_random_uuid(),
  section text not null default 'other', qty numeric not null default 0, sort_order int not null default 0,
  created_at timestamptz not null default now());

-- Saved work (live names; cut down to what pricing_sizes_in_use reads, plus their NOT NULLs).
create table public.designs (
  id uuid primary key default gen_random_uuid(),
  short_code text not null,
  client_id text not null,
  selections jsonb not null default '{}'::jsonb,
  bldg_w integer not null default 0,
  bldg_h integer not null default 0,
  status text not null default 'sent',
  accepted_snapshot jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index designs_client_status_idx on public.designs (client_id, status);
create table public.design_versions (
  id uuid primary key default gen_random_uuid(),
  short_code text not null,
  client_id text not null,
  version integer not null,
  selections jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index design_versions_lookup on public.design_versions (client_id, short_code, version);
create table public.change_orders (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  short_code text not null,
  order_id uuid,
  source text not null default 'portal',
  status text not null default 'pending_ack',
  description text not null default '',
  snapshot_before jsonb,
  created_at timestamptz not null default now()
);
`;

const T = "acme-sheds";   // the builder under test
const U = "bravo-barns";  // somebody else, with a style of the same key and label
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ST_BARN = uid(1), ST_SHED = uid(2), ST_OTHER = uid(4);
const FX_DOOR = uid(11);
// This builder's sizes. "used" names what alone names it.
const SZ_PRICED = uid(21);     // 10x12, priced, edited, boxes: deletable
const SZ_DESIGN = uid(22);     // 10x16, used: a design, by style key
const SZ_VERSION = uid(23);    // 12x16, used: only a version (of a code with no designs row: a leftover)
const SZ_ACCEPTED = uid(24);   // 12x20, used: only an accepted snapshot
const SZ_CO = uid(25);         // 12x24, used: only a change order's snapshot_before (a leftover too)
const SZ_BYLABEL = uid(26);    // 14x20, used: a design naming the style by its LABEL
const SZ_SPACED = uid(27);     // 14x24, used: a design writing " 14 × 24 "
const SZ_UPPER = uid(28);      // 14x28, used: a design writing "TEST-BARN" / "14X28"
const SZ_SAME = uid(29);       // 16x20, NOT used: only the other builder's work names test-barn 16x20
const SZ_BLANK = uid(30);      // label " ", NOT used: a blank size names nothing
const SZ_STALE = uid(31);      // 16x24, for a stale base
const SZ_BOM = uid(32);        // 16x28, BOM lines
const SZ_FREE = uid(33);       // 18x20, priced, unused
const SZ_SHED = uid(34);       // Test Shed 8x10, used: a design (whose accepted snapshot names 12x20)
const SZ_NEVER = uid(35);      // 20x20, never priced or edited
const SZ_U = uid(41);          // the other builder's 16x20, used by their own design
const USED_T = [SZ_DESIGN, SZ_VERSION, SZ_ACCEPTED, SZ_CO, SZ_BYLABEL, SZ_SPACED, SZ_UPPER, SZ_SHED].sort();

const CATALOG = `
insert into public.building_styles (id, client_id, key, label, code, sort_order) values
  ('${ST_BARN}', '${T}', 'test-barn', 'Test Barn', 'TB', 0),
  ('${ST_SHED}', '${T}', 'test-shed', 'Test Shed', 'TS', 1),
  ('${ST_OTHER}', '${U}', 'test-barn', 'Test Barn', 'TB', 0);
insert into public.client_layout_items (client_id, item_key, active, archived) values
  ('${T}', 'loft', true, false), ('${T}', 'workbench', true, false), ('${U}', 'loft', true, false);
insert into public.fixture_items (id, client_id, name) values ('${FX_DOOR}', '${T}', 'Single Door');
insert into public.client_settings (client_id, rtp_enabled) values ('${T}', false);
insert into public.building_sizes (id, client_id, style_id, label, width_ft, length_ft, base_price, active, sort_order) values
  ('${SZ_PRICED}', '${T}', '${ST_BARN}', '10x12', 10, 12, 400, true, 0),
  ('${SZ_DESIGN}', '${T}', '${ST_BARN}', '10x16', 10, 16, 500, true, 1),
  ('${SZ_VERSION}', '${T}', '${ST_BARN}', '12x16', 12, 16, 600, true, 2),
  ('${SZ_ACCEPTED}', '${T}', '${ST_BARN}', '12x20', 12, 20, 700, true, 3),
  ('${SZ_CO}', '${T}', '${ST_BARN}', '12x24', 12, 24, 800, true, 4),
  ('${SZ_BYLABEL}', '${T}', '${ST_BARN}', '14x20', 14, 20, 900, true, 5),
  ('${SZ_SPACED}', '${T}', '${ST_BARN}', '14x24', 14, 24, 950, true, 6),
  ('${SZ_UPPER}', '${T}', '${ST_BARN}', '14x28', 14, 28, 990, true, 7),
  ('${SZ_SAME}', '${T}', '${ST_BARN}', '16x20', 16, 20, 1000, true, 8),
  ('${SZ_BLANK}', '${T}', '${ST_BARN}', ' ', 18, 18, 1100, true, 9),
  ('${SZ_STALE}', '${T}', '${ST_BARN}', '16x24', 16, 24, 1200, true, 10),
  ('${SZ_BOM}', '${T}', '${ST_BARN}', '16x28', 16, 28, 1300, true, 11),
  ('${SZ_FREE}', '${T}', '${ST_BARN}', '18x20', 18, 20, 1400, true, 12),
  ('${SZ_SHED}', '${T}', '${ST_SHED}', '8x10', 8, 10, 300, true, 0),
  ('${SZ_NEVER}', '${T}', '${ST_BARN}', '20x20', 20, 20, null, false, 13),
  ('${SZ_U}', '${U}', '${ST_OTHER}', '16x20', 16, 20, 999, true, 0);
insert into public.building_size_inclusions (client_id, size_id, item_key, included, qty) values
  ('${T}', '${SZ_PRICED}', 'loft', true, 50), ('${T}', '${SZ_PRICED}', '${FX_DOOR}', true, 1),
  ('${T}', '${SZ_PRICED}', 'workbench', false, 3),
  ('${T}', '${SZ_DESIGN}', 'loft', true, 40),
  ('${U}', '${SZ_U}', 'loft', true, 9);
insert into public.rtp_bom_lines (client_id, size_id, qty) values ('${T}', '${SZ_BOM}', 4);
`;
// SZ_PRICED edited once (a price typed), so updated_at is past created_at, as every priced size's is.
// Its own statement, after a pause: inside the seed's transaction now() would not have moved.
const EDIT = `update public.building_sizes set base_price = 400 where id = '${SZ_PRICED}';`;
const sel = (style, size) => JSON.stringify(size === undefined ? { style } : { style, size, paint: "painted" });
const snap = (style, size) => JSON.stringify({ selections: { style, size }, total_cents: 1 });
const WORK = `
insert into public.designs (short_code, client_id, selections, status, accepted_snapshot) values
  ('TA0001', '${T}', '${sel("test-barn", "10x16")}', 'sent', null),
  ('TA0002', '${T}', '${sel("Test Barn", "14x20")}', 'draft', null),
  ('TA0003', '${T}', '${sel("test-barn", " 14 × 24 ")}', 'draft', null),
  ('TA0004', '${T}', '${sel("TEST-BARN", "14X28")}', 'draft', null),
  ('TA0005', '${T}', '${sel("test-barn", "")}', 'draft', null),
  ('TA0006', '${T}', '${sel("test-barn")}', 'draft', null),
  ('TA0007', '${T}', '${sel("test-shed", "8x10")}', 'accepted', '${snap("test-barn", "12x20")}'),
  ('UB0001', '${U}', '${sel("test-barn", "16x20")}', 'sent', null),
  ('UB0003', '${U}', '${sel("not-a-style", "1x1")}', 'accepted', '${snap("test-barn", "16x20")}');
insert into public.design_versions (short_code, client_id, version, selections) values
  ('TA0001', '${T}', 1, '${sel("test-barn", "10x16")}'),
  ('TL0009', '${T}', 1, '${sel("test-barn", "12x16")}'),
  ('UB0002', '${U}', 1, '${sel("test-barn", "16x20")}');
insert into public.change_orders (client_id, short_code, snapshot_before) values
  ('${T}', 'TL0010', '${snap("test-barn", "12x24")}'),
  ('${U}', 'UB0004', '${snap("test-barn", "16x20")}');
`;
// 350's removes seed (migration350.test.cjs SEED_REMOVES), under ids of its own.
const SR_NEW = uid(51), SR_EDITED = uid(52), SR_INC = uid(53), SR_BOM = uid(54), SR_THEIRS_NEW = uid(55);
const SEED_REMOVES = `
insert into public.building_sizes (id, client_id, style_id, label, width_ft, length_ft, base_price, active, sort_order) values
  ('${SR_NEW}', '${T}', '${ST_SHED}', '20x20', 20, 20, null, false, 10),
  ('${SR_EDITED}', '${T}', '${ST_SHED}', '20x24', 20, 24, null, false, 11),
  ('${SR_INC}', '${T}', '${ST_SHED}', '20x28', 20, 28, null, false, 12),
  ('${SR_BOM}', '${T}', '${ST_SHED}', '20x32', 20, 32, null, false, 13),
  ('${SR_THEIRS_NEW}', '${U}', '${ST_OTHER}', '20x20', 20, 20, null, false, 1);
insert into public.building_size_inclusions (client_id, size_id, item_key, included, qty) values ('${T}', '${SR_INC}', 'loft', true, 10);
insert into public.rtp_bom_lines (client_id, size_id, qty) values ('${T}', '${SR_BOM}', 4);
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const J = (v) => JSON.stringify(v);
/** JSON with every object's keys sorted: jsonb orders keys by length, so compare content, not order. */
const C = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const opened = [];
/** A database with the schema and the catalog, 350 applied, and `extra` seeded (WORK by default). */
async function fresh(extra = WORK) {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  await db.exec(CATALOG + extra);
  await sleep(5);
  await db.exec(EDIT);
  await db.exec(MIG350());
  return db;
}
async function apply(db, sql = MIG()) {
  const notices = [];
  try {
    const out = await db.exec(sql, { onNotice: (n) => notices.push(n.message) });
    const record = [...out].reverse().map((r) => r.rows && r.rows[0]).find((r) => r && "service_role_can_execute" in r);
    return { err: null, record, notices };
  } catch (e) { await db.exec("rollback").catch(() => {}); return { err: e.message, notices }; }
}
/** fresh() with 351 applied. */
async function applied(extra = WORK, sql = MIG()) {
  const db = await fresh(extra);
  const a = await apply(db, sql);
  return { db, ...a };
}
/** One save call, as portal-settings makes it. A pause first, so every call's now() differs. */
async function call(db, { creates = [], removes = [], sizes = [] } = {}, client = T) {
  await sleep(5);
  try {
    return (await one(db, "select public.pricing_cells_apply($1, $2::jsonb, $3::jsonb, $4::jsonb) r",
      [client, J(creates), J(removes), J(sizes)])).r;
  } catch (e) { return { err: e.message, code: e.code }; }
}
/** A size's version exactly as size_table and the function hand it out (timestamptz as JSON text). */
const version = async (db, id) => (await one(db, "select to_jsonb(updated_at) #>> '{}' v from public.building_sizes where id = $1", [id]))?.v ?? null;
const exists = async (db, id) => !!(await one(db, "select 1 x from public.building_sizes where id = $1", [id]));
const boxRows = async (db, id) => (await one(db, "select count(*)::int n from public.building_size_inclusions where size_id = $1", [id])).n;
const inUse = async (db, client) => (await one(db, "select public.pricing_sizes_in_use($1) a", [client])).a;
/** A Delete of one size at the version it has now (or at `base`). */
const del = async (db, id, base) => ({ id, base: base ?? await version(db, id) });
const byId = (list) => Object.fromEntries((list || []).map((x) => [x.id, x]));
const functiondef = async (db) => (await one(db, "select pg_get_functiondef('public.pricing_cells_apply(text, jsonb, jsonb, jsonb)'::regprocedure) d")).d.replace(/\r/g, "");
/** One block of checks. A block that throws (run against 350 alone, a function it calls is missing)
 *  is one failure, and the blocks after it still run, so every check that should fail is seen. */
async function guard(run) {
  try { await run(); } catch (e) { ok(false, "the block above ran to its end", String(e && e.message || e).split("\n")[0]); }
}
/** 351 with one exact piece of text replaced; the replacement must happen exactly once. */
function mutant(from, to) {
  const src = MIG();
  const n = src.split(from).length - 1;
  return n === 1 ? src.replace(from, () => to) : null;
}

(async () => {
  const SIGS = ["public.ss_size_norm(text)", "public.pricing_sizes_in_use(text)", "public.pricing_cells_apply(text, jsonb, jsonb, jsonb)"];

  console.log("migration 351: apply on 350, the record and the grants");
  const { db, err, record, notices } = await applied();
  ok(!err, "applies cleanly on top of 350", err);
  ok(record && record.ready === true && record.anon_can_execute === false && record.authenticated_can_execute === false
    && record.service_role_can_execute === true, "THE RECORD: ready, no browser role, service_role", J(record));
  ok(record && record.used_check === "ran", "THE RECORD: used_check = 'ran' on a seed with a size in use", J(record));
  ok(record && record.sizes_in_use === USED_T.length + 1, "THE RECORD: counts the sizes in use (this builder's 8 and the other's 1)", J(record));
  ok(notices.some((n) => /a live size saved designs use is refused/.test(n)) && !notices.some((n) => /skipped/.test(n)),
    "...and the apply says the live refusal check ran", J(notices));
  await guard(async () => {
    for (const sig of SIGS) {
      for (const role of ["anon", "authenticated"]) {
        ok((await one(db, `select has_function_privilege($1, '${sig}', 'execute') x`, [role])).x === false, `${role} cannot execute ${sig}`);
      }
      ok((await one(db, `select has_function_privilege('service_role', '${sig}', 'execute') x`)).x === true, `service_role can execute ${sig}`);
    }
  });
  await guard(async () => {
    const p = (await db.query(`select p.oid::regprocedure::text sig, p.prosecdef, p.provolatile, array_to_string(p.proconfig, ',') cfg, p.proretset, p.prorettype::regtype::text ret
      from pg_proc p where p.oid in ('${SIGS[0]}'::regprocedure, '${SIGS[1]}'::regprocedure, '${SIGS[2]}'::regprocedure)`)).rows;
    const of = (s) => p.find((r) => r.sig.startsWith(s));
    ok(of("ss_size_norm").provolatile === "i" && /search_path=/.test(of("ss_size_norm").cfg), "ss_size_norm: immutable, fixed search_path", J(of("ss_size_norm")));
    ok(of("pricing_sizes_in_use").prosecdef && of("pricing_sizes_in_use").provolatile === "s" && /search_path=/.test(of("pricing_sizes_in_use").cfg),
      "pricing_sizes_in_use: SECURITY DEFINER, stable, fixed search_path", J(of("pricing_sizes_in_use")));
    ok(of("pricing_sizes_in_use").proretset === false && of("pricing_sizes_in_use").ret === "uuid[]", "...returning ONE uuid[], not a set (db-max-rows cuts a set)");
    ok(of("pricing_cells_apply").prosecdef && /search_path=/.test(of("pricing_cells_apply").cfg) && /lock_timeout=5s/.test(of("pricing_cells_apply").cfg),
      "pricing_cells_apply: still SECURITY DEFINER, fixed search_path, lock_timeout 5s", J(of("pricing_cells_apply")));
    let denied = null;
    try { await db.exec(`set role anon; select public.pricing_sizes_in_use('${T}');`); } catch (e) { denied = e.message; }
    await db.exec("reset role");
    ok(denied && /permission denied/.test(denied), "called as anon, pricing_sizes_in_use is refused before it runs", denied);
    let asService = null;
    try {
      await db.exec("set role service_role");
      asService = (await db.query(`select public.pricing_sizes_in_use('${T}') a`)).rows[0]?.a;
    } catch (e) { asService = { err: e.message }; }
    await db.exec("reset role");
    ok(J(asService) === J(USED_T), "called as service_role, it answers this builder's sizes in use", J(asService));
  });

  console.log("migration 351: ss_size_norm");
  await guard(async () => {
    const r = await one(db, `select public.ss_size_norm(' 10 × 12 ') a, public.ss_size_norm('10X12') b, public.ss_size_norm('10✕12') c,
      public.ss_size_norm(null) d, public.ss_size_norm('Test Barn') e, public.ss_size_norm(E'10\\tx 12') f`);
    ok(r.a === "10x12" && r.b === "10x12" && r.c === "10x12" && r.d === "" && r.e === "testbarn" && r.f === "10x12",
      "\" 10 × 12 \", \"10X12\", \"10✕12\" and a tab read 10x12; NULL is ''; a style label loses its spaces", J(r));
    // JavaScript's \s takes U+FEFF (so `norm` drops it) and Postgres's \s doesn't, in PGlite's libc
    // locale and in live's ICU one alike. ss_size_norm strips it by name. Compared in SQL: a text
    // that starts with U+FEFF loses it in the client's decoder, so JavaScript can't see that one.
    const bom = await one(db, `select public.ss_size_norm(chr(65279) || '10x12') = '10x12' a, public.ss_size_norm('10' || chr(65279) || 'x12') = '10x12' b,
      public.ss_size_norm('Test Barn' || chr(65279)) = 'testbarn' c, regexp_replace(chr(65279), '\\s', '', 'g') = chr(65279) as plain_s_keeps_it`);
    ok(bom.a === true && bom.b === true && bom.c === true && bom.plain_s_keeps_it === true,
      "U+FEFF is stripped before, inside and after a name, as JavaScript's \\s strips it (Postgres's \\s alone keeps it)", J(bom));
    // The same through the in-use read and the Delete: a design whose size, or whose style label,
    // carries a U+FEFF still names the size, as submit-estimate's norm matches it.
    const f = await applied(WORK + `
insert into public.designs (short_code, client_id, selections, status) values
  ('TA0090', '${T}', jsonb_build_object('style', 'test-barn', 'size', chr(65279) || '18x20'), 'draft'),
  ('TA0091', '${T}', jsonb_build_object('style', 'Test Barn' || chr(65279), 'size', '16x24'), 'draft');`);
    ok(!f.err, "(applies with designs naming a size and a style with a U+FEFF)", f.err);
    const tf = await inUse(f.db, T);
    ok(tf.includes(SZ_FREE) && tf.includes(SZ_STALE), "in use: a design writing U+FEFF before the size, and one writing it after the style label", J(tf));
    const fr = await call(f.db, { removes: [await del(f.db, SZ_FREE)] });
    ok(fr.removed[0].status === "refused" && fr.removed[0].code === "used" && await exists(f.db, SZ_FREE),
      "...and the Delete of that size is refused as used, the row kept", J(fr.removed[0]));
  });

  console.log("migration 351: pricing_sizes_in_use");
  await guard(async () => {
    const t = await inUse(db, T);
    ok(Array.isArray(t) && J(t) === J(USED_T), "this builder: exactly the sizes its saved work names", J(t));
    for (const [id, what] of [[SZ_DESIGN, "a design, by style key"], [SZ_VERSION, "only a version, of a code with no designs row (a leftover counts)"],
      [SZ_ACCEPTED, "only an accepted snapshot"], [SZ_CO, "only a change order's snapshot_before (a leftover too)"],
      [SZ_BYLABEL, "the style named by its label, not its key"], [SZ_SPACED, "the size written \" 14 × 24 \""],
      [SZ_UPPER, "the style and size in capitals (\"TEST-BARN\", \"14X28\")"], [SZ_SHED, "a design whose own size differs from its accepted snapshot's"]]) {
      ok(t.includes(id), `in use: ${what}`);
    }
    ok(!t.includes(SZ_SAME), "another builder's design, version, accepted snapshot and change order naming the same style key, label and size count for nothing");
    ok(!t.includes(SZ_BLANK), "a blank or missing selections.size names nothing (not even a size whose label is blank)");
    ok(J(await inUse(db, U)) === J([SZ_U]), "the other builder: only their own size", J(await inUse(db, U)));
    ok(J(await inUse(db, "nobody-here")) === "[]", "a tenant with no designs: '{}'");
    ok((await one(db, "select pg_typeof(public.pricing_sizes_in_use('acme-sheds'))::text t")).t === "uuid[]", "it is a uuid[]");
  });
  await guard(async () => {
    // No row cap: 1,200 sizes in use come back in one value (PostgREST would cut a set at 1,000).
    const big = await fresh("");
    await apply(big);
    await big.exec(`
      insert into public.building_styles (id, client_id, key, label) values ('${uid(900)}', 'big-barns', 'big', 'Big');
      insert into public.building_sizes (client_id, style_id, label, width_ft, length_ft, base_price)
        select 'big-barns', '${uid(900)}', '10x' || g, 10, g, 100 from generate_series(1, 1200) g;
      insert into public.designs (short_code, client_id, selections)
        select 'BG' || g, 'big-barns', jsonb_build_object('style', 'big', 'size', '10x' || g) from generate_series(1, 1200) g;`);
    ok((await one(big, "select cardinality(public.pricing_sizes_in_use('big-barns')) n")).n === 1200, "1,200 sizes in use come back whole, in one array");
  });

  console.log("migration 351: the Delete takes a priced, edited size, and answers what went");
  await guard(async () => {
    const before = await one(db, "select base_price::float8 price, (updated_at > created_at) edited from public.building_sizes where id = $1", [SZ_PRICED]);
    ok(before.price === 400 && before.edited === true, "(the size is priced and was edited)", J(before));
    const v = await version(db, SZ_PRICED);
    const r = await call(db, { removes: [{ id: SZ_PRICED, base: v }] });
    const a = r.removed && r.removed[0];
    ok(a && a.status === "removed" && a.gone === undefined && a.code === undefined && a.reason === undefined, "a priced size with boxes, at its version, is removed", J(r));
    ok(!await exists(db, SZ_PRICED), "...and the row is gone");
    ok(await boxRows(db, SZ_PRICED) === 0, "...and its inclusion rows cascaded, the not-included one too");
    ok(a && a.id === SZ_PRICED && typeof a.id === "string", "the answer's id is the uuid string, not the object sent", J(a && a.id));
    ok(a && a.row && a.row.price === 400 && a.row.active === true && a.row.label === "10x12" && a.row.width_ft === 10 && a.row.length_ft === 12
      && a.row.style_id === ST_BARN && a.row.sort_order === 0 && typeof a.row.created_at === "string", "the answer carries the row as it was", J(a && a.row));
    ok(a && C(a.row && Object.keys(a.row).sort()) === C(["active", "created_at", "label", "length_ft", "price", "sort_order", "style_id", "width_ft"]),
      "...in the sizes arm's shape", J(a && a.row));
    ok(a && C(a.cells) === C({ loft: 50, [FX_DOOR]: 1 }), "...and its included boxes as they were before the delete (a not-included row is no box)", J(a && a.cells));
    ok(J(r.created) === "[]" && J(r.results) === "[]", "...and nothing else in the answer");
    const again = await call(db, { removes: [{ id: SZ_PRICED, base: v }] });
    ok(C(again.removed) === C([{ id: SZ_PRICED, status: "removed", gone: true }]), "a resend answers removed, gone, with nothing else", J(again));
    const never = await call(db, { removes: [await del(db, SZ_NEVER)] });
    ok(never.removed[0].status === "removed" && !await exists(db, SZ_NEVER) && J(never.removed[0].cells) === "{}" && never.removed[0].row.price === null,
      "a size never priced or edited goes by the Delete too, with no boxes and no price", J(never));
  });

  console.log("migration 351: a size saved designs use is refused, and stays");
  await guard(async () => {
    for (const [id, what] of [[SZ_DESIGN, "named by a design"], [SZ_VERSION, "only by a version"], [SZ_ACCEPTED, "only by an accepted snapshot"],
      [SZ_CO, "only by a change order's snapshot_before"], [SZ_BYLABEL, "the style named by label"], [SZ_SPACED, "written \" 14 × 24 \""],
      [SZ_UPPER, "written \"14X28\""]]) {
      const v = await version(db, id);
      const r = await call(db, { removes: [{ id, base: v }] });
      const a = r.removed && r.removed[0];
      ok(a && a.status === "refused" && a.code === "used" && /Saved designs use this size/.test(a.reason) && a.row === undefined,
        `${what}: refused, code used`, J(r));
      ok(await exists(db, id) && await version(db, id) === v, `...and the row is kept, its version unmoved`);
    }
    ok(await boxRows(db, SZ_DESIGN) === 1, "...its boxes kept too");
    const same = await call(db, { removes: [await del(db, SZ_SAME)] });
    ok(same.removed[0].status === "removed" && !await exists(db, SZ_SAME), "a size only another builder's work names is deleted", J(same));
    const blank = await call(db, { removes: [await del(db, SZ_BLANK)] });
    ok(blank.removed[0].status === "removed" && !await exists(db, SZ_BLANK), "a size named only by blank selections.size is deleted", J(blank));
  });

  console.log("migration 351: a stale base is changed, BOM lines are bom, another builder's id is gone");
  await guard(async () => {
    const v0 = await version(db, SZ_STALE);
    const saved = await call(db, { sizes: [{ id: SZ_STALE, base: v0, from: { price: 1200 }, to: { price: 1250 } }] });
    ok(saved.results[0].status === "saved", "(a colleague's price lands)", J(saved));
    const stale = await call(db, { removes: [{ id: SZ_STALE, base: v0 }] });
    ok(stale.removed[0].status === "refused" && stale.removed[0].code === "changed" && /changed/.test(stale.removed[0].reason),
      "a Delete confirmed on the old version: refused, code changed", J(stale));
    ok(await exists(db, SZ_STALE) && await version(db, SZ_STALE) === saved.results[0].version, "...and the row stays as the colleague left it");
    const usedStale = await call(db, { removes: [{ id: SZ_DESIGN, base: "2026-01-01T00:00:00+00:00" }] });
    ok(usedStale.removed[0].code === "changed", "a stale base is answered before the in-use check", J(usedStale));
    const bom = await call(db, { removes: [await del(db, SZ_BOM)] });
    ok(bom.removed[0].status === "refused" && bom.removed[0].code === "bom" && /Real-Time Pricing/.test(bom.removed[0].reason) && await exists(db, SZ_BOM),
      "a size with BOM lines: refused, code bom, and stays", J(bom));
    const theirs = await call(db, { removes: [await del(db, SZ_U)] });
    ok(C(theirs.removed) === C([{ id: SZ_U, status: "removed", gone: true }]), "another builder's size answers removed, gone, exactly as an id nobody holds", J(theirs));
    const nobody = await call(db, { removes: [{ id: uid(999), base: await version(db, SZ_U) }] });
    const { id: _a, ...t1 } = theirs.removed[0], { id: _b, ...t2 } = nobody.removed[0];
    ok(C(t1) === C(t2), "...the answer says nothing about other accounts", J([t1, t2]));
    ok(await exists(db, SZ_U) && await boxRows(db, SZ_U) === 1, "...and their row and boxes stay");
    const asThem = await call(db, { removes: [await del(db, SZ_FREE)] }, U);
    ok(asThem.removed[0].gone === true && await exists(db, SZ_FREE), "called as the other builder, this builder's size is gone to it, and stays");
  });

  console.log("migration 351: any other error is code error; a serialization failure fails the whole call");
  await guard(async () => {
    const e = await applied(WORK + SEED_REMOVES);
    const bad = await call(e.db, { removes: [{ id: "not-a-uuid", base: await version(e.db, SZ_FREE) }, { id: SZ_FREE, base: "not-a-time" }] });
    ok(!bad.err && bad.removed.every((x) => x.status === "refused" && x.code === "error" && typeof x.reason === "string"),
      "a malformed id or base inside an object is refused on its own, code error", J(bad));
    ok(bad.removed[0].id === "not-a-uuid", "...answered under the id it was sent with");
    ok(await exists(e.db, SZ_FREE), "...and nothing is deleted");
    await e.db.exec(`
      create function public.t_boom() returns trigger language plpgsql as $t$
      begin
        if old.label = '18x20' then raise exception 'test: eighteen by twenty is unlucky'; end if;
        if old.label = '20x20' and old.client_id = '${T}' then raise exception 'test: could not serialize access' using errcode = '40001'; end if;
        return old;
      end $t$;
      create trigger t_boom before delete on public.building_sizes for each row execute function public.t_boom();`);
    const boom = await call(e.db, { removes: [await del(e.db, SZ_FREE), await del(e.db, SZ_SAME)] });
    ok(boom.removed[0].status === "refused" && boom.removed[0].code === "error" && /unlucky/.test(boom.removed[0].reason) && await exists(e.db, SZ_FREE),
      "a delete the database refuses is refused, code error, with its sentence", J(boom.removed[0]));
    ok(boom.removed[1].status === "removed" && !await exists(e.db, SZ_SAME), "...and the size beside it goes", J(boom.removed[1]));
    const vA = await version(e.db, SZ_STALE);
    const ser = await call(e.db, { removes: [await del(e.db, SZ_BLANK), await del(e.db, SR_NEW)],
      sizes: [{ id: SZ_STALE, base: vA, from: { price: 1200 }, to: { price: 1201 } }] });
    ok(ser.err && ser.code === "40001", "a serialization failure inside an object remove fails the WHOLE call with 40001", J(ser));
    ok(await exists(e.db, SZ_BLANK) && await exists(e.db, SR_NEW) && await version(e.db, SZ_STALE) === vA,
      "...and nothing of it is left: the delete before it and the price after it are rolled back");
    ok(await boxRows(e.db, SZ_DESIGN) === 1, "(the boxes of an untouched size are untouched)");
  });

  console.log("migration 351: string removes keep 350's rule (350's own cases, against 351's body)");
  await guard(async () => {
    const m = (await applied(WORK + SEED_REMOVES)).db;
    await sleep(5);
    await m.query(`update public.building_sizes set sort_order = sort_order where id = '${SR_EDITED}'`);   // edited once, still unpriced
    const r = await call(m, { removes: [SR_NEW, SZ_FREE, SR_EDITED, SR_INC, SR_BOM, SR_THEIRS_NEW, uid(998)] });
    const st = byId(r.removed);
    ok(C(st[SR_NEW]) === C({ id: SR_NEW, status: "removed" }) && !await exists(m, SR_NEW), "a size never priced or edited, with nothing in it, is removed, in 350's shape exactly", J(st[SR_NEW]));
    for (const [id, what] of [[SZ_FREE, "a priced size"], [SR_EDITED, "a once-edited size"], [SR_INC, "a size with a box filled"], [SR_BOM, "a size with BOM lines"]]) {
      ok(C(st[id]) === C({ id, status: "refused", reason: "Only a size that was never priced or edited can be removed. Untick Offered to hide it." }) && await exists(m, id),
        `${what} is refused with 350's sentence and no code, and stays`, J(st[id]));
    }
    ok(C(st[uid(998)]) === C({ id: uid(998), status: "removed", gone: true }), "an id nobody holds is already gone", J(st[uid(998)]));
    const { id: _a, ...theirs } = st[SR_THEIRS_NEW], { id: _b, ...nobodys } = st[uid(998)];
    ok(C(theirs) === C(nobodys), "another builder's size answers exactly as an id nobody holds", J([theirs, nobodys]));
    ok(await exists(m, SR_THEIRS_NEW), "...and it stays, theirs");
    const again = await call(m, { removes: [SR_NEW] });
    ok(C(again.removed) === C([{ id: SR_NEW, status: "removed", gone: true }]), "a resent remove that landed answers removed (gone)", J(again));
    const used = await call(m, { removes: [SZ_DESIGN] });
    ok(used.removed[0].status === "refused" && used.removed[0].code === undefined && /never priced or edited/.test(used.removed[0].reason),
      "a string remove of a size in use answers 350's refusal, with no code (the browser words it)", J(used));
    // The edge never sends a malformed id; the function still refuses one per entry.
    const bad = await call(m, { removes: ["not-a-uuid"], sizes: [{ id: SZ_STALE, base: await version(m, SZ_STALE), from: { price: 1200 }, to: { price: 1210 } }] });
    ok(!bad.err && bad.removed[0].status === "refused" && bad.removed[0].code === undefined && bad.results[0].status === "saved",
      "a malformed string id is refused on its own entry, with no code, and the size beside it saves", J(bad));

    // WHAT STAYS OPEN (350): a create resent after its size was removed inserts it again.
    const N = uid(801);
    const create = { creates: [{ id: N, styleId: ST_SHED, width: 11, length: 11, label: "11x11" }] };
    const side = await call(m, create);
    const removed = await call(m, { removes: [N] });
    const late = await call(m, create);
    ok(side.created[0].status === "created" && C(removed.removed) === C([{ id: N, status: "removed" }]) && late.created[0].status === "created",
      "a create resent after its size was removed inserts it again (350's open gap, unchanged)", J([side, removed, late]));
    const deleted = await call(m, { removes: [await del(m, N)] });
    ok(deleted.removed[0].status === "removed" && !await exists(m, N), "...and the Delete takes it away again too", J(deleted));

    // A whole call resent after it landed (350's case).
    const W = uid(201), FRESH = uid(202);
    await m.query(`insert into public.building_sizes (id, client_id, style_id, label, width_ft, length_ft, base_price, active) values ('${FRESH}', '${T}', '${ST_SHED}', '9x12', 9, 12, null, false)`);
    const body = { creates: [{ id: W, styleId: ST_SHED, width: 9, length: 9, label: "9x9" }], removes: [FRESH],
      sizes: [{ id: SZ_STALE, base: await version(m, SZ_STALE), from: { price: 1210 }, to: { price: 1220 } }] };
    const first = await call(m, body);
    const second = await call(m, body);
    ok(first.created[0].status === "created" && C(first.removed) === C([{ id: FRESH, status: "removed" }]) && first.results[0].status === "saved", "a whole call: the first copy lands", J(first));
    ok(second.created[0].status === "duplicate" && C(second.removed) === C([{ id: FRESH, status: "removed", gone: true }]) && second.results[0].status === "duplicate",
      "...and its resend answers duplicate, gone and duplicate", J(second));
  });

  console.log("migration 351: a string and an object in one call each get their own rule");
  await guard(async () => {
    const x = (await applied()).db;
    const r = await call(x, { removes: [SZ_FREE, await del(x, SZ_SAME), SZ_NEVER, await del(x, SZ_DESIGN)] });
    const st = byId(r.removed);
    ok(st[SZ_FREE].status === "refused" && st[SZ_FREE].code === undefined && /never priced or edited/.test(st[SZ_FREE].reason) && await exists(x, SZ_FREE),
      "the string remove of a priced size: 350's refusal, no code", J(st[SZ_FREE]));
    ok(st[SZ_SAME].status === "removed" && st[SZ_SAME].row && st[SZ_SAME].cells && !await exists(x, SZ_SAME), "the object remove of a priced, unused size: deleted, with row and cells", J(st[SZ_SAME]));
    ok(C(st[SZ_NEVER]) === C({ id: SZ_NEVER, status: "removed" }) && !await exists(x, SZ_NEVER), "the string remove of a never-edited size: removed, 350's shape (no row, no cells)", J(st[SZ_NEVER]));
    ok(st[SZ_DESIGN].status === "refused" && st[SZ_DESIGN].code === "used" && await exists(x, SZ_DESIGN), "the object remove of a size in use: refused, used", J(st[SZ_DESIGN]));
    ok(J(r.removed.map((a) => a.id)) === J([SZ_FREE, SZ_SAME, SZ_NEVER, SZ_DESIGN]) && r.removed.every((a) => typeof a.id === "string"),
      "answers come in the order sent, each id the uuid string", J(r.removed.map((a) => a.id)));
    const fiftyOne = [...Array.from({ length: 26 }, (_, i) => uid(400 + i)), ...Array.from({ length: 25 }, (_, i) => ({ id: uid(500 + i), base: "2026-10-31T00:00:00+00:00" }))];
    const many = await call(x, { removes: fiftyOne });
    ok(many.err && many.code === "22023", "51 mixed entries are refused whole, 22023", J(many));
    const fifty = await call(x, { removes: fiftyOne.slice(1) });
    ok(!fifty.err && fifty.removed.length === 50 && fifty.removed.every((a) => a.status === "removed" && a.gone === true), "50 mixed entries run", fifty.err);
  });

  console.log("migration 351: the lock list locks an object remove's size");
  // PGlite has one connection, so no second session can wait on the lock. A row a transaction locked
  // FOR UPDATE keeps that transaction's id in xmax after it commits; a row nobody locked or changed
  // keeps 0. The used refusal neither updates nor deletes the row, so only the lock list sets it.
  const lockedByDelete = async (sql) => {
    const d = await applied(WORK, sql);
    if (d.err) return { err: d.err };
    const before = (await one(d.db, "select xmax::text x from public.building_sizes where id = $1", [SZ_SPACED])).x;
    const r = await call(d.db, { removes: [await del(d.db, SZ_SPACED)] });
    const after = (await one(d.db, "select xmax::text x from public.building_sizes where id = $1", [SZ_SPACED])).x;
    return { before, after, r, def: await functiondef(d.db) };
  };
  await guard(async () => {
    const l = await lockedByDelete();
    ok(!l.err && l.before === "0" && l.r.removed[0].code === "used", "(a size in use, never locked before, refused used)", J(l));
    ok(l.after !== "0", "...was locked by the call (its xmax is the call's transaction)", J([l.before, l.after]));
    const lockStmt = l.def.slice(l.def.indexOf("perform 1 from public.building_sizes z"), l.def.indexOf("for update;", l.def.indexOf("perform 1 from public.building_sizes z")));
    ok(/jsonb_typeof\(e\.x\) = 'object' then e\.x ->> 'id' else e\.x #>> '\{\}'/.test(lockStmt) && /jsonb_array_elements\(v_removes\)/.test(lockStmt),
      "pg_get_functiondef: the lock list reads an object remove's id", lockStmt.slice(0, 80));
  });

  console.log("migration 351: pricing_cells_apply is 350's body outside the three marked sections");
  await guard(async () => {
    const d350 = await fresh();
    const def350 = await functiondef(d350);
    const def351 = await functiondef(db);
    const marks = [...def351.matchAll(/-- \[351\.([abc]) begin\]/g)].map((m) => m[1]);
    ok(J(marks) === J(["b", "a", "b", "c"]), "the marked sections: b (variables), a (lock list), b (the in-use read), c (removes)", J(marks));
    const skeleton351 = def351.replace(/[ \t]*-- \[351\.([abc]) begin\][\s\S]*?-- \[351\.\1 end\][^\n]*\n/g, (_m, s) => `<<${s}>>`);
    const ORIG_A = "           select case when e.x #>> '{}' ~* c_uuid then (e.x #>> '{}')::uuid end from jsonb_array_elements(v_removes) e(x)))\n";
    const cFrom = "  for v_e in select x from jsonb_array_elements(v_removes) as t(x) loop\n";
    const cAt = def350.indexOf(cFrom), cEnd = def350.indexOf("  end loop;\n", cAt) + "  end loop;\n".length;
    let skeleton350 = def350.slice(0, cAt) + "<<c>>" + def350.slice(cEnd);
    const once = (from, to, what) => {
      const n = skeleton350.split(from).length - 1;
      ok(n === 1, `(350's ${what} found once)`, String(n));
      skeleton350 = skeleton350.replace(from, () => to);
    };
    once(ORIG_A, "<<a>>", "lock list removes arm");
    once("  v_ans         jsonb;\n", "  v_ans         jsonb;\n<<b>>", "last variable");
    once("   for update;\n\n", "   for update;\n\n<<b>>\n", "end of the lock list");
    ok(def350.slice(cAt, cEnd).includes("Only a size that was never priced or edited can be removed"), "(350's removes loop found)");
    ok(skeleton351 === skeleton350, "everything outside the marked sections is 350's text, byte for byte",
      (() => { for (let i = 0; i < Math.max(skeleton350.length, skeleton351.length); i++) if (skeleton350[i] !== skeleton351[i]) return `first difference at ${i}: 350 ${J(skeleton350.slice(i, i + 60))} / 351 ${J(skeleton351.slice(i, i + 60))}`; return ""; })());
    const c351 = def351.slice(def351.indexOf("-- [351.c begin]"), def351.indexOf("-- [351.c end]"));
    const stringArm = def350.slice(def350.indexOf("      v_id := (v_e #>> '{}')::uuid;\n", cAt), def350.indexOf("    exception\n", cAt));
    ok(stringArm.length > 200 && c351.includes(stringArm.replace(/^/gm, "  ").replace(/^  $/gm, "")), "the string arm inside section c is 350's statements word for word (indented one level)",
      stringArm.slice(0, 60));
  });

  console.log("migration 351: a seed with no size in use still applies, and says the check was skipped");
  await guard(async () => {
    const s = await applied("");
    ok(!s.err, "applies on a database with no designs", s.err);
    ok(s.record && s.record.used_check === "skipped" && s.record.sizes_in_use === 0 && s.record.ready === true, "THE RECORD: used_check = 'skipped'", J(s.record));
    ok(s.notices.some((n) => n === "351: no size in use, live refusal check skipped"), "...with the notice", J(s.notices));
    const onlyBom = await applied(`insert into public.designs (short_code, client_id, selections) values ('TB0001', '${T}', '${sel("test-barn", "16x28")}');`);
    ok(!onlyBom.err && onlyBom.record.used_check === "skipped" && onlyBom.record.sizes_in_use === 1,
      "a size in use that has BOM lines is passed over (it would answer bom): skipped", J(onlyBom.record || onlyBom.err));
  });

  console.log("migration 351: re-apply");
  await guard(async () => {
    const re = await apply(db);
    ok(!re.err && re.record && re.record.ready === true && re.record.anon_can_execute === false && re.record.used_check === "ran", "re-applies cleanly, grants unchanged", re.err || J(re.record));
  });

  // ── Mutants: each must fail a check ──────────────────────────────────────────────────────
  console.log("migration 351: mutants");
  for (const [arm, from, to] of [
    ["designs", " from public.designs d where d.client_id = p_client_id\n", " from public.designs d\n"],
    ["design_versions", " from public.design_versions v where v.client_id = p_client_id\n", " from public.design_versions v\n"],
    ["accepted snapshots", "where d.client_id = p_client_id and d.accepted_snapshot is not null", "where d.accepted_snapshot is not null"],
    ["change orders", "where c.client_id = p_client_id and c.snapshot_before is not null", "where c.snapshot_before is not null"],
  ]) {
    const sql = mutant(from, to);
    ok(!!sql, `(the mutant formed: no client_id filter on the ${arm} arm)`);
    if (!sql) continue;
    const d = await applied(WORK, sql);
    ok(!d.err, "...it applies", d.err);
    const same = await call(d.db, { removes: [await del(d.db, SZ_SAME)] });
    ok(same.removed[0].code === "used" && await exists(d.db, SZ_SAME), `...and the other builder's ${arm} lock this builder's size (the check above fails)`, J(same.removed[0]));
  }
  await guard(async () => {
    const sql = mutant("        elsif v_id = any (v_used) then\n", "        elsif false then\n");
    ok(!!sql, "(the mutant formed: no used check)");
    const refused = await applied(WORK, sql);
    ok(refused.err && /a size saved designs use answered removed \/ no code, not refused \/ used/.test(refused.err),
      "...the apply-time check refuses the file on a seed with a size in use", refused.err);
    const d = await applied("", sql);
    ok(!d.err && d.record.used_check === "skipped", "...(with no size in use it applies, skipped)", d.err);
    await d.db.exec(WORK);
    const r = await call(d.db, { removes: [await del(d.db, SZ_DESIGN)] });
    ok(r.removed[0].status === "removed" && !await exists(d.db, SZ_DESIGN), "...and a size a design names is deleted", J(r.removed[0]));
  });
  await guard(async () => {
    const sql = mutant("        elsif v_row.updated_at is distinct from (v_e ->> 'base')::timestamptz then\n", "        elsif false then\n");
    ok(!!sql, "(the mutant formed: no version check)");
    const refused = await applied(WORK, sql);
    ok(refused.err && /a delete at a stale version answered refused \/ used, not refused \/ changed/.test(refused.err),
      "...the apply-time check refuses the file", refused.err);
    const d = await applied("", sql);
    const v0 = await version(d.db, SZ_STALE);
    await call(d.db, { sizes: [{ id: SZ_STALE, base: v0, from: { price: 1200 }, to: { price: 1250 } }] });
    const r = await call(d.db, { removes: [{ id: SZ_STALE, base: v0 }] });
    ok(r.removed[0].status === "removed" && !await exists(d.db, SZ_STALE), "...and a Delete confirmed on the old version deletes the colleague's price", J(r.removed[0]));
  });
  await guard(async () => {
    const newArm = MIG().slice(MIG().indexOf("           -- [351.a begin]"), MIG().indexOf("           -- [351.a end]\n") + "           -- [351.a end]\n".length);
    const sql = mutant(newArm, "           select case when e.x #>> '{}' ~* c_uuid then (e.x #>> '{}')::uuid end from jsonb_array_elements(v_removes) e(x)))\n");
    ok(!!sql && newArm.length > 100, "(the mutant formed: the lock list without its object arm, as 350's)");
    const l = await lockedByDelete(sql);
    ok(!l.err && l.r.removed[0].code === "used", "...it applies and still refuses the size in use", J(l.err || l.r));
    ok(l.after === "0", "...but never locked it: the xmax check above fails", J([l.before, l.after]));
    const lockStmt = l.def.slice(l.def.indexOf("perform 1 from public.building_sizes z"), l.def.indexOf("   for update;"));
    ok(!/jsonb_typeof\(e\.x\) = 'object'/.test(lockStmt), "...and so does the pg_get_functiondef check");
  });
  await guard(async () => {
    const read = "          select coalesce(jsonb_object_agg(i.item_key, i.qty), '{}'::jsonb) into v_cells\n            from public.building_size_inclusions i where i.size_id = v_id and i.included;\n";
    const delLine = "          delete from public.building_sizes z where z.id = v_id and z.client_id = p_client_id returning z.* into v_row;\n";
    const sql = mutant(read + delLine, delLine + read);
    ok(!!sql, "(the mutant formed: the boxes read after the delete)");
    const d = await applied(WORK, sql);
    const r = await call(d.db, { removes: [await del(d.db, SZ_PRICED)] });
    ok(!d.err && r.removed[0].status === "removed" && J(r.removed[0].cells) === "{}", "...and the answer's cells come back empty (the check above fails)", J(d.err || r.removed[0]));
  });

  for (const d of opened) await d.close().catch(() => {});
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch(async (e) => { console.error(e); for (const d of opened) await d.close().catch(() => {}); process.exitCode = 1; });
