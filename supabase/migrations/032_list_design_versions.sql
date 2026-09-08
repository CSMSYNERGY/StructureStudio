-- 032_list_design_versions: capability read of all versions for a design, keyed by the
-- unguessable short code (same anon-capability model as load_design / load_design_version).
-- Powers the "all designs on this estimate" list on the designer's submit screen, and later
-- the customer login. Newest version first.
--
-- NB: applied to live via MCP on 2026-06-30; this NNN_ file is the repo record.
--
-- !! SUPERSEDED PROJECTION -- the body below is the ORIGINAL, not what runs on live.
-- Migration 193 re-issues this function (and load_design_version, 031) with the legacy-code
-- redaction that 156 introduced for load_design: when the share code is shorter than 8
-- characters the row comes back with `contact` and `image_url` NULL, because a code that
-- short is enumerable and those two fields carry the customer's identity. Signature, return
-- type, volatility, SECURITY DEFINER, empty search_path and grants are unchanged by 193, so
-- everything else on this page still stands. Read 193 before assuming an anon caller gets
-- the whole row, and before writing anything that re-issues this function.

create or replace function public.list_design_versions(p_code text)
 returns setof public.design_versions
 language sql
 security definer
 set search_path to ''
as $function$
  select * from public.design_versions where short_code = p_code order by version desc;
$function$;
grant execute on function public.list_design_versions(text) to anon, authenticated;
