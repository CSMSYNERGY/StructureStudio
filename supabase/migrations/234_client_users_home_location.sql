-- 234_client_users_home_location: a team member's home sales lot. Applied live 2026-09-14.
--
-- WHY. Delivery (233) can measure miles "from the rep's location" (Carolyn 2026-09-14: "if it is
-- from builder location, or from the reps location or from ANY location. they decide in
-- settings"). Nothing linked a person to a lot before this: builder_locations (075) hold the
-- lots, client_users (001/100) hold the people, and inventory_units was the only table pointing
-- at a location. Set under Settings → Company → Team ("Home lot"), written only by
-- portal-commissions set_home_location, which checks the lot belongs to the caller's tenant —
-- the FK below cannot express that (builder_locations.client_id is text, not part of the key).
--
-- NULL = no home lot; delivery_settings.origin_mode = 'rep' then falls back to 'nearest'.

begin;

alter table public.client_users
  add column if not exists location_id uuid
    references public.builder_locations(id) on delete set null;

comment on column public.client_users.location_id is
  'Home sales lot (Settings → Company → Team). Delivery origin when delivery_settings.origin_mode = rep; NULL falls back to the nearest origin. Tenant match is enforced by portal-commissions, not by this FK.';

commit;
