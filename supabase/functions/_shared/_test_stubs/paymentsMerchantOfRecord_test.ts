// Void, refund and reconcile on the merchant account the charge was TAKEN on, driven through the
// SHIPPED portal-payments handler (2026-10, Fiserv certification, workstream 1 phase 2).
//
// WHY THIS EXISTS. Until now every gateway call after the sale asked the tenant's CURRENT merchant
// id (client_settings.cardpointe_merchid, or the deployment default when that was blank). So a
// builder whose MID changed after a sale (a re-board, a move from test to live) could no longer void
// or refund it: the gateway was asked about a retref on an account that never saw it. And the
// `payments_online_enabled` refusal sat in front of EVERY action, so a tenant switched off could not
// give a customer their money back, or see a bank payment clear or come back. Held here:
//
//   1. void_payment and refund_payment send the MID off the payment's own attempt row
//      (merchantOfRecord), whatever the tenant's settings say now, or whether they say anything.
//   2. A cardpointe payment with NO attempt (or an attempt that is not there) is REFUSED with a
//      logged fault and no gateway call. It never falls back to the current MID.
//   3. A tenant switched off still voids, refunds and reconciles; pay_options, surcharge_probe,
//      charge and charge_adhoc are still refused, exactly as before.
//   4. reconcile asks settlestat once per (merchant, day), each on its own MID, and skips (and
//      logs, once a day) a pending bank payment with no merchant of record instead of asking the
//      current MID.
//   5. merchantOfRecord reads the CALLER'S tenant's attempts only: an attempt id that belongs to
//      another tenant is no merchant of record.
//   6. The billing fields on the shipped handler (phase 1): pay_options hands billingPrefill to a
//      member who can take the card and to nobody else; a keyed `charge` sends the typed name,
//      street and ZIP with ecomind "E"; a swipe sends no ecomind; a page that sends nothing gets
//      the auth it always got.
//
// HOW. deleteDesignWiring_test's idiom: Deno.serve is stubbed while portal-payments/index.ts is
// imported, and the import map swaps supabase-js for supabase_stub.ts, whose stubDb hook routes every
// table call into the fake below. globalThis.fetch is the CardPointe gateway and nothing else. No
// --allow-net: nothing here reaches a real database or gateway.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check portal-payments against the stub's partial client type.
//
// Tenants, users, merchant ids and retrefs are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";

// The UAT system's configuration (cardpointe.ts reads it per call since phase 3; set here once, for
// the whole file). Every attempt below has no cp_env, which is UAT.
const GATEWAY = "https://gateway.example.invalid/cardconnect/rest";
Deno.env.set("CARDPOINTE_BASE_URL", GATEWAY);
Deno.env.set("CARDPOINTE_API_USER", "u");
Deno.env.set("CARDPOINTE_API_PASS", "p");
Deno.env.set("CARDPOINTE_MERCHID", "100200300999");   // the deployment default: must never be asked
Deno.env.set("CARDPOINTE_TOKENIZER_BASE", "https://gateway.example.invalid/itoke/ajax-tokenizer.html");

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

const TENANT = "acme-sheds";
const USER_ID = "00000000-0000-4000-8000-0000000000c3";
const OLD_MID = "100200300400";   // the account the charges were taken on
const NEW_MID = "100200300500";   // the tenant's account today
const DEFAULT_MID = "100200300999";

