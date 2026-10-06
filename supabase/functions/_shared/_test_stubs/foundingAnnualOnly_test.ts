// Founding pricing is yearly only ON THE SERVER, driven through the SHIPPED portal-billing handler.
//
// WHY THIS EXISTS. Since 2026-09-24 the Billing tab will not put a monthly plan in the cart
// (FOUNDING_ANNUAL_ONLY in portal/03-catalog.jsx), but until 2026-09-29 portal-billing's
// `subscribe` still sold one to any request that named it. The refusal that closes that gap is
// only worth having if all of this holds, and each is pinned here:
//
//   1. A monthly plan anywhere in the cart is refused: 409, code "founding_annual_only", the
//      sentence from _shared/foundingPricing.ts, and the monthly plan ids — for a builder, for an
//      operator in view-as, and on the move up to the Suite.
//   2. The refusal happens BEFORE anything is touched: the gateway stand-in below fails the test
//      if it is called at all, no row is written anywhere (no vault, no attempt ledger, no strict
//      operator audit row), and nothing is filed in app_errors (a 4xx is a refusal, not a fault).
//   3. Everything else is exactly as it was: an annual cart goes on to the gateway, a comped
//      (billing_exempt, not internal) tenant's annual cart too, our own internal account still
//      gets its own 409 first, and cancelling a monthly subscription still reaches the gateway.
//
// The switch itself, and its pin to the browser's copy, are _shared/foundingPricing.test.ts.
//
// HOW. The aiDraftStreamWiring_test idiom: Deno.serve is stubbed while portal-billing/index.ts is
// imported, so a request goes through withErrorLog, resolveTenant and the subscribe branch exactly
// as it does live. The import map swaps supabase-js for supabase_stub.ts, whose stubDb hook routes
// every table read and write into the fake below. fetch is the payment gateway and nothing else,
// and no --allow-net is granted, so no card can be charged from here.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE, as in aiDraftStreamWiring_test: a literal one
// puts portal-billing in this file's type-checked graph against the stub's partial client type.
// preflight's `deno check` types it against the real client; here it only has to run.
//
// Tenants, users and plan prices here are made up. The repo is public: no real client id belongs
// in a fixture.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";
import {
  FOUNDING_ANNUAL_ONLY, FOUNDING_ANNUAL_ONLY_CODE, FOUNDING_ANNUAL_ONLY_MESSAGE, FOUNDING_ANNUAL_ONLY_STATUS,
} from "../foundingPricing.ts";
import { paidThroughOf } from "../billingPeriods.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SOURCE = await read("../../portal-billing/index.ts");
const WEBHOOK = await read("../../billing-webhook/index.ts");

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
// _shared/nmi.ts reads the gateway settings when it is first imported, so they are set around the
// import. The gateway host is a .test name: even a stand-in that let a call through could not
// reach anything real.
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

// ─── The catalogue: monthly + annual pairs, in billing_plans' shape ─────────────────────────────
const FEATURES = [
  { feature: "full_suite", name: "Suite", mo: 80000, avail: "available", required: false },
  { feature: "simple_layout", name: "Base", mo: 20000, avail: "available", required: true },
  { feature: "crm", name: "CRM", mo: 20000, avail: "available", required: false },
  { feature: "view_3d", name: "3D", mo: 30000, avail: "available", required: false },
  { feature: "self_serve_displays", name: "Displays", mo: 50000, avail: "coming_soon", required: false },
];
const PLANS = FEATURES.flatMap((f, i) => (["monthly", "annual"] as const).map((iv) => ({
  id: `${f.feature}_${iv}`, feature: f.feature, name: f.name, billing_interval: iv,
  price_cents: iv === "annual" ? f.mo * 10 : f.mo, gateway_plan_id: `HARNESS_${f.feature.toUpperCase()}_${iv.toUpperCase()}`,
  setup_fee_cents: 0, availability: f.avail, required: f.required, sort_order: 100 - i, price_visible: true,
  active: true, operator_grantable: false,
})));
const price = (id: string) => PLANS.find((p) => p.id === id)!.price_cents;

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
type World = {
  tenant?: string;
  settings?: Record<string, unknown> | null;   // client_settings row (null = none)
  vault?: string | null;                        // billing_customers.vault_id (null = no card on file)
  subs?: Record<string, unknown>[];             // billing_subscriptions rows
  operator?: boolean;                           // the caller is a platform operator in view-as
  gateway?: "decline" | "ok";                   // how the gateway answers; unset = it must not be called
};
type Trace = {
  db: any[][];                                  // every awaited table op, in order
  writes: any[][];                              // the ones that insert / upsert / update / delete
  audit: Record<string, unknown>[];             // admin_audit rows
  errors: Record<string, unknown>[];            // app_errors rows
  gateway: Record<string, string>[];            // every gateway request, parsed
};

