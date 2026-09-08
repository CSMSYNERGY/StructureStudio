-- 172_style_wall_heights.sql — Taller walls (slice 2 of the Interior / Electrical /
-- Insulation / Taller-walls plan).
--
-- NUMBERING: repo files run to 171 and the live ledger's top name is 171_interior_shelves.
-- Check BOTH before adding the next one — they have disagreed before.
--
-- WHAT THIS IS. A builder offers specific wall-height INCREASES per building style, priced
-- per lineal foot of the building's perimeter. Carolyn's example: Lofted Barn +6" at $2/lf,
-- +12" at $8/lf. The heights on offer differ per style because HAULING limits differ per
-- style, which is why this is a per-style child table and not one list per tenant.
--
-- WHY DELTA INCHES, NOT ABSOLUTE FEET. Carolyn thinks and sells in "+6 inches". A delta also
-- composes with whatever baseline the style already has (building_styles.d3->>'wallHeightFt')
-- and survives an edit to that baseline, where a stored absolute would silently become a
-- different upgrade. The 3D viewer still works in absolute feet — the browser adds the delta
-- to the baseline and clamps, exactly as it already clamps a hand-picked height.
--
-- WHAT ALREADY EXISTED, so nobody re-derives it: the customer could ALREADY pick a wall height
-- inside the 3D viewer; it rode to the server as `selections.wallHeightFt` and the source
-- comment said "pricing hookup is a catalog follow-up". Nothing priced it. This is that
-- follow-up. `building_sizes.wall_height_ft` (migration 040) stays INERT and unrelated —
-- do not entangle them.

begin;

create table if not exists public.style_wall_heights (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null,
  style_id     uuid not null references public.building_styles(id) on delete cascade,
  -- Whole inches above the style's standard wall. Capped at 4 ft: past that it is a different
  -- building, not an upgrade, and a fat-fingered 120 would quietly quote a five-figure line.
  delta_in     integer not null check (delta_in > 0 and delta_in <= 48),
  -- NULL = not offered. The same not-yet-priced contract as building_sizes.base_price and
  -- fixture_items.price: a row can exist while the builder is still deciding, and the
  -- customer is never shown a choice we cannot price.
  rate_per_lf  numeric check (rate_per_lf is null or rate_per_lf >= 0),
  taxable      boolean not null default true,
  active       boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (client_id, style_id, delta_in)
);

create index if not exists style_wall_heights_style_idx on public.style_wall_heights (style_id);

-- Same posture as building_sizes / building_styles: RLS on, owner-scoped SELECT for
-- authenticated, and NO write policy — every write goes through portal-settings on the
-- service role, so the tenant is resolved from the JWT and never trusted from the body.
-- The public designer never reads this table directly; it arrives via get_config.
alter table public.style_wall_heights enable row level security;

drop policy if exists style_wall_heights_owner_read on public.style_wall_heights;
create policy style_wall_heights_owner_read on public.style_wall_heights
  for select to authenticated
  using (client_id = current_client_id());

revoke all on public.style_wall_heights from anon;

comment on table public.style_wall_heights is
  'Per-style wall-height upgrades. delta_in = whole inches above the style standard; rate_per_lf is charged against the building perimeter. NULL rate = not offered.';

-- ── get_config: emit the offered heights ─────────────────────────────────────
-- Spliced, not rewritten — see 171 for why. The rate is show_pricing-gated the way colors[]
-- is (null, not omitted), because the customer must still be able to CHOOSE a height on a
-- tenant that hides prices; only the number is withheld.
do $mig$
declare
  src      text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk  text;
  new_blk  text;
begin
  old_blk := $anchor$    'colors', coalesce(($anchor$;

  new_blk := $repl$    'wallHeightOptions', coalesce((
      select jsonb_object_agg(st.key, opt.list)
      from public.building_styles st
      cross join lateral (
        select jsonb_agg(jsonb_build_object(
                 'deltaIn', swh.delta_in,
                 'ratePerLf', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then swh.rate_per_lf else null end)
                 || case when coalesce(swh.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end
               order by swh.delta_in) as list
        from public.style_wall_heights swh
        where swh.style_id = st.id and swh.active and swh.rate_per_lf is not null
      ) opt
      where st.client_id = cc.client_id and st.active and opt.list is not null), '{}'::jsonb),
    'colors', coalesce(($repl$;

  if position($check$'wallHeightOptions'$check$ in src) > 0 then
    raise notice '172: get_config already emits wallHeightOptions — nothing to splice.';
    return;
  end if;

  if position(old_blk in src) = 0 then
    raise exception '172: the colors block anchor was not found in the LIVE get_config body. '
                    'It has been rewritten since this migration was written — re-derive the '
                    'anchor from a fresh pg_get_functiondef dump before applying.';
  end if;

  execute replace(src, old_blk, new_blk);
end
$mig$;

commit;

-- EXPECTED VERIFICATION RESULT, so a future reader is not alarmed: this adds a 14th top-level
-- key to get_config, so the output md5 MOVES for every tenant. That is the change. What must
-- NOT move is anything else — check the styles, colors, sizes and layoutItems counts, and
-- confirm get_fixtures is byte-identical.
