-- 062_captured_leads: browsing leads, visible in the tenant's own portal.
--
-- capture-lead has been sending gate/Details leads to the tenant's GHL only — the portal's
-- Contacts tab never showed them, because that tab is built from SUBMITTED designs. The
-- project owner's website "try it out" link makes browsing leads the top of the funnel, so
-- they belong in the portal too. This table is the durable local record: capture-lead
-- writes it FIRST, so a lead survives GHL being unconfigured, down, or rejecting the
-- upsert (previously those leads simply evaporated).
--
-- One row per (tenant, phone), enriched over time: the gate captures name+phone; opening
-- the quote Details later adds email and address onto the same row.

create table if not exists public.captured_leads (
  id bigint generated always as identity primary key,
  client_id text not null,
  name text not null,
  phone_digits text not null,           -- normalized: digits only, the dedupe key
  phone text not null,                  -- as typed, for display
  email text,
  street text, city text, state text, zip text,
  source text not null default 'gate'
    check (source in ('gate', 'details')),
  ghl_contact_id text,                  -- set when the GHL upsert succeeded
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists captured_leads_tenant_phone
  on public.captured_leads (client_id, phone_digits);
create index if not exists captured_leads_client
  on public.captured_leads (client_id, updated_at desc);

-- Same posture as feedback_submissions: tenants READ their own rows; every write is
-- service-role (capture-lead), so the anon designer can never write or read directly.
alter table public.captured_leads enable row level security;
drop policy if exists captured_leads_owner_select on public.captured_leads;
create policy captured_leads_owner_select on public.captured_leads
  for select to authenticated using (client_id = public.current_client_id());

comment on table public.captured_leads is
  'Browsing leads from the public designer (gate pass / Details open), one row per tenant+phone, enriched as more fields arrive. Written service-role by capture-lead BEFORE the GHL upsert so a lead survives GHL failures.';
