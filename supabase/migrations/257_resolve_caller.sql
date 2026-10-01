-- 257_resolve_caller.sql — one query that answers "is this login still alive, and which business
-- is it?", so _shared/resolveTenant.ts can verify the access token itself instead of asking GoTrue
-- (auth.getUser) on every portal call.
--
-- ⛔ APPLY BY HAND (`supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`.
--
-- WHY: getUser() is a network round trip to the auth server on every call, and it was the slowest,
-- least predictable part of the portal's preamble — measured 2026-10-01 through portal-settings'
-- Server-Timing with the function next to the database: 0.12–0.16 s on a good call, 2.6–3.5 s on
-- a bad one. Access tokens here are ES256-signed, so the signature, issuer, audience and expiry are
-- checked in the function against the published key set (_shared/localJwt.ts). A signature cannot
-- say whether the user has since SIGNED OUT, though: GoTrue deletes the session row, but the token
-- stays validly signed until it expires. This function answers that half from auth.sessions, in
-- the same round trip as the client_users lookup resolveTenant needed anyway — so sign-out still
-- takes effect immediately, and the fast path costs no extra query.
--
-- WHAT "LIVE" MEANS — the stricter of what getUser() checks, never looser:
--   • the session row still exists (sign-out, "sign out everywhere" and admin revocation delete it),
--     belongs to this user, and has not passed its not_after;
--   • the user still exists and is not soft-deleted;
--   • the user is not currently banned (banned_until in the future).
--
-- THE CLIENT_USERS HALF is the exact read it replaces: the same four columns, `where user_id = …
-- limit 1`, unordered (resolveTenant's own comment explains why limit 1 and not maybeSingle). A
-- user with no client_users row still gets ONE row back, with session_live set and the mapping
-- columns null, so "no business linked" stays distinguishable from "not signed in".
--
-- SERVICE ROLE ONLY. It reads auth.sessions and answers for any user id, so anon/authenticated must
-- never call it — revoked from PUBLIC as well as the named roles (Supabase's default privileges
-- grant new functions to all three).

create or replace function public.resolve_caller(p_user_id uuid, p_session_id uuid)
returns table (session_live boolean, client_id text, role text, title text, access jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from auth.sessions s
      join auth.users u on u.id = s.user_id
      where s.id = p_session_id
        and s.user_id = p_user_id
        and (s.not_after is null or s.not_after > now())
        and u.deleted_at is null
        and (u.banned_until is null or u.banned_until <= now())
    ) as session_live,
    cu.client_id,
    cu.role,
    cu.title,
    cu.access
  from (select 1) as one
  left join lateral (
    select c.client_id, c.role, c.title, c.access
    from public.client_users c
    where c.user_id = p_user_id
    limit 1
  ) as cu on true;
$$;

revoke execute on function public.resolve_caller(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.resolve_caller(uuid, uuid) to service_role;

-- Self-check: refuse to finish if the grants did not land as intended.
do $$
begin
  if has_function_privilege('anon', 'public.resolve_caller(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.resolve_caller(uuid, uuid)', 'execute') then
    raise exception 'migration 257: resolve_caller must be service_role only — revoke from PUBLIC as well as from the named roles';
  end if;
  if not has_function_privilege('service_role', 'public.resolve_caller(uuid, uuid)', 'execute') then
    raise exception 'migration 257: service_role cannot execute resolve_caller';
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = 'public.resolve_caller(uuid, uuid)'::regprocedure) then
    raise exception 'migration 257: resolve_caller must be SECURITY DEFINER (it reads auth.sessions)';
  end if;
end $$;
