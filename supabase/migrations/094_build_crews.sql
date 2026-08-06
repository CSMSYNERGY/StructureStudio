-- 094_build_crews: named BUILD CREWS (Carolyn 2026-08-05) — builds are assigned to a crew,
-- and the Build Schedule calendar flips between per-crew calendars. Crews are a tenant's
-- own vocabulary ("TJ's crew", "Crew 2"), managed on Settings → Team next to drivers;
-- optionally linked to team logins via member_user_ids, but a crew does NOT require
-- accounts (many shop crews never log in).
--
-- build_jobs.assignee_user_id stays for old rows and individual assignment; the crew is
-- the scheduling unit going forward. Same RLS posture as everything scheduling: owner
-- SELECT, all writes through portal-schedule.

create table public.build_crews (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  name text not null,
  color text not null default '#3D3672',
  member_user_ids uuid[] not null default '{}',
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, name)
);
create index build_crews_client on public.build_crews (client_id, sort_order);
alter table public.build_crews enable row level security;
create policy build_crews_owner_select on public.build_crews
  for select to authenticated using (client_id = current_client_id());

alter table public.build_jobs add column crew_id uuid
  references public.build_crews(id) on delete set null;
create index build_jobs_crew on public.build_jobs (client_id, crew_id)
  where crew_id is not null;

-- Rollback:
--   alter table public.build_jobs drop column crew_id;
--   drop table public.build_crews;
