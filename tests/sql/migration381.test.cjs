// Execute migration 381 for real in PGlite (Postgres compiled to WASM, in memory) on top of the CRM
// tables as they are live, with the functions it leans on lifted from their own migrations
// (crm_set_custom 330, crm_contact_visible_to + crm_visible_contact_ids 193, crm_seed_statuses and
// the default-status trigger 354), then drive crm_import_leads the way portal-settings calls it
// (service role, one page per call, each call its own transaction) and check what the file promises:
//   * a DRY RUN answers the real path's counts and leaves every row exactly as it was;
//   * new contacts get source 'import', the row's owner when they are on the team (else the default),
//     tags, a note, custom fields, a first_seen_at from the date added, an opt-out for do-not-text;
//   * a match (phone, then email, the contact's second people too; merged tombstones ignored) fills
//     blanks only, never renames, never changes owner or source; a different phone becomes a second
//     person; on_match 'skip' writes nothing;
//   * one deal per person per pipeline, a LOST one included; a row's own stage, else the default; a
//     stage from elsewhere refuses the row before anything is written; no pipeline, no deals;
//   * a viewer (an own-scoped importer) never writes onto a contact they cannot see, and owns what
//     they create (force_owner);
//   * a re-run of the same page writes nothing; another tenant is never touched;
//   * only a unique_violation is absorbed per row (its writes and counts undone); any other fault fails
//     the page with nothing kept;
//   * the answer is numbers and [{row, code}] only; the up-front refusals carry fixed sentences;
//   * both functions are service-role only; THE RECORD; a dry run of the file; CRLF; a re-apply; the
//     header's ROLLBACK; a mutant that opens the function to the browser is refused by PART 3.
// Nothing here touches the live project.
//
// Tenants, people, numbers and addresses are made up (555-01xx numbers, .invalid domains). The repo
// is public: no real client id or customer belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration381.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration.
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/381_crm_import_leads.sql"), "utf8").replace(/\r/g, "");

// One function lifted out of its own migration, from `create or replace function public.<name>(` to
// the end of its dollar-quoted body, so the test runs the live rule and not a copy.
function liftFn(file, name, nth = 0) {
  const src = fs.readFileSync(path.join(WT, "supabase/migrations", file), "utf8").replace(/\r\n/g, "\n");
  const head = `create or replace function public.${name}(`;
  let at = -1;
  for (let i = 0; i <= nth; i++) at = src.indexOf(head, at + 1);
  if (at < 0) throw new Error(`${file} no longer defines ${name}; re-point liftFn`);
  const tag = /\bas\s+(\$[a-z_]*\$)/i.exec(src.slice(at));
  if (!tag) throw new Error(`${file}: no dollar-quoted body for ${name}`);
  const bodyStart = at + tag.index + tag[0].length;
  const end = src.indexOf(tag[1], bodyStart);
  const semi = src.indexOf(";", end);
  return src.slice(at, semi + 1);
}
const LIFTED = [
  liftFn("330_crm_custom_fields.sql", "crm_set_custom"),
  liftFn("193_contacts_own_scope.sql", "crm_contact_visible_to"),
  liftFn("193_contacts_own_scope.sql", "crm_visible_contact_ids"),
  liftFn("354_crm_statuses_per_pipeline.sql", "crm_seed_statuses"),
  liftFn("354_crm_statuses_per_pipeline.sql", "crm_deals_default_status"),
].join("\n\n");

// The live shapes the function writes (information_schema, the migrations named per table). Default
// privileges as live, so the function's revokes are tested against the trap they exist for.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;

create or replace function public.crm_phone_key(p_phone text)
 returns text language sql immutable set search_path to ''
as $function$
  select nullif(case when length(d) = 11 and left(d, 1) = '1' then right(d, 10) else d end, '')
  from (select regexp_replace(coalesce(p_phone, ''), '\\D', '', 'g') as d) s;
$function$;

create table public.client_users (user_id uuid primary key, client_id text not null, role text not null default 'owner');

create table public.crm_contacts (
  id uuid primary key default gen_random_uuid(), client_id text not null, name text, company text, phone text,
  phone_digits text, email text, email_lower text generated always as (lower(btrim(email))) stored,
  street text, city text, state text, zip text, owner_user_id uuid, labels text[] not null default '{}',
  merged_into uuid references public.crm_contacts(id), source text not null default 'design',
  first_seen_at timestamptz not null default now(), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), sms_opt_out_at timestamptz,
  custom jsonb not null default '{}'::jsonb,
  constraint crm_contacts_source_check check (source = any (array['design','captured_lead','manual','import','phone','ghl_import','booking','form']))
);
create unique index crm_contacts_tenant_phone on public.crm_contacts (client_id, phone_digits)
  where phone_digits is not null and phone_digits <> '' and merged_into is null;
