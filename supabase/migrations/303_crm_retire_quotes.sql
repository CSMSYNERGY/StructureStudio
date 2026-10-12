-- 303_crm_retire_quotes.sql — the Quotes pipeline is retired in every account, Shed Deals is where
-- new designs land, and a card's STATUS is set only by the system.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('303', '303_crm_retire_quotes') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. To rehearse and change nothing, swap the last `commit;`
--    for `rollback;`.
--    ⚠️ Deploy portal-settings RIGHT AFTER this. Until it is live, the deployed portal-settings
--    still lets a person set a card's status by hand (its crm_deal_set_status), and its stage
--    editor's "status link" save fails on this file's CHECK with a generic "couldn't save" line.
--    The new portal-settings works on a database without this file too (it only stops calling
--    the paths this file retires), so deploying it first is also safe.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- 303 is a placeholder: take the next free number from the live ledger, renaming this file and
-- its test (tests/sql/migration303.test.cjs). It must come after 302, and refuses without it.
--
-- ── WHY (Carolyn, 2026-10-12 call) ───────────────────────────────────────────────────────
--   * "I want quotes gone. ... I just want that pipeline gone." 302 seeded a Quotes pipeline in
--     every account (stages = the statuses, the pipeline new designs landed in). It holds no cards
--     anywhere; every design's card is in Shed Deals ("I said I want to call it shed deals, I'm
--     using their language ... So that stays like this"). New designs now land in Shed Deals, in
--     its first open stage (New Incoming), and no account is ever seeded a Quotes again.
--   * "those statuses are automatically set, like, it is not even possible for them to make the
--     changes, it is system-driven, okay, the statuses are system-driven, 100%." Under 302 a card
--     dragged into a stage LINKED to a status took that status, a status moved a card to its linked
--     stage, and a person could pick any status from the pill. From here a status changes only
--     through the system events (crm_design_event, fed by the designs, payments and build_jobs
--     triggers, forward only), and a stage is a stage: moving a card never touches its status, and
--     a status never moves a card. portal-settings refuses the hand-set (crm_deal_set_status).
--   * Stages stay the builder's to edit ("they can make them whatever they want"), and the status
--     list stays hers (New Lead, Appt Set, Estimate Sent, Accepted, Invoiced, Payment Received,
--     Scheduling, Delivered): renamable, recolourable, each with its "Set automatically when".
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1  the functions: crm_seed_pipeline seeds Shed Deals as the design-fed pipeline, first on
--           the board, and maps 301's 'sales' and 302's 'quotes' to it (an old caller can never make
--           a Quotes again); crm_ensure_pipelines = statuses + Shed Deals, and makes Shed Deals the
--           feed when an account has none; crm_deals_default_status no longer reads a stage's link;
--           crm_move_deal never changes a status; crm_set_deal_status never moves a card.
--   PART 2  the data, in every account: Quotes stops feeding and mirroring; Shed Deals becomes the
--           feed and takes Quotes' place at the front of the tab row; any card still in Quotes moves
--           to Shed Deals' first open stage (with its history row, changed_by NULL = the system); the
--           Quotes pipeline and its stages are ARCHIVED (kept: reversible, and the seed_once index
--           keeps anything from seeding a second one); every live stage loses its status link, and a
--           CHECK keeps it that way.
--   PART 3  checks, and a rehearsal on a made-up account (no design, no real row touched).
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- No column or table is dropped: the deployed portal-settings still selects mirrors_statuses and
-- stage status_id, and the live beta portal still reads them. Both read as false/null from here.
-- The pipeline tables are locked (ACCESS EXCLUSIVE) for the length of the transaction, under a
-- 15 s lock_timeout, so a design saved while this runs either finished before it (its Quotes card
-- is moved below) or waits and lands in Shed Deals. A deadlock or a lock timeout rolls the whole
-- file back; run it again.
--
-- ── REVERSE (only if this has to be undone) ──────────────────────────────────────────────
-- Cards moved out of Quotes stay in Shed Deals (there were none on 2026-10-13). In one transaction:
--   1. Run 302's PART 3 to PART 5 again: copy 302_crm_pipeline_designs.sql from the line
--      `-- ── PART 3 — starters` up to (not including) `-- ── PART 6`. That puts back 302's
--      crm_seed_statuses, crm_seed_pipeline, crm_ensure_pipelines, crm_deals_default_status (and its
--      trigger), crm_move_deal, crm_set_deal_status, crm_design_event and
--      crm_event_for_design_status.
--   2. Then:
-- REVERSE-SQL-BEGIN
-- alter table public.crm_pipeline_stages drop constraint if exists crm_pipeline_stages_no_status_link;
-- update public.crm_pipelines set feeds_designs = false, updated_at = now()
--  where seed_kind = 'shed_deals' and feeds_designs;
-- update public.crm_pipeline_stages s set archived_at = null, updated_at = now()
--   from public.crm_pipelines q
--  where s.pipeline_id = q.id and q.seed_kind = 'quotes' and q.archived_at is not null
--    and s.archived_at = q.archived_at;
-- update public.crm_pipelines set archived_at = null, feeds_designs = true, mirrors_statuses = true, updated_at = now()
--  where seed_kind = 'quotes' and archived_at is not null;
-- update public.crm_pipelines s set position = (select max(o.position) from public.crm_pipelines o
--                                                where o.client_id = s.client_id and o.archived_at is null) + 1024
--  where s.seed_kind = 'shed_deals' and s.archived_at is null;
-- delete from supabase_migrations.schema_migrations where version = '303';
-- REVERSE-SQL-END
--   (Quotes' stages keep their status links while archived, so un-archiving them restores 302's
--   mirror exactly; the CHECK below allows a link only on an archived stage for that reason.)

