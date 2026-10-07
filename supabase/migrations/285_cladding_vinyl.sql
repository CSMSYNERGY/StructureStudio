-- 285_cladding_vinyl.sql — a fifth cladding, 4.5" Vinyl Siding ("vinyl"), sold beside the lap.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked` on
--    stdin (NOT `--file`, which auth-fails, retries and still exits 0 — see 232's header), then
--    record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('285', '285_cladding_vinyl') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit; so every check below takes the
--    whole migration with it if it fails.
--    `db query` NEVER prints a NOTICE (it prints the rows of the last statement that returns any), so
--    every RAISE NOTICE below is for psql and the tests only. What the apply shows is THE RECORD, one
--    row just before the commit (see its header at the end): read it, and keep it with the ledger
--    insert. No row printed means the file did not run. To see the same row first and change
--    nothing, pipe the file with its last `commit;` swapped for `rollback;` (a dry run).
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn's answers of 2026-10-06 (Q20): rename the built-in lap to 7" LP Lap Siding "and keep its
-- profile, treating the current lap as 7"", and add 4.5" Vinyl Siding, "the same profile at 4.5"
-- spacing", priced by the builder. A builder who sells both has to be able to sell them SIDE BY SIDE
-- on one style, each with its own price, and that is what the table cannot hold today:
--   * style_cladding_cladding_id_check (207) is a closed list of four ids, so no 'vinyl' row can be
--     stored at all;
--   * UNIQUE (client_id, style_id, cladding_id) allows ONE lap row per style, so 275's course size
--     (exposure_in) can make a style's lap draw as vinyl, but never as the 7 in lap AND the 4.5 in
--     vinyl at once.
-- So vinyl is its own id, exactly as each of the other four is.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   style_cladding_cladding_id_check swapped for the same CHECK with 'vinyl' added, in ONE
--            ALTER TABLE (drop and add under one lock, so the table is never without it). Skipped
--            when the live CHECK already names vinyl, so a re-run is safe
--   PART 2   the table's and exposure_in's comments say what is true now
--   PART 3   checks: the CHECK names exactly the five ids; exposure_in's CHECK is still lap-only;
--            every tenant's get_config md5 is unchanged; no vinyl row exists yet; RLS, the one
--            SELECT policy and the grants hold; a rehearsal on one real style proves a vinyl row
--            reaches get_config and the CHECKs refuse what they should, and is rolled back
--   RECORD   one row the CLI prints
--
-- ── WHAT DOES NOT CHANGE ─────────────────────────────────────────────────────────────────
--   * NO DATA. No vinyl row is seeded: the portal's Cladding card renders all five rows whether or
--     not a database row is behind them, a blank rate means "not offered", and the builder prices
--     it with the seven methods every cladding already has. So nothing anyone sees moves until a
--     builder types a vinyl rate.
--   * NO get_config CHANGE. It emits sc.cladding_id as it is and names no id, so a vinyl row
--     appears on its own; and with no vinyl row anywhere, every tenant's payload is byte-identical
--     (PART 3 proves it, md5 by md5).
--   * NO exposure_in CHANGE. A course size stays LAP-ONLY (style_cladding_exposure_in_check is
--     untouched): vinyl is fixed at 4.5, its name says so. Only the column's COMMENT moves, because
--     its scale did: since 2026-10-06 a size is in the inches of the built-in names, where NULL is
--     the standard lap, called 7 in, and 4.5 draws the vinyl's courses. Rows holding a size on
--     2026-10-07: 0, so no wall draws differently (the RECORD counts them again at apply time).
--     That count is NOT the go-ahead on its own: the new reading of a size ships with the
--     FRONTEND, and production's portal keeps showing 275's "Blank is 6 in" copy until the
--     promotion, so a builder can still type a size on the old scale after this applies. Re-run
--       select client_id, style_id, exposure_in from style_cladding where exposure_in is not null;
--     right before the beta frontend ship AND right before the production promotion. For any row,
--     tell that builder in plain words, or (with their OK) convert it to round(n * 7 / 6 * 4) / 4
--     so the drawing stays the same.
--   * No table, column, policy, trigger, function or grant. style_cladding has no trigger, and
--     get_config is the only SQL function that reads it.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database, so the wider CHECK is live for both the moment it
-- commits. It is inert there: no vinyl row exists, production's portal sends only four rows and
-- production's portal-settings refuses any fifth id, and production's designer drops an id it has
-- no D3_CLADDING entry for (claddingOptionsFor), so 'vinyl' can neither be written nor shown by
-- anything that predates this change.
-- The swap takes an ACCESS EXCLUSIVE lock on style_cladding, briefly: dropping a CHECK is a catalog
-- change, and adding one scans the table once (86 rows on 2026-10-06) to validate it. Every
-- designer's boot read (get_config) reads this table, hence lock_timeout 5s: a hung apply gives up
-- rather than sit in front of every public designer.
--
-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────
-- style_cladding as 207 left it: RLS on, ONE policy (owner-scoped SELECT for authenticated), no
-- write policy, nothing for anon. PART 3 checks that rather than assuming it. Every write goes
-- through portal-settings on the service role; the public designer learns of a row only through
-- get_config.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-07: 282 is the newest, and 281 is written but deliberately unapplied. The
-- batches built beside this one hold 283 (numbering), 284 (shop serials), 286 and 287; this file is
-- 285. They are independent of each other and apply in any order. Confirm at apply time that the
-- ledger does not already show 285:
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 5;
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- This file FIRST, then portal-settings (and the other functions of the same batch), then the
-- portal and the designer to beta. The server must be ahead of the portal: a portal that offers
-- the vinyl row, saving through a portal-settings that predates this change, gets the row skipped
-- as "not a cladding we ship", and a portal-settings ahead of this file would get the upsert
-- refused by the four-id CHECK.
--
-- ── ROLLBACK — in THIS order ─────────────────────────────────────────────────────────────
--   1. Put back the portal-settings without "vinyl" (it then refuses a vinyl row again).
--   2. ONLY IF nothing uses the id yet — both of these read 0:
--        select count(*) from public.style_cladding where cladding_id = 'vinyl';
--        select count(*) from public.designs where selections ->> 'cladding' = 'vinyl';
--      — restore the four ids:
--        alter table public.style_cladding
--          drop constraint style_cladding_cladding_id_check,
--          add constraint style_cladding_cladding_id_check check (cladding_id in ('panel', 'lap', 'batten', 'agpanel'));
--      Otherwise LEAVE THE WIDER CHECK IN PLACE: it is harmless, and narrowing it under a row that
--      names vinyl fails anyway.
--   3. Then delete the ledger row.

begin;

-- PART 1's ALTER TABLE takes an ACCESS EXCLUSIVE lock on style_cladding, which get_config reads on
-- every call. A hung apply must give up rather than sit in front of every designer's boot read.
set local lock_timeout = '5s';

-- Every tenant's get_config BEFORE anything here runs: PART 3 compares the md5 of each.
create temp table m285_before on commit drop as
  select cc.client_id, md5(public.get_config(cc.client_id)::text) as cfg_md5
    from public.client_configs cc;

select set_config('ss.m285_swapped', 'no', true);
select set_config('ss.m285_rehearsal', 'not run', true);

-- ── PART 1. The CHECK, with 'vinyl' ──────────────────────────────────────────────────────
do $swap$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.style_cladding'::regclass and c.conname = 'style_cladding_cladding_id_check';
  if v_def is null then
    raise exception '285: style_cladding_cladding_id_check is missing — style_cladding is not the shape 207 left; stop and look';
  end if;

  -- Idempotent: already widened (a re-run) → leave it, and let PART 3 check what is there.
  if position('''vinyl''' in v_def) > 0 then
    raise notice '285: style_cladding_cladding_id_check already allows vinyl — nothing to swap';
    return;
  end if;

  -- ONE statement: the old CHECK goes and the new one arrives under the same lock, so there is no
  -- moment at which style_cladding takes any id at all.
  alter table public.style_cladding
    drop constraint style_cladding_cladding_id_check,
    add constraint style_cladding_cladding_id_check
      check (cladding_id in ('panel', 'lap', 'batten', 'agpanel', 'vinyl'));

  perform set_config('ss.m285_swapped', 'yes', true);
  raise notice '285: style_cladding_cladding_id_check now allows vinyl';
end
$swap$;

-- ── PART 2. What the table and the course size say now ───────────────────────────────────
comment on table public.style_cladding is
  'Which cladding types a builder offers per building style, what each costs, and what the customer '
  'sees it called. cladding_id is the CLOSED D3_CLADDING set of five: panel, lap, vinyl, batten, '
  'agpanel (vinyl since migration 285) — the 3D renderer keys on it. NULL rate = not offered, '
  '0 = included, > 0 = upcharge.';

comment on column public.style_cladding.exposure_in is
  'The lap board size (Settings → Options → Cladding, "Course (in)"), in inches as in the built-in '
  'names, not the reveal; the 3D scales the courses by it. NULL = the standard lap, called 7 in (7" LP Lap Siding), and 4.5 draws '
  'the courses 4.5" Vinyl Siding has. LAP rows only, 3 to 12. Appearance only: it never prices. '
  'get_config emits "exposureIn" on the cladding entry only when set (sparse). Migrations 275 and 285.';

-- ── PART 3. Checks: raise (and so roll the whole file back) rather than commit a surprise ─
do $check$
declare
  v_def      text;
  v_valid    boolean;
  v_ids      text[];
  v_exdef    text;
  v_priv     text;
  v_moved    text;
  v_vinyl    integer;
  v_style    uuid;
  v_client   text;
  v_key      text;
  v_emits    jsonb;
  v_refused  text := '';
  v_after    text;
begin
  -- ── The CHECK: validated, one plain IN list, exactly the five ids ──
  select pg_get_constraintdef(c.oid), c.convalidated into v_def, v_valid
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.style_cladding'::regclass and c.conname = 'style_cladding_cladding_id_check';
  select array_agg(m[1] order by m[1]) into v_ids
    from regexp_matches(coalesce(v_def, ''), '''([^'']*)''', 'g') as m;
  if v_def is null
     or v_def !~ '^CHECK \(\(cladding_id = ANY \(ARRAY\[[^]]*\]\)\)\)$'
     or v_ids is distinct from array['agpanel', 'batten', 'lap', 'panel', 'vinyl'] then
    raise exception '285: style_cladding_cladding_id_check should allow exactly panel, lap, vinyl, batten, agpanel; it reads %',
      coalesce(v_def, '(missing)');
  end if;
  if not v_valid then
    raise exception '285: style_cladding_cladding_id_check is NOT VALID — existing rows were never checked against it';
  end if;

  -- ── A course size is still LAP ONLY (exposure_in's CHECK, 275, untouched) ──
  select pg_get_constraintdef(c.oid) into v_exdef
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.style_cladding'::regclass and c.conname = 'style_cladding_exposure_in_check';
  if v_exdef is null or position('cladding_id = ''lap''::text' in v_exdef) = 0 or position('vinyl' in v_exdef) > 0 then
    raise exception '285: style_cladding_exposure_in_check should still allow a size on lap rows only; it reads %',
      coalesce(v_exdef, '(missing)');
  end if;

  -- ── Nothing names vinyl yet: this file seeds nothing ──
  select count(*) into v_vinyl from public.style_cladding where cladding_id = 'vinyl';
  if current_setting('ss.m285_swapped', true) = 'yes' and v_vinyl <> 0 then
    raise exception '285: the CHECK was only just widened and % row(s) already name vinyl', v_vinyl;
  end if;

  -- ── Still as 207 left it: RLS on, exactly one policy and it is a SELECT, nothing for anon ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.style_cladding'::regclass) then
    raise exception '285: RLS is off on style_cladding';
  end if;
  if (select count(*) from pg_catalog.pg_policy p where p.polrelid = 'public.style_cladding'::regclass) <> 1
     or exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.style_cladding'::regclass and p.polcmd <> 'r') then
    raise exception '285: style_cladding should carry exactly one policy, a SELECT; every write is meant to go through portal-settings';
  end if;
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
    if has_table_privilege('anon', 'public.style_cladding', v_priv) then
      raise exception '285: anon holds % on style_cladding', v_priv;
    end if;
    if not has_table_privilege('service_role', 'public.style_cladding', v_priv) then
      raise exception '285: service_role lacks % on style_cladding — the Cladding save would fail', v_priv;
    end if;
  end loop;
  if not has_function_privilege('anon', 'public.get_config(text)', 'execute') then
    raise exception '285: anon cannot EXECUTE get_config — every public designer would fail to load';
  end if;

  -- ── Every tenant's get_config, md5 for md5, is what it was. Dynamic SQL so no plan cached before
  --    the swap is reused.
  execute 'select string_agg(b.client_id, '', '' order by b.client_id) from m285_before b
            where md5(public.get_config(b.client_id)::text) is distinct from b.cfg_md5'
    into v_moved;
  if v_moved is not null then
    raise exception '285: get_config changed for: %', v_moved;
  end if;
  if (select count(*) from m285_before) <> (select count(*) from public.client_configs) then
    raise exception '285: the tenant count moved during the apply — run it again';
  end if;

  -- ── The rehearsal: a vinyl row on one real active style, at rate 0 (offered, included), read back
  --    through get_config; then the CHECKs asked to refuse an id we do not ship and a course size on
  --    the vinyl row. A sub-block whose own exception is its rollback: every write is undone, and
  --    only the answers (plain variables) survive it. A database with no active style has nothing to
  --    rehearse on; the checks above still stand.
  select st.id, st.client_id, st.key into v_style, v_client, v_key
    from public.building_styles st
    join public.client_configs cc on cc.client_id = st.client_id
   where st.active
     and not exists (select 1 from public.style_cladding sc where sc.style_id = st.id and sc.cladding_id = 'vinyl')
   order by st.client_id, st.key
   limit 1;
  if v_style is not null then
    begin
      insert into public.style_cladding (client_id, style_id, cladding_id, rate) values (v_client, v_style, 'vinyl', 0);
      execute 'select e from jsonb_array_elements(public.get_config($1) -> ''claddingOptions'' -> $2) e where e ->> ''id'' = ''vinyl'''
        into v_emits using v_client, v_key;
      begin
        insert into public.style_cladding (client_id, style_id, cladding_id, rate) values (v_client, v_style, 'barn', 0);
      exception when check_violation then v_refused := v_refused || 'barn ';
      end;
      begin
        update public.style_cladding set exposure_in = 4.5 where style_id = v_style and cladding_id = 'vinyl';
      exception when check_violation then v_refused := v_refused || 'vinylsize ';
      end;
      raise exception using errcode = 'S2850', message = '285: rehearsal rolled back';
    exception when sqlstate 'S2850' then
      null;
    end;
    if v_emits is null or (v_emits ->> 'id') is distinct from 'vinyl' or (v_emits -> 'label') is distinct from 'null'::jsonb then
      raise exception '285: a vinyl row at rate 0 did not reach get_config as {"id": "vinyl", "label": null} (got %)',
        coalesce(v_emits::text, 'no vinyl entry');
    end if;
    if v_refused <> 'barn vinylsize ' then
      raise exception '285: a CHECK let something through (refused only: %)', coalesce(nullif(btrim(v_refused), ''), 'nothing');
    end if;
    execute 'select md5(public.get_config($1)::text)' into v_after using v_client;
    if v_after is distinct from (select b.cfg_md5 from m285_before b where b.client_id = v_client) then
      raise exception '285: the rehearsal did not roll back — that tenant''s get_config still differs';
    end if;
    if (select count(*) from public.style_cladding where cladding_id = 'vinyl') <> v_vinyl then
      raise exception '285: the rehearsal did not roll back — its vinyl row is still there';
    end if;
    perform set_config('ss.m285_rehearsal', 'ok', true);
  else
    perform set_config('ss.m285_rehearsal', 'no active style to rehearse on', true);
  end if;

  raise notice '285: checks hold; the CHECK % ids %; every tenant''s get_config unchanged; vinyl rows: %; rehearsal: %',
    case when current_setting('ss.m285_swapped', true) = 'yes' then 'widened to' else 'already allowed' end,
    array_to_string(v_ids, ','), v_vinyl, current_setting('ss.m285_rehearsal', true);
end
$check$;

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- The NOTICEs above never reach the CLI (it prints the rows of the last statement that returns any,
-- even with a commit or rollback after it). So this row is the apply's report, and it sits BEFORE
-- the commit so a dry run (last `commit;` swapped for `rollback;`) prints the same row and leaves
-- nothing behind. Expected on the first apply:
--   cladding_ids 'agpanel,batten,lap,panel,vinyl', swapped 'yes', tenants_checked (every
--   client_configs row), configs_changed '(none)', vinyl_rows 0, rows_with_size 0, rehearsal 'ok',
--   anon_reads_get_config true, anon_reads_cladding false
-- rows_with_size is the FIRST of the re-checks the scale change asks for: a lap size typed on the old
-- scale draws 6/7 as wide once the new frontend reads it. It is not the last: production's portal
-- still invites a size on the old scale until the promotion, so count again right before the beta
-- frontend ship and right before the production promotion (the query is in the header, under NO
-- exposure_in CHANGE). Anything other than 0: tell that builder before that frontend ships.
-- Anything else unexpected: roll back (see ROLLBACK above) before recording the ledger row.
select
  '285' as migration,
  (select array_to_string(array_agg(m[1] order by m[1]), ',')
     from pg_catalog.pg_constraint c
     cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']*)''', 'g') as m
    where c.conrelid = 'public.style_cladding'::regclass and c.conname = 'style_cladding_cladding_id_check') as cladding_ids,
  current_setting('ss.m285_swapped', true) as swapped,
  (select count(*) from m285_before)::int as tenants_checked,
  coalesce((select string_agg(b.client_id, ', ' order by b.client_id) from m285_before b
             where md5(public.get_config(b.client_id)::text) is distinct from b.cfg_md5), '(none)') as configs_changed,
  (select count(*) from public.style_cladding where cladding_id = 'vinyl')::int as vinyl_rows,
  (select count(*) from public.style_cladding where exposure_in is not null)::int as rows_with_size,
  current_setting('ss.m285_rehearsal', true) as rehearsal,
  has_function_privilege('anon', 'public.get_config(text)', 'execute') as anon_reads_get_config,
  has_table_privilege('anon', 'public.style_cladding', 'SELECT') as anon_reads_cladding;

commit;

-- After this: style_cladding takes 'vinyl' beside the other four ids, no row names it, and every
-- tenant's get_config is what it was. A builder offers 4.5" Vinyl Siding by typing a rate on its row
-- in Settings → Options → Cladding (blank = not offered), once the portal carrying the fifth row is
-- live.
