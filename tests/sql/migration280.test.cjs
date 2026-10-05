// Execute migration 280 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// client_settings as it is live, then check what it promises:
//   * invoice_in_ghl stays boolean NOT NULL and its DEFAULT becomes false; the column comment says so;
//   * NO existing row moves: mode, capability, numbering and tax rate are all exactly as they were;
//   * a brand-new row starts in StructureStudio paperwork mode, both when it is inserted bare and when
//     portal-settings' first save creates it (an upsert of named columns);
//   * an EXISTING row keeps its mode through that same upsert, which is why the default change alone
//     moves nobody (INSERT ... ON CONFLICT DO UPDATE sets only the columns it names);
//   * the move itself, as the Quotes & Invoices card saves it, lands for a grandfathered row and for a
//     tenant with no row; the one tenant with the capability can still store true;
//   * THE RECORD, the one row `supabase db query` prints; a dry run (the last commit; swapped for
//     rollback;) prints the same row and leaves nothing; a re-apply and a CRLF checkout are harmless;
//   * the header's ROLLBACK, run as written, puts 121's default and comment back;
//   * broken shapes are refused with the WHOLE file rolled back (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration280.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/280_invoice_in_ghl_default_false.sql"), "utf8");

// 121's comment on the column, lifted from 121 itself so the rollback check compares against the
// real text and not a copy that could drift.
const COMMENT_121 = (() => {
  const src = fs.readFileSync(path.join(WT, "supabase/migrations/121_invoice_in_ghl.sql"), "utf8");
  const m = src.match(/comment on column public\.client_settings\.invoice_in_ghl is\s*\r?\n\s*('(?:[^']|'')*');/);
  if (!m) throw new Error("121's invoice_in_ghl comment moved; re-point COMMENT_121");
  return m[1];
})();

// client_settings as it is live (information_schema, 2026-10-05), cut to the columns 280 and the
// Quotes & Invoices save touch: 121's three, 125's invoice pair, 158's tax trio, 217's capability,
// the CRM credentials and the save's own updated_at. RLS on with no policies, and an ACL of
// postgres + service_role only: granted to everyone first and then revoked, which is how Supabase's
// default privileges and the migrations that closed it left it. No trigger (live has none).
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);
insert into supabase_migrations.schema_migrations (version, name) values ('280', '280_invoice_in_ghl_default_false');

create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(),
  ghl_location_id text, ghl_api_key text, business_name text,
  invoice_in_ghl boolean not null default true,
  ss_quote_next integer, ss_quote_prefix text not null default '',
  ss_invoice_next integer, ss_invoice_prefix text not null default '',
  ss_tax_rate numeric(7,5), ss_tax_label text not null default 'Sales tax', ss_tax_delivery boolean not null default false,
  ghl_invoicing_allowed boolean not null default false,
  constraint client_settings_ss_tax_rate_range check (ss_tax_rate is null or (ss_tax_rate >= 0 and ss_tax_rate <= 0.25))
);
comment on column public.client_settings.invoice_in_ghl is ${COMMENT_121};
alter table public.client_settings enable row level security;
grant all on public.client_settings to anon, authenticated, service_role;
revoke all on public.client_settings from anon, authenticated;
`;

// The live mix (2026-10-05): five rows, four on the CRM path (one with the capability, three
// without: two connected to a CRM or not), one already on StructureStudio paperwork. Live also
// has a tenant with no row at all; foxtrot-sheds plays it below.
const SEED = `
insert into public.client_settings
  (client_id, ghl_location_id, ghl_api_key, business_name, invoice_in_ghl, ghl_invoicing_allowed,
   ss_quote_next, ss_quote_prefix, ss_invoice_next, ss_invoice_prefix, ss_tax_rate, updated_at) values
  ('acme-sheds',     'loc-acme',  'harness-key-a', 'Acme Sheds',     true,  true,  null, '',    null, '',     null,   '2026-09-01 10:00+00'),
  ('bravo-barns',    'loc-bravo', 'harness-key-b', 'Bravo Barns',    true,  false, null, '',    null, '',     null,   '2026-09-02 10:00+00'),
  ('charlie-cabins', null,        null,            'Charlie Cabins', true,  false, null, '',    null, '',     null,   '2026-09-03 10:00+00'),
  ('delta-sheds',    null,        null,            'Delta Sheds',    false, false, 1042, 'DS-', 2007, 'DSI-', 0.0725, '2026-09-04 10:00+00'),
  ('echo-barns',     null,        null,            null,             true,  false, null, '',    null, '',     null,   '2026-09-05 10:00+00');
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
const column = async (db) => (await one(db, `select data_type, is_nullable, column_default from information_schema.columns
  where table_schema = 'public' and table_name = 'client_settings' and column_name = 'invoice_in_ghl'`)) || null;
