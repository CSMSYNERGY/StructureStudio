// The Verify button's wallet check, driven through the SHIPPED portal-settings handler (2026-10-05).
// The rule is plan v2's "refuse the button, never the invoice": a Verify press the wallet cannot
// cover is refused before anything is spent, while the meter stays disarmed nothing changes.
//
// WHAT THIS PINS, against the real handler rather than taxSpend.ts alone:
//
//   1. The live state (tax_lookup disarmed at 0c) asks nothing of the wallet: a press with an
//      empty wallet, or none at all, still reaches the claim. Deploying this is a no-op for every
//      builder until the meter is armed.
//   2. Armed, a wallet that cannot cover the price is refused 402 with the server's sentence, and
//      the refusal comes BEFORE the claim: no claim_tax_lookup call (no ledger row, nothing
//      counted against the cap), no request to the tax service, no quote write.
//   3. Held money is not available money, and a tenant with no wallet row has $0.00.
//   4. Exactly the price, metered_exempt and billing_exempt all go through to the claim; an
//      exempt tenant does even when the price read fails (it can never be charged).
//   5. A wallet or price read that fails on the way refuses 503 (fail closed) with an app_errors
//      row under `tax_meter`, and still never reaches the claim.
//   6. The confirmations come first: a press that still needs confirmResend is asked for it
//      without the wallet being read, and the confirmed press is the one the wallet answers.
//   7. tax_settings hands the Verify confirm `lookupPriceCents`: null while disarmed, unpriced,
//      hidden or exempt, or when the price cannot be read (the card still loads); the price when
//      armed.
//   8. A press that will be charged must carry the price its confirm stated (quotedPriceCents):
//      none, or another figure, is 409 price_changed naming the price, before the claim.
//
// HOW. quoteDocsWiring_test's idiom: Deno.serve is stubbed while portal-settings/index.ts is
// imported, so a request goes through withErrorLog, resolveTenant and the verify_tax branch as it
// does live. The import map swaps supabase-js for supabase_stub.ts, whose stubDb / stubRpc route
// every table and RPC into the fakes below. The claim answers `daily_cap`, so a press that gets
// past the wallet stops at the ledger with a 429 and never reaches the tax service; fetch is
// stubbed to throw and no --allow-net is granted, so nothing leaves the box either way.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check portal-settings against the stub's partial client type.
//
// Tenants, codes, numbers and the customer are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-settings did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
const T = "acme-sheds";
const CODE = "SS-ABCD2345EF";
const PROJECT = "https://stub.supabase.co";
const ENV: Record<string, string> = {
  SUPABASE_URL: PROJECT,
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
  // avalaraConfigured() only asks whether these exist. The base is a reserved .test host, and the
  // claim stops every press before a request anyway.
  AVALARA_ACCOUNT_ID: "test-account",
  AVALARA_LICENSE_KEY: "test-key",
  AVALARA_API_BASE: "https://avatax.test",
};
const CONTACT = { name: "Pat Example", email: "pat@example.test", street: "42 Sample Lane", city: "Springfield", state: "OH", zip: "45501" };
const TAX = {
  rate: 0.0725, amount: 670.38, label: "Sales tax", taxableSubtotal: 9335, nonTaxableSubtotal: 0, taxableBase: 9335, nonTaxableNet: 0,
  source: "fallback", jurisdiction: null, address: { state: "OH", zip: "45501" }, resolvedAt: "2026-10-01T15:00:00Z",
  basis: "company", locationId: null, locationName: null, verifiedAt: null,
};
const LINES = {
  version: 1, discount: 0, tax: TAX,
  lines: [
    { kind: "building", itemKey: "", name: "12x24 Lofted Barn", desc: "Base building", qty: 1, amount: 8950 },
    { kind: "door", itemKey: "door-9lite", name: "9-Lite Entry Door", desc: "", qty: 1, amount: 385 },
  ],
};
const LIVE_PRICE = { price_cents: 0, active: false, visible: true }; // usage_prices(tax_lookup) on 2026-10-05
const ARMED = { price_cents: 10, active: true, visible: true };
const DOWN = { message: "connection reset", code: "08006" };

type World = {
  price?: Record<string, unknown> | null;      // the tax_lookup row; undefined = the live row
  priceError?: boolean;
  wallet?: Record<string, unknown> | null;     // the wallet_accounts row; null = none
  walletError?: boolean;
  walletThrows?: boolean;
  billingExempt?: boolean;
  sentToCustomer?: boolean;                     // ss_quote_sent_at set: confirmResend is needed
};
type Trace = { reads: string[]; writes: string[]; rpcs: string[]; fetched: string[]; errors: Record<string, unknown>[] };

