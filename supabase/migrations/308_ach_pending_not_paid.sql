-- 308_ach_pending_not_paid.sql — a bank payment that is still clearing is not "Payment Received":
-- the CRM pipeline's paid_in_full event waits until the bank payment stops being pending. It also
-- adds the column portal-payments reconcile uses to keep its place in the funding data.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`, see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('308', '308_ach_pending_not_paid') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check takes the
--    whole file with it. What the apply shows is THE RECORD at the end; no row printed means the
--    file did not run.
--
--    REHEARSAL (changes nothing): pipe it with the last `commit;` swapped for `rollback;`. From
--    Main Apps/StructureStudio, in Git Bash:
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/308_ach_pending_not_paid.sql | npx supabase db query --linked -o csv
--    It prints the same RECORD row and leaves the 302 definition in place.
--
-- ⚠️ BEFORE OR WITH portal-payments. Its reconcile reads payments.funding_checked_through (part 2).
--    Deployed first, it still runs: it reads the payment lists without the column, skips the
--    funding pass and files `reconcile_funding_needs_migration` (info) once a day until this lands.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- 306 is held by ss/c1012-csv-import and 307 by the phone AI-consent branch, so this is 308. Take
-- the next free number at apply time, renaming this file and every '308' below; record the ledger
-- row with `returning`: no row back means the number was taken.
--
-- ── WHY (2026-10-14) ─────────────────────────────────────────────────────────────────────
-- payments_pipeline_sync (migration 302) fires the CRM event paid_in_full when an order's live
-- (non-voided) payments reach its total. It never looked at funding_state, so a bank payment (ACH)
-- that is still CLEARING counted as money the moment it was taken. A read-only check on 2026-10-14
-- found a test-system order whose only payment is a pending bank payment for the whole total, and
-- whose CRM card already read "Payment Received". Fiserv (CardPointe integrations), 2026-10-14: every
-- test-system bank payment comes back R03, and in production any debit can come back days later.
-- A builder reading the pipeline could schedule a build on money that never arrived.
--
-- ── WHAT THIS CHANGES ────────────────────────────────────────────────────────────────────
--   1. payments_pipeline_sync counts only rows that are not voided AND whose funding_state is not
--      'pending'. A returned bank payment is voided as it is marked returned (_shared/achState.ts
--      returnedPaymentPatch), so it was out already. Cash, cheque and card rows are 'settled' (174's
--      column default; cards land settled), so nothing changes for them.
--      The trigger also fires on UPDATE OF funding_state, so paid_in_full fires when portal-payments
--      reconcile moves the bank payment from 'pending' to 'settled'. That happens when the FUNDING
--      data lists it with no sign of a return (the money is in), or, if the funding data never says,
--      once settlestat has accepted it AND seven days have passed (ACH_CLEARED_AFTER_DAYS: a bank
--      payment no reader moves must not hold its order for good). So the event waits for the money
--      to fund, not for the processor to accept the debit; it does not wait out the return window.
--      Everything else in the function is byte-identical to 302: the same order lookup, the same
--      forward-only event (crm_design_event), the same "never fail the write it rides on" handler.
--   2. payments.funding_checked_through (date, null): the last funding day reconcile has read for a
--      bank payment, from its sale day on. Reconcile asks /funding for each (merchant, day) ONCE and
--      starts each sweep where the last one stopped, instead of re-reading the same days on every
--      Orders visit and never reaching the rest (the 40-a-minute per-MID quota is shared with live
--      charges). Bookkeeping only: nothing else reads it, and the browser cannot write a gateway row
--      (174's RLS).
--
-- ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────────────────
--   * It moves no card BACK. 302's rule stands: an automatic event only moves a card forward. A card
--     that already reads Payment Received on a pending or returned bank payment (the test-system one
--     above) stays there until a person moves it. A bank payment that funds and THEN comes back (a
--     return can post days after funding, R10 up to sixty) is voided and its balance reopens, but
--     its card stays at Payment Received too.
--   * No backfill and no grant change. The new column starts null everywhere, which means "read from
--     the sale day".
--
-- ── REVERSE (restores 302's definition exactly) ──────────────────────────────────────────
--   begin;
--   create or replace function public.payments_pipeline_sync()
--   returns trigger language plpgsql security definer set search_path to '' as $fn$
--   declare v_code text; v_total bigint; v_paid bigint;
--   begin
--     begin
--       select o.short_code, o.total_cents into v_code, v_total from public.orders o where o.id = new.order_id;
--       if v_code is not null and coalesce(v_total, 0) > 0 then
--         select coalesce(sum(amount_cents), 0) into v_paid from public.payments
--          where order_id = new.order_id and voided_at is null;
--         if v_paid >= v_total then
--           perform public.crm_design_event(new.client_id, v_code, 'paid_in_full');
--         end if;
--       end if;
--     exception when others then
--       begin
--         insert into public.app_errors (client_id, source, severity, code, message, context)
--         values (new.client_id, 'db:payments_pipeline_sync', 'error', 'crm_pipeline_sync_failed',
--                 'payments_pipeline_sync: ' || sqlerrm, jsonb_build_object('sqlstate', sqlstate, 'order_id', new.order_id));
--       exception when others then null;
--       end;
--     end;
--     return null;
--   end;
--   $fn$;
--   drop trigger if exists payments_pipeline_sync on public.payments;
--   create trigger payments_pipeline_sync after insert or update of amount_cents, voided_at on public.payments
--     for each row execute function public.payments_pipeline_sync();
--   alter table public.payments drop column if exists funding_checked_through;
--   delete from supabase_migrations.schema_migrations where version = '308';
--   commit;
--   (portal-payments keeps working without the column: it skips the funding pass, see above.)

begin;

set local lock_timeout = '5s';

-- ── Before: the function is 302's, not something changed since ─────────────────────────
do $pre$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'payments_pipeline_sync';
  if v_src is null then
    raise exception '308: public.payments_pipeline_sync is missing (migration 302 not applied?)';
  end if;
  -- 302's line, or this file's own (a re-apply); anything else is a definition nobody here has read.
  if position('where order_id = new.order_id and voided_at is null;' in v_src) = 0
     and position('where order_id = new.order_id and voided_at is null and funding_state <> ''pending'';' in v_src) = 0 then
    raise exception '308: payments_pipeline_sync is not the 302 definition this file replaces; read the live one before applying';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'payments' and column_name = 'funding_state'
                    and is_nullable = 'NO') then
    raise exception '308: payments.funding_state is missing or nullable (migration 174)';
  end if;
end;
$pre$;

-- ── 1. Paid in full: the order's live (non-voided) payments that are not still clearing reach its total.
create or replace function public.payments_pipeline_sync()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare v_code text; v_total bigint; v_paid bigint;
begin
  begin
    select o.short_code, o.total_cents into v_code, v_total from public.orders o where o.id = new.order_id;
    if v_code is not null and coalesce(v_total, 0) > 0 then
      select coalesce(sum(amount_cents), 0) into v_paid from public.payments
       where order_id = new.order_id and voided_at is null and funding_state <> 'pending';
      if v_paid >= v_total then
        perform public.crm_design_event(new.client_id, v_code, 'paid_in_full');
      end if;
    end if;
  exception when others then
    begin
      insert into public.app_errors (client_id, source, severity, code, message, context)
      values (new.client_id, 'db:payments_pipeline_sync', 'error', 'crm_pipeline_sync_failed',
              'payments_pipeline_sync: ' || sqlerrm, jsonb_build_object('sqlstate', sqlstate, 'order_id', new.order_id));
    exception when others then null;
    end;
  end;
  return null;
end;
$fn$;
drop trigger if exists payments_pipeline_sync on public.payments;
create trigger payments_pipeline_sync after insert or update of amount_cents, voided_at, funding_state on public.payments
  for each row execute function public.payments_pipeline_sync();

-- ── 2. Where the funding reader got to ───────────────────────────────────────────────────
-- Not in the trigger's column list on purpose: moving a reader's place is not a payment changing.
alter table public.payments
  add column if not exists funding_checked_through date;

comment on column public.payments.funding_checked_through is
  'CardPointe bank payments: the last funding day (inclusive) portal-payments reconcile has read for this payment, from its sale day on, finding no return it could not read. NULL = nothing read yet, start at the sale day. Bookkeeping only (migration 308): it lets each funding day be asked for once. If the date format sent to /funding ever changes, set it back to NULL so every day is read again.';

-- ── After: the new rule is the live one, the trigger watches funding_state, the column is there ──
do $chk$
declare v_src text; v_cols text;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'payments'
                    and column_name = 'funding_checked_through' and data_type = 'date' and is_nullable = 'YES') then
    raise exception '308: payments.funding_checked_through is missing, or not a nullable date';
  end if;
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'payments_pipeline_sync';
  if position('voided_at is null and funding_state <> ''pending'';' in coalesce(v_src, '')) = 0 then
    raise exception '308: payments_pipeline_sync does not leave pending payments out';
  end if;
  select string_agg(a.attname, ',' order by a.attname) into v_cols
    from pg_trigger t
    join pg_attribute a on a.attrelid = t.tgrelid
     and a.attnum = any (string_to_array(t.tgattr::text, ' ')::int2[])
   where t.tgrelid = 'public.payments'::regclass and t.tgname = 'payments_pipeline_sync' and not t.tgisinternal;
  if v_cols is distinct from 'amount_cents,funding_state,voided_at' then
    raise exception '308: payments_pipeline_sync should fire on amount_cents, funding_state, voided_at; it fires on %', coalesce(v_cols, 'nothing');
  end if;
end;
$chk$;

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so the rehearsal prints the same row. Expected: pending_rule true, the three
-- trigger columns, cursor_column true, and pending_bank_payments = the cardpointe bank payments
-- still clearing (on 2026-10-14, one on the test system), which no longer count toward Payment
-- Received.
select
  '308' as migration,
  (select position('funding_state <> ''pending''' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'payments_pipeline_sync') as pending_rule,
  (select string_agg(a.attname, ',' order by a.attname)
     from pg_trigger t
     join pg_attribute a on a.attrelid = t.tgrelid
      and a.attnum = any (string_to_array(t.tgattr::text, ' ')::int2[])
    where t.tgrelid = 'public.payments'::regclass and t.tgname = 'payments_pipeline_sync' and not t.tgisinternal) as trigger_columns,
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'payments' and column_name = 'funding_checked_through') as cursor_column,
  (select count(*) from public.payments
    where gateway = 'cardpointe' and funding_state = 'pending' and voided_at is null)::int as pending_bank_payments;

commit;
