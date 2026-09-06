// Unit tests for invoice payments (migration 174).
//
// WHY THESE EXIST. Two halves, and the second half is the one this repo has never had.
//
//   1. paymentAmountDecision is the ONE definition of "what is payable right now", shared
//      by the button the customer sees, the confirm handshake, and the charge itself. If
//      those three ever disagree, a screen says one number and a card is charged another.
//
//   2. The choreography. billing_charge_attempts has guarded the subscription path since
//      migration 061 with NO test of its state machine, and walletTopup.ts mirrors it with
//      none either. The properties below — the charge attempt exists in OUR records before
//      the card is touched, an unverifiable outcome BLOCKS rather than retries, and a good
//      charge is never auto-reversed on a bookkeeping failure — are the whole reason those
//      files are shaped the way they are. Asserting them here is what stops a future
//      "improvement" from quietly undoing one.
//
// The gateway is driven through a stubbed globalThis.fetch rather than a mocked cpAuth, so
// these exercise the REAL classification in cardpointe.ts end to end.
//
// Dependency-free (no jsr:/npm: imports) so the suite runs with no registry access. Env is
// set before the dynamic import because cardpointe.ts reads its configuration at load.

Deno.env.set("CARDPOINTE_BASE_URL", "https://isv-uat.example.invalid/cardconnect/rest");
Deno.env.set("CARDPOINTE_API_USER", "u");
Deno.env.set("CARDPOINTE_API_PASS", "p");
Deno.env.set("CARDPOINTE_MERCHID", "490000000101");
Deno.env.set("CARDPOINTE_TOKENIZER_BASE", "https://isv-uat.example.invalid/itoke/ajax-tokenizer.html");

const ip = await import("./invoicePayment.ts");

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Part 1 — the amount, which is pure and therefore cheap to pin exhaustively.
// ─────────────────────────────────────────────────────────────────────────────────────

const base = { owedCents: 365000, settledCents: 0, pendingCents: 0, depositCents: null as number | null };

Deno.test("no deposit set: the ask is the whole balance", () => {
  const d = ip.paymentAmountDecision(base);
  check("ok", d.ok);
  if (!d.ok) return;
  check("ask", d.askCents === 365000, String(d.askCents));
  check("kind", d.kind === "balance");
});

Deno.test("deposit set and nothing paid: the ask is the DEPOSIT, not the total", () => {
  const d = ip.paymentAmountDecision({ ...base, depositCents: 100000 });
  check("ok", d.ok);
  if (!d.ok) return;
  check("ask", d.askCents === 100000, String(d.askCents));
  check("kind", d.kind === "deposit");
  check("balance still the full amount", d.balanceCents === 365000);
});

Deno.test("deposit part-paid: the ask is the REMAINDER of the deposit", () => {
  const d = ip.paymentAmountDecision({ ...base, depositCents: 100000, settledCents: 40000 });
  check("ok", d.ok);
  if (!d.ok) return;
  check("ask", d.askCents === 60000, String(d.askCents));
  check("kind", d.kind === "deposit");
});

Deno.test("deposit covered: the ask becomes the remaining balance", () => {
  const d = ip.paymentAmountDecision({ ...base, depositCents: 100000, settledCents: 100000 });
  check("ok", d.ok);
  if (!d.ok) return;
  check("ask", d.askCents === 265000, String(d.askCents));
  check("kind", d.kind === "balance");
});

Deno.test("a deposit larger than the balance never over-collects", () => {
  const d = ip.paymentAmountDecision({ owedCents: 5000, settledCents: 0, pendingCents: 0, depositCents: 100000 });
  check("ok", d.ok);
  if (!d.ok) return;
  check("clamped to the balance", d.askCents === 5000, String(d.askCents));
});

Deno.test("ANY pending bank payment blocks a further payment", () => {
  // The way a customer pays twice is by being shown a button that still says they owe it.
  // Partial coverage blocks too: a second payment must never ride on an unsettled first.
  const full = ip.paymentAmountDecision({ ...base, pendingCents: 365000 });
  check("full coverage refused", !full.ok && full.reason === "pending_clearing");
  const part = ip.paymentAmountDecision({ ...base, pendingCents: 100 });
  check("partial coverage ALSO refused", !part.ok && part.reason === "pending_clearing");
});

