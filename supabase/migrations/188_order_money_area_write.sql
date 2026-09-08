-- 188_order_money_area_write: per-area access reaches the WRITE side of the three money
--                             tables the browser writes directly.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, and record as version 188. Never
--    `supabase db push`. Like 154, this is a migration that can take an ability AWAY from a
--    signed-in builder, so PART 0 is not optional: run its queries against live data and
--    decide, before PART 2 is applied.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- 154 gave per-area access a server representation and 183 finished the area list, but both
-- stopped at `for select`. 154 PART 3 says so in as many words: "reads only. Writes to these
-- tables already go through SECURITY DEFINER RPCs or the service role". That is true of the
-- five tables 154 covered. It is NOT true of orders, payments and change_orders — those
-- three are written STRAIGHT FROM THE BROWSER over PostgREST under RLS, which is the
-- deliberate orders/105 precedent, and every one of their insert/update policies tests
-- nothing but `client_id = public.current_client_id()` (plus `gateway is null` on payments
-- and a status shape on change_orders, 126:187-198).
--
-- current_client_id() (001_tenancy.sql) resolves ANY client_users row, and 101 made every
-- driver a real login. So the tenant test is satisfied by the LEAST privileged title in the
-- product, and the per-area map — the thing Settings → Team writes, the thing
-- _shared/access.ts resolves, the thing 154 mirrored into SQL — has never been consulted on
-- a write to any of them. The browser clamps that exist (portal/12-shell.jsx's coCanEdit
-- for the change-order card) run in the browser, and 154's own header already states the
-- rule this file applies to the write side: the UI hiding a control is a courtesy, not a
-- control.
--
-- The defect class, stated without a recipe: a team member whose area map says 'view' or
-- 'none' for an area can still INSERT and UPDATE that area's rows by talking to PostgREST
-- directly. On these three tables the rows are money and evidence — a recorded payment
-- (which fires inventory_claim_on_payment and marks a unit sold, irreversibly), an order
-- total, and a change order carrying a verbal attestation that the guard trigger then
-- STAMPS rather than authorises (126:112-116).
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 0  what to run first: the panic button and the two blast-radius queries.
--   PART 1  change_orders — the VERIFIED half. Blast radius zero. Safe to apply alone.
--   PART 2  orders + payments — the same shape, one decision wider. READ IT FIRST.
--   PART 3  apply-time assertions. They RAISE, which aborts the transaction.
--   PART 4  rollback.
--
-- ONE TRANSACTION: wrap the file in begin;/commit; when you apply it, so a failed assertion
-- in PART 3 takes PARTS 1-2 with it. PART 1 may be applied on its own; PART 2 must not be
-- applied without PART 0's second query having been run and read.
--
-- ── RESTRICTIVE IS LOAD-BEARING (the same warning 154 carries) ────────────────────────────
-- Postgres ORs permissive policies together and ANDs restrictive ones in afterwards. A
-- PERMISSIVE twin of any policy below would WIDEN these tables — `tenant OR area` — and hand
-- the money tables to anyone the area test happened to pass. The word `restrictive` on each
-- policy is the difference between closing this and inverting it, and PART 3 refuses to
-- finish if any of the six did not land RESTRICTIVE, write-only and authenticated-only.
--
-- Adding restrictive policies is also what lets this file leave the existing policies ALONE.
-- orders and payments have no migration in this repo at all — 105_inventory_sold_by_invoice
-- records that their DDL lives on an unmerged `wip/orders` branch, and 174_card_payments had
-- to re-query information_schema to write against them. A restrictive policy does not need
-- to know the text of the permissive one it narrows, so nothing here rewrites, drops or
-- guesses at DDL this repo cannot see.
--
-- ── SAFETY PROPERTIES, AND WHERE EACH IS ENFORCED ─────────────────────────────────────────
--   Owners            area_level_for returns 'edit' before the access map is read at all.
--   Admins            the admin preset holds orders and change_orders at 'edit' (183).
--   Sales reps        orders 'edit' (183; the view→edit move of 2026-09-01). They keep
--                     recording payments, voiding them and finalising a sale exactly as
--                     today. change_orders stays 'none' unless granted, which is Carolyn's
--                     rule of 2026-09-01 and the entire point of PART 1.
--   Service role      every policy here is `to authenticated`; a restrictive policy is not
--                     evaluated for a role it does not name, and service_role additionally
--                     carries BYPASSRLS. So submit-estimate's design_edit upsert,
--                     customer-accept's signature acknowledgment, portal-settings' stage and
--                     void actions, and the CardPointe charge path are all untouched.
--   anon / customers  same reason. The customer portal is not a Supabase auth session at
--                     all (customer_sessions are opaque tokens checked service-side), so a
--                     customer is never the `authenticated` role.
--   Absent data       no client_users row resolves OPEN ('edit'), by 154 PART 2's
--                     DEFAULT-OPEN rule. It cannot widen anything: current_client_id() reads
--                     the SAME row of the SAME table, so no row there means the permissive
--                     tenant policy already returns nothing, and ANDing "everything" onto
--                     "nothing" is still nothing. This is what keeps operators (who have no
--                     client_users row on the tenant they are viewing) behaving as today.
--   Typo'd area key   PART 3 aborts the migration. An unknown key resolves to 'none' for
--                     everyone including owners, which would freeze the table for a whole
--                     tenant with no error anywhere.
--   Reads             NOT NARROWED. Not one policy here is `for select`, deliberately —
--                     see PART 1's note on the invoice-blocked chip.
--
-- ── WHAT THIS FILE DOES NOT CLOSE ─────────────────────────────────────────────────────────
--   * The browser-side controls stay ungated: OrderDetail's Record-a-payment, void/restore
--     and manual total editor have no area test in portal/04-orders.jsx, so after PART 2 a
--     crew leader or driver pressing them gets a raw RLS refusal rendered as an error
--     banner. That is a correct refusal with a bad face on it. The follow-up is to pass an
--     `ordersOn` prop the way `coOn` is already passed and hide the controls — a portal
--     change, not a SQL one, and not in this file.
--   * Column-level intent. RLS is row-level: this file can say "may this person write an
--     order row at all", never "may they write total_cents specifically". Moving the manual
--     total edit and the manual payment behind a gated portal-settings / portal-payments
--     action is the version of this that can express that, and remains the longer-term fix.
--   * The comment at portal/04-orders.jsx:3277-3279 — "portal-settings refuses the three
--     change-order actions on the same grant, so this is not the gate" — is false for the
--     create, the verbal attestation and the card's own void, which never reach
--     portal-settings. After PART 1 it becomes true in substance for the wrong reason;
--     correct the comment in the portal commit.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 0 — DO THIS FIRST
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- PANIC BUTTON. If a builder reports "it won't let me save" after this ships, restore
-- today's behaviour instantly. The six drops are independent and safe to run alone, in any
-- order, at any time:
--
--   drop policy if exists change_orders_area_insert on public.change_orders;
--   drop policy if exists change_orders_area_update on public.change_orders;
--   drop policy if exists orders_area_insert        on public.orders;
--   drop policy if exists orders_area_update        on public.orders;
--   drop policy if exists payments_area_insert      on public.payments;
--   drop policy if exists payments_area_update      on public.payments;
--
-- BLAST RADIUS 1 — who resolves to what. area_level_for is pure, so this preview is exact:
--
--   select cu.client_id, cu.role, cu.title,
--          public.area_level_for(cu.role, cu.title, cu.access, 'orders')        as orders,
--          public.area_level_for(cu.role, cu.title, cu.access, 'change_orders') as change_orders,
--          cu.user_id
--     from public.client_users cu
--    order by cu.client_id, cu.title, cu.role;
--
-- BLAST RADIUS 2 — WHO ACTUALLY LOSES SOMETHING THEY HAVE DONE. This is the number to read
-- before applying PART 2, because it is the only one that reports real behaviour rather than
-- a preset: every person who has recorded or voided money on an order and who will no longer
-- be able to. If it returns rows, STOP and take them to the owner: either those people
-- should hold orders='edit' (set it in Settings → Team first, then apply), or they have been
-- doing something the access model says they may not, and that is a conversation, not a
-- migration.
--
--   select p.client_id, p.created_by, cu.title, count(*) as payments_recorded,
--          max(p.created_at) as most_recent
--     from public.payments p
--     join public.client_users cu
--       on cu.user_id = p.created_by and cu.client_id = p.client_id
--    where public.area_level_for(cu.role, cu.title, cu.access, 'orders') <> 'edit'
--    group by 1, 2, 3
--    order by most_recent desc;
--
-- The same question for PART 1, which is expected to return NOTHING — the change-order card
-- has only ever rendered for coCanEdit, so nobody without the grant can have used it:
--
--   select co.client_id, co.created_by, cu.title, count(*) as change_orders_raised
--     from public.change_orders co
--     join public.client_users cu
--       on cu.user_id = co.created_by and cu.client_id = co.client_id
--    where public.area_level_for(cu.role, cu.title, cu.access, 'change_orders') <> 'edit'
--    group by 1, 2, 3;
--
-- If THAT one returns rows, it is evidence the browser clamp was bypassed, not a reason to
-- widen the policy.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — change_orders. The verified half.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Carolyn, 2026-09-01, recorded at _shared/access.ts:80-90: Change Orders is "the only
-- feature they shouldn't have unless given permission in the team settings". The area is
-- omitted from every non-owner/non-admin preset (183 k_presets), and portal/12-shell.jsx
-- clamps the card on `myAccess.change_orders === "edit"`. These two policies are that same
-- sentence, on the server, where it cannot be edited out of a browser tab.
--
-- `= 'edit'` and not `<> 'none'`: 'edit' is the level the card itself tests, and there is no
-- read-only change-order surface for 'view' to mean anything on. Matching the browser clamp
-- exactly is what makes the blast radius provably zero.
--
-- SELECT IS DELIBERATELY NOT NARROWED. portal/04-orders.jsx:1430 reads pending change orders
-- to paint the invoice-blocked chip on the Orders LIST, and :3080 reads them for the order
-- document — both of which reps and admins legitimately see without holding the grant.
-- Narrowing select here would blank that chip silently, which is 154's exact failure mode:
-- an empty result with error === null sails past every `if (error)` guard in the portal.

