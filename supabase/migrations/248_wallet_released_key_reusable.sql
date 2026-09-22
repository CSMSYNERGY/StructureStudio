-- 248 — a RELEASED hold must not refuse the next press for the rest of the tab's life.
--
-- THE BUG THIS CLOSES. `calGenerate` mints one idempotency key per press and clears it only on
-- a landed draft, keyed by style, so every failure leaves that key in the ref for the life of
-- the tab. That is deliberate and correct: it is what makes a retry of a failed press reuse its
-- key instead of taking a second $20 hold. The database is the half that does not hold up its
-- end of it.
--
-- `wallet_tx_idem` is unique on (client_id, idempotency_key) with NO state predicate (128:121),
-- so a row keeps its key after it is released. A 110 s model timeout calls
-- `releaseHold("model timeout")`: the money goes back, the row stays, state = 'released',
-- key = K. The next press reuses K, `wallet_hold`'s insert raises unique_violation, and its
-- exception handler — which cannot tell WHICH index fired — answers 'hold_in_flight' (151:104).
-- portal-settings turns that into 409 "A 3D generation is already running for this account -
-- wait for it to finish." and deletes the ledger row it had just written.
--
-- The key is never re-minted, so that 409 repeats for EVERY later press on that style, not only
-- for the retry of the one that failed. The builder is told to wait for a generation that
-- finished minutes ago, forever, and nothing lands in ai_style_calls to show it happened. The
-- only escapes are a page reload or a generation on some other style, and neither is
-- discoverable; the natural act — pressing Generate again — never works.
--
-- Worse in the money direction when the SERVER SUCCEEDS and the reply never arrives (a network
-- drop, a gateway 504 after `wallet_capture`): $20 is spent, the promise rejects so the key is
-- kept, the row is state='posted' with key K, and every retry is that same 409. Paid, no draft,
-- no way to retry, and the sentence on screen is about something else entirely.
--
-- THE FIX, IN TWO HALVES, BOTH HERE. The index says "one row ever per key"; what it means is
-- "one CHARGE per intent". A released hold took no money from anyone, so its key must not stand
-- in the way of that same intent being tried again.
--
--   1. `wallet_tx_idem` becomes partial on state <> 'released'. A retry after a release then
--      simply inserts, with no collision and no new code path — the common case fixes itself.
--   2. `wallet_hold`'s blanket unique_violation handler learns to look. On a collision it reads
--      the surviving row for that key: state='posted' returns a NEW code, 'hold_replayed', so
--      the caller can say something true about money that has already been spent; anything else
--      (including a collision with no such row, which is the one-hold index firing) stays
--      'hold_in_flight'.
--
-- WHY NOT SIMPLY CLEAR THE KEY IN THE BROWSER. Because it reopens the double-hold that minting
-- a key was written to close, the moment the classification of "did this release?" is ever
-- wrong — and because it cannot help the paid-and-lost case at all. This half can.
--
-- TIMING AND BLAST RADIUS. `usage_prices.video_3d_generation.active` is still false, so
-- wallet_hold returns 'meter_inactive' before any wallet_transactions row exists and the trap
-- cannot fire today — which is exactly why this lands BEFORE the boolean moves rather than
-- after the first builder is locked out. The index rebuild touches a table that on this project
-- holds no rows for this meter at all. `wallet_credit` (top-ups) is unaffected: it looks its key
-- up BEFORE inserting, and its rows are 'posted', which the partial index still covers.
--
-- Apply by hand (SQL editor / MCP / `supabase db query --linked -f`) and record as 248. NEVER
-- `supabase db push` — see the migration ledger note on 126. Safe to re-run.
--
-- Rollback: recreate `wallet_tx_idem` without the predicate and re-apply 151's `wallet_hold`
-- body verbatim. Nothing else here needs reversing.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The index says what it means.
-- ─────────────────────────────────────────────────────────────────────────────
-- 'void' stays INSIDE the constraint deliberately. It is in the state check and is written
-- nowhere in this codebase; a voided row is not a released one, and if it ever starts being
-- written it should keep blocking replays until somebody decides otherwise.
drop index if exists public.wallet_tx_idem;
create unique index if not exists wallet_tx_idem
  on public.wallet_transactions (client_id, idempotency_key)
  where idempotency_key is not null and state <> 'released';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. wallet_hold stops guessing which index fired.
-- ─────────────────────────────────────────────────────────────────────────────
-- 151's body verbatim except for the exception block at the end. Repeated in full because
-- `create or replace function` has no other form, and because a money function that gets read
-- in a hurry should be readable in one place.
create or replace function public.wallet_hold(
  p_client_id text, p_kind text, p_idem text, p_user uuid
) returns table (hold_id bigint, price_cents integer, balance_after bigint, err text)
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  v_price integer; v_active boolean; v_exempt boolean;
  v_bal bigint; v_held bigint; v_id bigint; v_stale bigint;
  v_prev_state text; v_prev_id bigint;
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

  -- An exempt tenant still gets a ROW, at zero.
  if v_exempt then v_price := 0; end if;

  -- Release a stale hold rather than blocking on it (151). BOTH halves: the ledger flip and
  -- the held_cents credit, because amount_cents is negative for a debit.
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
    -- WHICH INDEX FIRED. 151 could not tell and answered 'hold_in_flight' for both, which is
    -- how a released key came to read as a generation still running. So look the key up. The
    -- partial index above means a row found here is 'held' or 'posted', never 'released'.
    if p_idem is null or p_idem = '' then
      -- No key to collide on, so it was wallet_tx_one_hold: a genuine second generation.
      return query select null::bigint, v_price, v_bal, 'hold_in_flight'; return;
    end if;
    select t.id, t.state into v_prev_id, v_prev_state
      from public.wallet_transactions t
     where t.client_id = p_client_id and t.idempotency_key = p_idem
       and t.state <> 'released'
     order by t.id desc
     limit 1;
    if v_prev_state = 'posted' then
      -- PAID ALREADY, for this exact intent. The caller must not capture again, and must not
      -- tell the builder to wait for something that finished. hold_id stays null: there is no
      -- live hold, and a caller handed the posted row as one would capture it twice.
      return query select null::bigint, v_price, v_bal, 'hold_replayed'; return;
    end if;
    -- 'held', or no row at all (the one-hold index). Both mean something is running.
    return query select null::bigint, v_price, v_bal, 'hold_in_flight'; return;
end $fn$;

-- Re-asserted rather than assumed (151): `create or replace` keeps the existing grants, but a
-- money function must not depend on how it was last re-applied.
revoke execute on function public.wallet_hold(text, text, text, uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Refuse to report success if either half did not land. Same posture as 226 and 247.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare v_pred text;
begin
  select pg_get_expr(i.indpred, i.indrelid) into v_pred
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
   where c.relname = 'wallet_tx_idem';
  if v_pred is null then
    raise exception '248 did not land: wallet_tx_idem still has no state predicate';
  end if;
  if position('released' in v_pred) = 0 then
    raise exception '248 did not land: wallet_tx_idem predicate does not exclude released rows (%)', v_pred;
  end if;
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'wallet_hold'
      and position('hold_replayed' in pg_get_functiondef(p.oid)) > 0
  ) then
    raise exception '248 did not land: wallet_hold does not return hold_replayed';
  end if;
end $$;
