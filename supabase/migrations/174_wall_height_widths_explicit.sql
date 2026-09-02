-- 174_wall_height_widths_explicit.sql — a NEW building width is never offered a taller wall
-- until the builder says so.
--
-- WHY THIS REVERSES PART OF 173. 173 borrowed the fixture window-colour contract, where NULL
-- means "every value, including ones added later" — a LIVING default. That is safe for a
-- colour: adding one can only offer more choice. It is NOT safe here, and the direction is
-- what makes it unsafe. Total haul height is wall + roof, the roof grows with width, so the
-- WIDER a building gets the LESS wall-height headroom it has. A living default therefore
-- auto-offers every unrestricted increase on each newly added width — and the newly added
-- width is usually the widest one, which is exactly the case the feature exists to refuse.
-- Carolyn, asked directly ("if there is a 16 wide building in the list, will that wall height
-- increase then also have a 16 wide?"), chose: a new width arrives UNTICKED, always.
--
-- WHAT CHANGES. `widths_ft` becomes explicit on every row. The reader still treats NULL as
-- "all widths" — that stays as a safe fallback for any row written outside the portal — but
-- portal-settings no longer collapses a fully-ticked list back to NULL, so the value stops
-- drifting when the catalog grows.
--
-- The backfill materialises today's answer: every NULL row is pinned to the widths its style
-- ACTUALLY sells right now, which is precisely what it was already offering. No customer's
-- available choices change today; only tomorrow's newly added width behaves differently.

begin;

update public.style_wall_heights swh
   set widths_ft = w.list,
       updated_at = now()
  from (
    select sz.style_id, array_agg(distinct sz.width_ft order by sz.width_ft) as list
    from public.building_sizes sz
    where sz.active
    group by sz.style_id
  ) w
 where w.style_id = swh.style_id
   and swh.widths_ft is null;

-- A style with no active sizes has nothing to pin to; leave those NULL rather than writing an
-- empty array, which would read as "offered on nothing" and silently retire the increase.

comment on column public.style_wall_heights.widths_ft is
  'Building widths (ft) this increase is offered on. Written EXPLICITLY by portal-settings so a width added to the style later is NOT auto-offered — taller walls lose headroom as buildings get wider, so the safe default for a new width is off. NULL is read as "all widths" only as a fallback for rows not written through the portal.';

commit;

-- Verification: no active-sized style should have a NULL widths_ft row left, and every
-- customer's currently offered set should be unchanged (the backfill copies what was already
-- being offered).
