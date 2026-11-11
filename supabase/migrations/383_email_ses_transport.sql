-- ═════════════════════════════════════════════════════════════════════════════
-- 383: EMAIL CAN GO OUT THROUGH AMAZON SES. A per-builder pin, and a key the ledger remembers.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────
-- Written as 381 on 2026-11-10, when the ledger and origin/beta both ended at 380. By the time
-- it was due to be applied the next day, beta held 381_crm_import_leads and
-- 382_crm_deal_account_link and the ledger read 382, so this became 383 before it touched the
-- database. Read immediately before applying: the ledger's highest numbered row was 382, and no
-- local or remote branch held a 383 or higher.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- Email is moving from Resend to Amazon SES (decided 2026-11-09). It cannot move in one flip: a
-- builder whose domain is verified at Resend must keep sending through Resend until the same
-- domain verifies at SES. So the wire is chosen per builder (_shared/mailTransport.ts), and the
-- database has to say which wire a builder is on and what they hold at SES.
--
-- Separately, SES has no Idempotency-Key. The retries added on 2026-11-06 (automations, meeting
-- reminders) lean on Resend's: the same key gets the first request's answer and no second email.
-- On SES the same question is put to our own ledger instead, which needs the key on the row.
--
-- ── WHAT ─────────────────────────────────────────────────────────────────────
--   client_settings.email_transport   'resend' | 'ses' | NULL. The builder's pin. NULL means
--                                     "follow the platform default" (the EMAIL_DEFAULT_TRANSPORT
--                                     setting). Backfilled to 'resend' for every builder who
--                                     holds a Resend domain today, so flipping the default can
--                                     never move them.
--   client_settings.ses_identity      The sending domain this builder holds at SES (the identity's
--                                     name), or NULL. One builder per identity.
--   client_settings.ses_dns_records   The SES DNS records waiting to be published by a builder who
--                                     is still sending through Resend (the operator's "prepare"
--                                     step). Same shape as email_dns_records. NULL otherwise: a
--                                     builder who is on SES keeps their records in
--                                     email_dns_records and inbound_dns_records like anyone else.
--   email_sends.idem_key              The caller's retry key plus the email's fingerprint, kept
--                                     for a keyed send that went out through SES. NULL on every
--                                     other row, including every Resend row ever written.
--   adopt_email_send(send, id)        Puts SES's message id on a row that has none, when the
--                                     event feed names the row by its tag (see the function).
-- `email_provider` is untouched and keeps its meaning: 'resend' there has always meant
-- "StructureStudio sends this builder's email", and six readers compare against that word.
-- No row in email_sends changes. No policy, grant or trigger changes: client_settings and
-- email_sends are service-role only (107), and new columns inherit that.
--
-- ── ORDER ────────────────────────────────────────────────────────────────────
-- Apply BEFORE any builder is pinned to SES or the default is flipped. The functions are safe to
-- deploy ahead of it all the same: emailSend.ts reads the two settings columns in a read it
-- repeats without them on "no such column", and writes idem_key in a claim it repeats without it.
--
-- ── APPLY ────────────────────────────────────────────────────────────────────
-- By hand, like every migration here: the SQL editor or the Supabase connector. Read the result
-- back BEFORE recording it:
--   select count(*) filter (where email_transport = 'resend') as pinned_resend,
--          count(*) filter (where email_transport = 'ses')    as pinned_ses,
--          count(*) filter (where resend_domain_id is not null and email_transport is null) as unpinned_holders
--     from public.client_settings;
--   -- on the first apply pinned_ses must be 0; unpinned_holders must always be 0
-- Then record it under a plain number and check that a row came back:
--   insert into supabase_migrations.schema_migrations (version, name)
--     values ('383', '383_email_ses_transport') on conflict (version) do nothing
--     returning version, name;
-- Proven offline by tests/sql/migration383.test.cjs.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Only while no builder is pinned to 'ses' (otherwise their email stops):
--   drop function if exists public.adopt_email_send(uuid, text);
--   drop index if exists public.email_sends_idem_key_idx;
--   alter table public.email_sends drop constraint if exists email_sends_idem_key_chk,
--     drop column if exists idem_key;
--   drop index if exists public.client_settings_ses_identity_uniq;
--   alter table public.client_settings
--     drop constraint if exists client_settings_email_transport_check,
--     drop column if exists ses_dns_records, drop column if exists ses_identity,
--     drop column if exists email_transport;

begin;
set local lock_timeout = '5s';

-- ── client_settings: the pin, and what a builder holds at SES ────────────────
alter table public.client_settings
  add column if not exists email_transport text,
  add column if not exists ses_identity    text,
  add column if not exists ses_dns_records jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'client_settings_email_transport_check'
                    and conrelid = 'public.client_settings'::regclass) then
    alter table public.client_settings
      add constraint client_settings_email_transport_check
      check (email_transport is null or email_transport in ('resend', 'ses'));
  end if;
end $$;

