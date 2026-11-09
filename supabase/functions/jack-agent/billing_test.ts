// What Jack costs a builder (billing.ts): the charge rule, the order a row is decided in, the sweep that
// finishes what didn't post, the wallet floor, the top-up request and the $50. Fakes only: no database,
// no network. The fake wallet keeps a ledger keyed like wallet_transactions (client + key), so "nothing is
// charged twice" is checked against what would really have posted.

import { assert, assertEquals } from "./test_assert.ts";
import {
  afterCharge, availableCents, chargeFor, chargeKey, ensureWelcomeCredit, FLOOR_CENTS, forgetGrantsSeen, gate, JACK_METER, LOW_CENTS,
  MAX_CHARGE_MICROS, settle, sweep, SWEEP_AGE_MS, SWEEP_LIMIT, turnOutcome, WALLET_SAID, WELCOME_CENTS, WELCOME_KEY, WELCOME_MEMO,
} from "./billing.ts";
import type { Deps, Store, Wallet, Who } from "./types.ts";
import { leaksContactDetails } from "./redact.ts";
import { TOOL_DEFS } from "./agent.ts";
import { PIECE_TOOLS } from "./pieces.ts";
import { JACK_METER as LEDGER_JACK_METER, JACK_WELCOME_MEMO } from "../_shared/walletLedger.ts";

const NOW = Date.parse("2026-11-06T15:00:00.000Z");
const who: Who = { clientId: "builder-a", userId: "u1", operatorEmail: null };
const operator: Who = { clientId: "builder-a", userId: "u1", operatorEmail: "ops@example.test" };

type Table = "jack_messages" | "jack_proposals";
type Row = { table: Table; id: string; charge_state: string | null; charge_micros: number | null; cost_micros: number; model: string | null; created_at: number; wallet_tx_id?: number | null };
type Fails = boolean | "throw";

function fakeWallet(init: {
  active?: boolean; markup?: number | null; exempt?: boolean; balance?: number; held?: number; rem?: number; autoTopup?: boolean; threshold?: number | null;
  meterFails?: Fails; exemptFails?: Fails; accountFails?: Fails; debitFails?: Fails | "lost"; grantFails?: Fails; markFails?: boolean; pendingFails?: boolean;
} = {}) {
  const s = {
    active: true, markup: 1.5 as number | null, exempt: false, balance: 5000, held: 0, rem: 0, autoTopup: false, threshold: null as number | null,
    meterFails: false as Fails, exemptFails: false as Fails, accountFails: false as Fails, debitFails: false as Fails | "lost", grantFails: false as Fails,
    markFails: false, pendingFails: false,
    ...init,
    rows: new Map<string, Row>(),
    /** wallet_transactions, keyed client + idempotency key, as 248's unique index is. */
    ledger: new Map<string, { txId: number; charge: number }>(),
    debits: [] as Parameters<Wallet["debit"]>[0][],
    grants: [] as { clientId: string; cents: number; key: string; memo: string }[],
    topups: [] as string[],
    marks: [] as { table: Table; id: string; patch: Record<string, unknown> }[],
    pendingAsks: [] as { olderThan: string; limit: number }[],
    reads: { meter: 0, exempt: 0, account: 0 },
    nextTx: 100,
  };
  const failing = <T>(f: Fails, value: () => T): Promise<T | null> => (f === "throw" ? Promise.reject(new Error("read failed")) : Promise.resolve(f ? null : value()));
  const wallet: Wallet = {
    meter: () => { s.reads.meter++; return failing(s.meterFails, () => ({ active: s.active, markup: s.markup })); },
    exempt: () => { s.reads.exempt++; return failing(s.exemptFails, () => s.exempt); },
    account: () => {
      s.reads.account++;
      return failing(s.accountFails, () => ({ balanceCents: s.balance, heldCents: s.held, remainderMicros: s.rem, autoTopup: s.autoTopup, thresholdCents: s.threshold }));
    },
    debit: (a) => {
      s.debits.push(a);
      if (s.debitFails === "throw") return Promise.reject(new Error("rpc down"));
      if (s.debitFails === true) return Promise.resolve({ ok: false, txId: null });
      const k = `${a.clientId}|${a.key}`;
      let line = s.ledger.get(k);
      if (!line) {
        line = { txId: ++s.nextTx, charge: a.chargeMicros };
        s.ledger.set(k, line);
        s.balance -= Math.floor(a.chargeMicros / 10_000);
      }
      // "lost": it posted, and the answer never came back.
      if (s.debitFails === "lost") return Promise.resolve({ ok: false, txId: null });
      return Promise.resolve({ ok: true, txId: line.txId });
    },
    grantOnce: (clientId, cents, key, memo) => {
      s.grants.push({ clientId, cents, key, memo });
      if (s.grantFails === "throw") return Promise.reject(new Error("rpc down"));
      if (s.grantFails) return Promise.resolve(false);
      const k = `${clientId}|${key}`;
      if (!s.ledger.has(k)) { s.ledger.set(k, { txId: ++s.nextTx, charge: -cents * 10_000 }); s.balance += cents; }
      return Promise.resolve(true);
    },
    requestTopup: (clientId) => { s.topups.push(clientId); },
    mark: (table, id, patch) => {
      s.marks.push({ table, id, patch: { ...patch } });
      if (s.markFails) return Promise.reject(new Error("write failed"));
      const r = s.rows.get(`${table}:${id}`);
      if (r) Object.assign(r, patch);
      return Promise.resolve();
    },
    pending: (_clientId, olderThan, limit) => {
      s.pendingAsks.push({ olderThan, limit });
      if (s.pendingFails) return Promise.reject(new Error("read failed"));
      const rows = [...s.rows.values()].filter((r) => r.charge_state === "pending" && r.created_at < Date.parse(olderThan)).sort((a, b) => a.created_at - b.created_at);
      return Promise.resolve(rows.slice(0, limit).map((r) => ({ table: r.table, id: r.id, charge_micros: Number(r.charge_micros ?? 0), cost_micros: r.cost_micros, model: r.model })));
    },
  };
  /** A row as addMessage / addProposalCost leave it: cost on it, no charge state yet. */
  const seed = (table: Table, id: string, cost: number, agoMs = 0, model: string | null = "claude-sonnet-5-5") => {
    s.rows.set(`${table}:${id}`, { table, id, charge_state: null, charge_micros: null, cost_micros: cost, model, created_at: NOW - agoMs });
  };
  const row = (table: Table, id: string) => s.rows.get(`${table}:${id}`)!;
  return { wallet, s, seed, row };
}

