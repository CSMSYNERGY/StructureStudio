-- 108_customer_portal.sql — customer phone-OTP quote portal: rate-limit state + sessions.
--
-- WHY. Customers (shed shoppers) get a quote portal where they log in with their PHONE
-- NUMBER, verified by a one-time code via Twilio Verify. This is the feature 048 deferred:
-- 047's anon-callable list_designs_by_phone let a bare, low-entropy 10-digit phone bridge
-- to the unguessable short_code and from there to the design's full contact PII, so 048
-- dropped it with the rollback note "ONLY behind proper phone verification" (048:11).
-- Phone-OTP is that proper verification — the caller PROVES control of the phone before
-- any design is listed, rather than merely knowing the number.
--
-- Division of labour: OTP generation, delivery and checking live entirely in Twilio
-- Verify. Codes are NEVER stored here, not even hashed. These tables hold only (1) the
-- durable rate-limit counters that keep the send/check endpoints from being abused and
-- (2) the bearer sessions minted after a successful verification.
--
-- Hand-apply via the SQL editor / MCP and record as version 108 — NEVER `supabase db push`.

-- ── customer_otp_throttle ────────────────────────────────────────────────────────────
-- One row per bucket: '<client_id>:<phone_digits>' (per-target phone) or 'ip:<addr>'
-- (per-caller). Per-bucket lockout ONLY — NEVER a global hard lock: 053's rationale
-- applies unchanged. There, a global lock would let an attacker deny the operator their
-- own admin tool; here it would let one attacker lock every legitimate shopper out of
-- every tenant's portal. Window lengths, send/fail thresholds and lockout escalation are
-- enforced in the edge function, not in the schema — this table is just the counters.
create table if not exists public.customer_otp_throttle (
  bucket            text primary key,   -- '<client_id>:<phone_digits>' or 'ip:<addr>'
  send_count        int  not null default 0,
  fail_count        int  not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until      timestamptz,
  updated_at        timestamptz not null default now()
);

alter table public.customer_otp_throttle enable row level security;
-- No policies → service_role only (the 053:33–35 posture): the browser never reads or
-- writes throttle state.
revoke all on public.customer_otp_throttle from anon, authenticated;

-- ── customer_sessions ────────────────────────────────────────────────────────────────
-- Minted by the edge function after Twilio Verify approves the code. The browser holds an
-- opaque bearer token; only its sha-256 hex lands here — the raw token is never stored,
-- so a database read yields nothing presentable as a session.
create table if not exists public.customer_sessions (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null,
  phone_digits text not null,           -- digits only — the identity (062's convention)
  name         text,
  token_hash   text not null unique,    -- sha-256 hex of the opaque bearer token
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);

create index if not exists customer_sessions_client_phone_idx
  on public.customer_sessions (client_id, phone_digits);

alter table public.customer_sessions enable row level security;
-- No policies → service_role only (053:33–35): every read/write goes through the edge
-- function, which resolves the session from the hash of the presented token.
revoke all on public.customer_sessions from anon, authenticated;

-- ── designs phone-lookup index ───────────────────────────────────────────────────────
-- The portal's core query is "this tenant's designs for this verified phone" — the same
-- comparison 047 ran as a seq scan over normalized phones. designs.contact->>'phone' is
-- stored as a formatted DISPLAY string ("(555) 555-5555"), so BOTH sides of every phone
-- comparison must normalize to digits — and the query must use this exact expression
-- (regexp_replace over the raw ->> read) or the planner falls back to the seq scan.
create index if not exists designs_client_phone_digits_idx
  on public.designs (client_id, (regexp_replace(contact->>'phone', '\D', '', 'g')));

-- Rollback:
--   drop index if exists public.designs_client_phone_digits_idx;
--   drop table if exists public.customer_sessions;
--   drop table if exists public.customer_otp_throttle;
