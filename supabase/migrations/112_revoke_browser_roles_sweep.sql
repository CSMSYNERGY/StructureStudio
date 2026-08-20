-- 112_revoke_browser_roles_sweep: finish what 102 started -- explicit browser-role revokes
-- on every service-role-only table that never got them.
--
-- The 2026-08-20 whole-app audit swept the LIVE grants: six tables carried full
-- anon/authenticated privileges (Supabase's default grant on CREATE) while holding ZERO
-- policies. RLS is enabled on all six, so with no policies every browser request is denied
-- in practice -- but that protection is one careless `create policy` away from vanishing,
-- and 102's own header states the convention this repo settled on: service-role-only
-- tables get the explicit revoke as well, so the grants table tells the truth about intent
-- (client_feature_grants, migration 109, is the worked example).
--
--   _backup_designs_junior_20260702 / _bak_designs_junior_20260702
--       2026-07-02 snapshots of junior-barns designs, taken during the size-label
--       migration. They hold CUSTOMER CONTACT DATA. Revoked here; whether to DROP them
--       outright is a data-retention call deliberately left to a human (they are the only
--       copies of that snapshot).
--   admin_audit          operator action log -- written by edge functions, read by nobody else
--   ai_style_calls       the AI-draft spend ledger (086/109-adjacent; the cap the meter enforces)
--   billing_charge_attempts  gateway charge history -- service role writes, portal-billing reads
--   qbo_item_map         QuickBooks item mapping -- qbo sync functions only
--
-- Idempotent; revoking an absent grant is a no-op.

revoke all on table public._backup_designs_junior_20260702 from anon, authenticated;
revoke all on table public._bak_designs_junior_20260702 from anon, authenticated;
revoke all on table public.admin_audit from anon, authenticated;
revoke all on table public.ai_style_calls from anon, authenticated;
revoke all on table public.billing_charge_attempts from anon, authenticated;
revoke all on table public.qbo_item_map from anon, authenticated;
