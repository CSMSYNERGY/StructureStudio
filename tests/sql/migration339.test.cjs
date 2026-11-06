// Execute migration 339 (the library: library_items, client_library, the links from style_cladding
// and fixture_items, library_requests, the flag, the request meter and the library-refs bucket) for
// real in PGlite (Postgres compiled to WASM, in memory) on top of the tables it touches, cut to their
// live columns. Then check what the file promises:
//   * every piece is cut out exactly the way the header's `piece()` does it, is ONE statement, starts
//     with SQL rather than a comment, and is under 30 KB;
//   * applied piece by piece, as live, every read-back reads what its comment says; P0 claims the
//     ledger row once and a second claim returns nothing; B0 (every builder's get_config and
//     get_fixtures, hashed) reads the same before and after;
//   * anon and authenticated read and write nothing in the three tables and run none of the functions;
//   * the look rule: a course on anything but lap, an unknown door look, a half or oversized window
//     grid and an unknown key are all refused, in a template and in a builder's entry;
//   * a builder's entry: names unique per category ignoring case, the template of the same category,
//     category and a cladding's profile fixed;
//   * the links: a style row cannot point at ANOTHER builder's entry, nor at a different cladding look,
//     nor at a door; linking writes the entry's name and course through; editing the entry moves its
//     rows and nobody else's; a save that disagrees unlinks instead of being overwritten or refused; a
//     door row takes and follows the entry's look, a window row its grid; a deleted entry clears the
//     link and keeps client_id;
//   * library_requests' checks (photos, https link, money, the result entry's builder);
//   * the seed: 5 claddings, 9 door looks, 6 window grids;
//   * the whole file also runs as one script, a re-apply changes nothing, the header's ROLLBACK takes
//     it all back out, and it applies again after;
//   * a policy, a missing revoke, a trigger function left executable, or a SET NULL without its column
//     list makes P7 refuse (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration339.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/339_library.sql"), "utf8").replace(/\r/g, "");
const NAMES = ["P0", "R0", "P1", "R1", "P2", "R2", "P3", "R3", "P4", "R4", "P5", "R5", "P6", "R6", "P7", "R7"];
const piece = (n, text = MIG()) => {
  const out = [];
  let on = false;
  for (const l of text.split("\n")) {
    if (l === `-- >>> ${n}`) { on = true; continue; }
    if (l === `-- <<< ${n}`) { on = false; continue; }
    if (on && !l.startsWith("--")) out.push(l);
  }
  return out.join("\n");
};

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table public.client_configs (client_id text primary key);
create table public.client_settings (client_id text primary key, show_pricing boolean);
create table public.usage_prices (
  kind text primary key, label text not null, unit_label text not null default 'generation',
  price_cents integer not null check (price_cents >= 0), active boolean not null default false,
  visible boolean not null default true, sort_order integer not null default 0, note text,
  updated_at timestamptz not null default now()
);
insert into public.usage_prices (kind, label, price_cents) values ('video_3d_generation', '3D model from a walk-around video', 2000);
create table public.building_styles (id uuid primary key default gen_random_uuid(), client_id text not null, key text not null);
create table public.style_cladding (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  style_id uuid not null references public.building_styles (id) on delete cascade,
  cladding_id text not null check (cladding_id in ('panel', 'lap', 'batten', 'agpanel', 'vinyl')),
  label_override text,
  rate numeric,
  exposure_in numeric constraint style_cladding_exposure_in_check check (exposure_in is null or (cladding_id = 'lap' and exposure_in between 3 and 12)),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, style_id, cladding_id)
);
create table public.fixture_items (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  category text not null default 'door',
  name text not null,
  width_in numeric not null,
  height_in numeric not null,
  price numeric,
  active boolean not null default true,
  door_style text not null default 'auto',
  lite_rows smallint, lite_cols smallint,
  updated_at timestamptz not null default now(),
  constraint fixture_items_door_style_chk check (door_style in ('auto', 'plank', 'zbrace', 'xbrace', 'rollup', 'american', 'basic', 'classic', 'dutch')),
  constraint fixture_items_lites_chk check ((lite_rows is null and lite_cols is null) or (lite_rows between 1 and 8 and lite_cols between 1 and 8))
);
-- Stand-ins for the two RPCs B0 hashes. They read every column the real ones read from these rows.
create function public.get_config(p text) returns jsonb language sql as $$
  select jsonb_build_object('client', p, 'cladding', (select jsonb_agg(jsonb_build_object('id', sc.cladding_id, 'label', sc.label_override, 'exposureIn', sc.exposure_in, 'rate', sc.rate) order by sc.id)
    from public.style_cladding sc where sc.client_id = p)) $$;
