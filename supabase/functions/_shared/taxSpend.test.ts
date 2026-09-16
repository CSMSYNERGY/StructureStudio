// Unit tests for _shared/taxSpend.ts — the paid Avalara lookup behind the Verify button and the
// invoice-time check (2026-09-17).
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// Every failure worth pinning here spends money or changes a quote without anyone noticing:
// a refusal that runs after the ledger row (a press on a draft costs a lookup), a cap that
// reads "unknown" as zero, a failed lookup that is charged, two presses that collapse into one
// charge while the account paid for two calls, a verified rate replaced with nothing. No case
// reaches the network: every fetch is a stub and the base URL is a reserved .test host.
Deno.env.set("AVALARA_ACCOUNT_ID", "test-account");
Deno.env.set("AVALARA_LICENSE_KEY", "test-key");
Deno.env.set("AVALARA_API_BASE", "https://avatax.test");

const {
  chargeLookup, invoiceTaxCheck, invoiceTaxCheckPlan, lookupSwitchRefusal, paidLookup, parseVerifyTax,
  quoteSentRefusal, rateBucket, rateLimitedRefusal, verifiedTax, VERIFY_BUCKET_MAX, VERIFY_BUCKET_WINDOW_MS,
  verifyBucket, verifyLookupRefusal, verifyQuoteRefusal,
} = await import("./taxSpend.ts");
const { DAILY_TAX_LOOKUP_CAP } = await import("./taxLookups.ts");
const { taxLedgerIdem } = await import("./taxMeter.ts");
const { taxOn } = await import("./salesTax.ts");
const { designTotalCents } = await import("./estimateLines.ts");
import type { PaidLookup, PaidLookupFailure } from "./taxSpend.ts";

const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};
const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

const ADDR = { street: "100 Example Rd", city: "Macon", state: "Georgia", zip: "31201" };
const NO_ZIP = { street: "100 Example Rd", city: "Macon", state: "GA", zip: null };

// Taxable base 10,000; delivery 500 is not taxable. The same lines locationTax.test uses.
const LINES = [
  { kind: "building", itemKey: "", name: "Barn", desc: "", qty: 1, amount: 10000, nonTaxable: false },
  { kind: "delivery", itemKey: "", name: "Delivery", desc: "", qty: 1, amount: 500, nonTaxable: true },
];
const storedTax = (extra: Record<string, unknown> = {}) => ({
  rate: 0.0725, amount: 725, label: "County sales tax",
  taxableSubtotal: 10000, nonTaxableSubtotal: 500, taxableBase: 10000, nonTaxableNet: 500,
  source: "fallback", jurisdiction: null, address: { state: "GA", zip: "31201" }, resolvedAt: "2026-09-17T08:00:00Z",
  reason: "address changed — re-verify", basis: "location", locationId: "lot-1", locationName: "Macon lot", verifiedAt: null,
  ...extra,
});
const quote = (tax: unknown = storedTax()) => ({ version: 1, discount: 0, lines: LINES, tax });

/** Swap globalThis.fetch for one case, always restoring it, and count the requests. */
async function withFetch(respond: (n: number) => Promise<Response>, run: () => Promise<void>): Promise<number> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => respond(++calls)) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
  return calls;
}
const avalaraOk = (totalRate = 0.08, county = "Bibb") => () =>
  Promise.resolve(new Response(JSON.stringify({ totalRate, rates: [{ type: "County", name: county }] }), { status: 200 }));
const avalaraStatus = (code: number, body: unknown = "") => () =>
  Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status: code }));
const noFetch = () => Promise.reject(new Error("a request was made where none may be"));

async function withoutCredentials(run: () => Promise<void>) {
  const id = Deno.env.get("AVALARA_ACCOUNT_ID"), key = Deno.env.get("AVALARA_LICENSE_KEY");
  Deno.env.delete("AVALARA_ACCOUNT_ID");
  Deno.env.delete("AVALARA_LICENSE_KEY");
  try { await run(); } finally {
    if (id) Deno.env.set("AVALARA_ACCOUNT_ID", id);
    if (key) Deno.env.set("AVALARA_LICENSE_KEY", key);
  }
}

