-- 098_full_suite_available: the Structure Studio Suite goes live — portal-billing bundle
-- entitlement is deployed, the Deposyt plans SS_Full_Suite_Monthly/_Yearly exist, and the Suite
-- UI (first card, covers its members) shipped, so flip it purchasable. ALREADY APPLIED via execute_sql.

update public.billing_plans set availability = 'available', updated_at = now() where feature = 'full_suite';
