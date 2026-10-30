// Execute migration 350 (pricing_cells_apply, the sizes table's save) for real in PGlite (Postgres
// compiled to WASM, in memory) on a cut-down schema with the shapes the live function meets:
//   * building_sizes built the way live got it: created as building_sizes_new (011) and renamed, so
//     its primary key and its (style_id, label) key kept that prefix, then the dimensions key (027).
//     Live order: pkey, label, dims. The function must never read a violated constraint's name;
//   * the set_updated_at and enforce_size_pricing triggers (no price → not offered, 029);
//   * building_size_inclusions keyed (size_id, item_key) with NO id column (022);
//   * client_layout_items and fixture_items with active/archived (075), client_settings.rtp_enabled
//     and rtp_bom_lines (152).
// Then check what the file promises (its header, rules 0-3):
//   * the RECORD and the grants: no browser role can execute it, service_role can;
//   * saves: price and boxes land together; a boxes-only edit moves the version; a blank price hides
//     the size, a first price offers it, a changed price leaves Offered alone; 0 deletes only a row on
//     file; Offered without a price is refused per box; a negative price is refused per box;
//   * the guard: a stale version gives conflict and writes nothing, boxes included; the same call
//     twice gives duplicate; A→B→A gives conflict and the price stays 400; a matching version with a
//     stale starting value gives conflict;
//   * option keys: ramp, partitionWall, an archived or switched-off item, an archived or switched-off
//     door and another builder's door each come back in cellErrors, and the rest saves;
//   * Real-Time Pricing on: the price is refused and the boxes save;
//   * creates: at the end of the style in typed order; the same id twice is duplicate; existing
//     dimensions are exists, though the label index is checked first live; a label taken with other
//     dimensions, another builder's style and a used id are refused; a create that loses a race it
//     cannot see again is refused with the database's sentence;
//   * removes: only a size never priced or edited, with no boxes and no BOM lines, and only this
//     builder's; an id nobody holds is already gone;
//   * per-size isolation: one size forced to fail is refused, its boxes untouched, the others save;
//   * tenant safety, the 50-entry and 2,500-box caps, and a 50-entry call that runs;
//   * mutants: without the version check A→B→A writes the orphan; without the starting-value check a
//     stale edit lands on a refreshed version.
// Not testable here: PGlite has one connection, so two sessions waiting on the row lock cannot be
// run. That rests on Postgres semantics.
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants, styles and doors are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration350.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/350_pricing_cells_apply.sql"), "utf8").replace(/\r/g, "");

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
  size_id uuid not null references public.building_sizes (id) on delete cascade, qty numeric not null default 0);
`;

const T = "acme-sheds";   // the builder under test
const U = "bravo-barns";  // somebody else
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ST_BARN = uid(1), ST_SHED = uid(2), ST_CABIN = uid(3), ST_OTHER = uid(4);
const FX_DOOR = uid(11), FX_OLD = uid(12), FX_OFF = uid(13), FX_THEIRS = uid(14);
const SZ_A = uid(21), SZ_B = uid(22), SZ_C = uid(23), SZ_HAND = uid(24), SZ_D = uid(25), SZ_THEIRS = uid(29);
const SZ_NEW = uid(31), SZ_EDITED = uid(32), SZ_INC = uid(33), SZ_BOM = uid(34), SZ_THEIRS_NEW = uid(35);

const SEED = `
insert into public.building_styles (id, client_id, key, label, code, sort_order) values
  ('${ST_BARN}', '${T}', 'test-barn', 'Test Barn', 'TB', 0),
  ('${ST_SHED}', '${T}', 'test-shed', 'Test Shed', 'TS', 1),
  ('${ST_CABIN}', '${T}', 'test-cabin', 'Test Cabin', 'TC', 2),
  ('${ST_OTHER}', '${U}', 'other-barn', 'Other Barn', 'OB', 0);
insert into public.client_layout_items (client_id, item_key, active, archived) values
  ('${T}', 'loft', true, false), ('${T}', 'workbench', true, false), ('${T}', 'ramp', true, false),
  ('${T}', 'partitionWall', true, false), ('${T}', 'shelf', true, true), ('${T}', 'vent', false, false),
  ('${U}', 'loft', true, false);
insert into public.fixture_items (id, client_id, name, active, archived) values
  ('${FX_DOOR}', '${T}', 'Single Door', true, false), ('${FX_OLD}', '${T}', 'Old Door', true, true),
  ('${FX_OFF}', '${T}', 'Off Door', false, false), ('${FX_THEIRS}', '${U}', 'Their Door', true, false);
