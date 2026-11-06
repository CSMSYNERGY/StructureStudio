-- 345_library_door_looks.sql — a door made from a photo goes into the builder's library (339), so it
-- shows in every door's "How it looks in 3D" like any other library door (Ahsan, 2026-10-27: "the
-- result goes into their library").
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, AFTER 343_door_looks.sql AND 344_get_fixtures_door_look.sql.
--    NEVER `supabase db push`, never `--file`, never inside begin;/commit;. One inline call per piece,
--    from the repo root in Git Bash (or the Supabase connector's execute_sql, piece by piece):
--
--   F=supabase/migrations/345_library_door_looks.sql
--   piece() { awk -v n="$1" '{sub(/\r$/,"")} $0=="-- >>> "n{on=1;next} $0=="-- <<< "n{on=0} on' "$F" | grep -v '^--'; }
--   "$SB" db query --linked "$(piece P0)"      # must print ONE row: 345, 345_library_door_looks
--   "$SB" db query --linked "$(piece P1)"      # the look rule, the entry and look guards, one look per row
--   "$SB" db query --linked "$(piece R1)"
--   "$SB" db query --linked "$(piece P2)"      # the get_fixtures splice and its checks: ONE do block
--   "$SB" db query --linked "$(piece R2)"      # THE RECORD
--
-- P0 claims the number first: no row back means another session took 345, so rename this file, its test
-- (tests/sql/migration345.test.cjs) and every '345' below. Read the max first, numbered rows only:
-- select max(version) filter (where version ~ '^\d{3}$') from supabase_migrations.schema_migrations;
--
-- ── WHAT IT DOES ─────────────────────────────────────────────────────────────────────────
-- A library door entry may now name one of the builder's own generated looks:
--   client_library.look = { "doorStyle": <the look's base>, "doorLookId": <door_looks.id> }
-- * library_look_ok (339) accepts that shape for doors only, and only with one of the seven bases (never
--   "auto" or "rollup"). StructureStudio templates (library_items) may never hold a doorLookId.
-- * An entry that names a look: the look is the same builder's, READY, and its base is the entry's
--   doorStyle. Once made, the entry's look never changes (rename only), and an entry never gains one.
-- * A look an entry names stays READY with the same base (no archive, no base change) until the entry
--   is removed, so the entry can never point at something get_fixtures would not send.
-- * ONE LOOK PER DOOR ROW: fixture_items holds client_library_id OR door_look_id, never both (CHECK).
--   Setting one clears the other in the same statement (trigger), so a save never fails on it.
-- * get_fixtures (344's merge, spliced, never rewritten): a door row linked to such an entry sends
--   doorLook { id, v, spec, thumbUrl } exactly as a row with door_look_id does, from the same READY look.
--   339's write-through already keeps door_style = the entry's doorStyle = the look's base, so
--   production's designer (which ignores doorLook) draws the base look, as plan §1 Done #8 says.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- No entry names a look at apply, and no row holds both columns, so every tenant's get_fixtures is
-- byte-for-byte unchanged; P2 checks that before it ends. The old portal never sends doorLookId.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   1. Remove the entries that name a look first (their rows fall back to door_style, the base):
--      delete from public.client_library where category = 'door' and look ? 'doorLookId';
--   2. do $rb$
--      declare src text;
--      begin
--        src := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
--        src := replace(src, <345's look_blk, below>, <344's look_blk, below>);
--        execute src;
--        perform pg_notify('pgrst', 'reload schema');
--      end $rb$;
--      (then the body's md5 with carriage returns removed is 344's c7ef0626e645b725f5e16673002ee8a5 again)
--   3. drop trigger if exists fixture_items_one_look on public.fixture_items;
--      drop function if exists public.fixture_items_one_look();
--      alter table public.fixture_items drop constraint if exists fixture_items_one_look_chk;
--      drop trigger if exists door_looks_library_guard on public.door_looks;
--      drop function if exists public.door_looks_library_guard();
--      drop trigger if exists client_library_door_look on public.client_library;
--      drop function if exists public.client_library_door_look();
--      alter table public.library_items drop constraint if exists library_items_no_door_look_chk;
--      and 339's library_look_ok body again (339's P1).
--   4. delete from supabase_migrations.schema_migrations where version = '345' returning version;
--
-- The repo is public: no builder names or ids in here.

-- >>> P0
insert into supabase_migrations.schema_migrations (version, name)
values ('345', '345_library_door_looks')
on conflict (version) do nothing
returning version, name;
-- <<< P0

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P1 — the look rule, the guards, one look per door row
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P1
do $m345_p1$
begin
  perform set_config('lock_timeout', '5s', true);
  if to_regclass('public.door_looks') is null or to_regclass('public.client_library') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fixture_items' and column_name = 'door_look_id') then
    raise exception '345: apply 339_library and 343_door_looks first (client_library, door_looks or fixture_items.door_look_id is missing); nothing changed';
  end if;

  -- 339's rule, with ONE change in the door branch: an optional doorLookId (a uuid) beside one of the
  -- seven bases. Every look 339 accepted is still accepted, so no existing row can fail its CHECK.
  create or replace function public.library_look_ok(p_category text, p_look jsonb)
  returns boolean language sql immutable set search_path = '' as $fn$
    -- coalesce: a CHECK passes on NULL, and a missing key makes these comparisons NULL, not false.
    select coalesce(case
      when p_look is null or jsonb_typeof(p_look) <> 'object' or octet_length(p_look::text) > 1024 then false
      when p_category = 'cladding' then
        not exists (select 1 from jsonb_object_keys(p_look) k where k not in ('profile', 'exposureIn'))
        and coalesce(p_look ->> 'profile', '') in ('panel', 'lap', 'batten', 'agpanel', 'vinyl')
        and (p_look -> 'exposureIn' is null or jsonb_typeof(p_look -> 'exposureIn') = 'null'
             or (p_look ->> 'profile' = 'lap' and jsonb_typeof(p_look -> 'exposureIn') = 'number'
                 and (p_look ->> 'exposureIn')::numeric between 3 and 12))
      when p_category = 'door' then
        not exists (select 1 from jsonb_object_keys(p_look) k where k not in ('doorStyle', 'doorLookId'))
        and coalesce(p_look ->> 'doorStyle', '') in ('auto', 'plank', 'zbrace', 'xbrace', 'rollup', 'american', 'basic', 'classic', 'dutch')
        and (p_look -> 'doorLookId' is null
             or (jsonb_typeof(p_look -> 'doorLookId') = 'string'
                 and (p_look ->> 'doorLookId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 and p_look ->> 'doorStyle' in ('plank', 'zbrace', 'xbrace', 'american', 'basic', 'classic', 'dutch')))
      when p_category = 'window' then
        not exists (select 1 from jsonb_object_keys(p_look) k where k not in ('liteRows', 'liteCols'))
        and ((p_look -> 'liteRows' is null and p_look -> 'liteCols' is null)
             or (jsonb_typeof(p_look -> 'liteRows') = 'number' and jsonb_typeof(p_look -> 'liteCols') = 'number'
                 and (p_look ->> 'liteRows') ~ '^[1-8]$' and (p_look ->> 'liteCols') ~ '^[1-8]$'))
      else false
    end, false)
  $fn$;
  revoke all on function public.library_look_ok(text, jsonb) from public, anon, authenticated;

  -- A StructureStudio template is everyone's: it can never name one builder's own look.
  if not exists (select 1 from pg_constraint where conname = 'library_items_no_door_look_chk'
                  and conrelid = 'public.library_items'::regclass) then
    alter table public.library_items
      add constraint library_items_no_door_look_chk check (not (look ? 'doorLookId'));
  end if;

  -- An entry that names a look: the same builder's, ready, with the entry's base. Fixed once made.
  create or replace function public.client_library_door_look()
  returns trigger language plpgsql set search_path = '' as $fn$
  declare l record;
  begin
    if tg_op = 'UPDATE' and (old.look ? 'doorLookId' or new.look ? 'doorLookId')
       and new.look is distinct from old.look then
      raise exception 'A door made from a photo keeps its look; rename it, or add a new entry instead' using errcode = '23514';
    end if;
    if new.category = 'door' and new.look ? 'doorLookId' then
      -- FOR SHARE: an archive of this look racing this insert waits for it, and its guard then sees
      -- the entry (or this check sees the archive), so an entry can never name a look that is not ready.
      select dl.base, dl.status into l from public.door_looks dl
       where dl.client_id = new.client_id and dl.id = (new.look ->> 'doorLookId')::uuid
       for share;
      if not found then
        raise exception 'That 3D door look isn''t in this catalog' using errcode = '23503';
      end if;
      if l.status <> 'ready' then
        raise exception 'Save that 3D door look before you add it to the library' using errcode = '23514';
      end if;
      if l.base is distinct from new.look ->> 'doorStyle' then
        raise exception 'That library entry''s door look is drawn on a different base' using errcode = '23514';
      end if;
    end if;
    return new;
  end
  $fn$;
  revoke all on function public.client_library_door_look() from public, anon, authenticated;
  drop trigger if exists client_library_door_look on public.client_library;
  create trigger client_library_door_look before insert or update on public.client_library
    for each row execute function public.client_library_door_look();

  -- A look an entry names stays ready, with the same base, until the entry is removed.
  create or replace function public.door_looks_library_guard()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    if (new.status is distinct from old.status or new.base is distinct from old.base)
       and exists (select 1 from public.client_library cl
                    where cl.client_id = old.client_id and cl.category = 'door' and cl.look ->> 'doorLookId' = old.id::text) then
      raise exception 'That 3D door look is in your library; remove it from the library first' using errcode = '23514';
    end if;
    return new;
  end
  $fn$;
  revoke all on function public.door_looks_library_guard() from public, anon, authenticated;
  drop trigger if exists door_looks_library_guard on public.door_looks;
  create trigger door_looks_library_guard before update of status, base on public.door_looks
    for each row execute function public.door_looks_library_guard();

  -- One look per door row. The trigger keeps every save going (the one set last wins); the CHECK is the
  -- guarantee. Named after 339's fixture_items_library_link, so it runs after it (BEFORE triggers run in
  -- name order) and sees the link that trigger kept or dropped.
  create or replace function public.fixture_items_one_look()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    if new.door_look_id is not null and new.client_library_id is not null then
      if tg_op = 'UPDATE' and new.door_look_id is not distinct from old.door_look_id then
        new.door_look_id := null;          -- a library entry was put on: it replaces the row's own look
      else
        new.client_library_id := null;     -- a look was put on (or both arrived at once): the look wins
        -- ...and the row is drawn over the LOOK's base (343's rule), not the entry's, which 339's link
        -- trigger wrote just before this one.
        new.door_style := coalesce((select dl.base from public.door_looks dl
                                     where dl.client_id = new.client_id and dl.id = new.door_look_id), new.door_style);
      end if;
    end if;
    return new;
  end
  $fn$;
  revoke all on function public.fixture_items_one_look() from public, anon, authenticated;
  drop trigger if exists fixture_items_one_look on public.fixture_items;
  create trigger fixture_items_one_look before insert or update on public.fixture_items
    for each row execute function public.fixture_items_one_look();
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_one_look_chk'
                  and conrelid = 'public.fixture_items'::regclass) then
    alter table public.fixture_items
      add constraint fixture_items_one_look_chk check (client_library_id is null or door_look_id is null);
  end if;
  comment on constraint fixture_items_one_look_chk on public.fixture_items is
    'A door row draws ONE look: a library entry (client_library_id, 339) or its own look (door_look_id, '
    '343), never both (345). The fixture_items_one_look trigger clears the older of the two on a save.';
end
$m345_p1$;
-- <<< P1

-- Expect: true, true, true, true, true, 0
-- >>> R1
select public.library_look_ok('door', '{"doorStyle":"classic","doorLookId":"00000000-0000-4000-8000-000000000001"}'::jsonb) as entry_shape_ok,
       not public.library_look_ok('door', '{"doorStyle":"auto","doorLookId":"00000000-0000-4000-8000-000000000001"}'::jsonb) as auto_refused,
       exists (select 1 from pg_constraint where conname = 'library_items_no_door_look_chk') as templates_guarded,
       exists (select 1 from pg_constraint where conname = 'fixture_items_one_look_chk') as one_look_chk,
       (select count(*) = 3 from pg_trigger where not tgisinternal and tgname in ('client_library_door_look', 'door_looks_library_guard', 'fixture_items_one_look')) as triggers_ready,
       (select count(*) from public.fixture_items where client_library_id is not null and door_look_id is not null) as rows_with_both;
-- <<< R1

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P2 — get_fixtures: a door row on such an entry sends the entry's look
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- The body it is derived from: 344's written body, prosrc md5 c7ef0626e645b725f5e16673002ee8a5 with
-- carriage returns removed. The splice swaps 344's one merge line for the line below, nothing else.
-- >>> P2
do $m345_p2$
declare
  src      text := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
  v_src    text;
  old_blk  text := $old$    || case when fi.door_look_id is not null and fi.category = 'door' then coalesce((select jsonb_build_object('doorLook', jsonb_build_object('id', dl.id, 'v', dl.spec_version, 'spec', dl.spec, 'thumbUrl', dl.thumb_url)) from public.door_looks dl where dl.client_id = fi.client_id and dl.id = fi.door_look_id and dl.status = 'ready'), '{}'::jsonb) else '{}'::jsonb end$old$;
  new_blk  text := $new$    || case when fi.category = 'door' and (fi.door_look_id is not null or fi.client_library_id is not null) then coalesce((select jsonb_build_object('doorLook', jsonb_build_object('id', dl.id, 'v', dl.spec_version, 'spec', dl.spec, 'thumbUrl', dl.thumb_url)) from public.door_looks dl where dl.client_id = fi.client_id and dl.status = 'ready' and dl.id = coalesce(fi.door_look_id, (select (cl.look ->> 'doorLookId')::uuid from public.client_library cl where cl.client_id = fi.client_id and cl.id = fi.client_library_id and cl.category = 'door' and cl.look ? 'doorLookId'))), '{}'::jsonb) else '{}'::jsonb end$new$;
  v_before jsonb := '{}'::jsonb;
  v_n      int;
  r        record;
  v_want   text[];
  v_got    text[];
begin
  perform set_config('lock_timeout', '5s', true);
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_one_look_chk') then
    raise exception '345: run P1 first; nothing changed';
  end if;
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if position(new_blk in src) > 0 then
    raise notice '345: get_fixtures already sends a library entry''s look';
  else
    if md5(v_src) <> 'c7ef0626e645b725f5e16673002ee8a5' then
      raise exception '345: the LIVE get_fixtures (prosrc md5 %) is not 344''s written body, so another change has replaced it since. Re-dump it (pg_get_functiondef), check 344''s merge line still stands, and update the md5s in P2.', md5(v_src);
    end if;
    if (length(src) - length(replace(src, old_blk, ''))) / length(old_blk) <> 1 then
      raise exception '345: 344''s doorLook merge is not in the LIVE get_fixtures body exactly once; re-derive it from a fresh pg_get_functiondef dump before applying';
    end if;
    select coalesce(jsonb_object_agg(cc.client_id, public.get_fixtures(cc.client_id)), '{}'::jsonb) into v_before
      from public.client_configs cc;
    execute replace(src, old_blk, new_blk);
  end if;

  -- 1. The body is exactly the one this writes.
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if md5(v_src) <> '02f39b137682b2666a2a53688fdf71ea' then
    raise exception '345: get_fixtures is not the body this splice writes (prosrc md5 %)', md5(v_src);
  end if;
  -- 2. Still security definer with an empty search_path, as 289 wrote it.
  if not exists (select 1 from pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure and p.prosecdef
                   and p.proconfig @> array['search_path=""']) then
    raise exception '345: get_fixtures lost SECURITY DEFINER or its empty search_path';
  end if;

  -- 3. Byte-for-byte unchanged for every tenant with no library entry naming a look (every tenant, on
  --    a first apply), and unchanged apart from doorLook for the rest.
  if v_before <> '{}'::jsonb then
    select count(*) into v_n
      from jsonb_each(v_before) b(client_id, f)
      cross join lateral (select public.get_fixtures(b.client_id) as g) n
     where jsonb_set(b.f, '{items}', coalesce((select jsonb_agg(i - 'doorLook' order by o) from jsonb_array_elements(b.f -> 'items') with ordinality t(i, o)), '[]'::jsonb))
           is distinct from
           jsonb_set(n.g, '{items}', coalesce((select jsonb_agg(i - 'doorLook' order by o) from jsonb_array_elements(n.g -> 'items') with ordinality t(i, o)), '[]'::jsonb))
        or (not exists (select 1 from public.client_library cl where cl.client_id = b.client_id and cl.category = 'door' and cl.look ? 'doorLookId')
            and md5(b.f::text) is distinct from md5(n.g::text));
    if v_n > 0 then
      raise exception '345: get_fixtures changed for % tenant(s) beyond doorLook; this splice must move nothing else', v_n;
    end if;
  end if;

  -- 4. doorLook goes on exactly the listed door rows whose own look, or whose library entry's look, is
  --    ready, and it is that look.
  for r in select cc.client_id from public.client_configs cc loop
    select coalesce(array_agg(fi.id::text || ':' || dl.id::text order by fi.id::text), '{}') into v_want
      from public.fixture_items fi
      left join public.client_library cl on cl.client_id = fi.client_id and cl.id = fi.client_library_id and cl.category = 'door'
      join public.door_looks dl on dl.client_id = fi.client_id and dl.status = 'ready'
        and dl.id = coalesce(fi.door_look_id, (cl.look ->> 'doorLookId')::uuid)
     where fi.client_id = r.client_id and fi.category = 'door' and fi.active
       and fi.price is not null and coalesce(fi.archived, false) = false;
    select coalesce(array_agg((i ->> 'id') || ':' || (i -> 'doorLook' ->> 'id') order by i ->> 'id'), '{}') into v_got
      from jsonb_array_elements(public.get_fixtures(r.client_id) -> 'items') i
     where i ? 'doorLook';
    if v_want is distinct from v_got then
      raise exception '345: get_fixtures(%) sends doorLook as % but the catalog has %', r.client_id, v_got, v_want;
    end if;
  end loop;
  perform pg_notify('pgrst', 'reload schema');
end
$m345_p2$;
-- <<< P2

-- THE RECORD. Expect on a first apply: true, <tenant count>, 0, 0, 02f39b137682b2666a2a53688fdf71ea.
-- >>> R2
select position($k$cl.look ? 'doorLookId'$k$ in pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) > 0 as fixtures_send_it,
       (select count(*) from public.client_configs) as tenants,
       (select count(*) from public.client_library where category = 'door' and look ? 'doorLookId') as library_looks,
       (select count(*) from public.fixture_items where client_library_id is not null and door_look_id is not null) as rows_with_both,
       (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure) as body_md5;
-- <<< R2
