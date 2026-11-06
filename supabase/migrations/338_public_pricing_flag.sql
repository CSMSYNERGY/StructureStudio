-- 338 — the customer-facing page shows NO prices, whoever is signed in.
--
-- 337 made get_config answer the CALLER: a builder's own staff and our operators get the real
-- prices even where the tenant hides them. The designer's component is the same on both pages and
-- its Supabase client restores the portal session on the SAME ORIGIN, so a signed-in rep opening
-- the tenant's own public link got the staff answer there too — prices and a subtotal on the page
-- a shopper reads. Carolyn, 2026-10-26: "if pricing is off, that means no pricing".
--
-- Visibility is therefore TWO questions, and 337 only answered one:
--   * WHO is asking   → ss_prices_visible (unchanged, still the only source of the money).
--   * WHICH PAGE      → the designer: the portal shows the caller's answer, the public page shows
--                       the tenant's own setting and nothing more.
-- This migration adds the second question's input: `showPricingPublic`, the raw
-- client_settings.show_pricing with no caller in it. The config loader reads it when the designer
-- is NOT embedded and uses it as `showPricing`, so no price renders on a customer-facing page for
-- a hide-prices tenant no matter who is signed in.
--
-- Rollback:
--   begin;
--   do $rb$
--   declare src text;
--   begin
--     src := pg_get_functiondef('public.get_config(text)'::regprocedure);
--     src := replace(src, $k$    'showPricingPublic', coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false),
$k$, '');
--     execute src;
--   end $rb$;
--   delete from supabase_migrations.schema_migrations where version = '338';
--   notify pgrst, 'reload schema';
--   commit;

begin;

do $m338$
declare
  src     text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text := $anchor$    'showPricing', public.ss_prices_visible(cc.client_id),$anchor$;
  new_blk text := $repl$    'showPricing', public.ss_prices_visible(cc.client_id),
    -- The TENANT's own answer, with no caller in it: what the customer-facing page must show.
    'showPricingPublic', coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false),$repl$;
begin
  if position('showPricingPublic' in src) > 0 then
    raise notice '338: get_config already emits showPricingPublic';
    return;
  end if;
  if position(old_blk in src) = 0 then
    raise exception '338: 337''s showPricing line was not found in the LIVE get_config body — re-derive the anchor from a fresh pg_get_functiondef dump before applying';
  end if;
  execute replace(src, old_blk, new_blk);
end $m338$;

-- Every tenant now answers the raw setting on that key, for a caller with no JWT and for one with.
do $check$
declare bad text;
begin
  select string_agg(cc.client_id, ', ') into bad
  from public.client_configs cc
  where (public.get_config(cc.client_id)->>'showPricingPublic')::boolean
        is distinct from coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false);
  if bad is not null then
    raise exception '338: showPricingPublic does not match client_settings for: %', bad;
  end if;
end $check$;

notify pgrst, 'reload schema';

commit;
