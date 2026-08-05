-- 095_3dview_third_reprice: move 3D View (feature view_3d) to the 3rd card (sort_order 97 — between
-- SCHEDULER 98 and QuickBooks Sync 95; list renders sort_order DESC) and reprice it to match
-- SCHEDULER: $195/mo · $1950/yr. Stays coming_soon. (Carolyn, 2026-08-05.)
-- ⚠️ Its Deposyt plans SS_3D_VIEW_MONTHLY/_YEARLY are still at the OLD $275/$2750 — before ever
-- flipping 3D View to 'available', update those gateway plans to $195/$1950 (else the plan_id path
-- charges the gateway amount, not the display price). No risk while coming_soon (not purchasable).
-- ALREADY APPLIED via execute_sql.

update public.billing_plans
   set sort_order = 97,
       price_cents = case billing_interval when 'monthly' then 19500 when 'annual' then 195000 else price_cents end,
       updated_at = now()
 where feature = 'view_3d';
