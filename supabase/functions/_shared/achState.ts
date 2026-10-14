// _shared/achState.ts — what a bank payment's gateway status MEANS to us, and what we tell
// the customer when it comes back.
//
// PURE on purpose. It runs in the pre-push gate on every push, which a one-time screenshot
// never would. This header used to say the UAT emulator only ever walks an ACH to "Accepted";
// Fiserv (CardPointe integrations), 2026-10-14, says the opposite: EVERY UAT bank payment comes
// back R03, and the return shows in the FUNDING data, not in settlestat. achFundingRead below is
// the reader for that answer (funded, returned, or a return it cannot read), settlementStatuses
// the one for settlestat's, and the tests are still the evidence for every shape we have not yet
// seen live.
//
// THE RULE EVERYTHING HERE SERVES: a bank payment is not money until it funds. `pending`
// counts toward NOTHING. Showing a customer "paid" on the day they submit, then discovering
// three days later that it bounced, is how a builder schedules a build against money that
// never arrived.

/** Our three states — the `payments.funding_state` domain from migration 174. */
export type FundingState = "settled" | "pending" | "returned";

/**
 * CardPointe `setlstat` / funding language → our state.
 *
 * Matched loosely and case-insensitively because this string is a third-party label that
 * has drifted before (the gateway alone returned `respproc: "RPCT"` from /auth and `"PPS"`
 * from the /void of that same transaction on 2026-09-01). An unrecognised status returns
 * null, and null means LEAVE IT PENDING — never guess a bank payment into being money.
 */
export function fundingStateFromSetlstat(setlstat: unknown): FundingState | null {
  const s = String(setlstat ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/reject|return|nsf|failed|declin/.test(s)) return "returned";
  if (/accept|funded|settled|complete|deposited/.test(s)) return "settled";
  if (/queue|pending|batch|in.?process|originat/.test(s)) return "pending";
  return null;
}

/**
 * NACHA return codes we have a specific sentence for. Everything else falls through to the
 * generic line — the customer does not need a code, they need to know whether they owe
 * money and whether anything left their account.
 *
 * Deliberately never says "your account had insufficient funds" out loud to a third party:
 * the builder sees the code, the customer sees a neutral sentence. A shed shopper reading
 * "insufficient funds" in a portal their spouse can also open is a support call at best.
 */
const RETURN_TEXT: Record<string, string> = {
  R01: "Your bank didn't complete the transfer. Nothing was taken from your account.",
  R02: "That account is closed, so the transfer didn't go through.",
  R03: "Your bank couldn't find that account — check the numbers and try again.",
  R04: "That account number wasn't valid, so the transfer didn't go through.",
  R07: "Your bank stopped the transfer at your request.",
  R08: "Your bank placed a stop payment on the transfer.",
  R09: "Your bank didn't complete the transfer. Nothing was taken from your account.",
  R10: "Your bank flagged the transfer as unauthorised and sent it back.",
  R16: "That account is frozen, so the transfer didn't go through.",
  R20: "That account can't accept this kind of transfer.",
  R29: "Your bank needs authorisation on file before it will allow this transfer.",
};

/** What the CUSTOMER reads. Never a raw code, never a bank's own wording. */
export function returnTextForCustomer(code: unknown): string {
  const c = String(code ?? "").trim().toUpperCase();
  return RETURN_TEXT[c] ??
    "Your bank sent the transfer back, so it didn't go through. Nothing was taken from your account.";
}

/** What the BUILDER reads — the code IS useful to them, because they may have to chase it. */
export function returnTextForBuilder(code: unknown): string {
  const c = String(code ?? "").trim().toUpperCase();
  const detail = RETURN_TEXT[c];
  return c
    ? `Bank transfer returned (${c})${detail ? " — " + detail.replace(/^Your bank /, "the bank ") : ""}`
    : "Bank transfer returned by the customer's bank";
}

/**
 * Is this return worth a retry by the customer, or is the account itself the problem?
 * Drives whether the pay button comes back with "try again" or "use a different account".
 */
export function returnIsRetryable(code: unknown): boolean {
  const c = String(code ?? "").trim().toUpperCase();
  // Closed / invalid / frozen / unauthorised accounts will fail again with the same details.
  return !["R02", "R03", "R04", "R10", "R16", "R20", "R29"].includes(c);
}

