-- 339_library.sql — the library of claddings, doors and windows (Carolyn's 10-26 call, plan §1 step 4).
--
-- ⛔ APPLY BY HAND, AFTER AHSAN HAS SAID YES. Apply it BEFORE the portal-settings and admin-catalog
--    deploys that read it. NEVER `supabase db push`, never `--file` (403s since 2026-10-24), and never
--    wrapped in begin;/commit; (`db query --linked` has silently applied nothing from such a block,
--    2026-10-21). Beta and production share this database: whatever lands here is live everywhere.
--
-- ── HOW TO APPLY: ONE PIECE AT A TIME, INLINE, EACH READ BACK ─────────────────────────────
-- The file is cut into pieces between `-- >>> <name>` and `-- <<< <name>` lines. Every P piece is
-- ONE statement (a DO block, atomic by itself; P0 is one insert), every R piece is ONE select that
-- reads that piece back. Run B0 FIRST and keep its output, then P0, R0, P1, R1, ... P7, R7, each as
-- its own call, stopping at the first R that does not read as its comment says, and B0 again at the
-- end: its output must be byte-identical to the first run (get_config and get_fixtures unchanged for
-- every builder). Each piece is far under 30 KB, has no comment line at column 0 once cut (a leading
-- `--` makes the CLI run NOTHING), and can be run again safely. From the repo root, in Git Bash:
--
--   F=supabase/migrations/339_library.sql
--   SB=<the supabase.exe of the CLI, called directly, not through npx.cmd (8 KB line limit)>
--   piece() { awk -v n="$1" '{sub(/\r$/,"")} $0=="-- >>> "n{on=1;next} $0=="-- <<< "n{on=0} on' "$F" | grep -v '^--'; }
--   (The `sub` drops a Windows checkout's carriage returns; without it no marker matches, the piece
--   comes out empty and the CLI refuses it. An empty piece is a stop, never a skip.)
--   "$SB" db query --linked -o csv "$(piece B0)" > before.csv
--   "$SB" db query --linked "$(piece P0)"      # must print ONE row: 339, 339_library
--   "$SB" db query --linked "$(piece R0)"      # ...and so on through R7
--   "$SB" db query --linked -o csv "$(piece B0)" > after.csv; diff before.csv after.csv   # no output
--
-- P0 CLAIMS THE NUMBER FIRST. No row back from P0 means another session already took 339: stop,
-- rename this file, its test (tests/sql/migration339.test.cjs) and every '339' below, and start
-- again. Numbering on 2026-10-27: 336 is the newest applied, and the unapplied door-looks branch
-- holds 337 and 338.
--
-- ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────────────────
--   P1  library_look_ok(category, look): the one rule for what a look may hold, used by both tables
--       (cladding {profile, exposureIn}, door {doorStyle}, window {liteRows, liteCols}). Then
--       library_items: the StructureStudio library, global (no client_id), operator-owned (the 016
--       layout_item_types pattern). Builders read it through portal-settings only.
--   P2  client_library: each builder's own entries. Ahsan 2026-10-27: a builder USES a template under
--       any name and may EDIT it, and the edit changes their copy only, never the StructureStudio
--       template. So an entry holds its own `look` (copied from the template it came from, whose id
--       and version it remembers). A cladding entry's profile never changes (a new profile is a new
--       entry: the profile is which drawn look it is, and style rows key on it).
--   P3  style_cladding.client_library_id and fixture_items.client_library_id: a style's cladding row
--       or a door/window row may point at one of the SAME builder's entries (composite FK, SET NULL
--       on the id alone). The link WRITES THROUGH to the columns everything already reads, so
--       get_config, get_fixtures, the designer, submit-estimate and claddingLineName never change:
--         cladding row  label_override := the entry's name, exposure_in := its course (lap only)
--         door row      door_style := the entry's doorStyle
--         window row    lite_rows, lite_cols := the entry's grid (both NULL = automatic)
--       at link time and whenever the entry is edited (the entry's AFTER trigger re-touches its rows).
--       A SAVE THAT DISAGREES WITH THE ENTRY UNLINKS THE ROW rather than being overwritten or refused:
--       production's older portal sends doorStyle and label_override on every save, and the library is
--       a filter on the pickers, never a save rule (plan, Risks). A cladding row's profile must match
--       its entry's at link time (the action checks first, with a sentence; this is the backstop).
--   P4  library_requests: a builder asking for a cladding, door or window that is not in the library.
--       Windows and cladding are hand-built by CSM and charged at submit (Ahsan 2026-10-27: $2);
--       doors will come through the paid photo flow (a later step: ai_idem_key links its ledger).
--       charged_cents / refunded_cents record the money; wallet_transactions stays the ledger.
--   P5  client_settings.library_beta (the tenant flag, default off), the request meter
--       'library_request' at 200 cents, INACTIVE (requests are free until Ahsan arms it, outside any
--       migration), and the private bucket library-refs (5 MB, JPEG/PNG/WebP) for request photos.
--   P6  the seed: today's code as templates, under the names builders already see. The 5 claddings
--       (SS_CLADDING_ROWS' names, so seeding a builder's library changes no label a customer reads),
--       the 9 door looks with the Doors editor's own words, and 6 window grids. No builder or
--       supplier names: the repo is public. Operators add search terms from Admin → Master Catalog.
--   P7  apply-time assertions (RAISE on anything wrong).
--
-- ── RLS AND GRANTS ───────────────────────────────────────────────────────────────────────
-- All three tables: RLS on, NO policies, `revoke all ... from public, anon, authenticated`, granted
-- to service_role. Nothing reads them directly: portal-settings and admin-catalog use the service
-- role. P7 checks pg_policies, not only relrowsecurity. The trigger functions are revoked from
-- public, anon and authenticated (revoking from the two roles alone leaves the PUBLIC grant).
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- New tables nothing reads yet, two nullable columns every row reads NULL in (so the triggers on
-- them do nothing until a row is linked), a flag that is off for every builder, and an inactive
-- meter. get_config and get_fixtures do not change (B0 proves it). The live portal-settings never
-- names any of it.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   1. portal-settings and admin-catalog back to builds without the library actions (both fall back
--      on 42P01/42703, so this is a cleanliness step, not a must).
--   2. This, as one inline call:
--   do $rb$ begin
--     drop trigger if exists client_library_write_through on public.client_library;
--     drop trigger if exists client_library_guard on public.client_library;
--     drop trigger if exists style_cladding_library_link on public.style_cladding;
--     drop trigger if exists fixture_items_library_link on public.fixture_items;
--     drop function if exists public.client_library_write_through();
--     drop function if exists public.client_library_guard();
--     drop function if exists public.style_cladding_library_link();
--     drop function if exists public.fixture_items_library_link();
--     alter table public.style_cladding drop constraint if exists style_cladding_library_fk;
--     drop index if exists public.style_cladding_library_idx;
--     alter table public.style_cladding drop column if exists client_library_id;
--     alter table public.fixture_items drop constraint if exists fixture_items_library_fk;
--     drop index if exists public.fixture_items_library_idx;
--     alter table public.fixture_items drop column if exists client_library_id;
--     drop table if exists public.library_requests;
--     drop table if exists public.client_library;
--     drop table if exists public.library_items;
--     drop function if exists public.library_look_ok(text, jsonb);
--     alter table public.client_settings drop column if exists library_beta;
--     delete from public.usage_prices where kind = 'library_request';
--     notify pgrst, 'reload schema';
--   end $rb$;
--   delete from supabase_migrations.schema_migrations where version = '339' returning version;
-- Then check: to_regclass('public.client_library') is null. The library-refs bucket is NOT dropped
-- here: Supabase refuses direct deletes from its storage tables, and one refusal inside the block
-- would undo the whole rollback. Empty and delete it from the dashboard if it must go.
--
-- The repo is public: no builder names or ids in here.

-- Every builder's config and fixtures, hashed. Run before P0 and after R7; the two outputs must match.
-- >>> B0
select cc.client_id, md5(public.get_config(cc.client_id)::text) as config_md5,
       md5(coalesce(public.get_fixtures(cc.client_id)::text, '')) as fixtures_md5
  from public.client_configs cc order by cc.client_id;
-- <<< B0

-- >>> P0
insert into supabase_migrations.schema_migrations (version, name)
values ('339', '339_library')
on conflict (version) do nothing
returning version, name;
-- <<< P0

-- >>> R0
select version, name from supabase_migrations.schema_migrations where version = '339';
-- <<< R0

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P1 — the look rule, and the StructureStudio library (global)
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P1
do $m339_p1$
begin
  perform set_config('lock_timeout', '5s', true);
  create or replace function public.library_look_ok(p_category text, p_look jsonb)
  returns boolean language sql immutable set search_path = '' as $fn$
    -- coalesce: a CHECK passes on NULL, and a missing key makes these comparisons NULL, not false.
    select coalesce(case
      when p_look is null or jsonb_typeof(p_look) <> 'object' or octet_length(p_look::text) > 1024 then false
      when p_category = 'cladding' then
        not exists (select 1 from jsonb_object_keys(p_look) k where k not in ('profile', 'exposureIn'))
        and coalesce(p_look ->> 'profile', '') in ('panel', 'lap', 'batten', 'agpanel', 'vinyl')
        and (p_look -> 'exposureIn' is null or jsonb_typeof(p_look -> 'exposureIn') = 'null'
             or (p_look ->> 'profile' = 'lap' and jsonb_typeof(p_look -> 'exposureIn') = 'number'
                 and (p_look ->> 'exposureIn')::numeric between 3 and 12))
      when p_category = 'door' then
        not exists (select 1 from jsonb_object_keys(p_look) k where k <> 'doorStyle')
        and coalesce(p_look ->> 'doorStyle', '') in ('auto', 'plank', 'zbrace', 'xbrace', 'rollup', 'american', 'basic', 'classic', 'dutch')
      when p_category = 'window' then
        not exists (select 1 from jsonb_object_keys(p_look) k where k not in ('liteRows', 'liteCols'))
        and ((p_look -> 'liteRows' is null and p_look -> 'liteCols' is null)
             or (jsonb_typeof(p_look -> 'liteRows') = 'number' and jsonb_typeof(p_look -> 'liteCols') = 'number'
                 and (p_look ->> 'liteRows') ~ '^[1-8]$' and (p_look ->> 'liteCols') ~ '^[1-8]$'))
      else false
    end, false)
  $fn$;
  revoke all on function public.library_look_ok(text, jsonb) from public, anon, authenticated;

  create table if not exists public.library_items (
    id            uuid primary key default gen_random_uuid(),
    category      text not null,
    slug          text not null,
    name          text not null,
    description   text,
    search_terms  text[] not null default '{}',
    look          jsonb not null,
    recolourable  boolean not null default true,
    leaves        smallint,
    thumb_url     text,
    status        text not null default 'active',
    version       integer not null default 1,
    source        text not null default 'builtin',
    sort_order    integer not null default 0,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    constraint library_items_category_chk check (category in ('cladding', 'door', 'window')),
    constraint library_items_slug_chk check (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
    constraint library_items_slug_key unique (category, slug),
    constraint library_items_id_category_key unique (id, category),
    constraint library_items_name_chk check (char_length(name) between 1 and 80 and name = btrim(name)),
    constraint library_items_description_chk check (description is null or char_length(description) <= 600),
    constraint library_items_terms_chk check (cardinality(search_terms) <= 40),
    constraint library_items_look_chk check (public.library_look_ok(category, look)),
    constraint library_items_leaves_chk check (leaves is null or leaves in (1, 2)),
    constraint library_items_thumb_chk check (thumb_url is null or (thumb_url ~ '^https://' and char_length(thumb_url) <= 500)),
    constraint library_items_status_chk check (status in ('active', 'archived')),
    constraint library_items_version_chk check (version >= 1),
    constraint library_items_source_chk check (source in ('builtin', 'csm'))
  );
  create index if not exists library_items_list_idx on public.library_items (category, status, sort_order);
  alter table public.library_items enable row level security;
  revoke all on table public.library_items from public, anon, authenticated;
  grant select, insert, update, delete on table public.library_items to service_role;
  comment on table public.library_items is
    'The StructureStudio library (339): the cladding, door and window templates every builder can '
    'use. Global, operator-owned (Admin → Master Catalog). A builder''s use of one is a COPY in '
    'client_library, so editing a template never changes a builder''s entry, and a builder''s edit '
    'never changes the template. Archived = hidden from new picks; copies already made stay. version '
    'is bumped on every edit. RLS on, no policies, revoked from public, anon, authenticated.';
end
$m339_p1$;
-- <<< P1

-- Expect: true, true, 0, false, true, false
-- >>> R1
select to_regclass('public.library_items') is not null as items_ready,
       (select relrowsecurity from pg_class where oid = 'public.library_items'::regclass) as rls_on,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'library_items') as policies,
       has_table_privilege('anon', 'public.library_items', 'select') or has_table_privilege('authenticated', 'public.library_items', 'select') as browser_reads,
       public.library_look_ok('cladding', '{"profile":"lap","exposureIn":7}'::jsonb) as lap_course_ok,
       public.library_look_ok('cladding', '{"profile":"panel","exposureIn":7}'::jsonb) as panel_course_ok;
-- <<< R1

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P2 — each builder's own entries
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P2
do $m339_p2$
begin
  perform set_config('lock_timeout', '5s', true);
  create table if not exists public.client_library (
    id               uuid primary key default gen_random_uuid(),
    client_id        text not null,
    category         text not null,
    library_item_id  uuid,
    template_version integer,
    name             text not null,
    look             jsonb not null,
    active           boolean not null default true,
    sort_order       integer not null default 0,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    constraint client_library_client_id_id_key unique (client_id, id),
    constraint client_library_category_chk check (category in ('cladding', 'door', 'window')),
    constraint client_library_name_chk check (char_length(name) between 1 and 60 and name = btrim(name)),
    constraint client_library_look_chk check (public.library_look_ok(category, look)),
    constraint client_library_version_chk check (template_version is null or template_version >= 1),
    -- The template it was copied from, of the same category. RESTRICT: a template a builder copied is
    -- archived, never deleted.
    constraint client_library_template_fk foreign key (library_item_id, category)
      references public.library_items (id, category) on delete restrict
  );
  create unique index if not exists client_library_name_key
    on public.client_library (client_id, category, lower(name));
  create index if not exists client_library_template_idx on public.client_library (library_item_id);
  alter table public.client_library enable row level security;
  revoke all on table public.client_library from public, anon, authenticated;
  grant select, insert, update, delete on table public.client_library to service_role;
  comment on table public.client_library is
    'A builder''s own library (339): the claddings, doors and windows they sell, each a named COPY of '
    'a StructureStudio template (library_item_id, template_version) whose look they may edit. Rows '
    'that use an entry point at it (style_cladding / fixture_items.client_library_id) and follow its '
    'edits. Names are unique per builder and category, ignoring case. A cladding entry''s profile '
    'never changes. RLS on, no policies, revoked from public, anon, authenticated.';

  -- Category and a cladding's profile are fixed once made.
  create or replace function public.client_library_guard()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    if new.category is distinct from old.category then
      raise exception 'A library entry''s category cannot change' using errcode = '23514';
    end if;
    if new.category = 'cladding' and (new.look ->> 'profile') is distinct from (old.look ->> 'profile') then
      raise exception 'A cladding entry''s look cannot change; add a new entry instead' using errcode = '23514';
    end if;
    new.updated_at := now();
    return new;
  end
  $fn$;
  revoke all on function public.client_library_guard() from public, anon, authenticated;
  drop trigger if exists client_library_guard on public.client_library;
  create trigger client_library_guard before update on public.client_library
    for each row execute function public.client_library_guard();
end
$m339_p2$;
-- <<< P2

-- Expect: true, true, 0, false, true, true
-- >>> R2
select to_regclass('public.client_library') is not null as entries_ready,
       (select relrowsecurity from pg_class where oid = 'public.client_library'::regclass) as rls_on,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'client_library') as policies,
       has_table_privilege('anon', 'public.client_library', 'select') or has_table_privilege('authenticated', 'public.client_library', 'select') as browser_reads,
       exists (select 1 from pg_constraint where conname = 'client_library_client_id_id_key' and conrelid = 'public.client_library'::regclass) as tenant_key,
       exists (select 1 from pg_trigger where tgname = 'client_library_guard' and tgrelid = 'public.client_library'::regclass and not tgisinternal) as guard_ready;
