-- 167_customer_email_otp.sql
-- An email route into the customer quote portal, so a Twilio outage cannot lock every
-- customer out of their own quotes.
--
-- APPLY BY HAND. NEVER `supabase db push`.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- `customer-auth` is SMS-ONLY: request_code and verify_code both go through Twilio Verify
-- with no second route. Login therefore dies on ANY Twilio unavailability — an outage, a
-- billing lapse, a mistyped token, or a messaging suspension. Moving Verify to its own
-- account (the change this was weighed against) narrows exactly one of those; a second
-- channel covers all of them, and Resend is already sending for these tenants.
--
-- ⚠️ THE CODES LIVE HERE, WHICH IS THE OPPOSITE OF THE SMS PATH — and that difference is
-- forced, not chosen. Twilio Verify generates, delivers and checks its own codes, which is
-- why customer-auth's header can say codes are "never stored or logged here, not even
-- hashed". Running our own channel means holding the secret ourselves, so this table is
-- built to the posture that implies:
--   * service-role ONLY (RLS on, zero policies, explicit revokes) — the customer_sessions
--     and commission_members shape
--   * the code is stored as a KEYED hash, never plaintext and never a bare digest. A bare
--     sha256 of a 6-digit code is ~1M guesses, i.e. instant offline, so a read-only leak of
--     this table would hand over live codes. See _shared/emailOtp.ts for the keying.
--   * one live code per (tenant, email) — a new request REPLACES the old, so a stolen
--     older code dies the moment the customer asks for another
--   * attempts counted on the row, so a wrong code cannot be brute-forced within its life

create table if not exists public.customer_email_otps (
  client_id     text not null,
  -- Lower-cased and trimmed at the edge. The identity is the address as typed, normalised
  -- the one way, so throttling, lookup and consumption cannot disagree about who this is.
  email_lower   text not null,
  -- HMAC, not a digest — see the module. Never the code itself.
  code_hash     text not null,
  expires_at    timestamptz not null,
  attempts      integer not null default 0,
  -- Set the moment a code is accepted. A consumed row is kept rather than deleted so a
  -- replay is refused explicitly instead of looking like "no code was ever requested",
  -- which is a different message to the customer.
  consumed_at   timestamptz,
  created_at    timestamptz not null default now(),
  primary key (client_id, email_lower)
);

-- Expiry sweeps and the "is there a live code" read.
create index if not exists customer_email_otps_expiry_idx
  on public.customer_email_otps (expires_at);

alter table public.customer_email_otps enable row level security;
revoke all on public.customer_email_otps from anon, authenticated;

-- ── The send ledger learns a new kind ────────────────────────────────────────
-- email_sends.kind is CHECK-constrained, so a login code cannot be recorded without this.
-- The send goes through sendTenantEmail like every other, which means it comes FROM THE
-- BUILDER'S OWN DOMAIN — the customer gets their code from the same sender that sent the
-- quote, rather than from a platform address they have never seen.
alter table public.email_sends drop constraint if exists email_sends_kind_check;
alter table public.email_sends add constraint email_sends_kind_check
  check (kind = any (array[
    'estimate', 'invoice', 'test', 'acceptance', 'change_order', 'conversation', 'login_code'
  ]));
