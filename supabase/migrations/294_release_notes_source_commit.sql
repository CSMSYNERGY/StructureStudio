-- 294_release_notes_source_commit.sql — which commit a What's New entry was copied from.
--
-- ⛔ APPLY BY HAND (`supabase db query --linked --file <this file>`), then record the ledger row with
--    `returning`. NEVER `supabase db push`. THE NUMBER IS TENTATIVE: take the next free version from
--    the LIVE ledger at apply time (288 is missing from the ledger; do not reuse it).
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- release-ci (supabase/functions/release-ci) copies the words a person wrote in a commit's
-- `Release-note:` trailer into release_notes, as status 'beta', when that commit lands on beta. The
-- same push can be delivered twice (a re-run of the workflow, a force-push, a retried request), so
-- the row needs to say which commit it came from, and that has to be unique: the second delivery
-- finds the row and answers "exists" instead of publishing the same note twice.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   release_notes.source_commit text, NULL for every row written by hand (all of them today, and
--   every hand INSERT after this). A PLAIN unique constraint: NULLs are distinct in Postgres, so any
--   number of hand-written rows can stay NULL while two rows can never share a sha. Not a partial
--   unique index, on purpose: PostgREST's on_conflict needs a real constraint to name.
--
-- ── WHAT IT DOES NOT TOUCH ───────────────────────────────────────────────────────────────
--   * Grants and RLS stay exactly as 045 set them (authenticated may read the whole changelog,
--     anon nothing, writes are service-role only). A new column inherits the table's grants.
--   * 103's release_notes_status_check is not touched: 'beta' is already a status.
--   * Nothing writes this column until release-ci is deployed AND RELEASE_CI_WRITES=1 is set.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   alter table public.release_notes drop constraint if exists release_notes_source_commit_key;
--   alter table public.release_notes drop column if exists source_commit;
-- (Rows release-ci wrote stay; they just lose the record of their commit.)

begin;

alter table public.release_notes add column if not exists source_commit text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'release_notes_source_commit_key'
                    and conrelid = 'public.release_notes'::regclass) then
    alter table public.release_notes
      add constraint release_notes_source_commit_key unique (source_commit);
  end if;
end $$;

comment on column public.release_notes.source_commit is
  'Full sha of the commit whose Release-note trailer this entry was copied from (release-ci). NULL = written by hand.';

-- Assertions: the column is text and nullable, the constraint is a plain unique on it alone, and
-- 103's status check is the five statuses it was.
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'release_notes'
                    and column_name = 'source_commit' and data_type = 'text' and is_nullable = 'YES') then
    raise exception '294: release_notes.source_commit is not a nullable text column';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conname = 'release_notes_source_commit_key' and conrelid = 'public.release_notes'::regclass)
     is distinct from 'UNIQUE (source_commit)' then
    raise exception '294: release_notes_source_commit_key is not UNIQUE (source_commit)';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conname = 'release_notes_status_check' and conrelid = 'public.release_notes'::regclass)
     is distinct from 'CHECK ((status = ANY (ARRAY[''shipped''::text, ''beta''::text, ''roadmap''::text, ''planned''::text, ''requested''::text])))' then
    raise exception '294: release_notes_status_check is not 103''s five statuses';
  end if;
end $$;

commit;

-- ── AFTER COMMIT ─────────────────────────────────────────────────────────────────────────
-- Read back:
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_name = 'release_notes' and column_name = 'source_commit';
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.release_notes'::regclass;
--   select count(*) filter (where source_commit is null) hand_written, count(*) total from public.release_notes;
-- Record it (re-read max(version) first; use the number you actually applied):
--   insert into supabase_migrations.schema_migrations (version, name)
--   values ('294', 'release_notes_source_commit') returning version, name;
