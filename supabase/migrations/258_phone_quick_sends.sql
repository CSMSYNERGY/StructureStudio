-- 258_phone_quick_sends.sql — My Synergy Phone quick sends: each person's saved messages, the
--                             starter set they are given once, and the Worker's three RPCs.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. The file carries its own
--    begin;/commit; so every assertion below takes the whole migration with it if it fails.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Quick sends are saved messages a person picks from a list in the phone app instead of typing.
-- The plan is _Extras/My Synergy Phone Quick Sends Plan 2026-10-01.md (vault); this file is its
-- section 1. Insert puts the message in the app's text box with the customer's name filled in.
-- It never sends: the person presses Send, and the text goes through the phone-api Worker's
-- /sms/send with every one of its checks. Nothing in this file can reach a customer.
--
-- Each person owns their own list (plan decision 2): rows are keyed by (user_id, client_id), and
-- the Worker (workers/phone-api/src/routes/quickSends.ts) narrows every read and write to the
-- caller's own pair. "Used N×" counts Inserts, not sends (decision 7).
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   phone_quick_sends            each person's list
--            phone_quick_send_defaults    the starter set, EMPTY here (see below)
--            phone_quick_send_seeded      the once-only marker, one row per (user_id, client_id)
--   PART 2   RLS on, zero policies, service-role only, all three
--   PART 3   phone_seed_quick_sends(user, client)       copy the starter set in, once ever
--            phone_quick_send_used(id, user, client)    usage_count + 1 on the caller's own row
--            phone_add_quick_send(user, client, ...)    add one after the last, never past 100
--   PART 4   apply-time assertions (they RAISE and abort the transaction)
--   PART 5   a behavioural probe on synthetic rows, rolled back, leaving nothing
--
-- ── THE STARTER SET IS NOT IN THIS FILE ──────────────────────────────────────────────────
-- This repo is public, and the starter wording is the product owner's coaching material (plan
-- decision 4). phone_quick_send_defaults ships EMPTY. Its rows come from a SQL file in the
-- private phone repo (docs/sql/quick_send_defaults.sql), applied by hand after this one. Until
-- then:
--   * phone_seed_quick_sends does nothing and returns 0, and it does NOT claim the marker, so
--     anyone who opens the list early still gets the set the first time they open it after;
--   * people can add their own quick sends as normal.
-- To change the set, replace all of its rows in one transaction. A change reaches only people
-- not seeded yet: a seeded person's list is theirs, and nothing here rewrites it.
--
-- ── SEEDED ONCE, EVER ────────────────────────────────────────────────────────────────────
-- phone_quick_send_seeded holds one row per (user_id, client_id) that has been given the set.
-- The seed CLAIMS that row first, with one `insert ... on conflict do nothing returning`, and
-- copies the defaults only when the claim came back with a row. So:
--   * two first opens at once (two devices) copy the set once: the second insert waits on the
--     first's key, then conflicts and copies nothing;
--   * deleting every quick send never brings the set back;
--   * the claim and the copy are one RPC, so one transaction: a copy that fails takes the claim
--     with it, and the next open tries again.
-- Someone on two teams (two client_ids) has a list, and gets the set, on each.
--
-- ── GRANTS: 254's POSTURE ────────────────────────────────────────────────────────────────
-- Default privileges hand every NEW table to anon AND authenticated, and every new function to
-- PUBLIC. So each table here gets RLS enabled, zero policies, `revoke all ... from public` and
-- `from anon, authenticated`, then an explicit select/insert/update/delete grant to
-- service_role. Each function gets `revoke execute ... from public, anon, authenticated` and a
-- grant to service_role only. PART 4 asserts all of it.
--   phone_seed_quick_sends   SECURITY DEFINER, as the plan asks, with search_path = ''.
--   phone_quick_send_used    SECURITY INVOKER, both. They need nothing service_role lacks, so a
--   phone_add_quick_send     stray grant to a browser role would meet the table's revoked
--                            privileges instead of running as the owner.
--
-- ── CHOICES THE PLAN LEFT OPEN ───────────────────────────────────────────────────────────
--   1. The length limits are CHECKs (name 1–60, body 1–1600, category NULL or 1–30), counted as
--      char_length counts them (code points, so an emoji is one), and a value that is only
--      whitespace is refused. The Worker trims and counts the same way, so it refuses first
--      with a plain sentence; these are the backstop. The defaults table carries the SAME
--      checks, so the private file cannot load a row the seed would then fail to copy.
--   2. No foreign keys on user_id or client_id, like 254's phone tables. A person removed from
--      the team keeps their rows, unreadable (the Worker answers only a caller on the team), and
--      finds their list again if they are added back.
--   3. The seed appends after anything the person already has, in the set's own order
--      (sort_order, then name), so someone who added their own before the set existed keeps
--      theirs at the top.
--   4. updated_at moves only when name, body, category or sort_order is written (a column-list
--      trigger), so counting an Insert does not make a quick send look edited.
--   5. The 100-per-person cap is phone_add_quick_send's. It counts, numbers and inserts under a
--      per-person advisory lock, so a burst of adds at once queues and still stops at 100 (a
--      count in the Worker and a separate insert let N parallel adds land N past it). It is not
--      a constraint: the starter set may take someone who already had 100 a little past it, and
--      that is fine.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. Three new tables nothing reads yet, and three new
-- functions nothing calls until the Worker ships its /quick-sends routes. No existing table,
-- function or grant is touched. Apply this BEFORE deploying a Worker with /quick-sends, or every
-- list read there fails.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Deploy the Worker without /quick-sends first. Everyone's quick sends go with the table:
--   begin;
--   drop function if exists public.phone_add_quick_send(uuid, text, text, text, text);
--   drop function if exists public.phone_quick_send_used(uuid, uuid, text);
--   drop function if exists public.phone_seed_quick_sends(uuid, text);
--   drop table if exists public.phone_quick_send_seeded;
--   drop table if exists public.phone_quick_send_defaults;
--   drop table if exists public.phone_quick_sends;
--   delete from supabase_migrations.schema_migrations where version = '258';
--   commit;
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the tables
-- ═════════════════════════════════════════════════════════════════════════════════════════

