// Execute migration 278 for real in PGlite (Postgres compiled to WASM, in memory) on top of the
// catalog tables as they are live (layout_item_types and client_layout_items after 171, the
// layout_item_pricing columns get_config reads) and get_config cut to its LIVE layoutItems block,
// then check what the file promises: the partitionWall master row and one row per tenant; every
// existing row untouched; every tenant's get_config gaining exactly one key, partitionWall, as a
// partition in the Interior group and OUT of the palette until that tenant prices it; a re-apply
// that changes nothing; and assertions that really abort the whole apply (mutants). Nothing here
// touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration278.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
// LF, whatever the checkout: the mutants below splice LF-only text, and on a CRLF checkout
// (core.autocrlf) they would silently fail to form.
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/278_partition_walls.sql"), "utf8").replace(/\r/g, "");

// get_config's layoutItems block, as pg_get_functiondef printed it on the live project on 2026-10-05
// (171's splice, then archived / internalOnly / taxable). 278 does not touch get_config; it asserts
// the three 171 lines are still there, and this is what it is checked against.
const LAYOUT_ITEMS_BLOCK = `
    'layoutItems', coalesce((
      select jsonb_object_agg(cli.item_key,
               jsonb_build_object(
                 'label', coalesce(cli.label_override, lt.label),
                 'icon', lt.icon, 'color', lt.color,
                 'width',  coalesce(cli.width_override,  lt.default_width),
                 'height', coalesce(cli.height_override, lt.default_height),
                 'shortLabel', coalesce(cli.short_label_override, lt.short_label),
                 'wallOnly', lt.wall_only, 'wallSnap', lt.wall_snap)
               || case when lt.door_snap then jsonb_build_object('doorSnap', true) else '{}'::jsonb end
               || case when lt.palette_group is not null then jsonb_build_object('group', lt.palette_group) else '{}'::jsonb end
               || case when lt.model_key is not null then jsonb_build_object('modelKey', lt.model_key) else '{}'::jsonb end
               || case when coalesce(cli.depth_in, lt.depth_in) is not null then jsonb_build_object('depthIn', coalesce(cli.depth_in, lt.depth_in)) else '{}'::jsonb end
               || case when coalesce(cli.height_off_floor_in, lt.height_off_floor_in) is not null then jsonb_build_object('heightOffFloorIn', coalesce(cli.height_off_floor_in, lt.height_off_floor_in)) else '{}'::jsonb end
               || case when coalesce(lt.hidden_until_priced, false)
                         and not exists (select 1 from public.layout_item_pricing lp
                                          where lp.client_id = cc.client_id and lp.item_key = cli.item_key and lp.rate is not null)
                       then jsonb_build_object('noPalette', true) else '{}'::jsonb end
               || case when coalesce(cli.archived, false) then jsonb_build_object('noPalette', true, 'archived', true) else '{}'::jsonb end
               || case when coalesce(cli.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
               || case when coalesce(cli.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end)
      from public.client_layout_items cli
      join public.layout_item_types lt on lt.item_key = cli.item_key and lt.active
      where cli.client_id = cc.client_id and (cli.active or coalesce(cli.archived, false))), '{}'::jsonb)`;

// The tables 278 touches or reads, cut to their live columns and keys. `block` lets a mutant swap the
// get_config body; `extra` adds something the assertions must refuse.
const STUBS = (block = LAYOUT_ITEMS_BLOCK, extra = "") => `
create table public.client_configs (client_id text primary key);
create table public.layout_item_types (
  item_key text primary key,
  label text not null,
  icon text not null default '',
  color text not null default '#000000',
  default_width numeric not null default 3,
  default_height numeric not null default 3,
  wall_only boolean not null default false,
  wall_snap boolean not null default false,
  door_snap boolean not null default false,
  short_label text not null default '',
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  palette_group text,
  model_key text,
  depth_in numeric,
  height_off_floor_in numeric,
  hidden_until_priced boolean not null default false
);
create table public.client_layout_items (
  client_id text not null,
  item_key text not null,
  active boolean not null default true,
  label_override text,
  width_override numeric,
  height_override numeric,
  short_label_override text,
  archived boolean not null default false,
  internal_only boolean not null default false,
  taxable boolean not null default true,
  depth_in numeric,
  height_off_floor_in numeric,
  unique (client_id, item_key)
);
create table public.layout_item_pricing (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  item_key text not null,
  style_id uuid,
  pricing_method text not null default 'each',
  rate numeric,
  image_url text
);
create function public.get_config(p_client_id text) returns jsonb language sql stable as $fn$
  select jsonb_build_object(${block})
  from public.client_configs cc where cc.client_id = p_client_id
$fn$;
${extra}
`;

