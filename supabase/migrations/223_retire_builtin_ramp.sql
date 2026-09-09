-- 223_retire_builtin_ramp: delete the built-in `ramp` layout item from the MASTER catalog.
-- Applied live 2026-09-08; this file records what ran. Follows 222 (doors + windows).
--
-- WHY THIS IS THE COMPLETION OF EXISTING WORK, NOT A NEW MOVE. Ramps were rebuilt twice over:
-- catalog ramps live in fixture_items (category='ramp'), and the "simple" ramp's mode, price,
-- image and on/off flag live in client_settings (073_ramp_mode.sql, 079_ramp_enabled.sql).
-- 079's own header states the goal outright:
--     "Move that signal to an explicit, non-price-gated flag on client_settings so it
--      survives deleting the built-in item."
-- 080_delete_junior_builtin_ramp.sql then performed exactly this deletion, client-scoped, and
-- has been in production since. This is that, platform-wide.
--
-- NOTHING RENDERS DIFFERENTLY. All 43 designs with a placed ramp keep drawing: ITEMS.ramp is
-- assigned from SIMPLE_RAMP_CFG *after* the ...C.layoutItems spread (StructureStudio.jsx:9406),
-- so the master row's label/width/colour/doorSnap were already inert before this ran. Verified
-- live on beta with junior-barns SS-35WZS9G5S5 (a design carrying a ramp AND 222's retired
-- doubleDoor/singleDoor/window): plan draws RAMP, 3' SD, 2' W, 5' DD, and the Ramp tool arms.
--
-- LIVE PROOF THIS WAS ALREADY SAFE: junior-barns had no client_layout_items row for 'ramp' at
-- all (080 deleted it) and its designer has been serving a working Ramp tool ever since.
--
-- Pre-flight, all clean: 0 building_size_inclusions rows for 'ramp' (so 222's ordering trap does
-- not apply here), 0 rows with taxable=false, 0 client_settings rows with a NULL ramp_enabled.

-- ── 1. Two builders were quoting a ramp and invoicing $0 ───────────────────────────────
-- abc-builder and preferred-structures had a legacy layout_item_pricing ramp rate of $575 but
-- no client_settings.ramp_price. The designer prices the simple ramp off the legacy row when
-- ramp_price is unset, while submit-estimate requires `rampPrice > 0` and has NO fallback to
-- the layout rate — so the customer saw $575 and the estimate charged nothing. Neither had sold
-- a ramp (0 designs), so nothing was mispriced in the field; it was armed. Carolyn's call was
-- to switch ramps off rather than guess a price.
--
-- preferred-structures had NO client_settings row at all — the only tenant in that state — and
-- that is its own bug: the portal reads a missing flag as ON (portal-settings:1711, `!== false`)
-- while get_fixtures reads it as OFF (coalesce(v_enabled, false)). So their Ramps card claimed
-- ramps were enabled while their customers got no ramp tool. Creating the row settles it.
-- Checked first: get_config('preferred-structures') hashes IDENTICALLY with and without the row
-- (2fde94e983087fdac10121c5e1cac1c3), so the other column defaults change nothing.
insert into public.client_settings (client_id, ramp_enabled) values ('preferred-structures', false);
update public.client_settings set ramp_enabled = false where client_id = 'abc-builder';

-- ── 2. The master row ──────────────────────────────────────────────────────────────────
-- Cascades the 8 client_layout_items rows (016_catalog_master.sql:63). No tenant had a label,
-- width, height or short_label override, taxable=false, or internal_only on any of them.
-- Master catalog goes 6 -> 5: loft, roughOpening, workbench, shelf, doubleShelf.
delete from public.layout_item_types where item_key = 'ramp';

-- ── 3. What is deliberately NOT deleted ────────────────────────────────────────────────
-- layout_item_pricing (5 rows) and qbo_item_map (1 row) stay, for 222 §3's reason: no FK, read
-- by key with no join to the master table, so deleting them silently quotes $0 on a resubmit.
--
-- One cosmetic consequence worth writing down: LEGACY_LAYOUT_FALLBACK deliberately has no ramp
-- entry (StructureStudio.jsx:83 says so — SIMPLE_RAMP_CFG covers rendering), and the pricing-row
-- label chain is C.layoutItems[key].label -> LEGACY_LAYOUT_FALLBACK[key].label -> the raw key.
-- So a tenant still on the legacy pricing path would see "ramp" instead of "Ramp" on that line.
-- That path is only reachable with ramps enabled AND client_settings.ramp_price unset; after
-- step 1 the only tenant left in that state is `testtttttt` (a junk tenant). If a real builder
-- ever lands there, the fix is to set their ramp_price — which is the real fix regardless,
-- since submit-estimate charges $0 for a simple ramp with no ramp_price.
