// Test or live, per builder (workstream 1 phase 3, migration 296), driven through the SHIPPED
// portal-payments, customer-pay and admin-catalog handlers.
//
// WHY THIS EXISTS. cardpointe.test.ts proves the client picks a system per call. What it cannot see
// is the three handlers around it, and every mistake worth pinning here is a short edit that throws
// nothing:
//
//   portal-payments / customer-pay
//     1. the tokenizer a page is handed is the one on the BUILDER'S system: a token minted by the
//        test tokenizer cannot be charged on live, and the reverse;
//     2. a live builder with the production secrets unset is REFUSED (503, reason env_not_configured),
//        nothing is sent anywhere, and a FAULT row is filed. Never quietly the test system;
//     3. a builder switched on with NO merchant id is refused like one switched off, even with the
//        old CARDPOINTE_MERCHID still set: the deployment default is gone;
//     4. a charge goes to the builder's system, and its attempt records cp_env;
//     5. void and refund go to the system the charge was TAKEN on (cp_env, NULL = uat), whatever the
//        builder is on now; reconcile asks settlestat once per (system, merchant, day), and never for
//        a system with no credentials;
//     6. a database WITHOUT 296 (no cardpointe_env, no cp_env): charges still go through, on UAT,
//        which is what every charge was before it;
//     7. neither system configured: every action refused as it always was.
//   admin-catalog
//     8. get_payments answers the system, whether the column exists, whether the builder is
//        non-billable, and which systems this deployment can reach;
//     9. set_payments refuses switching on in TEST for a billable builder, switching on a system with
//        no credentials, switching on with no merchant id, an unknown system, and a system change on
//        a database without 296 (an older console that sends no `env` still saves);
//    10. verify_payments asks ONE inquireByOrderid for an unused order id on the saved merchant and
//        its system, answers reachable / configError, audits the last four only, and is refused to
//        an operator without can_bill.
//
// HOW. paymentsMerchantOfRecord_test's idiom: Deno.serve is stubbed while each handler is imported,
// the import map swaps supabase-js for supabase_stub.ts, stubDb routes every table call into the
// fake below, and globalThis.fetch is the two CardPointe systems and nothing else. No --allow-net.
// cardpointe.ts reads its configuration per call, so one module serves both systems here; nmi.ts
// (admin-catalog's other gateway) reads its keys at load and is left unconfigured, which nothing here
// touches.
//
// ⚠️ THE IMPORT SPECIFIERS ARE COMPUTED ON PURPOSE (see aiDraftStreamWiring_test).
//
// Tenants, users, merchant ids, hosts and logins are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";

const UAT = "https://uat.example.invalid/cardconnect/rest";
const LIVE = "https://live.example.invalid/cardconnect/rest";
const UAT_ENV: Record<string, string> = {
  CARDPOINTE_BASE_URL: UAT,
  CARDPOINTE_API_USER: "u",
  CARDPOINTE_API_PASS: "p",
  CARDPOINTE_TOKENIZER_BASE: "https://uat.example.invalid/itoke/ajax-tokenizer.html",
};
const LIVE_ENV: Record<string, string> = {
  CARDPOINTE_PROD_BASE_URL: LIVE,
  CARDPOINTE_PROD_API_USER: "pu",
  CARDPOINTE_PROD_API_PASS: "pp",
  CARDPOINTE_PROD_TOKENIZER_BASE: "https://live.example.invalid/itoke/ajax-tokenizer.html",
};
const ADMIN_PASSWORD = "admin-password-test";
for (const [k, v] of Object.entries(UAT_ENV)) Deno.env.set(k, v);
for (const k of Object.keys(LIVE_ENV)) Deno.env.delete(k);
// The old deployment default, still set the way a live deployment may still have it: nothing here
// may ever send it.
const DEFAULT_MID = "100200300999";
Deno.env.set("CARDPOINTE_MERCHID", DEFAULT_MID);

