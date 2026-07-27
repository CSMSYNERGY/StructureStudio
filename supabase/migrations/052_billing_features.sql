-- 052_billing_features: billing v2 — per-feature plans instead of one product.
--
-- Carolyn's founding pricing sheet (2026-07-24): each feature is its own recurring
-- subscription, chosen monthly or annual independently. Simple Layout (the current
-- core designer) is REQUIRED and the only feature available today; the rest show as
-- coming-soon on the Billing tab and cannot be purchased yet. CRM was dropped from
-- the lineup (tenants use Synergy/GHL; the tab notes CRM integration instead).
-- Yearly = 10× monthly across the board ("2 months free").
--
-- Grandfathering: billing_subscriptions.price_cents snapshots the price at subscribe
-- time, and NMI subscriptions keep their created terms — founding accounts keep
-- their price when the plan rows change later.
--
-- billing_customers: NMI Customer Vault id per tenant (one card entry → setup-fee
-- sale + N subscriptions + card reuse later). Service-role only.
--
-- Hand-apply via MCP and record as 052 — NEVER `supabase db push`.

alter table public.billing_plans add column if not exists feature text;
alter table public.billing_plans add column if not exists setup_fee_cents int;   -- NULL = TBD (charged 0 until set)
alter table public.billing_plans add column if not exists availability text not null default 'available';
alter table public.billing_plans add column if not exists required boolean not null default false;
alter table public.billing_plans drop constraint if exists billing_plans_availability_check;
alter table public.billing_plans add constraint billing_plans_availability_check
  check (availability in ('available','coming_soon'));

-- v1 seed rows (single-product model) — no subscriptions reference them yet.
delete from public.billing_plans where id in ('structurestudio_monthly','structurestudio_annual');

insert into public.billing_plans
  (id, feature, name, price_cents, billing_interval, gateway_plan_id, setup_fee_cents, availability, required, active, sort_order) values
  ('simple_layout_monthly',       'simple_layout',       'Simple Layout',                19500,  'monthly', 'SS_SIMPLE_LAYOUT_MONTHLY',       0,    'available',   true,  true, 100),
  ('simple_layout_annual',        'simple_layout',       'Simple Layout',                195000, 'annual',  'SS_SIMPLE_LAYOUT_YEARLY',        0,    'available',   true,  true, 100),
  ('on_demand_pricing_monthly',   'on_demand_pricing',   'On Demand Pricing',            7500,   'monthly', 'SS_ON_DEMAND_PRICING_MONTHLY',   null, 'coming_soon', false, true, 90),
  ('on_demand_pricing_annual',    'on_demand_pricing',   'On Demand Pricing',            75000,  'annual',  'SS_ON_DEMAND_PRICING_YEARLY',    null, 'coming_soon', false, true, 90),
  ('view_3d_monthly',             'view_3d',             '3D View',                      27500,  'monthly', 'SS_3D_VIEW_MONTHLY',             null, 'coming_soon', false, true, 80),
  ('view_3d_annual',              'view_3d',             '3D View',                      275000, 'annual',  'SS_3D_VIEW_YEARLY',              null, 'coming_soon', false, true, 80),
  ('schedule_builds_monthly',     'schedule_builds',     'Schedule Builds and Delivery', 25000,  'monthly', 'SS_SCHEDULE_BUILDS_MONTHLY',     0,    'coming_soon', false, true, 70),
  ('schedule_builds_annual',      'schedule_builds',     'Schedule Builds and Delivery', 250000, 'annual',  'SS_SCHEDULE_BUILDS_YEARLY',      0,    'coming_soon', false, true, 70),
  ('self_serve_displays_monthly', 'self_serve_displays', 'Self Serve Displays',          50000,  'monthly', 'SS_SELF_SERVE_DISPLAYS_MONTHLY', null, 'coming_soon', false, true, 60),
  ('self_serve_displays_annual',  'self_serve_displays', 'Self Serve Displays',          500000, 'annual',  'SS_SELF_SERVE_DISPLAYS_YEARLY',  null, 'coming_soon', false, true, 60)
on conflict (id) do nothing;

-- Price snapshot at subscribe time (grandfathering).
alter table public.billing_subscriptions add column if not exists price_cents int;

-- NMI Customer Vault mapping — one card on file per tenant. Browser never reads it.
create table if not exists public.billing_customers (
  client_id  text primary key,
  vault_id   text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.billing_customers enable row level security;
revoke all on public.billing_customers from anon, authenticated;

-- Rollback: drop table public.billing_customers;
--           alter table public.billing_subscriptions drop column price_cents;
--           (plan rows/columns can be reverted by re-seeding from 050)
