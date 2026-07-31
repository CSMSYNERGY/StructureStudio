-- 067_qbo_door_kind.sql — add 'door' to qbo_item_map.line_kind.
--
-- The 066 enum predates the fixtures-catalog doors (064, 2026-07-30), which create
-- estimate lines that are neither a layout_item (no layout_item_pricing row) nor a
-- custom option (catalog-priced). Without a kind of their own, every door line would
-- bill against the fallback item — legal, but it makes a common line unmappable.
-- Doors take no item_key and no style override, like paint/roof.

alter table public.qbo_item_map
  drop constraint qbo_item_map_line_kind_check;

alter table public.qbo_item_map
  add constraint qbo_item_map_line_kind_check check (line_kind in (
    'building', 'paint', 'roof', 'door', 'layout_item',
    'custom_option', 'discount', 'delivery', 'fallback'));
