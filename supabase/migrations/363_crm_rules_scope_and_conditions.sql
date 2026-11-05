-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 363 — AUTOMATIONS, ROUND 1: a rule says WHO it is for, and may carry "only if" conditions
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Ledger read before writing this: max = 361 (359–361 were applied from other checkouts). It was
-- written as 362 and applied 2026-11-05 13:00 UTC — ten minutes after another agent applied
-- 362_billing_shed_naming, between that read and this apply. Renumbered to 363 the same hour, in
-- the file and in the ledger row (which apply_migration had stamped 20261105130005). The run-once
-- DO blocks below say 363 here; the copy that ran said 362. The functions are identical.
-- THE LESSON: read the ledger again IMMEDIATELY before applying, not when you start writing.
--
-- ── WHY (Carolyn, 2026-11-04 and -05) ────────────────────────────────────────────────────
-- 355 tied every rule to one pipeline: the pipeline you clicked "+ Add rule" under WAS the
-- rule's audience. Carolyn reversed that the day after it shipped, in her words: "I do not want
-- it connected to a specific pipeline… there needs to be an option to select which pipeline in
-- the rules portion." Her decisions, asked before any of this was written:
--   • Every rule has a "runs on" picker: cards in ONE pipeline · cards in EVERY pipeline ·
--     customers matching a filter · nobody, just the team.
--   • An existing rule MAY be moved to another pipeline.
--   • "Only if" conditions from the start.
--   • One flat list on Settings → Customer Hub → Automations.
-- This is round 1 of three. It lays every column the later rounds need, so rounds 2 and 3 are
-- additive, and it ships the two scopes that need no new query: one pipeline, and every
-- pipeline. The database already admits 'contacts' and 'none'; portal-settings refuses them
-- until round 2 builds the audience query and the schedule they need.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1  client_settings.time_zone — nothing reads it yet; round 2's schedules will
--   PART 2  crm_rules: scope_kind, conditions, applies_from, armed_count, max_per_run
--   PART 3  crm_rule_runs: a run may be on a customer (contact_id) and carry an occurrence
--   PART 4  crm_rule_outbox: hold_until (quiet hours WAITS, it is not a failure) + a lease
--   PART 5  the evaluator, generalised: facts, conditions, crm_rules_run, crm_rule_event, sweep
--   PART 6  checks, rehearsed on a made-up account and deleted
--
-- ── WHO A RULE FIRES ON, AND HOW MANY TIMES (read this before changing crm_rule_event) ───
--   scope           a CARD fact (estimate sent, delivered)    a CUSTOMER fact (contact made)
--   pipeline        that card, if it is in the pipeline        each open card in the pipeline
--   all_pipelines   that card                                  ONE card: their newest open one
--   contacts        the customer, once                         the customer, once
--   none            never (round 2: schedules only)            never
-- The all_pipelines row is the one that is easy to get wrong. A customer with a shed card, a
-- reviews card and a repair card must not get "thanks for calling" three times, so a customer
-- fact does NOT fan out to every card for an every-pipeline rule. A card fact still lands on its
-- own card, because "every pipeline's cards" means each card.
--
-- ── WHAT IS UNCHANGED, ON PURPOSE ────────────────────────────────────────────────────────
-- Everything 355 built to stop a rule texting a builder's customer base by accident: each rule
-- runs in its own sub-block and the evaluator raises nothing (its callers' handlers would roll
-- back the status advance); the once guard is a unique INDEX, not a check; a clock rule only
-- fires on cards whose anchor passes after the rule — now `applies_from`, which a move resets.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Additive for everything that exists. The one live rule (structure-studio, "ASK FOR REVIEW")
-- becomes scope 'pipeline' with applies_from = its created_at, i.e. exactly what it was. The
-- live crm-rules-tick ignores the new outbox columns and keeps working until it is redeployed.
-- The old 4-argument crm_rules_run is DROPPED, after its only three callers (crm_design_event,
-- crm_contact_made, crm_rules_sweep — checked against pg_proc on the live database) are
-- re-issued below, so nothing can reach the per-card path by accident.
--
-- The composite FK (pipeline_id, client_id) → crm_pipelines is LEFT AS 355 WROTE IT. It is MATCH
-- SIMPLE, so a row with pipeline_id NULL is simply not checked, and deleting a pipeline still
-- cascades to the rules that name it. Do not "fix" it to MATCH FULL — that refuses exactly the
-- (NULL, 'tenant') pair an every-pipeline rule is.
--
-- ── REVERSE (only if this has to be undone) ──────────────────────────────────────────────
--   -- Loses every rule that is not scope 'pipeline', by construction.
--   -- delete from public.crm_rules where scope_kind <> 'pipeline';
--   -- Re-issue crm_design_event, crm_contact_made, crm_rules_run(text,uuid,text,uuid) and
--   -- crm_rules_sweep from 355; then:
--   -- drop function if exists public.crm_rules_run(text, text, uuid, uuid, jsonb, uuid, text, text[]);
--   -- drop function if exists public.crm_rule_event(text, text, uuid, uuid, jsonb);
--   -- drop function if exists public.crm_rule_conditions_hold(jsonb, jsonb);
--   -- drop function if exists public.crm_rule_cmp(jsonb, jsonb);
--   -- drop function if exists public.crm_rule_facts(text, uuid, uuid, jsonb);
--   -- drop function if exists public.crm_rule_last_contact(text, uuid, timestamptz);
--   -- drop trigger if exists crm_rules_guard_reset on public.crm_rules;
--   -- drop function if exists public.crm_rules_guard_reset();
--   -- delete from public.crm_rule_runs where deal_id is null;
--   -- drop index public.crm_rule_runs_once_idx; create unique index crm_rule_runs_once_idx
--   --   on public.crm_rule_runs (rule_id, deal_id) where once_guard and outcome <> 'failed';
--   -- then drop the added columns and constraints, and client_settings.time_zone,
--   -- crm_tenant_time_zone and ss_valid_time_zone.
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.crm_rules') is null or to_regclass('public.crm_rule_runs') is null
     or to_regclass('public.crm_rule_outbox') is null then
    raise exception '363: the rule tables are missing (migration 355 not applied?)';
  end if;
  if to_regprocedure('public.crm_rules_run(text, uuid, text, uuid)') is null
     and to_regprocedure('public.crm_rules_run(text, text, uuid, uuid, jsonb, uuid, text, text[])') is null then
    raise exception '363: neither 355''s crm_rules_run nor this file''s is present — something else replaced it';
  end if;
end $$;

-- ── PART 1 — the account's time zone ─────────────────────────────────────────────────────
-- There was none anywhere: zones lived per phone number, per person's ring hours and per meeting
-- host. "Every Monday at 08:00" (round 2) has nothing to be 08:00 IN without this. Seeded from the
-- account's first phone number, which is where a builder already told us where they are.
create or replace function public.ss_valid_time_zone(p text)
returns boolean
language plpgsql
immutable
set search_path to ''
as $fn$
begin
  if p is null or length(p) > 64 or p !~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$' then
    return false;
  end if;
  perform now() at time zone p;          -- raises on a name Postgres does not know
  return true;
exception when others then
  return false;
end;
$fn$;

