-- 102_billing_plans_no_browser_read: stop serving unpublished prices to every tenant.
--
-- WHY: `billing_plans` carried BOTH a `using (true)` select policy and a
-- `grant select ... to authenticated` (050_billing.sql:33-36). Together those mean "any
-- signed-in user may read every row of this table" — so any builder with a portal login
-- could query billing_plans directly from the browser and read `price_cents` for every
-- plan, including the ones deliberately held back by `price_visible = false`.
--
-- That flag exists (055_billing_price_visible) because "coming soon" and "we have not
-- settled the price" are different things: Self Serve Displays is still being costed and
-- showing a number now anchors builders to a figure we may have to raise. 055 recorded the
-- leak as accepted and suggested redacting `price_cents` in portal-billing's `publicPlans`
-- projection. That alone would NOT have closed it — it hides the front door while the
-- direct table read stays open. Both halves are needed, and this is the other half.
--
-- SAFE because nothing in the browser reads this table directly: every price the portal
-- shows arrives through the `portal-billing` edge function, which uses the service role
-- (RLS and grants do not apply to it). Verified by grep over portal.html and admin.html —
-- zero `.from("billing_plans")` call sites. The paired projection change lands in
-- portal-billing's `status` action in the same commit.
--
-- NOT a price change and NOT a gateway change: `price_cents` keeps its real value, the
-- subscribe path still reads it server-side, and publishing a price later is still the
-- one-field `price_visible = true` flip 055 designed.
--
-- Follows the convention 025_revoke_client_settings_grant established: RLS alone
-- fail-closes, but the explicit revoke is what makes the intent legible and stops a future
-- policy edit from silently re-opening a table grant nobody meant to keep.
--
-- Hand-apply via the SQL editor / MCP and record as version 102 — NEVER `supabase db push`.

-- The policy is dropped rather than narrowed: with no grant there is nothing for a policy
-- to permit, and leaving a `using (true)` policy behind invites someone to "restore" the
-- grant to match it.
drop policy if exists billing_plans_auth_read on public.billing_plans;

revoke select on public.billing_plans from authenticated;
revoke all on public.billing_plans from anon;

-- RLS stays on: belt and braces, and it keeps the table consistent with every other table
-- in this schema rather than becoming the one exception someone has to reason about.
alter table public.billing_plans enable row level security;

comment on column public.billing_plans.price_visible is
  'Display gate for an unsettled price. false = portal-billing REDACTS price_cents/charge_cents from its response and the Billing tab prints no number. Since migration 102 the browser also has no direct read on this table, so false genuinely hides the figure rather than only asking the UI not to print it.';
