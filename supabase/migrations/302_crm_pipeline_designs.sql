-- 302_crm_pipeline_designs.sql — card STATUSES, the Quotes and Shed Deals pipelines, and every
-- design as a card.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('302', '302_crm_pipeline_designs') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;. To rehearse and change
--    nothing, swap the last `commit;` for `rollback;`.
--
-- ── WHY (Carolyn, 2026-10-10 / 10-11) ────────────────────────────────────────────────────
-- 301 shipped draggable pipelines as a Leads tab; she liked them better than the Pipeline page's
-- fixed board and asked for them to BE the Pipeline page, with:
--   * a STATUS on every card, shown as a coloured pill: New Lead, Appt Set, Estimate Sent,
--     Accepted, Invoiced, Payment Received, Scheduling, Delivered. "I do want to have these ... in
--     the settings, so that each builder can then rename them if they want and ... add others if
--     they want and they will set up When they get that stage such as when an estimate is
--     accepted then it gets that stage ... a drop down similar to how we have it in GHL settings."
--   * a QUOTES pipeline "for the designs/quotes that we do": its stages ARE the statuses, so a
--     card moves when its status changes. New designs land here.
--   * a SHED DEALS pipeline on every account, current and new, moved by hand "like the
--     Manufacturers outreach": New Incoming, Attempting Contact, Nurturing -Cool, Nurturing -Warm,
--     Nurturing -Hot, Gone Cold Again.
--   * every account's EXISTING designs moved into Shed Deals → Nurturing - Cool, "but I want the
--     status to reflect the actual status in the system". One card per design, movable to other
--     pipelines. The old status-derived board is retired.
--
-- ── THE MODEL ────────────────────────────────────────────────────────────────────────────
--   crm_statuses         per tenant; name, colour, order, and `trigger_event` — the system event
--                        that sets it (at most one status per event; NULL = set by hand only).
--   crm_deals.status_id  every card has one (a BEFORE INSERT default fills it).
--   stage.status_id      a LINK. Moving a card into a linked stage gives it that status, and giving
--                        a card that status moves it to that stage IF its pipeline has one. Quotes'
--                        stages are all linked (mirrors_statuses); Shed Deals' are not, so a status
--                        change never moves a card there.
--   Events: design_submitted, estimate_sent, estimate_accepted, invoiced, delivered (designs.status),
--   plus paid_in_full (payments against the order reach its total) and build_scheduled (a build
--   job for the design).
--
-- ── RULES ────────────────────────────────────────────────────────────────────────────────
--   * An AUTOMATIC event only moves a card's status FORWARD in the builder's status order; a person
--     can set any status by hand. (A late payment must not drag a Delivered card back.)
--   * ⛔ NO TRIGGER HERE MAY FAIL THE WRITE IT RIDES ON. A design save, a payment and a build job are
--     all more important than a card: every error is caught, logged to app_errors
--     (code crm_pipeline_sync_failed) and swallowed.
--   * Inventory masters (designs.status 'inventory') are lot buildings, never a card.
--   * A move made by the system writes its history row with changed_by NULL.
--   * The card's value is NOT copied: portal-settings reads the design's live total_cents.

begin;

-- ── PART 1 — statuses ────────────────────────────────────────────────────────────────────
create table if not exists public.crm_statuses (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null,
  name          text not null check (length(btrim(name)) between 1 and 40),
  color         text not null default '#64748B' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  position      double precision not null default 1024,
  trigger_event text check (trigger_event is null or trigger_event in
                  ('design_submitted', 'estimate_sent', 'estimate_accepted', 'invoiced',
                   'paid_in_full', 'build_scheduled', 'delivered')),
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, client_id)
);
create index if not exists crm_statuses_client_idx on public.crm_statuses (client_id, position) where archived_at is null;
create unique index if not exists crm_statuses_event_once on public.crm_statuses (client_id, trigger_event)
  where trigger_event is not null and archived_at is null;
alter table public.crm_statuses enable row level security;
revoke all on public.crm_statuses from public, anon, authenticated;

-- ── PART 2 — deals, stages, pipelines ────────────────────────────────────────────────────
alter table public.crm_deals add column if not exists short_code text
  references public.designs (short_code) on delete cascade;
