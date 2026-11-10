-- 380_jack_option_prices.sql -- Jack: one new kind of card, option prices (jack-agent/options.ts).
-- Carolyn, 11-09 call: Jack should handle "every option". This is the prices on Interior items, colors
-- (paint, shingle, metal, and a color's door price) and Electrical items. Still behind the same switches:
-- nothing here turns Jack on for anyone.
--
-- APPLY BY HAND, AFTER A HUMAN HAS READ IT, and only after 375 to 379. Re-read the ledger first and take
-- the next free number:
--     select max(version) from supabase_migrations.schema_migrations where version ~ '^\d{3}$';
--   Run this file as ONE statement batch, then record it:
--     insert into supabase_migrations.schema_migrations (version, name) values ('380', '380_jack_option_prices') returning version;
--   Zero rows back from `returning` means the number was taken: renumber. NEVER `supabase db push`.
--   Apply it BEFORE deploying the jack-agent that writes the card, and deploy portal-settings (its
--   set_color_prices and set_electrical_prices) before jack-agent too.
--
-- WHAT THIS ADDS: only the kind. The card saves interior items through portal-settings save_layout_pricing
-- (the tab's own save) and colors and electrical items through set_color_prices / set_electrical_prices,
-- price columns only, by id, with the person's token. No new table, column, function or grant. It holds
-- prices only, no customer contents, so jack_clear_old_private leaves it.
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
  'insulation_price',
  -- 380: option prices (interior items, colors, electrical)
  'option_price'
));

-- ── Proof ─────────────────────────────────────────────────────────────────────────────────────────────
do $proof$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'jack_proposals_kind_check' and conrelid = 'public.jack_proposals'::regclass
       and pg_get_constraintdef(oid) like '%commission_rate%' and pg_get_constraintdef(oid) like '%reply_draft%'
       and pg_get_constraintdef(oid) like '%reply_send%' and pg_get_constraintdef(oid) like '%estimate_resend%'
       and pg_get_constraintdef(oid) like '%insulation_price%' and pg_get_constraintdef(oid) like '%option_price%'
  ) then
    raise exception '380: jack_proposals_kind_check must list every earlier kind and option_price';
  end if;
  if has_table_privilege('authenticated', 'public.jack_proposals', 'select') or has_table_privilege('anon', 'public.jack_proposals', 'select') then
    raise exception '380: jack_proposals must stay service role only';
  end if;
end
$proof$;
