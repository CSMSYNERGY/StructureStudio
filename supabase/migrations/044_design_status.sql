-- 044_design_status: portal fulfillment status (sent/accepted/invoiced/delivered), GHL-derived.
-- Hand-apply via the SQL editor / Supabase MCP apply_migration — NEVER `supabase db push`. Record as version 044.
--
-- `public.designs.status` already exists in live (added out-of-band, default 'submitted', nullable, no CHECK;
-- all rows 'submitted'). This is its first repo record. Idempotent + defensive so it is safe on any DB
-- (incl. a beta/fresh DB that lacks the column). Backfill BEFORE adding the CHECK / NOT NULL.
--
-- Rollback:
--   alter table public.designs drop constraint if exists designs_status_check;
--   alter table public.designs alter column status drop not null;
--   alter table public.designs alter column status set default 'submitted';
--   alter table public.client_settings drop column if exists ghl_stage_delivered_id;
--   (the 'submitted'->'sent' backfill is one-way; acceptable — all rows were identical pre-migration)

alter table public.designs add column if not exists status text;

update public.designs set status = 'sent' where status = 'submitted' or status is null;

alter table public.designs alter column status set default 'sent';

alter table public.designs drop constraint if exists designs_status_check;
alter table public.designs add constraint designs_status_check
  check (status in ('sent', 'accepted', 'invoiced', 'delivered'));

alter table public.designs alter column status set not null;

-- Per-tenant "Delivered" pipeline-stage id (mirrors client_settings.ghl_stage_send_quote_id).
-- The design's status becomes 'delivered' when its GHL opportunity reaches this pipeline stage.
alter table public.client_settings add column if not exists ghl_stage_delivered_id text;
