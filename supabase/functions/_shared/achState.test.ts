// Unit tests for ACH state (migration 174).
//
// WHY THESE EXIST, and they are the whole reason achState.ts is a pure module. They run in
// the pre-push gate on every push forever, which a one-time screenshot never would. This
// header used to say the UAT emulator never produces a return; Fiserv (CardPointe
// integrations), 2026-10-14, says every UAT bank payment comes back R03 and the return shows in
// the FUNDING data. Nobody has seen a funding answer yet, so the funding shapes below are
// invented, and they pin how NARROW the reader is: a return only when one object holds both
// this payment's retref and an R-code, and funded only when nothing on its rows looks like a return.
//
// The rule everything here serves: a bank payment is not money until it funds.
//
// Dependency-free (no jsr:/npm: imports), the house rule for _shared tests.

import {
  achFundingRead,
  achReturnCode,
  achReturnFromFunding,
  fundingAnswerShape,
  fundingStateFromSetlstat,
  returnedPaymentPatch,
  returnIsRetryable,
  returnTextForBuilder,
  returnTextForCustomer,
  settlementStatuses,
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

Deno.test("a settlestat status WORD is never stored as the return code", () => {
  // Reconcile handed returnedPaymentPatch the settlestat word until 2026-10-14, so return_code read
  // "REJECTED" and the builder's reason "Bank transfer returned (REJECTED)".
  for (const word of ["Rejected", "REJECTED", "Returned by bank", "NSF", "R3", "R003"]) {
    const patch = returnedPaymentPatch(word, "2026-10-14T12:00:00.000Z");
    check(`${word}: no code`, patch.return_code === null, String(patch.return_code));
    check(`${word}: generic reason`, !String(patch.void_reason).includes(word), String(patch.void_reason));
    check(`${word}: still returned and voided`, patch.funding_state === "returned" && patch.voided_at !== null);
  }
  check("an R-code is kept, upper-cased", returnedPaymentPatch(" r03 ", "2026-10-14T12:00:00.000Z").return_code === "R03");
  check("achReturnCode R03", achReturnCode("R03") === "R03");
  check("achReturnCode rejects a word", achReturnCode("Rejected") === null);
  check("achReturnCode rejects nothing", achReturnCode(null) === null && achReturnCode(undefined) === null);
});

// ── Reading a return out of /funding. Every shape here is INVENTED (none seen live yet). ─────────
const RETREF = "100200300123";

Deno.test("funding: ONE object with this payment's exact retref AND an R-code is a return", () => {
  const answer = {
    fundingdate: "20261014",
    txns: [
      { retref: "100200300999", type: "SALE", amount: "50.00" },
      { retref: RETREF, type: "RETURN", returncode: "R03", amount: "-1854.00" },
    ],
  };
  check("R03", achReturnFromFunding(answer, RETREF) === "R03", String(achReturnFromFunding(answer, RETREF)));
  // Other field names that mention a reason or a code, and a retref field under another name.
  check("reasonCode", achReturnFromFunding([{ origRetref: RETREF, reasonCode: "R01" }], RETREF) === "R01");
  check("achreturn", achReturnFromFunding({ adjustments: [{ retref: RETREF, achreturn: "R10" }] }, RETREF) === "R10");
  check("deep but the same object", achReturnFromFunding({ a: { b: { rows: [{ retref: RETREF, code: "R16" }] } } }, RETREF) === "R16");
  // A number retref compares as its text.
  check("number retref", achReturnFromFunding({ txns: [{ retref: Number(RETREF), returnCode: "R02" }] }, RETREF) === "R02");
});

Deno.test("funding: the retref on one object and the code on ANOTHER is not a return", () => {
  const answer = {
    txns: [{ retref: RETREF, type: "SALE", amount: "1854.00" }],
    returns: [{ retref: "100200300999", returncode: "R03" }],
    summary: { reasoncode: "R03" },
  };
  check("not a return", achReturnFromFunding(answer, RETREF) === null);
  // Nor a code on a PARENT of the object that carries the retref.
  check("parent code", achReturnFromFunding({ returncode: "R03", txns: [{ retref: RETREF }] }, RETREF) === null);
});

Deno.test("funding: a code with no retref, or a retref with no code, is not a return", () => {
  check("code alone", achReturnFromFunding({ txns: [{ returncode: "R03", amount: "1854.00" }] }, RETREF) === null);
  check("retref alone", achReturnFromFunding({ txns: [{ retref: RETREF, status: "Funded" }] }, RETREF) === null);
  // A retref that only CONTAINS ours, or ours with something added, is not ours.
  check("not exact (longer)", achReturnFromFunding([{ retref: RETREF + "9", returncode: "R03" }], RETREF) === null);
  check("not exact (shorter)", achReturnFromFunding([{ retref: RETREF.slice(1), returncode: "R03" }], RETREF) === null);
});

Deno.test("funding: look-alike values that are not R plus two digits are not a return", () => {
  for (const v of ["R3", "R003", "r03", "RO3", "AR03", "R03X", "Rejected", "R", "03", "R03 - No account", 3]) {
    check(`${String(v)}`, achReturnFromFunding([{ retref: RETREF, returncode: v }], RETREF) === null, String(v));
  }
  // An R-code in a field whose name says nothing about a return, reason or code.
  check("wrong field name", achReturnFromFunding([{ retref: RETREF, status: "R03", note: "R03" }], RETREF) === null);
});

Deno.test("funding: the guards. Nothing to match, nothing that walks, nothing that throws", () => {
  check("blank retref never matches", achReturnFromFunding([{ retref: "", returncode: "R03" }], "") === null);
  check("null retref", achReturnFromFunding([{ retref: RETREF, returncode: "R03" }], null) === null);
  for (const a of [null, undefined, "R03", 42, true, [], {}]) {
    check(`answer ${JSON.stringify(a)}`, achReturnFromFunding(a, RETREF) === null);
  }
  // Too deep is not read (the walk stops at its depth limit), and a cycle cannot loop forever.
  let deep: Record<string, unknown> = { retref: RETREF, returncode: "R03" };
  for (let i = 0; i < 20; i++) deep = { next: deep };
  check("beyond the depth limit", achReturnFromFunding(deep, RETREF) === null);
  const loop: Record<string, unknown> = { txns: [] };
  (loop.txns as unknown[]).push(loop);
  check("a cycle ends", achReturnFromFunding(loop, RETREF) === null);
});

Deno.test("fundingAnswerShape: retrefs or an empty day are recognised; anything else gives key paths, never a value", () => {
  check("rows with retrefs", fundingAnswerShape({ txns: [{ retref: RETREF, amount: "1.00" }] }).recognised);
  check("a bare list of rows", fundingAnswerShape([{ retref: RETREF }]).recognised);
  check("empty list", fundingAnswerShape([]).recognised);
  check("an empty day", fundingAnswerShape({ merchid: "x", fundingdate: "20261014", fundings: [], txns: [] }).recognised);
  check("an empty object", fundingAnswerShape({}).recognised);
  check("nested empty lists", fundingAnswerShape({ data: { txns: [] } }).recognised);

  const odd = { resptext: "Invalid date", detail: { acct: "9876543210", rows: 3 } };
  const s = fundingAnswerShape(odd);
  check("an object of scalars is NOT recognised", !s.recognised);
  check("its key paths", JSON.stringify([...s.keyPaths].sort()) === JSON.stringify(["detail", "detail.acct", "detail.rows", "resptext"]), JSON.stringify(s.keyPaths));
  check("never a value", !JSON.stringify(s).includes("Invalid") && !JSON.stringify(s).includes("9876543210"), JSON.stringify(s));

  // A fee-only day: a deposit summary and an adjustment, no transaction. Recognised (2026-10-14): it
  // used to file an "unrecognised" row for an ordinary day.
  check("a fee-only day is recognised",
    fundingAnswerShape({ fundings: [{ fundingid: 7, netsales: "10.00" }], adjustments: [{ type: "FEE", amount: "-1.00" }], txns: [] }).recognised);
  const rowsNoRetref = fundingAnswerShape({ fundings: [{ fundingid: 7 }], txns: [{ fundingid: 7, netsales: "10.00" }] });
  check("transaction rows with no retref anywhere are NOT recognised", !rowsNoRetref.recognised);
  check("their paths, list items as []", rowsNoRetref.keyPaths.includes("txns[].fundingid") && rowsNoRetref.keyPaths.includes("fundings"),
    JSON.stringify(rowsNoRetref.keyPaths));
  check("rows in a list of another name are NOT recognised either", !fundingAnswerShape({ data: [{ ref: "x" }] }).recognised);
  check("a bare list of rows with no retref is NOT recognised", !fundingAnswerShape([{ ref: "x" }]).recognised);

  check("a bare string is not recognised", !fundingAnswerShape("R03").recognised && fundingAnswerShape("R03").keyPaths[0] === "(string)");
  check("null", fundingAnswerShape(null).keyPaths[0] === "(null)");
  // A key that is itself a long number (a reference, an account) is masked.
  const keyed = fundingAnswerShape({ "123456789012": { amount: "1.00" } });
  check("digit runs in keys are masked", !JSON.stringify(keyed).includes("123456789012") && keyed.keyPaths.includes("#"), JSON.stringify(keyed));
  // Capped.
  const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]));
  check("at most 60 paths", fundingAnswerShape(wide).keyPaths.length === 60);
});

