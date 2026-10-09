// Execute migration 297 for real in PGlite (Postgres compiled to WASM, in memory) on a database
// whose default privileges hand every new table to the browser roles (as Supabase's do), then check
// what it promises: phone_number_requests is service-role only (RLS on, NOT forced, no policy, no
// table or column privilege for anon / authenticated, no foreign key); a request as the code writes
// it is stored; what must never be stored is refused (no numbers, more than ten, a NULL number, a
// number that is not +1 E.164, five digits in a free-text box even spaced or dashed, any digit after
// PIN / acct / account, a bad email or status), while dates and times in the timing note and a
// carrier whose name merely contains "pin" are stored (review 2026-10-09); the apply-time rehearsal
// leaves nothing behind; a re-apply is harmless; broken copies are refused (mutants).
// Nothing here touches the live project.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration297.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(path.join(WT, "supabase/migrations/297_phone_number_requests.sql"), "utf8").replace(/\r/g, "");

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`;
// Every database is closed at the end and the process then exits by itself (process.exitCode, not
// process.exit): on Windows, process.exit() with PGlite still winding down tripped libuv's
// "UV_HANDLE_CLOSING" assertion after ALL CHECKS PASSED and turned the pass into exit 127.
const opened = [];
async function makeDb() {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
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
async function refused(db, sql, params, pattern) {
  try { await db.query(sql, params); return { refused: false, message: "(accepted)" }; }
  catch (e) { return { refused: !pattern || pattern.test(e.message), message: e.message }; }
}
async function as(db, role, fn) {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
const INSERT = "insert into public.phone_number_requests (client_id, numbers, current_carrier, is_lc_phone, contact_name, contact_email, cutover_window) values ($1, $2, $3, $4, $5, $6, $7)";
const good = () => ["some-builder", ["+18165550123"], "Verizon", false, "Pat Example", "pat@builder.example.test", "after the 20th"];

(async () => {
  console.log("migration 297: applies");
  const db = await makeDb();
  let res;
  try { res = await apply(db); ok(true, "297 applied cleanly, checks and rehearsal included"); }
  catch (e) { ok(false, "297 applied", e.message); process.exit(1); }
  ok(res.notices.some((n) => /297: checks hold/.test(n)), "the checks ran to their notice", res.notices.join(" | "));
  const R = res.record || {};
  ok(R.table_ready === true && R.rows === 0, "RECORD: table_ready, no rows", JSON.stringify(R));
  ok(R.rehearsal === "a request stored; empty, non-E.164 and malformed numbers, digit runs and a bad status refused", "RECORD: the rehearsal ran to its end", R.rehearsal);

  console.log("what is stored, and what never is");
  ok(!(await refused(db, INSERT, good())).refused, "a request as the code writes it is stored");
  const r = await one(db, "select status, is_lc_phone, numbers from public.phone_number_requests");
  ok(r.status === "new" && r.is_lc_phone === false && r.numbers.join() === "+18165550123", "status starts 'new' (the operator's notification)", JSON.stringify(r));
  ok(!(await refused(db, INSERT, ["some-builder", ["+18165550123", "+18165550124"], "GoHighLevel", null, "Pat Example", "pat@builder.example.test", null])).refused, "two numbers, 'not sure', no window: stored");
  for (const [what, mutate] of [
    ["dates and times in the window", (g) => { g[6] = "after 10/20/2026, 9am-5pm, or 2026-10-27 at 17:00"; }],
    ["a carrier whose name contains 'pin'", (g) => { g[2] = "Pinnacle Telecom"; }],
    ["a year and a short count in the carrier", (g) => { g[2] = "AT&T 2025 plan, 3 lines"; }],
  ]) {
    const g = good(); mutate(g);
    const x = await refused(db, INSERT, g);
    ok(!x.refused, `stores ${what}`, x.message);
  }
  const bad = [
    ["no numbers", (g) => { g[1] = []; }],
    ["eleven numbers", (g) => { g[1] = Array.from({ length: 11 }, (_, i) => `+1816555${String(1000 + i)}`); }],
    ["a number without +1", (g) => { g[1] = ["8165550123"]; }],
    ["a malformed number", (g) => { g[1] = ["+1816555012"]; }],
    ["a NULL number", (g) => { g[1] = ["+18165550123", null]; }],
    ["an account number in the carrier", (g) => { g[2] = "AT&T account 12345678"; }],
    ["a dashed account number in the carrier", (g) => { g[2] = "Verizon 1234-5678-9012"; }],
    ["a PIN in the window", (g) => { g[6] = "PIN is 88213"; }],
    ["a four-digit PIN in the window", (g) => { g[6] = "PIN 4829"; }],
    ["a dashed account number after acct in the window", (g) => { g[6] = "acct 287-123-456"; }],
    ["'account no. 4' in the window", (g) => { g[6] = "account no. 4"; }],
    ["'Acct #9' in the carrier", (g) => { g[2] = "Verizon Acct #9"; }],
    ["digits in the name", (g) => { g[4] = "Pat 55512"; }],
    ["a spaced PIN in the name", (g) => { g[4] = "Pat 48 29 13"; }],
    ["a bad email", (g) => { g[5] = "pat at example"; }],
    ["a bad slug", (g) => { g[0] = "Some Builder"; }],
  ];
  for (const [what, mutate] of bad) {
    const g = good(); mutate(g);
    const x = await refused(db, INSERT, g, /check constraint/);
    ok(x.refused, `refuses ${what}`, x.message);
  }
  ok((await refused(db, "update public.phone_number_requests set status = 'approved'", [], /check constraint/)).refused, "refuses a status outside new / in_progress / done / cancelled");

  console.log("privileges");
  for (const role of ["anon", "authenticated"]) {
    for (const sql of ["select * from public.phone_number_requests", "insert into public.phone_number_requests (client_id, numbers, current_carrier, contact_name, contact_email) values ('x', array['+18165550123'], 'v', 'Pat', 'p@e.test')"]) {
      const x = await as(db, role, () => refused(db, sql, [], /permission denied/));
      ok(x.refused, `${role} may not ${sql.slice(0, 6)}`, x.message);
    }
  }

  console.log("re-apply");
  const before = (await one(db, "select count(*)::int n from public.phone_number_requests")).n;
  try { await apply(db); ok(true, "297 re-applies cleanly"); } catch (e) { ok(false, "297 re-applies", e.message); }
  ok((await one(db, "select count(*)::int n from public.phone_number_requests")).n === before, "every request is still there");

  console.log("mutants");
  const src = MIG_TEXT();
  for (const [label, mutate, re] of [
    ["the browser roles keep the default grant", (s) => s.replace("revoke all on public.phone_number_requests from anon, authenticated;", ""), /anon holds SELECT on phone_number_requests/],
    ["RLS forced", (s) => s.replace("alter table public.phone_number_requests no force row level security;", "alter table public.phone_number_requests force row level security;"), /enabled and NOT forced/],
    ["a policy for the browser", (s) => s.replace("-- ── CHECKS", "create policy p on public.phone_number_requests for select to authenticated using (true);\n-- ── CHECKS"), /has a policy/],
    ["the secret words allowed in the window", (s) => s.replace("and cutover_window !~* '\\m(pin|", "and 'x' !~* '\\m(pin|"), /expected 13 refusals, got 12/],
    ["a NULL number allowed", (s) => s.replace("and array_position(numbers, null) is null", ""), /expected 13 refusals, got 12/],
    // Slash dates "taken out" as five digits: the rehearsal's own dated timing note is then refused.
    ["dates no longer taken out of the window", (s) => s.replace("([/.-][0-9]{2,4})?\\M', ' ', 'g')", "([/.-][0-9]{2,4})?\\M', '11111', 'g')"), /violates check constraint/],
  ]) {
    const mm = mutate(src);
    if (mm === src) { ok(false, `mutant "${label}" changed nothing (the source moved; update the test)`); continue; }
    const mdb = await makeDb();
    try { await apply(mdb, mm); ok(false, `mutant "${label}" was refused`, "it committed"); }
    catch (e) {
      ok(re.test(e.message), `mutant "${label}" was refused`, e.message);
      await mdb.exec("rollback");
      ok((await one(mdb, "select to_regclass('public.phone_number_requests') is null as gone")).gone, "  and left nothing behind");
    }
  }

  for (const d of opened) await d.close().catch(() => {});
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
