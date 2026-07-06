-- 013_deactivate_unpriced_sizes: a building size with NULL base_price is "not
-- yet priced" and must not be SELECTABLE in the designer (get_catalog filters
-- active sizes, so an active NULL-priced size would otherwise surface with
-- basePrice=null). Deactivate such sizes. The building_sizes_set_updated_at
-- trigger (006/011) bumps updated_at automatically on this UPDATE.
--
-- NULL-base-price contract (source of truth):
--   base_price IS NULL => not yet priced  => MUST be active=false.
--   base_price = 0      => intentionally free / included (distinct from NULL).
--   base_price > 0      => priced normally.
-- When a price is later set via the portal, set base_price AND flip active=true
-- in the same edit.
--
-- NON-DESTRUCTIVE + REVERSIBLE: no row is deleted; only a boolean flips. Today
-- affects exactly one seeded row (junior-barns northwood 8x20, see 007).
-- Idempotent (the active=true guard makes re-runs a true no-op).
--
-- To make the change perfectly reversible, snapshot the affected ids first:
--   create table public.building_sizes_active_bak_013 as
--     select id from public.building_sizes where base_price is null and active = true;
--   -- revert with:
--   --   update public.building_sizes set active = true
--   --   where id in (select id from public.building_sizes_active_bak_013);

update public.building_sizes
   set active = false
 where base_price is null
   and active = true;