-- <<< R2

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P3 — style rows and door/window rows point at an entry, and the entry writes through
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P3
do $m339_p3$
begin
  perform set_config('lock_timeout', '5s', true);
  alter table public.style_cladding add column if not exists client_library_id uuid;
  if not exists (select 1 from pg_constraint where conname = 'style_cladding_library_fk'
                  and conrelid = 'public.style_cladding'::regclass) then
    -- SET NULL names client_library_id alone: client_id is NOT NULL and must never be cleared.
    alter table public.style_cladding
      add constraint style_cladding_library_fk foreign key (client_id, client_library_id)
      references public.client_library (client_id, id) on delete set null (client_library_id);
  end if;
  create index if not exists style_cladding_library_idx
    on public.style_cladding (client_id, client_library_id) where client_library_id is not null;
  comment on column public.style_cladding.client_library_id is
    'The builder''s library entry this cladding row offers (339), or NULL. Same builder only '
    '(composite FK). While set, label_override is the entry''s name and exposure_in its course, and '
    'they follow the entry''s edits; a save that sets either to something else unlinks the row.';

  alter table public.fixture_items add column if not exists client_library_id uuid;
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_library_fk'
                  and conrelid = 'public.fixture_items'::regclass) then
    alter table public.fixture_items
      add constraint fixture_items_library_fk foreign key (client_id, client_library_id)
      references public.client_library (client_id, id) on delete set null (client_library_id);
  end if;
  create index if not exists fixture_items_library_idx
    on public.fixture_items (client_id, client_library_id) where client_library_id is not null;
  comment on column public.fixture_items.client_library_id is
    'The builder''s library entry whose look this door or window row draws (339), or NULL. Same '
    'builder and same category only. While set, door_style (doors) or lite_rows/lite_cols (windows) '
    'are the entry''s and follow its edits; a save that sets them to something else unlinks the row.';

  -- Link time: the row takes the entry's values. Linked already: a save that disagrees unlinks.
  create or replace function public.style_cladding_library_link()
  returns trigger language plpgsql set search_path = '' as $fn$
  declare e record; v_course numeric;
  begin
    if new.client_library_id is null then return new; end if;
    select l.category, l.name, l.look into e from public.client_library l
     where l.client_id = new.client_id and l.id = new.client_library_id;
    if not found then return new; end if;   -- the FK says so, in its own words
    if e.category <> 'cladding' then
      raise exception 'That library entry is not a cladding' using errcode = '23514';
    end if;
    v_course := case when e.look ->> 'profile' = 'lap' then (e.look ->> 'exposureIn')::numeric end;
    if tg_op = 'INSERT' or new.client_library_id is distinct from old.client_library_id then
      if new.cladding_id <> e.look ->> 'profile' then
        raise exception 'That library entry is a different cladding look' using errcode = '23514';
      end if;
      new.label_override := e.name;
      new.exposure_in := v_course;
    elsif new.cladding_id <> e.look ->> 'profile'
       or new.label_override is distinct from e.name
       or new.exposure_in is distinct from v_course then
      new.client_library_id := null;
    end if;
    return new;
  end
  $fn$;
  revoke all on function public.style_cladding_library_link() from public, anon, authenticated;
  drop trigger if exists style_cladding_library_link on public.style_cladding;
  create trigger style_cladding_library_link
    before insert or update on public.style_cladding
    for each row execute function public.style_cladding_library_link();

  create or replace function public.fixture_items_library_link()
  returns trigger language plpgsql set search_path = '' as $fn$
  declare e record; v_rows smallint; v_cols smallint;
  begin
    if new.client_library_id is null then return new; end if;
    select l.category, l.look into e from public.client_library l
     where l.client_id = new.client_id and l.id = new.client_library_id;
    if not found then return new; end if;
    if e.category is distinct from new.category or new.category not in ('door', 'window') then
      raise exception 'That library entry is for a different kind of item' using errcode = '23514';
    end if;
    v_rows := (e.look ->> 'liteRows')::smallint;
    v_cols := (e.look ->> 'liteCols')::smallint;
    if tg_op = 'INSERT' or new.client_library_id is distinct from old.client_library_id then
      if new.category = 'door' then
        new.door_style := e.look ->> 'doorStyle';
      else
        new.lite_rows := v_rows;
        new.lite_cols := v_cols;
      end if;
    elsif (new.category = 'door' and new.door_style is distinct from e.look ->> 'doorStyle')
       or (new.category = 'window' and (new.lite_rows is distinct from v_rows or new.lite_cols is distinct from v_cols)) then
      new.client_library_id := null;
    end if;
    return new;
  end
  $fn$;
  revoke all on function public.fixture_items_library_link() from public, anon, authenticated;
  drop trigger if exists fixture_items_library_link on public.fixture_items;
  create trigger fixture_items_library_link
    before insert or update on public.fixture_items
    for each row execute function public.fixture_items_library_link();

  -- An entry's edit reaches its rows in the same statement. The rows are rewritten to the entry's new
  -- values, which is exactly what the link triggers above accept without unlinking.
  create or replace function public.client_library_write_through()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    if new.category = 'cladding' then
      update public.style_cladding
         set label_override = new.name,
             exposure_in = case when new.look ->> 'profile' = 'lap' then (new.look ->> 'exposureIn')::numeric end,
             updated_at = now()
       where client_id = new.client_id and client_library_id = new.id;
    elsif new.category = 'door' then
      update public.fixture_items set door_style = new.look ->> 'doorStyle', updated_at = now()
       where client_id = new.client_id and client_library_id = new.id
         and door_style is distinct from new.look ->> 'doorStyle';
    elsif new.category = 'window' then
      update public.fixture_items
         set lite_rows = (new.look ->> 'liteRows')::smallint, lite_cols = (new.look ->> 'liteCols')::smallint, updated_at = now()
       where client_id = new.client_id and client_library_id = new.id
         and (lite_rows is distinct from (new.look ->> 'liteRows')::smallint or lite_cols is distinct from (new.look ->> 'liteCols')::smallint);
    end if;
    return null;
  end
  $fn$;
  revoke all on function public.client_library_write_through() from public, anon, authenticated;
  drop trigger if exists client_library_write_through on public.client_library;
  create trigger client_library_write_through
    after update of name, look on public.client_library
    for each row execute function public.client_library_write_through();
