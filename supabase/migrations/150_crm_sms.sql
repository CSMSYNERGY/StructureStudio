-- 150_crm_sms.sql — two-way SMS on the record page.
--
-- Carolyn, 2026-08-26 27:02, walking the action bar: "and we have calls. We probably need
-- SMS in there, too. We will need that in there as well."
--
-- ⚠️ THIS REVERSES A DECISION THAT WAS DELIBERATE, TWICE OVER. On 2026-08-25 Ahsan removed
-- the greyed WhatsApp tab and a reserved `sms` feed type, saying "we are not using Twilio
-- for conversation or campaigns. We are only using Twilio to get the code to log in." The
-- work log's own words were "Do not re-add them — the reserved seam was the thing most
-- likely to mislead a future session into building it." Ahsan reversed that on 2026-08-27
-- and asked for the real thing. The comments carrying the old decision are being rewritten
-- rather than deleted, because a decision that has flipped twice is worth being able to read.
--
-- ── THE TENANT MODEL, AND WHY IT IS ONE NUMBER PER BUILDER ─────────────────────────────
--
-- ONE local number per tenant, all in ONE Messaging Service under ONE A2P campaign.
--
-- Per-tenant numbers are not a branding nicety, they are the only thing that makes inbound
-- work. The single discriminator on an arriving message is the number the customer texted
-- (`To`). A shared platform number cannot tell one builder's customer from another's — and
-- the same person really can be a contact of two builders on this platform. The email side
-- solved the identical problem the identical way (each builder sends from their own domain
-- on one shared account, 137), and this is that model in the messaging channel.
--
-- The Messaging Service and the campaign are shared because A2P registration attaches to a
-- service: six services would mean six campaign registrations, six monthly fees and six
-- carrier reviews to shepherd, for one product sending conversational one-to-one messages.
-- The send path passes BOTH the service SID and an explicit `From`, so the tenant's own
-- number is what the customer sees while the service still supplies opt-out handling and
-- status callbacks.

create table if not exists public.sms_messages (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null,
  -- Nullable BOTH ways on purpose: an inbound message from a number we cannot place is
  -- still stored (see the unmatched index below), and a message sent from a design record
  -- carries both the code and the contact.
  contact_id   uuid,
  short_code   text,
  direction    text not null check (direction in ('out', 'in')),
  from_number  text not null,
  to_number    text not null,
  body         text,
  -- Outbound walks claimed -> sent -> delivered | undelivered | failed. Inbound arrives
  -- already 'received'. `claimed` exists so a row is written BEFORE the provider call:
  -- a send that succeeds at Twilio and then fails to record is a message the customer got
  -- and the builder cannot see, which is worse than a duplicate.
  status       text not null default 'received'
    check (status in ('claimed', 'sent', 'delivered', 'undelivered', 'failed', 'received')),
  -- The numeric Twilio code only (30034, 21610…). NEVER their message text: it echoes the
  -- `To` number back, and this column is read by the browser.
  error_code   text,
  provider     text not null default 'twilio',
  provider_sid text,
  num_segments integer,
  sent_by      uuid,
  delivered_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- IDEMPOTENCY. Twilio retries a webhook it did not get a 2xx for, and the status callback
-- fires several times per message. Without this a retry writes a second copy of the
-- customer's words. Partial, because outbound rows have no SID until the send returns.
create unique index if not exists sms_messages_sid_uniq
  on public.sms_messages (provider_sid) where provider_sid is not null and provider_sid <> '';

-- The two feed reads, mirroring email_inbound's shape.
create index if not exists sms_messages_contact_idx
  on public.sms_messages (client_id, contact_id, created_at desc) where contact_id is not null;
create index if not exists sms_messages_code_idx
  on public.sms_messages (client_id, short_code, created_at desc) where short_code is not null;
-- The operator's "who texted us that we could not place?" query. Same reasoning as
-- email_inbound_unmatched_idx: an unfiled row is visible and can be re-linked, a dropped
-- one is gone.
create index if not exists sms_messages_unmatched_idx
  on public.sms_messages (client_id, created_at desc)
  where contact_id is null and short_code is null and direction = 'in';

alter table public.sms_messages enable row level security;
-- New tables ship world-readable; 112's lesson. Revoke, then grant back only the read the
-- portal needs. Every write is service-role, from portal-settings or the webhooks.
revoke all on public.sms_messages from anon, authenticated;
grant select on public.sms_messages to authenticated;
drop policy if exists sms_messages_owner_select on public.sms_messages;
create policy sms_messages_owner_select on public.sms_messages
  for select to authenticated using (client_id = public.current_client_id());

comment on table public.sms_messages is
  'Two-way SMS on the CRM record page (Carolyn 2026-08-26). One Twilio number per tenant is '
  'what makes inbound attributable — the To number is the only tenant discriminator on an '
  'arriving message. An UNMATCHED inbound message is still stored; see sms_messages_unmatched_idx.';

-- ── Per-tenant configuration ───────────────────────────────────────────────────────────
-- client_settings is service-role only, so the number never reaches the browser except
-- through portal-settings, which decides what to show.
alter table public.client_settings
  add column if not exists sms_number text,
  add column if not exists sms_status text not null default 'off';

-- Added separately from the column so re-running is safe and the constraint has a name.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'client_settings_sms_status_chk') then
    alter table public.client_settings
      add constraint client_settings_sms_status_chk
      check (sms_status in ('off', 'pending', 'active'));
  end if;
end $$;

-- ⚠️ THE ATTRIBUTION KEY. Two tenants sharing a number would make every inbound message
-- ambiguous, and the resolver would silently pick whichever row came back first — one
-- builder reading another's customer conversation. The database refuses it instead.
create unique index if not exists client_settings_sms_number_uniq
  on public.client_settings (sms_number) where sms_number is not null and sms_number <> '';

-- STOP is a legal instruction, not a preference. Twilio's Advanced Opt-Out blocks the send
-- at the provider; this column is what lets the composer say so BEFORE somebody types a
-- message that was never going to arrive.
alter table public.crm_contacts add column if not exists sms_opt_out_at timestamptz;
