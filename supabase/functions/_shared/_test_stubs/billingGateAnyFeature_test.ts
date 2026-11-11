// THE BILLING GATE KEYS ON "ANY PAID FEATURE", driven through the SHIPPED portal-billing handler.
//
// WHY THIS EXISTS. Until 2026-11-04 the gate asked whether the tenant held the REQUIRED feature
// (Simple Layout). StructureStudio stopped being a shed-only product: a post-frame builder buys
// Customer Hub and SmartBuild Sync and never wants the designer, and that builder was both
// padlocked out of the portal and refused at checkout. Migration 359 clears `required` from every
// plan row and the gate now reads the subscriptions themselves.
//
// ⚠️ THE FAILURE THIS FILE EXISTS TO CATCH. The old gate was `else if (requiredFeatures.length > 0)`.
// Clear the flag under that code and the branch never runs, `entState` keeps its "active"
// initialiser, and EVERY non-exempt tenant reads as unlocked — the whole portal, free, with
// nothing looking wrong on screen. So the case that matters most here is the dullest one: a tenant
// with NO subscriptions is LOCKED. If that ever passes while reading "active", the gate is gone.
//
// Each status case runs against BOTH catalogues — one with `required: true` still on the base
// (the live rows before the migration) and one with it cleared (after). The gate must give the
// same answer to both, which is what makes it safe to deploy this handler BEFORE applying 359.
//
// HOW. The foundingAnnualOnly_test idiom: Deno.serve is stubbed while portal-billing/index.ts is
// imported, so a request goes through withErrorLog, resolveTenant and the real branches. The
// import map swaps supabase-js for supabase_stub.ts, whose stubDb hook routes every table read
// and write into the fake below. fetch is the payment gateway and nothing else, and no
// --allow-net is granted, so no card can be charged from here.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE, as in foundingAnnualOnly_test: a literal one
// puts portal-billing in this file's type-checked graph against the stub's partial client type.
//
// Tenants, users and plan prices here are made up. The repo is public: no real client id belongs
// in a fixture.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";
import { COF_CONSENT_VERSION } from "../cofConsent.ts";

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const GATEWAY = "https://gateway.example.test";
const NMI_ENV: Record<string, string> = {
  NMI_SECURITY_KEY: "harness-security-key",
  NMI_TOKENIZATION_KEY: "harness-tokenization-key",
  NMI_GATEWAY_URL: GATEWAY,
};
const savedNmi = Object.fromEntries(Object.keys(NMI_ENV).map((k) => [k, Deno.env.get(k)]));
for (const [k, v] of Object.entries(NMI_ENV)) Deno.env.set(k, v);
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
let serveCalls = 0;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  serveCalls++;
  handler = h;
  return { finished: Promise.resolve() };
};
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

// ─── Two catalogues: before migration 359 and after ────────────────────────────────────────────
const FEATURES = [
  { feature: "full_suite", name: "Suite", mo: 80000, avail: "available" },
  { feature: "simple_layout", name: "Base", mo: 20000, avail: "available" },
  { feature: "crm", name: "Customer Hub", mo: 40000, avail: "available" },
  { feature: "view_3d", name: "3D", mo: 30000, avail: "available" },
  { feature: "smartbuild_sync", name: "SmartBuild Sync", mo: 8500, avail: "coming_soon" },
];
const catalogue = (baseRequired: boolean) => FEATURES.flatMap((f, i) => (["monthly", "annual"] as const).map((iv) => ({
  id: `${f.feature}_${iv}`, feature: f.feature, name: f.name, billing_interval: iv,
  price_cents: iv === "annual" ? f.mo * 10 : f.mo,
  gateway_plan_id: `HARNESS_${f.feature.toUpperCase()}_${iv.toUpperCase()}`,
  setup_fee_cents: 0, availability: f.avail,
  required: baseRequired && f.feature === "simple_layout",
  sort_order: 100 - i, price_visible: true, active: true, operator_grantable: false,
})));
const CATALOGUES = { "required still set (pre-359)": catalogue(true), "required cleared (post-359)": catalogue(false) };
const price = (id: string) => catalogue(false).find((p) => p.id === id)!.price_cents;

const DAY = 86400000;
const iso = (ms: number) => new Date(ms).toISOString();

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
type World = {
  plans?: any[];
  settings?: Record<string, unknown> | null;
  vault?: string | null;
  subs?: Record<string, unknown>[];
  gateway?: "decline" | "ok";
};
type Trace = { db: any[][]; writes: any[][]; errors: Record<string, unknown>[]; gateway: Record<string, string>[] };

const USER_ID = "00000000-0000-4000-8000-00000000f001";
const TENANT = "harness-builder";
const WRITES = new Set(["insert", "upsert", "update", "delete"]);

