-- 009_colors: rename/replace the flat options table with a purpose-built colors
-- table. Each color row is ticked for siding and/or trim (two booleans, not an
-- enum) so it shows in the Siding Color picker, the Trim Color picker, or both.
-- A color may be typeable (allow_custom) so the rep can enter any color even
-- though it's a dropdown. Price still lives on the row (rate + pricing_method;
-- 0 / positive / negative). Non-color priced selections, if ever needed, would
-- get their own structure later.
--
-- Junior Barns has no named colors: his siding dropdown is just "Unpainted" ($0)
-- and "Custom Color" (typed, +20% of building). NOT YET APPLIED.

drop table if exists public.options;

create table public.colors (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null,
  label          text not null,                       -- 'Unpainted' / 'Custom Color' / 'Barn Red'
  siding         boolean not null default false,      -- usable as a siding color
  trim           boolean not null default false,      -- usable as a trim color
  rate           numeric not null default 0,          -- 0 / positive / NEGATIVE
  pricing_method public.pricing_method not null default 'each',
  image_url      text,                                -- swatch
  allow_custom   boolean not null default false,      -- dropdown entry that lets the rep type any color
  is_default     boolean not null default false,      -- preselected in the picker
  sort_order     int not null default 0,
  active         boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, label),
  constraint colors_usable_somewhere check (siding or trim)   -- can't be usable nowhere
);

create index colors_client_idx on public.colors (client_id, sort_order);

create trigger colors_set_updated_at before update on public.colors
  for each row execute function public.set_updated_at();

alter table public.colors enable row level security;
create policy colors_public_read on public.colors
  for select to anon, authenticated using (true);

-- ── Reseed Junior Barns (siding only; Unpainted $0 default, Custom +20%) ──
insert into public.colors
  (client_id, label, siding, trim, rate, pricing_method, allow_custom, is_default, sort_order)
values
  ('junior-barns','Unpainted',    true, false, 0,  'each',               false, true,  1),
  ('junior-barns','Custom Color',  true, false, 20, 'pct_building_price',  true,  false, 2)
on conflict (client_id, label) do nothing;
