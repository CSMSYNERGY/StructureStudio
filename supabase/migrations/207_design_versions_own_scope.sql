-- 207_design_versions_own_scope.sql — close the one gap 193 named and deliberately left.
--
-- ── WHY ───────────────────────────────────────────────────────────────────────────────────
-- 193's header, verbatim:
--
--   "⚠️ KNOWN GAP, DELIBERATELY NOT CLOSED HERE: public.design_versions. The Pipeline reads
--    it directly (portal/02-sales.jsx:189) and it carries a design's configuration and
--    images, but no contact of its own — gating it means joining to designs by short_code,
--    i.e. a fourth policy and a fourth helper. Its rows are only ever rendered under a design
--    the list has already filtered away, so the leak is devtools-only and is configuration,
--    not customer identity. Closing it is one policy of the same shape."
--
-- That reasoning was right about the SEVERITY and is not an argument for leaving it. A rep on
-- contacts:'own' cannot see another rep's design in the list, but `design_versions` answers a
-- direct PostgREST query for the same building's configuration, sizes, selections and image
-- URLs. "Devtools-only" describes the effort, not the permission — and the whole point of
-- 193 is that this tenant's builder does not want his dealers reading each other's work.
--
-- 193 also wrote the policy out. This is that policy, with its own helper, applied.
--
-- ── THE RECURSION TRAP, WHICH IS THE ONLY HARD PART ───────────────────────────────────────
-- The predicate has to read public.designs from inside a policy. Left bare, that read runs
-- through designs' OWN policies — including 193's `designs_own_select`, which is the policy
-- directly above this one in the same restrictive stack. A row a rep may not see would make
-- its own version rows invisible for the wrong reason, and worse, the behaviour would depend
-- on policy evaluation order rather than on the rule anyone wrote down.
--
-- So the read is wrapped in a SECURITY DEFINER function, exactly as 193 said it must be.
--
-- ⚠️ IT CALLS crm_contact_mine, THE ONE-ARGUMENT WRAPPER, NOT crm_contact_visible_to. The
-- two-argument predicate is service-role only on purpose: granting it to `authenticated`
-- would let any rep ask "does colleague X own customer Y", which is precisely the fact
-- Carolyn reserved to the owner ("only the owner would see, okay, this customer went through
-- employee B and C", 09-04 @1:02:16).
--
-- ── WHAT IT DOES NOT CHANGE ──────────────────────────────────────────────────────────────
-- Nothing, for anybody, today. It narrows only callers whose resolved contacts level is
-- exactly 'own', and an owner short-circuits to 'edit' before the access map is read. Same
-- property 193 asserted for itself: applying this file takes nothing from anyone until an
-- owner sets somebody to Own only.
--
-- ROLLBACK:
--   drop policy if exists design_versions_own_select on public.design_versions;
--   drop function if exists public.crm_design_mine(text, text);
--
-- HAND-APPLY: pipe this file to `supabase db query --linked`. NOT `--file` (auth-fails,
-- retries, still exits 0) and NOT with a `--` separator (that makes the CLI read stdin and
-- ignore the argument). Then record in supabase_migrations.schema_migrations. BOM-free.

begin;

-- ── The helper. SECURITY DEFINER so the designs read does not re-enter designs' policies. ──
create or replace function public.crm_design_mine(p_client_id text, p_short_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.designs d
     where d.short_code = p_short_code
       and d.client_id  = p_client_id
       and public.crm_contact_mine(d.contact_id)
  );
$fn$;

comment on function public.crm_design_mine(text, text) is
  'Is this design one the CALLER may see under contacts:''own''? SECURITY DEFINER because it '
  'is called from a policy and must not re-enter designs'' own policies (207). Delegates to '
  'crm_contact_mine, never the two-argument predicate — a rep may not ask about a colleague.';

revoke execute on function public.crm_design_mine(text, text) from public, anon;
grant  execute on function public.crm_design_mine(text, text) to authenticated, service_role;

-- ── The policy. RESTRICTIVE, so it ANDs onto the existing tenant policy rather than ORing
--    in and widening — the same load-bearing detail 154's header calls out. ─────────────────
drop policy if exists design_versions_own_select on public.design_versions;
create policy design_versions_own_select on public.design_versions
  as restrictive for select to authenticated
  using (
    case when (select public.crm_contact_scope()) = 'own'
         then public.crm_design_mine(design_versions.client_id, design_versions.short_code)
         else true end
  );

-- ── Assertions. These RAISE, which aborts the transaction — every failure below is SILENT
--    at runtime, which is the whole reason they are here. ────────────────────────────────────
do $$
declare r record;
begin
  select * into r from pg_policies
   where schemaname = 'public' and tablename = 'design_versions'
     and policyname = 'design_versions_own_select';
  if not found then
    raise exception '207: the policy did not land';
  end if;
  if r.permissive <> 'RESTRICTIVE' then
    raise exception '207: policy landed % — a PERMISSIVE policy ORs in and WIDENS access', r.permissive;
  end if;
  if r.cmd <> 'SELECT' then
    raise exception '207: policy landed for %, expected SELECT', r.cmd;
  end if;
  if r.roles::text not like '%authenticated%' then
    raise exception '207: policy is not scoped to authenticated (roles=%)', r.roles;
  end if;

  -- The permissive tenant policy must still exist. A restrictive policy alone grants nothing,
  -- so if the tenant policy were ever dropped this table would return zero rows to everyone
  -- and look like a bug in the Pipeline rather than a missing policy.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'design_versions' and permissive = 'PERMISSIVE'
  ) then
    raise exception '207: no PERMISSIVE policy remains on design_versions — it would return nothing to everyone';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'crm_design_mine' and p.prosecdef
  ) then
    raise exception '207: crm_design_mine is not SECURITY DEFINER — the policy would recurse into designs'' own policies';
  end if;

  raise notice '207: design_versions is scoped for contacts=own; nobody is narrowed until an owner sets it';
end $$;

commit;
