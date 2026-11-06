// Execute migration 307 for real in PGlite (Postgres compiled to WASM, in memory), on a
// phone_user_settings shaped like the live one (254 + 264's columns, its trigger, RLS on with no
// policy, service-role only), then check what it promises: three nullable columns with no
// default, both checks validated, nobody's answer made up, the browser roles still hold nothing,
// the Worker's save (upsert on user_id) and reads work as the service role, the shapes the checks
// must refuse are refused, the rehearsal leaves nothing behind, a re-apply is harmless, it refuses
// without 254, and broken copies (mutants) are refused. Nothing here touches the live project.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration307.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
//
// Every value here is an obviously fake fixture: this repo is public.
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const M307 = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/307_phone_ai_transcripts_consent.sql"), "utf8").replace(/\r/g, "");
const USER_1 = "00000000-0000-4000-8000-0000000000a1";
const USER_2 = "00000000-0000-4000-8000-0000000000b2";
const REHEARSAL = "allowed then declined saved; maybe, no version, version 0 and a stray version refused";

// The live shape (information_schema, 2026-10-13): 254 PART 3 plus 264's cover, hours and greeting.
const STUBS = ({ withTable = true, grantBrowser = false } = {}) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant select on tables to anon;
create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
${withTable ? `
create table public.phone_user_settings (
  user_id uuid primary key, client_id text not null, dnd boolean not null default false, dnd_until timestamptz,
  forward_to_cell text, device_generation integer not null default 1, updated_at timestamptz not null default now(),
  dnd_cover_user_id uuid, ring_hours jsonb, ring_hours_tz text, greeting_recording_sid text, greeting_updated_at timestamptz,
  constraint phone_user_settings_generation_positive check (device_generation >= 1)
);
create trigger phone_user_settings_set_updated_at before update on public.phone_user_settings for each row execute function public.set_updated_at();
alter table public.phone_user_settings enable row level security;
revoke all on public.phone_user_settings from public;
revoke all on public.phone_user_settings from anon, authenticated;
grant select, insert, update, delete on public.phone_user_settings to service_role;
${grantBrowser ? "grant select on public.phone_user_settings to authenticated;" : ""}
insert into public.phone_user_settings (user_id, client_id, dnd) values ('${USER_1}', 'demo-tenant', false);
` : ""}
`;

async function makeDb(opts) {
  const db = new PGlite();
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
async function refused(db, sql, pattern) {
  try { await db.exec(sql); return { refused: false, message: "(accepted)" }; }
  catch (e) { return { refused: !pattern || pattern.test(e.message), message: e.message }; }
  finally { try { await db.exec("reset role"); } catch (_e) { /* not in a role */ } }
}

(async () => {
  console.log("migration 307: the three columns");
  const early = await makeDb({ withTable: false });
  try { await apply(early, M307()); ok(false, "307 without phone_user_settings is refused", "it committed"); }
  catch (e) { ok(/migration 254 not applied/.test(e.message), "307 without phone_user_settings is refused", e.message); }

  const db = await makeDb();
  let res;
  try { res = await apply(db, M307()); ok(true, "307 applied cleanly"); }
  catch (e) { ok(false, "307 applied", e.message); process.exit(1); }
  const R = res.record || {};
  ok(R.columns === "ai_transcripts text,ai_transcripts_version smallint,ai_transcripts_at timestamp with time zone", "RECORD: the three columns, in order, with their types", R.columns);
  ok(R.rows_total === 1 && R.rows_answered === 0, "RECORD: 1 row, nobody's answer made up", JSON.stringify(R));
  ok(R.rehearsal === REHEARSAL, "RECORD: the rehearsal ran to its end", R.rehearsal);
  ok((await one(db, "select count(*)::int n from public.phone_user_settings where user_id = '00000000-0000-4000-8000-00000000c307'")).n === 0, "the rehearsal left no row");
  const row = await one(db, `select ai_transcripts, ai_transcripts_version, ai_transcripts_at, dnd from public.phone_user_settings where user_id = '${USER_1}'`);
  ok(row.ai_transcripts === null && row.ai_transcripts_version === null && row.ai_transcripts_at === null && row.dnd === false, "the existing row reads 'never answered' and kept its settings");

  console.log("the Worker's writes and reads, as the service role");
  await db.exec("set role service_role");
  // POST /settings/me/ai-transcripts: upsert on user_id, only the person's own columns.
  const save = (user, choice) => db.query(
    `insert into public.phone_user_settings (user_id, client_id, updated_at, ai_transcripts, ai_transcripts_version, ai_transcripts_at)
       values ($1, 'demo-tenant', now(), $2, 1, now())
     on conflict (user_id) do update set updated_at = excluded.updated_at, ai_transcripts = excluded.ai_transcripts,
       ai_transcripts_version = excluded.ai_transcripts_version, ai_transcripts_at = excluded.ai_transcripts_at
     returning ai_transcripts, ai_transcripts_version, ai_transcripts_at`, [user, choice]);
  const s1 = (await save(USER_1, "allowed")).rows[0];
  ok(s1.ai_transcripts === "allowed" && s1.ai_transcripts_version === 1 && s1.ai_transcripts_at, "an existing row saves a yes");
  const s2 = (await save(USER_2, "declined")).rows[0];
  ok(s2.ai_transcripts === "declined", "a person with no row yet saves a no (the row is created)");
  ok((await one(db, `select dnd, device_generation from public.phone_user_settings where user_id = '${USER_2}'`)).device_generation === 1, "  and their new row takes the table's defaults");
  // src/aiConsent.ts consentedCalls: the answers of the people on the calls.
  const read = (await db.query(`select user_id, ai_transcripts, ai_transcripts_version, ai_transcripts_at from public.phone_user_settings where user_id in ($1, $2) order by user_id`, [USER_1, USER_2])).rows;
  ok(read.length === 2 && read[0].ai_transcripts === "allowed" && read[1].ai_transcripts === "declined", "the tick's read: both answers");
  await db.exec("reset role");

  console.log("the checks refuse what the Worker never writes");
  for (const [label, sql] of [
    ["an answer other than allowed / declined", `update public.phone_user_settings set ai_transcripts = 'yes' where user_id = '${USER_1}'`],
    ["an answer with no version", `update public.phone_user_settings set ai_transcripts_version = null where user_id = '${USER_1}'`],
    ["version 0", `update public.phone_user_settings set ai_transcripts_version = 0 where user_id = '${USER_1}'`],
    ["an answer with no time", `update public.phone_user_settings set ai_transcripts_at = null where user_id = '${USER_1}'`],
    ["a version and time with no answer", `update public.phone_user_settings set ai_transcripts = null where user_id = '${USER_1}'`],
    ["a new row with an answer and nothing else", `insert into public.phone_user_settings (user_id, client_id, ai_transcripts) values ('00000000-0000-4000-8000-0000000000c3', 'demo-tenant', 'allowed')`],
  ]) {
    const r = await refused(db, sql, /violates check constraint "phone_user_settings_ai_transcripts_(chk|whole)"/);
    ok(r.refused, `refused: ${label}`, r.message);
  }
  ok((await db.query(`update public.phone_user_settings set ai_transcripts = null, ai_transcripts_version = null, ai_transcripts_at = null where user_id = '${USER_1}' returning user_id`)).rows.length === 1, "clearing all three together is allowed");

  console.log("the browser roles hold nothing on them");
  for (const role of ["anon", "authenticated"]) {
    const r = await refused(db, `set role ${role}; select ai_transcripts from public.phone_user_settings`, /permission denied/);
    ok(r.refused, `${role} cannot read an answer`, r.message);
    const w = await refused(db, `set role ${role}; update public.phone_user_settings set ai_transcripts = 'allowed', ai_transcripts_version = 1, ai_transcripts_at = now()`, /permission denied/);
    ok(w.refused, `${role} cannot write one`, w.message);
  }

  console.log("a re-apply");
  await db.exec("set role service_role");
  await save(USER_2, "allowed");
  await db.exec("reset role");
  try {
    const again = await apply(db, M307());
    ok(again.record && again.record.rows_answered === 1 && again.record.rehearsal === REHEARSAL, "a re-apply after someone answered passes, and keeps the answer", JSON.stringify(again.record));
  } catch (e) { ok(false, "a re-apply after someone answered passes", e.message); }
  ok((await one(db, `select ai_transcripts from public.phone_user_settings where user_id = '${USER_2}'`)).ai_transcripts === "allowed", "  the saved answer is still there");
  const fresh = await makeDb();
  await apply(fresh, M307());
  try { const again = await apply(fresh, M307()); ok(again.record && again.record.rehearsal === REHEARSAL, "a re-apply before anyone answered passes straight through"); }
  catch (e) { ok(false, "a re-apply before anyone answered passes straight through", e.message); }

  console.log("307 mutants");
  const src = M307();
  for (const [label, mutate, re, opts] of [
    ["the browser roles already hold the table", (s) => s, /authenticated holds SELECT on phone_user_settings\.ai_transcripts/, { grantBrowser: true }],
    ["the answer check never added", (s) => s.replace("check (ai_transcripts is null or ai_transcripts in ('allowed', 'declined')) not valid;", "check (true) not valid;"), /an answer other than allowed \/ declined was accepted/],
    ["everyone backfilled as allowed", (s) => s.replace("-- ── CHECKS: raise", "update public.phone_user_settings set ai_transcripts = 'allowed', ai_transcripts_version = 1, ai_transcripts_at = now();\n-- ── CHECKS: raise"), /the number of answers moved \(0 before, 1 now\)/],
    // A default fills the existing row with an answer and no version: the validation stops it.
    ["a default of allowed", (s) => s.replace("add column if not exists ai_transcripts         text,", "add column if not exists ai_transcripts         text default 'allowed',"), /phone_user_settings_ai_transcripts_whole" of relation "phone_user_settings" is violated by some row/],
    ["the version check loosened to 0", (s) => s.replace("ai_transcripts_version is not null and ai_transcripts_version >= 1", "ai_transcripts_version is not null and ai_transcripts_version >= 0"), /notice version 0 was accepted/],
    ["the whole check letting a NULL version through", (s) => s.replace("ai_transcripts is not null and ai_transcripts_version is not null and ai_transcripts_version >= 1", "ai_transcripts is not null and ai_transcripts_version >= 1"), /an answer with no notice version was accepted/],
  ]) {
    const mm = mutate(src);
    if (!opts && mm === src) { ok(false, `mutant "${label}" changed nothing (the source moved; update the test)`); continue; }
    const mdb = await makeDb(opts);
    try { await apply(mdb, mm); ok(false, `mutant "${label}" was refused`, "it committed"); }
    catch (e) {
      ok(re.test(e.message), `mutant "${label}" was refused`, e.message);
      await mdb.exec("rollback").catch(() => {});
      ok((await one(mdb, "select count(*)::int n from information_schema.columns where table_name = 'phone_user_settings' and column_name like 'ai\\_transcripts%'")).n === 0, "  and nothing of it stayed");
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
