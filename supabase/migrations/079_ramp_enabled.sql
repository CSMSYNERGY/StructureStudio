-- 079_ramp_enabled: the ramp becomes a SELF-CONTAINED option — the designer draws + places it from
-- its own SIMPLE_RAMP_CFG and the Ramp settings, no longer borrowing the built-in `ramp` layout
-- item. That lets the built-in `ramp` be deleted with no leftover reference, while every saved
-- design's ramp keeps rendering + pricing.
--
-- "Does this tenant OFFER a (simple) ramp" used to be signalled by client_layout_items.ramp being
-- active. Move that signal to an explicit, non-price-gated flag on client_settings so it survives
-- deleting the built-in item. Default it from the CURRENT built-in state so no tenant's ramp
-- offering changes. get_fixtures returns it in the `ramp` block (ungated — it's not a price).
-- HAND-APPLY via MCP; record in ledger.

alter table public.client_settings add column if not exists ramp_enabled boolean;
-- New tenants OFFER a ramp by default (matches the old built-in ramp being active on seed).
alter table public.client_settings alter column ramp_enabled set default true;

update public.client_settings cs
   set ramp_enabled = exists (
     select 1 from public.client_layout_items cli
     where cli.client_id = cs.client_id and cli.item_key = 'ramp' and cli.active
   )
 where cs.ramp_enabled is null;

-- get_fixtures: add `enabled` to the ramp block (ungated); keep the archived-fixture exclusion.
create or replace function public.get_fixtures(p_client_id text)
returns jsonb language plpgsql stable security definer set search_path to ''
as $function$
declare
  v_show    boolean;
  v_items   jsonb;
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
      'enabled', coalesce(v_enabled, false),
      'imageUrl', v_img,
      'showImage', coalesce(v_showimg, true)
    ) || (case when v_show then jsonb_build_object('price', v_price) else '{}'::jsonb end)
  );
end;
$function$;
