// Execute migration 291 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// payment_attempts as 174 built it, then check what it promises:
//   * four NULLABLE columns, no default: sent_fields text[], ecomind text, avsresp text, cvvresp text,
//     each with a comment;
//   * NO existing row moves, and nothing is back-filled into the new columns;
//   * the table stays exactly as 174 left it: RLS on, no policy, nothing for anon/authenticated on
//     any new column, everything the charge path needs for service_role;
//   * the charge path's writes, as _shared/invoicePayment.ts makes them under service_role: a keyed
//     attempt (sent_fields + ecomind "E"), a swipe (no ecomind), a decline's close carrying the
//     AVS/CVV answer, and the OLDER function's insert that names none of the four; the one-open
//     guard still refuses a second open attempt on the same order;
//   * THE RECORD, the one row `supabase db query` prints; a dry run (the last commit; swapped for
//     rollback;) prints the same row and leaves nothing; a re-apply after real charges is harmless;
//     a CRLF checkout applies the same;
//   * the header's ROLLBACK, run as written, takes the columns and the ledger row away;
//   * broken shapes are refused with the WHOLE file rolled back (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants, merchant ids and order references are made up. The repo is public.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration291.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_PATH = path.join(WT, "supabase/migrations/291_payment_attempt_fields.sql");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || MIG_PATH, "utf8");

// payment_attempts as 174 creates it (174_card_payments.sql section 3, verbatim in shape): the
// identity key, the checks, the one-open guard and the orderid key, RLS on with ZERO policies, and an
// ACL of postgres + service_role only: granted to everyone first (Supabase's default privileges) and
// then `revoke all ... from anon, authenticated`, as 174 does. No trigger.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);
insert into supabase_migrations.schema_migrations (version, name) values ('291', '291_payment_attempt_fields');

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
  state         text not null default 'open'
    check (state in ('open', 'closed_ok', 'closed_declined', 'closed_unknown')),
  respstat      text,
  respcode      text,
  detail        text,
  actor_kind    text not null check (actor_kind in ('customer', 'operator', 'staff')),
  actor_ref     text,
  created_at    timestamptz not null default now(),
  closed_at     timestamptz
);
create unique index payment_attempts_one_open on public.payment_attempts (client_id, order_id) where state = 'open';
create unique index payment_attempts_orderid_uniq on public.payment_attempts (merchid, orderid);
alter table public.payment_attempts enable row level security;
grant all on public.payment_attempts to anon, authenticated, service_role;
revoke all on public.payment_attempts from anon, authenticated;
`;

// Three attempts as the live ledger holds them: one recorded sale, one decline, one still blocking.
const SEED = `
insert into public.payment_attempts
  (client_id, order_id, short_code, amount_cents, rail, merchid, orderid, retref, state, respstat, detail, actor_kind, actor_ref, created_at, closed_at) values
  ('acme-sheds',  '11111111-1111-4111-8111-111111111111', 'SS-AAAAAAAAAA', 100000, 'card', '100200300400', 'ssp_aaaaaaaaaaaaaaaaaaaa', 'r-ok', 'closed_ok', 'A', null, 'customer', '5555550101', '2026-09-02 10:00+00', '2026-09-02 10:00:05+00'),
  ('acme-sheds',  '22222222-2222-4222-8222-222222222222', 'SS-BBBBBBBBBB', 50000,  'card', '100200300400', 'ssp_bbbbbbbbbbbbbbbbbbbb', null,   'closed_declined', null, 'Not sufficient funds', 'staff', 'u-1', '2026-09-03 10:00+00', '2026-09-03 10:00:04+00'),
  ('bravo-barns', '33333333-3333-4333-8333-333333333333', null,            25000,  'ach',  '100200300401', 'ssp_cccccccccccccccccccc', null,   'closed_unknown', null, 'charge outcome unverifiable', 'staff', 'u-2', '2026-09-04 10:00+00', '2026-09-04 10:00:31+00');
