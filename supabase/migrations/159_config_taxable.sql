-- 159_config_taxable: tell the designer which catalog items are not taxed (migration 158).
--
-- The tax itself is computed SERVER-SIDE in submit-estimate, read straight from the catalog
-- tables — nothing here changes a single number on a quote, an invoice or a customer's screen.
-- This is purely so the designer can SHOW a rep which lines are exempt before they send, which
-- is otherwise only discoverable on the issued PDF.
--
-- BOTH BODIES WERE EXTRACTED FROM THE LIVE DATABASE (pg_get_functiondef) on 2026-08-29 and the
-- taxable emission spliced in programmatically — the standing rule from 110's header, which
-- 117 also followed: get_config is rewritten wholesale by whoever touches it last, ACROSS
-- BRANCHES, so a file in this repo is never proof of what is live. Before applying this file,
-- re-run the check and diff against these bodies minus the taxable lines:
--   select pg_get_functiondef(p.oid) from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname in ('get_config','get_fixtures');
-- Expect ZERO other differences. Any difference means someone changed a function after
-- 2026-08-29 and this file must be regenerated the same way rather than applied.
--
-- Captured state at extraction: get_config 8670 chars (view3d/110, doorRate/117 present),
-- get_fixtures 3784 chars (sillIn+sillMode/139 present). Neither carried `taxable`.
--
-- SPARSE EMISSION, deliberately. `'taxable', false` is emitted ONLY for a non-taxable row —
-- the same idiom internalOnly, doorSnap and archived already use here. Three reasons: the
-- payload for an all-taxable catalog (which is every tenant today) stays byte-identical, so
-- applying this changes nothing anyone can observe; the browser convention is already
-- `taxable !== false` everywhere it was wired; and get_config reaches every ANONYMOUS visitor,
-- so a key per catalog row for the default case is bytes on every page load for nothing.
--
-- LEDGER NOTE: applied live 2026-08-29 via MCP, recorded as 20260829051855 / '159_config_taxable'.
-- VERIFIED ON APPLY, the strongest check available for a wholesale function rewrite: the output
-- of BOTH functions was md5'd for structure-studio and junior-barns BEFORE and AFTER, and came
-- back BYTE-IDENTICAL (config 37625 chars / 13 top-level keys, fixtures 5871 chars). Nothing was
-- dropped, which is the failure this file's own warning exists to prevent. Then one row in each
-- of the four catalogs was flipped non-taxable: exactly one 'taxable': false appeared in each of
-- buildingStyles, layoutItems, colors and get_fixtures.items — and only 1 of 27 colors carried
-- the key, confirming the sparse emission. Reverted, and the md5s returned to baseline.
--
-- Hand-apply via the SQL editor / MCP and record as version 159 — NEVER `supabase db push`.
-- NUMBERING: check BOTH the live ledger AND `git ls-tree origin/beta supabase/migrations/`
-- before the next one. Neither alone was the whole picture for 158, and origin moves fast.

