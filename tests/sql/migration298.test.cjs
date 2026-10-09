// Execute migration 298 for real in PGlite (Postgres compiled to WASM, in memory) on a
// twilio_usage_daily shaped like the live one (259 + 292's account_sid), then check step 1 of the
// order that keeps the phone-api Worker's 09:00 UTC run working (Workstream 2, phase 7; step 2 is
// 299, tests/sql/migration299.test.cjs):
//   298: the new key UNIQUE NULLS NOT DISTINCT (day, account_sid, category) sits BESIDE the old
//        primary key; the old Worker's upsert (day, category) and the new one's (day, account_sid,
//        category) both refresh the parent's one row; a sub-account row beside the parent's is still
//        refused (it waits for 299); nothing moves; a re-apply is harmless; without 292 it refuses;
//        broken copies are refused (mutants);
// Nothing here touches the live project.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration298.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const M298 = () => fs.readFileSync(path.join(WT, "supabase/migrations/298_twilio_usage_account_key.sql"), "utf8").replace(/\r/g, "");
const M299 = () => fs.readFileSync(path.join(WT, "supabase/migrations/299_twilio_usage_drop_day_key.sql"), "utf8").replace(/\r/g, "");
const SUB = "AC" + "5".repeat(32);

const STUBS = (with292) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create table public.twilio_usage_daily (
  day date not null, category text not null, count numeric, usage numeric, price_micros bigint,
  fetched_at timestamptz not null default now(), primary key (day, category)
);
revoke all on public.twilio_usage_daily from public;
revoke all on public.twilio_usage_daily from anon, authenticated;
grant select, insert, update, delete on public.twilio_usage_daily to service_role;
${with292 ? `alter table public.twilio_usage_daily add column account_sid text;
alter table public.twilio_usage_daily add constraint twilio_usage_daily_account_sid_chk check (account_sid is null or account_sid ~ '^AC[0-9a-fA-F]{32}$');` : ""}
insert into public.twilio_usage_daily (day, category, count, price_micros) values
  ('2026-10-07', 'calls-outbound', 12, 434000), ('2026-10-07', 'sms-outbound', 40, 332000), ('2026-10-08', 'calls-outbound', 3, 42000);
`;

async function makeDb({ with292 = true } = {}) {
  const db = new PGlite();
  await db.exec(STUBS(with292));
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
  try { await db.query(sql); return { refused: false, message: "(accepted)" }; }
  catch (e) { return { refused: !pattern || pattern.test(e.message), message: e.message }; }
}
// The two upserts the Worker sends, as PostgREST writes them.
const oldWorker = (day, cat, count) => `insert into public.twilio_usage_daily (day, category, count) values ('${day}', '${cat}', ${count}) on conflict (day, category) do update set count = excluded.count`;
const newParent = (day, cat, count) => `insert into public.twilio_usage_daily (day, category, count) values ('${day}', '${cat}', ${count}) on conflict (day, account_sid, category) do update set count = excluded.count`;
const newSub = (day, cat, count) => `insert into public.twilio_usage_daily (day, account_sid, category, count) values ('${day}', '${SUB}', '${cat}', ${count}) on conflict (day, account_sid, category) do update set count = excluded.count`;
const countRows = async (db, where = "true") => (await one(db, `select count(*)::int n from public.twilio_usage_daily where ${where}`)).n;

(async () => {
  console.log("migration 298: the new key beside the old one");
  const db = await makeDb();
  let res;
  try { res = await apply(db, M298()); ok(true, "298 applied cleanly, checks and rehearsal included"); }
  catch (e) { ok(false, "298 applied", e.message); process.exit(1); }
  ok(res.notices.some((n) => /298: checks hold/.test(n)), "the checks ran to their notice", res.notices.join(" | "));
  const R = res.record || {};
  ok(R.account_key === "day,account_sid,category" && R.nulls_not_distinct === true && R.usage_pk === "day,category" && R.rows === 3,
    "RECORD: the new key, NULLS NOT DISTINCT, the old key still there, 3 rows", JSON.stringify(R));
  ok(R.rehearsal === "both upserts refresh one parent row; a sub row waits for 299", "RECORD: the rehearsal ran to its end", R.rehearsal);

  await db.query(oldWorker("2026-10-08", "calls-outbound", 4));
  ok(await countRows(db, "day = '2026-10-08'") === 1 && (await one(db, "select count::int c from public.twilio_usage_daily where day = '2026-10-08'")).c === 4, "the OLD Worker's upsert still refreshes the day");
  await db.query(newParent("2026-10-08", "calls-outbound", 5));
  await db.query(newParent("2026-10-08", "calls-outbound", 6));
  ok(await countRows(db, "day = '2026-10-08'") === 1 && (await one(db, "select count::int c from public.twilio_usage_daily where day = '2026-10-08'")).c === 6, "the NEW Worker's upsert refreshes the same one parent row (NULL matches NULL)");
  const r1 = await refused(db, newSub("2026-10-08", "calls-outbound", 1), /twilio_usage_daily_pkey|duplicate key/);
  ok(r1.refused, "a sub-account row beside the parent's is refused while the old key is there", r1.message);
  ok((await refused(db, newSub("2026-10-08", "sms-inbound", 1))).refused === false, "a sub row for a category the parent lacks still fits (each key holds)");
  await db.query("delete from public.twilio_usage_daily where account_sid is not null");

  try { await apply(db, M298()); ok(true, "298 re-applies cleanly"); } catch (e) { ok(false, "298 re-applies", e.message); }
  ok((await one(db, "select count(*)::int n from pg_constraint where conname = 'twilio_usage_daily_account_key'")).n === 1, "still one account key");

  const bare = await makeDb({ with292: false });
  try { await apply(bare, M298()); ok(false, "a database without 292 is refused", "it committed"); }
  catch (e) { ok(/migration 292 not applied/.test(e.message), "a database without 292 is refused before anything is changed", e.message); }

  console.log("298 mutants");
  const src = M298();
  for (const [label, mutate, re] of [
    ["a plain unique key (NULLs distinct)", (s) => s.replace("unique nulls not distinct (day, account_sid, category)", "unique (day, account_sid, category)"), /must be NULLS NOT DISTINCT/],
    ["the old key dropped too early", (s) => s.replace("comment on constraint twilio_usage_daily_account_key", "alter table public.twilio_usage_daily drop constraint twilio_usage_daily_pkey;\ncomment on constraint twilio_usage_daily_account_key"), /old primary key \(day, category\) must still be there/],
    ["the browser granted the table", (s) => s.replace("notify pgrst, 'reload schema';", "notify pgrst, 'reload schema';").replace("do $check$", "grant select on public.twilio_usage_daily to anon;\ndo $check$"), /anon holds SELECT/],
  ]) {
    const mm = mutate(src);
    if (mm === src) { ok(false, `mutant "${label}" changed nothing (the source moved; update the test)`); continue; }
    const mdb = await makeDb();
    try { await apply(mdb, mm); ok(false, `mutant "${label}" was refused`, "it committed"); }
    catch (e) {
      ok(re.test(e.message), `mutant "${label}" was refused`, e.message);
      await mdb.exec("rollback");
      ok((await one(mdb, "select count(*)::int n from pg_constraint where conname = 'twilio_usage_daily_account_key'")).n === 0, "  and left nothing behind");
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
