// Execute migration 313 (Interior walls, slice 1) for real in PGlite (Postgres compiled to WASM, in
// memory) on top of the tables it touches or reads, cut to their live columns, with get_fixtures
// created from 289's own statement saved with CRLF line endings (the live body has them) and
// get_config cut to the two blocks 313 splices (electricalItems and the start of colors, as
// pg_get_functiondef printed them live on 2026-10-17). Then check what the file promises:
//   * interior_wall_settings and interior_wall_coverings exist, RLS on, owner read only, no anon grant;
//   * fixture_items.in_partition and electrical_items.interior_wall_ok default TRUE;
//   * NO SEED (Carolyn, 2026-10-17): no tenant gets a settings row, not even one that priced the
//     278 row, so every get_config carries interiorWalls: null (walls not offered) until the builder
//     saves the tab; the 278 rows are left where they are;
//   * every tenant's get_config gains exactly one key, interiorWalls (null without a row), and
//     get_fixtures does not move at all;
//   * the sparse flags: inPartition: false for an unticked door or window only, interiorWallOk: false
//     for an unticked electrical item only; coverings emitted active and rated, prices nulled for a
//     tenant that hides them while `offered` / `charged` survive;
//   * the table checks (bad stud, 'each' or any method but lineal_ft / sqft_option for the wall, a
//     rafters standard with rafters not offered);
//   * a re-apply changes nothing and never overwrites a builder's saved tab;
//   * the header's ROLLBACK really takes the splices back out;
//   * the anchors really abort the whole apply when the live body has drifted (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration313.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/313_interior_walls.sql"), "utf8").replace(/\r/g, "");

// get_fixtures as it is live: 289's own create statement (the live prosrc md5 on 2026-10-17 was
// 289's c23b2e457c56312b84866937ad982fac once \r is removed), stored WITH CRLF, as live.
const GET_FIXTURES_289 = (() => {
  const t = fs.readFileSync(path.join(WT, "supabase/migrations/289_door_generator.sql"), "utf8").replace(/\r/g, "");
  const i = t.indexOf("create or replace function public.get_fixtures(p_client_id text)");
  const j = t.indexOf("\n$$\n;", i);
  if (i < 0 || j < 0) throw new Error("289's get_fixtures statement moved; re-point GET_FIXTURES_289");
  return t.slice(i, j + "\n$$\n;".length).replace(/\n/g, "\r\n");
})();

// get_config's electricalItems block, verbatim from the live body (181, then 206's columns), and the
// opening of its colors block (181's anchor), cut short after it.
const ELECTRICAL_ITEMS_BLOCK = `
    'electricalItems', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ei.id, 'name', ei.name, 'icon', ei.icon, 'mount', ei.mount,
               'heightOffFloorIn', ei.height_off_floor_in,
               'withPackage', ei.price_with_package is not null,
               'standalone', ei.price_standalone is not null,
               'priceWithPackage', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
                                        then ei.price_with_package else null end,
               'priceStandalone', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
                                       then ei.price_standalone else null end)
             || case when ei.internal_only then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
             order by ei.sort_order, ei.name)
      from public.electrical_items ei
      where ei.client_id = cc.client_id and ei.active
        and (ei.price_with_package is not null or ei.price_standalone is not null)), '[]'::jsonb),`;
const COLORS_BLOCK = `
    'colors', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label) order by c.label)
      from public.colors c
      where c.client_id = cc.client_id and c.active), '[]'::jsonb),
    'showPricing', coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)`;