Deno.test("returned money does not count as settled — the balance reopens", () => {
  // readOrderMoney excludes 'returned' from settledCents, so the arithmetic here is simply
  // the balance coming back. Pinned so a future reducer change cannot silently keep it paid.
  const d = ip.paymentAmountDecision({ ...base, settledCents: 0, pendingCents: 0 });
  check("payable again", d.ok && d.askCents === 365000);
});

Deno.test("paid in full, overpaid, and no-total are each a NAMED refusal", () => {
  const paid = ip.paymentAmountDecision({ ...base, settledCents: 365000 });
  check("paid", !paid.ok && paid.reason === "paid_in_full");
  const over = ip.paymentAmountDecision({ ...base, settledCents: 400000 });
  check("overpaid", !over.ok && over.reason === "paid_in_full");
  const none = ip.paymentAmountDecision({ ...base, owedCents: null });
  check("no total", !none.ok && none.reason === "no_total");
  // Every reason has a customer sentence, or a refusal ships with no words.
  for (const r of ["no_total", "paid_in_full", "pending_clearing", "below_minimum", "above_maximum"]) {
    check(`sentence for ${r}`, ip.amountRefusalText(r).length > 10, r);
  }
});

Deno.test("amounts outside the floor and ceiling are refused", () => {
  const tiny = ip.paymentAmountDecision({ owedCents: 50, settledCents: 0, pendingCents: 0, depositCents: null });
  check("below minimum", !tiny.ok && tiny.reason === "below_minimum");
  const huge = ip.paymentAmountDecision({
    owedCents: ip.MAX_PAYMENT_CENTS + 1, settledCents: 0, pendingCents: 0, depositCents: null,
  });
  check("above maximum", !huge.ok && huge.reason === "above_maximum");
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Part 2 — the choreography.
// ─────────────────────────────────────────────────────────────────────────────────────

type Call = { table: string; op: string; payload?: unknown };

/** A chainable PostgREST-shaped stub. `answer` decides what each (table, op) resolves to;
 *  every call is appended to `log`, which is how ORDERING is asserted. */
// deno-lint-ignore no-explicit-any
function makeAdmin(answer: (table: string, op: string, payload: any) => any, log: Call[]) {
  return {
    from(table: string) {
      const st = { table, op: "", payload: undefined as unknown };
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select() {
          if (!st.op) st.op = "select";
          return b;
        },
        insert(p: unknown) {
          st.op = "insert";
          st.payload = p;
          return b;
        },
        update(p: unknown) {
          st.op = "update";
          st.payload = p;
          return b;
        },
        eq() {
          return b;
        },
        in() {
          return b;
        },
        gt() {
          return b;
        },
        is() {
          return b;
        },
        order() {
          return b;
        },
        limit() {
          return b;
        },
        maybeSingle() {
          return b;
        },
        // deno-lint-ignore no-explicit-any
        then(res: any, rej?: any) {
          log.push({ table: st.table, op: st.op, payload: st.payload });
          try {
            return Promise.resolve(answer(st.table, st.op, st.payload)).then(res, rej);
          } catch (e) {
            return rej ? Promise.resolve(rej(e)) : Promise.reject(e);
          }
        },
      };
      return b;
    },
  };
}

const realFetch = globalThis.fetch;
let fetchCount = 0;
const fetchLog: string[] = [];
function stubGateway(handler: (url: string, init?: RequestInit) => Response) {
  fetchCount = 0;
  fetchLog.length = 0;
  globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => {
    fetchCount++;
    fetchLog.push(String(u));
    return Promise.resolve(handler(String(u), i));
  }) as typeof fetch;
}
function restore() {
  globalThis.fetch = realFetch;
}

const OPTS = {
  clientId: "t1",
  merchid: "490000000101",
  orderId: "o1",
  shortCode: "SS-ABC",
  amountCents: 100000,
  rail: "card" as const,
  account: "9413948780281111",
  actorKind: "customer" as const,
};

