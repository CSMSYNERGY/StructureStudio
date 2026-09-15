-- 236_get_config_delivery: get_config tells the designer whether delivery is automated.
-- Applied live 2026-09-14; this file records what ran.
--
-- WHY. When delivery_settings.automate is on, the customer designer asks the delivery-quote
-- endpoint for miles + fee as soon as the address is complete and shows the line in its running
-- total. It needs to know WHETHER to ask (and, in the rep designer, whether to offer a
-- suggestion) before it has an address — that is this key. NO RATES are emitted: the browser
-- never prices delivery itself; the endpoint does, from the same _shared modules submit-estimate
-- uses, so nothing here is show_pricing-gated. Booleans only, the 207 rule.
--
-- SPLICE, never a rewrite (the 110/159 rule): get_config is rewritten wholesale on branches we
-- cannot see, so this reads the LIVE body, anchors on the 'showPricing' line (117, untouched by
-- every later splice), inserts the 'delivery' key before it, and RAISES if the anchor is missing
-- rather than guessing.
--
--   config.delivery = { configured, automate, originMode, ruleType, taxable }
--   (configured:false when the tenant has no delivery_settings row; taxable always present.)

do $mig$
declare
  src     text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text := $anchor$    'showPricing', coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false),$anchor$;
  new_blk text := $repl$    'delivery', coalesce((
      select jsonb_build_object(
        'configured', true,
        'automate', ds.automate,
        'originMode', ds.origin_mode,
        'ruleType', ds.rule_type,
        'taxable', coalesce((select cs2.ss_tax_delivery from public.client_settings cs2 where cs2.client_id = cc.client_id), false))
      from public.delivery_settings ds where ds.client_id = cc.client_id),
      jsonb_build_object(
        'configured', false,
        'automate', false,
        'taxable', coalesce((select cs2.ss_tax_delivery from public.client_settings cs2 where cs2.client_id = cc.client_id), false))),
    'showPricing', coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false),$repl$;
begin
  if position('''delivery'', coalesce((' in src) > 0 then
    raise notice '236: get_config already emits delivery — nothing to do';
    return;
  end if;
  if position(old_blk in src) = 0 then
    raise exception '236: the showPricing line was not found in the LIVE get_config body — re-derive the anchor from a fresh pg_get_functiondef dump before applying';
  end if;
  execute replace(src, old_blk, new_blk);
end
$mig$;
