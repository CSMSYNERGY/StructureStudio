-- 111_save_design_protect_invoiced: the invoice's drawing is not anon-writable either.
--
-- 104 stopped anonymous rewrites of INVENTORY masters; the same ON CONFLICT DO UPDATE
-- still rewrote the content of INVOICED and DELIVERED designs for anyone holding the
-- short code (which appears in the public floor-plan PDF URL). The invoice and any
-- QuickBooks rows were issued from that content; silently changing it breaks the paper
-- trail while every total still matches. Found by the 2026-08-20 whole-app audit.
--
-- Deliberately NOT a blanket refusal: tenant staff revise invoiced estimates through the
-- portal designer, which calls this same RPC authenticated -- the guard therefore lets
-- through members of the design's tenant (client_users) and operators (app_operators),
-- and refuses everyone else, anon included.
--
-- REGENERATED FROM THE LIVE FUNCTION (pg_get_functiondef), exactly like 110: get_config
-- taught us the repo's file for a wholesale-replaced function is never proof of what is
-- live. Before applying, re-dump the live body and diff against this file minus the new
-- guard block; any other difference means regenerate, not apply.
--
-- ⚠️ SUPERSEDED IN PART BY 197 (2026-09-06). The list below stops at invoiced/delivered, so
-- 'accepted' -- the rung the customer's own agreement lands on, alongside designs.accepted_at
-- (122) and the design_acceptances record (124) -- stayed anon-writable: the change order the
-- app raises for any post-acceptance revision (126) sat on top of content the short code could
-- still rewrite. 197 splices 'accepted' plus an accepted_at test into the LIVE body, and
-- widens the refusal message with it. Read 197 before treating this file as the guard.

CREATE OR REPLACE FUNCTION public.save_design(p_code text, p_client_id text, p_contact jsonb, p_selections jsonb, p_paint_colors jsonb, p_items jsonb, p_custom_options jsonb, p_ro_dimensions jsonb, p_bldg_w integer, p_bldg_h integer, p_image_url text, p_status text DEFAULT NULL::text)
 RETURNS designs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if v_existing_status = 'inventory' then
    raise exception 'design belongs to an inventory building';
  end if;
  -- An INVOICED or DELIVERED design is a billing document's source of truth: the invoice
  -- (and any QuickBooks rows) were issued from this content, so the anonymous internet
  -- must not be able to rewrite it under the same short code while the paperwork stands.
  -- 104 closed the same hole for inventory masters and stopped there (audit 2026-08-20).
  -- TENANT STAFF still may edit: the portal designer saves through this same RPC as an
  -- authenticated user, and revising an invoiced estimate is a real back-office flow -- so
  -- the refusal is scoped to callers who are neither a member of this tenant nor an
  -- operator. auth.uid() is null for anon; membership is the client_users mapping, and
  -- operators are app_operators (both PK'd on user_id).
  if v_existing_status in ('invoiced', 'delivered') then
    if auth.uid() is null or not (
      exists (select 1 from public.client_users cu
               where cu.user_id = auth.uid() and cu.client_id = p_client_id)
      or exists (select 1 from public.app_operators op where op.user_id = auth.uid())
    ) then
      raise exception 'design has been invoiced -- ask the builder to change it';
    end if;
  end if;

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
