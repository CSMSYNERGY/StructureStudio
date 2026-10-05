-- 266_phone_numbers.sql — My Synergy Phone with more than one number: each number gets a name and
--                         can belong to one person, and a person with their own number calls out
--                         from it.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations with `returning`. NEVER `supabase db push`. The file
--    carries its own begin;/commit; so every assertion below takes the whole migration with it if
--    it fails.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-09-30 (Fathom 188300043, 11:02): "Are the numbers assigned to the individual
-- person?" At 11:56, on the Phone tab: "We only have one phone number in here... What if they want
-- more than one number?" Ahsan (13:22): add more numbers "and they can assign numbers to
-- particular" people. Carolyn (13:28): "all of these settings that you have here needs to be for
-- that individual number."
--
-- The settings already were per number: phone_routes has one row per sms_numbers row (254), and
-- every inbound call and text is resolved by the number dialled (phone_route_for_number,
-- sms-inbound). What was single-number is the app around them (one number per tenant at purchase,
-- the Phone tab showing the oldest, every outbound call and text from one number). This file adds
-- the two facts the app needs and nothing else:
--   * a NAME for each number ("Sales line", "Mike's cell"), so the Phone tab can tell them apart;
--   * WHOSE number it is: NULL = a team line (today's meaning of every number), else the one person
--     it belongs to. Their calls out show that number, and the Phone tab rings them on it by
--     default. One personal number per person.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   sms_numbers.label (1 to 40 characters, or NULL) and sms_numbers.assigned_user_id
--            (NULL = a team line)
--   PART 2   sms_numbers_one_per_person: a partial unique index, one LIVE number per person
--   PART 3   phone_caller_context re-issued (263's text): the person's own number first, then a
--            team line, and `numbers`, every live number of the business
--   PART 3b  phone_route_for_number re-issued (264's text): `number_owner`, the person the dialled
--            number belongs to, so their own voicemail greeting plays on it
--   PART 4   apply-time assertions (they RAISE and abort the transaction)
--   PART 5   a behavioural probe, rolled back, leaving nothing
--   after commit: recording the row, verification, as comments
--
-- phone_routes is unchanged: an inbound call already rings whoever the dialled number's own route
-- names, and a number given to someone starts out ringing just them (portal-settings).
--
-- ── NUMBERING AND ORDER ──────────────────────────────────────────────────────────────────
-- AFTER 263 AND 264, never before: this re-issues 263's phone_caller_context (its recording
-- columns; a `language sql` body is checked at the create, so ahead of 263 it fails there) and
-- 264's phone_route_for_number (its away-rule columns; PART 4 checks they exist and PART 5 calls
-- it, so ahead of 264 the apply aborts). Applied ahead of 264, a later 264 would also put back a
-- copy of phone_route_for_number without number_owner. It does not depend on 265 (QuickBooks
-- realm). Several Part C items claimed numbers at once; this is the batch-3 file. Before applying,
-- read the live ledger:
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 4;
-- It must show 263 and 264 and must not already show 266. If something else re-issued
-- phone_caller_context after 263, or phone_route_for_number after 264, re-read the live body
-- (pg_get_functiondef) and carry the edits below onto it; do not apply this copy over a newer one.
--
-- ── RE-ISSUED BODY ───────────────────────────────────────────────────────────────────────
-- phone_caller_context is 263 PART 6's text, verbatim, with these edits and nothing else:
--   * the `number` pick is ordered
--       1. the person's OWN number (assigned_user_id = them),
--       2. then a team line (assigned_user_id NULL), so nobody calls out from a teammate's own
--          number while a team line exists,
--       3. then 263's rule: the number texting sends from (client_settings.sms_number),
--       4. then the OLDEST live number (263 said newest; see CHOICES 4).
--     The first key is coalesced to false: `x = y` is NULL for a team line, and Postgres sorts
--     NULL FIRST under DESC, which would put every team line ahead of the person's own number.
--   * 'numbers': the business's live numbers as E.164 strings, oldest first. The apps compare a
--     ringing call's From against this list (a warm transfer rings From a business number, and
--     with more than one number it can be any of them).
-- Every key 263 returned is still returned, with the same meaning for a business with one number.
-- 263's self-check string ('recording') is still in it, and PART 4 checks it again.
--
-- phone_route_for_number is 264 PART 2's text, verbatim, with one edit: a top-level
-- 'number_owner', {user_id, greeting_sid, has_access} for a number that is someone's own (has_access
-- read on the NUMBER's tenant, exactly as every member's is), NULL for a team line. The Worker
-- plays that person's own greeting on the number's voicemail (voicemail.ts lineOwner), whoever the
-- answer list names; 264 could only guess a line's owner from an answer list of exactly one. The
-- members, the covers, the recording block and every 263/264 rule are untouched, and PART 4
-- checks their self-check strings again.
--
-- ── CHOICES ──────────────────────────────────────────────────────────────────────────────
--   1. Numbers are team lines unless assigned. Every number live today stays a team line (both
--      columns NULL), so nothing about calls, texts or caller ID changes when this is applied.
--   2. One personal number per person, among LIVE numbers (a released number keeps its history
--      and its old owner, and counts for nothing). Enforced here, not only in the app: two
--      owners assigning at once both pass a read-then-write check.
--   3. No foreign key on assigned_user_id, like phone_user_settings (254): the row outlives the
--      person. A number whose person left the team is shown as such on the Phone tab and is
--      nobody's caller ID until it is reassigned (it ranks last, after the team lines).
--   4. The fallback is the OLDEST live number, where 263 took the newest. The two agree for every
--      business today (each has at most one live number; read-only check 2026-10-05), and the
--      Phone tab has always called the oldest number "your number" (its read is purchased_at
--      ascending), so a person with no number of their own now calls out from the same number the
--      Phone tab calls the main one.
--   5. Labels are trimmed and checked by portal-settings; this file only keeps them 1 to 40
--      characters, so an empty string can never stand in for "no name".
--   6. Who may assign: the business's phone editors, in portal-settings (phone_settings_save). The
--      assignee must have phone access on the same business; the database does not repeat that
--      (it has no tenant-scoped key to check it against), and phone_caller_context only ever
--      matches the signed-in person against numbers of their own business.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. Two nullable columns with no default (no table
-- rewrite), CHECKs every existing row passes (all NULL), and a unique index over no rows yet. The
-- RPC returns one more top-level key, which the live Worker ignores, and the same `number` for
-- every business with one live number (all of them on 2026-10-05). phone_route_for_number answers
-- one more key, number_owner, NULL for every number until someone is given one; the live Worker
-- ignores it. The live portal-settings and portal-sms never read the new columns. The apply waits
-- at most 5 s for a lock, so it gives up rather than hold calls behind it; retry it.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Roll the code back first (portal-settings, then the phone-api Worker): both read the columns.
--   begin;
--   -- Re-run 263 PART 6's phone_caller_context and 264 PART 2's phone_route_for_number (each one's
--   -- create, comment, revoke and grant) FIRST: this file's copies name assigned_user_id, and every
--   -- /token and every inbound call would fail once it is dropped.
--   drop index if exists public.sms_numbers_one_per_person;
--   alter table public.sms_numbers
--     drop constraint if exists sms_numbers_label_len,
--     drop column if exists label,
--     drop column if exists assigned_user_id;
--   delete from supabase_migrations.schema_migrations where version = '266';
--   notify pgrst, 'reload schema';
--   commit;
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — a name and an owner for each number
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.sms_numbers
  add column if not exists label            text,
  add column if not exists assigned_user_id uuid;

