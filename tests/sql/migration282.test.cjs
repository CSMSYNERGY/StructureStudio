// Execute migration 282 for real in PGlite (Postgres compiled to WASM, in memory) on top of the CRM
// contact tables as they are live, with the resolver lifted from 191 itself, then drive
// crm_import_ghl_contacts the way portal-settings calls it (service role, one page per call, each
// call its own transaction) and check what the file promises:
//   * crm_contacts.source accepts 'ghl_import' and still every value it took before;
//   * a DRY RUN answers the real path's counts and leaves every row exactly as it was;
//   * the real run creates contacts with source 'ghl_import', matches existing ones through the
//     resolver (phone first, then email; enrich, never blank; a different email on a known phone
//     becomes a second person), adds tags to labels and moves first_seen_at back, never forward;
//   * an existing contact keeps its source, another tenant is never touched, a re-run creates
//     nothing, two rows for one person in a page count once as new;
//   * the contract's duplicate check: no two live contacts share a phone key or an email, even when
//     GoHighLevel holds one person as email-only, phone-only and both (on separate pages or one);
//   * GoHighLevel's do-not-disturb becomes the phone's opt-out (sms_opt_outs, reason 'import') and
//     the contact's sms_opt_out_at when it is the contact's own phone; a dry run keeps none of it;
//   * a name goes onto a second person the resolver records, never onto the contact it conflicts with;
//   * only a unique_violation is absorbed per row; any other fault fails the page with nothing kept;
//   * the function is service-role only;
//   * THE RECORD the CLI prints; a dry run of the file; CRLF; a re-apply; the header's ROLLBACK;
//   * broken shapes are refused with the WHOLE file rolled back (mutants).
// Nothing here touches the live project: no network, no Supabase, no GoHighLevel.
//
// Tenants, people, numbers and addresses are made up (555-01xx numbers, .invalid / example
// domains). The repo is public: no real client id or customer belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration282.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
// LF, whatever the checkout: the mutants below splice LF-only text, and on a CRLF checkout
// (core.autocrlf) they would not find their anchors. The CRLF check builds its own copy.
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/282_crm_ghl_import.sql"), "utf8").replace(/\r/g, "");

// The resolver, lifted from 191 itself (its body is the live one: pg_get_functiondef compared on
// 2026-10-06), so the test runs the matching rules the import really goes through and not a copy.
const RESOLVER_191 = (() => {
  const src = fs.readFileSync(path.join(WT, "supabase/migrations/191_crm_ensure_contact_second_channel.sql"), "utf8").replace(/\r\n/g, "\n");
  const m = src.match(/\nbegin;\n([\s\S]*?)\ncommit;/);
  if (!m || !/create or replace function public\.crm_ensure_contact\(/.test(m[1])) throw new Error("191's resolver block moved; re-point RESOLVER_191");
  return m[1];
})();

// The live shapes (information_schema / pg_constraint / pg_indexes / pg_get_functiondef,
// 2026-10-06): crm_contacts with 254's five-value source check and 130's two partial uniques,
// crm_contact_people (190) with its stamp trigger, crm_phone_key (132). No trigger on crm_contacts
// (live has none). Default privileges as live, so the function's revokes are tested against the
// trap they exist for.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);
insert into supabase_migrations.schema_migrations (version, name) values ('282', '282_crm_ghl_import');

create or replace function public.crm_phone_key(p_phone text)
 returns text language sql immutable set search_path to ''
as $function$
  select nullif(
    case
      when length(d) = 11 and left(d, 1) = '1' then right(d, 10)
      else d
    end, '')
  from (select regexp_replace(coalesce(p_phone, ''), '\\D', '', 'g') as d) s;
$function$;

create table public.crm_contacts (
  id uuid primary key default gen_random_uuid(), client_id text not null, name text, phone text,
  phone_digits text, email text, email_lower text generated always as (lower(btrim(email))) stored,
  street text, city text, state text, zip text, owner_user_id uuid, labels text[] not null default '{}',
  merged_into uuid references public.crm_contacts(id), source text not null default 'design',
  first_seen_at timestamptz not null default now(), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), sms_opt_out_at timestamptz,
  billing_street text, billing_city text, billing_state text, billing_zip text,
  constraint crm_contacts_source_check check (source = any (array['design', 'captured_lead', 'manual', 'import', 'phone']))
);
create unique index crm_contacts_tenant_phone on public.crm_contacts (client_id, phone_digits)
  where phone_digits is not null and phone_digits <> '' and merged_into is null;
create unique index crm_contacts_tenant_email on public.crm_contacts (client_id, email_lower)
  where (phone_digits is null or phone_digits = '') and email_lower is not null and email_lower <> '' and merged_into is null;
create index crm_contacts_client_recent on public.crm_contacts (client_id, updated_at desc);
alter table public.crm_contacts enable row level security;
revoke all on public.crm_contacts from anon, authenticated;
grant select on public.crm_contacts to authenticated;