function answer(world: World, trace: Trace, table: string, ops: any[][]): any {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
  const one = (row: unknown) => ({ data: row ?? null, error: null });
  switch (table) {
    case "client_users":
      return { data: [{ client_id: TENANT, role: "owner", title: null, access: null }], error: null };
    case "app_operators":
      return one(null);
    case "client_configs":
      return one({ client_id: TENANT });
    case "billing_plans":
      return { data: (world.plans ?? CATALOGUES["required cleared (post-359)"]).map((p) => ({ ...p })), error: null };
    case "billing_subscriptions":
      return { data: (world.subs ?? []).map((s) => ({ ...s })), error: null };
    case "billing_customers":
      if (has("upsert")) return { data: null, error: null };
      return one(world.vault ? { vault_id: world.vault } : null);
    case "client_settings":
      return one(world.settings ?? null);
    case "client_feature_grants":
      return { data: [], error: null };
    case "app_errors":
      trace.errors.push(arg("insert"));
      return { data: null, error: null };
    case "billing_consents":
      return has("insert") ? one({ id: 9001 }) : { data: null, error: null };
    case "billing_charge_attempts":
      if (has("insert")) return one({ id: 501 });
      return { data: [], error: null };
    case "wallet_accounts":
      return one(null);
    case "wallet_transactions":
      return { data: [], error: null };
    case "admin_audit":
      return { data: null, error: null };
  }
  throw new Error(`the fake database has no answer for ${table} ${JSON.stringify(ops)}`);
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "is", "in", "limit", "order", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    trace.db.push([table, ...ops]);
    if (ops.some((o) => WRITES.has(o[0]))) trace.writes.push([table, ...ops]);
    return Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  };
  return q;
}

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

