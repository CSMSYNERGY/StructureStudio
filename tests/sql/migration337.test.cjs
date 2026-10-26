// Execute migration 337 (door looks: door_looks, the ai_door_calls ledger, fixture_items.door_look_id,
// the tenant flag, the door meter and the door-refs bucket) for real in PGlite (Postgres compiled to
// WASM, in memory) on top of the tables it touches, cut to their live columns. Then check what the
// file promises:
//   * every piece is cut out exactly the way the header's `piece()` does it (column-0 comment lines
//     dropped), is ONE statement, starts with SQL rather than a comment, and is under 30 KB;
//   * applied piece by piece, as live, every read-back reads what its comment says, P0 claims the
//     ledger row once and a second claim returns nothing;
//   * anon and authenticated read and write nothing in either table; there are no policies;
//   * a door row cannot point at another builder's look, a non-door row cannot have a look, and a
//     look going away clears door_look_id and nothing else;
//   * door_looks' checks: the seven bases, a cleaned spec object of at most 4096 bytes naming the
//     row's base and version, the three statuses, a 1-60 character trimmed name;
//   * idem_key is NOT unique (a first try and its lean retry share it);
//   * the trigger: a look's new base reaches its door rows' door_style, an archived look sends its
//     rows back to that base, and no other builder's row moves;
//   * the flag is off and the cap NULL on every existing builder; the meter is inactive; the bucket
//     is private, and a bucket someone made public first is made private;
//   * the whole file also runs as one script, a re-apply changes nothing, the header's ROLLBACK takes
//     it all back out, and it applies again after;
//   * a policy, a unique idem_key index or a browser grant left behind makes P7 refuse (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration337.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/337_door_looks.sql"), "utf8").replace(/\r/g, "");
const NAMES = ["P0", "R0", "P1", "R1", "P2", "R2", "P3", "R3", "P4", "R4", "P5", "R5", "P6", "R6", "P7", "R7"];
// The header's piece(): the lines strictly between `-- >>> n` and `-- <<< n`, minus every line that
// starts with `--`.
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
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text);
create table public.client_configs (client_id text primary key);
create table public.client_settings (client_id text primary key, show_pricing boolean, ramp_mode text);
create table public.usage_prices (
  kind text primary key, label text not null, unit_label text not null default 'generation',
  price_cents integer not null check (price_cents >= 0), active boolean not null default false,
  visible boolean not null default true, sort_order integer not null default 0, note text,
  updated_at timestamptz not null default now()
);
insert into public.usage_prices (kind, label, price_cents) values ('video_3d_generation', '3D model from a walk-around video', 2000);
create table public.fixture_items (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  category text not null default 'door',
  name text not null,
  width_in numeric not null,
  height_in numeric not null,
  price numeric,
  active boolean not null default true,
  archived boolean not null default false,
  door_style text not null default 'auto',
  lite_rows smallint, lite_cols smallint,
  constraint fixture_items_door_style_chk check (door_style in ('auto', 'plank', 'zbrace', 'xbrace', 'rollup', 'american', 'basic', 'classic', 'dutch'))
);
grant all on all tables in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to public;
`;

const A = "acme-sheds", B = "bravo-barns";
const DOOR_A = "00000000-0000-4000-8000-0000000000d1";
const DOOR_A2 = "00000000-0000-4000-8000-0000000000d2";
const DOOR_B = "00000000-0000-4000-8000-0000000000d3";
const WIN_A = "00000000-0000-4000-8000-0000000000a1";
const LOOK_A = "00000000-0000-4000-8000-00000000100a";
const LOOK_B = "00000000-0000-4000-8000-00000000100b";
const SEED = `
insert into public.client_configs (client_id) values ('${A}'), ('${B}');
insert into public.client_settings (client_id, show_pricing) values ('${A}', true), ('${B}', false);
insert into public.fixture_items (id, client_id, category, name, width_in, height_in, price, door_style) values
  ('${DOOR_A}',  '${A}', 'door',   'Barn door',   72, 78, 900, 'zbrace'),
  ('${DOOR_A2}', '${A}', 'door',   'Barn door',   60, 78, 800, 'zbrace'),
  ('${DOOR_B}',  '${B}', 'door',   'Single door', 36, 78, 400, 'plank'),
  ('${WIN_A}',   '${A}', 'window', 'Wall window', 24, 36, 120, 'auto');
