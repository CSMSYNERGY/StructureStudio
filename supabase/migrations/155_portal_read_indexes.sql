-- 155_portal_read_indexes.sql — indexes for the portal's tenant-scoped status filters.
--
-- APPLY BY HAND (SQL editor / MCP execute_sql / `supabase db query --linked`), then record
-- the row in supabase_migrations.schema_migrations. NEVER `supabase db push` — see 148's
-- header and CLAUDE.md for why.
--
-- Why these four, and why they are NOT the headline fix. The portal's slow tabs
-- (Build Schedule, Delivery Schedule, Repairs, Commissions, Inventory) were measured as
-- round-trip bound, not scan bound: their edge functions issue up to 13 SEQUENTIAL
-- PostgREST calls per request, and at present every one of these tables is small enough
-- (hundreds of rows) that Postgres seq-scans them faster than it could walk an index. The
-- parallelisation of those waves is the fix; these indexes are the cheap insurance that the
-- same queries stay flat as tenants accumulate years of designs and repairs, so nobody has
-- to rediscover them under load. Each one covers a filter the code issues today:
--
--   designs (client_id, status)          portal-schedule build_board — invoiced tray
--   repairs (client_id, status)          portal-schedule build_board tray + delivery pool
--   inventory_units (client_id, sale_state)  portal-schedule pool + schedule_links
--   client_users (client_id)             getTeam and every commissions roster read; the
--                                        table's only index is its user_id PK, so a lookup
--                                        by client_id scans every tenant's rows
--
-- Plain CREATE INDEX, not CONCURRENTLY: the sanctioned apply paths wrap statements in a
-- transaction (where CONCURRENTLY is illegal), and at these row counts the SHARE lock is
-- held for milliseconds.
--
-- ROLLBACK:
--   drop index if exists public.designs_client_status_idx;
--   drop index if exists public.repairs_client_status_idx;
--   drop index if exists public.inventory_units_client_sale_idx;
--   drop index if exists public.client_users_client_idx;
--
-- ⛔ Do NOT drop commission_entries_one_auto_per_order (migration 148) while cleaning up
-- here — it is the invariant that lets the Commissions ledger paint before compute runs.

create index if not exists designs_client_status_idx
  on public.designs (client_id, status);

create index if not exists repairs_client_status_idx
  on public.repairs (client_id, status);

create index if not exists inventory_units_client_sale_idx
  on public.inventory_units (client_id, sale_state);

create index if not exists client_users_client_idx
  on public.client_users (client_id);
