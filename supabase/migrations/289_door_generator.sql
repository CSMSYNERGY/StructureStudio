-- 289_door_generator.sql — the DOOR GENERATOR: four built door looks, and windows that can go in a door.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations with `returning`. NEVER `supabase db push`. The file
--    carries its own begin;/commit;, so every assertion below takes the whole migration with it if
--    it fails. The number may be renamed at apply time (see NUMBERING).
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   fixture_items.door_style: the CHECK gains the generator's four looks, 'american',
--            'basic', 'classic' and 'dutch' (modelled on 187, which last widened it).
--   PART 2   fixture_items.in_door boolean not null default false: a WINDOW the builder ticked "Can
--            be used inside a door". A second CHECK keeps it false on every other category.
--   PART 3   get_fixtures, derived from the LIVE body, sends `inDoor: true` for a window whose
--            in_door is set, and nothing new for any other row.
--   PART 3A  apply-time assertions: both checks as written, the column's shape, the body exactly the
--            one written here, every tenant's get_fixtures byte-for-byte unchanged, and a rolled-back
--            probe that saves an American door and an in-door window and reads them back.
--   after commit: recording the row, verification and rollback, as comments.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- A builder sells four hinged shed doors, each also as a double -- American, Basic, Classic and
-- Dutch -- and asked (2026-10-06) for three things the catalog could not say:
--   * "picking the style should show that door in 3D". A photo laid on the opening can only be
--     tinted one colour, so it cannot colour the frame and the panels separately, and every real
--     one of these doors is a trim-coloured frame round panels of the building's own siding. The
--     designer now BUILDS them (trimDoorLeaf): door_style names which one. A double is the row's
--     existing op_double, so "American double" is an american row with Double ticked -- no column.
--   * windows inside doors, without uploading the same door once per window it can take. A window
--     row ticked in_door is offered in the door picker for these four looks, where it fits the upper
--     panel of one leaf, and is priced as its OWN window line, one per leaf (submit-estimate already
--     re-prices windows[] by fixtureItemId with no category filter; the payload marks the line
--     `inDoor`). It is never folded into the door's line: an included door nets its whole price.
--   * in the window settings, "a can be used inside a door option": the in_door tick.
--
-- WHAT EACH LOOK IS (drawn by the designer, not stored): a frame of two stiles and top and bottom
-- rails, a mid rail at 42% of the leaf, black T-strap hinges and a latch, a header board and an
-- aluminium threshold; then basic = nothing more, american = four pickets below the mid rail,
-- classic = an octagon and a diamond above it and an X below, dutch = a small louvred vent below.
--
-- ── WHY door_style AND NOT A NEW COLUMN ──────────────────────────────────────────────────
-- 186 and 187 settled it: the look is ONE value from a whitelist, so a new look is a wider CHECK.
-- Every allowed list agrees on the same nine values: this CHECK, portal-settings validateFixtureRow,
-- D3_DOOR_STYLES in portal/03-catalog.jsx and in both designer twins. Anything a designer does not
-- know reads as 'auto', so a production designer that predates this file draws these doors as it
-- always did (the photo or the raised-panel slab) and ignores inDoor -- safe, if plainer.
--
-- ── WHY in_door IS A COLUMN, NOT A LIST ON THE DOOR ──────────────────────────────────────
-- The builder's own words put the switch on the WINDOW ("window settings get a ... option"), and a
-- window either can go in a door or it cannot; which door is decided by whether it fits, which the
-- designer measures. A NOT NULL boolean with a constant default is a metadata-only add (no rewrite),
-- and every existing row reads false, so nothing is offered in a door until a builder ticks one.
--
-- ⚠️ A WHOLE-FUNCTION REPLACE, DERIVED FROM THE LIVE BODY. Dumped READ-ONLY 2026-10-07 with
--   select pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
-- its prosrc (carriage returns removed) has md5 276d22b7c1a3d60ebe7c5d6e58373de6, which is 272's
-- body byte for byte, and the body below is that text plus ONE merge, after 272's styleKeys. The
-- pre-apply block refuses to replace anything else, so a get_fixtures some other change replaced
-- since cannot be quietly reverted by this file: re-dump, carry that change in, update both md5s.
-- Grants are untouched: create or replace keeps them.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-07: 286 is the newest recorded; 287 and 288 are held by other batches. 289 is
-- this batch's working number and may be renamed at apply time. Confirm then:
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 4;
-- must not already show the number this file is applied as.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database.
-- PART 1 only widens a check: every row that was valid stays valid, and the live portal-settings
-- turns the four new values into 'auto' before they reach the table, so it is inert until the new
-- portal-settings ships.
-- PART 2 adds a column every row reads false in, with a check every row passes. The live
-- portal-settings never writes it.
-- PART 3 sends `inDoor` only for a window with in_door set, which none is until the new
-- portal-settings saves one; live designers ignore the key either way. PART 3A checks every
-- tenant's get_fixtures is unchanged by the apply. The apply waits at most 5 s for a lock.
--
-- ── DEPLOY ORDER ─────────────────────────────────────────────────────────────────────────
--   1. this file, and its ledger row (AFTER APPLYING, A), BEFORE the batch merges into the
--      integration branch. portal-settings' catalog read now selects in_door and every fixture save
--      writes it: deployed ahead of this file, every builder's Settings catalog fails to load on the
--      unknown column, and every fixture save fails.
--   2. portal-settings and submit-estimate (edge functions are one project for beta and production,
--      so both are live everywhere at once). submit-estimate only adds "Window in door: <door>" to
--      a windows[] line marked inDoor and keeps it off a wall window's group; no client sends the
--      flag yet, so it is inert until step 3.
--   3. the designer twins and the portal, compiled, to beta; drive them there.
--   4. promotion to production.
--   Tell builders to pick the four looks and tick "Can be used inside a door" only after step 4: a
--   production designer before it draws the looks as 'auto', and it neither offers nor charges a
--   window in a door (a design saved from beta with one would quote from production without it).

