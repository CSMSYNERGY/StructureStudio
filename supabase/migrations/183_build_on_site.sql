-- 183_build_on_site: a wall-height increase that can only be BUILT ON SITE, and what that costs.
--
-- ── WHY IT HANGS OFF THE WALL-HEIGHT ROW ───────────────────────────────────────────
-- Carolyn, 2026-09-01, explaining why taller walls are capped at all: "they haul these, they
-- put these on a truck and trailer and haul them down the road and they have road restrictions
-- to go under bridges." Then the exception: "Sometimes they build buildings on site. If they
-- build it on site, then they can tip it then ... I'm probably going to put that in there to
-- allow them to raise the wall height more, but then it becomes a build on site building."
-- And the money: "They always charge more for a build on site. They will always have an up
-- charge, because they're sending the crew out there to build."
--
-- So build-on-site is not a separate product a customer shops for — it is a CONSEQUENCE of
-- asking for a wall too tall to haul. That is exactly the row 172 already created: per style
-- (hauling limits differ per style), per increase, per width (173). Putting the flag anywhere
-- else would mean maintaining a second copy of "which heights are legal on what", which is the
-- thing 173 exists to express.
--
-- One increase is ever selected, so exactly one fee can ever apply. No double-charge is
-- reachable by construction rather than by a guard.
--
-- ── THE FEE BASIS IS A CHOICE CAROLYN HAS NOT MADE YET ─────────────────────────────
-- She was still deciding on the call and asked for a view. Rather than guess a number into the
-- schema, the basis is a COLUMN with the vocabulary `layout_item_pricing` already uses, so her
-- answer is a dropdown in Settings and not a migration:
--
--   each                -> a flat call-out fee, the whole job          (DEFAULT)
--   sqft_building       -> per square foot of floor
--   perimeter_building  -> per lineal foot of the building's perimeter
--
-- All three already have working formulas in submit-estimate's geometry (buildingArea,
-- buildingPerimeter), which is why this costs no new pricing code.
--
-- ⚠️ I nearly defaulted this to `perimeter_building` "to match the wall-height increase beside
-- it". That would have been wrong for the wrong reason: the increase is per lineal foot because
-- taller walls are literally more material around the perimeter. A build-on-site fee is LABOUR
-- and mobilisation — sending a crew — which is flat far more often than it is dimensional.
-- Matching the neighbour would have been tidiness mistaken for correctness.
--
-- ── A NULL FEE IS "NO UPCHARGE", NOT "MISCONFIGURED" ───────────────────────────────
-- This is the one place this file deliberately departs from its neighbour. An increase with a
-- NULL rate_per_lf is a hard 400 in submit-estimate ("isn't offered"), because a builder who
-- forgot to price something they are selling must not have it quoted at $0. A NULL
-- bos_fee_rate is different: Carolyn says builders always charge, but "always" is her market,
-- not a database constraint, and a builder who genuinely absorbs it is not misconfigured. So a
-- flagged increase with no fee still STAMPS the building as built on site — the build board
-- needs to know it is not a haul — and simply adds no charge line.
--
-- ── WHAT REACHES THE ANONYMOUS BROWSER ─────────────────────────────────────────────
-- `buildOnSite` always (it changes what the customer is buying, and they should see it before
-- they pick), the fee only behind show_pricing, exactly like ratePerLf beside it. Insulation
-- publishes no rate at all, but that was Carolyn's explicit choice for insulation; this control
-- IS the wall-height control, so it follows the wall-height rule. The server re-reads both
-- regardless, so nothing here is trusted back.
--
-- Additive and inert until code ships: every existing row reads build_on_site = false, which is
-- exactly today's behaviour. Hand-apply via the SQL editor / MCP and record as version 183.
-- NEVER `supabase db push`. (Ledger tip when written: 182_insulation_rate_to_browser. 179 is
-- authored and NOT applied, so 183 is the next free number either way.)

begin;

alter table public.style_wall_heights
  add column if not exists build_on_site boolean not null default false,
  add column if not exists bos_fee_basis text,
  add column if not exists bos_fee_rate  numeric(12,2);

alter table public.style_wall_heights
  drop constraint if exists style_wall_heights_bos_basis_check;
alter table public.style_wall_heights
  add  constraint style_wall_heights_bos_basis_check
  check (bos_fee_basis is null or bos_fee_basis in ('each', 'sqft_building', 'perimeter_building'));

alter table public.style_wall_heights
  drop constraint if exists style_wall_heights_bos_rate_nonneg;
alter table public.style_wall_heights
  add  constraint style_wall_heights_bos_rate_nonneg
  check (bos_fee_rate is null or bos_fee_rate >= 0);

comment on column public.style_wall_heights.build_on_site is
  'Choosing this increase makes the building BUILT ON SITE rather than hauled — it is too tall to go under a bridge. Stamps the design so the build board knows it is not a haul, and adds the fee below if one is set. A builder who does not offer build-on-site simply flags no row.';
comment on column public.style_wall_heights.bos_fee_basis is
  'How the build-on-site fee is charged: each (flat call-out), sqft_building, or perimeter_building. Same vocabulary as layout_item_pricing, so all three already have formulas. NULL reads as ''each''.';
comment on column public.style_wall_heights.bos_fee_rate is
  'The build-on-site upcharge at that basis. NULL means NO UPCHARGE — deliberately not an error, unlike a NULL rate_per_lf: a builder who absorbs the cost is not misconfigured, and the building is still stamped built-on-site.';

-- ── get_config: emit buildOnSite, and the fee only behind show_pricing ─────────────
-- Spliced, not rewritten — 110's rule is that get_config gets rewritten wholesale across
-- branches we cannot see, so pasting a stored body would silently drop whatever landed in
-- between. A drifted body RAISES instead. Same mechanism as 171/172/173.
do $mig$
declare
  src     text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text;
  new_blk text;
begin
  old_blk := $anchor$                 || case when coalesce(swh.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end$anchor$;

  new_blk := $repl$                 || case when coalesce(swh.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
                 || case when coalesce(swh.build_on_site, false) then jsonb_build_object('buildOnSite', true) else '{}'::jsonb end
                 || case when coalesce(swh.build_on_site, false) and swh.bos_fee_rate is not null
                            and coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
                         then jsonb_build_object('bosFeeBasis', coalesce(swh.bos_fee_basis, 'each'), 'bosFeeRate', swh.bos_fee_rate)
                         else '{}'::jsonb end$repl$;

  if position($check$'buildOnSite'$check$ in src) > 0 then
    raise notice '183: get_config already emits buildOnSite — nothing to splice.';
    return;
  end if;

  if position(old_blk in src) = 0 then
    raise exception '183: the wallHeightOptions internalOnly anchor was not found in the LIVE '
                    'get_config body. Re-derive it from a fresh pg_get_functiondef dump — '
                    'migration 175 must be applied before this one.';
  end if;

  execute replace(src, old_blk, new_blk);
end
$mig$;

commit;

-- ── ROLLBACK ───────────────────────────────────────────────────────────────────────
-- Re-splice get_config to drop the two emitted keys, then:
--   alter table public.style_wall_heights
--     drop column if exists build_on_site,
--     drop column if exists bos_fee_basis,
--     drop column if exists bos_fee_rate;
-- Safe while no design has been quoted with a build-on-site line. After that, dropping the
-- columns loses the record of WHY a quoted building was priced the way it was; the estimate
-- snapshot keeps its line either way, so prefer flagging the rows off to dropping them.