type Answer = { data?: unknown; error?: unknown; count?: unknown };

/**
 * A service-role client stub with an in-memory tax_lookups table, a canned meter, a canned wallet
 * row and a rate_buckets row. Records every `from` chain and every RPC.
 */
function fakeAdmin(opts: {
  count?: number | null;          // null = the count read fails
  insertFails?: boolean;
  closeFails?: boolean;
  price?: { active: boolean; price_cents: number } | null;
  exempt?: boolean;
  bucket?: { window_started_at: string; hits: number } | null;
  bucketReadFails?: boolean;
} = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const chains: { table: string; ops: unknown[][] }[] = [];
  const rpcs: [string, Record<string, unknown>][] = [];
  const upserts: Record<string, unknown>[] = [];
  const answer = (table: string, ops: unknown[][]): Answer => {
    const first = ops[0]?.[0];
    if (table === "tax_lookups") {
      if (first === "select") return opts.count === null ? { error: { message: "down" } } : { count: opts.count ?? 0 };
      if (first === "insert") {
        if (opts.insertFails) return { error: { message: "denied" } };
        const id = crypto.randomUUID();
        rows.set(id, { ...(ops[0][1] as Record<string, unknown>), outcome: null, finished_at: null });
        return { data: { id } };
      }
      if (first === "update") {
        if (opts.closeFails) return { error: { message: "down" } };
        const id = String((ops.find((o) => o[0] === "eq" && o[1] === "id") ?? [])[2]);
        const row = rows.get(id);
        if (!row || row.finished_at) return { data: [] };
        Object.assign(row, ops[0][1] as Record<string, unknown>);
        return { data: [{ id }] };
      }
    }
    if (table === "usage_prices") return { data: opts.price === undefined ? { active: false, price_cents: 0 } : opts.price };
    if (table === "wallet_accounts") return { data: { metered_exempt: opts.exempt === true } };
    if (table === "rate_buckets") {
      if (first === "select") return opts.bucketReadFails ? { error: { message: "down" } } : { data: opts.bucket ?? null };
      if (first === "upsert") { upserts.push(ops[0][1] as Record<string, unknown>); return {}; }
    }
    return {};
  };
  const admin = {
    from(table: string) {
      const rec = { table, ops: [] as unknown[][] };
      chains.push(rec);
      // deno-lint-ignore no-explicit-any
      const chain: any = {};
      for (const m of ["insert", "update", "upsert", "select", "eq", "is", "in", "gt", "single", "maybeSingle"]) {
        chain[m] = (...args: unknown[]) => { rec.ops.push([m, ...args]); return chain; };
      }
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null, count: null, ...answer(table, rec.ops) }).then(res, rej);
      return chain;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcs.push([name, args]);
      return Promise.resolve({ data: 4900, error: null });
    },
  };
  const touched = (table: string, op: string) => chains.some((c) => c.table === table && c.ops[0]?.[0] === op);
  return { admin, rows, chains, rpcs, upserts, touched };
}

/** One paidLookup against a fetch stub: the outcome and how many requests it made. */
async function run(admin: unknown, input: Parameters<typeof paidLookup>[1], respond: (n: number) => Promise<Response>) {
  const box: { r?: PaidLookup } = {};
  const calls = await withFetch(respond, async () => { box.r = await paidLookup(admin, input); });
  return { r: box.r!, calls };
}
const failureOf = (r: PaidLookup) => (r.ok ? null : r.failure);

const lookupInput = (address: Record<string, unknown> = ADDR) => ({
  clientId: "acme", kind: "verify" as const, shortCode: "SS-ABCDEFGH", address: address as never,
  fallbackRate: 0.0725, actorUserId: "0b6f7c1d-2e3a-4b5c-8d9e-0f1a2b3c4d5e", operator: false,
});

