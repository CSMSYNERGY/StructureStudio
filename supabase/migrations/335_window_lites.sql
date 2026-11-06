-- 335_window_lites.sql — a window row's default GRID: rows x columns of lites. Replaces 324's Panes.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, BEFORE the portal-settings deploy that reads it (its
--    catalog read selects fixture_items.lite_rows and lite_cols, so a deploy ahead of this file fails
--    every Options tab's load). Run it with `supabase db query --linked --file 335_window_lites.sql`,
--    then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('335', '335_window_lites') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, run it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger 2026-10-24: 334 is the newest, and no branch holds 335. Take the next free number at
-- apply time, renaming this file, its test (tests/sql/migration335.test.cjs) and every '335' below;
-- record the ledger row with `returning`: no row back means the number was taken.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-10-23 call: every window draws grids in 3D although nobody asked for them. Every
-- window must be able to have no grid, or a grid of lites (L-I-T-E). Ahsan, 2026-10-24: describe a
-- grid as ROWS x COLUMNS of lites: no grid = 1 x 1, her transom = 1 row of 5 (vertical bars only),
-- a "6-lite" window = 3 x 2, a "9-lite" door window = 3 x 3. Set as a default per window row in
-- Settings, which replaces 324's Panes (1/2/3/4/6 columns), and changed per placed window by the rep
-- in the designer (that override lives on the design's item, not here).
--
-- ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────────────────
--   PART 0   refuses to run while any row still uses 324's panes (none did on 2026-10-24), so no
--            builder's choice is dropped silently. panes itself stays, unread; see LATER below.
--   PART 1   fixture_items.lite_rows and lite_cols, smallint NULL: both NULL (automatic, the grid every
--            window drew before 335) or both whole numbers 1 to 8, and only ever on a window. Every
--            existing row reads NULL, so every window already sold keeps its look.
--   PART 2   get_fixtures, SPLICED (313's anchor-replace on the LIVE body, never rewritten): 324's panes
--            merge is replaced by a lites merge, so a window with a grid set gains
--            `liteRows: <n>, liteCols: <n>`, SPARSE, and nothing moves at apply.
--   PART 3   apply-time assertions (they RAISE and abort the transaction).
--   THE RECORD
--
-- The designer reads the pair live off the catalog (like a window's photo), in d3WindowFill: exactly
-- rows - 1 horizontal and columns - 1 vertical bars, equal lites inside the sash, for wall windows,
-- windows in a door's upper panel and transoms in doors. NULL keeps the automatic grid. A photo on
-- the window still wins over bars. The estimate line and the plan page say "6-lite (3 rows of 2)".
-- portal-settings gives a NEW window 1 x 1 (no grid) unless one is sent.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- PART 1 adds columns every row reads NULL in, with checks every row passes. Only the new
-- portal-settings writes them. PART 2 sends nothing for any row that exists today (no row has a grid
-- and none has panes), and live designers ignore the keys either way. PART 3 checks every tenant's
-- get_fixtures is unchanged. The live portal-settings (v404) still selects and writes panes, which
-- stays, so it keeps working until the new one is deployed.
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
--   1. This file, then its ledger row.
--   2. portal-settings (reads and saves the grid, no longer panes) and submit-estimate (says the grid on
--      the window's line), from a tree that contains origin/beta.
--   3. The beta designer and portal (the Settings grid, the rep's override, the 3D grid).
--
-- ── LATER ───────────────────────────────────────────────────────────────────────────────
-- Once no deployed portal-settings selects panes (after step 2), panes can be dropped with its two
-- checks in a migration of its own. Nothing reads it after this file.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────
-- Ship portal-settings without the grid in its catalog read and its save FIRST (the read fails on the
-- missing columns). Then put 324's panes merge back BEFORE the columns go: get_fixtures does not track
-- what it reads, so a dropped column under the spliced body fails every designer's catalog load.
--   begin;
--   do $rb$
--   declare src text;
--   begin
--     src := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
--     src := replace(src, $k$|| case when fi.lite_rows is not null and fi.category = 'window' then jsonb_build_object('liteRows', fi.lite_rows, 'liteCols', fi.lite_cols) else '{}'::jsonb end$k$,
--                         $k$|| case when fi.panes is not null and fi.category = 'window' then jsonb_build_object('panes', fi.panes) else '{}'::jsonb end$k$);
--     execute src;
--   end $rb$;
--   alter table public.fixture_items drop constraint if exists fixture_items_lites_window_chk;
--   alter table public.fixture_items drop constraint if exists fixture_items_lites_chk;
--   alter table public.fixture_items drop column if exists lite_cols;
--   alter table public.fixture_items drop column if exists lite_rows;
--   delete from supabase_migrations.schema_migrations where version = '335';
--   notify pgrst, 'reload schema';
--   commit;
-- Then check: position('''liteRows''' in pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) = 0.

begin;

-- How long this may wait for a lock on fixture_items before it gives up (and changes nothing).
set local lock_timeout = '5s';

-- Every tenant's catalog as it is now, for PART 3 to compare against, with any panes / liteRows /
-- liteCols key taken off each item (there is none on a first apply) so a re-apply compares like with
-- like. Dropped at commit.
create temp table m335_before on commit drop as
  select cc.client_id,
         md5(g.f::text) as raw,
         md5(jsonb_set(g.f, '{items}', coalesce((select jsonb_agg(i - 'panes' - 'liteRows' - 'liteCols' order by o)
                                                 from jsonb_array_elements(g.f -> 'items') with ordinality t(i, o)), '[]'::jsonb))::text) as stripped
  from public.client_configs cc
  cross join lateral (select public.get_fixtures(cc.client_id) as f) g;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 0 — no builder's Panes choice is dropped silently
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $m335_panes$
declare v_n int;
begin
  select count(*) into v_n from public.fixture_items where panes is not null;
  if v_n > 0 then
    raise exception '335: % window(s) use 324''s Panes. Carry each one over to a grid by hand (lite_rows = 1 for a transom, 2 for a double-hung window; lite_cols = panes) and set panes back to NULL, then apply again', v_n;
  end if;
end
$m335_panes$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — lite_rows and lite_cols: a window's default grid of lites
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.fixture_items add column if not exists lite_rows smallint;
alter table public.fixture_items add column if not exists lite_cols smallint;

do $m335_chk$
begin
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_lites_chk'
                  and conrelid = 'public.fixture_items'::regclass) then
    -- Both or neither: the IS NOT NULLs are what refuse a half-set pair, since a CHECK passes on NULL
    -- and `1 between 1 and 8 and NULL between 1 and 8` is NULL.
    alter table public.fixture_items
      add constraint fixture_items_lites_chk check (
        (lite_rows is null and lite_cols is null)
        or (lite_rows is not null and lite_cols is not null
            and lite_rows between 1 and 8 and lite_cols between 1 and 8));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_lites_window_chk'
                  and conrelid = 'public.fixture_items'::regclass) then
    alter table public.fixture_items
      add constraint fixture_items_lites_window_chk check (lite_rows is null or category = 'window');
  end if;
end
$m335_chk$;

comment on column public.fixture_items.lite_rows is
  'A window''s default grid in 3D: how many ROWS of lites (335; with lite_cols). 1 x 1 = no grid. '
  'NULL with lite_cols NULL = automatic, the grid every window drew before 335. Windows only. '
  'The rep can change it per placed window in the designer. get_fixtures sends liteRows only when set.';
comment on column public.fixture_items.lite_cols is
  'A window''s default grid in 3D: how many lites ACROSS each row (335; with lite_rows). See lite_rows.';
comment on column public.fixture_items.panes is
  'SUPERSEDED by lite_rows / lite_cols (335): nothing reads it any more, and get_fixtures no longer sends '
  'it. Kept only while the portal-settings deployed before 335 still selects it; drop it after.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — get_fixtures: the grid, sparse, in place of 324's panes
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Anchored on 324's panes merge, one line, no line ending (the live body was applied with CRLF), and
-- replaced by the lites merge in the same place, so 289's inDoor merge right after it (the anchor 313,
-- 320 and 324 used) still stands exactly once for a later splice.
-- The body it was derived from: prosrc md5 325c73a2e633e884947d6dc795eb36be with carriage returns
-- removed (289 + 313's PART 6 + 320's PART 2 + 324's PART 2), read live on 2026-10-24. A body that is
-- neither that one nor the one this writes means another change replaced get_fixtures since:
-- re-dump, re-derive.
do $m335_fix$
declare
  src     text := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
  v_src   text;
  old_blk text := $anchor$|| case when fi.panes is not null and fi.category = 'window' then jsonb_build_object('panes', fi.panes) else '{}'::jsonb end$anchor$;
  new_blk text := $repl$|| case when fi.lite_rows is not null and fi.category = 'window' then jsonb_build_object('liteRows', fi.lite_rows, 'liteCols', fi.lite_cols) else '{}'::jsonb end$repl$;
begin
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if position($k$jsonb_build_object('liteRows'$k$ in src) > 0 then
    raise notice '335: get_fixtures already emits the grid';
    return;
  end if;
  if md5(v_src) <> '325c73a2e633e884947d6dc795eb36be' then
    raise exception '335: the LIVE get_fixtures (prosrc md5 %) is not the body PART 2 was derived from on 2026-10-24, so another change has replaced it since. Re-dump it (pg_get_functiondef), check the anchor still stands, and update the md5s in PART 2 and PART 3.', md5(v_src);
  end if;
  if (length(src) - length(replace(src, old_blk, ''))) / length(old_blk) <> 1 then
    raise exception '335: 324''s panes merge is not in the LIVE get_fixtures body exactly once — re-derive the anchor from a fresh pg_get_functiondef dump before applying';
  end if;
  execute replace(src, old_blk, new_blk);
end
$m335_fix$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — apply-time assertions
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $check$
declare
  v_n     int;
  v_def   text;
  v_src   text;
  r       record;
  v_want  text[];
  v_got   text[];
begin
  -- 1. The columns: smallint, nullable, no default.
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'fixture_items' and column_name in ('lite_rows', 'lite_cols')
     and data_type = 'smallint' and is_nullable = 'YES' and column_default is null;
  if v_n <> 2 then
    raise exception '335: fixture_items.lite_rows and lite_cols should be smallint, nullable, with no default';
  end if;

  -- 2. Both checks, as written.
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conname = 'fixture_items_lites_chk' and c.conrelid = 'public.fixture_items'::regclass;
  if v_def is null or position('8' in v_def) = 0 or position('lite_cols' in v_def) = 0 then
    raise exception '335: fixture_items_lites_chk is missing or wrong: %', coalesce(v_def, 'missing');
  end if;
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conname = 'fixture_items_lites_window_chk' and c.conrelid = 'public.fixture_items'::regclass;
  if v_def is null or position('window' in v_def) = 0 then
    raise exception '335: fixture_items_lites_window_chk is missing or wrong: %', coalesce(v_def, 'missing');
  end if;

  -- 3. The body is exactly the one PART 2 writes.
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if md5(v_src) <> '050771662b98682be0aaa97da8d87d5f' then
    raise exception '335: get_fixtures is not the body PART 2 writes (prosrc md5 %)', md5(v_src);
  end if;

  -- 4. Every tenant's get_fixtures is unchanged apart from the grid, and byte-for-byte unchanged for a
  --    tenant with no window that has a grid set (every tenant, on a first apply).
  select count(*) into v_n from m335_before b
   cross join lateral (select public.get_fixtures(b.client_id) as f) g
   where b.stripped is distinct from md5(jsonb_set(g.f, '{items}', coalesce((select jsonb_agg(i - 'panes' - 'liteRows' - 'liteCols' order by o)
                                                     from jsonb_array_elements(g.f -> 'items') with ordinality t(i, o)), '[]'::jsonb))::text)
      or (not exists (select 1 from public.fixture_items fi where fi.client_id = b.client_id and fi.lite_rows is not null)
          and b.raw is distinct from md5(g.f::text));
  if v_n > 0 then
    raise exception '335: get_fixtures changed for % tenant(s) beyond the grid; this migration must move nothing else', v_n;
  end if;

  -- 5. The grid goes on exactly the listed windows that have one, with their values, and nowhere
  --    else; panes on none.
  for r in select cc.client_id from public.client_configs cc loop
    select coalesce(array_agg(fi.id::text || ':' || fi.lite_rows || 'x' || fi.lite_cols order by fi.id::text), '{}') into v_want
      from public.fixture_items fi
     where fi.client_id = r.client_id and fi.lite_rows is not null and fi.active
       and fi.price is not null and coalesce(fi.archived, false) = false;
    select coalesce(array_agg((i ->> 'id') || ':' || (i ->> 'liteRows') || 'x' || (i ->> 'liteCols') order by i ->> 'id'), '{}') into v_got
      from jsonb_array_elements(public.get_fixtures(r.client_id) -> 'items') i
     where i ? 'liteRows' or i ? 'liteCols';
    if v_want is distinct from v_got then
      raise exception '335: get_fixtures(%) sends the grid as % but the catalog has %', r.client_id, v_got, v_want;
    end if;
    if exists (select 1 from jsonb_array_elements(public.get_fixtures(r.client_id) -> 'items') i where i ? 'panes') then
      raise exception '335: get_fixtures(%) still sends panes', r.client_id;
    end if;
  end loop;
  raise notice '335: the grid is in place; get_fixtures sends it for windows that set it and nothing else moved';
end
$check$;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- THE RECORD — `db query` prints only the last statement's rows, so this is what the apply shows.
-- Expect on a first apply: true, <tenant count>, 0, true, false.
-- ═════════════════════════════════════════════════════════════════════════════════════════
select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'fixture_items' and column_name in ('lite_rows', 'lite_cols')) = 2 as columns_ready,
       (select count(*) from public.client_configs) as tenants,
       (select count(*) from public.fixture_items where lite_rows is not null) as windows_with_a_grid,
       position($k$jsonb_build_object('liteRows'$k$ in pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) > 0 as fixtures_send_it,
       position($k$jsonb_build_object('panes'$k$ in pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) > 0 as fixtures_send_panes;

commit;
