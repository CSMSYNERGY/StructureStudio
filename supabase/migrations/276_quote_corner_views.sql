-- 276_quote_corner_views.sql — a builder can put the building from all four corners on page 2 of
-- the customer's quote, instead of the one three-quarter view it carries today.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (NOT `--file`, which auth-fails, retries and still exits 0 — see 232's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('276', '276_quote_corner_views');
--    NEVER `supabase db push`. The file carries its own begin;/commit; so every check below takes the
--    whole migration with it if it fails.
--    `db query` NEVER prints a NOTICE (it prints the rows of the last statement that returns any), so
--    every RAISE NOTICE below is for psql and the tests only. What the apply shows is THE RECORD, one
--    row just before the commit (see its header at the end): read it, and keep it with the ledger
--    insert. No row printed means the file did not run. To see the same row first and change
--    nothing, pipe the file with its last `commit;` swapped for `rollback;` (a dry run).
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-08-20 (Fathom 792806297 @33:15): a 3D page on the estimate, "optional for them",
-- that "gets 4 sides. So 4 quadrants", on its own page so it prints two-sided behind the floor
-- plan. 2026-09-08, in writing: "we want to see 4 images... one from each corner". Monday Tasks item
-- ("4-quadrant 3D view as optional page 2 of the estimate PDF, per-builder toggle"), and
-- a builder's own card asks for the same thing ("3D image on estimates for customers to see").
-- Four three-quarter views from the corners show all four walls, so the 2026-09-08 wording meets
-- the 2026-08-20 one.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   client_settings.quote_corner_views boolean NOT NULL DEFAULT false — the switch
--   PART 2   get_config emits a top-level `"quoteCornerViews": true` ONLY when the switch is on,
--            SPLICED into the live body (232's mechanism), never rewritten
--   PART 3   checks: every tenant's get_config md5 is unchanged; grants hold; a rehearsal on one
--            tenant proves the switch reaches get_config, and is rolled back
--   RECORD   one row the CLI prints
--
-- ── HOW THE CODE USES IT (deployed after this file) ──────────────────────────────────────
--   portal-settings   status returns quoteCornerViews from its own tolerant read (null when the
--                     column cannot be read, which hides the switch); save takes a boolean.
--   portal            Settings → Company, under "Quotes are good for": "Show the building from
--                     all four corners on page 2 of my quotes", only where 3D is unlocked.
--   designer (twins)  submitQuote: with 3D on AND config.quoteCornerViews, page 2 of the plan PDF is
--                     the four-corner sheet (renderQuoteCornerSheet), falling back to today's single
--                     shot when it cannot render. The single shot still goes up as the 3D image, so
--                     the order screen's card and the quote thumbnail do not change.
--   _shared/quotePdf.ts appends that PDF to the estimate, the invoice and every re-print, so the
--                     page reaches all three with no server change.
--
-- ── WHAT DOES NOT CHANGE ─────────────────────────────────────────────────────────────────
--   * Off for every row it lands on, so no quote changes until a builder switches it on.
--   * SPARSE: a builder with the switch off gets NO key, not `"quoteCornerViews": false`, so every
--     tenant's get_config payload is byte-identical to today's (PART 3 proves it, md5 by md5).
--     jsonb `|| '{}'` is a no-op on the serialised text, the same fact 232 relied on.
--   * No table, policy, trigger or new function.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database, and get_config is the boot read for every tenant's
-- public designer, so the splice is live on PRODUCTION's pages the moment it commits. It is inert
-- there: the key is absent for everyone, and a production designer that predates this ignores it
-- anyway. ADD COLUMN with a constant default is a catalog change (no rewrite) on a table of a
-- handful of rows (5 on 2026-10-05). The live functions select named columns, so the new one is
-- invisible to them; portal-settings' save upserts named columns, so the default fills it on a first
-- insert. client_settings has no trigger. CREATE OR REPLACE keeps get_config's ACL, owner, SECURITY
-- DEFINER and search_path; PART 3 re-asserts anon EXECUTE anyway, because a designer that cannot
-- read its config is every tenant's page down.
--
-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────
-- client_settings is service-role only: RLS on, no policy, nothing for the browser roles (it holds
-- the CRM API key). A new column carries no privilege beyond the table's, and PART 3 checks that
-- rather than assuming it. The browser learns the switch two ways, both as a function: get_config
-- (SECURITY DEFINER, owner postgres, which already reads show_pricing from this table) and
-- portal-settings (service_role).
--
-- ── SPLICED, NOT REWRITTEN ───────────────────────────────────────────────────────────────
-- 110's rule, 232's mechanism: read the LIVE body, insert one expression at one anchor, execute.
-- get_config is ~17.8 KB and has been extended by splices on several branches; pasting a body from
-- a file would silently drop whatever landed since. Three guards, and nothing rather than half:
--   1. Already spliced (`quoteCornerViews` in the body) → notice and skip. A re-run is safe.
--   2. The anchor — the paren that closes the top-level jsonb_build_object, the `end` of the
--      null-tenant CASE and the FROM line under it — must occur EXACTLY ONCE. Confirmed on the live
--      project 2026-10-05: count 1, body 17807 chars, md5 770a09c039be6a5d280204880d25cb8c (that is
--      270's body). The newlines inside it are chr(10), not literal line breaks: this file is
--      checked out CRLF on Windows, and a CRLF anchor never matches.
--   3. The new body is longer by exactly the inserted text: one insertion, no deletion.
-- The insertion goes between the `)` and the `end`, so it is the ELSE branch's value that gains the
-- key; an unknown tenant still reads NULL (the designer's "Configuration not found").
-- ⚠️ Migration 275 (the same batch) splices get_config too, inside claddingOptions. Each splice
-- re-derives its anchor from the live body at apply time, so the two apply in either order.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-05: 270 is the newest. 271-274 are held for the batches building beside this
-- one; batch Y2 has 275 (cladding exposure) and 276 (this). Confirm at apply time that the ledger
-- does not already show 276:
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 3;
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- This file FIRST, then portal-settings, then the portal and the designer to beta.
-- Either function order is survivable: portal-settings reads the column tolerantly (a missing
-- column answers null and hides the switch), and a designer without this file never sees the key.
-- Production's designer and portal ignore the key until they are promoted.
--
-- ── ROLLBACK — in THIS order ─────────────────────────────────────────────────────────────
--   1. Un-splice first (a LANGUAGE sql body that names a dropped column fails every call, and that
--      body is every public designer's first read):
--        do $$ declare s text := pg_get_functiondef('public.get_config(text)'::regprocedure);
--               a text := $a$ || case when coalesce((select cs.quote_corner_views from public.client_settings cs where cs.client_id = cc.client_id), false) then jsonb_build_object('quoteCornerViews', true) else '{}'::jsonb end$a$;
--        begin if position(a in s) = 0 then raise exception 'splice not found'; end if;
--              execute replace(s, a, ''); end $$;
--   2. Then put back the portal-settings without quoteCornerViews (with the column gone its status
--      read answers null and hides the switch; a save that carries the key would fail).
--   3. Then: alter table public.client_settings drop column quote_corner_views;
--      notify pgrst, 'reload schema';
--   4. Then delete the ledger row. Every builder who switched it on goes back to the one-view page 2.

begin;

-- PART 1's ALTER TABLE takes an ACCESS EXCLUSIVE lock on client_settings (brief: a catalog change),
-- which get_config reads on every call, and PART 2's CREATE OR REPLACE locks get_config itself. A
-- hung apply must give up rather than sit in front of every designer's boot read.
set local lock_timeout = '5s';

-- Every tenant's get_config BEFORE anything here runs: PART 3 compares the md5 of each. Taken
-- before the ALTER so the comparison covers PART 1 too.
create temp table m276_before on commit drop as
  select cc.client_id, md5(public.get_config(cc.client_id)::text) as cfg_md5
    from public.client_configs cc;

-- Was the column already here? On the first apply every builder must read off; a re-apply comes
-- after builders have chosen, and must keep what they chose.
select set_config('ss.m276_first_apply', (not exists (
  select 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'client_settings' and column_name = 'quote_corner_views'
))::text, true);

-- ── PART 1. client_settings.quote_corner_views ───────────────────────────────────────────
alter table public.client_settings
  add column if not exists quote_corner_views boolean not null default false;

comment on column public.client_settings.quote_corner_views is
  'The builder''s "Show the building from all four corners on page 2 of my quotes" switch (Settings → Company, '
  'portal-settings save). On, and with 3D on: page 2 of every quote PDF the designer submits is a '
  'four-corner sheet instead of the one three-quarter view. get_config emits "quoteCornerViews": true '
  'only when on (sparse, so every other tenant''s config is unchanged). Off by default. Migration 276.';

-- ── PART 2. get_config: the sparse top-level key ─────────────────────────────────────────
do $splice$
declare
  v_src    text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  -- The top-level object's closing paren, the null-tenant CASE's `end`, and the FROM under them.
  -- chr(10), not a line break in this file: see the header (CRLF checkouts).
  v_head   text := chr(10) || '  )';
  v_tail   text := ' end' || chr(10) || '  from public.client_configs cc where cc.client_id = p_client_id;';
  v_anchor text := v_head || v_tail;
  v_add    text := $a$ || case when coalesce((select cs.quote_corner_views from public.client_settings cs where cs.client_id = cc.client_id), false) then jsonb_build_object('quoteCornerViews', true) else '{}'::jsonb end$a$;
  v_hits   integer;
  v_new    text;
begin
  -- GUARD 1 — idempotent.
  if position('quoteCornerViews' in v_src) > 0 then
    raise notice '276: get_config already emits quoteCornerViews — nothing to splice';
    return;
  end if;

  -- GUARD 2 — the anchor is unique: the end of the top-level object.
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '276: anchor found % time(s), expected exactly 1 — get_config has changed shape; re-derive the anchor from a fresh pg_get_functiondef before retrying', v_hits;
  end if;

  v_new := replace(v_src, v_anchor, v_head || v_add || v_tail);

  -- GUARD 3 — one insertion, no deletion.
  if length(v_new) <> length(v_src) + length(v_add) then
    raise exception '276: spliced body is % chars, expected % — refusing to execute', length(v_new), length(v_src) + length(v_add);
  end if;

  execute v_new;
  raise notice '276: spliced quoteCornerViews into get_config (% -> % chars)', length(v_src), length(v_new);
end
$splice$;

-- ── PART 3. Checks: raise (and so roll the whole file back) rather than commit a surprise ─
do $check$
declare
  v_col     record;
  v_body    text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  v_role    text;
  v_priv    text;
  v_on      text;
  v_moved   text;
  v_probe   text;
  v_emits   jsonb;
  v_offkey  boolean;
begin
  -- ── The column: boolean, NOT NULL, default false ──
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'quote_corner_views';
  if v_col.data_type is null then
    raise exception '276: client_settings.quote_corner_views is missing';
  end if;
  if v_col.data_type <> 'boolean' or v_col.is_nullable <> 'NO' or v_col.column_default is distinct from 'false' then
    raise exception '276: client_settings.quote_corner_views should be boolean NOT NULL DEFAULT false, is % / nullable % / default %',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  end if;

  -- ── Freshly added means off for everyone ──
  select string_agg(client_id, ', ' order by client_id) into v_on from public.client_settings where quote_corner_views;
  if current_setting('ss.m276_first_apply', true) = 'true' and v_on is not null then
    raise exception '276: quote_corner_views was just added and is already on for: %', v_on;
  end if;

  -- ── Still service-role only: RLS on, no policy, nothing for the browser roles ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.client_settings'::regclass) then
    raise exception '276: RLS is off on client_settings';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.client_settings'::regclass) then
    raise exception '276: client_settings has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if has_column_privilege(v_role, 'public.client_settings', 'quote_corner_views', v_priv) then
        raise exception '276: % holds % on client_settings.quote_corner_views', v_role, v_priv;
      end if;
    end loop;
  end loop;
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
    if not has_column_privilege('service_role', 'public.client_settings', 'quote_corner_views', v_priv) then
      raise exception '276: service_role lacks % on client_settings.quote_corner_views — the Settings save would fail', v_priv;
    end if;
  end loop;

  -- ── get_config: spliced once, still callable by anon ──
  if (length(v_body) - length(replace(v_body, 'quoteCornerViews', ''))) / length('quoteCornerViews') <> 1 then
    raise exception '276: get_config does not name quoteCornerViews exactly once after the splice';
  end if;
  if not has_function_privilege('anon', 'public.get_config(text)', 'execute') then
    raise exception '276: anon lost EXECUTE on get_config — every public designer would fail to load';
  end if;

  -- ── Every tenant's get_config, md5 for md5, is what it was. Dynamic SQL so no plan cached before
  --    the splice is reused. On a first apply nobody has the switch on, so this is "no key anywhere";
  --    on a re-apply the builders who switched it on carried the key before and after alike.
  execute 'select string_agg(b.client_id, '', '' order by b.client_id) from m276_before b
            where md5(public.get_config(b.client_id)::text) is distinct from b.cfg_md5'
    into v_moved;
  if v_moved is not null then
    raise exception '276: get_config changed for: %', v_moved;
  end if;
  if (select count(*) from m276_before) <> (select count(*) from public.client_configs) then
    raise exception '276: the tenant count moved during the apply — run it again';
  end if;

  -- ── The rehearsal: switch it on for one real tenant, read get_config, and roll that back ──
  -- A sub-block whose own exception is its rollback: the update and everything it touched are
  -- undone, and only the two answers (plain variables) survive it. A table with no tenant that has
  -- both rows has nothing to rehearse on; the checks above still stand.
  select min(cs.client_id) into v_probe
    from public.client_settings cs
    join public.client_configs cc on cc.client_id = cs.client_id
   where not cs.quote_corner_views;
  if v_probe is not null then
    begin
      update public.client_settings set quote_corner_views = true where client_id = v_probe;
      execute 'select public.get_config($1)' into v_emits using v_probe;
      raise exception using errcode = 'S2760', message = '276: rehearsal rolled back';
    exception when sqlstate 'S2760' then
      null;
    end;
    if v_emits is null or (v_emits -> 'quoteCornerViews') is distinct from 'true'::jsonb then
      raise exception '276: switching it on for % did not make get_config emit "quoteCornerViews": true (got %)',
        v_probe, coalesce(v_emits -> 'quoteCornerViews', 'null'::jsonb);
    end if;
    execute 'select public.get_config($1) ? ''quoteCornerViews''' into v_offkey using v_probe;
    if v_offkey then
      raise exception '276: the rehearsal did not roll back — % still carries quoteCornerViews', v_probe;
    end if;
  end if;

  raise notice '276: checks hold; quote_corner_views % on client_settings; every tenant''s get_config unchanged; on for: %',
    case when current_setting('ss.m276_first_apply', true) = 'true' then 'added, off,' else 'kept' end, coalesce(v_on, '(none)');
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- The NOTICEs above never reach the CLI (it prints the rows of the last statement that returns any,
-- even with a commit or rollback after it). So this row is the apply's report, and it sits BEFORE
-- the commit so a dry run (last `commit;` swapped for `rollback;`) prints the same row and leaves
-- nothing behind. Expected on 2026-10-05:
--   get_config_splices 1, tenants_checked 6 (every client_configs row), configs_changed '(none)',
--   switched_on 0, anon_reads_get_config true, browser_can_read_switch false
-- Anything else: roll back (see ROLLBACK above) before recording the ledger row.
select
  '276' as migration,
  (length(pg_get_functiondef('public.get_config(text)'::regprocedure))
     - length(replace(pg_get_functiondef('public.get_config(text)'::regprocedure), 'quoteCornerViews', '')))
     / length('quoteCornerViews') as get_config_splices,
  (select count(*) from m276_before)::int as tenants_checked,
  coalesce((select string_agg(b.client_id, ', ' order by b.client_id) from m276_before b
             where md5(public.get_config(b.client_id)::text) is distinct from b.cfg_md5), '(none)') as configs_changed,
  (select count(*) from public.client_settings where quote_corner_views)::int as switched_on,
  has_function_privilege('anon', 'public.get_config(text)', 'execute') as anon_reads_get_config,
  (has_column_privilege('anon', 'public.client_settings', 'quote_corner_views', 'SELECT')
     or has_column_privilege('authenticated', 'public.client_settings', 'quote_corner_views', 'SELECT')) as browser_can_read_switch;

commit;

-- After this: client_settings.quote_corner_views exists, off for every builder, and get_config
-- carries "quoteCornerViews": true for a builder who switches it on. Nothing else in get_config moved.
