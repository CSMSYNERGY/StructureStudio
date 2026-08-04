-- 080_version_inventory_source: label each SAVED VERSION as an inventory or a new build.
--
-- Carolyn, 2026-08-02: "the words inventory in the designs tab should be listed behind the
-- name of the building in the versions… and then we should also be able to recreate a
-- complete new build in that same contact and show as another version".
--
-- designs.inventory_unit_id (075) says what the design is tied to RIGHT NOW, so it cannot
-- describe history: a customer quoted on lot building #12049 who then asks for a fresh
-- custom build gets a v2 on the SAME design, and v1 must keep reading "Inventory" while v2
-- reads "New". That is a per-version fact, so it lives on the version row.
--
-- Written by portal-settings' link_design_to_unit immediately after a submit (the newest
-- version row), NOT by save_design — save_design is anon-callable and must never learn to
-- write inventory links.
alter table public.design_versions add column inventory_unit_id uuid
  references public.inventory_units(id) on delete set null;

-- Existing linked estimates predate this column; every version they have today was quoted
-- from the unit the design still points at.
update public.design_versions v
   set inventory_unit_id = d.inventory_unit_id
  from public.designs d
 where d.short_code = v.short_code
   and d.inventory_unit_id is not null;
