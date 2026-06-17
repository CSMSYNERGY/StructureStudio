-- 023_size_inclusions_rls: lock down building_size_inclusions exactly like
-- building_sizes (012). Anon can never read it directly; authenticated owners
-- read only their own tenant's rows; writes are service-role only (no write
-- policy). get_config is SECURITY DEFINER (owned by postgres, which bypasses
-- RLS) so it reads inclusions for the public designer regardless.
--
-- Hand-applied via MCP execute_sql (not recorded in supabase_migrations).

alter table public.building_size_inclusions enable row level security;

revoke all on public.building_size_inclusions from anon, authenticated;

drop policy if exists building_size_inclusions_owner_select on public.building_size_inclusions;
create policy building_size_inclusions_owner_select on public.building_size_inclusions
  for select to authenticated
  using (client_id = public.current_client_id());

grant select on public.building_size_inclusions to authenticated;
