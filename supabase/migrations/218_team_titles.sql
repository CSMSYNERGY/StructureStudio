-- 218_team_titles.sql — five more job titles on the Team screen, and the two hardcoded lists
--                       that would otherwise refuse or silently empty them.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-09-07: "when a team member is added we choose their role, of Owner, Office
-- Staff, Sales Manager, Sales Rep, Dealer, Crew Leader, Crew Member, Scheduler, Driver. Then
-- I want to attribute default access based on the role, but we still keep the override access
-- that is already set."
--
-- Migration 100 shipped five titles. This adds office_staff, sales_manager, dealer, scheduler
-- and crew_member, keeping ADMIN as a tenth. Her nine omit it, and her decision was to KEEP
-- it: admin is the only title that may HOLD a granted Billing switch, and roleForTitle maps
-- it to the coarse role='admin' that older policies read — so retitling every existing admin
-- would have moved real people's access on what looked like a rename.
--
-- The presets themselves live in _shared/access.ts. This file exists because TWO copies of
-- the title list live in the DATABASE, and each fails in its own way:
--
--   PART 1  client_users_title_check — a hardcoded five-value CHECK (100_user_access.sql:53).
--           A title missing here CANNOT BE SAVED: portal-commissions' set_access passes its
--           own TITLES validation, then the UPDATE dies on a constraint violation and the
--           Team screen shows a raw Postgres message. 176_operator_support_only.sql:26-29
--           flagged this exact trap when it chose a column over a new title, and noted that
--           "nothing in the code comments mentions that step". They do now — see TITLES in
--           _shared/access.ts.
--
--   PART 2  area_level_for()'s k_presets AND its normTitle CASE — the SQL twin of
--           effectiveAccess(), which the RESTRICTIVE RLS policies of 154/164/183/193/194 read
--           on ~17 tenant-readable tables. THIS IS THE HALF THAT FAILS SILENTLY. A title
--           absent from the CASE falls through to 'sales_rep'; a title absent from k_presets
--           resolves to 'none' for every area. So a Scheduler would pass every edge-function
--           gate (those read the TypeScript) and then read an EMPTY build board, repairs list
--           and designs list, with `error === null` and nothing logged anywhere. That is
--           154's own stated hazard, and it is why both lists move in this file.
--
-- Both parts are additive. No existing row changes title, no existing preset changes level,
-- and client_users.access — the per-person overrides — is not touched at all: it stores only
-- deviations from a preset, so every override set before today keeps resolving exactly as it
-- did. PART 3 asserts that rather than claiming it.
--
-- ── THE FIVE NEW PRESETS ─────────────────────────────────────────────────────────────────
-- The reasoning for each lives beside it in _shared/access.ts and is not repeated here; the
-- levels below must stay a byte-for-byte statement of the same table.
--
--   office_staff   paperwork: designs/contacts/inventory/orders/change_orders edit, the three
--                  schedule boards + reports view, branding + QuickBooks edit. No designer.
--   sales_manager  a rep plus change orders, reports edit, and EVERYONE'S payouts.
--   dealer         a rep narrowed to contacts:'own' — their own customers only.
--   scheduler      all three boards edit; designs/contacts/inventory/orders view.
--   crew_member    build_schedule + repairs, view only.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   Re-run 100_user_access.sql's constraint block and 212_change_order_approve_area.sql's
--   area_level_for definition (212, NOT 193 — see PART 2). Any client_users row already
--   carrying a new title must be re-titled FIRST, or the old constraint will refuse to
--   validate.
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ── PART 1 ── the CHECK constraint, widened from five titles to ten ──────────────────────
alter table public.client_users
  drop constraint if exists client_users_title_check;

alter table public.client_users
  add constraint client_users_title_check
  check (title is null or title in (
    'owner','admin','office_staff','sales_manager','sales_rep',
    'dealer','scheduler','crew_leader','crew_member','driver'
  ));

