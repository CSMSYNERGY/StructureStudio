// Execute migration 289 (the door generator) for real in PGlite (Postgres compiled to WASM, in
// memory) on top of fixture_items as it is live (064 onward, with 187's door_style check and 272's
// style_ids) and get_fixtures created from 272's own statement (the live body, byte for byte), then
// check what it promises:
//   PART 1  the door_style check takes the four new looks and still refuses an unknown one;
//   PART 2  in_door is boolean not null default false, every existing row reads false, and only a
//           WINDOW can be ticked (a door, ramp or vent with it is refused);
//   PART 3  get_fixtures is replaced only when it is the body PART 3 was derived from, every
//           tenant's catalog is byte-for-byte unchanged by the apply, `inDoor: true` is sent for a
//           ticked window and for nothing else, and the four looks reach the designer as doorStyle;
//   and a re-apply that changes nothing, the rollback restoring the old body, and assertions that
//   really abort the whole apply (mutants). Nothing here touches the live project: no network.
//
// Tenants, styles and fixtures are made up. The repo is public: no real client id belongs here.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration289.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
// LF, whatever the checkout: the mutants below splice LF-only text. The migration strips \r itself.
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/289_door_generator.sql"), "utf8").replace(/\r/g, "");

// get_fixtures as it is live: 272's own create statement. Dumped READ-ONLY 2026-10-07, the live
// prosrc has md5 276d22b7c1a3d60ebe7c5d6e58373de6, which is exactly 272's body, so the stub must BE
// that statement or the apply refuses it, which the first check pins.
const GET_FIXTURES_272 = (() => {
  const t = fs.readFileSync(path.join(WT, "supabase/migrations/272_builder_options.sql"), "utf8").replace(/\r/g, "");
  const i = t.indexOf("create or replace function public.get_fixtures(p_client_id text)");
  const j = t.indexOf("\n$$\n;", i);
  if (i < 0 || j < 0) throw new Error("272's get_fixtures statement moved; re-point GET_FIXTURES_272");
  return t.slice(i, j + "\n$$\n;".length);
})();
const LIVE_BODY_MD5 = "276d22b7c1a3d60ebe7c5d6e58373de6";   // prosrc, as dumped on 2026-10-07
const NEW_BODY_MD5 = "c23b2e457c56312b84866937ad982fac";    // the body PART 3 writes (its own pin)
const NINE = "CHECK ((door_style = ANY (ARRAY['auto'::text, 'plank'::text, 'zbrace'::text, 'xbrace'::text, 'rollup'::text, 'american'::text, 'basic'::text, 'classic'::text, 'dutch'::text])))";
const FIVE = "CHECK ((door_style = ANY (ARRAY['auto'::text, 'plank'::text, 'zbrace'::text, 'xbrace'::text, 'rollup'::text])))";
const WINDOWS_ONLY = "CHECK (((NOT in_door) OR (category = 'window'::text)))";

// What get_fixtures reads, as it is live: fixture_items with every column (064 through 272) and
// 187's named door_style check, colors and window_colors cut to the columns it names,
// building_styles with sort_order, client_configs and client_settings' pricing and ramp columns.
const STUBS = (extra = "") => `
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
  door_style text not null default 'auto',
  style_ids uuid[]
);
alter table public.fixture_items add constraint fixture_items_door_style_chk
  check (door_style in ('auto', 'plank', 'zbrace', 'xbrace', 'rollup'));
${GET_FIXTURES_272}
${extra}
`;