const USER_ID = "00000000-0000-4000-8000-00000000f001";
const OPERATOR_ID = "00000000-0000-4000-8000-00000000f0f0";
const WRITES = new Set(["insert", "upsert", "update", "delete"]);

function answer(world: World, trace: Trace, table: string, ops: any[][]): any {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
  const tenant = world.tenant ?? "harness-builder";
  const one = (row: unknown) => ({ data: row ?? null, error: null });
  switch (table) {
    case "client_users":
      // An operator belongs to no tenant; a builder owns this one.
      return { data: world.operator ? [] : [{ client_id: tenant, role: "owner", title: null, access: null }], error: null };
    case "app_operators":
      return one(world.operator ? { user_id: OPERATOR_ID, email: "operator@example.test", can_write: true, can_bill: true, support_only: false } : null);
    case "client_configs":
      return one({ client_id: tenant });
    case "billing_plans":
      return { data: PLANS.map((p) => ({ ...p })), error: null };
    case "billing_subscriptions":
      if (has("update")) {
        const hit = (world.subs ?? []).find((s) => s.id === (ops.find((o) => o[0] === "eq") ?? [])[2]);
        return one(hit ? { ...hit, ...arg("update") } : null);
      }
      return { data: (world.subs ?? []).map((s) => ({ ...s })), error: null };
    case "billing_customers":
      if (has("upsert")) return { data: null, error: null };
      return one(world.vault ? { vault_id: world.vault } : null);
    case "client_settings":
      return one(world.settings ?? null);
    case "client_feature_grants":
      return { data: [], error: null };
    case "admin_audit":
      trace.audit.push(arg("insert"));
      return { data: null, error: null };
    case "app_errors":
      trace.errors.push(arg("insert"));
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
  const trace: Trace = { db: [], writes: [], audit: [], errors: [], gateway: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  stubAuth.user = world.operator
    ? { id: OPERATOR_ID, email: "operator@example.test" }
    : { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  // nmiPost's 30 s AbortSignal.timeout would outlive the test as a live timer; nothing here waits.
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: () => new AbortController().signal });
  // THE GATEWAY. With no `gateway` in the world, a call is a test failure: it is recorded (so the
  // test fails however the handler copes with the throw) and it throws (so nothing proceeds).
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
      body: JSON.stringify(world.operator ? { ...payload, targetClientId: world.tenant ?? "harness-builder" } : payload),
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

const subscribe = (planIds: string[], extra: Record<string, unknown> = {}) =>
  ({ action: "subscribe", planIds, confirmChargeCents: planIds.reduce((s, id) => s + price(id), 0), ...extra });
const REFUSED = { error: FOUNDING_ANNUAL_ONLY_MESSAGE, code: FOUNDING_ANNUAL_ONLY_CODE };

/** The founding refusal, and proof it touched nothing on its way out. */
function assertRefusedUntouched(r: Awaited<ReturnType<typeof drive>>, monthlyIds: string[]) {
  assertEquals(r.status, FOUNDING_ANNUAL_ONLY_STATUS, JSON.stringify(r.body));
  assertEquals(r.body, { ...REFUSED, planIds: monthlyIds });
  assertEquals(r.trace.gateway, [], "the payment gateway was called for a refused cart");
  assertEquals(r.trace.writes.filter((w) => w[0] !== "admin_audit"), [], "a refused cart wrote to the database");
  assert(!r.trace.db.some((op) => op[0] === "billing_charge_attempts"), "the attempt ledger was touched");
  assertEquals(r.trace.errors, [], "a refusal filed an app_errors row");
}

// ─── Tests ─────────────────────────────────────────────────────────────────────────────────────
Deno.test("module registered exactly one handler through Deno.serve, with founding pricing on", () => {
  assertEquals(serveCalls, 1);
  assert(FOUNDING_ANNUAL_ONLY, "these cases describe founding pricing ON; with it off they are the wrong tests");
});

Deno.test("monthly is refused: a new builder's monthly base plan, before the card is ever vaulted", async () => {
  // No card on file and a fresh Collect.js token: without the refusal, the next step is the
  // gateway's add_customer, then a real sale.
  const r = await drive(subscribe(["simple_layout_monthly"], { paymentToken: "harness-token" }), { vault: null });
  assertRefusedUntouched(r, ["simple_layout_monthly"]);
});

Deno.test("monthly is refused: a mixed cart is refused WHOLE, annual lines included", async () => {
  const r = await drive(subscribe(["simple_layout_annual", "crm_monthly", "view_3d_annual"], { paymentToken: "harness-token" }), { vault: null });
  assertRefusedUntouched(r, ["crm_monthly"]);
});

Deno.test("monthly is refused: a builder with a card on file, before the confirm-amount check and any sale", async () => {
  const r = await drive(subscribe(["crm_monthly", "view_3d_monthly"]), {
    vault: "harness-vault",
    subs: [{ id: "sub-base", plan_id: "simple_layout_annual", status: "active", price_cents: price("simple_layout_annual"), created_at: new Date().toISOString() }],
  });
  assertRefusedUntouched(r, ["crm_monthly", "view_3d_monthly"]);
});

Deno.test("monthly is refused: the move up to the Suite cannot land on the monthly Suite", async () => {
  const start = new Date(Date.now() - 30 * 86400000).toISOString();
  const r = await drive(subscribe(["full_suite_monthly"]), {
    vault: "harness-vault",
    subs: [{
      id: "sub-base", plan_id: "simple_layout_annual", status: "active", price_cents: price("simple_layout_annual"),
      current_period_start: start, current_period_end: new Date(Date.now() + 300 * 86400000).toISOString(), created_at: start,
    }],
  });
  assertRefusedUntouched(r, ["full_suite_monthly"]);
});

Deno.test("monthly is refused: an operator in view-as, before the strict audit row and the gateway", async () => {
  const r = await drive(subscribe(["simple_layout_monthly"]), { operator: true, vault: "harness-vault" });
  assertRefusedUntouched(r, ["simple_layout_monthly"]);
  // The best-effort `operator_billing_subscribe` row is written for every operator call, as it
  // always was; the STRICT attempt row that precedes a charge must not be.
  assertEquals(r.trace.audit.map((a) => a.action), ["operator_billing_subscribe"]);
});

Deno.test("annual is allowed: the same builder's annual cart goes on to the gateway", async () => {
  const r = await drive(subscribe(["simple_layout_annual", "crm_annual"], { paymentToken: "harness-token" }), { vault: null, gateway: "decline" });
  // The stand-in declines the card at the vault step, so nothing is charged, but the request got
  // past every refusal to the first gateway call, exactly as before this change.
  assertEquals(r.trace.gateway.map((g) => g.customer_vault), ["add_customer"]);
  assertEquals(r.status, 402, JSON.stringify(r.body));
  assertEquals(r.body, { error: "Payment gateway error: Harness decline - nothing was charged" });
});

Deno.test("annual is allowed: a card on file reaches the confirm-amount check, which still guards the charge", async () => {
  const r = await drive(subscribe(["crm_annual"], { confirmChargeCents: 1 }), {
    vault: "harness-vault",
    subs: [{ id: "sub-base", plan_id: "simple_layout_annual", status: "active", price_cents: price("simple_layout_annual"), created_at: new Date().toISOString() }],
  });
  assertEquals(r.status, 400, JSON.stringify(r.body));
  assertEquals(r.body.dueTodayCents, price("crm_annual"));
  assertEquals(r.trace.gateway, []);
});

Deno.test("annual is allowed: a comped (billing_exempt, not internal) tenant is handled as before", async () => {
  const r = await drive(subscribe(["simple_layout_annual"], { paymentToken: "harness-token" }), {
    vault: null, gateway: "decline", settings: { billing_exempt: true, internal_account: false, discount_percent: 0 },
  });
  assertEquals(r.trace.gateway.map((g) => g.customer_vault), ["add_customer"]);
  assertEquals(r.status, 402, JSON.stringify(r.body));
});

Deno.test("monthly is refused for every pricing group the browser also refuses: comped, Free-until and discounted", async () => {
  // The browser rule has no exception for any of these (setInterval_ refuses monthly before it
  // looks at who is buying), so the server must not grow one either.
  const future = new Date(Date.now() + 60 * 86400000).toISOString();
  for (const settings of [
    { billing_exempt: true, internal_account: false, discount_percent: 0 },
    { billing_exempt: false, billing_exempt_until: future, internal_account: false, discount_percent: 0 },
    { billing_exempt: false, internal_account: false, discount_percent: 25 },
  ]) {
    const r = await drive(subscribe(["simple_layout_monthly"], { paymentToken: "harness-token" }), { vault: null, settings });
    assertRefusedUntouched(r, ["simple_layout_monthly"]);
  }
});

Deno.test("our own internal account still gets its existing 409 first, monthly or annual", async () => {
  const internal = { settings: { billing_exempt: true, internal_account: true, discount_percent: 0 }, vault: "harness-vault", tenant: "harness-internal" };
  for (const ids of [["simple_layout_monthly"], ["simple_layout_annual"]]) {
    const r = await drive(subscribe(ids), internal);
    assertEquals(r.status, 409, JSON.stringify(r.body));
    assertEquals(r.body, { error: "This is CSM Synergy's own account. Nothing can be bought on it." }, `for ${ids}`);
    assertEquals(r.trace.gateway, []);
    assertEquals(r.trace.writes, []);
  }
});

Deno.test("cancelling a monthly subscription still reaches the gateway and ends it", async () => {
  const sub = { id: "sub-monthly", plan_id: "crm_monthly", status: "active", price_cents: price("crm_monthly"), created_at: new Date().toISOString() };
  const r = await drive({ action: "cancel", subscriptionId: "sub-monthly" }, { vault: "harness-vault", subs: [sub], gateway: "ok" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.trace.gateway.map((g) => [g.recurring, g.subscription_id]), [["delete_subscription", "sub-monthly"]]);
  assertEquals(r.body.subscription.status, "cancelled");
});

// A monthly subscription that predates founding pricing keeps renewing (see the header), and its
// stored current_period_end stays on the FIRST renewal date for good: only checkout writes it.
// `status` sends the rolled-forward date as paid_through, which is what the Billing tab prints as
// "renews"; the stored one would read as a renewal that already happened.
Deno.test("status: a monthly subscription past its first renewal reports the NEXT renewal as paid_through", async () => {
  const day = 86400000;
  const stored = new Date(Date.now() - 40 * day).toISOString();
  const sub = { id: "sub-old-monthly", plan_id: "crm_monthly", status: "active", price_cents: price("crm_monthly"), current_period_start: new Date(Date.now() - 70 * day).toISOString(), current_period_end: stored, canceled_at: null, created_at: new Date(Date.now() - 70 * day).toISOString() };
  const r = await drive({ action: "status" }, { vault: "harness-vault", subs: [sub] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const got = r.body.subscriptions.find((s: any) => s.id === "sub-old-monthly");
  assertEquals(got.current_period_end, stored, "the stored column is passed through untouched");
  assertEquals(got.paid_through, new Date(paidThroughOf(sub, "monthly")).toISOString());
  assert(Date.parse(got.paid_through) > Date.now(), `paid_through ${got.paid_through} is not in the future`);
  assert(Date.parse(got.paid_through) < Date.now() + 32 * day, `paid_through ${got.paid_through} is more than one month out`);
});

// ─── The wiring, read from the shipped source ─────────────────────────────────────────────────
function codeBetween(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`foundingAnnualOnly_test: could not find ${what} (start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`);
  }
  return src.slice(i, j).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
}

Deno.test("wiring: the refusal is in subscribe only, after the internal 409 and ahead of the vault, the amount check, the strict audit and the gateway", () => {
  const calls = [...SOURCE.matchAll(/monthlyPlansRefused\(/g)].length;
  assertEquals(calls, 1, "portal-billing calls monthlyPlansRefused exactly once");
  const branch = codeBetween(SOURCE, 'if (action === "subscribe") {', '  if (action === "topup") {', "the subscribe branch");
  const at = (needle: string) => {
    const i = branch.indexOf(needle);
    assert(i >= 0, `the subscribe branch no longer contains ${JSON.stringify(needle)}`);
    return i;
  };
  const refusal = at("monthlyPlansRefused(");
  assert(at("if (internal) {") < refusal, "the internal-account 409 must answer first");
  for (const later of ["let vault = vaultId;", "customer_vault: \"add_customer\"", "confirmChargeCents", "auditStrict(", "nmiPost(", "billing_charge_attempts"]) {
    assert(refusal < at(later), `the founding refusal must come before ${later}`);
  }
  // Every other action is untouched: top-ups, auto top-up settings, cancel and status.
  const rest = SOURCE.slice(SOURCE.indexOf('  if (action === "topup") {'));
  assert(!rest.includes("monthlyPlansRefused") && !rest.includes("FOUNDING_ANNUAL_ONLY"), "the refusal leaked into top-up or cancel");
});

Deno.test("wiring: renewals are the gateway's — billing-webhook never consults founding pricing", () => {
  // A renewal of an EXISTING subscription arrives as a webhook the gateway sends after it has
  // already billed. Refusing to mirror it would only make our records lie about the card.
  assert(!/foundingPricing|FOUNDING_ANNUAL_ONLY|monthlyPlansRefused/.test(WEBHOOK), "billing-webhook must not refuse a renewal");
});
