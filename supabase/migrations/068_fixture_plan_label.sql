-- 068_fixture_plan_label: the short label/initials a fixture shows ON the floor plan
-- (e.g. "SD", "GD", "36S"). Owner-set per door in the portal Doors editor; the designer
-- draws it on the door glyph and falls back to a derived short of the name when blank.
-- Additive, nullable — no backfill needed. HAND-APPLY via MCP; record in the ledger.

alter table public.fixture_items
  add column if not exists plan_label text;

-- get_fixtures now surfaces planLabel to the designer (price still gated by show_pricing).
create or replace function public.get_fixtures(p_client_id text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
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
  into v_result
  from public.fixture_items fi
  where fi.client_id = p_client_id and fi.active
    and fi.price is not null;

  return v_result;
end;
$$;
revoke execute on function public.get_fixtures(text) from public;
grant  execute on function public.get_fixtures(text) to anon, authenticated;
