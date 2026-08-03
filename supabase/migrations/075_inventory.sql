-- 075_inventory: builder locations, shared serial numbers, and inventory units.
--
-- Carolyn 2026-08-01 (mockup approved): builders create INVENTORY buildings in the
-- designer — real physical units that sit on a sales lot waiting to sell. Each unit:
--   * takes the next number in ONE per-builder serial sequence, in creation order.
--     Orders will draw from the SAME sequence when Build Scheduling ships — that is why
--     the counter lives on client_settings and is taken through take_next_serial(),
--     not computed from max(inventory_units.serial).
--   * sits at one of the builder's sales locations (Settings → Branding for now).
--   * carries its own ASKING PRICE in cents — markdowns never touch the catalog.
--   * can be estimated to MANY potential customers: each "send estimate" creates a
--     normal designs row (its own short_code + GHL estimate) linking back via
--     designs.inventory_unit_id. When one accepts, the unit flips sold and the portal
--     flags the other open estimates — nothing in the CRM is auto-touched.
--
-- The unit's own design (the "master") is a designs row with status='inventory':
--   * created ONLY by portal-settings (service role) — save_design's anon p_status
--     guard still allows nothing but 'draft', so the public internet cannot mint one.
--   * excluded from the Designs/Contacts tabs and skipped by sync-design-status
--     (it has no GHL estimate; the 'sent' baseline would mispromote it — same
--     reasoning as 'draft' in migration 063).
--   * reuses load_design / versions / PDF / delete machinery unchanged.

-- ── Sales locations ──────────────────────────────────────────────────────────
create table public.builder_locations (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  name text not null,
  street text,
  city text,
  state text,
  zip text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index builder_locations_client on public.builder_locations (client_id, sort_order);
alter table public.builder_locations enable row level security;
-- Owner read (same shape as designs/orders); ALL writes go through portal-settings
-- (service role) so operator view-as, can_write gating and audit apply.
create policy builder_locations_owner_select on public.builder_locations
  for select to authenticated using (client_id = current_client_id());

-- ── Shared serial sequence ───────────────────────────────────────────────────
-- One counter per builder. NULL = never configured; the first take initializes at 1
-- unless the builder set a starting number first (their shop may be at #12,000).
alter table public.client_settings add column next_serial bigint;

-- Atomic take: the UPDATE..RETURNING locks the row, so two simultaneous saves can
-- never mint the same serial. SECURITY DEFINER + service-role-only execute: serials
-- are handed out exclusively by edge functions (portal-settings now, orders later).
create function public.take_next_serial(p_client_id text)
returns bigint
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_serial bigint;
begin
  -- Ensure the row exists (a brand-new tenant may have no client_settings row yet).
  insert into public.client_settings (client_id, next_serial)
  values (p_client_id, 1)
  on conflict (client_id) do nothing;

  update public.client_settings
     set next_serial = coalesce(next_serial, 1) + 1,
         updated_at = now()
   where client_id = p_client_id
  returning next_serial - 1 into v_serial;

  if v_serial is null then
    raise exception 'unknown client';
  end if;
  return v_serial;
end
$$;
revoke execute on function public.take_next_serial(text) from public, anon, authenticated;
grant execute on function public.take_next_serial(text) to service_role;

-- ── Inventory units ──────────────────────────────────────────────────────────
create table public.inventory_units (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  serial bigint not null,
  design_short_code text not null,
  location_id uuid references public.builder_locations(id) on delete set null,
  asking_price_cents integer,
  -- 'available' | 'sold'. Manual flips via portal-settings; the portal ALSO derives
  -- sold-ness from any linked estimate reaching accepted+, so a webhookless sale
  -- still displays right. Stored status wins when explicitly set to sold.
  status text not null default 'available' check (status in ('available','sold')),
  sold_design_short_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, serial)
);
create index inventory_units_client on public.inventory_units (client_id, created_at desc);
alter table public.inventory_units enable row level security;
create policy inventory_units_owner_select on public.inventory_units
  for select to authenticated using (client_id = current_client_id());

-- ── Estimates link back to the unit they were sent from ─────────────────────
alter table public.designs add column inventory_unit_id uuid
  references public.inventory_units(id) on delete set null;
create index designs_inventory_unit on public.designs (inventory_unit_id)
  where inventory_unit_id is not null;

-- ── The master design status ─────────────────────────────────────────────────
alter table public.designs drop constraint designs_status_check;
alter table public.designs add constraint designs_status_check
  check (status = any (array['draft'::text, 'inventory'::text, 'sent'::text, 'accepted'::text, 'invoiced'::text, 'delivered'::text]));
