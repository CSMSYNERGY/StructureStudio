-- 199_orders_update_column_grant: the browser's UPDATE on public.orders narrows from
--                                 "every column" to the three it actually writes.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. Wrap the whole file in
--    begin;/commit; so a failed assertion in PART 2 takes PART 1 with it.
--
-- ⛔ THIS IS A MONEY-PATH CHANGE AND IT NEEDS THE OWNER'S OK BEFORE IT IS APPLIED. It can
--    take an ability away from a signed-in builder, and the failure mode is quiet: a missing
--    column privilege comes back as 42501, which the portal renders as a red banner on Save,
--    not as a crash anyone would notice in a smoke test. PART 0 is not optional.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- 188 asked "may this person write an order row at all" and said in its own header that RLS
-- cannot ask the next question: "may they write THIS column". This file asks it, with the one
-- mechanism Postgres has for it — a column-level grant.
--
-- The portal writes `orders` in exactly two places, and both write the same three columns:
--
--   portal/04-orders.jsx  saveTotal        { total_cents, total_source, updated_at }
--   portal/04-orders.jsx  applyAckedTotal  { total_cents, total_source, updated_at }
--
-- The grant behind them is table-wide, so every other column on the row is browser-writable
-- by anyone the tenant lets edit orders, over PostgREST, with no UI involved. Several of
-- those columns are read back later as facts by code that has no way to tell they were
-- touched:
--
--   pretax_subtotal_cents  the COMMISSION BASE. portal-commissions computes a rep's pay from
--   tax_cents              `pretax_subtotal_cents ?? total_cents` (158b put tax inside
--                          total_cents, and these two are how the pre-tax figure survives).
--                          They are written by portal-commissions itself as the service role.
--   building_serial        the serial a builder writes on the physical building (163).
--   order_no               the human order number, and short_code the soft link to the
--   short_code             design — the two joins the whole Orders tab is built on.
--   submitter_user_id      who the order is credited to, i.e. whose commission it is.
--   client_id              the tenancy column itself.
--
-- Every one of them is written by the service role today (customer-accept, portal-commissions,
-- portal-payments, portal-settings, sync-design-status — all use the admin client), so a
-- column grant costs those paths nothing: service_role is not `authenticated`.
--
-- ── WHY A GRANT AND NOT A TRIGGER ────────────────────────────────────────────────────────
-- A BEFORE UPDATE trigger comparing OLD/NEW could express the same rule, but it would run on
-- the service-role writes too and would have to carve them out by role — a second, weaker
-- copy of a rule Postgres already enforces natively, on a table whose DDL this repo cannot
-- even see. The grant is the smaller object: no function to keep in step, nothing to run per
-- row, and it fails CLOSED at the point of the write.
--
-- ── WHAT THIS FILE DOES NOT DO ───────────────────────────────────────────────────────────
--   * It does not touch SELECT. The Orders tab reads `select("*")` and must keep doing so.
--   * It does not touch INSERT or DELETE, and it does not touch any policy. 188's restrictive
--     area policies still decide WHO may update a row; this decides WHICH COLUMNS.
--   * It does not stop a person with orders='edit' from typing a wrong total. That is the
--     total editor's job and it is the one column they are supposed to write.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 0 — DO THIS FIRST. THE DDL FOR public.orders IS NOT IN THIS REPO.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- 105_inventory_sold_by_invoice records that orders/payments were created on an unmerged
-- `wip/orders` branch, and 174_card_payments had to re-query information_schema to write
-- against them. So the column list and the grants below are the LIVE database's answer, not
-- this repo's — read them before applying anything.
--
-- PANIC BUTTON. If a builder reports "it won't let me save the total" after this ships,
-- restore today's behaviour instantly and completely with one statement:
--
--   grant update on public.orders to authenticated;
--
-- (A table-level grant supersedes the column list; the narrower grants can be left in place
-- and cleaned up later, or dropped with PART 3.)
--
-- QUERY 1 — WHO HOLDS WHAT TODAY. Run as the owner/postgres so nothing is filtered out.
-- Read the UPDATE rows. `service_role` and the table owner must appear with UPDATE; if
-- UPDATE reaches `authenticated` only through PUBLIC, PART 1's revoke from public is the one
-- that matters and QUERY 4's assertion is what protects service_role while it happens.
--
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'orders'
--    order by grantee, privilege_type;
--
-- QUERY 2 — THE REAL COLUMN LIST. Confirm total_cents, total_source and updated_at all exist
-- and are spelled exactly that way. A grant on a column that does not exist errors out (good);
-- a column the portal writes that is MISSING from the grant list does not (bad) — it saves
-- today and 42501s tomorrow.
--
--   select ordinal_position, column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'orders'
--    order by ordinal_position;
--
-- QUERY 3 — ANY COLUMN-LEVEL UPDATE GRANTS ALREADY IN PLACE (expected: none).
--
--   select grantee, column_name
--     from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'orders' and privilege_type = 'UPDATE'
--    order by grantee, column_name;
--
-- QUERY 3b — THE TABLE'S CURRENT COMMENT. PART 1 REPLACES it (a table has one comment, and
-- `comment on` has no append). Capture it first so nothing written on the unmerged branch is
-- lost; if it says something this file's replacement does not, merge the two by hand.
--
--   select obj_description('public.orders'::regclass, 'pg_class');
--
-- QUERY 4 — NOTHING ELSE WRITES orders AS `authenticated`. Every edge function in this repo
-- uses the service-role client for orders (grep confirms: customer-accept, customer-pay,
-- customer-quotes, portal-commissions, portal-payments, portal-schedule, portal-settings,
-- sync-design-status). What this repo cannot see is designs_ensure_order, the trigger that
-- mints an order row when a design is accepted — 188 PART 2 raises the same question. A
-- SECURITY DEFINER function runs as its OWNER, not as the caller, so it is unaffected by a
-- grant to `authenticated`; confirm that is what it is:
--
--   select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, t.tgname
--     from pg_catalog.pg_trigger t
--     join pg_catalog.pg_proc  p on p.oid = t.tgfoid
--     join pg_catalog.pg_class c on c.oid = t.tgrelid
--    where not t.tgisinternal and p.proname like '%ensure_order%';
--
-- AFTER APPLYING, re-run the two portal writes against beta before calling this done — they
-- are the only two consumers and neither has a test:
--   1. Orders → a manual (design-less) order → Order total → Edit → Save total.
--   2. Orders → an SS order → Change orders → record a verbal confirmation on a CO that
--      carries a new total (applyAckedTotal), and check the header total moves.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — PRECONDITIONS, THEN THE CHANGE
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  c text;
begin
  -- 1. The three columns exist and are spelled as the portal spells them. Asserted rather
  --    than assumed: the grant statement below would error on a missing column, but this
  --    says WHICH one and why, before anything has been revoked.
  foreach c in array array['total_cents', 'total_source', 'updated_at'] loop
    perform 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'orders' and column_name = c;
    if not found then
      raise exception
        'migration 199: public.orders has no column "%" — the portal writes it (04-orders.jsx saveTotal / applyAckedTotal). Re-read PART 0 QUERY 2 before applying.', c;
    end if;
  end loop;

  -- 2. service_role keeps its own table-level UPDATE. The revoke below includes `from public`
  --    (a PUBLIC grant survives a revoke aimed at a role — the trap 112 recorded), and if
  --    UPDATE reached service_role ONLY through PUBLIC, that revoke would silently break
  --    every edge function that writes an order: the invoice total, the commission base, the
  --    CardPointe payment's order row.
  if not has_table_privilege('service_role', 'public.orders', 'UPDATE') then
    raise exception
      'migration 199: service_role cannot UPDATE public.orders even before this migration — resolve that first; revoking PUBLIC would leave the edge functions unable to write orders.';
  end if;

  -- 3. authenticated keeps SELECT. Nothing here touches it, and the Orders tab is a
  --    `select("*")`; this catches the day someone folds a SELECT change into this file.
  if not has_table_privilege('authenticated', 'public.orders', 'SELECT') then
    raise exception 'migration 199: authenticated cannot SELECT public.orders — the Orders tab is already dark; stop.';
  end if;
