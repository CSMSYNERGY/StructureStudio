// PLANS AS DATA AND THE BILLING GATE (migrations 386 and 387), driven through the SHIPPED
// portal-billing handler.
//
// portal-billing holds a company with nothing paid at a gate ("activate your account"). A plan an
// operator ASSIGNED (a comp, or one paid by ACH or cheque) is not a subscription it can see, so the
// first company put on a custom plan would have landed on that gate whatever its tabs said. Two
// rules close that, and this file holds both:
//
//   1. A company on the new map that is LOCKED and that an operator granted something directly
//      (access_for_portal's `granted`) is let through, like a phone-only account is.
//   2. A company on the new map that is STILL locked gets `modules: null`: today's padlocked rail and
//      the gate page, not a rail the map has emptied with nothing behind it.
//
// And the rule that makes shipping this safe: for a company that is NOT on the map, or when the
// database cannot answer, the gate and every other entitlement field are exactly what they were.
//
// HOW. billingGateAnyFeature_test's idiom: Deno.serve is stubbed while portal-billing/index.ts is
// imported, so a request goes through withErrorLog, resolveTenant and the real branches; the import
// map swaps supabase-js for supabase_stub.ts. Tenants and prices are made up (public repo).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubPlanRead, stubRpc } from "./supabase_stub.ts";

const NMI_ENV: Record<string, string> = {
  NMI_SECURITY_KEY: "harness-security-key",
  NMI_TOKENIZATION_KEY: "harness-tokenization-key",
  NMI_GATEWAY_URL: "https://gateway.example.test",
};
const savedNmi = Object.fromEntries(Object.keys(NMI_ENV).map((k) => [k, Deno.env.get(k)]));
for (const [k, v] of Object.entries(NMI_ENV)) Deno.env.set(k, v);
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
try {
  await import(new URL("../../portal-billing/index.ts", import.meta.url).href);
} finally {
  (Deno as any).serve = realServe;
  for (const [k, v] of Object.entries(savedNmi)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}
if (!handler) throw new Error("portal-billing did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

const PLANS = ["simple_layout", "crm", "view_3d"].flatMap((f, i) => (["monthly", "annual"] as const).map((iv) => ({
  id: `${f}_${iv}`, feature: f, name: f, billing_interval: iv, price_cents: iv === "annual" ? 200000 : 20000,
  gateway_plan_id: `HARNESS_${f}_${iv}`, setup_fee_cents: 0, availability: "available", required: false,
  sort_order: 100 - i, price_visible: true, active: true, operator_grantable: f === "view_3d",
})));
const DAY = 86400000;
const activeSub = (planId: string) => ({
  id: `sub-${planId}`, plan_id: planId, status: "active", price_cents: 200000,
  current_period_start: new Date(Date.now() - 30 * DAY).toISOString(),
  current_period_end: new Date(Date.now() + 335 * DAY).toISOString(),
  created_at: new Date(Date.now() - 30 * DAY).toISOString(),
});

type World = { subs?: any[]; settings?: Record<string, unknown> | null; rpc?: ((fn: string, args: any) => any) | null };
const TENANT = "harness-builder";

function answer(world: World, table: string): any {
  const one = (row: unknown) => ({ data: row ?? null, error: null });
  switch (table) {
    case "client_users": return { data: [{ client_id: TENANT, role: "owner", title: null, access: null }], error: null };
    case "app_operators": return one(null);
    case "client_configs": return one({ client_id: TENANT });
    case "billing_plans": return { data: PLANS.map((p) => ({ ...p })), error: null };
    case "billing_subscriptions": return { data: (world.subs ?? []).map((s) => ({ ...s })), error: null };
    case "billing_customers": return one(null);
    case "client_settings": return one(world.settings ?? null);
    case "client_feature_grants": return { data: [], error: null };
    case "wallet_accounts": return one(null);
    case "wallet_transactions": return { data: [], error: null };
    case "billing_charge_attempts": return { data: [], error: null };
    case "app_errors": case "admin_audit": return { data: null, error: null };
  }
  throw new Error(`the fake database has no answer for ${table}`);
}
function chain(world: World, table: string): any {
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "is", "in", "limit", "order", "single", "maybeSingle"]) {
    q[m] = () => q;
  }
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => answer(world, table)).then(ok, bad);
  return q;
}

const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };

