-- 320_door_window_at.sql — a window can go in a door as a TRANSOM, across the top of each leaf.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, BEFORE the portal-settings deploy that reads it (its
--    catalog read selects fixture_items.door_window_at, so a deploy ahead of this file fails every
--    Options tab's load). Run it with `supabase db query --linked --file 320_door_window_at.sql`,
--    then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('320', '320_door_window_at') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, run it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger 2026-10-21: 318 is the newest, and the tax-tracking branch (ss/c1021-tax-tracking)
-- holds 319 unapplied. Take the next free number at apply time, renaming this file, its test
-- (tests/sql/migration320.test.cjs) and every '320' below; record the ledger row with `returning`:
-- no row back means the number was taken.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Yoder Barns (portal feature request, 2026-08-07): "Need to be able to add transom windows in
-- doors". Carolyn, 10-19: due 10-31. Yoder's catalog already has "Transom Windows" 29 x 10 in, and
-- their doors are 72 in doubles. Since 289 a window ticked "Can be used inside a door" (in_door) can
-- go in the UPPER PANEL of each leaf of the four built door looks, but a 29 in transom does not fit
-- the upper panel of a 35 in leaf (the 3.5 in stiles), and a transom is not a panel window anyway:
-- it is glass across the top of the door. So a window row now says WHERE in the door it goes.
--
-- ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────────────────
--   PART 1   fixture_items.door_window_at text not null default 'panel', check ('panel', 'top'),
--            and a second check that 'top' is only ever on a window that can go in a door
--            (category 'window' and in_door). Every row reads 'panel', which is 289 exactly.
--   PART 2   get_fixtures, SPLICED (313's anchor-replace on the LIVE body, never rewritten): a window
--            set to 'top' gains `doorWindowAt: 'top'`, SPARSE, so nothing moves at apply (no row is
--            'top' until the new portal-settings saves one).
--   PART 3   apply-time assertions (they RAISE and abort the transaction).
--   THE RECORD
--
-- The designer (both twins, "WINDOWS IN DOORS") reads `doorWindowAt` off the fixture and stamps it on
-- the placed door; a transom goes in the four built looks, the board-and-batten looks and a plain
-- slab with no photo, one per leaf, priced like 289's window (its own window line at the window's
-- catalog price). submit-estimate writes "Transom in door: <door>". The key is `doorWindowAt`, never
-- `transom`: that word is already a DORMER type in the designer.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- PART 1 adds a column every row reads 'panel' in, with checks every row passes. The live
-- portal-settings never writes it (the default fills inserts; updates leave it alone), and unticking
-- in_door on a row that is 'top' is refused by the check, which only the new portal-settings can
-- reach, since only it can set 'top' (it resets to 'panel' in the same write). PART 2 sends nothing
-- for any row that exists today; live designers ignore the key either way (production's designer has
-- no window-in-door code at all). PART 3 checks every tenant's get_fixtures is unchanged.
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
--   1. This file, then its ledger row.
--   2. portal-settings (reads and saves the column) and submit-estimate (the words), from a tree
--      that contains origin/beta.
--   3. The beta designer and portal (the catalog select, the picker, the 3D transom).
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────
-- Ship portal-settings without door_window_at in its catalog read and its save FIRST (the read fails
-- on the missing column). Then take the splice back out BEFORE the column goes: get_fixtures does not
-- track what it reads, so a dropped column under the spliced body fails every designer's catalog load.
--   begin;
--   do $rb$
--   declare src text;
--   begin
--     src := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
--     src := replace(src, $k$|| case when fi.door_window_at = 'top' and fi.category = 'window' and coalesce(fi.in_door, false) then jsonb_build_object('doorWindowAt', 'top') else '{}'::jsonb end
--       $k$, '');
--     execute src;
--   end $rb$;
--   alter table public.fixture_items drop constraint if exists fixture_items_door_window_top_chk;
--   alter table public.fixture_items drop constraint if exists fixture_items_door_window_at_chk;
--   alter table public.fixture_items drop column if exists door_window_at;
--   delete from supabase_migrations.schema_migrations where version = '320';
--   notify pgrst, 'reload schema';
--   commit;
-- Then check: position('doorWindowAt' in pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) = 0.

begin;

-- How long this may wait for a lock on fixture_items before it gives up (and changes nothing).
set local lock_timeout = '5s';

-- Every tenant's catalog as it is now, for PART 3 to compare against, with any doorWindowAt key taken
-- off each item (there is none on a first apply) so a re-apply compares like with like. Dropped at commit.
create temp table m320_before on commit drop as
  select cc.client_id,
         md5(g.f::text) as raw,
         md5(jsonb_set(g.f, '{items}', coalesce((select jsonb_agg(i - 'doorWindowAt' order by o)
                                                 from jsonb_array_elements(g.f -> 'items') with ordinality t(i, o)), '[]'::jsonb))::text) as stripped
  from public.client_configs cc
  cross join lateral (select public.get_fixtures(cc.client_id) as f) g;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — door_window_at: where in a door a window goes
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.fixture_items add column if not exists door_window_at text not null default 'panel';

do $m320_chk$
begin
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_door_window_at_chk'
                  and conrelid = 'public.fixture_items'::regclass) then
    alter table public.fixture_items
      add constraint fixture_items_door_window_at_chk check (door_window_at in ('panel', 'top'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_door_window_top_chk'
                  and conrelid = 'public.fixture_items'::regclass) then
    alter table public.fixture_items
      add constraint fixture_items_door_window_top_chk check (door_window_at = 'panel' or (category = 'window' and in_door));
  end if;
end
$m320_chk$;

comment on column public.fixture_items.door_window_at is
  'Where a window that can go in a door (in_door) sits in it: ''panel'' = the upper panel of each '
  'leaf (289, the default); ''top'' = a transom across the top of each leaf, under the top rail '
  '(Yoder Barns, 2026-10-21). ''top'' only on a window with in_door (fixture_items_door_window_top_chk). '
  'get_fixtures sends doorWindowAt: ''top'' only then.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — get_fixtures: doorWindowAt, sparse
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Anchored on 289's inDoor merge, one line, no line ending: the live body was applied with CRLF.
-- The new merge goes just before it, after 313's inPartition merge, and is written so that it does
-- NOT itself contain the anchor's text: a later splice anchored on the inDoor merge still finds it
-- exactly once.
-- The body it was derived from: prosrc md5 06ff912026e31ca460781f7b05f8269d with carriage returns
-- removed (289's body plus 313's PART 6), read live on 2026-10-21. A body that is neither that one nor
-- the one this writes means another change replaced get_fixtures since: re-dump it and re-derive.
do $m320_fix$
declare
  src     text := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
  v_src   text;
  old_blk text := $anchor$|| case when fi.category = 'window' and coalesce(fi.in_door, false)$anchor$;
  new_blk text := $repl$|| case when fi.door_window_at = 'top' and fi.category = 'window' and coalesce(fi.in_door, false) then jsonb_build_object('doorWindowAt', 'top') else '{}'::jsonb end
    || case when fi.category = 'window' and coalesce(fi.in_door, false)$repl$;
begin
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if position('doorWindowAt' in src) > 0 then
    raise notice '320: get_fixtures already emits doorWindowAt';
    return;
  end if;
  if md5(v_src) <> '06ff912026e31ca460781f7b05f8269d' then
    raise exception '320: the LIVE get_fixtures (prosrc md5 %) is not the body PART 2 was derived from on 2026-10-21, so another change has replaced it since. Re-dump it (pg_get_functiondef), check the anchor still stands, and update the md5s in PART 2 and PART 3.', md5(v_src);
  end if;
  if (length(src) - length(replace(src, old_blk, ''))) / length(old_blk) <> 1 then
    raise exception '320: the inDoor merge (289) is not in the LIVE get_fixtures body exactly once — re-derive the anchor from a fresh pg_get_functiondef dump before applying';
  end if;
  execute replace(src, old_blk, new_blk);
end
$m320_fix$;

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
  -- 1. The column: text, not null, default 'panel'.
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'fixture_items' and column_name = 'door_window_at'
     and data_type = 'text' and is_nullable = 'NO' and column_default like '''panel''%';
  if v_n <> 1 then
    raise exception '320: fixture_items.door_window_at should be text not null default ''panel''';
  end if;

  -- 2. Both checks, as written.
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conname = 'fixture_items_door_window_at_chk' and c.conrelid = 'public.fixture_items'::regclass;
  if v_def is null or position('panel' in v_def) = 0 or position('top' in v_def) = 0 then
    raise exception '320: fixture_items_door_window_at_chk is missing or wrong: %', coalesce(v_def, 'missing');
  end if;
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conname = 'fixture_items_door_window_top_chk' and c.conrelid = 'public.fixture_items'::regclass;
  if v_def is null or position('in_door' in v_def) = 0 or position('window' in v_def) = 0 then
    raise exception '320: fixture_items_door_window_top_chk is missing or wrong: %', coalesce(v_def, 'missing');
  end if;

  -- 3. The body is exactly the one PART 2 writes, with the new merge once and the anchor once.
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if md5(v_src) <> '9c2f3d46395acf52f6c74a223210ecb5' then
    raise exception '320: get_fixtures is not the body PART 2 writes (prosrc md5 %)', md5(v_src);
  end if;

  -- 4. Every tenant's get_fixtures is unchanged apart from doorWindowAt, and byte-for-byte unchanged
  --    for a tenant with no 'top' window (every tenant, on a first apply).
  select count(*) into v_n from m320_before b
   cross join lateral (select public.get_fixtures(b.client_id) as f) g
   where b.stripped is distinct from md5(jsonb_set(g.f, '{items}', coalesce((select jsonb_agg(i - 'doorWindowAt' order by o)
                                                     from jsonb_array_elements(g.f -> 'items') with ordinality t(i, o)), '[]'::jsonb))::text)
      or (not exists (select 1 from public.fixture_items fi where fi.client_id = b.client_id and fi.door_window_at = 'top')
          and b.raw is distinct from md5(g.f::text));
  if v_n > 0 then
    raise exception '320: get_fixtures changed for % tenant(s) beyond doorWindowAt; this migration must move nothing else', v_n;
  end if;

  -- 5. doorWindowAt goes on exactly the listed windows set to 'top', and nowhere else.
  for r in select cc.client_id from public.client_configs cc loop
    select coalesce(array_agg(fi.id::text order by fi.id::text), '{}') into v_want
      from public.fixture_items fi
     where fi.client_id = r.client_id and fi.door_window_at = 'top' and fi.active
       and fi.price is not null and coalesce(fi.archived, false) = false;
    select coalesce(array_agg(i ->> 'id' order by i ->> 'id'), '{}') into v_got
      from jsonb_array_elements(public.get_fixtures(r.client_id) -> 'items') i
     where i ->> 'doorWindowAt' = 'top';
    if v_want is distinct from v_got then
      raise exception '320: get_fixtures(%) sends doorWindowAt on % but the catalog has % set to top', r.client_id, v_got, v_want;
    end if;
  end loop;
  raise notice '320: door_window_at in place; get_fixtures sends doorWindowAt for top windows only and nothing else moved';
end
$check$;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- THE RECORD — `db query` prints only the last statement's rows, so this is what the apply shows.
-- Expect on a first apply: true, <tenant count>, 0, 0, true.
-- ═════════════════════════════════════════════════════════════════════════════════════════
select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fixture_items' and column_name = 'door_window_at') as column_ready,
       (select count(*) from public.client_configs) as tenants,
       (select count(*) from public.fixture_items where door_window_at = 'top') as top_windows,
       (select count(*) from public.fixture_items where door_window_at not in ('panel', 'top')) as bad_rows,
       position('doorWindowAt' in pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) > 0 as fixtures_send_it;

commit;
