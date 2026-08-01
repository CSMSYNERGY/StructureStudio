-- 072_app_errors_resolution.sql
--
-- `app_errors` had exactly one field for triage state: a `resolved` boolean. So closing a row
-- recorded THAT it was closed and nothing else — not when, and not why.
--
-- That matters here more than it would elsewhere, because "check app_errors after publishing" is a
-- standing habit on this project, and the table is the dependable diagnostic channel (the Supabase
-- runtime log stream is not reliably queryable — see CLAUDE.md). Two concrete costs, both hit
-- during the 2026-08-01 post-audit wash:
--
--   * 139 rows were closed in one pass across six distinct reasons (a fix commit, a stale-before-fix
--     timestamp argument, localhost test artifacts, designed rejections, a superseded deploy-window
--     transient, and an opaque error class whose diagnosability was itself the fix). None of that
--     could live on the row, so the reasoning had to be written into a vault note — and a triager
--     reading the table alone sees 143 closed rows with no explanation attached to any of them.
--   * Five rows had been deliberately KEPT OPEN as evidence for specific findings. Nothing in the
--     table said so. That intent survived only because it was written down elsewhere, and the next
--     person to "tidy up" the table would have had no way to know from the data.
--
-- Both columns are nullable and nothing is required to set them, so every existing writer
-- (log_error, logEdgeError, ssLogError) is unaffected and needs no change.

alter table public.app_errors
  add column if not exists resolved_at    timestamptz,
  add column if not exists resolution_note text;

comment on column public.app_errors.resolved_at is
  'When the row was closed. NULL on rows closed before 2026-08-01, because the column did not exist '
  'then — absence here means "unknown", not "never".';

comment on column public.app_errors.resolution_note is
  'Why the row was closed: the fix commit, the supersession argument, or "test artifact". Also the '
  'place to say why a row is being kept OPEN on purpose, so that intent lives with the data instead '
  'of in a note someone has to find.';

-- Backfill a pointer, not a fabrication. Every row resolved as of this migration was closed in the
-- 2026-08-01 wash except a small number that were already closed beforehand; the two are no longer
-- distinguishable, so the note says so rather than asserting a single cause for all of them.
-- resolved_at is deliberately left NULL — inventing a timestamp would be worse than admitting the
-- column started empty.
-- The pointer is deliberately generic: this repo is PUBLIC, so it names neither the internal
-- document nor anything that identifies a tenant. The StructureStudio work log in the team vault
-- is the single place that triage history lives, which is enough to find the reasoning.
update public.app_errors
   set resolution_note = 'Closed 2026-08-01 in a triage pass; per-class reasoning is recorded in the '
                      || 'StructureStudio work log. A few rows were already resolved beforehand and '
                      || 'are not distinguished here.'
 where resolved = true
   and resolution_note is null;
