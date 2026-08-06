-- 099_full_suite_sixth: move the Structure Studio Suite to card #6 (sort_order 75 — after RealTime
-- Pricing 90, before Self Serve Displays 60; list renders sort_order DESC). At ~5 cards/row this
-- puts the Suite at the start of the second row, under Simple Layout. (Carolyn, 2026-08-05.)
-- ALREADY APPLIED via execute_sql.
update public.billing_plans set sort_order = 75, updated_at = now() where feature = 'full_suite';
