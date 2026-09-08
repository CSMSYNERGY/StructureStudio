-- 208_get_fixtures_door_sill.sql
--
-- The LOFT DOOR: let get_fixtures emit a height off the floor for a DOOR, not only a window.
--
-- Carolyn, 2026-09-04 @24:43. Ahsan pointed at a small opening high on a gable end and asked
-- what it was: "Oh, that's a door ... it's a small, it's called a loft door ... A lot of them
-- have that. So consider it the same thing as a vent, or it might be a door. Some of them just
-- put trim on it." Asked where it belongs in the catalog she was unambiguous (@27:16): "that
-- loft door goes with the doors."
--
-- So a loft door is NOT a new category, NOT a FIXTURE_CATEGORIES value, and NOT an
-- is_loft_door flag. It is an ordinary category='door' row whose height off the floor is not
-- zero. The height IS the distinction, and a boolean beside it would be a second source of
-- truth for one fact.
--
-- NO COLUMN IS ADDED. sill_in / sill_mode (139) already exist on every fixture_items row —
-- they were window-only by ENFORCEMENT, not by shape. Three independent gates each swallowed a
-- door's height whole, and all three had to move together or the feature ships as a door every
-- builder places at floor level with no error anywhere:
--
--   1. portal-settings' validateFixtureRow nulled the pair on save for any non-window.
--   2. THIS function dropped it on read for any non-window.
--   3. the designer's openingSpan returned a hard-coded 0 for every door.
--
-- 1 and 3 ship alongside this. Applying this migration alone is harmless but inert: nothing
-- can write a door sill until portal-settings is deployed.
--
-- A DOOR'S sill_mode IS ALWAYS 'fixed'. 'variable' lets the shopper slide an opening up and
-- down the wall in 3D (Carolyn's transom); a loft door's height is where the builder's loft
-- floor is, not a customer's choice. That is enforced in portal-settings rather than by a CHECK
-- here, because the column is shared with windows, for which 'variable' is legal. The pair is
-- emitted for doors anyway — the designer reads sillMode on the swap and drag paths, and a key
-- present-and-'fixed' is cheaper to reason about than a key that is sometimes absent.
--
-- ⚠️ DERIVED FROM THE LIVE FUNCTION, not from the newest file on disk — 120's header explains
-- why, and 186 re-issued this function after it. Verified on 2026-09-06: the body below is
-- `select pg_get_functiondef('public.get_fixtures'::regproc)` byte-for-byte apart from
-- pg_get_functiondef's own header normalisation (CREATE OR REPLACE ... AS $function$ vs the
-- lower-case `as $$` this repo writes) and the ONE case-expression changed below. The pre-apply
-- block re-checks that before replacing anything, so this cannot silently un-ship 186's
-- doorStyle merge the way a file-based rebuild could.
--
-- Grants are untouched: `create or replace` preserves them, and pg_get_functiondef never
-- carried them in the first place.
--
-- HAND-APPLY by PIPING this file inline:
--     cat supabase/migrations/208_get_fixtures_door_sill.sql | supabase db query --linked
-- NOT `--file` (it auth-fails, retries eight times, applies nothing and still exits 0), and
-- NOT with a `--` separator (the CLI then reads stdin and ignores the argument). Then record it
-- in supabase_migrations.schema_migrations. Do NOT db push. BOM-free.

-- ── PRE-APPLY: prove the body below is derived from what is actually running ────────────────
do $$
declare
  src text;
