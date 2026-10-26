// Every NMI (Deposyt) card-on-file path, driven through the SHIPPED portal-billing handler (317).
//
// WHY THIS EXISTS. Until migration 317 every sale StructureStudio ran on a card it keeps went out
// with no stored-credential data: no initiated_by, no stored_credential_indicator, no
// billing_method, no initial_transaction_id. Cards were vaulted before any approved charge, and
// nothing recorded what the builder agreed to. The Visa/Mastercard framework wants each charge on
// a stored card to say who started it and which agreement it belongs to, linked to the approved
// first transaction of that agreement, and the agreement itself on record. Each of those is
// pinned here, path by path, from what actually reaches the gateway:
//
//   subscribe   new card: ONE call stores and charges (sale + customer_vault=add_customer), as
//               the initial recurring CIT; a decline stores nothing. Card on file: the same
//               flags on the vault. Every subscription keeps its own initial. A processor that
//               refuses billing_method=initial_recurring gets one retry with 'recurring'; a card
//               decline never retries. A fully credited upgrade runs a $0 validate as its initial.
//               No box ticked, nothing touched. Operators must say the builder is on the phone.
//   topup       first top-up (new card, or a card a subscription saved): customer + stored, kept
//               as the vault's unscheduled initial, agreement required. Later: customer + used +
//               that initial. Operators: on the phone = customer + used; not = merchant + used +
//               the initial (refused without one), and the owners are sent a receipt.
//   topup_settings  switching on needs the builder (never an operator), their own first top-up
//               and the ticked sentence, which is recorded before the setting.
//   update_card a $0 validate that replaces the vaulted card and becomes the new initial.
//   no 317      against a database without 317's columns no card action runs at all.
//   older tab   until COF_REQUIRE_CONSENT=1, a request with neither `consent` nor
//               `cardholderPresent` (only the pre-317 Billing tab sends that) is served with the
//               right COF fields and no agreement row, and filed as an info row. Never for
//               switching automatic top-ups on.
//
// HOW. foundingAnnualOnly_test's idiom: Deno.serve is stubbed while portal-billing is imported,
// supabase-js is the stub (import map), every table op lands in the fake below, fetch is the
// payment gateway and nothing else, and no --allow-net is granted, so no card can be charged
// from here. Tenants, users, tokens and prices are made up: the repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";
import { AUTO_TOPUP_DAILY_MAX, COF_CONSENT_TEMPLATES, COF_CONSENT_VERSION, renderCofConsent } from "../cofConsent.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SOURCE = await read("../../portal-billing/index.ts");
const TOPUP_SRC = await read("../walletTopup.ts");

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
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
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

// ─── Catalogue. The Suite is priced BELOW its base member so a recent base buys it outright ─────
const PLANS = [
  { id: "simple_layout_annual", feature: "simple_layout", name: "Base", billing_interval: "annual", price_cents: 200000, required: true },
  { id: "crm_annual", feature: "crm", name: "CRM", billing_interval: "annual", price_cents: 150000, required: false },
  { id: "full_suite_annual", feature: "full_suite", name: "Suite", billing_interval: "annual", price_cents: 100000, required: false },
  { id: "view_3d_annual", feature: "view_3d", name: "3D", billing_interval: "annual", price_cents: 50000, required: false },
].map((p, i) => ({
  ...p, gateway_plan_id: `HARNESS_${p.id.toUpperCase()}`, setup_fee_cents: 0, availability: "available",
  sort_order: 100 - i, price_visible: true, active: true, operator_grantable: false,
}));
const price = (id: string) => PLANS.find((p) => p.id === id)!.price_cents;

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
type Vault = { vault_id: string; unscheduled_initial_txn?: string | null; card_last4?: string | null; card_brand?: string | null };
type World = {
  vault?: Vault | null;
  subs?: Record<string, unknown>[];
  wallet?: Record<string, unknown> | null;
  operator?: boolean;
  /** billing_customers has no 317 columns: the full select is refused with 42703. */
  pre317?: boolean;
  /** How the gateway answers one request. Unset = approve everything. */
  gateway?: (p: Record<string, string>) => string | "unknown";
  /** COF_REQUIRE_CONSENT=1: the transition for the older Billing tab is over. */
  strict?: boolean;
  /** billing_consents rows already on file (what a select there answers). */
  consents?: Record<string, unknown>[];
  /** wallet_credit fails after an approved sale (charged, not credited). */
  creditFails?: boolean;
};
type Trace = {
  seq: string[];                                // gateway calls and db writes, in order
  gateway: Record<string, string>[];
  writes: any[][];
  consents: Record<string, unknown>[];
  customers: { op: string; row: Record<string, unknown> }[];
  attempts: { op: string; row: Record<string, unknown> }[];
  subRows: Record<string, unknown>[];
  wallet: Record<string, unknown>[];
  errors: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  rpcs: { fn: string; args: Record<string, unknown> }[];
};

const USER_ID = "00000000-0000-4000-8000-00000000c0f1";
const OPERATOR_ID = "00000000-0000-4000-8000-00000000c0f0";
const TENANT = "harness-cof-builder";
const WRITES = new Set(["insert", "upsert", "update", "delete"]);

