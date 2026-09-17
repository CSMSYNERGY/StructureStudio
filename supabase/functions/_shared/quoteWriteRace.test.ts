// Unit tests for _shared/quoteWriteRace.ts — the two writers of an issued quote (review, 2026-09-17).
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// Every failure here is silent. A persist miss read as "retry" when another writer re-priced the
// tax overwrites a verified rate the builder paid for. One read as "retaxed" when nothing money-
// related moved refuses a shopper's submit over an unrelated write. And a document that is not
// rebuilt after the lines moved prints one total while the quote page and the acceptance freeze
// another. The last section checks the ordering rule itself against every interleaving of two
// writers, including the old order, which must fail.

import { quotePdfStale, sameTaxStamp, SUBMIT_RACE_REFUSAL, submitPersistMiss } from "./quoteWriteRace.ts";
import { carriedTax, stampTax } from "./taxChain.ts";

const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};
const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};

const POOLS = { taxable: 10000, nonTaxable: 0, taxableBase: 10000, nonTaxableNet: 0 };
const ADDR = { state: "GA", zip: "31201" };

/** The tax a quote was issued with: the company rate, stamped at submit time. */
const ISSUED = stampTax({
  pools: POOLS,
  resolved: { rate: 0.0725, source: "fallback", jurisdiction: null, reason: "not requested" },
  choice: { basis: "company", label: "Sales tax", locationId: null, locationName: null },
  address: ADDR,
  now: "2026-09-17T10:00:00.000Z",
});

/** What the Verify button writes a few seconds later: a fresh stamp, verified. */
const VERIFIED = stampTax({
  pools: POOLS,
  resolved: { rate: 0.081, source: "avalara", jurisdiction: "GA", reason: null },
  choice: { basis: "company", label: "Sales tax", locationId: null, locationName: null },
  address: ADDR,
  now: "2026-09-17T10:00:05.000Z",
});

/** jsonb hands a value back with its own key order; the comparison must not care. */
const fromDb = (v: Record<string, unknown>) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(v).reverse())));

// ── sameTaxStamp ────────────────────────────────────────────────────────────────────────────

Deno.test("sameTaxStamp: a carried tax is the same stamp, whatever the new lines did to its amount", () => {
  const carried = carriedTax(ISSUED, { taxable: 12000, nonTaxable: 500, taxableBase: 12000, nonTaxableNet: 500 });
  assert(carried.amount !== ISSUED.amount, "fixture: the carried amount should follow the new lines");
  assert(sameTaxStamp(carried, ISSUED), "a resubmit that carried the tax reads as a re-price");
  assert(sameTaxStamp(fromDb(ISSUED), ISSUED), "a round trip through jsonb reads as a re-price");
});

Deno.test("sameTaxStamp: any fresh stamp is a different one, even at the same rate", () => {
  assert(!sameTaxStamp(VERIFIED, ISSUED), "a verified rate reads as the stamp it replaced");
  const sameRateLater = stampTax({
    pools: POOLS,
    resolved: { rate: 0.0725, source: "fallback", jurisdiction: null, reason: "not requested" },
    choice: { basis: "location", label: "Macon lot", locationId: "3f0c2b1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c", locationName: "Macon" },
    address: ADDR,
    now: "2026-09-17T10:00:07.000Z",
  });
  assert(!sameTaxStamp(sameRateLater, ISSUED), "a location re-stamp at the same rate reads as untouched");
});

Deno.test("sameTaxStamp: no tax on both sides is the same; a tax on one side is not", () => {
  assert(sameTaxStamp(null, undefined));
  assert(!sameTaxStamp(null, ISSUED));
  assert(!sameTaxStamp(ISSUED, "not a tax"));
});

// ── submitPersistMiss ───────────────────────────────────────────────────────────────────────

const unsigned = (tax: unknown, extra: Record<string, unknown> = {}) => ({
  estimate_lines: { lines: [{ qty: 1, amount: 10000 }], tax },
  accepted_at: null,
  status: "sent",
  updated_at: "2026-09-17T10:00:09.000Z",
  ...extra,
});

Deno.test("submitPersistMiss: the Verify button landed after the submit read — refuse, never overwrite", () => {
  const carriedForward = carriedTax(ISSUED, POOLS);
  assertEquals(submitPersistMiss({ readTax: ISSUED, stampedTax: carriedForward, now: unsigned(fromDb(VERIFIED)) }), { kind: "retaxed" });
});

Deno.test("submitPersistMiss: an unrelated write moved updated_at — swap against the new value", () => {
  // A re-send stamping ss_quote_sent_at, a status sync, the designer's own save.
  assertEquals(submitPersistMiss({ readTax: ISSUED, stampedTax: carriedTax(ISSUED, POOLS), now: unsigned(fromDb(ISSUED)) }),
    { kind: "retry", updatedAt: "2026-09-17T10:00:09.000Z" });
});

Deno.test("submitPersistMiss: the submit's own draft promote wrote its stamp — a retry, not a re-price", () => {
  // A first issue: nothing was read, the promote wrote the new stamp, the persist then missed.
  const stamped = stampTax({
    pools: POOLS,
    resolved: { rate: 0.0725, source: "fallback", jurisdiction: null, reason: "not requested" },
    choice: { basis: "company", label: "Sales tax", locationId: null, locationName: null },
    address: ADDR,
    now: "2026-09-17T10:00:08.000Z",
  });
  assertEquals(submitPersistMiss({ readTax: null, stampedTax: stamped, now: unsigned(fromDb(stamped)) }).kind, "retry");
  assertEquals(submitPersistMiss({ readTax: null, stampedTax: stamped, now: unsigned(null) }).kind, "retry",
    "no tax yet on either side");
});