begin
  if to_regprocedure('public.get_fixtures(text)') is null then
    raise exception '208: public.get_fixtures(text) does not exist. This migration REPLACES a '
                    'live function; creating it from here would ship a body nobody verified.';
  end if;
  src := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
  -- The exact merge this migration widens. Absent means the live body has moved on since this
  -- file was written, so the body below is stale and would revert whatever changed it.
  --
  -- The SECOND arm is what makes a re-run safe: once this migration is applied the window-only
  -- text is gone by design, and a guard that then fails would teach whoever re-ran it that the
  -- database had drifted when nothing had. Either spelling means "the live body is one this
  -- file knows how to replace".
  if position('case when fi.category = ''window''' in src) = 0
     and position('fi.category in (''window'', ''door'')' in src) = 0 then
    raise exception '208: the LIVE get_fixtures body contains neither the window-only sill '
                    'merge this migration was derived from nor the widened one it writes. '
                    'Re-derive from a fresh pg_get_functiondef dump before applying — see '
                    'this file''s header.';
  end if;
  -- 186's doorStyle merge. Its absence would mean this file is NEWER than the database in one
  -- place and OLDER in another, which is the exact failure 120's header warns about.
  if position('doorStyle' in src) = 0 then
    raise exception '208: the LIVE get_fixtures body has no doorStyle merge, so 186 is not '
                    'applied. Apply 186 first — replacing the function from here would '
                    'un-ship it.';
  end if;
end $$;

-- ── get_fixtures: emit the sill pair for DOORS as well as windows ───────────────────────────
-- The only change from the live body is the one case expression, from
--     case when fi.category = 'window' ... else '{}'::jsonb end
-- to the two-category test below. Everything else is verbatim.
--
-- Emitted for a door even when sill_in is NULL, exactly as it already is for a window: NULL is
-- the wire form of "use the designer's default", which for a door is the floor. The designer's
-- doorSillStamps reads a null/absent sillIn as undefined and openingSpan falls through to 0, so
-- every door that exists today keeps rendering byte-identically.
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

-- ── POST-APPLY assertions ──────────────────────────────────────────────────────────────────
do $$
declare
  v_client text;
  v_out    jsonb;
  v_hits   int;
begin
  -- 1. Structural: the widened merge is what is now running, and 186's is still beside it.
  if position('fi.category in (''window'', ''door'')' in
              pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) = 0 then
    raise exception '208: the replacement did not take — the sill merge is still window-only.';
  end if;
  if position('doorStyle' in
              pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) = 0 then
    raise exception '208: doorStyle vanished from get_fixtures. The body applied was older '
                    'than the database. Restore 186 and re-derive this file.';
  end if;

  -- 2. It still RUNS. A structural check passes happily on a body that raises at call time,
  --    and this function is what every public designer loads its catalog from.
  select client_id into v_client from public.client_configs order by client_id limit 1;
  if v_client is null then
    raise notice '208: no client_configs rows — execution check skipped';
  else
    v_out := public.get_fixtures(v_client);
    if v_out is null or not (v_out ? 'items') then
      raise exception '208: get_fixtures(%) no longer returns an items envelope', v_client;
    end if;
  end if;

  -- 3. End to end, WHEN there is anything to check. On the day this is applied no builder has
  --    entered a loft door yet, so this is conditional rather than failing on empty data — a
  --    vacuous assertion that says so is honest; one that fails on an empty table teaches
  --    people to bypass assertions. The filters mirror the function's own (active, priced,
  --    not archived) or a row it deliberately omits would read as a bug here.
  select fi.client_id into v_client
    from public.fixture_items fi
    where fi.category = 'door' and fi.sill_in is not null
      and fi.active and fi.price is not null and coalesce(fi.archived, false) = false
      and exists (select 1 from public.client_configs cc where cc.client_id = fi.client_id)
    limit 1;
  if v_client is null then
    raise notice '208: no priced, active door carries a sill yet — door-sill emit verified structurally only';
  else
    select count(*) into v_hits
      from jsonb_array_elements(public.get_fixtures(v_client) -> 'items') e
      where e ->> 'category' = 'door' and e ? 'sillIn';
    if v_hits = 0 then
      raise exception '208: get_fixtures(%) still drops sillIn for doors', v_client;
    end if;
  end if;
end $$;