begin;

set local lock_timeout = '15s';

do $pre$
begin
  if to_regclass('public.crm_statuses') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'crm_pipelines' and column_name = 'feeds_designs') then
    raise exception '303: crm_statuses / crm_pipelines.feeds_designs are missing (migration 302 not applied?)';
  end if;
end
$pre$;

-- ── PART 1 — the functions ───────────────────────────────────────────────────────────────
-- 302's starters, without Quotes. Shed Deals is the design-fed pipeline and goes first on the board.
create or replace function public.crm_seed_pipeline(p_client_id text, p_kind text default 'shed_deals')
returns uuid
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  -- 301's 'sales' and 302's 'quotes' are retired (migration 303): an old caller gets Shed Deals.
  v_kind   text := case when p_kind in ('sales', 'quotes') then 'shed_deals' else p_kind end;
  v_id     uuid;
  v_name   text;
  v_stages jsonb;
  v_lost   text[];
  v_s      jsonb;
  v_i      integer := 0;
  v_pos    double precision;
begin
  if coalesce(btrim(p_client_id), '') = '' then
    raise exception 'a tenant is required' using errcode = 'null_value_not_allowed';
  end if;
  if v_kind = 'shed_deals' then
    v_name := 'Shed Deals';
    v_stages := '[{"n":"New Incoming","c":"#64748B"},{"n":"Attempting Contact","c":"#0EA5E9"},
                  {"n":"Nurturing - Cool","c":"#60A5FA"},{"n":"Nurturing - Warm","c":"#F59E0B"},
                  {"n":"Nurturing - Hot","c":"#EF4444"},{"n":"Gone Cold Again","c":"#94A3B8"}]';
    v_lost := array['Price', 'Went with a competitor', 'Timing', 'No response', 'Not a fit'];
    -- First on the board: it is where new designs land.
    v_pos := coalesce((select min(position) from public.crm_pipelines
                        where client_id = p_client_id and archived_at is null), 2048) - 1024;
  elsif v_kind = 'outreach' then
    v_name := 'Manufacturer Outreach';
    v_stages := '[{"n":"New Lead","c":"#64748B","k":"open"},{"n":"Attempting Contact","c":"#0EA5E9","k":"open"},
                  {"n":"Connected","c":"#14B8A6","k":"open"},{"n":"Demo Scheduled","c":"#6366F1","k":"open"},
                  {"n":"Demo Completed","c":"#8B5CF6","k":"open"},{"n":"Proposal Sent","c":"#F59E0B","k":"open"},
                  {"n":"Not Now / Nurture","c":"#94A3B8","k":"open"},
                  {"n":"Won","c":"#16A34A","k":"won"},{"n":"Lost","c":"#DC2626","k":"lost"}]';
    v_lost := array['Not interested', 'Happy with current software', 'Price', 'Too small', 'Wrong contact / bad number', 'Went with a competitor'];
  else
    raise exception 'unknown starter pipeline %', p_kind using errcode = 'invalid_parameter_value';
  end if;
  if v_pos is null then
    v_pos := coalesce((select max(position) from public.crm_pipelines where client_id = p_client_id), 0) + 1024;
  end if;

  insert into public.crm_pipelines (client_id, name, lost_reasons, seed_kind, position, feeds_designs, mirrors_statuses)
  values (p_client_id, v_name, v_lost, v_kind, v_pos,
          v_kind = 'shed_deals' and not exists (select 1 from public.crm_pipelines o
                                                where o.client_id = p_client_id and o.feeds_designs and o.archived_at is null),
          false)
  on conflict (client_id, seed_kind) where seed_kind is not null do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.crm_pipelines where client_id = p_client_id and seed_kind = v_kind;
    return v_id;
  end if;

  for v_s in select * from jsonb_array_elements(v_stages) loop
    v_i := v_i + 1;
    insert into public.crm_pipeline_stages (client_id, pipeline_id, name, color, kind, position)
    values (p_client_id, v_id, v_s->>'n', v_s->>'c', coalesce(v_s->>'k', 'open'), v_i * 1024);
  end loop;
  return v_id;
