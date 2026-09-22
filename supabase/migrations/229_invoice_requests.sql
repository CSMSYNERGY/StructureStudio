-- 229_invoice_requests.sql — a customer's Accept raises a DRAFT invoice; the builder approves it.
--
-- Carolyn, 2026-09-14 (expo prep call): accept → sign the invoice has to happen inside the
-- designer, and today the step in the middle is invisible. Ahsan, 2026-09-15 (decision 1 of the
-- expo plan): "Accept → auto-DRAFT invoice, builder approves with one click. No invoice number,
-- QuickBooks push or inventory claim until the builder approves."
--
-- ── WHY A REQUEST AND NOT AN INVOICE ─────────────────────────────────────────────────────
-- Issuing an invoice is irreversible four times over: it takes the next number in the
-- builder's series, pushes to QuickBooks, claims the inventory unit, and emails a document the
-- customer signs. None of that may happen on a customer's click alone. So the click records
-- an INTENT — this row — and approving it in the portal IS today's send_invoice, unchanged.
-- There is no second "approve" code path to keep correct: portal-settings marks the request
-- approved at the point send_invoice records the invoice (that covers push_to_invoice too).
--
--   public.invoice_requests         one row per design (PK client_id, short_code). Written
--       by customer-accept accept_quote (best-effort, never fails the accept) and answered
--       by portal-settings: send_invoice → 'approved', dismiss_invoice_request → 'dismissed'.
--       notified_at / notify_error say whether the builder's owners and admins were emailed
--       ("Invoice to approve", max 5, from the platform sender). SERVICE-ROLE ONLY: RLS on,
--       zero policies, revoked from anon, authenticated AND public — the invoice_sends (052)
--       posture, because dismiss_note is the team's words about a customer.
--   public.designs.ss_invoice_requested_at   the browser-readable twin, exactly as
--       ss_invoice_sent_at (136) is for invoice_sends: the portal's Orders tab reads `designs`
--       and cannot read this table. Set when a request is raised, CLEARED when the builder
--       dismisses it ("Not now" drops the order back to "Needs invoice"), and left in place on
--       approval — ss_invoice_sent_at outranks it there, and the gap between the two stamps is
--       how long the customer waited. save_design (anon) writes an explicit column list, so
--       a browser cannot set it; its grants are the table's, the same as ss_invoice_sent_at.
--
-- ── THE BACKFILL ─────────────────────────────────────────────────────────────────────────
-- Accepted-but-not-invoiced SS designs become PENDING requests, so the Orders tab shows every
-- order that is waiting on the builder the day this ships, not only the ones accepted after.
-- Same predicate the Orders tab uses for "Needs invoice" (status 'accepted', no
-- ss_invoice_sent_at), narrowed to SS-mode tenants, designs with a quote number, and no issued
-- invoice_sends row.
--
-- COUNTED READ-ONLY ON LIVE, 2026-09-15: 1 design, on structure-studio (the platform's own demo
-- tenant). abc-builder, the only other SS-mode tenant, has none; every other tenant quotes
-- through the CRM (invoice_in_ghl = true) and is untouched.
--
-- notified_at = now() on backfilled rows: they are OLD acceptances, and emailing every owner
-- about each one on apply would be a storm of stale notices. They surface on the Orders tab.
--
-- ⚠️ designs_set_updated_at (BEFORE UPDATE) bumps designs.updated_at on the backfilled design(s).
--
-- ── ORDER OF APPLY ───────────────────────────────────────────────────────────────────────
-- THIS MIGRATION FIRST, then portal-settings. portal-settings' design selects name
-- ss_invoice_requested_at: deployed before this column exists, orders_designs returns 500 (the
-- Orders tab goes empty) and crm_record swallows the error and shows a record with no designs.
-- customer-accept and customer-quotes tolerate the table's absence, BUT DEPLOY customer-accept
-- STRAIGHT AFTER THIS MIGRATION, then re-run statement 3 (the backfill INSERT) and the stamp
-- UPDATE below it once more (review, 2026-09-15). The backfill runs once, at apply. A customer who
-- accepts in the gap gets no request at all: the old customer-accept raises none, and the new one
-- answers an already-accepted design with 'already' before it reaches the request. The order would
-- sit in "Needs invoice" with no builder email. Both statements are idempotent (ON CONFLICT DO
-- NOTHING; the UPDATE only fills ss_invoice_requested_at where it is null), so a second run
-- picks up exactly the gap. customer-quotes has no such gap, so its order is free.
--
-- Hand-apply via `supabase db query --linked` (SQL inline, NOT --file) or the SQL editor, and
-- record as version 229 — NEVER `supabase db push`. Rehearse inside begin … rollback first.
--
-- Rollback (nothing else reads the table or the column once the functions are reverted; the
-- functions tolerate their absence, portal-settings' selects excepted — revert it first):
--   alter table public.designs drop column if exists ss_invoice_requested_at;
--   drop table if exists public.invoice_requests;

-- 1. The request.
create table if not exists public.invoice_requests (
  client_id            text        not null,
  short_code           text        not null references public.designs(short_code) on delete cascade,
  status               text        not null default 'pending'
                                   check (status in ('pending', 'approved', 'dismissed')),
  source               text        not null default 'customer_accept'
                                   check (source in ('customer_accept', 'backfill')),
  -- The acceptance that raised it. SET NULL rather than cascade: the request is the builder's
  -- to-do and outlives a tidy-up of evidence rows, which is not something this table decides.
  acceptance_id        uuid        references public.design_acceptances(id) on delete set null,
  requested_at         timestamptz not null default now(),
  notified_at          timestamptz,
  notify_error         text,
  decided_at           timestamptz,
  -- Who decided: a builder's own user, or a platform operator in view-as (by email — the
  -- invoice_sends.sent_by_operator posture). Never both.
  decided_by_user_id   uuid,
  decided_by_operator  text,
  dismiss_note         text,
  primary key (client_id, short_code),
  -- A decided request says when; a pending one has not been decided.
  constraint invoice_requests_decided_check check ((status = 'pending') = (decided_at is null))
);

