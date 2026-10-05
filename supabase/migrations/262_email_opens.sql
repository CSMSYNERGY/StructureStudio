-- 262_email_opens.sql — read tracking: when a customer opens an email, and what happened to it
--                       after it left (delivered, bounced), recorded once per Resend event.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. The file carries its own
--    begin;/commit; so every assertion below takes the whole migration with it if it fails.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-10-01 (Fathom 188709860, 24:37-26:28): "One of the potential clients to sign up
-- asked to be able to see if an email is read or not."
--
-- email_sends has had delivered_at, bounced_at and bounce_reason since 107, and a consumer for
-- Resend's delivery events since 113 (the postmark-events function, name kept). Nothing has ever
-- posted to it: no Resend webhook was subscribed to delivery events, so on 2026-10-04 none of the
-- 54 live rows was delivered or bounced. This file adds the open (opened_at, open_count), the spam
-- complaint (complained_at) and ONE function that records any of the five events exactly once.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-04: 261 is the newest. 263 is already written on another branch (phone call
-- recording), so this is 262 whichever lands first. Check the live list before applying:
-- `select version from supabase_migrations.schema_migrations order by 1 desc limit 3;` must not
-- already show 262.
--
-- ── WRITE ORDER: THIS FILE FIRST, THEN THE FUNCTIONS, THEN THE RESEND WEBHOOK ────────────
-- postmark-events calls record_email_event. Deployed before this file it answers 500 and Resend
-- retries on its own schedule (5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h), so an early event is
-- recorded once this lands, not lost. crmFeed (the portal's History) and the phone-api Worker read
-- opened_at and both fall back to a read without it, so neither breaks ahead of this file. Create
-- the Resend webhook (email.delivered, opened, bounced, complained, suppressed and failed) only
-- after this and the function are live.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   email_sends.opened_at, open_count, complained_at (and delivered_at, which 107 already added)
--   PART 2   email_send_events: one row per provider event, the idempotency key
--   PART 3   record_email_event(provider_message_id, event, at, reason, event_id)
--   PART 4   apply-time assertions (they RAISE and abort the transaction)
--   PART 5   a behavioural probe on synthetic rows, rolled back, leaving nothing
--
-- ── WHAT EACH EVENT DOES ─────────────────────────────────────────────────────────────────
--   delivered   delivered_at = the earliest seen; status claimed/sent → delivered. A bounce stays
--               a bounce: Resend can report a late bounce after a delivery, and the bounce is the
--               news a builder has to act on.
--   opened      opened_at = the earliest seen; open_count + 1, up to 25. Status unchanged: an open
--               is shown from opened_at, so a delivery receipt that never arrived does not hide it.
--   bounced     bounced_at = the earliest seen; bounce_reason; status → bounced.
--   complained  complained_at = the earliest seen. Status, bounced_at and bounce_reason are left as
--               they are: a complaint is NOT a bounce. The email arrived (often it was opened first),
--               so filing it as one, as 113 planned, would read "Not sent" on the phone and "check
--               the address and send again" in the portal, which is the worst advice for someone the
--               customer just reported as spam. The portal shows it as "Marked as spam" instead. The
--               status vocabulary stays 'claimed','sent','failed','delivered','bounced'.
--   failed      Resend accepted the email (so the row reads 'sent'), then could not send it: a quota,
--               a domain problem (email.failed). status claimed/sent → failed, and `error` says why,
--               as it does for a send the API refused outright. A row already delivered or bounced
--               has a better answer and is left alone.
-- email.suppressed (an address on Resend's account-wide suppression list, skipped after the API
-- accepted it) arrives as 'bounced' with its own reason: postmark-events maps it, nothing here is
-- special to it.
-- "Earliest seen", not "first to arrive": a retried event can land after a later one, and the
-- earliest time is the one that is true.
--
-- ── IDEMPOTENT ───────────────────────────────────────────────────────────────────────────
-- Resend retries a webhook that failed and replays any message from its dashboard, succeeded ones
-- included. Every event therefore carries an id (Resend's `svix-id` header, which stays the same
-- across retries and replays), and the function writes it to email_send_events IN THE SAME
-- TRANSACTION as the update. An id it has already seen changes nothing and answers 'duplicate'.
-- Without that, every retried open would count twice. An event with no id at all (a hand-made test
-- post) is still recorded, without that protection.
--
-- An email id that matches no send (a dashboard test, mail sent before the ledger) answers
-- 'unknown' and writes nothing, not even the event id.
--
-- ── OPENS STOP COUNTING AT 25 ────────────────────────────────────────────────────────────
-- The tracking image's address is in the HTML of every email from a tracked domain, so anyone who
-- received or was forwarded one can fetch it in a loop, and Resend reports each fetch as its own
-- email.opened with a fresh svix-id (the idempotency key above cannot help). Uncapped, every fetch
-- would add an email_send_events row, lock and update the email_sends row, and push a realtime
-- broadcast to the builder's team (261's trigger). So once an email has 25 opens, a further open
-- answers 'capped' and writes NOTHING, not even its event id, which also makes a retry of a capped
-- event a no-op. 25 is far past anything a person does; the first open time is already set by then.
--
-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────
-- The live default ACL grants anon and authenticated privileges on every new table and EXECUTE on
-- every new function. So: email_send_events has RLS on, no policy, and nothing for public, anon
-- or authenticated; record_email_event is revoked from public, anon and authenticated and granted
-- to service_role only. It is SECURITY INVOKER with an empty search_path: it needs nothing the
-- service role does not already hold. email_sends itself is untouched (107's revoke stands, and
-- PART 4 checks the new columns too).
--
-- ── REALTIME ─────────────────────────────────────────────────────────────────────────────
-- 261's email_sends_phone_realtime trigger fires on every UPDATE of email_sends, so an open or a
-- delivery moves the phone app's bubble without a refresh: one ids-only broadcast to the team and
-- the contact's people, exactly like a send moving from claimed to sent. Nothing to add here.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. Three nullable/defaulted columns no existing writer
-- names (open_count's constant default is a catalog change, no table rewrite), a new table and a
-- new function nothing calls until postmark-events is redeployed. sendTenantEmail's claim insert
-- is unaffected: it names none of these columns. The apply waits at most 5 s for a lock
-- (lock_timeout), so it gives up rather than queue customers' emails behind it; retry it.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ Redeploy postmark-events, the portal functions and the Worker WITHOUT the 262 reads first,
-- or roll them back after (each falls back on "no such column", so the order is forgiving).
-- Dropping the columns deletes every recorded open and complaint.
--   begin;
--   drop function if exists public.record_email_event(text, text, timestamptz, text, text);
--   drop table if exists public.email_send_events;
--   alter table public.email_sends
--     drop constraint if exists email_sends_open_count_chk,
--     drop column if exists opened_at,
--     drop column if exists open_count,
--     drop column if exists complained_at;
--   -- delivered_at is 107's and stays.
--   delete from supabase_migrations.schema_migrations where version = '262';
--   notify pgrst, 'reload schema';
--   commit;
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — email_sends: the open, and the spam complaint
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- delivered_at is 107's; `if not exists` makes it a no-op here and keeps this file whole on a
-- database that somehow lacks it.
alter table public.email_sends
  add column if not exists delivered_at timestamptz,
  add column if not exists opened_at     timestamptz,
  add column if not exists open_count    integer not null default 0,
  add column if not exists complained_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'email_sends_open_count_chk'
                    and conrelid = 'public.email_sends'::regclass) then
    alter table public.email_sends
      add constraint email_sends_open_count_chk check (open_count >= 0);
  end if;
