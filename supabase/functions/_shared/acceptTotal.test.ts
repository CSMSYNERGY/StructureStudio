// Unit tests for _shared/acceptTotal.ts — the accept race (2026-09-17).
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// Two failures matter and both are silent: the check firing when the field is absent (every
// customer on production's older frontend is refused a signature), and the check passing a
// different total (a customer signs a number that is not the one on their screen).
//
// promoteMiss is the second half (review, 2026-09-17): a re-price that lands after the handler's
// read. Its silent failures are the mirror image: a re-price read as "retry" freezes the old total
// as the agreement beside the new quote, and a write that moved no money read as "repriced"
// throws away a real customer's acceptance.
//
// And the sentence itself: production's my-quotes.html signs a customer out when an error matches
// /token|session|expired|sign.?in/i, so a refusal that says "signing" logs them out instead of
// showing the new total.

import { checkExpectedTotal, promoteMiss, REPRICED_SENTENCE } from "./acceptTotal.ts";

const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

Deno.test("the repriced sentence matches none of the patterns a customer page reads as an expired login", () => {
  // Copied from production's my-quotes.html (origin/main), which tests every error with it.
  const SIGNED_OUT = /token|session|expired|sign.?in/i;
  assertEquals(SIGNED_OUT.test(REPRICED_SENTENCE), false, `the refusal would sign the customer out: ${REPRICED_SENTENCE}`);
  assertEquals(SIGNED_OUT.test("This quote was updated. Reload to see the current total before signing."), true,
    "the pattern no longer catches the sentence this replaced — re-copy it from my-quotes.html");
  const early = checkExpectedTotal(1, 13316.38);
  assertEquals(!early.ok && early.body.error, REPRICED_SENTENCE, "the early check answers with it");
  const late = promoteMiss({ lines: [{ qty: 1, amount: 1 }] }, { estimate_lines: { lines: [{ qty: 1, amount: 2 }] }, accepted_at: null, updated_at: "t" });
  assertEquals(late.kind === "repriced" && late.body.error, REPRICED_SENTENCE, "the promote-time refusal answers with it");
});

Deno.test("absent or null expectedTotalCents is today's behaviour: no check at all", () => {
  for (const total of [13316.38, 0, null]) {
    assertEquals(checkExpectedTotal(undefined, total), { ok: true }, `undefined vs ${total}`);
    assertEquals(checkExpectedTotal(null, total), { ok: true }, `null vs ${total}`);
  }
});

Deno.test("the total on screen is the total about to freeze: accepted, float dust included", () => {
  assertEquals(checkExpectedTotal(1331638, 13316.38), { ok: true });
  assertEquals(checkExpectedTotal(1122500, 11225), { ok: true });
  assertEquals(checkExpectedTotal(0, 0), { ok: true }, "a $0.00 quote is a total");
  // 0.1 + 0.2 style dust: the cents are compared, not the float.
  assertEquals(checkExpectedTotal(30, 0.1 + 0.2), { ok: true });
  assertEquals(checkExpectedTotal(90263, 902.625 + 0.005), { ok: true });
});

Deno.test("a re-priced quote is refused with 409 repriced and the current total", () => {
  assertEquals(checkExpectedTotal(1331638, 13390.1), {
    ok: false, status: 409,
    body: { error: REPRICED_SENTENCE, reason: "repriced", totalCents: 1339010 },
  });
  assertEquals(checkExpectedTotal(1331638, 13316.37).ok, false, "one cent is a different total");
  const gone = checkExpectedTotal(1331638, null);
  assertEquals([gone.ok, !gone.ok && gone.status, !gone.ok && gone.body], [false, 409, {
    error: REPRICED_SENTENCE, reason: "repriced", totalCents: null,
  }], "the page showed a total the quote no longer has");
});

Deno.test("a present value that is not whole cents is refused (400), never ignored", () => {
  for (const bad of ["1331638", 13316.38, NaN, Infinity, -Infinity, true, {}, [1331638], 2 ** 60]) {
    const r = checkExpectedTotal(bad, 13316.38);
    assertEquals([r.ok, !r.ok && r.status, !r.ok && r.body.reason], [false, 400, "bad_request"], JSON.stringify(bad));
  }
});

