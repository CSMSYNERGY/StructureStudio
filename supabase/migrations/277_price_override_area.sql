-- 277_price_override_area.sql — "Override prices": who may change a line's price in the Designer,
-- and (PART 3) who may WRITE one into a saved design.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, BEFORE the frontend that sends prices. Pipe this file
--    to `supabase db query --linked` (stdin; see 270's header for why not `--file` or an inline
--    "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('277', '277_price_override_area') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- A builder's request (filed from the portal 2026-09-21 as "Would really help"): a
-- sales person with the right permission changes the charge on any line right in the Designer — up
-- for an extra-large rough opening, down to close a sale — and the customer's quote shows the new
-- number as that line's price, never as a visible "Custom" fee or "Discount". The field pre-fills
-- with the list price and is editable only for people logged in at that permission level.
--
-- The money is enforced in submit-estimate (it honours a price only from someone holding this area,
-- and strips and logs it from anyone else — _shared/priceOverride.ts). This file is the SQL half of
-- the permission itself: area_level_for() is the twin of effectiveAccess() in
-- supabase/functions/_shared/access.ts, and the two must agree on every area.
--
-- ── WHO HOLDS IT ON DAY ONE ──────────────────────────────────────────────────────────────
-- Owners (absolute — area_level_for short-circuits them) and admins (preset). NOBODY ELSE: no sales
-- rep, sales manager, office staffer, dealer, scheduler, crew leader, crew member or driver. An
-- owner or admin ticks it on for the specific people they trust in Settings → Team. There is no
-- floor on a lowered price. Both are the safe default while Carolyn decides who should have it and
-- whether a price may go below some share of list; neither answer needs this file again unless a
-- preset changes (a floor is one clamp in priceOverride.ts).
--
-- Two levels, none | edit, like change_order_approve (212): there is nothing to "view" — a person
-- may type a price or may not — and `edit` stays the top level, which is the literal an owner
-- resolves to.
--
-- ── THE EDIT ─────────────────────────────────────────────────────────────────────────────
-- 254_sss_phone.sql's area_level_for, copied WHOLE (254 is the newest definition; on 2026-10-05 its
-- body was compared with pg_get_functiondef on the live project and is identical apart from line
-- endings). Derive it again before the next re-issue; do not trust this line:
--   grep -l 'create or replace function public.area_level_for' supabase/migrations/*.sql
-- Exactly three data lines are added and nothing else in the body moves, comments included:
--   k_areas            "price_override": {"levels": ["none","edit"]}
--   k_presets.admin    "price_override":"edit"
--   k_presets.owner    "price_override":"edit"   (owners short-circuit before the preset is read;
--                       the cell is there because access.ts's PRESETS.owner names every area and
--                       access.test.ts compares the two tables cell by cell)
-- MUST LAND IN THE SAME COMMIT as the AREAS/PRESETS change in _shared/access.ts. preflight's
-- checkAreaMirror compares area keys and level vocabularies; access.test.ts compares every preset
-- cell; PART 2 below asserts the new area and re-asserts the old cells, because this is a
-- whole-function replace and a lost cell would otherwise ship silently.
--
-- One function READS this area: save_design, after PART 3 (below). No RLS policy does. The other
-- consumers are the edge functions (submit-estimate decides; portal-settings ships the Team grid
-- and saves grants). Applying this file changes no query result anywhere except area_level_for's
-- own answer for 'price_override' and what save_design stores under selections.priceOverrides.
--
-- ── PART 3: WHO MAY WRITE A PRICE INTO A SAVED DESIGN ────────────────────────────────────
-- The prices live in designs.selections.priceOverrides, and save_design (granted to anon since 104)
-- overwrites `selections` for anyone holding the design's short code. submit-estimate checks WHO
-- submits, not who wrote the numbers, and the designer sends whatever applies from the stored map.
-- So without PART 3 a shopper could call save_design with their own share code and a $1 building,
-- and the next time an owner opened the lead, added a window and pressed Submit, the quote would go
-- out at $1 under the owner's session: a field pre-filled with a price that looks exactly like one a
-- colleague set, nothing on the quote to say so, and no record of who typed it.
--
-- PART 3 closes it in the one place every save passes: save_design keeps selections.priceOverrides
-- exactly as STORED for any caller who does not hold price_override on that tenant (the anon share
-- link, a member without the grant, a read-only operator account), whatever they send. A holder (or
-- an operator who may write) sets and clears them as before. With the key on neither side, the
-- save is untouched, byte for byte. design_versions snapshots the saved row, so versions are
-- covered too. A SPLICE of the live definition (197/220/240/241's discipline), not a new body.
--
-- PART 0's second query counts the designs and versions that already carry the key. It must be 0
-- before this ships (the designer never wrote one before 277); anything else was planted, and is
-- cleared by hand after a human has looked at it.
--
-- ── PART 0 — blast radius. area_level_for is immutable, so this preview is exact. ───────
--   select cu.client_id, cu.role, cu.title,
--          public.area_level_for(cu.role, cu.title, cu.access, 'price_override') as price_override
--     from public.client_users cu order by 1, 3;
--   -- Before applying: every row 'none' (the area does not exist; unknown area -> 'none').
--   -- After: owners and admins 'edit', everyone else 'none'. Nobody holds a stored
--   --        {"price_override": ...} key yet.
--   -- 2026-10-05, read-only, counts only: 14 client_users rows — 11 owners (7 with no title,
--   -- 4 titled owner), 1 'user' with no title (resolves as a sales rep) and 2 sales reps; no
--   -- admins; 0 rows store a price_override key. So applying this gives the 11 owners 'edit' and
--   -- the 3 others stay 'none'.
--
--   select (select count(*) from public.designs
--            where jsonb_typeof(selections) = 'object' and selections ? 'priceOverrides') as designs,
--          (select count(*) from public.design_versions
--            where jsonb_typeof(selections) = 'object' and selections ? 'priceOverrides') as versions;
--   -- Must be 0 and 0 (see PART 3). 2026-10-05, read-only: 0 and 0. Also read then: exactly one
--   -- public.save_design, carrying 241's marker, and the only function in public that writes
--   -- designs.selections. 4 app_operators rows, 1 of them read-only (can_write false).
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- 1. PART 3 first: run its splice block alone with c_reverse set to true. It puts save_design back
--    exactly as it was (the same exactly-once, byte-identity and grant checks). Stored prices stay
--    in selections and simply stop being guarded.
-- 2. Re-apply 254's area_level_for unchanged (the function only, not the rest of 254), and drop the
--    AREAS/PRESETS entries from access.ts in the same commit. A stored {"price_override": ...} then
--    resolves to 'none' on its own: both resolvers ignore an area they cannot find. submit-estimate
--    needs no rollback of its own — with the area gone, canEdit() says no for every non-operator, so
--    every override is stripped and the quote goes out at list price, which is today's behaviour.
-- (Done the other way round, step 2 alone leaves save_design asking for an area nobody holds: only
-- an operator who may write could store a price. Safe, just not what anyone wants for long.)
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — area_level_for(), re-issued with the `price_override` area
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
  -- row: commissions, contacts, phone and change_order_approve are deliberately not the
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
    "price_override":        {"levels": ["none","edit"]},
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
    "phone":                 {"levels": ["none","own","view","edit"]},
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
  -- ⚠️ THE CELLS 254 ADDED: phone. owner and admin edit; office_staff and sales_manager view;
  -- sales_rep and dealer own. scheduler, crew_leader, crew_member and driver OMIT it and
  -- therefore deny it. No other cell moved.
  k_presets constant jsonb := $j$
  {
    "owner": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "price_override":"edit",
      "change_orders":"edit","change_order_approve":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","phone":"edit","projects":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"edit"
    },
    "admin": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "price_override":"edit",
      "change_orders":"edit","change_order_approve":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","phone":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"none"
    },
    "sales_rep": {
      "designer":"edit","designs":"edit","contacts":"edit","phone":"own",
      "inventory":"view","orders":"edit","commissions":"own"
    },
    "office_staff": {
      "designer":"edit",
      "designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "change_orders":"edit",
      "build_schedule":"view","delivery_schedule":"view","repairs":"view","reports":"view",
      "phone":"view",
      "settings_branding":"edit","settings_quickbooks":"edit"
    },
    "sales_manager": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"view",
      "orders":"edit","change_orders":"edit","commissions":"edit","reports":"edit",
      "phone":"view"
    },
    "dealer": {
      "designer":"edit","designs":"edit","contacts":"own",
      "inventory":"view","orders":"edit","commissions":"own","phone":"own"
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
  'Pure mirror of effectiveAccess() in supabase/functions/_shared/access.ts: the title preset merged with the stored per-area deviations, owners absolute. MUST be changed in the same commit as that file — scripts/preflight.mjs cross-checks the AREA and TITLE lists on every push, and access.test.ts compares every preset LEVEL cell against this function''s literals. Migration 254 added the phone area; 277 added price_override (owners and admins). Reads no tables, so it is safe to call for preview/audit.';

revoke execute on function public.area_level_for(text, text, jsonb, text) from public, anon;
grant  execute on function public.area_level_for(text, text, jsonb, text) to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — apply-time assertions. These RAISE, aborting the whole transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_title text;
begin
  -- ── The new area, the way the decision says it resolves. ──
  if public.area_level_for('owner','owner', null, 'price_override') <> 'edit' then
    raise exception '277: an OWNER cannot override prices in their own business';
  end if;
  if public.area_level_for('owner', null, null, 'price_override') <> 'edit' then
    raise exception '277: an owner with no title cannot override prices';
  end if;
  if public.area_level_for('owner','driver','{"price_override":"none"}'::jsonb, 'price_override') <> 'edit' then
    raise exception '277: a stored map reduced an owner';
  end if;
  if public.area_level_for('admin','admin', null, 'price_override') <> 'edit' then
    raise exception '277: an admin does not hold Override prices by preset';
  end if;
  if public.area_level_for('user','admin', null, 'price_override') <> 'edit' then
    raise exception '277: the admin TITLE does not carry Override prices';
  end if;

  -- Denied by default to every other title, a NULL title and a title nobody has heard of — the
  -- one thing this must not do is hand every rep the power to re-price a quote on the day it ships.
  foreach v_title in array array['office_staff','sales_manager','sales_rep','dealer','scheduler',
                                 'crew_leader','crew_member','driver','nonsense'] loop
    if public.area_level_for('user', v_title, null, 'price_override') <> 'none' then
      raise exception '277: % holds Override prices by preset', v_title;
    end if;
  end loop;
  if public.area_level_for('user', null, null, 'price_override') <> 'none' then
    raise exception '277: a NULL title (a sales rep) holds Override prices by preset';
  end if;

  -- It is GRANTABLE per person, which is the whole delivery mechanism...
  if public.area_level_for('user','sales_rep','{"price_override":"edit"}'::jsonb, 'price_override') <> 'edit' then
    raise exception '277: Override prices cannot be granted to a sales rep';
  end if;
  -- ...an owner can take it from an admin...
  if public.area_level_for('admin','admin','{"price_override":"none"}'::jsonb, 'price_override') <> 'none' then
    raise exception '277: Override prices cannot be taken from an admin';
  end if;
  -- ...and a level outside its two-value vocabulary is discarded, not stored through.
  if public.area_level_for('user','sales_rep','{"price_override":"view"}'::jsonb, 'price_override') <> 'none' then
    raise exception '277: an out-of-vocabulary level was accepted for Override prices';
  end if;
  -- Granting it moves nothing else.
  if public.area_level_for('user','sales_rep','{"price_override":"edit"}'::jsonb, 'designer') <> 'edit'
     or public.area_level_for('user','sales_rep','{"price_override":"edit"}'::jsonb, 'change_orders') <> 'none'
     or public.area_level_for('user','sales_rep','{"price_override":"edit"}'::jsonb, 'settings_options') <> 'none'
  then
    raise exception '277: granting Override prices moved another area';
  end if;

  -- ── NOTHING ELSE MOVED. 254's cells, re-asserted: this is a whole-function replace. ──
  if public.area_level_for('admin','admin','{}'::jsonb,'phone')                   <> 'edit' then raise exception '277: admin phone'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'phone')             <> 'view' then raise exception '277: office_staff phone'; end if;
  if public.area_level_for('user','sales_manager','{}'::jsonb,'phone')            <> 'view' then raise exception '277: sales_manager phone'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'phone')                <> 'own'  then raise exception '277: sales_rep phone'; end if;
  if public.area_level_for('user','dealer','{}'::jsonb,'phone')                   <> 'own'  then raise exception '277: dealer phone'; end if;
  if public.area_level_for('user','driver','{}'::jsonb,'phone')                   <> 'none' then raise exception '277: driver phone'; end if;
  if public.area_level_for('user','crew_leader','{"phone":"own"}'::jsonb,'phone') <> 'own'  then raise exception '277: phone grant'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'designer')            <> 'edit' then raise exception '277: office_staff designer'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'orders')              <> 'edit' then raise exception '277: office_staff orders'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'change_orders')       <> 'edit' then raise exception '277: office_staff change_orders'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'settings_branding')   <> 'edit' then raise exception '277: office_staff branding'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'settings_quickbooks') <> 'edit' then raise exception '277: office_staff quickbooks'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'build_schedule')      <> 'view' then raise exception '277: office_staff build_schedule'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'commissions')         <> 'none' then raise exception '277: office_staff commissions'; end if;
  if public.area_level_for('owner','owner','{}'::jsonb,'settings_billing')            <> 'edit' then raise exception '277: owner regression'; end if;
  if public.area_level_for('admin','admin','{}'::jsonb,'settings_billing')            <> 'none' then raise exception '277: admin billing regression'; end if;
  if public.area_level_for('admin','admin','{"settings_billing":"edit"}'::jsonb,'settings_billing') <> 'edit' then raise exception '277: admin billing grant regression'; end if;
  if public.area_level_for('user','sales_rep','{"settings_billing":"edit"}'::jsonb,'settings_billing') <> 'none' then raise exception '277: billing granted to a non-admin'; end if;
  if public.area_level_for('user','admin','{"settings_team":"none"}'::jsonb,'settings_team') <> 'edit' then raise exception '277: settings_team became grantable'; end if;
  if public.area_level_for('admin','admin','{}'::jsonb,'change_order_approve')        <> 'edit' then raise exception '277: change_order_approve lost'; end if;
  if public.area_level_for('user','crew_leader','{}'::jsonb,'change_order_approve')   <> 'none' then raise exception '277: change_order_approve leaked to a preset'; end if;
  if public.area_level_for('user','crew_leader','{"change_order_approve":"edit"}'::jsonb,'change_order_approve') <> 'edit' then raise exception '277: change_order_approve area lost from k_areas'; end if;
  if public.area_level_for('user','sales_manager','{}'::jsonb,'commissions')          <> 'edit' then raise exception '277: sales_manager regression'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'commissions')              <> 'own'  then raise exception '277: sales_rep regression'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'orders')                   <> 'edit' then raise exception '277: sales_rep orders regression'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'designer')                 <> 'edit' then raise exception '277: sales_rep designer regression'; end if;
  if public.area_level_for('user','dealer','{}'::jsonb,'contacts')                    <> 'own'  then raise exception '277: dealer regression'; end if;
  if public.area_level_for('user','dealer','{}'::jsonb,'designer')                    <> 'edit' then raise exception '277: dealer designer regression'; end if;
  if public.area_level_for('user','scheduler','{}'::jsonb,'delivery_schedule')        <> 'edit' then raise exception '277: scheduler regression'; end if;
  if public.area_level_for('user','scheduler','{}'::jsonb,'designer')                 <> 'none' then raise exception '277: scheduler gained designer'; end if;
  if public.area_level_for('user','crew_leader','{}'::jsonb,'repairs')                <> 'edit' then raise exception '277: crew_leader regression'; end if;
  if public.area_level_for('user','crew_member','{}'::jsonb,'build_schedule')         <> 'view' then raise exception '277: crew_member regression'; end if;
  if public.area_level_for('user','driver','{}'::jsonb,'delivery_schedule')           <> 'edit' then raise exception '277: driver regression'; end if;
  if public.area_level_for('user','nonsense','{}'::jsonb,'commissions')               <> 'own'  then raise exception '277: normTitle fallback'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'no_such_area')          <> 'none' then raise exception '277: unknown area'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'projects')                 <> 'none' then raise exception '277: projects leaked to a preset'; end if;
  if public.area_level_for('owner','owner','{}'::jsonb,'projects')                    <> 'edit' then raise exception '277: owner projects'; end if;

  -- ── The grant posture, unchanged: authenticated and service_role only. ──
  if has_function_privilege('anon', 'public.area_level_for(text, text, jsonb, text)', 'EXECUTE') then
    raise exception '277: anon can execute area_level_for';
  end if;
  if not has_function_privilege('authenticated', 'public.area_level_for(text, text, jsonb, text)', 'EXECUTE') then
    raise exception '277: authenticated lost area_level_for (the RLS policies call it as the signed-in user)';
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — save_design: a line's own price is written only by someone holding the area (a splice)
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Why, in the header. save_design has been re-issued on live many times and no repo file is proof
-- of what runs, so this reads the LIVE definition, requires 241, refuses unless its one anchor
-- occurs exactly once, re-issues, RE-READS LIVE, and checks the grants, SECURITY DEFINER and
-- search_path did not move. Idempotent: a second run sees its marker and does nothing. AFTER
-- PART 1 on purpose: the guard asks area_level_for about 'price_override', which must exist first.
--
-- The anchor is the line that opens the upsert, so the guard runs after every refusal above it (the
-- code, the status whitelist, the client, the inventory, signed-order and contact locks) and just
-- before the row is written. It only ever reassigns p_selections.
--
-- WHO HOLDS IT is the answer submit-estimate gives: a member of THIS tenant (p_client_id, which the
-- function has already proved owns an existing design) whose area_level_for(…,'price_override') is
-- 'edit', or a platform operator who may write. save_design is SECURITY DEFINER, so the anon revoke
-- on area_level_for does not reach in here.
--
-- ROLLBACK: run this block alone with c_reverse set to true (see the header's ROLLBACK).
do $splice$
declare
  -- ROLLBACK SWITCH. true undoes exactly this replacement (new → old). Leave false to apply.
  c_reverse    constant boolean := false;
  c_marker     constant text := '277: a line''s own price';
  v_oid        oid;
  v_n          int;
  v_def        text;
  v_new        text;
  v_back       text;
  v_acl_before text;
  v_cfg_before text;
  c_old        text;
  c_new        text;
  v_from       text;
  v_to         text;
begin
  -- Dollar-quoted so the texts need no quote doubling. CRs are stripped below, so a CRLF checkout
  -- of this file can neither put \r into the live function nor miss the anchor.
  c_old := $o1$
  insert into public.designs as d
$o1$;
  c_new := $n1$
  -- 277: a line's own price is written only by someone holding "Override prices". submit-estimate
  -- honours the stored prices for whoever submits next, and this RPC is the share link's too, so
  -- anyone else (anon, a member without the area, a read-only operator) keeps exactly the prices the
  -- row already has, whatever they send. With the key on neither side p_selections is untouched.
  if (jsonb_typeof(p_selections) = 'object' and p_selections ? 'priceOverrides')
     or exists (select 1 from public.designs d6 where d6.short_code = p_code
                 and jsonb_typeof(d6.selections) = 'object' and d6.selections ? 'priceOverrides') then
    if auth.uid() is null or not (
         exists (select 1 from public.app_operators op where op.user_id = auth.uid() and op.can_write)
      or exists (select 1 from public.client_users cu
                  where cu.user_id = auth.uid() and cu.client_id = p_client_id
                    and public.area_level_for(cu.role, cu.title, cu.access, 'price_override') = 'edit')) then
      p_selections := (case when jsonb_typeof(p_selections) = 'object' then p_selections else '{}'::jsonb end
                         - 'priceOverrides')
        || coalesce((select jsonb_build_object('priceOverrides', d6.selections->'priceOverrides')
                       from public.designs d6
                      where d6.short_code = p_code
                        and jsonb_typeof(d6.selections) = 'object' and d6.selections ? 'priceOverrides'), '{}'::jsonb);
    end if;
  end if;

  insert into public.designs as d
$n1$;
  c_old := replace(c_old, E'\r', '');
  c_new := replace(c_new, E'\r', '');

  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_design';
  if v_n <> 1 then
    raise exception '277: expected exactly one public.save_design, found % -- resolve the overload by hand', v_n;
  end if;
  select p.oid, p.proacl::text, p.proconfig::text into v_oid, v_acl_before, v_cfg_before
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_design';

  v_def := pg_get_functiondef(v_oid);

  if (position(c_marker in v_def) > 0) <> c_reverse then
    if c_reverse then
      raise notice '277 rollback: live save_design does not carry 277 -- nothing to undo';
    else
      raise notice '277: live save_design already guards a line''s own price -- nothing to do';
    end if;
    return;
  end if;

  -- 241 must be live: this was written against its text, and its anchor sits under 241's insert.
  if position('241: born a draft.' in v_def) = 0 then
    raise exception '277: live save_design does not carry 241 -- live has drifted, splice by hand';
  end if;

  if c_reverse then v_from := c_new; v_to := c_old; else v_from := c_old; v_to := c_new; end if;

  v_n := (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from);
  if v_n <> 1 then
    raise exception '277: expected exactly 1 of the anchor in the live save_design, found % -- splice by hand: %',
      v_n, btrim(v_from);
  end if;
  v_new := replace(v_def, v_from, v_to);
  v_n := (length(v_new) - length(replace(v_new, v_to, ''))) / length(v_to);
  if v_n <> 1 then
    raise exception '277: the replacement landed % times, expected once', v_n;
  end if;

  -- BYTE IDENTITY. Undo the replacement; anything else that changed would survive the undo and fail
  -- this compare. Checked BEFORE the re-issue.
  v_back := replace(v_new, v_to, v_from);
  if v_back is distinct from v_def then
    raise exception '277: undoing the splice does not reproduce the live definition -- refusing';
  end if;

  execute v_new;

  -- RE-READ LIVE. CREATE OR REPLACE keeps the oid, so this reads what now runs.
  if pg_get_functiondef(v_oid) is distinct from v_new then
    raise exception '277: live save_design is not the text this splice issued';
  end if;
  if (select p.proacl::text from pg_proc p where p.oid = v_oid) is distinct from v_acl_before then
    raise exception '277: save_design''s grants moved (was %)', v_acl_before;
  end if;
  if (select p.proconfig::text from pg_proc p where p.oid = v_oid) is distinct from v_cfg_before then
    raise exception '277: save_design''s search_path setting moved (was %)', v_cfg_before;
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = v_oid) then
    raise exception '277: save_design is no longer SECURITY DEFINER';
  end if;
  if not c_reverse and position($x$public.area_level_for(cu.role, cu.title, cu.access, 'price_override') = 'edit'$x$
                                in pg_get_functiondef(v_oid)) = 0 then
    raise exception '277: live save_design does not ask area_level_for about price_override';
  end if;
  if c_reverse then
    raise notice '277 rollback: live save_design stores selections.priceOverrides from any caller again';
  else
    raise notice '277: live save_design keeps a line''s own price away from anyone without Override prices';
  end if;
end
$splice$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — the probe: the saves that matter, as the role that makes them. Rolled back.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 proves the text is there; only this proves the saves behave. Two throwaway codes on the
-- first tenant (by id) with a member who holds the area (every owner does). Nothing it writes
-- survives: the block ends by raising, which rolls back everything inside it.
do $probe$
declare
  cid   text;
  uid   uuid;
  nid   uuid;   -- a member of the same tenant WITHOUT the area, when it has one
  c1    text := 'SS-PRC277NEW';
  c2    text := 'SS-PRC277SET';
  mine  jsonb := '{"building": {"amount": "8500", "was": 9000}}'::jsonb;
  bad   jsonb := '{"building": {"amount": "1", "was": 9000}}'::jsonb;
  got   public.designs;
begin
  if position('277: a line''s own price' in pg_get_functiondef('public.save_design'::regproc)) = 0 then
    raise notice '277: live save_design does not carry 277 -- probe skipped';
    return;
  end if;
  select cu.client_id, cu.user_id into cid, uid
    from public.client_users cu join public.client_configs cc on cc.client_id = cu.client_id
   where public.area_level_for(cu.role, cu.title, cu.access, 'price_override') = 'edit'
   order by cu.client_id, cu.user_id
   limit 1;
  if cid is null or exists (select 1 from public.designs dd where dd.short_code in (c1, c2)) then
    raise notice '277: no tenant with a member holding the area, or a probe code already exists -- probe skipped';
    return;
  end if;
  select cu.user_id into nid
    from public.client_users cu
   where cu.client_id = cid
     and public.area_level_for(cu.role, cu.title, cu.access, 'price_override') <> 'edit'
     and not exists (select 1 from public.app_operators op where op.user_id = cu.user_id and op.can_write)
   order by cu.user_id
   limit 1;

  begin
    -- 1. ANON plants a price on a brand-new design: stored with none, the rest of selections kept,
    --    and the version row is clean too.
    execute 'set local role anon';
    got := public.save_design(c1, cid, '{}'::jsonb, jsonb_build_object('style', 'probe', 'priceOverrides', bad),
      '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    execute 'reset role';
    if got.selections ? 'priceOverrides' or got.selections->>'style' is distinct from 'probe' then
      raise exception '277 probe: AN ANONYMOUS SAVE STORED A PRICE (%)', got.selections;
    end if;
    if exists (select 1 from public.design_versions v where v.short_code = c1 and v.selections ? 'priceOverrides') then
      raise exception '277 probe: an anonymous save left a price in design_versions';
    end if;

    -- 2. A MEMBER WHO HOLDS IT sets one: stored.
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    got := public.save_design(c2, cid, '{}'::jsonb, jsonb_build_object('style', 'probe', 'priceOverrides', mine),
      '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    if got.selections->'priceOverrides' is distinct from mine then
      raise exception '277 probe: a member holding Override prices could not store one (%)', got.selections;
    end if;

    -- 3. ANON sends its own price over it, then a save with none at all (a shopper changing the
    --    colour): the stored price survives both, and everything else saves as before.
    execute 'set local role anon';
    got := public.save_design(c2, cid, '{}'::jsonb, jsonb_build_object('style', 'probe', 'priceOverrides', bad),
      '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    got := public.save_design(c2, cid, '{}'::jsonb, '{"style": "recoloured"}'::jsonb,
      '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    execute 'reset role';
    if got.selections->'priceOverrides' is distinct from mine or got.selections->>'style' is distinct from 'recoloured' then
      raise exception '277 probe: an anonymous save moved a stored price (%)', got.selections;
    end if;

    -- 4. A MEMBER WITHOUT IT (when this tenant has one): the same as anon.
    if nid is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', nid, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      got := public.save_design(c2, cid, '{}'::jsonb, jsonb_build_object('style', 'probe', 'priceOverrides', bad),
        '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
      execute 'reset role';
      perform set_config('request.jwt.claims', '', true);
      if got.selections->'priceOverrides' is distinct from mine then
        raise exception '277 probe: a member WITHOUT Override prices changed a stored price';
      end if;
    end if;

    -- 5. The holder clears it: gone.
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    got := public.save_design(c2, cid, '{}'::jsonb, '{"style": "probe"}'::jsonb,
      '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    if got.selections ? 'priceOverrides' then
      raise exception '277 probe: a member holding Override prices could not clear one';
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '277: anon and members without the area cannot store, change or clear a line''s price; a holder can; nothing else in selections moved';
      else
        raise;
      end if;
  end;
end
$probe$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- THE RECORD — `db query` prints only the last statement's rows, so this is what the apply shows.
-- Expect: edit, none, true, 0.
-- ═════════════════════════════════════════════════════════════════════════════════════════
select public.area_level_for('admin', 'admin', null, 'price_override') as admin_price_override,
       public.area_level_for('user', 'sales_rep', null, 'price_override') as sales_rep_price_override,
       position('277: a line''s own price' in pg_get_functiondef('public.save_design'::regproc)) > 0 as save_design_guarded,
       (select count(*) from public.designs
         where jsonb_typeof(selections) = 'object' and selections ? 'priceOverrides') as designs_with_prices;

commit;
