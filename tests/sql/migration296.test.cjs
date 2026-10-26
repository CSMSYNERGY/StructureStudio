// Execute migration 296 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// client_settings and payment_attempts as they are live, then check what it promises:
//   * client_settings.cardpointe_env is text NOT NULL DEFAULT 'uat' with a CHECK of ('uat','prod'),
//     and every existing builder reads 'uat' (where they have always been); nobody is moved;
//   * payment_attempts.cp_env is text NULL, no default, CHECK (null, 'uat', 'prod'), and nothing is
//     back-filled: NULL means uat;
//   * NOTHING ELSE MOVES on either table, every row and every column;
//   * the writes the functions make afterwards, as service_role: set_payments' upsert of the system,
//     an older save that does not name it (keeps it), a new row (starts 'uat'), the attempt insert
//     with cp_env and the older one without; 'live' and other junk refused on both columns;
//   * both tables stay service-role only (RLS on, client_settings not forced, no policy, nothing for
//     the browser roles);
//   * a RE-apply after an operator moved a builder to live moves nobody;
//   * THE RECORD, the one row `supabase db query` prints, carries counts only, including the two the
//     deploy depends on (enabled_without_mid, enabled_test_billable); a dry run prints the same row
//     and leaves nothing; a CRLF checkout applies the same; both tables are locked before the snapshot;
//   * the header's ROLLBACK, run as written, takes both columns, both CHECKs and the ledger row away;
//   * broken shapes are refused with the WHOLE file rolled back (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants, merchant ids and order references are made up. The repo is public.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration296.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
// LF, whatever the checkout: the mutants below splice LF-only text. Section 6 tries CRLF on purpose.
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/296_cardpointe_env.sql"), "utf8").replace(/\r\n/g, "\n");

// client_settings cut to the columns 296 reads and the payment saves touch (057's billing_exempt,
// 174's switch and MID), plus a neighbour (business_name) and the save's updated_at. payment_attempts
// as 174 built it with 291's four columns (291 is live). Both RLS on with no policies and an ACL of
// postgres + service_role only: granted to everyone first, then revoked, as Supabase's default
// privileges and the migrations that closed them left it. No triggers (live has none).
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);
insert into supabase_migrations.schema_migrations (version, name) values ('296', '296_cardpointe_env');

create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(),
  business_name text,
  billing_exempt boolean not null default false,
  payments_online_enabled boolean not null default false,
  cardpointe_merchid text
);
alter table public.client_settings enable row level security;
grant all on public.client_settings to anon, authenticated, service_role;
revoke all on public.client_settings from anon, authenticated;

create table public.payment_attempts (
  id            bigint generated always as identity primary key,
  client_id     text not null,
  order_id      uuid not null,
  short_code    text,
  amount_cents  integer not null check (amount_cents > 0),
  rail          text not null check (rail in ('card','ach')),
  merchid       text not null,
  orderid       text not null,
  retref        text,
  payment_id    uuid,
  state         text not null default 'open' check (state in ('open', 'closed_ok', 'closed_declined', 'closed_unknown')),
  respstat      text,
  respcode      text,
  detail        text,
  actor_kind    text not null check (actor_kind in ('customer', 'operator', 'staff')),
  actor_ref     text,
  created_at    timestamptz not null default now(),
  closed_at     timestamptz,
  sent_fields   text[],
  ecomind       text,
  avsresp       text,
  cvvresp       text
);
create unique index payment_attempts_one_open on public.payment_attempts (client_id, order_id) where state = 'open';
create unique index payment_attempts_orderid_uniq on public.payment_attempts (merchid, orderid);
alter table public.payment_attempts enable row level security;
grant all on public.payment_attempts to anon, authenticated, service_role;
revoke all on public.payment_attempts from anon, authenticated;
`;

// Five builders: acme switched on and billable (test mode, so enabled_test_billable), bravo switched
// on with NO merchant id (enabled_without_mid), charlie off with a MID, delta on and non-billable
// (the internal-account shape), echo with nothing. Three attempts, one per state that matters.
const SEED = `
insert into public.client_settings (client_id, business_name, billing_exempt, payments_online_enabled, cardpointe_merchid, updated_at) values
  ('acme-sheds',     'Acme Sheds',     false, true,  '100200300401', '2026-09-01 10:00+00'),
  ('bravo-barns',    'Bravo Barns',    true,  true,  null,           '2026-09-02 10:00+00'),
  ('charlie-cabins', 'Charlie Cabins', false, false, '100200300402', '2026-09-03 10:00+00'),
  ('delta-sheds',    'Delta Sheds',    true,  true,  '100200300403', '2026-09-04 10:00+00'),
  ('echo-barns',     null,             false, false, null,           '2026-09-05 10:00+00');
