// Execute migration 261 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// email_sends, email_inbound and phone_realtime_notify as they are live, then check what it
// promises: three nullable columns with validated length checks, an email branch in the
// broadcast trigger that reaches the right topics (and nothing for mail with no contact), the
// texts and calls it already served unchanged, the stored bodies unreadable from the browser
// roles, a probe that leaves nothing behind, a re-apply that is harmless, and assertions and a
// probe that really abort a broken copy (mutants). Nothing here touches the live project: no
// network, no Supabase, no email sent.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration261.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/261_phone_email_thread.sql"), "utf8");

// phone_realtime_notify and its three triggers as they are live. The live body
// (pg_get_functiondef, 2026-10-03) is 254 PART 7's text exactly, so it is lifted from the file
// rather than copied a second time: from the create to the PART 8 rule.
function livePart7() {
  const s = fs.readFileSync(path.join(WT, "supabase/migrations/254_sss_phone.sql"), "utf8").replace(/\r\n/g, "\n");
  const a = s.indexOf("create or replace function public.phone_realtime_notify()");
  const b = s.indexOf("-- ═══", a);
  if (a < 0 || b < 0) throw new Error("could not lift 254 PART 7 — re-point livePart7()");
  return s.slice(a, b);
}

// realtime.send verbatim from the live project (as tests/sql/migration254.test.cjs has it), and
// the two functions 135's email_inbound policy needs. Run after STUBS: they read its tables.
const LIVE = `
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
 returns void language plpgsql as $function$
DECLARE
  generated_id uuid;
  final_payload jsonb;
BEGIN
  BEGIN
    generated_id := gen_random_uuid();
    IF payload ? 'id' THEN
      final_payload := payload;
    ELSE
      final_payload := jsonb_set(payload, '{id}', to_jsonb(generated_id));
    END IF;
    EXECUTE format('SET LOCAL realtime.topic TO %L', topic);
    INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
    VALUES (generated_id, final_payload, event, topic, private, 'broadcast');
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'WarnSendingBroadcastMessage: %', SQLERRM;
  END;
END;
$function$;

create or replace function auth.uid() returns uuid language sql stable as $function$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;

create or replace function public.current_client_id() returns text language sql stable security definer
 set search_path to '' as $function$
  select client_id from public.client_users where user_id = (select auth.uid())
$function$;

-- 135's policy, once current_client_id exists.
create policy email_inbound_owner_select on public.email_inbound
  for select to authenticated using (client_id = public.current_client_id());
`;

// The live shapes (information_schema / pg_constraint on 2026-10-03), cut to the columns 261 and
// the trigger touch. email_sends and email_inbound are whole: their column lists are the point.
const STUBS = (grantBrowser) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema realtime;
grant usage on schema public, auth, realtime to anon, authenticated, service_role;

-- The live default ACLs: the trap every new table and function falls into.
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant select, maintain on tables to anon;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table realtime.messages (
  topic text not null, extension text not null, payload jsonb, event text,
  private boolean default false, updated_at timestamp not null default now(),
  inserted_at timestamp not null default now(), id uuid not null default gen_random_uuid(),
  binary_payload bytea,
  primary key (id, inserted_at)
) partition by range (inserted_at);
alter table realtime.messages enable row level security;

create table public.client_users (user_id uuid primary key, client_id text not null);
create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(), business_name text,
  phone_status text not null default 'off',
  constraint client_settings_phone_status_chk check (phone_status = any (array['off','on']))
);
create table public.crm_contacts (
  id uuid primary key default gen_random_uuid(), client_id text not null, name text, email text, phone text,
  owner_user_id uuid, merged_into uuid references public.crm_contacts(id),
  source text not null default 'design',
  constraint crm_contacts_source_check check (source = any (array['design','captured_lead','manual','import','phone']))
);
create table public.designs (
  id uuid primary key default gen_random_uuid(), short_code text not null unique, client_id text not null,
  contact jsonb not null default '{}', contact_id uuid, bldg_w integer not null, bldg_h integer not null,
  status text not null default 'sent'
);