const SEED = `
insert into public.client_configs (client_id) values ('acme-sheds'), ('bravo-barns');
insert into public.layout_item_types (item_key, label, icon, color, default_width, default_height, wall_only, wall_snap, short_label, sort_order, palette_group, model_key, depth_in, height_off_floor_in, hidden_until_priced, updated_at) values
  ('workbench', 'Workbench', '🔧', '#8B5E3C', 4, 2, false, true, 'WB', 0, 'interior', 'wallBench', null, 36, false, '2026-09-01 10:00+00'),
  ('loft', 'Loft Area', '⬆', '#7C3AED', 6, 4, false, false, 'LF', 0, 'interior', null, null, null, false, '2026-09-01 10:00+00'),
  ('shelf', 'Single Shelf', '📚', '#D97706', 4, 1, false, true, 'SHELF', 60, 'interior', 'wallShelf', 12, 48, true, '2026-09-01 10:00+00'),
  ('roughOpeningDoor', 'Rough Opening (Door)', '⬜', '#000000', 3, 0.5, true, false, 'RO-D', 0, 'doors', null, null, null, false, '2026-09-01 10:00+00');
insert into public.client_layout_items (client_id, item_key, active, label_override, archived, internal_only, taxable) values
  ('acme-sheds', 'workbench', true, null, false, false, true),
  ('acme-sheds', 'loft', true, 'Loft', false, false, true),
  ('acme-sheds', 'shelf', true, null, false, false, true),
  ('acme-sheds', 'roughOpeningDoor', true, null, false, true, false),
  ('bravo-barns', 'workbench', true, null, false, false, true),
  ('bravo-barns', 'shelf', true, null, false, false, true);
-- acme-sheds priced its shelf; bravo-barns did not, so its shelf is out of the palette today.
insert into public.layout_item_pricing (id, client_id, item_key, pricing_method, rate) values
  ('00000000-0000-4000-8000-0000000000a1', 'acme-sheds', 'shelf', 'lineal_ft', 18),
  ('00000000-0000-4000-8000-0000000000a2', 'acme-sheds', 'workbench', 'lineal_ft', 25);
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

async function fresh(block, extra) {
  const db = new PGlite();
  await db.exec(STUBS(block, extra));
  await db.exec(SEED);
  return db;
}
const snapshot = async (db) => JSON.stringify({
  types: await rows(db, "select * from public.layout_item_types where item_key <> 'partitionWall' order by item_key"),
  cli: await rows(db, "select * from public.client_layout_items where item_key <> 'partitionWall' order by client_id, item_key"),
  lp: await rows(db, "select * from public.layout_item_pricing order by id"),
});
const configOf = async (db, client) => (await one(db, "select public.get_config($1) j", [client])).j;
const withoutPartition = (cfg) => { const c = JSON.parse(JSON.stringify(cfg)); delete c.layoutItems.partitionWall; return JSON.stringify(c); };
/** Applies the migration; returns null on success, else the error message. A failed apply leaves its
 *  own begin; open and aborted, as `db query` would end the session: roll it back, as Postgres does. */
async function apply(db, sql = MIG()) {
  try { await db.exec(sql); return null; } catch (e) { await db.exec("rollback").catch(() => {}); return e.message; }
}

(async () => {
  console.log("migration 278: applies on the live shape, adds one item, moves no row");
  {
    const db = await fresh();
    const before = await snapshot(db);
    const cfgBefore = { acme: await configOf(db, "acme-sheds"), bravo: await configOf(db, "bravo-barns") };
    const err = await apply(db);
    ok(err === null, "278 applied cleanly, assertions included", err);

    const t = await one(db, "select * from public.layout_item_types where item_key = 'partitionWall'");
    ok(t && t.label === "Partition Wall" && t.model_key === "partition" && t.palette_group === "interior"
      && t.hidden_until_priced === true && t.wall_only === false && t.wall_snap === false && t.door_snap === false
      && Number(t.default_width) === 4 && t.active === true,
      "the master row: Partition Wall, a partition, Interior, hidden until priced, on no wall, 4 ft default", JSON.stringify(t));
    const tenantRows = await rows(db, "select client_id, active, archived, internal_only, taxable from public.client_layout_items where item_key = 'partitionWall' order by client_id");
    ok(JSON.stringify(tenantRows) === JSON.stringify([
      { client_id: "acme-sheds", active: true, archived: false, internal_only: false, taxable: true },
      { client_id: "bravo-barns", active: true, archived: false, internal_only: false, taxable: true },
    ]), "every tenant has its row, active and taxable", JSON.stringify(tenantRows));
    ok(await snapshot(db) === before, "every other catalog row and every price is untouched");
    ok((await one(db, "select count(*)::int n from public.layout_item_pricing where item_key = 'partitionWall'")).n === 0,
      "no tenant is given a price: nobody's customers see it");

    for (const [client, was] of [["acme-sheds", cfgBefore.acme], ["bravo-barns", cfgBefore.bravo]]) {
      const cfg = await configOf(db, client);
      const pw = cfg.layoutItems.partitionWall;
      ok(pw && pw.modelKey === "partition" && pw.group === "interior" && pw.noPalette === true
        && pw.wallOnly === false && pw.wallSnap === false && pw.label === "Partition Wall" && Number(pw.width) === 4,
        `${client}: get_config sends partitionWall as a partition in Interior, OUT of the palette`, JSON.stringify(pw));
      ok(withoutPartition(cfg) === JSON.stringify(was), `${client}: and nothing else in its get_config moved`);
    }

    // The builder prices it: the button is offered on THAT tenant's designer, and only there.
    await db.exec("insert into public.layout_item_pricing (client_id, item_key, pricing_method, rate) values ('acme-sheds', 'partitionWall', 'lineal_ft', 22)");
    ok(!("noPalette" in (await configOf(db, "acme-sheds")).layoutItems.partitionWall), "priced by acme-sheds: offered on acme-sheds' designer");
    ok((await configOf(db, "bravo-barns")).layoutItems.partitionWall.noPalette === true, "...and still hidden on bravo-barns'");

    // Re-applying is a no-op (on conflict do nothing) and its checks still pass with one tenant priced.
    const mid = JSON.stringify(await rows(db, "select * from public.client_layout_items order by client_id, item_key"));
    const err2 = await apply(db);
    ok(err2 === null, "a second apply goes through", err2);
    ok(JSON.stringify(await rows(db, "select * from public.client_layout_items order by client_id, item_key")) === mid
      && (await one(db, "select count(*)::int n from public.layout_item_types where item_key = 'partitionWall'")).n === 1,
      "...and changes nothing");

    // A tenant onboarded later is given its row by the next apply, like 171's shelves.
    await db.exec("insert into public.client_configs (client_id) values ('cedar-co')");
    ok(await apply(db) === null && (await one(db, "select count(*)::int n from public.client_layout_items where client_id = 'cedar-co' and item_key = 'partitionWall'")).n === 1,
      "a re-apply gives a new tenant its row");

    // THE RECORD is the last statement's row.
    const db2 = await fresh();
    const res = await db2.exec(MIG());
    const rec = res[res.length - 1] && res[res.length - 1].rows && res[res.length - 1].rows[0];
    // `commit;` is the last statement; the record is the one before it.
    const record = res.map((r) => r.rows && r.rows[0]).filter((r) => r && "master_row" in r).pop();
    ok(record && record.master_row === true && Number(record.tenants) === 2 && Number(record.tenant_rows) === 2 && Number(record.priced_by) === 0,
      "THE RECORD reads true, 2, 2, 0", JSON.stringify(record || rec));
  }

  console.log("migration 278: the assertions abort the whole apply (mutants)");
  {
    // A partitionWall row someone wrote by hand with another shape: on conflict keeps it, so the
    // check must refuse, and nothing of the migration may survive.
    const db = await fresh(undefined, "insert into public.layout_item_types (item_key, label, model_key, palette_group, hidden_until_priced) values ('partitionWall', 'Partition', 'wallShelf', 'interior', true);");
    const err = await apply(db);
    ok(err && /is not the row this migration writes/.test(err), "a conflicting master row aborts the apply", err);
    ok((await one(db, "select count(*)::int n from public.client_layout_items where item_key = 'partitionWall'")).n === 0,
      "...and no tenant row survives it (one transaction)");
  }
  {
    // get_config rewritten without the hidden-until-priced line: applying would put the item, unpriced,
    // on every customer's designer, so the apply refuses.
    const block = LAYOUT_ITEMS_BLOCK.replace(/\n\s*\|\| case when coalesce\(lt\.hidden_until_priced, false\)\n[^\n]*\n[^\n]*\n\s*then jsonb_build_object\('noPalette', true\) else '\{\}'::jsonb end/, "");
    ok(block !== LAYOUT_ITEMS_BLOCK, "(the mutant formed: get_config without 171's noPalette line)");
    const db = await fresh(block);
    const err = await apply(db);
    ok(err && /no longer emits group \/ modelKey \/ the hidden-until-priced noPalette/.test(err), "a get_config without it aborts the apply", err);
  }
  {
    // A copy of 278 whose master row forgot hidden_until_priced: the live probe must catch the item
    // reaching a customer's palette unpriced.
    const sql = MIG().replace("'PART', 62, true, 'interior', 'partition', null, null, true)", "'PART', 62, true, 'interior', 'partition', null, null, false)");
    ok(sql !== MIG(), "(the mutant formed: hidden_until_priced false)");
    const db = await fresh();
    const err = await apply(db, sql);
    ok(err && /is not the row this migration writes/.test(err), "a master row that is not hidden until priced aborts the apply", err);
  }
  {
    // A copy that seeds no tenant rows: the per-tenant check must notice.
    const sql = MIG().replace("from public.client_configs cc\non conflict (client_id, item_key) do nothing;", "from public.client_configs cc where false\non conflict (client_id, item_key) do nothing;");
    ok(sql !== MIG(), "(the mutant formed: no tenant rows)");
    const db = await fresh();
    const err = await apply(db, sql);
    ok(err && /tenant\(s\) have no client_layout_items row for partitionWall/.test(err), "a tenant without its row aborts the apply", err);
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
