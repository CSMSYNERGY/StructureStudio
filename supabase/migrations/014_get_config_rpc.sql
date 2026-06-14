-- 014_get_config_rpc: per-tenant config read door for the public/anon designer.
-- The config-loader currently reads client_configs directly with the anon key
-- (bulk-readable cross-tenant). This RPC is the capability replacement: it
-- returns ONE tenant's config blob by key. It is SECURITY DEFINER so it keeps
-- working AFTER 015 revokes anon's direct SELECT on client_configs.
--
-- Mirrors load_design (permissive read by key — the client_id is a public
-- subdomain, so there is nothing secret to gate here; the win is that anon can
-- no longer enumerate every tenant's config in one query). Returns the config
-- jsonb, or NULL if the client is unknown (the front-end shows its error screen).
--
-- ADDITIVE + SAFE NOW: creating it changes nothing until the front-end calls it
-- and 015 locks the table. NOT YET APPLIED.

create or replace function public.get_config(p_client_id text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select config from public.client_configs where client_id = p_client_id
$$;

revoke execute on function public.get_config(text) from public;
grant  execute on function public.get_config(text) to anon, authenticated;