-- 107 + 113 + 124/134/167 (kind) + 134 (contact_id), RLS on, browser roles revoked.
create table public.email_sends (
  id uuid primary key default gen_random_uuid(), client_id text not null, short_code text,
  kind text not null, to_email text not null, intended_email text, from_email text not null, subject text,
  status text not null default 'claimed', error text, postmark_message_id text, delivered_at timestamptz,
  bounced_at timestamptz, bounce_reason text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), provider_message_id text, contact_id uuid,
  constraint email_sends_kind_check check (kind = any (array['estimate','invoice','test','acceptance','change_order','conversation','login_code'])),
  constraint email_sends_status_check check (status = any (array['claimed','sent','failed','delivered','bounced']))
);
alter table public.email_sends enable row level security;
revoke all on public.email_sends from anon, authenticated;
${grantBrowser ? "grant select on public.email_sends to anon;" : ""}

-- 135: RLS on, the tenant's own rows readable by authenticated.
create table public.email_inbound (
  id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid, short_code text,
  from_email text not null, from_name text, to_email text, subject text, body_text text, body_html text,
  message_id text, in_reply_to text, references_raw text, provider text not null default 'resend',
  spam_verdict text, received_at timestamptz not null default now(), created_at timestamptz not null default now()
);
alter table public.email_inbound enable row level security;
revoke all on public.email_inbound from anon, authenticated;
grant select on public.email_inbound to authenticated;

-- The three tables 254's triggers already serve, with the columns the function reads.
create table public.sms_messages (
  id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid, short_code text,
  direction text not null, from_number text, to_number text, body text, sent_by uuid, client_temp_id text,
  created_at timestamptz not null default now()
);
create table public.phone_calls (
  id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid, direction text not null,
  placed_by uuid, answered_by uuid, transferred_from uuid, rang_user_ids uuid[] not null default '{}',
  status text not null default 'ringing'
);
create table public.phone_voicemails (
  id uuid primary key default gen_random_uuid(), call_id uuid not null, client_id text not null
);
`;

// The live data the apply has to live with: rows written before 261 (52 live), a contact, a design.
const SEED = `
insert into public.client_settings (client_id, business_name, phone_status) values
  ('demo-tenant', 'Demo Sheds', 'on'), ('other-tenant', 'Other Sheds', 'on'), ('quiet-tenant', 'Quiet Sheds', 'off');
insert into public.client_users (user_id, client_id) values
  ('00000000-0000-4000-8000-000000000002', 'demo-tenant'), ('00000000-0000-4000-8000-000000000009', 'other-tenant');
insert into public.crm_contacts (id, client_id, name, email, owner_user_id) values
  ('00000000-0000-4000-8000-0000000000c1', 'demo-tenant', 'Cam Customer', 'cam@example.test', '00000000-0000-4000-8000-000000000001');
insert into public.designs (short_code, client_id, contact_id, bldg_w, bldg_h) values
  ('SS-DEMOQUOTE', 'demo-tenant', '00000000-0000-4000-8000-0000000000c1', 10, 12);
insert into public.email_sends (client_id, short_code, kind, to_email, from_email, subject, status)
  select 'demo-tenant', 'SS-DEMOQUOTE', 'estimate', 'cam@example.test', 'info@example.test', 'Quote ' || g, 'sent'
    from generate_series(1, 5) g;
insert into public.email_sends (client_id, contact_id, kind, to_email, from_email, subject, status) values
  ('demo-tenant', '00000000-0000-4000-8000-0000000000c1', 'conversation', 'cam@example.test', 'info@example.test', 'Old one', 'sent');