const comment = async (db) => (await one(db, `select col_description('public.client_settings'::regclass,
  (select attnum from pg_attribute where attrelid = 'public.client_settings'::regclass and attname = 'invoice_in_ghl')) as c`)).c;
const all = async (db) => rows(db, "select * from public.client_settings order by client_id");
const modeOf = async (db, id) => (await one(db, "select invoice_in_ghl from public.client_settings where client_id = $1", [id]) || {}).invoice_in_ghl;

// portal-settings' `save`, as supabase-js sends it: one upsert of exactly the columns the save
// built, `onConflict: "client_id"`. Run as service_role, the role the function holds.
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
// The Quotes & Invoices card's save for a tenant WITHOUT the capability, after portal-settings has
// done its part: invoice_in_ghl forced to false (217), the tax rate turned from a percent into a
// fraction, prefixes and label trimmed, plus the save's own client_id and updated_at.
const quotesAndInvoicesSave = (clientId, { quoteNext, invoiceNext, taxPct }) => ({
  client_id: clientId, invoice_in_ghl: false,
  ss_quote_next: quoteNext, ss_quote_prefix: "Q-", ss_invoice_next: invoiceNext, ss_invoice_prefix: "INV-",
  ss_tax_rate: Math.round((taxPct / 100) * 100000) / 100000, ss_tax_label: "Sales tax", ss_tax_delivery: false,
  updated_at: "2026-10-06T12:00:00Z",
});

// Did the apply fail with `re`, and leave nothing behind?
async function refused(db, sql, re) {
  const before = JSON.stringify(await all(db));
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e.message; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  const col = await column(db);
  return {
    err, matched: !!err && re.test(err),
    defaultKept: !!col && col.column_default === "true",
    rowsKept: JSON.stringify(await all(db)) === before,
  };
}

const STATEMENT = /alter column invoice_in_ghl set default false;\r?\n/;

