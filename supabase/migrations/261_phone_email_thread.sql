-- 261_phone_email_thread.sql — My Synergy Phone, one conversation per contact: a sent email keeps
--                              its words, and email joins the phone's live updates.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. The file carries its own
--    begin;/commit; so every assertion below takes the whole migration with it if it fails.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- The phone app is getting one conversation per contact: texts, emails and calls in a single
-- list, each bubble labelled SMS or Email, with an [SMS | Email] switch in the composer (Ahsan,
-- 2026-10-02: "we should see whole conversation in a single tab just if it is an sms it should
-- say sms and if it is an email it should say email similar to what ghl has"). The plan is
-- _Extras/My Synergy Phone Unified Conversation Plan 2026-10-03.md (vault); this file is its
-- section 1, "Migration".
--
-- Two things stood in the way, and this file removes both:
--   * email_sends kept the SUBJECT of a sent email and nothing else. The words went to Resend
--     and nowhere we could read them back, so a conversation could show what the customer
--     wrote (email_inbound.body_text, 135) but never what we wrote back. PART 1 adds body_text,
--     and with it sent_by (who wrote it) and client_temp_id (the app's pending-bubble id, so the
--     confirmed row replaces the bubble instead of showing twice — sms_messages has had the same
--     column since 254).
--   * The phone hears about new texts and calls through phone_realtime_notify (254 PART 7), and
--     about email not at all. PART 2 gives that function an email branch and PART 3 hangs it on
--     email_sends and email_inbound, so a customer's reply shows up in the open thread live.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- The plan calls this 259. 259 (usage_billing) and 260 (phone_call_handoff) were applied live
-- by another session before this was written, and are not on origin/beta yet. Check the live
-- list before applying: `select version from supabase_migrations.schema_migrations order by 1
-- desc limit 3;` must not already show 261.
--
-- ── WRITE ORDER: THIS FILE FIRST, THEN THE FUNCTIONS (they survive the other order) ─────
-- _shared/emailSend.ts (sendTenantEmail) writes the three new columns on its claim insert
-- whenever the caller gives them, and _shared/crmFeed.ts reads body_text for the record page's
-- History. Both TOLERATE being deployed before this file: on "no such column" (42703 /
-- PGRST204) the claim is written again without the three keys, with one info row in app_errors
-- (email_ledger_261_columns_missing), and the feed reads again without body_text. So a
-- conversation or test email still sends and still lands on its contact, and the History keeps
-- every sent email; only the stored words, the writer and the bubble id are missing until this
-- is applied. Document mail (quotes, invoices, change orders, receipts) passes none of them and
-- never notices. The intended order is still: apply this, then deploy portal-settings,
-- submit-estimate and customer-accept (all three bundle emailSend.ts), then the phone-api
-- Worker, which reads body_text and has no fallback. Deploy them only from a tree that has
-- origin/beta merged in (or from beta itself): a tree cut before 259 and 260 were merged would
-- put back older copies of those functions and of the Worker. The notify at the end makes
-- PostgREST reload its schema cache at commit, so the columns are writable through the API the
-- moment this lands.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   email_sends.body_text, sent_by, client_temp_id, with two length CHECKs added
--            NOT VALID and then validated
--   PART 2   phone_realtime_notify() re-issued: the LIVE body plus one branch for email
--   PART 3   email_sends_phone_realtime    AFTER INSERT OR UPDATE on email_sends
--            email_inbound_phone_realtime  AFTER INSERT on email_inbound
--   PART 4   apply-time assertions (they RAISE and abort the transaction)
--   PART 5   a behavioural probe on synthetic rows, rolled back, leaving nothing
--
-- ── PART 2 IS THE LIVE BODY, NOT 254's FILE ──────────────────────────────────────────────
-- 260 was applied by another session, so the body was read from the live database
-- (pg_get_functiondef, 2026-10-03) rather than trusted from 254. It was identical to 254's
-- text apart from CR-LF line endings, so 260 did not touch it. The edits here are exactly: the
-- email branch, "or an email" in the comment above the loop, and the function comment.
-- Everything 254 promised still holds and is not re-explained here: ids-only payloads on private
-- topics, nothing for a tenant whose phone_status is not 'on', and an exception block that turns
-- any failure into a WARNING so a broadcast can never fail the write that fired it.
--
-- ── WHAT AN EMAIL EVENT IS ───────────────────────────────────────────────────────────────
-- Event `email`, payload {table, op, id, contact_id} exactly as for texts, table being
-- email_sends or email_inbound. It goes to phone:<client_id>, and to phone:user:<id> for the
-- contact's owner and, on email_sends, sent_by.
--   * The contact is the row's own contact_id, else the contact of the design it is about: a
--     quote, invoice or receipt carries only short_code. That contact also goes in the payload,
--     so the app refreshes the right thread.
--   * NO CONTACT, NO EVENT. The phone shows email only inside a contact's conversation, so an
--     email that belongs to nobody (an unmatched reply, a test to a stranger, a quote on a design
--     with no contact) would only make every phone on the team refresh for nothing.
--   * Unattributed inbound mail (client_id '__unattributed__') has no client_settings row, so the
--     phone_status check drops it before the branch is reached.
--
-- ── CHOICES THE PLAN LEFT OPEN ───────────────────────────────────────────────────────────
--   1. A customer's sign-in code (kind 'login_code', 167) is never broadcast. The phone-api
--      Worker never shows one, so its event could only refresh a thread for nothing — and it
--      would tell the contact's owner, live, that their customer is signing in.
--   2. On an UPDATE the OLD row's people are told too, as 254 does for texts, so an email
--      re-pointed by a contact merge (192) leaves the list it used to be in.
--   3. The CHECKs are char_length limits (code points, so an emoji is one): body_text up to
--      20,000, which is what crm_send_email already cuts a body to, and client_temp_id up to 64,
--      the length portal-settings accepts. sendTenantEmail never writes a value past either
--      (it cuts body_text to 20,000 and leaves off a client_temp_id of the wrong shape), because
--      a refused claim insert means an email that is not sent. These are the backstop.
--   4. NOT VALID then VALIDATE, as the plan asks. Inside one transaction that buys nothing on
--      locks — ADD COLUMN's ACCESS EXCLUSIVE lock is held to commit either way — and costs
--      nothing either: every existing row (52 live on 2026-10-03) is NULL in both columns. It is
--      kept so the pattern is already right if the file is ever split.
--   5. No foreign key on sent_by, like 254's user columns: a person removed from the team keeps
--      their authorship. No index on client_temp_id: nothing looks rows up by it; the app matches
--      it inside a thread it has already read.
--
-- ── GRANTS: NOTHING TO DO, AND PART 4 PROVES IT ──────────────────────────────────────────
-- email_sends has RLS on, zero policies, and no grant at all to anon or authenticated (107's
-- revoke; checked live 2026-10-03). New columns inherit the table's privileges, so the stored
-- email bodies are readable by the service role only. PART 4 asserts that, column by column.
-- email_inbound is not altered (135's authenticated read, by tenant, stays as it is).
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. Three nullable columns that no existing writer
-- names; a trigger function that behaves exactly as before for the three tables it already
-- serves; and two triggers that send nothing for a tenant whose phone is off — every tenant but
-- the ones switched on — and can never fail an email write. The apply waits at most 5 s for a
-- lock (lock_timeout), so it gives up rather than queue customers' emails behind it; retry it.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ Deploy portal-settings, submit-estimate and customer-accept WITHOUT the new columns first
-- (sendTenantEmail writes them; see WRITE ORDER), or conversation and test emails stop. Dropping
-- the columns deletes every stored email body.
--   begin;
--   drop trigger if exists email_inbound_phone_realtime on public.email_inbound;
--   drop trigger if exists email_sends_phone_realtime on public.email_sends;
--   -- Optional: re-run 254 PART 7's `create or replace function public.phone_realtime_notify()`.
--   -- With the triggers gone the email branch never runs.
--   alter table public.email_sends
--     drop constraint if exists email_sends_body_text_chk,
--     drop constraint if exists email_sends_client_temp_id_chk,
--     drop column if exists body_text,
--     drop column if exists sent_by,
--     drop column if exists client_temp_id;
--   delete from supabase_migrations.schema_migrations where version = '261';
--   notify pgrst, 'reload schema';
--   commit;
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — email_sends keeps the words, the writer and the app's bubble id
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.email_sends
  add column if not exists body_text      text,
  add column if not exists sent_by        uuid,
  add column if not exists client_temp_id text;

-- Choice 3 and 4: added NOT VALID once, then validated (a no-op once it is valid, so a re-apply
-- passes straight through).
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'email_sends_body_text_chk'
                    and conrelid = 'public.email_sends'::regclass) then
    alter table public.email_sends
      add constraint email_sends_body_text_chk
      check (body_text is null or char_length(body_text) <= 20000) not valid;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'email_sends_client_temp_id_chk'
                    and conrelid = 'public.email_sends'::regclass) then
    alter table public.email_sends
      add constraint email_sends_client_temp_id_chk
      check (client_temp_id is null or char_length(client_temp_id) <= 64) not valid;
  end if;
