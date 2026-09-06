import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import type { GateTable } from "../_shared/access.ts";
import { withErrorLog } from "../_shared/logError.ts";
import { paidThroughOf, unusedCreditOf } from "../_shared/billingPeriods.ts";
import { GATEWAY, TOKENIZATION_KEY, nmiConfigured, nmiPost, isGatewayUnknown } from "../_shared/nmi.ts";
import { chargeTopup, MIN_TOPUP_CENTS, MAX_TOPUP_CENTS } from "../_shared/walletTopup.ts";

// Only `status` is a read here; subscribe/cancel move real money.
// WHAT EACH ACTION REQUIRES (migration 100) — see _shared/access.ts.
//
// `status` is "open" and must stay that way. settings_billing is the one ownerOnly area, so
// gating this action on it would 403 the entitlement call for every non-owner — and
// entitlement is what the whole portal shell reads to decide whether the product is
// unlocked. A driver would not get a locked Billing tab, they would get a dead portal. The
// money-shaped half of the payload is filtered inside the branch instead (search: BILLING
// FIELD FILTER); what stays open is entitlement, which every role's UI genuinely needs.
//
// subscribe/cancel are settings_billing:'edit' = owners, plus any ADMIN an owner has
// granted Billing to (ownerGranted, 2026-08-08 — this reconciled Carolyn's two calls:
// "Billing stays with owners" and "admin should be able to as well". The owner decides
// which admin, per person, on the Team screen; the default for every admin is still
// 'none', and a granted admin cannot pass the grant on). The gate itself is unchanged —
// effectiveAccess simply resolves 'edit' for a granted admin now.
const GATES: GateTable = {
  status:    "open",
  subscribe: { area: "settings_billing", level: "edit" },
  cancel:    { area: "settings_billing", level: "edit" },
  // Wallet funding (migration 164). Same audience as subscribe, and for the same reason:
  // both move money off this tenant's card. topup_settings is a config write rather than a
  // charge, but it AUTHORISES unattended charges, so it is not a lesser permission.
  topup:          { area: "settings_billing", level: "edit" },
  topup_settings: { area: "settings_billing", level: "edit" },
};

// Platform billing endpoint for the portal's Billing tab — CSM Synergy charging
// tenants for StructureStudio features via the Deposyt/NMI gateway.
//
// v2 model (2026-07-24): per-FEATURE subscriptions. Each feature (Simple Layout,
// On Demand Pricing, 3D View, …) is its own recurring subscription, chosen monthly
// or annual independently. Simple Layout is the required base. Checkout flow:
// Collect.js tokenizes the card once in the browser → we create an NMI Customer
// Vault record (billing_customers) → charge one one-time sale for any setup fees →
// start one recurring subscription per selected feature off the vault. The vault
// also lets a returning tenant add features without re-entering their card.
//
// Grandfathering: each subscription row snapshots price_cents at subscribe time,
// and NMI subscriptions keep their created terms — future price changes never
// touch existing (founding) subscriptions.
//
// Auth mirrors portal-settings (real user via auth.getUser() → client_users);
// owner/admin only, client_id never from the body.
//
// Actions:
//   { action: "status" } → { configured, hasCard, plans[], subscriptions[], checkout? }
//   { action: "subscribe", planIds: string[], paymentToken? }
//       paymentToken required unless a vault card is on file.
//   { action: "cancel", subscriptionId }
//
// Secrets: NMI_SECURITY_KEY, NMI_TOKENIZATION_KEY, optional NMI_GATEWAY_URL.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// The gateway client lives in _shared/nmi.ts since 2026-08-29 — portal-settings needs it too
// (wallet auto-recharge charges a card at debit time), and two copies of isGatewayUnknown is
// how a customer gets charged twice. Behaviour is identical to the version that used to sit
// here; see that file's header for the money-path contract.

