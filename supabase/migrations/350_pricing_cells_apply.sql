-- 350_pricing_cells_apply.sql — the one database call behind the sizes table's saves (Settings →
-- Sheds → "Open sizes & prices table", Carolyn 2026-10-29). portal-settings' save_pricing_cells
-- sends a batch of edits; this function writes them, ONE SIZE AT A TIME, each size's price, Offered
-- and included options together or not at all.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, BEFORE the portal-settings deploy that calls it.
--    Nothing calls the function until then, so applying it early is safe. Run it with
--    `supabase db query --linked --file 350_pricing_cells_apply.sql`, then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('350', '350_pricing_cells_apply') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints only the last statement's rows: THE RECORD
--    at the end is what the apply shows. No row printed means the file did not run. To see the same
--    row and change nothing, run it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- 348 and 349 were taken live on 2026-10-30, so the plan's placeholder 348 became 350. Re-check
-- `max(version) filter (where version ~ '^\d{3}$')` just before applying; if 350 is taken, rename this
-- file, its test (tests/sql/migration350.test.cjs) and every '350' below. The ledger insert's
-- `returning` shows nothing when the number was already taken.
--
-- ── THE CALL ─────────────────────────────────────────────────────────────────────────────
--   public.pricing_cells_apply(p_client_id text, p_creates jsonb, p_removes jsonb, p_sizes jsonb)
--     returns jsonb { created: [...], removed: [...], results: [...] }
--   SECURITY DEFINER, search_path ''. service_role only: PUBLIC, anon and authenticated are revoked,
--   so no browser can reach /rest/v1/rpc/pricing_cells_apply. p_client_id is the tenant
--   portal-settings resolved from the caller's token (resolveTenant), never a body field; every
--   statement below filters by it. The edge (_shared/pricingCells.ts validatePayload) has already
--   checked shapes: uuids, a version on every size entry, whole-number option quantities, sizes
--   0 < w, l <= 500 with at most 2 decimals, labels in the importer's `${w}x${l}` form, at most 50
--   entries and 2,500 cells. The function re-checks the two caps and everything that needs the
--   database (who owns the style, which option columns exist, the stored values).
--   No new table, so no tenantTables.ts entry, and no RLS change.
--
--   0. CONTEXT. The option keys a size may include: the tenant's client_layout_items that are active
--      and not archived, except ramp and partitionWall, plus the ids of their fixture_items that are
--      active and not archived. This is the sheet's own column list (ssPricingColumns,
--      portal/03-catalog.jsx; the importer takes no partitionWall either). rtp_enabled from
--      client_settings, false without a row.
--   1. CREATES, in order, each in its own begin … exception block:
--      • the style must be this tenant's, else refused "That style isn't on this account.";
--      • look the size up by DIMENSIONS first (client_id, style_id, width_ft, length_ft): the same id
--        → duplicate (a resend), another id → exists with existingId. Both carry that row;
--      • the id already used by another row → refused (only a bug or a forged id gets here);
--      • the style already has this label with other dimensions → refused;
--      • otherwise insert it unpriced and not offered, at the end of its style (max sort_order + 1,
--        the importer's rule) → created;
--      • unique_violation (a concurrent create landed between the look-up and the insert): look
--        again by dimensions → exists/duplicate, or refused with the database's message.
--      NO CONSTRAINT NAME IS MATCHED ANYWHERE. Live, the label index (building_sizes_new_style_id_
--      label_key, from 011's building_sizes_new) is checked before the dimensions index
--      (building_sizes_client_style_dims_uniq, 027), so reading the violated constraint's name would
--      report "label taken" for a size that simply already exists.
--   2. REMOVES: only a size that was never priced or edited: base_price is null, updated_at =
--      created_at (both default to now() on insert; set_updated_at moves updated_at on every update),
--      no inclusion rows and no Real-Time Pricing BOM lines. Anything else → refused, "untick Offered
--      to hide it". An id this tenant has no size for, and that no other tenant holds either, answers
--      removed with gone=true: it is already gone (a resend of a remove that landed).
--   3. SIZES, in order, each in its own begin … exception block:
--      • LOCK the row (select … for update, by id AND client_id); no row → missing. Any other save
--        of the same size waits here until this one commits;
--      • the current value of every sent cell (qty when included, else 0);
--      • BOTH CHECKS must pass: the row's updated_at equals the entry's `base` exactly (compared as
--        timestamptz, to the microsecond), and every sent `from` equals its current value;
--      • pass → write: the price when sent (refused per box while RTP is on, or when negative and not
--        what is stored); Offered when sent, else ticked when the price goes from blank to a number,
--        else unchanged, and never without a price (the enforce_size_pricing trigger agrees); the
--        UPDATE always runs, so the version moves even when only cells changed; each cell: a key
--        that is not a column → cellErrors, a quantity that is not a whole number from 0 to 999,999
--        (unless it is what is stored) → cellErrors, > 0 → upsert included, 0 → delete if on file →
--        saved;
--      • fail → write nothing for this size: duplicate when every sent `to` is already what is
--        stored, else conflict;
--      • any other error rolls back only this size → refused, with the database's message (at most
--        200 characters, never one carrying '<', the importer's reason() rule).
--      Every answer carries the size's current version, row and cells, so the browser shows what the
--      server holds.
--   One call is one PostgREST request is one transaction. The edge caps a call at 50 entries because
--   each entry's exception block is a subtransaction, and Postgres caches 64 subtransaction ids per
--   backend before every snapshot falls back to pg_subtrans lookups.
--
-- ── WHY THE SERVER NEVER MERGES (the A→B→A sequence) ─────────────────────────────────────
-- The browser's transport gives up after 25 s and resends through the functions hostname, and the
-- original request can still land later (12-shell.jsx ssStyleSaveCall; _shared/styleSaveGuard.ts).
--   1. Batch 1 (price 400 → 480, base V0) stalls.
--   2. Its side-door copy lands: 480, version V1.
--   3. The builder types 400 again (from 480, base V1). It lands: 400, version V2.
--   4. The stalled original finally arrives. Its base V0 is not V2, and the stored 400 is not its
--      `to` (480), so it gets conflict and nothing is written. Nobody is waiting for that answer.
-- With only the `from` check the orphan would get through (the stored 400 equals its `from`). With
-- only the version check, an edit carrying a stale `from` would get through on a refreshed version
-- (a background refresh, or a backup replayed after a colleague's change). So both are required.
-- Merging (resending on a newer version) happens only in the browser, and only for answers it is
-- still waiting for. tests/sql/migration350.test.cjs pins both with mutants.
--
-- ── WHAT STAYS OPEN ──────────────────────────────────────────────────────────────────────
-- Excel. import_pricing_csv (_shared/pricingImport.ts) bumps every size it names and writes
-- inclusions later with no guard, so an upload overlapping a table save still wins on the boxes it
-- writes, as any upload does today. Row-lock waits between two sessions cannot be tested in PGlite
-- (one connection); they rest on Postgres semantics. lock_timeout 5 s turns a stuck wait into a
-- refused size rather than a hung save.
--
-- ROLLBACK (after portal-settings is reverted to a version without save_pricing_cells):
--   drop function if exists public.pricing_cells_apply(text, jsonb, jsonb, jsonb);

begin;

set local lock_timeout = '5s';

create or replace function public.pricing_cells_apply(p_client_id text, p_creates jsonb, p_removes jsonb, p_sizes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  c_max_entries constant int := 50;
  c_max_cells   constant int := 2500;
  c_max_qty     constant int := 999999;
  v_creates     jsonb := coalesce(p_creates, '[]'::jsonb);
  v_removes     jsonb := coalesce(p_removes, '[]'::jsonb);
  v_sizes       jsonb := coalesce(p_sizes, '[]'::jsonb);
  v_allowed     text[];
  v_rtp         boolean;
  v_created     jsonb := '[]'::jsonb;
  v_removed     jsonb := '[]'::jsonb;
  v_results     jsonb := '[]'::jsonb;
  v_e           jsonb;
  v_id          uuid;
  v_hit         uuid;
  v_style       uuid;
  v_w           numeric;
  v_l           numeric;
  v_label       text;
  v_n           int;
  v_status      text;
  v_reason      text;
  v_gone        boolean;
  v_row         public.building_sizes%rowtype;
  v_from        jsonb;
  v_to          jsonb;
  v_cur         jsonb;
  v_errs        jsonb;
  v_version_ok  boolean;
  v_from_ok     boolean;
  v_price       numeric;
  v_want        numeric;
  v_active      boolean;
  v_k           text;
  v_v           text;
  v_q           numeric;
  v_ans         jsonb;
begin
  -- ── Arguments ──────────────────────────────────────────────────────────────────────────────
  if p_client_id is null or p_client_id !~ '^[a-z0-9][a-z0-9-]*$' then
    raise exception 'pricing_cells_apply: % is not a builder id', coalesce(p_client_id, 'null') using errcode = '22023';
  end if;
  if jsonb_typeof(v_creates) <> 'array' or jsonb_typeof(v_removes) <> 'array' or jsonb_typeof(v_sizes) <> 'array' then
    raise exception 'pricing_cells_apply: creates, removes and sizes must be arrays' using errcode = '22023';
  end if;
  if jsonb_array_length(v_creates) + jsonb_array_length(v_removes) + jsonb_array_length(v_sizes) > c_max_entries then
    raise exception 'pricing_cells_apply: at most % creates, removes and sizes in one call', c_max_entries using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(v_sizes) s(e),
        jsonb_object_keys(case when jsonb_typeof(s.e -> 'to' -> 'cells') = 'object' then s.e -> 'to' -> 'cells' else '{}'::jsonb end)) > c_max_cells then
    raise exception 'pricing_cells_apply: at most % option boxes in one call', c_max_cells using errcode = '22023';
  end if;

  -- ── 0. Context ─────────────────────────────────────────────────────────────────────────────
  -- The sheet's columns (ssPricingColumns): built-ins that are active and not archived, never the
  -- ramp (its own settings section) or a partition wall (278: never part of a size's price), and
  -- catalog fixtures that are active and not archived, keyed by their id.
  v_allowed := array(
    select li.item_key from public.client_layout_items li
     where li.client_id = p_client_id and li.active is true and li.archived is not true
       and li.item_key not in ('ramp', 'partitionWall')
    union
    select f.id::text from public.fixture_items f
     where f.client_id = p_client_id and f.active is not false and f.archived is not true);
  v_rtp := coalesce((select cs.rtp_enabled from public.client_settings cs where cs.client_id = p_client_id), false);

  -- ── 1. Creates ─────────────────────────────────────────────────────────────────────────────
  for v_e in select x from jsonb_array_elements(v_creates) as t(x) loop
    v_id := null; v_hit := null; v_status := null; v_reason := null;
    begin
      v_id := (v_e ->> 'id')::uuid;
      v_style := (v_e ->> 'styleId')::uuid;
      v_w := (v_e ->> 'width')::numeric;
      v_l := (v_e ->> 'length')::numeric;
      v_label := v_e ->> 'label';
      if not exists (select 1 from public.building_styles s where s.id = v_style and s.client_id = p_client_id) then
        v_status := 'refused';
        v_reason := 'That style isn''t on this account.';
      else
        select z.id into v_hit from public.building_sizes z
         where z.client_id = p_client_id and z.style_id = v_style and z.width_ft = v_w and z.length_ft = v_l;
        if v_hit is not null then
          v_status := case when v_hit = v_id then 'duplicate' else 'exists' end;
        elsif exists (select 1 from public.building_sizes z where z.id = v_id) then
          v_status := 'refused';
          v_reason := 'That size id is already in use.';
        elsif exists (select 1 from public.building_sizes z where z.style_id = v_style and z.label = v_label) then
          v_status := 'refused';
          v_reason := format('A size called %s already exists in this style with other measurements.', v_label);
        else
          insert into public.building_sizes (id, client_id, style_id, label, width_ft, length_ft, base_price, active, sort_order)
          values (v_id, p_client_id, v_style, v_label, v_w, v_l, null, false,
                  coalesce((select max(z.sort_order) from public.building_sizes z
                             where z.client_id = p_client_id and z.style_id = v_style), -1) + 1);
          v_hit := v_id;
          v_status := 'created';
        end if;
      end if;
    exception
      when unique_violation then
        -- A concurrent create of the same size landed between the look-up and the insert. Look again
        -- by dimensions; the violated constraint's NAME is never read (see the header).
        v_hit := null;
        select z.id into v_hit from public.building_sizes z
         where z.client_id = p_client_id and z.style_id = v_style and z.width_ft = v_w and z.length_ft = v_l;
        if v_hit is not null then
          v_status := case when v_hit = v_id then 'duplicate' else 'exists' end;
        else
          v_status := 'refused';
          v_reason := case when length(sqlerrm) <= 200 and strpos(sqlerrm, '<') = 0 then sqlerrm else 'The database refused this change.' end;
        end if;
      when others then
        v_hit := null;
        v_status := 'refused';
        v_reason := case when length(sqlerrm) <= 200 and strpos(sqlerrm, '<') = 0 then sqlerrm else 'The database refused this change.' end;
    end;
    v_ans := jsonb_build_object('id', v_e ->> 'id', 'status', v_status);
    if v_hit is not null then
      select z.* into v_row from public.building_sizes z where z.id = v_hit and z.client_id = p_client_id;
      v_ans := v_ans || jsonb_build_object(
        'version', to_jsonb(v_row.updated_at),
        'row', jsonb_build_object('price', v_row.base_price, 'active', v_row.active, 'label', v_row.label,
                                  'width_ft', v_row.width_ft, 'length_ft', v_row.length_ft, 'style_id', v_row.style_id,
                                  'sort_order', v_row.sort_order, 'created_at', to_jsonb(v_row.created_at)),
        'cells', (select coalesce(jsonb_object_agg(i.item_key, i.qty), '{}'::jsonb)
                    from public.building_size_inclusions i where i.size_id = v_hit and i.included));
      if v_status = 'exists' then v_ans := v_ans || jsonb_build_object('existingId', v_hit); end if;
    end if;
    if v_reason is not null then v_ans := v_ans || jsonb_build_object('reason', v_reason); end if;
    v_created := v_created || jsonb_build_array(v_ans);
  end loop;

  -- ── 2. Removes ─────────────────────────────────────────────────────────────────────────────
  for v_e in select x from jsonb_array_elements(v_removes) as t(x) loop
    v_id := null; v_status := null; v_reason := null; v_gone := false;
    begin
      v_id := (v_e #>> '{}')::uuid;
      delete from public.building_sizes z
       where z.id = v_id and z.client_id = p_client_id
         and z.base_price is null and z.updated_at = z.created_at
         and not exists (select 1 from public.building_size_inclusions i where i.size_id = z.id)
         and not exists (select 1 from public.rtp_bom_lines b where b.size_id = z.id);
      get diagnostics v_n = row_count;
      if v_n = 1 then
        v_status := 'removed';
      elsif not exists (select 1 from public.building_sizes z where z.id = v_id) then
        v_status := 'removed';
        v_gone := true;
      else
        v_status := 'refused';
        v_reason := 'Only a size that was never priced or edited can be removed. Untick Offered to hide it.';
      end if;
    exception when others then
      v_status := 'refused';
      v_reason := case when length(sqlerrm) <= 200 and strpos(sqlerrm, '<') = 0 then sqlerrm else 'The database refused this change.' end;
    end;
    v_ans := jsonb_build_object('id', v_e #>> '{}', 'status', v_status);
    if v_gone then v_ans := v_ans || jsonb_build_object('gone', true); end if;
    if v_reason is not null then v_ans := v_ans || jsonb_build_object('reason', v_reason); end if;
    v_removed := v_removed || jsonb_build_array(v_ans);
  end loop;

  -- ── 3. Sizes ───────────────────────────────────────────────────────────────────────────────
  for v_e in select x from jsonb_array_elements(v_sizes) as t(x) loop
    v_id := null; v_status := null; v_reason := null; v_errs := '{}'::jsonb;
    v_from := case when jsonb_typeof(v_e -> 'from') = 'object' then v_e -> 'from' else '{}'::jsonb end;
    v_to := case when jsonb_typeof(v_e -> 'to') = 'object' then v_e -> 'to' else '{}'::jsonb end;
    begin
      v_id := (v_e ->> 'id')::uuid;
      select z.* into v_row from public.building_sizes z where z.id = v_id and z.client_id = p_client_id for update;
      if not found then
        v_status := 'missing';
        v_reason := 'That size isn''t on this account any more.';
      else
        -- The stored value of every box this entry names: the included quantity, or 0.
        select coalesce(jsonb_object_agg(k.key, coalesce(
                 (select case when i.included then i.qty else 0 end
                    from public.building_size_inclusions i
                   where i.size_id = v_id and i.item_key = k.key), 0)), '{}'::jsonb)
          into v_cur
          from (select jsonb_object_keys(coalesce(v_to -> 'cells', '{}'::jsonb)) as key
                union
                select jsonb_object_keys(coalesce(v_from -> 'cells', '{}'::jsonb))) k;

        -- CHECK 1, the version: what the browser last read for this size, exact to the microsecond.
        v_version_ok := v_row.updated_at = (v_e ->> 'base')::timestamptz;
        -- CHECK 2, the starting values: every box this edit was made against still holds it.
        v_from_ok := (not (v_from ? 'price') or (v_from ->> 'price')::numeric is not distinct from v_row.base_price) and (not (v_from ? 'active') or (v_from ->> 'active')::boolean = v_row.active) and not exists (select 1 from jsonb_each_text(coalesce(v_from -> 'cells', '{}'::jsonb)) f where f.value::numeric is distinct from (v_cur ->> f.key)::numeric);

        if coalesce(v_version_ok, false) and coalesce(v_from_ok, false) then
          -- Price.
          v_price := v_row.base_price;
          if v_to ? 'price' then
            v_want := (v_to ->> 'price')::numeric;
            if v_rtp then
              v_errs := v_errs || jsonb_build_object('price', 'Real-Time Pricing sets prices on this account');
            elsif v_want < 0 and v_want is distinct from v_row.base_price then
              v_errs := v_errs || jsonb_build_object('price', 'A price is a number, 0 or more');
            else
              v_price := v_want;
            end if;
          end if;
          -- Offered: as sent; else ticked when the price goes from blank to a number; else as it was.
          -- Never without a price (enforce_size_pricing forces the same).
          if v_to ? 'active' then
            v_active := coalesce((v_to ->> 'active')::boolean, false);
          elsif v_row.base_price is null and v_price is not null then
            v_active := true;
          else
            v_active := v_row.active;
          end if;
          if v_active and v_price is null then
            if v_to ? 'active' then
              v_errs := v_errs || jsonb_build_object('active', 'Add a price first');
            end if;
            v_active := false;
          end if;
          -- Always runs, so set_updated_at moves the version even when only boxes change.
          update public.building_sizes z set base_price = v_price, active = v_active
           where z.id = v_id and z.client_id = p_client_id;
          -- Included options.
          for v_k, v_v in select c.key, c.value from jsonb_each_text(coalesce(v_to -> 'cells', '{}'::jsonb)) c loop
            v_q := v_v::numeric;
            if not (v_k = any(v_allowed)) then
              v_errs := v_errs || jsonb_build_object(v_k, 'That option has no column in your sizes table');
            elsif v_q is null or v_q < 0 or v_q <> trunc(v_q) then
              v_errs := v_errs || jsonb_build_object(v_k, 'Whole numbers only, 0 or more');
            elsif v_q > c_max_qty and v_q is distinct from (v_cur ->> v_k)::numeric then
              v_errs := v_errs || jsonb_build_object(v_k, 'Whole numbers from 0 to 999,999');
            elsif v_q > 0 then
              insert into public.building_size_inclusions (client_id, size_id, item_key, included, qty)
              values (p_client_id, v_id, v_k, true, v_q::int)
              on conflict (size_id, item_key) do update set included = true, qty = excluded.qty;
            else
              delete from public.building_size_inclusions i where i.size_id = v_id and i.item_key = v_k;
            end if;
          end loop;
          v_status := 'saved';
        elsif (not (v_to ? 'price') or (v_to ->> 'price')::numeric is not distinct from v_row.base_price)
              and (not (v_to ? 'active') or (v_to ->> 'active')::boolean = v_row.active)
              and not exists (select 1 from jsonb_each_text(coalesce(v_to -> 'cells', '{}'::jsonb)) t
                               where t.value::numeric is distinct from (v_cur ->> t.key)::numeric) then
          v_status := 'duplicate';
        else
          v_status := 'conflict';
        end if;
      end if;
    exception when others then
      v_status := 'refused';
      v_reason := case when length(sqlerrm) <= 200 and strpos(sqlerrm, '<') = 0 then sqlerrm else 'The database refused this change.' end;
      v_errs := '{}'::jsonb;
    end;
    -- What the server holds now, whatever happened: the browser shows it.
    v_ans := jsonb_build_object('id', v_e ->> 'id', 'status', v_status);
    v_row := null;
    if v_status <> 'missing' then
      select z.* into v_row from public.building_sizes z where z.id = v_id and z.client_id = p_client_id;
    end if;
    if v_row.id is not null then
      v_ans := v_ans || jsonb_build_object(
        'version', to_jsonb(v_row.updated_at),
        'row', jsonb_build_object('price', v_row.base_price, 'active', v_row.active, 'label', v_row.label,
                                  'width_ft', v_row.width_ft, 'length_ft', v_row.length_ft, 'style_id', v_row.style_id,
                                  'sort_order', v_row.sort_order, 'created_at', to_jsonb(v_row.created_at)),
        'cells', (select coalesce(jsonb_object_agg(k.key, coalesce(
                    (select case when i.included then i.qty else 0 end
                       from public.building_size_inclusions i
                      where i.size_id = v_row.id and i.item_key = k.key), 0)), '{}'::jsonb)
                    from (select jsonb_object_keys(coalesce(v_to -> 'cells', '{}'::jsonb)) as key) k));
    else
      v_ans := v_ans || jsonb_build_object('version', null, 'row', null, 'cells', '{}'::jsonb);
    end if;
    if v_reason is not null then v_ans := v_ans || jsonb_build_object('reason', v_reason); end if;
    if v_errs <> '{}'::jsonb then v_ans := v_ans || jsonb_build_object('cellErrors', v_errs); end if;
    v_results := v_results || jsonb_build_array(v_ans);
  end loop;

  return jsonb_build_object('created', v_created, 'removed', v_removed, 'results', v_results);
end
$fn$;

-- FROM PUBLIC, not just the two API roles: Postgres grants EXECUTE on every new function to PUBLIC
-- by default, and PostgREST exposes public-schema functions as /rpc/ endpoints (152's lesson).
revoke all on function public.pricing_cells_apply(text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.pricing_cells_apply(text, jsonb, jsonb, jsonb) to service_role;

comment on function public.pricing_cells_apply(text, jsonb, jsonb, jsonb) is
  'The sizes table''s save (Settings -> Sheds, 2026-10-30): per size, lock, check version AND every '
  'starting value, then write price, Offered and included options together. service_role only; '
  'called by portal-settings save_pricing_cells. See 350_pricing_cells_apply.sql.';

-- ── Apply-time assertions (they RAISE and abort the transaction) ──────────────────────────
do $check$
declare
  v_r jsonb;
begin
  if has_function_privilege('anon', 'public.pricing_cells_apply(text, jsonb, jsonb, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.pricing_cells_apply(text, jsonb, jsonb, jsonb)', 'execute') then
    raise exception '350: a browser role can execute pricing_cells_apply';
  end if;
  if not has_function_privilege('service_role', 'public.pricing_cells_apply(text, jsonb, jsonb, jsonb)', 'execute') then
    raise exception '350: service_role cannot execute pricing_cells_apply';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = 'public.pricing_cells_apply(text, jsonb, jsonb, jsonb)'::regprocedure
                  and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=%') then
    raise exception '350: pricing_cells_apply is not SECURITY DEFINER with a fixed search_path';
  end if;

  -- The function itself, inside this transaction: an empty call for an id nobody has answers three
  -- empty lists, and a call over the cap is refused.
  v_r := public.pricing_cells_apply('zz-apply-check-350', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
  if v_r is distinct from '{"created": [], "removed": [], "results": []}'::jsonb then
    raise exception '350: an empty call answered %', v_r;
  end if;
  begin
    perform public.pricing_cells_apply('zz-apply-check-350', '[]'::jsonb,
      (select jsonb_agg(gen_random_uuid()) from generate_series(1, 51)), '[]'::jsonb);
    raise exception '350: pricing_cells_apply accepted 51 entries';
  exception when invalid_parameter_value then null;
  end;
  raise notice '350: pricing_cells_apply in place, service_role only';
end
$check$;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- THE RECORD — `db query` prints only the last statement's rows, so this is what the apply shows.
-- Expect: true, false, false, true.
-- ═════════════════════════════════════════════════════════════════════════════════════════
select to_regprocedure('public.pricing_cells_apply(text, jsonb, jsonb, jsonb)') is not null as ready,
       has_function_privilege('anon', 'public.pricing_cells_apply(text, jsonb, jsonb, jsonb)', 'execute') as anon_can_execute,
       has_function_privilege('authenticated', 'public.pricing_cells_apply(text, jsonb, jsonb, jsonb)', 'execute') as authenticated_can_execute,
       has_function_privilege('service_role', 'public.pricing_cells_apply(text, jsonb, jsonb, jsonb)', 'execute') as service_role_can_execute;

commit;
