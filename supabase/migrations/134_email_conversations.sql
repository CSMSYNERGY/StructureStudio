-- 134_email_conversations.sql — email IS the conversation channel.
--
-- Ahsan, 2026-08-25: "we are using the emails for the conversation now and messaging."
-- Carolyn, 2026-08-21, having ruled out duplicating GoHighLevel: "yes, so when you're
-- saying we need a conversations tab, I do think that is right. So conversations would be
-- email, all of it."
--
-- Two small changes so a free-text email to a customer is a first-class thing rather than
-- something only the quote and invoice paths can do.
--
-- Rollback:
--   alter table public.email_sends drop constraint if exists email_sends_kind_check;
--   alter table public.email_sends add constraint email_sends_kind_check
--     check (kind in ('estimate','invoice','test','acceptance','change_order'));
--   alter table public.email_sends drop column if exists contact_id;
--   drop index if exists email_sends_contact_idx;

-- 1. A new kind. Everything email_sends held until now was a DOCUMENT — an estimate, an
--    invoice, an acceptance receipt. 'conversation' is a person writing to a person, which
--    is what makes the Emails chip on the record page a conversation view rather than a
--    receipt log.
alter table public.email_sends drop constraint if exists email_sends_kind_check;
alter table public.email_sends
  add constraint email_sends_kind_check
  check (kind in ('estimate','invoice','test','acceptance','change_order','conversation'));

-- 2. A contact scope. Every existing row is keyed on short_code, because every existing row
--    was ABOUT a design. A conversation is with a PERSON and often about nothing in
--    particular — "are you still thinking about the 12x24?" — so it needs somewhere to live
--    when there is no design to hang it on.
--
--    Nullable and unconstrained by design: short_code stays the scope for document mail, and
--    a conversation sent from a design record carries BOTH, so it surfaces on the design and
--    on the person without being stored twice.
alter table public.email_sends add column if not exists contact_id uuid;
create index if not exists email_sends_contact_idx
  on public.email_sends (client_id, contact_id, created_at desc)
  where contact_id is not null;

comment on column public.email_sends.contact_id is
  'Set for kind=conversation and for any document mail sent from a contact record. Lets the '
  'CRM feed show a person''s whole email history, including messages that predate or outlive '
  'any single design.';
