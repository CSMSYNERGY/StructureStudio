// Execute migration 335 (a window's default grid of lites: fixture_items.lite_rows / lite_cols, in place
// of 324's panes) for real in PGlite (Postgres compiled to WASM, in memory) on top of the tables it
// touches or reads, cut to their live columns, with get_fixtures rebuilt exactly as it is live: 289's own
// statement saved with CRLF line endings (the live body has them), then 313's PART 6 and 320's PART 2
// splices run on it, then the whole of 324. The rebuilt body's md5 is checked against the one read live
// on 2026-10-24, so this test fails the moment it stops being the body the migration will meet. Then
// check what the file promises:
//   * lite_rows and lite_cols are smallint, nullable, no default; both NULL or both 1 to 8, and only on
//     a window;
//   * every tenant's get_fixtures is byte-for-byte unchanged at apply;
//   * get_fixtures sends `liteRows` / `liteCols` SPARSE, on a listed window that has a grid set (prices
//     hidden or not), beside 320's doorWindowAt and 289's inDoor; nothing for a window without one, a
//     door, or an archived, inactive or unpriced row (not listed); and panes never again;
//   * THE RECORD reads true, <tenants>, 0, true, false;
//   * a row still using 324's panes stops the apply, and nothing of it survives;
//   * a re-apply changes nothing; the header's ROLLBACK puts 324's merge back and takes the columns out,
//     leaving exactly the body it found, and the file applies again after it;
//   * a drifted live body, and a splice that moves anything else, abort the whole apply (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration335.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/335_window_lites.sql"), "utf8").replace(/\r/g, "");
// get_fixtures' live prosrc md5 (carriage returns removed), read on 2026-10-24: 289 + 313 + 320 + 324.
const LIVE_MD5 = "325c73a2e633e884947d6dc795eb36be";

const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
// 289's create statement, stored WITH CRLF, as live.
const GET_FIXTURES_289 = (() => {
  const t = read("289_door_generator.sql");
  const i = t.indexOf("create or replace function public.get_fixtures(p_client_id text)");
  const j = t.indexOf("\n$$\n;", i);
  if (i < 0 || j < 0) throw new Error("289's get_fixtures statement moved; re-point GET_FIXTURES_289");
  return t.slice(i, j + "\n$$\n;".length).replace(/\n/g, "\r\n");
})();
// A DO block lifted verbatim from a migration file.
const doBlock = (file, tag) => {
  const t = read(file);
  const i = t.indexOf(`do $${tag}$`);
  const j = t.indexOf(`$${tag}$;`, i + tag.length + 5);
  if (i < 0 || j < 0) throw new Error(`${file}'s ${tag} block moved; re-point the test`);
  return t.slice(i, j + tag.length + 3);
};
const SPLICE_313 = doBlock("313_interior_walls.sql", "m313_fix");
const SPLICE_320 = doBlock("320_door_window_at.sql", "m320_fix");
// 324 whole (its column, its checks, its splice and its own assertions), as it was applied live.
const MIG_324 = read("324_window_panes.sql");

