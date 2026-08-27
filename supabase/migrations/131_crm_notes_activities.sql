-- 131_crm_notes_activities.sql — the two genuinely NEW writable objects behind the
-- Pipedrive-style record page: a note, and a scheduled activity.
--
-- Everything else the record page shows already exists somewhere (designs, design_versions,
-- email_sends, design_acceptances, change_orders, invoice_sends, orders, captured_leads) and
-- is assembled at request time. These two have nowhere to live.
--
-- Carolyn, 2026-08-21, walking Pipedrive: "let me just add a note, you can do like meeting
-- scheduling, like right here, activity, here's where you can set up a call ... here's
-- everything that happened. This is not just a conversations view. This is also my
-- activities view."
--
-- Scope: inert on apply.
--
-- Rollback:
--   drop table if exists public.crm_activities;
--   drop table if exists public.crm_notes;

create table if not exists public.crm_notes (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null,
  contact_id uuid references public.crm_contacts(id),
  short_code text,                       -- design scope; soft link, the orders precedent
  body       text not null,
  pinned     boolean not null default false,
  created_by uuid,                       -- trigger-stamped, never trusted from the body
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- SOFT delete. A note is evidence of what someone was told and when; hard-deleting it
  -- removes the only record that a conversation happened.
  deleted_at timestamptz,
  constraint crm_notes_scope check (contact_id is not null or short_code is not null)
);
create index if not exists crm_notes_contact_idx
  on public.crm_notes (client_id, contact_id, created_at desc) where deleted_at is null;
create index if not exists crm_notes_code_idx
  on public.crm_notes (client_id, short_code, created_at desc) where deleted_at is null;

create table if not exists public.crm_activities (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null,
  contact_id uuid references public.crm_contacts(id),
  short_code text,
  kind       text not null check (kind in ('call','meeting','task','deadline','email','lunch')),
  subject    text not null,
  due_at     timestamptz,                -- null = an undated task
  all_day    boolean not null default false,
  duration_minutes integer,
  assignee_user_id uuid,
  note       text,
  done       boolean not null default false,
  done_at    timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_activities_scope check (contact_id is not null or short_code is not null)
);

-- ⚠️ THIS PARTIAL INDEX *IS* THE FOCUS BLOCK'S QUERY. Focus = open activities, soonest
-- first. Dropping it does not break the page, it silently turns every record open into a
-- full scan of every activity the tenant has ever completed.
create index if not exists crm_activities_focus
  on public.crm_activities (client_id, due_at) where done = false;
create index if not exists crm_activities_contact_idx
  on public.crm_activities (client_id, contact_id, due_at);
create index if not exists crm_activities_code_idx
  on public.crm_activities (client_id, short_code, due_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT-only for the browser. Every write goes through portal-settings.
-- ─────────────────────────────────────────────────────────────────────────────
-- NOT browser-direct-under-RLS, which is the orders / change_orders precedent, and the
-- reason is worth stating: RLS can only express TENANT scoping. `contacts` is a real
-- access AREA with real presets — driver and crew_leader resolve to `none`. Expressing
-- that in a policy would mean a second SQL copy of the preset table, and _shared/access.ts
-- is explicit that one definition is the entire point ("a permission table that drifts is
-- a permission table that lies"). So the gate stays in one place, in the edge function.
alter table public.crm_notes      enable row level security;
alter table public.crm_activities enable row level security;

revoke all on public.crm_notes      from anon, authenticated;
revoke all on public.crm_activities from anon, authenticated;
grant select on public.crm_notes      to authenticated;
grant select on public.crm_activities to authenticated;

drop policy if exists crm_notes_owner_select on public.crm_notes;
create policy crm_notes_owner_select on public.crm_notes
  for select to authenticated using (client_id = public.current_client_id());
drop policy if exists crm_activities_owner_select on public.crm_activities;
create policy crm_activities_owner_select on public.crm_activities
  for select to authenticated using (client_id = public.current_client_id());

-- Belt and braces over a service-role-only write path: stamp the author and freeze the
-- immutable columns, so the invariants survive if anyone ever adds an INSERT policy.
create or replace function public.crm_stamp_author()
returns trigger language plpgsql security definer set search_path to 'public'
as $fn$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    new.created_at := coalesce(new.created_at, now());
  else
    new.client_id  := old.client_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $fn$;

drop trigger if exists crm_notes_stamp on public.crm_notes;
create trigger crm_notes_stamp before insert or update on public.crm_notes
  for each row execute function public.crm_stamp_author();
drop trigger if exists crm_activities_stamp on public.crm_activities;
create trigger crm_activities_stamp before insert or update on public.crm_activities
  for each row execute function public.crm_stamp_author();
