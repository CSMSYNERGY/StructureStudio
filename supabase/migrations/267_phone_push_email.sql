-- 267_phone_push_email.sql — My Synergy Phone email alerts: a customer's new email to a business
--                           whose phone is on asks the phone-api Worker (/push/email) to alert
--                           the people who own that customer, as a text already does (256).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. The file carries its own
--    begin;/commit; so every assertion below takes the whole migration with it if it fails.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Since 261 (2026-10-03) the phone app shows a contact's emails in the same conversation as their
-- texts, and while the app is open a reply arrives live. A closed app heard nothing: only texts
-- had a push (256), and the app said so itself ("A closed app gets no alert for an email yet").
-- The Unified Conversation Plan (2026-10-03, open question 3) left it for v1.1: "an email twin of
-- phone_push_text plus a Worker /push/email". This file is that twin.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   public.phone_push_email_notify(): 256's function, aimed at email_inbound
--   PART 2   trigger phone_push_email, AFTER INSERT on email_inbound, for each row
--   PART 3   apply-time assertions (they RAISE and abort the transaction)
--   PART 4   a behavioural probe on synthetic rows, rolled back, leaving nothing
--   after commit: recording the row, verification, as comments
--
-- ── WHAT IT SENDS: IDS ONLY ──────────────────────────────────────────────────────────────
-- {type:'INSERT', table:'email_inbound', schema:'public', record:{id, client_id}} and nothing else
-- of the row: not the subject, not the sender, never body_text or body_html (up to 200 KB). A
-- request waits in net.http_request_queue until pg_net sends it (256's header has the detail on
-- that table), so no customer's words ever sit there. The Worker finds the row again by id AND
-- client_id with the service role, and everything an alert shows comes from that read
-- (workers/phone-api/src/routes/push.ts, deliverEmail). The secret is 256's Vault secret,
-- 'sss_phone_push_secret', which the Worker already checks for /push/text: nothing new to create.
--
-- ── WHO IS TOLD (the Worker decides; this only drops what can never alert anyone) ────────
-- The trigger posts only a business's own mail (not '__unattributed__'), filed on a contact or on
-- a design, at a business whose phone is on. The Worker then:
--   1. skips a sender the provider said failed SPF, DKIM or DMARC, or flagged as spam
--      (_shared/crmFeed.ts senderVerifiedFrom). No verdict at all still alerts;
--   2. finds the contact, the row's own or its design's, within the business (261's rule), and
--      skips mail whose contact isn't one of the business's;
--   3. alerts the same people a text from that contact would: its owner, else everyone with phone
--      access who can see the contact. The alert reads the contact's name over
--      "Email: <subject>", on the app's existing Android channel ("texts").
-- The app opens the contact's conversation on a tap with the build it already has: it opens
-- `thread_key` whatever the alert's `type`.
--
-- ── SAFETY (256's, unchanged) ────────────────────────────────────────────────────────────
-- pg_net queues the request and returns at once, so the email's INSERT never waits on the network;
-- any error inside the trigger is swallowed (WARNING only), so an alert can never block or roll
-- back storing a customer's email. A provider retry that hits email_inbound_message_uniq inserts
-- no row, so it fires nothing and nobody is alerted twice. INSERT is the only event: email-inbound
-- writes a row once (135), and the only later change, a contact merge re-pointing it (192), is
-- not news to anyone.
-- Do NOT also create a Dashboard "Database Webhook" on email_inbound → /push/email: this trigger
-- IS that webhook, and a second one doubles every alert (and stores the secret in plain text).
-- Never add the `net` schema to the API's exposed schemas.
--
-- ── LOCKS ────────────────────────────────────────────────────────────────────────────────
-- The apply waits at most 3 s for email_inbound (lock_timeout), so it can never queue customers'
-- mail behind it; retry it. The function carries 256's own 1 s lock_timeout, so a lock wait
-- inside it becomes a caught 55P03 long before the callers' statement_timeout (57014, which
-- `when others` cannot catch).
--
-- ── NUMBERING AND ORDER ──────────────────────────────────────────────────────────────────
-- Needs 135 (email_inbound) and 256 (pg_net and the Vault secret). PART 3 checks the table and
-- pg_net; PART 4 says whether the secret is there. It re-issues no earlier function, so it does not care whether 262–266 are in yet. Before applying,
-- read the live ledger: `select version from supabase_migrations.schema_migrations order by 1
-- desc limit 3;` must not already show 267.
-- 1. Deploy the phone-api Worker with /push/email FIRST. Until it is live every alert this asks
--    for is a 404 at the Worker: harmless, but nobody is alerted.
-- 2. The app's privacy policy must say what an email alert shows (the contact's name and the
--    subject) before this is applied: phone repo site/public/my-synergy-phone/privacy.html, live
--    through the site Worker. Ahsan checks Play's Data safety form declares Emails.
-- 3. Then apply this.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   drop trigger if exists phone_push_email on public.email_inbound;
--   drop function if exists public.phone_push_email_notify();
--   delete from supabase_migrations.schema_migrations where version = '267';
-- Texts keep their alerts (256 is untouched), and the Worker's /push/email just stops being called.

