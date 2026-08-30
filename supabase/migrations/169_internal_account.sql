-- 169_internal_account: CSM Synergy's own tenants get everything, always.
--
-- THE BUG THIS FIXES (Carolyn, 2026-08-30): "when we setup CRM perimeters for billing you
-- also locked the Structure Studio account out. I need Structure Studio account to always be
-- comped on everything."
--
-- She is right, and the CRM gate only made it VISIBLE — the hole predates it. Two facts
-- combine badly:
--
--   1. `operator` is only true when a TARGET is supplied. resolveTenant takes the operator
--      branch on view-as; signing into your OWN portal with no target goes down the normal
--      tenant path, where operator is false. So "operators are never gated" — the sentence
--      portal-billing and portal/11-shell.jsx both rely on — is true of view-as and FALSE of
--      CSM Synergy working in their own account.
--   2. `billing_exempt` deliberately does NOT cover PAID_ONLY_FEATURES. That omission is
--      correct and load-bearing: every pre-gate tenant is exempt, so honouring the blanket
--      there would hand every paid feature to everyone and make the gate decorative.
--
-- Net effect: structure-studio, exempt and holding no subscriptions, was locked out of every
-- pay-only feature on its own portal — schedule_builds, quickbooks_sync, on_demand_pricing
-- since those went pay-only, and crm since 2026-08-29. Nobody noticed until the CRM took
-- Contacts, because Contacts is a tab they open every day and QuickBooks is not.
--
-- WHY A NEW FLAG RATHER THAN WIDENING billing_exempt. They mean different things and must
-- keep meaning different things:
--   billing_exempt   = "this CUSTOMER is not billed" (grandfathering). Must not confer
--                      pay-only features, or the gate is decorative for everyone.
--   internal_account = "this tenant IS US". Not a customer at all. Gets everything,
--                      including pay-only, because there is no revenue to protect from
--                      ourselves and a sales demo has to be able to show the product.
-- Widening the first to fix the second would have unlocked every paid feature for every
-- grandfathered builder on the platform. That is the whole reason this is its own column.
--
-- ⚠️ NEVER set this on a customer tenant. It bypasses every entitlement check there is,
--    on the client AND the server. It is for CSM Synergy's own accounts only.

alter table public.client_settings
  add column if not exists internal_account boolean not null default false;

comment on column public.client_settings.internal_account is
  'CSM Synergy''s own tenant, not a customer. Confers EVERY feature including PAID_ONLY ones, '
  'on both the entitlement map (portal-billing) and the server-side gates (_shared/featureCheck.ts). '
  'Distinct from billing_exempt, which is grandfathering and deliberately does not cover pay-only. '
  'Never set this on a customer.';

-- The account this was written for. Verified live 2026-08-30: structure-studio is
-- billing_exempt with ZERO subscriptions, which is exactly the combination that was locked
-- out of every pay-only feature.
update public.client_settings set internal_account = true where client_id = 'structure-studio';

-- Rollback:
--   alter table public.client_settings drop column if exists internal_account;