const STUBS = ({ fixtures = GET_FIXTURES_289 } = {}) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
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
  in_door boolean not null default false,
  in_partition boolean not null default true,
  door_window_at text not null default 'panel',
  constraint fixture_items_in_door_window_chk check (not in_door or category = 'window'),
  constraint fixture_items_door_window_at_chk check (door_window_at in ('panel', 'top')),
  constraint fixture_items_door_window_top_chk check (door_window_at = 'panel' or (category = 'window' and in_door))
);
${fixtures}
${SPLICE_313}
${SPLICE_320}
`;

const DOOR = "00000000-0000-4000-8000-0000000000d1";
const WALL = "00000000-0000-4000-8000-0000000000a1";
const TOP = "00000000-0000-4000-8000-0000000000a2";   // a transom (320)
const LITE = "00000000-0000-4000-8000-0000000000a3";  // a panel window in doors (289)
const CEDAR = "00000000-0000-4000-8000-0000000000c2"; // cedar-co hides prices
const OLD = "00000000-0000-4000-8000-0000000000a4";   // archived
const OFF = "00000000-0000-4000-8000-0000000000a5";   // inactive
const FREE = "00000000-0000-4000-8000-0000000000a6";  // unpriced (not listed)
const SEED = `
insert into public.client_configs (client_id) values ('acme-sheds'), ('bravo-barns'), ('cedar-co');
insert into public.client_settings (client_id, show_pricing) values ('acme-sheds', true), ('bravo-barns', true), ('cedar-co', false);
insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, sort_order, in_door, door_window_at, archived, active) values
  ('${DOOR}',  'acme-sheds', 'door',   'Double door',     72, 72, 900, 0, false, 'panel', false, true),
  ('${WALL}',  'acme-sheds', 'window', 'Wall window',     24, 36, 120, 0, false, 'panel', false, true),
  ('${TOP}',   'acme-sheds', 'window', 'Transom Windows', 29, 10,  81, 1, true,  'top',   false, true),
  ('${LITE}',  'acme-sheds', 'window', 'Door lite',       18, 24,  95, 2, true,  'panel', false, true),
  ('${OLD}',   'acme-sheds', 'window', 'Old window',      24, 12,  70, 3, false, 'panel', true,  true),
  ('${OFF}',   'acme-sheds', 'window', 'Off window',      24, 12,  70, 4, false, 'panel', false, false),
  ('${CEDAR}', 'cedar-co',   'window', 'Transom',         24, 12,  85, 0, true,  'top',   false, true);
insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, sort_order) values
  ('${FREE}',  'acme-sheds', 'window', 'Free window',     24, 12, null, 5);
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const opened = [];
async function fresh(opts) {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS(opts));
  await db.exec(SEED);
  await db.exec(MIG_324);
  return db;
}
async function apply(db, sql = MIG()) {
  try {
    const out = await db.exec(sql);
    const record = [...out].reverse().map((r) => r.rows && r.rows[0]).find((r) => r && "columns_ready" in r);
    return { err: null, record };
  } catch (e) { await db.exec("rollback").catch(() => {}); return { err: e.message }; }
}
const fixOf = async (db, c) => (await one(db, "select public.get_fixtures($1) j", [c])).j;
const lfMd5 = async (db) => (await one(db, "select md5(replace(prosrc, chr(13), '')) m from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure")).m;
const defOf = async (db) => (await one(db, "select pg_get_functiondef('public.get_fixtures(text)'::regprocedure) d")).d;
const colCount = async (db) => (await one(db, "select count(*)::int n from information_schema.columns where table_name = 'fixture_items' and column_name in ('lite_rows', 'lite_cols')")).n;
const TENANTS = ["acme-sheds", "bravo-barns", "cedar-co"];
const refused = async (db, sql) => { try { await db.exec(sql); return false; } catch (_) { return true; } };
const MERGE = "|| case when fi.lite_rows is not null and fi.category = 'window' then jsonb_build_object('liteRows', fi.lite_rows, 'liteCols', fi.lite_cols) else '{}'::jsonb end";
const MERGE_324 = "|| case when fi.panes is not null and fi.category = 'window' then jsonb_build_object('panes', fi.panes) else '{}'::jsonb end";
// Rollback, as the header writes it, with the comment markers taken off.
const ROLLBACK = () => {
  const t = MIG();
  const i = t.indexOf("--   begin;\n--   do $rb$");
  const j = t.indexOf("--   commit;", i);
  if (i < 0 || j < 0) throw new Error("the ROLLBACK block in 335's header moved; re-point the test");
  return t.slice(i, j + "--   commit;".length).split("\n").map((l) => l.replace(/^--   ?/, "")).join("\n")
    .replace("delete from supabase_migrations.schema_migrations where version = '335';", "");
};
const set = (id, r, c) => `update public.fixture_items set lite_rows = ${r}, lite_cols = ${c} where id = '${id}'`;

