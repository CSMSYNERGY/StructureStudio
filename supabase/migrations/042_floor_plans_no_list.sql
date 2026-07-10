-- 042_floor_plans_no_list: close the design short_code enumeration + PII leak
-- (audit finding #1, CRITICAL).
--
-- The public floor-plans bucket carried a SELECT policy (026 / 031,
-- floor_plans_code_select TO public) so the designer's UPSERT upload could read
-- back its row. But that same SELECT policy also lets ANY anon caller run
-- storage.from('floor-plans').list('<client_id>') and enumerate every
-- SS-<code>.pdf filename. short_code is the sole capability for load_design(),
-- a SECURITY DEFINER RPC granted to anon that returns the full design row
-- including the contact jsonb (customer name / email / phone / address). So an
-- unauthenticated caller could list codes and bulk-read every customer's PII
-- across every tenant. (Confirmed live: an anon list() returned real codes.)
--
-- Fix: the designer now uploads with upsert:false (filenames are unique —
-- short_code + timestamp — so there is never a conflict). A plain INSERT needs
-- NO SELECT policy, per 026's own root-cause note ("a plain INSERT as anon
-- passed, but the upsert as anon was blocked 42501"). So we DROP the listable
-- SELECT policy: uploads keep working, list()/enumeration is dead, and the
-- bucket stays public so existing estimate-PDF links keep resolving.
--
-- PREREQUISITE: deploy the upsert:false frontend FIRST (index.html + jsx are
-- already on beta / beta-2.0), otherwise any in-flight upsert upload loses its
-- SELECT policy and fails. Then verify a submit still uploads.
-- Hand-apply via the SQL editor / MCP — NEVER `supabase db push`.

drop policy if exists floor_plans_code_select on storage.objects;

-- Rollback (re-enables enumeration — use only if uploads regress after the drop):
-- create policy floor_plans_code_select on storage.objects for select to public
--   using (bucket_id = 'floor-plans' and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}(-[0-9]+)?[.]pdf$');
