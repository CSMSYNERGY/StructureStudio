// Execute migration 345 (a door made from a photo goes into the builder's library) for real in PGlite
// (Postgres compiled to WASM, in memory), on get_fixtures rebuilt exactly as it is live (the same build as
// migration344.test.cjs: 289's statement with CRLF, 313's and 320's splices, 324, 335), with 339 (the
// library), 343 (door looks) and 344 (get_fixtures sends a door row's own look) applied first, piece by
// piece, as live. Then check what the file promises:
//   * every tenant's get_fixtures is byte-for-byte unchanged at apply (no entry names a look yet);
//   * library_look_ok takes { doorStyle: <one of the seven bases>, doorLookId: <uuid> } for doors only,
//     every look 339 took still passes, and a StructureStudio template can never name a look;
//   * an entry that names a look: the same builder's, READY, on the entry's base; fixed once made
//     (rename only); an entry never gains one; a look an entry names can't be archived or rebased;
//   * a door row linked to such an entry takes its base (339's write-through) and get_fixtures sends
//     that look as doorLook, exactly as for a row with door_look_id; another tenant never sees it;
//   * one look per door row: setting one clears the other, and the CHECK holds even with the trigger off;
//   * P0 claims the number once; a re-apply changes nothing; the header's rollback leaves 344's body;
//   * a drifted live body, and P2 before P1, abort with nothing changed (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration345.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");
const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
const MIG = () => (process.env.MIG_FILE ? fs.readFileSync(process.env.MIG_FILE, "utf8").replace(/\r/g, "") : read("345_library_door_looks.sql"));
// get_fixtures' prosrc md5 (carriage returns removed): 335's live body, and 344's written one.
const LIVE_MD5 = "050771662b98682be0aaa97da8d87d5f";
const MD5_344 = "c7ef0626e645b725f5e16673002ee8a5";
// The header's piece().
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
const PIECES_339 = ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7"].map((n) => piece(n, read("339_library.sql")));
const PIECES_343 = ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7"].map((n) => piece(n, read("343_door_looks.sql")));
const PIECES_344 = ["P0", "P1"].map((n) => piece(n, read("344_get_fixtures_door_look.sql")));
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
create table public.style_cladding (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  style_id uuid not null references public.building_styles (id) on delete cascade,
  cladding_id text not null check (cladding_id in ('panel', 'lap', 'batten', 'agpanel', 'vinyl')),
  label_override text, rate numeric,
  exposure_in numeric check (exposure_in is null or (cladding_id = 'lap' and exposure_in between 3 and 12)),
  active boolean not null default true, sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (client_id, style_id, cladding_id)
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
  updated_at timestamptz not null default now(),
  constraint fixture_items_in_door_window_chk check (not in_door or category = 'window'),
  constraint fixture_items_door_window_at_chk check (door_window_at in ('panel', 'top')),
  constraint fixture_items_door_window_top_chk check (door_window_at = 'panel' or (category = 'window' and in_door))
);
grant all on all tables in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
${GET_FIXTURES_289}
${doBlock("313_interior_walls.sql", "m313_fix")}
${doBlock("320_door_window_at.sql", "m320_fix")}
`;

const A = "acme-sheds", B = "bravo-barns", C = "cedar-co";
const DOOR = "00000000-0000-4000-8000-0000000000d1";   // acme, on the ready look itself (door_look_id)
const PLAIN = "00000000-0000-4000-8000-0000000000d3";  // acme, a plank door; gets the library entry
const SLAB = "00000000-0000-4000-8000-0000000000d7";   // acme, a basic door; stays as it is
const WIN = "00000000-0000-4000-8000-0000000000a1";
const CEDAR = "00000000-0000-4000-8000-0000000000c1";
const BDOOR = "00000000-0000-4000-8000-0000000000b1";
const LOOK = "00000000-0000-4000-8000-00000000100a";   // acme, ready, zbrace
const DRAFT = "00000000-0000-4000-8000-00000000100d";  // acme, draft, basic
const CLOOK = "00000000-0000-4000-8000-00000000100c";  // cedar, ready, classic
const SEED = `
insert into public.client_configs (client_id) values ('${A}'), ('${B}'), ('${C}');
insert into public.client_settings (client_id, show_pricing) values ('${A}', true), ('${B}', true), ('${C}', false);
insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, sort_order, door_style, op_double) values
  ('${DOOR}',  '${A}', 'door',   'Barn door',   72, 78, 900, 0, 'zbrace', true),
  ('${PLAIN}', '${A}', 'door',   'Single door', 36, 78, 400, 1, 'plank',  false),
  ('${SLAB}',  '${A}', 'door',   'Shop door',   36, 80, 450, 2, 'basic',  false),
  ('${WIN}',   '${A}', 'window', 'Wall window', 24, 36, 120, 0, 'auto',   false),
  ('${CEDAR}', '${C}', 'door',   'Cedar door',  36, 78, 500, 0, 'classic', false),
  ('${BDOOR}', '${B}', 'door',   'Bravo door',  36, 78, 300, 0, 'plank',  false);