// ── achFundingRead: funded, returned, a return it cannot read, or nothing (2026-10-14) ───────────
// Fiserv (CardPointe integrations), 2026-10-14, named the funding data as where a bank payment's
// fate shows, so a payment listed CLEANLY there is what moves it out of pending. "Cleanly" is the
// whole question, and every shape below is invented.

Deno.test("achFundingRead: listed with nothing else on its row is FUNDED", () => {
  const day = { fundingdate: "20261014", txns: [{ retref: RETREF, type: "SALE", status: "Funded", amount: "1854.00", reversalflag: "N" }] };
  check("funded", achFundingRead(day, RETREF).kind === "funded", JSON.stringify(achFundingRead(day, RETREF)));
  check("a number retref", achFundingRead({ txns: [{ retref: Number(RETREF), amount: "1.00" }] }, RETREF).kind === "funded");
  check("absent", achFundingRead({ txns: [{ retref: "100200300999", amount: "1.00" }] }, RETREF).kind === "absent");
  check("an empty day", achFundingRead({ txns: [] }, RETREF).kind === "absent");
  check("no retref to look for", achFundingRead(day, "").kind === "absent" && achFundingRead(day, null).kind === "absent");
});

Deno.test("achFundingRead: an R-code it reads is RETURNED, and wins over anything else on the day", () => {
  const day = { txns: [{ retref: RETREF, type: "SALE" }, { retref: RETREF, type: "RETURN", returncode: "R03" }] };
  const r = achFundingRead(day, RETREF);
  check("returned R03", r.kind === "returned" && r.code === "R03", JSON.stringify(r));
});

