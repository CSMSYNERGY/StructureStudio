// Execute migration 283 for real in PGlite (Postgres compiled to WASM, in memory) on top of 123's and
// 125's allocators as the files wrote them, then check what it promises:
//   * a blank (NULL) quote or invoice start hands out 1000, then 1001, and stores 1002; a prefix rides
//     along ('Q-1000');
//   * a SET counter is used exactly as before, with no floor applied (even one below an issued number:
//     that case belongs to portal-settings' save);
//   * a NULL counter over numbers already issued under the CURRENT prefix continues one past the
//     highest of them; other prefixes, non-digit tails, over-long tails and numbers under 1000 never
//     raise it, and the CRM's invoice rows (issued_by 'ghl') never count;
//   * no row: NULL, and still no row;
//   * anon and authenticated cannot call either allocator; service_role can;
//   * THE RECORD, the one row `supabase db query` prints; a dry run (the last commit; swapped for
//     rollback;) prints the same row and leaves 123/125 in place; a re-apply and a CRLF checkout are
//     harmless;
//   * the header's ROLLBACK, run as written, puts back 123's and 125's bodies byte for byte (md5 against
//     the bodies lifted from those files) and their behaviour;
//   * broken shapes are refused with the WHOLE file rolled back (mutants), including the one that drops
//     the row lock.
//
// CONCURRENCY. PGlite is one connection, so two first allocations can never truly race here. What this
// file can prove, and does: the second allocation is driven by the counter the first one stored and
// never re-reads the floor (even inside one transaction, with nothing persisted to designs), and the
// lock is taken before the floor read (the migration's own tripwire, which a mutant without
// `for update` trips). The waiting itself is Postgres' row-lock contract.
//
// Nothing here touches the live project: no network, no Supabase. Tenants are made up. The repo is
// public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration283.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/283_ss_numbering_default_1000.sql"), "utf8");
const FILE_123 = () => fs.readFileSync(path.join(WT, "supabase/migrations/123_allocate_ss_quote_number.sql"), "utf8");
const FILE_125 = () => fs.readFileSync(path.join(WT, "supabase/migrations/125_ss_invoice.sql"), "utf8");

// 123's and 125's function bodies, lifted from the files themselves so the rollback check compares
// against the real text and not a copy that could drift.
const bodyOf = (src, fn) => {
  const m = src.replace(/\r\n/g, "\n").match(new RegExp(`create or replace function public\\.${fn}\\(p_client_id text\\)[\\s\\S]*?as \\$fn\\$([\\s\\S]*?)\\$fn\\$;`));
  if (!m) throw new Error(`${fn}'s body moved; re-point bodyOf`);
  return m[1];
};
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const BODY_MD5 = {
  allocate_ss_quote_number: md5(bodyOf(FILE_123(), "allocate_ss_quote_number")),
  allocate_ss_invoice_number: md5(bodyOf(FILE_125(), "allocate_ss_invoice_number")),
};

// The tables the allocators and the rehearsal touch, as they are live (information_schema, 2026-10-07),
// cut to the columns that matter, BEFORE 125 (which adds the invoice pair and issued_by itself):
//   client_settings  RLS on, no policy, service-role only;
//   designs          short_code globally unique, bldg_w/bldg_h NOT NULL with no default, the status
//                    check, 122's partial unique quote number, and designs_ensure_order (live body),
//                    which opens an order on an accepted insert and does nothing for a draft;
//   invoice_sends    keyed (client_id, short_code), status check.
// Functions follow Supabase's default privileges (EXECUTE for anon, authenticated and service_role),
// which 123/125's revokes then close for the browser roles.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);
insert into supabase_migrations.schema_migrations (version, name) values ('283', '283_ss_numbering_default_1000');