end $$;

comment on column public.email_sends.opened_at is
  'Migration 262: the earliest time Resend reported this email opened (email.opened, recorded by record_email_event). NULL until then. Approximate by nature: some mail apps block the tracking image, some open mail by themselves, and Resend counts opens only on a domain whose tracking subdomain is set up and verified.';
comment on column public.email_sends.open_count is
  'Migration 262: how many email.opened events Resend reported for this email, each counted once (email_send_events holds the ids), up to 25: anyone with the email can fetch its tracking image in a loop, so record_email_event stops counting there. 0 until the first.';
comment on column public.email_sends.complained_at is
  'Migration 262: the earliest time Resend reported the recipient marked this email as spam (email.complained). NULL if they never did. Not a bounce: the email arrived, so status and the bounce fields are left alone; the portal shows "Marked as spam" and the builder should not email them again.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — email_send_events: one row per provider event
-- ═════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.email_send_events (
  event_id      text primary key,
  email_send_id uuid not null references public.email_sends(id) on delete cascade,
  event         text not null,
  occurred_at   timestamptz not null,
  received_at   timestamptz not null default now(),
  constraint email_send_events_event_id_chk check (char_length(event_id) between 1 and 200),
  constraint email_send_events_event_chk check (event in ('delivered', 'opened', 'bounced', 'complained', 'failed'))
);

