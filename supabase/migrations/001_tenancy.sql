-- 001_tenancy: map auth users to clients, give owners read access to their tenant's designs.
-- Additive only: coexists with the legacy designs_anon_all policy until cutover (005).
-- APPLIED to project jzeamjbhdrsbygdnphbm on 2026-06-11 (migration: tenancy_client_users_and_owner_policies).

create table public.client_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  client_id  text not null,
  role       text not null default 'owner',
  created_at timestamptz not null default now()
);

alter table public.client_users enable row level security;

-- Owners can see their own mapping row (the portal uses this to resolve its tenant).
-- No insert/update/delete policies: writes are service-role only (operator onboarding).
create policy client_users_select_own on public.client_users
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Tenant resolver for RLS policies. SECURITY DEFINER so it can read client_users
-- regardless of the caller's policies; stable so the planner caches it per-statement.
create or replace function public.current_client_id()
returns text
language sql stable security definer
set search_path = ''
as $$
  select client_id from public.client_users where user_id = (select auth.uid())
$$;

revoke execute on function public.current_client_id() from public, anon;
grant execute on function public.current_client_id() to authenticated;

-- Owners read only their tenant's designs. The legacy designs_anon_all policy
-- (anon role) is untouched here and gets dropped at cutover.
create policy designs_owner_select on public.designs
  for select to authenticated
  using (client_id = public.current_client_id());

create index if not exists designs_client_id_created_at_idx
  on public.designs (client_id, created_at desc);