// Fixed ids so "nothing moved" can compare whole rows, updated_at included.
const DOOR = "00000000-0000-4000-8000-0000000000d1";
const LITE = "00000000-0000-4000-8000-0000000000a1";
const PICTURE = "00000000-0000-4000-8000-0000000000a2";
const VENT = "00000000-0000-4000-8000-0000000000e1";
const RAMP = "00000000-0000-4000-8000-0000000000e2";
const SEED = `
insert into public.client_configs (client_id) values ('acme-sheds'), ('bravo-barns');
insert into public.client_settings (client_id, show_pricing) values ('acme-sheds', true), ('bravo-barns', false);
insert into public.building_styles (id, client_id, key, label) values
  ('00000000-0000-4000-8000-000000000001', 'acme-sheds', 'deluxe', 'Deluxe');
insert into public.window_colors (id, client_id, label, hex, is_default, rate) values
  ('00000000-0000-4000-8000-0000000000c1', 'acme-sheds', 'White', '#FFFFFF', true, 0);
-- acme-sheds: a barn door in board-and-batten, a small window and a picture window, a vent, a ramp,
-- an archived window and an unpriced one (neither is sent). bravo-barns: one door, one window.
insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, sort_order, door_style, op_double, window_color_ids, sill_in, archived, updated_at) values
  ('${DOOR}',    'acme-sheds',  'door',   'Barn door',       60, 80, 800, 0, 'plank', true,  null, null, false, '2026-09-20 10:00+00'),
  ('${LITE}',    'acme-sheds',  'window', 'Door lite',       18, 24, 95,  0, 'auto',  false, '{00000000-0000-4000-8000-0000000000c1}', null, false, '2026-09-20 10:00+00'),
  ('${PICTURE}', 'acme-sheds',  'window', 'Picture window',  48, 36, 220, 1, 'auto',  false, null, 42, false, '2026-09-20 10:00+00'),
  ('${VENT}',    'acme-sheds',  'vent',   'Standard vent',   12, 8,  0,   0, 'auto',  false, null, null, false, '2026-09-20 10:00+00'),
  ('${RAMP}',    'acme-sheds',  'ramp',   'Wood ramp',       72, 24, 120, 0, 'auto',  false, null, null, false, '2026-09-20 10:00+00'),
  ('00000000-0000-4000-8000-0000000000f1', 'acme-sheds',  'window', 'Old window', 24, 36, 90, 2, 'auto', false, null, null, true, '2026-09-20 10:00+00'),
  ('00000000-0000-4000-8000-0000000000f2', 'acme-sheds',  'window', 'Unpriced window', 24, 36, null, 3, 'auto', false, null, null, false, '2026-09-20 10:00+00'),
  ('00000000-0000-4000-8000-0000000000f3', 'bravo-barns', 'door',   'Single door', 36, 76, 400, 0, 'auto', false, null, null, false, '2026-09-20 10:00+00'),
  ('00000000-0000-4000-8000-0000000000f4', 'bravo-barns', 'window', 'Slider', 36, 24, 150, 0, 'auto', false, null, null, false, '2026-09-20 10:00+00');
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;
async function fresh(extra) {
  const db = new PGlite();
  await db.exec(STUBS(extra));
  await db.exec(SEED);
  return db;
}
const bodyMd5 = async (db) => (await one(db,
  "select md5(replace(prosrc, E'\\r', '')) h from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure")).h;
const catalogs = async (db) => JSON.stringify(await rows(db,
  `select client_id, md5(public.get_fixtures(client_id)::text) h from public.client_configs order by client_id`));
const fixSnapshot = async (db) => JSON.stringify(await rows(db, `select * from public.fixture_items order by id`));
const itemsOf = async (db, client) => (await one(db, "select public.get_fixtures($1) j", [client])).j.items;
const itemNamed = async (db, client, name) => (await itemsOf(db, client)).find((i) => i.name === name);
const checkDef = async (db, name) => {
  const r = await one(db, `select pg_get_constraintdef(oid) def from pg_constraint where conname = $1 and conrelid = 'public.fixture_items'::regclass`, [name]);
  return r ? r.def : null;
};
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
// Every assertion of PART 3A a mutant has to get past to reach the one under test.
const dropPostMd5 = (sql) => sql.replace(/  if md5\(v_src\) <> '[0-9a-f]{32}' then\n    raise exception '289: get_fixtures is not the body PART 3 writes[^\n]*\n  end if;\n/, "");

(async () => {
  console.log("migration 289: applies on the live shape and moves nothing");
  {
    const db = await fresh();
    ok(await bodyMd5(db) === LIVE_BODY_MD5, "the stub get_fixtures IS the live body (272's statement, prosrc md5 as dumped)", await bodyMd5(db));
    ok(await checkDef(db, "fixture_items_door_style_chk") === FIVE, "before: 187's five looks");
    const before = await catalogs(db);
    const rowsBefore = await fixSnapshot(db);
    const acmeBefore = await itemsOf(db, "acme-sheds");
    ok(acmeBefore.length === 5 && !acmeBefore.some((i) => "inDoor" in i), "before: acme's five offered fixtures, none with inDoor", JSON.stringify(acmeBefore.map((i) => i.name)));
    let applied = true;
    try { await db.exec(MIG()); } catch (e) { applied = false; ok(false, "289 applied", e.message); }
    ok(applied, "289 applied, its assertions and probe included");

    ok(await checkDef(db, "fixture_items_door_style_chk") === NINE, "PART 1: the door_style check carries the nine looks", await checkDef(db, "fixture_items_door_style_chk"));
    const col = await one(db, `select data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'fixture_items' and column_name = 'in_door'`);
    ok(!!col && col.data_type === "boolean" && col.is_nullable === "NO" && col.column_default === "false",
      "PART 2: fixture_items.in_door is boolean not null default false", JSON.stringify(col));
    ok(await checkDef(db, "fixture_items_in_door_window_chk") === WINDOWS_ONLY, "PART 2: ...with the windows-only check", await checkDef(db, "fixture_items_in_door_window_chk"));
    const rowsAfter = JSON.parse(await fixSnapshot(db));
    ok(rowsAfter.every((r) => r.in_door === false) && JSON.stringify(rowsAfter.map(({ in_door: _d, ...r }) => r)) === rowsBefore,
      "every fixture row is untouched, updated_at included, and reads in_door false (and the probe left nothing)");
    ok(await bodyMd5(db) === NEW_BODY_MD5, "PART 3: get_fixtures is the body PART 3 writes (the pin in the file matches)", await bodyMd5(db));
    ok(await catalogs(db) === before, "PART 3: every tenant's get_fixtures is byte-for-byte unchanged by the apply");
    const tmp = await one(db, "select to_regclass('pg_temp.m289_fixtures_before') t");
    ok(tmp.t === null, "the before-snapshot table is gone with the commit");

    // ── What the builder does after it ──
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const plain = (i) => { const { inDoor: _k, ...rest } = i; return rest; };
    await db.exec("begin");
    await db.exec(`update public.fixture_items set in_door = true where id = '${LITE}'`);
    const lite = await itemNamed(db, "acme-sheds", "Door lite");
    ok(lite.inDoor === true, "a window ticked in_door carries inDoor: true", JSON.stringify(lite));
    ok(same(plain(lite), acmeBefore.find((i) => i.name === "Door lite")), "...and every other key of it (colour list, sill, price) is what it was");
    ok(!("inDoor" in (await itemNamed(db, "acme-sheds", "Picture window"))), "a window not ticked carries no inDoor key at all");
    for (const look of ["american", "basic", "classic", "dutch"]) {
      await db.exec(`update public.fixture_items set door_style = '${look}' where id = '${DOOR}'`);
      const d = await itemNamed(db, "acme-sheds", "Barn door");
      ok(d.doorStyle === look && d.opDouble === true && !("inDoor" in d), `a door in the ${look} look saves and reaches the designer as doorStyle "${look}", a double by its opDouble`, JSON.stringify(d));
    }
    ok(await checkRefusal(db, `update public.fixture_items set door_style = 'gothic' where id = '${DOOR}'`) === "fixture_items_door_style_chk", "an unknown look is still refused");
    for (const id of [DOOR, VENT, RAMP]) {
      ok(await checkRefusal(db, `update public.fixture_items set in_door = true where id = '${id}'`) === "fixture_items_in_door_window_chk", `in_door on a non-window (${id.slice(-2)}) is refused`);
    }
    ok(await checkRefusal(db, `update public.fixture_items set in_door = null where id = '${LITE}'`) !== null, "in_door cannot be NULL");
    await db.exec(`update public.fixture_items set in_door = true, archived = true where id = '${PICTURE}'`);
    ok(!(await itemNamed(db, "acme-sheds", "Picture window")), "an archived window ticked for doors is not sent at all (get_fixtures' own rule)");
    const bravo = await itemsOf(db, "bravo-barns");
    ok(bravo.length === 2 && bravo.every((i) => !("inDoor" in i)), "another tenant's catalog is untouched by it", JSON.stringify(bravo));
    await db.exec("rollback");

    // ── Re-apply: a no-op, also with a ticked window and a door in a new look saved ──
    await db.exec(`update public.fixture_items set in_door = true where id = '${LITE}'`);
    await db.exec(`update public.fixture_items set door_style = 'classic' where id = '${DOOR}'`);
    const withTick = await catalogs(db);
    const rowsTick = await fixSnapshot(db);
    let again = true;
    try { await db.exec(MIG()); } catch (e) { again = false; ok(false, "re-apply with a ticked window", e.message); }
    ok(again && await catalogs(db) === withTick && await fixSnapshot(db) === rowsTick && await bodyMd5(db) === NEW_BODY_MD5,
      "a re-apply with a ticked window and a Classic door saved passes and changes nothing");

    // ── Rollback as the file writes it: 272's body back first, then the column, then the looks ──
    await db.exec(GET_FIXTURES_272);
    ok(await bodyMd5(db) === LIVE_BODY_MD5, "rollback: re-issuing 272's statement restores the live body");
    await db.exec(`update public.fixture_items set door_style = 'auto' where door_style in ('american', 'basic', 'classic', 'dutch');
      update public.fixture_items set in_door = false;
      update public.fixture_items set door_style = 'plank' where id = '${DOOR}';`);
    await db.exec(`begin;
      alter table public.fixture_items drop constraint if exists fixture_items_in_door_window_chk;
      alter table public.fixture_items drop column if exists in_door;
      alter table public.fixture_items drop constraint if exists fixture_items_door_style_chk;
      alter table public.fixture_items add constraint fixture_items_door_style_chk check (door_style in ('auto', 'plank', 'zbrace', 'xbrace', 'rollup'));
      commit;`);
    ok(await catalogs(db) === before && await checkDef(db, "fixture_items_door_style_chk") === FIVE, "rollback: every tenant's get_fixtures and the five-look check are what they were before 289");
    await db.close();
  }

  console.log("migration 289: the assertions abort the whole migration");
  {
    // Another change replaced get_fixtures after PART 3 was derived: a body PART 3 does not know.
    const drifted = GET_FIXTURES_272.replace("    order by fi.category, fi.sort_order, fi.name)", "    order by fi.category, fi.name, fi.sort_order)");
    const db = await fresh(drifted);
    ok(drifted !== GET_FIXTURES_272 && await bodyMd5(db) !== LIVE_BODY_MD5, "the stub really drifted");
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /289: the LIVE get_fixtures \(prosrc md5 [0-9a-f]{32}\) is neither the body PART 3 was derived from/.test(err.message),
      "a get_fixtures some other change replaced stops the apply, rather than being reverted", err && err.message);
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const col = await one(db, `select count(*)::int n from information_schema.columns where table_name = 'fixture_items' and column_name = 'in_door'`);
    ok(col.n === 0 && await checkDef(db, "fixture_items_door_style_chk") === FIVE,
      "and nothing of the apply is left: no in_door column, 187's five looks back", JSON.stringify({ col, def: await checkDef(db, "fixture_items_door_style_chk") }));
    await db.close();
  }
  {
    // 272 never applied: no styleKeys merge in the live body.
    const no272 = GET_FIXTURES_272.replace(/    \|\| case when fi\.style_ids is not null\n[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/, "");
    const db = await fresh(no272);
    ok(no272 !== GET_FIXTURES_272 && !no272.includes("styleKeys"), "the stub really lost styleKeys");
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /289: the LIVE get_fixtures has no styleKeys merge \(272\)/.test(err.message), "a body without 272's styleKeys stops the apply, naming it", err && err.message);
    await db.close();
  }
  {
    // A copy whose merge lost the in_door test, so every window says inDoor: the body pin catches it...
    const leaky = MIG().replace("case when fi.category = 'window' and coalesce(fi.in_door, false)", "case when fi.category = 'window'");
    ok(leaky !== MIG(), "the mutant really lost the in_door test");
    let db = await fresh();
    let err = null;
    try { await db.exec(leaky); } catch (e) { err = e; }
    ok(!!err && /289: get_fixtures is not the body PART 3 writes/.test(err.message), "a body that is not the pinned one stops the apply", err && err.message);
    await db.close();
    // ...and with the pin gone too, the catalogs-unchanged check catches the window that now says inDoor.
    db = await fresh();
    err = null;
    try { await db.exec(dropPostMd5(leaky)); } catch (e) { err = e; }
    ok(!!err && /289: get_fixtures changed for 2 tenant\(s\)/.test(err.message),
      "with the pin gone, the every-catalog-unchanged check catches a merge that marks every window (both tenants have one)", err && err.message);
    await db.close();
  }
  {
    // ...and with that check gone as well, the rolled-back probe still catches it: its unticked
    // window comes back from get_fixtures carrying inDoor.
    const leaky = MIG().replace("case when fi.category = 'window' and coalesce(fi.in_door, false)", "case when fi.category = 'window'");
    const noUnchanged = dropPostMd5(leaky).replace(/  select count\(\*\) into v_changed from m289_fixtures_before b\n[^\n]*\n  if v_changed > 0 then\n[^\n]*\n  end if;\n/, "");
    ok(noUnchanged !== dropPostMd5(leaky), "the mutant really lost the catalogs-unchanged check");
    const db = await fresh();
    let err = null;
    try { await db.exec(noUnchanged); } catch (e) { err = e; }
    ok(!!err && /289: a window not ticked in_door must carry no inDoor/.test(err.message), "the probe alone catches a merge that marks every window", err && err.message);
    await db.close();
  }
  {
    // A copy that forgot the windows-only check: the definition assertion catches it.
    const unchecked = MIG().replace(/do \$m289_indoor\$[\s\S]*?\$m289_indoor\$;\n/, "");
    ok(unchecked !== MIG(), "the mutant really lost the windows-only check");
    const db = await fresh();
    let err = null;
    try { await db.exec(unchecked); } catch (e) { err = e; }
    ok(!!err && /289: fixture_items_in_door_window_chk is not windows-only: missing/.test(err.message), "a missing windows-only check stops the apply", err && err.message);
    await db.close();
  }
  {
    // A copy that widened the looks by only three: the definition assertion catches it.
    const short = MIG().replace("'american', 'basic', 'classic', 'dutch'));\nend\n$m289_style$;", "'american', 'basic', 'classic'));\nend\n$m289_style$;");
    ok(short !== MIG(), "the mutant really lost a look");
    const db = await fresh();
    let err = null;
    try { await db.exec(short); } catch (e) { err = e; }
    ok(!!err && /289: fixture_items_door_style_chk is not the nine looks/.test(err.message), "a check missing a look stops the apply", err && err.message);
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  // exitCode, not process.exit(), for migration272.test.cjs's reason: an exit() on Windows can land
  // while libuv is still closing a PGlite handle and abort with UV_HANDLE_CLOSING (exit 127) after
  // every check passed. Every db above is closed, so the process ends by itself.
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
