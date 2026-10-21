// admin-catalog tax_charge_retry's rule (taxMeter.ts retryLookupCharges, migration 319): replay the
// charges that failed, or never finished, ON THE SAME LEDGER KEY, so a debit that did post is
// found, never posted twice — and refuse outright while a meter is disarmed.
//
// This replays real debits against builders' wallets, so most of the cases are about what it must
// NOT do: post a second debit for one call, touch a row that is not waiting on its charge, replay
// while a meter is off, or rewrite a row as "inactive" because the meter went off mid-run.
//
// The fake below is a small in-memory database: tax_lookups rows, usage_prices, wallet_accounts,
// client_settings and a wallet ledger whose wallet_credit behaves like 244's (a repeated key
// returns the existing balance and writes nothing). Dependency-free like the other _shared tests.

import { retryLookupCharges, STALE_PENDING_MS, taxLedgerIdem } from "./taxMeter.ts";

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
};

function fake(w: World) {
  const wallet: Row[] = (w.wallet ?? []).map((r) => ({ ...r }));
  let nextTx = 100 + wallet.length;
  const rpcs: Row[] = [];
  const updates: { id: unknown; patch: Row; filters: unknown[][] }[] = [];
  const reads: unknown[][][] = [];
  const prices = w.prices ?? [
    { kind: "tax_lookup", active: true, price_cents: 10 },
    { kind: "tax_invoice", active: true, price_cents: 10 },
  ];
  const match = (row: Row, ops: unknown[][]) => ops.every((o) => {
    const [op, col, v] = o as [string, string, unknown];
    if (op === "eq") return row[col] === v;
    if (op === "in") return (v as unknown[]).includes(row[col]);
    if (op === "lt") return String(row[col]) < String(v);
    if (op === "is") return row[col] === v;
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
      for (const m of ["select", "eq", "in", "lt", "is", "or", "order", "limit"]) q[m] = (...a: unknown[]) => (ops.push([m, ...a]), q);
      q.update = (p: Row) => { patch = p; return q; };
      q.maybeSingle = () => q.then((r: { data: unknown[] | null; error: unknown }) => ({ data: r.data?.[0] ?? null, error: r.error }));
      q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        const run = (): { data: unknown[] | null; error: unknown } => {
          if (table === "tax_lookups") {
            if (patch) {
              const hit = w.lookups.filter((r) => match(r, ops));
              for (const r of hit) Object.assign(r, patch);
              updates.push({ id: (ops.find((o) => o[0] === "eq" && o[1] === "id") ?? [])[2], patch, filters: ops });
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
          if (table === "wallet_transactions") return { data: wallet.filter((r) => match(r, ops)), error: null };
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
      const row = { id: ++nextTx, client_id: args.p_client_id, idempotency_key: args.p_idem, state: "posted", amount_cents: args.p_amount_cents, balance_after_cents: 1000, meter_kind: args.p_meter_kind };
      wallet.push(row);
      return Promise.resolve({ data: 1000, error: null });
    },
  };
  return { admin, wallet, rpcs, updates, reads };
}

const L = (n: number, extra: Row = {}): Row => ({
  id: id(n), client_id: "acme-sheds", kind: "verify", outcome: "ok", short_code: `SS-CODE${n}`, invoice_number: null, region: "OH",
  charge_state: "error", called_at: ago(60 * 60 * 1000 - n * 1000), charge_cents: null, wallet_tx_id: null, charged_at: null, ...extra,
});

Deno.test("an error row is replayed on its OWN ledger key and recorded charged with its wallet row", async () => {
  const f = fake({ lookups: [L(1), L(2, { kind: "invoice", invoice_number: "1042", short_code: "SS-INV" })] });
  const r = await retryLookupCharges(f.admin, { now: NOW, actorUserId: null });
  assert(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assertEquals([r.candidates, r.charged, r.exempt, r.stillFailed], [2, 2, 0, 0]);
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

Deno.test("a debit that DID post before the failure is found and linked, never posted again", async () => {
  // The first attempt's wallet_credit committed, then its answer was lost: the row says error.
  const posted = { id: 7, client_id: "acme-sheds", idempotency_key: taxLedgerIdem("tax_lookup", id(1)), state: "posted", amount_cents: -10, balance_after_cents: 490 };
  const f = fake({ lookups: [L(1)], wallet: [posted] });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(r.ok && r.charged === 1, JSON.stringify(r));
  assertEquals(f.wallet.length, 1, "no second wallet row");
  assertEquals(f.updates[0].patch.wallet_tx_id, 7, "linked to the row the first attempt posted");
  // And a second press of the retry finds nothing to do: the row is charged now.
  const again = await retryLookupCharges(f.admin, { now: NOW });
  assertEquals(again, { ok: true, candidates: 0, charged: 0, exempt: 0, stillFailed: 0, rows: [] });
  assertEquals(f.wallet.length, 1);
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
    if (!r.ok && r.refused === "meter_disarmed") assertEquals(r.candidates, 2);
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

Deno.test("only error rows and STALE pending rows are candidates; nothing else is touched", async () => {
  const f = fake({
    lookups: [
      L(1),                                                           // error: a candidate
      L(2, { charge_state: "pending", called_at: ago(STALE_PENDING_MS + 60_000) }), // stuck: a candidate
      L(3, { charge_state: "pending", called_at: ago(60_000) }),      // still finishing: not yet
      L(4, { charge_state: "charged", charge_cents: 10, charged_at: ago(1), wallet_tx_id: 1 }),
      L(5, { charge_state: "inactive" }),
      L(6, { charge_state: "no_rate", outcome: "timeout" }),
      L(7, { charge_state: "error", outcome: "timeout" }),            // a failed lookup is never charged
      L(8, { kind: "ping", client_id: "_platform", charge_state: null }),
      L(9, { charge_state: null }),
    ],
  });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assertEquals(r.rows.map((x) => [x.id, x.from, x.result]), [[id(1), "error", "charged"], [id(2), "pending", "charged"]]);
  assertEquals(f.rpcs.length, 2);
  // The candidate reads ask the database for exactly that: verify/invoice, outcome ok, and the state.
  const reads = f.reads.slice(0, 2).map((ops) => ops.filter((o) => ["in", "eq", "lt"].includes(String(o[0]))));
  assertEquals(reads[0], [["in", "kind", ["verify", "invoice"]], ["eq", "outcome", "ok"], ["eq", "charge_state", "error"]]);
  assertEquals(reads[1], [["in", "kind", ["verify", "invoice"]], ["eq", "outcome", "ok"], ["eq", "charge_state", "pending"], ["lt", "called_at", ago(STALE_PENDING_MS)]]);
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

Deno.test("a replay that fails again leaves an error row as it was, and turns a stuck pending into error", async () => {
  const f = fake({
    lookups: [L(1), L(2, { charge_state: "pending", called_at: ago(STALE_PENDING_MS * 2) })],
    creditFailsFor: ["acme-sheds"],
  });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assertEquals([r.charged, r.stillFailed], [0, 2]);
  assertEquals(r.rows.map((x) => [x.id, x.result]), [[id(1), "unchanged"], [id(2), "error"]]);
  assertEquals(f.updates.map((u) => [u.id, u.patch.charge_state]), [[id(2), "error"]], "only the stuck row is rewritten");
});

Deno.test("a tenant exempt by now is recorded exempt and not charged", async () => {
  const f = fake({ lookups: [L(1)], exempt: ["acme-sheds"] });
  const r = await retryLookupCharges(f.admin, { now: NOW });
  assert(r.ok && r.exempt === 1 && r.charged === 0, JSON.stringify(r));
  assertEquals(f.rpcs.length, 0);
  assertEquals(f.updates.map((u) => u.patch.charge_state), ["exempt"]);
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
  assertEquals(await retryLookupCharges(f.admin, { now: NOW }), { ok: true, candidates: 0, charged: 0, exempt: 0, stillFailed: 0, rows: [] });
  assertEquals([f.rpcs.length, f.updates.length], [0, 0]);
});
