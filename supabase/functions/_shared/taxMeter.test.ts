// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// This is BILLING CODE, and the failure that matters is the quiet one: a meter that charges
// when it should not. 169_sms_meters_disarmed exists because 165 shipped its meters armed and
// the first builder to register would have been charged $49 by code nobody had watched run.
// So the cases below spend most of their effort on the paths that must write NOTHING.
//
// The other half is what wallet_credit does NOT do. It moves the balance and records the row;
// it does not read usage_prices, does not honour metered_exempt and does not refuse on
// insufficient funds. Those checks live in wallet_hold, which this path deliberately avoids
// (wallet_tx_one_hold is unique on (client_id, meter_kind), so two staff invoicing at once
// would collide) — which means taxMeter.ts owns them, and a regression there is real money.

import { chargeTaxCalculation, taxInvoiceIdem, taxLookupIdem } from "./taxMeter.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

type Calls = { rpc: { name: string; args: Record<string, unknown> }[] };

/** Minimal service-role stub covering only what chargeTaxCalculation touches. */
function makeAdmin(opts: {
  price?: { price_cents: number; active: boolean } | null;
  priceError?: boolean;
  account?: { metered_exempt: boolean } | null;
  accountError?: boolean;
  creditError?: boolean;
  balance?: number;
}) {
  const calls: Calls = { rpc: [] };
  const admin = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.maybeSingle = () => {
        if (table === "usage_prices") {
          return Promise.resolve(
            opts.priceError
              ? { data: null, error: { message: "boom" } }
              : { data: opts.price === undefined ? { price_cents: 100, active: true } : opts.price, error: null },
          );
        }
        if (table === "wallet_accounts") {
          return Promise.resolve(
            opts.accountError
              ? { data: null, error: { message: "boom" } }
              : { data: opts.account ?? null, error: null },
          );
        }
        return Promise.resolve({ data: null, error: null });
      };
      return chain;
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push({ name, args });
      return Promise.resolve(
        opts.creditError
          ? { data: null, error: { message: "boom" } }
          : { data: opts.balance ?? 900, error: null },
      );
    },
  };
  return { admin, calls };
}

const base = { clientId: "acme", kind: "tax_invoice" as const, idem: "k", refType: "invoice", refId: "1" };

// ── The paths that must write NOTHING ────────────────────────────────────────────────

Deno.test("a DISARMED meter charges nothing — the whole point of shipping 179 inactive", async () => {
  const { admin, calls } = makeAdmin({ price: { price_cents: 250, active: false } });
  const r = await chargeTaxCalculation(admin, base);
  assertEquals(r, { charged: false, reason: "inactive" });
  assertEquals(calls.rpc.length, 0, "no wallet write may happen while disarmed");
});

Deno.test("an ARMED but UNPRICED meter charges nothing rather than posting a zero debit", async () => {
  // 179 seeds both meters at 0 on purpose. This is the state between "armed" and "priced",
  // and a £0.00 row in a builder's wallet history is noise they would have to ask about.
  const { admin, calls } = makeAdmin({ price: { price_cents: 0, active: true } });
  const r = await chargeTaxCalculation(admin, base);
  assertEquals(r, { charged: false, reason: "unpriced" });
  assertEquals(calls.rpc.length, 0);
});

Deno.test("an UNKNOWN meter charges nothing — the migration may not be applied yet", async () => {
  const { admin, calls } = makeAdmin({ price: null });
  const r = await chargeTaxCalculation(admin, base);
  assertEquals(r, { charged: false, reason: "unknown_meter" });
  assertEquals(calls.rpc.length, 0);
});

Deno.test("an EXEMPT tenant charges nothing — wallet_credit would not have checked", async () => {
  // CSM Synergy's own account and the demo tenants carry metered_exempt. Charging them puts
  // our own money through the ledger and makes every revenue figure wrong.
  const { admin, calls } = makeAdmin({ price: { price_cents: 250, active: true }, account: { metered_exempt: true } });
  const r = await chargeTaxCalculation(admin, base);
  assertEquals(r, { charged: false, reason: "exempt" });
  assertEquals(calls.rpc.length, 0);
});

Deno.test("a MISSING wallet row is not exempt — it is a tenant never charged before", async () => {
  const { admin, calls } = makeAdmin({ price: { price_cents: 250, active: true }, account: null });
  const r = await chargeTaxCalculation(admin, base);
  assertEquals(r.charged, true);
  assertEquals(calls.rpc.length, 1, "wallet_credit creates the row itself");
});

