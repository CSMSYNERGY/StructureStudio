-- 144_pm_boards: the internal "Projects" module — CSM Synergy's own project management
-- (bugs, feature requests, roadmap) living in the product instead of Monday.com.
--
-- Design (decisions with Carolyn, 2026-08-27; plan in the session worklog):
--   * Monday-style flexible boards: per-board user-defined COLUMNS (typed), GROUPS,
--     ITEMS whose values live in one jsonb keyed by column id, plus an updates thread
--     and an append-only activity audit. Operators only.
--   * TENANT-UNREADABLE BY CONSTRUCTION: every pm_* table is RLS-on with ZERO policies
--     and revoked from anon+authenticated — the app_operators/admin_audit posture (051).
--     The tenant-facing truth stays in feedback_submissions/feedback_comments (054):
--     client visibility is only ever a COPY into feedback_comments performed by the
--     portal-projects edge function. This preserves 054's "/client marker" safety
--     property — there is nothing internal stored anywhere a tenant could read.
--   * Status labels carry a stable `id` (item values store the id, so renames are free —
--     the Monday "Shipped"→"Completed" lesson) and an optional `client_status` mapping
--     onto 054's 8-state ladder; labels without one are pure-internal and touch nothing
--     tenant-side. The seeds below mirror the two Monday boards' STATUS_BY_ID maps in
--     portal-feedback/index.ts verbatim (source of truth for the compression).
--   * pm_items.feedback_submission_id (UNIQUE, nullable) links a client-sourced item to
--     its mirror row; monday_item_id/monday_update_id exist purely so the one-time
--     import and the parallel-run period are idempotent.
--
-- Hand-apply via the SQL editor / MCP and record as version 144 — NEVER `supabase db push`.
-- ⚠️ APPLIED LIVE + LEDGERED as version 144 on 2026-08-27. Numbered 144 (not 128) because
-- live already carries 128–143 (usage_wallet … crm_field_changes) applied from another
-- working line whose files are not in this checkout — check the LEDGER for the next free
-- number, not this folder.

