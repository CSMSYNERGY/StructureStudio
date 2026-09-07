-- 215_gate_open_while_amending.sql — an order with a live change on it is already open.
--
-- ⚠️ THE NUMBER 215 IS SHARED with 215_invoice_sends_ghl_sender.sql, which landed on beta
-- from a parallel branch while this was being written (214 is doubled for the same reason).
-- Neither touches the other's objects. The authority for what was applied and when is the
-- database's own migration ledger, where this is recorded as 215_gate_open_while_amending.
--
-- THE BUG 210 SHIPPED, found by driving the whole flow end to end on beta rather than by
-- reading it. The sequence is the ORDINARY one, not an edge case:
--
--   1. The approver grants an unlock.                      → gate: open, authority 'unlock'
--   2. open_amendment creates the draft and SPENDS it.     → order_unlocks.consumed_at = now()
--   3. The rep opens the designer and makes the change.    → gate: **LOCKED**
--
-- Step 3 is the entire point of steps 1 and 2. `order_amendment_gate` looked for an unspent
-- unlock, and by then there is deliberately none — it was spent to authorise the very change
-- the rep is now trying to make. So `stage_order_attribute_change` refused with "An admin or
-- crew leader has to unlock it", and submit-estimate's pre-check (2026-09-07) would have
-- refused the designer resubmit for the same reason. The rep could open a change and then
-- could not make it. Observed on SS-8ARZNP3RCX:
--
--   {"error":"This order is signed. An admin or crew leader has to unlock it before it can be
--     changed.","reason":"locked"}   ← on the staging call, one step after a granted unlock
--
-- ⚠️ WHY NOT "STOP CONSUMING THE UNLOCK UNTIL THE CHANGE IS FINISHED". That was the other
-- available fix and it is worse: consumption is what stops ONE grant authorising a second,
-- later change, and deferring it to acknowledgment leaves the order standing open for as long
-- as a rep leaves a draft sitting there — which is indefinitely. The grant is spent when it is
-- used. What was missing is that a change already underway is its own authority.
--
-- THE FIX: a live change order (draft or pending_ack) makes the order open, ahead of the free
-- window and the unlock search. Authority 'amendment'. The fee is reported as 0 because the
-- fee for this change is already stamped and frozen on that row — re-reporting the tenant's
-- current fee here is how a rep gets charged twice for one change, which is the trap the
-- guard trigger's UPDATE branch already freezes those columns against.
--
-- This closes on its own, three ways, all of which already exist: the change is acknowledged,
-- it is voided (which also hands the unlock back), or it is discarded. There is no new state.
--
-- Rollback: re-apply 210's body verbatim (this file re-issues it with one block inserted).

create or replace function public.order_amendment_gate(p_client_id text, p_short_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare
  v_accepted_at timestamptz;
  v_ordered_at  timestamptz;
  v_required    boolean;
  v_free_days   int;
  v_fee_cents   int;
  v_fee_taxable boolean;
  v_unlock      public.order_unlocks;
  v_free_until  timestamptz;
  v_live        public.change_orders;
begin
  select d.accepted_at into v_accepted_at
    from public.designs d
   where d.client_id = p_client_id and d.short_code = p_short_code;

  -- NOT YET COMMITTED: there is nothing to re-open and nothing to sign again. `accepted_at`
  -- is the durable fact 197 chose over `status` for exactly this test.
  if v_accepted_at is null then
    return jsonb_build_object('signed', false, 'open', true, 'authority', 'pre_signature',
                              'unlock_id', null, 'expires_at', null,
                              'fee_cents', 0, 'fee_taxable', false,
                              'reason', 'This order has not been accepted yet.');
  end if;

  select cs.co_unlock_required, cs.co_free_days, cs.co_fee_cents, cs.co_fee_taxable
    into v_required, v_free_days, v_fee_cents, v_fee_taxable
    from public.client_settings cs
   where cs.client_id = p_client_id;

  -- THE REGIME IS OFF (the default, 209). Today's behaviour, unchanged.
  if coalesce(v_required, false) = false then
    return jsonb_build_object('signed', true, 'open', true, 'authority', 'free_window',
                              'unlock_id', null, 'expires_at', null,
                              'fee_cents', 0, 'fee_taxable', false,
                              'reason', 'Changing a signed order does not need an unlock at this builder.');
  end if;

  -- ── 215: A CHANGE ALREADY UNDERWAY IS ITS OWN AUTHORITY. ────────────────────────────
  -- Placed ahead of the free window and the unlock search because it outranks both: whatever
  -- let this change be opened has already been checked, recorded on the row, and — in the
  -- case of an unlock — spent. fee_cents is 0 here on purpose; the fee for this change is
  -- frozen on the change_orders row and must not be re-quoted per keystroke.
  select c.* into v_live
    from public.change_orders c
   where c.client_id = p_client_id and c.short_code = p_short_code
     and c.status in ('draft', 'pending_ack')
   order by c.co_no desc
   limit 1;

  if v_live.id is not null then
    return jsonb_build_object('signed', true, 'open', true, 'authority', 'amendment',
                              'unlock_id', v_live.unlock_id, 'expires_at', null,
                              'fee_cents', 0, 'fee_taxable', false,
                              'change_order_id', v_live.id, 'co_no', v_live.co_no,
                              'reason', 'A change is already open on this order (CO-' || v_live.co_no || ').');
  end if;

  select o.ordered_at into v_ordered_at
    from public.orders o
   where o.client_id = p_client_id and o.short_code = p_short_code;
  -- An order row written before the ensure-order trigger, or a design-less order: fall back
  -- to the acceptance itself, which is the same day for every order the trigger did write.
  v_free_until := coalesce(v_ordered_at, v_accepted_at) + make_interval(days => coalesce(v_free_days, 0));

  if now() < v_free_until then
    return jsonb_build_object('signed', true, 'open', true, 'authority', 'free_window',
                              'unlock_id', null, 'expires_at', v_free_until,
                              'fee_cents', 0, 'fee_taxable', false,
                              'reason', 'Inside this builder''s free-change window.');
  end if;

  select u.* into v_unlock
    from public.order_unlocks u
   where u.client_id = p_client_id and u.short_code = p_short_code
     and u.decision = 'granted'
     and u.consumed_at is null and u.released_at is null
     and u.expires_at > now()
   order by u.decided_at desc
   limit 1;

  if v_unlock.id is not null then
    return jsonb_build_object('signed', true, 'open', true, 'authority', 'unlock',
                              'unlock_id', v_unlock.id, 'expires_at', v_unlock.expires_at,
                              'fee_cents', coalesce(v_fee_cents, 0),
                              'fee_taxable', coalesce(v_fee_taxable, true),
                              'reason', 'Unlocked.');
  end if;

  return jsonb_build_object('signed', true, 'open', false, 'authority', null,
                            'unlock_id', null, 'expires_at', null,
                            'fee_cents', coalesce(v_fee_cents, 0),
                            'fee_taxable', coalesce(v_fee_taxable, true),
                            'reason', 'This order is signed. An admin or crew leader has to unlock it before it can be changed.');
end;
$fn$;

-- ── The behavioural probe: the exact three steps that failed on beta. ───────────────────
-- Rolled back, leaves nothing. 214's lesson applied: this exercises the branch that broke,
-- not the default configuration.
do $$
declare
  cid text; code text; u_id uuid; co_id uuid; g jsonb;
begin
  select d.client_id, d.short_code into cid, code
    from public.designs d
   where d.accepted_at is not null
     and not exists (select 1 from public.change_orders c
                      where c.client_id = d.client_id and c.short_code = d.short_code
                        and c.status in ('draft','pending_ack'))
   limit 1;
  if code is null then
    raise notice '215: no signed order free of a live change order — probe skipped';
    return;
  end if;

  begin
    update public.client_settings
       set co_unlock_required = true, co_free_days = 0, co_fee_cents = 15000, co_fee_taxable = false
     where client_id = cid;

    -- Step 1 — the approver grants.
    insert into public.order_unlocks (client_id, short_code, reason, decision, decided_at, expires_at)
    values (cid, code, '215 probe', 'granted', now(), now() + interval '1 hour')
    returning id into u_id;

    g := public.order_amendment_gate(cid, code);
    if (g->>'authority') <> 'unlock' then
      raise exception '215 probe: expected authority=unlock before the change is opened, got %', g->>'authority';
    end if;

    -- Step 2 — the change is opened, which SPENDS the unlock (214).
    insert into public.change_orders (client_id, short_code, source, status, description)
    values (cid, code, 'design_edit', 'draft', '215 probe — rolled back')
    returning id into co_id;

    if (select consumed_at from public.order_unlocks where id = u_id) is null then
      raise exception '215 probe: the unlock was not spent — 214 has regressed';
    end if;

    -- Step 3 — THE REGRESSION THIS FILE EXISTS FOR. Before 215 this said open=false, and the
    -- rep could not edit the change they had just been given permission to make.
    g := public.order_amendment_gate(cid, code);
    if not (g->>'open')::boolean then
      raise exception '215 probe: the order LOCKED against the rep mid-change (%)', g->>'reason';
    end if;
    if (g->>'authority') <> 'amendment' then
      raise exception '215 probe: expected authority=amendment, got %', g->>'authority';
    end if;
    if coalesce((g->>'fee_cents')::int, -1) <> 0 then
      raise exception '215 probe: the fee must not be re-quoted mid-change (got %)', g->>'fee_cents';
    end if;
    if (g->>'change_order_id') is distinct from co_id::text then
      raise exception '215 probe: the gate did not name the change that is open';
    end if;

    -- And it closes again when the change goes away.
    update public.change_orders set status = 'void', void_reason = '215 probe' where id = co_id;
    g := public.order_amendment_gate(cid, code);
    if (g->>'authority') = 'amendment' then
      raise exception '215 probe: a voided change still holds the order open';
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '215: grant -> open -> EDIT proved end to end, and it closes again';
      else
        raise;
      end if;
  end;
end $$;
