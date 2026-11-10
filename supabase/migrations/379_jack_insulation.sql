-- 379_jack_insulation.sql -- Jack: one new kind of card, insulation prices (jack-agent/insulation.ts).
-- Carolyn, 11-09 call: "change my price of spray foam to $2.80" had no card to go to. Still behind the
-- same switches: nothing here turns Jack on for anyone.
--
-- APPLY BY HAND, AFTER A HUMAN HAS READ IT, and only after 375 to 378. Re-read the ledger first and take
-- the next free number:
--     select max(version) from supabase_migrations.schema_migrations where version ~ '^\d{3}$';
--   Run this file as ONE statement batch, then record it:
--     insert into supabase_migrations.schema_migrations (version, name) values ('379', '379_jack_insulation') returning version;
--   Zero rows back from `returning` means the number was taken: renumber. NEVER `supabase db push`.
--   Apply it BEFORE deploying the jack-agent that writes the card: until then the insert is refused and
--   Jack says the card couldn't be made.
--
-- WHAT THIS ADDS: only the kind. The card saves through portal-settings save_insulation, the route the
-- Insulation tab's own Save uses, with the person's token, so it needs no new table, column, function or
-- grant. It holds rates only, no customer contents, so jack_clear_old_private leaves it.
-- jack-agent kinds_test.ts reads this file and checks the list is exactly the kinds the code knows.

set local lock_timeout = '5s';

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
  'commission_rate',
  -- 378 (v2, round 2): sends
  'reply_send', 'estimate_resend',
  -- 379: insulation prices
  'insulation_price'
));

-- ── Proof ─────────────────────────────────────────────────────────────────────────────────────────────
do $proof$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'jack_proposals_kind_check' and conrelid = 'public.jack_proposals'::regclass
       and pg_get_constraintdef(oid) like '%commission_rate%' and pg_get_constraintdef(oid) like '%reply_draft%'
       and pg_get_constraintdef(oid) like '%reply_send%' and pg_get_constraintdef(oid) like '%estimate_resend%'
       and pg_get_constraintdef(oid) like '%insulation_price%'
  ) then
    raise exception '379: jack_proposals_kind_check must list every earlier kind and insulation_price';
  end if;
  if has_table_privilege('authenticated', 'public.jack_proposals', 'select') or has_table_privilege('anon', 'public.jack_proposals', 'select') then
    raise exception '379: jack_proposals must stay service role only';
  end if;
end
$proof$;
