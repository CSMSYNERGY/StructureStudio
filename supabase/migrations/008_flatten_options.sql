-- 008_flatten_options: replace the options + option_choices + option_pricing
-- trio with a SINGLE flat options table. Each row is one selectable, priced
-- option value; rows sharing a group_key render as one control (dropdown / cards
-- / counter). Price lives on the row as `rate` (0 / positive / NEGATIVE) with a
-- versatile pricing_method, so a client can price an option flat (each), per sq
-- ft (sqft_building), as a % of the building (pct_building_price), etc.
--
-- Decision: option prices do NOT vary by building style (paint is the same price
-- on every style), so there is no per-style matrix for options. Per-style
-- placeables (loft, doors, …) still live in layout_item_pricing.
--
-- Safe to replace: the old trio was inert (nothing reads it yet) and only held
-- the Junior Barns paint seed, reseeded below. NOT YET APPLIED.

drop table if exists public.option_pricing;
drop table if exists public.option_choices;
drop table if exists public.options;

create table public.options (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null,
  group_key      text not null,                       -- ties rows into one control, e.g. 'paint_color'
  group_label    text not null,                       -- 'Paint Color'
  input_type     text not null default 'dropdown',    -- 'dropdown' | 'cards' | 'counter'
  allow_custom   boolean not null default false,      -- let the customer type their own value
  label          text not null,                       -- 'Barn Red' | 'Unpainted' | 'Painted'
  image_url      text,
  rate           numeric not null default 0,          -- per-row value; 0 / positive / NEGATIVE
  pricing_method public.pricing_method not null default 'each',
  is_default     boolean not null default false,      -- preselected value in the control
  sort_order     int not null default 0,
  active         boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, group_key, label)
);

create index options_client_group_idx on public.options (client_id, group_key, sort_order);

create trigger options_set_updated_at before update on public.options
  for each row execute function public.set_updated_at();

alter table public.options enable row level security;
create policy options_public_read on public.options
  for select to anon, authenticated using (true);

-- ── Reseed Junior Barns paint (Unpainted $0 default; Painted +20% of base) ──
insert into public.options
  (client_id, group_key, group_label, input_type, allow_custom, label, rate, pricing_method, is_default, sort_order)
values
  ('junior-barns','paint_color','Paint Color','dropdown', false, 'Unpainted', 0,  'each',               true,  1),
  ('junior-barns','paint_color','Paint Color','dropdown', false, 'Painted',   20, 'pct_building_price',  false, 2)
on conflict (client_id, group_key, label) do nothing;
