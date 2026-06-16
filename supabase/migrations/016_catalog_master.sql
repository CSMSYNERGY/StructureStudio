-- 016_catalog_master: operator-owned MASTER catalog for layout items + building
-- styles, plus the per-client layout-item assignment table. The master tables
-- are GLOBAL (no client_id); the per-client building-style assignment reuses the
-- existing building_styles/building_sizes tables (no new table for styles).
--
-- Read by get_config (SECURITY DEFINER, after 019) and the admin-catalog edge
-- function (service role). Anon/authenticated get no direct access (RLS in 017).
-- Additive + inert until 018 seeds and 019 rewires get_config. HAND-APPLY only
-- (never db push). BOM-free.

-- ── Global master: layout item TYPES (geometry/flags/icon — the definitions
--    that currently live only in client_configs.layout_items jsonb) ──
create table public.layout_item_types (
  item_key       text primary key,              -- 'singleDoor','window',… (matches layout_items keys)
  label          text not null,
  icon           text not null default '',
  color          text not null default '#000000',
  default_width  numeric not null default 3,    -- feet
  default_height numeric not null default 3,    -- feet
  wall_only      boolean not null default false,
  wall_snap      boolean not null default false,
  door_snap      boolean not null default false,
  short_label    text not null default '',
  sort_order     int    not null default 0,
  active         boolean not null default true, -- master kill switch
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger layout_item_types_set_updated_at
  before update on public.layout_item_types
  for each row execute function public.set_updated_at();

-- ── Global master: building style catalog (thin: key/label/default image) ──
create table public.building_style_catalog (
  key               text primary key,            -- e.g. 'Econo' (matches config building_styles[].value)
  label             text not null,
  default_image_url text,
  sort_order        int  not null default 0,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger building_style_catalog_set_updated_at
  before update on public.building_style_catalog
  for each row execute function public.set_updated_at();

-- Master default sizes per style — the template cloned into building_sizes when a
-- style is assigned to a client (so an assigned style starts with sizes).
create table public.building_style_catalog_sizes (
  id         uuid primary key default gen_random_uuid(),
  style_key  text not null references public.building_style_catalog(key) on delete cascade,
  label      text not null,                       -- '8x12'
  width_ft   numeric not null,
  depth_ft   numeric not null,
  sort_order int not null default 0,
  unique (style_key, label)
);

-- ── Per-client layout-item assignment (which items this tenant gets) ──
-- *_override columns are NULL => inherit the master layout_item_types value.
create table public.client_layout_items (
  client_id            text not null,
  item_key             text not null references public.layout_item_types(item_key) on delete cascade,
  active               boolean not null default true,
  sort_order           int    not null default 0,
  label_override       text,
  width_override       numeric,
  height_override      numeric,
  short_label_override text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (client_id, item_key)
);
create index client_layout_items_client_idx on public.client_layout_items (client_id, sort_order);
create trigger client_layout_items_set_updated_at
  before update on public.client_layout_items
  for each row execute function public.set_updated_at();
