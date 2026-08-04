-- 088_territories_drivers: delivery territories (broad corridors) + per-driver truck specs.
--
-- Carolyn 2026-08-04: territories are BROAD CORRIDORS, not city lists — "Hwy 50 west of
-- Linn to Kansas City, the I-70 corridor and everything in between, as far north as the
-- Iowa line". The description IS the definition (written the way you'd brief a new
-- driver); deliberately NO geometry column — polygon/corridor matching can arrive with
-- the maps work without a schema change. Stops pick a territory from a dropdown in v1.
--
-- Drivers are team members with their own truck (decision 9): deck length drives the
-- capacity bar on every one of THEIR loads, max width caps what they can haul (the one
-- non-overridable rule), territory routes the right work to the right driver. Managed on
-- the existing Settings → Team page via portal-schedule.

-- ── Territories (defined once per company) ───────────────────────────────────
create table public.delivery_territories (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  name text not null,
  description text,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, name)
);
create index delivery_territories_client on public.delivery_territories (client_id, sort_order);
alter table public.delivery_territories enable row level security;
create policy delivery_territories_owner_select on public.delivery_territories
  for select to authenticated using (client_id = current_client_id());

-- ── Driver profiles (a team member's truck + territories) ────────────────────
-- Same shape and posture as commission_members (077): keyed (client_id, user_id),
-- SERVICE-ROLE ONLY. Not confidential like comp, but write-gating belongs to the edge
-- function (owner/admin only via resolveTenant), and reads come back through
-- portal-schedule responses joined to names — the browser never queries this directly.
create table public.driver_profiles (
  client_id text not null,
  user_id uuid not null,
  is_driver boolean not null default false,
  truck_name text,
  deck_length_ft numeric check (deck_length_ft is null or deck_length_ft > 0),
  max_width_ft numeric check (max_width_ft is null or max_width_ft > 0),
  wide_load_capable boolean not null default true,
  -- Usually one; a driver can cover several and two drivers can share one (decision 9b).
  territory_ids uuid[] not null default '{}',
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (client_id, user_id)
);
alter table public.driver_profiles enable row level security;
-- No RLS policies on purpose (service-role only), and revoke the default grants.
revoke all on public.driver_profiles from anon, authenticated;

-- Rollback:
--   drop table public.driver_profiles;
--   drop table public.delivery_territories;
