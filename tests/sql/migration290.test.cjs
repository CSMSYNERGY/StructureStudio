// Execute migration 290 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// client_settings and tax_code_assignments as they are live, then check what it promises:
//   * tax_codes_enabled is boolean NOT NULL DEFAULT false, and the column comment says what it is;
//   * on the FIRST apply, exactly the builders with codes AND a settings row are switched on (a
//     builder with codes but no settings row is counted, not invented a row);
//   * NOTHING ELSE MOVES: mode, capability, rate, label, delivery, numbering and updated_at are all
//     exactly as they were on every row, and no code is touched;
//   * a brand-new row starts off, both inserted bare and as portal-settings' save_company_tax
//     creates it (an upsert of named columns); an existing row keeps its switch through a save that
//     does not name it, and the switch itself saves as service_role;
//   * a RE-apply after builders have chosen moves nobody's switch;
//   * THE RECORD, the one row `supabase db query` prints, carries counts only; a dry run (the last
//     commit; swapped for rollback;) prints the same row and leaves nothing; a CRLF checkout is
//     harmless;
//   * the header's ROLLBACK, run as written, drops the column and the ledger row and keeps codes;
//   * broken shapes are refused with the WHOLE file rolled back (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration290.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
// LF, whatever the checkout: the mutants below splice LF-only text. Section 6 tries CRLF on purpose.
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/290_tax_codes_enabled.sql"), "utf8").replace(/\r\n/g, "\n");

// client_settings as it is live, cut to the columns 290 checks and the Tax tab's saves touch: 121's
// mode, 125's invoice counter, 158's tax trio, 217's capability, the CRM credentials and the
// save's own updated_at. RLS on with no policies, and an ACL of postgres + service_role only:
// granted to everyone first and then revoked, which is how Supabase's default privileges and the
// migrations that closed it left it. No trigger (live has none). tax_code_assignments and its
// catalog as 246 made them: service-role only, one code per target.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);
insert into supabase_migrations.schema_migrations (version, name) values ('290', '290_tax_codes_enabled');

create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(),
  ghl_location_id text, ghl_api_key text, business_name text,
  invoice_in_ghl boolean not null default false,
  ss_quote_next integer, ss_quote_prefix text not null default '',
  ss_invoice_next integer, ss_invoice_prefix text not null default '',
  ss_tax_rate numeric(7,5), ss_tax_label text not null default 'Sales tax', ss_tax_delivery boolean not null default false,
  ghl_invoicing_allowed boolean not null default false,
  constraint client_settings_ss_tax_rate_range check (ss_tax_rate is null or (ss_tax_rate >= 0 and ss_tax_rate <= 0.25))
);
alter table public.client_settings enable row level security;
grant all on public.client_settings to anon, authenticated, service_role;
revoke all on public.client_settings from anon, authenticated;

create table public.avalara_tax_codes (code text primary key, description text);
insert into public.avalara_tax_codes (code, description) values
  ('P0000000', 'Tangible personal property (tpp)'), ('FR010000', 'Delivery by company vehicle'), ('SI020200', 'Installation');
create table public.tax_code_assignments (
  client_id text not null, target_type text not null check (target_type in ('style', 'heading')),
  target_key text not null, tax_code text not null references public.avalara_tax_codes (code),
  updated_at timestamptz not null default now(), updated_by uuid,
  primary key (client_id, target_type, target_key)
);
alter table public.tax_code_assignments enable row level security;
grant all on public.avalara_tax_codes, public.tax_code_assignments to service_role;
revoke all on public.avalara_tax_codes, public.tax_code_assignments from public;
`;

// Five settings rows: two with codes (one in paperwork mode, one on the CRM path), three without,
// across the modes and rates the live table holds. foxtrot-sheds has codes and NO settings row.
const SEED = `
insert into public.client_settings
  (client_id, ghl_location_id, ghl_api_key, business_name, invoice_in_ghl, ghl_invoicing_allowed,
   ss_quote_next, ss_invoice_next, ss_tax_rate, ss_tax_label, ss_tax_delivery, updated_at) values
  ('acme-sheds',     null,        null,            'Acme Sheds',     false, false, 1042, 2007, 0.0725, 'Sales tax',       true,  '2026-09-01 10:00+00'),
  ('bravo-barns',    'loc-bravo', 'harness-key-b', 'Bravo Barns',    true,  false, null, null, null,   'Sales tax',       false, '2026-09-02 10:00+00'),
  ('charlie-cabins', 'loc-chas',  'harness-key-c', 'Charlie Cabins', true,  true,  null, null, 0,      'County tax',      false, '2026-09-03 10:00+00'),
  ('delta-sheds',    null,        null,            'Delta Sheds',    false, false, 1000, 1000, 0.06,   'Sales tax',       false, '2026-09-04 10:00+00'),
  ('echo-barns',     null,        null,            null,             true,  false, null, null, null,   'Sales tax',       false, '2026-09-05 10:00+00');
