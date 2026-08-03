-- 085_qbo_window_ramp_kinds.sql — add 'window' and 'ramp' to qbo_item_map.line_kind.
--
-- Same story as 067 (which added 'door'), for the other two fixture categories.
-- submit-estimate tags fixtures-catalog windows `{kind:"window"}` and every ramp
-- (custom fixture OR the simple per-each / per-ft ramp) `{kind:"ramp"}`, but neither
-- was a legal line_kind — so qboInvoice's resolver fell through to `fallback||` for
-- them. That is silent mis-billing when a fallback IS set (a window bills against
-- whatever generic item the fallback names) and an aborted push when it is not
-- ("unmapped: window (…), ramp (…)"). Neither kind takes an item_key or a style
-- override, exactly like door/paint/roof, so the shape constraints from 066 need
-- no change.

alter table public.qbo_item_map
  drop constraint qbo_item_map_line_kind_check;

alter table public.qbo_item_map
  add constraint qbo_item_map_line_kind_check check (line_kind in (
    'building', 'paint', 'roof', 'door', 'window', 'ramp', 'layout_item',
    'custom_option', 'discount', 'delivery', 'fallback'));
