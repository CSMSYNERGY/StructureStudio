-- 214_consume_unlock_after_insert.sql — spend the unlock AFTER the change order exists.
--
-- THE BUG 211 SHIPPED, found by driving the real flow on beta rather than by reading it.
-- 211's guard is a BEFORE INSERT trigger, and it consumed the unlock inside that trigger:
--
--     update public.order_unlocks
--        set consumed_at = now(), consumed_by_change_order = new.id ...
--
-- `new.id` is the row's id, but the row DOES NOT EXIST YET — a BEFORE trigger runs ahead of
-- the insert. So `order_unlocks.consumed_by_change_order` pointed at nothing and Postgres
-- refused with `violates foreign key constraint order_unlocks_consumed_by_change_order_fkey`.
-- Every unlock-authorised change order was impossible to open. The free-window path never hit
-- it (no unlock to consume), which is exactly why 211's own behavioural probe passed: it runs
-- with the regime dormant, where the gate answers free_window and unlock_id is null.
--
-- ⚠️ THE LESSON FOR THE NEXT PROBE. A probe that only exercises the default configuration
-- proves the default configuration. 211's probe asserted `raised_under = 'free_window'` and
-- was RIGHT to — but the branch that mattered had no test at all until a real request went
-- through the real endpoint. PART 3 below adds the missing one.
--
-- THE FIX: stamping stays in the BEFORE trigger (it must, to write NEW's own columns), and
-- consumption moves to an AFTER INSERT trigger, where the change order is a real row.
-- `change_orders_stamp_agreed` (migration 153) is already an AFTER trigger on this table for
-- the same class of reason, so the shape is the established one.
--
-- Rejected: making the FK DEFERRABLE INITIALLY DEFERRED. That would have made the write
-- succeed while leaving the ordering wrong, and a deferred constraint hides the next mistake
-- of this shape until commit — further from the cause, not closer.
--
-- Rollback: drop the AFTER trigger and put the update block back into change_orders_guard's
-- INSERT branch (and accept that unlock-authorised change orders cannot be created).

-- ── PART 1 — take consumption out of the BEFORE trigger ────────────────────────────────
-- Re-issued verbatim from 211 with ONLY the `if new.unlock_id is not null then ... end if;`
-- block removed from the INSERT branch. Everything else — the co_no sequence, the gate
-- refusal, the stamping, the freeze list, the void release — is unchanged.
create or replace function public.change_orders_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_trusted boolean := auth.uid() is null;
  v_gate jsonb;
  v_rate numeric;
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtext('ss_co_no:' || new.client_id || ':' || new.short_code));
    select coalesce(max(co_no), 0) + 1 into new.co_no
      from public.change_orders
     where client_id = new.client_id and short_code = new.short_code;
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_at := now();

    v_gate := public.order_amendment_gate(new.client_id, new.short_code);
    if not coalesce((v_gate->>'open')::boolean, true) then
      raise exception '%', coalesce(v_gate->>'reason',
        'this order is signed — an admin or crew leader has to unlock it before it can be changed');
    end if;

    new.raised_under := v_gate->>'authority';
    new.unlock_id    := nullif(v_gate->>'unlock_id', '')::uuid;
    new.fee_cents    := coalesce((v_gate->>'fee_cents')::int, 0);
    new.fee_taxable  := coalesce((v_gate->>'fee_taxable')::boolean, false);

    if new.fee_taxable and coalesce(new.fee_cents, 0) > 0 then
      select nullif(coalesce(d.accepted_snapshot->'estimateLines'->'tax'->>'rate',
                             d.estimate_lines->'tax'->>'rate'), '')::numeric
        into v_rate
        from public.designs d
       where d.client_id = new.client_id and d.short_code = new.short_code;
      if v_rate is not null and v_rate > 0 and v_rate <= 0.25 then
        new.fee_tax_cents := round(new.fee_cents * v_rate);
      else
        new.fee_tax_cents := 0;
      end if;
    else
      new.fee_tax_cents := 0;
    end if;

    -- The unlock is spent by change_orders_consume_unlock(), AFTER this row exists. See 214.

    if new.status = 'acknowledged' then
      if new.ack_method = 'signature' and not v_trusted then
        raise exception 'a signature acknowledgment can only be recorded by the signing flow';
      end if;
      if new.ack_method = 'verbal' then
        new.verbal_recorded_by := coalesce(auth.uid(), new.verbal_recorded_by);
        new.acknowledged_at := coalesce(new.acknowledged_at, now());
      end if;
    end if;
    return new;
  end if;

  new.updated_at := now();
  new.co_no := old.co_no;
  new.created_by := old.created_by;
  new.created_at := old.created_at;

  new.unlock_id     := old.unlock_id;
  new.raised_under  := old.raised_under;
  new.fee_cents     := old.fee_cents;
  new.fee_tax_cents := old.fee_tax_cents;
  new.fee_taxable   := old.fee_taxable;

  if new.ack_method = 'signature' and old.ack_method is distinct from 'signature' and not v_trusted then
    raise exception 'a signature acknowledgment can only be recorded by the signing flow';
  end if;

  if old.status = 'draft' and new.status not in ('draft', 'pending_ack', 'void') then
    raise exception 'a draft change order can only be sent for approval or discarded';
  end if;
  if new.status = 'draft' and old.status is distinct from 'draft' then
    raise exception 'a change order cannot go back to draft — void it and raise a new one';
  end if;

  if old.status = 'acknowledged' then
    if new.status = 'pending_ack' then
      raise exception 'an acknowledged change order cannot go back to pending — void it and raise a new one';
    end if;
    if new.description is distinct from old.description
       or new.total_before_cents is distinct from old.total_before_cents
       or new.total_after_cents  is distinct from old.total_after_cents
       or new.version_before is distinct from old.version_before
       or new.version_after  is distinct from old.version_after
       or new.ack_method is distinct from old.ack_method
       or new.acceptance_id is distinct from old.acceptance_id
       or new.verbal_rep_name is distinct from old.verbal_rep_name
       or new.verbal_conversation_date is distinct from old.verbal_conversation_date
       or new.acknowledged_at is distinct from old.acknowledged_at then
      raise exception 'an acknowledged change order is frozen — void it and raise a new one';
    end if;
  end if;

  if new.status = 'void' and old.status <> 'void' then
    if new.void_reason is null or btrim(new.void_reason) = '' then
      raise exception 'voiding a change order needs a reason';
    end if;
    new.voided_at := coalesce(new.voided_at, now());
    -- CLOSER #3 (210): give the unlock back. Safe in a BEFORE trigger — it only clears
    -- consumed_at on a row that already exists and points at a change order that also
    -- already exists.
    if old.unlock_id is not null then
      update public.order_unlocks
         set consumed_at = null,
             release_reason = 'change order CO-' || old.co_no || ' was voided'
       where id = old.unlock_id and consumed_by_change_order = old.id and released_at is null;
    end if;
  end if;

  if new.status = 'acknowledged' and old.status = 'pending_ack' and new.ack_method = 'verbal' then
    new.verbal_recorded_by := coalesce(auth.uid(), new.verbal_recorded_by);
    new.acknowledged_at := coalesce(new.acknowledged_at, now());
  end if;

  return new;
