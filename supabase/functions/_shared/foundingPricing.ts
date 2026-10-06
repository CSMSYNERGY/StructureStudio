// Founding pricing is YEARLY ONLY — the server's half of the rule (Carolyn 2026-09-24).
//
// "Everybody that comes in has to pay for the full year on whichever selections they make ...
// leave month so that month is still showing but when they click on it, it doesn't do
// anything." The portal shipped that on 2026-09-24 (d3ab404) as ONE switch in the browser,
// FOUNDING_ANNUAL_ONLY in portal/03-catalog.jsx: the Monthly button stays on every plan tile,
// dimmed, and setInterval_ refuses it, so a monthly plan id can never reach the cart.
//
// That was the browser only. The _monthly billing_plans rows are still `active` (they are the
// plumbing Carolyn asked to keep, so monthly can come back), and portal-billing's `subscribe`
// sold any active plan it was sent — a tab still running the frontend from before the
// promotion, an operator's hand-made request, or anyone with a session and devtools could
// start a monthly subscription. Holding back was deliberate while the rule lived on beta alone:
// the live site's older frontend still offered Monthly, and a refusal here would have broken its
// checkout. The rule went live on production 2026-09-29 (main 4724827), so the server now
// refuses too.
//
// TWO COPIES OF ONE SWITCH, PINNED TOGETHER. The browser constant stays where it is (it drives
// the dimmed button, the tile copy and the shell's /yr-only banner), and this is the server's.
// foundingPricing.test.ts reads portal/03-catalog.jsx and fails the push when the two values
// differ, or when the browser's rule stops being "monthly is refused while the switch is on".
// So reopening monthly is a two-line change — the browser constant AND this one — and doing
// only one half is a failed preflight rather than a checkout that disagrees with its page.
//
// WHAT THIS REFUSES, AND WHAT IT DOES NOT. Starting a subscription on a monthly plan, which in
// this codebase happens in exactly one place: portal-billing `subscribe` (a builder's own
// checkout, an operator's view-as checkout, and the move up to the Suite all run through it).
// Nothing else is touched. A renewal is the gateway billing a subscription that already exists
// (billing-webhook only mirrors it), a cancellation ends one, and a wallet top-up is not a
// subscription at all. A monthly subscription that already exists keeps renewing on the terms
// it was sold on, as the founding-price guarantee promises; this only stops new ones.
//
// Pure: no imports, so the test can load it without a registry.

/** The switch. Must equal FOUNDING_ANNUAL_ONLY in portal/03-catalog.jsx (the test enforces it). */
export const FOUNDING_ANNUAL_ONLY: boolean = true;

/** Stable machine code on the refusal body, for anything that wants to branch on it. */
export const FOUNDING_ANNUAL_ONLY_CODE = "founding_annual_only";

/** 409: the request is well formed, and what it asks for is simply not on sale right now. */
export const FOUNDING_ANNUAL_ONLY_STATUS: number = 409;

/**
 * The sentence the Billing tab shows, verbatim, in its red message box (subscribe() reads the
 * body's `error` and puts it on screen; a 409 gets no " — sign out" / " — ask an owner" suffix
 * from the portal's invoke wrapper, and is logged there as an info row, not a fault). It names
 * the button by its label, "Yearly", because the only screen that can still send a monthly
 * plan is a Billing tab that shows one.
 */
export const FOUNDING_ANNUAL_ONLY_MESSAGE =
  "Founding pricing is billed yearly only. Choose Yearly for each feature and try again.";

/**
 * The plans in a cart that founding pricing will not sell: every MONTHLY one while the switch
 * is on, and nothing otherwise. Empty means go ahead.
 *
 * Keyed on billing_interval === "monthly", which is exactly the browser's test
 * (`FOUNDING_ANNUAL_ONLY && iv === "monthly"` in setInterval_) and the only non-annual value
 * billing_plans can hold (migration 050's CHECK allows 'monthly' and 'annual'). Deliberately
 * NOT keyed on the plan id's suffix: the id is a name, the interval is the fact the gateway is
 * registered with (month_frequency 1 vs 12).
 */
export function monthlyPlansRefused<P extends { billing_interval?: string | null }>(
  plans: readonly P[],
  annualOnly: boolean = FOUNDING_ANNUAL_ONLY,
): P[] {
  if (!annualOnly) return [];
  return plans.filter((p) => p?.billing_interval === "monthly");
}
