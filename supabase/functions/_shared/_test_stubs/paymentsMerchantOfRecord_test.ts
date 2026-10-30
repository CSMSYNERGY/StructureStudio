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
//      street and ZIP with ecomind "T" (a builder keyed it: Fiserv (CardPointe integrations),
//      2026-10-14), read back as entry_mode "Moto"; a swipe sends no ecomind; a page that sends
//      nothing gets its contact's name and, since 2026-10-14, T as well.
//   7. Fiserv's 2026-10-14 answers on the handler (one change set, 2026-10-14):
//      a. a BANK payment is never a swipe, on charge and charge_adhoc alike: ecomind E, never Swipe;
//      b. `newCardNeeded: true` on a failure that reached /auth and did not stand (a decline, a voided
//         partial), and on nothing refused before it or blocked;
//      c. a pending bank payment cannot be refunded while it is clearing (seven days); a same-day void
//         still goes to the gateway, and a void it refuses does not tell the page to refund instead;
//         past the hold it refunds like a settled one, so no order is frozen for good;
//      d. reconcile reads /funding for pending bank payments AND settled ones inside their return
//         window: a payment listed cleanly settles, an R-code returns it (late, too), a return it
//         cannot read holds it and files the field names; each (merchant, day) is read once, only
//         days that are over, at most 8 calls, clearing payments first and each payment's oldest
//         unread day first, and funding_checked_through keeps the place between sweeps (without the
//         column it reads no funding at all and says so once a day). It books an R-code as
//         return_code, files a return on the test system as info, never stores a settlestat word as
//         the code, stops its funding calls at the first refusal, files its gateway failures and an
//         unknown funding shape once a DAY (no bodies, no values), and only counts a row its guarded
//         UPDATE handed back. settlestat's answer is read whatever it is wrapped in, and its
//         "Accepted" settles a bank payment only after the seven days.
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
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";
import { type LedgerRefund, type RefundLedger, refundLedger } from "./refundLedgerFake.ts";

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

