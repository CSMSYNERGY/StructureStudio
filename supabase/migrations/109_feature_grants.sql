-- 109_feature_grants: let an OPERATOR switch a feature on for one builder, before it is on sale.
--
-- WHY: Carolyn (2026-08-18) — "I would like to be able to see the 3D as I'm in beta, but not
-- all clients need to see it." There was no mechanism for that. Today a tenant gets a feature
-- exactly one way: `featureOn(key)` in the portal reads `entitlement.features[key]`, which
-- portal-billing computes from billing_plans + billing_subscriptions. So the only paths were
-- "buy it" or "be exempt", and exempt is a blanket that covers every grandfathered tenant at
-- once. The operator console's only per-tenant levers (admin-catalog's set_billing) are
-- blanket too: billing_exempt, an exemption date, a discount.
--
-- A TABLE, not a jsonb column on client_settings:
--   * granted_by / granted_at — a comp is a commercial act and should say who made it.
--   * expires_at — a preview that self-terminates, so "just for a look" cannot quietly
--     become free-forever, which is what every undated comp becomes.
--   * revoking is a DELETE, not a read-modify-write on a blob that set_billing also touches.
--   * a jsonb blob has no constraint on its keys, so a typo grants nothing and reports nothing.
--
-- SERVICE-ROLE ONLY, same posture migration 102 gave billing_plans and for the same reason: a
-- tenant must not be able to read its own grant (it tells them a feature exists and is being
-- withheld) and must never be able to forge one. Every read goes through portal-billing, every
-- write through admin-catalog.

create table if not exists public.client_feature_grants (
  client_id   text        not null,
  feature     text        not null,
  granted_by  uuid,                      -- the operator's auth uid; NULL for the ADMIN_PASSWORD
                                         -- break-glass path, which has no user id at all
  granted_at  timestamptz not null default now(),
  expires_at  timestamptz,               -- NULL = until revoked
  note        text,
  primary key (client_id, feature)
);

comment on table public.client_feature_grants is
  'Operator-granted feature access ("early access"). A COMP, not a purchase: it creates no '
  'subscription and charges nothing. Only features whose billing_plans rows carry '
  'operator_grantable may appear here, and PAID_ONLY features never may. Service-role only.';

alter table public.client_feature_grants enable row level security;
-- No policies on purpose: RLS with zero policies denies everyone except the service role.
revoke all on public.client_feature_grants from anon, authenticated;

-- Which features may be comped is a COMMERCIAL decision, so it lives next to the price rather
-- than in a hardcoded set inside the edge function — the same reasoning admin-catalog already
-- applies when it reads the feature list off billing_plans instead of hardcoding it.
--
-- Defaulting FALSE is what makes the paid-only guard STRUCTURAL rather than a check someone
-- can forget: schedule_builds and quickbooks_sync cannot be granted even by a hand-inserted
-- row, because the grant is only honoured when this column is true AND the feature is not in
-- PAID_ONLY_FEATURES. Both halves are load-bearing.
alter table public.billing_plans
  add column if not exists operator_grantable boolean not null default false;

comment on column public.billing_plans.operator_grantable is
  'May an operator comp this feature to one tenant via client_feature_grants? Default false. '
  'Never set it for a PAID_ONLY feature (schedule_builds, quickbooks_sync) — portal-billing '
  'and admin-catalog both refuse those anyway, but the column should not claim otherwise.';

-- ⚠️ APPLY THE LINE BELOW SEPARATELY, after portal-billing and admin-catalog are deployed and
-- production has been confirmed unchanged. With operator_grantable false everywhere the new
-- middle branch of the features map can never fire, so the deploy is a provable no-op; this
-- one statement is what actually arms it. ONE Supabase project serves beta and production.
--
-- Note view_3d's plans stay `coming_soon` and their Deposyt gateway plans are still at the
-- retired $275/$2750 (see 095_3dview_third_reprice.sql). That is deliberate: the grant is the
-- only path to 3D for now, and flipping availability before fixing those plans would charge
-- the gateway amount. Fix the plans on the day 3D actually goes on sale.
--
--   update public.billing_plans set operator_grantable = true where feature = 'view_3d';