create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(),
  invoice_in_ghl boolean not null default false, ghl_invoicing_allowed boolean not null default false,
  ss_quote_next integer, ss_quote_prefix text not null default '',
  ss_tax_rate numeric(7,5)
);
alter table public.client_settings enable row level security;
grant all on public.client_settings to anon, authenticated, service_role;
revoke all on public.client_settings from anon, authenticated;

create table public.designs (
  id uuid primary key default gen_random_uuid(),
  short_code text not null unique, client_id text not null,
  status text not null default 'sent' check (status in ('draft','inventory','sent','accepted','invoiced','delivered')),
  bldg_w integer not null, bldg_h integer not null,
  ss_quote_number text, updated_at timestamptz, created_at timestamptz not null default now()
);
create unique index designs_ss_quote_number_uniq on public.designs (client_id, ss_quote_number) where ss_quote_number is not null;
create table public.orders (client_id text not null, short_code text not null, ordered_at timestamptz, unique (client_id, short_code));
create function public.designs_ensure_order() returns trigger language plpgsql as $$
begin
  if new.status in ('accepted','invoiced','delivered') then
    insert into public.orders (client_id, short_code, ordered_at)
    values (new.client_id, new.short_code, coalesce(new.updated_at, now()))
    on conflict (client_id, short_code) do nothing;
  end if;
  return new;
end;
$$;
create trigger designs_ensure_order_ins after insert on public.designs for each row execute function public.designs_ensure_order();

create table public.invoice_sends (
  client_id text not null, short_code text not null,
  status text not null default 'claimed' check (status in ('claimed','created','sent','failed')),
  invoice_number text, created_at timestamptz not null default now(),
  primary key (client_id, short_code)
);
`;

// The live mix (2026-10-07): five rows, one on StructureStudio paperwork with both numbers set (and
// paperwork already out under its prefixes), four on the CRM path with nothing set.
const SEED = `
insert into public.client_settings
  (client_id, invoice_in_ghl, ghl_invoicing_allowed, ss_quote_next, ss_quote_prefix, ss_invoice_next, ss_invoice_prefix, ss_tax_rate, updated_at) values
  ('acme-sheds',     true,  true,  null, '',    null, '',     null,   '2026-09-01 10:00+00'),
  ('bravo-barns',    true,  false, null, '',    null, '',     null,   '2026-09-02 10:00+00'),
  ('charlie-cabins', true,  false, null, '',    null, '',     null,   '2026-09-03 10:00+00'),
  ('delta-sheds',    false, false, 1042, 'DS-', 2007, 'DSI-', 0.0725, '2026-09-04 10:00+00'),
  ('echo-barns',     true,  false, null, '',    null, '',     null,   '2026-09-05 10:00+00');
insert into public.designs (client_id, short_code, status, bldg_w, bldg_h, ss_quote_number) values
  ('delta-sheds', 'SS-DELTA0001', 'accepted', 10, 12, 'DS-1040'),
  ('delta-sheds', 'SS-DELTA0002', 'sent',     12, 16, 'DS-1041');
insert into public.invoice_sends (client_id, short_code, status, issued_by, invoice_number) values
  ('delta-sheds', 'SS-DELTA0001', 'sent', 'structurestudio', 'DSI-2006');
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];

// 123 and 125 as applied live (125 also adds the invoice pair, issued_by and its unique index).
async function fresh() {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(FILE_123());
  await db.exec(FILE_125());
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
// The header's ROLLBACK block, exactly as a human would copy it out: the lines under "── ROLLBACK"
// that are SQL ("--   " + the statement line) or a bare "--" (a blank line inside a function body),
// up to the paragraph that follows them, with the comment marker taken off.
const ROLLBACK_SQL = () => {
  const lines = MIG_TEXT().replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^-- ── ROLLBACK/.test(l));
  if (start < 0) throw new Error("the ROLLBACK heading moved");
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (l === "--") { out.push(""); continue; }
    if (!/^--   /.test(l)) break;
    out.push(l.replace(/^--   /, ""));
  }
  return out.join("\n");
};

