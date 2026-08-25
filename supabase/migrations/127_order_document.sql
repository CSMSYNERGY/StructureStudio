-- 127_order_document: what the invoice-style order screen needs (Carolyn 2026-08-24).
--
-- 1. change_orders.snapshot_before — the design AS THE CUSTOMER SIGNED IT, stamped by the
--    order screen's attribute-staging action the first time it creates/adopts the pending
--    CO ({estimateLines, selections, paintColors}). Discarding a staged-but-unsigned
--    change restores from here; re-stages diff against it so the customer always signs
--    the CUMULATIVE change since their signature, not a chain of increments. NULL on COs
--    raised by the designer-resubmit path (those keep today's void-only behavior).
--
-- 2. designs.plan_image_url / view3d_image_url — the sidebar cards. The designer already
--    RENDERS both images on submit (the plan JPEG that gets wrapped into the plan PDF,
--    and the 3D snapshot when the rep opened 3D View); now it also uploads them as
--    images, because an <img> beats an embedded PDF viewer in a small card. Persisted by
--    submit-estimate's SS branch only — CRM tenants' rows never populate these.
--
-- 3. The floor-plans anon INSERT policy widens to admit those two image names. The shape
--    IS the security (cutover invariant): tenant prefix + the unguessable SS code, now
--    with either the existing pdf suffix or -plan-<ts>.jpg / -3d-<ts>.jpg. Timestamped
--    names keep the anon-no-update invariant — anon can only ever ADD a new object.
--
-- Hand-apply via the SQL editor / MCP and record as version 127 — NEVER `supabase db push`.

alter table public.change_orders
  add column if not exists snapshot_before jsonb;

alter table public.designs
  add column if not exists plan_image_url   text,
  add column if not exists view3d_image_url text;

drop policy if exists floor_plans_code_insert on storage.objects;
create policy floor_plans_code_insert on storage.objects
  for insert
  with check (
    bucket_id = 'floor-plans'
    and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}((-[0-9]+)?[.]pdf|-(plan|3d)-[0-9]+[.]jpg)$'
  );

-- Rollback:
--   drop policy if exists floor_plans_code_insert on storage.objects;
--   create policy floor_plans_code_insert on storage.objects for insert
--     with check (bucket_id = 'floor-plans'
--       and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}(-[0-9]+)?[.]pdf$');
--   alter table public.designs drop column if exists plan_image_url, drop column if exists view3d_image_url;
--   alter table public.change_orders drop column if exists snapshot_before;