Deno.test("achFundingRead: a sign of a return it cannot read is RETURN_UNREAD, with field names only", () => {
  // The finding: an R03 under a field the narrow reader does not take, or with words after it, used
  // to read as "not a return" AND as funded-looking. Now it holds the payment and names the field.
  const cases: [string, unknown, string][] = [
    ["status R03", { txns: [{ retref: RETREF, status: "R03" }] }, "status"],
    ["code with words", { txns: [{ retref: RETREF, returncode: "R03 - No Account/Unable to Locate" }] }, "returncode"],
    ["a word", { txns: [{ retref: RETREF, type: "ACH Return" }] }, "type"],
    ["rejected", { txns: [{ retref: RETREF, setlstat: "Rejected" }] }, "setlstat"],
    ["a reversal flag that is a yes", { txns: [{ retref: RETREF, reversalflag: "Y" }] }, "reversalflag"],
    ["a negative amount", { txns: [{ retref: RETREF, amount: "-1854.00" }] }, "amount"],
    ["filed under adjustments", { adjustments: [{ retref: RETREF, amount: "1854.00" }] }, "adjustments[]"],
  ];
  for (const [label, answer, key] of cases) {
    const r = achFundingRead(answer, RETREF);
    check(`${label}: unread`, r.kind === "return_unread", JSON.stringify(r));
    if (r.kind !== "return_unread") continue;
    check(`${label}: names ${key}`, r.keys.includes(key), JSON.stringify(r.keys));
    check(`${label}: never a value`, !JSON.stringify(r).includes("R03") && !JSON.stringify(r).includes("1854") && !JSON.stringify(r).includes(RETREF),
      JSON.stringify(r));
  }
  // The retref field itself is never the sign, and neither is a "no".
  check("reversalflag N is a no", achFundingRead({ txns: [{ retref: RETREF, reversalflag: "N", returncode: "" }] }, RETREF).kind === "funded");
  // A digit-run key is masked, as in fundingAnswerShape.
  const masked = achFundingRead({ txns: [{ retref: RETREF, "123456789012": "R03" }] }, RETREF);
  check("masked key", masked.kind === "return_unread" && !JSON.stringify(masked).includes("123456789012"), JSON.stringify(masked));
});