// ── promoteMiss: why the compare-and-swap promote matched no row ────────────────────────────
const SIGNED = {
  lines: [{ desc: "10x16 Urban", qty: 1, amount: 12416 }], discount: 0,
  tax: { rate: 0.0725, amount: 900.16, label: "Sales tax", source: "fallback", basis: "company" },
};

Deno.test("promoteMiss: the total moved after the read, so the acceptance is refused with the current total", () => {
  const verified = {
    ...SIGNED,
    tax: { rate: 0.0785, amount: 974.66, label: "Sales tax", source: "avalara", basis: "avalara", jurisdiction: "X" },
  };
  const miss = promoteMiss(SIGNED, { estimate_lines: verified, accepted_at: null, updated_at: "2026-09-17T10:00:01Z" });
  assertEquals(miss, {
    kind: "repriced", status: 409,
    body: { error: REPRICED_SENTENCE, reason: "repriced", totalCents: 1339066 },
  });
  // The same shape the early check answers with, so the page handles one refusal.
  const early = checkExpectedTotal(1331616, 13390.66);
  assertEquals(!early.ok && early.body, miss.kind === "repriced" && miss.body, "the two halves of the race answer differently");
});

Deno.test("promoteMiss: lines that changed without moving the total are a retry, not a refusal", () => {
  // A re-stamp at the same rate under another basis, a fresh resolvedAt, a relabel: the customer
  // is paying exactly the figure they accepted, so nothing is refused (review, 2026-09-17).
  const sameTotal = {
    ...SIGNED,
    tax: { ...SIGNED.tax, source: "avalara", basis: "avalara", label: "County tax", resolvedAt: "2026-09-17T10:00:01Z" },
  };
  assertEquals(promoteMiss(SIGNED, { estimate_lines: sameTotal, accepted_at: null, updated_at: "t2" }), { kind: "retry", updatedAt: "t2" });
  // Float dust in the stored amount is not a different total either: compared in whole cents.
  const dust = { ...SIGNED, tax: { ...SIGNED.tax, amount: 900.1600000001 } };
  assertEquals(promoteMiss(SIGNED, { estimate_lines: dust, accepted_at: null, updated_at: "t3" }).kind, "retry");
});

Deno.test("promoteMiss: one cent, or the total gone, is a re-price", () => {
  const cent = { ...SIGNED, tax: { ...SIGNED.tax, amount: 900.17 } };
  const miss = promoteMiss(SIGNED, { estimate_lines: cent, accepted_at: null, updated_at: "t2" });
  assertEquals([miss.kind, miss.kind === "repriced" && miss.body.totalCents], ["repriced", 1331617]);
  const noLines = promoteMiss(SIGNED, { estimate_lines: null, accepted_at: null, updated_at: "t2" });
  assertEquals([noLines.kind, noLines.kind === "repriced" && noLines.body.totalCents], ["repriced", null], "lines removed");
});

Deno.test("promoteMiss: the lines are the accepted ones, so an unrelated write moved updated_at: retry", () => {
  // A fresh read of the same stored jsonb parses to the same value.
  const reread = JSON.parse(JSON.stringify(SIGNED));
  assertEquals(promoteMiss(SIGNED, { estimate_lines: reread, accepted_at: null, updated_at: "2026-09-17T10:00:02Z" }),
    { kind: "retry", updatedAt: "2026-09-17T10:00:02Z" });
  assertEquals(promoteMiss(SIGNED, { estimate_lines: reread, accepted_at: null, updated_at: null }),
    { kind: "retry", updatedAt: null }, "a null updated_at swaps against null");
  assertEquals(promoteMiss(null, { estimate_lines: null, accepted_at: null, updated_at: "t" }),
    { kind: "retry", updatedAt: "t" }, "no lines then, no lines now");
});

Deno.test("promoteMiss: an accepted or vanished design stops, never refuses and never re-freezes", () => {
  const moved = { ...SIGNED, discount: 500 };
  assertEquals(promoteMiss(SIGNED, { estimate_lines: moved, accepted_at: "2026-09-17T10:00:00Z", updated_at: "t" }),
    { kind: "stop", why: "accepted" }, "accepted_at wins over changed lines");
  assertEquals(promoteMiss(SIGNED, null), { kind: "stop", why: "gone" });
  assertEquals(promoteMiss(SIGNED, undefined), { kind: "stop", why: "gone" });
});
