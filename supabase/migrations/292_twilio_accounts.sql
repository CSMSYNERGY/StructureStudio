-- 292_twilio_accounts.sql — which Twilio account each business's texting and calling live in
-- (Workstream 2, phase 1: one Twilio sub-account per builder, ISV architecture #1).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file` or an inline "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('292', '292_twilio_accounts') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Written 2026-10-09 against origin/beta d118eb2e, where 289 is the newest file; 290 and 291 are
-- expected to be taken by the sibling batches of the same plan (company tax, payments, projects).
-- Read the live ledger first and take the next free number, renaming this file, its test
-- (tests/sql/migration292.test.cjs) and every '292' below together:
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 5;
-- Record the ledger row with `returning`: no row back means the number was taken, so rename.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Today every Twilio call uses ONE account (the parent) through the edge and Worker environment.
-- Carolyn, 2026-10-08: getting a number should give the builder their own account ("I don't want
-- them under my business name"). So each builder other than the platform's own gets a Twilio
-- sub-account, billed to the parent. Its SID, its secrets and the resources made inside it have to
-- live somewhere the code can find them per tenant: this table.
--
-- Stays on the parent, always: structure-studio (the pilot number, the primary profile, its own
-- brand), Verify, the setup-test app and NTS. A tenant with no row here IS on the parent, so no
-- pin rows are written and no tenant is named in this file (the repository is public).
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   * public.twilio_accounts, one row per tenant (client_id, plain text, NO foreign key: admin-
--     catalog's delete_client deletes client_configs last, after wiping everything else, and an FK
--     here would fail that last step and leave a half-deleted tenant; the repo's convention, as in
--     165's sms_registrations).
--       kind      'parent' | 'sub'. THE PARENT IS ENCODED ONE WAY ONLY: a NULL account_sid (a
--                 parent row never names the parent's SID, which lives in the edge environment).
--       status    provisioning | active | suspended | closed | failed. Only 'active' is used.
--       secrets   api_secret_id / auth_token_id are VAULT SECRET IDS, never the values. They are
--                 written only by twilio_account_secret_put below.
--       the rest  the SIDs provisioning makes inside the sub (API key, TwiML App, push
--                 credentials, Event Streams sink and subscription), the provisioning step and
--                 lock, and last_error (codes only, capped).
--   * twilio_account_sid on sms_registrations and sms_numbers, and account_sid on
--     twilio_usage_daily: which account a registration, a number or a usage row lives in. NULL =
--     the parent, the only encoding; every row today is NULL. twilio_usage_daily KEEPS its
--     primary key (day, category): the live Worker upserts on it (usageCharge.ts onConflict
--     "day,category"), and phase 7 swaps it in the order the plan gives.
--   * Two SECURITY DEFINER functions, search_path '', service role only:
--       twilio_account_secret_put(p_client_id, p_kind 'auth_token' | 'api_secret', p_secret)
--         stores a sub's secret in Vault (vault.create_secret, or vault.update_secret when the row
--         already points at one) and writes its id on the row. New code: 256 only ever created
--         its one secret by hand and read it in a definer.
--       twilio_account_creds(p_client_id, p_account_sid): exactly one of the two. One row (or
--         none): the account's SIDs and status with its two secrets decrypted. What the edge
--         resolver (_shared/twilioAccount.ts) calls, and only while TWILIO_SUBACCOUNTS is "on".
--   * RLS ENABLED, NOT FORCED (FORCE applies RLS to the table owner too, and the definer
--     functions would then read no rows: 154, 188 and 193 each assert it off), no policies, and
--     every privilege revoked from public, anon and authenticated.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────
--   * NOTHING CHANGES FOR ANY TENANT. The table starts empty; the resolver never reads it while
--     the edge secret / Worker var TWILIO_SUBACCOUNTS is anything but "on" (off by default), and
--     with it on, no row still means the parent.
--   * Creates no sub-account and no Vault secret (phase 3 does, behind the same switch).
--   * Does not touch delete_client: a row left behind by a deleted tenant is inert (phase 9 makes
--     delete_client close the sub first).
--   * Does not change twilio_usage_daily's key, or any existing row anywhere.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. ADD COLUMN with no default and a CHECK on a brand-new
-- all-NULL column are catalog changes plus one quick scan, under a brief ACCESS EXCLUSIVE lock on
-- sms_registrations, sms_numbers (read by every text sent and received) and twilio_usage_daily;
-- lock_timeout makes a hung apply give up instead of queueing texts behind it. Retry it.
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- Any time: inert until TWILIO_SUBACCOUNTS is "on", and the phase 2 code that reads it only does
-- so then. It must be applied BEFORE the switch goes on (with the switch on and no table, every
-- sub lookup fails closed and that tenant's Twilio work stops).
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Turn TWILIO_SUBACCOUNTS off first (edge secret and Worker var). ⛔ Never while a row of kind
-- 'sub' still has numbers: its SID is the only record of where they are. With no sub rows:
--   delete from vault.secrets where id in (select api_secret_id from public.twilio_accounts where api_secret_id is not null
--                                         union select auth_token_id from public.twilio_accounts where auth_token_id is not null);
--   drop function if exists public.twilio_account_creds(text, text);
--   drop function if exists public.twilio_account_secret_put(text, text, text);
--   drop table if exists public.twilio_accounts;
--   alter table public.sms_registrations drop column if exists twilio_account_sid;
--   alter table public.sms_numbers drop column if exists twilio_account_sid;
--   alter table public.twilio_usage_daily drop column if exists account_sid;
--   delete from supabase_migrations.schema_migrations where version = '292';

begin;

-- sms_numbers and sms_registrations are read on every text; a hung apply must give up rather than
-- sit in front of them.
set local lock_timeout = '5s';

-- What must already be here: the three tables this extends (165, 259) and Vault's own API, which
-- the put function calls by these exact signatures.
do $pre$
begin
  if to_regclass('public.sms_registrations') is null or to_regclass('public.sms_numbers') is null then
    raise exception '292: sms_registrations / sms_numbers are missing (migration 165 not applied?)';
  end if;
  if to_regclass('public.twilio_usage_daily') is null then
    raise exception '292: twilio_usage_daily is missing (migration 259 not applied?)';
  end if;
  if to_regprocedure('vault.create_secret(text, text, text, uuid)') is null
     or to_regprocedure('vault.update_secret(uuid, text, text, text, uuid)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise exception '292: Supabase Vault is not available (vault.create_secret / update_secret / decrypted_secrets)';
  end if;
end
$pre$;

-- Every existing row's Twilio-relevant columns BEFORE anything here runs, so the checks can prove
-- nothing moved.
create temp table m292_before on commit drop as
  select 'sms_registrations' as t, count(*)::bigint as n from public.sms_registrations
  union all select 'sms_numbers', count(*) from public.sms_numbers
  union all select 'twilio_usage_daily', count(*) from public.twilio_usage_daily;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — twilio_accounts
-- ═════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.twilio_accounts (
  client_id               text primary key,
  kind                    text not null,
  -- AC… of the sub-account. NULL = the parent, and ONLY the parent (twilio_accounts_parent_chk).
  account_sid             text,
  status                  text not null default 'provisioning',
  -- SK… of the Standard API key made inside the sub; its secret is in Vault (api_secret_id).
  api_key_sid             text,
  api_secret_id           uuid,
  -- The sub's auth token, in Vault: it signs every webhook the sub sends.
  auth_token_id           uuid,
  twiml_app_sid           text,
  push_apns_dev_sid       text,
  push_apns_prod_sid      text,
  push_fcm_sid            text,
  events_sink_sid         text,
  events_subscription_sid text,
  provision_step          text,
  provision_lock_until    timestamptz,
  -- Codes only (a Twilio code, our step name). Never a Twilio message body: those echo what was
  -- submitted.
  last_error              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- admin-catalog create_client's own slug rule.
  constraint twilio_accounts_client_id_chk check (client_id ~ '^[a-z0-9][a-z0-9-]*$'),
  constraint twilio_accounts_kind_chk check (kind in ('parent', 'sub')),
  constraint twilio_accounts_status_chk check (status in ('provisioning', 'active', 'suspended', 'closed', 'failed')),
  constraint twilio_accounts_account_sid_key unique (account_sid),
  constraint twilio_accounts_account_sid_chk check (account_sid is null or account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  -- The parent has no SID here, no secrets here and nothing provisioned here: all of that is the
  -- edge and Worker environment. A sub has its SID from the moment it is past provisioning.
  constraint twilio_accounts_parent_chk check (
    case when kind = 'parent'
      then account_sid is null and api_key_sid is null and api_secret_id is null and auth_token_id is null
           and twiml_app_sid is null and events_sink_sid is null and events_subscription_sid is null
      else account_sid is not null or status in ('provisioning', 'failed')
    end),
  constraint twilio_accounts_api_key_sid_chk check (api_key_sid is null or api_key_sid ~ '^SK[0-9a-fA-F]{32}$'),
  constraint twilio_accounts_twiml_app_sid_chk check (twiml_app_sid is null or twiml_app_sid ~ '^AP[0-9a-fA-F]{32}$'),
  constraint twilio_accounts_push_chk check (
    (push_apns_dev_sid is null or push_apns_dev_sid ~ '^CR[0-9a-fA-F]{32}$')
    and (push_apns_prod_sid is null or push_apns_prod_sid ~ '^CR[0-9a-fA-F]{32}$')
    and (push_fcm_sid is null or push_fcm_sid ~ '^CR[0-9a-fA-F]{32}$')),
  constraint twilio_accounts_events_chk check (
    (events_sink_sid is null or events_sink_sid ~ '^DG[0-9a-fA-F]{32}$')
    and (events_subscription_sid is null or events_subscription_sid ~ '^DF[0-9a-fA-F]{32}$')),
  constraint twilio_accounts_step_chk check (provision_step is null or char_length(provision_step) between 1 and 64),
  constraint twilio_accounts_last_error_chk check (last_error is null or char_length(last_error) <= 200)
);

comment on table public.twilio_accounts is
  'Migration 292. Which Twilio account each tenant''s texting and calling live in. No row, or kind '
  '''parent'' (account_sid NULL), = the parent account in the edge/Worker environment. kind ''sub'' '
  '= the tenant''s own sub-account: its SIDs here, its auth token and API key secret in Vault '
  '(auth_token_id / api_secret_id, written only by twilio_account_secret_put). Read only through '
  'twilio_account_creds, and only while TWILIO_SUBACCOUNTS is "on". Service role only.';

-- Enabled, NOT forced (see the header), no policies: the service role is BYPASSRLS, the browser
-- roles hold nothing.
alter table public.twilio_accounts enable row level security;
alter table public.twilio_accounts no force row level security;
revoke all on public.twilio_accounts from public;
revoke all on public.twilio_accounts from anon, authenticated;
grant select, insert, update, delete on public.twilio_accounts to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — which account a registration, a number and a usage row live in (NULL = parent)
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.sms_registrations add column if not exists twilio_account_sid text;
alter table public.sms_numbers       add column if not exists twilio_account_sid text;
alter table public.twilio_usage_daily add column if not exists account_sid text;

do $cols$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.sms_registrations'::regclass
                  and conname = 'sms_registrations_twilio_account_sid_chk') then
    alter table public.sms_registrations add constraint sms_registrations_twilio_account_sid_chk
      check (twilio_account_sid is null or twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.sms_numbers'::regclass
                  and conname = 'sms_numbers_twilio_account_sid_chk') then
    alter table public.sms_numbers add constraint sms_numbers_twilio_account_sid_chk
      check (twilio_account_sid is null or twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.twilio_usage_daily'::regclass
                  and conname = 'twilio_usage_daily_account_sid_chk') then
    alter table public.twilio_usage_daily add constraint twilio_usage_daily_account_sid_chk
      check (account_sid is null or account_sid ~ '^AC[0-9a-fA-F]{32}$');
  end if;
end
$cols$;

comment on column public.sms_registrations.twilio_account_sid is
  'Migration 292: the Twilio sub-account (AC…) this registration''s profile, brand, Messaging Service and campaign live in. NULL = the parent account.';
comment on column public.sms_numbers.twilio_account_sid is
  'Migration 292: the Twilio sub-account (AC…) this number lives in. NULL = the parent account.';
comment on column public.twilio_usage_daily.account_sid is
  'Migration 292: the Twilio account this usage row is for. NULL = the parent. The primary key is still (day, category) until phase 7.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — the two definer functions
-- ═════════════════════════════════════════════════════════════════════════════════════════

-- Store one of a sub-account's two secrets in Vault and point its row at it. Refused for the
-- parent (its secrets are the environment's), for a row with no SID yet (the Vault name carries
-- the SID, so a deleted and re-created slug can never collide with an old secret), and for
-- anything that is not a plain Twilio secret. Re-putting a secret replaces it in place (a rotated
-- auth token); a secret already in Vault under this account's name is adopted, not duplicated.
create or replace function public.twilio_account_secret_put(p_client_id text, p_kind text, p_secret text)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_row  public.twilio_accounts%rowtype;
  v_id   uuid;
  v_name text;
begin
  if p_kind is null or p_kind not in ('auth_token', 'api_secret') then
    raise exception using errcode = '22023', message = 'twilio_account_secret_put: p_kind must be auth_token or api_secret';
  end if;
  if p_secret is null or p_secret !~ '^[A-Za-z0-9]{16,128}$' then
    raise exception using errcode = '22023', message = 'twilio_account_secret_put: p_secret is not a Twilio secret';
  end if;

  select a.* into v_row from public.twilio_accounts a where a.client_id = p_client_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'twilio_account_secret_put: no twilio_accounts row for this tenant';
  end if;
  if v_row.kind <> 'sub' then
    raise exception using errcode = '22023', message = 'twilio_account_secret_put: the parent account''s secrets live in the environment, not Vault';
  end if;
  if v_row.account_sid is null then
    raise exception using errcode = '22023', message = 'twilio_account_secret_put: write the sub-account''s SID before its secrets';
  end if;

  v_name := 'twilio_' || p_kind || '_' || v_row.account_sid;
  v_id := case p_kind when 'auth_token' then v_row.auth_token_id else v_row.api_secret_id end;
  if v_id is not null and not exists (select 1 from vault.decrypted_secrets s where s.id = v_id) then
    v_id := null;
  end if;
  if v_id is null then
    select s.id into v_id from vault.decrypted_secrets s where s.name = v_name limit 1;
  end if;

  if v_id is null then
    v_id := vault.create_secret(p_secret, v_name, 'Twilio sub-account ' || p_kind || ' (migration 292)', null);
  else
    perform vault.update_secret(v_id, p_secret, null, null, null);
  end if;

  if p_kind = 'auth_token' then
    update public.twilio_accounts set auth_token_id = v_id, updated_at = now() where client_id = p_client_id;
  else
    update public.twilio_accounts set api_secret_id = v_id, updated_at = now() where client_id = p_client_id;
  end if;
end;
$fn$;

comment on function public.twilio_account_secret_put(text, text, text) is
  'Migration 292: store a Twilio sub-account''s auth_token or api_secret in Vault and write its id on twilio_accounts. Sub rows with a SID only. Service role only.';

-- One account's SIDs, status and decrypted secrets, by tenant OR by account SID (exactly one).
-- No row = no twilio_accounts row matched (the caller treats a tenant with none as the parent).
create or replace function public.twilio_account_creds(p_client_id text default null, p_account_sid text default null)
returns table (
  client_id          text,
  kind               text,
  account_sid        text,
  status             text,
  api_key_sid        text,
  api_secret         text,
  auth_token         text,
  twiml_app_sid      text,
  push_apns_dev_sid  text,
  push_apns_prod_sid text,
  push_fcm_sid       text
)
language plpgsql
stable
security definer
set search_path to ''
as $fn$
begin
  if (p_client_id is null) = (p_account_sid is null) then
    raise exception using errcode = '22023', message = 'twilio_account_creds: pass exactly one of p_client_id or p_account_sid';
  end if;
  return query
    select a.client_id, a.kind, a.account_sid, a.status, a.api_key_sid,
           (select s.decrypted_secret from vault.decrypted_secrets s where s.id = a.api_secret_id)::text,
           (select s.decrypted_secret from vault.decrypted_secrets s where s.id = a.auth_token_id)::text,
           a.twiml_app_sid, a.push_apns_dev_sid, a.push_apns_prod_sid, a.push_fcm_sid
      from public.twilio_accounts a
     where (p_client_id is not null and a.client_id = p_client_id)
        or (p_account_sid is not null and a.account_sid = p_account_sid)
     limit 1;
end;
$fn$;

comment on function public.twilio_account_creds(text, text) is
  'Migration 292: one tenant''s Twilio account (by p_client_id or p_account_sid, exactly one) with its auth token and API key secret decrypted from Vault. Service role only.';

-- The live default ACLs grant every new function to the browser roles until revoked.
revoke all on function public.twilio_account_secret_put(text, text, text) from public, anon, authenticated;
revoke all on function public.twilio_account_creds(text, text) from public, anon, authenticated;
grant execute on function public.twilio_account_secret_put(text, text, text) to service_role;
grant execute on function public.twilio_account_creds(text, text) to service_role;

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
do $check$
declare
  v_role  text;
  v_priv  text;
  v_fn    text;
  v_cnt   bigint;
  v_t     text;
  v_pk    text;
  v_probe constant text := 'm292-rehearsal';
  v_sid   constant text := 'AC' || repeat('f', 32);
  v_tok1  constant text := 'm292rehearsaltoken' || repeat('a', 14);
  v_tok2  constant text := 'm292rehearsaltoken' || repeat('b', 14);
  v_key   constant text := 'm292rehearsalsecret' || repeat('c', 13);
  v_got   record;
  v_ids   uuid[];
  v_out   text;
begin
  -- ── The table: RLS on, NOT forced, no policy, nothing for the browser roles ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.twilio_accounts'::regclass) then
    raise exception '292: RLS is off on twilio_accounts';
  end if;
  if (select c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = 'public.twilio_accounts'::regclass) then
    raise exception '292: twilio_accounts has FORCE ROW LEVEL SECURITY; the definer functions would read nothing';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.twilio_accounts'::regclass) then
    raise exception '292: twilio_accounts has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(v_role, 'public.twilio_accounts', v_priv) then
        raise exception '292: % holds % on twilio_accounts', v_role, v_priv;
      end if;
    end loop;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
      if has_any_column_privilege(v_role, 'public.twilio_accounts', v_priv) then
        raise exception '292: % holds column-level % on twilio_accounts', v_role, v_priv;
      end if;
    end loop;
  end loop;
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if not has_table_privilege('service_role', 'public.twilio_accounts', v_priv) then
      raise exception '292: service_role lacks % on twilio_accounts', v_priv;
    end if;
  end loop;

  -- ── The functions: definer, empty search_path, service role only ──
  foreach v_fn in array array['public.twilio_account_secret_put(text, text, text)', 'public.twilio_account_creds(text, text)'] loop
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = to_regprocedure(v_fn)
                     and p.prosecdef and 'search_path=""' = any(coalesce(p.proconfig, '{}'::text[]))) then
      raise exception '292: % is not SECURITY DEFINER with an empty search_path', v_fn;
    end if;
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_fn, 'EXECUTE') then
        raise exception '292: % may execute %', v_role, v_fn;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception '292: service_role may not execute %', v_fn;
    end if;
  end loop;

  -- ── The three new columns: nullable text, no default, every row NULL (the parent) ──
  foreach v_t in array array['sms_registrations.twilio_account_sid', 'sms_numbers.twilio_account_sid', 'twilio_usage_daily.account_sid'] loop
    if not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = split_part(v_t, '.', 1)
                      and c.column_name = split_part(v_t, '.', 2)
                      and c.data_type = 'text' and c.is_nullable = 'YES' and c.column_default is null) then
      raise exception '292: % should be nullable text with no default', v_t;
    end if;
    execute format('select count(*) from public.%I where %I is not null', split_part(v_t, '.', 1), split_part(v_t, '.', 2)) into v_cnt;
    if v_cnt <> 0 then
      raise exception '292: % has % non-NULL row(s); every existing row is on the parent', v_t, v_cnt;
    end if;
  end loop;
  if exists (select 1 from m292_before b
              where b.n <> case b.t when 'sms_registrations' then (select count(*) from public.sms_registrations)
                                    when 'sms_numbers' then (select count(*) from public.sms_numbers)
                                    else (select count(*) from public.twilio_usage_daily) end) then
    raise exception '292: a row count moved during the apply — run it again';
  end if;

  -- ── twilio_usage_daily keeps (day, category): the live Worker upserts on it ──
  select string_agg(a.attname, ',' order by k.ord) into v_pk
    from pg_catalog.pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'public.twilio_usage_daily'::regclass and c.contype = 'p';
  if v_pk is distinct from 'day,category' then
    raise exception '292: twilio_usage_daily''s primary key should still be (day, category), is (%)', coalesce(v_pk, 'none');
  end if;

  -- ── The rehearsal: a made-up sub row, both secrets through Vault and back, then rolled back ──
  -- A sub-block whose own exception is its rollback: the row and the Vault secrets are undone and
  -- only the answer (a plain variable) survives it.
  if exists (select 1 from public.twilio_accounts where client_id = v_probe or account_sid = v_sid) then
    raise exception '292: a twilio_accounts row for the rehearsal already exists; it will not be touched';
  end if;
  begin
    -- The parent is NULL only: a parent row with a SID, or a sub past provisioning without one, is refused.
    begin
      insert into public.twilio_accounts (client_id, kind, account_sid, status) values (v_probe, 'parent', v_sid, 'active');
      raise exception '292: a parent row with an account SID was accepted';
    exception when check_violation then null;
    end;
    begin
      insert into public.twilio_accounts (client_id, kind, status) values (v_probe, 'sub', 'active');
      raise exception '292: an active sub row with no account SID was accepted';
    exception when check_violation then null;
    end;

    insert into public.twilio_accounts (client_id, kind, account_sid, status, api_key_sid)
      values (v_probe, 'sub', v_sid, 'active', 'SK' || repeat('e', 32));
    perform public.twilio_account_secret_put(v_probe, 'auth_token', v_tok1);
    perform public.twilio_account_secret_put(v_probe, 'api_secret', v_key);
    -- Re-put: replaced in place, never a second secret.
    select array[a.auth_token_id, a.api_secret_id] into v_ids from public.twilio_accounts a where a.client_id = v_probe;
    perform public.twilio_account_secret_put(v_probe, 'auth_token', v_tok2);
    if (select a.auth_token_id from public.twilio_accounts a where a.client_id = v_probe) is distinct from v_ids[1] then
      raise exception '292: re-putting the auth token made a second Vault secret';
    end if;

    select * into v_got from public.twilio_account_creds(p_account_sid := v_sid);
    if v_got.client_id is distinct from v_probe or v_got.auth_token is distinct from v_tok2
       or v_got.api_secret is distinct from v_key or v_got.status is distinct from 'active' then
      raise exception '292: twilio_account_creds by SID did not give back what was put';
    end if;
    select * into v_got from public.twilio_account_creds(p_client_id := v_probe);
    if v_got.account_sid is distinct from v_sid or v_got.auth_token is distinct from v_tok2 then
      raise exception '292: twilio_account_creds by tenant did not give back what was put';
    end if;
    begin
      perform public.twilio_account_creds(v_probe, v_sid);
      raise exception '292: twilio_account_creds accepted both arguments';
    exception when invalid_parameter_value then null;
    end;
    v_out := 'secrets stored, replaced in place and read back by tenant and by SID; parent-with-SID and active-without-SID refused';
    raise exception using errcode = 'S2920', message = v_out;
  exception when sqlstate 'S2920' then
    v_out := sqlerrm;
  end;
  if exists (select 1 from public.twilio_accounts where client_id = v_probe)
     or exists (select 1 from vault.decrypted_secrets s where s.name = 'twilio_auth_token_' || v_sid or s.name = 'twilio_api_secret_' || v_sid) then
    raise exception '292: the rehearsal left something behind';
  end if;
  if v_out is null or v_out not like 'secrets stored%' then
    raise exception '292: the rehearsal did not run to its end';
  end if;
  perform set_config('ss.m292_rehearsal', v_out, true);

  raise notice '292: checks hold; twilio_accounts is empty and every existing row is on the parent';
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so a dry run (last `commit;` swapped for `rollback;`) prints the same row and
-- leaves nothing behind. PASS is all of these, none of which drifts with live data:
--   table_ready true, functions_ready true, accounts 0, columns_added 3, rows_not_parent 0,
--   usage_pk 'day,category',
--   rehearsal 'secrets stored, replaced in place and read back by tenant and by SID; parent-with-SID
--     and active-without-SID refused'
-- Anything else: roll back (see ROLLBACK above) before recording the ledger row.
select
  '292' as migration,
  ((select c.relrowsecurity and not c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = 'public.twilio_accounts'::regclass)
     and not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.twilio_accounts'::regclass)
     and not has_table_privilege('anon', 'public.twilio_accounts', 'SELECT')
     and not has_table_privilege('authenticated', 'public.twilio_accounts', 'SELECT')) as table_ready,
  (has_function_privilege('service_role', 'public.twilio_account_creds(text, text)', 'EXECUTE')
     and has_function_privilege('service_role', 'public.twilio_account_secret_put(text, text, text)', 'EXECUTE')
     and not has_function_privilege('anon', 'public.twilio_account_creds(text, text)', 'EXECUTE')
     and not has_function_privilege('authenticated', 'public.twilio_account_creds(text, text)', 'EXECUTE')
     and not has_function_privilege('anon', 'public.twilio_account_secret_put(text, text, text)', 'EXECUTE')
     and not has_function_privilege('authenticated', 'public.twilio_account_secret_put(text, text, text)', 'EXECUTE')) as functions_ready,
  (select count(*) from public.twilio_accounts)::int as accounts,
  (select count(*) from information_schema.columns c where c.table_schema = 'public'
     and ((c.table_name in ('sms_registrations', 'sms_numbers') and c.column_name = 'twilio_account_sid')
       or (c.table_name = 'twilio_usage_daily' and c.column_name = 'account_sid')))::int as columns_added,
  ((select count(*) from public.sms_registrations where twilio_account_sid is not null)
     + (select count(*) from public.sms_numbers where twilio_account_sid is not null)
     + (select count(*) from public.twilio_usage_daily where account_sid is not null))::int as rows_not_parent,
  (select string_agg(a.attname, ',' order by k.ord)
     from pg_catalog.pg_constraint c
     cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
     join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.conrelid = 'public.twilio_usage_daily'::regclass and c.contype = 'p') as usage_pk,
  current_setting('ss.m292_rehearsal', true) as rehearsal;

commit;

-- After this: nothing has changed for any tenant. The table waits for phase 3's provisioning, and
-- the code reads it only once TWILIO_SUBACCOUNTS is "on".
