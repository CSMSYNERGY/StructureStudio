-- 010_layout_item_pricing_defaults: kill the per-style duplication. style_id is
-- now NULLABLE: a NULL row is the default price for ALL styles; a row with a
-- style_id is an override for just that style. The estimate calc resolves the
-- style-specific row first, then falls back to the NULL default. So an item only
-- ever gets extra rows where a style is a genuine exception (e.g. loft is
-- $2/sqft everywhere but included/$0 on Farmland).
--
-- Rebuild (table was inert, seed only). Junior: 28 rows -> 8. NOT YET APPLIED.

drop table if exists public.layout_item_pricing;

create table public.layout_item_pricing (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null,
  item_key       text not null,                       -- matches layoutItems key in config
  style_id       uuid references public.building_styles(id) on delete cascade,  -- NULL = default for all styles
  pricing_method public.pricing_method not null default 'each',
  rate           numeric not null default 0,
  image_url      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One default per item, and at most one override per (item, style).
create unique index layout_item_pricing_default_uniq
  on public.layout_item_pricing (client_id, item_key) where style_id is null;
create unique index layout_item_pricing_override_uniq
  on public.layout_item_pricing (client_id, item_key, style_id) where style_id is not null;
create index layout_item_pricing_lookup_idx
  on public.layout_item_pricing (client_id, item_key);

create trigger layout_item_pricing_set_updated_at before update on public.layout_item_pricing
  for each row execute function public.set_updated_at();

alter table public.layout_item_pricing enable row level security;
create policy layout_item_pricing_public_read on public.layout_item_pricing
  for select to anon, authenticated using (true);

-- ── Reseed Junior Barns: 7 defaults + 1 Farmland loft override ──
insert into public.layout_item_pricing (client_id, item_key, style_id, pricing_method, rate) values
  ('junior-barns','singleDoor',   null, 'each',        0),
  ('junior-barns','doubleDoor',   null, 'each',        200),
  ('junior-barns','window',       null, 'each',        300),
  ('junior-barns','workbench',    null, 'lineal_ft',   25),
  ('junior-barns','ramp',         null, 'each',        200),
  ('junior-barns','roughOpening', null, 'each',        100),
  ('junior-barns','loft',         null, 'sqft_option', 2);

insert into public.layout_item_pricing (client_id, item_key, style_id, pricing_method, rate)
select 'junior-barns', 'loft', bs.id, 'sqft_option', 0
from public.building_styles bs
where bs.client_id = 'junior-barns' and bs.key = 'farmland';
