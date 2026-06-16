-- 017_catalog_master_rls: lock the master + assignment tables.
--   * Master tables (layout_item_types, building_style_catalog,
--     building_style_catalog_sizes): RLS on, NO policies, anon+authenticated
--     revoked → reachable only by the service role (admin-catalog edge fn) and
--     SECURITY DEFINER get_config (runs as owner, bypasses RLS).
--   * client_layout_items: owner-scoped read (matches the catalog convention so
--     the portal could later show a tenant its own palette); writes service-role
--     only (no write policy).
-- NON-DESTRUCTIVE. HAND-APPLY only. BOM-free.

alter table public.layout_item_types            enable row level security;
alter table public.building_style_catalog       enable row level security;
alter table public.building_style_catalog_sizes enable row level security;
alter table public.client_layout_items          enable row level security;

revoke all on public.layout_item_types            from anon, authenticated;
revoke all on public.building_style_catalog       from anon, authenticated;
revoke all on public.building_style_catalog_sizes from anon, authenticated;
revoke all on public.client_layout_items          from anon;

-- (no policies on the three master tables ⇒ authenticated/anon see nothing)

create policy client_layout_items_owner_read on public.client_layout_items
  for select to authenticated
  using (client_id = public.current_client_id());
