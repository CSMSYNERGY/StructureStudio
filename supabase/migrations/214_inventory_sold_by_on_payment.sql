-- 214_inventory_sold_by_on_payment: record WHO sold the building when a payment is what
-- sells it (Carolyn, 2026-09-07 — "basically everything that any user does is tracked").
--
-- ── THE GAP ─────────────────────────────────────────────────────────────────────────────
-- 105 documents three server-side paths that can mark an inventory building sold:
--
--   1. portal-settings' claimUnitSale, from send_invoice  →  sets sold_by (the caller). ✅
--   2. sync-design-status, when the CRM reports it        →  leaves sold_by NULL, ON PURPOSE:
--      "nobody clicked anything, the CRM did". Correct, and left alone here.
--   3. THIS TRIGGER, when money is recorded against the order  →  set every other sale
--      column and silently skipped sold_by. ⛔
--
-- So a building sold by taking a deposit recorded who bought it, when, and for which design,
-- and lost the only thing that answers "who sold this" — while the very same sale through the
-- invoice button recorded it. Two paths to one outcome, disagreeing about whether the seller
-- is worth keeping.
--
-- ⚠️ THIS IS PROSPECTIVE, NOT A REPAIR. Measured 2026-09-07: all 7 inventory units are
--    `unsold`, so nothing has ever taken this path and there is nothing to backfill. A 0/7
--    fill rate on sold_by was READ AS a missing writer earlier in this session and was not —
--    it was an empty table. The bug is real; the damage is not yet.
--
-- ── WHERE THE ACTOR COMES FROM ──────────────────────────────────────────────────────────
-- `new.created_by` — the person who recorded the payment. The portal sets it on every insert
-- (04-orders.jsx: `created_by: uid` from auth.getUser()), and payments are inserted straight
-- from the browser under RLS, which is exactly why 105 put this logic in a trigger rather
-- than a function: the trigger is the only choke point a browser insert cannot bypass.
--
-- COALESCEd with auth.uid() rather than used alone. Six of the nine payment rows on live
-- predate that portal line and carry no created_by; for a browser insert auth.uid() is the
-- same person anyway, and for a service-role insert both are null and sold_by stays null —
-- which is the honest answer, not a guess. NULL here has always meant "we do not know who",
-- and this must not start meaning "probably whoever".
--
-- Everything else in the function is unchanged from the live definition, including the
-- compare-and-swap on `sale_state = 'unsold'` (so two concurrent claims cannot both win) and
-- the sale_released_from guard (so a deliberately released building is not instantly re-sold
-- by the same design).

CREATE OR REPLACE FUNCTION public.inventory_claim_on_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_unit  uuid;
  v_code  text;
  v_first text;
begin
  if new.voided_at is not null then
    return new;
  end if;

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
         -- The only line this migration adds. See the header for why it is COALESCEd and why
         -- NULL is allowed to survive.
         sold_by                = coalesce(new.created_by, auth.uid()),
         updated_at             = now()
   where id = v_unit
     and client_id = new.client_id
     and sale_state = 'unsold'
     and (sale_released_from is null or sale_released_from is distinct from v_code);

  return new;
end
$function$;

-- Rollback: re-apply the body above without the `sold_by` line.