end $$;

alter table public.email_sends validate constraint email_sends_body_text_chk;
alter table public.email_sends validate constraint email_sends_client_temp_id_chk;

comment on column public.email_sends.body_text is
  'Migration 261: the plain-text words of a conversation email, as the person typed them (crm_send_email passes them; document mail leaves this NULL, its words are a template). Shown in the phone app''s conversation and on the record page. Up to 20,000 characters. NULL on every email sent before 261. Service-role only, like the whole table.';
comment on column public.email_sends.sent_by is
  'Migration 261: the auth user who wrote and sent this email, from the caller''s session, never from a request body. NULL for automatic mail (quotes from the designer, receipts) and for everything sent before 261.';
comment on column public.email_sends.client_temp_id is
  'Migration 261: the id the phone app gave its pending bubble (^[A-Za-z0-9_-]{1,64}$), so the confirmed row replaces it instead of showing twice. The same job as sms_messages.client_temp_id (254).';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — phone_realtime_notify: the live body, plus email
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- See the header: copied from the live pg_get_functiondef (2026-10-03, identical to 254's text),
-- with the email branch added. SECURITY DEFINER and search_path '' as before; it now also reads
-- designs (the contact of a quote or invoice email) and still writes nothing but
-- realtime.messages.
create or replace function public.phone_realtime_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row       jsonb;
  v_old       jsonb;
  v_client_id text;
  v_status    text;
  v_event     text;
  v_contact   jsonb;
  v_snap      jsonb;
  v_snaps     jsonb[] := '{}';
  v_ids       uuid[]  := '{}';
  v_owner     uuid;
  v_users     uuid[];
  v_payload   jsonb;
  v_uid       uuid;
begin
  begin
    if tg_op = 'DELETE' then
      v_row := to_jsonb(old);
    else
      v_row := to_jsonb(new);
      if tg_op = 'UPDATE' then
        v_old := to_jsonb(old);
      end if;
    end if;

    v_client_id := v_row ->> 'client_id';
    if v_client_id is null then
      return null;
    end if;

    -- DEVIATION 4: nothing is broadcast for a tenant that has not been switched on.
    select cs.phone_status into v_status
      from public.client_settings cs
     where cs.client_id = v_client_id;
    if v_status is distinct from 'on' then
      return null;
    end if;

    -- Which rows say who this belongs to. A voicemail has no people of its own: it belongs
    -- to its call's people (plan §7), and its contact is the call's.
    if tg_table_name = 'phone_calls' then
      v_event   := 'call';
      v_contact := v_row -> 'contact_id';
      v_snaps   := array[v_row];
      if v_old is not null then v_snaps := v_snaps || v_old; end if;
    elsif tg_table_name = 'phone_voicemails' then
      v_event := 'voicemail';
      select to_jsonb(c) into v_snap
        from public.phone_calls c
       where c.id = (v_row ->> 'call_id')::uuid;
      if v_snap is not null then
        v_contact := v_snap -> 'contact_id';
        v_snaps   := array[v_snap];
      end if;
    elsif tg_table_name = 'sms_messages' then
      v_event   := 'sms';
      v_contact := v_row -> 'contact_id';
      v_snaps   := array[v_row];
      if v_old is not null then v_snaps := v_snaps || v_old; end if;
    elsif tg_table_name in ('email_sends', 'email_inbound') then
      -- 261. A sign-in code is never part of a conversation (261 choice 1).
      if v_row ->> 'kind' = 'login_code' then
        return null;
      end if;
      v_event   := 'email';
      -- The row's own contact, else the contact of the design it is about: a quote, invoice or
      -- receipt carries only short_code. Within this tenant only, like the owner lookup below.
      v_contact := v_row -> 'contact_id';
      if v_row ->> 'contact_id' is null and v_row ->> 'short_code' is not null then
        select to_jsonb(d.contact_id) into v_contact
          from public.designs d
         where d.client_id = v_client_id
           and d.short_code = v_row ->> 'short_code';
      end if;
      -- No contact, no event: the phone shows email only inside a contact's conversation.
      if v_contact is null or jsonb_typeof(v_contact) = 'null' then
        return null;
      end if;
      -- The resolved contact rides on the snapshot, so the loop below tells its owner.
      v_snaps := array[v_row || jsonb_build_object('contact_id', v_contact)];
      if v_old is not null then v_snaps := v_snaps || v_old; end if;
    else
      return null;
    end if;

    -- The people. Keys a table does not have read as NULL and fall out below, which is what
    -- lets one loop serve both a call (placed_by, answered_by, transferred_from,
    -- rang_user_ids) and a text or an email (sent_by).
    foreach v_snap in array v_snaps loop
      v_ids := v_ids || array[
        (v_snap ->> 'placed_by')::uuid,
        (v_snap ->> 'answered_by')::uuid,
        (v_snap ->> 'transferred_from')::uuid,
        (v_snap ->> 'sent_by')::uuid
      ];
      if jsonb_typeof(v_snap -> 'rang_user_ids') = 'array' then
        v_ids := v_ids || array(select x::uuid
                                  from jsonb_array_elements_text(v_snap -> 'rang_user_ids') as r(x));
      end if;
      -- The contact's owner, within this tenant only: a mis-linked contact id must not tell
      -- another builder's staff that anything happened.
      if (v_snap ->> 'contact_id') is not null then
        select c.owner_user_id into v_owner
          from public.crm_contacts c
         where c.id = (v_snap ->> 'contact_id')::uuid
           and c.client_id = v_client_id;
        v_ids := v_ids || v_owner;
      end if;
    end loop;

    select coalesce(array_agg(distinct u), '{}'::uuid[]) into v_users
      from unnest(v_ids) as u
     where u is not null;

    -- IDS ONLY. Broadcast from the database skips table RLS, so nothing else rides along.
    v_payload := jsonb_build_object(
      'table',      tg_table_name,
      'op',         tg_op,
      'id',         v_row -> 'id',
      'contact_id', v_contact
    );

    perform realtime.send(v_payload, v_event, 'phone:' || v_client_id, true);
    foreach v_uid in array v_users loop
      perform realtime.send(v_payload, v_event, 'phone:user:' || v_uid::text, true);
    end loop;
  exception
    when others then
      raise warning 'phone_realtime_notify(%): % (%)', tg_table_name, sqlerrm, sqlstate;
  end;
  return null;  -- AFTER trigger; the return value is ignored
end
$fn$;

comment on function public.phone_realtime_notify() is
  'SSS Phone (migrations 254, 261): AFTER trigger on phone_calls, phone_voicemails, sms_messages, email_sends and email_inbound. Sends {table, op, id, contact_id} with realtime.send(..., private => true) on phone:<client_id> and on phone:user:<id> for each of the row''s people, only while the tenant''s phone_status is on. An email''s contact is its own contact_id, else its design''s; an email with no contact, and a login code, send nothing. Never fails the write: every error becomes a WARNING.';

revoke execute on function public.phone_realtime_notify() from public, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — the two email triggers
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- email_sends: INSERT is the claim row ("sending"), and an UPDATE is where it becomes sent or
-- failed, so the app's bubble moves on without a refresh. No DELETE: nothing deletes sent mail.
drop trigger if exists email_sends_phone_realtime on public.email_sends;
create trigger email_sends_phone_realtime
  after insert or update on public.email_sends
  for each row execute function public.phone_realtime_notify();

-- email_inbound: a reply arrives once and is never edited by the webhook (135).
drop trigger if exists email_inbound_phone_realtime on public.email_inbound;
create trigger email_inbound_phone_realtime
  after insert on public.email_inbound
  for each row execute function public.phone_realtime_notify();

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — apply-time assertions. Each RAISE aborts the transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_col  text;
  v_type text;
  v_role text;
  v_priv text;
  v_fn   constant text := 'public.phone_realtime_notify()';
begin
  -- ── The three columns, with the types sendTenantEmail writes ──
  for v_col, v_type in
    select * from (values ('body_text', 'text'), ('sent_by', 'uuid'), ('client_temp_id', 'text')) as t(c, ty)
  loop
    if not exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = 'public.email_sends'::regclass and a.attname = v_col
                      and not a.attisdropped and pg_catalog.format_type(a.atttypid, a.atttypmod) = v_type
                      and not a.attnotnull) then
      raise exception '261: email_sends.% is missing, not %, or NOT NULL', v_col, v_type;
    end if;
  end loop;

  -- ── Both checks exist and are VALIDATED (PART 5 proves they refuse what they must) ──
  if (select count(*) from pg_catalog.pg_constraint
       where conrelid = 'public.email_sends'::regclass and contype = 'c' and convalidated
         and conname in ('email_sends_body_text_chk', 'email_sends_client_temp_id_chk')) <> 2 then
    raise exception '261: a length check on email_sends is missing or not validated';
  end if;

  -- ── The stored bodies are the service role's alone (see GRANTS) ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.email_sends'::regclass) then
    raise exception '261: RLS is off on email_sends';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.email_sends'::regclass) then
    raise exception '261: email_sends has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon','authenticated'] loop
    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if has_table_privilege(v_role, 'public.email_sends', v_priv) then
        raise exception '261: % holds % on email_sends — the email bodies would be readable from the browser', v_role, v_priv;
      end if;
    end loop;
    foreach v_col in array array['body_text','sent_by','client_temp_id'] loop
      if has_column_privilege(v_role, 'public.email_sends', v_col, 'SELECT') then
        raise exception '261: % can read email_sends.%', v_role, v_col;
      end if;
    end loop;
  end loop;
  foreach v_priv in array array['SELECT','INSERT','UPDATE'] loop
    if not has_table_privilege('service_role', 'public.email_sends', v_priv) then
      raise exception '261: service_role lacks % on email_sends — every email send would fail', v_priv;
    end if;
  end loop;

  -- ── The function: still a definer with an empty search_path, still nobody's to call, and
  --    carrying the email branch ──
  if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception '261: phone_realtime_notify is callable from the browser';
  end if;
  if not (select p.prosecdef and p.proconfig @> array['search_path=""']
            from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure) then
    raise exception '261: phone_realtime_notify lost SECURITY DEFINER or its empty search_path';
  end if;
  if position('''email_inbound''' in (select p.prosrc from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure)) = 0 then
    raise exception '261: phone_realtime_notify has no email branch';
  end if;

  -- ── The triggers: the two new ones fire exactly when PART 3 says, and 254's three are
  --    still in place. tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update. ──
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgname = 'email_sends_phone_realtime' and t.tgrelid = 'public.email_sends'::regclass
                    and not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = v_fn::regprocedure
                    and t.tgtype = 1 + 4 + 16 and t.tgattr::text = '') then
    raise exception '261: email_sends_phone_realtime is missing, disabled, or not AFTER INSERT OR UPDATE FOR EACH ROW';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgname = 'email_inbound_phone_realtime' and t.tgrelid = 'public.email_inbound'::regclass
                    and not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = v_fn::regprocedure
                    and t.tgtype = 1 + 4) then
    raise exception '261: email_inbound_phone_realtime is missing, disabled, or not AFTER INSERT FOR EACH ROW';
  end if;
  if (select count(*) from pg_catalog.pg_trigger t
       where not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = v_fn::regprocedure
         and t.tgrelid in ('public.phone_calls'::regclass, 'public.phone_voicemails'::regclass,
                           'public.sms_messages'::regclass, 'public.email_sends'::regclass,
                           'public.email_inbound'::regclass)) <> 5 then
    raise exception '261: the five broadcast triggers (254''s three and these two) are not all in place';
  end if;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 — behavioural probe. Synthetic tenants, rolled back, leaves nothing.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 254's pattern: exercise what matters, then raise ROLLBACK_PROBE so every write in the inner
