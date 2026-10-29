-- 348_payment_refunds.sql — partial refunds on order payments: a refund ledger, the refunded total on
-- the payment, and the two locked steps every refund goes through (board card "Partial refunds").
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Through the Supabase connector's execute_sql with the
--    whole file, then the ledger row:
--      insert into supabase_migrations.schema_migrations (version, name) values ('348', '348_payment_refunds') returning version, name;
--    (or apply_migration, then renumber its timestamp row to '348'). NEVER `supabase db push`, never
--    `db query --file`. The file carries its own begin;/commit;. READ IT BACK in a separate query:
--      select column_name, is_nullable, column_default from information_schema.columns
--       where table_schema = 'public' and table_name = 'payments' and column_name = 'refunded_cents';
--      select to_regclass('public.payment_refunds'), to_regprocedure('public.payment_refund_open(text,uuid,integer,text,text,uuid,text,text,text)');
--    To see it and change nothing, run it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger 2026-10-29: 347 is the newest. Confirm 348 is free at apply time; no row back from the
-- ledger insert means the number is gone: rename this file, its test and every '348' below.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Refund on an order payment could only give back the WHOLE payment. portal-payments' refund_payment
-- took an amount, but nothing sent one, and it had no guard: a double click sent two refunds to the
-- card network, and a timeout said "nothing has changed, try again" about a refund that may have
-- gone through. Cash, check and bank payments recorded by hand could only be voided whole.
--
-- ── THE MODEL: THE PAYMENT KEEPS ITS NET, THE LEDGER KEEPS THE HISTORY ───────────────────
-- Every reader of money sums payments.amount_cents over rows that are not voided: the Orders tab
-- (paid, balance, Refund owed, tiles), readOrderMoney (the amount a customer or builder is asked
-- for), customer-pay / my-quotes "Paid in full", the change-order consent sentences, commissions'
-- collected date, and the payments_pipeline_sync trigger. So a refund REDUCES amount_cents (what
-- refund_payment already did for a partial one), and every one of those readers is right with no
-- change. A reader somebody forgets reads the net, which is the safe direction: a separate ledger
-- that a reader forgot to subtract would tell a customer they had paid money they got back.
--
--   payments.refunded_cents   what has been given back so far. The payment as taken is
--                             amount_cents + refunded_cents, always.
--   amount_cents may be 0     only on a row refunded in full: refunded_cents > 0 and voided_at set.
--                             Nothing else may write a 0, and a fully refunded payment cannot be
--                             restored (un-voided) into a zero payment.
--   payment_refunds           one row per refund: amount, card network or by hand, how it was paid
--                             back, the card network's order id and reference, who, when. Its
--                             (client_id, request_key) is unique: the page sends one key per refund,
--                             so a retry or a double click finds the first refund instead of making
--                             a second. At most one refund per payment is in flight (pending or
--                             unknown) at a time.
--
-- ── THE TWO STEPS (service role only; portal-payments calls them) ────────────────────────
--   payment_refund_open    locks the payment, answers a repeated key with what happened to it,
--                          refuses a second refund while one is in flight, a voided payment, the
--                          wrong kind (card network vs by hand) and an amount above what is left,
--                          then writes the refund 'pending'. A refund by hand is closed 'done' in the
--                          same transaction: there is nobody else to ask.
--   payment_refund_close   'done' moves the money on the payment (amount down, refunded up, voided
--                          when nothing is left, a note line), 'failed' and 'unknown' only mark the
--                          refund. A refund already done or failed is never moved again.
--
-- ── BACKFILL ─────────────────────────────────────────────────────────────────────────────
-- Refunds before this file live only in the note ("Refunded $X on DATE (ref R)"), one line each. Their
-- sum becomes refunded_cents, and a payment refunded in full (void_reason 'refunded $…') gets
-- amount_cents 0, so amount + refunded is the payment as taken. No ledger rows are made for them.
--
-- ── NOT TOUCHED ──────────────────────────────────────────────────────────────────────────
-- payments_pipeline_sync (309) fires on the amount_cents change and only ever moves a deal forward,
-- as with a void. inventory_claim_on_payment (214) is INSERT-only: a refund does not release a lot
-- building, as a void does not. surcharge_cents is not refunded or changed.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Only once no refund has run through the new code (select count(*) from public.payment_refunds = 0):
--   update public.payments set amount_cents = amount_cents + refunded_cents where amount_cents = 0 and refunded_cents > 0;
--   drop function public.payment_refund_open(text,uuid,integer,text,text,uuid,text,text,text);
--   drop function public.payment_refund_close(bigint,text,text,text,text);
--   drop trigger payments_refunded_guard on public.payments; drop function public.payments_refunded_guard();
--   drop table public.payment_refunds;
--   alter table public.payments drop constraint payments_amount_cents_check;
--   alter table public.payments add constraint payments_amount_cents_check check (amount_cents > 0);
--   alter table public.payments drop column refunded_cents;
-- The repo is public: no client identifiers in here.

