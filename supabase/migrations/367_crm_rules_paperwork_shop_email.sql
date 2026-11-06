-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 367 — AUTOMATIONS, ROUND 3a: the paperwork, the shop and the email facts
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Ledger read before writing: max = 366 (366_crm_contact_do_not_disturb). So 367. Read the ledger
-- AGAIN immediately before applying: 363 had to be renumbered once because two agents shared one.
--
-- ── WHY (Carolyn, 2026-11-04 / -05) ──────────────────────────────────────────────────────
-- "LOTS and LOTS more availability in the automations." Round 3 of the plan she approved
-- (~/.claude/plans/ok-thanks-found-it-cuddly-newell.md): the facts the product records about a
-- sale after the estimate, and about email and the online shop, that no rule could wait for yet.
--
--   payment_received      a payment counts (card, cash, check; ACH once it clears, never while pending)
--   change_order_sent     a change order goes to the customer to sign
--   change_order_signed   they sign it (or the team records their verbal yes)
--   build_completed       their building's job reaches a Done stage on the build board
--   delivery_scheduled    their building is put on a delivery load (payload: the load date)
--   lot_sold              a building on the lot is sold to them
--   repair_requested      a repair is opened for them
--   repair_completed      their repair is marked completed
--   email_received        they email you
--   email_opened          they open an email you sent them
--   email_bounced         an email to them bounces
--   shop_request          they send a request from your online shop
--   shop_purchase         they buy from your online shop
--
-- "Delivered" was already a fact (the eighth status event) and is not repeated here.
--
-- ── HOW ──────────────────────────────────────────────────────────────────────────────────
-- Exactly 365's shape. Each table gets one AFTER trigger that never fails the write it rides on
-- and QUEUES the fact in crm_rule_events (crm_rule_enqueue); crm-rules-tick drains the queue. The
-- trigger asks crm_rule_wanted() FIRST, so an account with no rule waiting for that fact pays one
-- indexed lookup and nothing else — no subject lookups on every payment or every email.
--
-- WHO A FACT IS ABOUT: anything about a building is found through its design's short code — the
-- card that carries that code (crm_deals.short_code, the newest open one) and that card's customer;
-- with no card, the design's own customer (designs.contact_id). A repair with no design is matched
-- to a customer by its phone or email, and only when exactly ONE customer has it. Nobody matched
-- means nothing is queued: a rule never reaches a stranger.
--
-- ── THE TWO LOOPS THIS HAS TO STOP ───────────────────────────────────────────────────────
-- 1. "When they open an email, send them an email." Apple Mail opens every message the moment it
--    arrives, so that rule would send for ever. And "when an email bounces, email them" bounces
--    again. So the three email facts join 365's three phone facts as INBOUND: an "every time" rule
--    on them fires at most once per customer per local day (crm_rules_run, re-issued below with
--    that one list widened and nothing else changed).
-- 2. "When they email us, reply." Their out-of-office answers our reply. An incoming email within
--    five minutes of our own email to that customer is not queued at all (365 uses one minute for
--    texts; an auto-responder is slower than a phone).
--
-- An email the receiving side flagged (spam or virus FAIL / GRAY) is never queued: nothing in the
-- email pipeline proves a reply is really from the customer (_shared/emailInbound.ts), and a rule
-- that answers a forged one answers the real customer.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Additive. No rule waits for any of these facts yet, so every trigger returns after one lookup.
-- The live crm-rules-tick already drains the queue (365), so nothing else needs deploying for a
-- fact to fire; the portal and portal-settings learn the new names in the same change.
--
-- ── REVERSE (only if this has to be undone) ──────────────────────────────────────────────
--   -- delete rules whose trigger_event is one of the thirteen above; drop the nine triggers and
--   -- their functions (crm_rule_on_payment … crm_rule_on_shop), crm_rule_wanted,
--   -- crm_rule_subject, crm_rule_queue_for_code; restore 365's trigger_event CHECK; re-issue
--   -- 365's crm_rules_run.
-- ═════════════════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';

