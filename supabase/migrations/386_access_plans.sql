-- 386: PLANS AS DATA. Which tabs a company has stops being code and becomes rows.
--
-- Ahsan, 2026-11-12: every tab selectable, plans he can add, edit and remove himself, custom plans
-- for one company, and a new plan in 5 to 15 minutes. Until now "what does this company have" was
-- three vocabularies that nothing tied together: billing_plans.feature (worked into an entitlement
-- by portal-billing, with the Suite's member list copied three times in code and once in SQL), a
-- dozen one-off columns on client_settings (sheds_enabled, phone_only, jack_on, ...), and the
-- 3D-only comps in client_feature_grants. A new kind of company meant a code change, the push gate
-- and about twenty function deploys.
--
-- THIS MIGRATION IS STAGE A, AND IT IS DARK. It adds five tables, their starting rows and one
-- resolver. Nothing reads any of it yet: no function, no portal page, no database rule. It alters no
-- existing table and no existing function. Stage B switches the portal over one company at a time.
--
--   access_modules        the fixed catalogue of tabs: one key per thing an operator would switch.
--                         Mirrored from _shared/accessModules.ts (a test holds the two equal), and
--                         here as a table so a typo cannot be saved as a plan's tab.
--   access_plans          a named set of tabs. `key` is billing_plans.feature for a plan that is
--                         sold (the link is by value, deliberately not a foreign key: this migration
--                         touches no billing table). A plan with no billing_plans row has no price
--                         and is operator-assigned only.
--   access_plan_modules   per plan, per tab: 'included', or 'teaser' (shown with a padlock and a
--                         "see Billing" card). No row = hidden.
--   client_access_plans   a plan an OPERATOR put a company on: a comp, or one paid outside the card
--                         system (ACH, a cheque). A paid plan is never written here; that stays a
--                         billing_subscriptions row, and the resolver reads both.
--   client_modules        one tab forced on or off for one company, with an optional end date.
--
-- THE ANSWER FOR ONE TAB AT ONE COMPANY, first match wins (access_resolve_detail):
--   1. a client_modules 'off' row                              -> off     (hidden AND blocked; data kept)
--   2. a client_modules 'on' row                               -> on
--   3. the company is phone-only (384)                         -> on for the Phone + Contacts plan's
--      tabs, hidden for every other one. EXCLUSIVE, as accountShape.ts is today: a plan it still
--      holds, a comp, Non-billable, none of them add a tab while the flag is set.
--   4. the company sells no sheds (364) and the tab is a shed one -> off
--   5. the tab's own older switch is on (jack_on, phone_status, the 3D comp, ...) -> on
--   6. ours or Non-billable, and a PUBLIC plan includes the tab -> on
--   7. a plan the company holds includes it                    -> on
--   8. a plan the company holds lists it as a teaser           -> locked
--   9. otherwise                                               -> hidden
-- "Holds" = a usable subscription (active; past due inside 7 days; cancelled but inside the period
-- already paid for: the rule portal-billing's featureState and 270's ss_view3d_paid both apply), an
-- unexpired client_access_plans row, or a dated free period for the plans marked free_period.
--
-- STEP 6 IS NARROW ON PURPOSE. Non-billable means "everything we sell", and it has never meant Jack,
-- the Support assistant, the Library, door looks, Advanced, Avalara or card payments: those are
-- switched per company and no plan sells them. Live on 2026-11-12 the demo account is Non-billable
-- and has none of them. They come from step 5 or from a row, never from the blanket.
--
-- STEPS 3, 4 AND 5 ARE THE OLD MECHANISMS READ AS IF THEY WERE ROWS, so no company changes on the day
-- anything starts reading this. A later clean-up writes the real rows and drops the columns.
--
-- THE STARTING ROWS REPRODUCE TODAY. portal-billing opens the base product (Designer, Inventory,
-- Orders, Commissions) to a company with ANY usable subscription, so every starting plan includes
-- those tabs. Taking them off a plan later is an edit to rows, which is the point. The teaser rows
-- are a best effort at today's upsell cards and are pinned against the shell in stage B; they are
-- data, so correcting one needs no migration.
--
-- SECURITY. All five tables are service-role only (RLS on, no policy, every browser grant revoked),
-- like client_settings. The three functions are SECURITY DEFINER with an empty search_path because
-- they read billing tables the browser roles cannot, and EXECUTE is revoked from public, anon and
-- authenticated: a company can neither read its own plan nor ask about another's.
--
-- The repo is public: no client identifiers in here.
--
-- Rollback (nothing reads these, so order is the only care):
--   drop function if exists public.access_resolve(text);
--   drop function if exists public.access_resolve_detail(text);
--   drop function if exists public.access_usable_plans(text);
--   drop table if exists public.client_modules, public.client_access_plans,
--     public.access_plan_modules, public.access_plans, public.access_modules;

-- ── 1. The tables ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.access_modules (
  key   text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text not null,
  grp   text not null check (grp in ('hub', 'sheds', 'integrations', 'soon', 'beta')),
  -- Part of the shed product: a company that sells no sheds (364) never has it.
  shed  boolean not null default false,
  sort  integer not null default 0
);
comment on table public.access_modules is
  'The catalogue of switchable tabs (migration 386). Mirrored from _shared/accessModules.ts; a test '
  'holds the two equal. Service-role only.';

create table if not exists public.access_plans (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name        text not null,
  blurb       text,
  -- draft: confers nothing and cannot be assigned. retired: still means what it meant to whoever
  -- holds it, and cannot be newly assigned (a plan row is a historical fact; only its sale ends).
  status      text not null default 'active' check (status in ('draft', 'active', 'retired')),
  -- public: sold to everyone, and so part of what Non-billable confers. private: a custom plan.
  visibility  text not null default 'private' check (visibility in ('public', 'private')),
  -- A dated free period (client_settings.billing_exempt_until) confers this plan.
  free_period boolean not null default false,
  -- The plans this one supersedes at checkout (the Suite and its members). Read by stage F.
  replaces    text[] not null default '{}',
  sort        integer not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.access_plans is
  'A named set of tabs (migration 386). key = billing_plans.feature for a plan that is sold; a plan '
  'with no billing_plans row is operator-assigned only. Service-role only.';

create table if not exists public.access_plan_modules (
  plan_key text not null references public.access_plans (key) on delete cascade on update cascade,
  module   text not null references public.access_modules (key),
  state    text not null check (state in ('included', 'teaser')),
  primary key (plan_key, module)
);
comment on table public.access_plan_modules is
  'Per plan, per tab: included, or teaser (shown locked). No row = hidden. Migration 386.';

create table if not exists public.client_access_plans (
  client_id  text not null,
  plan_key   text not null references public.access_plans (key) on update cascade,
  reason     text not null default 'comp' check (reason in ('comp', 'paid_offline')),
  expires_at timestamptz,               -- null = until removed; an expired row counts as no row
  note       text,
  set_by     uuid,                      -- the operator; null on the break-glass password path
  set_at     timestamptz not null default now(),
  primary key (client_id, plan_key)
);
comment on table public.client_access_plans is
  'A plan an operator put a company on (migration 386): a comp, or paid outside the card system. A '
  'card subscription is never written here. Service-role only.';

create table if not exists public.client_modules (
  client_id  text not null,
  module     text not null references public.access_modules (key),
  mode       text not null check (mode in ('on', 'off')),
  expires_at timestamptz,               -- null = until changed; an expired row counts as no row
  note       text,
  set_by     uuid,
  set_at     timestamptz not null default now(),
  primary key (client_id, module)
);
comment on table public.client_modules is
  'One tab forced on or off for one company (migration 386). off = hidden and blocked, data kept; '
  'on = works without a plan. Service-role only.';

alter table public.access_modules      enable row level security;
alter table public.access_plans        enable row level security;
alter table public.access_plan_modules enable row level security;
alter table public.client_access_plans enable row level security;
alter table public.client_modules      enable row level security;

revoke all on public.access_modules, public.access_plans, public.access_plan_modules,
  public.client_access_plans, public.client_modules from public, anon, authenticated;
grant all on public.access_modules, public.access_plans, public.access_plan_modules,
  public.client_access_plans, public.client_modules to service_role;

-- ── 2. The catalogue ───────────────────────────────────────────────────────────────────────────
-- ⚠️ Keep in step with _shared/accessModules.ts (ACCESS_MODULES). accessModulesMirror_test.ts reads
-- this block and fails the push when the two differ.
insert into public.access_modules (key, label, grp, shed, sort) values
  ('contacts',            'Customer Hub: contacts',        'hub',          false, 10),
  ('pipelines',           'Pipelines',                     'hub',          false, 20),
  ('conversations',       'Conversations',                 'hub',          false, 30),
  ('phone',               'Calls and the phone',           'hub',          false, 40),
  ('sms',                 'Business texting',              'hub',          false, 50),
  ('email',               'Email settings and templates',  'hub',          false, 60),
  ('meetings',            'Meetings',                      'hub',          false, 70),
  ('automations',         'Automations',                   'hub',          false, 80),
  ('forms',               'Forms',                         'hub',          false, 90),
  ('customer_login',      'Customer login',                'hub',          true,  100),
  ('jack',                'Jack',                          'hub',          false, 110),
  ('designer',            'Shed Designer',                 'sheds',        true,  200),
  ('advanced',            'Advanced',                      'sheds',        true,  210),
  ('view_3d',             '3D View',                       'sheds',        true,  220),
  ('inventory',           'Inventory',                     'sheds',        true,  230),
  ('orders',              'Orders',                        'sheds',        true,  240),
  ('build_schedule',      'Build Schedule',                'sheds',        true,  250),
  ('delivery_schedule',   'Delivery Schedule',             'sheds',        true,  260),
  ('repairs',             'Repairs',                       'sheds',        true,  270),
  ('commissions',         'Commissions',                   'sheds',        false, 280),
  ('rtp',                 'RealTime Pricing',              'sheds',        true,  290),
  ('quickbooks',          'QuickBooks',                    'integrations', false, 300),
  ('ghl',                 'GHL connection',                'integrations', true,  310),
  ('payments',            'Card payments',                 'integrations', true,  320),
  ('tax',                 'Automatic sales tax',           'integrations', true,  330),
  ('reports',             'Reports',                       'soon',         false, 400),
  ('projects',            'Project Management',            'soon',         false, 410),
  ('rent_to_own',         'Rent to Own',                   'soon',         true,  420),
  ('self_serve_displays', 'Self Serve Displays',           'soon',         true,  430),
  ('smartbuild_sync',     'SmartBuild Sync',               'soon',         false, 440),
  ('support_ai',          'Support assistant',             'beta',         false, 500),
  ('library',             'Library',                       'beta',         false, 510),
  ('door_looks',          'Door looks from a photo',       'beta',         false, 520)
on conflict (key) do nothing;

-- ── 3. The starting plans: today's ten features, plus Phone + Contacts ─────────────────────────
insert into public.access_plans (key, name, blurb, status, visibility, free_period, replaces, sort) values
  ('simple_layout',       'Simple Layout',        'The shed designer, inventory and orders.',                 'active', 'public',  true,  '{}', 100),
  ('schedule_builds',     'Shed Scheduler',       'Build Schedule, Delivery Schedule and Repairs.',           'active', 'public',  false, '{}', 98),
  ('view_3d',             '3D View',              'The 3D view of a building.',                               'active', 'public',  false, '{}', 97),
  ('quickbooks_sync',     'QuickBooks Sync',      'Invoices and payments synced to QuickBooks.',              'active', 'public',  false, '{}', 95),
  ('on_demand_pricing',   'RealTime Pricing',     'Prices worked out from materials and labour.',             'active', 'public',  false, '{}', 90),
  ('smartbuild_sync',     'SmartBuild Sync',      'Coming soon.',                                             'active', 'public',  true,  '{}', 88),
  ('project_management',  'Project Management',   'Coming soon.',                                             'active', 'public',  true,  '{}', 86),
  ('crm',                 'Customer Hub',         'Contacts, pipelines, conversations, meetings, automations and forms.', 'active', 'public', false, '{}', 75),
  ('full_suite',          'FULL Suite for Sheds', 'Everything for a shed builder in one plan.',               'active', 'public',  false,
     '{simple_layout,schedule_builds,view_3d,quickbooks_sync,on_demand_pricing,crm}', 74),
  ('self_serve_displays', 'Self Serve Displays',  'Coming soon.',                                             'active', 'public',  true,  '{}', 60),
  ('phone_contacts',      'Phone + Contacts',     'My Synergy Phone, the contact list and business texting.', 'active', 'private', false, '{}', 50)
on conflict (key) do nothing;

-- Included tabs. The base rows first: any usable subscription opens these today.
insert into public.access_plan_modules (plan_key, module, state)
select p.key, b.module, 'included'
  from (values ('simple_layout'), ('schedule_builds'), ('view_3d'), ('quickbooks_sync'), ('on_demand_pricing'),
               ('smartbuild_sync'), ('project_management'), ('crm'), ('full_suite'), ('self_serve_displays')) p(key)
 cross join (values ('designer'), ('inventory'), ('orders'), ('commissions'), ('ghl'), ('customer_login')) b(module)
on conflict (plan_key, module) do nothing;

-- What each plan adds to the base. The Suite's rows are its six members' rows.
insert into public.access_plan_modules (plan_key, module, state) values
  ('schedule_builds',     'build_schedule',      'included'),
  ('schedule_builds',     'delivery_schedule',   'included'),
  ('schedule_builds',     'repairs',             'included'),
  ('view_3d',             'view_3d',             'included'),
  ('quickbooks_sync',     'quickbooks',          'included'),
  ('on_demand_pricing',   'rtp',                 'included'),
  ('smartbuild_sync',     'smartbuild_sync',     'included'),
  ('project_management',  'projects',            'included'),
  ('self_serve_displays', 'self_serve_displays', 'included'),
  ('crm',                 'contacts',            'included'),
  ('crm',                 'pipelines',           'included'),
  ('crm',                 'conversations',       'included'),
  ('crm',                 'sms',                 'included'),
  ('crm',                 'email',               'included'),
  ('crm',                 'meetings',            'included'),
  ('crm',                 'automations',         'included'),
  ('crm',                 'forms',               'included'),
  ('full_suite',          'build_schedule',      'included'),
  ('full_suite',          'delivery_schedule',   'included'),
  ('full_suite',          'repairs',             'included'),
  ('full_suite',          'view_3d',             'included'),
  ('full_suite',          'quickbooks',          'included'),
  ('full_suite',          'rtp',                 'included'),
  ('full_suite',          'contacts',            'included'),
  ('full_suite',          'pipelines',           'included'),
  ('full_suite',          'conversations',       'included'),
  ('full_suite',          'sms',                 'included'),
  ('full_suite',          'email',               'included'),
  ('full_suite',          'meetings',            'included'),
  ('full_suite',          'automations',         'included'),
  ('full_suite',          'forms',               'included'),
  ('phone_contacts',      'contacts',            'included'),
  ('phone_contacts',      'phone',               'included'),
  ('phone_contacts',      'sms',                 'included')
on conflict (plan_key, module) do nothing;

-- Teasers: the tabs that show an upsell card today, on every public plan that does not include
-- them. `on conflict do nothing` is what keeps an included row included. Best effort; see the header.
insert into public.access_plan_modules (plan_key, module, state)
select p.key, t.module, 'teaser'
  from (values ('simple_layout'), ('schedule_builds'), ('view_3d'), ('quickbooks_sync'), ('on_demand_pricing'),
               ('smartbuild_sync'), ('project_management'), ('crm'), ('self_serve_displays')) p(key)
 cross join (values ('contacts'), ('build_schedule'), ('delivery_schedule'), ('repairs'), ('view_3d'),
                    ('quickbooks'), ('rtp')) t(module)
on conflict (plan_key, module) do nothing;

-- ── 4. Which sold plans does a company hold a USABLE subscription to? ─────────────────────────
-- portal-billing's featureState and 270's ss_view3d_paid, for every plan instead of 3D alone:
-- active; past due inside the 7-day grace (no timestamp = grace from now, generous rather than an
-- instant lockout); cancelled but inside the period already paid for (the stored boundary rolled
-- forward by whole billing intervals up to the cancellation, at most 240 steps). Read through the
-- plan row whether or not that price point is still on sale. Returns billing_plans.feature, once
-- per usable subscription (callers use it as a set).
create or replace function public.access_usable_plans(p_client_id text)
returns setof text
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  r       record;
  v_step  interval;
  v_end   timestamp;   -- UTC wall clock, as ss_view3d_paid and billingPeriods.ts addInterval
  v_until timestamp;
  v_now   timestamp := now() at time zone 'UTC';
  v_i     integer;
  v_ok    boolean;
begin
  if p_client_id is null then
    return;
  end if;
  for r in
    select p.feature, s.status, s.current_period_end, s.canceled_at, s.past_due_since, p.billing_interval
      from public.billing_subscriptions s
      join public.billing_plans p on p.id = s.plan_id
     where s.client_id = p_client_id
       and p.feature is not null
  loop
    v_ok := false;
    if r.status = 'active' then
      v_ok := true;
    elsif r.status = 'past_due' then
      v_ok := coalesce(r.past_due_since, now()) + interval '168 hours' > now();
    elsif r.status = 'cancelled' and r.current_period_end is not null then
      v_step  := case when lower(coalesce(r.billing_interval, '')) ~ '^(year|annual)'
                      then interval '1 year' else interval '1 month' end;
      v_end   := r.current_period_end at time zone 'UTC';
      v_until := coalesce(r.canceled_at, now()) at time zone 'UTC';
      v_i := 0;
      while v_i < 240 and v_end <= v_until loop
        v_end := v_end + v_step;
        v_i := v_i + 1;
      end loop;
      v_ok := v_end > v_now;
    end if;
    if v_ok then
      return next r.feature;
    end if;
  end loop;
  return;
end
$function$;

comment on function public.access_usable_plans(text) is
  'The sold plans (billing_plans.feature) a company holds a usable subscription to: active, past due '
  'inside 7 days, or cancelled inside the period paid for. Mirrors portal-billing featureState and '
  'ss_view3d_paid; change them together. Migration 386.';

-- ── 5. The resolver ────────────────────────────────────────────────────────────────────────────
-- One row per catalogue tab: its state for this company and why. The order of the CASE is the order
-- in the header. A company with no client_settings row resolves like any other (every flag false).
create or replace function public.access_resolve_detail(p_client_id text)
returns table (module text, state text, source text)
language sql
stable
security definer
set search_path to ''
as $function$
  with cs as (
    select coalesce(s.internal_account, false)                                        as internal,
           coalesce(s.billing_exempt, false)                                          as exempt,
           (s.billing_exempt_until is not null and s.billing_exempt_until > now())    as free_period,
           coalesce(s.phone_only, false)                                              as phone_only,
           (s.sheds_enabled is false)                                                 as no_sheds,
           coalesce(s.jack_on, false)                                                 as jack_on,
           coalesce(s.support_ai_beta, false)                                         as support_ai,
           coalesce(s.library_beta, false)                                            as library,
           coalesce(s.door_looks_beta, false)                                         as door_looks,
           coalesce(s.tax_lookup_enabled, false)                                      as tax,
           coalesce(s.payments_online_enabled, false)                                 as payments,
           coalesce(s.advanced_mode, false)                                           as advanced,
           (s.phone_status = 'on')                                                    as phone_on
      from (select 1) one
      left join public.client_settings s on s.client_id = p_client_id
  ),
  held as (
    select u.k as plan_key, 'plan:' || u.k as src
      from (select distinct f as k from public.access_usable_plans(p_client_id) f) u
    union
    select a.plan_key, 'assigned:' || a.plan_key
      from public.client_access_plans a
     where a.client_id = p_client_id and (a.expires_at is null or a.expires_at > now())
    union
    select p.key, 'free_period:' || p.key
      from public.access_plans p, cs
     where cs.free_period and p.free_period
  ),
  held_ok as (
    select h.plan_key, h.src
      from held h
      join public.access_plans p on p.key = h.plan_key and p.status <> 'draft'
  ),
  inc as (
    select pm.module as m, min(h.src) as src
      from held_ok h
      join public.access_plan_modules pm on pm.plan_key = h.plan_key and pm.state = 'included'
     group by pm.module
  ),
  tease as (
    select pm.module as m, min(h.src) as src
      from held_ok h
      join public.access_plan_modules pm on pm.plan_key = h.plan_key and pm.state = 'teaser'
     group by pm.module
  ),
  blanket as (
    select distinct pm.module as m
      from public.access_plans p
      join public.access_plan_modules pm on pm.plan_key = p.key and pm.state = 'included'
     where p.status = 'active' and p.visibility = 'public'
  ),
  exc as (
    select x.module as m, x.mode
      from public.client_modules x
     where x.client_id = p_client_id and (x.expires_at is null or x.expires_at > now())
  ),
  phone_plan as (
    select pm.module as m
      from public.access_plan_modules pm
     where pm.plan_key = 'phone_contacts' and pm.state = 'included'
  ),
  legacy as (
    select l.m, min(l.src) as src from (
      select 'jack'::text as m, 'switch:jack_on'::text as src from cs where cs.jack_on
      union all select 'support_ai', 'switch:support_ai_beta'         from cs where cs.support_ai
      union all select 'library',    'switch:library_beta'            from cs where cs.library
      union all select 'door_looks', 'switch:door_looks_beta'         from cs where cs.door_looks
      union all select 'tax',        'switch:tax_lookup_enabled'      from cs where cs.tax
      union all select 'payments',   'switch:payments_online_enabled' from cs where cs.payments
      union all select 'phone',      'switch:phone_status'            from cs where cs.phone_on
      union all select 'advanced',   'switch:advanced'                from cs where cs.internal or cs.advanced
      union all select 'view_3d',    'grant:view_3d'
                 where exists (select 1 from public.client_feature_grants g
                                where g.client_id = p_client_id and g.feature = 'view_3d'
                                  and (g.expires_at is null or g.expires_at > now()))
    ) l group by l.m
  )
  select am.key,
         case
           when e.mode = 'off'                                  then 'off'
           when e.mode = 'on'                                   then 'on'
           when cs.phone_only and pp.m is not null              then 'on'
           when cs.phone_only                                   then 'hidden'
           when cs.no_sheds and am.shed                         then 'off'
           when lg.m is not null                                then 'on'
           when (cs.internal or cs.exempt) and b.m is not null  then 'on'
           when i.m is not null                                 then 'on'
           when t.m is not null                                 then 'locked'
           else 'hidden'
         end,
         case
           when e.mode is not null                              then 'exception'
           when cs.phone_only                                   then 'shape:phone_only'
           when cs.no_sheds and am.shed                         then 'shape:no_sheds'
           when lg.m is not null                                then lg.src
           when cs.internal and b.m is not null                 then 'internal'
           when cs.exempt and b.m is not null                   then 'non_billable'
           when i.m is not null                                 then i.src
           when t.m is not null                                 then t.src
           else 'none'
         end
    from public.access_modules am
   cross join cs
    left join exc e         on e.m  = am.key
    left join phone_plan pp on pp.m = am.key
    left join legacy lg     on lg.m = am.key
    left join blanket b     on b.m  = am.key
    left join inc i         on i.m  = am.key
    left join tease t       on t.m  = am.key
   order by am.sort, am.key
$function$;

comment on function public.access_resolve_detail(text) is
  'Every catalogue tab''s state for one company (on | locked | hidden | off) and why. The one copy '
  'of the rule; see migration 386''s header for the order. Service-role only.';

create or replace function public.access_resolve(p_client_id text)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(jsonb_object_agg(d.module, d.state), '{}'::jsonb)
    from public.access_resolve_detail(p_client_id) d
$function$;

comment on function public.access_resolve(text) is
  'access_resolve_detail as one object: { tab: on | locked | hidden | off }. Migration 386.';

revoke execute on function public.access_usable_plans(text)   from public, anon, authenticated;
revoke execute on function public.access_resolve_detail(text) from public, anon, authenticated;
revoke execute on function public.access_resolve(text)        from public, anon, authenticated;
grant  execute on function public.access_usable_plans(text)   to service_role;
grant  execute on function public.access_resolve_detail(text) to service_role;
grant  execute on function public.access_resolve(text)        to service_role;

-- ── 6. Rehearsal: the shape this migration promises, or it does not apply ──────────────────────
do $$
declare n_mod int; n_plan int; n_bad int; n_suite int; n_members int;
begin
  select count(*) into n_mod from public.access_modules;
  if n_mod < 33 then raise exception '386: expected at least 33 catalogue tabs, found %', n_mod; end if;
  select count(*) into n_plan from public.access_plans
   where key in ('simple_layout', 'schedule_builds', 'view_3d', 'quickbooks_sync', 'on_demand_pricing',
                 'smartbuild_sync', 'project_management', 'crm', 'full_suite', 'self_serve_displays', 'phone_contacts');
  if n_plan <> 11 then raise exception '386: expected the 11 starting plans, found %', n_plan; end if;
  -- Every sold feature has a plan to mean something through.
  select count(*) into n_bad from (select distinct feature from public.billing_plans where feature is not null) f
   where not exists (select 1 from public.access_plans p where p.key = f.feature);
  if n_bad > 0 then raise exception '386: % billing_plans feature(s) have no access_plans row', n_bad; end if;
  -- The Suite includes exactly what its six members include.
  select count(*) into n_suite from public.access_plan_modules where plan_key = 'full_suite' and state = 'included';
  select count(distinct module) into n_members from public.access_plan_modules
   where state = 'included'
     and plan_key in ('simple_layout', 'schedule_builds', 'view_3d', 'quickbooks_sync', 'on_demand_pricing', 'crm');
  if n_suite <> n_members then
    raise exception '386: the Suite includes % tabs but its members include %', n_suite, n_members;
  end if;
  if has_function_privilege('anon', 'public.access_resolve(text)', 'execute')
     or has_function_privilege('authenticated', 'public.access_resolve(text)', 'execute')
     or has_function_privilege('anon', 'public.access_resolve_detail(text)', 'execute')
     or has_function_privilege('authenticated', 'public.access_resolve_detail(text)', 'execute')
     or has_function_privilege('anon', 'public.access_usable_plans(text)', 'execute')
     or has_function_privilege('authenticated', 'public.access_usable_plans(text)', 'execute') then
    raise exception '386: a browser role can execute a resolver function';
  end if;
end $$;
