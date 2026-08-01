-- 070_save_design_image_url.sql
--
-- save_design is anon-executable and stored p_image_url VERBATIM. That column is then
-- TRUSTED by server code and by the owner-facing UI: delete_design derives storage keys from
-- it for a service-role remove(), submit-estimate attaches it to the customer's estimate, and
-- portal.html renders it as a clickable link inside the authenticated portal. Each of those
-- consumers now validates it at the point of use, but the column itself was still writable
-- with anything at all, so every future consumer would have to remember. Close it at the
-- source: a caller may only ever name THIS design's own object, under THIS client's prefix.
--
-- Three deliberate choices:
--
--   1. SANITISE TO NULL, NEVER `raise`. This runs on the live estimate-submission path, so a
--      false negative must not be able to fail a customer's quote. Because the upsert below
--      keeps `image_url = coalesce(excluded.image_url, d.image_url)`, a nulled value PRESERVES
--      whatever good URL the row already had — it cannot blank a working PDF link either.
--      A brand-new row simply gets no image_url, which is exactly a draft's normal state.
--
--   2. PIN THE PATH, NOT THE HOST. Baking the storage hostname into SQL means that moving the
--      project, or fronting storage with a CDN, starts silently discarding real submissions.
--      Requiring https + our object path + this tenant's prefix + this design's code is what
--      carries the security; the host adds nothing, because the accepted value is already
--      confined to an object this design created.
--
--   3. NO REGEX IS BUILT FROM p_client_id. The slug is concatenated into a position() needle
--      only. p_code is already shape-checked above (`^SS-[A-HJ-NP-Z2-9]{6,12}$`), but a client
--      slug is whatever was inserted into client_configs, so it must never become a pattern.
--
-- Accepted (matches the sole upload site, `${clientId}/${shortCode}-${Date.now()}.pdf`):
--     https://…/storage/v1/object/public/floor-plans/<client_id>/<code>[-<digits>].pdf|.png
--
-- Verified against live data before applying: of 247 stored values, 211 satisfy this and the
-- only 36 that do not are the pre-2026-06-15 bucket-root rows, which no code path ever passes
-- back into this function (the designer always uploads a fresh prefixed PDF, and drafts pass
-- NULL). So this rejects nothing that legitimately occurs.
--
-- Everything else in this body is byte-identical to 063_draft_designs.sql. Signature unchanged,
-- so grants and PostREST overload resolution are untouched. Rollback = re-apply 063's body.

create or replace function public.save_design(
  p_code text, p_client_id text, p_contact jsonb, p_selections jsonb, p_paint_colors jsonb,
  p_items jsonb, p_custom_options jsonb, p_ro_dimensions jsonb, p_bldg_w integer,
  p_bldg_h integer, p_image_url text, p_status text default null::text)
 returns public.designs
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_existing_client text;
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
  select client_id into v_existing_client from public.designs where short_code = p_code;
  if v_existing_client is not null and v_existing_client != p_client_id then
    raise exception 'design belongs to a different client';
  end if;

  -- Reduce p_image_url to "this design's own object, or nothing". See the header for why this
  -- sanitises instead of raising, and why the host is deliberately not pinned.
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
