-- 149_pm_items_release_note: link a Projects item to the roadmap entry it came from.
--
-- Carolyn 2026-08-27: "I also want to have everything that is actually on the roadmap to
-- show in Projects as well." The roadmap lives in release_notes (kind='requested' /
-- status roadmap|planned|requested — what the What's New "Roadmap" tab shows tenants).
-- This column makes the mirror idempotent and lets the board mark where an item came from.
--
-- ONE-WAY on purpose: release_notes → Projects. Nothing in Projects writes back, because
-- release_notes is a PUBLICATION to every tenant and is hand-authored by rule (CLAUDE.md's
-- "What's New changelog" section). The mirror also only ever CREATES: once an item exists,
-- its name, status and notes belong to the team, so a later sync never stomps their triage.
--
-- APPLIED LIVE + LEDGERED as version 149 on 2026-08-27. Check the LEDGER for the next free
-- number, not this folder.
alter table public.pm_items add column if not exists release_note_id uuid references public.release_notes(id) on delete set null;
create unique index if not exists pm_items_release_note_idx on public.pm_items (release_note_id) where release_note_id is not null;

-- Rollback:
--   drop index public.pm_items_release_note_idx;
--   alter table public.pm_items drop column release_note_id;
