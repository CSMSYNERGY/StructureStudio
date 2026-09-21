-- 228_billing_exempt_full_access: Non-billable means full access to everything.
--
-- COMMENTS ONLY. No DDL beyond `comment on column` — this change is entirely about what the
-- code does with two columns that already exist, and it is recorded here because migration
-- 169 is where anyone looking for the rule will go first.
--
-- THE ASK (Carolyn, 2026-09-21), about the "Non-billable — skips the billing gate entirely"
-- checkbox in the portal's Admin -> Account -> Billing posture card:
--   "In Structure Studio when this is selected the account should have full access to
--    everything."
--
-- It did not. `billing_exempt` opened the base gate only. Four features are PAY-ONLY
-- (schedule_builds, quickbooks_sync, on_demand_pricing, crm) and one is GRANT-ONLY (view_3d),
-- and the exempt flag deliberately reached none of them, so a comped account got the product
-- and was locked out of Scheduling, QuickBooks Sync, Real-Time Pricing, the CRM and 3D.
--
-- WHAT 169 SAID, AND WHY IT NO LONGER HOLDS. 169_internal_account.sql added a separate flag
-- rather than widening this one, on the grounds that
--   "every pre-gate tenant is exempt, so honouring the blanket there would hand every paid
--    feature to everyone and make the gate decorative."
-- That was TRUE WHEN IT WAS WRITTEN and is a fact about the DATA, not about the code. Checked
-- live on 2026-09-21, before making this change:
--
--   billing_exempt = true : demo-sheds, pw-demo-barns, structure-studio, support-demo, test,
--                           testtttttt  — all internal/demo/test, ZERO subscriptions between
--                           them.
--   real builders         : junior-barns, yoder-barns, preferred-structures — all
--                           billing_exempt = FALSE, all holding live subscriptions.
--
-- The grandfathering flags were cleared as those builders started paying, which is what
-- dissolved 169's objection. Nothing about the argument was wrong; the world moved.
--
-- ⚠️ THE STANDING CONSEQUENCE, and the reason this file exists rather than a one-line commit
--    message: `billing_exempt` is no longer a BILLING POSTURE, it is an ENTITLEMENT GRANT.
--    Ticking that checkbox on a real builder now hands them roughly $755/mo of paid features
--    and free AI generations. The decisions it overrides are still the rule for customers —
--    Carolyn 2026-08-04 "No one gets grandfathered into this", and 2026-08-29 on the CRM
--    "Let them lose it" — and they are now enforced by nobody ticking the box on a customer,
--    plus a confirm dialog in portal/07-admin.jsx that names what is being given away.
--
--    BEFORE RELYING ON ANY OF THIS AGAIN, RE-RUN THE CHECK. If a paying builder ever appears
--    in the exempt list, the premise above is void and the `(internal || exempt)` head in
--    portal-billing has to be revisited:
--
--      select cs.client_id, cs.billing_exempt, cs.internal_account,
--             count(bs.id) filter (where bs.status <> 'cancelled') as live_subs
--      from client_settings cs
--      left join billing_subscriptions bs on bs.client_id = cs.client_id
--      where cs.billing_exempt or cs.internal_account
--      group by 1,2,3 order by 1;
--
-- WHAT CHANGED IN CODE (no schema):
--   portal-billing/index.ts      features map head is now `(internal || exempt) ? true : …`,
--                                and `exempt` was REMOVED from the tail branch where it is now
--                                unreachable. `granted` also carries a comped account's
--                                grantable features, which is what lights up the 3D tab.
--   _shared/featureCheck.ts      hasPaidFeature + usableFeatureSet short-circuit on
--                                billing_exempt as well as internal_account, so the server
--                                gates agree with the UI instead of 403ing every button.
--   _shared/taxMeter.ts          a non-billable account is exempt from metered AI charges.
--                                Carolyn was asked about this one specifically, because it is
--                                real model spend rather than a feature flag, and said yes.
--   portal/03-catalog.jsx        the tenant Billing tab shows a comped banner and veils every
--                                tile as "Included" — previously a comped account saw a full
--                                price list with working Subscribe buttons for things it
--                                already had, and could put a real charge through.
--   portal/07-admin.jsx          copy rewritten to say what the checkbox actually does, plus a
--                                confirm on the OFF->ON transition.
--   admin-catalog/index.ts       set_billing's note now warns when the flag is CLEARED, which
--                                since this change removes five features, not just the gate.
--
-- WHAT DID NOT CHANGE, deliberately:
--   billing_exempt_until (the "Free until" date) still confers only the non-pay-only,
--   non-grantable features. It means "hasn't started paying yet", not "comped" — a builder
--   should not get used to add-ons that vanish when the date passes. (Carolyn, 2026-09-21.)
--
--   internal_account stays, and is NOT redundant. It no longer carries any entitlement
--   billing_exempt does not, but it is the flag portal-settings checks before letting a tenant
--   claim a sending domain on one of our own apexes (PLATFORM_APEXES) — fold that onto
--   billing_exempt and any demo tenant could claim structurestudiosuite.com. It is also the
--   only one of the two with no UI, so it stays hard to set by accident, and
--   entitlement.reason still distinguishes 'internal' from 'exempt' in a support ticket.

comment on column public.client_settings.billing_exempt is
  'NON-BILLABLE. Confers EVERY feature, including the PAID_ONLY ones (schedule_builds, '
  'quickbooks_sync, on_demand_pricing, crm) and the grantable view_3d, on the entitlement map '
  '(portal-billing), the server-side gates (_shared/featureCheck.ts) and metered AI charges '
  '(_shared/taxMeter.ts). Widened from "skips the billing gate" to "full access" on 2026-09-21; '
  'see migration 228. Never set on a paying customer: it is an entitlement grant worth about '
  '$755/mo, not just a decision to stop charging them.';

comment on column public.client_settings.internal_account is
  'CSM Synergy''s own tenant, not a customer. Confers every feature, same as billing_exempt '
  'does since migration 228 — so this is no longer the only route to full access. Kept because '
  'it ALSO permits claiming an email sending domain on one of our own apexes (portal-settings), '
  'because it is the flag with no UI and so cannot be ticked by accident, and because '
  'entitlement.reason distinguishes ''internal'' from ''exempt''. Never set on a customer.';

-- Rollback: revert the code changes listed above. There is nothing to undo here but the two
-- comments, which can be restored from 057_billing_gate.sql and 169_internal_account.sql.
