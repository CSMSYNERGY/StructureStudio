-- 091_billing_quickbooks_sync: add "QuickBooks Sync" as a subscribable billing feature
-- (Carolyn, 2026-08-03) — $75/mo, $750/yr. Added as `coming_soon` (visible in the "Choose your
-- features" card, not yet purchasable) because its Deposyt/NMI recurring plans don't exist yet.
-- The gateway_plan_ids follow the SS_<FEATURE>_<INTERVAL> convention the other features use; once
-- those two recurring plans are created in the StructureStudio Deposyt account, flip availability
-- to 'available'. ALREADY APPLIED to live via execute_sql; this file records it. HAND-APPLY if re-seeding.

insert into public.billing_plans
  (id, feature, name, billing_interval, price_cents, gateway_plan_id, setup_fee_cents, availability, required, sort_order, price_visible, active)
values
  ('quickbooks_sync_monthly','quickbooks_sync','QuickBooks Sync','monthly', 7500,  'SS_QUICKBOOKS_SYNC_MONTHLY', 0, 'coming_soon', false, 95, true, true),
  ('quickbooks_sync_annual', 'quickbooks_sync','QuickBooks Sync','annual',  75000, 'SS_QUICKBOOKS_SYNC_YEARLY',  0, 'coming_soon', false, 95, true, true)
on conflict (id) do update set
  name = excluded.name, price_cents = excluded.price_cents, gateway_plan_id = excluded.gateway_plan_id,
  availability = excluded.availability, sort_order = excluded.sort_order, price_visible = excluded.price_visible,
  active = excluded.active, updated_at = now();
