-- 037_style_estimate_image: per-building-style toggle for whether the style's photo is
-- attached to the GHL estimate's building line item.
--
-- Default TRUE = today's behavior (the building-style image shows on the estimate). An owner
-- can uncheck a style in the portal Pricing tab (Building styles) to omit its image from the
-- estimate. Only affects the ESTIMATE attachment — the designer still shows the style photo.
--
-- NB: applied to live via MCP on 2026-07-06; this NNN_ file is the repo record.

alter table public.building_styles
  add column if not exists show_image_on_estimate boolean not null default true;