insert into public.tax_code_assignments (client_id, target_type, target_key, tax_code) values
  ('acme-sheds',     'heading', 'doors',    'P0000000'),
  ('acme-sheds',     'heading', 'delivery', 'FR010000'),
  ('acme-sheds',     'style',   '11111111-1111-4111-8111-111111111111', 'P0000000'),
  ('charlie-cabins', 'heading', 'services', 'SI020200'),
  ('foxtrot-sheds',  'heading', 'delivery', 'FR010000');
`;
const WITH_CODES = ["acme-sheds", "charlie-cabins"];

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
  const t = MIG_TEXT();
  const i = t.lastIndexOf("\ncommit;");
  return t.slice(0, i) + "\nrollback;" + t.slice(i + "\ncommit;".length);
};
// The header's ROLLBACK block, exactly as a human would copy it out: the indented statement lines
// under "── ROLLBACK", with the comment marker taken off.
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
const column = async (db) => (await one(db, `select data_type, is_nullable, column_default from information_schema.columns
  where table_schema = 'public' and table_name = 'client_settings' and column_name = 'tax_codes_enabled'`)) || null;
const comment = async (db) => (await one(db, `select col_description('public.client_settings'::regclass,
  (select attnum from pg_attribute where attrelid = 'public.client_settings'::regclass and attname = 'tax_codes_enabled')) as c`)).c;
// Every row, every column but the switch: what "nothing else moved" compares.
const others = async (db) => JSON.stringify((await rows(db, "select * from public.client_settings order by client_id"))
  .map(({ tax_codes_enabled: _s, ...rest }) => rest));
const switchedOn = async (db) => (await rows(db, "select client_id from public.client_settings where tax_codes_enabled order by client_id")).map((r) => r.client_id);
const codes = async (db) => JSON.stringify(await rows(db, "select * from public.tax_code_assignments order by client_id, target_type, target_key"));
const switchOf = async (db, id) => (await one(db, "select tax_codes_enabled from public.client_settings where client_id = $1", [id]) || {}).tax_codes_enabled;

// portal-settings' save_company_tax, as supabase-js sends it: one upsert of exactly the columns the
// save built, `onConflict: "client_id"`. Run as service_role, the role the function holds.
async function upsertAsSave(db, patch) {
  const cols = Object.keys(patch);
  const sql = `insert into public.client_settings (${cols.join(", ")}) values (${cols.map((_c, i) => `$${i + 1}`).join(", ")})
    on conflict (client_id) do update set ${cols.filter((c) => c !== "client_id").map((c) => `${c} = excluded.${c}`).join(", ")}`;
  await db.exec("begin");
  await db.exec("set local role service_role");
  let err = null;
  try { await db.query(sql, cols.map((c) => patch[c])); } catch (e) { err = e.message; }
  await db.exec(err ? "rollback" : "commit");
  return err;
}

// Did the apply fail with `re`, and leave nothing behind?
async function refused(db, sql, re) {
  const before = await others(db);
  const colBefore = JSON.stringify(await column(db));
  const onBefore = colBefore === "null" ? null : JSON.stringify(await switchedOn(db));
  const codesBefore = await codes(db);
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e.message; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  return {
    err, matched: !!err && re.test(err),
    columnKept: JSON.stringify(await column(db)) === colBefore,
    switchesKept: onBefore === null || JSON.stringify(await switchedOn(db)) === onBefore,
    rowsKept: (await others(db)) === before && (await codes(db)) === codesBefore,
  };
}
const kept = (r) => r.matched && r.columnKept && r.switchesKept && r.rowsKept;

const ADD = /add column if not exists tax_codes_enabled boolean not null default false;\n/;
const BACKFILL = /update public\.client_settings cs\n   set tax_codes_enabled = true\n where current_setting\('ss\.m290_first_apply'\)::boolean\n   and exists \(select 1 from public\.tax_code_assignments t where t\.client_id = cs\.client_id\);\n/;

(async () => {
  // ── 1. The first apply on the live shape ────────────────────────────────────────────────────
  console.log("migration 290: the first apply switches on exactly the builders with codes and moves nothing else");
  {
    const db = await fresh();
    const before = await others(db);
    const codesBefore = await codes(db);
    let notices = [];
    try { notices = await apply(db); ok(true, "290 applied cleanly, its own checks and rehearsal included"); }
    catch (e) { ok(false, "290 applied", e.message); }
    ok(notices.some((n) => /290: checks hold; tax_codes_enabled defaults to false; first apply true; 2 row\(s\) on$/.test(n)),
      "its own checks held", notices.join(" | "));
    const rec = notices.record || {};
    ok(JSON.stringify(rec) === JSON.stringify({
      migration: "290", tax_codes_enabled_default: "false", first_apply: "true", rows_total: 5, tenants_with_codes: 3,
      switched_on: 2, codes_without_settings_row: 1, rows_changed: 0, browser_can_read: false, new_row_starts: "false",
    }), "THE RECORD: default false, first apply, three builders with codes, two switched on, one with no settings row, nothing else changed, closed to the browser, a new row starts off", JSON.stringify(rec));
    ok(!Object.values(rec).some((v) => typeof v === "string" && /sheds|barns|cabins/.test(v)), "THE RECORD names no builder (counts only)");

    const col = await column(db);
    ok(col && col.data_type === "boolean" && col.is_nullable === "NO" && col.column_default === "false", "tax_codes_enabled is boolean NOT NULL DEFAULT false", JSON.stringify(col));
    const c = await comment(db);
    ok(/"Use tax codes" switch/.test(c || "") && /keeps every saved code/.test(c || "") && /migration 290 turned it on/.test(c || ""), "the column comment says what the switch is and what 290 did", c);
    ok(JSON.stringify(await switchedOn(db)) === JSON.stringify(WITH_CODES), "exactly the builders with codes and a settings row are on", JSON.stringify(await switchedOn(db)));
    ok((await others(db)) === before, "every other value on every row (mode, rate, label, delivery, numbering, updated_at) is what it was");
    ok((await codes(db)) === codesBefore, "no code moved");
    ok((await one(db, "select count(*)::int n from public.client_settings where client_id = 'foxtrot-sheds'")).n === 0, "no settings row was invented for the builder with codes and no row");
    ok((await one(db, "select count(*)::int n from public.client_settings where client_id = '__m290_rehearsal__'")).n === 0, "the rehearsal row is gone");
    ok((await one(db, "select to_regclass('pg_temp.m290_before') is null as gone")).gone, "the snapshot table went with the commit");

    // ── 2. New rows, neighbouring saves and the switch itself ──
    await db.exec("insert into public.client_settings (client_id) values ('golf-garages')");
    ok((await switchOf(db, "golf-garages")) === false, "a bare new row starts off");
    let err = await upsertAsSave(db, { client_id: "hotel-homes", ss_tax_rate: 0.065, updated_at: "2026-10-09T12:00:00Z" });
    ok(!err && (await switchOf(db, "hotel-homes")) === false, "save_company_tax creating a row with a rate: the switch starts off", err);
    err = await upsertAsSave(db, { client_id: "foxtrot-sheds", ss_tax_rate: 0.07, updated_at: "2026-10-09T12:00:00Z" });
    ok(!err && (await switchOf(db, "foxtrot-sheds")) === false, "the builder with codes and no row: their first save creates it off (their codes stay)", err);
    err = await upsertAsSave(db, { client_id: "acme-sheds", ss_tax_rate: 0.08, ss_tax_label: "State tax", updated_at: "2026-10-09T12:00:00Z" });
    ok(!err && (await switchOf(db, "acme-sheds")) === true, "a rate save that does not name the switch keeps it on (only named columns are set)", err);
    err = await upsertAsSave(db, { client_id: "acme-sheds", tax_codes_enabled: false, updated_at: "2026-10-09T12:00:00Z" });
    ok(!err && (await switchOf(db, "acme-sheds")) === false, "the switch saves off as service_role", err);
    ok((await one(db, "select count(*)::int n from public.tax_code_assignments where client_id = 'acme-sheds'")).n === 3, "and switching off keeps every code");
    err = await upsertAsSave(db, { client_id: "bravo-barns", tax_codes_enabled: true, updated_at: "2026-10-09T12:00:00Z" });
    ok(!err && (await switchOf(db, "bravo-barns")) === true, "a builder with no codes can switch them on");

    // ── 3. Re-apply after builders chose: nobody's switch moves ──
    const now = await others(db);
    const onNow = await switchedOn(db);
    let re = [];
    try { re = await apply(db); ok(true, "a re-apply runs clean"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(JSON.stringify(await switchedOn(db)) === JSON.stringify(onNow), "a re-apply keeps every builder's choice (acme off, bravo on)", JSON.stringify(await switchedOn(db)));
    ok((await others(db)) === now, "and moves nothing else");
    ok(re.record && re.record.first_apply === "false" && re.record.rows_total === 8 && re.record.switched_on === 2
      && re.record.codes_without_settings_row === 0 && re.record.rows_changed === 0,
      "its record says it was not the first apply and counts the rows as they now are", JSON.stringify(re.record));
    await db.close();
  }

  // ── 4. A builder with codes and the backfill on a table with no codes at all ────────────────
  console.log("migration 290: a project with no codes at all switches nobody on");
  {
    const db = await fresh();
    await db.exec("delete from public.tax_code_assignments");
    let rec = null, err = null;
    try { rec = (await apply(db)).record; } catch (e) { err = e.message; }
    ok(!err && rec && rec.switched_on === 0 && rec.tenants_with_codes === 0, "applies, and the record says nobody is on", err || JSON.stringify(rec));
    await db.close();
  }

  // ── 5. A CRLF checkout of the file applies the same ─────────────────────────────────────────
  console.log("migration 290: a Windows (CRLF) checkout applies the same");
  {
    const crlf = await fresh();
    let err = null, rec = null;
    try { rec = (await apply(crlf, MIG_TEXT().replace(/\n/g, "\r\n"))).record; } catch (e) { err = e.message; }
    ok(!err && rec && rec.tax_codes_enabled_default === "false" && rec.switched_on === 2 && rec.rows_changed === 0, "the CRLF copy applies and prints the same record", err || JSON.stringify(rec));
    await crlf.close();
  }

  // ── 6. The dry run: the same record, nothing left behind ────────────────────────────────────
  console.log("migration 290: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const db = await fresh();
    const before = await others(db);
    const dry = DRY_RUN();
    ok((dry.match(/\ncommit;/g) || []).length === 0 && (dry.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = [];
    try { notices = await apply(db, dry); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(notices.record && notices.record.tax_codes_enabled_default === "false" && notices.record.switched_on === 2 && notices.record.new_row_starts === "false",
      "it prints the same record the apply would", JSON.stringify(notices.record));
    ok((await column(db)) === null, "and leaves no column behind");
    ok((await others(db)) === before, "and no row moved");
    await db.close();
  }

  // ── 7. The header's ROLLBACK, as written ────────────────────────────────────────────────────
  console.log("migration 290: the header's ROLLBACK drops the column and the ledger row, and keeps codes");
  {
    const db = await fresh();
    await apply(db);
    const codesBefore = await codes(db);
    const sql = ROLLBACK_SQL();
    ok(/drop column if exists tax_codes_enabled;/.test(sql) && /notify pgrst/.test(sql) && /delete from supabase_migrations\.schema_migrations where version = '290';/.test(sql),
      "the ROLLBACK block has the drop, the reload and the ledger row", sql);
    let err = null;
    try { await db.exec(sql); } catch (e) { err = e.message; }
    ok(!err, "it runs as written", err);
    ok((await column(db)) === null, "the column is gone");
    ok((await one(db, "select count(*)::int n from supabase_migrations.schema_migrations where version = '290'")).n === 0, "the ledger row is gone");
    ok((await codes(db)) === codesBefore, "every code is still there");
    let re = null;
    try { re = (await apply(db)).record; } catch (e) { err = e.message; }
    ok(re && re.first_apply === "true" && re.switched_on === 2, "after a rollback the file applies again as a first apply", err || JSON.stringify(re));
    await db.close();
  }

  // ── 8. Mutants: broken shapes are refused, and nothing is left behind ───────────────────────
  console.log("migration 290: refuses what it cannot prove");
  {
    const mutate = (re, to) => {
      const t = MIG_TEXT();
      const m = t.replace(re, to);
      if (m === t) throw new Error(`mutant not built: ${re}`);
      return m;
    };

    // The default left at true: every new builder would start with the editor open.
    let db = await fresh();
    let r = await refused(db, mutate(ADD, "add column if not exists tax_codes_enabled boolean not null default true;\n"),
      /should be boolean NOT NULL DEFAULT false, is boolean \/ nullable NO \/ default true/);
    ok(kept(r), "a default of true: refused, nothing of 290 left", JSON.stringify(r));
    await db.close();

    // A nullable column.
    db = await fresh();
    r = await refused(db, mutate(ADD, "add column if not exists tax_codes_enabled boolean default false;\n"), /nullable YES/);
    ok(kept(r), "a nullable column: refused", JSON.stringify(r));
    await db.close();

    // The backfill switching everyone on, not just the builders with codes.
    db = await fresh();
    r = await refused(db, mutate(BACKFILL, "update public.client_settings set tax_codes_enabled = true;\n"),
      /3 row\(s\) are switched the wrong way on the first apply/);
    ok(kept(r), "a backfill that switches on builders with no codes: refused", JSON.stringify(r));
    await db.close();

    // The backfill left out: the builders with codes would lose their editor.
    db = await fresh();
    r = await refused(db, mutate(BACKFILL, ""), /2 row\(s\) are switched the wrong way on the first apply/);
    ok(kept(r), "no backfill: refused (a builder with codes would lose the editor)", JSON.stringify(r));
    await db.close();

    // A backfill that runs on every apply: a re-apply would undo a builder's "off".
    db = await fresh();
    await apply(db);
    let err = await upsertAsSave(db, { client_id: "acme-sheds", tax_codes_enabled: false, updated_at: "2026-10-09T12:00:00Z" });
    ok(!err, "(acme switched codes off before the re-apply)", err);
    r = await refused(db, mutate(BACKFILL, "update public.client_settings cs set tax_codes_enabled = true where exists (select 1 from public.tax_code_assignments t where t.client_id = cs.client_id);\n"),
      /a re-apply changed 1 builder\(s\)' tax codes switch/);
    ok(kept(r), "a backfill that ignores the first-apply guard: refused on the re-apply, acme stays off", JSON.stringify(r));
    await db.close();

    // A file that also touches a column it promises to leave: the snapshot covers it.
    db = await fresh();
    r = await refused(db, mutate(BACKFILL, (s) => s + "update public.client_settings set updated_at = now() where tax_codes_enabled;\n"),
      /2 client_settings row\(s\) changed in a column this file does not touch/);
    ok(kept(r), "stamping updated_at on the switched rows: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    r = await refused(db, mutate(BACKFILL, (s) => s + "update public.client_settings set ss_tax_rate = 0 where ss_tax_rate is null;\n"),
      /2 client_settings row\(s\) changed in a column this file does not touch/);
    ok(kept(r), "inventing a rate for the builders with none: refused", JSON.stringify(r));
    await db.close();

    // A trigger that starts new rows on: the rehearsal is the check that sees it.
    db = await fresh();
    await apply(db);
    await db.exec(`create function public.m290_force_on() returns trigger language plpgsql as $$ begin new.tax_codes_enabled := true; return new; end $$;
      create trigger m290_force_on before insert on public.client_settings for each row execute function public.m290_force_on();`);
    r = await refused(db, MIG_TEXT(), /a new client_settings row starts with tax_codes_enabled = true, expected false/);
    ok(kept(r), "a new row that starts on: refused by the rehearsal", JSON.stringify(r));
    await db.close();

    // A row already carrying the rehearsal's name is never touched.
    db = await fresh();
    await db.exec("insert into public.client_settings (client_id) values ('__m290_rehearsal__')");
    r = await refused(db, MIG_TEXT(), /a client_settings row named __m290_rehearsal__ already exists/);
    ok(kept(r), "a row named like the rehearsal: refused, left alone", JSON.stringify(r));
    await db.close();

    // The table open to the browser.
    db = await fresh();
    await db.exec("grant select on public.client_settings to authenticated");
    r = await refused(db, MIG_TEXT(), /authenticated holds SELECT on client_settings\.tax_codes_enabled/);
    ok(kept(r), "client_settings readable by authenticated: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    await db.exec("grant update on public.client_settings to anon");
    r = await refused(db, MIG_TEXT(), /anon holds UPDATE on client_settings\.tax_codes_enabled/);
    ok(kept(r), "client_settings writable by anon: refused", JSON.stringify(r));
    await db.close();

    // service_role unable to write it: the Tax tab's switch would fail for every builder.
    db = await fresh();
    await db.exec("revoke update on public.client_settings from service_role");
    r = await refused(db, MIG_TEXT(), /service_role lacks UPDATE on client_settings\.tax_codes_enabled/);
    ok(kept(r), "service_role without UPDATE: refused", JSON.stringify(r));
    await db.close();

    // RLS off, forced, or a policy added: the table is no longer service-role only.
    db = await fresh();
    await db.exec("alter table public.client_settings disable row level security");
    r = await refused(db, MIG_TEXT(), /RLS is off on client_settings/);
    ok(kept(r), "RLS off: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    await db.exec("alter table public.client_settings force row level security");
    r = await refused(db, MIG_TEXT(), /client_settings has FORCE ROW LEVEL SECURITY on/);
    ok(kept(r), "FORCE row level security: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    await db.exec("create policy open_read on public.client_settings for select using (true)");
    r = await refused(db, MIG_TEXT(), /client_settings has a policy/);
    ok(kept(r), "a policy on client_settings: refused", JSON.stringify(r));
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
