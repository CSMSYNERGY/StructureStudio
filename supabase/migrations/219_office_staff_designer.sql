-- 219_office_staff_designer.sql — Office Staff gets the Designer.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-09-07, hours after 218 shipped: "Give Office Staff the designer too."
--
-- 218 omitted `designer` from the office_staff preset on the reasoning that the title manages
-- quote RECORDS rather than building them, and that whoever takes phone orders would have it
-- switched on per person. That had the ratio backwards: in a shed business the person
-- answering the phone IS the one who builds the quote, so the exception was the rule and
-- every office staffer would have needed the same click.
--
-- ── WHY THIS IS A MIGRATION AT ALL, GIVEN IT CHANGES NOTHING TODAY ───────────────────────
-- NO RLS POLICY KEYS ON `designer`. Checked before writing this, both ways: no
-- `current_area_level('designer')` and no `area_level_for(..., 'designer')` anywhere in
-- supabase/migrations. The area gates the Designer TAB (portal/01-core.jsx's TAB_AREA) and one
-- branch of submit-estimate — never a table. So the SQL mirror and the TypeScript could
-- disagree about this single cell and nothing observable would happen.
--
-- That is exactly the state 154's `change_orders` drift and the sales_rep `orders` drift were
-- in, and CLAUDE.md's verdict on both is the reason this file exists: "Both were inert only by
-- luck — no policy happened to key on either — and 'inert by luck' is not a property you get to
-- keep." A future migration that gates a table on `designer` would silently find office staff
-- locked out of it, and the cause would be three months old by then.
--
-- ⚠️ preflight's checkAreaMirror does NOT catch this class. It compares area keys, area level
-- vocabularies and TITLE keys — all three of which already agree. Preset LEVELS are the gap it
-- names in its own header and still does not close, because PRESETS.owner is computed and
-- cannot be read statically. So this one is on the author, and the assertions below are the
-- only mechanical check there is.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────────────────────
-- One cell: k_presets -> office_staff -> designer, absent (therefore 'none') -> "edit".
--
-- The function is copied WHOLE from 218_team_titles.sql — the most recent DEFINITION, verified
-- against `pg_get_functiondef` rather than assumed, which is the rule 218's own header spells
-- out after nearly shipping a silent revert of 212's area. k_areas, every other preset, the
-- normTitle CASE and the resolution logic are byte-identical to 218.
--
-- Nobody holds this title yet (218 shipped today and every client_users row still reads owner,
-- sales_rep, driver or NULL), so this widens access for zero existing people. It also cannot
-- narrow anyone: a stored override still layers on top, so an owner who deliberately sets an
-- office staffer to designer:'none' keeps that — asserted below, because it is the half of
-- Carolyn's original request that must survive every preset change.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   Re-run 218_team_titles.sql's area_level_for definition (PART 2 of that file) and drop
--   designer:"edit" from office_staff in _shared/access.ts in the same commit.
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

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
      "designer":"edit",
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
  'Pure mirror of effectiveAccess() in supabase/functions/_shared/access.ts: the title preset merged with the stored per-area deviations, owners absolute. MUST be changed in the same commit as that file — scripts/preflight.mjs cross-checks the two AREA lists and the two TITLE lists on every push, but NOT the preset LEVELS, which is what migration 219 changed (office_staff gained designer). Reads no tables, so it is safe to call for preview/audit.';

revoke execute on function public.area_level_for(text, text, jsonb, text) from public, anon;
grant  execute on function public.area_level_for(text, text, jsonb, text) to authenticated, service_role;

-- ── ASSERTIONS ───────────────────────────────────────────────────────────────────────────
-- The only mechanical check on a preset LEVEL there is (see the header: preflight does not
-- cover this class). Every claim the header makes, asserted.
do $assert$
begin
  -- The one cell this migration exists to change.
  if public.area_level_for('user','office_staff','{}'::jsonb,'designer') <> 'edit' then
    raise exception 'office_staff did not gain designer';
  end if;

  -- AND NOTHING ELSE IN THAT PRESET MOVED. A whole-function copy is the safe way to re-issue
  -- this and also the easy way to lose a cell nobody re-reads, so the rest of office_staff is
  -- spelled out rather than trusted.
  if public.area_level_for('user','office_staff','{}'::jsonb,'designs')             <> 'edit' then raise exception 'office_staff designs'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'contacts')            <> 'edit' then raise exception 'office_staff contacts'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'inventory')           <> 'edit' then raise exception 'office_staff inventory'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'orders')              <> 'edit' then raise exception 'office_staff orders'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'change_orders')       <> 'edit' then raise exception 'office_staff change_orders'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'settings_branding')   <> 'edit' then raise exception 'office_staff branding'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'settings_quickbooks') <> 'edit' then raise exception 'office_staff quickbooks'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'build_schedule')      <> 'view' then raise exception 'office_staff build_schedule'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'delivery_schedule')   <> 'view' then raise exception 'office_staff delivery_schedule'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'repairs')             <> 'view' then raise exception 'office_staff repairs'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'reports')             <> 'view' then raise exception 'office_staff reports'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'commissions')         <> 'none' then raise exception 'office_staff commissions'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'settings_team')       <> 'none' then raise exception 'office_staff team'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'settings_billing')    <> 'none' then raise exception 'office_staff billing'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'settings_structures') <> 'none' then raise exception 'office_staff structures'; end if;

  -- WIDENING A PRESET DOES NOT OVERRULE AN OWNER. The half of the original request that has to
  -- survive every future preset change: an office staffer deliberately set to designer:'none'
  -- stays there.
  if public.area_level_for('user','office_staff','{"designer":"none"}'::jsonb,'designer') <> 'none' then
    raise exception 'a stored override no longer beats the office_staff preset';
  end if;
  if public.area_level_for('user','office_staff','{"designer":"view"}'::jsonb,'designer') <> 'view' then
    raise exception 'a narrowing override on designer was discarded';
  end if;

  -- NO OTHER TITLE MOVED. This is a whole-function replace, so the other nine are re-asserted
  -- rather than assumed — 218's header records how close a copy of this kind came to silently
  -- deleting 212's area.
  if public.area_level_for('owner','owner','{}'::jsonb,'settings_billing')            <> 'edit' then raise exception 'owner regression'; end if;
  if public.area_level_for('admin','admin','{}'::jsonb,'settings_billing')            <> 'none' then raise exception 'admin regression'; end if;
  if public.area_level_for('admin','admin','{}'::jsonb,'change_order_approve')        <> 'edit' then raise exception 'change_order_approve lost'; end if;
  if public.area_level_for('user','crew_leader','{"change_order_approve":"edit"}'::jsonb,'change_order_approve') <> 'edit' then raise exception 'change_order_approve area lost from k_areas'; end if;
  if public.area_level_for('user','sales_manager','{}'::jsonb,'commissions')          <> 'edit' then raise exception 'sales_manager regression'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'commissions')              <> 'own'  then raise exception 'sales_rep regression'; end if;
  if public.area_level_for('user','dealer','{}'::jsonb,'contacts')                    <> 'own'  then raise exception 'dealer regression'; end if;
  if public.area_level_for('user','dealer','{}'::jsonb,'designer')                    <> 'edit' then raise exception 'dealer designer regression'; end if;
  if public.area_level_for('user','scheduler','{}'::jsonb,'delivery_schedule')        <> 'edit' then raise exception 'scheduler regression'; end if;
  if public.area_level_for('user','scheduler','{}'::jsonb,'designer')                 <> 'none' then raise exception 'scheduler gained designer'; end if;
  if public.area_level_for('user','crew_leader','{}'::jsonb,'repairs')                <> 'edit' then raise exception 'crew_leader regression'; end if;
  if public.area_level_for('user','crew_member','{}'::jsonb,'build_schedule')         <> 'view' then raise exception 'crew_member regression'; end if;
  if public.area_level_for('user','crew_member','{}'::jsonb,'designer')               <> 'none' then raise exception 'crew_member gained designer'; end if;
  if public.area_level_for('user','driver','{}'::jsonb,'delivery_schedule')           <> 'edit' then raise exception 'driver regression'; end if;
  if public.area_level_for('user','nonsense','{}'::jsonb,'commissions')               <> 'own'  then raise exception 'normTitle fallback'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'no_such_area')          <> 'none' then raise exception 'unknown area'; end if;
end
$assert$;

commit;