/**
 * A returned ACH voids its payment row — it never deletes it. Two reasons, both learned
 * elsewhere in this codebase: the evidence of what happened is what matters in a dispute,
 * and `balOf` already skips voided rows, so voiding restores the balance arithmetic for
 * free with no portal change.
 *
 * ⚠️ Voiding does NOT release the inventory unit. Migration 105 states this outright — a
 * payment voided later does not un-sell the building. A returned transfer is a collections
 * problem, not an un-sale, and releasing a unit is a separate audited act.
 */
export function returnedPaymentPatch(code: unknown, nowIso: string) {
  // ONLY A NACHA CODE IS STORED (2026-10-14). Reconcile used to hand this the settlestat status
  // word, so return_code read "REJECTED" and the builder's reason "Bank transfer returned
  // (REJECTED)". A word that is not an R-code is no code: return_code NULL and the generic reason.
  const c = achReturnCode(code);
  return {
    funding_state: "returned" as const,
    funding_updated_at: nowIso,
    return_code: c,
    voided_at: nowIso,
    void_reason: returnTextForBuilder(c),
  };
}

/** A NACHA return code ("R" and two digits, e.g. "R03"), upper-cased, or null for anything else. */
export function achReturnCode(v: unknown): string | null {
  const c = String(v ?? "").trim().toUpperCase();
  return /^R[0-9]{2}$/.test(c) ? c : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Reading a return out of the /funding answer.
//
// Fiserv (CardPointe integrations), 2026-10-14: every UAT bank payment returns R03 and the return
// is visible in the FUNDING data. She did not say which list or field holds it, and no funding
// answer has been seen live, so this reader is deliberately NARROW: it calls something a return
// only when ONE object carries BOTH this payment's exact retref AND an R-code, in a field whose
// name says return, reason or code. A code on another object, a retref with no code, and a code-
// like value that is not R plus two digits are all "not a return", and a bank payment stays
// pending rather than being un-paid on a guess. fundingAnswerShape is how we learn the real shape
// without logging a value, and achFundingRead's `return_unread` is how we learn where a return we
// could not read sits (key names only).
// ─────────────────────────────────────────────────────────────────────────────────────

/** How far the walk goes. A funding day is a few lists of a few hundred rows; anything deeper or
 *  bigger than this is not an answer we read. settlestat's answer is walked the same way. */
const FUNDING_WALK_MAX_DEPTH = 8;
const FUNDING_WALK_MAX_NODES = 20000;

type Walked = { obj: Record<string, unknown>; path: string };

/** Every plain object in a gateway answer, with its key path ("txns[]", "fundings[].detail"). */
function answerObjects(answer: unknown): Walked[] {
  const out: Walked[] = [];
  const stack: { v: unknown; path: string; depth: number }[] = [{ v: answer, path: "", depth: 0 }];
  let nodes = 0;
  while (stack.length && nodes < FUNDING_WALK_MAX_NODES) {
    const { v, path, depth } = stack.pop()!;
    nodes++;
    if (!v || typeof v !== "object" || depth > FUNDING_WALK_MAX_DEPTH) continue;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], path: `${path}[]`, depth: depth + 1 });
      continue;
    }
    const obj = v as Record<string, unknown>;
    out.push({ obj, path });
    const keys = Object.keys(obj);
    for (let i = keys.length - 1; i >= 0; i--) {
      const child = obj[keys[i]];
      if (child && typeof child === "object") {
        stack.push({ v: child, path: path ? `${path}.${keyLabel(keys[i])}` : keyLabel(keys[i]), depth: depth + 1 });
      }
    }
  }
  return out;
}

/** A key as it may appear in a log: digit runs masked (a key could itself be a reference or an
 *  account number), capped. Never a value. */
function keyLabel(k: string): string {
  return k.replace(/[^\w.-]/g, "_").replace(/[0-9]{4,}/g, "#").slice(0, 40);
}

/** The text of a scalar, for comparing; objects and arrays have none. */
function scalarText(v: unknown): string | null {
  return typeof v === "string" || typeof v === "number" ? String(v).trim() : null;
}


/** Whether this object names the payment: a field whose name contains "retref", equal to it exactly. */
function carriesRetref(obj: Record<string, unknown>, want: string): boolean {
  return Object.keys(obj).some((k) => /retref/i.test(k) && scalarText(obj[k]) === want);
}