drop policy if exists change_orders_area_insert on public.change_orders;
create policy change_orders_area_insert on public.change_orders
  as restrictive for insert to authenticated
  with check (public.current_area_level('change_orders') = 'edit');

drop policy if exists change_orders_area_update on public.change_orders;
create policy change_orders_area_update on public.change_orders
  as restrictive for update to authenticated
  using       (public.current_area_level('change_orders') = 'edit')
  with check  (public.current_area_level('change_orders') = 'edit');

comment on policy change_orders_area_insert on public.change_orders is
  'Per-area write gate (migration 188): raising a change order needs change_orders=edit, the grant Settings -> Team hands out per person. ANDed with the tenant policy from 126. Service-role writers (submit-estimate, customer-accept, portal-settings) are unaffected — this policy names authenticated only.';
comment on policy change_orders_area_update on public.change_orders is
  'Per-area write gate (migration 188): amending, verbally acknowledging or voiding a change order needs change_orders=edit. The guard trigger''s signature and frozen-when-acknowledged rules (126) are unchanged and still apply on top.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — orders + payments. READ PART 0's SECOND QUERY BEFORE APPLYING THIS.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Area key is 'orders' for BOTH tables. There is no 'payments' area in AREAS: payments are
-- part of the Orders tab, the Record-a-payment control lives inside OrderDetail, and
-- inventing an area here would put the SQL mirror ahead of _shared/access.ts, which is the
-- drift 183 had to repair.
--
-- WHAT CHANGES FOR A REAL PERSON. Owners, admins and sales reps: nothing, all three resolve
-- orders='edit'. Crew leaders and drivers resolve orders='view' and lose the ability to
-- INSERT a payment, void one, or edit an order total. They never had a supported way to do
-- it — but unlike the change-order card, no UI has been hiding it from them, so this is the
-- one narrowing in this file that could be somebody's Tuesday. That is what PART 0's second
-- query is for.
--
-- The alternative considered and rejected: gate only the portal buttons and leave RLS open.
-- It is a smaller change and it is not a control — the whole finding is that the buttons are
-- not the boundary. Both should happen; only one of them can be enforced.
--
-- INSERT on orders has no browser producer today (the portal only selects and updates), so
-- the insert policies are pure gain: they close order-minting without costing a flow.
--
-- ONE THING TO CONFIRM AGAINST LIVE BEFORE APPLYING THIS PART, because this repo cannot
-- read it: designs_ensure_order, the trigger that mints an order row when a design is
-- accepted, is defined on the unmerged wip/orders branch (102:145, 153:123). It must reach
-- `orders` as the table owner or the service role, not as `authenticated` — every design
-- write in the product goes through a SECURITY DEFINER RPC or an edge function, so it
-- should, but "should" is not the standard for a policy on the sale itself:
--
--   select p.proname, p.prosecdef, t.tgname, c.relname
--     from pg_catalog.pg_trigger t
--     join pg_catalog.pg_proc  p on p.oid = t.tgfoid
--     join pg_catalog.pg_class c on c.oid = t.tgrelid
--    where not t.tgisinternal and p.proname like '%ensure_order%';
--
-- prosecdef = true (or a caller that is only ever service_role) means PART 2 cannot touch
-- it. If it comes back false AND some authenticated path writes designs directly, stop:
-- accepting a design would start failing for anyone below orders='edit'.

