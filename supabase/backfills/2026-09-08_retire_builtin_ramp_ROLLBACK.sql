-- Rollback for 223_retire_builtin_ramp.sql. Captured 2026-09-08 from the live DB immediately
-- BEFORE the delete. Restore the master row first — client_layout_items has an FK onto it.
--
-- NOTE: this does NOT restore the two client_settings changes in 223's step A1
-- (abc-builder ramp_enabled -> false, and the newly created preferred-structures row).
-- To undo those: set abc-builder's ramp_enabled back to true, and delete the
-- preferred-structures client_settings row entirely — it did not exist before.
-- get_config for preferred-structures hashed identically with and without that row
-- (2fde94e983087fdac10121c5e1cac1c3), so creating it changed nothing but the ramp flag.

insert into public.layout_item_types
  (item_key, label, icon, color, default_width, default_height, wall_only, wall_snap, door_snap, short_label, sort_order, active, palette_group)
values ('ramp', 'Ramp', '⬛', '#78716C', 3, 3, false, false, true, 'RAMP', 0, true, 'doors');

insert into public.client_layout_items (client_id, item_key, active, sort_order, archived, taxable, internal_only) values
 ('abc-builder',          'ramp', true,  0, false, true, false),
 ('demo-sheds',           'ramp', true,  0, false, true, false),
 ('preferred-structures', 'ramp', true,  0, false, true, false),
 ('pw-demo-barns',        'ramp', true,  0, false, true, false),
 ('structure-studio',     'ramp', true,  0, false, true, false),
 ('test',                 'ramp', true,  0, false, true, false),
 ('testtttttt',           'ramp', true,  0, false, true, false),
 ('yoder-barns',          'ramp', false, 0, false, true, false);
-- (no label/width/height/short_label overrides existed on any of these 8 rows)
-- (building_size_inclusions had ZERO rows for 'ramp', so none were deleted and none restore here)