insert into public.payment_attempts
  (client_id, order_id, short_code, amount_cents, rail, merchid, orderid, retref, state, respstat, detail, actor_kind, actor_ref, created_at, closed_at, sent_fields, ecomind, avsresp, cvvresp) values
  ('delta-sheds', '11111111-1111-4111-8111-111111111111', 'SS-AAAAAAAAAA', 100000, 'card', '100200300403', 'ssp_aaaaaaaaaaaaaaaaaaaa', 'r-ok', 'closed_ok', 'A', null, 'customer', '5555550101', '2026-10-02 10:00+00', '2026-10-02 10:00:05+00', '{account,amount,capture,currency,ecomind,merchid,orderid}', 'E', 'Y', 'M'),
  ('delta-sheds', '22222222-2222-4222-8222-222222222222', 'SS-BBBBBBBBBB', 50000,  'card', '100200300403', 'ssp_bbbbbbbbbbbbbbbbbbbb', null,   'closed_declined', 'C', 'Invalid CVV', 'staff', 'u-1', '2026-10-03 10:00+00', '2026-10-03 10:00:04+00', null, null, 'Y', 'N'),
  ('acme-sheds',  '33333333-3333-4333-8333-333333333333', null,            25000,  'ach',  '100200300401', 'ssp_cccccccccccccccccccc', null,   'closed_unknown', null, 'charge outcome unverifiable', 'staff', 'u-2', '2026-09-04 10:00+00', '2026-09-04 10:00:31+00', null, null, null, null);