-- ── phone_quick_sends: each person's list ───────────────────────────────────────────────
create table if not exists public.phone_quick_sends (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  user_id     uuid not null,
  name        text not null,
  body        text not null,
  category    text,
  sort_order  integer not null default 0,
  usage_count integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint phone_quick_sends_name_chk     check (name ~ '\S' and char_length(name) <= 60),
  constraint phone_quick_sends_body_chk     check (body ~ '\S' and char_length(body) <= 1600),
  constraint phone_quick_sends_category_chk check (category is null or (category ~ '\S' and char_length(category) <= 30)),
  constraint phone_quick_sends_usage_chk    check (usage_count >= 0)
);

-- The only read: one person's list on one team, in order.
create index if not exists phone_quick_sends_owner_idx
  on public.phone_quick_sends (user_id, client_id, sort_order);

-- Column-list trigger (choice 4): phone_quick_send_used writes usage_count only, so it never fires.
drop trigger if exists phone_quick_sends_set_updated_at on public.phone_quick_sends;
create trigger phone_quick_sends_set_updated_at
  before update of name, body, category, sort_order on public.phone_quick_sends
  for each row execute function public.set_updated_at();

comment on table public.phone_quick_sends is
  'My Synergy Phone (migration 258): each person''s quick sends, saved messages they insert into the text box instead of typing (never sent by themselves). Owned by (user_id, client_id); the phone-api Worker narrows every read and write to the caller''s pair. Fill-ins in body: {first_name}, {last_name}, {my_name}. usage_count counts Inserts, not sends.';

-- ── phone_quick_send_defaults: the starter set ──────────────────────────────────────────
-- EMPTY in this file. Filled by hand from the private phone repo (see the header).
create table if not exists public.phone_quick_send_defaults (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  body       text not null,
  category   text,
  sort_order integer not null default 0,
  constraint phone_quick_send_defaults_name_chk     check (name ~ '\S' and char_length(name) <= 60),
  constraint phone_quick_send_defaults_body_chk     check (body ~ '\S' and char_length(body) <= 1600),
  constraint phone_quick_send_defaults_category_chk check (category is null or (category ~ '\S' and char_length(category) <= 30))
);

