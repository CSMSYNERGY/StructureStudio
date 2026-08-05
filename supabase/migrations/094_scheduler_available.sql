-- 094_scheduler_available: remove "Coming Soon" from SCHEDULER (feature schedule_builds) — flip to
-- purchasable. Safe now because the Deposyt recurring plans SS_SCHEDULE_BUILDS_MONTHLY/_YEARLY were
-- updated to match the repriced $195/mo · $1950/yr (Carolyn confirmed 2026-08-05), so a non-discounted
-- buyer (plan_id path → gateway amount) is charged what the card shows. ALREADY APPLIED via execute_sql.

update public.billing_plans
   set availability = 'available', updated_at = now()
 where feature = 'schedule_builds';
