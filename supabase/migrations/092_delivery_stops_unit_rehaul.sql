-- 092_delivery_stops_unit_rehaul: an inventory unit legitimately rides TWO loads over its
-- life — shop → sales lot as a spec build (while 'available'), then lot → customer once
-- sold. The per-unit unique index from 090 forbade the second trip.
--
-- Carolyn 2026-08-04 (beta testing): "every building that is in the build schedule should
-- also show in the delivery schedule" — inventory spec builds included, which is what
-- surfaced this: the spec build's shop→lot haul is a real delivery, and it permanently
-- consumed the unit's one allowed stop.
--
-- The replacement guard lives in portal-schedule's add_stop: a unit may be on at most one
-- OPEN (undelivered) stop at a time; a delivered haul frees it for the sale delivery. The
-- sale stop is distinguished by carrying the buyer's design code (sold_design_short_code),
-- which is also what the pool query and the delivered write-back key on.

drop index if exists public.delivery_stops_one_per_unit;

-- Rollback:
--   create unique index delivery_stops_one_per_unit on public.delivery_stops (client_id, inventory_unit_id)
--     where inventory_unit_id is not null;