type Pay = { id: string; order_id: string; amount_cents: number; gateway: string; gateway_txn_id: string; attempt_id: number | null; voided_at?: string | null; funding_state?: string; received_at?: string; method?: string; note?: string | null };
type World = {
  settings?: Record<string, unknown> | null;
  payments?: Pay[];
  /** client_id defaults to TENANT. */
  attempts?: { id: number; merchid: string; client_id?: string }[];
  attemptsFail?: boolean;
  /** The caller's client_users row. Default: an owner of TENANT. */
  member?: Record<string, unknown>;
  /** An app_operators row: the caller is a platform operator (the body names targetClientId). */
  op?: Record<string, unknown> | null;
  /** The order pay_options / charge read, and the contact on its design. */
  order?: { id: string; short_code: string | null; total_cents: number } | null;
  contact?: Record<string, unknown> | null;
  /** app_errors rows already filed, for reconcile's once-a-day check. */
  priorErrors?: Record<string, unknown>[];
  /** The gateway's answer per path ("/void", "/refund", "/settlestat"): a body, or a status. */
  gateway?: (path: string, body: any, url: URL) => unknown;
};
type Trace = {
  gateway: { path: string; body: any; url: URL }[];
  errors: Record<string, unknown>[];
  errorReads: number;
  writes: { table: string; verb: string; row: any }[];
  audit: Record<string, unknown>[];
};
const eqOf = (ops: any[][], col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);
const has = (ops: any[][], op: string) => ops.some((o) => o[0] === op);

