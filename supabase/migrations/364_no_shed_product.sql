-- 364_no_shed_product.sql — a builder who does not sell sheds stops being shown the shed product.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header) or apply via MCP, then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('364', '364_no_shed_product') returning version;
--    NEVER `supabase db push`.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- 364 = max(live ledger, this folder) + 1. ⚠️ This file was written and applied as 363 and
-- RENUMBERED: by the time the ledger row was being recorded, another agent had taken 363
-- (`363_crm_rules_scope_and_conditions`) in the live ledger, minutes apart. That is exactly why
-- the rule says to re-read BOTH right before applying — four agents write migrations here, and
-- "I read the max an hour ago" is not a reading. The DDL had already gone in under the
-- MCP's own timestamp version, so the stray timestamp row was removed and '364' recorded by
-- hand; the column itself was never applied twice (`add column if not exists`).
--
-- ── WHY (Carolyn, 2026-11-05) ────────────────────────────────────────────────────────────
-- "Since I am making the decision to sell Structure Studio without a shed designer there's a lot
-- of things that need to be changed for this onboarding with Joe. We don't need Shed Designer on
-- the side, we don't need Inventory, Orders, Build Schedule, Delivery Schedule, Repairs,
-- Commissions — those should all just go away. He's not a shed diva, so he only needs the company
-- setup and the stuff for the CRM, the phone, the email. Definitely not GoHighLevel, and he's not
-- emailing quotes from here, so that all goes away as well."
--
-- Joe Dalmolin (TEXCO) bought Customer Hub + the SmartBuild integration and no designer. The
-- portal's rail is deliberately a SALES SURFACE — every unbought page stays visible with a padlock
-- so a builder can see the whole product — and for a shed builder in a trial that is right. For a
-- post-frame builder it is wrong in a way a padlock cannot fix: those pages are not "not yet", they
-- are never. Eight padlocks he will never open make the product look broken rather than bigger.
--
-- ── WHAT THIS IS, AND WHAT IT IS NOT ─────────────────────────────────────────────────────
-- `sheds_enabled` is an ACCOUNT SHAPE, not an entitlement and not a permission:
--   * It grants nothing. Every gate, padlock and 403 behaves exactly as before — a builder with
--     this off who somehow held `schedule_builds` would still be refused by the same rules.
--   * It is not `billing_exempt` and it is not a feature grant. It only decides what is OFFERED.
--   * The SERVER is unchanged. Nothing here stops an action; it stops a page being shown and its
--     route resolving (ssClampTab), the same two-part treatment the Coming Soon group has.
--
-- ⚠️ DEFAULT TRUE, AND THE FAILURE DIRECTION IS DELIBERATE. Every builder on the platform sells
-- sheds, so the column defaults true and nothing changes for any of them. The browser hides a page
-- ONLY on an explicit `false` (01-core's ssShedsOn: no entitlement yet, an older portal-billing
-- that does not send the field, or a failed read all read as sheds ON). Hiding the designer from a
-- shed builder would be the whole product disappearing; showing Joe a tab he does not need is
-- cosmetic. The read in portal-billing is fail-soft for the same reason and is NOT in the fatal
-- client_settings select — the advanced_mode precedent (270 PART 5), for the reason named there: a
-- database without the column would answer 42703 and every tenant's billing call would be a 500.
--
-- ── WHAT GOES AWAY WHEN IT IS FALSE ──────────────────────────────────────────────────────
-- Workspace rail (and their routes): Shed Designer, Advanced, Inventory, Orders, Build Schedule,
--   Delivery Schedule, Repairs, Commissions, 3D Design.
-- Settings rail: Sheds, Options, Colors, Designer, Online Inventory, GHL Connection.
-- Inside Company: Branding, Locations, Sales Tax, Payments, Commissions.
-- Inside Customer Hub: Customer login (it exists so a customer can accept an estimate and pay an
--   invoice — paperwork this builder does not issue).
-- KEPT: Customer Hub and all of its pipelines/forms/email/text/phone/meetings tabs, Conversations,
--   Calls, Company → Business Details and Team, Billing, QuickBooks, Support, My Profile, My View.
--   Billing and QuickBooks stay by Carolyn's decision — neither is shed-specific, and she should
--   not have to ask us to let a builder connect their accounting.
--
-- GHL Connection rides on this flag rather than one of its own because this shape IS "quotes
-- elsewhere, customers here": the builder works leads in our Hub and prices in SmartBuild. If a
-- post-frame builder ever wants GoHighLevel, that is a second switch, not a reason to widen this
-- one — say so rather than quietly re-showing it.
--
-- Not a release note: nothing a builder can newly DO. The commit carries `Release-note: none`.
--
-- Rollback:
--   update public.client_settings set sheds_enabled = true where client_id = '<slug>';
--   -- or, to retire the idea entirely:
--   -- alter table public.client_settings drop column sheds_enabled;

begin;

alter table public.client_settings
  add column if not exists sheds_enabled boolean not null default true;

comment on column public.client_settings.sheds_enabled is
  'Account SHAPE, not an entitlement: false hides the shed product (designer, catalog, inventory, '
  'orders, scheduling, repairs, commissions, GHL, our estimate paperwork) from the rail and clamps '
  'those routes. Grants nothing and refuses nothing — see migration 364. Default true.';

-- ── CHECKS ──────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_off integer;
  v_nul integer;
begin
  -- Nobody is switched off by the migration itself. A tenant is put into this shape by hand,
  -- one at a time, with somebody looking at it.
  select count(*) into v_off from public.client_settings where sheds_enabled = false;
  if v_off <> 0 then
    raise exception '364: % tenant(s) already have sheds off — this migration must not switch anyone', v_off;
  end if;

  -- NOT NULL with a default, so the browser's "explicit false" test can never meet a null.
  select count(*) into v_nul from public.client_settings where sheds_enabled is null;
  if v_nul <> 0 then
    raise exception '364: sheds_enabled is null on % row(s)', v_nul;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_settings'
       and column_name = 'sheds_enabled' and is_nullable = 'NO' and column_default like '%true%'
  ) then
    raise exception '364: sheds_enabled must be NOT NULL DEFAULT true';
  end if;
end $$;

commit;