`;
const spec = (base, extra = {}) => JSON.stringify({ v: 1, base, src: { leaves: 2, hinge: "right" }, ...extra });
const look = (id, client, base, status = "ready", extra = {}) =>
  `insert into public.door_looks (id, client_id, name, base, spec, status) values ('${id}', '${client}', 'Our barn door', '${base}', '${spec(base, extra)}'::jsonb, '${status}')`;

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
/** Every piece, in order, each as its own call (the live apply). Returns each R's row. */
async function applyPieces(db, text = MIG()) {
  const reads = {};
  for (const n of NAMES) {
    const sql = piece(n, text);
    const res = await db.query(sql);
    if (n.startsWith("R") || n === "P0") reads[n] = res.rows;
  }
  return reads;
}
const asRole = async (db, role, sql) => {
  await db.exec(`set role ${role}`);
  try { return await errOf(db, sql); } finally { await db.exec("reset role"); }
};
// Rollback, as the header writes it, with the comment markers taken off.
const ROLLBACK = () => {
  const t = MIG();
  const i = t.indexOf("--   do $rb$ begin");
  const j = t.indexOf("--   end $rb$;", i);
  if (i < 0 || j < 0) throw new Error("the ROLLBACK block in 337's header moved; re-point the test");
  return t.slice(i, j + "--   end $rb$;".length).split("\n").map((l) => l.replace(/^--   ?/, "")).join("\n");
};

(async () => {
  console.log("the pieces, cut the way the header cuts them");
  {
    const t = MIG();
    for (const n of NAMES) {
      const p = piece(n, t);
      ok(p.trim().length > 0, `${n}: found`);
      ok(!/^\s*--/.test(p), `${n}: does not start with a comment (the CLI would run nothing)`);
      ok(Buffer.byteLength(p) < 30 * 1024, `${n}: under 30 KB (${Buffer.byteLength(p)} bytes)`);
      const first = p.trim().split(/\s+/)[0].toLowerCase();
      ok(n.startsWith("R") ? first === "select" : (n === "P0" ? first === "insert" : first === "do"), `${n}: starts with ${n.startsWith("R") ? "select" : n === "P0" ? "insert" : "do"}`, first);
      // ONE statement: a single `;`, at the very end, outside the DO block's body.
      const outside = p.replace(/\$([a-z0-9_]*)\$[\s\S]*?\$\1\$/g, "");
      ok((outside.match(/;/g) || []).length === 1 && /;\s*$/.test(outside), `${n}: one statement`);
      ok(!/\bbegin\s*;|\bcommit\s*;/i.test(outside), `${n}: no begin;/commit; (db query drops them silently)`);
    }
  }

  console.log("migration 337: applied piece by piece, as live");
  {
    const db = await fresh();
    let reads;
    try { reads = await applyPieces(db); ok(true, "every piece ran"); }
    catch (e) { ok(false, "every piece ran", e.message); return; }
    ok(reads.P0.length === 1 && reads.P0[0].version === "337", "P0 claims 337 and prints its row", JSON.stringify(reads.P0));
    ok(reads.R0.length === 1 && reads.R0[0].name === "337_door_looks", "R0 reads the ledger row back");
    const r1 = reads.R1[0];
    ok(r1.ledger_ready === true && r1.rls_on === true && Number(r1.policies) === 0 && r1.anon_reads === false && r1.idem_key_unique === false,
      "R1 reads true, true, 0, false, false", JSON.stringify(r1));
    const r2 = reads.R2[0];
    ok(r2.looks_ready === true && r2.rls_on === true && Number(r2.policies) === 0 && r2.browser_reads === false && r2.tenant_key === true,
      "R2 reads true, true, 0, false, true", JSON.stringify(r2));
    const r3 = reads.R3[0];
    ok(r3.column_ready === true && r3.fk_set_null === true && r3.doors_only === true && Number(r3.rows_with_a_look) === 0,
      "R3 reads true, true, true, 0", JSON.stringify(r3));
    const r4 = reads.R4[0];
    ok(r4.trigger_ready === true && r4.anon_runs_it === false && r4.authenticated_runs_it === false, "R4 reads true, false, false", JSON.stringify(r4));
    const r5 = reads.R5[0];
    ok(r5.flag_ready === true && r5.cap_ready === true && Number(r5.builders_flagged) === 0, "R5 reads true, true, 0", JSON.stringify(r5));
    const r6 = reads.R6[0];
    ok(r6.meter_ready === true && r6.meter_active === false && r6.bucket_private === true, "R6 reads true, false, true", JSON.stringify(r6));
    const r7 = reads.R7[0];
    ok(r7.tables_ready === true && r7.rls_on === true && Number(r7.policies) === 0 && r7.anon_reads === false && r7.fixture_column_ready === true
      && r7.flag_ready === true && r7.meter_active === false && r7.bucket_private === true && Number(r7.looks) === 0,
      "THE RECORD (R7) reads true, true, 0, false, true, true, false, true, 0", JSON.stringify(r7));

    console.log("browser roles get nothing");
    for (const role of ["anon", "authenticated"]) {
      for (const t of ["door_looks", "ai_door_calls"]) {
        ok(/permission denied/.test(await asRole(db, role, `select * from public.${t}`) ?? ""), `${role} cannot read ${t}`);
        ok(/permission denied/.test(await asRole(db, role, `insert into public.${t} (client_id) values ('${A}')`) ?? ""), `${role} cannot write ${t}`);
      }
      ok(/permission denied/.test(await asRole(db, role, "select public.door_looks_sync_fixtures()") ?? ""), `${role} cannot run the trigger function`);
    }
    ok((await one(db, "select count(*)::int n from pg_policies where tablename in ('door_looks', 'ai_door_calls')")).n === 0, "no policies on either table");

    console.log("the columns and their defaults");
    const col = await one(db, "select data_type, is_nullable, column_default from information_schema.columns where table_name = 'fixture_items' and column_name = 'door_look_id'");
    ok(col.data_type === "uuid" && col.is_nullable === "YES" && col.column_default === null, "fixture_items.door_look_id: uuid, nullable, no default", JSON.stringify(col));
    ok((await one(db, "select count(*)::int n from public.fixture_items where door_look_id is not null")).n === 0, "every door row reads NULL (its standard look)");
    const cs = (await db.query("select door_looks_beta, ai_door_daily_cap from public.client_settings")).rows;
    ok(cs.length === 2 && cs.every((r) => r.door_looks_beta === false && r.ai_door_daily_cap === null), "every builder: flag off, cap NULL (10)", JSON.stringify(cs));
    ok(await refused(db, `update public.client_settings set ai_door_daily_cap = -1 where client_id = '${A}'`), "a negative cap is refused");
    ok(!(await refused(db, `update public.client_settings set ai_door_daily_cap = 0 where client_id = '${A}'`)), "0 (unlimited) is stored");
    const meter = await one(db, "select price_cents, active, visible from public.usage_prices where kind = 'door_look_generation'");
    ok(meter && meter.active === false, "the door meter is inactive (free while we pilot)", JSON.stringify(meter));
    const bucket = await one(db, "select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'door-refs'");
    ok(bucket && bucket.public === false && Number(bucket.file_size_limit) === 5242880 && JSON.stringify(bucket.allowed_mime_types) === JSON.stringify(["image/jpeg", "image/png", "image/webp"]),
      "door-refs: private, 5 MB, JPEG/PNG/WebP", JSON.stringify(bucket));

    console.log("door_looks: what a row may hold");
    ok(!(await refused(db, look(LOOK_A, A, "zbrace"))), "a ready zbrace look for acme is stored");
    ok(!(await refused(db, look(LOOK_B, B, "plank"))), "a ready plank look for bravo is stored");
    const L = "00000000-0000-4000-8000-0000000010ff";
    ok(await refused(db, look(L, A, "slab")), "a base outside the seven is refused");
    ok(await refused(db, `insert into public.door_looks (id, client_id, name, base, spec) values ('${L}', '${A}', 'X', 'zbrace', '${spec("plank")}'::jsonb)`), "a spec naming another base is refused");
    ok(await refused(db, `insert into public.door_looks (id, client_id, name, base, spec) values ('${L}', '${A}', 'X', 'zbrace', '${JSON.stringify({ v: 2, base: "zbrace" })}'::jsonb)`), "a spec of another version is refused");
    ok(await refused(db, `insert into public.door_looks (id, client_id, name, base, spec) values ('${L}', '${A}', 'X', 'zbrace', '[1]'::jsonb)`), "a spec that is not an object is refused");
    ok(await refused(db, look(L, A, "zbrace", "ready", { pad: "x".repeat(4100) })), "a spec over 4096 bytes is refused");
    ok(!(await refused(db, look(L, A, "zbrace", "draft", { pad: "x".repeat(3900) }))), "a spec just under it is stored");
    await db.exec(`delete from public.door_looks where id = '${L}'`);
    ok(await refused(db, look(L, A, "zbrace", "published")), "a status outside draft / ready / archived is refused");
    for (const n of ["", " Padded", "x".repeat(61)]) {
      ok(await refused(db, `insert into public.door_looks (client_id, name, base, spec) values ('${A}', '${n}', 'zbrace', '${spec("zbrace")}'::jsonb)`), `the name ${JSON.stringify(n.length > 10 ? n.slice(0, 6) + "…" : n)} is refused`);
    }
    ok(!(await refused(db, `insert into public.door_looks (client_id, name, base, spec) values ('${A}', '${"x".repeat(60)}', 'zbrace', '${spec("zbrace")}'::jsonb)`)), "a 60-character name is stored");
    const dflt = await one(db, `select status, spec_version, version from public.door_looks where name = '${"x".repeat(60)}'`);
    ok(dflt.status === "draft" && dflt.spec_version === 1 && dflt.version === 1, "a new look starts as a draft, spec v1, version 1", JSON.stringify(dflt));

    console.log("fixture_items.door_look_id: the builder's own look, doors only");
    ok(!(await refused(db, `update public.fixture_items set door_look_id = '${LOOK_A}' where id in ('${DOOR_A}', '${DOOR_A2}')`)), "acme's doors take acme's look");
    ok(await refused(db, `update public.fixture_items set door_look_id = '${LOOK_B}' where id = '${DOOR_A}'`), "acme's door cannot take bravo's look");
    ok(await refused(db, `update public.fixture_items set door_look_id = '${LOOK_A}' where id = '${DOOR_B}'`), "bravo's door cannot take acme's look");
    ok(await refused(db, `update public.fixture_items set door_look_id = '${LOOK_A}' where id = '${WIN_A}'`), "a window cannot have a look");
    ok(await refused(db, `update public.fixture_items set door_look_id = gen_random_uuid() where id = '${DOOR_A}'`), "a look that does not exist is refused");

    console.log("the trigger: base and archive reach the rows");
    await db.exec(`update public.fixture_items set door_look_id = '${LOOK_B}' where id = '${DOOR_B}'`);
    await db.exec(`update public.door_looks set base = 'xbrace', spec = '${spec("xbrace")}'::jsonb where id = '${LOOK_A}'`);
    let rows = (await db.query("select id, door_style, door_look_id from public.fixture_items order by id")).rows;
    const byId = (id) => rows.find((r) => r.id === id);
    ok(byId(DOOR_A).door_style === "xbrace" && byId(DOOR_A2).door_style === "xbrace", "a new base reaches every door row on the look", JSON.stringify(rows));
    ok(byId(DOOR_B).door_style === "plank", "...and no other builder's row");
    await db.exec(`update public.door_looks set name = 'Renamed' where id = '${LOOK_A}'`);
    rows = (await db.query("select id, door_style, door_look_id from public.fixture_items order by id")).rows;
    ok(byId(DOOR_A).door_look_id === LOOK_A && byId(DOOR_A).door_style === "xbrace", "a rename moves nothing");
    await db.exec(`update public.door_looks set status = 'archived' where id = '${LOOK_A}'`);
    rows = (await db.query("select id, door_style, door_look_id from public.fixture_items order by id")).rows;
    ok(byId(DOOR_A).door_look_id === null && byId(DOOR_A2).door_look_id === null, "an archived look's rows go back to their standard look", JSON.stringify(rows));
    ok(byId(DOOR_A).door_style === "xbrace", "...the base, which door_style already held");
    ok(byId(DOOR_B).door_look_id === LOOK_B, "...and bravo's row keeps bravo's look");
    await db.exec(`delete from public.door_looks where id = '${LOOK_B}'`);
    const dB = await one(db, `select client_id, door_look_id, door_style from public.fixture_items where id = '${DOOR_B}'`);
    ok(dB.client_id === B && dB.door_look_id === null && dB.door_style === "plank", "a deleted look clears door_look_id and keeps client_id (SET NULL names one column)", JSON.stringify(dB));

    console.log("ai_door_calls: the ledger");
    const K = "press-1";
    ok(!(await refused(db, `insert into public.ai_door_calls (client_id, idem_key) values ('${A}', '${K}'), ('${A}', '${K}')`)), "two rows under one key (first try and lean retry) are stored");
    const call = await one(db, `select id, status, self_check_round from public.ai_door_calls where idem_key = '${K}' limit 1`);
    ok(call.status === "running" && call.self_check_round === 0, "a new row is running, round 0", JSON.stringify(call));
    ok(await refused(db, `insert into public.ai_door_calls (client_id, status) values ('${A}', 'paused')`), "a status outside running / done / failed is refused");
    ok(await refused(db, `insert into public.ai_door_calls (client_id, photo_paths) values ('${A}', array['a','b','c','d','e'])`), "more than 4 photos is refused");
    await db.exec(`update public.door_looks set ai_call_id = '${call.id}' where id = '${LOOK_A}'`);
    await db.exec(`delete from public.ai_door_calls where id = '${call.id}'`);
    ok((await one(db, `select ai_call_id from public.door_looks where id = '${LOOK_A}'`)).ai_call_id === null, "a deleted ledger row clears the look's ai_call_id");

    console.log("re-apply and rollback");
    const again = await applyPieces(db);
    ok(again.P0.length === 0, "a second P0 claims nothing (the number is taken: stop and renumber)");
    ok(again.R7[0].tables_ready === true && Number(again.R7[0].looks) > 0, "every other piece runs again over live data", JSON.stringify(again.R7[0]));
    const bcount = (await one(db, "select count(*)::int n from public.fixture_items")).n;
    try { await db.exec(ROLLBACK()); ok(true, "the header's ROLLBACK runs"); }
    catch (e) { ok(false, "the header's ROLLBACK runs", e.message); }
    ok((await one(db, "select to_regclass('public.door_looks') is null and to_regclass('public.ai_door_calls') is null as gone")).gone === true, "...and the tables are gone");
    ok((await one(db, "select count(*)::int n from information_schema.columns where column_name in ('door_look_id', 'door_looks_beta', 'ai_door_daily_cap')")).n === 0, "...the columns too");
    ok((await one(db, "select count(*)::int n from public.fixture_items")).n === bcount, "...and every door row is still there");
    ok((await one(db, "select count(*)::int n from public.usage_prices where kind = 'door_look_generation'")).n === 0, "...the meter row is gone");
    ok((await one(db, "select count(*)::int n from storage.buckets where id = 'door-refs'")).n === 1, "...and the bucket is left for the dashboard (never a direct storage delete)");
    ok(!/delete from storage\./.test(ROLLBACK()), "the rollback never deletes from a storage table");
    await db.exec("delete from supabase_migrations.schema_migrations where version = '337'");
    const re = await applyPieces(db);
    ok(re.P0.length === 1 && re.R7[0].tables_ready === true, "337 applies again after a rollback");
  }

  console.log("migration 337: the whole file as one script");
  {
    const db = await fresh();
    try {
      const out = await db.exec(MIG());
      const rec = [...out].reverse().map((r) => r.rows && r.rows[0]).find((r) => r && "tables_ready" in r);
      ok(rec && rec.tables_ready === true && rec.bucket_private === true, "it runs top to bottom and ends on THE RECORD", JSON.stringify(rec));
    } catch (e) { ok(false, "it runs top to bottom", e.message); }
  }

  console.log("migration 337: a bucket someone already made public is made private");
  {
    const db = await fresh("insert into storage.buckets (id, name, public) values ('door-refs', 'door-refs', true);");
    await applyPieces(db);
    ok((await one(db, "select public from storage.buckets where id = 'door-refs'")).public === false, "door-refs is private after the apply");
  }

  console.log("migration 337: what P7 refuses (mutants)");
  {
    const mutants = [
      ["a policy on door_looks", (t) => t.replace("  alter table public.door_looks enable row level security;", "  alter table public.door_looks enable row level security;\n  create policy door_looks_anon on public.door_looks for select to anon using (true);"), /has a policy/],
      ["a unique idem_key", (t) => t.replace("create index if not exists ai_door_calls_idem_key_idx", "create unique index if not exists ai_door_calls_idem_key_idx"), /idem_key is unique/],
      ["the revoke left out", (t) => t.replace("  revoke all on table public.door_looks from public, anon, authenticated;\n", ""), /browser role can still read or write public\.door_looks/],
      ["the trigger function left executable", (t) => t.replace("  revoke all on function public.door_looks_sync_fixtures() from public, anon, authenticated;\n", ""), /executable by a browser role/],
      ["the FK without its column list", (t) => t.replace("on delete set null (door_look_id);", "on delete set null;"), /fixture_items_door_look_fk is missing or wrong/],
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