Deno.test("achFundingRead: listed as not-yet money (pending, held, refund, void) is LISTED, never funded", () => {
  for (const v of ["Pending", "Queued", "On Hold", "In Process", "Refund", "VOID"]) {
    const r = achFundingRead({ txns: [{ retref: RETREF, status: v }] }, RETREF);
    check(v, r.kind === "listed", JSON.stringify(r));
  }
  // A return sign on one row and a clean row beside it: the sign wins.
  const both = achFundingRead({ txns: [{ retref: RETREF, type: "SALE" }, { retref: RETREF, status: "R03" }] }, RETREF);
  check("a sign beside a clean row", both.kind === "return_unread", JSON.stringify(both));
});

Deno.test("achFundingRead: the guards. Nothing that walks, nothing that throws", () => {
  for (const a of [null, undefined, "R03", 42, true, [], {}]) {
    check(`answer ${JSON.stringify(a)}`, achFundingRead(a, RETREF).kind === "absent");
  }
  const loop: Record<string, unknown> = { txns: [] };
  (loop.txns as unknown[]).push(loop);
  check("a cycle ends", achFundingRead(loop, RETREF).kind === "absent");
});

// ── settlementStatuses: settlestat's answer, whatever it is wrapped in (2026-10-14) ──────────────
Deno.test("settlementStatuses: a LIST of batches, a list of rows and one object are all read", () => {
  // Reconcile used to read `txns` off the top level, so a list (what a copy of Fiserv's reference
  // says settlestat answers) read as nothing at all.
  const batches = [
    { merchid: "x", hoststat: "GB", txns: [{ retref: "rt-1", setlstat: "Accepted" }, { retref: "rt-2", setlstat: "Queued for Capture" }] },
    { merchid: "x", txns: [{ retref: "rt-3", setlstat: "Rejected" }] },
  ];
  const a = settlementStatuses(batches);
  check("batches", a.get("rt-1") === "Accepted" && a.get("rt-2") === "Queued for Capture" && a.get("rt-3") === "Rejected", JSON.stringify([...a]));
  const rows = settlementStatuses([{ merchid: "x", retref: "rt-1", setlstat: "Accepted", amount: "1.00" }]);
  check("flat rows", rows.get("rt-1") === "Accepted", JSON.stringify([...rows]));
  const one = settlementStatuses({ txns: [{ retref: "rt-1", status: "Accepted" }] });
  check("one object, status for setlstat", one.get("rt-1") === "Accepted", JSON.stringify([...one]));
  check("a batch has no retref, so it is no row", !settlementStatuses(batches).has(""));
});

Deno.test("settlementStatuses: a return word is never hidden by a later word for the same retref", () => {
  const m = settlementStatuses([{ txns: [{ retref: "rt-1", setlstat: "Rejected" }] }, { txns: [{ retref: "rt-1", setlstat: "Accepted" }] }]);
  check("rejected stands", m.get("rt-1") === "Rejected", JSON.stringify([...m]));
  for (const a of [null, undefined, "x", 3, [], {}]) check(`answer ${JSON.stringify(a)}`, settlementStatuses(a).size === 0);
});