drop policy if exists orders_area_insert on public.orders;
create policy orders_area_insert on public.orders
  as restrictive for insert to authenticated
  with check (public.current_area_level('orders') = 'edit');

drop policy if exists orders_area_update on public.orders;
create policy orders_area_update on public.orders
  as restrictive for update to authenticated
  using       (public.current_area_level('orders') = 'edit')
  with check  (public.current_area_level('orders') = 'edit');

drop policy if exists payments_area_insert on public.payments;
create policy payments_area_insert on public.payments
  as restrictive for insert to authenticated
  with check (public.current_area_level('orders') = 'edit');

drop policy if exists payments_area_update on public.payments;
create policy payments_area_update on public.payments
  as restrictive for update to authenticated
  using       (public.current_area_level('orders') = 'edit')
  with check  (public.current_area_level('orders') = 'edit');

comment on policy orders_area_update on public.orders is
  'Per-area write gate (migration 188): editing an order (total_cents, total_source, notes) needs orders=edit. Crew leaders and drivers hold orders=view and are read-only here, which is what the access model has always said and what nothing enforced.';
comment on policy payments_area_insert on public.payments is
  'Per-area write gate (migration 188): recording a payment needs orders=edit. It is not a cosmetic write — the AFTER INSERT trigger inventory_claim_on_payment marks the linked unit sold, which does not come back.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — apply-time assertions. Modelled on 154 PART 4. Every failure mode below is
