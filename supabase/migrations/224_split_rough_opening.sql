-- 224_split_rough_opening: one generic `roughOpening` becomes `roughOpeningDoor` and
-- `roughOpeningWindow`. Applied live 2026-09-08; this file records what ran.
--
-- WHY. In 3D a rough opening has always been geometrically a DOOR hole — D3.RO_H === D3.DOOR_H
-- (6.5 ft) and openingSpan hard-codes its bottom at the floor, so no sill panel is ever emitted
-- — while sitting under the WINDOWS palette heading. Carolyn needs both: a door RO that runs to
-- the floor, and a window RO with a sill. Splitting the key is what lets the two carry different
-- geometry, different prices and different palette groups.
--
-- ⚠️ DEPLOY ORDER IS LOAD-BEARING. The designer JS must ship BEFORE this migration:
--   1. deploy submit-estimate (accepts the new per-entry itemKey AND the old flat payload),
--   2. deploy the site bundle (adds LEGACY_LAYOUT_FALLBACK.roughOpening + the ssIsRO branches),
--   3. THEN run this.
-- Both code changes are no-ops until this migration lands, so step 1+2 change nothing visible.
-- Run this first and step 5 below silently drops the rough openings from every saved design that
-- carries one — ITEMS[item.type] is the guard in both renderers and an item whose type has no
-- entry is dropped from the plan while staying in the saved row (StructureStudio.jsx:61-63).
--
-- THE KEY IS NEVER RENAMED. 171_interior_shelves.sql:44 states the rule: item_key is the join to
-- every layout_item_pricing row and to the `type` string on every saved design. Nothing here
-- rewrites designs.items — 15 designs and 25 design_versions keep their `roughOpening` items and
-- keep rendering at today's geometry through the JS fallback, exactly as 222 did for the 105
-- door/window designs.

-- ── 1. The two new master rows ─────────────────────────────────────────────────────────
-- Geometry mirrors what the JS stamps at placement (d3OpeningDefaults): the door RO keeps the
-- generic 3ft x 0.5 plan bar and its floor-to-6'6" opening; the window RO is the same plan bar
-- but carries a sill in 3D. default_height is the PLAN bar depth, not a 3D height — the 3D
-- numbers live in D3 and on the item, because the customer sets them per opening.
-- palette_group is what moves the buttons: 'doors' puts the door RO under DOORS with the door
-- picker and the ramp, 'windows' keeps the window RO beside the window picker.
-- ⚠️ admin-catalog's save_master_item cannot write palette_group, which is why these are
-- inserted here rather than through the Admin console.
insert into public.layout_item_types
  (item_key, label, icon, color, default_width, default_height, wall_only, wall_snap, door_snap,
   short_label, sort_order, active, palette_group, hidden_until_priced)
values
  ('roughOpeningDoor',   'Rough Opening (Door)',   '⬜', '#000000', 3, 0.5, true, false, false, 'RO-D', 0, true, 'doors',   false),
  ('roughOpeningWindow', 'Rough Opening (Window)', '⬜', '#000000', 3, 0.5, true, false, false, 'RO-W', 0, true, 'windows', false);

-- ── 2. Per-client assignment, inherited from the generic row ───────────────────────────
-- Every tenant that had a rough opening gets both kinds, carrying over that tenant's own
-- active / archived / taxable / internal_only rather than assuming defaults. yoder-barns had the
-- generic one archived, so both of theirs arrive archived too — an operator un-archives what
-- they want. Pattern from 171_interior_shelves.sql:70-74.
insert into public.client_layout_items
  (client_id, item_key, active, sort_order, archived, taxable, internal_only)
select cli.client_id, k.item_key, cli.active, cli.sort_order, cli.archived, cli.taxable, cli.internal_only
from public.client_layout_items cli
cross join (values ('roughOpeningDoor'), ('roughOpeningWindow')) as k(item_key)
where cli.item_key = 'roughOpening'
on conflict (client_id, item_key) do nothing;

-- ── 3. Pricing, copied to both keys, ORIGINAL KEPT ─────────────────────────────────────
-- Copies the default row and any per-style override. The generic row STAYS, for 222 §3's
-- reason: submit-estimate prices a resubmitted legacy design by key with no join to the master
-- table, and deleting it would silently quote those rough openings at $0.
insert into public.layout_item_pricing (client_id, item_key, style_id, pricing_method, rate, image_url)
select lp.client_id, k.item_key, lp.style_id, lp.pricing_method, lp.rate, lp.image_url
from public.layout_item_pricing lp
cross join (values ('roughOpeningDoor'), ('roughOpeningWindow')) as k(item_key)
where lp.item_key = 'roughOpening';

-- ── 4. Size inclusions follow the DOOR ro — and this must happen BEFORE step 5 ─────────
-- 16 rows, all yoder-barns. Today's rough opening is door-shaped, so the door RO is what
-- preserves what they actually sell. 222 §1's warning is why the order matters: this table lost
-- its FK in 074_fixture_inclusions.sql so nothing cascades, and get_config drops an inclusion
-- only when an ARCHIVED client_layout_items row exists — once the generic row is inactive the
-- portal can no longer show or clear these.
update public.building_size_inclusions set item_key = 'roughOpeningDoor' where item_key = 'roughOpening';

-- ── 5. Retire the generic key ──────────────────────────────────────────────────────────
-- get_config joins `on lt.item_key = cli.item_key and lt.active` (159_config_taxable.sql:123),
-- so this alone drops it from every tenant's layoutItems. That is only safe because the site
-- bundle deployed in step 2 above carries LEGACY_LAYOUT_FALLBACK.roughOpening — render-only,
-- noPalette — which is what keeps the 15 saved designs drawing. Do not run this without it.
-- The row itself is KEPT (not deleted) so client_layout_items and its FK stay intact and the
-- retirement is one UPDATE to reverse.
update public.layout_item_types set active = false where item_key = 'roughOpening';

-- ── 6. QuickBooks ──────────────────────────────────────────────────────────────────────
-- Deliberately NOT touched. The 1 existing qbo_item_map row still resolves legacy lines, and
-- qboInvoice.ts falls back `layout_item|<key>|` -> `layout_item||` -> `fallback||`, so the two
-- new keys map through the tenant's layout-item default until someone maps them explicitly.
