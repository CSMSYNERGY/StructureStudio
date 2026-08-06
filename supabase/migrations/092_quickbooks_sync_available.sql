-- 092_quickbooks_sync_available: the QuickBooks Sync recurring plans now exist in the
-- StructureStudio Deposyt account (SS_QUICKBOOKS_SYNC_MONTHLY $75, SS_QUICKBOOKS_SYNC_YEARLY $750),
-- so flip the feature from 'coming_soon' to purchasable. gateway_plan_ids already match (091).
-- ALREADY APPLIED to live via execute_sql; this file records it. HAND-APPLY if re-seeding.

update public.billing_plans
   set availability = 'available', updated_at = now()
 where feature = 'quickbooks_sync';
