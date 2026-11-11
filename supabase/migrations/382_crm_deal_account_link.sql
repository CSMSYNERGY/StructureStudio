begin;
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 382 — A BUILDERS-PIPELINE CARD KNOWS THE ACCOUNT IT PRODUCED
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('382', '382_crm_deal_account_link') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. To rehearse and change nothing, swap the last `commit;`
--    for `rollback;`.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger and the beta folder both read 381 on 2026-11-10 (374-381 landed while this was written;
-- it was first drafted as 371). Re-read BOTH right before applying.
--
-- ── WHY (Carolyn, 2026-11-10) ────────────────────────────────────────────────────────────
--   "In the builders list when a builder gets an account with structure studio we need to be
--    able to mark/change their status... how will the deal know there is an account? TEXCO
--    Construction Group, LLC is a great example."
--   Our own Customer Hub (the internal account, client_settings.internal_account) has a Builders
--   pipeline (the 'outreach' starter) where every prospective builder is a card. When a prospect
--   buys, an operator creates their tenant in Admin → Builders. Until this file nothing connected
--   the two: TEXCO's card sat at "Demo Completed / New Lead" with no won date while the tenant
--   texco-construction had been paying and signing in for four days.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1  crm_deals.account_client_id → client_configs. One LIVE card per account (a partial
--           unique index): the card is the sale that produced the account. Four new facts join
--           the status CHECK and the rules CHECK: account_created, account_subscribed,
--           account_past_due, account_cancelled.
--   PART 2  crm_account_link / crm_account_unlink (the only writers of the column), the per-card
--           event resolver crm_account_event (the deal's OWN pipeline, like crm_design_event),
--           crm_account_billing_apply (the tenant's whole billing picture → one event), and the
--           trigger on billing_subscriptions that calls it. Every writer of billing_subscriptions
--           — checkout, the gateway webhook, admin set_billing, a cancel — is caught by the
--           trigger, so no edge function has to remember.
--   PART 3  the four statuses, seeded on the internal account's Builders pipeline ONLY, after
--           its existing rungs. Nobody else's pipelines change. The statuses are editable like
--           any other; automation keys on trigger_event, never the name.
--   PART 4  TEXCO: link the card to texco-construction, won on the day its subscriptions began.
--   PART 5  checks and a rehearsal on a made-up internal account, rolled back whatever happens.
--
-- ── THE RULES ────────────────────────────────────────────────────────────────────────────
--   * STAGES ARE UNTOUCHED. Carolyn, 2026-11-01: "I don't want any changes to my Builders
--     pipeline." The account life cycle rides the STATUS ladder, which is event-driven by design
--     (354: "internally you decide when the status changes").
--   * account_created stamps won_at when empty (the way `invoiced` does on the design ladder):
--     the sale is won when the account exists. account_cancelled is churn, NOT a lost sale: it
--     never touches lost_at.
--   * The billing picture is the TENANT'S, not one row's: any past_due row → Past Due; else any
--     active or paused row → Subscribed; else any cancelled row → Cancelled; no rows → nothing.
--     Statuses move both ways here (a recovered card goes Past Due → Subscribed), so these calls
--     are NOT forward-only.
--   * A rule event (crm_rule_enqueue) is queued only when the status actually changed, plus
--     always for account_created, so a second active subscription on an already-Subscribed
--     account does not fire "when they subscribe" again.
--   * NEVER FAILS THE WRITE IT RIDES ON (302:42-44, 355's rule): the trigger body is a sub-block
--     with its own handler that logs to app_errors and returns.
--   * Only the INTERNAL account may link: the column is refused on any other tenant's card, so a
--     builder's own Customer Hub can never point at a platform tenant.
--   * ONE live card per account. If an account is ever sold a second thing, that is a second
--     subscription on the same card (the Account panel lists them all), not a second link. Drop
--     crm_deals_account_once if that decision changes.
--
-- ── REVERSE (only if this has to be undone) ──────────────────────────────────────────────
--   drop trigger crm_account_on_billing on billing_subscriptions; drop the five functions; delete
--   the four statuses by trigger_event (cards wearing them fall back to NULL status: set status_id
--   null first); re-issue the two CHECKs from 354/367 without the four values; drop the column.

-- ── PART 1 — the column and the four facts ───────────────────────────────────────────────
alter table public.crm_deals add column if not exists account_client_id text
  references public.client_configs(client_id) on delete set null;
comment on column public.crm_deals.account_client_id is
  'The platform tenant this card produced (382). Internal account only; set by crm_account_link, cleared by crm_account_unlink or when the tenant is deleted. One live card per tenant.';
create unique index if not exists crm_deals_account_once
  on public.crm_deals (account_client_id) where account_client_id is not null and archived_at is null;
create index if not exists crm_deals_account_idx
  on public.crm_deals (client_id, account_client_id) where account_client_id is not null and archived_at is null;

alter table public.crm_statuses drop constraint if exists crm_statuses_trigger_event_check;
alter table public.crm_statuses add constraint crm_statuses_trigger_event_check
  check (trigger_event is null or trigger_event in (
    'design_submitted', 'estimate_sent', 'estimate_accepted', 'invoiced', 'paid_in_full', 'build_scheduled', 'delivered', 'contact_made',
    'account_created', 'account_subscribed', 'account_past_due', 'account_cancelled'));

-- 367's list (the live CHECK on 2026-11-10, read back before this was written) plus the four.
alter table public.crm_rules drop constraint if exists crm_rules_trigger_event_check;
alter table public.crm_rules add constraint crm_rules_trigger_event_check check (trigger_event is null or trigger_event in (
  'design_submitted', 'estimate_sent', 'estimate_accepted', 'invoiced', 'paid_in_full', 'build_scheduled', 'delivered', 'contact_made',
  'contact_created', 'label_added', 'form_submitted',
  'call_missed', 'voicemail_left', 'text_received',
  'meeting_booked', 'meeting_cancelled', 'meeting_completed', 'meeting_no_show',
  'stage_changed', 'deal_lost', 'deal_reopened',
  'payment_received', 'change_order_sent', 'change_order_signed', 'build_completed', 'delivery_scheduled', 'lot_sold',
  'repair_requested', 'repair_completed',
  'email_received', 'email_opened', 'email_bounced', 'shop_request', 'shop_purchase',
  'account_created', 'account_subscribed', 'account_past_due', 'account_cancelled'));

-- ── PART 2 — the functions ───────────────────────────────────────────────────────────────
-- One account fact onto every live card linked to that tenant, resolved in EACH CARD'S OWN
-- pipeline (crm_design_event's shape, 354). Returns how many cards changed status.
create or replace function public.crm_account_event(p_client text, p_event text)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare r record; v_status uuid; v_res jsonb; v_n integer := 0; v_changed boolean;
begin
  if coalesce(btrim(p_client), '') = '' then return 0; end if;
  for r in select d.id, d.client_id, d.pipeline_id, d.contact_id, d.won_at from public.crm_deals d
            where d.account_client_id = p_client and d.archived_at is null
  loop
    v_changed := false;
    select id into v_status from public.crm_statuses
     where client_id = r.client_id and pipeline_id = r.pipeline_id
       and trigger_event = p_event and archived_at is null;
    if v_status is not null then
      v_res := public.crm_set_deal_status(r.client_id, r.id, v_status, null, false);
      v_changed := coalesce((v_res ->> 'changed')::boolean, false);
      if v_changed then v_n := v_n + 1; end if;
    end if;
    if p_event = 'account_created' and r.won_at is null then
      update public.crm_deals set won_at = now(), updated_at = now() where id = r.id;
    end if;
    if v_changed or p_event = 'account_created' then
      perform public.crm_rule_enqueue(r.client_id, p_event, r.contact_id, r.id,
                                      jsonb_build_object('account', p_client));
    end if;
  end loop;
  return v_n;
end;
$fn$;
revoke execute on function public.crm_account_event(text, text) from public, anon, authenticated;
grant  execute on function public.crm_account_event(text, text) to service_role;

-- The tenant's WHOLE billing picture → one fact. Nothing to say when there are no rows.
create or replace function public.crm_account_billing_apply(p_client text)
returns text
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_event text;
begin
  if coalesce(btrim(p_client), '') = '' then return null; end if;
  if not exists (select 1 from public.crm_deals where account_client_id = p_client and archived_at is null) then
    return null;
  end if;
  select case
           when bool_or(status = 'past_due') then 'account_past_due'
           when bool_or(status in ('active', 'paused')) then 'account_subscribed'
           when bool_or(status = 'cancelled') then 'account_cancelled'
         end
    into v_event
    from public.billing_subscriptions where client_id = p_client;
  if v_event is null then return null; end if;
  perform public.crm_account_event(p_client, v_event);
  return v_event;
end;
$fn$;
revoke execute on function public.crm_account_billing_apply(text) from public, anon, authenticated;
grant  execute on function public.crm_account_billing_apply(text) to service_role;

-- LINK. The only writer of the column, with every refusal a sentence the console can show.
create or replace function public.crm_account_link(p_deal uuid, p_client text, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_deal public.crm_deals%rowtype; v_other uuid; v_billing text;
begin
  if p_deal is null or coalesce(btrim(p_client), '') = '' then
    raise exception 'A card and a builder are both needed.' using errcode = 'check_violation';
  end if;
  select * into v_deal from public.crm_deals where id = p_deal and archived_at is null for update;
  if not found then raise exception 'That card was not found.' using errcode = 'no_data_found'; end if;
  if not exists (select 1 from public.client_settings where client_id = v_deal.client_id and internal_account) then
    raise exception 'Only our own account''s cards can be linked to a builder.' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.client_configs where client_id = p_client) then
    raise exception 'There is no builder "%".', p_client using errcode = 'no_data_found';
  end if;
  if v_deal.account_client_id = p_client then
    return jsonb_build_object('changed', false, 'dealId', v_deal.id, 'clientId', p_client);
  end if;
  if v_deal.account_client_id is not null then
    raise exception 'This card is already linked to "%". Unlink it first.', v_deal.account_client_id using errcode = 'check_violation';
  end if;
  select id into v_other from public.crm_deals where account_client_id = p_client and archived_at is null limit 1;
  if v_other is not null then
    raise exception 'Builder "%" is already linked to another card.', p_client using errcode = 'check_violation';
  end if;
  update public.crm_deals set account_client_id = p_client, updated_at = now() where id = v_deal.id;
  perform public.crm_account_event(p_client, 'account_created');
  v_billing := public.crm_account_billing_apply(p_client);
  return jsonb_build_object('changed', true, 'dealId', v_deal.id, 'clientId', p_client, 'billing', v_billing);
end;
$fn$;
revoke execute on function public.crm_account_link(uuid, text, uuid) from public, anon, authenticated;
grant  execute on function public.crm_account_link(uuid, text, uuid) to service_role;

-- UNLINK. The card keeps its stage, its status and its won date: unlinking says "wrong builder",
-- not "the sale never happened". Returns the builder it was linked to, or null.
create or replace function public.crm_account_unlink(p_deal uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_was text;
begin
  select account_client_id into v_was from public.crm_deals where id = p_deal for update;
  if not found or v_was is null then
    return jsonb_build_object('changed', false, 'dealId', p_deal, 'was', null);
  end if;
  update public.crm_deals set account_client_id = null, updated_at = now() where id = p_deal;
  return jsonb_build_object('changed', true, 'dealId', p_deal, 'was', v_was);
end;
$fn$;
revoke execute on function public.crm_account_unlink(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.crm_account_unlink(uuid, uuid) to service_role;

-- The billing trigger. Every status write on billing_subscriptions re-reads the tenant's picture.
-- Cheap for the 99%: the first statement of crm_account_billing_apply is an indexed "is any card
-- linked to this tenant", and almost no tenant has one.
create or replace function public.crm_account_on_billing()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    perform public.crm_account_billing_apply(new.client_id);
  end if;
  return null;
exception when others then
  begin
    insert into public.app_errors (client_id, source, severity, code, message, context)
    values (new.client_id, 'db:crm_account_on_billing', 'error', 'crm_account_on_billing_failed',
            'crm_account_on_billing: ' || sqlerrm, jsonb_build_object('sqlstate', sqlstate, 'op', tg_op));
  exception when others then null;
  end;
  return null;
end;
$fn$;
drop trigger if exists crm_account_on_billing on public.billing_subscriptions;
create trigger crm_account_on_billing after insert or update of status on public.billing_subscriptions
  for each row execute function public.crm_account_on_billing();

-- The four rungs, after whatever a pipeline already has. Idempotent per pipeline (the per-pipeline
-- event index). Internal account only, by the caller's choice: PART 3 and the rehearsal.
create or replace function public.crm_account_seed_statuses(p_client text, p_pipeline uuid)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_pos double precision; v_n integer := 0; r record;
begin
  select coalesce(max(position), 0) into v_pos from public.crm_statuses
   where client_id = p_client and pipeline_id = p_pipeline and archived_at is null;
  for r in select * from (values
             ('Account Created', '#2563EB', 'account_created'),
             ('Subscribed',      '#059669', 'account_subscribed'),
             ('Past Due',        '#D97706', 'account_past_due'),
             ('Cancelled',       '#64748B', 'account_cancelled')) as t(name, color, ev)
  loop
    if not exists (select 1 from public.crm_statuses where client_id = p_client and pipeline_id = p_pipeline
                     and trigger_event = r.ev and archived_at is null) then
      v_pos := v_pos + 1024;
      insert into public.crm_statuses (client_id, pipeline_id, name, color, trigger_event, position)
      values (p_client, p_pipeline, r.name, r.color, r.ev, v_pos);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$fn$;
revoke execute on function public.crm_account_seed_statuses(text, uuid) from public, anon, authenticated;
grant  execute on function public.crm_account_seed_statuses(text, uuid) to service_role;

-- ── PART 3 — the internal account's Builders pipeline gets the four rungs ────────────────
do $seed$
declare r record; v_n integer; v_total integer := 0;
begin
  for r in select p.client_id, p.id from public.crm_pipelines p
            join public.client_settings s on s.client_id = p.client_id and s.internal_account
           where p.seed_kind = 'outreach' and p.archived_at is null
  loop
    v_n := public.crm_account_seed_statuses(r.client_id, r.id);
    v_total := v_total + v_n;
    raise notice '382: % statuses seeded on % pipeline %', v_n, r.client_id, r.id;
  end loop;
  raise notice '382: % statuses seeded in all', v_total;
end;
$seed$;

-- ── PART 4 — TEXCO ───────────────────────────────────────────────────────────────────────
-- The card Carolyn named (Joe Dalmolin, Builders pipeline, structure-studio) and the tenant made
-- for him on 2026-11-05/06. Guarded: both must exist, the card unlinked, the tenant unlinked.
-- won_at is the day the subscriptions were created, not today.
do $texco$
declare v_deal uuid := '485e4142-8cb0-4247-b062-d76d675aad7d'; v_client text := 'texco-construction'; v_res jsonb;
begin
  if exists (select 1 from public.crm_deals where id = v_deal and client_id = 'structure-studio' and archived_at is null and account_client_id is null)
     and exists (select 1 from public.client_configs where client_id = v_client)
     and not exists (select 1 from public.crm_deals where account_client_id = v_client and archived_at is null) then
    update public.crm_deals set won_at = coalesce(won_at, '2026-11-05 13:07:16+00'::timestamptz) where id = v_deal;
    v_res := public.crm_account_link(v_deal, v_client, null);
    raise notice '382: TEXCO linked: %', v_res;
  else
    raise notice '382: TEXCO backfill skipped (card or tenant missing, or already linked)';
  end if;
end;
$texco$;

-- ── PART 5 — checks, and a rehearsal rolled back whatever happens ────────────────────────
do $chk$
declare
  v_t text := 'm382-internal'; v_other text := 'm382-builder'; v_other2 text := 'm382-builder-2';
  v_p uuid; v_stage uuid; v_c uuid; v_d uuid; v_d2 uuid; v_res jsonb; v_n integer;
  v_fail text := null; v_ok boolean := false;
  st text;
begin
  -- Shapes that must hold after PART 1/2.
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'crm_deals' and column_name = 'account_client_id') then
    raise exception '382: crm_deals.account_client_id missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'crm_account_on_billing' and tgrelid = 'public.billing_subscriptions'::regclass) then
    raise exception '382: the billing trigger is missing';
  end if;
  if has_function_privilege('anon', 'public.crm_account_link(uuid, text, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.crm_account_link(uuid, text, uuid)', 'execute')
     or has_function_privilege('anon', 'public.crm_account_unlink(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.crm_account_event(text, text)', 'execute') then
    raise exception '382: an account function is callable from the browser';
  end if;

  begin
    -- A made-up internal account with the outreach starter, and two made-up builders.
    insert into public.client_configs (client_id, company_name) values (v_t, 'm382 internal'), (v_other, 'm382 builder'), (v_other2, 'm382 builder 2');
    insert into public.client_settings (client_id, internal_account) values (v_t, true);
    v_p := public.crm_seed_pipeline(v_t, 'outreach');
    v_n := public.crm_account_seed_statuses(v_t, v_p);
    if v_n <> 4 then v_fail := format('382: seeded %s statuses, expected 4', v_n); raise exception 'm382-stop'; end if;
    if public.crm_account_seed_statuses(v_t, v_p) <> 0 then v_fail := '382: seeding twice added rungs'; raise exception 'm382-stop'; end if;
    select id into v_stage from public.crm_pipeline_stages where pipeline_id = v_p and archived_at is null order by position limit 1;
    insert into public.crm_contacts (client_id, name, email, source) values (v_t, 'm382 Prospect', 'm382@example.invalid', 'manual') returning id into v_c;
    insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, source) values (v_t, v_p, v_stage, v_c, 'manual') returning id into v_d;
    insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, source) values (v_t, v_p, v_stage, v_c, 'manual') returning id into v_d2;

    -- 1. Link with no billing: Account Created, won.
    v_res := public.crm_account_link(v_d, v_other, null);
    select s.trigger_event into st from public.crm_deals d join public.crm_statuses s on s.id = d.status_id where d.id = v_d;
    if st is distinct from 'account_created' then v_fail := format('382: after link the card is %s, expected account_created', st); raise exception 'm382-stop'; end if;
    if (select won_at from public.crm_deals where id = v_d) is null then v_fail := '382: link did not stamp won_at'; raise exception 'm382-stop'; end if;
    if (select account_client_id from public.crm_deals where id = v_d) is distinct from v_other then v_fail := '382: link did not write the column'; raise exception 'm382-stop'; end if;

    -- 2. A second card cannot take the same builder; the linked card cannot take a second builder.
    begin
      perform public.crm_account_link(v_d2, v_other, null);
      v_fail := '382: a builder was linked to two cards'; raise exception 'm382-stop';
    exception when check_violation then null;
    end;
    begin
      perform public.crm_account_link(v_d, v_other2, null);
      v_fail := '382: a linked card took a second builder'; raise exception 'm382-stop';
    exception when check_violation then null;
    end;

    -- 3. Billing drives the status, both ways, through the trigger.
    insert into public.billing_subscriptions (id, client_id, plan_id, status) values ('m382-sub-1', v_other, (select id from public.billing_plans order by id limit 1), 'active');
    select s.trigger_event into st from public.crm_deals d join public.crm_statuses s on s.id = d.status_id where d.id = v_d;
    if st is distinct from 'account_subscribed' then v_fail := format('382: active subscription left the card %s', st); raise exception 'm382-stop'; end if;
    update public.billing_subscriptions set status = 'past_due' where id = 'm382-sub-1';
    select s.trigger_event into st from public.crm_deals d join public.crm_statuses s on s.id = d.status_id where d.id = v_d;
    if st is distinct from 'account_past_due' then v_fail := format('382: past_due left the card %s', st); raise exception 'm382-stop'; end if;
    update public.billing_subscriptions set status = 'active' where id = 'm382-sub-1';
    select s.trigger_event into st from public.crm_deals d join public.crm_statuses s on s.id = d.status_id where d.id = v_d;
    if st is distinct from 'account_subscribed' then v_fail := format('382: recovery left the card %s (statuses must move back)', st); raise exception 'm382-stop'; end if;
    -- a second, cancelled row changes nothing while one is active
    insert into public.billing_subscriptions (id, client_id, plan_id, status) values ('m382-sub-2', v_other, (select id from public.billing_plans order by id offset 1 limit 1), 'cancelled');
    select s.trigger_event into st from public.crm_deals d join public.crm_statuses s on s.id = d.status_id where d.id = v_d;
    if st is distinct from 'account_subscribed' then v_fail := format('382: one cancelled row beside an active one left the card %s', st); raise exception 'm382-stop'; end if;
    update public.billing_subscriptions set status = 'cancelled' where id = 'm382-sub-1';
    select s.trigger_event into st from public.crm_deals d join public.crm_statuses s on s.id = d.status_id where d.id = v_d;
    if st is distinct from 'account_cancelled' then v_fail := format('382: cancelling the last row left the card %s', st); raise exception 'm382-stop'; end if;
    if (select lost_at from public.crm_deals where id = v_d) is not null then v_fail := '382: cancelled set lost_at'; raise exception 'm382-stop'; end if;

    -- 4. Linking a card whose builder ALREADY has billing lands on the billing state, not on Created.
    insert into public.billing_subscriptions (id, client_id, plan_id, status) values ('m382-sub-3', v_other2, (select id from public.billing_plans order by id limit 1), 'active');
    v_res := public.crm_account_link(v_d2, v_other2, null);
    select s.trigger_event into st from public.crm_deals d join public.crm_statuses s on s.id = d.status_id where d.id = v_d2;
    if st is distinct from 'account_subscribed' then v_fail := format('382: linking a paying builder left the card %s', st); raise exception 'm382-stop'; end if;
    if (v_res ->> 'billing') is distinct from 'account_subscribed' then v_fail := '382: link did not report the billing state'; raise exception 'm382-stop'; end if;

    -- 5. Unlink clears the column and nothing else; a tenant deleted clears it too.
    v_res := public.crm_account_unlink(v_d, null);
    if (select account_client_id from public.crm_deals where id = v_d) is not null then v_fail := '382: unlink left the column'; raise exception 'm382-stop'; end if;
    if (select won_at from public.crm_deals where id = v_d) is null then v_fail := '382: unlink cleared won_at'; raise exception 'm382-stop'; end if;
    delete from public.billing_subscriptions where client_id = v_other2;
    delete from public.client_configs where client_id = v_other2;
    if (select account_client_id from public.crm_deals where id = v_d2) is not null then v_fail := '382: deleting the tenant left the link'; raise exception 'm382-stop'; end if;

    -- 6. Not for a builder's own Hub.
    update public.client_settings set internal_account = false where client_id = v_t;
    begin
      perform public.crm_account_link(v_d, v_other, null);
      v_fail := '382: a non-internal account linked a card'; raise exception 'm382-stop';
    exception when insufficient_privilege then null;
    end;

    raise exception 'm382-rollback';
  exception when others then
    if sqlerrm = 'm382-rollback' then
      v_ok := true;
    elsif sqlerrm <> 'm382-stop' then
      v_fail := coalesce(v_fail, '382: a check crashed: ' || sqlerrm || ' (' || sqlstate || ')');
    end if;
  end;
  if v_fail is not null then raise exception '%', v_fail; end if;
  if not v_ok then raise exception '382: the checks did not finish'; end if;
  if exists (select 1 from public.client_configs where client_id like 'm382-%')
     or exists (select 1 from public.crm_contacts where client_id = v_t)
     or exists (select 1 from public.billing_subscriptions where id like 'm382-%') then
    raise exception '382: the rehearsal account outlived its roll back';
  end if;
  raise notice '382 checks: OK';
end;
$chk$;

commit;