async function status(world: World) {
  const rpcCalls: [string, any][] = [];
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  const quiet = console.error;
  console.error = () => {};
  stubAuth.user = { id: "00000000-0000-4000-8000-00000000f001", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, table);
  stubPlanRead.on = true;
  stubRpc.rpc = world.rpc === null ? null : (fn: string, args: any) => {
    rpcCalls.push([fn, args]);
    return world.rpc ? world.rpc(fn, args) : Promise.resolve({ data: { enforced: false, modules: null, granted: false }, error: null });
  };
  globalThis.fetch = (() => Promise.reject(new Error("TEST FAILURE: a status call reached the network"))) as typeof fetch;
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/portal-billing", {
      method: "POST",
      headers: { "authorization": "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action: "status" }),
    }));
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));
    assert(body.entitlement, "no entitlement in the status answer");
    return { e: body.entitlement as Record<string, any>, rpcCalls };
  } finally {
    globalThis.fetch = realFetch;
    console.error = quiet;
    stubDb.from = null;
    stubRpc.rpc = null;
    stubPlanRead.on = false;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const MAP = { contacts: "on", phone: "on", designer: "hidden", meetings: "locked" };
const answerOf = (a: Record<string, unknown>) => () => Promise.resolve({ data: a, error: null });
const gateOf = (e: Record<string, any>) => [e.state, e.locked, e.reason];

// ── a company that is NOT on the map: nothing moves ─────────────────────────────────────────
Deno.test("not on the map, nothing paid: locked as before, and modules is null", async () => {
  const { e, rpcCalls } = await status({});
  assertEquals(gateOf(e), ["locked", true, "never_paid"]);
  assertEquals(e.modules, null);
  assertEquals(rpcCalls, [["access_for_portal", { p_client_id: TENANT }]]);
});

Deno.test("not on the map, with a subscription: active as before, and modules is null", async () => {
  const { e } = await status({ subs: [activeSub("simple_layout_annual")] });
  assertEquals(gateOf(e), ["active", false, "active"]);
  assertEquals(e.modules, null);
  assertEquals(e.features.simple_layout, true);
});

Deno.test("the database cannot answer (no function, an error, a thrown call): the old rules, and status still answers", async () => {
  const before = (await status({})).e;
  for (const rpc of [
    null,                                                                                       // rpc() itself throws
    () => Promise.resolve({ data: null, error: { code: "42883", message: "function does not exist" } }),
    () => Promise.reject(new Error("timeout")),
    answerOf({ enforced: true, modules: { contacts: "sometimes" }, granted: true }),             // malformed
    answerOf({ enforced: "true", modules: MAP, granted: true }),
  ]) {
    const { e } = await status({ rpc });
    assertEquals(gateOf(e), ["locked", true, "never_paid"]);
    assertEquals(e.modules, null);
    assertEquals(e.features, before.features);
  }
});

// ── a company ON the map ────────────────────────────────────────────────────────────────────
Deno.test("on the map with a plan an operator ASSIGNED and no subscription: let through, with its tabs", async () => {
  const { e } = await status({ rpc: answerOf({ enforced: true, modules: MAP, granted: true }) });
  assertEquals(gateOf(e), ["active", false, "assigned_plan"]);
  assertEquals(e.modules, MAP);
  // It opens no paid add-on by the old vocabulary: what the company may open is the map.
  assertEquals([e.features.crm, e.features.simple_layout, e.features.view_3d], [false, false, false]);
  assertEquals(e.paid, []);
});

Deno.test("on the map, nothing paid and nothing granted (a 3D comp alone): STILL locked, and modules is null", async () => {
  const { e } = await status({ rpc: answerOf({ enforced: true, modules: { ...MAP, view_3d: "on" }, granted: false }) });
  assertEquals(gateOf(e), ["locked", true, "never_paid"]);
  assertEquals(e.modules, null);
});

Deno.test("on the map with a subscription: active by the subscription, with its tabs", async () => {
  const { e } = await status({ subs: [activeSub("crm_annual")], rpc: answerOf({ enforced: true, modules: MAP, granted: false }) });
  assertEquals(gateOf(e), ["active", false, "active"]);
  assertEquals(e.modules, MAP);
});

Deno.test("on the map and Non-billable or ours: exempt as before, with its tabs", async () => {
  const demo = await status({ settings: { billing_exempt: true }, rpc: answerOf({ enforced: true, modules: MAP, granted: false }) });
  assertEquals(gateOf(demo.e), ["exempt", false, "exempt"]);
  assertEquals(demo.e.modules, MAP);
  const ours = await status({ settings: { internal_account: true }, rpc: answerOf({ enforced: true, modules: MAP, granted: true }) });
  assertEquals(gateOf(ours.e), ["exempt", false, "internal"]);
  assertEquals(ours.e.modules, MAP);
});

Deno.test("the map changes no other entitlement field", async () => {
  const world = { subs: [activeSub("simple_layout_annual")] };
  const off = (await status(world)).e;
  const on = (await status({ ...world, rpc: answerOf({ enforced: true, modules: MAP, granted: true }) })).e;
  const strip = (e: Record<string, any>) => { const { modules: _m, ...rest } = e; return rest; };
  assertEquals(strip(on), strip(off));
});
