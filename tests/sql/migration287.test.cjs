// Execute migration 287 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// client_settings' recording columns as 263 left them (and as they are live), then check what it
// promises:
//   * phone_record_calls stays boolean NOT NULL and its DEFAULT becomes true; both column comments
//     say what the default and the standard sentence are now;
//   * every row no owner has ever saved (phone_recording_updated_at NULL) is turned on, and its
//     updated_at / updated_by stay NULL; a row an owner saved keeps its choice, off or on; no other
//     recording column moves on any row;
//   * a brand-new row starts on, both inserted bare and created by a named-column upsert (a
//     Business Details save); an existing row keeps its value through that same upsert;
//   * the owner's own save (phone_recording_save) still turns it off, and a re-apply never turns an
//     owner's off back on;
//   * THE RECORD, the one row `supabase db query` prints; a dry run (the last commit; swapped for
//     rollback;) prints the same row and leaves nothing; a re-apply and a CRLF checkout are harmless;
//   * the header's ROLLBACK, run as written, puts 263's default and comments back and turns off
//     only the rows no owner chose;
//   * broken shapes are refused with the WHOLE file rolled back (mutants).
// Nothing here touches the live project: no network, no Supabase, no call recorded.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration287.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/287_phone_record_calls_default_on.sql"), "utf8");

// 263's comments on the two columns 287 re-words, lifted from 263 itself so the stub and the
// rollback check compare against the real text and not a copy that could drift.
const SRC_263 = fs.readFileSync(path.join(WT, "supabase/migrations/263_phone_call_recording.sql"), "utf8");
const comment263 = (col) => {
  const m = SRC_263.match(new RegExp(`comment on column public\\.client_settings\\.${col} is\\s*\\r?\\n\\s*('(?:[^']|'')*');`));
  if (!m) throw new Error(`263's ${col} comment moved; re-point comment263()`);
  return m[1];
};
const C263_ON = comment263("phone_record_calls");
const C263_TEXT = comment263("phone_recording_notice_text");
const unq = (lit) => lit.slice(1, -1).replace(/''/g, "'");

// client_settings as it is live (information_schema, 2026-10-07), cut to the columns 287 and the
// saves that touch them use: 263's seven recording columns with their defaults and both CHECKs,
// plus the business name, phone_status and the save's own updated_at. RLS on with no policies,
// and an ACL of postgres + service_role only: granted to everyone first and then revoked, which is
// how Supabase's default privileges and the migrations that closed it left it. No trigger (live
// has none).
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);
insert into supabase_migrations.schema_migrations (version, name) values ('287', '287_phone_record_calls_default_on');

create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(),
  business_name text, phone_status text not null default 'off',
  phone_record_calls             boolean not null default false,
  phone_recording_notice         boolean not null default true,
  phone_recording_notice_text    text,
  phone_transcribe_calls         boolean not null default true,
  phone_recording_retention_days integer not null default 365,
  phone_recording_updated_at     timestamptz,
  phone_recording_updated_by     uuid,
  constraint client_settings_phone_recording_notice_text_chk
    check (phone_recording_notice_text is null or char_length(btrim(phone_recording_notice_text)) between 10 and 300),
  constraint client_settings_phone_recording_retention_chk
    check (phone_recording_retention_days in (30, 90, 180, 365, 730))
);
comment on column public.client_settings.phone_record_calls is ${C263_ON};
comment on column public.client_settings.phone_recording_notice_text is ${C263_TEXT};
alter table public.client_settings enable row level security;
grant all on public.client_settings to anon, authenticated, service_role;
revoke all on public.client_settings from anon, authenticated;
`;

// The live mix (2026-10-07): five rows, one with calling on, every one recording-off, none ever
// saved by an owner, all at 365 days with the standard wording.
const LIVE_SEED = `
insert into public.client_settings (client_id, business_name, phone_status, updated_at) values
  ('acme-sheds',     'Acme Sheds',     'on',  '2026-09-01 10:00+00'),
  ('bravo-barns',    'Bravo Barns',    'off', '2026-09-02 10:00+00'),
  ('charlie-cabins', 'Charlie Cabins', 'off', '2026-09-03 10:00+00'),
  ('delta-sheds',    'Delta Sheds',    'off', '2026-09-04 10:00+00'),
  ('echo-barns',     null,             'off', '2026-09-05 10:00+00');