-- ── Before: crm_rules_run is 365's, not something changed since ──────────────────────────
do $pre$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'crm_rules_run';
  if v_src is null then
    raise exception '367: public.crm_rules_run is missing (migrations 363/365 not applied?)';
  end if;
  if position('p_trigger in (''text_received'', ''call_missed'', ''voicemail_left'')' in v_src) = 0
     and position('p_trigger in (''text_received'', ''call_missed'', ''voicemail_left'', ''email_received''' in v_src) = 0 then
    raise exception '367: crm_rules_run is not the 365 definition this file re-issues; read the live one before applying';
  end if;
end;
$pre$;

-- ── PART 1 — the vocabulary ──────────────────────────────────────────────────────────────
-- Mirrors RULE_EVENTS + RULE_CONTACT_EVENTS (_shared/crmRules.ts) and SS_RULE_CONTACT_EVENTS.
alter table public.crm_rules drop constraint if exists crm_rules_trigger_event_check;
alter table public.crm_rules add constraint crm_rules_trigger_event_check check (trigger_event is null or trigger_event in (
  'design_submitted', 'estimate_sent', 'estimate_accepted', 'invoiced', 'paid_in_full', 'build_scheduled', 'delivered', 'contact_made',
  'contact_created', 'label_added', 'form_submitted',
  'call_missed', 'voicemail_left', 'text_received',
  'meeting_booked', 'meeting_cancelled', 'meeting_completed', 'meeting_no_show',
  'stage_changed', 'deal_lost', 'deal_reopened',
  -- 367
  'payment_received', 'change_order_sent', 'change_order_signed', 'build_completed', 'delivery_scheduled',
  'lot_sold', 'repair_requested', 'repair_completed',
  'email_received', 'email_opened', 'email_bounced', 'shop_request', 'shop_purchase'));

-- ── PART 2 — three helpers ───────────────────────────────────────────────────────────────