alter table public.client_settings
  add column if not exists time_zone text not null default 'America/Chicago';
alter table public.client_settings drop constraint if exists client_settings_time_zone_valid;
alter table public.client_settings
  add constraint client_settings_time_zone_valid check (public.ss_valid_time_zone(time_zone));

update public.client_settings s
   set time_zone = r.time_zone
  from (select distinct on (client_id) client_id, time_zone
          from public.phone_routes where time_zone is not null
         order by client_id, created_at) r
 where r.client_id = s.client_id
   and public.ss_valid_time_zone(r.time_zone)
   and s.time_zone is distinct from r.time_zone;

-- Some accounts have no client_settings row at all, so nothing may join it and assume one.
create or replace function public.crm_tenant_time_zone(p_client text)
returns text
language sql
stable
security definer
set search_path to ''
as $fn$
  select coalesce((select time_zone from public.client_settings where client_id = p_client), 'America/Chicago');
$fn$;
revoke execute on function public.crm_tenant_time_zone(text) from public, anon, authenticated;
grant  execute on function public.crm_tenant_time_zone(text) to service_role;

-- ── PART 2 — crm_rules: who a rule is for ────────────────────────────────────────────────
alter table public.crm_rules alter column pipeline_id drop not null;
alter table public.crm_rules add column if not exists scope_kind  text  not null default 'pipeline';
-- ALL must hold. An array of {field, op, value}; the vocabulary is closed and lives in
-- _shared/crmRules.ts (RULE_CONDITION_FIELDS), which is the only validation it gets — the same
-- division as an action's params. The database keeps only the cheap shape check.
alter table public.crm_rules add column if not exists conditions  jsonb not null default '[]'::jsonb;
-- THE FORWARD-ONLY LINE, moved off created_at so that it can be RESET. A clock rule fires only on
-- cards whose anchor passed after this instant. Backfilled to created_at, so the one live rule
-- means exactly what it meant.
alter table public.crm_rules add column if not exists applies_from timestamptz;
update public.crm_rules set applies_from = created_at where applies_from is null;
alter table public.crm_rules alter column applies_from set default now();
alter table public.crm_rules alter column applies_from set not null;
-- ROUND 2's arm step, laid now so round 2 is additive: a rule that texts or emails a GROUP saves
-- unarmed, and the builder arms it with the audience count on screen. NULL = not armed. Nothing
-- in round 1 reads it (round 1's scopes are card scopes, which fire one card at a time).
alter table public.crm_rules add column if not exists armed_count integer;
-- Round 2's per-tick ceiling for a scheduled rule. Laid now for the same reason.
alter table public.crm_rules add column if not exists max_per_run integer not null default 200;

alter table public.crm_rules drop constraint if exists crm_rules_scope_kind;
alter table public.crm_rules add constraint crm_rules_scope_kind
  check (scope_kind in ('pipeline', 'all_pipelines', 'contacts', 'none'));
-- The one line that ties the picker to the column: a pipeline id exactly when the rule is on one.
alter table public.crm_rules drop constraint if exists crm_rules_scope_pipeline;
alter table public.crm_rules add constraint crm_rules_scope_pipeline
  check ((scope_kind = 'pipeline') = (pipeline_id is not null));
-- "Nobody — just notify the team" has no subject, so only a clock can fire it. trigger_kind has
-- no 'schedule' until round 2, so this makes 'none' unsaveable today, which is the right state.
alter table public.crm_rules drop constraint if exists crm_rules_none_is_schedule;
alter table public.crm_rules add constraint crm_rules_none_is_schedule
  check (scope_kind <> 'none' or trigger_kind = 'schedule');
alter table public.crm_rules drop constraint if exists crm_rules_conditions_shape;
alter table public.crm_rules add constraint crm_rules_conditions_shape
  check (jsonb_typeof(conditions) = 'array' and jsonb_array_length(conditions) <= 10);
alter table public.crm_rules drop constraint if exists crm_rules_armed_count;
alter table public.crm_rules add constraint crm_rules_armed_count
  check (armed_count is null or armed_count >= 0);
alter table public.crm_rules drop constraint if exists crm_rules_max_per_run;
alter table public.crm_rules add constraint crm_rules_max_per_run
  check (max_per_run between 1 and 2000);

-- The list is flat now (one per account), and an event lookup can no longer lead on a pipeline
-- an every-pipeline rule does not have.
drop index if exists public.crm_rules_pipeline_idx;
create index if not exists crm_rules_client_idx
  on public.crm_rules (client_id, position) where archived_at is null;
drop index if exists public.crm_rules_event_idx;
create index crm_rules_event_idx
  on public.crm_rules (client_id, trigger_event)
  where archived_at is null and enabled and trigger_kind = 'event';

-- ⚠️ THE RESET, ENFORCED BY THE DATABASE rather than by portal-settings alone, because it is the
-- line between "move this rule" and a mass send. A "30 days after delivered" rule moved onto a
-- pipeline that delivered sheds for two years would otherwise fire on every one of them within
-- five minutes: their anchors all pass after the rule's ORIGINAL date. Changing who the rule is
-- for, or what it waits for, is writing a new rule; it applies from now.
--
-- Deliberately NOT reset: a rename, the actions, the conditions (narrowing a filter is not a new
-- rule), or pausing and resuming. A paused clock rule that is resumed catches up the cards that
-- came due while it was paused — they are the right customers, a little late — rather than
-- silently forgetting every delivery that had not yet reached its day.
--
-- The arm (round 2) is a promise about ONE audience, so anything that changes who the rule
-- reaches withdraws it — unless the same write re-arms it with a new count.
create or replace function public.crm_rules_guard_reset()
returns trigger
language plpgsql
set search_path to ''
as $fn$
begin
  if new.scope_kind     is distinct from old.scope_kind
  or new.pipeline_id    is distinct from old.pipeline_id
  or new.trigger_kind   is distinct from old.trigger_kind
  or new.trigger_event  is distinct from old.trigger_event
  or new.elapsed_anchor is distinct from old.elapsed_anchor
  or new.elapsed_days   is distinct from old.elapsed_days then
    new.applies_from := now();
  end if;
  if (new.scope_kind   is distinct from old.scope_kind
   or new.pipeline_id  is distinct from old.pipeline_id
   or new.conditions   is distinct from old.conditions
   or new.trigger_kind is distinct from old.trigger_kind)
   and new.armed_count is not distinct from old.armed_count then
    new.armed_count := null;
  end if;
  return new;
end;
$fn$;
drop trigger if exists crm_rules_guard_reset on public.crm_rules;
create trigger crm_rules_guard_reset before update on public.crm_rules
  for each row execute function public.crm_rules_guard_reset();

-- ── PART 3 — crm_rule_runs: a run may be on a customer, not a card ───────────────────────
alter table public.crm_rule_runs alter column deal_id drop not null;
alter table public.crm_rule_runs add column if not exists contact_id uuid;
-- What makes "once" mean once PER SOMETHING. '' for an event or a plain clock (once per subject,
-- ever — 355's behaviour). Round 2 puts a meeting id or a calendar day here, so a customer's
-- second meeting still gets its reminder and next Monday is not "already run".
alter table public.crm_rule_runs add column if not exists occurrence text not null default '';
update public.crm_rule_runs n set contact_id = d.contact_id
  from public.crm_deals d where d.id = n.deal_id and n.contact_id is null;

-- ⚠️ THE ONCE GUARD, re-keyed. Both statements in one transaction: between them there is no
-- guard at all, and the old key would refuse a customer rule's second subject outright.
drop index if exists public.crm_rule_runs_once_idx;
create unique index crm_rule_runs_once_idx on public.crm_rule_runs
  (rule_id, (coalesce(deal_id, contact_id, '00000000-0000-0000-0000-000000000000'::uuid)), occurrence)
  where once_guard and outcome <> 'failed';
create index if not exists crm_rule_runs_contact_idx
  on public.crm_rule_runs (contact_id, fired_at desc) where contact_id is not null;
-- The log is per RULE now (a moved rule keeps its history), not per pipeline.
create index if not exists crm_rule_runs_rule_idx
  on public.crm_rule_runs (rule_id, fired_at desc);

-- ── PART 4 — crm_rule_outbox: waiting is not failing ─────────────────────────────────────
-- A customer rule's message has no card; round 2's "tell the team" has no customer either.
alter table public.crm_rule_outbox alter column deal_id drop not null;
alter table public.crm_rule_outbox alter column contact_id drop not null;
-- ⚠️ THE BUG THIS FIXES (found 2026-11-04): a text that met quiet hours went down the retry path,
-- used one of its four attempts each tick, and was marked 'failed' twenty minutes later — while
-- the tick's own comment promised it waited for the morning. A quiet-hours refusal now parks the
-- row until the window opens where the customer lives, and costs no attempt.
alter table public.crm_rule_outbox add column if not exists hold_until   timestamptz;
-- A short claim instead of the attempts-claim, so a slow tick and the next one cannot both send,
-- and a crashed tick's row comes back after a few minutes rather than never.
alter table public.crm_rule_outbox add column if not exists leased_until timestamptz;
drop index if exists public.crm_rule_outbox_queue_idx;
create index if not exists crm_rule_outbox_due_idx
  on public.crm_rule_outbox ((coalesce(hold_until, queued_at))) where state = 'queued';
create index if not exists crm_rule_outbox_rule_idx
  on public.crm_rule_outbox (rule_id, queued_at desc);

-- ── PART 5 — the evaluator ───────────────────────────────────────────────────────────────

-- 355's "last contact" expression, lifted out so the sweep and the conditions (round 2) agree to
-- the second. The floor is the card's or the customer's own creation, so a lead nobody has ever
-- contacted still has an age.
create or replace function public.crm_rule_last_contact(p_client text, p_contact uuid, p_floor timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path to ''
as $fn$
  select greatest(
    coalesce((select max(m.created_at) from public.sms_messages m
               where m.client_id = p_client and m.contact_id = p_contact), p_floor),
    coalesce((select max(c.started_at) from public.phone_calls c
               where c.client_id = p_client and c.contact_id = p_contact), p_floor));
$fn$;
revoke execute on function public.crm_rule_last_contact(text, uuid, timestamptz) from public, anon, authenticated;
grant  execute on function public.crm_rule_last_contact(text, uuid, timestamptz) to service_role;

-- WHAT A CONDITION CAN SEE about one subject, as one flat object keyed exactly like
-- RULE_CONDITION_FIELDS in _shared/crmRules.ts. Built once per firing and read by one generic
-- comparator, so adding a field is a line here and a line there — not a new branch in the
-- evaluator. A key is PRESENT (possibly JSON null) for every field that applies to the subject,
-- which is how the comparator tells "no value" from "not a field we know".
-- Raises nothing: a failure here is an empty object, and every condition then reads false.
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
        -- dollars, not cents: the builder types "10000" meaning ten thousand dollars
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
        -- A person reads these as TAGS. Lower-cased here so "VIP" and "vip" are one tag.
        'contact.label',     coalesce((select jsonb_agg(lower(btrim(l))) from unnest(c.labels) l
                                        where nullif(btrim(l), '') is not null), '[]'::jsonb));
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

-- -1 / 0 / 1, or NULL when the two cannot be compared (that NULL is what makes "is more than
-- $abc" false rather than an error). Numbers compare as numbers, booleans as booleans, anything
-- else as case-insensitive text — which covers the uuids a status, stage or owner condition holds.
create or replace function public.crm_rule_cmp(a jsonb, b jsonb)
returns integer
language plpgsql
immutable
set search_path to ''
as $fn$
declare an numeric; bn numeric; x_a text; x_b text;
begin
  if a is null or b is null or a = 'null'::jsonb or b = 'null'::jsonb then return null; end if;
  if jsonb_typeof(a) = 'number' then
    begin
      an := (a #>> '{}')::numeric;
      bn := (b #>> '{}')::numeric;
    exception when others then
      return null;
    end;
    return case when an < bn then -1 when an > bn then 1 else 0 end;
  end if;
  if jsonb_typeof(a) = 'boolean' then
    x_a := lower(a #>> '{}');
    x_b := lower(b #>> '{}');
    if x_b not in ('true', 'false') then return null; end if;
    return case when x_a = x_b then 0 when x_a = 'false' then -1 else 1 end;
  end if;
  x_a := lower(btrim(a #>> '{}'));
  x_b := lower(btrim(b #>> '{}'));
  return case when x_a < x_b then -1 when x_a > x_b then 1 else 0 end;
end;
$fn$;
revoke execute on function public.crm_rule_cmp(jsonb, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_rule_cmp(jsonb, jsonb) to service_role;

-- DO ALL OF A RULE'S CONDITIONS HOLD for these facts? One loop, no per-field branches.
-- ⛔ A FIELD THIS DOES NOT KNOW, AN OP IT DOES NOT KNOW, OR ANY ERROR → FALSE. A rule that says
-- something we do not understand must not act; and this runs inside its caller's per-rule block,
-- so an exception would only be caught there and recorded as a failure on every card for ever.
create or replace function public.crm_rule_conditions_hold(p_facts jsonb, p_conditions jsonb)
returns boolean
language plpgsql
immutable
set search_path to ''
as $fn$
declare
  c jsonb; f text; op text; fv jsonb; v jsonb; ok boolean; v_has boolean;
begin
  if p_conditions is null or jsonb_typeof(p_conditions) <> 'array' then return false; end if;
  for c in select value from jsonb_array_elements(p_conditions) loop
    f  := c ->> 'field';
    op := c ->> 'op';
    v  := c -> 'value';
    if f is null or op is null or p_facts is null or not (p_facts ? f) then return false; end if;
    fv := p_facts -> f;
    if op in ('has', 'lacks') then
      v_has := jsonb_typeof(fv) = 'array' and exists (
        select 1 from jsonb_array_elements_text(fv) e where lower(btrim(e)) = lower(btrim(v #>> '{}')));
    end if;
    ok := case op
      when 'eq'        then public.crm_rule_cmp(fv, v) = 0
      -- "is not X" holds when there is no value at all: a card with no status is not "Invoiced".
      when 'neq'       then coalesce(public.crm_rule_cmp(fv, v) <> 0, fv = 'null'::jsonb)
      when 'gt'        then public.crm_rule_cmp(fv, v) > 0
      when 'lt'        then public.crm_rule_cmp(fv, v) < 0
      when 'has'       then v_has
      when 'lacks'     then not v_has
      when 'is_empty'  then fv = 'null'::jsonb or fv = '""'::jsonb or fv = '[]'::jsonb
      when 'not_empty' then not (fv = 'null'::jsonb or fv = '""'::jsonb or fv = '[]'::jsonb)
      else false
    end;
    if not coalesce(ok, false) then return false; end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$fn$;
revoke execute on function public.crm_rule_conditions_hold(jsonb, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_rule_conditions_hold(jsonb, jsonb) to service_role;

-- RUN EVERY RULE THAT WANTS THIS TRIGGER, FOR ONE SUBJECT.
--   p_deal set       — the subject is that card (pipeline and all_pipelines scopes)
--   p_deal NULL      — the subject is the customer p_contact (contacts scope)
--   p_rule set       — just that rule (the sweep, which already matched it)
--   p_scopes         — which scopes this call may run; crm_rule_event uses it to send a customer
--                      fact to each card for pipeline rules but only ONE card for every-pipeline
--                      rules (see the header's table)
--   p_occurrence     — part of the once key; '' unless round 2's clock says otherwise
-- ⛔ RAISES NOTHING (355's header): its callers' handlers roll back the status advance.
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
  v_occ      text := coalesce(p_occurrence, '');
begin
  if coalesce(btrim(coalesce(p_client, '')), '') = '' then return 0; end if;
  if p_deal is not null then
    select * into v_deal from public.crm_deals
     where id = p_deal and client_id = p_client and archived_at is null;
    if not found then return 0; end if;
    v_has_deal := true;
    v_contact := coalesce(v_contact, v_deal.contact_id);
  end if;
  if not v_has_deal and v_contact is null then return 0; end if;

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
            or (x.scope_kind = 'contacts'      and not v_has_deal and v_contact is not null))
       -- An event from before the rule was written (a replay, a slow transaction) never counts.
       -- The sweep passes p_rule and has already applied the anchor-based guard itself.
       and (p_rule is not null or now() >= x.applies_from)
     order by x.position, x.created_at
  loop
    -- ── ONE RULE, ONE SUB-BLOCK (355) ─────────────────────────────────────────────────────
    begin
      -- CONDITIONS FIRST, and INSIDE this block — never in the loop's WHERE. A raise in the
      -- WHERE would escape to crm_design_event's handler and undo the status the event just set.
      -- A rule whose conditions do not hold is logged as a skip and does NOT hold the once guard:
      -- the next event should get another look.
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

      -- Claim the subject for this rule FIRST: on a once rule the unique index refuses a second
      -- claim, which is how a race is lost safely rather than twice-sent.
      insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard, occurrence, detail)
      values (p_client, r.id, case when v_has_deal then v_deal.id end, v_contact, p_trigger, 'done', r.once_per_card, v_occ, '{}'::jsonb)
      returning id into v_run;

      v_done := '[]'::jsonb;
      for a in
        select * from public.crm_rule_actions
         where rule_id = r.id and client_id = p_client
         order by position, created_at
      loop
        -- portal-settings refuses these combinations at save time; this is the backstop, and it
        -- fails the rule in words rather than writing to a card that is not there.
        if a.kind in ('set_status', 'move_stage', 'mark_lost', 'reopen', 'set_follow_up', 'set_close_date')
           and not v_has_deal then
          raise exception 'That action needs a card, and this rule runs on a customer' using errcode = 'check_violation';
        end if;
        if a.kind in ('add_note', 'create_card', 'send_sms', 'send_email') and v_contact is null then
          raise exception 'That action needs a customer, and this card has none' using errcode = 'check_violation';
        end if;

        if a.kind = 'set_status' then
          -- crm_set_deal_status refuses a status from another pipeline (354): an every-pipeline
          -- rule cannot name one, and portal-settings refuses it before it gets here.
          perform public.crm_set_deal_status(p_client, v_deal.id, (a.params ->> 'statusId')::uuid, null, false);

        elsif a.kind = 'move_stage' then
          perform public.crm_move_deal(p_client, v_deal.id, (a.params ->> 'stageId')::uuid, null, null);

        elsif a.kind = 'mark_lost' then
          perform public.crm_set_deal_lost(p_client, v_deal.id, null, a.params ->> 'reason');

        elsif a.kind = 'reopen' then
          perform public.crm_clear_deal_lost(p_client, v_deal.id, null);

        elsif a.kind = 'set_follow_up' then
          update public.crm_deals
             set next_follow_up_at = now() + make_interval(days => coalesce((a.params ->> 'days')::int, 0)),
                 updated_at = now()
           where id = v_deal.id;

        elsif a.kind = 'set_close_date' then
          update public.crm_deals
             set expected_close_date = (now() + make_interval(days => coalesce((a.params ->> 'days')::int, 0)))::date,
                 updated_at = now()
           where id = v_deal.id;

        elsif a.kind = 'add_note' then
          -- created_by stays NULL: nobody wrote it (355).
          insert into public.crm_notes (client_id, contact_id, short_code, body)
          values (p_client, v_contact, case when v_has_deal then v_deal.short_code end,
                  left(coalesce(a.params ->> 'body', ''), 4000));

        elsif a.kind = 'create_card' then
          -- NOT a move (355). Skipped when the customer already has a card there.
          v_stage := public.crm_rule_first_stage(p_client, (a.params ->> 'pipelineId')::uuid);
          if v_stage is not null and not exists (
            select 1 from public.crm_deals d
             where d.client_id = p_client
               and d.pipeline_id = (a.params ->> 'pipelineId')::uuid
               and d.contact_id = v_contact
               and d.archived_at is null)
          then
            insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, title, source)
            values (p_client, (a.params ->> 'pipelineId')::uuid, v_stage, v_contact,
                    left(nullif(btrim(coalesce(a.params ->> 'title', '')), ''), 200), 'manual');
          end if;

        elsif a.kind in ('send_sms', 'send_email') then
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
                  jsonb_build_object('reason', case when v_has_deal then 'already run for this card'
                                                    else 'already run for this customer' end));
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

-- THE ONE ENTRY POINT FOR EVERY FACT. A card fact names the card; a customer fact names the
-- customer. Which rules it reaches, and how many times, is the header's table — and it lives here
-- and nowhere else. Raises nothing.
create or replace function public.crm_rule_event(
  p_client  text,
  p_event   text,
  p_contact uuid,
  p_deal    uuid  default null,
  p_payload jsonb default '{}'::jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_contact uuid := p_contact;
  v_n       integer := 0;
  v_newest  uuid;
  d         record;
begin
  -- Rules can write things that are themselves facts (round 2: a tag added by one rule is the
  -- "tag added" another rule waits for). Four levels is more chaining than any real rule set
  -- needs, and it stops two rules feeding each other for ever.
  if pg_trigger_depth() > 4 then return 0; end if;
  if coalesce(btrim(coalesce(p_client, '')), '') = '' or coalesce(btrim(coalesce(p_event, '')), '') = '' then
    return 0;
  end if;
  if p_deal is not null and v_contact is null then
    select contact_id into v_contact from public.crm_deals where id = p_deal and client_id = p_client;
  end if;

  if p_deal is not null then
    -- A CARD FACT: the card's own pipeline rules and the every-pipeline rules, on that card.
    v_n := v_n + public.crm_rules_run(p_client, p_event, v_contact, p_deal, p_payload, null, '',
                                      array['pipeline', 'all_pipelines']);
  elsif v_contact is not null then
    -- A CUSTOMER FACT: each open card for its pipeline's rules (355's crm_contact_made shape) …
    for d in
      select x.id from public.crm_deals x
       where x.client_id = p_client and x.contact_id = v_contact and x.archived_at is null
       order by x.created_at desc
    loop
      v_n := v_n + public.crm_rules_run(p_client, p_event, v_contact, d.id, p_payload, null, '', array['pipeline']);
      v_newest := coalesce(v_newest, d.id);
    end loop;
    -- … but ONE card for the every-pipeline rules, or three cards mean three texts.
    if v_newest is not null then
      v_n := v_n + public.crm_rules_run(p_client, p_event, v_contact, v_newest, p_payload, null, '',
                                        array['all_pipelines']);
    end if;
  end if;

  -- And the customer rules, once, whichever kind of fact it was.
  if v_contact is not null then
    v_n := v_n + public.crm_rules_run(p_client, p_event, v_contact, null, p_payload, null, '', array['contacts']);
  end if;
  return v_n;
exception when others then
  begin
    insert into public.app_errors (client_id, source, severity, code, message, context)
    values (p_client, 'db:crm_rule_event', 'error', 'crm_rule_event_failed',
            'crm_rule_event: ' || sqlerrm,
            jsonb_build_object('sqlstate', sqlstate, 'event', p_event, 'deal_id', p_deal, 'contact_id', p_contact));
  exception when others then null;
  end;
  return 0;
end;
$fn$;
revoke execute on function public.crm_rule_event(text, text, uuid, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_rule_event(text, text, uuid, uuid, jsonb) to service_role;

-- THE CLOCK (355), now for every-pipeline rules too, with conditions and applies_from.
-- Round 1 sweeps card anchors only; round 2 adds customer anchors and schedules.
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
begin
  for r in
    select * from public.crm_rules
     where trigger_kind = 'elapsed' and enabled and archived_at is null
       and scope_kind in ('pipeline', 'all_pipelines')
     order by client_id, position
  loop
    -- One bad rule must not stall every other account's clock.
    begin
      v_trigger := 'elapsed:' || r.elapsed_anchor || '+' || r.elapsed_days || 'd';
      for d in
        select * from (
          select dl.id as deal_id, dl.contact_id,
                 (case r.elapsed_anchor
                    when 'stage_entered'  then dl.stage_entered_at
                    when 'expected_close' then dl.expected_close_date::timestamptz
                    when 'delivered'      then (select g.delivered_at from public.designs g
                                                 where g.client_id = dl.client_id
                                                   and g.short_code = dl.short_code limit 1)
                    when 'last_contact'   then public.crm_rule_last_contact(dl.client_id, dl.contact_id, dl.created_at)
                    else null
                  end) as at
            from public.crm_deals dl
           where dl.client_id = r.client_id
             and (r.scope_kind = 'all_pipelines' or dl.pipeline_id = r.pipeline_id)
             and dl.archived_at is null
             -- Already run for this card (the rows that hold the once guard). Without this the
             -- guard would still catch it, by writing a 'skipped' row every sweep.
             and not exists (select 1 from public.crm_rule_runs n
                              where n.rule_id = r.id and n.deal_id = dl.id and n.occurrence = ''
                                and n.once_guard and n.outcome <> 'failed')
        ) q
        where q.at is not null
          and q.at + make_interval(days => r.elapsed_days) <= now()
          -- ⚠️ THE LINE (355): only cards whose anchor passed after the rule applies from.
          and q.at >= r.applies_from
          -- Folded in here rather than left to crm_rules_run, so a card that does not match is
          -- not logged as a skip every five minutes for ever.
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
  return v_n;
end;
$fn$;
revoke execute on function public.crm_rules_sweep(integer) from public, anon, authenticated;
grant  execute on function public.crm_rules_sweep(integer) to service_role;

-- 355's crm_design_event, one line changed: the rules go through crm_rule_event, so an
-- every-pipeline rule and (round 2) a customer rule hear a design's events too.
create or replace function public.crm_design_event(p_client_id text, p_short_code text, p_event text)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_deal public.crm_deals%rowtype; v_status uuid;
begin
  select * into v_deal from public.crm_deals
   where client_id = p_client_id and short_code = p_short_code;
  if not found then return; end if;
  select id into v_status from public.crm_statuses
   where client_id = p_client_id and pipeline_id = v_deal.pipeline_id
     and trigger_event = p_event and archived_at is null;
  if v_status is not null then
    perform public.crm_set_deal_status(p_client_id, v_deal.id, v_status, null, true);
  end if;
  -- After the advance, so a rule reading the card sees the status the event just set.
  perform public.crm_rule_event(p_client_id, p_event, v_deal.contact_id, v_deal.id);
end;
$fn$;
revoke execute on function public.crm_design_event(text, text, text) from public, anon, authenticated;
grant  execute on function public.crm_design_event(text, text, text) to service_role;

-- 355's crm_contact_made: the status advance stays per card, exactly as it was; the rules move
-- out of the loop to ONE crm_rule_event call, which does the per-card fan-out itself — and does
-- NOT do it for every-pipeline rules (three cards must not mean three texts).
create or replace function public.crm_contact_made(p_client_id text, p_contact uuid)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_n integer := 0; r record; v_first uuid; v_made uuid;
begin
  if p_contact is null or coalesce(btrim(p_client_id), '') = '' then return 0; end if;
  for r in select d.id, d.pipeline_id, d.status_id from public.crm_deals d
            where d.client_id = p_client_id and d.contact_id = p_contact and d.archived_at is null
  loop
    select id into v_made from public.crm_statuses
     where client_id = p_client_id and pipeline_id = r.pipeline_id
       and trigger_event = 'contact_made' and archived_at is null;
    if v_made is not null then
      select id into v_first from public.crm_statuses
       where pipeline_id = r.pipeline_id and archived_at is null order by position limit 1;
      if v_first is not null and v_first <> v_made and r.status_id is not distinct from v_first then
        perform public.crm_set_deal_status(p_client_id, r.id, v_made, null, true);
        v_n := v_n + 1;
      end if;
    end if;
  end loop;
  perform public.crm_rule_event(p_client_id, 'contact_made', p_contact, null);
  return v_n;
end;
$fn$;
revoke execute on function public.crm_contact_made(text, uuid) from public, anon, authenticated;
grant  execute on function public.crm_contact_made(text, uuid) to service_role;

-- Last, now that nothing calls it.
drop function if exists public.crm_rules_run(text, uuid, text, uuid);

-- ── PART 6 — checks ──────────────────────────────────────────────────────────────────────
-- Asserted rather than claimed, on a made-up account that is deleted at the end.
do $chk$
declare
  v_t   text := 'm363-rehearsal-' || substr(md5(random()::text), 1, 8);
  v_n   integer;
  v_p1  uuid; v_p2 uuid; v_s1 uuid; v_s1b uuid; v_s2 uuid;
  v_c   uuid; v_d1 uuid; v_d2 uuid; v_d3 uuid; v_r jsonb;
  v_rp  uuid; v_ra uuid; v_rc uuid; v_rx uuid; v_rm uuid; v_rz uuid;
  v_f   jsonb;
begin
  -- 1. The time zone.
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'client_settings' and column_name = 'time_zone' and is_nullable = 'NO') then
    raise exception '363: client_settings.time_zone is missing or nullable';
  end if;
  if not public.ss_valid_time_zone('America/Chicago') or public.ss_valid_time_zone('Mars/Olympus')
     or public.ss_valid_time_zone('') or public.ss_valid_time_zone(null) then
    raise exception '363: ss_valid_time_zone accepts a bad zone or refuses a good one';
  end if;
  if exists (select 1 from public.client_settings where not public.ss_valid_time_zone(time_zone)) then
    raise exception '363: an account was seeded with a time zone Postgres does not know';
  end if;
  if public.crm_tenant_time_zone(v_t) <> 'America/Chicago' then
    raise exception '363: an account with no settings row does not fall back to America/Chicago';
  end if;

  -- 2. Every rule that existed is exactly what it was.
  select count(*) into v_n from public.crm_rules
   where scope_kind <> 'pipeline' or pipeline_id is null or conditions <> '[]'::jsonb or applies_from <> created_at;
  if v_n > 0 then raise exception '363: % existing rule(s) changed meaning', v_n; end if;

  -- The rehearsal account: two pipelines, one customer with THREE open cards (two in p1).
  perform public.crm_ensure_pipelines(v_t);
  select id into v_p1 from public.crm_pipelines where client_id = v_t and seed_kind = 'shed_deals';
  v_p2 := public.crm_seed_pipeline(v_t, 'outreach');
  perform public.crm_seed_statuses(v_t, v_p2);
  select id into v_s1  from public.crm_pipeline_stages where pipeline_id = v_p1 and archived_at is null order by position limit 1;
  select id into v_s1b from public.crm_pipeline_stages where pipeline_id = v_p1 and archived_at is null order by position offset 1 limit 1;
  select id into v_s2  from public.crm_pipeline_stages where pipeline_id = v_p2 and archived_at is null order by position limit 1;
  v_r := public.crm_create_lead(v_t, 'Pat Rehearsal', 'Rehearsal Barns', '(555) 010-3063', 'pat363@example.invalid', null, null, 'manual', v_s1);
  v_d1 := (v_r ->> 'dealId')::uuid;
  select contact_id into v_c from public.crm_deals where id = v_d1;
  insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, title, source)
  values (v_t, v_p2, v_s2, v_c, 'Second card', 'manual') returning id into v_d2;
  insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, title, source)
  values (v_t, v_p1, v_s1b, v_c, 'Third card', 'manual') returning id into v_d3;
  -- Anchors in the past, as a real account's are: p1's cards 10 days in stage, p2's 40.
  update public.crm_deals set stage_entered_at = now() - interval '10 days' where id in (v_d1, v_d3);
  update public.crm_deals set stage_entered_at = now() - interval '40 days' where id = v_d2;

  -- 3. The scope constraints.
  begin
    insert into public.crm_rules (client_id, pipeline_id, scope_kind, trigger_kind, trigger_event)
    values (v_t, v_p1, 'all_pipelines', 'event', 'delivered');
    raise exception '363: an every-pipeline rule was allowed to name a pipeline';
  exception when check_violation then null;
  end;
  begin
    insert into public.crm_rules (client_id, pipeline_id, scope_kind, trigger_kind, trigger_event)
    values (v_t, null, 'pipeline', 'event', 'delivered');
    raise exception '363: a one-pipeline rule was allowed no pipeline';
  exception when check_violation then null;
  end;
  begin
    insert into public.crm_rules (client_id, scope_kind, trigger_kind, trigger_event)
    values (v_t, 'none', 'event', 'delivered');
    raise exception '363: a no-subject rule was allowed an event trigger';
  exception when check_violation then null;
  end;
  begin
    insert into public.crm_rules (client_id, scope_kind, trigger_kind, trigger_event, conditions)
    values (v_t, 'all_pipelines', 'event', 'delivered', '{"field":"x"}'::jsonb);
    raise exception '363: conditions that are not a list were accepted';
  exception when check_violation then null;
  end;

  -- 4. The reset: a move resets applies_from and withdraws an arm; a rename does neither.
  insert into public.crm_rules (client_id, pipeline_id, scope_kind, trigger_kind, trigger_event, name)
  values (v_t, v_p1, 'pipeline', 'event', 'delivered', 'reset check') returning id into v_rx;
  update public.crm_rules set applies_from = now() - interval '1 day', armed_count = 5 where id = v_rx;
  update public.crm_rules set name = 'renamed' where id = v_rx;
  if (select applies_from from public.crm_rules where id = v_rx) <> now() - interval '1 day'
     or (select armed_count from public.crm_rules where id = v_rx) <> 5 then
    raise exception '363: a rename reset applies_from or withdrew the arm';
  end if;
  update public.crm_rules set pipeline_id = v_p2 where id = v_rx;
  if (select applies_from from public.crm_rules where id = v_rx) <> now()
     or (select armed_count from public.crm_rules where id = v_rx) is not null then
    raise exception '363: a move did not reset applies_from or did not withdraw the arm';
  end if;
  update public.crm_rules set conditions = '[{"field":"deal.lost","op":"eq","value":false}]'::jsonb, armed_count = 7 where id = v_rx;
  if (select armed_count from public.crm_rules where id = v_rx) <> 7 then
    raise exception '363: re-arming in the same write as a change was refused';
  end if;
  delete from public.crm_rules where id = v_rx;

  -- 5. The once index, re-keyed.
  insert into public.crm_rules (client_id, pipeline_id, scope_kind, trigger_kind, trigger_event)
  values (v_t, v_p1, 'pipeline', 'event', 'delivered') returning id into v_rx;
  insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard)
  values (v_t, v_rx, v_d1, v_c, 'x', 'done', true);
  begin
    insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard)
    values (v_t, v_rx, v_d1, v_c, 'x', 'done', true);
    raise exception '363: the once guard let one card run twice';
  exception when unique_violation then null;
  end;
  insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard)
  values (v_t, v_rx, null, v_c, 'x', 'done', true);
  begin
    insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard)
    values (v_t, v_rx, null, v_c, 'x', 'done', true);
    raise exception '363: the once guard let one customer run twice';
  exception when unique_violation then null;
  end;
  insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard, occurrence)
  values (v_t, v_rx, v_d1, v_c, 'x', 'done', true, '2026-11-09'),
         (v_t, v_rx, v_d1, v_c, 'x', 'done', true, '2026-11-16'),
         (v_t, v_rx, v_d1, v_c, 'x', 'failed', true, '2026-11-16');
  delete from public.crm_rules where id = v_rx;

  -- 6. Conditions: the facts and the comparator.
  update public.crm_deals set value_cents = 1500000 where id = v_d1;
  update public.crm_contacts set labels = array['VIP', ' Lot visitor '] where id = v_c;
  v_f := public.crm_rule_facts(v_t, v_d1, null);
  if not public.crm_rule_conditions_hold(v_f, '[]')
     or not public.crm_rule_conditions_hold(v_f, jsonb_build_array(jsonb_build_object('field', 'deal.stage', 'op', 'eq', 'value', v_s1)))
     or     public.crm_rule_conditions_hold(v_f, jsonb_build_array(jsonb_build_object('field', 'deal.stage', 'op', 'eq', 'value', v_s2)))
     or not public.crm_rule_conditions_hold(v_f, jsonb_build_array(jsonb_build_object('field', 'deal.stage', 'op', 'neq', 'value', v_s2)))
     or not public.crm_rule_conditions_hold(v_f, '[{"field":"deal.value","op":"gt","value":10000}]')
     or not public.crm_rule_conditions_hold(v_f, '[{"field":"deal.value","op":"gt","value":"10000"}]')
     or     public.crm_rule_conditions_hold(v_f, '[{"field":"deal.value","op":"lt","value":10000}]')
     or not public.crm_rule_conditions_hold(v_f, '[{"field":"contact.has_phone","op":"eq","value":true}]')
     or not public.crm_rule_conditions_hold(v_f, '[{"field":"contact.label","op":"has","value":"vip"}]')
     or not public.crm_rule_conditions_hold(v_f, '[{"field":"contact.label","op":"has","value":"lot visitor"}]')
     or     public.crm_rule_conditions_hold(v_f, '[{"field":"contact.label","op":"lacks","value":"Vip"}]')
     or not public.crm_rule_conditions_hold(v_f, '[{"field":"deal.lost","op":"eq","value":false},{"field":"contact.has_email","op":"eq","value":true}]')
     or     public.crm_rule_conditions_hold(v_f, '[{"field":"deal.lost","op":"eq","value":false},{"field":"contact.has_email","op":"eq","value":false}]') then
    raise exception '363: a condition read the facts wrong';
  end if;
  -- A field or an op we do not know, or a value that cannot be compared, is FALSE — not an error.
  if public.crm_rule_conditions_hold(v_f, '[{"field":"deal.nonsense","op":"neq","value":"x"}]')
     or public.crm_rule_conditions_hold(v_f, '[{"field":"deal.value","op":"wobbles","value":1}]')
     or public.crm_rule_conditions_hold(v_f, '[{"field":"deal.value","op":"gt","value":"abc"}]')
     or public.crm_rule_conditions_hold(v_f, '"not a list"') then
    raise exception '363: an unknown field, op or value was read as true';
  end if;
  -- A customer subject carries no card facts, so a card condition on it is false.
  if public.crm_rule_conditions_hold(public.crm_rule_facts(v_t, null, v_c), '[{"field":"deal.lost","op":"eq","value":false}]') then
    raise exception '363: a customer subject answered a card condition';
  end if;

  -- 7. THE FAN-OUT (the header's table). Three rules on one event, one per scope.
  insert into public.crm_rules (client_id, pipeline_id, scope_kind, trigger_kind, trigger_event, once_per_card, name)
  values (v_t, v_p1, 'pipeline', 'event', 'delivered', false, 'p') returning id into v_rp;
  insert into public.crm_rules (client_id, pipeline_id, scope_kind, trigger_kind, trigger_event, once_per_card, name)
  values (v_t, null, 'all_pipelines', 'event', 'delivered', false, 'a') returning id into v_ra;
  insert into public.crm_rules (client_id, pipeline_id, scope_kind, trigger_kind, trigger_event, once_per_card, name)
  values (v_t, null, 'contacts', 'event', 'delivered', false, 'c') returning id into v_rc;
  update public.crm_rules set applies_from = now() - interval '1 minute' where id in (v_rp, v_ra, v_rc);
  insert into public.crm_rule_actions (client_id, rule_id, kind, params)
  select v_t, x, 'add_note', jsonb_build_object('body', '363 rehearsal') from unnest(array[v_rp, v_ra, v_rc]) x;
  -- A card fact on d1 (p1): one run each.
  perform public.crm_rule_event(v_t, 'delivered', null, v_d1);
  if (select count(*) from public.crm_rule_runs where rule_id = v_rp and outcome = 'done') <> 1
     or (select count(*) from public.crm_rule_runs where rule_id = v_ra and outcome = 'done' and deal_id = v_d1) <> 1
     or (select count(*) from public.crm_rule_runs where rule_id = v_rc and outcome = 'done' and deal_id is null and contact_id = v_c) <> 1 then
    raise exception '363: a card fact did not reach one pipeline rule, one every-pipeline rule and one customer rule';
  end if;
  -- A customer fact: the pipeline rule on BOTH p1 cards, the every-pipeline rule ONCE, the customer rule ONCE.
  perform public.crm_rule_event(v_t, 'delivered', v_c, null);
  if (select count(*) from public.crm_rule_runs where rule_id = v_rp and outcome = 'done') <> 3 then
    raise exception '363: a customer fact did not reach each of the pipeline''s cards';
  end if;
  if (select count(*) from public.crm_rule_runs where rule_id = v_ra and outcome = 'done') <> 2 then
    raise exception '363: a customer fact fired an every-pipeline rule once per card — three cards, three texts';
  end if;
  if (select count(*) from public.crm_rule_runs where rule_id = v_rc and outcome = 'done') <> 2 then
    raise exception '363: a customer rule did not fire exactly once per fact';
  end if;
  if (select count(*) from public.crm_notes where client_id = v_t and body = '363 rehearsal') <> 7 then
    raise exception '363: the runs and the notes they wrote disagree';
  end if;
  -- An event from before a rule applies never fires it.
  update public.crm_rules set applies_from = now() + interval '1 hour' where id = v_rc;
  perform public.crm_rule_event(v_t, 'delivered', v_c, null);
  if (select count(*) from public.crm_rule_runs where rule_id = v_rc) <> 2 then
    raise exception '363: a rule fired on an event from before it applied';
  end if;
  delete from public.crm_rules where id in (v_rp, v_ra, v_rc);

  -- 8. Conditions inside the evaluator: a miss is a skip that does not hold the guard.
  insert into public.crm_rules (client_id, pipeline_id, scope_kind, trigger_kind, trigger_event, conditions)
  values (v_t, v_p1, 'pipeline', 'event', 'estimate_sent',
          jsonb_build_array(jsonb_build_object('field', 'deal.stage', 'op', 'eq', 'value', v_s1b)))
  returning id into v_rx;
  update public.crm_rules set applies_from = now() - interval '1 minute' where id = v_rx;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params) values (v_t, v_rx, 'set_follow_up', '{"days":1}');
  perform public.crm_rule_event(v_t, 'estimate_sent', null, v_d1);      -- d1 is in s1: miss
  perform public.crm_rule_event(v_t, 'estimate_sent', null, v_d3);      -- d3 is in s1b: hit
  if (select count(*) from public.crm_rule_runs where rule_id = v_rx and deal_id = v_d1 and outcome = 'skipped'
        and detail ->> 'reason' = 'conditions' and not once_guard) <> 1
     or (select count(*) from public.crm_rule_runs where rule_id = v_rx and deal_id = v_d3 and outcome = 'done') <> 1 then
    raise exception '363: the evaluator did not apply the conditions';
  end if;
  delete from public.crm_rules where id = v_rx;

  -- 9. Never-fail (355): a broken action is ONE failed run and no exception to the caller; a
  -- card action on a customer subject is a failure in words.
  insert into public.crm_rules (client_id, pipeline_id, scope_kind, trigger_kind, trigger_event)
  values (v_t, v_p1, 'pipeline', 'event', 'invoiced') returning id into v_rx;
  update public.crm_rules set applies_from = now() - interval '1 minute' where id = v_rx;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params)
  values (v_t, v_rx, 'set_status', jsonb_build_object('statusId', gen_random_uuid()));
  perform public.crm_rule_event(v_t, 'invoiced', null, v_d1);
  if (select count(*) from public.crm_rule_runs where rule_id = v_rx and outcome = 'failed') <> 1 then
    raise exception '363: a broken action was not recorded as one failed run';
  end if;
  delete from public.crm_rules where id = v_rx;
  insert into public.crm_rules (client_id, scope_kind, trigger_kind, trigger_event)
  values (v_t, 'contacts', 'event', 'invoiced') returning id into v_rx;
  update public.crm_rules set applies_from = now() - interval '1 minute' where id = v_rx;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params) values (v_t, v_rx, 'reopen', '{}');
  perform public.crm_rule_event(v_t, 'invoiced', v_c, null);
  if (select count(*) from public.crm_rule_runs where rule_id = v_rx and outcome = 'failed'
        and detail ->> 'error' like '%needs a card%') <> 1 then
    raise exception '363: a card action on a customer was not refused in words';
  end if;
  delete from public.crm_rules where id = v_rx;

  -- 10. THE FORWARD-ONLY SWEEP (355's check, on cards whose anchors are in the past). A rule
  -- written now with a ZERO-day count is due for every card the instant it exists; it must touch
  -- none of them, in one pipeline or in all.
  insert into public.crm_rules (client_id, pipeline_id, scope_kind, trigger_kind, elapsed_anchor, elapsed_days, name)
  values (v_t, v_p1, 'pipeline', 'elapsed', 'stage_entered', 0, '363 sweep self-check') returning id into v_rz;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params) values (v_t, v_rz, 'set_follow_up', '{"days":1}');
  insert into public.crm_rules (client_id, scope_kind, trigger_kind, elapsed_anchor, elapsed_days, name)
  values (v_t, 'all_pipelines', 'elapsed', 'stage_entered', 0, '363 sweep self-check (all)') returning id into v_rx;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params) values (v_t, v_rx, 'set_follow_up', '{"days":1}');
  perform public.crm_rules_sweep(500);
  if exists (select 1 from public.crm_rule_runs where rule_id in (v_rz, v_rx)) then
    raise exception '363: a brand-new clock rule swept existing cards — the forward-only guard is gone';
  end if;
  delete from public.crm_rules where id in (v_rz, v_rx);

  -- 11. THE MOVE (found 2026-11-04). An OLD "30 days in stage" rule on p1 (whose cards are 10
  -- days in) is moved onto p2, whose card is 40 days in. Without the reset that card fires the
  -- moment the rule moves.
  insert into public.crm_rules (client_id, pipeline_id, scope_kind, trigger_kind, elapsed_anchor, elapsed_days, name)
  values (v_t, v_p1, 'pipeline', 'elapsed', 'stage_entered', 30, '363 move check') returning id into v_rm;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params) values (v_t, v_rm, 'set_follow_up', '{"days":1}');
  update public.crm_rules set applies_from = now() - interval '60 days' where id = v_rm;
  perform public.crm_rules_sweep(500);
  if exists (select 1 from public.crm_rule_runs where rule_id = v_rm) then
    raise exception '363: the move check fired on p1, whose cards are not due';
  end if;
  update public.crm_rules set pipeline_id = v_p2 where id = v_rm;
  perform public.crm_rules_sweep(500);
  if exists (select 1 from public.crm_rule_runs where rule_id = v_rm) then
    raise exception '363: moving a clock rule fired it on the new pipeline''s history';
  end if;
  -- And it IS the reset that stopped it: put applies_from back and the same card fires, once.
  update public.crm_rules set applies_from = now() - interval '60 days' where id = v_rm;
  perform public.crm_rules_sweep(500);
  perform public.crm_rules_sweep(500);
  if (select count(*) from public.crm_rule_runs where rule_id = v_rm and deal_id = v_d2 and outcome = 'done') <> 1
     or exists (select 1 from public.crm_rule_runs where rule_id = v_rm and deal_id <> v_d2) then
    raise exception '363: with the guard put back, the moved rule did not fire exactly once on the due card';
  end if;
  -- An every-pipeline clock rule reaches cards in any pipeline.
  update public.crm_rules set scope_kind = 'all_pipelines', pipeline_id = null where id = v_rm;
  update public.crm_rules set applies_from = now() - interval '60 days' where id = v_rm;
  delete from public.crm_rule_runs where rule_id = v_rm;
  perform public.crm_rules_sweep(500);
  if (select count(*) from public.crm_rule_runs where rule_id = v_rm and deal_id = v_d2) <> 1 then
    raise exception '363: an every-pipeline clock rule missed a due card';
  end if;

  -- 12. The FK still cascades, and a rule with no pipeline survives its account losing them all.
  insert into public.crm_rules (client_id, pipeline_id, scope_kind, trigger_kind, trigger_event)
  values (v_t, v_p2, 'pipeline', 'event', 'delivered') returning id into v_rx;
  delete from public.crm_pipelines where client_id = v_t;
  if exists (select 1 from public.crm_rules where id = v_rx) then
    raise exception '363: deleting a pipeline did not take its rules with it';
  end if;
  if not exists (select 1 from public.crm_rules where id = v_rm) then
    raise exception '363: deleting the pipelines took an every-pipeline rule with them';
  end if;

  -- 13. Nothing here is reachable from a browser, and the old per-card evaluator is gone.
  if has_function_privilege('authenticated', 'public.crm_rule_event(text, text, uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.crm_rules_run(text, text, uuid, uuid, jsonb, uuid, text, text[])', 'execute')
     or has_function_privilege('authenticated', 'public.crm_rule_facts(text, uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.crm_tenant_time_zone(text)', 'execute') then
    raise exception '363: a browser role can call the evaluator';
  end if;
  if to_regprocedure('public.crm_rules_run(text, uuid, text, uuid)') is not null then
    raise exception '363: the old per-card crm_rules_run is still callable';
  end if;

  -- Clean the rehearsal away.
  delete from public.crm_rules     where client_id = v_t;
  delete from public.crm_notes     where client_id = v_t;
  delete from public.crm_pipelines where client_id = v_t;
  delete from public.crm_deals     where client_id = v_t;
  delete from public.crm_statuses  where client_id = v_t;
  delete from public.crm_contacts  where client_id = v_t;
  if exists (select 1 from public.crm_rule_runs where client_id = v_t)
     or exists (select 1 from public.crm_deals where client_id = v_t) then
    raise exception '363: the rehearsal left rows behind';
  end if;

  raise notice '363 OK: time zone, scopes, the reset, the once key, conditions, the fan-out, never-fail, the forward-only sweep and the move all check out';
end;
$chk$;
