-- 388: THE SERVER'S ROLLOUT SWITCH for plans as data (386, 387).
--
-- 387 lets one company's PORTAL obey the tab map (what is offered). This is the same switch for the
-- SERVER (what is allowed): the edge functions refuse an action whose tab the company has not got,
-- and they open a paid action by the map instead of by the billing feature.
--
-- WHY A SECOND LIST AND NOT THE SAME ONE. The portal half hides and lands; getting it wrong shows a
-- page too few or too many. The server half REFUSES. A page that is still offered can call an action
-- that belongs to another tab (the Orders page asks the scheduler whether a building is scheduled),
-- and until every such call is found, a refusal there is an error on a page the company does have.
-- So a company is moved in three steps, each one looked at before the next:
--
--   1. its PORTAL obeys the map                                   enforce.clients        (387)
--   2. the server REPORTS what it would refuse, and refuses nothing  enforce.server_report  (this)
--   3. the server REFUSES                                         enforce.server_clients (this)
--
-- All of it lives in the one access_config.enforce row:
--   { "all": false, "clients": [...],
--     "server_all": false, "server_clients": [...], "server_report": [...] }
--
--   access_for_server(client)  null = the old rules (not named, or anything malformed), else
--                              { "mode": "block" | "report", "modules": { tab: state } }.
--                              block wins when a company is in both lists.
--
-- FAILS TO "NOT ENFORCED", exactly as 387 does: a missing row, a malformed value, a null id and an
-- unknown shape all answer null, and the caller treats a failed call the same way. The switch can
-- only ever move a company onto the map by naming it.
--
-- Nothing reads it until the functions that ask are deployed (stage C). Service-role only.
--
-- Rollback: drop function if exists public.access_for_server(text);

create or replace function public.access_for_server(p_client_id text)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select case
           when e.block  then jsonb_build_object('mode', 'block',  'modules', public.access_resolve(p_client_id))
           when e.report then jsonb_build_object('mode', 'report', 'modules', public.access_resolve(p_client_id))
           else null
         end
    from (
      select (p_client_id is not null and (
               coalesce(c.value -> 'server_all' = 'true'::jsonb, false)
               or coalesce(jsonb_typeof(c.value -> 'server_clients') = 'array' and (c.value -> 'server_clients') ? p_client_id, false)
             )) as block,
             (p_client_id is not null
               and coalesce(jsonb_typeof(c.value -> 'server_report') = 'array' and (c.value -> 'server_report') ? p_client_id, false)
             ) as report
        from (select 1) one
        left join public.access_config c on c.key = 'enforce'
    ) e
$function$;

comment on function public.access_for_server(text) is
  'For the edge functions: null = the old rules; else { mode: block | report, modules } for a company '
  'named in access_config.enforce.server_clients (block; or server_all) or server_report. Migration 388.';

revoke execute on function public.access_for_server(text) from public, anon, authenticated;
grant  execute on function public.access_for_server(text) to service_role;

-- Rehearsal: the shape this migration promises, or it does not apply.
do $$
begin
  if has_function_privilege('anon', 'public.access_for_server(text)', 'execute')
     or has_function_privilege('authenticated', 'public.access_for_server(text)', 'execute') then
    raise exception '388: a browser role can execute access_for_server';
  end if;
  if public.access_for_server(null) is not null then
    raise exception '388: a null company reads as enforced';
  end if;
  -- Naming a company for the PORTAL must not switch the server on for it.
  if exists (
    select 1
      from public.access_config c,
           jsonb_array_elements_text(case when jsonb_typeof(c.value -> 'clients') = 'array' then c.value -> 'clients' else '[]'::jsonb end) k
     where c.key = 'enforce'
       and not coalesce(c.value -> 'server_all' = 'true'::jsonb, false)
       and not coalesce(jsonb_typeof(c.value -> 'server_clients') = 'array' and (c.value -> 'server_clients') ? k, false)
       and not coalesce(jsonb_typeof(c.value -> 'server_report') = 'array' and (c.value -> 'server_report') ? k, false)
       and public.access_for_server(k) is not null
  ) then
    raise exception '388: a company named only for the portal reads as enforced on the server';
  end if;
end $$;