end
$m339_p3$;
-- <<< P3

-- Expect: true, true, true, true, 0, 0, false
-- >>> R3
select exists (select 1 from pg_constraint where conname = 'style_cladding_library_fk' and conrelid = 'public.style_cladding'::regclass and confdeltype = 'n') as cladding_fk,
       exists (select 1 from pg_constraint where conname = 'fixture_items_library_fk' and conrelid = 'public.fixture_items'::regclass and confdeltype = 'n') as fixture_fk,
       (select count(*) = 2 from pg_trigger where tgname in ('style_cladding_library_link', 'fixture_items_library_link') and not tgisinternal) as link_triggers,
       exists (select 1 from pg_trigger where tgname = 'client_library_write_through' and tgrelid = 'public.client_library'::regclass and not tgisinternal) as write_through,
       (select count(*) from public.style_cladding where client_library_id is not null) as linked_cladding_rows,
       (select count(*) from public.fixture_items where client_library_id is not null) as linked_fixture_rows,
       has_function_privilege('anon', 'public.client_library_write_through()', 'execute') as anon_runs_it;
-- <<< R3

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P4 — requests for what is not in the library
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P4
do $m339_p4$
begin
  perform set_config('lock_timeout', '5s', true);
  create table if not exists public.library_requests (
    id                       uuid primary key default gen_random_uuid(),
    client_id                text not null,
    category                 text not null,
    status                   text not null default 'submitted',
    name                     text not null,
    width_in                 numeric,
    height_in                numeric,
    leaves                   smallint,
    photos                   jsonb not null default '[]'::jsonb,
    supplier_url             text,
    notes                    text,
    ai_idem_key              text,
    charged_cents            integer not null default 0,
    charge_tx_id             bigint,
    refunded_cents           integer not null default 0,
    refund_reason            text,
    result_library_item_id   uuid references public.library_items (id) on delete set null,
    result_client_library_id uuid,
    result_note              text,
    requested_by             uuid,
    decided_by               uuid,
    decided_at               timestamptz,
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now(),
    constraint library_requests_category_chk check (category in ('cladding', 'door', 'window')),
    constraint library_requests_status_chk check (status in
      ('submitted', 'in_progress', 'generating', 'review', 'ready', 'done', 'refused', 'failed', 'cancelled')),
    constraint library_requests_name_chk check (char_length(name) between 1 and 80 and name = btrim(name)),
    constraint library_requests_size_chk check ((width_in is null or width_in between 1 and 600) and (height_in is null or height_in between 1 and 600)),
    constraint library_requests_leaves_chk check (leaves is null or leaves in (1, 2)),
    -- Up to four photos, each {path, role}; the paths are minted by portal-settings under
    -- library-refs/<client>/requests/ and checked there by exact shape.
    constraint library_requests_photos_chk check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 4 and octet_length(photos::text) <= 4096),
    constraint library_requests_url_chk check (supplier_url is null or (supplier_url ~ '^https://' and char_length(supplier_url) <= 500)),
    constraint library_requests_notes_chk check (notes is null or char_length(notes) <= 2000),
    constraint library_requests_money_chk check (charged_cents >= 0 and refunded_cents >= 0 and refunded_cents <= charged_cents),
    constraint library_requests_refund_reason_chk check (refund_reason is null or char_length(refund_reason) <= 300),
    constraint library_requests_result_note_chk check (result_note is null or char_length(result_note) <= 1000),
    constraint library_requests_result_entry_fk foreign key (client_id, result_client_library_id)
      references public.client_library (client_id, id) on delete set null (result_client_library_id)
  );
  create index if not exists library_requests_client_idx on public.library_requests (client_id, created_at desc);
  create index if not exists library_requests_queue_idx on public.library_requests (status, created_at);
  alter table public.library_requests enable row level security;
  revoke all on table public.library_requests from public, anon, authenticated;
  grant select, insert, update, delete on table public.library_requests to service_role;
  comment on table public.library_requests is
    'Requests for a cladding, door or window that is not in the library (339). Windows and cladding '
    'are built by hand by CSM (Admin → Library requests) and charged at submit when the '
    'library_request meter is armed; a refusal or cancel is credited back through wallet_credit. '
    'Doors come through the photo flow (ai_idem_key). wallet_transactions is the money ledger; '
    'charged_cents / refunded_cents mirror it for the queue. RLS on, no policies.';
