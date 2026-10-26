-- 316_full_building_serials.sql — the FULL building serial, issued at the sale and frozen:
--     1027-LBA-1216-REBUWHM-25698
--
-- ⛔ APPLY BY HAND. Pipe to `supabase db query --linked` (stdin), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('316', '316_full_building_serials') returning version, name;
--    REHEARSAL: sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/316_full_building_serials.sql | npx supabase db query --linked -o csv
--
-- ── WHY (Carolyn 2026-10-18) ─────────────────────────────────────────────────────────────
-- "I want to add full serial numbers. 1027-LBA-1216-REBUWHM-25698 — 2 digit month of build date,
-- 2 digit year of build date - Style - size - siding color code, trim color code, roof color
-- code, and then the building number." … "make sure that we can/are using this for all invoice
-- and inventory serial numbers."
--
--     1027    MMYY
--     LBA     building_styles.code
--     1216    size, each side padded to 2 digits (as 163)
--     REBUWHM siding code + trim code + roof code + S/M (shingle/metal — 163's "always S or M")
--     25698   the BUILDING NUMBER: the shop serial (take_next_serial, 075/284), NOT order_no
--
-- This REPLACES 163's shape (0826LBA1016REBLDWS5000: MMDD, no dashes, order number on the end).
--
-- ── WHEN IT IS ISSUED (asked 2026-10-18, answered "At the sale, frozen") ─────────────────
-- An invoice goes out before the building is built, so the serial is minted when the ORDER row is
-- created, with MMYY = the order month (America/Chicago) and the next shop serial as the building
-- number. It never changes afterwards — with ONE exception: a segment that printed as a
-- placeholder (XXX / XX / X) because the builder had not entered that code yet is filled in when
-- they do. A placeholder was never readable off a tag, so filling it changes nothing anyone relied on.
--
-- An INVENTORY building gets its full serial when the unit is created (its number is already
-- taken there, 075), MMYY = the unit's created month. While the unit is unsold its middle follows
-- its master design, so a spec building re-coloured before it sells carries the colours it has.
-- An order that SELLS an inventory building copies the unit's full serial: one building, one tag.
--
-- A builder who has never set a starting number (client_settings.next_serial NULL) is NOT
-- numbered at the sale: printing #1 on an invoice for a shop already at #12,000 is worse than
-- printing nothing. Those orders keep the pre-316 path (a number at the build board, 284) and get
-- their full serial the moment that number lands (orders_mint_on_shop_serial below). The
-- Settings card tells the builder their starting number is required.
--
-- ── NEVER BREAKS AN ORDER ────────────────────────────────────────────────────────────────
-- Every mint runs in its own exception block. A failure (a unique collision on a resold lot
-- building, a design that vanished) leaves the serial NULL and the order is still created —
-- numbering is a label on top of the sale, the same contract mintBuildingSerial (163) keeps.

begin;

set local lock_timeout = '5s';

-- ── COLUMNS ──────────────────────────────────────────────────────────────────────────────
alter table public.inventory_units add column if not exists full_serial text;
comment on column public.inventory_units.full_serial is
  'Full building serial MMYY-STYLE-SIZE-COLORS-NUMBER (migration 316). Minted at unit creation; '
  'the middle follows the master design while the unit is unsold. Service-role written.';
comment on column public.orders.building_serial is
  'Full building serial MMYY-STYLE-SIZE-COLORS-NUMBER (migration 316, replacing 163''s shape). '
  'Minted when the order is created (order month + shop serial), or copied from the inventory '
  'unit it sells. Frozen except that placeholder segments fill in when codes are added.';

-- ── THE MIDDLE: STYLE-SIZE-COLORS ────────────────────────────────────────────────────────
-- 163's lookups, unchanged in substance (live JSON shapes: selections.style is the KEY,
-- body/trim are LABELS in paint_colors, roof narrowed by roofType). Only the joins differ:
-- dashes between blocks.
create or replace function public.ss_serial_middle(p_client_id text, p_short_code text)
returns text
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_sel jsonb; v_paint jsonb;
  v_style text; v_size text; v_siding text; v_trim text; v_roof text;
  v_rooftype text; v_mat text;
