-- APPLIED LIVE 2026-08-29 and LEDGERED (version 20260829192014).
-- Numbered against the LEDGER, not the folder: 162 was taken by 162_crm_above_suite on
-- origin/beta while this was being written, and the folder carries two 160s.
--
-- 163_building_serials: every physical building gets a serial number.
--
-- Carolyn, 2026-08-28 @55:00-61:28, after a day with Yoder Barns: "oh, serial numbers.
-- That's a thing. My guys have been asking for serial numbers." She then wrote the format
-- on screen at 57:00 and read it out piece by piece.
--
-- ⚠️ THE WHITEBOARD IS THE SPEC, NOT THE MEETING SUMMARY. What she wrote was
--     0826LBA1016REBLDWS5000
-- Fathom's summary rendered that as `082626-LBA-1016-RE-BL-DR(S)-5000`, which is wrong
-- three times over: a YY that is not there, separators that are not there, and DR for a
-- roof code that reads DW (Driftwood). Ahsan confirmed the whiteboard shape: MMDD, no
-- separators. Read the recording, not the summary.
--
--     0826   MMDD the building was BUILT
--     LBA    style code -- "all of their buildings have codes. They come up with them"
--     1016   size
--     RE     siding colour
--     BL     trim colour
--     DW     roof colour
--     S      S for shingle, M for metal -- "it'll always have S or M at the end"
--     5000   order number, "whatever sequence that they start"
--
-- WHY IT EXISTS, which decides where it lives: "they build inventory and have it sitting
-- out on display, and they're like, I don't know when this building was built." Plus
-- reading a spec off the tag in front of a customer: "you have two different tans and
-- you're like, I don't know if this is tan or if this is beige, and you look at the code."
--
-- ⚠️ ONE OPEN QUESTION FOR CAROLYN, because she said both halves. "The first number is the
-- day that the building GETS BUILT" and, minutes later, "the serial number will be stored
-- with the order, 100% with the order. There is no serial number until the order is
-- created." Those conflict: the build date is not known at order time. Built to mint at
-- MARK BUILT, when the date is real and the physical tag is actually made, with a preview
-- available on the order before then -- which serves the stated purpose. Confirm before the
-- freeze; if she wants order date instead, only the call site moves, not this function.

begin;

-- ── CODES ────────────────────────────────────────────────────────────────────────────
-- "We may want to actually have the code shown here and LET THEM CHANGE THE CODES, and
-- here's why..." -- so these are editable text, not derived from the label. A builder's
-- existing paper system already has codes and the app has to match it, not the reverse.
alter table public.colors          add column if not exists code text;
alter table public.building_styles add column if not exists code text;

-- Unique WITHIN A SECTION, exactly like the labels in 161, and for the same reason: a
-- shingle Black and a metal Black are different products. The predicates below are 161's
-- character for character -- if one moves, both move, or the screen and the database
-- disagree about what a duplicate is.
--
-- `code <> ''` matters: a blank is "not set yet", and every un-coded row would otherwise
-- collide with every other un-coded row the moment this index is created.
create unique index if not exists colors_paint_code_uniq
  on public.colors (client_id, code) where (not shingle and not metal) and code is not null and code <> '';
create unique index if not exists colors_shingle_code_uniq
  on public.colors (client_id, code) where shingle and code is not null and code <> '';
create unique index if not exists colors_metal_code_uniq
  on public.colors (client_id, code) where metal and code is not null and code <> '';
create unique index if not exists building_styles_code_uniq
  on public.building_styles (client_id, code) where code is not null and code <> '';

-- ── THE SERIAL ITSELF ────────────────────────────────────────────────────────────────
-- ⚠️ NOT `build_jobs.serial`, and not take_next_serial(). That is the SHOP COUNTER -- a
-- plain per-builder integer that inventory units and build jobs already mint from, and
-- CLAUDE.md's scheduling rule 3 ("order build jobs mint from take_next_serial() LAST, a
-- rejected payload must not burn a number") is about protecting it. Two different things
-- that both got called "serial"; keeping them apart is deliberate.
alter table public.orders add column if not exists building_serial text;
-- One serial identifies one building, per builder. Partial so un-minted orders don't collide.
create unique index if not exists orders_building_serial_uniq
  on public.orders (client_id, building_serial) where building_serial is not null;

-- ── ORDER NUMBERS START WHERE THE BUILDER SAYS ───────────────────────────────────────
-- "the very last number is the order number, which will be whatever sequence that they
-- start, 5,000."
alter table public.client_settings add column if not exists order_no_start bigint;

