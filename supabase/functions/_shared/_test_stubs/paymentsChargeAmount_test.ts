// The builder chooses the amount of a portal charge (Carolyn 2026-10-20: "$5,000 of the balance"),
// driven through the SHIPPED portal-payments handler.
//
// WHY THIS EXISTS. Until 2026-10-21 `charge` was pinned to the server's ask (the deposit, or the whole
// balance): it refused any confirmChargeCents but the ask and charged the ask. The modal therefore
// replaced whatever the builder typed with that figure ("it flips over"), and every test charge had to
// take, and move the CRM deal for, the whole balance. `amountCents` is now optional. Held here:
//
//   1. NO amountCents charges the ask, exactly as before: production's portal and my-quotes send none.
//      Its confirm still has to equal the ask, and the refusal still names the ask.
//   2. A typed amount between $1 and the balance (and the $50,000 ceiling) reaches /auth, the attempt
//      and the audit line as typed, below the deposit and above it alike.
//   3. Refused before the gateway, with nothing written: below $1, above the balance, above $50,000,
//      not a whole number of cents, not a number at all, and a confirm that does not match it.
//   4. Every refusal the ask had still stands with an amount: paid in full, a refund owed, a bank
//      payment clearing, a change the customer has not approved.
//
// HOW. paymentsMerchantOfRecord_test's idiom: Deno.serve is stubbed while portal-payments/index.ts is
// imported, and the import map swaps supabase-js for supabase_stub.ts. globalThis.fetch is the
// CardPointe gateway and nothing else. Tenants, users and tokens are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";

const GATEWAY = "https://gateway.example.invalid/cardconnect/rest";
Deno.env.set("CARDPOINTE_BASE_URL", GATEWAY);
Deno.env.set("CARDPOINTE_API_USER", "u");
Deno.env.set("CARDPOINTE_API_PASS", "p");
Deno.env.set("CARDPOINTE_MERCHID", "100200300999");
Deno.env.set("CARDPOINTE_TOKENIZER_BASE", "https://gateway.example.invalid/itoke/ajax-tokenizer.html");

