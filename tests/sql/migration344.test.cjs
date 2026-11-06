// Execute migration 344 (get_fixtures sends a door row's own 3D look as `doorLook`) for real in PGlite
// (Postgres compiled to WASM, in memory), on get_fixtures rebuilt exactly as it is live: 289's own
// statement saved with CRLF line endings (the live body has them), 313's PART 6 and 320's PART 2
// splices, the whole of 324 and the whole of 335. The rebuilt body's md5 is checked against the one 335
// recorded live on 2026-10-24, so this test fails the moment it stops being the body 344 will meet.
// 343 is applied first, piece by piece, as live. Then check what the file promises:
//   * every tenant's get_fixtures is byte-for-byte unchanged at apply (no look exists yet);
//   * `doorLook` is sent only for a READY look, only on the listed door rows that use it, with exactly
//     id, v, spec and thumbUrl, and never the look's name, creator, save version, ledger row or photo
//     paths; a draft or archived look, a door without one and an unlisted door send nothing;
//   * a tenant that hides its prices still gets the look; another tenant's call never sees it;
//   * the body is still security definer with an empty search_path;
//   * P0 claims the number once; a re-apply changes nothing; the header's ROLLBACK leaves exactly
//     335's body, and the file applies again after it;
//   * 344 before 343, a drifted live body, and a splice that moves anything else all abort the whole
//     apply (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration344.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/344_get_fixtures_door_look.sql"), "utf8").replace(/\r/g, "");
const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
// get_fixtures' prosrc md5 (carriage returns removed) as 335 wrote it and recorded it live, 2026-10-24.
const LIVE_MD5 = "050771662b98682be0aaa97da8d87d5f";

// The header's piece(), as in migration343.test.cjs.
const piece = (n, text) => {
  const out = [];
  let on = false;
  for (const l of text.split("\n")) {
    if (l === `-- >>> ${n}`) { on = true; continue; }
    if (l === `-- <<< ${n}`) { on = false; continue; }
    if (on && !l.startsWith("--")) out.push(l);
  }
  return out.join("\n");
};
const MIG_343 = read("343_door_looks.sql");
const PIECES_343 = ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7"].map((n) => piece(n, MIG_343));

// 289's create statement, stored WITH CRLF, as live.
const GET_FIXTURES_289 = (() => {
  const t = read("289_door_generator.sql");
  const i = t.indexOf("create or replace function public.get_fixtures(p_client_id text)");
  const j = t.indexOf("\n$$\n;", i);
  if (i < 0 || j < 0) throw new Error("289's get_fixtures statement moved; re-point GET_FIXTURES_289");
  return t.slice(i, j + "\n$$\n;".length).replace(/\n/g, "\r\n");
})();
const doBlock = (file, tag) => {
  const t = read(file);
  const i = t.indexOf(`do $${tag}$`);
  const j = t.indexOf(`$${tag}$;`, i + tag.length + 5);
  if (i < 0 || j < 0) throw new Error(`${file}'s ${tag} block moved; re-point the test`);
  return t.slice(i, j + tag.length + 3);
};
const SPLICE_313 = doBlock("313_interior_walls.sql", "m313_fix");
const SPLICE_320 = doBlock("320_door_window_at.sql", "m320_fix");
const MIG_324 = read("324_window_panes.sql");
const MIG_335 = read("335_window_lites.sql");

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text);
create table public.usage_prices (
  kind text primary key, label text not null, unit_label text not null default 'generation',
  price_cents integer not null check (price_cents >= 0), active boolean not null default false,
  visible boolean not null default true, sort_order integer not null default 0, note text,
  updated_at timestamptz not null default now()
);
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
grant all on all tables in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
${GET_FIXTURES_289}
${SPLICE_313}
${SPLICE_320}
`;

const A = "acme-sheds", B = "bravo-barns", C = "cedar-co";
const DOOR = "00000000-0000-4000-8000-0000000000d1";   // acme, gets the ready look
const DOOR2 = "00000000-0000-4000-8000-0000000000d2";  // acme, same look, another size
const PLAIN = "00000000-0000-4000-8000-0000000000d3";  // acme, a door with no look
const DRAFTED = "00000000-0000-4000-8000-0000000000d4"; // acme, on a draft look
const OLD = "00000000-0000-4000-8000-0000000000d5";    // acme, archived row on the ready look
const FREE = "00000000-0000-4000-8000-0000000000d6";   // acme, unpriced row on the ready look
const WIN = "00000000-0000-4000-8000-0000000000a1";
const CEDAR = "00000000-0000-4000-8000-0000000000c1";  // cedar hides prices
const BDOOR = "00000000-0000-4000-8000-0000000000b1";
const LOOK = "00000000-0000-4000-8000-00000000100a";
const DRAFT = "00000000-0000-4000-8000-00000000100d";
const CLOOK = "00000000-0000-4000-8000-00000000100c";
const SEED = `
insert into public.client_configs (client_id) values ('${A}'), ('${B}'), ('${C}');
insert into public.client_settings (client_id, show_pricing) values ('${A}', true), ('${B}', true), ('${C}', false);
insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, sort_order, door_style, archived, op_double) values
  ('${DOOR}',    '${A}', 'door',   'Barn door',   72, 78, 900, 0, 'zbrace', false, true),
  ('${DOOR2}',   '${A}', 'door',   'Barn door',   60, 78, 800, 1, 'zbrace', false, true),
  ('${PLAIN}',   '${A}', 'door',   'Single door', 36, 78, 400, 2, 'plank',  false, false),
  ('${DRAFTED}', '${A}', 'door',   'Shop door',   36, 80, 450, 3, 'basic',  false, false),
  ('${OLD}',     '${A}', 'door',   'Old door',    72, 78, 700, 4, 'zbrace', true,  true),
  ('${WIN}',     '${A}', 'window', 'Wall window', 24, 36, 120, 0, 'auto',   false, false),
  ('${CEDAR}',   '${C}', 'door',   'Cedar door',  36, 78, 500, 0, 'classic', false, false),
  ('${BDOOR}',   '${B}', 'door',   'Bravo door',  36, 78, 300, 0, 'plank',  false, false);
insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, sort_order, door_style) values
  ('${FREE}',    '${A}', 'door',   'Free door',   72, 78, null, 5, 'zbrace');
`;
const SPEC = { v: 1, base: "zbrace", src: { leaves: 2, hinge: "right" }, brace: { t: "z", from: "hinge" }, hinges: { type: "tstrap", count: 3, lenIn: 16 } };
// Looks and rows that use them, once 343 is in.
const LOOKS = `
insert into public.ai_door_calls (id, client_id, photo_paths) values ('00000000-0000-4000-8000-0000000c0001', '${A}', array['${A}/door-ref-00000000-0000-4000-8000-000000000001.jpg']);
insert into public.door_looks (id, client_id, name, base, spec, status, thumb_url, ai_call_id, created_by, version) values
  ('${LOOK}',  '${A}', 'Our Z barn door', 'zbrace', '${JSON.stringify(SPEC)}'::jsonb, 'ready', 'https://stub.supabase.co/storage/v1/object/public/fixtures/${A}/door-look-1.png', '00000000-0000-4000-8000-0000000c0001', '00000000-0000-4000-8000-0000000000b9', 4),
  ('${DRAFT}', '${A}', 'Shop door draft', 'basic',  '${JSON.stringify({ v: 1, base: "basic", src: { leaves: 1, hinge: "left" } })}'::jsonb, 'draft', null, null, null, 1),
  ('${CLOOK}', '${C}', 'Cedar classic',   'classic', '${JSON.stringify({ v: 1, base: "classic", src: { leaves: 1, hinge: "left" } })}'::jsonb, 'ready', null, null, null, 1);
update public.fixture_items set door_look_id = '${LOOK}' where id in ('${DOOR}', '${DOOR2}', '${OLD}', '${FREE}');
update public.fixture_items set door_look_id = '${DRAFT}' where id = '${DRAFTED}';
update public.fixture_items set door_look_id = '${CLOOK}' where id = '${CEDAR}';
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const opened = [];
async function fresh({ with343 = true } = {}) {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  await db.exec(SEED);
  await db.exec(MIG_324);
  await db.exec(MIG_335);
  if (with343) for (const p of PIECES_343) await db.query(p);
  return db;
}
/** P0, P1, R1 as three calls (the live apply). */
async function apply(db, text = MIG()) {
  try {
    const p0 = (await db.query(piece("P0", text))).rows;
    await db.query(piece("P1", text));
    const rec = (await db.query(piece("R1", text))).rows[0];
    return { err: null, p0, rec };
  } catch (e) { return { err: e.message }; }
}
const fixOf = async (db, c) => (await one(db, "select public.get_fixtures($1) j", [c])).j;
const lfMd5 = async (db) => (await one(db, "select md5(replace(prosrc, chr(13), '')) m from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure")).m;
const defOf = async (db) => (await one(db, "select pg_get_functiondef('public.get_fixtures(text)'::regprocedure) d")).d;
const TENANTS = [A, B, C];
const ROLLBACK = () => {
  const t = MIG();
  const i = t.indexOf("--   do $rb$");
  const j = t.indexOf("--   end $rb$;", i);
  if (i < 0 || j < 0) throw new Error("the ROLLBACK block in 344's header moved; re-point the test");
  return t.slice(i, j + "--   end $rb$;".length).split("\n").map((l) => l.replace(/^--   ?/, "")).join("\n");
};
const writtenMd5 = () => /if md5\(v_src\) <> '([0-9a-f]{32})' then\n    raise exception '344: get_fixtures is not the body this splice writes/.exec(MIG())?.[1];