function answer(world: World, trace: Trace, table: string, ops: any[][]): any {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
  const one = (row: unknown) => ({ data: row ?? null, error: null });
  switch (table) {
    case "client_users":
      if (ops.some((o) => o[0] === "eq" && o[1] === "role")) return { data: [{ user_id: USER_ID, role: "owner" }], error: null };
      return { data: world.operator ? [] : [{ client_id: TENANT, role: "owner", title: null, access: null }], error: null };
    case "app_operators":
      return one(world.operator ? { user_id: OPERATOR_ID, email: "operator@example.test", can_write: true, can_bill: true, support_only: false } : null);
    case "client_configs":
      return one({ client_id: TENANT });
    case "billing_plans":
      return { data: PLANS.map((p) => ({ ...p })), error: null };
    case "billing_subscriptions":
      if (has("upsert")) {
        trace.subRows.push(arg("upsert"));
        return one({ ...arg("upsert") });
      }
      if (has("update")) return one({});
      return { data: (world.subs ?? []).map((s) => ({ ...s })), error: null };
    case "billing_customers": {
      if (has("upsert") || has("update")) {
        trace.customers.push({ op: has("upsert") ? "upsert" : "update", row: arg(has("upsert") ? "upsert" : "update") });
        return { data: null, error: null };
      }
      const cols = String(arg("select") ?? "");
      if (world.pre317 && cols.includes("unscheduled_initial_txn")) return { data: null, error: { code: "42703", message: "column does not exist" } };
      return one(world.vault ?? null);
    }
    case "client_settings":
      return one({ billing_exempt: false, internal_account: false, discount_percent: 0 });
    case "client_feature_grants":
      return { data: [], error: null };
    case "admin_audit":
      trace.audit.push(arg("insert"));
      return { data: null, error: null };
    case "app_errors":
      trace.errors.push(arg("insert"));
      return { data: null, error: null };
    case "billing_consents":
      if (has("insert")) {
        trace.consents.push({ ...arg("insert") });
        return one({ id: 9000 + trace.consents.length });
      }
      if (has("update")) {
        const id = (ops.find((o) => o[0] === "eq" && o[1] === "id") ?? [])[2];
        const row = trace.consents[Number(id) - 9001];
        if (row) Object.assign(row, arg("update"));
        return { data: null, error: null };
      }
      return { data: (world.consents ?? []).map((c) => ({ ...c })), error: null };
    case "billing_charge_attempts":
      if (has("insert")) {
        trace.attempts.push({ op: "insert", row: arg("insert") });
        return one({ id: 700 + trace.attempts.length });
      }
      if (has("update")) {
        trace.attempts.push({ op: "update", row: arg("update") });
        return { data: null, error: null };
      }
      return { data: [], error: null };
    case "wallet_accounts":
      if (has("upsert") || has("update")) {
        trace.wallet.push(arg(has("upsert") ? "upsert" : "update"));
        return { data: null, error: null };
      }
      return one(world.wallet ?? { balance_cents: 0, held_cents: 0, auto_topup_enabled: false });
    case "usage_prices":
    case "wallet_transactions":
      return { data: [], error: null };
    case "billing_upgrade_credits":
      return { data: null, error: null };
  }
  throw new Error(`the fake database has no answer for ${table} ${JSON.stringify(ops)}`);
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "or", "limit", "order", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    if (ops.some((o) => WRITES.has(o[0]))) {
      trace.writes.push([table, ...ops]);
      trace.seq.push(`db:${table}:${ops.find((o) => WRITES.has(o[0]))![0]}`);
    }
    return Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  };
  return q;
}

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

/** Approve everything; a stored card answers with a vault id, a registration with a subscription id. */
function approve(p: Record<string, string>, n: number): string {
  const out = new URLSearchParams({ response: "1", responsetext: "SUCCESS", transactionid: `T${n}`, cof_supported: "stored" });
  if (p.customer_vault === "add_customer") out.set("customer_vault_id", "V-NEW");
  if (p.recurring === "add_subscription") out.set("subscription_id", `S${n}`);
  return out.toString();
}