create unique index crm_contacts_tenant_email on public.crm_contacts (client_id, email_lower)
  where (phone_digits is null or phone_digits = '') and email_lower is not null and email_lower <> '' and merged_into is null;

create table public.crm_contact_people (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  ordinal integer not null default 1, name text, phone text, phone_digits text, email text,
  email_lower text generated always as (lower(btrim(email))) stored, is_primary boolean not null default false,
  source text not null default 'design', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint crm_contact_people_source_check check (source = any (array['design','captured_lead','manual','import','merge'])),
  constraint crm_contact_people_identity check ((coalesce(btrim(name), '') <> '') or (coalesce(btrim(phone), '') <> '') or (coalesce(btrim(email), '') <> ''))
);
create unique index crm_contact_people_phone_uniq on public.crm_contact_people (contact_id, phone_digits) where phone_digits is not null and phone_digits <> '';
create unique index crm_contact_people_email_uniq on public.crm_contact_people (contact_id, email_lower) where email_lower is not null and email_lower <> '';
create or replace function public.crm_contact_people_stamp() returns trigger language plpgsql security definer set search_path to ''
as $function$ begin new.phone_digits := public.crm_phone_key(new.phone); return new; end $function$;
create trigger crm_contact_people_stamp before insert or update on public.crm_contact_people
  for each row execute function public.crm_contact_people_stamp();

create table public.crm_contact_followers (contact_id uuid not null, user_id uuid not null, primary key (contact_id, user_id));

create table public.sms_opt_outs (
  client_id text not null, phone_digits text not null, reason text not null,
  effective_at timestamptz not null default now(), requested_at timestamptz not null default now(),
  note text, created_at timestamptz not null default now(), primary key (client_id, phone_digits)
);

create table public.crm_notes (
  id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid references public.crm_contacts(id),
  short_code text, body text not null, pinned boolean not null default false, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
  constraint crm_notes_scope check (contact_id is not null or short_code is not null)
);
create or replace function public.crm_stamp_author() returns trigger language plpgsql security definer set search_path to 'public'
as $fn$ begin
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); new.created_at := coalesce(new.created_at, now()); end if;
  new.updated_at := now(); return new; end $fn$;
create trigger crm_notes_stamp before insert or update on public.crm_notes for each row execute function public.crm_stamp_author();

create table public.crm_field_changes (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  field text not null, old_value text, new_value text, changed_by uuid, created_at timestamptz not null default now()
);

create table public.crm_field_defs (
  id uuid primary key default gen_random_uuid(), client_id text not null, entity text not null, source text not null default 'custom',
  key text, label text not null default 'x', field_type text not null default 'text', archived_at timestamptz
);