begin;

set local lock_timeout = '3s';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the function (256's phone_push_text_notify, aimed at email_inbound)
-- ═════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.phone_push_email_notify()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set lock_timeout = '1s'
as $$
declare
  v_secret text;
begin
  -- Mail no business could be found for, and mail filed on nobody: no conversation to open.
  if new.client_id = '__unattributed__' then
    return new;
  end if;
  if new.contact_id is null and new.short_code is null then
    return new;
  end if;
  if not exists (
    select 1 from public.client_settings cs
     where cs.client_id = new.client_id and cs.phone_status = 'on'
  ) then
    return new;
  end if;

  select ds.decrypted_secret into v_secret
    from vault.decrypted_secrets ds
   where ds.name = 'sss_phone_push_secret'
   limit 1;
  if v_secret is null or v_secret = '' then
    return new;
  end if;

  -- Ids only. The Worker reads everything else from the table.
  perform net.http_post(
    url := 'https://phone.structurestudiosuite.com/push/email',
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'email_inbound',
      'schema', 'public',
      'record', jsonb_build_object('id', new.id, 'client_id', new.client_id)
    ),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-push-secret', v_secret
    ),
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  raise warning 'phone_push_email_notify: % (%)', sqlerrm, sqlstate;
  return new;
end;
$$;

comment on function public.phone_push_email_notify() is
  'SSS Phone (migration 267): posts {id, client_id} of a new email_inbound row, filed on a contact or a design of a business whose phone is on, to phone-api /push/email (secret from Vault, as 256). Never blocks or fails the insert.';

revoke all on function public.phone_push_email_notify() from public, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — the trigger
-- ═════════════════════════════════════════════════════════════════════════════════════════
drop trigger if exists phone_push_email on public.email_inbound;
create trigger phone_push_email
  after insert on public.email_inbound
  for each row execute function public.phone_push_email_notify();

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — apply-time assertions. Each RAISE aborts the transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_fn  constant text := 'public.phone_push_email_notify()';
  v_src text;
  v_cfg text[];
begin
  -- ── What it stands on: 256's pg_net function and the table ──
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception '267: net.http_post is missing; apply 256 (pg_net) first';
  end if;
  if to_regclass('public.email_inbound') is null then
    raise exception '267: public.email_inbound is missing (135)';
  end if;

  -- ── The function: a definer with 256's settings, nobody's to call, ids only ──
  select p.prosrc, p.proconfig into v_src, v_cfg
    from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure;
  if not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure) then
    raise exception '267: phone_push_email_notify is not SECURITY DEFINER (it reads Vault)';
  end if;
  if not (coalesce(v_cfg, '{}') @> array['lock_timeout=1s', 'search_path=public, extensions, pg_temp']) then
    raise exception '267: phone_push_email_notify lost its 1 s lock_timeout or its search_path (%)', v_cfg;
  end if;
  if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception '267: browser roles can execute phone_push_email_notify';
  end if;
  if position('https://phone.structurestudiosuite.com/push/email' in v_src) = 0 then
    raise exception '267: phone_push_email_notify does not post to /push/email';
  end if;
  if position('''__unattributed__''' in v_src) = 0 then
    raise exception '267: phone_push_email_notify does not skip unattributed mail';
  end if;
  -- PART 4 proves the posted body is ids only; this catches the obvious ways to undo that.
  if position('to_jsonb(' in v_src) > 0 or position('row_to_json(' in v_src) > 0
     or position('body_' in v_src) > 0 or position('new.subject' in v_src) > 0 then
    raise exception '267: phone_push_email_notify posts more of the row than its ids';
  end if;

  -- ── The trigger: AFTER INSERT FOR EACH ROW, enabled, and only once.
  --    tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update. ──
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgname = 'phone_push_email' and t.tgrelid = 'public.email_inbound'::regclass
                    and not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = v_fn::regprocedure
                    and t.tgtype = 1 + 4) then
    raise exception '267: phone_push_email is missing, disabled, or not AFTER INSERT FOR EACH ROW';
  end if;
  if (select count(*) from pg_catalog.pg_trigger t
       where not t.tgisinternal and t.tgfoid = v_fn::regprocedure) <> 1 then
    raise exception '267: phone_push_email_notify fires from more than one trigger; every alert would go out twice';
  end if;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — behavioural probe. Synthetic rows, rolled back, leaves nothing.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 261's pattern: write synthetic mail through the real trigger, read what it queued, then raise
