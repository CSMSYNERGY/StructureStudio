-- 103_inventory_drop_status: retire 075's single-axis column.
--
-- APPLY ONLY AFTER portal-settings, portal-schedule and sync-design-status are deployed AND
-- verified (download the live function and diff it — "Deployed" is not proof). Migrations and
-- edge functions ship separately, so dropping this column in 102 would have put both
-- functions into PostgREST 400s for the length of the deploy. 102 adds, this removes.
--
-- NOT kept as a generated column. A shim like
--   status generated always as (case when sale_state='sold' then 'sold' else 'available' end)
-- is tempting because it would keep portal-schedule's `.eq("status","available")` compiling —
-- and that is exactly why it is wrong. That query's MEANING changed: under the two-axis model
-- a sold-but-unbuilt spec build must STILL appear on the build board, because selling a
-- building does not build it. A query that keeps working while being wrong is the failure
-- mode this whole change exists to remove.

alter table public.inventory_units drop column status;

-- Rollback:
--   alter table public.inventory_units add column status text not null default 'available'
--     check (status in ('available','sold'));
--   update public.inventory_units
--      set status = case when sale_state = 'sold' then 'sold' else 'available' end;
