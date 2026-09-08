-- 219_build_board_change_flag.sql — the crew finds out that the plans moved.
--
-- Carolyn, 2026-09-06, asked for exactly one thing here and explicitly ruled out the other:
-- a changed job is FLAGGED ON THE BUILD BOARD and appears in the job history. **No staff
-- email.** So this is a board state, not a notification system, and there is nothing to
-- unsubscribe from or to fail to deliver.
--
-- ⚠️ WRITTEN BY A TRIGGER, NOT BY APPLICATION CODE, and that is the whole design. FOUR
-- writers can acknowledge a change today — the customer's signature (customer-accept
-- ack_change_order), the rep's attestation (portal-settings attest_change_order), the order
-- screen's verbal path, and any future edge action — and a fifth will be added by somebody
-- who has never read this file. `build_jobs` also carries a SELECT policy and nothing else,
-- so a browser physically cannot stamp the flag even if a UI path wanted to. One AFTER
-- trigger catches every writer, present and future, in the same statement as the
-- acknowledgment itself. change_orders_stamp_agreed (153) is already a trigger on this table
-- doing exactly this shape of thing, so the shape is the established one.
--
-- WHAT COUNTS AS "THE JOB": the build job for this design that is NOT YET COMPLETE. A
-- finished building cannot be re-read, and flagging a completed job would put a red banner on
-- the board over work nobody can act on. A delivered order that gets amended still records
-- the change everywhere else (the change order, the paperwork, the amendment trail); it just
-- does not shout at a crew who finished months ago.
--
-- CLEARING IS A NULL, NOT A SECOND TIMESTAMP COMPARED AGAINST THE FIRST. The obvious
-- alternative — keep `changed_at` and add `changed_cleared_at`, then test cleared < changed —
-- has a real failure mode: two changes acknowledged either side of one clear leave the two
-- timestamps in an order that reads as "already seen" for a change nobody saw. Clearing wipes
-- the flag; a later change stamps it again; the HISTORY (schedule_activity) is what keeps
-- both events, and it is append-only.
--
-- Rollback:
--   drop trigger if exists change_orders_flag_build_job_trg on public.change_orders;
--   drop function if exists public.change_orders_flag_build_job();
--   alter table public.build_jobs drop column if exists changed_at,
--     drop column if exists changed_co_no, drop column if exists changed_summary;
--   -- and restore the schedule_activity action CHECK to its pre-219 list (PART 2 below).

-- ── PART 1 — the flag ──────────────────────────────────────────────────────────────────
alter table public.build_jobs
  add column if not exists changed_at      timestamptz,
  add column if not exists changed_co_no   integer,
  add column if not exists changed_summary text;

comment on column public.build_jobs.changed_at is
  'Migration 219. Set by change_orders_flag_build_job() when a change order on this design is ACKNOWLEDGED and the job is not complete. NULL = nothing to re-read. Cleared (back to NULL) by portal-schedule''s clear_job_change when a crew member marks the plans read; a later change stamps it again. The history in schedule_activity keeps both events.';

create index if not exists build_jobs_changed_idx
  on public.build_jobs (client_id) where changed_at is not null;

-- ── PART 2 — two verbs the history needs ───────────────────────────────────────────────
-- 'changed'     — the customer approved a change to this building.
-- 'change_read' — a crew member says they have re-read the plans.
-- ⚠️ SCHED_ACT_VERB in portal/05-schedule.jsx must gain both IN THE SAME COMMIT. It falls
-- back to the raw slug, so a miss is ugly rather than broken — but "change_read" is not a
-- sentence anybody wants on a job card.
alter table public.schedule_activity
  drop constraint if exists schedule_activity_action_check;
alter table public.schedule_activity
  add constraint schedule_activity_action_check
  check (action = any (array[
    'created', 'moved', 'dated', 'assigned', 'noted', 'completed', 'deleted',
    'loaded', 'unloaded', 'out', 'delivered', 'override', 'updated',
    'changed', 'change_read'
  ]));

-- ── PART 3 — the trigger ───────────────────────────────────────────────────────────────
create or replace function public.change_orders_flag_build_job()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_job public.build_jobs;
  v_detail text;
