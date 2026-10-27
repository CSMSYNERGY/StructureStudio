-- 342_sms_sole_prop.sql — the per-builder switch for texting WITHOUT an EIN (Twilio's Sole
-- Proprietor tier). Off for every builder; an operator turns it on for one builder by SQL.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, and only once Ahsan says go. Either through the
--    Supabase connector's apply_migration (name '342_sms_sole_prop'; it stamps its own timestamp
--    version in the ledger, the way 158 is recorded, so add no second row), or pipe this file to
--    `npx supabase db query --linked` on stdin as 341 does. NEVER `--file` (it 403s since
--    2026-10-24, 339's header). After a stdin apply, record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('342', '342_sms_sole_prop') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run, and
--    a printed row is still not proof (2026-10-21: a begin/commit block sent through `db query`
--    applied nothing and said nothing), so READ IT BACK in a separate query afterwards:
--      select column_name, data_type, is_nullable, column_default from information_schema.columns
--       where table_schema = 'public' and table_name = 'client_settings' and column_name = 'sms_sole_prop';
--      select count(*) filter (where sms_sole_prop) as on_count, count(*) as rows from public.client_settings;
--    To see the record and change nothing, run it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger 2026-10-27: 341 is the newest numbered migration (340 is applied too, from the
-- unpushed ss/c1027-support-agent branch). Other sessions take numbers within minutes, so confirm
-- at apply time that 342 is free; record the ledger row with `returning`: no row back means the
-- number was taken, so rename this file, its test (tests/sql/migration342.test.cjs) and every
-- '342' below.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Texting has refused a builder with no EIN since 2026-08-31 ("We can't set this up without an EIN
-- yet"): Twilio registers them through a different chain (a Starter customer profile, a Sole
-- Proprietor trust product, a SOLE_PROPRIETOR brand the owner confirms by replying YES to a text,
-- one campaign and one number). That chain is built now (portal-sms, _shared/twilioTrustHub.ts),
-- but Ahsan, 2026-10-27: it SHIPS DARK. Nothing has been registered through it for real (no money
-- is spent proving it), so it opens one builder at a time, when an operator decides to.
--
-- ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────────────────
--   * client_settings.sms_sole_prop boolean NOT NULL DEFAULT false. Every existing row reads false
--     (the default fills them), and so does every builder made later.
--   * The checks: the column is boolean, not null, default false; client_settings is still
--     service-role only (RLS on, NO policy, nothing for anon or authenticated), the posture 287,
--     290 and 322 assert. New columns inherit the table's grants, so nothing is granted here.
--   * THE RECORD.
--
-- ── WHO READS IT ─────────────────────────────────────────────────────────────────────────
-- portal-sms only (portal-sms/soleProp.ts soleProprietorOn), TOLERANTLY: a database without this
-- column, or a read that fails, reads as OFF, the same posture portal-settings takes towards the
-- library switch (library.ts readLibraryFlag). Off, every screen and every answer is what it was
-- before this branch, the no-EIN refusal included. Nothing lets a builder set it: no action writes
-- it. The portal learns it only as `soleProprietorAvailable` on the Text Messaging status answer.
--
-- ── HOW AN OPERATOR TURNS IT ON (one builder) ────────────────────────────────────────────
--   update public.client_settings set sms_sole_prop = true where client_id = '<builder id>' returning client_id, sms_sole_prop;
-- and off again with `= false`. Off part-way through stops the next paid step (portal-sms refuses
-- the ready and profile_pending stages for a sole-proprietor row while it reads off); a brand that
-- already exists at Twilio carries on to its YES text and campaign either way.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- ADD COLUMN ... DEFAULT false on Postgres 11+ is a catalog change (no table rewrite) on a table of
-- a handful of rows. The live portal-sms never names the column, so nothing changes until the new
-- one is deployed, and the new one reads a database without it as off.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Turning every builder off is enough to stop the route:
--   update public.client_settings set sms_sole_prop = false where sms_sole_prop;
-- To remove the column too (portal-sms reads its absence as off, so the order does not matter):
--   alter table public.client_settings drop column if exists sms_sole_prop;
--   delete from supabase_migrations.schema_migrations where version = '342';
--   notify pgrst, 'reload schema';

begin;

-- The ALTER takes an ACCESS EXCLUSIVE lock on client_settings (brief), which get_config reads on
-- every designer boot. A hung apply must give up rather than sit in front of them.
set local lock_timeout = '5s';

do $m342_pre$
begin
  if to_regclass('public.client_settings') is null then
    raise exception '342: public.client_settings is missing — this is not the StructureStudio database';
  end if;
end
$m342_pre$;

alter table public.client_settings
  add column if not exists sms_sole_prop boolean not null default false;

comment on column public.client_settings.sms_sole_prop is
  'Texting without an EIN (Twilio''s Sole Proprietor A2P tier) is open to this builder. Off for everyone; an '
  'operator turns it on per builder by SQL, and nothing lets a builder set it. portal-sms reads it tolerantly '
  '(a database without it reads off): off, a builder who answers "no EIN" is refused exactly as before; on, '
  'they get the Starter profile + Sole Proprietor trust product + SOLE_PROPRIETOR brand chain, the reply-YES '
  'step, one campaign and one number. Migration 342 (Ahsan 2026-10-27: ships dark).';

-- ── The checks (they RAISE and abort the whole file) ────────────────────────────────────────
do $m342_check$
declare
  v_role text;
  v_priv text;
  v_col  record;
begin
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'sms_sole_prop';
  if not found then
    raise exception '342: client_settings.sms_sole_prop was not added';
  end if;
  -- An earlier hand-made copy of the column with another shape would survive `if not exists`.
  if v_col.data_type <> 'boolean' or v_col.is_nullable <> 'NO' or coalesce(v_col.column_default, '') <> 'false' then
    raise exception '342: client_settings.sms_sole_prop is % (nullable %, default %), not boolean not null default false',
      v_col.data_type, v_col.is_nullable, coalesce(v_col.column_default, 'none');
  end if;

  -- ── Still service-role only: RLS on, no policy, nothing for the browser roles ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.client_settings'::regclass) then
    raise exception '342: RLS is off on client_settings';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.client_settings'::regclass) then
    raise exception '342: client_settings has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
        if has_column_privilege(v_role, 'public.client_settings', 'sms_sole_prop', v_priv) then
          raise exception '342: % holds % on client_settings.sms_sole_prop', v_role, v_priv;
        end if;
      end loop;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach v_priv in array array['SELECT', 'UPDATE'] loop
      if not has_column_privilege('service_role', 'public.client_settings', 'sms_sole_prop', v_priv) then
        raise exception '342: service_role lacks % on client_settings.sms_sole_prop — portal-sms could not read it', v_priv;
      end if;
    end loop;
  end if;
end
$m342_check$;

notify pgrst, 'reload schema';

-- ── THE RECORD ────────────────────────────────────────────────────────────────────────────
-- PASS on a first apply is: column_added true, browser_blocked true, turned_on 0. On a re-apply,
-- turned_on is however many builders an operator has switched on since (this file never changes a row).
select
  '342' as migration,
  exists (select 1 from information_schema.columns c
           where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'sms_sole_prop') as column_added,
  (not exists (select 1 from pg_roles where rolname = 'anon')
     or not has_column_privilege('anon', 'public.client_settings', 'sms_sole_prop', 'SELECT')) as browser_blocked,
  (select count(*) from public.client_settings where sms_sole_prop)::int as turned_on,
  (select count(*) from public.client_settings)::int as settings_rows;

commit;
