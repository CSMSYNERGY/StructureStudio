-- 165_sms_registration.sql
-- Per-builder A2P 10DLC registration state: the profile/brand/campaign chain, the numbers,
-- and an append-only event trail.
--
-- APPLY BY HAND. NEVER `supabase db push`.
--
-- ARCHITECTURE (Twilio ISV "architecture #4"): ONE parent Twilio account, ONE Secondary
-- Customer Profile + Brand + Campaign + Messaging Service PER BUILDER. Not subaccounts —
-- main-account API keys are denied on subaccount resources, and every A2P endpoint lives on
-- a subdomain (trusthub./messaging./events.), so under subaccounts none of our credentials
-- reach any of it. Twilio's ISV API guide never once says "subaccount".
--
-- ⚠️ NO COMPLIANCE PII LIVES HERE. The builder's EIN, their representative's mobile and the
-- registered street address are held by TWILIO, inside the EndUser/Address objects, and are
-- referenced from here by SID only. What is kept locally is the minimum an operator needs to
-- recognise a row on screen (last 4 of the EIN, the rep's email DOMAIN) — never the values
-- themselves. A support ticket must never be answerable by reading our database.

create table if not exists public.sms_registrations (
  client_id                   text primary key,

  -- ── Our product state ─────────────────────────────────────────────────────────────
  -- The state the PORTAL renders. Kept separate from Twilio's enums below on purpose:
  -- collapsing a vendor's vocabulary into ours is how "failed" renders as "still waiting".
  status                      text not null default 'none',

  -- ── Brand tier ────────────────────────────────────────────────────────────────────
  -- ⚠️ "Low-Volume Standard" IS NOT A BrandType. The Twilio enum is only
  -- STANDARD | SOLE_PROPRIETOR. LVS is BrandType=STANDARD + SkipAutomaticSecVet=true, and
  -- that one boolean sets BOTH the price ($4.50 vs $46) and the throughput ceiling.
  --
  -- ⚠️ SOLE_PROPRIETOR IS AN ELIGIBILITY TIER, NOT A VOLUME TIER. It is for businesses with
  -- NO tax ID. Twilio rejects anyone holding an EIN with error 30915, triggered by (among
  -- other things) a business name containing LLC, Inc. or Corp. Every US LLC has an EIN.
  -- So the intake branches on whether they have an EIN, never on expected volume, and the
  -- default is low_volume_standard. Sole prop additionally needs the representative to
  -- answer an SMS one-time password on a real personal mobile within 24 hours, so it can
  -- never be fully self-serve.
  brand_tier                  text not null default 'low_volume_standard',

  -- ── Twilio object SIDs ────────────────────────────────────────────────────────────
  -- ⚠️ TWO DIFFERENT BU SIDs AT TWO DIFFERENT PATHS, and POST /v1/a2p/BrandRegistrations
  -- takes one of each. customer_profile -> trusthub.twilio.com/v1/CustomerProfiles/{BU};
  -- a2p_profile -> /v1/TrustProducts/{BU}. Two named columns, never one generic bundle_sid:
  -- swapping them is a silent bug that costs a real registration fee to discover.
  customer_profile_sid        text,   -- BU... (Secondary Customer Profile)
  a2p_profile_sid             text,   -- BU... (A2P TrustProduct)
  brand_sid                   text,   -- BN...
  messaging_service_sid       text,   -- MG...
  campaign_sid                text,   -- QE... (the Usa2p resource id, from the REST API)
  -- ⚠️ The Event Streams payload calls the campaign `campaignsid` and it is a CM SID —
  -- a DIFFERENT SID SPACE from the QE above. Resolve inbound events on brand_sid (BN,
  -- which does match) or messaging_service_sid (MG). Never join these two columns.
  campaign_cm_sid             text,

  -- ── Twilio's own status strings, stored verbatim ──────────────────────────────────
  -- REST enums: PENDING | APPROVED | FAILED | IN_REVIEW | SUSPENDED | DELETION_PENDING |
  -- DELETION_FAILED. Event Streams sends lowercase and DISJOINT values (registered,
  -- vetting_failed). Both are normalised at the edge before landing here.
  brand_status                text,
  brand_identity_status       text,   -- SELF_DECLARED | UNVERIFIED | VERIFIED | VETTED_VERIFIED
  campaign_status             text,
  -- errors[] from the brand resource. NOT brand_feedback / failure_reason — both are
  -- documented DEPRECATED, so any rejection UI built on them goes blank without warning.
  last_errors                 jsonb not null default '[]'::jsonb,

  -- Twilio allows THREE free brand resubmissions; a fourth returns HTTP 400 / error 21724.
  brand_update_count          integer not null default 0,

  -- ── Intake echo (recognition only, never the values) ──────────────────────────────
  legal_business_name         text,
  ein_last4                   text,
  rep_email_domain            text,
  website_url                 text,
  privacy_policy_url          text,
  terms_url                   text,

  -- ── AUP attestation ───────────────────────────────────────────────────────────────
  -- Stored the way my-quotes stores a quote acceptance: the sentence VERBATIM, plus who,
  -- when and from where. Twilio's Messaging Policy pushes the consent obligation onto us
  -- and requires us to push it onto the builder; this is the evidence that we did.
  aup_text                    text,
  aup_accepted_at             timestamptz,
  aup_accepted_by             uuid,
  aup_accepted_ip             text,

  -- ── Async machinery ───────────────────────────────────────────────────────────────
  -- Every non-terminal state must carry its next poll. Enforced below by a CHECK so a
  -- transition that forgets to schedule one fails at the database instead of parking a
  -- builder on a spinner nobody is watching.
  next_poll_at                timestamptz,
  -- Single-flight. ⚠️ MUST be taken in ONE conditional UPDATE:
  --   set advance_lock_until = now() + interval '5 minutes'
  --   where client_id = $1 and (advance_lock_until is null or advance_lock_until < now())
  --   returning *
  -- and the caller proceeds ONLY if a row comes back. A column you read and then write
  -- races, and this race is two brand registrations and two real charges for one builder.
  advance_lock_until          timestamptz,
  -- Set when only a human can move this forward (brand suspended, campaign rejected —
  -- campaigns have NO update API, so free remediation is Console-only).
  needs_attention             boolean not null default false,
  attention_note              text,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint sms_registrations_status_chk check (status in (
    'none',              -- nothing started
    'intake',            -- builder is filling the form
    'aup_pending',       -- intake done, AUP not yet accepted
    'ready',             -- everything collected, nothing submitted (no money spent yet)
    'profile_pending',   -- secondary customer profile + trust product submitted
    'brand_pending',     -- brand registered, awaiting carrier
    'brand_failed',
    'brand_approved',
    'campaign_pending',  -- campaign submitted, awaiting carrier
    'campaign_failed',   -- operator-only: fixing this free means the Twilio Console
    'campaign_approved',
    'number_pending',    -- number bought and attached, per-number carrier registration
    'active',            -- REGISTERED: sending is legal
    'paused',            -- operator kill switch; keeps number and campaign
    'releasing',
    'off'
  )),
  constraint sms_registrations_tier_chk check (brand_tier in ('low_volume_standard','standard','sole_proprietor')),

  -- ⚠️ number_pending is EXEMPT from the poll requirement, and that is not laziness.
  -- Per-number A2P registration has NO polling API at all: the Messaging Service
  -- PhoneNumbers resource carries no A2P fields, and Twilio's only status readout is a
  -- Console CSV that can take up to 24 hours to generate. The signal is Event Streams
  -- (com.twilio.messaging.compliance.number-registration.*), with a probe send as fallback.
  constraint sms_registrations_poll_chk check (
    status in ('none','intake','aup_pending','ready','brand_failed','campaign_failed',
               'number_pending','active','paused','off')
    or next_poll_at is not null
  )
);

create index if not exists sms_registrations_due_idx
  on public.sms_registrations (next_poll_at)
  where next_poll_at is not null;
create index if not exists sms_registrations_attention_idx
  on public.sms_registrations (needs_attention)
  where needs_attention;

-- ─────────────────────────────────────────────────────────────────────────────
-- Numbers
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.sms_numbers (
  id                    uuid primary key default gen_random_uuid(),
  client_id             text not null,
  phone_number          text not null,         -- E.164
  twilio_sid            text,                  -- PN...
  messaging_service_sid text,
  -- pending_registration | registered | failed — Twilio's externalstatus, verbatim.
  -- ⚠️ NEVER SEND FROM A NUMBER THAT IS NOT 'registered'. An unregistered US send dies at
  -- the carrier with error 30034, and the failure is invisible to the builder.
  registration_status   text not null default 'pending_registration',
  purchased_at          timestamptz not null default now(),
  -- Released numbers stay as ROWS. sms_messages holds history against them, and a released
  -- number that vanished from this table would orphan a conversation.
  released_at           timestamptz,
  created_at            timestamptz not null default now()
);

-- ⚠️ THE SAFETY PROPERTY OF THE WHOLE INBOUND PATH.
-- sms-inbound resolves the tenant from the `To` number and NOTHING ELSE. Two tenants live
-- on one number would let one builder read another builder's customer conversation. Partial
-- so a released number can be re-bought later by anyone.
create unique index if not exists sms_numbers_live_unique
  on public.sms_numbers (phone_number)
  where released_at is null;

create index if not exists sms_numbers_client_idx
  on public.sms_numbers (client_id) where released_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Event trail — append-only, and the idempotency key for Event Streams
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.sms_registration_events (
  id           uuid primary key default gen_random_uuid(),
  client_id    text,
  -- The CloudEvents id from the Event Streams envelope. Unique, so a redelivery collides
  -- with 23505 — which is a SUCCESS, not a failure: the event is already recorded.
  event_id     text,
  event_type   text,
  -- The raw payload, kept whole. Normalised columns above are a projection of this; when
  -- they disagree, this is the truth.
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create unique index if not exists sms_registration_events_event_id_key
  on public.sms_registration_events (event_id) where event_id is not null;
create index if not exists sms_registration_events_client_idx
  on public.sms_registration_events (client_id, created_at desc);

-- Service-role only. The portal reads all of this through portal-sms.
alter table public.sms_registrations       enable row level security;
alter table public.sms_numbers             enable row level security;
alter table public.sms_registration_events enable row level security;
revoke all on public.sms_registrations       from anon, authenticated;
revoke all on public.sms_numbers             from anon, authenticated;
revoke all on public.sms_registration_events from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Prices — rows, not constants, because 128_usage_wallet was built that way
-- ─────────────────────────────────────────────────────────────────────────────
-- Hard cost at time of writing (verified against Twilio's live Pricing API and the
-- 2026-06-15 A2P fee article): number $1.15/mo, campaign $1.50/mo on Low-Volume Mixed,
-- $0.0083/segment + ~$0.005 carrier pass-through. Registration is $4.50 brand + $15
-- campaign vetting. These are SELL prices with the operator hour priced in — the cost that
-- hurts at 50 builders is human, not Twilio's.
insert into public.usage_prices (kind, label, unit_label, price_cents, active, visible, sort_order, note)
values
  ('sms_registration',   'Text messaging setup',  'one-time', 4900, true, true, 20,
   'One-time carrier registration (brand + campaign vetting). Twilio hard cost about $19.50; the rest is the operator hour every registration actually costs.'),
  ('sms_number_monthly', 'Text messaging number', 'month',    2900, true, true, 21,
   'Includes the number, the A2P campaign and about 500 outbound segments. Twilio hard cost about $2.65/mo fixed.'),
  ('sms_segment',        'Extra text segment',    'segment',     3, true, false, 22,
   'Overage beyond the monthly allowance. Twilio about $0.013/segment all-in including carrier pass-through. A 2-segment message bills twice — see smsSegments().')
on conflict (kind) do nothing;