const STUBS = ({ elec = ELECTRICAL_ITEMS_BLOCK, colors = COLORS_BLOCK, fixtures = GET_FIXTURES_289 } = {}) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create function public.current_client_id() returns text language sql stable as $f$ select 'acme-sheds'::text $f$;
create table public.client_configs (client_id text primary key);
create table public.client_settings (
  client_id text primary key, show_pricing boolean,
  ramp_mode text, ramp_price numeric, ramp_price_method text, ramp_image_url text, ramp_show_image boolean, ramp_enabled boolean
);
create table public.building_styles (
  id uuid primary key default gen_random_uuid(), client_id text not null, key text not null, label text not null,
  sort_order integer not null default 0, active boolean not null default true
);
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
  plan_label text,
  show_image_on_estimate boolean not null default true,
  archived boolean not null default false,
  internal_only boolean not null default false,
  color_mode text not null default 'fixed',
  has_trim_color boolean not null default false,
  fixed_color_id uuid,
  window_color_ids uuid[],
  sill_in numeric,
  sill_mode text not null default 'fixed',
  taxable boolean not null default true,
  door_style text not null default 'auto',
  style_ids uuid[],
  in_door boolean not null default false
);
create table public.electrical_items (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  name text not null,
  icon text not null default '⚡',
  mount text not null default 'wall',
  height_off_floor_in numeric,
  price_with_package numeric,
  price_standalone numeric,
  taxable boolean not null default true,
  active boolean not null default true,
  internal_only boolean not null default false,
  sort_order integer not null default 0,
  unique (client_id, name)
);
create table public.client_layout_items (
  client_id text not null, item_key text not null, active boolean not null default true,
  archived boolean not null default false, internal_only boolean not null default false,
  taxable boolean not null default true, unique (client_id, item_key)
);
create table public.layout_item_pricing (
  id uuid primary key default gen_random_uuid(), client_id text not null, item_key text not null,
  style_id uuid, pricing_method text not null default 'each', rate numeric not null default 0, image_url text
);
${fixtures}
create function public.get_config(p_client_id text) returns jsonb language sql stable security definer set search_path = '' as $function$
  select case when cc.client_id is null then null else jsonb_build_object(
    'clientId', cc.client_id,${elec}${colors}
  ) end
  from public.client_configs cc where cc.client_id = p_client_id;
$function$;
`;

const DOOR = "00000000-0000-4000-8000-0000000000d1";
const WIN = "00000000-0000-4000-8000-0000000000a1";
const VENT = "00000000-0000-4000-8000-0000000000e1";
const FAN = "00000000-0000-4000-8000-0000000000f1";
const OUTLET = "00000000-0000-4000-8000-0000000000f2";
const SEED = `
insert into public.client_configs (client_id) values ('acme-sheds'), ('bravo-barns'), ('cedar-co'), ('delta-builds');
insert into public.client_settings (client_id, show_pricing) values ('acme-sheds', true), ('bravo-barns', true), ('cedar-co', false), ('delta-builds', true);
insert into public.colors (client_id, label) values ('acme-sheds', 'Red'), ('bravo-barns', 'Blue');
-- acme-sheds priced the 278 wall at $35/ft and made it non-taxable; cedar-co (hides prices) priced it
-- each at $400; bravo-barns never priced it; delta-builds priced it only for one style.
insert into public.client_layout_items (client_id, item_key, taxable, internal_only) values
  ('acme-sheds', 'partitionWall', false, false), ('bravo-barns', 'partitionWall', true, false),
  ('cedar-co', 'partitionWall', true, true), ('delta-builds', 'partitionWall', true, false);
insert into public.layout_item_pricing (client_id, item_key, style_id, pricing_method, rate) values
  ('acme-sheds', 'partitionWall', null, 'lineal_ft', 35),
  ('acme-sheds', 'shelf', null, 'lineal_ft', 18),
  ('cedar-co', 'partitionWall', null, 'each', 400),
  ('delta-builds', 'partitionWall', '00000000-0000-4000-8000-000000000001', 'lineal_ft', 30);
insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, sort_order) values
  ('${DOOR}', 'acme-sheds', 'door', 'Walk door', 36, 80, 300, 0),
  ('${WIN}',  'acme-sheds', 'window', 'Window', 24, 36, 120, 0),
  ('${VENT}', 'acme-sheds', 'vent', 'Gable vent', 12, 12, 40, 0);
