-- 272_builder_options.sql — three Settings → Options asks from one builder (2026-10-02), one
--                            file for the batch.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations with `returning`. NEVER `supabase db push`. The file
--    carries its own begin;/commit; so every assertion below takes the whole migration with it if
--    it fails.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   style_wall_heights: the same increase may be listed twice per style, once hauled and
--            once built on site. The unique key (client_id, style_id, delta_in) becomes
--            (client_id, style_id, delta_in, build_on_site).
--   PART 1A  apply-time assertions for PART 1 (they RAISE and abort the transaction), including a
--            behavioural probe that is rolled back and leaves nothing.
--   PART 2   insulation_offerings: rigid foam becomes a third insulation type beside batt and
--            spray foam. The ins_type check gains 'rigid_foam'.
--   PART 2A  apply-time assertions for PART 2, with the same rolled-back probe.
--   PART 3   fixture_items: a catalog door, window, ramp or vent can be offered on some building
--            styles only. Adds style_ids uuid[] (NULL = every style) and replaces get_fixtures,
--            derived from the live body, to send the styles as `styleKeys`.
--   PART 3A  apply-time assertions for PART 3: the body is exactly the one written here, every
--            tenant's get_fixtures is byte-for-byte unchanged, and a rolled-back probe.
--   after commit: recording the row, verification and rollback, as comments.
--
-- ── WHY (PART 1) ─────────────────────────────────────────────────────────────────────────
-- Bug report 2026-10-02: a builder needed 12" of extra wall height on a 14' wide building that is
-- built on site. They already sell +12" as a normal HAULED upgrade on the 8, 10 and 12
-- wide, and tried to add a second +12" row ticked Built on site for the 14 wide. The save refused
-- it ("+12 in: listed twice"). Carolyn's rule from 2026-09-01 (migration 183) is exactly this case:
-- taller walls are capped for hauling, and "if they build it on site ... allow them to raise the
-- wall height more, but then it becomes a build on site building".
--
-- The model allowed ONE row per (style, increase), and "built on site" is a flag on the whole row,
-- not per width. So "+12 hauled at 8-12, +12 on site at 14" could not be said at all: ticking 14
-- and Built on site on the single row would have made 8-12 on-site too. Now each increase can have
-- one hauled row and one built-on-site row, each with its own widths, $/lf and on-site fee.
--
-- WHAT KEEPS THE TWO ROWS APART is the width: they may not share one, so at any building width an
-- increase resolves to at most one row. That rule lives in the code, not here:
--   * portal-settings save_wall_heights refuses a save where the two rows share a width (a NULL
--     widths_ft counts as every width the style sells), and the portal checks it before sending.
--     The pair itself ships SWITCHED OFF: until the secret WALL_HEIGHT_SITE_PAIRS is "on", the
--     save still refuses a second row for an increase (see DEPLOY ORDER for when to switch it on);
--   * submit-estimate picks the row offered at the building's width and refuses an ambiguous one;
--   * the designer's resolveWallHeight picks the same row (both twins), so preview and estimate
--     agree to the penny.
-- No trigger enforces the width rule here, on purpose: a trigger sees one row at a time, so a save
-- that moves a width from one row to the other (hauled 8-12 → 8-10, on site 14 → 12-14) would be
-- refused halfway through for a state it never ends in.
--
-- No get_config change: it already emits every active, priced row with widthsFt and buildOnSite.
-- No data change: every live (client, style, increase) has one row today (13 rows, 2026-10-05), so
-- the new key holds on the first apply and every tenant's get_config is byte-for-byte unchanged.
--
-- ── WHY (PART 2) ─────────────────────────────────────────────────────────────────────────
-- Feature request 2026-10-02: "We use Rigid Foam insulation only under the floor sheeting." 177
-- closed the type to batt or spray foam, so the builder could not name what they sell. Rigid foam
-- becomes a third type with the same three areas. "Only under the floor" needs no schema: the
-- builder fills in a Floor rate for Rigid Foam and leaves Walls and Roof blank, and a blank rate is
-- already "not offered" (177). Floor square footage is width x length in both the designer and
-- submit-estimate, and the QBO kind and the tax mapping are both 'insulation', whatever the type.
--
-- No get_config change: its insulation block emits io.ins_type as it is, with no list of types
-- (PART 2A checks that), so a rigid_foam row reaches the designer like any other. No data change:
-- the 12 live rows are all batt or spray foam (2026-10-05), and no tenant has a rigid_foam row
-- until a builder saves one, so every tenant's get_config is byte-for-byte unchanged.
--
-- ── WHY (PART 3) ─────────────────────────────────────────────────────────────────────────
-- Feature request 2026-10-02: "I need my louvered vents to only be for greenhouse style
-- buildings." Every catalog fixture was offered on every style: fixture_items had no style column,
-- get_fixtures sent one list for the whole tenant, and the designer's pickers filtered on
-- internalOnly alone. The same builder's price sheet sells garage doors on some styles only, so
-- this is per fixture, for every category, not a vent switch.
--
-- style_ids follows window_color_ids (119): NULL is the living default, "every style, including
-- ones added later", and a list is exactly those. Every existing row is NULL after the add, so
-- nothing changes until a builder unticks a style. get_fixtures turns the list into the styles'
-- KEYS (`styleKeys`), because the designer knows a style by its key (get_config's 'value'),
-- ordered as the catalog orders styles, and only this tenant's: the column has no foreign key, so
-- the client_id test is what keeps a stray id from naming another builder's style. An id whose
-- style was deleted names nothing; a list that names nothing sends [] and the item is offered
-- nowhere, which portal-settings never saves on purpose (it refuses an empty list).
--
-- Visibility only, the internalOnly precedent: the pickers stop offering the item on other styles,
-- and a style change takes a placed one off the plan. submit-estimate is unchanged.
--
-- ⚠️ A WHOLE-FUNCTION REPLACE, DERIVED FROM THE LIVE BODY. Dumped 2026-10-05 with
--   select prosrc from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure;
-- it is 208's body byte for byte (md5 of prosrc, carriage returns removed:
-- 4f9f6b26e06da08b52123bdb6f560e27), and the body below is that text plus ONE merge, after
-- 186's doorStyle. The pre-apply block refuses to replace anything else, so a get_fixtures some
-- other change has replaced since cannot be quietly reverted by this file: re-dump and re-derive.
-- Grants are untouched: create or replace keeps them.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-05: 269 is the newest, 268 is unused, 270 and 271 are held for another batch.
-- 272 is the number assigned to this batch. Confirm at apply time:
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 4;
-- must not already show 272.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. Nothing can write a second row for an increase until
-- the secret WALL_HEIGHT_SITE_PAIRS is switched on: the live portal-settings refuses "listed
-- twice", and the new one keeps refusing a second row while the switch is off. So this file is
-- inert on its own. The new key's index serves every lookup the old one did, (client_id, style_id, delta_in)
-- being its leading columns. The apply waits at most 5 s for a lock (lock_timeout) and gives up
-- rather than queue a quote behind it; retry it.
-- PART 2 only widens a check, so every row that was valid stays valid. Live portal-settings
-- refuses 'rigid_foam' before it reaches the table, so PART 2 is inert until the new one ships.
-- PART 3 adds a nullable column with no default (no rewrite) and sends `styleKeys` only for a row
-- whose style_ids is set, which none is until the new portal-settings saves one. Live designers
-- ignore the key either way. PART 3A checks every tenant's get_fixtures is unchanged by the apply.
--
-- ── DEPLOY ORDER (one sequence, all three parts) ─────────────────────────────────────────
--   1. this file, and its ledger row (AFTER APPLYING, A), BEFORE this batch merges into the
--      integration branch. Every later batch deploys portal-settings from that branch, and its
--      catalog read now selects style_ids: deployed ahead of this file, every builder's Settings
--      catalog fails to load on the unknown column. The file is inert against the live
--      functions (SAFE WITH WHAT IS LIVE), so applying it early costs nothing.
--   2. submit-estimate. It reads every row for an increase and picks the one offered at the
--      building's width; the live one reads a single row with maybeSingle, which ERRORS on two
--      rows and would refuse the quote. It also names the line "Rigid Foam Insulation".
--   3. portal-settings, with WALL_HEIGHT_SITE_PAIRS NOT set. It saves rigid foam rates and the
--      "Offered on" ticks, its catalog read returns style_ids, and its wall-height save still
--      refuses a second row for an increase, exactly as the live one does. So any tree that holds
--      this batch is safe to deploy it from, whichever batch deploys it.
--   4. admin-catalog: a client cloned from a template gets the template's "Offered on" ticks on
--      its OWN styles. It shares _shared/fixtureStyleIds.ts with portal-settings. Either side of
--      this file works: it touches style_ids only when the template's row carries the column.
--   5. the designer twins + portal, compiled, to beta; drive them there.
--   6. promotion to production.
--   7. only then: `supabase secrets set WALL_HEIGHT_SITE_PAIRS=on` (read per request, no
--      redeploy). Switched on while production still runs the old resolveWallHeight, a pair would
--      preview one price (or none) and bill another, because the old designer prices the FIRST
--      row it finds for an increase.
--   Tell builders to enter Rigid Foam rates or set "Offered on" only after step 6: the production
--   designer before it has no "Rigid Foam" name for the button, and it ignores styleKeys. Tell
--   them to add a built-on-site row beside a hauled one only after step 7. Before it the save
--   answers "listed twice. For now, list each increase once.", even though the beta portal's
--   help text already describes the pair.
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — style_wall_heights: one hauled and one built-on-site row per increase
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- The old key is 172's inline `unique (client_id, style_id, delta_in)`, so Postgres named it
-- style_wall_heights_client_id_style_id_delta_in_key (read from pg_constraint 2026-10-05). The new
-- key is added only when missing, so a re-apply changes nothing. build_on_site is NOT NULL (183), so
-- the key admits exactly two rows per increase, never a third.
alter table public.style_wall_heights
  drop constraint if exists style_wall_heights_client_id_style_id_delta_in_key;

