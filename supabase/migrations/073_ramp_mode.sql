-- 073_ramp_mode: ramps on the fixtures engine. Two per-tenant modes:
--   simple  → one ramp, auto-sized to the door it attaches to; priced from the columns below.
--   custom  → ramp styles live in fixture_items (category='ramp'), like doors.
-- Adds the mode + the simple-ramp config to client_settings, and reshapes get_fixtures to
-- return { items, ramp } (the designer reads .items for the fixture list, .ramp for the mode +
-- simple config). Item prices AND the simple ramp price stay gated by show_pricing.
-- HAND-APPLY via MCP; record in the ledger.

alter table public.client_settings
  add column if not exists ramp_mode         text    not null default 'simple',
  add column if not exists ramp_price         numeric,
  add column if not exists ramp_price_method  text    not null default 'each',
  add column if not exists ramp_image_url     text,
  add column if not exists ramp_show_image    boolean not null default true;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_settings_ramp_mode_chk') then
    alter table public.client_settings add constraint client_settings_ramp_mode_chk check (ramp_mode in ('simple','custom'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_settings_ramp_method_chk') then
    alter table public.client_settings add constraint client_settings_ramp_method_chk check (ramp_price_method in ('each','per_ft'));
  end if;
end $$;

create or replace function public.get_fixtures(p_client_id text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
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
    and fi.price is not null;

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
$$;
revoke execute on function public.get_fixtures(text) from public;
grant  execute on function public.get_fixtures(text) to anon, authenticated;