create unique index if not exists crm_deals_design_once on public.crm_deals (client_id, short_code) where short_code is not null;
alter table public.crm_deals alter column contact_id drop not null;
alter table public.crm_deals drop constraint if exists crm_deals_has_subject;
alter table public.crm_deals add constraint crm_deals_has_subject check (contact_id is not null or short_code is not null);
alter table public.crm_deals drop constraint if exists crm_deals_source_check;
alter table public.crm_deals add constraint crm_deals_source_check check (source in ('manual', 'import', 'booking', 'phone', 'design'));
alter table public.crm_deals add column if not exists status_id uuid;
alter table public.crm_deals drop constraint if exists crm_deals_status_fk;
alter table public.crm_deals add constraint crm_deals_status_fk foreign key (status_id, client_id) references public.crm_statuses (id, client_id);

alter table public.crm_pipeline_stages add column if not exists status_id uuid;
alter table public.crm_pipeline_stages drop constraint if exists crm_pipeline_stages_status_fk;
alter table public.crm_pipeline_stages add constraint crm_pipeline_stages_status_fk foreign key (status_id, client_id) references public.crm_statuses (id, client_id);
create unique index if not exists crm_pipeline_stages_status_once
  on public.crm_pipeline_stages (pipeline_id, status_id) where status_id is not null and archived_at is null;

alter table public.crm_pipelines add column if not exists feeds_designs boolean not null default false;
alter table public.crm_pipelines add column if not exists mirrors_statuses boolean not null default false;
create unique index if not exists crm_pipelines_one_design_feed
  on public.crm_pipelines (client_id) where feeds_designs and archived_at is null;

-- ── PART 3 — starters ────────────────────────────────────────────────────────────────────
create or replace function public.crm_seed_statuses(p_client_id text)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_s jsonb; v_i int := 0;
begin
  if coalesce(btrim(p_client_id), '') = '' then
    raise exception 'a tenant is required' using errcode = 'null_value_not_allowed';
  end if;
  -- Once per tenant, ever: a builder who removed every status is not handed them back.
  perform pg_advisory_xact_lock(hashtext('crm_seed_statuses:' || p_client_id));
  if exists (select 1 from public.crm_statuses where client_id = p_client_id) then return; end if;
  for v_s in select * from jsonb_array_elements('[
      {"n":"New Lead","c":"#64748B","e":"design_submitted"},
      {"n":"Appt Set","c":"#0EA5E9","e":null},
      {"n":"Estimate Sent","c":"#6366F1","e":"estimate_sent"},
      {"n":"Accepted","c":"#16A34A","e":"estimate_accepted"},
      {"n":"Invoiced","c":"#14B8A6","e":"invoiced"},
      {"n":"Payment Received","c":"#84CC16","e":"paid_in_full"},
      {"n":"Scheduling","c":"#F59E0B","e":"build_scheduled"},
      {"n":"Delivered","c":"#0F766E","e":"delivered"}]'::jsonb) loop
    v_i := v_i + 1;
    insert into public.crm_statuses (client_id, name, color, trigger_event, position)
    values (p_client_id, v_s->>'n', v_s->>'c', v_s->>'e', v_i * 1024);
  end loop;
end;
$fn$;
revoke execute on function public.crm_seed_statuses(text) from public, anon, authenticated;
grant  execute on function public.crm_seed_statuses(text) to service_role;