/**
 * The NACHA return code /funding reports for THIS payment, or null.
 *
 * A return only when one object holds BOTH a field whose name contains "retref" equal to this
 * payment's retref exactly, AND a field whose name mentions return, reason or code whose value STARTS
 * with R plus two digits, alone or followed by words ("R03", "R03 - No Account/Unable to Locate").
 * Anything else is not a return. Never throws.
 */
export function achReturnFromFunding(answer: unknown, retref: unknown): string | null {
  const want = scalarText(retref);
  if (!want) return null;
  for (const { obj } of answerObjects(answer)) {
    if (!carriesRetref(obj, want)) continue;
    for (const k of Object.keys(obj)) {
      if (!/return|reason|code/i.test(k)) continue;
      const v = scalarText(obj[k]);
      const m = v ? /^(R[0-9]{2})(?![0-9A-Za-z])/.exec(v) : null;
      if (m) return m[1];
    }
  }
  return null;
}

/** What one /funding answer says about ONE bank payment (achFundingRead). */
export type FundingRead =
  | { kind: "returned"; code: string }
  | { kind: "return_unread"; keys: string[] }
  | { kind: "funded" }
  | { kind: "listed" }
  | { kind: "absent" };

// What a row about THIS payment must not carry before it is read as funded. Any of these on an
// object holding its retref is a sign of a return; one we cannot turn into a code leaves the payment
// as it is and says where the sign sat (return_unread).
/** An R-code anywhere in a value ("R03", "R03 - No account", "PPD R03"). */
const RCODE_LIKE = /\bR[0-9]{2}\b/i;
/** A return in words. */
const RETURN_WORD = /return|reject|revers|chargeback|\bnsf\b|unpaid|dishono/i;
/** A field whose NAME is about a return, holding anything but a "no" ("reversalflag": "N" is a no). */
const RETURN_KEY = /return|revers|reject|chargeback/i;
const NO_VALUE = /^(0+|n|no|none|false|null|-)$/i;
/** A row filed under a list named for returns or adjustments. */
const RETURN_PATH = /adjust|return|reject|revers|chargeback/i;
/** A row about the payment that is not money in: still moving, held, or money going back out. */
const NOT_YET_WORD = /\bpending\b|\bqueued?\b|\bon.?hold\b|\bheld\b|in.?process|\brefund|\bvoid/i;

/**
 * What /funding says about this one bank payment (by its exact retref), the most serious first:
 *
 *   returned       achReturnFromFunding read an R-code for it
 *   return_unread  an object holding its retref also holds a sign of a return that is not a code
 *                  we read: an R-code under a field we do not accept or with words after it
 *                  ("status": "R03", "returncode": "R03 - No account"), a word like Returned or
 *                  Rejected, a return or reversal field that is not a "no", a negative amount, or a
 *                  row under a list named for returns or adjustments. Nothing is decided on it, and
 *                  `keys` (field names, digit runs masked, never a value) is how the first live one
 *                  tells us where the code really sits
 *   funded         objects hold its retref and none of them says any of that, nor pending, on hold,
 *                  refund or void: the money is in
 *   listed         it is there, but only as one of those "not yet" rows
 *   absent         nowhere in the answer
 *
 * Fiserv (CardPointe integrations), 2026-10-14, named the funding data as where a bank payment's
 * fate shows, so `funded` is what moves a payment from pending to settled (portal-payments
 * reconcile). Never throws.
 */
export function achFundingRead(answer: unknown, retref: unknown): FundingRead {
  const want = scalarText(retref);
  if (!want) return { kind: "absent" };
  const code = achReturnFromFunding(answer, want);
  if (code) return { kind: "returned", code };
  let seen = false;
  let notYet = false;
  const keys = new Set<string>();
  for (const { obj, path } of answerObjects(answer)) {
    if (!carriesRetref(obj, want)) continue;
    seen = true;
    if (path && RETURN_PATH.test(path)) keys.add(path.slice(0, 120));
    for (const k of Object.keys(obj)) {
      if (/retref/i.test(k)) continue;
      const v = scalarText(obj[k]);
      if (!v) continue;
      const returnLike = RCODE_LIKE.test(v) || RETURN_WORD.test(v) ||
        (RETURN_KEY.test(k) && !NO_VALUE.test(v)) ||
        (/amount|amt/i.test(k) && Number(v) < 0);
      if (returnLike) keys.add(keyLabel(k));
      else if (NOT_YET_WORD.test(v)) notYet = true;
    }
  }
  if (!seen) return { kind: "absent" };
  if (keys.size) return { kind: "return_unread", keys: [...keys].slice(0, 10) };
  return notYet ? { kind: "listed" } : { kind: "funded" };
}

