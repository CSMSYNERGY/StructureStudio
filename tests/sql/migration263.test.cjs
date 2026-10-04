// Execute migration 263 for real in PGlite (Postgres compiled to WASM, in memory) on top of the
// tables and functions it builds on, as they are live after 261, then check what it promises:
// the recording settings with their defaults and checks, one recording per call, the two RPCs
// returning `recording`, the transcript and summary claims, the retention list, a recording told
// as its call (and the queue's own writes telling nobody), the enqueue's two new sources, every
// grant, a probe that leaves nothing behind, a re-apply that is harmless, and assertions and a
// probe that really abort a broken copy (mutants). Nothing here touches the live project: no
// network, no Supabase, no Twilio, no call recorded.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration263.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const lf = (s) => s.replace(/\r\n/g, "\n");
const READ = (f) => lf(fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8"));
const MIG_TEXT = () => lf(fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/263_phone_call_recording.sql"), "utf8"));

// phone_realtime_notify as it is live: 261 PART 2's text exactly (pg_get_functiondef, 2026-10-04),
// lifted from the file rather than copied a second time.
function liveNotify() {
  const s = READ("261_phone_email_thread.sql");
  // Its header names the function too (in the rollback notes), so the anchor takes the next line.
  const a = s.indexOf("create or replace function public.phone_realtime_notify()\nreturns trigger");
  const b = s.indexOf("comment on function public.phone_realtime_notify()", a);
  if (a < 0 || b < 0) throw new Error("could not lift 261 PART 2 — re-point liveNotify()");
  return s.slice(a, b);
}

// area_level_for as it is live: 254 PART 4 (219's body with the `phone` area), up to its comment.
function liveAreaLevel() {
  const s = READ("254_sss_phone.sql");
  const a = s.indexOf("create or replace function public.area_level_for(");
  const b = s.indexOf("comment on function public.area_level_for(", a);
  if (a < 0 || b < 0) throw new Error("could not lift 254 PART 4 — re-point liveAreaLevel()");
  return s.slice(a, b);
}

// usage_charges_enqueue as it is live: 259 PART 6's text exactly.
function liveEnqueue() {
  const s = READ("259_usage_billing.sql");
  const a = s.indexOf("create or replace function public.usage_charges_enqueue(");
  const b = s.indexOf("comment on function public.usage_charges_enqueue(", a);
  if (a < 0 || b < 0) throw new Error("could not lift 259's usage_charges_enqueue — re-point liveEnqueue()");
  return s.slice(a, b);
}

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
`;

// The live shapes (information_schema / pg_constraint after 261), cut to the columns 263, its
// RPCs and the trigger read. client_settings is service-role only, as it is live (checked
// 2026-10-04); grantBrowser breaks that on purpose for the assertion test.
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

create or replace function public.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(), business_name text,
  sms_number text, billing_exempt boolean not null default false,
  phone_status text not null default 'off',
  constraint client_settings_phone_status_chk check (phone_status = any (array['off','on']))
);
alter table public.client_settings enable row level security;
revoke all on public.client_settings from anon, authenticated;
${grantBrowser ? "grant select on public.client_settings to authenticated;" : ""}

create table public.client_users (
  user_id uuid primary key, client_id text not null, role text not null default 'owner',
  created_at timestamptz not null default now(), full_name text, phone text, title text,
  access jsonb, prefs jsonb, location_id uuid
);
create table public.crm_contacts (
  id uuid primary key default gen_random_uuid(), client_id text not null, name text, owner_user_id uuid
);
create table public.designs (
  id uuid primary key default gen_random_uuid(), short_code text not null unique, client_id text not null, contact_id uuid
);
create table public.sms_numbers (
  id uuid primary key default gen_random_uuid(), client_id text not null, phone_number text not null,
  twilio_sid text, messaging_service_sid text, registration_status text not null default 'pending_registration',
  purchased_at timestamptz not null default now(), released_at timestamptz, created_at timestamptz not null default now(),
  voice_enabled boolean not null default false, voice_configured_at timestamptz
);
create table public.phone_routes (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  number_id uuid not null unique references public.sms_numbers(id) on delete cascade,
  mode text not null default 'all_at_once', members uuid[] not null default '{}', ring_seconds integer not null default 20,
  no_answer text not null default 'voicemail', forward_to text, business_hours jsonb,
  time_zone text not null default 'America/Chicago', after_hours text not null default 'voicemail', greeting_url text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.phone_user_settings (
  user_id uuid primary key, client_id text not null, dnd boolean not null default false, dnd_until timestamptz,
  forward_to_cell text, device_generation integer not null default 1, updated_at timestamptz not null default now()
);
create table public.phone_calls (
  id uuid primary key default gen_random_uuid(), client_id text not null, number_id uuid references public.sms_numbers(id),
  contact_id uuid references public.crm_contacts(id), direction text not null check (direction in ('in', 'out')),
  from_e164 text not null default 'unknown', to_e164 text not null default 'unknown', twilio_call_sid text unique, client_call_sid text,
  placed_by uuid, answered_by uuid, rang_user_ids uuid[] not null default '{}', transferred_from uuid,
  transfer_state text check (transfer_state in ('transferring', 'conference')),
  status text not null default 'ringing'
    check (status in ('ringing', 'in_progress', 'completed', 'missed', 'voicemail', 'failed', 'busy', 'no_answer')),
  started_at timestamptz not null default now(), answered_at timestamptz, ended_at timestamptz, duration_s integer,
  cost_cents integer, error_code text, is_emergency boolean not null default false
);
alter table public.phone_calls enable row level security;
revoke all on public.phone_calls from anon, authenticated;
create table public.phone_voicemails (
  id uuid primary key default gen_random_uuid(), call_id uuid not null unique references public.phone_calls(id) on delete cascade,
  client_id text not null
);
create table public.sms_messages (
  id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid, short_code text,
  direction text not null, from_number text, to_number text, body text, status text not null default 'received',
  provider_sid text, sent_by uuid, created_at timestamptz not null default now()
);
create table public.email_sends (
  id uuid primary key default gen_random_uuid(), client_id text not null, short_code text, contact_id uuid,
  kind text not null default 'conversation', sent_by uuid
);
create table public.email_inbound (
  id uuid primary key default gen_random_uuid(), client_id text not null, short_code text, contact_id uuid, kind text
);

-- 259's billing tables, the columns 263 touches.
create table public.usage_prices (
  kind text primary key, label text not null, unit_label text not null default 'generation',
  price_cents integer not null check (price_cents >= 0), active boolean not null default false,
  visible boolean not null default true, sort_order integer not null default 0, note text,
  updated_at timestamptz not null default now(),
  pricing text not null default 'fixed' check (pricing in ('fixed', 'cost_plus'))
);
insert into public.usage_prices (kind, label, unit_label, price_cents, active, visible, sort_order, pricing) values
  ('voice_minute', 'Call minutes', 'minute', 0, false, true, 41, 'cost_plus'),
  ('voice_minute_in', 'Incoming call minutes', 'minute', 0, false, false, 43, 'cost_plus');
create table public.phone_billing_settings (
  id boolean primary key default true check (id), markup numeric(6,3), armed_at timestamptz, pilot_client_ids text[] not null default '{}'
);
insert into public.phone_billing_settings (id) values (true);
create table public.usage_charges (
  id bigint generated always as identity primary key,
  source text not null check (source in ('call', 'sms')),
  source_id uuid not null, client_id text not null,
  direction text not null check (direction in ('in', 'out')), occurred_at timestamptz not null,
  state text not null default 'pending', attempts integer not null default 0, next_try_at timestamptz not null default now(),
  lease_until timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint usage_charges_source_key unique (source, source_id)
);
alter table public.usage_charges enable row level security;
revoke all on public.usage_charges from anon, authenticated;
`;

// The five broadcast triggers as they are live (254 PART 7 and 261 PART 3).
const TRIGGERS = `
revoke execute on function public.phone_realtime_notify() from public, anon, authenticated;
create trigger phone_calls_realtime after insert or update or delete on public.phone_calls
  for each row execute function public.phone_realtime_notify();
create trigger phone_voicemails_realtime after insert or update or delete on public.phone_voicemails
  for each row execute function public.phone_realtime_notify();
create trigger sms_messages_phone_realtime after insert or update or delete on public.sms_messages
  for each row execute function public.phone_realtime_notify();
create trigger email_sends_phone_realtime after insert or update on public.email_sends
  for each row execute function public.phone_realtime_notify();
create trigger email_inbound_phone_realtime after insert on public.email_inbound
  for each row execute function public.phone_realtime_notify();
revoke execute on function public.usage_charges_enqueue(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.usage_charges_enqueue(timestamptz, integer) to service_role;
`;

const T = "demo-tenant";
const NUMBER = "00000000-0000-4000-8000-00000000a001";
const E164 = "+15555550100";
const CUSTOMER = "+15555550142";
const CONTACT = "00000000-0000-4000-8000-0000000000c1";
const U = {
  owner: "00000000-0000-4000-8000-000000000001",
  rep: "00000000-0000-4000-8000-000000000002",
  mate: "00000000-0000-4000-8000-000000000003",
};

const SEED = `
insert into public.client_settings (client_id, business_name, phone_status, sms_number) values
  ('${T}', 'Demo Sheds', 'on', '${E164}'), ('other-tenant', 'Other Sheds', 'on', null), ('quiet-tenant', 'Quiet Sheds', 'off', null);
insert into public.client_users (user_id, client_id, role, title, full_name) values
  ('${U.owner}', '${T}', 'owner', 'owner', 'Olive Owner'), ('${U.rep}', '${T}', 'user', 'sales_rep', 'Rex Rep'),
  ('${U.mate}', 'no-settings-tenant', 'owner', 'owner', 'Nora Nosettings');
insert into public.crm_contacts (id, client_id, name, owner_user_id) values ('${CONTACT}', '${T}', 'Cam Customer', '${U.owner}');
insert into public.sms_numbers (id, client_id, phone_number, voice_enabled) values ('${NUMBER}', '${T}', '${E164}', true);
insert into public.phone_routes (client_id, number_id, members) values ('${T}', '${NUMBER}', array['${U.owner}', '${U.rep}']::uuid[]);
-- Calls from before 263: they must stay unarmed.
insert into public.phone_calls (client_id, number_id, direction, from_e164, to_e164, status, started_at, ended_at)
  select '${T}', '${NUMBER}', 'in', '${CUSTOMER}', '${E164}', 'completed', now() - interval '1 day', now() - interval '1 day'
    from generate_series(1, 3);
`;

async function makeDb({ withPartition = true, grantBrowser = false } = {}) {
  const db = new PGlite();
  await db.exec(STUBS(grantBrowser));
  await db.exec(LIVE);
  await db.exec(liveAreaLevel());
  await db.exec(liveNotify());
  await db.exec(liveEnqueue());
  await db.exec(TRIGGERS);
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

(async () => {
  // ── 1. Live as it is: Realtime has today's partition ─────────────────────────────────
  console.log("migration 263: applies on the live shape (realtime has a partition)");
  const db = await makeDb();
  let notices = [];
  try { notices = await apply(db); ok(true, "263 applied cleanly, assertions and probe included"); }
  catch (e) { ok(false, "263 applied", e.message); process.exit(1); }
  ok(notices.some((n) => /263 probe: a recording is told as its call/.test(n)), "the probe ran its broadcast checks", notices.join(" | "));
  ok(notices.some((n) => /nothing was kept/.test(n)), "the probe rolled back");
  ok(!notices.some((n) => /WarnSendingBroadcastMessage|phone_realtime_notify\(/.test(n)), "no send failed and the trigger raised no warning", notices.join(" | "));
  const left = await one(db, `select
    (select count(*)::int from public.client_settings where client_id like 'phone-recording-probe%') cs,
    (select count(*)::int from public.phone_calls where client_id like 'phone-recording-probe%') c,
    (select count(*)::int from public.phone_call_recordings) r,
    (select count(*)::int from public.usage_charges) u,
    (select count(*)::int from realtime.messages) m`);
  ok(Object.values(left).every((v) => v === 0), "the probe left nothing behind, realtime.messages included", JSON.stringify(left));

  console.log(" the settings");
  const cs = await one(db, `select phone_record_calls, phone_recording_notice, phone_recording_notice_text, phone_transcribe_calls,
      phone_recording_retention_days, phone_recording_updated_at, phone_recording_updated_by from public.client_settings where client_id = '${T}'`);
  ok(cs.phone_record_calls === false && cs.phone_recording_notice === true && cs.phone_recording_notice_text === null
    && cs.phone_transcribe_calls === true && cs.phone_recording_retention_days === 365 && cs.phone_recording_updated_by === null,
    "every business starts OFF, announcement on, transcripts on, 365 days", JSON.stringify(cs));
  ok((await one(db, "select bool_and(not recording_armed) b, count(*)::int n from public.phone_calls")).b === true, "every call from before 263 is unarmed");
  await refused(db, `update public.client_settings set phone_recording_notice_text = 'Too short' where client_id = '${T}'`,
    /client_settings_phone_recording_notice_text_chk/, "a 9-character announcement is refused");
  await refused(db, `update public.client_settings set phone_recording_notice_text = '   ' || repeat('x', 8) || '   ' where client_id = '${T}'`,
    /client_settings_phone_recording_notice_text_chk/, "padding does not count toward the 10 characters");
  await refused(db, `update public.client_settings set phone_recording_notice_text = repeat('r', 301) where client_id = '${T}'`,
    /client_settings_phone_recording_notice_text_chk/, "a 301-character announcement is refused");
  await refused(db, `update public.client_settings set phone_recording_retention_days = 60 where client_id = '${T}'`,
    /client_settings_phone_recording_retention_chk/, "a retention outside 30/90/180/365/730 is refused");
  await db.exec(`update public.client_settings set phone_recording_notice_text = repeat('r', 300), phone_recording_retention_days = 730 where client_id = '${T}'`);
  ok(true, "300 characters and 730 days fit");

  console.log(" the RPCs");
  let route = (await one(db, `select public.phone_route_for_number('${E164}') r`)).r;
  ok(JSON.stringify(route.recording) === JSON.stringify({ on: false, notice: true, transcribe: true, notice_text: "r".repeat(300) }),
    "phone_route_for_number returns recording {on, notice, notice_text, transcribe}", JSON.stringify(route.recording));
  ok(route.members.length === 2 && route.business_name === "Demo Sheds" && route.phone_status === "on" && route.recent_emergency_user === null,
    "and everything 254 returned is still there", JSON.stringify(Object.keys(route)));
  await db.exec(`update public.client_settings set phone_record_calls = true, phone_transcribe_calls = false, phone_recording_notice_text = null where client_id = '${T}'`);
  route = (await one(db, `select public.phone_route_for_number('${E164}') r`)).r;
  ok(route.recording.on === true && route.recording.transcribe === false && route.recording.notice_text === null, "a business that turned it on reads on", JSON.stringify(route.recording));
  let ctx = (await one(db, `select public.phone_caller_context('${U.rep}') c`)).c;
  ok(ctx.recording.on === true && ctx.recording.transcribe === false && ctx.recording.notice === true && ctx.phone_level === "own" && ctx.number.e164 === E164,
    "phone_caller_context returns the same recording block beside 254's keys", JSON.stringify(ctx));
  ctx = (await one(db, `select public.phone_caller_context('${U.mate}') c`)).c;
  ok(JSON.stringify(ctx.recording) === JSON.stringify({ on: false, notice: true, transcribe: true, notice_text: null }),
    "a team with no settings row reads off with the defaults", JSON.stringify(ctx.recording));

  console.log(" one recording per call, and the queue");
  const svc = async (sql) => {
    await db.exec("set role service_role");
    try { return (await db.query(sql)).rows; } finally { await db.exec("reset role"); }
  };
  const callId = (await svc(`insert into public.phone_calls (client_id, number_id, contact_id, direction, from_e164, to_e164, answered_by,
      rang_user_ids, status, recording_armed) values ('${T}', '${NUMBER}', '${CONTACT}', 'in', '${CUSTOMER}', '${E164}', '${U.rep}',
      array['${U.owner}', '${U.rep}']::uuid[], 'in_progress', true) returning id`))[0].id;
  await db.exec("delete from realtime.messages");
  // The Worker's claim: insert ... on conflict (call_id) do nothing returning id.
  const claim1 = await svc(`insert into public.phone_call_recordings (call_id, client_id, status, notice_text)
    values ('${callId}', '${T}', 'starting', 'This call will be recorded.') on conflict (call_id) do nothing returning id`);
  const claim2 = await svc(`insert into public.phone_call_recordings (call_id, client_id, status)
    values ('${callId}', '${T}', 'starting') on conflict (call_id) do nothing returning id`);
  ok(claim1.length === 1 && claim2.length === 0, "a second answer claims nothing: one recording per call");
  const recId = claim1[0].id;
  const msgs = async () => (await db.query("select topic, event, payload, private from realtime.messages order by topic")).rows;
  let m = await msgs();
  ok(m.length === 3 && m.every((r) => r.event === "call" && r.private && r.payload.table === "phone_calls" && r.payload.op === "UPDATE"
    && r.payload.id === callId && r.payload.contact_id === CONTACT && Object.keys(r.payload).sort().join() === "contact_id,id,op,table"),
    "a new recording is told as its call (ids only, private), to the team, who answered, who it rang and the owner", JSON.stringify(m.map((r) => [r.topic, r.payload])));
  ok(m.map((r) => r.topic).join() === [`phone:${T}`, `phone:user:${U.owner}`, `phone:user:${U.rep}`].sort().join(), "the right topics", m.map((r) => r.topic).join());

  await db.exec("delete from realtime.messages");
  await svc(`update public.phone_call_recordings set recording_sid = 'RE${"0".repeat(31)}1', started_at = now(), status = 'recording' where id = '${recId}'`);
  ok((await msgs()).length === 3, "starting → recording tells them again (the in-call chip)");
  await db.exec("delete from realtime.messages");
  await svc(`update public.phone_call_recordings set lease_until = now() + interval '5 minutes', attempts = attempts + 1, next_try_at = now(),
    last_error = 'x', summary_next_at = now() where id = '${recId}'`);
  ok((await msgs()).length === 0, "the queue's own writes (lease, attempts, next try, error) tell nobody");
  await svc(`update public.phone_call_recordings set lease_until = null, attempts = 0, next_try_at = null, last_error = null, summary_next_at = null where id = '${recId}'`);

  // Completed: the transcript is due.
  await svc(`update public.phone_call_recordings set status = 'completed', duration_s = 125, completed_at = now(),
    transcript_status = 'pending', next_try_at = now() - interval '1 second' where id = '${recId}'`);
  await svc(`update public.phone_calls set status = 'completed', ended_at = now(), duration_s = 125 where id = '${callId}'`);
  let claimed = await svc("select id, transcript_status, attempts, lease_until > now() leased from public.phone_recordings_claim(2, 300)");
  ok(claimed.length === 1 && claimed[0].id === recId && claimed[0].transcript_status === "working" && claimed[0].attempts === 1 && claimed[0].leased,
    "phone_recordings_claim leases the completed recording, working, attempt 1", JSON.stringify(claimed));
  ok((await svc("select id from public.phone_recordings_claim(2, 300)")).length === 0, "a leased row is not claimed again");
  await svc(`update public.phone_call_recordings set lease_until = now() - interval '1 second' where id = '${recId}'`);
  claimed = await svc("select id, attempts from public.phone_recordings_claim(2, 300)");
  ok(claimed.length === 1 && claimed[0].attempts === 2, "a lapsed lease is claimable again (the run that held it died)", JSON.stringify(claimed));
  await refused(db, "select public.phone_recordings_claim(0, 300)", /p_limit must be 1\.\.50/, "a nonsense limit is refused");

  // The summary claim.
  await svc(`update public.phone_call_recordings set transcript_status = 'done', transcript = 'Customer: Hello.\nTeam: Hi there.',
    summary_status = 'pending', lease_until = null, stt_cost_micros = 31200 where id = '${recId}'`);
  let s = (await svc(`select public.phone_recording_summary_claim('${recId}', 90) s`))[0].s;
  ok(s && s.transcript === "Customer: Hello.\nTeam: Hi there." && s.direction === "in" && s.summary_attempts === 1 && s.duration_s === 125 && s.client_id === T,
    "the summary claim hands over the transcript, direction and attempt", JSON.stringify(s));
  ok((await svc(`select public.phone_recording_summary_claim('${recId}', 90) s`))[0].s === null, "asked again while it works: nothing (Claude is asked once)");
  await svc(`update public.phone_call_recordings set lease_until = now() - interval '1 second' where id = '${recId}'`);
  ok((await svc(`select public.phone_recording_summary_claim('${recId}', 90) s`))[0].s?.summary_attempts === 2, "a lapsed summary lease can be claimed again");
  ok((await svc(`select public.phone_recording_summary_claim(null, 90) s`))[0].s === null, "a null id claims nothing");
  await refused(db, `insert into public.phone_call_recordings (call_id, client_id, summary) values ('${callId}', '${T}', repeat('s', 1201))`,
    /phone_call_recordings_summary_check|violates check constraint/, "a summary over 1,200 characters is refused");
  await svc(`update public.phone_call_recordings set summary_status = 'done', summary = 'Cam asked about a 12x24.', llm_cost_micros = 2400, lease_until = null where id = '${recId}'`);

  console.log(" the meters");
  let n = (await svc(`select public.usage_charges_enqueue(now() - interval '3 days', 500) n`))[0].n;
  const q = await svc("select source, source_id, direction, client_id from public.usage_charges order by source, source_id");
  ok(n === 6 && q.filter((r) => r.source === "call").length === 4, "the enqueue still queues the finished calls", JSON.stringify(q));
  ok(q.some((r) => r.source === "recording" && r.source_id === recId && r.direction === "in")
    && q.some((r) => r.source === "transcription" && r.source_id === recId && r.direction === "in"),
    "and the recording and its transcript, apart, with the call's direction", JSON.stringify(q));
  ok((await svc(`select public.usage_charges_enqueue(now() - interval '3 days', 500) n`))[0].n === 0, "a second run queues nothing again");
  const prices = await svc("select kind, active, visible, pricing, unit_label from public.usage_prices where kind like 'call_%' order by kind");
  ok(prices.length === 2 && prices.every((p) => !p.active && !p.visible && p.pricing === "cost_plus" && p.unit_label === "minute"),
    "call_recording and call_transcription exist, inactive, invisible, cost_plus, per minute", JSON.stringify(prices));
  // 259's ARMING step 2 (a markup, armed_at, one pilot tenant) arms that tenant's calls, never the
  // two recording meters while they are inactive; activating one arms it for everyone.
  await db.exec(`update public.phone_billing_settings set markup = 2, armed_at = now(), pilot_client_ids = array['${T}'] where id`);
  const armedQ = `select public.phone_usage_armed('${T}', 'voice_minute') vm, public.phone_usage_armed('${T}', 'call_recording') rec,
    public.phone_usage_armed('${T}', 'call_transcription') tr, public.phone_usage_armed('other-tenant', 'voice_minute') other,
    public.phone_usage_armed('other-tenant', 'call_recording') other_rec`;
  let armed = (await svc(armedQ))[0];
  ok(armed.vm === true && armed.rec === false && armed.tr === false && armed.other === false && armed.other_rec === false,
    "a pilot arms the pilot tenant's call minutes, not its recordings or transcripts", JSON.stringify(armed));
  await db.exec("update public.usage_prices set active = true where kind = 'call_recording'");
  armed = (await svc(armedQ))[0];
  ok(armed.rec === true && armed.other_rec === true && armed.tr === false, "an active recording meter is armed for every tenant, as 259's are", JSON.stringify(armed));
  await db.exec("update public.usage_prices set active = false where kind = 'call_recording'");
  await db.exec("update public.phone_billing_settings set markup = null, armed_at = null, pilot_client_ids = '{}' where id");
  await refused(db, `insert into public.usage_charges (source, source_id, client_id, direction, occurred_at) values ('fax', gen_random_uuid(), '${T}', 'in', now())`,
    /usage_charges_source_check/, "an unknown source is still refused");

  console.log(" retention");
  await db.exec(`update public.client_settings set phone_recording_retention_days = 30 where client_id = '${T}'`);
  const oldCall = (await svc(`insert into public.phone_calls (client_id, direction, status, started_at, ended_at)
    values ('${T}', 'out', 'completed', now() - interval '45 days', now() - interval '45 days') returning id`))[0].id;
  const oldRec = (await svc(`insert into public.phone_call_recordings (call_id, client_id, recording_sid, status, completed_at)
    values ('${oldCall}', '${T}', 'RE${"0".repeat(31)}2', 'completed', now() - interval '45 days') returning id`))[0].id;
  const otherCall = (await svc(`insert into public.phone_calls (client_id, direction, status) values ('other-tenant', 'in', 'completed') returning id`))[0].id;
  await svc(`insert into public.phone_call_recordings (call_id, client_id, recording_sid, status, completed_at)
    values ('${otherCall}', 'other-tenant', 'RE${"0".repeat(31)}3', 'completed', now() - interval '45 days')`);
  const liveCall = (await svc(`insert into public.phone_calls (client_id, direction, status) values ('${T}', 'in', 'in_progress') returning id`))[0].id;
  await svc(`insert into public.phone_call_recordings (call_id, client_id, recording_sid, status, started_at, created_at)
    values ('${liveCall}', '${T}', 'RE${"0".repeat(31)}4', 'recording', now() - interval '31 days', now() - interval '30 days 12 hours')`);
  const exp = await svc("select id, client_id from public.phone_recordings_expired(now(), 100)");
  ok(exp.length === 1 && exp[0].id === oldRec, "a 30-day business's 45-day-old recording is due; another business's (365 days) and a live one are not", JSON.stringify(exp));
  await svc(`update public.phone_call_recordings set deleted_at = now(), transcript = null where id = '${oldRec}'`);
  ok((await svc("select id from public.phone_recordings_expired(now(), 100)")).length === 0, "once deleted it is not listed again");

  console.log(" grants");
  const priv = await one(db, `select
    has_table_privilege('anon','public.phone_call_recordings','SELECT') a, has_table_privilege('authenticated','public.phone_call_recordings','SELECT') u,
    has_column_privilege('authenticated','public.client_settings','phone_record_calls','SELECT') cs,
    has_function_privilege('authenticated','public.phone_recordings_claim(integer, integer)','EXECUTE') f1,
    has_function_privilege('anon','public.phone_recording_summary_claim(uuid, integer)','EXECUTE') f2,
    has_function_privilege('authenticated','public.phone_recordings_expired(timestamptz, integer)','EXECUTE') f3,
    has_function_privilege('authenticated','public.phone_route_for_number(text)','EXECUTE') f4,
    has_function_privilege('authenticated','public.phone_caller_context(uuid)','EXECUTE') f5,
    has_function_privilege('authenticated','public.usage_charges_enqueue(timestamptz, integer)','EXECUTE') f6,
    has_function_privilege('authenticated','public.phone_realtime_notify()','EXECUTE') f7`);
  ok(Object.values(priv).every((v) => v === false), "the browser roles hold nothing: the table, the settings, every function", JSON.stringify(priv));
  await refused(db, "set role authenticated; select transcript from public.phone_call_recordings limit 1", /permission denied/, "authenticated cannot read a transcript");
  await refused(db, "set role anon; select public.phone_recording_summary_claim(gen_random_uuid(), 90)", /permission denied/, "anon cannot claim a summary");

  console.log(" a call delete takes its recording");
  await svc(`delete from public.phone_calls where id = '${oldCall}'`);
  ok((await one(db, `select count(*)::int n from public.phone_call_recordings where id = '${oldRec}'`)).n === 0, "ON DELETE CASCADE");

  let again = true;
  try { await apply(db); } catch (e) { again = false; ok(false, "re-apply", e.message); }
  ok(again, "a second apply is harmless (with live recordings and charges in the tables)");
  ok((await one(db, "select count(*)::int n from pg_constraint where conrelid = 'public.client_settings'::regclass and contype = 'c' and conname like 'client_settings_phone_recording_%'")).n === 2,
    "the re-apply added no second copy of either check");
  ok((await one(db, "select count(*)::int n from pg_trigger where tgrelid = 'public.phone_call_recordings'::regclass and not tgisinternal")).n === 3,
    "nor a second trigger");
  await db.close();

  // ── 2. No partition: the probe says so and still passes ─────────────────────────────
  console.log("migration 263: realtime.messages has no partition for today");
  {
    const db2 = await makeDb({ withPartition: false });
    let n2 = [];
    try { n2 = await apply(db2); ok(true, "applied"); } catch (e) { ok(false, "applied without a partition", e.message); }
    ok(n2.some((x) => /broadcast checks were skipped/.test(x)), "the probe said it skipped the broadcast checks", n2.join(" | "));
    ok(n2.some((x) => /nothing was kept/.test(x)), "and still checked the queue and rolled back");
    await db2.close();
  }

  // ── 3. The assertions abort the whole migration ─────────────────────────────────────
  console.log("migration 263: the assertions abort the whole migration");
  {
    const db3 = await makeDb({ grantBrowser: true });
    let err = null;
    try { await apply(db3); } catch (e) { err = e; }
    ok(!!err && /263: authenticated can read or write client_settings\.phone_record_calls/.test(err.message), "a browser-readable client_settings stops the apply", err && err.message);
    try { await db3.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const gone = await one(db3, `select to_regclass('public.phone_call_recordings') t,
      (select count(*)::int from information_schema.columns where table_name = 'client_settings' and column_name = 'phone_record_calls') c`);
    ok(gone.t === null && gone.c === 0, "and nothing of it is left behind", JSON.stringify(gone));
    await db3.close();
  }

  // ── 4. Mutants: each broken copy must be refused by an assertion or the probe ─────────
  console.log("migration 263: broken copies are refused");
  const src = MIG_TEXT();
  const mutants = [
    ["the table left readable from the browser", "revoke all on public.phone_call_recordings from anon, authenticated;\n", ""],
    ["two recordings per call", "call_id           uuid not null unique references", "call_id           uuid not null references"],
    ["the recording does not go with its call", "references public.phone_calls(id) on delete cascade,\n  client_id         text not null,\n  recording_sid",
      "references public.phone_calls(id),\n  client_id         text not null,\n  recording_sid"],
    ["every queue write broadcasts", "  when (old.status            is distinct from new.status\n     or (old.transcript_status is distinct from new.transcript_status\n         and not (old.transcript_status in ('pending', 'working') and new.transcript_status in ('pending', 'working')))\n     or (old.summary_status    is distinct from new.summary_status\n         and not (old.summary_status in ('pending', 'working') and new.summary_status in ('pending', 'working')))\n     or old.deleted_at        is distinct from new.deleted_at)\n", ""],
    ["a claim (pending to working) broadcasts", "\n         and not (old.transcript_status in ('pending', 'working') and new.transcript_status in ('pending', 'working')))", ")"],
    ["the recordings branch never runs", "elsif tg_table_name = 'phone_call_recordings' then", "elsif tg_table_name = 'phone_call_recordings' and false then"],
    ["a recording told as itself", "v_table   := 'phone_calls';", "v_table   := null;"],
    ["the email branch lost", "elsif tg_table_name in ('email_sends', 'email_inbound') then", "elsif tg_table_name in ('email_sends_x') then"],
    ["a leased row claimed twice", "and (r.lease_until is null or r.lease_until < pg_catalog.now())\n       order by", "\n       order by"],
    ["a summary claimed twice", "or (r.summary_status = 'working' and (r.lease_until is null or r.lease_until < pg_catalog.now())))",
      "or r.summary_status = 'working')"],
    ["retention ignores the business's days", "< p_now - pg_catalog.make_interval(days => coalesce(cs.phone_recording_retention_days, 365))\n     and",
      "< p_now - pg_catalog.make_interval(days => 365)\n     and"],
    ["the enqueue skips recordings", "         and r.status = 'completed'\n         and not exists", "         and false\n         and not exists"],
    ["the source check not widened", "check (source in ('call', 'sms', 'recording', 'transcription'));", "check (source in ('call', 'sms', 'recording'));"],
    ["the route RPC lost recording", "    'recent_emergency_user', v_emergency,\n    'recording',", "    'recent_emergency_user', v_emergency,\n    'recordingx',"],
    ["a claim callable from the browser", "revoke execute on function public.phone_recordings_claim(integer, integer) from public, anon, authenticated;",
      "grant execute on function public.phone_recordings_claim(integer, integer) to authenticated;"],
    ["the notice check off by one", "between 10 and 300) not valid", "between 9 and 300) not valid"],
    ["the meters shipped active", "0, false, false, 44,", "0, true, false, 44,"],
    ["a pilot arms the recording meters (259's clause)",
      "            or (p_meter = any (array['voice_minute', 'voice_minute_in', 'sms_segment', 'sms_in'])\n                and coalesce(p_client_id = any (s.pilot_client_ids), false)))",
      "            or coalesce(p_client_id = any (s.pilot_client_ids), false))  -- 'sms_in'"],
    ["recording defaults on", "phone_record_calls             boolean not null default false", "phone_record_calls             boolean not null default true"],
  ];
  for (const [label, from, to] of mutants) {
    if (!src.includes(from)) { ok(false, `mutant "${label}": anchor not found — re-point it`); continue; }
    const mdb = await makeDb();
    let err = null;
    try { await apply(mdb, src.replace(from, to)); } catch (e) { err = e; }
    ok(!!err && /263/.test(err.message), `refused: ${label}`, err ? err.message.slice(0, 160) : "applied cleanly");
    await mdb.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
