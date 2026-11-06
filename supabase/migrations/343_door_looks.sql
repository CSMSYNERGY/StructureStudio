-- 343_door_looks.sql — a builder's own 3D door looks (door looks from a photo, plan 2026-10-24 §6).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, AND NOT BEFORE CAROLYN HAS APPROVED P0 (the plan's
--    deploy order, step 3). Apply it BEFORE 344_get_fixtures_door_look.sql and BEFORE the
--    portal-settings deploy that reads it. NEVER `supabase db push`, never `--file` (403s since
--    2026-10-24), and never wrapped in begin;/commit; (`db query --linked` has silently applied
--    nothing from such a block, 2026-10-21).
--
-- ── HOW TO APPLY: ONE PIECE AT A TIME, INLINE, EACH READ BACK ─────────────────────────────
-- The file is cut into pieces between `-- >>> <name>` and `-- <<< <name>` lines. Every P piece is
-- ONE statement (a DO block, atomic by itself; P0 is one insert), every R piece is ONE select that
-- reads that piece back. Run them in order P0, R0, P1, R1, ... P7, R7, each as its own call, and
-- stop at the first R that does not read as its comment says. Each piece is far under 30 KB, has
-- no comment line at column 0 once cut (a leading `--` makes the CLI run NOTHING), and can be run
-- again safely. From the repo root, in Git Bash:
--
--   F=supabase/migrations/343_door_looks.sql
--   SB=<the supabase.exe of the CLI, called directly, not through npx.cmd (8 KB line limit)>
--   piece() { awk -v n="$1" '{sub(/\r$/,"")} $0=="-- >>> "n{on=1;next} $0=="-- <<< "n{on=0} on' "$F" | grep -v '^--'; }
--   (The `sub` drops a Windows checkout's carriage returns; without it no marker matches, the piece
--   comes out empty and the CLI refuses it. An empty piece is a stop, never a skip.)
--   "$SB" db query --linked "$(piece P0)"      # must print ONE row: 343, 343_door_looks
--   "$SB" db query --linked "$(piece R0)"      # ...and so on through R7
--
-- P0 CLAIMS THE NUMBER FIRST. No row back from P0 means another session already took 343: stop,
-- rename this file, its test (tests/sql/migration343.test.cjs) and every '343' below, and start
-- again. Numbering on 2026-10-26: origin/beta already holds 336_brand_colors.sql, so this one is
-- 337 then; renumbered to 343 on 2026-10-27, because the live ledger reached 342 first (the plan's "336";
-- its get_fixtures splice is 344).
--
-- ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────────────────
--   P0  the ledger row, claimed with `returning`.
--   P1  ai_door_calls: the server-only ledger of door-look generations (P4 writes it). idem_key is
--       NOT unique: one key owns the first try and one lean retry, so its index is a plain partial
--       one, like 253's on ai_style_calls.
--   P2  door_looks: one row per look, one builder each (text client_id, no FK, like fixture_items),
--       unique (client_id, id) so a door row can only point at its own builder's look. The spec is
--       the CLEANED spec (_shared/doorLook.ts) and never the pixel points, notes or photo paths.
--   P3  fixture_items.door_look_id, with the composite FK (client_id, door_look_id) -> door_looks
--       ON DELETE SET NULL (door_look_id) (Postgres 15+; live is 17.6), and doors only.
--   P4  door_looks_sync_fixtures: when a look's BASE changes, every door row on it follows
--       (fixture_items.door_style is the base, which production's designer draws); when a look is
--       ARCHIVED, its rows go back to that base look (door_look_id = NULL). In the database, in the
--       same statement as the look's own update, so door_style and the look never disagree.
--   P5  client_settings.door_looks_beta (the tenant flag, default off) and ai_door_daily_cap
--       (NULL = 10 presses per rolling 24 h, 0 = unlimited).
--   P6  usage_prices 'door_look_generation' (the door meter, INACTIVE: generating is free until
--       Carolyn sets the price), and the private storage bucket door-refs (5 MB, JPEG/PNG/WebP).
--   P7  apply-time assertions (RAISE on anything wrong).
--
-- ── RLS AND GRANTS ───────────────────────────────────────────────────────────────────────
-- Both tables: RLS on, NO policies, `revoke all ... from public, anon, authenticated`. Nothing reads
-- them directly: portal-settings uses the service role and get_fixtures is security definer. The
-- live ensure_rls trigger turns RLS on anyway; it is written out here, and P7 checks pg_policies,
-- not only relrowsecurity. The trigger function is revoked from public, anon and authenticated too
-- (revoking from the two roles alone leaves the PUBLIC grant in place).
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- New tables nothing reads yet, one nullable column every row reads NULL in, a flag that is off for
-- every builder, and an inactive meter. get_fixtures does not change here (344 does that). The live
-- portal-settings never names any of it. The old production portal keeps sending doorStyle on
-- every door save, and the new portal-settings never clears a look on that alone (§6).
--
-- ── ROLLBACK (344's ROLLBACK FIRST: its get_fixtures reads door_looks) ───────────────────
--   1. portal-settings back to a build without the door-look actions and the door_look_id select
--      (it falls back without the column on 42703, so this is a cleanliness step, not a must).
--   2. 344's rollback, so no get_fixtures body names door_looks.
--   3. These, each as its own inline call:
--   do $rb$ begin
--     drop trigger if exists door_looks_sync_fixtures on public.door_looks;
--     drop function if exists public.door_looks_sync_fixtures();
--     alter table public.fixture_items drop constraint if exists fixture_items_door_look_fk;
--     alter table public.fixture_items drop constraint if exists fixture_items_door_look_door_chk;
--     drop index if exists public.fixture_items_door_look_idx;
--     alter table public.fixture_items drop column if exists door_look_id;
--     drop table if exists public.door_looks;
--     drop table if exists public.ai_door_calls;
--     alter table public.client_settings drop constraint if exists client_settings_ai_door_daily_cap_chk;
--     alter table public.client_settings drop column if exists ai_door_daily_cap;
--     alter table public.client_settings drop column if exists door_looks_beta;
--     delete from public.usage_prices where kind = 'door_look_generation';
--     notify pgrst, 'reload schema';
--   end $rb$;
--   delete from supabase_migrations.schema_migrations where version = '343' returning version;
-- Then check: to_regclass('public.door_looks') is null. The door-refs bucket is NOT dropped here:
-- Supabase refuses direct deletes from its storage tables (and a bucket that holds photos), and one
-- refusal inside the block would undo the whole rollback. Empty and delete it from the dashboard
-- (Storage) if it must go; left alone it is private and costs nothing.
--
-- The repo is public: no builder names or ids in here.

-- >>> P0
insert into supabase_migrations.schema_migrations (version, name)
values ('343', '343_door_looks')
on conflict (version) do nothing
returning version, name;
-- <<< P0

-- >>> R0
select version, name from supabase_migrations.schema_migrations where version = '343';
-- <<< R0

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P1 — ai_door_calls, the generation ledger (server only)
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P1
do $m343_p1$
begin
  perform set_config('lock_timeout', '5s', true);
  create table if not exists public.ai_door_calls (
    id                uuid primary key default gen_random_uuid(),
    client_id         text not null,
    user_id           uuid,
    idem_key          text,
    created_at        timestamptz not null default now(),
    status            text not null default 'running',
    dims              jsonb,
    photo_paths       text[],
    measure           jsonb,
    reads             jsonb,
    drafted           jsonb,
    observed          jsonb,
    warnings          jsonb,
    zoom              jsonb,
    tokens            jsonb,
    effort            text,
    streamed          boolean,
    draft_ms          integer,
    self_check_round  integer not null default 0,
    self_check_rounds jsonb,
    self_check_at     timestamptz,
    charged_cents     integer,
    -- The hold's wallet_transactions.id, which is a bigint (128), as ai_style_calls.wallet_tx_id is (129).
    wallet_tx_id      bigint,
    constraint ai_door_calls_status_chk check (status in ('running', 'done', 'failed')),
    constraint ai_door_calls_idem_key_chk check (idem_key is null or char_length(idem_key) between 1 and 120),
    constraint ai_door_calls_photo_paths_chk check (photo_paths is null or cardinality(photo_paths) <= 4),
    constraint ai_door_calls_self_check_round_chk check (self_check_round between 0 and 3),
    constraint ai_door_calls_charged_chk check (charged_cents is null or charged_cents >= 0)
  );
  -- NOT unique on purpose (a key owns its first try and one lean retry). Recover reads the newest
  -- row for (client_id, idem_key); the cap counts distinct keys per tenant over 24 hours.
  create index if not exists ai_door_calls_idem_key_idx
    on public.ai_door_calls (client_id, idem_key) where idem_key is not null;
  create index if not exists ai_door_calls_client_idx
    on public.ai_door_calls (client_id, created_at desc);
  alter table public.ai_door_calls enable row level security;
  revoke all on table public.ai_door_calls from public, anon, authenticated;
  grant select, insert, update, delete on table public.ai_door_calls to service_role;
  comment on table public.ai_door_calls is
    'Door looks from a photo (343): one row per generation try, written by portal-settings only. '
    'idem_key is NOT unique: a press owns its first try and one lean retry, and recover reads the '
    'newest. Holds the private reference photo paths, the pixel points and the model''s notes, none '
    'of which ever reaches a shopper. RLS on, no policies, revoked from public, anon, authenticated.';
end
$m343_p1$;
-- <<< P1

-- Expect: true, true, 0, false, false
-- >>> R1
select to_regclass('public.ai_door_calls') is not null as ledger_ready,
       (select relrowsecurity from pg_class where oid = 'public.ai_door_calls'::regclass) as rls_on,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'ai_door_calls') as policies,
       has_table_privilege('anon', 'public.ai_door_calls', 'select') as anon_reads,
       exists (select 1 from pg_index i where i.indrelid = 'public.ai_door_calls'::regclass and i.indisunique
                 and exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any(i.indkey) and a.attname = 'idem_key')) as idem_key_unique;