-- The allocator was `coalesce(max(order_no), 1000) + 1`, per client, advisory-locked.
-- Two properties are preserved exactly:
--   * the lock, so two concurrent accepts cannot take the same number;
--   * the default, since with no start set this still yields 1001 then max+1 forever.
-- What is new is the floor. greatest() rather than a seed means setting a start on a
-- builder who ALREADY has orders jumps them forward (1021 -> 5000) instead of silently
-- doing nothing, which is what "whatever sequence they start" has to mean for a builder
-- migrating off paper mid-year. It can never go backwards: max+1 always wins if it is
-- higher, so no existing order is ever renumbered and no number is ever reused.
create or replace function public.orders_assign_no()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_start bigint;
begin
  perform pg_advisory_xact_lock(hashtext('ss_order_no:' || new.client_id));
  select order_no_start into v_start from public.client_settings where client_id = new.client_id;
  select greatest(coalesce(max(order_no), 0) + 1, coalesce(v_start, 1001))
    into new.order_no
    from public.orders where client_id = new.client_id;
  return new;
end;
$function$;

commit;

-- ── ASSEMBLING THE SERIAL ────────────────────────────────────────────────────────────
begin;

-- Built against the LIVE json shapes, not the ones CLAUDE.md describes. Checked 2026-08-29
-- against real rows, and three of them differ from the documentation in ways that would
-- have produced a silently wrong serial:
--   * selections->>'style' is the style KEY ("utility", "cabin"), never the label.
--   * body/trim are NOT in selections. They live in designs.paint_colors {body,trim}, as
--     display LABELS ("Mountain Red", "White"), and are frequently "".
--   * roofColor/roofType are frequently "" too -- most stored designs have no roof picked.
--
-- ⚠️ MISSING PARTS BECOME XX, THEY DO NOT COLLAPSE. A serial is a key someone reads off a
-- tag with a customer standing there; fixed-width segments are what make it decodable at
-- all. Dropping an unset colour would silently shift every later segment left and turn a
-- trim code into a roof code.
--
-- Size is parsed from the label rather than joined to building_sizes, because the label is
-- what the builder already says out loud, and a design can outlive the catalog row it was
-- built from. Each dimension is padded to two digits: 10x16 -> 1016 exactly as Carolyn
-- wrote it, and 8x12 -> 0812 rather than an ambiguous 812 that also reads as 81x2.
create or replace function public.ss_build_serial(
  p_client_id text,
  p_short_code text,
  p_order_no bigint,
  p_built_on date
) returns text
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

  -- Paint section = the same predicate 161's index uses: not shingle and not metal.
  select nullif(btrim(c.code), '') into v_siding from public.colors c
   where c.client_id = p_client_id and c.label = nullif(btrim(v_paint->>'body'), '')
     and not c.shingle and not c.metal limit 1;
  select nullif(btrim(c.code), '') into v_trim from public.colors c
   where c.client_id = p_client_id and c.label = nullif(btrim(v_paint->>'trim'), '')
     and not c.shingle and not c.metal limit 1;

  v_rooftype := lower(btrim(coalesce(v_sel->>'roofType', '')));
  v_mat := case v_rooftype when 'shingle' then 'S' when 'metal' then 'M' else 'X' end;

  -- Narrowed by the material the customer picked, so a builder holding a shingle Black and
  -- a metal Black -- which 161 exists to allow -- gets the right one of the two.
  select nullif(btrim(c.code), '') into v_roof from public.colors c
   where c.client_id = p_client_id and c.label = nullif(btrim(v_sel->>'roofColor'), '')
     and (case when v_rooftype = 'shingle' then c.shingle
               when v_rooftype = 'metal'   then c.metal
               else (c.shingle or c.metal) end) limit 1;

  return to_char(coalesce(p_built_on, current_date), 'MMDD')
      || v_style
      || v_size
      || upper(coalesce(v_siding, 'XX'))
      || upper(coalesce(v_trim,   'XX'))
      || upper(coalesce(v_roof,   'XX'))
      || v_mat
      || coalesce(p_order_no::text, '');
end;
$function$;

-- ⚠️ REVOKE FROM PUBLIC, NOT JUST FROM THE ROLES. Every new function on this project is
-- anon-callable through /rpc/ by default, and the PUBLIC grant survives revoking the
-- individual roles -- so revoking only anon/authenticated leaves it wide open. This one
-- reads another tenant's catalog if you hand it their client_id.
revoke execute on function public.ss_build_serial(text, text, bigint, date) from public, anon, authenticated;
grant  execute on function public.ss_build_serial(text, text, bigint, date) to service_role;

commit;
