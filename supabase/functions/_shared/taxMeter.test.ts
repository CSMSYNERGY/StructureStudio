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

import {
  chargeColumns, chargeStateOf, chargeTaxCalculation, markChargePending, recordLookupCharge, TAX_CHARGE_STATES,
  TAX_METER_FOR_LOOKUP, taxChargeMemo, taxInvoiceIdem, taxLedgerIdem, taxLookupIdem,
} from "./taxMeter.ts";
import { walletLineLabel } from "./walletLedger.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

type Calls = { rpc: { name: string; args: Record<string, unknown> }[]; txReads: unknown[][][] };

/** Minimal service-role stub covering only what chargeTaxCalculation touches. */
function makeAdmin(opts: {
  price?: { price_cents: number; active: boolean } | null;
  priceError?: boolean;
  account?: { metered_exempt: boolean } | null;
  accountError?: boolean;
  settings?: { billing_exempt: boolean } | null;
  settingsError?: boolean;
  creditError?: boolean;
  balance?: number;
  /** The wallet_transactions row the debit's key reads back (migration 319); undefined = none. */
  txId?: unknown;
  txError?: boolean;
}) {
  const calls: Calls = { rpc: [], txReads: [] };
  const admin = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const ops: unknown[][] = [];
      if (table === "wallet_transactions") calls.txReads.push(ops);
      chain.select = (...a: unknown[]) => (ops.push(["select", ...a]), chain);
      chain.eq = (...a: unknown[]) => (ops.push(["eq", ...a]), chain);
      chain.maybeSingle = () => {
        if (table === "wallet_transactions") {
          return Promise.resolve(opts.txError
            ? { data: null, error: { message: "boom" } }
            : { data: opts.txId === undefined ? null : { id: opts.txId }, error: null });
        }
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
        if (table === "client_settings") {
          return Promise.resolve(
            opts.settingsError
              ? { data: null, error: { message: "boom" } }
              : { data: opts.settings ?? null, error: null },
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

Deno.test("a NON-BILLABLE account charges nothing, even with no wallet exemption", async () => {
  // billing_exempt is the account posture set from the Billing posture card, and since
  // 2026-09-21 it means full access to everything — including free AI generations
  // (Carolyn, asked about this one specifically because it is real model spend).
  // Separate from metered_exempt, which is the per-wallet override for a BILLED tenant.
  const { admin, calls } = makeAdmin({
    price: { price_cents: 250, active: true },
    account: { metered_exempt: false },
    settings: { billing_exempt: true },
  });
  const r = await chargeTaxCalculation(admin, base);
  assertEquals(r, { charged: false, reason: "exempt" });
  assertEquals(calls.rpc.length, 0);
});

Deno.test("a client_settings read failure refuses rather than charging blind", async () => {
  const { admin, calls } = makeAdmin({
    price: { price_cents: 250, active: true },
    account: { metered_exempt: false },
    settingsError: true,
  });
  const r = await chargeTaxCalculation(admin, base);
  assertEquals(r, { charged: false, reason: "error" });
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
  assertEquals(r, { charged: true, priceCents: 250, balanceAfterCents: 4750, walletTxId: null });
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
  // 179's header says arming both would double-charge. Stale since 2026-09-17 (taxMeter.ts, "BOTH
  // METERS ARMED IS THE INTENDED STATE"): each meter is keyed on its own real call, and both are
  // meant to be armed. Distinct keys are still what keeps a lookup's charge and an invoice's apart.
  assert(taxInvoiceIdem("acme", "SS-1", 7) !== taxLookupIdem("acme", "SS-1", 0.0725, null));
});

Deno.test("a float rate does not produce a drifting key", () => {
  // 0.1 + 0.0625 is 0.16250000000000003. Keyed raw, the same lookup could mint two keys.
  assertEquals(taxLookupIdem("acme", "SS-1", 0.1 + 0.0625, null), taxLookupIdem("acme", "SS-1", 0.1625, null));
});

// ── The meter kind reaches the wallet row (migration 244) ────────────────────────────
// Before 244 wallet_credit dropped it, so every tax debit read "Usage" and no query could say
// what tax had cost a tenant.

Deno.test("every charge tells wallet_credit which meter it is, for both tax meters", async () => {
  for (const kind of ["tax_invoice", "tax_lookup"] as const) {
    const { admin, calls } = makeAdmin({ price: { price_cents: 10, active: true } });
    const r = await chargeTaxCalculation(admin, { ...base, kind });
    assertEquals(r.charged, true, kind);
    assertEquals(calls.rpc[0].args.p_meter_kind, kind, kind);
  }
});

// ── Keyed on the ledger row: one call, one row, one charge ───────────────────────────

const ROW = "3f0c2b1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c";
const ROW2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const ledgerBase = { clientId: "acme", kind: "tax_lookup" as const, refType: "tax_lookup", refId: ROW };

Deno.test("a lookupId charge is keyed on the tax_lookups row, not on the answer", async () => {
  const { admin, calls } = makeAdmin({ price: { price_cents: 10, active: true }, balance: 490 });
  const r = await chargeTaxCalculation(admin, { ...ledgerBase, lookupId: ROW });
  assertEquals(r, { charged: true, priceCents: 10, balanceAfterCents: 490, walletTxId: null });
  assertEquals(calls.rpc[0].args.p_idem, `tax_ledger:tax_lookup:${ROW}`);
  assertEquals(calls.rpc[0].args.p_meter_kind, "tax_lookup");
  assertEquals(calls.rpc[0].args.p_amount_cents, -10);
});

Deno.test("a second press is a second row, so a second key — even when the rate is identical", () => {
  // The answer-keyed taxLookupIdem folds these two together, which was right for an automatic
  // retry and wrong for a deliberate press: both presses made a call the account paid for.
  assert(taxLedgerIdem("tax_lookup", ROW) !== taxLedgerIdem("tax_lookup", ROW2), "two rows, two charges");
  assertEquals(taxLedgerIdem("tax_lookup", ROW), taxLedgerIdem("tax_lookup", ROW), "a replay of one row collapses");
  assert(taxLedgerIdem("tax_lookup", ROW) !== taxLedgerIdem("tax_invoice", ROW), "the meters never share a key");
});

Deno.test("a ledger key can never equal an answer-derived key", () => {
  // Even a tenant slug chosen to look like the ledger prefix cannot line the families up.
  const ledger = taxLedgerIdem("tax_lookup", ROW);
  assert(ledger !== taxLookupIdem("tax_ledger", "tax_lookup", 0, ROW));
  assert(ledger !== taxInvoiceIdem("tax_ledger", "tax_lookup", ROW));
  assert(ledger.startsWith("tax_ledger:") && !taxLookupIdem("acme", "SS-1", 0.07, null).startsWith("tax_ledger:"));
});

Deno.test("a disarmed meter charges nothing on the ledger path either", async () => {
  const { admin, calls } = makeAdmin({ price: { price_cents: 10, active: false } });
  assertEquals(await chargeTaxCalculation(admin, { ...ledgerBase, lookupId: ROW }), { charged: false, reason: "inactive" });
  assertEquals(calls.rpc.length, 0);
});

Deno.test("a charge with no usable key posts NOTHING and reads nothing", async () => {
  // wallet_credit treats an empty key as "no idempotency", so a retry would post twice.
  const keys: ({ idem: string } | { lookupId: string })[] = [
    { idem: "" },
    { lookupId: "" },
    { lookupId: "not-a-uuid" },
    { lookupId: `tax_ledger:tax_lookup:${ROW}` },
  ];
  for (const key of keys) {
    const { admin, calls } = makeAdmin({ price: { price_cents: 10, active: true } });
    let reads = 0;
    const spy = { from: (t: string) => { reads++; return admin.from(t); }, rpc: admin.rpc };
    const r = await chargeTaxCalculation(spy, { ...ledgerBase, ...key });
    assertEquals(r, { charged: false, reason: "error" }, JSON.stringify(key));
    assertEquals([reads, calls.rpc.length], [0, 0], `${JSON.stringify(key)}: nothing read, nothing posted`);
  }
});

// ── The wallet row, read back for the ledger (migration 319) ─────────────────────────

Deno.test("a posted charge names its wallet row, read back by the SAME key it was posted under", async () => {
  const { admin, calls } = makeAdmin({ price: { price_cents: 10, active: true }, balance: 490, txId: 4242 });
  const r = await chargeTaxCalculation(admin, { ...ledgerBase, lookupId: ROW });
  assertEquals(r, { charged: true, priceCents: 10, balanceAfterCents: 490, walletTxId: 4242 });
  assertEquals(calls.txReads.length, 1, "one read of the wallet row");
  assertEquals(calls.txReads[0], [
    ["select", "id"], ["eq", "client_id", "acme"], ["eq", "idempotency_key", `tax_ledger:tax_lookup:${ROW}`], ["eq", "state", "posted"],
  ], "read by tenant, the ledger key and posted: a replay finds the row the first attempt posted");
});

Deno.test("a wallet row that cannot be read back costs the link, never the charge", async () => {
  for (const opts of [{ txError: true }, { txId: "not-a-number" }, { txId: -3 }, { txId: 1.5 }, {}]) {
    const { admin } = makeAdmin({ price: { price_cents: 10, active: true }, balance: 490, ...opts });
    const r = await chargeTaxCalculation(admin, { ...ledgerBase, lookupId: ROW });
    assertEquals(r, { charged: true, priceCents: 10, balanceAfterCents: 490, walletTxId: null }, JSON.stringify(opts));
  }
  // A read that throws is caught too.
  const { admin } = makeAdmin({ price: { price_cents: 10, active: true }, balance: 490 });
  const throwing = {
    rpc: admin.rpc,
    from: (t: string) => {
      if (t === "wallet_transactions") throw new Error("socket");
      return admin.from(t);
    },
  };
  assertEquals(await chargeTaxCalculation(throwing, { ...ledgerBase, lookupId: ROW }), { charged: true, priceCents: 10, balanceAfterCents: 490, walletTxId: null });
});

Deno.test("nothing that is not charged reads the wallet row", async () => {
  for (const opts of [{ price: { price_cents: 10, active: false } }, { price: { price_cents: 0, active: true } }, { creditError: true }]) {
    const { admin, calls } = makeAdmin({ txId: 1, ...opts });
    await chargeTaxCalculation(admin, { ...ledgerBase, lookupId: ROW });
    assertEquals(calls.txReads.length, 0, JSON.stringify(opts));
  }
});

// ── The state each outcome is recorded as (migration 319) ────────────────────────────

Deno.test("every charge outcome maps to one of 319's states, and the columns match its CHECK", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");
  assertEquals(TAX_CHARGE_STATES, ["pending", "charged", "exempt", "inactive", "unpriced", "no_rate", "error"], "the list 319's CHECK holds");
  const cases: [Parameters<typeof chargeStateOf>[0], string][] = [
    [{ charged: true, priceCents: 10, balanceAfterCents: 490, walletTxId: 7 }, "charged"],
    [{ charged: false, reason: "exempt" }, "exempt"],
    [{ charged: false, reason: "inactive" }, "inactive"],
    [{ charged: false, reason: "unknown_meter" }, "inactive"],
    [{ charged: false, reason: "unpriced" }, "unpriced"],
    [{ charged: false, reason: "no_rate" }, "no_rate"],
    [{ charged: false, reason: "error" }, "error"],
  ];
  for (const [r, want] of cases) {
    assertEquals(chargeStateOf(r), want, JSON.stringify(r));
    const c = chargeColumns(r, now);
    assertEquals(c.charge_state, want);
    // 319: charged <=> charged_at <=> charge_cents; a wallet row only on a charged row.
    assertEquals(c.charged_at != null, want === "charged", `${want}: charged_at`);
    assertEquals(c.charge_cents != null, want === "charged", `${want}: charge_cents`);
    if (want !== "charged") assertEquals(c.wallet_tx_id, null, `${want}: wallet_tx_id`);
  }
  assertEquals(chargeColumns({ charged: true, priceCents: 10, balanceAfterCents: 490, walletTxId: 7 }, now),
    { charge_state: "charged", charge_cents: 10, wallet_tx_id: 7, charged_at: "2026-10-21T12:00:00.000Z" });
  assertEquals(TAX_METER_FOR_LOOKUP, { verify: "tax_lookup", invoice: "tax_invoice" });
});

/** A tax_lookups update recorder for the two state writers. */
function ledgerAdmin(answer: { data?: unknown; error?: unknown; throws?: boolean } = { data: [{ id: ROW }] }) {
  const writes: unknown[][][] = [];
  const admin = {
    from(table: string) {
      const ops: unknown[][] = [["table", table]];
      writes.push(ops);
      const q: Record<string, unknown> = {};
      for (const m of ["update", "eq", "is", "or", "select"]) q[m] = (...a: unknown[]) => (ops.push([m, ...a]), q);
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        (answer.throws ? Promise.reject(new Error("socket")) : Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null })).then(ok, bad);
      return q;
    },
  };
  return { admin, writes };
}

Deno.test("recordLookupCharge writes the outcome onto ITS row, and never over a row already charged", async () => {
  const { admin, writes } = ledgerAdmin();
  const now = new Date("2026-10-21T12:00:00.000Z");
  assert(await recordLookupCharge(admin, ROW, { charged: true, priceCents: 10, balanceAfterCents: 490, walletTxId: 9 }, now));
  assertEquals(writes[0], [
    ["table", "tax_lookups"],
    ["update", { charge_state: "charged", charge_cents: 10, wallet_tx_id: 9, charged_at: "2026-10-21T12:00:00.000Z" }],
    ["eq", "id", ROW],
    ["or", "charge_state.is.null,charge_state.in.(pending,error)"],
    ["select", "id"],
  ]);
});

Deno.test("recordLookupCharge and markChargePending never throw, and say false when nothing was written", async () => {
  for (const ans of [{ data: [] }, { error: { code: "42703", message: "column charge_state does not exist" } }, { throws: true }]) {
    const { admin } = ledgerAdmin(ans);
    assertEquals(await recordLookupCharge(admin, ROW, { charged: false, reason: "error" }), false, JSON.stringify(ans));
    assertEquals(await markChargePending(admin, ROW), false, JSON.stringify(ans));
  }
  // A bad id is refused before any write.
  for (const id of ["", "nope", `tax_ledger:tax_lookup:${ROW}`]) {
    const { admin, writes } = ledgerAdmin();
    assertEquals(await recordLookupCharge(admin, id, { charged: false, reason: "inactive" }), false);
    assertEquals(await markChargePending(admin, id), false);
    assertEquals(writes.length, 0, `${id}: nothing written`);
  }
});

Deno.test("markChargePending only moves a row with no state yet, and clears the charge columns", async () => {
  const { admin, writes } = ledgerAdmin();
  assert(await markChargePending(admin, ROW));
  assertEquals(writes[0], [
    ["table", "tax_lookups"],
    ["update", { charge_state: "pending", charge_cents: null, wallet_tx_id: null, charged_at: null }],
    ["eq", "id", ROW],
    ["is", "charge_state", null],
    ["select", "id"],
  ], "an error row being retried keeps its state until the retry has an answer");
});

// ── The wallet line's words ──────────────────────────────────────────────────────────

Deno.test("a tax debit's memo names the meter, the document and the state", () => {
  assertEquals(taxChargeMemo({ kind: "tax_lookup", quoteNumber: "SST-5021", state: "Minnesota" }), "Tax verification · SST-5021 · Minnesota");
  assertEquals(taxChargeMemo({ kind: "tax_invoice", invoiceNumber: 1042, state: "Missouri" }), "Invoice tax check · Invoice 1042 · Missouri");
  assertEquals(taxChargeMemo({ kind: "tax_invoice", invoiceNumber: "1042", state: "MO" }), "Invoice tax check · Invoice 1042 · MO", "a two-letter state as stored");
  assertEquals(taxChargeMemo({ kind: "tax_lookup", quoteNumber: null, state: null }), "Tax verification", "missing parts are left out, never blank");
  assertEquals(taxChargeMemo({ kind: "tax_lookup", quoteNumber: "  ", state: " Ohio " }), "Tax verification · Ohio");
  assertEquals(taxChargeMemo({ kind: "tax_invoice", invoiceNumber: null, quoteNumber: "SS-ABCD2345EF" }), "Invoice tax check · SS-ABCD2345EF", "no invoice number: the quote");
  // Control characters (a memo is printed in the ledger and its CSV) are folded out.
  const dirty = taxChargeMemo({ kind: "tax_lookup", quoteNumber: "SST-1" + String.fromCharCode(10) + "x", state: "Iowa" + String.fromCharCode(0, 7) });
  assertEquals(dirty, "Tax verification · SST-1 x · Iowa");
  assert([...dirty].every((c) => c.charCodeAt(0) >= 32), "no control character survives");
  assert(taxChargeMemo({ kind: "tax_lookup", quoteNumber: "Q".repeat(300), state: "S".repeat(300) }).length <= 200, "capped");
});

Deno.test("a memo starts with the same name the Billing tab gives the meter", () => {
  for (const kind of ["tax_lookup", "tax_invoice"] as const) {
    const fallback = walletLineLabel({ kind: "debit", meter_kind: kind, memo: null });
    assertEquals(taxChargeMemo({ kind }), fallback, `${kind}: the bare memo is the fallback label`);
    const memo = taxChargeMemo({ kind, quoteNumber: "SST-9", invoiceNumber: 9, state: "Ohio" });
    assert(memo.startsWith(fallback + " · "), `${kind}: ${memo}`);
    assertEquals(walletLineLabel({ kind: "debit", meter_kind: kind, memo }), memo, `${kind}: the Transactions line is the memo`);
  }
});
