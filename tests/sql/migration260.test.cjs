// Execute migration 260 for real in PGlite (Postgres compiled to WASM, in memory) on top of the
// database as 254 and 259 leave it: 254 is applied for real (its broadcast trigger, its grants
// and its realtime.messages policies, against the stubs migration254.test.cjs uses), the wallet as
// 128 + 151 + 164 + 169 + 244 + 248 left it, then 259, then 260. Checks: it applies (assertions
// and probe included) and leaves nothing behind; the six columns, three checks and the partial
// index are there with the types the Worker writes; the Worker's claim / answer / clear behave as
// handoff.ts sends them; phone_call_events takes `device_switch` with no CHECK change; no browser
// role can read or write the new columns (254's posture, column by column); every handoff write
// still broadcasts on 254's trigger, ids only (the key never rides along); 259's queue still takes
// a moved call; a second apply is a no-op, also mid-move; and broken copies and broken
// surroundings each abort the whole file. Nothing here touches the live project: no network, no
// Supabase, no Twilio.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration260.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIGDIR = path.join(WT, "supabase/migrations");
// LF only: with core.autocrlf on, a Windows checkout has CRLF .sql files, and the broken-copy
// mutations below match the migration's text across line breaks.
const lf = (s) => s.replace(/\r\n/g, "\n");
const read = (f) => lf(fs.readFileSync(path.join(MIGDIR, f), "utf8"));
const MIG = () => lf(fs.readFileSync(process.env.MIG_FILE || path.join(MIGDIR, "260_phone_call_handoff.sql"), "utf8"));

// The live bodies of the functions 254 calls but does not define (migration254.test.cjs, verbatim).
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

// migration254.test.cjs's stubs of the live schema, with two changes so 128..248 and 259 apply
// on the same database: usage_prices is left to 128 (which creates it), and client_settings
// carries billing_exempt (259's gate reads it). sms_messages has 150's status CHECK, as live.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema realtime;
grant usage on schema public, auth, realtime to anon, authenticated, service_role;

-- The live default ACLs for role postgres in schema public: every NEW table to the browser roles
-- (and, 244's trap, to PUBLIC), every new function and sequence to all three.
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant select, maintain on tables to anon;
alter default privileges in schema public grant select on tables to public;
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

create or replace function public.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(),
  business_name text, sms_number text, sms_status text not null default 'off',
  billing_exempt boolean not null default false
);
alter table public.client_settings enable row level security;
revoke all on public.client_settings from public, anon, authenticated;
create table public.client_users (
  user_id uuid primary key, client_id text not null, role text not null default 'owner',
  created_at timestamptz not null default now(), full_name text, phone text, title text,
  access jsonb, prefs jsonb, location_id uuid
);
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
create or replace function public.crm_contact_people_stamp() returns trigger language plpgsql set search_path = '' as $$
begin new.phone_digits := public.crm_phone_key(new.phone); new.email_lower := nullif(lower(btrim(coalesce(new.email, ''))), ''); return new; end $$;
create trigger crm_contact_people_stamp before insert or update on public.crm_contact_people
  for each row execute function public.crm_contact_people_stamp();
create table public.crm_field_changes (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade, field text not null,
  old_value text, new_value text, changed_by uuid, created_at timestamptz not null default now()
);

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
  body text, status text not null default 'received'
    check (status in ('claimed', 'sent', 'delivered', 'undelivered', 'failed', 'received')),
  error_code text, provider text not null default 'twilio',
  provider_sid text, num_segments integer, sent_by uuid, delivered_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index sms_messages_sid_uniq on public.sms_messages (provider_sid) where provider_sid is not null and provider_sid <> '';
alter table public.sms_messages enable row level security;
revoke all on public.sms_messages from anon, authenticated;
grant select on public.sms_messages to authenticated;

${LIVE}
`;

// 165's three sms meters, as 169 leaves them (inactive). 254 PART 9 seeds the phone ones.
const SMS_PRICES = `
insert into public.usage_prices (kind, label, unit_label, price_cents, active, visible, sort_order, note) values
  ('sms_registration',   'Text messaging setup',  'one-time', 4900, false, true, 20, null),
  ('sms_number_monthly', 'Text messaging number', 'month',    2900, false, true, 21, null),
  ('sms_segment',        'Extra text segment',    'segment',     3, false, false, 22, 'old note')