create or replace function public.crm_seed_pipeline(p_client_id text, p_kind text default 'quotes')
returns uuid
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_kind   text := case when p_kind = 'sales' then 'quotes' else p_kind end;  -- 301's name, for a portal-settings still calling it
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
  if v_kind = 'quotes' then
    v_name := 'Quotes';
    v_lost := array['Price', 'Went with a competitor', 'Timing', 'No response', 'Not a fit'];
    -- First on the board: it is where new designs land.
    v_pos := coalesce((select min(position) from public.crm_pipelines where client_id = p_client_id), 2048) - 1024;
  elsif v_kind = 'shed_deals' then
    v_name := 'Shed Deals';
    v_stages := '[{"n":"New Incoming","c":"#64748B"},{"n":"Attempting Contact","c":"#0EA5E9"},
                  {"n":"Nurturing - Cool","c":"#60A5FA"},{"n":"Nurturing - Warm","c":"#F59E0B"},
                  {"n":"Nurturing - Hot","c":"#EF4444"},{"n":"Gone Cold Again","c":"#94A3B8"}]';
    v_lost := array['Price', 'Went with a competitor', 'Timing', 'No response', 'Not a fit'];
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
          v_kind = 'quotes' and not exists (select 1 from public.crm_pipelines o where o.client_id = p_client_id and o.feeds_designs and o.archived_at is null),
          v_kind = 'quotes')
  on conflict (client_id, seed_kind) where seed_kind is not null do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.crm_pipelines where client_id = p_client_id and seed_kind = v_kind;
    return v_id;
  end if;

  if v_kind = 'quotes' then
    -- One stage per status, linked, in the statuses' order.
    perform public.crm_seed_statuses(p_client_id);
    insert into public.crm_pipeline_stages (client_id, pipeline_id, name, color, kind, status_id, position)
    select p_client_id, v_id, st.name, st.color, 'open', st.id, row_number() over (order by st.position) * 1024
      from public.crm_statuses st where st.client_id = p_client_id and st.archived_at is null;
  else
    for v_s in select * from jsonb_array_elements(v_stages) loop
      v_i := v_i + 1;
      insert into public.crm_pipeline_stages (client_id, pipeline_id, name, color, kind, position)
      values (p_client_id, v_id, v_s->>'n', v_s->>'c', coalesce(v_s->>'k', 'open'), v_i * 1024);
    end loop;
  end if;
  return v_id;
end;
$fn$;
revoke execute on function public.crm_seed_pipeline(text, text) from public, anon, authenticated;
grant  execute on function public.crm_seed_pipeline(text, text) to service_role;

-- Statuses, Quotes and Shed Deals for a tenant. Idempotent; portal-settings calls it the first
-- time a new account opens the board, and the backfill below calls it for every existing one.
create or replace function public.crm_ensure_pipelines(p_client_id text)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  perform public.crm_seed_statuses(p_client_id);
  perform public.crm_seed_pipeline(p_client_id, 'quotes');
  perform public.crm_seed_pipeline(p_client_id, 'shed_deals');
end;
$fn$;
revoke execute on function public.crm_ensure_pipelines(text) from public, anon, authenticated;
grant  execute on function public.crm_ensure_pipelines(text) to service_role;

-- ── PART 4 — status default on a new card ────────────────────────────────────────────────
-- A card made in a linked stage takes that stage's status; otherwise the tenant's first status.
create or replace function public.crm_deals_default_status()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  if new.status_id is null then
    select s.status_id into new.status_id from public.crm_pipeline_stages s where s.id = new.stage_id;
  end if;
  if new.status_id is null then
    perform public.crm_seed_statuses(new.client_id);
    select id into new.status_id from public.crm_statuses
     where client_id = new.client_id and archived_at is null order by position limit 1;
  end if;
  return new;
end;
$fn$;
drop trigger if exists crm_deals_default_status on public.crm_deals;
create trigger crm_deals_default_status before insert on public.crm_deals
  for each row execute function public.crm_deals_default_status();

-- ── PART 5 — moving and status changes ───────────────────────────────────────────────────
-- 301's crm_move_deal, plus: a LINKED stage gives the card its status.
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
    status_id        = coalesce(v_stage.status_id, status_id),
    updated_at       = v_now
  where id = v_deal.id;

  insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by, changed_at)
  values (p_client_id, v_deal.id, v_deal.stage_id, v_stage.id, p_actor, v_now);

  return jsonb_build_object('moved', true, 'stage_entered_at', v_now, 'kind', v_stage.kind,
                            'status_id', coalesce(v_stage.status_id, v_deal.status_id));