type Pay = { id: string; order_id: string; amount_cents: number; gateway: string; gateway_txn_id: string; attempt_id: number | null; voided_at?: string | null; funding_state?: string; received_at?: string; method?: string; note?: string | null; funding_checked_through?: string | null };
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
  /** Declines this member made in the last hour (the charge throttle's count). */
  declines?: number;
  /** Payment ids whose guarded UPDATE matches no row (voided or refunded since the read). */
  updateMisses?: string[];
  /** Payment ids whose UPDATE fails outright. */
  updateFails?: string[];
  /** A database without migration 309: a payments select naming funding_checked_through is refused. */
  noCursorColumn?: boolean;
  /** Refunds already in the ledger (migration 349). */
  refunds?: Partial<LedgerRefund>[];
  /** Set by call(): the ledger over this call's copies of `payments`. */
  ledger?: RefundLedger;
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
      // charge_adhoc's counter sale.
      if (verb === "insert") { trace.writes.push({ table, verb, row: argOf(ops, verb)[0] }); return { data: { id: "o-adhoc" }, error: null }; }
      return { data: world.order && world.order.id === eqOf(ops, "id") ? { ...world.order } : null, error: null };
    case "designs":
      // The charge path reads the contact; readOrderMoney reads the lines (none: the order total stands).
      return { data: String(argOf(ops, "select")[0] ?? "").includes("contact") && world.contact !== undefined ? { contact: world.contact } : null, error: null };
    case "change_orders":
      return { data: [], error: null };
    case "invoice_sends":
      return { data: null, error: null };
    case "payment_refunds":
      // void_payment's in-flight check and reconcile's refund pass (migration 349).
      return world.ledger!.read(ops);
    case "client_settings":
      return { data: world.settings === undefined ? { payments_online_enabled: true, cardpointe_merchid: NEW_MID, billing_exempt: true, business_name: "Acme Sheds" } : world.settings, error: null };
    case "payment_attempts": {
      if (verb) {
        trace.writes.push({ table, verb, row: argOf(ops, verb)[0] });
        return { data: verb === "insert" ? { id: 501 } : null, error: null };
      }
      // The decline throttle's head count.
      if ((argOf(ops, "select")[1] as any)?.count) return { data: null, count: world.declines ?? 0, error: null };
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
        const id = eqOf(ops, "id");
        if (verb === "update" && (world.updateFails ?? []).includes(id)) return { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
        if (verb === "update" && (world.updateMisses ?? []).includes(id)) return { data: [], error: null };
        trace.writes.push({ table, verb, row: argOf(ops, verb)[0] });
        if (verb === "insert") return { data: { id: "pay-new" }, error: null };
        return { data: has(ops, "select") ? [{ id }] : null, error: null };
      }
      const all = world.payments ?? [];
      const id = eqOf(ops, "id");
      if (id !== undefined) return { data: all.find((p) => p.id === id) ?? null, error: null };
      // What PostgREST answers for a column the database does not have.
      if (world.noCursorColumn && String(argOf(ops, "select")[0] ?? "").includes("funding_checked_through")) {
        return { data: null, error: { code: "42703", message: "column payments.funding_checked_through does not exist" } };
      }
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

async function call(body: Record<string, unknown>, given: World) {
  // The refund steps (migration 349) move money on the payment, so each call works on its own copies:
  // a constant like CARD is never changed by the test before it.
  const payments = (given.payments ?? []).map((p) => ({ ...p }));
  const world: World = { ...given, payments, ledger: refundLedger(payments, given.refunds ?? []) };
  const trace: Trace = { gateway: [], errors: [], errorReads: 0, writes: [], audit: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  stubRpc.rpc = (fn: string, args: any) => world.ledger!.rpc(fn, args);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(GATEWAY + "/")) return Promise.reject(new Error(`TEST FAILURE: unexpected fetch to ${href}`));
    const url = new URL(href);
    const path = url.pathname.replace(new URL(GATEWAY).pathname, "");
    const sent = init?.body ? JSON.parse(String(init.body)) : null;
    trace.gateway.push({ path, body: sent, url });
    const out = world.gateway ? world.gateway(path, sent, url) : { respstat: "A", respcode: "00", retref: "rf-1" };
    // A Response is sent as it is (a 429 with the limiter's header); a number is a bare status.
    if (out instanceof Response) return Promise.resolve(out);
    return Promise.resolve(typeof out === "number" ? new Response("", { status: out }) : new Response(JSON.stringify(out), { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await PAYMENTS(new Request("https://stub.supabase.co/functions/v1/portal-payments", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json(), trace, payments, ledger: world.ledger! };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubRpc.rpc = null;
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
  assertEquals(r.trace.gateway[0].body, { merchid: OLD_MID, retref: "rt-card", amount: "1000.00", orderid: r.ledger.refunds[0].gateway_orderid });
  // Since 349 the refund carries its OWN order id (the ledger row's), so a lost answer can be looked up by it.
  assert(/^ssr_/.test(String(r.trace.gateway[0].body.orderid)), JSON.stringify(r.trace.gateway[0].body));
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
  assertEquals(f.trace.gateway[0].body, { merchid: OLD_MID, retref: "rt-card", amount: "25.00", orderid: f.ledger.refunds[0].gateway_orderid });
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
    gateway: (path, _b, url) => {
      // The funding days list nothing, so settlestat decides (the sales are over seven days old, so
      // its "Accepted" may settle a bank payment).
      if (path === "/funding") return { txns: [] };
      const mid = url.searchParams.get("merchid");
      // Each MID's batch knows only its own retrefs; a3's would be invisible on OLD_MID.
      return mid === OLD_MID
        ? { txns: [{ retref: "rt-a1", setlstat: "Accepted" }, { retref: "rt-a2", setlstat: "Accepted" }] }
        : { txns: [{ retref: "rt-a3", setlstat: "Rejected" }] };
    },
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const asked = r.trace.gateway.filter((g) => g.path === "/settlestat")
    .map((g) => `${g.path} ${g.url.searchParams.get("merchid")} ${g.url.searchParams.get("date")}`).sort();
  // The gateway is asked MMDD (cardpointe.ts cpReportDay); reconcile's own day keys stay YYYYMMDD.
  assertEquals(asked, [`/settlestat ${OLD_MID} 1001`, `/settlestat ${NEW_MID} 1001`].sort());
  const moved = Object.fromEntries((r.body.updated as any[]).map((u) => [u.paymentId, u.to]));
  assertEquals(moved, { a1: "settled", a2: "settled", a3: "returned" });
  assertEquals(r.body.daysChecked, ["20261001"]);
  // /funding is asked on the payments' own MIDs too, and never the current one or the default.
  for (const g of r.trace.gateway) assert([OLD_MID, NEW_MID].includes(String(g.url.searchParams.get("merchid"))), g.url.href);
  // A settlestat "Rejected" is a status WORD: the return is booked with no code, never "REJECTED".
  const ret = r.trace.writes.find((w) => w.table === "payments" && w.verb === "update" && w.row.funding_state === "returned");
  assertEquals(ret?.row.return_code, null);
  // A return on the TEST system is expected (every UAT bank payment comes back R03): info, not a fault.
  const filed = r.trace.errors.filter((e) => e.code === "ach_returned");
  assertEquals(filed.map((e) => e.severity), ["info"]);
});

Deno.test("reconcile skips (and logs) a pending bank payment with no merchant of record — never the current MID", async () => {
  const r = await call({ action: "reconcile" }, {
    payments: [ACH("a1", 41, "rt-a1", "2026-10-01"), ACH("orphan", null, "rt-orphan", "2026-10-02")],
    attempts: ATTEMPTS,
    gateway: (path) => path === "/funding"
      ? { txns: [] }
      : { txns: [{ retref: "rt-a1", setlstat: "Accepted" }, { retref: "rt-orphan", setlstat: "Accepted" }] },
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const mids = [...new Set(r.trace.gateway.map((g) => g.url.searchParams.get("merchid")))];
  assertEquals(mids, [OLD_MID], "only the payment with a merchant of record is asked about");
  const settle = r.trace.gateway.filter((g) => g.path === "/settlestat");
  assertEquals(settle.map((g) => g.url.searchParams.get("date")), ["1001"], "the orphan's day is never fetched");
  // The funding pass starts at a1's own sale day; the orphan (received the day after) spends nothing.
  const funding = r.trace.gateway.filter((g) => g.path === "/funding").map((g) => g.url.searchParams.get("date"));
  assertEquals(funding[0], "1001");
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

Deno.test("charge, keyed: the typed name, street and ZIP reach /auth with ecomind T, and the attempt records the names", async () => {
  // Fiserv (CardPointe integrations), 2026-10-14: a card the builder keys is T, not E.
  const r = await call({
    action: "charge", orderId: "o-1", payToken: "9413948780281111", entry: "keyed", confirmChargeCents: 100000,
    name: " Card Holder ", address: "9 Elm Rd", postal: "54321-0001",
  }, { order: ORDER, contact: CONTACT, gateway: APPROVED });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const b = authBody(r.trace);
  assertEquals([b.name, b.address, b.postal, b.ecomind, b.merchid], ["Card Holder", "9 Elm Rd", "543210001", "T", NEW_MID]);
  for (const k of ["cvv2", "profile", "cof", "cofscheduled", "track"]) assert(!(k in b), `${k} sent`);
  const att = attemptInsert(r.trace);
  assertEquals(att.ecomind, "T");
  assertEquals(att.sent_fields, Object.keys(b).sort(), "sent_fields are the keys /auth was sent");
  for (const k of ["address", "name", "postal"]) assert(att.sent_fields.includes(k), String(att.sent_fields));
  const pay = r.trace.writes.find((w) => w.table === "payments" && w.verb === "insert");
  // The gateway gave no entrymode: what we sent, a mail/telephone order.
  assertEquals(pay?.row.entry_mode, "Moto");
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

Deno.test("charge from production's page (no billing fields, no entry): the contact's name, and T, since it is still a builder keying", async () => {
  // It used to get E, the silent default. A page that sends no `entry` is a builder keying a card all
  // the same, so it gets the same T as the new page (ecomindFor).
  const r = await call({ action: "charge", orderId: "o-1", payToken: "9413948780281111", confirmChargeCents: 100000 }, {
    order: ORDER, contact: CONTACT, gateway: APPROVED,
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const b = authBody(r.trace);
  assertEquals([b.name, b.ecomind, "address" in b, "postal" in b], ["Pat Example", "T", false, false]);
});

// ─── 7a. A bank payment is never a swipe; charge_adhoc keys T too ─────────────────────────────
const ADHOC = { action: "charge_adhoc", amountCents: 5000, confirmChargeCents: 5000, payToken: "9413948780281111" };
const APPROVED_50 = (path: string) =>
  path === "/auth" ? { respstat: "A", respcode: "000", retref: "rt-adhoc", amount: "50.00", token: "9413948780281111" } : APPROVED(path);

Deno.test("charge_adhoc, keyed: T on the wire, T on the attempt, Moto on the payment", async () => {
  const r = await call({ ...ADHOC, entry: "keyed", name: "Walk In" }, { gateway: APPROVED_50 });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(authBody(r.trace).ecomind, "T");
  assertEquals(attemptInsert(r.trace).ecomind, "T");
  const pay = r.trace.writes.find((w) => w.table === "payments" && w.verb === "insert");
  assertEquals(pay?.row.entry_mode, "Moto");
});

Deno.test("Card > Swipe > Bank: a BANK payment posted with entry 'swipe' sends ecomind E and is never labelled Swipe", async () => {
  // The modal never reset `entry` when the method changed. charge and charge_adhoc both honour the
  // swipe flag only on a card now, and invoicePayment ignores it on a bank payment as well.
  const onOrder = await call({ action: "charge", orderId: "o-1", rail: "ach", payToken: "9413948780281111", entry: "swipe", confirmChargeCents: 100000 }, {
    order: ORDER, contact: CONTACT, gateway: APPROVED,
  });
  const counter = await call({ ...ADHOC, rail: "ach", entry: "swipe", name: "Walk In" }, { gateway: APPROVED_50 });
  for (const [label, r] of [["charge", onOrder], ["charge_adhoc", counter]] as const) {
    assertEquals(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
    const b = authBody(r.trace);
    assertEquals([b.accttype, b.ecomind], ["ECHK", "E"], `${label}: ${JSON.stringify(b)}`);
    assertEquals(attemptInsert(r.trace).ecomind, "E", label);
    const pay = r.trace.writes.find((w) => w.table === "payments" && w.verb === "insert");
    assertEquals(pay?.row.entry_mode, "ECommerce", label);
    assertEquals(pay?.row.funding_state, "pending", label);
  }
});

// ─── 7b. newCardNeeded: only a failure that reached /auth and did not stand ───────────────────
const DECLINED = (path: string) => path === "/auth" ? { respstat: "C", respcode: "05", resptext: "Do not honor" } : APPROVED(path);
const PARTIAL = (path: string) =>
  path === "/auth" ? { respstat: "A", respcode: "000", retref: "rt-part", amount: "400.00" } : { respstat: "A", respcode: "00", retref: "rt-part" };
const CHARGE = { action: "charge", orderId: "o-1", payToken: "9413948780281111", entry: "keyed", confirmChargeCents: 100000 };

Deno.test("newCardNeeded: a decline and a voided partial carry it, on charge and charge_adhoc", async () => {
  const decline = await call(CHARGE, { order: ORDER, contact: CONTACT, gateway: DECLINED });
  assertEquals(decline.status, 402, JSON.stringify(decline.body));
  assertEquals(decline.body, { error: "Do not honor", blocking: false, newCardNeeded: true });

  const partial = await call(CHARGE, { order: ORDER, contact: CONTACT, gateway: PARTIAL });
  assertEquals(partial.status, 402, JSON.stringify(partial.body));
  assertEquals(partial.body.newCardNeeded, true);
  assertEquals(partial.trace.gateway.map((g) => g.path), ["/auth", "/void"]);
  // The builder reads about the card and the cardholder, and is promised no release of the hold.
  assert(/^The card only approved \$400\.00 of \$1000\.00/.test(partial.body.error), partial.body.error);
  assert(!/your card|released/i.test(partial.body.error), partial.body.error);

  const adhoc = await call({ ...ADHOC, entry: "keyed" }, { gateway: DECLINED });
  assertEquals(adhoc.status, 402, JSON.stringify(adhoc.body));
  // The counter sale's order stays (nothing was collected on it), and the modal is told to re-key.
  assertEquals([adhoc.body.newCardNeeded, adhoc.body.orderId], [true, "o-adhoc"]);
});

Deno.test("newCardNeeded: never on a refusal before /auth, nor on an unknown (a blocked order)", async () => {
  // The amount changed: refused before the card is touched.
  const amount = await call({ ...CHARGE, confirmChargeCents: 99999 }, { order: ORDER, contact: CONTACT, gateway: DECLINED });
  assertEquals(amount.status, 400, JSON.stringify(amount.body));
  // Five declines this hour: the throttle refuses before /auth.
  const throttled = await call(CHARGE, { order: ORDER, contact: CONTACT, gateway: DECLINED, declines: 5 });
  assertEquals(throttled.status, 429, JSON.stringify(throttled.body));
  // The gateway fell over: we do not know whether the card was charged, so the order is blocked.
  const unknown = await call(CHARGE, { order: ORDER, contact: CONTACT, gateway: (p) => p === "/auth" ? 502 : APPROVED(p) });
  assertEquals(unknown.status, 409, JSON.stringify(unknown.body));
  assertEquals(unknown.body.blocking, true);
  for (const r of [amount, throttled, unknown]) {
    assert(!("newCardNeeded" in r.body), JSON.stringify(r.body));
  }
  assertEquals(amount.trace.gateway, [], "nothing reached the gateway");
  assertEquals(throttled.trace.gateway, [], "nothing reached the gateway");
});

// ─── 7c. A pending bank payment: no refund, a void still tried ────────────────────────────────
const PENDING_ACH: Pay = { ...CARD, id: "p-ach", gateway_txn_id: "rt-ach", method: "ach", funding_state: "pending" };

Deno.test("refund_payment on a bank payment still clearing: refused with the clearing sentence, nothing sent, nothing written", async () => {
  const r = await call({ action: "refund_payment", paymentId: "p-ach" }, { payments: [PENDING_ACH], attempts: ATTEMPTS });
  assertEquals(r.status, 409, JSON.stringify(r.body));
  assertEquals(r.body, { error: "This bank payment is still clearing. It can be refunded once it clears.", reason: "ach_pending" });
  assertEquals(r.trace.gateway, [], "the gateway is never asked");
  assertEquals(r.trace.writes.filter((w) => w.table === "payments"), [], "nothing is marked refunded");
  // A bank payment that has CLEARED refunds as before, and so does a card.
  const cleared = await call({ action: "refund_payment", paymentId: "p-ach" }, { payments: [{ ...PENDING_ACH, funding_state: "settled" }], attempts: ATTEMPTS });
  assertEquals(cleared.status, 200, JSON.stringify(cleared.body));
  assertEquals(cleared.trace.gateway.map((g) => g.path), ["/refund"]);
});

Deno.test("void_payment on a bank payment still clearing still goes to the gateway; a void it refuses never says 'refund it instead'", async () => {
  const ok = await call({ action: "void_payment", paymentId: "p-ach" }, { payments: [PENDING_ACH], attempts: ATTEMPTS });
  assertEquals(ok.status, 200, JSON.stringify(ok.body));
  assertEquals(ok.trace.gateway.map((g) => g.path), ["/void"]);
  assertEquals(ok.body, { ok: true, voided: true });
  // Past the void window: the portal chains to refund_payment on `settled: true`, and that refund
  // would be refused, so the answer carries the clearing sentence instead.
  const late = await call({ action: "void_payment", paymentId: "p-ach" }, {
    payments: [PENDING_ACH], attempts: ATTEMPTS, gateway: () => ({ respstat: "C", respcode: "00", resptext: "Txn not voidable" }),
  });
  assertEquals(late.status, 409, JSON.stringify(late.body));
  assertEquals(late.body, { error: "This bank payment is still clearing. It can be refunded once it clears.", reason: "ach_pending" });
  assertEquals(late.trace.writes.filter((w) => w.table === "payments"), []);
  // A CARD the gateway will not void still says settled, as it always did.
  const card = await call({ action: "void_payment", paymentId: "p-card" }, {
    payments: [CARD], attempts: ATTEMPTS, gateway: () => ({ respstat: "C", respcode: "00", resptext: "Txn not voidable" }),
  });
  assertEquals(card.status, 409, JSON.stringify(card.body));
  assertEquals(card.body.settled, true);
});

Deno.test("a bank payment past its seven-day hold that still reads pending: refunded like a settled one, so no order is frozen for good", async () => {
  // Only reconcile moves a bank payment out of pending, and neither reader has been seen live. A
  // payment no reader ever moves must not leave its order unrefundable from the portal.
  const old = { ...PENDING_ACH, received_at: new Date(Date.now() - 8 * 86400000).toISOString() };
  const refund = await call({ action: "refund_payment", paymentId: "p-ach" }, { payments: [old], attempts: ATTEMPTS });
  assertEquals(refund.status, 200, JSON.stringify(refund.body));
  assertEquals(refund.trace.gateway.map((g) => g.path), ["/refund"]);
  // A void the gateway refuses now points at the refund (`settled: true`), worded for a bank payment.
  const late = await call({ action: "void_payment", paymentId: "p-ach" }, {
    payments: [old], attempts: ATTEMPTS, gateway: () => ({ respstat: "C", respcode: "00", resptext: "Txn not voidable" }),
  });
  assertEquals(late.status, 409, JSON.stringify(late.body));
  assertEquals(late.body, { error: "That bank payment can't be cancelled any more — refund it instead.", settled: true });
  // Six days in, it is still held.
  const young = { ...PENDING_ACH, received_at: new Date(Date.now() - 6 * 86400000).toISOString() };
  const held = await call({ action: "refund_payment", paymentId: "p-ach" }, { payments: [young], attempts: ATTEMPTS });
  assertEquals([held.status, held.body.reason], [409, "ach_pending"]);
  assertEquals(held.trace.gateway, []);
});

// ─── 7d. reconcile reads /funding ─────────────────────────────────────────────────────────────
/** A UTC day `n` days before today, as YYYY-MM-DD. Day 2 and older are always readable funding days
 *  (FUNDING_DAY_READABLE_AFTER_MS); yesterday and today never are. */
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
/** A day as the gateway is asked for it: MMDD (cardpointe.ts cpReportDay). */
const ymd = (iso: string) => iso.replace(/-/g, "").slice(4);
/** The funding answer for a day that carries this retref's R03: an INVENTED shape (none seen live). */
const FUNDED_R03 = (retref: string) => ({ fundingdate: "x", txns: [{ retref: "100200300999", type: "SALE" }, { retref, type: "RETURN", returncode: "R03" }] });
/** A day that lists this retref as funded, cleanly. Invented too. */
const FUNDED = (retref: string) => ({ fundingdate: "x", txns: [{ retref, type: "SALE", amount: "500.00" }] });
const fundingDays = (t: Trace) => t.gateway.filter((g) => g.path === "/funding").map((g) => g.url.searchParams.get("date"));
const paymentUpdates = (t: Trace) => t.writes.filter((w) => w.table === "payments" && w.verb === "update");
/** The funding_checked_through each payment was moved to, from the trace (the fake does not keep it). */
const cursorsWritten = (t: Trace, ids: string[]) => {
  const out: Record<string, string> = {};
  // The fake does not say which id an UPDATE was for, so this reads them in the order they ran.
  const writes = paymentUpdates(t).filter((w) => "funding_checked_through" in w.row);
  writes.forEach((w, i) => { out[ids[i]] = w.row.funding_checked_through; });
  return out;
};

Deno.test("reconcile: an R03 in the funding data returns the payment with return_code R03, before settlestat can settle it", async () => {
  const p = ACH("a1", 41, "rt-a1", daysAgo(4));
  const r = await call({ action: "reconcile" }, {
    payments: [p],
    attempts: ATTEMPTS,
    // settlestat would call it settled; the funding data says it came back.
    gateway: (path, _b, url) =>
      path === "/funding"
        ? (url.searchParams.get("date") === ymd(daysAgo(2)) ? FUNDED_R03("rt-a1") : { txns: [] })
        : { txns: [{ retref: "rt-a1", setlstat: "Accepted" }] },
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.updated, [{ paymentId: "a1", to: "returned", returnCode: "R03" }]);
  const writes = paymentUpdates(r.trace);
  assertEquals(writes.length, 1, "returned once, never then settled, and no place kept for a returned payment");
  assertEquals([writes[0].row.funding_state, writes[0].row.return_code], ["returned", "R03"]);
  assert(String(writes[0].row.void_reason).includes("R03"), String(writes[0].row.void_reason));
  // The funding days asked: the sale day to the day before yesterday, on the payment's own MID, YYYYMMDD.
  const asked = r.trace.gateway.filter((g) => g.path === "/funding");
  assertEquals(asked.map((g) => g.url.searchParams.get("date")), [daysAgo(4), daysAgo(3), daysAgo(2)].map(ymd));
  for (const g of asked) assertEquals(g.url.searchParams.get("merchid"), OLD_MID);
  assertEquals(r.body.fundingChecked, 3);
  assertEquals(r.body.fundingSkipped, 0);
  // A UAT return is info; nothing else was filed, and nothing was emailed (no other fetch exists).
  const filed = r.trace.errors.filter((e) => e.code === "ach_returned");
  assertEquals(filed.map((e) => [e.severity, (e.context as any).returnCode]), [["info", "R03"]]);
  assertEquals(r.trace.errors.filter((e) => e.code !== "ach_returned"), []);
});

Deno.test("reconcile: a bank payment the funding data lists cleanly SETTLES, keeping its place in the same write", async () => {
  // The finding: nothing moved a bank payment out of pending but settlestat, whose reading found
  // nothing, so a funded payment sat pending for good (no refund, no further payment, no Payment
  // Received). Fiserv named the funding data as where a bank payment's fate shows.
  const r = await call({ action: "reconcile" }, {
    payments: [ACH("a1", 41, "rt-a1", daysAgo(4))],
    attempts: ATTEMPTS,
    gateway: (path, _b, url) => path === "/funding" && url.searchParams.get("date") === ymd(daysAgo(3)) ? FUNDED("rt-a1") : { txns: [] },
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.updated, [{ paymentId: "a1", to: "settled" }]);
  const w = paymentUpdates(r.trace);
  assertEquals(w.length, 1);
  assertEquals([w[0].row.funding_state, w[0].row.funding_checked_through], ["settled", daysAgo(2)]);
  // settled by the funding data: settlestat spends nothing on it.
  assertEquals(r.trace.gateway.filter((g) => g.path === "/settlestat"), []);
});

Deno.test("reconcile: settlestat's 'Accepted' does NOT settle a bank payment inside its seven days; after them it does", async () => {
  // "Accepted" is the processor taking the debit, before an R03 can post in the funding data.
  const accepted = (path: string) => path === "/funding" ? { txns: [] } : { txns: [{ retref: "rt-a1", setlstat: "Accepted" }] };
  const young = await call({ action: "reconcile" }, { payments: [ACH("a1", 41, "rt-a1", daysAgo(3))], attempts: ATTEMPTS, gateway: accepted });
  assertEquals(young.body.updated, []);
  assertEquals(paymentUpdates(young.trace).filter((w) => w.row.funding_state), [], "never settled");
  const old = await call({ action: "reconcile" }, { payments: [ACH("a1", 41, "rt-a1", daysAgo(9))], attempts: ATTEMPTS, gateway: accepted });
  assertEquals(old.body.updated, [{ paymentId: "a1", to: "settled" }]);
  // A "Rejected" returns it at any age.
  const rejected = await call({ action: "reconcile" }, {
    payments: [ACH("a1", 41, "rt-a1", daysAgo(3))], attempts: ATTEMPTS,
    gateway: (path) => path === "/funding" ? { txns: [] } : { txns: [{ retref: "rt-a1", setlstat: "Rejected" }] },
  });
  assertEquals(rejected.body.updated, [{ paymentId: "a1", to: "returned" }]);
});

Deno.test("reconcile: settlestat answering with a LIST of batches is read (it used to read nothing)", async () => {
  const r = await call({ action: "reconcile" }, {
    payments: [ACH("a1", 41, "rt-a1", "2026-10-01"), ACH("a2", 42, "rt-a2", "2026-10-01")],
    attempts: ATTEMPTS,
    gateway: (path) => path === "/funding"
      ? { txns: [] }
      : [{ merchid: OLD_MID, hoststat: "GB", txns: [{ retref: "rt-a1", setlstat: "Accepted" }] }, { merchid: OLD_MID, txns: [{ retref: "rt-a2", setlstat: "Rejected" }] }],
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(Object.fromEntries((r.body.updated as any[]).map((u) => [u.paymentId, u.to])), { a1: "settled", a2: "returned" });
});

Deno.test("reconcile: a LATE return (an R03 after the payment settled) is read from the funding data too", async () => {
  // The finding: settled bank payments were only asked about in settlestat, which carries no return
  // code, so a debit that funded and then came back was never seen.
  const settled: Pay = { ...ACH("s1", 41, "rt-s1", daysAgo(6)), funding_state: "settled", funding_checked_through: daysAgo(4) };
  const r = await call({ action: "reconcile" }, {
    payments: [settled],
    attempts: ATTEMPTS,
    gateway: (path, _b, url) => path === "/funding" && url.searchParams.get("date") === ymd(daysAgo(2)) ? FUNDED_R03("rt-s1") : { txns: [] },
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  // Read from the day after its place: the days before were read on an earlier sweep.
  assertEquals(fundingDays(r.trace), [daysAgo(3), daysAgo(2)].map(ymd));
  assertEquals(r.body.updated, [{ paymentId: "s1", to: "returned", returnCode: "R03" }]);
  assertEquals(paymentUpdates(r.trace).map((w) => [w.row.funding_state, w.row.return_code]), [["returned", "R03"]]);
  // A settled payment the guarded UPDATE no longer finds (voided since) is not counted.
  const gone = await call({ action: "reconcile" }, {
    payments: [settled], attempts: ATTEMPTS, updateMisses: ["s1"],
    gateway: (path) => path === "/funding" ? FUNDED_R03("rt-s1") : { txns: [] },
  });
  assertEquals(gone.body.updated, []);
});

Deno.test("reconcile: a return it cannot READ holds the payment (no funding settle, no settlestat settle) and files the field name once a day", async () => {
  // The finding: an R03 under a field the reader does not take ("status") or with words after it
  // read as "no return", silently. Now it holds the payment pending and names the field, never a value.
  const world: World = {
    payments: [ACH("a1", 41, "rt-a1", daysAgo(9))],   // past seven days: settlestat would settle it
    attempts: ATTEMPTS,
    gateway: (path, _b, url) => path === "/funding"
      ? (url.searchParams.get("date") === ymd(daysAgo(8)) ? { txns: [{ retref: "rt-a1", status: "R03 - No Account" }] } : { txns: [] })
      : { txns: [{ retref: "rt-a1", setlstat: "Accepted" }] },
  };
  const r = await call({ action: "reconcile" }, world);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.updated, []);
  assertEquals(paymentUpdates(r.trace).filter((w) => w.row.funding_state), [], "not settled, not returned");
  // Its place stops BEFORE the day it could not read, so that day is read again next sweep.
  assertEquals(cursorsWritten(r.trace, ["a1"]), { a1: daysAgo(9) });
  const rows = r.trace.errors.filter((e) => e.code === "reconcile_funding_return_unread");
  assertEquals(rows.length, 1, JSON.stringify(r.trace.errors));
  assertEquals(rows[0].severity, "info", "the test system");
  assertEquals((rows[0].context as any).payments.map((p: any) => [p.paymentId, p.keys]), [["a1", ["status"]]]);
  const text = JSON.stringify(rows[0]);
  for (const v of ["R03", "No Account", "rt-a1", OLD_MID]) assert(!text.includes(v), `${v} was filed: ${text}`);
  // Filed today already: the next visit files nothing more.
  const again = await call({ action: "reconcile" }, { ...world, priorErrors: [{ ...rows[0], client_id: TENANT, source: "edge:portal-payments", created_at: new Date().toISOString() }] });
  assertEquals(again.trace.errors.filter((e) => e.code === "reconcile_funding_return_unread"), []);
});

Deno.test("reconcile: each funding day is read ONCE: clearing payments first, each payment's oldest unread day first, and the next sweep starts where this one stopped", async () => {
  // The finding: a stateless sweep read the newest payment, then the old one from its sale day, and
  // never the days between; every visit spent the same calls on the same empty days.
  const fresh = ACH("new", 41, "rt-new", daysAgo(3));
  const old = ACH("old", 42, "rt-old", daysAgo(20));
  const settled: Pay = { ...ACH("set", 41, "rt-set", daysAgo(30)), funding_state: "settled", funding_checked_through: daysAgo(10) };
  const empty = () => ({ txns: [] });
  const first = await call({ action: "reconcile" }, { payments: [old, fresh, settled], attempts: ATTEMPTS, gateway: empty });
  assertEquals(first.status, 200, JSON.stringify(first.body));
  // One MID: each payment's first unread day, then each one's second, and so on; the settled one waits.
  assertEquals(fundingDays(first.trace), [20, 3, 19, 2, 18, 17, 16, 15].map((n) => ymd(daysAgo(n))));
  assertEquals(first.body.fundingChecked, 8);
  // Still owed: days 14..4 (11 of them). The settled payment's days are all among the old one's, so
  // they cost nothing extra.
  assertEquals(first.body.fundingSkipped, 11);
  assertEquals(first.body.updated, [], "an empty day moves nothing");
  // Each place moves through the unbroken run of days read: old to 15, fresh to 2, settled not at all.
  const placed = paymentUpdates(first.trace).map((w) => w.row.funding_checked_through).sort();
  assertEquals(placed, [daysAgo(15), daysAgo(2)].sort());

  // The next sweep starts there. Nothing read is asked for again.
  const second = await call({ action: "reconcile" }, {
    payments: [{ ...old, funding_checked_through: daysAgo(15) }, { ...fresh, funding_checked_through: daysAgo(2) }, settled],
    attempts: ATTEMPTS,
    gateway: empty,
  });
  assertEquals(fundingDays(second.trace), [14, 13, 12, 11, 10, 9, 8, 7].map((n) => ymd(daysAgo(n))));
  // And a payment read to the day before yesterday asks nothing until another day is over.
  const done = await call({ action: "reconcile" }, {
    payments: [{ ...fresh, funding_checked_through: daysAgo(2) }], attempts: ATTEMPTS, gateway: empty,
  });
  assertEquals(fundingDays(done.trace), []);
  assertEquals([done.body.fundingChecked, done.body.fundingSkipped], [0, 0]);
});

Deno.test("reconcile: a day that is not over is never read (yesterday's funding may still be filling up)", async () => {
  const r = await call({ action: "reconcile" }, { payments: [ACH("a1", 41, "rt-a1", daysAgo(1))], attempts: ATTEMPTS, gateway: () => ({ txns: [] }) });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(fundingDays(r.trace), []);
});

Deno.test("reconcile: a return found for a payment voided since the read is NOT counted (the guarded UPDATE handed nothing back)", async () => {
  const r = await call({ action: "reconcile" }, {
    payments: [ACH("a1", 41, "rt-a1", daysAgo(3))],
    attempts: ATTEMPTS,
    updateMisses: ["a1"],
    gateway: (path) => path === "/funding" ? FUNDED_R03("rt-a1") : { txns: [{ retref: "rt-a1", setlstat: "Accepted" }] },
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.updated, [], JSON.stringify(r.body.updated));
  assertEquals(r.trace.errors.filter((e) => e.code === "ach_returned"), [], "no return is filed for a row that did not move");
});

Deno.test("reconcile: the settlestat pass is guarded too: still pending, still not voided, counted only when the row comes back", async () => {
  const p = ACH("a1", 41, "rt-a1", "2026-10-01");
  const settle = (path: string) => path === "/settlestat" ? { txns: [{ retref: "rt-a1", setlstat: "Accepted" }] } : { txns: [] };
  const missed = await call({ action: "reconcile" }, { payments: [p], attempts: ATTEMPTS, updateMisses: ["a1"], gateway: settle });
  assertEquals(missed.body.updated, [], "a row voided since the read is not reported as moved");
  // A write that FAILS is filed once, as a fault, and is not reported as moved either. (Its funding
  // place failed to write too, and that is not filed: it is bookkeeping.)
  const failed = await call({ action: "reconcile" }, { payments: [p], attempts: ATTEMPTS, updateFails: ["a1"], gateway: settle });
  assertEquals(failed.body.updated, []);
  const rows = failed.trace.errors.filter((e) => e.code === "reconcile_write_failed");
  assertEquals(rows.length, 1, JSON.stringify(failed.trace.errors));
  assertEquals(rows[0].severity, "error");
  assertEquals((rows[0].context as any).failures, [{ paymentId: "a1", pgCode: "57014" }]);
  // And the guard is on the UPDATE itself (the fake answers what PostgREST would; the row moved here).
  const ok = await call({ action: "reconcile" }, { payments: [p], attempts: ATTEMPTS, gateway: settle });
  assertEquals(ok.body.updated, [{ paymentId: "a1", to: "settled" }]);
});

Deno.test("reconcile: gateway failures are filed ONCE a day, at info, with the MID's last four and the class only, never a body", async () => {
  const world: World = {
    payments: [ACH("a1", 41, "rt-a1", daysAgo(3)), ACH("a3", 43, "rt-a3", daysAgo(3))],
    attempts: ATTEMPTS,
    // settlestat refuses the date with a body; funding falls over.
    gateway: (path) => path === "/settlestat" ? 400 : 500,
  };
  const r = await call({ action: "reconcile" }, world);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const rows = r.trace.errors.filter((e) => e.code === "reconcile_gateway_failed");
  assertEquals(rows.length, 1, JSON.stringify(r.trace.errors));
  assertEquals(rows[0].severity, "info");
  const failures = (rows[0].context as any).failures as Record<string, string>[];
  const settle = failures.filter((f) => f.call === "settlestat");
  assertEquals(settle.map((f) => [f.merchant, f.kind]).sort(), [["…" + OLD_MID.slice(-4), "config"], ["…" + NEW_MID.slice(-4), "config"]].sort());
  assert(failures.some((f) => f.call === "funding" && f.kind === "unknown"), JSON.stringify(failures));
  const text = JSON.stringify(rows[0]);
  for (const mid of [OLD_MID, NEW_MID]) assert(!text.includes(mid), `a whole MID was filed: ${text}`);
  assertEquals(r.body.updated, []);
  // The finding: one row per Orders visit, for ever. Filed earlier today: nothing more.
  const earlier = { ...rows[0], client_id: TENANT, source: "edge:portal-payments", created_at: new Date(Date.now() - 3600000).toISOString() };
  const again = await call({ action: "reconcile" }, { ...world, priorErrors: [earlier] });
  assertEquals(again.trace.errors.filter((e) => e.code === "reconcile_gateway_failed"), []);
  // Filed yesterday: filed again. And a failure the earlier row did not name is filed at once.
  const stale = await call({ action: "reconcile" }, { ...world, priorErrors: [{ ...earlier, created_at: new Date(Date.now() - 25 * 3600000).toISOString() }] });
  assertEquals(stale.trace.errors.filter((e) => e.code === "reconcile_gateway_failed").length, 1);
  const other = await call({ action: "reconcile" }, { ...world, gateway: (path) => path === "/settlestat" ? 400 : 401, priorErrors: [earlier] });
  assertEquals(other.trace.errors.filter((e) => e.code === "reconcile_gateway_failed").length, 1, "funding refused is new");
});

Deno.test("reconcile: the first funding REFUSAL ends the funding calls for the sweep (a bad date is refused every time)", async () => {
  const r = await call({ action: "reconcile" }, {
    payments: [ACH("a1", 41, "rt-a1", daysAgo(9))],
    attempts: ATTEMPTS,
    gateway: (path) => path === "/funding" ? new Response(JSON.stringify({ resptext: "Invalid date" }), { status: 400 }) : { txns: [] },
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(fundingDays(r.trace).length, 1);
  assertEquals([r.body.fundingChecked, r.body.fundingSkipped], [1, 7]);
  // settlestat is a different call and still asked.
  assertEquals(r.trace.gateway.filter((g) => g.path === "/settlestat").length, 1);
  assertEquals(cursorsWritten(r.trace, ["a1"]), {}, "a day not read moves nothing");
});

Deno.test("reconcile: a funding answer in a shape it cannot read is filed ONCE a day, key paths only, and moves nothing", async () => {
  const r = await call({ action: "reconcile" }, {
    payments: [ACH("a1", 41, "rt-a1", daysAgo(4))],
    attempts: ATTEMPTS,
    gateway: (path) => path === "/funding"
      ? { resptext: "Invalid date rt-a1", detail: { acct: "9876543210", code: "R03" } }
      : { txns: [] },
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const rows = r.trace.errors.filter((e) => e.code === "reconcile_funding_unrecognised");
  assertEquals(rows.length, 1, JSON.stringify(r.trace.errors));
  assertEquals(rows[0].severity, "info");
  const ctx = rows[0].context as any;
  assertEquals([...ctx.keyPaths].sort(), ["detail", "detail.acct", "detail.code", "resptext"]);
  assertEquals(ctx.answers.length, 3, "one entry per day read, in the one row");
  const text = JSON.stringify(rows[0]);
  for (const v of ["Invalid date", "9876543210", "R03", "rt-a1"]) assert(!text.includes(v), `${v} was filed: ${text}`);
  assertEquals(r.body.updated, [], "a code on an object without this retref is not a return");
  assertEquals(cursorsWritten(r.trace, ["a1"]), {}, "a day it cannot read is read again, never passed");
  // Filed today already: nothing more.
  const again = await call({ action: "reconcile" }, {
    payments: [ACH("a1", 41, "rt-a1", daysAgo(4))], attempts: ATTEMPTS,
    gateway: (path) => path === "/funding" ? { resptext: "Invalid date" } : { txns: [] },
    priorErrors: [{ ...rows[0], client_id: TENANT, source: "edge:portal-payments", created_at: new Date().toISOString() }],
  });
  assertEquals(again.trace.errors.filter((e) => e.code === "reconcile_funding_unrecognised"), []);
});

Deno.test("reconcile: a 200 that is only the gateway's error message is filed WITH that message, and ends the funding pass", async () => {
  const r = await call({ action: "reconcile" }, {
    payments: [ACH("a1", 41, "rt-a1", daysAgo(9))],
    attempts: ATTEMPTS,
    gateway: (path) => path === "/funding" ? { errormsg: "No funding data for merchant 100200300400" } : { errormsg: "Invalid date" },
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(fundingDays(r.trace).length, 1, "the first refusal ends the funding pass");
  const rows = r.trace.errors.filter((e) => e.code === "reconcile_gateway_failed");
  assertEquals(rows.length, 1, JSON.stringify(r.trace.errors));
  const failures = (rows[0].context as any).failures.map((f: any) => [f.call, f.kind, f.message]);
  assertEquals(failures.sort(), [["funding", "answered_error", "No funding data for merchant …0400"], ["settlestat", "answered_error", "Invalid date"]].sort());
  assertEquals(r.trace.errors.filter((e) => e.code === "reconcile_funding_unrecognised"), []);
  assertEquals(cursorsWritten(r.trace, ["a1"]), {}, "a refused day is read again, never passed");
  assertEquals(r.body.updated, []);
});

Deno.test("reconcile: 'No deposits match your request' is an empty day: read past, and the return on a later day is still found", async () => {
  const r = await call({ action: "reconcile" }, {
    payments: [ACH("a1", 41, "rt-a1", daysAgo(4))],
    attempts: ATTEMPTS,
    gateway: (path, _b, url) => path === "/funding"
      ? (url.searchParams.get("date") === ymd(daysAgo(2)) ? FUNDED_R03("rt-a1") : { errormsg: "No deposits match your request" })
      : { txns: [] },
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(fundingDays(r.trace), [daysAgo(4), daysAgo(3), daysAgo(2)].map(ymd));
  assertEquals((r.body.updated as any[]).map((u) => [u.paymentId, u.to, u.returnCode]), [["a1", "returned", "R03"]]);
  assertEquals(r.trace.errors.filter((e) => e.code === "reconcile_gateway_failed"), []);
});

Deno.test("reconcile: once the limiter says no, the sweep asks the gateway nothing more", async () => {
  const r = await call({ action: "reconcile" }, {
    payments: [ACH("a1", 41, "rt-a1", daysAgo(8))],
    attempts: ATTEMPTS,
    gateway: () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "X-Rate-Limit-Retry-After-Seconds": "30" } }),
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.trace.gateway.length, 1, r.trace.gateway.map((g) => g.path).join(","));
  assertEquals(r.body.fundingChecked, 1);
  assert(r.body.fundingSkipped >= 5 && r.body.daysSkipped === 1, JSON.stringify(r.body));
  const rows = r.trace.errors.filter((e) => e.code === "reconcile_gateway_failed");
  assertEquals(rows.length, 1);
  assertEquals((rows[0].context as any).failures.map((f: any) => [f.call, f.kind]), [["funding", "throttled"]]);
});

Deno.test("reconcile on a database WITHOUT 309's column: the lists are read without it, no funding is read, settlestat still works, and it says so once a day", async () => {
  const world: World = {
    noCursorColumn: true,
    payments: [ACH("a1", 41, "rt-a1", "2026-10-01")],
    attempts: ATTEMPTS,
    gateway: (path) => path === "/funding" ? FUNDED_R03("rt-a1") : { txns: [{ retref: "rt-a1", setlstat: "Accepted" }] },
  };
  const r = await call({ action: "reconcile" }, world);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(fundingDays(r.trace), []);
  assertEquals(r.body.updated, [{ paymentId: "a1", to: "settled" }]);
  const rows = r.trace.errors.filter((e) => e.code === "reconcile_funding_needs_migration");
  assertEquals(rows.map((e) => e.severity), ["info"]);
  assertEquals(paymentUpdates(r.trace).filter((w) => "funding_checked_through" in w.row), [], "no place is written");
  const again = await call({ action: "reconcile" }, { ...world, priorErrors: [{ ...rows[0], client_id: TENANT, source: "edge:portal-payments", created_at: new Date().toISOString() }] });
  assertEquals(again.trace.errors.filter((e) => e.code === "reconcile_funding_needs_migration"), []);
});

// ─── 8. Partial refunds (migration 349): the ledger, the net, one refund per key ───────────────
// What the Orders page's Refund box sends: an amount up to what is left and one requestKey per refund
// the builder means. The ledger fake (refundLedgerFake.ts) follows payment_refund_open/close rule for
// rule; tests/sql/migration349.test.cjs holds the SQL itself to them.
const TAKEN = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const SETTLED_CARD: Pay = { ...CARD, method: "card", received_at: TAKEN(3) };
const refundCalls = (t: Trace) => t.gateway.filter((g) => g.path === "/refund");
const inquiries = (t: Trace) => t.gateway.filter((g) => g.path.startsWith("/inquireByOrderid/"));
const KEY = "rk-0000000000000001";

Deno.test("8a. a partial refund sends that amount with its own order id, and the payment keeps its net", async () => {
  const r = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 25000, requestKey: KEY }, { payments: [SETTLED_CARD], attempts: ATTEMPTS });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body, { ok: true, refunded: 25000, retref: "rf-1", leftCents: 75000, refundedCents: 25000, fullyRefunded: false });
  assertEquals(refundCalls(r.trace).map((g) => g.body), [{ merchid: OLD_MID, retref: "rt-card", amount: "250.00", orderid: r.ledger.refunds[0].gateway_orderid }]);
  const p = r.payments[0] as any;
  assertEquals([p.amount_cents, p.refunded_cents, p.voided_at ?? null], [75000, 25000, null]);
  assert(/Refunded \$250\.00 on \d{4}-\d{2}-\d{2} \(ref rf-1\)$/.test(p.note), p.note);
  assertEquals(r.ledger.refunds.map((x) => [x.state, x.amount_cents, x.request_key, x.gateway_retref]), [["done", 25000, KEY, "rf-1"]]);
  assert(r.trace.audit.some((a: any) => /cents=25000/.test(JSON.stringify(a))), JSON.stringify(r.trace.audit));
});

Deno.test("8b. the same key again (a retry, a double click) is the first refund's answer, and no second refund", async () => {
  const first = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 25000, requestKey: KEY }, { payments: [SETTLED_CARD], attempts: ATTEMPTS });
  assertEquals(first.status, 200, JSON.stringify(first.body));
  // The second click arrives with the ledger and the payment as the first left them.
  const again = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 25000, requestKey: KEY }, {
    payments: first.payments as Pay[], attempts: ATTEMPTS, refunds: first.ledger.refunds,
  });
  assertEquals(again.status, 200, JSON.stringify(again.body));
  assertEquals(again.body.replay, true);
  assertEquals(again.body.refunded, 25000);
  assertEquals(refundCalls(again.trace), [], "the card network is not asked twice");
  assertEquals((again.payments[0] as any).amount_cents, 75000, "the payment moves once");
  // The same key for ANOTHER amount is refused, not sent.
  const other = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 100, requestKey: KEY }, {
    payments: first.payments as Pay[], attempts: ATTEMPTS, refunds: first.ledger.refunds,
  });
  assertEquals([other.status, other.body.reason], [409, "key_reused"]);
  assertEquals(refundCalls(other.trace), []);
});

Deno.test("8c. partials down to nothing: the last one voids it as refunded; a further one is `already`; no amount means all that is left", async () => {
  let pays: Pay[] = [SETTLED_CARD];
  let refunds: Partial<LedgerRefund>[] = [];
  for (const [cents, key] of [[30000, "rk-c-0000001"], [20000, "rk-c-0000002"]] as const) {
    const r = await call({ action: "refund_payment", paymentId: "p-card", amountCents: cents, requestKey: key }, { payments: pays, attempts: ATTEMPTS, refunds });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    pays = r.payments as Pay[];
    refunds = r.ledger.refunds;
  }
  assertEquals((pays[0] as any).amount_cents, 50000);
  // An older page (or the "already settled" chain after a void) sends no amount: the rest, 500.00.
  const rest = await call({ action: "refund_payment", paymentId: "p-card" }, { payments: pays, attempts: ATTEMPTS, refunds });
  assertEquals(rest.status, 200, JSON.stringify(rest.body));
  assertEquals(refundCalls(rest.trace)[0].body.amount, "500.00");
  assertEquals([rest.body.refunded, rest.body.leftCents, rest.body.refundedCents, rest.body.fullyRefunded], [50000, 0, 100000, true]);
  const p = rest.payments[0] as any;
  assert(p.voided_at && p.void_reason === "refunded $1000.00", JSON.stringify(p));
  const after = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 100, requestKey: "rk-c-0000004" }, { payments: rest.payments as Pay[], attempts: ATTEMPTS, refunds: rest.ledger.refunds });
  assertEquals(after.body, { ok: true, already: true });
  assertEquals(after.trace.gateway, []);
});

Deno.test("8d. more than is left, zero, a fraction of a cent: refused before anything is filed or sent", async () => {
  const part = { ...SETTLED_CARD, amount_cents: 40000, refunded_cents: 60000 } as Pay;
  for (const amountCents of [40001, 0, -5, 12.5, "abc"]) {
    const r = await call({ action: "refund_payment", paymentId: "p-card", amountCents, requestKey: KEY }, { payments: [part], attempts: ATTEMPTS });
    assertEquals(r.status, 400, `${amountCents}: ${JSON.stringify(r.body)}`);
    assertEquals([r.body.reason, r.body.refundableCents], ["amount", 40000]);
    assert(/up to \$400\.00/.test(r.body.error), r.body.error);
    assertEquals(r.trace.gateway, []);
    assertEquals(r.ledger.refunds, []);
  }
});

Deno.test("8e. a refund the card network refuses because the sale has not settled: the partial wording, nothing moved, the payment free again", async () => {
  const today = { ...SETTLED_CARD, received_at: TAKEN(0.1) };
  const r = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 25000, requestKey: KEY }, {
    payments: [today], attempts: ATTEMPTS, gateway: () => ({ respstat: "C", respcode: "29", resptext: "Txn not settled" }),
  });
  assertEquals(r.status, 409, JSON.stringify(r.body));
  assertEquals(r.body.reason, "not_settled");
  assert(/only the whole payment can be cancelled, not \$250\.00/.test(r.body.error) && /tomorrow/.test(r.body.error), r.body.error);
  assertEquals((r.payments[0] as any).amount_cents, 100000);
  assertEquals(r.ledger.refunds.map((x) => [x.state, x.gateway_resptext]), [["failed", "Txn not settled"]]);
  // The same wording comes from the age alone when the gateway's words say nothing about settling.
  const vague = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 25000, requestKey: KEY }, {
    payments: [today], attempts: ATTEMPTS, gateway: () => ({ respstat: "C", respcode: "05", resptext: "Invalid request" }),
  });
  assertEquals(vague.body.reason, "not_settled");
  // On an older sale it is a plain refusal, the gateway's words digit-masked.
  const old = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 25000, requestKey: KEY }, {
    payments: [SETTLED_CARD], attempts: ATTEMPTS, gateway: () => ({ respstat: "C", respcode: "05", resptext: "Refused 4111111111111111" }),
  });
  assertEquals([old.status, old.body.reason], [409, "refund_declined"]);
  assert(!/4111/.test(old.body.error) && /Nothing was refunded/.test(old.body.error), old.body.error);
  // A failed refund frees the payment: a new key goes ahead.
  const next = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 25000, requestKey: "rk-e-0000002" }, {
    payments: old.payments as Pay[], attempts: ATTEMPTS, refunds: old.ledger.refunds,
  });
  assertEquals(next.status, 200, JSON.stringify(next.body));
});

Deno.test("8f. a refund whose answer is LOST is never 'nothing changed, try again': asked by its order id, recorded if found, held if not", async () => {
  // Found approved by the inquire right after the timeout: recorded done.
  const found = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 25000, requestKey: KEY }, {
    payments: [SETTLED_CARD], attempts: ATTEMPTS,
    gateway: (path) => path === "/refund" ? 504 : { respstat: "A", respcode: "00", retref: "rf-late", amount: "250.00" },
  });
  assertEquals(found.status, 200, JSON.stringify(found.body));
  assertEquals(inquiries(found.trace).length, 1);
  assert(inquiries(found.trace)[0].path.includes(found.ledger.refunds[0].gateway_orderid!), inquiries(found.trace)[0].path);
  assertEquals([found.body.refunded, found.body.retref, (found.payments[0] as any).amount_cents], [25000, "rf-late", 75000]);

  // Not found: held, filed as a fault once, the payment unchanged, and the next refund refused.
  const lost = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 25000, requestKey: KEY }, {
    payments: [SETTLED_CARD], attempts: ATTEMPTS, gateway: (path) => path === "/refund" ? 504 : {},
  });
  assertEquals([lost.status, lost.body.reason], [409, "refund_unconfirmed"]);
  assert(/Don't refund it again/.test(lost.body.error), lost.body.error);
  assertEquals(lost.ledger.refunds.map((x) => x.state), ["unknown"]);
  assertEquals((lost.payments[0] as any).amount_cents, 100000);
  assert(faultCodes(lost.trace).includes("refund_unconfirmed"), JSON.stringify(lost.trace.errors));
  const msg = String(lost.trace.errors.find((e) => e.code === "refund_unconfirmed")?.message);
  assert(/payment_refund_close\(1, 'done'/.test(msg) && /payment_refund_close\(1, 'failed'/.test(msg), msg);

  const blocked = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 100, requestKey: "rk-f-0000002" }, {
    payments: lost.payments as Pay[], attempts: ATTEMPTS, refunds: lost.ledger.refunds, gateway: () => ({}),
  });
  assertEquals([blocked.status, blocked.body.reason], [409, "refund_unconfirmed"]);
  assertEquals(refundCalls(blocked.trace), [], "no second refund while the first is unknown");
  // …and a void is held too: cancelling the sale on top of a refund that may have gone through.
  const v = await call({ action: "void_payment", paymentId: "p-card" }, { payments: lost.payments as Pay[], attempts: ATTEMPTS, refunds: lost.ledger.refunds });
  assertEquals([v.status, v.body.reason], [409, "refund_unconfirmed"]);
  assertEquals(v.trace.gateway, []);

  // Once the gateway answers the inquire (approved), the next click records it and goes ahead.
  const later = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 100, requestKey: "rk-f-0000003" }, {
    payments: lost.payments as Pay[], attempts: ATTEMPTS, refunds: lost.ledger.refunds,
    gateway: (path) => path === "/refund" ? { respstat: "A", respcode: "00", retref: "rf-next" } : { respstat: "A", retref: "rf-late", amount: "250.00" },
  });
  assertEquals(later.status, 200, JSON.stringify(later.body));
  assertEquals(later.ledger.refunds.map((x) => x.state), ["done", "done"]);
  assertEquals((later.payments[0] as any).amount_cents, 100000 - 25000 - 100);
});

Deno.test("8g. the limiter refusing the refund: nothing went back, said so, and the payment is free", async () => {
  const r = await call({ action: "refund_payment", paymentId: "p-card", amountCents: 25000, requestKey: KEY }, {
    payments: [SETTLED_CARD], attempts: ATTEMPTS,
    gateway: () => new Response(JSON.stringify({}), { status: 429, headers: { "X-Rate-Limit-Retry-After-Seconds": "20" } }),
  });
  assertEquals(r.status, 502, JSON.stringify(r.body));
  assert(/Nothing was refunded/.test(r.body.error), r.body.error);
  assertEquals(r.ledger.refunds.map((x) => x.state), ["failed"]);
  assertEquals(inquiries(r.trace), [], "a known refusal needs no inquire");
});

Deno.test("8h. reconcile asks about a lost refund by its order id and records what it finds; one still in flight is left alone", async () => {
  const old = (id: number, orderid: string) => ({
    id, client_id: TENANT, payment_id: "p-card", order_id: "o-1", amount_cents: 25000, kind: "gateway" as const, state: "unknown" as const,
    gateway_orderid: orderid, created_at: TAKEN(1),
  });
  const r = await call({ action: "reconcile" }, {
    payments: [SETTLED_CARD], attempts: ATTEMPTS, refunds: [old(1, "ssr_00000000000000000001")],
    gateway: (path) => path.startsWith("/inquireByOrderid/") ? { respstat: "A", retref: "rf-found", amount: "250.00" } : {},
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.refunds, [{ refundId: 1, state: "done" }]);
  assertEquals(inquiries(r.trace)[0].path, `/inquireByOrderid/ssr_00000000000000000001/${OLD_MID}`);
  assertEquals((r.payments[0] as any).amount_cents, 75000);
  // One a minute old is still in flight: not asked.
  const fresh = await call({ action: "reconcile" }, {
    payments: [SETTLED_CARD], attempts: ATTEMPTS, refunds: [{ ...old(1, "ssr_00000000000000000001"), state: "pending", created_at: TAKEN(1 / 1440) }],
  });
  assertEquals(fresh.body.refunds, []);
  assertEquals(inquiries(fresh.trace), []);
});

// ─── 9. Refunds by hand (cash, check, a card run elsewhere) ────────────────────────────────────
const CASH: Pay = { id: "p-cash", order_id: "o-1", amount_cents: 30000, gateway: null as unknown as string, gateway_txn_id: null as unknown as string, attempt_id: null, method: "cash", note: "paid at the lot" };

Deno.test("9a. a by-hand refund of part of a cash payment is recorded at once, with how it went back, and asks no card network", async () => {
  const r = await call({ action: "refund_payment", paymentId: "p-cash", amountCents: 7500, requestKey: KEY, refundMethod: "check", reference: "chk 1043", reason: "trim kit returned" }, { payments: [CASH] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body, { ok: true, refunded: 7500, retref: null, leftCents: 22500, refundedCents: 7500, fullyRefunded: false, byHand: true });
  assertEquals(r.trace.gateway, []);
  const p = r.payments[0] as any;
  assert(p.note.startsWith("paid at the lot\n") && /Refunded \$75\.00 by check on .* \(ref chk 1043\)$/.test(p.note), p.note);
  assertEquals(r.ledger.refunds.map((x) => [x.kind, x.state, x.method, x.reference, x.reason]), [["manual", "done", "check", "chk 1043", "trim kit returned"]]);
  // Repeated: a replay.
  const again = await call({ action: "refund_payment", paymentId: "p-cash", amountCents: 7500, requestKey: KEY, refundMethod: "check" }, { payments: r.payments as Pay[], refunds: r.ledger.refunds });
  assertEquals([again.status, again.body.replay, (again.payments[0] as any).amount_cents], [200, true, 22500]);
  // The rest, with no method named: the payment's own (cash), and it is refunded in full.
  const rest = await call({ action: "refund_payment", paymentId: "p-cash", requestKey: "rk-9a-000003" }, { payments: r.payments as Pay[], refunds: r.ledger.refunds });
  assertEquals([rest.status, rest.body.fullyRefunded, rest.ledger.refunds[1].method], [200, true, "cash"]);
});

Deno.test("9b. by-hand refusals: more than is left, a voided payment, a GHL payment", async () => {
  const over = await call({ action: "refund_payment", paymentId: "p-cash", amountCents: 30001, requestKey: KEY }, { payments: [CASH] });
  assertEquals([over.status, over.body.reason, over.body.refundableCents], [400, "amount", 30000]);
  const voided = await call({ action: "refund_payment", paymentId: "p-cash", amountCents: 100, requestKey: KEY }, { payments: [{ ...CASH, voided_at: TAKEN(1) }] });
  assertEquals([voided.status, voided.body.reason], [409, "voided"]);
  const ghl = await call({ action: "refund_payment", paymentId: "p-cash", amountCents: 100, requestKey: KEY }, { payments: [{ ...CASH, gateway: "ghl" }] });
  assertEquals(ghl.status, 400);
  assert(/Synergy\/GHL/.test(ghl.body.error), ghl.body.error);
  for (const r of [over, voided, ghl]) assertEquals(r.ledger.refunds, []);
});

Deno.test("9c. refunds are gated like today's: a member with view-only Orders is refused before anything is read or sent", async () => {
  const viewer = { client_id: TENANT, role: "user", title: "sales_rep", access: { orders: "view" }, user_id: USER_ID };
  for (const pay of [SETTLED_CARD, CASH]) {
    const r = await call({ action: "refund_payment", paymentId: pay.id, amountCents: 100, requestKey: KEY }, { payments: [pay], attempts: ATTEMPTS, member: viewer });
    assertEquals(r.status, 403, JSON.stringify(r.body));
    assertEquals(r.trace.gateway, []);
    assertEquals(r.ledger.calls, []);
  }
});
