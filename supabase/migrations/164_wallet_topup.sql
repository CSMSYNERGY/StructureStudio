-- 164_wallet_topup: auto-recharge configuration for the prepaid usage wallet.
--
-- WHY NOW. The wallet shipped in 128 as infrastructure with its funding side deliberately
-- unbuilt — Carolyn, 2026-08-24: "I will connect the wallet to Deposyt AFTER — just set the
-- infrastructure up right now." This is that AFTER. Top-ups were never gated by a flag; they
-- were inert because nothing called wallet_credit with kind='topup'. The code that does now
-- exists (_shared/walletTopup.ts), so the only thing missing from the SCHEMA is somewhere to
-- keep "when I drop below $X, put $Y back".
--
-- ⚠️ THIS DOES NOT ARM THE METER. usage_prices.active stays false for video_3d_generation.
--    128's arming statement is still deliberately unrun and still lives outside a migration.
--    Order matters and it is this way round on purpose: arming spending BEFORE funding works
--    would charge builders a balance they have no way to refill online. Fund first, then arm.
--
-- NO NEW TABLE. Auto-recharge is four facts about an account that already exists, so they
-- live on wallet_accounts beside metered_exempt and monthly_ai_cost_cap_cents rather than in
-- a settings table that would need its own row lifecycle and its own RLS posture.

alter table public.wallet_accounts
  -- Off for everyone, always, until a human turns it on. There is no sensible default for
  -- "charge my card without asking me", and a migration is not the place to opt anyone in.
  add column if not exists auto_topup_enabled         boolean not null default false,
  -- Both null until configured. The edge function refuses to enable without both, so a row
  -- can never be enabled-but-meaningless.
  add column if not exists auto_topup_threshold_cents bigint,
  add column if not exists auto_topup_amount_cents    bigint,
  -- COOLDOWN ANCHOR, and the cheap race guard. Stamped BEFORE the charge is attempted, not
  -- after: a burst of 3D generations can drive the balance under the threshold several times
  -- in seconds, and the failure mode to design against is five recharges, not a late one.
  add column if not exists auto_topup_last_at         timestamptz,
  -- WHY A DECLINE TURNS IT OFF rather than retrying. An unattended charge that fails is not
  -- a transient to be retried — an expired card fails identically every time, and a loop
  -- against it earns real declines on the merchant account. So a decline sets this, flips
  -- enabled to false, and the Billing tab shows the reason. Re-enabling is a human act.
  -- NOT set for a GATEWAY-UNKNOWN outcome: that already blocks further top-ups through the
  -- billing_charge_attempts closed_unknown row, and support's reconciliation clears it.
  add column if not exists auto_topup_disabled_reason text;

-- Sanity, enforced where it cannot be forgotten. The edge function validates the same bounds
-- with friendlier messages; this is the backstop for anything that writes here later (an
-- operator action, a support fix by hand, a future admin UI).
--   $20 floor  = one 3D generation, the cheapest top-up that buys anything.
--   $5,000 cap = a typo guard, matching the per-entry cap admin-catalog already applies to
--                operator grants (wallet_credit callers there cap at 500000 cents).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wallet_accounts_auto_topup_sane') then
    alter table public.wallet_accounts add constraint wallet_accounts_auto_topup_sane check (
      (not auto_topup_enabled)
      or (auto_topup_threshold_cents is not null and auto_topup_threshold_cents between 2000 and 500000
          and auto_topup_amount_cents  is not null and auto_topup_amount_cents  between 2000 and 500000)
    );
  end if;
end $$;

-- No RLS change: wallet_accounts is already service-role only (128), and these columns are
-- served to owners through portal-billing's `status` projection like the rest of the wallet.
--
-- Rollback:
--   alter table public.wallet_accounts drop constraint if exists wallet_accounts_auto_topup_sane;
--   alter table public.wallet_accounts
--     drop column if exists auto_topup_enabled,         drop column if exists auto_topup_threshold_cents,
--     drop column if exists auto_topup_amount_cents,    drop column if exists auto_topup_last_at,
--     drop column if exists auto_topup_disabled_reason;
