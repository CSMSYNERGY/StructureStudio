-- 050_billing: platform billing — CSM Synergy charges tenants for StructureStudio via
-- the Deposyt/NMI gateway (same stack as BuildBridge: Collect.js browser tokenization,
-- recurring plans preset in the gateway, lifecycle webhooks mirrored locally).
--
-- Three tables:
--   billing_plans          — global price list (like release_notes: authenticated read,
--                            service-role write). gateway_plan_id must match a plan set
--                            up in the Deposyt gateway's Recurring → Plans list.
--   billing_subscriptions  — one row per gateway subscription, keyed by the gateway's
--                            subscription id and owned by a client_id. Owners read only
--                            their own row; all writes go through edge functions
--                            (service role): portal-billing (subscribe/cancel) and
--                            billing-webhook (Deposyt lifecycle events).
--   billing_webhook_events — service-role-only audit/idempotency log of Deposyt events.
--
-- Hand-apply via the SQL editor / MCP and record as version 050 — NEVER `supabase db push`.

create table if not exists public.billing_plans (
  id              text primary key,                  -- app plan id, e.g. 'structurestudio_monthly'
  name            text not null,                     -- display name, e.g. 'StructureStudio — Monthly'
  price_cents     int,                               -- display price; NULL = not yet published (UI hides amount)
  billing_interval text not null check (billing_interval in ('monthly','annual')),
  gateway_plan_id text not null,                     -- Deposyt/NMI Recurring plan id (must exist in the gateway)
  active          boolean not null default true,     -- inactive plans are hidden from the Billing tab
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.billing_plans enable row level security;

drop policy if exists billing_plans_auth_read on public.billing_plans;
create policy billing_plans_auth_read on public.billing_plans
  for select to authenticated using (true);

grant select on public.billing_plans to authenticated;
revoke all on public.billing_plans from anon;
revoke insert, update, delete, truncate, references, trigger on public.billing_plans from authenticated;

create table if not exists public.billing_subscriptions (
  id                   text primary key,             -- gateway (NMI) subscription id
  client_id            text not null,                -- tenant being billed
  plan_id              text references public.billing_plans(id),
  status               text not null default 'active'
                         check (status in ('active','paused','past_due','cancelled')),
  current_period_start timestamptz,
  current_period_end   timestamptz,                  -- next renewal (shown in the Billing tab)
  canceled_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.billing_subscriptions enable row level security;

-- Owners see only their own tenant's subscription; end shed-shoppers (anon) see nothing.
drop policy if exists billing_subscriptions_owner_read on public.billing_subscriptions;
create policy billing_subscriptions_owner_read on public.billing_subscriptions
  for select to authenticated using (client_id = public.current_client_id());

grant select on public.billing_subscriptions to authenticated;
revoke all on public.billing_subscriptions from anon;
revoke insert, update, delete, truncate, references, trigger on public.billing_subscriptions from authenticated;

create index if not exists billing_subscriptions_client_idx
  on public.billing_subscriptions (client_id, created_at desc);

create table if not exists public.billing_webhook_events (
  id           text primary key,                     -- Deposyt event id (idempotency key)
  event_type   text not null,
  payload      jsonb not null,
  status       text not null default 'received'
                 check (status in ('received','processed','failed')),
  error        text,
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.billing_webhook_events enable row level security;
-- No policies → service_role only (browser never reads the raw event log).
revoke all on public.billing_webhook_events from anon, authenticated;

-- Seed the two plans (monthly + annual). price_cents intentionally NULL until the
-- owner publishes pricing — the Billing tab hides the amount and the gateway plan
-- remains the source of truth for what is actually charged.
insert into public.billing_plans (id, name, price_cents, billing_interval, gateway_plan_id, sort_order) values
  ('structurestudio_monthly', 'StructureStudio — Monthly', null, 'monthly', 'STRUCTURESTUDIO_MONTHLY', 2),
  ('structurestudio_annual',  'StructureStudio — Annual',  null, 'annual',  'STRUCTURESTUDIO_YEARLY',  1)
on conflict (id) do nothing;

-- Rollback: drop table public.billing_webhook_events; drop table public.billing_subscriptions;
--           drop table public.billing_plans;
