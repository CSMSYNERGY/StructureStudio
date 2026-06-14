-- 000_prereqs: name-complete the 004/006-011 chain for a from-scratch replay.
--
-- set_updated_at() predates this repo: it was created by a FILE-LESS pre-repo
-- migration (one of the 20260504-20260515 timestamp migrations on the live DB,
-- see supabase/CUTOVER_HANDOFF.md Task 2). 004 only ALTERs its search_path and
-- 006-011 only bind it as a `before update` trigger — nothing in the repo
-- DEFINES it. Without this file a clean `supabase db reset` / fresh replay fails
-- at 004's `alter function ...` and at every `create trigger ... set_updated_at()`.
--
-- IDEMPOTENT + NO-OP ON LIVE: `create or replace` rewrites a byte-identical body
-- to the one already on jzeamjbhdrsbygdnphbm; triggers bound to it keep working
-- (replace does not drop dependents). Applying this on live changes nothing.
--
-- SCOPE: this closes ONLY the set_updated_at gap. The other file-less pre-repo
-- objects (designs / client_configs / client_settings tables, the http
-- extension) are NOT recreated here — reconstructing them by hand would risk
-- drift. A truly green `db reset` needs them backfilled via `supabase db pull`
-- (an operational step that requires live-DB auth). See CUTOVER_HANDOFF.md.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
