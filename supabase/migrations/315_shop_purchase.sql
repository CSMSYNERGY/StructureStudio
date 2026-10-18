-- 315_shop_purchase.sql — Online Inventory phase 4: buy and pay online, sign the invoice after.
--
-- ⛔ APPLY BY HAND. Pipe to `supabase db query --linked` (stdin), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('315', '315_shop_purchase') returning version, name;
--    REHEARSAL: sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/315_shop_purchase.sql | npx supabase db query --linked -o csv
--
-- ── WHY (Carolyn 2026-10-17) ─────────────────────────────────────────────────────────────
-- "When they purchase an online building they go through and purchase it and pay for it and then
-- an invoice is sent to them and they are required to sign the invoice." Estimates are never
-- signed. shop-checkout `purchase` creates the customer's estimate (accepted by the purchase, a
-- click), the order, takes the card payment (which sells the unit through payments_claim_inventory)
-- and raises an "Invoice to approve" for the builder; the customer signs the invoice when it arrives.
--
-- ── WHAT THIS ADDS ───────────────────────────────────────────────────────────────────────
--   1. shop_unit_holds — one row per building being bought RIGHT NOW. The claim trigger sells to
--      the first payment but does not stop a second one being charged, so shop-checkout takes this
--      hold BEFORE any card is touched (primary key = the unit) and drops it when the purchase
--      fails. A hold older than 15 minutes is stale and may be taken over.
--   2. invoice_requests.source may be 'shop_purchase'.
--   3. shop_requests: kind ('request' | 'purchase'), paid_cents, design_codes — one row per checkout
--      either way, so the builder's inbox shows paid purchases beside purchase requests.

begin;

create table public.shop_unit_holds (
  unit_id uuid primary key references public.inventory_units(id) on delete cascade,
  client_id text not null,
  held_at timestamptz not null default now(),
  holder text not null   -- the customer session's identity (phone or email), for the log
);
alter table public.shop_unit_holds enable row level security;
-- No policy: service role only (shop-checkout).

alter table public.invoice_requests drop constraint if exists invoice_requests_source_check;
alter table public.invoice_requests add constraint invoice_requests_source_check
  check (source = any (array['customer_accept'::text, 'backfill'::text, 'shop_purchase'::text]));

alter table public.shop_requests
  add column kind text not null default 'request' check (kind in ('request', 'purchase')),
  add column paid_cents bigint,
  add column design_codes text[];

select '315' as migration,
  to_regclass('public.shop_unit_holds') is not null as holds_table,
  (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.invoice_requests'::regclass
     and c.conname = 'invoice_requests_source_check') like '%shop_purchase%' as source_ok;

commit;