comment on column public.client_users.title is
  'Job label + access preset: owner | admin | office_staff | sales_manager | sales_rep | dealer | scheduler | crew_leader | crew_member | driver. See _shared/access.ts for the presets, and client_users_title_check (218) before adding another.';

-- ── PART 2 ── the SQL twin of effectiveAccess() ──────────────────────────────────────────
-- Copied WHOLE from 212_change_order_approve_area.sql:113 — the most recent DEFINITION of
-- this function, which is NOT the highest migration number and NOT the one CLAUDE.md names.
-- k_areas and the resolution logic below are byte-identical to that file. Only two things
-- changed: k_presets gained the five new titles, and the normTitle CASE gained their names.
--
-- ⛔ THIS FILE WAS ALMOST WRITTEN AGAINST 193 INSTEAD, AND THAT WOULD HAVE SHIPPED A SILENT
--    REVERT. CLAUDE.md and 194's header both point at 193_contacts_own_scope.sql:131 as the
--    current definition; 212 superseded it on 2026-09-07 by adding the `change_order_approve`
--    area, hours before this migration was written, and neither document had caught up. A
--    `create or replace` built on 193 would have dropped that area straight back out of
--    k_areas — where an unknown area returns 'none' rather than raising — quietly un-gating
--    nothing and re-gating nothing visible, until the next person wondered why approving a
--    change order behaved differently in RLS than in the edge functions.
--
--    So: DO NOT trust a written pointer to "the current definition". Derive it —
--      for f in supabase/migrations/*.sql; do grep -l 'create or replace function public.area_level_for' "$f"; done
--    — and cross-check against what is actually deployed:
--      select pg_get_functiondef('public.area_level_for(text,text,jsonb,text)'::regprocedure);
--    PART 3 asserts change_order_approve survived, so this particular revert cannot ship
--    again silently even if the next author repeats the mistake.
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
  -- row: commissions, contacts and now change_order_approve are deliberately not the
  -- universal none/view/edit triplet, which is why the level check below reads the array
  -- instead of assuming three.
  --
  -- `internalOnly` is NOT mirrored, on purpose. It governs which switches accessMetadata()
  -- ships to a browser — a presentation rule with no bearing on how a stored map resolves —
  -- and mirroring it here would invite a future reader to treat it as the tenancy check,
  -- which it is not.
  k_areas constant jsonb := $j$
  {
    "designer":              {"levels": ["none","view","edit"]},
    "designs":               {"levels": ["none","view","edit"]},
    "contacts":              {"levels": ["none","own","view","edit"]},
    "inventory":             {"levels": ["none","view","edit"]},
    "orders":                {"levels": ["none","view","edit"]},
    "change_orders":         {"levels": ["none","view","edit"]},
    "change_order_approve":  {"levels": ["none","edit"]},
    "build_schedule":        {"levels": ["none","view","edit"]},
    "delivery_schedule":     {"levels": ["none","view","edit"]},
    "repairs":               {"levels": ["none","view","edit"]},
    "commissions":           {"levels": ["none","own","edit"]},
    "reports":               {"levels": ["none","view","edit"]},
    "projects":              {"levels": ["none","view","edit"]},
    "settings_structures":   {"levels": ["none","view","edit"]},
    "settings_options":      {"levels": ["none","view","edit"]},
    "settings_branding":     {"levels": ["none","view","edit"]},
    "settings_crm":          {"levels": ["none","view","edit"]},
    "settings_quickbooks":   {"levels": ["none","view","edit"]},
    "settings_email":        {"levels": ["none","view","edit"]},
    "settings_team":         {"levels": ["none","view","edit"], "byTitleOnly": true},
    "settings_billing":      {"levels": ["none","view","edit"], "ownerGranted": true}
  }
  $j$::jsonb;

  -- ── PRESETS ── mirror of `PRESETS`. A title's default switches; anything a preset OMITS
  -- resolves to 'none', which is what makes tomorrow's new area safe to add.
  --
  -- ⚠️ ONE ENTRY CHANGED BY THIS MIGRATION: admin gains change_order_approve. sales_rep,
  -- crew_leader and driver OMIT it and therefore deny it. Nobody is narrowed by applying this
  -- file.
  k_presets constant jsonb := $j$
  {
    "owner": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "change_orders":"edit","change_order_approve":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","projects":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"edit"
    },
    "admin": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "change_orders":"edit","change_order_approve":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"none"
    },
    "sales_rep": {
      "designer":"edit","designs":"edit","contacts":"edit",
      "inventory":"view","orders":"edit","commissions":"own"
    },
    "office_staff": {
      "designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "change_orders":"edit",
      "build_schedule":"view","delivery_schedule":"view","repairs":"view","reports":"view",
      "settings_branding":"edit","settings_quickbooks":"edit"
    },
    "sales_manager": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"view",
      "orders":"edit","change_orders":"edit","commissions":"edit","reports":"edit"
    },
    "dealer": {
      "designer":"edit","designs":"edit","contacts":"own",
      "inventory":"view","orders":"edit","commissions":"own"
    },
    "scheduler": {
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit",
      "designs":"view","contacts":"view","inventory":"view","orders":"view"
    },
    "crew_leader": {
      "build_schedule":"edit","repairs":"edit",
      "designs":"view","inventory":"view","orders":"view"
    },
    "crew_member": {
      "build_schedule":"view","repairs":"view"
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
  --
  -- ⚠️ THIS LINE IS WHY NOTHING BELOW RE-CHECKS THE ROLE. crm_contact_scope() asks this
  -- function for the contacts level and compares it to 'own'; an owner can never produce
  -- that string, so owners are absolute in the RLS layer for free — by construction rather
  -- than by a second test somebody could forget to copy into the next policy.
  --
  -- It also returns the literal 'edit', which is exactly why change_order_approve is a
  -- two-level area topping out at 'edit' and not a third level named 'approve' — see the
  -- header.
  if p_role = 'owner' then
    return 'edit';
  end if;

  -- normTitle(): anything that is not one of the TEN known titles is a sales_rep.
  v_title := case
               when p_title in ('owner','admin','office_staff','sales_manager','sales_rep',
                               'dealer','scheduler','crew_leader','crew_member','driver')
                 then p_title
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
  'Pure mirror of effectiveAccess() in supabase/functions/_shared/access.ts: the title preset merged with the stored per-area deviations, owners absolute. MUST be changed in the same commit as that file — scripts/preflight.mjs cross-checks the two AREA lists and the two TITLE lists on every push (migration 218 added office_staff, sales_manager, dealer, scheduler, crew_member). Reads no tables, so it is safe to call for preview/audit.';

revoke execute on function public.area_level_for(text, text, jsonb, text) from public, anon;
grant  execute on function public.area_level_for(text, text, jsonb, text) to authenticated, service_role;

-- ── PART 3 ── assertions ─────────────────────────────────────────────────────────────────
-- Worth having only if a failure takes PARTS 1-2 with it, which is what the surrounding
-- transaction is for. Every one of these is a claim the header makes; a raise here means the
-- header is lying.
do $assert$
begin
  -- The five new presets resolve to what access.ts says they do.
  if public.area_level_for('user','office_staff','{}'::jsonb,'orders')            <> 'edit' then raise exception 'office_staff orders'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'settings_branding') <> 'edit' then raise exception 'office_staff branding'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'designer')          <> 'none' then raise exception 'office_staff designer'; end if;
  if public.area_level_for('user','sales_manager','{}'::jsonb,'commissions')      <> 'edit' then raise exception 'sales_manager commissions'; end if;
  if public.area_level_for('user','dealer','{}'::jsonb,'contacts')                <> 'own'  then raise exception 'dealer contacts'; end if;
  if public.area_level_for('user','scheduler','{}'::jsonb,'delivery_schedule')    <> 'edit' then raise exception 'scheduler delivery'; end if;
  if public.area_level_for('user','crew_member','{}'::jsonb,'build_schedule')     <> 'view' then raise exception 'crew_member build'; end if;
  if public.area_level_for('user','crew_member','{}'::jsonb,'orders')             <> 'none' then raise exception 'crew_member orders'; end if;

  -- THE OVERRIDES STILL WIN. This is the half of Carolyn's request that must not regress: a
  -- stored deviation layers on top of the new presets exactly as it did on the old ones.
  if public.area_level_for('user','dealer','{"contacts":"edit"}'::jsonb,'contacts')  <> 'edit' then raise exception 'dealer override'; end if;
  if public.area_level_for('user','crew_member','{"orders":"view"}'::jsonb,'orders') <> 'view' then raise exception 'crew_member override'; end if;
  -- ...and the two skips still apply to them: Team is by-title, Billing is admin-only.
  if public.area_level_for('user','scheduler','{"settings_team":"edit"}'::jsonb,'settings_team')          <> 'none' then raise exception 'scheduler team override'; end if;
  if public.area_level_for('user','office_staff','{"settings_billing":"edit"}'::jsonb,'settings_billing') <> 'none' then raise exception 'office_staff billing override'; end if;

  -- 212's AREA SURVIVED THIS create-or-replace. See the PART 2 header: this file was nearly
  -- built on 193, which predates change_order_approve, and the revert would have been silent
  -- because an unknown area returns 'none' instead of raising.
  if public.area_level_for('admin','admin','{}'::jsonb,'change_order_approve')     <> 'edit' then raise exception 'change_order_approve lost from admin preset'; end if;
  if public.area_level_for('user','crew_leader','{}'::jsonb,'change_order_approve') <> 'none' then raise exception 'change_order_approve default'; end if;
  if public.area_level_for('user','crew_leader','{"change_order_approve":"edit"}'::jsonb,'change_order_approve') <> 'edit' then raise exception 'change_order_approve area lost from k_areas'; end if;

  -- NOTHING THAT ALREADY WORKED MOVED.
  if public.area_level_for('owner','owner','{}'::jsonb,'settings_billing')  <> 'edit' then raise exception 'owner regression'; end if;
  if public.area_level_for('admin','admin','{}'::jsonb,'settings_billing')  <> 'none' then raise exception 'admin regression'; end if;
  if public.area_level_for('admin','admin','{"settings_billing":"edit"}'::jsonb,'settings_billing') <> 'edit' then raise exception 'admin grant regression'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'commissions')    <> 'own'  then raise exception 'sales_rep regression'; end if;
  if public.area_level_for('user','crew_leader','{}'::jsonb,'repairs')      <> 'edit' then raise exception 'crew_leader regression'; end if;
  if public.area_level_for('user','driver','{}'::jsonb,'delivery_schedule') <> 'edit' then raise exception 'driver regression'; end if;
  -- An unknown title is still a sales_rep, and an unknown area is still 'none'.
  if public.area_level_for('user','nonsense','{}'::jsonb,'commissions')     <> 'own'  then raise exception 'normTitle fallback'; end if;
  if public.area_level_for('user','scheduler','{}'::jsonb,'no_such_area')   <> 'none' then raise exception 'unknown area'; end if;
end
$assert$;

-- PART 1 really did widen: every title in TITLES must be storable. Kept out of the block
-- above because it reads the catalog rather than calling the function.
do $assert$
declare
  v_def text := pg_catalog.pg_get_constraintdef(
    (select oid from pg_catalog.pg_constraint where conname = 'client_users_title_check'));
  v_title text;
begin
  foreach v_title in array array['owner','admin','office_staff','sales_manager','sales_rep',
                                 'dealer','scheduler','crew_leader','crew_member','driver']
  loop
    if position('''' || v_title || '''' in v_def) = 0 then
      raise exception 'client_users_title_check does not accept %', v_title;
    end if;
  end loop;
end
$assert$;

commit;
