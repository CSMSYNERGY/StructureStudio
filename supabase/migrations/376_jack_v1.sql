-- 376_jack_v1.sql -- the rest of Jack's version 1, on top of 375_jack_agent.sql (plan: the vault's
-- StructureStudio AI Agent Plan 2026-11-02, sections 5.3 to 5.7 and 9). Still DARK: nothing here turns
-- Jack on for anyone, and the jack_ai meter ships inactive, so every charge is a shadow until someone arms
-- it on purpose.
--
-- APPLY BY HAND, AFTER A HUMAN HAS READ IT, and only after 375. Re-read the ledger first and take the next
-- free number:
--     select max(version) from supabase_migrations.schema_migrations where version ~ '^\d{3}$';
--   Run this file as ONE statement batch (the Supabase connector's execute_sql, or stdin to
--   `supabase db query --linked`; NOT `--file`), then record it:
--     insert into supabase_migrations.schema_migrations (version, name) values ('376', '376_jack_v1') returning version;
--   Zero rows back from `returning` means the number was taken: renumber. NEVER `supabase db push`.
--
-- WHAT THIS ADDS
--   1. jack_memory: what a builder told Jack once (when a quote counts as quiet, and so on). Typed values
--      from a fixed catalogue in jack-agent/memory.ts. Service role only, like Jack's other tables.
--   2. jack_proposals.kind: the new kinds of card (memory questions, look-up lists, reply drafts, setup
--      changes, when/then rules). The status list is unchanged.
--   3. Billing: charge_state and charge_micros on Jack's messages and proposals, usage_prices.markup, and
--      the jack_ai meter (cost_plus, x1.5, INACTIVE). Arming later is one statement, by an operator:
--          update public.usage_prices set active = true where kind = 'jack_ai';
--      and setting it false again is the panic button.
--   4. Setup: setup_template_items.jack_key (which step is which, for Jack) and "done with Jack" on
--      tenant_setup_items (completed_via, completed_proposal_id), with a trigger that clears it on any
--      tick that doesn't set it.
--   5. Look-ups: crm_contact_touch_facts, when each side last spoke. Service role only.
--   6. jack_clear_old_private: clears look-up lists and drafts 30 days after they were made.

-- ── 1. What Jack remembers ───────────────────────────────────────────────────────────────────────────
create table if not exists public.jack_memory (
  client_id        text not null,
  key              text not null check (key ~ '^[a-z_]{3,40}$'),
  value            jsonb not null,
  set_by           uuid,
  set_by_operator  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (client_id, key)
);
alter table public.jack_memory enable row level security;
revoke all on public.jack_memory from public, anon, authenticated;
grant all on public.jack_memory to service_role;

-- ── 2. The kinds of card ─────────────────────────────────────────────────────────────────────────────
-- ONE list for every kind (jack-agent kinds_test.ts reads this file and checks it against the code).
alter table public.jack_proposals drop constraint if exists jack_proposals_kind_check;
alter table public.jack_proposals add constraint jack_proposals_kind_check check (kind in (
  -- 375: the sizes table and doors
  'price_sheet', 'size_rule', 'new_fixture',
  -- memory.ts: a question whose answer Jack keeps
  'memory',
  -- setup.ts
  'setup_company', 'setup_paperwork', 'setup_styles', 'setup_fixture', 'setup_locations', 'setup_tick', 'setup_guide',
  -- rules.ts: when/then rules for Carolyn's Automations
  'automation_rule', 'automation_pause',
  -- lookups.ts and drafts.ts: private to the asker and the Structure Studio team (jack-agent hiddenFrom)
  'lookup', 'reply_draft'
));
comment on table public.jack_proposals is
  'Jack''s cards. lookup rows hold customer names, towns, buildings and scrubbed words; reply_draft rows hold one customer''s first name, a deal label and the draft words. Both are private to the asker and the Structure Studio team (jack-agent hiddenFrom), and the tenant wipe removes them (tenantTables.ts). Service role only (375).';

