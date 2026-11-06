-- 311_shop_requests.sql — Online Shop phase 3: the cart's "purchase request" checkout.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('311', '311_shop_requests') returning version, name;
--    REHEARSAL: sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/311_shop_requests.sql | npx supabase db query --linked -o csv
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- 310 is the Online Shop's first file (applied 2026-10-17). Take the next free number at apply.
--
-- ── WHY (Carolyn 2026-10-17) ─────────────────────────────────────────────────────────────
-- A shopper puts one or more lot buildings in a cart and checks out. For a builder without live
-- card payments (every builder today but the CSM test account) checkout sends the builder a
-- PURCHASE REQUEST: who wants which buildings, delivered where, at what price/delivery/tax and
-- what deposit would be due. Nothing is charged and no building is marked sold — the builder
-- follows up and sends an estimate from the Inventory tab as usual. Phase 4 adds card payment.
--
-- One row per checkout. `items` is the server's own priced snapshot (shop-checkout recomputes
-- every figure; nothing the browser sent is trusted), so the builder sees exactly what the
-- shopper was shown.

begin;

create table public.shop_requests (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  status text not null default 'new' check (status in ('new','handled')),
  contact_id uuid,
  name text not null check (char_length(name) between 1 and 200),
  phone text not null check (char_length(phone) <= 40),
  email text check (email is null or char_length(email) <= 200),
  street text, city text, state text, zip text,
  message text check (message is null or char_length(message) <= 2000),
  pay_in_full boolean not null default false,
  -- [{unitId, serial, label, lotName, priceCents, deliveryCents, deliveryNote, taxCents, taxLabel,
  --   totalCents, dueNowCents}]
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  total_cents bigint,
  due_now_cents bigint,
  notified_at timestamptz,
  notify_error text,
  handled_at timestamptz,
  handled_by uuid,
  created_at timestamptz not null default now()
);
create index shop_requests_client on public.shop_requests (client_id, created_at desc);
alter table public.shop_requests enable row level security;
-- Owner read like every other tenant table; every write goes through shop-checkout (insert) and
-- portal-settings (mark handled), both service role.
create policy shop_requests_owner_select on public.shop_requests
  for select to authenticated using (client_id = current_client_id());

select '311' as migration, to_regclass('public.shop_requests') is not null as shop_requests_table;

commit;