async function load(rel: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  try {
    // Computed on purpose (see paymentsMerchantOfRecord_test): a literal specifier would type-check
    // portal-payments against the stub's partial client type.
    await import(new URL(rel, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${rel} did not hand Deno.serve a handler`);
  return handler;
}
const PAYMENTS = await load("../../portal-payments/index.ts");

const TENANT = "acme-sheds";
const USER_ID = "00000000-0000-4000-8000-0000000000c4";
const MID = "100200300500";
const TOKEN = "9413948780281111";

type World = {
  /** orders.total_cents (no design lines, so it stands as the amount owed). */
  totalCents: number;
  /** invoice_sends.deposit_cents; null = pay in full. */
  depositCents?: number | null;
  /** The order's payments, as readOrderMoney reads them. */
  pays?: { amount_cents: number; funding_state?: string; voided_at?: string | null }[];
  /** change_orders rows on the design (status, acknowledged_at). */
  changeOrders?: { status: string; acknowledged_at?: string | null }[];
};
type Trace = { gateway: { path: string; body: any }[]; writes: { table: string; verb: string; row: any }[]; audit: any[] };

const eqOf = (ops: any[][], col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);
const has = (ops: any[][], op: string) => ops.some((o) => o[0] === op);

function answer(world: World, trace: Trace, table: string, ops: any[][]): any {
  const verb = ["insert", "update", "delete", "upsert"].find((v) => has(ops, v));
  switch (table) {
    case "client_users":
      return { data: [{ client_id: TENANT, role: "owner", title: "owner", access: null, user_id: USER_ID }], error: null };
    case "app_operators":
      return { data: null, error: null };
    case "client_configs":
      return { data: { client_id: eqOf(ops, "client_id") }, error: null };
    case "admin_audit":
      trace.audit.push(argOf(ops, "insert")[0]);
      return { data: null, error: null };
    case "app_errors":
      if (verb) trace.writes.push({ table, verb, row: argOf(ops, verb)[0] });
      return { data: [], error: null };
    case "orders":
      return { data: eqOf(ops, "id") === "o-1" ? { id: "o-1", short_code: "SS-AAAAAAAAAA", total_cents: world.totalCents } : null, error: null };
    case "designs":
      return { data: String(argOf(ops, "select")[0] ?? "").includes("contact") ? { contact: { name: "Pat Example" } } : null, error: null };
    case "change_orders": {
      const status = eqOf(ops, "status");
      return { data: (world.changeOrders ?? []).filter((c) => !status || c.status === status), error: null };
    }
    case "invoice_sends":
      // readOrderMoney asks for deposit_cents; changeRefusal for the document's dates (none: never stale).
      return { data: String(argOf(ops, "select")[0] ?? "").includes("deposit_cents") ? { deposit_cents: world.depositCents ?? null } : null, error: null };
    case "client_settings":
      return { data: { payments_online_enabled: true, cardpointe_merchid: MID, billing_exempt: true, business_name: "Acme Sheds" }, error: null };
    case "payment_attempts":
      if (verb) {
        trace.writes.push({ table, verb, row: argOf(ops, verb)[0] });
        return { data: verb === "insert" ? { id: 601 } : null, error: null };
      }
      if ((argOf(ops, "select")[1] as any)?.count) return { data: null, count: 0, error: null };
      return { data: [], error: null };
    case "payments":
      if (verb) {
        trace.writes.push({ table, verb, row: argOf(ops, verb)[0] });
        return { data: verb === "insert" ? { id: "pay-new" } : null, error: null };
      }
      return { data: (world.pays ?? []).map((p) => ({ funding_state: "settled", voided_at: null, ...p })), error: null };
  }
  // The money path's side effects (CRM stage, receipts) are not this file's concern: an empty answer.
  if (verb) trace.writes.push({ table, verb, row: argOf(ops, verb)[0] });
  return { data: null, error: null };
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

async function charge(extra: Record<string, unknown>, world: World) {
  const trace: Trace = { gateway: [], writes: [], audit: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(GATEWAY + "/")) return Promise.reject(new Error(`TEST FAILURE: unexpected fetch to ${href}`));
    const path = new URL(href).pathname.replace(new URL(GATEWAY).pathname, "");
    const sent = init?.body ? JSON.parse(String(init.body)) : null;
    trace.gateway.push({ path, body: sent });
    // An approval for exactly what was asked: the amount comes back as dollars, as CardPointe sends it.
    const out = path === "/auth"
      ? { respstat: "A", respcode: "000", retref: "rt-amt", amount: String(sent?.amount ?? "0"), token: TOKEN, authcode: "123456" }
      : { respstat: "A", respcode: "00", retref: "rf-1" };
    return Promise.resolve(new Response(JSON.stringify(out), { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await PAYMENTS(new Request("https://stub.supabase.co/functions/v1/portal-payments", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action: "charge", orderId: "o-1", payToken: TOKEN, entry: "keyed", ...extra }),
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

const auth = (t: Trace) => t.gateway.find((g) => g.path === "/auth")?.body ?? null;
const attempt = (t: Trace) => t.writes.find((w) => w.table === "payment_attempts" && w.verb === "insert")?.row ?? null;
const nothingSent = (t: Trace) => {
  assertEquals(t.gateway.length, 0, `the gateway was asked: ${JSON.stringify(t.gateway.map((g) => g.path))}`);
  assertEquals(attempt(t), null, "an attempt row was written");
};
// CardPointe takes dollars: 500000 cents is "5000.00".
const dollars = (cents: number) => (cents / 100).toFixed(2);

// $10,450.70 owed, nothing paid: the order Carolyn tried the reader on, more or less.
const OWED = { totalCents: 1045070 };
// The same with a $2,000 deposit asked.
const ON_DEPOSIT = { totalCents: 1045070, depositCents: 200000 };

// ─── 1. No amount: the ask, as before ────────────────────────────────────────────────────────
Deno.test("no amountCents charges the ask (production's page and my-quotes are unchanged)", async () => {
  const r = await charge({ confirmChargeCents: 1045070 }, OWED);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(auth(r.trace).amount, dollars(1045070));
  assertEquals(attempt(r.trace).amount_cents, 1045070);
  // On a deposit the ask is the deposit.
  const d = await charge({ confirmChargeCents: 200000 }, ON_DEPOSIT);
  assertEquals(d.status, 200, JSON.stringify(d.body));
  assertEquals(auth(d.trace).amount, dollars(200000));
});

Deno.test("no amountCents and a confirm that is not the ask: refused with the ask named, nothing sent", async () => {
  const r = await charge({ confirmChargeCents: 500000 }, ON_DEPOSIT);
  assertEquals(r.status, 400, JSON.stringify(r.body));
  assertEquals(r.body.askCents, 200000);
  assert(String(r.body.error).includes("$2000.00"), r.body.error);
  nothingSent(r.trace);
});

// ─── 2. A typed amount inside the balance ────────────────────────────────────────────────────
Deno.test("a typed $5,000 of a $10,450.70 balance is what /auth, the attempt and the audit carry", async () => {
  const r = await charge({ amountCents: 500000, confirmChargeCents: 500000 }, OWED);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(auth(r.trace).amount, dollars(500000));
  assertEquals(attempt(r.trace).amount_cents, 500000);
  assert(r.trace.audit.some((a) => String(a?.detail ?? JSON.stringify(a)).includes("cents=500000")), JSON.stringify(r.trace.audit));
});

Deno.test("$1.00 (the floor) and the whole balance (the ceiling) are both allowed", async () => {
  const low = await charge({ amountCents: 100, confirmChargeCents: 100 }, OWED);
  assertEquals(low.status, 200, JSON.stringify(low.body));
  assertEquals(auth(low.trace).amount, "1.00");
  const all = await charge({ amountCents: 1045070, confirmChargeCents: 1045070 }, OWED);
  assertEquals(all.status, 200, JSON.stringify(all.body));
  assertEquals(auth(all.trace).amount, dollars(1045070));
});

Deno.test("on a deposit, an amount below it and one above it (up to the balance) are both the builder's call", async () => {
  const below = await charge({ amountCents: 50000, confirmChargeCents: 50000 }, ON_DEPOSIT);
  assertEquals(below.status, 200, JSON.stringify(below.body));
  assertEquals(auth(below.trace).amount, dollars(50000));
  const above = await charge({ amountCents: 800000, confirmChargeCents: 800000 }, ON_DEPOSIT);
  assertEquals(above.status, 200, JSON.stringify(above.body));
  assertEquals(auth(above.trace).amount, dollars(800000));
});

Deno.test("the balance is what is LEFT: $3,000 paid leaves $7,450.70 to take", async () => {
  const world = { totalCents: 1045070, pays: [{ amount_cents: 300000 }] };
  const ok = await charge({ amountCents: 745070, confirmChargeCents: 745070 }, world);
  assertEquals(ok.status, 200, JSON.stringify(ok.body));
  const over = await charge({ amountCents: 745071, confirmChargeCents: 745071 }, world);
  assertEquals(over.status, 400, JSON.stringify(over.body));
  assertEquals(over.body.maxCents, 745070);
  nothingSent(over.trace);
});

// ─── 3. Refused before the gateway ───────────────────────────────────────────────────────────
Deno.test("below $1: refused, nothing sent", async () => {
  for (const cents of [99, 0, -500]) {
    const r = await charge({ amountCents: cents, confirmChargeCents: cents }, OWED);
    assertEquals(r.status, 400, `${cents}: ${JSON.stringify(r.body)}`);
    assertEquals(r.body.minCents, 100);
    nothingSent(r.trace);
  }
});

Deno.test("above the balance: refused with the balance named, nothing sent", async () => {
  const r = await charge({ amountCents: 1045071, confirmChargeCents: 1045071 }, OWED);
  assertEquals(r.status, 400, JSON.stringify(r.body));
  assertEquals(r.body.maxCents, 1045070);
  assert(String(r.body.error).includes("$10450.70"), r.body.error);
  nothingSent(r.trace);
});

Deno.test("above $50,000 on a bigger balance: refused at the ceiling, nothing sent", async () => {
  const r = await charge({ amountCents: 5_000_001, confirmChargeCents: 5_000_001 }, { totalCents: 9_000_000, depositCents: 100000 });
  assertEquals(r.status, 400, JSON.stringify(r.body));
  assertEquals(r.body.maxCents, 5_000_000);
  assert(String(r.body.error).includes("$50000.00"), r.body.error);
  nothingSent(r.trace);
});

Deno.test("not a whole number of cents, or not a number: refused, nothing sent", async () => {
  for (const amountCents of [500000.5, "500000", "5000.00", true, {}, [500000]]) {
    const r = await charge({ amountCents, confirmChargeCents: 500000 }, OWED);
    assertEquals(r.status, 400, `${JSON.stringify(amountCents)}: ${JSON.stringify(r.body)}`);
    nothingSent(r.trace);
  }
});

Deno.test("a confirm that does not match the typed amount: refused, nothing sent", async () => {
  for (const confirmChargeCents of [1045070, 500001, undefined, "500000"]) {
    const r = await charge({ amountCents: 500000, confirmChargeCents }, OWED);
    assertEquals(r.status, 400, `${JSON.stringify(confirmChargeCents)}: ${JSON.stringify(r.body)}`);
    // The typed path names no ask: the builder chose the figure, so "the amount due is now" is wrong.
    assert(!("askCents" in r.body), JSON.stringify(r.body));
    nothingSent(r.trace);
  }
});

// ─── 4. The ask's refusals still stand ───────────────────────────────────────────────────────
Deno.test("paid in full, a refund owed, a bank payment clearing: each still refused with an amount", async () => {
  const cases: [string, World][] = [
    ["paid_in_full", { totalCents: 100000, pays: [{ amount_cents: 100000 }] }],
    ["refund_due", { totalCents: 100000, pays: [{ amount_cents: 150000 }] }],
    ["pending_clearing", { totalCents: 1045070, pays: [{ amount_cents: 100000, funding_state: "pending" }] }],
  ];
  for (const [reason, world] of cases) {
    const r = await charge({ amountCents: 10000, confirmChargeCents: 10000 }, world);
    assertEquals(r.status, 409, `${reason}: ${JSON.stringify(r.body)}`);
    assertEquals(r.body.reason, reason);
    nothingSent(r.trace);
  }
});

Deno.test("a change the customer has not approved: still refused with an amount", async () => {
  const r = await charge({ amountCents: 10000, confirmChargeCents: 10000 }, { ...OWED, changeOrders: [{ status: "pending_ack" }] });
  assertEquals(r.status, 409, JSON.stringify(r.body));
  assertEquals(r.body.reason, "change_pending");
  nothingSent(r.trace);
});

Deno.test("a voided payment does not count toward the balance: the whole total is takeable again", async () => {
  const r = await charge({ amountCents: 1045070, confirmChargeCents: 1045070 }, {
    totalCents: 1045070, pays: [{ amount_cents: 100, voided_at: "2026-10-21T00:00:00Z" }],
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
});
