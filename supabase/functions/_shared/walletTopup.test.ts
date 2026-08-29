// Unit tests for the pure parts of wallet top-ups (migration 164).
//
// WHY THESE EXIST. autoTopupDecision is the only thing in this codebase that decides, with no
// human present, to charge a card. Its failure modes are asymmetric and both are expensive:
// firing when it shouldn't takes money nobody asked for, and firing repeatedly takes it over
// and over within seconds. So the properties pinned here are the guards, not the happy path —
// the cooldown, the available-vs-balance distinction, and every reason to refuse.
//
// The charge itself (chargeTopup) is not unit-testable without a gateway and a database; it
// is covered by the ledger states it writes and by the manual gateway run in the plan.
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
import {
  autoTopupDecision, AUTO_TOPUP_COOLDOWN_MS,
  MIN_TOPUP_CENTS, MAX_TOPUP_CENTS, TOPUP_PLAN_ID,
} from "./walletTopup.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; throw new Error(`${name}${detail ? `: ${detail}` : ""}`); }
}
const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

// A tenant configured to hold $100, topping up $250, with $50 available.
const READY = {
  auto_topup_enabled: true,
  auto_topup_threshold_cents: 10000,
  auto_topup_amount_cents: 25000,
  auto_topup_last_at: null as string | null,
  balance_cents: 5000,
  held_cents: 0,
};
const decide = (over: Partial<typeof READY>, hasVault = true, now = NOW) =>
  autoTopupDecision({ ...READY, ...over }, hasVault, now);

Deno.test("fires when available balance is under the threshold", () => {
  const d = decide({});
  check("fires", d.fire === true, JSON.stringify(d));
  check("for the configured amount", d.fire === true && d.amountCents === 25000);
});

Deno.test("does not fire when the tenant is above the threshold", () => {
  const d = decide({ balance_cents: 20000 });
  check("held", d.fire === false && d.reason === "above threshold", JSON.stringify(d));
});

Deno.test("HELD money counts as spent — available, not balance, drives the trigger", () => {
  // $150 balance with $120 held for an in-flight generation is $30 available: under the $100
  // threshold. Reading balance alone would leave a tenant at near-zero available while the
  // trigger insisted they were fine, and the next generation would be refused.
  const d = decide({ balance_cents: 15000, held_cents: 12000 });
  check("fires on available", d.fire === true, JSON.stringify(d));
});

Deno.test("the cooldown stops a burst of generations charging the card repeatedly", () => {
  // The single most expensive failure this function can have.
  check("just charged → held", decide({ auto_topup_last_at: ago(60 * 1000) }).fire === false);
  check("59 min → still held", decide({ auto_topup_last_at: ago(AUTO_TOPUP_COOLDOWN_MS - 60000) }).fire === false);
  check("61 min → allowed", decide({ auto_topup_last_at: ago(AUTO_TOPUP_COOLDOWN_MS + 60000) }).fire === true);
  const cooling = decide({ auto_topup_last_at: ago(60 * 1000) });
  check("and says why", cooling.fire === false && cooling.reason === "cooling down");
});

Deno.test("never fires without a card, however well configured", () => {
  const d = decide({}, false);
  check("refused", d.fire === false && d.reason === "no card on file", JSON.stringify(d));
});

Deno.test("never fires when switched off, or on a missing account", () => {
  check("disabled", decide({ auto_topup_enabled: false }).fire === false);
  check("null account", autoTopupDecision(null, true, NOW).fire === false);
  check("undefined account", autoTopupDecision(undefined, true, NOW).fire === false);
});

Deno.test("refuses a half-configured or out-of-bounds setup rather than guessing", () => {
  // Enabled with nulls should be impossible (the DB constraint and the edge function both
  // forbid it), so if it is ever seen the answer is "do nothing", never a default amount.
  check("no threshold", decide({ auto_topup_threshold_cents: null as never }).fire === false);
  check("no amount", decide({ auto_topup_amount_cents: null as never }).fire === false);
  check("amount below floor", decide({ auto_topup_amount_cents: MIN_TOPUP_CENTS - 1 }).fire === false);
  check("amount above cap", decide({ auto_topup_amount_cents: MAX_TOPUP_CENTS + 1 }).fire === false);
  check("threshold below floor", decide({ auto_topup_threshold_cents: 1 }).fire === false);
});

Deno.test("a zero or negative available balance still fires (it is the point)", () => {
  check("at zero", decide({ balance_cents: 0 }).fire === true);
  // Over-held shouldn't happen, but if it does the tenant is worse off, not better.
  check("over-held", decide({ balance_cents: 1000, held_cents: 5000 }).fire === true);
});

Deno.test("every refusal names a reason", () => {
  // At debit time this runs inside a swallow-everything block, so the reason string is the
  // only way anyone answers "why didn't my wallet recharge?".
  for (const [label, d] of [
    ["disabled", decide({ auto_topup_enabled: false })],
    ["no vault", decide({}, false)],
    ["above", decide({ balance_cents: 99999 })],
    ["cooling", decide({ auto_topup_last_at: ago(1000) })],
    ["unconfigured", decide({ auto_topup_amount_cents: 0 })],
  ] as const) {
    check(`${label} has a reason`, d.fire === false && typeof d.reason === "string" && d.reason.length > 0);
  }
});

Deno.test("the bounds and the attempt-ledger key are what the rest of the system assumes", () => {
  // MIN is one 3D generation ($20) — a smaller top-up would buy nothing and still cost a
  // gateway transaction. MAX matches admin-catalog's per-entry cap on operator grants.
  check("floor is $20", MIN_TOPUP_CENTS === 2000, String(MIN_TOPUP_CENTS));
  check("cap is $5,000", MAX_TOPUP_CENTS === 500000, String(MAX_TOPUP_CENTS));
  // Changing this string orphans every in-flight attempt row: the closed_unknown block and
  // the one-open concurrency index both look it up by exactly this value.
  check("ledger key is stable", TOPUP_PLAN_ID === "wallet_topup", TOPUP_PLAN_ID);
});

if (failures) throw new Error(`${failures} failed`);