(async () => {
  console.log("the stand-in for the live get_fixtures");
  {
    const db = await fresh();
    ok(await lfMd5(db) === LIVE_MD5, "289 + 313's splice + 320's splice + 324 is the body read live on 2026-10-24", await lfMd5(db));
  }

  console.log("migration 335: applies on the live shape");
  {
    const db = await fresh();
    const before = {};
    for (const c of TENANTS) before[c] = JSON.stringify(await fixOf(db, c));
    const bodyBefore = await defOf(db);
    const { err, record } = await apply(db);
    ok(err === null, "335 applied cleanly, assertions included", err);
    ok(record && record.columns_ready === true && Number(record.tenants) === 3 && Number(record.windows_with_a_grid) === 0
      && record.fixtures_send_it === true && record.fixtures_send_panes === false,
      "THE RECORD reads true, 3, 0, true, false", JSON.stringify(record));
    for (const c of TENANTS) ok(JSON.stringify(await fixOf(db, c)) === before[c], `${c}: get_fixtures is byte-for-byte unchanged`);
    const after = await defOf(db);
    ok(after.split(MERGE).length === 2, "the lites merge is in the body once");
    ok(!after.includes(MERGE_324), "324's panes merge is gone from it");
    ok(after.split("|| case when fi.category = 'window' and coalesce(fi.in_door, false)").length === 2, "289's inDoor merge is still there exactly once, for the next splice");
    ok(after.replace(/\r/g, "") === bodyBefore.replace(/\r/g, "").replace(MERGE_324, MERGE), "...and swapping the merge is the only change to the body");
    console.log("    (written body md5 " + (await lfMd5(db)) + ")");

    console.log("the columns and their checks");
    for (const c of ["lite_rows", "lite_cols"]) {
      const col = await one(db, `select data_type, is_nullable, column_default from information_schema.columns where table_name = 'fixture_items' and column_name = '${c}'`);
      ok(col && col.data_type === "smallint" && col.is_nullable === "YES" && col.column_default === null, `${c}: smallint, nullable, no default`, JSON.stringify(col));
    }
    ok((await one(db, "select count(*)::int n from public.fixture_items where lite_rows is not null or lite_cols is not null")).n === 0, "every row reads NULL (automatic, the look it had)");
    for (const [r, c] of [[0, 1], [1, 0], [9, 1], [1, 9], [-1, 2], [1, "null"], ["null", 2]]) {
      ok(await refused(db, set(WALL, r, c)), `${r} x ${c} is refused`);
    }
    ok(await refused(db, set(DOOR, 1, 1)), "a grid on a door is refused");
    ok(!(await refused(db, set(WALL, 3, 2))), "3 x 2 (a 6-lite) on a wall window is stored");
    ok(!(await refused(db, set(TOP, 1, 5))), "1 x 5 on a transom is stored");
    ok(!(await refused(db, set(LITE, 3, 3))), "3 x 3 (a 9-lite) on a door lite is stored");
    ok(!(await refused(db, `update public.fixture_items set lite_rows = 1, lite_cols = 1 where id in ('${CEDAR}', '${OLD}', '${OFF}', '${FREE}')`)), "1 x 1 (no grid) is stored");
    ok(!(await refused(db, set(OLD, 8, 8))), "8 x 8 is stored");

    console.log("get_fixtures: the grid, sparse");
    const byId = Object.fromEntries((await fixOf(db, "acme-sheds")).items.map((i) => [i.id, i]));
    ok(byId[WALL].liteRows === 3 && byId[WALL].liteCols === 2, "the wall window carries liteRows 3, liteCols 2", JSON.stringify(byId[WALL]));
    ok(byId[TOP].liteRows === 1 && byId[TOP].liteCols === 5 && byId[TOP].doorWindowAt === "top" && byId[TOP].inDoor === true,
      "the transom carries 1 x 5 beside doorWindowAt and inDoor", JSON.stringify(byId[TOP]));
    ok(byId[LITE].liteRows === 3 && byId[LITE].liteCols === 3, "the door lite carries 3 x 3", JSON.stringify(byId[LITE]));
    ok(!("liteRows" in byId[DOOR]) && !("liteCols" in byId[DOOR]), "a door carries nothing new");
    ok(Object.values(byId).every((i) => !("panes" in i)), "nothing carries panes");
    ok(!byId[OLD] && !byId[OFF] && !byId[FREE], "an archived, inactive or unpriced window is not listed at all");
    const cedar = (await fixOf(db, "cedar-co")).items;
    ok(cedar.length === 1 && cedar[0].liteRows === 1 && cedar[0].liteCols === 1 && !("price" in cedar[0]), "a tenant that hides prices still gets the grid (and no price)", JSON.stringify(cedar));
    ok(JSON.stringify(await fixOf(db, "bravo-barns")) === before["bravo-barns"], "a tenant with no window set: unchanged");
    const strip = (j) => JSON.stringify({ ...j, items: j.items.map(({ liteRows: _r, liteCols: _c, ...r }) => r) });
    ok(strip(await fixOf(db, "acme-sheds")) === before["acme-sheds"], "acme-sheds: nothing but the grid moved");

    console.log("re-apply and rollback");
    const def = await defOf(db);
    const re = await apply(db);
    ok(re.err === null, "a second apply goes through with grids on file, its checks included", re.err);
    ok(re.record && Number(re.record.windows_with_a_grid) === 7, "...THE RECORD counts them", JSON.stringify(re.record));
    ok(await defOf(db) === def, "...and splices nothing twice");
    try { await db.exec(ROLLBACK()); ok(true, "the header's ROLLBACK runs"); }
    catch (e) { ok(false, "the header's ROLLBACK runs", e.message); }
    ok(!(await defOf(db)).includes("jsonb_build_object('liteRows'"), "...and takes the splice back out");
    ok(await lfMd5(db) === LIVE_MD5, "...leaving exactly the body it found (324's)");
    ok(await colCount(db) === 0, "...and the columns are gone");
    for (const c of TENANTS) ok(JSON.stringify(await fixOf(db, c)) === before[c], `${c}: get_fixtures is back to what it was`);
    const again = await apply(db);
    ok(again.err === null, "335 applies again after a rollback", again.err);
  }

  console.log("migration 335: a row still on 324's panes stops it");
  {
    const db = await fresh();
    await db.exec(`update public.fixture_items set panes = 3 where id = '${WALL}'`);
    const { err } = await apply(db);
    ok(err && /use 324's Panes/.test(err), "the apply is refused, in words", err);
    ok(await colCount(db) === 0, "...and nothing of it survives (one transaction)");
    ok(await lfMd5(db) === LIVE_MD5, "...get_fixtures included");
  }

  console.log("migration 335: a drifted body or a wider splice aborts the whole apply (mutants)");
  {
    // Someone else's splice lands on the live body after 324.
    const db = await fresh();
    await db.exec(`do $d$ declare s text := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
      begin execute replace(s, $k$'sortOrder', fi.sort_order)$k$, $k$'sortOrder', fi.sort_order, 'x', 1)$k$); end $d$;`);
    ok(await lfMd5(db) !== LIVE_MD5, "(the mutant formed: get_fixtures changed by someone else since)");
    const { err } = await apply(db);
    ok(err && /is not the body PART 2 was derived from/.test(err), "a drifted live body aborts", err);
    ok(await colCount(db) === 0, "...and the columns do not survive it (one transaction)");
  }
  {
    // A splice that sends the key for every window: nothing has a grid at apply, so the body check
    // and the output check must both refuse it.
    const wide = (s) => s.replace("$repl$|| case when fi.lite_rows is not null and fi.category = 'window' then jsonb_build_object('liteRows', fi.lite_rows, 'liteCols', fi.lite_cols)",
      "$repl$|| case when fi.category = 'window' then jsonb_build_object('liteRows', coalesce(fi.lite_rows, 0), 'liteCols', fi.lite_cols)");
    const sql = wide(MIG());
    ok(sql !== MIG(), "(the mutant formed: the grid on every window)");
    let db = await fresh();
    let r = await apply(db, sql);
    ok(r.err && /(changed for \d+ tenant|is not the body PART 2 writes)/.test(r.err), "a splice that moves anything else aborts the apply", r.err);
    ok(await colCount(db) === 0, "...and nothing of it survives");
    const noBody = sql.replace(/if md5\(v_src\) <> '[0-9a-f]{32}' then\n    raise exception '335: get_fixtures is not the body PART 2 writes/, "if false then\n    raise exception '335: get_fixtures is not the body PART 2 writes");
    ok(/if false then/.test(noBody), "(the mutant formed: the wider splice, body check off)");
    db = await fresh();
    r = await apply(db, noBody);
    ok(r.err && /changed for 2 tenant\(s\) beyond the grid/.test(r.err), "...the per-tenant output check refuses it on its own (both tenants with a window)", r.err);
  }

  for (const db of opened) await db.close().catch(() => {});
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
