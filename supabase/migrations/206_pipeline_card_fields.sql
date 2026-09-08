-- 206_pipeline_card_fields: the dollar value, the expected close date, and who touched a
-- design (Carolyn, 2026-09-07 — "I want to see the dollar value ... and I want to add an
-- expected close date to the quote and see that date on the card").
--
-- FOUR COLUMNS, THREE DIFFERENT KINDS OF THING:
--
--   expected_close_date  NEW DATA. The only genuinely new field. Set from the board card or
--                        the customer record; nothing derives it.
--   total_cents          STORED, NOT DERIVED. See below — this is the load-bearing choice.
--   created_by_user_id   ATTRIBUTION, recorded but NOT DISPLAYED anywhere yet.
--   updated_by_user_id   Carolyn wants filters later ("show me what Rachel quoted"); these
--                        exist now because attribution is the one kind of data that cannot be
--                        backfilled. A filter built in three months over a column added in
--                        three months has three months of blanks, on exactly the deals worth
--                        asking about. She was explicit: "keep the created by / updated by,
--                        just now show it on the cards".
--
-- ── WHY total_cents IS STORED ───────────────────────────────────────────────────────────
-- The card needs a figure per design. The alternative is computing it in the browser, which
-- means the Pipeline query has to select `estimate_lines` + `accepted_snapshot` for every
-- row. MEASURED on structure-studio before choosing: estimate_lines is **32 kB across 43
-- designs** (avg 1.1 kB, max 2 kB) — four times the entire `selections` payload that
-- 02-sales.jsx:236 documents someone deliberately REMOVING from this exact query. Putting
-- four times that back to render one number per card is the wrong direction, and it gets
-- worse per design forever. A stored integer also makes "sort by value" possible later.
--
-- ⚠️ THE ARITHMETIC IS NOT REIMPLEMENTED HERE, ON PURPOSE. Tax-inclusive totals already have
--    exactly two implementations that must agree — `totalFromSnapshot` in
--    _shared/estimateLines.ts and `ssSnapTotals` in portal/04-orders.jsx — and they already
--    drifted apart once, in production, on 2026-09-02: the portal implemented the pre-tax
--    branch only, so every figure was short by exactly the tax on a taxed order and the drift
--    banner blamed a discarded revision for arithmetic. A third copy in PL/pgSQL, with its two
--    branches and its clamping and its discount rule, is the same bug waiting on a schedule.
--    So: this migration adds the column and stamps NOTHING. The six edge-function sites that
--    already write a snapshot set it with `orderCentsFromSnapshot`, and the backfill for
--    existing rows runs the SAME TypeScript over them (scripts/backfill-design-totals.mjs).
--
-- NULL means "no quote yet" and the card says so. It must never be rendered as $0 — 15 of the
-- 43 designs on structure-studio have no lines at all, and a $0 pipeline card is a lie about
-- a real deal.

alter table public.designs
  add column if not exists expected_close_date date,
  add column if not exists total_cents         integer,
  add column if not exists created_by_user_id  uuid,
  add column if not exists updated_by_user_id  uuid;

comment on column public.designs.total_cents is
  'Tax-INCLUSIVE quote total in cents, mirroring orders.total_cents. Written by the edge '
  'functions that write estimate_lines/accepted_snapshot, via orderCentsFromSnapshot. NULL = '
  'no quote yet; render as "No quote yet", never $0. Never compute this in SQL — see 206''s header.';
comment on column public.designs.expected_close_date is
  'When the rep expects this to close. Set from the pipeline board card or the customer record.';
comment on column public.designs.created_by_user_id is
  'Who created the design, from auth.uid() in save_design. NULL for the public designer, where '
  'the CUSTOMER builds it and nobody is signed in — that is correct, not missing data.';
comment on column public.designs.updated_by_user_id is
  'Who last saved the design, from auth.uid() in save_design. Only overwritten by a signed-in '
  'caller, so a customer re-opening their own design cannot blank the rep who last touched it.';

-- The board reads designs over direct PostgREST under the restrictive policies from 154/193,
-- so no grant changes are needed: these columns ride the existing row-level rules.

-- ── save_design: stamp the actor ────────────────────────────────────────────────────────
-- Reproduced from the LIVE definition (which 205_save_design_follow_splice.sql last touched)
-- with only the created_by/updated_by additions. auth.uid() is already read three times in
-- this body — the locked-design check and crm_quote_assign — so this adds a source of truth,
-- not a new dependency.
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
  if v_existing_status in ('accepted', 'invoiced', 'delivered') or exists (select 1 from public.designs d2 where d2.short_code = p_code and d2.accepted_at is not null) then
    if auth.uid() is null or not (
      exists (select 1 from public.client_users cu
               where cu.user_id = auth.uid() and cu.client_id = p_client_id)
      or exists (select 1 from public.app_operators op where op.user_id = auth.uid())
    ) then
      raise exception 'this design is locked -- ask the builder to change it';
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
     custom_options, ro_dimensions, bldg_w, bldg_h, image_url, status,
     created_by_user_id, updated_by_user_id)
  values
    (p_code, p_client_id,
     coalesce(p_contact, '{}'::jsonb),
     coalesce(p_selections, '{}'::jsonb),
     coalesce(p_paint_colors, '{}'::jsonb),
     coalesce(p_items, '[]'::jsonb),
     coalesce(p_custom_options, '[]'::jsonb),
     coalesce(p_ro_dimensions, '{}'::jsonb),
     p_bldg_w, p_bldg_h, p_image_url,
     coalesce(p_status, 'sent'),
     -- NULL on the public designer, and that is the honest answer: the CUSTOMER built it.
     auth.uid(), auth.uid())
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
    -- COALESCE, not assignment. A customer re-opening their own quote link saves through this
    -- same RPC with auth.uid() null; overwriting would erase the rep who last worked on it and
    -- leave the future "updated by" filter reporting nobody on the busiest designs.
    -- created_by is never touched on update: it is a fact about the first save.
    updated_by_user_id = coalesce(auth.uid(), d.updated_by_user_id),
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

  -- CONTACT ASSIGNMENT + AUTO-FOLLOW (migration 189). Carolyn 2026-09-04 @1:09:30: "we do
  -- not ever assign deals. We only assign contacts and followers." The rep who sends the
  -- quote follows the customer, and becomes the assignee under the tenant's
  -- crm_assign_latest_quote rule.
  --
  -- SEPARATE FROM THE BLOCK ABOVE ON PURPOSE. That one swallows, which is right for
  -- something a re-runnable backfill repairs. Nothing can reconstruct who was signed in, so
  -- this one records the failure instead of hiding it.
  begin
    perform public.crm_quote_assign(p_client_id, v_row.contact_id, auth.uid());
  exception when others then
    begin
      perform public.log_error(
        'save_design',
        'crm_quote_assign failed: ' || coalesce(sqlerrm, '(no message)'),
        'crm_quote_assign',
        p_client_id,
        null,
        jsonb_build_object('code', p_code, 'sqlstate', sqlstate),
        'error');
    exception when others then
      null;                      -- a logger that throws must never fail the design save
    end;
  end;

  return v_row;
end
$function$;

-- Rollback:
--   (re-apply 205_save_design_follow_splice.sql to restore the previous save_design body)
--   alter table public.designs
--     drop column if exists expected_close_date,
--     drop column if exists total_cents,
--     drop column if exists created_by_user_id,
--     drop column if exists updated_by_user_id;
