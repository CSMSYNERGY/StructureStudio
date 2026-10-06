// Execute migration 254 for real in PGlite (Postgres compiled to WASM) against stubs of the
// live schema, then drive the RPCs, the broadcast triggers and the realtime.messages policies
// as the roles Supabase uses. Nothing here touches the live project: there is no network, no
// Supabase and no Twilio, only an in-memory Postgres that exits with the process.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once; @electric-sql/pglite only, kept out of the root
//                                         package.json so the deploy and preflight's own
//                                         install stay as they are
//   node tests/sql/migration254.test.cjs  both scenarios (no realtime partitions / a partition)
// Exit code 0 = ALL CHECKS PASSED. Environment knobs: APPLY_ONLY=1 (just apply), MIG_FILE=<path>
// (apply another copy of the migration, e.g. a deliberately broken one, to see a check fail).
//
// Moved here from a session scratchpad on 2026-09-29 (review SSB-10), so the migration's
// behaviour is checked from the repo rather than from one person's disk.
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8");

// The live bodies (pg_get_functiondef on 2026-09-29) of the functions 254 calls but does not
// define. realtime.send / realtime.topic / auth.uid / current_client_id verbatim.
const LIVE = `
create or replace function auth.uid() returns uuid language sql stable as $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

create or replace function realtime.topic() returns text language sql stable as $function$
select nullif(current_setting('realtime.topic', true), '')::text;
$function$;

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

create or replace function public.current_client_id() returns text language sql stable security definer
 set search_path to '' as $function$
  select client_id from public.client_users where user_id = (select auth.uid())
$function$;
`;

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema realtime;
grant usage on schema public, auth, realtime to anon, authenticated, service_role;

-- The live default ACLs for role postgres in schema public (pg_default_acl, 2026-09-29):
-- tables to anon (SELECT, MAINTAIN), authenticated and service_role (all); functions and
-- sequences to all three. This is the trap 254 revokes against, reproduced.
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant select, maintain on tables to anon;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant usage, select, update on sequences to anon, authenticated, service_role;

create table realtime.messages (
  topic text not null, extension text not null, payload jsonb, event text,
  private boolean default false, updated_at timestamp not null default now(),
  inserted_at timestamp not null default now(), id uuid not null default gen_random_uuid(),
  binary_payload bytea,
  primary key (id, inserted_at)
) partition by range (inserted_at);
alter table realtime.messages enable row level security;
grant select, insert, update on realtime.messages to anon, authenticated, service_role;

-- ── stubs of the live public tables 254 touches, with the live column lists ──
create or replace function public.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(),
  business_name text, sms_number text, sms_status text not null default 'off'
);
create table public.client_users (
  user_id uuid primary key, client_id text not null, role text not null default 'owner',
  created_at timestamptz not null default now(), full_name text, phone text, title text,
  access jsonb, prefs jsonb, location_id uuid
);
-- crm_contacts with the live column list, 130's source CHECK and the two partial uniques
-- (information_schema / pg_constraint / pg_indexes on 2026-09-29).
create table public.crm_contacts (
  id uuid primary key default gen_random_uuid(), client_id text not null, name text, phone text,
  phone_digits text, email text, email_lower text, street text, city text, state text, zip text,
  owner_user_id uuid, labels text[] not null default '{}', merged_into uuid references public.crm_contacts(id),
  source text not null default 'design', first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  sms_opt_out_at timestamptz, billing_street text, billing_city text, billing_state text, billing_zip text,
  constraint crm_contacts_source_check check (source = any (array['design','captured_lead','manual','import']))
);
create unique index crm_contacts_tenant_phone on public.crm_contacts (client_id, phone_digits)
  where phone_digits is not null and phone_digits <> '' and merged_into is null;
create unique index crm_contacts_tenant_email on public.crm_contacts (client_id, email_lower)
  where (phone_digits is null or phone_digits = '') and email_lower is not null and email_lower <> '' and merged_into is null;

-- crm_phone_key, 132 verbatim.
create or replace function public.crm_phone_key(p_phone text)
returns text
language sql immutable
set search_path to ''
as $fn$
  select nullif(
    case
      when length(d) = 11 and left(d, 1) = '1' then right(d, 10)
      else d
    end, '')
  from (select regexp_replace(coalesce(p_phone, ''), '\\D', '', 'g') as d) s;
$fn$;

