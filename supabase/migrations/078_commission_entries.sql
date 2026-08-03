-- 078_commission_entries.sql
-- Commission tracking — slice 3 foundation: the payout ledger + order attribution columns.
-- Applied live via MCP 2026-08-02; in-repo record, do NOT `db push`.
--
-- Order attribution/base (nullable; populated in later sub-slices — pre-tax base from the GHL
-- estimate subtotal via the existing sync, submitter auto-captured or owner-assigned). No
-- designer/submit edits needed.
alter table public.orders add column if not exists submitter_user_id     uuid;
alter table public.orders add column if not exists pretax_subtotal_cents  integer;

-- One row per earner per order (a split = multiple rows for the same order_id). A clawback is a
-- separate negative-amount row (kind='clawback') created in the pay period a cancellation lands
-- in, linked back to the original via clawback_of. Materialized (not compute-on-read) because
-- approve / mark-paid / clawback are stateful and each row snapshots the rate it used.
create table if not exists public.commission_entries (
  id             bigint generated always as identity primary key,
  client_id      text not null,
  order_id       uuid not null,
  earner_user_id uuid,
  base_cents     integer,
  rate_percent   numeric(6,3),
  split_share    numeric(6,3),
  amount_cents   integer,
  earned_on      date,
  period_key     text,
  kind           text not null default 'commission' check (kind in ('commission','clawback')),
  status         text not null default 'pending' check (status in ('pending','payable','paid','excluded')),
  is_override    boolean not null default false,
  clawback_of    bigint references public.commission_entries(id) on delete set null,
  note           text,
  approved_at    timestamptz,
  paid_at        timestamptz,
  paid_batch     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists commission_entries_client_period_idx on public.commission_entries (client_id, period_key);
create index if not exists commission_entries_order_idx on public.commission_entries (order_id);
create index if not exists commission_entries_earner_idx on public.commission_entries (client_id, earner_user_id);

alter table public.commission_entries enable row level security;
-- Service-role only (confidential per-person $). Reads/writes go through the portal-commissions
-- edge fn, which enforces own-vs-all visibility. Browser roles get nothing.
revoke all on public.commission_entries from anon, authenticated;