// ── parseVerifyTax ───────────────────────────────────────────────────────────────────────────

Deno.test("parseVerifyTax: a short code is required; the confirmations are true only when literally true", () => {
  for (const p of [null, {}, { shortCode: "" }, { shortCode: "   " }, "SS-1"]) {
    const r = parseVerifyTax(p);
    assert(!r.ok, `${JSON.stringify(p)} must be refused`);
    if (!r.ok) assertEquals([r.refusal.status, r.refusal.body.reason], [400, "bad_request"]);
  }
  assertEquals(parseVerifyTax({ shortCode: " SS-1 " }), { ok: true, value: { shortCode: "SS-1", confirmResend: false, confirmVerify: false } });
  assertEquals(parseVerifyTax({ shortCode: "SS-1", confirmResend: "true", confirmVerify: 1 }),
    { ok: true, value: { shortCode: "SS-1", confirmResend: false, confirmVerify: false } }, "a truthy non-boolean is not consent");
  assertEquals(parseVerifyTax({ shortCode: "SS-1", confirmResend: true, confirmVerify: true }),
    { ok: true, value: { shortCode: "SS-1", confirmResend: true, confirmVerify: true } });
  const long = parseVerifyTax({ shortCode: "S".repeat(200) });
  assert(long.ok && long.value.shortCode.length === 64, "a long code is clipped, not refused");
});

// ── lookupSwitchRefusal ──────────────────────────────────────────────────────────────────────

Deno.test("lookupSwitchRefusal: switch off, CRM mode and no credentials are each lookup_disabled (403)", () => {
  const on = { lookupEnabled: true, ssMode: true, configured: true };
  assertEquals(lookupSwitchRefusal(on), null);
  for (const off of [{ lookupEnabled: false }, { ssMode: false }, { configured: false }]) {
    const r = lookupSwitchRefusal({ ...on, ...off });
    assertEquals([r?.status, r?.body.reason], [403, "lookup_disabled"], JSON.stringify(off));
  }
  // The switch is named first: a tenant with it off hears about the switch, not our credentials.
  const all = lookupSwitchRefusal({ lookupEnabled: false, ssMode: false, configured: false });
  assert(/switched on/.test(String(all?.body.error)), "the switch sentence must win when everything is off");
});

// ── verifyQuoteRefusal ───────────────────────────────────────────────────────────────────────

Deno.test("verifyQuoteRefusal: nothing issued is no_quote (409) — issue the quote first", () => {
  for (const snap of [null, undefined, {}, { lines: LINES }, { lines: LINES, tax: null }, { lines: LINES, tax: 0.0725 }, { tax: storedTax() }]) {
    const r = verifyQuoteRefusal({ snap, address: ADDR, operator: false, confirmVerify: false });
    assertEquals([r?.status, r?.body.reason], [409, "no_quote"], JSON.stringify(snap));
    assert(/issue the quote first/.test(String(r?.body.error)));
  }
});

Deno.test("verifyQuoteRefusal: an address with no ZIP or no recognisable state is no_address (400)", () => {
  for (const address of [NO_ZIP, { ...ADDR, state: "Atlantis" }, { ...ADDR, state: null }, { street: null, city: null, state: null, zip: null }]) {
    const r = verifyQuoteRefusal({ snap: quote(), address: address as never, operator: false, confirmVerify: false });
    assertEquals([r?.status, r?.body.reason], [400, "no_address"], JSON.stringify(address));
  }
  assertEquals(verifyQuoteRefusal({ snap: quote(), address: ADDR, operator: false, confirmVerify: false }), null,
    "a full state name maps through stateCode and is enough");
});