-- <<< R1

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P2 — door_looks
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P2
do $m343_p2$
begin
  perform set_config('lock_timeout', '5s', true);
  create table if not exists public.door_looks (
    id            uuid primary key default gen_random_uuid(),
    client_id     text not null,
    name          text not null,
    base          text not null,
    spec          jsonb not null,
    spec_version  integer not null default 1,
    status        text not null default 'draft',
    thumb_url     text,
    ai_call_id    uuid,
    version       integer not null default 1,
    created_by    uuid,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    constraint door_looks_client_id_id_key unique (client_id, id),
    constraint door_looks_name_chk check (char_length(name) between 1 and 60 and name = btrim(name)),
    constraint door_looks_base_chk check (base in ('plank', 'zbrace', 'xbrace', 'american', 'basic', 'classic', 'dutch')),
    -- The cleaned spec, as get_fixtures sends it: an object, at most 4096 bytes as stored, naming
    -- the same base as the row and the same version. portal-settings refuses a bigger one in words
    -- before this backstop is reached.
    constraint door_looks_spec_chk check (jsonb_typeof(spec) = 'object' and octet_length(spec::text) <= 4096),
    constraint door_looks_spec_base_chk check (spec ->> 'base' = base and spec -> 'v' = to_jsonb(spec_version)),
    constraint door_looks_status_chk check (status in ('draft', 'ready', 'archived')),
    constraint door_looks_version_chk check (version >= 1 and spec_version >= 1),
    constraint door_looks_ai_call_fk foreign key (ai_call_id) references public.ai_door_calls (id) on delete set null
  );
  create index if not exists door_looks_client_idx on public.door_looks (client_id, status);
  alter table public.door_looks enable row level security;
  revoke all on table public.door_looks from public, anon, authenticated;
  grant select, insert, update, delete on table public.door_looks to service_role;
  comment on table public.door_looks is
    'Door looks from a photo (343): one builder''s own 3D door look, a cleaned spec over one of the '
    'seven built looks (base). Draft until the builder saves it; only ready looks reach shoppers, '
    'through get_fixtures (344) on the door rows that use them. Never holds the reference photos, '
    'pixel points or notes (those stay in ai_door_calls). version is the late-save guard. RLS on, '
    'no policies, revoked from public, anon, authenticated.';
