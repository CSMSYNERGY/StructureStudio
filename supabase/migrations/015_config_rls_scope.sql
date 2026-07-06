-- 015_config_rls_scope: lock client_configs to per-tenant reads.
--
-- ⚠ CUTOVER-GATED — DO NOT APPLY TO LIVE until the new front-end (which reads
-- config via get_config(), migration 014) is deployed to PRODUCTION. Running
-- this while the old direct-table front-end is live breaks config load for
-- every visitor (same precondition discipline as 005_cutover.sql).
--
-- Replaces the pre-repo public-read policy with an owner-scoped read for
-- authenticated owners (the portal reads its own config this way). Anon loses
-- direct SELECT and must use get_config(). Writes stay service-role only.
-- save_design/get_config/get_catalog are SECURITY DEFINER and keep reading
-- client_configs regardless of this revoke.
--
-- The live policy is named "public read" (with a space) and granted TO public,
-- NOT to anon — verified read-only against jzeamjbhdrsbygdnphbm. The `public`
-- role implicitly includes anon, so the discovery below drops any read-granting
-- policy whose roles overlap {anon, public}, by whatever name it carries.
--
-- NON-DESTRUCTIVE: policy/grant changes only — no table or row is touched.

do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'client_configs'
      and cmd in ('SELECT', 'ALL')
      and roles::text[] && array['anon','public']
  loop
    execute format('drop policy %I on public.client_configs', p.policyname);
  end loop;
end $$;

drop policy if exists client_configs_owner_read on public.client_configs;
revoke select on public.client_configs from anon;

create policy client_configs_owner_read on public.client_configs
  for select to authenticated
  using (client_id = public.current_client_id());