-- A builder who holds a domain at Resend is pinned to Resend. Only rows with no pin are touched,
-- so a re-apply after a cutover never moves a builder back.
update public.client_settings
   set email_transport = 'resend'
 where email_transport is null
   and (coalesce(resend_domain_id, '') <> '' or coalesce(resend_inbound_domain_id, '') <> '');

-- Two builders on one SES identity would send as each other. email_domain already has this
-- guard (107); the identity gets its own because the prepare step fills it before the cutover.
create unique index if not exists client_settings_ses_identity_uniq
  on public.client_settings (ses_identity)
  where ses_identity is not null and ses_identity <> '';

comment on column public.client_settings.email_transport is
  'Migration 383: which provider carries this builder''s email: ''resend'' or ''ses''. NULL follows the platform default (the EMAIL_DEFAULT_TRANSPORT setting). A builder who holds a domain at a provider is pinned to it; only an operator''s cutover changes the pin. Not to be confused with email_provider, which says whether StructureStudio sends at all.';
comment on column public.client_settings.ses_identity is
  'Migration 383: the sending domain this builder holds at Amazon SES (the identity name), or NULL. The reply address reply.<domain> needs no identity of its own.';
comment on column public.client_settings.ses_dns_records is
  'Migration 383: the SES DNS records a builder still sending through Resend has been asked to publish (the operator''s prepare step), same shape as email_dns_records. NULL once they are cut over, and for a builder who connected on SES in the first place.';

-- ── email_sends: the retry key, for the wire that cannot keep it itself ──────
alter table public.email_sends
  add column if not exists idem_key text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'email_sends_idem_key_chk'
                    and conrelid = 'public.email_sends'::regclass) then
    alter table public.email_sends
      add constraint email_sends_idem_key_chk
      check (idem_key is null or char_length(idem_key) between 1 and 256);
  end if;
end $$;

-- The retry check reads (client_id, idem_key) for a row that went. Partial, because almost no
-- row has a key: only automations and reminders sent through SES.
create index if not exists email_sends_idem_key_idx
  on public.email_sends (client_id, idem_key)
  where idem_key is not null;

comment on column public.email_sends.idem_key is
  'Migration 383: for a keyed send that went out through Amazon SES, the caller''s retry key plus a fingerprint of the email. SES has no Idempotency-Key, so a retry asks this column whether an earlier try of the same email already went (emailSend.ts). NULL on every other row; Resend keeps its own key.';

-- ── adopt_email_send: the event feed names a row whose send call lost its answer ─
-- Every SES send carries its ledger row's id as a tag (ss_send). When our call to SES times out
-- but SES did send, the row says 'failed' and has no provider id, so record_email_event (262)
-- answers 'unknown' for the delivery event. The event still carries the tag: postmark-events
-- then calls this to put SES's id on that row and mark it sent, and records the event again.
-- It also un-sticks a row left at 'claimed' because the 'sent' write after a good send failed.
--
-- Only a row WITHOUT a provider id is touched, so an id is adopted once and can never be
-- replaced, and only 'claimed' and 'failed' move: a row that already says more keeps saying it.
-- security invoker, service role only, like record_email_event: it runs as its caller.
create or replace function public.adopt_email_send(
  p_send_id             uuid,
  p_provider_message_id text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  if p_send_id is null or coalesce(p_provider_message_id, '') = '' then
    return false;
  end if;
  update public.email_sends
     set provider_message_id = p_provider_message_id,
         status     = case when status in ('claimed', 'failed') then 'sent' else status end,
         error      = case when status in ('claimed', 'failed') then null else error end,
         updated_at = now()
   where id = p_send_id
     and provider_message_id is null;
  return found;
end
$fn$;

comment on function public.adopt_email_send(uuid, text) is
  'Migration 383: put the provider''s message id on an email_sends row that has none, and mark it sent, because a delivery event has just named the row by its ss_send tag. For a send whose call timed out (the row says failed) or whose sent-write was lost (the row says claimed). Returns true when a row changed. Called by the postmark-events function with the service role.';

revoke execute on function public.adopt_email_send(uuid, text) from public, anon, authenticated;
grant execute on function public.adopt_email_send(uuid, text) to service_role;

-- ── Assertions: abort the whole transaction rather than leave it half-applied ─
do $$
declare
  n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'client_settings'
     and column_name in ('email_transport', 'ses_identity', 'ses_dns_records');
  if n <> 3 then raise exception '383: client_settings is missing a new column (found % of 3)', n; end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'email_sends' and column_name = 'idem_key';
  if n <> 1 then raise exception '383: email_sends.idem_key was not added'; end if;

  -- Every builder holding a Resend domain must come out with a pin. ('ses' is allowed: after an
  -- operator's cutover a builder keeps their Resend domain for a week as the way back, and a
  -- re-apply of this file must not trip over them.)
  select count(*) into n from public.client_settings
   where (coalesce(resend_domain_id, '') <> '' or coalesce(resend_inbound_domain_id, '') <> '')
     and email_transport is null;
  if n <> 0 then raise exception '383: % builder(s) hold a Resend domain without a pin', n; end if;
end $$;

commit;
