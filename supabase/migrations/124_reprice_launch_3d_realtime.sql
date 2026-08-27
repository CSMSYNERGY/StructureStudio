-- 124_reprice_launch_3d_realtime: reprice four add-ons and take 3D View + RealTime Pricing
-- out of coming_soon (Carolyn, 2026-08-24):
--   SCHEDULER (schedule_builds)      $195 → $250/mo · $1,950 → $2,500/yr  (already available)
--   3D View (view_3d)                $195 → $250/mo · $1,950 → $2,500/yr  + coming_soon → available
--   QuickBooks Sync (quickbooks_sync) $75 →  $85/mo ·   $750 →   $850/yr  (already available)
--   RealTime Pricing (on_demand_pricing) $75 → $85/mo · $750 → $850/yr    + coming_soon → available
-- Self Serve Displays untouched (stays coming_soon, price hidden).
-- No subscriber impact: at apply time billing_subscriptions held only simple_layout rows.
-- The "GATEWAY SIDE STILL REQUIRED" warning that stood here is SUPERSEDED (same day): the
-- subscribe path was collapsed to NMI's custom-amount form (plan_amount) for every plan, so
-- price_cents is transmitted on each subscribe and stored on the subscription — renewals bill
-- it directly and no Deposyt plan-record edits are needed for a reprice, ever. Carolyn then
-- deleted the 12 unused Deposyt plan records; only SS_SIMPLE_LAYOUT_MONTHLY/_YEARLY remain
-- (the 2 pre-existing simple_layout_annual subscriptions renew from the yearly record — never
-- delete those two). gateway_plan_id survives only as the plan_name label on new subscriptions.
-- Per the 2026-07-26 rule, NO release_notes entry for the price change itself.
-- ALREADY APPLIED via execute_sql; this file records it. HAND-APPLY via MCP if re-seeding.

update public.billing_plans
   set price_cents = case billing_interval when 'monthly' then 25000 when 'annual' then 250000 else price_cents end,
       availability = 'available',
       updated_at = now()
 where feature in ('schedule_builds','view_3d');

update public.billing_plans
   set price_cents = case billing_interval when 'monthly' then 8500 when 'annual' then 85000 else price_cents end,
       availability = 'available',
       updated_at = now()
 where feature in ('quickbooks_sync','on_demand_pricing');