const nobody = (what: string) => () => { throw new Error(`billing.ts must not touch ${what}`); };

function makeDeps(wallet: Wallet, over: Partial<Deps> = {}) {
  const logs: { code: string; message: string; severity?: string; clientId?: string | null; context?: Record<string, unknown> }[] = [];
  const clock = { now: NOW };
  const deps: Deps = {
    env: () => undefined,
    store: new Proxy({}, { get: nobody("the store") }) as Store,
    portal: nobody("portal-settings"),
    call: nobody("a portal function"),
    wallet,
    fetch: nobody("the network"),
    canRead: () => true,
    canEdit: () => true,
    background: () => {},
    budgetMs: () => 300_000,
    makeId: () => crypto.randomUUID(),
    hash: (t) => Promise.resolve(t),
    log: (e) => { logs.push(e); return Promise.resolve(); },
    audit: () => Promise.resolve(),
    now: () => clock.now,
    markSentWithJack: () => Promise.resolve(true),
    ...over,
  };
  return { deps, logs, clock };
}

const answer = (id: string, cost: number, extra: Partial<Parameters<typeof settle>[2]> = {}) =>
  ({ table: "jack_messages" as const, id, costMicros: cost, model: "claude-sonnet-5-5", outcome: "answered" as const, ...extra });
const read = (id: string, cost: number, outcome: "answered" | "failed" = "answered") =>
  ({ table: "jack_proposals" as const, id, costMicros: cost, model: "claude-opus-5-5", outcome });
/** Past the reads' few seconds of memory, and past the sweep's minute. */
const later = (clock: { now: number }) => { clock.now += SWEEP_AGE_MS + 31_000; };

// ── The rule ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("chargeFor is the phone meters' half-up integer rule, on their own test vectors", () => {
  // workers/phone-api/test/usageCharge.test.ts, no ceiling.
  assertEquals(chargeFor(4150, 1.5), 6225);
  assertEquals(chargeFor(3333, 2.5), 8333); // 8332.5 up
  assertEquals(chargeFor(1, 1.5), 2); // 1.5 up
  assertEquals(chargeFor(46000, 2), 92000);
  assertEquals(chargeFor(1000, 1.333), 1333);
  assertEquals(chargeFor(0, 3), 0);
  assertEquals(chargeFor(54000, 1.25), 67500);
  assertEquals(chargeFor(12800, 1.25), 16000);
  assertEquals(chargeFor(11800, 1.25), 14750);
  assertEquals(chargeFor(2, 1.25), 3); // 2.5 up
  assertEquals(chargeFor(1, 1.25), 1); // 1.25 down
  // At x1.5, every cost: half up of 3c/2, worked without floats.
  for (let c = 0; c <= 20_000; c++) assertEquals(chargeFor(c, 1.5), Math.floor((3 * c + 1) / 2), `cost ${c}`);
  // A dollar of AI cost is a dollar fifty.
  assertEquals(chargeFor(1_000_000, 1.5), 1_500_000);
  assertEquals(chargeFor(-40, 1.5), 0);
  assertEquals(chargeFor(Number.NaN, 1.5), 0);
  assertEquals(chargeFor(100, Number.NaN), 0);
});

Deno.test("a turn that gave no answer is not billed; one that answered is", () => {
  for (const s of ["timeout", "error", "spend_limit", "rounds", "max_tokens", "refusal", "no_text", "", null, undefined]) assertEquals(turnOutcome(s), "failed", String(s));
  for (const s of ["end_turn", "stop_sequence", "pause_turn"]) assertEquals(turnOutcome(s), "answered", s);
});

Deno.test("available is balance less held less the owed fraction of a cent, rounded up", () => {
  assertEquals(availableCents({ balanceCents: 100, heldCents: 0, remainderMicros: 0 }), 100);
  assertEquals(availableCents({ balanceCents: 100, heldCents: 0, remainderMicros: 1 }), 99);
  assertEquals(availableCents({ balanceCents: 100, heldCents: 0, remainderMicros: 9_999 }), 99);
  assertEquals(availableCents({ balanceCents: 2500, heldCents: 2000, remainderMicros: 0 }), 500);
  assertEquals(availableCents({ balanceCents: -40, heldCents: 0, remainderMicros: 0 }), -40);
});