`;

const U = {
  owner: "00000000-0000-4000-8000-000000000001",
  rep: "00000000-0000-4000-8000-000000000002",
  outsider: "00000000-0000-4000-8000-000000000009",
};
const CONTACT = "00000000-0000-4000-8000-0000000000c1";
const T = "demo-tenant";

async function makeDb({ withPartition = true, grantBrowser = false } = {}) {
  const db = new PGlite();
  await db.exec(STUBS(grantBrowser));
  await db.exec(LIVE);
  await db.exec(livePart7());
  await db.exec(SEED);
  if (withPartition) {
    await db.exec(`do $$ begin execute format(
      'create table realtime.messages_probe partition of realtime.messages for values from (%L) to (%L)',
      current_date - 1, current_date + 2); end $$;`);
  }
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
const refused = async (db, sql, re, msg) => {
  try { await db.exec(sql); ok(false, msg, "no error"); } catch (e) { ok(re.test(e.message), `${msg} (${e.message.slice(0, 90)})`, e.message); }
  try { await db.exec("reset role"); } catch (_e) { /* not in a role */ }
};
const leftovers = async (db) => one(db, `select
  (select count(*)::int from public.email_sends where client_id like 'phone-email-probe-261%') s,
  (select count(*)::int from public.email_inbound where client_id like 'phone-email-probe-261%') i,
  (select count(*)::int from public.client_settings where client_id like 'phone-email-probe-261%') cs,
  (select count(*)::int from public.crm_contacts where client_id like 'phone-email-probe-261%') c,
  (select count(*)::int from public.designs where short_code like 'SS-PROBE261%') d,
  (select count(*)::int from realtime.messages) m`);

(async () => {
  // ── 1. Live as it is: Realtime has today's partition ─────────────────────────────────
  console.log("migration 261: applies on the live shape (realtime has a partition)");
  const db = await makeDb();
  let notices = [];
  try { notices = await apply(db); ok(true, "261 applied cleanly, assertions and probe included"); }
  catch (e) { ok(false, "261 applied", e.message); process.exit(1); }
  ok(notices.some((n) => /261 probe: emails reach the team/.test(n)), "the probe ran its broadcast checks", notices.join(" | "));
  ok(notices.some((n) => /nothing was kept/.test(n)), "the probe rolled back");
  ok(!notices.some((n) => /WarnSendingBroadcastMessage|phone_realtime_notify\(/.test(n)), "no send failed and the trigger raised no warning", notices.join(" | "));
  const left = await leftovers(db);
  ok(Object.values(left).every((v) => v === 0), "the probe left nothing behind, realtime.messages included", JSON.stringify(left));

  const cols = (await db.query(`select column_name, data_type, is_nullable, column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'email_sends' and column_name in ('body_text','sent_by','client_temp_id')
    order by column_name`)).rows;
  ok(cols.length === 3 && cols.every((c) => c.is_nullable === "YES" && c.column_default === null), "three nullable columns, no defaults", JSON.stringify(cols));
  ok(cols.find((c) => c.column_name === "sent_by")?.data_type === "uuid", "sent_by is a uuid");
  const pre = await one(db, "select count(*)::int n, bool_and(body_text is null and sent_by is null and client_temp_id is null) untouched from public.email_sends");
  ok(pre.n === 6 && pre.untouched, "the six rows from before 261 are still there, untouched", JSON.stringify(pre));
  const chk = (await db.query(`select conname, convalidated from pg_constraint where conrelid = 'public.email_sends'::regclass
    and conname in ('email_sends_body_text_chk','email_sends_client_temp_id_chk') order by 1`)).rows;
  ok(chk.length === 2 && chk.every((c) => c.convalidated), "both length checks exist and are validated", JSON.stringify(chk));

  let again = true;
  try { await apply(db); } catch (e) { again = false; ok(false, "re-apply", e.message); }
  ok(again, "a second apply is harmless");
  ok((await one(db, "select count(*)::int n from pg_constraint where conrelid = 'public.email_sends'::regclass and conname like 'email_sends_%_chk'")).n === 2,
    "the re-apply added no second copy of either check");

  console.log(" what sendTenantEmail writes, as the service role");
  const topics = async (id) => (await db.query(
    "select topic, event, payload, private from realtime.messages where payload ->> 'id' = $1 order by topic, payload ->> 'op'", [id])).rows;
  const set = (rs) => [...new Set(rs.map((r) => r.topic))].sort().join(" ");
  // Every write in this section as service_role, the role the edge functions use; every read of
  // realtime.messages as the owner, the way 254's test reads it.
  const svc = async (sql) => {
    await db.exec("set role service_role");
    try { return (await db.query(sql)).rows[0]; } finally { await db.exec("reset role"); }
  };
  // The claim insert crm_send_email now makes: contact, words, writer, bubble id.
  const sendId = (await svc(`insert into public.email_sends (client_id, contact_id, kind, to_email, from_email, subject, status,
      body_text, sent_by, client_temp_id)
    values ('${T}', '${CONTACT}', 'conversation', 'cam@example.test', 'info@example.test', 'Your shed', 'claimed',
      'Hi Cam, the 12x24 is ready.', '${U.rep}', 'tmp-abc_123') returning id`)).id;
  let rows = await topics(sendId);
  ok(set(rows) === [`phone:${T}`, `phone:user:${U.owner}`, `phone:user:${U.rep}`].sort().join(" "),
    "a conversation email reaches the team, the contact's owner and the writer", set(rows));
  ok(rows.length === 3 && rows.every((r) => r.event === "email" && r.private && Object.keys(r.payload).sort().join() === "contact_id,id,op,table"
    && r.payload.table === "email_sends" && r.payload.op === "INSERT" && r.payload.contact_id === CONTACT),
    "ids only, event 'email', private, the contact in the payload", JSON.stringify(rows[0]?.payload));
  await svc(`update public.email_sends set status = 'sent', provider_message_id = 'rs-1' where id = '${sendId}'`);
  rows = (await topics(sendId)).filter((r) => r.payload.op === "UPDATE");
  ok(rows.length === 3, "claimed → sent tells the same three again (op UPDATE)", String(rows.length));

  const quoteId = (await svc(`insert into public.email_sends (client_id, short_code, kind, to_email, from_email, subject)
    values ('${T}', 'SS-DEMOQUOTE', 'estimate', 'cam@example.test', 'info@example.test', 'Quote') returning id`)).id;
  rows = await topics(quoteId);
  ok(set(rows) === [`phone:${T}`, `phone:user:${U.owner}`].sort().join(" ") && rows.every((r) => r.payload.contact_id === CONTACT),
    "a quote email (short_code only) finds its design's contact", JSON.stringify(rows.map((r) => [r.topic, r.payload.contact_id])));

  const replyId = (await svc(`insert into public.email_inbound (client_id, contact_id, from_email, subject, body_text)
    values ('${T}', '${CONTACT}', 'cam@example.test', 'Re: Your shed', 'Sounds good') returning id`)).id;
  rows = await topics(replyId);
  ok(set(rows) === [`phone:${T}`, `phone:user:${U.owner}`].sort().join(" ") && rows.every((r) => r.payload.table === "email_inbound" && r.event === "email"),
    "a reply on the contact reaches the team and the contact's owner", set(rows));

  const quiet = [];
  quiet.push((await svc(`insert into public.email_sends (client_id, kind, to_email, from_email, subject)
    values ('${T}', 'test', 'someone@example.test', 'info@example.test', 'Test') returning id`)).id);
  quiet.push((await svc(`insert into public.email_inbound (client_id, from_email, subject)
    values ('${T}', 'stranger@example.test', 'Who is this') returning id`)).id);
  quiet.push((await svc(`insert into public.email_sends (client_id, contact_id, kind, to_email, from_email)
    values ('${T}', '${CONTACT}', 'login_code', 'cam@example.test', 'info@example.test') returning id`)).id);
  quiet.push((await svc(`insert into public.email_inbound (client_id, contact_id, from_email)
    values ('__unattributed__', '${CONTACT}', 'cam@example.test') returning id`)).id);
  quiet.push((await svc(`insert into public.email_inbound (client_id, contact_id, from_email)
    values ('quiet-tenant', '${CONTACT}', 'cam@example.test') returning id`)).id);
  // Another tenant naming this tenant's design: the design lookup is tenant-scoped.
  quiet.push((await svc(`insert into public.email_sends (client_id, short_code, kind, to_email, from_email)
    values ('other-tenant', 'SS-DEMOQUOTE', 'estimate', 'x@example.test', 'info@example.test') returning id`)).id);
  const loud = (await db.query("select payload ->> 'id' id from realtime.messages where payload ->> 'id' = any($1::text[])", [quiet])).rows;
  ok(loud.length === 0, "nothing for: a test to a stranger, an unmatched reply, a sign-in code, unattributed mail, a tenant switched off, another tenant's design", JSON.stringify(loud));
  // ...and every one of those writes landed.
  ok((await one(db, "select (select count(*) from public.email_sends where id = any($1::uuid[])) + (select count(*) from public.email_inbound where id = any($1::uuid[])) n", [quiet])).n == quiet.length,
    "every quiet write still landed");

  const alienId = (await svc(`insert into public.email_sends (client_id, contact_id, kind, to_email, from_email)
    values ('other-tenant', '${CONTACT}', 'conversation', 'x@example.test', 'info@example.test') returning id`)).id;
  rows = await topics(alienId);
  ok(set(rows) === "phone:other-tenant", "a contact id from another tenant tells that team only, never the contact's owner", set(rows));

  console.log(" the texts and calls the function already served");
  const smsId = (await svc(`insert into public.sms_messages (client_id, contact_id, direction, from_number, to_number, body, sent_by)
    values ('${T}', '${CONTACT}', 'out', '+15555550100', '+15555550142', 'hi', '${U.rep}') returning id`)).id;
  rows = await topics(smsId);
  ok(set(rows) === [`phone:${T}`, `phone:user:${U.owner}`, `phone:user:${U.rep}`].sort().join(" ") && rows.every((r) => r.event === "sms" && r.payload.table === "sms_messages"),
    "a text still reaches the team, the owner and its sender as 'sms'", set(rows));
  const callId = (await svc(`insert into public.phone_calls (client_id, contact_id, direction, answered_by, rang_user_ids)
    values ('${T}', '${CONTACT}', 'in', '${U.rep}', array['${U.outsider}']::uuid[]) returning id`)).id;
  rows = await topics(callId);
  ok(rows.length === 4 && rows.every((r) => r.event === "call"), "a call still reaches the team, who answered, who it rang and the owner", set(rows));

  console.log(" the checks");
  await refused(db, `insert into public.email_sends (client_id, kind, to_email, from_email, body_text) values ('${T}','test','a@example.test','b@example.test', repeat('b', 20001))`,
    /email_sends_body_text_chk/, "a 20,001-character body is refused");
  await refused(db, `insert into public.email_sends (client_id, kind, to_email, from_email, client_temp_id) values ('${T}','test','a@example.test','b@example.test', repeat('t', 65))`,
    /email_sends_client_temp_id_chk/, "a 65-character client_temp_id is refused");
  await db.exec(`insert into public.email_sends (client_id, kind, to_email, from_email, body_text, client_temp_id)
    values ('${T}','test','a@example.test','b@example.test', repeat('é', 20000), repeat('t', 64))`);
  ok(true, "20,000 two-byte characters and a 64-character id fit");

  console.log(" grants");
  const priv = await one(db, `select
    has_table_privilege('anon','public.email_sends','SELECT') a, has_table_privilege('authenticated','public.email_sends','SELECT') u,
    has_column_privilege('authenticated','public.email_sends','body_text','SELECT') ub,
    has_function_privilege('authenticated','public.phone_realtime_notify()','EXECUTE') fx,
    has_table_privilege('authenticated','public.email_inbound','SELECT') ui`);
  ok(!priv.a && !priv.u && !priv.ub, "the browser roles hold nothing on email_sends, the new bodies included", JSON.stringify(priv));
  ok(!priv.fx, "the trigger function is nobody's to call");
  ok(priv.ui, "135's authenticated read of email_inbound is untouched");
  await refused(db, "set role authenticated; select body_text from public.email_sends limit 1", /permission denied/, "authenticated cannot read a stored email body");
  await db.close();

  // ── 2. No partition: the probe says so and still passes ─────────────────────────────
  console.log("migration 261: realtime.messages has no partition for today");
  {
    const db2 = await makeDb({ withPartition: false });
    let n2 = [];
    try { n2 = await apply(db2); ok(true, "applied"); } catch (e) { ok(false, "applied without a partition", e.message); }
    ok(n2.some((n) => /broadcast checks were skipped/.test(n)), "the probe said it skipped the broadcast checks", n2.join(" | "));
    ok(n2.some((n) => /nothing was kept/.test(n)), "and still checked the limits and rolled back");
    await db2.exec(`insert into public.email_inbound (client_id, contact_id, from_email) values ('${T}', '${CONTACT}', 'cam@example.test')`);
    ok((await one(db2, "select count(*)::int n from public.email_inbound")).n === 1, "a reply is stored even though its broadcast cannot land");
    await db2.close();
  }

  // ── 3. The assertions abort the whole migration ─────────────────────────────────────
  console.log("migration 261: the assertions abort the whole migration");
  {
    const db3 = await makeDb({ grantBrowser: true });
    let err = null;
    try { await apply(db3); } catch (e) { err = e; }
    ok(!!err && /261: anon holds SELECT on email_sends/.test(err.message), "a browser-readable email_sends stops the apply", err && err.message);
    try { await db3.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const n = await one(db3, `select count(*)::int n from information_schema.columns where table_schema = 'public'
      and table_name = 'email_sends' and column_name = 'body_text'`);
    ok(n.n === 0, "and nothing of it is left behind", JSON.stringify(n));
    await db3.close();
  }

  // ── 4. Mutants: each broken copy must be refused by an assertion or the probe ─────────
  console.log("migration 261: broken copies are refused");
  const src = MIG_TEXT().replace(/\r\n/g, "\n");
  const mutants = [
    ["the email branch never runs", "elsif tg_table_name in ('email_sends', 'email_inbound') then",
      "elsif tg_table_name in ('email_sends', 'email_inbound') and false then"],
    ["no design fallback", "if v_row ->> 'contact_id' is null and v_row ->> 'short_code' is not null then", "if false then"],
    ["the design lookup is not tenant-scoped", "where d.client_id = v_client_id\n           and d.short_code", "where d.short_code"],
    ["mail with no contact is broadcast", "if v_contact is null or jsonb_typeof(v_contact) = 'null' then\n        return null;",
      "if false then\n        return null;"],
    ["sign-in codes are broadcast", "if v_row ->> 'kind' = 'login_code' then", "if false then"],
    ["the sender is not told", "(v_snap ->> 'sent_by')::uuid\n", "null::uuid\n"],
    ["body limit off by one", "char_length(body_text) <= 20000", "char_length(body_text) <= 20001"],
    ["client_temp_id unlimited", "char_length(client_temp_id) <= 64", "char_length(client_temp_id) <= 6400"],
    ["the checks left NOT VALID", "alter table public.email_sends validate constraint email_sends_body_text_chk;\n", ""],
    ["email_inbound fires on update too", "after insert on public.email_inbound", "after insert or update on public.email_inbound"],
    ["email_sends misses the update", "after insert or update on public.email_sends", "after insert on public.email_sends"],
    ["the function is callable from the browser", "revoke execute on function public.phone_realtime_notify() from public, anon, authenticated;",
      "grant execute on function public.phone_realtime_notify() to authenticated;"],
  ];
  for (const [label, from, to] of mutants) {
    if (!src.includes(from)) { ok(false, `mutant "${label}": anchor not found — re-point it`); continue; }
    const mdb = await makeDb();
    let err = null;
    try { await apply(mdb, src.replace(from, to)); } catch (e) { err = e; }
    ok(!!err && /261/.test(err.message), `refused: ${label}`, err ? err.message.slice(0, 160) : "applied cleanly");
    await mdb.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