`;
const SPEC = { v: 1, base: "zbrace", src: { leaves: 1, hinge: "left" }, brace: { t: "z", from: "hinge" }, hinges: { type: "tstrap", count: 3, lenIn: 16 } };
const LOOKS = `
insert into public.door_looks (id, client_id, name, base, spec, status, thumb_url, version) values
  ('${LOOK}',  '${A}', 'Our Z barn door', 'zbrace', '${JSON.stringify(SPEC)}'::jsonb, 'ready', 'https://stub.supabase.co/storage/v1/object/public/fixtures/${A}/door-look-1.png', 2),
  ('${DRAFT}', '${A}', 'Shop door draft', 'basic',  '${JSON.stringify({ v: 1, base: "basic", src: { leaves: 1, hinge: "left" } })}'::jsonb, 'draft', null, 1),
  ('${CLOOK}', '${C}', 'Cedar classic',   'classic', '${JSON.stringify({ v: 1, base: "classic", src: { leaves: 1, hinge: "left" } })}'::jsonb, 'ready', null, 1);
update public.fixture_items set door_look_id = '${LOOK}' where id = '${DOOR}';
`;
// jsonb stores keys in its own order: compare specs key-order-free.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const entryLook = (style, id) => JSON.stringify({ doorStyle: style, doorLookId: id });

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const refused = async (db, sql, re) => {
  try { await db.exec(sql); return null; } catch (e) { return re.test(e.message) ? e.message : "WRONG: " + e.message; }
};
const opened = [];
async function fresh() {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  await db.exec(SEED);
  await db.exec(read("324_window_panes.sql"));
  await db.exec(read("335_window_lites.sql"));
  for (const p of PIECES_339) await db.query(p);
  for (const p of PIECES_343) await db.query(p);
  for (const p of PIECES_344) await db.query(p);
  return db;
}
/** P0, P1, R1, P2, R2 as five calls (the live apply). */
async function apply(db, text = MIG()) {
  try {
    const p0 = (await db.query(piece("P0", text))).rows;
    await db.query(piece("P1", text));
    const r1 = (await db.query(piece("R1", text))).rows[0];
    await db.query(piece("P2", text));
    const r2 = (await db.query(piece("R2", text))).rows[0];
    return { err: null, p0, r1, r2 };
  } catch (e) { return { err: e.message }; }
}
const fixOf = async (db, c) => (await one(db, "select public.get_fixtures($1) j", [c])).j;
const lfMd5 = async (db) => (await one(db, "select md5(replace(prosrc, chr(13), '')) m from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure")).m;
const defOf = async (db) => (await one(db, "select pg_get_functiondef('public.get_fixtures(text)'::regprocedure) d")).d;
const TENANTS = [A, B, C];
const writtenMd5 = () => /if md5\(v_src\) <> '([0-9a-f]{32})' then\n    raise exception '345: get_fixtures is not the body this splice writes/.exec(MIG())?.[1];
const blk = (tag) => {
  const m = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`).exec(MIG());
  if (!m) throw new Error(`345's ${tag} block moved; re-point the test`);
  return m[1];
};
const item = async (db, c, id) => ((await fixOf(db, c)).items || []).find((i) => i.id === id) || null;

