-- 324_window_panes.sql — a window row says how many panes its glass is split into.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, BEFORE the portal-settings deploy that reads it (its
--    catalog read selects fixture_items.panes, so a deploy ahead of this file fails every Options
--    tab's load). Run it with `supabase db query --linked --file 324_window_panes.sql`, then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('324', '324_window_panes') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, run it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger 2026-10-21: 323 is the newest, and no branch holds 324. Take the next free number at
-- apply time, renaming this file, its test (tests/sql/migration324.test.cjs) and every '324' below;
-- record the ledger row with `returning`: no row back means the number was taken.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Ahsan, 2026-10-21, after the first transoms in doors (320): builders sell several transom styles,
-- and each is its own window row, but the 3D drew every window's grid by one rule (2 or 3 columns by
-- width). "Add the Panes setting": a window row picks its own pane count. NULL is "Automatic (by
-- width)", today's look exactly, so no window already sold changes.
--
-- ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────────────────
--   PART 1   fixture_items.panes smallint NULL, check in (1, 2, 3, 4, 6), and a second check that it
--            is only ever set on a window. Every row reads NULL.
--   PART 2   get_fixtures, SPLICED (313's anchor-replace on the LIVE body, never rewritten): a window
--            with panes set gains `panes: <n>`, SPARSE, so nothing moves at apply.
--   PART 3   apply-time assertions (they RAISE and abort the transaction).
--   THE RECORD
--
-- The designer reads `panes` live off the catalog (like a window's photo), in d3WindowFill: 1 = plain
-- glass, N = N equal panes with N - 1 vertical bars, for wall windows, windows in a door's upper
-- panel and transoms in doors. A double-hung window keeps its middle rail; only the columns follow
-- the setting. A photo on the window still wins over bars.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- PART 1 adds a column every row reads NULL in, with checks every row passes. Only the new
-- portal-settings writes it. PART 2 sends nothing for any row that exists today; live designers
-- ignore the key either way. PART 3 checks every tenant's get_fixtures is unchanged.
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
--   1. This file, then its ledger row.
--   2. portal-settings (reads and saves the column), from a tree that contains origin/beta.
--   3. The beta designer and portal (the catalog select, the 3D panes).
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────
-- Ship portal-settings without panes in its catalog read and its save FIRST (the read fails on the
-- missing column). Then take the splice back out BEFORE the column goes: get_fixtures does not track
-- what it reads, so a dropped column under the spliced body fails every designer's catalog load.
--   begin;
--   do $rb$
--   declare src text;
--   begin
--     src := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
--     src := replace(src, $k$|| case when fi.panes is not null and fi.category = 'window' then jsonb_build_object('panes', fi.panes) else '{}'::jsonb end
--       $k$, '');
--     execute src;
--   end $rb$;
--   alter table public.fixture_items drop constraint if exists fixture_items_panes_window_chk;
--   alter table public.fixture_items drop constraint if exists fixture_items_panes_chk;
--   alter table public.fixture_items drop column if exists panes;
--   delete from supabase_migrations.schema_migrations where version = '324';
--   notify pgrst, 'reload schema';
--   commit;
-- Then check: position('''panes''' in pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) = 0.

begin;

-- How long this may wait for a lock on fixture_items before it gives up (and changes nothing).
set local lock_timeout = '5s';

-- Every tenant's catalog as it is now, for PART 3 to compare against, with any panes key taken off
-- each item (there is none on a first apply) so a re-apply compares like with like. Dropped at commit.
create temp table m324_before on commit drop as
  select cc.client_id,
         md5(g.f::text) as raw,
         md5(jsonb_set(g.f, '{items}', coalesce((select jsonb_agg(i - 'panes' order by o)
                                                 from jsonb_array_elements(g.f -> 'items') with ordinality t(i, o)), '[]'::jsonb))::text) as stripped
  from public.client_configs cc
  cross join lateral (select public.get_fixtures(cc.client_id) as f) g;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — panes: how many panes a window's glass is split into
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.fixture_items add column if not exists panes smallint;

do $m324_chk$
begin
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_panes_chk'
                  and conrelid = 'public.fixture_items'::regclass) then
    alter table public.fixture_items
      add constraint fixture_items_panes_chk check (panes is null or panes in (1, 2, 3, 4, 6));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_panes_window_chk'
                  and conrelid = 'public.fixture_items'::regclass) then
    alter table public.fixture_items
      add constraint fixture_items_panes_window_chk check (panes is null or category = 'window');
  end if;
end
$m324_chk$;

comment on column public.fixture_items.panes is
  'How many panes a window''s glass is split into in 3D: 1 = plain glass, N = N equal panes with '
  'N - 1 vertical bars. NULL = automatic (2 or 3 by width), the look every window had before 324. '
  'Windows only (fixture_items_panes_window_chk). get_fixtures sends panes only when set.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — get_fixtures: panes, sparse
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Anchored on 289's inDoor merge, one line, no line ending (the live body was applied with CRLF),
-- the same anchor 313 and 320 used; the new merge goes just before it and does NOT contain its
-- text, so a later splice anchored there still finds it exactly once.
-- The body it was derived from: prosrc md5 9c2f3d46395acf52f6c74a223210ecb5 with carriage returns
-- removed (289 + 313's PART 6 + 320's PART 2), read live on 2026-10-21. A body that is neither that
-- one nor the one this writes means another change replaced get_fixtures since: re-dump, re-derive.
do $m324_fix$
declare
  src     text := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
  v_src   text;
  old_blk text := $anchor$|| case when fi.category = 'window' and coalesce(fi.in_door, false)$anchor$;
  new_blk text := $repl$|| case when fi.panes is not null and fi.category = 'window' then jsonb_build_object('panes', fi.panes) else '{}'::jsonb end
    || case when fi.category = 'window' and coalesce(fi.in_door, false)$repl$;
