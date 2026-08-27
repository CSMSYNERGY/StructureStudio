-- 128_usage_wallet.sql — a prepaid wallet, and the metered price list it spends against.
--
-- WHY. Carolyn, 2026-08-21 and again 2026-08-24: "every time they generate an image it's
-- going to cost them $20 ... if they have to pay $20 every time, they're going to take
-- better videos. That's my whole goal." And: "like GHL has a wallet on there ... put it in
-- the billing, in the billing portion. A wallet for usage cases ... I will connect the
-- wallet to Deposyt AFTER — just set the infrastructure up right now."
--
-- So: the ledger ships and works before any merchant account is attached. Debits function
-- with `configured = false`; only top-ups are inert until she connects Deposyt. That
-- asymmetry is what makes the September demo honest — a real balance really does drop.
--
-- SCOPE. This migration is INERT ON APPLY. Nothing selects these tables and no function
-- references them until portal-settings and portal-billing are redeployed. The seed price
-- row lands with active = false, so even after those deploys the charge does not fire
-- until one boolean is flipped (see the arming statement at the bottom, which is
-- deliberately NOT part of this file — the 109_feature_grants pattern).
--
-- Rollback:
--   drop function if exists public.wallet_release(bigint, text);
--   drop function if exists public.wallet_capture(bigint, integer, jsonb, text);
--   drop function if exists public.wallet_hold(text, text, text, uuid);
--   drop function if exists public.wallet_credit(text, bigint, text, text, text, text, text, uuid);
--   drop view if exists public.wallet_reconcile;
--   drop table if exists public.wallet_transactions;
--   drop table if exists public.wallet_accounts;
--   drop table if exists public.usage_prices;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The meter registry. A price is a ROW, not a constant.
-- ─────────────────────────────────────────────────────────────────────────────
-- She has already said Twilio usage will ride the same wallet ("when we do Twilio and all
-- those others, it'll be for that as well"). Adding a meter must therefore be an insert,
-- not a deploy. `visible` mirrors billing_plans.price_visible so a price can exist without
-- being shown.
create table if not exists public.usage_prices (
  kind        text primary key,
  label       text not null,
  unit_label  text not null default 'generation',
  price_cents integer not null check (price_cents >= 0),
  active      boolean not null default false,
  visible     boolean not null default true,
  sort_order  integer not null default 0,
  note        text,
  updated_at  timestamptz not null default now()
);

comment on table public.usage_prices is
  'Metered price list for the prepaid wallet. wallet_hold reads the price FROM HERE — the '
  'amount is never a parameter and never travels on the wire, which is one step stronger '
  'than portal-billing''s subscribe, where a client-supplied confirmChargeCents is merely '
  'refused on mismatch. A metered debit has no cart for the customer to have assembled, so '
  'echoing an amount back would add attack surface for no UX gain.';

insert into public.usage_prices (kind, label, unit_label, price_cents, active, sort_order, note)
values ('video_3d_generation', '3D model from a walk-around video', 'generation', 2000, false, 10,
        'Carolyn 2026-08-24: $20 per generation, priced to make a builder shoot a good video the first time rather than to track cost.')
on conflict (kind) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. One wallet per tenant.
-- ─────────────────────────────────────────────────────────────────────────────
-- STORED balance, ledger-authoritative, with a reconcile view — not sum-of-ledger.
-- Three reasons, in order of weight:
--   (a) the debit must be atomic AND conditional ("deduct 2000 only if available >= 2000").
--       That is one statement under a row lock. A sum-then-insert has a TOCTOU window
--       where two concurrent calls both see $20 available and both spend it.
--   (b) reads are hot — the Billing card, every catalog call, the calibration panel.
--   (c) a materialized cache would need a refresh job, and THIS PROJECT HAS NO pg_cron
--       (verified absent; it is why sync_all has never run once). Any design that assumes
--       a scheduler is dead on arrival here.
-- Drift is made detectable rather than avoided: see wallet_reconcile below.
create table if not exists public.wallet_accounts (
  client_id                  text primary key,
  balance_cents              bigint  not null default 0,
  held_cents                 bigint  not null default 0 check (held_cents >= 0),
  metered_exempt             boolean not null default false,
  monthly_ai_cost_cap_cents  integer,
  -- Shipped as columns, deliberately UNUSED. Auto-reload needs a card-not-present decline
  -- ladder and a trigger, and with no pg_cron the only trigger available is lazy — firing
  -- a sale inline during a debit, which doubles generation latency and puts a card decline
  -- in the middle of a 3D draft. Not before an expo. The columns exist because the
  -- low-balance copy reads differently depending on whether auto-reload is coming.
  auto_reload_enabled          boolean not null default false,
  auto_reload_threshold_cents  integer,
  auto_reload_amount_cents     integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The ledger. Append-only, signed cents.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.wallet_transactions (
  id                  bigint generated always as identity primary key,
  client_id           text not null,
  kind                text not null check (kind in ('topup','debit','refund','grant','adjustment','reversal')),
  amount_cents        bigint not null,          -- credits positive, debits negative
  balance_after_cents bigint not null,          -- written under the same row lock
  meter_kind          text,                     -- usage_prices.kind, for debits
  state               text not null default 'posted' check (state in ('held','posted','released','void')),
  idempotency_key     text,
  hold_id             bigint references public.wallet_transactions(id),
  ref_type            text,                     -- 'nmi_sale' | 'ai_style_call' | 'operator'
  ref_id              text,
  -- OUR cost, not theirs. This is the gross margin on a $20 charge and is the single most
  -- sensitive column in the schema — a tenant reading it is the worst leak available here.
  -- She asked for it directly: "do tell me how much it does use."
  cost_cents          integer,
  usage               jsonb,                    -- { model, input_tokens, output_tokens, ... }
  memo                text,
  actor_user_id       uuid,
  created_at          timestamptz not null default now(),
  posted_at           timestamptz
);

create index if not exists wallet_tx_client_recent
  on public.wallet_transactions (client_id, created_at desc);

-- Idempotency: a replayed top-up returns the existing row instead of crediting twice.
create unique index if not exists wallet_tx_idem
  on public.wallet_transactions (client_id, idempotency_key)
  where idempotency_key is not null;

-- THE CONCURRENCY GUARD, modelled on billing_charge_attempts' state='open' index (061).
-- Two simultaneous "Read the video" clicks: the second violates this and is refused
-- BEFORE the Anthropic call, which is the whole point — the expensive thing must not
-- happen twice.
--
-- It constrains one hold per tenant per meter, which is right for a slow expensive
-- synchronous call and WRONG for SMS. Resolve that by rule, not by schema gymnastics:
-- holds are for expensive, slow, failure-prone meters; cheap fast meters post directly
-- with state='posted' and no hold. Do not try to hold a $0.008 SMS segment.
create unique index if not exists wallet_tx_one_hold
  on public.wallet_transactions (client_id, meter_kind)
  where state = 'held';

-- Is the stored balance still the truth? Operator-only; the answer to "is the number on
-- screen real?". A stored column that cannot be checked is a rumour.
create or replace view public.wallet_reconcile as
  select a.client_id,
         a.balance_cents                                            as stored_balance_cents,
         coalesce(sum(t.amount_cents) filter (where t.state = 'posted'), 0) as ledger_balance_cents,
         a.held_cents                                               as stored_held_cents,
         coalesce(-sum(t.amount_cents) filter (where t.state = 'held'), 0)  as ledger_held_cents
    from public.wallet_accounts a
    left join public.wallet_transactions t on t.client_id = a.client_id
   group by a.client_id, a.balance_cents, a.held_cents;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS + privileges.
-- ─────────────────────────────────────────────────────────────────────────────
-- Zero policies (the client_settings / ai_style_calls / client_feature_grants posture)
-- PLUS the explicit revokes 112 established as this repo's convention: a new table ships
-- world-readable by default, and migration 102 is the worked example of that going wrong
-- on billing_plans. The grants table should tell the truth about intent.
alter table public.usage_prices        enable row level security;
alter table public.wallet_accounts     enable row level security;
alter table public.wallet_transactions enable row level security;

revoke all on public.usage_prices        from anon, authenticated;
revoke all on public.wallet_accounts     from anon, authenticated;
revoke all on public.wallet_transactions from anon, authenticated;
revoke all on public.wallet_reconcile    from anon, authenticated;

-- Do NOT grant select on usage_prices "because it's just a price list". Every read goes
-- through an edge function that redacts price_cents when visible = false, exactly as
-- portal-billing does for billing_plans.

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Mutation, only through SECURITY DEFINER functions.
-- ─────────────────────────────────────────────────────────────────────────────
-- Same posture as allocate_ss_invoice_number (125): definer, pinned search_path, execute
-- revoked from every browser role. Refusals are RETURNED as codes rather than raised, so
-- the edge function authors the customer's sentence instead of leaking a Postgres message.

create or replace function public.wallet_hold(
  p_client_id text, p_kind text, p_idem text, p_user uuid
) returns table (hold_id bigint, price_cents integer, balance_after bigint, err text)
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  v_price integer; v_active boolean; v_exempt boolean;
  v_bal bigint; v_held bigint; v_id bigint;
begin
  select up.price_cents, up.active into v_price, v_active
    from public.usage_prices up where up.kind = p_kind;
  if v_price is null then
    return query select null::bigint, null::integer, null::bigint, 'meter_unknown'; return;
  end if;
  if not v_active then
    -- The arming rail: deployed but not charging. The caller proceeds FREE.
    return query select null::bigint, 0, null::bigint, 'meter_inactive'; return;
  end if;

  -- Lock the wallet row for the whole check-and-insert. This is the TOCTOU fix.
  insert into public.wallet_accounts (client_id) values (p_client_id)
    on conflict (client_id) do nothing;
  select w.balance_cents, w.held_cents, w.metered_exempt
    into v_bal, v_held, v_exempt
    from public.wallet_accounts w where w.client_id = p_client_id for update;

  -- An exempt tenant still gets a ROW, at zero. "How many generations did this tenant run
  -- and what did they cost us" must stay answerable for internal accounts, which are
  -- exactly the ones most likely to run a lot of them.
  if v_exempt then v_price := 0; end if;

  if not v_exempt and (v_bal - v_held) < v_price then
    return query select null::bigint, v_price, v_bal, 'insufficient_funds'; return;
  end if;

  -- Release a stale hold rather than blocking on it. This is billing_charge_attempts'
  -- stale-open handling with the OPPOSITE conclusion, deliberately: there a stale row
  -- means we do not know whether a card was charged, so it must block; here it means a
  -- generation crashed and no money left anyone, so auto-resolving is correct.
  update public.wallet_transactions
     set state = 'released', memo = coalesce(memo, '') || ' [stale hold auto-released]'
   where client_id = p_client_id and meter_kind = p_kind and state = 'held'
     and created_at < now() - interval '10 minutes';

  insert into public.wallet_transactions
    (client_id, kind, amount_cents, balance_after_cents, meter_kind, state,
     idempotency_key, ref_type, actor_user_id)
  values (p_client_id, 'debit', -v_price, v_bal, p_kind, 'held',
          nullif(p_idem, ''), 'ai_style_call', p_user)
  returning id into v_id;

  update public.wallet_accounts
     set held_cents = held_cents + v_price, updated_at = now()
   where client_id = p_client_id;

  return query select v_id, v_price, v_bal, null::text;
exception
  when unique_violation then
    -- The one-hold index fired: a second concurrent generation for the same meter.
    return query select null::bigint, v_price, v_bal, 'hold_in_flight';
end $fn$;

create or replace function public.wallet_capture(
  p_hold_id bigint, p_cost_cents integer, p_usage jsonb, p_ref_id text
) returns bigint
language plpgsql security definer set search_path to 'public'
as $fn$
declare v_client text; v_amt bigint; v_bal bigint;
begin
  select client_id, amount_cents into v_client, v_amt
    from public.wallet_transactions where id = p_hold_id and state = 'held' for update;
  if v_client is null then return null; end if;

  -- amount_cents is NEGATIVE for a debit, so a single `+ v_amt` does both halves: the
  -- balance falls by the held amount and the hold is released by the same number.
  update public.wallet_accounts
     set balance_cents = balance_cents + v_amt,
         held_cents    = greatest(0, held_cents + v_amt),
         updated_at    = now()
   where client_id = v_client
  returning balance_cents into v_bal;

  -- Captures the HELD amount, never a fresh price read. A price change mid-generation
  -- must not charge a different number from the one the builder was shown.
  update public.wallet_transactions
     set state = 'posted', posted_at = now(), balance_after_cents = v_bal,
         cost_cents = p_cost_cents, usage = p_usage, ref_id = p_ref_id
   where id = p_hold_id;
  return v_bal;
end $fn$;

create or replace function public.wallet_release(p_hold_id bigint, p_reason text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare v_client text; v_amt bigint;
begin
  select client_id, amount_cents into v_client, v_amt
    from public.wallet_transactions where id = p_hold_id and state = 'held' for update;
  if v_client is null then return; end if;
  update public.wallet_accounts
     set held_cents = greatest(0, held_cents + v_amt), updated_at = now()
   where client_id = v_client;
  update public.wallet_transactions
     set state = 'released', memo = p_reason
   where id = p_hold_id;
end $fn$;

create or replace function public.wallet_credit(
  p_client_id text, p_amount_cents bigint, p_kind text,
  p_ref_type text, p_ref_id text, p_memo text, p_idem text, p_actor uuid
) returns bigint
language plpgsql security definer set search_path to 'public'
as $fn$
declare v_bal bigint; v_existing bigint;
begin
  if p_idem is not null and p_idem <> '' then
    select balance_after_cents into v_existing
      from public.wallet_transactions
     where client_id = p_client_id and idempotency_key = p_idem;
    if v_existing is not null then return v_existing; end if;   -- replay: no-op
  end if;

  insert into public.wallet_accounts (client_id) values (p_client_id)
    on conflict (client_id) do nothing;
  update public.wallet_accounts
     set balance_cents = balance_cents + p_amount_cents, updated_at = now()
   where client_id = p_client_id
  returning balance_cents into v_bal;

  insert into public.wallet_transactions
    (client_id, kind, amount_cents, balance_after_cents, state, idempotency_key,
     ref_type, ref_id, memo, actor_user_id, posted_at)
  values (p_client_id, p_kind, p_amount_cents, v_bal, 'posted', nullif(p_idem, ''),
          p_ref_type, p_ref_id, p_memo, p_actor, now());
  return v_bal;
end $fn$;

revoke execute on function public.wallet_hold(text, text, text, uuid)                       from public, anon, authenticated;
revoke execute on function public.wallet_capture(bigint, integer, jsonb, text)               from public, anon, authenticated;
revoke execute on function public.wallet_release(bigint, text)                               from public, anon, authenticated;
revoke execute on function public.wallet_credit(text, bigint, text, text, text, text, text, uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ ARM THE CHARGE SEPARATELY — do NOT include this in the file above.
-- Deploy portal-settings first, confirm a video draft still works and writes NO wallet
-- row, then run this one statement. Same rail as 109_feature_grants: the deploy is a
-- provable no-op until one boolean moves.
--
--   update public.usage_prices set active = true where kind = 'video_3d_generation';
-- ─────────────────────────────────────────────────────────────────────────────
