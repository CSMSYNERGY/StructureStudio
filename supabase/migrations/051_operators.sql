-- 051_operators: platform operators (Carolyn / Ahsan / Jonathan-support) as a real
-- logged-in identity, replacing "operator = whoever knows ADMIN_PASSWORD" for the
-- portal's account-switcher (GHL-subaccounts-style view into any tenant's portal).
--
-- Design (mirrors the existing posture):
--   app_operators — one row per operator auth user. RLS on, ZERO policies →
--     service-role only, same posture as admin_audit (046). client_users is NOT
--     reused: its PK pins one tenant per login and operators are cross-tenant.
--   is_operator() — SECURITY DEFINER membership check for the CALLER only, granted
--     to authenticated (mirrors current_client_id()'s grants, 001). The browser uses
--     it purely to decide whether to SHOW the Accounts tab; every actual cross-tenant
--     read is re-authorized server-side by the operator-portal edge function.
--
-- Hand-apply via the SQL editor / MCP and record as version 051 — NEVER `supabase db push`.
-- Seeding: run the insert below per operator AFTER confirming each auth user's email.

create table if not exists public.app_operators (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  email    text not null,
  added_at timestamptz not null default now()
);

alter table public.app_operators enable row level security;
-- No policies on purpose: browsers (anon or authenticated) can never read the
-- operator roster; only service-role edge functions touch it.
revoke all on public.app_operators from anon, authenticated;

create or replace function public.is_operator()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (select 1 from public.app_operators where user_id = auth.uid());
$$;

revoke execute on function public.is_operator() from public, anon;
grant execute on function public.is_operator() to authenticated;

-- ── Seed (run per operator; safe to re-run) ──
-- insert into public.app_operators (user_id, email)
-- select id, email from auth.users where email = '<operator email>'
-- on conflict (user_id) do nothing;

-- Rollback: drop function public.is_operator(); drop table public.app_operators;
