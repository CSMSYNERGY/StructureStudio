-- 296_cardpointe_env.sql — test or live, per builder: which of Fiserv's two systems a builder takes
-- cards on, and which one each charge attempt went to.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, and only once Ahsan says go. Run it with
--      supabase db query --linked --file supabase/migrations/296_cardpointe_env.sql
--    then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('296', '296_cardpointe_env') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. ⛔ HARD STOP: `--file` has been seen to
--    auth-fail, retry and still exit 0 (232's header), so the exit code proves nothing.
--    NO RECORD ROW PRINTED MEANS THE FILE DID NOT RUN: do not record the ledger row, read the
--    columns back (VERIFY, below) and find out why. To see the same row and change nothing, run it
--    with the last `commit;` swapped for `rollback;` (a dry run) first.
--
-- ── NUMBERING: 296 IS TENTATIVE ──────────────────────────────────────────────────────────
-- Written 2026-10-09 on a branch off beta, where 291 and 294 are the newest files; 292, 293 and 295
-- are held by sibling branches (288 is missing from the ledger: do not reuse it). THE GATE IS THE
-- LEDGER READ, RIGHT BEFORE THE APPLY:
--   select version, name from supabase_migrations.schema_migrations order by 1 desc limit 5;
-- If 296 is there, rename the file (and every '296' in it, and its test) to the next free number and
-- read the ledger again before running anything. The ledger insert cannot be the check: version is
-- the ledger's primary key and the insert has no `on conflict`, so a number claimed in between fails
-- with 23505 AFTER this file has run. Rename and record it under the new number then. Never add
-- `on conflict do nothing`: it answers no row, and the SQL is live with no ledger row of its own.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Workstream 1 phase 3 (Fiserv certification). Every CardPointe call used ONE set of secrets
-- (CARDPOINTE_*), which point at Fiserv's test system (UAT), and a builder with no merchant id fell
-- back to the deployment's own CARDPOINTE_MERCHID. Builders go live one at a time, and the
-- certification tenant has to stay on UAT for regression after they do. So the system becomes a
-- per-builder setting, and each attempt records the system it went to:
--   * client_settings.cardpointe_env: 'uat' (Fiserv's test system, no real money) or 'prod' (live).
--     _shared/cardpointe.ts reads CARDPOINTE_* for 'uat' and the new CARDPOINTE_PROD_* for 'prod',
--     per call; a 'prod' builder with those secrets unset is refused, never sent to UAT. Set only
--     through admin-catalog set_payments, which refuses switching a billable builder on in 'uat'.
--   * payment_attempts.cp_env: the system the sale went to, written with the attempt BEFORE the card
--     is touched. Void, refund, settlestat and the recovery inquire read it back
--     (_shared/invoicePayment.ts merchantOfRecord), so they ask the system that holds the
--     transaction, not the one the builder is on today.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   * client_settings.cardpointe_env text NOT NULL DEFAULT 'uat', with the named CHECK
--     client_settings_cardpointe_env_check (cardpointe_env in ('uat','prod')) and a column comment.
--     ADD COLUMN with a constant default is a catalog change (no rewrite). EVERY EXISTING ROW READS
--     'uat', which is exactly what every builder has been on: the existing secrets ARE the UAT set.
--     No builder is moved to live here; that is an operator's set_payments, one builder at a time.
--   * payment_attempts.cp_env text NULL, no default, with the named CHECK
--     payment_attempts_cp_env_check (cp_env is null or cp_env in ('uat','prod')) and a comment.
--     NULL MEANS 'uat' (review correction 5): every attempt before this file went to the UAT secrets,
--     so there is nothing to back-fill and no row is touched. _shared/paymentSettings.ts cpEnvOf
--     reads NULL as 'uat' and anything it does not know as "no merchant" (refused, never guessed).
--   * Both CHECKs scan their table once to validate (a handful of settings rows, a few hundred
--     attempts at most).
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────
--   * No policy, no grant, no function, no trigger, no index, no get_config splice. Both tables stay
--     service-role only (RLS on, ZERO policies, nothing for anon/authenticated); the checks below
--     prove it, and client_settings keeps FORCE row level security OFF (get_config is SECURITY
--     DEFINER and reads it; with FORCE on every public designer would break: 154 PART 4).
--   * No existing value changes: the checks compare every row, every column, before and after.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database, so both columns are live for both the moment this
-- commits. Functions deployed before this branch never name them. The functions from this branch
-- also work WITHOUT them, so the order between this file and those deploys cannot stop a charge:
-- readPaymentSettings and merchantOfRecord ask again without the column on 42703 and read UAT, and
-- the attempt insert drops cp_env alone on PGRST204 (keeping 291's fields). Still apply this FIRST,
-- so the first attempt after the deploy records its system. Every live writer of client_settings
-- upserts NAMED columns, so nothing production's pages save ever touches cardpointe_env.
-- The file takes EXCLUSIVE on client_settings and then on payment_attempts (reads pass, writes wait
-- the milliseconds it runs), then each ALTER's brief ACCESS EXCLUSIVE. client_settings is read by
-- every estimate and payment_attempts is written by every charge, so lock_timeout makes a hung apply
-- give up instead of queueing them. No live code path holds both tables in one transaction (each
-- PostgREST call is its own), so the fixed order cannot deadlock with one.
-- `notify pgrst` reloads PostgREST's schema cache, or the columns would answer PGRST204 until it
-- next reloaded on its own.
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- Push to beta (Ahsan's go), then this file (a separate go), then the functions (customer-pay,
-- portal-payments, admin-catalog, portal-settings), then the beta pages (admin console, portal).
-- BEFORE the functions: THE RECORD's enabled_without_mid must be 0. The new functions no longer fall
-- back to CARDPOINTE_MERCHID, so a builder switched on with no merchant id of their own stops taking
-- cards the moment they deploy (set their MID with set_payments, or switch them off, first).
--
-- ── VERIFY (read-only) ───────────────────────────────────────────────────────────────────
--   select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
--    where table_schema = 'public' and column_name in ('cardpointe_env', 'cp_env');
--   select cardpointe_env, count(*) from public.client_settings group by 1;
--   select count(*) from public.client_settings
--    where payments_online_enabled and nullif(trim(cardpointe_merchid), '') is null;      -- must be 0
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ ONLY WHILE NO BUILDER IS ON LIVE. Dropping cardpointe_env reads every builder as UAT again, and
-- dropping cp_env reads every attempt as UAT: a live builder's next charge would go to the test
-- system and a live charge's void or refund would be asked of the wrong system (refused there, money
-- untouched, but stuck). First: select count(*) from public.client_settings where cardpointe_env = 'prod';
-- and select count(*) from public.payment_attempts where cp_env = 'prod'; must both be 0 (switch any
-- such builder off and settle their charges first). The functions from this branch stay safe while
-- the columns are gone (they read UAT, as above).
--   alter table public.client_settings drop column if exists cardpointe_env;
--   alter table public.payment_attempts drop column if exists cp_env;
--   notify pgrst, 'reload schema';
--   delete from supabase_migrations.schema_migrations where version = '296';
-- Each CHECK goes with its column.

begin;

-- The ALTERs take ACCESS EXCLUSIVE (brief: catalog changes, plus one validation scan each). A hung
-- apply must give up rather than sit in front of every estimate's settings read and every charge.
set local lock_timeout = '5s';

-- Writes stop HERE, before the snapshots, not at the ALTERs below (281's and 291's order): a save or
-- a charge landing between the snapshot and the checks would otherwise fail the apply at a busy
-- moment. EXCLUSIVE still lets reads through. Held to the commit. Always this order.
lock table public.client_settings in exclusive mode;
lock table public.payment_attempts in exclusive mode;

-- Was each column already here? A re-apply must keep whatever operators have set since.
select set_config('ss.m296_first_env', (not exists (
  select 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'client_settings' and column_name = 'cardpointe_env'
))::text, true);
select set_config('ss.m296_first_cp', (not exists (
  select 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'payment_attempts' and column_name = 'cp_env'
))::text, true);

-- Every row BEFORE anything here runs, whole, as jsonb: the same snapshot works on a first apply (no
-- 296 columns yet) and on a re-apply (columns present, and possibly set since).
create temp table m296_settings_before on commit drop as
  select cs.client_id, to_jsonb(cs) as snap from public.client_settings cs;
create temp table m296_attempts_before on commit drop as
  select pa.id, to_jsonb(pa) as snap from public.payment_attempts pa;

-- ── THE CHANGE ───────────────────────────────────────────────────────────────────────────
alter table public.client_settings
  add column if not exists cardpointe_env text not null default 'uat';
alter table public.payment_attempts
  add column if not exists cp_env text;

-- Named, and added only when missing, so a re-apply neither duplicates nor drops one.
do $add$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'client_settings_cardpointe_env_check'
                    and conrelid = 'public.client_settings'::regclass) then
    alter table public.client_settings
      add constraint client_settings_cardpointe_env_check check (cardpointe_env in ('uat', 'prod'));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'payment_attempts_cp_env_check'
                    and conrelid = 'public.payment_attempts'::regclass) then
    alter table public.payment_attempts
      add constraint payment_attempts_cp_env_check check (cp_env is null or cp_env in ('uat', 'prod'));
  end if;
