-- 193_contacts_own_scope.sql — "they would only see the quotes that they have created
--                               themselves", enforced in the database.
--
-- ── WHY (Carolyn, 2026-09-04 call, 1:02:16–1:04:27, on a builder she is onboarding whose
--    salespeople are independent dealers) ─────────────────────────────────────────────────
-- "he also doesn't want them to see each other's quotes either … they would only see the
-- list, the pipelines or the quotes that they have created themselves. Only the owner would
-- see 'okay, this customer went through employee B and C' … Now, if the owner wants the
-- employees to see, then they just toggle the button in the settings and they will be able
-- to see."
--
-- The button is a new LEVEL on the existing `contacts` area — `own` — not a new area. It is
-- added to _shared/access.ts in this same commit, and PART 1 below is the SQL half of that
-- edit (the two are cross-checked by scripts/preflight.mjs's checkAreaMirror since
-- 2026-09-05, in both directions).
--
-- ── THE MODEL: CONTACTS ARE ASSIGNED, DEALS NEVER ARE ─────────────────────────────────────
-- Same call, 1:09:30: "we do not ever assign deals. We only assign contacts and followers …
-- if they are not assigned to or following that customer, they can't see anything of it."
--
-- So there is exactly ONE predicate in this whole feature — "may this person see this
-- CUSTOMER" — and a design or a browsing lead is visible because its customer is. That is
-- why `designs` keeps its ordinary none/view/edit vocabulary and is untouched here: it
-- answers "may you open the Pipeline at all", while `contacts` answers "whose rows are in
-- it". A per-design assignee would be a second thing to keep in step with the first, and she
-- has ruled it out twice.
--
-- 188 made crm_contacts.owner_user_id writable, 189 added crm_contact_followers and the
-- auto-follow that runs when a rep saves a quote (crm_quote_assign). 189's header says
-- plainly what it was NOT doing: "it does not narrow anybody's reads … turning it on means a
-- restrictive RLS policy on crm_contacts keyed on owner/follower". THIS IS THAT FILE.
--
-- ── TWO EDGE CASES, DECIDED, WITH THE REASONING ──────────────────────────────────────────
--
--   1. owner_user_id IS NULL  ->  VISIBLE TO EVERYONE.
--      Every contact that exists today has a NULL owner: 188 shipped the writer and nothing
--      has run against it yet, and 189's assigner only fires on a quote saved from here on.
--      The alternative — treating unassigned as nobody's — empties every rep's pipeline on
--      the day this applies, on every tenant, and the first symptom would be "the app lost
--      all my customers". Unassigned means "not yet decided", and the honest reading of a
--      decision nobody has made is not "denied".
--
--   2. A design (or lead) whose contact_id IS NULL  ->  OWNER/ADMIN ONLY.
--      crm_ensure_contact returns NULL for a submission carrying neither a phone nor an
--      email, so those rows have no customer at all — there is nothing to own and nothing to
--      follow, and rule 1 cannot apply because rule 1 is a fact about a contact row that
--      does not exist. Hidden rather than shown, because the row still carries a name, a
--      configuration and a price. In practice that means owners and admins, who resolve
--      'edit' and never reach the narrowing at all.
--      Same rule for captured_leads and the same reason. capture-lead stamps contact_id at
--      capture time (the runtime half of 176) and 176's backfill caught up the rest, so this
--      is a rare shape rather than the common one.
--
-- ── FAIL DIRECTION, STATED ON PURPOSE ────────────────────────────────────────────────────
-- 154's current_area_level FAILS OPEN on a missing client_users row and 154:437-461 explains
-- why at length. crm_contact_scope() below FAILS OPEN TOO, for the identical structural
-- reason and not by imitation: public.current_client_id() reads THE SAME ROW of THE SAME
-- TABLE, so no row here means no row there, means client_id = NULL, means the permissive
-- tenant policy has already returned zero rows. ANDing "all of them" onto "none of them" is
-- still none of them. The population with no client_users row is CSM operators, and 151 has
-- already recorded what happens when a resolver denies them: every storage policy failed
-- closed.
--
-- crm_contact_visible_to() fails the OTHER way — an unknown, deleted or NULL contact is NOT
-- visible — and that is deliberate too. It is not a resolver answering "who is this person";
-- it is the predicate itself, and its absence case is edge case 2 above.
--
-- ⚠️ THIS FILE IS ONLY ONE OF THREE ENFORCEMENT POINTS AND IT IS THE NARROWEST. Every edge
-- function runs with the service role and therefore BYPASSRLS, so nothing below constrains
-- portal-settings by so much as a row; those filters are written by hand at the reads, in
-- this same commit, and portal/01-core.jsx carries the browser-side registry. RLS covers the
-- lists the browser reads STRAIGHT from PostgREST — which is precisely the hole 154 was
-- written to close and 12-shell.jsx:487-510 described before it.
--
-- ⚠️ KNOWN GAP, DELIBERATELY NOT CLOSED HERE: public.design_versions. The Pipeline reads it
-- directly (portal/02-sales.jsx:189) and it carries a design's configuration and images, but
-- no contact of its own — gating it means joining to designs by short_code, i.e. a fourth
-- policy and a fourth helper. Its rows are only ever rendered under a design the list has
-- already filtered away, so the leak is devtools-only and is configuration, not customer
-- identity. Closing it is one policy of the same shape; see the bottom of PART 3.
--
-- HAND-APPLY (inline, not --file: `supabase db query --file` auth-fails, retries and still
-- exits 0), as the one begin/commit below, then record in
-- supabase_migrations.schema_migrations. Do NOT db push. BOM-free.
--
-- ⚠️ THIS ONE IS NOT INERT. PART 3 takes rows away from real people the moment it commits —
-- but only from people whose contacts level is exactly 'own', and NOBODY CAN HOLD THAT LEVEL
-- until _shared/access.ts ships it and an owner sets it on the Team screen. No preset here
-- or in access.ts grants 'own'; the sales_rep preset stays contacts:'edit'. So the apply
-- itself changes nothing for anyone, and the first person narrowed is narrowed by a human
-- clicking a switch.
--
-- Requires 188 (owner_user_id) and 189 (crm_contact_followers).
--
-- Rollback:
--   drop policy if exists crm_contacts_own_select  on public.crm_contacts;
--   drop policy if exists designs_own_select       on public.designs;
--   drop policy if exists captured_leads_own_select on public.captured_leads;
--   drop function if exists public.crm_visible_contact_ids(text, uuid, uuid[]);
--   drop function if exists public.crm_contact_scope();
--   drop function if exists public.crm_contact_mine(uuid);          -- before the next line:
--   drop function if exists public.crm_contact_visible_to(uuid, uuid);   -- it depends on it
--   -- re-issue 183's area_level_for verbatim (contacts back to none/view/edit), AND strip
--   -- "own" from every client_users.access blob that gained it, or those people resolve to
--   -- their title preset instead — which for a crew leader is 'none', i.e. MORE restrictive
--   -- than the state you are rolling back from. Levels are not a superset; check first:
--   --   select user_id, client_id from public.client_users where access->>'contacts' = 'own';

