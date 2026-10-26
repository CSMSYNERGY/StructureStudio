// Execute migration 294 (release_notes.source_commit) for real in PGlite (Postgres compiled to WASM,
// in memory) on release_notes as 045, 103 and 114 built it (their own files, applied in order), and
// check what it promises:
//   * source_commit is a nullable text column; any number of hand-written rows stay NULL;
//   * a second row with the same sha is refused, and `on conflict (source_commit)` (what a PostgREST
//     upsert names) works;
//   * 103's status check, 045's grants and RLS policy are exactly what they were;
//   * a re-apply changes nothing, the rollback in the header removes it cleanly, and the closing
//     assertions really abort the file (mutants).
//
// Notes are made up. The repo is public: nothing real belongs here.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration294.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
const MIG = () => (process.env.MIG_FILE ? fs.readFileSync(process.env.MIG_FILE, "utf8") : read("294_release_notes_source_commit.sql")).replace(/\r/g, "");

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
alter default privileges in schema public grant all on tables to anon, authenticated;
`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;
async function fresh() {
  const db = new PGlite();
  await db.exec(STUBS);
  for (const f of ["045_release_notes.sql", "103_release_notes_beta_status.sql", "114_release_note_section.sql"]) await db.exec(read(f));
  await db.exec(`insert into public.release_notes (kind, title, status) values
    ('feature', 'A hand-written note about estimates', 'shipped'),
    ('fix', 'Another hand-written note on beta', 'beta');`);
  return db;
}
const posture = async (db) => JSON.stringify({
  checks: await rows(db, `select conname, pg_get_constraintdef(oid) def from pg_constraint
    where conrelid = 'public.release_notes'::regclass and contype = 'c' order by conname`),
  rls: (await one(db, "select relrowsecurity r, relforcerowsecurity f from pg_class where oid = 'public.release_notes'::regclass")),
  policies: await rows(db, "select policyname, roles::text, cmd, qual from pg_policies where tablename = 'release_notes' order by policyname"),
  grants: await rows(db, `select grantee, privilege_type from information_schema.role_table_grants
    where table_name = 'release_notes' and grantee in ('anon', 'authenticated') order by 1, 2`),
});
// One statement, outside any transaction: a failure rolls back just that statement.
async function refusal(db, sql) {
  try { await db.exec(sql); return null; } catch (e) { return e.message; }
}

(async () => {
  console.log("migration 294: applies on 045 + 103 + 114 and changes nothing else");
  {
    const db = await fresh();
    const before = await posture(db);
    const rowsBefore = JSON.stringify(await rows(db, "select * from public.release_notes order by created_at, title"));
    let applied = true;
    try { await db.exec(MIG()); } catch (e) { applied = false; ok(false, "294 applied", e.message); }
    ok(applied, "294 applied, its assertions included");

    const col = await one(db, `select data_type, is_nullable, column_default from information_schema.columns
      where table_name = 'release_notes' and column_name = 'source_commit'`);
    ok(col && col.data_type === "text" && col.is_nullable === "YES" && col.column_default === null, "source_commit is nullable text with no default", JSON.stringify(col));
    const after = await rows(db, "select * from public.release_notes order by created_at, title");
    ok(after.every((r) => r.source_commit === null) && JSON.stringify(after.map(({ source_commit: _s, ...r }) => r)) === rowsBefore,
      "every existing (hand-written) row reads NULL and is otherwise untouched");
    ok(await posture(db) === before, "103's status check, 045's grants, RLS and policy are exactly what they were");
    const priv = await one(db, `select has_column_privilege('authenticated', 'public.release_notes', 'source_commit', 'SELECT') rs,
      has_table_privilege('authenticated', 'public.release_notes', 'INSERT') ri,
      has_table_privilege('anon', 'public.release_notes', 'SELECT') an`);
    ok(priv.rs === true && priv.ri === false && priv.an === false, "authenticated can read the new column and still cannot write; anon has nothing", JSON.stringify(priv));

    ok(await refusal(db, `insert into public.release_notes (kind, title, status) values ('fix', 'A third hand-written note here', 'beta')`) === null,
      "more hand-written rows with a NULL source_commit go in (NULLs are distinct)");
    ok(await refusal(db, `insert into public.release_notes (kind, title, status, source_commit) values ('fix', 'Copied from a commit trailer', 'beta', '${SHA_A}')`) === null,
      "a row with a sha goes in, as status beta");
    const dup = await refusal(db, `insert into public.release_notes (kind, title, status, source_commit) values ('feature', 'A different title, same commit', 'beta', '${SHA_A}')`);
    ok(!!dup && /release_notes_source_commit_key/.test(dup), "a second row with the same sha is refused by the unique constraint", dup);
    const up = await rows(db, `insert into public.release_notes (kind, title, status, source_commit) values ('fix', 'Copied from a commit trailer', 'beta', '${SHA_A}')
      on conflict (source_commit) do nothing returning id`);
    ok(up.length === 0, "on conflict (source_commit) do nothing (a PostgREST upsert's target) finds the constraint and inserts nothing");
    ok(await refusal(db, `insert into public.release_notes (kind, title, status, source_commit) values ('fix', 'Status outside the ladder', 'live', '${SHA_B}')`) !== null,
      "103's status check still refuses a status outside its five");

    // Re-apply: a no-op
    const snapRows = JSON.stringify(await rows(db, "select * from public.release_notes order by created_at, title"));
    const snapPosture = await posture(db);
    let again = true;
    try { await db.exec(MIG()); } catch (e) { again = false; ok(false, "re-apply", e.message); }
    ok(again && JSON.stringify(await rows(db, "select * from public.release_notes order by created_at, title")) === snapRows && await posture(db) === snapPosture,
      "a re-apply passes and changes nothing");
    const cons = await rows(db, "select conname from pg_constraint where conrelid = 'public.release_notes'::regclass and contype = 'u'");
    ok(cons.length === 1 && cons[0].conname === "release_notes_source_commit_key", "exactly one unique constraint after two applies");

    // Rollback, as the header writes it
    const rb = MIG().split("\n").filter((l) => /^--   alter table public\.release_notes drop /.test(l)).map((l) => l.replace(/^--   /, ""));
    ok(rb.length === 2, "the rollback is lifted from the file's own header", rb.join(" / "));
    await db.exec(rb.join("\n"));
    const gone = await one(db, "select count(*)::int n from information_schema.columns where table_name = 'release_notes' and column_name = 'source_commit'");
    ok(gone.n === 0 && await posture(db) === before, "rollback: the column and constraint are gone, and the table's posture is what it was");
    await db.close();
  }

  console.log("migration 294: the assertions really abort (mutants)");
  for (const [label, from, to, re] of [
    ["a constraint over the wrong columns", "unique (source_commit);", "unique (source_commit, title);", /^294: release_notes_source_commit_key is not UNIQUE \(source_commit\)/],
    ["a NOT NULL column", "add column if not exists source_commit text;", "add column if not exists source_commit text not null default gen_random_uuid()::text;", /^294: release_notes\.source_commit is not a nullable text column/],
  ]) {
    const m = MIG().replace(from, to);
    ok(m !== MIG(), `the mutant (${label}) really changed the file`);
    const db = await fresh();
    const before = JSON.stringify(await rows(db, "select column_name from information_schema.columns where table_name = 'release_notes' order by 1"));
    let err = null;
    try { await db.exec(m); } catch (e) { err = e; }
    ok(!!err && re.test(err.message), `${label} stops the apply`, err ? err.message : "applied");
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    ok(JSON.stringify(await rows(db, "select column_name from information_schema.columns where table_name = 'release_notes' order by 1")) === before,
      `${label}: nothing of the apply is left`);
    await db.close();
  }
  {
    // 103's check changed by something else: 294 must notice rather than carry on.
    const db = await fresh();
    await db.exec(`alter table public.release_notes drop constraint release_notes_status_check;
      alter table public.release_notes add constraint release_notes_status_check check (status in ('shipped', 'beta'));`);
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /^294: release_notes_status_check is not 103's five statuses/.test(err.message), "a status check that is not 103's stops the apply", err ? err.message : "applied");
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    await db.close();
  }

  console.log("");
  if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
  console.log("ALL CHECKS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