begin;

set local lock_timeout = '5s';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — door_style: the generator's four looks
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 187's shape: drop the constraint if it is there, re-add it with the wider list. 'auto' stays the
-- default and is still what every existing row holds unless a builder picked another look.
do $m289_style$
begin
  if exists (select 1 from pg_constraint where conname = 'fixture_items_door_style_chk'
              and conrelid = 'public.fixture_items'::regclass) then
    alter table public.fixture_items drop constraint fixture_items_door_style_chk;
  end if;
  alter table public.fixture_items
    add constraint fixture_items_door_style_chk
    check (door_style in ('auto', 'plank', 'zbrace', 'xbrace', 'rollup', 'american', 'basic', 'classic', 'dutch'));
end
$m289_style$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — in_door: a window that can go inside a door
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.fixture_items add column if not exists in_door boolean not null default false;

-- Windows only. portal-settings forces it false on every other category already; the check makes
-- the database say so too, so no door, ramp or vent can ever be offered inside a door.
do $m289_indoor$
begin
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_in_door_window_chk'
                  and conrelid = 'public.fixture_items'::regclass) then
    alter table public.fixture_items
      add constraint fixture_items_in_door_window_chk check (not in_door or category = 'window');
  end if;
end
$m289_indoor$;

comment on column public.fixture_items.in_door is
  'A window the builder ticked "Can be used inside a door" (migration 289). The designer offers it in '
  'the upper panel of the four built door looks (door_style american, basic, classic, dutch) where '
  'it fits one leaf, and prices it as its own window line, one per leaf. Windows only '
  '(fixture_items_in_door_window_chk). get_fixtures sends inDoor: true only when set.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — get_fixtures sends inDoor
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ── Pre-apply: the body below replaces only the get_fixtures it was derived from ──────────────
-- The markers say WHAT moved when something did; the md5 says whether anything did. Carriage
-- returns are removed first, so a file applied with Windows line endings reads the same. The
-- second md5 is this file's own body, so a re-apply passes.
do $m289_fix_pre$
declare
  v_src text;