end;
$fn$;
revoke execute on function public.crm_seed_pipeline(text, text) from public, anon, authenticated;
grant  execute on function public.crm_seed_pipeline(text, text) to service_role;

-- Statuses and Shed Deals for a tenant, Shed Deals feeding designs. Idempotent; portal-settings
-- calls it the first time a new account opens the board, crm_sync_design_card the first time a new
-- account's design is saved, and PART 2 below for every existing account.
create or replace function public.crm_ensure_pipelines(p_client_id text)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  perform public.crm_seed_statuses(p_client_id);
  perform public.crm_seed_pipeline(p_client_id, 'shed_deals');
  -- An account left with no design feed (its Quotes retired by migration 303) gets Shed Deals.
  if not exists (select 1 from public.crm_pipelines
                  where client_id = p_client_id and feeds_designs and archived_at is null) then
    update public.crm_pipelines set feeds_designs = true, updated_at = now()
     where client_id = p_client_id and seed_kind = 'shed_deals' and archived_at is null;
  end if;
end;
$fn$;
revoke execute on function public.crm_ensure_pipelines(text) from public, anon, authenticated;
grant  execute on function public.crm_ensure_pipelines(text) to service_role;

-- A new card starts on the tenant's first status. A stage no longer carries one.
create or replace function public.crm_deals_default_status()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  if new.status_id is null then
    perform public.crm_seed_statuses(new.client_id);
    select id into new.status_id from public.crm_statuses
     where client_id = new.client_id and archived_at is null order by position limit 1;
  end if;
  return new;
end;
$fn$;

-- 301's crm_move_deal again: a stage change and its history row. The status is untouched.
create or replace function public.crm_move_deal(
  p_client_id   text,
  p_deal        uuid,
  p_stage       uuid,
  p_actor       uuid default null,
  p_lost_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_deal  public.crm_deals%rowtype;
  v_stage public.crm_pipeline_stages%rowtype;
  v_now   timestamptz := now();
  v_reason text := nullif(btrim(coalesce(p_lost_reason, '')), '');
begin
  select * into v_deal from public.crm_deals
   where id = p_deal and client_id = p_client_id and archived_at is null
   for update;
  if not found then
    raise exception 'deal not found' using errcode = 'no_data_found';
  end if;
  select * into v_stage from public.crm_pipeline_stages
   where id = p_stage and client_id = p_client_id and archived_at is null;
  if not found then
    raise exception 'stage not found' using errcode = 'no_data_found';
  end if;
  if v_deal.stage_id = v_stage.id then
    return jsonb_build_object('moved', false, 'stage_entered_at', v_deal.stage_entered_at);
  end if;
  if v_stage.kind = 'lost' and v_reason is null then
    raise exception 'a lost reason is required' using errcode = 'check_violation';
  end if;

  update public.crm_deals set
    pipeline_id      = v_stage.pipeline_id,
    stage_id         = v_stage.id,
    stage_entered_at = v_now,
    won_at           = case when v_stage.kind = 'won'  then coalesce(won_at, v_now)  else null end,
    lost_at          = case when v_stage.kind = 'lost' then coalesce(lost_at, v_now) else null end,
    lost_reason      = case when v_stage.kind = 'lost' then left(v_reason, 200) else null end,
    updated_at       = v_now
  where id = v_deal.id;

  insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by, changed_at)
  values (p_client_id, v_deal.id, v_deal.stage_id, v_stage.id, p_actor, v_now);

  -- status_id is still answered (unchanged) for a portal that reads it.
  return jsonb_build_object('moved', true, 'stage_entered_at', v_now, 'kind', v_stage.kind,
                            'status_id', v_deal.status_id);
