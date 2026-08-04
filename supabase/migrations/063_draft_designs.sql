-- 063_draft_designs: silent draft capture for browsing leads.
--
-- WHY: the public designer captures a browsing lead's contact info the moment they open
-- quote Details (capture-lead), but WHAT they designed evaporated unless they pressed
-- submit. Now that same moment also saves their in-progress design as a status='draft'
-- row, so Contacts/Designs can open the actual floor plan of someone who never submitted.
-- A later real submit reuses the same short_code and promotes the row to 'sent'.
--
-- 1) designs.status gains 'draft' (ranked below 'sent' everywhere in the portal).
-- 2) save_design gains p_status — STRICTLY constrained because anon can call it:
--      * p_status must be null or exactly 'draft'. A public caller can never write a real
--        fulfillment status — those drive portal behaviour (send-invoice keys off
--        'accepted') and are a GHL-derived projection owned by sync-design-status.
--      * insert: status = coalesce(p_status, 'sent') — drafts insert as drafts, real
--        submits as sent, and callers that omit the param behave exactly as before.
--      * update: only a row that IS a draft can move, and only to what this call is
--        allowed to say ('draft' again on a re-save, or the coalesced 'sent' of a real
--        submit — the promotion). A non-draft row's status is never touched here.
--      * image_url: an incoming NULL preserves the existing value — draft saves upload no
--        PDF, and a draft re-save on top of a submitted design must not blank its PDF link.
--
-- Adding a parameter creates a NEW function overload in Postgres; the old 11-arg
-- signature is dropped in the same transaction, otherwise PostgREST sees two candidates
-- for every named-args rpc('save_design', …) call and rejects them all as ambiguous.

alter table public.designs drop constraint designs_status_check;
alter table public.designs add constraint designs_status_check
  check (status = any (array['draft'::text, 'sent'::text, 'accepted'::text, 'invoiced'::text, 'delivered'::text]));

drop function public.save_design(text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer, integer, text);

create function public.save_design(
  p_code text,
  p_client_id text,
  p_contact jsonb,
  p_selections jsonb,
  p_paint_colors jsonb,
  p_items jsonb,
  p_custom_options jsonb,
  p_ro_dimensions jsonb,
  p_bldg_w integer,
  p_bldg_h integer,
  p_image_url text,
  p_status text default null
) returns public.designs
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_existing_client text;
  v_row public.designs;
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
    -- NULL preserves: draft saves carry no PDF; a submitted design's PDF link survives.
    image_url      = coalesce(excluded.image_url, d.image_url),
    -- Only a draft can move: re-save keeps 'draft', a real submit promotes to 'sent'.
    -- Real statuses are GHL-derived (sync-design-status) and never written from here.
    status         = case when d.status = 'draft' then excluded.status else d.status end,
    updated_at     = now()
  returning * into v_row;

  -- Append this save as the next version (append-only history). Drafts version too:
  -- the tenant can flip through how a browsing lead's design evolved.
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
$$;

grant execute on function public.save_design(text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer, integer, text, text)
  to anon, authenticated, service_role;