end;
$fn$;
revoke execute on function public.crm_move_deal(text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.crm_move_deal(text, uuid, uuid, uuid, text) to service_role;

-- Give a card a status; if its pipeline has a stage linked to that status, move it there too.
-- p_forward_only (automatic events): skip unless the new status is later in the tenant's order
-- than the card's current one.
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
  v_stage public.crm_pipeline_stages%rowtype;
  v_moved boolean := false;
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

  if v_deal.archived_at is null then
    select * into v_stage from public.crm_pipeline_stages
     where pipeline_id = v_deal.pipeline_id and status_id = v_new.id and archived_at is null;
    if found and v_stage.id <> v_deal.stage_id then
      update public.crm_deals set
        stage_id = v_stage.id, stage_entered_at = now(),
        won_at  = case when v_stage.kind = 'won'  then coalesce(won_at, now())  else null end,
        lost_at = case when v_stage.kind = 'lost' then coalesce(lost_at, now()) else null end,
        lost_reason = case when v_stage.kind = 'lost' then coalesce(lost_reason, 'Set by status') else null end
      where id = v_deal.id;
      insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by)
      values (p_client_id, v_deal.id, v_deal.stage_id, v_stage.id, p_actor);
      v_moved := true;
    end if;
  end if;
  return jsonb_build_object('changed', true, 'moved', v_moved,
                            'stage_id', case when v_moved then v_stage.id else v_deal.stage_id end);
end;
$fn$;
revoke execute on function public.crm_set_deal_status(text, uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant  execute on function public.crm_set_deal_status(text, uuid, uuid, uuid, boolean) to service_role;

-- A system event for one design's card: the status that event sets (if the builder mapped one),
-- forward only.
create or replace function public.crm_design_event(p_client_id text, p_short_code text, p_event text)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_deal uuid; v_status uuid;
begin
  if p_event is null then return; end if;
  select id into v_deal from public.crm_deals where client_id = p_client_id and short_code = p_short_code;
  if v_deal is null then return; end if;
  select id into v_status from public.crm_statuses
   where client_id = p_client_id and trigger_event = p_event and archived_at is null;
  if v_status is null then return; end if;
  perform public.crm_set_deal_status(p_client_id, v_deal, v_status, null, true);
end;
$fn$;
revoke execute on function public.crm_design_event(text, text, text) from public, anon, authenticated;
grant  execute on function public.crm_design_event(text, text, text) to service_role;

-- designs.status → the event it is.
create or replace function public.crm_event_for_design_status(p_status text)
returns text language sql immutable set search_path to '' as $fn$
  select case p_status when 'draft' then 'design_submitted' when 'sent' then 'estimate_sent'
    when 'accepted' then 'estimate_accepted' when 'invoiced' then 'invoiced'
    when 'delivered' then 'delivered' end;
$fn$;

-- ── PART 6 — the triggers that feed events ───────────────────────────────────────────────
-- A design gets a card in its tenant's design-fed pipeline (Quotes) the first time it is seen,
-- then each status change is an event.
create or replace function public.crm_sync_design_card(
  p_client_id text, p_short_code text, p_status text, p_contact_id uuid, p_status_changed boolean
) returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_deal public.crm_deals%rowtype; v_pipe uuid; v_stage uuid; v_made boolean := false;
begin
  if p_status is null or p_status = 'inventory' then return; end if;
  select * into v_deal from public.crm_deals where client_id = p_client_id and short_code = p_short_code;
  if not found then
    select id into v_pipe from public.crm_pipelines where client_id = p_client_id and feeds_designs and archived_at is null;
    if v_pipe is null then
      perform public.crm_ensure_pipelines(p_client_id);
      select id into v_pipe from public.crm_pipelines where client_id = p_client_id and feeds_designs and archived_at is null;
      if v_pipe is null then return; end if;   -- a builder retired their Quotes pipeline: no card
    end if;
    select id into v_stage from public.crm_pipeline_stages
     where pipeline_id = v_pipe and archived_at is null and kind = 'open' order by position limit 1;
    if v_stage is null then return; end if;
    insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, short_code, source)
    values (p_client_id, v_pipe, v_stage, p_contact_id, p_short_code, 'design')
    on conflict (client_id, short_code) where short_code is not null do nothing;
    insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by)
    select p_client_id, d.id, null, v_stage, null from public.crm_deals d
     where d.client_id = p_client_id and d.short_code = p_short_code
       and not exists (select 1 from public.crm_deal_stage_changes c where c.deal_id = d.id);
    v_made := true;
  elsif v_deal.contact_id is distinct from p_contact_id and p_contact_id is not null then
    update public.crm_deals set contact_id = p_contact_id, updated_at = now() where id = v_deal.id;
  end if;
  if v_made or p_status_changed then
    perform public.crm_design_event(p_client_id, p_short_code, public.crm_event_for_design_status(p_status));
  end if;