create table public.crm_pipelines (
  id uuid primary key default gen_random_uuid(), client_id text not null, name text not null,
  position double precision not null default 1024, lost_reasons text[] not null default '{}', seed_kind text,
  archived_at timestamptz, created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  feeds_designs boolean not null default false, mirrors_statuses boolean not null default false,
  unique (id, client_id)
);
create table public.crm_statuses (
  id uuid primary key default gen_random_uuid(), client_id text not null, pipeline_id uuid, name text not null,
  color text not null default '#64748B', position double precision not null default 1024, trigger_event text,
  archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, client_id)
);
create table public.crm_pipeline_stages (
  id uuid primary key default gen_random_uuid(), client_id text not null, pipeline_id uuid not null, name text not null,
  color text not null default '#64748B', kind text not null default 'open', position double precision not null default 1024,
  archived_at timestamptz, status_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, client_id), unique (id, pipeline_id),
  foreign key (pipeline_id, client_id) references public.crm_pipelines (id, client_id) on delete cascade
);
create table public.crm_deals (
  id uuid primary key default gen_random_uuid(), client_id text not null, pipeline_id uuid not null, stage_id uuid not null,
  contact_id uuid references public.crm_contacts (id) on delete cascade,
  title text check (title is null or length(title) <= 200), value_cents bigint check (value_cents is null or value_cents >= 0),
  expected_close_date date, next_follow_up_at timestamptz, lost_reason text,
  source text not null default 'manual' check (source in ('manual', 'import', 'booking', 'phone', 'design', 'form')),
  stage_entered_at timestamptz not null default now(), won_at timestamptz, lost_at timestamptz, created_by uuid,
  archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  short_code text, status_id uuid, custom jsonb not null default '{}'::jsonb,
  foreign key (pipeline_id, client_id) references public.crm_pipelines (id, client_id) on delete cascade,
  foreign key (stage_id, client_id) references public.crm_pipeline_stages (id, client_id),
  foreign key (stage_id, pipeline_id) references public.crm_pipeline_stages (id, pipeline_id),
  foreign key (status_id, client_id) references public.crm_statuses (id, client_id),
  constraint crm_deals_has_subject check (contact_id is not null or short_code is not null)
);
create table public.crm_deal_stage_changes (
  id bigserial primary key, client_id text not null, deal_id uuid not null references public.crm_deals (id) on delete cascade,
  from_stage uuid, to_stage uuid not null, changed_by uuid, changed_at timestamptz not null default now()
);
`;
const TRIGGERS = `
create trigger crm_deals_default_status before insert on public.crm_deals for each row execute function public.crm_deals_default_status();
`;

const A = "acme-sheds";
const U1 = "00000000-0000-4000-8000-0000000000c1";
const U2 = "00000000-0000-4000-8000-0000000000c2";
const P = "00000000-0000-4000-8000-0000000000e1";
const Q = "00000000-0000-4000-8000-0000000000e2";
const ARCH = "00000000-0000-4000-8000-0000000000e3";
const S1 = "00000000-0000-4000-8000-0000000000f1";
const S2 = "00000000-0000-4000-8000-0000000000f2";
const SQ = "00000000-0000-4000-8000-0000000000f3";
const SGONE = "00000000-0000-4000-8000-0000000000f4";
const PAT = "00000000-0000-4000-8000-000000000001";
const ROBIN = "00000000-0000-4000-8000-000000000002";
const THEIRS = "00000000-0000-4000-8000-000000000003";
const TOMB = "00000000-0000-4000-8000-000000000004";

const SEED = `
insert into public.client_users (user_id, client_id) values ('${U1}', '${A}'), ('${U2}', '${A}'), ('00000000-0000-4000-8000-0000000000c9', 'bravo-barns');
insert into public.crm_pipelines (id, client_id, name) values ('${P}', '${A}', 'Outreach'), ('${Q}', '${A}', 'Other Board');
insert into public.crm_pipelines (id, client_id, name, archived_at) values ('${ARCH}', '${A}', 'Old Board', now());
insert into public.crm_pipeline_stages (id, client_id, pipeline_id, name, position) values
  ('${S1}', '${A}', '${P}', 'New Lead', 1024), ('${S2}', '${A}', '${P}', 'Demo', 2048), ('${SQ}', '${A}', '${Q}', 'Elsewhere', 1024);
insert into public.crm_pipeline_stages (id, client_id, pipeline_id, name, position, archived_at) values ('${SGONE}', '${A}', '${P}', 'Retired', 4096, now());
insert into public.crm_field_defs (client_id, entity, key, label) values ('${A}', 'contact', 'farm', 'Farm'), ('${A}', 'deal', 'size', 'Size');
insert into public.crm_contacts (id, client_id, name, phone, phone_digits, email, source, owner_user_id, first_seen_at, created_at, updated_at) values
  ('${PAT}',    '${A}', 'Pat Example', '(555) 010-0101', '5550100101', null, 'design', null, '2026-05-01 10:00+00', '2026-05-01 10:00+00', '2026-05-01 10:00+00'),
  ('${ROBIN}',  '${A}', null, null, null, 'robin@example.invalid', 'captured_lead', null, '2026-06-01 10:00+00', '2026-06-01 10:00+00', '2026-06-01 10:00+00'),
  ('${THEIRS}', '${A}', 'Theirs', '555-010-0109', '5550100109', null, 'phone', '${U2}', '2026-07-01 10:00+00', '2026-07-01 10:00+00', '2026-07-01 10:00+00'),
  ('00000000-0000-4000-8000-000000000009', 'bravo-barns', 'Pat Elsewhere', '(555) 010-0101', '5550100101', 'pat@example.invalid', 'design', null, '2026-05-02 10:00+00', '2026-05-02 10:00+00', '2026-05-02 10:00+00');
insert into public.crm_contacts (id, client_id, name, phone, phone_digits, source, merged_into) values
  ('${TOMB}', '${A}', 'Old Duplicate', '555-010-0404', '5550100404', 'design', '${PAT}');
insert into public.crm_contact_people (client_id, contact_id, ordinal, name, phone, source) values ('${A}', '${PAT}', 2, 'Pat Spouse', '555-010-0202', 'design');
-- Robin's card on Outreach was marked lost: a re-import must not put Robin back on the board.
insert into public.crm_statuses (client_id, pipeline_id, name) values ('${A}', '${P}', 'New Lead');
insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, source, lost_at, lost_reason)
  values ('${A}', '${P}', '${S1}', '${ROBIN}', 'manual', '2026-10-01 10:00+00', 'Timing');
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const canon = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