async function load(rel: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  try {
    await import(new URL(rel, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${rel} did not hand Deno.serve a handler`);
  return handler;
}
const PAYMENTS = await load("../../portal-payments/index.ts");
const CUSTOMER = await load("../../customer-pay/index.ts");
const ADMIN = await load("../../admin-catalog/index.ts");

const TENANT = "acme-sheds";
const USER_ID = "00000000-0000-4000-8000-0000000000c4";
const MID = "100200300400";
const LIVE_MID = "100200300500";
const CODE = "SS-AAAAAAAAAA";
const CONTACT = { name: "Pat Example", phone: "555-555-0101", street: "12 Main St", zip: "12345" };

type World = {
  /** The client_settings row (null = none). */
  settings?: Record<string, unknown> | null;
  /** The database has no cardpointe_env / cp_env (a deploy ahead of 296). */
  no296?: boolean;
  /** payment_attempts rows for merchantOfRecord: cp_env undefined = the column is absent from the row. */
  attempts?: { id: number; merchid: string; cp_env?: string | null }[];
  payments?: Record<string, unknown>[];
  /** An app_operators row (the caller is a platform operator). */
  op?: Record<string, unknown> | null;
  /** The gateway's answer per call: a body or a status. */
  gateway?: (system: "uat" | "live", path: string, url: URL) => unknown;
};
type Trace = {
  gateway: { system: "uat" | "live"; path: string; body: any; url: URL; auth: string | null }[];
  writes: { table: string; verb: string; row: any }[];
  faults: Record<string, unknown>[];
  audits: Record<string, unknown>[];
  selects: { table: string; cols: string }[];
};
const eqOf = (ops: any[][], col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);
const MISSING = (col: string) => ({ data: null, error: { code: "42703", message: `column ${col} does not exist` } });

function answer(world: World, trace: Trace, table: string, ops: any[][]): any {
  const verb = ["insert", "update", "delete", "upsert"].find((v) => ops.some((o) => o[0] === v));
  const cols = String(argOf(ops, "select")[0] ?? "");
  if (table === "app_errors") {
    if (verb) { trace.faults.push(argOf(ops, verb)[0]); return { data: null, error: null }; }
    return { data: [], error: null };
  }
  if (table === "admin_audit") { trace.audits.push(argOf(ops, "insert")[0]); return { data: null, error: null }; }
  if (verb) {
    const row = argOf(ops, verb)[0];
    trace.writes.push({ table, verb, row });
    if (world.no296 && row && typeof row === "object" && ("cp_env" in row || "cardpointe_env" in row)) {
      return { data: null, error: { code: "PGRST204", message: "Could not find the column in the schema cache" } };
    }
    if (verb === "insert" && table === "payment_attempts") return { data: { id: 501 }, error: null };
    if (verb === "insert" && table === "payments") return { data: { id: "pay-new" }, error: null };
    if (verb === "insert" && table === "orders") return { data: { id: "o-adhoc" }, error: null };
    return { data: ops.some((o) => o[0] === "select") ? [{ id: eqOf(ops, "id") }] : null, error: null };
  }
  trace.selects.push({ table, cols });
  switch (table) {
    case "client_users":
      return { data: [{ client_id: TENANT, role: "owner", title: "owner", access: null, user_id: USER_ID }], error: null };
    case "app_operators":
      return { data: world.op ?? null, error: null };
    case "client_configs":
      return { data: { client_id: eqOf(ops, "client_id") }, error: null };
    case "admin_auth_attempts":
      return { data: null, error: null };
    case "customer_sessions":
      return { data: { client_id: TENANT, phone_digits: "5555550101", email_lower: null, name: "Pat Example" }, error: null };
    case "client_settings": {
      if (world.no296 && /\bcardpointe_env\b/.test(cols)) return MISSING("client_settings.cardpointe_env");
      const s = world.settings === undefined ? { payments_online_enabled: true, cardpointe_merchid: MID, cardpointe_env: "uat", billing_exempt: true } : world.settings;
      return { data: s ? { invoice_in_ghl: false, business_name: "Acme Sheds", ...s } : null, error: null };
    }
    case "orders":
      return { data: { id: eqOf(ops, "id") ?? "o-1", short_code: CODE, total_cents: 100000 }, error: null };
    case "designs":
      return { data: cols.includes("contact") ? { short_code: CODE, status: "invoiced", contact: CONTACT, ss_quote_number: "Q-1", estimate_lines: null } : null, error: null };
    case "invoice_sends":
      return {
        data: { invoice_number: "1001", status: "sent", issued_by: "structurestudio", signed_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z", document_at: "2026-10-01T10:00:00Z", deposit_cents: null },
        error: null,
      };
    case "change_orders":
      return { data: [], error: null };
    case "payment_attempts": {
      const ids = argOf(ops, "in")[1];
      if (!ids) return { data: [], error: null, count: 0 };
      if (world.no296 && /\bcp_env\b/.test(cols)) return MISSING("payment_attempts.cp_env");
      const want = (ids as unknown[]).map(String);
      return {
        data: (world.attempts ?? []).filter((a) => want.includes(String(a.id))).map((a) => {
          const { cp_env, ...rest } = a;
          return cp_env === undefined || !/\bcp_env\b/.test(cols) ? rest : { ...rest, cp_env };
        }),
        error: null,
      };
    }
    case "payments": {
      const all = world.payments ?? [];
      const id = eqOf(ops, "id");
      if (id !== undefined) return { data: all.find((p) => p.id === id) ?? null, error: null };
      if (eqOf(ops, "order_id") !== undefined && eqOf(ops, "gateway") === undefined) return { data: [], error: null };
      const fs = eqOf(ops, "funding_state");
      const method = eqOf(ops, "method");
      return { data: all.filter((p) => (p.funding_state ?? "settled") === fs && (!method || p.method === method) && !p.voided_at), error: null };
    }
  }
  return { data: null, error: null };
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "not", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  return q;
}

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
  ADMIN_PASSWORD,
};
const APPROVED = { respstat: "A", respcode: "000", retref: "rt-new", amount: "1000.00", token: "9413948780281111", authcode: "123456", avsresp: "Y", cvvresp: "M" };

async function drive(
  handler: (req: Request) => Promise<Response>,
  fn: string,
  body: Record<string, unknown>,
  world: World = {},
  { live = false, uat = true, operator = false }: { live?: boolean; uat?: boolean; operator?: boolean } = {},
) {
  const trace: Trace = { gateway: [], writes: [], faults: [], audits: [], selects: [] };
  const touched = [...Object.keys(ENV), ...Object.keys(UAT_ENV), ...Object.keys(LIVE_ENV)];
  const saved = Object.fromEntries(touched.map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  for (const [k, v] of Object.entries(UAT_ENV)) uat ? Deno.env.set(k, v) : Deno.env.delete(k);
  for (const [k, v] of Object.entries(LIVE_ENV)) live ? Deno.env.set(k, v) : Deno.env.delete(k);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const system = href.startsWith(UAT + "/") ? "uat" : href.startsWith(LIVE + "/") ? "live" : null;
    if (!system) return Promise.reject(new Error(`TEST FAILURE: unexpected fetch to ${href}`));
    const url = new URL(href);
    const path = url.pathname.replace(new URL(system === "uat" ? UAT : LIVE).pathname, "");
    trace.gateway.push({ system, path, body: init?.body ? JSON.parse(String(init.body)) : null, url, auth: new Headers(init?.headers).get("Authorization") });
    const out = world.gateway ? world.gateway(system, path, url) : path === "/auth" ? APPROVED : { respstat: "A", respcode: "00", retref: "rf-1" };
    return Promise.resolve(typeof out === "number" ? new Response("", { status: out }) : new Response(JSON.stringify(out), { status: 200 }));
  }) as typeof fetch;
  try {
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "harness/1.0", "x-forwarded-for": "203.0.113.9" };
    // admin-catalog: the break-glass password path unless the test is an operator (a JWT, below).
    if (fn !== "admin-catalog" || operator) headers.authorization = "Bearer harness";
    const res = await handler(new Request(`https://stub.supabase.co/functions/v1/${fn}`, {
      method: "POST",
      headers,
      body: JSON.stringify(fn === "admin-catalog" && !operator ? { adminPassword: ADMIN_PASSWORD, ...body } : body),
    }));
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text), trace };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}
const payments = (body: Record<string, unknown>, world?: World, opts?: Parameters<typeof drive>[4]) => drive(PAYMENTS, "portal-payments", body, world, opts);
const customer = (body: Record<string, unknown>, world?: World, opts?: Parameters<typeof drive>[4]) =>
  drive(CUSTOMER, "customer-pay", { token: "s".repeat(64), quoteRef: CODE, ...body }, world, opts);