end
$m343_p2$;
-- <<< P2

-- Expect: true, true, 0, false, true
-- >>> R2
select to_regclass('public.door_looks') is not null as looks_ready,
       (select relrowsecurity from pg_class where oid = 'public.door_looks'::regclass) as rls_on,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'door_looks') as policies,
       has_table_privilege('anon', 'public.door_looks', 'select') or has_table_privilege('authenticated', 'public.door_looks', 'select') as browser_reads,
       exists (select 1 from pg_constraint where conname = 'door_looks_client_id_id_key' and conrelid = 'public.door_looks'::regclass) as tenant_key;
-- <<< R2

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P3 — fixture_items.door_look_id
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P3
do $m343_p3$
begin
  perform set_config('lock_timeout', '5s', true);
  alter table public.fixture_items add column if not exists door_look_id uuid;
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_door_look_fk'
                  and conrelid = 'public.fixture_items'::regclass) then
    -- Both client_id columns are text. SET NULL names door_look_id alone: client_id is NOT NULL and
    -- must never be cleared by a look going away.
    alter table public.fixture_items
      add constraint fixture_items_door_look_fk foreign key (client_id, door_look_id)
      references public.door_looks (client_id, id) on delete set null (door_look_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fixture_items_door_look_door_chk'
                  and conrelid = 'public.fixture_items'::regclass) then
    alter table public.fixture_items
      add constraint fixture_items_door_look_door_chk check (door_look_id is null or category = 'door');
  end if;
  create index if not exists fixture_items_door_look_idx
    on public.fixture_items (client_id, door_look_id) where door_look_id is not null;
  comment on column public.fixture_items.door_look_id is
    'The builder''s own 3D door look this door row draws (343), or NULL for the standard look in '
    'door_style. Doors only, the same builder''s look only (composite FK). door_style always holds '
    'the look''s base, which a designer that does not know looks draws instead.';
