-- 322_quote_corner_views_on.sql — the four-corner page on the quote is ON by default, for every
-- builder (it only ever renders where 3D is on).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Run it with
--      supabase db query --linked --file 322_quote_corner_views_on.sql
--    then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('322', '322_quote_corner_views_on') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run, and
--    a printed row is still not proof (2026-10-21: a begin/commit block sent through `db query`
--    applied nothing and said nothing), so READ IT BACK in a separate query afterwards:
--      select column_default from information_schema.columns
--       where table_schema = 'public' and table_name = 'client_settings' and column_name = 'quote_corner_views';
--      select client_id, quote_corner_views from public.client_settings order by 1;
--    To see the record and change nothing, run it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-21: 320 is the newest. 321 is left to the client-deletion branch
-- (ss/c1021-tenant-purge), which may claim it. Confirm at apply time that 322 is free; record the
-- ledger row with `returning`: no row back means the number was taken, so rename this file, its
-- test (tests/sql/migration322.test.cjs) and every '322' below.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- 276 shipped the page OFF for everyone, as a per-builder tick (Carolyn 2026-08-20: "optional for
-- them"). Nobody ticked it, and builders were never told, so a Yoder request from 08-03 ("3D image
-- on estimates for customers to see... four images, one from each corner") was still open on
-- Carolyn's board on 10-19. Ahsan, 2026-10-21: on for every builder whose 3D is on, no opt-in, and
-- it stays the PDF page (not the email, not My Quotes). A builder can still untick it.
--
-- ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────────────────
--   PART 1   client_settings.quote_corner_views DEFAULT true (was false), and every row that reads
--            false is turned on. FIRST APPLY ONLY: a re-apply finds the default already true and
--            leaves every row alone, so a builder who unticked it after this landed stays off.
--   PART 2   get_config's 276 splice, one word: a tenant with NO client_settings row reads the
--            column's default, so `coalesce(..., false)` becomes `coalesce(..., true)`. Without it a
--            new builder (admin-catalog create_client makes no settings row for an ordinary client)
--            would get no page until their first settings save. Anchor-replaced on the LIVE body,
--            never rewritten (110's rule): exactly one hit, and the body one character shorter.
--   PART 3   checks (they RAISE and abort the whole file).
--   THE RECORD
--
-- portal-settings' status read says the same thing for a tenant with no row (its own commit, same
-- branch): "no row" reads on, so the Settings box and the PDF agree. The Settings copy says it is
-- on by default and that unticking turns it off.
--
-- ── WHAT CUSTOMERS SEE ───────────────────────────────────────────────────────────────────
-- ⚠️ LIVE ON PRODUCTION AT COMMIT. Beta and production share this database, and the designer that
-- draws the page (renderQuoteCornerSheet, 7c18fe37) has been on main since the 10-06 promotion. From
-- the moment this commits, every quote a 3D builder's customer submits carries the four-corner sheet
-- as the page after the floor plan, in place of the single 3D view. Quotes already sent keep the PDF
-- they were issued with. A builder without 3D (view3d false) gets get_config's key and ignores it:
-- the designer draws the page only when view3dOn && config.quoteCornerViews === true.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- ALTER COLUMN SET DEFAULT is a catalog change (no rewrite) on a table of 6 rows. The UPDATE touches
-- only this column; updated_at is left alone on purpose (nobody saved anything). get_config gains the
-- key for every tenant that reads it on; nothing else in any tenant's config moves (PART 3 compares
-- each config with the key taken out). CREATE OR REPLACE keeps get_config's ACL, owner, SECURITY
-- DEFINER and search_path; PART 3 re-asserts anon EXECUTE anyway.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   alter table public.client_settings alter column quote_corner_views set default false;
--   update public.client_settings set quote_corner_views = false where client_id in (<the record's turned_on list>);
--   do $$ declare s text := pg_get_functiondef('public.get_config(text)'::regprocedure);
--          o text := $o$cs.client_id = cc.client_id), true) then jsonb_build_object('quoteCornerViews', true)$o$;
--   begin if position(o in s) = 0 then raise exception 'fallback not found'; end if;
--         execute replace(s, o, replace(o, '), true) then', '), false) then')); end $$;
--   delete from supabase_migrations.schema_migrations where version = '322';
-- Then put back the portal-settings and portal from before this branch.

begin;

-- The ALTER takes an ACCESS EXCLUSIVE lock on client_settings (brief), which get_config reads on
-- every call, and PART 2's CREATE OR REPLACE locks get_config itself. A hung apply must give up
-- rather than sit in front of every designer's boot read.
set local lock_timeout = '5s';

do $m322_pre$
begin
  if not exists (select 1 from information_schema.columns c
                  where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'quote_corner_views') then
    raise exception '322: client_settings.quote_corner_views is missing — apply 276 first';
  end if;