const admin = (body: Record<string, unknown>, world?: World, opts?: Parameters<typeof drive>[4]) => drive(ADMIN, "admin-catalog", { clientId: TENANT, ...body }, world, opts);

const LIVE_ON = { payments_online_enabled: true, cardpointe_merchid: LIVE_MID, cardpointe_env: "prod", billing_exempt: false };
const UAT_ON = { payments_online_enabled: true, cardpointe_merchid: MID, cardpointe_env: "uat", billing_exempt: true };
const faultCodes = (t: Trace) => t.faults.filter((f) => (f.severity ?? "error") === "error").map((f) => f.code);
const attemptInsert = (t: Trace) => t.writes.filter((w) => w.table === "payment_attempts" && w.verb === "insert");
const CHARGE = { action: "charge", orderId: "o-1", payToken: "9413948780281111", confirmChargeCents: 100000 };
const TAKES_MONEY = [
  { action: "pay_options", orderId: "o-1" },
  { action: "surcharge_probe", payToken: "9413948780281111" },
  CHARGE,
  { action: "charge_adhoc", amountCents: 5000, confirmChargeCents: 5000, payToken: "9413948780281111" },
];

// ─── 1. The tokenizer of the builder's own system ──────────────────────────────────────────────
Deno.test("1. pay_options hands each page the tokenizer of the builder's OWN system", async () => {
  const live = await payments({ action: "pay_options", orderId: "o-1" }, { settings: LIVE_ON }, { live: true });
  assertEquals(live.status, 200, live.text);
  assertEquals(live.body.tokenizer.origin, "https://live.example.invalid");
  for (const k of ["cardUrl", "achUrl", "swipeUrl"]) assert(String(live.body.tokenizer[k]).startsWith("https://live.example.invalid/itoke/ajax-tokenizer.html?"), `${k}: ${live.body.tokenizer[k]}`);
  const test = await payments({ action: "pay_options", orderId: "o-1" }, { settings: UAT_ON }, { live: true });
  assertEquals(test.body.tokenizer.origin, "https://uat.example.invalid");
  assert(String(test.body.tokenizer.cardUrl).startsWith("https://uat.example.invalid/itoke/"), test.body.tokenizer.cardUrl);
  // customer-pay: the same rule on the shopper's page.
  const cust = await customer({ action: "pay_options" }, { settings: LIVE_ON }, { live: true });
  assertEquals(cust.status, 200, cust.text);
  assertEquals(cust.body.tokenizer.origin, "https://live.example.invalid");
  assert(String(cust.body.tokenizer.cardUrl).startsWith("https://live.example.invalid/itoke/"), cust.body.tokenizer.cardUrl);
});

