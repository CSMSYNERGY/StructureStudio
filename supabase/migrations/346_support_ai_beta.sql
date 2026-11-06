-- 346_support_ai_beta.sql — the per-builder switch for the top bar's Support button and its
-- assistant (support-agent, migration 340). Off for every builder; an operator turns it on for one
-- builder by SQL.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, and only once Ahsan says go. Either through the
--    Supabase connector's apply_migration (name '346_support_ai_beta'; it stamps its own timestamp
--    version in the ledger, the way 158 is recorded, so add no second row), or the connector's
--    execute_sql followed by the ledger row:
--      insert into supabase_migrations.schema_migrations (version, name) values ('346', '346_support_ai_beta') returning version, name;
--    NEVER `supabase db push`, never `db query --file` (it 403s since 2026-10-24, 339's header).
--    The file carries its own begin;/commit;, so a failed check anywhere takes the whole migration
--    with it. A printed record is still not proof (2026-10-21: a begin/commit block sent through
--    `db query` applied nothing and said nothing), so READ IT BACK in a separate query afterwards:
--      select column_name, data_type, is_nullable, column_default from information_schema.columns
--       where table_schema = 'public' and table_name = 'client_settings' and column_name = 'support_ai_beta';
--      select count(*) filter (where support_ai_beta) as on_count, count(*) as rows from public.client_settings;
--    To see the record and change nothing, run it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger 2026-10-27 17:20 UTC: 345 is the newest. Other sessions take numbers within minutes,
-- so confirm at apply time that 346 is free; record the ledger row with `returning`: no row back
-- means the number was taken, so rename this file, its test (tests/sql/migration346.test.cjs) and
-- every '346' below.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- The Support button replaces the floating "💬 Feedback" pill (Carolyn, 10-26 call). Carolyn sees it
-- on 10-28, before any other builder, and it must not ride the weekly release to everyone while she
-- has not. So it SHIPS DARK, one builder at a time, the way texting without an EIN did (342): with
-- the switch off a builder's portal is exactly what it was, pill and all.
--
-- ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────────────────
--   * client_settings.support_ai_beta boolean NOT NULL DEFAULT false. Every existing row reads false
--     (the default fills them), and so does every builder made later.
--   * The checks: the column is boolean, not null, default false; client_settings is still
--     service-role only (RLS on, NO policy, nothing for anon or authenticated), the posture 287,
--     290 and 322 assert. New columns inherit the table's grants, so nothing is granted here.
--   * THE RECORD.
--
-- ── WHO READS IT ─────────────────────────────────────────────────────────────────────────
-- support-agent only (index.ts makeStore().enabled), and it FAILS CLOSED: a database without this
-- column, or a read that fails, reads as OFF. Off, `enabled` answers false, `status` says the
-- assistant is unavailable, and `send` refuses before anything is stored or Claude is asked. The
-- portal asks `enabled` after boot (useSupportOn in portal/04-orders.jsx) and draws the old pill
-- until it hears true. Nothing lets a builder set it: no action writes it.
--
-- ── HOW AN OPERATOR TURNS IT ON (one builder) ────────────────────────────────────────────
--   update public.client_settings set support_ai_beta = true where client_id = '<builder id>' returning client_id, support_ai_beta;
-- and off again with `= false`. The builder's next page load shows the pill again; a chat already
-- open gets the "not switched on" sentence on its next question.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- ADD COLUMN ... DEFAULT false on Postgres 11+ is a catalog change (no table rewrite) on a table of
-- a handful of rows. The live support-agent (build 340.2) never names the column, so nothing
-- changes until the new one (346.1) is deployed, and that one reads a database without it as off.
-- ⚠️ ORDER: apply this, turn the demo builder on, THEN deploy 346.1. Deployed first, it would answer
-- "off" to the branch build being shown from a local server until the switch exists.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Turning every builder off is enough to bring the pill back for everyone:
--   update public.client_settings set support_ai_beta = false where support_ai_beta;
-- To remove the column too (support-agent reads its absence as off, so the order does not matter):
--   alter table public.client_settings drop column if exists support_ai_beta;
--   delete from supabase_migrations.schema_migrations where version = '346';
--   notify pgrst, 'reload schema';

begin;

-- The ALTER takes an ACCESS EXCLUSIVE lock on client_settings (brief), which get_config reads on
-- every designer boot. A hung apply must give up rather than sit in front of them.
set local lock_timeout = '5s';

do $m346_pre$
begin
  if to_regclass('public.client_settings') is null then
    raise exception '346: public.client_settings is missing — this is not the StructureStudio database';
  end if;
end
$m346_pre$;

alter table public.client_settings
  add column if not exists support_ai_beta boolean not null default false;

comment on column public.client_settings.support_ai_beta is
  'The top bar''s Support button and its AI assistant (support-agent) are on for this builder. Off for '
  'everyone; an operator turns it on per builder by SQL, and nothing lets a builder set it. support-agent '
  'reads it and fails closed (a database without it reads off): off, the portal shows the old Feedback '
  'pill and the assistant answers nothing. Migration 346 (Carolyn sees it first, 2026-10-28).';

-- ── The checks (they RAISE and abort the whole file) ────────────────────────────────────────
do $m346_check$
declare
  v_role text;
  v_priv text;
  v_col  record;
begin
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'support_ai_beta';
  if not found then
    raise exception '346: client_settings.support_ai_beta was not added';
  end if;
  -- An earlier hand-made copy of the column with another shape would survive `if not exists`.
  if v_col.data_type <> 'boolean' or v_col.is_nullable <> 'NO' or coalesce(v_col.column_default, '') <> 'false' then
    raise exception '346: client_settings.support_ai_beta is % (nullable %, default %), not boolean not null default false',
      v_col.data_type, v_col.is_nullable, coalesce(v_col.column_default, 'none');
  end if;

  -- ── Still service-role only: RLS on, no policy, nothing for the browser roles ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.client_settings'::regclass) then
    raise exception '346: RLS is off on client_settings';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.client_settings'::regclass) then
    raise exception '346: client_settings has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
        if has_column_privilege(v_role, 'public.client_settings', 'support_ai_beta', v_priv) then
          raise exception '346: % holds % on client_settings.support_ai_beta', v_role, v_priv;
        end if;
      end loop;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach v_priv in array array['SELECT', 'UPDATE'] loop
      if not has_column_privilege('service_role', 'public.client_settings', 'support_ai_beta', v_priv) then
        raise exception '346: service_role lacks % on client_settings.support_ai_beta — support-agent could not read it', v_priv;
      end if;
    end loop;
  end if;
end
$m346_check$;

notify pgrst, 'reload schema';

-- ── THE RECORD ────────────────────────────────────────────────────────────────────────────
-- PASS on a first apply is: column_added true, browser_blocked true, turned_on 0. On a re-apply,
-- turned_on is however many builders an operator has switched on since (this file never changes a row).
select
  '346' as migration,
  exists (select 1 from information_schema.columns c
           where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'support_ai_beta') as column_added,
  (not exists (select 1 from pg_roles where rolname = 'anon')
     or not has_column_privilege('anon', 'public.client_settings', 'support_ai_beta', 'SELECT')) as browser_blocked,
  (select count(*) from public.client_settings where support_ai_beta)::int as turned_on,
  (select count(*) from public.client_settings)::int as settings_rows;

commit;
