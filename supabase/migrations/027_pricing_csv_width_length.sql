-- 027_pricing_csv_width_length: finish the depth_ft -> length_ft rename and harden the
-- pricing-CSV size upsert (June-18 Carolyn meeting follow-ups).
--
-- Background: during the 2026-06-18 call the per-client building_sizes.depth_ft column
-- was renamed to length_ft live (Supabase dashboard). That left the master catalog
-- table and the get_catalog RPC out of sync, and admin-catalog (which still selected
-- depth_ft) broken. This migration:
--   1. Renames building_style_catalog_sizes.depth_ft -> length_ft (master parity, so the
--      whole codebase speaks "length").
--   2. Adds a uniqueness guard on building_sizes(client_id, style_id, width_ft, length_ft)
--      so re-uploading a pricing CSV updates a size instead of duplicating it.
--   3. Recreates get_catalog reading length_ft. get_catalog is currently unused by the
--      frontend (the designer reads get_config, which never referenced depth_ft), but the
--      old body still selected sz.depth_ft and would error if the function were called.
--
-- Hand-applied via MCP execute_sql (NOT recorded in supabase_migrations).

-- 1. Master catalog sizes: align with the per-client rename.
alter table public.building_style_catalog_sizes rename column depth_ft to length_ft;

-- 2. No-duplicate guard for the pricing-CSV upsert path (verified: zero existing dups).
alter table public.building_sizes
  add constraint building_sizes_client_style_dims_uniq
  unique (client_id, style_id, width_ft, length_ft);

-- 3. get_catalog: depth_ft -> length_ft (keys exposed as lengthFt).
create or replace function public.get_catalog(p_client_id text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_show   boolean;
  v_result jsonb;
begin
  if not exists (select 1 from public.client_configs where client_id = p_client_id) then
    raise exception 'unknown client';
  end if;

  select coalesce(cs.show_pricing, false) into v_show
    from public.client_settings cs where cs.client_id = p_client_id;
  v_show := coalesce(v_show, false);

  select jsonb_build_object(
    'clientId', p_client_id,
    'showPricing', v_show,

    'buildingStyles', coalesce((
      select jsonb_agg(style_obj order by ord, lbl)
      from (
        select
          st.sort_order as ord,
          st.label      as lbl,
          jsonb_build_object(
            'id', st.id, 'key', st.key, 'label', st.label,
            'imageUrl', st.image_url, 'sortOrder', st.sort_order,
            'sizes', coalesce((
              select jsonb_agg(
                case when v_show then
                  jsonb_build_object(
                    'id', sz.id, 'label', sz.label, 'widthFt', sz.width_ft,
                    'lengthFt', sz.length_ft, 'sortOrder', sz.sort_order,
                    'basePrice', sz.base_price)
                else
                  jsonb_build_object(
                    'id', sz.id, 'label', sz.label, 'widthFt', sz.width_ft,
                    'lengthFt', sz.length_ft, 'sortOrder', sz.sort_order)
                end
                order by sz.sort_order, sz.label)
              from public.building_sizes sz
              where sz.style_id = st.id and sz.active
            ), '[]'::jsonb)
          ) as style_obj
        from public.building_styles st
        where st.client_id = p_client_id and st.active
      ) styles
    ), '[]'::jsonb),

    'colors', coalesce((
      select jsonb_agg(
        case when v_show then
          jsonb_build_object(
            'id', c.id, 'label', c.label, 'siding', c.siding, 'trim', c.trim,
            'imageUrl', c.image_url, 'allowCustom', c.allow_custom,
            'isDefault', c.is_default, 'sortOrder', c.sort_order,
            'rate', c.rate, 'pricingMethod', c.pricing_method)
        else
          jsonb_build_object(
            'id', c.id, 'label', c.label, 'siding', c.siding, 'trim', c.trim,
            'imageUrl', c.image_url, 'allowCustom', c.allow_custom,
            'isDefault', c.is_default, 'sortOrder', c.sort_order)
        end
        order by c.sort_order, c.label)
      from public.colors c
      where c.client_id = p_client_id and c.active
    ), '[]'::jsonb),

    'layoutItemPricing', coalesce((
      select jsonb_agg(
        case when v_show then
          jsonb_build_object(
            'id', li.id, 'itemKey', li.item_key, 'styleId', li.style_id,
            'rate', li.rate, 'pricingMethod', li.pricing_method)
        else
          jsonb_build_object(
            'id', li.id, 'itemKey', li.item_key, 'styleId', li.style_id)
        end
        order by li.item_key, li.style_id nulls first)
      from public.layout_item_pricing li
      where li.client_id = p_client_id
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$function$;
