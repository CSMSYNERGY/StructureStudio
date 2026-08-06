-- 100_user_access: job titles + per-person, per-area access (Carolyn, 2026-08-06).
--
-- "I think in the TEAM section we need to be able to add people throughout the company —
--  Owners, Admins, Sales Reps, Crew Leaders, Drivers. I want the access to each to be as
--  dynamic as possible per individual. Admins and Owners should assign each user the
--  access they want to give them (tab by tab) and they may choose Read or Edit."
--
-- SHAPE — two columns on client_users, deliberately not a new table:
--   * `title`  — the job label AND the preset that seeds their switches.
--   * `access` — ONLY the deviations from that preset, as { area: level }.
--     Effective access = preset(title) merged with access. Storing overrides rather than a
--     full map means a preset can be improved later and everyone who never customised
--     simply inherits it; it also makes "is this person customised?" a NULL check.
--
-- Why columns and not an access table: resolveTenant already SELECTs this row on every
-- single authenticated request. Reading permissions from it costs nothing, while a joined
-- table would add a round trip to every call in the product.
--
-- `role` STAYS as-is (owner|admin|user) and remains the coarse authority every existing
-- gate reads. Title is the human label; role still answers "may this person manage people
-- and settings at all". Owners are absolute: their access map is ignored entirely.
--
-- LEVELS: 'none' | 'view' | 'edit'. Commissions additionally understands 'own' (see your
-- own payout and nothing else), which is why levels are text and not an enum — the vocabulary
-- is per-area, and a CHECK here would have to be rewritten for every future area.
--
-- BACKFILL (Carolyn's call, this session): owners and admins keep exactly what they have;
-- everyone on role='user' lands on the Sales Rep preset — the closest match to what a user
-- can already do (Designs and Contacts, no settings), so nobody is locked out or silently
-- upgraded on the day this ships.
--
-- NOT covered by this: drivers and crew members who have no login. Migrations 094/095
-- made those name-first records that may never map to a client_users row, and access can
-- only ever attach to something you can sign in as. They are unaffected.

alter table public.client_users add column title text;
alter table public.client_users add column access jsonb;

comment on column public.client_users.title is
  'Job label + access preset: owner | admin | sales_rep | crew_leader | driver. See _shared/access.ts for the presets.';
comment on column public.client_users.access is
  'ONLY the per-area deviations from the title preset: { area: "none"|"view"|"edit"|"own" }. NULL/absent = inherit the preset.';

update public.client_users
   set title = case role
                 when 'owner' then 'owner'
                 when 'admin' then 'admin'
                 else 'sales_rep'
               end
 where title is null;

alter table public.client_users
  add constraint client_users_title_check
  check (title is null or title in ('owner','admin','sales_rep','crew_leader','driver'));

-- Rollback:
--   alter table public.client_users drop constraint client_users_title_check;
--   alter table public.client_users drop column access;
--   alter table public.client_users drop column title;
