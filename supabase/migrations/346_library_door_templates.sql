-- 346_library_door_templates.sql — a StructureStudio door template can be a door a builder made from
-- a photo, promoted by an operator (Carolyn's 10-27 call: "take any of the ones that they create and
-- then add it to a Structure Studio library"; Ahsan 10-27: promote freely, under a new name, with no
-- builder details on the template).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, AFTER 345_library_door_looks.sql. NEVER `supabase db push`,
--    never `--file`, never inside begin;/commit;. One inline call per piece (CLI `db query --linked` or
--    the Supabase connector's execute_sql):
--
--   F=supabase/migrations/346_library_door_templates.sql
--   piece() { awk -v n="$1" '{sub(/\r$/,"")} $0=="-- >>> "n{on=1;next} $0=="-- <<< "n{on=0} on' "$F" | grep -v '^--'; }
--   "$SB" db query --linked "$(piece P0)"      # must print ONE row: 346, 346_library_door_templates
--   "$SB" db query --linked "$(piece P1)"
--   "$SB" db query --linked "$(piece R1)"      # THE RECORD
--
-- P0 claims the number first: no row back means another session took 346, so rename this file, its test
-- (tests/sql/migration346.test.cjs) and every '346' below. Read the max first, numbered rows only:
-- select max(version) filter (where version ~ '^\d{3}$') from supabase_migrations.schema_migrations;
--
-- ── WHAT IT DOES ─────────────────────────────────────────────────────────────────────────
-- library_items.door_spec: the cleaned door-look spec of a promoted door (343's shape, at most 4096
-- bytes as stored), NULL for every other template. A template with one is drawn over its look's base:
-- door_spec.base = look.doorStyle, so production's designer (which reads only door_style) draws the base.
-- Nothing reads it but portal-settings: a builder who imports such a template gets their OWN ready
-- door_looks row with that spec and a library entry naming it (345), so get_fixtures, the designer and
-- submit-estimate see nothing new. The template row carries no builder id: where it came from is in
-- admin_audit only.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- One nullable column every row reads NULL in, and a CHECK every existing row passes. get_config and
-- get_fixtures don't read library_items.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   alter table public.library_items drop constraint if exists library_items_door_spec_chk;
--   alter table public.library_items drop column if exists door_spec;
--   delete from supabase_migrations.schema_migrations where version = '346' returning version;
-- (Builders' copies are their own door_looks rows and keep working.)
--
-- The repo is public: no builder names or ids in here.

-- >>> P0
insert into supabase_migrations.schema_migrations (version, name)
values ('346', '346_library_door_templates')
on conflict (version) do nothing
returning version, name;
-- <<< P0

-- >>> P1
do $m346_p1$
begin
  perform set_config('lock_timeout', '5s', true);
  if to_regclass('public.library_items') is null or to_regclass('public.door_looks') is null then
    raise exception '346: apply 339_library and 343_door_looks first; nothing changed';
  end if;
  alter table public.library_items add column if not exists door_spec jsonb;
  if not exists (select 1 from pg_constraint where conname = 'library_items_door_spec_chk'
                  and conrelid = 'public.library_items'::regclass) then
    alter table public.library_items
      add constraint library_items_door_spec_chk check (
        door_spec is null
        or (category = 'door'
            and jsonb_typeof(door_spec) = 'object'
            and octet_length(door_spec::text) <= 4096
            and door_spec -> 'v' = '1'::jsonb
            and door_spec ->> 'base' in ('plank', 'zbrace', 'xbrace', 'american', 'basic', 'classic', 'dutch')
            and door_spec ->> 'base' = look ->> 'doorStyle'));
  end if;
  comment on column public.library_items.door_spec is
    'A door a builder made from a photo, promoted by an operator (346): the cleaned door-look spec '
    '(343''s shape), drawn over look.doorStyle (its base). NULL for every other template. A builder who '
    'imports it gets their own ready door_looks copy and a library entry naming it (345). No builder '
    'id on the row; admin_audit says where it came from.';
  perform pg_notify('pgrst', 'reload schema');
end
$m346_p1$;
-- <<< P1

-- THE RECORD. Expect: true, true, 0.
-- >>> R1
select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'library_items'
                 and column_name = 'door_spec' and data_type = 'jsonb' and is_nullable = 'YES') as column_ready,
       exists (select 1 from pg_constraint where conname = 'library_items_door_spec_chk') as check_ready,
       (select count(*) from public.library_items where door_spec is not null) as promoted_doors;
-- <<< R1
