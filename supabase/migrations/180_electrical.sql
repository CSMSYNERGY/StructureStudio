-- 180_electrical.sql — slice 4 of the Interior / Electrical / Insulation / Taller-walls plan.
--
-- NUMBERING: 178 and 179 are BOTH already used in the folder (178_rep_attested_acceptance,
-- 179_tax_meters) by work that landed while this was being written, on top of the 174 that is
-- used twice. Check the folder AND the live ledger every single time.
--
-- WHAT THIS IS. A builder sets their wiring standards once — a plug every N feet at H inches
-- off the floor, higher above a workbench, lights every N feet, a switch by the door, panel or
-- no panel. The customer turns on the electrical package and the designer LAYS IT OUT for them
-- at those spacings. Extra devices beyond that standard layout are charged per device.
--
-- THE PRICING RULE, and it is the whole feature (Carolyn, 2026-09-02, asked explicitly because
-- it decides the data model): "removing one doesn't discount it, extras charged per device."
-- So the package is a FIXED price covering the standard layout, and the charge is
--
--     package_price  +  SUM over device types of  max(0, placed - auto) * rate
--
-- The max(0, …) is what makes "removing one doesn't discount" true — it is not a separate rule,
-- it falls out of flooring at zero. Delete four auto outlets and the package still costs what
-- the package costs. This is the SAME shape as a size inclusion (placed minus included, floored),
-- which is deliberate: it is the netting builders already understand from doors and windows.
--
-- WHY THE COUNT IS RECOMPUTED SERVER-SIDE. `auto` is a pricing input, so submit-estimate derives
-- it from the building's own dimensions and the tenant's stored standards rather than trusting a
-- number from the browser — the same rule as the wall-height resolve and the insulation area.
-- A browser that sent auto=999 would otherwise make every extra device free.

begin;