begin
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if position($k$jsonb_build_object('panes'$k$ in src) > 0 then
    raise notice '324: get_fixtures already emits panes';
    return;
  end if;
  if md5(v_src) <> '9c2f3d46395acf52f6c74a223210ecb5' then
    raise exception '324: the LIVE get_fixtures (prosrc md5 %) is not the body PART 2 was derived from on 2026-10-21, so another change has replaced it since. Re-dump it (pg_get_functiondef), check the anchor still stands, and update the md5s in PART 2 and PART 3.', md5(v_src);
  end if;
  if (length(src) - length(replace(src, old_blk, ''))) / length(old_blk) <> 1 then
    raise exception '324: the inDoor merge (289) is not in the LIVE get_fixtures body exactly once — re-derive the anchor from a fresh pg_get_functiondef dump before applying';
  end if;
  execute replace(src, old_blk, new_blk);
end
$m324_fix$;

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
  -- 1. The column: smallint, nullable, no default.
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'fixture_items' and column_name = 'panes'
     and data_type = 'smallint' and is_nullable = 'YES' and column_default is null;
  if v_n <> 1 then
    raise exception '324: fixture_items.panes should be smallint, nullable, with no default';
  end if;

  -- 2. Both checks, as written.
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conname = 'fixture_items_panes_chk' and c.conrelid = 'public.fixture_items'::regclass;
  if v_def is null or position('6' in v_def) = 0 or position('panes' in v_def) = 0 then
    raise exception '324: fixture_items_panes_chk is missing or wrong: %', coalesce(v_def, 'missing');
  end if;
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conname = 'fixture_items_panes_window_chk' and c.conrelid = 'public.fixture_items'::regclass;
  if v_def is null or position('window' in v_def) = 0 then
    raise exception '324: fixture_items_panes_window_chk is missing or wrong: %', coalesce(v_def, 'missing');
  end if;

  -- 3. The body is exactly the one PART 2 writes.
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if md5(v_src) <> '325c73a2e633e884947d6dc795eb36be' then
    raise exception '324: get_fixtures is not the body PART 2 writes (prosrc md5 %)', md5(v_src);
  end if;

  -- 4. Every tenant's get_fixtures is unchanged apart from panes, and byte-for-byte unchanged for a
  --    tenant with no window that has panes set (every tenant, on a first apply).
  select count(*) into v_n from m324_before b
   cross join lateral (select public.get_fixtures(b.client_id) as f) g
   where b.stripped is distinct from md5(jsonb_set(g.f, '{items}', coalesce((select jsonb_agg(i - 'panes' order by o)
                                                     from jsonb_array_elements(g.f -> 'items') with ordinality t(i, o)), '[]'::jsonb))::text)
      or (not exists (select 1 from public.fixture_items fi where fi.client_id = b.client_id and fi.panes is not null)
          and b.raw is distinct from md5(g.f::text));
  if v_n > 0 then
    raise exception '324: get_fixtures changed for % tenant(s) beyond panes; this migration must move nothing else', v_n;
  end if;

  -- 5. panes goes on exactly the listed windows that have it set, with their value, and nowhere else.
  for r in select cc.client_id from public.client_configs cc loop
    select coalesce(array_agg(fi.id::text || ':' || fi.panes order by fi.id::text), '{}') into v_want
      from public.fixture_items fi
     where fi.client_id = r.client_id and fi.panes is not null and fi.active
       and fi.price is not null and coalesce(fi.archived, false) = false;
    select coalesce(array_agg((i ->> 'id') || ':' || (i ->> 'panes') order by i ->> 'id'), '{}') into v_got
      from jsonb_array_elements(public.get_fixtures(r.client_id) -> 'items') i
     where i ? 'panes';
    if v_want is distinct from v_got then
      raise exception '324: get_fixtures(%) sends panes as % but the catalog has %', r.client_id, v_got, v_want;
    end if;
  end loop;
  raise notice '324: panes in place; get_fixtures sends it for windows that set it and nothing else moved';
end
$check$;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- THE RECORD — `db query` prints only the last statement's rows, so this is what the apply shows.
-- Expect on a first apply: true, <tenant count>, 0, true.
-- ═════════════════════════════════════════════════════════════════════════════════════════
select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fixture_items' and column_name = 'panes') as column_ready,
       (select count(*) from public.client_configs) as tenants,
       (select count(*) from public.fixture_items where panes is not null) as windows_with_panes,
       position($k$jsonb_build_object('panes'$k$ in pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) > 0 as fixtures_send_it;

commit;