Deno.serve(withErrorLog("portal-billing", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── Warm-up ───────────────────────────────────────────────────────────────────────
  // A table-free ping, the same shape as portal-schedule's, so the first real call does not
  // also pay a cold isolate boot (~2.5 s before the first query). Three properties are
  // deliberate and load-bearing:
  //   • it answers BEFORE any client, auth or tenant resolution, so it costs no round trip
  //     and cannot log a refusal — a ping firing on every boot must never fill app_errors;
  //   • it is a QUERY PARAM, not an action, so it needs no GATES entry (preflight
  //     cross-checks gates against action branches) and unknown-action handling is untouched;
  //   • it never reads the request BODY — the code below owns the single parse of that
  //     stream, and consuming it here would break every real call.
  // Booting the isolate IS the whole job; there is nothing to return but the acknowledgement.
  if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Auth + tenant resolution, shared with portal-settings / sync-design-status.
  // requireBilling: an operator additionally needs the can_bill capability here, because
  // every non-read action on this function moves real money against the tenant's card.
  const admin = createClient(supabaseUrl, serviceKey);
  const r = await resolveTenant(req, admin, {
    gates: GATES,
    readActions: new Set(),
    defaultAction: "status",
    requireBilling: true,
  });
  if (!r.ok) return json(r.body, r.status);
  const { clientId, operator, payload, action, userEmail, userId, audit, auditStrict, canRead } = r.ctx;
  if (operator) audit(`operator_billing_${action}`).catch(() => {});
  const configured = nmiConfigured;

  // Plan rows. Two DIFFERENT questions are asked of this table and conflating them locked out
  // paying customers:
  //   * "what may this tenant BUY?"      → active rows only (`plans`, below)
  //   * "what does this subscription MEAN?" → every row, active or not (`planById`)
  // Entitlement resolves a subscription's feature through planById. When that map held only
  // active rows, retiring a price point (active=false — exactly what the flag is for, and
  // grandfathered price snapshots make old rows natural retirement candidates) made every
  // subscription on it invisible: the tenant computed as locked/never_paid while the gateway
  // kept charging their card, and the duplicate-purchase 409 stopped firing so they could be
  // sold the same feature twice. A plan row is a historical fact; only its availability expires.
  const { data: planRows, error: plansErr } = await admin
    .from("billing_plans")
    .select("id, feature, name, price_cents, billing_interval, gateway_plan_id, setup_fee_cents, availability, required, sort_order, price_visible, active, operator_grantable")
    .order("sort_order", { ascending: false });
  if (plansErr) return json({ error: plansErr.message }, 500);
  const allPlans = planRows ?? [];
  const plans = allPlans.filter((p) => p.active);   // purchasable / gate-driving
  const planById = new Map(allPlans.map((p) => [p.id, p]));   // interpretive, includes retired

  // BUNDLES: one subscription that grants several features. The Structure Studio Suite
  // ("full_suite") unlocks everything except Self Serve Displays. expandFeature() turns a
  // subscription/cart feature into the concrete features it confers — a bundle expands to itself
  // PLUS its members, a plain feature to just itself. Used for entitlement, live-set, and the
  // purchase guards so a bundle satisfies the base and can't be stacked on the pieces it covers.
  const BUNDLE_FEATURES: Record<string, string[]> = {
    full_suite: ["simple_layout", "schedule_builds", "view_3d", "quickbooks_sync", "on_demand_pricing", "crm"],
  };
  const expandFeature = (f: string | null | undefined): string[] =>
    !f ? [] : (BUNDLE_FEATURES[f] ? [f, ...BUNDLE_FEATURES[f]] : [f]);

  // All subscription rows for this tenant, newest first (cancelled kept for history).
  const { data: subRows, error: subsErr } = await admin
    .from("billing_subscriptions")
    .select("id, plan_id, status, price_cents, current_period_start, current_period_end, canceled_at, created_at, past_due_since")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (subsErr) return json({ error: subsErr.message }, 500);
  const subs = subRows ?? [];
  const liveFeatures = new Set<string>();
  for (const s of subs) {
    if (s.status === "cancelled") continue;
    for (const t of expandFeature(planById.get(s.plan_id)?.feature)) liveFeatures.add(t);
  }

  // Card on file? (NMI Customer Vault id — never sent to the browser.)
  const { data: vaultRow } = await admin
    .from("billing_customers").select("vault_id").eq("client_id", clientId).maybeSingle();
  const vaultId: string | null = vaultRow?.vault_id ?? null;

  // ── Entitlement: may this tenant use the portal, and which features? ──────────
  // Computed HERE, not in the browser: client_settings (which holds billing_exempt)
  // is service-role only, so a tenant can't read the flag, let alone self-grant.
  //
  // A FAILED payment gets a grace period — a paying customer with an expired card
  // keeps working (with a warning) instead of being locked out mid-week. A
  // CANCELLATION is deliberate and locks immediately.
  const GRACE_DAYS = 7;
  const { data: csRow } = await admin
    .from("client_settings").select("billing_exempt, billing_exempt_until, discount_percent, discount_features, internal_account")
    .eq("client_id", clientId).maybeSingle();
  const exempt = Boolean(csRow?.billing_exempt);
  // INTERNAL ACCOUNT (migration 169): this tenant is CSM Synergy, not a customer. It gets
  // every feature including the pay-only ones, because there is no revenue to protect from
  // ourselves and a demo has to be able to show the product.
  //
  // This exists because `operator` is only true when a TARGET is supplied — signing into
  // your own portal takes the ordinary tenant path, so "operators are never gated" was only
  // ever true of view-as. See migration 169's header for the full diagnosis.
  //
  // DELIBERATELY SEPARATE FROM `exempt`. Widening billing_exempt to cover pay-only would
  // have unlocked every paid feature for every grandfathered builder on the platform.
  const internal = Boolean(csRow?.internal_account);
  // A DATED free period (migration 059) — an existing customer moving from free to paid gets
  // a warned window instead of a wall. Unlike billing_exempt this is visible (countdown
  // banner) and self-expiring, and it is deliberately checked AFTER the normal entitlement
  // so that subscribing supersedes it rather than nagging someone who has already paid.
  const exemptUntilMs = csRow?.billing_exempt_until ? Date.parse(csRow.billing_exempt_until) : NaN;
  const inTransition = Number.isFinite(exemptUntilMs) && exemptUntilMs > Date.now();

  // ── Account discount (migration 058) ──────────────────────────────────────────
  // An attribute of the ACCOUNT, not of a purchase, so it applies to whatever they
  // subscribe to whenever — no coupon to re-enter. Read here (service-role) and never
  // accepted from the browser. RECURRING ONLY: setup fees are charged in full.
  const discountPct = Math.max(0, Math.min(100, Number(csRow?.discount_percent) || 0));
  const discountFeatures: string[] = Array.isArray(csRow?.discount_features) ? csRow!.discount_features : [];
  // Empty list = every feature.
  const discountForFeature = (feature: string | null | undefined): number => {
    if (!discountPct || !feature) return 0;
    if (discountFeatures.length && !discountFeatures.includes(feature)) return 0;
    return discountPct;
  };
  // Round HALF UP on the customer's side of the deal: 50% of $19.99 bills as $10.00,
  // never $9.99, so we can never under-collect by a cent against the stated percentage.
  const chargeCentsFor = (plan: { feature?: string | null; price_cents?: number | null }): number => {
    const list = Number(plan?.price_cents) || 0;
    const pct = discountForFeature(plan?.feature);
    return pct ? Math.round((list * (100 - pct)) / 100) : list;
  };

  // Returns a number, never null — both branches produce one. The annotation used to say
  // `number | null`, which made the `ends > now` comparison below a type error and, worse,
  // described the opposite of the intended policy: a null would have compared false and locked
  // a past-due tenant instantly, which is exactly what the grace period exists to prevent.
  const graceEndOf = (s: any): number => {
    const since = s?.past_due_since ? Date.parse(s.past_due_since) : NaN;
    // No timestamp (e.g. a row that predates this column) → grace from now, so a
    // missing value is generous rather than an instant lockout.
    return Number.isFinite(since) ? since + GRACE_DAYS * 86400000 : Date.now() + GRACE_DAYS * 86400000;
  };

  // How far the tenant has actually PAID through, for a cancelled subscription.
  //
  // Since 2026-07-29 each period is charged UP FRONT, so a cancellation must keep access to the
  // period already bought. The stored current_period_end cannot be trusted for this on its own:
  // only checkout ever writes it (the FIRST renewal date), and billing-webhook's periodEnd is
  // dead data — NMI sends next_charge_date '1970-01-01' on every observed live event, which gets
  // filtered to null. So after the gateway's first renewal the column still holds period 1's end,
  // and a cancellation months later evaluated as "paid through a past date" → locked the same day,
  // confiscating the period the tenant had just paid for and contradicting the cancel dialog.
  //
  // Roll the stored boundary forward by whole billing intervals instead. The anchor and the
  // interval are both facts we hold; the roll STOPS at cancellation, because that is when the
  // gateway stopped charging — so this credits every period that was paid and not one more.
  //
  // On the cadence, deliberately: since 2026-08-24 every NEW subscription bills on a
  // day-of-month capped at 28 (custom-amount form — the only form now), while the two legacy
  // plan_id subscriptions (simple_layout_annual, pre-collapse) still follow their gateway
  // plan's day_frequency (365 yearly). This uses CALENDAR intervals for all of them rather
  // than inferring the path per row, because 12 × 30 days = 360 < 365: a calendar boundary is
  // never EARLIER than the gateway's, so the worst case is a tenant keeping a couple of days
  // more than they strictly bought. That direction is the whole point — this value is a floor
  // on access already paid for, not an instruction to charge anyone.
  // The arithmetic itself (addInterval + the roll-forward) lives in _shared/billingPeriods.ts,
  // shared with admin-catalog's operator billing overview so both compute the same dates.
  const paidThrough = (s: any): number =>
    paidThroughOf(s, planById.get(s?.plan_id)?.billing_interval ?? "month");
  const now = Date.now();
  // Best state per feature: active beats in-grace beats everything else.
  const featureState = new Map<string, { usable: boolean; state: string; graceEnds: number | null }>();
  for (const s of subs) {
    const feature = planById.get(s.plan_id)?.feature;
    if (!feature) continue;
    let st = { usable: false, state: String(s.status || ""), graceEnds: null as number | null };
    if (s.status === "active") st = { usable: true, state: "active", graceEnds: null };
    else if (s.status === "past_due") {
      const ends = graceEndOf(s);
      st = ends > now ? { usable: true, state: "grace", graceEnds: ends } : { usable: false, state: "past_due", graceEnds: ends };
    } else if (s.status === "cancelled") {
      // Since 2026-07-29 checkout charges each period UP FRONT, so a cancellation must keep
      // access through what was already paid — locking at once would confiscate a prepaid
      // year, and the cancel dialog explicitly promises "stops at the end of the billing
      // period". current_period_end is reliable on rows created since the same change; the
      // legacy rows without it (nothing was prepaid under the old bill-in-arrears flow)
      // fall through to the old lock-immediately behaviour, which for them is correct.
      const paidUntil = paidThrough(s);
      if (Number.isFinite(paidUntil) && paidUntil > now) {
        st = { usable: true, state: "cancelled_paid", graceEnds: null };
      }
    }
    const rank = (x: { state: string }) => (x.state === "active" ? 3 : x.state === "grace" || x.state === "cancelled_paid" ? 2 : x.state === "past_due" ? 1 : 0);
    // A bundle subscription confers its state on every feature it includes.
    for (const feat of expandFeature(feature)) {
      const prior = featureState.get(feat);
      if (!prior || rank(st) > rank(prior)) featureState.set(feat, st);
    }
  }

  // ── UPGRADE CREDIT (migration 160) ────────────────────────────────────────────────────
  // Moving to a bundle throws away prepaid time on the pieces it replaces. Checkout bills
  // every period UP FRONT, so that time is money the builder has already handed over, and
  // taking it twice is not a pricing decision — it is charging for the same months twice.
  // Carolyn 2026-08-29: "if someone has paid for one or multiple and decide to upgrade to
  // the suite I want to comp them for what was already paid on a prorated scale".
  //
  // Only subscriptions the bundle SUPERSEDES are credited: a feature outside the bundle
  // (Self Serve Displays) keeps running and keeps its money. Only subscriptions that are
  // still usable are credited — the same set featureState calls usable, which is what makes
  // "you paid for time you have not used" true. A past_due subscription outside its grace
  // paid for nothing, and crediting it would invent money.
  //
  // Returns the breakdown, not just a total: once the source subscriptions are cancelled the
  // total cannot be re-derived, and billing_upgrade_credits has to store WHY.
  const creditForBundle = (bundleFeature: string) => {
    const members = new Set(BUNDLE_FEATURES[bundleFeature] ?? []);
    if (members.size === 0) return { cents: 0, sources: [] as { planId: string; name: string; cents: number }[] };
    const sources: { planId: string; name: string; cents: number }[] = [];
    for (const s of subs) {
      const plan = planById.get(s.plan_id);
      if (!plan || !members.has(plan.feature)) continue;
      // Usable == paid for and not yet consumed. Mirrors featureState's branches.
      if (!featureState.get(plan.feature)?.usable) continue;
      const cents = unusedCreditOf(s, plan.billing_interval ?? "month", now);
      if (cents > 0) sources.push({ planId: s.plan_id, name: plan.name ?? s.plan_id, cents });
    }
    return { cents: sources.reduce((a, x) => a + x.cents, 0), sources };
  };

  const requiredFeatures = [...new Set(plans.filter((p) => p.required).map((p) => p.feature))];
  // PAID-ONLY features: the exempt/transition blankets deliberately do NOT cover these.
  // Carolyn 2026-08-04: "No one gets grandfathered into this" — the scheduling suite
  // (Build Schedule + Delivery Schedule + Repairs + drivers/territories) is available
  // ONLY with a real subscription, for every tenant: grandfathered, internal, and
  // free-period accounts included. Operators still see the tabs via the portal's own
  // isOperator branch, which never consults this map.
  //
  // quickbooks_sync joined it 2026-08-08, same call. Without it the new QuickBooks gate
  // would be decorative: every tenant that predates the billing gate is `exempt`, so the
  // blanket below would hand them the feature free and only brand-new tenants would ever
  // pay for a plan that has been on sale since migration 092. Checked before making the
  // change — exactly one tenant had a live QuickBooks connection (structure-studio, CSM
  // Synergy's own account), and operators are never gated, so no builder lost a working
  // integration.
  //
  // on_demand_pricing joined 2026-08-28, as the Real-Time Pricing build started (Carolyn
  // 2026-08-27: "There's an upcharge if they want to utilize the real-time pricing").
  // Same shape as quickbooks_sync: the plan has been on sale since 124 with nothing
  // behind it, so the moment real code appears the exempt blanket would hand it to every
  // pre-gate tenant free. Pay-only BEFORE any frontend read ships is what keeps the
  // feature dark. Server enforcement mirror: _shared/featureCheck.ts (portal-settings
  // rtp_* actions) — its state rules and this set must stay in agreement.
  //
  // crm joined 2026-08-29 (migration 160), and it is the FIRST of these where the feature
  // was already built, already shipped and already in daily use by real tenants before it
  // had a price. That inverts the usual risk. quickbooks_sync and on_demand_pricing went
  // pay-only while still dark, so nobody noticed; crm going pay-only TAKES the Contacts tab
  // and the pipeline board away from tenants using them today. Carolyn was shown exactly who
  // (junior-barns 26 contacts, yoder-barns 1) and chose it anyway: "Let them lose it."
  // Consequence to keep in view — pay-only is also NOT grantable (see `grantable` below), so
  // there is no comping this one from the Accounts screen. If she later wants to hand it to a
  // named builder free, the honest move is to take crm OUT of this set and mark the plans
  // operator_grantable, not to bolt an exception onto the pay-only branch.
  const PAID_ONLY_FEATURES = new Set(["schedule_builds", "quickbooks_sync", "on_demand_pricing", "crm"]);

  // OPERATOR GRANTS (migration 109). An operator can comp one feature to one tenant before it
  // is on sale — Carolyn 2026-08-18, about showing 3D to chosen builders. Read here because
  // client_feature_grants is service-role only: a tenant can neither see nor forge its own.
  // FAIL SOFT, like the entitlement itself: this table is a comp bonus, and a read error
  // (the table missing on a restored pre-109 snapshot is the proven case -- deploying this
  // function ahead of migration 109 hard-500'd every billing call for two minutes on
  // 2026-08-19) must cost the comp, never the whole billing/entitlement surface.
  const { data: grantRows, error: grantErr } = await admin
    .from("client_feature_grants")
    .select("feature, expires_at")
    .eq("client_id", clientId);
  if (grantErr) {
    console.error("client_feature_grants read failed; treating as no grants:", grantErr.message);
  }
  const nowMs = Date.now();
  const granted = new Set(((grantErr ? [] : grantRows) ?? [])
    .filter((g) => !g.expires_at || Date.parse(g.expires_at) > nowMs)
    .map((g) => g.feature));
  // Read off allPlans, NOT plans: a feature whose current price point has been retired must
  // not silently stop being grantable (the same lesson planById records above). Belt and
  // braces on PAID_ONLY: operator_grantable defaults false so those cannot be marked
  // grantable, but if someone flips the column by hand this still refuses.
  const grantable = new Set(allPlans
    .filter((p) => p.operator_grantable && !PAID_ONLY_FEATURES.has(p.feature))
    .map((p) => p.feature));

  const features: Record<string, boolean> = {};
  for (const p of plans) {
    features[p.feature] = internal
      // Our own account: everything, unconditionally, ahead of every other rule.
      ? true
      : PAID_ONLY_FEATURES.has(p.feature)
      // Pay-only: a real subscription is the ONLY way in, for everyone.
      ? Boolean(featureState.get(p.feature)?.usable)
      : grantable.has(p.feature)
        // GRANTABLE: the grant, or a real subscription — and deliberately NOT the
        // exempt/inTransition blankets. That omission is the whole design. Every tenant
        // predating the billing gate is `exempt`, so leaving the blanket here would hand
        // 3D to all of them the moment this shipped, which is the opposite of "not all
        // clients need to see it" and would make the gate decorative.
        ? (granted.has(p.feature) || Boolean(featureState.get(p.feature)?.usable))
        : (exempt || inTransition || Boolean(featureState.get(p.feature)?.usable));
  }

  let entState = "active";
  let reason = "active";
  let graceEndsAt: string | null = null;
  if (internal) { entState = "exempt"; reason = "internal"; }
  else if (exempt) { entState = "exempt"; reason = "exempt"; }
  else if (requiredFeatures.length > 0) {
    // The gate turns on the REQUIRED feature(s) — today that's Simple Layout, which is
    // the product itself; without it there is nothing to let them into.
    const states = requiredFeatures.map((f) => featureState.get(f));
    // cancelled_paid classifies as ACTIVE, not as a warning state: they paid for this
    // period and nothing is wrong — the only difference is that no renewal will happen,
    // which the Billing tab's cancelled row already shows.
    if (states.some((s) => s?.state === "active" || s?.state === "cancelled_paid")) { entState = "active"; reason = "active"; }
    else if (states.some((s) => s?.state === "grace")) {
      entState = "grace"; reason = "past_due";
      const ends = Math.max(...states.map((s) => s?.graceEnds ?? 0));
      graceEndsAt = new Date(ends).toISOString();
    } else {
      entState = "locked";
      const seen = requiredFeatures.flatMap((f) =>
        subs.filter((s) => planById.get(s.plan_id)?.feature === f).map((s) => String(s.status)));
      reason = seen.includes("past_due") ? "past_due"
        : seen.includes("paused") ? "paused"
        : seen.includes("cancelled") ? "cancelled"
        : "never_paid";
    }
  }
  // A dated free period rescues an otherwise-locked account, and ONLY that case: an active
  // or in-grace subscription already speaks for itself, and a permanent exemption was
  // handled above. Ordering it here is what makes subscribing during the window end the
  // countdown instead of nagging a customer who has already paid.
  let transitionEndsAt: string | null = null;
  if (entState === "locked" && inTransition) {
    entState = "transition";
    reason = "transition";
    transitionEndsAt = new Date(exemptUntilMs).toISOString();
  }

  // The required feature's price AS THIS TENANT WOULD PAY IT, so a transition banner can
  // state the actual rate instead of sending them off to find it.
  const requiredRate = (() => {
    const rp = plans.filter((p) => p.required);
    const mo = rp.find((p) => p.billing_interval === "monthly");
    const yr = rp.find((p) => p.billing_interval === "annual");
    const anchor = mo ?? yr;
    return {
      monthlyCents: mo ? chargeCentsFor(mo) : null,
      annualCents: yr ? chargeCentsFor(yr) : null,
      listMonthlyCents: mo?.price_cents ?? null,
      listAnnualCents: yr?.price_cents ?? null,
      discountPercent: anchor ? discountForFeature(anchor.feature) : 0,
    };
  })();

  const entitlement = {
    exempt,
    state: entState,                 // exempt | active | grace | transition | locked
    locked: entState === "locked",
    reason,                          // exempt|active|never_paid|past_due|paused|cancelled|transition
    graceEndsAt,
    graceDays: GRACE_DAYS,
    transitionEndsAt,                // dated free period; null unless state === "transition"
    requiredRate,                    // what the required feature costs THIS tenant
    features,
    // Which of the enabled features are ON BY GRANT rather than by purchase, so the UI can
    // say "switched on for you by Structure Studio" instead of implying they bought it.
    // Filtered through `grantable` so a stale row for a feature that has since been made
    // non-grantable never shows up as an entitlement the tenant supposedly holds.
    granted: [...granted].filter((f) => grantable.has(f)),
  };

  if (action === "status") {
    // gateway_plan_id stays server-side; everything else drives the UI.
    // charge_cents is what this tenant would actually be billed — equal to price_cents
    // for everyone without a discount. The UI shows the pair so a discounted customer
    // can see the list price struck through and what they save.
    // `active` is stripped alongside gateway_plan_id: this list is already filtered to active
    // rows, so the flag would only be noise the browser could come to depend on.
    //
    // ⚠️ `price_visible = false` now REDACTS the amount rather than merely asking the UI not
    // to print it (2026-08-07). Migration 055 made hiding presentation-only and recorded the
    // consequence — "the figure is still visible to anyone who opens devtools" — as accepted.
    // It was worse than that: `billing_plans` also carried `grant select to authenticated`
    // with a `using (true)` policy, so any builder could read every unpublished price straight
    // off the table. That grant is revoked (migration 102) and the number is dropped here, so
    // the two paths agree. The point of the flag is that we are still costing these features
    // and may have to raise the number — a builder who saw the old one is anchored to it.
    //
    // Redaction is safe precisely because a not-yet-published plan cannot be bought: the
    // `subscribe` path re-reads price_cents server-side from `plans` (never from the body),
    // so nothing in the billing flow depends on the browser having seen it.
    const publicPlans = plans.map(({ gateway_plan_id: _g, active: _a, ...p }) => {
      const hidden = p.price_visible === false;
      return {
        ...p,
        price_cents: hidden ? null : p.price_cents,
        charge_cents: hidden ? null : chargeCentsFor(p),
        discount_percent: discountForFeature(p.feature),
      };
    });
    // BILLING FIELD FILTER. Everyone gets `entitlement` — it is what unlocks the rest of
    // the portal, and withholding it would lock the product instead of the tab. Nobody but
    // an owner gets the commercial detail: what this business pays, what discount it has,
    // whether a card is on file, or the checkout keys to put a new one there.
    const mine = canRead("settings_billing");

    // WALLET. Behind the same field filter as the rest of the commercial detail: a
    // balance is what this business has paid for, so it belongs with `discount` and
    // `hasCard`, not with `entitlement`.
    //
    // Labels are authored HERE, server-side, so the browser never maps a `kind` enum to
    // English and drifts from it. `cost_cents` and `usage` are never selected — that
    // column is our gross margin on a $20 charge and is the single worst thing in this
    // schema for a tenant to read.
    let wallet: Record<string, unknown> | null = null;
    if (mine) {
      try {
        const [acct, price, txs] = await Promise.all([
          admin.from("wallet_accounts").select("balance_cents, held_cents, metered_exempt, auto_topup_enabled, auto_topup_threshold_cents, auto_topup_amount_cents, auto_topup_last_at, auto_topup_disabled_reason").eq("client_id", clientId).maybeSingle(),
          admin.from("usage_prices").select("kind, label, unit_label, price_cents, active, visible").eq("active", true).order("sort_order"),
          admin.from("wallet_transactions").select("id, kind, amount_cents, meter_kind, state, memo, created_at")
            .eq("client_id", clientId).in("state", ["posted", "held"]).order("created_at", { ascending: false }).limit(10),
        ]);
        const meters = (price.data ?? []).map((p: any) => ({
          kind: p.kind, label: p.label, unitLabel: p.unit_label,
          priceCents: p.visible === false ? null : Number(p.price_cents),
        }));
        const label = (t: any) => {
          if (t.kind === "topup") return "Added funds";
          if (t.kind === "grant") return "Credit from CSM Synergy";
          if (t.kind === "adjustment") return t.memo ? `Adjustment — ${t.memo}` : "Adjustment";
          if (t.kind === "refund") return "Refund";
          if (t.meter_kind === "video_3d_generation") return "3D generation from a video";
          return "Usage";
        };
        wallet = {
          balanceCents: Number(acct.data?.balance_cents ?? 0),
          heldCents: Number(acct.data?.held_cents ?? 0),
          exempt: Boolean(acct.data?.metered_exempt),
          // The bounds are SENT rather than hardcoded in the browser, so the floor and cap
          // live in exactly one place (_shared/walletTopup.ts) and a change to them cannot
          // leave a stale limit in the UI silently disagreeing with the server.
          minTopupCents: MIN_TOPUP_CENTS,
          maxTopupCents: MAX_TOPUP_CENTS,
          autoTopup: {
            enabled: Boolean(acct.data?.auto_topup_enabled),
            thresholdCents: acct.data?.auto_topup_threshold_cents ?? null,
            amountCents: acct.data?.auto_topup_amount_cents ?? null,
            lastAt: acct.data?.auto_topup_last_at ?? null,
            // Why it switched itself off, if it did. This is the ONLY surface that tells a
            // builder their card was declined on an unattended charge — there is no email.
            disabledReason: acct.data?.auto_topup_disabled_reason ?? null,
          },
          meters,
          transactions: (txs.data ?? []).map((t: any) => ({
            id: t.id, label: label(t), amountCents: Number(t.amount_cents),
            pending: t.state === "held", at: t.created_at,
          })),
        };
      } catch (_) {
        // A wallet read must never take the Billing tab down with it — `status` is the
        // action that decides whether the whole portal is locked.
        wallet = null;
      }
    }

    // UPGRADE CREDITS, one entry per purchasable bundle, so the cart can show the real
    // number BEFORE checkout. This is not advisory: for a tenant with no card on file the
    // browser mints its Collect.js payment token against the amount it computed, so a
    // browser that did not know about the credit would tokenize the wrong figure and the
    // confirmChargeCents handshake would (correctly) refuse the whole checkout.
    //
    // Keyed by feature, empty object when nothing is creditable, and behind `mine` with the
    // rest of the commercial detail.
    const upgradeCredits: Record<string, { cents: number; sources: { planId: string; name: string; cents: number }[] }> = {};
    if (mine) {
      for (const f of new Set(plans.map((p) => p.feature))) {
        if (!BUNDLE_FEATURES[f]) continue;
        const c = creditForBundle(f);
        if (c.cents > 0) upgradeCredits[f] = c;
      }
    }

    return json({
      configured,
      entitlement,
      ...(mine
        ? {
          wallet,
          upgradeCredits,
          hasCard: Boolean(vaultId),
          discount: { percent: discountPct, features: discountFeatures },
          plans: publicPlans,
          subscriptions: subs,
          checkout: configured
            ? { tokenizationKey: TOKENIZATION_KEY, collectJsUrl: `${GATEWAY}/token/Collect.js` }
            : null,
        }
        : { plans: [], subscriptions: [], checkout: null }),
    });
  }

  if (!configured) {
    return json({ error: "Billing is not configured yet. Contact CSM Synergy." }, 503);
  }

  if (action === "subscribe") {
    const planIds: string[] = Array.isArray(payload?.planIds)
      ? payload.planIds.map((x: unknown) => String(x).trim()).filter(Boolean)
      : [];
    const paymentToken = String(payload?.paymentToken || "").trim();
    if (planIds.length === 0) return json({ error: "Select at least one feature." }, 400);

    // ── Operator refusals ────────────────────────────────────────────────────────
    // A paymentToken is a Collect.js token minted in the CARDHOLDER'S browser. In
    // operator mode that browser belongs to CSM Synergy staff, so an operator-supplied
    // token means someone here typed a customer's card number. Refuse it outright, and
    // require a card the tenant vaulted themselves. This still allows the genuinely
    // useful case — an already-vaulted tenant asking us to add a feature on a call.
    if (operator) {
      if (paymentToken) {
        return json({ error: "An operator cannot enter a card on a tenant's behalf. Ask the owner to add their card first." }, 400);
      }
      if (!vaultId) {
        return json({ error: "This tenant has no card on file. The owner must add one themselves before an operator can change their subscription." }, 409);
      }
    }

    // Purchase resolves against the PURCHASABLE set, not the interpretive planById — that map
    // deliberately contains retired rows so old subscriptions still mean something, and reading a
    // plan id out of it here would let a caller buy a price point that was deliberately withdrawn.
    const purchasableById = new Map(plans.map((p) => [p.id, p]));
    const chosen = planIds.map((id) => purchasableById.get(id));
    if (chosen.some((p) => !p)) return json({ error: "Unknown plan in selection." }, 400);
    if (chosen.some((p) => p!.availability !== "available")) {
      return json({ error: "One of the selected features isn't available yet." }, 400);
    }
    const features = chosen.map((p) => p!.feature);
    if (new Set(features).size !== features.length) {
      return json({ error: "Pick either monthly or annual for each feature, not both." }, 400);
    }
    for (const f of features) {
      if (liveFeatures.has(f)) return json({ error: `You already have an active subscription for ${f}.` }, 409);
    }
    // A bundle covers its members — don't let it stack on the pieces it already includes when
    // both are in this same cart; that is a mistake, not an upgrade.
    //
    // Already SUBSCRIBED members are different, and since 2026-08-29 they are the upgrade
    // path rather than a refusal. This block used to end with a 409 ("Switching to the Suite
    // isn't automated yet — contact CSM Synergy"); it now resolves to `upgrade`, the bundle
    // whose members are being superseded, and the checkout below credits their unused time.
    // Only ONE bundle can be upgraded to per checkout — two bundles in one cart is already
    // impossible (each is its own feature and features are deduped above), but the credit is
    // computed against a single target and this makes that explicit rather than incidental.
    let upgrade: { plan: typeof chosen[number]; credit: ReturnType<typeof creditForBundle>; supersedes: typeof subs } | null = null;
    for (const p of chosen) {
      const members = BUNDLE_FEATURES[p!.feature];
      if (!members) continue;
      if (features.some((f) => f !== p!.feature && members.includes(f)))
        return json({ error: `The ${p!.name} already includes those features — remove them from your selection.` }, 400);
      if (members.some((m) => liveFeatures.has(m))) {
        // The subscriptions this upgrade replaces: usable, and for a feature the bundle
        // covers. Cancelled-but-still-prepaid rows are included deliberately — they are
        // exactly the case where money was paid for time not yet used.
        const superseded = subs.filter((sb2) => {
          const pl = planById.get(sb2.plan_id);
          return pl && members.includes(pl.feature) && featureState.get(pl.feature)?.usable;
        });
        upgrade = { plan: p, credit: creditForBundle(p!.feature), supersedes: superseded };
      }
    }
    // Required base (Simple Layout) must be covered — directly, via a bundle in the cart, or already live.
    const cartCovers = new Set(chosen.flatMap((p) => expandFeature(p!.feature)));
    if (!cartCovers.has("simple_layout") && !liveFeatures.has("simple_layout")) {
      return json({ error: "Simple Layout is the required base plan — add it (or the Suite) to your selection." }, 400);
    }

    // Card: reuse the vault, or create it from a fresh Collect.js token.
    let vault = vaultId;
    if (!vault) {
      if (!paymentToken) return json({ error: "paymentToken is required (no card on file)." }, 400);
      let cust: Record<string, string>;
      try {
        cust = await nmiPost({
          customer_vault: "add_customer",
          payment_token: paymentToken,
          first_name: String(payload?.firstName || ""),
          last_name: String(payload?.lastName || ""),
          email: String(payload?.email || userEmail || ""),
          merchant_defined_field_1: clientId,
        });
      } catch (e) {
        return json({ error: `Payment gateway error: ${(e as Error).message}` }, 402);
      }
      vault = cust.customer_vault_id;
      if (!vault) return json({ error: "Gateway did not return a customer vault id." }, 502);
      const { error: vErr } = await admin.from("billing_customers")
        .upsert({ client_id: clientId, vault_id: vault, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
      if (vErr) return json({ error: vErr.message }, 500);
    }

    // ── What the card is charged TODAY ──────────────────────────────────────────────
    // Registering a recurring subscription never charges anything. NMI starts the clock at
    // the subscribe date and takes the first plan_amount at the END of the first cycle —
    // proven live 2026-07-29 on subscription 12358527270 (Query API): created 2026-07-28
    // with a $0 setup fee, its first charge was scheduled for 2027-07-28. As originally
    // written, checkout gave every subscriber their first period FREE — a year, for an
    // annual plan — while the UI presented it as paying now.
    //
    // So checkout now charges first period + setup as an immediate SALE, and registers the
    // subscription so its first gateway charge is the RENEWAL.
    const grossDueToday = chosen.reduce((s, p) => s + chargeCentsFor(p!) + (p!.setup_fee_cents || 0), 0);
    // UPGRADE CREDIT comes off TODAY'S charge only. It must not touch the recurring
    // plan_amount registered below: that amount is stored on the NMI subscription and used
    // for every rebill, so discounting it would make a one-time credit permanent and hand
    // the builder a Suite at $7,657/yr forever.
    //
    // Capped at the gross: the excess does not vanish, it becomes free time (creditLeftover
    // below pushes the first renewal out). Carolyn 2026-08-29, asked what happens when the
    // credit is worth more than the charge: "Extend the renewal date."
    const creditCents = Math.min(upgrade?.credit.cents ?? 0, grossDueToday);
    const creditLeftover = (upgrade?.credit.cents ?? 0) - creditCents;
    const dueTodayTotal = grossDueToday - creditCents;

    // Last gate before any money moves. EVERY caller — tenant or operator — must name the
    // exact amount that will hit the card today; a mismatch means the browser showed one
    // number and the server would charge another (stale prices, a discount changed mid-
    // session), and the caller must re-confirm against the fresh amount returned here.
    if (Number(payload?.confirmChargeCents) !== dueTodayTotal) {
      return json({
        error: `Your total due today is $${(dueTodayTotal / 100).toFixed(2)} (first period plus any setup fees${creditCents > 0 ? `, less $${(creditCents / 100).toFixed(2)} credit for time you have already paid for` : ""}). Confirm the amount and try again.`,
        dueTodayCents: dueTodayTotal,
      }, 400);
    }
    // Operators additionally leave a DURABLE audit row before the first nmiPost.
    // auditStrict throws, and we refuse on failure: if we cannot record who charged a
    // client's card, we do not charge it.
    if (operator) {
      try {
        await auditStrict("operator_billing_subscribe_attempt", chosen.length, `plans=${planIds.join(",")} due_today_cents=${dueTodayTotal}`);
      } catch (e) {
        return json({ error: (e as Error).message }, 503);
      }
    }

    // ONE clock for the whole checkout: billingDay and the renewal arithmetic must never
    // observe different dates (a midnight straddle between two `new Date()` calls would
    // compute a renewal a month off).
    const checkoutNow = new Date();
    // Bill on today's day-of-month, capped at 28 so a subscription started on the 29th-31st
    // has the same anniversary in February as in every other month rather than drifting.
    const billingDay = Math.min(checkoutNow.getUTCDate(), 28);
    // First renewal: one interval from today on billingDay (≤28, so month arithmetic can
    // never roll over). This exact date is TRANSMITTED as start_date on every registration —
    // since 2026-08-24 all subscriptions use the custom-amount form (see below), so the
    // gateway's schedule and the DB mirror are the same arithmetic by construction.
    const renewalOf = (interval: string): Date =>
      new Date(Date.UTC(checkoutNow.getUTCFullYear(), checkoutNow.getUTCMonth() + (interval === "annual" ? 12 : 1), billingDay));
    // LEFTOVER CREDIT BUYS TIME. When the unused prepaid value exceeds today's whole charge,
    // the remainder cannot be taken off a charge that is already zero, so it moves the first
    // renewal instead: leftover / daily-rate days of Suite, free.
    //
    // ⚠️ The pushed date's day-of-month must also be TRANSMITTED as day_of_month. start_date
    // and day_of_month are two statements about the same schedule and NMI is given both; a
    // pushed start_date with the original billing day tells the gateway to start on one date
    // and bill on another day of the month. Capped at 28 for the same reason billingDay is.
    const extendedRenewalOf = (interval: string, planCents: number): { at: Date; days: number } => {
      const base = renewalOf(interval);
      const perDay = planCents / (interval === "annual" ? 365 : 30);
      const days = perDay > 0 ? Math.floor(creditLeftover / perDay) : 0;
      if (days <= 0) return { at: base, days: 0 };
      const at = new Date(base.getTime() + days * 86400000);
      return { at, days };
    };
    const yyyymmdd = (d: Date) =>
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

    // One recurring subscription per feature, sequentially; report partial failures.
    //
    // ONE gateway form since 2026-08-24: the custom-amount form (plan_amount). The charged
    // amount is transmitted from billing_plans.price_cents (via chargeCentsFor) on every
    // subscribe, and per NMI it is stored ON the subscription — every rebill uses it, no
    // further API calls, immune to any later plan or price edit. That is the Founding-price
    // guarantee: repricing billing_plans only affects NEW subscribers; existing ones keep
    // the amount snapshotted at the gateway (mirrored in billing_subscriptions.price_cents).
    // It also makes the DB the single source of truth — under the old plan_id form the
    // amount lived in a Deposyt plan record, could silently disagree with price_cents, and
    // every reprice needed a matching hand-edit in the Deposyt dashboard.
    //
    // History: two forms coexisted until 2026-08-24 (plan_id for full price, plan_amount for
    // discounts) because NMI's classic Subscription Management reference does not document
    // customer_vault_id for the custom-amount form. A live 25%-off subscription registered
    // off the vault on 2026-07-28 and its webhook returned correctly, proving the
    // combination, so the paths were collapsed as the original comment here prescribed.
    // The Deposyt plan records were then deleted — EXCEPT SS_SIMPLE_LAYOUT_MONTHLY/_YEARLY:
    // the two pre-existing simple_layout_annual subscriptions still renew from the yearly
    // record. Never delete those two records, and never re-register existing subscriptions.
    // gateway_plan_id survives in billing_plans only as the plan_name label sent below.
    const created: any[] = [];
    const failed: { planId: string; error: string }[] = [];
    // Required base first: if Simple Layout cannot be started, charging for add-ons would
    // take money for features behind a portal that is about to be locked.
    const orderedChosen = [...chosen].sort((a, b) => Number(b!.required) - Number(a!.required));
    let baseFailed = false;
    for (const p of orderedChosen) {
      const chargeCents = chargeCentsFor(p!);
      const pct = discountForFeature(p!.feature);
      const discounted = chargeCents !== p!.price_cents;
      // THE UPGRADE PLAN ONLY: today's charge is reduced by the credit, and if the credit
      // swallowed it whole the renewal moves out instead. Every other plan in the cart is
      // untouched — a credit belongs to the bundle that superseded the old subscriptions,
      // not to whatever else happens to be in the same checkout.
      const isUpgrade = upgrade !== null && p!.id === upgrade.plan!.id;
      const grossFirst = chargeCents + (p!.setup_fee_cents || 0);
      const firstCents = isUpgrade ? grossFirst - creditCents : grossFirst;
      const ext = isUpgrade ? extendedRenewalOf(p!.billing_interval, chargeCents) : { at: renewalOf(p!.billing_interval), days: 0 };
      const renewal = ext.at;

      if (baseFailed && !p!.required && !liveFeatures.has(requiredFeatures[0] ?? "")) {
        failed.push({ planId: p!.id, error: "Skipped - the required base plan could not be started, and this feature would be unusable without it." });
        continue;
      }
      // A 100% discount reaches the gateway as plan_amount "0.00", which either errors or
      // registers a pointless $0 recurring. Fully-free accounts have a real mechanism.
      //
      // ⚠️ An UPGRADE whose credit covers the whole charge lands on zero too, and it is not
      // this error — it is the correct, intended outcome of having already paid for the time.
      // That case skips the sale entirely (see the `firstCents > 0` guard below) and is not
      // a misconfiguration, so it must not be caught here. Guarding on !isUpgrade rather than
      // on the amount keeps a genuinely mispriced upgrade from slipping through silently:
      // a non-upgrade plan at zero is still refused exactly as before.
      if (firstCents === 0 && !isUpgrade) {
        failed.push({ planId: p!.id, error: "This account's discount makes this feature free - use the Non-billable setting instead of a 100% discount." });
        if (p!.required) baseFailed = true;
        continue;
      }

      // ── Attempt ledger: the charge exists in OUR records before it exists anywhere ──
      // A prior attempt whose outcome could not be verified blocks this plan entirely:
      // retrying an unverified charge is how a customer gets billed twice.
      const { data: unknownPrior } = await admin.from("billing_charge_attempts")
        .select("id").eq("client_id", clientId).eq("plan_id", p!.id).eq("state", "closed_unknown").limit(1);
      if (unknownPrior && unknownPrior.length) {
        failed.push({ planId: p!.id, error: "A previous payment attempt for this feature could not be verified. To avoid a double charge, contact CSM Synergy before trying again." });
        if (p!.required) baseFailed = true;
        continue;
      }
      // An 'open' attempt older than 10 minutes means a checkout DIED mid-flight — the one
      // failure the catch below can never see. That outcome is exactly as unknown as a lost
      // gateway response, so it is promoted to closed_unknown (blocking, support resolves)
      // rather than left blocking forever behind a misleading "in progress" message.
      const { data: staleOpen } = await admin.from("billing_charge_attempts")
        .select("id, created_at").eq("client_id", clientId).eq("plan_id", p!.id).eq("state", "open").limit(1);
      if (staleOpen && staleOpen.length) {
        const ageMs = Date.now() - Date.parse(staleOpen[0].created_at);
        if (ageMs > 10 * 60 * 1000) {
          await admin.from("billing_charge_attempts")
            .update({ state: "closed_unknown", detail: "stale open attempt - checkout crashed mid-flight; verify at the gateway", closed_at: new Date().toISOString() })
            .eq("id", staleOpen[0].id).eq("state", "open");
          failed.push({ planId: p!.id, error: "A previous payment attempt did not finish and could not be verified. To avoid a double charge, contact CSM Synergy before trying again." });
        } else {
          failed.push({ planId: p!.id, error: "Another checkout for this feature is already in progress. Give it a moment, then refresh." });
        }
        if (p!.required) baseFailed = true;
        continue;
      }
      // Inserting the 'open' row is also the concurrency guard: a simultaneous second
      // request hits the partial unique index and stops here, before any charge.
      const { data: attempt, error: attErr } = await admin.from("billing_charge_attempts")
        .insert({ client_id: clientId, plan_id: p!.id, orderid: `ss_first_${clientId}_${p!.id}` })
        .select("id").maybeSingle();
      if (attErr || !attempt) {
        failed.push({ planId: p!.id, error: "Another checkout for this feature is already in progress. Give it a moment, then refresh." });
        if (p!.required) baseFailed = true;
        continue;
      }
      const closeAttempt = (state: string, detail: string | null, txn: string | null) =>
        admin.from("billing_charge_attempts")
          .update({ state, detail, sale_txn: txn, closed_at: new Date().toISOString() })
          .eq("id", attempt.id).then(() => undefined, () => undefined);

      // Per-FEATURE sale + registration, so a failure can be unwound feature-by-feature:
      // money and access must never disagree. saleTxn / regSubId track how far this
      // feature got, and the catch reverses exactly that much.
      let saleTxn: string | null = null;
      let regSubId: string | null = null;
      try {
        // 1. Charge the first period (plus this feature's setup fee) NOW.
        //    UNLESS a credit already covers it: firstCents === 0 here can only be a fully
        //    credited upgrade (the misconfiguration case was refused above), and sending a
        //    $0.00 sale to NMI either errors or books a meaningless zero transaction. The
        //    honest record of "they already paid for this time" is the absence of a charge
        //    plus the billing_upgrade_credits row, not a $0 receipt.
        if (firstCents > 0) {
        try {
          const sale = await nmiPost({
            type: "sale",
            amount: (firstCents / 100).toFixed(2),
            customer_vault_id: vault,
            orderid: `ss_first_${clientId}_${p!.id}`,
            order_description: `StructureStudio ${p!.name} (${p!.billing_interval}) - first ${p!.billing_interval === "annual" ? "year" : "month"}${(p!.setup_fee_cents || 0) > 0 ? " + setup" : ""}${discounted ? `, ${pct}% off` : ""}`,
          });
          saleTxn = sale.transactionid || null;
        } catch (se) {
          if (isGatewayUnknown(se)) {
            // The card MAY have been charged and we cannot know. Do not guess, do not
            // retry, do not tell the customer nothing happened. The closed_unknown row
            // blocks every further attempt for this plan until support reconciles.
            await closeAttempt("closed_unknown", `sale outcome unverifiable: ${(se as Error).message}`, null);
            failed.push({ planId: p!.id, error: "We could not confirm whether your card was charged. Do NOT try again - contact CSM Synergy and we will confirm and finish the setup." });
            if (p!.required) baseFailed = true;
            continue;
          }
          await closeAttempt("closed_declined", (se as Error).message, null);
          failed.push({ planId: p!.id, error: (se as Error).message });
          if (p!.required) baseFailed = true;
          continue;
        }
        }
        // 2. Register the recurring so its first gateway charge is the RENEWAL.
        //    day_of_month alone is ambiguous about the first charge (subscribe ON the
        //    billing day could mean today), so start_date pins it to the renewal
        //    explicitly — a documented parameter on this form.
        const r = await nmiPost({
          recurring: "add_subscription",
          plan_amount: (chargeCents / 100).toFixed(2),
          plan_payments: "0",                                          // 0 = until cancelled
          month_frequency: p!.billing_interval === "annual" ? "12" : "1",
          // Taken from `renewal`, not from billingDay: an upgrade whose leftover credit
          // pushed the renewal out lands on a different day of the month, and the two
          // parameters describe one schedule. They agree by construction for every other
          // checkout, where renewal IS billingDay.
          day_of_month: String(Math.min(renewal.getUTCDate(), 28)),
          start_date: yyyymmdd(renewal),
          // Undocumented for the classic custom-amount form (NMI documents plan_name
          // for v5 only) but VERIFIED HONOURED: a live webhook payload came back with
          // plan.name = "SS_SIMPLE_LAYOUT_MONTHLY_25OFF" (2026-07-28). Deposyt's
          // Recurring Customer List still shows a bare number for these because that
          // column renders plan.id, which is "" for a custom subscription — the name is
          // stored, just not shown there. Don't remove this on the strength of that
          // screen; check the payload.
          plan_name: discounted ? `${p!.gateway_plan_id}_${pct}OFF` : p!.gateway_plan_id,
          customer_vault_id: vault,
          merchant_defined_field_1: clientId,
          orderid: `ss_${clientId}_${p!.id}`,
          order_description: discounted
            ? `StructureStudio ${p!.name} (${p!.billing_interval}) - ${pct}% off, $${(chargeCents / 100).toFixed(2)}`
            : `StructureStudio ${p!.name} (${p!.billing_interval})`,
        });
        const subId = r.subscription_id || r.transactionid;
        regSubId = subId || null;
        const { data: row, error: insErr } = await admin
          .from("billing_subscriptions")
          .upsert({
            id: subId,
            client_id: clientId,
            plan_id: p!.id,
            price_cents: chargeCents,          // what the gateway bills at each renewal
            list_price_cents: p!.price_cents,  // what it would have been without the discount
            status: "active",
            current_period_start: new Date().toISOString(),
            current_period_end: renewal.toISOString(),   // period 1 is PAID (the sale above)
          }, { onConflict: "id" })
          .select("id, plan_id, status, price_cents, list_price_cents, current_period_start, current_period_end, canceled_at, created_at")
          .maybeSingle();
        if (insErr) throw new Error(insErr.message);
        await closeAttempt("closed_ok", null, saleTxn);
        created.push(row);

        // ── The upgrade completes HERE, and only here ────────────────────────────────
        // Superseding subscriptions are cancelled only once the bundle that replaces them
        // is registered and recorded. The reverse order is the one bug this must never
        // have: cancel first and a failed registration leaves a paying builder with
        // nothing — no Suite, no features, and money already spent. Everything above can
        // still fail and unwind; from this point the new subscription genuinely exists.
        //
        // Failures here are logged, never thrown. A cancel that does not go through means
        // the builder is briefly subscribed to both, which costs THEM nothing today (the
        // old plan is already paid through) and is fixed by hand from the app_errors row.
        // Throwing instead would unwind a Suite that is working.
        if (isUpgrade && upgrade) {
          const cancelFailures: string[] = [];
          for (const old of upgrade.supersedes) {
            try {
              await nmiPost({ recurring: "delete_subscription", subscription_id: old.id });
              await admin.from("billing_subscriptions")
                .update({ status: "cancelled", canceled_at: new Date().toISOString() })
                .eq("id", old.id).eq("client_id", clientId);
            } catch (ce) {
              cancelFailures.push(`${old.plan_id} (${old.id}): ${(ce as Error).message}`);
            }
          }
          // The receipt. Written even when a cancel failed — it explains the charge, and
          // the charge happened either way.
          await admin.from("billing_upgrade_credits").insert({
            client_id: clientId,
            to_plan_id: p!.id,
            to_sub_id: subId,
            credit_cents: creditCents,
            charged_cents: firstCents,
            extended_days: ext.days,
            source_plans: upgrade.credit.sources,
          }).then(() => undefined, () => undefined);
          if (cancelFailures.length) {
            await admin.from("app_errors").insert({
              source: "edge:portal-billing", severity: "error", code: "upgrade_cancel_failed",
              message: `${clientId} upgraded to ${p!.id} but these superseded subscriptions are STILL LIVE at the gateway and will keep billing: ${cancelFailures.join(" | ")}`,
              client_id: clientId,
            }).then(() => undefined, () => undefined);
          }
        }
      } catch (e) {
        // Unwind exactly as far as this feature got. Order matters: stop FUTURE charges
        // first (delete the registration), then return TODAY's money.
        //
        // A registration failure that is GATEWAY_UNKNOWN is itself an unresolved state —
        // an orphan recurring may exist that would bill at every renewal — so it lands in
        // the same closed_unknown bucket as unverified money.
        const unwindErrors: string[] = [];
        if (isGatewayUnknown(e)) unwindErrors.push(`registration outcome unverifiable: ${(e as Error).message}`);
        if (regSubId) {
          try { await nmiPost({ recurring: "delete_subscription", subscription_id: regSubId }); }
          catch (de) { unwindErrors.push(`delete_subscription ${regSubId}: ${(de as Error).message}`); }
        }
        if (saleTxn) {
          // Void first (free, works pre-settlement); if the batch has already settled the
          // void fails, so fall back to a refund of the exact amount.
          try { await nmiPost({ type: "void", transactionid: saleTxn }); }
          catch (_ve) {
            try { await nmiPost({ type: "refund", transactionid: saleTxn, amount: (firstCents / 100).toFixed(2) }); }
            catch (re) { unwindErrors.push(`void AND refund of ${saleTxn} failed: ${(re as Error).message}`); }
          }
        }
        if (unwindErrors.length) {
          // Money moved (or a registration stands) and could not be reversed automatically.
          // Never silent: durable app_errors row, the attempt stays closed_unknown (which
          // BLOCKS retries for this plan), and the caller gets the reference.
          await closeAttempt("closed_unknown", `${(e as Error).message} | unwind: ${unwindErrors.join(" | ")}`, saleTxn);
          await admin.from("app_errors").insert({
            source: "edge:portal-billing", severity: "error", code: "charge_unwind_failed",
            message: `subscribe ${p!.id} for ${clientId} failed (${(e as Error).message}) and the unwind also failed: ${unwindErrors.join(" | ")}`,
            client_id: clientId,
          }).then(() => undefined, () => undefined);
          failed.push({ planId: p!.id, error: `The charge may not have been fully reversed (ref ${saleTxn ?? regSubId ?? "n/a"}). CSM Synergy has been notified and will make it right.` });
        } else {
          await closeAttempt("closed_declined", (e as Error).message, saleTxn);
          failed.push({ planId: p!.id, error: saleTxn ? `${(e as Error).message} - the charge was reversed.` : (e as Error).message });
        }
        if (p!.required) baseFailed = true;
      }
    }
    if (created.length === 0) {
      return json({ error: `Subscription failed: ${failed.map((f) => f.error).join("; ")}` }, 402);
    }
    // Closes the attempt row above. Best-effort — the charge already happened, so failing
    // the response now would only mislead the operator about what occurred.
    if (operator) audit("operator_billing_subscribe_result", created.length, `created=${created.map((c: any) => c?.plan_id).join(",")} failed=${failed.length}`);
    return json({ ok: true, created, failed });
  }

  // ── WALLET TOP-UP (migration 164) ───────────────────────────────────────────────────
  // Funding the prepaid usage wallet. Sits after the `configured` 503 above, so an
  // unconfigured deployment refuses this for free, exactly like subscribe.
  //
  // Differs from subscribe in one way worth stating: the AMOUNT IS THE CUSTOMER'S CHOICE,
  // not a price we look up. So confirmChargeCents cannot re-derive anything — it degenerates
  // to an echo. It is still required, because it keeps three numbers provably identical: the
  // figure on screen, the figure Collect.js minted its token against, and the figure charged.
  if (action === "topup") {
    const amountCents = Number(payload?.amountCents);
    if (!Number.isInteger(amountCents) || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_TOPUP_CENTS) {
      return json({
        error: `Choose an amount between $${(MIN_TOPUP_CENTS / 100).toFixed(0)} and $${(MAX_TOPUP_CENTS / 100).toLocaleString("en-US")}.`,
      }, 400);
    }
    if (Number(payload?.confirmChargeCents) !== amountCents) {
      return json({ error: "Confirm the amount and try again.", dueTodayCents: amountCents }, 400);
    }

    const paymentToken = String(payload?.paymentToken || "").trim();
    // Operator refusals, identical to subscribe's and for the identical reason: a Collect.js
    // token is minted in the CARDHOLDER's browser, so an operator-supplied one means someone
    // at CSM Synergy typed a customer's card number.
    if (operator) {
      if (paymentToken) {
        return json({ error: "An operator cannot enter a card on a tenant's behalf. Ask the owner to add their card first." }, 400);
      }
      if (!vaultId) {
        return json({ error: "This tenant has no card on file. The owner must add one themselves before an operator can top up their wallet." }, 409);
      }
    }

    // Card: reuse the vault, or create one from a fresh Collect.js token.
    let vault = vaultId;
    if (!vault) {
      if (!paymentToken) return json({ error: "paymentToken is required (no card on file)." }, 400);
      let cust: Record<string, string>;
      try {
        cust = await nmiPost({
          customer_vault: "add_customer",
          payment_token: paymentToken,
          first_name: String(payload?.firstName || ""),
          last_name: String(payload?.lastName || ""),
          email: String(payload?.email || userEmail || ""),
          merchant_defined_field_1: clientId,
        });
      } catch (e) {
        return json({ error: `Payment gateway error: ${(e as Error).message}` }, 402);
      }
      vault = cust.customer_vault_id;
      if (!vault) return json({ error: "Gateway did not return a customer vault id." }, 502);
      const { error: vErr } = await admin.from("billing_customers")
        .upsert({ client_id: clientId, vault_id: vault, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
      if (vErr) return json({ error: vErr.message }, 500);
    }

    // Durable audit BEFORE the first gateway call, and refuse if it cannot be written: if we
    // cannot record who charged a client's card, we do not charge it.
    if (operator) {
      try { await auditStrict("operator_wallet_topup_attempt", amountCents, `vault=${vault}`); }
      catch (e) { return json({ error: (e as Error).message }, 503); }
    }

    const r = await chargeTopup(admin, { clientId, vaultId: vault, amountCents, actorUserId: userId, auto: false });
    if (operator) audit("operator_wallet_topup_result", amountCents, r.ok ? "ok" : `failed: ${r.error}`);
    if (!r.ok) return json({ error: r.error }, r.blocking ? 409 : 402);
    return json({ ok: true, balanceCents: r.balanceCents, alreadyCredited: r.alreadyCredited });
  }

  // Configure unattended recharging. Not a charge, but it AUTHORISES charges, so it carries
  // the same gate and the same operator audit as one.
  if (action === "topup_settings") {
    const enabled = Boolean(payload?.enabled);
    const thresholdCents = payload?.thresholdCents == null ? null : Number(payload.thresholdCents);
    const amountCents = payload?.amountCents == null ? null : Number(payload.amountCents);

    if (enabled) {
      // A card must already be vaulted. Enabling auto-recharge with no card would arm
      // something that can only ever fail, and its first failure would switch it back off
      // and show a decline message for a card that never existed.
      if (!vaultId) {
        return json({ error: "Add a card first — make a one-off top-up, then switch on automatic top-ups." }, 409);
      }
      const ok = (n: number | null) => Number.isInteger(n) && (n as number) >= MIN_TOPUP_CENTS && (n as number) <= MAX_TOPUP_CENTS;
      if (!ok(thresholdCents) || !ok(amountCents)) {
        return json({
          error: `Both amounts must be between $${(MIN_TOPUP_CENTS / 100).toFixed(0)} and $${(MAX_TOPUP_CENTS / 100).toLocaleString("en-US")}.`,
        }, 400);
      }
    }
    if (operator) {
      try { await auditStrict("operator_wallet_autotopup_set", amountCents, `enabled=${enabled} threshold=${thresholdCents}`); }
      catch (e) { return json({ error: (e as Error).message }, 503); }
    }

    const { error: upErr } = await admin.from("wallet_accounts").upsert({
      client_id: clientId,
      auto_topup_enabled: enabled,
      auto_topup_threshold_cents: enabled ? thresholdCents : null,
      auto_topup_amount_cents: enabled ? amountCents : null,
      // Turning it back on clears the decline note — it is a record of why it stopped, not a
      // permanent mark, and leaving it would make a working setup look broken.
      auto_topup_disabled_reason: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "client_id" });
    if (upErr) return json({ error: upErr.message }, 500);
    return json({ ok: true });
  }

  if (action === "cancel") {
    const subscriptionId = String(payload?.subscriptionId || "").trim();
    if (!subscriptionId) return json({ error: "subscriptionId is required." }, 400);

    const owned = subs.find((s) => s.id === subscriptionId);
    if (!owned) return json({ error: "Subscription not found." }, 404);
    if (owned.status === "cancelled") return json({ error: "Already cancelled." }, 409);

    // Cancelling reduces charges rather than creating them, so there is no confirm-amount
    // step — but it still ends a client's paid feature, so it gets the same durable
    // pre-flight audit as subscribe.
    if (operator) {
      try {
        await auditStrict("operator_billing_cancel_attempt", null, `subscription=${subscriptionId} plan=${owned.plan_id ?? ""}`);
      } catch (e) {
        return json({ error: (e as Error).message }, 503);
      }
    }

    try {
      await nmiPost({ recurring: "delete_subscription", subscription_id: subscriptionId });
    } catch (e) {
      return json({ error: `Payment gateway error: ${(e as Error).message}` }, 402);
    }

    // current_period_end is deliberately NOT touched: since checkout charges each period up
    // front, the entitlement treats a cancelled row with a future current_period_end as
    // usable until that date ("cancelled_paid"). Nulling it here would confiscate the
    // prepaid remainder — the exact thing the cancel dialog promises does not happen.
    const { data: row, error: upErr } = await admin
      .from("billing_subscriptions")
      .update({ status: "cancelled", canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", subscriptionId)
      .select("id, plan_id, status, price_cents, current_period_start, current_period_end, canceled_at, created_at")
      .maybeSingle();
    if (upErr) return json({ error: upErr.message }, 500);
    if (operator) audit("operator_billing_cancel_result", null, `subscription=${subscriptionId}`);
    return json({ ok: true, subscription: row });
  }

  return json({ error: `Unknown action "${action}".` }, 400);
}));
