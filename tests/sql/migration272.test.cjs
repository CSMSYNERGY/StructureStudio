// Execute migration 272 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// style_wall_heights as it is live (172's inline unique key, 173's widths, 175's internal_only,
// 183/228's build-on-site columns), then check what PART 1 promises: the old (client, style,
// increase) key replaced by (client, style, increase, build_on_site); one hauled and one
// built-on-site row per increase accepted, a second of either refused; every existing row
// untouched; the apply-time probe leaving nothing; a re-apply that changes nothing; and assertions
// that really abort the whole apply (mutants). PART 2 runs on insulation_offerings as it is live
// (177's inline type check, 178's internal_only) beside a get_config cut to its live insulation
// block: rigid foam accepted, an unknown type still refused, a rigid foam floor row reaching
// get_config as it is, and every tenant's get_config unchanged by the apply. PART 3 runs on
// fixture_items as it is live, with get_fixtures created from 208's own statement (the live body,
// byte for byte): style_ids added, get_fixtures replaced only when it is the body PART 3 was derived
// from, every tenant's catalog unchanged, styleKeys sent only for a restricted row, in catalog
// order and only this tenant's styles, and the rollback restoring the old body. Nothing here
// touches the live project: no network, no Supabase.
//
// Tenants and styles are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration272.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/272_builder_options.sql"), "utf8");

// get_fixtures as it is live: 208's own create statement, carriage returns removed (a Windows
// checkout has them; the live body does not). PART 3 checks it by the md5 of its body, so the
// stub must BE the live body or the apply refuses it, which the first PART 3 check pins.
const GET_FIXTURES_208 = (() => {
  const t = fs.readFileSync(path.join(WT, "supabase/migrations/208_get_fixtures_door_sill.sql"), "utf8").replace(/\r/g, "");
  const i = t.indexOf("create or replace function public.get_fixtures(p_client_id text)");
  const j = t.indexOf("\n$$\n;", i);
  if (i < 0 || j < 0) throw new Error("208's get_fixtures statement moved; re-point GET_FIXTURES_208");
  return t.slice(i, j + "\n$$\n;".length);
})();
const LIVE_BODY_MD5 = "4f9f6b26e06da08b52123bdb6f560e27";   // prosrc, as dumped on 2026-10-05

// The tables 272 touches, cut to the columns that matter, with the live constraints. A later PART
// of this batch file that touches another table adds its stub here. `extra` lets a mutant add
// something the assertions must refuse.
const STUBS = (extra = "") => `
create table public.building_styles (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  key text not null,
  label text not null
);

create table public.style_wall_heights (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null,
  style_id     uuid not null references public.building_styles(id) on delete cascade,
  delta_in     integer not null check (delta_in > 0 and delta_in <= 48),
  rate_per_lf  numeric check (rate_per_lf is null or rate_per_lf >= 0),
  taxable      boolean not null default true,
  active       boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (client_id, style_id, delta_in)
);
alter table public.style_wall_heights add column widths_ft numeric[];
alter table public.style_wall_heights add column internal_only boolean not null default false;
alter table public.style_wall_heights
  add column build_on_site boolean not null default false,
  add column bos_fee_basis text,
  add column bos_fee_rate  numeric(12,2);
alter table public.style_wall_heights
  add constraint style_wall_heights_bos_basis_check
  check (bos_fee_basis is null or bos_fee_basis in (
    'each', 'lineal_ft', 'sqft_option', 'sqft_building', 'perimeter_building',
    'pct_building_price', 'pct_estimate_total'));
create index style_wall_heights_style_idx on public.style_wall_heights (style_id);

-- PART 2: insulation_offerings as 177 + 178 left it (the inline type check names itself
-- insulation_offerings_ins_type_check, as it is live), and get_config cut to its insulation key,
-- the block as it is live after 177, 178 and 182.
create table public.client_configs (client_id text primary key);
create table public.client_settings (
  client_id          text primary key,
  show_pricing       boolean,
  insulation_enabled boolean not null default false
);
create table public.insulation_offerings (
  id              uuid primary key default gen_random_uuid(),
  client_id       text not null,
  ins_type        text not null check (ins_type in ('batt', 'spray_foam')),
  area            text not null check (area in ('floor', 'walls', 'roof')),
  rate_per_sqft   numeric check (rate_per_sqft is null or rate_per_sqft >= 0),
  taxable         boolean not null default true,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (client_id, ins_type, area)
);
alter table public.insulation_offerings add column internal_only boolean not null default false;
create function public.get_config(p_client_id text) returns jsonb language sql stable as $fn$
  select jsonb_build_object(
    'insulation', case when coalesce((select cs.insulation_enabled from public.client_settings cs where cs.client_id = cc.client_id), false)
      then coalesce((
        select jsonb_agg(jsonb_build_object('type', io.ins_type, 'area', io.area,
                 'ratePerSqft', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
                                     then io.rate_per_sqft else null end)
                 || case when coalesce(io.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
               order by io.ins_type, io.area)
        from public.insulation_offerings io
        where io.client_id = cc.client_id and io.active and io.rate_per_sqft is not null), '[]'::jsonb)
      else '[]'::jsonb end)
  from public.client_configs cc where cc.client_id = p_client_id
$fn$;

-- PART 3: what get_fixtures reads, as it is live: fixture_items with every column (064 onward),
-- colors and window_colors cut to the columns it names, building_styles' sort_order, and the ramp
-- columns of client_settings. Then get_fixtures itself, from 208's statement (GET_FIXTURES_208).
alter table public.building_styles
  add column sort_order integer not null default 0,
  add column active boolean not null default true;
alter table public.client_settings
  add column ramp_mode text, add column ramp_price numeric, add column ramp_price_method text,
  add column ramp_image_url text, add column ramp_show_image boolean, add column ramp_enabled boolean;
create table public.colors (
  id uuid primary key default gen_random_uuid(), client_id text not null, label text not null,
  hex text, active boolean not null default true
);
create table public.window_colors (
  id uuid primary key default gen_random_uuid(), client_id text not null, label text not null, hex text,
  is_default boolean not null default false, rate numeric, sort_order integer not null default 0,
  active boolean not null default true
);
create table public.fixture_items (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  category text not null default 'door',
  name text not null,
  width_in numeric not null,
  height_in numeric not null,
  price numeric,
  swing_in boolean not null default false, swing_out boolean not null default false, swing_default text,
  op_right boolean not null default false, op_left boolean not null default false,
  op_double boolean not null default false, op_slideup boolean not null default false, op_default text,
  image_url text,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  plan_label text,
  show_image_on_estimate boolean not null default true,
  archived boolean not null default false,
  internal_only boolean not null default false,
  color_mode text not null default 'fixed',
  has_trim_color boolean not null default false,
  fixed_color_id uuid references public.colors(id) on delete set null,
  window_color_ids uuid[],
  sill_in numeric,
  sill_mode text not null default 'fixed',
  taxable boolean not null default true,
  door_style text not null default 'auto'
);
${GET_FIXTURES_208}
${extra}
`;

