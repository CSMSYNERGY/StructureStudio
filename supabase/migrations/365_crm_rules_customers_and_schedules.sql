-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 365 — AUTOMATIONS, ROUND 2a: customers, schedules, the new facts, and the new actions
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Ledger read before writing: max = 364 (364_no_shed_product, another agent's billing change).
-- So 365. 363 was renumbered once already because two agents shared a number — read the ledger
-- AGAIN immediately before applying, not when you start writing.
--
-- ── WHY (Carolyn, 2026-11-04 / -05) ──────────────────────────────────────────────────────
-- Round 2 of the plan she approved (~/.claude/plans/ok-thanks-found-it-cuddly-newell.md). 363 let a
-- rule say who it is for and switched on two of her four answers: one pipeline, every pipeline.
-- This switches on the other two — "customers matching…" and "nobody, just notify the team" —
-- and the things they need:
--   • a SCHEDULE trigger ("every Monday at 8:00", or "on the date in their record"), in the
--     account's own time zone (363 added client_settings.time_zone; this is the first reader);
--   • the facts the product records but never raised as events: a contact added, a tag added,
--     a form submitted, a missed call, a voicemail, a text received, a meeting booked /
--     cancelled / completed / no-show, a card changing stage, being marked lost or reopened;
--   • the actions she listed: add or remove a tag, assign an owner, create a task (it shows
--     under the customer's Planned section), and tell the team.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1  crm_rules: schedule + next_run_at; the trigger CHECKs widened
--   PART 2  the action and outbox vocabularies widened
--   PART 3  THE EVENT QUEUE, and the triggers that fill it
--   PART 4  the evaluator: facts, the new actions, the 'none' scope, once-a-day for inbound
--   PART 5  schedules: next_run, the audience, the preview
--   PART 6  the sweep: cards, customers, schedules
--   PART 7  checks, rehearsed on a made-up account and deleted
--
-- ── THE FOUR THINGS THAT KEEP THIS FROM HURTING A BUILDER'S CUSTOMERS ───────────────────
-- 1. NEW FACTS ARE QUEUED, NOT EVALUATED where they happen. A missed call or an incoming text is
--    written by the phone Worker while Twilio waits for an answer; a rule must never add work or
--    a failure to that write. Each trigger does one guarded insert into crm_rule_events, and
--    crm-rules-tick drains the queue. (The eight design events stay in-transaction, as 355 built.)
-- 2. A SCHEDULE FIRES ONCE PER CUSTOMER PER CALENDAR DAY, keyed by the LOCAL date — so a daylight
--    saving change or a time-zone change can never make the same Monday happen twice — and
--    next_run_at is always the first occurrence AFTER now: a rule paused for two months and
--    resumed gets one future Monday, never nine. A tick more than six hours late skips the
--    occurrence rather than sending yesterday's 8am text at 3pm.
-- 3. A SCHEDULE THAT MESSAGES CUSTOMERS MUST BE ARMED. Every matching customer shares one
--    instant, so the first Monday IS the mass send; the forward-only guard cannot help. The
--    editor shows the audience count and the builder arms it with that number on screen
--    (crm_rules.armed_count, laid in 363 and withdrawn by any change to who the rule reaches).
--    The sweep refuses an unarmed one and logs why. At most max_per_run (default 200) per tick;
--    the rest go on the next ticks under the same occurrence — nobody dropped, nobody twice.
-- 4. INBOUND FACTS ONLY EVER REACH KNOWN CUSTOMERS, AT MOST ONCE A DAY. A text or call with no
--    contact is never queued (sms-inbound: "THIS FUNCTION MUST NEVER SEND ANYTHING" to strangers —
--    that is how the shared A2P campaign gets flagged); an incoming text within a minute of our
--    own outbound to that customer is not queued either (two auto-replies cannot ping-pong); and
--    a rule set to "every time" fires at most once per customer per day on these three events.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Additive. Every existing rule keeps its meaning (no schedule; next_run_at stays NULL). The live
-- crm-rules-tick keeps working until redeployed: it does not drain the queue, so facts wait in it
-- (they are fired late, not lost — see crm_rules_drain_events) until the new tick deploys.
--
-- ── REVERSE (only if this has to be undone) ──────────────────────────────────────────────
--   -- delete rules with trigger_kind 'schedule', scope 'contacts'/'none', or a new event/action;
--   -- drop the queue triggers and their functions (crm_rule_enqueue_*), crm_rule_events,
--   -- crm_rules_drain_events, crm_rule_next_run, crm_rule_date_matches, crm_rule_audience,
--   -- crm_rule_audience_preview, the client_settings tz trigger; re-issue crm_rules_run,
--   -- crm_rule_facts, crm_rules_sweep and crm_rules_guard_reset from 363; restore 363's CHECKs.
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'crm_rules' and column_name = 'scope_kind') then
    raise exception '365: crm_rules.scope_kind is missing (migration 363 not applied)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'client_settings' and column_name = 'time_zone') then
    raise exception '365: client_settings.time_zone is missing (migration 363 not applied)';
  end if;
end $$;

-- ── PART 1 — crm_rules ───────────────────────────────────────────────────────────────────
-- {freq: daily|weekly|monthly|yearly|date_field, at: "HH:MM", days: [1..7 ISO, Monday = 1],
--  every: n (weekly), dayOfMonth: 1..31 (monthly), month + day (yearly),
--  field: "custom:<key>", offsetDays: n, yearly: bool (date_field)}. Shape validated by
-- parseRuleSchedule in _shared/crmRules.ts; the database keeps "is an object".
alter table public.crm_rules add column if not exists schedule    jsonb;
alter table public.crm_rules add column if not exists next_run_at timestamptz;

alter table public.crm_rules drop constraint if exists crm_rules_trigger_kind_check;
alter table public.crm_rules add constraint crm_rules_trigger_kind_check
  check (trigger_kind in ('event', 'elapsed', 'schedule'));
alter table public.crm_rules drop constraint if exists crm_rules_trigger_shape;
alter table public.crm_rules add constraint crm_rules_trigger_shape check (
     (trigger_kind = 'event'    and trigger_event is not null and elapsed_anchor is null and elapsed_days is null and schedule is null)
  or (trigger_kind = 'elapsed'  and trigger_event is null and elapsed_anchor is not null and elapsed_days is not null and schedule is null)
  or (trigger_kind = 'schedule' and trigger_event is null and elapsed_anchor is null and elapsed_days is null
      and schedule is not null and jsonb_typeof(schedule) = 'object'));
-- The vocabulary lives in RULE_EVENTS + RULE_CONTACT_EVENTS (_shared/crmRules.ts); this mirrors it.
alter table public.crm_rules drop constraint if exists crm_rules_trigger_event_check;
alter table public.crm_rules add constraint crm_rules_trigger_event_check check (trigger_event is null or trigger_event in (
  'design_submitted', 'estimate_sent', 'estimate_accepted', 'invoiced', 'paid_in_full', 'build_scheduled', 'delivered', 'contact_made',
  'contact_created', 'label_added', 'form_submitted',
  'call_missed', 'voicemail_left', 'text_received',
  'meeting_booked', 'meeting_cancelled', 'meeting_completed', 'meeting_no_show',
  'stage_changed', 'deal_lost', 'deal_reopened'));
alter table public.crm_rules drop constraint if exists crm_rules_elapsed_anchor_check;
alter table public.crm_rules add constraint crm_rules_elapsed_anchor_check check (elapsed_anchor is null
  or elapsed_anchor in ('delivered', 'stage_entered', 'last_contact', 'expected_close', 'contact_created'));
-- A card's anchors need a card. A customer rule can count only from things a customer has.
alter table public.crm_rules drop constraint if exists crm_rules_anchor_fits_scope;
alter table public.crm_rules add constraint crm_rules_anchor_fits_scope check (
  elapsed_anchor is null or scope_kind <> 'contacts' or elapsed_anchor in ('last_contact', 'contact_created'));
-- A SCHEDULE IS ALWAYS ONCE per subject per occurrence — the same reasoning as 355's
-- crm_rules_elapsed_is_once: without the guard a slow tick and the next one would both fire.
alter table public.crm_rules drop constraint if exists crm_rules_schedule_is_once;
alter table public.crm_rules add constraint crm_rules_schedule_is_once check (trigger_kind <> 'schedule' or once_per_card);
-- 363 made 'none' unsaveable until schedules existed. They do now; the CHECK stays as it is.
create index if not exists crm_rules_schedule_idx
  on public.crm_rules (next_run_at) where archived_at is null and enabled and trigger_kind = 'schedule';

-- ── PART 2 — the action and outbox vocabularies ──────────────────────────────────────────
alter table public.crm_rule_actions drop constraint if exists crm_rule_actions_kind_check;
alter table public.crm_rule_actions add constraint crm_rule_actions_kind_check check (kind in (
  'set_status', 'move_stage', 'mark_lost', 'reopen', 'set_follow_up', 'set_close_date', 'add_note', 'create_card',
  'add_label', 'remove_label', 'assign_owner', 'create_task',
  'send_sms', 'send_email', 'notify_team'));
-- notify_team has no customer; 363 already made contact_id nullable for it.
alter table public.crm_rule_outbox drop constraint if exists crm_rule_outbox_kind_check;
alter table public.crm_rule_outbox add constraint crm_rule_outbox_kind_check check (kind in ('send_sms', 'send_email', 'notify_team'));

-- ── PART 3 — THE EVENT QUEUE ─────────────────────────────────────────────────────────────
-- See the header, point 1. One row per fact; crm_rules_drain_events fires them on the tick.
create table if not exists public.crm_rule_events (
  id           bigserial primary key,
  client_id    text not null,
  event        text not null,
  contact_id   uuid,
  deal_id      uuid,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists crm_rule_events_queue_idx on public.crm_rule_events (id) where processed_at is null;
create index if not exists crm_rule_events_done_idx on public.crm_rule_events (processed_at) where processed_at is not null;
alter table public.crm_rule_events enable row level security;
revoke all on public.crm_rule_events from anon, authenticated;

-- ⛔ NEVER FAILS THE WRITE IT RIDES ON (302:42-44, 353's triggers). And it QUEUES ONLY when the
-- account has a live rule waiting for this fact, so an account with no automations pays one
-- indexed lookup per write and stores nothing.
create or replace function public.crm_rule_enqueue(p_client text, p_event text, p_contact uuid, p_deal uuid default null, p_payload jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  if p_client is null or (p_contact is null and p_deal is null) then return; end if;
  if not exists (select 1 from public.crm_rules
                  where client_id = p_client and archived_at is null and enabled
                    and trigger_kind = 'event' and trigger_event = p_event) then
    return;
  end if;
  insert into public.crm_rule_events (client_id, event, contact_id, deal_id, payload)
  values (p_client, p_event, p_contact, p_deal, coalesce(p_payload, '{}'::jsonb));
exception when others then
  begin
    insert into public.app_errors (client_id, source, severity, code, message, context)
    values (p_client, 'db:crm_rule_enqueue', 'error', 'crm_rule_enqueue_failed', 'crm_rule_enqueue: ' || sqlerrm,
            jsonb_build_object('sqlstate', sqlstate, 'event', p_event));
  exception when others then null;
  end;
end;
$fn$;
revoke execute on function public.crm_rule_enqueue(text, text, uuid, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_rule_enqueue(text, text, uuid, uuid, jsonb) to service_role;

-- A contact added, and a TAG added (one fact per tag that is new — labels are a text[]).
create or replace function public.crm_rule_on_contact()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare l text;
begin
  if new.merged_into is not null then return null; end if;
  if tg_op = 'INSERT' then
    perform public.crm_rule_enqueue(new.client_id, 'contact_created', new.id, null, jsonb_build_object('source', new.source));
    for l in select distinct btrim(x) from unnest(coalesce(new.labels, '{}')) x where nullif(btrim(x), '') is not null loop
      perform public.crm_rule_enqueue(new.client_id, 'label_added', new.id, null, jsonb_build_object('label', l));
    end loop;
  elsif new.labels is distinct from old.labels then
    for l in select distinct btrim(x) from unnest(coalesce(new.labels, '{}')) x
              where nullif(btrim(x), '') is not null
                and not exists (select 1 from unnest(coalesce(old.labels, '{}')) o where lower(btrim(o)) = lower(btrim(x))) loop
      perform public.crm_rule_enqueue(new.client_id, 'label_added', new.id, null, jsonb_build_object('label', l));
    end loop;
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_contact on public.crm_contacts;
create trigger crm_rule_on_contact after insert or update of labels on public.crm_contacts
  for each row execute function public.crm_rule_on_contact();

-- A form submitted: the contact is set by a SECOND write (lead-form/index.ts), so this fires on
-- the write that sets it, once, and never for a submission marked spam.
create or replace function public.crm_rule_on_form()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if new.contact_id is not null and not new.spam
     and (tg_op = 'INSERT' or old.contact_id is null) then
    perform public.crm_rule_enqueue(new.client_id, 'form_submitted', new.contact_id, new.deal_id, jsonb_build_object('form_id', new.form_id));
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_form on public.lead_form_submissions;
create trigger crm_rule_on_form after insert or update of contact_id on public.lead_form_submissions
  for each row execute function public.crm_rule_on_form();

-- A missed call: inbound, from a known customer, and only when the status BECOMES missed.
create or replace function public.crm_rule_on_call()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if new.direction = 'in' and new.contact_id is not null and new.status in ('missed', 'no_answer')
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform public.crm_rule_enqueue(new.client_id, 'call_missed', new.contact_id, null, jsonb_build_object('call_id', new.id));
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_call on public.phone_calls;
create trigger crm_rule_on_call after insert or update of status on public.phone_calls
  for each row execute function public.crm_rule_on_call();

-- A voicemail: the customer is on the call it belongs to.
create or replace function public.crm_rule_on_voicemail()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare v_contact uuid;
begin
  select contact_id into v_contact from public.phone_calls where id = new.call_id and client_id = new.client_id;
  if v_contact is not null then
    perform public.crm_rule_enqueue(new.client_id, 'voicemail_left', v_contact, null,
      jsonb_build_object('call_id', new.call_id, 'duration_s', new.duration_s));
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_voicemail on public.phone_voicemails;
create trigger crm_rule_on_voicemail after insert on public.phone_voicemails
  for each row execute function public.crm_rule_on_voicemail();

-- A text received, from a known customer — and NOT within a minute of our own text to them, so an
-- auto-reply answering an auto-reply cannot become a loop (see the header, point 4).
create or replace function public.crm_rule_on_text()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if new.direction = 'in' and new.contact_id is not null
     and not exists (select 1 from public.sms_messages m
                      where m.client_id = new.client_id and m.contact_id = new.contact_id
                        and m.direction = 'out' and m.created_at > now() - interval '60 seconds') then
    perform public.crm_rule_enqueue(new.client_id, 'text_received', new.contact_id, null, '{}'::jsonb);
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_text on public.sms_messages;
create trigger crm_rule_on_text after insert on public.sms_messages
  for each row execute function public.crm_rule_on_text();

-- Meetings: booked (when it gets a customer), cancelled, completed, no-show. completed and
-- no_show are set by hand in the portal today; the rule fires when they are.
create or replace function public.crm_rule_on_meeting()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare v_ev text;
begin
  if new.contact_id is null then return null; end if;
  if new.status = 'booked' and (tg_op = 'INSERT' or old.contact_id is null) then
    v_ev := 'meeting_booked';
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    v_ev := case new.status when 'cancelled' then 'meeting_cancelled' when 'completed' then 'meeting_completed'
                            when 'no_show' then 'meeting_no_show' end;
  end if;
  if v_ev is not null then
    perform public.crm_rule_enqueue(new.client_id, v_ev, new.contact_id, null,
      jsonb_build_object('meeting_id', new.id, 'starts_at', new.starts_at, 'type_id', new.type_id));
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_meeting on public.meetings;
create trigger crm_rule_on_meeting after insert or update of status, contact_id on public.meetings
  for each row execute function public.crm_rule_on_meeting();

-- Cards: a stage change (the history row), and lost / reopened.
create or replace function public.crm_rule_on_stage_change()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  perform public.crm_rule_enqueue(new.client_id, 'stage_changed', null, new.deal_id,
    jsonb_build_object('from_stage', new.from_stage, 'to_stage', new.to_stage));
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_stage_change on public.crm_deal_stage_changes;
create trigger crm_rule_on_stage_change after insert on public.crm_deal_stage_changes
  for each row execute function public.crm_rule_on_stage_change();

create or replace function public.crm_rule_on_deal_lost()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if old.lost_at is null and new.lost_at is not null then
    perform public.crm_rule_enqueue(new.client_id, 'deal_lost', new.contact_id, new.id, jsonb_build_object('lost_reason', new.lost_reason));
  elsif old.lost_at is not null and new.lost_at is null then
    perform public.crm_rule_enqueue(new.client_id, 'deal_reopened', new.contact_id, new.id, '{}'::jsonb);
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_deal_lost on public.crm_deals;
create trigger crm_rule_on_deal_lost after update of lost_at on public.crm_deals
  for each row execute function public.crm_rule_on_deal_lost();

do $$
declare f text;
begin
  foreach f in array array['crm_rule_on_contact', 'crm_rule_on_form', 'crm_rule_on_call', 'crm_rule_on_voicemail',
                           'crm_rule_on_text', 'crm_rule_on_meeting', 'crm_rule_on_stage_change', 'crm_rule_on_deal_lost'] loop
    execute format('revoke execute on function public.%I() from public, anon, authenticated', f);
  end loop;
end $$;

-- DRAIN THE QUEUE. Called by crm-rules-tick before the sweep. Each fact in its own block; a fact
-- that throws is marked processed with the error rather than retried for ever. Facts older than
-- a day are dropped unfired: a "thanks for calling" that arrives a day late is worse than none.
create or replace function public.crm_rules_drain_events(p_limit integer default 300)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_n integer := 0; e record;
begin
  for e in
    select * from public.crm_rule_events
     where processed_at is null
     order by id
     limit greatest(coalesce(p_limit, 300), 1)
     for update skip locked
  loop
    begin
      if e.created_at > now() - interval '1 day' then
        perform public.crm_rule_event(e.client_id, e.event, e.contact_id, e.deal_id, e.payload);
        v_n := v_n + 1;
      end if;
    exception when others then null;
    end;
    update public.crm_rule_events set processed_at = now() where id = e.id;
  end loop;
  -- A processed fact is kept a week, for "did the missed call even register?", then cleared.
  delete from public.crm_rule_events where processed_at < now() - interval '7 days';
  return v_n;
end;
$fn$;
revoke execute on function public.crm_rules_drain_events(integer) from public, anon, authenticated;
grant  execute on function public.crm_rules_drain_events(integer) to service_role;

-- ── PART 4 — the evaluator ───────────────────────────────────────────────────────────────

-- 363's facts plus three about the customer. Keys mirror RULE_CONDITION_FIELDS exactly.
create or replace function public.crm_rule_facts(p_client text, p_deal uuid, p_contact uuid, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare
  v jsonb := '{}'::jsonb;
  d public.crm_deals%rowtype;
  c public.crm_contacts%rowtype;
  v_contact uuid := p_contact;
begin
  if p_deal is not null then
    select * into d from public.crm_deals where id = p_deal and client_id = p_client;
    if found then
      v := v || jsonb_build_object(
        'deal.value',    case when d.value_cents is null then null else round(d.value_cents::numeric / 100, 2) end,
        'deal.status',   d.status_id,
        'deal.stage',    d.stage_id,
        'deal.pipeline', d.pipeline_id,
        'deal.lost',     d.lost_at is not null,
        'deal.source',   d.source);
      v_contact := coalesce(v_contact, d.contact_id);
    end if;
  end if;
  if v_contact is not null then
    select * into c from public.crm_contacts where id = v_contact and client_id = p_client;
    if found then
      v := v || jsonb_build_object(
        'contact.has_phone', nullif(btrim(coalesce(c.phone, '')), '') is not null,
        'contact.has_email', nullif(btrim(coalesce(c.email, '')), '') is not null,
        'contact.owner',     c.owner_user_id,
        'contact.label',     coalesce((select jsonb_agg(lower(btrim(l))) from unnest(c.labels) l
                                        where nullif(btrim(l), '') is not null), '[]'::jsonb),
        'contact.source',    c.source,
        -- whole days, so "no contact for more than 30 days" reads the way a person means it
        'contact.days_since_contact', floor(extract(epoch from now() - public.crm_rule_last_contact(p_client, c.id, c.created_at)) / 86400),
        'contact.days_since_created', floor(extract(epoch from now() - c.created_at) / 86400));
    end if;
  end if;
  if p_payload is not null and jsonb_typeof(p_payload) = 'object' then
    v := v || coalesce((select jsonb_object_agg('event.' || e.key, e.value) from jsonb_each(p_payload) e), '{}'::jsonb);
  end if;
  return v;
exception when others then
  return '{}'::jsonb;
end;
$fn$;
revoke execute on function public.crm_rule_facts(text, uuid, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_rule_facts(text, uuid, uuid, jsonb) to service_role;

-- 363's crm_rules_run, with: the 'none' scope (a schedule that only tells the team); the five new
-- actions; and once-a-day for inbound facts on an "every time" rule (header, point 4).
create or replace function public.crm_rules_run(
  p_client     text,
  p_trigger    text,
  p_contact    uuid,
  p_deal       uuid,
  p_payload    jsonb  default '{}'::jsonb,
  p_rule       uuid   default null,
  p_occurrence text   default '',
  p_scopes     text[] default null)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_deal     public.crm_deals%rowtype;
  v_has_deal boolean := false;
  v_contact  uuid := p_contact;
  v_n        integer := 0;
  r          record;
  a          record;
  v_run      bigint;
  v_done     jsonb;
  v_stage    uuid;
  v_facts    jsonb;
  v_occ      text;
  v_once     boolean;
  v_label    text;
  v_user     uuid;
  v_tz       text;
  v_short    text;
begin
  if coalesce(btrim(coalesce(p_client, '')), '') = '' then return 0; end if;
  if p_deal is not null then
    select * into v_deal from public.crm_deals
     where id = p_deal and client_id = p_client and archived_at is null;
    if not found then return 0; end if;
    v_has_deal := true;
    v_contact := coalesce(v_contact, v_deal.contact_id);
  end if;
  -- No subject is allowed only for one named rule — a 'none' schedule, from the sweep.
  if not v_has_deal and v_contact is null and p_rule is null then return 0; end if;
  v_short := case when v_has_deal then v_deal.short_code end;

  for r in
    select * from public.crm_rules x
     where x.client_id = p_client
       and x.archived_at is null
       and x.enabled
       and (case when p_rule is not null then x.id = p_rule
                 else x.trigger_kind = 'event' and x.trigger_event = p_trigger end)
       and (p_scopes is null or x.scope_kind = any (p_scopes))
       and (   (x.scope_kind = 'pipeline'      and v_has_deal and x.pipeline_id = v_deal.pipeline_id)
            or (x.scope_kind = 'all_pipelines' and v_has_deal)
            or (x.scope_kind = 'contacts'      and not v_has_deal and v_contact is not null)
            or (x.scope_kind = 'none'          and p_rule is not null and not v_has_deal and v_contact is null))
       and (p_rule is not null or now() >= x.applies_from)
     order by x.position, x.created_at
  loop
    begin
      -- Once a day, not every time, on the three facts a customer can produce at will.
      v_occ := coalesce(p_occurrence, '');
      if v_occ = '' and not r.once_per_card and p_trigger in ('text_received', 'call_missed', 'voicemail_left') then
        v_tz := coalesce(v_tz, public.crm_tenant_time_zone(p_client));
        v_occ := 'day:' || to_char(now() at time zone v_tz, 'YYYY-MM-DD');
      end if;
      v_once := r.once_per_card or v_occ like 'day:%';

      if jsonb_array_length(r.conditions) > 0 then
        if v_facts is null then
          v_facts := public.crm_rule_facts(p_client, case when v_has_deal then v_deal.id end, v_contact, p_payload);
        end if;
        if not public.crm_rule_conditions_hold(v_facts, r.conditions) then
          insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard, occurrence, detail)
          values (p_client, r.id, case when v_has_deal then v_deal.id end, v_contact, p_trigger, 'skipped', false, v_occ,
                  jsonb_build_object('reason', 'conditions'));
          continue;
        end if;
      end if;

      insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard, occurrence, detail)
      values (p_client, r.id, case when v_has_deal then v_deal.id end, v_contact, p_trigger, 'done', v_once, v_occ, '{}'::jsonb)
      returning id into v_run;

      v_done := '[]'::jsonb;
      for a in
        select * from public.crm_rule_actions
         where rule_id = r.id and client_id = p_client
         order by position, created_at
      loop
        if a.kind in ('set_status', 'move_stage', 'mark_lost', 'reopen', 'set_follow_up', 'set_close_date')
           and not v_has_deal then
          raise exception 'That action needs a card, and this rule runs on a customer' using errcode = 'check_violation';
        end if;
        if a.kind in ('add_note', 'create_card', 'send_sms', 'send_email', 'add_label', 'remove_label', 'assign_owner', 'create_task')
           and v_contact is null then
          raise exception 'That action needs a customer, and this rule has none' using errcode = 'check_violation';
        end if;

        if a.kind = 'set_status' then
          perform public.crm_set_deal_status(p_client, v_deal.id, (a.params ->> 'statusId')::uuid, null, false);
        elsif a.kind = 'move_stage' then
          perform public.crm_move_deal(p_client, v_deal.id, (a.params ->> 'stageId')::uuid, null, null);
        elsif a.kind = 'mark_lost' then
          perform public.crm_set_deal_lost(p_client, v_deal.id, null, a.params ->> 'reason');
        elsif a.kind = 'reopen' then
          perform public.crm_clear_deal_lost(p_client, v_deal.id, null);
        elsif a.kind = 'set_follow_up' then
          update public.crm_deals
             set next_follow_up_at = now() + make_interval(days => coalesce((a.params ->> 'days')::int, 0)), updated_at = now()
           where id = v_deal.id;
        elsif a.kind = 'set_close_date' then
          update public.crm_deals
             set expected_close_date = (now() + make_interval(days => coalesce((a.params ->> 'days')::int, 0)))::date, updated_at = now()
           where id = v_deal.id;
        elsif a.kind = 'add_note' then
          insert into public.crm_notes (client_id, contact_id, short_code, body)
          values (p_client, v_contact, v_short, left(coalesce(a.params ->> 'body', ''), 4000));
        elsif a.kind = 'create_card' then
          v_stage := public.crm_rule_first_stage(p_client, (a.params ->> 'pipelineId')::uuid);
          if v_stage is not null and not exists (
            select 1 from public.crm_deals d
             where d.client_id = p_client and d.pipeline_id = (a.params ->> 'pipelineId')::uuid
               and d.contact_id = v_contact and d.archived_at is null)
          then
            insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, title, source)
            values (p_client, (a.params ->> 'pipelineId')::uuid, v_stage, v_contact,
                    left(nullif(btrim(coalesce(a.params ->> 'title', '')), ''), 200), 'manual');
          end if;

        -- ── 365's actions ─────────────────────────────────────────────────────────────────
        elsif a.kind = 'add_label' then
          -- A tag already there is left alone: no write, so no "tag added" fact, so a rule that
          -- adds the tag another rule listens for cannot feed it twice.
          v_label := left(btrim(coalesce(a.params ->> 'label', '')), 60);
          if v_label = '' then raise exception 'That rule names no tag' using errcode = 'check_violation'; end if;
          update public.crm_contacts set labels = array_append(labels, v_label), updated_at = now()
           where id = v_contact and client_id = p_client
             and not exists (select 1 from unnest(labels) x where lower(btrim(x)) = lower(v_label));
        elsif a.kind = 'remove_label' then
          v_label := lower(btrim(coalesce(a.params ->> 'label', '')));
          update public.crm_contacts
             set labels = coalesce((select array_agg(x) from unnest(labels) x where lower(btrim(x)) <> v_label), '{}'), updated_at = now()
           where id = v_contact and client_id = p_client
             and exists (select 1 from unnest(labels) x where lower(btrim(x)) = v_label);
        elsif a.kind = 'assign_owner' then
          -- Only someone on THIS builder's team; a stale id fails the rule in words.
          select user_id into v_user from public.client_users
           where client_id = p_client and user_id = (a.params ->> 'userId')::uuid;
          if v_user is null then raise exception 'The person this rule assigns to is no longer on your team' using errcode = 'check_violation'; end if;
          update public.crm_contacts set owner_user_id = v_user, updated_at = now()
           where id = v_contact and client_id = p_client;
        elsif a.kind = 'create_task' then
          -- A task on the customer, which is what lists under their Planned section. Due at 9am
          -- on the day, in the ACCOUNT's time zone; for the named person, else the owner.
          v_tz := coalesce(v_tz, public.crm_tenant_time_zone(p_client));
          v_user := nullif(a.params ->> 'assigneeUserId', '')::uuid;
          if v_user is not null and not exists (select 1 from public.client_users where client_id = p_client and user_id = v_user) then
            raise exception 'The person this task is for is no longer on your team' using errcode = 'check_violation';
          end if;
          insert into public.crm_activities (client_id, contact_id, short_code, kind, subject, due_at, all_day, assignee_user_id, done)
          values (p_client, v_contact, v_short, 'task',
                  left(coalesce(nullif(btrim(a.params ->> 'title'), ''), 'Follow up'), 200),
                  ((((now() at time zone v_tz)::date) + coalesce((a.params ->> 'dueDays')::int, 0)) + time '09:00') at time zone v_tz,
                  false,
                  coalesce(v_user, (select owner_user_id from public.crm_contacts where id = v_contact)),
                  false);
        elsif a.kind in ('send_sms', 'send_email', 'notify_team') then
          insert into public.crm_rule_outbox (client_id, run_id, rule_id, deal_id, contact_id, kind, params)
          values (p_client, v_run, r.id, case when v_has_deal then v_deal.id end, v_contact, a.kind, a.params);
        else
          raise exception 'unknown rule action %', a.kind using errcode = 'check_violation';
        end if;
        v_done := v_done || jsonb_build_object('action', a.id, 'kind', a.kind);
      end loop;

      update public.crm_rule_runs
         set detail = jsonb_build_object('actions', v_done)
                      || case when p_payload is not null and p_payload <> '{}'::jsonb
                              then jsonb_build_object('payload', p_payload) else '{}'::jsonb end
       where id = v_run;
      v_n := v_n + 1;
    exception
      when unique_violation then
        begin
          insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard, occurrence, detail)
          values (p_client, r.id, case when v_has_deal then v_deal.id end, v_contact, p_trigger, 'skipped', false, v_occ,
                  jsonb_build_object('reason', case when v_occ like 'day:%' then 'already run for them today'
                                                    when v_has_deal then 'already run for this card'
                                                    when v_contact is not null then 'already run for this customer'
                                                    else 'already run' end));
        exception when others then null;
        end;
      when others then
        begin
          insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard, occurrence, detail)
          values (p_client, r.id, case when v_has_deal then v_deal.id end, v_contact, p_trigger, 'failed', false, v_occ,
                  jsonb_build_object('sqlstate', sqlstate, 'error', sqlerrm));
        exception when others then null;
        end;
    end;
  end loop;
  return v_n;
end;
$fn$;
revoke execute on function public.crm_rules_run(text, text, uuid, uuid, jsonb, uuid, text, text[]) from public, anon, authenticated;
grant  execute on function public.crm_rules_run(text, text, uuid, uuid, jsonb, uuid, text, text[]) to service_role;

-- ── PART 5 — schedules ───────────────────────────────────────────────────────────────────

-- THE NEXT OCCURRENCE strictly after p_after, in the account's zone. Postgres does the daylight
-- saving: `(date + time) at time zone tz` is 8:00 local on both sides of a change. NULL when the
-- schedule cannot occur (a bad shape) — the sweep then never picks the rule up.
create or replace function public.crm_rule_next_run(p_schedule jsonb, p_tz text, p_after timestamptz)
returns timestamptz
language plpgsql
stable
set search_path to ''
as $fn$
declare
  v_tz    text := coalesce(nullif(p_tz, ''), 'America/Chicago');
  v_freq  text := p_schedule ->> 'freq';
  v_at    time;
  v_day0  date;
  v_cand  date;
  v_inst  timestamptz;
  v_days  int[];
  v_every int := greatest(coalesce((p_schedule ->> 'every')::int, 1), 1);
  v_dom   int := coalesce((p_schedule ->> 'dayOfMonth')::int, 1);
  v_mon   int := coalesce((p_schedule ->> 'month')::int, 1);
  v_mday  int := coalesce((p_schedule ->> 'day')::int, 1);
  v_last  int;
  v_ok    boolean;
begin
  if p_schedule is null or jsonb_typeof(p_schedule) <> 'object' then return null; end if;
  v_at := coalesce(nullif(p_schedule ->> 'at', '')::time, time '09:00');
  v_day0 := (p_after at time zone v_tz)::date;
  if jsonb_typeof(p_schedule -> 'days') = 'array' then
    select array_agg(x::int) into v_days from jsonb_array_elements_text(p_schedule -> 'days') x;
  end if;
  for i in 0..400 loop
    v_cand := v_day0 + i;
    v_last := extract(day from (date_trunc('month', v_cand) + interval '1 month - 1 day'))::int;
    v_ok := case v_freq
      when 'daily'      then true
      when 'date_field' then true      -- a daily tick; the AUDIENCE is what filters by the date
      -- weeks counted from a fixed Monday, so "every 2 weeks" does not drift with the save date
      when 'weekly'     then extract(isodow from v_cand)::int = any (coalesce(v_days, array[1]))
                               and ((v_cand - date '2024-01-01') / 7) % v_every = 0
      -- the 31st in a 30-day month is the 30th, not skipped
      when 'monthly'    then extract(day from v_cand)::int = least(v_dom, v_last)
      when 'yearly'     then extract(month from v_cand)::int = v_mon and extract(day from v_cand)::int = least(v_mday, v_last)
      else false
    end;
    if v_ok then
      v_inst := (v_cand + v_at) at time zone v_tz;
      if v_inst > p_after then return v_inst; end if;
    end if;
  end loop;
  return null;
exception when others then
  return null;
end;
$fn$;
revoke execute on function public.crm_rule_next_run(jsonb, text, timestamptz) from public, anon, authenticated;
grant  execute on function public.crm_rule_next_run(jsonb, text, timestamptz) to service_role;

-- "On the date in their record": a date custom field (plus an offset) is today. Yearly compares
-- month and day — a birthday — with 29 February falling on the 28th in a year without one.
create or replace function public.crm_rule_date_matches(p_custom jsonb, p_schedule jsonb, p_on date)
returns boolean
language plpgsql
immutable
set search_path to ''
as $fn$
declare v_key text; v_d date; v_target date;
begin
  v_key := regexp_replace(coalesce(p_schedule ->> 'field', ''), '^custom:', '');
  if v_key = '' or p_custom is null then return false; end if;
  v_d := nullif(left(p_custom ->> v_key, 10), '')::date;
  if v_d is null then return false; end if;
  v_target := v_d + coalesce((p_schedule ->> 'offsetDays')::int, 0);
  if coalesce((p_schedule ->> 'yearly')::boolean, false) then
    if extract(month from v_target) = 2 and extract(day from v_target) = 29
       and extract(day from (make_date(extract(year from p_on)::int, 3, 1) - 1)) = 28 then
      return extract(month from p_on) = 2 and extract(day from p_on) = 28;
    end if;
    return extract(month from v_target) = extract(month from p_on) and extract(day from v_target) = extract(day from p_on);
  end if;
  return v_target = p_on;
exception when others then
  return false;
end;
$fn$;
revoke execute on function public.crm_rule_date_matches(jsonb, jsonb, date) from public, anon, authenticated;
grant  execute on function public.crm_rule_date_matches(jsonb, jsonb, date) to service_role;

-- WHO A SCHEDULE REACHES on one occurrence, not counting anyone it has already reached then. The
-- SAME predicate the editor's preview counts (crm_rule_audience_preview), so the number Carolyn
-- arms with is the number it acts on.
create or replace function public.crm_rule_audience(p_rule uuid, p_on date, p_occ text, p_limit integer default 201)
returns table (contact_id uuid, deal_id uuid)
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare r public.crm_rules%rowtype;
begin
  select * into r from public.crm_rules where id = p_rule;
  if not found then return; end if;
  if r.scope_kind = 'none' then
    return query select null::uuid, null::uuid
      where not exists (select 1 from public.crm_rule_runs n where n.rule_id = r.id and n.occurrence = p_occ
                          and n.deal_id is null and n.contact_id is null and n.once_guard and n.outcome <> 'failed');
  elsif r.scope_kind = 'contacts' then
    return query select c.id, null::uuid from public.crm_contacts c
      where c.client_id = r.client_id and c.merged_into is null
        and (r.schedule ->> 'freq' <> 'date_field' or public.crm_rule_date_matches(c.custom, r.schedule, p_on))
        and (jsonb_array_length(r.conditions) = 0
             or public.crm_rule_conditions_hold(public.crm_rule_facts(r.client_id, null, c.id), r.conditions))
        and not exists (select 1 from public.crm_rule_runs n where n.rule_id = r.id and n.occurrence = p_occ
                          and n.contact_id = c.id and n.deal_id is null and n.once_guard and n.outcome <> 'failed')
      order by c.created_at
      limit greatest(coalesce(p_limit, 201), 1);
  else
    return query select dl.contact_id, dl.id from public.crm_deals dl
      where dl.client_id = r.client_id and dl.archived_at is null
        and (r.scope_kind = 'all_pipelines' or dl.pipeline_id = r.pipeline_id)
        and (jsonb_array_length(r.conditions) = 0
             or public.crm_rule_conditions_hold(public.crm_rule_facts(r.client_id, dl.id, dl.contact_id), r.conditions))
        and not exists (select 1 from public.crm_rule_runs n where n.rule_id = r.id and n.occurrence = p_occ
                          and n.deal_id = dl.id and n.once_guard and n.outcome <> 'failed')
      order by dl.created_at
      limit greatest(coalesce(p_limit, 201), 1);
  end if;
end;
$fn$;
revoke execute on function public.crm_rule_audience(uuid, date, text, integer) from public, anon, authenticated;
grant  execute on function public.crm_rule_audience(uuid, date, text, integer) to service_role;

-- THE NUMBER THE EDITOR SHOWS before a rule is saved or armed: who a DRAFT would reach now, and a
-- few names. Same predicate as crm_rule_audience (without the date filter: "match now").
create or replace function public.crm_rule_audience_preview(p_client text, p_scope text, p_pipeline uuid, p_conditions jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare v_n integer; v_sample jsonb;
begin
  if p_scope = 'none' then return jsonb_build_object('count', 0, 'sample', '[]'::jsonb); end if;
  if p_scope = 'contacts' then
    with m as (
      select c.name from public.crm_contacts c
       where c.client_id = p_client and c.merged_into is null
         and (coalesce(jsonb_array_length(p_conditions), 0) = 0
              or public.crm_rule_conditions_hold(public.crm_rule_facts(p_client, null, c.id), p_conditions))
       order by c.created_at)
    select count(*), coalesce((select jsonb_agg(x.name) from (select name from m limit 5) x), '[]'::jsonb) into v_n, v_sample from m;
  else
    with m as (
      select coalesce(c.name, dl.title) as name from public.crm_deals dl
        left join public.crm_contacts c on c.id = dl.contact_id
       where dl.client_id = p_client and dl.archived_at is null
         and (p_scope = 'all_pipelines' or dl.pipeline_id = p_pipeline)
         and (coalesce(jsonb_array_length(p_conditions), 0) = 0
              or public.crm_rule_conditions_hold(public.crm_rule_facts(p_client, dl.id, dl.contact_id), p_conditions))
       order by dl.created_at)
    select count(*), coalesce((select jsonb_agg(x.name) from (select name from m limit 5) x), '[]'::jsonb) into v_n, v_sample from m;
  end if;
  return jsonb_build_object('count', v_n, 'sample', v_sample);
end;
$fn$;
revoke execute on function public.crm_rule_audience_preview(text, text, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_rule_audience_preview(text, text, uuid, jsonb) to service_role;

-- 363's reset, plus: a schedule rule's next_run_at, computed AFTER NOW on insert, on any change to
-- its schedule, and on resume — so a resumed rule never replays what it missed.
create or replace function public.crm_rules_guard_reset()
returns trigger
language plpgsql
set search_path to ''
as $fn$
begin
  if tg_op = 'INSERT' then
    new.next_run_at := case when new.trigger_kind = 'schedule'
      then public.crm_rule_next_run(new.schedule, public.crm_tenant_time_zone(new.client_id), now()) end;
    return new;
  end if;
  if new.scope_kind     is distinct from old.scope_kind
  or new.pipeline_id    is distinct from old.pipeline_id
  or new.trigger_kind   is distinct from old.trigger_kind
  or new.trigger_event  is distinct from old.trigger_event
  or new.elapsed_anchor is distinct from old.elapsed_anchor
  or new.elapsed_days   is distinct from old.elapsed_days
  or new.schedule       is distinct from old.schedule then
    new.applies_from := now();
  end if;
  if (new.scope_kind   is distinct from old.scope_kind
   or new.pipeline_id  is distinct from old.pipeline_id
   or new.conditions   is distinct from old.conditions
   or new.trigger_kind is distinct from old.trigger_kind)
   and new.armed_count is not distinct from old.armed_count then
    new.armed_count := null;
  end if;
  if new.trigger_kind <> 'schedule' then
    new.next_run_at := null;
  elsif new.schedule is distinct from old.schedule or new.trigger_kind is distinct from old.trigger_kind
     or (new.enabled and not old.enabled) or old.next_run_at is null then
    new.next_run_at := public.crm_rule_next_run(new.schedule, public.crm_tenant_time_zone(new.client_id), now());
  end if;
  return new;
end;
$fn$;
drop trigger if exists crm_rules_guard_insert on public.crm_rules;
create trigger crm_rules_guard_insert before insert on public.crm_rules
  for each row execute function public.crm_rules_guard_reset();

-- A builder who changes their time zone moves every schedule with it.
create or replace function public.crm_rules_tz_changed()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  update public.crm_rules
     set next_run_at = public.crm_rule_next_run(schedule, new.time_zone, now())
   where client_id = new.client_id and trigger_kind = 'schedule' and archived_at is null;
  return null;
exception when others then return null;
end;
$fn$;
revoke execute on function public.crm_rules_tz_changed() from public, anon, authenticated;
drop trigger if exists crm_rules_tz_changed on public.client_settings;
create trigger crm_rules_tz_changed after update of time_zone on public.client_settings
  for each row when (new.time_zone is distinct from old.time_zone)
  execute function public.crm_rules_tz_changed();

-- ── PART 6 — the sweep ───────────────────────────────────────────────────────────────────
create or replace function public.crm_rules_sweep(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_n integer := 0;
  r   record;
  d   record;
  v_trigger text;
  v_tz   text;
  v_occ  text;
  v_on   date;
  v_cap  integer;
  v_got  integer;
  v_out  boolean;
begin
  -- ── A. CARD CLOCKS (355/363, unchanged) ─────────────────────────────────────────────────
  for r in
    select * from public.crm_rules
     where trigger_kind = 'elapsed' and enabled and archived_at is null
       and scope_kind in ('pipeline', 'all_pipelines')
     order by client_id, position
  loop
    begin
      v_trigger := 'elapsed:' || r.elapsed_anchor || '+' || r.elapsed_days || 'd';
      for d in
        select * from (
          select dl.id as deal_id, dl.contact_id,
                 (case r.elapsed_anchor
                    when 'stage_entered'  then dl.stage_entered_at
                    when 'expected_close' then dl.expected_close_date::timestamptz
                    when 'delivered'      then (select g.delivered_at from public.designs g
                                                 where g.client_id = dl.client_id and g.short_code = dl.short_code limit 1)
                    when 'last_contact'   then public.crm_rule_last_contact(dl.client_id, dl.contact_id, dl.created_at)
                    else null
                  end) as at
            from public.crm_deals dl
           where dl.client_id = r.client_id
             and (r.scope_kind = 'all_pipelines' or dl.pipeline_id = r.pipeline_id)
             and dl.archived_at is null
             and not exists (select 1 from public.crm_rule_runs n
                              where n.rule_id = r.id and n.deal_id = dl.id and n.occurrence = ''
                                and n.once_guard and n.outcome <> 'failed')
        ) q
        where q.at is not null
          and q.at + make_interval(days => r.elapsed_days) <= now()
          and q.at >= r.applies_from          -- ⚠️ THE LINE (355)
          and (jsonb_array_length(r.conditions) = 0
               or public.crm_rule_conditions_hold(public.crm_rule_facts(r.client_id, q.deal_id, q.contact_id), r.conditions))
        order by q.at
        limit greatest(coalesce(p_limit, 200), 1)
      loop
        perform public.crm_rules_run(r.client_id, v_trigger, d.contact_id, d.deal_id, '{}'::jsonb, r.id, '');
        v_n := v_n + 1;
      end loop;
    exception when others then
      begin
        insert into public.app_errors (client_id, source, severity, code, message, context)
        values (r.client_id, 'db:crm_rules_sweep', 'error', 'crm_rules_sweep_failed',
                'crm_rules_sweep: ' || sqlerrm, jsonb_build_object('sqlstate', sqlstate, 'rule_id', r.id));
      exception when others then null;
      end;
    end;
  end loop;

  -- ── B. CUSTOMER CLOCKS (365): "no contact for 30 days", "7 days after they were added" ──
  -- "No contact" is keyed by WHEN they were last contacted, so it fires once per quiet spell —
  -- go quiet, get the nudge, talk, go quiet again, get it again — and never twice for one spell.
  for r in
    select * from public.crm_rules
     where trigger_kind = 'elapsed' and enabled and archived_at is null and scope_kind = 'contacts'
     order by client_id, position
  loop
    begin
      v_trigger := 'elapsed:' || r.elapsed_anchor || '+' || r.elapsed_days || 'd';
      for d in
        select * from (
          select c.id as contact_id,
                 (case r.elapsed_anchor
                    when 'contact_created' then c.created_at
                    when 'last_contact'    then public.crm_rule_last_contact(c.client_id, c.id, c.created_at)
                  end) as at
            from public.crm_contacts c
           where c.client_id = r.client_id and c.merged_into is null
        ) q
        where q.at is not null
          and q.at + make_interval(days => r.elapsed_days) <= now()
          and q.at >= r.applies_from          -- ⚠️ THE LINE, for customers too
          and not exists (select 1 from public.crm_rule_runs n
                           where n.rule_id = r.id and n.contact_id = q.contact_id and n.deal_id is null
                             and n.occurrence = (case when r.elapsed_anchor = 'last_contact'
                                                      then 'lc:' || to_char(q.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') else '' end)
                             and n.once_guard and n.outcome <> 'failed')
          and (jsonb_array_length(r.conditions) = 0
               or public.crm_rule_conditions_hold(public.crm_rule_facts(r.client_id, null, q.contact_id), r.conditions))
        order by q.at
        limit greatest(coalesce(p_limit, 200), 1)
      loop
        perform public.crm_rules_run(r.client_id, v_trigger, d.contact_id, null, '{}'::jsonb, r.id,
          case when r.elapsed_anchor = 'last_contact' then 'lc:' || to_char(d.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') else '' end);
        v_n := v_n + 1;
      end loop;
    exception when others then
      begin
        insert into public.app_errors (client_id, source, severity, code, message, context)
        values (r.client_id, 'db:crm_rules_sweep', 'error', 'crm_rules_sweep_failed',
                'crm_rules_sweep: ' || sqlerrm, jsonb_build_object('sqlstate', sqlstate, 'rule_id', r.id));
      exception when others then null;
      end;
    end;
  end loop;

  -- ── C. SCHEDULES (365) — see the header, points 2 and 3 ────────────────────────────────
  for r in
    select * from public.crm_rules
     where trigger_kind = 'schedule' and enabled and archived_at is null
       and next_run_at is not null and next_run_at <= now()
     order by next_run_at
  loop
    begin
      v_tz  := public.crm_tenant_time_zone(r.client_id);
      v_on  := (r.next_run_at at time zone v_tz)::date;
      v_occ := to_char(v_on, 'YYYY-MM-DD');
      v_trigger := 'schedule:' || coalesce(r.schedule ->> 'freq', '?');
      v_out := exists (select 1 from public.crm_rule_actions a where a.rule_id = r.id and a.kind in ('send_sms', 'send_email'));
      if now() - r.next_run_at > interval '6 hours' then
        -- A day-late "8am" text is worse than none.
        insert into public.crm_rule_runs (client_id, rule_id, trigger, outcome, once_guard, occurrence, detail)
        values (r.client_id, r.id, v_trigger, 'skipped', false, v_occ, jsonb_build_object('reason', 'missed its time by more than six hours'));
        update public.crm_rules set next_run_at = public.crm_rule_next_run(r.schedule, v_tz, now()) where id = r.id;
      elsif v_out and r.armed_count is null and r.scope_kind <> 'none' then
        -- ⛔ NOT ARMED: it would message a group nobody has counted. Logged, never sent.
        insert into public.crm_rule_runs (client_id, rule_id, trigger, outcome, once_guard, occurrence, detail)
        values (r.client_id, r.id, v_trigger, 'skipped', false, v_occ, jsonb_build_object('reason', 'not armed — open the rule and arm it'));
        update public.crm_rules set next_run_at = public.crm_rule_next_run(r.schedule, v_tz, now()) where id = r.id;
      else
        v_cap := r.max_per_run;
        v_got := 0;
        for d in select * from public.crm_rule_audience(r.id, v_on, v_occ, v_cap + 1) loop
          v_got := v_got + 1;
          exit when v_got > v_cap;
          perform public.crm_rules_run(r.client_id, v_trigger, d.contact_id, d.deal_id, '{}'::jsonb, r.id, v_occ);
          v_n := v_n + 1;
        end loop;
        -- More than a tick's worth: leave next_run_at where it is, and the next tick carries on
        -- under the SAME occurrence (the once key stops anyone getting it twice).
        if v_got <= v_cap then
          update public.crm_rules set next_run_at = public.crm_rule_next_run(r.schedule, v_tz, now()) where id = r.id;
        end if;
      end if;
    exception when others then
      begin
        insert into public.app_errors (client_id, source, severity, code, message, context)
        values (r.client_id, 'db:crm_rules_sweep', 'error', 'crm_rules_sweep_failed',
                'crm_rules_sweep: ' || sqlerrm, jsonb_build_object('sqlstate', sqlstate, 'rule_id', r.id));
      exception when others then null;
      end;
    end;
  end loop;
  return v_n;
end;
$fn$;
revoke execute on function public.crm_rules_sweep(integer) from public, anon, authenticated;
grant  execute on function public.crm_rules_sweep(integer) to service_role;

-- ── PART 7 — checks ──────────────────────────────────────────────────────────────────────
do $chk$
declare
  v_t   text := 'm365-rehearsal-' || substr(md5(random()::text), 1, 8);
  v_n   integer;
  v_c1  uuid; v_c2 uuid; v_c3 uuid; v_r jsonb; v_s1 uuid; v_p1 uuid;
  v_rx  uuid; v_ry uuid;
  v_ts  timestamptz;
begin
  -- 1. THE CLOCK, across daylight saving. Monday 08:00 in New York is 13:00 UTC in winter and
  --    12:00 UTC in summer; the same rule must say so on both sides of the change.
  v_ts := public.crm_rule_next_run('{"freq":"weekly","days":[1],"at":"08:00"}', 'America/New_York', '2026-11-04 15:00+00');
  if v_ts <> '2026-11-09 13:00+00' then raise exception '365: weekly Monday 08:00 New York in November gave %', v_ts; end if;
  v_ts := public.crm_rule_next_run('{"freq":"weekly","days":[1],"at":"08:00"}', 'America/New_York', '2026-03-06 00:00+00');
  if v_ts <> '2026-03-09 12:00+00' then raise exception '365: weekly Monday 08:00 New York across spring-forward gave %', v_ts; end if;
  -- Exactly at 8:00 means the NEXT one, not this one.
  v_ts := public.crm_rule_next_run('{"freq":"daily","at":"08:00"}', 'America/Chicago', '2026-11-05 14:00+00');
  if v_ts <> '2026-11-06 14:00+00' then raise exception '365: daily at exactly the hour did not move to tomorrow (%)', v_ts; end if;
  -- The 31st of a month without one is its last day, not skipped.
  v_ts := public.crm_rule_next_run('{"freq":"monthly","dayOfMonth":31,"at":"09:00"}', 'America/Chicago', '2027-02-01 00:00+00');
  if v_ts <> '2027-02-28 15:00+00' then raise exception '365: monthly on the 31st in February gave %', v_ts; end if;
  if public.crm_rule_next_run('{"freq":"sometimes"}', 'America/Chicago', now()) is not null then
    raise exception '365: a schedule that cannot occur produced a time';
  end if;
  -- Birthdays, including 29 February in a year without one.
  if not public.crm_rule_date_matches('{"bday":"1992-02-29"}', '{"field":"custom:bday","yearly":true}', '2027-02-28')
     or public.crm_rule_date_matches('{"bday":"1990-03-01"}', '{"field":"custom:bday","yearly":true}', '2027-02-28')
     or not public.crm_rule_date_matches('{"warranty":"2026-11-02"}', '{"field":"custom:warranty","offsetDays":3}', '2026-11-05')
     or public.crm_rule_date_matches('{"warranty":"not a date"}', '{"field":"custom:warranty"}', '2026-11-05') then
    raise exception '365: the date-on-their-record match is wrong';
  end if;

  -- The rehearsal account: three customers; one tagged, one with a card.
  perform public.crm_ensure_pipelines(v_t);
  select id into v_p1 from public.crm_pipelines where client_id = v_t and seed_kind = 'shed_deals';
  select id into v_s1 from public.crm_pipeline_stages where pipeline_id = v_p1 and archived_at is null order by position limit 1;
  v_r := public.crm_create_lead(v_t, 'Ann Rehearsal', null, '(555) 010-3651', 'ann365@example.invalid', null, null, 'manual', v_s1);
  select contact_id into v_c1 from public.crm_deals where id = (v_r ->> 'dealId')::uuid;
  insert into public.crm_contacts (client_id, name, phone, email, source, labels)
  values (v_t, 'Bo Rehearsal', '(555) 010-3652', null, 'manual', array['Lot visitor']) returning id into v_c2;
  insert into public.crm_contacts (client_id, name, phone, email, source)
  values (v_t, 'Cy Rehearsal', null, 'cy365@example.invalid', 'manual') returning id into v_c3;

  -- 2. A SCHEDULE gets its next run on save, AFTER now.
  insert into public.crm_rules (client_id, scope_kind, trigger_kind, schedule, conditions, max_per_run, name)
  values (v_t, 'contacts', 'schedule', '{"freq":"daily","at":"08:00"}',
          '[{"field":"contact.has_phone","op":"eq","value":true}]', 1, '365 schedule check') returning id into v_rx;
  if (select next_run_at from public.crm_rules where id = v_rx) <= now() then
    raise exception '365: a new schedule was given a next run in the past';
  end if;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params) values (v_t, v_rx, 'send_sms', '{"body":"Hi"}');

  -- 3. NOT ARMED → nothing sent, a skip logged, the clock moved on.
  update public.crm_rules set next_run_at = now() - interval '1 minute' where id = v_rx;
  perform public.crm_rules_sweep(500);
  if exists (select 1 from public.crm_rule_outbox where rule_id = v_rx)
     or not exists (select 1 from public.crm_rule_runs where rule_id = v_rx and outcome = 'skipped' and detail ->> 'reason' like 'not armed%')
     or (select next_run_at from public.crm_rules where id = v_rx) <= now() then
    raise exception '365: an unarmed schedule that texts customers was not stopped';
  end if;

  -- 4. ARMED, with a cap of ONE: the two customers with a phone take two ticks, under ONE
  --    occurrence, and only then does the clock move.
  delete from public.crm_rule_runs where rule_id = v_rx;
  update public.crm_rules set armed_count = 2, next_run_at = now() - interval '1 minute' where id = v_rx;
  perform public.crm_rules_sweep(500);
  if (select count(*) from public.crm_rule_outbox where rule_id = v_rx) <> 1
     or (select next_run_at from public.crm_rules where id = v_rx) > now() then
    raise exception '365: the cap did not hold the rest for the next tick';
  end if;
  perform public.crm_rules_sweep(500);
  if (select count(*) from public.crm_rule_outbox where rule_id = v_rx) <> 2
     or (select count(distinct occurrence) from public.crm_rule_runs where rule_id = v_rx and outcome = 'done') <> 1
     or exists (select 1 from public.crm_rule_outbox where rule_id = v_rx and contact_id = v_c3)
     or (select next_run_at from public.crm_rules where id = v_rx) <= now() then
    raise exception '365: the second tick did not finish the occurrence, or reached someone it should not';
  end if;
  -- A third sweep at the same occurrence reaches nobody new.
  update public.crm_rules set next_run_at = now() - interval '1 minute' where id = v_rx;
  perform public.crm_rules_sweep(500);
  if (select count(*) from public.crm_rule_outbox where rule_id = v_rx) <> 2 then
    raise exception '365: a schedule reached someone twice on one day';
  end if;
  -- More than six hours late: skipped, not sent.
  update public.crm_rules set next_run_at = now() - interval '7 hours' where id = v_rx;
  delete from public.crm_rule_runs where rule_id = v_rx;
  delete from public.crm_rule_outbox where rule_id = v_rx;
  perform public.crm_rules_sweep(500);
  if exists (select 1 from public.crm_rule_outbox where rule_id = v_rx)
     or not exists (select 1 from public.crm_rule_runs where rule_id = v_rx and detail ->> 'reason' like 'missed its time%') then
    raise exception '365: a schedule six hours late still sent';
  end if;
  -- Changing who it reaches withdraws the arm (363's reset, still in force).
  update public.crm_rules set conditions = '[]' where id = v_rx;
  if (select armed_count from public.crm_rules where id = v_rx) is not null then
    raise exception '365: changing a schedule''s audience left it armed';
  end if;
  delete from public.crm_rules where id = v_rx;

  -- 5. 'NONE' — a schedule that only tells the team runs with no subject at all.
  insert into public.crm_rules (client_id, scope_kind, trigger_kind, schedule, name)
  values (v_t, 'none', 'schedule', '{"freq":"daily","at":"08:00"}', '365 team check') returning id into v_rx;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params) values (v_t, v_rx, 'notify_team', '{"subject":"Monday","body":"Check the lot"}');
  update public.crm_rules set next_run_at = now() - interval '1 minute' where id = v_rx;
  perform public.crm_rules_sweep(500);
  if (select count(*) from public.crm_rule_outbox where rule_id = v_rx and kind = 'notify_team' and contact_id is null) <> 1 then
    raise exception '365: a team-only schedule did not queue its note';
  end if;
  delete from public.crm_rules where id = v_rx;

  -- 6. THE QUEUE: a tag added is queued ONLY when a rule waits for it; drained, it fires.
  update public.crm_contacts set labels = array['VIP'] where id = v_c3;
  if exists (select 1 from public.crm_rule_events where client_id = v_t) then
    raise exception '365: a fact was queued for an account with no rule waiting for it';
  end if;
  insert into public.crm_rules (client_id, scope_kind, trigger_kind, trigger_event, conditions, name)
  values (v_t, 'contacts', 'event', 'label_added', '[{"field":"event.label","op":"eq","value":"hot"}]', '365 tag check') returning id into v_rx;
  update public.crm_rules set applies_from = now() - interval '1 minute' where id = v_rx;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params)
  values (v_t, v_rx, 'add_label', '{"label":"Call back"}'),
         (v_t, v_rx, 'create_task', '{"title":"Ring them","dueDays":1}');
  update public.crm_contacts set labels = array_append(labels, 'Hot') where id = v_c3;
  update public.crm_contacts set labels = array_append(labels, 'cold') where id = v_c3;
  if (select count(*) from public.crm_rule_events where client_id = v_t and processed_at is null) <> 2 then
    raise exception '365: two new tags did not queue two facts';
  end if;
  perform public.crm_rules_drain_events(100);
  if (select count(*) from public.crm_rule_runs where rule_id = v_rx and outcome = 'done') <> 1
     or (select count(*) from public.crm_rule_runs where rule_id = v_rx and outcome = 'skipped' and detail ->> 'reason' = 'conditions') <> 1
     or not exists (select 1 from public.crm_contacts where id = v_c3 and 'Call back' = any (labels))
     or (select count(*) from public.crm_activities where client_id = v_t and contact_id = v_c3 and kind = 'task' and not done) <> 1
     -- The rule's own "add tag" is a fact too, queued for the NEXT drain — and it is the only one left.
     or exists (select 1 from public.crm_rule_events where client_id = v_t and processed_at is null
                  and payload ->> 'label' is distinct from 'Call back') then
    raise exception '365: draining the queue did not fire the tag rule exactly as its condition says';
  end if;
  -- A tag that is already there is not added again (no write, so no second fact): take "Hot" off,
  -- put "hot" back, and the rule fires again — its "add Call back" finds it already there.
  delete from public.crm_rule_events where client_id = v_t;
  update public.crm_rules set once_per_card = false where id = v_rx;
  update public.crm_contacts set labels = array_remove(labels, 'Hot') where id = v_c3;
  update public.crm_contacts set labels = array_append(labels, 'hot') where id = v_c3;
  perform public.crm_rules_drain_events(100);
  if (select count(*) from public.crm_rule_runs where rule_id = v_rx and outcome = 'done') <> 2 then
    raise exception '365: re-adding the tag did not fire the rule again';
  end if;
  if (select count(*) from public.crm_contacts c, unnest(c.labels) x where c.id = v_c3 and lower(x) = 'call back') <> 1 then
    raise exception '365: add_label added a tag the customer already had';
  end if;
  delete from public.crm_rules where id = v_rx;

  -- 7. INBOUND: never a stranger, never within a minute of our own text, and an "every time" rule
  --    fires at most once a day.
  insert into public.crm_rules (client_id, scope_kind, trigger_kind, trigger_event, once_per_card, name)
  values (v_t, 'contacts', 'event', 'text_received', false, '365 inbound check') returning id into v_rx;
  update public.crm_rules set applies_from = now() - interval '1 minute' where id = v_rx;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params) values (v_t, v_rx, 'add_note', '{"body":"They texted"}');
  delete from public.crm_rule_events where client_id = v_t;
  insert into public.sms_messages (client_id, contact_id, direction, from_number, to_number, body, status)
  values (v_t, null, 'in', '+15550103699', '+15550100000', 'stranger', 'received');
  if exists (select 1 from public.crm_rule_events where client_id = v_t and event = 'text_received') then
    raise exception '365: a text from a stranger was queued';
  end if;
  insert into public.sms_messages (client_id, contact_id, direction, from_number, to_number, body, status)
  values (v_t, v_c2, 'in', '+15550103652', '+15550100000', 'one', 'received'),
         (v_t, v_c2, 'in', '+15550103652', '+15550100000', 'two', 'received');
  perform public.crm_rules_drain_events(100);
  if (select count(*) from public.crm_rule_runs where rule_id = v_rx and outcome = 'done') <> 1
     or (select count(*) from public.crm_rule_runs where rule_id = v_rx and outcome = 'skipped'
           and detail ->> 'reason' = 'already run for them today') <> 1 then
    raise exception '365: an every-time inbound rule fired more than once a day';
  end if;
  insert into public.sms_messages (client_id, contact_id, direction, from_number, to_number, body, status)
  values (v_t, v_c1, 'out', '+15550100000', '+15550103651', 'ours', 'sent');
  delete from public.crm_rule_events where client_id = v_t;
  insert into public.sms_messages (client_id, contact_id, direction, from_number, to_number, body, status)
  values (v_t, v_c1, 'in', '+15550103651', '+15550100000', 'auto reply', 'received');
  if exists (select 1 from public.crm_rule_events where client_id = v_t and event = 'text_received') then
    raise exception '365: a text within a minute of our own was queued (two auto-replies could loop)';
  end if;
  delete from public.crm_rules where id = v_rx;

  -- 8. assign_owner to someone not on the team fails in words, and changes nothing.
  insert into public.crm_rules (client_id, scope_kind, trigger_kind, trigger_event, name)
  values (v_t, 'contacts', 'event', 'contact_made', '365 owner check') returning id into v_rx;
  update public.crm_rules set applies_from = now() - interval '1 minute' where id = v_rx;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params)
  values (v_t, v_rx, 'assign_owner', jsonb_build_object('userId', gen_random_uuid()));
  perform public.crm_rule_event(v_t, 'contact_made', v_c2, null);
  if (select count(*) from public.crm_rule_runs where rule_id = v_rx and outcome = 'failed'
        and detail ->> 'error' like '%no longer on your team%') <> 1
     or (select owner_user_id from public.crm_contacts where id = v_c2) is not null then
    raise exception '365: assign_owner reached outside the team';
  end if;
  delete from public.crm_rules where id = v_rx;

  -- 9. A CUSTOMER CLOCK is forward-only too: a brand-new zero-day "after they were added" rule
  --    touches none of the customers who already exist.
  update public.crm_contacts set created_at = now() - interval '5 days' where client_id = v_t;
  insert into public.crm_rules (client_id, scope_kind, trigger_kind, elapsed_anchor, elapsed_days, name)
  values (v_t, 'contacts', 'elapsed', 'contact_created', 0, '365 customer clock') returning id into v_rx;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params) values (v_t, v_rx, 'add_note', '{"body":"x"}');
  perform public.crm_rules_sweep(500);
  if exists (select 1 from public.crm_rule_runs where rule_id = v_rx) then
    raise exception '365: a brand-new customer clock swept existing customers';
  end if;
  delete from public.crm_rules where id = v_rx;

  -- 10. The preview counts what the audience would reach.
  if (public.crm_rule_audience_preview(v_t, 'contacts', null, '[{"field":"contact.has_phone","op":"eq","value":true}]') ->> 'count')::int <> 2
     or (public.crm_rule_audience_preview(v_t, 'pipeline', v_p1, '[]') ->> 'count')::int <> 1 then
    raise exception '365: the audience preview miscounted';
  end if;

  -- 11. Nothing new is reachable from a browser.
  if has_table_privilege('authenticated', 'public.crm_rule_events', 'select')
     or has_function_privilege('authenticated', 'public.crm_rules_drain_events(integer)', 'execute')
     or has_function_privilege('authenticated', 'public.crm_rule_audience_preview(text, text, uuid, jsonb)', 'execute') then
    raise exception '365: a browser role can reach the event queue or the audience';
  end if;

  delete from public.crm_rules         where client_id = v_t;
  delete from public.crm_rule_events   where client_id = v_t;
  delete from public.crm_notes         where client_id = v_t;
  delete from public.crm_activities    where client_id = v_t;
  delete from public.sms_messages      where client_id = v_t;
  delete from public.crm_pipelines     where client_id = v_t;
  delete from public.crm_deals         where client_id = v_t;
  delete from public.crm_statuses      where client_id = v_t;
  delete from public.crm_contacts      where client_id = v_t;
  raise notice '365 OK: the clock across DST, dates on a record, arming, the cap, late skips, team-only, the queue, inbound guards, owners, customer clocks and the preview all check out';
end;
$chk$;