-- ── get_config: building styles, layout items, colors ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_config(p_client_id text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when cc.client_id is null then null else jsonb_build_object(
    'clientId', cc.client_id,
    -- 3D visibility for the ANONYMOUS public designer (migration 110). The portal asks
    -- portal-billing for an entitlement; index.html has no session and never can, so the
    -- flag rides along with the config it already fetches. Sourced from the operator
    -- grant table ONLY (not a mirror of entitlement logic) -- correct while view_3d is
    -- coming_soon and therefore unpurchasable. When it goes on sale, add the
    -- subscription branch here AND fix the Deposyt plans (still at the retired
    -- $275/$2750, see 095_3dview_third_reprice.sql). Anon-callable: emit the boolean
    -- and NOTHING else -- never the grant row, the grantor, a plan or a price.
    'view3d', exists (
      select 1 from public.client_feature_grants g
      where g.client_id = cc.client_id
        and g.feature = 'view_3d'
        and (g.expires_at is null or g.expires_at > now())
    ),
    'branding', jsonb_build_object('companyName', cc.company_name, 'tagline', cc.tagline,
      'logo', cc.logo_url, 'headerBg', cc.header_bg, 'accentColor', cc.accent_color),
    'contactFields', cc.contact_fields,
    'defaultSizes',  cc.default_sizes,
    'options',       cc.options,
    'buildingStyles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'value', st.key, 'label', st.label, 'img', st.image_url,
               'sizes', coalesce((select jsonb_agg(sz.label order by sz.sort_order, sz.label)
                                  from public.building_sizes sz
                                  where sz.style_id = st.id and sz.active), '[]'::jsonb),
               'sizeInclusions', coalesce((
                 select jsonb_object_agg(s2.label, inc.keys)
                 from public.building_sizes s2
                 cross join lateral (
                   select coalesce(jsonb_agg(bsi.item_key order by bsi.item_key), '[]'::jsonb) as keys
                   from public.building_size_inclusions bsi
                   where bsi.size_id = s2.id and bsi.included
                     and not exists (select 1 from public.client_layout_items cli
                                     where cli.client_id = cc.client_id and cli.item_key = bsi.item_key and cli.archived)
                     and not exists (select 1 from public.fixture_items fi
                                     where fi.client_id = cc.client_id and fi.id::text = bsi.item_key and fi.archived)
                 ) inc
                 where s2.style_id = st.id and s2.active and jsonb_array_length(inc.keys) > 0
               ), '{}'::jsonb),
               'sizeInclusionQty', coalesce((
                 select jsonb_object_agg(s2.label, inc.qmap)
                 from public.building_sizes s2
                 cross join lateral (
                   select jsonb_object_agg(bsi.item_key, coalesce(bsi.qty, 1)) as qmap
                   from public.building_size_inclusions bsi
                   where bsi.size_id = s2.id and bsi.included
                     and not exists (select 1 from public.client_layout_items cli
                                     where cli.client_id = cc.client_id and cli.item_key = bsi.item_key and cli.archived)
                     and not exists (select 1 from public.fixture_items fi
                                     where fi.client_id = cc.client_id and fi.id::text = bsi.item_key and fi.archived)
                 ) inc
                 where s2.style_id = st.id and s2.active and inc.qmap is not null
               ), '{}'::jsonb))
               || case when st.d3 is not null then jsonb_build_object('d3', st.d3) else '{}'::jsonb end
               || case when coalesce(st.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end
             order by st.sort_order, st.label)
      from public.building_styles st
      where st.client_id = cc.client_id and st.active), '[]'::jsonb),
    'layoutItems', coalesce((
      select jsonb_object_agg(cli.item_key,
               jsonb_build_object(
                 'label', coalesce(cli.label_override, lt.label),
                 'icon', lt.icon, 'color', lt.color,
                 'width',  coalesce(cli.width_override,  lt.default_width),
                 'height', coalesce(cli.height_override, lt.default_height),
                 'shortLabel', coalesce(cli.short_label_override, lt.short_label),
                 'wallOnly', lt.wall_only, 'wallSnap', lt.wall_snap)
               || case when lt.door_snap then jsonb_build_object('doorSnap', true) else '{}'::jsonb end
               || case when coalesce(cli.archived, false) then jsonb_build_object('noPalette', true, 'archived', true) else '{}'::jsonb end
               || case when coalesce(cli.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
               || case when coalesce(cli.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end)
      from public.client_layout_items cli
      join public.layout_item_types lt on lt.item_key = cli.item_key and lt.active
      where cli.client_id = cc.client_id and (cli.active or coalesce(cli.archived, false))), '{}'::jsonb),
    'colors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'label', c.label,
               'siding', c.siding, 'trim', c.trim,
               'shingle', c.shingle, 'metal', c.metal,
               'door', c.door,
               'allowCustom', c.allow_custom, 'isDefault', c.is_default,
               'hex', c.hex, 'swatch', c.image_url,
               'rate', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then c.rate else null end,
               'pricingMethod', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then c.pricing_method::text else null end,
               'doorRate', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then c.door_rate else null end)
               || case when coalesce(c.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end
             order by c.sort_order, c.label)
      from public.colors c
      where c.client_id = cc.client_id and c.active), '[]'::jsonb),
    'showPricing', coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false),
    'layoutPrices', case
      when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
      then coalesce((select jsonb_object_agg(lp.item_key, lp.rate)
                     from public.layout_item_pricing lp
                     where lp.client_id = cc.client_id and lp.style_id is null), '{}'::jsonb)
      else '{}'::jsonb end,
    'layoutPricing', case
      when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
      then coalesce((
        select jsonb_object_agg(k.item_key, jsonb_build_object(
                 'rate',   coalesce(dflt.rate, 0),
                 'method', coalesce(dflt.pricing_method, 'each'),
                 'byStyle', coalesce(bystyle.map, '{}'::jsonb)))
        from (select distinct item_key from public.layout_item_pricing where client_id = cc.client_id) k
        left join lateral (
          select lp2.rate, lp2.pricing_method
          from public.layout_item_pricing lp2
          where lp2.client_id = cc.client_id and lp2.item_key = k.item_key and lp2.style_id is null
          limit 1
        ) dflt on true
        left join lateral (
          select jsonb_object_agg(st2.key, jsonb_build_object('rate', o.rate, 'method', o.pricing_method)) as map
          from public.layout_item_pricing o
          join public.building_styles st2 on st2.id = o.style_id
          where o.client_id = cc.client_id and o.item_key = k.item_key and o.style_id is not null
        ) bystyle on true
      ), '{}'::jsonb)
      else '{}'::jsonb end,
    'sizePricing', case
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
      else '{}'::jsonb end
  ) end
  from public.client_configs cc where cc.client_id = p_client_id;
