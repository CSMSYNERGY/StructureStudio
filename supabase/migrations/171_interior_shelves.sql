-- 171_interior_shelves.sql — Interior palette group + shelves (slice 1 of the Interior /
-- Electrical / Insulation / Taller-walls plan).
--
-- NUMBERING: 171 is the next free name. The repo folder runs to 170 and 169 is taken TWICE;
-- the live ledger's highest named migration is 166. Check BOTH before adding the next one.
--
-- WHY get_config IS SPLICED, NOT REWRITTEN. Migration 110's standing rule is that get_config
-- must be regenerated from a fresh pg_get_functiondef dump, because it is rewritten wholesale
-- by whoever touches it last, ACROSS BRANCHES — Ahsan works in trees we cannot see. Pasting a
-- full body here would freeze whatever this session happened to read and silently drop any
-- change he lands in between. Instead this reads the LIVE body at apply time, replaces exactly
-- one known block, and re-executes it: every other byte survives by construction, and a body
-- that has drifted out from under us RAISES instead of clobbering.
--
-- Verify the way 159 established: md5 the FUNCTION OUTPUT for two tenants before and after.
-- Emission here is sparse (a key appears only in its non-default case) and no tenant has a
-- palette_group, model_key, depth_in or height_off_floor_in until the UPDATEs below run, so
-- the only expected md5 movement is from those UPDATEs — not from the splice itself.

begin;

-- ── 1. Master catalog gains the columns the designer reads ────────────────────
alter table public.layout_item_types
  add column if not exists palette_group        text,
  add column if not exists model_key            text,
  add column if not exists depth_in             numeric,
  add column if not exists height_off_floor_in  numeric,
  add column if not exists hidden_until_priced  boolean not null default false;

comment on column public.layout_item_types.palette_group is
  'Designer palette section: doors | windows | interior | electrical. NULL renders in the unlabelled tail.';
comment on column public.layout_item_types.model_key is
  'Behaviour/geometry key the designer dispatches on instead of the item_key. wallBench | wallShelf | wallShelfDouble today. NULL means "legacy", which the browser reads as the pre-modelKey workbench rule.';
comment on column public.layout_item_types.hidden_until_priced is
  'Emit with noPalette until this tenant has a non-null layout_item_pricing rate — the same not-yet-priced contract as building_sizes.base_price and fixture_items.price.';

-- Per-tenant overrides, mirroring the *_override columns already here.
alter table public.client_layout_items
  add column if not exists depth_in             numeric,
  add column if not exists height_off_floor_in  numeric;

-- ── 2. Group the items that already exist ────────────────────────────────────
-- item_key is NEVER renamed: it is the join to every tenant's layout_item_pricing row and to
-- the `type` string on every saved design. Grouping is an added attribute, never a rename.
update public.layout_item_types set palette_group = 'doors'    where item_key in ('singleDoor', 'doubleDoor', 'ramp') and palette_group is null;
update public.layout_item_types set palette_group = 'windows'  where item_key in ('window', 'roughOpening') and palette_group is null;
update public.layout_item_types set palette_group = 'interior' where item_key in ('workbench', 'loft') and palette_group is null;

-- The workbench becomes an explicit slab so the browser's capability predicate stops keying on
-- its name. Deliberately NO depth_in: leaving it null keeps default_height as the drawn
-- footprint, so no existing workbench changes size.
update public.layout_item_types
   set model_key = 'wallBench', height_off_floor_in = coalesce(height_off_floor_in, 36)
 where item_key = 'workbench' and model_key is null;

-- ── 3. Shelves ───────────────────────────────────────────────────────────────
insert into public.layout_item_types
  (item_key, label, icon, color, default_width, default_height, wall_only, wall_snap, door_snap,
   short_label, sort_order, active, palette_group, model_key, depth_in, height_off_floor_in, hidden_until_priced)
values
  ('shelf', 'Single Shelf', '📚', '#D97706', 4, 1, false, true, false,
   'SHELF', 60, true, 'interior', 'wallShelf', 12, 48, true),
  ('doubleShelf', 'Double Shelf', '📚', '#B45309', 4, 1, false, true, false,
   'DBL SHELF', 61, true, 'interior', 'wallShelfDouble', 12, 48, true)
on conflict (item_key) do nothing;

-- Give every tenant the rows so the item is visible in their Options price list. It stays out
-- of the customer's palette until they set a rate (hidden_until_priced above), so seeding is
-- safe: without it a builder could never reach the item to price it in the first place.
insert into public.client_layout_items (client_id, item_key, active)
select cc.client_id, k.item_key, true
from public.client_configs cc
cross join (values ('shelf'), ('doubleShelf')) as k(item_key)
on conflict (client_id, item_key) do nothing;

-- ── 4. get_config: splice the layoutItems block ──────────────────────────────
do $mig$
declare
  src      text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk  text;
  new_blk  text;
begin
  -- Dollar-quoted so the anchor is a byte-for-byte copy of the live source with no escaping
  -- in the way. Indentation inside these blocks is load-bearing — it is part of the match.
  old_blk := $anchor$                 'wallOnly', lt.wall_only, 'wallSnap', lt.wall_snap)
               || case when lt.door_snap then jsonb_build_object('doorSnap', true) else '{}'::jsonb end$anchor$;

  new_blk := $repl$                 'wallOnly', lt.wall_only, 'wallSnap', lt.wall_snap)
               || case when lt.door_snap then jsonb_build_object('doorSnap', true) else '{}'::jsonb end
               || case when lt.palette_group is not null then jsonb_build_object('group', lt.palette_group) else '{}'::jsonb end
               || case when lt.model_key is not null then jsonb_build_object('modelKey', lt.model_key) else '{}'::jsonb end
               || case when coalesce(cli.depth_in, lt.depth_in) is not null then jsonb_build_object('depthIn', coalesce(cli.depth_in, lt.depth_in)) else '{}'::jsonb end
               || case when coalesce(cli.height_off_floor_in, lt.height_off_floor_in) is not null then jsonb_build_object('heightOffFloorIn', coalesce(cli.height_off_floor_in, lt.height_off_floor_in)) else '{}'::jsonb end
               || case when coalesce(lt.hidden_until_priced, false)
                         and not exists (select 1 from public.layout_item_pricing lp
                                          where lp.client_id = cc.client_id and lp.item_key = cli.item_key and lp.rate is not null)
                       then jsonb_build_object('noPalette', true) else '{}'::jsonb end$repl$;

  if position(new_blk in src) > 0 then
    raise notice '171: get_config already carries the interior keys — nothing to splice.';
    return;
  end if;

  if position(old_blk in src) = 0 then
    raise exception '171: get_config layoutItems block not found in the LIVE body. It has been '
                    'rewritten since this migration was written. Re-derive the anchor from a '
                    'fresh pg_get_functiondef dump before applying — do NOT paste a stored body.';
  end if;

  execute replace(src, old_blk, new_blk);
end
$mig$;

commit;

-- NOT DONE HERE, and deliberately: palette ORDER still follows jsonb key ordering, not
-- client_layout_items.sort_order. layoutItems is a jsonb OBJECT, and Postgres serialises object
-- keys by (length, bytes) regardless of any order by in the aggregate — so honouring sort_order
-- means changing layoutItems to an array, which is a payload contract break for every saved
-- design and every deployed browser. Sections give the grouping this slice was for; ordering
-- within a section is a separate decision with a migration of its own.
