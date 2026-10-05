// Execute migration 267 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// email_inbound, client_settings, pg_net's queue and Vault as they are live, then check what it
// promises: a new customer email filed on a contact or a design, at a business whose phone is on,
// queues exactly one ids-only request to /push/email with the secret header; nothing else does;
// the email is stored whatever happens to the alert; the function is nobody's to call; a re-apply
// is harmless; the probe leaves nothing behind; and broken copies are refused (mutants). Nothing
// here touches the live project: no network, no Supabase, no push sent.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration267.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/267_phone_push_email.sql"), "utf8");

const SECRET = "test-push-secret-267";
const URL_EMAIL = "https://phone.structurestudiosuite.com/push/email";

// pg_net 0.20.0's net.http_post as it is live (pg_proc.prosrc, 2026-10-05), with the two parts
// PGlite cannot run left out: the params url-encoding (we send none) and net.wake() (it signals
// the background worker; there is none here). The content-type rule and the queue insert are the
// live text. The queue table has the live columns.
const NET = (failing) => `
create schema net;
create table net.http_request_queue (
  id bigserial primary key, method text not null, url text not null, headers jsonb,
  body bytea, timeout_milliseconds integer not null
);
create or replace function net.http_post(
  url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000
) returns bigint language plpgsql as $function$
declare
    request_id bigint;
    content_type text;
begin
    ${failing ? "raise exception 'pg_net is down (test)';" : ""}
    select header_value into content_type
      from jsonb_each_text(coalesce(headers, '{}'::jsonb)) r(header_name, header_value)
     where lower(header_name) = 'content-type'
     limit 1;
    if content_type is null then
        select headers || '{"Content-Type": "application/json"}'::jsonb into headers;
    end if;
    if content_type <> 'application/json' then
        raise exception 'Content-Type header must be "application/json"';
    end if;
    insert into net.http_request_queue(method, url, headers, body, timeout_milliseconds)
    values ('POST', url, headers, convert_to(body::text, 'UTF8'), timeout_milliseconds)
    returning id into request_id;
    return request_id;
end
$function$;
`;

// The live shapes (information_schema, 2026-10-05), cut to what 267 touches. email_inbound is
// whole: what the trigger must NOT post is the point.
const STUBS = ({ secret = true, pgNet = true, failingNet = false } = {}) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema extensions;
create schema vault;
grant usage on schema public to anon, authenticated, service_role;

-- The live default ACLs: every new function is executable by the browser roles until revoked.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, secret text);
create view vault.decrypted_secrets as select id, name, secret, secret as decrypted_secret from vault.secrets;
${secret ? `insert into vault.secrets (name, secret) values ('sss_phone_push_secret', '${SECRET}');` : ""}
${pgNet ? NET(failingNet) : ""}

create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(), business_name text,
  phone_status text not null default 'off',
  constraint client_settings_phone_status_chk check (phone_status = any (array['off','on']))
);

