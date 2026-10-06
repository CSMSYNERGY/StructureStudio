-- 264_phone_away_rules.sql — My Synergy Phone away rules: while someone is on Do Not Disturb,
--                            the calls that would ring them ring the teammate they chose instead;
--                            each person's own hours, outside which they count as away; and each
--                            person's own voicemail greeting, recorded by phone.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. The file carries its own
--    begin;/commit; so every assertion below takes the whole migration with it if it fails.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-09-30 (Fathom 188300043, 36:19): when someone turns on Do Not Disturb "for
-- whatever time", they "can say who they want it to ring to while they're out for lunch". She
-- first asked on 05-26: GHL has no DND that routes calls to another user. 254 built the half
-- that skips the person; nothing stored or rang a cover. This file stores the cover and hands
-- the Worker everyone it might ring in an away member's place.
-- In the same breath (36:19): "also set their hours. So what times that they want the phone to
-- ring and what times they don't want it." Hours existed only per NUMBER, set by the owner
-- (phone_routes.business_hours). This file gives each person their own, and the Worker treats
-- outside them exactly like Do Not Disturb: their cover rings in their place, or nobody does.
-- Same call, same passage: "I want them to be able to go in the phone system and set up their
-- own voicemail. GHL, you have to send it to an admin and an admin has to set it up. Completely
-- don't want that." The only greeting was the owner's pasted link per NUMBER
-- (phone_routes.greeting_url). This file stores each person's own, recorded by phone (the Worker
-- rings their app and records them), and hands it to the Worker with the members.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   phone_user_settings.dnd_cover_user_id: the one teammate a person's calls ring while
--            they're away. NULL = nobody extra (calls skip them, as before). Never themselves.
--   PART 1b  phone_user_settings.ring_hours / ring_hours_tz: the hours a person's phone rings,
--            in their own time zone. NULL = always (today's behaviour).
--   PART 1c  phone_user_settings.greeting_recording_sid / greeting_updated_at: the person's own
--            voicemail greeting, a recording kept at Twilio (by its RE sid). NULL = none.
--   PART 2   phone_route_for_number re-issued (263's text): each member also returns
--            `dnd_cover`, `ring_hours`, `hours_tz` and `greeting_sid`, and the members gain one `cover_only` row
--            per cover who is not on the answer list, so the Worker can ring a cover who isn't on it
--   PART 3   apply-time assertions (they RAISE and abort the transaction)
--   PART 4   a behavioural probe on synthetic rows, rolled back, leaving nothing
--   after commit: recording the row, verification, as comments
--
-- ── NUMBERING AND ORDER ──────────────────────────────────────────────────────────────────
-- AFTER 262 AND 263, never before: this re-issues 263's phone_route_for_number, and applied ahead
-- of 263 it would fail (263's columns) or, worse, a later 263 would put back a copy without the
-- covers. Several Part C items claimed "264"; this one goes first because it re-issues 263's
-- function. Before applying, read the live ledger:
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 3;
-- It must show 263 and must not already show 264. If something else re-issued
-- phone_route_for_number after 263, re-read the live body (pg_get_functiondef) and carry the
-- edits below onto it; do not apply this copy over a newer one.
--
-- ── RE-ISSUED BODY ───────────────────────────────────────────────────────────────────────
-- phone_route_for_number is 263 PART 6's text, verbatim, with these edits and nothing else:
--   * each member object gains 'dnd_cover' (s.dnd_cover_user_id), 'cover_only', (PART 1b)
--     'ring_hours' (s.ring_hours) and 'hours_tz' (s.ring_hours_tz), and (PART 1c) 'greeting_sid'
--     (s.greeting_recording_sid);
--   * the member set is the route's members (cover_only false, in the owner's order, as before)
--     UNION ALL, once each, the covers those members chose who are not members themselves
--     (cover_only true, after every member). A cover row is built by the SAME expressions as a
--     member's: identity, dnd, busy, forward_to_cell, and has_access from client_users joined on
--     the NUMBER's tenant, so a cover from another business always reads has_access false and is
--     never rung. A cover's own cover is not added (no chains).
-- 263's self-check strings ('recording', recent_emergency_user, transfer_state = 'conference')
-- are all still in it, and PART 3 checks them again.
--
-- ── CHOICES ──────────────────────────────────────────────────────────────────────────────
--   1. One remembered cover per person, used only while they're away. Any teammate with phone
--      access may be chosen, on the answer list or not. The Worker checks them on every call
--      (access, busy, their own DND); this file only says who they are.
--   2. No foreign key, like the rest of phone_user_settings (254: the row outlives the person).
--      A cover who left the team reads has_access false and simply isn't rung; their old choice
--      is harmless.
--   3. Busy is not "away": a member on a call never hands their place to a cover. That is the
--      Worker's rule (routes/voice.ts); the RPC returns the facts.
--   4. The cover's own forward-to-cell rings with them, as for any ring.
--   5. Personal hours (PART 1b) are business_hours' shape: {"mon":[["08:00","17:00"]], ...}, a
--      missing day closed, NULL = always. The Worker reads them in ring_hours_tz (the zone the
--      person set them in), falling back to the number's time_zone, and they only ever NARROW the
--      number's business hours: those stay the outer gate, so nobody is rung after the business
--      has closed. Outside their hours a member counts as away (their cover rings, or nobody),
--      and a cover outside their own hours isn't rung either. Calls only: texts and outbound
--      calls don't look at them, and the 911 callback ignores them, as it ignores DND.
--   6. Only the person sets their own hours (the Worker's POST /settings/me, which checks them
--      with _shared/phoneHours.ts parseBusinessHours, the rule the owner's hours pass). The
--      CHECKs below are the database's floor: an object or NULL, a zone name of sane length.
--   7. The greeting (PART 1c) is recorded BY PHONE, never uploaded: browsers record webm/opus and
--      phones m4a, and Twilio's <Play> takes neither. The Worker rings the person's own app
--      (POST /settings/me/greeting/record), <Record>s up to 60 s, and stores the recording's sid
--      here; the audio stays at Twilio, like voicemail. The old recording is deleted at Twilio
--      when it is replaced or cleared; it is kept while this row exists. Only the Worker writes it.
--   8. Where it plays (the Worker decides, voicemail.ts): a voicemail on a line that is one
--      person's (a route whose answer list is exactly them), and a call transferred to them that
--      ends in voicemail. A shared number keeps the owner's greeting_url, or the standard one.
--      The Worker fetches the audio through its own GET /voice/greeting-audio, which plays only
--      the sid stored here, so a replaced or cleared greeting can never be played again.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. Five nullable columns with no default (no table
-- rewrite) and CHECKs every existing row passes (all NULL). The RPC returns five more keys per
-- member, which the live Worker ignores, and extra cover_only rows ONLY for people who chose a
-- cover. Only the new Worker can write a cover, hours or a greeting, so until it ships there are
-- none and the RPC answers exactly as 263's (PART 4 checks the keys). An older Worker that meets
-- hours someone saved simply rings them at any hour, which is today's behaviour, and one that
-- meets a greeting plays the number's greeting instead, as before. The
-- apply waits at most 5 s for a lock, so it gives up rather than hold calls behind it; retry it.
--
-- ⚠️ WORKER ROLLBACK: a Worker from BEFORE this file does not know cover_only, and in
-- all_at_once mode it would ring every cover row on every call, away or not. Before rolling
-- the phone-api Worker back past this change, clear the covers first:
--   update public.phone_user_settings set dnd_cover_user_id = null where dnd_cover_user_id is not null;
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Deploy a phone-api Worker without the cover logic only after clearing the covers (above).
--   begin;
--   -- Re-run 263 PART 6's phone_route_for_number (its create, comment, revoke and grant) FIRST:
--   -- this file's copy names the column, and every inbound call would fail once it is dropped.
--   -- The greetings first: their recordings stay at Twilio, so list the sids and delete them there
--   -- (DELETE /Recordings/<sid>.json) before the column that names them goes:
--   --   select greeting_recording_sid from public.phone_user_settings where greeting_recording_sid is not null;
--   alter table public.phone_user_settings
--     drop constraint if exists phone_user_settings_cover_not_self,
--     drop constraint if exists phone_user_settings_ring_hours_object,
--     drop constraint if exists phone_user_settings_ring_hours_tz_len,
--     drop constraint if exists phone_user_settings_greeting_sid_shape,
--     drop column if exists dnd_cover_user_id,
--     drop column if exists ring_hours,
--     drop column if exists ring_hours_tz,
--     drop column if exists greeting_recording_sid,
--     drop column if exists greeting_updated_at;
--   delete from supabase_migrations.schema_migrations where version = '264';
--   notify pgrst, 'reload schema';
--   commit;
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the cover, per person
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.phone_user_settings
  add column if not exists dnd_cover_user_id uuid;

-- NOT VALID then VALIDATE (261's pattern; every existing row is NULL, so the validation is a
-- scan that cannot fail). A re-apply passes straight through.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'phone_user_settings_cover_not_self'
                    and conrelid = 'public.phone_user_settings'::regclass) then
    alter table public.phone_user_settings
      add constraint phone_user_settings_cover_not_self
      check (dnd_cover_user_id is null or dnd_cover_user_id <> user_id) not valid;
  end if;
end
$$;
alter table public.phone_user_settings validate constraint phone_user_settings_cover_not_self;

comment on column public.phone_user_settings.dnd_cover_user_id is
  'SSS Phone (migration 264): the teammate whose phone rings in this person''s place while they''re away (on Do Not Disturb). NULL = nobody extra: calls skip them and ring the rest of the team, or go to voicemail. Never themselves. Set by the person in the apps or the portal (phone-api POST /settings/me, which checks the teammate has phone access on the same business). No FK: like the row, it outlives the person.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1b — the hours a person's phone rings, per person
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.phone_user_settings
  add column if not exists ring_hours    jsonb,
  add column if not exists ring_hours_tz text;

-- phone_routes_business_hours_object's rule (254), and a zone name no longer than the Worker's
-- validTimeZone takes. NOT VALID then VALIDATE, as above: every existing row is NULL.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'phone_user_settings_ring_hours_object'
                    and conrelid = 'public.phone_user_settings'::regclass) then
    alter table public.phone_user_settings
      add constraint phone_user_settings_ring_hours_object
      check (ring_hours is null or jsonb_typeof(ring_hours) = 'object') not valid;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'phone_user_settings_ring_hours_tz_len'
                    and conrelid = 'public.phone_user_settings'::regclass) then
    alter table public.phone_user_settings
      add constraint phone_user_settings_ring_hours_tz_len
      check (ring_hours_tz is null or char_length(ring_hours_tz) between 1 and 64) not valid;
  end if;