-- The cascade from email_sends looks rows up by the send.
create index if not exists email_send_events_send_idx on public.email_send_events (email_send_id);

alter table public.email_send_events enable row level security;
revoke all on public.email_send_events from public, anon, authenticated;
-- Explicit, rather than trusting the default ACL: record_email_event runs as its caller.
grant select, insert on public.email_send_events to service_role;

comment on table public.email_send_events is
  'Migration 262: every Resend delivery event record_email_event has applied, by the provider''s event id (the svix-id header), so a retry or a dashboard replay changes nothing. Ids and times only: no addresses, no message content. Service role only.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — record_email_event
-- ═════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.record_email_event(
  p_provider_message_id text,
  p_event               text,
  p_at                  timestamptz,
  p_reason              text default null,
  p_event_id            text default null
)
returns text
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_id    uuid;
  v_opens integer;
  v_at    timestamptz := coalesce(p_at, now());
begin
  if p_event is null or p_event not in ('delivered', 'opened', 'bounced', 'complained', 'failed') then
    raise exception 'record_email_event: unknown event %', p_event using errcode = '22023';
  end if;
  if coalesce(p_provider_message_id, '') = '' then
    return 'unknown';
  end if;

  -- The send. provider_message_id is Resend's email id, one per send (113's partial index serves
  -- this). FOR UPDATE: two events for one email — a delivery and an open, or a retry racing its
  -- original — take turns, so open_count never loses an increment and the earliest-time rule sees
  -- the other's write.
  select e.id, e.open_count into v_id, v_opens
    from public.email_sends e
   where e.provider_message_id = p_provider_message_id
   order by e.created_at
   limit 1
   for update;
  if v_id is null then
    return 'unknown';
  end if;

  -- Opens stop counting at 25 (see OPENS STOP COUNTING AT 25 above): anyone with the email can
  -- fetch the tracking image in a loop. Nothing is written, not even the event id. open_count
  -- >= 1 means opened_at is already set, so the email still reads as opened.
  if p_event = 'opened' and v_opens >= 25 then
    return 'capped';
  end if;

  -- Seen before: nothing changes. Written in this transaction, so the key and the update land
  -- together or not at all.
  if p_event_id is not null and p_event_id <> '' then
    insert into public.email_send_events (event_id, email_send_id, event, occurred_at)
    values (p_event_id, v_id, p_event, v_at)
    on conflict (event_id) do nothing;
    if not found then
      return 'duplicate';
    end if;
  end if;

  -- least() skips a NULL, so the first event sets the time and a later, earlier one wins.
  if p_event = 'delivered' then
    update public.email_sends
       set delivered_at = least(delivered_at, v_at),
           status       = case when status in ('claimed', 'sent') then 'delivered' else status end,
           updated_at   = now()
     where id = v_id;
  elsif p_event = 'opened' then
    update public.email_sends
       set opened_at  = least(opened_at, v_at),
           open_count = open_count + 1,
           updated_at = now()
     where id = v_id;
  elsif p_event = 'bounced' then
    update public.email_sends
       set bounced_at    = least(bounced_at, v_at),
           bounce_reason = coalesce(nullif(left(p_reason, 300), ''), bounce_reason, 'Bounce'),
           status        = 'bounced',
           updated_at    = now()
     where id = v_id;
  elsif p_event = 'failed' then
    -- Accepted, then not sent. Only a row still waiting on its answer moves: a delivery or a
    -- bounce already says more.
    update public.email_sends
       set status     = 'failed',
           error      = coalesce(nullif(left(p_reason, 300), ''), error, 'Not sent'),
           updated_at = now()
     where id = v_id
       and status in ('claimed', 'sent');
  else
    -- A complaint is not a bounce: the email arrived. Status and the bounce fields stay as they are.
    update public.email_sends
       set complained_at = least(complained_at, v_at),
           updated_at    = now()
     where id = v_id;
  end if;
  return 'recorded';
end
$fn$;

comment on function public.record_email_event(text, text, timestamptz, text, text) is
  'Migration 262: apply one Resend delivery event (delivered | opened | bounced | complained | failed) to the email_sends row whose provider_message_id it names. Returns ''recorded'', ''duplicate'' (the event id was seen before; nothing changed), ''capped'' (an open for an email that already has 25; nothing written) or ''unknown'' (no such send; nothing written). Times keep the earliest seen; an open counts once per event id, up to 25 per email. Called by the postmark-events function with the service role.';

