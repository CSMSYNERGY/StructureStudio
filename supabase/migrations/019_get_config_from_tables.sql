-- 019_get_config_from_tables: rewrite get_config to build buildingStyles +
-- layoutItems from the catalog tables (building_styles/building_sizes,
-- client_layout_items ⨝ layout_item_types) instead of the client_configs
-- building_styles/layout_items jsonb columns. branding/contactFields/
-- defaultSizes/options still read their client_configs columns.
--
-- Parity-verified (018 gate): for every tenant this reproduces the previous
-- column-based output byte-identically. Shapes preserved exactly:
--   * buildingStyles[] = {value, label, img, sizes:[<label strings>]}
--   * layoutItems{}     keyed by item_key → {label,icon,color,width,height,
--       shortLabel, wallOnly, wallSnap}, plus doorSnap ONLY when true.
-- SECURITY DEFINER. HAND-APPLY only. BOM-free.
--
-- Rollback: create or replace get_config back to the column-based body (kept in
-- migration 020's backup notes) — but only valid while the columns still exist.

create or replace function public.get_config(p_client_id text)
returns jsonb language sql stable security definer set search_path = '' as $fn$
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
                                  where sz.style_id = st.id and sz.active), '[]'::jsonb))
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
      where cli.client_id = cc.client_id and cli.active), '{}'::jsonb)
  ) end
  from public.client_configs cc where cc.client_id = p_client_id;
$fn$;

revoke execute on function public.get_config(text) from public;
grant  execute on function public.get_config(text) to anon, authenticated;

-- parity helper no longer needed
drop function if exists public.get_config_v2(text);
