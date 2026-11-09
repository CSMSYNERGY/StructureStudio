-- 377_jack_v2.sql -- Jack version 2, record changes (plan: the vault's StructureStudio AI Agent Plan
-- 2026-11-02, section 5.9; defaults confirmed 2026-11-06). Still DARK: nothing here turns Jack on.
--
-- APPLY BY HAND, AFTER A HUMAN HAS READ IT, and only after 375 and 376. Re-read the ledger first and take
-- the next free number:
--     select max(version) from supabase_migrations.schema_migrations where version ~ '^\d{3}$';
--   Run this file as ONE statement batch, then record it:
--     insert into supabase_migrations.schema_migrations (version, name) values ('377', '377_jack_v2') returning version;
--   Zero rows back from `returning` means the number was taken: renumber. NEVER `supabase db push`.
--
-- WHAT THIS ADDS: only the new kinds of card. Version 2 changes records through the routes a person's
-- buttons use (portal-settings, portal-schedule, portal-commissions), so it needs no new table, column,
-- function or grant.
--   inventory_price, inventory_listing, inventory_photos           (jack-agent/inventory.ts)
--   changeorder_attrs, changeorder_unlock                          (changeorders.ts)
--   build_job_add, build_job_change, build_job_built               (buildschedule.ts)
--   delivery_load_create, delivery_stop_add, delivery_stop_reorder,
--   delivery_load_out, delivery_stop_delivered, delivery_load_delivered   (delivery.ts)
--   commission_rate                                                (commissions.ts; private, but holds no
--                                                                   customer contents, so jack_clear_old_private
--                                                                   leaves it: its before and after is the record)
-- jack-agent kinds_test.ts reads this file and checks the list is exactly the kinds the code knows.

alter table public.jack_proposals drop constraint if exists jack_proposals_kind_check;
alter table public.jack_proposals add constraint jack_proposals_kind_check check (kind in (
  -- 375: the sizes table and doors
  'price_sheet', 'size_rule', 'new_fixture',
  -- 376 (v1)
  'memory',
  'setup_company', 'setup_paperwork', 'setup_styles', 'setup_fixture', 'setup_locations', 'setup_tick', 'setup_guide',
  'automation_rule', 'automation_pause',
  'lookup', 'reply_draft',
  -- 377 (v2): record changes
  'inventory_price', 'inventory_listing', 'inventory_photos',
  'changeorder_attrs', 'changeorder_unlock',
  'build_job_add', 'build_job_change', 'build_job_built',
  'delivery_load_create', 'delivery_stop_add', 'delivery_stop_reorder', 'delivery_load_out', 'delivery_stop_delivered', 'delivery_load_delivered',
  'commission_rate'
));

-- ── Proof ─────────────────────────────────────────────────────────────────────────────────────────────
do $proof$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'jack_proposals_kind_check' and conrelid = 'public.jack_proposals'::regclass
       and pg_get_constraintdef(oid) like '%commission_rate%' and pg_get_constraintdef(oid) like '%reply_draft%'
  ) then
    raise exception '377: jack_proposals_kind_check must list the v1 and v2 kinds';
  end if;
  if has_table_privilege('authenticated', 'public.jack_proposals', 'select') or has_table_privilege('anon', 'public.jack_proposals', 'select') then
    raise exception '377: jack_proposals must stay service role only';
  end if;
end
$proof$;
