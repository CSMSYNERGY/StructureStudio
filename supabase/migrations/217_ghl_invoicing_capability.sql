-- 217_ghl_invoicing_capability: invoicing THROUGH GoHighLevel becomes a per-tenant
-- capability, off by default, and Junior Barns is the only tenant that has it.
--
-- Carolyn, 2026-09-07: "The feature for payments to go through GHL should only show in
-- Junior Barns as he is an active user. All other builders will only have the option to
-- invoice through SS. They can still have the customer info pass to GHL if they choose
-- (for now)."
--
-- ── WHAT THIS DOES NOT TOUCH ────────────────────────────────────────────────────────────
-- The CRM CONNECTION. Location id, API key, pipeline and stages stay available to every
-- tenant, and submit-estimate keeps mirroring contacts and opportunities into a connected
-- CRM while StructureStudio issues the paperwork (submit-estimate:194-204). "Invoice in
-- StructureStudio" has never meant "stop using your CRM", and this change does not make it
-- mean that.
--
-- ⛔ AND IT DOES NOT FLIP ANYONE'S `invoice_in_ghl`. Measured 2026-09-07, six tenants are
--    still true: junior-barns (keeps it), yoder-barns (a real builder), and four demo/test
--    rows. Moving a tenant to our paperwork needs a starting quote number, a starting
--    invoice number and a tax rate — business facts only the builder has. Inventing them is
--    exactly the collision portal-settings:1296-1315 refuses saves over: numbering that
--    restarts at 1 clashes with the paperwork a builder already has in customers' hands.
--
--    So grandfathered tenants keep invoicing precisely as they do today. The switch happens
--    on their next save of that screen, with the numbers filled in — and for everyone but
--    junior-barns the only value that screen can now write is `false`.
--
-- ── WHY A FLAG AND NOT A HARD-CODED SLUG ────────────────────────────────────────────────
-- "for now" is doing real work in Carolyn's sentence: GHL is on its way out, and when
-- junior-barns follows the others this is one UPDATE rather than a code change and a deploy.
-- A tenant slug compiled into an edge function is also the kind of thing that survives its
-- reason by a year.

alter table public.client_settings
  add column if not exists ghl_invoicing_allowed boolean not null default false;

comment on column public.client_settings.ghl_invoicing_allowed is
  'May this tenant issue QUOTES AND INVOICES through GoHighLevel (invoice_in_ghl)? Default '
  'false: new and existing builders invoice from Structure Studio. Says nothing about the CRM '
  'connection itself — contacts and opportunities still flow to a connected GHL either way. '
  'Retires with the GHL integration.';

update public.client_settings
   set ghl_invoicing_allowed = true
 where client_id = 'junior-barns';

-- Rollback:
--   alter table public.client_settings drop column if exists ghl_invoicing_allowed;
