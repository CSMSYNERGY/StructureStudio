-- 012_catalog_rls_scope: lock the catalog to per-tenant reads + add the public
-- read door. Replaces the four `*_public_read using(true)` policies (from
-- 006/009/010/011) with owner-scoped authenticated-only reads, revokes anon's
-- direct table SELECT, and adds get_catalog() so the (future) public/anon
-- designer can fetch ONE tenant's catalog without ever bulk-querying the tables.
-- The service role (estimate engine) bypasses RLS and needs no policy.
--
-- NON-DESTRUCTIVE: drops/creates POLICIES and REVOKEs grants only — no table or
-- row is touched. SAFE TO APPLY NOW: these four tables are INERT (no app code
-- reads them yet), so tightening RLS cannot break a running path. Idempotent
-- (drop-if-exists then create; `create or replace function`). NOT YET APPLIED.

-- ── Per-tenant RLS on the four catalog tables ────────────────────────
-- All four carry client_id directly (building_sizes since 011), so the same
-- owner-scoped policy applies uniformly.
do $$
declare t text;
begin
  foreach t in array array['building_styles','building_sizes','colors','layout_item_pricing'] loop
    execute format('drop policy if exists %I_public_read on public.%I', t, t);
    execute format('drop policy if exists %I_owner_read  on public.%I', t, t);
    execute format('revoke select on public.%I from anon', t);
    execute format($f$create policy %I_owner_read on public.%I
      for select to authenticated using (client_id = public.current_client_id())$f$, t, t);
  end loop;
end $$;

-- ── get_catalog: single-call per-tenant catalog as one JSONB object ──────────
-- SECURITY DEFINER so it reads the now-private catalog tables AND the
-- service-role-only client_settings (show_pricing). Validates the tenant exactly
-- like save_design. When show_pricing is FALSE, every price field is OMITTED
-- (absent, not null) so prices never reach the browser for tenants who haven't
-- opted in. Shape mirrors client_configs.config (buildingStyles[]->sizes[],
-- colors[], camelCase) so the future designer consumes it like the config blob.
create or replace function public.get_catalog(p_client_id text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_show   boolean;
  v_result jsonb;
begin
  -- Same tenant gate as save_design.
  if not exists (select 1 from public.client_configs where client_id = p_client_id) then
    raise exception 'unknown client';
  end if;

  -- client_settings is service-role-only; this SECURITY DEFINER fn may read it.
  -- No settings row => pricing hidden (fail closed).
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
                    'depthFt', sz.depth_ft, 'sortOrder', sz.sort_order,
                    'basePrice', sz.base_price)
                else
                  jsonb_build_object(
                    'id', sz.id, 'label', sz.label, 'widthFt', sz.width_ft,
                    'depthFt', sz.depth_ft, 'sortOrder', sz.sort_order)
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
$$;

revoke execute on function public.get_catalog(text) from public;
grant  execute on function public.get_catalog(text) to anon, authenticated;
