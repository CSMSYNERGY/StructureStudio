// Unit tests for unusedCreditOf — the prorated credit a builder gets when they upgrade to a
// bundle (migration 160).
//
// WHY THESE EXIST. This function decides how much money to take off a real card. Every other
// number in checkout is read from a table; this one is COMPUTED, from dates, and it is the
// only figure in the billing flow that no human typed anywhere. It is also invisible when
// wrong: a credit that comes out 10% light still looks like a plausible discount on the
// invoice, still reconciles against nothing, and the builder has no way to check it. So the
// properties pinned here are the ones a reader cannot eyeball —
//
//   * a period that is over credits NOTHING (the failure that quietly refunds thin air)
//   * a subscription bought minutes ago credits nearly ALL of it (the failure that quietly
//     keeps a builder's money when they upgrade the same week)
//   * the credit never exceeds what was actually PAID, discount included
//   * a stale current_period_end — the normal state of any renewed subscription, because
//     nothing writes that column after checkout — still prorates against the CURRENT period
//
// That last one is the whole reason this anchors on paidThroughOf instead of the stored
// column. A renewed annual subscription carries period 1's boundary forever; prorating
// against it would credit zero to exactly the long-standing customers most likely to upgrade.
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
import { unusedCreditOf, subInterval, paidThroughOf } from "./billingPeriods.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; throw new Error(`${name}${detail ? `: ${detail}` : ""}`); }
}
function eq(name: string, got: number, want: number) {
  check(name, got === want, `expected ${want}, got ${got}`);
}
function near(name: string, got: number, want: number, tol: number) {
  check(name, Math.abs(got - want) <= tol, `expected ~${want} (±${tol}), got ${got}`);
}

// A fixed clock. Date.now() must never leak into these — a test whose expected value drifts
// with the wall clock is a test nobody trusts at 2am.
const NOW = Date.parse("2026-08-29T04:30:00.000Z");
const iso = (s: string) => `${s}T00:00:00+00:00`;   // the shape PostgREST returns
const sub = (price: number, end: string, canceled: string | null = null) =>
  ({ price_cents: price, current_period_end: iso(end), canceled_at: canceled ? iso(canceled) : null });

Deno.test("an annual bought yesterday credits back almost all of it", () => {
  // The upgrade-the-same-week case. Anything much below list here means we kept their money.
  const c = unusedCreditOf(sub(195000, "2027-08-28"), "annual", NOW);
  near("~364/365 of 195000", c, 194466, 600);
  check("never more than was paid", c <= 195000, `${c} > 195000`);
});

Deno.test("a period that has already ended credits nothing", () => {
  eq("expired annual", unusedCreditOf(sub(195000, "2026-01-01", "2025-11-01"), "annual", NOW), 0);
  eq("expired monthly", unusedCreditOf(sub(19500, "2026-07-01", "2026-06-15"), "monthly", NOW), 0);
});

Deno.test("credit is proportional to the time left, not to the time used", () => {
  // Half a year gone on an annual: about half the money back. Pinned loosely because the
  // real span is a calendar year, not 365.0 days.
  const c = unusedCreditOf(sub(1195000, "2027-02-28"), "annual", NOW);
  near("~half of the Suite", c, 597500, 25000);
});

Deno.test("the credit is off what they PAID, so a discount rides through", () => {
  // junior-barns holds a 50%-for-life account discount: price_cents is 97500 on a 195000
  // list plan. Crediting list price would hand them $975 they never paid.
  const full = unusedCreditOf(sub(195000, "2027-08-04"), "annual", NOW);
  const half = unusedCreditOf(sub(97500,  "2027-08-04"), "annual", NOW);
  near("half the price, half the credit", half * 2, full, 2);
  check("bounded by what was paid", half <= 97500, `${half} > 97500`);
});