begin
  select selections, coalesce(paint_colors, '{}'::jsonb) into v_sel, v_paint
    from public.designs where client_id = p_client_id and short_code = p_short_code;
  if v_sel is null then return null; end if;

  select nullif(btrim(code), '') into v_style
    from public.building_styles
   where client_id = p_client_id and key = v_sel->>'style' limit 1;
  v_style := upper(coalesce(v_style, 'XXX'));

  v_size := lpad(regexp_replace(split_part(lower(coalesce(v_sel->>'size', '')), 'x', 1), '\D', '', 'g'), 2, '0')
         || lpad(regexp_replace(split_part(lower(coalesce(v_sel->>'size', '')), 'x', 2), '\D', '', 'g'), 2, '0');

  select nullif(btrim(c.code), '') into v_siding from public.colors c
   where c.client_id = p_client_id and c.label = nullif(btrim(v_paint->>'body'), '')
     and not c.shingle and not c.metal limit 1;
  select nullif(btrim(c.code), '') into v_trim from public.colors c
   where c.client_id = p_client_id and c.label = nullif(btrim(v_paint->>'trim'), '')
     and not c.shingle and not c.metal limit 1;

  v_rooftype := lower(btrim(coalesce(v_sel->>'roofType', '')));
  v_mat := case v_rooftype when 'shingle' then 'S' when 'metal' then 'M' else 'X' end;

  select nullif(btrim(c.code), '') into v_roof from public.colors c
   where c.client_id = p_client_id and c.label = nullif(btrim(v_sel->>'roofColor'), '')
     and (case when v_rooftype = 'shingle' then c.shingle
               when v_rooftype = 'metal'   then c.metal
               else (c.shingle or c.metal) end) limit 1;

  return v_style || '-' || v_size || '-'
      || upper(coalesce(v_siding, 'XX')) || upper(coalesce(v_trim, 'XX')) || upper(coalesce(v_roof, 'XX'))
      || v_mat;
end;
$function$;

create or replace function public.ss_full_serial(p_client_id text, p_short_code text, p_building_no bigint, p_on timestamptz)
returns text
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_mid text;
begin
  if p_building_no is null then return null; end if;
  v_mid := public.ss_serial_middle(p_client_id, p_short_code);
  if v_mid is null then return null; end if;
  return to_char(coalesce(p_on, now()) at time zone 'America/Chicago', 'MMYY') || '-' || v_mid || '-' || p_building_no::text;
end;
$function$;

-- A stored serial with a NEW middle, keeping its frozen first and last blocks. NULL when the
-- stored value is not in the 316 shape (5 dash-separated blocks).
create or replace function public.ss_serial_with_middle(p_serial text, p_middle text)
returns text
language sql
immutable
as $function$
  select case
    when p_serial is null or p_middle is null then null
    when array_length(string_to_array(p_serial, '-'), 1) <> 5 then null
    else split_part(p_serial, '-', 1) || '-' || p_middle || '-' || split_part(p_serial, '-', 5)
  end;
$function$;

-- Does this serial still carry a placeholder (a code that was missing when it was minted)?
create or replace function public.ss_serial_has_placeholder(p_serial text)
returns boolean
language sql
immutable
as $function$
  select p_serial is not null and (
    split_part(p_serial, '-', 2) = 'XXX'
    or split_part(p_serial, '-', 4) like '%XX%'
    or right(split_part(p_serial, '-', 4), 1) = 'X'
  );
$function$;

-- ── ONE ORDER'S SERIAL ───────────────────────────────────────────────────────────────────
-- p_take_number: may this call take a NEW shop number? true at order creation; false for the
-- backfill (which only ever describes numbers already issued).
create or replace function public.ss_assign_order_serial(p_order_id uuid, p_take_number boolean)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  o record; u record; v_no bigint; v_serial text; v_counter bigint;
begin
  select id, client_id, short_code, shop_serial, building_serial, ordered_at, created_at
    into o from public.orders where id = p_order_id;
  if o.id is null or o.short_code is null or o.building_serial is not null then
    return o.building_serial;
  end if;

  -- An INVENTORY SALE: the building already has its number and tag (the test 284 uses).
  select iu.id, iu.serial, iu.design_short_code, iu.full_serial, iu.created_at into u
    from public.inventory_units iu
   where iu.client_id = o.client_id
     and (iu.sold_design_short_code = o.short_code
          or iu.id = (select d.inventory_unit_id from public.designs d
                       where d.client_id = o.client_id and d.short_code = o.short_code))
   limit 1;
  if u.id is not null then
    v_serial := coalesce(u.full_serial, public.ss_full_serial(o.client_id, u.design_short_code, u.serial, u.created_at));
    if v_serial is not null then
      update public.orders set building_serial = v_serial where id = o.id and building_serial is null;
    end if;
    return v_serial;
  end if;

  -- Only a real customer design is a building (never an inventory master).
  if not exists (select 1 from public.designs d where d.client_id = o.client_id and d.short_code = o.short_code
                   and coalesce(d.status, '') <> 'inventory') then
    return null;
  end if;

  v_no := o.shop_serial;
  if v_no is null then
    if not p_take_number then return null; end if;
    select next_serial into v_counter from public.client_settings where client_id = o.client_id;
    if v_counter is null then return null; end if;   -- starting number never set: see header
    v_no := public.take_next_serial(o.client_id);
  end if;

  v_serial := public.ss_full_serial(o.client_id, o.short_code, v_no, coalesce(o.ordered_at, o.created_at));
  update public.orders set shop_serial = v_no, building_serial = v_serial where id = o.id;
  return v_serial;
