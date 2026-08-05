-- 096_scheduler_gateway_id_fix: the SCHEDULER Deposyt recurring plans were (re)created with ids
-- SS_SCHEDULER_MONTHLY ($195) / SS_SCHEDULER_YEARLY ($1950) — NOT the original SS_SCHEDULE_BUILDS_*
-- our row still pointed at. Since SCHEDULER is `available`, a subscribe would have sent a dead/old
-- plan id to NMI (fail or mischarge). Repoint gateway_plan_id at the real plans. (Carolyn confirmed
-- the ids from the Deposyt Recurring → Plans list, 2026-08-05.) ALREADY APPLIED via execute_sql.
--
-- Lesson: repricing a feature by DELETING+RECREATING the gateway plan under a NEW id (rather than
-- editing the amount in place) breaks the billing_plans.gateway_plan_id link — always re-point it.

update public.billing_plans
   set gateway_plan_id = case billing_interval
                           when 'monthly' then 'SS_SCHEDULER_MONTHLY'
                           when 'annual'  then 'SS_SCHEDULER_YEARLY'
                           else gateway_plan_id
                         end,
       updated_at = now()
 where feature = 'schedule_builds';
