-- 162_crm_above_suite: swap the Built-in CRM and Structure Studio Suite cards (Carolyn,
-- 2026-08-29, having looked at the tab: "Switch the placement of the Suite and the built in
-- CRM").
--
-- The feature grid renders sort_order DESCENDING, so the higher number is the EARLIER card.
-- Migration 160 landed the CRM at 74 and left the Suite at 75, putting the Suite first; this
-- reverses exactly that pair and touches nothing else. Order after this:
--
--   100  Simple Layout (required)        95  QuickBooks Sync
--    98  SCHEDULER                       90  RealTime Pricing
--    97  3D View                         75  Built-in CRM      ← was 74
--                                        74  Structure Studio Suite  ← was 75
--                                        60  Self Serve Displays (coming soon)
--
-- Pure presentation: sort_order is read for display only. It is not consulted by the purchase
-- guards, the bundle expansion, the entitlement map or the upgrade credit — the Suite still
-- includes the CRM and still supersedes it, whichever card is drawn first.
--
-- ALREADY APPLIED to live via execute_sql; this file records it. HAND-APPLY if re-seeding.

update public.billing_plans set sort_order = 75, updated_at = now() where feature = 'crm';
update public.billing_plans set sort_order = 74, updated_at = now() where feature = 'full_suite';