end
$m343_p3$;
-- <<< P3

-- Expect: true, true, true, 0
-- >>> R3
select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fixture_items'
                 and column_name = 'door_look_id' and data_type = 'uuid' and is_nullable = 'YES' and column_default is null) as column_ready,
       exists (select 1 from pg_constraint where conname = 'fixture_items_door_look_fk' and conrelid = 'public.fixture_items'::regclass
                 and confdeltype = 'n') as fk_set_null,
       exists (select 1 from pg_constraint where conname = 'fixture_items_door_look_door_chk' and conrelid = 'public.fixture_items'::regclass) as doors_only,
       (select count(*) from public.fixture_items where door_look_id is not null) as rows_with_a_look;
-- <<< R3

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P4 — a look's base and archive reach its door rows in the same statement
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P4
do $m343_p4$
begin
  perform set_config('lock_timeout', '5s', true);
  create or replace function public.door_looks_sync_fixtures()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    if new.status = 'archived' and old.status is distinct from 'archived' then
      -- Archived: its rows go back to the base look, which door_style already holds.
      update public.fixture_items set door_look_id = null
       where client_id = new.client_id and door_look_id = new.id;
    elsif new.base is distinct from old.base then
      update public.fixture_items set door_style = new.base
       where client_id = new.client_id and door_look_id = new.id and door_style is distinct from new.base;
    end if;
    return null;
  end
  $fn$;
  revoke all on function public.door_looks_sync_fixtures() from public, anon, authenticated;
  drop trigger if exists door_looks_sync_fixtures on public.door_looks;
  create trigger door_looks_sync_fixtures
    after update of base, status on public.door_looks
    for each row execute function public.door_looks_sync_fixtures();
end
$m343_p4$;
-- <<< P4

