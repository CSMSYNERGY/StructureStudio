-- 356_ghl_sender_user.sql — Which CRM user a builder's estimates go out as.
--
-- GoHighLevel picks an estimate email's route from the user it is sent as. A user with a connected
-- mailbox sends through that mailbox, and there an estimate carrying the floor plan PDF from our
-- storage fails after GHL has already answered 201. A user with no mailbox sends through the
-- location's own sending domain, where the same PDF is delivered. submit-estimate borrows
-- products[0].createdBy, so a builder cannot choose. Measured 2026-11-04 on a live location; the
-- detail is in supabase/functions/_shared/ghlSender.ts.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────────────
-- One nullable text column on client_settings. NULL keeps today's behaviour, and every row starts
-- NULL, so applying this changes the behaviour of nothing until someone sets a value. That is a
-- GHL user id on that builder's own location:
--
--   update public.client_settings set ghl_sender_user_id = '<GHL user id>'
--    where client_id = '<builder>' returning client_id, ghl_sender_user_id;
--
-- No Settings screen yet: this is a platform decision about one builder's CRM, not something a
-- builder should have to understand. submit-estimate checks the id against GHL's user list on each
-- submit and files a ghl_sender_pin_stale error row instead of failing the quote if it has gone.
--
-- Pick a user with no connected mailbox, and check from a signed-in GHL session: the builder's API
-- key read twoWaySync.outlook as absent for a user who has one (2026-11-04). If the pinned user
-- connects a mailbox later, the silent failure returns and nothing here notices.
--
-- ── SAFE WITH WHAT IS LIVE ──────────────────────────────────────────────────────────
-- Either order. submit-estimate reads the column on its own tolerant read (_shared/ghlSender.ts),
-- so deployed first it sees "no pin" on the 42703 and quotes go out as they do today. The column
-- stays service-role only like the rest of the table (it sits beside the CRM API key). Checked
-- below.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. NEVER `supabase db push`, never `--file`, never inside
--    begin;/commit;. One inline call per piece (CLI `db query --linked` or the Supabase connector's
--    execute_sql):
--
--   F=supabase/migrations/356_ghl_sender_user.sql
--   piece() { awk -v n="$1" '{sub(/\r$/,"")} $0=="-- >>> "n{on=1;next} $0=="-- <<< "n{on=0} on' "$F" | grep -v '^--'; }
--   "$SB" db query --linked "$(piece P0)"      # must print ONE row: 356, 356_ghl_sender_user
--   "$SB" db query --linked "$(piece P1)"      # the column and its checks
--   "$SB" db query --linked "$(piece R1)"      # THE RECORD
--
-- P0 claims the number first: no row back means another session took 356, so rename this file, its
-- test (tests/sql/migration356.test.cjs) and every '356' below. Read the max first, numbered rows only:
-- select max(version) filter (where version ~ '^\d{3}$') from supabase_migrations.schema_migrations;
--
-- ── REVERSE ─────────────────────────────────────────────────────────────────────────
--   alter table public.client_settings drop column if exists ghl_sender_user_id;
--   delete from supabase_migrations.schema_migrations where version = '356';
-- Safe at any time: the read goes back to "no pin", and estimates go out as products[0].createdBy.

-- >>> P0
insert into supabase_migrations.schema_migrations (version, name)
values ('356', '356_ghl_sender_user')
on conflict (version) do nothing
returning version, name;
-- <<< P0

-- >>> P1
-- The ALTER takes an ACCESS EXCLUSIVE lock on client_settings (brief), which every quote and portal
-- settings load reads. A hung apply must give up rather than sit in front of them. One call is one
-- implicit transaction, so this holds for the ALTER, and re-running is safe.
set local lock_timeout = '5s';

alter table public.client_settings
  add column if not exists ghl_sender_user_id text;

comment on column public.client_settings.ghl_sender_user_id is
  'GHL user id this builder''s estimates go out as (migration 356). NULL: products[0].createdBy, then the first user. GHL routes the email by this user: see _shared/ghlSender.ts.';

do $assert$
declare
  v_role text;
  v_priv text;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'client_settings'
                    and column_name = 'ghl_sender_user_id' and data_type = 'text'
                    and is_nullable = 'YES' and column_default is null) then
    raise exception '356: client_settings.ghl_sender_user_id should be text, nullable, with no default';
  end if;

  -- Still service-role only: RLS on, no policy, nothing for the browser roles.
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.client_settings'::regclass) then
    raise exception '356: RLS is off on client_settings';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.client_settings'::regclass) then
    raise exception '356: client_settings has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if has_column_privilege(v_role, 'public.client_settings', 'ghl_sender_user_id', v_priv) then
        raise exception '356: % holds % on client_settings.ghl_sender_user_id', v_role, v_priv;
      end if;
    end loop;
  end loop;

  -- The function's read has to work.
  if not has_column_privilege('service_role', 'public.client_settings', 'ghl_sender_user_id', 'SELECT') then
    raise exception '356: service_role cannot read client_settings.ghl_sender_user_id';
  end if;
end
$assert$;

notify pgrst, 'reload schema';
-- <<< P1

-- >>> R1
select exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'client_settings'
                  and column_name = 'ghl_sender_user_id' and data_type = 'text'
                  and is_nullable = 'YES') as column_ready,
       (select count(*) from public.client_settings where ghl_sender_user_id is not null) as pinned_builders,
       (select count(*) from supabase_migrations.schema_migrations where version = '356') as ledger_rows;
-- <<< R1