function answer(world: World, trace: Trace, table: string, ops: any[][]): any {
  const verb = ["insert", "update", "delete", "upsert"].find((v) => has(ops, v));
  switch (table) {
    case "client_users":
      return { data: [world.member ?? { client_id: TENANT, role: "owner", title: "owner", access: null, user_id: USER_ID }], error: null };
    case "app_operators":
      return { data: world.op ?? null, error: null };
    case "client_configs":
      return { data: { client_id: eqOf(ops, "client_id") }, error: null };
    case "admin_audit":
      trace.audit.push(argOf(ops, "insert")[0]);
      return { data: null, error: null };
    case "app_errors": {
      if (verb) { trace.errors.push(argOf(ops, verb)[0]); return { data: null, error: null }; }
      // orphansFiledToday: this tenant's rows under the code, newer than the cutoff.
      trace.errorReads++;
      const since = String(argOf(ops, "gt")[1] ?? "");
      return {
        data: (world.priorErrors ?? []).filter((e) =>
          e.client_id === eqOf(ops, "client_id") && e.code === eqOf(ops, "code") && e.source === eqOf(ops, "source") &&
          String(e.created_at) > since
        ),
        error: null,
      };
    }
    case "orders":
      return { data: world.order && world.order.id === eqOf(ops, "id") ? { ...world.order } : null, error: null };
    case "designs":
      // The charge path reads the contact; readOrderMoney reads the lines (none: the order total stands).
      return { data: String(argOf(ops, "select")[0] ?? "").includes("contact") && world.contact !== undefined ? { contact: world.contact } : null, error: null };
    case "change_orders":
      return { data: [], error: null };
    case "invoice_sends":
      return { data: null, error: null };
    case "client_settings":
      return { data: world.settings === undefined ? { payments_online_enabled: true, cardpointe_merchid: NEW_MID, business_name: "Acme Sheds" } : world.settings, error: null };
    case "payment_attempts": {
      if (verb) {
        trace.writes.push({ table, verb, row: argOf(ops, verb)[0] });
        return { data: verb === "insert" ? { id: 501 } : null, error: null };
      }
      const ids = argOf(ops, "in")[1];
      if (ids) {
        if (world.attemptsFail) return { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
        const want = (ids as unknown[]).map(String);
        // Honours the tenant filter, as Postgres would: another tenant's attempt is not found.
        const tenant = eqOf(ops, "client_id");
        return {
          data: (world.attempts ?? []).filter((a) => want.includes(String(a.id)) && (a.client_id ?? TENANT) === tenant).map((a) => ({ ...a })),
          error: null,
        };
      }
      // reconcile's closed_unknown sweep, the charge path's unknown/open checks, the decline count: none.
      return { data: [], error: null };
    }
    case "payments": {
      if (verb) {
        trace.writes.push({ table, verb, row: argOf(ops, verb)[0] });
        if (verb === "insert") return { data: { id: "pay-new" }, error: null };
        return { data: has(ops, "select") ? [{ id: eqOf(ops, "id") }] : null, error: null };
      }
      const all = world.payments ?? [];
      const id = eqOf(ops, "id");
      if (id !== undefined) return { data: all.find((p) => p.id === id) ?? null, error: null };
      // reconcile's two reads: pending, and settled ACH inside the return window.
      const fs = eqOf(ops, "funding_state");
      const method = eqOf(ops, "method");
      return { data: all.filter((p) => (p.funding_state ?? "settled") === fs && (!method || p.method === method) && !p.voided_at), error: null };
    }
  }
  throw new Error(`the fake database has no answer for ${table} ${JSON.stringify(ops)}`);
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "is", "in", "not", "or", "limit", "order", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  return q;
}

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

async function call(body: Record<string, unknown>, world: World) {
  const trace: Trace = { gateway: [], errors: [], errorReads: 0, writes: [], audit: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(GATEWAY + "/")) return Promise.reject(new Error(`TEST FAILURE: unexpected fetch to ${href}`));
    const url = new URL(href);
    const path = url.pathname.replace(new URL(GATEWAY).pathname, "");
    const sent = init?.body ? JSON.parse(String(init.body)) : null;
    trace.gateway.push({ path, body: sent, url });
    const out = world.gateway ? world.gateway(path, sent, url) : { respstat: "A", respcode: "00", retref: "rf-1" };
    return Promise.resolve(typeof out === "number" ? new Response("", { status: out }) : new Response(JSON.stringify(out), { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await PAYMENTS(new Request("https://stub.supabase.co/functions/v1/portal-payments", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json(), trace };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const CARD: Pay = { id: "p-card", order_id: "o-1", amount_cents: 100000, gateway: "cardpointe", gateway_txn_id: "rt-card", attempt_id: 41 };
const ATTEMPTS = [{ id: 41, merchid: OLD_MID }, { id: 42, merchid: OLD_MID }, { id: 43, merchid: NEW_MID }];
const OFF = { payments_online_enabled: false, cardpointe_merchid: NEW_MID, business_name: "Acme Sheds" };
const faultCodes = (t: Trace) => t.errors.filter((e) => e.severity === "error").map((e) => e.code);

// ─── 1. Void and refund ask the account the charge was taken on ───────────────────────────────
Deno.test("a void after the tenant's MID changed is sent on the ORIGINAL MID", async () => {
  const r = await call({ action: "void_payment", paymentId: "p-card" }, { payments: [CARD], attempts: ATTEMPTS });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body, { ok: true, voided: true });
  assertEquals(r.trace.gateway.length, 1, JSON.stringify(r.trace.gateway.map((g) => g.path)));
  assertEquals(r.trace.gateway[0].path, "/void");
  assertEquals(r.trace.gateway[0].body, { merchid: OLD_MID, retref: "rt-card" });
  const upd = r.trace.writes.find((w) => w.table === "payments" && w.verb === "update");
  assert(upd && upd.row.voided_at, `the payment is marked voided: ${JSON.stringify(r.trace.writes)}`);
});

Deno.test("a full refund after the MID changed is sent on the ORIGINAL MID", async () => {
  const r = await call({ action: "refund_payment", paymentId: "p-card" }, { payments: [CARD], attempts: ATTEMPTS });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.trace.gateway.map((g) => g.path), ["/refund"]);
  assertEquals(r.trace.gateway[0].body, { merchid: OLD_MID, retref: "rt-card", amount: "1000.00" });
});

Deno.test("neither the tenant's current MID nor the deployment default is ever asked", async () => {
  for (const settings of [undefined, { payments_online_enabled: true, cardpointe_merchid: null, business_name: "Acme Sheds" }]) {
    for (const action of ["void_payment", "refund_payment"]) {
      const r = await call({ action, paymentId: "p-card" }, { settings: settings as any, payments: [CARD], attempts: ATTEMPTS });
      assertEquals(r.status, 200, `${action}: ${JSON.stringify(r.body)}`);
      for (const g of r.trace.gateway) {
        assert(g.body.merchid !== NEW_MID && g.body.merchid !== DEFAULT_MID, `${action} asked ${g.body.merchid}`);
      }
    }
  }
});

// ─── 2. No attempt, no merchant: refused, logged, never the current MID ───────────────────────
Deno.test("a cardpointe payment with NO attempt is refused, logged as a fault, and the gateway is never asked", async () => {
  for (const action of ["void_payment", "refund_payment"]) {
    const r = await call({ action, paymentId: "p-orphan" }, { payments: [{ ...CARD, id: "p-orphan", attempt_id: null }], attempts: ATTEMPTS });
    assertEquals(r.status, 409, `${action}: ${JSON.stringify(r.body)}`);
    assert(/which merchant account took this payment/.test(String(r.body.error)), r.body.error);
    assertEquals(r.trace.gateway, [], `${action} must not reach the gateway`);
    assert(faultCodes(r.trace).includes("payment_no_merchant_of_record"), `${action}: ${JSON.stringify(r.trace.errors)}`);
    assertEquals(r.trace.writes.filter((w) => w.table === "payments"), [], "nothing is marked voided or refunded");
  }
});

Deno.test("an attempt id whose row is not there is refused the same way", async () => {
  const r = await call({ action: "void_payment", paymentId: "p-card" }, { payments: [{ ...CARD, attempt_id: 999 }], attempts: ATTEMPTS });
  assertEquals(r.status, 409, JSON.stringify(r.body));
  assertEquals(r.trace.gateway, []);
  assert(faultCodes(r.trace).includes("payment_no_merchant_of_record"), JSON.stringify(r.trace.errors));
});

Deno.test("an attempt read that FAILS is a 500 with nothing sent, not a fall back", async () => {
  const r = await call({ action: "refund_payment", paymentId: "p-card" }, { payments: [CARD], attempts: ATTEMPTS, attemptsFail: true });
  assertEquals(r.status, 500, JSON.stringify(r.body));
  assertEquals(r.trace.gateway, []);
});

// ─── 3. The switch guards taking money, and only that ─────────────────────────────────────────
Deno.test("a tenant switched OFF can still void and refund (on the original MID)", async () => {
  const v = await call({ action: "void_payment", paymentId: "p-card" }, { settings: OFF, payments: [CARD], attempts: ATTEMPTS });
  assertEquals(v.status, 200, JSON.stringify(v.body));
  assertEquals(v.trace.gateway[0].body.merchid, OLD_MID);
  const f = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 2500 }, { settings: OFF, payments: [CARD], attempts: ATTEMPTS });
  assertEquals(f.status, 200, JSON.stringify(f.body));
  assertEquals(f.body.refunded, 2500);
  assertEquals(f.trace.gateway[0].body, { merchid: OLD_MID, retref: "rt-card", amount: "25.00" });
  // A tenant with no settings row at all is the same.
  const n = await call({ action: "void_payment", paymentId: "p-card" }, { settings: null, payments: [CARD], attempts: ATTEMPTS });
  assertEquals(n.status, 200, JSON.stringify(n.body));
});

Deno.test("a tenant switched OFF is still refused everything that TAKES money", async () => {
  const bodies: Record<string, unknown>[] = [
    { action: "pay_options", orderId: "o-1" },
    { action: "surcharge_probe", payToken: "9413948780281111" },
    { action: "charge", orderId: "o-1", payToken: "9413948780281111", confirmChargeCents: 100000 },
    { action: "charge_adhoc", amountCents: 5000, confirmChargeCents: 5000, payToken: "9413948780281111" },
  ];
  // Switched off, and no settings row at all. (A tenant switched ON with a blank MID is refused the
  // same way since phase 3 removed the deployment default: paymentsEnvWiring_test, case 3.)
  for (const settings of [OFF, null]) {
    for (const body of bodies) {
      const r = await call(body, { settings, payments: [CARD], attempts: ATTEMPTS });
      assertEquals(r.status, 503, `${body.action} on ${JSON.stringify(settings)}: ${JSON.stringify(r.body)}`);
      assertEquals(r.body.error, "Taking cards isn't switched on for this account yet.");
      assertEquals(r.trace.gateway, [], `${body.action} must not reach the gateway`);
    }
  }
});

// ─── 4. reconcile: one settlestat per (merchant, day), each on its own MID ────────────────────
const ACH = (id: string, attempt: number | null, retref: string, day: string): Pay => ({
  id, order_id: `o-${id}`, amount_cents: 50000, gateway: "cardpointe", gateway_txn_id: retref, attempt_id: attempt,
  funding_state: "pending", method: "ach", received_at: `${day}T15:00:00Z`,
});

Deno.test("reconcile asks settlestat once per (merchant, day), each on the MID the payment was taken on", async () => {
  const payments = [
    ACH("a1", 41, "rt-a1", "2026-10-01"),
    ACH("a2", 42, "rt-a2", "2026-10-01"),   // same MID, same day: no second call
    ACH("a3", 43, "rt-a3", "2026-10-01"),   // another MID, same day: its own call
  ];
  const r = await call({ action: "reconcile" }, {
    settings: OFF,   // switched off: reconcile still runs
    payments,
    attempts: ATTEMPTS,
    gateway: (_p, _b, url) => {
      const mid = url.searchParams.get("merchid");
      // Each MID's batch knows only its own retrefs; a3's would be invisible on OLD_MID.
      return mid === OLD_MID
        ? { txns: [{ retref: "rt-a1", setlstat: "Accepted" }, { retref: "rt-a2", setlstat: "Accepted" }] }
        : { txns: [{ retref: "rt-a3", setlstat: "Rejected" }] };
    },
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const asked = r.trace.gateway.map((g) => `${g.path} ${g.url.searchParams.get("merchid")} ${g.url.searchParams.get("date")}`).sort();
  assertEquals(asked, [`/settlestat ${OLD_MID} 20261001`, `/settlestat ${NEW_MID} 20261001`].sort());
  const moved = Object.fromEntries((r.body.updated as any[]).map((u) => [u.paymentId, u.to]));
  assertEquals(moved, { a1: "settled", a2: "settled", a3: "returned" });
  assertEquals(r.body.daysChecked, ["20261001"]);
});

Deno.test("reconcile skips (and logs) a pending bank payment with no merchant of record — never the current MID", async () => {
  const r = await call({ action: "reconcile" }, {
    payments: [ACH("a1", 41, "rt-a1", "2026-10-01"), ACH("orphan", null, "rt-orphan", "2026-10-02")],
    attempts: ATTEMPTS,
    gateway: () => ({ txns: [{ retref: "rt-a1", setlstat: "Accepted" }, { retref: "rt-orphan", setlstat: "Accepted" }] }),
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const mids = r.trace.gateway.map((g) => g.url.searchParams.get("merchid"));
  assertEquals(mids, [OLD_MID], "only the payment with a merchant of record is asked about");
  assertEquals(r.trace.gateway[0].url.searchParams.get("date"), "20261001", "the orphan's day is never fetched");
  assertEquals((r.body.updated as any[]).map((u) => u.paymentId), ["a1"]);
  assert(faultCodes(r.trace).includes("payment_no_merchant_of_record"), JSON.stringify(r.trace.errors));
});

Deno.test("reconcile files an orphan ONCE a day, not once a visit, and a new orphan at once", async () => {
  const orphan = ACH("orphan", null, "rt-orphan", "2026-10-02");
  const earlier = {
    client_id: TENANT, source: "edge:portal-payments", code: "payment_no_merchant_of_record",
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), context: { paymentIds: ["orphan"] },
  };
  // Filed two hours ago: this visit files nothing more about it.
  const again = await call({ action: "reconcile" }, { payments: [orphan], attempts: ATTEMPTS, priorErrors: [earlier] });
  assertEquals(again.status, 200, JSON.stringify(again.body));
  assertEquals(again.trace.errorReads, 1, "it looked for the earlier row");
  assertEquals(faultCodes(again.trace), [], JSON.stringify(again.trace.errors));
  // Filed YESTERDAY: filed again today.
  const stale = { ...earlier, created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
  const nextDay = await call({ action: "reconcile" }, { payments: [orphan], attempts: ATTEMPTS, priorErrors: [stale] });
  assertEquals(faultCodes(nextDay.trace), ["payment_no_merchant_of_record"], JSON.stringify(nextDay.trace.errors));
  // A SECOND orphan the earlier row never named: filed now, naming both.
  const second = ACH("orphan2", null, "rt-orphan2", "2026-10-03");
  const fresh = await call({ action: "reconcile" }, { payments: [orphan, second], attempts: ATTEMPTS, priorErrors: [earlier] });
  assertEquals(faultCodes(fresh.trace), ["payment_no_merchant_of_record"], JSON.stringify(fresh.trace.errors));
  assertEquals((fresh.trace.errors[0].context as any).paymentIds, ["orphan", "orphan2"]);
  // Another tenant's row about the same id does not count for this one.
  const elsewhere = await call({ action: "reconcile" }, { payments: [orphan], attempts: ATTEMPTS, priorErrors: [{ ...earlier, client_id: "bravo-barns" }] });
  assertEquals(faultCodes(elsewhere.trace), ["payment_no_merchant_of_record"], JSON.stringify(elsewhere.trace.errors));
});

// ─── 5. The tenant filter is part of the merchant of record ───────────────────────────────────
Deno.test("an attempt id that belongs to ANOTHER tenant is no merchant of record: refused, nothing sent", async () => {
  const r = await call({ action: "void_payment", paymentId: "p-card" }, {
    payments: [CARD],
    attempts: [{ id: 41, merchid: OLD_MID, client_id: "bravo-barns" }],
  });
  assertEquals(r.status, 409, JSON.stringify(r.body));
  assertEquals(r.trace.gateway, [], "another tenant's MID is never asked");
  assert(faultCodes(r.trace).includes("payment_no_merchant_of_record"), JSON.stringify(r.trace.errors));
});

// ─── 6. Billing fields on the shipped handler ─────────────────────────────────────────────────
const ORDER = { id: "o-1", short_code: "SS-AAAAAAAAAA", total_cents: 100000 };
const CONTACT = { name: "Pat Example", phone: "5555550101", street: "12 Main St", city: "Springfield", zip: "12345-6789" };
// sales_rep is orders:edit by preset; the override takes this one down to view.
const VIEWER = { client_id: TENANT, role: "user", title: "sales_rep", access: { orders: "view" }, user_id: USER_ID };
const PLATFORM_OP = { user_id: USER_ID, email: "ops@example.test", can_write: true, can_bill: false, support_only: false };
const APPROVED = (path: string) =>
  path === "/auth"
    ? { respstat: "A", respcode: "000", retref: "rt-new", amount: "1000.00", token: "9413948780281111", authcode: "123456", avsresp: "Y", cvvresp: "M" }
    : { respstat: "A", respcode: "00", retref: "rf-1" };
const authBody = (t: Trace) => (t.gateway.find((g) => g.path === "/auth") ?? { body: null }).body;
const attemptInsert = (t: Trace) => (t.writes.find((w) => w.table === "payment_attempts" && w.verb === "insert") ?? { row: null }).row;

Deno.test("pay_options: billingPrefill for a member who can take the card, from the delivery address", async () => {
  const r = await call({ action: "pay_options", orderId: "o-1" }, { order: ORDER, contact: CONTACT });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  // ZIP+4 through cpBillingFields: nine digits.
  assertEquals(r.body.billingPrefill, { name: "Pat Example", street: "12 Main St", zip: "123456789" });
  // An older contact shape (address/postalCode) is read the same way (addressFrom).
  const old = await call({ action: "pay_options", orderId: "o-1" }, { order: ORDER, contact: { name: "Pat Example", address: "7 Oak Ave", postalCode: "54321" } });
  assertEquals(old.body.billingPrefill, { name: "Pat Example", street: "7 Oak Ave", zip: "54321" });
});

Deno.test("pay_options: NO billingPrefill for an orders:view member or an operator, and the address is nowhere in the answer", async () => {
  const viewer = await call({ action: "pay_options", orderId: "o-1" }, { order: ORDER, contact: CONTACT, member: VIEWER });
  assertEquals(viewer.status, 200, JSON.stringify(viewer.body));
  assertEquals(viewer.body.billingPrefill, null);
  const op = await call({ action: "pay_options", orderId: "o-1", targetClientId: TENANT }, {
    order: ORDER, contact: CONTACT, op: PLATFORM_OP,
    member: { client_id: "ops-home", role: "user", title: "office_staff", access: null, user_id: USER_ID },
  });
  assertEquals(op.status, 200, JSON.stringify(op.body));
  assertEquals(op.body.billingPrefill, null);
  for (const r of [viewer, op]) {
    const text = JSON.stringify(r.body);
    for (const v of ["12 Main St", "12345", "Pat Example"]) assert(!text.includes(v), `${v} leaked: ${text}`);
  }
});

Deno.test("charge, keyed: the typed name, street and ZIP reach /auth with ecomind E, and the attempt records the names", async () => {
  const r = await call({
    action: "charge", orderId: "o-1", payToken: "9413948780281111", entry: "keyed", confirmChargeCents: 100000,
    name: " Card Holder ", address: "9 Elm Rd", postal: "54321-0001",
  }, { order: ORDER, contact: CONTACT, gateway: APPROVED });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const b = authBody(r.trace);
  assertEquals([b.name, b.address, b.postal, b.ecomind, b.merchid], ["Card Holder", "9 Elm Rd", "543210001", "E", NEW_MID]);
  for (const k of ["cvv2", "profile", "cof", "cofscheduled", "track"]) assert(!(k in b), `${k} sent`);
  const att = attemptInsert(r.trace);
  assertEquals(att.ecomind, "E");
  assertEquals(att.sent_fields, Object.keys(b).sort(), "sent_fields are the keys /auth was sent");
  for (const k of ["address", "name", "postal"]) assert(att.sent_fields.includes(k), String(att.sent_fields));
  const pay = r.trace.writes.find((w) => w.table === "payments" && w.verb === "insert");
  assertEquals(pay?.row.entry_mode, "ECommerce");
});

Deno.test("charge, swipe: NO ecomind on /auth (R is recurring), recorded as none, entry_mode Swipe", async () => {
  const track = "02" + "A".repeat(300) + "03";
  const r = await call({ action: "charge", orderId: "o-1", payToken: track, entry: "swipe", confirmChargeCents: 100000 }, {
    order: ORDER, contact: CONTACT, gateway: APPROVED,
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const b = authBody(r.trace);
  assert(!("ecomind" in b), `ecomind sent on a swipe: ${JSON.stringify(Object.keys(b))}`);
  assertEquals(b.account, track);
  // The modal sends no billing fields for a swipe: the contact's name, no street, no ZIP.
  assertEquals([b.name, "address" in b, "postal" in b], ["Pat Example", false, false]);
  const att = attemptInsert(r.trace);
  assertEquals(att.ecomind, null);
  assert(!att.sent_fields.includes("ecomind"), String(att.sent_fields));
  const pay = r.trace.writes.find((w) => w.table === "payments" && w.verb === "insert");
  assertEquals(pay?.row.entry_mode, "Swipe");
});

Deno.test("charge from production's page (no billing fields): the auth it always got, contact name and ecomind E", async () => {
  const r = await call({ action: "charge", orderId: "o-1", payToken: "9413948780281111", confirmChargeCents: 100000 }, {
    order: ORDER, contact: CONTACT, gateway: APPROVED,
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const b = authBody(r.trace);
  assertEquals([b.name, b.ecomind, "address" in b, "postal" in b], ["Pat Example", "E", false, false]);
});