comment on table public.phone_quick_send_defaults is
  'My Synergy Phone (migration 258): the starter quick sends every person is given once (phone_seed_quick_sends). Empty in the public repo; filled by hand from the private phone repo''s docs/sql/quick_send_defaults.sql. Replace the whole set in one transaction; a change reaches only people not seeded yet.';

-- ── phone_quick_send_seeded: the once-only marker ───────────────────────────────────────
create table if not exists public.phone_quick_send_seeded (
  user_id   uuid not null,
  client_id text not null,
  seeded_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

comment on table public.phone_quick_send_seeded is
  'My Synergy Phone (migration 258): one row per (user_id, client_id) that has been given the starter quick sends. phone_seed_quick_sends claims it before copying, so the set is copied once ever, even if every quick send is later deleted.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — RLS on, zero policies, and the PUBLIC grant revoked — 254's posture
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.phone_quick_sends         enable row level security;
alter table public.phone_quick_send_defaults enable row level security;
alter table public.phone_quick_send_seeded   enable row level security;

revoke all on public.phone_quick_sends         from public;
revoke all on public.phone_quick_send_defaults from public;
revoke all on public.phone_quick_send_seeded   from public;
revoke all on public.phone_quick_sends         from anon, authenticated;
revoke all on public.phone_quick_send_defaults from anon, authenticated;
revoke all on public.phone_quick_send_seeded   from anon, authenticated;

grant select, insert, update, delete on public.phone_quick_sends         to service_role;
grant select, insert, update, delete on public.phone_quick_send_defaults to service_role;
grant select, insert, update, delete on public.phone_quick_send_seeded   to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — the Worker's three RPCs. service_role only.
-- ═════════════════════════════════════════════════════════════════════════════════════════

-- ── phone_seed_quick_sends: the starter set, once ever per person and team ──────────────
-- Called by GET /quick-sends before it reads the list. Returns how many quick sends it added:
-- 0 while the set is empty (the marker stays unclaimed), 0 once seeded, else the set's size.
create or replace function public.phone_seed_quick_sends(p_user uuid, p_client text)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_claimed uuid;
  v_base    integer;
  v_n       integer;
begin
  if p_user is null or p_client is null or p_client = '' then
    return 0;
  end if;
  -- Nothing to give yet. Leave the marker alone, so the set still arrives once it is filled.
  if not exists (select 1 from public.phone_quick_send_defaults) then
    return 0;
  end if;

  -- The claim, in one statement. A second caller waits on this key, then conflicts.
  insert into public.phone_quick_send_seeded (user_id, client_id)
  values (p_user, p_client)
  on conflict do nothing
  returning user_id into v_claimed;
  if v_claimed is null then
    return 0;
  end if;

  -- After anything they already have (choice 3).
  select coalesce(max(q.sort_order) + 1, 0) into v_base
    from public.phone_quick_sends q
   where q.user_id = p_user and q.client_id = p_client;

  insert into public.phone_quick_sends (client_id, user_id, name, body, category, sort_order)
  select p_client, p_user, d.name, d.body, d.category,
         v_base + (row_number() over (order by d.sort_order, d.name, d.id))::integer - 1
    from public.phone_quick_send_defaults d;
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

comment on function public.phone_seed_quick_sends(uuid, text) is
  'My Synergy Phone (migration 258): copies phone_quick_send_defaults into this person''s quick sends, once ever per (user, client). Claims phone_quick_send_seeded first (insert on conflict do nothing returning) and copies only if the claim succeeded. Does nothing, and claims nothing, while the defaults are empty. Returns the number of quick sends added. service_role only.';

revoke execute on function public.phone_seed_quick_sends(uuid, text) from public, anon, authenticated;
grant  execute on function public.phone_seed_quick_sends(uuid, text) to service_role;

-- ── phone_quick_send_used: "used N×" ────────────────────────────────────────────────────
-- One atomic increment on the caller's own row: two Inserts at once both count. True when it
-- counted; false for an id that is not this person's on this team (the Worker answers
-- not_found).
create or replace function public.phone_quick_send_used(p_id uuid, p_user uuid, p_client text)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $fn$
  with bumped as (
    update public.phone_quick_sends q
       set usage_count = q.usage_count + 1
     where q.id = p_id
       and q.user_id = p_user
       and q.client_id = p_client
    returning q.id
  )
  select exists (select 1 from bumped);
