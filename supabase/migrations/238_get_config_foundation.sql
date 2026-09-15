-- 238_get_config_foundation: get_config emits the tenant's offered foundation items.
-- Applied live 2026-09-14; this file records what ran.
--
-- Emitted shape (the 207 cladding rules, item for item):
--   config.foundationItems = [{ id, label|null, basis, rate|null, charged, taxable?: false, internalOnly?: true }]
-- - only ACTIVE rows WITH a rate are emitted, so an emitted rate of null can only mean "this
--   tenant hides prices" (show_pricing off) — one meaning per null;
-- - `charged` is computed from the real number server-side and always present, because the
--   rate is nulled for hide-prices tenants and 0 means included;
-- - taxable / internalOnly are SPARSE: only when false / true, so an all-default catalog is
--   byte-identical to today.
--
-- SPLICE on the claddingOptions block (207), which no later migration has touched (221 made no
-- get_config change; 220/222–228 anchor elsewhere). Idempotent; RAISES on a drifted body.

do $mig$
declare
  src     text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text := $anchor$    'claddingOptions', coalesce(($anchor$;
  new_blk text := $repl$    'foundationItems', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', fi.item_id,
                 'label', nullif(btrim(coalesce(fi.label_override, '')), ''),
                 'basis', fi.basis,
                 'rate', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then fi.rate else null end,
                 'charged', coalesce(fi.rate, 0) > 0)
               || case when coalesce(fi.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end
               || case when coalesce(fi.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
               order by fi.sort_order, fi.item_id)
      from public.foundation_items fi
      where fi.client_id = cc.client_id and fi.active and fi.rate is not null), '[]'::jsonb),
    'claddingOptions', coalesce(($repl$;
begin
  if position('foundationItems' in src) > 0 then
    raise notice '238: get_config already emits foundationItems — nothing to do';
    return;
  end if;
  if position(old_blk in src) = 0 then
    raise exception '238: the claddingOptions block was not found in the LIVE get_config body — re-derive the anchor from a fresh pg_get_functiondef dump before applying';
  end if;
  execute replace(src, old_blk, new_blk);
end
$mig$;