async function fresh() {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(LIFTED);
  await db.exec(TRIGGERS);
  await db.exec(SEED);
  return db;
}
async function apply(db, sql = MIG_TEXT()) {
  const notices = [];
  const results = await db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
  const last = [...results].reverse().find((r) => r.rows && r.rows.length);
  notices.record = last ? last.rows[0] : null;
  return notices;
}
const DRY_RUN = () => {
  const t = MIG_TEXT();
  const i = t.lastIndexOf("\ncommit;");
  return t.slice(0, i) + "\nrollback;" + t.slice(i + "\ncommit;".length);
};
const ROLLBACK_SQL = () => {
  const lines = MIG_TEXT().split("\n");
  const start = lines.findIndex((l) => /^-- ── ROLLBACK/.test(l));
  if (start < 0) throw new Error("the ROLLBACK heading moved");
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (!/^--   /.test(l)) break;
    out.push(l.replace(/^--   /, ""));
  }
  return out.join("\n");
};
const REHEARSAL = "real: 2 new, 2 matched, 3 deals, 1 already on it, 4 refused; re-run: 0 new, 0 deals; "
  + "skip: 1 left alone; second phone: 1; opted out: 1";

// Everything the import could write, as one comparable text.
const snapshot = async (db) => JSON.stringify([
  await rows(db, "select * from public.crm_contacts order by client_id, id"),
  await rows(db, "select client_id, contact_id, name, phone, email, source from public.crm_contact_people order by contact_id, ordinal"),
  await rows(db, "select * from public.crm_deals order by client_id, id"),
  await rows(db, "select client_id, deal_id, from_stage, to_stage from public.crm_deal_stage_changes order by id"),
  await rows(db, "select client_id, contact_id, body from public.crm_notes order by id"),
  await rows(db, "select * from public.sms_opt_outs order by client_id, phone_digits"),
  await rows(db, "select client_id, contact_id, field, new_value from public.crm_field_changes order by id"),
  await rows(db, "select client_id, pipeline_id, name from public.crm_statuses order by id"),
]);

// One page, the way portal-settings sends it: service role, its own transaction.
async function importPage(db, clientId, page, opts = {}, dryRun = false, actor = U1) {
  await db.exec("begin");
  await db.exec("set local role service_role");
  let out = null, err = null;
  try {
    out = (await one(db, "select public.crm_import_leads($1, $2::jsonb, $3::jsonb, $4::uuid, $5) as r",
      [clientId, JSON.stringify(page), JSON.stringify(opts), actor, dryRun])).r;
  } catch (e) { err = e; }
  await db.exec(err ? "rollback" : "commit");
  if (err) throw err;
  return out;
}
const counts = (r) => { const c = { ...r }; delete c.refused; delete c.dry_run; return c; };

const PAGE = [
  { row: 2, name: "Lee New", phone: "+1 (555) 010-0505", email: "lee@example.invalid", labels: ["a", "b"], note: "Called once",
    owner: U1, stage: S2, title: "Shed", value_cents: 100000, expected_close_date: "2026-12-01", added_at: "2025-01-02",
    do_not_text: true, contact_custom: { farm: "Bear Creek", bogus: "x", list: [1] }, deal_custom: { size: "12x16" } },
  { row: 3, name: "Renamed", phone: "555.010.0101", email: "pat@example.invalid", street: "1 Main St" },
  { row: 4, name: "Pat Phone Two", phone: "5550100202" },
  { row: 5, name: "Robin Lead", phone: "+15550100303", email: "ROBIN@example.invalid" },
  { row: 6, name: "Theirs Again", phone: "5550100109" },
  { row: 7, name: "Tombstone Number", phone: "555-010-0404" },
  { row: 8, name: "Elsewhere", phone: "5550100808", stage: SQ },
  { row: 9, name: "Nobody" },
  { row: 10, email: "nameless@example.invalid" },
  { row: 11, name: "Stranger Owner", phone: "5550100606", owner: "00000000-0000-4000-8000-0000000000aa" },
];
const OPTS = { pipeline: P, default_stage: S1, default_owner: U2 };
const REAL = {
  rows: 10, contacts_created: 3, contacts_matched: 4, matched_skipped: 0, deals_created: 5, already_in_pipeline: 2,
  not_yours: 0, no_identity: 1, no_name: 1, conflicts: 0, notes_added: 1, labelled: 1, people_added: 0, opted_out: 1,
};
const REFUSED = [{ row: 8, code: "stage_missing" }, { row: 9, code: "no_identity" }, { row: 10, code: "no_name" }];