create table public.crm_contact_people (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  ordinal integer not null default 1, name text, phone text, phone_digits text, email text,
  email_lower text generated always as (lower(btrim(email))) stored, is_primary boolean not null default false,
  source text not null default 'design', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint crm_contact_people_source_check check (source = any (array['design', 'captured_lead', 'manual', 'import', 'merge'])),
  constraint crm_contact_people_identity check ((coalesce(btrim(name), '') <> '') or (coalesce(btrim(phone), '') <> '') or (coalesce(btrim(email), '') <> ''))
);
create unique index crm_contact_people_phone_uniq on public.crm_contact_people (contact_id, phone_digits) where phone_digits is not null and phone_digits <> '';
create unique index crm_contact_people_email_uniq on public.crm_contact_people (contact_id, email_lower) where email_lower is not null and email_lower <> '';
create unique index crm_contact_people_primary_uniq on public.crm_contact_people (contact_id) where is_primary;
create index crm_contact_people_tenant_phone_idx on public.crm_contact_people (client_id, phone_digits) where phone_digits is not null and phone_digits <> '';
create index crm_contact_people_tenant_email_idx on public.crm_contact_people (client_id, email_lower) where email_lower is not null and email_lower <> '';
create or replace function public.crm_contact_people_stamp() returns trigger language plpgsql security definer set search_path to ''
as $function$
begin
  new.phone_digits := public.crm_phone_key(new.phone);
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end $function$;
create trigger crm_contact_people_stamp before insert or update on public.crm_contact_people
  for each row execute function public.crm_contact_people_stamp();

-- 164's opt-out table, as live (information_schema / pg_constraint 2026-10-06: no check on reason,
-- no trigger), service-role only.
create table public.sms_opt_outs (
  client_id text not null, phone_digits text not null, reason text not null,
  effective_at timestamptz not null default now(), requested_at timestamptz not null default now(),
  note text, created_at timestamptz not null default now(),
  primary key (client_id, phone_digits)
);
alter table public.sms_opt_outs enable row level security;
revoke all on public.sms_opt_outs from anon, authenticated;
`;

// Two tenants. acme-sheds is the one importing: a design contact with a phone and no email, a
// captured lead known by email only, a phone-call contact with labels, a merged-away tombstone. The
// other tenant holds the same phone and email, and must never be touched.
const SEED = `
insert into public.crm_contacts (id, client_id, name, phone, phone_digits, email, labels, source, first_seen_at, created_at, updated_at) values
  ('00000000-0000-4000-8000-000000000001', 'acme-sheds',  'Pat Example',  '(555) 010-0101', '5550100101', null,                     '{}',            'design',        '2026-05-01 10:00+00', '2026-05-01 10:00+00', '2026-05-01 10:00+00'),
  ('00000000-0000-4000-8000-000000000002', 'acme-sheds',  null,           null,             null,         'robin@example.invalid', '{}',            'captured_lead', '2026-06-01 10:00+00', '2026-06-01 10:00+00', '2026-06-01 10:00+00'),
  ('00000000-0000-4000-8000-000000000003', 'acme-sheds',  'Sam Caller',   '+15550100303',   '5550100303', null,                     '{vip,Warm}',    'phone',         '2026-07-01 10:00+00', '2026-07-01 10:00+00', '2026-07-01 10:00+00'),
  ('00000000-0000-4000-8000-000000000009', 'bravo-barns', 'Pat Elsewhere','(555) 010-0101', '5550100101', 'robin@example.invalid', '{}',            'design',        '2026-05-02 10:00+00', '2026-05-02 10:00+00', '2026-05-02 10:00+00');
insert into public.crm_contacts (id, client_id, name, phone, phone_digits, source, merged_into, created_at, updated_at) values
  ('00000000-0000-4000-8000-000000000004', 'acme-sheds', 'Old Duplicate', '555-010-0404', '5550100404', 'design', '00000000-0000-4000-8000-000000000001', '2026-04-01 10:00+00', '2026-04-01 10:00+00');
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
// jsonb hands its keys back in its own order (shortest first), so compare objects key by key.
const canon = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

async function fresh() {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(RESOLVER_191);
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
  const t = MIG_TEXT().replace(/\r\n/g, "\n");
  const i = t.lastIndexOf("\ncommit;");
  return t.slice(0, i) + "\nrollback;" + t.slice(i + "\ncommit;".length);
};
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

const REHEARSAL = "dry run: 1 new, 1 opted out, kept 0; real: 2 new, 1 matched, 1 no identity, 2 labelled, 1 opted out; "
  + "re-run: 0 new, 0 opted out; shared email: 1 left with its contact";

const contacts = async (db) => rows(db, `select id, client_id, name, phone, phone_digits, email, labels, source, merged_into,
  first_seen_at, created_at, updated_at from public.crm_contacts order by client_id, id`);
const optOuts = async (db) => rows(db, "select client_id, phone_digits, reason, note from public.sms_opt_outs order by client_id, phone_digits");
const dupEmails = async (db) => rows(db, `select client_id, email_lower from public.crm_contacts where merged_into is null and coalesce(email_lower, '') <> ''
  group by 1, 2 having count(*) > 1`);
const people = async (db) => rows(db, "select client_id, contact_id, name, phone, phone_digits, email, source from public.crm_contact_people order by created_at, id");
const sourceCheck = async (db) => (await one(db, `select pg_get_constraintdef(c.oid) as d from pg_constraint c
  where c.conrelid = 'public.crm_contacts'::regclass and c.conname = 'crm_contacts_source_check'`) || {}).d || null;
const fnExists = async (db) => (await one(db, "select to_regprocedure('public.crm_import_ghl_contacts(text, jsonb, boolean)') is not null as e")).e;