Deno.test("verifyQuoteRefusal: an operator needs confirmVerify; a builder's own staff never do", () => {
  const r = verifyQuoteRefusal({ snap: quote(), address: ADDR, operator: true, confirmVerify: false });
  assertEquals([r?.status, r?.body.reason], [409, "confirm_operator"]);
  assertEquals(verifyQuoteRefusal({ snap: quote(), address: ADDR, operator: true, confirmVerify: true }), null);
  assertEquals(verifyQuoteRefusal({ snap: quote(), address: ADDR, operator: false, confirmVerify: false }), null);
});

Deno.test("verifyQuoteRefusal: refusals come in the spec's order — quote, then address, then operator", () => {
  assertEquals(verifyQuoteRefusal({ snap: null, address: NO_ZIP as never, operator: true, confirmVerify: false })?.body.reason, "no_quote");
  assertEquals(verifyQuoteRefusal({ snap: quote(), address: NO_ZIP as never, operator: true, confirmVerify: false })?.body.reason, "no_address");
});

// ── quoteSentRefusal ─────────────────────────────────────────────────────────────────────────

Deno.test("quoteSentRefusal: an emailed quote needs confirmResend before the lookup, and names what the customer holds", () => {
  const r = quoteSentRefusal({ sent: true, confirmResend: false, quoteNumber: "Q-104", totalCents: 1122500 });
  assertEquals([r?.status, r?.body.reason, r?.body.quoteNumber, r?.body.totalCents], [409, "quote_sent", "Q-104", 1122500]);
  assertEquals(quoteSentRefusal({ sent: true, confirmResend: true, quoteNumber: "Q-104", totalCents: 1122500 }), null);
  assertEquals(quoteSentRefusal({ sent: false, confirmResend: false, quoteNumber: null, totalCents: 1122500 }), null);
  assertEquals(quoteSentRefusal({ sent: true, confirmResend: false, quoteNumber: undefined, totalCents: null })?.body.quoteNumber, null);
});

// ── verifyLookupRefusal: the failure taxonomy, and the quote is always left alone ────────────

Deno.test("verifyLookupRefusal: every failure maps to the contract's status, reason and failure field", () => {
  const table: [PaidLookupFailure, number, string, string | undefined][] = [
    ["daily_cap", 429, "daily_cap", undefined],
    ["ledger_unavailable", 503, "ledger_unavailable", undefined],
    ["not_configured", 403, "lookup_disabled", undefined],
    ["bad_address", 400, "bad_address", undefined],
    ["credentials_rejected", 502, "lookup_failed", "credentials_rejected"],
    ["subscription", 502, "lookup_failed", "subscription"],
    ["rate_limited", 502, "lookup_failed", "rate_limited"],
    ["timeout", 502, "lookup_failed", "timeout"],
    ["network", 502, "lookup_failed", "network"],
    ["malformed", 502, "lookup_failed", "malformed"],
  ];
  for (const [failure, status, reason, field] of table) {
    const r = verifyLookupRefusal(failure);
    assertEquals([r.status, r.body.reason, r.body.failure], [status, reason, field], failure);
    assert(/keeps its current tax rate/.test(r.body.error), `${failure}: the refusal must say the quote is unchanged`);
    assert(!/avalara/i.test(r.body.error), `${failure}: a builder-facing sentence names "the tax service", not the vendor`);
  }
  assertEquals(verifyLookupRefusal("daily_cap").body.dailyCap, DAILY_TAX_LOOKUP_CAP);
});

Deno.test("rateLimitedRefusal: our own burst limit is 429 rate_limited, apart from Avalara's 429 (502 lookup_failed)", () => {
  const r = rateLimitedRefusal();
  assertEquals([r.status, r.body.reason, r.body.retryAfterSeconds], [429, "rate_limited", VERIFY_BUCKET_WINDOW_MS / 1000]);
  assertEquals(verifyLookupRefusal("rate_limited").status, 502);
});

// ── rateBucket (migration 204's pattern) ─────────────────────────────────────────────────────

