-- 045_release_notes: global product changelog surfaced in the owner portal ("What's New" tab).
--
-- This is NOT per-tenant — it is one shared list of product updates authored by the CSM Synergy
-- team and read by every authenticated portal user (so tenants can see what shipped to beta and
-- test it). Writes are service-role only; the team adds entries via the SQL editor / MCP. Kept
-- read-open to `authenticated` (non-sensitive product news); anon has no access.
--
-- Hand-apply via the SQL editor / MCP and record as version 045 — NEVER `supabase db push`.

create table if not exists public.release_notes (
  id          uuid primary key default gen_random_uuid(),
  released_at timestamptz not null default now(),   -- the log timestamp: when the change went live
  version     text,                                 -- optional label (edge version / sprint / date tag)
  kind        text not null default 'feature'
                check (kind in ('feature','fix','requested')),   -- feature added / bug fixed / requested
  title       text not null,
  detail      text,                                 -- optional longer description
  status      text not null default 'shipped'
                check (status in ('shipped','roadmap','planned','requested')),  -- for the roadmap section
  sort_order  int  not null default 0,              -- tiebreak within the same released_at
  created_at  timestamptz not null default now()
);

alter table public.release_notes enable row level security;

-- Any authenticated portal user may READ the whole changelog (global, non-sensitive).
drop policy if exists release_notes_auth_read on public.release_notes;
create policy release_notes_auth_read on public.release_notes
  for select to authenticated using (true);

-- No INSERT/UPDATE/DELETE policy → only service_role (which bypasses RLS) can write. Belt-and-
-- suspenders: Supabase's default public-schema grants hand anon+authenticated ALL privileges, so
-- explicitly strip them — anon gets nothing, authenticated keeps only SELECT — and writes stay
-- service-role-only even if RLS were ever toggled off.
grant select on public.release_notes to authenticated;
revoke all on public.release_notes from anon;
revoke insert, update, delete, truncate, references, trigger on public.release_notes from authenticated;

create index if not exists release_notes_released_at_idx
  on public.release_notes (released_at desc, sort_order desc);

-- Rollback: drop policy release_notes_auth_read on public.release_notes; drop table public.release_notes;