-- block vanishes — the realtime.messages rows included, which Realtime streams only once they
-- are COMMITTED, so no phone ever hears of them. The tenants, people and addresses are obviously
-- fake, and the two design codes contain O and 1, which the short-code alphabet leaves out
-- (migration 002), so they cannot be a real design.
--
-- The broadcast half runs only when a broadcast can land right now. realtime.send swallows its
-- own failure (254's header: no partition for today means every send is dropped with a WARNING),
-- so the probe sends one sentinel first and checks it arrived. If it did not, it says so and
-- skips those checks, and the property that matters most still holds: every write succeeded.
do $probe$
declare
  k_cid     constant text := 'phone-email-probe-261';
  k_other   constant text := 'phone-email-probe-261-x';
  k_nobody  constant text := 'phone-email-probe-261-none';  -- no client_settings row, like '__unattributed__'
  k_code    constant text := 'SS-PROBE261A';                -- a design with a contact
  k_bare    constant text := 'SS-PROBE261B';                -- a design with none
  k_addr    constant text := 'probe@example.test';
  u_owner   uuid := gen_random_uuid();
  u_sender  uuid := gen_random_uuid();
  u_alien   uuid := gen_random_uuid();
  v_contact uuid;
  v_alien   uuid;
  v_id      uuid;
  v_quiet   uuid[] := '{}';
  v_live    boolean;
  v_got     text[];
  v_bad     integer;
  v_refused boolean;
begin
  begin
    insert into public.client_settings (client_id, phone_status, business_name)
    values (k_cid, 'on', 'Probe Sheds'), (k_other, 'on', 'Other Probe Sheds');
    insert into public.crm_contacts (client_id, owner_user_id, source)
    values (k_cid, u_owner, 'manual')
    returning id into v_contact;
    -- Another builder's contact, owned by someone who must never hear about this tenant's mail.
    insert into public.crm_contacts (client_id, owner_user_id, source)
    values (k_other, u_alien, 'manual')
    returning id into v_alien;
    insert into public.designs (short_code, client_id, contact_id, bldg_w, bldg_h)
    values (k_code, k_cid, v_contact, 10, 12), (k_bare, k_cid, null, 8, 10);

    -- ── 1. The checks take their limits, counted as characters, and refuse one past them ──
    -- 20,000 two-byte letters are a 20,000-character body. This row has no contact and no
    -- design, so it must also broadcast nothing (checked in 3d).
    insert into public.email_sends (client_id, kind, to_email, from_email, subject, body_text, client_temp_id)
    values (k_cid, 'test', k_addr, k_addr, 'Probe', repeat('é', 20000), repeat('t', 64))
    returning id into v_id;
    v_quiet := v_quiet || v_id;
    v_refused := false;
    begin
      insert into public.email_sends (client_id, kind, to_email, from_email, body_text)
      values (k_cid, 'test', k_addr, k_addr, repeat('b', 20001));
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '261 probe: email_sends took a 20,001-character body_text'; end if;
    v_refused := false;
    begin
      insert into public.email_sends (client_id, kind, to_email, from_email, client_temp_id)
      values (k_cid, 'test', k_addr, k_addr, repeat('t', 65));
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '261 probe: email_sends took a 65-character client_temp_id'; end if;

    -- ── 2. Can a broadcast land right now? ──
    perform realtime.send(jsonb_build_object('probe', 261), 'probe', 'phone:' || k_cid || ':sentinel', true);
    v_live := exists (select 1 from realtime.messages m where m.topic = 'phone:' || k_cid || ':sentinel');

    if not v_live then
      raise notice '261 probe: realtime.messages took nothing (no partition for today?), so the broadcast checks were skipped. Every write above still succeeded. Live updates need Realtime''s partitions (see 254''s header).';
    else
      -- ── 3a. A conversation email to the contact, written by a team member: the team, the
      --        contact's owner and the writer. Ids only, the contact in the payload. ──
      insert into public.email_sends (client_id, contact_id, kind, to_email, from_email, subject,
                                      body_text, sent_by, client_temp_id)
      values (k_cid, v_contact, 'conversation', k_addr, k_addr, 'Probe', 'Probe body', u_sender, 'probe-261')
      returning id into v_id;
      select array_agg(m.topic order by m.topic) into v_got
        from realtime.messages m where m.event = 'email' and m.payload ->> 'id' = v_id::text;
      if v_got is distinct from array(select t from unnest(array['phone:' || k_cid, 'phone:user:' || u_owner,
                                                                  'phone:user:' || u_sender]) as t order by t) then
        raise exception '261 probe: a conversation email reached %, not the team, the owner and the writer', v_got;
      end if;
      select count(*) into v_bad
        from realtime.messages m
       where m.event = 'email' and m.payload ->> 'id' = v_id::text
         and ((select array_agg(k order by k) from jsonb_object_keys(m.payload) as k) <> array['contact_id','id','op','table']
              or m.payload ->> 'op' <> 'INSERT' or m.payload ->> 'table' <> 'email_sends'
              or m.payload ->> 'contact_id' <> v_contact::text or not m.private);
      if v_bad <> 0 then
        raise exception '261 probe: an email broadcast carries more than ids, the wrong op/table/contact, or is not private';
      end if;

      -- ── 3b. claimed → sent is an UPDATE, to the same three ──
      update public.email_sends set status = 'sent' where id = v_id;
      if (select count(*) from realtime.messages m
           where m.event = 'email' and m.payload ->> 'id' = v_id::text and m.payload ->> 'op' = 'UPDATE') <> 3 then
        raise exception '261 probe: the claimed → sent update did not reach the same three topics';
      end if;

      -- ── 3c. A quote email carries only short_code: its design's contact is found ──
      insert into public.email_sends (client_id, short_code, kind, to_email, from_email, subject)
      values (k_cid, k_code, 'estimate', k_addr, k_addr, 'Probe quote')
      returning id into v_id;
      select array_agg(m.topic order by m.topic) into v_got
        from realtime.messages m
       where m.event = 'email' and m.payload ->> 'id' = v_id::text and m.payload ->> 'contact_id' = v_contact::text;
      if v_got is distinct from array(select t from unnest(array['phone:' || k_cid, 'phone:user:' || u_owner]) as t order by t) then
        raise exception '261 probe: a quote email did not reach the team and the design''s contact''s owner: %', v_got;
      end if;

      -- ── 3d. Nothing to attach it to, or a sign-in code: no event at all ──
      insert into public.email_sends (client_id, short_code, kind, to_email, from_email)
      values (k_cid, k_bare, 'estimate', k_addr, k_addr)
      returning id into v_id;
      v_quiet := v_quiet || v_id;
      insert into public.email_sends (client_id, contact_id, short_code, kind, to_email, from_email)
      values (k_cid, v_contact, k_code, 'login_code', k_addr, k_addr)
      returning id into v_id;
      v_quiet := v_quiet || v_id;
      -- Another builder's email naming this builder's design finds no contact: the design
      -- lookup is tenant-scoped, so one tenant's mail can never carry another's contact id.
      insert into public.email_sends (client_id, short_code, kind, to_email, from_email)
      values (k_other, k_code, 'estimate', k_addr, k_addr)
      returning id into v_id;
      v_quiet := v_quiet || v_id;

      -- ── 3e. A reply: on the contact, through its design, from nowhere, and to a tenant with
      --        no settings row (how '__unattributed__' mail is dropped) ──
      insert into public.email_inbound (client_id, contact_id, from_email, subject, body_text)
      values (k_cid, v_contact, k_addr, 'Re: Probe', 'Probe reply')
      returning id into v_id;
      select array_agg(m.topic order by m.topic) into v_got
        from realtime.messages m
       where m.event = 'email' and m.payload ->> 'id' = v_id::text and m.payload ->> 'table' = 'email_inbound'
         and m.payload ->> 'op' = 'INSERT' and m.payload ->> 'contact_id' = v_contact::text;
      if v_got is distinct from array(select t from unnest(array['phone:' || k_cid, 'phone:user:' || u_owner]) as t order by t) then
        raise exception '261 probe: a reply did not reach the team and the contact''s owner: %', v_got;
      end if;
      insert into public.email_inbound (client_id, short_code, from_email, subject)
      values (k_cid, k_code, k_addr, 'Re: Probe quote')
      returning id into v_id;
      if (select count(*) from realtime.messages m
           where m.event = 'email' and m.payload ->> 'id' = v_id::text and m.payload ->> 'contact_id' = v_contact::text) <> 2 then
        raise exception '261 probe: a reply threaded to a design did not find the design''s contact';
      end if;
      insert into public.email_inbound (client_id, from_email, subject)
      values (k_cid, k_addr, 'Unmatched')
      returning id into v_id;
      v_quiet := v_quiet || v_id;
      insert into public.email_inbound (client_id, contact_id, from_email, subject)
      values (k_nobody, v_contact, k_addr, 'Unattributed')
      returning id into v_id;
      v_quiet := v_quiet || v_id;
      if exists (select 1 from realtime.messages m where m.payload ->> 'id' = any (array(select x::text from unnest(v_quiet) as x))) then
        raise exception '261 probe: an email with no contact, a sign-in code, mail for a tenant with no settings, or another tenant''s mail naming this design was broadcast';
      end if;

      -- ── 3f. Another builder's contact id on this tenant's email: this team hears, the other
      --        builder's staff do not ──
      insert into public.email_sends (client_id, contact_id, kind, to_email, from_email)
      values (k_cid, v_alien, 'conversation', k_addr, k_addr)
      returning id into v_id;
      select array_agg(m.topic order by m.topic) into v_got
        from realtime.messages m where m.payload ->> 'id' = v_id::text;
      if v_got is distinct from array['phone:' || k_cid] then
        raise exception '261 probe: a mis-linked contact id told someone outside the tenant: %', v_got;
      end if;

      -- ── 3g. Switched off: nothing ──
      update public.client_settings set phone_status = 'off' where client_id = k_cid;
      insert into public.email_inbound (client_id, contact_id, from_email, subject)
      values (k_cid, v_contact, k_addr, 'Off')
      returning id into v_id;
      if exists (select 1 from realtime.messages m where m.payload ->> 'id' = v_id::text) then
        raise exception '261 probe: an email was broadcast for a tenant whose phone is off';
      end if;

      raise notice '261 probe: emails reach the team, the contact''s owner and the writer (sends and replies, by contact or through the design), ids only; nothing for mail with no contact, a sign-in code, a tenant without settings, or a phone that is off; nobody outside the tenant hears';
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '261 probe: body_text and client_temp_id hold their limits and refuse one past; nothing was kept';
      else
        raise;
      end if;
  end;

  if exists (select 1 from public.email_sends e where e.client_id like 'phone-email-probe-261%')
     or exists (select 1 from public.email_inbound e where e.client_id like 'phone-email-probe-261%')
     or exists (select 1 from public.client_settings s where s.client_id like 'phone-email-probe-261%')
     or exists (select 1 from public.crm_contacts c where c.client_id like 'phone-email-probe-261%')
     or exists (select 1 from public.designs d where d.short_code in (k_code, k_bare)) then
    raise exception '261 probe: synthetic rows were left behind';
  end if;
end
$probe$;

notify pgrst, 'reload schema';

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. Record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('261', '261_phone_email_thread');
-- B. The columns are there and empty until the functions ship:
--      select count(*) filter (where body_text is not null) bodies, count(*) from public.email_sends;   -- 0, n
-- C. Then deploy portal-settings, submit-estimate and customer-accept (they bundle emailSend.ts).
--    After the first conversation email from the phone or the portal:
--      select kind, contact_id is not null has_contact, sent_by is not null has_writer,
--             client_temp_id, left(body_text, 40) from public.email_sends order by created_at desc limit 3;