Deno.test("a STALE current_period_end still prorates against the current period", () => {
  // The normal state of any renewed subscription: nothing writes this column after checkout,
  // so it holds period 1's end forever. paidThroughOf rolls it forward; without that roll
  // this returns 0 and a two-year customer upgrades with no credit at all.
  const stale  = unusedCreditOf(sub(19500, "2026-06-13"), "monthly", NOW);   // 2 renewals ago
  const fresh  = unusedCreditOf(sub(19500, "2026-09-13"), "monthly", NOW);   // the same real period
  eq("rolled forward to the same answer", stale, fresh);
  check("and it is not zero", stale > 0, `${stale}`);
});

Deno.test("nothing prepaid, nothing credited", () => {
  eq("legacy bill-in-arrears row (no period end)",
     unusedCreditOf({ price_cents: 195000, current_period_end: null, canceled_at: null }, "annual", NOW), 0);
  eq("a free plan", unusedCreditOf(sub(0, "2027-08-04"), "annual", NOW), 0);
  eq("a null subscription", unusedCreditOf(null, "annual", NOW), 0);
});

Deno.test("a cancelled subscription still inside its prepaid period IS credited", () => {
  // They cancelled, but checkout billed the period up front and the portal still lets them
  // in until it runs out. That time was bought and paid for; an upgrade must not eat it.
  const c = unusedCreditOf(sub(195000, "2027-03-01", "2026-08-22"), "annual", NOW);
  check("credited", c > 0, `${c}`);
  check("bounded", c <= 195000, `${c} > 195000`);
});

Deno.test("subInterval is the exact inverse of the period it describes", () => {
  // The denominator of the proration. If this drifts, every credit is scaled wrong by the
  // same silent factor — the hardest kind of billing bug to notice.
  const end = Date.parse(iso("2027-08-27"));
  const start = subInterval(end, "annual");
  eq("one year back", new Date(start).getUTCFullYear(), 2026);
  eq("same month", new Date(start).getUTCMonth(), new Date(end).getUTCMonth());
  eq("same day", new Date(start).getUTCDate(), new Date(end).getUTCDate());
  // End-of-month clamping, mirroring addInterval: 31 Mar back one month is 28/29 Feb.
  const mar31 = Date.parse(iso("2027-03-31"));
  eq("31 Mar -1mo clamps into February", new Date(subInterval(mar31, "monthly")).getUTCMonth(), 1);
});

Deno.test("the live yoder-barns rows produce the figure that was shipped", () => {
  // Regression pin on the exact numbers verified against production before this went out
  // (2026-08-29). If a later change moves these, it moved a real customer's bill.
  const simple = unusedCreditOf({ price_cents: 195000, current_period_end: "2027-07-31T20:51:06.059+00:00", canceled_at: null }, "annual", NOW);
  const view3d = unusedCreditOf({ price_cents: 250000, current_period_end: "2027-08-27T00:00:00+00:00",     canceled_at: null }, "annual", NOW);
  eq("Simple Layout, 337 days left", simple, 179871);
  eq("3D View, 363 days left", view3d, 248502);
  eq("total credit", simple + view3d, 428373);
  eq("due today on an $11,950 Suite", 1195000 - (simple + view3d), 766627);
});

Deno.test("paidThroughOf and the credit agree about what is still owned", () => {
  // The credit is only ever offered for subscriptions portal-billing calls usable, and both
  // sides decide that from paidThroughOf. If one said "expired" while the other credited it,
  // we would pay out for access we had already withdrawn.
  const s = sub(195000, "2027-03-01", "2026-08-22");
  const usable = paidThroughOf(s, "annual") > NOW;
  check("usable and credited together", usable === (unusedCreditOf(s, "annual", NOW) > 0));
  const dead = sub(195000, "2026-01-01", "2025-11-01");
  const deadUsable = paidThroughOf(dead, "annual") > NOW;
  check("expired and uncredited together", deadUsable === (unusedCreditOf(dead, "annual", NOW) > 0));
});

if (failures) throw new Error(`${failures} failed`);
