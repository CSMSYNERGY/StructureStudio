-- 342_crm_outcomes_not_stages.sql — Won and Lost stop being STAGES, "Appt Set" becomes
-- "Contact Made" and fires off real activity, and a card's outcome lives on the card.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('342', '342_crm_outcomes_not_stages') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. To rehearse and change nothing, swap the last `commit;`
--    for `rollback;`.
--    ⚠️ Deploy portal-settings RIGHT AFTER this. Until it is live, the deployed portal-settings
--    still seeds a Won and a Lost stage for a new pipeline (its crm_pipeline_save), which this
--    file's CHECK refuses — the builder sees a generic "couldn't create that pipeline". The new
--    portal-settings works on a database without this file too (it only stops asking for the
--    stages and the paths this file retires), so deploying it first is also safe.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- 342 is the next free number in the LIVE LEDGER, which was at 341 on 2026-10-26. Note the repo's
-- migrations folder stops at 335: the database is ahead of it (336-341 were applied from elsewhere),
-- so the folder is NOT the place to read the next number from — ask the ledger:
--   select version, name from supabase_migrations.schema_migrations order by version desc limit 5;
-- It must come after 303, and refuses without it.
--
-- ── WHY (Carolyn, 2026-10-26) ────────────────────────────────────────────────────────────
--   * "We need a LOST status. We will not be using a column called lost ... it should be a
--     status." And then: "Won should also not be a stage ... remove all WON and Lost stages from
--     all client accounts. Invoiced indicates a sold job."
--     A stage is WHERE A LEAD IS in the process. Lost is not a place — a lead can be lost at any
--     stage — and sold is already recorded by the status ladder. Dragging a card into a Lost column
--     threw away the one fact worth reporting (where it actually died) and left two dead columns on
--     every board.
--   * "LOST stays in the column it was when marking lost." Marking a card lost does not move it.
--     The board hides it by default; "Show lost" brings it back where it died, with its reason.
--   * "since we now have meetings set up we should be able to see on the card when an appt is set.
--     I don't think we want that as a status as it can happen anytime in the process, so the status
--     that says appt set currently should by default be contact made ... and it should switch
--     automatically after there was an actual call recorded ... or there was a text inbound and
--     outbound both. This should only change to this if the lead is in New Lead status."
--     `Appt Set` was seeded with NO trigger_event, so no card could ever get it (302:113) — a dead
--     rung. It becomes Contact Made, fired by an answered call or a two-way text thread, and only
--     while the card is still on the first status. The appointment itself becomes a chip on the
--     card, read live from `meetings` — not a status, because it can happen at any point.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1  the table: 'contact_made' joins the trigger_event list.
--   PART 2  the functions: crm_seed_statuses seeds Contact Made with its event; crm_seed_pipeline's
--           'outreach' starter loses Won and Lost; crm_move_deal is a stage move and nothing else
--           (it no longer writes won_at/lost_at/lost_reason, nor refuses a move for want of a lost
--           reason); crm_set_deal_status stamps won_at when a card reaches the INVOICED status, the
--           only thing that marks a deal sold now; crm_set_deal_lost / crm_clear_deal_lost mark and
--           reopen a card WITHOUT moving it; crm_contact_made advances a first-status card, and two
--           swallowing triggers on phone_calls and sms_messages call it.
--   PART 3  the data, in every account: Appt Set → Contact Made where it is still the seeded row;
--           every card in a Won or Lost stage keeps its won_at/lost_at/lost_reason and lands back on
--           the stage it was last working in; those stages are ARCHIVED; and a CHECK keeps every
--           live stage 'open'.
--   PART 4  checks, and a rehearsal on a made-up account (no design, no real row touched).
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- No column or table is dropped. crm_pipeline_stages.kind stays (archived stages and the history
-- still read it) and the deployed portal still selects it; from here it is always 'open' on a live
-- stage. crm_deals.won_at / lost_at / lost_reason keep their meaning — they are simply written
-- directly now instead of as a side effect of a stage move. crm_move_deal keeps its 5-argument
-- signature, so the deployed portal-settings' p_lost_reason call still binds (it is ignored).
-- The pipeline tables are locked (ACCESS EXCLUSIVE) for the length of the transaction under a 15 s
-- lock_timeout. A deadlock or a lock timeout rolls the whole file back; run it again.
-- On 2026-10-26 this touched: 2 Lost stages and 2 Won stages in 2 accounts, holding ONE live card
-- (structure-studio, pipeline "Builders", last worked in "New Lead"); and the seeded Appt Set row
-- in all 6 accounts.
--
-- ── REVERSE (only if this has to be undone) ──────────────────────────────────────────────
--   1. Put 303's functions back: copy 303_crm_retire_quotes.sql from `-- ── PART 1 — the functions`
--      up to (not including) `-- ── PART 2`. That restores crm_seed_pipeline, crm_move_deal and
--      crm_set_deal_status. Then re-run 302's crm_seed_statuses (302's PART 3, first function).
--   2. Then:
-- REVERSE-SQL-BEGIN
-- alter table public.crm_pipeline_stages drop constraint if exists crm_pipeline_stages_open_only;
-- drop trigger if exists phone_calls_contact_made on public.phone_calls;
-- drop trigger if exists sms_messages_contact_made on public.sms_messages;
-- drop function if exists public.phone_calls_contact_made();
-- drop function if exists public.sms_messages_contact_made();
-- drop function if exists public.crm_contact_made(text, uuid);
-- drop function if exists public.crm_set_deal_lost(text, uuid, uuid, text);
-- drop function if exists public.crm_clear_deal_lost(text, uuid, uuid);
-- update public.crm_pipeline_stages set archived_at = null, updated_at = now()
--  where kind in ('won', 'lost') and archived_at is not null;
-- update public.crm_statuses set name = 'Appt Set', trigger_event = null, updated_at = now()
--  where btrim(name) = 'Contact Made' and trigger_event = 'contact_made';
-- alter table public.crm_statuses drop constraint crm_statuses_trigger_event_check;
-- alter table public.crm_statuses add constraint crm_statuses_trigger_event_check
--   check (trigger_event is null or trigger_event in
--          ('design_submitted', 'estimate_sent', 'estimate_accepted', 'invoiced',
--           'paid_in_full', 'build_scheduled', 'delivered'));
-- delete from supabase_migrations.schema_migrations where version = '342';
-- REVERSE-SQL-END
--   (Cards do NOT go back into the Won/Lost columns: their won_at/lost_at say the same thing, and
--   which column they sat in is the fact this migration set out to stop losing.)

