-- 302_crm_pipeline_designs.sql — designs become cards on the draggable sales pipelines.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('302', '302_crm_pipeline_designs') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;. To rehearse and change
--    nothing, swap the last `commit;` for `rollback;`.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-10-09, having used 301's board for a day: "I like the way this pipeline view looks
-- and works better than the Pipeline one ... move the Leads pipeline into the pipeline page and we
-- have the ability to have multiple pipelines." The Pipeline tab's old board derived six fixed
-- columns from designs.status and could not be dragged. Now every design is a CARD (a crm_deals
-- row) on the tenant's design-fed pipeline, and the Pipeline tab renders 301's board.
--
-- Her decisions the same day:
--   * DESIGN CARDS CAN BE DRAGGED ANYWHERE. When the estimate's status later changes, the card
--     jumps to the stage tied to that status. This retires the old board's rule that only an
--     accepted estimate could put a deal in Won ("A rep may not drag a deal into Won") — her call.
--   * The separate Leads tab goes; reps get Designs access.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1  crm_deals.short_code (one card per design, FK to designs, cascade on delete);
--           contact_id becomes nullable (a design with neither phone nor email still gets a card).
--           crm_pipeline_stages.design_status — "an estimate reaching this status lands here".
--           crm_pipelines.feeds_designs — at most one per tenant: where new designs appear.
--   PART 2  crm_seed_pipeline('sales') redefined as the old board's six stages, mapped, plus Lost,
--           so a builder sees the same columns on day one. Nobody had a 'sales' pipeline yet
--           (checked live 2026-10-09: the only pipeline anywhere was the internal Outreach one).
--   PART 3  crm_sync_design_deal(design) + the AFTER trigger on designs. Every status writer
--           (save_design, sync-design-status, customer-accept, send_invoice, delivery) goes through
--           this one choke point. ⛔ IT NEVER FAILS THE DESIGN WRITE: any error is caught, logged to
--           app_errors (code crm_design_deal_sync_failed) and swallowed. A broken pipeline must
--           never stop a customer's estimate from saving.
--   PART 4  Backfill: a Sales pipeline for every tenant with non-inventory designs, one card each.
--   PART 5  checks.
--
-- ── RULES ────────────────────────────────────────────────────────────────────────────────
--   * Inventory masters (status 'inventory') are lot buildings, not estimates: never a card.
--   * A status change moves the card only to a mapped stage in the card's CURRENT pipeline; a
--     status with no mapped stage there leaves the card where a person put it.
--   * A move made by the estimate writes its history row with changed_by NULL.
--   * The card's value is NOT copied: portal-settings reads the design's live total_cents.

begin;

-- ── PART 1 ───────────────────────────────────────────────────────────────────────────────
alter table public.crm_deals add column if not exists short_code text
  references public.designs (short_code) on delete cascade;
create unique index if not exists crm_deals_design_once on public.crm_deals (client_id, short_code) where short_code is not null;
alter table public.crm_deals alter column contact_id drop not null;
alter table public.crm_deals drop constraint if exists crm_deals_has_subject;
alter table public.crm_deals add constraint crm_deals_has_subject check (contact_id is not null or short_code is not null);
alter table public.crm_deals drop constraint if exists crm_deals_source_check;
alter table public.crm_deals add constraint crm_deals_source_check check (source in ('manual', 'import', 'booking', 'phone', 'design'));

alter table public.crm_pipeline_stages add column if not exists design_status text
  check (design_status is null or design_status in ('draft', 'sent', 'accepted', 'invoiced', 'delivered'));
create unique index if not exists crm_pipeline_stages_status_once
  on public.crm_pipeline_stages (pipeline_id, design_status) where design_status is not null and archived_at is null;

alter table public.crm_pipelines add column if not exists feeds_designs boolean not null default false;
create unique index if not exists crm_pipelines_one_design_feed
  on public.crm_pipelines (client_id) where feeds_designs and archived_at is null;

-- ── PART 2 ───────────────────────────────────────────────────────────────────────────────
create or replace function public.crm_seed_pipeline(p_client_id text, p_kind text default 'sales')
returns uuid
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_id     uuid;
  v_name   text;
  v_stages jsonb;
  v_lost   text[];
  v_feeds  boolean := false;
  v_s      jsonb;
  v_i      integer := 0;
