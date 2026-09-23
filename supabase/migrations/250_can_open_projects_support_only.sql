-- 250_can_open_projects_support_only.sql — a support operator's row no longer opens door 1 of
-- can_open_projects(), so the browser stops offering them a Projects console the server refuses.
--
-- THE BUG. Door 1 of can_open_projects() (183) is "any app_operators row". 183 was written the
-- day after 176 added support_only and a few hours after portal-projects started refusing it,
-- and its door 1 was simply carried over from "every operator" without that exception. So for a
-- support operator the two halves disagree:
--   * can_open_projects() answers TRUE — they have an app_operators row;
--   * portal-projects answers 403 "Support accounts can't open Projects — that console is for
--     platform operators." (portal-projects/index.ts, the `op.support_only` refusal right after
--     resolveProjectsAccess), for every action, list_boards included.
-- The portal's `canProjects` comes from this rpc and from nothing else, so on a support account's
-- OWN portal the Projects nav item is drawn, the route resolves, ProjectsTab mounts, and its first
-- call comes back 403. That is the "disabled UI fails silently" shape: a console whose every
-- action is refused. It is real, not theoretical — app_errors holds list_boards refusals at a bare
-- /portal/projects (no ?view=, so not inside view-as) on 2026-09-16 and 2026-09-18, and the same
-- two support accounts were refused the Admin console at the same moments (admin_audit
-- 'admin_auth_support_operator_denied').
--
-- The shell's own gate, `canProjects && !supportView`, cannot catch it: supportView is
-- `!!viewing && isSupportOp`, true only INSIDE a view-as session, and false on the support
-- account's own portal on purpose (12-shell.jsx's note on supportView says why). The rpc is the
-- one place that can give the right answer everywhere at once.
--
-- THE FIX. Door 1 reads the caller's row and returns `not support_only` instead of `true`. That is
-- exactly what portal-projects does: resolveProjectsAccess returns door 1 whenever an
-- app_operators row exists, and the handler then refuses a support_only row outright, whatever
-- client_users or Team access the same login holds. So a support operator is answered here at
-- door 1 and never falls through to door 2 — falling through could grant them the console on a
-- Team switch the server would still refuse.
--
-- ONE CHANGE CLOSES EVERY PROJECTS GATE, including the ones that are easy to miss: the workspace
-- rail item, the Settings-rail item, the ProjectsTab mount, the ?popout=1 window, and ssClampTab's
-- projects branch all read `canProjects`. It is also the fix for production today, with no
-- frontend deploy: production runs the same shell, and a false here hides Projects there too.
-- The Admin console has no rpc of its own (it rides is_operator), so that half is fixed in
-- portal/12-shell.jsx in the same commit.
--
-- NOT CHANGED: platform operators (support_only = false) get exactly today's answer; door 2 is
-- byte-identical; nothing else calls this function (checked 2026-09-23: no RLS policy and no other
-- function references it — it only answers the browser's question). is_operator() is untouched on
-- purpose: it is what shows a support account the Accounts switcher, which they need.
--
-- Written from the LIVE definition read on 2026-09-23: exactly 1 overload, can_open_projects(),
-- owner postgres, SECURITY DEFINER, STABLE, search_path '', EXECUTE for authenticated and
-- service_role only. Its body matched 183 byte-for-byte after LF normalisation (md5
-- 3b576b813149c48163fe23d3dcea5575). CREATE OR REPLACE with the identical (empty) signature keeps
-- the owner and the grants; they are restated below anyway so the file alone says who may call it.
-- Live data at that read: 4 app_operators rows, 2 of them support_only. A read-only probe that
-- signed in as each of them (the same set_config route as the DO block below) got TRUE from the
-- old door for all four, the two support accounts included, and FALSE with no caller.
--
-- Apply by hand (never `supabase db push`), in ONE transaction together with the ledger row
-- (insert into supabase_migrations.schema_migrations (version, name) values ('250',
-- '250_can_open_projects_support_only') returning version, name). This file starts with a comment,
-- so pass the statements rather than the file inline. If 250 is taken by then, renumber.
-- The DO block at the end checks every app_operators row against the new door and raises if one
-- disagrees, which rolls the whole transaction back. Read it back afterwards:
--   select position('250:' in pg_get_functiondef('public.can_open_projects()'::regprocedure)) > 0;
--
-- Rollback: re-run 183's `create or replace function public.can_open_projects()` block (PART 2,
-- with its comment and grants) verbatim. Only that block — 183's PART 1 re-issues area_level_for.