Deno.test("rateBucket: counts first, refuses past the max, and a new window starts over", async () => {
  const now = Date.parse("2026-09-17T10:00:00Z");
  const fresh = fakeAdmin({ bucket: null });
  assertEquals(await rateBucket(fresh.admin, verifyBucket("acme"), VERIFY_BUCKET_MAX, VERIFY_BUCKET_WINDOW_MS, now), { over: false, hits: 1 });
  assertEquals(fresh.upserts[0], {
    bucket: "portal-settings:verify_tax:acme", window_started_at: new Date(now).toISOString(), hits: 1, updated_at: new Date(now).toISOString(),
  });

  const started = new Date(now - 30_000).toISOString();
  const atMax = fakeAdmin({ bucket: { window_started_at: started, hits: VERIFY_BUCKET_MAX - 1 } });
  assertEquals(await rateBucket(atMax.admin, "b", VERIFY_BUCKET_MAX, VERIFY_BUCKET_WINDOW_MS, now), { over: false, hits: VERIFY_BUCKET_MAX });
  const past = fakeAdmin({ bucket: { window_started_at: started, hits: VERIFY_BUCKET_MAX } });
  assertEquals(await rateBucket(past.admin, "b", VERIFY_BUCKET_MAX, VERIFY_BUCKET_WINDOW_MS, now), { over: true, hits: VERIFY_BUCKET_MAX + 1 });
  assertEquals(past.upserts[0].hits, VERIFY_BUCKET_MAX + 1, "the refused press is still counted, so the counter never freezes at the cap");
  assertEquals(past.upserts[0].window_started_at, started, "an open window keeps its start");

  const expired = fakeAdmin({ bucket: { window_started_at: new Date(now - VERIFY_BUCKET_WINDOW_MS).toISOString(), hits: 500 } });
  assertEquals(await rateBucket(expired.admin, "b", VERIFY_BUCKET_MAX, VERIFY_BUCKET_WINDOW_MS, now), { over: false, hits: 1 });
});

Deno.test("rateBucket fails OPEN (the daily cap behind it is what fails closed)", async () => {
  const down = fakeAdmin({ bucketReadFails: true });
  assertEquals(await rateBucket(down.admin, "b", 1, 60_000), { over: false, hits: 0 });
  assertEquals(down.upserts.length, 0, "an unreadable bucket is not overwritten");
  assertEquals(await rateBucket({ from() { throw new Error("network"); } }, "b", 1, 60_000), { over: false, hits: 0 });
});

// ── paidLookup: the cap fails closed, the row comes first ────────────────────────────────────

Deno.test("paidLookup: an unreadable count refuses — no row, no request (the cap fails CLOSED)", async () => {
  const f = fakeAdmin({ count: null });
  const { r, calls } = await run(f.admin, lookupInput(), noFetch);
  assertEquals(r, { ok: false, failure: "ledger_unavailable", lookupId: null, ledgerClosed: true });
  assertEquals(calls, 0, "no request");
  assert(!f.touched("tax_lookups", "insert"), "no row");
});

Deno.test("paidLookup: at the daily cap nothing is written or requested; one under, the lookup runs", async () => {
  const full = fakeAdmin({ count: DAILY_TAX_LOOKUP_CAP });
  const capped = await run(full.admin, lookupInput(), noFetch);
  assertEquals([capped.r.ok, failureOf(capped.r), capped.calls], [false, "daily_cap", 0]);
  assert(!full.touched("tax_lookups", "insert"));

  const under = fakeAdmin({ count: DAILY_TAX_LOOKUP_CAP - 1 });
  const one = await run(under.admin, lookupInput(), avalaraOk());
  assertEquals([one.r.ok, one.calls], [true, 1]);
});

Deno.test("paidLookup: a row that cannot be written refuses the lookup", async () => {
  const f = fakeAdmin({ insertFails: true });
  const { r, calls } = await run(f.admin, lookupInput(), noFetch);
  assertEquals([r, calls], [{ ok: false, failure: "ledger_unavailable", lookupId: null, ledgerClosed: true }, 0]);
});

