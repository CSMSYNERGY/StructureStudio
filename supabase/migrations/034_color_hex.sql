-- 034_color_hex: give each paint color a stored hex so the swatch is visible everywhere
-- (portal Colors tab, and the designer's paint dropdown), matching the color-library chips.
--
-- The colors table previously only had an optional image_url swatch; a color added from the
-- library kept its NAME but not its color. This adds a nullable `hex` (e.g. '#8C2A2A'),
-- backfills it for any color whose label matches a known library name, and returns it from
-- get_config. Still selection-only — no prices exposed.
--
-- NB: applied to live via MCP on 2026-07-02; this NNN_ file is the repo record.

alter table public.colors add column if not exists hex text;

-- Backfill hex for existing colors added from the built-in library (matched by label).
update public.colors c set hex = m.hex
from (values
  ('bright white','#F6F6F1'), ('white','#ECEAE0'), ('almond','#E7D9BE'), ('beige','#D8C7A0'),
  ('sandstone','#C9B489'), ('buckskin','#B79A6E'), ('desert tan','#C2A579'), ('khaki','#A89468'),
  ('clay','#B08155'), ('mocha tan','#9A8064'), ('coffee brown','#5A4535'), ('chocolate','#3E2C22'),
  ('barn red','#7B1E22'), ('mountain red','#8C2A2A'), ('classic red','#A32431'), ('red delicious','#9E1B2A'),
  ('burgundy','#5E1F2B'), ('sage green','#8A9A78'), ('hunter green','#2F4A38'), ('forest green','#274134'),
  ('ivy green','#3B5E3A'), ('country blue','#5E7C99'), ('slate blue','#41566B'), ('navy blue','#25324B'),
  ('light gray','#C7CACC'), ('pewter gray','#8C9194'), ('slate gray','#5E676C'), ('charcoal gray','#3A3F43'),
  ('quaker gray','#9AA0A0'), ('black','#1C1C1C')
) as m(name, hex)
where lower(c.label) = m.name and (c.hex is null or c.hex = '');

-- get_config now returns hex on each color.
create or replace function public.get_config(p_client_id text)
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
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
               || case when lt.door_snap then jsonb_build_object('doorSnap', true) else '{}'::jsonb end)
      from public.client_layout_items cli
      join public.layout_item_types lt on lt.item_key = cli.item_key and lt.active
      where cli.client_id = cc.client_id and cli.active), '{}'::jsonb),
    'colors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'label', c.label,
               'siding', c.siding, 'trim', c.trim,
               'allowCustom', c.allow_custom, 'isDefault', c.is_default,
               'hex', c.hex, 'swatch', c.image_url)
             order by c.sort_order, c.label)
      from public.colors c
      where c.client_id = cc.client_id and c.active), '[]'::jsonb)
  ) end
  from public.client_configs cc where cc.client_id = p_client_id;
$function$;