-- ── 3. Billing ───────────────────────────────────────────────────────────────────────────────────────
alter table public.jack_messages
  add column if not exists charge_state text check (charge_state is null or charge_state in ('shadow', 'pending', 'charged', 'exempt', 'not_billable', 'failed')),
  add column if not exists charge_micros bigint check (charge_micros is null or charge_micros >= 0),
  add column if not exists wallet_tx_id bigint;
alter table public.jack_proposals
  add column if not exists charge_state text check (charge_state is null or charge_state in ('shadow', 'pending', 'charged', 'exempt', 'not_billable', 'failed')),
  add column if not exists charge_micros bigint check (charge_micros is null or charge_micros >= 0),
  add column if not exists wallet_tx_id bigint;
create index if not exists jack_messages_pending_idx on public.jack_messages (client_id, created_at) where charge_state = 'pending';
create index if not exists jack_proposals_pending_idx on public.jack_proposals (client_id, created_at) where charge_state = 'pending';

-- cost_plus has meant "cost x phone_billing_settings.markup" since 259. A meter can now carry its own
-- markup; null keeps the phone meaning for the phone meters.
alter table public.usage_prices
  add column if not exists markup numeric(6,3) check (markup is null or markup between 1.0 and 10.0);
comment on column public.usage_prices.markup is
  'Migration 376. For a cost_plus meter that is not a phone meter: charge = cost x this markup. Null on the phone meters, which use phone_billing_settings.markup.';

insert into public.usage_prices (kind, label, unit_label, price_cents, active, visible, sort_order, note, pricing, markup)
values ('jack_ai', 'Jack (AI agent)', 'answer', 0, false, true, 60,
        'Migration 376. Carolyn 11-04: $1.50 for every $1 of AI cost, after a $50 welcome credit. cost_plus at this row''s markup. price_cents is unused. Charged per answer and per price list read by jack-agent.', 'cost_plus', 1.500)
on conflict (kind) do nothing;

-- ── 3b. Billing: what cost_plus means now, and proof of the money rails ───────────────────────────
-- No new tables, functions or grants: Jack's money writes reuse wallet_usage_debit and wallet_credit,
-- which stay service-role only.
comment on column public.usage_prices.pricing is
  'Migrations 259, 376. fixed = price_cents per unit (every meter before 259). cost_plus = price_cents is unused; the charge is our cost times a markup: phone_billing_settings.markup for the call and text meters (phone-api Worker, cron/usageCharge.ts), or this row''s own usage_prices.markup when it is set (jack_ai: jack-agent/billing.ts, charged per answer and per price list read).';

comment on column public.jack_messages.charge_state is
  'Migration 376. How this answer was billed (jack-agent/billing.ts): not_billable | exempt | shadow | pending | charged | failed. pending with charge_micros null = never priced; pending with charge_micros set = sent once, replayed under jack:answer:<id> at that amount.';
comment on column public.jack_proposals.charge_state is
  'Migration 376. How this price list read was billed (jack-agent/billing.ts), under key jack:read:<id>. Same states as jack_messages.charge_state.';

do $billing_proof$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name in ('jack_messages', 'jack_proposals')
         and column_name in ('charge_state', 'charge_micros', 'wallet_tx_id')) <> 6 then
    raise exception '376: the Jack charge columns are missing';
  end if;
  begin
    update public.usage_prices set markup = 0.5 where kind = 'jack_ai';
    raise exception '376: usage_prices.markup took 0.5';
  exception when check_violation then null;
  end;
  begin
    update public.usage_prices set markup = 11 where kind = 'jack_ai';
    raise exception '376: usage_prices.markup took 11';
  exception when check_violation then null;
  end;
  if has_function_privilege('authenticated', 'public.wallet_usage_debit(text, text, bigint, bigint, text, text, text, jsonb, text)', 'execute')
     or has_function_privilege('anon', 'public.wallet_usage_debit(text, text, bigint, bigint, text, text, text, jsonb, text)', 'execute')
     or has_function_privilege('authenticated', 'public.wallet_credit(text, bigint, text, text, text, text, text, uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.wallet_credit(text, bigint, text, text, text, text, text, uuid, text)', 'execute') then
    raise exception '376: the wallet''s money functions must stay service role only';
  end if;
  if has_table_privilege('authenticated', 'public.jack_messages', 'select') or has_table_privilege('authenticated', 'public.jack_proposals', 'select') then
    raise exception '376: Jack''s tables must stay service role only';
  end if;
