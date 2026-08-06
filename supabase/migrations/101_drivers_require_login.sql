-- 101_drivers_require_login: every driver is a person on the team.
--
-- Carolyn, 2026-08-06: "drivers and crew leaders need a login." This corrects the
-- optional-login model 095 introduced a day earlier — that migration was answering a
-- different request ("I need to be able to give our drivers names"), and inferred that a
-- name should be able to stand alone. It shouldn't: a driver signs in to see their loads
-- and mark a delivery done, and per-person access (migration 100) can only ever attach to
-- something you can sign in as. `display_name` survives as an optional label on top of
-- their real name — a nickname, or "Dad's truck" — which is what 095 actually needed.
--
-- SAFE TO TIGHTEN: checked immediately before writing this — 3 driver_profiles rows, 0 of
-- them without a login. Nothing to convert, nobody to chase. The application path was
-- closed first (portal-schedule's save_driver now refuses to create or unlink a
-- login-less driver), so this constraint cannot start rejecting writes the product still
-- makes; it is here to keep the invariant true against hand-edits and future code.
--
-- Crews needed no schema change: build_crews.member_user_ids has always been user ids.
-- What it lacked was a CHECK that those ids are members of THIS tenant, which the same
-- commit adds in save_crew (isUuid alone let any uuid at all be stored, including another
-- tenant's user).

alter table public.driver_profiles alter column user_id set not null;

-- The partial unique index from 095 (one profile per login) can now be a plain unique
-- constraint, but leave it: it is correct either way, and rewriting an index costs a lock
-- for no behaviour change.

-- Rollback (restores 095's optional-login model):
--   alter table public.driver_profiles alter column user_id drop not null;