begin;

do $$
begin
  if to_regclass('public.payments') is null then raise exception '348: public.payments is missing'; end if;
  if to_regclass('public.orders') is null then raise exception '348: public.orders is missing'; end if;
  -- payments_order_client_fk points at the unique index orders_id_client_uniq; the refund's does too.
  if not exists (select 1 from pg_index i where i.indrelid = 'public.orders'::regclass and i.indisunique
                  and i.indpred is null
                  and (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey) with ordinality k(attnum, ord)
                         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = array['id', 'client_id']) then
    raise exception '348: orders has no unique (id, client_id) for the refund''s order key';
  end if;
end $$;

-- ── 1. payments.refunded_cents, and the one way amount_cents may reach 0 ─────────────────
alter table public.payments add column if not exists refunded_cents integer not null default 0;
alter table public.payments drop constraint if exists payments_refunded_cents_check;
alter table public.payments add constraint payments_refunded_cents_check check (refunded_cents >= 0);

-- The old check (amount_cents > 0) comes off first: the backfill writes the 0 of a payment refunded
-- in full, and the new check below is what allows it.
alter table public.payments drop constraint if exists payments_amount_cents_check;
with lines as (
  select p.id, sum((m[1])::numeric) as dollars
    from public.payments p,
         regexp_matches(coalesce(p.note, ''), 'Refunded \$([0-9]+(?:\.[0-9]{1,2})?) on ', 'g') as m
   where p.refunded_cents = 0
   group by p.id
)
update public.payments p
   set refunded_cents = round(l.dollars * 100)::integer,
       amount_cents = case when p.voided_at is not null and p.void_reason like 'refunded $%' then 0 else p.amount_cents end
  from lines l
 where l.id = p.id and l.dollars > 0;

alter table public.payments add constraint payments_amount_cents_check
  check (amount_cents > 0 or (amount_cents = 0 and refunded_cents > 0 and voided_at is not null));

-- The browser may update a payment it recorded by hand (payments_owner_update), every column. The
-- refunded total is not one of them: only the steps below move it.
create or replace function public.payments_refunded_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.refunded_cents is distinct from old.refunded_cents and current_user in ('anon', 'authenticated') then
    raise exception 'refunded_cents is changed by a refund only' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists payments_refunded_guard on public.payments;
create trigger payments_refunded_guard before update of refunded_cents on public.payments
  for each row execute function public.payments_refunded_guard();

-- ── 2. The ledger ────────────────────────────────────────────────────────────────────────
create table if not exists public.payment_refunds (
  id bigint generated always as identity primary key,
  client_id text not null,
  payment_id uuid not null,
  order_id uuid not null,
  amount_cents integer not null check (amount_cents > 0),
  kind text not null check (kind in ('gateway', 'manual')),
  state text not null default 'pending' check (state in ('pending', 'unknown', 'done', 'failed')),
  request_key text not null check (length(request_key) between 8 and 100),
  method text check (method is null or method in ('card', 'cash', 'check', 'ach', 'other')),
  reference text check (reference is null or length(reference) <= 200),
  reason text check (reason is null or length(reason) <= 500),
  gateway_orderid text,
  gateway_retref text,
  gateway_respcode text,
  gateway_resptext text,
  created_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint payment_refunds_key_uniq unique (client_id, request_key),
  constraint payment_refunds_payment_fk foreign key (payment_id) references public.payments (id) on delete cascade,
  constraint payment_refunds_order_fk foreign key (order_id, client_id) references public.orders (id, client_id) on delete cascade
);
create unique index if not exists payment_refunds_one_open on public.payment_refunds (payment_id) where state in ('pending', 'unknown');
create unique index if not exists payment_refunds_orderid_uniq on public.payment_refunds (gateway_orderid) where gateway_orderid is not null;
create index if not exists payment_refunds_order_idx on public.payment_refunds (client_id, order_id);

