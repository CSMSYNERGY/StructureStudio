-- 147_operator_display_name: names for operators, and a way to find one by email.
--
-- Carolyn 2026-08-27: "The Assignee tab needs to be able to add or edit the users." The
-- Assignee picker IS the operator roster (app_operators), which until now was editable
-- only by hand in SQL and displayed as the email's prefix.
--
-- ⚠️ app_operators is a PRIVILEGE table: a row grants cross-tenant operator access to
-- every builder's account (051). The Projects roster editor therefore adds only people who
-- ALREADY have a StructureStudio login, states plainly what the grant means, and writes an
-- admin_audit row for every add/remove/permission change.
--
-- APPLIED LIVE + LEDGERED as version 147 on 2026-08-27. Check the LEDGER for the next free
-- number, not this folder.
alter table public.app_operators add column if not exists display_name text;

-- Adding an operator means naming an existing login, and app_operators is keyed on
-- auth.users(id) — which PostgREST cannot reach. This is the narrow lookup the roster
-- editor needs: ONE row, by exact email, nothing else exposed. Service-role only.
create or replace function public.pm_find_user_by_email(p_email text)
returns table (id uuid, email text)
language sql
security definer
stable
set search_path = ''
as $$
  select u.id, u.email::text
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
  limit 1;
$$;
revoke execute on function public.pm_find_user_by_email(text) from public, anon, authenticated;

-- Rollback:
--   drop function public.pm_find_user_by_email(text);
--   alter table public.app_operators drop column display_name;
