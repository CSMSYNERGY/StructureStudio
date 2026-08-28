-- 127_order_document: what the invoice-style order screen needs (Carolyn 2026-08-24).
--
-- 1. change_orders.snapshot_before — the order screen's UNDO POINT: the design as it stood
--    immediately BEFORE this screen staged its change ({estimateLines, selections,
--    paintColors}), stamped the first time that action creates or adopts the pending CO.
--    Discarding a staged-but-unsigned change restores from here. NULL on COs raised by the
--    designer-resubmit path (those keep today's void-only behavior).
--    ⚠️ CORRECTION (2026-08-28, migration 153). This line used to read "the design AS THE
--    CUSTOMER SIGNED IT", and it also served as the money/diff baseline for re-stages. It is
--    NOT the signed design: when this screen ADOPTS a designer-raised CO, the pre-stage
--    design already carries that designer's unacknowledged revision — so using it as the
--    baseline stamped a total the customer never agreed to onto the CO they then signed
--    (audit finding 16). The baseline now lives in designs.accepted_snapshot (153) and is
--    read through agreedBaseline(); snapshot_before keeps ONLY its restore job, is still
--    written in exactly the one place it always was, and void_change_order is unchanged.
--    The SQL below is byte-identical to what was applied — this correction is comment-only.
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

-- The bucket's mime allowlist gated harder than the policy (uploads died 415 before the
-- name shape was ever checked) — the JPEG twins need image/jpeg admitted too.
update storage.buckets
   set allowed_mime_types = array['application/pdf','image/jpeg']
 where id = 'floor-plans';

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
