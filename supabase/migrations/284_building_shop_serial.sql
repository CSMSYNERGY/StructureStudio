-- 284_building_shop_serial.sql — a customer's building gets its shop serial ONCE and keeps it: the
-- number lives on the building's order, not on whichever build job happens to exist today.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file` or an inline "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('284', '284_building_shop_serial') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ⛔ BEFORE portal-schedule. The new portal-schedule reads orders.shop_serial on every order
--    create_job; deployed ahead of this file that read answers 42703 and NO tenant can put an
--    order on the build board. See ORDER.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-10-06 (question 14, "Delivery serial numbers: one per building, or one per job?"):
-- "one per building". Today it is one per JOB. create_job mints a fresh take_next_serial() every
-- time an order's build job is created, and delete_job hard-deletes the row, so taking a building
-- off the board and putting it back hands it a second number. Live (2026-10-06): 20 build-job
-- deletes and 24 order-job creates logged, about 15 numbers already burned, and an undelivered
-- stop still carrying the number of an earlier job while the building's current job carries a
-- newer one. A stop added from a bare design code (a builder who skips the build board) carries
-- no number at all, and a repair logged against a design code finds none, so service history
-- (which matches on the serial) misses the building.
--
-- ── WHICH SERIAL ─────────────────────────────────────────────────────────────────────────
-- The SHOP SERIAL: the plain per-builder integer from client_settings.next_serial, handed out by
-- take_next_serial() (075). Inventory units, build jobs, delivery stops and repairs carry it. It
-- is NOT orders.building_serial, the tag code (0826LBA1016REBLDWS5000) 163 mints at Mark built;
-- that one is already one per order and nothing here touches it.
--
-- ── WHERE IT LIVES, AND WHY THERE ────────────────────────────────────────────────────────
-- orders.shop_serial. An order is exactly one building (orders_client_id_short_code_key: one order
-- per design, one design per building), and it already holds the tag code. Nothing else can:
--   * build_jobs rows are hard-deleted (delete_job), which is the bug;
--   * delivery_stops.serial is a SNAPSHOT, and a bare-code stop never fills it;
--   * designs is UPDATE-able from the browser (table-level grant), so a number there could be
--     rewritten from a console;
--   * orders' browser UPDATE is column-scoped to total_cents/total_source/updated_at (199), so a new
--     column is service-role-only for UPDATE the moment it exists. (The browser keeps the table-
--     level INSERT 188 left it, the same exposure building_serial has had since 163: tenant-scoped,
--     and the value can never be UPDATEd afterwards. Accepted for parity.)
-- An INVENTORY building's number stays on its inventory unit (075, minted once already). An order
-- for a lot building is an inventory sale; its shop_serial stays NULL and readers fall through to
-- the unit.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1   orders.shop_serial bigint, NULL = not issued yet; comments on the column and table.
--   PART 2   Fills it for every order building that already has a number:
--            (b) from the building's ORDER build job (expected 9 on 2026-10-06);
--            (c) a building with no order job, from its one ORDER stop (expected 2):
--                delivery_stops_one_per_design (090) means there is never a choice to make.
--            Never an inventory sale, even when its order stop carries the unit's number.
--            Then a unique index (client_id, shop_serial) where it is set: one number, one building,
--            per builder. The same number on two builders is fine; it is their own count.
--   PART 3   (d) UNDELIVERED order stops take their building's number (expected 2, both on the
--            internal demo tenant). Where the two disagree the build board's number wins: it is
--            the job that exists now, and every reader from today on gets it from the order.
--            DELIVERED stops are history (that number went out the door) and are never touched.
--   PART 4   Checks that raise, and so roll the whole file back:
--            * no ORDER build job carries a number different from its order's;
--            * no order's number equals an inventory unit's on the same tenant;
--            * no undelivered order stop disagrees with its order;
--            * every number is below its tenant's next_serial, so take_next_serial() can never
--              hand one out again (save_serial_start's floor keeps it that way afterwards);
--            * nothing moved but orders.shop_serial and the PART 3 stops: no build job, no
--              delivered stop, no other order column (updated_at included);
--            * the browser still cannot UPDATE the column; service_role can read and write it.
--   THE RECORD the counts, and each realigned stop as `id: old -> new` (see ROLLBACK).
--
-- Idempotent: a re-apply changes no row and prints zeros. That is also the read-back after the
-- portal-schedule deploy (see ORDER).
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────
--   * Mints nothing and renumbers nothing. Every number written here is one a job or a stop
--     already carries; the counter is not touched.
--   * Inventory, repair and manual jobs keep their current behaviour (the unit's number, the
--     repair's, none).
--   * A delivery-only building (stop added from a design code, never on the build board) is not
--     given a number. Default kept from Carolyn's answer: numbers are handed out on the build board
--     and in inventory only.
--   * Does not touch building_serial, ss_build_serial or mintBuildingSerial (163).
--   * The behaviour change (create_job reuses the number; a bare-code stop and a repair intake
--     find it) is portal-schedule's, shipped after this file.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. The old portal-schedule never names the column, so it
-- carries on unchanged. ADD COLUMN with no default is a catalog change (no rewrite) under a brief
-- ACCESS EXCLUSIVE lock on orders, held to the commit; the tables are tiny (53 orders, 13 build
-- jobs, 8 stops on 2026-10-06), so the whole file is milliseconds. build_jobs and delivery_stops
-- are locked SHARE first, so a job created mid-apply cannot slip between the fill and the checks;
-- lock_timeout makes a hung apply give up instead of queueing the Orders tab behind it. No trigger
-- on build_jobs or delivery_stops; orders has only orders_assign_no_trg (BEFORE INSERT).
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-07: 282 is the newest applied, 281 is written and deliberately not applied.
-- 283 is held for A-numbering, 284 for this batch, 285-287 for the others in the same round.
-- Confirm at apply time, and record the ledger row with `returning`: no row back means 284 was
-- taken, so rename.
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 3;
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- 1. This file, then its ledger row. Expected record: filled_from_jobs 9, filled_from_stops 2,
--    stops_realigned 2, orders_with_shop_serial 11, both mismatch counts 0.
-- 2. ONLY THEN merge the portal-schedule change into beta. Other batches deploy portal-schedule
--    from beta too; merged first, any of their deploys would ship the shop_serial read before the
--    column exists. Re-fetch beta and re-diff the live function before deploying it.
-- 3. Deploy portal-schedule (explicit --workdir), grep the downloaded live copy for
--    buildingSerialFor.
-- 4. Pipe this file again, unchanged, as the read-back (no second ledger row). Between steps 1
--    and 3 the OLD code can still create an order job without recording its number on the order;
--    a non-zero filled_from_jobs is that job, now recorded, and a non-zero stops_realigned is a
--    stop the old code added from a design code (it never gave one a number) for a building that
--    has one. If it instead RAISES "carries #…, its order holds #…", the old code deleted and
--    re-created a job for a building that already had a number: put the job back on the
--    order's number
--      update public.build_jobs set serial = <the order's>, updated_at = now() where id = '<job>';
--    and pipe the file once more.
-- 5. Triage app_errors (a 'serial_no_order' row is an order job created for a design with no
--    orders row; 0 such designs on 2026-10-06).
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   drop index if exists public.orders_shop_serial_uniq;
--   alter table public.orders drop column if exists shop_serial;
--   comment on table public.orders is 'Order header. Browser UPDATE is column-scoped (migration 199) to total_cents/total_source/updated_at — the only columns portal/04-orders.jsx writes. Everything else (pretax_subtotal_cents, tax_cents, order_no, short_code, building_serial, submitter_user_id, client_id) is service-role-written and must stay that way: the first two are the commission base. WHO may update a row is migration 188''s restrictive area policies; WHICH columns is this grant.';
--   delete from supabase_migrations.schema_migrations where version = '284';
-- Run the block above LAST. Other batches deploy portal-schedule from beta too, so none of them may deploy it until step 4 is done:
-- 1. Take this batch's shop_serial reads out of portal-schedule on beta with a forward commit (not `git revert -m 1` of a merge), and push.
-- 2. Re-fetch beta, re-diff the live function, and deploy portal-schedule from that tree (explicit --workdir). Never redeploy a saved pre-284 copy: it also drops every sibling change shipped since, and beta would still put the shop_serial read back on the next deploy.
-- 3. Grep the downloaded live copy: no `shop_serial` anywhere.
-- 4. Only then run the block above. Stops realigned by PART 3 keep their new number; the record lists each one as `id: old -> new`, which is all a restore needs.

begin;

-- ACCESS EXCLUSIVE on orders (the ADD COLUMN) and SHARE on the two schedule tables, all brief. A
-- hung apply must give up rather than sit in front of the Orders tab and both boards.
set local lock_timeout = '5s';

-- No job or stop can be written between the fill and the checks below, so what they prove is what
-- commits. SHARE lets every read through.
lock table public.build_jobs, public.delivery_stops in share mode;

-- ── PART 1: THE COLUMN ───────────────────────────────────────────────────────────────────
alter table public.orders add column if not exists shop_serial bigint;

comment on column public.orders.shop_serial is
  'This building''s SHOP SERIAL: the plain per-builder number from take_next_serial() (075), '
  'issued ONCE, the first time the building goes on the build board, and reused by every later '
  'build job, delivery stop and repair for it (migration 284). NULL = not issued yet. Not the tag '
  'code: that is building_serial (163). Stays NULL on an inventory sale, whose number belongs to '
  'its inventory unit. Written by portal-schedule (service role) only.';

-- 199's comment, with the new column added to the service-role-written list.
comment on table public.orders is
  'Order header. Browser UPDATE is column-scoped (migration 199) to total_cents/total_source/updated_at — the only columns portal/04-orders.jsx writes. Everything else (pretax_subtotal_cents, tax_cents, order_no, short_code, building_serial, shop_serial, submitter_user_id, client_id) is service-role-written and must stay that way: the first two are the commission base, and shop_serial (284) is a number printed on a building. WHO may update a row is migration 188''s restrictive area policies; WHICH columns is this grant.';

-- What must NOT move, taken before anything is written: every order but its new column, every
-- build job's number, every delivered stop.
create temp table m284_orders_before on commit drop as
  select o.id, to_jsonb(o) - 'shop_serial' as rest from public.orders o;
create temp table m284_jobs_before on commit drop as
  select j.id, j.serial, j.updated_at from public.build_jobs j;
create temp table m284_delivered_before on commit drop as
  select s.id, s.serial, s.updated_at from public.delivery_stops s where s.delivered_at is not null;

-- ── PART 2: FILL FROM THE NUMBERS ALREADY ISSUED ─────────────────────────────────────────
do $fill$
declare
  v_jobs  integer;
  v_stops integer;
begin
  -- Neither fill ever numbers an INVENTORY SALE: that building's number is its unit's, and an
  -- order stop for it (portal-schedule's add_stop from the buyer's design code) carries the
  -- unit's number. Copied onto the order it would be two owners for one number. The test is
  -- the one buildingSerialFor() uses: the buyer's design points at the unit, or the unit was
  -- sold to that code. (0 such orders on 2026-10-07.)

  -- (b) The building's order build job. build_jobs_one_per_design (087) allows one job per design,
  --     so a building has at most one candidate.
  update public.orders o
     set shop_serial = j.serial
    from public.build_jobs j
   where j.client_id = o.client_id
     and j.design_short_code = o.short_code
     and j.source = 'order'
     and j.serial is not null
     and o.shop_serial is null
     and not exists (select 1 from public.designs d
                      where d.client_id = o.client_id and d.short_code = o.short_code and d.inventory_unit_id is not null)
     and not exists (select 1 from public.inventory_units u
                      where u.client_id = o.client_id and u.sold_design_short_code = o.short_code);
  get diagnostics v_jobs = row_count;

  -- (c) A building with NO order job (deleted, or never on the board) whose order stop carries a
  --     number: that stop's. delivery_stops_one_per_design (090) allows one stop per design.
  update public.orders o
     set shop_serial = s.serial
    from public.delivery_stops s
   where s.client_id = o.client_id
     and s.design_short_code = o.short_code
     and s.source = 'order'
     and s.serial is not null
     and o.shop_serial is null
     and not exists (select 1 from public.build_jobs j
                      where j.client_id = o.client_id and j.design_short_code = o.short_code and j.source = 'order')
     and not exists (select 1 from public.designs d
                      where d.client_id = o.client_id and d.short_code = o.short_code and d.inventory_unit_id is not null)
     and not exists (select 1 from public.inventory_units u
                      where u.client_id = o.client_id and u.sold_design_short_code = o.short_code);
  get diagnostics v_stops = row_count;

  perform set_config('ss.m284_from_jobs', v_jobs::text, true);
  perform set_config('ss.m284_from_stops', v_stops::text, true);
end
$fill$;

-- Two buildings on one number would make the index below fail with a bare 23505. Say which.
do $dupes$
declare
  v_dupe text;
begin
  select string_agg(format('%s #%s', d.client_id, d.shop_serial), ', ' order by d.client_id, d.shop_serial) into v_dupe
    from (select o.client_id, o.shop_serial from public.orders o
           where o.shop_serial is not null group by 1, 2 having count(*) > 1) d;
  if v_dupe is not null then
    raise exception '284: two or more buildings would share a shop serial: %. Find which job or stop carries the wrong number before applying.', v_dupe;
  end if;
end
$dupes$;

create unique index if not exists orders_shop_serial_uniq
  on public.orders (client_id, shop_serial) where shop_serial is not null;

-- ── PART 3: OPEN STOPS TAKE THEIR BUILDING'S NUMBER ──────────────────────────────────────
do $realign$
declare
  v_detail text;
  v_count  integer;
begin
  select string_agg(format('%s: %s -> %s', s.id, coalesce(s.serial::text, 'none'), o.shop_serial), ', ' order by s.id::text)
    into v_detail
    from public.delivery_stops s
    join public.orders o on o.client_id = s.client_id and o.short_code = s.design_short_code
   where s.source = 'order'
     and s.delivered_at is null
     and o.shop_serial is not null
     and s.serial is distinct from o.shop_serial;

  update public.delivery_stops s
     set serial = o.shop_serial, updated_at = now()
    from public.orders o
   where o.client_id = s.client_id
     and o.short_code = s.design_short_code
     and s.source = 'order'
     and s.delivered_at is null
     and o.shop_serial is not null
     and s.serial is distinct from o.shop_serial;
  get diagnostics v_count = row_count;

  perform set_config('ss.m284_realigned', v_count::text, true);
  perform set_config('ss.m284_realigned_detail', coalesce(v_detail, '(none)'), true);
end
$realign$;

-- ── PART 4: CHECKS: raise (and so roll the whole file back) rather than commit a surprise ─
do $check$
declare
  v_col   record;
  v_bad   text;
  v_role  text;
  v_priv  text;
begin
  -- ── The column and its index ──
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'orders' and c.column_name = 'shop_serial';
  if v_col.data_type is distinct from 'bigint' or v_col.is_nullable <> 'YES' or v_col.column_default is not null then
    raise exception '284: orders.shop_serial should be a nullable bigint with no default, is % / nullable % / default %',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  end if;
  if not exists (select 1 from pg_catalog.pg_indexes i
                  where i.schemaname = 'public' and i.tablename = 'orders' and i.indexname = 'orders_shop_serial_uniq'
                    and i.indexdef = 'CREATE UNIQUE INDEX orders_shop_serial_uniq ON public.orders USING btree (client_id, shop_serial) WHERE (shop_serial IS NOT NULL)') then
    raise exception '284: orders_shop_serial_uniq is missing or not the unique (client_id, shop_serial) where shop_serial is not null this file creates';
  end if;

  -- ── Every order build job carries its building's number ──
  select string_agg(format('job %s carries #%s, its order holds #%s', j.id, coalesce(j.serial::text, 'none'), coalesce(o.shop_serial::text, 'none')), '; ' order by j.id::text)
    into v_bad
    from public.build_jobs j
    join public.orders o on o.client_id = j.client_id and o.short_code = j.design_short_code
   where j.source = 'order' and j.serial is distinct from o.shop_serial;
  if v_bad is not null then
    raise exception '284: an order build job disagrees with its building: %', v_bad;
  end if;

  -- ── No order building shares a number with a lot building ──
  select string_agg(format('%s #%s', o.client_id, o.shop_serial), ', ' order by o.client_id, o.shop_serial) into v_bad
    from public.orders o
    join public.inventory_units u on u.client_id = o.client_id and u.serial = o.shop_serial;
  if v_bad is not null then
    raise exception '284: an order building holds the same shop serial as an inventory unit: %', v_bad;
  end if;

  -- ── No open order stop disagrees with its building ──
  select string_agg(s.id::text, ', ' order by s.id::text) into v_bad
    from public.delivery_stops s
    join public.orders o on o.client_id = s.client_id and o.short_code = s.design_short_code
   where s.source = 'order' and s.delivered_at is null and o.shop_serial is not null
     and s.serial is distinct from o.shop_serial;
  if v_bad is not null then
    raise exception '284: undelivered order stops still disagree with their building: %', v_bad;
  end if;

  -- ── The counter is past every number held, so take_next_serial() cannot hand one out again ──
  select string_agg(distinct o.client_id, ', ') into v_bad
    from public.orders o
    left join public.client_settings cs on cs.client_id = o.client_id
   where o.shop_serial is not null
     and (cs.next_serial is null or cs.next_serial <= o.shop_serial);
  if v_bad is not null then
    raise exception '284: next_serial is at or below a number a building already holds, for: %. take_next_serial() would issue it again; raise next_serial first.', v_bad;
  end if;

  -- ── Nothing else moved ──
  select string_agg(b.id::text, ', ' order by b.id::text) into v_bad
    from m284_orders_before b
    left join public.orders o on o.id = b.id
   where o.id is null or (to_jsonb(o) - 'shop_serial') is distinct from b.rest;
  if v_bad is not null then
    raise exception '284: orders changed beyond shop_serial during the apply: %', v_bad;
  end if;
  if (select count(*) from m284_orders_before) <> (select count(*) from public.orders) then
    raise exception '284: the orders row count moved during the apply — run it again';
  end if;
  select string_agg(b.id::text, ', ' order by b.id::text) into v_bad
    from m284_jobs_before b
    left join public.build_jobs j on j.id = b.id
   where j.id is null or (j.serial, j.updated_at) is distinct from (b.serial, b.updated_at);
  if v_bad is not null then
    raise exception '284: build jobs changed during the apply: %', v_bad;
  end if;
  select string_agg(b.id::text, ', ' order by b.id::text) into v_bad
    from m284_delivered_before b
    left join public.delivery_stops s on s.id = b.id
   where s.id is null or (s.serial, s.updated_at) is distinct from (b.serial, b.updated_at);
  if v_bad is not null then
    raise exception '284: delivered stops changed during the apply (they are history): %', v_bad;
  end if;

  -- ── The browser cannot rewrite the number; the edge function can ──
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_column_privilege(v_role, 'public.orders', 'shop_serial', 'UPDATE') then
      raise exception '284: % holds UPDATE on orders.shop_serial; 199''s column-scoped grant is gone', v_role;
    end if;
  end loop;
  foreach v_priv in array array['SELECT', 'UPDATE'] loop
    if not has_column_privilege('service_role', 'public.orders', 'shop_serial', v_priv) then
      raise exception '284: service_role lacks % on orders.shop_serial; create_job could not keep the number', v_priv;
    end if;
  end loop;

  raise notice '284: checks hold; % filled from build jobs, % from stops, % open stop(s) realigned; % building(s) hold a shop serial',
    current_setting('ss.m284_from_jobs'), current_setting('ss.m284_from_stops'), current_setting('ss.m284_realigned'),
    (select count(*) from public.orders where shop_serial is not null);
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so a dry run (last `commit;` swapped for `rollback;`) prints the same row and
-- leaves nothing behind. Expected on 2026-10-07:
--   filled_from_jobs 9, filled_from_stops 2, stops_realigned 2 (both on the internal demo tenant),
--   orders_with_shop_serial 11, order_jobs_mismatched 0, open_stops_mismatched 0
-- A re-apply prints 0, 0, 0 and the same 11 (plus any order job created in between).
select
  '284' as migration,
  current_setting('ss.m284_from_jobs')::int as filled_from_jobs,
  current_setting('ss.m284_from_stops')::int as filled_from_stops,
  current_setting('ss.m284_realigned')::int as stops_realigned,
  current_setting('ss.m284_realigned_detail') as stops_realigned_detail,
  (select count(*) from public.orders where shop_serial is not null)::int as orders_with_shop_serial,
  (select count(*) from public.build_jobs j
     join public.orders o on o.client_id = j.client_id and o.short_code = j.design_short_code
    where j.source = 'order' and j.serial is distinct from o.shop_serial)::int as order_jobs_mismatched,
  (select count(*) from public.delivery_stops s
     join public.orders o on o.client_id = s.client_id and o.short_code = s.design_short_code
    where s.source = 'order' and s.delivered_at is null and o.shop_serial is not null
      and s.serial is distinct from o.shop_serial)::int as open_stops_mismatched;

commit;

-- After this: every order building that already had a number holds it on its order, and the
-- stops still waiting to go out show that same number. portal-schedule (shipped next) reads it
-- from there, so taking a job off the board and putting it back no longer spends a new one.