insert into public.client_settings (client_id, rtp_enabled) values ('${T}', false);
insert into public.building_sizes (id, client_id, style_id, label, width_ft, length_ft, base_price, active, sort_order) values
  ('${SZ_A}', '${T}', '${ST_BARN}', '10x12', 10, 12, 400, true, 0),
  ('${SZ_B}', '${T}', '${ST_BARN}', '10x16', 10, 16, 500, true, 1),
  ('${SZ_C}', '${T}', '${ST_BARN}', '12x24', 12, 24, null, false, 2),
  ('${SZ_HAND}', '${T}', '${ST_BARN}', '16x20', 16, 21, 900, true, 3),
  ('${SZ_D}', '${T}', '${ST_SHED}', '8x10', 8, 10, 300, false, 0),
  ('${SZ_THEIRS}', '${U}', '${ST_OTHER}', '10x12', 10, 12, 999, true, 0);
insert into public.building_size_inclusions (client_id, size_id, item_key, included, qty) values
  ('${T}', '${SZ_A}', 'loft', true, 50), ('${T}', '${SZ_A}', '${FX_DOOR}', true, 1),
  ('${T}', '${SZ_B}', 'workbench', true, 1), ('${T}', '${SZ_B}', 'loft', false, 3), ('${T}', '${SZ_B}', '${FX_OLD}', true, 2),
  ('${U}', '${SZ_THEIRS}', 'loft', true, 40);
`;
// Sizes a Remove can meet. All unpriced; created now, so updated_at = created_at until edited.
const SEED_REMOVES = `
insert into public.building_sizes (id, client_id, style_id, label, width_ft, length_ft, base_price, active, sort_order) values
  ('${SZ_NEW}', '${T}', '${ST_BARN}', '20x20', 20, 20, null, false, 10),
  ('${SZ_EDITED}', '${T}', '${ST_BARN}', '20x24', 20, 24, null, false, 11),
  ('${SZ_INC}', '${T}', '${ST_BARN}', '20x28', 20, 28, null, false, 12),
  ('${SZ_BOM}', '${T}', '${ST_BARN}', '20x32', 20, 32, null, false, 13),
  ('${SZ_THEIRS_NEW}', '${U}', '${ST_OTHER}', '20x20', 20, 20, null, false, 1);
insert into public.building_size_inclusions (client_id, size_id, item_key, included, qty) values ('${T}', '${SZ_INC}', 'loft', true, 10);
insert into public.rtp_bom_lines (client_id, size_id, qty) values ('${T}', '${SZ_BOM}', 4);
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
async function fresh(extra = "") {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  await db.exec(SEED + extra);
  return db;
}
async function apply(db, sql = MIG()) {
  try {
    const out = await db.exec(sql);
    const record = [...out].reverse().map((r) => r.rows && r.rows[0]).find((r) => r && "service_role_can_execute" in r);
    return { err: null, record };
  } catch (e) { await db.exec("rollback").catch(() => {}); return { err: e.message }; }
}
/** One save call, as portal-settings makes it. A pause first, so every call's now() (and so every
 *  version it writes) differs from the last call's, as separate requests' would. */
async function call(db, { creates = [], removes = [], sizes = [] } = {}, client = T) {
  await sleep(5);
  try {
    return (await one(db, "select public.pricing_cells_apply($1, $2::jsonb, $3::jsonb, $4::jsonb) r",
      [client, J(creates), J(removes), J(sizes)])).r;
  } catch (e) { return { err: e.message, code: e.code }; }
}
/** A size's version exactly as size_table and the function hand it out (timestamptz as JSON text). */
const version = async (db, id) => (await one(db, "select to_jsonb(updated_at) #>> '{}' v from public.building_sizes where id = $1", [id]))?.v ?? null;
const sizeOf = async (db, id) => one(db,
  "select base_price::float8 price, active, label, sort_order, width_ft::float8 w, length_ft::float8 l, client_id, (updated_at = created_at) untouched from public.building_sizes where id = $1", [id]);
/** Every inclusion row of one size: { key: qty } for included rows, { key: "off:qty" } otherwise. */
async function cellsOf(db, id) {
  const out = {};
  for (const r of (await db.query("select item_key, included, qty from public.building_size_inclusions where size_id = $1 order by item_key", [id])).rows) {
    out[r.item_key] = r.included ? r.qty : `off:${r.qty}`;
  }
  return out;
}
const entry = (id, base, from, to) => ({ id, base, from, to });

/** A→B→A: the stalled original lands after a newer save that put the old value back. */
async function abaCase(db) {
  const v0 = await version(db, SZ_A);
  const orig = [entry(SZ_A, v0, { price: 400 }, { price: 480 })];
  const side = await call(db, { sizes: orig });          // the side-door copy lands first
  const back = await call(db, { sizes: [entry(SZ_A, side.results[0].version, { price: 480 }, { price: 400 })] });
  const late = await call(db, { sizes: orig });          // the stalled original finally arrives
  return { side, back, late, price: (await sizeOf(db, SZ_A)).price };
}
/** A colleague's save, then an edit made against the old value on the refreshed version. */
async function staleRefreshCase(db) {
  const v0 = await version(db, SZ_B);
  const colleague = await call(db, { sizes: [entry(SZ_B, v0, { price: 500 }, { price: 450 })] });
  const stale = await call(db, { sizes: [entry(SZ_B, colleague.results[0].version, { price: 500 }, { price: 480 })] });
  return { colleague, stale, price: (await sizeOf(db, SZ_B)).price };
}

