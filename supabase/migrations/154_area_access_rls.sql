-- 154_area_access_rls: give per-area access a SERVER representation. Audit finding 11.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Do not let this ride a script, a CI step or
--    an agent to production. It is the FIRST restrictive policy in this database and the
--    only migration in the repo that can take rows AWAY from a signed-in builder. A wrong
--    area key here does not throw — it silently empties a tab for a real business. Read
--    PART 0, run its queries against live data, and decide, before PART 3 is applied.
--
-- ── WHY (audit finding 11, confirmed and still open) ─────────────────────────────────────
-- Migration 100 added `client_users.title` and `client_users.access` and created NO policy.
-- The per-area permission map has therefore never existed in SQL. Every policy on the five
-- tables below is `client_id = public.current_client_id()` and nothing else:
--   001_tenancy.sql:35         designs_owner_select
--   031_design_versions.sql:33 design_versions_owner_select
--   062_captured_leads.sql:37  captured_leads_owner_select
--   075_inventory.sql:101      inventory_units_owner_select
--   130_crm_contacts.sql:78    crm_contacts_owner_select
--
-- The portal reads all five over DIRECT PostgREST — DesignsTable (portal/02-sales.jsx:147,
-- :165), LeadsTable (:766, :776), the inventory picker (:115) — so the tab clamp in
-- portal/01-core.jsx is the ONLY gate on them, and a tab clamp runs in the browser.
-- Consequence, recorded verbatim at portal/11-shell.jsx:337-370: an authenticated team
-- member whose Designs/Contacts switches an owner set to "none" opens devtools, runs
-- `sb.from("designs").select("*")`, and RLS hands back every design, contact, phone number
-- and quote figure in the tenant. _shared/access.ts:12 already states the rule — "the UI
-- hiding a tab is a courtesy, not a control". For these five tables there was no control
-- behind the courtesy. This migration is that control, and nothing else changes.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1  public.area_level_for(role, title, access, area)  — a PURE mirror of
--           effectiveAccess() in supabase/functions/_shared/access.ts. Reads no tables.
--   PART 2  public.current_area_level(area)                   — SECURITY DEFINER; resolves
--           the caller's client_users row and delegates to PART 1.
--   PART 3  one RESTRICTIVE select policy per table, ANDed with the existing tenant policy.
--   PART 4  apply-time assertions (they abort the transaction; see "ONE TRANSACTION" below).
--   PART 5  verification — the exact SELECTs to run as each role.
--   PART 6  rollback.
--
-- PARTS 1, 2 AND 4 ARE INERT. A function nothing references changes no behaviour, so they
-- can be applied on their own, inspected with PART 0's blast-radius query, and left sitting
-- there for a day. PART 3 is the only part that can take a row away.
--
-- ONE TRANSACTION: wrap the whole file in begin;/commit; when you apply it. PART 4's
-- assertions are worth having only if a failure takes the policies with it.
--
-- ── RESTRICTIVE IS LOAD-BEARING ──────────────────────────────────────────────────────────
-- Postgres ORs permissive policies together and ANDs restrictive ones in afterwards. A
-- second PERMISSIVE policy here would WIDEN access — `tenant OR area` — and hand every
-- table to anyone the area check happened to pass. The word `restrictive` on each policy
-- below is the difference between closing this finding and inverting it. PART 4 refuses to
-- finish if any of the five policies did not land as RESTRICTIVE.
--
-- ── KEEP IN STEP WITH _shared/access.ts ──────────────────────────────────────────────────
-- PART 1 is a hand transcription of PRESETS + effectiveAccess(). THE TWO MUST BE CHANGED
-- TOGETHER, IN THE SAME COMMIT, ALWAYS. They are the same rule about the same people, and
-- they disagree in the worst possible way if they drift: TypeScript decides whether an
-- edge-function action is refused, SQL decides whether a row comes back, and a person caught
-- between the two sees a tab that loads with nothing in it and an owner who swears they
-- turned it on. Adding an area to AREAS, changing a PRESET, or adding a title means editing
-- the two jsonb constants in PART 1 in the same breath. There is no test pinning this yet:
-- adding one to scripts/preflight.mjs (parse AREAS/PRESETS out of access.ts, diff against
-- area_level_for's constants) is the obvious follow-up and is NOT part of this file.
--
-- ── KNOWN CONSEQUENCES — DECIDE THESE BEFORE APPLYING PART 3 ─────────────────────────────
-- 1. THE ORDERS TAB IS NOT AFFECTED — and this has to be written out, because every reading
--    of the code short of the render block says it is. An earlier version of this header
--    asserted the opposite as fact and offered three options for it; the walk below is what
--    disproved it, and is why the walk is now part of the file.
--    THE MECHANISM IS REAL: the driver preset is orders:'view' with designs:'none'
--    (_shared/access.ts PRESETS) and portal/01-core.jsx TAB_AREA maps orders -> 'orders', so
--    a driver genuinely opens Orders; OrdersView (portal/04-orders.jsx:751) builds that tab
--    by reading `designs` DIRECTLY at :816, and OrderDetail does it again at :2019 through
--    .maybeSingle(). After PART 3 both return empty with error === null, so the
--    `if (dsnRes.error)` guard on the next line never fires, `byCode` stays empty and the
--    ssOrders filter drops every row carrying a short_code.
--    ⛔ IT IS UNREACHABLE. portal/11-shell.jsx:1098 mounts OrdersView only for
--    `isOperator && !viewing`. Every tenant user — owner, admin, sales rep, crew leader,
--    driver, in every builder's account — gets <OrdersPreview /> instead: the static
--    "Coming soon / example data" card, which reads no table at all. is_operator()
--    (051_operators.sql:28) is the CSM Synergy staff roster in app_operators, not a tenant
--    title, so no builder can be one. And the operator on their OWN tenant resolves
--    designs:'edit' by every route into PART 1 (owner short-circuit, admin preset, or
--    normTitle's sales_rep fallback for a null title), so they are not narrowed either.
--    WHAT IT COSTS LATER, which is the part to carry forward: the day OrdersView ships to
--    tenants this becomes real for all four titles holding orders >= 'view'. Fix it THEN,
--    in code — move the designs read behind a portal-settings action gated
--    { area: 'orders', level: 'view' }, the way every other cross-area read in this product
--    already works, so the server decides which design rows an order viewer may see.
--    Do NOT widen this policy to get there. Not `designs OR orders`, and not the EXISTS
--    against `orders` on the same client_id/short_code either — that one reads as the
--    narrow, careful version and is not: designs_ensure_order mints an order row for EVERY
--    accepted/invoiced design, so the EXISTS resolves to "every design that was ever sold"
--    and hands the least privileged title in the product a clean list of each of those
--    customers' names, phone numbers, selections and quote figures. That is audit finding 11
--    restored, bought in advance, for a tab nobody can open yet.
--    Do NOT grant drivers Designs:'view' on the Team screen either. It is 30 seconds of work
--    that gives a driver every design in the tenant — the whole of what this file closes —
--    to repair a symptom that does not exist.
-- 2. The Contacts tab is built from `designs` + `captured_leads` (02-sales.jsx:766, :776).
--    A person given Contacts but NOT Designs will see browsing leads only — every contact who
--    ever submitted a design vanishes from their list. No shipped preset is in that state
--    (it takes a hand-set override), and the narrowing is arguably correct, but it looks like
--    a broken tab rather than a permission, so it belongs in the release note.
-- 3. Cosmetic, and already handled at both sites: DesignsTable's inventory serial chips
--    (02-sales.jsx:115) and the designer's unit banner (structure-studio.component.js:7231)
--    degrade to "no serial" on an empty read — each already documents that path for operators
--    in view-as. Every shipped title holds inventory >= 'view', so it takes an override to
--    happen at all.
-- 4. NOT CLOSED BY THIS FILE, on purpose: the code-keyed capability RPCs. load_design,
--    load_design_version and list_design_versions are SECURITY DEFINER and granted to anon
--    (002:87, 031, 032). They bypass every policy here — that is the anon designer's whole
--    delivery model, and the customer portal's. So a team member on designs:'none' who
--    already KNOWS a short code can still fetch that one design. Guessing
--    SS-[A-HJ-NP-Z2-9]{6,12} is the control there, unchanged since 048 dropped the
--    phone-keyed lookup. What this migration closes is the LIST read — "give me all of
--    them" — which is what the finding describes.
--
-- ── THE WALK — every preset, every tab it opens, every DIRECT read that tab performs ──────
-- This is the evidence for the four consequences above, and it is in the file because the
-- version that shipped without it got consequence 1 wrong in the dangerous direction: it
-- told an owner to hand every driver the designs table to repair a tab that was never
-- broken. A consequence asserted from a data path, without checking whether anything mounts
-- it, is a guess wearing a citation.
--
-- METHOD, so it can be redone when a tab is added: TAB_AREA + ssCanSeeTab (portal/01-core.jsx
-- :424-480) give the tabs a preset can open; the render block in portal/11-shell.jsx says
-- which component each tab actually MOUNTS — not which one it is named after; and
-- `grep -n '\.from("' portal/*.jsx structure-studio.component.js` gives every direct
-- PostgREST read in the product. There are eight, listed below, and nothing else: every other
-- portal surface goes through an edge function on the service role, which no policy here
-- touches. There are also zero PostgREST embeds of these tables (no `select("...designs(...)")`),
-- so an embedded read cannot smuggle one in.
--
--   FILE:LINE            TABLE            COMPONENT / TAB                       TAB'S AREA
--   02-sales.jsx:115     inventory_units  DesignsTable   — Pipeline             designs   CROSS
--   02-sales.jsx:147     designs          DesignsTable   — Pipeline             designs   same
--   02-sales.jsx:165     design_versions  DesignsTable   — Pipeline             designs   same
--   02-sales.jsx:766     designs          LeadsTable     — Contacts             contacts  CROSS
--   02-sales.jsx:776     captured_leads   LeadsTable     — Contacts             contacts  same
--   04-orders.jsx:816    designs          OrdersView     — Orders               orders    CROSS
--   04-orders.jsx:2019   designs          OrderDetail    — Orders               orders    CROSS
--   component.js:7231    inventory_units  the designer   — Designer             designer  CROSS
--                        (and its mirrored twin StructureStudio.jsx:7229)
--
-- Four CROSS rows, and each is already accounted for: the two Orders rows are consequence 1
-- (nothing mounts them), Contacts->designs is consequence 2, and the two inventory_units
-- rows are consequence 3. crm_contacts appears NOWHERE — CrmRecord makes exactly one fetch,
-- portal-settings' `crm_record`, and says so at 02-sales.jsx:1263 — so the policy on that
-- table can only ever refuse a devtools query. Pure gain, no surface.
--
-- PER PRESET, then. Tabs are what ssCanSeeTab admits; "loses" is what PART 3 takes away from
-- a screen they can actually reach:
--   OWNER        every tab. PART 1 returns 'edit' before the access map is read. Loses nothing.
--   ADMIN        every tab. Every area 'edit' but settings_billing. Loses nothing.
--   SALES_REP    Designer, Contacts, Pipeline, Inventory, Orders, Commissions, teasers.
--                designs/contacts 'edit', inventory 'view' — satisfies all four CROSS reads.
--                Commissions is portal-commissions; Inventory is list_inventory. Loses nothing.
--   CREW_LEADER  Pipeline, Inventory, Orders, Build Schedule, Repairs, teasers.
--                contacts 'none' costs them captured_leads and crm_contacts — but the Contacts
--                tab gates on that same area and is hidden, and no tab they CAN open reads
--                either table. Build Schedule and Repairs are portal-schedule end to end
--                (portal/05-schedule.jsx makes ZERO direct reads). Loses nothing visible.
--   DRIVER       Inventory, Orders, Delivery Schedule, teasers, What's New.
--                designs/contacts 'none' costs them four tables — and not one of their tabs
--                reads any of them: Inventory is list_inventory (edge fn), Delivery Schedule
--                is portal-schedule (edge fn), Orders is <OrdersPreview /> (consequence 1),
--                What's New is release_notes + feedback_*, none of them restricted here.
--                Loses nothing.
--
-- So NO SHIPPED PRESET loses a row it can currently see. Every narrowing this file causes
-- takes a hand-set override to reach — which is consequences 2 and 3, and is the point.
--
-- ── SAFETY PROPERTIES, AND WHERE EACH IS ENFORCED ────────────────────────────────────────
--   Owners            PART 1 returns 'edit' before the access map is read at all.
--   Service role      the policies are `to authenticated`; a restrictive policy is not
--                     evaluated for a role it does not name, and service_role additionally
--                     carries BYPASSRLS. Every edge function reads through it: unaffected.
--   anon / customers  same reason (`to authenticated`), plus the customer portal is not a
--                     Supabase auth session at all — customer_sessions are opaque tokens
--                     checked service-side (_shared/customerSession.ts, migration 108), so a
--                     customer is never the `authenticated` role. get_config, get_catalog,
--                     load_design and customer-quotes are untouched; PART 5 H proves it.
--   Absent data       no client_users row, or a null/absent access map, resolves OPEN.
--                     See PART 2's DEFAULT-OPEN note for why that can never widen anything.
--   Typo'd area key   PART 4 aborts the migration.
--
-- Rollback: PART 6. The one-line panic button is at the top of PART 0.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 0 — DO THIS FIRST
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- PANIC BUTTON. If a builder reports an empty tab after this ships, restore today's
-- behaviour instantly. The five drops are independent of the functions and safe to run
-- alone, in any order, at any time:
--
--   drop policy if exists designs_area_select         on public.designs;
--   drop policy if exists design_versions_area_select on public.design_versions;
--   drop policy if exists captured_leads_area_select  on public.captured_leads;
--   drop policy if exists crm_contacts_area_select    on public.crm_contacts;
--   drop policy if exists inventory_units_area_select on public.inventory_units;
--
-- BLAST RADIUS (run after PART 1, before PART 3). Every person who can sign in, and what
-- each of them will be able to read. This is why area_level_for is a PURE function of the
-- row: the preview is exact, not a guess.
--
--   select cu.client_id,
--          cu.role, cu.title,
--          public.area_level_for(cu.role, cu.title, cu.access, 'designs')   as designs,
--          public.area_level_for(cu.role, cu.title, cu.access, 'contacts')  as contacts,
--          public.area_level_for(cu.role, cu.title, cu.access, 'inventory') as inventory,
--          cu.user_id
--     from public.client_users cu
--    order by cu.client_id, cu.title, cu.role;
--
-- WHO ACTUALLY LOSES SOMETHING (the number to take to Carolyn before applying):
--
--   select cu.client_id,
--          count(*) filter (where public.area_level_for(cu.role, cu.title, cu.access, 'designs')   = 'none') as lose_designs,
--          count(*) filter (where public.area_level_for(cu.role, cu.title, cu.access, 'contacts')  = 'none') as lose_contacts,
--          count(*) filter (where public.area_level_for(cu.role, cu.title, cu.access, 'inventory') = 'none') as lose_inventory,
--          count(*) filter (where cu.title = 'driver')                                                       as drivers,
--          count(*)                                                                                          as people
--     from public.client_users cu
--    group by cu.client_id
--    order by 1;
--
-- The `drivers` column is CONTEXT, not a loss count — it used to be named after consequence 1
-- and read as "people this breaks", which is exactly the claim the walk disproved. A driver
-- resolves designs/contacts to 'none' and loses nothing they can see, because every tab they
-- can open reads through an edge function. Keep the column so the numbers can be re-checked
-- when the Orders tab ships to tenants; do not read it as damage today.
--
-- BASELINE. Capture the numbers this migration must NOT change, per user, BEFORE applying
-- PART 3. PART 5 re-runs the identical block afterwards and the two are diffed:
--
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<USER_UUID>","role":"authenticated"}';
--     select (select count(*) from public.designs)         as designs,
--            (select count(*) from public.design_versions) as versions,
--            (select count(*) from public.captured_leads)  as leads,
--            (select count(*) from public.crm_contacts)    as contacts,
--            (select count(*) from public.inventory_units) as units;
--   rollback;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the resolver, as a PURE function. Mirror of effectiveAccess() in
--          supabase/functions/_shared/access.ts. CHANGE THE TWO TOGETHER.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Split out from current_area_level() deliberately, and it earns the split twice:
--   * it TAKES the row instead of reading it, so PART 0 can show an owner exactly who is
--     about to lose what, on live data, before a single policy exists;
--   * it reads no tables and needs no elevated rights, so the privileged half (PART 2) is
--     four lines long and the half worth arguing about has nothing hidden in it.

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
  k_areas constant jsonb := $j$
  {
    "designer":             {"levels": ["none","view","edit"]},
    "designs":              {"levels": ["none","view","edit"]},
    "contacts":             {"levels": ["none","view","edit"]},
    "inventory":            {"levels": ["none","view","edit"]},
    "orders":               {"levels": ["none","view","edit"]},
    "build_schedule":       {"levels": ["none","view","edit"]},
    "delivery_schedule":    {"levels": ["none","view","edit"]},
    "repairs":              {"levels": ["none","view","edit"]},
    "commissions":          {"levels": ["none","own","edit"]},
    "reports":              {"levels": ["none","view","edit"]},
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
  k_presets constant jsonb := $j$
  {
    "owner": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"edit"
    },
    "admin": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"none"
    },
    "sales_rep": {
      "designer":"edit","designs":"edit","contacts":"edit",
      "inventory":"view","orders":"view","commissions":"own"
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
  -- UNKNOWN AREA -> 'none'. effectiveAccess() only ever fills AREA_KEYS, so a key that is
  -- not in the table comes back `undefined` and canRead() reads it as 'none' — for OWNERS
  -- too (access.test.ts's "newly added area" case papers over that with `?? "edit"`; the
  -- resolver itself does not). Mirrored rather than quietly improved, because the two must
  -- agree. It is also the one input that could deny a whole table to a whole tenant, so
  -- PART 4 asserts that every area key these policies use is real before the migration
  -- finishes. Failing OPEN here instead was considered and rejected: it would make a future
  -- typo'd policy silently protect nothing, which is this exact finding, reintroduced and
  -- invisible.
  v_area := k_areas -> p_area;
  if v_area is null then
    return 'none';
  end if;

  -- OWNERS ABSOLUTE. `if (role === "owner") return <every area "edit">` — an owner's stored
  -- map is never consulted, so a hostile, corrupted or hand-edited access blob can never
  -- lock an owner out of their own business. Keyed on `role`, not `title`, exactly as the
  -- TypeScript is: role is the coarse column every other policy in this database already
  -- trusts, and roleForTitle() guarantees every write of one writes the other.
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
  -- TypeScript loop. A non-object blob is treated as no overrides: Object.entries() of a
  -- non-object yields nothing that matches an area key, so the outcome is identical.
  if p_access is not null and jsonb_typeof(p_access) = 'object' then
    v_override := p_access ->> p_area;
    if v_override is not null
       -- owner-granted areas (Billing) resolve ONLY on an admin. Checked at RESOLUTION and
       -- not just at the set_access door, so demoting an admin structurally revokes the
       -- grant without anyone remembering to clear the switch.
       and not (coalesce((v_area ->> 'ownerGranted')::boolean, false) and v_title <> 'admin')
       -- by-title areas (Team) come with the title and are never a per-person switch.
       and not coalesce((v_area ->> 'byTitleOnly')::boolean, false)
       -- and the level must be in THAT area's vocabulary. An invalid level keeps the preset
       -- and must never blank it (access.test.ts pins this: contacts stays 'edit' when
       -- someone has stored "sideways").
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
  'Pure mirror of effectiveAccess() in supabase/functions/_shared/access.ts: the title preset merged with the stored per-area deviations, owners absolute. MUST be changed in the same commit as that file. Reads no tables, so it is safe to call for preview/audit (migration 154, PART 0).';

revoke execute on function public.area_level_for(text, text, jsonb, text) from public, anon;
grant  execute on function public.area_level_for(text, text, jsonb, text) to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — the RLS entry point. SECURITY DEFINER, because client_users' only browser policy
--          is client_users_select_own (001) and a policy must not depend on the caller's own
--          policies. Same posture and same flags as public.current_client_id().
-- ═════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.current_area_level(p_area text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid    uuid;
  v_role   text;
  v_title  text;
  v_access jsonb;
begin
  v_uid := (select auth.uid());

  -- No JWT at all. Unreachable through the policies below (they are `to authenticated`),
  -- but a direct call must still fail OPEN, for the same reason the next branch does.
  if v_uid is null then
    return 'edit';
  end if;

  -- limit 1, never strict/maybeSingle: a duplicate client_users row must not become an
  -- EXCEPTION raised inside an RLS policy, which would turn one bad row into a 500 on every
  -- read that person makes. resolveTenant.ts guards the same hazard the same way (.limit(1),
  -- its "audit #F6" comment), and portal.html before it. Unordered first-row-wins is
  -- deliberate: public.current_client_id() (001) picks its row the same way, so the tenant
  -- policy and this one always read the SAME client_users row and can never disagree about
  -- who this person is.
  select cu.role, cu.title, cu.access
    into v_role, v_title, v_access
    from public.client_users cu
   where cu.user_id = v_uid
   limit 1;

  -- ── DEFAULT-OPEN ON ABSENCE ────────────────────────────────────────────────────────────
  -- No client_users row: return full access, so this restrictive layer contributes NOTHING
  -- and the caller lands on exactly the access they have today.
  --
  -- This cannot widen anything, and the reason is structural rather than a judgement call:
  -- public.current_client_id() reads THE SAME ROW of THE SAME TABLE. No row here means no
  -- row there, means client_id = NULL, means the existing permissive tenant policy already
  -- returns zero rows. ANDing "everything" onto "nothing" is still nothing. So the only
  -- people this policy can ever narrow are people who HAVE a client_users row — and for them
  -- the map is real data, not an absence.
  --
  -- Failing closed here would be the mistake this repo has already made once and written
  -- down: 151_customer_uploads.sql's header explains that an operator with no client_users
  -- row gets NULL from current_client_id() and "every storage policy fails closed".
  -- Operators are precisely the population with no row on the tenant they are looking at.
  -- Their reads run through the service role and are unaffected either way — but a resolver
  -- that answers 'none' to an absent row is one refactor away from being consulted somewhere
  -- that matters.
  --
  -- A NULL or absent `access` map is NOT an absence in this sense: it means "inherit the
  -- title preset", which is what migration 100 stores and what PART 1 resolves. Same answer
  -- as today's TypeScript, on the same inputs.
  if not found then
    return 'edit';
  end if;

  return public.area_level_for(v_role, v_title, v_access, p_area);
end
$fn$;

comment on function public.current_area_level(text) is
  'The signed-in caller''s resolved level for one area (migration 100 + _shared/access.ts). Backs the restrictive area policies added in migration 154. Owners resolve to edit; a caller with no client_users row resolves OPEN, because the tenant policy already denies them every row.';

revoke execute on function public.current_area_level(text) from public, anon;
grant  execute on function public.current_area_level(text) to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — the policies. THE ONLY PART THAT CHANGES BEHAVIOUR.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Each is ANDed with the table's existing permissive tenant policy, so the effective rule
-- becomes:  client_id = current_client_id()  AND  this area is not 'none'.
--
--   `as restrictive`   narrows. A permissive twin would OR in and WIDEN — see the header.
--   `for select`       reads only. Writes to these tables already go through SECURITY
--                      DEFINER RPCs (save_design, crm_ensure_contact) or the service role,
--                      and not one of them is touched.
--   `to authenticated` names the ONLY role this applies to. A restrictive policy is not
--                      evaluated for a role it does not list, which is what keeps anon (the
--                      public designer), the customer portal and every edge function's
--                      service-role client behaving exactly as they do today.
--
-- Area map — portal/01-core.jsx TAB_AREA agrees, so the tab and its data now gate alike:
--   designs, design_versions     -> 'designs'
--   captured_leads, crm_contacts -> 'contacts'
--   inventory_units              -> 'inventory'

drop policy if exists designs_area_select on public.designs;
create policy designs_area_select on public.designs
  as restrictive for select to authenticated
  using (public.current_area_level('designs') <> 'none');

drop policy if exists design_versions_area_select on public.design_versions;
create policy design_versions_area_select on public.design_versions
  as restrictive for select to authenticated
  using (public.current_area_level('designs') <> 'none');

drop policy if exists captured_leads_area_select on public.captured_leads;
create policy captured_leads_area_select on public.captured_leads
  as restrictive for select to authenticated
  using (public.current_area_level('contacts') <> 'none');

drop policy if exists crm_contacts_area_select on public.crm_contacts;
create policy crm_contacts_area_select on public.crm_contacts
  as restrictive for select to authenticated
  using (public.current_area_level('contacts') <> 'none');

drop policy if exists inventory_units_area_select on public.inventory_units;
create policy inventory_units_area_select on public.inventory_units
  as restrictive for select to authenticated
  using (public.current_area_level('inventory') <> 'none');

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — apply-time assertions. These RAISE, which aborts the transaction and takes PART 3
--          with it. That is the point: every failure mode below is SILENT at runtime.
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('designs',         'designs'),
      ('design_versions', 'designs'),
      ('captured_leads',  'contacts'),
      ('crm_contacts',    'contacts'),
      ('inventory_units', 'inventory')
    ) as t(tbl, area)
  loop
    -- 1. THE AREA KEY IS REAL. An unknown key resolves to 'none' for everyone, owners
    --    included (PART 1), so one typo would empty this table for an entire tenant with no
    --    error anywhere. This is the assertion that has to exist.
    --    The owner probe is an EXACT discriminator and that is why it is the only one here:
    --    a known area returns 'edit' for an owner and an unknown area returns 'none', with
    --    nothing else able to produce either answer. Probing a staff title as well would add
    --    no signal and would fire spuriously the day a table is mapped to an area whose
    --    presets are narrower (settings_billing, say).
    if public.area_level_for('owner', 'owner', null::jsonb, r.area) <> 'edit' then
      raise exception
        'migration 154: "%" is not an area key in area_level_for (policy on public.%). A typo here denies the table to every user in every tenant.',
        r.area, r.tbl;
    end if;

    -- 2. THE POLICY LANDED, AND LANDED RESTRICTIVE, SELECT-ONLY, authenticated-ONLY, on the
    --    intended area. A permissive twin would widen access instead of narrowing it; a role
    --    list containing anon or service_role would break the public designer and every edge
    --    function.
    perform 1
       from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = r.tbl
        and p.policyname = r.tbl || '_area_select'
        and p.permissive = 'RESTRICTIVE'
        and p.cmd        = 'SELECT'
        and p.roles      = '{authenticated}'::name[]
        and p.qual like '%''' || r.area || '''%';
    if not found then
      raise exception
        'migration 154: policy %_area_select on public.% is missing, or is not a RESTRICTIVE authenticated-only SELECT policy on area "%".',
        r.tbl, r.tbl, r.area;
    end if;

    -- 3. THE TENANT POLICY IS STILL THERE. A restrictive policy alone matches nothing: with
    --    no permissive policy left, every authenticated read of this table returns zero rows.
    --    Nothing in this file drops one — this catches the day something else does.
    perform 1
       from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = r.tbl
        and p.permissive = 'PERMISSIVE'
        and p.cmd in ('SELECT', 'ALL')
        and p.roles && '{authenticated,public}'::name[];
    if not found then
      raise exception
        'migration 154: public.% has no permissive SELECT policy for authenticated. Adding a restrictive one now would deny the table outright.',
        r.tbl;
    end if;

    -- 4. FORCE ROW LEVEL SECURITY IS OFF. With FORCE on, RLS also applies to the table
    --    OWNER — which is who the SECURITY DEFINER capability RPCs (load_design,
    --    list_design_versions, get_config) run as. These policies would then reach the
    --    anonymous designer and the customer portal through the back door. It has never been
    --    set on this database; asserted because if it ever is, the blast radius is the public
    --    product rather than a tab.
    if exists (
      select 1
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = r.tbl and c.relforcerowsecurity
    ) then
      raise exception
        'migration 154: public.% has FORCE ROW LEVEL SECURITY on. These policies would then apply to the SECURITY DEFINER capability RPCs and break the public designer. Resolve before applying.',
        r.tbl;
    end if;
  end loop;

  -- 5. THE FOUR PROPERTIES THE WHOLE FILE RESTS ON, checked against the resolver itself.
  --    The same cases access.test.ts pins for the TypeScript — if these ever disagree with
  --    that file, the two copies have drifted and the header's warning has come true.
  if public.area_level_for('owner', 'driver',
       '{"designs":"none","contacts":"none","inventory":"none"}'::jsonb, 'designs') <> 'edit' then
    raise exception 'migration 154: OWNERS ABSOLUTE is broken — a stored map reduced an owner.';
  end if;
  if public.area_level_for('user', 'sales_rep', null::jsonb, 'designs') <> 'edit'
     or public.area_level_for('user', 'sales_rep', null::jsonb, 'inventory') <> 'view'
     or public.area_level_for('user', 'sales_rep', null::jsonb, 'commissions') <> 'own' then
    raise exception 'migration 154: the sales_rep preset does not match _shared/access.ts.';
  end if;
  if public.area_level_for('user', 'sales_rep', '{"contacts":"sideways"}'::jsonb, 'contacts') <> 'edit' then
    raise exception 'migration 154: an invalid stored level blanked a preset instead of being ignored.';
  end if;
  if public.area_level_for('user', 'driver', null::jsonb, 'designs') <> 'none'
     or public.area_level_for('user', 'driver', null::jsonb, 'inventory') <> 'view' then
    raise exception 'migration 154: the driver preset does not match _shared/access.ts.';
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 — VERIFICATION. Run every block. A permission change that returns 200 with the
--          wrong rows looks exactly like one that works.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Pick the fixtures first, as postgres/service_role:
--   select user_id, client_id, role, title, access
--     from public.client_users where client_id = '<TENANT>' order by role, title;
--   select short_code from public.designs where client_id = '<TENANT>' limit 1;
--
-- THE HARNESS. `set local` inside a transaction that is rolled back, so nothing you do here
-- can persist:
--
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<USER_UUID>","role":"authenticated"}';
--     -- (older auth.uid() builds read the flat GUC instead:
--     --  set local "request.jwt.claim.sub" = '<USER_UUID>';)
--     select public.current_area_level('designs')   as designs,
--            public.current_area_level('contacts')  as contacts,
--            public.current_area_level('inventory') as inventory;
--     select (select count(*) from public.designs)         as designs,
--            (select count(*) from public.design_versions) as versions,
--            (select count(*) from public.captured_leads)  as leads,
--            (select count(*) from public.crm_contacts)    as contacts,
--            (select count(*) from public.inventory_units) as units;
--   rollback;
--
-- WHAT EACH ROLE MUST RETURN — set up the left, confirm the right:
--
--   A. OWNER (role='owner'). First store a hostile
--      access = '{"designs":"none","contacts":"none","inventory":"none"}' on their row, to
--      prove it is ignored.
--      -> levels: edit / edit / edit.
--      -> ALL FIVE COUNTS IDENTICAL TO THE PART 0 BASELINE. If an owner's numbers moved,
--         stop and roll back; nothing else in this list matters.
--
--   B. SALES REP (title='sales_rep', access null).
--      -> levels: edit / edit / view.
--      -> all five counts identical to their baseline. `view` is not `none`: 'view', 'edit'
--         and (for commissions) 'own' all admit rows. Only 'none' refuses.
--
--   C. CREW LEADER (title='crew_leader', access null).
--      -> levels: view / none / view.
--      -> designs and versions UNCHANGED; captured_leads = 0 and crm_contacts = 0;
--         inventory_units unchanged. Nothing they can open reads contacts (the Contacts tab
--         gates on the same area), so this must be invisible to them in the app.
--
--   D. DRIVER (title='driver', access null) — THE NAMED DRIVER/ORDERS TEST. This preset loses
--      the most tables of any shipped title, so it is the one that proves the walk.
--      -> levels: none / none / view.
--      -> designs = 0, versions = 0, leads = 0, contacts = 0; inventory_units unchanged.
--      -> ⚠️ THEN OPEN THE REAL PORTAL AS THIS DRIVER — the app, signed in as them, not psql.
--         An empty screen throws no error, and an API-level test passes while a tab is dead.
--         Click every item their nav shows and expect EXACTLY this:
--           ORDERS            the "Coming soon / example data" preview with the five sample
--                             rows (Dale Hostetler, Marcus Webb, …). Seeing sample data IS
--                             the pass: <OrdersPreview /> is what every tenant user mounts
--                             (portal/11-shell.jsx:1098) and it reads no table.
--                             ⛔ STOP if you instead get a REAL Orders table reading "No
--                             orders yet." over $0.00 tiles. That means OrdersView has been
--                             unlocked for tenants since this file was written, the designs
--                             read at 04-orders.jsx:816 is now live for a driver, and
--                             consequence 1's future has arrived. The fix is the gated
--                             portal-settings action named there — it is NOT widening this
--                             policy, and it is NOT granting drivers Designs on the Team
--                             screen. Roll PART 3 back (PART 0's panic button) until it is
--                             in, rather than opening the table to close a blank tab.
--           INVENTORY         the full unit list. portal-settings' `list_inventory` runs on
--                             the service role, and their inventory level is 'view' anyway.
--           DELIVERY SCHEDULE loads, stops and the to-be-loaded pool, all present.
--                             portal/05-schedule.jsx makes zero direct table reads.
--           WHAT'S NEW        release notes and their own submissions, unchanged.
--         Every one of those must look identical to a screenshot taken before PART 3. A
--         driver reaching nothing that reads the five tables is the whole claim, and this is
--         the only place it is checked against the running product instead of the source.
--
--   E. THE FINDING ITSELF (title='sales_rep', access '{"designs":"none","contacts":"none"}').
--      -> levels: none / none / view.
--      -> designs = 0, versions = 0, leads = 0, contacts = 0, units unchanged.
--      -> Before this migration all five were the tenant's full counts. That difference IS
--         audit finding 11. Then re-run it THROUGH PostgREST with that person's real JWT —
--         `sb.from("designs").select("*")` must come back [] — because the browser is where
--         the hole was reported and a psql count does not prove the API.
--
--   F. NO client_users ROW (any signed-in uuid that is not in client_users).
--      -> levels: edit / edit / edit  (DEFAULT-OPEN — this layer adds nothing).
--      -> all five counts = 0, exactly as before this migration: current_client_id() is null,
--         so the tenant policy already denied every row. BOTH halves must hold; the levels
--         are what prove the new policy is not what is denying them.
--
--   G. SERVICE ROLE — every edge function reads this way, so this is the one that must not
--      have moved at all:
--        begin;
--          set local role service_role;
--          select (select count(*) from public.designs)         as designs,
--                 (select count(*) from public.design_versions) as versions,
--                 (select count(*) from public.captured_leads)  as leads,
--                 (select count(*) from public.crm_contacts)    as contacts,
--                 (select count(*) from public.inventory_units) as units;
--        rollback;
--      -> ALL FIVE = the whole table, ACROSS EVERY TENANT, unchanged. The policies name
--         `authenticated` only, and service_role additionally carries BYPASSRLS.
--
--   H. ANON, and the customer-facing capability RPCs — the public designer, the shared
--      estimate link and the customer portal all live or die here:
--        begin;
--          set local role anon;
--          select count(*) from public.designs;                           -- 0 (unchanged: no anon policy)
--          select count(*) from public.inventory_units;                   -- 0 (unchanged)
--          select public.get_config('<TENANT>')  is not null;             -- true
--          select public.get_catalog('<TENANT>') is not null;             -- true
--          select count(*) from public.load_design('<SS-CODE>');          -- 1
--          select count(*) from public.list_design_versions('<SS-CODE>'); -- >= 1
--        rollback;
--      -> The RPCs are SECURITY DEFINER and unaffected by design (consequence 4). If any of
--         them returns 0 rows, something has set FORCE ROW LEVEL SECURITY — roll back at once.
--      -> customer-quotes / customer-accept / customer-auth need no separate test: they hold
--         no Supabase auth session at all (customer_sessions, migration 108) and read with the
--         service role, so G covers them. Still worth one end-to-end click through a real
--         customer quote link before this is called done.
--
--   I. THE WRITE PATHS STILL WRITE (these policies are `for select`, but prove it): submit
--      one real design end to end on an internal tenant. save_design must still upsert
--      `designs`, append to `design_versions`, and stamp designs.contact_id through
--      crm_ensure_contact; capture-lead must still write `captured_leads`.
--
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 6 — ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Behaviour is restored by the five policy drops ALONE (the PART 0 panic button). The
-- functions are inert without them and can be left in place for a retry.
--
--   drop policy if exists designs_area_select         on public.designs;
--   drop policy if exists design_versions_area_select on public.design_versions;
--   drop policy if exists captured_leads_area_select  on public.captured_leads;
--   drop policy if exists crm_contacts_area_select    on public.crm_contacts;
--   drop policy if exists inventory_units_area_select on public.inventory_units;
--
-- Full removal (only after the policies are gone — current_area_level depends on the second):
--
--   drop function if exists public.current_area_level(text);
--   drop function if exists public.area_level_for(text, text, jsonb, text);
