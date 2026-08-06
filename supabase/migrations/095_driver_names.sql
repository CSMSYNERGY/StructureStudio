-- 095_driver_names: drivers get their OWN NAME, and a portal login becomes optional
-- (Carolyn 2026-08-05: "I need to be able to give our drivers names"). Same philosophy as
-- build_crews (094): most drivers never log in; the profile row is the identity, a linked
-- login is a bonus (it's what lets them tap "Delivered" from the field).
--
-- Shape change: driver_profiles was keyed (client_id, user_id) with user_id required.
-- Now every profile has its own `id`, `display_name` carries the typed name, user_id is
-- nullable (at most one profile per login, enforced by a partial unique index), and
-- delivery_loads gains `driver_id` → the profile (backfilled from driver_user_id, which
-- stays for legacy rows and the driver's own field access).

alter table public.driver_profiles add column id uuid not null default gen_random_uuid();
alter table public.driver_profiles add column display_name text;
alter table public.driver_profiles drop constraint driver_profiles_pkey;
alter table public.driver_profiles add primary key (id);
alter table public.driver_profiles alter column user_id drop not null;
create unique index driver_profiles_one_per_user on public.driver_profiles (client_id, user_id)
  where user_id is not null;

alter table public.delivery_loads add column driver_id uuid
  references public.driver_profiles(id) on delete set null;
update public.delivery_loads l set driver_id = p.id
  from public.driver_profiles p
 where p.client_id = l.client_id and p.user_id = l.driver_user_id
   and l.driver_user_id is not null;

-- Rollback:
--   alter table public.delivery_loads drop column driver_id;
--   drop index driver_profiles_one_per_user;
--   alter table public.driver_profiles alter column user_id set not null;
--   alter table public.driver_profiles drop constraint driver_profiles_pkey;
--   alter table public.driver_profiles add primary key (client_id, user_id);
--   alter table public.driver_profiles drop column display_name, drop column id;
