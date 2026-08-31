// _shared/featureCheck.ts — server-side "does this tenant have a USABLE subscription for
// feature X" for gating actions inside other edge functions.
//
// Exists because the Real-Time Pricing actions in portal-settings must refuse a direct
// POST from a tenant who never bought on_demand_pricing — featureOn() in the browser is
// presentation, not enforcement. This mirrors portal-billing's featureState rules for the
// PAY-ONLY branch exactly (a subscription is the ONLY way in — no exempt/transition
// blankets, no operator grants), because a pay-only feature is precisely the case where a
// lite check that "just looks for an active row" would diverge from the UI: past_due
// tenants inside the 7-day grace and cancelled tenants inside their prepaid period would
// see an unlocked screen whose every button 403s.
//
// Kept deliberately small: state rules only. portal-billing remains the authority for the
// full entitlement map (exempt / transition / grantable branches); if you need one of
// those semantics, extend THAT, not this.
//
// ⚠️ Duplication ledger — change these together:
//   GRACE_DAYS        also in portal-billing/index.ts (const GRACE_DAYS = 7)
//   BUNDLE_FEATURES   also in portal-billing/index.ts (const BUNDLE_FEATURES = …)
// portal-billing predates this module and keeps its local copies; both files point here.

import { paidThroughOf } from "./billingPeriods.ts";

const GRACE_DAYS = 7;

// One subscription that confers several features. full_suite unlocks everything except
// Self Serve Displays — the same map portal-billing holds. `crm` joined 2026-08-29 when the
// Suite repriced to $11,950/yr to include it (migration 160); it is PAY-ONLY, and a bundle
// conferring a pay-only feature is fine — a Suite subscription IS a real subscription.
export const BUNDLE_FEATURES: Record<string, string[]> = {
  full_suite: ["simple_layout", "schedule_builds", "view_3d", "quickbooks_sync", "on_demand_pricing", "crm"],
};

// Plan features that confer `feature`: the feature itself plus every bundle containing it.
const conferringFeatures = (feature: string): string[] => [
  feature,
  ...Object.keys(BUNDLE_FEATURES).filter((b) => BUNDLE_FEATURES[b].includes(feature)),
];

// True iff the tenant holds a subscription that makes `feature` usable RIGHT NOW:
// active, past_due within grace, or cancelled but inside the period already paid for.
// Throws on a database error — the caller turns that into its own 5xx (dbFail) rather
// than this module guessing; a paid gate fails CLOSED, never open, the wallet's posture.
export async function hasPaidFeature(
  admin: {
    from: (t: string) => {
      // deno-lint-ignore no-explicit-any
      select: (c: string) => any;
    };
  },
  clientId: string,
  feature: string,
): Promise<boolean> {
  // INTERNAL ACCOUNT (migration 169) short-circuits before anything else. This is the server
  // mirror of portal-billing's `internal` branch, and the two must agree: a UI that shows the
  // tab while every action 403s is worse than no access at all. Read first and cheaply — one
  // indexed lookup on a table this function would not otherwise touch, paid only on the paths
  // that are gated anyway.
  //
  // Fails CLOSED like the rest of this module: a read error throws to the caller's 5xx rather
  // than being swallowed into "not internal, carry on", because silently downgrading our own
  // account to a customer is how this bug happened the first time.
  const csRes = await admin.from("client_settings").select("internal_account").eq("client_id", clientId).maybeSingle();
  if (csRes.error) throw new Error(`client_settings read failed: ${csRes.error.message}`);
  if (csRes.data?.internal_account) return true;

  const confer = conferringFeatures(feature);
  const plansRes = await admin.from("billing_plans")
    .select("id, feature, billing_interval")
    .in("feature", confer);
  if (plansRes.error) throw new Error(`billing_plans read failed: ${plansRes.error.message}`);
  const plans = plansRes.data ?? [];
  if (!plans.length) return false;
  const intervalByPlan = new Map<string, string>(
    plans.map((p: { id: string; billing_interval?: string | null }) => [p.id, p.billing_interval ?? "month"]),
  );

  const subsRes = await admin.from("billing_subscriptions")
    .select("plan_id, status, current_period_start, current_period_end, canceled_at, created_at, past_due_since")
    .eq("client_id", clientId)
    .in("plan_id", [...intervalByPlan.keys()]);
  if (subsRes.error) throw new Error(`billing_subscriptions read failed: ${subsRes.error.message}`);

  const now = Date.now();
  // deno-lint-ignore no-explicit-any
  return (subsRes.data ?? []).some((s: any) => {
    if (s.status === "active") return true;
    if (s.status === "past_due") {
      const since = s.past_due_since ? Date.parse(s.past_due_since) : NaN;
      // Missing timestamp → grace from now: generous, never an instant lockout
      // (portal-billing's graceEndOf, same reasoning).
      const ends = Number.isFinite(since) ? since + GRACE_DAYS * 86400000 : now + GRACE_DAYS * 86400000;
      return ends > now;
    }
    if (s.status === "cancelled") {
      const paidUntil = paidThroughOf(s, intervalByPlan.get(s.plan_id) ?? "month");
      return Number.isFinite(paidUntil) && paidUntil > now;
    }
    return false;
  });
}
