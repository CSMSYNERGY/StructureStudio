-- 025_revoke_client_settings_grant: close a defense-in-depth gap found in the
-- security audit. client_settings (GHL API key, location id, pipeline ids,
-- beta_email) is service-role-only and RLS is enabled with NO policy, so it is
-- fail-closed today — but the anon/authenticated roles still held a vestigial
-- table-level SELECT grant, so anon GET returned 200 [] instead of the 401 that
-- every sibling private table returns. Revoke it so the grant layer 401s too;
-- the only legitimate readers are the SECURITY DEFINER RPCs and the service-role
-- edge functions, neither of which use these roles' grants.
--
-- Hand-applied via MCP execute_sql (not recorded in supabase_migrations).

revoke all on public.client_settings from anon, authenticated;
