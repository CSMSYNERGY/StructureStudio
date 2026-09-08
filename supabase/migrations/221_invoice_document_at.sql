-- 221_invoice_document_at.sql — "is this invoice stale" is a question about the DOCUMENT,
-- not about whether an email succeeded.
--
-- ── THE DEAD END, found 2026-09-08 by testing the whole change-order flow ────────────────
-- Three places refuse a payment when an approved change is NEWER than the invoice: the
-- customer's own pay screen (customer-pay), the invoice signature (customer-accept), and —
-- since 2026-09-07 — the rep's terminal (portal-payments). All three compare
-- `change_orders.acknowledged_at` against `invoice_sends.updated_at`, and the refusal reads:
--
--     "This invoice was issued before the latest approved change. Regenerate and resend it,
--      then take the payment."
--
-- `updated_at` moves when the row changes, and on the re-send path it moves ONLY IF THE EMAIL
-- LANDS. So on a real order with a bad or missing customer email address:
--
--   * the send fails, `updated_at` stays put,
--   * the refusal never clears,
--   * NOBODY can take payment on that order again — not the customer, not the rep,
--   * and the message tells them to do the one thing that cannot succeed.
--
-- Worse, there was no regenerate path at all: the retry branch re-sends the STORED pdf url,
-- and an invoice whose email already succeeded returns "This design was already invoiced."
-- So the remedy the refusal names did not exist in the product. That was survivable while
-- amending a signed order was rare; the change-order rebuild makes it the ordinary case, and
-- Carolyn's requirement is explicitly that a change can happen AFTER delivery and final
-- payment. This is the column that makes the remedy possible.
--
-- ── WHY A NEW COLUMN AND NOT A REUSED ONE ───────────────────────────────────────────────
-- `updated_at` already carries a second meaning: customer-quotes projects it to the customer
-- as `sentAt` ("Invoice sent on …"). Bumping it when a document is rebuilt would tell the
-- customer their invoice was sent at a moment nobody sent anything. Two facts, two columns.
--
-- BACKFILLED TO `updated_at`, so every existing row answers exactly as it does today and no
-- order changes state on apply. Readers use `coalesce(document_at, updated_at)` for the same
-- reason — a row written by an older deploy still has a sensible answer.
--
-- Rollback:
--   alter table public.invoice_sends drop column if exists document_at;
--   -- and revert the four readers to updated_at (they coalesce, so they keep working meanwhile).

alter table public.invoice_sends
  add column if not exists document_at timestamptz;

update public.invoice_sends
   set document_at = updated_at
 where document_at is null;

comment on column public.invoice_sends.document_at is
  'Migration 221. When the invoice DOCUMENT (the PDF) was last built from the current amended figures — NOT when an email was sent, which is what updated_at means and what the customer is shown as "sent". The stale-invoice refusals compare an approved change against coalesce(document_at, updated_at): reissuing the document clears them even when the customer''s email address is undeliverable, which before this was a permanent payment lock-out.';

-- ── Apply-time assertions. These RAISE. ────────────────────────────────────────────────
do $$
declare n int; m int;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='invoice_sends' and column_name='document_at') then
    raise exception '221: invoice_sends.document_at is missing';
  end if;

  -- Nothing may be left unanswered: a NULL here would read as "never built", and the
  -- coalesce covers it, but the backfill is the thing that keeps behaviour identical today.
  select count(*) into n from public.invoice_sends where document_at is null;
  if n <> 0 then raise exception '221: % invoice rows have no document_at after the backfill', n; end if;

  -- And it must equal updated_at everywhere right now — that IS "no order changed state".
  select count(*) into m from public.invoice_sends where document_at is distinct from updated_at;
  if m <> 0 then raise exception '221: % rows already diverge from updated_at — the backfill did not do what it claims', m; end if;

  raise notice '221: document_at added and backfilled on % invoice row(s); every stale check answers exactly as before',
    (select count(*) from public.invoice_sends);
end $$;
