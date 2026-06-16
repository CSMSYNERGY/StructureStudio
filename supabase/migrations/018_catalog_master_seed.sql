-- 018_catalog_master_seed: seed the master catalogs from the UNION of every
-- tenant's live client_configs columns, then reconcile per-client assignments so
-- get_config (after 019) reproduces each tenant's CURRENT config EXACTLY.
--
-- Principles: derive from the LIVE config columns (the source of truth); additive
-- + activate/deactivate only; NEVER overwrite base_price (preserves the 007
-- prices); NEVER hard-delete. Re-runnable (idempotent). HAND-APPLY only. BOM-free.
--
-- Notes on reconcile:
--   * Style identity: config uses value='Econo' (capitalized); the building_styles
--     table was seeded (007) with key='econo' for junior-barns ONLY. We match
--     case-insensitively and NORMALIZE the table key to the config value, keeping
--     the existing style_id (so its building_sizes + prices survive). demo-sheds /
--     test-barn have no rows → inserted fresh.
--   * Size active-set = config size list per style (re-activates northwood 8x20,
--     which 013 had deactivated, because the live config still offers it).

-- 1. Master layout item types (all tenants share identical item defs today).
insert into public.layout_item_types
  (item_key, label, icon, color, default_width, default_height,
   wall_only, wall_snap, door_snap, short_label, sort_order, active)
select distinct on (kv.key)
  kv.key,
  coalesce(kv.value->>'label', kv.key),
  coalesce(kv.value->>'icon', ''),
  coalesce(kv.value->>'color', '#000000'),
  coalesce((kv.value->>'width')::numeric, 3),
  coalesce((kv.value->>'height')::numeric, 3),
  coalesce((kv.value->>'wallOnly')::boolean, false),
  coalesce((kv.value->>'wallSnap')::boolean, false),
  coalesce((kv.value->>'doorSnap')::boolean, false),
  coalesce(kv.value->>'shortLabel', ''),
  0, true
from public.client_configs cc, lateral jsonb_each(cc.layout_items) kv
on conflict (item_key) do nothing;

-- 2. Master building style catalog + default sizes (union).
insert into public.building_style_catalog (key, label, default_image_url, sort_order, active)
select distinct on (s->>'value')
  s->>'value', coalesce(s->>'label', s->>'value'), s->>'img', 0, true
from public.client_configs cc, lateral jsonb_array_elements(cc.building_styles) s
on conflict (key) do nothing;

insert into public.building_style_catalog_sizes (style_key, label, width_ft, depth_ft, sort_order)
select distinct on (s->>'value', sz.label)
  s->>'value', sz.label,
  split_part(sz.label,'x',1)::numeric, split_part(sz.label,'x',2)::numeric, sz.ord::int
from public.client_configs cc,
     lateral jsonb_array_elements(cc.building_styles) s,
     lateral jsonb_array_elements_text(s->'sizes') with ordinality sz(label, ord)
on conflict (style_key, label) do nothing;

-- 3. Per-client reconcile.
do $$
declare cc record; kv record; st record; sz record; v_style_id uuid;
begin
  for cc in select client_id, building_styles, layout_items from public.client_configs loop

    -- 3a. layout-item assignments (one row per key in this tenant's layout_items)
    for kv in select key, value from jsonb_each(cc.layout_items) loop
      insert into public.client_layout_items
        (client_id, item_key, active, sort_order,
         label_override, width_override, height_override, short_label_override)
      select cc.client_id, kv.key, true, lt.sort_order,
        nullif(kv.value->>'label', lt.label),
        nullif((kv.value->>'width')::numeric,  lt.default_width),
        nullif((kv.value->>'height')::numeric, lt.default_height),
        nullif(kv.value->>'shortLabel', lt.short_label)
      from public.layout_item_types lt where lt.item_key = kv.key
      on conflict (client_id, item_key) do update set
        active               = true,
        label_override       = excluded.label_override,
        width_override       = excluded.width_override,
        height_override      = excluded.height_override,
        short_label_override = excluded.short_label_override;
    end loop;

    -- 3b. styles: reconcile building_styles + building_sizes to match config
    for st in
      select elem->>'value' as val, elem->>'label' as lbl, elem->>'img' as img,
             elem->'sizes' as sizes, ord_pos as ord
      from jsonb_array_elements(cc.building_styles) with ordinality as t(elem, ord_pos)
    loop
      select id into v_style_id from public.building_styles
        where client_id = cc.client_id and lower(key) = lower(st.val) limit 1;

      if v_style_id is null then
        insert into public.building_styles (client_id, key, label, image_url, sort_order, active)
        values (cc.client_id, st.val, coalesce(st.lbl, st.val), st.img, st.ord, true)
        returning id into v_style_id;
      else
        update public.building_styles
          set key = st.val, label = coalesce(st.lbl, st.val), image_url = st.img,
              sort_order = st.ord, active = true
          where id = v_style_id;
      end if;

      -- ensure a building_sizes row (active) for each config size; keep base_price
      for sz in
        select label, ord_pos as ord
        from jsonb_array_elements_text(st.sizes) with ordinality as t(label, ord_pos)
      loop
        insert into public.building_sizes
          (client_id, style_id, label, width_ft, depth_ft, base_price, sort_order, active)
        values (cc.client_id, v_style_id, sz.label,
                split_part(sz.label,'x',1)::numeric, split_part(sz.label,'x',2)::numeric,
                null, sz.ord, true)
        on conflict (style_id, label) do update set active = true, sort_order = excluded.sort_order;
      end loop;

      -- deactivate any sizes NOT in the config list for this style
      update public.building_sizes b set active = false
        where b.style_id = v_style_id
          and b.label not in (select jsonb_array_elements_text(st.sizes));
    end loop;

    -- deactivate any styles whose key isn't in the config (case-insensitive)
    update public.building_styles b set active = false
      where b.client_id = cc.client_id
        and lower(b.key) not in (select lower(x->>'value') from jsonb_array_elements(cc.building_styles) x);
  end loop;
end $$;
