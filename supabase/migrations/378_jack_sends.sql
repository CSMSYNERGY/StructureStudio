-- 378_jack_sends.sql -- Jack version 2, round 2: sending replies and resending estimates (plan: the vault's
-- StructureStudio AI Agent Plan 2026-11-02, sections 5.5 and 6; defaults settled 2026-11-06). Still DARK:
-- nothing here turns Jack on, and nothing here sends anything.
--
-- APPLY BY HAND, AFTER A HUMAN HAS READ IT, and only after 375, 376 and 377. Re-read the ledger first and
-- take the next free number:
--     select max(version) from supabase_migrations.schema_migrations where version ~ '^\d{3}$';
--   Run this file as ONE statement batch, then record it:
--     insert into supabase_migrations.schema_migrations (version, name) values ('378', '378_jack_sends') returning version;
--   Zero rows back from `returning` means the number was taken: renumber. NEVER `supabase db push`.
--
-- DEPLOY ORDER: apply this file BEFORE deploying jack-agent from this branch. That jack-agent writes the
-- two new kinds, and a database still on 377's kind list refuses them (23514): a reply then falls back to
-- the copy-only draft card (drafts.ts) and an estimate card can't be made at all. Deploy portal-settings
-- (resend_quote_email's row id) before jack-agent too, or a resent estimate can't be marked "with Jack"
-- (logged as jack_sent_with_no_id), and the portal before jack-agent, or an open page from before these
-- cards can't press them (the server answers "Reload the page", nothing is sent).
--
-- WHAT THIS ADDS
--   1. Two new kinds of card:
--        reply_send       a text or email to one customer, sent when the person presses Approve on the card
--        estimate_resend  a StructureStudio estimate emailed again through the route the portal uses
--      Both are private: they hold one customer's name, town, a deal label and the words.
--   2. jack_clear_old_private clears all four private kinds 30 days after they were made (lookup,
--      reply_draft, reply_send, estimate_resend). commission_rate is private but holds no customer
--      contents, so the sweep still leaves it (377).
--   3. sent_with on sms_messages and email_sends: 'jack' when the person pressed Approve on a Jack card, null
--      for everything else. jack-agent stamps it with its own service-role client right after the route
--      says sent, only where it is still null. The record timeline (_shared/crmFeed.ts) reads it for the
--      line "Sent by Mike with Jack". crmFeed.ts reads again without it while this file is not applied, so
--      the record page keeps working in the deploy window.
-- jack-agent kinds_test.ts reads this file and checks the kind list is exactly the kinds the code knows,
-- and that the sweep's kinds are exactly common.ts PRIVATE_KINDS.
--
-- Re-applying changes nothing: the kind check and the function are re-issued as they are, the columns and
-- their checks are added only when missing.

-- Both tables take inbound texts and email events all day. Give up after 5 seconds of waiting for the
-- lock the new column and check need, rather than queueing every writer behind a long transaction (the
-- whole batch then rolls back; run it again later).
set local lock_timeout = '5s';

-- ── 1. The kinds of card ─────────────────────────────────────────────────────────────────────────────
alter table public.jack_proposals drop constraint if exists jack_proposals_kind_check;
alter table public.jack_proposals add constraint jack_proposals_kind_check check (kind in (
  -- 375: the sizes table and doors
  'price_sheet', 'size_rule', 'new_fixture',
  -- 376 (v1)
  'memory',
  'setup_company', 'setup_paperwork', 'setup_styles', 'setup_fixture', 'setup_locations', 'setup_tick', 'setup_guide',
  'automation_rule', 'automation_pause',
  'lookup', 'reply_draft',
  -- 377 (v2): record changes
  'inventory_price', 'inventory_listing', 'inventory_photos',
  'changeorder_attrs', 'changeorder_unlock',
  'build_job_add', 'build_job_change', 'build_job_built',
  'delivery_load_create', 'delivery_stop_add', 'delivery_stop_reorder', 'delivery_load_out', 'delivery_stop_delivered', 'delivery_load_delivered',
  'commission_rate',
  -- 378 (v2, round 2): sends
  'reply_send', 'estimate_resend'
));

-- ── 2. Clearing old private cards ────────────────────────────────────────────────────────────────────
-- 376's function, word for word, with the two new private kinds added to the list. A reply send or an
-- estimate resend holds a customer's first name, a deal label and the words, the same as a reply draft.
create or replace function public.jack_clear_old_private(p_client text, p_before timestamptz)
returns integer
language sql
security definer
set search_path to ''
as $fn$
  with cleared as (
    update public.jack_proposals
       set preview = '{"cleared": true}'::jsonb, payload = '{"cleared": true}'::jsonb
     where client_id = p_client
       and kind in ('lookup', 'reply_draft', 'reply_send', 'estimate_resend')
       and created_at < p_before
       and coalesce(preview ->> 'cleared', '') <> 'true'
    returning 1
  )
  select count(*)::integer from cleared;
$fn$;
revoke execute on function public.jack_clear_old_private(text, timestamptz) from public, anon, authenticated;
grant  execute on function public.jack_clear_old_private(text, timestamptz) to service_role;
comment on function public.jack_clear_old_private(text, timestamptz) is
  'Migration 376; kinds widened by 378. Clears the customer contents of one builder''s Jack look-up lists, reply drafts, reply sends and estimate resends made before p_before (jack-agent passes now minus 30 days). The count cleared. Service role only.';

-- ── 3. "Sent by Mike with Jack" ──────────────────────────────────────────────────────────────────────
-- Nullable, no default: every row already there, and every row a route writes, stays null. Only
-- jack-agent sets it, after the send. Each check is added NOT VALID only when it is missing, then
-- validated (261's way): a re-apply skips the add, and validating a check that is already valid does
-- nothing. In one batch the table lock is held until the end either way; the new column is null on every
-- row, so the one scan is quick.
alter table public.sms_messages add column if not exists sent_with text;
alter table public.email_sends  add column if not exists sent_with text;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'sms_messages_sent_with_chk'
                    and conrelid = 'public.sms_messages'::regclass) then
    alter table public.sms_messages
      add constraint sms_messages_sent_with_chk
      check (sent_with is null or sent_with = 'jack') not valid;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'email_sends_sent_with_chk'
                    and conrelid = 'public.email_sends'::regclass) then
    alter table public.email_sends
      add constraint email_sends_sent_with_chk
      check (sent_with is null or sent_with = 'jack') not valid;
  end if;
