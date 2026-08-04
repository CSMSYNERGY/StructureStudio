-- 059_billing_transition_window: a dated free period, distinct from a permanent comp.
--
-- WHY THIS IS NOT THE EXISTING GRACE PERIOD
-- The 7-day grace in 057 is triggered by a FAILED PAYMENT on an existing subscription —
-- it needs a subscription row, status past_due, and past_due_since to count from. It also
-- says "Your last payment didn't go through". Neither fits a tenant who has never been
-- billed: there is nothing to be past due, and that message would be a lie.
--
-- What was actually needed is a TRANSITION: an existing customer moving from free to paid
-- gets a warned window rather than a wall. Junior Barns is the first case — a live customer
-- since before billing existed, now going onto 50% off for life.
--
-- billing_exempt      = permanent bypass. Never gated for any reason. A failed payment on an
--                       exempt account produces NO banner and NO lock, because exempt is
--                       checked first and short-circuits the whole gate. Correct for CSM
--                       Synergy's own accounts; dangerous to leave on a paying customer.
-- billing_exempt_until = dated. Full access plus a countdown until this instant, then the
--                       normal gate applies. Subscribing clears it early — entitlement goes
--                       to "active" the moment a required subscription is live, so the
--                       banner stops nagging a customer who has already paid.
--
-- Also useful for every future onboarding: a new client can have a week to get set up
-- instead of hitting the gate on day one, and there is a date on the record instead of a
-- comp flag somebody has to remember to revoke.

alter table public.client_settings
  add column if not exists billing_exempt_until timestamptz;

comment on column public.client_settings.billing_exempt_until is
  'Full portal access with a countdown banner until this instant, then the normal billing gate applies. Distinct from billing_exempt (permanent, silent, no banner). An active required subscription supersedes it.';