$fn$;

comment on function public.phone_quick_send_used(uuid, uuid, text) is
  'My Synergy Phone (migration 258): usage_count + 1 on one quick send, only if it belongs to p_user on p_client. Returns whether it counted. Counts Inserts, not sends. service_role only.';

revoke execute on function public.phone_quick_send_used(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.phone_quick_send_used(uuid, uuid, text) to service_role;

-- ── phone_add_quick_send: add one, never past 100 ───────────────────────────────────────
-- Called by POST /quick-sends with a name, body and category the Worker has already trimmed and
-- checked; the table's own checks are the backstop. Count, next sort_order and insert all happen
-- under one lock per person and team, held until this transaction commits, so adds that arrive
-- together queue and the cap holds however many there are (choice 5). At 100 it raises
-- 'quick_send_cap', which the Worker turns into a sentence. Returns the new row.
create or replace function public.phone_add_quick_send(
  p_user uuid, p_client text, p_name text, p_body text, p_category text)
returns public.phone_quick_sends
language plpgsql
volatile
security invoker
set search_path = ''
as $fn$
declare
  v_count integer;
  v_next  integer;
  v_row   public.phone_quick_sends;
begin
  if p_user is null or p_client is null or p_client = '' then
    raise exception 'a person and a team are required' using errcode = 'null_value_not_allowed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('phone_quick_send:' || p_user::text || ':' || p_client));

  select count(*), coalesce(max(q.sort_order), -1) + 1 into v_count, v_next
    from public.phone_quick_sends q
   where q.user_id = p_user and q.client_id = p_client;
  if v_count >= 100 then
    raise exception 'quick_send_cap' using errcode = 'P0001';
  end if;

  insert into public.phone_quick_sends (client_id, user_id, name, body, category, sort_order)
  values (p_client, p_user, p_name, p_body, p_category, v_next)
  returning * into v_row;
  return v_row;
end
$fn$;

comment on function public.phone_add_quick_send(uuid, text, text, text, text) is
  'My Synergy Phone (migration 258): adds one quick send for p_user on p_client after their last, under a per-person advisory lock so parallel adds cannot pass the cap. Raises quick_send_cap (P0001) at 100. Returns the new row. service_role only.';

revoke execute on function public.phone_add_quick_send(uuid, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.phone_add_quick_send(uuid, text, text, text, text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — apply-time assertions. Each RAISE aborts the transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_tbl  text;
  v_role text;
  v_priv text;
  v_fn   text;
  v_con  text;
begin
  -- ── The grant posture. The trap is silent, so it is checked, not assumed. ──
  foreach v_tbl in array array['phone_quick_sends','phone_quick_send_defaults','phone_quick_send_seeded'] loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c
             where c.oid = ('public.' || v_tbl)::regclass) then
      raise exception '258: RLS is not enabled on %', v_tbl;
    end if;
    if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = ('public.' || v_tbl)::regclass) then
      raise exception '258: % has a policy; it is meant to be service-role only', v_tbl;
    end if;
    foreach v_role in array array['anon','authenticated'] loop
      foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE'] loop
        if has_table_privilege(v_role, 'public.' || v_tbl, v_priv) then
          raise exception '258: % holds % on % — the default-privilege trap is open', v_role, v_priv, v_tbl;
        end if;
      end loop;
    end loop;
    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('service_role', 'public.' || v_tbl, v_priv) then
        raise exception '258: service_role lacks % on % — the Worker could not use it', v_priv, v_tbl;
      end if;
    end loop;
  end loop;

  foreach v_fn in array array['public.phone_seed_quick_sends(uuid,text)',
                              'public.phone_quick_send_used(uuid,uuid,text)',
                              'public.phone_add_quick_send(uuid,text,text,text,text)'] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception '258: % is callable from the browser — revoke from PUBLIC as well as the named roles', v_fn;
    end if;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception '258: service_role cannot call %', v_fn;
    end if;
  end loop;
  if not (select p.prosecdef from pg_catalog.pg_proc p
           where p.oid = 'public.phone_seed_quick_sends(uuid,text)'::regprocedure) then
    raise exception '258: phone_seed_quick_sends must be SECURITY DEFINER (the plan)';
  end if;
  foreach v_fn in array array['public.phone_quick_send_used(uuid,uuid,text)',
                              'public.phone_add_quick_send(uuid,text,text,text,text)'] loop
    if (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure) then
      raise exception '258: % must be SECURITY INVOKER', v_fn;
    end if;
  end loop;

  -- ── The checks exist (PART 5 proves they refuse what they must) ──
  foreach v_con in array array['phone_quick_sends_name_chk','phone_quick_sends_body_chk',
                               'phone_quick_sends_category_chk','phone_quick_sends_usage_chk'] loop
    if not exists (select 1 from pg_catalog.pg_constraint
                    where conname = v_con and conrelid = 'public.phone_quick_sends'::regclass and contype = 'c') then
      raise exception '258: check constraint % is missing', v_con;
    end if;
  end loop;
  foreach v_con in array array['phone_quick_send_defaults_name_chk','phone_quick_send_defaults_body_chk',
                               'phone_quick_send_defaults_category_chk'] loop
    if not exists (select 1 from pg_catalog.pg_constraint
                    where conname = v_con and conrelid = 'public.phone_quick_send_defaults'::regclass and contype = 'c') then
      raise exception '258: check constraint % is missing', v_con;
    end if;
  end loop;

  -- ── updated_at's trigger is the column-list one (choice 4), and enabled ──
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgname = 'phone_quick_sends_set_updated_at'
                    and t.tgrelid = 'public.phone_quick_sends'::regclass
                    and not t.tgisinternal and t.tgenabled = 'O'
                    and position('BEFORE UPDATE OF ' in pg_catalog.pg_get_triggerdef(t.oid)) > 0) then
    raise exception '258: phone_quick_sends_set_updated_at is missing, disabled, or fires on every update';
  end if;

  -- ── The RPCs answer nothing for nobody ──
  if public.phone_seed_quick_sends(null, 'x') <> 0 or public.phone_seed_quick_sends(gen_random_uuid(), '') <> 0 then
    raise exception '258: phone_seed_quick_sends seeded for nobody';
  end if;
  if public.phone_quick_send_used(gen_random_uuid(), gen_random_uuid(), 'x') then
    raise exception '258: phone_quick_send_used counted a use on a quick send that does not exist';
  end if;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 — behavioural probe. Synthetic people, rolled back, leaves nothing.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 254's pattern: exercise what matters, then raise ROLLBACK_PROBE so every write in the inner
