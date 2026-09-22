// featureCheck.test.ts — the NON-BILLABLE rule, pinned.
//
// Exists because migration 228 reversed a decision this repo argues for in four places, and
// the cheapest way for it to be quietly reverted is a "tidy-up" of the `billing_exempt`
// short-circuit. These three cases fail loudly if that happens.
//
// Drives the REAL _shared/featureCheck.ts (the exact file now deployed) with the live row
// shapes for demo-sheds (non-billable, no subscriptions) and junior-barns (billable, one
// active Simple Layout annual), read from the production DB on 2026-09-21.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hasPaidFeature, usableFeatureSet } from "./featureCheck.ts";

const PLANS = [
  { id: "simple_layout_monthly", feature: "simple_layout", billing_interval: "monthly", operator_grantable: false },
  { id: "simple_layout_annual", feature: "simple_layout", billing_interval: "annual", operator_grantable: false },
  { id: "schedule_builds_monthly", feature: "schedule_builds", billing_interval: "monthly", operator_grantable: false },
  { id: "quickbooks_sync_monthly", feature: "quickbooks_sync", billing_interval: "monthly", operator_grantable: false },
  { id: "on_demand_pricing_monthly", feature: "on_demand_pricing", billing_interval: "monthly", operator_grantable: false },
  { id: "crm_monthly", feature: "crm", billing_interval: "monthly", operator_grantable: false },
  { id: "view_3d_monthly", feature: "view_3d", billing_interval: "monthly", operator_grantable: true },
  { id: "full_suite_monthly", feature: "full_suite", billing_interval: "monthly", operator_grantable: false },
];

function makeAdmin(settings: Record<string, unknown> | null, subs: Record<string, unknown>[], grants: Record<string, unknown>[] = []) {
  // deno-lint-ignore no-explicit-any
  const stub: any = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      let want: string[] = [];
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = (_c: string, v: string[]) => { want = v; return chain; };
      chain.maybeSingle = () => Promise.resolve({ data: settings, error: null });
      // `in()` terminates the chain for plans/subs/grants — make it thenable.
      (chain as { then?: unknown }).then = (res: (v: unknown) => void) => {
        if (table === "billing_plans") return res({ data: PLANS.filter((p) => want.includes(p.feature)), error: null });
        if (table === "billing_subscriptions") return res({ data: subs.filter((s) => want.includes(String(s.plan_id))), error: null });
        if (table === "client_feature_grants") return res({ data: grants, error: null });
        return res({ data: [], error: null });
      };
      return chain;
    },
  };
  return stub;
}

const ALL = ["simple_layout", "schedule_builds", "quickbooks_sync", "on_demand_pricing", "crm", "view_3d"];

Deno.test("demo-sheds (NON-BILLABLE, zero subscriptions) can use every feature", async () => {
  const admin = makeAdmin({ internal_account: false, billing_exempt: true }, []);
  const set = await usableFeatureSet(admin, "demo-sheds", ALL);
  assertEquals([...set].sort(), [...ALL].sort());
  for (const f of ALL) assertEquals(await hasPaidFeature(admin, "demo-sheds", f), true, `hasPaidFeature(${f})`);
});

Deno.test("junior-barns (BILLABLE, one active Simple Layout) still gets ONLY what it bought", async () => {
  const subs = [{
    plan_id: "simple_layout_annual", status: "active",
    current_period_start: "2026-08-04T17:20:05.827Z", current_period_end: "2027-08-04T00:00:00Z",
    canceled_at: null, created_at: "2026-08-04T17:20:05.871484Z", past_due_since: null,
  }];
  const admin = makeAdmin({ internal_account: false, billing_exempt: false }, subs);
  const set = await usableFeatureSet(admin, "junior-barns", ALL);
  assertEquals([...set], ["simple_layout"]);
  for (const f of ["schedule_builds", "quickbooks_sync", "on_demand_pricing", "crm", "view_3d"]) {
    assertEquals(await hasPaidFeature(admin, "junior-barns", f), false, `${f} must stay locked`);
  }
  assertEquals(await hasPaidFeature(admin, "junior-barns", "simple_layout"), true);
});

Deno.test("a tenant with NO client_settings row is unaffected", async () => {
  const admin = makeAdmin(null, []);
  assertEquals([...await usableFeatureSet(admin, "nobody", ALL)], []);
  assertEquals(await hasPaidFeature(admin, "nobody", "crm"), false);
});
