-- 032_list_design_versions: capability read of all versions for a design, keyed by the
-- unguessable short code (same anon-capability model as load_design / load_design_version).
-- Powers the "all designs on this estimate" list on the designer's submit screen, and later
-- the customer login. Newest version first.
--
-- NB: applied to live via MCP on 2026-06-30; this NNN_ file is the repo record.

create or replace function public.list_design_versions(p_code text)
 returns setof public.design_versions
 language sql
 security definer
 set search_path to ''
as $function$
  select * from public.design_versions where short_code = p_code order by version desc;
$function$;
grant execute on function public.list_design_versions(text) to anon, authenticated;
