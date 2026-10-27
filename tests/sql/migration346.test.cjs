// Execute migration 346 (a StructureStudio door template can be a promoted door made from a photo) for
// real in PGlite, after 339 (the library) and 343 (door looks), piece by piece as live. Checks:
//   * P0 claims 346 once; P1 adds library_items.door_spec and its CHECK; R1 reads true, true, 0;
//     a second apply changes nothing; the header's rollback leaves the table as 339 made it;
//   * every template 339 seeded still passes; a door template may carry a spec on its own base only,
//     at version 1, an object, at most 4096 bytes; never on a window or cladding, never over "auto";
//   * P1 before 343 aborts with nothing changed.
// Nothing here touches the live project. The repo is public: no real client id belongs in a fixture.
//
//   node tests/sql/migration346.test.cjs   exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");
const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
const MIG = () => (process.env.MIG_FILE ? fs.readFileSync(process.env.MIG_FILE, "utf8").replace(/\r/g, "") : read("346_library_door_templates.sql"));
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
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table public.usage_prices (
  kind text primary key, label text not null, unit_label text not null default 'generation',
  price_cents integer not null check (price_cents >= 0), active boolean not null default false,
  visible boolean not null default true, sort_order integer not null default 0, note text,
  updated_at timestamptz not null default now()
);
create table public.client_configs (client_id text primary key);
create table public.client_settings (client_id text primary key, show_pricing boolean);
create table public.building_styles (id uuid primary key default gen_random_uuid(), client_id text not null, key text not null, label text);
create table public.style_cladding (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  style_id uuid not null references public.building_styles (id) on delete cascade,
  cladding_id text not null, label_override text, rate numeric, exposure_in numeric,
  active boolean not null default true, sort_order integer not null default 0, updated_at timestamptz not null default now()
);
create table public.fixture_items (
  id uuid primary key default gen_random_uuid(), client_id text not null, category text not null default 'door',
  name text not null, width_in numeric not null default 36, height_in numeric not null default 80, price numeric,
  door_style text not null default 'auto', lite_rows smallint, lite_cols smallint, updated_at timestamptz not null default now()
);
grant all on all tables in schema public to anon, authenticated, service_role;
`;
let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const refused = async (db, sql, re) => { try { await db.exec(sql); return null; } catch (e) { return re.test(e.message) ? e.message : "WRONG: " + e.message; } };
const opened = [];
async function fresh({ with343 = true } = {}) {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  for (const p of PIECES_339) await db.query(p);
  if (with343) for (const p of PIECES_343) await db.query(p);
  return db;
}
async function apply(db, text = MIG()) {
  try {
    const p0 = (await db.query(piece("P0", text))).rows;
    await db.query(piece("P1", text));
    const r1 = (await db.query(piece("R1", text))).rows[0];
    return { err: null, p0, r1 };
  } catch (e) { return { err: e.message }; }
}
const SPEC = (base, extra = {}) => JSON.stringify({ v: 1, base, src: { leaves: 1, hinge: "left" }, ...extra });
const tpl = (slug, category, look, spec) => `insert into public.library_items (category, slug, name, look, source, door_spec) values ('${category}', '${slug}', '${slug} name', '${JSON.stringify(look)}'::jsonb, 'csm', ${spec === null ? "null" : `'${spec}'::jsonb`})`;

(async () => {
  console.log("migration 346: applies after 339 and 343");
  const db = await fresh();
  {
    for (const n of ["P0", "P1", "R1"]) {
      const p = piece(n, MIG());
      ok(p.trim() && !/^\s*--/.test(p) && Buffer.byteLength(p) < 30 * 1024, `${n}: cut cleanly, no leading comment, under 30 KB`);
    }
    const seeded = Number((await one(db, "select count(*) n from public.library_items")).n);
    const { err, p0, r1 } = await apply(db);
    ok(err === null, "346 applied cleanly", err);
    ok(p0 && p0.length === 1 && p0[0].version === "346", "P0 claims 346");
    ok(r1 && r1.column_ready === true && r1.check_ready === true && Number(r1.promoted_doors) === 0, "R1 (THE RECORD) reads true, true, 0", JSON.stringify(r1));
    ok(Number((await one(db, "select count(*) n from public.library_items where door_spec is null")).n) === seeded && seeded >= 20, `the ${seeded} seeded templates are untouched`);
    const again = await apply(db);
    ok(again.err === null && again.p0.length === 0, "a second apply claims nothing and changes nothing", again.err);
  }

  console.log("what a template's door_spec may be");
  {
    let r = await db.exec(tpl("promoted-z", "door", { doorStyle: "zbrace" }, SPEC("zbrace", { brace: { t: "z", from: "hinge" } }))).then(() => null, (e) => e.message);
    ok(r === null, "a door template with a spec on its own base", r);
    r = await refused(db, tpl("bad-base", "door", { doorStyle: "classic" }, SPEC("zbrace")), /library_items_door_spec_chk/);
    ok(r && !r.startsWith("WRONG"), "a spec on another base is refused", r);
    r = await refused(db, tpl("bad-auto", "door", { doorStyle: "auto" }, SPEC("zbrace")), /library_items_door_spec_chk/);
    ok(r && !r.startsWith("WRONG"), "a spec over 'use the door's photo' is refused", r);
    r = await refused(db, tpl("bad-win", "window", { liteRows: 2, liteCols: 2 }, SPEC("zbrace")), /library_items_door_spec_chk/);
    ok(r && !r.startsWith("WRONG"), "a window never carries one", r);
    r = await refused(db, tpl("bad-v", "door", { doorStyle: "zbrace" }, JSON.stringify({ v: 2, base: "zbrace" })), /library_items_door_spec_chk/);
    ok(r && !r.startsWith("WRONG"), "a spec of another version is refused", r);
    r = await refused(db, tpl("bad-arr", "door", { doorStyle: "zbrace" }, JSON.stringify([1])), /library_items_door_spec_chk/);
    ok(r && !r.startsWith("WRONG"), "a spec that is not an object is refused", r);
    r = await refused(db, tpl("bad-big", "door", { doorStyle: "zbrace" }, SPEC("zbrace", { pad: "x".repeat(4200) })), /library_items_door_spec_chk/);
    ok(r && !r.startsWith("WRONG"), "a spec over 4096 bytes is refused", r);
    r = await refused(db, "update public.library_items set look = '{\"doorStyle\":\"classic\"}'::jsonb where slug = 'promoted-z'", /library_items_door_spec_chk/);
    ok(r && !r.startsWith("WRONG"), "a promoted template's look can't move off its spec's base", r);
    r = await db.exec("update public.library_items set name = 'Ranch Z door', status = 'archived' where slug = 'promoted-z'").then(() => null, (e) => e.message);
    ok(r === null, "...but it renames and archives like any template", r);
  }

  console.log("the header's rollback");
  {
    const rdb = await fresh();
    await apply(rdb);
    const t = MIG();
    const i = t.indexOf("--   alter table public.library_items drop constraint"), j = t.indexOf("--   delete from supabase_migrations", i);
    const rb = t.slice(i, j).split("\n").map((l) => l.replace(/^--   ?/, "")).join("\n");
    await rdb.exec(rb);
    const gone = await one(rdb, "select exists (select 1 from information_schema.columns where table_name = 'library_items' and column_name = 'door_spec') as col, exists (select 1 from pg_constraint where conname = 'library_items_door_spec_chk') as chk");
    ok(gone.col === false && gone.chk === false, "the rollback drops the column and its check", JSON.stringify(gone));
  }

  console.log("mutants");
  {
    const ndb = await fresh({ with343: false });
    const { err } = await apply(ndb);
    ok(err && /apply 339_library and 343_door_looks first/.test(err), "P1 before 343 aborts", err);
    ok((await one(ndb, "select exists (select 1 from information_schema.columns where table_name = 'library_items' and column_name = 'door_spec') as col")).col === false, "...with nothing changed");
  }

  for (const d of opened) await d.close().catch(() => {});
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
