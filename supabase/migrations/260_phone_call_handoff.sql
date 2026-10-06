-- 260_phone_call_handoff.sql — My Synergy Phone: move a live call between a person's own devices
--                               (the Chrome extension and the phone app) without dropping it.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. The file carries its own
--    begin;/commit; so every assertion below takes the whole migration with it if it fails.
--
-- ⚠️ THE NUMBER. 259 is taken by usage billing (built at the same time). Claim this one with
--    `insert ... returning` into schema_migrations when it is applied; if 260 has gone by then,
--    rename the file to the next free number. Nothing inside depends on the number except the
--    '260:' prefix on the assertion messages.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- The product owner asked on 2026-10-02 for a call answered on the phone to move to the Chrome
-- extension, and the other way round: a "Move to phone" / "Move to computer" button, the other
-- device rings, she answers there, and the first device drops off. The plan is Part 2 of the
-- 2026-10-02 plan (wallet billing and call handoff); the Worker side is
-- workers/phone-api/src/handoff.ts (its header explains the flow). The row needs to say that a move is under way, to where,
-- with which one-time key, since when, and which two legs are involved. Six nullable columns,
-- all NULL on every existing row, and NULL again on a row once a move has finished.
--
--   handoff_state     'ringing'     the other device is being rung; the call has not moved
--                     'connecting'  the other device answered; the Worker is moving the call
--                     NULL          no move under way (also: done, missed, failed, canceled —
--                                   the outcome is a phone_call_events row, type device_switch)
--   handoff_to        'chrome' | 'mobile'   where it is going
--   handoff_key       a fresh uuid per attempt: the answering device must present it, and a
--                     late answer from an older attempt never matches
--   handoff_at        when it started ringing, then when it was answered. A move older than
--                     45 s is over whatever handoff_state says (a lost callback must never
--                     block Hold, Transfer or the next move for good)
--   handoff_sid       the answering leg's CallSid (for the phone: the ring Twilio placed)
--   handoff_from_sid  the leg the call is moving FROM (client_call_sid at the start)
--
-- ── WHAT IS NOT CHANGED, AND WHY ─────────────────────────────────────────────────────────
--   * phone_call_events.type has no CHECK (254 PART 3), so the new `device_switch` type needs
--     nothing. PART 2 asserts that is still true, so a CHECK added later cannot start
--     refusing these writes without someone reading this.
--   * Realtime. 254 PART 7's phone_calls_realtime trigger is AFTER INSERT OR UPDATE OR DELETE
--     FOR EACH ROW with no WHEN clause and no column list, so every write to these columns
--     already broadcasts {table, op, id, contact_id} on phone:<client> and on
--     phone:user:<each person on the call> (placed_by / answered_by — the holder). The payload
--     is IDS ONLY by design: none of these columns rides along, and none should (handoff_key is
--     a capability). The apps re-read through the Worker on every event (GET /handoff/pending,
--     GET /calls/:id/handoff, GET /calls). PART 2 asserts the trigger is still that trigger.
--   * Grants. Columns added to an existing table take the table's privileges. 254 revoked
--     everything on phone_calls from PUBLIC, anon and authenticated; PART 2 asserts, column
--     by column, that neither browser role can read or write any of the six.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   the six columns, three named CHECKs, one tiny partial index
--   PART 2   apply-time assertions (they RAISE and abort the transaction)
--   PART 3   a behavioural probe on a synthetic row, rolled back, leaving nothing
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. Nullable columns with no default (no table
-- rewrite, a catalog change only), CHECKs that every existing row passes (all NULL), and an
-- index over rows that do not exist yet. The live Worker selects named columns (CALL_COLUMNS),
-- so it neither sees nor minds them. Apply this BEFORE deploying a Worker with the handoff
-- routes: that Worker's CALL_COLUMNS names these columns, and every phone_calls read it makes
-- fails without them.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Deploy the Worker without the handoff routes (and its CALL_COLUMNS without handoff_*) first.
--   begin;
--   drop index if exists public.phone_calls_handoff_live_idx;
--   alter table public.phone_calls
--     drop constraint if exists phone_calls_handoff_shape_chk,
--     drop constraint if exists phone_calls_handoff_to_chk,
--     drop constraint if exists phone_calls_handoff_state_chk,
--     drop column if exists handoff_from_sid,
--     drop column if exists handoff_sid,
--     drop column if exists handoff_at,
--     drop column if exists handoff_key,
--     drop column if exists handoff_to,
--     drop column if exists handoff_state;
--   delete from supabase_migrations.schema_migrations where version = '260';
--   commit;
-- The device_switch rows in phone_call_events stay (they are history, and billing reads the
-- new legs' SIDs from them); delete them only if billing no longer needs them:
--   delete from public.phone_call_events where type = 'device_switch';
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the columns
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.phone_calls
  add column if not exists handoff_state    text,
  add column if not exists handoff_to       text,
  add column if not exists handoff_key      uuid,
  add column if not exists handoff_at       timestamptz,
  add column if not exists handoff_sid      text,
  add column if not exists handoff_from_sid text;

-- Named, so PART 2 can find them and the rollback can drop them. Dropped first so a re-apply
-- replaces rather than fails.
alter table public.phone_calls drop constraint if exists phone_calls_handoff_state_chk;
alter table public.phone_calls add constraint phone_calls_handoff_state_chk
  check (handoff_state is null or handoff_state in ('ringing', 'connecting'));

alter table public.phone_calls drop constraint if exists phone_calls_handoff_to_chk;
alter table public.phone_calls add constraint phone_calls_handoff_to_chk
  check (handoff_to is null or handoff_to in ('chrome', 'mobile'));

-- A move under way always knows where it is going, its key, its start and the leg it is moving
-- from. The Worker writes all four in the one statement that claims the move; this is the
-- backstop. A finished move clears handoff_state only, so the rest may linger: they describe
-- the last attempt. The status endpoints read them after it (how the move ended), and the
-- Worker's finishIfAlone only against the leg holding the call now, so a stale pair never
-- changes how a later warm transfer hands the call on.
alter table public.phone_calls drop constraint if exists phone_calls_handoff_shape_chk;
alter table public.phone_calls add constraint phone_calls_handoff_shape_chk
  check (handoff_state is null
         or (handoff_to is not null and handoff_key is not null
             and handoff_at is not null and handoff_from_sid is not null));

-- GET /handoff/pending runs on every realtime event the extension receives and once a minute.
-- Only the rows of a move under way match, so this index stays a handful of entries forever.
create index if not exists phone_calls_handoff_live_idx
  on public.phone_calls (client_id, handoff_at desc)
  where handoff_state is not null;

comment on column public.phone_calls.handoff_state is
  'My Synergy Phone (migration 260): a move of this live call to the person''s other device. ringing = the other device is being rung, nothing has moved; connecting = it answered and the Worker is moving the call; NULL = none under way. The outcome (done, missed, failed, canceled) is a phone_call_events row of type device_switch. Older than 45 s (handoff_at) counts as over.';
comment on column public.phone_calls.handoff_to is
  'My Synergy Phone (migration 260): where the move is going, chrome or mobile.';
comment on column public.phone_calls.handoff_key is
  'My Synergy Phone (migration 260): one-time key for this move attempt; the answering device must present it. A capability: never broadcast, never written to phone_call_events.';
comment on column public.phone_calls.handoff_at is
  'My Synergy Phone (migration 260): when the move started ringing, then when the other device answered.';
comment on column public.phone_calls.handoff_sid is
  'My Synergy Phone (migration 260): the CallSid of the leg that rang (phone) or answered (either device).';
comment on column public.phone_calls.handoff_from_sid is
  'My Synergy Phone (migration 260): the CallSid the call is moving away from (client_call_sid when the move started).';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — apply-time assertions. Each RAISE aborts the transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_col  text;
  v_role text;
  v_priv text;
  v_con  text;
begin
  -- ── The six columns, with the types the Worker writes ──
  foreach v_col in array array['handoff_state','handoff_to','handoff_key','handoff_at','handoff_sid','handoff_from_sid'] loop
    if not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = 'phone_calls' and c.column_name = v_col) then
      raise exception '260: phone_calls.% is missing', v_col;
    end if;
  end loop;
  if (select c.data_type from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = 'phone_calls' and c.column_name = 'handoff_key') <> 'uuid'
     or (select c.data_type from information_schema.columns c
          where c.table_schema = 'public' and c.table_name = 'phone_calls' and c.column_name = 'handoff_at') <> 'timestamp with time zone' then
    raise exception '260: handoff_key must be uuid and handoff_at timestamptz (a column of that name already existed with another type?)';
  end if;

  -- ── The checks exist (PART 3 proves they refuse what they must) ──
  foreach v_con in array array['phone_calls_handoff_state_chk','phone_calls_handoff_to_chk','phone_calls_handoff_shape_chk'] loop
    if not exists (select 1 from pg_catalog.pg_constraint
                    where conname = v_con and conrelid = 'public.phone_calls'::regclass and contype = 'c') then
      raise exception '260: check constraint % is missing', v_con;
    end if;
  end loop;

  -- ── No browser role can touch the new columns (254's posture, inherited, checked) ──
  foreach v_col in array array['handoff_state','handoff_to','handoff_key','handoff_at','handoff_sid','handoff_from_sid'] loop
    foreach v_role in array array['anon','authenticated'] loop
      foreach v_priv in array array['SELECT','INSERT','UPDATE'] loop
        if has_column_privilege(v_role, 'public.phone_calls', v_col, v_priv) then
          raise exception '260: % holds % on phone_calls.% — the handoff key would be readable from the browser', v_role, v_priv, v_col;
        end if;
      end loop;
    end loop;
    foreach v_priv in array array['SELECT','INSERT','UPDATE'] loop
      if not has_column_privilege('service_role', 'public.phone_calls', v_col, v_priv) then
        raise exception '260: service_role lacks % on phone_calls.% — the Worker could not use it', v_priv, v_col;
      end if;
    end loop;
  end loop;

  -- ── device_switch needs no CHECK change: phone_call_events.type is still unconstrained ──
  if exists (select 1 from pg_catalog.pg_constraint k
              where k.conrelid = 'public.phone_call_events'::regclass and k.contype = 'c'
                and pg_catalog.pg_get_constraintdef(k.oid) ~ '\mtype\M') then
    raise exception '260: phone_call_events.type has gained a CHECK; add device_switch to it before applying this';
  end if;

  -- ── The broadcast that carries the signal is still 254's: every update, no column list ──
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgname = 'phone_calls_realtime'
                    and t.tgrelid = 'public.phone_calls'::regclass
                    and not t.tgisinternal and t.tgenabled = 'O'
                    and t.tgfoid = 'public.phone_realtime_notify()'::regprocedure
                    and position(' UPDATE OF ' in pg_catalog.pg_get_triggerdef(t.oid)) = 0
                    and position(' WHEN ' in pg_catalog.pg_get_triggerdef(t.oid)) = 0) then
    raise exception '260: phone_calls_realtime is missing, disabled, or no longer fires on every update; the apps would never hear a move start';
  end if;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — behavioural probe. One synthetic row, rolled back, leaves nothing.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 254's pattern: exercise what matters, then raise ROLLBACK_PROBE so every write in the inner