-- ── 1. The builder's standards, and the package price ────────────────────────
create table if not exists public.electrical_settings (
  client_id             text primary key,
  -- Opt-in, exactly like insulation_enabled: DEFAULT FALSE so nobody starts offering wiring
  -- because a column appeared. Off hides the whole feature without discarding the standards.
  enabled               boolean not null default false,
  -- NULL price = not yet priced = not offered, even when enabled. The ship-dark contract shared
  -- with building_sizes.base_price, fixture_items.price and style_wall_heights.rate_per_lf.
  package_price         numeric check (package_price is null or package_price >= 0),
  package_label         text    not null default 'Electrical Package',
  taxable               boolean not null default true,
  -- Rep designer only, hidden from the customer-facing page. VISIBILITY only — a rep-selected
  -- package still prices. Same semantics as style_wall_heights.internal_only.
  internal_only         boolean not null default false,

  -- The standards. Defaults are ordinary US shed practice so a builder who switches this on
  -- gets a sane layout before touching anything.
  outlet_spacing_ft     numeric not null default 6   check (outlet_spacing_ft   > 0),
  outlet_height_in      numeric not null default 24  check (outlet_height_in   >= 0),
  -- "with a workbench they go above the workbench" — the mount height used for an outlet that
  -- lands on a wall span occupied by a bench. Stored for the 3D height and the shop drawing;
  -- it does not change the COUNT, so it can never change a price.
  outlet_above_bench_in numeric not null default 42  check (outlet_above_bench_in >= 0),
  light_spacing_ft      numeric not null default 10  check (light_spacing_ft    > 0),
  switch_height_in      numeric not null default 48  check (switch_height_in   >= 0),
  -- "They need to specify if they put in an electrical box or not." A package attribute, NOT a
  -- placed item: where the panel goes is the electrician's call on site, and inventing a
  -- position for it would put a wrong drawing in front of a shop. It rides on the quote line.
  include_panel         boolean not null default true,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.electrical_settings enable row level security;

-- Same posture as insulation_offerings / style_wall_heights: owner-scoped SELECT, and NO write
-- policy — every write goes through portal-settings on the service role, so the tenant comes
-- from the JWT and is never trusted from the body. The public designer reads it via get_config.
drop policy if exists electrical_settings_owner_read on public.electrical_settings;
create policy electrical_settings_owner_read on public.electrical_settings
  for select to authenticated
  using (client_id = current_client_id());

revoke all on public.electrical_settings from anon;

comment on table public.electrical_settings is
  'Per-tenant wiring standards + the electrical package price. The package is a FIXED price covering the auto-laid-out devices; only devices placed BEYOND that standard count are charged, at the per-device layout_item_pricing rate. Removing an auto device never discounts.';

-- ── 2. The three placed device types ─────────────────────────────────────────
-- Per-device RATES need no new table: these are layout items, so they price through
-- layout_item_pricing with method 'each' like a door, and the portal's existing Options price
-- list edits them with no new UI.
--
-- outlet + lightSwitch are wall_snap: they sit against a wall but must NEVER block a door or a
-- shelf. That is already guaranteed structurally rather than by a name check — the slab
-- predicate keys on model_key, and none of these carry a slab model, so checkWallSlabOverlap
-- ignores them (wallSlab_test has pinned exactly this since the shelves shipped).
--
-- lightFixture carries NEITHER flag: it hangs from the ceiling anywhere inside the footprint.
-- Both free-placement attachment guards are keyed on `type === "loft"`, not on the absence of
-- flags, so an unflagged non-loft item already places and drags freely with only the
-- containment clamp. No new placement mode was needed, which is why this slice is small.
insert into public.layout_item_types
  (item_key, label, icon, color, default_width, default_height,
   wall_only, wall_snap, door_snap, short_label, sort_order, active,
   palette_group, model_key, depth_in, height_off_floor_in, hidden_until_priced)
values
  ('outlet',      'Outlet',       '🔌', '#7C3AED', 0.5, 0.3, false, true,  false, 'OUT',  70, true, 'electrical', 'outlet',      2, 24, true),
  ('lightSwitch', 'Light Switch', '🎚️', '#6D28D9', 0.5, 0.3, false, true,  false, 'SW',   71, true, 'electrical', 'lightSwitch', 2, 48, true),
  ('lightFixture','Light',        '💡', '#F59E0B', 0.8, 0.8, false, false, false, 'LIGHT',72, true, 'electrical', 'lightFixture',0, 96, true)
on conflict (item_key) do nothing;

-- Give every tenant the rows so the devices appear in their Options price list. They stay out
-- of the customer's palette until a rate is set (hidden_until_priced), so seeding is safe —
-- without it a builder could never reach the item to price it in the first place.
insert into public.client_layout_items (client_id, item_key, active)
select cc.client_id, k.item_key, true
from public.client_configs cc
cross join (values ('outlet'), ('lightSwitch'), ('lightFixture')) as k(item_key)
on conflict (client_id, item_key) do nothing;

-- ── 3. get_config: emit the package + standards ──────────────────────────────
-- Spliced onto the live body, not pasted from a stored copy — see 171 for why. Gated on
-- enabled AND a non-null price: an unpriced package is not offered, so the browser is never
-- shown a choice the estimate would refuse.
--
-- The PER-DEVICE rates are deliberately NOT emitted here. They already reach the browser
-- through layoutPricing, which get_config nulls out when show_pricing is off — so electrical
-- inherits that gating for free rather than growing a second, unguarded copy of the numbers.
-- The PACKAGE price is emitted, because the customer is choosing it and a priced choice with a
-- hidden price reads as broken — but it carries the same show_pricing gate, nulled rather than
-- dropped (the colors[] idiom) so a hide-prices tenant still gets the choice.
--
-- ⚠️ Pricing the devices is what TURNS THEM ON: hidden_until_priced means an unpriced device has
-- no palette button. A builder who prices the package but no devices gets the standard layout
-- and no way to add extras — which is coherent (extras are not offered until they are priced),
-- but it is not obvious, so the portal says so.
do $mig$
declare
  src text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text; new_blk text;
begin
  old_blk := $anchor$    'colors', coalesce(($anchor$;

  new_blk := $repl$    'electrical', coalesce((
      select jsonb_build_object(
               'label', es.package_label,
               'price', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
                             then es.package_price else null end,
               'outletSpacingFt', es.outlet_spacing_ft,
               'outletHeightIn', es.outlet_height_in,
               'outletAboveBenchIn', es.outlet_above_bench_in,
               'lightSpacingFt', es.light_spacing_ft,
               'switchHeightIn', es.switch_height_in,
               'includePanel', es.include_panel)
             || case when es.internal_only then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
      from public.electrical_settings es
      where es.client_id = cc.client_id and es.enabled and es.package_price is not null), 'null'::jsonb),
    'colors', coalesce(($repl$;

  if position('electrical_settings' in src) > 0 then
    raise notice '180: get_config already emits electrical - nothing to splice.';
    return;
  end if;
  if position(old_blk in src) = 0 then
    raise exception '180: the colors anchor was not found in the LIVE get_config body. '
                    'Re-derive it from a fresh pg_get_functiondef dump before applying.';
  end if;

  execute replace(src, old_blk, new_blk);
end
$mig$;

commit;

-- Every tenant's get_config md5 moves (a new top-level key). Nothing else may: check the
-- styles, colors, sizes and layoutItems counts, and note layoutItems grows by THREE for
-- everyone — the devices are seeded to all tenants but stay noPalette until priced.