-- NOT VALID then VALIDATE (261's pattern; every existing row is NULL, so the validation is a scan
-- that cannot fail). A re-apply passes straight through.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'sms_numbers_label_len'
                    and conrelid = 'public.sms_numbers'::regclass) then
    alter table public.sms_numbers
      add constraint sms_numbers_label_len
      check (label is null or char_length(label) between 1 and 40) not valid;
  end if;
end
$$;
alter table public.sms_numbers validate constraint sms_numbers_label_len;

comment on column public.sms_numbers.label is
  'SSS Phone (migration 266): the name the business gave this number ("Sales line"), 1 to 40 characters, or NULL for none (the Phone tab then says "Main number" / "Number 2"). Set by a phone editor on the Phone tab (portal-settings phone_settings_save).';
comment on column public.sms_numbers.assigned_user_id is
  'SSS Phone (migration 266): whose number this is. NULL = a team line (every number before 266). Else the one person it belongs to (client_users.user_id on this business): their calls out show it (phone_caller_context picks it first) and its answer list starts as just them. One live number per person (sms_numbers_one_per_person). No FK: the row outlives the person. Set by a phone editor on the Phone tab.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — one live number per person
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Partial, like sms_numbers_live_unique (165): a released number keeps its old owner and counts
-- for nothing. Not CONCURRENTLY: this runs inside the file's transaction, and the index covers no
-- row yet.
create unique index if not exists sms_numbers_one_per_person
  on public.sms_numbers (client_id, assigned_user_id)
  where released_at is null and assigned_user_id is not null;

