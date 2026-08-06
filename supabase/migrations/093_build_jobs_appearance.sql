-- 093_build_jobs_appearance: the build card leads with the BUILDING (Carolyn 2026-08-04,
-- mockup approved): style+size headline, then roof type, then colors, then customer.
-- Roof + colors get snapshotted onto the job at creation (like customer/size already are),
-- with hex values resolved from the tenant's colors catalog at snapshot time so the card
-- renders true swatches without a join on every read.
--
-- Shapes (verified against live data 2026-08-04): designs.selections uses keys
-- style / size / roofType / roofColor (NOT buildingStyle/buildingSize — portal-schedule
-- read the wrong keys until this change, which is why early cards showed no building or
-- dimensions); designs.paint_colors is { body, trim }; colors.label + colors.hex.

alter table public.build_jobs
  add column roof_type text,
  add column roof_color text,
  add column body_color text,
  add column trim_color text,
  add column roof_color_hex text,
  add column body_color_hex text,
  add column trim_color_hex text;

-- Rollback:
--   alter table public.build_jobs
--     drop column roof_type, drop column roof_color, drop column body_color,
--     drop column trim_color, drop column roof_color_hex, drop column body_color_hex,
--     drop column trim_color_hex;
