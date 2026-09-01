-- 173_wall_height_widths.sql — a wall-height increase is only offered on the widths it can
-- actually be hauled at.
--
-- WHY. Total haul height is wall + roof, and the roof grows with the building's width, so a
-- narrow building has headroom a wide one does not: Carolyn, 2026-09-01 — "you can increase
-- the wall height more on an 8 wide than a 16 wide and still remain in the height range for
-- hauling." Without this, the designer would happily quote a +12" upgrade on a 14 wide that
-- cannot legally leave the lot.
--
-- SHAPE: NULL = every width (a LIVING default — a width added to the style later is offered
-- automatically), an array = exactly those widths, '{}' = none. This is the same idiom as
-- fixture_items.window_color_ids (migration 119) and is emitted the same sparse way (120):
-- the key appears only when the row is restricted, so an unrestricted tenant's payload does
-- not change at all.
--
-- The widths are matched against building_sizes.width_ft — the FIRST number of a size label
-- ("12x24" is 12 wide), which is what the designer's parseSize reads too.

begin;

alter table public.style_wall_heights
  add column if not exists widths_ft numeric[];

comment on column public.style_wall_heights.widths_ft is
  'Building widths (ft) this increase is offered on. NULL = all widths (a width added later is offered automatically); an array = exactly those; empty = none.';

-- get_config: emit widthsFt ONLY when restricted. Spliced, not rewritten — see 171.
do $mig$
declare
  src      text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk  text;
  new_blk  text;
begin
  old_blk := $anchor$                 || case when coalesce(swh.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end$anchor$;

  new_blk := $repl$                 || case when coalesce(swh.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end
                 || case when swh.widths_ft is not null then jsonb_build_object('widthsFt', to_jsonb(swh.widths_ft)) else '{}'::jsonb end$repl$;

  if position($check$'widthsFt'$check$ in src) > 0 then
    raise notice '173: get_config already emits widthsFt — nothing to splice.';
    return;
  end if;

  if position(old_blk in src) = 0 then
    raise exception '173: the wallHeightOptions taxable anchor was not found in the LIVE '
                    'get_config body. Re-derive it from a fresh pg_get_functiondef dump — '
                    'migration 172 must be applied before this one.';
  end if;

  execute replace(src, old_blk, new_blk);
end
$mig$;

commit;

-- Verification: an UNRESTRICTED tenant's get_config output must be byte-identical before and
-- after (sparse emission). Only a row with widths_ft set should move the md5.
