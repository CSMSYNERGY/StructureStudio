-- 026_storage_select_policy_fix: fix the PDF-upload "new row violates row-level
-- security policy" that blocked EVERY designer submit since the 005 cutover.
--
-- Root cause: 005 replaced the old `floor_plans_public_all` (FOR ALL) policy
-- with INSERT + UPDATE policies only — it dropped SELECT. But Supabase Storage
-- uploads run as `INSERT ... ON CONFLICT (name,bucket_id) DO UPDATE ... RETURNING *`
-- (an upsert), which under RLS also needs a SELECT policy to read/return the row.
-- With no SELECT policy, the upsert was rejected with a WITH-CHECK-style RLS error
-- for every client/SS-<code>.pdf path (proven: a plain INSERT as anon passed, but
-- the upsert as anon was blocked 42501). Hence zero prefixed objects ever uploaded.
--
-- Fix: keep INSERT + UPDATE and ADD a matching SELECT policy, all TO public,
-- restricted to the {client_id}/SS-<code>.pdf shape. NO DELETE policy (anon still
-- cannot delete; storage.protect_delete also blocks direct deletes). TO public
-- (vs the 005 `to anon, authenticated`) matches the original working policy and
-- whatever role storage-api uses for anonymous uploads.
--
-- Tradeoff (accepted): a SELECT policy re-enables listing/enumeration of the
-- code-shaped floor-plan PDFs (low sensitivity — floor-plan drawings, already
-- shared via GHL estimate emails). For zero enumeration, switch to a private
-- bucket + signed URLs later.
--
-- Hand-applied via MCP execute_sql (not recorded in supabase_migrations).

drop policy if exists floor_plans_code_insert on storage.objects;
drop policy if exists floor_plans_code_update on storage.objects;
drop policy if exists floor_plans_code_select on storage.objects;

create policy floor_plans_code_insert on storage.objects
  for insert to public
  with check (bucket_id = 'floor-plans' and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}\.pdf$');

create policy floor_plans_code_update on storage.objects
  for update to public
  using (bucket_id = 'floor-plans' and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}\.pdf$')
  with check (bucket_id = 'floor-plans' and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}\.pdf$');

create policy floor_plans_code_select on storage.objects
  for select to public
  using (bucket_id = 'floor-plans' and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}\.pdf$');
