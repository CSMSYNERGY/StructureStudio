-- 151 — the stale-hold sweep must give the money back, not just mark the ledger row.
--
-- THE BUG THIS CLOSES: `wallet_hold` (128) releases a stale hold in ONE half. It flips
-- `wallet_transactions.state` to 'released' and stops there; `wallet_accounts.held_cents`
-- is never credited back. Every other path in 128 does both halves — `wallet_release`
-- (`held_cents = greatest(0, held_cents + v_amt)`) and `wallet_capture` — so the sweep is
-- the one place the stored column and the ledger are allowed to disagree.
--
-- What that costs a builder, concretely. A $20 hold is written, then the isolate dies mid
-- generation (a wall-clock kill on a slow Anthropic call, or portal-settings' own
-- capture-failure branch, which deliberately walks away saying "the hold will age out and
-- auto-release, which is the safe direction for them"). Eleven minutes later they retry:
-- the sweep marks the orphan released, the fresh hold adds another $20, and `held_cents`
-- now reads $40 against ONE genuinely held row. Capture subtracts one price. Available
-- (`balance - held`, what the Billing card and the "generations left" tile both read) is
-- permanently $20 short, and it is not cosmetic — `wallet_hold`'s own funds check reads
-- that same inflated number, so the frozen money gates every future generation. Each crash
-- freezes another $20. Nothing self-heals: this project has NO pg_cron (128 says so at the
-- wallet_accounts comment), `wallet_reconcile` only REPORTS the drift, and there is no
-- operator repair in the product either — `wallet_set_limits` patches only `metered_exempt`
-- and the monthly cap, and `wallet_adjust` moves `balance_cents`. The only fix was a hand
-- UPDATE with direct DB access.
--
-- AND THE ORDERING, which is the half that turns a leak into a lock-out. The
-- `insufficient_funds` early return sits ABOVE the sweep, and the `v_held` it reads
-- includes the stale hold. A tenant left at exactly one price of balance against one stale
-- hold returns 402 before reaching the only statement that would clear that hold — the
-- stale row blocks its own release. So the sweep moves above the funds check here: a hold
-- old enough to be swept is money nobody is owed and must not be counted against them.
--
-- TIMING. The meter is still disarmed (`usage_prices.active = false`, and 128's arming
-- statement is deliberately not in any file), so no hold has ever been written and the
-- repair below should touch zero rows today. That is the point of landing this BEFORE the
-- arming flip rather than after the first frozen wallet.
--
-- Apply by hand (SQL editor / MCP / `supabase db query --linked -f`) and record as 151.
-- NEVER `supabase db push` — see the migration ledger note on 126. Safe to re-run: the
-- function is a replace, and the repair only writes wallets that are actually adrift.
--
-- Rollback: re-apply 128's `wallet_hold` body verbatim. Nothing else here needs reversing —
-- the repair only moves a stored column back onto the ledger it was always meant to match.

create or replace function public.wallet_hold(
  p_client_id text, p_kind text, p_idem text, p_user uuid
) returns table (hold_id bigint, price_cents integer, balance_after bigint, err text)
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  v_price integer; v_active boolean; v_exempt boolean;
  v_bal bigint; v_held bigint; v_id bigint; v_stale bigint;
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

  -- Release a stale hold rather than blocking on it. This is billing_charge_attempts'
  -- stale-open handling with the OPPOSITE conclusion, deliberately: there a stale row
  -- means we do not know whether a card was charged, so it must block; here it means a
  -- generation crashed and no money left anyone, so auto-resolving is correct.
  --
  -- Auto-resolving means BOTH halves. amount_cents is negative for a debit, so
  -- `held_cents + v_stale` hands the money back exactly the way wallet_release does; the
  -- ledger flip on its own is what froze $20 per crashed generation. And this runs ABOVE
  -- the funds check on purpose — the stale hold used to be counted against the balance
  -- that decides whether we ever reach this statement at all.
  with swept as (
    update public.wallet_transactions
       set state = 'released', memo = coalesce(memo, '') || ' [stale hold auto-released]'
     where client_id = p_client_id and meter_kind = p_kind and state = 'held'
       and created_at < now() - interval '10 minutes'
    returning amount_cents
  )
  select coalesce(sum(amount_cents), 0) into v_stale from swept;

  if v_stale <> 0 then
    update public.wallet_accounts
       set held_cents = greatest(0, held_cents + v_stale), updated_at = now()
     where client_id = p_client_id
    returning held_cents into v_held;
  end if;

  if not v_exempt and (v_bal - v_held) < v_price then
    return query select null::bigint, v_price, v_bal, 'insufficient_funds'; return;
  end if;

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

-- Re-asserted rather than assumed: `create or replace` keeps the existing grants, but if
-- this file is ever applied after someone has dropped the function, EXECUTE comes back to
-- PUBLIC by default. On a money function that must not depend on how it was re-applied.
revoke execute on function public.wallet_hold(text, text, text, uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- One-time repair: put held_cents back on the ledger.
-- ─────────────────────────────────────────────────────────────────────────────
-- The ledger is authoritative (128, wallet_accounts), so the truth for a wallet is the sum
-- of its rows still in state 'held'. Any wallet the old sweep touched reads high by one or
-- more prices; this writes the ledger's answer back. Idempotent — a wallet already in
-- agreement is not written, so re-running is a no-op and updated_at does not churn.
--
-- Row by row under `for update` rather than one set-based UPDATE off wallet_reconcile: that
-- view's aggregate is a snapshot, and a wallet_hold committing between the read and the
-- write would have its brand-new hold overwritten away. wallet_hold takes this same lock
-- before it inserts, so holding it here makes the recompute and the write one atomic step.
-- There is nothing to race today (the meter is disarmed), but this is the statement an
-- operator reaches for again the next time wallet_reconcile shows drift.
do $repair$
declare r record; v_ledger bigint; v_fixed integer := 0;
begin
  for r in select client_id from public.wallet_accounts order by client_id for update loop
    select coalesce(-sum(amount_cents), 0) into v_ledger
      from public.wallet_transactions
     where client_id = r.client_id and state = 'held';
    update public.wallet_accounts
       set held_cents = v_ledger, updated_at = now()
     where client_id = r.client_id and held_cents <> v_ledger;
    if found then v_fixed := v_fixed + 1; end if;
  end loop;
  raise notice '151: held_cents realigned with the ledger on % wallet(s)', v_fixed;
end
$repair$;
