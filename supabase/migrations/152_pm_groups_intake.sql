-- 152_pm_groups_intake: name the group new client submissions land in, instead of guessing.
--
-- portal-feedback's mirror picked "the first group by position", which was fine until the
-- Monday import created a SECOND intake group per board (Monday's titles carried stray
-- whitespace — "Incoming  Bugs" — so the name match missed and made a new group). Result:
-- submissions land in one group while the team triages the other, and nothing on screen
-- explains why. Found by Carolyn's 2026-08-28 module review; confirmed in the data first.
--
-- The flag is per board and behaves like a radio — the partial unique index enforces at
-- most one intake group per board. Defaulting it to today's lowest-position group keeps
-- current behaviour until somebody picks deliberately in Board settings.
--
-- APPLIED LIVE + LEDGERED as version 152 on 2026-08-28 (150 and 151 were taken by another working line mid-session - the ledger is the source of truth for the next number). Check the LEDGER for the next
-- free number, not this folder.
alter table public.pm_groups add column if not exists intake boolean not null default false;

update public.pm_groups g
set intake = true
where g.id = (
  select g2.id from public.pm_groups g2
  where g2.board_id = g.board_id
  order by g2.position asc, g2.created_at asc
  limit 1
);

create unique index if not exists pm_groups_one_intake_idx on public.pm_groups (board_id) where intake;

-- Rollback:
--   drop index public.pm_groups_one_intake_idx;
--   alter table public.pm_groups drop column intake;