// Fixed ids so "nothing moved" can compare whole rows, updated_at included.
const DELUXE = "00000000-0000-4000-8000-000000000001";
const LOFTED = "00000000-0000-4000-8000-000000000002";
const GREENHOUSE = "00000000-0000-4000-8000-000000000003";
const COTTAGE = "00000000-0000-4000-8000-000000000004";
const VENT = "00000000-0000-4000-8000-0000000000f1";
const GARAGE = "00000000-0000-4000-8000-0000000000f2";
const SEED = `
insert into public.building_styles (id, client_id, key, label) values
  ('${DELUXE}', 'acme-sheds',  'deluxe', 'Deluxe'),
  ('${LOFTED}', 'bravo-barns', 'lofted', 'Lofted Barn');
insert into public.style_wall_heights (id, client_id, style_id, delta_in, rate_per_lf, widths_ft, build_on_site, bos_fee_basis, bos_fee_rate, updated_at) values
  ('00000000-0000-4000-8000-0000000000a1', 'acme-sheds',  '${DELUXE}', 12, 4.75, '{8,10,12}', false, null,   null, '2026-09-20 10:00+00'),
  ('00000000-0000-4000-8000-0000000000b1', 'bravo-barns', '${LOFTED}', 6,  2,    '{8,10,12,14}', false, null, null, '2026-09-01 10:00+00'),
  ('00000000-0000-4000-8000-0000000000b2', 'bravo-barns', '${LOFTED}', 24, 9,    '{8,10}', true, 'each', 500, '2026-09-14 10:00+00');
insert into public.client_configs (client_id) values ('acme-sheds'), ('bravo-barns');
-- acme-sheds has insulation switched off and no rates (the builder who asked for rigid foam);
-- bravo-barns sells batt and spray foam, with a blank spray-foam roof, like the live tenant.
insert into public.client_settings (client_id, show_pricing, insulation_enabled) values
  ('acme-sheds', true, false), ('bravo-barns', true, true);
insert into public.insulation_offerings (id, client_id, ins_type, area, rate_per_sqft, internal_only, updated_at) values
  ('00000000-0000-4000-8000-0000000000c1', 'bravo-barns', 'batt',       'floor', 1.10, false, '2026-09-02 10:00+00'),
  ('00000000-0000-4000-8000-0000000000c2', 'bravo-barns', 'batt',       'walls', 0.90, false, '2026-09-02 10:00+00'),
  ('00000000-0000-4000-8000-0000000000c3', 'bravo-barns', 'spray_foam', 'walls', 2.20, true,  '2026-09-02 10:00+00'),
  ('00000000-0000-4000-8000-0000000000c4', 'bravo-barns', 'spray_foam', 'roof',  null, false, '2026-09-02 10:00+00');

-- PART 3: acme-sheds sells a Greenhouse (sorted last) and a Cottage (sorted first, tied with
-- the Deluxe on 0, so the key breaks the tie); a vent, a garage door with its own 3D look and a
-- fixed colour, a window with a colour list and a sill, a ramp, an archived door and an unpriced
-- vent (neither is sent). bravo-barns has one door.
insert into public.building_styles (id, client_id, key, label, sort_order) values
  ('${GREENHOUSE}', 'acme-sheds', 'greenhouse', 'Greenhouse', 4),
  ('${COTTAGE}', 'acme-sheds', 'cottage', 'Cottage', 0);
update public.client_settings set ramp_mode = 'custom', ramp_enabled = true, ramp_price = 150 where client_id = 'acme-sheds';
insert into public.colors (id, client_id, label, hex) values
  ('00000000-0000-4000-8000-0000000000e1', 'acme-sheds', 'Barn Red', '#7C2D12');
insert into public.window_colors (id, client_id, label, hex, is_default, rate) values
  ('00000000-0000-4000-8000-0000000000e2', 'acme-sheds', 'White', '#FFFFFF', true, 0),
  ('00000000-0000-4000-8000-0000000000e3', 'acme-sheds', 'Black', '#111111', false, 25);
insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, sort_order, door_style, color_mode, fixed_color_id, window_color_ids, sill_in, archived, updated_at) values
  ('${VENT}',    'acme-sheds',  'vent',   'Standard vent',      12, 8,  0,    0, 'auto',   'fixed', null, null, null, false, '2026-09-20 10:00+00'),
  ('${GARAGE}',  'acme-sheds',  'door',   'Garage Door',        96, 84, 900,  0, 'rollup', 'fixed', '00000000-0000-4000-8000-0000000000e1', null, null, false, '2026-09-20 10:00+00'),
  ('00000000-0000-4000-8000-0000000000f3', 'acme-sheds',  'window', '2x3 Window', 24, 36, 90, 0, 'auto', 'fixed', null, '{00000000-0000-4000-8000-0000000000e2}', 42, false, '2026-09-20 10:00+00'),
  ('00000000-0000-4000-8000-0000000000f4', 'acme-sheds',  'ramp',   'Wood ramp',          72, 24, 120,  0, 'auto',   'fixed', null, null, null, false, '2026-09-20 10:00+00'),
  ('00000000-0000-4000-8000-0000000000f5', 'acme-sheds',  'door',   'Old door',           36, 72, 150,  1, 'auto',   'fixed', null, null, null, true,  '2026-09-20 10:00+00'),
  ('00000000-0000-4000-8000-0000000000f6', 'acme-sheds',  'vent',   'Unpriced vent',      12, 12, null, 1, 'auto',   'fixed', null, null, null, false, '2026-09-20 10:00+00'),
  ('00000000-0000-4000-8000-0000000000f7', 'bravo-barns', 'door',   'Single door',        36, 76, 400,  0, 'auto',   'fixed', null, null, null, false, '2026-09-20 10:00+00');
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

const snapshot = async (db) => JSON.stringify(await rows(db,
  `select id, client_id, style_id, delta_in, rate_per_lf, taxable, active, sort_order, widths_ft, internal_only,
          build_on_site, bos_fee_basis, bos_fee_rate, created_at, updated_at
     from public.style_wall_heights order by id`));

/** Did this statement fail on a unique key? Returns the constraint name, or null if it went in. */
async function uniqueRefusal(db, sql) {
  await db.exec("savepoint probe");
  try {
    await db.exec(sql);
    await db.exec("release savepoint probe");
    return null;
  } catch (e) {
    await db.exec("rollback to savepoint probe");
    const m = /unique constraint "([^"]+)"/.exec(e.message);
    return m ? m[1] : "other: " + e.message;
  }
}

async function fresh(extra) {
  const db = new PGlite();
  await db.exec(STUBS(extra));
  await db.exec(SEED);
  return db;
}

const uniqueKeys = async (db) => (await rows(db, `select conname, pg_get_constraintdef(oid) def from pg_constraint
  where conrelid = 'public.style_wall_heights'::regclass and contype = 'u' order by conname`));

// PART 2 helpers.
const insSnapshot = async (db) => JSON.stringify(await rows(db,
  `select id, client_id, ins_type, area, rate_per_sqft, taxable, active, internal_only, created_at, updated_at
     from public.insulation_offerings order by id`));
const typeChecks = async (db) => (await rows(db, `select conname, pg_get_constraintdef(oid) def from pg_constraint
  where conrelid = 'public.insulation_offerings'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%ins_type%' order by conname`));
