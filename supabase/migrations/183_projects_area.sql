-- 183_projects_area: Settings → Team becomes the place Projects access is granted,
--                    and the SQL mirror catches up with the two areas it had lost.
--
-- WHY (Carolyn, 2026-09-02, with Settings → Team open beside the Projects people list):
-- "I feel like THIS should be where we add them. And here we say ... we give them access to
-- projects. That's the way I see it ... this part right here is where we add the users. And
-- that's not built in right now currently ... I don't think it's connected at all."
--
-- She is right that it is not connected: across all 210 migrations there is no trigger on
-- client_users or pm_people, portal-projects never references client_users, and
-- portal-commissions never references pm_people. The two lists have simply drifted —
-- structure-studio's Team holds four people, two of whom (a driver and a sales rep) appear
-- on no board at all.
--
-- ⚠️ TWO THINGS THIS MIGRATION IS NOT.
--   * It does not make Projects per-tenant. No pm_* table has a client_id and none gains
--     one here: Projects is ONE internal board, and the whole point of the internal_account
--     check below is that a builder's staff can never reach it.
--   * The area is not, by itself, the gate. portal-projects establishes that the caller's
--     tenant IS ours before it consults the area at all. The area answers "what may this
--     CSM person do on the board", not "whose board is it".
--
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — re-issue area_level_for with TWENTY areas.
--
-- ⚠️ THE MIRROR WAS ALREADY BROKEN BEFORE THIS FEATURE, and fixing it is half of why this
-- part exists. 154's own comment says "CHANGE THE TWO TOGETHER", and then `change_orders`
-- was added to _shared/access.ts on 2026-09-01 (commit 0cfd398) and never landed here: the
-- function has been resolving it to 'none' for everyone, owners excepted, ever since.
--
-- That has been INERT — no policy in 154 keys on change_orders, and unknown areas return
-- 'none' rather than raising — but it is exactly the shape of a bug that stops being inert
-- the day someone adds a policy for it and cannot work out why every row vanished. The
-- preflight gate added in this same commit now cross-checks the two lists on every push, so
-- this is the last time the drift can happen silently.
--
-- The resolution LOGIC below is byte-identical to 154's. Only k_areas and k_presets move.
-- ═════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.area_level_for(
  p_role   text,
  p_title  text,
  p_access jsonb,
  p_area   text
) returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  -- ── AREAS ── mirror of `AREAS` in _shared/access.ts. `levels` is the vocabulary for THAT
  -- row: commissions is deliberately not the universal none/view/edit triplet, which is why
  -- the level check below reads the array instead of assuming three values.
  --
  -- `internalOnly` is NOT mirrored, on purpose. It governs which switches accessMetadata()
  -- ships to a browser — a presentation rule with no bearing on how a stored map resolves —
  -- and mirroring it here would invite a future reader to treat it as the tenancy check,
  -- which it is not.
  k_areas constant jsonb := $j$
  {
    "designer":             {"levels": ["none","view","edit"]},
    "designs":              {"levels": ["none","view","edit"]},
    "contacts":             {"levels": ["none","view","edit"]},
    "inventory":            {"levels": ["none","view","edit"]},
    "orders":               {"levels": ["none","view","edit"]},
    "change_orders":        {"levels": ["none","view","edit"]},
    "build_schedule":       {"levels": ["none","view","edit"]},
    "delivery_schedule":    {"levels": ["none","view","edit"]},
    "repairs":              {"levels": ["none","view","edit"]},
    "commissions":          {"levels": ["none","own","edit"]},
    "reports":              {"levels": ["none","view","edit"]},
    "projects":             {"levels": ["none","view","edit"]},
    "settings_structures":  {"levels": ["none","view","edit"]},
    "settings_options":     {"levels": ["none","view","edit"]},
    "settings_branding":    {"levels": ["none","view","edit"]},
    "settings_crm":         {"levels": ["none","view","edit"]},
    "settings_quickbooks":  {"levels": ["none","view","edit"]},
    "settings_email":       {"levels": ["none","view","edit"]},
    "settings_team":        {"levels": ["none","view","edit"], "byTitleOnly": true},
    "settings_billing":     {"levels": ["none","view","edit"], "ownerGranted": true}
  }
  $j$::jsonb;

  -- ── PRESETS ── mirror of `PRESETS`. A title's default switches; anything a preset OMITS
  -- resolves to 'none', which is what makes tomorrow's new area safe to add.
  --
  -- `projects` appears on OWNER only, because the TypeScript owner preset is built from
  -- AREA_KEYS and therefore picks up every area automatically. Every other title omits it —
  -- including admin — so nobody gains the internal board by being promoted.
  k_presets constant jsonb := $j$
  {
    "owner": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "change_orders":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","projects":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"edit"
    },
    "admin": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "change_orders":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"none"
    },
    "sales_rep": {
      "designer":"edit","designs":"edit","contacts":"edit",
      "inventory":"view","orders":"edit","commissions":"own"
    },
    "crew_leader": {
      "build_schedule":"edit","repairs":"edit",
      "designs":"view","inventory":"view","orders":"view"
    },
    "driver": {
      "delivery_schedule":"edit",
      "inventory":"view","orders":"view"
    }
  }
  $j$::jsonb;

  v_area     jsonb;
  v_title    text;
  v_level    text;
  v_override text;