-- Expect: true, false, false
-- >>> R4
select exists (select 1 from pg_trigger where tgname = 'door_looks_sync_fixtures' and tgrelid = 'public.door_looks'::regclass and not tgisinternal) as trigger_ready,
       has_function_privilege('anon', 'public.door_looks_sync_fixtures()', 'execute') as anon_runs_it,
       has_function_privilege('authenticated', 'public.door_looks_sync_fixtures()', 'execute') as authenticated_runs_it;
-- <<< R4

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P5 — the tenant flag and the daily cap
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P5
do $m343_p5$
begin
  perform set_config('lock_timeout', '5s', true);
  alter table public.client_settings add column if not exists door_looks_beta boolean not null default false;
  alter table public.client_settings add column if not exists ai_door_daily_cap integer;
  if not exists (select 1 from pg_constraint where conname = 'client_settings_ai_door_daily_cap_chk'
                  and conrelid = 'public.client_settings'::regclass) then
    alter table public.client_settings
      add constraint client_settings_ai_door_daily_cap_chk check (ai_door_daily_cap is null or ai_door_daily_cap between 0 and 1000);
  end if;
  comment on column public.client_settings.door_looks_beta is
    'Door looks from a photo (343): the Door looks section, its actions and doorLookId on a door row '
    'are this builder''s only when true. Off for everyone at apply; structure-studio first.';
  comment on column public.client_settings.ai_door_daily_cap is
    'Door looks from a photo (343): Generate presses per rolling 24 hours, counted as distinct keys. '
    'NULL = 10, 0 = unlimited.';
end
$m343_p5$;
-- <<< P5

-- Expect: true, true, 0
-- >>> R5
select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'client_settings'
                 and column_name = 'door_looks_beta' and data_type = 'boolean' and is_nullable = 'NO') as flag_ready,
       exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'client_settings'
                 and column_name = 'ai_door_daily_cap' and data_type = 'integer') as cap_ready,
       (select count(*) from public.client_settings where door_looks_beta) as builders_flagged;
-- <<< R5

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P6 — the door meter (inactive) and the private reference-photo bucket
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P6
do $m343_p6$
begin
  -- Its own meter, because the wallet allows one open hold per (client, meter kind): sharing the
  -- building meter would make a door generation block a building one. Inactive, so generating is
  -- free while we pilot. $5 (Ahsan, 2026-10-27), stored switched off; arming it is one update.
  insert into public.usage_prices (kind, label, unit_label, price_cents, active, visible, sort_order, note)
  values ('door_look_generation', '3D door look from a photo', 'generation', 500, false, true, 11,
          'Door looks from a photo (343). One Generate press: one key, one hold, at most one charge. Inactive while we pilot; Carolyn sets the price (the plan suggests $5) in the same statement that arms it.')
  on conflict (kind) do nothing;
  -- Private: the server signs every upload and read; no policy for anon or authenticated.
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('door-refs', 'door-refs', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];
end
$m343_p6$;
-- <<< P6

-- Expect: true, false, true
-- >>> R6
select exists (select 1 from public.usage_prices where kind = 'door_look_generation') as meter_ready,
       coalesce((select active from public.usage_prices where kind = 'door_look_generation'), true) as meter_active,
       exists (select 1 from storage.buckets where id = 'door-refs' and not public and file_size_limit = 5242880) as bucket_private;
-- <<< R6

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- P7 — apply-time assertions (they RAISE; a pass prints nothing, R7 is the proof)
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- >>> P7
do $m343_check$
declare
  v_def text;
  v_t   text;