-- block vanishes. The tenant id is obviously fake and has no client_settings row, so the
-- broadcast trigger sends nothing for it (254 DEVIATION 4).
do $probe$
declare
  k_cid     constant text := '__260_probe__';
  v_id      uuid := gen_random_uuid();
  v_key     uuid := gen_random_uuid();
  v_n       integer;
  v_refused boolean;
begin
  begin
    insert into public.phone_calls (id, client_id, direction, from_e164, to_e164, status, client_call_sid)
    values (v_id, k_cid, 'in', '+15555550142', '+15555550100', 'in_progress', 'CA' || repeat('0', 31) || '5');

    -- ── 1. The Worker's claim: all four in one statement, only while nothing is under way ──
    update public.phone_calls
       set handoff_state = 'ringing', handoff_to = 'mobile', handoff_key = v_key,
           handoff_at = now(), handoff_sid = null, handoff_from_sid = client_call_sid
     where id = v_id and (handoff_state is null or handoff_at < now() - interval '45 seconds');
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception '260 probe: the first claim did not land'; end if;
    update public.phone_calls
       set handoff_state = 'ringing', handoff_key = gen_random_uuid(), handoff_at = now()
     where id = v_id and (handoff_state is null or handoff_at < now() - interval '45 seconds');
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception '260 probe: a second claim won over a move under way'; end if;

    -- ── 2. The answer: ringing → connecting, only with the right key ──
    update public.phone_calls set handoff_state = 'connecting'
     where id = v_id and handoff_state = 'ringing' and handoff_key = gen_random_uuid();
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception '260 probe: a wrong key answered the move'; end if;
    update public.phone_calls set handoff_state = 'connecting', handoff_sid = 'CA' || repeat('0', 31) || '7'
     where id = v_id and handoff_state = 'ringing' and handoff_key = v_key;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception '260 probe: the right key did not answer the move'; end if;

    -- ── 3. Done: back to NULL, the rest may stay ──
    update public.phone_calls set handoff_state = null, client_call_sid = handoff_sid where id = v_id;

    -- ── 4. The checks refuse what they must ──
    v_refused := false;
    begin
      update public.phone_calls set handoff_state = 'moving' where id = v_id;
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '260 probe: handoff_state took a value outside ringing/connecting'; end if;
    v_refused := false;
    begin
      update public.phone_calls set handoff_to = 'ipad' where id = v_id;
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '260 probe: handoff_to took a value outside chrome/mobile'; end if;
    v_refused := false;
    begin
      update public.phone_calls set handoff_state = 'ringing', handoff_key = null where id = v_id;
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '260 probe: a move under way was allowed without its key'; end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '260 probe: one claim at a time, answered only with its key, cleared when done, and the checks hold; nothing was kept';
      else
        raise;
      end if;
  end;

  if exists (select 1 from public.phone_calls c where c.client_id = k_cid) then
    raise exception '260 probe: the synthetic row was left behind';
  end if;
end
$probe$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. The columns are there and empty:
--      select count(*) from public.phone_calls where handoff_state is not null;   -- 0
-- B. After a move on a test call (phone_calls.id = <id>):
--      select handoff_state, handoff_to, handoff_at, handoff_sid, handoff_from_sid, client_call_sid
--        from public.phone_calls where id = '<id>';
--      select at, data from public.phone_call_events
--       where call_id = '<id>' and type = 'device_switch' order by at;
--      -- offered, then done (data.sid = the new leg, data.from_sid = the old one), and
--      -- client_call_sid = data.sid.