-- The other tables crm_merge_contacts (192) re-points: the columns it touches, live shapes for
-- the three child tables it treats specially.
create table public.designs        (id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid);
create table public.captured_leads (id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid);
create table public.crm_notes      (id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid);
create table public.crm_activities (id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid);
create table public.crm_files      (id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid);
create table public.email_inbound  (id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid);
create table public.email_sends    (id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid);
create table public.crm_contact_followers (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade, user_id uuid not null,
  added_at timestamptz not null default now(), added_reason text not null default 'manual',
  constraint crm_contact_followers_uniq unique (contact_id, user_id)
);
create table public.crm_contact_people (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade, ordinal integer not null default 1,
  name text, phone text, phone_digits text, email text, email_lower text, is_primary boolean not null default false,
  source text not null default 'design' check (source = any (array['design','captured_lead','manual','import','merge'])),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index crm_contact_people_phone_uniq on public.crm_contact_people (contact_id, phone_digits) where phone_digits is not null and phone_digits <> '';
create unique index crm_contact_people_email_uniq on public.crm_contact_people (contact_id, email_lower) where email_lower is not null and email_lower <> '';
-- Stand-in for the live crm_contact_people_stamp trigger: derive the two keys.
create or replace function public.crm_contact_people_stamp() returns trigger language plpgsql set search_path = '' as $$
begin new.phone_digits := public.crm_phone_key(new.phone); new.email_lower := nullif(lower(btrim(coalesce(new.email, ''))), ''); return new; end $$;
create trigger crm_contact_people_stamp before insert or update on public.crm_contact_people
  for each row execute function public.crm_contact_people_stamp();
create table public.crm_field_changes (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade, field text not null,
  old_value text, new_value text, changed_by uuid, created_at timestamptz not null default now()
);

-- auth.sessions and the two tables that cascade from it (live FKs, 2026-09-29).
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid, created_at timestamptz default now());
create table auth.refresh_tokens (id bigserial primary key, session_id uuid references auth.sessions(id) on delete cascade, token text);
create table auth.mfa_amr_claims (id uuid primary key default gen_random_uuid(), session_id uuid not null references auth.sessions(id) on delete cascade);
create table public.sms_numbers (
  id uuid primary key default gen_random_uuid(), client_id text not null, phone_number text not null,
  twilio_sid text, messaging_service_sid text,
  registration_status text not null default 'pending_registration',
  purchased_at timestamptz not null default now(), released_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index sms_numbers_live_unique on public.sms_numbers (phone_number) where released_at is null;
create table public.sms_messages (
  id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid, short_code text,
  direction text not null check (direction in ('out','in')), from_number text not null, to_number text not null,
  body text, status text not null default 'received', error_code text, provider text not null default 'twilio',
  provider_sid text, num_segments integer, sent_by uuid, delivered_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.sms_messages enable row level security;
create table public.usage_prices (
  kind text primary key, label text not null, unit_label text not null default 'generation',
  price_cents integer not null check (price_cents >= 0), active boolean not null default false,
  visible boolean not null default true, sort_order integer not null default 0, note text,
  updated_at timestamptz not null default now()
);
insert into public.usage_prices (kind, label, unit_label, price_cents, active, sort_order)
values ('sms_segment', 'Extra text segment', 'segment', 3, false, 22);

${LIVE}
`;

// current_area_level exactly as 154 defines it.
function currentAreaLevel() {
  const s = MIG("154_area_access_rls.sql");
  const a = s.indexOf("create or replace function public.current_area_level(p_area text)");
  const b = s.indexOf("$fn$;", a) + 5;
  return s.slice(a, b) + "\ngrant execute on function public.current_area_level(text) to authenticated, service_role;\n";
}

async function makeDb(withPartition) {
  const notices = [];
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(MIG("219_office_staff_designer.sql"));   // area_level_for as it is live today
  await db.exec(currentAreaLevel());
  if (withPartition) {
    await db.exec(`do $$ begin execute format(
      'create table realtime.messages_probe partition of realtime.messages for values from (%L) to (%L)',
      current_date - 1, current_date + 2); end $$;`);
  }
  return { db, notices };
}

async function apply(db, notices) {
  const res = await db.exec(process.env.MIG_FILE ? fs.readFileSync(process.env.MIG_FILE, "utf8") : MIG("254_sss_phone.sql"), {
    onNotice: (n) => notices.push(`${n.severity}: ${n.message}`),
  });
  return res;
}

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const expectError = async (db, sql, re, msg) => {
  try { await db.exec(sql); failures++; console.log("  FAIL " + msg + " (no error)"); }
  catch (e) { ok(re.test(e.message), `${msg} (${e.message.slice(0, 90)})`); }
};

(async () => {
  if (process.env.APPLY_ONLY) {
    const { db, notices } = await makeDb(process.env.APPLY_ONLY === "part");
    try { await apply(db, notices); console.log("APPLIED CLEANLY"); } catch (e) { console.log("APPLY FAILED: " + e.message); }
    process.exit(0);
  }
  // ── Scenario 1: live as it is today — realtime.messages has no partitions ─────────────
  console.log("scenario 1: no realtime partitions (the live project on 2026-09-29)");
  {
    const { db, notices } = await makeDb(false);
    await apply(db, notices);
    ok(notices.some((n) => /NO partitions yet/.test(n)), "probe reported the missing partitions");
    ok(notices.some((n) => /WarnSendingBroadcastMessage/.test(n)), "realtime.send dropped the sends with a WARNING");
    ok(notices.some((n) => /routing, identity, DND, busy, has_access and the 911 window behave/.test(n)), "probe passed and rolled back");
    ok(notices.some((n) => /a transferred call frees its placer; Save as contact re-links/.test(n)), "probe covered transfer-busy, Save as contact and the merge");
    const left = await one(db, `select (select count(*) from client_settings) cs, (select count(*) from sms_numbers) n, (select count(*) from phone_calls) c,
      (select count(*) from crm_contacts) k, (select count(*) from sms_messages) s, (select count(*) from crm_field_changes) f, (select count(*) from crm_contact_people) p`);
    ok([left.cs, left.n, left.c, left.k, left.s, left.f, left.p].every((v) => Number(v) === 0), "the probe left nothing behind", JSON.stringify(left));
    // A write with the switch on still succeeds while the send fails.
    await db.exec(`insert into client_settings (client_id, phone_status) values ('demo-tenant','on');
                   insert into phone_calls (client_id, direction, from_e164, to_e164) values ('demo-tenant','in','+15555550142','+15555550100');`);
    ok(Number((await one(db, "select count(*) c from phone_calls")).c) === 1, "a call row is written even though its broadcast cannot land");
    await db.close();
  }

  // ── Scenario 2: Realtime has created a partition ──────────────────────────────────────
  console.log("scenario 2: realtime.messages has a partition");
  const { db, notices } = await makeDb(true);
  await apply(db, notices);
  ok(notices.some((n) => /broadcasts landed on the team and user topics/.test(n)), "probe observed the broadcasts");
  ok(!notices.some((n) => /WarnSendingBroadcastMessage/.test(n)), "no send failed");
  ok(Number((await one(db, "select count(*) c from realtime.messages")).c) === 0, "the probe's broadcasts were rolled back");
  ok(notices.some((n) => /a transferred call frees its placer; Save as contact re-links/.test(n)), "probe covered transfer-busy, Save as contact and the merge");

  // A tenant, its team, another tenant.
  const T = "demo-tenant", X = "other-tenant";
  const U = {
    owner: "00000000-0000-4000-8000-000000000001", rep: "00000000-0000-4000-8000-000000000002",
    office: "00000000-0000-4000-8000-000000000003", driver: "00000000-0000-4000-8000-000000000004",
    stranger: "00000000-0000-4000-8000-000000000005", outsider: "00000000-0000-4000-8000-000000000006",
  };
  await db.exec(`
    insert into client_settings (client_id, business_name, sms_number, phone_status) values
      ('${T}', 'Demo Sheds', '+15555550100', 'on'), ('${X}', 'Other Sheds', null, 'on');
    insert into client_users (user_id, client_id, role, title, full_name, access) values
      ('${U.owner}',  '${T}', 'owner', 'owner',        'Olive Owner',  '{"phone":"none"}'),
      ('${U.rep}',    '${T}', 'user',  'sales_rep',    'Rita Rep',     null),
      ('${U.office}', '${T}', 'user',  'office_staff', 'Oscar Office', null),
      ('${U.driver}', '${T}', 'user',  'driver',       'Dora Driver',  null),
      ('${U.outsider}','${X}','user',  'office_staff', 'Otto Outside', null);
    insert into sms_numbers (client_id, phone_number, registration_status, purchased_at) values
      ('${T}', '+15555550100', 'registered', now() - interval '2 days'),
      ('${T}', '+15555550101', 'registered', now());
  `);
  const numId = (await one(db, "select id from sms_numbers where phone_number = '+15555550100'")).id;
  const contact = (await one(db, `insert into crm_contacts (client_id, name, owner_user_id) values ('${T}', 'Cam Customer', '${U.rep}') returning id`)).id;

  console.log(" RPCs");
  await db.exec(`insert into phone_routes (client_id, number_id, members, mode)
                 values ('${T}', '${numId}', array['${U.office}','${U.rep}','${U.driver}','${U.outsider}']::uuid[], 'in_order')`);
  const route = (await one(db, "select public.phone_route_for_number('+15555550100') r")).r;
  ok(route.client_id === T && route.number_id === numId && route.phone_status === "on", "route header");
  ok(route.route.mode === "in_order" && route.route.members.length === 4, "route row carried through");
  const byId = Object.fromEntries(route.members.map((m) => [m.user_id, m]));
  ok(route.members.map((m) => m.user_id).join() === [U.office, U.rep, U.driver, U.outsider].join(), "member order kept");
  ok(byId[U.office].has_access === true && byId[U.office].full_name === "Oscar Office", "office staff (view) has access, with a name");
  ok(byId[U.rep].has_access === true, "sales rep (own) has access");
  ok(byId[U.driver].has_access === false, "driver (none) does not");
  ok(byId[U.outsider].has_access === false && byId[U.outsider].full_name === null, "another tenant's user does not, and their name does not leak");
  ok(byId[U.rep].identity === "u_" + U.rep.replace(/-/g, "") + "_g1", "identity uses generation 1 by default");
  ok(/^u_([0-9a-f]{32})_g(\d+)(_dev)?$/.test(byId[U.rep].identity), "identity matches the SPEC parser");
  ok(route.business_name === "Demo Sheds" && route.recent_emergency_user === null, "business name, no 911 window");
  ok(await one(db, "select public.phone_route_for_number('+15555550199') is null as n").then((r) => r.n), "unknown number -> null");
  await db.exec("update sms_numbers set released_at = now() where phone_number = '+15555550101'");

  const ctx = (await one(db, `select public.phone_caller_context('${U.rep}') c`)).c;
  ok(ctx.client_id === T && ctx.phone_level === "own" && ctx.contacts_level === "edit" && ctx.own_contacts_only === false, "caller context: rep");
  ok(ctx.number && ctx.number.e164 === "+15555550100" && ctx.number.voice_enabled === false && ctx.number.registration_status === "registered", "caller context: the tenant's sms_number line");
  ok(ctx.device_generation === 1 && ctx.full_name === "Rita Rep" && ctx.phone_status === "on", "caller context: generation, name, switch");
  const octx = (await one(db, `select public.phone_caller_context('${U.owner}') c`)).c;
  ok(octx.phone_level === "edit", "an owner with a stored phone:none is still edit");
  await db.exec(`insert into phone_user_settings (user_id, client_id, device_generation) values ('${U.rep}', '${T}', 4)`);
  ok((await one(db, `select public.phone_caller_context('${U.rep}') c`)).c.device_generation === 4, "a bumped generation is read uncached");
  ok((await one(db, `select public.phone_route_for_number('+15555550100') r`)).r.members[1].identity.endsWith("_g4"), "and the route's identity follows it");
  ok((await one(db, `select public.phone_caller_context('00000000-0000-4000-8000-00000000dead') is null as n`)).n, "no team -> null");

  console.log(" broadcasts");
  await db.exec("delete from realtime.messages");
  const topics = async () => (await db.query("select topic, event, payload from realtime.messages order by topic")).rows;
  const callId = (await one(db, `insert into phone_calls (client_id, number_id, contact_id, direction, from_e164, to_e164, rang_user_ids, answered_by, status)
     values ('${T}', '${numId}', '${contact}', 'in', '+15555550142', '+15555550100', array['${U.owner}','${U.office}']::uuid[], '${U.office}', 'in_progress') returning id`)).id;
  let rows = await topics();
  const set = (rs) => rs.map((r) => r.topic).sort().join(" ");
  ok(set(rows) === [`phone:${T}`, `phone:user:${U.owner}`, `phone:user:${U.rep}`, `phone:user:${U.office}`].sort().join(" "),
    "a call reaches the team, everyone it rang, who answered, and the contact's owner");
  ok(rows.every((r) => r.event === "call" && Object.keys(r.payload).sort().join() === "contact_id,id,op,table"
    && r.payload.op === "INSERT" && r.payload.table === "phone_calls" && r.payload.id === callId && r.payload.contact_id === contact), "payload is ids only");

  await db.exec("delete from realtime.messages");
  await db.exec(`update phone_calls set answered_by = '${U.rep}', transferred_from = '${U.office}', rang_user_ids = '{}' where id = '${callId}'`);
  rows = await topics();
  ok(set(rows).includes(`phone:user:${U.owner}`) && set(rows).includes(`phone:user:${U.office}`) && rows.every((r) => r.payload.op === "UPDATE"),
    "an UPDATE also tells the people on the OLD row");

  await db.exec("delete from realtime.messages");
  const vm = (await one(db, `insert into phone_voicemails (call_id, client_id) values ('${callId}', '${T}') returning id`)).id;
  rows = await topics();
  ok(rows.length > 1 && rows.every((r) => r.event === "voicemail" && r.payload.id === vm && r.payload.contact_id === contact && r.payload.table === "phone_voicemails"),
    "a voicemail rides its call's people and contact");

  await db.exec("delete from realtime.messages");
  await db.exec(`insert into sms_messages (client_id, contact_id, direction, from_number, to_number, body) values ('${T}', '${contact}', 'in', '+15555550142', '+15555550100', 'hi')`);
  rows = await topics();
  ok(set(rows) === [`phone:${T}`, `phone:user:${U.rep}`].sort().join(" ") && rows.every((r) => r.event === "sms"),
    "an inbound text reaches the team and the contact's owner");
  await db.exec("delete from realtime.messages");
  await db.exec(`insert into sms_messages (client_id, direction, from_number, to_number, body) values ('${T}', 'in', '+15555550143', '+15555550100', 'who is this')`);
  rows = await topics();
  ok(set(rows) === `phone:${T}`, "a text from an unknown number goes to the team topic only");
  await db.exec("delete from realtime.messages");
  await db.exec(`insert into sms_messages (client_id, direction, from_number, to_number, body, sent_by, sent_via, client_temp_id) values ('${T}', 'out', '+15555550100', '+15555550143', 'hello', '${U.office}', 'extension', 'tmp-1')`);
  rows = await topics();
  ok(set(rows) === [`phone:${T}`, `phone:user:${U.office}`].sort().join(" "), "an outbound text reaches its sender");
  await db.exec("delete from realtime.messages");
  await db.exec(`insert into sms_messages (client_id, direction, from_number, to_number, body) values ('${X}', 'in', '+15555550142', '+15555550100', 'x')`);
  await db.exec(`update client_settings set phone_status = 'off' where client_id = '${X}'`);
  await db.exec(`insert into sms_messages (client_id, direction, from_number, to_number, body) values ('${X}', 'in', '+15555550142', '+15555550100', 'y')`);
  rows = await topics();
  ok(rows.length === 1, "a tenant switched off broadcasts nothing");
  await expectError(db, `insert into sms_messages (client_id, direction, from_number, to_number, sent_via) values ('${T}','out','+1','+1','fax')`,
    /sms_messages_sent_via_chk/, "sent_via is checked");

  console.log(" grants");
  for (const [role, sql, re, msg] of [
    ["anon", "select * from phone_calls", /permission denied/, "anon cannot read phone_calls"],
    ["authenticated", "select * from phone_routes", /permission denied/, "authenticated cannot read phone_routes"],
    ["authenticated", "insert into phone_devices (user_id, client_id, platform) values (gen_random_uuid(), 'x', 'chrome')", /permission denied/, "authenticated cannot write phone_devices"],
    ["authenticated", "select public.phone_route_for_number('+15555550100')", /permission denied/, "authenticated cannot call phone_route_for_number"],
    ["anon", `select public.phone_caller_context('${U.rep}')`, /permission denied/, "anon cannot call phone_caller_context"],
  ]) {
    await expectError(db, `set role ${role}; ${sql}; reset role;`, re, msg);
    await db.exec("reset role");
  }
  await db.exec("set role service_role");
  ok((await one(db, "select public.phone_route_for_number('+15555550100') is not null as ok")).ok, "service_role calls the route RPC");
  await db.exec(`insert into phone_devices (user_id, client_id, platform) values ('${U.rep}', '${T}', 'chrome')
                 on conflict (user_id, platform, push_token) do update set last_seen_at = now()`);
  await db.exec(`insert into phone_devices (user_id, client_id, platform) values ('${U.rep}', '${T}', 'chrome')
                 on conflict (user_id, platform, push_token) do update set last_seen_at = now()`);
  await db.exec("reset role");
  ok(Number((await one(db, "select count(*) c from phone_devices")).c) === 1, "a token-less device upserts ONE row (nulls not distinct)");

  console.log(" realtime.messages policies (as the signed-in user)");
  // Rows as the database would write them, one per topic family.
  await db.exec(`delete from realtime.messages;
    insert into realtime.messages (topic, extension, event, payload, private) values
      ('phone:user:${U.rep}', 'broadcast', 'call', '{}', true),
      ('phone:${T}',          'broadcast', 'call', '{}', true),
      ('phone:presence:${T}', 'presence',  null,   '{}', true),
      ('phone:presence:${T}', 'broadcast', 'call', '{}', true);`);
  const canRead = async (uid, topic, ext) => {
    await db.exec(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', false);
                   select set_config('realtime.topic', '${topic}', false); set role authenticated;`);
    try {
      return Number((await one(db, `select count(*) c from realtime.messages where topic = '${topic}' and extension = '${ext}'`)).c) > 0;
    } finally { await db.exec("reset role"); }
  };
  const canTrack = async (uid, topic) => {
    await db.exec(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', false);
                   select set_config('realtime.topic', '${topic}', false); set role authenticated;`);
    try {
      await db.exec(`insert into realtime.messages (topic, extension, payload, private) values ('${topic}', 'presence', '{}', true)`);
      return true;
    } catch (e) { return /row-level security/.test(e.message) ? false : Promise.reject(e); }
    finally { await db.exec("reset role"); }
  };
  ok(await canRead(U.rep, `phone:user:${U.rep}`, "broadcast"), "a rep reads their own user topic");
  ok(!(await canRead(U.office, `phone:user:${U.rep}`, "broadcast")), "nobody reads someone else's user topic");
  ok(!(await canRead(U.rep, `phone:${T}`, "broadcast")), "a rep (own) cannot read the team topic — rank puts own == view, the policy must not");
  ok(await canRead(U.office, `phone:${T}`, "broadcast"), "office staff (view) read the team topic");
  ok(await canRead(U.owner, `phone:${T}`, "broadcast"), "an owner with a stored phone:none still reads the team topic");
  ok(!(await canRead(U.outsider, `phone:${T}`, "broadcast")), "another tenant's viewer cannot read this team topic");
  ok(!(await canRead(U.stranger, `phone:${T}`, "broadcast")), "a signed-in user on no team reads nothing (current_area_level fails open, the tenant guard holds)");
  ok(await canRead(U.rep, `phone:presence:${T}`, "presence"), "a rep reads presence");
  ok(!(await canRead(U.rep, `phone:presence:${T}`, "broadcast")), "the presence topic carries no broadcast");
  ok(!(await canRead(U.driver, `phone:presence:${T}`, "presence")), "a driver (none) cannot read presence");
  ok(await canTrack(U.rep, `phone:presence:${T}`), "a rep can track presence");
  ok(!(await canTrack(U.driver, `phone:presence:${T}`)), "a driver cannot track presence");
  ok(!(await canTrack(U.outsider, `phone:presence:${T}`)), "another tenant cannot track here");
  ok(!(await canTrack(U.stranger, `phone:presence:${T}`)), "a user on no team cannot track");
  ok(!(await canTrack(U.office, `phone:${T}`)), "nobody can send on the team topic from a client");

  // ── The gaps closed on 2026-09-29 (second wave) ─────────────────────────────────────────
  await db.exec("reset role");
  console.log(" busy after a transfer (DEVIATION 10)");
  const busyOf = async (uid) => (await one(db, "select public.phone_route_for_number('+15555550100') r")).r.members.find((m) => m.user_id === uid).busy;
  ok((await busyOf(U.office)) === false, "office staff start idle (the earlier call was handed to the rep)");
  const placed = (await one(db, `insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, status, transferred_from, transfer_state)
     values ('${T}', '${numId}', 'out', '+15555550100', '+15555550150', '${U.office}', 'in_progress', '${U.office}', 'transferring') returning id`)).id;
  ok((await busyOf(U.office)) === false, "a call the placer transferred away does not make them busy");
  await db.exec(`update phone_calls set transferred_from = '${U.rep}' where id = '${placed}'`);
  ok((await busyOf(U.office)) === false, "nor after a second hop moves transferred_from to a teammate");
  await db.exec(`update phone_calls set transferred_from = null, transfer_state = null where id = '${placed}'`);
  ok((await busyOf(U.office)) === true, "the same call never handed on does make them busy");
  await db.exec(`delete from phone_calls where id = '${placed}'`);
  // DEVIATION 13 (review SSB-8): the Worker's third "on this call" clause. A warm transfer moves
  // answered_by to the teammate and sets transferred_from to the person handing it on, while the
  // call sits in its conference; that person may still be in it, so they are busy.
  const warm = (await one(db, `insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, answered_by, status, transferred_from, transfer_state)
     values ('${T}', '${numId}', 'in', '+15555550151', '+15555550100', '${U.rep}', 'in_progress', '${U.office}', 'conference') returning id`)).id;
  ok((await busyOf(U.office)) === true, "the person consulting in a warm transfer's conference is busy");
  ok((await busyOf(U.rep)) === true, "and so is the teammate who took it");
  await db.exec(`update phone_calls set transfer_state = null where id = '${warm}'`);
  ok((await busyOf(U.office)) === false, "once the conference is over, the person who handed it on is free again");
  await db.exec(`update phone_calls set transfer_state = 'conference', started_at = now() - interval '5 hours' where id = '${warm}'`);
  ok((await busyOf(U.office)) === false, "a conference row older than the 4-hour bound (a lost callback) does not keep them busy");
  await db.exec(`delete from phone_calls where id = '${warm}'`);
  ok(Number((await one(db, "select count(*) c from pg_indexes where indexname = 'phone_calls_live_conference_idx'")).c) === 1, "the third busy branch has its own partial index");

  console.log(" Save as contact (crm_create_contact)");
  const NUM = "+15555550177";
  await db.exec(`
    insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, status) values ('${T}', '${numId}', 'in', '${NUM}', '+15555550100', 'missed');
    insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, status) values ('${T}', '${numId}', 'in', '+15555550188', '+15555550100', 'missed');
    insert into phone_calls (client_id, direction, from_e164, to_e164, status) values ('${X}', 'in', '${NUM}', '+15555550111', 'missed');
    insert into sms_messages (client_id, direction, from_number, to_number, body) values ('${T}', 'in', '${NUM}', '+15555550100', 'hello?');
    insert into sms_messages (client_id, direction, from_number, to_number, body, sent_by) values ('${T}', 'out', '+15555550100', '${NUM}', 'hi, who is this', '${U.office}');
    delete from realtime.messages;`);
  await db.exec("set role service_role");
  const made = (await one(db, `select public.crm_create_contact('${T}', ' Una Known ', '(555) 555-0177', '${U.rep}', '${U.office}', 'phone') r`)).r;
  await db.exec("reset role");
  ok(!!made.id && made.relinked.calls === 1 && made.relinked.sms === 2, "service_role creates it and it reports what it re-linked", JSON.stringify(made));
  const row = await one(db, `select name, phone, phone_digits, source, owner_user_id from crm_contacts where id = '${made.id}'`);
  ok(row.name === "Una Known" && row.phone_digits === "5555550177" && row.source === "phone" && row.owner_user_id === U.rep, "the row: trimmed name, keyed phone, source phone, the owner asked for", JSON.stringify(row));
  const linked = await one(db, `select
      (select count(*) from phone_calls where client_id = '${T}' and contact_id = '${made.id}') c,
      (select count(*) from sms_messages where client_id = '${T}' and contact_id = '${made.id}') s,
      (select count(*) from phone_calls where client_id = '${T}' and from_e164 = '+15555550188' and contact_id is null) other,
      (select count(*) from phone_calls where client_id = '${X}' and contact_id is null) x`);
  ok(Number(linked.c) === 1 && Number(linked.s) === 2, "the number's earlier call and both texts (in and out) moved onto it");
  ok(Number(linked.other) === 1, "a call from another number stayed where it was");
  ok(Number(linked.x) === 1, "ANOTHER tenant's call from the same number stayed unlinked");
  const fc = await one(db, `select field, old_value, new_value, changed_by from crm_field_changes where contact_id = '${made.id}'`);
  ok(fc && fc.field === "owner" && fc.old_value === null && fc.new_value === U.rep && fc.changed_by === U.office, "the owner is logged like crm_update_contact logs it", JSON.stringify(fc));
  const relinkTopics = (await db.query("select topic, event from realtime.messages")).rows;
  ok(relinkTopics.some((r) => r.topic === `phone:user:${U.rep}` && r.event === "sms") && relinkTopics.some((r) => r.topic === `phone:user:${U.rep}` && r.event === "call"),
    "the re-link tells the new owner live (UPDATE broadcasts on their topic)", JSON.stringify(relinkTopics));
  await db.exec("set role service_role");
  await expectError(db, `select public.crm_create_contact('${T}', 'Una Again', '+1 555 555 0177')`, /crm_contacts_tenant_phone/, "the same number twice hits the tenant index (23505)");
  const xMade = (await one(db, `select public.crm_create_contact('${X}', 'Una Elsewhere', '${NUM}') r`)).r;
  ok(!!xMade.id && xMade.relinked.calls === 1 && xMade.relinked.sms === 0, "the same number is a new contact at ANOTHER tenant, with that tenant's call", JSON.stringify(xMade));
  await expectError(db, `select public.crm_create_contact('${T}', 'Otto', '+15555550179', '${U.outsider}')`, /owner is not on this team/, "an owner from another team is refused");
  await expectError(db, `select public.crm_create_contact('${T}', 'Nobody', 'Anonymous')`, /a phone number is required/, "a number with no digits is refused");
  await expectError(db, `select public.crm_create_contact('${T}', 'Faxed', '+15555550180', null, null, 'fax')`, /crm_contacts_source_check/, "a source outside the CHECK is refused");
  await db.exec("reset role");
  await expectError(db, `set role authenticated; select public.crm_create_contact('${T}', 'Sneaky', '+15555550181'); reset role;`, /permission denied/, "authenticated cannot call crm_create_contact");
  await db.exec("reset role");

  console.log(" Save as contact moves only what nobody loses and nobody gains (DEVIATION 14)");
  // Two dealers (contacts:'own', phone:'own') have both been talking to the same unknown number.
  const D = { a: "00000000-0000-4000-8000-00000000000a", b: "00000000-0000-4000-8000-00000000000b" };
  await db.exec(`insert into client_users (user_id, client_id, role, title, full_name) values
    ('${D.a}', '${T}', 'user', 'dealer', 'Dana Dealer'), ('${D.b}', '${T}', 'user', 'dealer', 'Dale Dealer')`);
  ok((await one(db, "select public.area_level_for('user', 'dealer', null, 'contacts') l")).l === "own", "a dealer is limited to their own customers (the case this is about)");
  const SHARED = "+15555550166";
  const mk = async (sql) => (await one(db, sql + " returning id")).id;
  const cA   = await mk(`insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, status) values ('${T}', '${numId}', 'out', '+15555550100', '${SHARED}', '${D.a}', 'completed')`);
  const cB   = await mk(`insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, status) values ('${T}', '${numId}', 'out', '+15555550100', '${SHARED}', '${D.b}', 'completed')`);
  const cAB  = await mk(`insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, rang_user_ids, status) values ('${T}', '${numId}', 'in', '${SHARED}', '+15555550100', array['${D.a}','${D.b}']::uuid[], 'missed')`);
  const cBr  = await mk(`insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, rang_user_ids, status) values ('${T}', '${numId}', 'in', '${SHARED}', '+15555550100', array['${D.b}']::uuid[], 'missed')`);
  const cBA  = await mk(`insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, answered_by, transferred_from, status) values ('${T}', '${numId}', 'out', '+15555550100', '${SHARED}', '${D.b}', '${D.a}', '${D.b}', 'completed')`);
  const cOff = await mk(`insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, answered_by, status) values ('${T}', '${numId}', 'in', '${SHARED}', '+15555550100', '${U.office}', 'completed')`);
  const tIn  = await mk(`insert into sms_messages (client_id, direction, from_number, to_number, body) values ('${T}', 'in', '${SHARED}', '+15555550100', 'who is this?')`);
  const tA   = await mk(`insert into sms_messages (client_id, direction, from_number, to_number, body, sent_by) values ('${T}', 'out', '+15555550100', '${SHARED}', 'from Dana', '${D.a}')`);
  const tB   = await mk(`insert into sms_messages (client_id, direction, from_number, to_number, body, sent_by) values ('${T}', 'out', '+15555550100', '${SHARED}', 'from Dale', '${D.b}')`);
  // Dale saves it. portal-settings passes the caller as owner AND actor for a narrowed caller.
  await db.exec("set role service_role");
  const dale = (await one(db, `select public.crm_create_contact('${T}', 'Shared Lead', '${SHARED}', '${D.b}', '${D.b}', 'phone') r`)).r;
  await db.exec("reset role");
  const where = async (table, id) => (await one(db, `select contact_id from ${table} where id = '${id}'`)).contact_id;
  ok(dale.relinked.calls === 2 && dale.relinked.sms === 1, "the narrowed saver moved exactly their own two calls and their own text", JSON.stringify(dale.relinked));
  ok((await where("phone_calls", cB)) === dale.id, "Dale's own call moved onto Dale's new contact");
  ok((await where("phone_calls", cBr)) === dale.id, "a missed call that rang only Dale moved");
  ok((await where("phone_calls", cA)) === null, "Dana's call stayed unlinked: Dana keeps it, and Dale does not get it");
  ok((await where("phone_calls", cAB)) === null, "a missed call that rang BOTH stayed unlinked: moving it would take it from Dana");
  ok((await where("phone_calls", cBA)) === null, "a call Dale handed to Dana stayed unlinked: Dana answered it");
  ok((await where("phone_calls", cOff)) === null, "a call office staff answered stayed unlinked: Dale was never on it");
  ok((await where("sms_messages", tB)) === dale.id, "Dale's own text moved");
  ok((await where("sms_messages", tA)) === null, "Dana's text stayed where it was");
  ok((await where("sms_messages", tIn)) === null, "the customer's earlier text stayed: Dale could not see unknown numbers' texts before saving");

  // Office staff (contacts view/edit, not narrowed) save a number Dana has called: the contact
  // is unassigned, which everybody can see, so everything moves and nobody loses.
  const OPEN = "+15555550167";
  const oA  = await mk(`insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, status) values ('${T}', '${numId}', 'out', '+15555550100', '${OPEN}', '${D.a}', 'completed')`);
  const oIn = await mk(`insert into sms_messages (client_id, direction, from_number, to_number, body) values ('${T}', 'in', '${OPEN}', '+15555550100', 'hi')`);
  await db.exec("set role service_role");
  const office = (await one(db, `select public.crm_create_contact('${T}', 'Open Lead', '${OPEN}', null, '${U.office}', 'phone') r`)).r;
  // A saver who is NOT narrowed but names an owner: a dealer who took a call on that number and
  // is not the owner would lose it, so that call stays.
  const OWNED = "+15555550168";
  const wA = await mk(`insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, status) values ('${T}', '${numId}', 'out', '+15555550100', '${OWNED}', '${D.a}', 'completed')`);
  const wB = await mk(`insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, status) values ('${T}', '${numId}', 'out', '+15555550100', '${OWNED}', '${D.b}', 'completed')`);
  const wO = await mk(`insert into phone_calls (client_id, number_id, direction, from_e164, to_e164, answered_by, status) values ('${T}', '${numId}', 'in', '${OWNED}', '+15555550100', '${U.office}', 'completed')`);
  const owned = (await one(db, `select public.crm_create_contact('${T}', 'Owned Lead', '${OWNED}', '${D.b}', '${U.office}', 'phone') r`)).r;
  await db.exec("reset role");
  ok(office.relinked.calls === 1 && office.relinked.sms === 1 && (await where("phone_calls", oA)) === office.id && (await where("sms_messages", oIn)) === office.id,
    "a saver with full contacts access and no owner moves the dealer's call and the customer's text (an unassigned contact is everyone's)", JSON.stringify(office.relinked));
  ok((await where("phone_calls", wA)) === null && (await where("phone_calls", wB)) === owned.id && (await where("phone_calls", wO)) === owned.id,
    "with an owner named, a call by another dealer stays (they could not see Dale's contact); the owner's and office staff's calls move", JSON.stringify(owned.relinked));

  console.log(" crm_merge_contacts carries calls");
  const loser = (await one(db, `insert into crm_contacts (client_id, name, phone, phone_digits, source) values ('${T}', 'Una Dup', '+15555550178', '5555550178', 'manual') returning id`)).id;
  const lcall = (await one(db, `insert into phone_calls (client_id, number_id, contact_id, direction, from_e164, to_e164, status) values ('${T}', '${numId}', '${loser}', 'in', '+15555550178', '+15555550100', 'voicemail') returning id`)).id;
  await db.exec(`insert into phone_voicemails (call_id, client_id) values ('${lcall}', '${T}')`);
  await db.exec("set role service_role");
  const merged = (await one(db, `select public.crm_merge_contacts('${T}', '${made.id}', '${loser}', '${U.office}') r`)).r;
  await db.exec("reset role");
  ok(merged.ok === true && merged.moved.calls === 1, "the merge reports the call it moved", JSON.stringify(merged.moved));
  const after = await one(db, `select (select contact_id from phone_calls where id = '${lcall}') c, (select merged_into from crm_contacts where id = '${loser}') m,
      (select count(*) from crm_contact_people where contact_id = '${made.id}' and phone_digits = '5555550178') p`);
  ok(after.c === made.id && after.m === made.id, "the loser's call (and so its voicemail) is on the winner; the loser is a tombstone");
  ok(Number(after.p) === 1, "192's own behaviour still holds: the loser's number is kept as a person on the winner");
  await expectError(db, `set role authenticated; select public.crm_merge_contacts('${T}', '${made.id}', '${loser}'); reset role;`, /permission denied/, "authenticated cannot call crm_merge_contacts");
  await db.exec("reset role");

  console.log(" Sign out all devices (phone_end_user_sessions)");
  await db.exec(`
    insert into auth.sessions (id, user_id) values ('10000000-0000-4000-8000-000000000001', '${U.rep}'), ('10000000-0000-4000-8000-000000000002', '${U.rep}'),
                                                   ('10000000-0000-4000-8000-000000000003', '${U.office}');
    insert into auth.refresh_tokens (session_id, token) values ('10000000-0000-4000-8000-000000000001', 'a'), ('10000000-0000-4000-8000-000000000002', 'b'),
                                                              ('10000000-0000-4000-8000-000000000003', 'c');
    insert into auth.mfa_amr_claims (session_id) values ('10000000-0000-4000-8000-000000000001');`);
  await expectError(db, `set role authenticated; select public.phone_end_user_sessions('${U.rep}'); reset role;`, /permission denied/, "authenticated cannot call phone_end_user_sessions");
  await db.exec("reset role");
  await expectError(db, `set role anon; select public.phone_end_user_sessions('${U.rep}'); reset role;`, /permission denied/, "anon cannot call it either");
  await db.exec("reset role; set role service_role");
  const ended = (await one(db, `select public.phone_end_user_sessions('${U.rep}') n`)).n;
  const none = (await one(db, `select public.phone_end_user_sessions(null) a, public.phone_end_user_sessions('${U.stranger}') b`));
  await db.exec("reset role");
  ok(ended === 2 && none.a === 0 && none.b === 0, "service_role ends the rep's two sessions; NULL and a stranger end none", JSON.stringify({ ended, none }));
  const auth = await one(db, `select (select count(*) from auth.sessions where user_id = '${U.rep}') rs, (select count(*) from auth.sessions) total,
      (select count(*) from auth.refresh_tokens) rt, (select count(*) from auth.mfa_amr_claims) mfa`);
  ok(Number(auth.rs) === 0 && Number(auth.total) === 1 && Number(auth.rt) === 1 && Number(auth.mfa) === 0,
    "their refresh tokens and MFA claims cascade; the office's session is untouched", JSON.stringify(auth));

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  await db.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