end
$m339_p4$;
-- <<< P4

-- Expect: true, true, 0, false
-- >>> R4
select to_regclass('public.library_requests') is not null as requests_ready,
       (select relrowsecurity from pg_class where oid = 'public.library_requests'::regclass) as rls_on,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'library_requests') as policies,
       has_table_privilege('anon', 'public.library_requests', 'select') or has_table_privilege('authenticated', 'public.library_requests', 'select') as browser_reads;
-- <<< R4

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P5 — the flag, the request meter (inactive) and the photo bucket
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P5
do $m339_p5$
begin
  perform set_config('lock_timeout', '5s', true);
  alter table public.client_settings add column if not exists library_beta boolean not null default false;
  comment on column public.client_settings.library_beta is
    'Settings → Options shows the library sections and feeds the cladding, door and window pickers '
    'from the builder''s library (339). Off for every builder until CSM turns it on.';
  insert into public.usage_prices (kind, label, unit_label, price_cents, active, visible, sort_order, note)
  values ('library_request', 'Library request (a window or a cladding)', 'request', 200, false, true, 40,
          'Ahsan 2026-10-27: $2 per window or cladding request, charged when submitted and credited back if CSM refuses it or the builder cancels before work starts. Inactive until armed (requests are free while inactive).')
  on conflict (kind) do nothing;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('library-refs', 'library-refs', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = false, file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];