// ─── 2. A live builder with no production secrets ──────────────────────────────────────────────
Deno.test("2. a LIVE builder with the production secrets unset: refused, nothing sent anywhere, filed as a fault", async () => {
  for (const body of TAKES_MONEY) {
    const r = await payments(body, { settings: LIVE_ON });
    assertEquals(r.status, 503, `${body.action}: ${r.text}`);
    assertEquals(r.body.reason, "env_not_configured", `${body.action}: ${r.text}`);
    assertEquals(r.trace.gateway, [], `${body.action} reached a gateway`);
    assert(faultCodes(r.trace).includes("payments_env_not_configured"), `${body.action}: ${JSON.stringify(r.trace.faults)}`);
    assertEquals(attemptInsert(r.trace), [], `${body.action} wrote an attempt`);
    assertEquals(r.trace.writes.filter((w) => w.table === "orders"), [], `${body.action} opened an order`);
  }
  for (const body of [{ action: "pay_options" }, { action: "surcharge_probe", payToken: "9413948780281111" }, { action: "pay", rail: "card", payToken: "9413948780281111", confirmChargeCents: 100000 }]) {
    const r = await customer(body, { settings: LIVE_ON });
    assertEquals(r.status, 503, `customer ${body.action}: ${r.text}`);
    assertEquals(r.trace.gateway, [], `customer ${body.action} reached a gateway`);
    assert(faultCodes(r.trace).includes("payments_env_not_configured"), `customer ${body.action}: ${JSON.stringify(r.trace.faults)}`);
    assertEquals(attemptInsert(r.trace), []);
  }
});

// ─── 3. No default merchant ────────────────────────────────────────────────────────────────────
Deno.test("3. switched ON with NO merchant id: refused like switched off, and the old default is never sent", async () => {
  for (const mid of [null, "", "   "]) {
    const settings = { payments_online_enabled: true, cardpointe_merchid: mid, cardpointe_env: "uat", billing_exempt: true };
    for (const body of TAKES_MONEY) {
      const r = await payments(body, { settings });
      assertEquals(r.status, 503, `${body.action} mid=${JSON.stringify(mid)}: ${r.text}`);
      assertEquals(r.body.error, "Taking cards isn't switched on for this account yet.");
      assertEquals(r.trace.gateway, []);
    }
    const c = await customer({ action: "pay", rail: "card", payToken: "9413948780281111", confirmChargeCents: 100000 }, { settings });
    assertEquals(c.status, 503, c.text);
    assertEquals(c.body.error, "Your builder hasn't finished setting up payments yet.");
    assertEquals(c.trace.gateway, []);
  }
});

