// Execute migration 325 (website lead forms + email templates) for real in PGlite (Postgres in WASM,
// in memory) on top of the tables it touches, cut to the columns it reads, then check what it promises:
//   * the four tables exist with RLS on and only an owner SELECT policy each (no anon policy);
//   * lead_form_bump counts views / starts / submits per form per day, refuses any other kind, and
//     only the service role may call it;
//   * a published form must carry its published definition; deleting a form takes its submissions
//     and daily counts with it;
//   * email_sends.kind, crm_contacts.source and crm_deals.source take the new values and keep the old;
//   * THE RECORD reads true, and a re-apply (and the commit -> rollback rehearsal) behave.
// Nothing here touches the live project. Tenants are made up (the repo is public).
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration325.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const RAW = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/325_lead_forms.sql"), "utf8");
const M = () => RAW().replace(/\r\n/g, "\n");

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create function public.current_client_id() returns text language sql stable as $$ select 'example-builder'::text $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table public.crm_contacts (id uuid primary key default gen_random_uuid(), client_id text not null, source text not null default 'design',
  constraint crm_contacts_source_check check (source = any (array['design','captured_lead','manual','import','phone','ghl_import','booking'])));
create table public.crm_deals (id uuid primary key default gen_random_uuid(), client_id text not null, source text not null default 'manual',
  constraint crm_deals_source_check check (source = any (array['manual','import','booking','phone','design'])));
create table public.email_sends (id uuid primary key default gen_random_uuid(), client_id text not null, kind text not null,
  constraint email_sends_kind_check check (kind = any (array['estimate','invoice','test','acceptance','change_order','conversation','login_code'])));
`;

let failures = 0;
const ok = (cond, name, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail && !cond ? `   [${detail}]` : ""}`);
};
const opened = [];
const closeAll = async () => { for (const d of opened) await d.close().catch(() => {}); };
async function fresh() { const db = new PGlite(); opened.push(db); await db.exec(STUBS); return db; }
const rows = async (db, sql) => (await db.query(sql)).rows;
const refused = async (db, sql) => { try { await db.exec(sql); return false; } catch { return true; } };