begin;

set local lock_timeout = '15s';

do $pre$
begin
  if to_regclass('public.crm_statuses') is null
     or not exists (select 1 from pg_constraint
                     where conname = 'crm_pipeline_stages_no_status_link'
                       and conrelid = 'public.crm_pipeline_stages'::regclass) then
    raise exception '342: crm_statuses / the 303 stage CHECK are missing (migration 303 not applied?)';
  end if;
  if to_regclass('public.phone_calls') is null or to_regclass('public.sms_messages') is null then
    raise exception '342: phone_calls / sms_messages are missing (migrations 150 and 254 not applied?)';
  end if;
end
$pre$;

-- ── PART 1 — the table ───────────────────────────────────────────────────────────────────
-- A card's status can now be set by a CONVERSATION, not only by a design, a payment or a build
-- slot. The event list lives in exactly one place (302:58-60); this adds to it.
alter table public.crm_statuses drop constraint if exists crm_statuses_trigger_event_check;
alter table public.crm_statuses add constraint crm_statuses_trigger_event_check
  check (trigger_event is null or trigger_event in
         ('design_submitted', 'estimate_sent', 'estimate_accepted', 'invoiced',
          'paid_in_full', 'build_scheduled', 'delivered', 'contact_made'));

-- ── PART 2 — the functions ───────────────────────────────────────────────────────────────
-- 302's starter statuses, with Contact Made in place of the unreachable Appt Set. Still once per
-- tenant, ever.
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
      {"n":"Contact Made","c":"#0EA5E9","e":"contact_made"},
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