on conflict (kind) do nothing;`;

// current_area_level exactly as 154 defines it.
function currentAreaLevel() {
  const s = read("154_area_access_rls.sql");
  const a = s.indexOf("create or replace function public.current_area_level(p_area text)");
  const b = s.indexOf("$fn$;", a) + 5;
  return s.slice(a, b) + "\ngrant execute on function public.current_area_level(text) to authenticated, service_role;\n";
}

// A tenant switched on, the person on the calls, a teammate who owns the contact, and two calls
// written BEFORE 260: one finished, one live and held by USER on the extension.
const T = "tenant-260";
const USER = "00000000-0000-4000-8000-0000000000a1";
const MATE = "00000000-0000-4000-8000-0000000000b2";
const LIVE_CALL = "00000000-0000-4000-8000-000000000c01";
const DONE_CALL = "00000000-0000-4000-8000-000000000c02";
const CONTACT = "00000000-0000-4000-8000-000000000d01";
const SID = (n) => "CA" + String(n).padStart(32, "0");
const HISTORY = `
insert into public.client_settings (client_id, business_name, sms_number, phone_status) values ('${T}', 'Demo Sheds', '+15555550100', 'on');
insert into public.client_users (user_id, client_id, role, title, full_name) values
  ('${USER}', '${T}', 'user', 'office_staff', 'Pat Person'), ('${MATE}', '${T}', 'user', 'sales_rep', 'Rita Rep');
insert into public.crm_contacts (id, client_id, name, owner_user_id) values ('${CONTACT}', '${T}', 'Cam Customer', '${MATE}');
insert into public.phone_calls (id, client_id, contact_id, direction, from_e164, to_e164, twilio_call_sid, client_call_sid,
                                placed_by, status, started_at, answered_at, ended_at, duration_s)
values ('${DONE_CALL}', '${T}', null, 'out', '+15555550100', '+15555550142', '${SID(1)}', '${SID(2)}',
        '${USER}', 'completed', now() - interval '20 minutes', now() - interval '19 minutes', now() - interval '15 minutes', 240),
       ('${LIVE_CALL}', '${T}', '${CONTACT}', 'in', '+15555550143', '+15555550100', '${SID(3)}', '${SID(4)}',
        null, 'in_progress', now() - interval '3 minutes', now() - interval '3 minutes', null, null);