begin
  if coalesce(btrim(p_client_id), '') = '' then
    raise exception 'a tenant is required' using errcode = 'null_value_not_allowed';
  end if;
  if p_kind = 'sales' then
    -- The old Pipeline board's stages, names and order (Carolyn's, from her Pipedrive screen),
    -- each tied to the estimate status that used to place a card there, plus Lost.
    v_name := 'Sales';
    v_feeds := true;
    v_stages := '[{"n":"Qualified","c":"#64748B","k":"open","d":"draft"},
                  {"n":"Demo Scheduled","c":"#0EA5E9","k":"open"},
                  {"n":"Proposal Made","c":"#6366F1","k":"open","d":"sent"},
                  {"n":"Contract Signed","c":"#16A34A","k":"won","d":"accepted"},
                  {"n":"Invoiced","c":"#14B8A6","k":"won","d":"invoiced"},
                  {"n":"Delivered","c":"#0F766E","k":"won","d":"delivered"},
                  {"n":"Lost","c":"#DC2626","k":"lost"}]';
    v_lost := array['Price', 'Went with a competitor', 'Timing', 'No response', 'Not a fit'];
  elsif p_kind = 'outreach' then
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

  insert into public.crm_pipelines (client_id, name, lost_reasons, seed_kind, feeds_designs, position)
  values (p_client_id, v_name, v_lost, p_kind,
          -- Only if no other live pipeline already feeds designs (crm_pipelines_one_design_feed).
          v_feeds and not exists (select 1 from public.crm_pipelines o where o.client_id = p_client_id
                                   and o.feeds_designs and o.archived_at is null),
          -- The design-fed pipeline is the board a builder opens on, so it goes first.
          case when v_feeds then coalesce((select min(position) from public.crm_pipelines where client_id = p_client_id), 2048) - 1024
               else coalesce((select max(position) from public.crm_pipelines where client_id = p_client_id), 0) + 1024 end)
  on conflict (client_id, seed_kind) where seed_kind is not null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.crm_pipelines where client_id = p_client_id and seed_kind = p_kind;
    return v_id;
  end if;

  for v_s in select * from jsonb_array_elements(v_stages) loop
    v_i := v_i + 1;
    insert into public.crm_pipeline_stages (client_id, pipeline_id, name, color, kind, design_status, position)
    values (p_client_id, v_id, v_s->>'n', v_s->>'c', v_s->>'k', v_s->>'d', v_i * 1024);
  end loop;
  return v_id;
end;
$fn$;
revoke execute on function public.crm_seed_pipeline(text, text) from public, anon, authenticated;
grant  execute on function public.crm_seed_pipeline(text, text) to service_role;

-- ── PART 3 ───────────────────────────────────────────────────────────────────────────────
-- Make sure a design has its card, and (when p_status_changed) move it to the stage its status
-- maps to. Callable on its own (the backfill and the checks use it); the trigger wraps it.
create or replace function public.crm_sync_design_deal(
  p_client_id      text,
  p_short_code     text,
  p_status         text,
  p_contact_id     uuid,
  p_at             timestamptz,
  p_status_changed boolean
) returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_pipe  uuid;
  v_deal  public.crm_deals%rowtype;
  v_stage public.crm_pipeline_stages%rowtype;
  v_at    timestamptz := coalesce(p_at, now());
begin
  if p_status is null or p_status = 'inventory' then
    return;
  end if;

  select * into v_deal from public.crm_deals where client_id = p_client_id and short_code = p_short_code;

  if not found then
    select id into v_pipe from public.crm_pipelines
     where client_id = p_client_id and feeds_designs and archived_at is null;
    if v_pipe is null then
      -- First design on this tenant since 302: seed the starter. If 'sales' already exists but no
      -- longer feeds designs (a builder retired it), there is nowhere to put the card: none is made.
      v_pipe := public.crm_seed_pipeline(p_client_id, 'sales');
      if not exists (select 1 from public.crm_pipelines where id = v_pipe and feeds_designs and archived_at is null) then
        return;
      end if;
    end if;
    select * into v_stage from public.crm_pipeline_stages
     where pipeline_id = v_pipe and archived_at is null and design_status = p_status;
    if not found then
      select * into v_stage from public.crm_pipeline_stages
       where pipeline_id = v_pipe and archived_at is null and kind = 'open'
       order by position limit 1;
      if not found then return; end if;
    end if;
    insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, short_code, source,
                                  stage_entered_at, won_at, created_at, updated_at)
    values (p_client_id, v_pipe, v_stage.id, p_contact_id, p_short_code, 'design',
            v_at, case when v_stage.kind = 'won' then v_at end, v_at, v_at)
    on conflict (client_id, short_code) where short_code is not null do nothing;
    if found then
      insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by, changed_at)
      select p_client_id, d.id, null, v_stage.id, null, v_at
        from public.crm_deals d where d.client_id = p_client_id and d.short_code = p_short_code;
    end if;
    return;
  end if;

  -- Existing card: keep its contact in step with the design's.
  if v_deal.contact_id is distinct from p_contact_id and p_contact_id is not null then
    update public.crm_deals set contact_id = p_contact_id, updated_at = now() where id = v_deal.id;
  end if;

  if not p_status_changed or v_deal.archived_at is not null then
    return;
  end if;
  select * into v_stage from public.crm_pipeline_stages
   where pipeline_id = v_deal.pipeline_id and archived_at is null and design_status = p_status;
  if not found or v_stage.id = v_deal.stage_id then
    return;
  end if;
  update public.crm_deals set
    stage_id         = v_stage.id,
    stage_entered_at = now(),
    won_at           = case when v_stage.kind = 'won'  then coalesce(won_at, now())  else null end,
    lost_at          = case when v_stage.kind = 'lost' then coalesce(lost_at, now()) else null end,
    lost_reason      = case when v_stage.kind = 'lost' then lost_reason else null end,
    updated_at       = now()
  where id = v_deal.id;
  insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by)
  values (p_client_id, v_deal.id, v_deal.stage_id, v_stage.id, null);