/** The lists a funding day carries that are not transactions: its deposit summaries and its
 *  adjustments (fees, mostly). Rows there with no retref are what a fee-only day looks like. */
const SUMMARY_LIST = /^(fundings?|adjustments?|fees?|deposits?)$/i;

/**
 * Whether achFundingRead can read this answer at all, and its key paths for a log line.
 *
 * Recognised: an answer that carries retrefs (some object has a `retref`-named field holding a
 * value), or one with no transaction rows in it: an empty list, an object whose lists are all empty
 * (a day with nothing funded), or one whose only rows sit in its summary lists (fundings,
 * adjustments, fees, deposits: a day with a fee and no sale). Anything else (a bare string, an object
 * of scalars only, rows in any other list with no retref anywhere) is a shape we do not know, and
 * `keyPaths` says what it looked like: key names and nesting only, never a value, digit runs masked,
 * capped at 60 paths.
 */
/**
 * The gateway's own refusal, when a settlestat or funding answer is ONLY that: one object of
 * scalars, with no lists or nested objects, carrying an error-message field (errormsg, resptext,
 * message, error). The first live funding read on 2026-10-14 came back exactly so ({errormsg}), and a
 * key-paths-only log could not say what it said. The text is the gateway's words about our request,
 * not card or bank data; runs of five or more digits are cut to their last four anyway, and it is
 * capped at 160 characters. Anything else (a data answer, an empty one, a non-object) is null.
 */
export function gatewayErrorText(answer: unknown): string | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const obj = answer as Record<string, unknown>;
  if (Object.values(obj).some((v) => v !== null && typeof v === "object")) return null;
  for (const k of Object.keys(obj)) {
    if (!/^(errormsg|errormessage|error|message|resptext)$/i.test(k)) continue;
    const v = typeof obj[k] === "string" ? (obj[k] as string).trim() : "";
    if (v) return v.replace(/[0-9]{5,}/g, (run) => "…" + run.slice(-4)).slice(0, 160);
  }
  return null;
}

export function fundingAnswerShape(answer: unknown): { recognised: boolean; keyPaths: string[] } {
  if (!answer || typeof answer !== "object") {
    return { recognised: false, keyPaths: [`(${answer === null ? "null" : typeof answer})`] };
  }
  const walked = answerObjects(answer);
  const paths = new Set<string>();
  let hasRetref = false;
  // A list anywhere, and whether any list but a summary one has something in it. A day with nothing
  // funded is lists that are all empty; an object with no list at all (a bare error sentence) is
  // not that.
  let hasLists = Array.isArray(answer);
  let hasRows = Array.isArray(answer) && answer.length > 0;
  for (const { obj, path } of walked) {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (/retref/i.test(k) && scalarText(v)) hasRetref = true;
      if (Array.isArray(v)) {
        hasLists = true;
        if (v.length > 0 && !SUMMARY_LIST.test(k)) hasRows = true;
      }
      if (paths.size < 60) paths.add((path ? `${path}.${keyLabel(k)}` : keyLabel(k)).slice(0, 120));
    }
  }
  const empty = !hasRows && (hasLists || walked.every(({ obj }) => Object.keys(obj).length === 0));
  return { recognised: hasRetref || empty, keyPaths: [...paths] };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Reading settlement statuses out of the /settlestat answer.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Every retref -> status word a settlestat answer carries, whatever it is wrapped in.
 *
 * Reconcile read `txns` off the top level of the answer until 2026-10-14. A copy of Fiserv's API
 * reference says settlestat answers with a LIST (of batches that each carry their own txns, or of
 * rows that each carry retref and setlstat), and a list has no top-level `txns`, so on such an
 * answer that read found nothing, every time. This walks the answer instead: any object holding
 * both a `retref` and a `setlstat` (or `status`) is one transaction's status, at any depth. The
 * same retref twice keeps a word that reads as a return over any other, so a later "Accepted" can
 * never hide a "Rejected". Never throws.
 */
export function settlementStatuses(answer: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const { obj } of answerObjects(answer)) {
    const rr = scalarText(obj.retref);
    const st = scalarText(obj.setlstat ?? obj.status);
    if (!rr || st === null) continue;
    const prior = out.get(rr);
    if (prior !== undefined && fundingStateFromSetlstat(prior) === "returned") continue;
    out.set(rr, st);
  }
  return out;
}
