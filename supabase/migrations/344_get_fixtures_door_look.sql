-- 344_get_fixtures_door_look.sql — get_fixtures sends a door row's own 3D look (door looks from a
-- photo, plan 2026-10-24 §6, the plan's "337"; renumbered to 344 on 2026-10-27).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, AFTER 343_door_looks.sql. NEVER `supabase db push`,
--    never `--file`, never inside begin;/commit;. Two inline calls, from the repo root in Git Bash:
--
--   F=supabase/migrations/344_get_fixtures_door_look.sql
--   piece() { awk -v n="$1" '{sub(/\r$/,"")} $0=="-- >>> "n{on=1;next} $0=="-- <<< "n{on=0} on' "$F" | grep -v '^--'; }
--   "$SB" db query --linked "$(piece P0)"      # must print ONE row: 344, 344_get_fixtures_door_look
--   "$SB" db query --linked "$(piece P1)"      # the splice and its checks: ONE do block
--   "$SB" db query --linked "$(piece R1)"      # THE RECORD (see its comment)
--
-- P0 claims the number first: no row back means another session took 344, so rename this file, its
-- test (tests/sql/migration344.test.cjs) and every '344' below. P1 is ONE do block, so the splice and
-- every check after it land together or not at all.
--
-- ── WHAT IT DOES ─────────────────────────────────────────────────────────────────────────
-- get_fixtures is SPLICED (313's anchor-replace on the LIVE body, never rewritten). One merge goes in
-- right after 335's lites merge, so a door row whose look is READY gains
--   doorLook: { id, v, spec, thumbUrl }
-- SPARSE: nothing for a door with no look, a draft or archived look, or any other category, and
-- never the photo paths, the ledger, the look's name, its creator or its save version. 289's inDoor
-- merge right after it still stands exactly once, for the next splice.
--
-- The look is read from the same tenant as the door row (dl.client_id = fi.client_id), which the
-- composite FK of 343 already guarantees; the filter is written anyway so the read can never cross.
-- get_fixtures returns only p_client_id's rows, and anyone may call it for any tenant, exactly as for
-- the door list and its prices today: a look is as public as the builder's own catalog (question 5).
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- No look exists at apply, so every tenant's output is byte-for-byte unchanged, and P1 checks that
-- before it ends. Live designers ignore the key either way. P1 refuses to run before 343 (the body
-- would name a table that is not there, and every designer's catalog load would fail).
--
-- ── ROLLBACK (before 343's) ──────────────────────────────────────────────────────────────
--   do $rb$
--   declare src text;
--   begin
--     src := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
--     src := replace(src, chr(10) || $k$    || case when fi.door_look_id is not null and fi.category = 'door' then coalesce((select jsonb_build_object('doorLook', jsonb_build_object('id', dl.id, 'v', dl.spec_version, 'spec', dl.spec, 'thumbUrl', dl.thumb_url)) from public.door_looks dl where dl.client_id = fi.client_id and dl.id = fi.door_look_id and dl.status = 'ready'), '{}'::jsonb) else '{}'::jsonb end$k$, '');
--     execute src;
--     perform pg_notify('pgrst', 'reload schema');
--   end $rb$;
--   delete from supabase_migrations.schema_migrations where version = '344' returning version;
-- Then check: position('''doorLook''' in pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) = 0,
-- and the body's md5 with carriage returns removed is 335's 050771662b98682be0aaa97da8d87d5f again.
--
-- The repo is public: no builder names or ids in here.

-- >>> P0
insert into supabase_migrations.schema_migrations (version, name)
values ('344', '344_get_fixtures_door_look')
on conflict (version) do nothing
returning version, name;
-- <<< P0

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P1 — the splice, then every check, in one do block
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- The body it was derived from: prosrc md5 050771662b98682be0aaa97da8d87d5f with carriage returns
-- removed (289 + 313 + 320 + 324 + 335), 335's written body, which 335 recorded live on 2026-10-24.
-- A body that is neither that one nor the one this writes means another change replaced
-- get_fixtures since: re-dump, re-derive the anchor and both md5s.
-- >>> P1
do $m344$
declare
  src      text := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
  v_src    text;
  anchor   text := $anchor$|| case when fi.lite_rows is not null and fi.category = 'window' then jsonb_build_object('liteRows', fi.lite_rows, 'liteCols', fi.lite_cols) else '{}'::jsonb end$anchor$;
  look_blk text := $look$    || case when fi.door_look_id is not null and fi.category = 'door' then coalesce((select jsonb_build_object('doorLook', jsonb_build_object('id', dl.id, 'v', dl.spec_version, 'spec', dl.spec, 'thumbUrl', dl.thumb_url)) from public.door_looks dl where dl.client_id = fi.client_id and dl.id = fi.door_look_id and dl.status = 'ready'), '{}'::jsonb) else '{}'::jsonb end$look$;
  v_before jsonb := '{}'::jsonb;
  v_n      int;
  r        record;
  v_want   text[];
  v_got    text[];
begin
  perform set_config('lock_timeout', '5s', true);
  -- 0. 343 first: the merge reads door_looks and fixture_items.door_look_id.
  if to_regclass('public.door_looks') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fixture_items' and column_name = 'door_look_id') then
    raise exception '344: apply 343_door_looks first (door_looks or fixture_items.door_look_id is missing); nothing changed';
  end if;

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if position($k$jsonb_build_object('doorLook'$k$ in src) > 0 then
    raise notice '344: get_fixtures already sends doorLook';
  else
    if md5(v_src) <> '050771662b98682be0aaa97da8d87d5f' then
      raise exception '344: the LIVE get_fixtures (prosrc md5 %) is not the body this splice was derived from (335''s), so another change has replaced it since. Re-dump it (pg_get_functiondef), check the anchor still stands, and update the md5s in P1.', md5(v_src);
    end if;
    if (length(src) - length(replace(src, anchor, ''))) / length(anchor) <> 1 then
      raise exception '344: 335''s lites merge is not in the LIVE get_fixtures body exactly once; re-derive the anchor from a fresh pg_get_functiondef dump before applying';
    end if;
    -- Every tenant's catalog as it is now, for check 3.
    select coalesce(jsonb_object_agg(cc.client_id, public.get_fixtures(cc.client_id)), '{}'::jsonb) into v_before
      from public.client_configs cc;
    execute replace(src, anchor, anchor || chr(10) || look_blk);
  end if;

  -- 1. The body is exactly the one this writes.
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if md5(v_src) <> 'c7ef0626e645b725f5e16673002ee8a5' then
    raise exception '344: get_fixtures is not the body this splice writes (prosrc md5 %)', md5(v_src);
  end if;
  -- 2. Still security definer with an empty search_path, as 289 wrote it.
  if not exists (select 1 from pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure and p.prosecdef
                   and p.proconfig @> array['search_path=""']) then
    raise exception '344: get_fixtures lost SECURITY DEFINER or its empty search_path';
  end if;

  -- 3. Every tenant's output is unchanged apart from doorLook, and byte-for-byte unchanged for a
  --    tenant with no ready look on a listed door (every tenant, on a first apply).
  select count(*) into v_n
    from jsonb_each(v_before) b(client_id, f)
    cross join lateral (select public.get_fixtures(b.client_id) as g) n
   where jsonb_set(b.f, '{items}', coalesce((select jsonb_agg(i - 'doorLook' order by o) from jsonb_array_elements(b.f -> 'items') with ordinality t(i, o)), '[]'::jsonb))
         is distinct from
         jsonb_set(n.g, '{items}', coalesce((select jsonb_agg(i - 'doorLook' order by o) from jsonb_array_elements(n.g -> 'items') with ordinality t(i, o)), '[]'::jsonb))
      or (not exists (select 1 from public.fixture_items fi join public.door_looks dl on dl.client_id = fi.client_id and dl.id = fi.door_look_id
                       where fi.client_id = b.client_id and dl.status = 'ready')
          and md5(b.f::text) is distinct from md5(n.g::text));
  if v_n > 0 then
    raise exception '344: get_fixtures changed for % tenant(s) beyond doorLook; this splice must move nothing else', v_n;
  end if;

  -- 4. doorLook goes on exactly the listed door rows whose look is ready, carries exactly
  --    id, v, spec and thumbUrl, and the look is that row's own.
  for r in select cc.client_id from public.client_configs cc loop
    select coalesce(array_agg(fi.id::text || ':' || dl.id::text order by fi.id::text), '{}') into v_want
      from public.fixture_items fi
      join public.door_looks dl on dl.client_id = fi.client_id and dl.id = fi.door_look_id and dl.status = 'ready'
     where fi.client_id = r.client_id and fi.category = 'door' and fi.active
       and fi.price is not null and coalesce(fi.archived, false) = false;
    select coalesce(array_agg((i ->> 'id') || ':' || (i -> 'doorLook' ->> 'id') order by i ->> 'id'), '{}') into v_got
      from jsonb_array_elements(public.get_fixtures(r.client_id) -> 'items') i
     where i ? 'doorLook';
    if v_want is distinct from v_got then
      raise exception '344: get_fixtures(%) sends doorLook as % but the catalog has %', r.client_id, v_got, v_want;
    end if;
    if exists (select 1 from jsonb_array_elements(public.get_fixtures(r.client_id) -> 'items') i
                where i ? 'doorLook'
                  and (select array_agg(k order by k) from jsonb_object_keys(i -> 'doorLook') k) is distinct from array['id', 'spec', 'thumbUrl', 'v']) then
      raise exception '344: get_fixtures(%) sends a doorLook with keys other than id, v, spec, thumbUrl', r.client_id;
    end if;
  end loop;
  perform pg_notify('pgrst', 'reload schema');
end
$m344$;
-- <<< P1

-- THE RECORD. Expect on a first apply: true, <tenant count>, 0, 0, c7ef0626e645b725f5e16673002ee8a5.
-- >>> R1
select position($k$jsonb_build_object('doorLook'$k$ in pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) > 0 as fixtures_send_it,
       (select count(*) from public.client_configs) as tenants,
       (select count(*) from public.door_looks where status = 'ready') as ready_looks,
       (select count(*) from public.fixture_items where door_look_id is not null) as doors_with_a_look,
       (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure) as body_md5;
-- <<< R1