end;
$fn$;
revoke execute on function public.crm_sync_design_deal(text, text, text, uuid, timestamptz, boolean) from public, anon, authenticated;
grant  execute on function public.crm_sync_design_deal(text, text, text, uuid, timestamptz, boolean) to service_role;

create or replace function public.designs_pipeline_sync()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  begin
    perform public.crm_sync_design_deal(
      new.client_id, new.short_code, new.status, new.contact_id,
      case when tg_op = 'INSERT' then coalesce(new.created_at, now()) else now() end,
      tg_op = 'UPDATE' and old.status is distinct from new.status);
  exception when others then
    -- ⛔ Never fail the design write. Record what broke and carry on.
    begin
      insert into public.app_errors (client_id, source, severity, code, message, context)
      values (new.client_id, 'db:designs_pipeline_sync', 'error', 'crm_design_deal_sync_failed',
              'designs_pipeline_sync: ' || sqlerrm,
              jsonb_build_object('sqlstate', sqlstate, 'short_code', new.short_code, 'op', tg_op));
    exception when others then null;
    end;
  end;
  return null;
end;
$fn$;

drop trigger if exists designs_pipeline_sync on public.designs;
create trigger designs_pipeline_sync
  after insert or update of status, contact_id on public.designs
  for each row execute function public.designs_pipeline_sync();

-- ── PART 4 — backfill ────────────────────────────────────────────────────────────────────
-- Oldest first, so each card's history starts at its design's own date.
do $bf$
declare r record;
begin
  for r in select client_id, short_code, status, contact_id, updated_at
             from public.designs where status <> 'inventory' order by created_at loop
    perform public.crm_sync_design_deal(r.client_id, r.short_code, r.status, r.contact_id, r.updated_at, false);
  end loop;
end;
$bf$;

-- ── PART 5 — checks ──────────────────────────────────────────────────────────────────────
do $chk$
declare v_missing int; v_wrong int;
begin
  select count(*) into v_missing from public.designs d
   where d.status <> 'inventory'
     and not exists (select 1 from public.crm_deals x where x.client_id = d.client_id and x.short_code = d.short_code);
  if v_missing > 0 then raise exception '302: % designs have no card', v_missing; end if;

  select count(*) into v_wrong from public.crm_deals x
    join public.designs d on d.short_code = x.short_code
    join public.crm_pipeline_stages s on s.id = x.stage_id
   where s.design_status is distinct from d.status;
  if v_wrong > 0 then raise exception '302: % cards sit in a stage that does not match their status', v_wrong; end if;

  if exists (select 1 from public.crm_deals where short_code is not null and source <> 'design') then
    raise exception '302: a design card has the wrong source';
  end if;

  -- The trigger's behaviour (a status change moves a card; an unrelated save keeps a person's
  -- drag) was proven before apply by appending those moves to this file and running it with the
  -- last `commit;` swapped for `rollback;` (see the 302 commit message) -- never here:
  -- flipping a real design to 'accepted' fires designs_ensure_order and would leave an order row.
end;
$chk$;

select (select count(*) from public.crm_pipelines where feeds_designs) as design_pipelines,
       (select count(*) from public.crm_deals where short_code is not null) as design_cards,
       (select count(*) from public.designs where status <> 'inventory') as designs;

commit;
