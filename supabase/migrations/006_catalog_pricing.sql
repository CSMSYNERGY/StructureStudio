-- 006_catalog_pricing: per-client building catalog + pricing, moving the price
-- book out of GHL and into Supabase. After cutover, submit-estimate computes
-- every line-item amount from these tables and pushes ad-hoc line items to GHL
-- (the same call path custom options already use) instead of matching GHL
-- products by name.
--
-- Additive and inert on its own: nothing reads these tables until the derived
-- config + submit-estimate rework lands. Does NOT touch designs or client_configs.
--
-- NOT YET APPLIED as of 2026-06-11.

-- Pricing methods a rate can use. The estimate calc resolves each to dollars at
-- submit time, in this order: base price -> flat/per-unit/area items ->
-- pct_building_price -> pct_estimate_total (which must be resolved last).
create type public.pricing_method as enum (
  'each',                 -- rate x quantity
  'lineal_ft',            -- rate x linear feet (e.g. workbench length)
  'sqft_option',          -- rate x the option's own area
  'sqft_building',        -- rate x (width_ft * depth_ft)
  'perimeter_building',   -- rate x 2*(width_ft + depth_ft)
  'pct_building_price',   -- rate% x base price of the chosen size
  'pct_estimate_total'    -- rate% x estimate subtotal (resolved last)
);

-- ── Catalog structure ────────────────────────────────────────────────
create table public.building_styles (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null,
  key        text not null,                 -- stable slug, e.g. 'urban'
  label      text not null,                 -- display, e.g. 'Urban'
  image_url  text,
  sort_order int  not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, key)
);

create table public.building_sizes (
  id         uuid primary key default gen_random_uuid(),
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

create table public.options (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null,
  key        text not null,                 -- stable slug, e.g. 'paint'
  label      text not null,
  type       text not null,                 -- 'counter' | 'image_cards'
  sort_order int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, key)
);

create table public.option_choices (
  id         uuid primary key default gen_random_uuid(),
  option_id  uuid not null references public.options(id) on delete cascade,
  key        text not null,                 -- e.g. 'painted'
  label      text not null,                 -- e.g. 'Painted'
  image_url  text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (option_id, key)
);

-- ── Pricing ─────────────────────────────────────────────────────────
-- A row = "this choice is offered on this style," priced by method + rate.
-- rate 0 renders as "Included / $0". No row = the choice isn't offered there.
create table public.option_pricing (
  id                  uuid primary key default gen_random_uuid(),
  option_choice_id    uuid not null references public.option_choices(id) on delete cascade,
  style_id            uuid not null references public.building_styles(id) on delete cascade,
  pricing_method      public.pricing_method not null default 'each',
  rate                numeric not null default 0,
  line_item_image_url text,                 -- optional image for the GHL line item
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (option_choice_id, style_id)
);

-- Placeable layout items (doors, windows, workbench, rough openings, lofts,
-- ramps). Their placement BEHAVIOUR stays in the front-end layoutItems config;
-- only the PRICE lives here, keyed by the item's stable type key, per style.
create table public.layout_item_pricing (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null,
  item_key       text not null,            -- matches layoutItems key in config
  style_id       uuid not null references public.building_styles(id) on delete cascade,
  pricing_method public.pricing_method not null default 'each',
  rate           numeric not null default 0,
  image_url      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, item_key, style_id)
);

-- Lookup indexes for the per-client reads the designer/portal/estimate make.
create index building_styles_client_idx      on public.building_styles (client_id, sort_order);
create index building_sizes_style_idx        on public.building_sizes (style_id, sort_order);
create index options_client_idx              on public.options (client_id, sort_order);
create index option_choices_option_idx       on public.option_choices (option_id, sort_order);
create index option_pricing_style_idx        on public.option_pricing (style_id);
create index layout_item_pricing_client_idx  on public.layout_item_pricing (client_id, item_key);

-- Keep updated_at fresh (reuses the existing hardened trigger fn from 004).
create trigger building_styles_set_updated_at      before update on public.building_styles      for each row execute function public.set_updated_at();
create trigger building_sizes_set_updated_at       before update on public.building_sizes       for each row execute function public.set_updated_at();
create trigger options_set_updated_at              before update on public.options              for each row execute function public.set_updated_at();
create trigger option_choices_set_updated_at       before update on public.option_choices       for each row execute function public.set_updated_at();
create trigger option_pricing_set_updated_at       before update on public.option_pricing       for each row execute function public.set_updated_at();
create trigger layout_item_pricing_set_updated_at  before update on public.layout_item_pricing  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────
-- Public read: the catalog (branding + inventory + prices) is not sensitive,
-- same stance as client_configs. Writes are service-role only for now (portal
-- onboarding / admin functions); owner-scoped write policies come with the
-- portal editing UI.
alter table public.building_styles      enable row level security;
alter table public.building_sizes       enable row level security;
alter table public.options              enable row level security;
alter table public.option_choices       enable row level security;
alter table public.option_pricing       enable row level security;
alter table public.layout_item_pricing  enable row level security;

create policy building_styles_public_read     on public.building_styles      for select to anon, authenticated using (true);
create policy building_sizes_public_read      on public.building_sizes       for select to anon, authenticated using (true);
create policy options_public_read             on public.options              for select to anon, authenticated using (true);
create policy option_choices_public_read      on public.option_choices       for select to anon, authenticated using (true);
create policy option_pricing_public_read      on public.option_pricing       for select to anon, authenticated using (true);
create policy layout_item_pricing_public_read on public.layout_item_pricing  for select to anon, authenticated using (true);

-- ── Per-client designer pricing toggle ──────────────────────────────
-- When true, the customer-facing designer shows prices/upcharges; the derived
-- public config surfaces this flag. Default off.
alter table public.client_settings
  add column if not exists show_pricing boolean not null default false;
