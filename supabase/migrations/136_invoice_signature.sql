-- 136_invoice_signature: the signature moves from the quote to the invoice.
--
-- Carolyn, 2026-08-25, watching a customer sign a quote in the live portal: "I honestly
-- want them to sign the invoice, I don't want them to sign the quote. I want them to
-- accept the quote to let us know, then I will [invoice]." So the ladder becomes:
--
--   QUOTE  -> customer ACCEPTS (a click, recorded, no signature)
--   INVOICE-> operator sends it, customer SIGNS it, and THAT is the commitment.
--
-- WHY designs.status GAINS NO NEW VALUE. 'invoiced' is REDEFINED as "the customer signed
-- the bill" rather than "we issued the bill". That single re-pointing keeps every existing
-- consumer correct with no edit: the build-board gate (portal-schedule create_job refuses
-- anything not 'invoiced'/'delivered'), the sold flag and paperwork lock in the Orders tab,
-- the delivery pool, and the inventory claim. Had we added a status rung instead, each of
-- those would have needed to learn the new word, and the one that got missed would have put
-- an UNSIGNED building on the build schedule. The cost of this choice is that send_invoice
-- must stop flipping the status (it does, in the same deploy) — see ss_invoice_sent_at.
--
--   design_acceptances.subject += 'invoice'   one signing event per document. The partial
--       unique index below is the concurrency claim, exactly as _quote_once is for quotes
--       (124): the INSERT is what makes a double-submit impossible, not a read-then-write.
--   design_acceptances.method += 'click'      an acceptance with no signature is still an
--       acceptance. Keeping the row preserves the evidence that actually matters in a
--       dispute — the OTP-verified phone, the ip, the user agent, and the consent sentence
--       stored verbatim — and it means "did they accept?" has ONE answer table, not two.
--   invoice_sends.signed_at / .acceptance_id  invoice_sends is still "the invoice on our
--       side" (125). These teach it the one thing it could not say: whether the customer
--       has signed. acceptance_id is the join back to the evidence.
--   designs.ss_invoice_sent_at                the browser-readable twin of "an invoice is
--       out". invoice_sends has RLS with ZERO policies (service-role only, 052), so the
--       Orders list cannot read it directly; without this column the portal could not
--       distinguish "needs an invoice" from "invoice sent, waiting on the signature".
--       Mirrors ss_quote_sent_at (122) deliberately, including its nullable-means-never.
--
-- THE BACKFILL IS THE COMPATIBILITY STORY. Designs already 'invoiced'/'delivered' were
-- invoiced under the OLD rule, where issuing was the end of the road. They get
-- ss_invoice_sent_at so the portal renders them coherently, and they keep signed_at NULL
-- forever: the sign_invoice gate is status-based, so it never demands a signature from a
-- design that is already past it, and answers {already:true} if one is attempted.
--
-- Everything here is ADDITIVE. Applied before the code ships it is completely inert: no
-- writer emits 'invoice'/'click' yet, and the new columns stay NULL. That is what makes the
-- rollout order (DDL -> customer functions -> my-quotes -> portal) safe at every step.
--
-- LIVE-ONLY DDL SNAPSHOT (orders/payments have no migration in this repo — their DDL lives
-- on the unmerged wip/orders branch, which exists nowhere; dumped from live 2026-08-26 so a
-- future reader is not guessing):
--   orders(id uuid, client_id text, short_code text, order_no int, total_cents int,
--          currency text, total_source text, ordered_at timestamptz, notes text,
--          created_at, updated_at, submitter_user_id uuid, pretax_subtotal_cents int)
--   payments(id uuid, client_id text, order_id uuid, amount_cents int, method text,
--          reference text, received_at timestamptz, note text, voided_at timestamptz,
--          void_reason text, gateway text, gateway_txn_id text, created_by uuid, created_at)
--   Note for the future card-charging work: the gateway seam is exactly TWO columns,
--   gateway + gateway_txn_id. Anything richer needs its own migration.
--
-- Hand-apply via the SQL editor / MCP and record as version 136 — NEVER `supabase db push`.
-- (135 is email_inbound, authored in a parallel session; this file deliberately steps past
-- it rather than racing it.)

-- 1. The two CHECKs. Names confirmed against live 2026-08-26 (pg_constraint), not assumed.
alter table public.design_acceptances
  drop constraint if exists design_acceptances_subject_check;
alter table public.design_acceptances
  add constraint design_acceptances_subject_check
  check (subject in ('quote','change_order','invoice'));

alter table public.design_acceptances
  drop constraint if exists design_acceptances_method_check;
alter table public.design_acceptances
  add constraint design_acceptances_method_check
  check (method in ('drawn','typed','click'));

-- 2. One signed invoice per design — the claim that makes sign_invoice idempotent under a
--    double-submit. Mirrors design_acceptances_quote_once (124).
create unique index if not exists design_acceptances_invoice_once
  on public.design_acceptances (client_id, short_code)
  where subject = 'invoice';

-- 3. The invoice learns whether it has been signed.
alter table public.invoice_sends
  add column if not exists signed_at timestamptz,
  add column if not exists acceptance_id uuid references public.design_acceptances(id);

-- 4. The browser-readable "an invoice is out" signal.
alter table public.designs
  add column if not exists ss_invoice_sent_at timestamptz;

-- 5. Backfill: legacy SS invoices, so the Orders tab reads coherently on day one.
update public.designs d
   set ss_invoice_sent_at = i.updated_at
  from public.invoice_sends i
 where i.client_id = d.client_id
   and i.short_code = d.short_code
   and i.issued_by = 'structurestudio'
   and i.status in ('created','sent')
   and d.status in ('invoiced','delivered')
   and d.ss_invoice_sent_at is null;

-- ROLLBACK (additive migration — leaving it applied is harmless, and preferred if any code
-- that writes 'invoice'/'click' has already run):
--   drop index if exists public.design_acceptances_invoice_once;
--   alter table public.designs        drop column if exists ss_invoice_sent_at;
--   alter table public.invoice_sends  drop column if exists acceptance_id, drop column if exists signed_at;
--   alter table public.design_acceptances drop constraint design_acceptances_subject_check;
--   alter table public.design_acceptances add  constraint design_acceptances_subject_check
--     check (subject in ('quote','change_order'));
--   alter table public.design_acceptances drop constraint design_acceptances_method_check;
--   alter table public.design_acceptances add  constraint design_acceptances_method_check
--     check (method in ('drawn','typed'));
--   -- Both CHECK restorations FAIL LOUDLY if any 'invoice'/'click' row exists. That is the
--   -- intended behaviour: delete or re-subject those rows first, deliberately.
