-- 093_scheduler_second_price_visible: move SCHEDULER (feature schedule_builds) to the 2nd card
-- in the billing feature list (sort_order 98 — between Simple Layout 100 and QuickBooks Sync 95;
-- the list renders sort_order DESC) and turn its price on (price_visible=true) so $195/mo · $1950/yr
-- shows even while it's coming_soon. ALREADY APPLIED to live via execute_sql; this file records it.

update public.billing_plans
   set sort_order = 98, price_visible = true, updated_at = now()
 where feature = 'schedule_builds';
