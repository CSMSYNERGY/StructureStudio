-- 222_retire_builtin_doors_windows: delete the pre-fixtures generic door/window layout
-- items from the MASTER catalog. Applied live 2026-09-08; this file records what ran.
--
-- WHY. Doors and windows are sold from the fixtures catalog now (fixture_items — priced,
-- photographed, per-builder, with colors/swing/operation). `singleDoor`, `doubleDoor` and
-- `window` in layout_item_types are the old way of doing the same job, and they were still
-- sitting in Admin > Master Catalog as a platform-wide palette entry every builder draws
-- from. Carolyn asked for them gone.
--
-- THIS IS A SUPPORTED RETIREMENT, NOT A BREAK. StructureStudio.jsx's LEGACY_LAYOUT_FALLBACK
-- (line 79) holds exactly these three keys, marked noPalette, and is spread into ITEMS
-- BEFORE C.layoutItems — so the 105 saved designs that still carry them keep rendering in
-- 2D, in the PNG/PDF export and in the 3D wall cut-outs. Its values were checked against the
-- rows deleted below and are identical field for field (color, width, height, shortLabel,
-- wallOnly), so nothing changes appearance. See the comment at StructureStudio.jsx:9552,
-- which names doubleDoor as the worked example of this exact move.
--
-- THE FIXTURES PATH IS UNAFFECTED. Fixtures reach the designer through get_fixtures, which
-- reads client_configs / client_settings / fixture_items / colors / window_colors and never
-- touches layout_item_types or client_layout_items. One coupling is real and deliberate: a
-- placed CATALOG window is a plain type:"window" item (StructureStudio.jsx:611) so it reuses
-- the built-in window's render, collision and payload — which is precisely why the JS
-- fallback above must stay. Do not delete it.

-- ── 1. Size inclusions FIRST, and this order is load-bearing ────────────────────────────
-- building_size_inclusions lost its FK to layout_item_types in 074_fixture_inclusions.sql,
-- so these rows do NOT cascade. get_config's inclusion filter (159_config_taxable.sql:83)
-- drops a key only when an ARCHIVED client_layout_items row exists — delete the row outright
-- and there is no archived row, so the inclusion keeps publishing and keeps netting against
-- the base price. After the master row is gone there is no way back: the portal's inclusion
-- columns are built from client_layout_items, set_layout_item_archived silently updates zero
-- rows, and the pricing CSV stops emitting the column. Clear them while it is still possible.
--
-- This FIXES a live bug rather than causing one. abc-builder, preferred-structures and
-- yoder-barns already had these items off with archived=false, so the guard already failed to
-- match — their customers were being shown "✓ Included — place or decline: Double Door" for
-- an item with no palette button to place it with.
--
-- 539 rows: abc-builder 205, preferred-structures 205, yoder-barns 128, testtttttt 1.
delete from public.building_size_inclusions
where item_key in ('doubleDoor', 'singleDoor', 'window');

-- ── 2. The master rows ─────────────────────────────────────────────────────────────────
-- Cascades to all 22 client_layout_items rows (016_catalog_master.sql:63). No tenant had a
-- label/short_label/width/height override or taxable=false on any of them, so nothing is
-- lost with the rows — checked before deleting. Takes effect immediately: get_config reads
-- the DB, so no deploy is involved.
delete from public.layout_item_types
where item_key in ('doubleDoor', 'singleDoor', 'window');

-- ── 3. What is deliberately NOT deleted ────────────────────────────────────────────────
-- layout_item_pricing (18 rows) and qbo_item_map (3 rows) are left in place ON PURPOSE.
-- Neither has an FK, so neither cascaded, and both are read by key with no join to the master
-- table. If a customer re-opens and RESUBMITS one of the 105 legacy designs, submit-estimate
-- prices its doors through pushItem, whose rate is `lp?.rate || 0` — deleting the pricing
-- rows would silently quote those doors at $0. The QBO mappings are the same argument one
-- step further down the pipe (_shared/qboInvoice.ts:104 keys on item_key).
--
-- The cost of keeping them is 21 invisible rows. The cost of deleting them is a wrong number
-- on a real quote. Leave them until the legacy designs age out.
