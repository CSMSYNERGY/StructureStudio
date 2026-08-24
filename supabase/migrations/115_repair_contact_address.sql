-- 115_repair_contact_address: the repair carries its customer's ADDRESS, and the seam for
-- SS-native repair invoicing (Carolyn 2026-08-23, Repairs round).
--
-- Address: street/city/state/zip — the exact StopAddress shape _shared/contactAddress.ts
-- defines, so add_stop's repair branch can inherit a site-visit destination the same way
-- design-linked stops already do via addressFrom(). Before this, a repair site visit had NO
-- destination unless someone typed one on the stop itself.
--
-- order_id: the order created FROM this repair's invoice writes its id back here. Soft link,
-- deliberately no FK — the orders table's own migrations live on wip/orders, the same
-- convention as build_jobs.order_id (087). Shipped NOW, ahead of the invoicing build, so the
-- invoicing session never needs a competing repairs migration. Repair invoices are SS-NATIVE
-- ONLY (never GHL), regardless of the tenant's invoice_in_ghl setting.

alter table public.repairs
  add column street text,
  add column city text,
  add column state text,
  add column zip text,
  add column order_id uuid;

-- Rollback:
--   alter table public.repairs
--     drop column street, drop column city, drop column state, drop column zip,
--     drop column order_id;