revoke execute on function public.record_email_event(text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.record_email_event(text, text, timestamptz, text, text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — apply-time assertions. Each RAISE aborts the transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_role text;
  v_priv text;
  v_col  text;
  v_fn   constant text := 'public.record_email_event(text, text, timestamptz, text, text)';
begin
  -- ── The columns, with the types the readers expect ──
  if not exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = 'public.email_sends'::regclass and a.attname = 'opened_at'
                    and not a.attisdropped and not a.attnotnull
                    and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone') then
    raise exception '262: email_sends.opened_at is missing, not timestamptz, or NOT NULL';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute a
                  join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                  where a.attrelid = 'public.email_sends'::regclass and a.attname = 'open_count'
                    and not a.attisdropped and a.attnotnull
                    and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'integer'
                    and pg_catalog.pg_get_expr(d.adbin, d.adrelid) = '0') then
    raise exception '262: email_sends.open_count is missing, not integer NOT NULL DEFAULT 0';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = 'public.email_sends'::regclass and a.attname = 'delivered_at'
                    and not a.attisdropped
                    and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone') then
    raise exception '262: email_sends.delivered_at is missing';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = 'public.email_sends'::regclass and a.attname = 'complained_at'
                    and not a.attisdropped and not a.attnotnull
                    and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone') then
    raise exception '262: email_sends.complained_at is missing, not timestamptz, or NOT NULL';
  end if;

  -- ── Nothing here is the browser's ──
  foreach v_role in array array['anon','authenticated'] loop
    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if has_table_privilege(v_role, 'public.email_send_events', v_priv) then
        raise exception '262: % holds % on email_send_events', v_role, v_priv;
      end if;
      if has_table_privilege(v_role, 'public.email_sends', v_priv) then
        raise exception '262: % holds % on email_sends', v_role, v_priv;
      end if;
    end loop;
    foreach v_col in array array['opened_at','open_count','complained_at'] loop
      if has_column_privilege(v_role, 'public.email_sends', v_col, 'SELECT') then
        raise exception '262: % can read email_sends.%', v_role, v_col;
      end if;
    end loop;
    if has_function_privilege(v_role, v_fn, 'EXECUTE') then
      raise exception '262: % can call record_email_event', v_role;
    end if;
  end loop;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.email_send_events'::regclass) then
    raise exception '262: RLS is off on email_send_events';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.email_send_events'::regclass) then
    raise exception '262: email_send_events has a policy; it is meant to be service-role only';
  end if;

  -- ── The service role can do its job ──
  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception '262: service_role cannot call record_email_event — every event would fail';
  end if;
  foreach v_priv in array array['SELECT','INSERT'] loop
    if not has_table_privilege('service_role', 'public.email_send_events', v_priv) then
      raise exception '262: service_role lacks % on email_send_events', v_priv;
    end if;
  end loop;

  -- ── The function: an invoker with an empty search_path ──
  if not (select not p.prosecdef and p.proconfig @> array['search_path=""']
            from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure) then
    raise exception '262: record_email_event must be SECURITY INVOKER with an empty search_path';
  end if;

  -- ── An open has to reach the phone: 261's trigger on email_sends updates is in place ──
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgname = 'email_sends_phone_realtime' and t.tgrelid = 'public.email_sends'::regclass
                    and not t.tgisinternal and t.tgenabled = 'O' and (t.tgtype & 16) = 16) then
    raise exception '262: email_sends_phone_realtime (migration 261) is missing or does not fire on UPDATE — apply 261 first';
  end if;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 — behavioural probe. Synthetic rows, rolled back, leaves nothing.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- The tenant has no client_settings row, so 261's trigger sends nothing for it (no phone is told).
-- The addresses are example.test and the provider ids start 'probe-262-', which Resend never issues.
do $probe$
declare
  k_cid   constant text := 'email-opens-probe-262';
  k_addr  constant text := 'probe@example.test';
  t0      constant timestamptz := '2026-10-04 12:00:00+00';
  v_a     uuid;
  v_b     uuid;
  v_c     uuid;
  v_d     uuid;
  v_i     integer;
  v_n     integer;
  v_r     text;
  v_row   record;
  v_raised boolean;
