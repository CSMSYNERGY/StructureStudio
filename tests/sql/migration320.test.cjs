// Execute migration 320 (a window as a TRANSOM in a door: fixture_items.door_window_at) for real in
// PGlite (Postgres compiled to WASM, in memory) on top of the tables it touches or reads, cut to their
// live columns, with get_fixtures rebuilt exactly as it is live: 289's own statement saved with CRLF
// line endings (the live body has them), then 313's PART 6 splice run on it. The rebuilt body's md5
// is checked against the one read live on 2026-10-21, so this test fails the moment it stops being
// the body the migration will meet. Then check what the file promises:
//   * door_window_at is text not null default 'panel', 'panel' or 'top' only, and 'top' only on a
//     window that can go in a door (in_door) -- a door, a vent, a window not ticked for doors, and
//     unticking in_door on a 'top' row are all refused;
//   * every tenant's get_fixtures is byte-for-byte unchanged at apply;
//   * get_fixtures sends doorWindowAt: 'top', SPARSE, on a listed 'top' window only (prices hidden or
//     not), never on a panel window, and not for an archived, inactive or unpriced row (not listed);
//   * THE RECORD reads true, <tenants>, 0, 0, true;
//   * a re-apply changes nothing; the header's ROLLBACK takes the splice and the column back out, and
//     the file applies again after it;
//   * a drifted live body, and a splice that moves anything else, abort the whole apply (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration320.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/320_door_window_at.sql"), "utf8").replace(/\r/g, "");
// get_fixtures' live prosrc md5 (carriage returns removed), read on 2026-10-21: 289's body plus 313's splice.
const LIVE_MD5 = "06ff912026e31ca460781f7b05f8269d";

// 289's create statement, stored WITH CRLF, as live.
const GET_FIXTURES_289 = (() => {
  const t = fs.readFileSync(path.join(WT, "supabase/migrations/289_door_generator.sql"), "utf8").replace(/\r/g, "");
  const i = t.indexOf("create or replace function public.get_fixtures(p_client_id text)");
  const j = t.indexOf("\n$$\n;", i);
  if (i < 0 || j < 0) throw new Error("289's get_fixtures statement moved; re-point GET_FIXTURES_289");
  return t.slice(i, j + "\n$$\n;".length).replace(/\n/g, "\r\n");
})();
// 313's PART 6 (the inPartition splice), verbatim.
const SPLICE_313 = (() => {
  const t = fs.readFileSync(path.join(WT, "supabase/migrations/313_interior_walls.sql"), "utf8").replace(/\r/g, "");
  const i = t.indexOf("do $m313_fix$");
  const j = t.indexOf("$m313_fix$;", i + 20);
  if (i < 0 || j < 0) throw new Error("313's PART 6 moved; re-point SPLICE_313");
  return t.slice(i, j + "$m313_fix$;".length);
})();

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
  constraint fixture_items_in_door_window_chk check (not in_door or category = 'window')
);
${fixtures}
${SPLICE_313}
`;

const DOOR = "00000000-0000-4000-8000-0000000000d1";
const LITE = "00000000-0000-4000-8000-0000000000a1";   // in_door, the upper panel (289)
const TRANSOM = "00000000-0000-4000-8000-0000000000a2"; // in_door, about to be a transom
const WALL = "00000000-0000-4000-8000-0000000000a3";    // a wall window, not for doors
const VENT = "00000000-0000-4000-8000-0000000000e1";
const CEDAR_T = "00000000-0000-4000-8000-0000000000c2"; // cedar-co hides prices
const OLD_T = "00000000-0000-4000-8000-0000000000a4";   // archived
const OFF_T = "00000000-0000-4000-8000-0000000000a5";   // inactive
const FREE_T = "00000000-0000-4000-8000-0000000000a6";  // unpriced (not listed by get_fixtures)
const SEED = `
insert into public.client_configs (client_id) values ('acme-sheds'), ('bravo-barns'), ('cedar-co');
insert into public.client_settings (client_id, show_pricing) values ('acme-sheds', true), ('bravo-barns', true), ('cedar-co', false);
insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, sort_order, in_door, door_style, in_partition, archived, active) values
  ('${DOOR}',    'acme-sheds', 'door',   'Double door',     72, 72, 900, 0, false, 'american', true, false, true),
  ('${LITE}',    'acme-sheds', 'window', 'Door lite',       18, 24,  95, 0, true,  'auto', true, false, true),
  ('${TRANSOM}', 'acme-sheds', 'window', 'Transom Windows', 29, 10,  81, 1, true,  'auto', false, false, true),
  ('${WALL}',    'acme-sheds', 'window', 'Wall window',     24, 36, 120, 2, false, 'auto', true, false, true),
  ('${VENT}',    'acme-sheds', 'vent',   'Gable vent',      12, 12,  40, 0, false, 'auto', true, false, true),
  ('${OLD_T}',   'acme-sheds', 'window', 'Old transom',     29, 10,  70, 3, true,  'auto', true, true,  true),
  ('${OFF_T}',   'acme-sheds', 'window', 'Off transom',     29, 10,  70, 4, true,  'auto', true, false, false),
  ('${CEDAR_T}', 'cedar-co',   'window', 'Transom',         29, 12,  85, 0, true,  'auto', true, false, true);
insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, sort_order, in_door) values
  ('${FREE_T}',  'acme-sheds', 'window', 'Free transom',    29, 10, null, 5, true);
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
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
    const record = [...out].reverse().map((r) => r.rows && r.rows[0]).find((r) => r && "column_ready" in r);
    return { err: null, record };
  } catch (e) { await db.exec("rollback").catch(() => {}); return { err: e.message }; }
}
const fixOf = async (db, c) => (await one(db, "select public.get_fixtures($1) j", [c])).j;
const lfMd5 = async (db) => (await one(db, "select md5(replace(prosrc, chr(13), '')) m from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure")).m;
const defOf = async (db) => (await one(db, "select pg_get_functiondef('public.get_fixtures(text)'::regprocedure) d")).d;
const TENANTS = ["acme-sheds", "bravo-barns", "cedar-co"];
const refused = async (db, sql) => { try { await db.exec(sql); return false; } catch (_) { return true; } };
// Rollback, as the header writes it, with the comment markers taken off.
const ROLLBACK = () => {
  const t = MIG();
  const i = t.indexOf("--   begin;\n--   do $rb$");
  const j = t.indexOf("--   commit;", i);
  if (i < 0 || j < 0) throw new Error("the ROLLBACK block in 320's header moved; re-point the test");
  return t.slice(i, j + "--   commit;".length).split("\n").map((l) => l.replace(/^--   ?/, "")).join("\n")
    // There is no ledger in PGlite.
    .replace("delete from supabase_migrations.schema_migrations where version = '320';", "");
};

