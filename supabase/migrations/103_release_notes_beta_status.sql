-- 103_release_notes_beta_status: publish release notes when the work lands on BETA, then
-- flip them to Live on Monday when beta is promoted to main.
--
-- Carolyn, 2026-08-08: "We need to publish all release notes as they happen, but it should
-- always say 'on beta for testing', so they can see and test things in Beta before the
-- release. Then on Monday after the push to main we need to change it to Live."
--
-- WHY A NEW STATUS AND NOT A NEW COLUMN: `status` already means "how real is this" —
-- roadmap / planned / requested / shipped. "On beta" is another point on that same line,
-- one step before shipped. A parallel boolean would let a row claim both roadmap and beta.
--
-- THE LADDER, end to end:
--   requested/roadmap/planned  ->  beta  ->  shipped
--                                   ^          ^
--                          merged to beta   promoted to main on Monday
--
-- The flip is done by .github/workflows/merge-beta-to-main.yml AFTER the merge succeeds —
-- deliberately not on a timer of its own. A clock-based flip would announce "Live" for
-- code that never shipped on any week the merge failed or was skipped (which has happened:
-- see the -50 / SIGPIPE bug in that workflow's own comments).
--
-- NOTE the CHECK is replaced, not added to: Postgres has no "alter constraint" for this.

alter table public.release_notes drop constraint if exists release_notes_status_check;

alter table public.release_notes
  add constraint release_notes_status_check
  check (status = any (array['shipped'::text, 'beta'::text, 'roadmap'::text, 'planned'::text, 'requested'::text]));

-- Rollback (only safe once no row is still 'beta' — the CHECK would reject them):
--   update public.release_notes set status = 'shipped' where status = 'beta';
--   alter table public.release_notes drop constraint release_notes_status_check;
--   alter table public.release_notes
--     add constraint release_notes_status_check
--     check (status = any (array['shipped'::text, 'roadmap'::text, 'planned'::text, 'requested'::text]));