begin
  -- UNKNOWN AREA -> 'none'. Mirrored from 154 rather than quietly improved, because the two
  -- must agree; see that migration's note on why failing open here was rejected.
  v_area := k_areas -> p_area;
  if v_area is null then
    return 'none';
  end if;

  -- OWNERS ABSOLUTE. An owner's stored map is never consulted, so a hostile, corrupted or
  -- hand-edited access blob can never lock an owner out of their own business.
  if p_role = 'owner' then
    return 'edit';
  end if;

  -- normTitle(): anything that is not one of the five known titles is a sales_rep.
  v_title := case
               when p_title in ('owner','admin','sales_rep','crew_leader','driver') then p_title
               else 'sales_rep'
             end;

  -- `out[k] = base[k] ?? "none"`.
  v_level := coalesce(k_presets -> v_title ->> p_area, 'none');

  -- The stored deviations, layered on top — the same three skips, in the same order as the
  -- TypeScript loop.
  if p_access is not null and jsonb_typeof(p_access) = 'object' then
    v_override := p_access ->> p_area;
    if v_override is not null
       and not (coalesce((v_area ->> 'ownerGranted')::boolean, false) and v_title <> 'admin')
       and not coalesce((v_area ->> 'byTitleOnly')::boolean, false)
       and exists (select 1 from jsonb_array_elements_text(v_area -> 'levels') as lv(l)
                    where lv.l = v_override)
    then
      v_level := v_override;
    end if;
  end if;

  return v_level;
end
$fn$;

comment on function public.area_level_for(text, text, jsonb, text) is
  'Pure mirror of effectiveAccess() in supabase/functions/_shared/access.ts: the title preset merged with the stored per-area deviations, owners absolute. MUST be changed in the same commit as that file — scripts/preflight.mjs cross-checks the two area lists on every push (migration 183). Reads no tables, so it is safe to call for preview/audit.';