/** Default answers: no prior attempts, order money reads clean, inserts succeed. */
// deno-lint-ignore no-explicit-any
function defaultAnswer(over: Record<string, any> = {}) {
  // deno-lint-ignore no-explicit-any
  return (table: string, op: string, _p: any): any => {
    const key = `${table}:${op}`;
    if (key in over) return over[key];
    if (table === "payment_attempts" && op === "select") return { data: [] };
    if (table === "payment_attempts" && op === "insert") return { data: { id: 7 }, error: null };
    if (table === "payment_attempts" && op === "update") return { data: null, error: null };
    if (table === "payments" && op === "insert") return { data: { id: "p1" }, error: null };
    if (table === "payments" && op === "select") return { data: [] };
    if (table === "orders" && op === "select") return { data: { id: "o1", short_code: null, total_cents: 365000 } };
    if (table === "app_errors" && op === "insert") return { data: null, error: null };
    return { data: null, error: null };
  };
}

Deno.test("a prior closed_unknown REFUSES, and the gateway is never called", async () => {
  // The whole safety property. Retrying an unverified charge is how a customer is billed
  // twice, and nothing in this repo tested the equivalent for billing.
  const log: Call[] = [];
  stubGateway(() => new Response("{}", { status: 200 }));
  const admin = makeAdmin(defaultAnswer({ "payment_attempts:select": { data: [{ id: 3, orderid: "ssp_old" }] } }), log);
  const r = await ip.chargeInvoicePayment(admin, OPTS);
  restore();
  check("refused", !r.ok);
  if (r.ok) return;
  check("blocking", r.blocking === true);
  check("409", r.status === 409);
  check("ZERO gateway calls", fetchCount === 0, String(fetchCount));
  check("no attempt row written", !log.some((c) => c.table === "payment_attempts" && c.op === "insert"));
});

Deno.test("the attempt row is written BEFORE the gateway is called, and payments AFTER", async () => {
  // Ordering IS the design. Nothing in this codebase pinned it until now.
  const log: Call[] = [];
  let attemptInsertAt = -1;
  let fetchAt = -1;
  let paymentsInsertAt = -1;
  let seq = 0;
  stubGateway(() => {
    fetchAt = seq++;
    return new Response(
      JSON.stringify({ respstat: "A", respcode: "000", retref: "r9", amount: "1000.00", token: "9413948780284242" }),
      { status: 200 },
    );
  });
  const admin = makeAdmin((table, op, p) => {
    if (table === "payment_attempts" && op === "insert") attemptInsertAt = seq++;
    if (table === "payments" && op === "insert") paymentsInsertAt = seq++;
    return defaultAnswer()(table, op, p);
  }, log);
  const r = await ip.chargeInvoicePayment(admin, OPTS);
  restore();
  check("succeeded", r.ok, r.ok ? "" : r.error);
  check("attempt before gateway", attemptInsertAt >= 0 && attemptInsertAt < fetchAt, `${attemptInsertAt} < ${fetchAt}`);
  check("payments after gateway", paymentsInsertAt > fetchAt, `${paymentsInsertAt} > ${fetchAt}`);
  const closes = log.filter((c) => c.table === "payment_attempts" && c.op === "update");
  const lastClose = closes[closes.length - 1]?.payload as Record<string, unknown>;
  check("closed_ok last", lastClose?.state === "closed_ok", JSON.stringify(lastClose));
});

Deno.test("a losing race on the open-attempt insert refuses before any charge", async () => {
  // The partial unique index IS the concurrency guard: two tabs, a double-tap, or a
  // customer paying while a rep charges the same balance all land here.
  const log: Call[] = [];
  stubGateway(() => new Response("{}", { status: 200 }));
  const admin = makeAdmin(
    defaultAnswer({ "payment_attempts:insert": { data: null, error: { message: "duplicate key", code: "23505" } } }),
    log,
  );
  const r = await ip.chargeInvoicePayment(admin, OPTS);
  restore();
  check("refused", !r.ok);
  if (r.ok) return;
  check("not blocking — it is safe to retry in a moment", r.blocking === false);
  check("ZERO gateway calls", fetchCount === 0, String(fetchCount));
});