Deno.test("the numbers Ahsan set, and the words the ledger shows, are the same in both places", () => {
  assertEquals(FLOOR_CENTS, { chat: 100, sheet: 300 });
  assertEquals(LOW_CENTS, 1000);
  assertEquals([WELCOME_CENTS, WELCOME_KEY, WELCOME_MEMO], [5000, "jack_welcome", "Jack welcome credit"]);
  assertEquals(WELCOME_MEMO, JACK_WELCOME_MEMO, "walletLedger.ts names the welcome grant by this memo");
  assertEquals(JACK_METER, LEDGER_JACK_METER, "the meter the ledger gives a Jack chip");
  assertEquals(MAX_CHARGE_MICROS, 500_000_000);
  assertEquals([chargeKey("jack_messages", "m1"), chargeKey("jack_proposals", "p1")], ["jack:answer:m1", "jack:read:p1"]);
  assertEquals([SWEEP_AGE_MS, SWEEP_LIMIT], [60_000, 10]);
});

// ── settle ────────────────────────────────────────────────────────────────────────────────────────

Deno.test("meter off: a shadow with what it would have charged, and nothing moves", async () => {
  const { wallet, s, seed, row } = fakeWallet({ active: false });
  const { deps } = makeDeps(wallet);
  seed("jack_messages", "m1", 4150);
  assertEquals(await settle(deps, who, answer("m1", 4150)), { state: "shadow", chargeMicros: 6225, billed: false });
  assertEquals([row("jack_messages", "m1").charge_state, row("jack_messages", "m1").charge_micros], ["shadow", 6225]);
  assertEquals([s.debits.length, s.topups.length, s.grants.length, s.ledger.size], [0, 0, 0, 0]);

  // No markup yet, or one the meter's check wouldn't allow: still a shadow, with no would-be figure when
  // there's nothing to work it out from.
  for (const [active, markup, want] of [[false, null, null], [true, null, null], [true, 0.5, null], [true, 11, null]] as const) {
    const w = fakeWallet({ active, markup });
    const r = await settle(makeDeps(w.wallet).deps, who, answer("m2", 4150));
    assertEquals(r, { state: "shadow", chargeMicros: want, billed: false }, `${active} ${markup}`);
    assertEquals(w.s.debits.length, 0);
  }
});

Deno.test("an exempt builder: recorded as exempt, no wallet line, no top-up, no welcome credit", async () => {
  // Wallet.exempt is metered_exempt, then billing_exempt (index.ts); either one reads as true here.
  const { wallet, s, seed, row } = fakeWallet({ exempt: true, balance: 0, autoTopup: true, threshold: 2000 });
  const { deps } = makeDeps(wallet);
  seed("jack_messages", "m1", 4150);
  forgetGrantsSeen();
  assertEquals(await ensureWelcomeCredit(deps, who), "skipped");
  assertEquals(await gate(deps, who, "chat", true), { ok: true });
  assertEquals(await settle(deps, who, answer("m1", 4150)), { state: "exempt", chargeMicros: 6225, billed: false });
  assertEquals(await afterCharge(deps, who), false);
  assertEquals(row("jack_messages", "m1").charge_state, "exempt");
  assertEquals([s.debits.length, s.grants.length, s.topups.length, s.reads.account], [0, 0, 0, 0]);
});

Deno.test("armed: one debit at cost x 1.5, keyed to the answer, and the row ends charged", async () => {
  const { wallet, s, seed, row } = fakeWallet();
  const { deps } = makeDeps(wallet);
  seed("jack_messages", "m1", 4150);
  const r = await settle(deps, who, answer("m1", 4150, { tokens: { input: 1200, output: 300, cacheRead: 9000, cacheWrite: 0 } }));
  assertEquals(r, { state: "charged", chargeMicros: 6225, billed: true });
  assertEquals(s.debits, [{
    clientId: "builder-a", chargeMicros: 6225, costMicros: 4150, refType: "jack_message", refId: "m1", memo: "Jack · answer",
    usage: { model: "claude-sonnet-5-5", input: 1200, output: 300, cache_read: 9000, cache_write: 0 }, key: "jack:answer:m1",
  }]);
  // Pending with its price first, so a worker that dies mid-debit leaves it for the sweep.
  assertEquals(s.marks.map((m) => m.patch), [{ charge_state: "pending", charge_micros: 6225 }, { charge_state: "charged", charge_micros: 6225, wallet_tx_id: 101 }]);
  assertEquals([row("jack_messages", "m1").charge_state, row("jack_messages", "m1").wallet_tx_id], ["charged", 101]);

  // A price list read: its own key and words.
  seed("jack_proposals", "p1", 1_000_000);
  assertEquals(await settle(deps, who, read("p1", 1_000_000)), { state: "charged", chargeMicros: 1_500_000, billed: true });
  const d = s.debits[1];
  assertEquals([d.refType, d.refId, d.key, d.memo, d.chargeMicros, d.costMicros], ["jack_proposal", "p1", "jack:read:p1", "Jack · price list read", 1_500_000, 1_000_000]);
  assertEquals(d.usage, { model: "claude-opus-5-5" });
});

