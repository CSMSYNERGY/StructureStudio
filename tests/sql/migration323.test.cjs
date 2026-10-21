// Execute migration 323 for real in PGlite (Postgres compiled to WASM, in memory), on a
// twilio_accounts shaped like the live one (292 + 295: its kind / status checks, RLS on and not
// forced, no policy, nothing for the browser roles), then check what it promises:
//   * the two columns exist and start NULL for every row (nothing is filled by the migration);
//   * the constraints refuse what they should: a SID that is not VA + 32 hex, a name that is not
//     the sanitized shape (punctuation, a leading space, 31 characters), one without the other, and
//     a service on a kind 'parent' row (structure-studio keeps the parent's service);
//   * the browser roles reach neither column, Supabase's default privileges notwithstanding;
//   * a re-apply changes nothing, the rehearsal (commit swapped for rollback) leaves nothing, a CRLF
//     checkout applies the same, and a database without twilio_accounts is refused with 292 named.
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants and SIDs are made up. The repo is public.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration323.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const RAW = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/323_twilio_verify_service.sql"), "utf8");
const M323 = () => RAW().replace(/\r\n/g, "\n");

const ROLES = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`;
// 292's table, trimmed to the columns 323 sits beside, with its posture.
const TABLE = `
create table public.twilio_accounts (
  client_id text primary key,
  kind text not null,
  account_sid text,
  status text not null default 'provisioning',
  provision_lock_until timestamptz,
  updated_at timestamptz not null default now(),
  constraint twilio_accounts_kind_chk check (kind in ('parent', 'sub')),
  constraint twilio_accounts_status_chk check (status in ('provisioning', 'active', 'suspended', 'closed', 'failed'))
);
alter table public.twilio_accounts enable row level security;
alter table public.twilio_accounts no force row level security;
revoke all on public.twilio_accounts from public;
revoke all on public.twilio_accounts from anon, authenticated;
grant select, insert, update, delete on public.twilio_accounts to service_role;
insert into public.twilio_accounts (client_id, kind, account_sid, status) values
  ('structure-studio', 'parent', null, 'active'),
  ('example-builder', 'sub', 'AC${"0".repeat(31)}1', 'active'),
  ('other-builder', 'sub', 'AC${"0".repeat(31)}2', 'provisioning');
`;
const VA = "VA" + "0".repeat(31) + "4";

let failures = 0;
const ok = (cond, name, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail && !cond ? `   [${detail}]` : ""}`);
};
// process.exitCode, never process.exit: PGlite's handles in flight trip libuv on Windows (exit 127).
const opened = [];
const closeAll = async () => { for (const d of opened) await d.close().catch(() => {}); };
async function fresh(withTable = true) {
  const db = new PGlite();
  opened.push(db);
  await db.exec(ROLES);
  if (withTable) await db.exec(TABLE);
  return db;
}
const rows = async (db, sql) => (await db.query(sql)).rows;
const refused = async (db, sql) => { try { await db.exec(sql); return false; } catch { return true; } };
const snapshot = async (db) => JSON.stringify(await rows(db, "select client_id, verify_service_sid, verify_service_name from public.twilio_accounts order by client_id"));

