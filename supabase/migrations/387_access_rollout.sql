-- 387: THE ROLLOUT SWITCH for plans as data (386). Which companies' portals obey the new map.
--
-- 386 added the plans, the per-company exceptions and one resolver, and nothing read them. This is
-- the switch a reader asks before it believes the resolver: a company is "enforced" when it is named
-- here (or when everything is). Until then that company's portal keeps working out its tabs the old
-- way, from billing features and the shape columns, exactly as before.
--
-- WHY A SWITCH AT ALL. The resolver was held equal to today's rules on every live company before
-- anything read it (386's parity run), but ON versus NOT ON is what that proves. Whether a tab that
-- is not on shows a padlock or nothing, and what each page does when its tab is locked, lives in the
-- portal shell. Moving one company at a time, ours first, means a difference shows up on our own
-- account on beta and nowhere else. The weekly promotion to production then carries code that
-- changes nothing for any builder, because no builder is named here.
--
--   access_config              one row per setting; `enforce` holds { "all": false, "clients": [...] }.
--                              Not a tenant table (no client_id column): it is ours, not a company's.
--   access_for_portal(client)  { "enforced": bool, "modules": { tab: state } | null, "granted": bool }.
--                              One call for portal-billing, which adds `modules` to the entitlement it
--                              already sends. Null modules = not enforced = the old rules.
--
-- `granted` IS FOR THE BILLING GATE. portal-billing holds a company with nothing paid at a gate
-- ("activate your account"), and a plan an operator ASSIGNED is not a payment it can see. Without
-- this, the first company put on a custom plan would land on that gate whatever its tabs said.
-- granted = the company is enforced AND an operator gave it something directly: an assignment that
-- has not ended (to a plan that is not a draft), or a tab switched on for it. It is deliberately NOT
-- "has any tab on": a 3D comp or a phone switch never opened the gate before, and must not start to.
--
-- FAILS TO "NOT ENFORCED". A missing row, a malformed value or an unknown company all answer
-- enforced false, and the caller treats a failed call the same way: the old rules. The switch can
-- only ever move a company ONTO the new map by naming it.
--
-- Service-role only, like 386's tables. The function is SECURITY DEFINER with an empty search_path
-- and EXECUTE revoked from public, anon and authenticated.
--
-- The repo is public: no client identifiers in here. The companies named in the row are data.
--
-- Rollback: drop function if exists public.access_for_portal(text);
--           drop table if exists public.access_config;

create table if not exists public.access_config (
  key        text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table public.access_config is
  'Settings for plans as data (migration 387). `enforce` = { all, clients }: whose portal obeys '
  'access_resolve. Service-role only.';

alter table public.access_config enable row level security;
revoke all on public.access_config from public, anon, authenticated;
grant all on public.access_config to service_role;

insert into public.access_config (key, value) values ('enforce', '{"all": false, "clients": []}'::jsonb)
on conflict (key) do nothing;

create or replace function public.access_for_portal(p_client_id text)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
           'enforced', e.is_on,
           'modules', case when e.is_on then public.access_resolve(p_client_id) else null end,
           'granted', e.is_on and (
             exists (select 1
                       from public.client_access_plans a
                       join public.access_plans p on p.key = a.plan_key and p.status <> 'draft'
                      where a.client_id = p_client_id and (a.expires_at is null or a.expires_at > now()))
             or exists (select 1
                          from public.client_modules x
                         where x.client_id = p_client_id and x.mode = 'on'
                           and (x.expires_at is null or x.expires_at > now()))))
    from (
      select (p_client_id is not null and (
               coalesce(c.value -> 'all' = 'true'::jsonb, false)
               or coalesce(jsonb_typeof(c.value -> 'clients') = 'array' and (c.value -> 'clients') ? p_client_id, false)
             )) as is_on
        from (select 1) one
        left join public.access_config c on c.key = 'enforce'
    ) e
$function$;

comment on function public.access_for_portal(text) is
  'For portal-billing: { enforced, modules, granted }. modules is access_resolve''s answer when the '
  'company is named in access_config.enforce (or all is true), else null = the old rules. granted = an '
  'operator assigned it a plan or switched a tab on, which opens the billing gate. Migration 387.';

revoke execute on function public.access_for_portal(text) from public, anon, authenticated;
grant  execute on function public.access_for_portal(text) to service_role;

-- Rehearsal: the shape this migration promises, or it does not apply.
do $$
declare v jsonb;
begin
  select value into v from public.access_config where key = 'enforce';
  if v is null or jsonb_typeof(v -> 'clients') <> 'array' or jsonb_typeof(v -> 'all') <> 'boolean' then
    raise exception '387: the enforce row is missing or malformed: %', v;
  end if;
  if has_function_privilege('anon', 'public.access_for_portal(text)', 'execute')
     or has_function_privilege('authenticated', 'public.access_for_portal(text)', 'execute') then
    raise exception '387: a browser role can execute access_for_portal';
  end if;
  if (public.access_for_portal(null) ->> 'enforced')::boolean or (public.access_for_portal(null) ->> 'granted')::boolean then
    raise exception '387: a null company reads as enforced or granted';
  end if;
end $$;
