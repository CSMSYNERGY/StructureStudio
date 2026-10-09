// Execute migration 297 for real in PGlite (Postgres compiled to WASM, in memory) on an sms_numbers
// shaped like the live one (165 + 255), then check what it promises: three NULLable text columns
// with no default; the CNAM status takes 255's vocabulary only, the SID only a BU… SID, and the
// display name only Twilio's rules (1-15 of letters, numbers, spaces, periods, commas, starting with
// a letter); the apply-time probe leaves no row behind; the browser roles still hold nothing; a
// re-apply is harmless; a database without 255 is refused; and broken copies are refused (mutants).
// Nothing here touches the live project.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration297.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of 297.
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_PATH = process.env.MIG_FILE || path.join(WT, "supabase/migrations/297_twilio_cnam.sql");
const MIG_TEXT = () => fs.readFileSync(MIG_PATH, "utf8").replace(/\r/g, "");

const STUBS = (with255) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table public.sms_numbers (
  id uuid primary key default gen_random_uuid(), client_id text not null, phone_number text not null,
  twilio_sid text, messaging_service_sid text, registration_status text not null default 'pending_registration',
  purchased_at timestamptz not null default now(), released_at timestamptz, created_at timestamptz not null default now()
  ${with255 ? `, shaken_trust_product_sid text, shaken_status text, voice_integrity_trust_product_sid text,
  voice_integrity_status text, caller_id_checked_at timestamptz, caller_id_lock_until timestamptz` : ""}
);
create unique index sms_numbers_live_unique on public.sms_numbers (phone_number) where released_at is null;
revoke all on public.sms_numbers from anon, authenticated;
insert into public.sms_numbers (client_id, phone_number) values ('some-builder', '+15555550111');
`;

async function makeDb({ with255 = true } = {}) {
  const db = new PGlite();
  await db.exec(STUBS(with255));
  return db;
}
async function apply(db, sql = MIG_TEXT()) {
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
  try { await db.query(sql); return { refused: false, message: "(accepted)" }; }
  catch (e) { return { refused: !pattern || pattern.test(e.message), message: e.message }; }
}

(async () => {
  console.log("migration 297: applies on 165 + 255");
  const db = await makeDb();
  let res;
  try { res = await apply(db); ok(true, "297 applied cleanly, checks and probe included"); }
  catch (e) { ok(false, "297 applied", e.message); process.exit(1); }
  ok(res.notices.some((n) => /297: checks hold/.test(n)), "the checks ran to their notice", res.notices.join(" | "));
  const R = res.record || {};
  ok(R.columns_added === 3 && R.constraints === 3 && R.rows_with_cnam === 0, "RECORD: 3 columns, 3 constraints, no row with CNAM", JSON.stringify(R));
  ok(/^six bad values refused, a real SID, status and two real names taken, probe removed$/.test(String(R.probe)), "RECORD: the probe ran to its end", R.probe);
  ok((await one(db, "select count(*)::int n from public.sms_numbers")).n === 1, "the probe row is gone and the real row stays");

  console.log("the rules");
  const id = (await one(db, "select id from public.sms_numbers limit 1")).id;
  const set = (frag) => `update public.sms_numbers set ${frag} where id = '${id}'`;
  for (const [frag, what] of [
    ["cnam_status = 'approved'", "a status outside Twilio's enum"],
    ["cnam_trust_product_sid = 'BU12'", "a malformed SID"],
    ["cnam_display_name = 'ABCDEFGHIJKLMNOP'", "16 characters"],
    ["cnam_display_name = '1 Barns'", "a name starting with a digit"],
    ["cnam_display_name = 'Barns & Co'", "an ampersand"],
    ["cnam_display_name = ''", "an empty name"],
  ]) {
    const r = await refused(db, set(frag), /check constraint/);
    ok(r.refused, `refuses ${what}`, r.message);
  }
  for (const frag of [
    "cnam_status = 'twilio-approved', cnam_trust_product_sid = 'BU" + "f".repeat(32) + "'",
    "cnam_display_name = 'ABCDEFGHIJKLMNO'",
    "cnam_display_name = 'Acme Barns, LLC'",
    "cnam_display_name = 'J.R. Sheds 2'",
    "cnam_status = null, cnam_trust_product_sid = null, cnam_display_name = null",
  ]) {
    const r = await refused(db, set(frag));
    ok(!r.refused, `takes ${frag}`, r.message);
  }

  console.log("privileges and shape");
  for (const role of ["anon", "authenticated"]) {
    for (const col of ["cnam_trust_product_sid", "cnam_status", "cnam_display_name"]) {
      const has = await one(db, `select has_column_privilege('${role}', 'public.sms_numbers', '${col}', 'SELECT') as h`);
      ok(has.h === false, `${role} cannot read ${col}`);
    }
  }
  const cols = (await db.query("select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'sms_numbers' and column_name like 'cnam%' order by 1")).rows;
  ok(cols.length === 3 && cols.every((c) => c.data_type === "text" && c.is_nullable === "YES" && c.column_default === null), "three nullable text columns, no default", JSON.stringify(cols));

  console.log("re-apply");
  try { await apply(db); ok(true, "297 re-applies cleanly"); } catch (e) { ok(false, "297 re-applies", e.message); }
  ok((await one(db, "select count(*)::int n from pg_constraint where conname like 'sms_numbers_cnam%'")).n === 3, "still exactly three constraints");

  console.log("without 255");
  const bare = await makeDb({ with255: false });
  try { await apply(bare); ok(false, "a database without 255 is refused", "it committed"); }
  catch (e) { ok(/migration 255 not applied/.test(e.message), "a database without 255 is refused before anything is changed", e.message); }

  console.log("mutants");
  const src = MIG_TEXT();
  const mutants = [
    ["no display-name rule", (s) => s.replace(/alter table public\.sms_numbers add constraint sms_numbers_cnam_display_name_chk\n\s+check \(cnam_display_name is null\n\s+or \(char_length\(cnam_display_name\) between 1 and 15 and cnam_display_name ~ '\^\[A-Za-z\]\[A-Za-z0-9\., \]\*\$'\)\);/, "null;"), /sms_numbers_cnam_display_name_chk is missing|probe expected 6 refusals/],
    ["a 16-character name allowed", (s) => s.replace("between 1 and 15", "between 1 and 16"), /probe expected 6 refusals/],
    ["a default on the status", (s) => s.replace("add column if not exists cnam_status            text,", "add column if not exists cnam_status            text default 'draft',"), /has a default|already holds a value/],
    ["anon granted the name", (s) => s.replace("do $assert$", "grant select (cnam_display_name) on public.sms_numbers to anon;\ndo $assert$"), /anon holds column SELECT/],
  ];
  for (const [label, mutate, re] of mutants) {
    const mm = mutate(src);
    if (mm === src) { ok(false, `mutant "${label}" changed nothing (the source moved; update the test)`); continue; }
    const mdb = await makeDb();
    try { await apply(mdb, mm); ok(false, `mutant "${label}" was refused`, "it committed"); }
    catch (e) {
      ok(re.test(e.message), `mutant "${label}" was refused`, e.message);
      await mdb.exec("rollback");
      ok((await one(mdb, "select count(*)::int n from information_schema.columns where table_name = 'sms_numbers' and column_name like 'cnam%'")).n === 0, "  and left nothing behind");
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
