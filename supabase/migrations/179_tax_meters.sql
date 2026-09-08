-- 179_tax_meters: what a sales-tax calculation costs, and who pays for it.
--
-- ── WHY TWO METERS AND NOT ONE ─────────────────────────────────────────────────────
-- Carolyn, 2026-09-01, on Avalara's pricing: "it can either be on every invoice created ...
-- or every time that they do a quote, and it's two different pricing ranges ... they'll do
-- 10, 12, 14 quotes sometimes per customer. I can assure you I'm not going to pay that. I can
-- assure you it will be on invoice generated."
--
-- She is confirming which product we are on at her next call. Those are genuinely DIFFERENT
-- products with different unit economics, and the code that charges for them lives in
-- different places — per-invoice at send_invoice, per-lookup at the two resolveRate call
-- sites. Waiting for the answer would have meant writing the whole thing twice or guessing;
-- seeding BOTH meters inactive and wiring BOTH charge points means her answer is a
-- one-statement UPDATE rather than a rebuild.
--
-- ⚠️ ARMING BOTH AT ONCE WOULD DOUBLE-CHARGE. They are separate meters precisely so that is
-- a visible configuration mistake rather than an invisible code one — exactly one of these
-- rows should ever carry active = true. The prices are 0 on purpose: an armed meter with no
-- price is a debit of nothing, which is a far better failure than an armed meter carrying a
-- number nobody agreed to. Set the price in the same statement that arms it.
--
-- ── WHY INACTIVE, WHICH IS NOT A DETAIL ────────────────────────────────────────────
-- 169_sms_meters_disarmed is the worked example of getting this wrong: 165 seeded its SMS
-- meters active = true, and the first builder to submit a registration would have been
-- charged $49 by code nobody had yet watched run. Same rail as 109_feature_grants and the
-- note at the bottom of 128 — the deploy is a PROVABLE NO-OP until one boolean moves.
--
-- ── HOW IT CHARGES ─────────────────────────────────────────────────────────────────
-- DIRECT-POST, not a hold, and `_shared/taxMeter.ts` carries the reasoning: wallet_tx_one_hold
-- is unique on (client_id, meter_kind), so two staff invoicing at the same moment on one
-- tenant would collide with hold_in_flight and one of them would be refused a tax figure.
-- 128's own rule points the same way — holds are for expensive, slow, failure-prone meters.
--
-- Hand-apply via the SQL editor / MCP and record as version 179. NEVER `supabase db push`.

insert into public.usage_prices (kind, label, unit_label, price_cents, active, visible, sort_order, note)
values
  ('tax_invoice', 'Sales tax calculation', 'invoice', 0, false, true, 30,
   'Charged once per invoice sent, when the tax on it was resolved from Avalara rather than the tenant''s fallback rate. Carolyn 2026-09-01 expects this to be the product we buy. Price is 0 until her pricing call — set it in the same statement that arms it.'),
  ('tax_lookup', 'Sales tax lookup', 'lookup', 0, false, true, 31,
   'The alternative product: charged per successful Avalara rate lookup, so every quote a customer reprices costs money. Seeded so the choice is a config change, NOT a rebuild. Do not arm this one AND tax_invoice.')
on conflict (kind) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ ARM SEPARATELY — deliberately NOT part of this file, and ONE of these only.
-- Deploy the functions first, send a real invoice, and confirm it writes NO wallet row.
-- Then, once Carolyn has Avalara's number:
--
--   update public.usage_prices set price_cents = <cents>, active = true where kind = 'tax_invoice';
--   -- or, if their pricing turns out to be per lookup:
--   update public.usage_prices set price_cents = <cents>, active = true where kind = 'tax_lookup';
--
-- To roll back an arming, set active = false. The posted wallet_transactions rows stay:
-- they are money that moved, and 174 makes the same choice for the same reason.
-- ─────────────────────────────────────────────────────────────────────────────