// One page, the way portal-settings sends it: service role, its own transaction (autocommit).
async function importPage(db, clientId, pageRows, dryRun) {
  await db.exec("begin");
  await db.exec("set local role service_role");
  let out = null, err = null;
  try {
    const args = dryRun === undefined
      ? [clientId, JSON.stringify(pageRows)]
      : [clientId, JSON.stringify(pageRows), dryRun];
    const sql = dryRun === undefined
      ? "select public.crm_import_ghl_contacts($1, $2::jsonb) as r"
      : "select public.crm_import_ghl_contacts($1, $2::jsonb, $3) as r";
    out = (await one(db, sql, args)).r;
  } catch (e) { err = e; }
  await db.exec(err ? "rollback" : "commit");
  if (err) throw err;
  return out;
}

// GoHighLevel's page as portal-settings hands it over (ghlContactImport.ts parseGhlContact): name,
// phone, email, tags, added_at, sms_dnd. Every key optional.
const PAGE = [
  // 1. Pat, known by phone (written differently), now with an email: matched, enriched.
  { name: "Pat Example", phone: "+1 555-010-0101", email: "pat@example.invalid", tags: ["customer", "2025 show"], added_at: "2024-03-04T05:06:07Z" },
  // 2. Robin, known by email only, now with a phone: matched by email, the phone is added.
  { name: "Robin Lead", phone: "+15550100202", email: "ROBIN@example.invalid", tags: ["lead"] },
  // 3. Sam, a phone-call contact, under another name in GoHighLevel: matched, NOT renamed; labels
  //    union keeps vip and Warm.
  //    Its do-not-disturb is the STRING "true", which is not GoHighLevel's flag: no opt-out.
  { name: "Samantha Renamed", phone: "555.010.0303", tags: ["vip", "newsletter"], sms_dnd: "true" },
  // 4. A brand-new person, marked do-not-disturb in GoHighLevel: the phone's opt-out.
  { name: "Lee New", phone: "+1 (555) 010-0505", email: "lee@example.invalid", tags: ["lead"], added_at: "2025-01-02T00:00:00Z", sms_dnd: true },
  // 5. The same new person again in the same page (GoHighLevel holds duplicates).
  { name: "Lee New", phone: "5550100505", tags: ["lead", "repeat"] },
  // 6. Email only, new. Do-not-disturb with no phone to keep it on: nothing to record.
  { email: "kim@example.invalid", added_at: "not a date", sms_dnd: true },
  // 7. Nothing to match on.
  { name: "Nameless Browser", tags: ["x"] },
  // 8. Not even an object.
  "garbage",
  // 9. The merged-away tombstone's number: the resolver ignores merged rows, so this is new.
  { name: "Tombstone Number", phone: "555-010-0404", added_at: "2999-01-01T00:00:00Z" },
];