// ─── 4. The charge goes to the builder's system ────────────────────────────────────────────────
Deno.test("4. a charge on a LIVE builder goes to live with the live login, and the attempt says prod", async () => {
  const r = await payments(CHARGE, { settings: LIVE_ON }, { live: true });
  assertEquals(r.status, 200, r.text);
  assertEquals(r.trace.gateway.map((g) => `${g.system} ${g.path}`), ["live /auth"]);
  assertEquals(r.trace.gateway[0].body.merchid, LIVE_MID);
  assertEquals(r.trace.gateway[0].auth, "Basic " + btoa("pu:pp"));
  const att = attemptInsert(r.trace)[0]?.row;
  assertEquals([att?.merchid, att?.cp_env], [LIVE_MID, "prod"]);
  // A test-mode builder on the same deployment: test, with the test login.
  const t = await payments(CHARGE, { settings: UAT_ON }, { live: true });
  assertEquals(t.trace.gateway.map((g) => `${g.system} ${g.path}`), ["uat /auth"]);
  assertEquals(t.trace.gateway[0].auth, "Basic " + btoa("u:p"));
  assertEquals(attemptInsert(t.trace)[0]?.row.cp_env, "uat");
  // The customer's own payment.
  const c = await customer({ action: "pay", rail: "card", payToken: "9413948780281111", confirmChargeCents: 100000 }, { settings: LIVE_ON }, { live: true });
  assertEquals(c.status, 200, c.text);
  assertEquals(c.trace.gateway.map((g) => `${g.system} ${g.path} ${g.body?.merchid}`), [`live /auth ${LIVE_MID}`]);
  assertEquals(attemptInsert(c.trace)[0]?.row.cp_env, "prod");
});

// ─── 5. Money already taken: the system it was taken on ────────────────────────────────────────
const CARD = { id: "p-card", order_id: "o-1", amount_cents: 100000, gateway: "cardpointe", gateway_txn_id: "rt-card", attempt_id: 41 };
Deno.test("5a. void and refund go to the system the charge was TAKEN on, whatever the builder is on now", async () => {
  // Taken in test (cp_env NULL, from before 296), builder now live: the void goes to test.
  const old = await payments({ action: "void_payment", paymentId: "p-card" }, { settings: LIVE_ON, payments: [CARD], attempts: [{ id: 41, merchid: MID, cp_env: null }] }, { live: true });
  assertEquals(old.status, 200, old.text);
  assertEquals(old.trace.gateway.map((g) => `${g.system} ${g.path} ${g.body.merchid}`), [`uat /void ${MID}`]);
  // Taken live, builder since switched to test: the refund goes to live.
  const live = await payments({ action: "refund_payment", paymentId: "p-card", amountCents: 2500 }, { settings: UAT_ON, payments: [CARD], attempts: [{ id: 41, merchid: LIVE_MID, cp_env: "prod" }] }, { live: true });
  assertEquals(live.status, 200, live.text);
  assertEquals(live.trace.gateway.map((g) => `${g.system} ${g.path} ${g.body.merchid} ${g.body.amount}`), [`live /refund ${LIVE_MID} 25.00`]);
});

Deno.test("5b. a void on a LIVE charge with the production secrets unset: refused, nothing sent, filed", async () => {
  const r = await payments({ action: "void_payment", paymentId: "p-card" }, { payments: [CARD], attempts: [{ id: 41, merchid: LIVE_MID, cp_env: "prod" }] });
  assertEquals(r.status, 503, r.text);
  assertEquals(r.body.reason, "env_not_configured");
  assertEquals(r.trace.gateway, []);
  assert(faultCodes(r.trace).includes("payments_env_not_configured"), JSON.stringify(r.trace.faults));
  assertEquals(r.trace.writes.filter((w) => w.table === "payments"), [], "nothing is marked voided");
});