insert into public.electrical_items (id, client_id, name, price_with_package, price_standalone, sort_order) values
  ('${FAN}', 'acme-sheds', 'Ceiling fan', 150, 250, 0),
  ('${OUTLET}', 'acme-sheds', 'Outlet', 25, 60, 1);
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const same = (a, b) => { try { require("assert").deepStrictEqual(a, b); return true; } catch (_) { return false; } };
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;
const opened = [];
async function fresh(opts) {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS(opts));
  await db.exec(SEED);
  return db;
}
async function apply(db, sql = MIG()) {
  try {
    const out = await db.exec(sql);
    const record = [...out].reverse().map((r) => r.rows && r.rows[0]).find((r) => r && "tables_ready" in r);
    return { err: null, record };
  } catch (e) { await db.exec("rollback").catch(() => {}); return { err: e.message }; }
}
const cfgOf = async (db, c) => (await one(db, "select public.get_config($1) j", [c])).j;
const fixOf = async (db, c) => (await one(db, "select public.get_fixtures($1) j", [c])).j;
const without = (cfg) => { const c = { ...cfg }; delete c.interiorWalls; return JSON.stringify(c); };
const defOf = async (db, fn) => (await one(db, `select pg_get_functiondef('public.${fn}(text)'::regprocedure) d`)).d;
const TENANTS = ["acme-sheds", "bravo-barns", "cedar-co", "delta-builds"];
// Rollback, as the header writes it, with the comment markers taken off.
const ROLLBACK = () => {
  const t = MIG();
  const i = t.indexOf("--   begin;\n--   do $rb$");
  const j = t.indexOf("--   commit;", i);
  if (i < 0 || j < 0) throw new Error("the ROLLBACK block in 313's header moved; re-point the test");
  return t.slice(i, j + "--   commit;".length).split("\n").map((l) => l.replace(/^--   ?/, "")).join("\n")
    // There is no ledger in PGlite.
    .replace("delete from supabase_migrations.schema_migrations where version = '313';", "");
};

