-- 334_pm_board_privacy.sql — private boards, and a straight answer to "who can see this?"
-- Follows 333 (meeting_video_connect).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('334', '334_pm_board_privacy') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
--    REHEARSAL (changes nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/334_pm_board_privacy.sql | npx supabase db query --linked -o csv
--
-- ── WHAT CAROLYN ASKED FOR (2026-10-23) ─────────────────────────────────────────────────
--   "Board settings in projects should have privacy settings so admins can create a board
--    for themselves that others can't see. Somehow we need to easily see who all has
--    access to see a board."
--
--   Two decisions she made when asked:
--     * VISIBLE BUT LOCKED, not hidden. A private board still appears in the tab strip with
--       a padlock and its owner's name; opening it is refused. Rationale is hers: a board
--       nobody can see is a board nobody can ask to join, and the Projects console has one
--       small team on it — the name is not the secret, the work is.
--     * Members are drawn from everyone who can reach Projects at all — platform operators
--       AND internal team members granted the `projects` area (projectsAccess.ts's two
--       doors). Not operators only.
--
-- ── WHY MEMBERSHIP IS A TABLE AND NOT A jsonb LIST IN pm_boards.settings ────────────────
-- settings already carries overlay_from and is rebuilt wholesale by update_board-ish writes.
-- An access list that can be clobbered by an unrelated save of the same column is a security
-- control with a race in it. A row per person also makes "which boards can this login see?"
-- one indexed read, which list_boards does on every load.
--
-- ── NO RLS POLICIES, DELIBERATELY ───────────────────────────────────────────────────────
-- Same posture as 144: the pm_* tables are revoked from anon/authenticated and reached only
-- by portal-projects with the service role. The privacy rule therefore lives in that
-- function's door (_shared/pmBoardPrivacy.ts), which is where every other Projects access
-- rule already lives and where it can be unit-tested. RLS here would be a second, untested
-- copy of the same rule — and the one the browser never reaches.

begin;

-- ── pm_boards: visibility + who made it ─────────────────────────────────────────────────
alter table public.pm_boards
  add column if not exists visibility text not null default 'everyone',
  add column if not exists created_by uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pm_boards_visibility_chk' and conrelid = 'public.pm_boards'::regclass
  ) then
    alter table public.pm_boards
      add constraint pm_boards_visibility_chk check (visibility in ('everyone', 'private'));
  end if;
end $$;

comment on column public.pm_boards.visibility is
  'everyone = any login that can open Projects; private = only pm_board_members rows (the name still shows, locked).';
comment on column public.pm_boards.created_by is
  'auth.users id of whoever created the board. Seeds the first owner row; never the access check by itself.';

-- ── Who is on a private board ───────────────────────────────────────────────────────────
-- A row here grants SIGHT of the board. It does not grant write: that is still can_write /
-- the projects area, resolved at the door exactly as before. The two are independent on
-- purpose — a read-only operator added to a private board reads it read-only.
create table if not exists public.pm_board_members (
  board_id   uuid not null references public.pm_boards (id) on delete cascade,
  user_id    uuid not null,
  email      text,
  name       text,
  -- 'owner' may change the board's visibility and its member list. The creator is seeded as
  -- one, and the LAST owner can never be removed — a private board with no owner is a board
  -- whose access list nobody can ever open again.
  role       text not null default 'member',
  added_at   timestamptz not null default now(),
  added_by   uuid,
  primary key (board_id, user_id),
  constraint pm_board_members_role_chk check (role in ('owner', 'member'))
);
create index if not exists pm_board_members_user_idx on public.pm_board_members (user_id);

alter table public.pm_board_members enable row level security;
revoke all on public.pm_board_members from anon, authenticated;

-- Existing boards stay exactly as they are: 'everyone' is the column default, and the five
-- boards that exist today were made before anyone could choose. Nothing is backfilled into
-- pm_board_members — a public board has no member list, by design, because "who can see it"
-- is then a question about the roster, not about the board.

commit;
