-- 239_qbo_line_kinds_services: qbo_item_map may map the kinds the estimate actually emits.
-- Applied live 2026-09-14; this file records what ran.
--
-- WHY. qbo_item_map.line_kind is a CLOSED set (066, widened by 067 and 085). submit-estimate has
-- since grown kinds the set never learned — wall_height, build_on_site, cladding, insulation,
-- electrical, electrical_item — every one of which silently resolves to `fallback` in
-- _shared/qboInvoice.ts and cannot be mapped from the portal at all. The new Services lines add
-- `foundation` (`delivery` was already in the set). One constraint edit fixes all seven; the
-- portal's QBO_KINDS grid grows the matching rows in the same commit.
--
-- Additive only: no existing row can violate the wider set, and nothing else reads the CHECK.

begin;

alter table public.qbo_item_map
  drop constraint if exists qbo_item_map_line_kind_check;
alter table public.qbo_item_map
  add constraint qbo_item_map_line_kind_check
  check (line_kind in (
    'building', 'paint', 'roof', 'door', 'window', 'ramp', 'layout_item', 'custom_option',
    'discount', 'delivery', 'fallback',
    -- 239: the kinds submit-estimate already emits, plus the Services line
    'wall_height', 'build_on_site', 'cladding', 'insulation', 'electrical', 'electrical_item',
    'foundation'));

commit;