Deno.test("the debit fails: the turn still has its answer, the row stays pending, and the log has ids only", async () => {
  for (const fails of [true, "throw"] as const) {
    const { wallet, s, seed, row } = fakeWallet({ debitFails: fails });
    const { deps, logs } = makeDeps(wallet);
    seed("jack_messages", "m1", 4150);
    assertEquals(await settle(deps, who, answer("m1", 4150)), { state: "pending", chargeMicros: 6225, billed: false });
    assertEquals([row("jack_messages", "m1").charge_state, row("jack_messages", "m1").charge_micros], ["pending", 6225]);
    assertEquals(s.debits.length, 1);
    const failed = logs.filter((l) => l.code === "jack_charge_failed");
    assertEquals(failed.length, 1);
    assertEquals(failed[0].context, { table: "jack_messages", row: "m1" });
    assert(!/\d/.test(failed[0].message), "a figure in the log line");
  }
});

Deno.test("no answer, a failed read, nothing spent, or a team member in view-as: not billable, no read of the wallet", async () => {
  const cases: [Who, Parameters<typeof settle>[2]][] = [
    ...["timeout", "error", "spend_limit", "rounds", "max_tokens", "refusal"].map((stop): [Who, Parameters<typeof settle>[2]] => [who, answer("m1", 4150, { outcome: turnOutcome(stop) })]),
    [who, read("p1", 900_000, "failed")],
    [who, answer("m1", 0)],
    [operator, answer("m1", 4150)],
    [operator, read("p1", 900_000)],
  ];
  for (const [w, ref] of cases) {
    const { wallet, s } = fakeWallet();
    const r = await settle(makeDeps(wallet).deps, w, ref);
    assertEquals(r, { state: "not_billable", chargeMicros: null, billed: false }, JSON.stringify(ref));
    assertEquals(s.marks.map((m) => [m.table, m.id, m.patch]), [[ref.table, ref.id, { charge_state: "not_billable", charge_micros: null }]]);
    assertEquals([s.debits.length, s.reads.meter, s.reads.exempt], [0, 0, 0]);
  }
});

Deno.test("a wallet read that fails: pending with no price, nothing sent, and the sweep decides it later", async () => {
  for (const which of ["exemptFails", "meterFails"] as const) {
    const { wallet, s, seed, row } = fakeWallet({ [which]: true });
    const { deps, logs, clock } = makeDeps(wallet);
    seed("jack_messages", "m1", 4150);
    assertEquals(await settle(deps, who, answer("m1", 4150)), { state: "pending", chargeMicros: null, billed: false }, which);
    assertEquals([row("jack_messages", "m1").charge_state, row("jack_messages", "m1").charge_micros, s.debits.length], ["pending", null, 0]);
    assertEquals(logs.map((l) => l.code), ["jack_charge_deferred"]);
    // The reads work again a minute on: priced now, at today's markup, and charged once.
    s[which] = false;
    later(clock);
    assertEquals(await sweep(deps, who), { looked: 1, charged: 1 });
    assertEquals(s.debits.map((d) => [d.key, d.chargeMicros, d.costMicros]), [["jack:answer:m1", 6225, 4150]]);
    assertEquals(row("jack_messages", "m1").charge_state, "charged");
  }
  // Exempt is decided even when the meter can't be read: nothing is owed either way.
  const { wallet } = fakeWallet({ exempt: true, meterFails: true });
  assertEquals(await settle(makeDeps(wallet).deps, who, answer("m1", 4150)), { state: "exempt", chargeMicros: null, billed: false });

  // And a shadow is decided when the exempt flags can't be read but the meter is off. Left pending, the
  // turn would be charged by the first sweep after Ahsan arms the meter, though it was taken before.
  const off = fakeWallet({ active: false, exemptFails: true });
  const o = makeDeps(off.wallet);
  off.seed("jack_messages", "m1", 4150);
  assertEquals(await settle(o.deps, who, answer("m1", 4150)), { state: "shadow", chargeMicros: 6225, billed: false });
  assertEquals([off.row("jack_messages", "m1").charge_state, off.s.debits.length], ["shadow", 0]);
  assertEquals(o.logs.map((l) => l.code), []);
  off.s.active = true;
  off.s.exemptFails = false;
  later(o.clock);
  assertEquals(await sweep(o.deps, who), { looked: 0, charged: 0 }, "nothing left for a sweep to charge once armed");
  assertEquals(off.s.debits.length, 0);
});

Deno.test("a charge over the $500 guard is never sent: wallet_usage_debit would refuse it forever", async () => {
  const { wallet, s, seed, row } = fakeWallet();
  const { deps, logs } = makeDeps(wallet);
  seed("jack_messages", "m1", 400_000_000);
  assertEquals(await settle(deps, who, answer("m1", 400_000_000)), { state: "failed", chargeMicros: 600_000_000, billed: false });
  assertEquals([s.debits.length, row("jack_messages", "m1").charge_state], [0, "failed"]);
  assertEquals(logs.filter((l) => l.code === "jack_charge_too_big").map((l) => l.severity), ["error"]);
  // Just under it goes through.
  seed("jack_messages", "m2", 333_333_333);
  assertEquals((await settle(deps, who, answer("m2", 333_333_333))).state, "charged");
});

