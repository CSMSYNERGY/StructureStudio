// _shared/achState.ts — what a bank payment's gateway status MEANS to us, and what we tell
// the customer when it comes back.
//
// PURE on purpose. The UAT emulator only ever walks an ACH to "Accepted" — it will not
// produce a return — so this module is the permanent, reproducible evidence that the
// returned path is handled at all. It runs in the pre-push gate on every push, which a
// one-time screenshot never would.
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
  return {
    funding_state: "returned" as const,
    funding_updated_at: nowIso,
    return_code: String(code ?? "").trim().toUpperCase() || null,
    voided_at: nowIso,
    void_reason: returnTextForBuilder(code),
  };
}
