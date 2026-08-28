-- 152_realtime_pricing.sql — the material-cost pricing engine, dark.
--
-- Carolyn, 2026-08-27, sharing the 2015 Sterling Supply workbook: "The whole goal of this
-- is … every quarter, all they do is they come in here and say, oh, our eight foot two by
-- fours are now twelve dollars. Now that automatically changes the price on that building.
-- That's the whole point of it."
--
-- The model, verified against the workbook itself (Barn 8x8: materials 1909 → price
-- 3779.82 = 1909 × 1.8 × 1.1):
--   materials list (one place, per tenant)  →  per-size bill of materials  →
--   ordered overhead lines  →  building_sizes.base_price.
-- Sales 5% / Delivery 10% / Build 10% in her sheet do NOT change the price — they are
-- carve-out allocations OF the price, shown so the builder sees where it goes; SS Profit
-- is the remainder. The `kind` check below encodes exactly that three-way split.
--
-- COEXISTENCE IS THE DESIGN CONSTRAINT, not the feature. "Not everybody's going to do
-- this … I don't want his current prices to become deactivated." So: base_price stays the
-- ONE live column every reader already consumes (get_config, both browser calculators,
-- submit-estimate — none of them change); the engine only decides WHO WRITES it. The
-- toggle backs up the manual price on the way in and restores it on the way out, and a
-- size with no BOM is never touched ("if there is no sheet uploaded in real time, it will
-- use the old one"). Frozen designs.estimate_lines snapshots are never re-priced.
--
-- Dark on arrival: nothing reads these tables until the portal-settings rtp_* actions
-- land, and those are gated on the on_demand_pricing entitlement (sold since 124, pay-only
-- as of this line's sibling edit in portal-billing/admin-catalog).
--
-- Hand-applied via MCP execute_sql (not recorded in supabase_migrations).

-- ── Master material list ───────────────────────────────────────────────────────────────
-- "There needs to be one place, very much like pricing, where they upload everything that
-- they buy." Category is presentational grouping only (Lumber / Roofing / …) — free text,
-- repeated per row, because the engine never dispatches on it. `name` is the join key the
-- spreadsheet round-trip matches on, so it is unique per tenant. Archive with active=false,
-- never delete: BOM lines reference these rows and a deleted material would silently
-- change a price.
create table public.rtp_materials (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null,
  category   text not null default '',
  name       text not null,
  unit_cost  numeric not null default 0,     -- dollars, like every catalog price
  sort_order int  not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, name)
);
create index rtp_materials_client_idx on public.rtp_materials (client_id, sort_order);

-- ── Bill of materials, per size ────────────────────────────────────────────────────────
-- Keyed to building_sizes.id so size identity stays the one the whole pricing pipeline
-- already uses — no second style+width+length keyspace to drift. Sections are Carolyn's
-- explicit re-grouping ("I want it broken down to floor, walls, and roof. And then
-- interior stuff"), with 'other' as the escape hatch. The same material may appear in two
-- sections (2x4s in the floor AND the walls), hence the three-column uniqueness.
-- on delete restrict on the material: archiving is the supported removal path.
create table public.rtp_bom_lines (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  size_id     uuid not null references public.building_sizes(id) on delete cascade,
  material_id uuid not null references public.rtp_materials(id) on delete restrict,
  section     text not null default 'other'
    check (section in ('floor','walls','roof','interior','other')),
  qty         numeric not null default 0,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (size_id, material_id, section)
);
create index rtp_bom_lines_client_idx on public.rtp_bom_lines (client_id);
create index rtp_bom_lines_size_idx   on public.rtp_bom_lines (size_id);

-- ── Overhead lines, ordered ────────────────────────────────────────────────────────────
-- "This needs to be very versatile for them to be able to add any kind of overhead costs
-- and then add in their markup." Applied in sort_order to a running total that starts at
-- the materials sum:
--   multiplier        running := running * value          (her ×1.8 and ×1.1 rows)
--   flat              running := running + value          (a fixed fee)
--   percent_of_price  NO-OP on the price                  (her Sales/Delivery/Build rows)
-- percent_of_price is reported as an allocation of the final price; the preview must say
-- so in words, or "Sales 5%" will be read as +5%.
create table public.rtp_overhead_lines (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null,
  label      text not null,
  kind       text not null check (kind in ('multiplier','percent_of_price','flat')),
  value      numeric not null,
  sort_order int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rtp_overhead_lines_client_idx on public.rtp_overhead_lines (client_id, sort_order);

-- ── The toggle and the backup ──────────────────────────────────────────────────────────
-- Tenant-wide, like show_pricing. manual_base_price is what makes the toggle reversible:
-- copied from base_price the moment real-time pricing goes live, restored if it is turned
-- back off. A size created while the toggle is ON has no backup, so toggling OFF leaves
-- its price as-is — the conservative failure.
alter table public.client_settings
  add column if not exists rtp_enabled boolean not null default false;
alter table public.building_sizes
  add column if not exists manual_base_price numeric;

-- ── rtp_compute_prices: the ONE price authority ────────────────────────────────────────
-- Pure read. The settings preview renders these rows verbatim — the browser does no RTP
-- math, because three hand-synchronized estimate calculators is already the repo's ceiling.
-- Only ACTIVE materials and ACTIVE overhead lines count. Prices round to cents.
-- allocations: [{label, kind, value, amount}] for percent_of_price lines, plus a final
-- {"label": "Profit"} remainder row = price − materials − Σ percent amounts.
create or replace function public.rtp_compute_prices(p_client_id text)
returns table (
  size_id         uuid,
  style_id        uuid,
  size_label      text,
  materials_total numeric,
  computed_price  numeric,
  allocations     jsonb
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  r        record;
  o        record;
  running  numeric;
  alloc    jsonb;
  alloc_sum numeric;
begin
  for r in
    select bs.id, bs.style_id, bs.label,
           round(sum(b.qty * m.unit_cost), 2) as mat_total
    from public.rtp_bom_lines b
    join public.rtp_materials m on m.id = b.material_id and m.active
    join public.building_sizes bs on bs.id = b.size_id
    where b.client_id = p_client_id
    group by bs.id, bs.style_id, bs.label
    having sum(b.qty * m.unit_cost) is not null
  loop
    running := r.mat_total;
    alloc := '[]'::jsonb;
    for o in
      select label, kind, value
      from public.rtp_overhead_lines
      where client_id = p_client_id and active
      order by sort_order, created_at
    loop
      if o.kind = 'multiplier' then
        running := running * o.value;
      elsif o.kind = 'flat' then
        running := running + o.value;
      end if;
      -- percent_of_price: resolved after the loop, against the final price
    end loop;
    running := round(running, 2);

    alloc_sum := 0;
    for o in
      select label, kind, value
      from public.rtp_overhead_lines
      where client_id = p_client_id and active and kind = 'percent_of_price'
      order by sort_order, created_at
    loop
      alloc := alloc || jsonb_build_object(
        'label', o.label, 'kind', o.kind, 'value', o.value,
        'amount', round(running * o.value / 100.0, 2));
      alloc_sum := alloc_sum + round(running * o.value / 100.0, 2);
    end loop;
    alloc := alloc || jsonb_build_object(
      'label', 'Profit', 'kind', 'remainder', 'value', null,
      'amount', round(running - r.mat_total - alloc_sum, 2));

    size_id := r.id; style_id := r.style_id; size_label := r.label;
    materials_total := r.mat_total; computed_price := running; allocations := alloc;
    return next;
  end loop;
end;
$$;

-- ── rtp_apply: write computed prices into the live column ──────────────────────────────
-- Only when the toggle is ON, and only for sizes that HAVE a bill of materials — a
-- BOM-less size keeps its manual price and the NULL-means-unpriced contract is untouched.
create or replace function public.rtp_apply(p_client_id text)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  n integer := 0;
begin
  if not exists (
    select 1 from public.client_settings
    where client_id = p_client_id and rtp_enabled
  ) then
    return 0;
  end if;

  update public.building_sizes bs
  set base_price = c.computed_price,
      updated_at = now()
  from public.rtp_compute_prices(p_client_id) c
  where bs.id = c.size_id
    and bs.base_price is distinct from c.computed_price;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ── rtp_set_enabled: the atomic swap ───────────────────────────────────────────────────
-- ON (from OFF): back up every current price, then apply. Idempotent — calling ON while
-- already ON never re-copies the backup, so the manual prices survive however many times
-- the button is pressed. OFF: restore every backed-up price. The backup values are kept
-- (not nulled) purely as an audit trail; the next ON overwrites them.
create or replace function public.rtp_set_enabled(p_client_id text, p_on boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  currently boolean;
begin
  select rtp_enabled into currently
  from public.client_settings where client_id = p_client_id;
  if currently is null then
    raise exception 'no client_settings row for %', p_client_id;
  end if;

  if p_on and not currently then
    update public.building_sizes
    set manual_base_price = base_price
    where client_id = p_client_id;
    update public.client_settings
    set rtp_enabled = true where client_id = p_client_id;
    perform public.rtp_apply(p_client_id);
  elsif not p_on and currently then
    update public.client_settings
    set rtp_enabled = false where client_id = p_client_id;
    update public.building_sizes
    set base_price = manual_base_price,
        updated_at = now()
    where client_id = p_client_id
      and manual_base_price is not null
      and base_price is distinct from manual_base_price;
  end if;
end;
$$;

-- ── Lockdown ───────────────────────────────────────────────────────────────────────────
-- Same posture as client_settings: service-role only, RLS on with NO policy (fail-closed),
-- and the vestigial default grants revoked so the grant layer 401s too (the lesson from
-- 025). Unit costs and margins are the most sensitive numbers a builder gives us; they
-- reach the browser only through portal-settings, which checks the entitlement first.
alter table public.rtp_materials      enable row level security;
alter table public.rtp_bom_lines      enable row level security;
alter table public.rtp_overhead_lines enable row level security;
revoke all on public.rtp_materials      from anon, authenticated;
revoke all on public.rtp_bom_lines      from anon, authenticated;
revoke all on public.rtp_overhead_lines from anon, authenticated;
-- FROM PUBLIC, not just the two API roles: Postgres grants EXECUTE on every new function
-- to PUBLIC by default, and PostgREST exposes public-schema functions as /rpc/ endpoints —
-- verified live before this line existed: has_function_privilege('anon','rtp_apply') was
-- TRUE after revoking only anon/authenticated. Left open, any visitor could re-price (or
-- rtp_set_enabled: mass-rewrite) ANY tenant's price book by POSTing /rest/v1/rpc/….
revoke all on function public.rtp_compute_prices(text) from public, anon, authenticated;
revoke all on function public.rtp_apply(text)          from public, anon, authenticated;
revoke all on function public.rtp_set_enabled(text, boolean) from public, anon, authenticated;

comment on table public.rtp_materials is
  'Real-time pricing: master material cost list (Carolyn 2026-08-27, the 2015 workbook''s '
  'Costs sheet). The only thing a builder updates quarterly; rtp_apply re-prices from it.';
comment on table public.rtp_bom_lines is
  'Real-time pricing: bill of materials per building_sizes row, grouped floor/walls/roof/'
  'interior. qty x rtp_materials.unit_cost is the materials total rtp_compute_prices sums.';
comment on table public.rtp_overhead_lines is
  'Real-time pricing: ordered overhead lines. multiplier/flat change the price; '
  'percent_of_price is a carve-out allocation OF the price (Sales/Delivery/Build in the '
  'source workbook) and never changes it.';