begin
  foreach v_t in array array['ai_door_calls', 'door_looks'] loop
    if to_regclass('public.' || v_t) is null then
      raise exception '343: public.% is missing', v_t;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || v_t)::regclass) then
      raise exception '343: RLS is off on public.%', v_t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_t) then
      raise exception '343: public.% has a policy; it must have none (the server reads it, nothing else)', v_t;
    end if;
    if has_table_privilege('anon', 'public.' || v_t, 'select') or has_table_privilege('authenticated', 'public.' || v_t, 'select')
       or has_table_privilege('anon', 'public.' || v_t, 'insert') or has_table_privilege('authenticated', 'public.' || v_t, 'insert')
       or has_table_privilege('anon', 'public.' || v_t, 'update') or has_table_privilege('authenticated', 'public.' || v_t, 'update') then
      raise exception '343: a browser role can still read or write public.% (revoke from public, anon, authenticated)', v_t;
    end if;
  end loop;

  if exists (select 1 from pg_index i where i.indrelid = 'public.ai_door_calls'::regclass and i.indisunique
               and exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any(i.indkey) and a.attname = 'idem_key')) then
    raise exception '343: ai_door_calls.idem_key is unique; a key must be able to own a first try and its lean retry';
  end if;

  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conname = 'fixture_items_door_look_fk' and c.conrelid = 'public.fixture_items'::regclass;
  if v_def is null or position('client_id, door_look_id' in v_def) = 0 or position('SET NULL (door_look_id)' in v_def) = 0 then
    raise exception '343: fixture_items_door_look_fk is missing or wrong: %', coalesce(v_def, 'missing');
  end if;
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conname = 'fixture_items_door_look_door_chk' and c.conrelid = 'public.fixture_items'::regclass;
  if v_def is null or position('door' in v_def) = 0 then
    raise exception '343: fixture_items_door_look_door_chk is missing or wrong: %', coalesce(v_def, 'missing');
  end if;

  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'client_settings'
        and column_name in ('door_looks_beta', 'ai_door_daily_cap')) <> 2 then
    raise exception '343: client_settings.door_looks_beta or ai_door_daily_cap is missing';
  end if;
  if exists (select 1 from public.usage_prices where kind = 'door_look_generation' and active) then
    raise notice '343: the door meter is already armed (someone set its price); left as it is';
  end if;
  if not exists (select 1 from public.usage_prices where kind = 'door_look_generation') then
    raise exception '343: usage_prices has no door_look_generation row';
  end if;
  if not exists (select 1 from storage.buckets where id = 'door-refs' and not public) then
    raise exception '343: the door-refs bucket is missing or public';
  end if;
  if has_function_privilege('anon', 'public.door_looks_sync_fixtures()', 'execute')
     or has_function_privilege('authenticated', 'public.door_looks_sync_fixtures()', 'execute') then
    raise exception '343: door_looks_sync_fixtures is executable by a browser role';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'door_looks_sync_fixtures' and tgrelid = 'public.door_looks'::regclass and not tgisinternal) then
    raise exception '343: the door_looks_sync_fixtures trigger is missing';
  end if;
  -- A look on a non-door, or a look of another builder, would already have failed its constraint;
  -- this is the shape of the data, read once.
  if exists (select 1 from public.fixture_items fi where fi.door_look_id is not null
               and not exists (select 1 from public.door_looks dl where dl.client_id = fi.client_id and dl.id = fi.door_look_id)) then
    raise exception '343: a door row points at a look that is not its own builder''s';
  end if;
  perform pg_notify('pgrst', 'reload schema');
end
$m343_check$;
-- <<< P7

-- THE RECORD. Expect on a first apply: true, true, 0, false, true, true, false, true, 0.
-- >>> R7
select to_regclass('public.door_looks') is not null and to_regclass('public.ai_door_calls') is not null as tables_ready,
       (select bool_and(relrowsecurity) from pg_class where oid in ('public.door_looks'::regclass, 'public.ai_door_calls'::regclass)) as rls_on,
       (select count(*) from pg_policies where schemaname = 'public' and tablename in ('door_looks', 'ai_door_calls')) as policies,
       has_table_privilege('anon', 'public.door_looks', 'select') or has_table_privilege('anon', 'public.ai_door_calls', 'select') as anon_reads,
       exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fixture_items' and column_name = 'door_look_id') as fixture_column_ready,
       exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'client_settings' and column_name = 'door_looks_beta') as flag_ready,
       coalesce((select active from public.usage_prices where kind = 'door_look_generation'), true) as meter_active,
       exists (select 1 from storage.buckets where id = 'door-refs' and not public) as bucket_private,
       (select count(*) from public.door_looks) as looks;
-- <<< R7
