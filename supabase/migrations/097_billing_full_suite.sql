-- 097_billing_full_suite: the Structure Studio Suite bundle — one subscription that unlocks every
-- feature EXCEPT Self Serve Displays (Simple Layout + SCHEDULER + 3D View + QuickBooks Sync +
-- RealTime Pricing), $795/mo · $7950/yr (Carolyn, 2026-08-05). gateway_plan_ids are the exact
-- Deposyt plan ids created in the SS account (case-sensitive): SS_Full_Suite_Monthly / _Yearly.
-- Added coming_soon; portal-billing's BUNDLE_FEATURES expands `full_suite` -> the 5 members for
-- entitlement + purchase guards. Flip to 'available' once the Suite UI ships. NEW SIGNUPS only for
-- now — switching an existing per-feature subscriber to the Suite is a later, separate task.
-- ALREADY APPLIED via execute_sql; this file records it.

insert into public.billing_plans
  (id, feature, name, billing_interval, price_cents, gateway_plan_id, setup_fee_cents, availability, required, sort_order, price_visible, active)
values
  ('full_suite_monthly','full_suite','Structure Studio Suite','monthly', 79500,  'SS_Full_Suite_Monthly', 0, 'coming_soon', false, 110, true, true),
  ('full_suite_annual', 'full_suite','Structure Studio Suite','annual',  795000, 'SS_Full_Suite_Yearly',  0, 'coming_soon', false, 110, true, true)
on conflict (id) do update set
  name = excluded.name, price_cents = excluded.price_cents, gateway_plan_id = excluded.gateway_plan_id,
  availability = excluded.availability, sort_order = excluded.sort_order, updated_at = now();