function answer(world: World, table: string, ops: any[][]): { data: unknown; error: unknown } {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const cols = String((ops.find((o) => o[0] === "select") ?? [])[1] ?? "");
  if (table === "client_users") return { data: [{ client_id: T, role: "owner", title: null, access: null, user_id: "u1", prefs: null }], error: null };
  if (table === "admin_audit") return { data: null, error: null };
  if (table === "client_settings") {
    return { data: { invoice_in_ghl: false, tax_lookup_enabled: true, ss_tax_label: "Sales tax", ss_tax_rate: 0.0725, billing_exempt: world.billingExempt === true }, error: null };
  }
  if (table === "designs") {
    if (has("update")) return { data: null, error: null };
    return {
      data: {
        short_code: CODE, status: "sent", accepted_at: null, updated_at: "2026-10-01T15:00:00Z", estimate_lines: LINES, total_cents: 1000538,
        ss_quote_number: "SST-1001", ss_quote_sent_at: world.sentToCustomer ? "2026-10-01T15:05:00Z" : null, image_url: null, contact: CONTACT,
      },
      error: null,
    };
  }
  if (table === "design_acceptances" || table === "orders" || table === "builder_locations") return { data: [], error: null };
  if (table === "usage_prices") {
    if (world.priceError) return { data: null, error: DOWN };
    return { data: world.price === undefined ? LIVE_PRICE : world.price, error: null };
  }
  if (table === "wallet_accounts") {
    if (world.walletError) return { data: null, error: DOWN };
    return { data: world.wallet === undefined ? null : world.wallet, error: null };
  }
  void cols;
  return { data: has("maybeSingle") || has("single") ? null : [], error: null };
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    if (table === "app_errors") {
      trace.errors.push((ops.find((o) => o[0] === "insert") ?? [])[1]);
      return Promise.resolve({ error: null }).then(ok, bad);
    }
    const verb = ops.find((o) => ["select", "insert", "update", "delete", "upsert"].includes(o[0]))?.[0] ?? "?";
    (verb === "select" ? trace.reads : trace.writes).push(table);
    if (table === "wallet_accounts" && world.walletThrows) return Promise.reject(new Error("socket hang up")).then(ok, bad);
    return Promise.resolve().then(() => answer(world, table, ops)).then(ok, bad);
  };
  return q;
}

