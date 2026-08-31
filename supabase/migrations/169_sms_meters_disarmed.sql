-- 169_sms_meters_disarmed.sql
-- Disarm the SMS meters until the billing code has been proven a no-op against them.
--
-- APPLY BY HAND. NEVER `supabase db push`.
--
-- ⚠️ THIS IS A CORRECTION. Migration 165 seeded the three sms_* meters with `active = true`,
-- which misses the arming rail this project already established for `video_3d_generation`:
-- a price row seeded INACTIVE lets the charging code deploy and be watched running free,
-- and then ONE boolean turns the money on. `wallet_hold` returns `meter_inactive` for such a
-- row, which the caller treats as "proceed, unbilled" rather than as a failure.
--
-- Seeding them active meant the first builder to submit a registration would have been
-- charged $49 by code nobody had yet seen run. The prices are right; the timing was not.
--
-- TO ARM, once a real registration has been watched go through unbilled:
--   update public.usage_prices set active = true where kind = 'sms_registration';
--   update public.usage_prices set active = true where kind = 'sms_number_monthly';
-- (sms_segment stays off until per-segment metering exists — nothing charges it yet.)
update public.usage_prices set active = false, updated_at = now()
where kind in ('sms_registration', 'sms_number_monthly', 'sms_segment');
