-- 145_pm_monday_unique_constraints: 144's partial unique indexes on the Monday dedupe
-- keys can't be targeted by ON CONFLICT (Postgres requires the conflict target to match
-- the index predicate, and PostgREST's on_conflict never sends one) — which broke the
-- import's upsert path on its first real run. A plain UNIQUE constraint gives the same
-- guarantee: NULLs are distinct, so unlimited non-Monday rows still coexist.
--
-- ⚠️ APPLIED LIVE + LEDGERED as version 145 on 2026-08-27.
drop index if exists public.pm_updates_monday_idx;
alter table public.pm_updates add constraint pm_updates_monday_update_id_key unique (monday_update_id);
drop index if exists public.pm_items_monday_idx;
alter table public.pm_items add constraint pm_items_monday_item_id_key unique (monday_item_id);

-- Rollback:
--   alter table public.pm_updates drop constraint pm_updates_monday_update_id_key;
--   create unique index pm_updates_monday_idx on public.pm_updates (monday_update_id) where monday_update_id is not null;
--   alter table public.pm_items drop constraint pm_items_monday_item_id_key;
--   create unique index pm_items_monday_idx on public.pm_items (monday_item_id) where monday_item_id is not null;
