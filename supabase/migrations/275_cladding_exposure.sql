-- 275_cladding_exposure.sql — a builder's lap siding can show narrower boards than the 6 in the
-- 3D has always drawn: a 4.5 in vinyl, say.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (NOT `--file`, which auth-fails, retries and still exits 0 — see 232's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('275', '275_cladding_exposure');
--    NEVER `supabase db push`. The file carries its own begin;/commit; so every check below takes the
--    whole migration with it if it fails.
--    `db query` NEVER prints a NOTICE (it prints the rows of the last statement that returns any), so
--    every RAISE NOTICE below is for psql and the tests only. What the apply shows is THE RECORD, one
--    row just before the commit (see its header at the end): read it, and keep it with the ledger
--    insert. No row printed means the file did not run. To see the same row first and change
--    nothing, pipe the file with its last `commit;` swapped for `rollback;` (a dry run).
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- A builder, on the portal 2026-10-03: "I will need an option for 4.5" vinyl siding". One of their
-- styles already sells the lap row, renamed to vinyl, and their price sheet has one vinyl column, so
-- the option exists and is priced; what is wrong is the LOOK. The 3D draws every lap wall in 6 in
-- courses (D3_CLADDING.lap: stepFt 0.5, a texture tile of 4 ft = 8 boards), and nothing per builder
-- or per style could change that. A 4.5 in vinyl drawn as 6 in boards is a different product on the
-- customer's screen and on page 2 of their quote.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   style_cladding.exposure_in numeric, NULL = the 3D's standard 6 in. Only a LAP row may
--            hold one, and only 3..12 in (a CHECK, so no path can store anything else)
--   PART 2   get_config's claddingOptions entry gains `"exposureIn": n` ONLY where it is set,
--            SPLICED into the live body (232's mechanism), never rewritten
--   PART 3   checks: every tenant's get_config md5 is unchanged; grants and RLS hold; a rehearsal on
--            one real lap row proves the value reaches get_config and the CHECK refuses what it
--            should, and is rolled back
--   RECORD   one row the CLI prints
--
-- ── HOW THE CODE USES IT (deployed after this file) ──────────────────────────────────────
--   portal-settings   catalog reads exposure_in (tolerantly: a database before 275 reads without it
--                     and the card hides the box); save_cladding takes `exposureIn` on the lap row,
--                     blank = NULL, and refuses it on any other row or outside 3..12.
--   portal            Settings → Options → Cladding: a "Course (in)" box on the Lap Siding row only,
--                     placeholder 6.
--   designer (twins)  d3CladdingExposureIn reads it for the customer's lap pick; d3ResolveStyleSpec's
--                     7th argument carries it to the renderer as spec.sidingExposureIn, from the five
--                     customer-facing calls only (never openCalEditor's, whose result the calibration
--                     panel saves AS THE STYLE); d3CladdingFor draws the courses at that size.
--   Nothing prices on it. The rate, basis and line on the quote are exactly what they were.
--
-- ── WHAT DOES NOT CHANGE ─────────────────────────────────────────────────────────────────
--   * NULL on every row it lands on, so no building draws differently until a builder types a size.
--   * SPARSE: a row without a size gets NO key, not `"exposureIn": null`, so every tenant's
--     get_config payload is byte-identical to today's (PART 3 proves it, md5 by md5). jsonb
--     `|| '{}'` is a no-op on the serialised text, the same fact 232 and 276 relied on.
--   * No table, policy, trigger or new function.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database, and get_config is the boot read for every tenant's
-- public designer, so the splice is live on PRODUCTION's pages the moment it commits. It is inert
-- there: the key is absent for everyone until a builder types a size, and a production designer
-- that predates this ignores an unknown key on a cladding entry (claddingOptionsFor passes the
-- object through; only id/label/rate/basis/charged/taxable/internalOnly are read).
-- ADD COLUMN with no default is a catalog change (no rewrite), and its CHECK is validated against
-- rows that are all NULL, on a table of 86 rows (2026-10-05). The live functions select named
-- columns, so the new one is invisible to them; portal-settings' save upserts named columns, and
-- leaves exposure_in alone unless the request names it. style_cladding has no trigger.
-- CREATE OR REPLACE keeps get_config's ACL, owner, SECURITY DEFINER and search_path; PART 3
-- re-asserts anon EXECUTE anyway, because a designer that cannot read its config is every tenant's
-- page down.
--
-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────
-- style_cladding as 207 left it: RLS on, ONE policy (owner-scoped SELECT for authenticated), no
-- write policy, nothing for anon. A new column carries no privilege beyond the table's, and PART 3
-- checks that rather than assuming it. Every write goes through portal-settings on the service
-- role; the public designer learns the value only through get_config.
--
-- ── SPLICED, NOT REWRITTEN ───────────────────────────────────────────────────────────────
-- 110's rule, 232's mechanism: read the LIVE body, insert one expression at one anchor, execute.
-- get_config is ~17.8 KB and has been extended by splices on several branches; pasting a body from
-- a file (207's included) would silently drop whatever landed since. Three guards, and nothing
-- rather than half:
--   1. Already spliced (`exposureIn` in the body) → notice and skip. A re-run is safe.
--   2. The anchor — the claddingOptions entry's `sc.internal_only` line and the `order by` line
--      under it, which closes the jsonb_agg's argument — must occur EXACTLY ONCE. Confirmed on the
--      live project 2026-10-05: count 1, body 17807 chars, md5 770a09c039be6a5d280204880d25cb8c
--      (that is 270's body). The newline inside it is chr(10), not a literal line break: this file
--      is checked out CRLF on Windows, and a CRLF anchor never matches.
--   3. The new body is longer by exactly the inserted text: one insertion, no deletion.
-- The insertion goes after the internalOnly `||` and before the `order by`, so it is each entry's
-- object that gains the key, in the same sparse `|| case ... else '{}' end` form as its neighbours.
-- ⚠️ Migration 276 (the same batch) splices get_config too, at the end of the top-level object.
-- Each splice re-derives its anchor from the live body at apply time, so the two apply in either
-- order.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-05: 270 is the newest. 271-274 are held for the batches building beside this
-- one; batch Y2 has 275 (this) and 276 (the four-corner page). Confirm at apply time that the
-- ledger does not already show 275:
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 3;
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- This file FIRST, then portal-settings, then the portal and the designer to beta.
-- Either function order is survivable: portal-settings reads the column tolerantly (a missing
-- column reads the catalog without it and hides the box), and a designer without this file never
-- sees the key. Production's designer and portal ignore the key until they are promoted.
--
-- ── ROLLBACK — in THIS order ─────────────────────────────────────────────────────────────
--   1. Un-splice first (a LANGUAGE sql body that names a dropped column fails every call, and that
--      body is every public designer's first read):
--        do $$ declare s text := pg_get_functiondef('public.get_config(text)'::regprocedure);
--               a text := chr(10) || $a$                 || case when sc.exposure_in is not null then jsonb_build_object('exposureIn', sc.exposure_in) else '{}'::jsonb end$a$;
--        begin if position(a in s) = 0 then raise exception 'splice not found'; end if;
--              execute replace(s, a, ''); end $$;
--   2. Then put back the portal-settings without exposure_in (its catalog read falls back on a
--      missing column, but its save would fail for a lap row that names the field).
--   3. Then: alter table public.style_cladding drop column exposure_in;
--      notify pgrst, 'reload schema';
--   4. Then delete the ledger row. Every lap wall goes back to 6 in courses.

begin;

-- PART 1's ALTER TABLE takes an ACCESS EXCLUSIVE lock on style_cladding (brief: a catalog change,
-- and a CHECK over a few hundred NULLs), which get_config reads on every call, and PART 2's
-- CREATE OR REPLACE locks get_config itself. A hung apply must give up rather than sit in front of
-- every designer's boot read.
set local lock_timeout = '5s';

-- Every tenant's get_config BEFORE anything here runs: PART 3 compares the md5 of each. Taken
-- before the ALTER so the comparison covers PART 1 too.
create temp table m275_before on commit drop as
  select cc.client_id, md5(public.get_config(cc.client_id)::text) as cfg_md5
    from public.client_configs cc;

-- Was the column already here? On the first apply every row must be NULL; a re-apply comes after
-- builders have typed sizes, and must keep them.
select set_config('ss.m275_first_apply', (not exists (
  select 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'style_cladding' and column_name = 'exposure_in'
))::text, true);
select set_config('ss.m275_rehearsal', 'not run', true);

-- ── PART 1. style_cladding.exposure_in ───────────────────────────────────────────────────
-- The CHECK is NAMED so PART 3 can find it, and a re-apply onto a column someone added by hand
-- without it is refused there rather than trusted.
alter table public.style_cladding
  add column if not exists exposure_in numeric
    constraint style_cladding_exposure_in_check
    check (exposure_in is null or (cladding_id = 'lap' and exposure_in between 3 and 12));

comment on column public.style_cladding.exposure_in is
  'How much of each lap board shows, in inches (Settings → Options → Cladding, "Course (in)"). LAP '
  'rows only, 3 to 12. NULL = the 3D''s standard 6 in. Appearance only: it never prices. get_config '
  'emits "exposureIn" on the cladding entry only when set (sparse, so every other tenant''s config is '
  'unchanged). Migration 275.';

-- ── PART 2. get_config: the sparse per-entry key ─────────────────────────────────────────
do $splice$
declare
  v_src    text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  -- The claddingOptions entry's last `||` and the `order by` that closes jsonb_agg's argument.
  -- chr(10), not a line break in this file: see the header (CRLF checkouts).
  v_head   text := $h$                 || case when coalesce(sc.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end$h$;
  v_tail   text := chr(10) || '               order by sc.sort_order, sc.cladding_id) as list';
  v_anchor text := v_head || v_tail;
  v_add    text := chr(10) || $a$                 || case when sc.exposure_in is not null then jsonb_build_object('exposureIn', sc.exposure_in) else '{}'::jsonb end$a$;
  v_hits   integer;
  v_new    text;
begin
  -- GUARD 1 — idempotent.
  if position('exposureIn' in v_src) > 0 then
    raise notice '275: get_config already emits exposureIn — nothing to splice';
    return;
  end if;

  -- GUARD 2 — the anchor is unique: the end of one claddingOptions entry.
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '275: anchor found % time(s), expected exactly 1 — get_config has changed shape; re-derive the anchor from a fresh pg_get_functiondef before retrying', v_hits;
  end if;

  v_new := replace(v_src, v_anchor, v_head || v_add || v_tail);

  -- GUARD 3 — one insertion, no deletion.
  if length(v_new) <> length(v_src) + length(v_add) then
    raise exception '275: spliced body is % chars, expected % — refusing to execute', length(v_new), length(v_src) + length(v_add);
  end if;

  execute v_new;
  raise notice '275: spliced exposureIn into get_config (% -> % chars)', length(v_src), length(v_new);
end
$splice$;

-- ── PART 3. Checks: raise (and so roll the whole file back) rather than commit a surprise ─
do $check$
declare
  v_col     record;
  v_con     text;
  v_body    text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  v_role    text;
  v_priv    text;
  v_set     integer;
  v_moved   text;
  v_lap_id     uuid;
  v_lap_client text;
  v_lap_style  text;
  v_other   uuid;
  v_emits   jsonb;
  v_refused text := '';
  v_after   text;
begin
  -- ── The column: numeric, nullable, no default ──
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'style_cladding' and c.column_name = 'exposure_in';
  if v_col.data_type is null then
    raise exception '275: style_cladding.exposure_in is missing';
  end if;
  if v_col.data_type <> 'numeric' or v_col.is_nullable <> 'YES' or v_col.column_default is not null then
    raise exception '275: style_cladding.exposure_in should be numeric, nullable, no default; is % / nullable % / default %',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  end if;

  -- ── Its CHECK is there (a hand-added column without one is refused, not trusted) ──
  select pg_get_constraintdef(c.oid) into v_con
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.style_cladding'::regclass and c.conname = 'style_cladding_exposure_in_check';
  if v_con is null then
    raise exception '275: style_cladding_exposure_in_check is missing — the column was added without its CHECK';
  end if;

  -- ── Freshly added means NULL on every row ──
  select count(*) into v_set from public.style_cladding where exposure_in is not null;
  if current_setting('ss.m275_first_apply', true) = 'true' and v_set <> 0 then
    raise exception '275: exposure_in was just added and % row(s) already carry a value', v_set;
  end if;

  -- ── Still as 207 left it: RLS on, one owner-scoped SELECT policy, nothing for anon ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.style_cladding'::regclass) then
    raise exception '275: RLS is off on style_cladding';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.style_cladding'::regclass and p.polcmd <> 'r') then
    raise exception '275: style_cladding has a write policy; every write is meant to go through portal-settings';
  end if;
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
    if has_column_privilege('anon', 'public.style_cladding', 'exposure_in', v_priv) then
      raise exception '275: anon holds % on style_cladding.exposure_in', v_priv;
    end if;
    if not has_column_privilege('service_role', 'public.style_cladding', 'exposure_in', v_priv) then
      raise exception '275: service_role lacks % on style_cladding.exposure_in — the Cladding save would fail', v_priv;
    end if;
  end loop;

  -- ── get_config: spliced once, still callable by anon ──
  if (length(v_body) - length(replace(v_body, 'exposureIn', ''))) / length('exposureIn') <> 1 then
    raise exception '275: get_config does not name exposureIn exactly once after the splice';
  end if;
  if not has_function_privilege('anon', 'public.get_config(text)', 'execute') then
    raise exception '275: anon lost EXECUTE on get_config — every public designer would fail to load';
  end if;

  -- ── Every tenant's get_config, md5 for md5, is what it was. Dynamic SQL so no plan cached before
  --    the splice is reused. On a first apply no row has a size, so this is "no key anywhere"; on a
  --    re-apply the rows that have one carried the key before and after alike.
  execute 'select string_agg(b.client_id, '', '' order by b.client_id) from m275_before b
            where md5(public.get_config(b.client_id)::text) is distinct from b.cfg_md5'
    into v_moved;
  if v_moved is not null then
    raise exception '275: get_config changed for: %', v_moved;
  end if;
  if (select count(*) from m275_before) <> (select count(*) from public.client_configs) then
    raise exception '275: the tenant count moved during the apply — run it again';
  end if;

  -- ── The rehearsal: one real lap row the designer is offered, set to 4.5, read back through
  --    get_config, then the CHECK asked to refuse a non-lap row and two sizes out of range. A
  --    sub-block whose own exception is its rollback: every update is undone, and only the answers
  --    (plain variables) survive it. A database with no offered lap row has nothing to rehearse on;
  --    the checks above still stand.
  select sc.id, sc.client_id, st.key into v_lap_id, v_lap_client, v_lap_style
    from public.style_cladding sc
    join public.building_styles st on st.id = sc.style_id and st.active
    join public.client_configs cc on cc.client_id = sc.client_id
   where sc.cladding_id = 'lap' and sc.active and sc.rate is not null and sc.exposure_in is null
   order by sc.client_id, st.key
   limit 1;
  select sc.id into v_other
    from public.style_cladding sc
   where sc.cladding_id <> 'lap' and sc.exposure_in is null
   order by sc.client_id, sc.cladding_id
   limit 1;
  if v_lap_id is not null then
    begin
      update public.style_cladding set exposure_in = 4.5 where id = v_lap_id;
      execute 'select e from jsonb_array_elements(public.get_config($1) -> ''claddingOptions'' -> $2) e where e ->> ''id'' = ''lap'''
        into v_emits using v_lap_client, v_lap_style;
      begin
        update public.style_cladding set exposure_in = 2.9 where id = v_lap_id;
      exception when check_violation then v_refused := v_refused || 'below3 ';
      end;
      begin
        update public.style_cladding set exposure_in = 12.5 where id = v_lap_id;
      exception when check_violation then v_refused := v_refused || 'above12 ';
      end;
      if v_other is not null then
        begin
          update public.style_cladding set exposure_in = 4.5 where id = v_other;
        exception when check_violation then v_refused := v_refused || 'notlap ';
        end;
      else
        v_refused := v_refused || 'notlap ';
      end if;
      raise exception using errcode = 'S2750', message = '275: rehearsal rolled back';
    exception when sqlstate 'S2750' then
      null;
    end;
    if v_emits is null or (v_emits -> 'exposureIn') is distinct from '4.5'::jsonb then
      raise exception '275: setting 4.5 on a lap row did not make its get_config entry emit "exposureIn": 4.5 (got %)',
        coalesce(v_emits::text, 'no lap entry');
    end if;
    if v_refused <> 'below3 above12 notlap ' then
      raise exception '275: the CHECK let something through (refused only: %)', coalesce(nullif(btrim(v_refused), ''), 'nothing');
    end if;
    execute 'select md5(public.get_config($1)::text)' into v_after using v_lap_client;
    if v_after is distinct from (select b.cfg_md5 from m275_before b where b.client_id = v_lap_client) then
      raise exception '275: the rehearsal did not roll back — that tenant''s get_config still differs';
    end if;
    perform set_config('ss.m275_rehearsal', 'ok', true);
  else
    perform set_config('ss.m275_rehearsal', 'no offered lap row to rehearse on', true);
  end if;

  raise notice '275: checks hold; exposure_in % on style_cladding; every tenant''s get_config unchanged; rows with a size: %; rehearsal: %',
    case when current_setting('ss.m275_first_apply', true) = 'true' then 'added, empty,' else 'kept' end, v_set,
    current_setting('ss.m275_rehearsal', true);
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- The NOTICEs above never reach the CLI (it prints the rows of the last statement that returns any,
-- even with a commit or rollback after it). So this row is the apply's report, and it sits BEFORE
-- the commit so a dry run (last `commit;` swapped for `rollback;`) prints the same row and leaves
-- nothing behind. Expected on 2026-10-05:
--   get_config_splices 1, tenants_checked 6 (every client_configs row), configs_changed '(none)',
--   rows_with_size 0, rehearsal 'ok', anon_reads_get_config true, anon_can_read_size false
-- Anything else: roll back (see ROLLBACK above) before recording the ledger row.
select
  '275' as migration,
  (length(pg_get_functiondef('public.get_config(text)'::regprocedure))
     - length(replace(pg_get_functiondef('public.get_config(text)'::regprocedure), 'exposureIn', '')))
     / length('exposureIn') as get_config_splices,
  (select count(*) from m275_before)::int as tenants_checked,
  coalesce((select string_agg(b.client_id, ', ' order by b.client_id) from m275_before b
             where md5(public.get_config(b.client_id)::text) is distinct from b.cfg_md5), '(none)') as configs_changed,
  (select count(*) from public.style_cladding where exposure_in is not null)::int as rows_with_size,
  current_setting('ss.m275_rehearsal', true) as rehearsal,
  has_function_privilege('anon', 'public.get_config(text)', 'execute') as anon_reads_get_config,
  has_column_privilege('anon', 'public.style_cladding', 'exposure_in', 'SELECT') as anon_can_read_size;

commit;

-- After this: style_cladding.exposure_in exists, NULL on every row, and get_config carries
-- "exposureIn": n on a lap entry whose builder typed a size. Nothing else in get_config moved.
-- The data change this was built for (approval needed, not part of this file): that builder's
-- vinyl (lap) row set to 4.5, from their own Settings → Options → Cladding or by hand.
