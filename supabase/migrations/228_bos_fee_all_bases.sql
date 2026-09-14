-- 228_bos_fee_all_bases: the build-on-site fee can be charged by ANY of the seven pricing
-- methods, not just three. Applied live 2026-09-14; this file records what ran.
--
-- WHY. Carolyn 2026-09-14, shown the layout-item method list: "All these but each is flat
-- rate." The fee was limited to each / sqft_building / perimeter_building by the 183 check
-- constraint; the other four already have formulas everywhere else in the product (layout
-- items since 006, cladding since 221), so opening the constraint is the only schema change.
-- How each resolves for a wall-height fee lives in _shared/buildOnSite.ts (server) and the
-- designer's build-on-site rows (preview); they mirror cladding's whole-building reading:
-- sqft_option = wall area at the billed height, lineal_ft = perimeter.
--
-- Safe to run before the code ships: nothing writes the new values until the portal offers
-- them, and the old three stay valid.

begin;

alter table public.style_wall_heights
  drop constraint if exists style_wall_heights_bos_basis_check;
alter table public.style_wall_heights
  add  constraint style_wall_heights_bos_basis_check
  check (bos_fee_basis is null or bos_fee_basis in (
    'each', 'lineal_ft', 'sqft_option', 'sqft_building', 'perimeter_building',
    'pct_building_price', 'pct_estimate_total'));

comment on column public.style_wall_heights.bos_fee_basis is
  'How the build-on-site fee is charged — any of the seven layout-item pricing methods (each = flat call-out; sqft_option = per sq ft of WALL at the billed height; lineal_ft = per ft of perimeter; pct_* = a percentage). NULL reads as ''each''.';

commit;

-- ROLLBACK (only if no row holds one of the four new values):
-- alter table public.style_wall_heights drop constraint style_wall_heights_bos_basis_check;
-- alter table public.style_wall_heights add constraint style_wall_heights_bos_basis_check
--   check (bos_fee_basis is null or bos_fee_basis in ('each', 'sqft_building', 'perimeter_building'));
