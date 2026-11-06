-- 352_pm_system_columns.sql — Created and Requestor stop being data.
--
-- Carolyn 2026-11-01: "I need to see all the dates things were added. this should be a static field
-- and not changeable. I also need to see who added it. ... Created is already a static field in bugs
-- and feature requests. both also say CLIENT ... I want the title of it changed to requestor and then
-- if ahsan creates something it is from him, or if I do it is from me. I need the created date in
-- Ongoing projects as well and all of this in the roadmap and support."
--
-- It only LOOKED static. "Created" was an ordinary editable `date` column on four boards and absent
-- from the roadmap; "Client" was an ordinary text column holding a builder slug, blank for everything
-- the team added itself. Both are now SYNTHETIC columns that portal-projects serves on EVERY board,
-- derived on read from the row (_shared/pmSystemColumns.ts) under the reserved ids `sys_created` /
-- `sys_requestor`. sanitizeValues rebuilds every write against the board's real pm_columns, so a
-- reserved id cannot be stored, and the browser marks them read-only.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. NEVER `supabase db push`, never `--file`, never inside
--    begin;/commit;. One inline call per piece (CLI `db query --linked` or the Supabase connector's
--    execute_sql):
--
--   F=supabase/migrations/352_pm_system_columns.sql
--   piece() { awk -v n="$1" '{sub(/\r$/,"")} $0=="-- >>> "n{on=1;next} $0=="-- <<< "n{on=0} on' "$F" | grep -v '^--'; }
--   "$SB" db query --linked "$(piece P0)"      # must print ONE row: 352, 352_pm_system_columns
--   "$SB" db query --linked "$(piece P1)"      # the column + the backfill
--   "$SB" db query --linked "$(piece P2)"      # retire the four editable duplicates
--   "$SB" db query --linked "$(piece R1)"      # THE RECORD
--
-- P0 claims the number first: no row back means another session took 352, so rename this file, its
-- test (tests/sql/migration352.test.cjs) and every '352' below. Read the max first, numbered rows only:
-- select max(version) filter (where version ~ '^\d{3}$') from supabase_migrations.schema_migrations;
--
-- ── WHY source_created_at EXISTS ─────────────────────────────────────────────────────────
-- 21 items came in from the monday.com import (2026-08-27) carrying their ORIGINAL monday creation
-- date in the "Created" cell, while their pm_items.created_at is the day of the import. Deriving
-- Created from created_at alone would have silently rewritten three months of history the day this
-- shipped — measured before writing this: 18 such rows on Feature Requests, 3 on Bugs. So P1 adds a
-- nullable `source_created_at` and backfills it from that cell wherever the two disagree. Nothing
-- writes the column afterwards; for every row born here it stays NULL and created_at is the truth.
--
-- ── WHY THE OLD COLUMNS GO, AND WHAT IS KEPT ─────────────────────────────────────────────
-- Leaving them would put two "Created" columns side by side, one of them still editable — which is
-- the thing she asked to end. P2 deletes the pm_columns ROWS only and deliberately leaves every
-- pm_items.values key alone, so the data is still in the jsonb and the change is reversible by
-- re-inserting the columns with their old ids (printed by R1 before they go). Carolyn's own board
-- keeps its hand-made "Added On" date column: it is hers, not a duplicate of this.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- pm_* tables are internal-only (RLS on, zero policies, revoked) and reached solely through
-- portal-projects / portal-feedback with the service role, so no tenant and no anon browser can see
-- any of this. A saved view (pm_views) naming a deleted column loses that one part on read — the
-- browser skips a facet whose column is gone — and a board with no "Created"/"Client" column simply
-- gets fewer defaults from mirrorToProjects and defaultValues, which both match by NAME.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   -- the columns, with the ids R1 recorded (values are still in the jsonb):
--   insert into public.pm_columns (id, board_id, name, type, settings, position) values (…);
--   alter table public.pm_items drop column if exists source_created_at;
--   delete from supabase_migrations.schema_migrations where version = '352' returning version;
-- (Also redeploy the previous portal-projects and un-push the portal parts, or the synthetic columns
--  keep being served alongside the restored ones.)
--
-- The repo is public: no builder names or ids in here.

-- >>> P0
insert into supabase_migrations.schema_migrations (version, name)
values ('352', '352_pm_system_columns')
on conflict (version) do nothing
returning version, name;
-- <<< P0

-- >>> P1
do $m352_p1$
declare
  n_backfilled int;
begin
  perform set_config('lock_timeout', '5s', true);
  if to_regclass('public.pm_items') is null or to_regclass('public.pm_columns') is null then
    raise exception '352: apply 144_pm_boards first; nothing changed';
  end if;

  alter table public.pm_items add column if not exists source_created_at timestamptz;

  comment on column public.pm_items.source_created_at is
    'The date this item was created SOMEWHERE ELSE, where that is older than created_at: the original '
    'monday.com creation date for the 2026-08-27 import (352). NULL for every row born here. '
    '_shared/pmSystemColumns.ts reads coalesce(source_created_at, created_at) as the static Created '
    'column; nothing writes this after the backfill.';

  -- The backfill. For each board's "Created" date column, take the cell where it is a real date and
  -- disagrees with created_at's own date, and keep it as the original. Matched by NAME + TYPE, never
  -- by uuid — every board seeds its own column ids (the pmOverlay rule).
  with created_cols as (
    select c.board_id, min(c.id::text) as col_id
      from public.pm_columns c
     where c.type = 'date' and c.name = 'Created'
     group by c.board_id
  ), cells as (
    select i.id,
           (i.values ->> cc.col_id) as cell
      from public.pm_items i
      join created_cols cc on cc.board_id = i.board_id
     where i.source_created_at is null
  )
  update public.pm_items i
     set source_created_at = (cells.cell)::timestamptz
    from cells
   where cells.id = i.id
     and cells.cell ~ '^\d{4}-\d{2}-\d{2}$'
     and cells.cell <> to_char(i.created_at, 'YYYY-MM-DD');
  get diagnostics n_backfilled = row_count;
  raise notice '352: kept the original date on % item(s)', n_backfilled;

  perform pg_notify('pgrst', 'reload schema');
end
$m352_p1$;
-- <<< P1

-- >>> P2
-- Retire the editable duplicates. The ROWS go; pm_items.values keeps its keys, so this is
-- reversible — the ids are printed here and again by R1.
with gone as (
  delete from public.pm_columns c
   where (c.type = 'date' and c.name = 'Created')
      or (c.type = 'text' and c.name = 'Client')
  returning c.id, c.board_id, c.name, c.type, c.position
)
select b.slug, gone.name, gone.type, gone.id as retired_column_id, gone.position
  from gone join public.pm_boards b on b.id = gone.board_id
 order by b.slug, gone.position;
-- <<< P2

-- THE RECORD. Expect: column_ready true; no_editable_duplicates true; backfilled 21 on live;
-- every item answering a Created date.
-- >>> R1
select exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'pm_items'
                  and column_name = 'source_created_at' and data_type = 'timestamp with time zone'
                  and is_nullable = 'YES') as column_ready,
       not exists (select 1 from public.pm_columns
                    where (type = 'date' and name = 'Created') or (type = 'text' and name = 'Client')) as no_editable_duplicates,
       (select count(*) from public.pm_items where source_created_at is not null) as backfilled,
       (select count(*) from public.pm_items where archived_at is null
          and coalesce(source_created_at, created_at) is null) as items_with_no_created_date;
-- <<< R1