`;

const COLS = ["avsresp", "cvvresp", "ecomind", "sent_fields"];

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
// The file as a dry run: its last `commit;` swapped for `rollback;`.
const DRY_RUN = () => {
  const t = MIG_TEXT().replace(/\r\n/g, "\n");
  const i = t.lastIndexOf("\ncommit;");
  return t.slice(0, i) + "\nrollback;" + t.slice(i + "\ncommit;".length);
};
// The header's ROLLBACK block, exactly as a human would copy it out: the indented statement lines
// between "── ROLLBACK" and the paragraph that follows them, with the comment marker taken off.
const ROLLBACK_SQL = () => {
  const lines = MIG_TEXT().replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^-- ── ROLLBACK/.test(l));
  if (start < 0) throw new Error("the ROLLBACK heading moved");
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (!/^--   /.test(l)) break;
    out.push(l.replace(/^--   /, ""));
  }
  return out.join("\n");
};
const columns = async (db) => rows(db, `select column_name, udt_name, is_nullable, column_default from information_schema.columns
  where table_schema = 'public' and table_name = 'payment_attempts' and column_name = any($1) order by column_name`, [COLS]);
const comment = async (db, col) => (await one(db, `select col_description('public.payment_attempts'::regclass,
  (select attnum from pg_attribute where attrelid = 'public.payment_attempts'::regclass and attname = $1)) as c`, [col])).c;
const all = async (db) => rows(db, "select * from public.payment_attempts order by id");
// The 174 columns only, so "nothing moved" compares like with like before and after the apply.
const OLD_COLS = "id, client_id, order_id, short_code, amount_cents, rail, merchid, orderid, retref, payment_id, state, respstat, respcode, detail, actor_kind, actor_ref, created_at, closed_at";
const old174 = async (db) => rows(db, `select ${OLD_COLS} from public.payment_attempts order by id`);

// One statement as a role, in its own transaction. Returns the error message, or null.
async function as(db, role, sql, params) {
  await db.exec("begin");
  await db.exec(`set local role ${role}`);
  let err = null, res = null;
  try { res = await db.query(sql, params); } catch (e) { err = e.message; }
  await db.exec(err ? "rollback" : "commit");
  return { err, rows: res ? res.rows : null };
}

// The attempt insert as _shared/invoicePayment.ts makes it (supabase-js .insert(row).select("id")).
const insertAttempt = (db, row) => {
  const cols = Object.keys(row);
  return as(db, "service_role",
    `insert into public.payment_attempts (${cols.join(", ")}) values (${cols.map((_c, i) => `$${i + 1}`).join(", ")}) returning id`,
    cols.map((c) => row[c]));
};
const BASE_ROW = (orderId, orderid) => ({
  client_id: "charlie-cabins", order_id: orderId, short_code: "SS-CCCCCCCCCC", amount_cents: 365000, rail: "card",
  merchid: "100200300402", orderid, actor_kind: "customer", actor_ref: "5555550199",
});
// What cpAuthFieldNames returns for a keyed sale carrying a name, street and ZIP, and for a swipe.
const KEYED_FIELDS = ["account", "address", "amount", "capture", "currency", "ecomind", "expiry", "merchid", "name", "orderid", "postal"];
const SWIPE_FIELDS = ["account", "amount", "capture", "currency", "merchid", "name", "orderid"];

// Did the apply fail with `re`, and leave nothing behind?
async function refused(db, sql, re) {
  const before = JSON.stringify(await old174(db));
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e.message; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  return {
    err, matched: !!err && re.test(err),
    columnsGone: (await columns(db)).length === 0,
    rowsKept: JSON.stringify(await old174(db)) === before,
  };
}

const STATEMENT = /  add column if not exists cvvresp     text;\r?\n/;

(async () => {
  // ── 1. The apply on 174's shape ─────────────────────────────────────────────────────────────
  console.log("migration 291: applies on 174's shape; four columns, no row moves");
  {
    const db = await fresh();
    const before = await old174(db);
    let notices = [];
    try { notices = await apply(db); ok(true, "291 applied cleanly, its own checks included"); }
    catch (e) { ok(false, "291 applied", e.message); }
    ok(notices.some((n) => /291: checks hold; 4 columns on payment_attempts, service-role only; 3 existing row\(s\) unchanged$/.test(n)),
      "its own checks held", notices.join(" | "));
    const rec = notices.record || {};
    ok(JSON.stringify(rec) === JSON.stringify({
      migration: "291", columns: "avsresp text, cvvresp text, ecomind text, sent_fields _text",
      rows_checked: 3, rows_changed: "(none)", rls: true, policies: 0,
    }), "THE RECORD, the row the CLI prints: four columns, three rows unchanged, RLS on, no policy", JSON.stringify(rec));

    const cols = await columns(db);
    ok(JSON.stringify(cols) === JSON.stringify([
      { column_name: "avsresp", udt_name: "text", is_nullable: "YES", column_default: null },
      { column_name: "cvvresp", udt_name: "text", is_nullable: "YES", column_default: null },
      { column_name: "ecomind", udt_name: "text", is_nullable: "YES", column_default: null },
      { column_name: "sent_fields", udt_name: "_text", is_nullable: "YES", column_default: null },
    ]), "sent_fields is text[], the other three text, all nullable with no default", JSON.stringify(cols));
    for (const c of COLS) ok(((await comment(db, c)) || "").length > 40, `${c} carries a comment`, await comment(db, c));
    ok(/never a value/i.test(await comment(db, "sent_fields")), "sent_fields' comment says it holds names, never a value");
    ok(/R as recurring/.test(await comment(db, "ecomind")), "ecomind's comment says what R really means");
    ok(JSON.stringify(await old174(db)) === JSON.stringify(before), "every 174 value on every row is what it was");
    ok((await rows(db, "select id from public.payment_attempts where sent_fields is not null or ecomind is not null or avsresp is not null or cvvresp is not null")).length === 0,
      "and nothing was back-filled: old rows read null (written before 291)");
    ok((await one(db, "select to_regclass('pg_temp.m291_before') is null as gone")).gone, "the snapshot table went with the commit");

    // ── 2. Still service-role only ──
    const rls = await one(db, "select relrowsecurity from pg_class where oid = 'public.payment_attempts'::regclass");
    ok(rls.relrowsecurity === true, "RLS is still on");
    ok((await one(db, "select count(*)::int n from pg_policy where polrelid = 'public.payment_attempts'::regclass")).n === 0, "and there is still no policy");
    for (const role of ["anon", "authenticated"]) {
      const r = await as(db, role, "select sent_fields, ecomind, avsresp, cvvresp from public.payment_attempts");
      ok(r.err && /permission denied/.test(r.err), `${role} cannot read the new columns`, r.err);
      const w = await as(db, role, "update public.payment_attempts set avsresp = 'Y'");
      ok(w.err && /permission denied/.test(w.err), `${role} cannot write them`, w.err);
    }

    // ── 3. The charge path's writes, as service_role ──
    let r = await insertAttempt(db, { ...BASE_ROW("44444444-4444-4444-8444-444444444444", "ssp_keyed0000000000000"), sent_fields: KEYED_FIELDS, ecomind: "E" });
    ok(!r.err && r.rows && r.rows[0].id, "a keyed attempt is inserted with its field names and ecomind E", r.err);
    const keyedId = r.rows && r.rows[0].id;
    const keyed = await one(db, "select sent_fields, ecomind from public.payment_attempts where id = $1", [keyedId]);
    ok(JSON.stringify(keyed) === JSON.stringify({ sent_fields: KEYED_FIELDS, ecomind: "E" }), "…and reads back as written", JSON.stringify(keyed));
    ok((await one(db, "select count(*)::int n from public.payment_attempts where sent_fields @> array['address','postal','name']")).n === 1,
      "the certification question is one query: which sales carried a name, street and ZIP");

    // The one-open guard is untouched: a second open attempt on the same order is refused.
    r = await insertAttempt(db, { ...BASE_ROW("44444444-4444-4444-8444-444444444444", "ssp_keyed0000000000001"), sent_fields: KEYED_FIELDS, ecomind: "E" });
    ok(r.err && /duplicate key|unique/.test(r.err), "a second OPEN attempt on the same order is still refused (174's guard)", r.err);

    // The decline: its close keeps the AVS/CVV answer (respstat/respcode are 174's columns).
    r = await as(db, "service_role", `update public.payment_attempts set state = 'closed_declined', detail = 'Invalid CVV', closed_at = now(),
      respstat = 'C', respcode = '82', avsresp = 'Y', cvvresp = 'N' where id = $1`, [keyedId]);
    ok(!r.err, "a declined attempt closes with its AVS and CVV answers", r.err);
    const declined = await one(db, "select state, respstat, respcode, avsresp, cvvresp from public.payment_attempts where id = $1", [keyedId]);
    ok(JSON.stringify(declined) === JSON.stringify({ state: "closed_declined", respstat: "C", respcode: "82", avsresp: "Y", cvvresp: "N" }),
      "…and they read back: the one place a decline's CVV answer is kept", JSON.stringify(declined));

    // A swipe: no ecomind sent, so the column is null while sent_fields says what WAS sent.
    r = await insertAttempt(db, { ...BASE_ROW("55555555-5555-4555-8555-555555555555", "ssp_swipe0000000000000"), actor_kind: "staff", sent_fields: SWIPE_FIELDS, ecomind: null });
    ok(!r.err, "a swipe attempt is inserted with no ecomind", r.err);
    const swipe = await one(db, "select sent_fields, ecomind from public.payment_attempts where orderid = 'ssp_swipe0000000000000'");
    ok(swipe.ecomind === null && !swipe.sent_fields.includes("ecomind") && swipe.sent_fields.length === SWIPE_FIELDS.length,
      "…sent_fields set and ecomind null: none was sent (not 'written before 291')", JSON.stringify(swipe));

    // Production's older function names none of the four: its insert still works, and reads null.
    r = await insertAttempt(db, BASE_ROW("66666666-6666-4666-8666-666666666666", "ssp_older0000000000000"));
    ok(!r.err, "the OLDER function's insert, naming none of the four, still works", r.err);
    const older = await one(db, "select sent_fields, ecomind, avsresp, cvvresp from public.payment_attempts where orderid = 'ssp_older0000000000000'");
    ok(Object.values(older).every((v) => v === null), "…and its row reads null in all four", JSON.stringify(older));

    // ── 4. Re-apply after real charges: harmless, and it counts the rows as they now stand ──
    const now = await all(db);
    let re = [];
    try { re = await apply(db); ok(true, "a re-apply runs clean with charges already carrying the columns"); }
    catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(JSON.stringify(await all(db)) === JSON.stringify(now), "and moves no row, the new columns' values included");
    ok(re.record && re.record.rows_checked === 6 && re.record.rows_changed === "(none)", "its record counts the rows as they now are", JSON.stringify(re.record));
    await db.close();
  }

  // ── 4b. Writes are locked out BEFORE the snapshot, not only at the ALTER ───────────────────
  // Without it a charge closing its attempt between the snapshot and the ALTER failed the "no row
  // moved" check at a busy moment. PGlite has one connection, so the race itself cannot be staged
  // here: this proves the order in the file and that the lock really is held at the snapshot.
  console.log("migration 291: payment_attempts is locked against writes before the snapshot is taken");
  {
    const t = MIG_TEXT().replace(/\r\n/g, "\n");
    const iBegin = t.indexOf("\nbegin;");
    const at = (needle) => t.indexOf(needle, iBegin);
    const iTimeout = at("set local lock_timeout = '5s';");
    const iLock = at("lock table public.payment_attempts in exclusive mode;");
    const iSnap = at("create temp table m291_before");
    const iAlter = at("alter table public.payment_attempts");
    ok(iBegin > 0 && iTimeout > iBegin && iLock > iTimeout && iSnap > iLock && iAlter > iSnap,
      "begin; then lock_timeout, then the EXCLUSIVE lock, then the snapshot, then the ALTER", JSON.stringify({ iBegin, iTimeout, iLock, iSnap, iAlter }));
    const db = await fresh();
    let err = null;
    try { await db.exec(t.slice(iBegin, iSnap)); } catch (e) { err = e.message; }
    ok(!err, "the file up to the snapshot runs", err);
    const held = await rows(db, "select mode from pg_locks where relation = 'public.payment_attempts'::regclass and granted");
    ok(held.some((r) => r.mode === "ExclusiveLock"), "and at the snapshot the table is held in EXCLUSIVE mode (reads pass, writes wait)", JSON.stringify(held));
    await db.exec("rollback");
    await db.close();
  }

  // ── 5. A CRLF checkout of the file applies the same ─────────────────────────────────────────
  console.log("migration 291: a Windows (CRLF) checkout applies the same");
  {
    const crlf = await fresh();
    let err = null, rec = null;
    try { rec = (await apply(crlf, MIG_TEXT().replace(/\r?\n/g, "\r\n"))).record; } catch (e) { err = e.message; }
    ok(!err && rec && rec.columns === "avsresp text, cvvresp text, ecomind text, sent_fields _text" && rec.rows_changed === "(none)",
      "the CRLF copy applies and prints the same record", err || JSON.stringify(rec));
    await crlf.close();
  }

  // ── 6. The dry run: the same record, nothing left behind ────────────────────────────────────
  console.log("migration 291: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const db = await fresh();
    const before = await all(db);
    const dry = DRY_RUN();
    ok((dry.match(/\ncommit;/g) || []).length === 0 && (dry.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = [];
    try { notices = await apply(db, dry); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(notices.record && notices.record.columns === "avsresp text, cvvresp text, ecomind text, sent_fields _text" && notices.record.rows_checked === 3,
      "it prints the same record the apply would", JSON.stringify(notices.record));
    ok((await columns(db)).length === 0, "and leaves no column behind");
    ok(JSON.stringify(await all(db)) === JSON.stringify(before), "and no row moved");
    await db.close();
  }

  // ── 7. The header's ROLLBACK, as written ────────────────────────────────────────────────────
  console.log("migration 291: the header's ROLLBACK takes the columns and the ledger row away");
  {
    const db = await fresh();
    await apply(db);
    await insertAttempt(db, { ...BASE_ROW("77777777-7777-4777-8777-777777777777", "ssp_rollback000000000"), sent_fields: KEYED_FIELDS, ecomind: "E" });
    const sql = ROLLBACK_SQL();
    ok(/drop column if exists sent_fields/.test(sql) && /drop column if exists cvvresp/.test(sql) && /notify pgrst/.test(sql)
      && /delete from supabase_migrations\.schema_migrations where version = '291';/.test(sql),
      "the ROLLBACK block drops the four columns, reloads PostgREST and removes the ledger row", sql);
    let err = null;
    try { await db.exec(sql); } catch (e) { err = e.message; }
    ok(!err, "it runs as written", err);
    ok((await columns(db)).length === 0, "the four columns are gone");
    ok((await one(db, "select count(*)::int n from supabase_migrations.schema_migrations where version = '291'")).n === 0, "the ledger row is gone");
    ok((await one(db, "select count(*)::int n from public.payment_attempts")).n === 4, "every attempt row is still there (only the columns went)");
    // The functions' fallback: the insert they retry with, without the four keys, works after a rollback.
    const r = await insertAttempt(db, BASE_ROW("88888888-8888-4888-8888-888888888888", "ssp_afterrollback00000"));
    ok(!r.err, "the write the functions fall back to still works on a rolled-back table", r.err);
    await db.close();
  }

  // ── 8. Mutants: broken shapes are refused, and nothing is left behind ───────────────────────
  console.log("migration 291: refuses what it cannot prove");
  {
    // A back-fill snuck in after the ALTER: every old row claims an ecomind it was never sent with.
    let db = await fresh();
    const backfill = MIG_TEXT().replace(STATEMENT, (s) => s + "update public.payment_attempts set ecomind = 'E' where rail = 'card';\n");
    ok(backfill !== MIG_TEXT(), "(mutant built: a back-fill of ecomind)");
    let r = await refused(db, backfill, /these payment_attempts rows changed during the apply: 1, 2$/);
    ok(r.matched && r.columnsGone && r.rowsKept, "a file that back-fills: refused, naming the rows, nothing left", JSON.stringify(r));
    await db.close();

    // A file that rewrites a 174 value.
    db = await fresh();
    const unblock = MIG_TEXT().replace(STATEMENT, (s) => s + "update public.payment_attempts set state = 'closed_declined' where state = 'closed_unknown';\n");
    r = await refused(db, unblock, /these payment_attempts rows changed during the apply: 3$/);
    ok(r.matched && r.columnsGone && r.rowsKept, "a file that unblocks a closed_unknown: refused", JSON.stringify(r));
    await db.close();

    // A column that already exists with the wrong type: `add column if not exists` skips it, the check sees it.
    db = await fresh();
    await db.exec("alter table public.payment_attempts add column ecomind integer");
    r = await refused(db, MIG_TEXT(), /payment_attempts\.ecomind should be text NULL with no default, is int4/);
    ok(r.matched && r.rowsKept, "an ecomind that is already an integer: refused", JSON.stringify(r));
    await db.close();

    // sent_fields as plain text, not an array.
    db = await fresh();
    await db.exec("alter table public.payment_attempts add column sent_fields text");
    r = await refused(db, MIG_TEXT(), /payment_attempts\.sent_fields should be _text NULL with no default, is text/);
    ok(r.matched && r.rowsKept, "a sent_fields that is plain text: refused", JSON.stringify(r));
    await db.close();

    // A default on a new column would stamp every future older-function row with a claim it never made.
    db = await fresh();
    const withDefault = MIG_TEXT().replace("add column if not exists ecomind     text,", "add column if not exists ecomind     text default 'E',");
    ok(withDefault !== MIG_TEXT(), "(mutant built: ecomind default 'E')");
    r = await refused(db, withDefault, /ecomind should be text NULL with no default/);
    ok(r.matched && r.columnsGone && r.rowsKept, "a default on ecomind: refused", JSON.stringify(r));
    await db.close();

    // The table opened to the browser.
    db = await fresh();
    await db.exec("grant select on public.payment_attempts to authenticated");
    r = await refused(db, MIG_TEXT(), /authenticated holds SELECT on payment_attempts\.sent_fields/);
    ok(r.matched && r.columnsGone && r.rowsKept, "payment_attempts readable by authenticated: refused", JSON.stringify(r));
    await db.close();

    // service_role unable to write: every charge would fall back to writing without the columns.
    db = await fresh();
    await db.exec("revoke update on public.payment_attempts from service_role");
    r = await refused(db, MIG_TEXT(), /service_role lacks UPDATE on payment_attempts\.sent_fields/);
    ok(r.matched && r.columnsGone && r.rowsKept, "service_role without UPDATE: refused", JSON.stringify(r));
    await db.close();

    // RLS switched off, or a policy added: no longer service-role only.
    db = await fresh();
    await db.exec("alter table public.payment_attempts disable row level security");
    r = await refused(db, MIG_TEXT(), /RLS is off on payment_attempts/);
    ok(r.matched && r.columnsGone && r.rowsKept, "RLS off: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    await db.exec("create policy open_read on public.payment_attempts for select using (true)");
    r = await refused(db, MIG_TEXT(), /payment_attempts has a policy/);
    ok(r.matched && r.columnsGone && r.rowsKept, "a policy on payment_attempts: refused", JSON.stringify(r));
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
