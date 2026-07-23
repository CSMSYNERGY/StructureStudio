-- 049_stage_accepted_invoiced: extend the quote-stage mapping to the full 4-stage ladder
-- (Sent -> Accepted -> Invoiced -> Delivered). client_settings already has
-- ghl_stage_send_quote_id + ghl_stage_delivered_id (044); add the two middle ones.
-- Each is a GHL pipeline STAGE id (globally unique), matched pipeline-agnostically by
-- sync-design-status against the linked opportunity's current pipelineStageId. The
-- send-quote PIPELINE stays stored (ghl_pipeline_id) since submit-estimate places the opp there;
-- the accepted/invoiced/delivered pipelines are UI-derived from their stage ids in portal.html.
-- Hand-applied via Supabase MCP apply_migration and recorded as version 049 (never db push).
alter table public.client_settings add column if not exists ghl_stage_accepted_id text;
alter table public.client_settings add column if not exists ghl_stage_invoiced_id text;
-- Rollback: alter table public.client_settings drop column ghl_stage_accepted_id, drop column ghl_stage_invoiced_id;