// The allocators as submit-estimate and portal-settings call them: as service_role, one call per
// transaction (PostgREST's rpc).
async function alloc(db, kind, clientId) {
  const fn = kind === "quote" ? "allocate_ss_quote_number" : "allocate_ss_invoice_number";
  await db.exec("begin");
  await db.exec("set local role service_role");
  let out, err = null;
  try { out = (await one(db, `select public.${fn}($1) as n`, [clientId])).n; } catch (e) { err = e.message; }
  await db.exec(err ? "rollback" : "commit");
  if (err) throw new Error(err);
  return out;
}
const counters = async (db, id) => one(db, "select ss_quote_next, ss_invoice_next from public.client_settings where client_id = $1", [id]);
const settings = async (db) => (await db.query("select client_id, invoice_in_ghl, ss_quote_next, ss_quote_prefix, ss_invoice_next, ss_invoice_prefix from public.client_settings order by client_id")).rows;
const bodies = async (db) => {
  const r = (await db.query(`select p.proname, md5(replace(p.prosrc, chr(13), '')) as m from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('allocate_ss_quote_number', 'allocate_ss_invoice_number') order by 1`)).rows;
  return Object.fromEntries(r.map((x) => [x.proname, x.m]));
};
const are123and125 = async (db) => {
  const b = await bodies(db);
  return b.allocate_ss_quote_number === BODY_MD5.allocate_ss_quote_number && b.allocate_ss_invoice_number === BODY_MD5.allocate_ss_invoice_number;
};
const tenant = async (db, id, cols = {}) => {
  const keys = ["client_id", ...Object.keys(cols)];
  await db.query(`insert into public.client_settings (${keys.join(", ")}) values (${keys.map((_k, i) => `$${i + 1}`).join(", ")})`, [id, ...Object.values(cols)]);
};
const issueQuotes = async (db, id, numbers) => {
  for (const [i, n] of numbers.entries()) {
    await db.query("insert into public.designs (client_id, short_code, status, bldg_w, bldg_h, ss_quote_number) values ($1, $2, 'sent', 10, 12, $3)",
      [id, `SS-${id.slice(0, 5).toUpperCase()}${String(i).padStart(4, "0")}`, n]);
  }
};
const issueInvoices = async (db, id, rows) => {
  for (const [i, [n, by]] of rows.entries()) {
    await db.query("insert into public.invoice_sends (client_id, short_code, status, issued_by, invoice_number) values ($1, $2, 'sent', $3, $4)",
      [id, `SS-${id.slice(0, 5).toUpperCase()}I${String(i).padStart(3, "0")}`, by, n]);
  }
};

// Did the apply fail with `re`, and leave nothing behind?
async function refused(db, sql, re) {
  const before = JSON.stringify(await settings(db));
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e.message; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  return {
    err, matched: !!err && re.test(err),
    allocatorsKept: await are123and125(db),
    rowsKept: JSON.stringify(await settings(db)) === before,
  };
}

const EXPECTED_RECORD = {
  migration: "283", rehearsal: "quote 1000, 1001, Q-1005; invoice 1000, 1001, INV-1005",
  rows_checked: 5, rows_changed: "(none)", paperwork_rows: 1, paperwork_rows_with_null_counter: 0,
};

