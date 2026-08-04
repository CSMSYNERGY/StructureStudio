-- 091_designs_delivered_at: local ownership of the "delivered" state.
--
-- Today designs.status='delivered' is reachable ONLY via ghl_stage_delivered_id, which no
-- tenant has mapped — Delivered is 0 everywhere. The Delivery Schedule OWNS delivered:
-- when a stop for an order is marked delivered, portal-schedule sets
-- designs.status='delivered' + delivered_at.
--
-- ⚠️ THE FENCE (ships with the Delivery tab, Phase 4 — recorded here so nobody forgets):
-- sync-design-status recomputes designs.status from GHL, and GHL never reports delivered,
-- so without a skip it would DOWNGRADE delivered → invoiced on the next sync. The fence is
-- a one-line skip in sync-design-status for rows with delivered_at IS NOT NULL — same
-- spirit as its existing draft/inventory skips. This column lands now (Phase 1) so the
-- edge function can be built and tested against it; the portal never writes it directly.

alter table public.designs add column delivered_at timestamptz;

-- Rollback:
--   alter table public.designs drop column delivered_at;
