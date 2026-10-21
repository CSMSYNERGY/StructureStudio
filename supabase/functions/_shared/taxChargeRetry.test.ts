// admin-catalog tax_charge_retry's rule (taxMeter.ts retryLookupCharges, migration 319): replay the
// charges that failed, or never finished, ON THE SAME LEDGER KEY AT THE SAME PRICE, link a debit
// that already posted instead of re-deciding it, skip a deleted builder's rows, and refuse outright
// while a meter a row still needs is disarmed.
//
// This replays real debits against builders' wallets, so most of the cases are about what it must
// NOT do: post a second debit for one call, bill a call made while a meter was off, bill at a price
// the builder never saw, record an exemption over a debit that posted, charge a deleted builder (or
// the new builder on a reused slug), touch a row that is not waiting on its charge, or rewrite a
// row as "inactive" because the meter went off mid-run.
//
// The fake below is a small in-memory database: tax_lookups rows, usage_prices, wallet_accounts,
// client_settings, client_configs, admin_audit and a wallet ledger whose wallet_credit behaves like
// 244's (a repeated key returns the existing balance and writes nothing, an unknown tenant gets a
// wallet created). Dependency-free like the other _shared tests.

import { chargeTaxCalculation, closeTenantTaxCharges, retryLookupCharges, STALE_PENDING_MS, taxLedgerIdem } from "./taxMeter.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

const NOW = new Date("2026-10-21T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

type Row = Record<string, unknown>;
type World = {
  lookups: Row[];
  prices?: Row[];
  exempt?: string[];                 // client ids with billing_exempt
  wallet?: Row[];                    // existing wallet_transactions
  creditFailsFor?: string[];         // client ids whose wallet_credit errors
  readFails?: boolean;
  tenants?: string[];                // client_configs rows (default: the two fixtures)
  deletes?: Row[];                   // admin_audit delete_client rows
  tenantReadFails?: boolean;
  walletReadFails?: boolean;
};

function fake(w: World) {
  const wallet: Row[] = (w.wallet ?? []).map((r) => ({ ...r }));
  let nextTx = 100 + wallet.length;
  const rpcs: Row[] = [];
  const updates: { id: unknown; patch: Row; filters: unknown[][] }[] = [];
  const reads: unknown[][][] = [];
  const createdWallets: string[] = [];
  const tenants = w.tenants ?? ["acme-sheds", "other-barns"];
  const prices = w.prices ?? [
    { kind: "tax_lookup", active: true, price_cents: 10 },
    { kind: "tax_invoice", active: true, price_cents: 10 },
  ];
  const match = (row: Row, ops: unknown[][]) => ops.every((o) => {
    const [op, col, v, v2] = o as [string, string, unknown, unknown];
    if (op === "eq") return row[col] === v;
    if (op === "in") return (v as unknown[]).includes(row[col]);
    if (op === "lt") return String(row[col]) < String(v);
    if (op === "is") return (row[col] ?? null) === v;
    if (op === "not") return v === "is" && v2 === null ? row[col] != null : true;
    if (op === "or") {
      // the one or() the writer uses: charge_state.is.null,charge_state.in.(pending,error)
      return row.charge_state == null || row.charge_state === "pending" || row.charge_state === "error";
    }
    return true;
  });
  const admin = {
    from(table: string) {
      const ops: unknown[][] = [];
      if (table === "tax_lookups") reads.push(ops);
      let patch: Row | null = null;
      // deno-lint-ignore no-explicit-any
      const q: any = {};
      for (const m of ["select", "eq", "in", "lt", "is", "not", "or", "order", "limit"]) q[m] = (...a: unknown[]) => (ops.push([m, ...a]), q);
      q.update = (p: Row) => { patch = p; return q; };
      q.maybeSingle = () => q.then((r: { data: unknown[] | null; error: unknown }) => ({ data: r.data?.[0] ?? null, error: r.error }));
      q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        const run = (): { data: unknown[] | null; error: unknown } => {
          if (table === "tax_lookups") {
            if (patch) {
              const hit = w.lookups.filter((r) => match(r, ops));
              for (const r of hit) Object.assign(r, patch);
              // Only writes that changed a row: markChargePending's `charge_state is null` filter
              // means a retried error or pending row is never moved by it, and that is not a write.
              if (hit.length) updates.push({ id: (ops.find((o) => o[0] === "eq" && o[1] === "id") ?? [])[2], patch, filters: ops });
              return { data: hit.map((r) => ({ id: r.id })), error: null };
            }
            if (w.readFails) return { data: null, error: { message: "down" } };
            const lim = Number((ops.find((o) => o[0] === "limit") ?? [])[1] ?? 1000);
            return { data: w.lookups.filter((r) => match(r, ops)).slice(0, lim).map((r) => ({ ...r })), error: null };
          }
          if (table === "usage_prices") {
            const kinds = (ops.find((o) => o[0] === "in") ?? [])[2] as string[] | undefined;
            const eqKind = (ops.find((o) => o[0] === "eq" && o[1] === "kind") ?? [])[2];
            return { data: prices.filter((p) => (kinds ? kinds.includes(String(p.kind)) : p.kind === eqKind)), error: null };
          }
          if (table === "wallet_accounts") return { data: [], error: null };
          if (table === "client_settings") {
            const c = (ops.find((o) => o[0] === "eq") ?? [])[2];
            return { data: (w.exempt ?? []).includes(String(c)) ? [{ billing_exempt: true }] : [], error: null };
          }
          if (table === "client_configs") {
            if (w.tenantReadFails) return { data: null, error: { message: "down" } };
            return { data: tenants.map((c) => ({ client_id: c })).filter((r) => match(r, ops)), error: null };
          }
          if (table === "admin_audit") {
            return { data: (w.deletes ?? []).filter((r) => match(r, ops)), error: null };
          }
          if (table === "wallet_transactions") {
            if (w.walletReadFails) return { data: null, error: { message: "down" } };
            return { data: wallet.filter((r) => match(r, ops)), error: null };
          }
          return { data: [], error: null };
        };
        return Promise.resolve(run()).then(ok, bad);
      };
      return q;
    },
    rpc(name: string, args: Row) {
      rpcs.push({ name, ...args });
      if ((w.creditFailsFor ?? []).includes(String(args.p_client_id))) return Promise.resolve({ data: null, error: { message: "down" } });
      const existing = wallet.find((r) => r.client_id === args.p_client_id && r.idempotency_key === args.p_idem);
      if (existing) return Promise.resolve({ data: existing.balance_after_cents, error: null });   // 244: a replay is a no-op
      if (!wallet.some((r) => r.client_id === args.p_client_id)) createdWallets.push(String(args.p_client_id)); // 244:157
      const row = { id: ++nextTx, client_id: args.p_client_id, idempotency_key: args.p_idem, state: "posted", amount_cents: args.p_amount_cents, balance_after_cents: 1000, meter_kind: args.p_meter_kind, posted_at: NOW.toISOString() };
      wallet.push(row);
      return Promise.resolve({ data: 1000, error: null });
    },
  };
  return { admin, wallet, rpcs, updates, reads, createdWallets };
}

