-- 204_rate_buckets: a fixed-window request counter for the anon-callable edge functions.
--
-- WHY. `submit-estimate` is reachable with the public anon key and had no cap of any kind,
-- while `capture-lead` — the other anonymous surface, and the cheaper one — has been capped
-- per tenant since 2026-07-30 (migration-free, because it can count rows in captured_leads).
-- One submit-estimate call spends the tenant's money: several CRM API calls, a branded email
-- to whatever address the body names, a sales-tax lookup that can be a metered Avalara
-- request, and the wallet debit behind it.
--
-- WHY A TABLE AND NOT A ROW COUNT. capture-lead counts rows because its damaging shape is
-- MANY DIFFERENT phones, which grows a table. submit-estimate's damaging shape is the
-- opposite: ONE design resubmitted in a loop, which moves no row count at all, because
-- `designs` is UPDATEd and never inserted. The count therefore has to be per REQUEST.
--
-- SHAPE. One row per bucket, where a bucket is `<function>:<client_id>` — the same
-- one-row-per-bucket idea as 053_admin_auth_throttle, so an anonymous flood cannot grow this
-- table beyond one row per tenant per function. A fixed window: `window_started_at` plus a
-- counter, both rewritten by the caller when the window has rolled over. Two concurrent
-- requests can undercount by one; that is a rate limit, not an accounting ledger.
--
-- The caller FAILS OPEN if this table is missing or unreadable, so applying it turns the cap
-- on and nothing breaks before it lands.
--
-- Service-role only — no browser ever reads or writes this.
--
-- Hand-apply via `supabase db query --linked` / the SQL editor and record as version 204 —
-- NEVER `supabase db push`.

create table if not exists public.rate_buckets (
  bucket             text primary key,        -- '<function>:<client_id>'
  window_started_at  timestamptz not null default now(),
  hits               int         not null default 0,
  updated_at         timestamptz not null default now()
);

alter table public.rate_buckets enable row level security;

-- No policies → service_role only. The PUBLIC grant is the one that bites: this project's
-- default privileges make every NEW table world-readable, and that grant survives a revoke
-- aimed only at anon/authenticated. Revoke it explicitly.
revoke all on public.rate_buckets from public;
revoke all on public.rate_buckets from anon, authenticated;

-- Serves the housekeeping sweep (delete rows whose window is long past), not the hot path —
-- the hot path is a primary-key lookup.
create index if not exists rate_buckets_updated_idx on public.rate_buckets (updated_at);

-- Rollback: drop table public.rate_buckets;