Deno.test("paidLookup: a rate that comes back is one request, one row, closed with the answer", async () => {
  const f = fakeAdmin();
  const { r, calls } = await run(f.admin, { ...lookupInput(), operator: true }, avalaraOk(0.08, "Bibb"));
  assertEquals(calls, 1);
  if (!r.ok) throw new Error(`expected a rate, got ${r.failure}`);
  assertEquals([r.rate, r.jurisdiction, r.ledgerClosed], [0.08, "Bibb, Georgia", true]);
  const row = f.rows.get(r.lookupId)!;
  assertEquals([row.kind, row.client_id, row.short_code, row.region, row.postal_code, row.operator],
    ["verify", "acme", "SS-ABCDEFGH", "GA", "31201", true], "the row names the tenant, the quote and the place asked about");
  assertEquals([row.outcome, row.rate, row.attempts, row.http_status], ["ok", 0.08, 1, 200]);
  assert(row.finished_at, "closed");
});

Deno.test("paidLookup: Avalara's refusals close the row with their outcome and return no rate", async () => {
  const cases: [() => Promise<Response>, PaidLookupFailure, number][] = [
    [avalaraStatus(401), "credentials_rejected", 1],
    [avalaraStatus(403, { error: { code: "SubscriptionRequired" } }), "subscription", 1],
    [avalaraStatus(400), "bad_address", 1],
    [avalaraStatus(503), "network", 2],
  ];
  for (const [respond, failure, attempts] of cases) {
    const f = fakeAdmin();
    const { r, calls } = await run(f.admin, lookupInput(), respond);
    assertEquals([r.ok, failureOf(r), calls], [false, failure, attempts], failure);
    const row = f.rows.get(String(r.lookupId))!;
    assertEquals([row.outcome, row.attempts, row.rate], [failure, attempts, null], `${failure}: the row`);
  }
});

Deno.test("paidLookup: credentials gone after the caller checked — no request, the row closes not_configured", async () => {
  const f = fakeAdmin();
  const box: { out?: { r: PaidLookup; calls: number } } = {};
  await withoutCredentials(async () => { box.out = await run(f.admin, lookupInput(), noFetch); });
  const { r, calls } = box.out!;
  assertEquals([r.ok, failureOf(r), calls, r.ledgerClosed], [false, "not_configured", 0, true]);
  assertEquals(f.rows.get(String(r.lookupId))!.outcome, "not_configured");
});

Deno.test("paidLookup: an address resolveRate will not ask about — no request, the row is still closed", async () => {
  const f = fakeAdmin();
  const { r, calls } = await run(f.admin, lookupInput(NO_ZIP), noFetch);
  assertEquals([r.ok, failureOf(r), calls, r.ledgerClosed], [false, "bad_address", 0, true]);
  const row = f.rows.get(String(r.lookupId))!;
  assertEquals([row.outcome, row.attempts, row.http_status], ["bad_address", 0, null], "never left in flight against the cap");
});

Deno.test("paidLookup: a row that fails to close does not undo a rate that came back — the caller logs it", async () => {
  const f = fakeAdmin({ closeFails: true });
  const { r } = await run(f.admin, lookupInput(), avalaraOk());
  assertEquals([r.ok, r.ledgerClosed], [true, false]);
});

// ── chargeLookup: one charge per ledger row, only for a rate ─────────────────────────────────

const ARMED = { active: true, price_cents: 10 };
const chargeOpts = { clientId: "acme", kind: "tax_lookup" as const, refType: "design", refId: "SS-ABCDEFGH", memo: "m" };

