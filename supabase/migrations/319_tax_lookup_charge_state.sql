-- 319_tax_lookup_charge_state.sql — what each Avalara lookup cost, written on its own ledger row.
--
-- ⛔ APPLY BY HAND, BEFORE deploying portal-settings / submit-estimate / admin-catalog /
--    portal-billing from the same commit. Pipe the FILE to `supabase db query --linked` (stdin or
--    --file; never "$(cat …)" inline, which a leading comment empties), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('319', '319_tax_lookup_charge_state') returning version, name;
--    Zero rows back from that insert means another session took 319 first: rename this file.
--    REHEARSAL (prints the RECORD row, leaves nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/319_tax_lookup_charge_state.sql | npx supabase db query --linked -o csv
--    The other order is safe too: deployed first, the functions' charge-state writes fail on the
--    missing columns, are swallowed (best-effort by contract) and the lookups and charges carry on.
--
-- ── WHY (Carolyn 2026-10-19: "Connect tax generation API calls to wallet and tracking") ──────
-- Migration 244 gave every deliberate Avalara request a tax_lookups row, and every successful
-- one a charge keyed on that row (_shared/taxMeter.ts taxLedgerIdem). But nothing recorded what
-- the charge DID: the only link between a call and the wallet was an idempotency string, so
-- "what did this call cost, and was it billed?" had no answer short of a join on text, and a
-- charge that failed (wallet_credit erroring) was lost — logged once as app_errors code
-- tax_meter and never retried. Four columns, written by _shared/taxSpend.ts chargeLookup after
-- the charge attempt (best-effort, never blocking the lookup's answer):
--
--   charge_state  what happened to the charge. NULL = no charge was decided for this row: a ping,
--                 a lookup still in flight, or one whose answer never reached a document (a
--                 Verify press whose quote write was refused is charged nothing).
--                   pending   the charge is being attempted. Written just before the attempt, so a
--                             function that died between the debit and the record leaves a row
--                             an operator can see and replay (the replay is keyed, so safe);
--                   charged   a debit posted (or a replay found the one already posted);
--                   exempt    the tenant is metered_exempt or billing_exempt;
--                   inactive  the meter is disarmed (or has no usage_prices row at all);
--                   unpriced  the meter is armed at 0 cents;
--                   no_rate   the lookup produced no rate, and a failed lookup is never charged;
--                   error     the charge failed: admin-catalog tax_charge_retry replays these
--                             with the SAME tax_ledger idem key, so a debit that did post is
--                             found, not doubled.
--   charge_cents  the price debited, on a charged row only (positive; the wallet row is negative).
--   wallet_tx_id  the wallet_transactions row. BIGINT, not uuid: wallet_transactions.id is
--                 `bigint generated always as identity` (128), and a foreign key must match it.
--                 ON DELETE SET NULL: the ledger row outlives a wallet row an operator removes.
--   charged_at    when the debit posted, on a charged row only.
--
-- One CHECK holds the shape, so a half-written state cannot exist: charged ⇔ charged_at ⇔
-- charge_cents; a wallet row only on a charged row; a ping never carries a charge (it checks
-- OUR credentials and is platform cost, 244).
--
-- ── BACKFILL ────────────────────────────────────────────────────────────────────────────────
-- Every closed verify/invoice row gets a state. A row whose tax_ledger key really is on a posted
-- wallet row is 'charged' and linked (none live on 2026-10-21: 0 tax wallet rows); a closed
-- lookup that produced no rate is 'no_rate'; every other closed lookup is 'inactive', because
-- both tax meters (179) have been active = false, price 0, since they were seeded, so nothing was
-- ever charged for them. Live on 2026-10-20 that is 8 rows (7 invoice + 1 verify), all 'ok'.
-- In-flight rows and pings stay NULL.
--
-- ── POSTURE ───────────────────────────────────────────────────────────────────────────────
-- Unchanged from 244 and re-issued so this file proves it: RLS on, zero policies, nothing for
-- anon, authenticated or PUBLIC (this project's default privileges hand every new table to the
-- API roles; the PUBLIC revoke is the one that matters). Service role reads and writes it.
-- Nothing here touches usage_prices: both tax meters stay DISARMED.

begin;

-- tax_lookups is written by every Verify press and invoice send. Behind a long-held lock the
-- ALTER would queue them; with this the apply fails after 5 s instead, nothing applied.
set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.tax_lookups') is null then
    raise exception '319: public.tax_lookups is missing (migration 244 not applied?)';
  end if;
  if to_regclass('public.wallet_transactions') is null then
    raise exception '319: public.wallet_transactions is missing (migration 128 not applied?)';
  end if;
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'wallet_transactions' and column_name = 'id') is distinct from 'bigint' then
    raise exception '319: wallet_transactions.id is not bigint; wallet_tx_id must match it';
  end if;
end
$pre$;

-- ── 1. The columns ─────────────────────────────────────────────────────────────────────────
alter table public.tax_lookups
  add column if not exists charge_state text,
  add column if not exists charge_cents integer,
  add column if not exists wallet_tx_id bigint references public.wallet_transactions(id) on delete set null,
  add column if not exists charged_at   timestamptz;

do $con$
begin
  if not exists (select 1 from pg_constraint where conname = 'tax_lookups_charge_state_check') then
    alter table public.tax_lookups add constraint tax_lookups_charge_state_check check (
      charge_state is null
      or charge_state in ('pending', 'charged', 'exempt', 'inactive', 'unpriced', 'no_rate', 'error')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tax_lookups_charge_shape_check') then
    alter table public.tax_lookups add constraint tax_lookups_charge_shape_check check (
          (charge_state is not distinct from 'charged') = (charged_at is not null)
      and (charge_state is not distinct from 'charged') = (charge_cents is not null)
      and (charge_cents is null or charge_cents > 0)
      and (wallet_tx_id is null or charge_state = 'charged')
      and (kind <> 'ping' or charge_state is null)
    );
  end if;
end
$con$;

comment on column public.tax_lookups.charge_state is
  'Migration 319. What happened to this lookup''s charge: pending | charged | exempt | inactive | unpriced | no_rate | error. NULL = none decided (a ping, in flight, or an answer that reached no document). Written by _shared/taxSpend.ts chargeLookup; error rows are replayed by admin-catalog tax_charge_retry on the same tax_ledger idem key.';
comment on column public.tax_lookups.charge_cents is
  'Migration 319. The price debited (positive), on a charged row only.';
comment on column public.tax_lookups.wallet_tx_id is
  'Migration 319. The wallet_transactions row the charge posted (bigint, as that id is). Set null if the wallet row is ever deleted.';
comment on column public.tax_lookups.charged_at is
  'Migration 319. When the debit posted, on a charged row only.';

-- The retry action reads the failed and stuck charges; a partial index keeps that read cheap
-- as the ledger grows, and holds only the rows that need attention.
create index if not exists tax_lookups_charge_attention
  on public.tax_lookups (called_at)
  where charge_state in ('error', 'pending');

-- ── 2. The posture, re-issued (244's) ────────────────────────────────────────────────────────
alter table public.tax_lookups enable row level security;
revoke all on public.tax_lookups from public;
revoke all on public.tax_lookups from anon, authenticated;

-- ── 3. The backfill ────────────────────────────────────────────────────────────────────────
-- 3a. A row whose ledger key is really on a posted wallet row was charged: link it.
update public.tax_lookups l
   set charge_state = 'charged',
       charge_cents = -w.amount_cents,
       wallet_tx_id = w.id,
       charged_at   = coalesce(w.posted_at, w.created_at)
  from public.wallet_transactions w
 where l.charge_state is null
   and l.kind in ('verify', 'invoice')
   and w.client_id = l.client_id
   and w.state = 'posted'
   and w.amount_cents < 0
   and w.idempotency_key = 'tax_ledger:'
         || case l.kind when 'verify' then 'tax_lookup' else 'tax_invoice' end
         || ':' || l.id::text;

-- 3b. Every other closed verify/invoice row: no rate, or never charged (the meters were off).
update public.tax_lookups
   set charge_state = case when outcome = 'ok' then 'inactive' else 'no_rate' end
 where charge_state is null
   and kind in ('verify', 'invoice')
   and outcome is not null;

-- ── 4. The checks ──────────────────────────────────────────────────────────────────────────
-- Run inside the transaction: any failure aborts the whole file and leaves the database as it
-- was. The rehearsal writes a wallet row and a ledger row under a client id no tenant can have
-- (slugs are ^[a-z0-9][a-z0-9-]*$) and is rolled back by its own SQLSTATE.
do $check$
declare
  v_n    int;
  v_id   uuid;
  v_ping uuid;
  v_tx   bigint;
  v_out  text;
  v_t    constant text := '__m319_rehearsal__';
begin
  -- The columns, with the types the functions write.
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'tax_lookups'
     and (column_name, data_type) in (('charge_state', 'text'), ('charge_cents', 'integer'),
                                      ('wallet_tx_id', 'bigint'), ('charged_at', 'timestamp with time zone'));
  if v_n <> 4 then
    raise exception '319: expected 4 charge columns of the right types on tax_lookups, found %', v_n;
  end if;

  -- The foreign key: to wallet_transactions(id), ON DELETE SET NULL.
  select count(*) into v_n from pg_constraint c
   where c.conrelid = 'public.tax_lookups'::regclass and c.contype = 'f'
     and c.confrelid = 'public.wallet_transactions'::regclass and c.confdeltype = 'n';
  if v_n <> 1 then
    raise exception '319: wallet_tx_id is not one foreign key to wallet_transactions with ON DELETE SET NULL (% found)', v_n;
  end if;

  -- The posture: RLS on, no policies, nothing for a browser role, the service role reads + writes.
  if not (select relrowsecurity from pg_class where oid = 'public.tax_lookups'::regclass) then
    raise exception '319: row level security is off on tax_lookups';
  end if;
  select count(*) into v_n from pg_policies where schemaname = 'public' and tablename = 'tax_lookups';
  if v_n <> 0 then
    raise exception '319: tax_lookups has % policies; it is service-role only and must have none', v_n;
  end if;
  if has_table_privilege('anon', 'public.tax_lookups', 'select')
     or has_table_privilege('authenticated', 'public.tax_lookups', 'select')
     or has_table_privilege('authenticated', 'public.tax_lookups', 'update')
     or has_column_privilege('authenticated', 'public.tax_lookups', 'charge_state', 'select') then
    raise exception '319: tax_lookups is reachable by a browser role';
  end if;
  if not (has_table_privilege('service_role', 'public.tax_lookups', 'select')
          and has_table_privilege('service_role', 'public.tax_lookups', 'update')) then
    raise exception '319: service_role cannot read and update tax_lookups';
  end if;

  -- The backfill: no closed verify/invoice row is left without a state, no ping got one.
  select count(*) into v_n from public.tax_lookups
   where kind in ('verify', 'invoice') and outcome is not null and charge_state is null;
  if v_n <> 0 then
    raise exception '319: % closed lookup(s) were left without a charge state', v_n;
  end if;
  select count(*) into v_n from public.tax_lookups where kind = 'ping' and charge_state is not null;
  if v_n <> 0 then
    raise exception '319: % ping(s) carry a charge state', v_n;
  end if;
  select count(*) into v_n from public.tax_lookups where outcome is distinct from 'ok' and charge_state = 'inactive';
  if v_n <> 0 then
    raise exception '319: % failed lookup(s) were backfilled as inactive rather than no_rate', v_n;
  end if;

  -- The rehearsal.
  begin
    insert into public.tax_lookups (client_id, kind, outcome, finished_at, rate)
    values (v_t, 'verify', 'ok', now(), 0.07375) returning id into v_id;
    insert into public.tax_lookups (client_id, kind, outcome, finished_at)
    values (v_t, 'ping', 'ok', now()) returning id into v_ping;
    insert into public.wallet_transactions
      (client_id, kind, amount_cents, balance_after_cents, meter_kind, state, idempotency_key, posted_at)
    values (v_t, 'debit', -10, -10, 'tax_lookup', 'posted', 'tax_ledger:tax_lookup:' || v_id::text, now())
    returning id into v_tx;

    -- pending, then charged and linked: the write chargeLookup makes.
    update public.tax_lookups set charge_state = 'pending' where id = v_id;
    update public.tax_lookups
       set charge_state = 'charged', charge_cents = 10, wallet_tx_id = v_tx, charged_at = now()
     where id = v_id;
    -- Every state the code writes for an uncharged row is accepted, bare.
    update public.tax_lookups set charge_state = 'error', charge_cents = null, wallet_tx_id = null, charged_at = null where id = v_id;
    update public.tax_lookups set charge_state = 'exempt' where id = v_id;
    update public.tax_lookups set charge_state = 'inactive' where id = v_id;
    update public.tax_lookups set charge_state = 'unpriced' where id = v_id;
    update public.tax_lookups set charge_state = 'no_rate' where id = v_id;

    -- What the shape refuses.
    begin
      update public.tax_lookups set charge_state = 'billed' where id = v_id;
      raise exception '319: an unknown charge state was accepted';
    exception when check_violation then null;
    end;
    begin
      update public.tax_lookups set charge_state = 'charged', charge_cents = 10, charged_at = null where id = v_id;
      raise exception '319: a charged row without charged_at was accepted';
    exception when check_violation then null;
    end;
    begin
      update public.tax_lookups set charge_state = 'charged', charge_cents = null, charged_at = now() where id = v_id;
      raise exception '319: a charged row without charge_cents was accepted';
    exception when check_violation then null;
    end;
    begin
      update public.tax_lookups set charge_state = 'charged', charge_cents = 0, charged_at = now() where id = v_id;
      raise exception '319: a charge of 0 cents was accepted';
    exception when check_violation then null;
    end;
    begin
      update public.tax_lookups set charge_state = 'exempt', wallet_tx_id = v_tx where id = v_id;
      raise exception '319: a wallet row on an uncharged lookup was accepted';
    exception when check_violation then null;
    end;
    begin
      update public.tax_lookups set charge_state = 'exempt', charged_at = now() where id = v_id;
      raise exception '319: charged_at on an uncharged lookup was accepted';
    exception when check_violation then null;
    end;
    begin
      update public.tax_lookups set charge_state = 'inactive' where id = v_ping;
      raise exception '319: a ping was given a charge state';
    exception when check_violation then null;
    end;
    begin
      update public.tax_lookups set wallet_tx_id = -1 where id = v_ping;
      raise exception '319: a wallet row that does not exist was accepted';
    exception when check_violation or foreign_key_violation then null;
    end;

    -- ON DELETE SET NULL: the ledger row keeps its charge when the wallet row goes.
    update public.tax_lookups
       set charge_state = 'charged', charge_cents = 10, wallet_tx_id = v_tx, charged_at = now()
     where id = v_id;
    delete from public.wallet_transactions where id = v_tx;
    select count(*) into v_n from public.tax_lookups
     where id = v_id and charge_state = 'charged' and wallet_tx_id is null and charge_cents = 10;
    if v_n <> 1 then
      raise exception '319: deleting the wallet row did not leave the lookup charged with no wallet link';
    end if;

    raise exception using errcode = 'S3190',
      message = 'pending, charged + linked, every uncharged state; refused: unknown state, half-charged rows, 0 cents, a wallet link or time off a charge, a charged ping, a missing wallet row; a deleted wallet row unlinks';
  exception when sqlstate 'S3190' then
    v_out := sqlerrm;
  end;
  if exists (select 1 from public.tax_lookups where client_id = v_t)
     or exists (select 1 from public.wallet_transactions where client_id = v_t) then
    raise exception '319: the rehearsal rows were not rolled back';
  end if;
  perform set_config('ss.m319_rehearsal', v_out, true);
  raise notice '319: checks hold';
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so a rehearsal (commit swapped for rollback) prints the same row and
-- leaves nothing behind. Expected live (2026-10-21): columns 4, charged 0, inactive 8,
-- no_rate 0, unstated 0 (or the in-flight count), and the rehearsal sentence above.
select
  '319' as migration,
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'tax_lookups'
      and column_name in ('charge_state', 'charge_cents', 'wallet_tx_id', 'charged_at')) as columns,
  (select count(*)::int from public.tax_lookups where charge_state = 'charged') as charged,
  (select count(*)::int from public.tax_lookups where charge_state = 'inactive') as inactive,
  (select count(*)::int from public.tax_lookups where charge_state = 'no_rate') as no_rate,
  (select count(*)::int from public.tax_lookups where kind in ('verify', 'invoice') and charge_state is null) as unstated,
  current_setting('ss.m319_rehearsal', true) as rehearsal;

commit;

-- ROLLBACK (revert the four functions first, or their charge-state writes fail — harmlessly,
-- they are best-effort — until they are):
--   begin;
--   drop index if exists public.tax_lookups_charge_attention;
--   alter table public.tax_lookups
--     drop constraint if exists tax_lookups_charge_shape_check,
--     drop constraint if exists tax_lookups_charge_state_check,
--     drop column if exists charged_at,
--     drop column if exists wallet_tx_id,
--     drop column if exists charge_cents,
--     drop column if exists charge_state;
--   notify pgrst, 'reload schema';
--   commit;
