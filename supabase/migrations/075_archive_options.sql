-- 075_archive_options: ARCHIVE an option (built-in layout item OR catalog fixture) instead of
-- deleting/deactivating it. An archived option is retired from NEW builds but MUST never disappear
-- from existing designs — a saved plan keeps every item it ever had, forever.
--
--   * client_layout_items.archived  → built-in doors/windows/ramps.
--   * fixture_items.archived         → catalog doors/windows/ramps.
--
-- Behaviour:
--   - get_config KEEPS an archived built-in in layoutItems (so old designs still RENDER it) but
--     flags it noPalette + archived → the designer won't offer it for new placement and can mark
--     placed instances as "archived, please swap".
--   - get_fixtures DROPS archived catalog fixtures from the designer's list (so the picker won't
--     offer them). Their already-placed items carry a full snapshot and render regardless; the
--     designer marks any placed catalog item whose fixture is no longer in the active list.
--   - The owner portal reads fixture_items / client_layout_items directly (catalog action), so it
--     still SHOWS archived options (sorted to the bottom, badged) for un-archiving.
-- Distinct from `active=false` (which fully removes an item). HAND-APPLY via MCP; record in ledger.

alter table public.client_layout_items add column if not exists archived boolean not null default false;
alter table public.fixture_items      add column if not exists archived boolean not null default false;

-- get_config: include archived built-ins (render-only), flagged noPalette+archived.
create or replace function public.get_config(p_client_id text)
returns jsonb language sql stable security definer set search_path to ''
as $function$
  select case when cc.client_id is null then null else jsonb_build_object(
    'clientId', cc.client_id,
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
               || case when coalesce(cli.archived, false) then jsonb_build_object('noPalette', true, 'archived', true) else '{}'::jsonb end)
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

-- get_fixtures: DROP archived catalog fixtures from the designer list (picker won't offer them).
create or replace function public.get_fixtures(p_client_id text)
returns jsonb language plpgsql stable security definer set search_path to ''
as $function$
declare
  v_show    boolean;
  v_items   jsonb;
  v_mode    text; v_method text; v_img text; v_showimg boolean; v_price numeric;
begin
  if not exists (select 1 from public.client_configs where client_id = p_client_id) then
    raise exception 'unknown client';
  end if;

  select coalesce(cs.show_pricing, false), cs.ramp_mode, cs.ramp_price_method, cs.ramp_image_url, cs.ramp_show_image, cs.ramp_price
    into v_show, v_mode, v_method, v_img, v_showimg, v_price
    from public.client_settings cs where cs.client_id = p_client_id;
  v_show := coalesce(v_show, false);

  select coalesce(jsonb_agg(
    case when v_show then
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
    end
    order by fi.category, fi.sort_order, fi.name)
    , '[]'::jsonb)
  into v_items
  from public.fixture_items fi
  where fi.client_id = p_client_id and fi.active
    and fi.price is not null
    and coalesce(fi.archived, false) = false;

  return jsonb_build_object(
    'items', v_items,
    'ramp', jsonb_build_object(
      'mode', coalesce(v_mode, 'simple'),
      'method', coalesce(v_method, 'each'),
      'imageUrl', v_img,
      'showImage', coalesce(v_showimg, true)
    ) || (case when v_show then jsonb_build_object('price', v_price) else '{}'::jsonb end)
  );
end;
$function$;