--          SILENT at runtime, which is why each one aborts the transaction instead.
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  r      record;
  v_bad  integer;
begin
  -- 0. The resolver exists. current_area_level is 154 PART 2 and area_level_for was
  --    re-issued by 183 with change_orders present. A policy referencing a missing function
  --    would fail at write time, per row, as a 500 — not here.
  if to_regprocedure('public.current_area_level(text)') is null then
    raise exception 'migration 188: public.current_area_level(text) is missing — apply 154 (and 183) first';
  end if;

  for r in
    select * from (values
      ('change_orders', 'change_orders'),
      ('orders',        'orders'),
      ('payments',      'orders')
    ) as t(tbl, area)
  loop
    -- 1. THE AREA KEY IS REAL. An unknown key resolves to 'none' for everyone, owners
    --    included, so one typo would freeze this table for an entire tenant with no error
    --    anywhere. The owner probe is an exact discriminator: a known area returns 'edit'
    --    for an owner, an unknown one returns 'none', and nothing else produces either.
    if public.area_level_for('owner', 'owner', null::jsonb, r.area) <> 'edit' then
      raise exception
        'migration 188: "%" is not an area key in area_level_for (policies on public.%). A typo here denies the table to every user in every tenant.',
        r.area, r.tbl;
    end if;

    -- 2. RLS IS ACTUALLY ON. A restrictive policy on a table with row security disabled is
    --    inert and looks installed. orders and payments have no migration in this repo, so
    --    this is asserted rather than assumed.
    perform 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = r.tbl and c.relrowsecurity;
    if not found then
      raise exception 'migration 188: row level security is not enabled on public.% — the policies below would be inert', r.tbl;
    end if;

    -- 3. BOTH POLICIES LANDED, RESTRICTIVE, WRITE-ONLY, authenticated-ONLY. A permissive
    --    twin would widen these tables instead of narrowing them; a role list carrying anon
    --    or service_role would break the public designer and every edge function; a `select`
    --    or `all` command would blank the invoice-blocked chip and the Orders list.
    perform 1
       from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = r.tbl
        and p.policyname = r.tbl || '_area_insert'
        and p.permissive = 'RESTRICTIVE'
        and p.cmd        = 'INSERT'
        and p.roles      = '{authenticated}'::name[]
        -- the area key as a LITERAL, 154 PART 4's form: `%'orders'%`, so a policy that
        -- merely mentions the word cannot satisfy the check.
        and p.with_check like '%''' || r.area || '''%';
    if not found then
      raise exception 'migration 188: %_area_insert did not land as a RESTRICTIVE INSERT policy for authenticated on the % area', r.tbl, r.area;
    end if;

    perform 1
       from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = r.tbl
        and p.policyname = r.tbl || '_area_update'
        and p.permissive = 'RESTRICTIVE'
        and p.cmd        = 'UPDATE'
        and p.roles      = '{authenticated}'::name[]
        and p.qual       like '%''' || r.area || '''%'
        and p.with_check like '%''' || r.area || '''%';
    if not found then
      raise exception 'migration 188: %_area_update did not land as a RESTRICTIVE UPDATE policy (USING and WITH CHECK) for authenticated on the % area', r.tbl, r.area;
    end if;

    -- 4. THE PERMISSIVE WRITE POLICIES ARE STILL THERE. A restrictive policy alone matches
    --    nothing: with no permissive INSERT/UPDATE policy left, every authenticated write to
    --    this table is denied outright. Nothing in this file drops one — this catches the day
    --    something else does. If it fires, writes were ALREADY denied for authenticated on
    --    that table: drop this file's matching restrictive policy rather than widening
    --    anything to satisfy the assertion.
    perform 1
       from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = r.tbl
        and p.permissive = 'PERMISSIVE'
        and p.cmd in ('INSERT', 'ALL')
        and p.roles && '{authenticated,public}'::name[];
    if not found then
      raise exception 'migration 188: public.% has no permissive INSERT policy for authenticated. Adding a restrictive one now would deny the table outright.', r.tbl;
    end if;

    perform 1
       from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = r.tbl
        and p.permissive = 'PERMISSIVE'
        and p.cmd in ('UPDATE', 'ALL')
        and p.roles && '{authenticated,public}'::name[];
    if not found then
      raise exception 'migration 188: public.% has no permissive UPDATE policy for authenticated. Adding a restrictive one now would deny the table outright.', r.tbl;
    end if;

    -- 5. FORCE ROW LEVEL SECURITY IS OFF, for 154 PART 4's reason applied to writes. With
    --    FORCE on, RLS also binds the table OWNER — which is who SECURITY DEFINER functions
    --    run as, and the owner is how the out-of-band designs_ensure_order trigger reaches
    --    `orders` when a design is accepted (that trigger lives on the unmerged wip/orders
    --    branch; 102 and 153 both record that this repo cannot see it). These policies would
    --    then bind it, and accepting a design could start failing for the tenant. FORCE has
    --    never been set on this database; asserted because the blast radius if it ever is
    --    would be the sale itself. See PART 2's note on verifying that path before applying.
    if exists (
      select 1
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = r.tbl and c.relforcerowsecurity
    ) then
      raise exception
        'migration 188: public.% has FORCE ROW LEVEL SECURITY on. These write policies would then bind the SECURITY DEFINER paths (designs_ensure_order, the capability RPCs) too. Resolve before applying.',
        r.tbl;
    end if;

    -- 6. NOTHING HERE TOUCHES READS. Belt and braces against a future edit turning one of
    --    these into `for all`, which would silently empty the Orders tab.
    perform 1
       from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = r.tbl
        and p.policyname in (r.tbl || '_area_insert', r.tbl || '_area_update')
        and p.cmd not in ('INSERT', 'UPDATE');
    if found then
      raise exception 'migration 188: a policy added by this file covers reads on public.% — it must be INSERT/UPDATE only', r.tbl;
    end if;
  end loop;

  -- 7. THE TWO GRANTS MUST TRAVEL TOGETHER. Acknowledging a change order writes the new
  --    total onto orders (portal/04-orders.jsx applyAckedTotal), so a person holding
  --    change_orders='edit' with orders <> 'edit' would record a frozen, acknowledged change
  --    order and then fail to apply its total — a half-written agreement, which is worse
  --    than either refusal. No shipped preset is in that state; only a hand-set override can
  --    reach it. Refuse to install rather than leave it live.
  select count(*) into v_bad
    from public.client_users cu
   where public.area_level_for(cu.role, cu.title, cu.access, 'change_orders') = 'edit'
     and public.area_level_for(cu.role, cu.title, cu.access, 'orders')        <> 'edit';
  if v_bad > 0 then
    raise exception
      'migration 188: % team member(s) resolve change_orders=edit with orders<>edit. Give them orders=edit in Settings -> Team first, or their acknowledged change orders would not reach the order total.',
      v_bad;
  end if;
end
$$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- The six drops in PART 0's panic button, in any order. Nothing else in this file creates,
-- alters or drops anything: no table, no column, no function, no grant, and none of the
-- permissive policies from 126 or from the unmerged orders/payments DDL.
