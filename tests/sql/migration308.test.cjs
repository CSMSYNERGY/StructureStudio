// Execute migration 308 for real in PGlite (Postgres compiled to WASM, in memory), on a
// crm_contacts / crm_field_changes shaped like the live ones (information_schema, 2026-10-14) with
// 188's crm_update_contact applied from its own file, then check what it promises: one
// crm_update_contact with p_company last, still service-role only, the company set / left alone /
// cleared / capped and logged, the live 15-argument named call still saving, another tenant
// refused, the rehearsal leaving nothing behind, a re-apply harmless, a refusal without 188, and
// broken copies (mutants) refused. Nothing here touches the live project.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration308.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
//
// Every value here is an obviously fake fixture: this repo is public.
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
const M308 = () => (process.env.MIG_FILE ? fs.readFileSync(process.env.MIG_FILE, "utf8").replace(/\r/g, "") : read("308_crm_contact_company_edit.sql"));
const M188 = () => read("188_crm_contact_owner_and_billing.sql");
const TENANT = "demo-tenant";
const CONTACT = "00000000-0000-4000-8000-00000000c308";
const OFFICE = "00000000-0000-4000-8000-0000000000a1";
const REHEARSAL = "company set, kept, re-saved, kept by a 15-argument call, cleared, capped at 200; another tenant refused";
const SIG16 = "crm_update_contact(text,uuid,text,text,text,uuid,text,text,text,text,text,text,text,text,text,text)";

// The live shape before 188 (its four billing columns are added by running 188 itself), and
// crm_phone_key verbatim from pg_get_functiondef (2026-10-14). company is 301's column.
const STUBS = ({ with188 = true } = {}) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create or replace function public.crm_phone_key(p_phone text) returns text language sql immutable set search_path to '' as $function$
  select nullif(
    case
      when length(d) = 11 and left(d, 1) = '1' then right(d, 10)
      else d
    end, '')
  from (select regexp_replace(coalesce(p_phone, ''), '\\D', '', 'g') as d) s;