(async () => {
  // ── 1. Apply ────────────────────────────────────────────────────────────────────────────
  const db = await fresh();
  let record;
  try {
    const res = await db.exec(M323());
    record = res.filter((r) => r.rows && r.rows.length).pop()?.rows?.[0];
    ok(true, "323 applied");
  } catch (e) { ok(false, "323 applied", e.message); await closeAll(); process.exitCode = 1; return; }
  ok(record && record.migration === "323" && record.columns_added === true && record.browser_blocked === true && record.services_set === 0,
    "THE RECORD reads columns_added, browser_blocked, services_set 0", JSON.stringify(record));

  const cols = (await rows(db, "select column_name from information_schema.columns where table_schema='public' and table_name='twilio_accounts'")).map((r) => r.column_name);
  ok(cols.includes("verify_service_sid") && cols.includes("verify_service_name"), "twilio_accounts gains verify_service_sid and verify_service_name");
  const set = await rows(db, "select count(*)::int as n from public.twilio_accounts where verify_service_sid is not null or verify_service_name is not null");
  ok(set[0].n === 0, "every row starts with no service (the console fills them)");

  // ── 2. Constraints ──────────────────────────────────────────────────────────────────────
  const upd = (sid, name, who = "example-builder") =>
    `update public.twilio_accounts set verify_service_sid = ${sid === null ? "null" : `'${sid}'`}, verify_service_name = ${name === null ? "null" : `'${name}'`} where client_id = '${who}'`;
  ok(!(await refused(db, upd(VA, "Example Barns Sheds LLC"))), "a VA SID with a sanitized name is kept");
  ok(!(await refused(db, upd(VA, "Route 66 Sheds"))), "digits and single spaces are fine");
  ok(!(await refused(db, upd(null, null))), "clearing both (the rollback) is fine");
  ok(await refused(db, upd("VAnothex", "Example Barns")), "a SID that is not VA + 32 hex is refused");
  ok(await refused(db, upd("MG" + "0".repeat(32), "Example Barns")), "a SID of another kind is refused");
  ok(await refused(db, upd(VA, "Example Barns & Sheds")), "a name with punctuation is refused (it is stored sanitized)");
  ok(await refused(db, upd(VA, " Example Barns")), "a name with a leading space is refused");
  ok(await refused(db, upd(VA, "A".repeat(31))), "a 31-character name is refused (Twilio's cap is 30)");
  ok(!(await refused(db, upd(VA, "A".repeat(30)))), "30 characters are kept");
  ok(await refused(db, upd(VA, null)), "a SID without its name is refused");
  ok(await refused(db, upd(null, "Example Barns")), "a name without its SID is refused");
  ok(await refused(db, upd(VA, "Structure Studio", "structure-studio")), "a parent pin cannot hold a service of its own");
  await db.exec(upd(null, null));

  // ── 3. Lockdown ─────────────────────────────────────────────────────────────────────────
  const priv = await rows(db, `select
      has_column_privilege('anon', 'public.twilio_accounts', 'verify_service_sid', 'select') as anon_sel,
      has_column_privilege('authenticated', 'public.twilio_accounts', 'verify_service_name', 'select') as auth_sel,
      has_column_privilege('authenticated', 'public.twilio_accounts', 'verify_service_sid', 'update') as auth_upd,
      has_column_privilege('service_role', 'public.twilio_accounts', 'verify_service_sid', 'update') as svc_upd,
      (select relrowsecurity from pg_class where oid = 'public.twilio_accounts'::regclass) as rls,
      (select count(*)::int from pg_policy where polrelid = 'public.twilio_accounts'::regclass) as policies`);
  ok(!priv[0].anon_sel && !priv[0].auth_sel && !priv[0].auth_upd, "the browser roles reach neither column", JSON.stringify(priv[0]));
  ok(priv[0].svc_upd === true, "the service role writes them (customer-auth reads, admin-catalog writes)");
  ok(priv[0].rls === true && priv[0].policies === 0, "RLS still on, still no policy");

  // ── 4. Re-apply, rehearsal, CRLF, no table ──────────────────────────────────────────────
  await db.exec(upd(VA, "Example Barns"));
  const before = await snapshot(db);
  try { await db.exec(M323()); ok(true, "a re-apply runs"); } catch (e) { ok(false, "a re-apply runs", e.message); }
  ok((await snapshot(db)) === before, "…and changes nothing (a service already recorded stays)");

  const rehearse = await fresh();
  await rehearse.exec(M323().replace(/^commit;$/m, "rollback;"));
  const left = await rows(rehearse, "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='twilio_accounts' and column_name like 'verify_service_%'");
  ok(left[0].n === 0, "the rehearsal (commit -> rollback) leaves nothing behind", JSON.stringify(left[0]));

  const crlf = await fresh();
  try {
    await crlf.exec(RAW().replace(/\r?\n/g, "\r\n"));
    const c = await rows(crlf, "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='twilio_accounts' and column_name like 'verify_service_%'");
    ok(c[0].n === 2, "a CRLF checkout applies the same");
  } catch (e) { ok(false, "a CRLF checkout applies the same", e.message); }

  const bare = await fresh(false);
  let msg = "";
  try { await bare.exec(M323()); } catch (e) { msg = String(e.message); }
  ok(/migration 292 not applied/.test(msg), "a database without twilio_accounts is refused, naming 292", msg);

  await closeAll();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch(async (e) => { console.error(e); await closeAll(); process.exitCode = 1; });