end
$m322_pre$;

-- Every tenant's get_config and switch BEFORE anything here runs; PART 3 compares against them.
create temp table m322_before on commit drop as
  select cc.client_id,
         public.get_config(cc.client_id) as cfg,
         (select cs.quote_corner_views from public.client_settings cs where cs.client_id = cc.client_id) as qcv
    from public.client_configs cc;
create temp table m322_rows_before on commit drop as
  select client_id, quote_corner_views from public.client_settings;

-- First apply = the default still reads false. A re-apply comes after builders may have unticked it,
-- and must keep what they chose.
select set_config('ss.m322_first_apply', (
  select (c.column_default is distinct from 'true')::text
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'quote_corner_views'
), true);

-- ── PART 1. On by default, and on for everyone today ─────────────────────────────────────
alter table public.client_settings
  alter column quote_corner_views set default true;

update public.client_settings
   set quote_corner_views = true
 where not quote_corner_views
   and current_setting('ss.m322_first_apply', true) = 'true';

comment on column public.client_settings.quote_corner_views is
  'The builder''s "Show the building from all four corners on page 2 of my estimates" switch (Settings → Company, '
  'portal-settings save). On, and with 3D on: the page after the floor plan in every quote PDF the designer '
  'submits is a four-corner sheet instead of the one three-quarter view. get_config emits "quoteCornerViews": true '
  'only when on (sparse). On by default since migration 322 (Ahsan 2026-10-21), and a tenant with no settings row '
  'reads on; unticking it turns it off. Migration 276.';

-- ── PART 2. get_config: a tenant with no settings row reads the default ───────────────────
do $m322_splice$
declare
  v_src  text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  v_old  text := $o$cs.client_id = cc.client_id), false) then jsonb_build_object('quoteCornerViews', true)$o$;
  v_new  text := $n$cs.client_id = cc.client_id), true) then jsonb_build_object('quoteCornerViews', true)$n$;
  v_hits integer;
  v_out  text;
begin
  -- GUARD 1 — idempotent: already reads true, and the old fallback is gone.
  if position(v_new in v_src) > 0 and position(v_old in v_src) = 0 then
    raise notice '322: get_config already reads a missing settings row as on — nothing to splice';
    return;
  end if;

  -- GUARD 2 — the 276 expression is there, exactly once.
  v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  if v_hits <> 1 then
    raise exception '322: 276''s quoteCornerViews fallback found % time(s) in the LIVE get_config, expected exactly 1 — re-derive it from a fresh pg_get_functiondef before retrying', v_hits;
  end if;

  v_out := replace(v_src, v_old, v_new);

  -- GUARD 3 — one word changed: false → true is one character shorter, and nothing else moved.
  if length(v_out) <> length(v_src) - 1 or replace(v_out, v_new, v_old) <> v_src then
    raise exception '322: the new get_config is % chars, expected % — refusing to execute', length(v_out), length(v_src) - 1;
  end if;

  execute v_out;
  raise notice '322: get_config now reads a missing settings row as on (% -> % chars)', length(v_src), length(v_out);
end
$m322_splice$;

-- ── PART 3. Checks: raise (and so roll the whole file back) rather than commit a surprise ─
do $m322_check$
declare
  v_col   record;
  v_body  text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  v_role  text;
  v_priv  text;
  v_bad   text;