$function$;

-- ── get_fixtures: doors, windows, ramps ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_fixtures(p_client_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_show    boolean;
  v_items   jsonb;
  v_wcolors jsonb;
  v_mode    text; v_method text; v_img text; v_showimg boolean; v_price numeric; v_enabled boolean;
begin
  if not exists (select 1 from public.client_configs where client_id = p_client_id) then
    raise exception 'unknown client';
  end if;

  select coalesce(cs.show_pricing, false), cs.ramp_mode, cs.ramp_price_method, cs.ramp_image_url, cs.ramp_show_image, cs.ramp_price, cs.ramp_enabled
    into v_show, v_mode, v_method, v_img, v_showimg, v_price, v_enabled
    from public.client_settings cs where cs.client_id = p_client_id;
  v_show := coalesce(v_show, false);

  select coalesce(jsonb_agg(
    (case when v_show then
      jsonb_build_object(
        'id', fi.id, 'category', fi.category, 'name', fi.name, 'planLabel', fi.plan_label,
        'widthIn', fi.width_in, 'heightIn', fi.height_in, 'price', fi.price,
        'swingIn', fi.swing_in, 'swingOut', fi.swing_out, 'swingDefault', fi.swing_default,
        'opRight', fi.op_right, 'opLeft', fi.op_left, 'opDouble', fi.op_double,
        'opSlideUp', fi.op_slideup, 'opDefault', fi.op_default,
        'imageUrl', fi.image_url, 'sortOrder', fi.sort_order)
    else
      jsonb_build_object(
        'id', fi.id, 'category', fi.category, 'name', fi.name, 'planLabel', fi.plan_label,
        'widthIn', fi.width_in, 'heightIn', fi.height_in,
        'swingIn', fi.swing_in, 'swingOut', fi.swing_out, 'swingDefault', fi.swing_default,
        'opRight', fi.op_right, 'opLeft', fi.op_left, 'opDouble', fi.op_double,
        'opSlideUp', fi.op_slideup, 'opDefault', fi.op_default,
        'imageUrl', fi.image_url, 'sortOrder', fi.sort_order)
    end)
    || case when coalesce(fi.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
    || case when coalesce(fi.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end
    || jsonb_build_object('colorMode', coalesce(fi.color_mode, 'fixed'), 'hasTrimColor', coalesce(fi.has_trim_color, false))
    || case when fi.window_color_ids is not null then jsonb_build_object('windowColorIds', to_jsonb(fi.window_color_ids)) else '{}'::jsonb end
    || case when fi.category = 'window'
              then jsonb_build_object('sillIn', fi.sill_in, 'sillMode', coalesce(fi.sill_mode, 'fixed'))
              else '{}'::jsonb end
    || coalesce((select jsonb_build_object('fixedColor', jsonb_build_object('id', c.id, 'label', c.label, 'hex', c.hex))
                 from public.colors c
                 where c.id = fi.fixed_color_id and c.client_id = fi.client_id and c.active), '{}'::jsonb)
    order by fi.category, fi.sort_order, fi.name)
    , '[]'::jsonb)
  into v_items
  from public.fixture_items fi
  where fi.client_id = p_client_id and fi.active
    and fi.price is not null
    and coalesce(fi.archived, false) = false;

  select coalesce(jsonb_agg(
    (case when v_show then
      jsonb_build_object('id', wc.id, 'label', wc.label, 'hex', wc.hex, 'isDefault', wc.is_default, 'rate', wc.rate)
    else
      jsonb_build_object('id', wc.id, 'label', wc.label, 'hex', wc.hex, 'isDefault', wc.is_default)
    end)
    order by wc.sort_order, wc.label)
    , '[]'::jsonb)
  into v_wcolors
  from public.window_colors wc
  where wc.client_id = p_client_id and wc.active;

  return jsonb_build_object(
    'items', v_items,
    'windowColors', v_wcolors,
    'ramp', jsonb_build_object(
      'mode', coalesce(v_mode, 'simple'),
      'method', coalesce(v_method, 'each'),
      'enabled', coalesce(v_enabled, false),
      'imageUrl', v_img,
      'showImage', coalesce(v_showimg, true)
    ) || (case when v_show then jsonb_build_object('price', v_price) else '{}'::jsonb end)
  );
end;
$function$;

-- Rollback: re-apply the pre-159 bodies — regenerate them from pg_get_functiondef BEFORE
-- applying this file, or reconstruct by deleting the four `taxable` case-lines above (two in
-- get_config's buildingStyles/layoutItems, one in its colors block, one in get_fixtures).