(async () => {
  // ── 1. The apply on the live shape ──────────────────────────────────────────────────────────
  console.log("migration 282: applies on the live shape; the source value is added and no contact moves");
  {
    const db = await fresh();
    const before = await contacts(db);
    let notices = [];
    try { notices = await apply(db); ok(true, "282 applied cleanly, its own checks and rehearsal included"); }
    catch (e) { ok(false, "282 applied", e.message); }
    ok(notices.some((n) => /282: checks hold; 5 existing contact\(s\) unchanged$/.test(n)), "its own checks held", notices.join(" | "));
    const rec = notices.record || {};
    ok(JSON.stringify(rec) === JSON.stringify({
      migration: "282", source_check_has_ghl_import: true, function_ready: true, contacts_checked: 5, contacts_changed: 0,
      by_source: "captured_lead 1, design 3, phone 1", ghl_import_rows: 0,
      rehearsal: REHEARSAL,
    }), "THE RECORD, the row the CLI prints", JSON.stringify(rec));
    ok(JSON.stringify(await contacts(db)) === JSON.stringify(before), "every contact is exactly as it was");
    ok((await rows(db, "select 1 from public.crm_contacts where client_id = '__m282_rehearsal__'")).length === 0, "the rehearsal left nothing");
    const def = await sourceCheck(db);
    for (const v of ["design", "captured_lead", "manual", "import", "phone", "ghl_import"]) {
      ok(def && def.includes(`'${v}'`), `the source check accepts '${v}'`, def);
    }
    let err = null;
    try { await db.exec("insert into public.crm_contacts (client_id, phone_digits, source) values ('acme-sheds', '5550109999', 'gohighlevel')"); } catch (e) { err = e.message; }
    ok(err && /crm_contacts_source_check/.test(err), "and still refuses a value it does not list", err);

    // ── 2. Who may call it ──
    for (const role of ["anon", "authenticated"]) {
      let denied = null;
      await db.exec("begin");
      await db.exec(`set local role ${role}`);
      try { await db.query("select public.crm_import_ghl_contacts('acme-sheds', '[]'::jsonb, true)"); } catch (e) { denied = e.message; }
      await db.exec("rollback");
      ok(denied && /permission denied/.test(denied), `${role} cannot execute it`, denied);
    }
    const priv = await one(db, `select p.prosecdef, p.proconfig from pg_proc p where p.oid = 'public.crm_import_ghl_contacts(text, jsonb, boolean)'::regprocedure`);
    ok(priv.prosecdef === true && JSON.stringify(priv.proconfig) === JSON.stringify(['search_path=""']), "SECURITY DEFINER with an empty search_path", JSON.stringify(priv));

    // ── 3. The dry run: the real path's counts, nothing kept ──
    const beforeDry = JSON.stringify(await contacts(db));
    const beforePeople = JSON.stringify(await people(db));
    const dry = await importPage(db, "acme-sheds", PAGE);
    ok(canon(dry) === canon({ dry_run: true, rows: 9, created: 3, matched: 4, no_identity: 2, conflicts: 0, labelled: 5, opted_out: 1, split: 0 }),
      "no dry_run argument means a dry run, and it answers the real path's counts", JSON.stringify(dry));
    ok(JSON.stringify(await contacts(db)) === beforeDry && JSON.stringify(await people(db)) === beforePeople, "and leaves every contact and person exactly as it was");
    ok((await optOuts(db)).length === 0, "and records no opt-out", JSON.stringify(await optOuts(db)));
    const dryNull = await importPage(db, "acme-sheds", PAGE, null);
    ok(dryNull.dry_run === true && dryNull.created === 3 && JSON.stringify(await contacts(db)) === beforeDry, "a NULL dry_run is a dry run too", JSON.stringify(dryNull));
    const dryText = JSON.stringify(dry);
    ok(!/Pat|Robin|Lee|example\.invalid|555/.test(dryText), "the answer carries numbers only", dryText);

    // ── 4. The real run ──
    const real = await importPage(db, "acme-sheds", PAGE, false);
    ok(canon(real) === canon({ dry_run: false, rows: 9, created: 3, matched: 4, no_identity: 2, conflicts: 0, labelled: 5, opted_out: 1, split: 0 }),
      "the real run: 3 new (Lee, Kim, the tombstone's number), 4 matched (Pat, Robin, Sam, Lee again), 2 with nothing to match", JSON.stringify(real));
    const byId = async (id) => one(db, "select * from public.crm_contacts where id = $1", [id]);
    const pat = await byId("00000000-0000-4000-8000-000000000001");
    ok(pat.source === "design" && pat.email === "pat@example.invalid" && pat.phone_digits === "5550100101" && pat.name === "Pat Example",
      "Pat: keeps source design, the number and the name, gains the email", JSON.stringify(pat));
    ok(pat.phone === "+1 555-010-0101", "Pat: the same number may be rewritten as GoHighLevel writes it (the resolver's rule, as a design does)", pat.phone);
    ok(JSON.stringify([...pat.labels].sort()) === JSON.stringify(["2025 show", "customer"]), "Pat: GoHighLevel's tags became labels", JSON.stringify(pat.labels));
    ok(new Date(pat.first_seen_at).toISOString() === "2024-03-04T05:06:07.000Z", "Pat: GoHighLevel knew them first, so first_seen_at moved back", String(pat.first_seen_at));
    const robin = await byId("00000000-0000-4000-8000-000000000002");
    ok(robin.source === "captured_lead" && robin.phone_digits === "5550100202" && robin.name === "Robin Lead" && robin.email_lower === "robin@example.invalid",
      "Robin: matched by email (any case), keeps source and the address, gains the phone and fills the blank name", JSON.stringify(robin));
    const sam = await byId("00000000-0000-4000-8000-000000000003");
    ok(sam.source === "phone" && JSON.stringify([...sam.labels].sort()) === JSON.stringify(["Warm", "newsletter", "vip"].sort()),
      "Sam: keeps source phone; labels are a union (vip and Warm kept, newsletter added once)", JSON.stringify(sam));
    ok(sam.name === "Sam Caller", "Sam: GoHighLevel's other name does not rename the contact (a name only fills a blank)", sam.name);
    ok(new Date(sam.first_seen_at).toISOString() === "2026-07-01T10:00:00.000Z", "Sam: no date added, first_seen_at untouched");
    const lee = await one(db, "select * from public.crm_contacts where client_id = 'acme-sheds' and phone_digits = '5550100505'");
    ok(lee && lee.source === "ghl_import" && lee.name === "Lee New" && lee.email === "lee@example.invalid",
      "Lee: one new contact, source ghl_import, with the name and email", JSON.stringify(lee));
    ok(lee && JSON.stringify([...lee.labels].sort()) === JSON.stringify(["lead", "repeat"]), "Lee: both rows' tags, once each", JSON.stringify(lee && lee.labels));
    ok(lee && new Date(lee.first_seen_at).toISOString() === "2025-01-02T00:00:00.000Z", "Lee: first_seen_at is GoHighLevel's date added");
    ok(JSON.stringify(await optOuts(db)) === JSON.stringify([{ client_id: "acme-sheds", phone_digits: "5550100505", reason: "import", note: "GoHighLevel do-not-disturb" }]),
      "do-not-disturb: Lee's phone is opted out (reason import); Sam's string \"true\" and Kim's phoneless row record nothing", JSON.stringify(await optOuts(db)));
    const optedAt = await rows(db, "select phone_digits from public.crm_contacts where sms_opt_out_at is not null order by 1");
    ok(JSON.stringify(optedAt) === JSON.stringify([{ phone_digits: "5550100505" }]), "and only Lee's contact carries sms_opt_out_at", JSON.stringify(optedAt));
    const kim = await one(db, "select * from public.crm_contacts where client_id = 'acme-sheds' and email_lower = 'kim@example.invalid'");
    ok(kim && kim.source === "ghl_import" && kim.phone_digits === null, "Kim: email-only and new", JSON.stringify(kim));
    ok(kim && Math.abs(new Date(kim.first_seen_at) - new Date(kim.created_at)) < 1000, "Kim: an unreadable date added is ignored");
    const tomb = await one(db, "select * from public.crm_contacts where client_id = 'acme-sheds' and phone_digits = '5550100404' and merged_into is null");
    ok(tomb && tomb.source === "ghl_import", "a merged-away contact's number makes a new live contact, as a design would", JSON.stringify(tomb));
    ok(tomb && new Date(tomb.first_seen_at) <= new Date(), "a date added in the future never moves first_seen_at forward");
    const old = await byId("00000000-0000-4000-8000-000000000004");
    ok(old.merged_into === "00000000-0000-4000-8000-000000000001" && old.source === "design", "the tombstone itself is untouched");
    const bravo = await rows(db, "select * from public.crm_contacts where client_id = 'bravo-barns'");
    ok(bravo.length === 1 && bravo[0].email === "robin@example.invalid" && bravo[0].name === "Pat Elsewhere" && JSON.stringify(bravo[0].labels) === "[]",
      "the other tenant holding the same phone and email is never touched", JSON.stringify(bravo));
    ok((await rows(db, "select 1 from public.crm_contacts where name = 'Nameless Browser'")).length === 0, "no contact is invented for a row with no phone and no email");
    ok((await one(db, "select count(*)::int n from public.crm_contacts where client_id = 'acme-sheds'")).n === 7, "acme-sheds has 7 rows: 4 before + 3 new");

    // ── 5. The contract's verification queries ──
    const bySource = await rows(db, "select source, count(*)::int n from public.crm_contacts where client_id = 'acme-sheds' and merged_into is null group by 1 order by 1");
    ok(JSON.stringify(bySource) === JSON.stringify([
      { source: "captured_lead", n: 1 }, { source: "design", n: 1 }, { source: "ghl_import", n: 3 }, { source: "phone", n: 1 },
    ]), "counts by source", JSON.stringify(bySource));
    const dupPhone = await rows(db, `select client_id, phone_digits from public.crm_contacts where merged_into is null and coalesce(phone_digits, '') <> ''
      group by 1, 2 having count(*) > 1`);
    const dupEmail = await dupEmails(db);
    ok(dupPhone.length === 0 && dupEmail.length === 0, "the duplicate check: no two live contacts on one tenant share a phone key or an email",
      JSON.stringify({ dupPhone, dupEmail }));

    // ── 6. A re-run creates nothing and moves nothing but the resolver's own updated_at ──
    const settled = await contacts(db);
    const again = await importPage(db, "acme-sheds", PAGE, false);
    ok(again.created === 0 && again.matched === 7 && again.no_identity === 2 && again.labelled === 0 && again.opted_out === 0,
      "the same page again: nothing new, nothing relabelled, no opt-out counted twice", JSON.stringify(again));
    ok((await optOuts(db)).length === 1, "and still the one opt-out");
    const strip = (r) => r.map(({ updated_at: _u, ...rest }) => rest);
    ok(JSON.stringify(strip(await contacts(db))) === JSON.stringify(strip(settled)),
      "every contact's identity, name, labels, source and dates are as they were (only updated_at, which the resolver bumps on every match)");

    // ── 7. A second channel becomes a second person, through the resolver ──
    const second = await importPage(db, "acme-sheds", [{ name: "Pat Partner", phone: "5550100101", email: "partner@example.invalid" }], false);
    ok(second.created === 0 && second.matched === 1, "a different email on a known phone is a match", JSON.stringify(second));
    const pp = await people(db);
    ok(pp.length === 1 && pp[0].contact_id === "00000000-0000-4000-8000-000000000001" && pp[0].email === "partner@example.invalid" && pp[0].name === "Pat Partner",
      "and lands as a second person on Pat's record, as 191 does for a design", JSON.stringify(pp));
    ok((await byId("00000000-0000-4000-8000-000000000001")).email === "pat@example.invalid", "Pat's own email is not overwritten");
    const other = await importPage(db, "acme-sheds", [{ name: "Pat Other Phone", phone: "555-010-0909", email: "pat@example.invalid", sms_dnd: true }], false);
    ok(other.matched === 1 && other.opted_out === 1 && other.split === 0, "do-not-disturb on a second person's phone is counted", JSON.stringify(other));
    ok((await optOuts(db)).some((o) => o.phone_digits === "5550100909" && o.reason === "import"), "that phone is opted out");
    ok((await byId("00000000-0000-4000-8000-000000000001")).sms_opt_out_at === null, "Pat's own number is not blocked by the second person's");
    ok((await byId("00000000-0000-4000-8000-000000000001")).name === "Pat Example", "and Pat is not renamed after the second person");

    // ── 8. Shapes it refuses ──
    for (const [label, args, re] of [
      ["no tenant", ["", "[]"], /no tenant/],
      ["an object instead of an array", ["acme-sheds", "{}"], /must be a JSON array/],
      ["501 rows", ["acme-sheds", JSON.stringify(Array.from({ length: 501 }, () => ({})))], /at most 500 rows per call, got 501/],
    ]) {
      let e = null;
      try { await one(db, "select public.crm_import_ghl_contacts($1, $2::jsonb, false)", args); } catch (x) { e = x.message; }
      ok(e && re.test(e), `refused: ${label}`, e);
    }
    const tagged = await importPage(db, "acme-sheds", [{ phone: "5550100606", tags: ["  spaced  ", "", 7, null, { a: 1 }, "x".repeat(80), ...Array.from({ length: 40 }, (_v, i) => `t${i}`)] }], false);
    const t = await one(db, "select labels from public.crm_contacts where client_id = 'acme-sheds' and phone_digits = '5550100606'");
    ok(tagged.created === 1 && t.labels.length === 25 && t.labels.includes("spaced") && t.labels.includes("x".repeat(60)) && !t.labels.includes(""),
      "tags: strings only, trimmed, blanks dropped, cut to 60 characters, at most 25", JSON.stringify(t.labels));
    await db.close();
  }

  // ── 8b. One person three times in GoHighLevel: the email stays with the contact that had it ──
  console.log("migration 282: an email another live contact holds is never copied onto the phone's contact");
  for (const order of ["three pages", "one page"]) {
    const db = await fresh();
    await apply(db);
    const trio = [
      { name: "Dana Email", email: "dana@example.invalid" },
      { name: "Dana Phone", phone: "(555) 010-0707" },
      { name: "Dana Both", phone: "+15550100707", email: "DANA@example.invalid" },
    ];
    let split = 0;
    if (order === "three pages") {
      for (const r of trio) split += (await importPage(db, "acme-sheds", [r], false)).split;
    } else {
      const r = await importPage(db, "acme-sheds", trio, false);
      ok(r.created === 2 && r.matched === 1 && r.split === 1, `${order}: two new, the third matched by its phone alone`, JSON.stringify(r));
      split = r.split;
    }
    ok(split === 1, `${order}: counted once as split`, String(split));
    ok((await dupEmails(db)).length === 0, `${order}: the duplicate check stays empty`, JSON.stringify(await dupEmails(db)));
    const byPhone = await one(db, "select * from public.crm_contacts where client_id = 'acme-sheds' and phone_digits = '5550100707'");
    const byEmail = await one(db, "select * from public.crm_contacts where client_id = 'acme-sheds' and email_lower = 'dana@example.invalid'");
    ok(byPhone && byPhone.email_lower === null && byPhone.name === "Dana Phone", `${order}: the phone's contact keeps no email and its own name`, JSON.stringify(byPhone));
    ok(byEmail && byEmail.phone_digits === null && byEmail.name === "Dana Email" && byEmail.email === "dana@example.invalid",
      `${order}: the email's contact is unchanged`, JSON.stringify(byEmail));
    await db.close();
  }
  {
    // A dry run of the one-page order: the same answer, nothing kept (each page of a dry run is rolled
    // back, so only rows on one page can see each other).
    const db = await fresh();
    await apply(db);
    const beforeDry = JSON.stringify(await contacts(db));
    const dry = await importPage(db, "acme-sheds", [
      { email: "dana@example.invalid" }, { phone: "(555) 010-0707" }, { phone: "+15550100707", email: "dana@example.invalid" },
    ], true);
    ok(dry.split === 1 && dry.created === 2 && JSON.stringify(await contacts(db)) === beforeDry, "a dry run counts the split and keeps nothing", JSON.stringify(dry));
    await db.close();
  }

  // ── 8c. A conflict's name goes on the second person, not the contact ────────────────────────
  console.log("migration 282: a second person's name never lands on the contact it conflicts with");
  {
    const db = await fresh();
    await apply(db);
    await db.exec(`insert into public.crm_contacts (id, client_id, name, phone, phone_digits, email, source) values
      ('00000000-0000-4000-8000-000000000021', 'acme-sheds', null, '555-010-0121', '5550100121', 'shared@example.invalid', 'design')`);
    const r = await importPage(db, "acme-sheds", [{ name: "Jane Roe", phone: "555-010-0122", email: "shared@example.invalid" }], false);
    ok(r.created === 0 && r.matched === 1, "matched by the email", JSON.stringify(r));
    const a = await one(db, "select * from public.crm_contacts where id = '00000000-0000-4000-8000-000000000021'");
    ok(a.name === null && a.phone_digits === "5550100121", "the nameless contact is not named after the second person", JSON.stringify(a));
    const pp = await people(db);
    ok(pp.length === 1 && pp[0].phone_digits === "5550100122" && pp[0].name === "Jane Roe", "the second person carries the name", JSON.stringify(pp));
    // Without a conflict, a blank is still filled.
    const fill = await importPage(db, "acme-sheds", [{ name: "Owner Name", phone: "+1 555 010 0121" }], false);
    ok(fill.matched === 1 && (await one(db, "select name from public.crm_contacts where id = '00000000-0000-4000-8000-000000000021'")).name === "Owner Name",
      "the contact's own phone fills its blank name", JSON.stringify(fill));
    await db.close();
  }

  // ── 9. One fault fails the page; only a unique_violation is absorbed per row ────────────────
  console.log("migration 282: a racing number costs one row; any other fault fails the page and keeps nothing");
  {
    const db = await fresh();
    await apply(db);
    // A stand-in for the race the indexes catch (two writers creating one number at once): one
    // number raises unique_violation from inside the resolver's insert, two others a check_violation.
    await db.exec(`create function public.m282_fault() returns trigger language plpgsql as $$
      begin
        if new.phone_digits = '5550100702' then raise exception 'race' using errcode = 'unique_violation'; end if;
        if new.phone_digits in ('5550100802', '5550100803') then raise exception 'broken' using errcode = 'check_violation'; end if;
        return new;
      end $$;
      create trigger m282_fault before insert on public.crm_contacts for each row execute function public.m282_fault();`);
    const raced = await importPage(db, "acme-sheds", [
      { name: "Before", phone: "5550100701" }, { name: "Racer", phone: "5550100702" }, { name: "After", phone: "5550100703" },
    ], false);
    ok(raced.created === 2 && raced.conflicts === 1, "a unique_violation is counted as a conflict and the page carries on", JSON.stringify(raced));
    ok((await rows(db, "select name from public.crm_contacts where phone_digits in ('5550100701', '5550100702', '5550100703') order by 1")).map((r) => r.name).join(",") === "After,Before",
      "the rows around it are kept, the racing one is not");
    const before = JSON.stringify(await contacts(db));
    let err = null;
    try { await importPage(db, "acme-sheds", [{ name: "Fine", phone: "5550100801" }, { name: "Broken", phone: "5550100802" }], false); } catch (e) { err = e.message; }
    ok(err && /broken/.test(err), "a check_violation is not absorbed: the page fails", err);
    ok(JSON.stringify(await contacts(db)) === before, "and nothing from that page is kept, not even the row before the fault");
    err = null;
    try { await importPage(db, "acme-sheds", [{ name: "Broken", phone: "5550100803" }], true); } catch (e) { err = e.message; }
    ok(err && /broken/.test(err), "a dry run reports the same fault instead of hiding it", err);
    await db.close();
  }

  // ── 10. Re-apply, CRLF, dry run of the file, the header's ROLLBACK ──────────────────────────
  console.log("migration 282: a re-apply, a CRLF checkout, a dry run of the file and the header's ROLLBACK");
  {
    const db = await fresh();
    await apply(db);
    await importPage(db, "acme-sheds", PAGE, false);
    const now = await contacts(db);
    let re = null;
    try { re = await apply(db); ok(true, "a re-apply runs clean, after an import"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(JSON.stringify(await contacts(db)) === JSON.stringify(now), "and moves no contact");
    ok(re && re.record && re.record.contacts_checked === 8 && re.record.contacts_changed === 0 && re.record.ghl_import_rows === 3,
      "its record counts the contacts as they now are", JSON.stringify(re && re.record));

    const sql = ROLLBACK_SQL();
    ok(/drop function if exists public\.crm_import_ghl_contacts\(text, jsonb, boolean\);/.test(sql)
      && /set source = 'import' where source = 'ghl_import';/.test(sql)
      && /delete from supabase_migrations\.schema_migrations where version = '282';/.test(sql), "the ROLLBACK block has the function, the relabel, the check and the ledger row", sql);
    let err = null;
    try { await db.exec(sql); } catch (e) { err = e.message; }
    ok(!err, "it runs as written, after a real import", err);
    ok(!(await fnExists(db)), "the function is gone");
    const def = await sourceCheck(db);
    ok(def && !def.includes("'ghl_import'") && def.includes("'phone'") && def.includes("'import'"), "the check is 254's five values again", def);
    ok((await one(db, "select count(*)::int n from public.crm_contacts where source = 'import'")).n === 3
      && (await one(db, "select count(*)::int n from public.crm_contacts")).n === 8, "the imported contacts are kept, relabelled 'import'");
    ok((await one(db, "select count(*)::int n from supabase_migrations.schema_migrations where version = '282'")).n === 0, "the ledger row is gone");
    await db.close();

    const crlf = await fresh();
    let rec = null; err = null;
    try { rec = (await apply(crlf, MIG_TEXT().replace(/\r?\n/g, "\r\n"))).record; } catch (e) { err = e.message; }
    ok(!err && rec && rec.function_ready === true && rec.contacts_changed === 0, "a CRLF copy applies and prints the same record", err || JSON.stringify(rec));
    await crlf.close();

    const dry = await fresh();
    const beforeDry = await contacts(dry);
    const text = DRY_RUN();
    ok((text.match(/\ncommit;/g) || []).length === 0 && (text.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = null;
    try { notices = await apply(dry, text); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(notices && notices.record && notices.record.function_ready === true && notices.record.source_check_has_ghl_import === true,
      "it prints the same record the apply would", JSON.stringify(notices && notices.record));
    ok(!(await fnExists(dry)) && !(await sourceCheck(dry)).includes("'ghl_import'") && JSON.stringify(await contacts(dry)) === JSON.stringify(beforeDry),
      "and leaves no function, the old check and every contact as it was");
    await dry.close();
  }

  // ── 11. Mutants: broken shapes are refused, and nothing is left behind ──────────────────────
  console.log("migration 282: refuses what it cannot prove");
  {
    async function refused(mutant, re) {
      const db = await fresh();
      const before = JSON.stringify(await contacts(db));
      let err = null;
      try { await apply(db, mutant); } catch (e) { err = e.message; }
      await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
      const out = {
        err, matched: !!err && re.test(err),
        fnGone: !(await fnExists(db)),
        checkKept: !(await sourceCheck(db)).includes("'ghl_import'"),
        rowsKept: JSON.stringify(await contacts(db)) === before,
      };
      await db.close();
      return out;
    }
    const swap = (from, to) => {
      const t = MIG_TEXT();
      if (!t.includes(from)) throw new Error(`mutant anchor not found: ${from}`);
      return t.replace(from, to);
    };

    let r = await refused(swap("revoke execute on function public.crm_import_ghl_contacts(text, jsonb, boolean) from public, anon, authenticated;", ""),
      /282: anon can execute crm_import_ghl_contacts/);
    ok(r.matched && r.fnGone && r.checkKept && r.rowsKept, "the revoke left out (default privileges hand it to anon): refused, nothing of 282 left", JSON.stringify(r));

    r = await refused(swap("update public.crm_contacts set source = 'ghl_import' where id = v_id and source = 'design';",
      "update public.crm_contacts set source = 'import' where id = v_id and source = 'design';"),
      /a new contact has source import \/ import, expected ghl_import/);
    ok(r.matched && r.fnGone && r.checkKept && r.rowsKept, "new contacts labelled with the wrong source: refused by the rehearsal", JSON.stringify(r));

    r = await refused(swap("      else\n        n_matched := n_matched + 1;\n      end if;",
      "      else\n        n_matched := n_matched + 1;\n        update public.crm_contacts set source = 'ghl_import' where id = v_id;\n      end if;"),
      /an existing contact's source moved to ghl_import/);
    ok(r.matched && r.fnGone && r.checkKept && r.rowsKept, "an import that relabels contacts it did not create: refused", JSON.stringify(r));

    r = await refused(swap("    if v_dry then\n      raise exception using errcode = 'S2820'", "    if false then\n      raise exception using errcode = 'S2820'"),
      /the dry run left a contact behind/);
    ok(r.matched && r.fnGone && r.checkKept && r.rowsKept, "a dry run that keeps its writes: refused", JSON.stringify(r));

    r = await refused(swap("check (source in ('design', 'captured_lead', 'manual', 'import', 'phone', 'ghl_import'));",
      "check (source in ('design', 'captured_lead', 'manual', 'import', 'ghl_import'));"),
      /crm_contacts_source_check|check constraint/);
    ok(r.matched && r.fnGone && r.checkKept && r.rowsKept, "a check that drops 'phone' (254's value): refused, the phone contact's row is the proof", JSON.stringify(r));

    r = await refused(swap("    from public.crm_contacts c where c.client_id = p_client_id and c.created_at = now();",
      "    from public.crm_contacts c where false;"),
      /a re-run answered/);
    ok(r.matched && r.fnGone && r.checkKept && r.rowsKept, "\"new\" judged without the call's known ids (several calls in one transaction): refused by the re-run check", JSON.stringify(r));

    r = await refused(swap("      if v_key is not null and v_dnd then\n        insert into public.sms_opt_outs",
      "      if false then\n        insert into public.sms_opt_outs"),
      /the dry run answered/);
    ok(r.matched && r.fnGone && r.checkKept && r.rowsKept, "do-not-disturb dropped instead of opted out: refused by the rehearsal", JSON.stringify(r));

    r = await refused(swap("         where id = v_id and phone_digits = v_key and sms_opt_out_at is null;",
      "         where id = v_id and false and sms_opt_out_at is null;"),
      /do-not-disturb did not become the phone's opt-out/);
    ok(r.matched && r.fnGone && r.checkKept && r.rowsKept, "the contact's sms_opt_out_at left unset: refused by the rehearsal", JSON.stringify(r));

    r = await refused(swap("            raise exception using errcode = 'S2822', message = 'crm_import_ghl_contacts: email belongs to another contact';", "            null;"),
      /an email two contacts would share/);
    ok(r.matched && r.fnGone && r.checkKept && r.rowsKept, "an email copied onto a second live contact: refused by the rehearsal", JSON.stringify(r));

    r = await refused(swap("        if not coalesce(v_conflict, false) then", "        if true then"),
      /a second person's name went onto the contact/);
    ok(r.matched && r.fnGone && r.checkKept && r.rowsKept, "a second person's name put on the contact: refused by the rehearsal", JSON.stringify(r));

    // A contact or an opt-out that already carries the rehearsal's tenant is never touched.
    for (const [label, seed] of [
      ["a contact", "insert into public.crm_contacts (client_id, phone_digits) values ('__m282_rehearsal__', '5550109998')"],
      ["an opt-out", "insert into public.sms_opt_outs (client_id, phone_digits, reason) values ('__m282_rehearsal__', '5550109998', 'operator')"],
    ]) {
      const db = await fresh();
      await db.exec(seed);
      const before = JSON.stringify(await contacts(db)) + JSON.stringify(await optOuts(db));
      let err = null;
      try { await apply(db); } catch (e) { err = e.message; }
      await db.exec("rollback").catch(() => {});
      ok(err && /contacts or opt-outs for __m282_rehearsal__ already exist/.test(err)
        && JSON.stringify(await contacts(db)) + JSON.stringify(await optOuts(db)) === before && !(await fnExists(db)),
        `${label} already on the rehearsal's tenant: refused, left alone`, err);
      await db.close();
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