alter table public.payment_refunds enable row level security;
revoke all on public.payment_refunds from anon, authenticated;
grant select on public.payment_refunds to authenticated;
grant select, insert, update, delete on public.payment_refunds to service_role;
drop policy if exists payment_refunds_owner_select on public.payment_refunds;
create policy payment_refunds_owner_select on public.payment_refunds
  for select to authenticated using (client_id = public.current_client_id());

-- ── 3. Close: the only code that moves money on the payment for a refund ────────────────
create or replace function public.payment_refund_close(
  p_refund bigint, p_state text, p_retref text default null, p_respcode text default null, p_resptext text default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_row public.payment_refunds%rowtype;
  v_pay public.payments%rowtype;
  v_left integer;
  v_line text;
  v_short boolean := false;
begin
  if p_state not in ('done', 'failed', 'unknown') then
    raise exception '348: payment_refund_close: no such state %', p_state;
  end if;
  select * into v_row from public.payment_refunds where id = p_refund;
  if not found then return jsonb_build_object('refused', 'not_found'); end if;
  -- Payment first, then the refund: the order payment_refund_open takes them in.
  select * into v_pay from public.payments where id = v_row.payment_id for update;
  select * into v_row from public.payment_refunds where id = p_refund for update;
  if v_row.state in ('done', 'failed') then
    return jsonb_build_object('already', true, 'refund', to_jsonb(v_row),
      'payment', jsonb_build_object('id', v_pay.id, 'amount_cents', v_pay.amount_cents, 'refunded_cents', v_pay.refunded_cents, 'voided_at', v_pay.voided_at));
  end if;

  if p_state <> 'done' then
    update public.payment_refunds
       set state = p_state,
           gateway_retref = coalesce(left(p_retref, 64), gateway_retref),
           gateway_respcode = coalesce(left(p_respcode, 16), gateway_respcode),
           gateway_resptext = coalesce(left(p_resptext, 200), gateway_resptext),
           completed_at = case when p_state = 'failed' then now() else completed_at end
     where id = p_refund returning * into v_row;
    return jsonb_build_object(p_state, true, 'refund', to_jsonb(v_row));
  end if;

  -- 'done'. The open step refused more than was left and allows one refund in flight per payment,
  -- so the money is there. If something else took it since (a bank return voided the payment), the
  -- refund still happened: it is recorded, the payment goes no lower than 0, and `short` says so.
  v_left := v_pay.amount_cents - v_row.amount_cents;
  if v_left < 0 then v_short := true; v_left := 0; end if;
  v_line := 'Refunded $' || to_char(v_row.amount_cents / 100.0, 'FM9999999990.00')
    || case when v_row.kind = 'manual' and v_row.method is not null then ' by ' || v_row.method else '' end
    || ' on ' || to_char(now() at time zone 'utc', 'YYYY-MM-DD')
    || case when coalesce(p_retref, v_row.reference) is not null then ' (ref ' || left(coalesce(p_retref, v_row.reference), 64) || ')' else '' end;
  update public.payments
     set amount_cents = v_left,
         refunded_cents = refunded_cents + v_row.amount_cents,
         voided_at = case when v_left = 0 then coalesce(voided_at, now()) else voided_at end,
         void_reason = case when v_left = 0 and voided_at is null
                            then 'refunded $' || to_char((refunded_cents + v_row.amount_cents) / 100.0, 'FM9999999990.00')
                            else void_reason end,
         note = right(concat_ws(E'\n', nullif(btrim(note), ''), v_line), 2000),
         funding_updated_at = case when gateway is not null then now() else funding_updated_at end
   where id = v_pay.id returning * into v_pay;
  update public.payment_refunds
     set state = 'done', completed_at = now(),
         gateway_retref = coalesce(left(p_retref, 64), gateway_retref),
         gateway_respcode = coalesce(left(p_respcode, 16), gateway_respcode),
         gateway_resptext = coalesce(left(p_resptext, 200), gateway_resptext)
   where id = p_refund returning * into v_row;
  return jsonb_build_object('done', true, 'short', v_short, 'refund', to_jsonb(v_row),
    'payment', jsonb_build_object('id', v_pay.id, 'amount_cents', v_pay.amount_cents, 'refunded_cents', v_pay.refunded_cents, 'voided_at', v_pay.voided_at));
end $$;

-- ── 4. Open ───────────────────────────────────────────────────────────────────────────────
create or replace function public.payment_refund_open(
  p_client text, p_payment uuid, p_amount integer, p_key text, p_kind text,
  p_actor uuid default null, p_method text default null, p_reference text default null, p_reason text default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_pay public.payments%rowtype;
  v_row public.payment_refunds%rowtype;
begin
  if p_kind is null or p_kind not in ('gateway', 'manual') then return jsonb_build_object('refused', 'kind'); end if;
  if p_key is null or length(p_key) < 8 or length(p_key) > 100 then return jsonb_build_object('refused', 'key'); end if;
  if p_method is not null and p_method not in ('card', 'cash', 'check', 'ach', 'other') then
    return jsonb_build_object('refused', 'method');
  end if;
  -- Every refund on one payment queues on this lock.
  select * into v_pay from public.payments where client_id = p_client and id = p_payment for update;
  if not found then return jsonb_build_object('refused', 'not_found'); end if;

  -- The same request again (a retry, a double click): what happened to it, and nothing new.
  select * into v_row from public.payment_refunds where client_id = p_client and request_key = p_key;
  if found then
    if v_row.payment_id <> p_payment or v_row.amount_cents is distinct from p_amount then
      return jsonb_build_object('refused', 'key_reused');
    end if;
    return jsonb_build_object('replay', true, 'refund', to_jsonb(v_row),
      'payment', jsonb_build_object('id', v_pay.id, 'amount_cents', v_pay.amount_cents, 'refunded_cents', v_pay.refunded_cents, 'voided_at', v_pay.voided_at));
  end if;

  select * into v_row from public.payment_refunds where payment_id = p_payment and state in ('pending', 'unknown') limit 1;
  if found then return jsonb_build_object('refused', 'in_flight', 'refund', to_jsonb(v_row)); end if;
  if v_pay.voided_at is not null then return jsonb_build_object('refused', 'voided'); end if;
  if p_kind = 'gateway' and (v_pay.gateway is distinct from 'cardpointe' or v_pay.gateway_txn_id is null) then
    return jsonb_build_object('refused', 'not_gateway');
  end if;
  if p_kind = 'manual' and v_pay.gateway is not null then return jsonb_build_object('refused', 'not_manual'); end if;
  if p_amount is null or p_amount <= 0 or p_amount > v_pay.amount_cents then
    return jsonb_build_object('refused', 'amount', 'refundable_cents', v_pay.amount_cents);
  end if;

  insert into public.payment_refunds
    (client_id, payment_id, order_id, amount_cents, kind, state, request_key, method, reference, reason, gateway_orderid, created_by)
  values
    (p_client, p_payment, v_pay.order_id, p_amount, p_kind, 'pending', p_key,
     coalesce(p_method, case when p_kind = 'gateway' then v_pay.method end),
     nullif(left(btrim(coalesce(p_reference, '')), 200), ''),
     nullif(left(btrim(coalesce(p_reason, '')), 500), ''),
     case when p_kind = 'gateway' then 'ssr_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20) end,
     p_actor)
  returning * into v_row;

  if p_kind = 'manual' then
    return public.payment_refund_close(v_row.id, 'done') || jsonb_build_object('opened', true);
  end if;
  return jsonb_build_object('opened', true, 'refund', to_jsonb(v_row));
end $$;

revoke all on function public.payment_refund_open(text, uuid, integer, text, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.payment_refund_close(bigint, text, text, text, text) from public, anon, authenticated;
revoke all on function public.payments_refunded_guard() from public, anon, authenticated;
grant execute on function public.payment_refund_open(text, uuid, integer, text, text, uuid, text, text, text) to service_role;
grant execute on function public.payment_refund_close(bigint, text, text, text, text) to service_role;

-- ── THE RECORD ────────────────────────────────────────────────────────────────────────────
select
  (select count(*) from public.payments where refunded_cents > 0) as payments_with_refunds,
  (select count(*) from public.payments where amount_cents = 0) as refunded_in_full,
  (select count(*) from public.payment_refunds) as ledger_rows,
  (select relrowsecurity from pg_class where oid = 'public.payment_refunds'::regclass) as ledger_rls;

commit;
