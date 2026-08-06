-- 090_rename_scheduler_reprice: the "Schedule Builds and Delivery" billing feature is renamed to
-- SCHEDULER and repriced to $195/mo · $1950/yr (Carolyn, 2026-08-03). Display name + price only —
-- the feature key stays `schedule_builds` and the gateway_plan_id is untouched (Deposyt identifies
-- the recurring plan by id, not our label). Safe: the feature is still `coming_soon`, so no tenant
-- is subscribed and no charge changes. ALREADY APPLIED to live via execute_sql; this file records it.
-- HAND-APPLY via MCP if re-seeding.

update public.billing_plans
   set name = 'SCHEDULER',
       price_cents = case billing_interval
                       when 'monthly' then 19500
                       when 'annual'  then 195000
                       else price_cents
                     end,
       updated_at = now()
 where feature = 'schedule_builds';