end $$;

alter table public.sms_messages validate constraint sms_messages_sent_with_chk;
alter table public.email_sends  validate constraint email_sends_sent_with_chk;

comment on column public.sms_messages.sent_with is
  'Migration 378: ''jack'' when a person pressed Approve on a Jack card and this text went (jack-agent stamps it after the send, by row id, only where it is null). NULL for every other text. sent_by is still the person who pressed Approve. The record timeline shows "Sent by {name} with Jack".';
comment on column public.email_sends.sent_with is
  'Migration 378: ''jack'' when a person pressed Approve on a Jack card and this email went: a reply, or an estimate resent (jack-agent stamps it after the send, by row id, only where it is null, and fills sent_by with the person when the route left it null). NULL for every other email. The record timeline shows "Sent by {name} with Jack".';

-- ── Proof ─────────────────────────────────────────────────────────────────────────────────────────────
do $proof$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'jack_proposals_kind_check' and conrelid = 'public.jack_proposals'::regclass
       and pg_get_constraintdef(oid) like '%commission_rate%' and pg_get_constraintdef(oid) like '%reply_draft%'
       and pg_get_constraintdef(oid) like '%reply_send%' and pg_get_constraintdef(oid) like '%estimate_resend%'
  ) then
    raise exception '378: jack_proposals_kind_check must list the v1 and v2 kinds and the two send kinds';
  end if;
  if has_table_privilege('authenticated', 'public.jack_proposals', 'select') or has_table_privilege('anon', 'public.jack_proposals', 'select') then
    raise exception '378: jack_proposals must stay service role only';
  end if;
  if not exists (
    select 1 from pg_proc
     where oid = 'public.jack_clear_old_private(text, timestamptz)'::regprocedure
       and prosecdef
       and pg_get_functiondef(oid) like '%''reply_send''%' and pg_get_functiondef(oid) like '%''estimate_resend''%'
       and pg_get_functiondef(oid) not like '%commission_rate%'
  ) then
    raise exception '378: jack_clear_old_private must clear the four private kinds, and never commission_rate';
  end if;
  if has_function_privilege('authenticated', 'public.jack_clear_old_private(text, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.jack_clear_old_private(text, timestamptz)', 'execute') then
    raise exception '378: jack_clear_old_private must be service role only';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'sms_messages_sent_with_chk' and conrelid = 'public.sms_messages'::regclass and convalidated
       and pg_get_constraintdef(oid) like '%jack%'
  ) or not exists (
    select 1 from pg_constraint
     where conname = 'email_sends_sent_with_chk' and conrelid = 'public.email_sends'::regclass and convalidated
       and pg_get_constraintdef(oid) like '%jack%'
  ) then
    raise exception '378: sent_with must be checked on sms_messages and email_sends';
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name in ('sms_messages', 'email_sends') and column_name = 'sent_with'
       and (is_nullable <> 'YES' or column_default is not null or data_type <> 'text')
  ) or (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name in ('sms_messages', 'email_sends') and column_name = 'sent_with') <> 2 then
    raise exception '378: sent_with must be a nullable text column with no default on both tables';
  end if;
end
$proof$;