// ── The path that must write ─────────────────────────────────────────────────────────

Deno.test("an armed, priced, non-exempt tenant is debited the price NEGATIVELY", async () => {
  const { admin, calls } = makeAdmin({ price: { price_cents: 250, active: true }, balance: 4750 });
  const r = await chargeTaxCalculation(admin, { ...base, idem: "tax_invoice:acme:SS-1:7", memo: "m", actorUserId: "u1" });
  assertEquals(r, { charged: true, priceCents: 250, balanceAfterCents: 4750 });
  assertEquals(calls.rpc.length, 1);
  const { name, args } = calls.rpc[0];
  assertEquals(name, "wallet_credit");
  assertEquals(args.p_amount_cents, -250, "a charge is a NEGATIVE credit");
  assertEquals(args.p_kind, "debit");
  assertEquals(args.p_client_id, "acme");
  assertEquals(args.p_idem, "tax_invoice:acme:SS-1:7");
  assertEquals(args.p_actor, "u1");
});

// ── Failures must never propagate ────────────────────────────────────────────────────

Deno.test("every failure reports and swallows — a billing fault cannot kill an invoice", async () => {
  // The tax is already stamped and the customer is waiting on the document by the time this
  // runs. Losing a charge costs cents; throwing here would cost the builder a sale.
  for (const opts of [{ priceError: true }, { accountError: true }, { creditError: true }]) {
    const { admin } = makeAdmin({ price: { price_cents: 250, active: true }, ...opts });
    const r = await chargeTaxCalculation(admin, base);
    assertEquals(r, { charged: false, reason: "error" }, JSON.stringify(opts));
  }
});

Deno.test("a thrown client is caught too, not just a returned error", async () => {
  const admin = { from() { throw new Error("network"); }, rpc() { throw new Error("network"); } };
  const r = await chargeTaxCalculation(admin, base);
  assertEquals(r, { charged: false, reason: "error" });
});

// ── Idempotency keys: derived from the ACT, never from a clock ───────────────────────

Deno.test("resending the SAME invoice reuses the key, so it cannot charge twice", () => {
  assertEquals(taxInvoiceIdem("acme", "SS-1", 7), taxInvoiceIdem("acme", "SS-1", 7));
  assert(!taxInvoiceIdem("acme", "SS-1", 7).includes("undefined"));
});

Deno.test("a genuinely different invoice, design or tenant gets its own key", () => {
  const k = taxInvoiceIdem("acme", "SS-1", 7);
  assert(k !== taxInvoiceIdem("acme", "SS-1", 8), "a second invoice is a second charge");
  assert(k !== taxInvoiceIdem("acme", "SS-2", 7), "a different design is a different charge");
  assert(k !== taxInvoiceIdem("other", "SS-1", 7), "tenants must never share a key");
});

Deno.test("a null invoice number still yields a stable key", () => {
  assertEquals(taxInvoiceIdem("acme", "SS-1", null), taxInvoiceIdem("acme", "SS-1", null));
  assert(!taxInvoiceIdem("acme", "SS-1", null).includes("null"));
});

Deno.test("a lookup key folds an unchanged resubmit but splits on a real rate change", () => {
  // resolveRate is live-until-signed, so a resubmit CAN legitimately return a different rate
  // — that is a new billable lookup. An identical answer is the same one.
  const same = taxLookupIdem("acme", "SS-1", 0.0725, "Bibb County, GA");
  assertEquals(same, taxLookupIdem("acme", "SS-1", 0.0725, "Bibb County, GA"));
  assert(same !== taxLookupIdem("acme", "SS-1", 0.08, "Bibb County, GA"), "a new rate is a new lookup");
  assert(same !== taxLookupIdem("acme", "SS-1", 0.0725, "Fulton County, GA"), "a new jurisdiction too");
});

Deno.test("the two meters can never collide on one key", () => {
  // Arming both would double-charge; that is meant to be a visible config mistake. The keys
  // being distinct means it would at least show as two rows rather than one silently winning.
  assert(taxInvoiceIdem("acme", "SS-1", 7) !== taxLookupIdem("acme", "SS-1", 0.0725, null));
});

Deno.test("a float rate does not produce a drifting key", () => {
  // 0.1 + 0.0625 is 0.16250000000000003. Keyed raw, the same lookup could mint two keys.
  assertEquals(taxLookupIdem("acme", "SS-1", 0.1 + 0.0625, null), taxLookupIdem("acme", "SS-1", 0.1625, null));
});
