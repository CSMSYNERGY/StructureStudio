-- 020_drop_config_style_item_cols: get_config is now table-driven (019), so the
-- client_configs.building_styles / layout_items jsonb columns are dead weight.
-- Back them up permanently, then drop. The data also lives (and is now edited)
-- in the relational tables building_styles/building_sizes + client_layout_items/
-- layout_item_types. HAND-APPLY only. BOM-free.
--
-- Rollback note: to revert the 019 cutover you would first restore these columns
-- from the backup, then create-or-replace get_config back to the column body.

create table if not exists public.client_configs_styleitem_backup as
  select client_id, building_styles, layout_items, now() as backed_up_at
  from public.client_configs;

alter table public.client_configs drop column building_styles;
alter table public.client_configs drop column layout_items;