Deno.test("chargeLookup: a lookup that produced no rate is never charged — not even read against the meter", async () => {
  for (const failure of ["timeout", "network", "credentials_rejected", "daily_cap", "ledger_unavailable"] as PaidLookupFailure[]) {
    const f = fakeAdmin({ price: ARMED });
    const r = await chargeLookup(f.admin, { ok: false, failure, lookupId: crypto.randomUUID(), ledgerClosed: true }, chargeOpts);
    assertEquals(r, { charged: false, reason: "no_rate" }, failure);
    assertEquals([f.rpcs.length, f.touched("usage_prices", "select")], [0, false], `${failure}: nothing touched`);
  }
});

Deno.test("chargeLookup: the charge is keyed on the ledger row — two presses are two charges, a replay is one", async () => {
  const f = fakeAdmin({ price: ARMED });
  const first: PaidLookup = { ok: true, lookupId: crypto.randomUUID(), rate: 0.08, jurisdiction: "Bibb, GA", ledgerClosed: true };
  const second: PaidLookup = { ...first, lookupId: crypto.randomUUID() }; // same answer, a second real request

  assertEquals(await chargeLookup(f.admin, first, chargeOpts), { charged: true, priceCents: 10, balanceAfterCents: 4900 });
  await chargeLookup(f.admin, second, chargeOpts);
  await chargeLookup(f.admin, first, chargeOpts); // a retried charge for the first press

  const keys = f.rpcs.map(([, a]) => a.p_idem);
  assertEquals(keys, [
    taxLedgerIdem("tax_lookup", first.lookupId), taxLedgerIdem("tax_lookup", second.lookupId), taxLedgerIdem("tax_lookup", first.lookupId),
  ]);
  assert(keys[0] !== keys[1], "the same rate twice must not collapse into one charge");
  assertEquals(f.rpcs.map(([name, a]) => [name, a.p_meter_kind, a.p_amount_cents]),
    [["wallet_credit", "tax_lookup", -10], ["wallet_credit", "tax_lookup", -10], ["wallet_credit", "tax_lookup", -10]]);
});

Deno.test("chargeLookup: with the meters as they are live (disarmed) a verified lookup charges nothing", async () => {
  const f = fakeAdmin(); // price row active=false, price_cents=0
  const ok: PaidLookup = { ok: true, lookupId: crypto.randomUUID(), rate: 0.08, jurisdiction: null, ledgerClosed: true };
  assertEquals(await chargeLookup(f.admin, ok, chargeOpts), { charged: false, reason: "inactive" });
  assertEquals(await chargeLookup(f.admin, ok, { ...chargeOpts, kind: "tax_invoice" }), { charged: false, reason: "inactive" });
  assertEquals(f.rpcs.length, 0);
});

// ── verifiedTax ──────────────────────────────────────────────────────────────────────────────

Deno.test("verifiedTax: the new stamp is Avalara's rate on the same lines, with the quote's label and no stale reason", () => {
  const now = "2026-09-17T12:00:00.000Z";
  const tax = verifiedTax({ snap: quote(), lookup: { rate: 0.08, jurisdiction: "Bibb, GA" }, companyLabel: "Sales tax", address: ADDR, now })!;
  assertEquals(
    [tax.rate, tax.amount, tax.source, tax.basis, tax.jurisdiction, tax.verifiedAt, tax.resolvedAt, tax.label],
    [0.08, taxOn(10000, 0.08), "avalara", "avalara", "Bibb, GA", now, now, "County sales tax"],
  );
  assertEquals([tax.locationId, tax.locationName, "reason" in tax], [null, null, false], "a verified rate belongs to no lot and answers 're-verify'");
  assertEquals(tax.address, { state: "Georgia", zip: "31201" });
  assertEquals([tax.taxableBase, tax.nonTaxableNet], [10000, 500]);
  assertEquals(designTotalCents({ ...quote(), tax }), 1130000, "10,000 + 800 tax + 500 delivery");

  const unlabeled = verifiedTax({ snap: quote(storedTax({ label: "" })), lookup: { rate: 0.08, jurisdiction: null }, companyLabel: "  GA tax ", address: ADDR })!;
  assertEquals(unlabeled.label, "GA tax");
  assertEquals(verifiedTax({ snap: quote(storedTax({ label: null })), lookup: { rate: 0.08, jurisdiction: null }, companyLabel: null, address: ADDR })!.label, "Sales tax");
  assertEquals(verifiedTax({ snap: { tax: storedTax() }, lookup: { rate: 0.08, jurisdiction: null }, companyLabel: null, address: ADDR }), null);
});