end;
$function$;

-- 163's entry point, which portal-schedule's mintBuildingSerial still calls at Mark built. Kept
-- so that path needs no deploy; it now returns the 316 serial (order month + building number)
-- and ignores the order number and build day it is handed. NULL when the order has no building
-- number yet, which mintBuildingSerial already treats as "not yet".
create or replace function public.ss_build_serial(p_client_id text, p_short_code text, p_order_no bigint, p_built_on date)
returns text
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  o record; v_unit text;
begin
  select shop_serial, building_serial, ordered_at, created_at into o
    from public.orders where client_id = p_client_id and short_code = p_short_code;
  if o.building_serial is not null then return o.building_serial; end if;
  select coalesce(iu.full_serial, public.ss_full_serial(p_client_id, iu.design_short_code, iu.serial, iu.created_at)) into v_unit
    from public.inventory_units iu
   where iu.client_id = p_client_id
     and (iu.sold_design_short_code = p_short_code
          or iu.id = (select d.inventory_unit_id from public.designs d where d.client_id = p_client_id and d.short_code = p_short_code))
   limit 1;
  if v_unit is not null then return v_unit; end if;
  return public.ss_full_serial(p_client_id, p_short_code, o.shop_serial, coalesce(o.ordered_at, o.created_at));
end;
$function$;

-- ── TRIGGERS ─────────────────────────────────────────────────────────────────────────────
create or replace function public.orders_mint_serial_trg()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    perform public.ss_assign_order_serial(new.id, tg_op = 'INSERT');
  exception when others then
    raise warning 'ss_assign_order_serial(%) failed: %', new.id, sqlerrm;
  end;
  return null;
end;
$function$;

-- AFTER, not BEFORE: an upsert ... ON CONFLICT DO NOTHING fires BEFORE INSERT triggers for rows
-- that then never land, which would burn a shop number on every idempotent re-ensure.
drop trigger if exists orders_mint_serial on public.orders;
create trigger orders_mint_serial after insert on public.orders
  for each row execute function public.orders_mint_serial_trg();

-- A pre-316 / no-starting-number order whose number arrives later (the build board, 284).
drop trigger if exists orders_mint_on_shop_serial on public.orders;
create trigger orders_mint_on_shop_serial after update of shop_serial on public.orders
  for each row when (new.shop_serial is not null and new.building_serial is null)
  execute function public.orders_mint_serial_trg();

create or replace function public.inventory_units_mint_serial_trg()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    update public.inventory_units
       set full_serial = public.ss_full_serial(new.client_id, new.design_short_code, new.serial, new.created_at)
     where id = new.id and full_serial is null;
  exception when others then
    raise warning 'inventory full_serial(%) failed: %', new.id, sqlerrm;
  end;
  return null;
end;
$function$;

drop trigger if exists inventory_units_mint_serial on public.inventory_units;
create trigger inventory_units_mint_serial after insert on public.inventory_units
  for each row execute function public.inventory_units_mint_serial_trg();

-- An unsold spec building's tag follows its master design.
create or replace function public.designs_inventory_serial_trg()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    update public.inventory_units iu
       set full_serial = coalesce(public.ss_serial_with_middle(iu.full_serial, public.ss_serial_middle(iu.client_id, iu.design_short_code)), iu.full_serial)
     where iu.client_id = new.client_id and iu.design_short_code = new.short_code
       and iu.sale_state = 'unsold' and iu.full_serial is not null;
  exception when others then
    raise warning 'inventory serial follow(%) failed: %', new.short_code, sqlerrm;
  end;
  return null;
end;
$function$;

drop trigger if exists designs_inventory_serial on public.designs;
create trigger designs_inventory_serial after update of selections, paint_colors on public.designs
  for each row when (new.status = 'inventory')
  execute function public.designs_inventory_serial_trg();