do $m272_key$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.style_wall_heights'::regclass
       and conname = 'style_wall_heights_client_style_delta_bos_key'
  ) then
    alter table public.style_wall_heights
      add constraint style_wall_heights_client_style_delta_bos_key
      unique (client_id, style_id, delta_in, build_on_site);
  end if;
end
$m272_key$;

comment on table public.style_wall_heights is
  'Per-style wall-height upgrades. delta_in = whole inches above the style standard; rate_per_lf is '
  'charged against the building perimeter. NULL rate = not offered. Each increase may appear twice '
  'per style, once hauled and once built on site (migration 272), and the two rows may not share a '
  'width; portal-settings save_wall_heights enforces the width rule.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1A — apply-time assertions. Any RAISE aborts the whole migration.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $m272_assert$
declare
  v_def      text;
  v_row      record;
  v_d        integer;
  v_refused  boolean;
  v_took     boolean;
begin
  -- ── The old key is gone and the new one is exactly the four columns ──
  if exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.style_wall_heights'::regclass
       and conname = 'style_wall_heights_client_id_style_id_delta_in_key'
  ) then
    raise exception '272: the old (client_id, style_id, delta_in) key is still on style_wall_heights';
  end if;
  select pg_get_constraintdef(c.oid) into v_def
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.style_wall_heights'::regclass
     and c.conname = 'style_wall_heights_client_style_delta_bos_key'
     and c.contype = 'u';
  if v_def is distinct from 'UNIQUE (client_id, style_id, delta_in, build_on_site)' then
    raise exception '272: style_wall_heights_client_style_delta_bos_key should be UNIQUE (client_id, style_id, delta_in, build_on_site), is %', v_def;
  end if;
  -- And it is the ONLY unique key besides the primary key: a leftover unique index on the old three
  -- columns (made by hand, under another name) would still refuse the second row.
  if exists (
    select 1 from pg_catalog.pg_index i
     where i.indrelid = 'public.style_wall_heights'::regclass
       and i.indisunique and not i.indisprimary
       and i.indexrelid <> (select c.conindid from pg_catalog.pg_constraint c
                             where c.conrelid = 'public.style_wall_heights'::regclass
                               and c.conname = 'style_wall_heights_client_style_delta_bos_key')
  ) then
    raise exception '272: style_wall_heights carries another unique index besides the new key';
  end if;

  -- ── Behaviour, probed on a real style and rolled back ──
  -- An increase no row of that style uses, so the probe never meets a builder's own rows. The
  -- whole probe sits in one sub-block that ends by raising P0272, which rolls back every insert in
  -- it; the two booleans survive because variables are not transactional. A table with no rows has
  -- no style to probe; the key's definition is checked above either way.
  select client_id, style_id into v_row from public.style_wall_heights order by id limit 1;
  if found then
    select d into v_d from generate_series(1, 48) d
     where not exists (select 1 from public.style_wall_heights s
                        where s.client_id = v_row.client_id and s.style_id = v_row.style_id and s.delta_in = d)
     order by d limit 1;
    if v_d is null then
      raise exception '272: probe found no unused increase on style % (all 48 are taken)', v_row.style_id;
    end if;
    v_took := false;
    v_refused := false;
    begin
      insert into public.style_wall_heights (client_id, style_id, delta_in, build_on_site, active)
      values (v_row.client_id, v_row.style_id, v_d, false, false);
      insert into public.style_wall_heights (client_id, style_id, delta_in, build_on_site, active)
      values (v_row.client_id, v_row.style_id, v_d, true, false);
      v_took := true;          -- one hauled + one built on site: the pair this file exists for
      begin
        insert into public.style_wall_heights (client_id, style_id, delta_in, build_on_site, active)
        values (v_row.client_id, v_row.style_id, v_d, false, false);
      exception when unique_violation then v_refused := true;   -- a second HAULED row: refused
      end;
      raise exception using errcode = 'P0272', message = '272 probe rollback';
    exception when sqlstate 'P0272' then null;
    end;
    if not v_took then
      raise exception '272: a hauled and a built-on-site row for the same increase were not both accepted';
    end if;
    if not v_refused then
      raise exception '272: a second hauled row for the same increase was accepted';
    end if;
    if exists (select 1 from public.style_wall_heights s
                where s.client_id = v_row.client_id and s.style_id = v_row.style_id and s.delta_in = v_d) then
      raise exception '272: the probe left a row behind';
    end if;
  end if;
