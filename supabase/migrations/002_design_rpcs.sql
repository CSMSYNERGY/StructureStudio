-- 002_design_rpcs: capability-based access to designs keyed by the unguessable
-- short_code. SECURITY DEFINER so these keep working after the blanket
-- designs_anon_all policy is dropped at cutover. The code IS the capability:
-- whoever holds it may read/update that one design (same model as today's
-- share links), but nobody can list or touch other rows.
-- APPLIED to project jzeamjbhdrsbygdnphbm on 2026-06-11 (migration: design_capability_rpcs).

create or replace function public.load_design(p_code text)
returns setof public.designs
language sql stable security definer
set search_path = ''
as $$
  select * from public.designs where short_code = p_code
$$;

create or replace function public.save_design(
  p_code text,
  p_client_id text,
  p_contact jsonb,
  p_selections jsonb,
  p_paint_colors jsonb,
  p_items jsonb,
  p_custom_options jsonb,
  p_ro_dimensions jsonb,
  p_bldg_w int,
  p_bldg_h int,
  p_image_url text
) returns public.designs
language plpgsql security definer
set search_path = ''
as $$
declare
  v_existing_client text;
  v_row public.designs;
begin
  -- Code shape: SS- + 6..12 chars from the look-alike-free alphabet
  -- (no I/O/0/1). 6 accepted for legacy rows; new codes are 10.
  if p_code is null or p_code !~ '^SS-[A-HJ-NP-Z2-9]{6,12}$' then
    raise exception 'invalid design code';
  end if;

  -- Only known tenants may save designs.
  if not exists (select 1 from public.client_configs where client_id = p_client_id) then
    raise exception 'unknown client';
  end if;

  -- A known code must not re-home a design to another tenant.
  select client_id into v_existing_client
    from public.designs where short_code = p_code;
  if v_existing_client is not null and v_existing_client <> p_client_id then
    raise exception 'design belongs to a different client';
  end if;

  insert into public.designs
    (short_code, client_id, contact, selections, paint_colors, items,
     custom_options, ro_dimensions, bldg_w, bldg_h, image_url)
  values
    (p_code, p_client_id,
     coalesce(p_contact, '{}'::jsonb),
     coalesce(p_selections, '{}'::jsonb),
     coalesce(p_paint_colors, '{}'::jsonb),
     coalesce(p_items, '[]'::jsonb),
     coalesce(p_custom_options, '[]'::jsonb),
     coalesce(p_ro_dimensions, '{}'::jsonb),
     p_bldg_w, p_bldg_h, p_image_url)
  on conflict (short_code) do update set
    contact        = excluded.contact,
    selections     = excluded.selections,
    paint_colors   = excluded.paint_colors,
    items          = excluded.items,
    custom_options = excluded.custom_options,
    ro_dimensions  = excluded.ro_dimensions,
    bldg_w         = excluded.bldg_w,
    bldg_h         = excluded.bldg_h,
    image_url      = excluded.image_url,
    updated_at     = now()
    -- client_id deliberately not updated: enforced immutable above
  returning * into v_row;

  return v_row;
end
$$;

-- The public designer (anon) and logged-in owners both use these.
revoke execute on function public.load_design(text) from public;
revoke execute on function public.save_design(text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,int,int,text) from public;
grant execute on function public.load_design(text) to anon, authenticated;
grant execute on function public.save_design(text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,int,int,text) to anon, authenticated;