$function$;
create table public.client_users (user_id uuid primary key, client_id text not null);
create table public.crm_contacts (
  id uuid primary key default gen_random_uuid(), client_id text not null, name text, phone text, phone_digits text,
  email text, email_lower text generated always as (lower(btrim(email))) stored,
  street text, city text, state text, zip text, owner_user_id uuid, labels text[] not null default '{}'::text[],
  merged_into uuid references public.crm_contacts(id),
  source text not null default 'design' check (source = any (array['design','captured_lead','manual','import','phone','ghl_import','booking'])),
  first_seen_at timestamptz not null default now(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  sms_opt_out_at timestamptz
);
create unique index crm_contacts_tenant_phone on public.crm_contacts (client_id, phone_digits)
  where phone_digits is not null and phone_digits <> '' and merged_into is null;
create table public.crm_field_changes (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  field text not null, old_value text, new_value text, changed_by uuid, created_at timestamptz not null default now()
);
revoke all on public.crm_contacts, public.crm_field_changes from public, anon, authenticated;
grant all on public.crm_contacts, public.crm_field_changes, public.client_users to service_role;
${with188 ? M188() : ""}
alter table public.crm_contacts add column if not exists company text;
insert into public.client_users (user_id, client_id) values ('${OFFICE}', '${TENANT}');
insert into public.crm_contacts (id, client_id, name, company, phone, phone_digits, email, source)
  values ('${CONTACT}', '${TENANT}', 'Pat Fixture', 'Wrong Barns', '(555) 010-3081', '5550103081', 'pat.fixture@example.invalid', 'manual');
`;

async function makeDb(opts) {
  const db = new PGlite();
  await db.exec(STUBS(opts));
  return db;
}
async function apply(db, sql) {
  const notices = [];
  const out = await db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
  const record = [...out].reverse().find((r) => r.rows && r.rows.length && r.fields.some((f) => f.name === "migration"));
  return { notices, record: record ? record.rows[0] : null };
}

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
async function refused(db, sql, pattern) {
  try { await db.exec(sql); return { refused: false, message: "(accepted)" }; }
  catch (e) { return { refused: !pattern || pattern.test(e.message), message: e.message }; }
  finally { try { await db.exec("reset role"); } catch (_e) { /* not in a role */ } }
}

(async () => {
  console.log("migration 308: the company joins the contact editor");
  const early = await makeDb({ with188: false });
  try { await apply(early, M308()); ok(false, "308 without 188's crm_update_contact is refused", "it committed"); }
  catch (e) { ok(/migration 188 not applied/.test(e.message), "308 without 188's crm_update_contact is refused", e.message); }

  const db = await makeDb();
  ok((await one(db, "select count(*)::int n from pg_proc where proname = 'crm_update_contact'")).n === 1, "before: 188's one crm_update_contact");
  let res;
  try { res = await apply(db, M308()); ok(true, "308 applied cleanly"); }
  catch (e) { ok(false, "308 applied", e.message); process.exit(1); }
  const R = res.record || {};
  ok(R.signature === SIG16, "RECORD: the 16-argument signature, p_company last", R.signature);
  ok(R.overloads === 1, "RECORD: exactly one crm_update_contact", String(R.overloads));
  ok(R.rehearsal === REHEARSAL, "RECORD: the rehearsal ran to its end", R.rehearsal);
  ok((await one(db, "select count(*)::int n from public.crm_contacts where client_id = '__m308_rehearsal__'")).n === 0, "the rehearsal left no contact");
  ok((await one(db, "select count(*)::int n from public.crm_field_changes")).n === 0, "  and no changelog row");
  ok((await one(db, `select company from public.crm_contacts where id = '${CONTACT}'`)).company === "Wrong Barns", "the existing contact was not touched");

  console.log("portal-settings' calls, as the service role");
  await db.exec("set role service_role");
  // crm_save_contact after this change: every field the browser sends, company included.
  const save16 = (company, name) => db.query(
    `select public.crm_update_contact(p_client_id => $1, p_id => $2, p_name => $3, p_phone => '(555) 010-3081',
       p_email => 'pat.fixture@example.invalid', p_actor => $4, p_street => '', p_city => '', p_state => '', p_zip => '',
       p_owner => '', p_billing_street => '', p_billing_city => '', p_billing_state => '', p_billing_zip => '',
       p_company => $5) as n`, [TENANT, CONTACT, name, OFFICE, company]);
  ok((await save16("Right Barns", "Pat Fixture")).rows[0].n === 1, "the editor's save with a corrected company counts one change");
  const c1 = await one(db, `select company, name, phone_digits, email from public.crm_contacts where id = '${CONTACT}'`);
  ok(c1.company === "Right Barns" && c1.name === "Pat Fixture" && c1.phone_digits === "5550103081", "  the company is fixed and nothing else moved", JSON.stringify(c1));
  const fc = await one(db, `select field, old_value, new_value, changed_by from public.crm_field_changes where contact_id = '${CONTACT}'`);
  ok(fc && fc.field === "company" && fc.old_value === "Wrong Barns" && fc.new_value === "Right Barns" && fc.changed_by === OFFICE, "  logged as a company change by the person who saved", JSON.stringify(fc));
  ok((await save16("Right Barns", "Pat Fixture")).rows[0].n === 0, "saving the same form again changes nothing");
  // The live portal-settings until it is redeployed: 15 named arguments, no p_company.
  const n15 = (await db.query(
    `select public.crm_update_contact(p_client_id => $1, p_id => $2, p_name => 'Pat Renamed', p_phone => null, p_email => null,
       p_actor => $3, p_street => null, p_city => null, p_state => null, p_zip => null, p_owner => null,
       p_billing_street => null, p_billing_city => null, p_billing_state => null, p_billing_zip => null) as n`, [TENANT, CONTACT, OFFICE])).rows[0].n;
  ok(n15 === 1, "the live 15-argument call still saves");
  ok((await one(db, `select company from public.crm_contacts where id = '${CONTACT}'`)).company === "Right Barns", "  and leaves the company alone");
  ok((await save16("", "Pat Renamed")).rows[0].n === 1 && (await one(db, `select company from public.crm_contacts where id = '${CONTACT}'`)).company === null, "an empty company clears it");
  ok((await one(db, `select count(*)::int n from public.crm_field_changes where field = 'company' and old_value = 'Right Barns' and new_value is null`)).n === 1, "  and the clear is logged");
  await db.query(`select public.crm_update_contact(p_client_id => $1, p_id => $2, p_company => $3)`, [TENANT, CONTACT, "y".repeat(240)]);
  ok((await one(db, `select length(company)::int n from public.crm_contacts where id = '${CONTACT}'`)).n === 200, "a 240-character company is stored at 200");
  const other = await refused(db, `set role service_role; select public.crm_update_contact(p_client_id => 'someone-else', p_id => '${CONTACT}', p_company => 'Stolen Barns')`, /contact not found/);
  ok(other.refused, "another tenant's id is 'contact not found'", other.message);
  await db.exec("reset role");

  console.log("the browser roles cannot call it");
  for (const role of ["anon", "authenticated"]) {
    const r = await refused(db, `set role ${role}; select public.crm_update_contact(p_client_id => '${TENANT}', p_id => '${CONTACT}', p_company => 'Browser Barns')`, /permission denied/);
    ok(r.refused, `${role} cannot execute crm_update_contact`, r.message);
  }

  console.log("a re-apply");
  try {
    const again = await apply(db, M308());
    ok(again.record && again.record.overloads === 1 && again.record.rehearsal === REHEARSAL, "a re-apply passes and still leaves one function", JSON.stringify(again.record));
  } catch (e) { ok(false, "a re-apply passes", e.message); }
  ok((await one(db, `select length(company)::int n from public.crm_contacts where id = '${CONTACT}'`)).n === 200, "  and keeps what was saved");

  console.log("308 mutants");
  const src = M308();
  for (const [label, mutate, re] of [
    ["the company never written", (s) => s.replace("         company = v_company,\n", ""), /308: the company did not change/],
    ["the company change logged under another name", (s) => s.replace("values (p_client_id, p_id, 'company', v_old.company, v_company, p_actor);", "values (p_client_id, p_id, 'contact', v_old.company, v_company, p_actor);"), /308: the company change was not logged/],
    ["188's function never dropped", (s) => s.replace("drop function if exists public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text, text, text, text, text, text);", ""), /308: expected exactly 1 crm_update_contact, found 2/],
    ["the browser handed execute", (s) => s.replace("to service_role;\n\ncomment on function", "to service_role, authenticated;\n\ncomment on function"), /308: authenticated can execute crm_update_contact/],
    ["NULL treated as a clear", (s) => s.replace("v_company := case when p_company is null then v_old.company else", "v_company := case when false then v_old.company else"), /308: a save without a company changed it/],
    ["no cap", (s) => s.replace("else left(nullif(btrim(p_company), ''), 200) end;", "else nullif(btrim(p_company), '') end;"), /a 250-character company was stored at 250 characters/],
  ]) {
    const mm = mutate(src);
    if (mm === src) { ok(false, `mutant "${label}" changed nothing (the source moved; update the test)`); continue; }
    const mdb = await makeDb();
    try { await apply(mdb, mm); ok(false, `mutant "${label}" was refused`, "it committed"); }
    catch (e) {
      ok(re.test(e.message), `mutant "${label}" was refused`, e.message);
      await mdb.exec("rollback").catch(() => {});
      ok((await one(mdb, "select count(*)::int n from pg_proc where proname = 'crm_update_contact' and pronargs = 15")).n === 1, "  and 188's function is still the one there");
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