end
$m272_assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — insulation_offerings: rigid foam as a third type
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 177's inline `check (ins_type in ('batt', 'spray_foam'))` named itself
-- insulation_offerings_ins_type_check (read from pg_constraint 2026-10-05). It is dropped and
-- added back under the same name with the third value, so a re-apply ends in the same definition.
-- Adding it back re-checks the existing rows (12 on 2026-10-05), all batt or spray foam.
alter table public.insulation_offerings
  drop constraint if exists insulation_offerings_ins_type_check;
alter table public.insulation_offerings
  add constraint insulation_offerings_ins_type_check
  check (ins_type in ('batt', 'spray_foam', 'rigid_foam'));

comment on column public.insulation_offerings.ins_type is
  'batt, spray_foam or rigid_foam (migration 272). Every type offers the same three areas; a '
  'builder who insulates only under the floor fills in the floor rate and leaves walls and roof '
  'blank (NULL rate = not offered).';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2A — apply-time assertions. Any RAISE aborts the whole migration.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $m272_ins$
declare
  v_def      text;
  v_src      text;
  v_took     boolean;
  v_refused  boolean;
begin
  -- ── The check is exactly the three types ──
  select pg_get_constraintdef(c.oid) into v_def
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.insulation_offerings'::regclass
     and c.conname = 'insulation_offerings_ins_type_check'
     and c.contype = 'c';
  if v_def is distinct from $d$CHECK ((ins_type = ANY (ARRAY['batt'::text, 'spray_foam'::text, 'rigid_foam'::text])))$d$ then
    raise exception '272: insulation_offerings_ins_type_check should allow batt, spray_foam and rigid_foam, is %', v_def;
  end if;
  -- And it is the ONLY check on ins_type: a second one (made by hand, under another name) would
  -- still refuse rigid foam, and the save would fail for a reason nobody can see in this file.
  if (select count(*) from pg_catalog.pg_constraint c
       where c.conrelid = 'public.insulation_offerings'::regclass and c.contype = 'c'
         and pg_get_constraintdef(c.oid) like '%ins_type%') <> 1 then
    raise exception '272: insulation_offerings carries another check on ins_type besides insulation_offerings_ins_type_check';
  end if;

  -- ── get_config passes the type through ──
  -- Nothing here changes get_config, so it has to emit io.ins_type as it is. A body that names a
  -- type is listing them, and a list written before 272 would drop every rigid foam row on the
  -- way to the designer with no error anywhere.
  v_src := pg_get_functiondef('public.get_config(text)'::regprocedure);
  if position('insulation_offerings' in v_src) = 0 then
    raise exception '272: get_config no longer reads insulation_offerings; re-check how insulation reaches the designer before applying';
  end if;
  if position('spray_foam' in v_src) > 0 or position('''batt''' in v_src) > 0 then
    raise exception '272: get_config names an insulation type, so it may drop rigid_foam; widen that list in this file too';
  end if;

  -- ── Behaviour, probed and rolled back ──
  -- A client id no tenant can have, an inactive row with no rate (so even a leak would offer
  -- nothing), all inside one sub-block that ends by raising P0272.
  v_took := false;
  v_refused := false;
  begin
    insert into public.insulation_offerings (client_id, ins_type, area, rate_per_sqft, active)
    values ('__m272_probe__', 'rigid_foam', 'floor', null, false);
    v_took := true;            -- rigid foam goes in
    begin
      insert into public.insulation_offerings (client_id, ins_type, area, rate_per_sqft, active)
      values ('__m272_probe__', 'rockwool', 'floor', null, false);
    exception when check_violation then v_refused := true;     -- an unknown type is still refused
    end;
    raise exception using errcode = 'P0272', message = '272 probe rollback';
  exception when sqlstate 'P0272' then null;
  end;
  if not v_took then
    raise exception '272: a rigid_foam insulation row was not accepted';
  end if;
  if not v_refused then
    raise exception '272: an unknown insulation type was accepted';
  end if;
  if exists (select 1 from public.insulation_offerings where client_id = '__m272_probe__') then
    raise exception '272: the insulation probe left a row behind';
  end if;
