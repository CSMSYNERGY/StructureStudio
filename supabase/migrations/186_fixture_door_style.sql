-- 186_fixture_door_style.sql
--
-- How a catalog DOOR is drawn in 3D, per door.
--
-- Until now a fixture door had exactly two possible looks and the builder chose neither:
-- upload a photo and the 3D pastes that photo flat on the slab; upload nothing and it
-- falls back to a generic two-raised-panel residential slab with a grey lever handle.
-- Every builder in this vault sells a framed VERTICAL-PLANK door with black strap hinges
-- and a barn latch, so the fallback has never once matched the product, and the photo path
-- has its own failure: production photos are three-quarter perspective cut-outs, and
-- stretching one onto a flat rectangle renders the door visibly skewed.
--
--   door_style  'auto'   exactly today's behaviour -- the photo if there is one, the
--                        raised-panel slab if there is not. THE DEFAULT, so every existing
--                        fixture for every tenant renders byte-identical to before.
--               'plank'  real geometry: perimeter stiles + head/mid/sill rails, a recessed
--                        field of vertical planks, black strap hinges on the hinge side and
--                        a black barn latch on the strike side. The fixture's photo is NOT
--                        layered over it -- the geometry IS the door, and a skewed cut-out
--                        floating in front of it is the fault this option exists to remove.
--
-- Deliberately a door look and not a "has planks" boolean: the next product on this list is
-- a roll-up and a Z-brace, and a second boolean would have to encode which one wins.
--
-- Doors only. A window's look is its glass and muntins and a ramp has no face, so neither
-- category reads this column; the constraint does not know that, but get_fixtures does.
--
-- HAND-APPLY (inline, not --file: `supabase db query --file` auth-fails, retries and still
-- exits 0), then record in supabase_migrations.schema_migrations. Do NOT db push. BOM-free.

alter table public.fixture_items
  add column if not exists door_style text not null default 'auto';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_door_style_chk') then
    alter table public.fixture_items
      add constraint fixture_items_door_style_chk check (door_style in ('auto', 'plank'));
  end if;
end $$;

-- get_fixtures: emit doorStyle for DOORS, and only when it is not the default.
--
-- Regenerated from the LIVE pg_get_functiondef, per 120's header -- several migrations have
-- edited this function and the newest file on disk is not necessarily what the database
-- runs. The only change below is the doorStyle merge beside the window sill merge;
-- everything else is the live body verbatim.
--
-- Omitted when 'auto' rather than always emitted, so a tenant who has never touched this
-- gets a payload identical to the one they get today -- the designer's own default for an
-- absent key is 'auto', so absent and 'auto' cannot disagree.

create or replace function public.get_fixtures(p_client_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
    || case when coalesce(fi.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end
    || jsonb_build_object('colorMode', coalesce(fi.color_mode, 'fixed'), 'hasTrimColor', coalesce(fi.has_trim_color, false))
    || case when fi.window_color_ids is not null then jsonb_build_object('windowColorIds', to_jsonb(fi.window_color_ids)) else '{}'::jsonb end
    || case when fi.category = 'window'
              then jsonb_build_object('sillIn', fi.sill_in, 'sillMode', coalesce(fi.sill_mode, 'fixed'))
              else '{}'::jsonb end
    || case when fi.category = 'door' and coalesce(fi.door_style, 'auto') <> 'auto'
              then jsonb_build_object('doorStyle', fi.door_style)
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
$$
;