revoke execute on function public.area_level_for(text, text, jsonb, text) from public, anon;
grant  execute on function public.area_level_for(text, text, jsonb, text) to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — may the signed-in caller open the Projects console?
--
-- TWO DOORS, and the second one is additive. Nothing anywhere starts REQUIRING a
-- client_users row:
--
--   1. an app_operators row — the platform operator, who by design belongs to no tenant at
--      all. resolveTenant has always supported that and there is a test pinning it
--      (_test_stubs/resolveTenant_test.ts, "operator with no client_users row still resolves
--      the target"). If this function ever started demanding a tenant row, every CSM
--      operator who is not a member of one would lose the console.
--
--   2. a client_users row on an INTERNAL tenant whose resolved `projects` level is not
--      'none' — the new path, and the one Carolyn asked for.
--
-- ⚠️ THE INTERNAL CHECK COMES FIRST AND IS THE REAL BOUNDARY. Every owner of every builder
-- tenant resolves projects='edit' (the owner preset is absolute, by construction); what
-- stops Junior Barns' owner opening CSM's roadmap is client_settings.internal_account, not
-- the area. Read that sentence again before simplifying this function.
--
-- security definer for the same reason current_area_level is: client_settings is
-- service-role only and client_users' single browser policy is client_users_select_own, so
-- an unprivileged caller could answer neither question about themselves.
-- ═════════════════════════════════════════════════════════════════════════════════════════

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
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    return false;
  end if;

  -- Door 1. Kept first and deliberately cheap: it is the path every existing operator takes,
  -- and it must not depend on anything the second door needs.
  if exists (select 1 from public.app_operators o where o.user_id = v_uid) then
    return true;
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
  'True when the caller may open the internal Projects console: an app_operators row, OR a client_users row on a tenant flagged client_settings.internal_account whose resolved projects level is not none (migration 183). Argument-less so it cannot be used to enumerate; the browser uses it to decide whether to render the tab, and portal-projects re-checks the same two doors server-side.';

revoke execute on function public.can_open_projects() from public, anon;
grant  execute on function public.can_open_projects() to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — assertions. Modelled on 154 PART 4: these RAISE, which aborts the transaction and
--          takes PARTS 1-2 with it, so a mirror that does not resolve the way the TypeScript
--          does cannot be left installed.
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
begin
  -- The two areas this migration adds, at both ends of the ladder.
  if public.area_level_for('owner', 'owner', null, 'projects') <> 'edit' then
    raise exception 'area_level_for: an owner must resolve projects=edit';
  end if;
  if public.area_level_for('user', 'admin', null, 'projects') <> 'none' then
    raise exception 'area_level_for: projects must NOT come with the admin title';
  end if;
  if public.area_level_for('user', 'sales_rep', null, 'projects') <> 'none' then
    raise exception 'area_level_for: projects must default to none for staff';
  end if;
  -- A granted override resolves, so the Team switch actually does something.
  if public.area_level_for('user', 'sales_rep', '{"projects":"view"}'::jsonb, 'projects') <> 'view' then
    raise exception 'area_level_for: a stored projects override must resolve';
  end if;

  -- The drift this migration repairs. If these two ever fail again, the preflight
  -- cross-check has been removed or bypassed.
  if public.area_level_for('user', 'admin', null, 'change_orders') <> 'edit' then
    raise exception 'area_level_for: change_orders must come with the admin title';
  end if;
  if public.area_level_for('user', 'sales_rep', null, 'change_orders') <> 'none' then
    raise exception 'area_level_for: change_orders must default to none for a sales rep';
  end if;

  -- A spot check that re-issuing did not disturb anything else.
  if public.area_level_for('user', 'driver', null, 'delivery_schedule') <> 'edit' then
    raise exception 'area_level_for: the driver preset moved';
  end if;
  if public.area_level_for('user', 'admin', '{"settings_billing":"edit"}'::jsonb, 'settings_billing') <> 'edit'
     or public.area_level_for('user', 'sales_rep', '{"settings_billing":"edit"}'::jsonb, 'settings_billing') <> 'none' then
    raise exception 'area_level_for: the ownerGranted rule moved';
  end if;
  if public.area_level_for('user', 'admin', '{"settings_team":"none"}'::jsonb, 'settings_team') <> 'edit' then
    raise exception 'area_level_for: the byTitleOnly rule moved';
  end if;

  -- ⚠️ EXACTLY ONE INTERNAL TENANT. Not a style check: internal_account also confers every
  -- paid feature (169), so a second one appearing means somebody flagged a demo or a
  -- customer, and that tenant's staff would now be one Team switch away from CSM's internal
  -- boards. Blocking here forces a human decision instead of a silent widening.
  if (select count(*) from public.client_settings where internal_account) <> 1 then
    raise exception 'internal_account is set on % tenants, expected exactly 1 — resolve this before granting Projects by tenant',
      (select count(*) from public.client_settings where internal_account);
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- ROLLBACK, if this has to come out:
--   * re-issue 154's area_level_for verbatim (it is the previous definition, 18 areas —
--     note that restores the change_orders drift too, which you probably do not want);
--   * drop function public.can_open_projects();
--   * strip "projects" from any client_users.access blob that gained it.
-- ─────────────────────────────────────────────────────────────────────────────────────────