Deno.test("submitPersistMiss: a design accepted or deleted under the submit stops it", () => {
  assertEquals(submitPersistMiss({ readTax: ISSUED, stampedTax: ISSUED, now: unsigned(ISSUED, { accepted_at: "2026-09-17T10:00:06Z", status: "accepted" }) }),
    { kind: "accepted" });
  assertEquals(submitPersistMiss({ readTax: ISSUED, stampedTax: ISSUED, now: unsigned(ISSUED, { status: "invoiced" }) }), { kind: "accepted" },
    "the status ladder counts, as it does everywhere agreement is read");
  assertEquals(submitPersistMiss({ readTax: ISSUED, stampedTax: ISSUED, now: null }), { kind: "gone" });
});

Deno.test("SUBMIT_RACE_REFUSAL: plain sentences that say nothing was sent, with a reason code", () => {
  for (const [k, v] of Object.entries(SUBMIT_RACE_REFUSAL)) {
    assert(/^[A-Z]/.test(v.error) && /\.$/.test(v.error), `${k} is not a sentence`);
    assert(/nothing was sent/.test(v.error), `${k} does not say nothing was sent`);
    assert(!/\b(ss_|null|undefined|updated_at|portal|Verify)\b/.test(v.error), `${k} leaks an internal word: ${v.error}`);
    assert(v.reason === "changed" || v.reason === "accepted", `${k} has an unexpected reason`);
  }
});

// ── quotePdfStale ───────────────────────────────────────────────────────────────────────────

Deno.test("quotePdfStale: two database reads of the same lines agree; a replaced tax does not", () => {
  const stored = fromDb({ lines: [{ qty: 1, amount: 10000 }], tax: ISSUED, discount: 0 });
  assertEquals(quotePdfStale(stored, JSON.parse(JSON.stringify(stored))), false);
  assertEquals(quotePdfStale(stored, { ...stored, tax: VERIFIED }), true);
  assertEquals(quotePdfStale(null, undefined), false);
});

// ── The ordering rule, against every interleaving of two writers ────────────────────────────
//
// A model, not the handlers: the row, the PDF at its fixed path, and two writers whose steps are
// atomic. The wiring tests pin the handlers to the same order.

type Writer = { lines: string; order: "write-first-and-check" | "upload-first" | "write-first-no-check" };
type Local = { pc: number; printed: string | null; pending: string | null; passes: number };
type World = { row: string; pdf: string; w: Local[] };

const MAX_PASSES = 2;

/** One atomic step of writer i, or null when it is done. */
function step(writers: Writer[], s: World, i: number): World | null {
  const me = writers[i], l = s.w[i];
  const next = (patch: Partial<World>, local: Partial<Local>): World => ({
    ...s, ...patch, w: s.w.map((x, j) => (j === i ? { ...x, ...local } : x)),
  });
  if (me.order === "upload-first") {
    if (l.pc === 0) return next({ pdf: me.lines }, { pc: 1 });
    if (l.pc === 1) return next({ row: me.lines }, { pc: 9 });
    return null;
  }
  if (l.pc === 0) return next({ row: me.lines }, { pc: 1 });
  if (l.pc === 1) return next({ pdf: me.lines }, { pc: me.order === "write-first-and-check" ? 2 : 9, printed: me.lines });
  if (l.pc === 2) {
    if (!quotePdfStale(l.printed, s.row) || l.passes >= MAX_PASSES) return next({}, { pc: 9 });
    return next({}, { pc: 3, pending: s.row, passes: l.passes + 1 });
  }
  if (l.pc === 3) return next({ pdf: l.pending! }, { pc: 2, printed: l.pending });
  return null;
}

/** Every terminal world reachable from the start. */
function outcomes(writers: Writer[]): World[] {
  const done: World[] = [];
  const walk = (s: World) => {
    let moved = false;
    for (let i = 0; i < writers.length; i++) {
      const n = step(writers, s, i);
      if (n) { moved = true; walk(n); }
    }
    if (!moved) done.push(s);
  };
  walk({ row: "L0", pdf: "L0", w: writers.map(() => ({ pc: 0, printed: null, pending: null, passes: 0 })) });
  return done;
}

Deno.test("the rule: write, then upload, then re-read and rebuild — the document always prints the final row", () => {
  const worlds = outcomes([
    { lines: "resubmit", order: "write-first-and-check" },
    { lines: "verified", order: "write-first-and-check" },
  ]);
  assert(worlds.length > 20, `the model explored too little: ${worlds.length}`);
  for (const w of worlds) assertEquals(w.pdf, w.row, "a finished interleaving left the document and the row apart");
});

Deno.test("the old order fails: the submit uploading before it persists leaves a stale document", () => {
  // submit-estimate before this change, beside a re-stamp that already regenerated after writing.
  const worlds = outcomes([
    { lines: "resubmit", order: "upload-first" },
    { lines: "verified", order: "write-first-no-check" },
  ]);
  assert(worlds.some((w) => w.pdf !== w.row), "the model no longer reproduces the finding — it proves nothing about the fix");
});

Deno.test("half a fix fails too: the re-read alone, while one writer still uploads first", () => {
  const worlds = outcomes([
    { lines: "resubmit", order: "upload-first" },
    { lines: "verified", order: "write-first-and-check" },
  ]);
  assert(worlds.some((w) => w.pdf !== w.row), "upload-first is safe after all? then the reorder in submit-estimate is unexplained");
});