Deno.test("a charge state that won't save doesn't stop the debit, and is logged", async () => {
  const { wallet, s } = fakeWallet({ markFails: true });
  const { deps, logs } = makeDeps(wallet);
  assertEquals(await settle(deps, who, answer("m1", 4150)), { state: "charged", chargeMicros: 6225, billed: true });
  assertEquals(s.debits.length, 1);
  assertEquals(logs.filter((l) => l.code === "jack_charge_mark").length, 2);
});

Deno.test("nothing here throws, whatever the wallet does", async () => {
  const boom = () => { throw new Error("boom"); };
  const wallet: Wallet = { meter: boom, exempt: boom, account: boom, debit: boom, grantOnce: boom, requestTopup: boom, mark: boom, pending: boom };
  const { deps } = makeDeps(wallet, { log: boom });
  forgetGrantsSeen();
  assertEquals((await settle(deps, who, answer("m1", 4150))).billed, false);
  assertEquals(await sweep(deps, who), { looked: 0, charged: 0 });
  // A meter that can't be read may be armed, so the gate stops the turn in a sentence (never a throw).
  assertEquals(await gate(deps, who, "chat", true), { ok: false, cap: "wallet", sentence: WALLET_SAID.unread });
  assertEquals(await afterCharge(deps, who), false);
  assertEquals(await ensureWelcomeCredit(deps, who), "skipped");
  // Armed, and every write blowing up.
  const w = fakeWallet({ debitFails: "throw", markFails: true, grantFails: "throw" });
  const d2 = makeDeps(w.wallet, { log: boom }).deps;
  assertEquals((await settle(d2, who, answer("m1", 4150))).state, "pending");
  assertEquals(await ensureWelcomeCredit(d2, who), "failed");
});

// ── sweep ─────────────────────────────────────────────────────────────────────────────────────────

Deno.test("sweep: a pending charge goes again under the same key and amount, even after the markup moved", async () => {
  const { wallet, s, seed, row } = fakeWallet({ debitFails: true });
  const { deps, clock } = makeDeps(wallet);
  seed("jack_messages", "m1", 4150);
  await settle(deps, who, answer("m1", 4150));
  // Too young to sweep: it may still be settling in the worker that wrote it.
  s.debitFails = false;
  clock.now += 30_000;
  assertEquals(await sweep(deps, who), { looked: 0, charged: 0 });
  assertEquals(s.pendingAsks.at(-1), { olderThan: new Date(clock.now - 60_000).toISOString(), limit: 10 });
  // A minute on, and the markup has moved since: the stored amount is what goes.
  s.markup = 2;
  later(clock);
  assertEquals(await sweep(deps, who), { looked: 1, charged: 1 });
  assertEquals(s.debits.map((d) => [d.key, d.chargeMicros, d.costMicros, d.refId]), [["jack:answer:m1", 6225, 4150, "m1"], ["jack:answer:m1", 6225, 4150, "m1"]]);
  assertEquals([row("jack_messages", "m1").charge_state, row("jack_messages", "m1").wallet_tx_id], ["charged", 101]);
  // Done: the next sweep finds nothing, and one line is on the ledger.
  assertEquals(await sweep(deps, who), { looked: 0, charged: 0 });
  assertEquals([s.debits.length, s.ledger.size], [2, 1]);
});

Deno.test("sweep: a debit that posted but whose answer was lost comes back as the first line, never a second", async () => {
  const { wallet, s, seed, row } = fakeWallet({ debitFails: "lost", balance: 5000 });
  const { deps, clock } = makeDeps(wallet);
  seed("jack_proposals", "p1", 2_000_000);
  assertEquals((await settle(deps, who, read("p1", 2_000_000))).state, "pending");
  assertEquals(s.ledger.size, 1, "it did post");
  s.debitFails = false;
  later(clock);
  assertEquals(await sweep(deps, who), { looked: 1, charged: 1 });
  assertEquals([row("jack_proposals", "p1").charge_state, row("jack_proposals", "p1").wallet_tx_id], ["charged", 101]);
  assertEquals([s.ledger.size, s.balance], [1, 5000 - 300], "charged $3.00 once");
});

Deno.test("sweep: a sent charge waits while the meter is off or the builder is exempt; an unpriced one is decided", async () => {
  for (const change of ["off", "exempt"] as const) {
    const { wallet, s, seed, row } = fakeWallet({ debitFails: true });
    const { deps, clock } = makeDeps(wallet);
    seed("jack_messages", "sent", 4150, 0);
    await settle(deps, who, answer("sent", 4150));
    // An unpriced one, from a time a read failed.
    seed("jack_messages", "unpriced", 1000, 0);
    row("jack_messages", "unpriced").charge_state = "pending";
    s.debitFails = false;
    if (change === "off") s.active = false;
    else s.exempt = true;
    later(clock);
    const before = s.debits.length;
    assertEquals(await sweep(deps, who), { looked: 2, charged: 0 }, change);
    assertEquals(s.debits.length, before, "nothing sent");
    assertEquals([row("jack_messages", "sent").charge_state, row("jack_messages", "sent").charge_micros], ["pending", 6225], "the sent one waits");
    assertEquals([row("jack_messages", "unpriced").charge_state, row("jack_messages", "unpriced").charge_micros], [change === "off" ? "shadow" : "exempt", 1500]);
  }
});