begin
  -- Only the transition INTO acknowledged, and only once. The guard trigger freezes an
  -- acknowledged row, but a void or a later touch must not re-flag a board the crew has
  -- already cleared — the same "already acknowledged before this statement" test 153 makes,
  -- nested rather than ANDed because OLD does not exist on INSERT.
  if new.status <> 'acknowledged' then return null; end if;
  if tg_op = 'UPDATE' then
    if old.status = 'acknowledged' then return null; end if;
  end if;
  if new.short_code is null then return null; end if;

  select * into v_job
    from public.build_jobs b
   where b.client_id = new.client_id
     and b.design_short_code = new.short_code
     and b.completed_at is null
   order by b.created_at desc
   limit 1;

  -- No job on the board (not scheduled yet, or already built) — nothing to shout at.
  if v_job.id is null then return null; end if;

  -- The FIRST LINE of the generated description. The full diff is on the change order and in
  -- the order screen; a job card has room for a sentence, and the crew's next move is to open
  -- the plans rather than to read a spec off a chip.
  v_detail := nullif(btrim(split_part(coalesce(new.description, ''), E'\n', 1)), '');

  update public.build_jobs
     set changed_at = now(),
         changed_co_no = new.co_no,
         changed_summary = left(coalesce(v_detail, 'The customer approved a change to this building.'), 300),
         updated_at = now()
   where id = v_job.id;

  -- The history. `user_id` is deliberately NULL: the four acknowledging writers all run as
  -- the service role (the customer has no auth user at all), so naming one would be a guess.
  -- The detail says who approved it in words instead.
  insert into public.schedule_activity (client_id, subject, subject_id, user_id, action, detail)
  values (
    new.client_id, 'build_job', v_job.id, null, 'changed',
    left('CO-' || new.co_no || ' approved' ||
         case when v_detail is null then '' else ' — ' || v_detail end, 400)
  );
  return null;  -- AFTER trigger; the return value is ignored
end;
$fn$;

revoke execute on function public.change_orders_flag_build_job() from public, anon, authenticated;

drop trigger if exists change_orders_flag_build_job_trg on public.change_orders;
create trigger change_orders_flag_build_job_trg
  after insert or update on public.change_orders
  for each row execute function public.change_orders_flag_build_job();

-- ── PART 4 — apply-time assertions AND a rolled-back behavioural probe ─────────────────
-- 214's lesson: probe the branch that matters, not the default configuration. The branch
-- that matters here is "a change is acknowledged on a design that has an unfinished job".
do $$
declare
  n int; def text;
  cid text; code text; job_id uuid; co_id uuid; stage_id uuid; got record; acts int;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='build_jobs' and column_name='changed_at') then
    raise exception '219: build_jobs.changed_at is missing';
  end if;

  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid='public.schedule_activity'::regclass and conname='schedule_activity_action_check';
  if def is null then raise exception '219: the action CHECK vanished'; end if;
  if def not like '%changed%' then raise exception '219: the action CHECK does not admit ''changed'''; end if;
  if def not like '%change_read%' then raise exception '219: the action CHECK does not admit ''change_read'''; end if;
  -- And it did not lose anything on the way. One spot-check per family is enough to catch a
  -- hand-retyped list, which is the way this constraint would actually break.
  if def not like '%delivered%' or def not like '%override%' or def not like '%completed%' then
    raise exception '219: the action CHECK lost a pre-existing verb';
  end if;

  -- Nothing pre-existing is flagged: this ships inert.
  select count(*) into n from public.build_jobs where changed_at is not null;
  if n <> 0 then raise exception '219: % jobs are already flagged before anything happened', n; end if;

  -- ── THE PROBE. Rolled back; leaves nothing. ─────────────────────────────────────────
  select b.client_id, b.design_short_code, b.id, b.stage_id
    into cid, code, job_id, stage_id
    from public.build_jobs b
    join public.designs d on d.client_id = b.client_id and d.short_code = b.design_short_code
   where b.completed_at is null
     and b.design_short_code is not null
     and d.accepted_at is not null
     and not exists (select 1 from public.change_orders c
                      where c.client_id = b.client_id and c.short_code = b.design_short_code
                        and c.status in ('draft','pending_ack'))
   limit 1;
  if job_id is null then
    raise notice '219: no unfinished build job on a signed design — probe skipped';
    return;
  end if;

  begin
    -- A change order, acknowledged the way the verbal path does it.
    insert into public.change_orders (client_id, short_code, source, status, description,
                                      ack_method, verbal_rep_name, verbal_conversation_date, acknowledged_at)
    values (cid, code, 'manual', 'acknowledged', E'Moved the double door to the gable end\nTotal: $1.00 -> $1.00',
            'verbal', '219 probe', current_date, now())
    returning * into got;
    co_id := got.id;

    select * into got from public.build_jobs where id = job_id;
    if got.changed_at is null then
      raise exception '219 probe: the job was not flagged';
    end if;
    if got.changed_summary <> 'Moved the double door to the gable end' then
      raise exception '219 probe: the summary is the wrong line (%)', got.changed_summary;
    end if;

    select count(*) into acts from public.schedule_activity
     where subject = 'build_job' and subject_id = job_id and action = 'changed';
    if acts < 1 then raise exception '219 probe: nothing reached the job history'; end if;

    -- A COMPLETED job is not flagged — a finished building cannot be re-read.
    update public.build_jobs set changed_at = null, completed_at = now() where id = job_id;
    insert into public.change_orders (client_id, short_code, source, status, description,
                                      ack_method, verbal_rep_name, verbal_conversation_date, acknowledged_at)
    values (cid, code, 'manual', 'acknowledged', 'A second change', 'verbal', '219 probe', current_date, now());
    select * into got from public.build_jobs where id = job_id;
    if got.changed_at is not null then
      raise exception '219 probe: a COMPLETED job was flagged';
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '219: an acknowledged change flags the open job and lands in its history; a completed job is left alone';
      else
        raise;
      end if;
  end;
end $$;