`;
// What the days after 263 could have produced, and what an owner's save leaves: an owner who
// chose OFF (stamped), an owner who chose ON (stamped), and an unsaved row carrying its own
// wording, transcripts off and 90 days (written some other way), so "only the switch moved" is
// tested against values that are not the defaults.
const OWNER = "00000000-0000-4000-8000-0000000000aa";
const MIXED_SEED = `
insert into public.client_settings (client_id, business_name, phone_status, phone_record_calls, phone_recording_notice_text,
    phone_transcribe_calls, phone_recording_retention_days, phone_recording_updated_at, phone_recording_updated_by) values
  ('acme-sheds',     'Acme Sheds',     'on',  false, null,                                   true,  365, null,                   null),
  ('bravo-barns',    'Bravo Barns',    'on',  false, null,                                   true,  365, '2026-10-05 12:00+00', '${OWNER}'),
  ('charlie-cabins', 'Charlie Cabins', 'on',  true,  'Calls are recorded for training.',     false, 180, '2026-10-05 13:00+00', '${OWNER}'),
  ('delta-sheds',    'Delta Sheds',    'off', false, 'We record calls to serve you better.', false, 90,  null,                   null),
  ('echo-barns',     null,             'off', false, null,                                   true,  365, null,                   null);
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

async function fresh(seed = LIVE_SEED) {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(seed);
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
// The header's ROLLBACK block, exactly as a human would copy it out: after "── ROLLBACK" and its
// warning, the run of indented statement lines, with the comment marker taken off.
const ROLLBACK_SQL = () => {
  const lines = MIG_TEXT().replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^-- ── ROLLBACK/.test(l));
  if (start < 0) throw new Error("the ROLLBACK heading moved");
  const rest = lines.slice(start + 1);
  const first = rest.findIndex((l) => /^--   /.test(l));
  if (first < 0) throw new Error("the ROLLBACK block has no statements");
  const out = [];
  for (const l of rest.slice(first)) {
    if (!/^--   /.test(l)) break;
    out.push(l.replace(/^--   /, ""));
  }
  return out.join("\n");
};
const column = async (db) => (await one(db, `select data_type, is_nullable, column_default from information_schema.columns
  where table_schema = 'public' and table_name = 'client_settings' and column_name = 'phone_record_calls'`)) || null;
const commentOf = async (db, col) => (await one(db, `select col_description('public.client_settings'::regclass,
  (select attnum from pg_attribute where attrelid = 'public.client_settings'::regclass and attname = $1)) as c`, [col])).c;
const all = async (db) => rows(db, "select * from public.client_settings order by client_id");
const onOf = async (db, id) => (await one(db, "select phone_record_calls from public.client_settings where client_id = $1", [id]) || {}).phone_record_calls;
const OTHER = ["phone_recording_notice", "phone_recording_notice_text", "phone_transcribe_calls", "phone_recording_retention_days",
  "phone_recording_updated_at", "phone_recording_updated_by", "business_name", "phone_status", "updated_at"];
const pick = (r, keys) => Object.fromEntries(keys.map((k) => [k, r[k] instanceof Date ? r[k].toISOString() : r[k]]));

// A save as supabase-js sends it, run as service_role (the role every edge function holds):
//   upsert  one INSERT ... ON CONFLICT (client_id) DO UPDATE of exactly the named columns (the
//           Business Details save, or anything else that creates the row);
//   update  phone_recording_save: UPDATE ... WHERE client_id of parseRecording's five columns
//           plus who and when (portal-settings index.ts).
async function asService(db, sql, params) {
  await db.exec("begin");
  await db.exec("set local role service_role");
  let err = null;
  try { await db.query(sql, params); } catch (e) { err = e.message; }
  await db.exec(err ? "rollback" : "commit");
  return err;
}
async function upsertAsSave(db, patch) {
  const cols = Object.keys(patch);
  return asService(db, `insert into public.client_settings (${cols.join(", ")}) values (${cols.map((_c, i) => `$${i + 1}`).join(", ")})
    on conflict (client_id) do update set ${cols.filter((c) => c !== "client_id").map((c) => `${c} = excluded.${c}`).join(", ")}`,
  cols.map((c) => patch[c]));
}
const ownerSave = (db, clientId, on) => asService(db, `update public.client_settings set phone_record_calls = $2, phone_recording_notice = true,
    phone_recording_notice_text = null, phone_transcribe_calls = true, phone_recording_retention_days = 365,
    phone_recording_updated_at = '2026-10-08T12:00:00Z', phone_recording_updated_by = $3 where client_id = $1`, [clientId, on, OWNER]);