end
$m339_p5$;
-- <<< P5

-- Expect: 0, true, false, 200, true
-- >>> R5
select (select count(*) from public.client_settings where library_beta) as flagged_builders,
       exists (select 1 from public.usage_prices where kind = 'library_request') as meter_ready,
       (select active from public.usage_prices where kind = 'library_request') as meter_active,
       (select price_cents from public.usage_prices where kind = 'library_request') as meter_cents,
       exists (select 1 from storage.buckets where id = 'library-refs' and not public and file_size_limit = 5242880) as bucket_private;
-- <<< R5

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P6 — the seed: today's looks as templates
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P6
do $m339_p6$
begin
  perform set_config('lock_timeout', '5s', true);
  insert into public.library_items (category, slug, name, description, search_terms, look, recolourable, sort_order) values
    ('cladding', 'lap', '7" LP Lap Siding',
     'Horizontal boards, each lapping the one below. The course (how much of each board shows) is set per entry, 3 to 12 inches; 6 inches when left blank.',
     array['lap', 'lap siding', 'LP', 'clapboard', 'horizontal', 'engineered wood', 'wood lap', 'cement board', 'beveled'], '{"profile":"lap"}', true, 10),
    ('cladding', 'vinyl', '4.5" Vinyl Siding',
     'Horizontal vinyl siding with its double-course profile.',
     array['vinyl', 'vinyl siding', 'dutch lap', 'double 4', 'horizontal', 'plastic'], '{"profile":"vinyl"}', true, 20),
    ('cladding', 'panel', 'Panel Siding',
     'Flat sheet siding with vertical grooves.',
     array['panel', 'panel siding', 'sheet', 'plywood', 'T1-11', 't111', 'grooved', 'smooth panel', 'vertical groove'], '{"profile":"panel"}', true, 30),
    ('cladding', 'batten', 'Board & Batten',
     'Wide vertical boards with narrow battens over the seams.',
     array['board and batten', 'batten', 'b&b', 'vertical boards', 'barn siding', 'farmhouse'], '{"profile":"batten"}', true, 40),
    ('cladding', 'agpanel', 'AG Panel',
     'Ribbed metal wall panel (the same rib as an agricultural metal roof).',
     array['metal', 'steel', 'ag panel', 'agricultural', 'ribbed', 'corrugated', 'tin', 'post frame'], '{"profile":"agpanel"}', true, 50),
    ('door', 'photo', 'Use the door''s photo',
     'The door''s photo is laid onto the door in 3D. Photos taken at an angle look stretched on the building; switch to one of the built looks if the door looks skewed.',
     array['photo', 'picture', 'image', 'custom', 'auto'], '{"doorStyle":"auto"}', false, 10),
    ('door', 'plank', 'Board-and-batten (built in 3D)',
     'Drawn as a real door: a framed panel of vertical boards with black strap hinges and a barn latch, in the door colour the customer picks.',
     array['plank', 'board and batten', 'barn door', 'wood door', 'strap hinges'], '{"doorStyle":"plank"}', true, 20),
    ('door', 'zbrace', 'Board-and-batten with a Z brace',
     'The board-and-batten door with a single diagonal brace, rising from the hinge side.',
     array['z brace', 'z-brace', 'barn door', 'diagonal brace', 'wood door'], '{"doorStyle":"zbrace"}', true, 30),
    ('door', 'xbrace', 'Board-and-batten with an X brace',
     'The board-and-batten door with a crossed X brace across the lower panel.',
     array['x brace', 'x-brace', 'crossbuck', 'barn door', 'wood door'], '{"doorStyle":"xbrace"}', true, 40),
    ('door', 'rollup', 'Roll-up / garage door',
     'Drawn as a roll-up: horizontal slats in side tracks with a lift handle. No hinges or latch.',
     array['roll up', 'roll-up', 'garage door', 'overhead', 'rollup', 'metal door'], '{"doorStyle":"rollup"}', true, 50),
    ('door', 'american', 'American (built in 3D)',
     'A trim frame with a mid rail and vertical pickets across the lower panel, panels in the door colour, with a window in the upper panel if the customer picks one.',
     array['american', 'pickets', 'trim frame', 'shed door', 'barn door'], '{"doorStyle":"american"}', true, 60),
    ('door', 'basic', 'Basic (built in 3D)',
     'A trim frame with a mid rail and plain panels in the door colour, with a window in the upper panel if the customer picks one.',
     array['basic', 'plain', 'trim frame', 'shed door', 'barn door'], '{"doorStyle":"basic"}', true, 70),
    ('door', 'classic', 'Classic (built in 3D)',
     'A trim frame with an octagon and a diamond in the upper panel and an X in the lower one; a window, if the customer picks one, takes the octagon''s place.',
     array['classic', 'octagon', 'diamond', 'x', 'trim frame', 'shed door', 'barn door'], '{"doorStyle":"classic"}', true, 80),
    ('door', 'dutch', 'Dutch (built in 3D)',
     'A trim frame with a mid rail and a small dark louvred vent in the lower panel, with a window in the upper panel if the customer picks one.',
     array['dutch', 'vent', 'louvre', 'louver', 'trim frame', 'shed door', 'barn door'], '{"doorStyle":"dutch"}', true, 90),
    ('window', 'automatic', 'Standard window',
     'The window as the 3D has always drawn it, its grid sized to the window.',
     array['standard', 'automatic', 'default', 'single hung', 'double hung'], '{}', true, 10),
    ('window', 'no-grid', 'No grid',
     'One clear pane, no grid.',
     array['no grid', 'clear', 'picture window', 'plain', 'one lite', '1 lite'], '{"liteRows":1,"liteCols":1}', true, 20),
    ('window', 'two-lite', '2-lite, side by side',
     'Two panes side by side.',
     array['2 lite', 'two lite', 'slider', 'sliding window', 'two pane'], '{"liteRows":1,"liteCols":2}', true, 30),
    ('window', 'six-lite', '6-lite (3 rows of 2)',
     'Six panes: three rows of two.',
     array['6 lite', 'six lite', 'colonial', 'grid'], '{"liteRows":3,"liteCols":2}', true, 40),
    ('window', 'nine-lite', '9-lite (3 by 3)',
     'Nine panes: three rows of three.',
     array['9 lite', 'nine lite', 'grid', 'door lite'], '{"liteRows":3,"liteCols":3}', true, 50),
    ('window', 'transom-four', '4-lite transom (1 row of 4)',
     'A transom: one row of four panes.',
     array['transom', '4 lite', 'four lite', 'one row'], '{"liteRows":1,"liteCols":4}', true, 60)
  on conflict (category, slug) do nothing;
