// Unit tests for ACH state (migration 174).
//
// WHY THESE EXIST, and they are the whole reason achState.ts is a pure module. The UAT
// emulator only ever walks a bank payment to "Accepted" — it will NOT produce a return —
// so no amount of sandbox testing can demonstrate that the returned path works. These
// tests are the compensating evidence, and unlike a one-time screenshot they run in the
// pre-push gate on every push forever.
//
// The rule everything here serves: a bank payment is not money until it funds.
//
// Dependency-free (no jsr:/npm: imports), the house rule for _shared tests.

import {
  fundingStateFromSetlstat,
  returnedPaymentPatch,
  returnIsRetryable,
  returnTextForBuilder,
  returnTextForCustomer,
} from "./achState.ts";

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

Deno.test("the documented ACH ladder maps to our three states", () => {
  // Fiserv's own sequence: Queued for Capture -> Accepted, or Rejected within ~3 days.
  check("queued", fundingStateFromSetlstat("Queued for Capture") === "pending");
  check("accepted", fundingStateFromSetlstat("Accepted") === "settled");
  check("rejected", fundingStateFromSetlstat("Rejected") === "returned");
});

Deno.test("matching is case- and wording-insensitive", () => {
  // This string is a third-party label that has already drifted once on this gateway: one
  // live transaction returned respproc "RPCT" from /auth and "PPS" from its own /void.
  check("upper", fundingStateFromSetlstat("ACCEPTED") === "settled");
  check("lower", fundingStateFromSetlstat("rejected") === "returned");
  check("funded", fundingStateFromSetlstat("Funded") === "settled");
  check("in process", fundingStateFromSetlstat("In Process") === "pending");
  check("returned", fundingStateFromSetlstat("Returned by bank") === "returned");
  check("nsf", fundingStateFromSetlstat("NSF") === "returned");
});

Deno.test("an UNRECOGNISED status returns null — never guess a bank payment into money", () => {
  // null means LEAVE IT PENDING. The reconcile loop treats it as "no news", which is the
  // only safe reading: settling on a status we do not understand credits a builder for
  // money that may never arrive.
  check("gibberish", fundingStateFromSetlstat("Schrodinger") === null);
  check("empty", fundingStateFromSetlstat("") === null);
  check("null", fundingStateFromSetlstat(null) === null);
  check("undefined", fundingStateFromSetlstat(undefined) === null);
});

Deno.test("every known return code has a customer sentence, and none of them leak the code", () => {
  for (const code of ["R01", "R02", "R03", "R04", "R07", "R08", "R09", "R10", "R16", "R20", "R29"]) {
    const t = returnTextForCustomer(code);
    check(`${code} has words`, t.length > 20, t);
    check(`${code} hides the code`, !t.includes(code), t);
    check(`${code} ends in a full stop`, t.trim().endsWith("."), t);
  }
});

Deno.test("an unknown return code still gets an honest sentence", () => {
  const t = returnTextForCustomer("R99");
  check("has words", t.length > 20, t);
  check("says nothing was taken", /nothing was taken/i.test(t), t);
});

Deno.test("R01 does not say 'insufficient funds' to the customer", () => {
  // A shed shopper reads this in a portal their spouse can also open. The builder gets the
  // code and can chase it; the customer gets a neutral sentence.
  const t = returnTextForCustomer("R01");
  // \b on NSF deliberately: a bare /nsf/i also matches "tra-nsf-er", which is in almost
  // every sentence this module produces.
  check("neutral", !/insufficient|\bnsf\b/i.test(t), t);
  check("builder DOES get the code", returnTextForBuilder("R01").includes("R01"), returnTextForBuilder("R01"));
});

Deno.test("retryable vs account-is-the-problem is distinguished", () => {
  // Drives whether the pay button comes back as "try again" or "use a different account".
  check("R01 retryable", returnIsRetryable("R01") === true);
  check("R09 retryable", returnIsRetryable("R09") === true);
  check("R02 closed account is not", returnIsRetryable("R02") === false);
  check("R03 no account is not", returnIsRetryable("R03") === false);
  check("R10 unauthorised is not", returnIsRetryable("R10") === false);
  check("R16 frozen is not", returnIsRetryable("R16") === false);
  check("unknown defaults to retryable", returnIsRetryable("R99") === true);
});

Deno.test("a returned payment is VOIDED, not deleted — and the balance reopens for free", () => {
  const now = "2026-09-04T12:00:00.000Z";
  const patch = returnedPaymentPatch("R01", now);
  check("state", patch.funding_state === "returned");
  check("code kept", patch.return_code === "R01");
  // balOf already skips voided rows, so voiding restores the balance arithmetic with no
  // portal change at all. Keeping the row is what preserves the evidence of what happened.
  check("voided", patch.voided_at === now);
  check("reason names the code", String(patch.void_reason).includes("R01"), String(patch.void_reason));
  check("stamped", patch.funding_updated_at === now);
});

Deno.test("a blank return code still produces a usable patch", () => {
  const patch = returnedPaymentPatch("", "2026-09-04T12:00:00.000Z");
  check("state", patch.funding_state === "returned");
  check("null code rather than empty string", patch.return_code === null);
  check("reason still readable", String(patch.void_reason).length > 10, String(patch.void_reason));
});
