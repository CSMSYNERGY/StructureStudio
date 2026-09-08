-- 194_area_access_rls_extend: eleven more tenant-readable tables join the area-guarded set
--                             that 154 created and 164 first extended. Audit finding F112.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. Wrap the whole file in
--    begin;/commit; — PART 2's assertions are worth having only if a failure takes the
--    policies with it.
--
-- Like 154, this migration can take rows AWAY from a signed-in builder, and a wrong area key
-- does not throw — it silently empties a screen for a real business. Read PART 0, run its
-- queries against live data, and decide before PART 1 is applied.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- 154 gave per-area access a server representation and moved five tables behind it. 164 moved
-- a sixth (sms_messages) and said in its own header that it was not fixing RLS, that "34
-- tenant-readable tables carry no restrictive guard", and that the rest was "a separate,
-- deliberate audit". This is that audit's first instalment: every remaining table whose
-- contents are as sensitive as the ones 154 and 164 already guard.
--
-- The state each of these eleven is in today is identical, and it is the pre-154 posture:
-- RLS on, exactly one policy, `client_id = public.current_client_id()`, and a SELECT grant to
-- `authenticated` (explicit for the six CRM/billing/acceptance tables, inherited from
-- Supabase's default privileges for the five scheduling ones — 112's lesson, which those
-- migrations predate). So ANY signed-in member of the tenant can read all of them directly
-- over PostgREST regardless of their per-area access:
--
--   135_email_inbound.sql:72          email_inbound_owner_select        customer email bodies
--   131_crm_notes_activities.sql:87   crm_notes_owner_select            internal notes on people
--   131_crm_notes_activities.sql:90   crm_activities_owner_select       follow-up tasks
--   143_crm_field_changes.sql:41      crm_field_changes_owner_select    contact edit history
--   124_customer_acceptance.sql:67    design_acceptances_owner_select   e-signature evidence
--   050_billing.sql:57                billing_subscriptions_owner_read  the tenant's plan
--   087_scheduling_core.sql:82        build_jobs_owner_select           build board
--   087_scheduling_core.sql:102       schedule_activity_owner_select    crew accountability log
--   089_repairs.sql:40                repairs_owner_select              service jobs
--   090_delivery_loads.sql:50         delivery_loads_owner_select       loads
--   090_delivery_loads.sql:115        delivery_stops_owner_select       stops, with site notes
--
-- 154's finding was that the tab clamp in the browser was the only gate. That is still true of
-- these eleven, and _shared/access.ts:12 still says why it is not a gate: "the UI hiding a tab
-- is a courtesy, not a control".
--
-- ── THE OBJECTION 131 RAISED, AND WHY IT NO LONGER HOLDS ──────────────────────────────────
-- 131_crm_notes_activities.sql:72-77 declined this guard ON PURPOSE and said so: expressing an
-- AREA in a policy "would mean a second SQL copy of the preset table", and access.ts is
-- explicit that one definition is the whole point. That reasoning was correct in 2026-08 and
-- is spent now — 154 built the mirror anyway, weighed exactly that cost in its header, and 183
-- re-issued it with the two areas it had already lost. The second copy exists whether or not
-- these tables use it, so declining to use it buys nothing and leaves the notes readable.
--
-- ⚠️ The mirror still has to be kept in step by hand. 183's header and CLAUDE.md both say
-- scripts/preflight.mjs cross-checks the TypeScript area list against the SQL on every push;
-- as of this migration that check is NOT in scripts/preflight.mjs. Do not rely on it to catch
-- a drift. Adding an area to AREAS still means editing area_level_for in the same commit.
--
-- ── AREA MAP, AND WHY EACH ONE ───────────────────────────────────────────────────────────
-- The rule is the one 154 set and portal/01-core.jsx's TAB_AREA encodes: a table gates on the
-- area of the SCREEN THAT READS IT, so the tab and its data gate alike. Where a table has no
-- screen at all, it gates on the area that owns the feature.
--
--   email_inbound         contacts            same content and same reasoning as sms_messages
--   crm_notes             contacts            in 164 — the customer conversation and the notes
--   crm_activities        contacts            about a person. All four are read only by
--   crm_field_changes     contacts            _shared/crmFeed.ts, on the service role.
--
--   design_acceptances    orders              ⚠️ NOT 'designs'. See the note below.
--
--   billing_subscriptions settings_billing    the owner-granted billing model (access.ts's
--                                             ownerGranted flag): an owner always, and the one
--                                             admin they have granted the card to. Nothing in
--                                             the browser reads this table; entitlement is
--                                             computed in portal-billing on the service role.
--
--   build_jobs            build_schedule      TAB_AREA's own mapping for the three schedule
--   delivery_loads        delivery_schedule   pages. portal/05-schedule.jsx makes ZERO direct
--   delivery_stops        delivery_schedule   reads and the Orders page's Schedule column goes
--   repairs               repairs             through portal-schedule's `schedule_links`
--                                             action (04-orders.jsx:1510), so no screen loses
--                                             anything.
--
--   schedule_activity     per row, by subject — build_job -> build_schedule,
--                         load/stop -> delivery_schedule, repair -> repairs. It is one log
--                         across three areas and a single area key would be wrong in two
--                         directions at once.
--
-- ⚠️ design_acceptances GATES ON 'orders', AND THE OBVIOUS-LOOKING 'designs' WOULD BREAK A
--    SCREEN. 154's THE WALK recorded that nothing mounted OrdersView for tenants; that changed
--    on 2026-09-01 (portal/12-shell.jsx:1413-1425 records the change and cites 154 by line).
--    OrdersView now mounts for anyone holding orders — which includes a crew leader and a
--    driver — and its order document reads design_acceptances DIRECTLY at
--    portal/04-orders.jsx:3077 to render "signed by NAME on DATE". Gating that table on
--    'designs' would hand a driver an empty array with `error === null`, the `aRes.error`
--    branch on the next line would not fire, and the signature block would silently vanish
--    from a document that is otherwise complete. Every shipped preset holds orders >= 'view',
--    so this policy narrows nobody today; it makes the switch mean something for a hand-set
--    override, and it puts the table in the guarded set so the next reader can see that it is
--    covered.
--
--    What it does NOT close is COLUMN-level: the row carries `ip`, `user_agent`,
--    `phone_digits` and `typed_signature`, which the browser's select list at :3078
--    deliberately omits and a devtools `select("*")` would not. RLS is row-level and cannot
--    express that. Narrowing it needs a column grant (or a view) on 124's table plus a pinned
--    select list in the portal, which is a different change in different files.
--
-- ── WHO ACTUALLY LOSES SOMETHING ─────────────────────────────────────────────────────────
-- Derived the way 154's WALK was: `grep -n '\.from("' portal/*.jsx structure-studio.component.js`
-- for every direct PostgREST read in the product, then portal/12-shell.jsx's render block for
-- which component each tab MOUNTS. RE-DERIVE IT rather than trusting this list — 154's
-- equivalent table listed eight direct reads and there are now far more, which is how
-- consequence 1 in that file came true.
--
-- NOT ONE of these eleven tables appears in that grep, EXCEPT design_acceptances, which is the
-- paragraph above. So:
--
--   OWNER        loses nothing — area_level_for returns 'edit' before the access map is read.
--   ADMIN        loses the direct read of billing_subscriptions unless an owner has granted
--                them Billing. No screen reads it; the Billing tab is portal-billing, service
--                role, and its entitlement call fails OPEN, so a lock is not reachable here.
--   SALES_REP    loses build_jobs, delivery_loads, delivery_stops, repairs, schedule_activity,
--                billing_subscriptions. No tab they can open reads any of them.
--   CREW_LEADER  loses the four contacts tables, delivery_loads/stops, billing_subscriptions,
--                and the load/stop rows of schedule_activity. Contacts is hidden from them by
--                the same area; Build Schedule and Repairs are portal-schedule end to end.
--   DRIVER       loses the four contacts tables, build_jobs, repairs, billing_subscriptions,
--                and the build_job/repair rows of schedule_activity. Delivery Schedule is
--                portal-schedule end to end and Orders keeps design_acceptances.
--
-- So no shipped preset loses a row it can currently see, which is the same bar 154 set.
--
-- ── SAFETY PROPERTIES (unchanged from 154 — the same mechanism, the same guarantees) ──────
--   Owners            area_level_for returns 'edit' before the access map is read.
--   Service role      the policies are `to authenticated`; a restrictive policy is not
--                     evaluated for a role it does not name, and service_role carries
--                     BYPASSRLS. Every TABLE read in every edge function goes through it. The
--                     anon-key clients that exist (_shared/resolveTenant, _shared/adminAuth,
--                     portal-commissions, portal-feedback, portal-projects, operator-portal,
--                     admin-import-monday) call auth.getUser() and nothing else — check with
--                     `grep -rn 'userClient\.' supabase/functions` before assuming otherwise.
--   anon / customers  same reason, plus the customer portal holds no Supabase auth session at
--                     all (customer_sessions, migration 108).
--   Absent data       no client_users row resolves OPEN in current_area_level, and cannot
--                     widen anything: current_client_id() reads the same row, so the
--                     permissive tenant policy has already returned nothing.
--   Typo'd area key   PART 2 aborts the migration.
--   restrictive       load-bearing. Permissive policies OR together, so a permissive twin
--                     would WIDEN these tables instead of narrowing them. PART 2 refuses to
--                     finish if any policy did not land RESTRICTIVE, SELECT-only and
--                     authenticated-only.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 0 — DO THIS FIRST
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- PANIC BUTTON. If a builder reports an empty screen after this ships, restore today's
-- behaviour instantly. The eleven drops are independent, and safe to run alone in any order:
--
--   drop policy if exists email_inbound_area_select         on public.email_inbound;
--   drop policy if exists crm_notes_area_select             on public.crm_notes;
--   drop policy if exists crm_activities_area_select        on public.crm_activities;
--   drop policy if exists crm_field_changes_area_select     on public.crm_field_changes;
--   drop policy if exists design_acceptances_area_select    on public.design_acceptances;
--   drop policy if exists billing_subscriptions_area_select on public.billing_subscriptions;
--   drop policy if exists build_jobs_area_select            on public.build_jobs;
--   drop policy if exists delivery_loads_area_select        on public.delivery_loads;
--   drop policy if exists delivery_stops_area_select        on public.delivery_stops;
--   drop policy if exists repairs_area_select               on public.repairs;
--   drop policy if exists schedule_activity_area_select     on public.schedule_activity;
--
-- PRECONDITION. 154 and 183 must already be applied — this file adds policies only, and
-- installs no function of its own:
--
--   select public.area_level_for('owner','owner',null,'orders');            -- edit
--   select public.area_level_for('user','sales_rep',null,'change_orders');  -- none (183 is in)
--
-- BLAST RADIUS. Every person who can sign in and what each of them will be able to read.
-- area_level_for is a PURE function of the row, so this preview is exact, not a guess:
--
--   select cu.client_id, cu.role, cu.title,
--          public.area_level_for(cu.role, cu.title, cu.access, 'contacts')          as contacts,
--          public.area_level_for(cu.role, cu.title, cu.access, 'orders')            as orders,
--          public.area_level_for(cu.role, cu.title, cu.access, 'build_schedule')    as build_sched,
--          public.area_level_for(cu.role, cu.title, cu.access, 'delivery_schedule') as del_sched,
--          public.area_level_for(cu.role, cu.title, cu.access, 'repairs')           as repairs,
--          public.area_level_for(cu.role, cu.title, cu.access, 'settings_billing')  as billing,
--          cu.user_id
--     from public.client_users cu
--    order by cu.client_id, cu.title, cu.role;
--
-- THE NUMBER TO TAKE TO THE PRODUCT OWNER BEFORE APPLYING — how many people per tenant fall
-- to 'none' on each guarded area. Every one of them keeps every screen (see WHO ACTUALLY
-- LOSES SOMETHING above); this is the count to re-check, not a damage report:
--
--   select cu.client_id,
--          count(*) filter (where public.area_level_for(cu.role, cu.title, cu.access, 'contacts')          = 'none') as lose_contacts,
--          count(*) filter (where public.area_level_for(cu.role, cu.title, cu.access, 'orders')            = 'none') as lose_orders,
--          count(*) filter (where public.area_level_for(cu.role, cu.title, cu.access, 'build_schedule')    = 'none') as lose_build,
--          count(*) filter (where public.area_level_for(cu.role, cu.title, cu.access, 'delivery_schedule') = 'none') as lose_delivery,
--          count(*) filter (where public.area_level_for(cu.role, cu.title, cu.access, 'repairs')           = 'none') as lose_repairs,
--          count(*) filter (where public.area_level_for(cu.role, cu.title, cu.access, 'settings_billing')  = 'none') as lose_billing,
--          count(*)                                                                                                 as people
--     from public.client_users cu
--    group by cu.client_id
--    order by 1;
--
-- BASELINE. Capture the numbers this migration must not change for an OWNER, per user, BEFORE
-- applying PART 1. PART 3 re-runs the identical block afterwards and the two are diffed:
--
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<USER_UUID>","role":"authenticated"}';
--     select (select count(*) from public.email_inbound)         as inbound,
--            (select count(*) from public.crm_notes)             as notes,
--            (select count(*) from public.crm_activities)        as activities,
--            (select count(*) from public.crm_field_changes)     as field_changes,
--            (select count(*) from public.design_acceptances)    as acceptances,
--            (select count(*) from public.billing_subscriptions) as subscriptions,
--            (select count(*) from public.build_jobs)            as build_jobs,
--            (select count(*) from public.delivery_loads)        as loads,
--            (select count(*) from public.delivery_stops)        as stops,
--            (select count(*) from public.repairs)               as repairs,
--            (select count(*) from public.schedule_activity)     as activity;
--   rollback;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the policies. THE ONLY PART THAT CHANGES BEHAVIOUR.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Each is ANDed with the table's existing permissive tenant policy, so the effective rule
-- becomes:  client_id = current_client_id()  AND  this area is not 'none'.
--
--   `as restrictive`   narrows. A permissive twin would OR in and WIDEN — see the header.
--   `for select`       reads only. Every write to all eleven is service-role already (the
--                      portal-* edge functions and the webhooks), and not one is touched.
--   `to authenticated` names the ONLY role this applies to.
--
-- current_area_level(<constant>) is STABLE with a constant argument, so the planner hoists it
-- into an InitPlan and it is evaluated once per query rather than once per row.

-- ── contacts: the customer conversation and the record of it ─────────────────────────────

drop policy if exists email_inbound_area_select on public.email_inbound;
create policy email_inbound_area_select on public.email_inbound
  as restrictive for select to authenticated
  using (public.current_area_level('contacts') <> 'none');

drop policy if exists crm_notes_area_select on public.crm_notes;
create policy crm_notes_area_select on public.crm_notes
  as restrictive for select to authenticated
  using (public.current_area_level('contacts') <> 'none');

drop policy if exists crm_activities_area_select on public.crm_activities;
create policy crm_activities_area_select on public.crm_activities
  as restrictive for select to authenticated
  using (public.current_area_level('contacts') <> 'none');

drop policy if exists crm_field_changes_area_select on public.crm_field_changes;
create policy crm_field_changes_area_select on public.crm_field_changes
  as restrictive for select to authenticated
  using (public.current_area_level('contacts') <> 'none');

-- ── orders: the signature on the order document ──────────────────────────────────────────
-- 'orders', not 'designs' — see the header. Gating this on 'designs' silently blanks the
-- signature block for a crew leader or a driver on a screen they are meant to have.

drop policy if exists design_acceptances_area_select on public.design_acceptances;
create policy design_acceptances_area_select on public.design_acceptances
  as restrictive for select to authenticated
  using (public.current_area_level('orders') <> 'none');

-- ── settings_billing: the card that pays for the product ─────────────────────────────────
-- ownerGranted, so this resolves for an owner and for an admin an owner has granted, and for
-- nobody else — including a granted admin who is later demoted, because the title check lives
-- in the resolver rather than at the set_access door.

drop policy if exists billing_subscriptions_area_select on public.billing_subscriptions;
create policy billing_subscriptions_area_select on public.billing_subscriptions
  as restrictive for select to authenticated
  using (public.current_area_level('settings_billing') <> 'none');

-- ── the three schedule areas ─────────────────────────────────────────────────────────────

drop policy if exists build_jobs_area_select on public.build_jobs;
create policy build_jobs_area_select on public.build_jobs
  as restrictive for select to authenticated
  using (public.current_area_level('build_schedule') <> 'none');

drop policy if exists delivery_loads_area_select on public.delivery_loads;
create policy delivery_loads_area_select on public.delivery_loads
  as restrictive for select to authenticated
  using (public.current_area_level('delivery_schedule') <> 'none');

drop policy if exists delivery_stops_area_select on public.delivery_stops;
create policy delivery_stops_area_select on public.delivery_stops
  as restrictive for select to authenticated
  using (public.current_area_level('delivery_schedule') <> 'none');

drop policy if exists repairs_area_select on public.repairs;
create policy repairs_area_select on public.repairs
  as restrictive for select to authenticated
  using (public.current_area_level('repairs') <> 'none');

-- ── schedule_activity: one log, three areas, so the guard is per ROW ─────────────────────
-- The subject column (087's check constraint) says which area a row belongs to. A single area
-- key would be wrong twice over: 'build_schedule' hides a driver's own delivery trail, and
-- 'delivery_schedule' hides a crew leader's own build trail.
--
-- ⚠️ FAILS CLOSED ON AN UNKNOWN SUBJECT, deliberately and in the same direction as
-- area_level_for's unknown-area rule: a fifth subject added to 087's check constraint without
-- a branch here is refused rather than waved through. PART 2 asserts no such row exists today,
-- so the day one is added this file has to be revisited on purpose.
--
-- Each current_area_level call still takes a CONSTANT argument, so all three stay hoistable
-- into InitPlans; only the cheap subject comparison is per row.

drop policy if exists schedule_activity_area_select on public.schedule_activity;
create policy schedule_activity_area_select on public.schedule_activity
  as restrictive for select to authenticated
  using (
    (subject = 'build_job'         and public.current_area_level('build_schedule')    <> 'none')
    or (subject in ('load','stop') and public.current_area_level('delivery_schedule') <> 'none')
    or (subject = 'repair'         and public.current_area_level('repairs')           <> 'none')
  );

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — apply-time assertions. These RAISE, which aborts the transaction and takes PART 1
--          with it. That is the point: every failure mode below is SILENT at runtime.
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  r record;
begin
  -- 0. THE RESOLVER EXISTS. This file installs no function; without 154 + 183 every policy
  --    above would fail at first read instead of at apply time.
  if to_regprocedure('public.area_level_for(text,text,jsonb,text)') is null
     or to_regprocedure('public.current_area_level(text)') is null then
    raise exception
      'migration 194: area_level_for/current_area_level are missing — apply 154 (and 183) first.';
  end if;

  for r in
    select * from (values
      ('email_inbound',         'contacts'),
      ('crm_notes',             'contacts'),
      ('crm_activities',        'contacts'),
      ('crm_field_changes',     'contacts'),
      ('design_acceptances',    'orders'),
      ('billing_subscriptions', 'settings_billing'),
      ('build_jobs',            'build_schedule'),
      ('delivery_loads',        'delivery_schedule'),
      ('delivery_stops',        'delivery_schedule'),
      ('repairs',               'repairs'),
      -- schedule_activity appears three times on purpose: assertions 1, 3 and 4 are
      -- idempotent per row, and assertion 2 then checks that its single policy names all
      -- three areas.
      ('schedule_activity',     'build_schedule'),
      ('schedule_activity',     'delivery_schedule'),
      ('schedule_activity',     'repairs')
    ) as t(tbl, area)
  loop
    -- 1. THE AREA KEY IS REAL. An unknown key resolves to 'none' for everyone, owners
    --    included, so one typo would empty the table for an entire tenant with no error
    --    anywhere. The owner probe is an exact discriminator: a known area returns 'edit' for
    --    an owner and an unknown one returns 'none'.
    if public.area_level_for('owner', 'owner', null::jsonb, r.area) <> 'edit' then
      raise exception
        'migration 194: "%" is not an area key in area_level_for (policy on public.%). A typo here denies the table to every user in every tenant.',
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
        'migration 194: policy %_area_select on public.% is missing, or is not a RESTRICTIVE authenticated-only SELECT policy naming area "%".',
        r.tbl, r.tbl, r.area;
    end if;

    -- 3. THE TENANT POLICY IS STILL THERE. A restrictive policy alone matches nothing: with no
    --    permissive policy left, every authenticated read of the table returns zero rows.
    perform 1
       from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = r.tbl
        and p.permissive = 'PERMISSIVE'
        and p.cmd in ('SELECT', 'ALL')
        and p.roles && '{authenticated,public}'::name[];
    if not found then
      raise exception
        'migration 194: public.% has no permissive SELECT policy for authenticated. Adding a restrictive one now would deny the table outright.',
        r.tbl;
    end if;

    -- 4. FORCE ROW LEVEL SECURITY IS OFF. With FORCE on, RLS also applies to the table OWNER,
    --    which is who every SECURITY DEFINER capability RPC runs as — these policies would
    --    then reach the anonymous designer and the customer portal through the back door.
    if exists (
      select 1
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = r.tbl and c.relforcerowsecurity
    ) then
      raise exception
        'migration 194: public.% has FORCE ROW LEVEL SECURITY on. Resolve before applying.',
        r.tbl;
    end if;
  end loop;

  -- 5. EVERY schedule_activity ROW IS ONE OF THE FOUR SUBJECTS THE POLICY BRANCHES ON.
  --    A fifth subject is denied to everyone by the policy above, silently. 087's check
  --    constraint should make this impossible; assert it anyway, because if the constraint is
  --    ever widened this is the assertion that has to fail.
  if exists (
    select 1 from public.schedule_activity
     where subject not in ('build_job', 'load', 'stop', 'repair')
  ) then
    raise exception
      'migration 194: public.schedule_activity holds a subject the area policy does not branch on — add the branch before applying.';
  end if;

  -- 6. THE PRESET FACTS THIS FILE RESTS ON. If any of these fails, area_level_for has drifted
  --    from _shared/access.ts and the WHO ACTUALLY LOSES SOMETHING analysis above is stale.
  if public.area_level_for('user', 'driver', null::jsonb, 'orders') <> 'view'
     or public.area_level_for('user', 'crew_leader', null::jsonb, 'orders') <> 'view' then
    raise exception
      'migration 194: a driver/crew leader no longer resolves orders=view — the design_acceptances policy would blank the signature block on the order document.';
  end if;
  if public.area_level_for('user', 'crew_leader', null::jsonb, 'build_schedule') <> 'edit'
     or public.area_level_for('user', 'crew_leader', null::jsonb, 'repairs') <> 'edit'
     or public.area_level_for('user', 'driver', null::jsonb, 'delivery_schedule') <> 'edit' then
    raise exception 'migration 194: the crew_leader/driver schedule presets do not match _shared/access.ts.';
  end if;
  if public.area_level_for('user', 'crew_leader', null::jsonb, 'contacts') <> 'none'
     or public.area_level_for('user', 'driver', null::jsonb, 'contacts') <> 'none' then
    raise exception 'migration 194: the contacts preset moved — re-run the blast radius before applying.';
  end if;
  if public.area_level_for('user', 'admin', null::jsonb, 'settings_billing') <> 'none'
     or public.area_level_for('user', 'admin', '{"settings_billing":"edit"}'::jsonb, 'settings_billing') <> 'edit'
     or public.area_level_for('user', 'sales_rep', '{"settings_billing":"edit"}'::jsonb, 'settings_billing') <> 'none' then
    raise exception 'migration 194: the ownerGranted rule for Billing moved.';
  end if;
  if public.area_level_for('owner', 'driver',
       '{"contacts":"none","orders":"none","settings_billing":"none"}'::jsonb, 'contacts') <> 'edit' then
    raise exception 'migration 194: OWNERS ABSOLUTE is broken — a stored map reduced an owner.';
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — VERIFICATION. Run every block. A permission change that returns 200 with the wrong
--          rows looks exactly like one that works.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- THE HARNESS — `set local` inside a transaction that is rolled back, so nothing persists:
--
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<USER_UUID>","role":"authenticated"}';
--     -- (older auth.uid() builds read the flat GUC instead:
--     --  set local "request.jwt.claim.sub" = '<USER_UUID>';)
--     select public.current_area_level('contacts')          as contacts,
--            public.current_area_level('orders')            as orders,
--            public.current_area_level('build_schedule')    as build_sched,
--            public.current_area_level('delivery_schedule') as del_sched,
--            public.current_area_level('repairs')           as repairs,
--            public.current_area_level('settings_billing')  as billing;
--     -- then the eleven counts from PART 0's BASELINE block, verbatim.
--   rollback;
--
--   A. OWNER, with a hostile access map stored on their row
--      ('{"contacts":"none","orders":"none","settings_billing":"none"}') to prove it is
--      ignored.
--      -> every level 'edit'; ALL ELEVEN COUNTS IDENTICAL TO THE BASELINE. If an owner's
--         numbers moved, stop and roll back; nothing else in this list matters.
--
--   B. ADMIN (title='admin', access null).
--      -> billing 'none', everything else 'edit'.
--      -> subscriptions = 0; the other ten unchanged. Then GRANT them Billing on the Team
--         screen and re-run: subscriptions returns to the baseline. That grant round-trip is
--         the only proof that the ownerGranted path resolves in SQL as well as in TypeScript.
--
--   C. SALES REP (title='sales_rep', access null).
--      -> contacts/orders 'edit'; build_sched, del_sched, repairs, billing 'none'.
--      -> inbound/notes/activities/field_changes/acceptances unchanged; build_jobs, loads,
--         stops, repairs, subscriptions = 0; schedule_activity = 0.
--
--   D. CREW LEADER (title='crew_leader', access null).
--      -> contacts 'none'; orders 'view'; build_sched 'edit'; del_sched 'none';
--         repairs 'edit'; billing 'none'.
--      -> the four contacts tables = 0; loads = 0; stops = 0; subscriptions = 0;
--         build_jobs and repairs unchanged; acceptances unchanged;
--         schedule_activity = only the build_job and repair rows.
--
--   E. DRIVER (title='driver', access null) — the preset that loses the most.
--      -> contacts 'none'; orders 'view'; build_sched 'none'; del_sched 'edit';
--         repairs 'none'; billing 'none'.
--      -> the four contacts tables = 0; build_jobs = 0; repairs = 0; subscriptions = 0;
--         loads and stops unchanged; acceptances UNCHANGED (this is the one that matters);
--         schedule_activity = only the load and stop rows.
--      -> ⚠️ THEN OPEN THE REAL PORTAL AS THIS DRIVER — the app, signed in as them, not psql.
--         An empty screen throws no error, and an API-level test passes while a tab is dead.
--         ORDERS            the real order list. Open an SS-mode order and confirm the
--                           document still shows "Signed by NAME on DATE" and its totals.
--                           ⛔ STOP and roll back if the signature line is gone or the card
--                              shows a load error: that is design_acceptances being refused,
--                              which is the one regression this file could cause.
--         DELIVERY SCHEDULE loads, stops and the to-be-loaded pool, all present.
--         INVENTORY         the full unit list.
--         WHAT'S NEW        release notes and their own submissions, unchanged.
--
--   F. THE FINDING ITSELF (title='driver', access null), through PostgREST with that person's
--      real JWT rather than psql — the browser is where the hole was reported:
--        sb.from("crm_notes").select("*")      -> []
--        sb.from("email_inbound").select("*")  -> []
--        sb.from("crm_activities").select("*") -> []
--        sb.from("billing_subscriptions").select("*") -> []
--      Before this migration all four returned the tenant's rows. That difference IS F112.
--
--   G. SERVICE ROLE — every edge function reads this way, so this is the one that must not
--      have moved at all:
--        begin;
--          set local role service_role;
--          -- the eleven counts from PART 0's BASELINE block
--        rollback;
--      -> ALL ELEVEN = the whole table, ACROSS EVERY TENANT, unchanged.
--
--   H. THE FEATURES THAT READ THESE TABLES THROUGH AN EDGE FUNCTION still work, as a
--      crew leader AND as a driver: the record page's Emails/Notes/Activities feed
--      (_shared/crmFeed.ts, service role) for someone WITH contacts; the Build Schedule and
--      Repairs boards; the Delivery Schedule board and its pool; the Orders row's Schedule
--      column (portal-schedule `schedule_links`); the Billing tab for an owner.
--
--   I. THE WRITE PATHS STILL WRITE (these policies are `for select`, but prove it): a customer
--      acceptance on a real quote must still land in design_acceptances; an inbound reply must
--      still file into email_inbound; creating a build job, a load and a stop must still work
--      and must still append to schedule_activity.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- The eleven policy drops in PART 0's panic button, and nothing else. This file installs no
-- function and alters no table, so there is nothing else to undo.
