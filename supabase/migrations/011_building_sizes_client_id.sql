-- 011_building_sizes_client_id: give building_sizes its own client_id column,
-- matching the other catalog tables (building_styles / options /
-- layout_item_pricing), which all carry client_id directly. Until now
-- building_sizes reached its tenant only indirectly via style_id ->
-- building_styles.client_id.
--
-- client_id is placed as the 2nd column (after id), consistent with where we
-- want tenant scoping to read in every catalog table. Because Postgres can't
-- reorder columns in place, this recreates the table with the desired column
-- order and backfills client_id from each row's parent style (all 'junior-barns'
-- today). No external FK references building_sizes, so the recreate is safe.
--
-- NB: on the live DB this landed as two migrations (an additive
-- `building_sizes_client_id` then a `building_sizes_reorder_client_id_second`
-- recreate). This file collapses both into the single end-state for a clean
-- repo; reconcile naming with the rest of the timestamp-vs-NNN divergence per
-- CUTOVER_HANDOFF.md.

create table public.building_sizes_new (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null,
  style_id   uuid not null references public.building_styles(id) on delete cascade,
  label      text not null,                 -- "8x12"
  width_ft   numeric not null,
  depth_ft   numeric not null,
  base_price numeric,                        -- flat, per style x size; NULL = not yet priced
  sort_order int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (style_id, label)
);

-- Carry existing rows over, backfilling client_id from the parent style.
insert into public.building_sizes_new
  (id, client_id, style_id, label, width_ft, depth_ft, base_price, sort_order, active, created_at, updated_at)
select bs.id, bst.client_id, bs.style_id, bs.label, bs.width_ft, bs.depth_ft,
       bs.base_price, bs.sort_order, bs.active, bs.created_at, bs.updated_at
from public.building_sizes bs
join public.building_styles bst on bst.id = bs.style_id;

drop table public.building_sizes;            -- cascades its own indexes/trigger/policy
alter table public.building_sizes_new rename to building_sizes;

-- Rebuild lookup indexes (style index from 006, plus the new per-client one).
create index building_sizes_style_idx  on public.building_sizes (style_id, sort_order);
create index building_sizes_client_idx on public.building_sizes (client_id, sort_order);

-- Keep updated_at fresh (reuses the hardened trigger fn from 004).
create trigger building_sizes_set_updated_at
  before update on public.building_sizes
  for each row execute function public.set_updated_at();

-- RLS: same public-read stance as the rest of the catalog (006).
alter table public.building_sizes enable row level security;
create policy building_sizes_public_read
  on public.building_sizes for select to anon, authenticated using (true);