create function public.get_fixtures(p text) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('id', fi.id, 'doorStyle', fi.door_style, 'liteRows', fi.lite_rows, 'liteCols', fi.lite_cols) order by fi.id)
    from public.fixture_items fi where fi.client_id = p $$;
grant all on all tables in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to public;
`;

const A = "acme-sheds", B = "bravo-barns";
const STYLE_A = "00000000-0000-4000-8000-0000000000a5", STYLE_B = "00000000-0000-4000-8000-0000000000b5";
const LAP_A = "00000000-0000-4000-8000-00000000c1a1", PANEL_A = "00000000-0000-4000-8000-00000000c1a2", LAP_B = "00000000-0000-4000-8000-00000000c1b1";
const DOOR_A = "00000000-0000-4000-8000-0000000000d1", DOOR_B = "00000000-0000-4000-8000-0000000000d3";
const WIN_A = "00000000-0000-4000-8000-0000000000a1";
const SEED = `
insert into public.client_configs (client_id) values ('${A}'), ('${B}');
insert into public.client_settings (client_id, show_pricing) values ('${A}', true), ('${B}', false);
insert into public.building_styles (id, client_id, key) values ('${STYLE_A}', '${A}', 'utility'), ('${STYLE_B}', '${B}', 'utility');
insert into public.style_cladding (id, client_id, style_id, cladding_id, label_override, rate, exposure_in) values
  ('${LAP_A}',   '${A}', '${STYLE_A}', 'lap',   null, 0, 6),
  ('${PANEL_A}', '${A}', '${STYLE_A}', 'panel', 'Smooth panel', 0, null),
  ('${LAP_B}',   '${B}', '${STYLE_B}', 'lap',   null, 1.5, null);
insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, door_style, lite_rows, lite_cols) values
  ('${DOOR_A}', '${A}', 'door',   'Double barn door', 60, 72, 300, 'auto', null, null),
  ('${DOOR_B}', '${B}', 'door',   'Single door',      36, 78, 400, 'plank', null, null),
  ('${WIN_A}',  '${A}', 'window', 'Wall window',      24, 36, 120, 'auto', null, null);
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const opened = [];
async function fresh(extra = "") {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  await db.exec(SEED);
  if (extra) await db.exec(extra);
  return db;
}
const refused = async (db, sql) => { try { await db.exec(sql); return false; } catch (_) { return true; } };
const errOf = async (db, sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
async function applyPieces(db, text = MIG()) {
  const reads = {};
  for (const n of NAMES) {
    const res = await db.query(piece(n, text));
    if (n.startsWith("R") || n === "P0") reads[n] = res.rows;
  }
  return reads;
}
const asRole = async (db, role, sql) => {
  await db.exec(`set role ${role}`);
  try { return await errOf(db, sql); } finally { await db.exec("reset role"); }
};
const ROLLBACK = () => {
  const t = MIG();
  const i = t.indexOf("--   do $rb$ begin");
  const j = t.indexOf("--   end $rb$;", i);
  if (i < 0 || j < 0) throw new Error("the ROLLBACK block in 339's header moved; re-point the test");
  return t.slice(i, j + "--   end $rb$;".length).split("\n").map((l) => l.replace(/^--   ?/, "")).join("\n");
};
const tmpl = async (db, cat, slug) => (await one(db, `select id, version from public.library_items where category = '${cat}' and slug = '${slug}'`));
const entry = async (db, client, cat, slug, name, look) => {
  const t = await tmpl(db, cat, slug);
  return (await one(db, `insert into public.client_library (client_id, category, library_item_id, template_version, name, look)
    values ('${client}', '${cat}', '${t.id}', ${t.version}, $1, $2::jsonb) returning id`, [name, JSON.stringify(look)])).id;
};
const cladRow = (db, id) => one(db, `select client_library_id, label_override, exposure_in::float as exposure_in, cladding_id, client_id from public.style_cladding where id = '${id}'`);
const fxRow = (db, id) => one(db, `select client_library_id, door_style, lite_rows, lite_cols, client_id from public.fixture_items where id = '${id}'`);

(async () => {
  console.log("the pieces, cut the way the header cuts them");
  {
    const t = MIG();
    ok(t.includes(`piece() { awk -v n="$1" '{sub(/\\r$/,"")} $0=="-- >>> "n{on=1;next}`), "the header's piece() drops carriage returns before it matches a marker");
    for (const n of ["B0", ...NAMES]) {
      const p = piece(n, t);
      ok(p.trim().length > 0, `${n}: found`);
      ok(!/^\s*--/.test(p), `${n}: does not start with a comment (the CLI would run nothing)`);
      ok(Buffer.byteLength(p) < 30 * 1024, `${n}: under 30 KB (${Buffer.byteLength(p)} bytes)`);
      const first = p.trim().split(/\s+/)[0].toLowerCase();
      const want = n.startsWith("R") || n === "B0" ? "select" : n === "P0" ? "insert" : "do";
      ok(first === want, `${n}: starts with ${want}`, first);
      const outside = p.replace(/\$([a-z0-9_]*)\$[\s\S]*?\$\1\$/g, "");
      ok((outside.match(/;/g) || []).length === 1 && /;\s*$/.test(outside), `${n}: one statement`);
      ok(!/\bbegin\s*;|\bcommit\s*;/i.test(outside), `${n}: no begin;/commit; (db query drops them silently)`);
    }
  }

  console.log("migration 339: applied piece by piece, as live");
  {
    const db = await fresh();
    const before = JSON.stringify((await db.query(piece("B0"))).rows);
    let reads;
    try { reads = await applyPieces(db); ok(true, "every piece ran"); }
    catch (e) { ok(false, "every piece ran", e.message); return; }
    ok(JSON.stringify((await db.query(piece("B0"))).rows) === before, "B0: every builder's get_config and get_fixtures hash the same before and after");
    ok(reads.P0.length === 1 && reads.P0[0].version === "339", "P0 claims 339 and prints its row", JSON.stringify(reads.P0));
    ok(reads.R0.length === 1 && reads.R0[0].name === "339_library", "R0 reads the ledger row back");
    const r1 = reads.R1[0];
    ok(r1.items_ready === true && r1.rls_on === true && Number(r1.policies) === 0 && r1.browser_reads === false && r1.lap_course_ok === true && r1.panel_course_ok === false,
      "R1 reads true, true, 0, false, true, false", JSON.stringify(r1));
    const r2 = reads.R2[0];
    ok(r2.entries_ready === true && r2.rls_on === true && Number(r2.policies) === 0 && r2.browser_reads === false && r2.tenant_key === true && r2.guard_ready === true,
      "R2 reads true, true, 0, false, true, true", JSON.stringify(r2));
    const r3 = reads.R3[0];
    ok(r3.cladding_fk === true && r3.fixture_fk === true && r3.link_triggers === true && r3.write_through === true
      && Number(r3.linked_cladding_rows) === 0 && Number(r3.linked_fixture_rows) === 0 && r3.anon_runs_it === false,
      "R3 reads true, true, true, true, 0, 0, false", JSON.stringify(r3));
    const r4 = reads.R4[0];
    ok(r4.requests_ready === true && r4.rls_on === true && Number(r4.policies) === 0 && r4.browser_reads === false, "R4 reads true, true, 0, false", JSON.stringify(r4));
    const r5 = reads.R5[0];
    ok(Number(r5.flagged_builders) === 0 && r5.meter_ready === true && r5.meter_active === false && Number(r5.meter_cents) === 200 && r5.bucket_private === true,
      "R5 reads 0, true, false, 200, true", JSON.stringify(r5));
    const r6 = reads.R6[0];
    ok(Number(r6.claddings) === 5 && Number(r6.doors) === 9 && Number(r6.windows) === 6 && Number(r6.not_active) === 0, "R6 reads 5, 9, 6, 0", JSON.stringify(r6));
    const r7 = reads.R7[0];
    ok(r7.assertions_passed === true && Number(r7.templates) === 20 && Number(r7.builder_entries) === 0, "R7 reads true, 20, 0", JSON.stringify(r7));

    console.log("browser roles get nothing");
    for (const role of ["anon", "authenticated"]) {
      for (const t of ["library_items", "client_library", "library_requests"]) {
        ok(!!(await asRole(db, role, `select * from public.${t}`)), `${role} cannot read ${t}`);
        ok(!!(await asRole(db, role, `insert into public.${t} (client_id) values ('x')`.replace("(client_id) values ('x')", t === "library_items" ? "(category, slug, name, look) values ('door', 'x', 'x', '{\"doorStyle\":\"auto\"}')" : "(client_id, category, name, look) values ('x', 'door', 'x', '{\"doorStyle\":\"auto\"}')"))), `${role} cannot write ${t}`);
      }
      ok(!!(await asRole(db, role, "select public.library_look_ok('door', '{}'::jsonb)")), `${role} cannot run library_look_ok`);
    }

    console.log("the look rule");
    const bad = [
      ["cladding", { profile: "panel", exposureIn: 7 }, "a course on panel"],
      ["cladding", { profile: "vinyl", exposureIn: 7 }, "a course on vinyl"],
      ["cladding", { profile: "lap", exposureIn: 13 }, "a lap course over 12"],
      ["cladding", { profile: "stucco" }, "an unknown profile"],
      ["door", { doorStyle: "sliding" }, "an unknown door look"],
      ["door", { doorStyle: "american", pickets: 3 }, "an unknown key"],
      ["window", { liteRows: 2 }, "half a grid"],
      ["window", { liteRows: 9, liteCols: 1 }, "a grid over 8"],
      ["window", { liteRows: 1.5, liteCols: 2 }, "a fractional grid"],
    ];
    for (const [cat, look, what] of bad) {
      ok(await refused(db, `insert into public.library_items (category, slug, name, look) values ('${cat}', 'bad-${cat}', 'Bad', '${JSON.stringify(look)}')`), `a template with ${what} is refused`);
      ok(await refused(db, `insert into public.client_library (client_id, category, name, look) values ('${A}', '${cat}', 'Bad', '${JSON.stringify(look)}')`), `...and so is an entry`);
    }
    ok(!(await refused(db, `insert into public.client_library (client_id, category, name, look) values ('${A}', 'window', 'Automatic', '{}')`)), "an automatic window ({}) is a good look");

    console.log("a builder's entries");
    const lapA = await entry(db, A, "cladding", "lap", "Our 7 in lap", { profile: "lap", exposureIn: 7 });
    ok(await refused(db, `insert into public.client_library (client_id, category, name, look) values ('${A}', 'cladding', 'OUR 7 IN LAP', '{"profile":"lap"}')`), "a second entry with the same name in another case is refused");
    ok(!(await refused(db, `insert into public.client_library (client_id, category, name, look) values ('${B}', 'cladding', 'Our 7 in lap', '{"profile":"lap"}')`)), "...another builder may use the name");
    const doorT = await tmpl(db, "door", "american");
    ok(await refused(db, `insert into public.client_library (client_id, category, library_item_id, name, look) values ('${A}', 'cladding', '${doorT.id}', 'Wrong', '{"profile":"lap"}')`), "an entry cannot come from a template of another category");
    ok(await refused(db, `update public.client_library set look = '{"profile":"panel"}' where id = '${lapA}'`), "a cladding entry's profile cannot change");
    ok(await refused(db, `update public.client_library set category = 'door', look = '{"doorStyle":"auto"}' where id = '${lapA}'`), "nor its category");
    const lapB = (await one(db, `select id from public.client_library where client_id = '${B}' and category = 'cladding'`)).id;

    console.log("a style's cladding row and the entry");
    ok(await refused(db, `update public.style_cladding set client_library_id = '${lapB}' where id = '${LAP_A}'`), "a style row cannot point at ANOTHER builder's entry");
    ok(await refused(db, `update public.style_cladding set client_library_id = '${lapA}' where id = '${PANEL_A}'`), "...nor at a different cladding look");
    const panelA = await entry(db, A, "cladding", "panel", "T1-11 panel", { profile: "panel" });
    await db.exec(`update public.style_cladding set client_library_id = '${lapA}' where id = '${LAP_A}'`);
    let r = await cladRow(db, LAP_A);
    ok(r.client_library_id === lapA && r.label_override === "Our 7 in lap" && r.exposure_in === 7, "linking writes the entry's name and course through", JSON.stringify(r));
    await db.exec(`update public.client_library set name = 'Our lap siding', look = '{"profile":"lap","exposureIn":8}' where id = '${lapA}'`);
    r = await cladRow(db, LAP_A);
    ok(r.client_library_id === lapA && r.label_override === "Our lap siding" && r.exposure_in === 8, "editing the entry moves its row (name and course)", JSON.stringify(r));
    const rB = await cladRow(db, LAP_B);
    ok(rB.label_override === null && rB.client_library_id === null, "...and nobody else's");
    await db.exec(`update public.style_cladding set rate = 2, label_override = 'Our lap siding' where id = '${LAP_A}'`);
    ok((await cladRow(db, LAP_A)).client_library_id === lapA, "a save that agrees with the entry (the old portal resending the label) keeps the link");
    await db.exec(`update public.style_cladding set label_override = 'Lap (hand typed)' where id = '${LAP_A}'`);
    r = await cladRow(db, LAP_A);
    ok(r.client_library_id === null && r.label_override === "Lap (hand typed)", "a save that disagrees unlinks the row and keeps what was saved", JSON.stringify(r));
    await db.exec(`update public.style_cladding set client_library_id = '${panelA}' where id = '${PANEL_A}'`);
    ok((await cladRow(db, PANEL_A)).label_override === "T1-11 panel" && (await cladRow(db, PANEL_A)).exposure_in === null, "a panel row links to a panel entry, no course");
    await db.exec(`delete from public.client_library where id = '${panelA}'`);
    r = await cladRow(db, PANEL_A);
    ok(r.client_library_id === null && r.client_id === A && r.label_override === "T1-11 panel", "a deleted entry clears the link and keeps client_id and the label", JSON.stringify(r));

    console.log("door and window rows and the entry");
    const doorA = await entry(db, A, "door", "american", "Our American", { doorStyle: "american" });
    const winA = await entry(db, A, "window", "six-lite", "Colonial", { liteRows: 3, liteCols: 2 });
    ok(await refused(db, `update public.fixture_items set client_library_id = '${winA}' where id = '${DOOR_A}'`), "a door row cannot point at a window entry");
    ok(await refused(db, `update public.fixture_items set client_library_id = '${doorA}' where id = '${DOOR_B}'`), "...nor at another builder's entry");
    await db.exec(`update public.fixture_items set client_library_id = '${doorA}' where id = '${DOOR_A}'`);
    ok((await fxRow(db, DOOR_A)).door_style === "american", "a linked door draws the entry's look");
    await db.exec(`update public.client_library set look = '{"doorStyle":"classic"}' where id = '${doorA}'`);
    ok((await fxRow(db, DOOR_A)).door_style === "classic" && (await fxRow(db, DOOR_A)).client_library_id === doorA, "editing the entry's look moves its door");
    ok((await fxRow(db, DOOR_B)).door_style === "plank", "...and nobody else's");
    await db.exec(`update public.fixture_items set price = 350, door_style = 'classic' where id = '${DOOR_A}'`);
    ok((await fxRow(db, DOOR_A)).client_library_id === doorA, "a door save resending the same look keeps the link (the old portal sends doorStyle on every save)");
    await db.exec(`update public.fixture_items set door_style = 'plank' where id = '${DOOR_A}'`);
    r = await fxRow(db, DOOR_A);
    ok(r.client_library_id === null && r.door_style === "plank", "a door save with another look unlinks it and keeps that look", JSON.stringify(r));
    await db.exec(`update public.fixture_items set client_library_id = '${winA}' where id = '${WIN_A}'`);
    r = await fxRow(db, WIN_A);
    ok(r.lite_rows === 3 && r.lite_cols === 2, "a linked window takes the entry's grid", JSON.stringify(r));
    await db.exec(`update public.client_library set look = '{}' where id = '${winA}'`);
    r = await fxRow(db, WIN_A);
    ok(r.lite_rows === null && r.lite_cols === null && r.client_library_id === winA, "an entry set to automatic clears its windows' grid", JSON.stringify(r));

    console.log("library_requests");
    const req = (cols, vals) => `insert into public.library_requests (client_id, category, name${cols}) values ('${A}', 'window', 'Our window'${vals})`;
    ok(!(await refused(db, req("", ""))), "a plain request is stored");
    ok(await refused(db, req(", photos", `, '[1,2,3,4,5]'`)), "more than 4 photos is refused");
    ok(await refused(db, req(", supplier_url", `, 'http://example.test/w'`)), "a link that is not https is refused");
    ok(await refused(db, req(", charged_cents, refunded_cents", ", 200, 300")), "refunding more than was charged is refused");
    ok(await refused(db, req(", status", ", 'paused'")), "an unknown status is refused");
    ok(await refused(db, req(", result_client_library_id", `, '${lapB}'`)), "a result entry of another builder is refused");

    console.log("re-apply and rollback");
    const again = await applyPieces(db);
    ok(again.P0.length === 0, "a second P0 claims nothing (the number is taken: stop and renumber)");
    ok(again.R7[0].assertions_passed === true && Number(again.R7[0].builder_entries) > 0, "every other piece runs again over live data", JSON.stringify(again.R7[0]));
    const counts = async () => (await one(db, "select (select count(*)::int from public.style_cladding) sc, (select count(*)::int from public.fixture_items) fi"));
    const c0 = await counts();
    try { await db.exec(ROLLBACK()); ok(true, "the header's ROLLBACK runs"); }
    catch (e) { ok(false, "the header's ROLLBACK runs", e.message); }
    ok((await one(db, "select to_regclass('public.library_items') is null and to_regclass('public.client_library') is null and to_regclass('public.library_requests') is null as gone")).gone === true, "...and the tables are gone");
    ok((await one(db, "select count(*)::int n from information_schema.columns where column_name in ('client_library_id', 'library_beta')")).n === 0, "...the columns too");
    ok(JSON.stringify(await counts()) === JSON.stringify(c0), "...and every style and fixture row is still there");
    ok((await one(db, "select count(*)::int n from public.usage_prices where kind = 'library_request'")).n === 0, "...the meter row is gone");
    ok((await one(db, "select count(*)::int n from storage.buckets where id = 'library-refs'")).n === 1, "...and the bucket is left for the dashboard");
    ok(!/delete from storage\./.test(ROLLBACK()), "the rollback never deletes from a storage table");
    await db.exec("delete from supabase_migrations.schema_migrations where version = '339'");
    const re = await applyPieces(db);
    ok(re.P0.length === 1 && re.R7[0].assertions_passed === true, "339 applies again after a rollback");
  }

  console.log("migration 339: the whole file as one script");
  {
    const db = await fresh();
    try {
      const out = await db.exec(MIG());
      const rec = [...out].reverse().map((x) => x.rows && x.rows[0]).find((x) => x && "assertions_passed" in x);
      ok(rec && rec.assertions_passed === true && Number(rec.templates) === 20, "it runs top to bottom and ends on R7", JSON.stringify(rec));
    } catch (e) { ok(false, "it runs top to bottom", e.message); }
  }

  console.log("migration 339: a bucket someone already made public is made private");
  {
    const db = await fresh("insert into storage.buckets (id, name, public) values ('library-refs', 'library-refs', true);");
    await applyPieces(db);
    ok((await one(db, "select public from storage.buckets where id = 'library-refs'")).public === false, "library-refs is private after the apply");
  }

  console.log("migration 339: what P7 refuses (mutants)");
  {
    const mutants = [
      ["a policy on client_library", (t) => t.replace("  alter table public.client_library enable row level security;", "  alter table public.client_library enable row level security;\n  create policy client_library_anon on public.client_library for select to anon using (true);"), /has a policy/],
      ["the revoke left out", (t) => t.replace("  revoke all on table public.library_requests from public, anon, authenticated;\n", ""), /browser role can read or write library_requests/],
      ["a trigger function left executable", (t) => t.replace("  revoke all on function public.client_library_write_through() from public, anon, authenticated;\n", ""), /client_library_write_through\(\) is executable by a browser role/],
      ["a SET NULL without its column list", (t) => t.replace("on delete set null (client_library_id);\n  end if;\n  create index if not exists fixture_items_library_idx", "on delete set null;\n  end if;\n  create index if not exists fixture_items_library_idx"), /fixture_items_library_fk is missing or wrong/],
    ];
    for (const [what, mutate, want] of mutants) {
      const text = mutate(MIG());
      ok(text !== MIG(), `(the mutant formed: ${what})`);
      const db = await fresh();
      let err = null;
      try { await applyPieces(db, text); } catch (e) { err = e.message; }
      ok(err && want.test(err), `${what}: P7 refuses it`, err);
    }
  }

  for (const db of opened) await db.close().catch(() => {});
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