(async () => {
  // ── 1. The apply ──
  console.log("migration 381: applies on the live shape, its own checks and rehearsal included");
  {
    const db = await fresh();
    const before = await snapshot(db);
    let notices = [];
    try { notices = await apply(db); ok(true, "381 applied cleanly"); } catch (e) { ok(false, "381 applied", e.message); }
    ok(notices.some((n) => /381: checks hold$/.test(n)), "its own checks held", notices.join(" | "));
    ok(JSON.stringify(notices.record) === JSON.stringify({ migration: "381", function_ready: true, rehearsal: REHEARSAL }),
      "THE RECORD, the row the CLI prints", JSON.stringify(notices.record));
    ok(await snapshot(db) === before, "applying it wrote nothing outside the rolled-back rehearsal");
    ok((await rows(db, "select 1 from public.crm_contacts where client_id = '__m381_rehearsal__'")).length === 0, "the rehearsal left nothing");

    // ── 2. Who may call it ──
    for (const role of ["anon", "authenticated"]) {
      for (const sql of ["select public.crm_import_leads('acme-sheds', '[]'::jsonb, '{}'::jsonb, null, true)",
                         "select public.crm_import_leads_text('\"x\"'::jsonb, 5)"]) {
        let denied = null;
        await db.exec("begin");
        await db.exec(`set local role ${role}`);
        try { await db.query(sql); } catch (e) { denied = e.message; }
        await db.exec("rollback");
        ok(denied && /permission denied/.test(denied), `${role} cannot execute ${sql.slice(14, 40)}`, denied);
      }
    }
    const priv = await one(db, "select p.prosecdef, p.proconfig from pg_proc p where p.oid = 'public.crm_import_leads(text, jsonb, jsonb, uuid, boolean)'::regprocedure");
    ok(priv.prosecdef === true && JSON.stringify(priv.proconfig) === JSON.stringify(['search_path=""']), "SECURITY DEFINER with an empty search_path", JSON.stringify(priv));

    // ── 3. The dry run ──
    const beforeDry = await snapshot(db);
    const dry = await importPage(db, A, PAGE, OPTS, true);
    ok(dry.dry_run === true && canon(counts(dry)) === canon(REAL), "a dry run answers the real path's counts", JSON.stringify(dry));
    ok(JSON.stringify(dry.refused) === JSON.stringify(REFUSED), "and the same refusals", JSON.stringify(dry.refused));
    ok(await snapshot(db) === beforeDry, "and leaves every row exactly as it was");
    let nullDry = null;
    await db.exec("begin"); await db.exec("set local role service_role");
    nullDry = (await one(db, "select public.crm_import_leads($1, $2::jsonb) as r", [A, JSON.stringify(PAGE)])).r;
    await db.exec("rollback");
    // With no pipeline, row 8's stage from another board means nothing, so row 8 is a fourth new contact.
    ok(nullDry.dry_run === true && nullDry.contacts_created === 4 && nullDry.refused.length === 2, "no options and no dry_run argument: a dry run, contacts only", JSON.stringify(nullDry));
    ok(nullDry.deals_created === 0, "no pipeline, no deals");
    const text = JSON.stringify(dry);
    ok(!/Lee|Pat|Robin|example\.invalid|555|Bear|Shed|Main/.test(text), "the answer carries numbers and codes only", text);

    // ── 4. The real run ──
    const real = await importPage(db, A, PAGE, OPTS, false);
    ok(real.dry_run === false && canon(counts(real)) === canon(REAL), "the real run: 3 new, 4 matched, 5 deals, 2 already on the board", JSON.stringify(real));
    ok(JSON.stringify(real.refused) === JSON.stringify(REFUSED), "refusals: a stage from another board, no way to reach them, no name", JSON.stringify(real.refused));
    for (const r of real.refused) ok(JSON.stringify(Object.keys(r).sort()) === JSON.stringify(["code", "row"]), `a refusal is a row and a code (row ${r.row})`);

    const lee = await one(db, `select * from public.crm_contacts where client_id = '${A}' and phone_digits = '5550100505'`);
    ok(lee && lee.source === "import" && lee.name === "Lee New" && lee.email === "lee@example.invalid" && lee.owner_user_id === U1,
      "Lee: new, source import, the row's owner (on the team)", JSON.stringify(lee));
    ok(lee && JSON.stringify(lee.labels) === JSON.stringify(["a", "b"]) && new Date(lee.first_seen_at).toISOString() === "2025-01-02T00:00:00.000Z",
      "Lee: tags, and first seen on the date added", JSON.stringify(lee && [lee.labels, lee.first_seen_at]));
    ok(lee && canon(lee.custom) === canon({ farm: "Bear Creek" }), "Lee: a known custom field kept; an unknown key and a list dropped", JSON.stringify(lee && lee.custom));
    ok(lee && lee.sms_opt_out_at !== null, "Lee: do not text sets the contact's opt-out");
    ok(JSON.stringify(await rows(db, "select client_id, phone_digits, reason from public.sms_opt_outs")) === JSON.stringify([{ client_id: A, phone_digits: "5550100505", reason: "import" }]),
      "Lee: and the phone's opt-out, reason import");
    const leeDeal = await one(db, "select * from public.crm_deals where contact_id = $1", [lee.id]);
    ok(leeDeal && leeDeal.stage_id === S2 && leeDeal.title === "Shed" && Number(leeDeal.value_cents) === 100000 && leeDeal.source === "import"
      && leeDeal.created_by === U1 && leeDeal.status_id && canon(leeDeal.custom) === canon({ size: "12x16" }),
      "Lee's deal: the row's own stage, name, value, source import, the actor, a status, the deal's custom field", JSON.stringify(leeDeal));
    ok(leeDeal && new Date(leeDeal.expected_close_date).toISOString().slice(0, 10) === "2026-12-01", "Lee's deal: the expected close date");
    ok((await rows(db, "select 1 from public.crm_deal_stage_changes where deal_id = $1 and from_stage is null and to_stage = $2", [leeDeal.id, S2])).length === 1, "Lee's deal: its first stage change");
    ok(JSON.stringify(await rows(db, "select body, created_by from public.crm_notes where contact_id = $1", [lee.id])) === JSON.stringify([{ body: "Called once", created_by: U1 }]), "Lee: the note, by the actor");
    ok((await rows(db, "select 1 from public.crm_field_changes where contact_id = $1 and field = 'owner' and new_value = $2", [lee.id, U1])).length === 1, "Lee: the owner is logged");

    const pat = await one(db, "select * from public.crm_contacts where id = $1", [PAT]);
    ok(pat.name === "Pat Example" && pat.email === "pat@example.invalid" && pat.street === "1 Main St" && pat.source === "design" && pat.owner_user_id === null,
      "Pat: matched by phone, NOT renamed, gains the email and street, keeps source and owner", JSON.stringify(pat));
    ok((await rows(db, "select 1 from public.crm_contact_people where contact_id = $1", [PAT])).length === 1, "Pat: matched by the second person's phone, no new person added");
    ok((await rows(db, "select stage_id from public.crm_deals where contact_id = $1", [PAT])).map((r) => r.stage_id).join() === S1, "Pat: one deal, on the default stage");
    const robin = await one(db, "select * from public.crm_contacts where id = $1", [ROBIN]);
    ok(robin.name === "Robin Lead" && robin.phone_digits === "5550100303" && robin.source === "captured_lead", "Robin: matched by email in any case, the blank name and phone filled", JSON.stringify(robin));
    ok((await rows(db, "select 1 from public.crm_deals where contact_id = $1", [ROBIN])).length === 1, "Robin: the LOST card counts, so no second card");
    const theirs = await one(db, "select * from public.crm_contacts where id = $1", [THEIRS]);
    ok(theirs.name === "Theirs" && theirs.owner_user_id === U2, "Theirs: no viewer, so matched; name and owner untouched");
    const tomb = await one(db, `select * from public.crm_contacts where client_id = '${A}' and phone_digits = '5550100404' and merged_into is null`);
    ok(tomb && tomb.source === "import" && tomb.id !== TOMB, "a merged-away tombstone's number makes a new live contact");
    const stranger = await one(db, `select * from public.crm_contacts where client_id = '${A}' and phone_digits = '5550100606'`);
    ok(stranger && stranger.owner_user_id === U2, "an owner who is not on the team gives way to the default owner", JSON.stringify(stranger));
    ok((await rows(db, `select 1 from public.crm_contacts where client_id = '${A}' and phone_digits = '5550100808'`)).length === 0, "the refused stage row wrote nothing");
    const bravo = await one(db, "select * from public.crm_contacts where client_id = 'bravo-barns'");
    ok(bravo.name === "Pat Elsewhere" && bravo.street === null, "the other tenant's contact with the same phone is untouched");
    const dupes = await rows(db, "select client_id, phone_digits from public.crm_contacts where merged_into is null and phone_digits is not null group by 1, 2 having count(*) > 1");
    ok(dupes.length === 0, "no two live contacts share a phone", JSON.stringify(dupes));

    // ── 5. The same page again ──
    const beforeAgain = await rows(db, "select count(*)::int as n from public.crm_deals");
    const again = await importPage(db, A, PAGE, OPTS, false);
    ok(again.contacts_created === 0 && again.deals_created === 0 && again.notes_added === 0 && again.labelled === 0 && again.people_added === 0 && again.opted_out === 0,
      "a re-run creates nothing", JSON.stringify(again));
    ok(again.contacts_matched === 7 && again.already_in_pipeline === 7, "everyone it brought in now matches, and is already on the board", JSON.stringify(again));
    ok((await rows(db, "select count(*)::int as n from public.crm_deals"))[0].n === beforeAgain[0].n, "no deal was added");

    // ── 6. Someone limited to their own customers ──
    const narrow = await importPage(db, A, [
      { row: 2, name: "Theirs Once More", phone: "5550100109", street: "9 Side Rd" },
      { row: 3, name: "Narrow New", phone: "5550100707", owner: U2 },
      { row: 4, name: "Pat", phone: "5550100101", zip: "11111" },
    ], { ...OPTS, force_owner: U1, viewer: U1, default_owner: U1 }, false);
    ok(narrow.not_yours === 1 && JSON.stringify(narrow.refused) === JSON.stringify([{ row: 2, code: "not_yours" }]), "a teammate's customer is refused as not_yours", JSON.stringify(narrow));
    ok((await one(db, "select street from public.crm_contacts where id = $1", [THEIRS])).street === null, "and nothing about them is written");
    ok((await one(db, `select owner_user_id from public.crm_contacts where client_id = '${A}' and phone_digits = '5550100707'`)).owner_user_id === U1,
      "what they create is theirs, whatever the row's owner says");
    ok((await one(db, "select zip from public.crm_contacts where id = $1", [PAT])).zip === "11111", "an unassigned contact is everybody's (193), so it is enriched");

    // ── 7. Leave them as they are; contacts only; a second phone ──
    const skip = await importPage(db, A, [{ row: 2, name: "Pat", phone: "5550100101", city: "Nowhere", stage: S2 }], { ...OPTS, on_match: "skip" }, false);
    ok(skip.matched_skipped === 1 && skip.contacts_matched === 0 && skip.deals_created === 0 && skip.already_in_pipeline === 0, "on_match skip counts the match and does nothing else", JSON.stringify(skip));
    ok((await one(db, "select city from public.crm_contacts where id = $1", [PAT])).city === null, "the match is left exactly as it was");
    const flat = await importPage(db, A, [{ row: 2, name: "No Board", phone: "5550100909", stage: S1 }], {}, false);
    ok(flat.contacts_created === 1 && flat.deals_created === 0 && flat.refused.length === 0, "no pipeline: a contact and no deal, the row's stage ignored", JSON.stringify(flat));
    const second = await importPage(db, A, [{ row: 2, name: "Lee Work", phone: "5550100777", email: "lee@example.invalid" }], OPTS, false);
    ok(second.people_added === 1 && second.contacts_created === 0, "a different phone for a known email becomes a second person", JSON.stringify(second));
    const leePeople = await rows(db, "select name, phone_digits, source from public.crm_contact_people where contact_id = $1", [lee.id]);
    ok(JSON.stringify(leePeople) === JSON.stringify([{ name: "Lee Work", phone_digits: "5550100777", source: "import" }]), "with the row's name, source import", JSON.stringify(leePeople));
    ok((await one(db, "select name, phone_digits from public.crm_contacts where id = $1", [lee.id])).name === "Lee New", "and the contact keeps its own name and phone");

    // ── 8. Faults ──
    await db.exec(`create function public.test_race() returns trigger language plpgsql as $$
      begin
        if new.name = 'Race Me' then raise exception 'raced' using errcode = 'unique_violation'; end if;
        if new.name = 'Boom' then raise exception 'boom' using errcode = 'check_violation'; end if;
        return new;
      end $$;
      create trigger test_race before insert on public.crm_contacts for each row execute function public.test_race();`);
    const race = await importPage(db, A, [
      { row: 2, name: "Race Me", phone: "5550101001", note: "lost with the row", stage: S1 },
      { row: 3, name: "After The Race", phone: "5550101002" },
    ], OPTS, false);
    ok(race.conflicts === 1 && race.contacts_created === 1 && race.notes_added === 0 && JSON.stringify(race.refused) === JSON.stringify([{ row: 2, code: "conflict" }]),
      "a unique_violation costs that row alone, its counts with it", JSON.stringify(race));
    const beforeBoom = await snapshot(db);
    let boom = null;
    try { await importPage(db, A, [{ row: 2, name: "Fine", phone: "5550101003" }, { row: 3, name: "Boom", phone: "5550101004" }], OPTS, false); } catch (e) { boom = e.message; }
    ok(boom && /boom/.test(boom), "any other fault fails the page", boom);
    ok(await snapshot(db) === beforeBoom, "with nothing from that page kept");
    await db.exec("drop trigger test_race on public.crm_contacts; drop function public.test_race();");

    // ── 9. Up-front refusals, fixed sentences ──
    const refuse = async (page, opts, re, label) => {
      let err = null;
      try { await importPage(db, A, page, opts, true); } catch (e) { err = e.message; }
      ok(err && re.test(err) && !/555|example/.test(err), label, err);
    };
    await refuse(Array.from({ length: 201 }, (_, i) => ({ row: i + 2 })), {}, /at most 200 rows per call/, "201 rows refused");
    await refuse({ row: 2 }, {}, /p_rows must be a JSON array/, "rows that are not a list refused");
    await refuse([], { pipeline: "00000000-0000-4000-8000-0000000000ee" }, /^pipeline not found$/, "a pipeline that does not exist");
    await refuse([], { pipeline: ARCH }, /^pipeline not found$/, "an archived pipeline");
    await refuse([], { pipeline: "board" }, /^pipeline not found$/, "a pipeline that is not an id");
    await refuse([], { pipeline: P, default_stage: SQ }, /^stage not found$/, "a default stage from another pipeline");
    await refuse([], { pipeline: P, default_stage: SGONE }, /^stage not found$/, "an archived default stage");
    await refuse([], { default_stage: S1 }, /^stage not found$/, "a default stage with no pipeline");
    await refuse([], { pipeline: P, default_owner: "00000000-0000-4000-8000-0000000000c9" }, /^owner is not on this team$/, "an owner from another tenant");
    await refuse([], { force_owner: "nobody" }, /^owner is not on this team$/, "a forced owner that is not an id");
    await refuse([], { on_match: "overwrite" }, /on_match must be attach or skip/, "an unknown on_match");
    let otherTenant = null;
    try { await importPage(db, "bravo-barns", [], { pipeline: P }, true); } catch (e) { otherTenant = e.message; }
    ok(otherTenant === "pipeline not found", "another tenant cannot import into this tenant's pipeline", otherTenant);
  }

  // ── 10. Re-apply, CRLF, dry run of the file, the header's ROLLBACK, a mutant ──
  console.log("migration 381: a re-apply, a CRLF copy, a dry run of the file, the ROLLBACK, a mutant");
  {
    const db = await fresh();
    await apply(db);
    let re = null;
    try { re = await apply(db); ok(true, "a re-apply runs clean"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(re && re.record && re.record.function_ready === true, "and prints the same record");
    const sql = ROLLBACK_SQL();
    ok(/drop function if exists public\.crm_import_leads\(text, jsonb, jsonb, uuid, boolean\);/.test(sql)
      && /drop function if exists public\.crm_import_leads_text\(jsonb, integer\);/.test(sql)
      && /delete from supabase_migrations\.schema_migrations where version = '381';/.test(sql), "the ROLLBACK block drops both functions and the ledger row", sql);
    await db.exec(sql);
    ok((await one(db, "select to_regprocedure('public.crm_import_leads(text, jsonb, jsonb, uuid, boolean)') is null and to_regprocedure('public.crm_import_leads_text(jsonb, integer)') is null as gone")).gone, "and it runs");
  }
  {
    const crlf = await fresh();
    let rec = null, err = null;
    try { rec = (await apply(crlf, MIG_TEXT().replace(/\n/g, "\r\n"))).record; } catch (e) { err = e.message; }
    ok(!err && rec && rec.function_ready === true && rec.rehearsal === REHEARSAL, "a CRLF copy applies and prints the same record", err || JSON.stringify(rec));
  }
  {
    const dry = await fresh();
    let notices = null;
    try { notices = await apply(dry, DRY_RUN()); } catch (e) { ok(false, "the dry run of the file ran", e.message); }
    ok(notices && notices.record && notices.record.rehearsal === REHEARSAL, "a dry run of the file prints the same record", JSON.stringify(notices && notices.record));
    ok((await one(dry, "select to_regprocedure('public.crm_import_leads(text, jsonb, jsonb, uuid, boolean)') is null as gone")).gone, "and leaves no function behind");
  }
  {
    const db = await fresh();
    const t = MIG_TEXT();
    const anchor = "-- ═════════════════════════════════════════════════════════════════════════════════════════\n-- PART 3";
    if (!t.includes(anchor)) throw new Error("mutant anchor not found: PART 3");
    const mutant = t.replace(anchor, "grant execute on function public.crm_import_leads(text, jsonb, jsonb, uuid, boolean) to authenticated;\n" + anchor);
    let err = null;
    try { await apply(db, mutant); } catch (e) { err = e.message; }
    // The file's own begin; is still open after the failed batch, as it would be in the CLI's session.
    await db.exec("rollback");
    ok(err && /381: authenticated can execute/.test(err), "a copy that opens the function to the browser is refused by PART 3", err);
    ok((await one(db, "select to_regprocedure('public.crm_import_leads(text, jsonb, jsonb, uuid, boolean)') is null as gone")).gone, "with the whole file rolled back");
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