end
$add$;

comment on column public.client_settings.cardpointe_env is
  'Which of Fiserv''s two CardPointe systems this builder takes cards on: ''uat'' (the test system, '
  'no real money; the CARDPOINTE_* secrets) or ''prod'' (live; the CARDPOINTE_PROD_* secrets). Read '
  'per call by _shared/cardpointe.ts; a ''prod'' builder with those secrets unset is refused, never '
  'sent to uat. Set only through admin-catalog set_payments, which refuses switching a billable '
  'builder on in ''uat''. Default ''uat'': migration 296 left every existing builder there.';
comment on column public.payment_attempts.cp_env is
  'The CardPointe system this attempt went to (''uat'' or ''prod''), written before the card is '
  'touched. NULL = ''uat'': every attempt written before migration 296 went to the CARDPOINTE_* '
  '(UAT) secrets. Void, refund, settlestat and the recovery inquire read it back '
  '(_shared/invoicePayment.ts merchantOfRecord) to ask the system that holds the transaction.';

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
do $check$
declare
  v_first_env constant boolean := current_setting('ss.m296_first_env')::boolean;
  v_first_cp  constant boolean := current_setting('ss.m296_first_cp')::boolean;
  v_col       record;
  v_n         integer;
  v_def       text;
  v_role      text;
  v_priv      text;
  v_tab       text;
  v_colname   text;
  v_probe     constant text := '__m296_rehearsal__';
  v_new       text;
  v_refused   boolean := false;