begin
  -- ── The column: boolean, NOT NULL, default true ──
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'quote_corner_views';
  if v_col.data_type <> 'boolean' or v_col.is_nullable <> 'NO' or v_col.column_default is distinct from 'true' then
    raise exception '322: client_settings.quote_corner_views should be boolean NOT NULL DEFAULT true, is % / nullable % / default %',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  end if;

  -- ── First apply: on for every row. Re-apply: every row exactly as it was. ──
  if current_setting('ss.m322_first_apply', true) = 'true' then
    select string_agg(client_id, ', ' order by client_id) into v_bad from public.client_settings where not quote_corner_views;
    if v_bad is not null then
      raise exception '322: still off after the update for: %', v_bad;
    end if;
  else
    select string_agg(b.client_id, ', ' order by b.client_id) into v_bad
      from m322_rows_before b join public.client_settings cs using (client_id)
     where cs.quote_corner_views is distinct from b.quote_corner_views;
    if v_bad is not null then
      raise exception '322: a re-apply changed a builder''s choice for: %', v_bad;
    end if;
  end if;
  if (select count(*) from m322_rows_before) <> (select count(*) from public.client_settings) then
    raise exception '322: the client_settings row count moved during the apply — run it again';
  end if;

  -- ── Still service-role only: RLS on, no policy, nothing for the browser roles ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.client_settings'::regclass) then
    raise exception '322: RLS is off on client_settings';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.client_settings'::regclass) then
    raise exception '322: client_settings has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if has_column_privilege(v_role, 'public.client_settings', 'quote_corner_views', v_priv) then
        raise exception '322: % holds % on client_settings.quote_corner_views', v_role, v_priv;
      end if;
    end loop;
  end loop;
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
    if not has_column_privilege('service_role', 'public.client_settings', 'quote_corner_views', v_priv) then
      raise exception '322: service_role lacks % on client_settings.quote_corner_views — the Settings save would fail', v_priv;
    end if;
  end loop;

  -- ── get_config: still one key, the fallback reads on, anon can still call it ──
  if (length(v_body) - length(replace(v_body, 'quoteCornerViews', ''))) / length('quoteCornerViews') <> 1 then
    raise exception '322: get_config does not name quoteCornerViews exactly once';
  end if;
  if position($o$cs.client_id = cc.client_id), true) then jsonb_build_object('quoteCornerViews', true)$o$ in v_body) = 0 then
    raise exception '322: get_config does not read a missing settings row as on';
  end if;
  if not has_function_privilege('anon', 'public.get_config(text)', 'execute') then
    raise exception '322: anon lost EXECUTE on get_config — every public designer would fail to load';
  end if;

  -- ── Every tenant: the key is there exactly when its switch reads on (a missing row reads on),
  --    and NOTHING ELSE in its config moved. Dynamic SQL so no plan cached before PART 2 is reused.
  execute $q$
    select string_agg(b.client_id, ', ' order by b.client_id)
      from m322_before b
      left join public.client_settings cs on cs.client_id = b.client_id
      cross join lateral (select public.get_config(b.client_id) as cfg) a
     where (a.cfg ? 'quoteCornerViews') is distinct from coalesce(cs.quote_corner_views, true)
        or (a.cfg ? 'quoteCornerViews' and (a.cfg -> 'quoteCornerViews') is distinct from 'true'::jsonb)
        or (a.cfg - 'quoteCornerViews') is distinct from (b.cfg - 'quoteCornerViews')
  $q$ into v_bad;
  if v_bad is not null then
    raise exception '322: get_config is wrong for: %', v_bad;
  end if;
  if (select count(*) from m322_before) <> (select count(*) from public.client_configs) then
    raise exception '322: the tenant count moved during the apply — run it again';
  end if;

  raise notice '322: checks hold; default true; %; every tenant''s get_config carries the key exactly where it reads on',
    case when current_setting('ss.m322_first_apply', true) = 'true' then 'every row on' else 're-apply, builders'' choices kept' end;
end
$m322_check$;

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- It sits BEFORE the commit, so a dry run prints the same row and leaves nothing behind.
-- Expected on 2026-10-21 (live: 6 tenants, all with a settings row, structure-studio already on):
--   column_default 'true', first_apply true, rows_off 0, rows_on 6,
--   turned_on 'junior-barns, midwest-mini-barns, preferred-structures, support-demo, yoder-barns',
--   tenants_checked 6, tenants_with_key 6, missing_row_reads_on true, anon_reads_get_config true,
--   browser_can_read_switch false
-- Anything else: roll back (see ROLLBACK above) before recording the ledger row.
select
  '322' as migration,
  (select c.column_default from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'quote_corner_views') as column_default,
  (current_setting('ss.m322_first_apply', true) = 'true') as first_apply,
  (select count(*) from public.client_settings where not quote_corner_views)::int as rows_off,
  (select count(*) from public.client_settings where quote_corner_views)::int as rows_on,
  coalesce((select string_agg(b.client_id, ', ' order by b.client_id) from m322_rows_before b
             join public.client_settings cs using (client_id)
            where not b.quote_corner_views and cs.quote_corner_views), '(none)') as turned_on,
  (select count(*) from m322_before)::int as tenants_checked,
  (select count(*) from m322_before b where public.get_config(b.client_id) ? 'quoteCornerViews')::int as tenants_with_key,
  position($o$cs.client_id = cc.client_id), true) then jsonb_build_object('quoteCornerViews', true)$o$
           in pg_get_functiondef('public.get_config(text)'::regprocedure)) > 0 as missing_row_reads_on,
  has_function_privilege('anon', 'public.get_config(text)', 'execute') as anon_reads_get_config,
  (has_column_privilege('anon', 'public.client_settings', 'quote_corner_views', 'SELECT')
     or has_column_privilege('authenticated', 'public.client_settings', 'quote_corner_views', 'SELECT')) as browser_can_read_switch;

commit;

-- After this: every builder's switch reads on, a new builder's does too, get_config carries
-- "quoteCornerViews": true for all of them, and the designer draws the page wherever 3D is on.