-- 303's starters, with no Won or Lost stage in the 'outreach' one: neither is a stage any more.
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
    -- Won and Lost were the last two stages here until 342. Sold is the status ladder (Invoiced
    -- onwards); lost is a flag on the card, set where the card already stands.
    v_stages := '[{"n":"New Lead","c":"#64748B"},{"n":"Attempting Contact","c":"#0EA5E9"},
                  {"n":"Connected","c":"#14B8A6"},{"n":"Demo Scheduled","c":"#6366F1"},
                  {"n":"Demo Completed","c":"#8B5CF6"},{"n":"Proposal Sent","c":"#F59E0B"},
                  {"n":"Not Now / Nurture","c":"#94A3B8"}]';
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

-- A STAGE MOVE IS A STAGE MOVE (342). It no longer writes won_at, lost_at or lost_reason, and no
-- longer refuses for want of a lost reason: there is no stage that means won or lost any more.
-- Moving a card that is marked lost leaves it marked — reopening is deliberate
-- (crm_clear_deal_lost), never a side effect of a drag.
-- p_lost_reason is kept so the deployed portal-settings' call still binds; it is ignored.
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

  update public.crm_deals set
    pipeline_id      = v_stage.pipeline_id,
    stage_id         = v_stage.id,
    stage_entered_at = v_now,
    updated_at       = v_now
  where id = v_deal.id;

  insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by, changed_at)
  values (p_client_id, v_deal.id, v_deal.stage_id, v_stage.id, p_actor, v_now);

  -- status_id and the lost flag are still answered (unchanged) for a portal that reads them.
  return jsonb_build_object('moved', true, 'stage_entered_at', v_now, 'kind', v_stage.kind,
                            'status_id', v_deal.status_id, 'lost_at', v_deal.lost_at);