comment on index public.sms_numbers_one_per_person is
  'SSS Phone (migration 266): one live number per person per business. portal-settings answers a 23505 here with "That person already has their own number."';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — phone_caller_context: your own number first, and every number of the business
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 263 PART 6's text with the edits the header lists (each marked "266").

-- ── phone_caller_context: who is this signed-in person, for /token and /voice/outbound ──
create or replace function public.phone_caller_context(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object(
           'client_id',         cu.client_id,
           'phone_status',      coalesce(cs.phone_status, 'off'),
           'phone_level',       public.area_level_for(cu.role, cu.title, cu.access, 'phone'),
           'contacts_level',    public.area_level_for(cu.role, cu.title, cu.access, 'contacts'),
           'own_contacts_only', public.area_level_for(cu.role, cu.title, cu.access, 'contacts') = 'own',
           'device_generation', coalesce(s.device_generation, 1),
           'number',            (select jsonb_build_object(
                                          'id',                  n.id,
                                          'e164',                n.phone_number,
                                          'voice_enabled',       n.voice_enabled,
                                          'registration_status', n.registration_status)
                                   from public.sms_numbers n
                                  where n.client_id = cu.client_id
                                    and n.released_at is null
                                  -- 266: their own number, then a team line, then 263's rule.
                                  order by coalesce(n.assigned_user_id = cu.user_id, false) desc,
                                           (n.assigned_user_id is null) desc,
                                           (n.phone_number = cs.sms_number) desc nulls last,
                                           n.purchased_at asc, n.id
                                  limit 1),
           -- 266: every live number of the business, oldest first.
           'numbers',           coalesce((select jsonb_agg(n.phone_number order by n.purchased_at, n.id)
                                            from public.sms_numbers n
                                           where n.client_id = cu.client_id
                                             and n.released_at is null), '[]'::jsonb),
           'full_name',         cu.full_name,
           'recording',         jsonb_build_object(
                                  'on',          coalesce(cs.phone_record_calls, false),
                                  'notice',      coalesce(cs.phone_recording_notice, true),
                                  'notice_text', cs.phone_recording_notice_text,
                                  'transcribe',  coalesce(cs.phone_transcribe_calls, true))
         )
    from public.client_users cu
    left join public.client_settings cs on cs.client_id = cu.client_id
    left join public.phone_user_settings s on s.user_id = cu.user_id
   where cu.user_id = p_user_id
   limit 1;
$fn$;

comment on function public.phone_caller_context(uuid) is
  'SSS Phone (migrations 254, 263, 266): one uncached read of a signed-in person for /token and every /voice/outbound: {client_id, phone_status, phone_level, contacts_level, own_contacts_only, device_generation, number, numbers, full_name, recording:{on, notice, notice_text, transcribe}}. number = the number their calls show: their own (sms_numbers.assigned_user_id), else a team line, preferring the texting number (client_settings.sms_number), else the oldest; someone else''s own number only when the business has nothing else. numbers = every live number of the business, E.164, oldest first. NULL when the user is on no team. service_role only.';

revoke execute on function public.phone_caller_context(uuid) from public, anon, authenticated;
grant  execute on function public.phone_caller_context(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3b — phone_route_for_number: whose number was dialled
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 264 PART 2's text with the one edit the header lists (marked "266").

-- ── phone_route_for_number: everything /voice/inbound needs, in one call ────────────────
create or replace function public.phone_route_for_number(p_e164 text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_num       public.sms_numbers%rowtype;
  v_route     public.phone_routes%rowtype;
  v_has_route boolean;
  v_status    text;
  v_business  text;
  v_members   jsonb;
  v_emergency uuid;
  -- 263: the business's recording settings.
  v_rec_on     boolean;
  v_rec_notice boolean;
  v_rec_text   text;
  v_rec_trans  boolean;
  -- 266: the number's own person (sms_numbers.assigned_user_id), NULL for a team line.
  v_owner      jsonb;
begin
  -- The live number. sms_numbers_live_unique (165) makes this at most one row.
  select n.* into v_num
    from public.sms_numbers n
   where n.phone_number = p_e164
     and n.released_at is null
   limit 1;
  if not found then
    return null;
  end if;

  select cs.phone_status, cs.business_name,
         cs.phone_record_calls, cs.phone_recording_notice, cs.phone_recording_notice_text, cs.phone_transcribe_calls
    into v_status, v_business,
         v_rec_on, v_rec_notice, v_rec_text, v_rec_trans
    from public.client_settings cs
   where cs.client_id = v_num.client_id;

  -- A route filed under a different tenant than the number's owner is ignored rather than
  -- believed: ringing another builder's staff is the one thing this must never do.
  select r.* into v_route
    from public.phone_routes r
   where r.number_id = v_num.id
     and r.client_id = v_num.client_id;
  v_has_route := found;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id',         m.user_id,
           'identity',        'u_' || replace(m.user_id::text, '-', '') || '_g'
                                   || coalesce(s.device_generation, 1)::text,
           'dnd',             coalesce(s.dnd, false)
                                and (s.dnd_until is null or s.dnd_until > now()),
           'busy',            exists (
                                select 1 from public.phone_calls c
                                 where c.status in ('ringing', 'in_progress')
                                   and c.answered_by = m.user_id
                                   and c.started_at > now() - case when c.status = 'ringing'
                                                                   then interval '10 minutes'
                                                                   else interval '4 hours' end)
                              or exists (
                                -- DEVIATION 10: the person who placed a call stops being on
                                -- it the moment they hand it on. A transfer writes
                                -- transferred_from, so a placed call counts only while that
                                -- is still NULL (the Worker's own rule in routes/calls.ts,
                                -- `!call.transferred_from`). Stricter than "is distinct from
                                -- this person": a second hop moves transferred_from to the
                                -- teammate, and the placer must not turn busy again.
                                select 1 from public.phone_calls c
                                 where c.status in ('ringing', 'in_progress')
                                   and c.placed_by = m.user_id
                                   and c.transferred_from is null
                                   and c.started_at > now() - case when c.status = 'ringing'
                                                                   then interval '10 minutes'
                                                                   else interval '4 hours' end)
                              or exists (
                                -- DEVIATION 13: the Worker's THIRD clause (conference.ts
                                -- onTheCall). During a warm transfer the call sits in its
                                -- conference (transfer_state = 'conference') with answered_by
                                -- moved to the teammate and transferred_from = the person who
                                -- handed it on, who may still be in the room consulting. They
                                -- are on the call until the conference ends, so a new inbound
                                -- call must not ring them in the middle of it.
                                select 1 from public.phone_calls c
                                 where c.status in ('ringing', 'in_progress')
                                   and c.transfer_state = 'conference'
                                   and c.transferred_from = m.user_id
                                   and c.started_at > now() - case when c.status = 'ringing'
                                                                   then interval '10 minutes'
                                                                   else interval '4 hours' end),
           'has_access',      cu.user_id is not null
                                and public.area_level_for(cu.role, cu.title, cu.access, 'phone') <> 'none',
           'full_name',       cu.full_name,
           'forward_to_cell', s.forward_to_cell,
           -- 264: who this person's calls ring while they're away, and whether this row is here
           -- only as someone's cover (not on the answer list: the Worker never rings it alone).
           'dnd_cover',       s.dnd_cover_user_id,
           'cover_only',      m.cover_only,
           -- 264: the hours this person's phone rings (NULL = always) and the zone they're in
           -- (NULL = the number's). The Worker decides; a cover's are read like a member's.
           'ring_hours',      s.ring_hours,
           'hours_tz',        s.ring_hours_tz,
           -- 264: the person's own voicemail greeting (a Twilio recording sid), or NULL. The
           -- Worker plays it on a line that is only theirs (voicemail.ts lineOwner).
           'greeting_sid',    s.greeting_recording_sid
         ) order by m.cover_only, m.ord), '[]'::jsonb)
    into v_members
    from (
      -- First position wins for a repeated id; NULLs are skipped (the CHECK forbids them, but
      -- this is the read the call path depends on).
      select u.user_id, min(u.ord) as ord, false as cover_only
        from unnest(case when v_has_route then v_route.members else '{}'::uuid[] end)
             with ordinality as u(user_id, ord)
       where u.user_id is not null
       group by u.user_id
      union all
      -- 264: the cover each member chose (dnd_cover_user_id) who is not on the list, once,
      -- placed by the first member who chose them. One level only: a cover's own cover is
      -- not read. Built by the same joins below as a member, so has_access is checked against
      -- the number's tenant.
      select cs.dnd_cover_user_id, min(cm.ord), true
        from unnest(case when v_has_route then v_route.members else '{}'::uuid[] end)
             with ordinality as cm(user_id, ord)
        join public.phone_user_settings cs on cs.user_id = cm.user_id
       where cm.user_id is not null
         and cs.dnd_cover_user_id is not null
         and array_position(v_route.members, cs.dnd_cover_user_id) is null
       group by cs.dnd_cover_user_id
    ) m
    left join public.phone_user_settings s on s.user_id = m.user_id
    left join public.client_users cu
           on cu.user_id = m.user_id
          and cu.client_id = v_num.client_id;

  -- The dispatcher's callback (plan §14): within 60 minutes of a 911 call from this number,
  -- the Worker rings only the person who dialed it, ignoring DND and busy.
  select c.placed_by into v_emergency
    from public.phone_calls c
   where c.number_id = v_num.id
     and c.is_emergency
     and c.direction = 'out'
     and c.placed_by is not null
     and c.started_at > now() - interval '60 minutes'
   order by c.started_at desc
   limit 1;

  -- 266: whose number this is, for their voicemail greeting (the Worker's voicemail.ts), whoever
  -- the answer list names. Access is read on the NUMBER's tenant, like every member's: a person
  -- who left the business, or lost phone access, reads has_access false and is nobody's line.
  if v_num.assigned_user_id is not null then
    select jsonb_build_object(
             'user_id',      v_num.assigned_user_id,
             'greeting_sid', s.greeting_recording_sid,
             'has_access',   cu.user_id is not null
                               and public.area_level_for(cu.role, cu.title, cu.access, 'phone') <> 'none')
      into v_owner
      from (select 1) one
      left join public.phone_user_settings s on s.user_id = v_num.assigned_user_id
      left join public.client_users cu
             on cu.user_id = v_num.assigned_user_id
            and cu.client_id = v_num.client_id;
  end if;

  return jsonb_build_object(
    'client_id',             v_num.client_id,
    'number_id',             v_num.id,
    'phone_status',          coalesce(v_status, 'off'),
    'route',                 case when v_has_route then to_jsonb(v_route) end,
    'members',               v_members,
    'business_name',         v_business,
    'recent_emergency_user', v_emergency,
    'number_owner',          v_owner,
    'recording',             jsonb_build_object(
                               'on',          coalesce(v_rec_on, false),
                               'notice',      coalesce(v_rec_notice, true),
                               'notice_text', v_rec_text,
                               'transcribe',  coalesce(v_rec_trans, true))
  );
end
$fn$;

comment on function public.phone_route_for_number(text) is
  'SSS Phone (migrations 254, 263, 264, 266): the one database call behind /voice/inbound. Returns {client_id, number_id, phone_status, route, members:[{user_id, identity, dnd, busy, has_access, full_name, forward_to_cell, dnd_cover, cover_only, ring_hours, hours_tz, greeting_sid}], business_name, recent_emergency_user, number_owner:{user_id, greeting_sid, has_access}|null, recording:{on, notice, notice_text, transcribe}} for a live number, NULL otherwise. number_owner = the person the number belongs to (sms_numbers.assigned_user_id, 266), NULL for a team line: their own greeting plays on its voicemail. members = the route''s members in order (cover_only false), then once each the covers they chose who are not members (cover_only true: rung only in an away member''s place, never alone). ring_hours/hours_tz = the person''s own hours (NULL = always); outside them the Worker treats them as away. greeting_sid = the person''s own voicemail greeting (a Twilio recording sid), or NULL. Uncached by design. service_role only.';

revoke execute on function public.phone_route_for_number(text) from public, anon, authenticated;
grant  execute on function public.phone_route_for_number(text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — apply-time assertions. Each RAISE aborts the transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_type text;
  v_null boolean;
  v_def  text;
  v_role text;
  v_priv text;
  v_col  text;
  v_src  text;
  v_idx  text;
  v_fn   constant text := 'public.phone_caller_context(uuid)';
  v_rfn  constant text := 'public.phone_route_for_number(text)';
begin
  -- ── 264 first: the away-rule columns the re-issued phone_route_for_number reads ──
  if (select count(*) from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = 'phone_user_settings'
         and c.column_name in ('dnd_cover_user_id', 'ring_hours', 'ring_hours_tz', 'greeting_recording_sid')) <> 4 then
    raise exception '266: migration 264 is not applied (phone_user_settings has no away-rule columns); apply 264 first';
  end if;
  -- ── PART 1: two nullable columns with no default, and the label's check, validated ──
  foreach v_col in array array['label', 'assigned_user_id'] loop
    select c.data_type, c.is_nullable = 'YES', c.column_default
      into v_type, v_null, v_def
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'sms_numbers' and c.column_name = v_col;
    if v_type is distinct from (case v_col when 'label' then 'text' else 'uuid' end) or not v_null or v_def is not null then
      raise exception '266: sms_numbers.% is %, nullable %, default %', v_col, v_type, v_null, v_def;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'sms_numbers_label_len'
                    and conrelid = 'public.sms_numbers'::regclass
                    and contype = 'c' and convalidated) then
    raise exception '266: sms_numbers_label_len is missing or not validated';
  end if;
  -- Still the service role's alone: the browser roles can neither read nor write the new columns.
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      foreach v_col in array array['label', 'assigned_user_id'] loop
        if has_column_privilege(v_role, 'public.sms_numbers', v_col, v_priv) then
          raise exception '266: % can % sms_numbers.%', v_role, v_priv, v_col;
        end if;
      end loop;
    end loop;
  end loop;

  -- ── PART 2: the index is unique, on (client_id, assigned_user_id), live and assigned rows only ──
  select pg_catalog.pg_get_indexdef(i.indexrelid) into v_idx
    from pg_catalog.pg_index i
   where i.indexrelid = 'public.sms_numbers_one_per_person'::regclass
     and i.indisunique and i.indisvalid;
  if v_idx is null
     or position('(client_id, assigned_user_id)' in v_idx) = 0
     or position('released_at IS NULL' in v_idx) = 0
     or position('assigned_user_id IS NOT NULL' in v_idx) = 0 then
    raise exception '266: sms_numbers_one_per_person is missing or not the partial unique index it should be: %', v_idx;
  end if;

  -- ── PART 3: the RPC, the service role's alone, with its empty search_path ──
  if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception '266: % is callable from the browser', v_fn;
  end if;
  if exists (select 1 from pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where p.oid = v_fn::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception '266: % is still executable by PUBLIC', v_fn;
  end if;
  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception '266: service_role cannot call %', v_fn;
  end if;
  -- coalesce: a function with no SET at all has a NULL proconfig, and NOT NULL is not true.
  if not coalesce((select p.proconfig @> array['search_path=""'] from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure), false) then
    raise exception '266: % lost its empty search_path', v_fn;
  end if;
  -- 263's self-check (its recording block), and this file's own: the person's own number first,
  -- coalesced, then a team line, and the list of numbers.
  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure;
  if position('''recording''' in v_src) = 0 or position('cs.phone_record_calls' in v_src) = 0 then
    raise exception '266: phone_caller_context does not return recording any more (263)';
  end if;
  if position('coalesce(n.assigned_user_id = cu.user_id, false) desc' in v_src) = 0
     or position('(n.assigned_user_id is null) desc' in v_src) = 0
     or position('(n.phone_number = cs.sms_number) desc nulls last' in v_src) = 0 then
    raise exception '266: phone_caller_context does not pick the person''s own number, then a team line, then the texting number';
  end if;
  if position('''numbers''' in v_src) = 0 then
    raise exception '266: phone_caller_context does not return numbers';
  end if;

  -- ── PART 3b: the route RPC, the service role's alone, with its empty search_path ──
  if has_function_privilege('anon', v_rfn, 'EXECUTE') or has_function_privilege('authenticated', v_rfn, 'EXECUTE') then
    raise exception '266: % is callable from the browser', v_rfn;
  end if;
  if exists (select 1 from pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where p.oid = v_rfn::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception '266: % is still executable by PUBLIC', v_rfn;
  end if;
  if not has_function_privilege('service_role', v_rfn, 'EXECUTE') then
    raise exception '266: service_role cannot call %', v_rfn;
  end if;
  if not coalesce((select p.proconfig @> array['search_path=""'] from pg_catalog.pg_proc p where p.oid = v_rfn::regprocedure), false) then
    raise exception '266: % lost its empty search_path', v_rfn;
  end if;
  -- 263's and 264's self-checks (a token of each rule they kept), and this file's own.
  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = v_rfn::regprocedure;
  if position('''recording''' in v_src) = 0
     or position('recent_emergency_user' in v_src) = 0
     or position('transfer_state = ''conference''' in v_src) = 0 then
    raise exception '266: phone_route_for_number does not return recording, or lost a 254 rule';
  end if;
  if position('''dnd_cover''' in v_src) = 0
     or position('''cover_only''' in v_src) = 0
     or position('cs.dnd_cover_user_id' in v_src) = 0
     or position('''ring_hours'',      s.ring_hours' in v_src) = 0
     or position('''greeting_sid'',    s.greeting_recording_sid' in v_src) = 0 then
    raise exception '266: phone_route_for_number lost a 264 rule (covers, hours or greetings)';
  end if;
  if position('''number_owner''' in v_src) = 0
     or position('on cu.user_id = v_num.assigned_user_id
            and cu.client_id = v_num.client_id' in v_src) = 0 then
    raise exception '266: phone_route_for_number does not return number_owner, or reads its access off another tenant';
  end if;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 — behavioural probe. Rolled back, leaves nothing.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 254 PART 11's pattern: exercise what matters, then raise ROLLBACK_PROBE so the writes vanish.
-- phone_caller_context needs a real client_users row (its user_id is a login), so the probe
-- borrows the oldest one WITH NO LIVE NUMBER OF THEIR OWN: two synthetic numbers (obviously fake
-- 555-01xx) are added to THAT person's business inside this transaction, one of them theirs, read
-- back and rolled away with everything else. Nobody outside the transaction ever sees them.
-- ⚠️ Not simply the oldest: once that person is given a real number, one live number per person
-- (PART 2) refuses the probe's, and a re-apply would abort. The ordering between team lines and
-- the texting number needs businesses built for it, so that is tests/sql/migration266.test.cjs's,
-- not this probe's. With nobody to borrow (a fresh database, or everyone already has a number of
-- their own) the caller-context half is skipped, saying so. The route RPC is called on a synthetic business of its own (a number, a route, and a
-- person with no login), so it runs everywhere, and on a database before 264 it aborts the apply.
do $probe$
declare
  k_team   constant text := '+15555550196';
  k_own    constant text := '+15555550197';
  k_sid    constant text := 'RE' || repeat('0', 31) || '6';
  v_ghost  uuid := gen_random_uuid();  -- synthetic: no login, on no team
  v_route_own uuid;
  v_real   public.client_users%rowtype;
  v_team   uuid;
  v_own    uuid;
  v        jsonb;
  v_refused boolean;
begin
  select cu.* into v_real from public.client_users cu
   where not exists (select 1 from public.sms_numbers n
                      where n.assigned_user_id = cu.user_id and n.released_at is null)
   order by cu.created_at, cu.user_id limit 1;

  begin
    if v_real.user_id is not null then
      insert into public.sms_numbers (client_id, phone_number, registration_status, label)
      values (v_real.client_id, k_team, 'pending_registration', 'Probe team line')
      returning id into v_team;
      insert into public.sms_numbers (client_id, phone_number, registration_status, label, assigned_user_id)
      values (v_real.client_id, k_own, 'pending_registration', 'Probe own line', v_real.user_id)
      returning id into v_own;

      -- ── 1. Their own number is their caller ID, and both are in the list ──
      v := public.phone_caller_context(v_real.user_id);
      if v -> 'number' ->> 'id' is distinct from v_own::text or v -> 'number' ->> 'e164' is distinct from k_own then
        raise exception '266 probe: a person with their own number calls out from %', v -> 'number';
      end if;
      if jsonb_typeof(v -> 'numbers') <> 'array'
         or not (v -> 'numbers') @> jsonb_build_array(k_team, k_own) then
        raise exception '266 probe: numbers is %', v -> 'numbers';
      end if;
      if not (v ? 'recording') or not (v ? 'device_generation') or not (v ? 'full_name') then
        raise exception '266 probe: 263''s keys are gone: %', v;
      end if;

      -- ── 2. One live number per person ──
      v_refused := false;
      begin
        update public.sms_numbers set assigned_user_id = v_real.user_id where id = v_team;
      exception when unique_violation then v_refused := true;
      end;
      if not v_refused then raise exception '266 probe: one person was given two live numbers'; end if;

      -- ── 3. A released number counts for nothing: not theirs any more, not in the list ──
      update public.sms_numbers set released_at = now() where id = v_own;
      v := public.phone_caller_context(v_real.user_id);
      if v -> 'number' ->> 'id' = v_own::text or (v -> 'numbers') @> jsonb_build_array(k_own) then
        raise exception '266 probe: a released number is still used: %', v;
      end if;
      update public.sms_numbers set assigned_user_id = v_real.user_id where id = v_team;
      v := public.phone_caller_context(v_real.user_id);
      if v -> 'number' ->> 'id' is distinct from v_team::text then
        raise exception '266 probe: a number assigned after the old one was released is not theirs: %', v -> 'number';
      end if;
    else
      raise notice '266 probe: client_users has nobody without a live number of their own (or is empty), so the caller-context checks were skipped';
    end if;

    -- ── 4. The route RPC names the number's own person, and nobody for a team line ──
    insert into public.sms_numbers (client_id, phone_number, registration_status, assigned_user_id)
    values ('phone-numbers-probe-266', '+15555550194', 'registered', v_ghost)
    returning id into v_route_own;
    insert into public.sms_numbers (client_id, phone_number, registration_status)
    values ('phone-numbers-probe-266', '+15555550193', 'registered');
    insert into public.phone_routes (client_id, number_id, members) values ('phone-numbers-probe-266', v_route_own, array[v_ghost]);
    insert into public.phone_user_settings (user_id, client_id, greeting_recording_sid, greeting_updated_at)
    values (v_ghost, 'phone-numbers-probe-266', k_sid, now());
    v := public.phone_route_for_number('+15555550194');
    if v -> 'number_owner' ->> 'user_id' is distinct from v_ghost::text
       or v -> 'number_owner' ->> 'greeting_sid' is distinct from k_sid
       or (v -> 'number_owner' ->> 'has_access')::boolean then
      raise exception '266 probe: number_owner reads % (want the person, their greeting, and no access: they are on no team)', v -> 'number_owner';
    end if;
    if jsonb_array_length(v -> 'members') <> 1 or not (v ? 'recording') or not (v ? 'recent_emergency_user') then
      raise exception '266 probe: phone_route_for_number lost what it answered before: %', v;
    end if;
    v := public.phone_route_for_number('+15555550193');
    if jsonb_typeof(v -> 'number_owner') <> 'null' then
      raise exception '266 probe: a team line has an owner: %', v -> 'number_owner';
    end if;

    -- ── 5. A name is 1 to 40 characters or nothing ──
    v_refused := false;
    begin
      insert into public.sms_numbers (client_id, phone_number, label) values ('phone-numbers-probe-266', '+15555550195', '');
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '266 probe: a number took an empty name'; end if;
    v_refused := false;
    begin
      insert into public.sms_numbers (client_id, phone_number, label) values ('phone-numbers-probe-266', '+15555550195', repeat('x', 41));
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '266 probe: a number took a 41-character name'; end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '266 probe: a person''s own number is their caller ID; every live number is listed; one live number per person; a released number counts for nothing; the route RPC names a number''s own person and nobody for a team line; a name is 1 to 40 characters; nothing was kept';
      else
        raise;
      end if;
  end;

  if exists (select 1 from public.sms_numbers n where n.phone_number in (k_team, k_own, '+15555550195', '+15555550194', '+15555550193'))
     or exists (select 1 from public.sms_numbers n where n.client_id = 'phone-numbers-probe-266')
     or exists (select 1 from public.phone_routes r where r.client_id = 'phone-numbers-probe-266')
     or exists (select 1 from public.phone_user_settings s where s.client_id = 'phone-numbers-probe-266') then
    raise exception '266 probe: synthetic rows were left behind';
  end if;
end
$probe$;

notify pgrst, 'reload schema';

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. Record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('266', '266_phone_numbers') returning version;
-- B. Every number is still a team line with no name:
--      select count(*) filter (where label is not null) named,
--             count(*) filter (where assigned_user_id is not null) assigned,
--             count(*) from public.sms_numbers;   -- 0, 0, n
-- C. Every number is still nobody's (any live number):
--      select public.phone_route_for_number('<a live number>') -> 'number_owner';   -- null
-- D. Every business still calls out from the same number, and lists its numbers:
--      select cu.client_id, public.phone_caller_context(cu.user_id) -> 'number' ->> 'e164' e164,
--             public.phone_caller_context(cu.user_id) -> 'numbers' numbers
--        from public.client_users cu
--        join public.sms_numbers n on n.client_id = cu.client_id and n.released_at is null
--       limit 5;   -- e164 = that business's one live number; numbers = [that number]
--      select position('assigned_user_id' in pg_get_functiondef('public.phone_caller_context(uuid)'::regprocedure)) > 0;   -- true
-- E. Then deploy portal-settings, submit-estimate and the phone-api Worker (they read the columns),
--    then the portal. The apps follow with their next release; an older app compares a ringing
--    call's From with `number` alone, which is enough while the business has one number.