begin;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — re-issue area_level_for, with `contacts` speaking four levels instead of three.
--
-- The resolution LOGIC is byte-identical to 183's, which was byte-identical to 154's. The
-- ONLY change in this whole function is one line of the areas literal: contacts gains "own".
--
-- ⚠️ ADDED, NOT SUBSTITUTED. "view" stays in the list even though the new switch is what
-- everyone will use. The override loop below DISCARDS a stored level that is not in the
-- area's own vocabulary — that check is what keeps a hand-edited blob from blanking a preset
-- — so removing "view" would silently drop every stored {"contacts":"view"} back to the
-- title preset on the next read. For a crew leader that preset is 'none'. Nothing would
-- error and nothing would log; someone would just quietly stop seeing customers.
--
-- ⚠️ ORDER MATTERS TO THE GUARD, not to the resolver. preflight's checkAreaMirror compares
-- the level vocabularies as a joined string, so ["none","own","view","edit"] here must match
-- the array in _shared/access.ts element for element. A reordering that means the same thing
-- to Postgres fails the push, which is the correct amount of pedantry for a permission table
-- that has silently drifted twice.
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
  -- row: commissions and now contacts are deliberately not the universal none/view/edit
  -- triplet, which is why the level check below reads the array instead of assuming three.
  --
  -- `internalOnly` is NOT mirrored, on purpose. It governs which switches accessMetadata()
  -- ships to a browser — a presentation rule with no bearing on how a stored map resolves —
  -- and mirroring it here would invite a future reader to treat it as the tenancy check,
  -- which it is not.
  k_areas constant jsonb := $j$
  {
    "designer":             {"levels": ["none","view","edit"]},
    "designs":              {"levels": ["none","view","edit"]},
    "contacts":             {"levels": ["none","own","view","edit"]},
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
  -- ⚠️ UNCHANGED BY THIS MIGRATION, AND THAT IS THE POINT. sales_rep keeps contacts:"edit".
  -- Nobody is narrowed by applying this file; 'own' arrives only when an owner sets it on one
  -- person, which is exactly the shape Carolyn described ("they just toggle the button").
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
  --
  -- ⚠️ THIS LINE IS WHY NOTHING BELOW RE-CHECKS THE ROLE. crm_contact_scope() asks this
  -- function for the contacts level and compares it to 'own'; an owner can never produce
  -- that string, so owners are absolute in the RLS layer for free — by construction rather
  -- than by a second test somebody could forget to copy into the next policy.
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
  'Pure mirror of effectiveAccess() in supabase/functions/_shared/access.ts: the title preset merged with the stored per-area deviations, owners absolute. MUST be changed in the same commit as that file — scripts/preflight.mjs cross-checks the two area lists on every push (migration 193 widened contacts to none/own/view/edit). Reads no tables, so it is safe to call for preview/audit.';

revoke execute on function public.area_level_for(text, text, jsonb, text) from public, anon;
grant  execute on function public.area_level_for(text, text, jsonb, text) to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — the predicate, its two call forms, and the scope resolver.
--
-- FOUR functions and exactly ONE rule between them. crm_contact_visible_to() IS the rule;
-- crm_contact_mine() asks it about the signed-in caller (for RLS) and
-- crm_visible_contact_ids() asks it about a named user for a list of ids (for the
-- service-role edge functions); crm_contact_scope() only decides whether to ask at all.
-- Splitting the RULE any further is how a permission model starts lying — _shared/access.ts
-- says so in its own header and this schema has the receipts (the k_areas drift 183
-- repaired). Splitting the CALL FORMS is a privilege boundary, which is a different thing:
-- see the grants under each.
-- ═════════════════════════════════════════════════════════════════════════════════════════

-- ── THE RULE ─────────────────────────────────────────────────────────────────────────────
-- "if they are not assigned to or following that customer, they can't see anything of it"
-- (Carolyn, 2026-09-04 @1:09:30), plus edge case 1 from the header: an UNASSIGNED customer
-- belongs to everyone, because nobody has decided yet and "not yet decided" is not "no".
--
-- SECURITY DEFINER for three separate reasons, all of which apply:
--   * it is called from a policy ON crm_contacts and reads crm_contacts. As an INVOKER
--     function that is a policy consulting itself. As a definer owned by the migration role
--     it bypasses RLS and the question does not arise.
--     ⛔ If anyone ever puts `alter table public.crm_contacts force row level security` on
--     this table, that bypass stops applying and this becomes infinite recursion. Do not.
--   * crm_contact_followers is `revoke all … grant select to authenticated` with one
--     tenant-scoped policy (189). A policy that leaned on that policy would be two access
--     models stacked, and the inner one would be invisible in any explain plan.
--   * the batch form below runs as the service role on behalf of a NAMED user, so it must be
--     able to answer about somebody who is not the caller.
--
-- NOT tenant-scoped, on purpose: every call site has already constrained the row to one
-- tenant (the permissive tenant policy for RLS; an explicit client_id filter for the batch
-- form, which is the argument it takes). Re-deriving the tenant here would be a second,
-- slower copy of a check that is structurally already made.
create or replace function public.crm_contact_visible_to(
  p_contact_id uuid,
  p_user_id    uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  -- p_contact_id IS NULL -> false. THIS IS EDGE CASE 2, and it is the whole implementation
  -- of it: a design or lead with no customer has nobody to own it, so it stays with the
  -- people who are never narrowed. Written as an explicit `is not null` rather than left to
  -- the `exists` (which would also return false) so that deleting this line reads as the
  -- decision it would be.
  select p_contact_id is not null
     and exists (
       select 1
         from public.crm_contacts c
        where c.id = p_contact_id
          and (
            -- 1. Nobody's yet. Everybody's.
            c.owner_user_id is null
            -- 2. Assigned to them (crm_contacts.owner_user_id, writable since 188).
            or c.owner_user_id = p_user_id
            -- 3. Following them (189 — and crm_quote_assign auto-follows the rep who saves
            --    a quote, which is what makes "the quotes they created themselves" work
            --    without anybody having to remember to tick a box).
            or exists (
              select 1
                from public.crm_contact_followers f
               where f.contact_id = c.id
                 and f.user_id    = p_user_id
            )
          )
     );
$fn$;

comment on function public.crm_contact_visible_to(uuid, uuid) is
  'THE row-visibility rule for the contacts:''own'' access level (migration 193, Carolyn 2026-09-04): true when the contact is unassigned, assigned to this user, or followed by them. A NULL contact id is false — a design or lead with no customer has no owner. Not callable by a browser: the policies go through crm_contact_mine(uuid) and the edge functions through crm_visible_contact_ids.';

-- SERVICE ROLE ONLY, even though the policies below need this rule. It takes an ARBITRARY
-- p_user_id, so granting it to `authenticated` would answer "does my colleague own or follow
-- this customer?" for any pair of ids a rep holds — which is the exact fact Carolyn reserved
-- to the owner ("only the owner would see 'okay, this customer went through employee B and
-- C'"). The policies call the one-argument wrapper below instead, which cannot be pointed at
-- anyone but the caller. `from public` as well as the named roles: the PUBLIC grant survives
-- revoking anon and authenticated, and PUBLIC is what every role inherits.
revoke execute on function public.crm_contact_visible_to(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.crm_contact_visible_to(uuid, uuid) to service_role;

-- ── THE POLICY FORM ──────────────────────────────────────────────────────────────────────
-- The same rule, permanently aimed at the CALLER. One argument is the whole security
-- property: there is no id to substitute, so the worst a signed-in person can learn from it
-- is what their own screen would already have shown them.
--
-- SECURITY DEFINER again, and it has to be: it calls a function `authenticated` may not
-- execute, and inside a definer function the current role is the owner, which may.
create or replace function public.crm_contact_mine(p_contact_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.crm_contact_visible_to(p_contact_id, (select auth.uid()));
$fn$;

comment on function public.crm_contact_mine(uuid) is
  'May the SIGNED-IN caller see this contact under the contacts:''own'' rule (migration 193)? The one-argument, caller-pinned form of crm_contact_visible_to — the two-argument version is service-role only so a rep cannot probe who else owns or follows a customer.';

revoke execute on function public.crm_contact_mine(uuid) from public, anon;
grant  execute on function public.crm_contact_mine(uuid) to authenticated, service_role;

-- ── IS THE SIGNED-IN CALLER NARROWED AT ALL? ─────────────────────────────────────────────
-- Returns 'own' or 'all'. Same shape, same posture and the same client_users read as 154's
-- current_area_level, and the same FAIL-OPEN on absence for the reason set out in the header.
--
-- Deliberately answers a BOOLEAN question rather than returning the level: the policies only
-- ever need "is this person narrowed", and a resolver that handed back 'view' or 'edit' would
-- invite a future policy to make an access decision out of it, which is current_area_level's
-- job and not this one's.
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

  if public.area_level_for(v_role, v_title, v_access, 'contacts') = 'own' then
    return 'own';
  end if;
  return 'all';
end
$fn$;

comment on function public.crm_contact_scope() is
  'Is the signed-in caller limited to the customers they own or follow? ''own'' or ''all'' (migration 193). Owners always resolve ''all'', structurally: area_level_for short-circuits role=owner to edit before it looks at any stored map. A caller with no client_users row resolves ''all'', because the tenant policy already denies them every row.';

revoke execute on function public.crm_contact_scope() from public, anon;
grant  execute on function public.crm_contact_scope() to authenticated, service_role;

-- ── THE BATCH FORM, FOR THE EDGE FUNCTIONS ───────────────────────────────────────────────
-- ⚠️ WHY THIS EXISTS AT ALL: every edge function connects with the service role, which is
-- BYPASSRLS. Not one policy in PART 3 applies to portal-settings, portal-schedule or any of
-- the others — so the filter has to be written by hand at each read, and this is what those
-- reads call. Without it the same rule would be transcribed into TypeScript and would drift
-- from the SQL the browser is held to, which is the failure this file's PART 1 exists to
-- prevent one layer up.
--
-- Takes and returns an ARRAY rather than being called per row: it is one round trip for a
-- list of any size, and it goes over POST so there is no URL-length ceiling to hit the day
-- somebody opens an Orders tab with two thousand rows on it.
--
-- p_client_id is the tenant guard the predicate deliberately does not carry. The ids reaching
-- here come from caller-supplied short codes, so the check has to be somewhere.
create or replace function public.crm_visible_contact_ids(
  p_client_id text,
  p_user_id   uuid,
  p_ids       uuid[]
) returns uuid[]
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(array_agg(c.id), '{}'::uuid[])
    from public.crm_contacts c
   where c.client_id = p_client_id
     and c.id = any(p_ids)
     and public.crm_contact_visible_to(c.id, p_user_id);
$fn$;

comment on function public.crm_visible_contact_ids(text, uuid, uuid[]) is
  'Which of these contact ids may that user see, under the contacts:''own'' rule (migration 193)? The service-role batch form of crm_contact_visible_to, for edge functions — which are BYPASSRLS and therefore get nothing from the policies below. Tenant-scoped by p_client_id.';

-- Service role ONLY. `authenticated` must not hold this: it takes an arbitrary p_user_id and
-- would let any signed-in person ask whose customers somebody else can see. `from public` as
-- well as the named roles — the PUBLIC grant survives revoking anon and authenticated, and
-- PUBLIC is what every role inherits (189's header, and every function revoke in this schema).
revoke execute on function public.crm_visible_contact_ids(text, uuid, uuid[]) from public, anon, authenticated;
grant  execute on function public.crm_visible_contact_ids(text, uuid, uuid[]) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — the policies. THE ONLY PART THAT CHANGES BEHAVIOUR.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Same three flags, same reasons, as 154:494-517 — read that block before editing these:
--
--   `as restrictive`   narrows. A permissive twin would OR in and WIDEN.
--   `for select`       reads only. Writes to these tables go through SECURITY DEFINER RPCs
--                      (save_design, crm_ensure_contact, crm_update_contact) or the service
--                      role, and not one of them is touched.
--   `to authenticated` the ONLY role this applies to. A restrictive policy is not evaluated
--                      for a role it does not list, which is what keeps anon (the public
--                      designer), the customer portal and every edge function's service-role
--                      client behaving exactly as they do today.
--
-- These stack with 154's `*_area_select` policies rather than replacing them: 154 answers
-- "may you see this TABLE", these answer "may you see this ROW". Both are restrictive, so
-- both must pass. Separate policies rather than one edited policy so that either can be
-- dropped without disturbing the other.
--
-- ⚠️ WHY `case` AND NOT `or`. The scope test is hoisted into an InitPlan by the `(select …)`
-- wrapper — the standard trick, and the same one 154 uses on `(select auth.uid())` — so it is
-- evaluated once per query rather than once per row. `case` then GUARANTEES that the per-row
-- predicate is not evaluated at all when the answer is already 'all', which is every caller
-- on every tenant today. Written as `A or B` the planner is free to cost B first, and B is a
-- SECURITY DEFINER function doing two index lookups per row; on a Pipeline read of a few
-- thousand designs that is the difference between free and noticeable.

drop policy if exists crm_contacts_own_select on public.crm_contacts;
create policy crm_contacts_own_select on public.crm_contacts
  as restrictive for select to authenticated
  using (
    case when (select public.crm_contact_scope()) = 'own'
         then public.crm_contact_mine(crm_contacts.id)
         else true
    end
  );

-- The Pipeline. designs.contact_id is stamped by save_design (133) and backfilled by 130;
-- NULL means "no phone and no email were given", which is edge case 2 and is hidden.
drop policy if exists designs_own_select on public.designs;
create policy designs_own_select on public.designs
  as restrictive for select to authenticated
  using (
    case when (select public.crm_contact_scope()) = 'own'
         then public.crm_contact_mine(designs.contact_id)
         else true
    end
  );

-- Browsing leads: people who passed the public designer's gate but never submitted (062).
-- capture-lead stamps contact_id at capture time and 176 backfilled the gap, so a NULL here
-- is the same rare shape as on designs — a person who gave neither a phone nor an email.
drop policy if exists captured_leads_own_select on public.captured_leads;
create policy captured_leads_own_select on public.captured_leads
  as restrictive for select to authenticated
  using (
    case when (select public.crm_contact_scope()) = 'own'
         then public.crm_contact_mine(captured_leads.contact_id)
         else true
    end
  );

-- NOT POLICIED HERE, and each omission is a decision:
--   * design_versions — see the header's KNOWN GAP. The policy would be
--       using (case when (select public.crm_contact_scope()) = 'own'
--                   then exists (select 1 from public.designs d
--                                 where d.short_code = design_versions.short_code
--                                   and d.client_id  = design_versions.client_id
--                                   and public.crm_contact_mine(d.contact_id))
--                   else true end)
--     ...wrapped in its OWN security-definer function, because that `exists` reads
--     public.designs from inside a policy and would otherwise run through designs' own
--     policies — including the one directly above it. Note crm_contact_mine, not the
--     two-argument predicate: `authenticated` may not execute that one (see PART 2).
--   * inventory_units — a building on the lot belongs to the builder, not to a customer.
--     Narrowing it would hide the shared stock list from the very reps who sell from it.
--   * crm_notes / crm_activities / crm_field_changes / crm_contact_followers /
--     crm_contact_people — none is read directly from the browser; every one of them is
--     reached through portal-settings, which resolves the area itself. 189's header states
--     the rule and 131 decided it: a policy guarding nothing is a second copy of the
--     permission model, and this schema already knows what those cost. The day one of these
--     is read straight from the browser, add the policy in that commit.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — apply-time assertions. These RAISE, which aborts the transaction and takes PARTS
--          1-3 with it. That is the point: every failure mode below is SILENT at runtime.
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  r record;
begin
  -- ── The level itself ──────────────────────────────────────────────────────────────────
  -- OWNERS ABSOLUTE, from both directions: the plain case, and the case where somebody has
  -- managed to store 'own' on an owner's row. The second is the one that matters — it is the
  -- assertion that an owner's dashboard cannot be emptied by data.
  if public.area_level_for('owner', 'owner', null, 'contacts') <> 'edit' then
    raise exception 'area_level_for: an owner must resolve contacts=edit';
  end if;
  if public.area_level_for('owner', 'owner', '{"contacts":"own"}'::jsonb, 'contacts') <> 'edit' then
    raise exception 'area_level_for: a stored contacts=own must NOT narrow an owner';
  end if;

  -- Nobody is narrowed by applying this file: the presets did not move.
  if public.area_level_for('user', 'sales_rep', null, 'contacts') <> 'edit' then
    raise exception 'area_level_for: the sales_rep contacts preset moved — applying this migration would narrow every rep on every tenant';
  end if;
  if public.area_level_for('user', 'admin', null, 'contacts') <> 'edit' then
    raise exception 'area_level_for: the admin contacts preset moved';
  end if;

  -- The new level resolves, so the Team switch actually does something...
  if public.area_level_for('user', 'sales_rep', '{"contacts":"own"}'::jsonb, 'contacts') <> 'own' then
    raise exception 'area_level_for: a stored contacts=own must resolve';
  end if;
  -- ...and the OLD one still does. This is the assertion behind "added, not substituted":
  -- if it ever fails, someone has dropped "view" and every stored view override has silently
  -- fallen back to the title preset.
  if public.area_level_for('user', 'crew_leader', '{"contacts":"view"}'::jsonb, 'contacts') <> 'view' then
    raise exception 'area_level_for: contacts=view must still resolve — dropping it silently demotes everyone who holds it';
  end if;
  -- An invalid level keeps the preset and must never blank it.
  if public.area_level_for('user', 'sales_rep', '{"contacts":"sideways"}'::jsonb, 'contacts') <> 'edit' then
    raise exception 'area_level_for: an unknown contacts level must fall back to the preset';
  end if;

  -- A spot check that re-issuing did not disturb anything else (183's list, kept).
  if public.area_level_for('user', 'driver', null, 'delivery_schedule') <> 'edit' then
    raise exception 'area_level_for: the driver preset moved';
  end if;
  if public.area_level_for('user', 'admin', null, 'change_orders') <> 'edit'
     or public.area_level_for('user', 'sales_rep', null, 'change_orders') <> 'none' then
    raise exception 'area_level_for: the change_orders preset moved';
  end if;
  if public.area_level_for('owner', 'owner', null, 'projects') <> 'edit'
     or public.area_level_for('user', 'admin', null, 'projects') <> 'none' then
    raise exception 'area_level_for: the projects rules moved';
  end if;
  if public.area_level_for('user', 'admin', '{"settings_billing":"edit"}'::jsonb, 'settings_billing') <> 'edit'
     or public.area_level_for('user', 'sales_rep', '{"settings_billing":"edit"}'::jsonb, 'settings_billing') <> 'none' then
    raise exception 'area_level_for: the ownerGranted rule moved';
  end if;
  if public.area_level_for('user', 'admin', '{"settings_team":"none"}'::jsonb, 'settings_team') <> 'edit' then
    raise exception 'area_level_for: the byTitleOnly rule moved';
  end if;

  -- ── The predicate ─────────────────────────────────────────────────────────────────────
  -- Edge case 2, asserted with no data at all: no customer, no visibility. A boolean
  -- function that started returning NULL here would make the policies deny everything, which
  -- from the outside looks exactly like the feature working.
  -- Fixed uuids rather than gen_random_uuid(), so a failure names the same inputs twice and
  -- the assertion cannot become flaky. Both are the zero uuid's neighbourhood; crm_contacts
  -- ids are v4, so neither can collide with a real row.
  if public.crm_contact_visible_to(null::uuid, '00000000-0000-0000-0000-000000000001'::uuid) is not false then
    raise exception 'crm_contact_visible_to: a NULL contact id must be false, not % (edge case 2: a design with no customer is owner/admin only)',
      coalesce(public.crm_contact_visible_to(null::uuid, '00000000-0000-0000-0000-000000000001'::uuid)::text, 'NULL');
  end if;
  -- A contact that does not exist is not visible either. Same shape, different cause, and
  -- the one that would bite if the `exists` were ever inverted.
  if public.crm_contact_visible_to('00000000-0000-0000-0000-000000000002'::uuid,
                                   '00000000-0000-0000-0000-000000000001'::uuid) is not false then
    raise exception 'crm_contact_visible_to: an unknown contact id must be false';
  end if;
  -- The batch form agrees with the predicate on the empty case, and returns an array rather
  -- than NULL — a NULL here would make every edge-function filter treat every row as hidden.
  if public.crm_visible_contact_ids('does-not-exist',
                                    '00000000-0000-0000-0000-000000000001'::uuid,
                                    array[]::uuid[]) is distinct from '{}'::uuid[] then
    raise exception 'crm_visible_contact_ids: an empty input must return an empty array, never NULL';
  end if;

  -- ── The policies ──────────────────────────────────────────────────────────────────────
  -- Landed, RESTRICTIVE, SELECT-only, authenticated-only. A permissive twin would WIDEN
  -- access instead of narrowing it; a role list containing anon or service_role would break
  -- the public designer and every edge function. 154 PART 4's check, on this file's policies.
  for r in
    select * from (values
      ('crm_contacts',   'crm_contacts_own_select'),
      ('designs',        'designs_own_select'),
      ('captured_leads', 'captured_leads_own_select')
    ) as t(tbl, pol)
  loop
    perform 1
       from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = r.tbl
        and p.policyname = r.pol
        and p.permissive = 'RESTRICTIVE'
        and p.cmd        = 'SELECT'
        and p.roles      = '{authenticated}'::name[];
    if not found then
      raise exception
        'migration 193: policy %.% did not land as a RESTRICTIVE, SELECT-only, authenticated-only policy. A permissive twin widens instead of narrowing.',
        r.tbl, r.pol;
    end if;

    -- The permissive tenant policy is still there. A table carrying only RESTRICTIVE
    -- policies matches nothing at all: every authenticated read returns zero rows. Nothing
    -- in this file drops one — this catches the day something else does. (154 PART 4 #3.)
    perform 1
       from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = r.tbl
        and p.permissive = 'PERMISSIVE'
        and p.cmd in ('SELECT', 'ALL')
        and p.roles && '{authenticated,public}'::name[];
    if not found then
      raise exception
        'migration 193: public.% has no permissive SELECT policy for authenticated. A restrictive policy on top of nothing denies the table outright.',
        r.tbl;
    end if;

    -- ⛔ FORCE ROW LEVEL SECURITY IS OFF, and for this file that is not only 154's concern
    -- (the SECURITY DEFINER capability RPCs) but a HARD requirement of the design:
    -- crm_contact_visible_to reads public.crm_contacts and is called from the policy ON
    -- public.crm_contacts. Its definer bypass is the only thing standing between that and
    -- infinite recursion. If this ever fires, do not "fix" it by forcing RLS anyway.
    if exists (
      select 1
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = r.tbl and c.relforcerowsecurity
    ) then
      raise exception
        'migration 193: public.% has FORCE ROW LEVEL SECURITY on. crm_contact_visible_to would then recurse through the very policy that calls it. Resolve before applying.',
        r.tbl;
    end if;
  end loop;

  -- 154's policies must still be there. These two layers are independent and the row rule is
  -- NOT a replacement for the table rule: without the area policies, contacts:'none' reads
  -- everything again the moment somebody assumes this file covers it.
  for r in
    select * from (values
      ('crm_contacts',   'crm_contacts_area_select'),
      ('designs',        'designs_area_select'),
      ('captured_leads', 'captured_leads_area_select')
    ) as t(tbl, pol)
  loop
    perform 1 from pg_catalog.pg_policies p
      where p.schemaname = 'public' and p.tablename = r.tbl and p.policyname = r.pol;
    if not found then
      raise exception
        'migration 193: 154''s area policy %.% is missing. The row rule stacks WITH it and does not replace it — contacts:''none'' would read the whole table.',
        r.tbl, r.pol;
    end if;
  end loop;

  -- ── The posture ───────────────────────────────────────────────────────────────────────
  -- SECURITY DEFINER on all four, or the crm_contacts policy consults itself, the followers
  -- read leans on 189's own policy, and crm_contact_mine cannot reach the predicate it wraps.
  if (select count(*) from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('crm_contact_visible_to', 'crm_contact_mine',
                           'crm_contact_scope', 'crm_visible_contact_ids')
         and p.prosecdef) <> 4 then
    raise exception 'migration 193: all four helpers must be SECURITY DEFINER';
  end if;

  -- THE TWO FUNCTIONS THAT TAKE AN ARBITRARY USER ID ARE SERVICE-ROLE ONLY. If `authenticated`
  -- can execute either, any signed-in person can ask whose customers a colleague owns or
  -- follows — the fact Carolyn reserved to the owner. Checked with has_function_privilege
  -- rather than by trusting the revoke statements, because the PUBLIC grant is the one that
  -- survives revoking the named roles: this asks the effective answer.
  if has_function_privilege('authenticated', 'public.crm_visible_contact_ids(text, uuid, uuid[])', 'execute')
     or has_function_privilege('anon', 'public.crm_visible_contact_ids(text, uuid, uuid[])', 'execute') then
    raise exception 'migration 193: crm_visible_contact_ids must be service_role only — revoke from PUBLIC as well as from the named roles';
  end if;
  if has_function_privilege('authenticated', 'public.crm_contact_visible_to(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.crm_contact_visible_to(uuid, uuid)', 'execute') then
    raise exception 'migration 193: the two-argument crm_contact_visible_to must be service_role only — the policies use crm_contact_mine(uuid), which cannot be aimed at another person';
  end if;
  -- ...and the one-argument form MUST be reachable, or every policy above raises
  -- "permission denied for function" and the three tables read as empty for everyone.
  if not has_function_privilege('authenticated', 'public.crm_contact_mine(uuid)', 'execute') then
    raise exception 'migration 193: authenticated must be able to execute crm_contact_mine — without it every policy above denies the whole table';
  end if;
end
$$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 🚨 AFTER APPLYING — the three things this migration cannot check for itself.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- 1. REDEPLOY ALL TEN access.ts CONSUMERS TOGETHER. _shared/access.ts is bundled per
--    function, so leaving one behind means two copies of the permission model disagreeing
--    about what levels `contacts` has — and the one left behind would DISCARD a stored
--    'own' override and resolve that person to 'edit', i.e. hand them everybody's customers
--    through whichever endpoint was missed. Derive the list, do not trust a written one
--    (CLAUDE.md has the multiline-aware recipe; `grep -rl` over-counts by two):
--      portal-billing, portal-commissions, portal-payments, portal-projects, portal-schedule,
--      portal-settings, portal-setup, portal-sms, qbo-oauth-connect, sync-design-status
--
-- 2. PROVE IT ON A REAL SESSION, not with curl. Sign in as a rep set to contacts:'own' on an
--    internal tenant, open the Pipeline, and confirm the list shrinks; then confirm an OWNER
--    on the same tenant still sees everything. Both halves — a filter that empties the
--    owner's dashboard passes every test that only checks the rep.
--
-- 3. TEAM SCREEN LABEL. portal/08-integrations.jsx's ssLevelLabel() has a special case for
--    commissions and falls through to the raw level string for everything else, so the new
--    switch renders as a button reading "own". It wants the same treatment:
--      if (areaKey === "contacts") return ({ none: "No access", own: "Own only",
--                                            view: "View", edit: "Edit" })[lv] || lv;
--    Cosmetic, and not in this change's file set.
