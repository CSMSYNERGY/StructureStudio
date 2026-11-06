// Execute migration 304 for real in PGlite (Postgres compiled to WASM, in memory, with its pg_trgm
// extension) on sms_messages, phone_voicemails and crm_contacts shaped like the live ones (150,
// 254, 130), then check what it promises: three valid GIN gin_trgm_ops indexes on the columns the
// phone apps' list search reads with ilike '%term%', which the planner uses for that shape; a
// search answers the same with the index as without it (case, a word inside a word, NULLs); a
// re-apply is harmless; pg_trgm already installed in another schema is used where it is; the
// rehearsal (last commit swapped for rollback) leaves nothing; a database without 254's transcript
// is refused before anything changes; broken copies are refused (mutants).
// Nothing here touches the live project.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration304.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");
const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");

const WT = path.resolve(__dirname, "../..");
const M304 = () => fs.readFileSync(path.join(WT, "supabase/migrations/304_phone_list_search_trgm.sql"), "utf8").replace(/\r/g, "");
const INDEXES = ["crm_contacts_name_trgm", "phone_voicemails_transcript_trgm", "sms_messages_body_trgm"];

const STUBS = ({ with254 = true, trgmIn = null } = {}) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema extensions;
${trgmIn ? `create extension pg_trgm with schema ${trgmIn};` : ""}
create table public.crm_contacts (
  id uuid primary key default gen_random_uuid(), client_id text not null, name text, phone_digits text,
  merged_into uuid, updated_at timestamptz not null default now()
);
create index crm_contacts_client_recent on public.crm_contacts (client_id, updated_at desc);
create table public.sms_messages (
  id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid,
  direction text not null check (direction in ('out', 'in')), from_number text not null, to_number text not null,
  body text, created_at timestamptz not null default now()
);
create index sms_messages_contact_idx on public.sms_messages (client_id, contact_id, created_at desc) where contact_id is not null;
create index sms_messages_created_idx on public.sms_messages (created_at);
create table public.phone_calls (id uuid primary key default gen_random_uuid(), client_id text not null, started_at timestamptz not null default now());
${with254 ? `create table public.phone_voicemails (
  id uuid primary key default gen_random_uuid(), call_id uuid not null unique references public.phone_calls(id) on delete cascade,
  client_id text not null, transcript text, deleted_at timestamptz, created_at timestamptz not null default now()
);` : `create table public.phone_voicemails (id uuid primary key default gen_random_uuid(), call_id uuid not null, client_id text not null);`}
`;

// Every database is closed at the end and the process then exits by itself (process.exitCode, not
// process.exit): on Windows, process.exit() with PGlite still winding down tripped libuv's
// "UV_HANDLE_CLOSING" assertion after ALL CHECKS PASSED (migration298.test.cjs).
const opened = [];
async function makeDb(opts) {
  const db = new PGlite({ extensions: { pg_trgm } });
  opened.push(db);
  await db.exec(STUBS(opts));
  return db;
}
async function apply(db, sql) {
  const notices = [];
  const out = await db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
  const record = [...out].reverse().find((r) => r.rows && r.rows.length && r.fields.some((f) => f.name === "migration"));
  return { notices, record: record ? record.rows[0] : null };
}

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const indexCount = async (db) => (await one(db, `select count(*)::int n from pg_class where relname = any($1)`, [INDEXES])).n;

// A business's worth of rows, with the shapes a search meets: case, a word inside a word, NULLs.
async function seed(db) {
  await db.exec(`
    insert into public.crm_contacts (client_id, name)
      select 't1', case when g % 50 = 0 then 'Jordan Barnes ' || g when g % 7 = 0 then null else 'Pat ' || g end from generate_series(1, 3000) g;
    insert into public.sms_messages (client_id, direction, from_number, to_number, body)
      select 't1', 'in', '+15555550142', '+15555550100',
             case when g % 97 = 0 then 'About the lean-to and the BARN ' || g when g % 11 = 0 then null else 'see you ' || g end
        from generate_series(1, 4000) g;
    insert into public.phone_calls (client_id) select 't1' from generate_series(1, 600);
    insert into public.phone_voicemails (call_id, client_id, transcript)
      select id, 't1', case when row_number() over () % 9 = 0 then 'Hi, it is about the barn estimate' else null end from public.phone_calls;
    analyze;
  `);
}
const SEARCHES = [
  ["sms_messages", "body", "barn"],
  ["sms_messages", "body", "lean-to"],
  ["sms_messages", "body", "you 12"],
  ["crm_contacts", "name", "jordan"],
  ["crm_contacts", "name", "arne"],
  ["phone_voicemails", "transcript", "BARN EST"],
];
async function searchIds(db, table, col, term, seqscan) {
  await db.exec(`set enable_seqscan = ${seqscan ? "on" : "off"}`);
  const rows = (await db.query(`select id::text from public.${table} where ${col} ilike '%' || $1 || '%' order by id`, [term])).rows.map((r) => r.id);
  await db.exec("reset enable_seqscan");
  return rows;
}

(async () => {
  console.log("migration 304: applies");
  const db = await makeDb();
  await seed(db);
  let res;
  try { res = await apply(db, M304()); ok(true, "304 applied cleanly, checks included"); }
  catch (e) { ok(false, "304 applied", e.message); process.exitCode = 1; return; }
  ok(res.notices.some((n) => /304: checks hold/.test(n)), "the checks ran to their notice", res.notices.join(" | "));
  const R = res.record || {};
  ok(R.indexes === INDEXES.join(","), "RECORD: the three trigram indexes, valid", JSON.stringify(R));
  ok(R.trgm_schema === "extensions", "RECORD: pg_trgm created in extensions", R.trgm_schema);
  ok(R.planner_uses && R.planner_uses.split(",").sort().join(",") === INDEXES.join(","), "RECORD: the planner uses each for ilike '%term%'", R.planner_uses);
  ok((await one(db, "select current_setting('enable_seqscan') v")).v === "on", "sequential scans are back on after the checks");

  console.log("a search answers the same with the index as without it");
  for (const [table, col, term] of SEARCHES) {
    const withIndex = await searchIds(db, table, col, term, false);
    const without = await searchIds(db, table, col, term, true);
    ok(withIndex.length > 0 && withIndex.join() === without.join(), `${table}.${col} ilike '%${term}%': ${withIndex.length} rows either way`);
  }
  await db.exec("set enable_seqscan = off");
  const plan = (await db.query("explain select id from public.sms_messages where client_id = 't1' and body ilike '%lean-to%'")).rows.map((r) => r["QUERY PLAN"]).join("\n");
  await db.exec("reset enable_seqscan");
  ok(/sms_messages_body_trgm/.test(plan), "the Worker's own shape (client_id = and body ilike) can use it", plan);

  try { await apply(db, M304()); ok(true, "304 re-applies cleanly"); } catch (e) { ok(false, "304 re-applies", e.message); }
  ok(await indexCount(db) === 3, "still one of each");

  console.log("pg_trgm already installed elsewhere");
  const pub = await makeDb({ trgmIn: "public" });
  try {
    const r = await apply(pub, M304());
    ok(r.record && r.record.trgm_schema === "public" && r.record.indexes === INDEXES.join(","), "the copy in public is used as it is", JSON.stringify(r.record));
  } catch (e) { ok(false, "304 applies with pg_trgm in public", e.message); }

  console.log("the rehearsal changes nothing");
  const dry = await makeDb();
  const rehearsal = M304().replace(/commit;\s*$/, "rollback;\n");
  ok(rehearsal !== M304(), "the rehearsal swaps the last commit");
  const dr = await apply(dry, rehearsal);
  ok(dr.record && dr.record.indexes === INDEXES.join(","), "the rehearsal prints the same record", JSON.stringify(dr.record));
  ok(await indexCount(dry) === 0, "and leaves no index");
  ok((await one(dry, "select count(*)::int n from pg_extension where extname = 'pg_trgm'")).n === 0, "and no extension");

  console.log("without 254");
  const bare = await makeDb({ with254: false });
  try { await apply(bare, M304()); ok(false, "a database without phone_voicemails.transcript is refused", "it committed"); }
  catch (e) {
    ok(/migration 254 not applied/.test(e.message), "a database without phone_voicemails.transcript is refused before anything changes", e.message);
    await bare.exec("rollback");
    ok(await indexCount(bare) === 0 && (await one(bare, "select count(*)::int n from pg_extension where extname = 'pg_trgm'")).n === 0, "  and left nothing behind");
  }

  console.log("304 mutants");
  const src = M304();
  for (const [label, mutate, re] of [
    ["a b-tree, which cannot serve a leading wildcard", (s) => s.replace("on public.sms_messages using gin (body %s)', v_ops)", "on public.sms_messages using btree (body)')"), /sms_messages_body_trgm should be a valid GIN/],
    ["the wrong column", (s) => s.replace("on public.phone_voicemails using gin (transcript %s)", "on public.phone_voicemails using gin (client_id %s)"), /phone_voicemails_transcript_trgm should be/],
    ["a partial index (only some names)", (s) => s.replace("using gin (name %s)', v_ops)", "using gin (name %s) where merged_into is null', v_ops)"), /crm_contacts_name_trgm should be/],
  ]) {
    const mm = mutate(src);
    if (mm === src) { ok(false, `mutant "${label}" changed nothing (the source moved; update the test)`); continue; }
    const mdb = await makeDb();
    try { await apply(mdb, mm); ok(false, `mutant "${label}" was refused`, "it committed"); }
    catch (e) {
      ok(re.test(e.message), `mutant "${label}" was refused`, e.message);
      await mdb.exec("rollback");
      ok(await indexCount(mdb) === 0, "  and left nothing behind");
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { for (const db of opened) await db.close().catch(() => {}); });