end
$$;

-- THE CHANGE. Both revokes, then the narrow grant. `from public` is not decoration: PUBLIC is
-- a separate grantee and a privilege held that way is invisible to a revoke naming a role.
revoke update on public.orders from authenticated;
revoke update on public.orders from public;
grant  update (total_cents, total_source, updated_at) on public.orders to authenticated;

comment on table public.orders is
  'Order header. Browser UPDATE is column-scoped (migration 199) to total_cents/total_source/updated_at — the only columns portal/04-orders.jsx writes. Everything else (pretax_subtotal_cents, tax_cents, order_no, short_code, building_serial, submitter_user_id, client_id) is service-role-written and must stay that way: the first two are the commission base. WHO may update a row is migration 188''s restrictive area policies; WHICH columns is this grant.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — APPLY-TIME ASSERTIONS. Every failure below is silent at runtime.
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  c        text;
  col      record;
  allowed  text[] := array['total_cents', 'total_source', 'updated_at'];
begin
  -- 1. The three columns the portal writes are still writable by the browser.
  --    has_column_privilege answers for the role as it will actually be evaluated — role
  --    membership and PUBLIC included — so this is the same question PostgREST asks on Save.
  foreach c in array allowed loop
    if not has_column_privilege('authenticated', 'public.orders', c, 'UPDATE') then
      raise exception
        'migration 199: authenticated lost UPDATE on public.orders.% — saveTotal and applyAckedTotal would 42501 and the portal would show a red banner on Save.', c;
    end if;
  end loop;

  -- 2. NOTHING ELSE IS. This is the whole point of the file, and it is checked column by
  --    column rather than by trusting the revoke: a leftover table-level grant to PUBLIC, or
  --    a column grant added by hand later, would leave the money columns open and look fine.
  for col in
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'orders'
       and column_name <> all (allowed)
     order by ordinal_position
  loop
    if has_column_privilege('authenticated', 'public.orders', col.column_name, 'UPDATE') then
      raise exception
        'migration 199: authenticated can still UPDATE public.orders.% — the revoke did not take (check for a PUBLIC grant, PART 0 QUERY 1).', col.column_name;
    end if;
  end loop;

  -- 3. No table-wide UPDATE left for the browser roles. Redundant with 2 today and not
  --    tomorrow: a table-level grant re-added later would satisfy nothing else here.
  if has_table_privilege('authenticated', 'public.orders', 'UPDATE') then
    raise exception 'migration 199: authenticated still holds a TABLE-level UPDATE on public.orders — the column grant is then meaningless.';
  end if;
  if has_table_privilege('anon', 'public.orders', 'UPDATE') then
    raise exception 'migration 199: anon can UPDATE public.orders. That is a separate and larger problem; do not proceed.';
  end if;

  -- 4. The service role is untouched. If this fires, the `revoke ... from public` above took
  --    a privilege service_role only held through PUBLIC — run PART 3 immediately: every
  --    edge-function write to an order (invoice totals, commission base, CardPointe rows) is
  --    failing while this is true.
  if not has_table_privilege('service_role', 'public.orders', 'UPDATE') then
    raise exception 'migration 199: service_role lost UPDATE on public.orders — roll back now (PART 3).';
  end if;

  -- 5. Reads are untouched.
  if not has_table_privilege('authenticated', 'public.orders', 'SELECT') then
    raise exception 'migration 199: authenticated lost SELECT on public.orders — the Orders tab would be empty with no error.';
  end if;
end
$$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════════════════
--   grant  update on public.orders to authenticated;
--   revoke update (total_cents, total_source, updated_at) on public.orders from authenticated;
--
-- Nothing else in this file creates, alters or drops anything: no table, no column, no
-- function, no policy, no row.
