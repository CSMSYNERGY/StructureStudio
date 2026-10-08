-- 295_twilio_provision.sql — what creating a builder's Twilio sub-account needs from the database
-- (Workstream 2, phases 3 and 9: provisioning, and the operator console's Close / delete_client).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, AND AFTER 292. Pipe this file to
--    `supabase db query --linked` (stdin), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('295', '295_twilio_provision') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;. THE RECORD at the end is
--    what the apply shows; no row printed means the file did not run. To see the same row and
--    change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Written 2026-10-09 against origin/beta d118eb2e plus 292 (this branch). 293 and 294 are expected
-- to be taken by sibling batches. Read the live ledger first and take the next free number above
-- 292's, renaming this file, its test (tests/sql/migration295.test.cjs) and every '295' below.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Phase 3 (_shared/twilioProvision.ts ensureTwilioAccount) makes each builder's sub-account and
-- everything Twilio needs inside it. Two of its steps need something only the database holds:
--   * the push credentials (step 4). Every sub needs its own copies of the APNs and FCM
--     credentials (a Voice token signed with the sub's key may only name the sub's own push
--     credential: Twilio error 31203). Their material (certificates, private keys, the Firebase
--     service account) is put into Vault BY HAND, under the names below, and only
--     twilio_push_material() reads it.
--   * which kinds were skipped because their material was missing (push_skipped), so the operator
--     console can say "this sub has no iPhone push credential" instead of the app finding out.
-- And phase 9's Close and delete_client need to drop a sub-account's row and its Vault secrets
-- once Twilio has closed it, which only a definer can do (the service role cannot touch vault.*).
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   * twilio_accounts.push_skipped text[]: the push kinds provisioning skipped for want of
--     material ('apns_dev', 'apns_prod', 'fcm'). NULL = none skipped (or not reached).
--   * twilio_push_material(): THREE rows, always, one per kind, with the material Vault holds
--     under exactly these names (NULL where a secret is missing or empty):
--       apns_dev   certificate  twilio_push_apns_dev_certificate    (PEM, the DEVELOPMENT bundle
--                  private_key  twilio_push_apns_dev_private_key     id's VoIP Services cert)
--       apns_prod  certificate  twilio_push_apns_prod_certificate   (PEM, the STORE bundle id's)
--                  private_key  twilio_push_apns_prod_private_key
--       fcm        secret       twilio_push_fcm_secret              (the Firebase service account
--                                                                    JSON the parent's FCM
--                                                                    credential was made from)
--     Both APNs credentials are made with Sandbox UNTICKED, like the parent's (the Worker's
--     DEVIATIONS "One APNs environment": EAS signs every iPhone build for production push; the
--     "dev" one differs by bundle id, not by APNs environment). The function reads ONLY these
--     five names: no argument can point it at any other secret.
--     To load one (by hand, in the SQL editor, never in a file):
--       select vault.create_secret('<the PEM text>', 'twilio_push_apns_prod_certificate', 'Twilio push material (migration 295)');
--     The VoIP certificate expires 2027-11-05: when it is renewed, update the two apns secrets AND
--     each sub's credential (the console card lists them).
--   * twilio_account_forget(p_client_id): removes a tenant's twilio_accounts row, and for a sub
--     its two Vault secrets (by their names only), when that is safe:
--       a parent pin                          → removed ('parent_pin')
--       a sub never created at Twilio         → removed ('never_created'): no SID, provisioning/failed
--       a sub Twilio has CLOSED               → removed with its secrets ('closed_sub')
--       anything else (a live or suspended sub) → REFUSED (55000): close it at Twilio first
--     admin-catalog's delete_client calls it last, so a recreated slug never inherits a dead
--     tenant's account (a closed row would read "not ready" forever; a pin would keep it off a sub).
--   * Both functions SECURITY DEFINER, search_path '', service role only.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────
--   * Nothing changes for any tenant: provisioning runs only when TWILIO_SUBACCOUNTS is "on" or
--     an operator presses Create in the console, and no Vault secret is created here.
--   * Does not change 292's functions, its guard or its pins.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- ADD COLUMN with no default on twilio_accounts (read only by the switch-on code) and two new
-- functions. lock_timeout makes a hung apply give up.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   drop function if exists public.twilio_account_forget(text);
--   drop function if exists public.twilio_push_material();
--   alter table public.twilio_accounts drop column if exists push_skipped;
--   delete from supabase_migrations.schema_migrations where version = '295';
-- The push material secrets, if loaded, are removed by hand:
--   delete from vault.secrets where name like 'twilio\_push\_%';

begin;

set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.twilio_accounts') is null
     or to_regprocedure('public.twilio_account_creds(text, text)') is null
     or to_regprocedure('public.twilio_account_secret_put(text, text, text)') is null then
    raise exception '295: twilio_accounts and its functions are missing (migration 292 not applied?)';
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regclass('vault.secrets') is null then
    raise exception '295: Supabase Vault is not available (vault.secrets / decrypted_secrets)';
  end if;
end
$pre$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — push_skipped
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.twilio_accounts add column if not exists push_skipped text[];

do $col$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.twilio_accounts'::regclass
                  and conname = 'twilio_accounts_push_skipped_chk') then
    alter table public.twilio_accounts add constraint twilio_accounts_push_skipped_chk
      check (push_skipped is null or push_skipped <@ array['apns_dev', 'apns_prod', 'fcm']::text[]);
  end if;
end
$col$;

comment on column public.twilio_accounts.push_skipped is
  'Migration 295: the push credential kinds (apns_dev, apns_prod, fcm) provisioning skipped because twilio_push_material() had no material for them. NULL = none skipped.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — twilio_push_material()
-- ═════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.twilio_push_material()
returns table (kind text, certificate text, private_key text, secret text)
language sql
stable
security definer
set search_path to ''
as $fn$
  -- ⚠️ FIVE FIXED NAMES. Nothing the caller sends can name another Vault secret.
  with s as (
    select d.name, nullif(btrim(d.decrypted_secret), '') as v
      from vault.decrypted_secrets d
     where d.name in ('twilio_push_apns_dev_certificate', 'twilio_push_apns_dev_private_key',
                      'twilio_push_apns_prod_certificate', 'twilio_push_apns_prod_private_key',
                      'twilio_push_fcm_secret')
  )
  select 'apns_dev'::text,
         (select v from s where name = 'twilio_push_apns_dev_certificate' limit 1),
         (select v from s where name = 'twilio_push_apns_dev_private_key' limit 1),
         null::text
  union all
  select 'apns_prod'::text,
         (select v from s where name = 'twilio_push_apns_prod_certificate' limit 1),
         (select v from s where name = 'twilio_push_apns_prod_private_key' limit 1),
         null::text
  union all
  select 'fcm'::text, null::text, null::text,
         (select v from s where name = 'twilio_push_fcm_secret' limit 1);
$fn$;

comment on function public.twilio_push_material() is
  'Migration 295: the push credential material for a new Twilio sub-account, read from five fixed Vault names (twilio_push_apns_dev_certificate / _private_key, twilio_push_apns_prod_certificate / _private_key, twilio_push_fcm_secret). Three rows: apns_dev, apns_prod, fcm; NULL where missing. Service role only.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — twilio_account_forget(p_client_id)
-- ═════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.twilio_account_forget(p_client_id text)
returns text
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_row public.twilio_accounts%rowtype;
begin
  select a.* into v_row from public.twilio_accounts a where a.client_id = p_client_id for update;
  if not found then
    return 'none';
  end if;
  if v_row.kind = 'parent' then
    delete from public.twilio_accounts where client_id = p_client_id;
    return 'parent_pin';
  end if;
  if v_row.account_sid is null and v_row.status in ('provisioning', 'failed') then
    delete from public.twilio_accounts where client_id = p_client_id;
    return 'never_created';
  end if;
  if v_row.status <> 'closed' then
    raise exception using errcode = '55000',
      message = format('twilio_account_forget: %s''s sub-account is %s; close it at Twilio first', p_client_id, v_row.status);
  end if;
  -- ⚠️ BY NAME ONLY (292's rule): the id columns are writable by the service role, so an id could
  -- point at any secret. Only the two secrets named for this row's own SID are removed.
  delete from vault.secrets s
   where s.name in ('twilio_auth_token_' || v_row.account_sid, 'twilio_api_secret_' || v_row.account_sid);
  delete from public.twilio_accounts where client_id = p_client_id;
  return 'closed_sub';
end;
$fn$;

comment on function public.twilio_account_forget(text) is
  'Migration 295: remove a tenant''s twilio_accounts row (a parent pin, a sub never created, or a sub Twilio has closed, with its two Vault secrets by name). Refuses a live or suspended sub. Service role only.';

revoke all on function public.twilio_push_material() from public, anon, authenticated;
revoke all on function public.twilio_account_forget(text) from public, anon, authenticated;
grant execute on function public.twilio_push_material() to service_role;
grant execute on function public.twilio_account_forget(text) to service_role;

-- ── CHECKS ────────────────────────────────────────────────────────────────────────────────
do $check$
declare
  v_fn    text;
  v_role  text;
  v_cnt   bigint;
  v_probe constant text := 'm295-rehearsal';
  v_sid   constant text := 'AC' || repeat('e', 32);
  v_out   text;
  v_got   text;
begin
  foreach v_fn in array array['public.twilio_push_material()', 'public.twilio_account_forget(text)'] loop
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = to_regprocedure(v_fn)
                     and p.prosecdef and 'search_path=""' = any(coalesce(p.proconfig, '{}'::text[]))) then
      raise exception '295: % is not SECURITY DEFINER with an empty search_path', v_fn;
    end if;
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_fn, 'EXECUTE') then
        raise exception '295: % may execute %', v_role, v_fn;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception '295: service_role may not execute %', v_fn;
    end if;
  end loop;

  select count(*) into v_cnt from public.twilio_push_material();
  if v_cnt <> 3 then
    raise exception '295: twilio_push_material() returned % row(s), not 3', v_cnt;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.twilio_accounts'::regclass
                  and conname = 'twilio_accounts_push_skipped_chk') then
    raise exception '295: twilio_accounts.push_skipped has no check on its values';
  end if;

  -- ── The rehearsal: forget refuses a live sub, removes a closed one with its secrets ──
  if exists (select 1 from public.twilio_accounts where client_id = v_probe or account_sid = v_sid) then
    raise exception '295: a twilio_accounts row for the rehearsal already exists; it will not be touched';
  end if;
  begin
    insert into public.twilio_accounts (client_id, kind, account_sid, status) values (v_probe, 'sub', v_sid, 'active');
    perform public.twilio_account_secret_put(v_probe, 'auth_token', 'm295rehearsaltoken' || repeat('a', 14));
    begin
      perform public.twilio_account_forget(v_probe);
      raise exception '295: twilio_account_forget removed a live sub-account';
    exception when object_not_in_prerequisite_state then null;
    end;
    update public.twilio_accounts set status = 'closed' where client_id = v_probe;
    v_got := public.twilio_account_forget(v_probe);
    if v_got is distinct from 'closed_sub'
       or exists (select 1 from public.twilio_accounts where client_id = v_probe)
       or exists (select 1 from vault.secrets s where s.name = 'twilio_auth_token_' || v_sid) then
      raise exception '295: twilio_account_forget did not remove a closed sub and its secret (%)', v_got;
    end if;
    if public.twilio_account_forget(v_probe) is distinct from 'none' then
      raise exception '295: twilio_account_forget of nothing did not answer none';
    end if;
    v_out := 'a live sub refused, a closed sub removed with its secret, nothing answered none';
    raise exception using errcode = 'S2950', message = v_out;
  exception when sqlstate 'S2950' then
    v_out := sqlerrm;
  end;
  if exists (select 1 from public.twilio_accounts where client_id = v_probe)
     or exists (select 1 from vault.secrets s where s.name = 'twilio_auth_token_' || v_sid) then
    raise exception '295: the rehearsal left something behind';
  end if;
  if v_out is null or v_out not like 'a live sub refused%' then
    raise exception '295: the rehearsal did not run to its end';
  end if;
  perform set_config('ss.m295_rehearsal', v_out, true);
  raise notice '295: checks hold';
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD ────────────────────────────────────────────────────────────────────────────
-- PASS is: functions_ready true, column_added true, material_rows 3, material_loaded = how many of
-- the three kinds Vault has complete material for (0 until Ahsan loads it; provisioning then
-- skips push and says so), rehearsal 'a live sub refused, a closed sub removed with its secret,
-- nothing answered none'.
select
  '295' as migration,
  (has_function_privilege('service_role', 'public.twilio_push_material()', 'EXECUTE')
     and has_function_privilege('service_role', 'public.twilio_account_forget(text)', 'EXECUTE')
     and not has_function_privilege('anon', 'public.twilio_push_material()', 'EXECUTE')
     and not has_function_privilege('authenticated', 'public.twilio_push_material()', 'EXECUTE')
     and not has_function_privilege('anon', 'public.twilio_account_forget(text)', 'EXECUTE')
     and not has_function_privilege('authenticated', 'public.twilio_account_forget(text)', 'EXECUTE')) as functions_ready,
  exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'twilio_accounts'
            and c.column_name = 'push_skipped') as column_added,
  (select count(*) from public.twilio_push_material())::int as material_rows,
  (select count(*) from public.twilio_push_material() m
    where (m.kind <> 'fcm' and m.certificate is not null and m.private_key is not null)
       or (m.kind = 'fcm' and m.secret is not null))::int as material_loaded,
  current_setting('ss.m295_rehearsal', true) as rehearsal;

commit;
