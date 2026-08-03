-- 082_internal_only_columns: add a per-item "internal designer only" flag.
--
-- A THIRD visibility state beyond active/archived. When internal_only is true, the item is still
-- placeable in the INTERNAL/embedded designer (the portal Designer tab reps use) but is NOT offered
-- in the palette of the CLIENT-FACING public designer — yet a placed instance still RENDERS on a
-- loaded design for the customer. This mirrors the existing archived → noPalette "render-but-not-
-- placeable" pattern (migration 081), except it is conditioned CLIENT-SIDE on the designer's
-- `embedded` flag rather than applied to everyone. get_config / get_fixtures keep emitting the item
-- (so it renders + the embedded palette can show it) and just tag it internalOnly; the designer
-- hides it from the palette only when NOT embedded. See migration 083 for the RPC changes.
--
-- Default false = current behavior (available to everyone). HAND-APPLY via MCP; record in ledger.

alter table public.client_layout_items add column if not exists internal_only boolean not null default false;
alter table public.fixture_items       add column if not exists internal_only boolean not null default false;
