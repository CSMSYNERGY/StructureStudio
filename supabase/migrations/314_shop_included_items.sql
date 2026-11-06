-- 314_shop_included_items.sql — the Online Inventory page lists what comes with each building.
--
-- ⛔ APPLY BY HAND. Pipe to `supabase db query --linked` (stdin), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('314', '314_shop_included_items') returning version, name;
--    REHEARSAL: sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/314_shop_included_items.sql | npx supabase db query --linked -o csv
--
-- ── WHY (Carolyn 2026-10-17) ─────────────────────────────────────────────────────────────
-- "on the right side I also want to list all the items included in this building just like the
-- estimate shows it." get_public_shop (310) gains, per unit:
--   included — the building's placed items (doors, windows, ramps, lofts, shelves, workbenches,
--              rough openings, electrical), each with a display name, size and colour. Notes,
--              drawn lines and staging props are not things that come with the building and are
--              left out. NO PRICES: the asking price is one number the builder sets (a lot price
--              can be a markdown), and per-item prices would contradict it.
--   options  — the building-wide choices: siding type, paint, loft package.
-- Names come from where the designer gets them: doorName / windowName on the item, the builder's
-- label_override for layout items, electrical_items.name for electrical. Everything else in 310's
-- function is unchanged.

begin;

create or replace function public.get_public_shop(p_client_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_shop public.shop_settings;
  v_cfg record;
  v_pay boolean;
  v_units jsonb;
  v_photo_base text := 'https://jzeamjbhdrsbygdnphbm.supabase.co/storage/v1/object/public/inventory-photos/';
begin
  if p_client_id is null or p_client_id !~ '^[a-z0-9-]{1,64}$' then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into v_shop from public.shop_settings where client_id = p_client_id;
  if not found or not v_shop.enabled then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select company_name, tagline, logo_url, header_bg, accent_color into v_cfg
    from public.client_configs where client_id = p_client_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select coalesce(cs.payments_online_enabled, false) and cs.cardpointe_merchid is not null
    into v_pay from public.client_settings cs where cs.client_id = p_client_id;

  select coalesce(jsonb_agg(u order by (u->>'sold')::boolean, (u->>'createdAt') desc), '[]'::jsonb) into v_units
  from (
    select jsonb_build_object(
      'id', iu.id,
      'serial', iu.serial,
      'title', nullif(btrim(coalesce(iu.public_title, '')), ''),
      'description', nullif(btrim(coalesce(iu.public_description, '')), ''),
      'style', coalesce(bs.label, d.selections->>'style'),
      'size', d.selections->>'size',
      'roofType', d.selections->>'roofType',
      'roofColor', nullif(d.selections->>'roofColor', ''),
      'bodyColor', nullif(d.paint_colors->>'body', ''),
      'trimColor', nullif(d.paint_colors->>'trim', ''),
      'locationId', l.id,
      'locationName', l.name,
      'locationCity', l.city,
      'locationState', l.state,
      'priceCents', case when iu.show_price_online and not v_shop.hide_all_prices then iu.asking_price_cents end,
      'sold', iu.sale_state = 'sold',
      'soldLabelExpiresAt', case when iu.sale_state = 'sold' and iu.sold_at is not null then iu.sold_at + interval '30 days' end,
      'createdAt', iu.created_at,
      'photos', coalesce((
        select jsonb_agg(v_photo_base || p.storage_key order by p.sort_order, p.created_at)
          from public.inventory_unit_photos p where p.unit_id = iu.id
      ), '[]'::jsonb),
      'options', jsonb_strip_nulls(jsonb_build_object(
        'cladding', nullif(d.selections->>'cladding', ''),
        'paint', nullif(d.selections->>'paint', ''),
        'loftPackage', nullif(d.selections->>'loftPackage', ''))),
      'included', coalesce((
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'type', it->>'type',
          'name', coalesce(nullif(it->>'doorName', ''), nullif(it->>'windowName', ''),
                           nullif(li.label_override, ''), ei.name),
          'widthFt', case when jsonb_typeof(it->'widthFt') = 'number' then (it->>'widthFt')::numeric end,
          'widthIn', case when jsonb_typeof(it->'widthIn') = 'number' then (it->>'widthIn')::numeric end,
          'heightIn', case when jsonb_typeof(it->'heightIn') = 'number' then (it->>'heightIn')::numeric end,
          'color', nullif(it->>'colorLabel', ''),
          'shutters', case when (it->>'shutters')::text = 'true' then true end,
          'flowerBox', case when (it->>'flowerBox')::text = 'true' then true end
        )) order by (it->>'id'))
        from jsonb_array_elements(case when jsonb_typeof(d.items) = 'array' then d.items else '[]'::jsonb end) it
        left join public.client_layout_items li on li.client_id = iu.client_id and li.item_key = it->>'type'
        left join public.electrical_items ei on ei.client_id = iu.client_id and ei.id::text = coalesce(it->>'electricalItemId', '')
        where coalesce(it->>'type', '') not in ('textNote', 'line', 'prop', '')
      ), '[]'::jsonb)
    ) as u
    from public.inventory_units iu
    join public.designs d on d.short_code = iu.design_short_code and d.client_id = iu.client_id
    left join public.builder_locations l on l.id = iu.location_id
    left join public.building_styles bs on bs.client_id = iu.client_id and bs.key = d.selections->>'style'
    where iu.client_id = p_client_id
      and iu.listed
      and (iu.sale_state = 'unsold' or iu.sold_at > now() - interval '30 days')
  ) s;

  return jsonb_build_object(
    'ok', true,
    'clientId', p_client_id,
    'branding', jsonb_build_object(
      'companyName', v_cfg.company_name, 'tagline', v_cfg.tagline, 'logoUrl', v_cfg.logo_url,
      'headerBg', v_cfg.header_bg, 'accentColor', v_cfg.accent_color),
    'shop', jsonb_build_object(
      'heading', v_shop.heading, 'intro', v_shop.intro, 'termsUrl', v_shop.terms_url,
      'gtmContainerId', v_shop.gtm_container_id, 'hideAllPrices', v_shop.hide_all_prices,
      'depositMode', v_shop.deposit_mode, 'depositValue', v_shop.deposit_value,
      'allowPayInFull', v_shop.allow_pay_in_full,
      'paymentsLive', coalesce(v_pay, false)),
    'units', v_units);
end
$$;

select '314' as migration,
  (select jsonb_array_length(u->'included') from jsonb_array_elements(public.get_public_shop('structure-studio')->'units') u
    where (u->>'serial') = '4523') as included_on_4523;

commit;