const configs = async (db) => JSON.stringify(await rows(db,
  `select client_id, md5(public.get_config(client_id)::text) h from public.client_configs order by client_id`));
const THREE = "CHECK ((ins_type = ANY (ARRAY['batt'::text, 'spray_foam'::text, 'rigid_foam'::text])))";
const TWO = "CHECK ((ins_type = ANY (ARRAY['batt'::text, 'spray_foam'::text])))";
// PART 3 helpers.
const NEW_BODY_MD5 = "276d22b7c1a3d60ebe7c5d6e58373de6";   // the body PART 3 writes (its own pin)
const bodyMd5 = async (db) => (await one(db,
  "select md5(replace(prosrc, E'\\r', '')) h from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure")).h;
const fixtureCatalogs = async (db) => JSON.stringify(await rows(db,
  `select client_id, md5(public.get_fixtures(client_id)::text) h from public.client_configs order by client_id`));
const fixSnapshot = async (db) => JSON.stringify(await rows(db,
  `select * from public.fixture_items order by id`));
const itemsOf = async (db, client) => (await one(db, "select public.get_fixtures($1) j", [client])).j.items;
const itemNamed = async (db, client, name) => (await itemsOf(db, client)).find((i) => i.name === name);
// Every assertion of PART 3A that a mutant has to get past to reach the one under test.
const dropPostMd5 = (sql) => sql.replace(/  if md5\(v_src\) <> '[0-9a-f]{32}' then\n    raise exception '272: get_fixtures is not the body PART 3 writes[^\n]*\n  end if;\n/, "");
const dropPreMd5 = (sql) => sql.replace(/  if md5\(v_src\) not in \('[0-9a-f]{32}', '[0-9a-f]{32}'\) then\n    raise exception[^\n]*\n  end if;\n/, "");

/** Did this statement fail on a check? Returns the constraint name, or null if it went in. */
async function checkRefusal(db, sql) {
  await db.exec("savepoint probe");
  try {
    await db.exec(sql);
    await db.exec("release savepoint probe");
    return null;
  } catch (e) {
    await db.exec("rollback to savepoint probe");
    const m = /check constraint "([^"]+)"/.exec(e.message);
    return m ? m[1] : "other: " + e.message;
  }
}

