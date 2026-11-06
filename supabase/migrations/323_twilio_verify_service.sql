-- 323_twilio_verify_service.sql — each builder's own Twilio Verify service, inside their sub-account,
-- so a customer's login text says "Your <Builder> verification code is …" instead of ours.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Run the file (its comment header rules out inline):
--      npx supabase db query --linked --file supabase/migrations/323_twilio_verify_service.sql
--    then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('323', '323_twilio_verify_service') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;. THE RECORD at the end is
--    what the apply shows; no row printed means the file did not run (read the column back from
--    information_schema to be sure). To see the same row and change nothing, run it with the last
--    `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger 2026-10-21: 320 is the newest. 321 (tenant_purge, client deletion part 2) and 322
-- (quote_corner_views_on) are held by sibling branches. Take the next free number at apply time,
-- renaming this file, its test (tests/sql/migration323.test.cjs) and every '323' below; record the
-- ledger row with `returning`: no row back means the number was taken.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn's board item 72b1008c (due 2026-10-23): a customer's login code text names Structure
-- Studio, not their builder. Twilio's default Verify text is "Your {friendly name} verification
-- code is …", and the friendly name belongs to the SERVICE. Every code went out on ONE service
-- (TWILIO_VERIFY_SERVICE_SID, "Structure Studio"). The per-request override (CustomFriendlyName,
-- "Custom Company Name") needs Twilio Sales, and without it Twilio refused every branded send
-- (403/60204). Ahsan, 2026-10-21: build a Verify service per builder now instead. Each client
-- builder already has its own sub-account (292, made 2026-10-12), so the service lives there, is
-- made with the sub's own credentials, and is named after the builder (_shared/twilioVerifyService.ts).
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   * twilio_accounts.verify_service_sid  the VA… SID of the Verify service inside the tenant's
--     sub-account. NULL = none yet: customer-auth sends on the parent's service, as before.
--   * twilio_accounts.verify_service_name the FriendlyName that service was last given (already
--     sanitized: letters, digits, spaces, at most 30 characters). customer-auth compares it with the
--     builder's current name to notice a rename without asking Twilio.
--   * Both set together or not at all, and only on a kind 'sub' row: a parent pin has no service
--     of its own (structure-studio stays on the parent's "Structure Studio" service, its real name).
--   Same posture as the rest of the table (292): RLS on, not forced, no policy, nothing granted to
--   anon or authenticated. New columns inherit the table's grants, so nothing is granted here.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────
--   * Creates no service and changes no row: the columns start NULL for every tenant, and the
--     operator console's Twilio account card (Create, or "Sync login text name") fills them.
--   * Touches none of 292's or 295's functions (twilio_account_creds still returns what it did).
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- ADD COLUMN with no default on a six-row table that only service-role code reads. The live
-- customer-auth never names these columns, so nothing changes until the new one is deployed.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Clearing the SIDs alone sends every login code back to the parent's service at once:
--   update public.twilio_accounts set verify_service_sid = null, verify_service_name = null;
-- To remove the columns too (after customer-auth and admin-catalog are rolled back):
--   alter table public.twilio_accounts drop column if exists verify_service_name;
--   alter table public.twilio_accounts drop column if exists verify_service_sid;
--   delete from supabase_migrations.schema_migrations where version = '323';
-- The services themselves stay in each sub-account (they cost nothing until a code is sent) and
-- close with it.

begin;

set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.twilio_accounts') is null then
    raise exception '323: twilio_accounts is missing (migration 292 not applied?)';
  end if;
end
$pre$;

alter table public.twilio_accounts add column if not exists verify_service_sid text;
alter table public.twilio_accounts add column if not exists verify_service_name text;

do $col$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.twilio_accounts'::regclass
                  and conname = 'twilio_accounts_verify_service_sid_chk') then
    alter table public.twilio_accounts add constraint twilio_accounts_verify_service_sid_chk
      check (verify_service_sid is null or verify_service_sid ~ '^VA[0-9a-fA-F]{32}$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.twilio_accounts'::regclass
                  and conname = 'twilio_accounts_verify_service_name_chk') then
    alter table public.twilio_accounts add constraint twilio_accounts_verify_service_name_chk
      check (verify_service_name is null or verify_service_name ~ '^[A-Za-z0-9]([A-Za-z0-9 ]{0,28}[A-Za-z0-9])?$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.twilio_accounts'::regclass
                  and conname = 'twilio_accounts_verify_service_pair_chk') then
    alter table public.twilio_accounts add constraint twilio_accounts_verify_service_pair_chk
      check ((verify_service_sid is null) = (verify_service_name is null)
             and (verify_service_sid is null or kind = 'sub'));
  end if;
end
$col$;

comment on column public.twilio_accounts.verify_service_sid is
  'Migration 323: the Twilio Verify service (VA…) inside this sub-account, named after the builder; customer-auth sends and checks login codes on it with the sub''s credentials. NULL = none: the parent''s service is used.';
comment on column public.twilio_accounts.verify_service_name is
  'Migration 323: the FriendlyName the Verify service was last given (sanitized, max 30). Set together with verify_service_sid.';

-- ── The checks ──────────────────────────────────────────────────────────────────────────────
do $check$
begin
  if not exists (select 1 from pg_catalog.pg_class c where c.oid = 'public.twilio_accounts'::regclass and c.relrowsecurity) then
    raise exception '323: twilio_accounts has row level security OFF';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.twilio_accounts'::regclass) then
    raise exception '323: twilio_accounts has a policy; it is meant to be service-role only';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and (has_column_privilege('anon', 'public.twilio_accounts', 'verify_service_sid', 'SELECT')
       or has_column_privilege('anon', 'public.twilio_accounts', 'verify_service_name', 'UPDATE')) then
    raise exception '323: anon can reach the new columns';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and (has_column_privilege('authenticated', 'public.twilio_accounts', 'verify_service_sid', 'SELECT')
       or has_column_privilege('authenticated', 'public.twilio_accounts', 'verify_service_name', 'UPDATE')) then
    raise exception '323: authenticated can reach the new columns';
  end if;
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD ────────────────────────────────────────────────────────────────────────────
-- PASS is: columns_added true, browser_blocked true, services_set 0 (nothing is filled by this file).
select
  '323' as migration,
  (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'twilio_accounts'
     and c.column_name in ('verify_service_sid', 'verify_service_name'))::int = 2 as columns_added,
  (not exists (select 1 from pg_roles where rolname = 'anon')
     or not has_table_privilege('anon', 'public.twilio_accounts', 'SELECT')) as browser_blocked,
  (select count(*) from public.twilio_accounts where verify_service_sid is not null)::int as services_set;

commit;