Deno.test("5c. reconcile asks settlestat once per (system, merchant, day), and never on a system it cannot reach", async () => {
  const ach = (id: string, attempt: number, retref: string) => ({
    id, order_id: `o-${id}`, amount_cents: 50000, gateway: "cardpointe", gateway_txn_id: retref, attempt_id: attempt,
    funding_state: "pending", method: "ach", received_at: "2026-10-01T15:00:00Z",
  });
  // The SAME MID on both systems, same day: two calls, each batch read for its own system.
  const world: World = {
    payments: [ach("a1", 41, "rt-a1"), ach("a2", 42, "rt-a2")],
    attempts: [{ id: 41, merchid: MID, cp_env: null }, { id: 42, merchid: MID, cp_env: "prod" }],
    gateway: (system) => ({ txns: [{ retref: system === "uat" ? "rt-a1" : "rt-a2", setlstat: system === "uat" ? "Accepted" : "Rejected" }] }),
  };
  const both = await payments({ action: "reconcile" }, world, { live: true });
  assertEquals(both.status, 200, both.text);
  assertEquals(both.trace.gateway.map((g) => `${g.system} ${g.path} ${g.url.searchParams.get("merchid")} ${g.url.searchParams.get("date")}`).sort(),
    [`live /settlestat ${MID} 20261001`, `uat /settlestat ${MID} 20261001`]);
  assertEquals(Object.fromEntries((both.body.updated as any[]).map((u) => [u.paymentId, u.to])), { a1: "settled", a2: "returned" });
  assertEquals(both.body.daysChecked, ["20261001"]);
  // Production unset: only the test batch is asked for, and the live payment stays as it is.
  const one = await payments({ action: "reconcile" }, world);
  assertEquals(one.trace.gateway.map((g) => g.system), ["uat"]);
  assertEquals((one.body.updated as any[]).map((u) => u.paymentId), ["a1"]);
});

// ─── 6. A database without 296 ─────────────────────────────────────────────────────────────────
Deno.test("6. a database WITHOUT 296: the charge still goes through, on UAT, and the attempt is written without cp_env", async () => {
  const r = await payments(CHARGE, { no296: true, settings: { payments_online_enabled: true, cardpointe_merchid: MID } }, { live: true });
  assertEquals(r.status, 200, r.text);
  assertEquals(r.trace.gateway.map((g) => `${g.system} ${g.path}`), ["uat /auth"]);
  const inserts = attemptInsert(r.trace);
  assertEquals(inserts.length, 2, "tried with cp_env, then without");
  assertEquals(["cp_env" in inserts[0].row, "cp_env" in inserts[1].row], [true, false]);
  assert(Array.isArray(inserts[1].row.sent_fields), "the 291 fields stay");
  const c = await customer({ action: "pay", rail: "card", payToken: "9413948780281111", confirmChargeCents: 100000 }, { no296: true, settings: { payments_online_enabled: true, cardpointe_merchid: MID } });
  assertEquals(c.status, 200, c.text);
  assertEquals(c.trace.gateway.map((g) => g.system), ["uat"]);
  // A void reads the attempt's system tolerantly too.
  const v = await payments({ action: "void_payment", paymentId: "p-card" }, { no296: true, payments: [CARD], attempts: [{ id: 41, merchid: MID }] });
  assertEquals(v.status, 200, v.text);
  assertEquals(v.trace.gateway.map((g) => `${g.system} ${g.path}`), ["uat /void"]);
});

// ─── 7. Nothing configured ─────────────────────────────────────────────────────────────────────
Deno.test("7. neither system configured: every action refused as it always was, nothing read, nothing sent", async () => {
  for (const body of [...TAKES_MONEY, { action: "void_payment", paymentId: "p-card" }, { action: "reconcile" }]) {
    const r = await payments(body, { payments: [CARD], attempts: [{ id: 41, merchid: MID }] }, { uat: false });
    assertEquals(r.status, 503, `${body.action}: ${r.text}`);
    assertEquals(r.body.error, "Card payments aren't configured on this deployment yet.");
    assertEquals(r.trace.gateway, []);
  }
  const c = await customer({ action: "pay_options" }, {}, { uat: false });
  assertEquals([c.status, c.body.error], [503, "Online payments aren't switched on yet."]);
});

