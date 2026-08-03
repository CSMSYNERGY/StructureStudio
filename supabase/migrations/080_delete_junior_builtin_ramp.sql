-- 080_delete_junior_builtin_ramp: complete the ramp MERGE for the only live ramp tenant.
--
-- The simple ramp is now fully self-contained (079 + SIMPLE_RAMP_CFG in the designer): the
-- designer draws + places it from its own config and client_settings.ramp_enabled, and
-- get_fixtures reads price/method/image from client_settings — nothing reads the built-in
-- `ramp` layout item anymore. Junior Barns is the only live client using ramps and every one
-- of his saved designs stores its ramp items inline, so removing the now-orphaned built-in row
-- leaves all of those designs rendering + pricing exactly as before.
--
-- Client-scoped and idempotent: a no-op on any environment without a junior-barns ramp row.
-- HAND-APPLY via MCP; record in ledger.

delete from public.layout_item_pricing
 where client_id = 'junior-barns' and item_key = 'ramp';

delete from public.client_layout_items
 where client_id = 'junior-barns' and item_key = 'ramp';
