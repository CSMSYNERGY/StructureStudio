-- 057_billing_gate: make the Billing tab actually mean something.
--
-- Until now billing was recorded but never enforced — a tenant with no subscription
-- had the same access as a paying one. This adds the two pieces the gate needs:
--
--   client_settings.billing_exempt      — CSM Synergy's own / demo / test accounts.
--                                         Exempt tenants skip every gate and are never
--                                         shown a plan picker. Set at creation from the
--                                         admin console's "+ New client" form.
--   billing_subscriptions.past_due_since — when a subscription first went past_due, so a
--                                         failed payment gets a GRACE PERIOD (keep
--                                         working, show a warning) instead of locking a
--                                         paying customer out over an expired card.
--                                         Cleared when the payment recovers.
--
-- Cancellation is NOT graced — that's a deliberate act, and canceled_at already records it.
--
-- Entitlement itself is computed SERVER-SIDE in portal-billing (client_settings is
-- service-role only, so the browser can't read the exempt flag and can't self-grant).
--
-- NOTE ON NUMBERING: 053/054 (orders + payments) are applied to this database but their
-- .sql files live on the unmerged `wip/orders` branch, so `beta` jumps 052 → 055. The
-- ledger in supabase_migrations.schema_migrations is the source of truth.
--
-- Hand-apply via the SQL editor / MCP and record as version 057 — NEVER `supabase db push`.

alter table public.client_settings
  add column if not exists billing_exempt boolean not null default false;

comment on column public.client_settings.billing_exempt is
  'true = internal/demo account: bypasses the billing gate and is never charged.';

alter table public.billing_subscriptions
  add column if not exists past_due_since timestamptz;

comment on column public.billing_subscriptions.past_due_since is
  'When this subscription first went past_due; drives the grace period. NULL when healthy.';
