-- 220_size_dimensions_not_a_price.sql — a size's WIDTH and LENGTH are not prices, and
-- withholding them silently deleted every square-foot line from the customer's quote.
--
-- NUMBERING: the repo folder runs to 219 and the live ledger carries timestamp-versioned rows
-- beyond that. Check BOTH before adding 221.
--
-- FOUND BY TESTING CLADDING ON EVERY BUILDING (Carolyn 2026-09-07: "make sure it all works
-- accurately on every building"). The audit asked a simple question of all seven tenants —
-- for every size a customer can actually pick, can the browser resolve its width and length? —
-- and three tenants answered NO for every single size they sell: demo-sheds (28 sizes),
-- testtttttt (33) and yoder-barns (175). Those are exactly the three tenants with
-- show_pricing = false.
--
-- WHY. get_config emitted the WHOLE sizePricing map only when show_pricing was on, and '{}'
-- otherwise. But computeSelectionRows reads the building's geometry out of that same map:
--
--     const bW = (szRow && szRow.widthFt != null) ? Number(szRow.widthFt) : 0;
--     const buildingPerimeter = 2 * (bW + bL);
--
-- so on a hide-prices tenant every quantity derived from the building collapsed to zero:
--
--   * CLADDING — the new line is guarded on `cladQty > 0`, so it never appeared at all. The
--     customer picked a siding, saw no mention of it, and then submit-estimate charged for it
--     from the real dimensions in the payload. Preview and estimate disagreed completely.
--   * INSULATION — same shape (`if (sqft <= 0) return;`), so no insulation line either. This
--     one is OLDER than cladding and had been true since 177. Migration 182's header states
--     the opposite as the intent — "a tenant who hides prices still gets the choice, still
--     sees the square footage, and simply gets no number" — which could not happen, because
--     the square footage was never computable.
--   * TALLER WALLS — pushed a line reading 0 ft of wall.
--
-- THE FIX IS TO GATE THE PRICE, NOT THE SHAPE — the colors[] idiom this function already uses
-- everywhere else: null the number, keep the row. A size LABEL is "12x24"; its dimensions are
-- published to the customer the moment they open the dropdown. There was never anything to
-- withhold, and withholding it cost three tenants every square-foot line on every building.
--
-- SAFE FOR THE BUILDING LINE: both call sites read `szRow.basePrice != null ? Number(...) : 0`,
-- so a null price yields the same 0 an absent szRow yielded. Nothing else in either twin reads
-- sizePricing.

begin;

do $mig$
declare
  src      text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk  text;
  new_blk  text;
begin
  old_blk := $anchor$    'sizePricing', case
      when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
      then coalesce((
        select jsonb_object_agg(st.key, sizes.map)
        from public.building_styles st
        cross join lateral (
          select jsonb_object_agg(sz.label, jsonb_build_object(
                   'basePrice', sz.base_price, 'widthFt', sz.width_ft, 'lengthFt', sz.length_ft)) as map
          from public.building_sizes sz
          where sz.style_id = st.id and sz.active
        ) sizes
        where st.client_id = cc.client_id and st.active and sizes.map is not null
      ), '{}'::jsonb)
      else '{}'::jsonb end$anchor$;

  new_blk := $repl$    'sizePricing', coalesce((
        select jsonb_object_agg(st.key, sizes.map)
        from public.building_styles st
        cross join lateral (
          select jsonb_object_agg(sz.label, jsonb_build_object(
                   -- The PRICE is gated; the DIMENSIONS are not. Nulled rather than dropped,
                   -- the colors[] idiom, so a hide-prices tenant keeps the shape and loses only
                   -- the number. Emitting the map unconditionally is what restores the quantity
                   -- to every square-foot line (cladding, insulation, taller walls) on the three
                   -- tenants that hide prices.
                   'basePrice', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
                                     then sz.base_price else null end,
                   'widthFt', sz.width_ft, 'lengthFt', sz.length_ft)) as map
          from public.building_sizes sz
          where sz.style_id = st.id and sz.active
        ) sizes
        where st.client_id = cc.client_id and st.active and sizes.map is not null
      ), '{}'::jsonb)$repl$;

  if position($chk$'sizePricing', coalesce(($chk$ in src) > 0 then
    raise notice '220: get_config already emits size dimensions unconditionally.';
    return;
  end if;
  if position(old_blk in src) = 0 then
    raise exception '220: the show_pricing-gated sizePricing block was not found in the LIVE '
                    'get_config body — re-derive the anchor from a fresh pg_get_functiondef dump.';
  end if;
  execute replace(src, old_blk, new_blk);
end
$mig$;

commit;

-- Retest afterwards by asking the original question again: for every size a customer can pick,
-- on every tenant, does sizePricing carry a positive widthFt and lengthFt? The answer must be
-- yes for all seven, including the three that hide prices.
