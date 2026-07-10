-- 017_style_photos: let authenticated tenant owners upload building-style
-- reference photos (the four-side calibration sets, plan §"four-sided photos")
-- to the floor-plans bucket under their own tenant prefix:
--   {client_id}/style-photos/<name>.(jpg|jpeg|png|webp)
--
-- Until this is applied, the ?admin=1 calibration editor takes photo URLs
-- (e.g. GHL media library or Drive links) — uploads are a convenience, not a
-- dependency. Reads need no policy: the bucket is public, so /object/public/
-- URLs work (and the bucket still can't be LISTED — see 005 notes).
--
-- NOT YET APPLIED as of 2026-07-02. Hand-apply via the SQL Editor — NEVER
-- `supabase db push` (see CLAUDE.md: unreconciled migration history would
-- re-run 008-011 and wipe the catalog).

create policy style_photos_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'floor-plans'
    and name ~ '^[a-z0-9][a-z0-9-]*/style-photos/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$'
    and split_part(name, '/', 1) = public.current_client_id()
  );

create policy style_photos_owner_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'floor-plans'
    and name ~ '^[a-z0-9][a-z0-9-]*/style-photos/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$'
    and split_part(name, '/', 1) = public.current_client_id()
  )
  with check (
    bucket_id = 'floor-plans'
    and name ~ '^[a-z0-9][a-z0-9-]*/style-photos/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$'
    and split_part(name, '/', 1) = public.current_client_id()
  );