-- A code was added or changed: fill the placeholders on this builder's serials.
create or replace function public.ss_fill_serial_placeholders(p_client_id text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record; v_new text; n integer := 0;
begin
  for r in select id, short_code, building_serial from public.orders
            where client_id = p_client_id and public.ss_serial_has_placeholder(building_serial) loop
    begin
      v_new := public.ss_serial_with_middle(r.building_serial, public.ss_serial_middle(p_client_id, r.short_code));
      if v_new is not null and v_new <> r.building_serial then
        update public.orders set building_serial = v_new where id = r.id;
        n := n + 1;
      end if;
    exception when unique_violation then null;
    end;
  end loop;
  for r in select id, design_short_code, full_serial from public.inventory_units
            where client_id = p_client_id and public.ss_serial_has_placeholder(full_serial) loop
    v_new := public.ss_serial_with_middle(r.full_serial, public.ss_serial_middle(p_client_id, r.design_short_code));
    if v_new is not null and v_new <> r.full_serial then
      update public.inventory_units set full_serial = v_new where id = r.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$function$;

create or replace function public.catalog_code_fill_trg()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    perform public.ss_fill_serial_placeholders(new.client_id);
  exception when others then
    raise warning 'ss_fill_serial_placeholders(%) failed: %', new.client_id, sqlerrm;
  end;
  return null;
end;
$function$;

drop trigger if exists colors_code_fill on public.colors;
create trigger colors_code_fill after insert or update of code on public.colors
  for each row when (new.code is not null and new.code <> '')
  execute function public.catalog_code_fill_trg();
drop trigger if exists building_styles_code_fill on public.building_styles;
create trigger building_styles_code_fill after insert or update of code on public.building_styles
  for each row when (new.code is not null and new.code <> '')
  execute function public.catalog_code_fill_trg();

-- ── GRANTS: service role only (REVOKE FROM PUBLIC — see 163) ─────────────────────────────
revoke execute on function public.ss_serial_middle(text, text) from public, anon, authenticated;
revoke execute on function public.ss_full_serial(text, text, bigint, timestamptz) from public, anon, authenticated;
revoke execute on function public.ss_assign_order_serial(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.ss_fill_serial_placeholders(text) from public, anon, authenticated;
revoke execute on function public.ss_build_serial(text, text, bigint, date) from public, anon, authenticated;
revoke execute on function public.orders_mint_serial_trg() from public, anon, authenticated;
revoke execute on function public.inventory_units_mint_serial_trg() from public, anon, authenticated;
revoke execute on function public.designs_inventory_serial_trg() from public, anon, authenticated;
revoke execute on function public.catalog_code_fill_trg() from public, anon, authenticated;
grant execute on function public.ss_serial_middle(text, text) to service_role;
grant execute on function public.ss_full_serial(text, text, bigint, timestamptz) to service_role;
grant execute on function public.ss_assign_order_serial(uuid, boolean) to service_role;
grant execute on function public.ss_fill_serial_placeholders(text) to service_role;
grant execute on function public.ss_build_serial(text, text, bigint, date) to service_role;

-- ── BACKFILL ─────────────────────────────────────────────────────────────────────────────
-- Inventory units: every unit has a number already (075).
update public.inventory_units
   set full_serial = public.ss_full_serial(client_id, design_short_code, serial, created_at)
 where full_serial is null;

-- 163-shaped serials (no dashes) are replaced by the 316 shape. Only one existed live
-- (structure-studio, the internal test tenant). Cleared here, re-minted just below.
update public.orders set building_serial = null
 where building_serial is not null and array_length(string_to_array(building_serial, '-'), 1) <> 5;

-- Orders: describe numbers ALREADY issued (shop_serial, or the inventory unit sold). Never takes
-- a new number — numbering past orders would hand out numbers for buildings long since tagged
-- on paper.
do $bf$
declare r record;
begin
  for r in select id from public.orders where building_serial is null and short_code is not null loop
    begin
      perform public.ss_assign_order_serial(r.id, false);
    exception when others then
      raise warning 'backfill %: %', r.id, sqlerrm;
    end;
  end loop;
end
$bf$;

-- THE RECORD
select
  (select count(*) from public.inventory_units where full_serial is not null) as units_with_full_serial,
  (select count(*) from public.inventory_units) as units_total,
  (select count(*) from public.orders where building_serial is not null) as orders_with_full_serial,
  (select count(*) from public.orders where shop_serial is not null) as orders_with_shop_serial,
  (select string_agg(building_serial, ' ' order by building_serial) from public.orders where building_serial is not null) as order_serials,
  (select string_agg(full_serial, ' ' order by full_serial) from public.inventory_units) as unit_serials;

commit;