-- Is any live rule on this account waiting for this fact? The cheap question every trigger asks
-- before it looks anything else up (the same test crm_rule_enqueue makes before it stores a row).
create or replace function public.crm_rule_wanted(p_client text, p_event text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $fn$
  select p_client is not null and exists (
    select 1 from public.crm_rules
     where client_id = p_client and archived_at is null and enabled
       and trigger_kind = 'event' and trigger_event = p_event);
$fn$;

-- Who a design's fact is about: the newest open card carrying that code and its customer, else the
-- design's own customer. Both null when the code reaches nobody (a lot building nobody bought).
create or replace function public.crm_rule_subject(p_client text, p_code text, out deal_id uuid, out contact_id uuid)
language plpgsql
stable
security definer
set search_path to ''
as $fn$
begin
  if p_client is null or nullif(btrim(coalesce(p_code, '')), '') is null then return; end if;
  select d.id, d.contact_id into deal_id, contact_id from public.crm_deals d
   where d.client_id = p_client and d.short_code = p_code and d.archived_at is null
   order by d.created_at desc limit 1;
  if deal_id is null then
    select g.contact_id into contact_id from public.designs g
     where g.client_id = p_client and g.short_code = p_code and g.contact_id is not null
     limit 1;
    if contact_id is not null and exists (select 1 from public.crm_contacts c
                                            where c.id = contact_id and c.merged_into is not null) then
      contact_id := null;
    end if;
  end if;
end;
$fn$;

-- Queue a design's fact for whoever it is about. Never raises.
create or replace function public.crm_rule_queue_for_code(p_client text, p_event text, p_code text, p_payload jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare s record;
begin
  if not public.crm_rule_wanted(p_client, p_event) then return; end if;
  select * into s from public.crm_rule_subject(p_client, p_code);
  if s.deal_id is not null or s.contact_id is not null then
    perform public.crm_rule_enqueue(p_client, p_event, s.contact_id, s.deal_id,
      coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('short_code', p_code));
  end if;
exception when others then null;
end;
$fn$;

-- ── PART 3 — the triggers that fill the queue ───────────────────────────────────────────

-- A payment COUNTS: not voided, and cleared. A card, cash or check payment counts the moment it is
-- recorded; an ACH payment counts when it settles, never while it is pending (309's rule for
-- "paid in full"), so a returned ACH never thanked anybody.
create or replace function public.crm_rule_on_payment()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare v_code text;
begin
  if new.voided_at is null and new.funding_state = 'settled'
     and (tg_op = 'INSERT' or old.voided_at is not null or old.funding_state is distinct from 'settled')
     and public.crm_rule_wanted(new.client_id, 'payment_received') then
    select o.short_code into v_code from public.orders o where o.id = new.order_id and o.client_id = new.client_id;
    perform public.crm_rule_queue_for_code(new.client_id, 'payment_received', v_code,
      jsonb_build_object('amount_cents', new.amount_cents, 'method', new.method));
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_payment on public.payments;
create trigger crm_rule_on_payment after insert or update of funding_state, voided_at on public.payments
  for each row execute function public.crm_rule_on_payment();

-- A change order sent to sign, and signed (by signature, or the team recording a verbal yes).
create or replace function public.crm_rule_on_change_order()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare v_ev text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return null; end if;
  v_ev := case new.status when 'pending_ack' then 'change_order_sent' when 'acknowledged' then 'change_order_signed' end;
  if v_ev is not null then
    perform public.crm_rule_queue_for_code(new.client_id, v_ev, new.short_code, jsonb_build_object('co_no', new.co_no));
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_change_order on public.change_orders;
create trigger crm_rule_on_change_order after insert or update of status on public.change_orders
  for each row execute function public.crm_rule_on_change_order();

-- Their building is finished: the build job reaches a Done stage (portal-schedule stamps
-- completed_at exactly then, and clears it if the job moves back). A repair's own job is a repair
-- fact, not a building, and a spec build for the lot has no customer to find.
create or replace function public.crm_rule_on_build()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if new.completed_at is not null and new.repair_id is null and new.design_short_code is not null
     and (tg_op = 'INSERT' or old.completed_at is null) then
    perform public.crm_rule_queue_for_code(new.client_id, 'build_completed', new.design_short_code, '{}'::jsonb);
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_build on public.build_jobs;
create trigger crm_rule_on_build after insert or update of completed_at on public.build_jobs
  for each row execute function public.crm_rule_on_build();

-- A delivery scheduled: the building is put on a load (or moved to another one). A lot sale's stop
-- may carry the unit's own spec design, so when that reaches nobody the buyer's design is tried.
-- Changing the date of a load already scheduled is not a new fact (the stop does not change).
create or replace function public.crm_rule_on_delivery_stop()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare v_date date; v_code text; s record;
begin
  if new.load_id is null or new.repair_id is not null then return null; end if;
  if tg_op = 'UPDATE' and new.load_id is not distinct from old.load_id then return null; end if;
  if not public.crm_rule_wanted(new.client_id, 'delivery_scheduled') then return null; end if;
  select l.load_date into v_date from public.delivery_loads l where l.id = new.load_id;
  v_code := new.design_short_code;
  select * into s from public.crm_rule_subject(new.client_id, v_code);
  if s.deal_id is null and s.contact_id is null and new.inventory_unit_id is not null then
    select u.sold_design_short_code into v_code from public.inventory_units u
     where u.id = new.inventory_unit_id and u.client_id = new.client_id;
  end if;
  perform public.crm_rule_queue_for_code(new.client_id, 'delivery_scheduled', v_code,
    jsonb_build_object('load_date', v_date));
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_delivery_stop on public.delivery_stops;
create trigger crm_rule_on_delivery_stop after insert or update of load_id on public.delivery_stops
  for each row execute function public.crm_rule_on_delivery_stop();

-- A building on the lot is sold: the unit goes unsold → sold, carrying the buyer's design.
create or replace function public.crm_rule_on_lot_sale()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if new.sale_state = 'sold' and old.sale_state is distinct from 'sold' then
    perform public.crm_rule_queue_for_code(new.client_id, 'lot_sold', new.sold_design_short_code,
      jsonb_build_object('serial', new.serial));
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_lot_sale on public.inventory_units;
create trigger crm_rule_on_lot_sale after update of sale_state on public.inventory_units
  for each row execute function public.crm_rule_on_lot_sale();

-- A repair opened, and completed. Its customer: the design it is for, else its order's design,
-- else the ONE customer with its phone or email (two customers sharing a number reach nobody).
create or replace function public.crm_rule_on_repair()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare v_ev text; v_code text; v_digits text; v_email text; v_contact uuid; v_n integer; s record;
begin
  if tg_op = 'INSERT' then
    v_ev := case when new.status = 'completed' then 'repair_completed' else 'repair_requested' end;
  elsif new.status = 'completed' and old.status is distinct from 'completed' then
    v_ev := 'repair_completed';
  end if;
  if v_ev is null or not public.crm_rule_wanted(new.client_id, v_ev) then return null; end if;

  v_code := new.design_short_code;
  if v_code is null and new.order_id is not null then
    select o.short_code into v_code from public.orders o where o.id = new.order_id and o.client_id = new.client_id;
  end if;
  select * into s from public.crm_rule_subject(new.client_id, v_code);
  if s.deal_id is not null or s.contact_id is not null then
    perform public.crm_rule_enqueue(new.client_id, v_ev, s.contact_id, s.deal_id,
      jsonb_build_object('repair_no', new.repair_no, 'short_code', v_code));
    return null;
  end if;

  v_digits := right(regexp_replace(coalesce(new.phone, ''), '[^0-9]', '', 'g'), 10);
  v_email := lower(btrim(coalesce(new.email, '')));
  select count(*), min(c.id::text)::uuid into v_n, v_contact from public.crm_contacts c
   where c.client_id = new.client_id and c.merged_into is null
     and ((length(v_digits) = 10 and right(coalesce(c.phone_digits, ''), 10) = v_digits)
       or (v_email <> '' and c.email_lower = v_email));
  if v_n = 1 then
    perform public.crm_rule_enqueue(new.client_id, v_ev, v_contact, null, jsonb_build_object('repair_no', new.repair_no));
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_repair on public.repairs;
create trigger crm_rule_on_repair after insert or update of status on public.repairs
  for each row execute function public.crm_rule_on_repair();

-- They email you: a known customer, not flagged by the receiving side, and not within five minutes
-- of our own email to them (header, loop 2). A reply on a design's thread is a fact about that
-- design's card when the card is theirs.
create or replace function public.crm_rule_on_email_in()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare s record; v_deal uuid;
begin
  if new.contact_id is null or (tg_op = 'UPDATE' and old.contact_id is not null) then return null; end if;
  if lower(coalesce(new.spam_verdict, '')) ~ '(spam|virus)=(fail|gray|grey|processing_failed)' then return null; end if;
  if not public.crm_rule_wanted(new.client_id, 'email_received') then return null; end if;
  if exists (select 1 from public.email_sends e
              where e.client_id = new.client_id and e.contact_id = new.contact_id
                and e.created_at > now() - interval '5 minutes') then
    return null;
  end if;
  if new.short_code is not null then
    select * into s from public.crm_rule_subject(new.client_id, new.short_code);
    if s.contact_id = new.contact_id then v_deal := s.deal_id; end if;
  end if;
  perform public.crm_rule_enqueue(new.client_id, 'email_received', new.contact_id, v_deal, '{}'::jsonb);
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_email_in on public.email_inbound;
create trigger crm_rule_on_email_in after insert or update of contact_id on public.email_inbound
  for each row execute function public.crm_rule_on_email_in();

-- An email we sent is opened, or bounces (262 stamps opened_at / bounced_at once, the first time
-- each is seen). Test sends are nobody's. Without a customer on the send, its design decides.
create or replace function public.crm_rule_on_email_sent()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare v_ev text; s record; v_contact uuid := new.contact_id; v_deal uuid;
begin
  if new.kind = 'test' then return null; end if;
  if new.bounced_at is not null and old.bounced_at is null then
    v_ev := 'email_bounced';
  elsif new.opened_at is not null and old.opened_at is null then
    v_ev := 'email_opened';
  end if;
  if v_ev is null or not public.crm_rule_wanted(new.client_id, v_ev) then return null; end if;
  if new.short_code is not null then
    select * into s from public.crm_rule_subject(new.client_id, new.short_code);
    if v_contact is null or s.contact_id = v_contact then
      v_deal := s.deal_id;
      v_contact := coalesce(v_contact, s.contact_id);
    end if;
  end if;
  if v_contact is not null or v_deal is not null then
    perform public.crm_rule_enqueue(new.client_id, v_ev, v_contact, v_deal, jsonb_build_object('kind', new.kind));
  end if;
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_email_sent on public.email_sends;
create trigger crm_rule_on_email_sent after update of opened_at, bounced_at on public.email_sends
  for each row execute function public.crm_rule_on_email_sent();

-- The online shop: a request, or a purchase, once it has a customer.
create or replace function public.crm_rule_on_shop()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare v_ev text;
begin
  if new.contact_id is null or (tg_op = 'UPDATE' and old.contact_id is not null) then return null; end if;
  v_ev := case when new.kind = 'purchase' then 'shop_purchase' else 'shop_request' end;
  perform public.crm_rule_enqueue(new.client_id, v_ev, new.contact_id, null,
    jsonb_build_object('kind', new.kind, 'total_cents', new.total_cents));
  return null;
exception when others then return null;
end;
$fn$;
drop trigger if exists crm_rule_on_shop on public.shop_requests;
create trigger crm_rule_on_shop after insert or update of contact_id on public.shop_requests
  for each row execute function public.crm_rule_on_shop();

do $$
declare f text;
begin
  foreach f in array array['crm_rule_on_payment', 'crm_rule_on_change_order', 'crm_rule_on_build',
                           'crm_rule_on_delivery_stop', 'crm_rule_on_lot_sale', 'crm_rule_on_repair',
                           'crm_rule_on_email_in', 'crm_rule_on_email_sent', 'crm_rule_on_shop'] loop
    execute format('revoke execute on function public.%I() from public, anon, authenticated', f);
  end loop;
end;
$$;
revoke execute on function public.crm_rule_wanted(text, text) from public, anon, authenticated;
grant  execute on function public.crm_rule_wanted(text, text) to service_role;
revoke execute on function public.crm_rule_subject(text, text) from public, anon, authenticated;
grant  execute on function public.crm_rule_subject(text, text) to service_role;
revoke execute on function public.crm_rule_queue_for_code(text, text, text, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_rule_queue_for_code(text, text, text, jsonb) to service_role;

-- ── PART 4 — crm_rules_run: the three email facts are inbound too (header, loop 1) ───────
-- 365's definition, re-issued with ONE change: the once-a-day list gains email_received,
-- email_opened and email_bounced. Nothing else in it moved.
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
      -- Once a day, not every time, on the facts a customer can produce at will (365's three
      -- phone facts, and 367's three email facts: opens and bounces can loop on their own).
      v_occ := coalesce(p_occurrence, '');
      if v_occ = '' and not r.once_per_card and p_trigger in ('text_received', 'call_missed', 'voicemail_left',
                                                                  'email_received', 'email_opened', 'email_bounced') then
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

-- ── PART 5 — checks, on a made-up account, and ROLLED BACK whatever happens ──────────────
-- Every write below happens inside one sub-block that ends by raising 'm367-rollback', so the
-- rehearsal account, its payments, change orders, jobs, loads, repairs, emails and shop requests
-- vanish with it — nothing to clean up by hand, and nothing left behind if a check fails halfway.
do $chk$
declare
  v_t    text := 'm367-rehearsal-' || substr(md5(random()::text), 1, 8);
  v_code text := 'SS-M367' || upper(substr(md5(random()::text), 1, 5));
  v_fail text;
  v_ok   boolean := false;
  v_p1 uuid; v_s1 uuid; v_r jsonb; v_c1 uuid; v_c2 uuid; v_d1 uuid;
  v_o uuid; v_pay uuid; v_co uuid; v_q uuid; v_job uuid; v_load uuid; v_unit uuid;
  v_rep uuid; v_send uuid; v_send2 uuid; v_shop uuid;
  e text; x record; v_want integer;
  k_events text[] := array['payment_received', 'change_order_sent', 'change_order_signed', 'build_completed',
    'delivery_scheduled', 'lot_sold', 'repair_requested', 'repair_completed', 'email_received', 'email_opened',
    'email_bounced', 'shop_request', 'shop_purchase'];
begin
  begin
    perform public.crm_ensure_pipelines(v_t);
    select id into v_p1 from public.crm_pipelines where client_id = v_t and seed_kind = 'shed_deals';
    select id into v_s1 from public.crm_pipeline_stages where pipeline_id = v_p1 and archived_at is null order by position limit 1;
    v_r := public.crm_create_lead(v_t, 'Dee Rehearsal', null, '(555) 010-3671', 'dee367@example.invalid', null, null, 'manual', v_s1);
    select contact_id into v_c1 from public.crm_deals where id = (v_r ->> 'dealId')::uuid;
    -- Their design. Saving one with a customer may make its own card (302), carrying the code;
    -- otherwise the lead's card takes it (crm_deals_short_code_fkey needs the design first).
    insert into public.designs (short_code, client_id, bldg_w, bldg_h, contact_id) values (v_code, v_t, 10, 12, v_c1);
    select id into v_d1 from public.crm_deals where client_id = v_t and short_code = v_code;
    if v_d1 is null then
      v_d1 := (v_r ->> 'dealId')::uuid;
      update public.crm_deals set short_code = v_code where id = v_d1;
    end if;
    -- phone_digits is written by the app, not the database, so a row made here sets it itself.
    insert into public.crm_contacts (client_id, name, phone, phone_digits, source)
    values (v_t, 'Ed Rehearsal', '(555) 010-3672', '5550103672', 'manual') returning id into v_c2;
    insert into public.crm_contacts (client_id, name, email, source)
    values (v_t, 'Fay Rehearsal', 'fay367@example.invalid', 'manual');

    -- 1. NO RULE, NO QUEUE: an account with no automation stores nothing for these facts.
    -- A design may already have made its own order (designs_ensure_order_ins); use it if so.
    select id into v_o from public.orders where client_id = v_t and short_code = v_code;
    if v_o is null then
      insert into public.orders (client_id, short_code, total_cents) values (v_t, v_code, 100000) returning id into v_o;
    end if;
    insert into public.payments (client_id, order_id, amount_cents, method, funding_state) values (v_t, v_o, 100, 'cash', 'settled');
    if exists (select 1 from public.crm_rule_events where client_id = v_t) then
      v_fail := '367: a fact was queued on an account with no rule waiting for it'; raise exception 'm367-stop';
    end if;

    -- A rule waiting for every new fact, on customers, every time, adding a note.
    foreach e in array k_events loop
      insert into public.crm_rules (client_id, scope_kind, trigger_kind, trigger_event, once_per_card, name)
      values (v_t, 'contacts', 'event', e, false, '367 ' || e) returning id into v_q;
      insert into public.crm_rule_actions (client_id, rule_id, kind, params)
      values (v_t, v_q, 'add_note', jsonb_build_object('body', '367 ' || e));
    end loop;

    -- 2. PAYMENTS: a card payment counts at once; an ACH payment only when it settles.
    insert into public.payments (client_id, order_id, amount_cents, method, funding_state) values (v_t, v_o, 200, 'card', 'settled');
    insert into public.payments (client_id, order_id, amount_cents, method, funding_state)
    values (v_t, v_o, 300, 'ach', 'pending') returning id into v_pay;
    if (select count(*) from public.crm_rule_events where client_id = v_t and event = 'payment_received') <> 1 then
      v_fail := '367: a pending ACH payment counted, or a card payment did not'; raise exception 'm367-stop';
    end if;
    update public.payments set funding_state = 'settled' where id = v_pay;

    -- 3. CHANGE ORDERS: a draft is nothing; sent; signed (a verbal yes recorded by the team).
    insert into public.change_orders (client_id, short_code, order_id, source, description, status)
    values (v_t, v_code, v_o, 'manual', '367 check', 'draft') returning id into v_co;
    if exists (select 1 from public.crm_rule_events where client_id = v_t and event like 'change_order%') then
      v_fail := '367: a draft change order was a fact'; raise exception 'm367-stop';
    end if;
    update public.change_orders set status = 'pending_ack' where id = v_co;
    update public.change_orders set status = 'acknowledged', ack_method = 'verbal', verbal_rep_name = 'Rehearsal',
           verbal_conversation_date = current_date, acknowledged_at = now() where id = v_co;

    -- 4. THE BUILD: a job reaching a Done stage.
    insert into public.schedule_stages (client_id, name, kind) values (v_t, 'Queue', 'queue') returning id into v_q;
    insert into public.build_jobs (client_id, stage_id, source, design_short_code)
    values (v_t, v_q, 'order', v_code) returning id into v_job;
    if exists (select 1 from public.crm_rule_events where client_id = v_t and event = 'build_completed') then
      v_fail := '367: a build job was finished before it was'; raise exception 'm367-stop';
    end if;
    update public.build_jobs set completed_at = now() where id = v_job;

    -- 5. DELIVERY + 6. LOT SALE: a stop for the customer's design; and a lot building's stop, whose
    --    own spec design reaches nobody, finds its buyer through the unit.
    insert into public.delivery_loads (client_id, load_date) values (v_t, current_date + 3) returning id into v_load;
    insert into public.delivery_stops (client_id, load_id, source, design_short_code) values (v_t, v_load, 'order', v_code);
    insert into public.inventory_units (client_id, serial, design_short_code)
    values (v_t, 990367, 'SS-M367SPEC1') returning id into v_unit;
    update public.inventory_units set sale_state = 'sold', sold_design_short_code = v_code, sold_at = now() where id = v_unit;
    insert into public.delivery_stops (client_id, load_id, source, design_short_code, inventory_unit_id)
    values (v_t, v_load, 'inventory', 'SS-M367SPEC1', v_unit);

    -- 7. REPAIRS: through the design; through the ONE customer with that phone; and a repair whose
    --    phone and email belong to two different customers reaches nobody.
    insert into public.repairs (client_id, customer_name, description, design_short_code)
    values (v_t, 'Dee', '367 check', v_code) returning id into v_rep;
    update public.repairs set status = 'completed', completed_at = now() where id = v_rep;
    insert into public.repairs (client_id, customer_name, description, phone) values (v_t, 'Ed', '367 check', '555.010.3672');
    insert into public.repairs (client_id, customer_name, description, phone, email)
    values (v_t, 'Ed or Fay', '367 check', '5550103672', 'fay367@example.invalid');

    -- 8. EMAIL IN: theirs queues; a flagged one does not; one within five minutes of ours does not.
    insert into public.email_inbound (client_id, from_email, contact_id, spam_verdict)
    values (v_t, 'dee367@example.invalid', v_c1, 'spam=PASS virus=PASS spf=pass');
    insert into public.email_inbound (client_id, from_email, contact_id, spam_verdict)
    values (v_t, 'dee367@example.invalid', v_c1, 'spam=FAIL virus=PASS');
    insert into public.email_sends (client_id, kind, to_email, from_email, contact_id, status)
    values (v_t, 'conversation', 'dee367@example.invalid', 'team@example.invalid', v_c1, 'sent') returning id into v_send;
    insert into public.email_inbound (client_id, from_email, contact_id) values (v_t, 'dee367@example.invalid', v_c1);

    -- 9. OPENED (once, however many times the receipt arrives), BOUNCED; a test send is nobody's.
    update public.email_sends set opened_at = now(), open_count = 1 where id = v_send;
    update public.email_sends set open_count = 2 where id = v_send;
    update public.email_sends set bounced_at = now(), status = 'bounced' where id = v_send;
    insert into public.email_sends (client_id, kind, to_email, from_email, contact_id, status)
    values (v_t, 'test', 'dee367@example.invalid', 'team@example.invalid', v_c1, 'sent') returning id into v_send2;
    update public.email_sends set opened_at = now() where id = v_send2;

    -- 10. THE SHOP: a request; a purchase that has no customer yet is a fact only once it gets one.
    insert into public.shop_requests (client_id, name, phone, kind, contact_id) values (v_t, 'Dee', '5550103671', 'request', v_c1);
    insert into public.shop_requests (client_id, name, phone, kind) values (v_t, 'Dee', '5550103671', 'purchase') returning id into v_shop;
    if exists (select 1 from public.crm_rule_events where client_id = v_t and event = 'shop_purchase') then
      v_fail := '367: a shop purchase with no customer was queued'; raise exception 'm367-stop';
    end if;
    update public.shop_requests set contact_id = v_c1 where id = v_shop;

    -- THE TALLY: how many times each fact was queued, and about whom.
    for x in select * from (values
        ('payment_received', 2, 'card'), ('change_order_sent', 1, 'card'), ('change_order_signed', 1, 'card'),
        ('build_completed', 1, 'card'), ('delivery_scheduled', 2, 'card'), ('lot_sold', 1, 'card'),
        ('repair_requested', 2, 'mixed'), ('repair_completed', 1, 'card'),
        ('email_received', 1, 'customer'), ('email_opened', 1, 'customer'), ('email_bounced', 1, 'customer'),
        ('shop_request', 1, 'customer'), ('shop_purchase', 1, 'customer')) t(ev, n, who)
    loop
      if (select count(*) from public.crm_rule_events where client_id = v_t and event = x.ev) <> x.n then
        v_fail := format('367: %s was queued %s time(s), expected %s', x.ev,
          (select count(*) from public.crm_rule_events where client_id = v_t and event = x.ev), x.n);
        raise exception 'm367-stop';
      end if;
      if x.who = 'card' and exists (select 1 from public.crm_rule_events where client_id = v_t and event = x.ev
                                       and (deal_id is distinct from v_d1 or contact_id is distinct from v_c1)) then
        v_fail := format('367: %s was not about the card that carries the design', x.ev); raise exception 'm367-stop';
      end if;
      if x.who = 'customer' and exists (select 1 from public.crm_rule_events where client_id = v_t and event = x.ev
                                           and (contact_id is distinct from v_c1 or deal_id is not null)) then
        v_fail := format('367: %s was not about the customer', x.ev); raise exception 'm367-stop';
      end if;
    end loop;
    if not exists (select 1 from public.crm_rule_events where client_id = v_t and event = 'repair_requested'
                    and contact_id = v_c2 and deal_id is null) then
      v_fail := '367: a repair did not find the one customer with its phone'; raise exception 'm367-stop';
    end if;
    if (select payload ->> 'load_date' from public.crm_rule_events where client_id = v_t and event = 'delivery_scheduled' limit 1)
       is distinct from (current_date + 3)::text then
      v_fail := '367: a scheduled delivery did not carry its load date'; raise exception 'm367-stop';
    end if;

    -- A second open, of another email, the same day: queued, but the rule fires once a day.
    insert into public.email_sends (client_id, kind, to_email, from_email, contact_id, status)
    values (v_t, 'conversation', 'dee367@example.invalid', 'team@example.invalid', v_c1, 'sent') returning id into v_send2;
    update public.email_sends set opened_at = now() where id = v_send2;

    -- 11. THE DRAIN: every fact fires its rule; the email ones once a day; nothing fails.
    perform public.crm_rules_drain_events(1000);
    if exists (select 1 from public.crm_rule_events where client_id = v_t and processed_at is null) then
      v_fail := '367: the drain left facts in the queue'; raise exception 'm367-stop';
    end if;
    for x in select r.trigger_event ev,
                    count(*) filter (where u.outcome = 'done') done,
                    count(*) filter (where u.outcome = 'failed') failed
               from public.crm_rules r left join public.crm_rule_runs u on u.rule_id = r.id
              where r.client_id = v_t group by r.trigger_event
    loop
      if x.failed > 0 then
        v_fail := format('367: the %s rule failed', x.ev); raise exception 'm367-stop';
      end if;
      v_want := case when x.ev in ('payment_received', 'delivery_scheduled', 'repair_requested') then 2 else 1 end;
      if x.done <> v_want then
        v_fail := format('367: the %s rule ran %s time(s)', x.ev, x.done); raise exception 'm367-stop';
      end if;
    end loop;
    if (select count(*) from public.crm_notes where client_id = v_t and body like '367 %') <> 16 then
      v_fail := format('367: the rules wrote %s notes, expected 16',
                       (select count(*) from public.crm_notes where client_id = v_t and body like '367 %'));
      raise exception 'm367-stop';
    end if;

    -- 12. Every new function is closed to the browser.
    if has_function_privilege('anon', 'public.crm_rule_subject(text, text)', 'execute')
       or has_function_privilege('authenticated', 'public.crm_rule_queue_for_code(text, text, text, jsonb)', 'execute')
       or has_function_privilege('authenticated', 'public.crm_rule_wanted(text, text)', 'execute') then
      v_fail := '367: a rule helper is callable from the browser'; raise exception 'm367-stop';
    end if;

    raise exception 'm367-rollback';
  exception when others then
    if sqlerrm = 'm367-rollback' then
      v_ok := true;
    elsif sqlerrm <> 'm367-stop' then
      v_fail := coalesce(v_fail, '367: a check crashed: ' || sqlerrm || ' (' || sqlstate || ')');
    end if;
  end;
  if v_fail is not null then raise exception '%', v_fail; end if;
  if not v_ok then raise exception '367: the checks did not finish'; end if;
  if exists (select 1 from public.crm_contacts where client_id = v_t)
     or exists (select 1 from public.crm_rules where client_id = v_t) then
    raise exception '367: the rehearsal account outlived its roll back';
  end if;
  raise notice '367 checks: OK';
end;
$chk$;
