// _shared/achState.ts — what a bank payment's gateway status MEANS to us, and what we tell
// the customer when it comes back.
//
// PURE on purpose. It runs in the pre-push gate on every push, which a one-time screenshot
// never would. This header used to say the UAT emulator only ever walks an ACH to "Accepted";
// Fiserv (CardPointe integrations), 2026-10-14, says the opposite: EVERY UAT bank payment comes
// back R03, and the return shows in the FUNDING data, not in settlestat. achReturnFromFunding
// below is the reader for that answer, and the tests are still the evidence for every shape we
// have not yet seen live.
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
// without logging a value.
// ─────────────────────────────────────────────────────────────────────────────────────

/** How far the walk goes. A funding day is a few lists of a few hundred rows; anything deeper or
 *  bigger than this is not an answer we read. */
const FUNDING_WALK_MAX_DEPTH = 8;
const FUNDING_WALK_MAX_NODES = 20000;

type Walked = { obj: Record<string, unknown>; path: string };

/** Every plain object in the answer, with its key path ("txns[]", "fundings[].detail"). */
function fundingObjects(answer: unknown): Walked[] {
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

/**
 * The NACHA return code /funding reports for THIS payment, or null.
 *
 * A return only when one object holds BOTH a field whose name contains "retref" equal to this
 * payment's retref exactly, AND a field whose name mentions return, reason or code holding a value
 * that is exactly R plus two digits. Anything else is not a return. Never throws.
 */
export function achReturnFromFunding(answer: unknown, retref: unknown): string | null {
  const want = scalarText(retref);
  if (!want) return null;
  for (const { obj } of fundingObjects(answer)) {
    const keys = Object.keys(obj);
    const ours = keys.some((k) => /retref/i.test(k) && scalarText(obj[k]) === want);
    if (!ours) continue;
    for (const k of keys) {
      if (!/return|reason|code/i.test(k)) continue;
      const v = scalarText(obj[k]);
      if (v && /^R[0-9]{2}$/.test(v)) return v;
    }
  }
  return null;
}

/**
 * Whether achReturnFromFunding can read this answer at all, and its key paths for a log line.
 *
 * Recognised: an answer that carries retrefs (some object has a `retref`-named field holding a
 * value), or one with nothing in it (an empty list, or an object whose lists are all empty: a day
 * with nothing funded). Anything else (a bare string, an object of scalars only, lists of rows with
 * no retref anywhere) is a shape we do not know, and `keyPaths` says what it looked like: key names
 * and nesting only, never a value, digit runs masked, capped at 60 paths.
 */
export function fundingAnswerShape(answer: unknown): { recognised: boolean; keyPaths: string[] } {
  if (!answer || typeof answer !== "object") {
    return { recognised: false, keyPaths: [`(${answer === null ? "null" : typeof answer})`] };
  }
  const walked = fundingObjects(answer);
  const paths = new Set<string>();
  let hasRetref = false;
  // A list anywhere, and whether any list has something in it. A day with nothing funded is lists
  // that are all empty; an object with no list at all (a bare error sentence) is not that.
  let hasLists = Array.isArray(answer);
  let hasRows = Array.isArray(answer) && answer.length > 0;
  for (const { obj, path } of walked) {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (/retref/i.test(k) && scalarText(v)) hasRetref = true;
      if (Array.isArray(v)) {
        hasLists = true;
        if (v.length > 0) hasRows = true;
      }
      if (paths.size < 60) paths.add((path ? `${path}.${keyLabel(k)}` : keyLabel(k)).slice(0, 120));
    }
  }
  const empty = !hasRows && (hasLists || walked.every(({ obj }) => Object.keys(obj).length === 0));
  return { recognised: hasRetref || empty, keyPaths: [...paths] };
}