async function drive(payload: Record<string, unknown>, world: World = {}) {
  const trace: Trace = { db: [], writes: [], errors: [], gateway: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: () => new AbortController().signal });
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${GATEWAY}/`)) throw new Error(`unexpected fetch: ${url}`);
    const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    delete params.security_key;
    trace.gateway.push(params);
    if (!world.gateway) return Promise.reject(new Error("TEST FAILURE: the payment gateway was called"));
    const body = world.gateway === "ok"
      ? "response=1&responsetext=SUCCESS&transactionid=harness-txn&subscription_id=harness-sub"
      : "response=2&responsetext=Harness+decline+-+nothing+was+charged";
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/portal-billing", {
      method: "POST",
      headers: { "authorization": "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(payload),
    }));
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, trace };
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: realTimeout });
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

/** The gate's answer for one set of subscription rows, under both catalogues. */
async function gate(subs: Record<string, unknown>[], settings: Record<string, unknown> | null = null) {
  const out: Record<string, { state: string; locked: boolean; reason: string }> = {};
  for (const [label, plans] of Object.entries(CATALOGUES)) {
    const r = await drive({ action: "status" }, { plans, subs, settings });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const e = r.body.entitlement;
    assert(e, `no entitlement in the status answer (${label}): ${JSON.stringify(r.body)}`);
    out[label] = { state: e.state, locked: e.locked, reason: e.reason };
  }
  const [a, b] = Object.values(out);
  assertEquals(a, b, `the gate answered differently before and after migration 359: ${JSON.stringify(out)}`);
  return a;
}

// ⚠️ The period must be INTERNALLY CONSISTENT, because `paidThroughOf` falls back to
// start + one interval when the stored end does not stand up: an annual row whose start is 30
// days ago is paid through next year whatever its `current_period_end` says, so a "spent"
// fixture has to start more than a year back. Getting that wrong reads as a gate bug.
const sub = (planId: string, status: string, endMs: number, extra: Record<string, unknown> = {}) => {
  const year = 365 * DAY;
  const start = endMs - year;
  return {
    id: `sub-${planId}-${status}`, plan_id: planId, status,
    price_cents: price(planId),
    current_period_start: iso(start),
    current_period_end: iso(endMs),
    created_at: iso(start),
    ...extra,
  };
};

// ─── Tests ─────────────────────────────────────────────────────────────────────────────────────
Deno.test("module registered exactly one handler through Deno.serve", () => {
  assertEquals(serveCalls, 1);
});

Deno.test("THE ONE THAT MUST NOT ROT: no subscriptions at all is LOCKED, never_paid", async () => {
  // If this ever reads "active", the gate has been skipped entirely and every non-paying tenant
  // has the whole portal. It is the exact failure mode of keying on an empty `required` list.
  assertEquals(await gate([]), { state: "locked", locked: true, reason: "never_paid" });
});

Deno.test("Customer Hub alone unlocks the account — no Simple Layout anywhere", async () => {
  // Joe's shape: a post-frame builder who bought the CRM and never wants the designer. Under the
  // old rule this tenant was padlocked out of a portal they were paying for.
  assertEquals(
    await gate([sub("crm_annual", "active", Date.now() + 300 * DAY)]),
    { state: "active", locked: false, reason: "active" },
  );
});

Deno.test("a lapsed card inside the 7-day grace keeps the account open", async () => {
  const g = await gate([sub("crm_annual", "past_due", Date.now() - 2 * DAY, { past_due_since: iso(Date.now() - 2 * DAY) })]);
  assertEquals({ state: g.state, locked: g.locked }, { state: "grace", locked: false });
  assertEquals(g.reason, "past_due");
});

Deno.test("cancelled but still inside the period already paid for stays open", async () => {
  // Checkout bills each period up front, so locking here would confiscate a prepaid year.
  assertEquals(
    await gate([sub("crm_annual", "cancelled", Date.now() + 200 * DAY)]),
    { state: "active", locked: false, reason: "active" },
  );
});

Deno.test("cancelled and the paid period is spent locks, and says why", async () => {
  assertEquals(
    // They cancelled mid-period and kept access to the end of what they had paid for; that end
    // is now behind us. `canceled_at` is load-bearing: paidThroughOf rolls the stored boundary
    // forward by whole intervals until the gateway stopped charging, so a cancelled row with no
    // cancellation date (or one AFTER the boundary) rolls on and reads as still paid up.
    await gate([sub("crm_annual", "cancelled", Date.now() - 10 * DAY, { canceled_at: iso(Date.now() - 200 * DAY) })]),
    { state: "locked", locked: true, reason: "cancelled" },
  );
});

Deno.test("the Suite still unlocks on its own", async () => {
  assertEquals(
    await gate([sub("full_suite_annual", "active", Date.now() + 300 * DAY)]),
    { state: "active", locked: false, reason: "active" },
  );
});

// A PHONE-ONLY account (migration 384) pays by its wallet and has no subscription to buy, so the
// gate lets it in on the shape alone — and opens NOTHING paid: crm stays false (its contacts are
// accountShape.ts's narrow grant in portal-settings, not the feature), and the shed half is off.
Deno.test("a phone-only account with no subscription is let in (reason phone_only), with no paid feature", async () => {
  assertEquals(await gate([], { phone_only: true }), { state: "active", locked: false, reason: "phone_only" });
  const r = await drive({ action: "status" }, { subs: [], settings: { phone_only: true } });
  const e = r.body.entitlement;
  assertEquals([e.phoneOnly, e.shedsOn, e.features.crm, e.features.simple_layout], [true, false, false, false]);
});

Deno.test("…and only an explicit true does it: false, a missing row or a lost read is the ordinary gate", async () => {
  assertEquals(await gate([], { phone_only: false }), { state: "locked", locked: true, reason: "never_paid" });
  assertEquals(await gate([], { phone_only: "true" }), { state: "locked", locked: true, reason: "never_paid" });
  const r = await drive({ action: "status" }, { subs: [], settings: null });
  assertEquals([r.body.entitlement.phoneOnly, r.body.entitlement.shedsOn], [false, true]);
});

Deno.test("a phone-only account cannot buy a plan: subscribe is refused before the gateway (384)", async () => {
  const r = await drive(
    { action: "subscribe", planIds: ["crm_annual"], confirmChargeCents: price("crm_annual"), paymentToken: "harness-token", consent: { version: COF_CONSENT_VERSION, accepted: true } },
    { vault: null, gateway: "ok", settings: { phone_only: true } },
  );
  assertEquals(r.status, 403, JSON.stringify(r.body));
  assert(/This isn't part of your account/.test(String(r.body?.error ?? "")), JSON.stringify(r.body));
  assertEquals([r.trace.gateway.length, r.trace.writes.length], [0, 0], "nothing charged, nothing written");
  // …and its wallet still answers.
  const s = await drive({ action: "status" }, { settings: { phone_only: true } });
  assertEquals(s.status, 200, JSON.stringify(s.body));
});

Deno.test("a non-billable account is exempt, with or without rows", async () => {
  const g = await gate([], { billing_exempt: true });
  assertEquals({ state: g.state, locked: g.locked }, { state: "exempt", locked: false });
});

Deno.test("checkout takes a Customer-Hub-only cart — the required-base 400 is gone", async () => {
  // This is the sentence that used to refuse it:
  //   "Simple Layout is the required base plan — add it (or the Suite) to your selection."
  // The stand-in declines the card, so nothing is charged; what matters is that the request got
  // all the way to the first gateway call instead of being turned away at the cart check.
  const r = await drive(
    { action: "subscribe", planIds: ["crm_annual"], confirmChargeCents: price("crm_annual"), paymentToken: "harness-token", consent: { version: COF_CONSENT_VERSION, accepted: true } },
    { vault: null, gateway: "decline" },
  );
  assert(!String(r.body?.error ?? "").includes("required base plan"), `the cart was refused for a required base: ${JSON.stringify(r.body)}`);
  assertEquals(r.trace.gateway.map((g) => g.type), ["sale"], JSON.stringify(r.body));
});