end
$m272_ins$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — fixture_items: offered on some building styles only
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A nullable column with no default: no table rewrite, and every existing row reads NULL, "every
-- style". Re-applying adds nothing.
alter table public.fixture_items add column if not exists style_ids uuid[];

comment on column public.fixture_items.style_ids is
  'The building styles this fixture is offered on (migration 272). NULL = every style, including '
  'ones added later; a list = exactly those building_styles ids. No foreign key, like '
  'window_color_ids: get_fixtures sends only this tenant''s styles, as styleKeys. portal-settings '
  'never saves an empty list.';

-- ── Pre-apply: the body below replaces only the get_fixtures it was derived from ──────────────
-- The sill and doorStyle markers say WHAT moved when something did; the md5 says whether anything
-- did. Carriage returns are removed first, so a file applied with Windows line endings reads the
-- same. The second md5 is this file's own body, so a re-apply passes.
do $m272_fix_pre$
declare
  v_src text;
begin
  if to_regprocedure('public.get_fixtures(text)') is null then
    raise exception '272: public.get_fixtures(text) does not exist. PART 3 REPLACES a live function; '
                    'creating it from here would ship a body nobody verified.';
  end if;
  select replace(p.prosrc, E'\r', '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if position('fi.category in (''window'', ''door'')' in v_src) = 0 then
    raise exception '272: the LIVE get_fixtures has no door-and-window sill merge (208). Re-derive PART 3 from a fresh dump before applying.';
  end if;
  if position('doorStyle' in v_src) = 0 then
    raise exception '272: the LIVE get_fixtures has no doorStyle merge (186). Re-derive PART 3 from a fresh dump before applying.';
  end if;
  if md5(v_src) not in ('4f9f6b26e06da08b52123bdb6f560e27', '276d22b7c1a3d60ebe7c5d6e58373de6') then
    raise exception '272: the LIVE get_fixtures (prosrc md5 %) is neither the body PART 3 was derived from on 2026-10-05 nor the one it writes, so another change has replaced it since. Re-dump it (select prosrc from pg_proc where oid = ''public.get_fixtures(text)''::regprocedure), carry that change into PART 3, and update both md5s.', md5(v_src);
  end if;
end
$m272_fix_pre$;

-- Every tenant's catalog as it is now, for PART 3A to compare against. Dropped at commit.
create temp table m272_fixtures_before on commit drop as
  select cc.client_id, md5(public.get_fixtures(cc.client_id)::text) as h from public.client_configs cc;

-- ── get_fixtures: the live body plus styleKeys ───────────────────────────────────────────────
-- The only change from the live body is the one merge after doorStyle. Emitted ONLY for a row
-- with style_ids set, so every fixture that exists today comes out byte-for-byte as it did.
-- st.client_id = fi.client_id keeps another tenant's style out of the list; ordered as the catalog
-- orders styles (sort_order, then key, since sort_order ties are common).
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
do $m272_fix$
declare
  v_src      text;
  v_changed  integer;
  v_own      record;
  v_foreign  uuid;
  v_keys     jsonb;
  v_all      jsonb;
  v_took     boolean;
begin
  -- ── The column: uuid[], nullable, no default ──
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'fixture_items' and column_name = 'style_ids'
       and udt_name = '_uuid' and is_nullable = 'YES' and column_default is null
  ) then
    raise exception '272: fixture_items.style_ids should be a nullable uuid[] with no default';
  end if;

  -- ── The body is exactly the one written above, 208 and 186 included ──
  select replace(p.prosrc, E'\r', '') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.get_fixtures(text)'::regprocedure;
  if md5(v_src) <> '276d22b7c1a3d60ebe7c5d6e58373de6' then
    raise exception '272: get_fixtures is not the body PART 3 writes (prosrc md5 %)', md5(v_src);
  end if;

  -- ── Every tenant's catalog is byte-for-byte what it was: no row has style_ids yet ──
  select count(*) into v_changed from m272_fixtures_before b
   where md5(public.get_fixtures(b.client_id)::text) is distinct from b.h;
  if v_changed > 0 then
    raise exception '272: get_fixtures changed for % tenant(s); it must change nothing until a builder sets style_ids', v_changed;
  end if;

  -- ── Behaviour, probed on a real tenant and rolled back ──
  -- get_fixtures emits only active, priced rows, so the two probe vents are active and priced at
  -- 0, inside a sub-block that ends by raising P0272, which rolls both inserts back. One is offered
  -- on one of the tenant's styles plus a style id that is NOT the tenant's (another builder's, or
  -- a random one on a one-tenant database); the other on every style. Variables survive the
  -- rollback; rows do not.
  select st.client_id, st.id, st.key into v_own
    from public.building_styles st
   where exists (select 1 from public.client_configs cc where cc.client_id = st.client_id)
   order by st.client_id, st.sort_order, st.key
   limit 1;
  if found then
    select st.id into v_foreign from public.building_styles st where st.client_id <> v_own.client_id order by st.id limit 1;
    v_foreign := coalesce(v_foreign, gen_random_uuid());
    v_took := false;
    begin
      insert into public.fixture_items (client_id, category, name, width_in, height_in, price, active, style_ids)
      values (v_own.client_id, 'vent', '__m272_probe_some__', 1, 1, 0, true, array[v_foreign, v_own.id]),
             (v_own.client_id, 'vent', '__m272_probe_every__', 1, 1, 0, true, null);
      select e -> 'styleKeys' into v_keys
        from jsonb_array_elements(public.get_fixtures(v_own.client_id) -> 'items') e
       where e ->> 'name' = '__m272_probe_some__';
      select e into v_all
        from jsonb_array_elements(public.get_fixtures(v_own.client_id) -> 'items') e
       where e ->> 'name' = '__m272_probe_every__';
      v_took := true;
      raise exception using errcode = 'P0272', message = '272 probe rollback';
    exception when sqlstate 'P0272' then null;
    end;
    if not v_took then
      raise exception '272: the get_fixtures probe did not run';
    end if;
    if v_keys is distinct from jsonb_build_array(v_own.key) then
      raise exception '272: a fixture offered on style % (plus a style that is not this tenant''s) should carry styleKeys ["%"], carries %', v_own.key, v_own.key, coalesce(v_keys::text, 'nothing');
    end if;
    if v_all is null then
      raise exception '272: the probe fixture offered on every style is missing from get_fixtures';
    end if;
    if v_all ? 'styleKeys' then
      raise exception '272: a fixture offered on every style must carry no styleKeys, carries %', v_all -> 'styleKeys';
    end if;
    if exists (select 1 from public.fixture_items where name in ('__m272_probe_some__', '__m272_probe_every__')) then
      raise exception '272: the get_fixtures probe left a row behind';
    end if;
  end if;