begin
  if to_regprocedure('public.get_fixtures(text)') is null then
    raise exception '289: public.get_fixtures(text) does not exist. PART 3 REPLACES a live function; '
                    'creating it from here would ship a body nobody verified.';
  end if;
  select replace(p.prosrc, E'\r', '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if position('doorStyle' in v_src) = 0 then
    raise exception '289: the LIVE get_fixtures has no doorStyle merge (186). Re-derive PART 3 from a fresh dump before applying.';
  end if;
  if position('styleKeys' in v_src) = 0 then
    raise exception '289: the LIVE get_fixtures has no styleKeys merge (272). Apply 272 first, or re-derive PART 3 from a fresh dump.';
  end if;
  if md5(v_src) not in ('276d22b7c1a3d60ebe7c5d6e58373de6', 'c23b2e457c56312b84866937ad982fac') then
    raise exception '289: the LIVE get_fixtures (prosrc md5 %) is neither the body PART 3 was derived from on 2026-10-07 nor the one it writes, so another change has replaced it since. Re-dump it (select prosrc from pg_proc where oid = ''public.get_fixtures(text)''::regprocedure), carry that change into PART 3, and update both md5s.', md5(v_src);
  end if;
end
$m289_fix_pre$;

-- Every tenant's catalog as it is now, for PART 3A to compare against. Dropped at commit.
create temp table m289_fixtures_before on commit drop as
  select cc.client_id, md5(public.get_fixtures(cc.client_id)::text) as h from public.client_configs cc;

-- ── get_fixtures: the live body plus inDoor ──────────────────────────────────────────────────
-- The only change from the live body is the one merge after styleKeys. Emitted ONLY for a window
-- with in_door set, so every fixture that exists today comes out byte-for-byte as it did. doorStyle
-- needs nothing: 186's merge already sends whatever look is stored, the four new ones included.
create or replace function public.get_fixtures(p_client_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_show    boolean;
  v_items   jsonb;
  v_wcolors jsonb;
  v_mode    text; v_method text; v_img text; v_showimg boolean; v_price numeric; v_enabled boolean;
begin
  if not exists (select 1 from public.client_configs where client_id = p_client_id) then
    raise exception 'unknown client';
  end if;

  select coalesce(cs.show_pricing, false), cs.ramp_mode, cs.ramp_price_method, cs.ramp_image_url, cs.ramp_show_image, cs.ramp_price, cs.ramp_enabled
    into v_show, v_mode, v_method, v_img, v_showimg, v_price, v_enabled
    from public.client_settings cs where cs.client_id = p_client_id;
  v_show := coalesce(v_show, false);

  select coalesce(jsonb_agg(
    (case when v_show then
      jsonb_build_object(
        'id', fi.id, 'category', fi.category, 'name', fi.name, 'planLabel', fi.plan_label,
        'widthIn', fi.width_in, 'heightIn', fi.height_in, 'price', fi.price,
        'swingIn', fi.swing_in, 'swingOut', fi.swing_out, 'swingDefault', fi.swing_default,
        'opRight', fi.op_right, 'opLeft', fi.op_left, 'opDouble', fi.op_double,
        'opSlideUp', fi.op_slideup, 'opDefault', fi.op_default,
        'imageUrl', fi.image_url, 'sortOrder', fi.sort_order)
    else
      jsonb_build_object(
        'id', fi.id, 'category', fi.category, 'name', fi.name, 'planLabel', fi.plan_label,
        'widthIn', fi.width_in, 'heightIn', fi.height_in,
        'swingIn', fi.swing_in, 'swingOut', fi.swing_out, 'swingDefault', fi.swing_default,
        'opRight', fi.op_right, 'opLeft', fi.op_left, 'opDouble', fi.op_double,
        'opSlideUp', fi.op_slideup, 'opDefault', fi.op_default,
        'imageUrl', fi.image_url, 'sortOrder', fi.sort_order)
    end)
    || case when coalesce(fi.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
    || case when coalesce(fi.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end
    || jsonb_build_object('colorMode', coalesce(fi.color_mode, 'fixed'), 'hasTrimColor', coalesce(fi.has_trim_color, false))
    || case when fi.window_color_ids is not null then jsonb_build_object('windowColorIds', to_jsonb(fi.window_color_ids)) else '{}'::jsonb end
    || case when fi.category in ('window', 'door')
              then jsonb_build_object('sillIn', fi.sill_in, 'sillMode', coalesce(fi.sill_mode, 'fixed'))
              else '{}'::jsonb end
    || case when fi.category = 'door' and coalesce(fi.door_style, 'auto') <> 'auto'
              then jsonb_build_object('doorStyle', fi.door_style)
              else '{}'::jsonb end
    || case when fi.style_ids is not null
              then jsonb_build_object('styleKeys', coalesce((select jsonb_agg(st.key order by st.sort_order, st.key)
                                                             from public.building_styles st
                                                             where st.client_id = fi.client_id and st.id = any(fi.style_ids)), '[]'::jsonb))
              else '{}'::jsonb end
    || case when fi.category = 'window' and coalesce(fi.in_door, false)
              then jsonb_build_object('inDoor', true)
              else '{}'::jsonb end
    || coalesce((select jsonb_build_object('fixedColor', jsonb_build_object('id', c.id, 'label', c.label, 'hex', c.hex))
                 from public.colors c
                 where c.id = fi.fixed_color_id and c.client_id = fi.client_id and c.active), '{}'::jsonb)
    order by fi.category, fi.sort_order, fi.name)
    , '[]'::jsonb)
  into v_items
  from public.fixture_items fi
  where fi.client_id = p_client_id and fi.active
    and fi.price is not null
    and coalesce(fi.archived, false) = false;

  select coalesce(jsonb_agg(
    (case when v_show then
      jsonb_build_object('id', wc.id, 'label', wc.label, 'hex', wc.hex, 'isDefault', wc.is_default, 'rate', wc.rate)
    else
      jsonb_build_object('id', wc.id, 'label', wc.label, 'hex', wc.hex, 'isDefault', wc.is_default)
    end)
    order by wc.sort_order, wc.label)
    , '[]'::jsonb)
  into v_wcolors
  from public.window_colors wc
  where wc.client_id = p_client_id and wc.active;

  return jsonb_build_object(
    'items', v_items,
    'windowColors', v_wcolors,
    'ramp', jsonb_build_object(
      'mode', coalesce(v_mode, 'simple'),
      'method', coalesce(v_method, 'each'),
      'enabled', coalesce(v_enabled, false),
      'imageUrl', v_img,
      'showImage', coalesce(v_showimg, true)
    ) || (case when v_show then jsonb_build_object('price', v_price) else '{}'::jsonb end)
  );
end;
$$
;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3A — apply-time assertions. Any RAISE aborts the whole migration.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $m289_fix$
declare
  v_src      text;
  v_def      text;
  v_changed  integer;
  v_client   text;
  v_win      jsonb;
  v_plain    jsonb;
  v_door     jsonb;
  v_refused  boolean;
  v_took     boolean;
begin
  -- ── PART 1: the door_style check carries exactly the nine looks ──
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conname = 'fixture_items_door_style_chk' and c.conrelid = 'public.fixture_items'::regclass;
  if v_def is distinct from 'CHECK ((door_style = ANY (ARRAY[''auto''::text, ''plank''::text, ''zbrace''::text, ''xbrace''::text, ''rollup''::text, ''american''::text, ''basic''::text, ''classic''::text, ''dutch''::text])))' then
    raise exception '289: fixture_items_door_style_chk is not the nine looks: %', coalesce(v_def, 'missing');
  end if;

  -- ── PART 2: the column (boolean, not null, default false) and its windows-only check ──
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'fixture_items' and column_name = 'in_door'
       and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false'
  ) then
    raise exception '289: fixture_items.in_door should be boolean not null default false';
  end if;
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conname = 'fixture_items_in_door_window_chk' and c.conrelid = 'public.fixture_items'::regclass;
  if v_def is distinct from 'CHECK (((NOT in_door) OR (category = ''window''::text)))' then
    raise exception '289: fixture_items_in_door_window_chk is not windows-only: %', coalesce(v_def, 'missing');
  end if;

  -- ── PART 3: the body is exactly the one written above ──
  select replace(p.prosrc, E'\r', '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if md5(v_src) <> 'c23b2e457c56312b84866937ad982fac' then
    raise exception '289: get_fixtures is not the body PART 3 writes (prosrc md5 %)', md5(v_src);
  end if;

  -- ── Every tenant's catalog is byte-for-byte what it was: no window is in_door yet ──
  select count(*) into v_changed from m289_fixtures_before b
   where md5(public.get_fixtures(b.client_id)::text) is distinct from b.h;
  if v_changed > 0 then
    raise exception '289: get_fixtures changed for % tenant(s); it must change nothing until a builder ticks in_door', v_changed;
  end if;

  -- ── Behaviour, probed on a real tenant and rolled back ──
  -- get_fixtures emits only active, priced rows, so the probes are active and priced at 0, inside a
  -- sub-block that ends by raising P0289, which rolls them back. A window ticked for doors, one not
  -- ticked, and a door in the American look; then a DOOR with in_door, which the check must refuse.
  -- Variables survive the rollback; rows do not.
  select cc.client_id into v_client from public.client_configs cc order by cc.client_id limit 1;
  if found then
    v_took := false;
    v_refused := false;
    begin
      insert into public.fixture_items (client_id, category, name, width_in, height_in, price, active, in_door, door_style)
      values (v_client, 'window', '__m289_probe_win__', 18, 24, 0, true, true, 'auto'),
             (v_client, 'window', '__m289_probe_plain__', 18, 24, 0, true, false, 'auto'),
             (v_client, 'door', '__m289_probe_door__', 36, 80, 0, true, false, 'american');
      select e into v_win from jsonb_array_elements(public.get_fixtures(v_client) -> 'items') e where e ->> 'name' = '__m289_probe_win__';
      select e into v_plain from jsonb_array_elements(public.get_fixtures(v_client) -> 'items') e where e ->> 'name' = '__m289_probe_plain__';
      select e into v_door from jsonb_array_elements(public.get_fixtures(v_client) -> 'items') e where e ->> 'name' = '__m289_probe_door__';
      begin
        insert into public.fixture_items (client_id, category, name, width_in, height_in, price, active, in_door)
        values (v_client, 'door', '__m289_probe_door_in_door__', 36, 80, 0, true, true);
      exception when check_violation then v_refused := true;
      end;
      v_took := true;
      raise exception using errcode = 'P0289', message = '289 probe rollback';
    exception when sqlstate 'P0289' then null;
    end;
    if not v_took then
      raise exception '289: the get_fixtures probe did not run';
    end if;
    if v_win is null or (v_win -> 'inDoor') is distinct from 'true'::jsonb then
      raise exception '289: a window ticked in_door should carry inDoor true, carries %', coalesce(v_win::text, 'nothing (missing)');
    end if;
    if v_plain is null or v_plain ? 'inDoor' then
      raise exception '289: a window not ticked in_door must carry no inDoor, carries %', coalesce(v_plain::text, 'nothing (missing)');
    end if;
    if v_door is null or (v_door ->> 'doorStyle') is distinct from 'american' or v_door ? 'inDoor' then
      raise exception '289: an American door should carry doorStyle american and no inDoor, carries %', coalesce(v_door::text, 'nothing (missing)');
    end if;
    if not v_refused then
      raise exception '289: a DOOR with in_door true was accepted; fixture_items_in_door_window_chk must refuse it';
    end if;
    if exists (select 1 from public.fixture_items where name like '\_\_m289\_probe%') then
      raise exception '289: the get_fixtures probe left a row behind';
    end if;
  end if;
end
$m289_fix$;

notify pgrst, 'reload schema';

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. Record it (with the number it was applied as):
--      insert into supabase_migrations.schema_migrations (version, name)
--      values ('289', '289_door_generator') returning version;
-- B. Both checks (expect the nine looks, and NOT in_door OR category = 'window'):
--      select conname, pg_get_constraintdef(oid) from pg_constraint
--       where conrelid = 'public.fixture_items'::regclass
--         and conname in ('fixture_items_door_style_chk', 'fixture_items_in_door_window_chk');
-- C. The column, and no window ticked yet (expect boolean / NO / false, then 0):
--      select data_type, is_nullable, column_default from information_schema.columns
--       where table_schema = 'public' and table_name = 'fixture_items' and column_name = 'in_door';
--      select count(*) from public.fixture_items where in_door;
-- D. get_fixtures is the new body (expect c23b2e457c56312b84866937ad982fac):
--      select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure;
-- E. get_fixtures is unchanged for every tenant (PART 3A already refused the apply otherwise): compare
--      select client_id, md5(public.get_fixtures(client_id)::text) from public.client_configs order by 1;
--    with the same query run before the apply; every one must match.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Ship portal-settings without in_door in its catalog read and its saves FIRST: both fail on a
-- missing column. Then the function goes back BEFORE the column goes, because plpgsql does not track
-- the columns it reads: drop the column under the new body and every designer's catalog load fails
-- at call time. 272's get_fixtures statement is the body this replaced: run that one statement (the
-- `create or replace function public.get_fixtures` block of 272_builder_options.sql, not the whole
-- file, whose other parts are not idempotent against later data) and check query D reads
-- 276d22b7c1a3d60ebe7c5d6e58373de6. Then:
--   begin;
--   alter table public.fixture_items drop constraint if exists fixture_items_in_door_window_chk;
--   alter table public.fixture_items drop column if exists in_door;
--   -- Only while no row uses the four new looks (select count(*) from public.fixture_items where
--   -- door_style in ('american', 'basic', 'classic', 'dutch') returns 0); otherwise set those rows
--   -- back to 'auto' first, which a builder will see as their doors drawn the old way.
--   alter table public.fixture_items drop constraint if exists fixture_items_door_style_chk;
--   alter table public.fixture_items
--     add constraint fixture_items_door_style_chk check (door_style in ('auto', 'plank', 'zbrace', 'xbrace', 'rollup'));
--   delete from supabase_migrations.schema_migrations where version = '289';
--   notify pgrst, 'reload schema';
--   commit;