(async () => {
  const db = await fresh();
  let record;
  try {
    const res = await db.exec(M());
    record = res.filter((r) => r.rows && r.rows.length).pop()?.rows?.[0];
    ok(true, "325 applied");
  } catch (e) { ok(false, "325 applied", e.message); await closeAll(); process.exitCode = 1; return; }
  ok(record && record.migration === "325" && record.forms && record.submissions && record.stats && record.templates && record.bucket && record.anon_can_bump === false,
    "THE RECORD reads true for every part, and anon cannot bump", JSON.stringify(record));

  // ── RLS posture ─────────────────────────────────────────────────────────────────────────
  for (const t of ["lead_forms", "lead_form_submissions", "lead_form_daily_stats", "email_templates"]) {
    const r = await rows(db, `select (select relrowsecurity from pg_class where oid = 'public.${t}'::regclass) as rls,
      (select count(*)::int from pg_policy where polrelid = 'public.${t}'::regclass) as n,
      (select count(*)::int from pg_policy p where polrelid = 'public.${t}'::regclass and polcmd = 'r' and 'authenticated'::regrole = any(p.polroles)) as owner_select`);
    ok(r[0].rls && r[0].n === 1 && r[0].owner_select === 1, `${t}: RLS on, one owner SELECT policy, nothing else`, JSON.stringify(r[0]));
  }

  // ── forms ───────────────────────────────────────────────────────────────────────────────
  ok(await refused(db, "insert into public.lead_forms (client_id, name, status) values ('example-builder', 'X', 'published')"),
    "a published form without its published definition is refused");
  ok(await refused(db, "insert into public.lead_forms (client_id, name) values ('example-builder', '   ')"), "a blank name is refused");
  const [f] = await rows(db, "insert into public.lead_forms (client_id, name, status, published_definition) values ('example-builder', 'Contact us', 'published', '{}') returning id");
  ok(!!f.id, "a published form with its definition is kept");

  // ── counters ────────────────────────────────────────────────────────────────────────────
  await db.exec(`select public.lead_form_bump('${f.id}', 'example-builder', 'views'); select public.lead_form_bump('${f.id}', 'example-builder', 'views');
    select public.lead_form_bump('${f.id}', 'example-builder', 'starts'); select public.lead_form_bump('${f.id}', 'example-builder', 'submits');`);
  const s = await rows(db, `select views, starts, submits from public.lead_form_daily_stats where form_id = '${f.id}'`);
  ok(s.length === 1 && s[0].views === 2 && s[0].starts === 1 && s[0].submits === 1, "lead_form_bump counts per form per day", JSON.stringify(s));
  ok(await refused(db, `select public.lead_form_bump('${f.id}', 'example-builder', 'client_id')`), "lead_form_bump refuses any other kind");
  const priv = await rows(db, `select has_function_privilege('anon', 'public.lead_form_bump(uuid,text,text)', 'execute') as anon,
    has_function_privilege('authenticated', 'public.lead_form_bump(uuid,text,text)', 'execute') as auth,
    has_function_privilege('service_role', 'public.lead_form_bump(uuid,text,text)', 'execute') as svc`);
  ok(!priv[0].anon && !priv[0].auth && priv[0].svc, "only the service role may bump", JSON.stringify(priv[0]));

  // ── cascade ─────────────────────────────────────────────────────────────────────────────
  await db.exec(`insert into public.lead_form_submissions (client_id, form_id, answers) values ('example-builder', '${f.id}', '[]')`);
  await db.exec(`delete from public.lead_forms where id = '${f.id}'`);
  const left = await rows(db, `select (select count(*)::int from public.lead_form_submissions) as subs, (select count(*)::int from public.lead_form_daily_stats) as stats`);
  ok(left[0].subs === 0 && left[0].stats === 0, "deleting a form takes its submissions and counts (the tenant registry's cascade)", JSON.stringify(left[0]));

  // ── widened checks ──────────────────────────────────────────────────────────────────────
  ok(!(await refused(db, "insert into public.email_sends (client_id, kind) values ('example-builder', 'form_autoreply'), ('example-builder', 'form_notification'), ('example-builder', 'login_code')")), "email_sends takes the two form kinds and keeps the old ones");
  ok(await refused(db, "insert into public.email_sends (client_id, kind) values ('example-builder', 'blast')"), "email_sends still refuses an unknown kind");
  ok(!(await refused(db, "insert into public.crm_contacts (client_id, source) values ('example-builder', 'form'), ('example-builder', 'booking')")), "crm_contacts.source takes 'form' and keeps the old values");
  ok(!(await refused(db, "insert into public.crm_deals (client_id, source) values ('example-builder', 'form'), ('example-builder', 'design')")), "crm_deals.source takes 'form' and keeps the old values");
  ok(await refused(db, "insert into public.crm_deals (client_id, source) values ('example-builder', 'nope')"), "crm_deals.source still refuses an unknown value");
  ok(await refused(db, "insert into public.email_templates (client_id, name, purpose) values ('example-builder', 'X', 'blast')"), "email_templates.purpose is a closed list");

  // ── re-apply, rehearsal, CRLF ───────────────────────────────────────────────────────────
  try { await db.exec(M()); ok(true, "a re-apply runs"); } catch (e) { ok(false, "a re-apply runs", e.message); }
  const rehearse = await fresh();
  await rehearse.exec(M().replace(/^commit;$/m, "rollback;"));
  const gone = await rows(rehearse, "select to_regclass('public.lead_forms') is null as none");
  ok(gone[0].none, "the rehearsal (commit -> rollback) leaves nothing behind");
  const crlf = await fresh();
  try { await crlf.exec(RAW().replace(/\r?\n/g, "\r\n")); ok(true, "a CRLF checkout applies the same"); } catch (e) { ok(false, "a CRLF checkout applies the same", e.message); }

  await closeAll();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})();