alter table public.invoice_requests enable row level security;

-- No policies → service_role only. The PUBLIC grant is the one that bites: this project's
-- default privileges make every NEW table world-readable, and that grant survives a revoke
-- aimed only at anon/authenticated. Revoke it explicitly.
revoke all on public.invoice_requests from public;
revoke all on public.invoice_requests from anon, authenticated;

comment on table public.invoice_requests is
  'Migration 229. A customer''s quote acceptance asking the builder to issue the invoice (a DRAFT: no number, PDF, QuickBooks push or inventory claim). customer-accept raises it; portal-settings send_invoice approves it by issuing the invoice, dismiss_invoice_request sets it aside. Service-role only.';
comment on column public.invoice_requests.notified_at is
  'When at least one owner/admin was emailed "Invoice to approve". Backfilled rows carry the apply time on purpose (no stale-notice storm). notify_error explains a partial or total miss.';

-- 2. The browser-readable twin.
alter table public.designs
  add column if not exists ss_invoice_requested_at timestamptz;

comment on column public.designs.ss_invoice_requested_at is
  'Migration 229. A customer accepted and an invoice request is waiting on the builder. Cleared when the builder dismisses it; left in place when the invoice is issued (ss_invoice_sent_at outranks it). The portal-readable twin of invoice_requests, as ss_invoice_sent_at is of invoice_sends.';

-- 3. Backfill: accepted, not invoiced, SS mode. See the header for the count.
insert into public.invoice_requests
  (client_id, short_code, status, source, acceptance_id, requested_at, notified_at)
select d.client_id,
       d.short_code,
       'pending',
       'backfill',
       (select a.id from public.design_acceptances a
         where a.client_id = d.client_id and a.short_code = d.short_code and a.subject = 'quote'
         order by a.accepted_at desc limit 1),
       d.accepted_at,
       now()
  from public.designs d
  join public.client_settings cs on cs.client_id = d.client_id
 where cs.invoice_in_ghl = false
   and d.status = 'accepted'
   and d.accepted_at is not null
   and d.ss_quote_number is not null
   and d.ss_invoice_sent_at is null
   and not exists (
         select 1 from public.invoice_sends i
          where i.client_id = d.client_id and i.short_code = d.short_code
            and i.status in ('created', 'sent'))
on conflict (client_id, short_code) do nothing;

update public.designs d
   set ss_invoice_requested_at = r.requested_at
  from public.invoice_requests r
 where r.client_id = d.client_id
   and r.short_code = d.short_code
   and r.status = 'pending'
   and d.ss_invoice_requested_at is null;

-- ── Apply-time assertions. These RAISE. ──────────────────────────────────────────────────
do $$
declare
  n_req int;
  n_unstamped int;
  r text;
begin
  if not exists (select 1 from pg_class where oid = 'public.invoice_requests'::regclass and relrowsecurity) then
    raise exception '229: RLS is not enabled on invoice_requests';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_requests') then
    raise exception '229: invoice_requests has a policy — it must be service-role only';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.invoice_requests', 'SELECT')
       or has_table_privilege(r, 'public.invoice_requests', 'INSERT')
       or has_table_privilege(r, 'public.invoice_requests', 'UPDATE')
       or has_table_privilege(r, 'public.invoice_requests', 'DELETE') then
      raise exception '229: % still holds a privilege on invoice_requests', r;
    end if;
  end loop;
  if exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
              where c.oid = 'public.invoice_requests'::regclass and a.grantee = 0) then
    raise exception '229: PUBLIC still holds a privilege on invoice_requests';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'designs' and column_name = 'ss_invoice_requested_at') then
    raise exception '229: designs.ss_invoice_requested_at is missing';
  end if;

  select count(*) into n_unstamped
    from public.invoice_requests r join public.designs d on d.short_code = r.short_code
   where r.status = 'pending' and d.ss_invoice_requested_at is null;
  if n_unstamped <> 0 then
    raise exception '229: % pending request(s) have no designs.ss_invoice_requested_at', n_unstamped;
  end if;

  select count(*) into n_req from public.invoice_requests where source = 'backfill';
  raise notice '229: invoice_requests ready; % backfilled pending request(s) (counted 1 on 2026-09-15)', n_req;
end $$;