end
$billing_proof$;

-- ── 4. Setup (jack-agent/setup.ts, portal-setup) ─────────────────────────────────────────────────────
-- 1. Which template step is which, for Jack. Read by portal-setup through template_item_id, like
--    requires_feature and builder_visible. Service-role-only table (157): no grant changes.
alter table public.setup_template_items add column if not exists jack_key text;
alter table public.setup_template_items drop constraint if exists setup_template_items_jack_key_format;
alter table public.setup_template_items add constraint setup_template_items_jack_key_format
  check (jack_key is null or jack_key ~ '^[a-z][a-z0-9_]{1,39}$');
-- One step per key for each account shape (368's account_type): a SmartBuild builder's own "Add your
-- business details" is the business step on that list, as the shed one is on the shed list.
create unique index if not exists setup_template_items_jack_key_uniq
  on public.setup_template_items (jack_key, account_type) where jack_key is not null;

-- Best effort, by title: the 160 seed titles and the live template's (read 11-06; operators had reworded
-- and split some steps since 160). One row per key, and never over a key already set. A step with no key
-- still works: Jack treats it as the operator's own step (help in words, no auto-tick). Check the result:
--     select title, jack_key from public.setup_template_items order by position;
with k(title, key) as (values
  ('Set your password and sign in', 'password'),
  ('Add your business details and logo', 'business'),
  ('Check your building styles and sizes', 'styles'),
  ('Set up doors, windows, ramps and add-ons', 'catalog_items'),
  ('Set your colors', 'colors'),
  ('Set your prices', 'prices'),
  ('Decide if customers see prices', 'show_prices'),
  ('Connect your CRM (if you use GoHighLevel)', 'crm'),
  ('Choose how quotes & invoices go out', 'paperwork'),
  ('Send email from your own domain', 'email_domain'),
  ('Send yourself a test quote', 'test_quote'),
  ('Share your customer design link', 'share_link'),
  ('Add your team & set access', 'team'),
  ('Add sales locations & your serial number start', 'locations'),
  ('Set up commissions (optional)', 'commissions'),
  ('Scheduling: create crews, territories & drivers', 'crews_drivers'),
  ('QuickBooks: connect & map your items', 'quickbooks'),
  ('Real-Time Pricing: materials & build sheets', 'rtp'),
  ('3D: calibrate how your styles look', 'd3'),
  -- the live template's wording, 11-06
  ('Add your business details', 'business'),
  ('Set up your logo and branding', 'logo'),
  ('Add your sales locations', 'locations'),
  ('Set where your building serial numbers start', 'serial'),
  ('Connect GoHighLevel (optional)', 'crm')
), pick as (
  select distinct on (k.key, t.account_type) t.id, k.key, t.account_type
  from k join public.setup_template_items t on t.title = k.title
  where t.jack_key is null
  order by k.key, t.account_type, t.active desc, t.position
)
update public.setup_template_items t set jack_key = pick.key
from pick
where t.id = pick.id
  and not exists (select 1 from public.setup_template_items x where x.jack_key = pick.key and x.account_type = pick.account_type);