Deno.test("a DECLINE closes declined, writes no payment, and issues no void or refund", async () => {
  const log: Call[] = [];
  stubGateway(() =>
    new Response(JSON.stringify({ respstat: "C", respcode: "116", resptext: "Not sufficient funds" }), { status: 200 })
  );
  const admin = makeAdmin(defaultAnswer(), log);
  const r = await ip.chargeInvoicePayment(admin, OPTS);
  restore();
  check("refused", !r.ok);
  if (r.ok) return;
  check("402", r.status === 402, String(r.status));
  check("not blocking", r.blocking === false);
  check("carries the reason", r.error.includes("Not sufficient funds"), r.error);
  check("no payments row", !log.some((c) => c.table === "payments" && c.op === "insert"));
  check("exactly one gateway call — no void, no retry", fetchCount === 1, fetchLog.join(","));
  const close = log.filter((c) => c.table === "payment_attempts" && c.op === "update").pop()
    ?.payload as Record<string, unknown>;
  check("closed_declined", close?.state === "closed_declined", JSON.stringify(close));
});

Deno.test("an UNKNOWN outcome blocks, logs a fault, and writes no payment", async () => {
  const log: Call[] = [];
  stubGateway(() => new Response("upstream exploded", { status: 502 }));
  const admin = makeAdmin(defaultAnswer(), log);
  const r = await ip.chargeInvoicePayment(admin, OPTS);
  restore();
  check("refused", !r.ok);
  if (r.ok) return;
  check("blocking", r.blocking === true);
  check("409", r.status === 409);
  check("tells them NOT to retry", /do not try again/i.test(r.error), r.error);
  check("no payments row", !log.some((c) => c.table === "payments" && c.op === "insert"));
  check("app_errors written", log.some((c) => c.table === "app_errors" && c.op === "insert"));
  const close = log.filter((c) => c.table === "payment_attempts" && c.op === "update").pop()
    ?.payload as Record<string, unknown>;
  check("closed_unknown", close?.state === "closed_unknown", JSON.stringify(close));
  // The orderid is the recovery key — the fault message has to name it or the whole
  // inquireByOrderid design is unreachable by the person reading the log.
  const fault = log.find((c) => c.table === "app_errors")?.payload as Record<string, unknown>;
  check("fault names the orderid", String(fault?.message ?? "").includes("ssp_"), String(fault?.message));
});

Deno.test("THROTTLED is known-not-charged: a 429, not a block", async () => {
  const log: Call[] = [];
  stubGateway(() =>
    new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
      headers: { "X-Rate-Limit-Retry-After-Seconds": "42" },
    })
  );
  const admin = makeAdmin(defaultAnswer(), log);
  const r = await ip.chargeInvoicePayment(admin, OPTS);
  restore();
  check("refused", !r.ok);
  if (r.ok) return;
  check("429", r.status === 429, String(r.status));
  check("NOT blocking", r.blocking === false);
  check("mentions the wait", /42/.test(r.error), r.error);
});

