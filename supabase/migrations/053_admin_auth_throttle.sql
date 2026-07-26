-- 053_admin_auth_throttle: brute-force protection for the shared ADMIN_PASSWORD gate.
--
-- Why. `admin-catalog` and `admin-save-settings` are deployed with verify_jwt=false, so
-- the Supabase gateway performs NO check — the only barrier is a constant-time compare
-- against one shared static password. Behind that single string sit the most destructive
-- operations in the system: delete_client (hard-wipes a tenant's designs, catalog,
-- settings, logins and storage), link_owner (creates auth users + returns a one-time
-- set-password link), get_client_portal (cross-tenant customer PII) and
-- connect_email/disconnect_email (rewrites the project's Auth SMTP sender). Until now
-- there was no rate limit, no lockout, no attempt counter and no record of failures: an
-- attacker could guess at full request speed, forever, silently.
--
-- One row per bucket, where a bucket is the caller's IP (or the shared 'unknown' bucket
-- when IP attribution fails, plus a 'GLOBAL' row used as a distributed-attack brake).
-- Escalating per-IP lockout after repeated failures; a successful login clears the row.
--
-- Deliberately per-IP rather than global-hard-lock: a global lock would let an attacker
-- deny the operator access to their own admin tool. The GLOBAL row therefore only adds
-- latency (never a hard lock) so a rotating-IP attack is slowed without a DoS lever.
--
-- Service-role only — the browser never reads or writes this.
--
-- Hand-apply via the SQL editor / MCP and record as version 053 — NEVER `supabase db push`.

create table if not exists public.admin_auth_attempts (
  bucket            text primary key,              -- caller IP, 'unknown', or 'GLOBAL'
  failures          int  not null default 0,
  first_failure_at  timestamptz not null default now(),
  last_failure_at   timestamptz not null default now(),
  locked_until      timestamptz
);

alter table public.admin_auth_attempts enable row level security;
-- No policies → service_role only.
revoke all on public.admin_auth_attempts from anon, authenticated;

create index if not exists admin_auth_attempts_locked_idx
  on public.admin_auth_attempts (locked_until);

-- Rollback: drop table public.admin_auth_attempts;
