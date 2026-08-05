-- 086_invoice_sends_qbo_tid.sql — record Intuit's trace id for each QuickBooks push.
--
-- WHY. qboFetch deliberately never surfaces a QuickBooks error body, because QuickBooks
-- echoes customer fields into validation faults. The cost of that correct decision was a
-- failure recorded as "QuickBooks API 400 on /invoice" — a status code and a path, with no
-- way to learn anything more after the fact. Intuit's `intuit_tid` response header is the
-- opaque per-request correlation id that closes the gap: it carries no customer data, and it
-- is the first thing Intuit support asks for when a push is rejected against a real book.
--
-- Written on BOTH outcomes. On failure it is the trace for the fault; on success it is the
-- trace of the call that created the invoice, which is what makes a "did this really land?"
-- reconciliation answerable without guessing.
--
-- Nullable and additive by design: every existing row keeps a null, and a push whose response
-- carried no tid header (or which failed before reaching Intuit at all) simply leaves it null.
-- No backfill is possible — the tids of past calls are gone.

alter table public.invoice_sends
  add column if not exists qbo_tid text;

comment on column public.invoice_sends.qbo_tid is
  'Intuit intuit_tid trace id for the most recent QuickBooks call on this row (success or '
  'failure). Opaque correlation id, no customer data — quote it in an Intuit support ticket.';