(async () => {
  // ── 1. The apply on the live shape ──────────────────────────────────────────────────────────
  console.log("migration 280: applies on the live shape; the default moves and no row does");
  {
    const db = await fresh();
    const before = await all(db);
    let notices = [];
    try { notices = await apply(db); ok(true, "280 applied cleanly, its own checks and rehearsal included"); }
    catch (e) { ok(false, "280 applied", e.message); }
    ok(notices.some((n) => /280: checks hold; invoice_in_ghl defaults to false; 5 existing row\(s\) unchanged$/.test(n)),
      "its own checks held", notices.join(" | "));
    const rec = notices.record || {};
    ok(JSON.stringify(rec) === JSON.stringify({
      migration: "280", invoice_in_ghl_default: "false", rows_checked: 5, rows_changed: "(none)",
      crm_invoicing: 4, grandfathered: 3, new_row_starts: "false",
    }), "THE RECORD, the row the CLI prints: default false, five rows unchanged, four on the CRM path, three grandfathered, a new row starts false", JSON.stringify(rec));

    const col = await column(db);
    ok(col && col.data_type === "boolean" && col.is_nullable === "NO" && col.column_default === "false", "invoice_in_ghl is boolean NOT NULL DEFAULT false", JSON.stringify(col));
    ok(JSON.stringify(await all(db)) === JSON.stringify(before), "every client_settings value on every row is what it was");
    const c = await comment(db);
    ok(/false \(the default since migration 280\) =\s+StructureStudio/.test(c || "") && /ghl_invoicing_allowed \(217\)/.test(c || "") && /anything but false is the CRM/.test(c || ""),
      "the column comment says what the default is now, and how it is read", c);
    ok((await one(db, "select count(*)::int n from public.client_settings where client_id = '__m280_rehearsal__'")).n === 0, "the rehearsal row is gone");
    ok((await one(db, "select to_regclass('pg_temp.m280_before') is null as gone")).gone, "the snapshot table went with the commit");

    // ── 2. New rows start in paperwork mode ──
    await db.exec("insert into public.client_settings (client_id) values ('golf-garages')");
    const bare = await one(db, "select invoice_in_ghl, ghl_invoicing_allowed, ss_quote_next, ss_invoice_next, ss_tax_rate from public.client_settings where client_id = 'golf-garages'");
    ok(bare.invoice_in_ghl === false && bare.ghl_invoicing_allowed === false && bare.ss_quote_next === null && bare.ss_invoice_next === null && bare.ss_tax_rate === null,
      "a bare new row: paperwork mode, no capability, and NO numbering invented", JSON.stringify(bare));
    // A Business Details save from a tenant with no row yet: the upsert creates the row.
    let err = await upsertAsSave(db, { client_id: "foxtrot-sheds", business_name: "Foxtrot Sheds", updated_at: "2026-10-06T12:00:00Z" });
    ok(!err && (await modeOf(db, "foxtrot-sheds")) === false, "a first save that creates the row (Business Details) leaves it in paperwork mode", err);

    // ── 3. Existing rows keep their mode through the same save ──
    for (const id of ["acme-sheds", "bravo-barns", "charlie-cabins", "echo-barns"]) {
      err = await upsertAsSave(db, { client_id: id, business_name: "Renamed", updated_at: "2026-10-06T12:00:00Z" });
      ok(!err && (await modeOf(db, id)) === true, `${id}: a neighbouring save keeps invoice_in_ghl = true (only named columns are set)`, err);
    }
    err = await upsertAsSave(db, { client_id: "delta-sheds", business_name: "Renamed", updated_at: "2026-10-06T12:00:00Z" });
    const delta = await one(db, "select invoice_in_ghl, ss_quote_next, ss_invoice_next, ss_tax_rate::text as r from public.client_settings where client_id = 'delta-sheds'");
    ok(!err && delta.invoice_in_ghl === false && delta.ss_quote_next === 1042 && delta.ss_invoice_next === 2007 && delta.r === "0.07250",
      "the paperwork tenant keeps its numbering and rate", JSON.stringify(delta));

    // ── 4. The move itself, as the Quotes & Invoices card saves it ──
    err = await upsertAsSave(db, quotesAndInvoicesSave("bravo-barns", { quoteNext: 3101, invoiceNext: 7001, taxPct: 6.5 }));
    const bravo = await one(db, "select invoice_in_ghl, ss_quote_next, ss_invoice_next, ss_tax_rate::text as r, ghl_location_id, ghl_api_key, ghl_invoicing_allowed from public.client_settings where client_id = 'bravo-barns'");
    ok(!err && bravo.invoice_in_ghl === false && bravo.ss_quote_next === 3101 && bravo.ss_invoice_next === 7001 && bravo.r === "0.06500",
      "a grandfathered CRM-connected tenant moves to paperwork with its own numbers and rate", JSON.stringify(bravo));
    ok(bravo.ghl_location_id === "loc-bravo" && bravo.ghl_api_key === "harness-key-b" && bravo.ghl_invoicing_allowed === false,
      "and keeps its CRM connection (contacts and opportunities still flow)", JSON.stringify(bravo));
    err = await upsertAsSave(db, quotesAndInvoicesSave("hotel-homes", { quoteNext: 1, invoiceNext: 1, taxPct: 0 }));
    const hotel = await one(db, "select invoice_in_ghl, ss_quote_next, ss_invoice_next, ss_tax_rate::text as r from public.client_settings where client_id = 'hotel-homes'");
    ok(!err && hotel && hotel.invoice_in_ghl === false && hotel.ss_quote_next === 1 && hotel.ss_invoice_next === 1 && hotel.r === "0.00000",
      "a tenant with no row: the save creates it, in paperwork mode, and 0% tax is stored as an answer", JSON.stringify(hotel));
    err = await upsertAsSave(db, { client_id: "acme-sheds", invoice_in_ghl: true, updated_at: "2026-10-06T12:00:00Z" });
    ok(!err && (await modeOf(db, "acme-sheds")) === true, "the tenant WITH the capability can still store true", err);

    // ── 5. Re-apply: harmless, and it counts the rows as they now stand ──
    const now = await all(db);
    let re = [];
    try { re = await apply(db); ok(true, "a re-apply runs clean"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(JSON.stringify(await all(db)) === JSON.stringify(now), "and moves no row");
    ok(re.record && re.record.rows_checked === 8 && re.record.rows_changed === "(none)" && re.record.crm_invoicing === 3 && re.record.grandfathered === 2 && re.record.new_row_starts === "false",
      "its record counts the rows as they now are", JSON.stringify(re.record));
    await db.close();
  }

  // ── 6. A CRLF checkout of the file applies the same ─────────────────────────────────────────
  console.log("migration 280: a Windows (CRLF) checkout applies the same");
  {
    const crlf = await fresh();
    let err = null, rec = null;
    try { rec = (await apply(crlf, MIG_TEXT().replace(/\r?\n/g, "\r\n"))).record; } catch (e) { err = e.message; }
    ok(!err && rec && rec.invoice_in_ghl_default === "false" && rec.rows_changed === "(none)", "the CRLF copy applies and prints the same record", err || JSON.stringify(rec));
    await crlf.close();
  }

  // ── 7. The dry run: the same record, nothing left behind ────────────────────────────────────
  console.log("migration 280: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const db = await fresh();
    const before = await all(db);
    const dry = DRY_RUN();
    ok((dry.match(/\ncommit;/g) || []).length === 0 && (dry.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = [];
    try { notices = await apply(db, dry); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(notices.record && notices.record.invoice_in_ghl_default === "false" && notices.record.rows_checked === 5 && notices.record.new_row_starts === "false",
      "it prints the same record the apply would", JSON.stringify(notices.record));
    const col = await column(db);
    ok(col.column_default === "true" && (await comment(db)) === COMMENT_121.slice(1, -1).replace(/''/g, "'"), "and leaves 121's default and comment in place", JSON.stringify(col));
    ok(JSON.stringify(await all(db)) === JSON.stringify(before), "and no row moved");
    await db.close();
  }

  // ── 8. The header's ROLLBACK, as written ────────────────────────────────────────────────────
  console.log("migration 280: the header's ROLLBACK puts 121's default and comment back");
  {
    const db = await fresh();
    await apply(db);
    await db.exec("insert into public.client_settings (client_id) values ('india-sheds')");
    const sql = ROLLBACK_SQL();
    ok(/set default true;/.test(sql) && /comment on column/.test(sql) && /delete from supabase_migrations\.schema_migrations where version = '280';/.test(sql),
      "the ROLLBACK block has the default, the comment and the ledger row", sql);
    let err = null;
    try { await db.exec(sql); } catch (e) { err = e.message; }
    ok(!err, "it runs as written", err);
    const col = await column(db);
    ok(col.column_default === "true", "the default is true again", JSON.stringify(col));
    ok((await comment(db)) === COMMENT_121.slice(1, -1).replace(/''/g, "'"), "the comment is 121's again", await comment(db));
    ok((await one(db, "select count(*)::int n from supabase_migrations.schema_migrations where version = '280'")).n === 0, "the ledger row is gone");
    ok((await modeOf(db, "india-sheds")) === false, "a row created while 280 was live keeps false (no numbering yet; its save is still the way forward)");
    await db.close();
  }

  // ── 9. Mutants: broken shapes are refused, and nothing is left behind ───────────────────────
  console.log("migration 280: refuses what it cannot prove");
  {
    // The default left at true: the one thing the file is for.
    let db = await fresh();
    const stayTrue = MIG_TEXT().replace(STATEMENT, "alter column invoice_in_ghl set default true;\n");
    ok(stayTrue !== MIG_TEXT(), "(mutant built: default true)");
    let r = await refused(db, stayTrue, /should be boolean NOT NULL DEFAULT false, is boolean \/ nullable NO \/ default true/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a default left at true: refused, nothing of 280 left", JSON.stringify(r));
    await db.close();

    // A read-time move snuck in as a data change: every grandfathered row flipped by the file.
    db = await fresh();
    const flipAll = MIG_TEXT().replace(STATEMENT, (s) => s + "update public.client_settings set invoice_in_ghl = false where not ghl_invoicing_allowed;\n");
    ok(flipAll !== MIG_TEXT(), "(mutant built: an UPDATE that moves the grandfathered rows)");
    r = await refused(db, flipAll, /these client_settings rows changed during the apply: bravo-barns, charlie-cabins, echo-barns$/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a file that flips rows: refused, naming them, nothing moved", JSON.stringify(r));
    await db.close();

    // Numbering invented for the grandfathered rows: the snapshot covers it too.
    db = await fresh();
    const invent = MIG_TEXT().replace(STATEMENT, (s) => s + "update public.client_settings set ss_quote_next = 1 where ss_quote_next is null;\n");
    r = await refused(db, invent, /rows changed during the apply: acme-sheds, bravo-barns, charlie-cabins, echo-barns$/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a file that invents a starting number: refused", JSON.stringify(r));
    await db.close();

    // Something between a fresh insert and the default (a trigger, say) keeps new rows on the CRM
    // path: the rehearsal is the check that sees it.
    db = await fresh();
    await db.exec(`create function public.m280_force_crm() returns trigger language plpgsql as $$ begin new.invoice_in_ghl := true; return new; end $$;
      create trigger m280_force_crm before insert on public.client_settings for each row execute function public.m280_force_crm();`);
    r = await refused(db, MIG_TEXT(), /a new client_settings row starts with invoice_in_ghl = true, expected false/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a new row that still starts on the CRM path: refused by the rehearsal", JSON.stringify(r));
    await db.close();

    // A row already carrying the rehearsal's name is never touched.
    db = await fresh();
    await db.exec("insert into public.client_settings (client_id) values ('__m280_rehearsal__')");
    r = await refused(db, MIG_TEXT(), /a client_settings row named __m280_rehearsal__ already exists/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a row named like the rehearsal: refused, left alone", JSON.stringify(r));
    await db.close();

    // A nullable column: "anything but false" would then include NULL, which no reader should meet.
    db = await fresh();
    await db.exec("alter table public.client_settings alter column invoice_in_ghl drop not null");
    r = await refused(db, MIG_TEXT(), /should be boolean NOT NULL DEFAULT false, is boolean \/ nullable YES/);
    ok(r.matched && r.rowsKept, "a nullable invoice_in_ghl: refused", JSON.stringify(r));
    await db.close();

    // The table open to the browser.
    db = await fresh();
    await db.exec("grant select on public.client_settings to authenticated");
    r = await refused(db, MIG_TEXT(), /authenticated holds SELECT on client_settings\.invoice_in_ghl/);
    ok(r.matched && r.defaultKept && r.rowsKept, "client_settings readable by authenticated: refused", JSON.stringify(r));
    await db.close();

    // service_role unable to write it: the Quotes & Invoices save would fail for every builder.
    db = await fresh();
    await db.exec("revoke update on public.client_settings from service_role");
    r = await refused(db, MIG_TEXT(), /service_role lacks UPDATE on client_settings\.invoice_in_ghl/);
    ok(r.matched && r.defaultKept && r.rowsKept, "service_role without UPDATE: refused", JSON.stringify(r));
    await db.close();

    // RLS switched off, or a policy added: the table is no longer service-role only.
    db = await fresh();
    await db.exec("alter table public.client_settings disable row level security");
    r = await refused(db, MIG_TEXT(), /RLS is off on client_settings/);
    ok(r.matched && r.defaultKept && r.rowsKept, "RLS off: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    await db.exec("create policy open_read on public.client_settings for select using (true)");
    r = await refused(db, MIG_TEXT(), /client_settings has a policy/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a policy on client_settings: refused", JSON.stringify(r));
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
