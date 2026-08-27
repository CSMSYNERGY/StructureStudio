-- 135_email_inbound.sql — the return leg. A customer's reply lands on their record.
--
-- Carolyn, 2026-08-21, on what a conversations tab has to be: "I want to be able to see my
-- emails and only emails in a quick and easy way ... this is not just a conversations view.
-- This is also my activities view. So I wanted more, more looking like this." And Ahsan,
-- 2026-08-26: track everything in the conversation.
--
-- Until now the record page showed only what we SENT. A reply went to a staff member's own
-- inbox and vanished from the product, which makes a "conversation" a monologue.
--
-- WHY A SEPARATE TABLE AND NOT A `direction` COLUMN ON email_sends.
-- email_sends is an outbound LEDGER: it carries intended_email (the beta redirect's real
-- recipient), status ∈ claimed|sent|failed|delivered|bounced, bounce_reason, and a claim row
-- written BEFORE the provider call so a crash cannot lose a send. None of that means
-- anything for a message someone sent US. Bolting a direction flag on would leave half the
-- columns permanently null and the table's name lying about half its rows. The feed already
-- unions nine sources; a tenth is cheaper than a table that means two things.
--
-- Rollback:
--   drop table if exists public.email_inbound;

create table if not exists public.email_inbound (
  id uuid primary key default gen_random_uuid(),
  client_id  text not null,
  -- Where it attaches. Both nullable: a reply we cannot place still gets STORED, because a
  -- customer's words are worth more than our ability to file them. An unmatched row is
  -- visible to an operator and can be re-linked later; a dropped one is gone.
  contact_id uuid,
  short_code text,

  from_email text not null,
  from_name  text,
  to_email   text,                       -- which tenant address it arrived at
  subject    text,
  body_text  text,                       -- plain text, which is what the feed renders
  body_html  text,

  -- THREADING. `in_reply_to` is the Message-ID of the mail being answered; we store our own
  -- provider id on email_sends.provider_message_id at send time, so this is the join that
  -- puts a reply back on the right design. `message_id` is the reply's own id, kept so a
  -- reply-to-a-reply can chain and so a redelivery is detectable.
  message_id  text,
  in_reply_to text,
  references_raw text,

  provider text not null default 'resend',
  spam_verdict text,                     -- provider's own call, stored not acted on
  received_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- IDEMPOTENCY. Providers retry, and a retried webhook must not double-post a customer's
-- reply into the conversation. Partial so the absence of a Message-ID never blocks a write.
create unique index if not exists email_inbound_message_uniq
  on public.email_inbound (client_id, message_id)
  where message_id is not null and message_id <> '';

create index if not exists email_inbound_contact_idx
  on public.email_inbound (client_id, contact_id, received_at desc) where contact_id is not null;
create index if not exists email_inbound_code_idx
  on public.email_inbound (client_id, short_code, received_at desc) where short_code is not null;
-- The operator's "what could we not file?" query.
create index if not exists email_inbound_unmatched_idx
  on public.email_inbound (client_id, received_at desc) where contact_id is null and short_code is null;

alter table public.email_inbound enable row level security;
-- New tables ship world-readable; 112's lesson. Revoke, then grant back only the read the
-- portal needs. Every write is service-role, from the webhook.
revoke all on public.email_inbound from anon, authenticated;
grant select on public.email_inbound to authenticated;
drop policy if exists email_inbound_owner_select on public.email_inbound;
create policy email_inbound_owner_select on public.email_inbound
  for select to authenticated using (client_id = public.current_client_id());

comment on table public.email_inbound is
  'Customer replies, so the record page shows a conversation rather than a monologue. '
  'Matched to a contact/design by In-Reply-To against email_sends.provider_message_id, '
  'falling back to the sender address. An UNMATCHED reply is still stored — see '
  'email_inbound_unmatched_idx.';
