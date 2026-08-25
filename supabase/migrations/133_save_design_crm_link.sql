-- 133_save_design_crm_link.sql — stamp designs.contact_id at save time.
--
-- APPLIED TO LIVE 2026-08-25 AND VERIFIED. This file is the RESULT, recorded so the repo
-- shows what is actually running — it was NOT generated from the repo's copy of
-- save_design.
--
-- 🚨 HOW THIS WAS PRODUCED, AND THE ONLY SAFE WAY TO PRODUCE IT AGAIN.
-- The body below was dumped from LIVE with pg_get_functiondef, the guarded block spliced
-- in, and the two texts diffed to prove the block was the ONLY change. Building it from
-- supabase/migrations/002_design_rpcs.sql would have silently un-shipped three protections
-- that live in the deployed function and nowhere in that file:
--     * 031 — the design_versions snapshot on every save
--     * 104 — inventory-master designs cannot be rewritten
--     * 111 — an INVOICED/DELIVERED design cannot be rewritten by anon
-- Migration 110 documents the same trap for get_config. Never rebuild a wholesale-replaced
-- function from its repo file.
--
-- WHAT THE BLOCK DOES: resolves the submitted contact to a crm_contacts row (migration 130)
-- and stamps designs.contact_id, so notes, activities and the record page have a stable
-- person to hang off. Only when contact_id is still null, so re-saving never re-homes a
-- design after a human has merged or corrected a contact.
--
-- WHY IT SWALLOWS EVERY ERROR: this is bookkeeping and the design is the customer's actual
-- work. A resolver failure must never surface as "your design would not save". 130's
-- backfill is re-runnable and picks up anything missed.
--
-- PROVEN, not assumed (transaction rolled back afterwards, nothing persisted):
--   1. a new design gets contact_id stamped
--   2. "+1 555 010 9999" keys as 5550109999 — country code stripped, no digit lost
--   3. with crm_ensure_contact replaced by one that always raises, THE DESIGN STILL SAVED
--      and contact_id was left null
--
-- Rollback: re-dump from live and remove the `v_contact_id` declaration and the guarded
-- block. Do not restore from 002.

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
  v_contact_id uuid;
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

  -- CRM CONTACT LINK (migration 130). Resolve this submission to a crm_contacts row and
  -- stamp it, so notes, activities and the record page have a stable person to hang off.
  --
  -- WRAPPED AND SWALLOWED ON PURPOSE. This is bookkeeping; the design above is the
  -- customer's actual work. A resolver failure -- a table dropped, a permission changed, a
  -- constraint nobody anticipated -- must NEVER surface as "your design would not save".
  -- The backfill in 130 is re-runnable and will pick up anything missed here. Same
  -- contract as qboInvoice/emailSend: the money and the paperwork never block the save.
  --
  -- Only stamps when contact_id is still null, so re-saving a design never re-homes it to a
  -- different contact after a human has merged or corrected one.
  begin
    v_contact_id := public.crm_ensure_contact(
      p_client_id, p_contact->>'name', p_contact->>'phone', p_contact->>'email');
    if v_contact_id is not null and v_row.contact_id is null then
      update public.designs set contact_id = v_contact_id where short_code = p_code;
      v_row.contact_id := v_contact_id;
    end if;
  exception when others then
    null;
  end;

  return v_row;
end
$function$
;