update public.phone_calls set answered_by = '${USER}' where id = '${LIVE_CALL}';
`;

const SIX = ["handoff_state", "handoff_to", "handoff_key", "handoff_at", "handoff_sid", "handoff_from_sid"];
const CHECKS = ["phone_calls_handoff_shape_chk", "phone_calls_handoff_state_chk", "phone_calls_handoff_to_chk"];

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, p) => (await db.query(sql, p)).rows[0];
const refused = async (db, sql, re, msg) => {
  try { await db.exec(sql); ok(false, msg, "no error"); } catch (e) { ok(re.test(e.message), `${msg} (${e.message.slice(0, 110)})`, e.message); }
  try { await db.exec("reset role"); } catch (_e) { /* ignore */ }
};

/** 254 + 259 applied for real, then the pre-260 history. `before` runs just before 260 would. */
const fresh = async (before) => {
  const db = new PGlite();
  const notices = [];
  const onNotice = (n) => notices.push(`${n.severity}: ${n.message}`);
  await db.exec(STUBS);
  await db.exec(read("219_office_staff_designer.sql"));
  await db.exec(currentAreaLevel());
  // A realtime partition, so broadcasts land and can be read back.
  await db.exec(`do $$ begin execute format(
    'create table realtime.messages_p260 partition of realtime.messages for values from (%L) to (%L)',
    current_date - 1, current_date + 2); end $$;`);
  for (const f of ["128_usage_wallet.sql", "151_wallet_stale_hold_release.sql", "164_wallet_topup.sql"]) await db.exec(read(f));
  await db.exec(SMS_PRICES);
  for (const f of ["169_sms_meters_disarmed.sql", "244_avalara_tax_lookups.sql", "248_wallet_released_key_reusable.sql"]) await db.exec(read(f));
  await db.exec(read("254_sss_phone.sql"), { onNotice });
  await db.exec(read("259_usage_billing.sql"), { onNotice });
  await db.exec(HISTORY);
  await db.exec("delete from realtime.messages");
  if (before) await db.exec(before);
  return { db, notices };
};

const triggerDef = async (db) => (await one(db, `select pg_get_triggerdef(t.oid) d, t.tgenabled e, t.tgfoid::regprocedure::text f
  from pg_trigger t where t.tgname = 'phone_calls_realtime' and t.tgrelid = 'public.phone_calls'::regclass`)) ?? null;

(async () => {
  console.log("migration 260: applies on 254 + 259 as live");
  {
    const { db, notices: baseNotices } = await fresh();
    ok(baseNotices.some((n) => /broadcasts landed on the team and user topics/.test(n)), "254 applied for real, its probe saw broadcasts land");
    ok(baseNotices.some((n) => /259 probe: three 4150-micro debits/.test(n)), "259 applied for real, its probe ran");
    const trigBefore = await triggerDef(db);
    const msgsBefore = Number((await one(db, "select count(*) n from realtime.messages")).n);

    const notices = [];
    let applied = true;
    try { await db.exec(MIG(), { onNotice: (n) => notices.push(n.message) }); } catch (e) { applied = false; ok(false, "260 applied", e.message); }
    ok(applied, "260 applied cleanly, assertions and probe included");
    ok(notices.some((m) => /260 probe: one claim at a time, answered only with its key/.test(m)), "the probe ran to its ROLLBACK_PROBE", JSON.stringify(notices));
    const left = await one(db, `select (select count(*)::int from public.phone_calls where client_id = '__260_probe__') calls,
      (select count(*)::int from public.phone_calls) all_calls, (select count(*)::int from realtime.messages) msgs`);
    ok(left.calls === 0 && left.all_calls === 2 && left.msgs === msgsBefore, "the probe left nothing behind and broadcast nothing", JSON.stringify(left));

    // ── Columns, checks, index ──
    const cols = (await db.query(`select column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'phone_calls' and column_name = any($1) order by column_name`, [SIX])).rows;
    const type = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
    ok(cols.length === 6 && cols.every((c) => c.is_nullable === "YES" && c.column_default === null), "six nullable columns, no defaults", JSON.stringify(cols));
    ok(type.handoff_key === "uuid" && type.handoff_at === "timestamp with time zone"
      && ["handoff_state", "handoff_to", "handoff_sid", "handoff_from_sid"].every((c) => type[c] === "text"),
      "handoff_key uuid, handoff_at timestamptz, the rest text (what handoff.ts writes)", JSON.stringify(type));
    const untouched = await one(db, `select count(*)::int n from public.phone_calls where ${SIX.map((c) => `${c} is null`).join(" and ")}`);
    ok(untouched.n === 2, "every existing row is NULL in all six");
    const checks = (await db.query(`select conname, pg_get_constraintdef(oid) def from pg_constraint
      where conrelid = 'public.phone_calls'::regclass and contype = 'c' and conname like 'phone_calls_handoff_%' order by conname`)).rows;
    ok(checks.map((c) => c.conname).join() === CHECKS.join(), "three named CHECKs", JSON.stringify(checks.map((c) => c.conname)));
    ok(/ringing.*connecting/.test(checks.find((c) => c.conname === "phone_calls_handoff_state_chk")?.def ?? "")
      && /chrome.*mobile/.test(checks.find((c) => c.conname === "phone_calls_handoff_to_chk")?.def ?? ""), "the state and to CHECKs name the Worker's values");
    const idx = await one(db, "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'phone_calls_handoff_live_idx'");
    ok(!!idx && /\(client_id, handoff_at DESC\)/.test(idx.indexdef) && /WHERE \(handoff_state IS NOT NULL\)/.test(idx.indexdef),
      "the partial index GET /handoff/pending reads", idx && idx.indexdef);

    // ── The Worker's writes, as service_role, the way handoff.ts sends them ──
    await db.exec("set role service_role");
    const key = (await one(db, "select gen_random_uuid()::text k")).k;
    // routes/handoff.ts startHandoff: the claim, from the leg that holds the call, one at a time.
    const claim = async (k, from) => (await db.query(`update public.phone_calls
        set handoff_state = 'ringing', handoff_to = 'mobile', handoff_key = $1::uuid, handoff_at = now(), handoff_sid = null, handoff_from_sid = $2
      where id = $3 and client_call_sid = $2 and status = 'in_progress' and ended_at is null
        and (handoff_state is null or handoff_at < now() - interval '45 seconds') returning id`, [k, from, LIVE_CALL])).rows.length;
    ok(await claim(key, SID(4)) === 1, "the claim lands on a live call from its holding leg");
    ok(await claim((await one(db, "select gen_random_uuid()::text k")).k, SID(4)) === 0, "a second claim while one rings gets nothing back (handoff_in_progress)");
    ok(await claim((await one(db, "select gen_random_uuid()::text k")).k, SID(9)) === 0, "a claim from a leg that does not hold the call gets nothing back");
    await db.exec(`update public.phone_calls set handoff_sid = '${SID(5)}' where id = '${LIVE_CALL}' and handoff_key = '${key}' and handoff_state = 'ringing'`);
    // handoff.ts handoffAnswer: ringing -> connecting with the key; on a plain call the conference too.
    const answer = async (k, leg) => (await db.query(`update public.phone_calls
        set handoff_state = 'connecting', handoff_sid = $2, handoff_at = now(), transfer_state = 'conference'
      where id = $3 and handoff_state = 'ringing' and handoff_key = $1::uuid and handoff_to = 'mobile'
        and handoff_at > now() - interval '45 seconds' and status = 'in_progress' and ended_at is null and client_call_sid = $4
        and (handoff_sid is null or handoff_sid = $2) and transfer_state is null returning id`, [k, leg, LIVE_CALL, SID(4)])).rows.length;
    ok(await answer((await one(db, "select gen_random_uuid()::text k")).k, SID(5)) === 0, "a wrong key does not answer the move");
    ok(await answer(key, SID(6)) === 0, "a leg other than the ring does not answer it");
    ok(await answer(key, SID(5)) === 1, "the ring with the key answers it and claims the conference");
    // completeHandoff step 3: the swap, guarded on the old leg; step 4: the event, sid = the new leg.
    const swapped = (await db.query(`update public.phone_calls set client_call_sid = $1, handoff_state = null
      where id = $2 and client_call_sid = $3 and handoff_key = $4::uuid and handoff_state = 'connecting' returning id`, [SID(5), LIVE_CALL, SID(4), key])).rows.length;
    ok(swapped === 1, "the swap lands once, then the move is over (state NULL, the rest lingers)");
    for (const data of [
      { phase: "offered", to: "mobile", held: false, user: USER },
      { phase: "done", to: "mobile", from_sid: SID(4), sid: SID(5), ms: 2100 },
      { phase: "missed", to: "mobile", sid: SID(7), status: "no-answer" },
      { phase: "canceled", to: "chrome", sid: null, reason: "declined", user: USER },
      { phase: "failed", to: "chrome", reason: "new_leg_gone", sid: SID(8), from_sid: SID(5), ms: 900 },
    ]) await db.query("insert into public.phone_call_events (call_id, type, data) values ($1, 'device_switch', $2::jsonb)", [LIVE_CALL, JSON.stringify(data)]);
    const ev = await one(db, `select count(*)::int n, count(*) filter (where data->>'sid' = '${SID(5)}')::int done_sid
      from public.phone_call_events where call_id = '${LIVE_CALL}' and type = 'device_switch'`);
    ok(ev.n === 5 && ev.done_sid === 1, "phone_call_events takes device_switch, every phase, with no CHECK change", JSON.stringify(ev));
    const ecs = await one(db, `select count(*)::int n from pg_constraint where conrelid = 'public.phone_call_events'::regclass and contype = 'c'`);
    ok(ecs.n === 0, "phone_call_events still has no CHECK at all (254 PART 3)");
    const row = await one(db, `select handoff_state, handoff_to, handoff_sid, handoff_from_sid, client_call_sid, handoff_key::text k from public.phone_calls where id = '${LIVE_CALL}'`);
    ok(row.handoff_state === null && row.client_call_sid === SID(5) && row.handoff_sid === SID(5) && row.handoff_from_sid === SID(4) && row.k === key,
      "after the move: holder = the new leg, the last attempt's pair kept for the status endpoints", JSON.stringify(row));
    // A move older than 45 s is over whatever the row says: the next claim may take it.
    await db.exec(`update public.phone_calls set handoff_state = 'ringing', handoff_at = now() - interval '46 seconds' where id = '${LIVE_CALL}'`);
    ok(await claim((await one(db, "select gen_random_uuid()::text k")).k, SID(5)) === 1, "a move stuck past 45 s does not block the next one");
    await db.exec(`update public.phone_calls set handoff_state = null where id = '${LIVE_CALL}'`);

    // The CHECKs, on a real row.
    await refused(db, `set role service_role; update public.phone_calls set handoff_state = 'moving' where id = '${LIVE_CALL}'`, /phone_calls_handoff_state_chk/, "handoff_state outside ringing/connecting is refused");
    await refused(db, `set role service_role; update public.phone_calls set handoff_to = 'ipad' where id = '${LIVE_CALL}'`, /phone_calls_handoff_to_chk/, "handoff_to outside chrome/mobile is refused");
    for (const c of ["handoff_to", "handoff_key", "handoff_at", "handoff_from_sid"]) {
      await refused(db, `set role service_role; update public.phone_calls set handoff_state = 'ringing', ${c} = null where id = '${LIVE_CALL}'`,
        /phone_calls_handoff_shape_chk/, `a move under way without ${c} is refused`);
    }
    await db.exec("set role service_role");
    await db.exec(`update public.phone_calls set handoff_state = 'connecting', handoff_sid = null where id = '${LIVE_CALL}'`);
    ok(true, "handoff_sid may be NULL while a move is under way (the ring's SID lands after the claim)");
    await db.exec(`update public.phone_calls set handoff_state = null where id = '${LIVE_CALL}'`);
    await db.exec("reset role");

    // ── Grants: phone_calls stays server-only, the new columns included ──
    const priv = (await db.query(`select r.role, c.col, p.priv, has_column_privilege(r.role, 'public.phone_calls', c.col, p.priv) has
      from unnest(array['anon','authenticated']) r(role), unnest($1::text[]) c(col),
           unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) p(priv)`, [SIX])).rows;
    ok(priv.length === 48 && priv.every((x) => x.has === false), "anon and authenticated hold no SELECT/INSERT/UPDATE/REFERENCES on any of the six",
      JSON.stringify(priv.filter((x) => x.has)));
    const tbl = await one(db, `select has_table_privilege('authenticated','public.phone_calls','SELECT') a_sel,
      has_table_privilege('anon','public.phone_calls','SELECT') n_sel,
      has_any_column_privilege('authenticated','public.phone_calls','SELECT') a_any,
      (select relrowsecurity from pg_class where oid = 'public.phone_calls'::regclass) rls,
      (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'phone_calls') pol,
      (select count(*)::int from pg_attribute a, aclexplode(a.attacl) x
         where a.attrelid = 'public.phone_calls'::regclass and a.attname = any($1::text[]) and a.attacl is not null) col_acls`, [SIX]);
    ok(!tbl.a_sel && !tbl.n_sel && !tbl.a_any && tbl.rls === true && tbl.pol === 0 && tbl.col_acls === 0,
      "phone_calls: RLS on, zero policies, no table or column grant to a browser role (254's posture)", JSON.stringify(tbl));
    const svc = await one(db, `select bool_and(has_column_privilege('service_role','public.phone_calls', c, 'SELECT')
      and has_column_privilege('service_role','public.phone_calls', c, 'UPDATE')) s from unnest($1::text[]) c`, [SIX]);
    ok(svc.s === true, "service_role (the Worker) reads and writes all six");
    for (const role of ["anon", "authenticated"]) {
      await refused(db, `set role ${role}; select handoff_key from public.phone_calls`, /permission denied/, `${role} cannot read phone_calls.handoff_key`);
      await refused(db, `set role ${role}; update public.phone_calls set handoff_state = null`, /permission denied/, `${role} cannot write phone_calls.handoff_state`);
      await refused(db, `set role ${role}; select data from public.phone_call_events where type = 'device_switch'`, /permission denied/, `${role} cannot read the device_switch events`);
    }

    // ── Realtime: 254's trigger, untouched, broadcasts every handoff write, ids only ──
    const trigAfter = await triggerDef(db);
    ok(!!trigBefore && JSON.stringify(trigAfter) === JSON.stringify(trigBefore) && trigAfter.e === "O" && trigAfter.f === "phone_realtime_notify()"
      && !/ UPDATE OF | WHEN /.test(trigAfter.d), "phone_calls_realtime is 254's, enabled, every update, no column list", trigAfter && trigAfter.d);
    const pubs = await one(db, "select count(*)::int n from pg_publication_tables where tablename = 'phone_calls'");
    ok(pubs.n === 0, "phone_calls joins no publication (no postgres_changes path that could carry a column)");
    await db.exec("delete from realtime.messages");
    const key2 = (await one(db, "select gen_random_uuid()::text k")).k;
    await db.exec("set role service_role");
    await db.exec(`update public.phone_calls set handoff_state = 'ringing', handoff_to = 'chrome', handoff_key = '${key2}', handoff_at = now(),
      handoff_sid = null, handoff_from_sid = client_call_sid where id = '${LIVE_CALL}'`);
    await db.exec("reset role");
    const msgs = (await db.query("select topic, event, payload from realtime.messages order by topic")).rows;
    const topics = msgs.map((m) => m.topic).sort().join(" ");
    ok(topics === [`phone:${T}`, `phone:user:${USER}`, `phone:user:${MATE}`].sort().join(" "),
      "the claim broadcasts on the team topic, the holder's own topic (the extension rings on it) and the contact owner's", topics);
    ok(msgs.every((m) => m.event === "call" && Object.keys(m.payload).sort().join() === "contact_id,id,op,table"
      && m.payload.op === "UPDATE" && m.payload.id === LIVE_CALL && m.payload.table === "phone_calls"), "payload is ids only", JSON.stringify(msgs[0]));
    ok(!JSON.stringify(msgs).includes(key2) && !JSON.stringify(msgs).includes("handoff"), "the key (a capability) and the handoff columns never ride along");
    await db.exec("delete from realtime.messages");
    await db.exec(`set role service_role; update public.phone_calls set handoff_state = null where id = '${LIVE_CALL}' and handoff_key = '${key2}'; reset role;`);
    ok(Number((await one(db, "select count(*) n from realtime.messages")).n) === 3, "clearing the move broadcasts too (the apps re-read on it)");

    // ── 259 still takes a call that was moved ──
    await db.exec(`update public.phone_calls set status = 'completed', ended_at = now() - interval '1 minute', duration_s = 180, transfer_state = null where id = '${LIVE_CALL}'`);
    await db.exec("set role service_role");
    const enq = await one(db, "select public.usage_charges_enqueue(now() - interval '3 days', 500) n");
    await db.exec("reset role");
    const q = (await db.query("select source_id::text s from public.usage_charges where source = 'call' order by source_id")).rows.map((r) => r.s);
    ok(enq.n === 2 && q.includes(LIVE_CALL) && q.includes(DONE_CALL), "usage_charges_enqueue queues the moved call like any finished one", JSON.stringify({ enq, q }));

    // ── A second apply is a no-op, also with a move under way and a finished one lingering ──
    await db.exec(`update public.phone_calls set handoff_state = 'ringing', handoff_to = 'mobile', handoff_key = gen_random_uuid(), handoff_at = now(),
      handoff_from_sid = '${SID(2)}' where id = '${DONE_CALL}'`);
    const snap = async () => (await db.query(`select id, ${SIX.join(", ")}, client_call_sid from public.phone_calls order by id`)).rows;
    const before = JSON.stringify(await snap());
    let again = true;
    try { await db.exec(MIG()); } catch (e) { again = false; ok(false, "re-apply", e.message); }
    ok(again, "a second apply is harmless, with a move under way on one row and a finished one's pair on another");
    ok(JSON.stringify(await snap()) === before, "and changes no row");
    const shape = await one(db, `select
      (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'phone_calls' and column_name like 'handoff_%') cols,
      (select count(*)::int from pg_constraint where conrelid = 'public.phone_calls'::regclass and conname like 'phone_calls_handoff_%') cons,
      (select count(*)::int from pg_indexes where tablename = 'phone_calls' and indexname like 'phone_calls_handoff_%') idx,
      (select count(*)::int from pg_trigger where tgrelid = 'public.phone_calls'::regclass and not tgisinternal) trg`);
    ok(shape.cols === 6 && shape.cons === 3 && shape.idx === 1 && shape.trg === 1, "still six columns, three checks, one index, one trigger", JSON.stringify(shape));
    ok(JSON.stringify(await triggerDef(db)) === JSON.stringify(trigBefore), "and 254's trigger as it was");
    // The two were built at the same time and either may be applied second: 259 (its assertions
    // and its probe, which writes phone_calls rows) still applies over 260's columns.
    let order = true;
    try { await db.exec(read("259_usage_billing.sql")); } catch (e) { order = false; ok(false, "259 after 260", e.message); }
    ok(order && JSON.stringify(await snap()) === before, "259 re-applied over 260 still applies and touches no call row");
    await db.close();
  }

  console.log("migration 260: the assertions and the probe abort the whole migration");
  const broken = async (label, { mutate, before }, re) => {
    const { db } = await fresh(before);
    const src = mutate ? mutate(MIG()) : MIG();
    if (mutate && src === MIG()) { ok(false, `${label}: the mutation did not apply`); await db.close(); return; }
    let err = null;
    try { await db.exec(src); } catch (e) { err = e; }
    ok(!!err && re.test(err.message), `${label} stops the apply`, err ? err.message : "applied");
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const n = await one(db, `select
      (select count(*)::int from information_schema.columns where table_name = 'phone_calls' and column_name in ('handoff_state','handoff_sid','handoff_from_sid')) c,
      (select count(*)::int from pg_constraint where conname like 'phone_calls_handoff_%') k,
      to_regclass('public.phone_calls_handoff_live_idx') i`);
    ok(n.c === 0 && n.k === 0 && n.i === null, `${label}: nothing of 260 is left behind`, JSON.stringify(n));
    await db.close();
  };
  await broken("a column grant to the browser",
    { mutate: (s) => s.replace("-- Named, so PART 2 can find them", "grant select (handoff_key) on public.phone_calls to authenticated;\n-- Named, so PART 2 can find them") },
    /260: authenticated holds SELECT on phone_calls\.handoff_key/);
  await broken("a table that was readable by anon before 260",
    { before: "grant select on public.phone_calls to anon;" },
    /260: anon holds SELECT on phone_calls\.handoff_state/);
  await broken("service_role without UPDATE on phone_calls",
    { before: "revoke update on public.phone_calls from service_role;" },
    /260: service_role lacks UPDATE on phone_calls\.handoff_state/);
  await broken("a CHECK on phone_call_events.type added since 254",
    { before: "alter table public.phone_call_events add constraint phone_call_events_type_chk check (type in ('answered','ended'));" },
    /260: phone_call_events\.type has gained a CHECK/);
  await broken("the broadcast trigger narrowed to UPDATE OF status",
    { before: `drop trigger phone_calls_realtime on public.phone_calls;
      create trigger phone_calls_realtime after insert or update of status or delete on public.phone_calls
        for each row execute function public.phone_realtime_notify();` },
    /260: phone_calls_realtime is missing, disabled, or no longer fires on every update/);
  await broken("the broadcast trigger disabled",
    { before: "alter table public.phone_calls disable trigger phone_calls_realtime;" },
    /260: phone_calls_realtime is missing, disabled/);
  await broken("a shape CHECK that forgets the key",
    { mutate: (s) => s.replace("(handoff_to is not null and handoff_key is not null", "(handoff_to is not null") },
    /260 probe: a move under way was allowed without its key/);
  await broken("a state CHECK that takes anything",
    { mutate: (s) => s.replace("check (handoff_state is null or handoff_state in ('ringing', 'connecting'))", "check (true)") },
    /260 probe: handoff_state took a value outside ringing\/connecting/);
  // A column of the wrong type that already existed: add column if not exists keeps it, PART 2 refuses.
  {
    const { db } = await fresh("alter table public.phone_calls add column handoff_key text;");
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /260: handoff_key must be uuid/.test(err.message), "a handoff_key of another type stops the apply", err ? err.message : "applied");
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const n = await one(db, "select count(*)::int c from information_schema.columns where table_name = 'phone_calls' and column_name = 'handoff_state'");
    ok(n.c === 0, "and nothing of 260 is left behind", JSON.stringify(n));
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