(async () => {
  console.log("the stand-in for the live get_fixtures");
  {
    const db = await fresh();
    ok(await lfMd5(db) === LIVE_MD5, "289's body plus 313's splice is the body read live on 2026-10-21", await lfMd5(db));
  }

  console.log("migration 320: applies on the live shape");
  {
    const db = await fresh();
    const before = {};
    for (const c of TENANTS) before[c] = JSON.stringify(await fixOf(db, c));
    const bodyBefore = await defOf(db);
    const { err, record } = await apply(db);
    ok(err === null, "320 applied cleanly, assertions included", err);
    ok(record && record.column_ready === true && Number(record.tenants) === 3 && Number(record.top_windows) === 0
      && Number(record.bad_rows) === 0 && record.fixtures_send_it === true,
      "THE RECORD reads true, 3, 0, 0, true", JSON.stringify(record));
    for (const c of TENANTS) ok(JSON.stringify(await fixOf(db, c)) === before[c], `${c}: get_fixtures is byte-for-byte unchanged`);
    const after = await defOf(db);
    const mergeAt = after.indexOf("|| case when fi.door_window_at = 'top'");
    ok(mergeAt > 0 && after.indexOf("|| case when fi.door_window_at = 'top'", mergeAt + 1) < 0, "the doorWindowAt merge is in the body once");
    const anchor = "|| case when fi.category = 'window' and coalesce(fi.in_door, false)";
    ok(after.split(anchor).length === 2, "289's inDoor merge is still there exactly once, for the next splice");
    ok(mergeAt > 0 && after.replace(/\r/g, "").replace("|| case when fi.door_window_at = 'top' and fi.category = 'window' and coalesce(fi.in_door, false) then jsonb_build_object('doorWindowAt', 'top') else '{}'::jsonb end\n    ", "")
      === bodyBefore.replace(/\r/g, ""), "...and the merge is the only change to the body");

    console.log("the column and its checks");
    const col = await one(db, "select data_type, is_nullable, column_default from information_schema.columns where table_name = 'fixture_items' and column_name = 'door_window_at'");
    ok(col && col.data_type === "text" && col.is_nullable === "NO" && /^'panel'/.test(col.column_default), "text not null default 'panel'", JSON.stringify(col));
    ok((await one(db, "select count(*)::int n from public.fixture_items where door_window_at <> 'panel'")).n === 0, "every row reads 'panel' (289 exactly)");
    ok(await refused(db, `update public.fixture_items set door_window_at = 'side' where id = '${LITE}'`), "a position that is neither 'panel' nor 'top' is refused");
    ok(await refused(db, `update public.fixture_items set door_window_at = 'top' where id = '${WALL}'`), "'top' on a window not ticked for doors is refused");
    ok(await refused(db, `update public.fixture_items set door_window_at = 'top' where id = '${DOOR}'`), "'top' on a door is refused");
    ok(await refused(db, `update public.fixture_items set door_window_at = 'top' where id = '${VENT}'`), "'top' on a vent is refused");
    ok(!(await refused(db, `update public.fixture_items set door_window_at = 'top' where id in ('${TRANSOM}', '${CEDAR_T}', '${OLD_T}', '${OFF_T}', '${FREE_T}')`)), "'top' on a window that can go in a door is stored");
    ok(await refused(db, `update public.fixture_items set in_door = false where id = '${TRANSOM}'`), "unticking in_door on a transom (still 'top') is refused");
    ok(!(await refused(db, `update public.fixture_items set in_door = false, door_window_at = 'panel' where id = '${TRANSOM}'`)), "...and goes through with the position reset in the same write (portal-settings' rule)");
    await db.exec(`update public.fixture_items set in_door = true, door_window_at = 'top' where id = '${TRANSOM}'`);

    console.log("get_fixtures: doorWindowAt, sparse");
    const items = (await fixOf(db, "acme-sheds")).items;
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    ok(byId[TRANSOM] && byId[TRANSOM].doorWindowAt === "top" && byId[TRANSOM].inDoor === true, "the transom carries doorWindowAt: 'top' beside inDoor: true", JSON.stringify(byId[TRANSOM]));
    ok(byId[TRANSOM].inPartition === false, "...and 313's flag still rides beside it");
    ok(byId[LITE] && byId[LITE].inDoor === true && !("doorWindowAt" in byId[LITE]), "a panel window carries inDoor only, as before");
    ok(!("doorWindowAt" in byId[WALL]) && !("doorWindowAt" in byId[DOOR]) && !("doorWindowAt" in byId[VENT]), "nothing else carries it");
    ok(!byId[OLD_T] && !byId[OFF_T] && !byId[FREE_T], "an archived, inactive or unpriced transom is not listed at all");
    const cedar = (await fixOf(db, "cedar-co")).items;
    ok(cedar.length === 1 && cedar[0].doorWindowAt === "top" && !("price" in cedar[0]), "a tenant that hides prices still gets doorWindowAt (and no price)", JSON.stringify(cedar));
    ok(JSON.stringify(await fixOf(db, "bravo-barns")) === before["bravo-barns"], "a tenant with no transom: unchanged");
    const strip = (j) => JSON.stringify({ ...j, items: j.items.map(({ doorWindowAt: _d, ...r }) => r) });
    ok(strip(await fixOf(db, "acme-sheds")) === before["acme-sheds"], "acme-sheds: nothing but doorWindowAt moved");

    console.log("re-apply and rollback");
    const def = await defOf(db);
    const re = await apply(db);
    ok(re.err === null, "a second apply goes through with transoms on file, its checks included", re.err);
    ok(re.record && Number(re.record.top_windows) === 5, "...THE RECORD counts them", JSON.stringify(re.record));
    ok(await defOf(db) === def, "...and splices nothing twice");
    ok((await fixOf(db, "acme-sheds")).items.find((i) => i.id === TRANSOM).doorWindowAt === "top", "...and leaves the builder's transom alone");

    try { await db.exec(ROLLBACK()); ok(true, "the header's ROLLBACK runs"); }
    catch (e) { ok(false, "the header's ROLLBACK runs", e.message); }
    ok(!(await defOf(db)).includes("doorWindowAt"), "...and takes the splice back out");
    ok(await lfMd5(db) === LIVE_MD5, "...leaving exactly the body it found");
    ok((await one(db, "select count(*)::int n from information_schema.columns where table_name = 'fixture_items' and column_name = 'door_window_at'")).n === 0, "...and the column is gone");
    for (const c of TENANTS) ok(JSON.stringify(await fixOf(db, c)) === before[c], `${c}: get_fixtures is back to what it was`);
    const again = await apply(db);
    ok(again.err === null, "320 applies again after a rollback", again.err);
  }

  console.log("migration 320: a drifted body or a wider splice aborts the whole apply (mutants)");
  {
    const fixtures = GET_FIXTURES_289.replace("'imageUrl', fi.image_url, 'sortOrder', fi.sort_order)\r\n    end)", "'imageUrl', fi.image_url, 'sortOrder', fi.sort_order, 'x', 1)\r\n    end)");
    ok(fixtures !== GET_FIXTURES_289, "(the mutant formed: get_fixtures changed by someone else since)");
    const db = await fresh({ fixtures });
    const { err } = await apply(db);
    ok(err && /is not the body PART 2 was derived from/.test(err), "a drifted live body aborts", err);
    ok((await one(db, "select count(*)::int n from information_schema.columns where table_name = 'fixture_items' and column_name = 'door_window_at'")).n === 0, "...and the column does not survive it (one transaction)");
  }
  {
    // A splice that sends the key for every window in a door: nothing is 'top' at apply, so check 4 must see it.
    const sql = MIG().replace("$repl$|| case when fi.door_window_at = 'top' and fi.category = 'window'", "$repl$|| case when fi.category = 'window'");
    ok(sql !== MIG(), "(the mutant formed: doorWindowAt on every in-door window)");
    const db = await fresh();
    const { err } = await apply(db, sql);
    ok(err && /(changed for \d+ tenant|is not the body PART 2 writes)/.test(err), "a splice that moves anything else aborts the apply", err);
    ok((await one(db, "select count(*)::int n from information_schema.columns where table_name = 'fixture_items' and column_name = 'door_window_at'")).n === 0, "...and nothing of it survives");
  }
  {
    // The same wider splice with the body check taken out: the output check alone must still refuse it.
    const sql = MIG().replace("$repl$|| case when fi.door_window_at = 'top' and fi.category = 'window'", "$repl$|| case when fi.category = 'window'")
      .replace(/if md5\(v_src\) <> '[0-9a-f]{32}' then\n    raise exception '320: get_fixtures is not the body PART 2 writes/, "if false then\n    raise exception '320: get_fixtures is not the body PART 2 writes");
    ok(/if false then/.test(sql), "(the mutant formed: the wider splice, body check off)");
    const db = await fresh();
    const { err } = await apply(db, sql);
    ok(err && /changed for 2 tenant\(s\) beyond doorWindowAt/.test(err), "...the per-tenant output check refuses it on its own (both tenants with a window in a door)", err);
  }
  {
    // A splice that drops the window test: on a first apply it moves nothing, so the body check must see it.
    const sql = MIG().replace("$repl$|| case when fi.door_window_at = 'top' and fi.category = 'window' and coalesce(fi.in_door, false) then", "$repl$|| case when fi.door_window_at = 'top' then");
    ok(sql !== MIG(), "(the mutant formed: no window test)");
    const db = await fresh();
    const { err } = await apply(db, sql);
    ok(err && /is not the body PART 2 writes/.test(err), "a body other than the one written aborts", err);
  }

  for (const db of opened) await db.close().catch(() => {});
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
