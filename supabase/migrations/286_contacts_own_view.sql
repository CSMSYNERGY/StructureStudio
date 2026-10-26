-- 286_contacts_own_view.sql — "Own · View": a person limited to their own customers who may look
--                             but not change them. The SQL half of contacts:'own_view'.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file` or an inline "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('286', '286_contacts_own_view') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-10-06, answering the 10-04 questions: for reps limited to their own customers, "a
-- per-user setting the builder controls: edit or view only." 'own' (193, writing since 09-07) is the
-- EDIT half and does not move. This file teaches the database the VIEW half: a fifth contacts level,
-- `own_view`, the same rows as 'own' and no writes. _shared/access.ts gains it in the same commit
-- (AREAS, RANK, ownContactsOnly, mayGrant), and its header names 193's own note: "Reinstating a
-- read-only-own means a NEW level, never quietly narrowing this one back." This is that level.
--
-- What the database has to do with it is READ narrowing. Writes never go through RLS here (no
-- INSERT/UPDATE/DELETE policy for authenticated exists on crm_*, designs, design_versions,
-- captured_leads, sms_messages or email_messages; crm_update_contact is service_role only), so the
-- "view only" half is enforced by the edge gates and the phone Worker: canEdit() refuses own_view
-- on every contacts:'edit' action. The database's job is to make sure an own_view person READS
-- only their own customers through PostgREST (Pipeline, Contacts, browsing leads, design_versions),
-- and that the phone Worker hears that they are narrowed.
--
-- ⚠️ WITHOUT THIS FILE, own_view WIDENS. area_level_for DISCARDS a stored level that is not in the
-- area's vocabulary and falls back to the title preset — read live on 2026-10-07:
--   area_level_for('user','sales_rep','{"contacts":"own_view"}','contacts') = 'edit'
-- i.e. every customer on the tenant, through the four restrictive policies that would then say
-- 'all'. Hence the ship order below.
--
-- ── THE EDITS ────────────────────────────────────────────────────────────────────────────
-- Three functions, each copied WHOLE from its newest definition, and each compared with
-- pg_get_functiondef on the live project on 2026-10-07: the bodies were byte-identical to the repo
-- copies named here (apart from line endings; live area_level_for md5 2a99f2fdd053870c3b755fc21e3f5f1f).
-- Derive the newest definition again before the next re-issue; do not trust these lines:
--   grep -l 'create or replace function public.<name>' supabase/migrations/*.sql
--
--   PART 1  area_level_for          from 277. ONE data token: contacts' vocabulary becomes
--                                   ["none","own_view","own","view","edit"], plus a "286" comment
--                                   line above k_areas. MUST LAND IN THE SAME COMMIT as the AREAS
--                                   change in _shared/access.ts: preflight's checkAreaMirror and
--                                   access.test.ts read the NEWEST file that defines this function,
--                                   and compare the joined vocabulary, so the order matters.
--   PART 2  crm_contact_scope       from 193. `= 'own'` becomes `in ('own', 'own_view')`, plus a
--                                   "286" comment line. It still RETURNS only 'own' or 'all', so the
--                                   four restrictive policies keyed on it (193 x3: crm_contacts,
--                                   designs, captured_leads; 207 x1: design_versions) narrow an
--                                   own_view person without being touched.
--   PART 3  phone_caller_context    from 266 (the newest; 263 before it). own_contacts_only becomes
--                                   `in ('own', 'own_view')`, plus a "286" comment line. Still the
--                                   service role's alone. contacts_level now reports 'own_view' for
--                                   such a person, and the Worker keeps it (workers/phone-api db.ts
--                                   normContactsLevel; an older Worker maps it to 'none', which
--                                   fails closed).
--
-- LEFT ALONE, on purpose: crm_create_contact (254), which checks that nobody on a call loses sight
-- of it when the call is relinked to a new contact, and counts only the literal 'own' as narrowed.
-- An own_view teammate on such a call therefore keeps that call unlinked. No leak, and nobody on
-- own_view can call it themselves (it is behind contacts:'edit'). Fix it in a later re-issue if
-- anyone notices.
--
-- No table, column or policy changes. No data writes.
--
-- ── INERT ON APPLY ───────────────────────────────────────────────────────────────────────
-- Nobody can store own_view until portal-commissions ships the new access.ts: the live
-- sanitizeAccess drops it at the door, and nothing else writes client_users.access. Every level
-- that exists today resolves exactly as before (PART 4 re-asserts them), and live on 2026-10-07 the
-- 14 client_users rows resolve contacts to 13 'edit' and 1 'view', with 0 storing 'own' or 'own_view'.
-- The PRECONDITION block refuses the apply if a row stores own_view while the live resolver still
-- discards it (that person has been reading every customer); a re-apply after this file passes.
--
-- ── SHIP ORDER: every READER before the one WRITER ───────────────────────────────────────
-- A reader still on old code DISCARDS a stored own_view and resolves the title preset — for a sales
-- rep, 'edit' on every customer. So:
--   1. this file (inert);
--   2. the portal on beta, then promoted to production (inert until the server emits own_view;
--      an old bundle shows a raw "own_view" button and hides Contacts from such a person);
--   3. the ten non-writing access.ts edge consumers together (portal-billing, portal-payments,
--      portal-projects, portal-schedule, portal-settings, portal-setup, portal-sms,
--      qbo-oauth-connect, submit-estimate, sync-design-status) and the phone-api Worker (manual);
--      grep each downloaded live copy for own_view;
--   4. LAST, portal-commissions — the only writer (set_access) and the only source of the Team
--      grid's metadata, so the "Own · View" button appears only then.
-- AND FOR GOOD AFTER STEP 4: every later deploy of an access.ts consumer or of phone-api must come
-- from a tree that holds own_view. One built from an older tree reads a stored own_view as the
-- title preset, the same widening. Grep the bundle, and the downloaded live copy afterwards, for
-- own_view on every such deploy.
--
-- ── PART 0 — blast radius. area_level_for is immutable, so this preview is exact. ───────
--   select count(*) from public.client_users where access->>'contacts' = 'own_view';
--   -- Must be 0 before applying (nothing can have stored it). 2026-10-07, read-only: 0.
--   select public.area_level_for(cu.role, cu.title, cu.access, 'contacts') as contacts, count(*)
--     from public.client_users cu group by 1 order by 1;
--   -- Before AND after: unchanged. 2026-10-07: edit 13, view 1.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ FAIL CLOSED FIRST, AND TAKE THE WRITER BACK FIRST. Reverting any reader while someone stores
-- own_view widens them to their title preset (a sales rep: every customer, with edit). The ship
-- order runs backwards: the writer leaves first, the readers last. An UPDATE run while the new
-- portal-commissions is still live does not cover rows an owner saves after it; and the OLD
-- portal-commissions silently drops own_view whenever an owner saves anything else for that
-- person, which lands them on their title preset ('edit' for a sales rep) with every reader still
-- new. Hence the rewrite on both sides of the writer:
--   1. Rewrite every stored own_view to 'none' (note each row; tell that builder afterwards):
--        update public.client_users set access = access || '{"contacts":"none"}'::jsonb
--         where access->>'contacts' = 'own_view' returning client_id, user_id;
--   2. Redeploy portal-commissions ALONE with the pre-286 _shared/access.ts. Grep the downloaded
--      live copy: own_view must be gone. Its sanitizeAccess now drops the level and the Team
--      grid's Own · View button disappears, so nothing can store it again.
--   3. Run the step-1 UPDATE again, for anything saved between steps 1 and 2, then:
--        select count(*) from public.client_users where access->>'contacts' = 'own_view';  -- 0
--   4. Only then revert the ten other access.ts edge consumers, the phone-api Worker and the
--      portal, and re-issue 277's area_level_for, 193's crm_contact_scope and 266's
--      phone_caller_context, each unchanged (the functions only).
--   5. Read the step-3 count once more: it must still be 0.
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PRECONDITION — nobody was narrowed to own_view while the database still discarded it.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Read before anything is re-issued. If the area_level_for that is live NOW does not know own_view
-- and a row stores it anyway, something wrote it before the readers shipped, and that person has
-- been reading every customer as their title preset. Stop: a human looks, and tells the builder.
-- Once this file has applied, area_level_for knows the level, so a re-apply after the Team screen
-- starts storing it passes.
do $pre$
begin
  if public.area_level_for('user', 'sales_rep', '{"contacts":"own_view"}'::jsonb, 'contacts') <> 'own_view'
     and exists (select 1 from public.client_users where access->>'contacts' = 'own_view') then
    raise exception '286: somebody already stores contacts=own_view while the database discards it -- something wrote it before the readers shipped; stop and look';
  end if;
end
$pre$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — area_level_for(), re-issued with contacts' fifth level, `own_view`
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
  -- 286: contacts gained own_view (own customers, view only), narrowest first after none.
  k_areas constant jsonb := $j$
  {
    "designer":              {"levels": ["none","view","edit"]},
    "price_override":        {"levels": ["none","edit"]},
    "designs":               {"levels": ["none","view","edit"]},
    "contacts":              {"levels": ["none","own_view","own","view","edit"]},
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
  'Pure mirror of effectiveAccess() in supabase/functions/_shared/access.ts: the title preset merged with the stored per-area deviations, owners absolute. MUST be changed in the same commit as that file — scripts/preflight.mjs cross-checks the AREA and TITLE lists on every push, and access.test.ts compares every preset LEVEL cell against this function''s literals. Migration 254 added the phone area; 277 added price_override (owners and admins); 286 added contacts:''own_view'' (own customers, view only). Reads no tables, so it is safe to call for preview/audit.';

revoke execute on function public.area_level_for(text, text, jsonb, text) from public, anon;
grant  execute on function public.area_level_for(text, text, jsonb, text) to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — crm_contact_scope(): own_view is narrowed exactly like 'own'
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 193's text with the one edit marked "286". The answer stays 'own' or 'all': the policies ask
-- "is this person narrowed", and both own-scope levels say yes.
create or replace function public.crm_contact_scope()
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

  -- No JWT. Unreachable through the policies below (they are `to authenticated`), but a
  -- direct call must still fail OPEN, for the same reason the next branch does.
  if v_uid is null then
    return 'all';
  end if;

  -- limit 1, never strict/maybeSingle: a duplicate client_users row must not become an
  -- EXCEPTION raised inside an RLS policy, which turns one bad row into a 500 on every read
  -- that person makes. Unordered first-row-wins matches public.current_client_id() (001) and
  -- current_area_level (154) exactly, so the tenant policy and this one always read the SAME
  -- row and can never disagree about who this person is.
  select cu.role, cu.title, cu.access
    into v_role, v_title, v_access
    from public.client_users cu
   where cu.user_id = v_uid
   limit 1;

  -- FAIL OPEN. See the header: no row here means no row for current_client_id() either,
  -- means the permissive tenant policy has already returned nothing, so "all" ANDed onto
  -- "nothing" is still nothing. The only population this affects is CSM operators, whose
  -- reads go through the service role anyway.
  if not found then
    return 'all';
  end if;

  -- 286: own_view (own customers, view only) sees the same rows as 'own', so it is narrowed the same.
  if public.area_level_for(v_role, v_title, v_access, 'contacts') in ('own', 'own_view') then
    return 'own';
  end if;
  return 'all';
end
$fn$;
comment on function public.crm_contact_scope() is
  'Is the signed-in caller limited to the customers they own or follow? ''own'' or ''all'' (migration 193). ''own'' for the contacts levels ''own'' and ''own_view'' (286: own customers, view only), which see the same rows. Owners always resolve ''all'', structurally: area_level_for short-circuits role=owner to edit before it looks at any stored map. A caller with no client_users row resolves ''all'', because the tenant policy already denies them every row.';

revoke execute on function public.crm_contact_scope() from public, anon;
grant  execute on function public.crm_contact_scope() to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — phone_caller_context: the Worker hears that an own_view person is narrowed
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 266's text with the one edit marked "286".

-- ── phone_caller_context: who is this signed-in person, for /token and /voice/outbound ──
create or replace function public.phone_caller_context(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object(
           'client_id',         cu.client_id,
           'phone_status',      coalesce(cs.phone_status, 'off'),
           'phone_level',       public.area_level_for(cu.role, cu.title, cu.access, 'phone'),
           'contacts_level',    public.area_level_for(cu.role, cu.title, cu.access, 'contacts'),
           -- 286: own_view (own customers, view only) is narrowed like 'own'.
           'own_contacts_only', public.area_level_for(cu.role, cu.title, cu.access, 'contacts') in ('own', 'own_view'),
           'device_generation', coalesce(s.device_generation, 1),
           'number',            (select jsonb_build_object(
                                          'id',                  n.id,
                                          'e164',                n.phone_number,
                                          'voice_enabled',       n.voice_enabled,
                                          'registration_status', n.registration_status)
                                   from public.sms_numbers n
                                  where n.client_id = cu.client_id
                                    and n.released_at is null
                                  -- 266: their own number, then a team line, then 263's rule.
                                  order by coalesce(n.assigned_user_id = cu.user_id, false) desc,
                                           (n.assigned_user_id is null) desc,
                                           (n.phone_number = cs.sms_number) desc nulls last,
                                           n.purchased_at asc, n.id
                                  limit 1),
           -- 266: every live number of the business, oldest first.
           'numbers',           coalesce((select jsonb_agg(n.phone_number order by n.purchased_at, n.id)
                                            from public.sms_numbers n
                                           where n.client_id = cu.client_id
                                             and n.released_at is null), '[]'::jsonb),
           'full_name',         cu.full_name,
           'recording',         jsonb_build_object(
                                  'on',          coalesce(cs.phone_record_calls, false),
                                  'notice',      coalesce(cs.phone_recording_notice, true),
                                  'notice_text', cs.phone_recording_notice_text,
                                  'transcribe',  coalesce(cs.phone_transcribe_calls, true))
         )
    from public.client_users cu
    left join public.client_settings cs on cs.client_id = cu.client_id
    left join public.phone_user_settings s on s.user_id = cu.user_id
   where cu.user_id = p_user_id
   limit 1;
$fn$;
comment on function public.phone_caller_context(uuid) is
  'SSS Phone (migrations 254, 263, 266, 286): one uncached read of a signed-in person for /token and every /voice/outbound: {client_id, phone_status, phone_level, contacts_level, own_contacts_only, device_generation, number, numbers, full_name, recording:{on, notice, notice_text, transcribe}}. own_contacts_only = contacts level ''own'' or ''own_view'' (286). number = the number their calls show: their own (sms_numbers.assigned_user_id), else a team line, preferring the texting number (client_settings.sms_number), else the oldest; someone else''s own number only when the business has nothing else. numbers = every live number of the business, E.164, oldest first. NULL when the user is on no team. service_role only.';

revoke execute on function public.phone_caller_context(uuid) from public, anon, authenticated;
grant  execute on function public.phone_caller_context(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — apply-time assertions. These RAISE, aborting the whole transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  r      record;
  v_src  text;
  v_fn   constant text := 'public.phone_caller_context(uuid)';
  v_sc   constant text := 'public.crm_contact_scope()';
begin
  -- ── The new level, the way the decision says it resolves. ──
  if public.area_level_for('user','sales_rep','{"contacts":"own_view"}'::jsonb,'contacts') <> 'own_view' then
    raise exception '286: a stored contacts=own_view does not resolve on a sales rep';
  end if;
  if public.area_level_for('user','dealer','{"contacts":"own_view"}'::jsonb,'contacts') <> 'own_view' then
    raise exception '286: a stored contacts=own_view does not resolve on a dealer';
  end if;
  if public.area_level_for('user', null,'{"contacts":"own_view"}'::jsonb,'contacts') <> 'own_view' then
    raise exception '286: a stored contacts=own_view does not resolve on a NULL title';
  end if;
  -- OWNERS ABSOLUTE: a stored own_view on an owner's row never narrows them.
  if public.area_level_for('owner','owner','{"contacts":"own_view"}'::jsonb,'contacts') <> 'edit' then
    raise exception '286: a stored contacts=own_view narrowed an OWNER';
  end if;
  -- The default is today's behaviour: no preset moved.
  if public.area_level_for('user','dealer', null,'contacts') <> 'own' then
    raise exception '286: the dealer contacts preset moved (it stays Own, Edit)';
  end if;
  if public.area_level_for('user','sales_rep', null,'contacts') <> 'edit' then
    raise exception '286: the sales_rep contacts preset moved';
  end if;
  -- ADDED, NOT SUBSTITUTED: 'own' and 'view' still resolve.
  if public.area_level_for('user','sales_rep','{"contacts":"own"}'::jsonb,'contacts') <> 'own' then
    raise exception '286: a stored contacts=own no longer resolves';
  end if;
  if public.area_level_for('user','crew_leader','{"contacts":"view"}'::jsonb,'contacts') <> 'view' then
    raise exception '286: a stored contacts=view no longer resolves';
  end if;
  if public.area_level_for('user','scheduler','{"contacts":"edit"}'::jsonb,'contacts') <> 'edit' then
    raise exception '286: a stored contacts=edit no longer resolves';
  end if;
  -- On contacts ONLY: the other two own-scope areas discard it and keep the preset.
  if public.area_level_for('user','sales_rep','{"commissions":"own_view"}'::jsonb,'commissions') <> 'own' then
    raise exception '286: own_view was accepted on commissions';
  end if;
  if public.area_level_for('user','sales_rep','{"phone":"own_view"}'::jsonb,'phone') <> 'own' then
    raise exception '286: own_view was accepted on phone';
  end if;
  -- An unknown level still falls back to the preset rather than blanking it.
  if public.area_level_for('user','sales_rep','{"contacts":"own-view"}'::jsonb,'contacts') <> 'edit' then
    raise exception '286: an unknown contacts level no longer falls back to the preset';
  end if;

  -- ── NOTHING ELSE MOVED. 277's checks, re-asserted: this is a whole-function replace. ──
  if public.area_level_for('owner','owner', null, 'price_override') <> 'edit' then raise exception '286: owner price_override'; end if;
  if public.area_level_for('admin','admin', null, 'price_override') <> 'edit' then raise exception '286: admin price_override'; end if;
  if public.area_level_for('user','sales_rep', null, 'price_override') <> 'none' then raise exception '286: sales_rep price_override'; end if;
  if public.area_level_for('user','sales_rep','{"price_override":"edit"}'::jsonb, 'price_override') <> 'edit' then raise exception '286: price_override grant'; end if;
  if public.area_level_for('admin','admin','{}'::jsonb,'phone')                   <> 'edit' then raise exception '286: admin phone'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'phone')             <> 'view' then raise exception '286: office_staff phone'; end if;
  if public.area_level_for('user','sales_manager','{}'::jsonb,'phone')            <> 'view' then raise exception '286: sales_manager phone'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'phone')                <> 'own'  then raise exception '286: sales_rep phone'; end if;
  if public.area_level_for('user','dealer','{}'::jsonb,'phone')                   <> 'own'  then raise exception '286: dealer phone'; end if;
  if public.area_level_for('user','driver','{}'::jsonb,'phone')                   <> 'none' then raise exception '286: driver phone'; end if;
  if public.area_level_for('user','crew_leader','{"phone":"own"}'::jsonb,'phone') <> 'own'  then raise exception '286: phone grant'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'designer')            <> 'edit' then raise exception '286: office_staff designer'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'orders')              <> 'edit' then raise exception '286: office_staff orders'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'change_orders')       <> 'edit' then raise exception '286: office_staff change_orders'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'settings_branding')   <> 'edit' then raise exception '286: office_staff branding'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'settings_quickbooks') <> 'edit' then raise exception '286: office_staff quickbooks'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'build_schedule')      <> 'view' then raise exception '286: office_staff build_schedule'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'commissions')         <> 'none' then raise exception '286: office_staff commissions'; end if;
  if public.area_level_for('owner','owner','{}'::jsonb,'settings_billing')            <> 'edit' then raise exception '286: owner regression'; end if;
  if public.area_level_for('admin','admin','{}'::jsonb,'settings_billing')            <> 'none' then raise exception '286: admin billing regression'; end if;
  if public.area_level_for('admin','admin','{"settings_billing":"edit"}'::jsonb,'settings_billing') <> 'edit' then raise exception '286: admin billing grant regression'; end if;
  if public.area_level_for('user','sales_rep','{"settings_billing":"edit"}'::jsonb,'settings_billing') <> 'none' then raise exception '286: billing granted to a non-admin'; end if;
  if public.area_level_for('user','admin','{"settings_team":"none"}'::jsonb,'settings_team') <> 'edit' then raise exception '286: settings_team became grantable'; end if;
  if public.area_level_for('admin','admin','{}'::jsonb,'change_order_approve')        <> 'edit' then raise exception '286: change_order_approve lost'; end if;
  if public.area_level_for('user','crew_leader','{}'::jsonb,'change_order_approve')   <> 'none' then raise exception '286: change_order_approve leaked to a preset'; end if;
  if public.area_level_for('user','sales_manager','{}'::jsonb,'commissions')          <> 'edit' then raise exception '286: sales_manager regression'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'commissions')              <> 'own'  then raise exception '286: sales_rep regression'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'orders')                   <> 'edit' then raise exception '286: sales_rep orders regression'; end if;
  if public.area_level_for('user','dealer','{}'::jsonb,'designer')                    <> 'edit' then raise exception '286: dealer designer regression'; end if;
  if public.area_level_for('user','scheduler','{}'::jsonb,'contacts')                 <> 'view' then raise exception '286: scheduler contacts regression'; end if;
  if public.area_level_for('user','scheduler','{}'::jsonb,'designer')                 <> 'none' then raise exception '286: scheduler gained designer'; end if;
  if public.area_level_for('user','crew_leader','{}'::jsonb,'repairs')                <> 'edit' then raise exception '286: crew_leader regression'; end if;
  if public.area_level_for('user','crew_member','{}'::jsonb,'build_schedule')         <> 'view' then raise exception '286: crew_member regression'; end if;
  if public.area_level_for('user','driver','{}'::jsonb,'delivery_schedule')           <> 'edit' then raise exception '286: driver regression'; end if;
  if public.area_level_for('user','nonsense','{}'::jsonb,'commissions')               <> 'own'  then raise exception '286: normTitle fallback'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'no_such_area')          <> 'none' then raise exception '286: unknown area'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'projects')                 <> 'none' then raise exception '286: projects leaked to a preset'; end if;
  if public.area_level_for('owner','owner','{}'::jsonb,'projects')                    <> 'edit' then raise exception '286: owner projects'; end if;

  -- ── area_level_for's grant posture, unchanged: authenticated and service_role only. ──
  if has_function_privilege('anon', 'public.area_level_for(text, text, jsonb, text)', 'EXECUTE') then
    raise exception '286: anon can execute area_level_for';
  end if;
  if not has_function_privilege('authenticated', 'public.area_level_for(text, text, jsonb, text)', 'EXECUTE') then
    raise exception '286: authenticated lost area_level_for (the RLS policies call it as the signed-in user)';
  end if;

  -- ── crm_contact_scope: the edit landed, and its posture did not move. ──
  -- SECURITY DEFINER (it reads client_users from inside four RLS policies), an empty search_path,
  -- callable by the signed-in user (the policies run as them) and never by anon or PUBLIC.
  if not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_sc::regprocedure) then
    raise exception '286: crm_contact_scope is no longer SECURITY DEFINER';
  end if;
  if not coalesce((select p.proconfig @> array['search_path=""'] from pg_catalog.pg_proc p where p.oid = v_sc::regprocedure), false) then
    raise exception '286: crm_contact_scope lost its empty search_path';
  end if;
  if has_function_privilege('anon', v_sc, 'EXECUTE')
     or exists (select 1 from pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = v_sc::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception '286: crm_contact_scope is executable by anon or PUBLIC';
  end if;
  if not has_function_privilege('authenticated', v_sc, 'EXECUTE')
     or not has_function_privilege('service_role', v_sc, 'EXECUTE') then
    raise exception '286: authenticated or service_role lost crm_contact_scope -- every policy keyed on it would raise';
  end if;
  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = v_sc::regprocedure;
  if position($x$'contacts') in ('own', 'own_view') then$x$ in v_src) = 0 then
    raise exception '286: crm_contact_scope does not narrow own_view';
  end if;
  if position($x$return 'own';$x$ in v_src) = 0 or position($x$return 'all';$x$ in v_src) = 0
     or position($x$return 'own_view'$x$ in v_src) > 0 then
    raise exception '286: crm_contact_scope must still answer only own or all (the policies compare to own)';
  end if;

  -- ── The four policies keyed on it: still there, still RESTRICTIVE / SELECT / authenticated, and
  --    still asking crm_contact_scope() = 'own'. Not touched by this file; checked because the
  --    narrowing of own_view rests entirely on them. ──
  for r in
    select * from (values
      ('crm_contacts',    'crm_contacts_own_select'),
      ('designs',         'designs_own_select'),
      ('captured_leads',  'captured_leads_own_select'),
      ('design_versions', 'design_versions_own_select')
    ) as t(tbl, pol)
  loop
    perform 1
       from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = r.tbl
        and p.policyname = r.pol
        and p.permissive = 'RESTRICTIVE'
        and p.cmd        = 'SELECT'
        and p.roles      = '{authenticated}'::name[]
        and position('crm_contact_scope()' in p.qual) > 0
        and position('''own''' in p.qual) > 0;
    if not found then
      raise exception '286: policy %.% is missing, or no longer a RESTRICTIVE, SELECT-only, authenticated-only policy asking crm_contact_scope() = ''own''',
        r.tbl, r.pol;
    end if;
  end loop;

  -- ── phone_caller_context: the service role's alone, with its empty search_path. ──
  if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception '286: % is callable from the browser', v_fn;
  end if;
  if exists (select 1 from pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where p.oid = v_fn::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception '286: % is still executable by PUBLIC', v_fn;
  end if;
  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception '286: service_role cannot call %', v_fn;
  end if;
  if not coalesce((select p.proconfig @> array['search_path=""'] from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure), false) then
    raise exception '286: % lost its empty search_path', v_fn;
  end if;
  -- 263's and 266's self-checks, kept, and this file's own.
  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure;
  if position('''recording''' in v_src) = 0 or position('cs.phone_record_calls' in v_src) = 0 then
    raise exception '286: phone_caller_context does not return recording any more (263)';
  end if;
  if position('coalesce(n.assigned_user_id = cu.user_id, false) desc' in v_src) = 0
     or position('(n.assigned_user_id is null) desc' in v_src) = 0
     or position('(n.phone_number = cs.sms_number) desc nulls last' in v_src) = 0
     or position('''numbers''' in v_src) = 0 then
    raise exception '286: phone_caller_context lost 266''s number rules';
  end if;
  if position($x$'contacts') in ('own', 'own_view'),$x$ in v_src) = 0 then
    raise exception '286: phone_caller_context does not report own_view as own_contacts_only';
  end if;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 — read-only probe on real rows. Nothing is written.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- phone_caller_context on one real team member agrees with area_level_for (the PRECONDITION above
-- already refused a stored own_view the old resolver would have discarded).
do $probe$
declare
  v_real public.client_users;
  v_ctx  jsonb;
begin
  select cu.* into v_real from public.client_users cu order by cu.user_id limit 1;
  if v_real.user_id is not null then
    v_ctx := public.phone_caller_context(v_real.user_id);
    if v_ctx is null then
      raise exception '286 probe: phone_caller_context returned NULL for a real team member';
    end if;
    if v_ctx ->> 'contacts_level' is distinct from public.area_level_for(v_real.role, v_real.title, v_real.access, 'contacts')
       or (v_ctx ->> 'own_contacts_only')::boolean
            is distinct from (public.area_level_for(v_real.role, v_real.title, v_real.access, 'contacts') in ('own', 'own_view')) then
      raise exception '286 probe: phone_caller_context disagrees with area_level_for';
    end if;
  end if;
  -- No JWT: the resolver fails open by design (193), and still answers.
  if public.crm_contact_scope() is distinct from 'all' then
    raise exception '286 probe: crm_contact_scope without a signed-in user is not ''all''';
  end if;
end
$probe$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- THE RECORD — `db query` prints only the last statement's rows, so this is what the apply shows.
-- Expect: own_view, own, edit, 0 (on the first apply; the count is people on Own · View since).
-- ═════════════════════════════════════════════════════════════════════════════════════════
select public.area_level_for('user', 'sales_rep', '{"contacts":"own_view"}'::jsonb, 'contacts') as rep_own_view,
       public.area_level_for('user', 'dealer', null, 'contacts') as dealer_preset,
       public.area_level_for('owner', 'owner', '{"contacts":"own_view"}'::jsonb, 'contacts') as owner_own_view,
       (select count(*) from public.client_users where access->>'contacts' = 'own_view') as stored_own_view;

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING — verify read-only:
--   select public.area_level_for('user','sales_rep','{"contacts":"own_view"}','contacts');   -- own_view
--   select position('286:' in pg_get_functiondef('public.crm_contact_scope()'::regprocedure)) > 0,
--          position('286:' in pg_get_functiondef('public.phone_caller_context(uuid)'::regprocedure)) > 0,
--          position('286:' in pg_get_functiondef('public.area_level_for(text,text,jsonb,text)'::regprocedure)) > 0;  -- true x3
--   select public.area_level_for(cu.role, cu.title, cu.access, 'contacts'), count(*) from public.client_users cu group by 1;
--     -- unchanged from PART 0
-- ═════════════════════════════════════════════════════════════════════════════════════════