(async () => {
  console.log("the stand-in for the live get_fixtures");
  {
    const db = await fresh();
    ok(await lfMd5(db) === LIVE_MD5, "289 + 313 + 320 + 324 + 335 is the body 335 recorded live on 2026-10-24", await lfMd5(db));
    ok(MIG().includes(`piece() { awk -v n="$1" '{sub(/\\r$/,"")} $0=="-- >>> "n{on=1;next}`), "the header's piece() drops carriage returns (a Windows checkout) before it matches a marker");
    for (const n of ["P0", "P1", "R1"]) {
      const p = piece(n, MIG());
      ok(p.trim() && !/^\s*--/.test(p) && Buffer.byteLength(p) < 30 * 1024, `${n}: cut cleanly, no leading comment, under 30 KB (${Buffer.byteLength(p)} bytes)`);
    }
  }

  console.log("migration 344: applies on the live shape");
  {
    const db = await fresh();
    const before = {};
    for (const c of TENANTS) before[c] = JSON.stringify(await fixOf(db, c));
    const bodyBefore = await defOf(db);
    const { err, p0, rec } = await apply(db);
    ok(err === null, "344 applied cleanly, its checks included", err);
    if (err) { console.log("    (written body md5 " + (await lfMd5(db)) + ")"); }
    ok(p0 && p0.length === 1 && p0[0].version === "344", "P0 claims 344");
    ok(rec && rec.fixtures_send_it === true && Number(rec.tenants) === 3 && Number(rec.ready_looks) === 0 && Number(rec.doors_with_a_look) === 0
      && rec.body_md5 === writtenMd5(), "THE RECORD reads true, 3, 0, 0, <the md5 P1 checks>", JSON.stringify(rec));
    for (const c of TENANTS) ok(JSON.stringify(await fixOf(db, c)) === before[c], `${c}: get_fixtures is byte-for-byte unchanged`);
    const after = await defOf(db);
    ok(after.split("jsonb_build_object('doorLook'").length === 2, "the doorLook merge is in the body once");
    ok(after.split("|| case when fi.category = 'window' and coalesce(fi.in_door, false)").length === 2, "289's inDoor merge is still there exactly once, for the next splice");
    ok(after.split("jsonb_build_object('liteRows'").length === 2, "335's lites merge is still there exactly once");
    const sec = await one(db, "select prosecdef, proconfig from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure");
    ok(sec.prosecdef === true && JSON.stringify(sec.proconfig) === JSON.stringify(['search_path=""']), "still security definer, search_path ''", JSON.stringify(sec));
    console.log("    (written body md5 " + (await lfMd5(db)) + ")");

    console.log("get_fixtures: the look, sparse, ready only");
    await db.exec(LOOKS);
    const items = (await fixOf(db, A)).items;
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    ok(byId[DOOR].doorLook && byId[DOOR].doorLook.id === LOOK && byId[DOOR].doorLook.v === 1, "the barn door carries its look", JSON.stringify(byId[DOOR]));
    ok(JSON.stringify(byId[DOOR].doorLook.spec) === JSON.stringify(await one(db, `select spec from public.door_looks where id = '${LOOK}'`).then((r) => r.spec)), "...the cleaned spec exactly as stored");
    ok(byId[DOOR].doorLook.thumbUrl === `https://stub.supabase.co/storage/v1/object/public/fixtures/${A}/door-look-1.png`, "...and our render as its tile");
    ok(JSON.stringify(Object.keys(byId[DOOR].doorLook).sort()) === JSON.stringify(["id", "spec", "thumbUrl", "v"]), "...with exactly id, v, spec, thumbUrl", JSON.stringify(Object.keys(byId[DOOR].doorLook)));
    const text = JSON.stringify(items);
    for (const priv of ["Our Z barn door", "door-ref-", "00000000-0000-4000-8000-0000000c0001", "00000000-0000-4000-8000-0000000000b9", "photo_paths", "aiCallId", "createdBy"]) {
      ok(!text.includes(priv), `nothing private reaches the shopper: ${priv}`);
    }
    ok(byId[DOOR].doorStyle === "zbrace", "the row still sends its base as doorStyle (what an older designer draws)");
    ok(byId[DOOR2].doorLook && byId[DOOR2].doorLook.id === LOOK, "the other size of the same door carries it too");
    ok(!("doorLook" in byId[PLAIN]), "a door with no look carries nothing new");
    ok(!("doorLook" in byId[DRAFTED]), "a door on a DRAFT look carries nothing (Save comes first)");
    ok(!("doorLook" in byId[WIN]), "a window carries nothing");
    ok(!byId[OLD] && !byId[FREE], "an archived or unpriced door is not listed at all");
    const cedar = (await fixOf(db, C)).items;
    ok(cedar.length === 1 && cedar[0].doorLook && cedar[0].doorLook.id === CLOOK && !("price" in cedar[0]), "a tenant that hides prices still gets its look (and no price)", JSON.stringify(cedar));
    ok(!JSON.stringify(await fixOf(db, B)).includes("doorLook"), "another builder's get_fixtures never sees a look");
    ok(JSON.stringify(await fixOf(db, B)) === before[B], "...and bravo's output is unchanged");
    const strip = (j) => JSON.stringify({ ...j, items: j.items.map(({ doorLook: _l, ...r }) => r) });
    ok(strip(await fixOf(db, A)) === before[A], "acme: nothing but doorLook moved");
    await db.exec(`update public.door_looks set status = 'archived' where id = '${CLOOK}'`);
    ok(!JSON.stringify(await fixOf(db, C)).includes("doorLook"), "archiving a look takes it off its rows at once");

    console.log("re-apply and rollback");
    const def = await defOf(db);
    const re = await apply(db);
    ok(re.err === null && re.p0.length === 0, "a second apply claims nothing and goes through with looks on file, its checks included", re.err);
    ok(re.rec && Number(re.rec.ready_looks) === 1 && Number(re.rec.doors_with_a_look) === 5, "...THE RECORD counts them", JSON.stringify(re.rec));
    ok(await defOf(db) === def, "...and splices nothing twice");
    try { await db.exec(ROLLBACK()); ok(true, "the header's ROLLBACK runs"); }
    catch (e) { ok(false, "the header's ROLLBACK runs", e.message); }
    ok(!(await defOf(db)).includes("doorLook"), "...takes the merge back out");
    ok(await lfMd5(db) === LIVE_MD5, "...leaving exactly the body it found (335's)");
    ok(await defOf(db) === bodyBefore, "...byte for byte, carriage returns included");
    await db.exec("delete from supabase_migrations.schema_migrations where version = '344'");
    const again = await apply(db);
    ok(again.err === null && again.p0.length === 1, "344 applies again after a rollback, with looks on file", again.err);
  }

  console.log("migration 344: refused before 343");
  {
    const db = await fresh({ with343: false });
    const { err } = await apply(db);
    ok(err && /apply 343_door_looks first/.test(err), "the splice refuses to run without door_looks", err);
    ok(await lfMd5(db) === LIVE_MD5, "...and get_fixtures is untouched");
  }

  console.log("migration 344: a drifted body or a wider splice aborts the whole apply (mutants)");
  {
    const db = await fresh();
    await db.exec(`do $d$ declare s text := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
      begin execute replace(s, $k$'sortOrder', fi.sort_order)$k$, $k$'sortOrder', fi.sort_order, 'x', 1)$k$); end $d$;`);
    ok(await lfMd5(db) !== LIVE_MD5, "(the mutant formed: get_fixtures changed by someone else since)");
    const { err } = await apply(db);
    ok(err && /is not the body this splice was derived from/.test(err), "a drifted live body aborts", err);
    ok(!(await defOf(db)).includes("doorLook"), "...and nothing is spliced");
  }
  {
    // A merge that sends a look whatever its status: the body check refuses it, and with the body
    // check off the per-tenant checks must refuse it on their own.
    const wide = MIG().replace("and dl.status = 'ready'), '{}'::jsonb) else '{}'::jsonb end$look$;", "), '{}'::jsonb) else '{}'::jsonb end$look$;");
    ok(wide !== MIG(), "(the mutant formed: draft and archived looks sent too)");
    let db = await fresh();
    let r = await apply(db, wide);
    ok(r.err && /is not the body this splice writes/.test(r.err), "a splice that moves anything else aborts the apply", r.err);
    ok(!(await defOf(db)).includes("doorLook"), "...and nothing of it survives (one do block)");
    // With looks on file before the splice, and the body check off, check 4 refuses it on its own.
    const noBody = wide.replace(/if md5\(v_src\) <> '[0-9a-f]{32}' then\n    raise exception '344: get_fixtures is not the body this splice writes/, "if false then\n    raise exception '344: get_fixtures is not the body this splice writes");
    ok(/if false then/.test(noBody), "(the mutant formed: the wider splice, body check off)");
    db = await fresh();
    await db.exec(LOOKS);
    r = await apply(db, noBody);
    ok(r.err && /(sends doorLook as|changed for \d+ tenant)/.test(r.err), "...the per-tenant checks refuse it on their own", r.err);
    ok(!(await defOf(db)).includes("doorLook"), "...and nothing of it survives");
  }

  for (const db of opened) await db.close().catch(() => {});
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