end;
$fn$;
revoke execute on function public.crm_sync_design_card(text, text, text, uuid, boolean) from public, anon, authenticated;
grant  execute on function public.crm_sync_design_card(text, text, text, uuid, boolean) to service_role;

create or replace function public.designs_pipeline_sync()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  begin
    perform public.crm_sync_design_card(new.client_id, new.short_code, new.status, new.contact_id,
                                        tg_op = 'UPDATE' and old.status is distinct from new.status);
  exception when others then
    -- ⛔ Never fail the design write.
    begin
      insert into public.app_errors (client_id, source, severity, code, message, context)
      values (new.client_id, 'db:designs_pipeline_sync', 'error', 'crm_pipeline_sync_failed',
              'designs_pipeline_sync: ' || sqlerrm, jsonb_build_object('sqlstate', sqlstate, 'short_code', new.short_code, 'op', tg_op));
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

-- Paid in full: the order's live (non-voided) payments reach its total.
create or replace function public.payments_pipeline_sync()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare v_code text; v_total bigint; v_paid bigint;
begin
  begin
    select o.short_code, o.total_cents into v_code, v_total from public.orders o where o.id = new.order_id;
    if v_code is not null and coalesce(v_total, 0) > 0 then
      select coalesce(sum(amount_cents), 0) into v_paid from public.payments
       where order_id = new.order_id and voided_at is null;
      if v_paid >= v_total then
        perform public.crm_design_event(new.client_id, v_code, 'paid_in_full');
      end if;
    end if;
  exception when others then
    begin
      insert into public.app_errors (client_id, source, severity, code, message, context)
      values (new.client_id, 'db:payments_pipeline_sync', 'error', 'crm_pipeline_sync_failed',
              'payments_pipeline_sync: ' || sqlerrm, jsonb_build_object('sqlstate', sqlstate, 'order_id', new.order_id));
    exception when others then null;
    end;
  end;
  return null;
end;
$fn$;
drop trigger if exists payments_pipeline_sync on public.payments;
create trigger payments_pipeline_sync after insert or update of amount_cents, voided_at on public.payments
  for each row execute function public.payments_pipeline_sync();

-- On the build schedule: a build job for the design.
create or replace function public.build_jobs_pipeline_sync()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  begin
    if new.design_short_code is not null then
      perform public.crm_design_event(new.client_id, new.design_short_code, 'build_scheduled');
    end if;
  exception when others then
    begin
      insert into public.app_errors (client_id, source, severity, code, message, context)
      values (new.client_id, 'db:build_jobs_pipeline_sync', 'error', 'crm_pipeline_sync_failed',
              'build_jobs_pipeline_sync: ' || sqlerrm, jsonb_build_object('sqlstate', sqlstate, 'job', new.id));
    exception when others then null;
    end;
  end;
  return null;
end;
$fn$;
drop trigger if exists build_jobs_pipeline_sync on public.build_jobs;
create trigger build_jobs_pipeline_sync after insert or update of design_short_code on public.build_jobs
  for each row execute function public.build_jobs_pipeline_sync();

-- ── PART 7 — every account, and every existing design ────────────────────────────────────
-- Statuses + Quotes + Shed Deals for every account there is (client_configs is the tenant list).
do $acc$
declare r record;
begin
  for r in select client_id from public.client_configs loop
    perform public.crm_ensure_pipelines(r.client_id);
  end loop;
end;
$acc$;

-- 301's lazy starter was an empty "Sales" pipeline (seed_kind 'sales'); midwest-mini-barns got one on
-- 2026-10-11 when its Leads board was opened. Quotes and Shed Deals replace it: retire it while empty.
update public.crm_pipelines p set archived_at = now(), updated_at = now()
 where p.seed_kind = 'sales' and p.archived_at is null
   and not exists (select 1 from public.crm_deals d where d.pipeline_id = p.id);