end;
$fn$;
revoke execute on function public.crm_move_deal(text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.crm_move_deal(text, uuid, uuid, uuid, text) to service_role;

-- Give a card a status. Only the system calls this (crm_design_event and crm_contact_made, forward
-- only); the card stays in its stage. p_actor is kept for the signature.
-- 342: reaching the INVOICED status is what marks a deal SOLD now that there is no Won stage —
-- Carolyn, "Invoiced indicates a sold job". Stamped once; a later status never clears it.
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
  v_won   timestamptz;
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

  v_won := case when v_new.trigger_event = 'invoiced' then coalesce(v_deal.won_at, now()) else v_deal.won_at end;
  update public.crm_deals set status_id = v_new.id, won_at = v_won, updated_at = now() where id = v_deal.id;
  return jsonb_build_object('changed', true, 'moved', false, 'stage_id', v_deal.stage_id, 'won_at', v_won);
end;
$fn$;
revoke execute on function public.crm_set_deal_status(text, uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant  execute on function public.crm_set_deal_status(text, uuid, uuid, uuid, boolean) to service_role;

-- MARK A CARD LOST WHERE IT STANDS (342). Carolyn: "LOST stays in the column it was when marking
-- lost." The stage, the pipeline and the status are untouched; the board hides the card by default
-- and shows it in its own column under "Show lost". A reason is required, as it was when this was
-- a drag into a Lost column.
create or replace function public.crm_set_deal_lost(
  p_client_id text,
  p_deal      uuid,
  p_actor     uuid default null,
  p_reason    text default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_deal   public.crm_deals%rowtype;
  v_now    timestamptz := now();
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 200);
begin
  if v_reason is null then
    raise exception 'a lost reason is required' using errcode = 'check_violation';
  end if;
  select * into v_deal from public.crm_deals
   where id = p_deal and client_id = p_client_id and archived_at is null
   for update;
  if not found then raise exception 'deal not found' using errcode = 'no_data_found'; end if;
  if v_deal.lost_at is not null then
    return jsonb_build_object('lost', false, 'lost_at', v_deal.lost_at, 'lost_reason', v_deal.lost_reason,
                              'stage_id', v_deal.stage_id);
  end if;

  update public.crm_deals set lost_at = v_now, lost_reason = v_reason, updated_at = v_now
   where id = v_deal.id;
  return jsonb_build_object('lost', true, 'lost_at', v_now, 'lost_reason', v_reason, 'stage_id', v_deal.stage_id);
end;
$fn$;
revoke execute on function public.crm_set_deal_lost(text, uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.crm_set_deal_lost(text, uuid, uuid, text) to service_role;

-- Reopen a card marked lost. It is already in the stage it was working in, so nothing moves.
create or replace function public.crm_clear_deal_lost(
  p_client_id text,
  p_deal      uuid,
  p_actor     uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_deal public.crm_deals%rowtype;
  v_now  timestamptz := now();
begin
  select * into v_deal from public.crm_deals
   where id = p_deal and client_id = p_client_id and archived_at is null
   for update;
  if not found then raise exception 'deal not found' using errcode = 'no_data_found'; end if;
  if v_deal.lost_at is null then
    return jsonb_build_object('reopened', false, 'stage_id', v_deal.stage_id);
  end if;

  update public.crm_deals set lost_at = null, lost_reason = null, updated_at = v_now
   where id = v_deal.id;
  return jsonb_build_object('reopened', true, 'stage_id', v_deal.stage_id);
end;
$fn$;
revoke execute on function public.crm_clear_deal_lost(text, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.crm_clear_deal_lost(text, uuid, uuid) to service_role;

-- SOMEBODY ACTUALLY TALKED TO THIS LEAD (342). Carolyn: the status "should switch automatically
-- after there was an actual call recorded ... or there was a text inbound and outbound both. This
-- should only change to this if the lead is in New Lead status."
--   * keyed on the CONTACT, not a design short_code (crm_design_event's key): a lead you phoned may
--     have no design yet. A contact with no card has nothing to move, and says so with 0.
--   * "in New Lead status" is the tenant's FIRST status by position — the same expression
--     crm_deals_default_status uses to decide where a new card starts. Not the name 'New Lead',
--     which every builder can rename, and not trigger_event 'design_submitted', which a builder can
--     point at another status.
--   * forward_only as well, so this can never pull a card backwards even if the two disagree.
create or replace function public.crm_contact_made(p_client_id text, p_contact uuid)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_status uuid;
  v_first  uuid;
  v_n      integer := 0;
  r        record;
begin
  if p_contact is null or coalesce(btrim(p_client_id), '') = '' then return 0; end if;
  select id into v_status from public.crm_statuses
   where client_id = p_client_id and trigger_event = 'contact_made' and archived_at is null;
  if v_status is null then return 0; end if;          -- the builder removed the rung: nothing to do
  select id into v_first from public.crm_statuses
   where client_id = p_client_id and archived_at is null order by position limit 1;
  if v_first is null or v_first = v_status then return 0; end if;

  for r in select id from public.crm_deals
            where client_id = p_client_id and contact_id = p_contact
              and archived_at is null and status_id = v_first
  loop
    perform public.crm_set_deal_status(p_client_id, r.id, v_status, null, true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$fn$;
revoke execute on function public.crm_contact_made(text, uuid) from public, anon, authenticated;
grant  execute on function public.crm_contact_made(text, uuid) to service_role;

-- ⛔ NEITHER TRIGGER BELOW MAY FAIL THE WRITE IT RIDES ON (302:42-44). A call log and a text are
-- worth more than a card: every error is caught, logged to app_errors (code
-- crm_pipeline_sync_failed) and swallowed. Note phone_calls rows are written by the phone-api
-- Worker, not by an edge function, which is why this lives in the database.

-- An ANSWERED call, either direction. A missed call, a voicemail, a busy tone or a failure is not
-- contact; no minimum length (Carolyn said "an actual call recorded", nothing about seconds).
create or replace function public.phone_calls_contact_made()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  begin
    if new.contact_id is not null and new.answered_at is not null and new.status = 'completed' then
      perform public.crm_contact_made(new.client_id, new.contact_id);
    end if;
  exception when others then
    begin
      insert into public.app_errors (client_id, source, severity, code, message, context)
      values (new.client_id, 'db:phone_calls_contact_made', 'error', 'crm_pipeline_sync_failed',
              'phone_calls_contact_made: ' || sqlerrm,
              jsonb_build_object('sqlstate', sqlstate, 'call_id', new.id));
    exception when others then null;
    end;
  end;
  return null;
end;
$fn$;
drop trigger if exists phone_calls_contact_made on public.phone_calls;
create trigger phone_calls_contact_made
  after insert or update of status, answered_at, contact_id on public.phone_calls
  for each row execute function public.phone_calls_contact_made();

-- A text BOTH WAYS. One outbound text nobody answered is not contact, and neither is an inbound
-- one we never replied to. An inbound row arrives 'received'; an outbound one counts once the
-- provider took it ('sent' or 'delivered'), never while 'claimed' or after it failed.
create or replace function public.sms_messages_contact_made()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  begin
    if new.contact_id is not null
       and exists (select 1 from public.sms_messages m
                    where m.client_id = new.client_id and m.contact_id = new.contact_id
                      and m.direction = 'in')
       and exists (select 1 from public.sms_messages m
                    where m.client_id = new.client_id and m.contact_id = new.contact_id
                      and m.direction = 'out' and m.status in ('sent', 'delivered')) then
      perform public.crm_contact_made(new.client_id, new.contact_id);
    end if;
  exception when others then
    begin
      insert into public.app_errors (client_id, source, severity, code, message, context)
      values (new.client_id, 'db:sms_messages_contact_made', 'error', 'crm_pipeline_sync_failed',
              'sms_messages_contact_made: ' || sqlerrm,
              jsonb_build_object('sqlstate', sqlstate, 'message_id', new.id));
    exception when others then null;
    end;
  end;
  return null;
end;
$fn$;
drop trigger if exists sms_messages_contact_made on public.sms_messages;
create trigger sms_messages_contact_made
  after insert or update of status, contact_id on public.sms_messages
  for each row execute function public.sms_messages_contact_made();

-- ── PART 3 — the data, in every account ──────────────────────────────────────────────────
-- Nothing reads or writes a pipeline or a stage until this commits (see SAFE WITH WHAT IS LIVE).
lock table public.crm_pipelines, public.crm_pipeline_stages in access exclusive mode;

-- Appt Set → Contact Made, ONLY where it is still the row 302 seeded (no event, never renamed).
-- A builder who renamed or repurposed it keeps what they have: the list is theirs.
update public.crm_statuses set name = 'Contact Made', trigger_event = 'contact_made', updated_at = now()
 where btrim(name) = 'Appt Set' and trigger_event is null and archived_at is null;

-- Every card sitting in a Won or Lost stage: keep the outcome, and put the card back on the stage
-- it was last WORKING in. Removed cards too, so a restore lands somewhere live.
--   1. the stage it came from when it was dropped into Won/Lost, if that stage is still live
--   2. else the live stage just below the Won/Lost one
--   3. else the pipeline's first live stage
-- From here nothing moves at all — this one-off exists only because these cards are sitting IN the
-- columns being deleted.
create temporary table m342_moving on commit drop as
with dead as (
  select d.id, d.client_id, d.pipeline_id, d.stage_id, d.stage_entered_at,
         d.won_at, d.lost_at, d.lost_reason, s.kind, s.position
    from public.crm_deals d
    join public.crm_pipeline_stages s on s.id = d.stage_id
   where s.kind in ('won', 'lost') and s.archived_at is null
)
select dead.*,
       coalesce(
         (select c.from_stage from public.crm_deal_stage_changes c
            join public.crm_pipeline_stages x on x.id = c.from_stage
           where c.deal_id = dead.id and x.pipeline_id = dead.pipeline_id
             and x.archived_at is null and x.kind = 'open'
           order by c.changed_at desc limit 1),
         (select x.id from public.crm_pipeline_stages x
           where x.pipeline_id = dead.pipeline_id and x.archived_at is null and x.kind = 'open'
             and x.position < dead.position
           order by x.position desc limit 1),
         (select x.id from public.crm_pipeline_stages x
           where x.pipeline_id = dead.pipeline_id and x.archived_at is null and x.kind = 'open'
           order by x.position limit 1)
       ) as to_stage
  from dead;

-- stage_entered_at is left as it is: it says when the outcome happened, which is the truest thing
-- it can say about a card that has been sitting in a Lost column.
update public.crm_deals d set
  stage_id   = m.to_stage,
  won_at     = case when m.kind = 'won'  then coalesce(m.won_at,  m.stage_entered_at) else m.won_at  end,
  lost_at    = case when m.kind = 'lost' then coalesce(m.lost_at, m.stage_entered_at) else m.lost_at end,
  updated_at = now()
  from m342_moving m
 where d.id = m.id and m.to_stage is not null;

insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by)
select client_id, id, stage_id, to_stage, null from m342_moving where to_stage is not null;

-- Retire the columns themselves. A Won/Lost stage that still holds a card (its pipeline had no
-- live open stage to put it on) stays, and the checks below refuse the whole file in that case.
update public.crm_pipeline_stages s set archived_at = now(), updated_at = now()
 where s.kind in ('won', 'lost') and s.archived_at is null
   and not exists (select 1 from public.crm_deals d where d.stage_id = s.id);

-- Say WHY before the CHECK below says it unhelpfully: a Won/Lost stage left live is one whose
-- pipeline had no open stage to put its card back on.
do $left$
declare v_n int;
begin
  select count(*) into v_n from public.crm_pipeline_stages
   where kind in ('won', 'lost') and archived_at is null;
  if v_n > 0 then
    raise exception '342: % Won/Lost stages still hold a card and their pipeline has no live open stage to move it to. Add an open stage to those pipelines, then run this again.', v_n;
  end if;
end
$left$;

-- A live stage is a stage: it never means won or lost again. kind stays on the column so archived
-- stages still read, which is also how the reverse finds them.
alter table public.crm_pipeline_stages drop constraint if exists crm_pipeline_stages_open_only;
alter table public.crm_pipeline_stages add constraint crm_pipeline_stages_open_only
  check (kind = 'open' or archived_at is not null);
comment on column public.crm_pipeline_stages.kind is
  'Retired by 342: always ''open'' on a live stage (crm_pipeline_stages_open_only). A card''s outcome lives on the card — crm_deals.lost_at/lost_reason, and won_at stamped when it reaches the Invoiced status. Archived Won/Lost stages keep their kind for the reverse.';

-- ── PART 4 — checks ──────────────────────────────────────────────────────────────────────
do $chk$
declare
  v_n int;
  v_t text := 'm342-rehearsal-' || substr(md5(random()::text), 1, 8);
  v_p uuid; v_s1 uuid; v_s2 uuid; v_c uuid; v_d uuid; v_d2 uuid;
  v_first uuid; v_made uuid; v_inv uuid;
  v_r jsonb; v_got uuid; v_won timestamptz;
begin
  select count(*) into v_n from public.crm_pipeline_stages where kind in ('won', 'lost') and archived_at is null;
  if v_n > 0 then
    raise exception '342: % Won/Lost stages are still live: a card in one had no open stage in its pipeline to go back to', v_n;
  end if;
  select count(*) into v_n from public.crm_deals d join public.crm_pipeline_stages s on s.id = d.stage_id
   where s.kind <> 'open';
  if v_n > 0 then raise exception '342: % cards are still in a Won or Lost stage', v_n; end if;
  select count(*) into v_n from public.crm_statuses
   where btrim(name) = 'Appt Set' and trigger_event is null and archived_at is null;
  if v_n > 0 then raise exception '342: % accounts still have the unreachable Appt Set status', v_n; end if;
  select count(*) into v_n from public.crm_statuses c
   where c.trigger_event = 'contact_made' and c.archived_at is null
     and c.position <= (select min(o.position) from public.crm_statuses o
                         where o.client_id = c.client_id and o.archived_at is null);
  if v_n > 0 then
    raise exception '342: % accounts have Contact Made as their FIRST status, so no card could ever reach it', v_n;
  end if;
  if has_table_privilege('authenticated', 'public.crm_deals', 'select')
     or has_table_privilege('authenticated', 'public.crm_statuses', 'select') then
    raise exception '342: browser roles can read the pipeline tables';
  end if;

  -- ── Rehearsal on a made-up account (no client_users row, so no owner; no design, so no design
  -- trigger fires). Every claim this migration makes, proved on real functions.
  perform public.crm_ensure_pipelines(v_t);
  select id into v_p from public.crm_pipelines where client_id = v_t and seed_kind = 'shed_deals';
  select id into v_s1 from public.crm_pipeline_stages where pipeline_id = v_p order by position limit 1;
  select id into v_s2 from public.crm_pipeline_stages where pipeline_id = v_p order by position offset 1 limit 1;
  select count(*) into v_n from public.crm_pipeline_stages where pipeline_id = v_p and kind <> 'open';
  if v_n > 0 then raise exception '342: a new account''s starter pipeline still has a Won or Lost stage'; end if;
  v_p := public.crm_seed_pipeline(v_t, 'outreach');
  select count(*) into v_n from public.crm_pipeline_stages where pipeline_id = v_p;
  if v_n <> 7 then raise exception '342: the outreach starter seeded % stages, not 7', v_n; end if;

  select id into v_first from public.crm_statuses where client_id = v_t and archived_at is null order by position limit 1;
  select id into v_made  from public.crm_statuses where client_id = v_t and trigger_event = 'contact_made';
  select id into v_inv   from public.crm_statuses where client_id = v_t and trigger_event = 'invoiced';
  if v_made is null then raise exception '342: a new account has no Contact Made status'; end if;
  if (select name from public.crm_statuses where id = v_made) <> 'Contact Made' then
    raise exception '342: the contact_made status is not called Contact Made';
  end if;

  v_r := public.crm_create_lead(v_t, 'Pat Rehearsal', 'Rehearsal Barns', '(555) 010-3036', 'pat342@example.invalid', null, null, 'manual', v_s1);
  v_d := (v_r->>'dealId')::uuid;
  select contact_id into v_c from public.crm_deals where id = v_d;
  if v_d is null or v_c is null then raise exception '342: create_lead made no deal'; end if;

  -- A move is a stage move and nothing else, and needs no lost reason.
  perform public.crm_move_deal(v_t, v_d, v_s2, null, null);
  if (select won_at is not null or lost_at is not null or lost_reason is not null from public.crm_deals where id = v_d) then
    raise exception '342: a stage move wrote an outcome onto the card';
  end if;

  -- Marked lost WHERE IT STANDS, reason required, idempotent, and reopening puts it back.
  begin
    perform public.crm_set_deal_lost(v_t, v_d, null, '   ');
    raise exception '342: a card was marked lost with no reason';
  exception when check_violation then null;
  end;
  v_r := public.crm_set_deal_lost(v_t, v_d, null, 'Price');
  if (v_r->>'lost') <> 'true' then raise exception '342: marking a card lost did not take'; end if;
  select stage_id into v_got from public.crm_deals where id = v_d;
  if v_got <> v_s2 then raise exception '342: marking a card lost MOVED it'; end if;
  if (select lost_reason from public.crm_deals where id = v_d) <> 'Price' then
    raise exception '342: the lost reason was not kept';
  end if;
  if ((public.crm_set_deal_lost(v_t, v_d, null, 'Timing'))->>'lost') <> 'false' then
    raise exception '342: a card already lost was marked lost again';
  end if;
  if (select lost_reason from public.crm_deals where id = v_d) <> 'Price' then
    raise exception '342: marking an already-lost card again changed its reason';
  end if;
  -- A stage move does not quietly reopen it.
  perform public.crm_move_deal(v_t, v_d, v_s1, null, null);
  if (select lost_at is null from public.crm_deals where id = v_d) then
    raise exception '342: moving a lost card reopened it';
  end if;
  v_r := public.crm_clear_deal_lost(v_t, v_d, null);
  if (v_r->>'reopened') <> 'true' then raise exception '342: reopening a card answered no'; end if;
  if (select lost_at is not null or lost_reason is not null from public.crm_deals where id = v_d) then
    raise exception '342: reopening a card did not clear the lost flag';
  end if;

  -- Reaching Invoiced is what marks a deal sold.
  if (select won_at is not null from public.crm_deals where id = v_d) then
    raise exception '342: the card was already sold';
  end if;
  perform public.crm_set_deal_status(v_t, v_d, v_inv, null, true);
  select won_at into v_won from public.crm_deals where id = v_d;
  if v_won is null then raise exception '342: reaching Invoiced did not mark the deal sold'; end if;
  perform public.crm_set_deal_status(v_t, v_d, (select id from public.crm_statuses where client_id = v_t and trigger_event = 'delivered'), null, true);
  if (select won_at from public.crm_deals where id = v_d) <> v_won then
    raise exception '342: a later status changed when the deal was sold';
  end if;

  -- CONTACT MADE: only from the first status, and only on real two-way activity.
  v_r := public.crm_create_lead(v_t, 'Dale Rehearsal', null, '(555) 010-3037', 'dale342@example.invalid', null, null, 'manual', v_s1);
  v_d2 := (v_r->>'dealId')::uuid;
  select contact_id into v_c from public.crm_deals where id = v_d2;
  if (select status_id from public.crm_deals where id = v_d2) <> v_first then
    raise exception '342: a new card did not start on the first status';
  end if;

  -- a missed call is not contact
  insert into public.phone_calls (client_id, contact_id, direction, from_e164, to_e164, status, started_at)
  values (v_t, v_c, 'in', '+15550103037', '+15550100000', 'missed', now());
  if (select status_id from public.crm_deals where id = v_d2) <> v_first then
    raise exception '342: a missed call moved the card';
  end if;
  -- one outbound text nobody answered is not contact
  insert into public.sms_messages (client_id, contact_id, direction, from_number, to_number, body, status)
  values (v_t, v_c, 'out', '+15550100000', '+15550103037', 'hello?', 'sent');
  if (select status_id from public.crm_deals where id = v_d2) <> v_first then
    raise exception '342: a single outbound text moved the card';
  end if;
  -- they answer: that is contact
  insert into public.sms_messages (client_id, contact_id, direction, from_number, to_number, body, status)
  values (v_t, v_c, 'in', '+15550103037', '+15550100000', 'yes hi', 'received');
  if (select status_id from public.crm_deals where id = v_d2) <> v_made then
    raise exception '342: a two-way text thread did not move the card to Contact Made';
  end if;
  if (select stage_id from public.crm_deals where id = v_d2) <> v_s1 then
    raise exception '342: Contact Made moved the card out of its stage';
  end if;
  -- and it never runs again from further up the ladder
  perform public.crm_set_deal_status(v_t, v_d2, v_inv, null, true);
  insert into public.phone_calls (client_id, contact_id, direction, from_e164, to_e164, status, started_at, answered_at, duration_s)
  values (v_t, v_c, 'out', '+15550100000', '+15550103037', 'completed', now(), now(), 95);
  if (select status_id from public.crm_deals where id = v_d2) <> v_inv then
    raise exception '342: an answered call pulled a card back from Invoiced to Contact Made';
  end if;
  -- an answered call on a fresh first-status card does move it
  v_r := public.crm_create_lead(v_t, 'Robin Rehearsal', null, '(555) 010-3038', 'robin342@example.invalid', null, null, 'manual', v_s1);
  v_d := (v_r->>'dealId')::uuid;
  select contact_id into v_c from public.crm_deals where id = v_d;
  insert into public.phone_calls (client_id, contact_id, direction, from_e164, to_e164, status, started_at, answered_at, duration_s)
  values (v_t, v_c, 'in', '+15550103038', '+15550100000', 'completed', now(), now(), 40);
  if (select status_id from public.crm_deals where id = v_d) <> v_made then
    raise exception '342: an answered call did not move a New Lead card to Contact Made';
  end if;

  -- and no live stage can mean won or lost any more
  begin
    update public.crm_pipeline_stages set kind = 'lost' where id = v_s2;
    raise exception '342: a live stage took kind = lost';
  exception when check_violation then null;
  end;

  -- Clean the rehearsal away (the pipeline's cascade takes its stages, deals and history).
  delete from public.phone_calls  where client_id = v_t;
  delete from public.sms_messages where client_id = v_t;
  delete from public.crm_pipelines where client_id = v_t;
  delete from public.crm_statuses where client_id = v_t;
  delete from public.crm_contacts where client_id = v_t;
  if exists (select 1 from public.crm_deals where client_id = v_t) then raise exception '342: rehearsal left cards'; end if;
end;
$chk$;

-- What the apply shows.
select '342' as migration,
       (select count(*) from public.crm_pipeline_stages where kind in ('won', 'lost') and archived_at is not null) as stages_retired,
       (select count(*) from public.crm_pipeline_stages where archived_at is null and kind <> 'open') as live_outcome_stages,
       (select count(*) from public.crm_statuses where trigger_event = 'contact_made' and archived_at is null) as contact_made_statuses,
       (select count(*) from public.crm_statuses where btrim(name) = 'Appt Set' and archived_at is null) as appt_set_left,
       (select count(*) from public.crm_deals where lost_at is not null and archived_at is null) as cards_marked_lost,
       (select count(*) from public.crm_deals where won_at is not null and archived_at is null) as cards_sold;

commit;
