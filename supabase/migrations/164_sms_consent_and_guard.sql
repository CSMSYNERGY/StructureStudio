-- 164_sms_consent_and_guard.sql
-- Phase 0 + Phase 1 foundation for self-serve SMS: an area guard on the message ledger,
-- and the consent record that has to exist before a single text is legal to send.
--
-- APPLY BY HAND (SQL editor / MCP execute_sql / `supabase db query --linked -f`), then
-- record the row in supabase_migrations.schema_migrations. NEVER `supabase db push`.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1 — sms_messages joins the area-guarded set
-- ─────────────────────────────────────────────────────────────────────────────
-- 150 shipped `grant select on sms_messages to authenticated` with a tenant-only policy.
-- That is the pre-154 posture: any signed-in member of the tenant can read the table
-- directly over PostgREST, including a DRIVER whose `contacts` level is 'none'. The UI
-- never does this (the feed is built under service role in _shared/crmFeed.ts), so there
-- is no reader to preserve — but customer text conversations are exactly the content 154
-- decided should be gated, and this table was created before that decision existed.
--
-- ⚠️ This is NOT the only table in that state — 34 tenant-readable tables carry no
-- restrictive guard. This migration does not "fix RLS"; it moves ONE table whose contents
-- are as sensitive as crm_contacts into the set that 154 already guards. The rest is a
-- separate, deliberate audit, not a drive-by.
--
-- A RESTRICTIVE policy, matching crm_contacts_area_select. Restrictive is load-bearing:
-- permissive policies OR together, so a second permissive policy would widen access
-- rather than narrow it. Both must pass.
create policy sms_messages_area_select on public.sms_messages
  as restrictive for select to authenticated
  using (public.current_area_level('contacts') <> 'none');

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2 — consent, the thing that makes a send legal
-- ─────────────────────────────────────────────────────────────────────────────
-- There is no consent record anywhere in the product today. capture-lead takes a name and
-- a phone to open the quote gate; migration 060 even says in a comment that a phone there
-- is "NOT a marketing/SMS destination, which would need its own consent record". This is
-- that record.
--
-- Two tables on purpose. The LOG is append-only evidence — what was shown, to whom, when,
-- from where. The OPT-OUT table is a tiny derived hot-path lookup the send path can hit on
-- every message without scanning history.

create table if not exists public.sms_consent_log (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null,
  -- The 10-digit NANP key, matching public.crm_phone_key / smsPhoneKey. The identity here
  -- is the PHONE, not the contact row: consent survives a contact being merged, renamed or
  -- deleted, and a re-created contact must not silently inherit a consent it never got.
  phone_digits  text not null,
  contact_id    uuid,
  -- 'granted' | 'revoked'. Free text with a check so a future channel/keyword can be added
  -- without a type migration.
  action        text not null,
  -- HOW consent arrived, so an auditor can tell a checkbox from an inbound START.
  -- 'web_form' | 'sms_start' | 'sms_stop' | 'operator' | 'import'
  source        text not null,
  -- ⚠️ THE DISCLOSURE SENTENCE, VERBATIM — never a template id. The template WILL be
  -- edited; today's wording is not evidence of what was on screen last March. This column
  -- is the entire point of the table.
  disclosure_text text,
  -- Where it was shown, and who the browser said they were.
  consent_url   text,
  ip            text,
  user_agent    text,
  -- Free-form provenance (message sid for an SMS STOP, operator user id, import batch).
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  constraint sms_consent_log_action_chk check (action in ('granted','revoked')),
  constraint sms_consent_log_source_chk check (source in ('web_form','sms_start','sms_stop','operator','import'))
);

-- The hot path: "may this tenant text this number right now?"
create index if not exists sms_consent_log_lookup_idx
  on public.sms_consent_log (client_id, phone_digits, created_at desc);

create table if not exists public.sms_opt_outs (
  client_id     text not null,
  phone_digits  text not null,
  -- 'sms_stop' | 'operator' | 'web_form' | 'import' — why they are suppressed.
  reason        text not null,
  -- The FCC's 2025-04-11 rule requires honouring a revocation made "in any reasonable
  -- manner" within 10 BUSINESS DAYS. When a human records a free-text revocation ("please
  -- quit texting me"), this is the clock. A row is effective immediately regardless; the
  -- column exists so an operator can prove the deadline was met.
  effective_at  timestamptz not null default now(),
  requested_at  timestamptz not null default now(),
  note          text,
  created_at    timestamptz not null default now(),
  primary key (client_id, phone_digits)
);

-- ⚠️ OPT-OUT IS PER TENANT, AND THAT IS CORRECT, not an oversight.
-- Twilio: "these STOP keyword replies only apply to the most recent number that messaged
-- the recipient". The legal caller is the BUILDER, not StructureStudio, and one homeowner
-- can be a customer of two builders on this platform. A homeowner who STOPs builder A must
-- keep hearing from builder B, whose messages they asked for. A global key would silently
-- cancel a consent the customer actually gave.

-- Service-role only, like commission_members and driver_profiles. Everything the browser
-- needs comes through portal-sms; nothing reads these tables directly.
alter table public.sms_consent_log enable row level security;
alter table public.sms_opt_outs    enable row level security;
revoke all on public.sms_consent_log from anon, authenticated;
revoke all on public.sms_opt_outs    from anon, authenticated;
