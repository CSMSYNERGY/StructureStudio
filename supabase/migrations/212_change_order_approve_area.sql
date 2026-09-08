-- 212_change_order_approve_area.sql — "Approve Changes": who may unlock a signed order.
--
-- WHY A SECOND AREA AND NOT A THIRD LEVEL. Carolyn, 2026-09-07: "there should be both the
-- option to give approval for a change order, but they can also make the change order if they
-- are given permission." Approving must NOT imply raising, and one person may hold either,
-- both, or neither. The access system is rank-based (_shared/access.ts RANK), so a level that
-- grants one power while withholding a lower one breaks every comparison built on it.
--
-- Two more traps a third level would have walked into, both silent:
--   * area_level_for returns the literal 'edit' for an owner on EVERY area (see below). An
--     area whose top level was 'approve' would leave the owner unable to approve an unlock in
--     their own business, and nothing re-checks the role afterwards — 193's note says so.
--   * 188's restrictive policies test `current_area_level('change_orders') = 'edit'` as a
--     literal. An approver would be refused every change-order write at PostgREST, with no
--     gate table, lint or preflight check standing behind it.
-- With two areas, `edit` stays the top level of both and neither exists.
--
-- WHO HOLDS IT ON DAY ONE. Owners (absolute, below) and admins (preset). NOT sales reps, NOT
-- drivers, and deliberately NOT crew leaders — Carolyn chose "everyone starts at None except
-- owners and admins; you tick Approve for the specific crew leaders you trust". A preset entry
-- for crew_leader would hand this to every existing crew leader in every tenant on their next
-- page load, which is the class of change 188's PART 0 exists to make you look at first.
--
-- ⚠️ MUST LAND IN THE SAME COMMIT as the `AREAS` entry in _shared/access.ts.
-- scripts/preflight.mjs checkAreaMirror() compares the area keys and each area's level
-- vocabulary in BOTH directions and will refuse the push otherwise. That is correct behaviour;
-- do not push past it. It does NOT compare PRESETS to k_presets — the admin entry below is
-- unguarded by tooling, which is why PART 2 asserts it by hand.
--
-- The body is 193_contacts_own_scope.sql's, verbatim, with exactly two edits: one k_areas row
-- and one k_presets entry. Diff it against that file before believing this comment.
--
-- Rollback: re-apply 193's definition of area_level_for unchanged, and drop the AREAS entry
-- from access.ts in the same commit. Any stored {"change_order_approve": ...} deviation then
-- resolves to 'none' on its own — effectiveAccess drops an override whose area it cannot find.

-- ── PART 0 — blast radius. area_level_for is immutable, so this preview is exact. ──────
--   select cu.client_id, cu.role, cu.title,
--          public.area_level_for(cu.role, cu.title, cu.access, 'change_order_approve') as approve
--     from public.client_users cu order by 1, 3;
--   -- 2026-09-07, before applying: every row returns 'none' (the area does not exist yet).
--   -- After applying: owners and admins return 'edit', everyone else still 'none'.

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

-- ── PART 1 — apply-time assertions. These RAISE, aborting the transaction. ─────────────
do $$
begin
  -- The new area resolves, and resolves the way the decision says it should.
  if public.area_level_for('owner','owner', null, 'change_order_approve') <> 'edit' then
    raise exception '212: an OWNER cannot approve an unlock in their own business';
  end if;
  if public.area_level_for('user','admin', null, 'change_order_approve') <> 'edit' then
    raise exception '212: an admin does not hold Approve Changes by preset';
  end if;
  if public.area_level_for('user','crew_leader', null, 'change_order_approve') <> 'none' then
    raise exception '212: a crew leader was handed Approve Changes automatically — that is the one thing this must not do';
  end if;
  if public.area_level_for('user','sales_rep', null, 'change_order_approve') <> 'none' then
    raise exception '212: a sales rep holds Approve Changes by preset';
  end if;
  if public.area_level_for('user','driver', null, 'change_order_approve') <> 'none' then
    raise exception '212: a driver holds Approve Changes by preset';
  end if;

  -- It is GRANTABLE per person, which is the whole delivery mechanism.
  if public.area_level_for('user','crew_leader', '{"change_order_approve":"edit"}'::jsonb,
                           'change_order_approve') <> 'edit' then
    raise exception '212: Approve Changes cannot be granted to a crew leader';
  end if;
  -- ...and a level outside its two-value vocabulary is discarded, not stored through.
  if public.area_level_for('user','crew_leader', '{"change_order_approve":"view"}'::jsonb,
                           'change_order_approve') <> 'none' then
    raise exception '212: an out-of-vocabulary level was accepted for Approve Changes';
  end if;

  -- APPROVING DOES NOT IMPLY RAISING. The point of two areas.
  -- 'none', not 'view': crew_leader's preset carries no change_orders entry at all, and
  -- omission is how a preset denies. (This assertion said 'view' on the first run and failed
  -- the apply — which is the assertion doing its job on its own author.)
  if public.area_level_for('user','crew_leader', '{"change_order_approve":"edit"}'::jsonb,
                           'change_orders') <> 'none' then
    raise exception '212: granting Approve also moved the change_orders level — the two must be independent';
  end if;
  -- ...and raising does not imply approving.
  if public.area_level_for('user','sales_rep', '{"change_orders":"edit"}'::jsonb,
                           'change_order_approve') <> 'none' then
    raise exception '212: granting Raise also granted Approve';
  end if;

  -- NOTHING ELSE MOVED. Every other area must answer exactly as it did before this file.
  if public.area_level_for('user','sales_rep', null, 'change_orders') <> 'none'
     or public.area_level_for('user','sales_rep', null, 'orders') <> 'edit'
     or public.area_level_for('user','crew_leader', null, 'build_schedule') <> 'edit'
     or public.area_level_for('user','driver', null, 'delivery_schedule') <> 'edit'
     or public.area_level_for('user','admin', null, 'settings_billing') <> 'none'
     or public.area_level_for('user','sales_rep', null, 'contacts') <> 'edit'
     or public.area_level_for('user','admin', '{"settings_team":"none"}'::jsonb, 'settings_team') <> 'edit'
  then
    raise exception '212: an existing area changed answer — this file was meant to add one row and nothing else';
  end if;

  -- 188's assertion 7, restated: an acknowledged change order has to be able to write the
  -- order total, so nobody may hold change_orders>=edit without orders=edit.
  if exists (
    select 1 from public.client_users cu
     where public.area_level_for(cu.role, cu.title, cu.access, 'change_orders') = 'edit'
       and public.area_level_for(cu.role, cu.title, cu.access, 'orders') <> 'edit'
  ) then
    raise exception '212: someone holds change_orders=edit without orders=edit';
  end if;
end $$;