end;
$fn$;
revoke execute on function public.crm_move_deal(text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.crm_move_deal(text, uuid, uuid, uuid, text) to service_role;

-- Give a card a status. Only the system calls this now (crm_design_event, forward only); the card
-- stays in its stage. p_actor is kept for the signature.
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
  v_deal  public.crm_deals%rowtype;
  v_new   public.crm_statuses%rowtype;
  v_cur   double precision;
begin
  select * into v_deal from public.crm_deals where id = p_deal and client_id = p_client_id for update;
  if not found then raise exception 'deal not found' using errcode = 'no_data_found'; end if;
  select * into v_new from public.crm_statuses where id = p_status and client_id = p_client_id and archived_at is null;
  if not found then raise exception 'status not found' using errcode = 'no_data_found'; end if;
  if v_deal.status_id = v_new.id then return jsonb_build_object('changed', false); end if;
  if p_forward_only then
    select position into v_cur from public.crm_statuses where id = v_deal.status_id and archived_at is null;
    if v_cur is not null and v_new.position <= v_cur then return jsonb_build_object('changed', false); end if;
  end if;

  update public.crm_deals set status_id = v_new.id, updated_at = now() where id = v_deal.id;
  return jsonb_build_object('changed', true, 'moved', false, 'stage_id', v_deal.stage_id);
end;
$fn$;
revoke execute on function public.crm_set_deal_status(text, uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant  execute on function public.crm_set_deal_status(text, uuid, uuid, uuid, boolean) to service_role;

-- ── PART 2 — every account ───────────────────────────────────────────────────────────────
-- Nothing reads or writes a pipeline or a stage until this commits (see SAFE WITH WHAT IS LIVE).
lock table public.crm_pipelines, public.crm_pipeline_stages in access exclusive mode;

-- Quotes stops being the design feed, and no pipeline mirrors the statuses any more.
update public.crm_pipelines set feeds_designs = false, mirrors_statuses = false, updated_at = now()
 where (seed_kind = 'quotes' and feeds_designs) or mirrors_statuses;

-- Statuses + Shed Deals for every account there is (client_configs is the tenant list), Shed Deals
-- now the feed.
do $acc$
declare r record;
begin
  for r in select client_id from public.client_configs loop
    perform public.crm_ensure_pipelines(r.client_id);
  end loop;
end;
$acc$;

-- Shed Deals takes Quotes' place at the front of the tab row (the board opens on the first one).
update public.crm_pipelines s set position = q.position, updated_at = now()
  from public.crm_pipelines q
 where q.client_id = s.client_id and q.seed_kind = 'quotes' and q.archived_at is null
   and s.seed_kind = 'shed_deals' and s.archived_at is null and q.position < s.position;

-- Any card still in Quotes (removed ones too, so a restore lands somewhere live) moves to its
-- account's Shed Deals, first open stage. Its status is not touched. One history row each.
with target as (
  select p.client_id, p.id as pipeline_id,
         (select s.id from public.crm_pipeline_stages s
           where s.pipeline_id = p.id and s.archived_at is null and s.kind = 'open'
           order by s.position limit 1) as stage_id
    from public.crm_pipelines p
   where p.seed_kind = 'shed_deals' and p.archived_at is null
), moving as (
  select d.id, d.stage_id as from_stage, t.pipeline_id, t.stage_id
    from public.crm_deals d
    join public.crm_pipelines q on q.id = d.pipeline_id and q.seed_kind = 'quotes'
    join target t on t.client_id = d.client_id and t.stage_id is not null
), moved as (
  update public.crm_deals d set
    pipeline_id = m.pipeline_id, stage_id = m.stage_id, stage_entered_at = now(),
    won_at = null, lost_at = null, lost_reason = null, updated_at = now()
    from moving m
   where d.id = m.id
  returning d.id, d.client_id, m.from_stage, d.stage_id
)
insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by)
select client_id, id, from_stage, stage_id, null from moved;

-- Retire Quotes: its stages, then the pipeline, archived together (one now(), which is how the
-- reverse finds them). A Quotes that still holds a card had nowhere to send it and stays: the
-- checks below refuse the whole file in that case.
update public.crm_pipeline_stages s set archived_at = now(), updated_at = now()
  from public.crm_pipelines q
 where s.pipeline_id = q.id and q.seed_kind = 'quotes' and q.archived_at is null and s.archived_at is null
   and not exists (select 1 from public.crm_deals d where d.pipeline_id = q.id);
update public.crm_pipelines q set archived_at = now(), updated_at = now()
 where q.seed_kind = 'quotes' and q.archived_at is null
   and not exists (select 1 from public.crm_deals d where d.pipeline_id = q.id);

-- A stage never sets a status again. Live stages lose their link; an archived one keeps it (the
-- retired Quotes stages, so the reverse can put 302's mirror back as it was).
update public.crm_pipeline_stages set status_id = null, updated_at = now()
 where status_id is not null and archived_at is null;
alter table public.crm_pipeline_stages drop constraint if exists crm_pipeline_stages_no_status_link;
alter table public.crm_pipeline_stages add constraint crm_pipeline_stages_no_status_link
  check (status_id is null or archived_at is not null);
comment on column public.crm_pipeline_stages.status_id is
  'Retired by 303: a stage never sets a status (statuses are system-driven). Always NULL on a live stage (crm_pipeline_stages_no_status_link); an archived Quotes stage keeps its 302 link for the reverse.';
comment on column public.crm_pipelines.mirrors_statuses is
  'Retired by 303 (it marked 302''s Quotes pipeline). Always false; kept so a portal that still reads it keeps working.';

-- ── PART 3 — checks ──────────────────────────────────────────────────────────────────────
do $chk$
declare
  v_n int;
  v_t text := 'm303-rehearsal-' || substr(md5(random()::text), 1, 8);
  v_p uuid; v_s1 uuid; v_s2 uuid; v_st0 uuid; v_st uuid; v_r jsonb; v_d uuid;
begin
  select count(*) into v_n from public.crm_pipelines where seed_kind = 'quotes' and archived_at is null;
  if v_n > 0 then
    raise exception '303: % Quotes pipelines are still live: a card in one had no Shed Deals (with an open stage) to move to', v_n;
  end if;
  select count(*) into v_n from public.crm_deals d join public.crm_pipelines q on q.id = d.pipeline_id where q.seed_kind = 'quotes';
  if v_n > 0 then raise exception '303: % cards are still in a Quotes pipeline', v_n; end if;
  select count(*) into v_n from public.client_configs c
   where (select count(*) from public.crm_pipelines p
           where p.client_id = c.client_id and p.feeds_designs and p.archived_at is null and p.seed_kind = 'shed_deals') <> 1;
  if v_n > 0 then raise exception '303: % accounts do not have Shed Deals as the pipeline new designs land in', v_n; end if;
  select count(*) into v_n from public.client_configs c
    join public.crm_pipelines p on p.client_id = c.client_id and p.feeds_designs and p.archived_at is null
   where not exists (select 1 from public.crm_pipeline_stages s where s.pipeline_id = p.id and s.archived_at is null and s.kind = 'open');
  if v_n > 0 then raise exception '303: % accounts have no open stage in Shed Deals for a new design to land in', v_n; end if;
  select count(*) into v_n from public.crm_pipelines where mirrors_statuses;
  if v_n > 0 then raise exception '303: % pipelines still mirror the statuses', v_n; end if;
  select count(*) into v_n from public.crm_pipeline_stages where status_id is not null and archived_at is null;
  if v_n > 0 then raise exception '303: % live stages still set a status', v_n; end if;
  if has_table_privilege('authenticated', 'public.crm_deals', 'select')
     or has_table_privilege('authenticated', 'public.crm_statuses', 'select') then
    raise exception '303: browser roles can read the pipeline tables';
  end if;

  -- Rehearsal on a made-up account (no client_users row, so no owner; no design, so no design
  -- trigger). A new account gets the statuses and Shed Deals only, Shed Deals the feed; an old
  -- caller asking for Quotes gets Shed Deals; a move keeps the status; a status keeps the stage.
  perform public.crm_ensure_pipelines(v_t);
  select count(*) into v_n from public.crm_pipelines where client_id = v_t;
  if v_n <> 1 then raise exception '303: a new account got % pipelines, not just Shed Deals', v_n; end if;
  select id into v_p from public.crm_pipelines where client_id = v_t and seed_kind = 'shed_deals' and feeds_designs;
  if v_p is null then raise exception '303: a new account''s Shed Deals does not take new designs'; end if;
  if public.crm_seed_pipeline(v_t, 'quotes') <> v_p or public.crm_seed_pipeline(v_t, 'sales') <> v_p then
    raise exception '303: asking for Quotes did not answer Shed Deals';
  end if;
  select count(*) into v_n from public.crm_pipelines where client_id = v_t;
  if v_n <> 1 then raise exception '303: asking for Quotes made a pipeline'; end if;
  select id into v_s1 from public.crm_pipeline_stages where pipeline_id = v_p order by position limit 1;
  select id into v_s2 from public.crm_pipeline_stages where pipeline_id = v_p order by position offset 1 limit 1;
  if (select name from public.crm_pipeline_stages where id = v_s1) <> 'New Incoming' then
    raise exception '303: Shed Deals does not start at New Incoming';
  end if;

  v_r := public.crm_create_lead(v_t, 'Pat Rehearsal', 'Rehearsal Barns', '(555) 010-3031', 'pat303@example.invalid', null, null, 'manual', v_s1);
  v_d := (v_r->>'dealId')::uuid;
  if v_d is null then raise exception '303: create_lead made no deal'; end if;
  select status_id into v_st0 from public.crm_deals where id = v_d;
  if v_st0 is distinct from (select id from public.crm_statuses where client_id = v_t and archived_at is null order by position limit 1) then
    raise exception '303: a new card did not start on the first status';
  end if;
  perform public.crm_move_deal(v_t, v_d, v_s2, null, null);
  if (select status_id from public.crm_deals where id = v_d) is distinct from v_st0 then
    raise exception '303: moving a card changed its status';
  end if;
  select id into v_st from public.crm_statuses where client_id = v_t and trigger_event = 'estimate_sent';
  v_r := public.crm_set_deal_status(v_t, v_d, v_st, null, true);
  if (select status_id <> v_st or stage_id <> v_s2 from public.crm_deals where id = v_d) then
    raise exception '303: a status change did not stick, or moved the card';
  end if;
  begin
    update public.crm_pipeline_stages set status_id = v_st where id = v_s1;
    raise exception '303: a live stage took a status link';
  exception when check_violation then null;
  end;

  -- Clean the rehearsal away (the pipeline's cascade takes its stages, deals and history).
  delete from public.crm_pipelines where client_id = v_t;
  delete from public.crm_statuses where client_id = v_t;
  delete from public.crm_contacts where client_id = v_t;
  if exists (select 1 from public.crm_deals where client_id = v_t) then raise exception '303: rehearsal left cards'; end if;
end;
$chk$;

-- What the apply shows. designs_without_card is C15 (every design has a card; 0 on 2026-10-13).
select '303' as migration,
       (select count(*) from public.crm_pipelines where seed_kind = 'quotes' and archived_at is not null) as quotes_retired,
       (select count(*) from public.crm_pipelines where seed_kind = 'shed_deals' and feeds_designs and archived_at is null) as shed_deals_feeds,
       (select count(*) from public.client_configs) as accounts,
       (select count(*) from public.crm_deals x join public.crm_pipelines p on p.id = x.pipeline_id
         where x.short_code is not null and p.seed_kind = 'shed_deals') as design_cards_in_shed_deals,
       (select count(*) from public.crm_deals where short_code is not null) as design_cards,
       (select count(*) from public.designs d where d.status <> 'inventory'
           and not exists (select 1 from public.crm_deals x where x.client_id = d.client_id and x.short_code = d.short_code)) as designs_without_card;

commit;