end
$$;
alter table public.phone_user_settings validate constraint phone_user_settings_ring_hours_object;
alter table public.phone_user_settings validate constraint phone_user_settings_ring_hours_tz_len;

comment on column public.phone_user_settings.ring_hours is
  'SSS Phone (migration 264): the hours this person''s phone rings, {"mon":[["08:00","17:00"]],...} like phone_routes.business_hours (a missing day = not that day), read in ring_hours_tz. NULL = always (whenever the business is open). Outside them the person counts as away, like Do Not Disturb: their cover rings, or nobody. Never wider than the business hours, which stay the outer gate. Calls only. Set by the person (phone-api POST /settings/me).';
comment on column public.phone_user_settings.ring_hours_tz is
  'SSS Phone (migration 264): the IANA time zone ring_hours are in (the device or browser the person set them on). NULL, or a zone the Worker doesn''t know, = the number''s phone_routes.time_zone.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1c — each person's own voicemail greeting
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.phone_user_settings
  add column if not exists greeting_recording_sid text,
  add column if not exists greeting_updated_at    timestamptz;

-- A Twilio recording sid (RE + 32 lowercase hex) or nothing: the Worker builds a URL from it.
-- NOT VALID then VALIDATE, as above: every existing row is NULL.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'phone_user_settings_greeting_sid_shape'
                    and conrelid = 'public.phone_user_settings'::regclass) then
    alter table public.phone_user_settings
      add constraint phone_user_settings_greeting_sid_shape
      check (greeting_recording_sid is null or greeting_recording_sid ~ '^RE[0-9a-f]{32}$') not valid;
  end if;
