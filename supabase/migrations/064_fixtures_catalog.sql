-- 064_fixtures_catalog: the "Fixtures" catalog — owner-defined placeable products
-- (doors first; windows/ramps reuse the same table via `category`). Sits ALONGSIDE
-- the existing layout_item_types / client_layout_items door items — it does not
-- touch or replace them. One flat row per door (Colors-tab model): its own size +
-- price + swing/operation + photo, like a color is one row.
--
-- Mirrors 006_catalog_pricing / 012_catalog_rls_scope conventions: client_id-keyed,
-- image_url, set_updated_at trigger (from 004), owner-scoped authenticated read via
-- current_client_id(), anon reaches it ONLY through get_fixtures() (SECURITY
-- DEFINER, price-gated by client_settings.show_pricing exactly like get_catalog).
-- Writes are service-role only for now (portal editor edge function, Slice 2) —
-- owner write policies come with that UI.
--
-- Additive and INERT: nothing reads this table until the portal editor + designer
-- land. HAND-APPLY via MCP/SQL editor, then record in the ledger. Do NOT db push.
-- BOM-free.

-- ── Table ────────────────────────────────────────────────────────────
create table if not exists public.fixture_items (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null,
  category      text not null default 'door',      -- 'door' | 'window' | 'ramp' | ...
  name          text not null,                     -- owner free-text, e.g. 'Steel door'
  width_in      numeric not null,                  -- drives render width (/12 -> feet)
  height_in     numeric not null,
  -- NULL-price contract (matches building_sizes.base_price): NULL = not-yet-priced
  -- (treat as not offered), 0 = included/free, >0 = priced.
  price         numeric,
  -- Swing: check the ways this door can swing. A default is only meaningful when
  -- BOTH are allowed (the customer flips to the other on the plan).
  swing_in      boolean not null default false,
  swing_out     boolean not null default false,
  swing_default text,                              -- 'in' | 'out' | null
  -- Operation: right/left are hinge sides (default when both), double = both leaves
  -- open, slide up = garage/roll-up.
  op_right      boolean not null default false,
  op_left       boolean not null default false,
  op_double     boolean not null default false,
  op_slideup    boolean not null default false,
  op_default    text,                              -- 'right' | 'left' | null
  image_url     text,                              -- fixtures bucket, {client_id}/...
  sort_order    int  not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint fixture_items_swing_default_chk    check (swing_default is null or swing_default in ('in','out')),
  constraint fixture_items_op_default_chk       check (op_default    is null or op_default    in ('right','left'))
);

create index if not exists fixture_items_client_idx on public.fixture_items (client_id, category, sort_order);

drop trigger if exists fixture_items_set_updated_at on public.fixture_items;
create trigger fixture_items_set_updated_at
  before update on public.fixture_items
  for each row execute function public.set_updated_at();

-- ── RLS: owner-scoped read; anon only via get_fixtures(); writes service-role ──
alter table public.fixture_items enable row level security;

drop policy if exists fixture_items_owner_read on public.fixture_items;
create policy fixture_items_owner_read on public.fixture_items
  for select to authenticated using (client_id = public.current_client_id());

revoke select on public.fixture_items from anon;

-- ── Storage bucket for door photos (also the future 3D source art) ───────────
-- Public like `branding` (021): the designer <img src>s it; owner uploads go
-- through the portal editor edge function (service role bypasses RLS), so no
-- anon/authenticated write policy is created here.
insert into storage.buckets (id, name, public)
values ('fixtures', 'fixtures', true)
on conflict (id) do update set public = true;

-- ── get_fixtures: single-call per-tenant fixtures for the public designer ─────
-- SECURITY DEFINER so it reads the owner-private table AND service-role-only
-- client_settings (show_pricing). Same tenant gate as get_catalog. When
-- show_pricing is FALSE, `price` is OMITTED (absent, not null) so prices never
-- reach an anon browser for tenants who haven't opted in. camelCase, one array.
create or replace function public.get_fixtures(p_client_id text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_show   boolean;
  v_result jsonb;
begin
  if not exists (select 1 from public.client_configs where client_id = p_client_id) then
    raise exception 'unknown client';
  end if;

  select coalesce(cs.show_pricing, false) into v_show
    from public.client_settings cs where cs.client_id = p_client_id;
  v_show := coalesce(v_show, false);

  select coalesce(jsonb_agg(
    case when v_show then
      jsonb_build_object(
        'id', fi.id, 'category', fi.category, 'name', fi.name,
        'widthIn', fi.width_in, 'heightIn', fi.height_in, 'price', fi.price,
        'swingIn', fi.swing_in, 'swingOut', fi.swing_out, 'swingDefault', fi.swing_default,
        'opRight', fi.op_right, 'opLeft', fi.op_left, 'opDouble', fi.op_double,
        'opSlideUp', fi.op_slideup, 'opDefault', fi.op_default,
        'imageUrl', fi.image_url, 'sortOrder', fi.sort_order)
    else
      jsonb_build_object(
        'id', fi.id, 'category', fi.category, 'name', fi.name,
        'widthIn', fi.width_in, 'heightIn', fi.height_in,
        'swingIn', fi.swing_in, 'swingOut', fi.swing_out, 'swingDefault', fi.swing_default,
        'opRight', fi.op_right, 'opLeft', fi.op_left, 'opDouble', fi.op_double,
        'opSlideUp', fi.op_slideup, 'opDefault', fi.op_default,
        'imageUrl', fi.image_url, 'sortOrder', fi.sort_order)
    end
    order by fi.category, fi.sort_order, fi.name)
    , '[]'::jsonb)
  into v_result
  from public.fixture_items fi
  where fi.client_id = p_client_id and fi.active
    and fi.price is not null;   -- unpriced = not yet offered (NULL-price contract)

  return v_result;
end;
$$;

revoke execute on function public.get_fixtures(text) from public;
grant  execute on function public.get_fixtures(text) to anon, authenticated;
