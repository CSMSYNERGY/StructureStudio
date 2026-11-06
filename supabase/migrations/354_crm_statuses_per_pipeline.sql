-- 354_crm_statuses_per_pipeline.sql — a status belongs to ONE pipeline, not to the whole account.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('354', '354_crm_statuses_per_pipeline') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. To rehearse and change nothing, swap the last `commit;`
--    for `rollback;`.
--    ⚠️ Deploy portal-settings RIGHT AFTER this. The deployed one reads and writes statuses by
--    client_id alone: it would list every pipeline's statuses on every board, and `crm_status_save`
--    would create one with no pipeline, which the CHECK below refuses. The new portal-settings
--    works on a database without this file too (it only starts sending a pipelineId), so deploying
--    it first is also safe.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- 354 = max(live ledger, this folder) + 1, both read at 353 on 2026-11-02. Re-read BOTH right
-- before applying — four agents write migrations here and 353 was renumbered three times on its
-- way in (see its header). scripts/preflight.mjs refuses a push where two files share a number.
--
-- ── WHY (Carolyn, 2026-11-01) ────────────────────────────────────────────────────────────
--   "Since we are doing SHED customers and Post Frame and now I also brought on a Smart Build User
--    and plan to integrate with Smart Build. I want to make specific statuses per pipeline and they
--    will work the way it is now (internally you decide when the status changes). So in settings
--    lets move the pipelines above the statuses. and then the statuses and pipelines and lost
--    reasons all within that pipeline."
--   One ladder cannot serve a shed pipeline, a post-frame pipeline and a SmartBuild pipeline whose
--   statuses will later be driven by webhooks. Lost reasons are ALREADY per pipeline
--   (crm_pipelines.lost_reasons); this puts the statuses beside them.
--
--   "I don't want any changes to my Builders pipeline." So the backfill is not a blanket copy:
--     * a pipeline the DESIGNER feeds (feeds_designs) gets the whole 8-rung ladder, because that
--       is the one every design/estimate/invoice/delivery event is about;
--     * every other pipeline keeps ONLY the statuses its own cards are actually on. On 2026-11-02
--       that is Builders, whose three cards are all New Lead — so Builders ends with exactly one
--       status and looks identical to the way she left it.
--
--   A status may now sit with NO trigger_event — a placeholder for a rung the SmartBuild webhooks
--   will drive later. Nobody can set it by hand in the meantime; it simply waits.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1  the table: crm_statuses.pipeline_id, its FK, the per-pipeline uniqueness of an event,
--           and a CHECK that a LIVE status always names a pipeline.
--   PART 2  the functions, each gaining the pipeline it was missing: crm_seed_statuses seeds into
--           one pipeline; crm_deals_default_status reads new.pipeline_id; crm_set_deal_status
--           refuses a status from another pipeline; crm_design_event and crm_contact_made resolve
--           the status in the DEAL'S OWN pipeline; crm_ensure_pipelines seeds per pipeline.
--   PART 3  the data: copy, repoint, archive (see WHY for who gets what).
--   PART 4  checks, and a rehearsal on a made-up account.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Nothing is dropped. The old tenant-wide rows are ARCHIVED, not deleted, because
-- crm_pipeline_stages_status_fk still points at them from archived stages (302's retired link,
-- kept by 303 for its reverse) — deleting them would fail that FK. crm_deals_status_fk stays on
-- (status_id, client_id) rather than tightening to (status_id, pipeline_id): a tighter FK would
-- have to be satisfied mid-statement by every path that touches both columns, and the pipeline
-- agreement is enforced in the functions instead, which is where it can give a sentence.
-- The pipeline tables are locked (ACCESS EXCLUSIVE) for the transaction under a 15 s lock_timeout.
--
-- ── REVERSE (only if this has to be undone) ──────────────────────────────────────────────
--   1. Put 353's functions back: copy 353_crm_outcomes_not_stages.sql from `-- ── PART 2 — the
--      functions` up to (not including) `-- ── PART 3`, and 302's crm_design_event (302:360-378).
--   2. Then:
-- REVERSE-SQL-BEGIN
-- alter table public.crm_statuses drop constraint if exists crm_statuses_live_has_pipeline;
-- update public.crm_deals d set status_id = o.id
--   from public.crm_statuses c join public.crm_statuses o
--     on o.client_id = c.client_id and o.pipeline_id is null and o.name = c.name
--    and o.trigger_event is not distinct from c.trigger_event
--  where d.status_id = c.id and c.pipeline_id is not null;
-- update public.crm_statuses set archived_at = null where pipeline_id is null and archived_at is not null;
-- delete from public.crm_statuses where pipeline_id is not null;
-- drop index if exists public.crm_statuses_event_once_per_pipeline;
-- create unique index crm_statuses_event_once on public.crm_statuses (client_id, trigger_event)
--   where trigger_event is not null and archived_at is null;
-- alter table public.crm_statuses drop column if exists pipeline_id;
-- delete from supabase_migrations.schema_migrations where version = '354';
-- REVERSE-SQL-END

begin;

set local lock_timeout = '15s';

do $pre$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'crm_pipeline_stages_open_only'
                    and conrelid = 'public.crm_pipeline_stages'::regclass) then
    raise exception '354: crm_pipeline_stages_open_only is missing (migration 353 not applied?)';
  end if;
end
$pre$;

lock table public.crm_pipelines, public.crm_pipeline_stages, public.crm_statuses in access exclusive mode;

-- ── PART 1 — the table ───────────────────────────────────────────────────────────────────
alter table public.crm_statuses add column if not exists pipeline_id uuid;

-- The same double-key shape crm_pipeline_stages uses (301:93-95): the pipeline must belong to the
-- status's own tenant, so a cross-tenant id cannot be written even by a bug in a function.
alter table public.crm_statuses drop constraint if exists crm_statuses_pipeline_fk;
alter table public.crm_statuses add constraint crm_statuses_pipeline_fk
  foreign key (pipeline_id, client_id) references public.crm_pipelines (id, client_id) on delete cascade;

-- ONE STATUS PER EVENT, PER PIPELINE (it was per tenant). Every pipeline now needs its own
-- "Estimate Sent", and two pipelines may each have one.
drop index if exists public.crm_statuses_event_once;
create unique index if not exists crm_statuses_event_once_per_pipeline
  on public.crm_statuses (client_id, pipeline_id, trigger_event)
  where trigger_event is not null and archived_at is null;

-- The board reads a pipeline's ladder in order; the old index was keyed on the tenant.
create index if not exists crm_statuses_pipeline_idx
  on public.crm_statuses (client_id, pipeline_id, position) where archived_at is null;

-- ── PART 2 — the functions ───────────────────────────────────────────────────────────────
-- 353's eight starter rungs, seeded into ONE pipeline. Once per pipeline, ever: a builder who
-- strips a pipeline's ladder is not handed it back.
create or replace function public.crm_seed_statuses(p_client_id text, p_pipeline uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_s jsonb; v_i int := 0;
begin
  if coalesce(btrim(p_client_id), '') = '' or p_pipeline is null then
    raise exception 'a tenant and a pipeline are required' using errcode = 'null_value_not_allowed';
  end if;
  perform pg_advisory_xact_lock(hashtext('crm_seed_statuses:' || p_client_id || ':' || p_pipeline::text));
  if exists (select 1 from public.crm_statuses where pipeline_id = p_pipeline) then return; end if;
  for v_s in select * from jsonb_array_elements('[
      {"n":"New Lead","c":"#64748B","e":"design_submitted"},
      {"n":"Contact Made","c":"#0EA5E9","e":"contact_made"},
      {"n":"Estimate Sent","c":"#6366F1","e":"estimate_sent"},
      {"n":"Accepted","c":"#16A34A","e":"estimate_accepted"},
      {"n":"Invoiced","c":"#14B8A6","e":"invoiced"},
      {"n":"Payment Received","c":"#84CC16","e":"paid_in_full"},
      {"n":"Scheduling","c":"#F59E0B","e":"build_scheduled"},
      {"n":"Delivered","c":"#0F766E","e":"delivered"}]'::jsonb) loop
    v_i := v_i + 1;
    insert into public.crm_statuses (client_id, pipeline_id, name, color, trigger_event, position)
    values (p_client_id, p_pipeline, v_s->>'n', v_s->>'c', v_s->>'e', v_i * 1024);
  end loop;
end;
$fn$;
revoke execute on function public.crm_seed_statuses(text, uuid) from public, anon, authenticated;
grant  execute on function public.crm_seed_statuses(text, uuid) to service_role;

-- The 1-argument form is KEPT so a caller that has not been re-deployed still works: it seeds
-- every live pipeline of the tenant that has no ladder yet.
create or replace function public.crm_seed_statuses(p_client_id text)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare r record;
begin
  for r in select id from public.crm_pipelines where client_id = p_client_id and archived_at is null loop
    perform public.crm_seed_statuses(p_client_id, r.id);
  end loop;
end;
$fn$;
revoke execute on function public.crm_seed_statuses(text) from public, anon, authenticated;
grant  execute on function public.crm_seed_statuses(text) to service_role;

-- A new card starts on the first status OF ITS OWN PIPELINE. new.pipeline_id is on the row, so
-- this one always knew the pipeline — it simply never asked.
create or replace function public.crm_deals_default_status()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  if new.status_id is null then
    perform public.crm_seed_statuses(new.client_id, new.pipeline_id);
    select id into new.status_id from public.crm_statuses
     where pipeline_id = new.pipeline_id and archived_at is null order by position limit 1;
  end if;
  return new;
end;
$fn$;

-- 353's crm_set_deal_status, plus the pipeline agreement. The forward-only comparison was always
-- between two `position` values; now both are read from the same pipeline's ladder, which is the
-- only way that comparison means anything.
create or replace function public.crm_set_deal_status(
  p_client_id    text,
  p_deal         uuid,
  p_status       uuid,
  p_actor        uuid default null,
  p_forward_only boolean default false
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_deal   public.crm_deals%rowtype;
  v_new    public.crm_statuses%rowtype;
  v_cur    double precision;
  v_won    timestamptz;
  v_reopen boolean;
begin
  select * into v_deal from public.crm_deals where id = p_deal and client_id = p_client_id for update;
  if not found then raise exception 'deal not found' using errcode = 'no_data_found'; end if;
  select * into v_new from public.crm_statuses where id = p_status and client_id = p_client_id and archived_at is null;
  if not found then raise exception 'status not found' using errcode = 'no_data_found'; end if;
  -- A STATUS BELONGS TO ONE PIPELINE (354). Refused rather than written: a card wearing another
  -- pipeline's rung would read as progress it never made.
  if v_new.pipeline_id is distinct from v_deal.pipeline_id then
    raise exception 'that status belongs to another pipeline' using errcode = 'check_violation';
  end if;

  -- A lost lead that comes back (353): any PAPERWORK event on a lost card puts it back in play,
  -- computed before the early returns because a requote often lands on the status it is already on.
  v_reopen := v_deal.lost_at is not null
              and v_new.trigger_event is not null
              and v_new.trigger_event <> 'contact_made';

  if v_deal.status_id = v_new.id then
    if v_reopen then
      update public.crm_deals set lost_at = null, lost_reason = null, updated_at = now() where id = v_deal.id;
    end if;
    return jsonb_build_object('changed', false, 'reopened', v_reopen);
  end if;
  if p_forward_only then
    select position into v_cur from public.crm_statuses where id = v_deal.status_id and archived_at is null;
    if v_cur is not null and v_new.position <= v_cur then
      if v_reopen then
        update public.crm_deals set lost_at = null, lost_reason = null, updated_at = now() where id = v_deal.id;
      end if;
      return jsonb_build_object('changed', false, 'reopened', v_reopen);
    end if;
  end if;

  v_won := case when v_new.trigger_event = 'invoiced' then coalesce(v_deal.won_at, now()) else v_deal.won_at end;
  update public.crm_deals set
    status_id   = v_new.id,
    won_at      = v_won,
    lost_at     = case when v_reopen then null else lost_at end,
    lost_reason = case when v_reopen then null else lost_reason end,
    updated_at  = now()
  where id = v_deal.id;
  return jsonb_build_object('changed', true, 'moved', false, 'stage_id', v_deal.stage_id,
                            'won_at', v_won, 'reopened', v_reopen);
end;
$fn$;
revoke execute on function public.crm_set_deal_status(text, uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant  execute on function public.crm_set_deal_status(text, uuid, uuid, uuid, boolean) to service_role;

-- A design/payment/build event names a DESIGN, never a pipeline. It now loads the card first and
-- reads the matching rung out of THAT CARD'S pipeline — before 354 it read the tenant's one copy,
-- which is the read that would have cross-wired the moment two pipelines each had an "Invoiced".
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
  if v_status is null then return; end if;        -- this pipeline has no rung for that event
  perform public.crm_set_deal_status(p_client_id, v_deal.id, v_status, null, true);
end;
$fn$;
revoke execute on function public.crm_design_event(text, text, text) from public, anon, authenticated;
grant  execute on function public.crm_design_event(text, text, text) to service_role;

-- Somebody actually talked to this lead (353), now per pipeline: each of the contact's cards is
-- judged against ITS OWN first rung and advanced to ITS OWN Contact Made.
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
    if v_made is null then continue; end if;       -- that pipeline has no Contact Made rung
    select id into v_first from public.crm_statuses
     where pipeline_id = r.pipeline_id and archived_at is null order by position limit 1;
    if v_first is null or v_first = v_made or r.status_id is distinct from v_first then continue; end if;
    perform public.crm_set_deal_status(p_client_id, r.id, v_made, null, true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$fn$;
revoke execute on function public.crm_contact_made(text, uuid) from public, anon, authenticated;
grant  execute on function public.crm_contact_made(text, uuid) to service_role;

-- Statuses now hang off a pipeline, so the pipeline is seeded FIRST and its ladder after it.
create or replace function public.crm_ensure_pipelines(p_client_id text)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_pipe uuid; r record;
begin
  v_pipe := public.crm_seed_pipeline(p_client_id, 'shed_deals');
  if not exists (select 1 from public.crm_pipelines
                  where client_id = p_client_id and feeds_designs and archived_at is null) then
    update public.crm_pipelines set feeds_designs = true, updated_at = now()
     where client_id = p_client_id and seed_kind = 'shed_deals' and archived_at is null;
  end if;
  for r in select id from public.crm_pipelines where client_id = p_client_id and archived_at is null loop
    perform public.crm_seed_statuses(p_client_id, r.id);
  end loop;
end;
$fn$;
revoke execute on function public.crm_ensure_pipelines(text) from public, anon, authenticated;
grant  execute on function public.crm_ensure_pipelines(text) to service_role;

-- ── PART 3 — the data ────────────────────────────────────────────────────────────────────
-- Who gets which rungs. A design-fed pipeline takes the whole ladder; every other pipeline takes
-- ONLY the rungs its own cards stand on — Carolyn: "I don't want any changes to my Builders
-- pipeline." Archived cards count, or restoring one would land it on a status its pipeline lacks.
create temporary table m354_copy on commit drop as
select p.id as pipeline_id, p.client_id, s.id as old_status,
       s.name, s.color, s.position, s.trigger_event,
       gen_random_uuid() as new_status
  from public.crm_pipelines p
  join public.crm_statuses s
    on s.client_id = p.client_id and s.pipeline_id is null and s.archived_at is null
 where p.archived_at is null
   and (p.feeds_designs
        or exists (select 1 from public.crm_deals d where d.pipeline_id = p.id and d.status_id = s.id));

insert into public.crm_statuses (id, client_id, pipeline_id, name, color, position, trigger_event)
select new_status, client_id, pipeline_id, name, color, position, trigger_event from m354_copy;

update public.crm_deals d set status_id = c.new_status, updated_at = now()
  from m354_copy c
 where d.pipeline_id = c.pipeline_id and d.status_id = c.old_status;

-- A live pipeline that ended up with no ladder at all (no cards, and not the design feed) gets the
-- tenant's first rung, so a card added there tomorrow has somewhere to start.
insert into public.crm_statuses (client_id, pipeline_id, name, color, position, trigger_event)
select p.client_id, p.id, s.name, s.color, s.position, s.trigger_event
  from public.crm_pipelines p
  join lateral (select s0.* from public.crm_statuses s0
                 where s0.client_id = p.client_id and s0.pipeline_id is null and s0.archived_at is null
                 order by s0.position limit 1) s on true
 where p.archived_at is null
   and not exists (select 1 from public.crm_statuses x where x.pipeline_id = p.id);

-- Any live card still without a status takes its pipeline's first rung.
update public.crm_deals d set status_id = (
         select s.id from public.crm_statuses s
          where s.pipeline_id = d.pipeline_id and s.archived_at is null order by s.position limit 1),
       updated_at = now()
 where d.status_id is null and d.archived_at is null;

-- The tenant-wide rows retire. ARCHIVED, not deleted: crm_pipeline_stages_status_fk still points
-- at them from archived stages (302's retired link, kept by 303 for its reverse).
update public.crm_statuses set archived_at = now(), updated_at = now()
 where pipeline_id is null and archived_at is null;

-- A LIVE status names its pipeline. The archived tenant-wide rows keep a null, which is how the
-- reverse finds them — the same shape 303 used for the retired stage link.
alter table public.crm_statuses drop constraint if exists crm_statuses_live_has_pipeline;
alter table public.crm_statuses add constraint crm_statuses_live_has_pipeline
  check (pipeline_id is not null or archived_at is not null);
comment on column public.crm_statuses.pipeline_id is
  'The pipeline this status belongs to (354). NULL only on the tenant-wide rows this migration archived.';

-- ── PART 4 — checks ──────────────────────────────────────────────────────────────────────
do $chk$
declare
  v_n int;
  v_t text := 'm354-rehearsal-' || substr(md5(random()::text), 1, 8);
  v_p1 uuid; v_p2 uuid; v_s1 uuid; v_s2 uuid; v_d1 uuid; v_d2 uuid; v_c uuid;
  v_r jsonb; v_made uuid; v_first uuid; v_sent uuid;
begin
  select count(*) into v_n from public.crm_statuses where archived_at is null and pipeline_id is null;
  if v_n > 0 then raise exception '354: % live statuses still belong to no pipeline', v_n; end if;
  select count(*) into v_n from public.crm_deals d
    join public.crm_statuses s on s.id = d.status_id
   where s.pipeline_id is distinct from d.pipeline_id;
  if v_n > 0 then raise exception '354: % cards wear a status from another pipeline', v_n; end if;
  select count(*) into v_n from public.crm_deals where status_id is null and archived_at is null;
  if v_n > 0 then raise exception '354: % live cards have no status', v_n; end if;
  select count(*) into v_n from public.crm_pipelines p
   where p.archived_at is null
     and not exists (select 1 from public.crm_statuses s where s.pipeline_id = p.id and s.archived_at is null);
  if v_n > 0 then raise exception '354: % live pipelines have no status for a new card to start on', v_n; end if;
  -- Carolyn's own ask, asserted rather than hoped for: a hand-made pipeline keeps only what it used.
  select count(*) into v_n from public.crm_statuses s
    join public.crm_pipelines p on p.id = s.pipeline_id
   where s.archived_at is null and not p.feeds_designs
     and not exists (select 1 from public.crm_deals d where d.pipeline_id = p.id and d.status_id = s.id)
     and (select count(*) from public.crm_statuses x where x.pipeline_id = p.id and x.archived_at is null) > 1;
  if v_n > 0 then raise exception '354: a hand-made pipeline was given % rungs its cards never used', v_n; end if;
  if has_table_privilege('authenticated', 'public.crm_statuses', 'select') then
    raise exception '354: browser roles can read the statuses';
  end if;

  -- ── Rehearsal on a made-up account ───────────────────────────────────────────────────
  perform public.crm_ensure_pipelines(v_t);
  select id into v_p1 from public.crm_pipelines where client_id = v_t and seed_kind = 'shed_deals';
  v_p2 := public.crm_seed_pipeline(v_t, 'outreach');
  perform public.crm_seed_statuses(v_t, v_p2);

  select count(*) into v_n from public.crm_statuses where pipeline_id = v_p1 and archived_at is null;
  if v_n <> 8 then raise exception '354: the seeded pipeline got % rungs, not 8', v_n; end if;
  select count(*) into v_n from public.crm_statuses where pipeline_id = v_p2 and archived_at is null;
  if v_n <> 8 then raise exception '354: the second pipeline got % rungs, not 8', v_n; end if;
  -- Two pipelines may each own the same event now; that is the whole change.
  select count(*) into v_n from public.crm_statuses
   where client_id = v_t and trigger_event = 'invoiced' and archived_at is null;
  if v_n <> 2 then raise exception '354: two pipelines could not each have an Invoiced rung (% found)', v_n; end if;

  select id into v_s1 from public.crm_pipeline_stages where pipeline_id = v_p1 order by position limit 1;
  select id into v_s2 from public.crm_pipeline_stages where pipeline_id = v_p2 order by position limit 1;
  v_r := public.crm_create_lead(v_t, 'Pat Rehearsal', 'Rehearsal Barns', '(555) 010-3054', 'pat354@example.invalid', null, null, 'manual', v_s1);
  v_d1 := (v_r->>'dealId')::uuid;
  select contact_id into v_c from public.crm_deals where id = v_d1;
  v_r := public.crm_create_lead(v_t, 'Dale Rehearsal', null, '(555) 010-3055', 'dale354@example.invalid', null, null, 'manual', v_s2);
  v_d2 := (v_r->>'dealId')::uuid;

  -- Each card started on ITS OWN pipeline's first rung.
  select id into v_first from public.crm_statuses where pipeline_id = v_p1 and archived_at is null order by position limit 1;
  if (select status_id from public.crm_deals where id = v_d1) <> v_first then
    raise exception '354: a new card did not start on its own pipeline''s first status';
  end if;
  if (select status_id from public.crm_deals where id = v_d2)
     = (select status_id from public.crm_deals where id = v_d1) then
    raise exception '354: two pipelines'' cards share a status row';
  end if;

  -- A status from the WRONG pipeline is refused.
  select id into v_sent from public.crm_statuses where pipeline_id = v_p2 and trigger_event = 'estimate_sent';
  begin
    perform public.crm_set_deal_status(v_t, v_d1, v_sent, null, false);
    raise exception '354: a card took a status from another pipeline';
  exception when check_violation then null;
  end;

  -- Contact Made advances each card against its OWN ladder.
  select id into v_made from public.crm_statuses where pipeline_id = v_p1 and trigger_event = 'contact_made';
  perform public.crm_contact_made(v_t, v_c);
  if (select status_id from public.crm_deals where id = v_d1) <> v_made then
    raise exception '354: contact_made did not advance the card on its own pipeline';
  end if;

  -- A placeholder rung (no event) is allowed, and nothing can reach it.
  insert into public.crm_statuses (client_id, pipeline_id, name, color, position, trigger_event)
  values (v_t, v_p2, 'Waiting on SmartBuild', '#94A3B8', 9999, null);
  if (select count(*) from public.crm_statuses where pipeline_id = v_p2 and trigger_event is null and archived_at is null) <> 1 then
    raise exception '354: a placeholder status with no trigger was refused';
  end if;

  -- Clean the rehearsal away (the pipeline's cascade takes its stages, statuses, deals and history).
  delete from public.crm_pipelines where client_id = v_t;
  delete from public.crm_statuses where client_id = v_t;
  delete from public.crm_contacts where client_id = v_t;
  if exists (select 1 from public.crm_deals where client_id = v_t) then raise exception '354: rehearsal left cards'; end if;
end;
$chk$;

-- What the apply shows.
select '354' as migration,
       (select count(*) from public.crm_statuses where pipeline_id is not null and archived_at is null) as live_statuses,
       (select count(*) from public.crm_statuses where pipeline_id is null and archived_at is not null) as retired_tenant_wide,
       (select count(*) from public.crm_pipelines where archived_at is null) as live_pipelines,
       (select count(*) from public.crm_statuses s join public.crm_pipelines p on p.id = s.pipeline_id
         where s.archived_at is null and p.feeds_designs) as rungs_on_design_pipelines,
       (select count(*) from public.crm_statuses s join public.crm_pipelines p on p.id = s.pipeline_id
         where s.archived_at is null and not p.feeds_designs) as rungs_on_hand_made,
       (select count(*) from public.crm_deals d join public.crm_statuses s on s.id = d.status_id
         where s.pipeline_id is distinct from d.pipeline_id) as mismatched_cards;

commit;