-- 135: RLS on, the tenant's own rows readable by authenticated; the edge function writes as service_role.
create table public.email_inbound (
  id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid, short_code text,
  from_email text not null, from_name text, to_email text, subject text, body_text text, body_html text,
  message_id text, in_reply_to text, references_raw text, provider text not null default 'resend',
  spam_verdict text, received_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create unique index email_inbound_message_uniq on public.email_inbound (client_id, message_id)
  where message_id is not null and message_id <> '';
alter table public.email_inbound enable row level security;
revoke all on public.email_inbound from anon, authenticated;
grant select, insert, update on public.email_inbound to service_role;

insert into public.client_settings (client_id, business_name, phone_status) values
  ('demo-tenant', 'Demo Sheds', 'on'), ('quiet-tenant', 'Quiet Sheds', 'off');
`;

const CONTACT = "00000000-0000-4000-8000-0000000000c1";
const T = "demo-tenant";

async function makeDb(opts) {
  const db = new PGlite();
  await db.exec(STUBS(opts));
  return db;
}

async function apply(db, sql = MIG_TEXT()) {
  const notices = [];
  await db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
  return notices;
}

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const queued = async (db) => (await db.query(
  `select id, method, url, headers, timeout_milliseconds, convert_from(body, 'UTF8')::jsonb as body
     from net.http_request_queue order by id`)).rows;
const leftovers = async (db) => one(db, `select
  (select count(*)::int from public.client_settings where client_id like 'phone-push-email-probe-267%') cs,
  (select count(*)::int from public.email_inbound) e,
  (select count(*)::int from net.http_request_queue) q`);

// Writes as the service role, the role email-inbound uses; reads as the owner.
async function svc(db, sql, notices) {
  await db.exec("set role service_role");
  try {
    return (await db.query(sql, [], notices ? { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) } : undefined)).rows[0];
  } finally {
    await db.exec("reset role");
  }
}

(async () => {
  // ── 1. Live as it is: pg_net, the Vault secret, a business with the phone on ───────────
  console.log("migration 267: applies on the live shape (secret in Vault)");
  const db = await makeDb();
  let notices = [];
  try { notices = await apply(db); ok(true, "267 applied cleanly, assertions and probe included"); }
  catch (e) { ok(false, "267 applied", e.message); process.exit(1); }
  ok(notices.some((n) => /267 probe: mail on a contact and mail on a design each posted one ids-only request/.test(n)),
    "the probe ran its checks on what was posted", notices.join(" | "));
  ok(!notices.some((n) => /phone_push_email_notify:/.test(n)), "the trigger raised no warning during the probe", notices.join(" | "));
  let left = await leftovers(db);
  ok(Object.values(left).every((v) => v === 0), "the probe left nothing behind: no businesses, no emails, no queued requests", JSON.stringify(left));

  const fn = await one(db, `select p.prosecdef, p.proconfig from pg_proc p where p.oid = 'public.phone_push_email_notify()'::regprocedure`);
  ok(fn.prosecdef, "the function is SECURITY DEFINER (it reads Vault)");
  ok(fn.proconfig.includes("lock_timeout=1s") && fn.proconfig.includes("search_path=public, extensions, pg_temp"),
    "it carries 256's 1 s lock_timeout and search_path", JSON.stringify(fn.proconfig));
  const priv = await one(db, `select has_function_privilege('anon','public.phone_push_email_notify()','EXECUTE') a,
    has_function_privilege('authenticated','public.phone_push_email_notify()','EXECUTE') u`);
  ok(!priv.a && !priv.u, "nobody in the browser can call it", JSON.stringify(priv));
  const trg = (await db.query(`select tgname, tgtype, tgenabled from pg_trigger
    where tgrelid = 'public.email_inbound'::regclass and not tgisinternal`)).rows;
  ok(trg.length === 1 && trg[0].tgname === "phone_push_email" && trg[0].tgtype === 5 && trg[0].tgenabled === "O",
    "one trigger, AFTER INSERT FOR EACH ROW, enabled", JSON.stringify(trg));

  console.log(" what email-inbound writes, as the service role");
  // A reply on a contact: everything 135 stores, the words included.
  const replyId = (await svc(db, `insert into public.email_inbound
      (client_id, contact_id, from_email, from_name, to_email, subject, body_text, body_html, message_id, spam_verdict)
    values ('${T}', '${CONTACT}', 'cam@example.test', 'Cam Customer', 'reply@example.test', 'Re: Your 12x24 quote',
      'Can we move delivery to Friday?', '<p>Can we move delivery to Friday?</p>', '<m1@example.test>',
      'spam=PASS virus=PASS spf=pass dkim=pass dmarc=pass') returning id`)).id;
  let q = await queued(db);
  ok(q.length === 1, "a reply on a contact queues one request", String(q.length));
  const r = q[0] || {};
  ok(r.method === "POST" && r.url === URL_EMAIL && r.timeout_milliseconds === 5000, "POST to /push/email, 5 s", JSON.stringify([r.method, r.url, r.timeout_milliseconds]));
  ok(JSON.stringify(Object.keys(r.headers || {}).sort()) === JSON.stringify(["content-type", "x-push-secret"])
    && r.headers["content-type"] === "application/json" && r.headers["x-push-secret"] === SECRET,
    "the headers are the JSON content type and Vault's secret, nothing else");
  ok(!!r.body && JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(["record", "schema", "table", "type"])
    && JSON.stringify(Object.keys(r.body.record).sort()) === JSON.stringify(["client_id", "id"])
    && r.body.record.id === replyId && r.body.record.client_id === T
    && r.body.type === "INSERT" && r.body.table === "email_inbound" && r.body.schema === "public",
    "the body is {type, table, schema, record:{id, client_id}}: ids only", JSON.stringify(r.body));
  const raw = (await one(db, "select string_agg(convert_from(body, 'UTF8'), ' ') s from net.http_request_queue")).s || "";
  ok(!/Friday|12x24|Cam Customer|cam@example\.test|example\.test|PASS|m1@/.test(raw), "no subject, words, sender, address, verdict or message id is queued", raw);

  // A reply found by its quote's code alone.
  const codeId = (await svc(db, `insert into public.email_inbound (client_id, short_code, from_email, subject)
    values ('${T}', 'SS-DEMOQUOTE', 'cam@example.test', 'Re: Quote') returning id`)).id;
  q = await queued(db);
  ok(q.length === 2 && q[1].body.record.id === codeId, "a reply filed only on a design queues one too (the Worker finds its contact)");

  // The provider retrying the same message: the unique index refuses it, so nothing fires twice.
  let dup = null;
  try { await svc(db, `insert into public.email_inbound (client_id, contact_id, from_email, message_id)
    values ('${T}', '${CONTACT}', 'cam@example.test', '<m1@example.test>') returning id`); } catch (e) { dup = e; }
  ok(!!dup && /email_inbound_message_uniq|duplicate key/.test(dup.message), "a provider retry is refused by 135's unique index", dup && dup.message);
  ok((await queued(db)).length === 2, "and queues no second alert");

  // Quiet: filed on nobody, phone off, unattributed (even if that sentinel had the phone on).
  await db.exec(`insert into public.client_settings (client_id, phone_status) values ('__unattributed__', 'on')`);
  const quiet = [];
  quiet.push((await svc(db, `insert into public.email_inbound (client_id, from_email, subject)
    values ('${T}', 'stranger@example.test', 'Who is this') returning id`)).id);
  quiet.push((await svc(db, `insert into public.email_inbound (client_id, contact_id, from_email)
    values ('quiet-tenant', '${CONTACT}', 'cam@example.test') returning id`)).id);
  quiet.push((await svc(db, `insert into public.email_inbound (client_id, contact_id, from_email)
    values ('__unattributed__', '${CONTACT}', 'cam@example.test') returning id`)).id);
  quiet.push((await svc(db, `insert into public.email_inbound (client_id, contact_id, from_email)
    values ('no-settings-tenant', '${CONTACT}', 'cam@example.test') returning id`)).id);
  ok((await queued(db)).length === 2, "nothing for: mail filed on nobody, a business with the phone off, unattributed mail, a business with no settings row");
  ok((await one(db, "select count(*)::int n from public.email_inbound where id = any($1::uuid[])", [quiet])).n === quiet.length, "and every one of those emails was stored");

  await svc(db, `update public.email_inbound set contact_id = '${CONTACT}' where id = '${quiet[0]}'`);
  ok((await queued(db)).length === 2, "an UPDATE (a merge re-pointing a reply) alerts nobody: INSERT only");

  let again = true;
  try { await apply(db); } catch (e) { again = false; ok(false, "re-apply", e.message); }
  ok(again, "a second apply is harmless");
  ok((await one(db, `select count(*)::int n from pg_trigger where tgrelid = 'public.email_inbound'::regclass and not tgisinternal`)).n === 1,
    "and leaves one trigger, not two");
  await db.close();

  // ── 2. No secret in Vault yet: the probe says so, and nothing is posted ──────────────
  console.log("migration 267: Vault has no sss_phone_push_secret");
  {
    const db2 = await makeDb({ secret: false });
    let n2 = [];
    try { n2 = await apply(db2); ok(true, "applied"); } catch (e) { ok(false, "applied without the secret", e.message); }
    ok(n2.some((n) => /Vault has no sss_phone_push_secret/.test(n)), "the probe said the posting checks were skipped", n2.join(" | "));
    await svc(db2, `insert into public.email_inbound (client_id, contact_id, from_email) values ('${T}', '${CONTACT}', 'cam@example.test')`);
    ok((await queued(db2)).length === 0, "a reply is stored and nothing is posted");
    ok((await one(db2, "select count(*)::int n from public.email_inbound")).n === 1, "the reply is there");
    await db2.close();
  }

  // ── 3. pg_net failing: the email is stored anyway, with a WARNING ────────────────────
  console.log("migration 267: net.http_post raising");
  {
    const db3 = await makeDb();
    await apply(db3);
    await db3.exec(NET(true).replace("create schema net;", "").replace(/create table net\.http_request_queue[\s\S]*?\);\n/, ""));
    const n3 = [];
    let stored = true;
    try {
      await svc(db3, `insert into public.email_inbound (client_id, contact_id, from_email, subject)
        values ('${T}', '${CONTACT}', 'cam@example.test', 'Re: shed') returning id`, n3);
    } catch (e) { stored = false; ok(false, "the insert survived a failing pg_net", e.message); }
    ok(stored && (await one(db3, "select count(*)::int n from public.email_inbound")).n === 1, "the customer's email is stored");
    ok(n3.some((n) => /^WARNING: phone_push_email_notify: pg_net is down/.test(n)), "and the failure is a WARNING, not an error", n3.join(" | "));
    await db3.close();
  }

  // ── 4. No pg_net at all (256 not applied): refused, nothing left ─────────────────────
  console.log("migration 267: pg_net missing");
  {
    const db4 = await makeDb({ pgNet: false });
    let err = null;
    try { await apply(db4); } catch (e) { err = e; }
    ok(!!err && /267: net\.http_post is missing/.test(err.message), "the apply stops and says to apply 256 first", err && err.message);
    try { await db4.exec("rollback"); } catch (_e) { /* already rolled back */ }
    ok(!(await one(db4, "select to_regprocedure('public.phone_push_email_notify()') is not null f")).f, "and nothing of it is left behind");
    await svc(db4, `insert into public.email_inbound (client_id, contact_id, from_email) values ('${T}', '${CONTACT}', 'cam@example.test')`);
    ok(true, "email still stores without it");
    await db4.close();
  }

  // ── 5. Mutants: each broken copy must be refused by an assertion or the probe ─────────
  console.log("migration 267: broken copies are refused");
  const src = MIG_TEXT().replace(/\r\n/g, "\n");
  const mutants = [
    ["posts the whole row", "'record', jsonb_build_object('id', new.id, 'client_id', new.client_id)", "'record', to_jsonb(new)"],
    ["posts the subject", "jsonb_build_object('id', new.id, 'client_id', new.client_id)", "jsonb_build_object('id', new.id, 'client_id', new.client_id, 'subject', new.subject)"],
    ["posts the sender", "jsonb_build_object('id', new.id, 'client_id', new.client_id)", "jsonb_build_object('id', new.id, 'client_id', new.client_id, 'f', new.from_email)"],
    ["posts no client_id", "jsonb_build_object('id', new.id, 'client_id', new.client_id)", "jsonb_build_object('id', new.id)"],
    ["unattributed mail not skipped", "if new.client_id = '__unattributed__' then", "if false then"],
    ["mail on nobody posted", "if new.contact_id is null and new.short_code is null then", "if false then"],
    ["mail on a design dropped", "if new.contact_id is null and new.short_code is null then", "if new.contact_id is null then"],
    ["phone switch ignored", "where cs.client_id = new.client_id and cs.phone_status = 'on'", "where cs.client_id = new.client_id"],
    ["posted to the text route", "url := 'https://phone.structurestudiosuite.com/push/email'", "url := 'https://phone.structurestudiosuite.com/push/text'"],
    ["no secret header", "'x-push-secret', v_secret", "'x-push-secret-missing', v_secret"],
    ["fires on update too", "after insert on public.email_inbound", "after insert or update on public.email_inbound"],
    ["fires before the insert", "after insert on public.email_inbound", "before insert on public.email_inbound"],
    ["no 1 s lock_timeout", "set search_path = public, extensions, pg_temp\nset lock_timeout = '1s'\n", "set search_path = public, extensions, pg_temp\n"],
    ["not a definer", "language plpgsql\nsecurity definer\n", "language plpgsql\nsecurity invoker\n"],
    ["callable from the browser", "revoke all on function public.phone_push_email_notify() from public, anon, authenticated;",
      "grant execute on function public.phone_push_email_notify() to authenticated;"],
    ["a second trigger", "-- PART 3 — apply-time assertions.",
      "create trigger phone_push_email_twice after insert on public.email_inbound for each row execute function public.phone_push_email_notify();\n-- PART 3 — apply-time assertions."],
  ];
  for (const [label, from, to] of mutants) {
    if (!src.includes(from)) { ok(false, `mutant "${label}": anchor not found — re-point it`); continue; }
    const mdb = await makeDb();
    let err = null;
    try { await apply(mdb, src.replace(from, to)); } catch (e) { err = e; }
    ok(!!err && /267/.test(err.message), `refused: ${label}`, err ? err.message.slice(0, 160) : "applied cleanly");
    await mdb.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
