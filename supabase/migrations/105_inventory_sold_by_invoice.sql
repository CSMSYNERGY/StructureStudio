-- 105_inventory_sold_by_invoice: a building is sold by an INVOICE or a PAYMENT, never a button.
--                                And its build status is stated, never set.
--
-- Carolyn, 2026-08-08, after testing what 102 shipped:
--   "There is a Mark Sold button. And we should never be able to mark it sold. Always needs
--    an invoice."
--   "NO SCHEDULING EVER HAPPENS FROM THE INVENTORY PAGE. It should only state the status."
--
-- 102 got the model right and the page wrong: it put a manual sell button and two scheduling
-- shortcuts on a page whose only job is to report. This removes the machinery behind them.
--
-- ── What goes ───────────────────────────────────────────────────────────────────────────
-- accepted_at / accepted_by, and the whole lifecycle_manual override. The `accepted` rung was
-- the ONE state nothing could derive, which is exactly why it needed a button — and the button
-- lived on the Inventory page. PUTTING A BUILDING ON THE BUILD SCHEDULE IS THE APPROVAL: a
-- unit reads `requested` until it has a build job, and `in_queue` the moment it does. A person
-- still decides; they decide it on the production page, where production decisions belong.
--
-- Dropping the override means the status is now a pure projection of build_jobs +
-- delivery_stops. CONSEQUENCE, STATED PLAINLY: a building that was already standing on a lot
-- before this system existed can only reach "Available to sell at Location" by being walked
-- through the schedule. There is no longer any way to assert a status by hand. That is the
-- deliberate trade for a status column that can never disagree with the schedules.
--
-- ── What arrives ────────────────────────────────────────────────────────────────────────
-- sale_released_at / sale_released_from, because a release has to SURVIVE the next automatic
-- claim. Without it, releasing a wrongly-sold building is pointless: the buyer's design is
-- still `invoiced`, so the next sync would re-sell it within seconds. All three claim paths
-- skip a claim originating from the released design. A DIFFERENT estimate can still sell the
-- building later, which is the real case — a re-sale after a cancelled one comes with a new
-- estimate and a new invoice anyway.
--
-- Why a release exists at all, given "always needs an invoice": there is NO way to void a
-- customer invoice anywhere in this product — no action, no button, no inbound GHL webhook —
-- so a CRM-side void is invisible to us. Without this, one mis-clicked invoice would remove a
-- building from sellable stock permanently, short of a hand-written UPDATE.
--
-- ── The payment trigger ─────────────────────────────────────────────────────────────────
-- Money arriving means the building is sold, whether or not an invoice went out through us.
-- This is a TRIGGER rather than edge-function code because payments are inserted straight from
-- the browser under RLS (portal.html's OrdersView) with no edge function in the path — a
-- trigger is the only choke point that cannot be bypassed, and it keeps working when the
-- Orders tab ships to tenants (it is operator-only today).
--
-- ⚠️ orders/payments live in this database but their migrations are on the unmerged
-- wip/orders branch. A trigger is safe to add from here in a way that orders.order_type was
-- not: it is self-contained and needs nothing on the other branch to populate it. Migration
-- 078 already sets the precedent for touching `orders` from beta.

-- ── Retire the hand-set columns ─────────────────────────────────────────────────────────
alter table public.inventory_units
  drop constraint if exists inventory_units_lifecycle_manual_check,
  drop constraint if exists inventory_units_lifecycle_basis_check,
  drop constraint if exists inventory_units_lifecycle_manual_paired;

drop index if exists public.inventory_units_queueable;   -- was `where accepted_at is not null`

alter table public.inventory_units
  drop column accepted_at,
  drop column accepted_by,
  drop column lifecycle_manual,
  drop column lifecycle_manual_basis,
  drop column lifecycle_manual_at,
  drop column lifecycle_manual_by;

-- ── A release the automatic claims respect ──────────────────────────────────────────────
alter table public.inventory_units
  add column sale_released_at   timestamptz,
  add column sale_released_from text;

comment on column public.inventory_units.sale_released_from is
  'Design code this unit was last released FROM. Every automatic sale claim skips this code, '
  'so a release is not undone by the next sync. A different estimate can still sell the unit.';

-- ── Money arrived ⇒ sold ────────────────────────────────────────────────────────────────
-- Mirrors the compare-and-swap the edge functions use: the `sale_state = 'unsold'` predicate
-- means a second claim matches zero rows rather than overwriting the first buyer. Voided
-- payments are ignored on the way in; a payment voided LATER does not release the building
-- (releasing is a deliberate, audited act — see unsell_inventory).
create or replace function public.inventory_claim_on_payment()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_unit  uuid;
  v_code  text;
  v_first text;
begin
  if new.voided_at is not null then
    return new;
  end if;

  -- payments.order_id → orders.short_code → designs.inventory_unit_id. orders.short_code is a
  -- soft link (a future manual order has none), so a payment against an order with no design
  -- simply finds nothing and this is a no-op.
  select d.inventory_unit_id, d.short_code, split_part(btrim(coalesce(d.contact->>'name','')), ' ', 1)
    into v_unit, v_code, v_first
    from public.orders o
    join public.designs d
      on d.client_id = o.client_id and d.short_code = o.short_code
   where o.id = new.order_id and o.client_id = new.client_id
     and d.inventory_unit_id is not null
   limit 1;

  if v_unit is null then
    return new;
  end if;

  update public.inventory_units
     set sale_state             = 'sold',
         sold_design_short_code = v_code,
         sold_first_name        = nullif(v_first, ''),
         sold_at                = coalesce(new.received_at, now()),
         updated_at             = now()
   where id = v_unit
     and client_id = new.client_id
     and sale_state = 'unsold'
     -- Do not undo a deliberate release. Re-selling this building needs a new estimate.
     and (sale_released_from is null or sale_released_from is distinct from v_code);

  return new;
end
$$;

revoke execute on function public.inventory_claim_on_payment() from public, anon, authenticated;

drop trigger if exists payments_claim_inventory on public.payments;
create trigger payments_claim_inventory
  after insert on public.payments
  for each row execute function public.inventory_claim_on_payment();

-- Rollback:
--   drop trigger if exists payments_claim_inventory on public.payments;
--   drop function if exists public.inventory_claim_on_payment();
--   alter table public.inventory_units
--     drop column sale_released_at, drop column sale_released_from;
--   -- then re-apply 102's accepted_at / lifecycle_manual block if the override is ever wanted
--   -- back (see 102_inventory_lifecycle.sql; note the ladder loses a rung with it).
