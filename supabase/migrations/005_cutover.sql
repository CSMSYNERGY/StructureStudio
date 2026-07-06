-- 005_cutover: lock down the legacy open policies.
--
-- ████ DO NOT RUN UNTIL THE NEW FRONTEND IS DEPLOYED ████
--
-- The live site (Cloudflare Pages, deployed from GitHub main) must be serving
-- the multi-tenant build first — verify by opening the site and checking the
-- browser console for:
--     [StructureStudio] multi-tenant build: config-loader + RPC data path
-- and that loading a ?id= design hits /rest/v1/rpc/load_design (devtools →
-- Network), NOT /rest/v1/designs. Running this script while the OLD frontend
-- is live breaks design loading and saving for every visitor.
--
-- The new frontend also writes floor-plan PDFs to client-prefixed paths
-- ({client_id}/SS-….pdf), so the storage write policies below require that
-- shape. Confirm the deployed build uploads to {client_id}/<code>.pdf before
-- running this (see CUTOVER_HANDOFF.md storage re-path runbook).
--
-- NOT YET APPLIED as of 2026-06-11.

-- 1. Designs: anon loses blanket access. After this, anon reaches designs only
--    through the load_design / save_design SECURITY DEFINER RPCs (002), and
--    owners read their tenant's rows via designs_owner_select (001).
drop policy designs_anon_all on public.designs;

-- 2. Storage: replace "public can do anything in floor-plans" with
--    writes only to client-prefixed, code-shaped PDF names + no deletes. The
--    path shape is {client_id}/SS-<code>.pdf — client_id is a DNS-safe slug
--    (lowercase alphanumerics + hyphens), so the leading segment is matched as
--    [a-z0-9][a-z0-9-]*. NO select policy on purpose: the bucket is public, so
--    /object/public/ URLs (what the app and GHL emails use) work without one —
--    and without it the bucket can't be LISTED via the API (advisor 0025).
--    Pre-cutover files at the bucket root (SS-<code>.pdf, no prefix) remain
--    publicly READABLE — this policy only governs new writes — so old share
--    links keep working even before they're copied under a client prefix.
drop policy floor_plans_public_all on storage.objects;

create policy floor_plans_code_insert on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'floor-plans' and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}\.pdf$');

create policy floor_plans_code_update on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'floor-plans' and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}\.pdf$')
  with check (bucket_id = 'floor-plans' and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}\.pdf$');

-- After running: smoke-test per CLAUDE.md "Cutover checklist".