async function drive(payload: Record<string, unknown>, world: World = {}) {
  const trace: Trace = { reads: [], writes: [], rpcs: [], fetched: [], errors: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  stubRpc.rpc = (fn: string) => {
    trace.rpcs.push(fn);
    // The claim refuses at the daily cap: a press that got this far stops at the ledger.
    if (fn === "claim_tax_lookup") return Promise.resolve({ data: { refused: "daily_cap" }, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    trace.fetched.push(url);
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(payload),
    }));
    return { status: res.status, body: await res.json(), trace };
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

const PRESS = { action: "verify_tax", shortCode: CODE, confirmResend: true };
/** A press whose confirm stated the armed price (ARMED, 10c). */
const PRICED = { ...PRESS, quotedPriceCents: 10 };
const SAY_FUNDS = (price: string, has: string) =>
  `A verified tax lookup costs ${price} and your wallet has ${has}. Add funds in Settings → Billing. The estimate keeps its current tax rate.`;

/** The press got past the wallet: one claim, refused at the cap by the stub, nothing fetched. */
function reachedClaim(out: Awaited<ReturnType<typeof drive>>, label: string) {
  assertEquals([out.status, out.body.reason], [429, "daily_cap"], `${label}: ${JSON.stringify(out.body)}`);
  assertEquals(out.trace.rpcs.filter((r) => r === "claim_tax_lookup").length, 1, `${label}: the claim ran once`);
  assertEquals(out.trace.fetched, [], `${label}: nothing reached the tax service`);
}

/** The press was refused before the claim: no ledger row, no request, no quote write. */
function refusedBeforeClaim(out: Awaited<ReturnType<typeof drive>>, label: string) {
  assertEquals(out.trace.rpcs.filter((r) => r === "claim_tax_lookup"), [], `${label}: no claim, so no ledger row and nothing counted`);
  assertEquals(out.trace.fetched, [], `${label}: nothing reached the tax service`);
  assert(!out.trace.writes.includes("designs"), `${label}: the quote was not written`);
}

// ─── 1. the live state ─────────────────────────────────────────────────────────────────────────
Deno.test("disarmed (the live row, 0c): an empty wallet, or none at all, still reaches the claim", async () => {
  for (const wallet of [null, { balance_cents: 0, held_cents: 0, metered_exempt: false }, { balance_cents: -40, held_cents: 0, metered_exempt: false }]) {
    reachedClaim(await drive(PRESS, { wallet }), JSON.stringify(wallet));
  }
  reachedClaim(await drive(PRESS, { price: { price_cents: 10, active: false, visible: true }, wallet: null }), "priced but not armed");
  reachedClaim(await drive(PRESS, { price: { price_cents: 0, active: true, visible: true }, wallet: null }), "armed at zero");
  reachedClaim(await drive(PRESS, { price: null, wallet: null }), "no price row at all");
  reachedClaim(await drive(PRESS, { walletError: true }), "disarmed, and the wallet read failed: nothing to check");
});

// ─── 2-3. armed, and the wallet cannot cover it ────────────────────────────────────────────────
Deno.test("armed, a wallet that can't cover the press: 402 with the server's sentence, before the claim", async () => {
  const out = await drive(PRESS, { price: ARMED, wallet: { balance_cents: 9, held_cents: 0, metered_exempt: false } });
  assertEquals(out.status, 402, JSON.stringify(out.body));
  assertEquals(out.body, { error: SAY_FUNDS("$0.10", "$0.09"), reason: "insufficient_funds", code: "insufficient_funds", priceCents: 10, balanceCents: 9 });
  refusedBeforeClaim(out, "9c");
  assertEquals(out.trace.errors, [], "a refusal is the product working, not an app_errors row");
});

Deno.test("armed: no wallet row is $0.00, and money held for another charge is not available", async () => {
  const none = await drive(PRESS, { price: ARMED, wallet: null });
  assertEquals([none.status, none.body.error], [402, SAY_FUNDS("$0.10", "$0.00")]);
  refusedBeforeClaim(none, "no wallet row");

  const held = await drive(PRESS, { price: ARMED, wallet: { balance_cents: 2005, held_cents: 2000, metered_exempt: false } });
  assertEquals([held.status, held.body.error], [402, SAY_FUNDS("$0.10", "$0.05")]);
  refusedBeforeClaim(held, "held");

  const below = await drive(PRESS, { price: { price_cents: 25, active: true, visible: false }, wallet: { balance_cents: -30, held_cents: 0, metered_exempt: false } });
  assertEquals([below.status, below.body.error], [402, SAY_FUNDS("$0.25", "-$0.30")], "the meter's price, never a hardcoded 10c");
});

// ─── 4. what goes through ──────────────────────────────────────────────────────────────────────
Deno.test("armed: exactly the price, a wallet-exempt tenant and a billing-exempt account all reach the claim", async () => {
  reachedClaim(await drive(PRICED, { price: ARMED, wallet: { balance_cents: 10, held_cents: 0, metered_exempt: false } }), "exactly 10c");
  // Exempt presses cost nothing, so they need no stated price either.
  reachedClaim(await drive(PRESS, { price: ARMED, wallet: { balance_cents: 0, held_cents: 0, metered_exempt: true } }), "metered_exempt");
  reachedClaim(await drive(PRESS, { price: ARMED, wallet: null, billingExempt: true }), "billing_exempt, no wallet row");
  reachedClaim(await drive(PRESS, { price: ARMED, walletError: true, billingExempt: true }), "billing_exempt decides without the wallet");
  reachedClaim(await drive(PRESS, { price: ARMED, walletThrows: true, billingExempt: true }), "billing_exempt, and the wallet read threw");
});

Deno.test("an exempt tenant is never refused over a price read that failed: it can never be charged", async () => {
  const billing = await drive(PRESS, { priceError: true, wallet: null, billingExempt: true });
  reachedClaim(billing, "billing_exempt");
  assertEquals(billing.trace.errors, [], "nothing filed: nothing was refused");
  reachedClaim(await drive(PRESS, { priceError: true, wallet: { balance_cents: 0, held_cents: 0, metered_exempt: true } }), "metered_exempt");
});

// ─── 5. fail closed ────────────────────────────────────────────────────────────────────────────
Deno.test("a price or wallet read that fails refuses 503 meter_unavailable, files tax_meter, and never claims", async () => {
  for (const [label, world] of [
    ["the wallet read errored", { price: ARMED, walletError: true }],
    ["the wallet read threw", { price: ARMED, walletThrows: true }],
    ["the price read errored", { priceError: true, wallet: { balance_cents: 900, held_cents: 0, metered_exempt: false } }],
  ] as [string, World][]) {
    const out = await drive(PRESS, world);
    assertEquals([out.status, out.body.reason], [503, "meter_unavailable"], `${label}: ${JSON.stringify(out.body)}`);
    assert(/nothing was looked up/.test(out.body.error) && /keeps its current tax rate/.test(out.body.error), out.body.error);
    refusedBeforeClaim(out, label);
    assertEquals(out.trace.errors.map((r) => r?.code), ["tax_meter"], `${label}: one row support can find`);
  }
});

// ─── 6. the confirmations first ────────────────────────────────────────────────────────────────
Deno.test("a quote the customer holds is asked about first, without reading the wallet; the confirmed press is the one refused", async () => {
  const world: World = { price: ARMED, wallet: { balance_cents: 0, held_cents: 0, metered_exempt: false }, sentToCustomer: true };
  const ask = await drive({ action: "verify_tax", shortCode: CODE }, world);
  assertEquals([ask.status, ask.body.reason], [409, "quote_sent"], JSON.stringify(ask.body));
  assert(!ask.trace.reads.includes("wallet_accounts") && !ask.trace.reads.includes("usage_prices"), `read: ${ask.trace.reads.join(", ")}`);

  const confirmed = await drive({ action: "verify_tax", shortCode: CODE, confirmResend: true }, world);
  assertEquals([confirmed.status, confirmed.body.reason], [402, "insufficient_funds"]);
  refusedBeforeClaim(confirmed, "confirmed");
});

// ─── 8. the price the confirm stated ───────────────────────────────────────────────────────────
Deno.test("armed: a press that carries no price, or another one, is 409 price_changed naming the price, before the claim", async () => {
  const wallet = { balance_cents: 900, held_cents: 0, metered_exempt: false };
  for (const [label, body] of [
    ["no price (a card opened before the meter was armed)", PRESS],
    ["null (the card's price read failed)", { ...PRESS, quotedPriceCents: null }],
    ["a stale figure", { ...PRESS, quotedPriceCents: 5 }],
  ] as [string, Record<string, unknown>][]) {
    const out = await drive(body, { price: ARMED, wallet });
    assertEquals([out.status, out.body.reason, out.body.priceCents], [409, "price_changed", 10], `${label}: ${JSON.stringify(out.body)}`);
    assert(out.body.error.includes("$0.10 from your wallet") && /Nothing was looked up/.test(out.body.error), out.body.error);
    refusedBeforeClaim(out, label);
    assertEquals(out.trace.errors, [], `${label}: a question, not an app_errors row`);
  }
  reachedClaim(await drive(PRICED, { price: ARMED, wallet }), "the stated price");
  reachedClaim(await drive({ ...PRESS, quotedPriceCents: 10 }, { wallet }), "disarmed: a stale 10c confirm is free now, never refused");
});

// ─── 7. the price the confirm states ───────────────────────────────────────────────────────────
Deno.test("tax_settings: lookupPriceCents is the armed, shown price — null otherwise, and a failed read never fails the card", async () => {
  const price = async (world: World) => {
    const out = await drive({ action: "tax_settings" }, world);
    assertEquals(out.status, 200, JSON.stringify(out.body));
    assertEquals([out.body.ssMode, out.body.lookupEnabled], [true, true], "the rest of the card still loads");
    return out.body.lookupPriceCents;
  };
  assertEquals(await price({}), null, "the live row: disarmed at 0c");
  assertEquals(await price({ price: ARMED }), 10);
  assertEquals(await price({ price: { price_cents: 10, active: true, visible: false } }), null, "hidden");
  assertEquals(await price({ price: { price_cents: 10, active: false, visible: true } }), null, "priced, not armed");
  assertEquals(await price({ price: { price_cents: 0, active: true, visible: true } }), null, "armed, unpriced");
  assertEquals(await price({ priceError: true }), null, "unreadable");
  assertEquals(await price({ price: ARMED, billingExempt: true }), null, "billing_exempt: a press is never charged");
  assertEquals(await price({ price: ARMED, wallet: { balance_cents: 0, held_cents: 0, metered_exempt: true } }), null, "metered_exempt");
  assertEquals(await price({ price: ARMED, walletError: true }), 10, "a wallet read that failed is not an exemption");
  assertEquals(await price({ price: ARMED, walletThrows: true }), 10, "nor is one that threw");
});
