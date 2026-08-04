-- 046_admin_audit: operator (ADMIN_PASSWORD) action audit log.
-- Records every operator impersonation/portal-view (and future sensitive ops).
-- Service-role ONLY: RLS enabled with NO anon/authenticated policies, so the
-- admin-catalog edge function (service role, bypasses RLS) is the sole writer/reader.
-- Hand-applied via Supabase MCP apply_migration and recorded as version 046 (never db push).
create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  action text not null,
  target_client_id text,
  row_count integer,
  note text
);
alter table public.admin_audit enable row level security;
comment on table public.admin_audit is 'Operator (ADMIN_PASSWORD) action audit log — service-role only, no client-facing RLS policies.';
-- Rollback: drop table public.admin_audit;
