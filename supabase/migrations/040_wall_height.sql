-- 016_wall_height: per-size wall height for the 3D view (plan §6 gap #1).
--
-- Additive and inert on its own: nothing reads this column until get_catalog /
-- the derived config surface it. Until then the 3D view reads wallHeightFt from
-- the tenant's config blob (per-style `buildingStyles[].wallHeightFt` or a
-- top-level `wallHeightFt`) and falls back to the 8 ft app default (D3.WALL_H).
--
-- NOT YET APPLIED as of 2026-07-02. Hand-apply via the SQL Editor — NEVER
-- `supabase db push` (see CLAUDE.md: unreconciled migration history would
-- re-run 008-011 and wipe the catalog).

alter table public.building_sizes
  add column if not exists wall_height_ft numeric;

comment on column public.building_sizes.wall_height_ft is
  'Wall plate height in feet for the 3D view; NULL = app default (8 ft).';