-- block vanishes. The people are fresh uuids and the team ids are obviously fake. If the starter
-- set has already been filled (a re-apply), the probe empties it INSIDE the rolled-back block,
-- so the real set is untouched.
do $probe$
declare
  k_cid     constant text := '__258_probe__';
  u1        uuid := gen_random_uuid();
  u2        uuid := gen_random_uuid();
  u3        uuid := gen_random_uuid();
  v_n       integer;
  v_row     public.phone_quick_sends;
  v_id      uuid;
  v_names   text[];
  v_refused boolean;
  v_name    text;
  v_body    text;
  v_cat     text;
begin
  begin
    -- ── 1. No starter set: nothing copied, and the marker NOT claimed ──
    delete from public.phone_quick_send_defaults where true;
    if public.phone_seed_quick_sends(u1, k_cid) <> 0 then
      raise exception '258 probe: seeded from an empty starter set';
    end if;
    if exists (select 1 from public.phone_quick_send_seeded s where s.user_id = u1) then
      raise exception '258 probe: an empty starter set claimed the marker, so the set would never arrive';
    end if;

    -- ── 2. They add their own first; then the set is filled ──
    insert into public.phone_quick_sends (client_id, user_id, name, body, sort_order)
    values (k_cid, u1, 'Probe mine', 'Probe body', 0);
    insert into public.phone_quick_send_defaults (name, body, category, sort_order)
    values ('Probe two', 'Probe {first_name} two', 'Probe', 2),
           ('Probe one', 'Probe {first_name} one', null, 1);

    -- ── 3. The next open copies it, after their own, in the set's order ──
    v_n := public.phone_seed_quick_sends(u1, k_cid);
    if v_n is distinct from 2 then
      raise exception '258 probe: the seed added % quick sends, not 2', v_n;
    end if;
    select array_agg(q.name order by q.sort_order) into v_names
      from public.phone_quick_sends q where q.user_id = u1 and q.client_id = k_cid;
    if v_names is distinct from array['Probe mine','Probe one','Probe two'] then
      raise exception '258 probe: seeded in the wrong place or order: %', v_names;
    end if;
    if not exists (select 1 from public.phone_quick_send_seeded s where s.user_id = u1 and s.client_id = k_cid) then
      raise exception '258 probe: the seed copied without claiming the marker';
    end if;

    -- ── 4. Once, ever: a second open, and after deleting everything ──
    if public.phone_seed_quick_sends(u1, k_cid) <> 0 then
      raise exception '258 probe: seeded twice';
    end if;
    delete from public.phone_quick_sends q where q.user_id = u1 and q.client_id = k_cid;
    if public.phone_seed_quick_sends(u1, k_cid) <> 0 then
      raise exception '258 probe: deleting every quick send brought the starter set back';
    end if;

    -- ── 5. Another person, and the same person on another team, each get their own ──
    if public.phone_seed_quick_sends(u2, k_cid) <> 2 then
      raise exception '258 probe: a second person was not seeded';
    end if;
    if public.phone_seed_quick_sends(u1, k_cid || '-2') <> 2 then
      raise exception '258 probe: the same person on another team was not seeded';
    end if;

    -- ── 6. "Used" counts on the caller's own row only ──
    select q.id into v_id from public.phone_quick_sends q
     where q.user_id = u2 and q.client_id = k_cid order by q.sort_order limit 1;
    if not public.phone_quick_send_used(v_id, u2, k_cid) then
      raise exception '258 probe: a use on their own quick send did not count';
    end if;
    if public.phone_quick_send_used(v_id, u1, k_cid) then
      raise exception '258 probe: someone else counted a use on this quick send';
    end if;
    if public.phone_quick_send_used(v_id, u2, k_cid || '-2') then
      raise exception '258 probe: a use counted from another team';
    end if;
    if (select q.usage_count from public.phone_quick_sends q where q.id = v_id) <> 1 then
      raise exception '258 probe: usage_count is not 1 after one counted use';
    end if;

    -- ── 7. The checks refuse what they must, on both tables, and take the limits ──
    for v_name, v_body, v_cat in
      select * from (values
        ('',                'ok',               null::text),
        (E' \t\n',          'ok',               null),
        (repeat('n', 61),   'ok',               null),
        ('ok',              '',                 null),
        ('ok',              E'\n\n ',           null),
        ('ok',              repeat('b', 1601),  null),
        ('ok',              'ok',               ''),
        ('ok',              'ok',               '   '),
        ('ok',              'ok',               repeat('c', 31))
      ) as t(n, b, c)
    loop
      v_refused := false;
      begin
        insert into public.phone_quick_sends (client_id, user_id, name, body, category)
        values (k_cid, u1, v_name, v_body, v_cat);
      exception when check_violation then v_refused := true;
      end;
      if not v_refused then
        raise exception '258 probe: phone_quick_sends took name of % chars, body of % chars, category %',
          char_length(v_name), char_length(v_body), coalesce('of ' || char_length(v_cat) || ' chars', 'null');
      end if;
      v_refused := false;
      begin
        insert into public.phone_quick_send_defaults (name, body, category)
        values (v_name, v_body, v_cat);
      exception when check_violation then v_refused := true;
      end;
      if not v_refused then
        raise exception '258 probe: phone_quick_send_defaults took name of % chars, body of % chars, category %',
          char_length(v_name), char_length(v_body), coalesce('of ' || char_length(v_cat) || ' chars', 'null');
      end if;
    end loop;
    v_refused := false;
    begin
      update public.phone_quick_sends set usage_count = -1 where id = v_id;
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '258 probe: usage_count went below 0'; end if;
    -- The limits themselves fit, counted as characters: 60 two-byte letters are a 60-character name.
    insert into public.phone_quick_sends (client_id, user_id, name, body, category)
    values (k_cid, u1, repeat('é', 60), repeat('b', 1600), repeat('c', 30));
    insert into public.phone_quick_send_defaults (name, body, category)
    values (repeat('é', 60), repeat('b', 1600), repeat('c', 30));

    -- ── 8. Adding one: theirs, after the last, and refused at 100 ──
    v_row := public.phone_add_quick_send(u3, k_cid, 'Probe added', 'Probe body', null);
    if v_row.user_id is distinct from u3 or v_row.client_id is distinct from k_cid or v_row.sort_order <> 0 then
      raise exception '258 probe: the first add was not theirs at sort_order 0: %', v_row;
    end if;
    -- 98 more with a gap in sort_order, so "after the last" and "after as many as there are" differ.
    insert into public.phone_quick_sends (client_id, user_id, name, body, sort_order)
    select k_cid, u3, 'Probe ' || g, 'Probe body', 10 + g from generate_series(1, 98) g;
    v_row := public.phone_add_quick_send(u3, k_cid, 'Probe hundredth', 'Probe body', 'Probe');
    if v_row.sort_order <> 109 then
      raise exception '258 probe: the 100th went to sort_order %, not 109 (after the last)', v_row.sort_order;
    end if;
    v_refused := false;
    begin
      perform public.phone_add_quick_send(u3, k_cid, 'Probe one too many', 'Probe body', null);
    exception when raise_exception then
      if sqlerrm <> 'quick_send_cap' then raise; end if;
      v_refused := true;
    end;
    if not v_refused then
      raise exception '258 probe: an add past 100 was taken';
    end if;
    if (select count(*) from public.phone_quick_sends q where q.user_id = u3 and q.client_id = k_cid) <> 100 then
      raise exception '258 probe: a refused add left a row';
    end if;
    -- Their 100 hold back no one else on the team, and not themselves on another team.
    perform public.phone_add_quick_send(u2, k_cid, 'Probe theirs', 'Probe body', null);
    perform public.phone_add_quick_send(u3, k_cid || '-2', 'Probe other team', 'Probe body', null);
    v_refused := false;
    begin
      perform public.phone_add_quick_send(u2, k_cid, ' ', 'Probe body', null);
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '258 probe: phone_add_quick_send took a blank name'; end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '258 probe: seeded once (not while empty, not twice, not after deleting all), per person and team; used counts own rows only; the checks hold; adds stop at 100; nothing was kept';
      else
        raise;
      end if;
  end;

  if exists (select 1 from public.phone_quick_sends q where q.client_id like '\_\_258\_probe\_\_%')
     or exists (select 1 from public.phone_quick_send_seeded s where s.client_id like '\_\_258\_probe\_\_%') then
    raise exception '258 probe: synthetic rows were left behind';
  end if;
end
$probe$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. Fill the starter set from the private phone repo (docs/sql/quick_send_defaults.sql), then:
--      select count(*) from public.phone_quick_send_defaults;          -- the set's size
-- B. Nobody has been seeded before the Worker ships:
--      select count(*) from public.phone_quick_send_seeded;            -- 0
-- C. After someone opens Quick sends in the app:
--      select user_id, client_id, seeded_at from public.phone_quick_send_seeded order by seeded_at desc limit 5;
