// What a company has TODAY, worked out the way the product works it out today: portal-billing's
// entitlement (featureState, the pay-only and grantable branches, Non-billable, the dated free
// period), the account shapes (364 sheds_enabled, 384 phone_only) and the per-company switch columns.
//
// It exists to be compared with migration 386's resolver. The resolver is SQL reading rows; this is
// JavaScript following the code. Two independent readings of the same rules agreeing on the same
// data is the evidence that switching a reader from one to the other changes nothing.
//
// ON versus NOT ON only. Whether a tab that is not on shows a padlock or nothing at all lives in the
// portal shell's upsell cards, and stage B pins that there.
//
// Not a test file (the gate runs tests/sql/*.test.cjs): migration386.test.cjs requires it, and so
// does the live parity run. No client identifiers in here (public repo).

const GRACE_MS = 7 * 86400000;

// portal-billing / featureCheck.ts BUNDLE_FEATURES and PAID_ONLY_FEATURES, copied on purpose: this
// file is the OLD rule, so it must not read the new tables.
const BUNDLE = { full_suite: ["simple_layout", "schedule_builds", "view_3d", "quickbooks_sync", "on_demand_pricing", "crm"] };
const PAID_ONLY = new Set(["schedule_builds", "quickbooks_sync", "on_demand_pricing", "crm"]);

// _shared/billingPeriods.ts addInterval + paidThroughOf.
function addInterval(ms, interval) {
  const d = new Date(ms);
  const yearly = /^(year|annual)/.test(String(interval).toLowerCase());
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(
    d.getUTCFullYear() + (yearly ? 1 : 0), d.getUTCMonth() + (yearly ? 0 : 1), 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
  ));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}
function paidThroughOf(s, interval, now) {
  const stored = s.current_period_end ? Date.parse(s.current_period_end) : NaN;
  if (!Number.isFinite(stored)) return NaN;
  const chargedUntil = s.canceled_at ? Date.parse(s.canceled_at) : now;
  if (!Number.isFinite(chargedUntil)) return stored;
  let end = stored;
  for (let i = 0; i < 240 && end <= chargedUntil; i++) end = addInterval(end, interval);
  return end;
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v);

/**
 * @param {object} input
 *   settings  the company's client_settings row, or null when it has none
 *   subs      its billing_subscriptions rows
 *   plans     every billing_plans row (id, feature, billing_interval, active, operator_grantable)
 *   grants    its client_feature_grants rows
 *   now       epoch ms
 * @returns {Set<string>} the catalogue tabs that are ON for it today
 */
function todayOn({ settings, subs, plans, grants, now }) {
  const cs = settings || {};
  const planById = new Map(plans.map((p) => [p.id, p]));
  const expand = (f) => (!f ? [] : BUNDLE[f] ? [f, ...BUNDLE[f]] : [f]);

  // featureState: is any subscription conferring this feature usable right now?
  const usable = new Set();
  for (const s0 of subs) {
    const s = { ...s0, current_period_end: iso(s0.current_period_end), canceled_at: iso(s0.canceled_at), past_due_since: iso(s0.past_due_since) };
    const plan = planById.get(s.plan_id);
    if (!plan || !plan.feature) continue;
    let ok = false;
    if (s.status === "active") ok = true;
    else if (s.status === "past_due") {
      const since = s.past_due_since ? Date.parse(s.past_due_since) : NaN;
      ok = (Number.isFinite(since) ? since + GRACE_MS : now + GRACE_MS) > now;
    } else if (s.status === "cancelled") {
      const until = paidThroughOf(s, plan.billing_interval || "month", now);
      ok = Number.isFinite(until) && until > now;
    }
    if (ok) for (const f of expand(plan.feature)) usable.add(f);
  }

  const internal = cs.internal_account === true;
  const exempt = cs.billing_exempt === true;
  const untilMs = cs.billing_exempt_until ? Date.parse(iso(cs.billing_exempt_until)) : NaN;
  const inTransition = Number.isFinite(untilMs) && untilMs > now;
  const granted = new Set(grants
    .filter((g) => !g.expires_at || Date.parse(iso(g.expires_at)) > now)
    .map((g) => g.feature));
  const grantable = new Set(plans.filter((p) => p.operator_grantable && !PAID_ONLY.has(p.feature)).map((p) => p.feature));

  // The features map, branch for branch.
  const feature = (f) => (internal || exempt) ? true
    : PAID_ONLY.has(f) ? usable.has(f)
    : grantable.has(f) ? (granted.has(f) || usable.has(f))
    : (inTransition || usable.has(f));
  const sold = new Set(plans.filter((p) => p.active).map((p) => p.feature));
  const has = (f) => sold.has(f) && feature(f);

  const phoneOnly = cs.phone_only === true;
  const shedsOn = !phoneOnly && cs.sheds_enabled !== false;
  // The billing gate: Non-billable, ours, anything usable, or a dated free period.
  const gateOpen = internal || exempt || usable.size > 0 || inTransition;

  const on = new Set();
  // A phone-only account (384) is offered, and allowed, the phone and the contact list. Nothing else.
  if (phoneOnly) return new Set(["contacts", "phone", "sms"]);

  if (gateOpen) {
    on.add("commissions");
    if (shedsOn) for (const m of ["designer", "inventory", "orders", "ghl", "customer_login"]) on.add(m);
  }
  if (has("crm")) for (const m of ["contacts", "pipelines", "conversations", "sms", "email", "meetings", "automations", "forms"]) on.add(m);
  if (has("schedule_builds") && shedsOn) for (const m of ["build_schedule", "delivery_schedule", "repairs"]) on.add(m);
  // 3D opens on a comp OR a purchase (01-core ssView3dOn); ours and Non-billable are shown it as a comp.
  if (shedsOn && sold.has("view_3d") && (internal || exempt || granted.has("view_3d") || usable.has("view_3d"))) on.add("view_3d");
  if (has("quickbooks_sync")) on.add("quickbooks");
  if (has("on_demand_pricing") && shedsOn) on.add("rtp");
  if (has("self_serve_displays") && shedsOn) on.add("self_serve_displays");
  if (has("smartbuild_sync")) on.add("smartbuild_sync");
  if (has("project_management")) on.add("projects");

  // The per-company switches. None of them is a plan, so Non-billable does not turn them on.
  if (cs.jack_on === true) on.add("jack");
  if (cs.support_ai_beta === true) on.add("support_ai");
  if (cs.library_beta === true) on.add("library");
  if (cs.door_looks_beta === true) on.add("door_looks");
  if (cs.phone_status === "on") on.add("phone");
  if (shedsOn) {
    if (cs.tax_lookup_enabled === true) on.add("tax");
    if (cs.payments_online_enabled === true) on.add("payments");
    if (internal || cs.advanced_mode === true) on.add("advanced");
  }
  return on;
}

module.exports = { todayOn };
