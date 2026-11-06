-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 355 — PER-PIPELINE RULES: "when ‹this happens› → ‹do this›"
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger read immediately before writing this: max(version::int) = 354, and this folder's
-- highest file is 354. So 355. Re-read BOTH before applying — this repo's folder has been ten
-- behind the database before, and a file numbered from memory overwrites someone else's work.
--
-- ── WHY (Carolyn, 2026-11-01/02) ─────────────────────────────────────────────────────────
-- Part D of the Customer Hub rework. The statuses migration (354) gave each pipeline its own
-- ladder but left the rungs that no built-in event sets unreachable: `trigger_event` is NULL
-- for them and nothing in the product can move a card onto one. Rules are the general answer —
-- the builder says what should happen, instead of us shipping a new event for each wish.
--
-- Carolyn's two scope decisions (2026-11-02), asked before any of this was written:
--   • Triggers: the eight events the system already records AND a clock ("30 days after
--     delivered" is the Reviews pipeline she is building towards).
--   • Actions: inside the Hub AND reaching the customer by text or email.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1  three tables: crm_rules, crm_rule_actions, crm_rule_runs, plus crm_rule_outbox
--   PART 2  the evaluator, crm_rules_run, and the two event functions re-issued to call it
--   PART 3  checks
--
-- Nothing is seeded. A tenant has no rules until somebody writes one, so applying this changes
-- the behaviour of exactly nothing until a builder opens Settings → Pipelines.
--
-- ── THE ONE HAZARD, AND WHY THE CODE LOOKS PARANOID ──────────────────────────────────────
-- Every event reaches the Hub through a trigger whose body is `begin … exception when others
-- then log end` (302's designs_pipeline_sync is the pattern). That handler ROLLS THE BLOCK
-- BACK. So an exception raised anywhere inside it does not merely lose the rules — it undoes
-- the status advance that had already succeeded, and the only symptom is cards quietly not
-- moving, which took twelve days to notice the last time this product failed that way
-- (CLAUDE.md, the Monday webhook).
--
-- Therefore: EVERY RULE RUNS IN ITS OWN SUB-BLOCK WITH ITS OWN HANDLER. A rule that throws is
-- recorded as `failed` in crm_rule_runs with the Postgres message, its own actions are rolled
-- back (a half-applied rule is worse than none), and the next rule still runs. The evaluator
-- itself can raise nothing to its caller. Do not "simplify" those nested blocks away.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Additive. The two re-issued functions keep their signatures and their old behaviour; the
-- only change is that they resolve the status first and then call the evaluator, so a pipeline
-- with no rung for an event now still gets its rules (before, that was an early return).
--
-- ── REVERSE (only if this has to be undone) ──────────────────────────────────────────────
--   -- Re-issue crm_design_event and crm_contact_made from 354 (they are unchanged there),
--   -- then:
--   -- drop function if exists public.crm_rules_run(text, uuid, text);
--   -- drop function if exists public.crm_rule_first_stage(text, uuid);
--   -- drop table if exists public.crm_rule_outbox;
--   -- drop table if exists public.crm_rule_runs;
--   -- drop table if exists public.crm_rule_actions;
--   -- drop table if exists public.crm_rules;
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.crm_pipelines') is null or to_regclass('public.crm_statuses') is null then
    raise exception '355: crm_pipelines / crm_statuses are missing (migrations 301-354 not applied?)';
  end if;
  -- 354 is what makes a rule's target status unambiguous: without pipeline_id a "set status"
  -- action would name one of several tenant-wide rows and pick the wrong pipeline's rung.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'crm_statuses' and column_name = 'pipeline_id') then
    raise exception '355: crm_statuses.pipeline_id is missing (migration 354 not applied)';
  end if;
end $$;

-- ── PART 1 — the tables ──────────────────────────────────────────────────────────────────

-- A rule belongs to ONE pipeline, like its stages, its statuses and its lost reasons (354).
-- There is no tenant-wide rule on purpose: "when delivered" means something different in the
-- shed pipeline and in a reviews pipeline, and a shared rule would fire on both.
create table if not exists public.crm_rules (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null,
  pipeline_id    uuid not null,
  name           text check (name is null or length(name) <= 120),
  -- 'event'   — one of the eight facts the system already records.
  -- 'elapsed' — a clock. Evaluated by a sweep, not by a trigger, because nothing happens at
  --             the moment a rule becomes due; see crm-rules-tick.
  trigger_kind   text not null check (trigger_kind in ('event', 'elapsed')),
  -- Deliberately NOT a foreign key onto a vocabulary table: the list lives in exactly one
  -- place (the CHECK on crm_statuses.trigger_event, 353:134) and this mirrors it so the two
  -- can be compared by eye. Adding an event means both.
  trigger_event  text check (trigger_event is null or trigger_event in
                   ('design_submitted', 'estimate_sent', 'estimate_accepted', 'invoiced',
                    'paid_in_full', 'build_scheduled', 'delivered', 'contact_made')),
  -- What the clock counts from. Each one is a timestamp the card already carries, so the sweep
  -- is a plain query and no new bookkeeping can drift out of step with it.
  elapsed_anchor text check (elapsed_anchor is null or elapsed_anchor in
                   ('delivered', 'stage_entered', 'last_contact', 'expected_close')),
  elapsed_days   integer check (elapsed_days is null or (elapsed_days >= 0 and elapsed_days <= 3650)),
  -- Reviews wants once (Carolyn's own example: ask for a review 30 days after delivery, not
  -- every sweep for ever). A nudge rule may want every time, so it is per rule — but the
  -- default is the safe one, and it is enforced by an index, not by the evaluator alone.
  once_per_card  boolean not null default true,
  enabled        boolean not null default true,
  position       double precision not null default 0,
  created_by     uuid,
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- The composite unique is what lets the child tables carry client_id and still be tied to
  -- the parent BY TENANT — the same shape 301 uses for stages, so a cross-tenant rule_id can
  -- never be referenced.
  unique (id, client_id),
  foreign key (pipeline_id, client_id) references public.crm_pipelines (id, client_id) on delete cascade,
  -- A trigger must be fully described by its own kind and say nothing about the other, so a
  -- row cannot read as both and leave the evaluator to choose.
  constraint crm_rules_trigger_shape check (
    (trigger_kind = 'event'   and trigger_event is not null and elapsed_anchor is null and elapsed_days is null)
    or
    (trigger_kind = 'elapsed' and trigger_event is null and elapsed_anchor is not null and elapsed_days is not null)
  ),
  -- ⛔ AN ELAPSED RULE IS ALWAYS ONCE PER CARD, and this is a constraint rather than a default
  -- because the alternative is not a quirk, it is a disaster. "30 days after delivered" is true
  -- of a card from the moment it comes due and stays true for ever, so a rule allowed to run
  -- every time would fire on every sweep — a text to the same customer every five minutes until
  -- somebody noticed. "Every time" is meaningful for an EVENT, which happens and is over.
  constraint crm_rules_elapsed_is_once check (trigger_kind <> 'elapsed' or once_per_card)
);
create index if not exists crm_rules_pipeline_idx
  on public.crm_rules (client_id, pipeline_id, position) where archived_at is null;
-- The evaluator's own lookup: every firing asks "which live rules on this pipeline want this
-- event?", so it is worth its own index rather than filtering the one above.
create index if not exists crm_rules_event_idx
  on public.crm_rules (client_id, pipeline_id, trigger_event)
  where archived_at is null and enabled and trigger_kind = 'event';
-- The sweep's lookup, tenant-wide: it walks every elapsed rule on the platform each tick.
create index if not exists crm_rules_elapsed_idx
  on public.crm_rules (trigger_kind, elapsed_anchor)
  where archived_at is null and enabled and trigger_kind = 'elapsed';

-- ONE TRIGGER, SEVERAL ACTIONS, IN ORDER. Carolyn's reviews case is already two ("set the
-- status" and "send the review request"), and a one-action rule would have had her write the
-- same trigger twice and hope they stayed in step.
create table if not exists public.crm_rule_actions (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null,
  rule_id    uuid not null,
  position   double precision not null default 0,
  kind       text not null check (kind in (
               -- inside the Hub: all of these are writes this database can make itself
               'set_status', 'move_stage', 'mark_lost', 'reopen',
               'set_follow_up', 'set_close_date', 'add_note', 'create_card',
               -- reaching the customer: QUEUED here, sent by crm-rules-tick. Postgres has no
               -- business holding a Twilio or Resend connection, and an outbound send that
               -- fails must not roll back the Hub writes that already succeeded.
               'send_sms', 'send_email')),
  -- Shape is validated where it is authored (portal-settings' RULE_ACTIONS table), not by a
  -- jsonb CHECK: the vocabulary differs per kind and a constraint spanning ten shapes is
  -- unreadable and unmaintainable. The evaluator treats a malformed row as a failed rule.
  params     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id),
  foreign key (rule_id, client_id) references public.crm_rules (id, client_id) on delete cascade
);
create index if not exists crm_rule_actions_rule_idx
  on public.crm_rule_actions (rule_id, position);

-- THE RUN LOG. A rule that did nothing must be explainable (the plan's fourth open question):
-- without this, "the review text never went out" has no answer at all — not whether the rule
-- matched, not whether it was skipped, not what Postgres said.
create table if not exists public.crm_rule_runs (
  id         bigserial primary key,
  client_id  text not null,
  rule_id    uuid not null,
  deal_id    uuid not null,
  -- The event name, or 'elapsed:<anchor>+<n>d'. Stored as text rather than joined back to the
  -- rule because a rule is editable: the log must say what fired at the time, not what the
  -- rule has since been changed to say.
  trigger    text not null,
  outcome    text not null check (outcome in ('done', 'failed', 'skipped')),
  -- Per-action results, or the reason for a skip, or sqlstate + sqlerrm for a failure.
  detail     jsonb not null default '{}'::jsonb,
  -- Copied from the rule at firing time, because the once guard below is an INDEX and an index
  -- cannot read the parent row. Editing a rule to fire every time therefore does not retract
  -- the guard on cards it has already acted on — which is the right way round: those customers
  -- have already had the text.
  once_guard boolean not null default false,
  fired_at   timestamptz not null default now(),
  foreign key (rule_id, client_id) references public.crm_rules (id, client_id) on delete cascade
);
-- ⚠️ THE ONCE GUARD IS THIS INDEX, not the evaluator's existence check. The check alone loses
-- the race that matters: two events on one card in the same instant (an estimate accepted and
-- invoiced land together often enough) would each see no row and each send the customer a
-- text. A 'failed' run deliberately does NOT hold the guard — a rule that threw never reached
-- its actions, so the next event should try again.
create unique index if not exists crm_rule_runs_once_idx
  on public.crm_rule_runs (rule_id, deal_id) where once_guard and outcome <> 'failed';
create index if not exists crm_rule_runs_log_idx
  on public.crm_rule_runs (client_id, fired_at desc);
create index if not exists crm_rule_runs_deal_idx
  on public.crm_rule_runs (deal_id, fired_at desc);

-- OUTBOUND, QUEUED. Written by the evaluator inside the database transaction, drained by
-- crm-rules-tick. The queue is the thing that makes "a rule texts the customer" safe to put
-- inside a trigger: the send is somebody else's problem, later, and a Twilio outage cannot
-- roll back a card's status.
create table if not exists public.crm_rule_outbox (
  id         bigserial primary key,
  client_id  text not null,
  run_id     bigint not null references public.crm_rule_runs (id) on delete cascade,
  rule_id    uuid not null,
  deal_id    uuid not null,
  contact_id uuid not null,
  kind       text not null check (kind in ('send_sms', 'send_email')),
  params     jsonb not null default '{}'::jsonb,
  state      text not null default 'queued' check (state in ('queued', 'sent', 'failed', 'skipped')),
  attempts   integer not null default 0,
  last_error text,
  queued_at  timestamptz not null default now(),
  sent_at    timestamptz,
  foreign key (rule_id, client_id) references public.crm_rules (id, client_id) on delete cascade
);
create index if not exists crm_rule_outbox_queue_idx
  on public.crm_rule_outbox (queued_at) where state = 'queued';
create index if not exists crm_rule_outbox_deal_idx
  on public.crm_rule_outbox (client_id, deal_id, queued_at desc);

-- RLS: the 054 posture. Every one of these is read through an edge function, so there is no
-- read policy either — the browser never sees a rule except as portal-settings serves it, and
-- nothing is writable from a browser at all. A rule can text a customer; it is not something
-- an authenticated session should be able to reach past the function's access gate.
alter table public.crm_rules        enable row level security;
alter table public.crm_rule_actions enable row level security;
alter table public.crm_rule_runs    enable row level security;
alter table public.crm_rule_outbox  enable row level security;
revoke all on public.crm_rules        from anon, authenticated;
revoke all on public.crm_rule_actions from anon, authenticated;
revoke all on public.crm_rule_runs    from anon, authenticated;
revoke all on public.crm_rule_outbox  from anon, authenticated;

-- ── PART 2 — the evaluator ───────────────────────────────────────────────────────────────

-- A card created by a rule has to start somewhere, and "the first stage" is the only answer
-- that does not need the builder to name one (and then keep it right when they reorder).
create or replace function public.crm_rule_first_stage(p_client_id text, p_pipeline uuid)
returns uuid
language sql
stable
security definer
set search_path to ''
as $fn$
  select id from public.crm_pipeline_stages
   where client_id = p_client_id and pipeline_id = p_pipeline and archived_at is null
   order by position, created_at
   limit 1;
$fn$;
revoke execute on function public.crm_rule_first_stage(text, uuid) from public, anon, authenticated;
grant  execute on function public.crm_rule_first_stage(text, uuid) to service_role;

-- RUN EVERY RULE ON THIS CARD'S PIPELINE THAT WANTS THIS TRIGGER.
--
-- p_trigger is the event name ('delivered') for an event rule, or 'elapsed:<anchor>+<n>d' for
-- a swept one; the sweep passes the rule it already matched, so this function matches event
-- rules only and takes the elapsed ones by id.
--
-- ⛔ RAISES NOTHING. See the header: its callers' exception handlers roll back the status
-- advance, so an escaping error here stops cards moving across the whole product.
create or replace function public.crm_rules_run(p_client_id text, p_deal uuid, p_trigger text, p_rule uuid default null)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_deal public.crm_deals%rowtype;
  v_n    integer := 0;
  r      record;
  a      record;
  v_run  bigint;
  v_done jsonb;
  v_stage uuid;
  v_new  uuid;
begin
  if p_deal is null or coalesce(btrim(coalesce(p_client_id, '')), '') = '' then return 0; end if;
  select * into v_deal from public.crm_deals
   where id = p_deal and client_id = p_client_id and archived_at is null;
  if not found then return 0; end if;

  for r in
    select * from public.crm_rules
     where client_id = p_client_id
       and pipeline_id = v_deal.pipeline_id
       and archived_at is null
       and enabled
       and (case when p_rule is not null then id = p_rule
                 else trigger_kind = 'event' and trigger_event = p_trigger end)
     order by position, created_at
  loop
    -- ── ONE RULE, ONE SUB-BLOCK ───────────────────────────────────────────────────────────
    -- Everything below runs or none of it does, and either way the loop continues and the
    -- caller never sees an exception.
    begin
      -- Claim the card for this rule FIRST. On a once-per-card rule the unique index refuses
      -- the second claim, which is how the race is lost safely rather than twice-sent; the
      -- unique_violation lands in the handler below and is recorded as a skip.
      insert into public.crm_rule_runs (client_id, rule_id, deal_id, trigger, outcome, once_guard, detail)
      values (p_client_id, r.id, v_deal.id, p_trigger, 'done', r.once_per_card, '{}'::jsonb)
      returning id into v_run;

      v_done := '[]'::jsonb;
      for a in
        select * from public.crm_rule_actions
         where rule_id = r.id and client_id = p_client_id
         order by position, created_at
      loop
        if a.kind = 'set_status' then
          -- crm_set_deal_status refuses a status from another pipeline (354), which is the
          -- check that matters here: a rule keeps pointing at a status id after somebody
          -- archives it or moves the card's pipeline out from under it.
          perform public.crm_set_deal_status(p_client_id, v_deal.id, (a.params ->> 'statusId')::uuid, null, false);

        elsif a.kind = 'move_stage' then
          perform public.crm_move_deal(p_client_id, v_deal.id, (a.params ->> 'stageId')::uuid, null, null);

        elsif a.kind = 'mark_lost' then
          perform public.crm_set_deal_lost(p_client_id, v_deal.id, null, a.params ->> 'reason');

        elsif a.kind = 'reopen' then
          perform public.crm_clear_deal_lost(p_client_id, v_deal.id, null);

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
          -- created_by stays NULL: nobody wrote it. The body says the rule did, so a builder
          -- reading the record is never told a colleague said something they did not.
          insert into public.crm_notes (client_id, contact_id, short_code, body)
          values (p_client_id, v_deal.contact_id, v_deal.short_code,
                  left(coalesce(a.params ->> 'body', ''), 4000));

        elsif a.kind = 'create_card' then
          -- NOT a move (Carolyn 2026-11-01: a card stays in its pipeline). This is the second
          -- card — a delivered shed becoming a reviews card — and it is skipped when the
          -- contact already has one there, or a re-fired rule would pile them up.
          v_stage := public.crm_rule_first_stage(p_client_id, (a.params ->> 'pipelineId')::uuid);
          if v_stage is not null and not exists (
            select 1 from public.crm_deals d
             where d.client_id = p_client_id
               and d.pipeline_id = (a.params ->> 'pipelineId')::uuid
               and d.contact_id = v_deal.contact_id
               and d.archived_at is null)
          then
            insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, title, source)
            values (p_client_id, (a.params ->> 'pipelineId')::uuid, v_stage, v_deal.contact_id,
                    left(nullif(btrim(coalesce(a.params ->> 'title', '')), ''), 200), 'manual')
            returning id into v_new;
          end if;

        elsif a.kind in ('send_sms', 'send_email') then
          insert into public.crm_rule_outbox (client_id, run_id, rule_id, deal_id, contact_id, kind, params)
          values (p_client_id, v_run, r.id, v_deal.id, v_deal.contact_id, a.kind, a.params);

        else
          raise exception 'unknown rule action %', a.kind using errcode = 'check_violation';
        end if;

        v_done := v_done || jsonb_build_object('action', a.id, 'kind', a.kind);
      end loop;

      update public.crm_rule_runs set detail = jsonb_build_object('actions', v_done) where id = v_run;
      v_n := v_n + 1;

    exception
      when unique_violation then
        -- The once guard. Recorded so the log can answer "why did nothing happen?" rather
        -- than leaving a silent gap, and NOT once_guard itself or it would collide in turn.
        begin
          insert into public.crm_rule_runs (client_id, rule_id, deal_id, trigger, outcome, once_guard, detail)
          values (p_client_id, r.id, v_deal.id, p_trigger, 'skipped', false,
                  jsonb_build_object('reason', 'already run for this card'));
        exception when others then null;
        end;
      when others then
        begin
          insert into public.crm_rule_runs (client_id, rule_id, deal_id, trigger, outcome, once_guard, detail)
          values (p_client_id, r.id, v_deal.id, p_trigger, 'failed', false,
                  jsonb_build_object('sqlstate', sqlstate, 'error', sqlerrm));
        exception when others then null;
        end;
    end;
  end loop;

  return v_n;
end;
$fn$;
revoke execute on function public.crm_rules_run(text, uuid, text, uuid) from public, anon, authenticated;
grant  execute on function public.crm_rules_run(text, uuid, text, uuid) to service_role;

-- THE CLOCK. Nothing happens at the moment a rule becomes due, so an elapsed rule needs somebody
-- to come and ask — this is what crm-rules-tick calls, on the phone-api Worker's one-minute tick,
-- which is the only real scheduler in this product (pg_cron is NOT installed on this project, and
-- CLAUDE.md records what the last function that assumed otherwise cost: `sync_all` has never run).
--
-- ⚠️ A NEW RULE ONLY ACTS GOING FORWARD, and that `q.at >= r.created_at` clause is the single most
-- important line in this file. "30 days after it was delivered" is true of every shed this builder
-- delivered in the last two years. Without it, saving that rule would text the whole customer base
-- within a minute — hundreds of messages, from a screen whose Save button gives no hint of it. With
-- it, the rule applies to cards whose anchor passes after it was written, which is what a person
-- means by "from now on".
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
     order by client_id, position
  loop
    v_trigger := 'elapsed:' || r.elapsed_anchor || '+' || r.elapsed_days || 'd';
    for d in
      select * from (
        select dl.id as deal_id,
               (case r.elapsed_anchor
                  when 'stage_entered'  then dl.stage_entered_at
                  -- A date, not an instant: midnight of that day, so "0 days after the expected
                  -- close date" comes due on the day itself rather than at some hour of it.
                  when 'expected_close' then dl.expected_close_date::timestamptz
                  when 'delivered'      then (select g.delivered_at from public.designs g
                                               where g.client_id = dl.client_id
                                                 and g.short_code = dl.short_code limit 1)
                  -- The newest of a text and a call. The card's own creation is the floor, so a
                  -- lead nobody has ever contacted still has an age — otherwise "no contact for
                  -- 7 days" would be silent about exactly the leads it exists to catch.
                  when 'last_contact'   then greatest(
                                               coalesce((select max(m.created_at) from public.sms_messages m
                                                          where m.client_id = dl.client_id and m.contact_id = dl.contact_id), dl.created_at),
                                               coalesce((select max(c.started_at) from public.phone_calls c
                                                          where c.client_id = dl.client_id and c.contact_id = dl.contact_id), dl.created_at))
                  else null
                end) as at
          from public.crm_deals dl
         where dl.client_id = r.client_id
           and dl.pipeline_id = r.pipeline_id
           and dl.archived_at is null
           -- Already run for this card. The once guard in crm_rules_run would catch it anyway,
           -- but it would catch it by writing a 'skipped' row EVERY sweep, and the log would be
           -- nothing but skips within a day.
           and not exists (select 1 from public.crm_rule_runs n
                            where n.rule_id = r.id and n.deal_id = dl.id and n.outcome <> 'failed')
      ) q
      where q.at is not null
        and q.at + make_interval(days => r.elapsed_days) <= now()
        and q.at >= r.created_at          -- see the header: going forward only
      order by q.at
      limit greatest(coalesce(p_limit, 200), 1)
    loop
      -- crm_rules_run raises nothing, records each firing, and holds the once guard itself.
      perform public.crm_rules_run(r.client_id, d.deal_id, v_trigger, r.id);
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_n;
end;
$fn$;
revoke execute on function public.crm_rules_sweep(integer) from public, anon, authenticated;
grant  execute on function public.crm_rules_sweep(integer) to service_role;

-- 354's crm_design_event, with two changes and no others: the early return when the pipeline
-- has no rung for this event is gone (a pipeline with no "Delivered" status may still have a
-- rule about being delivered), and the rules run after the advance.
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
  -- 355. After the advance, so a rule reading the card sees the status the event just set.
  perform public.crm_rules_run(p_client_id, v_deal.id, p_event);
end;
$fn$;
revoke execute on function public.crm_design_event(text, text, text) from public, anon, authenticated;
grant  execute on function public.crm_design_event(text, text, text) to service_role;

-- 354's crm_contact_made, same two changes, per card in the loop. The first-rung test still
-- governs the STATUS advance only — a contact_made rule fires wherever the card stands, because
-- "somebody talked to them" is true regardless of which rung they are on.
create or replace function public.crm_contact_made(p_client_id text, p_contact uuid)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_n integer := 0; r record; v_first uuid; v_made uuid; v_moved boolean;
begin
  if p_contact is null or coalesce(btrim(p_client_id), '') = '' then return 0; end if;
  for r in select d.id, d.pipeline_id, d.status_id from public.crm_deals d
            where d.client_id = p_client_id and d.contact_id = p_contact and d.archived_at is null
  loop
    v_moved := false;
    select id into v_made from public.crm_statuses
     where client_id = p_client_id and pipeline_id = r.pipeline_id
       and trigger_event = 'contact_made' and archived_at is null;
    if v_made is not null then
      select id into v_first from public.crm_statuses
       where pipeline_id = r.pipeline_id and archived_at is null order by position limit 1;
      if v_first is not null and v_first <> v_made and r.status_id is not distinct from v_first then
        perform public.crm_set_deal_status(p_client_id, r.id, v_made, null, true);
        v_moved := true;
        v_n := v_n + 1;
      end if;
    end if;
    -- 355.
    perform public.crm_rules_run(p_client_id, r.id, 'contact_made');
  end loop;
  return v_n;
end;
$fn$;
revoke execute on function public.crm_contact_made(text, uuid) from public, anon, authenticated;
grant  execute on function public.crm_contact_made(text, uuid) to service_role;

-- ── PART 3 — checks ──────────────────────────────────────────────────────────────────────
-- Asserted rather than claimed, so applying this file proves its own invariants.
do $$
declare v_n integer; v_rule uuid; v_pipe uuid; v_deal uuid; v_client text; v_runs integer;
begin
  -- The four tables exist with RLS on and nothing granted to a browser.
  select count(*) into v_n from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relrowsecurity
     and c.relname in ('crm_rules', 'crm_rule_actions', 'crm_rule_runs', 'crm_rule_outbox');
  if v_n <> 4 then raise exception '355: expected 4 rule tables with RLS on, found %', v_n; end if;
  select count(*) into v_n from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'authenticated')
     and table_name in ('crm_rules', 'crm_rule_actions', 'crm_rule_runs', 'crm_rule_outbox');
  if v_n <> 0 then raise exception '355: a browser role can still reach the rule tables (% grants)', v_n; end if;

  -- The trigger shape CHECK refuses a half-described rule. Tested on a real pipeline so the
  -- foreign keys are exercised too; rolled back at the end.
  select p.client_id, p.id into v_client, v_pipe from public.crm_pipelines p
   where p.archived_at is null order by p.created_at limit 1;
  if v_pipe is null then
    raise notice '355: no pipeline on this database, shape checks skipped';
    return;
  end if;

  begin
    insert into public.crm_rules (client_id, pipeline_id, trigger_kind, trigger_event, elapsed_days)
    values (v_client, v_pipe, 'event', 'delivered', 30);
    raise exception '355: an event rule carrying elapsed_days was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.crm_rules (client_id, pipeline_id, trigger_kind, elapsed_anchor)
    values (v_client, v_pipe, 'elapsed', 'delivered');
    raise exception '355: an elapsed rule with no day count was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.crm_rules (client_id, pipeline_id, trigger_kind, elapsed_anchor, elapsed_days, once_per_card)
    values (v_client, v_pipe, 'elapsed', 'delivered', 30, false);
    raise exception '355: an elapsed rule was allowed to run more than once per card';
  exception when check_violation then null;
  end;

  -- The once guard refuses a second claim for the same card, and a failed run does not hold it.
  insert into public.crm_rules (client_id, pipeline_id, name, trigger_kind, trigger_event)
  values (v_client, v_pipe, '355 self-check', 'event', 'delivered') returning id into v_rule;
  select id into v_deal from public.crm_deals where client_id = v_client and pipeline_id = v_pipe
    and archived_at is null limit 1;
  if v_deal is not null then
    insert into public.crm_rule_runs (client_id, rule_id, deal_id, trigger, outcome, once_guard)
    values (v_client, v_rule, v_deal, 'delivered', 'done', true);
    begin
      insert into public.crm_rule_runs (client_id, rule_id, deal_id, trigger, outcome, once_guard)
      values (v_client, v_rule, v_deal, 'delivered', 'done', true);
      raise exception '355: the once guard allowed a second run for the same card';
    exception when unique_violation then null;
    end;
    insert into public.crm_rule_runs (client_id, rule_id, deal_id, trigger, outcome, once_guard)
    values (v_client, v_rule, v_deal, 'delivered', 'failed', true);

    -- And the evaluator itself: a rule whose action names a status that does not exist must be
    -- recorded as failed and must not raise, because its caller's handler would roll back the
    -- status advance that had already succeeded.
    insert into public.crm_rule_actions (client_id, rule_id, kind, params)
    values (v_client, v_rule, 'set_status', jsonb_build_object('statusId', gen_random_uuid()));
    delete from public.crm_rule_runs where rule_id = v_rule;
    update public.crm_rules set once_per_card = false where id = v_rule;
    perform public.crm_rules_run(v_client, v_deal, 'delivered', v_rule);
    select count(*) into v_runs from public.crm_rule_runs
     where rule_id = v_rule and outcome = 'failed';
    if v_runs <> 1 then
      raise exception '355: a broken action was not recorded as one failed run (found %)', v_runs;
    end if;
  end if;
  delete from public.crm_rules where id = v_rule;

  -- THE FORWARD-ONLY GUARD, asserted rather than trusted, because it is the line between this
  -- feature and texting a builder's whole customer base by accident. A rule written NOW with a
  -- ZERO day count is due for every card in the pipeline the instant it exists — the sweep must
  -- still touch none of them, because no card's anchor can be later than a rule created a moment
  -- ago. Drop `q.at >= r.created_at` and this check fires on any tenant with a dated card.
  insert into public.crm_rules (client_id, pipeline_id, name, trigger_kind, elapsed_anchor, elapsed_days)
  values (v_client, v_pipe, '355 sweep self-check', 'elapsed', 'stage_entered', 0) returning id into v_rule;
  insert into public.crm_rule_actions (client_id, rule_id, kind, params)
  values (v_client, v_rule, 'reopen', '{}'::jsonb);
  select public.crm_rules_sweep(500) into v_runs;
  select count(*) into v_n from public.crm_rule_runs where rule_id = v_rule;
  if v_n <> 0 then
    raise exception '355: a brand-new elapsed rule swept % existing card(s) — the forward-only guard is gone', v_n;
  end if;
  delete from public.crm_rules where id = v_rule;

  raise notice '355 OK: tables, trigger shape, once guard, the never-fail evaluator and the forward-only sweep all check out';
end $$;
