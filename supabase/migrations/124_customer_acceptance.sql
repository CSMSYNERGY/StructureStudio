-- 124_customer_acceptance: the record of a customer signing for their order.
--
-- SS-mode only (client_settings.invoice_in_ghl = false, migration 121): CRM-mode customers
-- keep accepting on GHL's hosted estimate page, which we cannot put a signature on. For
-- SS-mode tenants the accept happens on OUR customer quote page (my-quotes.html), where the
-- customer's identity was already proven by the phone OTP (migration 108) — precisely the
-- attribution an electronic signature needs.
--
-- ONE ROW PER SIGNING EVENT, append-only. The row snapshots everything the signature
-- attests to — the quote number, the design version, the total, the exact consent sentence
-- shown — so no later edit of the design, the catalog, or the consent copy can rewrite what
-- was agreed. Same snapshotting philosophy as commission_entries (078).
--
--   subject           'quote' = the initial acceptance; 'change_order' = acknowledging a
--                     change order (migration 12N_change_orders, later — the FK is added
--                     there, in the migration that creates the referenced table).
--   design_version    max(design_versions.version) at signing = the content baseline a later
--                     change order diffs against.
--   method            'drawn' (canvas PNG in the signatures bucket) or 'typed' (the name-as-
--                     signature kept in typed_signature).
--   consent_text      the sentence the customer agreed to, verbatim as shown.
--   phone_digits      the OTP-verified identity that signed; session name kept separately
--                     because the signer may type a fuller legal name than they gave at login.
--
-- WRITES ARE SERVICE-ROLE ONLY (the customer-accept edge function). The portal may read its
-- own tenant's rows to show "signed by NAME on DATE". A browser can never insert one — an
-- e-signature minted by anything but the customer-accept flow would be worthless as evidence.
--
-- Hand-apply via the SQL editor / MCP and record as version 124 — NEVER `supabase db push`.

create table if not exists public.design_acceptances (
  id                   uuid primary key default gen_random_uuid(),
  client_id            text not null,
  short_code           text not null,
  subject              text not null default 'quote'
                       check (subject in ('quote','change_order')),
  change_order_id      uuid,           -- FK added by the change_orders migration
  quote_number         text,
  design_version       integer,
  total                numeric(12,2),
  method               text not null check (method in ('drawn','typed')),
  signer_name          text not null,
  signature_image_path text,           -- signatures bucket path (drawn); null for typed
  typed_signature      text,           -- the typed name-as-signature; null for drawn
  consent_text         text not null,
  phone_digits         text not null,
  session_seen_name    text,
  ip                   inet,
  user_agent           text,
  accepted_at          timestamptz not null default now()
);

-- The insert IS the concurrency claim (invoice_sends precedent): one quote acceptance per
-- design, one acknowledgment per change order. A double-tap or a second device signing
-- concurrently loses on the index, not on a read-then-write race.
create unique index if not exists design_acceptances_quote_once
  on public.design_acceptances (client_id, short_code) where subject = 'quote';
create unique index if not exists design_acceptances_co_once
  on public.design_acceptances (change_order_id) where change_order_id is not null;
create index if not exists design_acceptances_lookup
  on public.design_acceptances (client_id, short_code, accepted_at desc);

alter table public.design_acceptances enable row level security;
revoke all on public.design_acceptances from anon, authenticated;
grant select on public.design_acceptances to authenticated;
drop policy if exists design_acceptances_owner_select on public.design_acceptances;
create policy design_acceptances_owner_select on public.design_acceptances
  for select to authenticated using (client_id = public.current_client_id());
-- No insert/update/delete policies: writes are service-role only, by construction.

-- Private bucket for drawn signatures. NO storage.objects policies on purpose: with none,
-- anon/authenticated can neither read nor write it — only the service role (customer-accept
-- uploads; the acceptance-certificate PDF embeds the image server-side, so nothing ever
-- needs a public URL to it).
insert into storage.buckets (id, name, public)
  values ('signatures', 'signatures', false)
  on conflict (id) do nothing;

-- email_sends grows two kinds now, in one CHECK rewrite: 'acceptance' (the confirmation the
-- customer gets after signing) ships with this slice; 'change_order' (the "a change needs
-- your approval" request) ships with the change-orders slice but is added here so that
-- migration doesn't have to rewrite this constraint a second time.
alter table public.email_sends drop constraint if exists email_sends_kind_check;
alter table public.email_sends
  add constraint email_sends_kind_check
  check (kind in ('estimate','invoice','test','acceptance','change_order'));

-- Rollback:
--   alter table public.email_sends drop constraint if exists email_sends_kind_check;
--   alter table public.email_sends add constraint email_sends_kind_check
--     check (kind in ('estimate','invoice','test'));
--   drop policy if exists design_acceptances_owner_select on public.design_acceptances;
--   drop table if exists public.design_acceptances;
--   delete from storage.buckets where id = 'signatures';  -- only if empty
