-- 077_commission_members.sql
-- Commission tracking — slice 2 foundation: confidential per-user comp + grants.
-- Keyed to client_users by (client_id, user_id). Deliberately service-role ONLY:
-- rates and payout-visibility grants are owner-confidential, so all reads/writes go
-- through a service-role edge function (portal-commissions, built next) that enforces
-- owner / full_access gating. A rep must NEVER be able to read their own %, which is
-- why this is NOT columns on the RLS-readable client_users table. The two grants are
-- INDEPENDENT (Carolyn, 2026-08-02). Applied live via MCP 2026-08-02; do NOT `db push`.

create table if not exists public.commission_members (
  client_id          text not null,
  user_id            uuid not null,
  commission_percent numeric(6,3)
                       check (commission_percent is null or (commission_percent >= 0 and commission_percent <= 100)),
  sees_all_payouts   boolean not null default false,
  full_access        boolean not null default false,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  primary key (client_id, user_id)
);

alter table public.commission_members enable row level security;
-- No RLS policies on purpose (service-role only). Also revoke the default table grants
-- so browser roles have no privilege at all — belt and suspenders for confidential comp.
revoke all on public.commission_members from anon, authenticated;
