-- 094_style_scan_model: a building style can carry a phone SCAN of the real building.
--
-- The scan is a REFERENCE, never the thing customers see. A phone LiDAR export is one fused
-- shell of triangles with no notion of "wall" or "door", so it cannot be edited, cannot be
-- priced, and cannot answer a quote. We measure it and read its shape, then generate the
-- parametric building the rest of the app already understands. Hence: the mesh lives in a
-- PRIVATE bucket, model_url is deliberately NOT emitted by get_config (that is the anonymous
-- customer call -- see 093), and the measurements live in their own column because
-- _shared/styleD3.ts rebuilds d3 from a fixed key list and would silently drop them.
--
-- HAND-APPLY via MCP apply_migration; record in the ledger. Never `supabase db push`.
-- 094 because beta's 087-092 are already applied to this shared production DB and 093 is the
-- d3Photos privacy fix.
alter table public.building_styles
  add column if not exists model_url        text,        -- object PATH in the private `models` bucket, not a URL
  add column if not exists model_status     text not null default 'none',
  add column if not exists model_uploaded_at timestamptz,
  add column if not exists model_locked_at  timestamptz,
  add column if not exists model_meta       jsonb;       -- { widthFt, depthFt, eaveFt, peakFt, pitch, roofType, scaleSource, source:{...} }

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'building_styles_model_status_chk') then
    alter table public.building_styles
      add constraint building_styles_model_status_chk
      check (model_status in ('none', 'uploaded', 'calibrated', 'locked'));
  end if;
end $$;

-- Private bucket. 60 MB because a Medium/High phone scan of a shed lands at 10-40 MB and
-- Ultra can exceed that; the in-function and client gates refuse earlier with a readable
-- message, and this is the backstop. Browsers frequently label a .glb
-- application/octet-stream rather than model/gltf-binary, so BOTH are allowed or the upload
-- fails at the storage gate for a reason no builder could diagnose.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('models', 'models', false, 62914560, array['model/gltf-binary', 'application/octet-stream'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Tenant-folder-scoped policies, mirroring feedback_attach_* (the existing precedent for a
-- direct browser upload into a private bucket): a signed-in builder may write and read only
-- under their own {client_id}/ prefix. No anon policy at all, and no DELETE policy -- removal
-- goes through the service role so it is always paired with clearing the row.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='models_tenant_insert') then
    create policy models_tenant_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'models' and (storage.foldername(name))[1] = public.current_client_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='models_tenant_read') then
    create policy models_tenant_read on storage.objects for select to authenticated
      using (bucket_id = 'models' and (storage.foldername(name))[1] = public.current_client_id());
  end if;
end $$;
