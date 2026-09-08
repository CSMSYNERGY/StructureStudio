-- 215_invoice_sends_ghl_sender: give the GoHighLevel sender its own column, and stop
-- `sender_user_id` meaning two different things.
--
-- ── WHY THIS EXISTS, AND WHY IT IS URGENT RATHER THAN TIDY ──────────────────────────────
-- Earlier today (commit 03d5534) the GHL invoice branch stopped writing a GHL user id into
-- `sender_user_id` and started writing the portal user who pressed send, because
-- portal-commissions reads that column as the commission earner and a GHL id can never match
-- a portal user. That fix was right and stands.
--
-- But `sender_user_id` had a SECOND reader: the resend path seeded GHL's own `userId` API
-- parameter from it, so an invoice created-but-not-emailed was re-sent as the exact GHL user
-- it was created with. With the column no longer holding a GHL id, that seed was set to null
-- and the resend now falls back to `users[0]` from GHL's user list — a different person than
-- the invoice was raised as, if the sub-account has more than one user.
--
-- ⚠️ THAT REGRESSION LANDS ON THE ONE BUILDER WHO CANNOT ABSORB IT. Carolyn, 2026-09-07:
--    "the only builder that has actual sales that need to be protected is Junior barns and he
--    is exclusively selling through GHL." Measured the same day: junior-barns has 7 invoices,
--    ALL issued_by='ghl', ALL with a GHL sender recorded.
--
--    It has not bitten yet — all 7 are status='sent', and the resend path only runs for
--    status='created' (created in GHL, never emailed), of which he has none. But every future
--    invoice passes through 'created' on its way to 'sent', so a single failed email would
--    expose it, on the only tenant whose invoices are real money.
--
-- The answer is not to choose between the two meanings. It is to stop overloading one column:
--   sender_user_id      → the PORTAL user. The actor. What commissions pay.
--   ghl_sender_user_id  → GoHighLevel's own user id. An API argument, never a person here.
--
-- GHL is on its way out (Carolyn: "GHL connection will be going away as we are building a CRM
-- here"), and this column goes with it. Until then it keeps the resend faithful.

alter table public.invoice_sends
  add column if not exists ghl_sender_user_id text;

comment on column public.invoice_sends.ghl_sender_user_id is
  'GoHighLevel''s own user id, used as the `userId` argument on GHL invoice/email calls so a '
  'resend goes out as the same GHL user the invoice was raised as. NOT a person in this '
  'product and NEVER an actor — sender_user_id is the portal user. Retires with the GHL '
  'integration.';

-- ── Move the historical ids to the column that means what they are ─────────────────────
-- All 10 existing values are GHL ids (verified: zero match any client_users.user_id). They
-- are moved, not copied, and sender_user_id is cleared on those rows.
--
-- This changes NO behaviour for commissions: portal-commissions:858 already discarded every
-- one of them (`!teamSet.has(earner)` — a GHL id is never in the team set), so those invoices
-- credited nobody before this migration and credit nobody after it. What changes is that the
-- data now says so honestly instead of looking like an attribution that failed.
update public.invoice_sends
   set ghl_sender_user_id = sender_user_id,
       sender_user_id     = null
 where sender_user_id is not null
   and ghl_sender_user_id is null
   and sender_user_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

-- Rollback:
--   update public.invoice_sends set sender_user_id = ghl_sender_user_id where sender_user_id is null and ghl_sender_user_id is not null;
--   alter table public.invoice_sends drop column if exists ghl_sender_user_id;
