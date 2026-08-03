-- 074_fixture_inclusions: let a building SIZE "include" a catalog fixture (fixture_items),
-- not just a built-in layout item. Every client's catalog options (doors/windows/ramps) must be
-- manageable as inclusions the same way the built-ins are — so an owner can set, per size, how
-- many of a catalog door/window/ramp the base price already covers (client-specific).
--
-- The whole inclusion pipeline (building_size_inclusions, the pricing CSV import/export, and the
-- designer/estimate "first N included" netting) is already generic over item_key. The ONLY thing
-- stopping a fixture inclusion from flowing through it was the FK that forces item_key to be a
-- built-in layout key. Drop it so a fixture inclusion is stored as item_key = fixture id (a UUID).
-- Built-in layout-item inclusions are unchanged. A stale row for a deleted fixture is harmless
-- (nothing on a plan will match its id). HAND-APPLY via MCP; record in the ledger.

alter table public.building_size_inclusions
  drop constraint if exists building_size_inclusions_item_key_fkey;