Deno.test("sweep: at most ten, oldest first, and it stops at the first debit that doesn't answer", async () => {
  const { wallet, s, seed, row } = fakeWallet({ debitFails: true });
  const { deps, clock } = makeDeps(wallet);
  for (let i = 0; i < 12; i++) {
    seed("jack_messages", `m${i}`, 1000, 1000 * (12 - i));
    await settle(deps, who, answer(`m${i}`, 1000));
  }
  assertEquals(s.debits.length, 12);
  later(clock);
  // Still down: one try, then it leaves the rest for the next send.
  assertEquals(await sweep(deps, who), { looked: 1, charged: 0 });
  assertEquals(s.debits.length, 13);
  s.debitFails = false;
  assertEquals(await sweep(deps, who), { looked: 10, charged: 10 });
  assertEquals(s.debits.slice(13).map((d) => d.refId), ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
  assertEquals([row("jack_messages", "m10").charge_state, row("jack_messages", "m11").charge_state], ["pending", "pending"]);
  assertEquals(await sweep(deps, who), { looked: 2, charged: 2 });
  assertEquals(s.ledger.size, 12);
});

Deno.test("sweep: nothing to do when the wallet can't be read, and a worker near its end leaves it", async () => {
  for (const f of [{ exemptFails: true }, { meterFails: true }, { pendingFails: true }] as const) {
    const { wallet, s } = fakeWallet(f);
    assertEquals(await sweep(makeDeps(wallet).deps, who), { looked: 0, charged: 0 }, JSON.stringify(f));
    assertEquals(s.debits.length, 0);
  }
  const { wallet, s, seed, row } = fakeWallet();
  seed("jack_messages", "m1", 1000, 120_000);
  row("jack_messages", "m1").charge_state = "pending";
  row("jack_messages", "m1").charge_micros = 1500;
  assertEquals(await sweep(makeDeps(wallet, { budgetMs: () => 5_000 }).deps, who), { looked: 0, charged: 0 });
  assertEquals(s.debits.length, 0);
});

// ── gate ──────────────────────────────────────────────────────────────────────────────────────────

Deno.test("gate: a meter that isn't armed, an exempt builder or a team member in view-as is never refused", async () => {
  for (const [w, init] of [[who, { active: false, balance: 0 }], [who, { markup: null, balance: 0 }], [who, { exempt: true, balance: 0 }], [operator, { balance: -500 }]] as const) {
    const { wallet, s } = fakeWallet(init);
    assertEquals(await gate(makeDeps(wallet).deps, w, "sheet", true), { ok: true }, JSON.stringify(init));
    assertEquals([s.reads.account, s.topups.length], [0, 0]);
  }
});

Deno.test("gate: under the floor with automatic top-up off, it says why and asks nobody", async () => {
  const { wallet, s } = fakeWallet({ balance: 99 });
  const { deps } = makeDeps(wallet);
  assertEquals(await gate(deps, who, "chat", true), { ok: false, cap: "wallet", sentence: WALLET_SAID.empty });
  assertEquals(await gate(deps, who, "chat", false), { ok: false, cap: "wallet", sentence: WALLET_SAID.askOwner });
  assertEquals(await gate(deps, who, "sheet", true), { ok: false, cap: "wallet", sentence: WALLET_SAID.emptySheet });
  assertEquals(await gate(deps, who, "sheet", false), { ok: false, cap: "wallet", sentence: WALLET_SAID.askOwnerSheet });
  assertEquals(s.topups.length, 0);
});

Deno.test("gate: $1 to start a chat turn, $3 to read a price list, counting held money and the owed fraction", async () => {
  const at = async (init: Parameters<typeof fakeWallet>[0], purpose: "chat" | "sheet") => (await gate(makeDeps(fakeWallet(init).wallet).deps, who, purpose, true)).ok;
  assertEquals(await at({ balance: 100 }, "chat"), true);
  assertEquals(await at({ balance: 100, rem: 1 }, "chat"), false);
  assertEquals(await at({ balance: 250 }, "chat"), true);
  assertEquals(await at({ balance: 250 }, "sheet"), false);
  assertEquals(await at({ balance: 300 }, "sheet"), true);
  assertEquals(await at({ balance: 2300, held: 2000 }, "sheet"), true);
  assertEquals(await at({ balance: 2299, held: 2000 }, "sheet"), false);
  assertEquals(await at({ balance: -40 }, "chat"), false);
});

Deno.test("gate: under the floor with automatic top-up on, it asks the door each time and says so", async () => {
  const { wallet, s } = fakeWallet({ balance: 0, autoTopup: true, threshold: 2000 });
  const { deps } = makeDeps(wallet);
  assertEquals(await gate(deps, who, "chat", true), { ok: false, cap: "wallet", sentence: WALLET_SAID.toppingUp });
  // Asked again on the next refusal: the door's own cooldown and daily cap decide whether it charges.
  assertEquals(await gate(deps, who, "sheet", false), { ok: false, cap: "wallet", sentence: WALLET_SAID.toppingUpAsk });
  assertEquals(s.topups, ["builder-a", "builder-a"]);
});

Deno.test("gate: a read it can't make stops the turn in a sentence, and says so in the log, even with money in the wallet", async () => {
  for (const f of [{ meterFails: true }, { meterFails: "throw" }, { exemptFails: true }, { exemptFails: "throw" }, { accountFails: true }, { accountFails: "throw" }] as const) {
    for (const purpose of ["chat", "sheet"] as const) {
      const { wallet, s } = fakeWallet({ ...f, balance: 5000, autoTopup: true });
      const { deps, logs } = makeDeps(wallet);
      assertEquals(await gate(deps, who, purpose, true), { ok: false, cap: "wallet", sentence: WALLET_SAID.unread }, JSON.stringify(f));
      assertEquals(logs.map((l) => l.code), ["jack_wallet_gate_error"]);
      assert(!/goes ahead/.test(logs[0].message), logs[0].message);
      // Nothing it couldn't read is a reason to ask the top-up door.
      assertEquals(s.topups.length, 0);
    }
  }
});

Deno.test("gate: with the meter known to be off, an exempt or wallet read that would fail is never made, and the turn goes ahead as before", async () => {
  for (const f of [{ exemptFails: true }, { accountFails: "throw" }, { exemptFails: "throw", accountFails: true }] as const) {
    for (const off of [{ active: false }, { markup: null }] as const) {
      const { wallet, s } = fakeWallet({ ...f, ...off, balance: 0 });
      const { deps, logs } = makeDeps(wallet);
      assertEquals(await gate(deps, who, "chat", true), { ok: true }, JSON.stringify({ ...f, ...off }));
      assertEquals([s.reads.exempt, s.reads.account, logs.length], [0, 0, 0]);
    }
  }
  // The team in view-as is never refused, whatever can't be read: their turn is absorbed.
  const { wallet } = fakeWallet({ meterFails: "throw", exemptFails: true, accountFails: true });
  assertEquals(await gate(makeDeps(wallet).deps, operator, "sheet", true), { ok: true });
});

Deno.test("the gate's words are short, plain and hold no figure", () => {
  for (const [k, t] of Object.entries(WALLET_SAID)) {
    assert(!/\d|\$|—|–/.test(t), `${k} holds a figure or a dash: ${t}`);
    assert(!leaksContactDetails(t), k);
    assert(t.length <= 140, `${k} is long`);
  }
});

// ── afterCharge ───────────────────────────────────────────────────────────────────────────────────

Deno.test("afterCharge asks the door only when automatic top-up is on and the balance is under its threshold", async () => {
  const cases: [Parameters<typeof fakeWallet>[0], Who, boolean][] = [
    [{ autoTopup: true, threshold: 2000, balance: 1999 }, who, true],
    [{ autoTopup: true, threshold: 2000, balance: 3000, held: 1001 }, who, true],
    [{ autoTopup: true, threshold: 2000, balance: 2000 }, who, false],
    [{ autoTopup: true, threshold: 2000, balance: 1999, rem: 9_999 }, who, true],
    [{ autoTopup: false, threshold: 2000, balance: 0 }, who, false],
    [{ autoTopup: true, threshold: null, balance: 0 }, who, false],
    [{ autoTopup: true, threshold: 0, balance: 0 }, who, false],
    [{ autoTopup: true, threshold: 2000, balance: 0, exempt: true }, who, false],
    [{ autoTopup: true, threshold: 2000, balance: 0, active: false }, who, false],
    [{ autoTopup: true, threshold: 2000, balance: 0 }, operator, false],
    [{ autoTopup: true, threshold: 2000, balance: 0, accountFails: true }, who, false],
    [{ autoTopup: true, threshold: 2000, balance: 0, exemptFails: true }, who, false],
  ];
  for (const [init, w, asked] of cases) {
    const { wallet, s } = fakeWallet(init);
    assertEquals(await afterCharge(makeDeps(wallet).deps, w), asked, JSON.stringify(init));
    assertEquals(s.topups, asked ? ["builder-a"] : []);
  }
});

// ── The $50 ───────────────────────────────────────────────────────────────────────────────────────

Deno.test("the welcome credit: $50 once, under its fixed key, before the gate, so a $0 wallet isn't refused", async () => {
  forgetGrantsSeen();
  const { wallet, s } = fakeWallet({ balance: 0 });
  const { deps } = makeDeps(wallet);
  assertEquals(await ensureWelcomeCredit(deps, who), "granted");
  assertEquals(s.grants, [{ clientId: "builder-a", cents: 5000, key: "jack_welcome", memo: "Jack welcome credit" }]);
  assertEquals(await gate(deps, who, "chat", true), { ok: true });
  // The next send makes no call at all.
  assertEquals(await ensureWelcomeCredit(deps, who), "granted");
  assertEquals(s.grants.length, 1);
  // Another worker that hasn't seen it calls once, and the ledger key keeps it to one $50.
  forgetGrantsSeen();
  assertEquals(await ensureWelcomeCredit(makeDeps(wallet).deps, who), "granted");
  assertEquals([s.grants.length, s.balance], [2, 5000]);
});

Deno.test("the welcome credit waits while the meter is off, and skips exempt builders and the team in view-as", async () => {
  for (const [init, w] of [[{ active: false }, who], [{ markup: null }, who], [{ exempt: true }, who], [{ meterFails: true }, who], [{ exemptFails: true }, who], [{}, operator]] as const) {
    forgetGrantsSeen();
    const { wallet, s } = fakeWallet(init);
    assertEquals(await ensureWelcomeCredit(makeDeps(wallet).deps, w), "skipped", JSON.stringify(init));
    assertEquals(s.grants.length, 0);
  }
});

Deno.test("a welcome credit that didn't post is logged and tried again on the next message", async () => {
  forgetGrantsSeen();
  const { wallet, s } = fakeWallet({ grantFails: true, balance: 0 });
  const { deps, logs } = makeDeps(wallet);
  assertEquals(await ensureWelcomeCredit(deps, who), "failed");
  assertEquals(logs.map((l) => l.code), ["jack_welcome_failed"]);
  // Without it, a $0 wallet stops at the floor.
  assertEquals((await gate(deps, who, "chat", true)).ok, false);
  s.grantFails = false;
  assertEquals(await ensureWelcomeCredit(deps, who), "granted");
  assertEquals([s.grants.length, s.balance], [2, 5000]);
});

// ── What Jack can't do with money (source checks over jack-agent) ─────────────────────────────────

const DIR = new URL("./", import.meta.url);
async function sources(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const e of Deno.readDir(DIR)) {
    if (!e.isFile || !e.name.endsWith(".ts") || e.name.endsWith("_test.ts") || e.name === "test_assert.ts") continue;
    const src = (await Deno.readTextFile(new URL(e.name, DIR))).replace(/\r\n/g, "\n");
    // Code only: a comment may name a thing to say it isn't done.
    out[e.name] = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }
  return out;
}