/** A ledger row waiting on its charge: error, attempted at 10 cents (the fixture meters' price). */
const L = (n: number, extra: Row = {}): Row => ({
  id: id(n), client_id: "acme-sheds", kind: "verify", outcome: "ok", short_code: `SS-CODE${n}`, invoice_number: null, region: "OH",
  charge_state: "error", called_at: ago(60 * 60 * 1000 - n * 1000), charge_cents: 10, wallet_tx_id: null, charged_at: null, ...extra,
});
const EMPTY = { ok: true, candidates: 0, charged: 0, linked: 0, exempt: 0, stillFailed: 0, priceChanged: 0, orphaned: 0, rows: [] };

Deno.test("an error row is replayed on its OWN ledger key and recorded charged with its wallet row", async () => {
  const f = fake({ lookups: [L(1), L(2, { kind: "invoice", invoice_number: "1042", short_code: "SS-INV" })] });
  const r = await retryLookupCharges(f.admin, { now: NOW, actorUserId: null });
  assert(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assertEquals([r.candidates, r.charged, r.linked, r.exempt, r.stillFailed], [2, 2, 0, 0, 0]);
  assertEquals(f.rpcs.map((x) => [x.name, x.p_idem, x.p_meter_kind, x.p_amount_cents]), [
    ["wallet_credit", taxLedgerIdem("tax_lookup", id(1)), "tax_lookup", -10],
    ["wallet_credit", taxLedgerIdem("tax_invoice", id(2)), "tax_invoice", -10],
  ], "the SAME key the first attempt used: one row, one charge");
  assertEquals(f.rpcs.map((x) => [x.p_ref_type, x.p_ref_id, x.p_memo]), [
    ["design", "SS-CODE1", "Tax verification · SS-CODE1 · OH"],
    ["invoice", "1042", "Invoice tax check · Invoice 1042 · OH"],
  ]);
  const rows = f.updates.map((u) => [u.id, u.patch.charge_state, u.patch.charge_cents, u.patch.wallet_tx_id != null]);
  assertEquals(rows, [[id(1), "charged", 10, true], [id(2), "charged", 10, true]]);
});

Deno.test("a debit that DID post before the failure is LINKED from the wallet, never posted or re-decided", async () => {
  // The first attempt's wallet_credit committed, then its answer was lost: the row says error.
  const posted = { id: 7, client_id: "acme-sheds", idempotency_key: taxLedgerIdem("tax_lookup", id(1)), state: "posted", amount_cents: -10, balance_after_cents: 490, posted_at: "2026-10-21T10:00:00.000Z" };
  const f = fake({ lookups: [L(1)], wallet: [posted] });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(r.ok && r.linked === 1 && r.charged === 0, JSON.stringify(r));
  assertEquals(f.rpcs.length, 0, "the charge path is skipped: nothing posted, no meter or exemption consulted");
  assertEquals(f.wallet.length, 1, "no second wallet row");
  assertEquals(f.updates[0].patch, { charge_state: "charged", charge_cents: 10, wallet_tx_id: 7, charged_at: "2026-10-21T10:00:00.000Z" },
    "linked to the row the first attempt posted, at its amount and its post time (319 backfill 3a's rule)");
  // And a second press of the retry finds nothing to do: the row is charged now.
  assertEquals(await retryLookupCharges(f.admin, { now: NOW }), EMPTY);
  assertEquals(f.wallet.length, 1);
});

Deno.test("a posted debit is linked even when the builder is exempt by now: never recorded exempt over a real debit", async () => {
  for (const charge_state of ["error", "pending"]) {
    const posted = { id: 8, client_id: "acme-sheds", idempotency_key: taxLedgerIdem("tax_lookup", id(1)), state: "posted", amount_cents: -10, balance_after_cents: 490, posted_at: ago(3_600_000) };
    const f = fake({ lookups: [L(1, { charge_state, called_at: ago(STALE_PENDING_MS * 2) })], wallet: [posted], exempt: ["acme-sheds"] });
    const r = await retryLookupCharges(f.admin, { now: NOW });
    assert(r.ok && r.linked === 1 && r.exempt === 0, JSON.stringify(r));
    assertEquals([f.updates[0].patch.charge_state, f.updates[0].patch.wallet_tx_id], ["charged", 8], charge_state);
  }
});

Deno.test("a debit posted at an OLDER price is recorded at that price, not the meter's price today", async () => {
  // Attempted at 7 cents, posted, answer lost; the meter has since been repriced to 10.
  const posted = { id: 9, client_id: "acme-sheds", idempotency_key: taxLedgerIdem("tax_lookup", id(1)), state: "posted", amount_cents: -7, balance_after_cents: 493, posted_at: ago(7_200_000) };
  const f = fake({ lookups: [L(1, { charge_cents: 7 })], wallet: [posted] });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(r.ok && r.linked === 1, JSON.stringify(r));
  if (r.ok) assertEquals(r.rows[0].priceCents, 7);
  assertEquals([f.updates[0].patch.charge_cents, f.rpcs.length], [7, 0], "charge_cents = -amount_cents of the debit that exists");
});

Deno.test("links stand while the meters are disarmed; only rows that still need a charge are refused", async () => {
  const DISARMED = [{ kind: "tax_lookup", active: false, price_cents: 0 }, { kind: "tax_invoice", active: false, price_cents: 0 }];
  const posted = { id: 11, client_id: "acme-sheds", idempotency_key: taxLedgerIdem("tax_lookup", id(1)), state: "posted", amount_cents: -10, balance_after_cents: 490, posted_at: ago(1) };
  // Only linkable rows: the retry completes with the meters off.
  const f = fake({ lookups: [L(1)], wallet: [posted], prices: DISARMED });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(r.ok && r.linked === 1, JSON.stringify(r));
  // One linkable, one that needs a charge: the link is written, then the charge is refused.
  const g = fake({ lookups: [L(1), L(2)], wallet: [posted], prices: DISARMED });
  const s = await retryLookupCharges(g.admin, { now: NOW });
  assert(!s.ok && s.refused === "meter_disarmed" && s.linked === 1 && s.candidates === 2, JSON.stringify(s));
  assertEquals(g.updates.map((u) => [u.id, u.patch.charge_state]), [[id(1), "charged"]]);
  assertEquals(g.rpcs.length, 0);
});

Deno.test("REFUSED while a candidate's meter is disarmed or unpriced: nothing replayed, nothing written", async () => {
  for (const prices of [
    [{ kind: "tax_lookup", active: false, price_cents: 10 }, { kind: "tax_invoice", active: true, price_cents: 10 }],
    [{ kind: "tax_lookup", active: true, price_cents: 0 }, { kind: "tax_invoice", active: true, price_cents: 10 }],
    [{ kind: "tax_invoice", active: true, price_cents: 10 }],   // no row for tax_lookup at all
    [{ kind: "tax_lookup", active: false, price_cents: 0 }, { kind: "tax_invoice", active: false, price_cents: 0 }], // live today
  ]) {
    const f = fake({ lookups: [L(1), L(2, { kind: "invoice", invoice_number: "9" })], prices });
    const r = await retryLookupCharges(f.admin, { now: NOW });
    assert(!r.ok && r.refused === "meter_disarmed", JSON.stringify(r));
    if (!r.ok && r.refused === "meter_disarmed") assertEquals([r.candidates, r.linked, r.orphaned], [2, 0, 0]);
    assertEquals([f.rpcs.length, f.updates.length], [0, 0], JSON.stringify(prices));
  }
  // Only the meters the candidates need are asked about: an armed invoice meter and a disarmed
  // lookup meter still replays the invoice rows.
  const f = fake({
    lookups: [L(2, { kind: "invoice", invoice_number: "9" })],
    prices: [{ kind: "tax_lookup", active: false, price_cents: 0 }, { kind: "tax_invoice", active: true, price_cents: 10 }],
  });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(r.ok && r.charged === 1, JSON.stringify(r));
});

Deno.test("a call made while the meter was OFF is never billed once it is armed", async () => {
  // The reviewer's case: a Verify press while disarmed, then an operator arms the meters and
  // presses retry. chargeTaxCalculation never marks such a row pending (the rail returns first),
  // so the row is left with no state for chargeLookup to record (here: its record write failed).
  const lookups = [L(1, { charge_state: null, charge_cents: null, called_at: ago(STALE_PENDING_MS * 4) })];
  const off = fake({ lookups, prices: [{ kind: "tax_lookup", active: false, price_cents: 0 }] });
  const r0 = await chargeTaxCalculation(off.admin, { clientId: "acme-sheds", kind: "tax_lookup", lookupId: id(1), refType: "design", refId: "SS-CODE1" });
  assertEquals(r0, { charged: false, reason: "inactive" });
  assertEquals([off.updates.length, lookups[0].charge_state], [0, null], "no pending while disarmed");
  // Armed now, at a price: the retry has nothing to charge.
  const on = fake({ lookups });
  assertEquals(await retryLookupCharges(on.admin, { now: NOW }), EMPTY);
  assertEquals(on.rpcs.length, 0);
  // And an error that failed BEFORE the rail (the price read) carries no price, so it is no candidate.
  const early = fake({ lookups: [L(2, { charge_cents: null })] });
  assertEquals(await retryLookupCharges(early.admin, { now: NOW }), EMPTY);
  assert(early.reads[0].some((o) => o[0] === "not" && o[1] === "charge_cents" && o[2] === "is" && o[3] === null), "the read asks for priced rows only");
  assertEquals(early.rpcs.length, 0);
});

Deno.test("a meter repriced since the attempt is NOT replayed at the new price (price_changed, row untouched)", async () => {
  for (const price_cents of [12, 8]) {
    const f = fake({ lookups: [L(1), L(2, { charge_state: "pending", called_at: ago(STALE_PENDING_MS * 2) })], prices: [{ kind: "tax_lookup", active: true, price_cents }] });
    const r = await retryLookupCharges(f.admin, { now: NOW });
    assert(r.ok && r.priceChanged === 2 && r.charged === 0, JSON.stringify(r));
    if (r.ok) assertEquals(r.rows.map((x) => x.result), ["price_changed", "price_changed"]);
    assertEquals([f.rpcs.length, f.updates.length], [0, 0], `${price_cents}: nothing posted, nothing rewritten`);
  }
});

Deno.test("a deleted builder's rows are orphaned, never replayed — and a reused slug is never billed", async () => {
  // Deleted, slug not reused: no client_configs row.
  const gone = fake({ lookups: [L(1, { client_id: "gone-sheds" })], tenants: ["acme-sheds"] });
  const r = await retryLookupCharges(gone.admin, { now: NOW });
  assert(r.ok && r.orphaned === 1 && r.charged === 0, JSON.stringify(r));
  assertEquals([gone.rpcs.length, gone.createdWallets.length, gone.updates.length], [0, 0, 0], "no wallet created for a deleted slug");
  // Deleted and the slug given to a NEW builder: a delete_client audit row newer than the call.
  const reused = fake({
    lookups: [L(1), L(2, { called_at: ago(60_000) })],
    deletes: [{ action: "delete_client", target_client_id: "acme-sheds", created_at: ago(30 * 60 * 1000) }],
  });
  const s = await retryLookupCharges(reused.admin, { now: NOW });
  assert(s.ok, JSON.stringify(s));
  if (!s.ok) return;
  // L(1) was called ~1 h ago (before the delete): orphaned. L(2) was called after: the new builder's own.
  assertEquals(s.rows.map((x) => [x.id, x.result]), [[id(1), "orphaned"], [id(2), "charged"]]);
  assertEquals(reused.rpcs.map((x) => x.p_idem), [taxLedgerIdem("tax_lookup", id(2))]);
  // The tenant reads ask for exactly the candidates' builders.
  const f = fake({ lookups: [L(1)], tenantReadFails: true });
  const t = await retryLookupCharges(f.admin, { now: NOW });
  assert(!t.ok && t.refused === "unreadable", JSON.stringify(t));
  assertEquals(f.rpcs.length, 0, "an unreadable tenant list replays nothing");
});

Deno.test("an unreadable wallet refuses: a replay never runs blind to a debit that may have posted", async () => {
  const f = fake({ lookups: [L(1)], walletReadFails: true });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(!r.ok && r.refused === "unreadable", JSON.stringify(r));
  assertEquals([f.rpcs.length, f.updates.length], [0, 0]);
});

Deno.test("only error rows and STALE pending rows are candidates; nothing else is touched", async () => {
  const f = fake({
    lookups: [
      L(1),                                                           // error: a candidate
      L(2, { charge_state: "pending", called_at: ago(STALE_PENDING_MS + 60_000) }), // stuck: a candidate
      L(3, { charge_state: "pending", called_at: ago(60_000) }),      // still finishing: not yet
      L(4, { charge_state: "charged", charge_cents: 10, charged_at: ago(1), wallet_tx_id: 1 }),
      L(5, { charge_state: "inactive", charge_cents: null }),
      L(6, { charge_state: "no_rate", outcome: "timeout", charge_cents: null }),
      L(7, { charge_state: "error", outcome: "timeout" }),            // a failed lookup is never charged
      L(8, { kind: "ping", client_id: "_platform", charge_state: null, charge_cents: null }),
      L(9, { charge_state: null, charge_cents: null }),
      L(10, { charge_state: "error", charge_cents: null }),           // failed before the rail
    ],
  });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assertEquals(r.rows.map((x) => [x.id, x.from, x.result]), [[id(1), "error", "charged"], [id(2), "pending", "charged"]]);
  assertEquals(f.rpcs.length, 2);
  // The candidate reads ask the database for exactly that: verify/invoice, outcome ok, a price, and the state.
  const reads = f.reads.slice(0, 2).map((ops) => ops.filter((o) => ["in", "eq", "lt", "not"].includes(String(o[0]))));
  assertEquals(reads[0], [["in", "kind", ["verify", "invoice"]], ["eq", "outcome", "ok"], ["not", "charge_cents", "is", null], ["eq", "charge_state", "error"]]);
  assertEquals(reads[1], [["in", "kind", ["verify", "invoice"]], ["eq", "outcome", "ok"], ["not", "charge_cents", "is", null], ["eq", "charge_state", "pending"], ["lt", "called_at", ago(STALE_PENDING_MS)]]);
});

Deno.test("one builder only, when asked; and the limit is clamped", async () => {
  const f = fake({ lookups: [L(1), L(2, { client_id: "other-barns" }), L(3)] });
  const r = await retryLookupCharges(f.admin, { now: NOW, clientId: "acme-sheds", limit: 1 });
  assert(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assertEquals(r.rows.map((x) => x.id), [id(1)], "oldest first, one");
  assert(f.reads[0].some((o) => o[0] === "eq" && o[1] === "client_id" && o[2] === "acme-sheds"), "the tenant filter is in the read");
  assertEquals((f.reads[0].find((o) => o[0] === "limit") ?? [])[1], 1);
  const g = fake({ lookups: [] });
  await retryLookupCharges(g.admin, { now: NOW, limit: 100000 });
  assertEquals((g.reads[0].find((o) => o[0] === "limit") ?? [])[1], 200, "capped at RETRY_LIMIT_MAX");
});

Deno.test("a replay that fails again leaves an error row as it was, and turns a stuck pending into a PRICED error", async () => {
  const f = fake({
    lookups: [L(1), L(2, { charge_state: "pending", called_at: ago(STALE_PENDING_MS * 2) })],
    creditFailsFor: ["acme-sheds"],
  });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assertEquals([r.charged, r.stillFailed], [0, 2]);
  assertEquals(r.rows.map((x) => [x.id, x.result]), [[id(1), "unchanged"], [id(2), "error"]]);
  assertEquals(f.updates.map((u) => [u.id, u.patch.charge_state, u.patch.charge_cents]), [[id(2), "error", 10]],
    "only the stuck row is rewritten, and it keeps its price so it stays replayable");
});

Deno.test("a tenant exempt by now, with no debit posted, is recorded exempt and not charged", async () => {
  const f = fake({ lookups: [L(1)], exempt: ["acme-sheds"] });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(r.ok && r.exempt === 1 && r.charged === 0, JSON.stringify(r));
  assertEquals(f.rpcs.length, 0);
  assertEquals(f.updates.map((u) => [u.patch.charge_state, u.patch.charge_cents]), [["exempt", null]]);
});

Deno.test("an unreadable ledger or price list refuses, and nothing is replayed; it never throws", async () => {
  const f = fake({ lookups: [L(1)], readFails: true });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(!r.ok && r.refused === "unreadable", JSON.stringify(r));
  assertEquals(f.rpcs.length, 0);
  const throwing = { from: () => { throw new Error("socket"); }, rpc: () => Promise.reject(new Error("x")) };
  const t = await retryLookupCharges(throwing, { now: NOW });
  assert(!t.ok && t.refused === "unreadable", JSON.stringify(t));
});

Deno.test("no candidates: nothing read from the price list, nothing written", async () => {
  const f = fake({ lookups: [L(1, { charge_state: "charged", charge_cents: 10, charged_at: ago(1), wallet_tx_id: 3 })] });
  assertEquals(await retryLookupCharges(f.admin, { now: NOW }), EMPTY);
  assertEquals([f.rpcs.length, f.updates.length], [0, 0]);
});

// ── delete_client's step ─────────────────────────────────────────────────────────────────

Deno.test("closeTenantTaxCharges: a deleted builder's waiting charges become unpriced errors no retry replays", async () => {
  const lookups = [
    L(1),                                                                         // error at a price
    L(2, { charge_state: "pending", called_at: ago(STALE_PENDING_MS * 2) }),      // stuck
    L(3, { charge_state: "charged", charge_cents: 10, charged_at: ago(1), wallet_tx_id: 4 }),
    L(4, { client_id: "other-barns" }),                                           // another builder's
  ];
  const f = fake({ lookups });
  assertEquals(await closeTenantTaxCharges(f.admin, "acme-sheds"), 2);
  assertEquals(lookups.map((r) => [r.id, r.charge_state, r.charge_cents]), [
    [id(1), "error", null], [id(2), "error", null], [id(3), "charged", 10], [id(4), "error", 10],
  ], "only this builder's open charges; a charged row and another builder's are untouched");
  assert(f.updates[0].filters.some((o) => o[0] === "eq" && o[1] === "client_id" && o[2] === "acme-sheds"), "scoped to the builder");
  // Even with the slug reused, nothing of the old builder's is a candidate any more.
  const g = fake({ lookups });
  const r = await retryLookupCharges(g.admin, { now: NOW, clientId: "acme-sheds" });
  assertEquals(r, EMPTY);
  // Never throws; null when nothing could be written.
  assertEquals(await closeTenantTaxCharges({ from: () => { throw new Error("socket"); } }, "acme-sheds"), null);
  assertEquals(await closeTenantTaxCharges(f.admin, ""), null);
});