// Did the apply fail with `re`, and leave nothing behind?
async function refused(db, sql, re) {
  const before = JSON.stringify(await all(db));
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e.message; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  const col = await column(db);
  return {
    err, matched: !!err && re.test(err),
    defaultKept: !!col && col.column_default === "false",
    rowsKept: JSON.stringify(await all(db)) === before,
  };
}

const STATEMENT = /alter column phone_record_calls set default true;\r?\n/;
const BACKFILL = /   and phone_recording_updated_at is null;\r?\n/;

(async () => {
  // ── 1. The apply on the live shape ──────────────────────────────────────────────────────────
  console.log("migration 287: applies on the live shape; the default moves and every unsaved row turns on");
  {
    const db = await fresh();
    const before = await all(db);
    let notices = [];
    try { notices = await apply(db); ok(true, "287 applied cleanly, its own checks and rehearsal included"); }
    catch (e) { ok(false, "287 applied", e.message); }
    ok(notices.some((n) => /287: checks hold; phone_record_calls defaults to true; 5 row\(s\) turned on, 0 owner choice\(s\) kept$/.test(n)),
      "its own checks held", notices.join(" | "));
    const rec = notices.record || {};
    ok(JSON.stringify(rec) === JSON.stringify({
      migration: "287", phone_record_calls_default: "true", rows_total: 5, rows_on: 5, rows_turned_on: 5,
      owner_choices_kept: 0, new_row_starts: "true",
    }), "THE RECORD, the row the CLI prints, is the header's expected row: default true, 5 of 5 on, 5 turned on, no owner choice", JSON.stringify(rec));

    const col = await column(db);
    ok(col && col.data_type === "boolean" && col.is_nullable === "NO" && col.column_default === "true", "phone_record_calls is boolean NOT NULL DEFAULT true", JSON.stringify(col));
    const now = await all(db);
    ok(now.every((r) => r.phone_record_calls === true), "every row is on");
    ok(JSON.stringify(now.map((r) => pick(r, OTHER))) === JSON.stringify(before.map((r) => pick(r, OTHER))),
      "and nothing else moved: wording, transcripts, retention, who-and-when (still NULL), name, calling, updated_at");
    const c = await commentOf(db, "phone_record_calls");
    ok(/Default TRUE since migration 287 \(Carolyn,\s+2026-10-06/.test(c || "") && /never an owner's choice: on by the platform\s+default/.test(c || "")
      && /CALL_RECORDING = "on"/.test(c || "") && /recording_armed/.test(c || ""),
    "the switch's comment says the default, what NULL updated_at means, and that the rail and the arm still decide", c);
    const t = await commentOf(db, "phone_recording_notice_text");
    ok(/"This call may be recorded\." \(or "This call\s+may be recorded and transcribed\."/.test(t || "") && /10 to 300 characters/.test(t || ""),
      "the wording's comment names the new standard sentence", t);
    ok((await one(db, "select count(*)::int n from public.client_settings where client_id = '__m287_rehearsal__'")).n === 0, "the rehearsal row is gone");
    ok((await one(db, "select to_regclass('pg_temp.m287_before') is null as gone")).gone, "the snapshot table went with the commit");

    // ── 2. New rows start on ──
    await db.exec("insert into public.client_settings (client_id) values ('golf-garages')");
    const bare = await one(db, `select phone_record_calls, phone_recording_notice, phone_transcribe_calls, phone_recording_retention_days,
      phone_recording_updated_at, phone_recording_updated_by from public.client_settings where client_id = 'golf-garages'`);
    ok(bare.phone_record_calls === true && bare.phone_recording_notice === true && bare.phone_recording_retention_days === 365
      && bare.phone_recording_updated_at === null && bare.phone_recording_updated_by === null,
    "a bare new row: recording on, the announcement on, a year, and never an owner's choice", JSON.stringify(bare));
    let err = await upsertAsSave(db, { client_id: "foxtrot-sheds", business_name: "Foxtrot Sheds", updated_at: "2026-10-08T12:00:00Z" });
    ok(!err && (await onOf(db, "foxtrot-sheds")) === true, "a first save that creates the row (Business Details) starts it on", err);

    // ── 3. The owner's off is a stamped choice: it holds through other saves and a re-apply ──
    err = await ownerSave(db, "bravo-barns", false);
    ok(!err && (await onOf(db, "bravo-barns")) === false, "the owner's own save still turns it off", err);
    err = await upsertAsSave(db, { client_id: "bravo-barns", business_name: "Renamed", updated_at: "2026-10-08T13:00:00Z" });
    ok(!err && (await onOf(db, "bravo-barns")) === false, "a neighbouring named-column save keeps the owner's off", err);
    err = await upsertAsSave(db, { client_id: "acme-sheds", business_name: "Renamed", updated_at: "2026-10-08T13:00:00Z" });
    ok(!err && (await onOf(db, "acme-sheds")) === true, "and keeps an unsaved row's on", err);

    // ── 4. Re-apply: harmless, and it never overrides an owner ──
    const settled = await all(db);
    let re = [];
    try { re = await apply(db); ok(true, "a re-apply runs clean"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(JSON.stringify(await all(db)) === JSON.stringify(settled), "and moves no row: the owner's off stays off");
    ok(re.record && re.record.rows_total === 7 && re.record.rows_on === 6 && re.record.rows_turned_on === 0 && re.record.owner_choices_kept === 1
      && re.record.new_row_starts === "true", "its record counts the rows as they now are", JSON.stringify(re.record));
    await db.close();
  }

  // ── 5. Owners' choices, and rows that are not at the defaults ───────────────────────────────
  console.log("migration 287: an owner's saved choice is never overwritten, and only the switch moves");
  {
    const db = await fresh(MIXED_SEED);
    const before = await all(db);
    let notices = [];
    try { notices = await apply(db); } catch (e) { ok(false, "287 applied on the mixed rows", e.message); }
    ok(notices.record && notices.record.rows_total === 5 && notices.record.rows_on === 4 && notices.record.rows_turned_on === 3
      && notices.record.owner_choices_kept === 2, "the record: 3 unsaved rows turned on, 2 owner choices kept", JSON.stringify(notices.record));
    ok((await onOf(db, "bravo-barns")) === false, "an owner who chose OFF stays off");
    ok((await onOf(db, "charlie-cabins")) === true, "an owner who chose ON stays on");
    for (const id of ["acme-sheds", "delta-sheds", "echo-barns"]) ok((await onOf(db, id)) === true, `${id}: never saved by an owner, turned on`);
    const after = await all(db);
    ok(JSON.stringify(after.map((r) => pick(r, OTHER))) === JSON.stringify(before.map((r) => pick(r, OTHER))),
      "own wording, transcripts off, 90 and 180 days, and every who-and-when are exactly as they were");
    const delta = after.find((r) => r.client_id === "delta-sheds");
    ok(delta.phone_recording_updated_at === null && delta.phone_recording_updated_by === null, "a row turned on by the platform default is not stamped as an owner's choice");
    await db.close();
  }

  // ── 6. A CRLF checkout of the file applies the same ─────────────────────────────────────────
  console.log("migration 287: a Windows (CRLF) checkout applies the same");
  {
    const crlf = await fresh();
    let err = null, rec = null;
    try { rec = (await apply(crlf, MIG_TEXT().replace(/\r?\n/g, "\r\n"))).record; } catch (e) { err = e.message; }
    ok(!err && rec && rec.phone_record_calls_default === "true" && rec.rows_on === 5 && rec.rows_turned_on === 5,
      "the CRLF copy applies and prints the same record", err || JSON.stringify(rec));
    await crlf.close();
  }

  // ── 7. The dry run: the same record, nothing left behind ────────────────────────────────────
  console.log("migration 287: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const db = await fresh();
    const before = await all(db);
    const dry = DRY_RUN();
    ok((dry.match(/\ncommit;/g) || []).length === 0 && (dry.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = [];
    try { notices = await apply(db, dry); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(notices.record && notices.record.phone_record_calls_default === "true" && notices.record.rows_on === 5 && notices.record.rows_turned_on === 5
      && notices.record.new_row_starts === "true", "it prints the same record the apply would", JSON.stringify(notices.record));
    const col = await column(db);
    ok(col.column_default === "false" && (await commentOf(db, "phone_record_calls")) === unq(C263_ON)
      && (await commentOf(db, "phone_recording_notice_text")) === unq(C263_TEXT), "and leaves 263's default and comments in place", JSON.stringify(col));
    ok(JSON.stringify(await all(db)) === JSON.stringify(before), "and no row moved");
    await db.close();
  }

  // ── 8. The header's ROLLBACK, as written ────────────────────────────────────────────────────
  console.log("migration 287: the header's ROLLBACK puts 263's default and comments back, and only unsaved rows off");
  {
    const db = await fresh(MIXED_SEED);
    await apply(db);
    await db.exec("insert into public.client_settings (client_id) values ('india-sheds')");
    await ownerSave(db, "echo-barns", true);   // an owner who chose ON while 287 was live
    const sql = ROLLBACK_SQL();
    ok(/set default false;/.test(sql) && /phone_recording_updated_at is null;/.test(sql) && (sql.match(/comment on column/g) || []).length === 2
      && /delete from supabase_migrations\.schema_migrations where version = '287';/.test(sql),
    "the ROLLBACK block has the default, the unsaved rows, both comments and the ledger row", sql);
    let err = null;
    try { await db.exec(sql); } catch (e) { err = e.message; }
    ok(!err, "it runs as written", err);
    ok((await column(db)).column_default === "false", "the default is false again");
    ok((await commentOf(db, "phone_record_calls")) === unq(C263_ON) && (await commentOf(db, "phone_recording_notice_text")) === unq(C263_TEXT),
      "both comments are 263's again");
    ok((await one(db, "select count(*)::int n from supabase_migrations.schema_migrations where version = '287'")).n === 0, "the ledger row is gone");
    for (const id of ["acme-sheds", "delta-sheds", "india-sheds"]) ok((await onOf(db, id)) === false, `${id}: never an owner's choice, off again`);
    ok((await onOf(db, "charlie-cabins")) === true && (await onOf(db, "echo-barns")) === true, "owners who chose ON keep it (before 287 and while it was live)");
    ok((await onOf(db, "bravo-barns")) === false, "the owner who chose OFF is still off");
    await db.close();
  }

  // ── 9. Mutants: broken shapes are refused, and nothing is left behind ───────────────────────
  console.log("migration 287: refuses what it cannot prove");
  {
    // The default left at false: the one thing new builders need.
    let db = await fresh();
    const stayFalse = MIG_TEXT().replace(STATEMENT, "alter column phone_record_calls set default false;\n");
    ok(stayFalse !== MIG_TEXT(), "(mutant built: default false)");
    let r = await refused(db, stayFalse, /should be boolean NOT NULL DEFAULT true, is boolean \/ nullable NO \/ default false/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a default left at false: refused, nothing of 287 left", JSON.stringify(r));
    await db.close();

    // A backfill that overrides owners: every off row turned on, stamped or not.
    db = await fresh(MIXED_SEED);
    const overrideOwners = MIG_TEXT().replace(BACKFILL, ";\n");
    ok(overrideOwners !== MIG_TEXT(), "(mutant built: a backfill without the owner guard)");
    r = await refused(db, overrideOwners, /changed in a way this file does not promise: bravo-barns$/);
    ok(r.matched && r.defaultKept && r.rowsKept, "turning on an owner's saved off: refused, naming the row", JSON.stringify(r));
    await db.close();

    // No backfill at all: the businesses there today stay off.
    db = await fresh();
    const noBackfill = MIG_TEXT().replace(/update public\.client_settings\r?\n   set phone_record_calls = true\r?\n[^;]*;\r?\n/, "");
    ok(noBackfill !== MIG_TEXT(), "(mutant built: no backfill)");
    r = await refused(db, noBackfill, /still off with no owner's choice behind it: acme-sheds, bravo-barns, charlie-cabins, delta-sheds, echo-barns$/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a default with no backfill: refused, naming every row left off", JSON.stringify(r));
    await db.close();

    // A backfill that stamps itself as the owner's choice: NULL must keep meaning "never chosen".
    db = await fresh();
    const stamped = MIG_TEXT().replace(/   set phone_record_calls = true\r?\n/, "   set phone_record_calls = true, phone_recording_updated_at = now()\n");
    ok(stamped !== MIG_TEXT(), "(mutant built: a backfill that stamps updated_at)");
    r = await refused(db, stamped, /changed in a way this file does not promise: acme-sheds, bravo-barns, charlie-cabins, delta-sheds, echo-barns$/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a backfill that poses as an owner's choice: refused", JSON.stringify(r));
    await db.close();

    // Retention moved by the file (one year is Carolyn's answer, as voicemail).
    db = await fresh();
    const shorter = MIG_TEXT().replace(STATEMENT, (s) => s + "alter table public.client_settings alter column phone_recording_retention_days set default 90;\n");
    r = await refused(db, shorter, /phone_recording_retention_days no longer defaults to 365/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a retention default other than a year: refused", JSON.stringify(r));
    await db.close();

    // Retention's CHECK gone, or the announcement no longer on by default.
    db = await fresh();
    await db.exec("alter table public.client_settings drop constraint client_settings_phone_recording_retention_chk");
    r = await refused(db, MIG_TEXT(), /client_settings_phone_recording_retention_chk is missing/);
    ok(r.matched && r.defaultKept && r.rowsKept, "retention's CHECK missing: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    await db.exec("alter table public.client_settings alter column phone_recording_notice set default false");
    r = await refused(db, MIG_TEXT(), /phone_recording_notice no longer defaults to true/);
    ok(r.matched && r.defaultKept && r.rowsKept, "the announcement not on by default: refused", JSON.stringify(r));
    await db.close();

    // Something between a fresh insert and the default (a trigger, say) keeps new rows off: the
    // rehearsal is the check that sees it.
    db = await fresh();
    await db.exec(`create function public.m287_force_off() returns trigger language plpgsql as $$ begin new.phone_record_calls := false; return new; end $$;
      create trigger m287_force_off before insert on public.client_settings for each row execute function public.m287_force_off();`);
    r = await refused(db, MIG_TEXT(), /a new client_settings row starts with phone_record_calls = false/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a new row that still starts off: refused by the rehearsal", JSON.stringify(r));
    await db.close();

    // A row already carrying the rehearsal's name is never touched.
    db = await fresh();
    await db.exec("insert into public.client_settings (client_id, phone_recording_updated_at) values ('__m287_rehearsal__', now())");
    r = await refused(db, MIG_TEXT(), /a client_settings row named __m287_rehearsal__ already exists/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a row named like the rehearsal: refused, left alone", JSON.stringify(r));
    await db.close();

    // A nullable column: the Worker and the RPCs read it as a plain boolean.
    db = await fresh();
    await db.exec("alter table public.client_settings alter column phone_record_calls drop not null");
    r = await refused(db, MIG_TEXT(), /should be boolean NOT NULL DEFAULT true, is boolean \/ nullable YES/);
    ok(r.matched && r.rowsKept, "a nullable phone_record_calls: refused", JSON.stringify(r));
    await db.close();

    // A browser role able to see or change who records (263 PART 8's rule, per column).
    db = await fresh();
    await db.exec("grant select (phone_recording_updated_by) on public.client_settings to authenticated");
    r = await refused(db, MIG_TEXT(), /authenticated holds SELECT on client_settings\.phone_recording_updated_by/);
    ok(r.matched && r.defaultKept && r.rowsKept, "a column grant to authenticated: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    await db.exec("grant update on public.client_settings to anon");
    r = await refused(db, MIG_TEXT(), /anon holds UPDATE on client_settings\.phone_record_calls/);
    ok(r.matched && r.defaultKept && r.rowsKept, "client_settings writable by anon: refused", JSON.stringify(r));
    await db.close();

    // service_role unable to write it: the owner's save would fail.
    db = await fresh();
    await db.exec("revoke update on public.client_settings from service_role");
    r = await refused(db, MIG_TEXT(), /service_role lacks UPDATE on client_settings\.phone_record_calls/);
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
