-- 351_pricing_sizes_delete.sql — Delete for priced sizes in the sizes table (Settings → Sheds →
-- "Open sizes & prices table", Carolyn's call 2026-10-30: "we need a simple delete button").
-- Plan: _Extras/StructureStudio Pricing Table Delete Plan 2026-10-31.md, §4.1 (Ahsan 10-31: build
-- it with the recommended defaults: refuse a size saved designs use, leftovers of deleted designs
-- count as in use, no undo).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, BEFORE the portal-settings deploy that reads
--    pricing_sizes_in_use (size_table) and before any browser sends an object remove. Applying it
--    early is safe: it changes answers only for object removes, which nothing sends yet, and adds
--    two functions nothing calls yet. Run it with
--    `supabase db query --linked --file 351_pricing_sizes_delete.sql`, then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('351', '351_pricing_sizes_delete') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints only the last statement's rows: THE RECORD
--    at the end is what the apply shows. No row printed means the file did not run. To see the same
--    row and change nothing, run it with the last `commit;` swapped for `rollback;`.
--    THE RECORD must read ready true, the two browser roles false, service_role true and
--    used_check 'ran'. 'skipped' on live means the live refusal check found no size in use and did
--    not run: stop and look (live had 72 sizes in use on 2026-10-31).
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger max numbered version was 350 on 2026-10-31 and no remote branch added a 351. Re-check
-- `max(version) filter (where version ~ '^\d{3}$')` just before applying; if 351 is taken, rename this
-- file, its test (tests/sql/migration351.test.cjs) and every '351' below. The ledger insert's
-- `returning` shows nothing when the number was already taken.
--
-- ── WHAT IT ADDS ─────────────────────────────────────────────────────────────────────────
--   1. public.ss_size_norm(text) returns text. IMMUTABLE, search_path ''. The re-pricing code's
--      `norm` (_shared/attributeLines.ts, submit-estimate): lowercase, × and ✕ read as x, every
--      space stripped. So " 10 × 12 " and "10X12" are both "10x12", and NULL is ''. Style keys and
--      labels go through the same rule. JavaScript's \s takes U+FEFF and Postgres's doesn't, so
--      U+FEFF is stripped here by name (\uFEFF): a size that `norm` matches across one is in use
--      here too. What Postgres's \s still takes beyond JavaScript's (U+001C-001F, U+0085) can only
--      add sizes to in use, the safe side.
--   2. public.pricing_sizes_in_use(p_client_id text) returns uuid[]. STABLE, SECURITY DEFINER,
--      search_path ''. The ids of this tenant's sizes that any of its saved work names:
--        designs.selections, design_versions.selections, designs.accepted_snapshot.selections and
--        change_orders.snapshot_before.selections,
--      matched as the re-pricing code matches them: the style by key OR label, the size by label,
--      both through ss_size_norm. A blank size names nothing. Every arm filters by p_client_id, so
--      another builder's design naming the same style and size counts for nothing here.
--      Leftovers count (plan Q8, kept in v1): versions and change orders whose designs row is gone
--      still name their size, because an old version link still loads by its code alone (193).
--      An ARRAY, not setof: PostgREST cuts a set an rpc returns at db-max-rows (1000), and a big
--      tenant could pass that. ONE definition, read by the delete below and by size_table (portal-
--      settings, _shared/pricingCells.ts readSizeTable), so the greyed ✕ and the server agree.
--   3. public.pricing_cells_apply, replaced with the same signature (so its grants stand). Its body
--      is a byte copy of 350's except three sections marked `[351.a begin]` … `[351.a end]` (b, c):
--        a. the up-front lock list reads an object remove's id too. Without it, an object entry's
--           text never matches the uuid pattern and its size would go unlocked;
--        b. v_used (and the delete's other variables), set after the locks from
--           pricing_sizes_in_use, only when the call carries an object remove;
--        c. the removes loop. A uuid STRING keeps 350's rule word for word: only a size never priced
--           or edited goes, its refusal carries no code. An OBJECT {id, base} is the confirmed Delete,
--           checked in this order:
--             1. no row of this tenant's        → removed, gone: true (as 350);
--             2. updated_at is not base         → refused, code "changed";
--             3. it has Real-Time Pricing BOM lines → refused, code "bom";
--             4. saved designs use it (v_used)  → refused, code "used";
--             5. otherwise its included boxes are read (the cascade takes them), the row is deleted
--                (returning *), and the answer carries `row` and `cells` as they were: removed.
--           Any other error → refused, code "error", with the importer's reason() text. A lock wait
--           or deadlock is raised again, as everywhere in 350. The answer's `id` is the uuid string
--           for both shapes (the browser matches it to what it sent). `reason` is only the server's
--           fallback text; the browser words every refusal from `code` (plan §2.4).
--      tests/sql/migration351.test.cjs pins that the body equals 350's outside the marked sections.
--   No new table, so no tenantTables.ts entry, and no RLS change. The only two tables that hold a
--   size id, building_size_inclusions and rtp_bom_lines, are ON DELETE CASCADE.
--
-- ── WHAT STAYS OPEN (accepted, plan §3) ──────────────────────────────────────────────────
-- Designs aren't locked: a quote saved between the in-use read and the delete (a shopper on an old
-- page choosing that exact size while the builder deletes it) gets submit-estimate's 400 "No price
-- is set…" on its next send, as clearing a price can today. A late create after its size was
-- deleted inserts it again, unpriced and hidden (350's gap, unchanged). Lead form answers are not
-- scanned (0 rows live). The audit row stays best-effort, after the commit (pricingCells.ts).
--
-- ── ROLLBACK (revert the portal-settings deploy FIRST: its size_table reads pricing_sizes_in_use) ──
--   1. re-run supabase/migrations/350_pricing_cells_apply.sql as it stands (its create or replace
--      puts 350's body back; its grants and checks are idempotent), then
--   2. drop function if exists public.pricing_sizes_in_use(text);
--      drop function if exists public.ss_size_norm(text);
--      notify pgrst, 'reload schema';
--   and delete the ledger row: delete from supabase_migrations.schema_migrations where version = '351';
--   A size deleted while 351 was live stays deleted: its id is in the audit row's deletedIds, and
--   its row and boxes were in that save's answer, not anywhere in the database.

begin;

set local lock_timeout = '5s';

-- ── 1. The label rule ────────────────────────────────────────────────────────────────────
create or replace function public.ss_size_norm(text)
returns text
language sql
immutable
set search_path = ''
as $norm$
  select regexp_replace(lower(translate(coalesce($1, ''), '×✕', 'xx')), '[\s\uFEFF]', '', 'g')
$norm$;

-- ── 2. Which sizes saved designs use ─────────────────────────────────────────────────────
create or replace function public.pricing_sizes_in_use(p_client_id text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $inuse$
  with u(st, sz) as (
    select d.selections ->> 'style', d.selections ->> 'size' from public.designs d where d.client_id = p_client_id
    union select v.selections ->> 'style', v.selections ->> 'size' from public.design_versions v where v.client_id = p_client_id
    union select d.accepted_snapshot -> 'selections' ->> 'style', d.accepted_snapshot -> 'selections' ->> 'size'
            from public.designs d where d.client_id = p_client_id and d.accepted_snapshot is not null
    union select c.snapshot_before -> 'selections' ->> 'style', c.snapshot_before -> 'selections' ->> 'size'
            from public.change_orders c where c.client_id = p_client_id and c.snapshot_before is not null
  ), n as (
    select distinct public.ss_size_norm(st) st, public.ss_size_norm(sz) sz from u where coalesce(sz, '') <> ''
  )
  select coalesce(array_agg(distinct z.id), '{}')
    from public.building_sizes z
    join public.building_styles s on s.id = z.style_id and s.client_id = p_client_id
    join n on n.sz = public.ss_size_norm(z.label)
          and (n.st = public.ss_size_norm(s.key) or n.st = public.ss_size_norm(s.label))
   where z.client_id = p_client_id
$inuse$;

-- ── 3. The save, with the Delete ─────────────────────────────────────────────────────────
-- 350's function, three marked sections changed (the header above). Everything else, the comments
-- included, is 350's text byte for byte; read 350_pricing_cells_apply.sql's header for the rest.
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
  c_uuid        constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
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
  -- [351.b begin] The Delete's state: the sizes saved designs use, and one object remove's answer.
  v_used        uuid[] := '{}';
  v_obj         boolean;
  v_code        text;
  v_cells       jsonb;
  -- [351.b end]
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

  -- Every existing size this call removes or edits, locked now in ONE statement, in id order (the
  -- locks are taken above the sort, so in that order). Two saves naming the same sizes in different
  -- orders then queue on the first instead of deadlocking halfway through. A malformed id is left to
  -- its own entry below, which refuses it: the CASE never casts what the pattern did not pass.
  -- Outside any entry's block, so a wait past lock_timeout here ends the whole call (see the header).
  perform 1 from public.building_sizes z
   where z.client_id = p_client_id
     and z.id = any (array(
           select case when e.x ->> 'id' ~* c_uuid then (e.x ->> 'id')::uuid end from jsonb_array_elements(v_sizes) e(x)
           union all
           -- [351.a begin] A remove is a uuid string (350's Remove) or an object {id, base} (351's
           -- Delete): read the id from either, or an object's size would go unlocked.
           select case when r.t ~* c_uuid then r.t::uuid end
             from jsonb_array_elements(v_removes) e(x)
             cross join lateral (select case when jsonb_typeof(e.x) = 'object' then e.x ->> 'id' else e.x #>> '{}' end) r(t)))
           -- [351.a end]
   order by z.id
   for update;

  -- [351.b begin] The sizes saved designs use (pricing_sizes_in_use: designs, their versions,
  -- accepted snapshots and change orders, the style by key or label, the size by label). Read after
  -- the locks, and only when the call deletes (an object remove): a call of 350's shape never reads it.
  if exists (select 1 from jsonb_array_elements(v_removes) e(x) where jsonb_typeof(e.x) = 'object') then
    v_used := public.pricing_sizes_in_use(p_client_id);
  end if;
  -- [351.b end]

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
      -- A lock wait past lock_timeout, a deadlock: the whole call fails and is resent (header).
      when transaction_rollback or lock_not_available then raise;
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
  -- [351.c begin] Two shapes. A uuid STRING is 350's Remove, rule and words unchanged: only a size
  -- never priced or edited goes, and a refusal carries no code. Tabs opened before 351 send these,
  -- and the browser still sends one for a size never priced or edited (no confirm). An OBJECT
  -- {id, base} is the confirmed Delete, checked in this order: no row of this tenant's → removed,
  -- gone (as 350); updated_at is not base → "changed"; Real-Time Pricing BOM lines → "bom"; saved
  -- designs use it → "used"; otherwise its boxes are read BEFORE the delete (the cascade takes
  -- them), the row is deleted, and the answer carries the row and those boxes as they were. Any
  -- other error → "error". So every object refusal carries a code; `reason` is the fallback text.
  -- The answer's id is the uuid string for both shapes.
  for v_e in select x from jsonb_array_elements(v_removes) as t(x) loop
    v_id := null; v_status := null; v_reason := null; v_gone := false;
    v_obj := jsonb_typeof(v_e) = 'object'; v_code := null; v_cells := null; v_row := null;
    begin
      if not v_obj then
        v_id := (v_e #>> '{}')::uuid;
        delete from public.building_sizes z
         where z.id = v_id and z.client_id = p_client_id
           and z.base_price is null and z.updated_at = z.created_at
           and not exists (select 1 from public.building_size_inclusions i where i.size_id = z.id)
           and not exists (select 1 from public.rtp_bom_lines b where b.size_id = z.id);
        get diagnostics v_n = row_count;
        if v_n = 1 then
          v_status := 'removed';
        elsif not exists (select 1 from public.building_sizes z where z.id = v_id and z.client_id = p_client_id) then
          -- Nothing of this tenant's to remove: a resend of a remove that landed, or an id that was
          -- never theirs. Another builder's rows are not looked at, so both answer alike (header).
          v_status := 'removed';
          v_gone := true;
        else
          v_status := 'refused';
          v_reason := 'Only a size that was never priced or edited can be removed. Untick Offered to hide it.';
        end if;
      else
        v_id := (v_e ->> 'id')::uuid;
        select z.* into v_row from public.building_sizes z where z.id = v_id and z.client_id = p_client_id;
        if not found then
          -- As a string remove: a resend of a delete that landed, or an id that was never theirs.
          v_status := 'removed';
          v_gone := true;
        elsif v_row.updated_at is distinct from (v_e ->> 'base')::timestamptz then
          -- Exact to the microsecond, as the sizes arm's version check: what the browser confirmed
          -- is not what is on file now (a colleague, an Excel upload, another tab).
          v_status := 'refused';
          v_code := 'changed';
          v_reason := 'This size was changed since it was read, so it wasn''t deleted.';
        elsif exists (select 1 from public.rtp_bom_lines b where b.size_id = v_id) then
          v_status := 'refused';
          v_code := 'bom';
          v_reason := 'This size has a Real-Time Pricing materials list, so it wasn''t deleted.';
        elsif v_id = any (v_used) then
          v_status := 'refused';
          v_code := 'used';
          v_reason := 'Saved designs use this size, so it can''t be deleted. Untick Offered to hide it.';
        else
          select coalesce(jsonb_object_agg(i.item_key, i.qty), '{}'::jsonb) into v_cells
            from public.building_size_inclusions i where i.size_id = v_id and i.included;
          delete from public.building_sizes z where z.id = v_id and z.client_id = p_client_id returning z.* into v_row;
          -- Locked above, so only a trigger could keep the row: then nothing went, and it says so.
          if not found then raise exception 'This size wasn''t deleted.'; end if;
          v_status := 'removed';
        end if;
      end if;
    exception
      when transaction_rollback or lock_not_available then raise;
      when others then
        v_status := 'refused';
        v_code := case when v_obj then 'error' end;
        v_reason := case when length(sqlerrm) <= 200 and strpos(sqlerrm, '<') = 0 then sqlerrm else 'The database refused this change.' end;
    end;
    v_ans := jsonb_build_object('id', case when v_obj then v_e ->> 'id' else v_e #>> '{}' end, 'status', v_status);
    if v_gone then v_ans := v_ans || jsonb_build_object('gone', true); end if;
    if v_code is not null then v_ans := v_ans || jsonb_build_object('code', v_code); end if;
    if v_reason is not null then v_ans := v_ans || jsonb_build_object('reason', v_reason); end if;
    if v_obj and v_status = 'removed' and not v_gone then
      -- What went, in the sizes arm's shape: the browser and support know exactly, and a later undo
      -- has the data.
      v_ans := v_ans || jsonb_build_object(
        'row', jsonb_build_object('price', v_row.base_price, 'active', v_row.active, 'label', v_row.label,
                                  'width_ft', v_row.width_ft, 'length_ft', v_row.length_ft, 'style_id', v_row.style_id,
                                  'sort_order', v_row.sort_order, 'created_at', to_jsonb(v_row.created_at)),
        'cells', v_cells);
    end if;
    v_removed := v_removed || jsonb_build_array(v_ans);
  end loop;
  -- [351.c end]

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
    exception
      when transaction_rollback or lock_not_available then raise;
      when others then
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
-- by default, and PostgREST exposes public-schema functions as /rpc/ endpoints (152's lesson). The
-- replaced pricing_cells_apply keeps 350's grants (same signature); they are re-stated anyway.
revoke all on function public.ss_size_norm(text) from public, anon, authenticated;
grant execute on function public.ss_size_norm(text) to service_role;
revoke all on function public.pricing_sizes_in_use(text) from public, anon, authenticated;
grant execute on function public.pricing_sizes_in_use(text) to service_role;
revoke all on function public.pricing_cells_apply(text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.pricing_cells_apply(text, jsonb, jsonb, jsonb) to service_role;

comment on function public.ss_size_norm(text) is
  'A style or size name as the re-pricing code compares it (_shared/attributeLines.ts norm): '
  'lowercase, × and ✕ as x, no spaces. See 351_pricing_sizes_delete.sql.';
comment on function public.pricing_sizes_in_use(text) is
  'The ids of a tenant''s sizes that its designs, design versions, accepted snapshots or change '
  'orders name (style by key or label, size by label, through ss_size_norm), as one array. Read by '
  'pricing_cells_apply''s Delete and by portal-settings size_table. service_role only. See 351.';
comment on function public.pricing_cells_apply(text, jsonb, jsonb, jsonb) is
  'The sizes table''s save (Settings -> Sheds, 2026-10-30): per size, lock, check version AND every '
  'starting value, then write price, Offered and included options together. A remove {id, base} '
  'deletes a size at that version unless saved designs use it (351). service_role only; called by '
  'portal-settings save_pricing_cells. See 350_pricing_cells_apply.sql and 351_pricing_sizes_delete.sql.';

-- ── Apply-time assertions (they RAISE and abort the transaction) ──────────────────────────
do $check$
declare
  v_sig text;
  v_r   jsonb;
  v_id  uuid := gen_random_uuid();
begin
  -- 1. No browser role can execute any of the three; service_role can. The two that read tables
  --    are SECURITY DEFINER, and all three have a fixed search_path.
  foreach v_sig in array array['public.ss_size_norm(text)', 'public.pricing_sizes_in_use(text)',
                               'public.pricing_cells_apply(text, jsonb, jsonb, jsonb)'] loop
    if has_function_privilege('anon', v_sig, 'execute') or has_function_privilege('authenticated', v_sig, 'execute') then
      raise exception '351: a browser role can execute %', v_sig;
    end if;
    if not has_function_privilege('service_role', v_sig, 'execute') then
      raise exception '351: service_role cannot execute %', v_sig;
    end if;
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_sig::regprocedure
                    and array_to_string(p.proconfig, ',') like '%search_path=%'
                    and (p.prosecdef or (v_sig = 'public.ss_size_norm(text)' and p.provolatile = 'i'))) then
      raise exception '351: % is not SECURITY DEFINER (or immutable) with a fixed search_path', v_sig;
    end if;
  end loop;
  if (select p.proretset or p.prorettype <> 'uuid[]'::regtype from pg_catalog.pg_proc p
       where p.oid = 'public.pricing_sizes_in_use(text)'::regprocedure) then
    raise exception '351: pricing_sizes_in_use must return one uuid[], not a set (db-max-rows would cut a set)';
  end if;

  -- 2. The label rule.
  if public.ss_size_norm(' 10 × 12 ') is distinct from '10x12' or public.ss_size_norm('10X12') is distinct from '10x12'
     or public.ss_size_norm('10✕12') is distinct from '10x12' or public.ss_size_norm(null) is distinct from ''
     or public.ss_size_norm(chr(65279) || '10x12') is distinct from '10x12'
     or public.ss_size_norm('10' || chr(65279) || 'x12') is distinct from '10x12' then
    raise exception '351: ss_size_norm does not read sizes as the re-pricing code does';
  end if;

  -- 3. 350's own checks, on the new body: an empty call for an id nobody has answers three empty
  --    lists, and a call over the cap is refused. Then one remove of each shape for an id nobody
  --    holds: both gone, the answer's id the uuid string, a code on neither.
  v_r := public.pricing_cells_apply('zz-apply-check-351', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
  if v_r is distinct from '{"created": [], "removed": [], "results": []}'::jsonb then
    raise exception '351: an empty call answered %', v_r;
  end if;
  begin
    perform public.pricing_cells_apply('zz-apply-check-351', '[]'::jsonb,
      (select jsonb_agg(gen_random_uuid()) from generate_series(1, 51)), '[]'::jsonb);
    raise exception '351: pricing_cells_apply accepted 51 entries';
  exception when invalid_parameter_value then null;
  end;
  v_r := public.pricing_cells_apply('zz-apply-check-351', '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('id', v_id, 'base', to_jsonb(now()) #>> '{}'), gen_random_uuid()), '[]'::jsonb);
  if v_r -> 'removed' -> 0 is distinct from jsonb_build_object('id', v_id::text, 'status', 'removed', 'gone', true)
     or v_r -> 'removed' -> 1 ->> 'status' is distinct from 'removed' or (v_r -> 'removed' -> 1) ? 'code' then
    raise exception '351: removes of an id nobody holds answered %', v_r -> 'removed';
  end if;
  raise notice '351: ss_size_norm, pricing_sizes_in_use and pricing_cells_apply in place, service_role only';
end
$check$;

-- 4. A LIVE size that saved designs use is refused. The first tenant (by id) with a size in use and
--    no BOM lines on it: a delete at its version must answer refused / used, and one at a stale
--    version refused / changed, and the row must still be there after each. No id is in this file;
--    the size is picked here, at run time. Everything runs inside this migration's transaction, so
--    even a wrong delete would be rolled back with the rest when the check raises. With no size in
--    use anywhere (a fresh or local database) the check is skipped, with a notice, and THE RECORD
--    says which: ss.m351_used_check is 'ran' or 'skipped' (transaction-local; a DO block cannot feed
--    the final select any other way). On live it must read 'ran'.
do $live$
declare
  v_cid  text;
  v_id   uuid;
  v_base timestamptz;
  v_a    jsonb;
begin
  perform set_config('ss.m351_used_check', 'skipped', true);
  for v_cid in select distinct z.client_id from public.building_sizes z
                where z.client_id ~ '^[a-z0-9][a-z0-9-]*$' order by 1 loop
    select u.id into v_id from unnest(public.pricing_sizes_in_use(v_cid)) u(id)
     where not exists (select 1 from public.rtp_bom_lines b where b.size_id = u.id)
     order by u.id limit 1;
    continue when v_id is null;
    select z.updated_at into v_base from public.building_sizes z where z.id = v_id and z.client_id = v_cid;

    v_a := public.pricing_cells_apply(v_cid, '[]'::jsonb,
      jsonb_build_array(jsonb_build_object('id', v_id, 'base', to_jsonb(v_base) #>> '{}')), '[]'::jsonb) -> 'removed' -> 0;
    if v_a ->> 'status' is distinct from 'refused' or v_a ->> 'code' is distinct from 'used' then
      raise exception '351: a size saved designs use answered % / %, not refused / used',
        coalesce(v_a ->> 'status', 'nothing'), coalesce(v_a ->> 'code', 'no code');
    end if;
    if not exists (select 1 from public.building_sizes z where z.id = v_id) then
      raise exception '351: a size saved designs use was deleted';
    end if;

    v_a := public.pricing_cells_apply(v_cid, '[]'::jsonb,
      jsonb_build_array(jsonb_build_object('id', v_id, 'base', to_jsonb(v_base - interval '1 millisecond') #>> '{}')), '[]'::jsonb) -> 'removed' -> 0;
    if v_a ->> 'status' is distinct from 'refused' or v_a ->> 'code' is distinct from 'changed' then
      raise exception '351: a delete at a stale version answered % / %, not refused / changed',
        coalesce(v_a ->> 'status', 'nothing'), coalesce(v_a ->> 'code', 'no code');
    end if;
    if not exists (select 1 from public.building_sizes z where z.id = v_id) then
      raise exception '351: a delete at a stale version deleted the size';
    end if;

    perform set_config('ss.m351_used_check', 'ran', true);
    raise notice '351: a live size saved designs use is refused (used), and a stale version too (changed)';
    exit;
  end loop;
  if current_setting('ss.m351_used_check', true) = 'skipped' then
    raise notice '351: no size in use, live refusal check skipped';
  end if;
end
$live$;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- THE RECORD — `db query` prints only the last statement's rows, so this is what the apply shows.
-- Expect: true, false, false, true, 'ran', and the number of sizes saved designs use (counts only;
-- 72 live on 2026-10-31).
-- ═════════════════════════════════════════════════════════════════════════════════════════
select to_regprocedure('public.pricing_cells_apply(text, jsonb, jsonb, jsonb)') is not null
         and to_regprocedure('public.pricing_sizes_in_use(text)') is not null
         and to_regprocedure('public.ss_size_norm(text)') is not null as ready,
       has_function_privilege('anon', 'public.pricing_cells_apply(text, jsonb, jsonb, jsonb)', 'execute')
         or has_function_privilege('anon', 'public.pricing_sizes_in_use(text)', 'execute')
         or has_function_privilege('anon', 'public.ss_size_norm(text)', 'execute') as anon_can_execute,
       has_function_privilege('authenticated', 'public.pricing_cells_apply(text, jsonb, jsonb, jsonb)', 'execute')
         or has_function_privilege('authenticated', 'public.pricing_sizes_in_use(text)', 'execute')
         or has_function_privilege('authenticated', 'public.ss_size_norm(text)', 'execute') as authenticated_can_execute,
       has_function_privilege('service_role', 'public.pricing_cells_apply(text, jsonb, jsonb, jsonb)', 'execute')
         and has_function_privilege('service_role', 'public.pricing_sizes_in_use(text)', 'execute')
         and has_function_privilege('service_role', 'public.ss_size_norm(text)', 'execute') as service_role_can_execute,
       current_setting('ss.m351_used_check', true) as used_check,
       (select coalesce(sum(cardinality(public.pricing_sizes_in_use(c.client_id))), 0)::int
          from (select distinct z.client_id from public.building_sizes z) c) as sizes_in_use;

commit;
