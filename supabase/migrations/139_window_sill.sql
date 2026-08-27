-- 139_window_sill.sql
--
-- How far off the FLOOR a window sits, per window, and whether the customer may slide it.
--
-- Carolyn, 2026-08-25: "they need to specify here width, height, and they need to specify
-- how far off the ground... off the floor, not off the ground, off the floor, which is off
-- the inside of the building, not the exterior." Today every window in the 3D renders at a
-- hardcoded 3'6" sill (D3.WINDOW_SILL) regardless of what the builder sells, so a transom
-- and a picture window sit at the same height on the wall.
--
-- TWO columns, not one, because she asked for two different things in the same breath:
--
--   sill_in    how high off the interior floor. NULL means "use the designer's 3'6"
--              default" -- deliberately distinct from 0, which is a real answer meaning a
--              window that starts at the floor.
--
--   sill_mode  'fixed'    the window is always at sill_in. The customer cannot drag it up
--                         or down; it is a property of the product, like its width.
--              'variable' the customer may slide it up and down the wall. Her example was
--                         the transom, and a high window on the side of a garage door.
--
-- An explicit mode rather than a sentinel (e.g. "sill_in = 0 means draggable"), because she
-- was explicit -- "so a fixed and a variable toggle" -- and because the sentinel would steal
-- the one legitimate meaning of 0. Same shape as color_mode from migration 116.

alter table public.fixture_items
  add column if not exists sill_in   numeric,
  add column if not exists sill_mode text not null default 'fixed';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_sill_mode_chk') then
    alter table public.fixture_items
      add constraint fixture_items_sill_mode_chk check (sill_mode in ('fixed', 'variable'));
  end if;
end $$;

-- get_fixtures: emit the two new fields for WINDOWS only.
--
-- Regenerated from the LIVE pg_get_functiondef, per 120's header -- this function has been
-- edited by several migrations and the newest file on disk is not necessarily what the
-- database is running. The only change below is the sill merge beside the windowColorIds
-- merge; everything else is the live body verbatim.
--
-- Doors get nothing rather than nulls: a door's height off the floor is zero by definition,
-- and an extra key on every door row is a key some future reader has to rule out.
create or replace function public.get_fixtures(p_client_id text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
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