begin
  begin
    insert into public.email_sends (client_id, kind, to_email, from_email, subject, status, provider_message_id)
    values (k_cid, 'test', k_addr, k_addr, 'Probe A', 'sent', 'probe-262-a')
    returning id into v_a;
    insert into public.email_sends (client_id, kind, to_email, from_email, subject, status, provider_message_id)
    values (k_cid, 'test', k_addr, k_addr, 'Probe B', 'sent', 'probe-262-b')
    returning id into v_b;

    -- ── 1. A delivery: recorded once, a replay changes nothing ──
    v_r := public.record_email_event('probe-262-a', 'delivered', t0, null, 'probe-262-ev-1');
    if v_r <> 'recorded' then raise exception '262 probe: a delivery answered %', v_r; end if;
    v_r := public.record_email_event('probe-262-a', 'delivered', t0 + interval '1 hour', null, 'probe-262-ev-1');
    if v_r <> 'duplicate' then raise exception '262 probe: a replayed delivery answered %', v_r; end if;
    select status, delivered_at into v_row from public.email_sends where id = v_a;
    if v_row.status <> 'delivered' or v_row.delivered_at <> t0 then
      raise exception '262 probe: after a delivery and its replay the row reads % at %', v_row.status, v_row.delivered_at;
    end if;

    -- ── 2. Opens: each id counts once, the earliest time wins (not the first or the last to
    --       arrive), status is left alone ──
    perform public.record_email_event('probe-262-a', 'opened', t0 + interval '2 hours', null, 'probe-262-ev-2');
    perform public.record_email_event('probe-262-a', 'opened', t0 + interval '1 hour', null, 'probe-262-ev-3');
    perform public.record_email_event('probe-262-a', 'opened', t0 + interval '3 hours', null, 'probe-262-ev-9');
    v_r := public.record_email_event('probe-262-a', 'opened', t0 + interval '2 hours', null, 'probe-262-ev-2');
    if v_r <> 'duplicate' then raise exception '262 probe: a retried open answered %', v_r; end if;
    select status, opened_at, open_count into v_row from public.email_sends where id = v_a;
    if v_row.open_count <> 3 or v_row.opened_at <> t0 + interval '1 hour' or v_row.status <> 'delivered' then
      raise exception '262 probe: three opens and a retry read count %, first %, status %', v_row.open_count, v_row.opened_at, v_row.status;
    end if;

    -- ── 3. A bounce wins, and a late delivery cannot undo it ──
    perform public.record_email_event('probe-262-b', 'bounced', t0, 'Permanent/General: probe', 'probe-262-ev-4');
    perform public.record_email_event('probe-262-b', 'delivered', t0 + interval '1 minute', null, 'probe-262-ev-5');
    select status, bounced_at, bounce_reason, delivered_at into v_row from public.email_sends where id = v_b;
    if v_row.status <> 'bounced' or v_row.bounced_at <> t0 or v_row.bounce_reason <> 'Permanent/General: probe'
       or v_row.delivered_at is null then
      raise exception '262 probe: a bounce then a delivery read % / % / %', v_row.status, v_row.bounced_at, v_row.bounce_reason;
    end if;

    -- ── 4. A complaint: complained_at (the earliest), and NOT a bounce: status and the bounce
    --       fields do not move ──
    update public.email_sends set status = 'delivered', bounced_at = null, bounce_reason = null where id = v_b;
    perform public.record_email_event('probe-262-b', 'complained', t0 + interval '5 minutes', null, 'probe-262-ev-6');
    perform public.record_email_event('probe-262-b', 'complained', t0 + interval '2 minutes', null, 'probe-262-ev-6b');
    perform public.record_email_event('probe-262-b', 'complained', t0 + interval '8 minutes', null, 'probe-262-ev-6c');
    select status, bounced_at, bounce_reason, complained_at into v_row from public.email_sends where id = v_b;
    if v_row.status <> 'delivered' or v_row.bounced_at is not null or v_row.bounce_reason is not null
       or v_row.complained_at is distinct from t0 + interval '2 minutes' then
      raise exception '262 probe: a complaint read % / % / % / %', v_row.status, v_row.bounced_at, v_row.bounce_reason, v_row.complained_at;
    end if;

    -- ── 4b. Opens stop counting at 25: the 26th answers 'capped' and writes nothing, not even
    --        its event id or an earlier time ──
    insert into public.email_sends (client_id, kind, to_email, from_email, subject, status, provider_message_id)
    values (k_cid, 'test', k_addr, k_addr, 'Probe C', 'sent', 'probe-262-c')
    returning id into v_c;
    for v_i in 1..25 loop
      v_r := public.record_email_event('probe-262-c', 'opened', t0 + make_interval(mins => v_i), null, 'probe-262-cap-' || v_i);
      if v_r <> 'recorded' then raise exception '262 probe: open % of 25 answered %', v_i, v_r; end if;
    end loop;
    v_r := public.record_email_event('probe-262-c', 'opened', t0 - interval '1 hour', null, 'probe-262-cap-26');
    if v_r <> 'capped' then raise exception '262 probe: the 26th open answered %', v_r; end if;
    select opened_at, open_count into v_row from public.email_sends where id = v_c;
    select count(*) into v_n from public.email_send_events where email_send_id = v_c and event = 'opened';
    if v_row.open_count <> 25 or v_n <> 25 or v_row.opened_at <> t0 + interval '1 minute' then
      raise exception '262 probe: 26 opens read count %, % event rows, first %', v_row.open_count, v_n, v_row.opened_at;
    end if;

    -- ── 4c. Accepted, then not sent (email.failed): sent → failed with the reason in `error`, and
    --        a late delivery does not undo it; a row already delivered is left alone ──
    insert into public.email_sends (client_id, kind, to_email, from_email, subject, status, provider_message_id)
    values (k_cid, 'test', k_addr, k_addr, 'Probe D', 'sent', 'probe-262-d')
    returning id into v_d;
    v_r := public.record_email_event('probe-262-d', 'failed', t0, 'Not sent: probe quota', 'probe-262-ev-f1');
    if v_r <> 'recorded' then raise exception '262 probe: a failure answered %', v_r; end if;
    perform public.record_email_event('probe-262-d', 'delivered', t0 + interval '1 minute', null, 'probe-262-ev-f2');
    select status, error into v_row from public.email_sends where id = v_d;
    if v_row.status <> 'failed' or v_row.error is distinct from 'Not sent: probe quota' then
      raise exception '262 probe: a failure after acceptance read % / %', v_row.status, v_row.error;
    end if;
    perform public.record_email_event('probe-262-a', 'failed', t0, 'Not sent: probe', 'probe-262-ev-f3');
    select status, error into v_row from public.email_sends where id = v_a;
    if v_row.status <> 'delivered' or v_row.error is not null then
      raise exception '262 probe: a failure undid a delivery: % / %', v_row.status, v_row.error;
    end if;

    -- ── 5. An email id nobody sent: 'unknown', and not even the event id is kept ──
    v_r := public.record_email_event('probe-262-nobody', 'opened', t0, null, 'probe-262-ev-7');
    if v_r <> 'unknown' then raise exception '262 probe: an unknown email id answered %', v_r; end if;
    if exists (select 1 from public.email_send_events where event_id = 'probe-262-ev-7') then
      raise exception '262 probe: an event for no send was kept';
    end if;

    -- ── 6. An event this file does not know is refused, not guessed at ──
    v_raised := false;
    begin
      perform public.record_email_event('probe-262-a', 'clicked', t0, null, 'probe-262-ev-8');
    exception when invalid_parameter_value then v_raised := true;
    end;
    if not v_raised then raise exception '262 probe: an unknown event type was accepted'; end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '262 probe: deliveries, opens, bounces, complaints and failures recorded once each, earliest time kept, a bounce or a failure outranks a delivery, opens stop at 25, an unknown email id writes nothing; nothing was kept';
      else
        raise;
      end if;
  end;

  if exists (select 1 from public.email_sends e where e.client_id = k_cid)
     or exists (select 1 from public.email_send_events e where e.event_id like 'probe-262-%') then
    raise exception '262 probe: synthetic rows were left behind';
  end if;
end
$probe$;

notify pgrst, 'reload schema';

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. Record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('262', '262_email_opens');
-- B. Every row starts unopened:
--      select count(*) filter (where opened_at is not null) opened, min(open_count), max(open_count) from public.email_sends;   -- 0, 0, 0
-- C. Then deploy postmark-events, then create the Resend webhook (deploy notes). After the first
--    test email is opened:
--      select status, delivered_at, opened_at, open_count from public.email_sends order by created_at desc limit 3;
--      select event, occurred_at from public.email_send_events order by received_at desc limit 5;