-- ROLLBACK_PROBE so every write in the inner block vanishes. That includes the queued requests:
-- pg_net sends only rows that are COMMITTED in net.http_request_queue, so the Worker never hears
-- of them and no phone is alerted. The business ids, the address and the design code are
-- obviously fake (the code contains O and 1, which the short-code alphabet leaves out, migration
-- 002), and the contact ids are random: the trigger never looks them up.
--
-- The checks on what was queued run only when the Vault secret exists. Without it the trigger
-- posts nothing (as 256 does), and the probe checks exactly that and says so.
do $probe$
declare
  k_on    constant text := 'phone-push-email-probe-267';
  k_off   constant text := 'phone-push-email-probe-267-off';
  k_url   constant text := 'https://phone.structurestudiosuite.com/push/email';
  k_addr  constant text := 'probe@example.test';
  v_armed boolean;
  v_loud  uuid[] := '{}';
  v_quiet uuid[] := '{}';
  v_id    uuid;
  v_loud_n  integer;
  v_quiet_n integer;
  v_bad   integer;
begin
  begin
    v_armed := exists (select 1 from vault.decrypted_secrets ds
                        where ds.name = 'sss_phone_push_secret' and coalesce(ds.decrypted_secret, '') <> '');

    insert into public.client_settings (client_id, phone_status, business_name)
    values (k_on, 'on', 'Probe Sheds'), (k_off, 'off', 'Quiet Probe Sheds');

    -- ── 1. Two that post: mail on a contact, and mail on a design by its code alone ──
    insert into public.email_inbound (client_id, contact_id, from_email, from_name, subject, body_text, body_html)
    values (k_on, gen_random_uuid(), k_addr, 'Probe Sender', 'Probe 267 subject', 'Probe 267 words', '<p>Probe 267 words</p>')
    returning id into v_id;
    v_loud := v_loud || v_id;
    insert into public.email_inbound (client_id, short_code, from_email, subject)
    values (k_on, 'SS-PROBE1267', k_addr, 'Probe 267 quote reply')
    returning id into v_id;
    v_loud := v_loud || v_id;

    -- ── 2. Three that don't: filed on nobody, a business whose phone is off, unattributed ──
    insert into public.email_inbound (client_id, from_email, subject)
    values (k_on, k_addr, 'Probe 267 nobody')
    returning id into v_id;
    v_quiet := v_quiet || v_id;
    insert into public.email_inbound (client_id, contact_id, from_email, subject)
    values (k_off, gen_random_uuid(), k_addr, 'Probe 267 phone off')
    returning id into v_id;
    v_quiet := v_quiet || v_id;
    insert into public.email_inbound (client_id, contact_id, from_email, subject)
    values ('__unattributed__', gen_random_uuid(), k_addr, 'Probe 267 unattributed')
    returning id into v_id;
    v_quiet := v_quiet || v_id;

    -- ── 3. Every email was stored, alert or not ──
    if (select count(*) from public.email_inbound e where e.id = any(v_loud || v_quiet)) <> 5 then
      raise exception '267 probe: an email was not stored';
    end if;

    -- ── 4. What the trigger queued for them ──
    select count(*) filter (where (s.b #>> '{record,id}') = any(v_loud::text[])),
           count(*) filter (where (s.b #>> '{record,id}') = any(v_quiet::text[]))
      into v_loud_n, v_quiet_n
      from (select convert_from(q.body, 'UTF8')::jsonb as b
              from net.http_request_queue q where q.url = k_url) s;
    if v_quiet_n <> 0 then
      raise exception '267 probe: mail filed on nobody, at a business whose phone is off, or unattributed was posted (%)', v_quiet_n;
    end if;

    if not v_armed then
      if v_loud_n <> 0 then
        raise exception '267 probe: with no Vault secret the trigger still posted (%)', v_loud_n;
      end if;
      raise notice '267 probe: Vault has no sss_phone_push_secret, so the trigger posts nothing (as 256); the checks on what it posts were skipped. Every email above was still stored. Create the secret (workers/phone-api/SETUP.md section 6) and re-run this probe to see them.';
    else
      if v_loud_n <> 2 then
        raise exception '267 probe: mail on a contact and mail on a design should post once each, not % in all', v_loud_n;
      end if;
      -- Exactly the webhook the Worker expects, and nothing of the row but its ids.
      select count(*) into v_bad
        from (select q.method, q.headers, q.timeout_milliseconds, convert_from(q.body, 'UTF8')::jsonb as b
                from net.http_request_queue q where q.url = k_url) s
       where (s.b #>> '{record,id}') = any(v_loud::text[])
         and (s.method is distinct from 'POST'
              or s.timeout_milliseconds is distinct from 5000
              or (select array_agg(k order by k) from jsonb_object_keys(s.headers) as k) is distinct from array['content-type', 'x-push-secret']
              or s.headers ->> 'content-type' is distinct from 'application/json'
              or coalesce(s.headers ->> 'x-push-secret', '') = ''
              or (select array_agg(k order by k) from jsonb_object_keys(s.b) as k) is distinct from array['record', 'schema', 'table', 'type']
              or s.b ->> 'type' is distinct from 'INSERT' or s.b ->> 'table' is distinct from 'email_inbound'
              or s.b ->> 'schema' is distinct from 'public'
              or case when jsonb_typeof(s.b -> 'record') = 'object'
                      then (select array_agg(k order by k) from jsonb_object_keys(s.b -> 'record') as k)
                           is distinct from array['client_id', 'id']
                      else true end
              or s.b #>> '{record,client_id}' is distinct from k_on);
      if v_bad <> 0 then
        raise exception '267 probe: % posted request(s) are not {type, table, schema, record:{id, client_id}} with the secret header', v_bad;
      end if;
      if exists (select 1 from net.http_request_queue q
                  where q.url = k_url and convert_from(q.body, 'UTF8') like '%Probe 267 %') then
        raise exception '267 probe: a posted request carries the email''s subject or words';
      end if;
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        if v_armed then
          raise notice '267 probe: mail on a contact and mail on a design each posted one ids-only request to /push/email with the secret header; mail filed on nobody, at a business whose phone is off and unattributed mail posted nothing; every email was stored; nothing was kept';
        else
          raise notice '267 probe: every email was stored and nothing was posted; nothing was kept';
        end if;
      else
        raise;
      end if;
  end;

  if exists (select 1 from public.client_settings s where s.client_id in (k_on, k_off))
     or exists (select 1 from public.email_inbound e where e.id = any(v_loud || v_quiet))
     or exists (select 1 from net.http_request_queue q
                 where q.url = k_url and (convert_from(q.body, 'UTF8')::jsonb #>> '{record,id}') = any((v_loud || v_quiet)::text[])) then
    raise exception '267 probe: synthetic rows were left behind';
  end if;
end
$probe$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. Record it (returning, so a row someone else already wrote shows up as an error, not silence):
--      insert into supabase_migrations.schema_migrations (version, name)
--      values ('267', '267_phone_push_email') returning version;
-- B. The trigger is there, once, beside 261's live-update trigger:
--      select tgname, tgenabled from pg_trigger
--       where tgrelid = 'public.email_inbound'::regclass and not tgisinternal order by 1;
--      -- email_inbound_phone_realtime O, phone_push_email O
--      select position('/push/email' in pg_get_functiondef('public.phone_push_email_notify()'::regprocedure)) > 0;   -- true
-- C. The first real reply: pg_net keeps the Worker's answer for about 6 hours. Read the status
--    only (the response body is the Worker's 204, never an email):
--      select status_code, count(*) from net._http_response
--       where created > now() - interval '1 hour' group by 1;
--    A 204 is the Worker taking it; a 404 means the Worker without /push/email is still live.