-- 2. "Done with Jack". Tenant-readable through the existing select policy (157); writes stay revoked
--    from authenticated, and only portal-setup (service role) sets these.
alter table public.tenant_setup_items add column if not exists completed_via text;
alter table public.tenant_setup_items add column if not exists completed_proposal_id uuid;
alter table public.tenant_setup_items drop constraint if exists tenant_setup_items_completed_via_check;
alter table public.tenant_setup_items add constraint tenant_setup_items_completed_via_check
  check (completed_via is null or completed_via = 'jack');
alter table public.tenant_setup_items drop constraint if exists tenant_setup_items_completed_via_pair;
alter table public.tenant_setup_items add constraint tenant_setup_items_completed_via_pair
  check ((completed_via is null) = (completed_proposal_id is null));

-- Any tick or untick that doesn't set the marker itself (a person in portal-setup sets it to null; the
-- operator's portal-projects setup_client_toggle doesn't mention it) clears it. Otherwise an operator's
-- re-tick would read "with Jack" and Jack's Undo could take it back.
create or replace function public.tenant_setup_items_clear_jack_marker()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.completed_at is distinct from old.completed_at
     and new.completed_proposal_id is not distinct from old.completed_proposal_id
     and old.completed_proposal_id is not null then
    new.completed_via := null;
    new.completed_proposal_id := null;
  end if;
  return new;
end
$$;
revoke all on function public.tenant_setup_items_clear_jack_marker() from public, anon, authenticated;
drop trigger if exists tenant_setup_items_jack_marker on public.tenant_setup_items;
create trigger tenant_setup_items_jack_marker
  before update on public.tenant_setup_items
  for each row execute function public.tenant_setup_items_clear_jack_marker();

