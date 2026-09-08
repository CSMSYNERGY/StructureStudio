-- 187_fixture_door_style_more.sql
--
-- Three more looks for a catalog DOOR. 186 predicted this migration in its own header --
-- "the next product on this list is a roll-up and a Z-brace" -- and named the reason it is a
-- widened whitelist rather than another boolean: a second flag would have to encode which of
-- two looks wins, and by the third it is a truth table nobody can read.
--
-- Carolyn 2026-09-04, walking through the several door styles ONE builder sells, pointed at a
-- barn door with an X across the lower half and asked for that one by its shape. It is the
-- reason this migration exists; the other two ride with it because they are the same change.
--
--   door_style  'auto'    unchanged, still THE DEFAULT: the fixture's photo if there is one,
--                         else the generic raised-panel slab. Every existing row keeps it.
--               'plank'   unchanged (186): framed vertical boards, strap hinges, barn latch.
--               'zbrace'  those same boards with ONE diagonal brace, rising FROM the hinge
--                         side the way a real Z brace carries the leaf back into its hinges --
--                         so it mirrors with the door instead of pointing the wrong way on
--                         half the doors a builder hangs.
--               'xbrace'  those same boards with TWO crossed diagonals. The X sits in the
--                         panel BELOW the mid rail, which is both what Carolyn described ("an
--                         X across the lower half") and the only place it fits: the leaf's mid
--                         rail crosses at 55%, so a full-height X would run through it.
--               'rollup'  a segmented roll-up: horizontal slats in side tracks under a head
--                         hood, with a lift handle. No stiles, no rails, no hinges, no latch.
--
-- The three hinged looks are ONE leaf with three fields in the renderer, not three doors --
-- they share the stiles, rails, strap hinges and latch because on the real products those are
-- shared, and four near-identical copies of that geometry would drift apart the first time one
-- of them was adjusted. 'rollup' is drawn by its own function for the opposite reason: it has
-- no hinge side and no latch, so it would ignore most of what a leaf is told.
--
-- ⚠️ ONE REVERSAL RIDES WITH THIS, recorded because 186 shipped the opposite rule on purpose.
-- 186's renderer refused to build ANY door whose operation is 'slideup', on the grounds that
-- "board-and-batten describes a hinged leaf". That was right while a slide-up door could only
-- be asking for a hinged leaf it cannot have. A builder who picks 'rollup' is asking for
-- exactly the seamed door, so slideup now excludes only the hinged styles. A slide-up door
-- still on 'auto' falls through to the same lap-textured slab as before -- nothing a tenant
-- has today changes.
--
-- NO get_fixtures CHANGE. 186's version already emits `doorStyle` for a door whenever the
-- column is not 'auto', and it emits whatever is stored rather than a list of known values --
-- so the three new looks reach the browser through the function exactly as it stands. Nothing
-- to regenerate, and therefore nothing that can go stale against the live definition.
--
-- Doors only, as before. A window's look is its glass and muntins, a ramp has no face, and a
-- vent is a louvre; none of those categories reads this column. The constraint does not know
-- that -- get_fixtures does, and portal-settings forces the column to 'auto' for every
-- non-door row on save.
--
-- HAND-APPLY (inline, not --file: `supabase db query --file` auth-fails, retries and still
-- exits 0), then record in supabase_migrations.schema_migrations. Do NOT db push. BOM-free.

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fixture_items_door_style_chk') then
    alter table public.fixture_items drop constraint fixture_items_door_style_chk;
  end if;
  alter table public.fixture_items
    add constraint fixture_items_door_style_chk
    check (door_style in ('auto', 'plank', 'zbrace', 'xbrace', 'rollup'));
end $$;