(async () => {
  // ── 0. Before 283: what it replaces ─────────────────────────────────────────────────────────
  console.log("before 283: a blank start is a refusal (123/125)");
  {
    const db = await fresh();
    ok(await are123and125(db), "the stub carries 123's and 125's bodies, byte for byte");
    await tenant(db, "foxtrot-sheds");
    ok((await alloc(db, "quote", "foxtrot-sheds")) === null && (await alloc(db, "invoice", "foxtrot-sheds")) === null,
      "123/125 hand back NULL for a NULL counter (submit-estimate and send_invoice refuse on that)");
    await db.close();
  }

  // ── 1. The apply on the live shape ──────────────────────────────────────────────────────────
  console.log("migration 283: applies on the live shape; no row moves");
  const db = await fresh();
  {
    const before = await settings(db);
    let notices = [];
    try { notices = await apply(db); ok(true, "283 applied cleanly, its own checks and rehearsal included"); }
    catch (e) { ok(false, "283 applied", e.message); }
    ok(notices.some((n) => /283: checks hold; a blank start now begins at 1000; 5 existing row\(s\) unchanged$/.test(n)),
      "its own checks held", notices.join(" | "));
    ok(JSON.stringify(notices.record) === JSON.stringify(EXPECTED_RECORD),
      "THE RECORD: the rehearsal's numbers, five rows unchanged, one paperwork row, none with a blank counter", JSON.stringify(notices.record));
    ok(JSON.stringify(await settings(db)) === JSON.stringify(before), "every client_settings row is what it was");
    ok((await one(db, "select count(*)::int n from public.client_settings where client_id like '\\_\\_m283%'")).n === 0
      && (await one(db, "select count(*)::int n from public.designs where client_id like '\\_\\_m283%'")).n === 0
      && (await one(db, "select count(*)::int n from public.invoice_sends where client_id like '\\_\\_m283%'")).n === 0,
      "the rehearsal tenant, its designs and its invoices are gone");
    ok((await one(db, "select count(*)::int n from public.orders where client_id like '\\_\\_m283%'")).n === 0, "the rehearsal's draft designs opened no order");
    ok((await one(db, "select to_regclass('pg_temp.m283_before') is null as gone")).gone, "the snapshot table went with the commit");
    const shape = (await db.query(`select p.proname, p.prosecdef, p.proconfig, p.prorettype::regtype::text as ret,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('allocate_ss_quote_number', 'allocate_ss_invoice_number') order by 1`)).rows;
    ok(shape.length === 2 && shape.every((s) => s.prosecdef && JSON.stringify(s.proconfig) === '["search_path=public"]' && s.ret === "text"),
      "both allocators: SECURITY DEFINER, search_path=public, return text", JSON.stringify(shape));
    ok(shape.every((s) => !s.anon && !s.auth && s.svc), "(h) anon and authenticated lack EXECUTE; service_role has it", JSON.stringify(shape));
    for (const role of ["anon", "authenticated"]) {
      let err = null;
      await db.exec("begin");
      await db.exec(`set local role ${role}`);
      try { await db.query("select public.allocate_ss_quote_number('delta-sheds')"); } catch (e) { err = e.message; }
      await db.exec("rollback");
      ok(/permission denied for function allocate_ss_quote_number/.test(err || ""), `(h) ${role} calling it directly: permission denied`, err);
    }
  }

  // ── 2. What a blank start does now ──────────────────────────────────────────────────────────
  console.log("migration 283: a blank start means 1000");
  {
    // (a) A row with nothing chosen (the shape 280's default creates): 1000, then 1001; stored 1002.
    await tenant(db, "foxtrot-sheds");
    ok((await alloc(db, "quote", "foxtrot-sheds")) === "1000", "(a) first quote: 1000");
    ok((await alloc(db, "quote", "foxtrot-sheds")) === "1001", "(a) second quote: 1001");
    ok((await alloc(db, "invoice", "foxtrot-sheds")) === "1000" && (await alloc(db, "invoice", "foxtrot-sheds")) === "1001",
      "(a) invoices are their own book: 1000, then 1001");
    const fc = await counters(db, "foxtrot-sheds");
    ok(fc.ss_quote_next === 1002 && fc.ss_invoice_next === 1002, "(a) the counters now read 1002 (the next number to use)", JSON.stringify(fc));

    // (b) A prefix rides along.
    await tenant(db, "golf-garages", { ss_quote_prefix: "Q-", ss_invoice_prefix: "INV-" });
    ok((await alloc(db, "quote", "golf-garages")) === "Q-1000" && (await alloc(db, "invoice", "golf-garages")) === "INV-1000",
      "(b) a blank start with a prefix: Q-1000 / INV-1000");

    // (c) A set counter: exactly as before. Even one set BELOW an issued number (a hand edit) is not
    // floored here, as 123 never floored it: portal-settings' save is the check for that.
    ok((await alloc(db, "quote", "delta-sheds")) === "DS-1042" && (await alloc(db, "invoice", "delta-sheds")) === "DSI-2007",
      "(c) a set counter is used as it stands: DS-1042 / DSI-2007");
    const dc = await counters(db, "delta-sheds");
    ok(dc.ss_quote_next === 1043 && dc.ss_invoice_next === 2008, "(c) and goes up by one", JSON.stringify(dc));
    await db.query("update public.client_settings set ss_quote_next = 1040 where client_id = 'delta-sheds'");
    ok((await alloc(db, "quote", "delta-sheds")) === "DS-1040", "(c) a counter hand-set below an issued number is still not floored (unchanged from 123)");

    // (d) Cleared after use: one past the highest issued under THIS prefix. Another prefix, a non-digit
    // tail, an empty tail and an 11-digit tail (which would overflow the counter) are all ignored.
    await tenant(db, "hotel-homes", { ss_quote_prefix: "Q-" });
    await issueQuotes(db, "hotel-homes", ["Q-1000", "Q-1001", "Q-1002", "Q-1003", "Q-1004", "X-9000", "Q-12A", "Q-", "Q-12345678901", "9999"]);
    ok((await alloc(db, "quote", "hotel-homes")) === "Q-1005", "(d) Q-1000..Q-1004 issued, field blank: Q-1005; X-9000, Q-12A, Q-, Q-12345678901 and 9999 ignored");
    ok((await alloc(db, "quote", "hotel-homes")) === "Q-1006", "(d) and then Q-1006 (the counter, not the floor, from here on)");

    // (e) Issued numbers below 1000 never pull the start down; a bare-number book continues past its own.
    await tenant(db, "india-sheds");
    await issueQuotes(db, "india-sheds", ["12", "999", "0042", "Q-5000"]);
    ok((await alloc(db, "quote", "india-sheds")) === "1000", "(e) issued 12, 999 and 0042 (no prefix): still 1000; Q-5000 is another prefix");
    await tenant(db, "juliet-barns");
    await issueQuotes(db, "juliet-barns", ["1499", "1500"]);
    ok((await alloc(db, "quote", "juliet-barns")) === "1501", "(e) cleared after 1500 was issued: 1501, never a second 1500");
    // A new prefix has issued nothing, so it restarts at 1000 (the portal's floor rule, the same way).
    await tenant(db, "kilo-cabins", { ss_quote_prefix: "K26-" });
    await issueQuotes(db, "kilo-cabins", ["K25-1000", "K25-1001"]);
    ok((await alloc(db, "quote", "kilo-cabins")) === "K26-1000", "(e) a new prefix restarts at 1000");

    // (f) No row: NULL, and no row appears.
    ok((await alloc(db, "quote", "lima-lofts")) === null && (await alloc(db, "invoice", "lima-lofts")) === null, "(f) no settings row: NULL from both");
    ok((await one(db, "select count(*)::int n from public.client_settings where client_id = 'lima-lofts'")).n === 0, "(f) and still no row");

    // (g) Invoices: only OUR rows set the floor. The CRM's numbers are a different book.
    await tenant(db, "mike-sheds", { ss_invoice_prefix: "INV-" });
    await issueInvoices(db, "mike-sheds", [["INV-1000", "structurestudio"], ["INV-1001", "structurestudio"], ["INV-1002", "structurestudio"], ["INV-7000", "ghl"], ["8000", "ghl"], ["OLD-3000", "structurestudio"]]);
    ok((await alloc(db, "invoice", "mike-sheds")) === "INV-1003", "(g) INV-1000..1002 ours: INV-1003; the CRM's INV-7000 and OLD-3000 (another prefix) ignored");
    ok((await alloc(db, "quote", "mike-sheds")) === "1000", "(g) and the quote book is untouched by any invoice");

    // Concurrency, as far as one connection can take it: two first allocations in ONE transaction, with
    // nothing persisted to designs in between (the way a refused submit leaves it). The second is driven
    // by the counter the first stored, so it can never re-derive 1000 from the floor.
    await tenant(db, "november-barns");
    await db.exec("begin");
    await db.exec("set local role service_role");
    const twice = (await db.query("select public.allocate_ss_quote_number('november-barns') as a, public.allocate_ss_quote_number('november-barns') as b")).rows[0];
    await db.exec("commit");
    ok(twice.a === "1000" && twice.b === "1001", "concurrency: back-to-back first allocations with nothing persisted: 1000 then 1001, never 1000 twice", JSON.stringify(twice));
    // And a number that was taken and never used (a refusal after allocation) is a gap, never a repeat.
    ok((await alloc(db, "quote", "november-barns")) === "1002", "concurrency: the next one is 1002, so a burned number stays burned");
    // updated_at moves with the bump, as 123's did.
    const ts = await one(db, "select updated_at > '2026-09-04 10:00+00' as moved from public.client_settings where client_id = 'delta-sheds'");
    ok(ts.moved, "updated_at moves with every allocation");
  }

  // ── 3. Re-apply: harmless, counters as they now stand ───────────────────────────────────────
  console.log("migration 283: a re-apply is harmless");
  {
    const now = await settings(db);
    let re = [];
    try { re = await apply(db); ok(true, "(i) a re-apply runs clean"); } catch (e) { ok(false, "(i) a re-apply runs clean", e.message); }
    ok(JSON.stringify(await settings(db)) === JSON.stringify(now), "(i) and moves no row");
    ok(re.record && re.record.rows_checked === 13 && re.record.rows_changed === "(none)" && re.record.paperwork_rows === 9 && re.record.paperwork_rows_with_null_counter === 5,
      "(i) its record counts the rows as they now are: 13, 9 on paperwork, 5 of them with a book still blank (each takes 1000 or its floor on first use)", JSON.stringify(re.record));
    await db.close();
  }

  // ── 4. A CRLF checkout of the file applies the same ─────────────────────────────────────────
  console.log("migration 283: a Windows (CRLF) checkout applies the same");
  {
    const crlf = await fresh();
    let err = null, rec = null;
    try { rec = (await apply(crlf, MIG_TEXT().replace(/\r?\n/g, "\r\n"))).record; } catch (e) { err = e.message; }
    ok(!err && JSON.stringify(rec) === JSON.stringify(EXPECTED_RECORD), "(i) the CRLF copy applies and prints the same record", err || JSON.stringify(rec));
    await tenant(crlf, "oscar-sheds", { ss_quote_prefix: "Q-" });
    await issueQuotes(crlf, "oscar-sheds", ["Q-1000", "Q-1001"]);
    ok((await alloc(crlf, "quote", "oscar-sheds")) === "Q-1002", "(i) and the CRLF body behaves the same (the digit pattern survives the line endings)");
    await crlf.close();
  }

  // ── 5. The dry run: the same record, nothing left behind ────────────────────────────────────
  console.log("migration 283: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const dry = await fresh();
    const before = await settings(dry);
    const text = DRY_RUN();
    ok((text.match(/\ncommit;/g) || []).length === 0 && (text.match(/\nrollback;/g) || []).length === 1, "(i) the dry run has no commit left in it, and one rollback");
    let rec = null;
    try { rec = (await apply(dry, text)).record; } catch (e) { ok(false, "(i) the dry run ran", e.message); }
    ok(JSON.stringify(rec) === JSON.stringify(EXPECTED_RECORD), "(i) it prints the same record the apply would", JSON.stringify(rec));
    ok(await are123and125(dry), "(i) and leaves 123's and 125's allocators in place");
    ok(JSON.stringify(await settings(dry)) === JSON.stringify(before), "(i) and no row moved");
    await tenant(dry, "papa-sheds");
    ok((await alloc(dry, "quote", "papa-sheds")) === null, "(i) a blank start is still a refusal after a dry run");
    await dry.close();
  }

  // ── 6. The header's ROLLBACK, as written ────────────────────────────────────────────────────
  console.log("migration 283: the header's ROLLBACK puts 123's and 125's bodies back");
  {
    const rb = await fresh();
    await apply(rb);
    ok(!(await are123and125(rb)), "(j) after the apply, the bodies are 283's");
    await tenant(rb, "quebec-barns");
    ok((await alloc(rb, "quote", "quebec-barns")) === "1000", "(j) a tenant takes 1000 while 283 is live");
    const sql = ROLLBACK_SQL();
    ok(/^begin;\n/.test(sql) && /\ncommit;\s*$/.test(sql) && (sql.match(/create or replace function/g) || []).length === 2
      && (sql.match(/^revoke execute on function/gm) || []).length === 6
      && /delete from supabase_migrations\.schema_migrations where version = '283';/.test(sql),
      "(j) the ROLLBACK block holds both functions, their six revokes and the ledger row, in one transaction", sql.slice(0, 200));
    let err = null;
    try { await rb.exec(sql); } catch (e) { err = e.message; }
    ok(!err, "(j) it runs as written", err);
    const b = await bodies(rb);
    ok(b.allocate_ss_quote_number === BODY_MD5.allocate_ss_quote_number, "(j) the quote allocator's body is 123's, md5 for md5", JSON.stringify(b));
    ok(b.allocate_ss_invoice_number === BODY_MD5.allocate_ss_invoice_number, "(j) the invoice allocator's body is 125's, md5 for md5", JSON.stringify(b));
    const acl = (await rb.query(`select bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and has_function_privilege('service_role', p.oid, 'EXECUTE')) as fine from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('allocate_ss_quote_number', 'allocate_ss_invoice_number')`)).rows[0];
    ok(acl.fine, "(j) still service-role only");
    ok((await one(rb, "select count(*)::int n from supabase_migrations.schema_migrations where version = '283'")).n === 0, "(j) the ledger row is gone");
    await tenant(rb, "romeo-cabins");
    ok((await alloc(rb, "quote", "romeo-cabins")) === null, "(j) a blank start is a refusal again");
    ok((await alloc(rb, "quote", "quebec-barns")) === "1001", "(j) a tenant that took 1000 under 283 keeps its counter and carries on");
    await rb.close();
  }

  // ── 7. Mutants: broken shapes are refused, and nothing is left behind ───────────────────────
  console.log("migration 283: refuses what it cannot prove");
  {
    const MIG = MIG_TEXT().replace(/\r\n/g, "\n");
    // The statements themselves start a line; the header's ROLLBACK quotes 123/125 behind "--   ".
    const quoteFnAt = MIG.indexOf("\ncreate or replace function public.allocate_ss_quote_number");
    const invoiceFnAt = MIG.indexOf("\ncreate or replace function public.allocate_ss_invoice_number");
    if (quoteFnAt < 0 || invoiceFnAt < quoteFnAt) throw new Error("the allocator statements moved; re-point the mutants");
    const checkAt = MIG.indexOf("do $check$");
    const inQuoteFn = (from, to) => MIG.slice(0, quoteFnAt) + MIG.slice(quoteFnAt, invoiceFnAt).replace(from, to) + MIG.slice(invoiceFnAt);
    const inInvoiceFn = (from, to) => MIG.slice(0, invoiceFnAt) + MIG.slice(invoiceFnAt, checkAt).replace(from, to) + MIG.slice(checkAt);
    const mutants = [
      ["the floor dropped (a cleared field restarts at 1000 over issued numbers)", inQuoteFn("greatest(1000, coalesce(max(", "greatest(1000, 0 * coalesce(max("),
        /the quote rehearsal handed out 1000, 1001, Q-1000, expected 1000, 1001, Q-1005/],
      ["a blank start invented as 1, not 1000", inQuoteFn("greatest(1000,", "greatest(1,"),
        /the quote rehearsal handed out 1, 2, Q-1005, expected 1000, 1001, Q-1005/],
      ["the CRM's invoice numbers counted in our floor", inInvoiceFn("       and s.issued_by = 'structurestudio'\n", ""),
        /the invoice rehearsal handed out 1000, 1001, INV-5001, expected 1000, 1001, INV-1005/],
      ["the row lock dropped (two first quotes could both read the floor)", inQuoteFn("\n     for update;", ";"),
        /allocate_ss_quote_number must lock the settings row \(for update\) before it reads the floor/],
      ["the invoice allocator no longer SECURITY DEFINER", inInvoiceFn("security definer\n", ""),
        /allocate_ss_invoice_number is not SECURITY DEFINER/],
      ["a different search_path", inQuoteFn("set search_path to 'public'", "set search_path to 'public', 'extensions'"),
        /allocate_ss_quote_number should run with search_path=public/],
      ["EXECUTE handed back to anon", MIG.replace("\nrevoke execute on function public.allocate_ss_quote_number(text) from authenticated;\n",
        (s) => s + "grant execute on function public.allocate_ss_quote_number(text) to anon;\n"), /anon can execute allocate_ss_quote_number/],
      ["a counter that keeps NULL (the first number would come back NULL forever)", inQuoteFn("coalesce(ss_quote_next, v_start) + 1", "ss_quote_next + 1"),
        /the quote rehearsal handed out NULL, NULL, NULL/],
      ["numbers invented for every blank row as a data change", MIG.replace("-- ── CHECKS:", "update public.client_settings set ss_quote_next = 1000 where ss_quote_next is null;\n-- ── CHECKS:"),
        /these client_settings rows changed during the apply \(a quote or invoice issued meanwhile\?\): acme-sheds, bravo-barns, charlie-cabins, echo-barns/],
    ];
    for (const [label, sql, re] of mutants) {
      ok(sql !== MIG, `(mutant built: ${label})`);
      const m = await fresh();
      const r = await refused(m, sql, re);
      ok(r.matched && r.allocatorsKept && r.rowsKept, `(k) ${label}: refused, 123/125 kept, no row moved`, JSON.stringify(r));
      await m.close();
    }

    // A row already carrying the rehearsal's name is never touched.
    let m = await fresh();
    await tenant(m, "__m283_rehearsal__", { ss_quote_next: 77 });
    let r = await refused(m, MIG, /a client_settings row named __m283_rehearsal__ or __m283_no_row__ already exists/);
    ok(r.matched && r.allocatorsKept && r.rowsKept, "(k) a row named like the rehearsal: refused, left alone", JSON.stringify(r));
    await m.close();

    // service_role unable to call it: every quote and invoice would fail.
    m = await fresh();
    await m.exec("revoke execute on function public.allocate_ss_invoice_number(text) from service_role");
    r = await refused(m, MIG, /service_role cannot execute allocate_ss_invoice_number/);
    ok(r.matched && r.allocatorsKept && r.rowsKept, "(k) service_role without EXECUTE: refused", JSON.stringify(r));
    await m.close();
  }

  // ── 8. 280's own test still holds next to this file ─────────────────────────────────────────
  // (run separately: node tests/sql/migration280.test.cjs — this file does not import it)

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
