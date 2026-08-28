-- 146_pm_views: shared saved views for the internal Projects boards.
-- Carolyn 2026-08-27: "make the saved views server-side so we all share them" - so a view
-- is per BOARD and shared by the whole operator team, not per person. Same internal
-- posture as every other pm_* table (RLS on, ZERO policies, revoked): only portal-projects
-- (service role) touches it, and no tenant has a read path.
--
-- Supersedes the localStorage-per-browser saved views shipped hours earlier; the client
-- migrates any local ones up on first load and then drops its key.
--
-- APPLIED LIVE + LEDGERED as version 146 on 2026-08-27. Check the LEDGER for the next
-- free number, not this folder (live carries 128-143 from another working line).
create table if not exists public.pm_views (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.pm_boards(id) on delete cascade,
  name       text not null,
  -- The whole working state of the board: { q, facets, when, groupBy, sortKey, sortDir,
  -- hiddenCols }. Whitelist-rebuilt in the edge function on every write, never trusted raw.
  snap       jsonb not null default '{}',
  position   double precision not null default 1024,
  created_by       uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One view per name per board: saving over a name UPDATES it (the fn upserts on this),
-- which is what "save this view" means the second time you use the same name.
create unique index if not exists pm_views_board_name_idx on public.pm_views (board_id, name);
create index if not exists pm_views_board_idx on public.pm_views (board_id, position);

alter table public.pm_views enable row level security;
revoke all on public.pm_views from anon, authenticated;

-- Rollback:
--   drop table public.pm_views;