end
$$;
alter table public.phone_user_settings validate constraint phone_user_settings_greeting_sid_shape;

comment on column public.phone_user_settings.greeting_recording_sid is
  'SSS Phone (migration 264): the person''s own voicemail greeting, a Twilio recording (RE sid) they made by phone (phone-api POST /settings/me/greeting/record, then /voice/greeting). NULL = none: their voicemail plays the number''s greeting, or the standard one. Plays on a line that is only theirs and on a call transferred to them. The old recording is deleted at Twilio when this is replaced or cleared. Written by the Worker only.';
comment on column public.phone_user_settings.greeting_updated_at is
  'SSS Phone (migration 264): when the person last recorded or cleared their greeting (NULL until they first do). With a greeting the apps show it ("recorded Oct 5") and watch it change after a recording call; without one it only stops a late recording callback from bringing back a greeting cleared since its ring began.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — phone_route_for_number returns the covers and everyone's hours
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 263 PART 6's text with the edits the header lists (each marked "264").

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

  return jsonb_build_object(
    'client_id',             v_num.client_id,
    'number_id',             v_num.id,
    'phone_status',          coalesce(v_status, 'off'),
    'route',                 case when v_has_route then to_jsonb(v_route) end,
    'members',               v_members,
    'business_name',         v_business,
    'recent_emergency_user', v_emergency,
    'recording',             jsonb_build_object(
                               'on',          coalesce(v_rec_on, false),
                               'notice',      coalesce(v_rec_notice, true),
                               'notice_text', v_rec_text,
                               'transcribe',  coalesce(v_rec_trans, true))
  );
