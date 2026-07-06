-- 030_drop_building_style_catalog: retire the obsolete GLOBAL building-style master.
--
-- Why: new tenants now get their building styles via the admin "Clone" feature (which copies
-- a template CLIENT's full catalog) or per-client create_style — never by assigning from this
-- global template. Per-client building_styles/building_sizes are independent COPIES (no FK to
-- the master), so dropping these tables does NOT touch any tenant's styles. All code that
-- referenced them (admin-catalog get_master / assign_style / save_master_style and the
-- create_style key-collision checks in admin-catalog + portal-settings) was removed in the
-- same change.
--
-- KEPT on purpose: layout_item_types (the master LAYOUT-ITEM palette) — the public get_catalog
-- and the portal still read it for item labels/defaults. This migration does NOT touch it.
--
-- Child first (building_style_catalog_sizes references building_style_catalog ON DELETE CASCADE).
drop table if exists public.building_style_catalog_sizes;
drop table if exists public.building_style_catalog;
