-- 278_partition_walls.sql — Partition walls: a wall inside the building that can hold a door or a
--                            window, as a new Interior item.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, BEFORE submit-estimate and the frontend that know the
--    item. Pipe this file to `supabase db query --linked` (stdin; see 270's header for why not
--    `--file` or an inline "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('278', '278_partition_walls') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- A builder's request (filed from the portal on 2026-09-07 as "Would really help"): "Need to be able
-- to add a partition wall on the interior of the shed, with the ability to add door/window to that
-- wall. Right now I am trying to do it by using lines and notes but hardly works." Carolyn answered
-- "This is planned", and INTERIOR_SCOPE.md records her standing rule: "Interior walls must be able to
-- hold a door."
--
-- ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────────────────
-- The 171 shelves pattern, and nothing else:
--   PART 1   layout_item_types gains 'partitionWall' (Partition Wall, Interior group, model_key
--            'partition', hidden_until_priced, 4 ft default). wall_only and wall_snap are false: it
--            stands on the floor, inside the building, and attaches to no wall.
--   PART 2   every tenant gets its client_layout_items row, so the item shows in Settings → Options
--            → Interior items, where the builder sets its price.
--   PART 3   apply-time assertions (they RAISE and abort the transaction).
--   THE RECORD
--
-- NO get_config CHANGE. 171 spliced into its layoutItems block everything this item needs —
-- `group`, `modelKey`, and `noPalette` while the tenant has no rate for it (hidden_until_priced) —
-- and PART 3 checks the live body still carries those lines. So the day this is applied every tenant's
-- get_config gains one key, partitionWall, with noPalette: true, and NO customer sees a button: the
-- designer leaves a noPalette item out of the palette (and its 3D palette leaves a partition out
-- whatever it says). The builder enters a rate under Settings → Options → Interior items, and the
-- button appears. The portal starts that rate blank and does not save a blank one (portal-settings
-- sends hiddenUntilPriced), so a Save made for something else can never offer it at $0. Production's
-- portal from before this change never lists an unpriced one (the catalog shows it only to a read that
-- sends withUnpriced) and can never price one (save_layout_pricing writes it only for partitionAware).
--
-- What the designer does with it (both twins' PARTITION WALLS block): a click places a wall across the
-- building's short span; it is dragged across the building, its ends are stretched, its height is
-- Full or a number of inches, and "+ Door" / "+ Window" put a catalog door or window IN it. All of
-- that is the designs' own items JSON — no table, column or RPC changes for it. submit-estimate prices
-- each wall by the builder's method (each, per foot of wall, per square foot of wall — portal-settings
-- refuses the other four for this key), with lengths clamped to the building and heights to its wall,
-- and each door or window from fixture_items by id.
--
-- ── BLAST RADIUS (read on 2026-10-05, read-only) ─────────────────────────────────────────
-- 6 tenants in client_configs; no layout_item_types, client_layout_items or layout_item_pricing row
-- for 'partitionWall'; no design whose items mention it; schema_migrations' last row 277.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────
-- Only while no design carries one (select count(*) from public.designs where items::text like
-- '%"partitionWall"%'): the designer would still draw a saved one (its LEGACY_LAYOUT_FALLBACK), but a
-- quote would price it at $0.
--   begin;
--   delete from public.layout_item_pricing where item_key = 'partitionWall';
--   delete from public.client_layout_items where item_key = 'partitionWall';
--   delete from public.layout_item_types   where item_key = 'partitionWall';
--   delete from supabase_migrations.schema_migrations where version = '278';
--   commit;

begin;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the master row
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- item_key is NEVER renamed (171's rule): it is the join to every tenant's layout_item_pricing row
-- and to the `type` string on every saved design. default_height is the wall's drawn thickness in
-- feet; nothing prices by it.
insert into public.layout_item_types
  (item_key, label, icon, color, default_width, default_height, wall_only, wall_snap, door_snap,
   short_label, sort_order, active, palette_group, model_key, depth_in, height_off_floor_in, hidden_until_priced)
values
  ('partitionWall', 'Partition Wall', '🧱', '#57534E', 4, 0.375, false, false, false,
   'PART', 62, true, 'interior', 'partition', null, null, true)
on conflict (item_key) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — every tenant's row
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Without it a builder could never reach the item to price it. Seeding is safe because the item stays
-- out of every customer's palette until that builder sets a rate (hidden_until_priced, PART 1).
insert into public.client_layout_items (client_id, item_key, active)
select cc.client_id, 'partitionWall', true
from public.client_configs cc
on conflict (client_id, item_key) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — apply-time assertions
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $check$
declare
  t        record;
  src      text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  missing  int;
  probe    text;
  got      jsonb;
begin
  -- 1. The master row is the one written above. A row that already existed under this key with a
  --    different shape (on conflict do nothing keeps it) would make the designer treat some other
  --    item as a partition, or a partition as something else.
  select * into t from public.layout_item_types where item_key = 'partitionWall';
  if not found then
    raise exception '278: layout_item_types has no partitionWall row';
  end if;
  if t.model_key is distinct from 'partition' or t.palette_group is distinct from 'interior'
     or t.hidden_until_priced is distinct from true or t.wall_only or t.wall_snap or t.door_snap or not t.active then
    raise exception '278: layout_item_types.partitionWall is not the row this migration writes (model_key %, group %, hidden_until_priced %, wall_only %, wall_snap %, door_snap %, active %). Find out who wrote it before applying.',
      t.model_key, t.palette_group, t.hidden_until_priced, t.wall_only, t.wall_snap, t.door_snap, t.active;
  end if;

  -- 2. Every tenant can reach it in Settings.
  select count(*) into missing
  from public.client_configs cc
  where not exists (select 1 from public.client_layout_items cli where cli.client_id = cc.client_id and cli.item_key = 'partitionWall');
  if missing > 0 then
    raise exception '278: % tenant(s) have no client_layout_items row for partitionWall', missing;
  end if;

  -- 3. get_config still carries 171's three lines, which are the whole of how the designer learns the
  --    item's group, that it is a partition, and that it is hidden until priced. If someone rewrote
  --    the block without them, the item would reach every customer's palette unpriced.
  if position('jsonb_build_object(''group'', lt.palette_group)' in src) = 0
     or position('jsonb_build_object(''modelKey'', lt.model_key)' in src) = 0
     or position('coalesce(lt.hidden_until_priced, false)' in src) = 0 then
    raise exception '278: get_config no longer emits group / modelKey / the hidden-until-priced noPalette (171). Restore them before applying.';
  end if;

  -- 4. What a tenant's designer receives today: the item, a partition in the Interior group, and
  --    out of the palette because nobody has priced it (BLAST RADIUS: no tenant has a rate). A
  --    tenant that did price it in between is skipped — for them the button is the point.
  for probe in
    select cc.client_id from public.client_configs cc
    where not exists (select 1 from public.layout_item_pricing lp
                      where lp.client_id = cc.client_id and lp.item_key = 'partitionWall' and lp.rate is not null)
  loop
    got := public.get_config(probe) -> 'layoutItems' -> 'partitionWall';
    if got is null then
      raise exception '278: get_config(%) has no layoutItems.partitionWall', probe;
    end if;
    if got->>'modelKey' is distinct from 'partition' or got->>'group' is distinct from 'interior'
       or (got->>'noPalette')::boolean is distinct from true then
      raise exception '278: get_config(%) emits partitionWall as % — expected modelKey partition, group interior, noPalette true', probe, got;
    end if;
  end loop;
  raise notice '278: partitionWall is in the catalog for every tenant and hidden from every customer until priced';
end
$check$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- THE RECORD — `db query` prints only the last statement's rows, so this is what the apply shows.
-- Expect: true, <tenant count>, <tenant count>, 0.
-- ═════════════════════════════════════════════════════════════════════════════════════════
select exists (select 1 from public.layout_item_types where item_key = 'partitionWall' and model_key = 'partition' and hidden_until_priced) as master_row,
       (select count(*) from public.client_configs) as tenants,
       (select count(*) from public.client_layout_items where item_key = 'partitionWall') as tenant_rows,
       (select count(*) from public.layout_item_pricing where item_key = 'partitionWall' and rate is not null) as priced_by;

commit;