-- ── Boards ──────────────────────────────────────────────────────────────────
create table if not exists public.pm_boards (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,          -- stable machine key; automation keys on slug, never name
  name        text not null,
  position    double precision not null default 1024,
  settings    jsonb not null default '{}',
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Columns (the user-defined schema) ───────────────────────────────────────
create table if not exists public.pm_columns (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.pm_boards(id) on delete cascade,
  type       text not null check (type in
               ('status','text','long_text','number','date','people','dropdown','checkbox','link')),
  name       text not null,
  -- settings by type (validated by whitelist-rebuild in portal-projects, never trusted raw):
  --   status:   { labels: [{ id:"l_…", label, color, kind?, client_status?, intake? }] }
  --             client_status ∈ the 8 feedback_submissions states; intake marks the label
  --             new client submissions land on (exactly one per client-linked board).
  --   dropdown: { options: [{ id:"o_…", label, color }], multi: bool }
  --   number:   { unit?, precision? }
  settings   jsonb not null default '{}',
  position   double precision not null default 1024,
  width      integer,                        -- board default; per-user overrides are localStorage
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pm_columns_board_idx on public.pm_columns (board_id, position);

-- ── Groups ──────────────────────────────────────────────────────────────────
create table if not exists public.pm_groups (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.pm_boards(id) on delete cascade,
  name       text not null,
  color      text,
  position   double precision not null default 1024,
  created_at timestamptz not null default now()
);
create index if not exists pm_groups_board_idx on public.pm_groups (board_id, position);

-- ── Items ───────────────────────────────────────────────────────────────────
create table if not exists public.pm_items (
  id            uuid primary key default gen_random_uuid(),
  board_id      uuid not null references public.pm_boards(id) on delete cascade,
  group_id      uuid not null references public.pm_groups(id),
  name          text not null,
  values        jsonb not null default '{}',   -- keyed by pm_columns.id; whitelist-rebuilt server-side
  position      double precision not null default 1024,
  feedback_submission_id uuid unique references public.feedback_submissions(id) on delete set null,
  monday_item_id text,
  created_by       uuid,
  created_by_email text,                       -- denormalized; operator rows can be removed
  archived_at   timestamptz,                   -- "delete" archives; hard delete is SQL-only
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists pm_items_board_group_idx on public.pm_items (board_id, group_id, position);
create index if not exists pm_items_feedback_idx on public.pm_items (feedback_submission_id);
create unique index if not exists pm_items_monday_idx on public.pm_items (monday_item_id)
  where monday_item_id is not null;

-- ── Updates (the conversation; internal unless explicitly published) ────────
create table if not exists public.pm_updates (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null references public.pm_items(id) on delete cascade,
  author_user_id uuid,
  author_email   text,
  body           text not null,
  client_visible boolean not null default false,
  -- Set when published: the id of the COPY inserted into feedback_comments (with a NULL
  -- monday_update_id — both Monday reconcile paths delete only .eq(monday_update_id, …),
  -- verified 2026-08-27, so published copies survive a Monday refresh).
  feedback_comment_id uuid references public.feedback_comments(id) on delete set null,
  monday_update_id text,
  attachments    jsonb not null default '[]',  -- [{ path, name, size, mime }] in pm-attachments
  created_at     timestamptz not null default now(),
  edited_at      timestamptz
);
create index if not exists pm_updates_item_idx on public.pm_updates (item_id, created_at);
create unique index if not exists pm_updates_monday_idx on public.pm_updates (monday_update_id)
  where monday_update_id is not null;

-- ── Activity (append-only audit — what makes shared write access accountable) ─
create table if not exists public.pm_activity (
  id            bigserial primary key,
  board_id      uuid,
  item_id       uuid,
  actor_user_id uuid,
  actor_email   text,
  action        text not null,
  detail        jsonb not null default '{}',
  created_at    timestamptz not null default now()
);
create index if not exists pm_activity_item_idx on public.pm_activity (item_id, created_at desc);

-- ── Lockdown: internal posture (051's app_operators pattern) ─────────────────
alter table public.pm_boards   enable row level security;
alter table public.pm_columns  enable row level security;
alter table public.pm_groups   enable row level security;
alter table public.pm_items    enable row level security;
alter table public.pm_updates  enable row level security;
alter table public.pm_activity enable row level security;
-- No policies on purpose: browsers (anon or authenticated) can never read these;
-- only the portal-projects edge function (service role) touches them.
revoke all on public.pm_boards, public.pm_columns, public.pm_groups,
              public.pm_items, public.pm_updates, public.pm_activity
  from anon, authenticated;
revoke all on sequence public.pm_activity_id_seq from anon, authenticated;

-- ── Attachment bucket ───────────────────────────────────────────────────────
-- PRIVATE with NO storage policies at all — operator reads/writes go exclusively
-- through service-role signed URLs from portal-projects. feedback-attachments is NOT
-- reused: its policies grant tenant reads by folder prefix, and internal attachments
-- (screens of admin tools, stack traces) must never ride a tenant-readable bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pm-attachments', 'pm-attachments', false, 26214400,   -- 25 MB
  array['image/png','image/jpeg','image/gif','image/webp',
        'video/mp4','video/quicktime','video/webm','application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── Seed: the three boards, mirroring today's Monday boards ─────────────────
-- Label/option ids are fixed literals (not uuids): item values store them, the import
-- script matches Monday labels onto them BY LABEL TEXT, and portal-feedback's
-- parallel-run insert finds the intake label by settings — nothing looks up a uuid.
-- client_status values mirror STATUS_BY_ID in portal-feedback/index.ts exactly
-- (id 5, Monday's blank bug label, is deliberately absent there and unseeded here).
do $$
declare
  b_bugs uuid; b_feat uuid; b_road uuid;
begin
  if exists (select 1 from public.pm_boards) then return; end if;  -- seed once

  insert into public.pm_boards (slug, name, position) values ('bugs', 'Bugs', 1024)
    returning id into b_bugs;
  insert into public.pm_boards (slug, name, position) values ('features', 'Feature Requests', 2048)
    returning id into b_feat;
  insert into public.pm_boards (slug, name, position) values ('roadmap', 'Roadmap', 3072)
    returning id into b_road;

  -- Groups (import creates further Monday groups; these match the Monday group titles)
  insert into public.pm_groups (board_id, name, color, position) values
    (b_bugs, 'Incoming Bugs', '#B91C1C', 1024),
    (b_feat, 'Incoming Requests', '#1D4ED8', 1024),
    (b_road, 'Roadmap', '#3D3672', 1024),
    (b_road, 'Ops', '#64748B', 2048);

  -- Bugs columns
  insert into public.pm_columns (board_id, type, name, settings, position, width) values
    (b_bugs, 'status', 'Status', '{"labels":[
      {"id":"l_awaiting","label":"Awaiting Review","color":"#F59E0B","client_status":"in_review","intake":true},
      {"id":"l_readydev","label":"Ready for Dev","color":"#8B5CF6","client_status":"planned"},
      {"id":"l_sprints","label":"Move to ''Sprints''","color":"#6366F1","client_status":"planned"},
      {"id":"l_knownbug","label":"Known Bug","color":"#64748B","client_status":"in_review"},
      {"id":"l_fixing","label":"Fixing","color":"#2563EB","client_status":"in_progress"},
      {"id":"l_pendeploy","label":"Pending Deploy","color":"#0891B2","client_status":"in_progress"},
      {"id":"l_fixed","label":"Fixed","color":"#0E9F6E","client_status":"shipped","kind":"done"},
      {"id":"l_missinfo","label":"Missing Info","color":"#F97316","client_status":"needs_info"},
      {"id":"l_dup","label":"Duplicated","color":"#94A3B8","client_status":"duplicate","kind":"done"}
    ]}', 1024, 150),
    (b_bugs, 'people',    'Assignee', '{}', 2048, 120),
    (b_bugs, 'dropdown',  'Priority', '{"options":[
      {"id":"o_crit","label":"Critical","color":"#B91C1C"},
      {"id":"o_high","label":"High","color":"#B45309"},
      {"id":"o_med","label":"Medium","color":"#1D4ED8"},
      {"id":"o_low","label":"Low","color":"#475569"}],"multi":false}', 3072, 110),
    (b_bugs, 'text',      'Client',   '{}', 4096, 130),
    (b_bugs, 'date',      'Date',     '{}', 5120, 110),
    (b_bugs, 'long_text', 'Notes',    '{}', 6144, null);

  -- Feature Requests columns (Priority mirrors the Monday severity labels verbatim)
  insert into public.pm_columns (board_id, type, name, settings, position, width) values
    (b_feat, 'status', 'Status', '{"labels":[
      {"id":"l_new","label":"New","color":"#F59E0B","client_status":"submitted","intake":true},
      {"id":"l_review","label":"Under Review","color":"#8B5CF6","client_status":"in_review"},
      {"id":"l_planned","label":"Planned","color":"#6366F1","client_status":"planned"},
      {"id":"l_done","label":"Completed","color":"#0E9F6E","client_status":"shipped","kind":"done"},
      {"id":"l_declined","label":"Declined","color":"#94A3B8","client_status":"declined","kind":"done"}
    ]}', 1024, 150),
    (b_feat, 'people',    'Assignee', '{}', 2048, 120),
    (b_feat, 'dropdown',  'Priority', '{"options":[
      {"id":"o_critme","label":"Critical for me","color":"#B91C1C"},
      {"id":"o_help","label":"Would really help","color":"#B45309"},
      {"id":"o_nice","label":"Nice to have","color":"#475569"}],"multi":false}', 3072, 140),
    (b_feat, 'text',      'Client',   '{}', 4096, 130),
    (b_feat, 'date',      'Date',     '{}', 5120, 110),
    (b_feat, 'long_text', 'Notes',    '{}', 6144, null);

  -- Roadmap columns (internal only — no client_status mappings anywhere)
  insert into public.pm_columns (board_id, type, name, settings, position, width) values
    (b_road, 'status', 'Status', '{"labels":[
      {"id":"l_idea","label":"Idea","color":"#94A3B8"},
      {"id":"l_planned","label":"Planned","color":"#6366F1"},
      {"id":"l_building","label":"Building","color":"#2563EB"},
      {"id":"l_shipped","label":"Shipped","color":"#0E9F6E","kind":"done"}
    ]}', 1024, 130),
    (b_road, 'people',    'Assignee', '{}', 2048, 120),
    (b_road, 'dropdown',  'Priority', '{"options":[
      {"id":"o_high","label":"High","color":"#B45309"},
      {"id":"o_med","label":"Medium","color":"#1D4ED8"},
      {"id":"o_low","label":"Low","color":"#475569"}],"multi":false}', 3072, 110),
    (b_road, 'date',      'Target',   '{}', 4096, 110),
    (b_road, 'long_text', 'Notes',    '{}', 5120, null);
end $$;

-- Rollback:
--   drop table public.pm_activity, public.pm_updates, public.pm_items,
--              public.pm_groups, public.pm_columns, public.pm_boards;
--   delete from storage.buckets where id = 'pm-attachments';