(async () => {
  console.log("migration 272 PART 1: applies on the live shape and moves no row");
  {
    const db = await fresh();
    const before = await snapshot(db);
    let applied = true;
    try { await db.exec(MIG()); } catch (e) { applied = false; ok(false, "272 applied", e.message); }
    ok(applied, "272 applied cleanly, assertions and probe included");

    const keys = await uniqueKeys(db);
    ok(keys.length === 1 && keys[0].conname === "style_wall_heights_client_style_delta_bos_key"
      && keys[0].def === "UNIQUE (client_id, style_id, delta_in, build_on_site)",
      "the one unique key is (client, style, increase, built on site)", JSON.stringify(keys));
    ok(await snapshot(db) === before, "every existing row, updated_at included, is untouched (and the probe left nothing)");

    // ── The pair this exists for: +12 hauled on 8-12, +12 built on site on 14 ──
    await db.exec("begin");
    ok(await uniqueRefusal(db, `insert into public.style_wall_heights (client_id, style_id, delta_in, rate_per_lf, widths_ft, build_on_site, bos_fee_basis, bos_fee_rate)
      values ('acme-sheds', '${DELUXE}', 12, 6.50, '{14}', true, 'each', 750)`) === null,
      "a built-on-site +12 row beside the hauled +12 row goes in");
    ok(await uniqueRefusal(db, `insert into public.style_wall_heights (client_id, style_id, delta_in, rate_per_lf, widths_ft, build_on_site)
      values ('acme-sheds', '${DELUXE}', 12, 7, '{14}', false)`) === "style_wall_heights_client_style_delta_bos_key",
      "a second HAULED +12 row is refused by the new key");
    ok(await uniqueRefusal(db, `insert into public.style_wall_heights (client_id, style_id, delta_in, rate_per_lf, widths_ft, build_on_site)
      values ('acme-sheds', '${DELUXE}', 12, 7, '{16}', true)`) === "style_wall_heights_client_style_delta_bos_key",
      "a second BUILT-ON-SITE +12 row is refused too: never a third row for one increase");
    // Flipping which row is on site in one go is what portal-settings' key-first binding avoids;
    // done naively (the hauled row first) it collides, which is why the save binds by key.
    ok(await uniqueRefusal(db, `update public.style_wall_heights set build_on_site = true
      where client_id = 'acme-sheds' and style_id = '${DELUXE}' and delta_in = 12 and build_on_site = false`) === "style_wall_heights_client_style_delta_bos_key",
      "a row-by-row swap of the on-site flag collides mid-way (the save writes by key to avoid it)");
    // Other tenants and other styles are untouched by the key: the same increase elsewhere is free.
    ok(await uniqueRefusal(db, `insert into public.style_wall_heights (client_id, style_id, delta_in, rate_per_lf, build_on_site)
      values ('bravo-barns', '${LOFTED}', 12, 4, false)`) === null,
      "the same increase on another tenant's style is unaffected");
    await db.exec("rollback");

    // ── Re-apply: a no-op ──
    const all = await snapshot(db);
    let again = true;
    try { await db.exec(MIG()); } catch (e) { again = false; ok(false, "re-apply", e.message); }
    ok(again, "a second apply succeeds (the key is added only when missing)");
    ok(await snapshot(db) === all, "and changes nothing");
    ok((await uniqueKeys(db)).length === 1, "still exactly one unique key after two applies");

    // ── A re-apply after a builder saved a pair still passes: the probe uses an unused increase ──
    await db.exec(`insert into public.style_wall_heights (client_id, style_id, delta_in, rate_per_lf, widths_ft, build_on_site)
      values ('acme-sheds', '${DELUXE}', 12, 6.50, '{14}', true)`);
    const withPair = await snapshot(db);
    let third = true;
    try { await db.exec(MIG()); } catch (e) { third = false; ok(false, "re-apply with a saved pair", e.message); }
    ok(third && await snapshot(db) === withPair, "a re-apply with a hauled + on-site pair saved keeps both rows as they are");
    await db.close();
  }

  console.log("migration 272 PART 1: applies on an empty table too");
  {
    const db = new PGlite();
    await db.exec(STUBS());
    let applied = true;
    try { await db.exec(MIG()); } catch (e) { applied = false; ok(false, "272 on an empty table", e.message); }
    ok(applied, "no rows to probe is not a failure; the key is still checked by definition");
    ok((await uniqueKeys(db)).length === 1, "and the new key is in place");
    await db.close();
  }

  console.log("migration 272 PART 1: the assertions abort the whole migration");
  {
    // A hand-made unique index on the old three columns would still refuse the second row.
    const db = await fresh("create unique index style_wall_heights_legacy_uq on public.style_wall_heights (client_id, style_id, delta_in);");
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /272: style_wall_heights carries another unique index besides the new key/.test(err.message),
      "a leftover unique index on the old columns stops the apply", err && err.message);
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const keys = await uniqueKeys(db);
    ok(keys.length === 1 && keys[0].conname === "style_wall_heights_client_id_style_id_delta_in_key",
      "and the old key is back: nothing of the apply is left behind", JSON.stringify(keys));
    await db.close();
  }
  {
    // A copy that lost the ADD CONSTRAINT: the old key is dropped and nothing replaces it.
    const db = await fresh();
    const broken = MIG().replace(/alter table public\.style_wall_heights\s+add constraint style_wall_heights_client_style_delta_bos_key\s+unique \(client_id, style_id, delta_in, build_on_site\);/, "null;");
    ok(broken !== MIG(), "the mutant really lost its new key");
    let err = null;
    try { await db.exec(broken); } catch (e) { err = e; }
    ok(!!err && /272: style_wall_heights_client_style_delta_bos_key should be UNIQUE/.test(err.message),
      "a missing new key stops the apply", err && err.message);
    await db.close();
  }
  {
    // A copy whose key forgot build_on_site: the second row would still be refused.
    const db = await fresh();
    const broken = MIG().replace("unique (client_id, style_id, delta_in, build_on_site);", "unique (client_id, style_id, delta_in);");
    ok(broken !== MIG(), "the mutant really narrowed the key");
    let err = null;
    try { await db.exec(broken); } catch (e) { err = e; }
    ok(!!err && /272: style_wall_heights_client_style_delta_bos_key should be UNIQUE \(client_id, style_id, delta_in, build_on_site\), is UNIQUE \(client_id, style_id, delta_in\)/.test(err.message),
      "a key without build_on_site stops the apply", err && err.message);
    await db.close();
  }
  {
    // A copy that kept the old key (the drop removed): the probe's built-on-site row is refused.
    const db = await fresh();
    const broken = MIG().replace(/alter table public\.style_wall_heights\s+drop constraint if exists style_wall_heights_client_id_style_id_delta_in_key;/, "");
    ok(broken !== MIG(), "the mutant really kept the old key");
    let err = null;
    try { await db.exec(broken); } catch (e) { err = e; }
    ok(!!err && /272: the old \(client_id, style_id, delta_in\) key is still on style_wall_heights/.test(err.message),
      "an old key left in place stops the apply", err && err.message);
    await db.close();
  }

  console.log("migration 272 PART 2: rigid foam is a third insulation type, and nothing else moves");
  {
    const db = await fresh();
    const insBefore = await insSnapshot(db);
    const cfgBefore = await configs(db);
    ok((await typeChecks(db)).length === 1 && (await typeChecks(db))[0].def === TWO,
      "the stub starts where live is: batt and spray foam only", JSON.stringify(await typeChecks(db)));
    let applied = true;
    try { await db.exec(MIG()); } catch (e) { applied = false; ok(false, "272 applied", e.message); }
    ok(applied, "272 applied with PART 2");

    const checks = await typeChecks(db);
    ok(checks.length === 1 && checks[0].conname === "insulation_offerings_ins_type_check" && checks[0].def === THREE,
      "the one check on ins_type keeps its name and allows batt, spray foam and rigid foam", JSON.stringify(checks));
    ok(await insSnapshot(db) === insBefore, "every insulation row, updated_at included, is untouched");
    ok((await one(db, "select count(*)::int n from public.insulation_offerings where client_id = '__m272_probe__'")).n === 0,
      "the probe left no row behind");
    ok(await configs(db) === cfgBefore, "every tenant's get_config is byte-for-byte unchanged by the apply");

    // ── What the builder does after it: a Floor rate for Rigid Foam, Walls and Roof left blank ──
    await db.exec("begin");
    ok(await checkRefusal(db, `insert into public.insulation_offerings (client_id, ins_type, area, rate_per_sqft)
      values ('acme-sheds', 'rigid_foam', 'floor', 1.25)`) === null,
      "a rigid foam floor rate goes in");
    ok(await checkRefusal(db, `insert into public.insulation_offerings (client_id, ins_type, area, rate_per_sqft)
      values ('acme-sheds', 'rockwool', 'floor', 1)`) === "insulation_offerings_ins_type_check",
      "an unknown type is still refused by the same check");
    ok(await checkRefusal(db, `insert into public.insulation_offerings (client_id, ins_type, area, rate_per_sqft)
      values ('acme-sheds', 'rigid_foam', 'ceiling', 1)`) === "insulation_offerings_area_check",
      "the three areas are unchanged: rigid foam gets floor, walls and roof like the others");
    const off = await one(db, "select public.get_config('acme-sheds') -> 'insulation' j");
    ok(JSON.stringify(off.j) === "[]", "switched off, the tenant still offers nothing", JSON.stringify(off.j));
    await db.exec("update public.client_settings set insulation_enabled = true where client_id = 'acme-sheds'");
    const on = await one(db, "select public.get_config('acme-sheds') -> 'insulation' j");
    ok(JSON.stringify(on.j) === JSON.stringify([{ area: "floor", type: "rigid_foam", ratePerSqft: 1.25 }]),
      "switched on, get_config emits the rigid foam floor row as it is: one type, one area", JSON.stringify(on.j));
    const other = await one(db, "select public.get_config('bravo-barns') -> 'insulation' j");
    ok(Array.isArray(other.j) && other.j.length === 3 && !other.j.some((o) => o.type === "rigid_foam"),
      "another tenant's insulation is untouched by it", JSON.stringify(other.j));
    await db.exec("rollback");

    // ── Re-apply with a rigid foam row saved: the check still holds it, the row stays ──
    await db.exec(`insert into public.insulation_offerings (client_id, ins_type, area, rate_per_sqft)
      values ('acme-sheds', 'rigid_foam', 'floor', 1.25)`);
    const withFoam = await insSnapshot(db);
    let again = true;
    try { await db.exec(MIG()); } catch (e) { again = false; ok(false, "re-apply with a rigid foam row", e.message); }
    ok(again && await insSnapshot(db) === withFoam, "a re-apply with a rigid foam row saved keeps it as it is");
    ok((await typeChecks(db)).length === 1, "still exactly one check on ins_type after two applies");
    await db.close();
  }

  console.log("migration 272 PART 2: the assertions abort the whole migration");
  {
    // A second, hand-made check on ins_type would still refuse rigid foam.
    const db = await fresh("alter table public.insulation_offerings add constraint insulation_offerings_type_legacy check (ins_type in ('batt', 'spray_foam'));");
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /272: insulation_offerings carries another check on ins_type/.test(err.message),
      "a leftover second check on ins_type stops the apply", err && err.message);
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const checks = await typeChecks(db);
    const keys = await uniqueKeys(db);
    ok(checks.some((c) => c.conname === "insulation_offerings_ins_type_check" && c.def === TWO)
      && keys.length === 1 && keys[0].conname === "style_wall_heights_client_id_style_id_delta_in_key",
      "and PART 1 and PART 2 are both undone: the old check and the old key are back", JSON.stringify({ checks, keys }));
    await db.close();
  }
  {
    // A copy whose new check forgot rigid foam.
    const db = await fresh();
    const broken = MIG().replace("check (ins_type in ('batt', 'spray_foam', 'rigid_foam'));", "check (ins_type in ('batt', 'spray_foam'));");
    ok(broken !== MIG(), "the mutant really lost rigid foam");
    let err = null;
    try { await db.exec(broken); } catch (e) { err = e; }
    ok(!!err && /272: insulation_offerings_ins_type_check should allow batt, spray_foam and rigid_foam/.test(err.message),
      "a check without rigid foam stops the apply", err && err.message);
    await db.close();
  }
  {
    // A get_config that lists the types it emits would drop rigid foam on the way to the designer.
    const db = await fresh(`create or replace function public.get_config(p_client_id text) returns jsonb language sql stable as $fn$
      select jsonb_build_object('insulation', coalesce((select jsonb_agg(jsonb_build_object('type', io.ins_type, 'area', io.area))
        from public.insulation_offerings io where io.client_id = p_client_id and io.ins_type in ('batt', 'spray_foam')), '[]'::jsonb))
    $fn$;`);
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /272: get_config names an insulation type/.test(err.message),
      "a get_config that lists insulation types stops the apply", err && err.message);
    await db.close();
  }
  {
    // A copy that widened the check to accept anything: the probe's unknown type goes in.
    const db = await fresh();
    const broken = MIG()
      .replace("check (ins_type in ('batt', 'spray_foam', 'rigid_foam'));", "check (ins_type in ('batt', 'spray_foam', 'rigid_foam') or ins_type is not null);")
      .replace(/if v_def is distinct from \$d\$[^\n]*\n[^\n]*\n\s*end if;/, "null;");
    ok(broken !== MIG() && !/is distinct from \$d\$/.test(broken), "the mutant really opened the check and lost its definition test");
    let err = null;
    try { await db.exec(broken); } catch (e) { err = e; }
    ok(!!err && /272: an unknown insulation type was accepted/.test(err.message),
      "the probe alone catches a check that lets any type in", err && err.message);
    await db.close();
  }

  console.log("migration 272 PART 3: offered on some styles only, and nothing else moves");
  {
    const db = await fresh();
    ok(await bodyMd5(db) === LIVE_BODY_MD5, "the stub get_fixtures IS the live body (208's statement, prosrc md5 as dumped)", await bodyMd5(db));
    const before = await fixtureCatalogs(db);
    const rowsBefore = await fixSnapshot(db);
    const acmeBefore = await itemsOf(db, "acme-sheds");
    ok(acmeBefore.length === 4 && !acmeBefore.some((i) => "styleKeys" in i), "before: acme's four offered fixtures, none with styleKeys",
      JSON.stringify(acmeBefore.map((i) => i.name)));
    let applied = true;
    try { await db.exec(MIG()); } catch (e) { applied = false; ok(false, "272 applied", e.message); }
    ok(applied, "272 applied with PART 3, its assertions and probe included");

    const col = await one(db, `select udt_name, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'fixture_items' and column_name = 'style_ids'`);
    ok(!!col && col.udt_name === "_uuid" && col.is_nullable === "YES" && col.column_default === null,
      "fixture_items.style_ids is a nullable uuid[] with no default", JSON.stringify(col));
    ok(await bodyMd5(db) === NEW_BODY_MD5, "get_fixtures is the body PART 3 writes (the pin in the file matches)", await bodyMd5(db));
    ok(await fixtureCatalogs(db) === before, "every tenant's get_fixtures is byte-for-byte unchanged by the apply");
    const rowsAfter = JSON.parse(await fixSnapshot(db));
    ok(rowsAfter.every((r) => r.style_ids === null) && JSON.stringify(rowsAfter.map(({ style_ids: _s, ...r }) => r)) === rowsBefore,
      "every fixture row is untouched, updated_at included, and reads style_ids NULL (and the probe left nothing)");
    const tmp = await one(db, "select to_regclass('pg_temp.m272_fixtures_before') t");
    ok(tmp.t === null, "the before-snapshot table is gone with the commit");

    // ── What the builder does after it ──
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const plain = (i) => { const { styleKeys: _k, ...rest } = i; return rest; };
    await db.exec("begin");
    await db.exec(`update public.fixture_items set style_ids = '{${GREENHOUSE}}' where id = '${VENT}'`);
    let v = await itemNamed(db, "acme-sheds", "Standard vent");
    ok(same(v.styleKeys, ["greenhouse"]), "a vent offered on the Greenhouse only carries styleKeys [\"greenhouse\"]", JSON.stringify(v.styleKeys));
    ok(same(plain(v), acmeBefore.find((i) => i.name === "Standard vent")), "...and every other key of it is what it was");
    await db.exec(`update public.fixture_items set style_ids = '{${GREENHOUSE},${DELUXE},${COTTAGE}}' where id = '${VENT}'`);
    v = await itemNamed(db, "acme-sheds", "Standard vent");
    ok(same(v.styleKeys, ["cottage", "deluxe", "greenhouse"]), "several styles come in catalog order (sort_order, then key), not the order ticked", JSON.stringify(v.styleKeys));
    await db.exec(`update public.fixture_items set style_ids = '{${LOFTED},${GREENHOUSE}}' where id = '${VENT}'`);
    v = await itemNamed(db, "acme-sheds", "Standard vent");
    ok(same(v.styleKeys, ["greenhouse"]), "another tenant's style id names nothing: only this tenant's styles", JSON.stringify(v.styleKeys));
    await db.exec(`update public.fixture_items set style_ids = '{00000000-0000-4000-8000-00000000dead}' where id = '${VENT}'`);
    v = await itemNamed(db, "acme-sheds", "Standard vent");
    ok(same(v.styleKeys, []), "a list naming only a deleted style sends [] (offered nowhere), not every style", JSON.stringify(v.styleKeys));
    await db.exec(`update public.fixture_items set style_ids = '{${DELUXE},${COTTAGE}}' where id = '${GARAGE}'`);
    const g = await itemNamed(db, "acme-sheds", "Garage Door");
    ok(same(g.styleKeys, ["cottage", "deluxe"]) && g.doorStyle === "rollup" && g.fixedColor && g.fixedColor.label === "Barn Red" && g.price === 900,
      "a door keeps its 3D look, fixed colour and price beside its styleKeys", JSON.stringify(g));
    await db.exec(`update public.fixture_items set style_ids = null where id = '${VENT}'`);
    v = await itemNamed(db, "acme-sheds", "Standard vent");
    ok(!("styleKeys" in v), "back to NULL: no styleKeys key at all", JSON.stringify(v));
    const bravo = await itemsOf(db, "bravo-barns");
    ok(bravo.length === 1 && !("styleKeys" in bravo[0]) && bravo[0].name === "Single door", "another tenant's catalog is untouched by it", JSON.stringify(bravo));
    await db.exec("rollback");

    // ── Re-apply: a no-op, also with a restricted row saved ──
    await db.exec(`update public.fixture_items set style_ids = '{${GREENHOUSE}}' where id = '${VENT}'`);
    const withTick = await fixtureCatalogs(db);
    const rowsTick = await fixSnapshot(db);
    let again = true;
    try { await db.exec(MIG()); } catch (e) { again = false; ok(false, "re-apply with a restricted vent", e.message); }
    ok(again && await fixtureCatalogs(db) === withTick && await fixSnapshot(db) === rowsTick && await bodyMd5(db) === NEW_BODY_MD5,
      "a re-apply with a restricted vent saved passes and changes nothing");

    // ── Rollback as the file writes it: 208's body back first, then the column ──
    await db.exec(GET_FIXTURES_208);
    ok(await bodyMd5(db) === LIVE_BODY_MD5, "rollback: re-issuing 208's statement restores the live body");
    await db.exec("alter table public.fixture_items drop column if exists style_ids");
    ok(await fixtureCatalogs(db) === before, "rollback: and every tenant's get_fixtures is what it was before 272");
    await db.close();
  }

  console.log("migration 272 PART 3: the assertions abort the whole migration");
  {
    // Another change replaced get_fixtures after PART 3 was derived: a body PART 3 does not know.
    const drifted = GET_FIXTURES_208.replace("    order by fi.category, fi.sort_order, fi.name)", "    order by fi.category, fi.name, fi.sort_order)");
    const db = await fresh(drifted);
    ok(drifted !== GET_FIXTURES_208 && await bodyMd5(db) !== LIVE_BODY_MD5, "the stub really drifted");
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /272: the LIVE get_fixtures \(prosrc md5 [0-9a-f]{32}\) is neither the body PART 3 was derived from/.test(err.message),
      "a get_fixtures some other change replaced stops the apply, rather than being reverted", err && err.message);
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const col = await one(db, `select count(*)::int n from information_schema.columns where table_name = 'fixture_items' and column_name = 'style_ids'`);
    const keys = await uniqueKeys(db);
    ok(col.n === 0 && keys.length === 1 && keys[0].conname === "style_wall_heights_client_id_style_id_delta_in_key",
      "and nothing of the apply is left: no style_ids column, the old wall-height key back", JSON.stringify({ col, keys }));
    await db.close();
  }
  {
    // 186 never applied: no doorStyle merge in the live body.
    const no186 = GET_FIXTURES_208.replace(/    \|\| case when fi\.category = 'door' and coalesce\(fi\.door_style, 'auto'\) <> 'auto'\n[^\n]*\n[^\n]*\n/, "");
    const db = await fresh(no186);
    ok(no186 !== GET_FIXTURES_208, "the stub really lost doorStyle");
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /272: the LIVE get_fixtures has no doorStyle merge \(186\)/.test(err.message), "a body without 186's doorStyle stops the apply, naming it", err && err.message);
    await db.close();
  }
  {
    // A copy whose merge lost the tenant test: the body pin catches it...
    const leaky = MIG().replace("where st.client_id = fi.client_id and st.id = any(fi.style_ids)", "where st.id = any(fi.style_ids)");
    ok(leaky !== MIG(), "the mutant really lost the tenant test");
    let db = await fresh();
    let err = null;
    try { await db.exec(leaky); } catch (e) { err = e; }
    ok(!!err && /272: get_fixtures is not the body PART 3 writes/.test(err.message), "a body that is not the pinned one stops the apply", err && err.message);
    await db.close();
    // ...and with the pin gone too, the probe catches the other tenant's style in the list.
    db = await fresh();
    err = null;
    const leakyNoPin = dropPostMd5(leaky);
    ok(leakyNoPin !== leaky, "the mutant really lost its body pin");
    try { await db.exec(leakyNoPin); } catch (e) { err = e; }
    ok(!!err && /272: a fixture offered on style cottage \(plus a style that is not this tenant's\) should carry styleKeys \["cottage"\], carries \["cottage", "lofted"\]/.test(err.message),
      "the probe alone catches another tenant's style leaking into styleKeys", err && err.message);
    await db.close();
  }
  {
    // A copy that sends styleKeys on EVERY row (the NULL test lost), pin gone: every tenant's
    // catalog changes, which the before/after comparison refuses.
    const loud = dropPostMd5(MIG().replace("    || case when fi.style_ids is not null\n              then jsonb_build_object('styleKeys'",
      "    || case when true\n              then jsonb_build_object('styleKeys'"));
    ok(loud !== dropPostMd5(MIG()), "the mutant really sends styleKeys on every row");
    const db = await fresh();
    let err = null;
    try { await db.exec(loud); } catch (e) { err = e; }
    ok(!!err && /272: get_fixtures changed for 2 tenant\(s\)/.test(err.message), "a body that changes today's catalogs stops the apply", err && err.message);
    await db.close();
  }
  {
    // The pre-apply md5 check alone: a drifted body that still has both markers gets past them,
    // and only the md5 stops it. With that check removed, the apply would revert the drift.
    const drifted = GET_FIXTURES_208.replace("    order by fi.category, fi.sort_order, fi.name)", "    order by fi.category, fi.name, fi.sort_order)");
    const db = await fresh(drifted);
    let err = null;
    try { await db.exec(dropPreMd5(MIG())); } catch (e) { err = e; }
    ok(dropPreMd5(MIG()) !== MIG() && !err, "without its md5 check the drifted body is silently replaced (so the md5 check is what refuses it)", err && err.message);
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  // exitCode, not process.exit(): with a dozen PGlite instances opened and closed, an exit() on
  // Windows lands while libuv is still closing one of their handles, and Node aborts with
  // "UV_HANDLE_CLOSING" and exit 127 AFTER every check passed. Every db above is closed, so the
  // process ends by itself once those handles finish.
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