`;

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
  await db.exec(SEED);
  return db;
}
async function apply(db, sql = MIG_TEXT()) {
  const notices = [];
  const results = await db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
  // THE RECORD: what `supabase db query` prints is the rows of the last statement that returns any.
  const last = [...results].reverse().find((r) => r.rows && r.rows.length);
  notices.record = last ? last.rows[0] : null;
  return notices;
}
const DRY_RUN = () => {
  const t = MIG_TEXT();
  const i = t.lastIndexOf("\ncommit;");
  return t.slice(0, i) + "\nrollback;" + t.slice(i + "\ncommit;".length);
};
// The header's ROLLBACK statements, exactly as a human would copy them out: the indented lines under
// "── ROLLBACK", with the comment marker taken off (the warning paragraph above them is prose).
const ROLLBACK_SQL = () => {
  const lines = MIG_TEXT().split("\n");
  const start = lines.findIndex((l) => /^-- ── ROLLBACK/.test(l));
  if (start < 0) throw new Error("the ROLLBACK heading moved");
  const out = [];
  let seen = false;
  for (const l of lines.slice(start + 1)) {
    if (/^--   /.test(l)) { seen = true; out.push(l.replace(/^--   /, "")); continue; }
    if (seen) break;
  }
  return out.join("\n");
};
const column = async (db, table, col) => (await one(db, `select data_type, is_nullable, column_default from information_schema.columns
  where table_schema = 'public' and table_name = $1 and column_name = $2`, [table, col])) || null;
const comment = async (db, table, col) => (await one(db, `select col_description(('public.' || $1)::regclass,
  (select attnum from pg_attribute where attrelid = ('public.' || $1)::regclass and attname = $2)) as c`, [table, col])).c;
const constraint = async (db, name) => (await one(db, "select pg_get_constraintdef(oid) as def, convalidated from pg_constraint where conname = $1", [name])) || null;
// Every row, every column but the new one: what "nothing else moved" compares.
const settingsOthers = async (db) => JSON.stringify((await rows(db, "select * from public.client_settings order by client_id"))
  .map(({ cardpointe_env: _e, ...rest }) => rest));
const attemptsOthers = async (db) => JSON.stringify((await rows(db, "select * from public.payment_attempts order by id"))
  .map(({ cp_env: _e, ...rest }) => rest));
const envs = async (db) => JSON.stringify(await rows(db, "select client_id, cardpointe_env from public.client_settings order by client_id"));

// One statement as a role, in its own transaction. Returns the error message, or null.
async function as(db, role, sql, params) {
  await db.exec("begin");
  await db.exec(`set local role ${role}`);
  let err = null, res = null;
  try { res = await db.query(sql, params); } catch (e) { err = e.message; }
  await db.exec(err ? "rollback" : "commit");
  return { err, rows: res ? res.rows : null };
}
// admin-catalog set_payments / any portal-settings save, as supabase-js sends it: one upsert of
// exactly the named columns, onConflict client_id, as service_role.
const upsert = (db, patch) => {
  const cols = Object.keys(patch);
  return as(db, "service_role", `insert into public.client_settings (${cols.join(", ")}) values (${cols.map((_c, i) => `$${i + 1}`).join(", ")})
    on conflict (client_id) do update set ${cols.filter((c) => c !== "client_id").map((c) => `${c} = excluded.${c}`).join(", ")}`, cols.map((c) => patch[c]));
};
// The attempt insert as _shared/invoicePayment.ts makes it.
const insertAttempt = (db, row) => {
  const cols = Object.keys(row);
  return as(db, "service_role",
    `insert into public.payment_attempts (${cols.join(", ")}) values (${cols.map((_c, i) => `$${i + 1}`).join(", ")}) returning id`,
    cols.map((c) => row[c]));
};
const ATTEMPT = (orderId, orderid, extra = {}) => ({
  client_id: "delta-sheds", order_id: orderId, amount_cents: 365000, rail: "card", merchid: "100200300403", orderid,
  actor_kind: "customer", actor_ref: "5555550199", sent_fields: ["account", "amount", "merchid"], ecomind: "E", ...extra,
});

// Did the apply fail with `re`, and leave nothing behind?
async function refused(db, sql, re) {
  const s = await settingsOthers(db), a = await attemptsOthers(db);
  const envBefore = JSON.stringify(await column(db, "client_settings", "cardpointe_env"));
  const envValues = envBefore === "null" ? null : await envs(db);
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e.message; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  return {
    err, matched: !!err && re.test(err),
    columnsKept: JSON.stringify(await column(db, "client_settings", "cardpointe_env")) === envBefore,
    envsKept: envValues === null || (await envs(db)) === envValues,
    rowsKept: (await settingsOthers(db)) === s && (await attemptsOthers(db)) === a,
  };
}
const kept = (r) => r.matched && r.columnsKept && r.envsKept && r.rowsKept;

const FIRST_RECORD = {
  migration: "296", cardpointe_env: "text NOT NULL DEFAULT 'uat'::text", cp_env: "text NULL", first_apply: "true/true",
  settings_total: 5, settings_on_prod: 0, attempts_total: 3, attempts_with_env: 0, settings_changed: 0, attempts_changed: 0,
  browser_can_read: false, new_row_starts: "uat", enabled_without_mid: 1, enabled_test_billable: 1,
};
const ENV_ADD = /  add column if not exists cardpointe_env text not null default 'uat';\n/;
const CP_ADD = /  add column if not exists cp_env text;\n/;

(async () => {
  // ── 1. The first apply on the live shape ────────────────────────────────────────────────────
  console.log("migration 296: the first apply adds both columns, puts every builder on uat and moves nothing else");
  {
    const db = await fresh();
    const s = await settingsOthers(db), a = await attemptsOthers(db);
    let notices = [];
    try { notices = await apply(db); ok(true, "296 applied cleanly, its own checks and rehearsals included"); }
    catch (e) { ok(false, "296 applied", e.message); }
    ok(notices.some((n) => /296: checks hold; cardpointe_env defaults to uat; first apply true\/true; 0 builder\(s\) on prod$/.test(n)),
      "its own checks held", notices.join(" | "));
    const rec = notices.record || {};
    ok(JSON.stringify(rec) === JSON.stringify(FIRST_RECORD),
      "THE RECORD: both columns as designed, nobody on prod, no attempt given a system, nothing changed, closed to the browser, a new row starts uat, one builder on with no MID, one billable builder on in test",
      JSON.stringify(rec));
    ok(!Object.values(rec).some((v) => typeof v === "string" && /sheds|barns|cabins|1002003004/.test(v)), "THE RECORD names no builder and no merchant id");

    const env = await column(db, "client_settings", "cardpointe_env");
    ok(env && env.data_type === "text" && env.is_nullable === "NO" && env.column_default === "'uat'::text", "cardpointe_env is text NOT NULL DEFAULT 'uat'", JSON.stringify(env));
    const cp = await column(db, "payment_attempts", "cp_env");
    ok(cp && cp.data_type === "text" && cp.is_nullable === "YES" && cp.column_default === null, "cp_env is text NULL with no default", JSON.stringify(cp));
    const k1 = await constraint(db, "client_settings_cardpointe_env_check");
    ok(k1 && k1.convalidated && /'uat'/.test(k1.def) && /'prod'/.test(k1.def) && !/NULL/i.test(k1.def), "client_settings_cardpointe_env_check: (uat, prod), validated", JSON.stringify(k1));
    const k2 = await constraint(db, "payment_attempts_cp_env_check");
    ok(k2 && k2.convalidated && /cp_env IS NULL/.test(k2.def) && /'uat'/.test(k2.def) && /'prod'/.test(k2.def), "payment_attempts_cp_env_check: (null, uat, prod), validated", JSON.stringify(k2));
    ok(/CARDPOINTE_PROD_\*/.test(await comment(db, "client_settings", "cardpointe_env")) && /refuses switching a billable/.test(await comment(db, "client_settings", "cardpointe_env")),
      "cardpointe_env's comment names both secret sets and the billable rule", await comment(db, "client_settings", "cardpointe_env"));
    ok(/NULL = ''?uat''?/.test(await comment(db, "payment_attempts", "cp_env")) || /NULL = 'uat'/.test(await comment(db, "payment_attempts", "cp_env")),
      "cp_env's comment says NULL is uat", await comment(db, "payment_attempts", "cp_env"));
    ok((await rows(db, "select client_id from public.client_settings where cardpointe_env <> 'uat'")).length === 0, "every builder reads uat");
    ok((await rows(db, "select id from public.payment_attempts where cp_env is not null")).length === 0, "no attempt was given a system (NULL is uat)");
    ok((await settingsOthers(db)) === s, "every other value on every settings row is what it was");
    ok((await attemptsOthers(db)) === a, "every other value on every attempt is what it was");
    ok((await one(db, "select count(*)::int n from public.client_settings where client_id = '__m296_rehearsal__'")).n === 0, "the rehearsal row is gone");
    ok((await one(db, "select to_regclass('pg_temp.m296_settings_before') is null and to_regclass('pg_temp.m296_attempts_before') is null as gone")).gone, "the snapshot tables went with the commit");

    // ── 2. Still service-role only ──
    for (const t of ["client_settings", "payment_attempts"]) {
      ok((await one(db, `select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`)).relrowsecurity === true, `${t}: RLS still on`);
      ok((await one(db, `select count(*)::int n from pg_policy where polrelid = 'public.${t}'::regclass`)).n === 0, `${t}: still no policy`);
    }
    ok((await one(db, "select relforcerowsecurity from pg_class where oid = 'public.client_settings'::regclass")).relforcerowsecurity === false, "client_settings: FORCE stays off");
    for (const role of ["anon", "authenticated"]) {
      const r = await as(db, role, "select cardpointe_env from public.client_settings");
      ok(r.err && /permission denied/.test(r.err), `${role} cannot read cardpointe_env`, r.err);
      const r2 = await as(db, role, "select cp_env from public.payment_attempts");
      ok(r2.err && /permission denied/.test(r2.err), `${role} cannot read cp_env`, r2.err);
    }

    // ── 3. The writes the functions make afterwards ──
    let r = await upsert(db, { client_id: "acme-sheds", payments_online_enabled: true, cardpointe_merchid: "100200300401", cardpointe_env: "prod", updated_at: "2026-10-10T12:00:00Z" });
    ok(!r.err, "set_payments moves a builder to prod as service_role", r.err);
    r = await upsert(db, { client_id: "acme-sheds", business_name: "Acme Sheds LLC", updated_at: "2026-10-10T12:05:00Z" });
    ok(!r.err && (await one(db, "select cardpointe_env from public.client_settings where client_id = 'acme-sheds'")).cardpointe_env === "prod",
      "a save that does not name the system keeps it (only named columns are set)", r.err);
    r = await upsert(db, { client_id: "foxtrot-sheds", business_name: "Foxtrot Sheds", updated_at: "2026-10-10T12:00:00Z" });
    ok(!r.err && (await one(db, "select cardpointe_env from public.client_settings where client_id = 'foxtrot-sheds'")).cardpointe_env === "uat",
      "a builder's first save creates a row on uat", r.err);
    for (const bad of ["live", "test", "PROD", ""]) {
      r = await upsert(db, { client_id: "acme-sheds", cardpointe_env: bad });
      ok(r.err && /cardpointe_env_check/.test(r.err), `cardpointe_env '${bad}' is refused by the CHECK`, r.err);
    }
    r = await as(db, "service_role", "update public.client_settings set cardpointe_env = null where client_id = 'acme-sheds'");
    ok(r.err && /null value/.test(r.err), "cardpointe_env cannot be NULL", r.err);

    r = await insertAttempt(db, ATTEMPT("44444444-4444-4444-8444-444444444444", "ssp_prod000000000000000", { cp_env: "prod", client_id: "acme-sheds", merchid: "100200300401" }));
    ok(!r.err, "an attempt records cp_env 'prod'", r.err);
    r = await insertAttempt(db, ATTEMPT("55555555-5555-4555-8555-555555555555", "ssp_uat0000000000000000", { cp_env: "uat" }));
    ok(!r.err, "an attempt records cp_env 'uat'", r.err);
    r = await insertAttempt(db, ATTEMPT("66666666-6666-4666-8666-666666666666", "ssp_older00000000000000"));
    ok(!r.err && (await one(db, "select cp_env from public.payment_attempts where orderid = 'ssp_older00000000000000'")).cp_env === null,
      "an OLDER function's insert, naming no cp_env, still works and reads NULL (uat)", r.err);
    r = await insertAttempt(db, ATTEMPT("77777777-7777-4777-8777-777777777777", "ssp_junk000000000000000", { cp_env: "live" }));
    ok(r.err && /cp_env_check/.test(r.err), "cp_env 'live' is refused by the CHECK (the attempt insert, before any card is touched)", r.err);

    // ── 4. Re-apply after an operator chose: nobody moves ──
    const sNow = await settingsOthers(db), eNow = await envs(db), aNow = JSON.stringify(await rows(db, "select * from public.payment_attempts order by id"));
    let re = [];
    try { re = await apply(db); ok(true, "a re-apply runs clean with a builder on prod and attempts carrying cp_env"); }
    catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok((await envs(db)) === eNow && (await settingsOthers(db)) === sNow, "a re-apply keeps every builder's system and every other value");
    ok(JSON.stringify(await rows(db, "select * from public.payment_attempts order by id")) === aNow, "and every attempt, cp_env included");
    ok(re.record && re.record.first_apply === "false/false" && re.record.settings_on_prod === 1 && re.record.attempts_with_env === 2
      && re.record.settings_changed === 0 && re.record.attempts_changed === 0 && re.record.enabled_test_billable === 0,
      "its record says it was not the first apply and counts things as they now are (acme moved to prod, so no billable builder is on in test)", JSON.stringify(re.record));
    ok((await one(db, "select count(*)::int n from pg_constraint where conname in ('client_settings_cardpointe_env_check', 'payment_attempts_cp_env_check')")).n === 2,
      "a re-apply does not duplicate either CHECK");
    await db.close();
  }

  // ── 4b. Both tables are locked against writes BEFORE the snapshots ─────────────────────────
  console.log("migration 296: both tables are locked before the snapshots are taken");
  {
    const t = MIG_TEXT();
    const iBegin = t.indexOf("\nbegin;");
    const at = (needle) => t.indexOf(needle, iBegin);
    const iTimeout = at("set local lock_timeout = '5s';");
    const iLock1 = at("lock table public.client_settings in exclusive mode;");
    const iLock2 = at("lock table public.payment_attempts in exclusive mode;");
    const iSnap = at("create temp table m296_settings_before");
    const iAlter = at("alter table public.client_settings");
    ok(iBegin > 0 && iTimeout > iBegin && iLock1 > iTimeout && iLock2 > iLock1 && iSnap > iLock2 && iAlter > iSnap,
      "begin; lock_timeout; client_settings then payment_attempts locked; the snapshots; then the ALTERs", JSON.stringify({ iBegin, iTimeout, iLock1, iLock2, iSnap, iAlter }));
    const db = await fresh();
    let err = null;
    try { await db.exec(t.slice(iBegin, iSnap)); } catch (e) { err = e.message; }
    ok(!err, "the file up to the snapshots runs", err);
    for (const tab of ["client_settings", "payment_attempts"]) {
      const held = await rows(db, `select mode from pg_locks where relation = 'public.${tab}'::regclass and granted`);
      ok(held.some((r) => r.mode === "ExclusiveLock"), `${tab} is held in EXCLUSIVE mode at the snapshot (reads pass, writes wait)`, JSON.stringify(held));
    }
    await db.exec("rollback");
    await db.close();
  }

  // ── 5. A CRLF checkout applies the same ─────────────────────────────────────────────────────
  console.log("migration 296: a Windows (CRLF) checkout applies the same");
  {
    const db = await fresh();
    let err = null, rec = null;
    try { rec = (await apply(db, MIG_TEXT().replace(/\n/g, "\r\n"))).record; } catch (e) { err = e.message; }
    ok(!err && rec && JSON.stringify(rec) === JSON.stringify(FIRST_RECORD), "the CRLF copy applies and prints the same record", err || JSON.stringify(rec));
    await db.close();
  }

  // ── 6. The dry run ──────────────────────────────────────────────────────────────────────────
  console.log("migration 296: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const db = await fresh();
    const s = await settingsOthers(db), a = await attemptsOthers(db);
    const dry = DRY_RUN();
    ok((dry.match(/\ncommit;/g) || []).length === 0 && (dry.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = [];
    try { notices = await apply(db, dry); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(notices.record && JSON.stringify(notices.record) === JSON.stringify(FIRST_RECORD), "it prints the same record the apply would", JSON.stringify(notices.record));
    ok((await column(db, "client_settings", "cardpointe_env")) === null && (await column(db, "payment_attempts", "cp_env")) === null, "and leaves neither column behind");
    ok((await constraint(db, "client_settings_cardpointe_env_check")) === null && (await constraint(db, "payment_attempts_cp_env_check")) === null, "nor either CHECK");
    ok((await settingsOthers(db)) === s && (await attemptsOthers(db)) === a, "and no row moved");
    await db.close();
  }

  // ── 7. The header's ROLLBACK, as written ────────────────────────────────────────────────────
  console.log("migration 296: the header's ROLLBACK takes both columns, both CHECKs and the ledger row away");
  {
    const db = await fresh();
    await apply(db);
    const sql = ROLLBACK_SQL();
    ok(/alter table public\.client_settings drop column if exists cardpointe_env;/.test(sql) && /alter table public\.payment_attempts drop column if exists cp_env;/.test(sql)
      && /notify pgrst/.test(sql) && /delete from supabase_migrations\.schema_migrations where version = '296';/.test(sql),
      "the ROLLBACK block drops both columns, reloads PostgREST and removes the ledger row", sql);
    ok(!/select count/.test(sql), "the prose check above it is not swept into the statements", sql);
    let err = null;
    try { await db.exec(sql); } catch (e) { err = e.message; }
    ok(!err, "it runs as written", err);
    ok((await column(db, "client_settings", "cardpointe_env")) === null && (await column(db, "payment_attempts", "cp_env")) === null, "both columns are gone");
    ok((await constraint(db, "client_settings_cardpointe_env_check")) === null && (await constraint(db, "payment_attempts_cp_env_check")) === null, "and both CHECKs with them");
    ok((await one(db, "select count(*)::int n from supabase_migrations.schema_migrations where version = '296'")).n === 0, "the ledger row is gone");
    // The functions' fallback after a rollback: the attempt insert without cp_env.
    const r = await insertAttempt(db, ATTEMPT("88888888-8888-4888-8888-888888888888", "ssp_afterrollback000000"));
    ok(!r.err, "the attempt insert the functions fall back to still works", r.err);
    let re = null;
    try { re = (await apply(db)).record; } catch (e) { err = e.message; }
    ok(re && re.first_apply === "true/true" && re.settings_on_prod === 0, "after a rollback the file applies again as a first apply", err || JSON.stringify(re));
    await db.close();
  }

  // ── 8. Mutants: broken shapes are refused, and nothing is left behind ───────────────────────
  console.log("migration 296: refuses what it cannot prove");
  {
    const mutate = (re, to) => {
      const t = MIG_TEXT();
      const m = t.replace(re, to);
      if (m === t) throw new Error(`mutant not built: ${re}`);
      return m;
    };
    let db, r;

    // Every builder put on live by the default.
    db = await fresh();
    r = await refused(db, mutate(ENV_ADD, "  add column if not exists cardpointe_env text not null default 'prod';\n"),
      /cardpointe_env should be text NOT NULL DEFAULT 'uat', is text \/ nullable NO \/ default 'prod'::text/);
    ok(kept(r), "a default of 'prod': refused, nothing of 296 left", JSON.stringify(r));
    await db.close();

    // A nullable system.
    db = await fresh();
    r = await refused(db, mutate(ENV_ADD, "  add column if not exists cardpointe_env text default 'uat';\n"), /nullable YES/);
    ok(kept(r), "a nullable cardpointe_env: refused", JSON.stringify(r));
    await db.close();

    // cp_env with a default: every older function's attempt would claim a system.
    db = await fresh();
    r = await refused(db, mutate(CP_ADD, "  add column if not exists cp_env text default 'uat';\n"), /cp_env should be text NULL with no default/);
    ok(kept(r), "a default on cp_env: refused", JSON.stringify(r));
    await db.close();

    // A column that already exists in the wrong shape: `if not exists` skips it, the check sees it.
    db = await fresh();
    await db.exec("alter table public.client_settings add column cardpointe_env text");
    r = await refused(db, MIG_TEXT(), /cardpointe_env should be text NOT NULL DEFAULT 'uat', is text \/ nullable YES/);
    ok(r.matched && r.rowsKept, "a cardpointe_env already there, nullable with no default: refused", JSON.stringify(r));
    await db.close();
    // ...and in the wrong type, which the file cannot even constrain: refused with nothing left either.
    db = await fresh();
    await db.exec("alter table public.client_settings add column cardpointe_env boolean not null default false");
    r = await refused(db, MIG_TEXT(), /invalid input syntax for type boolean|cardpointe_env should be text/);
    ok(r.matched && r.rowsKept && (await constraint(db, "client_settings_cardpointe_env_check")) === null, "a cardpointe_env that is already a boolean: refused", JSON.stringify(r));
    await db.close();

    // No CHECK at all, and a CHECK that lets 'live' in.
    db = await fresh();
    r = await refused(db, mutate(/do \$add\$[\s\S]*?\$add\$;\n/, ""), /client_settings_cardpointe_env_check is missing/);
    ok(kept(r), "without the CHECKs: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    r = await refused(db, mutate("check (cardpointe_env in ('uat', 'prod'))", "check (cardpointe_env in ('uat', 'live'))"),
      /client_settings_cardpointe_env_check is missing, not validated, or not \(uat, prod\)/);
    ok(kept(r), "a CHECK of (uat, live): refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    r = await refused(db, mutate("check (cp_env is null or cp_env in ('uat', 'prod'))", "check (cp_env in ('uat', 'prod'))"),
      /payment_attempts_cp_env_check is missing, not validated, or not \(null, uat, prod\)/);
    ok(kept(r), "a cp_env CHECK without NULL: refused", JSON.stringify(r));
    await db.close();
    // A pre-existing NOT VALID check with the right name: never validated, so refused.
    db = await fresh();
    await db.exec("alter table public.client_settings add column cardpointe_env text not null default 'uat'");
    await db.exec("alter table public.client_settings add constraint client_settings_cardpointe_env_check check (cardpointe_env in ('uat', 'prod')) not valid");
    r = await refused(db, MIG_TEXT(), /client_settings_cardpointe_env_check is missing, not validated/);
    ok(r.matched && r.rowsKept, "a NOT VALID check left by hand: refused", JSON.stringify(r));
    await db.close();

    // A back-fill of cp_env: NULL is uat by rule, and old attempts must not be rewritten.
    db = await fresh();
    r = await refused(db, mutate(CP_ADD, (s) => s + "update public.payment_attempts set cp_env = 'uat';\n"),
      /3 payment_attempts row\(s\) were given a cp_env on the first apply/);
    ok(kept(r), "a back-fill of cp_env: refused", JSON.stringify(r));
    await db.close();

    // A builder moved to live by the file.
    db = await fresh();
    r = await refused(db, mutate(CP_ADD, (s) => s + "update public.client_settings set cardpointe_env = 'prod' where billing_exempt is not true;\n"),
      /3 client_settings row\(s\) are not 'uat' on the first apply/);
    ok(kept(r), "moving builders to live: refused", JSON.stringify(r));
    await db.close();

    // A file that touches a value it promises to leave.
    db = await fresh();
    r = await refused(db, mutate(CP_ADD, (s) => s + "update public.client_settings set updated_at = now() where payments_online_enabled;\n"),
      /3 client_settings row\(s\) changed during the apply/);
    ok(kept(r), "stamping updated_at: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    r = await refused(db, mutate(CP_ADD, (s) => s + "update public.payment_attempts set state = 'closed_declined' where state = 'closed_unknown';\n"),
      /1 payment_attempts row\(s\) changed during the apply/);
    ok(kept(r), "unblocking a closed_unknown: refused", JSON.stringify(r));
    await db.close();

    // A re-apply that would move a builder back.
    db = await fresh();
    await apply(db);
    await upsert(db, { client_id: "acme-sheds", cardpointe_env: "prod" });
    r = await refused(db, mutate(CP_ADD, (s) => s + "update public.client_settings set cardpointe_env = 'uat';\n"),
      /1 client_settings row\(s\) changed during the apply/);
    ok(kept(r), "a re-apply that resets a live builder to uat: refused, acme stays on prod", JSON.stringify(r));
    await db.close();

    // A trigger that starts new rows on live: the rehearsal sees it.
    db = await fresh();
    await apply(db);
    await db.exec(`create function public.m296_force_prod() returns trigger language plpgsql as $$ begin new.cardpointe_env := 'prod'; return new; end $$;
      create trigger m296_force_prod before insert on public.client_settings for each row execute function public.m296_force_prod();`);
    r = await refused(db, MIG_TEXT(), /a new client_settings row starts with cardpointe_env = prod, expected uat/);
    ok(kept(r), "a new row that starts on prod: refused by the rehearsal", JSON.stringify(r));
    await db.close();

    // A row already carrying the rehearsal's name is never touched.
    db = await fresh();
    await db.exec("insert into public.client_settings (client_id) values ('__m296_rehearsal__')");
    r = await refused(db, MIG_TEXT(), /a client_settings row named __m296_rehearsal__ already exists/);
    ok(kept(r), "a row named like the rehearsal: refused, left alone", JSON.stringify(r));
    await db.close();

    // The tables opened to the browser, or service_role unable to write.
    for (const [setup, re, label] of [
      ["grant select on public.client_settings to authenticated", /authenticated holds SELECT on client_settings\.cardpointe_env/, "client_settings readable by authenticated"],
      ["grant update on public.payment_attempts to anon", /anon holds UPDATE on payment_attempts\.cp_env/, "payment_attempts writable by anon"],
      ["revoke update on public.client_settings from service_role", /service_role lacks UPDATE on client_settings\.cardpointe_env/, "service_role without UPDATE on client_settings"],
      ["revoke insert on public.payment_attempts from service_role", /service_role lacks INSERT on payment_attempts\.cp_env/, "service_role without INSERT on payment_attempts"],
      ["alter table public.client_settings disable row level security", /RLS is off on client_settings/, "RLS off on client_settings"],
      ["alter table public.payment_attempts disable row level security", /RLS is off on payment_attempts/, "RLS off on payment_attempts"],
      ["alter table public.client_settings force row level security", /client_settings has FORCE ROW LEVEL SECURITY on/, "FORCE row level security"],
      ["create policy open_read on public.client_settings for select using (true)", /client_settings has a policy/, "a policy on client_settings"],
      ["create policy open_read on public.payment_attempts for select using (true)", /payment_attempts has a policy/, "a policy on payment_attempts"],
    ]) {
      db = await fresh();
      await db.exec(setup);
      r = await refused(db, MIG_TEXT(), re);
      ok(kept(r), `${label}: refused`, JSON.stringify(r));
      await db.close();
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
