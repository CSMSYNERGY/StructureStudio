// Execute migration 300 for real in PGlite (Postgres compiled to WASM, in memory), on a
// twilio_usage_daily shaped like the live one (259 + 292's account_sid) with 299 applied first, then
// check step 2 of the order that keeps the phone-api Worker's 09:00 UTC run working (Workstream 2,
// phase 7; step 1 is 299, tests/sql/migration299.test.cjs):
//   300: refuses without 299 and for a published table; drops the old key; then a parent row and a
//        sub row for the same day and category sit side by side, one each, the parent's NULL still
//        matches itself; the old Worker's upsert now fails (42P10), which is why SETUP 7f puts the new
//        Worker first; broken copies are refused.
// Nothing here touches the live project.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration300.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const M299 = () => fs.readFileSync(path.join(WT, "supabase/migrations/299_twilio_usage_account_key.sql"), "utf8").replace(/\r/g, "");
const M300 = () => fs.readFileSync(path.join(WT, "supabase/migrations/300_twilio_usage_drop_day_key.sql"), "utf8").replace(/\r/g, "");
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
  const db = await makeDb();
  await apply(db, M299());
  let res;
  console.log("migration 300: the old key goes");
  const early = await makeDb();
  try { await apply(early, M300()); ok(false, "300 without 299 is refused", "it committed"); }
  catch (e) { ok(/migration 299 not applied/.test(e.message), "300 without 299 is refused", e.message); }
  const pub = await makeDb();
  await apply(pub, M299());
  let pubMade = true;
  try { await pub.exec("create publication m300_test for table public.twilio_usage_daily"); } catch (_e) { pubMade = false; }
  if (pubMade) {
    try { await apply(pub, M300()); ok(false, "300 on a published table is refused", "it committed"); }
    catch (e) { ok(/is in a publication/.test(e.message), "300 on a published table is refused", e.message); }
  } else {
    ok(true, "(PGlite has no publications here; the publication refusal is read from the source)");
    ok(/pg_publication_tables/.test(M300()) && /puballtables/.test(M300()), "  300 checks both kinds of publication");
  }

  try { res = await apply(db, M300()); ok(true, "300 applied cleanly after 299"); }
  catch (e) { ok(false, "300 applied", e.message); process.exit(1); }
  const S = res.record || {};
  ok(S.usage_pk === null && S.account_key === "day,account_sid,category" && S.rows === 3, "RECORD: no primary key, the account key, 3 rows", JSON.stringify(S));
  ok(S.rehearsal === "a parent and a sub row side by side, one each; a second parent row refused", "RECORD: the rehearsal ran to its end", S.rehearsal);
  await db.query(newParent("2026-10-08", "calls-outbound", 7));
  await db.query(newSub("2026-10-08", "calls-outbound", 1));
  await db.query(newSub("2026-10-08", "calls-outbound", 2));
  ok(await countRows(db, "day = '2026-10-08'") === 2, "a parent row and a sub row for the same day and category, one each");
  ok((await one(db, `select count::int c from public.twilio_usage_daily where day = '2026-10-08' and account_sid = '${SUB}'`)).c === 2, "the sub's row refreshed in place");
  const r2 = await refused(db, oldWorker("2026-10-08", "calls-outbound", 9), /no unique or exclusion constraint/);
  ok(r2.refused, "the OLD Worker's upsert now fails (42P10): it must be replaced BEFORE 300", r2.message);
  try { await apply(db, M300()); ok(true, "300 re-applies cleanly"); } catch (e) { ok(false, "300 re-applies", e.message); }

  console.log("300 mutants");
  const src9 = M300();
  for (const [label, mutate, re] of [
    ["the key never dropped", (s) => s.replace("execute format('alter table public.twilio_usage_daily drop constraint %I', v_name);", "null;"), /old primary key is still there/],
    ["the account key dropped instead", (s) => s.replace("where c.conrelid = 'public.twilio_usage_daily'::regclass and c.contype = 'p';\n  if v_name is not null", "where c.conrelid = 'public.twilio_usage_daily'::regclass and c.conname = 'twilio_usage_daily_account_key';\n  if v_name is not null"), /old primary key is still there|no unique or exclusion constraint/],
  ]) {
    const mm = mutate(src9);
    if (mm === src9) { ok(false, `mutant "${label}" changed nothing (the source moved; update the test)`); continue; }
    const mdb = await makeDb();
    await apply(mdb, M299());
    try { await apply(mdb, mm); ok(false, `mutant "${label}" was refused`, "it committed"); }
    catch (e) {
      ok(re.test(e.message), `mutant "${label}" was refused`, e.message);
      await mdb.exec("rollback");
      ok((await one(mdb, "select count(*)::int n from pg_constraint where conrelid = 'public.twilio_usage_daily'::regclass and contype = 'p'")).n === 1, "  and the old key is still there");
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