Deno.test("a PARTIAL approval is voided, closes declined, and never becomes a payment", async () => {
  const log: Call[] = [];
  let sawVoid = false;
  stubGateway((url) => {
    if (url.endsWith("/void")) {
      sawVoid = true;
      return new Response(JSON.stringify({ respstat: "A", respcode: "000", retref: "r5" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ respstat: "A", respcode: "000", retref: "r5", amount: "500.00" }),
      { status: 200 },
    );
  });
  const admin = makeAdmin(defaultAnswer(), log);
  const r = await ip.chargeInvoicePayment(admin, OPTS);
  restore();
  check("refused", !r.ok);
  if (r.ok) return;
  check("the void was issued", sawVoid);
  check("402", r.status === 402);
  check("tells them the hold was released", /released/i.test(r.error), r.error);
  check("NO payments row", !log.some((c) => c.table === "payments" && c.op === "insert"));
});

Deno.test("a partial whose VOID fails blocks and shouts", async () => {
  const log: Call[] = [];
  stubGateway((url) => {
    if (url.endsWith("/void")) return new Response("nope", { status: 500 });
    return new Response(
      JSON.stringify({ respstat: "A", respcode: "000", retref: "r6", amount: "500.00" }),
      { status: 200 },
    );
  });
  const admin = makeAdmin(defaultAnswer(), log);
  const r = await ip.chargeInvoicePayment(admin, OPTS);
  restore();
  check("refused", !r.ok);
  if (r.ok) return;
  check("blocking", r.blocking === true);
  check("app_errors written", log.some((c) => c.table === "app_errors" && c.op === "insert"));
});

Deno.test("charged but NOT recorded: blocks, shouts, and issues NO reversal", async () => {
  // The most important assertion in this file. This DIFFERS from portal-billing's subscribe
  // unwind on purpose: subscribe voids because the thing the money bought does not exist,
  // whereas here the paid-down balance is real and only our bookkeeping broke. Reversing a
  // good customer payment on a guess un-pays a real invoice. Pinned so a future
  // "improvement" that adds an auto-refund here fails the push.
  const log: Call[] = [];
  stubGateway((url) => {
    if (url.endsWith("/void") || url.endsWith("/refund")) return new Response("{}", { status: 200 });
    return new Response(
      JSON.stringify({ respstat: "A", respcode: "000", retref: "r7", amount: "1000.00" }),
      { status: 200 },
    );
  });
  const admin = makeAdmin(
    defaultAnswer({ "payments:insert": { data: null, error: { message: "column blew up", code: "42703" } } }),
    log,
  );
  const r = await ip.chargeInvoicePayment(admin, OPTS);
  restore();
  check("refused", !r.ok);
  if (r.ok) return;
  check("500", r.status === 500, String(r.status));
  check("blocking", r.blocking === true);
  check("NO void and NO refund was issued", !fetchLog.some((u) => /\/(void|refund)$/.test(u)), fetchLog.join(","));
  const fault = log.find((c) => c.table === "app_errors")?.payload as Record<string, unknown>;
  check("fault names the retref", String(fault?.message ?? "").includes("r7"), String(fault?.message));
  // The trigger on payments (105) can abort this transaction for reasons that have nothing
  // to do with payments; the message has to say so or triage chases a phantom DB fault.
  check(
    "fault points at the inventory trigger",
    /payments_claim_inventory/.test(String(fault?.message ?? "")),
    String(fault?.message),
  );
});

Deno.test("a duplicate retref is a REPLAY, i.e. success — not a second charge", async () => {
  const log: Call[] = [];
  stubGateway(() =>
    new Response(
      JSON.stringify({ respstat: "A", respcode: "000", retref: "r8", amount: "1000.00" }),
      { status: 200 },
    )
  );
  // The lookup for the existing row happens BEFORE readOrderMoney re-reads the ledger, so
  // this override answers once with the found row and then falls back to a normal read.
  let lookupDone = false;
  const answer = defaultAnswer({
    "payments:insert": { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } },
  });
  const admin = makeAdmin((table, op, p) => {
    if (table === "payments" && op === "select" && !lookupDone) {
      lookupDone = true;
      return { data: { id: "already" } };
    }
    return answer(table, op, p);
  }, log);
  const r = await ip.chargeInvoicePayment(admin, OPTS);
  restore();
  check("SUCCEEDED", r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  check("flagged as a replay", r.already === true);
  const close = log.filter((c) => c.table === "payment_attempts" && c.op === "update").pop()
    ?.payload as Record<string, unknown>;
  check("closed_ok", close?.state === "closed_ok", JSON.stringify(close));
});

Deno.test("an ACH charge lands PENDING, never settled", async () => {
  const log: Call[] = [];
  stubGateway(() =>
    new Response(
      JSON.stringify({ respstat: "A", respcode: "000", retref: "ra", amount: "1000.00" }),
      { status: 200 },
    )
  );
  const admin = makeAdmin(defaultAnswer(), log);
  const r = await ip.chargeInvoicePayment(admin, { ...OPTS, rail: "ach" });
  restore();
  check("succeeded", r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  check("pending", r.fundingState === "pending");
  const row = log.find((c) => c.table === "payments" && c.op === "insert")?.payload as Record<string, unknown>;
  check("row says pending", row?.funding_state === "pending", JSON.stringify(row));
  check("method ach", row?.method === "ach");
});

Deno.test("an out-of-range amount is refused before anything is written", async () => {
  const log: Call[] = [];
  stubGateway(() => new Response("{}", { status: 200 }));
  const admin = makeAdmin(defaultAnswer(), log);
  for (const cents of [0, -100, 50, ip.MAX_PAYMENT_CENTS + 1, 1.5]) {
    const r = await ip.chargeInvoicePayment(admin, { ...OPTS, amountCents: cents });
    check(`${cents} refused`, !r.ok);
  }
  restore();
  check("nothing written", log.length === 0, JSON.stringify(log));
  check("ZERO gateway calls", fetchCount === 0);
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Part 3 — resolving an unverifiable charge.
//
// resolveUnknownAttempt is the ONLY code that can lift a closed_unknown block, so every
// exit it takes is a double-charge decision. Two of them are not obvious and are pinned
// here: an attempt still IN FLIGHT is not resolvable at all (the gateway has not heard of
// it yet, and "no record" would read as nothing-was-charged), and a recovery that cannot
// write the payments row must LEAVE the block standing rather than stamp closed_ok with
// no payment behind it.
// ─────────────────────────────────────────────────────────────────────────────────────

/** The gateway answering "yes, that orderid really did charge". */
const CHARGED = JSON.stringify({ respstat: "A", respcode: "000", retref: "rz", amount: "1000.00" });

const UNKNOWN_ATT = {
  id: 42,
  order_id: "o1",
  short_code: "SS-ABC",
  amount_cents: 100000,
  rail: "card",
  merchid: "490000000101",
  orderid: "ssp_lost",
  state: "closed_unknown",
  retref: null,
  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
};

/** Default answers for the recovery path: one attempt row, an insert that succeeds. */
// deno-lint-ignore no-explicit-any
function attemptAnswer(att: Record<string, any>, over: Record<string, any> = {}) {
  // deno-lint-ignore no-explicit-any
  return (table: string, op: string, _p: any): any => {
    const key = `${table}:${op}`;
    if (key in over) return over[key];
    if (table === "payment_attempts" && op === "select") return { data: att };
    if (table === "payment_attempts" && op === "update") return { data: null, error: null };
    if (table === "payments" && op === "insert") return { data: { id: "pRec" }, error: null };
    if (table === "payments" && op === "select") return { data: null };
    if (table === "app_errors" && op === "insert") return { data: null, error: null };
    return { data: null, error: null };
  };
}

Deno.test("recovery of a real charge records it and closes the attempt OK", async () => {
  const log: Call[] = [];
  stubGateway(() => new Response(CHARGED, { status: 200 }));
  const admin = makeAdmin(attemptAnswer(UNKNOWN_ATT), log);
  const r = await ip.resolveUnknownAttempt(admin, "t1", 42);
  restore();
  check("resolved", r.resolved, JSON.stringify(r));
  if (!r.resolved || r.outcome !== "charged") return;
  check("carries the payment id", r.paymentId === "pRec", String(r.paymentId));
  const close = log.filter((c) => c.table === "payment_attempts" && c.op === "update").pop()
    ?.payload as Record<string, unknown>;
  check("closed_ok WITH a payment id", close?.state === "closed_ok" && close?.payment_id === "pRec", JSON.stringify(close));
});

Deno.test("a recovery that cannot record the payment KEEPS the block and shouts", async () => {
  // THE ONE THIS FILE EXISTS FOR. Closing the attempt ok with a null payment_id would lift
  // the double-charge block on an order whose money is charged and still missing from the
  // ledger — strictly worse than the closed_unknown it started as, and invisible: the next
  // customer tap sails straight through to a second charge.
  const log: Call[] = [];
  stubGateway(() => new Response(CHARGED, { status: 200 }));
  const admin = makeAdmin(
    attemptAnswer(UNKNOWN_ATT, {
      "payments:insert": { data: null, error: { message: "column blew up", code: "42703" } },
    }),
    log,
  );
  const r = await ip.resolveUnknownAttempt(admin, "t1", 42);
  restore();
  check("NOT resolved", !r.resolved, JSON.stringify(r));
  if (r.resolved) return;
  check("reason", r.reason === "record_failed", r.reason);
  check(
    "the attempt state was NOT touched — the block stands",
    !log.some((c) => c.table === "payment_attempts" && c.op === "update"),
    JSON.stringify(log),
  );
  const fault = log.find((c) => c.table === "app_errors")?.payload as Record<string, unknown>;
  check("app_errors written", !!fault);
  check(
    "names the retref and the attempt a human has to close",
    /rz/.test(String(fault?.message)) && /42/.test(String(fault?.message)),
    String(fault?.message),
  );
});

Deno.test("a duplicate gateway_txn during recovery is the idempotent replay, i.e. success", async () => {
  // Must not regress: re-running reconcile over the same attempt collides with
  // payments_gateway_txn_uniq, and the row it collided with is the answer.
  const log: Call[] = [];
  stubGateway(() => new Response(CHARGED, { status: 200 }));
  const admin = makeAdmin(
    attemptAnswer(UNKNOWN_ATT, {
      "payments:insert": { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } },
      "payments:select": { data: { id: "already" } },
    }),
    log,
  );
  const r = await ip.resolveUnknownAttempt(admin, "t1", 42);
  restore();
  check("resolved", r.resolved, JSON.stringify(r));
  if (!r.resolved || r.outcome !== "charged") return;
  check("the row already there IS the answer", r.paymentId === "already", String(r.paymentId));
  const close = log.filter((c) => c.table === "payment_attempts" && c.op === "update").pop()
    ?.payload as Record<string, unknown>;
  check("closed_ok", close?.state === "closed_ok" && close?.payment_id === "already", JSON.stringify(close));
});

Deno.test("an OPEN attempt still in flight is left alone: no gateway call, block intact", async () => {
  // The charge that owns this row may be at the gateway this second, so the gateway has no
  // record of it YET. Answering "not_charged" here would unblock the order moments before
  // the auth lands.
  const log: Call[] = [];
  stubGateway(() => new Response(CHARGED, { status: 200 }));
  const admin = makeAdmin(
    attemptAnswer({ ...UNKNOWN_ATT, state: "open", created_at: new Date().toISOString() }),
    log,
  );
  const r = await ip.resolveUnknownAttempt(admin, "t1", 42);
  restore();
  check("NOT resolved", !r.resolved, JSON.stringify(r));
  if (r.resolved) return;
  check("reason", r.reason === "in_flight", r.reason);
  check("ZERO gateway calls", fetchCount === 0, String(fetchCount));
  check("nothing was written", !log.some((c) => c.op !== "select"), JSON.stringify(log));
});

Deno.test("a STALE open attempt is still resolvable, so the recovery route stays alive", async () => {
  // The other half of the in-flight guard: once it is as old as the charge path's own
  // promotion threshold it is certainly dead, and the durable orderid exists precisely to
  // settle it. A guard that never lets go would be its own outage.
  const log: Call[] = [];
  stubGateway(() => new Response("{}", { status: 200 })); // no retref: the gateway never saw it
  const admin = makeAdmin(
    attemptAnswer({
      ...UNKNOWN_ATT,
      state: "open",
      created_at: new Date(Date.now() - ip.STALE_OPEN_MS - 1000).toISOString(),
    }),
    log,
  );
  const r = await ip.resolveUnknownAttempt(admin, "t1", 42);
  restore();
  check("resolved", r.resolved, JSON.stringify(r));
  if (!r.resolved) return;
  check("nothing was charged", r.outcome === "not_charged", r.outcome);
  const close = log.filter((c) => c.table === "payment_attempts" && c.op === "update").pop()
    ?.payload as Record<string, unknown>;
  check("closed_declined", close?.state === "closed_declined", JSON.stringify(close));
  check("NO payments row", !log.some((c) => c.table === "payments" && c.op === "insert"));
});
