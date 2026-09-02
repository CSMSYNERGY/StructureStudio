-- 181_electrical_items.sql — a builder's own electrical items, and a height for the panel
-- (Carolyn, 2026-09-02, both in one ask).
--
-- 1. THE PANEL GETS A HEIGHT. It was a bare yes/no on the package; it moves onto the
--    measurements row beside the outlet and switch heights, because a panel is mounted at a
--    height like everything else and a shop needs the number. The checkbox stays — "panel or
--    no panel" is still a real choice, it just now carries a measurement with it.
--
-- 2. A BUILDER'S OWN ELECTRICAL ITEMS. Outlets, lights and switches are the standard layout;
--    everything else a builder sells — a ceiling fan, a flood light, a 220V receptacle, an
--    exhaust fan — is theirs to name and price. This is the fixture_items pattern (a per-tenant
--    catalog of things placed on the building) rather than more layout_item_types rows, because
--    the list is per-tenant and open-ended, not a fixed set of three.
--
-- THE TWO PRICES, and this is the whole reason the table looks like this (Carolyn's words):
-- "there should be 2 pricing options. One is for this additional item to be added TO the
-- existing package and the other is that there is no package and they are selling this item
-- individually."
--
--   price_with_package  — charged when the customer HAS the electrical package
--   price_standalone    — charged when they do NOT
--
-- A builder charges less for a fan when an electrician is already on site wiring the package
-- than when that fan is the only reason for the trip, so these are genuinely different numbers
-- and neither is derivable from the other. Either may be NULL, and NULL means NOT OFFERED IN
-- THAT MODE — the same not-yet-priced contract as building_sizes.base_price. An item priced
-- only with_package cannot be bought without one; an item priced only standalone disappears
-- once the customer takes the package. Both are useful states, so neither is a fallback for
-- the other: falling back would silently charge a price the builder never agreed to.

begin;

alter table public.electrical_settings
  add column if not exists panel_height_in numeric not null default 60 check (panel_height_in >= 0);

comment on column public.electrical_settings.panel_height_in is
  'Mount height for the electrical panel, inches off the floor. Spec only — it rides on the package quote line and never affects a count or a price.';

create table if not exists public.electrical_items (
  id                  uuid primary key default gen_random_uuid(),
  client_id           text not null,
  name                text not null,
  icon                text not null default '⚡',
  -- How it attaches, and the only two shapes the designer has: against a wall (snaps to the
  -- interior face, never blocks a door) or free inside the footprint (a ceiling fitting).
  mount               text not null default 'wall' check (mount in ('wall', 'ceiling')),
  height_off_floor_in numeric,
  -- NULL in either column = not offered in that mode. NOT a fallback for the other — see the
  -- header. Two independent offers, each priced or not.
  price_with_package  numeric check (price_with_package is null or price_with_package >= 0),
  price_standalone    numeric check (price_standalone   is null or price_standalone   >= 0),
  taxable             boolean not null default true,
  active              boolean not null default true,
  -- Rep designer only, hidden from the customer-facing page. Visibility only: a rep-selected
  -- item still prices. Same semantics as style_wall_heights.internal_only.
  internal_only       boolean not null default false,
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (client_id, name)
);

alter table public.electrical_items enable row level security;

-- Same posture as insulation_offerings / electrical_settings: owner-scoped SELECT, NO write
-- policy — every write goes through portal-settings on the service role, so the tenant comes
-- from the JWT and is never trusted from the body.
drop policy if exists electrical_items_owner_read on public.electrical_items;
create policy electrical_items_owner_read on public.electrical_items
  for select to authenticated
  using (client_id = current_client_id());

revoke all on public.electrical_items from anon;

create index if not exists electrical_items_client_idx on public.electrical_items (client_id, sort_order);

comment on table public.electrical_items is
  'Per-tenant catalog of electrical items beyond the standard layout. TWO prices: price_with_package (customer has the package) and price_standalone (they do not). NULL = not offered in that mode, never a fallback to the other.';

-- ── get_config ───────────────────────────────────────────────────────────────
-- Emits panelHeightIn on the package, and an electricalItems array.
--
-- ⚠️ The OFFERED FLAGS are emitted separately from the PRICES, and that is load-bearing. Prices
-- are nulled when show_pricing is off (the colors[] idiom), so "price is null" cannot also mean
-- "not offered in this mode" — a hide-prices tenant would lose every item. `withPackage` and
-- `standalone` are computed from NOT NULL server-side and are always present, so the browser
-- knows WHAT is offered without being told what it costs.
do $mig$
declare
  src text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text; new_blk text;
begin
  old_blk := $anchor$               'switchHeightIn', es.switch_height_in,
               'includePanel', es.include_panel)$anchor$;

  new_blk := $repl$               'switchHeightIn', es.switch_height_in,
               'panelHeightIn', es.panel_height_in,
               'includePanel', es.include_panel)$repl$;

  if position('panelHeightIn' in src) = 0 then
    if position(old_blk in src) = 0 then
      raise exception '181: the electrical block was not found in the LIVE get_config body — apply 180 first.';
    end if;
    src := replace(src, old_blk, new_blk);
  else
    raise notice '181: panelHeightIn already emitted.';
  end if;

  if position('electrical_items' in src) = 0 then
    old_blk := $anchor2$    'colors', coalesce(($anchor2$;
    new_blk := $repl2$    'electricalItems', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ei.id, 'name', ei.name, 'icon', ei.icon, 'mount', ei.mount,
               'heightOffFloorIn', ei.height_off_floor_in,
               -- Offered-in-this-mode, ALWAYS emitted; the prices below may be nulled.
               'withPackage', ei.price_with_package is not null,
               'standalone', ei.price_standalone is not null,
               'priceWithPackage', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
                                        then ei.price_with_package else null end,
               'priceStandalone', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
                                       then ei.price_standalone else null end)
             || case when ei.internal_only then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
             order by ei.sort_order, ei.name)
      from public.electrical_items ei
      where ei.client_id = cc.client_id and ei.active
        and (ei.price_with_package is not null or ei.price_standalone is not null)), '[]'::jsonb),
    'colors', coalesce(($repl2$;
    if position(old_blk in src) = 0 then
      raise exception '181: the colors anchor was not found in the LIVE get_config body.';
    end if;
    src := replace(src, old_blk, new_blk);
  else
    raise notice '181: electricalItems already emitted.';
  end if;

  execute src;
end
$mig$;

commit;

-- An item with NEITHER price set is not emitted at all — ship-dark, so a builder can draft the
-- list before deciding what to charge. Every tenant's get_config md5 moves (one new key).