// ─── 8. get_payments ───────────────────────────────────────────────────────────────────────────
Deno.test("8. get_payments answers the system, the column, the billing posture and what this deployment can reach", async () => {
  const r = await admin({ action: "get_payments" }, { settings: LIVE_ON }, { live: false });
  assertEquals(r.status, 200, r.text);
  assertEquals([r.body.paymentsEnabled, r.body.merchid, r.body.env, r.body.envColumn, r.body.billingExempt], [true, LIVE_MID, "prod", true, false]);
  assertEquals(r.body.configured, { uat: true, prod: false });
  const old = await admin({ action: "get_payments" }, { no296: true, settings: { payments_online_enabled: true, cardpointe_merchid: MID, billing_exempt: true } });
  assertEquals([old.body.env, old.body.envColumn], ["uat", false], old.text);
  assertEquals(r.trace.gateway, []);
});

// ─── 9. set_payments ───────────────────────────────────────────────────────────────────────────
const upserts = (t: Trace) => t.writes.filter((w) => w.table === "client_settings" && w.verb === "upsert").map((w) => w.row);
Deno.test("9a. switching ON in TEST is refused for a billable builder, and allowed for a non-billable one", async () => {
  const billable = { payments_online_enabled: false, cardpointe_merchid: MID, cardpointe_env: "uat", billing_exempt: false };
  const r = await admin({ action: "set_payments", paymentsEnabled: true, env: "uat" }, { settings: billable });
  assertEquals(r.status, 400, r.text);
  assert(/Test mode \(UAT\) moves no real money/.test(r.body.error), r.body.error);
  assertEquals(upserts(r.trace), [], "nothing written");
  // The same without naming env: the STORED system is the one judged.
  const stored = await admin({ action: "set_payments", paymentsEnabled: true }, { settings: billable });
  assertEquals(stored.status, 400, stored.text);
  // Non-billable: saved, env written, and the audit note names the system.
  const ok = await admin({ action: "set_payments", paymentsEnabled: true, env: "uat", merchid: MID }, { settings: { ...billable, billing_exempt: true } });
  assertEquals(ok.status, 200, ok.text);
  assertEquals([upserts(ok.trace)[0]?.cardpointe_env, upserts(ok.trace)[0]?.payments_online_enabled], ["uat", true]);
  assert(/ env uat -> uat$/.test(String(ok.trace.audits.find((a) => a.action === "set_payments")?.note)), JSON.stringify(ok.trace.audits));
  // Switching a billable builder OFF in test is always allowed.
  const off = await admin({ action: "set_payments", paymentsEnabled: false }, { settings: { ...billable, payments_online_enabled: true } });
  assertEquals(off.status, 200, off.text);
});