(async () => {
  console.log("migration 313: applies on the live shape");
  {
    const db = await fresh();
    const before = {};
    for (const c of TENANTS) before[c] = { cfg: JSON.stringify(await cfgOf(db, c)), fix: JSON.stringify(await fixOf(db, c)) };
    const { err, record } = await apply(db);
    ok(err === null, "313 applied cleanly, assertions included", err);
    ok(record && record.tables_ready === true && Number(record.tenants) === 4 && Number(record.settings_rows) === 0
      && Number(record.walls_offered) === 0 && Number(record.fixtures_not_in_walls) === 0 && Number(record.electrical_not_on_walls) === 0,
      "THE RECORD reads true, 4, 0, 0, 0, 0", JSON.stringify(record));

    console.log("tables, RLS and grants");
    const rls = await rows(db, "select relname, relrowsecurity from pg_class where relname in ('interior_wall_settings','interior_wall_coverings') order by relname");
    ok(rls.length === 2 && rls.every((r) => r.relrowsecurity === true), "RLS is on for both tables", JSON.stringify(rls));
    const pol = await rows(db, "select tablename, cmd, roles::text from pg_policies where tablename like 'interior_wall%' order by tablename");
    ok(pol.length === 2 && pol.every((p) => p.cmd === "SELECT" && /authenticated/.test(p.roles)), "one owner read policy each, nothing else", JSON.stringify(pol));
    const anon = await one(db, "select has_table_privilege('anon','public.interior_wall_settings','select') a, has_table_privilege('anon','public.interior_wall_coverings','select') b");
    ok(anon.a === false && anon.b === false, "anon holds no privilege on either table", JSON.stringify(anon));
    const cols = await rows(db, "select table_name, column_default, is_nullable from information_schema.columns where (table_name, column_name) in (('fixture_items','in_partition'),('electrical_items','interior_wall_ok')) order by table_name");
    ok(cols.length === 2 && cols.every((c) => c.column_default === "true" && c.is_nullable === "NO"), "in_partition and interior_wall_ok: not null default true", JSON.stringify(cols));

    console.log("no seed");
    ok((await one(db, "select count(*)::int n from public.interior_wall_settings")).n === 0,
      "no tenant gets a settings row, not even the two that priced the 278 row");
    ok((await one(db, "select count(*)::int n from public.layout_item_pricing where item_key = 'partitionWall'")).n === 3, "the 278 rows stay where they are");

    console.log("get_config and get_fixtures");
    for (const c of TENANTS) {
      const cfg = await cfgOf(db, c);
      ok(without(cfg) === before[c].cfg, `${c}: nothing in get_config moved but the new key`);
      ok("interiorWalls" in cfg && cfg.interiorWalls === null, `${c}: interiorWalls is null (not set up, so not offered)`);
      ok(JSON.stringify(await fixOf(db, c)) === before[c].fix, `${c}: get_fixtures is byte-for-byte unchanged`);
    }
    // The builders now save their tabs (what portal-settings save_interior_walls writes).
    await db.exec(`insert into public.interior_wall_settings (client_id, standard_stud, pricing_method, rate_2x4, taxable, internal_only) values
      ('acme-sheds', '2x4', 'lineal_ft', 35, false, false),
      ('cedar-co', '2x4', 'sqft_option', 4, true, true)`);
    const acme = (await cfgOf(db, "acme-sheds")).interiorWalls;
    ok(same(acme, { studs: { "2x4": { rate: 35 } }, method: "lineal_ft", allowRo: true, offered: true, coverings: [], allowRafters: true, standardStud: "2x4", standardHeight: "plate", taxable: false }),
      "acme-sheds: offered, 2x4 at $35/ft, plate height, rafters allowed, not taxable", JSON.stringify(acme));
    const cedar = (await cfgOf(db, "cedar-co")).interiorWalls;
    ok(cedar.offered === true && cedar.method === "sqft_option" && JSON.stringify(cedar.studs) === JSON.stringify({ "2x4": { rate: null } }) && cedar.internalOnly === true,
      "cedar-co hides prices: still offered, per sq ft, the 2x4 key is there, its rate is null; internal only", JSON.stringify(cedar));
    ok((await cfgOf(db, "bravo-barns")).interiorWalls === null && "interiorWalls" in (await cfgOf(db, "bravo-barns")), "bravo-barns (no row): interiorWalls is null");

    console.log("the sparse flags and the coverings");
    await db.exec(`update public.fixture_items set in_partition = false where id in ('${DOOR}', '${VENT}')`);
    await db.exec(`update public.electrical_items set interior_wall_ok = false where id = '${FAN}'`);
    const items = (await fixOf(db, "acme-sheds")).items;
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    ok(byId[DOOR].inPartition === false, "an unticked door carries inPartition: false");
    ok(!("inPartition" in byId[WIN]), "a ticked window carries nothing new");
    ok(!("inPartition" in byId[VENT]), "a vent never carries it, whatever its column says");
    const elec = Object.fromEntries((await cfgOf(db, "acme-sheds")).electricalItems.map((e) => [e.id, e]));
    ok(elec[FAN].interiorWallOk === false && !("interiorWallOk" in elec[OUTLET]), "interiorWallOk: false on the unticked item only", JSON.stringify(elec));
    await db.exec(`insert into public.interior_wall_coverings (client_id, name, pricing_method, rate, taxable, internal_only, active, sort_order) values
      ('acme-sheds', 'Drywall', 'sqft_option', 2.5, true, false, true, 1),
      ('acme-sheds', 'OSB', 'sqft_option', 0, false, false, true, 0),
      ('acme-sheds', 'Shiplap', 'lineal_ft', null, true, false, true, 2),
      ('acme-sheds', 'Pegboard', 'each', 90, true, true, false, 3),
      ('acme-sheds', 'Metal liner', 'each', 120, true, true, true, 4),
      ('cedar-co', 'Drywall', 'sqft_option', 3, true, false, true, 0)`);
    const cov = (await cfgOf(db, "acme-sheds")).interiorWalls.coverings.map(({ id, ...r }) => r);
    ok(same(cov, [
      { name: "OSB", rate: 0, method: "sqft_option", charged: false, taxable: false },
      { name: "Drywall", rate: 2.5, method: "sqft_option", charged: true },
      { name: "Metal liner", rate: 120, method: "each", charged: true, internalOnly: true },
    ]), "coverings: active and rated only, in order; 0 is included (charged false); taxable/internalOnly sparse", JSON.stringify(cov));
    const cedarCov = (await cfgOf(db, "cedar-co")).interiorWalls.coverings;
    ok(cedarCov.length === 1 && cedarCov[0].rate === null && cedarCov[0].charged === true, "a hide-prices tenant gets the covering, rate null, charged true", JSON.stringify(cedarCov));

    console.log("the table checks");
    const refused = async (sql) => { try { await db.exec(sql); return false; } catch (_) { return true; } };
    ok(await refused("insert into public.interior_wall_settings (client_id, standard_stud) values ('bravo-barns', '2x8')"), "a 2x8 standard is refused");
    ok(await refused("insert into public.interior_wall_settings (client_id, pricing_method) values ('bravo-barns', 'sqft_building')"), "a method a wall does not understand is refused");
    ok(await refused("insert into public.interior_wall_settings (client_id, pricing_method, rate_2x4) values ('bravo-barns', 'each', 400)"), "'each' is refused for the wall (per lineal ft or per sq ft only)");
    ok(String((await one(db, "select column_default d from information_schema.columns where table_name = 'interior_wall_settings' and column_name = 'pricing_method'")).d).startsWith("'lineal_ft'"), "the wall's method defaults to lineal_ft");
    ok(!(await refused("insert into public.interior_wall_coverings (client_id, name, pricing_method, rate) values ('cedar-co', 'Pegboard', 'each', 90)")), "a covering may still be priced each");
    await db.exec("delete from public.interior_wall_coverings where client_id = 'cedar-co' and name = 'Pegboard'");
    ok(await refused("insert into public.interior_wall_settings (client_id, standard_height, allow_rafters) values ('bravo-barns', 'rafters', false)"), "a 'rafters' standard with rafters not offered is refused");
    ok(await refused("insert into public.interior_wall_settings (client_id, rate_2x6) values ('bravo-barns', -1)"), "a negative rate is refused");
    ok(await refused("insert into public.interior_wall_coverings (client_id, name) values ('acme-sheds', 'Drywall')"), "a duplicate covering name is refused");
    ok(await refused("insert into public.interior_wall_coverings (client_id, name) values ('acme-sheds', '   ')"), "a blank covering name is refused");
    ok(!(await refused("insert into public.interior_wall_settings (client_id, standard_stud, rate_2x6, standard_height) values ('bravo-barns', '2x6', 40, 'rafters')")), "a 2x6 / rafters standard is stored");
    const bravo = (await cfgOf(db, "bravo-barns")).interiorWalls;
    ok(bravo.offered === true && JSON.stringify(bravo.studs) === JSON.stringify({ "2x6": { rate: 40 } }) && bravo.standardHeight === "rafters", "...and get_config says so", JSON.stringify(bravo));
    await db.exec("update public.interior_wall_settings set standard_stud = '2x6' where client_id = 'acme-sheds'");
    ok((await cfgOf(db, "acme-sheds")).interiorWalls.offered === false, "a standard stud with no rate is not offered");
    await db.exec("update public.interior_wall_settings set standard_stud = '2x4', rate_2x4 = 50 where client_id = 'acme-sheds'");

    console.log("re-apply and rollback");
    const defs = { cfg: await defOf(db, "get_config"), fix: await defOf(db, "get_fixtures") };
    const re = await apply(db);
    ok(re.err === null, "a second apply goes through, its checks included", re.err);
    ok(await defOf(db, "get_config") === defs.cfg && await defOf(db, "get_fixtures") === defs.fix, "...and splices nothing twice");
    ok(Number((await one(db, "select rate_2x4 from public.interior_wall_settings where client_id = 'acme-sheds'")).rate_2x4) === 50, "...and never overwrites a builder's saved rate");

    try { await db.exec(ROLLBACK()); ok(true, "the header's ROLLBACK runs"); }
    catch (e) { ok(false, "the header's ROLLBACK runs", e.message); }
    ok(!(await defOf(db, "get_config")).includes("interiorWalls") && !(await defOf(db, "get_config")).includes("interiorWallOk")
      && !(await defOf(db, "get_fixtures")).includes("inPartition"), "...and takes every splice back out");
    for (const c of TENANTS) ok(without(await cfgOf(db, c)) === before[c].cfg && !("interiorWalls" in (await cfgOf(db, c))), `${c}: get_config is back to what it was`);
    ok((await one(db, "select to_regclass('public.interior_wall_settings') r")).r === null, "...and the tables are gone");
    const again = await apply(db);
    ok(again.err === null, "313 applies again after a rollback", again.err);
  }

  console.log("migration 313: a drifted body aborts the whole apply (mutants)");
  {
    const colors = COLORS_BLOCK.replace("    'colors', coalesce((", "    'colors', (select coalesce((").replace("'[]'::jsonb),\n    'showPricing'", "'[]'::jsonb)),\n    'showPricing'");
    ok(colors !== COLORS_BLOCK, "(the mutant formed: get_config without 181's colors anchor)");
    const db = await fresh({ colors });
    const { err } = await apply(db);
    ok(err && /the colors anchor \(181\) was not found/.test(err), "a get_config without the colors anchor aborts", err);
    ok((await one(db, "select to_regclass('public.interior_wall_settings') r")).r === null, "...and nothing of the migration survives it (one transaction)");
  }
  {
    const elec = ELECTRICAL_ITEMS_BLOCK.replace("|| case when ei.internal_only then jsonb_build_object('internalOnly', true) else '{}'::jsonb end", "|| case when coalesce(ei.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end");
    ok(elec !== ELECTRICAL_ITEMS_BLOCK, "(the mutant formed: electricalItems' internalOnly merge rewritten)");
    const db = await fresh({ elec });
    const { err } = await apply(db);
    ok(err && /electricalItems internalOnly merge \(181\) was not found/.test(err), "a rewritten electricalItems merge aborts", err);
  }
  {
    const fixtures = GET_FIXTURES_289.replace("|| case when fi.category = 'window' and coalesce(fi.in_door, false)", "|| case when coalesce(fi.in_door, false) and fi.category = 'window'");
    ok(fixtures !== GET_FIXTURES_289, "(the mutant formed: get_fixtures' inDoor merge rewritten)");
    const db = await fresh({ fixtures });
    const { err } = await apply(db);
    ok(err && /the inDoor merge \(289\) was not found/.test(err), "a rewritten get_fixtures aborts", err);
    ok((await one(db, "select count(*)::int n from information_schema.columns where table_name = 'fixture_items' and column_name = 'in_partition'")).n === 0, "...and the new column does not survive it");
  }
  {
    // A copy that slips a seed back in: check 3 must notice.
    const anchor = "-- PART 4 — no seed (each builder sets up the Interior walls tab; see the header)\n-- ═════════════════════════════════════════════════════════════════════════════════════════\n";
    const sql = MIG().replace(anchor, anchor + "insert into public.interior_wall_settings (client_id, rate_2x4) select client_id, 35 from public.layout_item_pricing where item_key = 'partitionWall' and style_id is null;\n");
    ok(sql !== MIG(), "(the mutant formed: a seed slipped back in)");
    const db = await fresh();
    const { err } = await apply(db, sql);
    ok(err && /appeared during a first apply; this migration seeds nothing/.test(err), "a seed aborts the apply", err);
    ok((await one(db, "select to_regclass('public.interior_wall_settings') r")).r === null, "...and nothing of the migration survives it");
  }
  {
    // A copy whose interiorWalls block leaks into another key: "nothing else moved" must notice.
    const sql = MIG().replace("    'colors', coalesce(($repl2$;", "    'leak', true,\n    'colors', coalesce(($repl2$;");
    ok(sql !== MIG(), "(the mutant formed: a second key spliced)");
    const db = await fresh();
    const { err } = await apply(db, sql);
    ok(err && /changed for \d+ tenant/.test(err), "a splice that moves anything else aborts the apply", err);
  }

  for (const db of opened) await db.close().catch(() => {});
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