Deno.test("jack-agent can't charge a card: no card or top-up code, no holds, no money action on portal-billing", async () => {
  const src = await sources();
  assert(Object.keys(src).includes("billing.ts") && Object.keys(src).includes("index.ts"), "the source read found the wrong folder");
  for (const [name, code] of Object.entries(src)) {
    assert(!/from\s+["'][^"']*(walletTopup|walletAutoTopup|nmi|cardpointe|cofConsent|walletReceipt)\.ts["']/.test(code), `${name} imports card or top-up code`);
    assert(!/\bchargeTopup\b|\brunAutoTopup\b/.test(code), `${name} names a card charge`);
    assert(!/wallet_(hold|capture|release|adjust)\b/.test(code), `${name} names a wallet hold or adjustment`);
    assert(!/["']portal-billing["']\s*,\s*["'](topup|topup_settings|update_card|subscribe|cancel)["']/.test(code), `${name} asks portal-billing to move money`);
  }
});

Deno.test("the only money writes: the jack_ai debit and the $50 grant, each from one place", async () => {
  const src = await sources();
  const where = (re: RegExp) => Object.entries(src).filter(([, c]) => re.test(c)).map(([n]) => n).sort();
  assertEquals(where(/rpc\(\s*["']wallet_usage_debit["']/), ["index.ts"]);
  assertEquals(where(/rpc\(\s*["']wallet_credit["']/), ["index.ts"]);
  assert(/rpc\(\s*"wallet_usage_debit",\s*\{[^}]*p_meter_kind:\s*"jack_ai"/.test(src["index.ts"]), "the debit isn't on the jack_ai meter");
  assert(/rpc\(\s*"wallet_credit",\s*\{[^}]*p_kind:\s*"grant"/.test(src["index.ts"]), "the credit isn't a grant");
  // Who calls the wallet's writes: billing.ts, with the welcome constants.
  assertEquals(where(/\.debit\(/), ["billing.ts"]);
  assertEquals(where(/\.grantOnce\(/), ["billing.ts"]);
  assertEquals(where(/\.requestTopup\(/), ["billing.ts"]);
  const grants = [...src["billing.ts"].matchAll(/\.grantOnce\(([^)]*)\)/g)].map((m) => m[1].trim());
  assertEquals(grants, ["who.clientId, WELCOME_CENTS, WELCOME_KEY, WELCOME_MEMO"]);
  // No other rpc that moves money anywhere in jack-agent.
  for (const [name, code] of Object.entries(src)) {
    for (const m of code.matchAll(/rpc\(\s*["']([a-z_]+)["']/g)) assert(["jack_usage", "wallet_usage_debit", "wallet_credit", "jack_clear_old_private"].includes(m[1]), `${name} calls rpc ${m[1]}`);
  }
});

Deno.test("Claude has no money tool", () => {
  const names = [...(TOOL_DEFS as { name: string }[]).map((t) => t.name), ...PIECE_TOOLS.keys()];
  assert(names.length > 0, "no tools found");
  // A tool that only READS (look_ / find_, never strict, writes no card) may read billing (reads.ts
  // look_at_billing, v2). Anything that proposes or acts must not touch money.
  for (const n of names) {
    if (/^(look_|find_)/.test(n)) continue;
    assert(!/wallet|billing|bill|topup|top_up|charge|refund|credit|invoice|payment|balance|fund/i.test(n), `a money tool: ${n}`);
  }
  assert(PIECE_TOOLS.get("look_at_billing") ? !PIECE_TOOLS.get("look_at_billing")!.proposesChange : true, "look_at_billing must only read");
});