(async () => {
  console.log("the stand-in for the live database");
  {
    const db = await fresh();
    ok(await lfMd5(db) === MD5_344, "289 + 313 + 320 + 324 + 335 + 344 is the body 345 is derived from", await lfMd5(db));
    for (const n of ["P0", "P1", "R1", "P2", "R2"]) {
      const p = piece(n, MIG());
      ok(p.trim() && !/^\s*--/.test(p) && Buffer.byteLength(p) < 30 * 1024, `${n}: cut cleanly, no leading comment, under 30 KB (${Buffer.byteLength(p)} bytes)`);
    }
  }

  console.log("migration 345: applies on the live shape");
  const db = await fresh();
  {
    const before = {};
    for (const c of TENANTS) before[c] = JSON.stringify(await fixOf(db, c));
    await db.exec(LOOKS);
    const beforeLooks = {};
    for (const c of TENANTS) beforeLooks[c] = JSON.stringify(await fixOf(db, c));
    const { err, p0, r1, r2 } = await apply(db);
    ok(err === null, "345 applied cleanly, its checks included", err);
    if (err) console.log("    (written body md5 " + (await lfMd5(db)) + ")");
    ok(p0 && p0.length === 1 && p0[0].version === "345", "P0 claims 345");
    ok(r1 && r1.entry_shape_ok && r1.auto_refused && r1.templates_guarded && r1.one_look_chk && r1.triggers_ready && Number(r1.rows_with_both) === 0,
      "R1 reads true, true, true, true, true, 0", JSON.stringify(r1));
    ok(r2 && r2.fixtures_send_it === true && Number(r2.tenants) === 3 && Number(r2.library_looks) === 0 && Number(r2.rows_with_both) === 0
      && r2.body_md5 === writtenMd5(), "R2 (THE RECORD) reads true, 3, 0, 0, <the md5 P2 checks>", JSON.stringify(r2));
    for (const c of TENANTS) ok(JSON.stringify(await fixOf(db, c)) === beforeLooks[c], `${c}: get_fixtures is byte-for-byte unchanged (no entry names a look)`);
    ok(before[B] === beforeLooks[B], "(bravo has no look at all, before or after)");
    const sec = await one(db, "select prosecdef, proconfig from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure");
    ok(sec.prosecdef === true && JSON.stringify(sec.proconfig) === JSON.stringify(['search_path=""']), "still security definer, search_path ''", JSON.stringify(sec));
    const def = await defOf(db);
    ok(def.split("jsonb_build_object('doorLook'").length === 2, "one doorLook merge in the body");
    ok(def.split("jsonb_build_object('liteRows'").length === 2 && def.split("|| case when fi.category = 'window' and coalesce(fi.in_door, false)").length === 2,
      "335's lites merge and 289's inDoor merge are each still there once");
    console.log("    (written body md5 " + (await lfMd5(db)) + ")");
    const again = await apply(db);
    ok(again.err === null && again.p0.length === 0, "a second apply claims nothing and changes nothing", again.err);
    ok(await lfMd5(db) === writtenMd5(), "...and the body is the same");
    ok(Number((await one(db, "select count(*) n from pg_trigger where not tgisinternal and tgname = 'fixture_items_one_look'")).n) === 1, "...with one trigger, not two");
  }

  console.log("library_look_ok: the door shape, and nothing 339 took is lost");
  {
    const lk = async (cat, look) => (await one(db, "select public.library_look_ok($1, $2::jsonb) v", [cat, look])).v;
    ok(await lk("door", entryLook("zbrace", LOOK)) === true, "door: a base + a doorLookId");
    for (const s of ["plank", "zbrace", "xbrace", "american", "basic", "classic", "dutch"]) ok(await lk("door", entryLook(s, LOOK)) === true, `door: ${s} may carry a look`);
    for (const s of ["auto", "rollup"]) ok(await lk("door", entryLook(s, LOOK)) === false, `door: ${s} may not (a photo and a roll-up are not built looks)`);
    ok(await lk("door", JSON.stringify({ doorStyle: "zbrace", doorLookId: "not-a-uuid" })) === false, "door: a doorLookId that is not a uuid");
    ok(await lk("door", JSON.stringify({ doorStyle: "zbrace", doorLookId: LOOK.toUpperCase() })) === false, "door: a doorLookId in capitals (the server sends lower case)");
    ok(await lk("door", JSON.stringify({ doorStyle: "zbrace", doorLookId: 7 })) === false, "door: a doorLookId that is a number");
    ok(await lk("door", JSON.stringify({ doorStyle: "zbrace", doorLookId: LOOK, spec: {} })) === false, "door: any other key");
    ok(await lk("door", JSON.stringify({ doorLookId: LOOK })) === false, "door: a look with no base");
    ok(await lk("window", JSON.stringify({ doorLookId: LOOK })) === false && await lk("cladding", JSON.stringify({ profile: "lap", doorLookId: LOOK })) === false, "windows and claddings never carry one");
    for (const s of ["auto", "plank", "zbrace", "xbrace", "rollup", "american", "basic", "classic", "dutch"]) ok(await lk("door", JSON.stringify({ doorStyle: s })) === true, `339's door look still passes: ${s}`);
    ok(await lk("cladding", '{"profile":"lap","exposureIn":7}') === true && await lk("window", '{"liteRows":2,"liteCols":3}') === true && await lk("window", "{}") === true,
      "339's cladding and window looks still pass");
    const tpl = await refused(db, `insert into public.library_items (category, slug, name, look, source) values ('door', 'x-look', 'X look', '${entryLook("zbrace", LOOK)}'::jsonb, 'builtin')`, /library_items_no_door_look_chk|violates check constraint/);
    ok(tpl && !tpl.startsWith("WRONG"), "a StructureStudio template can never name a builder's look", tpl);
  }

  console.log("an entry that names a look");
  let ENTRY = null;
  {
    const ins = (client, style, id, name) => `insert into public.client_library (client_id, category, name, look) values ('${client}', 'door', '${name}', '${entryLook(style, id)}'::jsonb)`;
    let r = await refused(db, ins(A, "basic", DRAFT, "Draft door"), /Save that 3D door look/);
    ok(r && !r.startsWith("WRONG"), "a draft look is refused", r);
    r = await refused(db, ins(A, "classic", CLOOK, "Their door"), /isn't in this catalog/);
    ok(r && !r.startsWith("WRONG"), "another builder's look is refused (as if it were not there)", r);
    r = await refused(db, ins(A, "classic", LOOK, "Wrong base"), /different base/);
    ok(r && !r.startsWith("WRONG"), "an entry on a base other than the look's is refused", r);
    r = await refused(db, ins(A, "zbrace", "00000000-0000-4000-8000-0000000fffff", "Gone"), /isn't in this catalog/);
    ok(r && !r.startsWith("WRONG"), "a look that does not exist is refused", r);
    await db.exec(ins(A, "zbrace", LOOK, "Our photo door"));
    ENTRY = (await one(db, "select id from public.client_library where client_id = $1 and name = 'Our photo door'", [A])).id;
    ok(!!ENTRY, "the builder's own ready look on its own base goes in");
    r = await refused(db, `update public.client_library set look = '{"doorStyle":"zbrace"}'::jsonb where id = '${ENTRY}'`, /keeps its look/);
    ok(r && !r.startsWith("WRONG"), "its look can't be dropped", r);
    r = await refused(db, `update public.client_library set look = '${entryLook("zbrace", CLOOK)}'::jsonb where id = '${ENTRY}'`, /keeps its look/);
    ok(r && !r.startsWith("WRONG"), "...or swapped for another", r);
    await db.exec(`insert into public.client_library (client_id, category, name, look) values ('${A}', 'door', 'Plain Z', '{"doorStyle":"zbrace"}'::jsonb)`);
    r = await refused(db, `update public.client_library set look = '${entryLook("zbrace", LOOK)}'::jsonb where client_id = '${A}' and name = 'Plain Z'`, /keeps its look/);
    ok(r && !r.startsWith("WRONG"), "an entry never gains a look after it is made", r);
    await db.exec(`update public.client_library set name = 'Our Z photo door' where id = '${ENTRY}'`);
    ok((await one(db, "select name from public.client_library where id = $1", [ENTRY])).name === "Our Z photo door", "a rename goes through");
    r = await refused(db, `update public.door_looks set status = 'archived' where id = '${LOOK}'`, /in your library/);
    ok(r && !r.startsWith("WRONG"), "a look an entry names can't be archived", r);
    r = await refused(db, `update public.door_looks set base = 'xbrace' where id = '${LOOK}'`, /in your library/);
    ok(r && !r.startsWith("WRONG"), "...or moved to another base", r);
    await db.exec(`update public.door_looks set name = 'Renamed look', version = version + 1 where id = '${LOOK}'`);
    ok(true, "...but its other columns still save");
  }

  console.log("a door row on that entry");
  {
    await db.exec(`update public.fixture_items set client_library_id = '${ENTRY}' where id = '${PLAIN}'`);
    const row = await one(db, "select door_style, door_look_id, client_library_id from public.fixture_items where id = $1", [PLAIN]);
    ok(row.door_style === "zbrace" && row.door_look_id === null && row.client_library_id === ENTRY, "it takes the look's base (339's link), and no door_look_id", JSON.stringify(row));
    const it = await item(db, A, PLAIN);
    ok(it && it.doorStyle === "zbrace", "get_fixtures sends the base as doorStyle (production's designer draws that)", JSON.stringify(it && it.doorStyle));
    ok(it && it.doorLook && it.doorLook.id === LOOK && same(it.doorLook.spec, SPEC) && it.doorLook.v === 1
      && /door-look-1\.png$/.test(it.doorLook.thumbUrl || ""), "...and the look itself as doorLook", JSON.stringify(it && it.doorLook));
    ok(it && JSON.stringify(Object.keys(it.doorLook).sort()) === JSON.stringify(["id", "spec", "thumbUrl", "v"]), "doorLook carries exactly id, v, spec, thumbUrl");
    const own = await item(db, A, DOOR);
    ok(own && own.doorLook && own.doorLook.id === LOOK, "a row with its own door_look_id still sends its look (344)");
    const slab = await item(db, A, SLAB);
    ok(slab && !("doorLook" in slab), "a door on no look sends none");
    await db.exec(`insert into public.client_library (client_id, category, name, look) values ('${A}', 'door', 'Plain plank', '{"doorStyle":"plank"}'::jsonb)`);
    const plankEntry = (await one(db, "select id from public.client_library where client_id = $1 and name = 'Plain plank'", [A])).id;
    await db.exec(`update public.fixture_items set client_library_id = '${plankEntry}' where id = '${SLAB}'`);
    const slab2 = await item(db, A, SLAB);
    ok(slab2 && slab2.doorStyle === "plank" && !("doorLook" in slab2), "a row on a plain library entry sends no doorLook");
    for (const c of [B, C]) {
      const items = (await fixOf(db, c)).items || [];
      ok(!items.some((i) => i.doorLook && i.doorLook.id === LOOK), `${c}: never sees acme's look`);
    }
    const ced = await item(db, C, CEDAR);
    ok(ced && !("doorLook" in ced), "cedar's ready look on no row sends nothing");
    await db.exec(`update public.fixture_items set archived = true where id = '${PLAIN}'`);
    ok(!(await item(db, A, PLAIN)), "an archived row is not listed (nothing new about it)");
    await db.exec(`update public.fixture_items set archived = false where id = '${PLAIN}'`);
  }

  console.log("one look per door row");
  {
    await db.exec(`update public.fixture_items set client_library_id = '${ENTRY}' where id = '${DOOR}'`);
    let row = await one(db, "select door_look_id, client_library_id, door_style from public.fixture_items where id = $1", [DOOR]);
    ok(row.client_library_id === ENTRY && row.door_look_id === null && row.door_style === "zbrace", "putting an entry on a row with its own look clears the look", JSON.stringify(row));
    await db.exec(`update public.fixture_items set door_look_id = '${LOOK}' where id = '${DOOR}'`);
    row = await one(db, "select door_look_id, client_library_id from public.fixture_items where id = $1", [DOOR]);
    ok(row.door_look_id === LOOK && row.client_library_id === null, "putting a look on a row with an entry clears the entry", JSON.stringify(row));
    await db.exec(`update public.fixture_items set door_look_id = '${LOOK}', client_library_id = '${ENTRY}' where id = '${SLAB}'`);
    row = await one(db, "select door_look_id, client_library_id from public.fixture_items where id = $1", [SLAB]);
    ok(row.door_look_id === LOOK && row.client_library_id === null, "both in one save: the look wins, and the save goes through", JSON.stringify(row));
    await db.exec(`insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, door_style, door_look_id, client_library_id)
      values ('00000000-0000-4000-8000-0000000000d9', '${A}', 'door', 'New door', 36, 80, 300, 'zbrace', '${LOOK}', '${ENTRY}')`);
    row = await one(db, "select door_look_id, client_library_id from public.fixture_items where id = '00000000-0000-4000-8000-0000000000d9'");
    ok(row.door_look_id === LOOK && row.client_library_id === null, "...on an insert too", JSON.stringify(row));
    ok(Number((await one(db, "select count(*) n from public.fixture_items where door_look_id is not null and client_library_id is not null")).n) === 0, "no row holds both");
    await db.exec("alter table public.fixture_items disable trigger fixture_items_one_look");
    const r = await refused(db, `update public.fixture_items set client_library_id = '${ENTRY}' where id = '${DOOR}'`, /fixture_items_one_look_chk/);
    ok(r && !r.startsWith("WRONG"), "with the trigger off, the CHECK still refuses a row with both", r);
    await db.exec("alter table public.fixture_items enable trigger fixture_items_one_look");
  }

  console.log("removing the entry");
  {
    await db.exec(`update public.fixture_items set client_library_id = null where client_library_id = '${ENTRY}'`);
    await db.exec(`delete from public.client_library where id = '${ENTRY}'`);
    await db.exec(`update public.door_looks set status = 'archived' where id = '${LOOK}'`);
    ok((await one(db, "select status from public.door_looks where id = $1", [LOOK])).status === "archived", "once no entry names it, the look archives as before");
  }

  console.log("the header's rollback");
  {
    const rdb = await fresh();
    await apply(rdb);
    const t = MIG();
    const oldB = blk("old"), newB = blk("new");
    ok(t.includes("src := replace(src, <345's look_blk, below>, <344's look_blk, below>);"), "(the header names the swap back)");
    await rdb.query(`do $rb$ declare src text; begin src := pg_get_functiondef('public.get_fixtures(text)'::regprocedure); src := replace(src, $n$${newB}$n$, $o$${oldB}$o$); execute src; end $rb$`);
    ok(await lfMd5(rdb) === MD5_344, "swapping the line back leaves exactly 344's body");
    const again = await apply(rdb);
    ok(again.err === null && await lfMd5(rdb) === writtenMd5(), "...and 345 applies again after it", again.err);
  }

  console.log("mutants");
  {
    const mdb = await fresh();
    await mdb.exec(`do $d$ declare s text := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
      begin execute replace(s, $k$'sortOrder', fi.sort_order)$k$, $k$'sortOrder', fi.sort_order, 'x', 1)$k$); end $d$;`);
    ok(await lfMd5(mdb) !== MD5_344, "(the mutant formed: get_fixtures changed by someone else since)");
    const { err } = await apply(mdb);
    ok(err && /is not 344's written body/.test(err), "a drifted live body aborts P2", err);
    ok(!(await defOf(mdb)).includes("cl.look ? 'doorLookId'"), "...and nothing is spliced");
    const pdb = await fresh();
    let e2 = null;
    try { await pdb.query(piece("P2", MIG())); } catch (e) { e2 = e.message; }
    ok(e2 && /run P1 first/.test(e2), "P2 before P1 aborts", e2);
    ok(await lfMd5(pdb) === MD5_344, "...with get_fixtures untouched");
    const ndb = new PGlite();
    opened.push(ndb);
    await ndb.exec(STUBS); await ndb.exec(SEED);
    for (const p of PIECES_339) await ndb.query(p);
    let e3 = null;
    try { await ndb.query(piece("P1", MIG())); } catch (e) { e3 = e.message; }
    ok(e3 && /apply 339_library and 343_door_looks first/.test(e3), "P1 before 343 aborts with nothing changed", e3);
    // A splice that sends a draft too: the body check refuses it; with it off, check 4 does on its own.
    const wide = MIG().replace("from public.door_looks dl where dl.client_id = fi.client_id and dl.status = 'ready' and dl.id = coalesce(", "from public.door_looks dl where dl.client_id = fi.client_id and dl.id = coalesce(");
    ok(wide !== MIG(), "(the mutant formed: draft looks sent too)");
    const noBody = wide.replace(/if md5\(v_src\) <> '[0-9a-f]{32}' then\n    raise exception '345: get_fixtures is not the body this splice writes/, "if false then\n    raise exception '345: get_fixtures is not the body this splice writes");
    const wdb = await fresh();
    await wdb.exec(LOOKS);
    await wdb.query(piece("P1", MIG()));
    await wdb.exec(`insert into public.client_library (client_id, category, name, look) values ('${A}', 'door', 'Our photo door', '${entryLook("zbrace", LOOK)}'::jsonb)`);
    await wdb.exec(`update public.fixture_items set door_look_id = '${DRAFT}', door_style = 'basic' where id = '${SLAB}'`);
    let e4 = null;
    try { await wdb.query(piece("P2", noBody)); } catch (e) { e4 = e.message; }
    ok(e4 && /(sends doorLook as|changed for \d+ tenant)/.test(e4), "...the per-tenant checks refuse it on their own", e4);
    ok(await lfMd5(wdb) === MD5_344, "...and nothing of it survives (one do block)");
  }

  for (const d of opened) await d.close().catch(() => {});
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