end
$m339_p6$;
-- <<< P6

-- Expect: 5, 9, 6, 0
-- >>> R6
select count(*) filter (where category = 'cladding') as claddings,
       count(*) filter (where category = 'door') as doors,
       count(*) filter (where category = 'window') as windows,
       count(*) filter (where status <> 'active') as not_active
  from public.library_items where source = 'builtin';
-- <<< R6

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P7 — assertions
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P7
do $m339_p7$
declare t text;
begin
  foreach t in array array['library_items', 'client_library', 'library_requests'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '339: % has RLS off', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '339: % has a policy; it must have none', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('anon', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'insert') then
      raise exception '339: a browser role can read or write %', t;
    end if;
  end loop;
  foreach t in array array['library_look_ok(text, jsonb)', 'client_library_guard()', 'style_cladding_library_link()',
                           'fixture_items_library_link()', 'client_library_write_through()'] loop
    if has_function_privilege('anon', 'public.' || t, 'execute') or has_function_privilege('authenticated', 'public.' || t, 'execute') then
      raise exception '339: public.% is executable by a browser role', t;
    end if;
  end loop;
  -- SET NULL must name the id column alone, or a deleted entry would try to clear client_id.
  foreach t in array array['style_cladding_library_fk', 'fixture_items_library_fk', 'library_requests_result_entry_fk'] loop
    if not exists (select 1 from pg_constraint where conname = t and confdeltype = 'n' and cardinality(confdelsetcols) = 1) then
      raise exception '339: % is missing or wrong (want ON DELETE SET NULL of the id column alone)', t;
    end if;
  end loop;
  -- (The flag being off, the meter inactive and nothing linked are true on the FIRST apply and read
  -- back by R3 and R5. They are not asserted here, so P7 can run again over live data.)
  if not exists (select 1 from storage.buckets where id = 'library-refs' and not public) then
    raise exception '339: the library-refs bucket is missing or public';
  end if;
  if (select count(*) from public.library_items where source = 'builtin') < 20 then
    raise exception '339: the seed is short (want 5 claddings, 9 doors, 6 windows)';
  end if;
end
$m339_p7$;
-- <<< P7

-- Expect: true, 20, 0
-- >>> R7
select true as assertions_passed,
       (select count(*) from public.library_items) as templates,
       (select count(*) from public.client_library) as builder_entries;
-- <<< R7