// ── send_invoice's informational check ───────────────────────────────────────────────────────

Deno.test("invoiceTaxCheckPlan: which sends make a lookup", () => {
  const base = { lookupEnabled: true, configured: true, reissue: false, agreedTax: storedTax(), address: ADDR };
  assertEquals(invoiceTaxCheckPlan(base), { lookup: true, agreedRate: 0.0725 });
  assertEquals(invoiceTaxCheckPlan({ ...base, lookupEnabled: false }), { lookup: false, taxCheck: { status: "skipped", reason: "lookup_disabled" } });
  assertEquals(invoiceTaxCheckPlan({ ...base, configured: false }), { lookup: false, taxCheck: { status: "skipped", reason: "lookup_disabled" } });
  assertEquals(invoiceTaxCheckPlan({ ...base, reissue: true }), { lookup: false, taxCheck: { status: "skipped", reason: "reissue" } },
    "an email retry of an issued invoice never pays for a second lookup");
  for (const agreedTax of [null, {}, { rate: "" }, { rate: 7.25 }]) {
    assertEquals(invoiceTaxCheckPlan({ ...base, agreedTax }), { lookup: false, taxCheck: { status: "skipped", reason: "no_tax" } }, JSON.stringify(agreedTax));
  }
  assertEquals(invoiceTaxCheckPlan({ ...base, agreedTax: storedTax({ rate: 0 }) }), { lookup: true, agreedRate: 0 }, "0% is an agreed rate");
  assertEquals(invoiceTaxCheckPlan({ ...base, address: NO_ZIP as never }),
    { lookup: false, taxCheck: { status: "failed", failure: "no_address", agreedRatePct: 7.25 } });
  // The switch outranks everything: a tenant with it off never reaches the address test.
  assertEquals(invoiceTaxCheckPlan({ ...base, lookupEnabled: false, reissue: true, agreedTax: null, address: NO_ZIP as never }).lookup, false);
});

Deno.test("invoiceTaxCheck: matched, differs and failed — and never a total", () => {
  const ok = (rate: number): PaidLookup => ({ ok: true, lookupId: crypto.randomUUID(), rate, jurisdiction: "Bibb, GA", ledgerClosed: true });
  assertEquals(invoiceTaxCheck(0.0725, ok(0.0725)), { status: "matched", verifiedRatePct: 7.25, agreedRatePct: 7.25, jurisdiction: "Bibb, GA" });
  assertEquals(invoiceTaxCheck(0.0725, ok(0.07250000001)), { status: "matched", verifiedRatePct: 7.25, agreedRatePct: 7.25, jurisdiction: "Bibb, GA" },
    "compared at the five places both are stored to");
  assertEquals(invoiceTaxCheck(0.0725, ok(0.08)), { status: "differs", verifiedRatePct: 8, agreedRatePct: 7.25, jurisdiction: "Bibb, GA" });
  assertEquals(invoiceTaxCheck(0.0725, { ok: false, failure: "timeout", lookupId: null, ledgerClosed: true }),
    { status: "failed", failure: "timeout", agreedRatePct: 7.25 });
  for (const check of [invoiceTaxCheck(0.0725, ok(0.08)), invoiceTaxCheck(0.0725, ok(0.0725))]) {
    assert(Object.keys(check).every((k) => !/total|amount|cents/i.test(k)), "a tax check reports rates, never a figure to bill");
  }
});
