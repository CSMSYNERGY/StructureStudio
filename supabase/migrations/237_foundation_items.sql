-- 237_foundation_items: gravel pad, fence removal, piers, concrete slab — priced any of the seven
-- ways. Applied live 2026-09-14; this file records what ran.
--
-- WHY. Carolyn 2026-09-14: under the new Services heading, "for foundation, I want to be able to
-- add in gravel pad, Fence removal, piers, and concrete slab. ALL of these should have multiple
-- ways of charging for them." Site work done before the building arrives; nothing on the plan.
--
-- SHAPE. A FIXED set of four ids with a label override (the style_cladding shape, 207), not an
-- open list: she named exactly four, the ids are stable join keys in designs.selections and the
-- estimate, and there is no add/sort/delete UI to build. PER TENANT, not per style — site work
-- does not depend on which building style is bought. Same not-yet-priced contract as everywhere:
-- rate NULL = not offered, 0 = included (no line), > 0 = charged. `active` is the card's "Offer"
-- tick, which parks a rate without retyping it. `internal_only` is VISIBILITY only — a
-- rep-selected item still prices (the wall-height/insulation rule).
--
-- QUANTITY. Three bases take a number the building cannot supply — `each` (pier count),
-- `lineal_ft` (fence feet), `sqft_option` (pad/slab sq ft, defaulting to the footprint). The
-- customer enters it in the designer; _shared/foundation.ts is the one rule for defaults and
-- limits, mirrored by the designer's foundationQtyOf. The other four derive from the building.

begin;

create table if not exists public.foundation_items (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null,
  item_id        text not null
                   check (item_id in ('gravel_pad', 'fence_removal', 'piers', 'concrete_slab')),
  label_override text,
  rate           numeric check (rate is null or rate >= 0),
  basis          text not null default 'each'
                   check (basis in ('each', 'lineal_ft', 'sqft_option', 'sqft_building',
                                    'perimeter_building', 'pct_building_price', 'pct_estimate_total')),
  taxable        boolean not null default true,
  internal_only  boolean not null default false,
  active         boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (client_id, item_id)
);

alter table public.foundation_items enable row level security;
drop policy if exists foundation_items_owner_read on public.foundation_items;
create policy foundation_items_owner_read on public.foundation_items
  for select to authenticated using (client_id = public.current_client_id());
-- No write policy on purpose: every write goes through portal-settings on the service role.
-- The public designer never reads this table directly; it arrives via get_config (238).
revoke all on public.foundation_items from anon;
create index if not exists foundation_items_client_idx on public.foundation_items (client_id, sort_order);

comment on table public.foundation_items is
  'Site-work services (237): four fixed ids per tenant. rate NULL = not offered, 0 = included, >0 = charged by `basis`. internal_only hides the item from the customer page only.';
comment on column public.foundation_items.basis is
  'each = rate × a count the customer enters (default 1); lineal_ft = rate × feet entered; sqft_option = rate × sq ft entered (default: the building footprint); sqft_building = rate × footprint; perimeter_building = rate × 2(w+l); pct_building_price / pct_estimate_total = a percentage.';

commit;