begin
  -- ── client_settings.cardpointe_env: text, NOT NULL, default 'uat' ──
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'cardpointe_env';
  if v_col.data_type is null then
    raise exception '296: client_settings.cardpointe_env is missing after the ALTER';
  end if;
  if v_col.data_type <> 'text' or v_col.is_nullable <> 'NO' or v_col.column_default is distinct from '''uat''::text' then
    raise exception '296: client_settings.cardpointe_env should be text NOT NULL DEFAULT ''uat'', is % / nullable % / default %',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  end if;

  -- ── payment_attempts.cp_env: text, nullable, no default ──
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'payment_attempts' and c.column_name = 'cp_env';
  if v_col.data_type is null then
    raise exception '296: payment_attempts.cp_env is missing (is migration 174 applied?)';
  end if;
  if v_col.data_type <> 'text' or v_col.is_nullable <> 'YES' or v_col.column_default is not null then
    raise exception '296: payment_attempts.cp_env should be text NULL with no default, is % / nullable % / default %',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  end if;

  -- ── The two CHECKs: present, validated, and naming exactly the two systems ──
  select pg_get_constraintdef(k.oid) into v_def from pg_catalog.pg_constraint k
   where k.conname = 'client_settings_cardpointe_env_check' and k.conrelid = 'public.client_settings'::regclass
     and k.contype = 'c' and k.convalidated;
  if v_def is null or v_def !~ '''uat''' or v_def !~ '''prod''' or v_def ~* 'null' then
    raise exception '296: client_settings_cardpointe_env_check is missing, not validated, or not (uat, prod): %', coalesce(v_def, '(none)');
  end if;
  select pg_get_constraintdef(k.oid) into v_def from pg_catalog.pg_constraint k
   where k.conname = 'payment_attempts_cp_env_check' and k.conrelid = 'public.payment_attempts'::regclass
     and k.contype = 'c' and k.convalidated;
  if v_def is null or v_def !~ '''uat''' or v_def !~ '''prod''' or v_def !~* 'cp_env IS NULL' then
    raise exception '296: payment_attempts_cp_env_check is missing, not validated, or not (null, uat, prod): %', coalesce(v_def, '(none)');
  end if;

  -- ── Which values the columns hold ──
  if v_first_env then
    -- Every existing builder is on 'uat': what every one of them has been on.
    select count(*) into v_n from public.client_settings where cardpointe_env is distinct from 'uat';
    if v_n > 0 then
      raise exception '296: % client_settings row(s) are not ''uat'' on the first apply; no builder may be moved here', v_n;
    end if;
  end if;
  if v_first_cp then
    -- Nothing is back-filled: NULL is 'uat' by rule.
    select count(*) into v_n from public.payment_attempts where cp_env is not null;
    if v_n > 0 then
      raise exception '296: % payment_attempts row(s) were given a cp_env on the first apply; NULL means uat and nothing is back-filled', v_n;
    end if;
  end if;

  -- ── Nothing else moved: every row, every column the snapshot had, and on a re-apply the new
  -- columns too (a column the snapshot did not have may hold only what the first apply gives it) ──
  select count(*) into v_n
    from m296_settings_before b
    left join public.client_settings cs on cs.client_id = b.client_id
   where cs.client_id is null
      or exists (select 1 from jsonb_each(to_jsonb(cs)) e
                  where e.key <> 'cardpointe_env' and e.value is distinct from coalesce(b.snap -> e.key, 'null'::jsonb))
      or (b.snap ? 'cardpointe_env' and to_jsonb(cs.cardpointe_env) is distinct from b.snap -> 'cardpointe_env');
  if v_n > 0 then
    raise exception '296: % client_settings row(s) changed during the apply', v_n;
  end if;
  select count(*) into v_n
    from m296_attempts_before b
    left join public.payment_attempts pa on pa.id = b.id
   where pa.id is null
      or exists (select 1 from jsonb_each(to_jsonb(pa)) e
                  where e.value is distinct from coalesce(b.snap -> e.key, 'null'::jsonb));
  if v_n > 0 then
    raise exception '296: % payment_attempts row(s) changed during the apply', v_n;
  end if;
  if (select count(*) from m296_settings_before) <> (select count(*) from public.client_settings)
     or (select count(*) from m296_attempts_before) <> (select count(*) from public.payment_attempts) then
    raise exception '296: a row count moved during the apply, which the locks above should make impossible; nothing was committed';
  end if;

  -- ── Still service-role only: RLS on, client_settings NOT forced, no policy, nothing for the
  -- browser roles on either new column, everything for service_role ──
  foreach v_tab in array array['client_settings', 'payment_attempts'] loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = ('public.' || v_tab)::regclass) then
      raise exception '296: RLS is off on %', v_tab;
    end if;
    if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = ('public.' || v_tab)::regclass) then
      raise exception '296: % has a policy; it is meant to be service-role only', v_tab;
    end if;
  end loop;
  if (select c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = 'public.client_settings'::regclass) then
    raise exception '296: client_settings has FORCE ROW LEVEL SECURITY on; get_config (SECURITY DEFINER) reads it, so every designer would break. Resolve before applying.';
  end if;
  foreach v_tab in array array['client_settings', 'payment_attempts'] loop
    v_colname := case v_tab when 'client_settings' then 'cardpointe_env' else 'cp_env' end;
    foreach v_role in array array['anon', 'authenticated'] loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
        if has_column_privilege(v_role, 'public.' || v_tab, v_colname, v_priv) then
          raise exception '296: % holds % on %.%', v_role, v_priv, v_tab, v_colname;
        end if;
      end loop;
    end loop;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if not has_column_privilege('service_role', 'public.' || v_tab, v_colname, v_priv) then
        raise exception '296: service_role lacks % on %.% — the payment functions would fall back to UAT for everyone', v_priv, v_tab, v_colname;
      end if;
    end loop;
  end loop;

  -- ── The rehearsal: a brand-new settings row starts 'uat', and a system nobody knows is refused.
  -- Sub-blocks whose own exception is their rollback; only the answers (plain variables) survive.
  if exists (select 1 from public.client_settings where client_id = v_probe) then
    raise exception '296: a client_settings row named % already exists; the rehearsal will not touch it', v_probe;
  end if;
  begin
    insert into public.client_settings (client_id) values (v_probe) returning cardpointe_env into v_new;
    raise exception using errcode = 'S2960', message = '296: rehearsal rolled back';
  exception when sqlstate 'S2960' then
    null;
  end;
  if v_new is distinct from 'uat' then
    raise exception '296: a new client_settings row starts with cardpointe_env = %, expected uat', coalesce(v_new, 'null');
  end if;
  begin
    insert into public.client_settings (client_id, cardpointe_env) values (v_probe, 'live');
    raise exception using errcode = 'S2961', message = '296: rehearsal rolled back';
  exception
    when check_violation then v_refused := true;
    when sqlstate 'S2961' then v_refused := false;
  end;
  if not v_refused then
    raise exception '296: client_settings took cardpointe_env = ''live''; only uat and prod may be stored';
  end if;
  if exists (select 1 from public.client_settings where client_id = v_probe) then
    raise exception '296: the rehearsal row % was not rolled back', v_probe;
  end if;
  perform set_config('ss.m296_new_row', v_new, true);

  raise notice '296: checks hold; cardpointe_env defaults to uat; first apply %/%; % builder(s) on prod',
    v_first_env::text, v_first_cp::text, (select count(*) from public.client_settings where cardpointe_env = 'prod');
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Counts only: no builder is named, and no merchant id. Before the commit, so a dry run (last
-- `commit;` swapped for `rollback;`) prints the same row and leaves nothing behind. Expected on the
-- first apply:
--   cardpointe_env 'text NOT NULL DEFAULT ''uat''::text', cp_env 'text NULL', first_apply 'true/true',
--   settings_on_prod 0, attempts_with_env 0, settings_changed 0, attempts_changed 0,
--   browser_can_read false, new_row_starts 'uat',
--   enabled_without_mid 0     ← MUST be 0 before the functions deploy (see ORDER)
--   enabled_test_billable n   ← builders switched on in test mode who are billable. Not refused by
--                               anything at charge time; set_payments refuses re-saving them that way.
--                               Decide each one (live, non-billable, or off) before promotion.
-- settings_total and attempts_total are the live counts, to compare with a read-only count taken just
-- before. Anything else: roll back (see ROLLBACK above) before recording the ledger row.
select
  '296' as migration,
  (select c.data_type || case when c.is_nullable = 'NO' then ' NOT NULL' else ' NULL' end
          || coalesce(' DEFAULT ' || c.column_default, '')
     from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'cardpointe_env') as cardpointe_env,
  (select c.data_type || case when c.is_nullable = 'NO' then ' NOT NULL' else ' NULL' end
          || coalesce(' DEFAULT ' || c.column_default, '')
     from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'payment_attempts' and c.column_name = 'cp_env') as cp_env,
  current_setting('ss.m296_first_env') || '/' || current_setting('ss.m296_first_cp') as first_apply,
  (select count(*) from public.client_settings)::int as settings_total,
  (select count(*) from public.client_settings where cardpointe_env = 'prod')::int as settings_on_prod,
  (select count(*) from public.payment_attempts)::int as attempts_total,
  (select count(*) from public.payment_attempts where cp_env is not null)::int as attempts_with_env,
  (select count(*) from m296_settings_before b join public.client_settings cs on cs.client_id = b.client_id
    where exists (select 1 from jsonb_each(to_jsonb(cs)) e
                   where e.key <> 'cardpointe_env' and e.value is distinct from coalesce(b.snap -> e.key, 'null'::jsonb)))::int as settings_changed,
  (select count(*) from m296_attempts_before b join public.payment_attempts pa on pa.id = b.id
    where exists (select 1 from jsonb_each(to_jsonb(pa)) e
                   where e.value is distinct from coalesce(b.snap -> e.key, 'null'::jsonb)))::int as attempts_changed,
  (has_column_privilege('anon', 'public.client_settings', 'cardpointe_env', 'SELECT')
    or has_column_privilege('authenticated', 'public.client_settings', 'cardpointe_env', 'SELECT')
    or has_column_privilege('anon', 'public.payment_attempts', 'cp_env', 'SELECT')
    or has_column_privilege('authenticated', 'public.payment_attempts', 'cp_env', 'SELECT')) as browser_can_read,
  current_setting('ss.m296_new_row', true) as new_row_starts,
  (select count(*) from public.client_settings
    where payments_online_enabled and nullif(trim(cardpointe_merchid), '') is null)::int as enabled_without_mid,
  (select count(*) from public.client_settings
    where payments_online_enabled and cardpointe_env = 'uat' and billing_exempt is not true)::int as enabled_test_billable;

commit;

-- After this: every builder reads 'uat' (where they have always been), every attempt so far reads
-- NULL = 'uat', and an operator can move a builder to live, one at a time, through set_payments once
-- the CARDPOINTE_PROD_* secrets are set.