end
$fn$;

comment on function public.phone_route_for_number(text) is
  'SSS Phone (migrations 254, 263, 264): the one database call behind /voice/inbound. Returns {client_id, number_id, phone_status, route, members:[{user_id, identity, dnd, busy, has_access, full_name, forward_to_cell, dnd_cover, cover_only, ring_hours, hours_tz, greeting_sid}], business_name, recent_emergency_user, recording:{on, notice, notice_text, transcribe}} for a live number, NULL otherwise. members = the route''s members in order (cover_only false), then once each the covers they chose who are not members (cover_only true: rung only in an away member''s place, never alone). ring_hours/hours_tz = the person''s own hours (NULL = always); outside them the Worker treats them as away. greeting_sid = the person''s own voicemail greeting (a Twilio recording sid), or NULL. Uncached by design. service_role only.';

revoke execute on function public.phone_route_for_number(text) from public, anon, authenticated;
grant  execute on function public.phone_route_for_number(text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — apply-time assertions. Each RAISE aborts the transaction.
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
  v_fn   constant text := 'public.phone_route_for_number(text)';
begin
  -- ── PART 1: the column, a nullable uuid with no default, and its check, validated ──
  select c.data_type, c.is_nullable = 'YES', c.column_default
    into v_type, v_null, v_def
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'phone_user_settings' and c.column_name = 'dnd_cover_user_id';
  if v_type is distinct from 'uuid' or not v_null or v_def is not null then
    raise exception '264: phone_user_settings.dnd_cover_user_id is %, nullable %, default %', v_type, v_null, v_def;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'phone_user_settings_cover_not_self'
                    and conrelid = 'public.phone_user_settings'::regclass
                    and contype = 'c' and convalidated) then
    raise exception '264: phone_user_settings_cover_not_self is missing or not validated';
  end if;
  -- ── PART 1b: the hours, a nullable jsonb and a nullable text with no default, both checked ──
  select c.data_type, c.is_nullable = 'YES', c.column_default
    into v_type, v_null, v_def
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'phone_user_settings' and c.column_name = 'ring_hours';
  if v_type is distinct from 'jsonb' or not v_null or v_def is not null then
    raise exception '264: phone_user_settings.ring_hours is %, nullable %, default %', v_type, v_null, v_def;
  end if;
  select c.data_type, c.is_nullable = 'YES', c.column_default
    into v_type, v_null, v_def
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'phone_user_settings' and c.column_name = 'ring_hours_tz';
  if v_type is distinct from 'text' or not v_null or v_def is not null then
    raise exception '264: phone_user_settings.ring_hours_tz is %, nullable %, default %', v_type, v_null, v_def;
  end if;
  if (select count(*) from pg_catalog.pg_constraint
       where conname in ('phone_user_settings_ring_hours_object', 'phone_user_settings_ring_hours_tz_len')
         and conrelid = 'public.phone_user_settings'::regclass
         and contype = 'c' and convalidated) <> 2 then
    raise exception '264: the ring_hours checks are missing or not validated';
  end if;
  -- ── PART 1c: the greeting, a nullable text and a nullable timestamptz, the sid's shape checked ──
  select c.data_type, c.is_nullable = 'YES', c.column_default
    into v_type, v_null, v_def
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'phone_user_settings' and c.column_name = 'greeting_recording_sid';
  if v_type is distinct from 'text' or not v_null or v_def is not null then
    raise exception '264: phone_user_settings.greeting_recording_sid is %, nullable %, default %', v_type, v_null, v_def;
  end if;
  select c.data_type, c.is_nullable = 'YES', c.column_default
    into v_type, v_null, v_def
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'phone_user_settings' and c.column_name = 'greeting_updated_at';
  if v_type is distinct from 'timestamp with time zone' or not v_null or v_def is not null then
    raise exception '264: phone_user_settings.greeting_updated_at is %, nullable %, default %', v_type, v_null, v_def;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'phone_user_settings_greeting_sid_shape'
                    and conrelid = 'public.phone_user_settings'::regclass
                    and contype = 'c' and convalidated) then
    raise exception '264: phone_user_settings_greeting_sid_shape is missing or not validated';
  end if;
  -- Still the service role's alone: the browser roles can neither read nor write the new columns.
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      foreach v_col in array array['dnd_cover_user_id', 'ring_hours', 'ring_hours_tz', 'greeting_recording_sid', 'greeting_updated_at'] loop
        if has_column_privilege(v_role, 'public.phone_user_settings', v_col, v_priv) then
          raise exception '264: % can % phone_user_settings.%', v_role, v_priv, v_col;
        end if;
      end loop;
    end loop;
  end loop;

  -- ── PART 2: the RPC, the service role's alone, with its empty search_path ──
  if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception '264: % is callable from the browser', v_fn;
  end if;
  if exists (select 1 from pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where p.oid = v_fn::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception '264: % is still executable by PUBLIC', v_fn;
  end if;
  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception '264: service_role cannot call %', v_fn;
  end if;
  -- coalesce: a function with no SET at all has a NULL proconfig, and NOT NULL is not true.
  if not coalesce((select p.proconfig @> array['search_path=""'] from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure), false) then
    raise exception '264: % lost its empty search_path', v_fn;
  end if;
  -- 263's self-check (a token of each rule it kept), and this file's own: the two keys, the
  -- cover rows, and has_access read on the NUMBER's tenant.
  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure;
  if position('''recording''' in v_src) = 0
     or position('recent_emergency_user' in v_src) = 0
     or position('transfer_state = ''conference''' in v_src) = 0 then
    raise exception '264: phone_route_for_number does not return recording, or lost a 254 rule';
  end if;
  if position('''dnd_cover''' in v_src) = 0
     or position('''cover_only''' in v_src) = 0
     or position('cs.dnd_cover_user_id' in v_src) = 0
     or position('and cu.client_id = v_num.client_id' in v_src) = 0 then
    raise exception '264: phone_route_for_number does not return the covers, or reads access off the number''s tenant';
  end if;
  if position('''ring_hours'',      s.ring_hours' in v_src) = 0
     or position('''hours_tz'',        s.ring_hours_tz' in v_src) = 0 then
    raise exception '264: phone_route_for_number does not return each person''s own hours';
  end if;
  if position('''greeting_sid'',    s.greeting_recording_sid' in v_src) = 0 then
    raise exception '264: phone_route_for_number does not return each person''s own greeting';
  end if;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — behavioural probe. Synthetic tenant, rolled back, leaves nothing.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 254 PART 11's pattern: exercise what matters, then raise ROLLBACK_PROBE so the writes vanish.
-- The tenant, number and people are synthetic (phone_user_settings has no FK, so the people
-- need no login). The one real row it reads is a client_users row from ANOTHER business, chosen
-- as a cover, which must read has_access false: a cover is never rung across businesses. A
-- same-business cover with access needs a real login to exist, so that answer is
-- tests/sql/migration264.test.cjs's, not this probe's. Each person's own hours come back as they
-- were stored, on a member's row and a cover's alike; a non-object is refused. So does each
-- person's own greeting; a value that isn't a recording sid is refused.
do $probe$
declare
  k_cid    constant text := 'phone-away-probe-264';
  k_num    constant text := '+15555550198';
  k_sid    constant text := 'RE' || repeat('0', 31) || '7';
  v_num_id uuid;
  u1       uuid := gen_random_uuid();  -- on the list, on DND, covered by c1
  u2       uuid := gen_random_uuid();  -- on the list, covered by u1 (a member: no extra row)
  u3       uuid := gen_random_uuid();  -- on the list, covered by c1 too (c1 comes once)
  c1       uuid := gen_random_uuid();  -- not on the list; their own cover c2 is not added
  c2       uuid := gen_random_uuid();
  v_real   public.client_users%rowtype;
  v        jsonb;
  m        jsonb;
  v_keys   text[];
  v_ids    uuid[];
  v_refused boolean;
begin
  select cu.* into v_real from public.client_users cu order by cu.created_at limit 1;

  begin
    insert into public.client_settings (client_id, phone_status, business_name)
    values (k_cid, 'on', 'Probe Sheds');
    insert into public.sms_numbers (client_id, phone_number, registration_status)
    values (k_cid, k_num, 'registered')
    returning id into v_num_id;
    insert into public.phone_routes (client_id, number_id, members)
    values (k_cid, v_num_id, array[u1, u2, u3]);
    insert into public.phone_user_settings (user_id, client_id, dnd, dnd_cover_user_id)
    values (u1, k_cid, true, c1), (u2, k_cid, false, u1), (u3, k_cid, false, c1);
    insert into public.phone_user_settings (user_id, client_id, device_generation, forward_to_cell, dnd_cover_user_id)
    values (c1, k_cid, 4, '+15555550124', c2);

    -- ── 1. Nobody covers for themselves ──
    v_refused := false;
    begin
      update public.phone_user_settings set dnd_cover_user_id = user_id where user_id = u2;
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '264 probe: a person was saved as their own cover'; end if;
    -- … and hours are an object or nothing, in a zone name of sane length.
    v_refused := false;
    begin
      update public.phone_user_settings set ring_hours = '[["08:00","17:00"]]'::jsonb where user_id = u2;
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '264 probe: ring_hours took a non-object'; end if;
    v_refused := false;
    begin
      update public.phone_user_settings set ring_hours_tz = '' where user_id = u2;
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '264 probe: ring_hours_tz took an empty zone'; end if;
    -- … and a greeting is a Twilio recording sid or nothing.
    v_refused := false;
    begin
      update public.phone_user_settings set greeting_recording_sid = 'https://example.test/hi.mp3' where user_id = u2;
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '264 probe: greeting_recording_sid took something that isn''t a recording sid'; end if;
    update public.phone_user_settings
       set ring_hours = '{"mon":[["08:00","17:00"]]}'::jsonb, ring_hours_tz = 'America/Denver'
     where user_id in (u2, c1);
    update public.phone_user_settings
       set greeting_recording_sid = k_sid, greeting_updated_at = now()
     where user_id = u2;

    -- ── 2. The members, in order, then each outside cover once ──
    v := public.phone_route_for_number(k_num);
    select array_agg(k order by k) into v_keys from jsonb_object_keys(v) as k;
    if v_keys <> array['business_name','client_id','members','number_id','phone_status',
                       'recent_emergency_user','recording','route'] then
      raise exception '264 probe: phone_route_for_number keys are %', v_keys;
    end if;
    select array_agg((x ->> 'user_id')::uuid order by o) into v_ids
      from jsonb_array_elements(v -> 'members') with ordinality as e(x, o);
    if v_ids is distinct from array[u1, u2, u3, c1] then
      raise exception '264 probe: members are % (want the three on the list, then c1 once)', v_ids;
    end if;
    m := v -> 'members' -> 0;
    select array_agg(k order by k) into v_keys from jsonb_object_keys(m) as k;
    if v_keys <> array['busy','cover_only','dnd','dnd_cover','forward_to_cell','full_name','greeting_sid','has_access','hours_tz','identity','ring_hours','user_id'] then
      raise exception '264 probe: member keys are %', v_keys;
    end if;
    if jsonb_typeof(m -> 'ring_hours') <> 'null' or jsonb_typeof(m -> 'hours_tz') <> 'null' then
      raise exception '264 probe: someone who set no hours reads %', m;
    end if;
    if jsonb_typeof(m -> 'greeting_sid') <> 'null' then
      raise exception '264 probe: someone with no greeting reads %', m;
    end if;
    if v -> 'members' -> 1 ->> 'greeting_sid' is distinct from k_sid then
      raise exception '264 probe: a member''s own greeting reads %', v -> 'members' -> 1;
    end if;
    if v -> 'members' -> 1 -> 'ring_hours' <> '{"mon":[["08:00","17:00"]]}'::jsonb
       or v -> 'members' -> 1 ->> 'hours_tz' is distinct from 'America/Denver' then
      raise exception '264 probe: a member''s own hours read %', v -> 'members' -> 1;
    end if;
    if (m ->> 'cover_only')::boolean or (m ->> 'dnd_cover')::uuid is distinct from c1 or not (m ->> 'dnd')::boolean then
      raise exception '264 probe: the first member reads %', m;
    end if;
    if (v -> 'members' -> 1 ->> 'cover_only')::boolean or (v -> 'members' -> 1 ->> 'dnd_cover')::uuid is distinct from u1 then
      raise exception '264 probe: the second member reads %', v -> 'members' -> 1;
    end if;
    m := v -> 'members' -> 3;
    if not (m ->> 'cover_only')::boolean
       or m ->> 'identity' <> 'u_' || replace(c1::text, '-', '') || '_g4'
       or m ->> 'forward_to_cell' <> '+15555550124'
       or (m ->> 'dnd_cover')::uuid is distinct from c2
       or (m ->> 'dnd')::boolean or (m ->> 'busy')::boolean
       or m -> 'ring_hours' <> '{"mon":[["08:00","17:00"]]}'::jsonb or m ->> 'hours_tz' is distinct from 'America/Denver' then
      raise exception '264 probe: the cover row reads % (its identity, cell, hours and flags are a member''s)', m;
    end if;
    -- c1 has no client_users row on this business, so nothing may ring them.
    if (m ->> 'has_access')::boolean then raise exception '264 probe: a cover with no place on the team has access'; end if;

    -- ── 3. A cover from ANOTHER business is listed but never has access ──
    if v_real.user_id is not null then
      update public.phone_user_settings set dnd_cover_user_id = v_real.user_id where user_id = u2;
      v := public.phone_route_for_number(k_num);
      select e.x into m from jsonb_array_elements(v -> 'members') as e(x) where (e.x ->> 'user_id')::uuid = v_real.user_id;
      if m is null or not (m ->> 'cover_only')::boolean then
        raise exception '264 probe: the other business''s cover was not listed as a cover: %', v -> 'members';
      end if;
      if (m ->> 'has_access')::boolean then
        raise exception '264 probe: a cover from ANOTHER business has access to this number';
      end if;
    else
      raise notice '264 probe: client_users is empty, so the other-business cover check was skipped';
    end if;

    -- ── 4. Nobody chose a cover or hours: exactly 263's members (the live Worker's shape) ──
    update public.phone_user_settings
       set dnd_cover_user_id = null, ring_hours = null, ring_hours_tz = null, greeting_recording_sid = null, greeting_updated_at = null
     where client_id = k_cid;
    v := public.phone_route_for_number(k_num);
    if jsonb_array_length(v -> 'members') <> 3
       or exists (select 1 from jsonb_array_elements(v -> 'members') as e(x)
                   where (e.x ->> 'cover_only')::boolean or jsonb_typeof(e.x -> 'dnd_cover') <> 'null'
                      or jsonb_typeof(e.x -> 'ring_hours') <> 'null' or jsonb_typeof(e.x -> 'hours_tz') <> 'null'
                      or jsonb_typeof(e.x -> 'greeting_sid') <> 'null') then
      raise exception '264 probe: with no covers, hours or greetings the members are %', v -> 'members';
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '264 probe: nobody covers for themselves; hours are an object or nothing; a greeting is a recording sid or nothing; members keep their order; each outside cover is listed once, after them, as a member would be, hours included; a member''s greeting comes back; a cover from another business never has access; with no covers, hours or greetings the members are 263''s; nothing was kept';
      else
        raise;
      end if;
  end;

  if exists (select 1 from public.client_settings s where s.client_id = k_cid)
     or exists (select 1 from public.sms_numbers n where n.client_id = k_cid)
     or exists (select 1 from public.phone_routes r where r.client_id = k_cid)
     or exists (select 1 from public.phone_user_settings s where s.client_id = k_cid) then
    raise exception '264 probe: synthetic rows were left behind';
  end if;
end
$probe$;

notify pgrst, 'reload schema';

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. Record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('264', '264_phone_away_rules');
-- B. Nobody has a cover, hours or a greeting yet:
--      select count(*) filter (where dnd_cover_user_id is not null) covers,
--             count(*) filter (where ring_hours is not null or ring_hours_tz is not null) hours,
--             count(*) filter (where greeting_recording_sid is not null or greeting_updated_at is not null) greetings,
--             count(*) from public.phone_user_settings;   -- 0, 0, 0, n
-- C. The RPC carries the new keys (any live number):
--      select m -> 'dnd_cover', m -> 'cover_only', m -> 'ring_hours', m -> 'hours_tz', m -> 'greeting_sid'
--        from jsonb_array_elements(public.phone_route_for_number('<a live number>') -> 'members') m;
--      -- null, false, null, null, null for every member; no cover_only row
--      select position('cover_only' in pg_get_functiondef('public.phone_route_for_number(text)'::regprocedure)) > 0,
--             position('ring_hours_tz' in pg_get_functiondef('public.phone_route_for_number(text)'::regprocedure)) > 0,
--             position('greeting_recording_sid' in pg_get_functiondef('public.phone_route_for_number(text)'::regprocedure)) > 0;   -- true, true, true
-- D. Then deploy the phone-api Worker (it must ship before any app, extension or portal build
--    that offers the choice: an older Worker drops the field without saying so).