end
$m272_fix$;

notify pgrst, 'reload schema';

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. Record it:
--      insert into supabase_migrations.schema_migrations (version, name)
--      values ('272', '272_builder_options') returning version;
-- B. The key (expect one row, the four columns):
--      select conname, pg_get_constraintdef(oid) from pg_constraint
--       where conrelid = 'public.style_wall_heights'::regclass and contype = 'u';
-- C. No data moved (13 rows on 2026-10-05, none sharing an increase):
--      select client_id, count(*) from public.style_wall_heights group by 1;
--      select client_id, style_id, delta_in, count(*) from public.style_wall_heights
--       group by 1, 2, 3 having count(*) > 1;            -- expect no rows until a builder adds a pair
-- D. get_config is unchanged for every tenant: compare md5(get_config(client_id)::text) before and
--    after the apply; every one must match.
-- E. The insulation check (expect the three types):
--      select pg_get_constraintdef(oid) from pg_constraint
--       where conrelid = 'public.insulation_offerings'::regclass and conname = 'insulation_offerings_ins_type_check';
--    and no rigid foam row yet (expect 0 until a builder saves one):
--      select count(*) from public.insulation_offerings where ins_type = 'rigid_foam';
-- F. get_fixtures is the new body, and no fixture is restricted yet (expect 276d22b7c1a3d60ebe7c5d6e58373de6, then 0):
--      select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.get_fixtures(text)'::regprocedure;
--      select count(*) from public.fixture_items where style_ids is not null;
-- G. get_fixtures is unchanged for every tenant (PART 3A already refused the apply otherwise): compare
--      select client_id, md5(public.get_fixtures(client_id)::text) from public.client_configs order by 1;
--    with the same query run before the apply; every one must match.
--
-- ── ROLLBACK (PART 1) ────────────────────────────────────────────────────────────────────
-- Only while no style has both a hauled and a built-on-site row for one increase (query C's second
-- statement returns nothing); otherwise delete or re-number one row of each pair first.
--   begin;
--   alter table public.style_wall_heights drop constraint if exists style_wall_heights_client_style_delta_bos_key;
--   alter table public.style_wall_heights
--     add constraint style_wall_heights_client_id_style_id_delta_in_key unique (client_id, style_id, delta_in);
--   delete from supabase_migrations.schema_migrations where version = '272';
--   notify pgrst, 'reload schema';
--   commit;
--
-- ── ROLLBACK (PART 2) ────────────────────────────────────────────────────────────────────
-- Only while no rigid_foam row exists (query E's second statement returns 0); a builder's rigid
-- foam rate would otherwise fail the narrower check. Ship portal-settings without 'rigid_foam'
-- first, or the next save of that row is refused by the database instead of by the function.
--   begin;
--   alter table public.insulation_offerings drop constraint if exists insulation_offerings_ins_type_check;
--   alter table public.insulation_offerings
--     add constraint insulation_offerings_ins_type_check check (ins_type in ('batt', 'spray_foam'));
--   comment on column public.insulation_offerings.ins_type is null;
--   notify pgrst, 'reload schema';
--   commit;
--
-- ── ROLLBACK (PART 3) ────────────────────────────────────────────────────────────────────
-- Builders lose their "Offered on" ticks: every fixture is offered on every style again. The
-- function goes back FIRST, because plpgsql does not track the columns it reads: drop the column
-- under the new body and every designer's catalog load fails at call time. 208's file re-issues
-- the body this replaced; its pre-apply guard accepts the current one (both markers are in it).
--   cat supabase/migrations/208_get_fixtures_door_sill.sql | supabase db query --linked
-- then check query F's first statement reads 4f9f6b26e06da08b52123bdb6f560e27, and:
--   begin;
--   alter table public.fixture_items drop column if exists style_ids;
--   notify pgrst, 'reload schema';
--   commit;
-- Ship portal-settings without style_ids in its catalog read first: that read fails on a missing column.
-- Rolling back PART 1, PART 2 and PART 3 together: run all three, and delete the ledger row once.
