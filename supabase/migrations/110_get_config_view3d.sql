-- 110_get_config_view3d: tell the anonymous public designer whether this tenant has 3D.
--
-- WHY A WHOLE FUNCTION RE-EMIT: get_config is one monolithic jsonb_build_object and every
-- change to it has been a full `create or replace` (014 -> 019 -> 024 -> 033 -> 034 -> 035 ->
-- 036 -> 038 -> 039 -> 040 -> 081 -> 083). This body is 083's, copied MECHANICALLY (extracted
-- from the file, one key inserted programmatically) rather than retyped -- get_config is
-- anon-callable and serves every tenant's public designer, so a transcription slip here breaks
-- every shopfront at once with no branch gate in front of it.
--
-- The ONLY delta from 083 is the 'view3d' key. Diff it against 083 to confirm that.
-- ROLLBACK is one statement: re-run 083's function body.

create or replace function public.get_config(p_client_id text)
returns jsonb language sql stable security definer set search_path to ''
as $function$
  select case when cc.client_id is null then null else jsonb_build_object(
    'clientId', cc.client_id,
    -- 3D visibility for the ANONYMOUS public designer. The portal can ask portal-billing
    -- for an entitlement; index.html has no session and never can, so the flag has to ride
    -- along with the config it already fetches.
    --
    -- Sourced from the GRANT TABLE ONLY, deliberately not from the exempt/subscription logic
    -- portal-billing runs. One input rather than a second, drifting copy of entitlement -- and
    -- correct for now because view_3d is `coming_soon` and therefore unpurchasable, so a grant
    -- is the only way it can be true. WHEN view_3d GOES ON SALE: add the subscription branch
    -- here AND fix the Deposyt plans, which are still at the retired $275/$2750 (see
    -- 095_3dview_third_reprice.sql).
    --
    -- Anon-callable, so this emits a BOOLEAN and nothing else: never the grant row, never who
    -- granted it, never a plan or a price.
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
               || case when coalesce(cli.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end)
      from public.client_layout_items cli
      join public.layout_item_types lt on lt.item_key = cli.item_key and lt.active
      where cli.client_id = cc.client_id and (cli.active or coalesce(cli.archived, false))), '{}'::jsonb),
    'colors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'label', c.label,
               'siding', c.siding, 'trim', c.trim,
               'shingle', c.shingle, 'metal', c.metal,
               'allowCustom', c.allow_custom, 'isDefault', c.is_default,
               'hex', c.hex, 'swatch', c.image_url,
               'rate', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then c.rate else null end,
               'pricingMethod', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then c.pricing_method::text else null end)
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