-- Cards that already exist (301's leads) get the tenant's first status.
update public.crm_deals d set status_id = (select s.id from public.crm_statuses s
   where s.client_id = d.client_id and s.archived_at is null order by s.position limit 1)
 where d.status_id is null;

-- Carolyn: every account's existing designs go to Shed Deals → Nurturing - Cool, with the status
-- that matches where the design REALLY is: Delivered, else Scheduling (a build job), else Payment
-- Received (paid in full), else its designs.status.
insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, short_code, source,
                              status_id, stage_entered_at, created_at, updated_at)
select d.client_id, p.id, s.id, d.contact_id, d.short_code, 'design',
       (select st.id from public.crm_statuses st
         where st.client_id = d.client_id and st.archived_at is null and st.trigger_event =
           case
             when d.status = 'delivered' then 'delivered'
             when exists (select 1 from public.build_jobs j where j.client_id = d.client_id and j.design_short_code = d.short_code) then 'build_scheduled'
             when exists (select 1 from public.orders o where o.client_id = d.client_id and o.short_code = d.short_code
                            and coalesce(o.total_cents, 0) > 0
                            and (select coalesce(sum(pm.amount_cents), 0) from public.payments pm
                                  where pm.order_id = o.id and pm.voided_at is null) >= o.total_cents) then 'paid_in_full'
             else public.crm_event_for_design_status(d.status)
           end),
       coalesce(d.updated_at, d.created_at, now()), coalesce(d.created_at, now()), now()
  from public.designs d
  join public.crm_pipelines p on p.client_id = d.client_id and p.seed_kind = 'shed_deals'
  join public.crm_pipeline_stages s on s.pipeline_id = p.id and s.name = 'Nurturing - Cool'
 where d.status <> 'inventory'
on conflict (client_id, short_code) where short_code is not null do nothing;

insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by, changed_at)
select x.client_id, x.id, null, x.stage_id, null, x.stage_entered_at
  from public.crm_deals x
 where x.short_code is not null
   and not exists (select 1 from public.crm_deal_stage_changes c where c.deal_id = x.id);

-- ── PART 8 — checks ──────────────────────────────────────────────────────────────────────
do $chk$
declare v_n int;
begin
  if has_table_privilege('authenticated', 'public.crm_statuses', 'select') then
    raise exception '302: browser roles can read crm_statuses';
  end if;
  select count(*) into v_n from public.client_configs c
   where not exists (select 1 from public.crm_pipelines p where p.client_id = c.client_id and p.seed_kind = 'shed_deals')
      or not exists (select 1 from public.crm_pipelines p where p.client_id = c.client_id and p.seed_kind = 'quotes' and p.feeds_designs);
  if v_n > 0 then raise exception '302: % accounts are missing Quotes or Shed Deals', v_n; end if;
  select count(*) into v_n from public.client_configs c
   where (select count(*) from public.crm_statuses s where s.client_id = c.client_id) <> 8;
  if v_n > 0 then raise exception '302: % accounts do not have the 8 starter statuses', v_n; end if;
  select count(*) into v_n from public.designs d where d.status <> 'inventory'
     and not exists (select 1 from public.crm_deals x where x.client_id = d.client_id and x.short_code = d.short_code);
  if v_n > 0 then raise exception '302: % designs have no card', v_n; end if;
  select count(*) into v_n from public.crm_deals where status_id is null;
  if v_n > 0 then raise exception '302: % cards have no status', v_n; end if;
  select count(*) into v_n from public.crm_deals x
    join public.crm_pipeline_stages s on s.id = x.stage_id
   where x.short_code is not null and s.name <> 'Nurturing - Cool';
  if v_n > 0 then raise exception '302: % design cards are not in Nurturing - Cool', v_n; end if;
  -- The triggers' behaviour (a new design lands in Quotes; a status change moves its status and,
  -- in Quotes, its stage; forward-only; a Shed Deals card keeps its stage) is proven before apply
  -- by appending those moves to this file and running it with the last `commit;` swapped for
  -- `rollback;`: never here, because it would write real designs and orders.
end;
$chk$;

select (select count(*) from public.crm_pipelines where seed_kind = 'quotes') as quotes_pipelines,
       (select count(*) from public.crm_pipelines where seed_kind = 'shed_deals') as shed_deals_pipelines,
       (select count(*) from public.crm_deals where short_code is not null) as design_cards,
       (select count(*) from public.designs where status <> 'inventory') as designs;

commit;