end;
$fn$;

-- ── PART 2 — the AFTER trigger that actually spends it ─────────────────────────────────
create or replace function public.change_orders_consume_unlock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- Guarded on consumed_at so two concurrent inserts cannot both claim one grant; the
  -- one-live-amendment index already makes that race nearly impossible, and "nearly" is not
  -- the standard for a permission being spent.
  if new.unlock_id is not null then
    update public.order_unlocks
       set consumed_at = now(), consumed_by_change_order = new.id
     where id = new.unlock_id and consumed_at is null and released_at is null;
  end if;
  return null;  -- AFTER trigger; the return value is ignored
end;
$fn$;

revoke execute on function public.change_orders_consume_unlock() from public, anon, authenticated;

drop trigger if exists change_orders_consume_unlock_trg on public.change_orders;
create trigger change_orders_consume_unlock_trg
  after insert on public.change_orders
  for each row execute function public.change_orders_consume_unlock();

-- ── PART 3 — the probe 211 was missing: the UNLOCK branch, end to end. ─────────────────
-- Rolled back, leaves nothing. This is the path that was broken, so this is the path that
-- gets proved.
do $$
declare
  cid text; code text; u_id uuid; got record; got_unlock record;
begin
  select d.client_id, d.short_code into cid, code
    from public.designs d
   where d.accepted_at is not null
     and not exists (select 1 from public.change_orders c
                      where c.client_id = d.client_id and c.short_code = d.short_code
                        and c.status in ('draft','pending_ack'))
   limit 1;
  if code is null then
    raise notice '214: no signed order free of a live change order — probe skipped';
    return;
  end if;

  begin
    -- Force the regime ON for this tenant inside the sub-transaction, so the probe exercises
    -- the unlock branch whatever the tenant's real settings say.
    update public.client_settings
       set co_unlock_required = true, co_free_days = 0, co_fee_cents = 12345, co_fee_taxable = false
     where client_id = cid;

    if (public.order_amendment_gate(cid, code)->>'open')::boolean then
      raise exception '214 probe: the order should be LOCKED with the regime on and no unlock';
    end if;

    insert into public.order_unlocks (client_id, short_code, reason, decision, decided_at, expires_at)
    values (cid, code, '214 probe', 'granted', now(), now() + interval '1 hour')
    returning * into got_unlock;
    u_id := got_unlock.id;

    if not (public.order_amendment_gate(cid, code)->>'open')::boolean then
      raise exception '214 probe: the gate still refuses with a live unlock in place';
    end if;

    insert into public.change_orders (client_id, short_code, source, status, description)
    values (cid, code, 'manual', 'draft', '214 probe — rolled back')
    returning * into got;

    if got.raised_under <> 'unlock' then
      raise exception '214 probe: expected raised_under=unlock, got %', got.raised_under;
    end if;
    if got.unlock_id is distinct from u_id then
      raise exception '214 probe: the change order did not record the unlock it spent';
    end if;
    if coalesce(got.fee_cents, -1) <> 12345 then
      raise exception '214 probe: the fee was not stamped (%)', got.fee_cents;
    end if;

    -- THE REGRESSION THIS FILE EXISTS FOR.
    select * into got_unlock from public.order_unlocks where id = u_id;
    if got_unlock.consumed_at is null then
      raise exception '214 probe: the unlock was not consumed';
    end if;
    if got_unlock.consumed_by_change_order is distinct from got.id then
      raise exception '214 probe: the unlock does not name the change order that spent it';
    end if;

    -- And voiding gives it back.
    update public.change_orders set status = 'void', void_reason = '214 probe' where id = got.id;
    select * into got_unlock from public.order_unlocks where id = u_id;
    if got_unlock.consumed_at is not null then
      raise exception '214 probe: voiding the change order did not release the unlock';
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '214: unlock branch proved end to end (gate, stamp, consume, release)';
      else
        raise;
      end if;
  end;
end $$;
