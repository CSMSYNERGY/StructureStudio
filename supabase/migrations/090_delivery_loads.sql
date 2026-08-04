-- 090_delivery_loads: the Load Planner — one driver (with their truck), one day, one route.
--
-- The Delivery Schedule is NOT a kanban (decision 5): the unit of scheduling is a LOAD
-- holding ordered STOPS. Loads group buildings by territory (one route), size (deck-fit
-- against the assigned driver's snapshotted deck length), and build dates.
--
-- Key rules encoded here:
--   * deck_length_ft / max_width_ft are SNAPSHOTS from the driver's profile at assignment —
--     capacity math on past loads must not change when a driver upgrades trucks.
--   * The built-before-delivered invariant is enforced in portal-schedule (a load can't go
--     out/delivered while a stop's build job isn't kind='done'), with an owner/admin
--     override that stamps override_reason/overridden_by/overridden_at (decision 11) and
--     is rendered as a permanent inline chip. Width has NO override.
--   * Unassigned deliveries are NOT rows here — the "to be loaded" pool is a QUERY
--     (built order jobs / sold units / open field repairs without a stop). No double
--     bookkeeping.
--   * leg_miles = distance from the PREVIOUS stop (from the shop/lot for stop 1) —
--     hand-entered in v1, computed by the maps integration later (decision 10).

-- ── Loads ─────────────────────────────────────────────────────────────────────
create table public.delivery_loads (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  load_no bigint,
  driver_user_id uuid,
  deck_length_ft numeric,
  max_width_ft numeric,
  load_date date,
  route_label text,
  miles_out numeric,
  miles_back numeric,
  is_wide boolean not null default false,
  permit_status text not null default 'not_needed'
    check (permit_status in ('not_needed','needed','on_file')),
  status text not null default 'planned'
    check (status in ('planned','out','delivered')),
  departed_at timestamptz,
  completed_at timestamptz,
  notes text,
  override_reason text,
  overridden_by uuid,
  overridden_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, load_no)
);
create index delivery_loads_client on public.delivery_loads (client_id, load_date desc);
alter table public.delivery_loads enable row level security;
create policy delivery_loads_owner_select on public.delivery_loads
  for select to authenticated using (client_id = current_client_id());

-- Per-tenant load number, #1 up — same advisory-lock pattern as orders/repairs.
create function public.delivery_loads_assign_no()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  perform pg_advisory_xact_lock(hashtext('ss_load_no:' || new.client_id));
  select coalesce(max(load_no), 0) + 1 into new.load_no
    from public.delivery_loads where client_id = new.client_id;
  return new;
end;
$$;
create trigger delivery_loads_assign_no_trg
  before insert on public.delivery_loads
  for each row when (new.load_no is null or new.load_no = 0)
  execute function public.delivery_loads_assign_no();

-- ── Stops (ordered, everything-at-face-value rows) ───────────────────────────
create table public.delivery_stops (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  load_id uuid not null references public.delivery_loads(id) on delete cascade,
  stop_order integer not null default 1,
  source text not null check (source in ('order','inventory','repair','manual')),
  -- The cross-link: null for already-built lot units, field repairs, and manual hauls.
  build_job_id uuid references public.build_jobs(id) on delete set null,
  design_short_code text,
  inventory_unit_id uuid references public.inventory_units(id) on delete set null,
  repair_id uuid references public.repairs(id) on delete cascade,
  serial bigint,
  customer_name text,
  customer_phone text,
  building_label text,
  width_ft numeric,
  length_ft numeric,
  -- 'shop' or a builder_locations id as text — sold lot units start at the lot.
  pickup text not null default 'shop',
  dest_street text,
  dest_city text,
  dest_state text,
  dest_zip text,
  territory_id uuid references public.delivery_territories(id) on delete set null,
  lat numeric,
  lng numeric,
  leg_miles numeric,
  time_window text,
  site_notes text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index delivery_stops_load on public.delivery_stops (client_id, load_id, stop_order);
create index delivery_stops_build_job on public.delivery_stops (build_job_id)
  where build_job_id is not null;
-- One delivery per sold building/unit. NOT unique on repair_id: a shop repair legitimately
-- gets a pick-up stop AND a return stop.
create unique index delivery_stops_one_per_design on public.delivery_stops (client_id, design_short_code)
  where design_short_code is not null;
create unique index delivery_stops_one_per_unit on public.delivery_stops (client_id, inventory_unit_id)
  where inventory_unit_id is not null;
alter table public.delivery_stops enable row level security;
create policy delivery_stops_owner_select on public.delivery_stops
  for select to authenticated using (client_id = current_client_id());

-- Rollback:
--   drop table public.delivery_stops;
--   drop trigger delivery_loads_assign_no_trg on public.delivery_loads;
--   drop function public.delivery_loads_assign_no();
--   drop table public.delivery_loads;
