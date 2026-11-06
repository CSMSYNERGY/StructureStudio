// Execute migration 318 for real in PGlite (Postgres compiled to WASM, in memory), on top of the CRM
// contact tables as they are live (282's own test stubs: crm_contacts, crm_contact_people,
// sms_opt_outs, crm_phone_key), with 191's resolver and 282 itself applied from their own files,
// plus crm_contacts.company (301), crm_field_changes (143), a designs table with contact and
// contact_id, and app_errors. Then check what the file promises:
//   * the designs trigger fills a contact's BLANK company from the design's snapshot, logs it, and
//     never overwrites, never crosses tenants, never fires on a save that moved nothing, and never
//     fails the design write (a fault lands in app_errors);
//   * the GoHighLevel import fills a blank company, keeps a set one, counts as 282 did, and a dry
//     run keeps nothing;
//   * both functions are service-role only;
//   * THE RECORD; a refusal without 282 and on a drifted 282; a re-apply; a CRLF copy;
//   * broken copies (mutants) refused, with the whole file rolled back.
// Nothing here touches the live project.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration318.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
//
// Every value here is an obviously fake fixture: this repo is public.
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const readMig = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
const M318 = () => (process.env.MIG_FILE ? fs.readFileSync(process.env.MIG_FILE, "utf8").replace(/\r/g, "") : readMig("318_designs_contact_company.sql"));
const M282 = () => readMig("282_crm_ghl_import.sql");
const RESOLVER_191 = (() => {
  const src = readMig("191_crm_ensure_contact_second_channel.sql");
  const m = src.match(/\nbegin;\n([\s\S]*?)\ncommit;/);
  if (!m || !/create or replace function public\.crm_ensure_contact\(/.test(m[1])) throw new Error("191's resolver block moved; re-point RESOLVER_191");
  return m[1];
})();
const NEW_MD5 = (M318().match(/import_md5 '([0-9a-f]{32})'/) || [])[1];
const REHEARSAL = "filled a blank and logged it, kept two set companies, refused another tenant and six non-companies, capped at 200; "
  + "the import filled one, kept one, skipped a blank; a dry run kept nothing";

// 282's test stubs, verbatim (tests/sql/migration282.test.cjs, the live shapes on 2026-10-06).
const STUBS_282 = `
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
// What 282 does not cover: 301's company, 143's changelog, the designs columns this reads, app_errors.
const MORE = `
alter table public.crm_contacts add column if not exists company text;
create table public.crm_field_changes (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  field text not null, old_value text, new_value text, changed_by uuid, created_at timestamptz not null default now()
);
revoke all on public.crm_field_changes from anon, authenticated;
create table public.designs (
  id uuid primary key default gen_random_uuid(), short_code text not null unique, client_id text not null,
  contact jsonb not null default '{}', contact_id uuid, status text not null default 'draft',
  updated_at timestamptz not null default now()
);
create table public.app_errors (
  id uuid primary key default gen_random_uuid(), client_id text, source text, severity text not null default 'error',
  code text, message text, context jsonb, created_at timestamptz not null default now()
);
revoke all on public.designs, public.app_errors from anon, authenticated;
`;
const ACME = "acme-sheds";
const OTHER = "bravo-barns";
const A1 = "00000000-0000-4000-8000-00000000a318";   // acme, no company
const A2 = "00000000-0000-4000-8000-00000000b318";   // acme, a company set by hand
const B1 = "00000000-0000-4000-8000-00000000c318";   // the other tenant, no company
const SEED = `
insert into public.crm_contacts (id, client_id, name, company, phone, phone_digits, email, source) values
  ('${A1}', '${ACME}',  'Thomas Example', null,        '(555) 010-3101', '5550103101', 'thomas@example.invalid', 'design'),
  ('${A2}', '${ACME}',  'Rita Example',   'Set Farm',  '(555) 010-3102', '5550103102', null,                     'design'),
  ('${B1}', '${OTHER}', 'Bo Elsewhere',   null,        '(555) 010-3103', '5550103103', null,                     'design');
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];

async function fresh({ with282 = true, m282 = M282() } = {}) {
  const db = new PGlite();
  await db.exec(STUBS_282);
  await db.exec(RESOLVER_191);
  if (with282) await db.exec(m282);
  await db.exec(MORE);
  await db.exec(SEED);
  return db;
}
async function apply(db, sql = M318()) {
  const results = await db.exec(sql);
  const last = [...results].reverse().find((r) => r.rows && r.rows.length && r.fields.some((f) => f.name === "migration"));
  return last ? last.rows[0] : null;
}
async function refusedBy(db, sql, re) {
  try { await apply(db, sql); return { refused: false, message: "(it committed)" }; }
  catch (e) { await db.exec("rollback").catch(() => {}); return { refused: re.test(e.message), message: e.message }; }
}
const company = async (db, id) => (await one(db, "select company from public.crm_contacts where id = $1", [id])).company;
const logs = async (db, id) => (await one(db, "select count(*)::int n from public.crm_field_changes where contact_id = $1 and field = 'company'", [id])).n;
const fnExists = async (db) => (await one(db, "select count(*)::int n from pg_proc where proname = 'crm_fill_contact_company'")).n > 0;

