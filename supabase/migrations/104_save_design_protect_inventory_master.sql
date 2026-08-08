-- 104_save_design_protect_inventory_master: an inventory master is not anon-writable.
--
-- Found during the 2026-08-07 Inventory audit.
--
-- 075's header says an inventory master "is created ONLY by portal-settings (service role) —
-- save_design's anon p_status guard still allows nothing but 'draft', so the public internet
-- cannot mint one." That is true for MINTING and false for OVERWRITING. The status guard
-- protects the STATUS:
--
--   status = case when d.status = 'draft' then excluded.status else d.status end
--
-- but every other column in the ON CONFLICT DO UPDATE is written unconditionally. So an
-- anonymous caller holding a master's short code could rewrite the building itself — its
-- selections, items, contact, dimensions — and append a design_versions row, while the row
-- kept reading status='inventory'.
--
-- The code is not much of a secret: it appears in the public floor-plan PDF URL, and
-- load_design is granted to anon with no status filter, so `?id=SS-…` renders a lot
-- building's plan to anybody who has the link.
--
-- What that would have allowed: silently changing the specification of a building that is
-- physically standing on a sales lot, and that customers are being quoted from. The unit's
-- asking price, serial and location are untouched, so nothing on the Inventory tab looks
-- wrong — the drawing just stops matching the building.
--
-- Fix: refuse early rather than sanitising, matching the "design belongs to a different
-- client" guard immediately above it. This function is the only write path anon has to
-- designs; portal-settings' save_inventory (service role) edits masters and does not go
-- through here, so nothing legitimate is blocked.
--
-- Everything else in this definition is byte-identical to 070_save_design_image_url.sql.

create or replace function public.save_design(
  p_code text, p_client_id text, p_contact jsonb, p_selections jsonb, p_paint_colors jsonb,
  p_items jsonb, p_custom_options jsonb, p_ro_dimensions jsonb, p_bldg_w integer,
  p_bldg_h integer, p_image_url text, p_status text default null
)
returns public.designs
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_existing_client text;
  v_existing_status text;
  v_row public.designs;
  v_needle text;
  v_at int;
begin
  if p_code is null or p_code !~ '^SS-[A-HJ-NP-Z2-9]{6,12}$' then
    raise exception 'invalid design code';
  end if;
  if p_status is not null and p_status != 'draft' then
    raise exception 'invalid status';
  end if;
  if not exists (select 1 from public.client_configs where client_id = p_client_id) then
    raise exception 'unknown client';
  end if;
  select client_id, status into v_existing_client, v_existing_status
    from public.designs where short_code = p_code;
  if v_existing_client is not null and v_existing_client != p_client_id then
    raise exception 'design belongs to a different client';
  end if;
  -- The building on the lot is not a customer's quote. Its content is owned by
  -- portal-settings' save_inventory, which runs as the service role and never calls this.
  if v_existing_status = 'inventory' then
    raise exception 'design belongs to an inventory building';
  end if;

  -- Reduce p_image_url to "this design's own object, or nothing". Sanitises rather than raising
  -- so a false negative can never fail a live estimate submission; the upsert's
  -- coalesce(excluded.image_url, d.image_url) then preserves any existing good URL. The PATH is
  -- pinned, deliberately not the host. p_client_id is a position() needle, never a pattern.
  if p_image_url is not null then
    v_needle := '/storage/v1/object/public/floor-plans/' || p_client_id || '/' || p_code;
    v_at := position(v_needle in p_image_url);
    if p_image_url !~ '^https://'
       or v_at = 0
       or substring(p_image_url from v_at + length(v_needle)) !~ '^(-[0-9]+)?[.](pdf|png)$'
    then
      p_image_url := null;
    end if;
  end if;

  insert into public.designs as d
    (short_code, client_id, contact, selections, paint_colors, items,
     custom_options, ro_dimensions, bldg_w, bldg_h, image_url, status)
  values
    (p_code, p_client_id,
     coalesce(p_contact, '{}'::jsonb),
     coalesce(p_selections, '{}'::jsonb),
     coalesce(p_paint_colors, '{}'::jsonb),
     coalesce(p_items, '[]'::jsonb),
     coalesce(p_custom_options, '[]'::jsonb),
     coalesce(p_ro_dimensions, '{}'::jsonb),
     p_bldg_w, p_bldg_h, p_image_url,
     coalesce(p_status, 'sent'))
  on conflict (short_code) do update set
    contact        = excluded.contact,
    selections     = excluded.selections,
    paint_colors   = excluded.paint_colors,
    items          = excluded.items,
    custom_options = excluded.custom_options,
    ro_dimensions  = excluded.ro_dimensions,
    bldg_w         = excluded.bldg_w,
    bldg_h         = excluded.bldg_h,
    image_url      = coalesce(excluded.image_url, d.image_url),
    status         = case when d.status = 'draft' then excluded.status else d.status end,
    updated_at     = now()
  returning * into v_row;

  insert into public.design_versions
    (short_code, client_id, version, contact, selections, paint_colors, items,
     custom_options, ro_dimensions, bldg_w, bldg_h, image_url)
  values
    (v_row.short_code, v_row.client_id,
     coalesce((select max(version) from public.design_versions where short_code = p_code), 0) + 1,
     v_row.contact, v_row.selections, v_row.paint_colors, v_row.items,
     v_row.custom_options, v_row.ro_dimensions, v_row.bldg_w, v_row.bldg_h, v_row.image_url);

  return v_row;
end
$function$;

-- Grants are unchanged by CREATE OR REPLACE; re-stated so this file is self-describing.
-- grant execute on function public.save_design(...) to anon, authenticated;

-- Rollback: re-apply 070_save_design_image_url.sql verbatim.
