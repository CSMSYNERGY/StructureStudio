-- 362_billing_shed_naming.sql — two plans say "for sheds" out loud.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header) or apply via MCP, then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('362', '362_billing_shed_naming') returning version;
--    NEVER `supabase db push`.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- 362 = max(live ledger, this folder) + 1, both read at 361 immediately before writing (361 was
-- applied earlier today). Re-read BOTH right before applying — four agents write migrations here.
--
-- ── WHY (Carolyn, 2026-11-05) ────────────────────────────────────────────────────────────
-- "Scheduler should be named Shed Scheduler. Structure Studio Suite renamed to FULL Suite for
-- Sheds." The same move as 359: the product is being sold to post-frame and barndominium builders
-- now, and the shed-only pieces have to say so rather than reading like the whole platform. A
-- SmartBuild builder looking at the Billing tab should be able to tell at a glance which tiles are
-- not for them — "SCHEDULER" and "Structure Studio Suite" both read as everybody's.
--
--   SCHEDULER              -> Shed Scheduler
--   Structure Studio Suite -> FULL Suite for Sheds
--
-- Both rows per feature (monthly and annual) carry the name, so both move.
--
-- ⚠️ THE SUITE'S "Includes …" LINE IS DERIVED, so it follows this automatically. BillingView
-- builds it from SUITE_MEMBERS against the plan names (359's change, so the line can never drift
-- from the entitlement map): it will now read "Includes Simple Layout, Shed Scheduler, 3D View,
-- QuickBooks Sync, RealTime Pricing, Customer Hub." Nothing to edit for that.
--
-- ⚠️ WHAT THIS MUST NOT TOUCH, and the reason it is called out here: "CSM Capital LLC DBA Structure
-- Studio Suite" is the LEGAL BUSINESS NAME registered with the carriers for A2P texting, and it
-- appears in `_shared/smsComplianceCheck.ts`, its tests, and the registered opt-in sentence. That
-- string is not this product name and renaming it would make the SMS registration false. This
-- migration only writes `billing_plans.name`.
--
-- Not a release note: a plan's name is packaging, and the 2026-07-26 rule keeps pricing and
-- packaging presentation out of What's New. The commit carries `Release-note: none`.
--
-- Rollback:
--   update public.billing_plans set name = 'SCHEDULER'              where feature = 'schedule_builds';
--   update public.billing_plans set name = 'Structure Studio Suite' where feature = 'full_suite';

begin;

update public.billing_plans set name = 'Shed Scheduler'       where feature = 'schedule_builds';
update public.billing_plans set name = 'FULL Suite for Sheds' where feature = 'full_suite';

-- ── CHECKS ──────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_sched text;
  v_suite text;
  v_inc   text;
begin
  select string_agg(distinct name, ' / ') into v_sched from public.billing_plans where feature = 'schedule_builds';
  if v_sched <> 'Shed Scheduler' then
    raise exception '362: schedule_builds reads %, and both intervals must agree', v_sched;
  end if;

  select string_agg(distinct name, ' / ') into v_suite from public.billing_plans where feature = 'full_suite';
  if v_suite <> 'FULL Suite for Sheds' then
    raise exception '362: full_suite reads %, and both intervals must agree', v_suite;
  end if;

  -- The derived Includes line, assembled the way BillingView assembles it, so this migration
  -- fails rather than quietly shipping a Suite tile that still lists "SCHEDULER" inside itself.
  select string_agg(distinct name, ', ' order by name) into v_inc
    from public.billing_plans
   where feature in ('simple_layout', 'schedule_builds', 'view_3d', 'quickbooks_sync', 'on_demand_pricing', 'crm');
  if v_inc not like '%Shed Scheduler%' then
    raise exception '362: the Suite still lists the old scheduler name: %', v_inc;
  end if;

  -- Nothing else moved: eight other features keep their names, and no plan became required.
  if exists (select 1 from public.billing_plans where required) then
    raise exception '362: a plan is required again — see 359';
  end if;
end $$;

commit;