async function drive(payload: Record<string, unknown>, world: World = {}) {
  const trace: Trace = { seq: [], gateway: [], writes: [], consents: [], customers: [], attempts: [], subRows: [], wallet: [], errors: [], audit: [], rpcs: [] };
  const env = { ...ENV, COF_REQUIRE_CONSENT: world.strict ? "1" : "" };
  const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  stubAuth.user = world.operator ? { id: OPERATOR_ID, email: "operator@example.test" } : { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  stubRpc.rpc = (fn: string, args: any) => {
    trace.rpcs.push({ fn, args });
    if (world.creditFails && fn === "wallet_credit") return Promise.resolve({ data: null, error: { message: "credit down" } });
    return Promise.resolve({ data: 123456, error: null });
  };
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: () => new AbortController().signal });
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${GATEWAY}/`)) throw new Error(`unexpected fetch: ${url}`);
    const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    delete params.security_key;
    trace.gateway.push(params);
    trace.seq.push(`gw:${params.type ?? params.recurring ?? params.customer_vault}`);
    const body = world.gateway ? world.gateway(params) : approve(params, trace.gateway.length);
    if (body === "unknown") return Promise.reject(new Error("connection reset"));
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/portal-billing", {
      method: "POST",
      headers: { "authorization": "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(world.operator ? { ...payload, targetClientId: TENANT } : payload),
    }));
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, trace };
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: realTimeout });
    stubDb.from = null;
    stubRpc.rpc = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const CONSENT = { consent: { version: COF_CONSENT_VERSION, accepted: true } };
const CARD = { card: { last4: "4242", brand: "Visa" } };
const COF_KEYS = ["initiated_by", "stored_credential_indicator", "billing_method", "initial_transaction_id"];
const cofOf = (g: Record<string, string>) => Object.fromEntries(COF_KEYS.filter((k) => k in g).map((k) => [k, g[k]]));
const INITIAL_RECURRING = { initiated_by: "customer", stored_credential_indicator: "stored", billing_method: "initial_recurring" };
// The same initial on a request that carries a single-use Collect.js token: 'recurring', because
// a refused 'initial_recurring' could not be retried with a token already sent (nmi.ts).
const INITIAL_RECURRING_TOKEN = { ...INITIAL_RECURRING, billing_method: "recurring" };
const TAB = { cofTab: COF_CONSENT_VERSION };
const ON_FILE: Vault = { vault_id: "V-OLD", unscheduled_initial_txn: null, card_last4: "1881", card_brand: "visa" };
const subscribe = (planIds: string[], extra: Record<string, unknown> = {}) =>
  ({ action: "subscribe", planIds, confirmChargeCents: planIds.reduce((s, id) => s + price(id), 0), ...extra });
const topup = (cents: number, extra: Record<string, unknown> = {}) => ({ action: "topup", amountCents: cents, confirmChargeCents: cents, ...extra });
const sales = (t: Trace) => t.gateway.filter((g) => g.type === "sale" || g.type === "validate");
const nothingTouched = (t: Trace) => {
  assertEquals(t.gateway, [], "the gateway was called");
  assertEquals(t.writes.filter((w) => w[0] !== "admin_audit"), [], "something was written");
};

// ════ SUBSCRIBE ═══════════════════════════════════════════════════════════════════════════════

Deno.test("subscribe, new card: one call stores AND charges, flagged as the initial recurring CIT, per subscription", async () => {
  const r = await drive(subscribe(["simple_layout_annual", "crm_annual"], { paymentToken: "tok-1", ...CONSENT, ...CARD }), { vault: null });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const s = sales(r.trace);
  assertEquals(s.length, 2, "one initial per subscription");
  // The first sale carries the card: NMI stores it only if the sale is approved.
  assertEquals([s[0].type, s[0].customer_vault, s[0].payment_token, s[0].customer_vault_id], ["sale", "add_customer", "tok-1", undefined]);
  assertEquals(s[0].amount, (price("simple_layout_annual") / 100).toFixed(2));
  assertEquals(cofOf(s[0]), INITIAL_RECURRING_TOKEN);
  // The second runs on the vault the first created, and is ITS subscription's own initial.
  assertEquals([s[1].customer_vault, s[1].customer_vault_id], [undefined, "V-NEW"]);
  assertEquals(cofOf(s[1]), INITIAL_RECURRING);
  // Registrations carry no COF fields (NMI's Recurring module flags renewals itself).
  const regs = r.trace.gateway.filter((g) => g.recurring === "add_subscription");
  assertEquals(regs.length, 2);
  for (const g of regs) {
    assertEquals(cofOf(g), {}, "add_subscription takes no COF fields");
    assertEquals(g.customer_vault_id, "V-NEW");
    assert(!("source_transaction_id" in g), "source_transaction_id stays dark without NMI_SUB_SOURCE_TXN");
  }
  // Each subscription keeps its own initial, marked as sent flagged.
  assertEquals(r.trace.subRows.map((x) => [x.plan_id, x.initial_transaction_id, x.initial_cof_flagged]),
    [["simple_layout_annual", s[0] && "T1", true], ["crm_annual", "T3", true]]);
  // The card is recorded once, with the vault the gateway returned and the last 4 from Collect.js.
  assertEquals(r.trace.customers.length, 1);
  assertEquals([r.trace.customers[0].row.vault_id, r.trace.customers[0].row.card_last4, r.trace.customers[0].row.card_brand], ["V-NEW", "4242", "visa"]);
  // Attempts are filed as initial recurring CITs, with what the processor said.
  assert(r.trace.attempts.filter((a) => a.op === "insert").every((a) => a.row.cof === "cit_initial_recurring"));
  assert(r.trace.attempts.some((a) => a.op === "update" && a.row.state === "closed_ok" && a.row.cof_supported === "stored" && a.row.billing_method === "recurring"));
  assert(r.trace.attempts.some((a) => a.op === "update" && a.row.state === "closed_ok" && a.row.billing_method === "initial_recurring"));
});

Deno.test("subscribe: the agreement is recorded BEFORE the first gateway call, in the server's own words", async () => {
  const r = await drive(subscribe(["simple_layout_annual", "crm_annual"], { paymentToken: "tok-1", ...CONSENT, ...CARD }), { vault: null });
  const firstGw = r.trace.seq.findIndex((x) => x.startsWith("gw:"));
  const consentAt = r.trace.seq.indexOf("db:billing_consents:insert");
  assert(consentAt >= 0 && consentAt < firstGw, r.trace.seq.join(" > "));
  assertEquals(r.trace.consents.length, 1);
  const c = r.trace.consents[0];
  assertEquals([c.kind, c.wording_version, c.client_id, c.user_id, c.user_email, c.card_last4, c.ip], ["subscription_card", COF_CONSENT_VERSION, TENANT, USER_ID, "owner@example.test", "4242", "203.0.113.9"]);
  assertEquals(c.wording, "I agree that CSM Synergy may keep this card on file, charge $3,500 today, and charge $3,500 a year automatically at each renewal until I cancel. I can cancel any feature in Billing, and it stays on until the end of the period I have paid for.");
  assertEquals((c.terms as any).due_today_cents, 350000);
  // Stamped with the first approved initial once it exists.
  assertEquals(c.transaction_id, "T1");
});

Deno.test("subscribe, new card DECLINED: nothing is stored, the rest of the cart is not charged", async () => {
  const r = await drive(subscribe(["simple_layout_annual", "crm_annual"], { paymentToken: "tok-1", ...CONSENT, ...CARD }), {
    vault: null, gateway: () => "response=2&responsetext=Harness+decline&response_code=200",
  });
  assertEquals(r.status, 402, JSON.stringify(r.body));
  assertEquals(sales(r.trace).length, 1, "one sale tried; the card was not saved, so nothing else can be charged");
  assertEquals(r.trace.customers, [], "a declined card is not stored");
  assertEquals(r.trace.subRows, []);
  assert(String(r.body.error).includes("Skipped"), JSON.stringify(r.body));
});

Deno.test("subscribe, new card declined with the base already live: the add-ons after it are skipped, not charged", async () => {
  // Odd on purpose (a live base and no card on file), so the base-failed skip cannot be what stops them.
  const live = { id: "S-BASE", plan_id: "simple_layout_annual", status: "active", price_cents: 200000, current_period_start: new Date(Date.now() - 300 * 864e5).toISOString(), current_period_end: new Date(Date.now() + 65 * 864e5).toISOString(), created_at: new Date(Date.now() - 300 * 864e5).toISOString() };
  const r = await drive({ action: "subscribe", planIds: ["crm_annual"], confirmChargeCents: price("crm_annual"), paymentToken: "tok-1", ...CONSENT }, {
    vault: null, subs: [live], gateway: () => "response=2&responsetext=Harness+decline&response_code=200",
  });
  assertEquals(r.status, 402, JSON.stringify(r.body));
  assertEquals(sales(r.trace).length, 1);
  assertEquals(r.trace.customers, []);
});

Deno.test("subscribe, card on file: the initial recurring CIT runs on the vault and names the stored card", async () => {
  const base = { id: "S-BASE", plan_id: "simple_layout_annual", status: "active", price_cents: 200000, current_period_start: new Date(Date.now() - 200 * 864e5).toISOString(), current_period_end: new Date(Date.now() + 165 * 864e5).toISOString(), created_at: new Date(Date.now() - 200 * 864e5).toISOString() };
  const r = await drive(subscribe(["crm_annual"], CONSENT), { vault: ON_FILE, subs: [base] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const s = sales(r.trace);
  assertEquals([s.length, s[0].customer_vault_id, s[0].customer_vault, s[0].payment_token], [1, "V-OLD", undefined, undefined]);
  assertEquals(cofOf(s[0]), INITIAL_RECURRING);
  assertEquals(r.trace.customers, [], "the stored card is not re-recorded");
  assert(String(r.trace.consents[0].wording).includes("keep my card ending 1881 on file, charge $1,500 today"), String(r.trace.consents[0].wording));
});

Deno.test("subscribe: an unticked box, an old version of the sentence, or (once strict) no box at all touches nothing", async () => {
  const unticked = await drive(subscribe(["simple_layout_annual"], { paymentToken: "tok-1", consent: { version: COF_CONSENT_VERSION, accepted: false } }), { vault: null });
  assertEquals([unticked.status, unticked.body.code], [400, "consent_required"]);
  nothingTouched(unticked.trace);
  const none = await drive(subscribe(["simple_layout_annual"], { paymentToken: "tok-1" }), { vault: null, strict: true });
  assertEquals([none.status, none.body.code], [400, "consent_required"]);
  nothingTouched(none.trace);
  const stale = await drive(subscribe(["simple_layout_annual"], { paymentToken: "tok-1", consent: { version: "2020-01-01", accepted: true } }), { vault: null });
  assertEquals([stale.status, stale.body.code], [400, "consent_required"]);
  assert(String(stale.body.error).includes("changed"), JSON.stringify(stale.body));
  nothingTouched(stale.trace);
});

const BASE_LIVE = { id: "S-BASE", plan_id: "simple_layout_annual", status: "active", price_cents: 200000, current_period_start: new Date(Date.now() - 200 * 864e5).toISOString(), current_period_end: new Date(Date.now() + 165 * 864e5).toISOString(), created_at: new Date(Date.now() - 200 * 864e5).toISOString() };
const refuseInitialRecurring = (code: string) => (p: Record<string, string>) => p.billing_method === "initial_recurring"
  ? `response=3&responsetext=Invalid+billing_method&response_code=${code}`
  : approve(p, 5);

Deno.test("subscribe, card on file: a processor that refuses initial_recurring as a FIELD gets ONE retry with 'recurring', and it is filed", async () => {
  const r = await drive(subscribe(["crm_annual"], CONSENT), { vault: ON_FILE, subs: [BASE_LIVE], gateway: refuseInitialRecurring("300") });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const s = sales(r.trace);
  assertEquals(s.map((g) => g.billing_method), ["initial_recurring", "recurring"]);
  assertEquals(cofOf(s[1]), INITIAL_RECURRING_TOKEN);
  assert(r.trace.attempts.some((a) => a.op === "update" && a.row.state === "closed_ok" && a.row.billing_method === "recurring"));
  assertEquals(r.trace.errors.map((e) => e.code), ["nmi_initial_recurring_fallback"]);
});

Deno.test("subscribe, NEW card: the one-use token is never sent twice; it goes as 'recurring' in one call", async () => {
  const r = await drive(subscribe(["simple_layout_annual"], { paymentToken: "tok-1", ...CONSENT }), { vault: null, gateway: refuseInitialRecurring("300") });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const withToken = r.trace.gateway.filter((g) => g.payment_token);
  assertEquals(withToken.length, 1, "the token went out exactly once");
  assertEquals(withToken[0].billing_method, "recurring");
});

Deno.test("subscribe: a response-3 that is NOT a field refusal (an issuer communication error) is never retried", async () => {
  const r = await drive(subscribe(["crm_annual"], CONSENT), { vault: ON_FILE, subs: [BASE_LIVE], gateway: () => "response=3&responsetext=Communication+error+with+issuer&response_code=421" });
  assertEquals(r.status, 402, JSON.stringify(r.body));
  assertEquals(sales(r.trace).length, 1, "a second authorization could reach the issuer");
});

Deno.test("subscribe: when the 'recurring' retry fails too, the refusal is still filed for ops", async () => {
  const r = await drive(subscribe(["crm_annual"], CONSENT), {
    vault: ON_FILE, subs: [BASE_LIVE],
    gateway: (p) => p.billing_method === "initial_recurring"
      ? "response=3&responsetext=Invalid+billing_method&response_code=300"
      : "response=2&responsetext=DECLINE&response_code=200",
  });
  assertEquals(r.status, 402);
  assertEquals(sales(r.trace).length, 2);
  assert(r.trace.errors.some((e) => e.code === "nmi_initial_recurring_fallback"), JSON.stringify(r.trace.errors));
});

Deno.test("subscribe: a card DECLINE (response 2) is never retried", async () => {
  const r = await drive(subscribe(["simple_layout_annual"], { paymentToken: "tok-1", ...CONSENT }), {
    vault: null, gateway: () => "response=2&responsetext=DECLINE&response_code=200",
  });
  assertEquals(r.status, 402);
  assertEquals(sales(r.trace).length, 1);
});

Deno.test("subscribe: a fully credited upgrade runs a $0 VALIDATE as the subscription's initial, charging nothing", async () => {
  const start = new Date(Date.now() - 864e5).toISOString();
  const base = { id: "S-BASE", plan_id: "simple_layout_annual", status: "active", price_cents: 200000, current_period_start: start, current_period_end: new Date(Date.now() + 364 * 864e5).toISOString(), created_at: start };
  const r = await drive({ action: "subscribe", planIds: ["full_suite_annual"], confirmChargeCents: 0, ...CONSENT }, { vault: ON_FILE, subs: [base] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const s = sales(r.trace);
  assertEquals(s.length, 1);
  assertEquals([s[0].type, s[0].amount, s[0].customer_vault_id], ["validate", undefined, "V-OLD"]);
  assertEquals(cofOf(s[0]), INITIAL_RECURRING);
  assertEquals(r.trace.subRows[0].initial_transaction_id, "T1");
  assert(!r.trace.gateway.some((g) => g.type === "void" || g.type === "refund"), "nothing to reverse");
  assert(String(r.trace.consents[0].wording).includes("charge nothing today"), String(r.trace.consents[0].wording));
});

Deno.test("subscribe, operator: must say the builder is on the phone; without them it is refused, with them it is a phone CIT", async () => {
  const world = { operator: true, vault: ON_FILE };
  const silent = await drive(subscribe(["simple_layout_annual"]), { ...world, strict: true });
  assertEquals([silent.status, silent.body.code], [400, "cardholder_present_required"]);
  assertEquals(silent.trace.gateway, []);
  const absent = await drive(subscribe(["simple_layout_annual"], { cardholderPresent: false }), world);
  assertEquals(absent.status, 409, JSON.stringify(absent.body));
  assertEquals(absent.trace.gateway, []);
  const unread = await drive(subscribe(["simple_layout_annual"], { cardholderPresent: true, ...TAB }), world);
  assertEquals([unread.status, unread.body.code], [400, "consent_required"], "on the phone, but the sentence was not read out and agreed");
  assertEquals(unread.trace.gateway, []);
  const onPhone = await drive(subscribe(["simple_layout_annual"], { cardholderPresent: true, ...TAB, ...CONSENT }), world);
  assertEquals(onPhone.status, 200, JSON.stringify(onPhone.body));
  assertEquals(cofOf(sales(onPhone.trace)[0]), INITIAL_RECURRING);
  const c = onPhone.trace.consents[0];
  assertEquals([(c.terms as any).attested_by, (c.terms as any).via, (c.terms as any).read_to_owner, c.user_email], ["operator", "phone", true, "operator@example.test"]);
});

// ════ TOP-UP ══════════════════════════════════════════════════════════════════════════════════

Deno.test("top-up, new card: one sale stores the card (customer + stored, NO billing_method) and becomes its unscheduled initial", async () => {
  const r = await drive(topup(5000, { paymentToken: "tok-2", ...CONSENT, ...CARD }), { vault: null });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const s = sales(r.trace);
  assertEquals(s.length, 1);
  assertEquals([s[0].customer_vault, s[0].payment_token, s[0].customer_vault_id], ["add_customer", "tok-2", undefined]);
  assertEquals(cofOf(s[0]), { initiated_by: "customer", stored_credential_indicator: "stored" });
  const cust = r.trace.customers[0]?.row ?? {};
  assertEquals([cust.vault_id, cust.unscheduled_initial_txn, cust.card_last4], ["V-NEW", "T1", "4242"]);
  assertEquals(r.trace.rpcs.map((x) => x.fn), ["wallet_credit"]);
  const c = r.trace.consents[0];
  assertEquals(c.kind, "topup_card");
  assertEquals(c.wording, renderCofConsent(COF_CONSENT_TEMPLATES.topup, { card: "this card", amount: "$50" }));
  assert(String(c.wording).includes("when CSM Synergy adds funds to my wallet for me"), "the sentence discloses operator top-ups");
  assertEquals(c.transaction_id, "T1");
});

Deno.test("top-up: the FIRST one on a card a subscription saved needs the box, and starts the top-up agreement", async () => {
  const none = await drive(topup(5000, { consent: { version: COF_CONSENT_VERSION, accepted: false } }), { vault: ON_FILE });
  assertEquals([none.status, none.body.code], [400, "consent_required"]);
  nothingTouched(none.trace);
  const r = await drive(topup(5000, CONSENT), { vault: ON_FILE });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const s = sales(r.trace)[0];
  assertEquals([s.customer_vault_id, s.customer_vault], ["V-OLD", undefined]);
  assertEquals(cofOf(s), { initiated_by: "customer", stored_credential_indicator: "stored" });
  assertEquals(r.trace.customers[0].row.unscheduled_initial_txn, "T1");
  assert(String(r.trace.consents[0].wording).includes("keep my card ending 1881 on file"), String(r.trace.consents[0].wording));
});

Deno.test("top-up, later: customer + used + the unscheduled initial, no box needed, no agreement row", async () => {
  const r = await drive(topup(5000, TAB), { vault: { ...ON_FILE, unscheduled_initial_txn: "INIT-U" }, consents: OWNER_AGREED("INIT-U") });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(cofOf(sales(r.trace)[0]), { initiated_by: "customer", stored_credential_indicator: "used", initial_transaction_id: "INIT-U" });
  assertEquals(r.trace.consents, []);
  assertEquals(r.trace.customers, [], "the initial is not replaced by a later top-up");
});

Deno.test("top-up, operator: must say; on the phone is a CIT; not on the phone is an MIT naming the initial, with a receipt", async () => {
  const world = { operator: true, vault: { ...ON_FILE, unscheduled_initial_txn: "INIT-U" }, consents: [{ kind: "topup_card", wording_version: COF_CONSENT_VERSION, transaction_id: "INIT-U" }] };
  const silent = await drive(topup(5000), { ...world, strict: true });
  assertEquals([silent.status, silent.body.code], [400, "cardholder_present_required"]);
  assertEquals(silent.trace.gateway, []);

  const phone = await drive(topup(5000, { cardholderPresent: true }), world);
  assertEquals(phone.status, 200, JSON.stringify(phone.body));
  assertEquals(cofOf(sales(phone.trace)[0]), { initiated_by: "customer", stored_credential_indicator: "used", initial_transaction_id: "INIT-U" });
  // Every operator top-up is one the owner did not make themselves: the agreement promises a receipt.
  assert(phone.trace.attempts.some((a) => a.op === "update" && a.row.receipt_error === "platform email is not configured"), "a receipt is attempted for the phone top-up too");

  const mit = await drive(topup(5000, { cardholderPresent: false }), world);
  assertEquals(mit.status, 200, JSON.stringify(mit.body));
  assertEquals(cofOf(sales(mit.trace)[0]), { initiated_by: "merchant", stored_credential_indicator: "used", initial_transaction_id: "INIT-U" });
  assert(mit.trace.attempts.some((a) => a.op === "insert" && a.row.cof === "mit_unscheduled"));
  // The receipt is attempted and its outcome recorded on the attempt (no mail provider here).
  assert(mit.trace.attempts.some((a) => a.op === "update" && a.row.receipt_error === "platform email is not configured"), JSON.stringify(mit.trace.attempts));
  assert(mit.trace.audit.map((a) => String(a.note)).join(" ").includes("cof=mit_unscheduled"), JSON.stringify(mit.trace.audit));
});

Deno.test("top-up, operator, builder not asking and NO initial: refused, nothing charged", async () => {
  const r = await drive(topup(5000, { cardholderPresent: false }), { operator: true, vault: ON_FILE });
  assertEquals([r.status, r.body.code], [409, "needs_first_topup"]);
  assertEquals(r.trace.gateway, []);
});

// ════ AUTOMATIC TOP-UP SETTINGS ═══════════════════════════════════════════════════════════════

const autoOn = (extra: Record<string, unknown> = {}) => ({ action: "topup_settings", enabled: true, thresholdCents: 10000, amountCents: 25000, ...extra });

Deno.test("auto top-up ON: needs the builder's own first top-up first", async () => {
  const r = await drive(autoOn(CONSENT), { vault: ON_FILE });
  assertEquals([r.status, r.body.code], [409, "needs_first_topup"]);
  assertEquals(r.trace.writes.filter((w) => w[0] !== "admin_audit"), []);
});

Deno.test("auto top-up ON: needs the ticked sentence, which is recorded BEFORE the setting, naming card, amounts and cap", async () => {
  const vault = { ...ON_FILE, unscheduled_initial_txn: "INIT-U" };
  const none = await drive(autoOn(), { vault });
  assertEquals([none.status, none.body.code], [400, "consent_required"]);
  assertEquals(none.trace.wallet, []);

  const r = await drive(autoOn(CONSENT), { vault });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assert(r.trace.seq.indexOf("db:billing_consents:insert") < r.trace.seq.indexOf("db:wallet_accounts:upsert"), r.trace.seq.join(" > "));
  const c = r.trace.consents[0];
  assertEquals(c.kind, "auto_topup");
  assertEquals(c.wording, `I agree that CSM Synergy may charge my card ending 1881 $250 whenever my available wallet balance falls below $100, at most once an hour and no more than ${AUTO_TOPUP_DAILY_MAX} times in 24 hours. I will get an email receipt for each charge, and I can change or turn off automatic top-ups at any time in Billing.`);
  assertEquals((c.terms as any).initial_transaction_id, "INIT-U");
  assertEquals([r.trace.wallet[0].auto_topup_enabled, r.trace.wallet[0].auto_topup_consent_id], [true, 9001]);
});

Deno.test("auto top-up: an operator cannot switch it on, but can switch it off (which clears the agreement)", async () => {
  const vault = { ...ON_FILE, unscheduled_initial_txn: "INIT-U" };
  const on = await drive(autoOn(CONSENT), { operator: true, vault });
  assertEquals(on.status, 403, JSON.stringify(on.body));
  assertEquals(on.trace.wallet, []);
  const off = await drive({ action: "topup_settings", enabled: false }, { operator: true, vault });
  assertEquals(off.status, 200, JSON.stringify(off.body));
  assertEquals([off.trace.wallet[0].auto_topup_enabled, off.trace.wallet[0].auto_topup_consent_id], [false, null]);
});

// ════ REPLACE THE CARD ════════════════════════════════════════════════════════════════════════

Deno.test("update_card: a $0 validate replaces the vaulted card (customer + stored) and becomes the new unscheduled initial", async () => {
  const r = await drive({ action: "update_card", paymentToken: "tok-3", ...CONSENT, card: { last4: "5555", brand: "Mastercard" } }, { vault: { ...ON_FILE, unscheduled_initial_txn: "INIT-OLD" } });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.trace.gateway.length, 1);
  const g = r.trace.gateway[0];
  assertEquals([g.type, g.customer_vault, g.customer_vault_id, g.payment_token, g.amount], ["validate", "update_customer", "V-OLD", "tok-3", undefined]);
  assertEquals(cofOf(g), { initiated_by: "customer", stored_credential_indicator: "stored" });
  const up = r.trace.customers[0].row;
  assertEquals([up.card_last4, up.card_brand, up.unscheduled_initial_txn], ["5555", "mastercard", "T1"]);
  assertEquals([r.trace.consents[0].kind, r.trace.consents[0].transaction_id], ["card_update", "T1"]);
});

Deno.test("update_card: an operator, no card on file, or no box: refused before the gateway", async () => {
  for (const [payload, world, status] of [
    [{ action: "update_card", paymentToken: "tok", ...CONSENT }, { operator: true, vault: ON_FILE }, 400],
    [{ action: "update_card", paymentToken: "tok", ...CONSENT }, { vault: null }, 409],
    [{ action: "update_card", paymentToken: "tok" }, { vault: ON_FILE }, 400],
  ] as const) {
    const r = await drive(payload as any, world as World);
    assertEquals(r.status, status, JSON.stringify(r.body));
    assertEquals(r.trace.gateway, []);
  }
});

Deno.test("update_card: an unverifiable replacement clears the initial so no automatic top-up names the old card's", async () => {
  const r = await drive({ action: "update_card", paymentToken: "tok-3", ...CONSENT }, { vault: { ...ON_FILE, unscheduled_initial_txn: "INIT-OLD" }, gateway: () => "unknown" });
  assertEquals(r.status, 502, JSON.stringify(r.body));
  assertEquals(r.trace.customers.map((c) => [c.row.unscheduled_initial_txn, c.row.card_last4]), [[null, null]]);
  assert(r.trace.errors.some((e) => e.code === "card_update_unknown"), JSON.stringify(r.trace.errors));
});

// ════ BEFORE 317 / STATUS ═════════════════════════════════════════════════════════════════════

Deno.test("against a database without 317, no card action runs (503), and cancel still does", async () => {
  for (const payload of [topup(5000, CONSENT), subscribe(["simple_layout_annual"], CONSENT), autoOn(CONSENT), { action: "update_card", paymentToken: "t", ...CONSENT }]) {
    const r = await drive(payload, { pre317: true, vault: { vault_id: "V-OLD" } });
    assertEquals(r.status, 503, `${payload.action}: ${JSON.stringify(r.body)}`);
    assertEquals(r.trace.gateway, []);
  }
});

Deno.test("status tells the Billing tab the card, the sentences, and whether a top-up still needs agreeing", async () => {
  const r = await drive({ action: "status" }, { vault: ON_FILE });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.card, { last4: "1881", brand: "visa" });
  assertEquals(r.body.cof.version, COF_CONSENT_VERSION);
  assertEquals(r.body.cof.topupNeedsAgreement, true);
  assert(typeof r.body.cof.templates.subscription === "string" && r.body.cof.templates.autoTopup.includes("{dailyMax}"));
  assertEquals(r.body.wallet.autoTopup.ready, false);
  const after = await drive({ action: "status" }, { vault: { ...ON_FILE, unscheduled_initial_txn: "INIT-U" }, consents: OWNER_AGREED("INIT-U") });
  assertEquals([after.body.cof.topupNeedsAgreement, after.body.wallet.autoTopup.ready], [false, true]);
  // The vault id itself never leaves the server.
  assert(!JSON.stringify(r.body).includes("V-OLD"));
});

// ════ WIRING, from the shipped source ═════════════════════════════════════════════════════════

Deno.test("wiring: every remaining plain nmiPost in portal-billing is a reversal, a registration or a removal, never a sale", () => {
  const calls = [...SOURCE.matchAll(/nmiPost\(\{\s*([a-z_]+):\s*"([a-z_]+)"/g)].map((m) => `${m[1]}=${m[2]}`);
  assert(calls.length > 0);
  for (const c of calls) {
    assert(["type=void", "type=refund", "recurring=add_subscription", "recurring=delete_subscription", "customer_vault=delete_customer"].includes(c), `a plain nmiPost(${c}) bypasses the COF fields`);
  }
  // And the multi-line registration call is the add_subscription one.
  assert(/const r = await nmiPost\(\{\s*recurring: "add_subscription"/.test(SOURCE));
  // Sales and validates go through nmiPostCof, in portal-billing and in the shared top-up.
  assert(!/nmiPost\(\{\s*type: "(sale|validate)"/.test(SOURCE), "portal-billing sends a sale without COF fields");
  assert(!/nmiPost\(\{\s*type: "(sale|validate)"/.test(TOPUP_SRC), "walletTopup sends a sale without COF fields");
});

// ════ THE OLDER BILLING TAB (the transition until COF_REQUIRE_CONSENT=1) ═══════════════════════

Deno.test("older tab: a checkout with no `consent` key is served with the right COF fields, no agreement row, and an info row", async () => {
  const r = await drive(subscribe(["simple_layout_annual"], { paymentToken: "tok-1" }), { vault: null });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(cofOf(sales(r.trace)[0]), INITIAL_RECURRING_TOKEN, "the flags are the function's, whatever page sent the request");
  assertEquals(sales(r.trace)[0].customer_vault, "add_customer", "and the card is still stored only by an approved sale");
  assertEquals(r.trace.consents, [], "no agreement is invented for a page that showed none");
  assertEquals(r.trace.errors.map((e) => [e.code, e.severity]), [["cof_older_billing_tab", "info"]]);
});

Deno.test("older tab: a first top-up is served the same way, and still becomes the card's unscheduled initial", async () => {
  const r = await drive(topup(5000, { paymentToken: "tok-2" }), { vault: null });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(cofOf(sales(r.trace)[0]), { initiated_by: "customer", stored_credential_indicator: "stored" });
  assertEquals(r.trace.customers[0].row.unscheduled_initial_txn, "T1");
  assertEquals(r.trace.consents, []);
});

Deno.test("older tab: an operator's charge is taken as made with the owner on the phone (a CIT), and noted", async () => {
  const r = await drive(topup(5000), { operator: true, vault: { ...ON_FILE, unscheduled_initial_txn: "INIT-U" } });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(cofOf(sales(r.trace)[0]), { initiated_by: "customer", stored_credential_indicator: "used", initial_transaction_id: "INIT-U" });
  assert(r.trace.errors.some((e) => e.code === "cof_older_billing_tab"), JSON.stringify(r.trace.errors));
});

Deno.test("older tab: switching automatic top-ups ON is never served without the box", async () => {
  const r = await drive({ action: "topup_settings", enabled: true, thresholdCents: 10000, amountCents: 25000 }, { vault: { ...ON_FILE, unscheduled_initial_txn: "INIT-U" } });
  assertEquals([r.status, r.body.code], [400, "consent_required"]);
  assert(String(r.body.error).includes("next portal update"), JSON.stringify(r.body));
  assertEquals(r.trace.wallet, []);
});

// ════ AFTER THE REVIEW (2026-10-20) ═══════════════════════════════════════════════════════════

const OWNER_AGREED = (txn: string, version = COF_CONSENT_VERSION) => [{ kind: "topup_card", wording_version: version, transaction_id: txn }];

Deno.test("operator 'not asked' top-up: only when the owner's agreement behind the current initial covers it", async () => {
  const vault = { ...ON_FILE, unscheduled_initial_txn: "INIT-U" };
  const none = await drive(topup(5000, { cardholderPresent: false, ...TAB }), { operator: true, vault });
  assertEquals([none.status, none.body.code], [409, "needs_owner_agreement"], "no recorded agreement (e.g. a first top-up from the older tab)");
  assertEquals(none.trace.gateway, []);
  const old = await drive(topup(5000, { cardholderPresent: false, ...TAB }), { operator: true, vault, consents: OWNER_AGREED("INIT-U", "2026-01-01.1") });
  assertEquals([old.status, old.body.code], [409, "needs_owner_agreement"], "wording from before the disclosure");
  const ok = await drive(topup(5000, { cardholderPresent: false, ...TAB }), { operator: true, vault, consents: OWNER_AGREED("INIT-U") });
  assertEquals(ok.status, 200, JSON.stringify(ok.body));
  assertEquals(cofOf(sales(ok.trace)[0]), { initiated_by: "merchant", stored_credential_indicator: "used", initial_transaction_id: "INIT-U" });
});

Deno.test("status tells an operator whether 'not asked' is allowed, and never tells a builder it is", async () => {
  const vault = { ...ON_FILE, unscheduled_initial_txn: "INIT-U" };
  const op = await drive({ action: "status" }, { operator: true, vault, consents: OWNER_AGREED("INIT-U") });
  assertEquals(op.body.cof.operatorTopupAllowed, true);
  const opNo = await drive({ action: "status" }, { operator: true, vault });
  assertEquals(opNo.body.cof.operatorTopupAllowed, false);
  const builder = await drive({ action: "status" }, { vault, consents: OWNER_AGREED("INIT-U") });
  assertEquals(builder.body.cof.operatorTopupAllowed, false);
});

Deno.test("the new tab's marker: a first top-up from a STALE new tab with no box is refused, not waved through as the older tab", async () => {
  // The review's case: the new tab sends no `consent` when it thinks no box is needed (a stale
  // view after an unverifiable card replacement cleared the initial). With cofTab on every request
  // it is not mistaken for the pre-317 tab.
  const r = await drive(topup(5000, TAB), { vault: ON_FILE });
  assertEquals([r.status, r.body.code], [400, "consent_required"]);
  nothingTouched(r.trace);
  // ...while a later top-up from the new tab, marker and no box, is served as normal.
  const later = await drive(topup(5000, TAB), { vault: { ...ON_FILE, unscheduled_initial_txn: "INIT-U" }, consents: OWNER_AGREED("INIT-U") });
  assertEquals(later.status, 200, JSON.stringify(later.body));
  assert(!later.trace.errors.some((e) => e.code === "cof_older_billing_tab"), "the new tab is not counted as the old one");
});

Deno.test("a new card declined with the base already live: the next add-on in the cart is skipped, never charged", async () => {
  // Two add-ons and a live base, so it is the 'card not saved' rule, not the base-failed one, that stops the second.
  const r = await drive({ action: "subscribe", planIds: ["crm_annual", "view_3d_annual"], confirmChargeCents: price("crm_annual") + price("view_3d_annual"), paymentToken: "tok-1", ...CONSENT }, {
    vault: null, subs: [BASE_LIVE], gateway: () => "response=2&responsetext=Harness+decline&response_code=200",
  });
  assertEquals(r.status, 402, JSON.stringify(r.body));
  assertEquals(r.trace.gateway.length, 1, "one call, the declined one");
  assert(String(r.body.error).includes("your card was not saved"), JSON.stringify(r.body));
  assertEquals(r.trace.customers, []);
});

Deno.test("against a database without 317, cancelling still reaches the gateway (builders can always stop charges)", async () => {
  const r = await drive({ action: "cancel", subscriptionId: "S-BASE" }, { pre317: true, vault: { vault_id: "V-OLD" }, subs: [BASE_LIVE] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.trace.gateway.map((g) => [g.recurring, g.subscription_id]), [["delete_subscription", "S-BASE"]]);
});

Deno.test("an operator 'not asked' top-up charged but NOT credited still sends the owners a receipt", async () => {
  const vault = { ...ON_FILE, unscheduled_initial_txn: "INIT-U" };
  const r = await drive(topup(5000, { cardholderPresent: false, ...TAB }), { operator: true, vault, consents: OWNER_AGREED("INIT-U"), creditFails: true });
  assertEquals(r.status, 409, JSON.stringify(r.body));
  assert(r.trace.attempts.some((a) => a.op === "update" && a.row.receipt_error === "platform email is not configured"), "the receipt was attempted and recorded");
});

Deno.test("update_card: a replacement the database could not record still clears the old card's initial", () => {
  // The gateway replaced the card, then the billing_customers update failed: nothing may name the
  // old card's initial afterwards. This fake's writes never fail, so the branch is pinned from
  // the shipped source: the unrecorded branch clears the initial before it files the error.
  const branch = SOURCE.slice(SOURCE.indexOf("if (action === \"update_card\")"));
  const upErrAt = branch.indexOf("if (upErr) {");
  const clearAt = branch.indexOf("unscheduled_initial_txn: null", upErrAt);
  assert(upErrAt > 0 && clearAt > upErrAt && clearAt < branch.indexOf("card_update_unrecorded"), "the unrecorded branch clears the initial before filing");
});

Deno.test("wiring: every card request the Billing tab sends carries the cofTab marker", async () => {
  const jsx = await read("../../../../portal/03-catalog.jsx");
  for (const action of ["subscribe", "topup", "topup_settings", "update_card"]) {
    const i = jsx.indexOf(`action: "${action}"`);
    assert(i > 0, `${action} body not found`);
    const line = jsx.slice(i, jsx.indexOf("\n", i) + 400);
    assert(line.includes("...tabMark"), `${action}: the body does not spread tabMark`);
  }
});

// ════ ROUND 2 OF THE REVIEW ═══════════════════════════════════════════════════════════════════

Deno.test("an initial with NO agreement on file (a first top-up from the older tab): the next top-up asks for the box and becomes the initial", async () => {
  const vault = { ...ON_FILE, unscheduled_initial_txn: "INIT-NOAGREE" };
  const st = await drive({ action: "status" }, { vault });
  assertEquals(st.body.cof.topupNeedsAgreement, true, "the tab is told to show the box");
  const none = await drive(topup(5000, TAB), { vault });
  assertEquals([none.status, none.body.code], [400, "consent_required"]);
  assertEquals(none.trace.gateway, []);
  const r = await drive(topup(5000, { ...TAB, ...CONSENT }), { vault });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(cofOf(sales(r.trace)[0]), { initiated_by: "customer", stored_credential_indicator: "stored" });
  assertEquals(r.trace.customers[0].row.unscheduled_initial_txn, "T1", "this sale is the new initial");
  assertEquals([r.trace.consents[0].kind, r.trace.consents[0].transaction_id], ["topup_card", "T1"], "with its agreement, so operator top-ups can be covered from now on");
});

Deno.test("a 'recurring' retry refused exactly like the first is not blamed on billing_method", async () => {
  const r = await drive(subscribe(["crm_annual"], CONSENT), {
    vault: ON_FILE, subs: [BASE_LIVE], gateway: () => "response=3&responsetext=Invalid+Customer+Vault+Id&response_code=300",
  });
  assertEquals(r.status, 402);
  assertEquals(sales(r.trace).length, 2);
  assert(!r.trace.errors.some((e) => e.code === "nmi_initial_recurring_fallback"), JSON.stringify(r.trace.errors));
});

Deno.test("an unverifiable first sale of a NEW card files that a stored card may exist, and says so on the skipped lines", async () => {
  const r = await drive({ action: "subscribe", planIds: ["crm_annual", "view_3d_annual"], confirmChargeCents: price("crm_annual") + price("view_3d_annual"), paymentToken: "tok-1", ...CONSENT }, {
    vault: null, subs: [BASE_LIVE], gateway: () => "unknown",
  });
  assertEquals(r.status, 402, JSON.stringify(r.body));
  assertEquals(r.trace.gateway.length, 1);
  assert(r.trace.errors.some((e) => e.code === "new_card_unverifiable"), JSON.stringify(r.trace.errors));
  assert(String(r.body.error).includes("could not confirm the first charge"), JSON.stringify(r.body));
});

Deno.test("subscribe storing a NEW card clears any unscheduled initial (a first top-up racing it on another card)", async () => {
  const r = await drive(subscribe(["simple_layout_annual"], { paymentToken: "tok-1", ...CONSENT, ...CARD }), { vault: null });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const row = r.trace.customers[0].row;
  assert("unscheduled_initial_txn" in row && row.unscheduled_initial_txn === null, JSON.stringify(row));
});
