-- 138_email_template_copy.sql — let a builder write their own words on the emails we send.
--
-- Carolyn, 2026-08-21, looking at the GoHighLevel quote template she wants ported: "I don't
-- know what it's going to take to create like a template that they can edit, you know, for
-- images and all of that stuff too."
--
-- ⚠️ WHAT IS EDITABLE IS THE COPY, NOT THE HTML. This is the whole design decision.
--
-- A free-HTML template would be three bad things at once:
--   1. an injection surface into a customer's inbox, authored by a tenant;
--   2. a way to silently break the quote link, the PDF links and the totals table — the
--      parts of the email that DO something, which a builder editing wording has no reason
--      to be near;
--   3. unmaintainable — every future field (change orders, acceptance receipts) would have
--      to be retro-fitted into whatever markup each tenant had pasted.
--
-- So a builder edits the two things that are genuinely theirs: the SUBJECT and the INTRO
-- sentence. Everything structural — the branded header, the logo, the detail rows, the CTA,
-- the PDF links, the footer — stays ours and keeps working. The logo and colours are
-- already tenant-controlled through Branding, which is the "images" half of her ask.
--
-- Placeholders are substituted server-side and ESCAPED, so a tenant cannot inject markup
-- through them either:
--   {business}  {number}  {total}  {building}  {customer}
--
-- Shape: { "<kind>": { "subject": "...", "intro": "..." } } for kind in estimate|invoice.
-- A missing kind, or a missing field within one, falls back to the shipped wording — so a
-- tenant who never opens this screen sees no change whatsoever.
--
-- Rollback:
--   alter table public.client_settings drop column if exists email_template_copy;

alter table public.client_settings
  add column if not exists email_template_copy jsonb;

comment on column public.client_settings.email_template_copy is
  'Per-tenant SUBJECT and INTRO overrides for outbound document emails, as '
  '{kind: {subject, intro}}. Plain text only with {placeholder} tokens — never HTML: the '
  'structural half of every template (links, totals, CTA, footer) stays owned by the code '
  'so a wording edit cannot break the quote link. Absent = shipped wording.';