-- ── 5. Look-ups (jack-agent/lookups.ts, portal-settings/jackReads.ts) ───────────────────────────────
-- When each side last spoke, for a list of customers. crm_customer_facts uses it to say who is
-- waiting on whom. crm_rule_last_contact (363) counts only texts and calls, and lumps both
-- directions together. This one keeps them apart and counts email both ways.
--   in:  a text from them, an email from them, a call from them (any outcome)
--   out: a text to them the provider took (sent or delivered), a conversation email that went out
--        (sent or delivered), a call to them (any outcome), and an inbound call somebody answered
--        that didn't end in voicemail
-- Calls count only when p_calls is true (the caller sees the whole team's calls). Otherwise they
-- count for nothing. Service role only: portal-settings narrows the ids to what the caller may see
-- before it asks. Every table already has a (client_id, contact_id, time) index (150, 135, 134, 254).
create or replace function public.crm_contact_touch_facts(p_client text, p_ids uuid[], p_calls boolean default false)
returns table (contact_id uuid, last_in_at timestamptz, last_in_channel text, last_out_at timestamptz, last_out_channel text)
language sql
stable
security definer
set search_path to ''
as $fn$
  with ev (cid, ts, dir, channel) as (
    select m.contact_id, m.created_at, m.direction, 'sms'::text
      from public.sms_messages m
     where m.client_id = p_client and m.contact_id = any (p_ids)
       and (m.direction = 'in' or m.status in ('sent', 'delivered'))
    union all
    select e.contact_id, e.received_at, 'in', 'email'
      from public.email_inbound e
     where e.client_id = p_client and e.contact_id = any (p_ids)
    union all
    select s.contact_id, s.created_at, 'out', 'email'
      from public.email_sends s
     where s.client_id = p_client and s.contact_id = any (p_ids)
       and s.kind in ('conversation', 'test') and s.status in ('sent', 'delivered')
    union all
    select c.contact_id, c.started_at, c.direction, 'call'
      from public.phone_calls c
     where p_calls and c.client_id = p_client and c.contact_id = any (p_ids)
    union all
    select c.contact_id, coalesce(c.answered_at, c.started_at), 'out', 'call'
      from public.phone_calls c
     where p_calls and c.client_id = p_client and c.contact_id = any (p_ids)
       and c.direction = 'in' and (c.answered_by is not null or c.answered_at is not null)
       and c.status not in ('ringing', 'in_progress', 'voicemail')
       and not exists (select 1 from public.phone_voicemails v where v.call_id = c.id)
  )
  select ev.cid,
         max(ev.ts) filter (where ev.dir = 'in'),
         (array_agg(ev.channel order by ev.ts desc) filter (where ev.dir = 'in'))[1],
         max(ev.ts) filter (where ev.dir = 'out'),
         (array_agg(ev.channel order by ev.ts desc) filter (where ev.dir = 'out'))[1]
    from ev
   group by ev.cid;
$fn$;
revoke execute on function public.crm_contact_touch_facts(text, uuid[], boolean) from public, anon, authenticated;
grant  execute on function public.crm_contact_touch_facts(text, uuid[], boolean) to service_role;
comment on function public.crm_contact_touch_facts(text, uuid[], boolean) is
  'Migration 376 (Jack look-ups). Per contact: when they last wrote or called in, and when the builder last wrote, called or answered, each with its channel. Calls only when p_calls. Service role only; portal-settings crm_customer_facts narrows the ids first.';


-- ── 6. Clearing old private cards ─────────────────────────────────────────────────────────────────────
-- A look-up list or a reply draft holds customer names, towns, buildings and words. 30 days after it was
-- made, its contents are cleared: on any read (jack-agent settled) and by this sweep, which jack-agent
-- runs in the background whenever someone opens Jack or sends a message, so a card nobody reads again is
-- cleared too. Title, status, who asked and the dates stay for the activity page. The kinds are
-- jack-agent common.ts PRIVATE_KINDS (kinds_test.ts checks they match). Service role only.
create or replace function public.jack_clear_old_private(p_client text, p_before timestamptz)
returns integer
language sql
security definer
set search_path to ''
as $fn$
  with cleared as (
    update public.jack_proposals
       set preview = '{"cleared": true}'::jsonb, payload = '{"cleared": true}'::jsonb
     where client_id = p_client
       and kind in ('lookup', 'reply_draft')
       and created_at < p_before
       and coalesce(preview ->> 'cleared', '') <> 'true'
    returning 1
  )
  select count(*)::integer from cleared;
$fn$;
revoke execute on function public.jack_clear_old_private(text, timestamptz) from public, anon, authenticated;
grant  execute on function public.jack_clear_old_private(text, timestamptz) to service_role;
comment on function public.jack_clear_old_private(text, timestamptz) is
  'Migration 376. Clears the customer contents of one builder''s Jack look-up lists and reply drafts made before p_before (jack-agent passes now minus 30 days). The count cleared. Service role only.';

-- ── Proof ─────────────────────────────────────────────────────────────────────────────────────────────
do $proof$
begin
  if not exists (select 1 from public.usage_prices where kind = 'jack_ai' and active = false and pricing = 'cost_plus' and markup = 1.500) then
    raise exception '376: the jack_ai meter must ship inactive, cost_plus, at x1.5';
  end if;
  if has_table_privilege('authenticated', 'public.jack_memory', 'select') or has_table_privilege('anon', 'public.jack_memory', 'select') then
    raise exception '376: jack_memory must be service role only';
  end if;
  if has_function_privilege('authenticated', 'public.crm_contact_touch_facts(text, uuid[], boolean)', 'execute')
     or has_function_privilege('anon', 'public.crm_contact_touch_facts(text, uuid[], boolean)', 'execute') then
    raise exception '376: crm_contact_touch_facts must be service role only';
  end if;
  if has_function_privilege('authenticated', 'public.jack_clear_old_private(text, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.jack_clear_old_private(text, timestamptz)', 'execute') then
    raise exception '376: jack_clear_old_private must be service role only';
  end if;
  if has_function_privilege('authenticated', 'public.tenant_setup_items_clear_jack_marker()', 'execute') then
    raise exception '376: the setup marker trigger function must not be callable';
  end if;
end
$proof$;
