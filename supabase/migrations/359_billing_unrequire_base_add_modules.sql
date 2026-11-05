-- 359_billing_unrequire_base_add_modules.sql — Simple Layout stops being the required base,
-- and the two post-frame modules go on the Billing tab as Coming soon.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, and AFTER portal-billing is deployed (see the
--    ORDER section below). Pipe this file to `supabase db query --linked` (stdin; see 270's
--    header) or apply via MCP, then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('359', '359_billing_unrequire_base_add_modules') returning version;
--    NEVER `supabase db push`.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- 359. Written as 354 against this folder, which ended at 353 — and the LIVE ledger already
-- read 358 (354_crm_statuses_per_pipeline … 358_book_meeting_override, all applied from clones
-- this one has never seen). Exactly the trap 353's header documents: take max(live ledger, this
-- folder) + 1, and re-read BOTH right before applying.
--   select version, name from supabase_migrations.schema_migrations where length(version) <= 4 order by version::int desc limit 5;
--   ls supabase/migrations | sed 's/_.*//' | sort -n | tail -3
--
-- ── WHY (Carolyn, 2026-11-04) ────────────────────────────────────────────────────────────
-- StructureStudio was built and sold for shed builders. The first post-frame builder (TEXCO,
-- signed 2026-10-30) bought Customer Hub and a SmartBuild integration and nothing else — no
-- designer. The Billing tab could not sell that: `required` on simple_layout made the checkout
-- refuse any cart without it, and padlocked the nav of any tenant that did not hold it.
--
-- ⚠️ ORDER: DEPLOY portal-billing BEFORE APPLYING THIS.
-- The DEPLOYED-BEFORE gate reads `else if (requiredFeatures.length > 0)`. Clearing the flag
-- under that code empties the list, the branch never runs, `entState` keeps its "active"
-- initialiser, and EVERY non-exempt tenant reads as unlocked — the whole portal, free, with
-- nothing looking wrong. The new portal-billing keys the gate on "any usable subscription"
-- instead and does not read `required` at all, so it is correct both before and after this file.
--
-- Checked before writing this: every tenant holding a usable subscription today holds
-- simple_layout or full_suite (junior-barns, midwest-mini-barns, preferred-structures,
-- yoder-barns; structure-studio is exempt), so "any usable subscription" and "holds the
-- required base" give the same answer for every existing row. Nobody's access moves.
--
-- Rollback: update billing_plans set required = true where feature = 'simple_layout';
--           delete from billing_plans where feature in ('smartbuild_sync','project_management');
--           -- and redeploy the previous portal-billing, in that order.

begin;

-- ── 1. Nothing is required any more ─────────────────────────────────────────────────────
update public.billing_plans set required = false, updated_at = now()
where feature = 'simple_layout';

do $$
begin
  if exists (select 1 from public.billing_plans where required) then
    raise exception '359: a plan is still marked required — the new gate assumes none is';
  end if;
end $$;

-- ── 2. SmartBuild Sync and Project Management ───────────────────────────────────────────
-- Both COMING SOON: neither module is built. price_visible stays true so the Billing tab
-- prints the price under the overlay (Self Serve Displays is the opposite case — no price
-- announced, so its flag is false and it renders "Pricing announced at launch").
--
-- setup_fee_cents NULL renders "Setup fee: TBD". Deliberate for both — Carolyn, asked about a
-- SmartBuild setup fee: "I may or may not charge setup fees going forward." Set it to 0 to
-- print "No setup fee" instead.
--
-- sort_order 88 / 86 puts them between RealTime Pricing (90) and Customer Hub (75); the grid
-- renders sort_order DESCENDING.
--
-- ⚠️ gateway_plan_id is a LABEL ONLY since the 2026-08-24 move to the custom-amount form, so no
-- Deposyt plans are needed while these are coming_soon. BEFORE flipping either to 'available',
-- create the matching recurring plans in the StructureStudio Deposyt account (not BuildBridge's)
-- at the same amounts — a price that exists only here is not the price the gateway charges.
--
-- ⚠️ NOT Suite members. Carolyn 2026-11-04: sold separately, the Suite is not repriced. Adding
-- one later means all three copies of BUNDLE_FEATURES (portal-billing, _shared/featureCheck.ts,
-- SUITE_MEMBERS in portal/03-catalog.jsx) plus a price decision.
insert into public.billing_plans
  (id, feature, name, billing_interval, price_cents, gateway_plan_id, setup_fee_cents, availability, required, sort_order, price_visible, active)
values
  ('smartbuild_sync_monthly',    'smartbuild_sync',    'SmartBuild Sync',    'monthly',    8500, 'SS_SMARTBUILD_SYNC_MONTHLY',    null, 'coming_soon', false, 88, true, true),
  ('smartbuild_sync_annual',     'smartbuild_sync',    'SmartBuild Sync',    'annual',    85000, 'SS_SMARTBUILD_SYNC_YEARLY',     null, 'coming_soon', false, 88, true, true),
  ('project_management_monthly', 'project_management', 'Project Management', 'monthly',   25000, 'SS_PROJECT_MANAGEMENT_MONTHLY', null, 'coming_soon', false, 86, true, true),
  ('project_management_annual',  'project_management', 'Project Management', 'annual',   250000, 'SS_PROJECT_MANAGEMENT_YEARLY',  null, 'coming_soon', false, 86, true, true)
on conflict (id) do update set
  name = excluded.name, price_cents = excluded.price_cents, gateway_plan_id = excluded.gateway_plan_id,
  setup_fee_cents = excluded.setup_fee_cents, availability = excluded.availability,
  sort_order = excluded.sort_order, price_visible = excluded.price_visible,
  active = excluded.active, updated_at = now();

commit;