(async () => {
  console.log("migration 318: a quote's company fills its CRM contact's blank one");
  ok(/^[0-9a-f]{32}$/.test(NEW_MD5 || ""), "the file names the import body's md5 in its RECORD comment", String(NEW_MD5));

  const early = await fresh({ with282: false });
  const r0 = await refusedBy(early, M318(), /migration 282 not applied/);
  ok(r0.refused, "318 without 282's import is refused", r0.message);

  // A live import that someone changed by hand after 282: the splice would silently undo their change.
  const drifted = await fresh({ m282: M282().replace("v_dnd       := coalesce(v_row->'sms_dnd' = 'true'::jsonb, false);", "v_dnd       := coalesce(v_row->'sms_dnd' = 'true'::jsonb, false); -- hand edit") });
  const r1 = await refusedBy(drifted, M318(), /has drifted from 282/);
  ok(r1.refused, "318 on a drifted import is refused", r1.message);
  ok(!(await fnExists(drifted)), "  and leaves nothing behind");

  const db = await fresh();
  let rec;
  try { rec = await apply(db); ok(true, "318 applied cleanly"); }
  catch (e) { ok(false, "318 applied", e.message); process.exit(1); }
  ok(rec && rec.trigger === "AFTER INSERT OR UPDATE OF contact_id, contact ON", "RECORD: the trigger on contact_id and contact", rec && rec.trigger);
  ok(rec && rec.import_md5 === NEW_MD5, "RECORD: the import is this file's body", rec && rec.import_md5);
  ok(rec && rec.rehearsal === REHEARSAL, "RECORD: the rehearsal ran to its end", rec && rec.rehearsal);
  ok((await one(db, "select count(*)::int n from public.crm_contacts where client_id like '__m318%'")).n === 0, "the rehearsal left no contact");
  ok((await one(db, "select count(*)::int n from public.crm_field_changes")).n === 0, "  and no changelog row");

  console.log("the designs trigger");
  // save_design's shape: the row first (contact_id null), then the stamp of contact_id (migration 133).
  await db.exec(`insert into public.designs (short_code, client_id, contact) values ('SS-TEST3180AA', '${ACME}', '{"name":"Thomas Example","company":"Bear River Band"}')`);
  ok((await company(db, A1)) === null, "a design with no contact_id yet fills nothing");
  await db.exec(`update public.designs set contact_id = '${A1}' where short_code = 'SS-TEST3180AA'`);
  ok((await company(db, A1)) === "Bear River Band", "stamping its contact fills the contact's blank company");
  const fc = await one(db, `select client_id, old_value, new_value, changed_by from public.crm_field_changes where contact_id = '${A1}'`);
  ok(fc && fc.client_id === ACME && fc.old_value === null && fc.new_value === "Bear River Band" && fc.changed_by === null,
    "  logged as a company change by nobody (the estimate did it)", JSON.stringify(fc));
  await db.exec(`update public.designs set contact = contact || '{"company":"Other Band"}' where short_code = 'SS-TEST3180AA'`);
  ok((await company(db, A1)) === "Bear River Band" && (await logs(db, A1)) === 1, "a new company on the quote never overwrites the contact's");
  await db.exec(`insert into public.designs (short_code, client_id, contact, contact_id) values ('SS-TEST3180BB', '${ACME}', '{"company":"Quote Farm"}', '${A2}')`);
  ok((await company(db, A2)) === "Set Farm" && (await logs(db, A2)) === 0, "a company set by hand is kept");
  await db.exec(`insert into public.designs (short_code, client_id, contact, contact_id) values ('SS-TEST3180CC', '${ACME}', '{"company":"Stolen Farm"}', '${B1}')`);
  ok((await company(db, B1)) === null && (await logs(db, B1)) === 0, "a design never fills another tenant's contact");
  for (const [label, contact] of [["no company key", '{"name":"Pat"}'], ["an empty company", '{"company":""}'], ["spaces", '{"company":"   "}'], ["a number", '{"company":42}']]) {
    await db.exec(`update public.crm_contacts set company = null where id = '${A1}'`);
    await db.exec(`update public.designs set contact = '${contact}' where short_code = 'SS-TEST3180AA'`);
    ok((await company(db, A1)) === null, `${label} fills nothing`);
  }
  // Cleared by hand: an unrelated save, or a save that rewrites the same snapshot, does not put it back.
  await db.exec(`update public.designs set contact = '{"name":"Thomas Example","company":"Bear River Band"}' where short_code = 'SS-TEST3180AA'`);
  ok((await company(db, A1)) === "Bear River Band", "a real change to the quote's company fills a blank again");
  await db.exec(`update public.crm_contacts set company = null where id = '${A1}'`);
  await db.exec(`update public.designs set contact = contact where short_code = 'SS-TEST3180AA'`);
  await db.exec(`update public.designs set status = 'sent' where short_code = 'SS-TEST3180AA'`);
  ok((await company(db, A1)) === null, "a company cleared by hand stays cleared through saves that moved nothing");
  // A fault inside never fails the design write: it is filed in app_errors.
  await db.exec("alter table public.crm_field_changes rename to crm_field_changes_away");
  let wrote = true;
  try { await db.exec(`update public.designs set contact = '{"name":"Thomas Example","company":"Fault Farm"}' where short_code = 'SS-TEST3180AA'`); }
  catch (_e) { wrote = false; }
  await db.exec("alter table public.crm_field_changes_away rename to crm_field_changes");
  ok(wrote && (await one(db, "select contact->>'company' c from public.designs where short_code = 'SS-TEST3180AA'")).c === "Fault Farm", "a fault inside does not fail the design write");
  const ae = await one(db, "select count(*)::int n from public.app_errors where code = 'crm_company_fill_failed' and source = 'db:designs_fill_contact_company'");
  ok(ae.n === 1, "  and is filed in app_errors");
  ok((await company(db, A1)) === null, "  and its half-done fill was rolled back with it");

  console.log("the GoHighLevel import, as portal-settings calls it");
  await db.exec("set role service_role");
  const imp = async (rows, dry = false) => (await one(db, "select public.crm_import_ghl_contacts($1, $2::jsonb, $3) r", [ACME, JSON.stringify(rows), dry])).r;
  const r = await imp([
    { name: "Robin Example", phone: "(555) 010-3104", company: "Import Farm" },
    { phone: "(555) 010-3102", company: "Not Set Farm" },
    { name: "Sam Example", phone: "(555) 010-3105" },
    { name: "Lee Example", phone: "(555) 010-3106", company: 7 },
  ]);
  ok(r.created === 3 && r.matched === 1 && r.conflicts === 0, "the counts are 282's", JSON.stringify(r));
  ok((await one(db, `select company from public.crm_contacts where client_id = '${ACME}' and phone_digits = '5550103104'`)).company === "Import Farm", "a new contact takes its company");
  ok((await company(db, A2)) === "Set Farm", "a set company is kept");
  ok((await one(db, `select company from public.crm_contacts where client_id = '${ACME}' and phone_digits = '5550103105'`)).company === null, "a row with no company stores none");
  ok((await one(db, `select company from public.crm_contacts where client_id = '${ACME}' and phone_digits = '5550103106'`)).company === null, "a company that is not a string is none");
  await imp([{ name: "Thomas Example", phone: "(555) 010-3101", company: "Bear River Band" }]);
  ok((await company(db, A1)) === "Bear River Band", "a matched contact with no company takes the row's");
  await imp([{ phone: "(555) 010-3107", company: "Dry Farm" }], true);
  ok((await one(db, `select count(*)::int n from public.crm_contacts where phone_digits = '5550103107'`)).n === 0, "a dry run keeps nothing");
  ok((await one(db, `select count(*)::int n from public.crm_contacts where client_id = '${OTHER}' and company is not null`)).n === 0, "the other tenant is never touched");
  await db.exec("reset role");

  console.log("the browser roles cannot call either function");
  for (const role of ["anon", "authenticated"]) {
    for (const sql of [`select public.crm_fill_contact_company('${ACME}', '${A1}', '{"company":"X"}')`, `select public.crm_import_ghl_contacts('${ACME}', '[]'::jsonb, true)`]) {
      let refused = false, msg = "(accepted)";
      try { await db.exec(`set role ${role}; ${sql}`); } catch (e) { refused = /permission denied/.test(e.message); msg = e.message; }
      await db.exec("reset role").catch(() => {});
      ok(refused, `${role}: ${sql.slice(7, 40)}… is refused`, msg);
    }
  }

  console.log("a re-apply, a dry run and a CRLF copy");
  try {
    const again = await apply(db);
    ok(again && again.rehearsal === REHEARSAL && again.import_md5 === NEW_MD5, "a re-apply passes");
  } catch (e) { ok(false, "a re-apply passes", e.message); }
  ok((await company(db, A1)) === "Bear River Band", "  and keeps what was filled");
  const dry = await fresh();
  const t = M318();
  const at = t.lastIndexOf("\ncommit;");
  try {
    const dr = await apply(dry, t.slice(0, at) + "\nrollback;" + t.slice(at + "\ncommit;".length));
    ok(dr && dr.rehearsal === REHEARSAL, "a dry run (commit swapped for rollback) prints the same RECORD");
    ok(!(await fnExists(dry)), "  and leaves nothing behind");
  } catch (e) { ok(false, "a dry run prints the RECORD", e.message); }
  const crlf = await fresh();
  try {
    const cr = await apply(crlf, M318().replace(/\n/g, "\r\n"));
    ok(cr && cr.rehearsal === REHEARSAL && cr.import_md5 === NEW_MD5, "a CRLF checkout of the file applies, and its md5 checks still hold");
  } catch (e) { ok(false, "a CRLF copy applies", e.message); }

  console.log("318 mutants");
  const src = M318();
  for (const [label, mutate, re] of [
    ["the fill overwrites", (s) => s.replace("     and c.merged_into is null\n     and coalesce(btrim(c.company), '') = '';", "     and c.merged_into is null;"), /318: a company already on the contact was overwritten/],
    ["no tenant guard", (s) => s.replace("     and c.client_id = p_client_id\n", ""), /318: another tenant's contact was filled/],
    ["the fill logged under another name", (s) => s.replace("values (p_client_id, p_contact_id, 'company', null, v_company, null);", "values (p_client_id, p_contact_id, 'contact', null, v_company, null);"), /318: the fill was not logged/],
    ["no cap", (s) => s.replace("v_company := left(nullif(btrim(regexp_replace(p_contact->>'company', '[[:space:]]+', ' ', 'g')), ''), 200);", "v_company := nullif(btrim(regexp_replace(p_contact->>'company', '[[:space:]]+', ' ', 'g')), '');"), /a 240-character company was stored at 240 characters/],
    ["the browser handed execute", (s) => s.replace("grant  execute on function public.crm_fill_contact_company(text, uuid, jsonb) to service_role;", "grant  execute on function public.crm_fill_contact_company(text, uuid, jsonb) to service_role, authenticated;"), /318: authenticated can execute crm_fill_contact_company/],
    ["the trigger never made", (s) => s.replace("create trigger designs_fill_contact_company\n", "create trigger designs_fill_contact_company_x\n"), /318: the designs trigger is missing or wrong/],
    ["the import never writes the company", (s) => s.replace("          update public.crm_contacts set company = v_company where id = v_id and coalesce(btrim(company), '') = '';\n", ""), /./],
    ["the import overwrites", (s) => s.replace("set company = v_company where id = v_id and coalesce(btrim(company), '') = '';", "set company = v_company where id = v_id;"), /./],
  ]) {
    const mm = mutate(src);
    if (mm === src) { ok(false, `mutant "${label}" changed nothing (the source moved; update the test)`); continue; }
    const mdb = await fresh();
    const res = await refusedBy(mdb, mm, re);
    // The two import mutants change the body, so its md5 no longer matches the one the file names:
    // the body check refuses them before the rehearsal would.
    ok(res.refused, `mutant "${label}" was refused`, res.message);
    ok(!(await fnExists(mdb)), "  and the whole file rolled back");
  }
  // And the import mutants, judged by the rehearsal itself when the md5 is updated to match them.
  for (const [label, from, to, re] of [
    ["the import never writes the company", "          update public.crm_contacts set company = v_company where id = v_id and coalesce(btrim(company), '') = '';\n", "", /318: the import did not fill the company/],
    ["the import overwrites", "set company = v_company where id = v_id and coalesce(btrim(company), '') = '';", "set company = v_company where id = v_id;", /318: the import overwrote a company/],
  ]) {
    let mm = src.replace(from, to);
    const body = mm.slice(mm.indexOf("as $fn$", mm.indexOf("create or replace function public.crm_import_ghl_contacts(")) + 7);
    const md5 = require("crypto").createHash("md5").update(body.slice(0, body.indexOf("$fn$;"))).digest("hex");
    mm = mm.split(NEW_MD5).join(md5);
    const mdb = await fresh();
    const res = await refusedBy(mdb, mm, re);
    ok(res.refused, `mutant "${label}" (md5 matched) is refused by the rehearsal`, res.message);
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