create or replace function public.can_open_projects()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid    uuid;
  v_client text;
  v_role   text;
  v_title  text;
  v_access jsonb;
  v_internal boolean;
  v_support_only boolean;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    return false;
  end if;

  -- Door 1. Kept first and deliberately cheap: it is the path every existing operator takes,
  -- and it must not depend on anything the second door needs.
  --
  -- 250: a support_only row CLOSES this door rather than opening it, and the answer is final —
  -- no fall-through to door 2. portal-projects refuses any support_only operator outright,
  -- whatever Team access the same login holds, and this rpc is what the portal draws the console
  -- from, so the two have to agree. user_id is app_operators' primary key, so `found` is one row.
  select o.support_only into v_support_only
    from public.app_operators o
   where o.user_id = v_uid;
  if found then
    return v_support_only is not true;
  end if;

  -- Door 2. limit 1, never strict — a duplicate client_users row must not raise inside
  -- something a page calls on load. Same idiom, same reason, as current_area_level and
  -- resolveTenant.
  select cu.client_id, cu.role, cu.title, cu.access
    into v_client, v_role, v_title, v_access
    from public.client_users cu
   where cu.user_id = v_uid
   limit 1;

  -- ⚠️ FAILS CLOSED ON ABSENCE, and that is the OPPOSITE of current_area_level — which is
  -- correct, because the two answer opposite questions. current_area_level narrows rows a
  -- tenant policy has already filtered, so an absent row there means "this layer has nothing
  -- to say". This function GRANTS a console; an absent row here means "not a member of
  -- anything", and the only honest answer to "may this stranger open our internal boards" is
  -- no. Door 1 has already let every legitimate tenant-less operator through above.
  if not found then
    return false;
  end if;

  select cs.internal_account into v_internal
    from public.client_settings cs
   where cs.client_id = v_client;

  if coalesce(v_internal, false) is not true then
    return false;
  end if;

  return public.area_level_for(v_role, v_title, v_access, 'projects') <> 'none';
end
$fn$;

comment on function public.can_open_projects() is
  'True when the caller may open the internal Projects console: an app_operators row that is not support_only (a support_only row answers false, final — migration 250), OR a client_users row on a tenant flagged client_settings.internal_account whose resolved projects level is not none (migration 183). Argument-less so it cannot be used to enumerate; the browser uses it to decide whether to render the tab, and portal-projects re-checks the same two doors server-side.';

revoke execute on function public.can_open_projects() from public, anon;
grant  execute on function public.can_open_projects() to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Refuse to report success unless every operator gets the answer portal-projects would give:
-- a platform operator true, a support operator false. Reads only — the caller's identity is set
-- for this transaction alone (set_config(..., true)) and cleared again, the same way 241's probe
-- signs in. can_open_projects is SECURITY DEFINER, so no role switch is needed.
-- ─────────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  r   record;
  got boolean;
  n   int := 0;
begin
  if position('250:' in pg_get_functiondef('public.can_open_projects()'::regprocedure)) = 0 then
    raise exception '250 did not land: can_open_projects() does not carry the 250 door';
  end if;
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public' and p.proname = 'can_open_projects') <> 1 then
    raise exception '250: can_open_projects has more than one overload';
  end if;

  for r in select user_id, support_only from public.app_operators loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.user_id, 'role', 'authenticated')::text, true);
    got := public.can_open_projects();
    if got is distinct from (not r.support_only) then
      perform set_config('request.jwt.claims', '', true);
      raise exception '250: can_open_projects() answered % for an operator with support_only = %', got, r.support_only;
    end if;
    n := n + 1;
  end loop;
  perform set_config('request.jwt.claims', '', true);

  -- No caller still answers false. The null-uid guard is untouched, but a probe that never ran
  -- it proves nothing about it.
  if public.can_open_projects() is not false then
    raise exception '250: can_open_projects() answered true with no caller';
  end if;

  raise notice '250: can_open_projects() agrees with portal-projects for all % operator rows', n;
end
$$;