Deno.test("9b. switching ON a system with no credentials is refused; choosing it while OFF is not", async () => {
  const settings = { payments_online_enabled: false, cardpointe_merchid: LIVE_MID, cardpointe_env: "uat", billing_exempt: false };
  const r = await admin({ action: "set_payments", paymentsEnabled: true, env: "prod" }, { settings });
  assertEquals(r.status, 400, r.text);
  assert(/Live card processing isn't set up on this deployment yet: set the CARDPOINTE_PROD_BASE_URL, CARDPOINTE_PROD_API_USER, CARDPOINTE_PROD_API_PASS, CARDPOINTE_PROD_TOKENIZER_BASE secrets first/.test(r.body.error), r.body.error);
  assertEquals(upserts(r.trace), []);
  const off = await admin({ action: "set_payments", paymentsEnabled: false, env: "prod" }, { settings });
  assertEquals(off.status, 200, off.text);
  assertEquals(upserts(off.trace)[0]?.cardpointe_env, "prod");
  const on = await admin({ action: "set_payments", paymentsEnabled: true, env: "prod" }, { settings }, { live: true });
  assertEquals(on.status, 200, on.text);
  assertEquals(on.body.env, "prod");
  assert(/on LIVE/.test(on.body.note), on.body.note);
});

Deno.test("9c. no merchant id, an unknown system, and a system change on a database without 296 are all refused", async () => {
  const noMid = await admin({ action: "set_payments", paymentsEnabled: true, env: "prod", merchid: "" }, { settings: LIVE_ON }, { live: true });
  assertEquals(noMid.status, 400, noMid.text);
  assert(/With none, their customers can't pay by card at all/.test(noMid.body.error), noMid.body.error);
  assert(!/fall back/.test(noMid.body.error), "the refusal still talks about the removed fallback");
  for (const env of ["live", "test", "PROD", 1, null]) {
    const r = await admin({ action: "set_payments", paymentsEnabled: false, env }, { settings: LIVE_ON }, { live: true });
    assertEquals(r.status, 400, `${JSON.stringify(env)}: ${r.text}`);
    assertEquals(upserts(r.trace), []);
  }
  const old = { payments_online_enabled: false, cardpointe_merchid: MID, billing_exempt: true };
  const r = await admin({ action: "set_payments", paymentsEnabled: false, env: "prod" }, { no296: true, settings: old });
  assertEquals(r.status, 400, r.text);
  assert(/needs migration 296/.test(r.body.error), r.body.error);
  assertEquals(upserts(r.trace), []);
  // An OLDER console sends no env: it still saves on a database without 296, as it did before.
  const older = await admin({ action: "set_payments", paymentsEnabled: true, merchid: MID }, { no296: true, settings: old });
  assertEquals(older.status, 200, older.text);
  assert(!("cardpointe_env" in upserts(older.trace)[0]), JSON.stringify(upserts(older.trace)));
});

// ─── 10. verify_payments ───────────────────────────────────────────────────────────────────────
Deno.test("10a. verify_payments: ONE inquireByOrderid for an unused order id, on the saved merchant and its system", async () => {
  const r = await admin({ action: "verify_payments" }, {
    settings: LIVE_ON,
    gateway: () => ({ respstat: "C", respcode: "29", resptext: "Txn not found", merchid: LIVE_MID }),
  }, { live: true });
  assertEquals(r.status, 200, r.text);
  assertEquals(r.trace.gateway.length, 1);
  const g = r.trace.gateway[0];
  assertEquals(g.system, "live");
  assert(new RegExp(`^/inquireByOrderid/ssverify_[0-9a-f]{16}/${LIVE_MID}$`).test(g.path), g.path);
  assertEquals([r.body.reachable, r.body.env, r.body.midLast4, r.body.gateway?.resptext], [true, "prod", "0500", "Txn not found"]);
  assert(!r.text.includes(LIVE_MID), `the full MID went back: ${r.text}`);
  const audit = r.trace.audits.find((a) => a.action === "verify_payments");
  assert(audit && /env=prod mid=…0500 reachable=true$/.test(String(audit.note)), JSON.stringify(r.trace.audits));
  assert(!JSON.stringify(r.trace.audits).includes(LIVE_MID), "the audit row carries the full MID");
  assertEquals(r.trace.writes.filter((w) => w.table !== "admin_audit"), [], "verify writes nothing");
});

Deno.test("10b. verify_payments: not configured, no merchant id, and a refusal are config errors, with nothing sent for the first two", async () => {
  const unset = await admin({ action: "verify_payments" }, { settings: LIVE_ON });
  assertEquals([unset.status, unset.body.reachable], [200, false], unset.text);
  assert(/Live card processing isn't set up on this deployment/.test(unset.body.configError), unset.text);
  assertEquals(unset.trace.gateway, []);
  const noMid = await admin({ action: "verify_payments" }, { settings: { ...UAT_ON, cardpointe_merchid: null } });
  assertEquals([noMid.body.reachable, noMid.body.configError], [false, "No merchant id is set for this builder."]);
  assertEquals(noMid.trace.gateway, []);
  const refused = await admin({ action: "verify_payments" }, { settings: UAT_ON, gateway: () => 401 });
  assertEquals(refused.body.reachable, false, refused.text);
  assert(/The gateway refused our request/.test(refused.body.configError), refused.text);
  assertEquals(refused.trace.gateway.map((g) => g.system), ["uat"]);
  const dark = await admin({ action: "verify_payments" }, { settings: UAT_ON, gateway: () => 503 });
  assert(!dark.body.reachable && /The gateway did not answer/.test(dark.body.error), dark.text);
});

Deno.test("10c. verify_payments and set_payments are refused to an operator without can_bill; allowed with it", async () => {
  const noBill = { user_id: USER_ID, email: "ops@example.test", can_write: true, can_bill: false, support_only: false };
  for (const action of ["verify_payments", "set_payments"]) {
    const r = await admin({ action, paymentsEnabled: false }, { settings: UAT_ON, op: noBill }, { operator: true });
    assertEquals(r.status, 403, `${action}: ${r.text}`);
    assertEquals(r.trace.gateway, []);
  }
  const bill = await admin({ action: "verify_payments" }, { settings: UAT_ON, op: { ...noBill, can_bill: true } }, { operator: true });
  assertEquals([bill.status, bill.body.reachable], [200, true], bill.text);
});
