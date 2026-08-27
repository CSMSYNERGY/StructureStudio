-- 137_inbound_domain.sql — per-tenant reply addressing, so a builder can hold a whole
-- conversation on their OWN domain.
--
-- Ahsan, 2026-08-26: "I want them to have full conversations in there ... if Junior Barns
-- connects his domain, he should be able to send AND receive emails in there."
--
-- THE ADDRESS HAS TO BE ON THE BUILDER'S DOMAIN. A shared platform reply address
-- (reply@structurestudiosuite.com) would work technically and break the product: the
-- white-label model is that the client never learns who we are, and a customer hitting
-- Reply would see our name. So each tenant gets their own.
--
-- AND IT CANNOT BE THE APEX. Junior Barns already receives his business mail at
-- @jrbarns.com; pointing that MX at an inbound service would take over his company inbox.
-- A subdomain he is not using is the only safe target — and it mirrors what Resend already
-- makes him do for bounce handling (`send.<domain>`), so the shape is familiar rather than
-- alarming.
--
--   inbound_domain = "reply.jrbarns.com"   ← one MX record, his existing mail untouched
--
-- ROUTING IS A TOKEN IN THE LOCAL PART, not a guess:
--
--   d.SS-9R8UHJGTDJ@reply.jrbarns.com   → that design
--   c.<contact-uuid>@reply.jrbarns.com  → that person
--
-- This is deliberately stronger than the In-Reply-To threading the webhook already does.
-- Plenty of mail clients drop or rewrite References headers, and Outlook is the worst
-- offender; the address a customer replies TO always survives, because it is what their
-- client puts in the To field. Header matching stays as the fallback for mail sent before a
-- tenant configured this.
--
-- Rollback:
--   alter table public.client_settings
--     drop column if exists inbound_domain, drop column if exists inbound_status;

alter table public.client_settings
  add column if not exists inbound_domain text,
  -- pending  — the column is set, MX not confirmed yet
  -- active   — mail is arriving
  -- off      — deliberately disabled; send still works, replies just go to the staff member
  add column if not exists inbound_status text not null default 'off'
    check (inbound_status in ('off', 'pending', 'active'));

-- One tenant per inbound domain, or a reply could be attributed to the wrong builder — the
-- same reasoning as the existing uniqueness on email_domain. Partial so the many tenants
-- with none do not collide on null.
create unique index if not exists client_settings_inbound_domain_uniq
  on public.client_settings (inbound_domain)
  where inbound_domain is not null and inbound_domain <> '';

comment on column public.client_settings.inbound_domain is
  'Subdomain that receives customer replies, e.g. reply.jrbarns.com. MUST NOT be the apex — '
  'the tenant almost certainly receives their real business mail there. Replies are addressed '
  'to d.<short_code>@ or c.<contact_id>@ on this domain, which routes exactly rather than '
  'guessing from headers a mail client may have stripped.';
