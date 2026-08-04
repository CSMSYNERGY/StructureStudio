-- 060_user_profiles: a portal user's name and phone number.
--
-- Until now a portal user's human name was stored NOWHERE. Verified 2026-07-29 across every
-- column in public and auth: no name column, no phone, no profiles table, and
-- auth.users.raw_user_meta_data holds only `email_verified` on each of the 12 users. The
-- portal's own displayName falls back to `email.split("@")[0]`, so every user's "name" in the
-- UI was really their email local-part. auth.users.phone is empty on every row.
--
-- These live on client_users rather than a separate profiles table because client_users.user_id
-- is the PRIMARY KEY — one user maps to at most one tenant, enforced by the database — so there
-- is exactly one row per person and no risk of the same human's details diverging per tenant.
-- (Cross-tenant access is modelled by app_operators, not by multiple client_users rows.)
--
-- Both are NULL for the 12 pre-existing users. Nothing derives access from them; they are
-- contact information only.

alter table public.client_users
  add column if not exists full_name text,
  add column if not exists phone text;

comment on column public.client_users.full_name is
  'The person''s name, as entered by them or by an operator. NULL for users created before 060.';
comment on column public.client_users.phone is
  'Contact phone for this portal user, free-text so international formats survive. Internal contact detail only — NOT a marketing/SMS destination, which would need its own consent record.';

-- role was free text with NO database constraint, while three separate code paths assumed
-- owner|admin|user (admin-catalog silently rewrote anything unrecognised to "owner", which
-- would quietly GRANT admin rights on a typo). Pin the allowed values at the database instead.
-- Existing data is owner x11 + user x1, so this is satisfied already.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'client_users_role_ck') then
    alter table public.client_users
      add constraint client_users_role_ck check (role in ('owner', 'admin', 'user'));
  end if;
end $$;

-- RLS is unchanged and deliberately still restrictive: client_users_select_own lets a user read
-- ONLY their own row, and there is no UPDATE policy at all. So both the self-service editor and
-- the operator's per-tenant user list go through service-role edge functions — a browser cannot
-- enumerate its own colleagues, let alone another tenant's.