(async () => {
  const SIG = "public.pricing_cells_apply(text, jsonb, jsonb, jsonb)";

  console.log("migration 350: the schema it meets");
  {
    const db = await fresh();
    const names = (await db.query("select conname from pg_constraint where conrelid = 'public.building_sizes'::regclass and contype in ('p', 'u') order by oid")).rows.map((r) => r.conname);
    ok(J(names) === J(["building_sizes_new_pkey", "building_sizes_new_style_id_label_key", "building_sizes_client_style_dims_uniq"]),
      "building_sizes carries the live constraint names in live order", J(names));
  }

  console.log("migration 350: apply, the record and the grants");
  const db = await fresh();
  const { err, record } = await apply(db);
  ok(!err, "applies cleanly", err);
  ok(record && record.ready === true && record.anon_can_execute === false && record.authenticated_can_execute === false && record.service_role_can_execute === true,
    "THE RECORD: ready, no browser role, service_role", J(record));
  for (const role of ["anon", "authenticated"]) {
    ok((await one(db, `select has_function_privilege($1, '${SIG}', 'execute') x`, [role])).x === false, `${role} cannot execute it`);
  }
  ok((await one(db, `select has_function_privilege('service_role', '${SIG}', 'execute') x`)).x === true, "service_role can execute it");
  ok((await one(db, `select p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=%' x from pg_proc p where p.oid = '${SIG}'::regprocedure`)).x === true,
    "SECURITY DEFINER with a fixed search_path");
  {
    let denied = null;
    try { await db.exec(`set role anon; select public.pricing_cells_apply('${T}', '[]', '[]', '[]');`); } catch (e) { denied = e.message; }
    await db.exec("reset role");
    ok(denied && /permission denied/.test(denied), "called as anon, it is refused before it runs", denied);
    let asService = null;
    try {
      await db.exec("set role service_role");
      asService = (await db.query(`select public.pricing_cells_apply('${T}', '[]', '[]', '[]') r`)).rows[0]?.r;
    } catch (e) { asService = { err: e.message }; }
    await db.exec("reset role");
    ok(J(asService) === J({ created: [], removed: [], results: [] }), "called as service_role, an empty call answers three empty lists", J(asService));
  }

  console.log("migration 350: saves");
  {
    const v0 = await version(db, SZ_A);
    const r = await call(db, { sizes: [entry(SZ_A, v0, { price: 400, cells: { loft: 50, workbench: 0 } }, { price: 480, cells: { loft: 60, workbench: 1 } })] });
    const res = r.results && r.results[0];
    ok(res && res.status === "saved", "a price and two boxes save", J(r));
    const z = await sizeOf(db, SZ_A);
    ok(z.price === 480 && z.active === true, "the price landed and Offered stayed on", J(z));
    ok(C(await cellsOf(db, SZ_A)) === C({ [FX_DOOR]: 1, loft: 60, workbench: 1 }), "...and the boxes with it: loft changed, workbench added, the door untouched", J(await cellsOf(db, SZ_A)));
    ok(res && res.version === await version(db, SZ_A) && res.version !== v0, "the answer carries the new version", J(res));
    ok(res && res.row.price === 480 && res.row.active === true && res.row.label === "10x12" && res.row.width_ft === 10 && res.row.length_ft === 12
      && res.row.style_id === ST_BARN && res.row.sort_order === 0 && typeof res.row.created_at === "string", "...and the row", J(res && res.row));
    ok(res && C(res.cells) === C({ loft: 60, workbench: 1 }), "...and the boxes it was sent, as stored now", J(res && res.cells));
    ok(res && res.cellErrors === undefined && res.reason === undefined, "...with nothing refused");

    const vb = await version(db, SZ_B);
    const cellsOnly = await call(db, { sizes: [entry(SZ_B, vb, { cells: { workbench: 1 } }, { cells: { workbench: 2 } })] });
    ok(cellsOnly.results[0].status === "saved" && cellsOnly.results[0].version !== vb && await version(db, SZ_B) === cellsOnly.results[0].version,
      "a boxes-only edit still moves the version", J(cellsOnly));
    ok((await sizeOf(db, SZ_B)).price === 500, "...and leaves the price alone");

    const blank = await call(db, { sizes: [entry(SZ_B, cellsOnly.results[0].version, { price: 500 }, { price: null })] });
    const zb = await sizeOf(db, SZ_B);
    ok(blank.results[0].status === "saved" && zb.price === null && zb.active === false, "a blank price stores NULL and hides the size", J(zb));

    const first = await call(db, { sizes: [entry(SZ_C, await version(db, SZ_C), { price: null }, { price: 0 })] });
    const zc = await sizeOf(db, SZ_C);
    ok(first.results[0].status === "saved" && zc.price === 0 && zc.active === true, "a first price ($0 is a real price) offers the size", J(zc));

    await call(db, { sizes: [entry(SZ_D, await version(db, SZ_D), { price: 300 }, { price: 350 })] });
    const zd = await sizeOf(db, SZ_D);
    ok(zd.price === 350 && zd.active === false, "changing a hidden size's price leaves it hidden", J(zd));
    const vA = await version(db, SZ_A);
    await call(db, { sizes: [entry(SZ_A, vA, { price: 480 }, { price: 490 })] });
    ok((await sizeOf(db, SZ_A)).active === true, "...and an offered size's price leaves it offered");

    // 0 deletes a row on file (an included row, and the not-included row SZ_B keeps for loft), and
    // costs nothing where no row is on file.
    const before = (await one(db, "select count(*)::int n from public.building_size_inclusions")).n;
    const zero = await call(db, { sizes: [
      entry(SZ_A, await version(db, SZ_A), { cells: { [FX_DOOR]: 1 } }, { cells: { [FX_DOOR]: 0 } }),
      entry(SZ_B, await version(db, SZ_B), { cells: { loft: 0 } }, { cells: { loft: 0 } }),
      entry(SZ_C, await version(db, SZ_C), { cells: { loft: 0 } }, { cells: { loft: 0 } }),
    ] });
    ok(zero.results.every((x) => x.status === "saved"), "three zeros save", J(zero));
    ok(!(FX_DOOR in await cellsOf(db, SZ_A)) && !("loft" in await cellsOf(db, SZ_B)), "0 deletes the rows on file, included or not");
    ok((await one(db, "select count(*)::int n from public.building_size_inclusions")).n === before - 2, "...and writes nothing where none was on file");
    ok(C(zero.results[2].cells) === C({ loft: 0 }), "a box with nothing behind it reads 0");

    const vOff = await version(db, SZ_A);
    const off = await call(db, { sizes: [entry(SZ_A, vOff, { active: true }, { active: false })] });
    ok(off.results[0].status === "saved" && (await sizeOf(db, SZ_A)).active === false && (await sizeOf(db, SZ_A)).price === 490, "unticking Offered hides it and keeps the price");
    const on = await call(db, { sizes: [entry(SZ_A, off.results[0].version, { active: false }, { active: true })] });
    ok(on.results[0].status === "saved" && (await sizeOf(db, SZ_A)).active === true, "ticking it offers it again");
    const noPrice = await call(db, { sizes: [entry(SZ_B, await version(db, SZ_B), { active: false }, { active: true })] });
    ok(noPrice.results[0].status === "saved" && noPrice.results[0].cellErrors && /price first/.test(noPrice.results[0].cellErrors.active)
      && (await sizeOf(db, SZ_B)).active === false, "Offered on a size with no price is refused for that box", J(noPrice));

    const neg = await call(db, { sizes: [entry(SZ_D, await version(db, SZ_D), { price: 350, cells: { loft: 0 } }, { price: -5, cells: { loft: 10 } })] });
    ok(neg.results[0].status === "saved" && /0 or more/.test(neg.results[0].cellErrors?.price) && (await sizeOf(db, SZ_D)).price === 350
      && (await cellsOf(db, SZ_D)).loft === 10, "a negative price is refused for that box, and the box beside it saves", J(neg));

    const big = await call(db, { sizes: [entry(SZ_D, await version(db, SZ_D), { cells: { workbench: 0 } }, { cells: { workbench: 1000000 } })] });
    ok(/999,999/.test(big.results[0].cellErrors?.workbench) && !("workbench" in await cellsOf(db, SZ_D)), "a quantity past 999,999 is refused", J(big));
    await db.query(`update public.building_size_inclusions set qty = 1500000 where size_id = '${SZ_D}' and item_key = 'loft'`);
    const stored = await call(db, { sizes: [entry(SZ_D, await version(db, SZ_D), { price: 350, cells: { loft: 1500000 } }, { price: 360, cells: { loft: 1500000 } })] });
    ok(stored.results[0].status === "saved" && stored.results[0].cellErrors === undefined && (await sizeOf(db, SZ_D)).price === 360,
      "...unless it is what is already stored", J(stored));

    const hand = await call(db, { sizes: [entry(SZ_HAND, await version(db, SZ_HAND), { price: 900 }, { price: 950 })] });
    const zh = await sizeOf(db, SZ_HAND);
    ok(hand.results[0].status === "saved" && zh.label === "16x20" && zh.sort_order === 3,
      "a save never rewrites a size's label or its place in the list (the importer rewrites the label)", J(zh));

    const theirs = await call(db, { sizes: [entry(SZ_THEIRS, await version(db, SZ_THEIRS), { price: 999, cells: { loft: 40 } }, { price: 1, cells: { loft: 1 } })] });
    ok(theirs.results[0].status === "missing" && theirs.results[0].version === null && theirs.results[0].row === null,
      "another builder's size is missing, with nothing about it in the answer", J(theirs));
    ok((await sizeOf(db, SZ_THEIRS)).price === 999 && (await cellsOf(db, SZ_THEIRS)).loft === 40, "...and is untouched");
    const asThem = await call(db, { sizes: [entry(SZ_A, await version(db, SZ_A), { price: 490 }, { price: 1 })] }, U);
    ok(asThem.results[0].status === "missing" && (await sizeOf(db, SZ_A)).price === 490, "called as another builder, this builder's size is missing to it");
    const gone = await call(db, { sizes: [entry(uid(999), "2026-10-30T00:00:00+00:00", { price: 1 }, { price: 2 })] });
    ok(gone.results[0].status === "missing" && /isn't on this account/.test(gone.results[0].reason), "an id nobody holds is missing", J(gone));
  }

  console.log("migration 350: the guard");
  {
    const g = await fresh();
    await apply(g);
    const v0 = await version(g, SZ_A);
    const firstSave = await call(g, { sizes: [entry(SZ_A, v0, { price: 400 }, { price: 410 })] });
    const v1 = firstSave.results[0].version;
    const stale = await call(g, { sizes: [entry(SZ_A, v0, { price: 410, cells: { loft: 50 } }, { price: 420, cells: { loft: 70 } })] });
    const s = stale.results[0];
    ok(s.status === "conflict", "a stale version is a conflict", J(stale));
    ok((await sizeOf(g, SZ_A)).price === 410 && (await cellsOf(g, SZ_A)).loft === 50 && await version(g, SZ_A) === v1,
      "...and nothing is written, the boxes included, and the version does not move");
    ok(s.version === v1 && s.row.price === 410 && C(s.cells) === C({ loft: 50 }), "...and the answer carries what the server holds", J(s));

    const twice = [entry(SZ_A, v1, { price: 410, cells: { loft: 50 } }, { price: 430, cells: { loft: 55 } })];
    const once = await call(g, { sizes: twice });
    const again = await call(g, { sizes: twice });
    ok(once.results[0].status === "saved" && again.results[0].status === "duplicate", "the same call twice: saved, then duplicate", J(again));
    ok(again.results[0].version === once.results[0].version && await version(g, SZ_A) === once.results[0].version
      && (await sizeOf(g, SZ_A)).price === 430 && (await cellsOf(g, SZ_A)).loft === 55, "...and the duplicate writes nothing");

    // A duplicate needs every sent value to be there: one box someone else changed since makes it a conflict.
    await g.query(`update public.building_size_inclusions set qty = 56 where size_id = '${SZ_A}' and item_key = 'loft'`);
    const half = await call(g, { sizes: twice });
    ok(half.results[0].status === "conflict", "a resend whose box was changed since is a conflict, not a duplicate", J(half));

    const aba = await abaCase(await (async () => { const d = await fresh(); await apply(d); return d; })());
    ok(aba.side.results[0].status === "saved" && aba.back.results[0].status === "saved", "A→B→A: the side-door copy and the type-back both save", J([aba.side, aba.back]));
    ok(aba.late.results[0].status === "conflict" && aba.price === 400, "A→B→A: the stalled original is a conflict and the price stays 400", J(aba.late));

    const sr = await staleRefreshCase(await (async () => { const d = await fresh(); await apply(d); return d; })());
    ok(sr.stale.results[0].status === "conflict" && sr.price === 450, "a matching version with a stale starting value is a conflict", J(sr.stale));
    ok(sr.stale.results[0].version === sr.colleague.results[0].version && sr.stale.results[0].row.price === 450, "...answering the colleague's value");

    // Offered sent alone is judged on Offered alone (plus the version): a colleague's price change
    // does not make it a value conflict, only a version one the browser rebases.
    const vo = await version(g, SZ_B);
    const colleague = await call(g, { sizes: [entry(SZ_B, vo, { price: 500 }, { price: 520 })] });
    const toggle = await call(g, { sizes: [entry(SZ_B, colleague.results[0].version, { active: true }, { active: false })] });
    ok(toggle.results[0].status === "saved" && (await sizeOf(g, SZ_B)).price === 520 && (await sizeOf(g, SZ_B)).active === false,
      "Offered toggled on the colleague's version saves and keeps their price", J(toggle));
  }

  console.log("migration 350: option keys");
  {
    const o = await fresh();
    await apply(o);
    const keys = { loft: 5, [FX_DOOR]: 2, ramp: 1, partitionWall: 1, shelf: 1, vent: 1, [FX_OLD]: 1, [FX_OFF]: 1, [FX_THEIRS]: 1, nonsense: 1 };
    const from = Object.fromEntries(Object.keys(keys).map((k) => [k, k === "loft" ? 50 : k === FX_DOOR ? 1 : 0]));
    const r = await call(o, { sizes: [entry(SZ_A, await version(o, SZ_A), { cells: from }, { cells: keys })] });
    const res = r.results[0];
    const refused = Object.keys(res.cellErrors || {}).sort();
    ok(res.status === "saved", "the size saves", J(r));
    ok(J(refused) === J(["nonsense", "partitionWall", "ramp", "shelf", "vent", FX_OFF, FX_OLD, FX_THEIRS].sort()),
      "ramp, partitionWall, an archived and a switched-off item, an archived and a switched-off door, another builder's door and an unknown key are refused", J(refused));
    ok(C(await cellsOf(o, SZ_A)) === C({ [FX_DOOR]: 2, loft: 5 }), "...the two real columns save, and no row is written for a refused key", J(await cellsOf(o, SZ_A)));
    ok(C(res.cells) === C({ ...Object.fromEntries(Object.keys(keys).map((k) => [k, 0])), loft: 5, [FX_DOOR]: 2 }),
      "...and the answer reads every sent box back", J(res.cells));

    console.log("migration 350: Real-Time Pricing on");
    await o.query(`update public.client_settings set rtp_enabled = true where client_id = '${T}'`);
    const rtp = await call(o, { sizes: [entry(SZ_A, await version(o, SZ_A), { price: 400, cells: { loft: 5 } }, { price: 999, cells: { loft: 77 } })] });
    ok(rtp.results[0].status === "saved" && /Real-Time Pricing/.test(rtp.results[0].cellErrors?.price), "the price is refused for that box", J(rtp));
    ok((await sizeOf(o, SZ_A)).price === 400 && (await cellsOf(o, SZ_A)).loft === 77, "...the price stays and the boxes save");
    const noRow = await call(o, { sizes: [entry(SZ_THEIRS, await version(o, SZ_THEIRS), { price: 999 }, { price: 1000 })] }, U);
    ok(noRow.results[0].status === "saved" && (await sizeOf(o, SZ_THEIRS)).price === 1000, "a builder with no settings row reads as Real-Time Pricing off", J(noRow));
  }

  console.log("migration 350: creates");
  {
    const c = await fresh();
    await apply(c);
    const N1 = uid(101), N2 = uid(102), N3 = uid(103), N4 = uid(104);
    const r = await call(c, { creates: [
      { id: N1, styleId: ST_BARN, width: 14, length: 20, label: "14x20" },
      { id: N2, styleId: ST_BARN, width: 10.5, length: 12, label: "10.5x12" },
      { id: N3, styleId: ST_CABIN, width: 8, length: 8, label: "8x8" },
    ] });
    ok(r.created.map((x) => x.status).join() === "created,created,created", "three creates", J(r));
    const z1 = await sizeOf(c, N1), z2 = await sizeOf(c, N2), z3 = await sizeOf(c, N3);
    ok(z1.sort_order === 4 && z2.sort_order === 5, "new sizes go after the style's last one, in the order sent (max + 1)", J([z1, z2]));
    ok(z3.sort_order === 0, "...and an empty style's first size is 0");
    ok(z1.price === null && z1.active === false && z1.label === "14x20" && z2.label === "10.5x12" && z2.w === 10.5 && z1.untouched === true,
      "a new size is unpriced, not offered, labelled as sent, and never edited", J([z1, z2]));
    const c1 = r.created[0];
    ok(c1.version === await version(c, N1) && c1.row.sort_order === 4 && c1.row.price === null && c1.row.active === false && J(c1.cells) === "{}" && c1.existingId === undefined,
      "created carries the version, the row and its (empty) boxes", J(c1));

    const dup = await call(c, { creates: [{ id: N1, styleId: ST_BARN, width: 14, length: 20, label: "14x20" }] });
    ok(dup.created[0].status === "duplicate" && dup.created[0].version === c1.version && dup.created[0].row.label === "14x20",
      "the same create again is a duplicate, with its version", J(dup));
    ok((await one(c, `select count(*)::int n from public.building_sizes where style_id = '${ST_BARN}' and label = '14x20'`)).n === 1, "...and makes no second copy");

    // 10x12 exists as SZ_A. Live, the label index is checked before the dimensions index, so a
    // reading of the violated constraint would say "label taken"; the look-up by dimensions says exists.
    const ex = await call(c, { creates: [{ id: N4, styleId: ST_BARN, width: 10, length: 12, label: "10x12" }] });
    const e0 = ex.created[0];
    ok(e0.status === "exists" && e0.existingId === SZ_A && e0.version === await version(c, SZ_A) && e0.row.price === 400,
      "existing dimensions: exists, naming the size and carrying its version and row", J(e0));
    ok(C(e0.cells) === C({ [FX_DOOR]: 1, loft: 50 }), "...and its boxes", J(e0.cells));
    ok(!await sizeOf(c, N4), "...and nothing is inserted");

    const label = await call(c, { creates: [{ id: uid(105), styleId: ST_BARN, width: 16, length: 20, label: "16x20" }] });
    ok(label.created[0].status === "refused" && /A size called 16x20 already exists in this style with other measurements/.test(label.created[0].reason)
      && label.created[0].version === undefined, "a label taken with other dimensions is refused", J(label));
    const other = await call(c, { creates: [{ id: uid(106), styleId: ST_OTHER, width: 30, length: 30, label: "30x30" }] });
    ok(other.created[0].status === "refused" && /isn't on this account/.test(other.created[0].reason) && !await sizeOf(c, uid(106)),
      "another builder's style is refused", J(other));
    const used = await call(c, { creates: [{ id: SZ_THEIRS, styleId: ST_BARN, width: 30, length: 30, label: "30x30" }] });
    ok(used.created[0].status === "refused" && /already in use/.test(used.created[0].reason) && (await sizeOf(c, SZ_THEIRS)).client_id === U,
      "an id another row already has is refused, and that row is untouched", J(used));

    // The race backstop. A trigger plants a clashing row inside the insert, the way a concurrent
    // create would land between the look-up and the insert. Here the clash is rolled back with the
    // insert's subtransaction, so the look-again finds nothing: refused, with Postgres's sentence.
    await c.exec(`
      create function public.t_race() returns trigger language plpgsql as $t$
      begin
        if new.id = '${uid(107)}' and pg_trigger_depth() = 1 then
          insert into public.building_sizes (client_id, style_id, label, width_ft, length_ft) values (new.client_id, new.style_id, new.label, new.width_ft, new.length_ft);
        end if;
        return new;
      end $t$;
      create trigger t_race before insert on public.building_sizes for each row execute function public.t_race();`);
    const race = await call(c, { creates: [{ id: uid(107), styleId: ST_BARN, width: 40, length: 40, label: "40x40" }] });
    ok(race.created[0].status === "refused" && /duplicate key value violates unique constraint/.test(race.created[0].reason)
      && race.created[0].reason.length <= 200, "a create that hits a unique key it cannot see again is refused with the database's sentence", J(race));
    ok((await one(c, "select count(*)::int n from public.building_sizes where label = '40x40'")).n === 0, "...and leaves nothing behind");
    await c.exec("drop trigger t_race on public.building_sizes;");
  }

  console.log("migration 350: removes");
  {
    const m = await fresh(SEED_REMOVES);
    await apply(m);
    await sleep(5);
    await m.query(`update public.building_sizes set sort_order = sort_order where id = '${SZ_EDITED}'`);   // edited once, still unpriced
    const r = await call(m, { removes: [SZ_NEW, SZ_A, SZ_EDITED, SZ_INC, SZ_BOM, SZ_THEIRS_NEW, uid(998)] });
    const st = Object.fromEntries(r.removed.map((x) => [x.id, x]));
    ok(st[SZ_NEW].status === "removed" && !await sizeOf(m, SZ_NEW) && st[SZ_NEW].gone === undefined, "a size never priced or edited, with nothing in it, is removed", J(st[SZ_NEW]));
    for (const [id, what] of [[SZ_A, "a priced size"], [SZ_EDITED, "a once-edited size"], [SZ_INC, "a size with a box filled"], [SZ_BOM, "a size with BOM lines"], [SZ_THEIRS_NEW, "another builder's size"]]) {
      ok(st[id].status === "refused" && /Untick Offered/.test(st[id].reason) && !!await sizeOf(m, id), `${what} is refused and stays`, J(st[id]));
    }
    ok(st[uid(998)].status === "removed" && st[uid(998)].gone === true, "an id nobody holds is already gone", J(st[uid(998)]));
    const again = await call(m, { removes: [SZ_NEW] });
    ok(again.removed[0].status === "removed" && again.removed[0].gone === true, "a resent remove that landed answers removed (gone), not refused", J(again));
  }

  console.log("migration 350: one size failing does not take the others with it");
  {
    const p = await fresh();
    await apply(p);
    await p.exec(`
      create function public.t_boom() returns trigger language plpgsql as $t$
      begin
        if new.qty = 13 then raise exception 'test: thirteen is unlucky'; end if;
        return new;
      end $t$;
      create trigger t_boom before insert or update on public.building_size_inclusions for each row execute function public.t_boom();`);
    const before = await cellsOf(p, SZ_B);
    const r = await call(p, { sizes: [
      entry(SZ_A, await version(p, SZ_A), { price: 400 }, { price: 401 }),
      // loft (4 characters) is written before workbench (9), so loft is in and then rolled back.
      entry(SZ_B, await version(p, SZ_B), { price: 500, cells: { loft: 0, workbench: 1 } }, { price: 501, cells: { loft: 7, workbench: 13 } }),
      entry(SZ_C, await version(p, SZ_C), { price: null }, { price: 250 }),
    ] });
    ok(J(r.results.map((x) => x.status)) === J(["saved", "refused", "saved"]), "the failing size is refused, the others save", J(r));
    ok(/thirteen is unlucky/.test(r.results[1].reason) && r.results[1].row.price === 500 && r.results[1].version === await version(p, SZ_B),
      "...with the database's sentence and what the server holds", J(r.results[1]));
    ok((await sizeOf(p, SZ_B)).price === 500 && C(await cellsOf(p, SZ_B)) === C(before), "...its price and its boxes are untouched, the box written before the failure included", J(await cellsOf(p, SZ_B)));
    ok((await sizeOf(p, SZ_A)).price === 401 && (await sizeOf(p, SZ_C)).price === 250, "...and the sizes either side saved");
  }

  console.log("migration 350: a whole call resent after it landed");
  {
    const w = await fresh(SEED_REMOVES);
    await apply(w);
    const N = uid(201);
    const body = { creates: [{ id: N, styleId: ST_SHED, width: 9, length: 9, label: "9x9" }], removes: [SZ_NEW],
      sizes: [entry(SZ_A, await version(w, SZ_A), { price: 400, cells: { loft: 50 } }, { price: 444, cells: { loft: 44 } })] };
    const first = await call(w, body);
    const second = await call(w, body);
    ok(first.created[0].status === "created" && first.removed[0].status === "removed" && first.results[0].status === "saved", "the first copy lands", J(first));
    ok(second.created[0].status === "duplicate" && second.removed[0].status === "removed" && second.removed[0].gone === true && second.results[0].status === "duplicate",
      "the resend answers duplicate, gone and duplicate", J(second));
    ok(second.results[0].version === first.results[0].version && second.created[0].version === first.created[0].version, "...with the versions the first copy wrote");
    ok((await one(w, `select count(*)::int n from public.building_sizes where style_id = '${ST_SHED}'`)).n === 2, "...and no second size");
  }

  console.log("migration 350: caps and arguments");
  {
    const k = await fresh();
    await apply(k);
    const fifty = Array.from({ length: 50 }, (_, i) => ({ id: uid(300 + i), styleId: ST_CABIN, width: 10, length: 10 + i, label: `10x${10 + i}` }));
    const r = await call(k, { creates: fifty });
    ok(r.created && r.created.length === 50 && r.created.every((x) => x.status === "created"), "a 50-entry call runs", r.err);
    ok((await one(k, `select min(sort_order) a, max(sort_order) b from public.building_sizes where style_id = '${ST_CABIN}'`)).b === 49, "...in order");
    const many = await call(k, { removes: Array.from({ length: 51 }, (_, i) => uid(400 + i)) });
    ok(many.err && many.code === "22023", "51 entries are refused whole", J(many));
    const cells = Object.fromEntries(Array.from({ length: 2501 }, (_, i) => [`k${i}`, 1]));
    const tooMany = await call(k, { sizes: [entry(SZ_A, await version(k, SZ_A), {}, { cells })] });
    ok(tooMany.err && tooMany.code === "22023", "2,501 boxes are refused whole", J(tooMany));
    const badId = await call(k, {}, "Acme Sheds");
    ok(badId.err && badId.code === "22023", "an id that is not a builder id is refused", J(badId));
    ok((await sizeOf(k, SZ_A)).price === 400, "none of the refusals wrote anything");
  }

  console.log("migration 350: re-apply");
  {
    const re = await apply(db);
    ok(!re.err && re.record && re.record.ready === true && re.record.anon_can_execute === false, "re-applies cleanly, grants unchanged", re.err || J(re.record));
  }

  console.log("migration 350: without the version check, A→B→A writes the orphan (mutant)");
  {
    const line = "v_version_ok := v_row.updated_at = (v_e ->> 'base')::timestamptz;";
    const sql = MIG().replace(line, "v_version_ok := true;");
    ok(sql !== MIG(), "(the mutant formed: no version check)");
    const m = await fresh();
    const a = await apply(m, sql);
    ok(!a.err, "the mutant applies", a.err);
    const aba = await abaCase(m);
    ok(aba.late.results[0].status === "saved" && aba.price === 480, "...and the stalled original overwrites the type-back", J(aba.late));
  }

  console.log("migration 350: without the starting-value check, a stale edit lands on a refreshed version (mutant)");
  {
    const sql = MIG().replace(/v_from_ok := [^;]*;/, "v_from_ok := true;");
    ok(sql !== MIG(), "(the mutant formed: no starting-value check)");
    const m = await fresh();
    const a = await apply(m, sql);
    ok(!a.err, "the mutant applies", a.err);
    const sr = await staleRefreshCase(m);
    ok(sr.stale.results[0].status === "saved" && sr.price === 480, "...and the edit made against 500 overwrites the colleague's 450", J(sr.stale));
  }

  for (const d of opened) await d.close().catch(() => {});
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
