import { assert, assertEquals } from "./test_assert.ts";
import { runTool, toolsFor, type Deps, type Store, type TurnState, type Who } from "./agent.ts";
import { register } from "./pieces.ts";
import { BILLING_SWITCH, LEDGER_FILTER_NAMES, LEDGER_PAGES, lineWords, MIN_BUDGET_MS, moneyMicros, READ_WINDOW_MS, READS_SAID, readsPiece } from "./reads.ts";
import { SAID } from "./common.ts";
import { INBOX_PAGES, SAID_LOOKUP } from "./lookups.ts";
import { leaksContactDetails } from "./redact.ts";
import { FOUNDING_ANNUAL_ONLY } from "../_shared/foundingPricing.ts";
// The fakes answer with the real routes' own parsers and row shapes, so a body the route would refuse
// is refused here too.
import { LEDGER_FILTERS, type LedgerRaw, parseLedgerQuery, toLedgerRow, walletLineLabel } from "../_shared/walletLedger.ts";
import { canonAt, INBOX_PAGE, inboxName, parseInboxRequest } from "../_shared/crmInbox.ts";

register([readsPiece]);

const NOW = Date.parse("2026-11-06T12:00:00Z");
type R = Record<string, unknown>;
type Route = (body: R) => { status: number; data: R | null };
const parse = (c: string) => JSON.parse(c);
const ALLOWED = new Set(["portal-billing status", "portal-billing wallet_transactions", "portal-settings crm_inbox"]);

/** A world with no network: routes by "fn action", a store that refuses every use (no tool here may
 *  write a card), and the calls made, in order. */
function world(o: { routes?: Record<string, Route>; canRead?: (a: string) => boolean; who?: Who; off?: string[]; now?: () => number; budget?: number } = {}) {
  const calls: { fn: string; action: string; body: R }[] = [];
  const storeUsed: string[] = [];
  const refuse = (what: string) => new Proxy({}, { get: (_t, k) => { storeUsed.push(`${what}.${String(k)}`); return () => { throw new Error(`${what}.${String(k)} was used`); }; } });
  const routes = o.routes ?? {};
  const deps = {
    env: () => undefined,
    store: refuse("store") as Store,
    wallet: refuse("wallet"),
    fetch: () => { throw new Error("no network"); },
    portal: (a: string, b: R) => deps.call("portal-settings", a, b),
    call: (fn: string, action: string, body: R) => {
      calls.push({ fn, action, body: JSON.parse(JSON.stringify(body)) });
      const r = routes[`${fn} ${action}`];
      return Promise.resolve(r ? r(body) : { status: 400, data: { error: "Unknown action." } });
    },
    canRead: o.canRead ?? (() => true),
    canEdit: () => true,
    background: () => {},
    budgetMs: () => o.budget ?? 300_000,
    makeId: () => crypto.randomUUID(),
    hash: (t: string) => Promise.resolve(`h${t.length}`),
    log: () => Promise.resolve(),
    audit: () => Promise.resolve(),
    now: o.now ?? (() => NOW),
  } as unknown as Deps;
  const s: TurnState = { who: o.who ?? { clientId: "builder-a", userId: "u1", operatorEmail: null }, chatId: "chat1", off: o.off ?? [], proposalIds: [] };
  const done = () => {
    assertEquals(storeUsed, [], "a read tool touched the store or the wallet");
    assertEquals(s.proposalIds, [], "a read tool put a card up");
    for (const c of calls) assert(ALLOWED.has(`${c.fn} ${c.action}`), `called ${c.fn} ${c.action}`);
  };
  return { deps, s, calls, done };
}
const tool = (name: string) => readsPiece.tools.find((t) => t.def.name === name)!;
const run = (w: ReturnType<typeof world>, name: string, input: R) => tool(name).run(w.deps, w.s, input);

// ── portal-billing, as it answers ───────────────────────────────────────────────────────────────────

const PLAN = {
  layout: "0a1b2c3d-0000-4000-8000-00000000000a", crm: "0a1b2c3d-0000-4000-8000-00000000000b", d3: "0a1b2c3d-0000-4000-8000-00000000000c",
  retired: "0a1b2c3d-0000-4000-8000-00000000000d", layoutYear: "0a1b2c3d-0000-4000-8000-00000000000e", soon: "0a1b2c3d-0000-4000-8000-00000000000f",
};
// As status sends them (portal-billing publicPlans): a feature's monthly and yearly rows, availability
// 'available' or 'coming_soon' (migration 052's check), and an unpublished price nulled while its setup
// fee rides along (the Billing tab hides that too, "which would hint at the tier").
const PLANS = [
  { id: PLAN.layout, feature: "simple_layout", name: "Simple Layout", price_cents: 4900, charge_cents: 4410, billing_interval: "monthly", setup_fee_cents: 0, availability: "available", required: false, sort_order: 30, price_visible: true, operator_grantable: false, discount_percent: 10 },
  { id: PLAN.layoutYear, feature: "simple_layout", name: "Simple Layout", price_cents: 49000, charge_cents: 44100, billing_interval: "annual", setup_fee_cents: 0, availability: "available", required: false, sort_order: 30, price_visible: true, operator_grantable: false, discount_percent: 10 },
  { id: PLAN.crm, feature: "crm", name: "Customer Hub", price_cents: 99000, charge_cents: 99000, billing_interval: "annual", setup_fee_cents: 0, availability: "available", required: false, sort_order: 20, price_visible: true, operator_grantable: false, discount_percent: 0 },
  { id: PLAN.d3, feature: "view_3d", name: "3D View", price_cents: null, charge_cents: null, billing_interval: "annual", setup_fee_cents: 31700, availability: "available", required: false, sort_order: 10, price_visible: false, operator_grantable: true, discount_percent: 0 },
  { id: PLAN.soon, feature: "schedule_builds", name: "Schedule Builds and Delivery", price_cents: 250000, charge_cents: 250000, billing_interval: "annual", setup_fee_cents: 0, availability: "coming_soon", required: false, sort_order: 5, price_visible: true, operator_grantable: false, discount_percent: 0 },
];
const ENTITLEMENT = {
  exempt: false, state: "active", locked: false, reason: "active", graceEndsAt: null, graceDays: 7, transitionEndsAt: null,
  requiredRate: { monthlyCents: 4410, annualCents: 44100, listMonthlyCents: 4900, listAnnualCents: 49000, discountPercent: 10 },
  features: { simple_layout: true, crm: true, view_3d: false }, granted: [], paid: ["crm", "simple_layout"], advancedMode: false, shedsOn: true,
};
const SUBS = [
  { id: "s1", plan_id: PLAN.layout, status: "active", price_cents: 4410, current_period_start: "2026-10-01T00:00:00Z", current_period_end: "2026-11-01T00:00:00Z", canceled_at: null, created_at: "2026-08-01T00:00:00Z", past_due_since: null, paid_through: "2026-12-01T00:00:00.000Z" },
  { id: "s2", plan_id: PLAN.crm, status: "cancelled", price_cents: 99000, current_period_start: "2026-03-01T00:00:00Z", current_period_end: "2027-03-01T00:00:00Z", canceled_at: "2026-10-10T00:00:00Z", created_at: "2026-03-01T00:00:00Z", past_due_since: null, paid_through: "2027-03-01T00:00:00.000Z" },
  { id: "s3", plan_id: PLAN.retired, status: "cancelled", price_cents: 2900, current_period_start: "2025-12-01T00:00:00Z", current_period_end: "2026-01-01T00:00:00Z", canceled_at: "2025-12-15T00:00:00Z", created_at: "2025-06-01T00:00:00Z", past_due_since: null, paid_through: "2026-01-01T00:00:00.000Z" },
];

// The ledger as wallet_transactions holds it, oldest first, ids in the order the balance moved.
let lid = 4_100_000;
const tx = (at: string, kind: string, meter: string | null, memo: string | null, cents: number, micros: number | null, state = "posted"): LedgerRaw => ({
  id: ++lid, created_at: at, kind, meter_kind: meter, state, memo, amount_cents: cents, balance_after_cents: state === "held" ? null : 845012,
  amount_exact_micros: micros, balance_after_exact_micros: state === "held" ? null : 8_450_120_000,
});
const LEDGER: LedgerRaw[] = [
  tx("2026-10-02T15:00:00.000Z", "topup", null, "Automatic top-up", 5000, 50_000_000),
  tx("2026-10-05T14:00:00.000Z", "debit", "sms_segment", "Text to (816) 555-0100 · 1 segment", -1, -8_300),
  tx("2026-10-09T14:00:00.000Z", "debit", "sms_in", "Text from (660) 555-0199 · 2 segments", -2, -16_600),
  tx("2026-10-12T16:00:00.000Z", "debit", "voice_minute", "Outbound call to (816) 555-0100 · 3 min", -4, -42_000),
  tx("2026-10-12T16:05:00.000Z", "debit", "call_transcription", "Call transcript and summary, call from (816) 555-0100 · 3 min", -6, -60_000),
  tx("2026-10-15T10:00:00.000Z", "adjustment", null, "Refund for Dale Smith's dropped call, 816-555-0100", 500, 5_000_000),
  tx("2026-10-20T10:00:00.000Z", "debit", "jack_ai", "Jack · answer", -12, -123_400),
  tx("2026-10-21T10:00:00.000Z", "debit", "tax_lookup", "Tax verification · SST-5021 · Minnesota", -10, -100_000),
  tx("2026-10-25T10:00:00.000Z", "debit", "video_3d_generation", null, -2000, -20_000_000, "held"),
  tx("2026-10-30T10:00:00.000Z", "debit", "sms_segment", "Text to (816) 555-0100 · 1 segment", -1, -8_300),
  tx("2026-11-02T10:00:00.000Z", "debit", "sms_segment", "Text to (913) 555-0142 · 1 segment", -1, -8_300),
];

const WALLET = (ledger: LedgerRaw[], o: R = {}): R => ({
  balanceCents: 845012, heldCents: 2000, exempt: false, minTopupCents: 1000, maxTopupCents: 50000,
  autoTopup: {
    enabled: false, thresholdCents: 1000, amountCents: 5000, lastAt: "2026-10-20T15:00:00.000Z",
    disabledReason: "The card was declined (Card 4111111111111111 DECLINE REFID:3141592653). Replace the card, then switch them back on.",
    ready: true, agreed: false, dailyMax: 3, chargesLast24h: null,
  },
  meters: [
    { kind: "voice_minute", label: "Call minutes", unitLabel: "minute", priceCents: null, billedAs: "Billed per call minute" },
    { kind: "video_3d_generation", label: "3D generation from a video", unitLabel: "generation", priceCents: 2000 },
    { kind: "voicemail_transcription", label: "Voicemail transcription", unitLabel: "minute", priceCents: 5 },
  ],
  // status's ten lines: newest by created_at, labelled by the same walletLineLabel the route uses.
  transactions: [...ledger].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 10)
    .map((t) => ({ id: Number(t.id), label: walletLineLabel(t), amountCents: Number(t.amount_cents), pending: t.state === "held", at: t.created_at })),
  ...o,
});

/** portal-billing status. `mine` false is what an operator without can_bill gets (index.ts:988). */
function statusRoute(o: { mine?: boolean; wallet?: R | null; entitlement?: R; subs?: R[]; fail?: number } = {}): Route {
  return () => {
    if (o.fail !== undefined) return { status: o.fail, data: o.fail >= 500 ? { error: "We couldn't read your account settings. Try again in a moment." } : null };
    const base = { configured: true, entitlement: o.entitlement ?? ENTITLEMENT };
    if (o.mine === false) return { status: 200, data: { ...base, plans: [], subscriptions: [], checkout: null } };
    return {
      status: 200,
      data: {
        ...base,
        wallet: o.wallet === undefined ? WALLET(LEDGER) : o.wallet,
        upgradeCredits: { full_suite: { cents: 1234, sources: [{ planId: PLAN.layout, name: "Simple Layout", cents: 1234 }] } },
        hasCard: true,
        card: { last4: "4242", brand: "Visa" },
        cof: { wordingVersion: "2026-10-cof", topupConsent: "I authorize CSM Synergy to charge my card ending 4242 for this top-up and later ones.", topupNeedsAgreement: false, operatorTopupAllowed: false },
        discount: { percent: 10, features: ["simple_layout"] },
        plans: PLANS,
        subscriptions: o.subs ?? SUBS,
        checkout: { tokenizationKey: "tokkey-5Xq9-SECRET-KEY", collectJsUrl: "https://secure.nmi.com/token/Collect.js" },
      },
    };
  };
}

/** portal-billing wallet_transactions: the route's own parser and row, paged by id, newest first. */
function ledgerRoute(rows: LedgerRaw[], o: { canBill?: boolean; failOnPage?: number; status?: number } = {}): Route {
  let page = 0;
  return (body) => {
    page++;
    if (o.canBill === false) return { status: 403, data: { error: "Your access does not include the wallet. Ask an owner." } };
    if (o.failOnPage === page) return { status: o.status ?? 0, data: null };
    const parsed = parseLedgerQuery(body);
    if (!parsed.ok) return { status: 400, data: { error: parsed.error } };
    const q = parsed.query;
    if (q.csv) return { status: 200, data: { csv: "Date,Description,Amount,Balance", rows: rows.length, truncated: false } };
    const keep = rows
      .filter((t) => t.state === "posted" || t.state === "held")
      .filter((t) => q.filter === "all" || toLedgerRow(t).category === q.filter)
      .filter((t) => !q.from || Date.parse(t.created_at) >= Date.parse(q.from))
      .filter((t) => !q.to || Date.parse(t.created_at) < Date.parse(q.to))
      .filter((t) => q.before === null || Number(t.id) < q.before)
      .sort((a, b) => Number(b.id) - Number(a.id));
    const read = keep.slice(0, q.limit + 1);
    const out = read.slice(0, q.limit).map(toLedgerRow);
    return { status: 200, data: { rows: out, next_cursor: read.length > q.limit && out.length ? String(out[out.length - 1].id) : null } };
  };
}

const billingWorld = (o: Parameters<typeof world>[0] & { status?: Route; ledger?: Route } = {}) =>
  world({ ...o, routes: { "portal-billing status": o.status ?? statusRoute(), "portal-billing wallet_transactions": o.ledger ?? ledgerRoute(LEDGER), ...(o.routes ?? {}) } });

const OVERVIEW = { what: "overview", filter: "all", from: "", to: "" };
const LAST_MONTH = { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" };

// ── look_at_billing: overview ───────────────────────────────────────────────────────────────────────

Deno.test("billing overview: figures as dollars, and nothing of the card, the keys, the agreement or a number", async () => {
  const w = billingWorld();
  const out = await run(w, "look_at_billing", OVERVIEW);
  assert(!out.isError, out.content);
  const a = parse(out.content);
  assertEquals(a.plan.state, "active");
  assertEquals(a.plan.featuresOn, ["Simple Layout", "Customer Hub"]);
  assertEquals(a.plan.paidFor, ["Customer Hub", "Simple Layout"]);
  assertEquals(a.subscriptions, [
    { plan: "Simple Layout", status: "active", price: "$44.10 a month", paidThrough: "2026-12-01" },
    { plan: "Customer Hub", status: "cancelled", price: "$990 a year", endsOn: "2027-03-01" },
  ]);
  assertEquals(a.cancelledEarlier, 1);
  // A monthly subscription someone already has keeps its price (above); a new one is yearly only while
  // founding pricing is on, as portal-billing's subscribe and the Billing tab both have it.
  assertEquals(a.plansOffered, [
    ...(FOUNDING_ANNUAL_ONLY ? [] : [{ plan: "Simple Layout", price: "$44.10 a month" }]),
    { plan: "Simple Layout", price: "$441 a year" },
    { plan: "Customer Hub", price: "$990 a year" },
    { plan: "3D View", price: "price not published yet" },
    { plan: "Schedule Builds and Delivery", price: "$2,500 a year", comingSoon: true },
  ]);
  assertEquals(a.notes.includes(READS_SAID.yearlyOnly), FOUNDING_ANNUAL_ONLY);
  assert(a.notes.includes(READS_SAID.comingSoon));
  assertEquals(a.discount, { percent: 10, on: ["Simple Layout"] });
  assertEquals(a.cardOnFile, true);
  assertEquals([a.wallet.balance, a.wallet.setAside], ["$8,450.12", "$20"]);
  assertEquals(a.wallet.automaticTopUp, { on: false, whenBelow: "$10", adds: "$50", lastOn: "2026-10-20", switchedOffBecause: "the card was declined", canBeSwitchedOn: true });
  assertEquals(a.wallet.prices, [
    { what: "Call minutes", price: "Billed per call minute" },
    { what: "3D generation from a video", price: "$20 per generation" },
    { what: "Voicemail transcription", price: "$0.05 per minute" },
  ]);
  assertEquals(a.wallet.recent.length, 10);
  assertEquals(a.wallet.recent[0], { on: "2026-11-02T10:00:00.000Z", what: "Text sent · 1 segment", amount: "-$0.01" });
  assertEquals(a.wallet.recent.find((r: R) => r.pending), { on: "2026-10-25T10:00:00.000Z", what: "3D generation from a video", amount: "-$20", pending: true });
  assert(a.wallet.recent.some((r: R) => r.what === "Adjustment"), "an adjustment shows without its typed note");
  assert(a.wallet.recent.some((r: R) => r.what === "Outbound call · 3 min"));
  assert(a.notes.includes(READS_SAID.rounded) && a.notes.includes(READS_SAID.held));
  // What must never reach Claude. "317" is the unpublished plan's setup fee ($317), hidden on the tab.
  for (const bad of ["4242", "Visa", "tokkey", "SECRET", "Collect.js", "authorize", "4111", "3141592653", "Dale", "12.34", "upgrade", "0a1b2c3d", "4100", "816", "(no", "317"]) {
    assert(!out.content.includes(bad), `"${bad}" reached Claude`);
  }
  assert(!leaksContactDetails(out.content), "no number may reach Claude");
  assertEquals(w.calls.map((c) => [c.fn, c.action, c.body]), [["portal-billing", "status", {}]]);
  w.done();
});

Deno.test("billing overview: an operator without can_bill gets status without its billing half, which is can't see, never 'no plan'", async () => {
  const w = billingWorld({ status: statusRoute({ mine: false }), who: { clientId: "builder-a", userId: "u1", operatorEmail: "support@csmsynergy.test" } });
  const a = parse((await run(w, "look_at_billing", OVERVIEW)).content);
  assertEquals(a, { cantSee: "billing", note: READS_SAID.cantSeeBilling });
  w.done();
});

Deno.test("billing overview: a wallet that couldn't be read is said, and a $0 balance says it may be a failed read", async () => {
  const gone = billingWorld({ status: statusRoute({ wallet: null }) });
  const a = parse((await run(gone, "look_at_billing", OVERVIEW)).content);
  assertEquals(a.wallet, null);
  assert(a.notes.includes(READS_SAID.walletUnread));
  const zero = billingWorld({ status: statusRoute({ wallet: WALLET([], { balanceCents: 0, heldCents: 0 }) }) });
  const b = parse((await run(zero, "look_at_billing", OVERVIEW)).content);
  assertEquals(b.wallet.balance, "$0");
  assertEquals(b.wallet.recent, []);
  assert(b.notes.includes(READS_SAID.maybeUnread), "a $0 that may be a failed read says so");
  gone.done();
  zero.done();
});

Deno.test("billing overview: the plan's state in plain words, grace and locked included", async () => {
  const grace = billingWorld({ status: statusRoute({ entitlement: { ...ENTITLEMENT, state: "grace", reason: "past_due", graceEndsAt: "2026-11-10T00:00:00.000Z" } }) });
  assertEquals(parse((await run(grace, "look_at_billing", OVERVIEW)).content).plan.says, "A payment didn't go through. Everything keeps working until 2026-11-10, then it locks.");
  const locked = billingWorld({ status: statusRoute({ entitlement: { ...ENTITLEMENT, state: "locked", locked: true, reason: "never_paid", features: {} }, subs: [] }) });
  const l = parse((await run(locked, "look_at_billing", OVERVIEW)).content);
  assertEquals([l.plan.says, l.subscriptions, l.plan.featuresOn], ["Locked: there's no plan yet.", [], undefined]);
  const free = billingWorld({ status: statusRoute({ entitlement: { ...ENTITLEMENT, state: "transition", reason: "transition", transitionEndsAt: "2026-12-31T00:00:00.000Z" } }) });
  const f = parse((await run(free, "look_at_billing", OVERVIEW)).content);
  // The shell's banner: while founding pricing is yearly only, no a-month rate when there's a yearly one.
  assertEquals([f.plan.says, f.plan.entryPlanAfterThat], ["Free until 2026-12-31. After that it needs a plan.", FOUNDING_ANNUAL_ONLY ? "$441 a year" : "$44.10 a month or $441 a year"]);
  const monthlyOnly = { ...ENTITLEMENT.requiredRate, annualCents: null, listAnnualCents: null };
  const m = billingWorld({ status: statusRoute({ entitlement: { ...ENTITLEMENT, state: "transition", reason: "transition", transitionEndsAt: "2026-12-31T00:00:00.000Z", requiredRate: monthlyOnly } }) });
  assertEquals(parse((await run(m, "look_at_billing", OVERVIEW)).content).plan.entryPlanAfterThat, "$44.10 a month", "with no yearly rate, the monthly one is still said");
});

Deno.test("billing overview: a lost answer or a 500 is 'couldn't read', asked once; resolveTenant's refusal is said as it is", async () => {
  for (const fail of [0, 500, 503]) {
    const w = billingWorld({ status: statusRoute({ fail }) });
    const out = await run(w, "look_at_billing", OVERVIEW);
    assertEquals([out.isError, out.content], [true, SAID.readFailed], `status ${fail}`);
    assertEquals(w.calls.length, 1, "a lost answer is never asked again");
  }
  const refused = billingWorld({ status: () => ({ status: 403, data: { error: "Operator access required." } }) });
  assertEquals((await run(refused, "look_at_billing", OVERVIEW)).content, "Operator access required.");
});

// ── look_at_billing: spending ───────────────────────────────────────────────────────────────────────

Deno.test("spending: what texts cost last month, added from the exact amounts, with the route's own body", async () => {
  const w = billingWorld();
  const out = await run(w, "look_at_billing", { what: "spending", filter: "texts", ...LAST_MONTH });
  assert(!out.isError, out.content);
  const a = parse(out.content);
  // Three texts in October: 0.83 + 1.66 + 0.83 cents. Whole cents would have said 4.
  assertEquals([a.lines, a.spent, a.credited], [3, "$0.0332", undefined]);
  assertEquals(a.newest.map((l: R) => l.what), ["Text sent · 1 segment", "Text received · 2 segments", "Text sent · 1 segment"]);
  assertEquals(a.byKind, undefined);
  assertEquals(w.calls.map((c) => c.body), [{ filter: "texts", from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z", limit: 50 }]);
  assert(!leaksContactDetails(out.content) && !/4100|555/.test(out.content), "no number or ledger id reaches Claude");
  w.done();
});

Deno.test("spending: everything by kind, a 3D hold apart, call extras under other, and the typed note left out", async () => {
  const w = billingWorld();
  const a = parse((await run(w, "look_at_billing", { what: "spending", filter: "all", ...LAST_MONTH })).content);
  assertEquals([a.lines, a.spent, a.credited, a.setAside], [10, "$0.3586", "$55", "$20"]);
  assertEquals(a.byKind, {
    calls: { lines: 1, spent: "$0.0420" },
    texts: { lines: 3, spent: "$0.0332" },
    tax: { lines: 1, spent: "$0.10" },
    jack: { lines: 1, spent: "$0.1234" },
    funds: { lines: 2, spent: "$0", credited: "$55" },
    other: { lines: 2, spent: "$0.06", setAside: "$20" },
  });
  assert(a.notes.includes(READS_SAID.callExtras) && a.notes.includes(READS_SAID.held));
  assert(a.newest.some((l: R) => l.what === "Call transcript and summary · 3 min" || l.what === "Usage"));
  assert(!/Dale|Refund for/.test(JSON.stringify(a)), "an adjustment's typed note stays on the page");
  w.done();
});

Deno.test("spending: many pages follow the route's cursor, and the total is the whole stretch", async () => {
  const many: LedgerRaw[] = [];
  for (let d = 0; d < 120; d++) many.push(tx(new Date(Date.parse("2026-10-01T06:00:00Z") + d * 6 * 3_600_000).toISOString(), "debit", "sms_segment", "Text to (816) 555-0100 · 1 segment", -1, -8_300));
  const w = billingWorld({ ledger: ledgerRoute(many) });
  const a = parse((await run(w, "look_at_billing", { what: "spending", filter: "texts", ...LAST_MONTH })).content);
  assertEquals([a.lines, a.spent], [120, "$0.9960"]);
  assertEquals(w.calls.length, 3);
  assertEquals(w.calls[1].body.cursor, String(many[70].id), "newest first: the second page starts below the first page's last line");
  assert(w.calls.every((c) => !("format" in c.body) && !("tz" in c.body)), "never the CSV export");
  w.done();
});

Deno.test("spending: more lines than it reads in one go gives no total at all", async () => {
  const many: LedgerRaw[] = [];
  for (let i = 0; i <= LEDGER_PAGES * 50; i++) many.push(tx(new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60_000).toISOString(), "debit", "sms_in", "Text from (816) 555-0100 · 1 segment", -1, -8_300));
  const w = billingWorld({ ledger: ledgerRoute(many) });
  const out = await run(w, "look_at_billing", { what: "spending", filter: "texts", ...LAST_MONTH });
  assertEquals([out.isError, out.content], [true, READS_SAID.tooManyLines]);
  assertEquals(w.calls.length, LEDGER_PAGES);
  // Slow pages stop early, the same way.
  let t = NOW;
  const slow = billingWorld({ ledger: ledgerRoute(many), now: () => (t += 4_000) });
  const s = await run(slow, "look_at_billing", { what: "spending", filter: "texts", ...LAST_MONTH });
  assertEquals([s.isError, s.content], [true, READS_SAID.tooMuchTime]);
  assert(slow.calls.length < LEDGER_PAGES && slow.calls.length * 4_000 >= READ_WINDOW_MS / 2);
});

Deno.test("spending: a worker near the end of its budget stops after one page, and says it ran out of time, not that there are too many lines", async () => {
  // 80 lines: two pages, far under what one read adds up. Only the worker's time is short.
  const some: LedgerRaw[] = [];
  for (let i = 0; i < 80; i++) some.push(tx(new Date(Date.parse("2026-10-02T00:00:00Z") + i * 3_600_000).toISOString(), "debit", "sms_segment", "Text to (816) 555-0100 · 1 segment", -1, -8_300));
  const w = billingWorld({ ledger: ledgerRoute(some), budget: MIN_BUDGET_MS - 1 });
  const out = await run(w, "look_at_billing", { what: "spending", filter: "texts", ...LAST_MONTH });
  assertEquals([out.isError, out.content], [true, READS_SAID.tooMuchTime]);
  assertEquals(w.calls.length, 1, "no second page once the worker is short of time");
  // With time to spare, the same stretch adds up.
  const ok = billingWorld({ ledger: ledgerRoute(some) });
  assertEquals(parse((await run(ok, "look_at_billing", { what: "spending", filter: "texts", ...LAST_MONTH })).content).lines, 80);
});

Deno.test("spending: a lost page is never asked again, and part of a stretch is never added up", async () => {
  const many: LedgerRaw[] = [];
  for (let i = 0; i < 80; i++) many.push(tx(new Date(Date.parse("2026-10-02T00:00:00Z") + i * 3_600_000).toISOString(), "debit", "sms_segment", "Text to (816) 555-0100 · 1 segment", -1, -8_300));
  const first = billingWorld({ ledger: ledgerRoute(many, { failOnPage: 1 }) });
  assertEquals((await run(first, "look_at_billing", { what: "spending", filter: "all", ...LAST_MONTH })).content, SAID.readFailed);
  assertEquals(first.calls.length, 1);
  const second = billingWorld({ ledger: ledgerRoute(many, { failOnPage: 2, status: 502 }) });
  const out = await run(second, "look_at_billing", { what: "spending", filter: "all", ...LAST_MONTH });
  assertEquals([out.isError, out.content], [true, SAID_LOOKUP.partial]);
  assertEquals(second.calls.length, 2);
  assert(!/\$/.test(out.content), "no figure from part of a stretch");
});

Deno.test("spending: an operator without can_bill hears the route's refusal; a 400 is the route's own sentence", async () => {
  const op = billingWorld({ ledger: ledgerRoute(LEDGER, { canBill: false }), who: { clientId: "builder-a", userId: "u1", operatorEmail: "support@csmsynergy.test" } });
  assertEquals((await run(op, "look_at_billing", { what: "spending", filter: "all", ...LAST_MONTH })).content, "Your access does not include the wallet. Ask an owner.");
  const bad = billingWorld({ ledger: () => ({ status: 400, data: { error: "Those dates aren't valid." } }) });
  assertEquals((await run(bad, "look_at_billing", { what: "spending", filter: "all", ...LAST_MONTH })).content, "Those dates aren't valid.");
});

Deno.test("spending: a request it can't run is refused before any read", async () => {
  const cases: [R, string][] = [
    [{ what: "spending", filter: "all", from: "", to: "" }, READS_SAID.needFrom],
    [{ what: "spending", filter: "all", from: "last month", to: "" }, READS_SAID.badTime],
    [{ what: "spending", filter: "all", from: "2026-12-01T00:00:00Z", to: "" }, READS_SAID.notYet],
    [{ what: "spending", filter: "all", from: "2026-10-01T00:00:00Z", to: "2026-09-01T00:00:00Z" }, READS_SAID.endFirst],
    [{ what: "spending", filter: "refunds", from: "2026-10-01T00:00:00Z", to: "" }, READS_SAID.badFilter],
    [{ what: "charge", filter: "all", from: "", to: "" }, "Say overview or spending."],
  ];
  for (const [input, said] of cases) {
    const w = billingWorld();
    const out = await run(w, "look_at_billing", input);
    assertEquals([out.isError, out.content], [true, said], JSON.stringify(input));
    assertEquals(w.calls.length, 0);
  }
});

Deno.test("money words and wallet lines: never a phone-looking run, never the number a call went to", () => {
  assertEquals([moneyMicros(-8_300), moneyMicros(-60_000), moneyMicros(50_000_000), moneyMicros(-123_456_789_000), moneyMicros(0)], ["-$0.0083", "-$0.06", "$50", "-$123,456.79", "$0"]);
  for (const m of [-8_300, 1_234_567, 99_999_999, 123_456_789_012, -7_777_777]) assert(!leaksContactDetails(moneyMicros(m)), moneyMicros(m));
  assertEquals(lineWords("Outbound call to (816) 555-0100 · 3 min"), "Outbound call · 3 min");
  assertEquals(lineWords("Missed call from +1 816 555 0100 · voicemail 2 min"), "Missed call · voicemail 2 min");
  assertEquals(lineWords("Text to (816) 555-0100 · 1 segment"), "Text sent · 1 segment");
  assertEquals(lineWords("Text from Dale Smith · 2 segments"), "Text received · 2 segments");
  assertEquals(lineWords("Call recording, call to (816) 555-0100 · 4 min"), "Call recording · 4 min");
  assertEquals(lineWords("Adjustment — goodwill for Dale, call 816-555-0100"), "Adjustment");
  assertEquals(lineWords("Credit from CSM Synergy"), "Credit from CSM Synergy");
  assertEquals(lineWords("Added funds · automatic top-up"), "Added funds · automatic top-up");
  assertEquals(lineWords("Tax verification · SST-5021 · Minnesota"), "Tax verification · SST-5021 · Minnesota");
  assertEquals(lineWords(null), "Usage");
});

Deno.test("the ledger filter names are walletLedger.ts's own chips", () => {
  assertEquals([...LEDGER_FILTER_NAMES], [...LEDGER_FILTERS]);
});

// ── portal-settings crm_inbox, as it answers ────────────────────────────────────────────────────────

interface T { contactId: string; name: string | null; email?: string; phone?: string; channel: "sms" | "email" | "calls"; direction: "in" | "out"; preview: string; at: string; awaitingReply: boolean; mine?: boolean }
let cseq = 0;
const cid = () => `c0ffee00-0000-4000-8000-${String(++cseq).padStart(12, "0")}`;
const thread = (minutesAgo: number, o: Partial<T> = {}): T => ({
  contactId: cid(), name: `Customer ${cseq}`, channel: "sms", direction: "in", preview: "Is the 12x24 still on for Friday?",
  at: new Date(NOW - minutesAgo * 60_000).toISOString(), awaitingReply: true, ...o,
});

/** crm_inbox: the route's own request parser, one row per customer newest first, 50 a page, the next
 *  page below the last row's time, the name falling back to an email or a number (inboxName). */
function inboxRoute(threads: T[], o: { seesCalls?: boolean; refuse?: { status: number; error: string }; failOnPage?: number } = {}): Route {
  let page = 0;
  return (body) => {
    page++;
    if (o.refuse) return { status: o.refuse.status, data: { error: o.refuse.error } };
    if (o.failOnPage === page) return { status: 0, data: null };
    const req = parseInboxRequest(body);
    if ("error" in req) return { status: 400, data: { error: req.error } };
    const seesCalls = o.seesCalls !== false;
    const list = threads
      .filter((t) => seesCalls || t.channel !== "calls")
      .filter((t) => req.channel === "all" || t.channel === req.channel)
      .filter((t) => !req.mine || t.mine === true)
      .map((t) => ({ ...t, at: canonAt(t.at)! }))
      .filter((t) => !req.cursor || t.at < req.cursor)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const rows = list.slice(0, INBOX_PAGE);
    return {
      status: 200,
      data: {
        ok: true,
        threads: rows.map((t) => ({
          contactId: t.contactId, name: inboxName({ id: t.contactId, name: t.name, owner_user_id: null, email: t.email ?? null, phone: t.phone ?? null }),
          channel: t.channel, direction: t.direction, preview: t.preview, at: t.at, awaitingReply: t.awaitingReply,
        })),
        cursor: list.length > INBOX_PAGE ? rows[rows.length - 1].at : null,
        ...(req.cursor ? {} : { smsReady: true, hasTexts: true, hasCalls: seesCalls, seesCalls }),
      },
    };
  };
}
const inboxWorld = (threads: T[], o: Parameters<typeof world>[0] & { inbox?: Parameters<typeof inboxRoute>[1] } = {}) =>
  world({ ...o, routes: { "portal-settings crm_inbox": inboxRoute(threads, o.inbox) } });
const SEARCH = { name: "", channel: "all", waiting: "any", mine: false, from: "", to: "" };

// ── find_conversations ──────────────────────────────────────────────────────────────────────────────

Deno.test("conversations: finds a name three pages back, through the route's cursor, and never hands Claude an id", async () => {
  const threads = Array.from({ length: 130 }, (_, i) => thread(i * 10));
  threads[121] = thread(1210, { name: "Dale Smith", channel: "email", preview: "Re: your estimate", direction: "in", awaitingReply: false });
  const w = inboxWorld(threads);
  const out = await run(w, "find_conversations", { ...SEARCH, name: "dale sm" });
  assert(!out.isError, out.content);
  const a = parse(out.content);
  assertEquals(a.found, 1);
  assertEquals(a.rows, [{ name: "Dale Smith", channel: "email", lastFrom: "them", waiting: false, at: new Date(NOW - 1210 * 60_000).toISOString(), daysAgo: 0, said: "Re: your estimate" }]);
  assertEquals(a.searched, { customers: 130, all: true });
  assertEquals(w.calls.map((c) => Object.keys(c.body).sort().join(",")), ["channel,mine", "channel,cursor,mine", "channel,cursor,mine"]);
  assertEquals(w.calls[0].body, { channel: "all", mine: false });
  assert(!/c0ffee00|contactId/.test(out.content), "no id reaches Claude");
  w.done();
});

Deno.test("conversations: a name that is really an email or a number is dropped, and words are scrubbed", async () => {
  const threads = [
    thread(5, { name: null, email: "pat.lee@example.com", preview: "Text me at 816-555-0100 or pat.lee@example.com, I'm at 1234 N Main St" }),
    thread(6, { name: null, phone: "+18165550123", channel: "sms", preview: "Picture message" }),
    thread(7, { name: "Pat Lee", channel: "email", preview: "Delivery to 88 County Road 12" }),
  ];
  const w = inboxWorld(threads);
  const out = await run(w, "find_conversations", SEARCH);
  const a = parse(out.content);
  assertEquals(a.rows.map((r: R) => r.name), ["(no name saved)", "(no name saved)", "Pat Lee"]);
  assert(!leaksContactDetails(out.content), "no number or email reaches Claude");
  assert(!/Main St|County Road|example\.com|8165550123/.test(out.content), out.content);
  // A search by the fallback address finds nothing: it isn't a name, and it is refused before a read.
  const byMail = inboxWorld(threads);
  assertEquals((await run(byMail, "find_conversations", { ...SEARCH, name: "pat.lee@example.com" })).content, READS_SAID.nameOnly);
  assertEquals((await run(byMail, "find_conversations", { ...SEARCH, name: "816 555 0123" })).content, READS_SAID.nameOnly);
  assertEquals(byMail.calls.length, 0);
  w.done();
});

Deno.test("conversations: texts, waiting and Mine go to the route as the tab sends them", async () => {
  const threads = [
    thread(1, { name: "Avery Text", channel: "sms", mine: true }),
    thread(2, { name: "Blake Text", channel: "sms", direction: "out", awaitingReply: false, preview: "See you Friday" }),
    thread(3, { name: "Casey Mail", channel: "email", mine: true }),
  ];
  const w = inboxWorld(threads);
  const a = parse((await run(w, "find_conversations", { ...SEARCH, channel: "texts", waiting: "waiting", mine: true })).content);
  assertEquals(w.calls[0].body, { channel: "sms", mine: true });
  assertEquals(a.rows.map((r: R) => r.name), ["Avery Text"]);
  const b = parse((await run(w, "find_conversations", { ...SEARCH, waiting: "answered" })).content);
  assertEquals(b.rows.map((r: R) => [r.name, r.lastFrom, r.said]), [["Blake Text", "you", "See you Friday"]]);
  for (const [input, said] of [[{ channel: "voicemail" }, READS_SAID.badChannel], [{ waiting: "late" }, READS_SAID.badWaiting], [{ name: "a" }, READS_SAID.shortName]] as [R, string][]) {
    assertEquals((await run(w, "find_conversations", { ...SEARCH, ...input })).content, said);
  }
  assertEquals(w.calls.length, 2, "a request it can't run reads nothing");
  w.done();
});

Deno.test("conversations: calls are counts only, with no label, summary or voicemail words", async () => {
  const threads = [
    thread(1, { name: "Drew Call", channel: "calls", preview: "Voicemail", awaitingReply: true }),
    thread(2, { name: "Emery Call", channel: "calls", preview: "Missed call", awaitingReply: true }),
    thread(3, { name: "Finley Call", channel: "calls", direction: "out", preview: "Call 3:12", awaitingReply: false }),
    thread(4, { name: "Gray Text", channel: "sms" }),
  ];
  const w = inboxWorld(threads);
  const out = await run(w, "find_conversations", SEARCH);
  const a = parse(out.content);
  assertEquals([a.calls, a.missedCallsOrVoicemails, a.waitingOnYou], [3, 2, 3]);
  assertEquals(a.rows.filter((r: R) => r.channel === "call").map((r: R) => Object.keys(r).sort().join(",")), Array(3).fill("at,channel,daysAgo,lastFrom,name,waiting"));
  assert(!/\bVoicemail\b|Missed call|3:12/.test(out.content), "a call's label never reaches Claude");
  w.done();
});

Deno.test("conversations: without phone access, calls alone is answered without a read, and all says it can't see them", async () => {
  const threads = [thread(1, { name: "Drew Call", channel: "calls", preview: "Voicemail" }), thread(2, { name: "Gray Text" })];
  const noPhone = (a: string) => a !== "phone";
  const w = inboxWorld(threads, { canRead: noPhone, inbox: { seesCalls: false } });
  assertEquals(parse((await run(w, "find_conversations", { ...SEARCH, channel: "calls" })).content), { cantSee: "calls", note: READS_SAID.noCalls });
  assertEquals(w.calls.length, 0);
  const a = parse((await run(w, "find_conversations", SEARCH)).content);
  assertEquals([a.cantSee, a.calls, a.rows.map((r: R) => r.name)], ["calls", undefined, ["Gray Text"]]);
  assert(a.notes.includes(READS_SAID.noCalls));
  w.done();
});

Deno.test("conversations: a date range stops paging at its start, leaves newer ones out, and says each customer shows once", async () => {
  const threads = Array.from({ length: 120 }, (_, i) => thread(i * 60, { name: `Hour ${i}` }));
  const w = inboxWorld(threads);
  const from = new Date(NOW - 30 * 3_600_000).toISOString(), to = new Date(NOW - 10 * 3_600_000).toISOString();
  const a = parse((await run(w, "find_conversations", { ...SEARCH, from, to })).content);
  // From is inclusive and to is not, as the ledger reads them: hours 11 to 30.
  assertEquals(a.rows.map((r: R) => r.name), Array.from({ length: 20 }, (_, i) => `Hour ${i + 11}`));
  assertEquals([a.found, a.searched], [20, { customers: 31, all: true }]);
  assertEquals(w.calls.length, 1, "page one already reached the start, so no second page");
  assert(a.notes.some((n: string) => /shows once/.test(n)));
  w.done();
});

Deno.test("conversations: past the newest pages it says so, and never 'none'", async () => {
  const threads = Array.from({ length: 260 }, (_, i) => thread(i));
  const w = inboxWorld(threads);
  const a = parse((await run(w, "find_conversations", { ...SEARCH, name: "Zelda" })).content);
  assertEquals([a.found, a.searched], [0, { customers: INBOX_PAGES * INBOX_PAGE, all: false }]);
  assert(a.notes.some((n: string) => /don't say there are no others/.test(n)));
  assertEquals(w.calls.length, INBOX_PAGES);
  // Read to the end, the same name is a plain "no one by that name".
  const small = inboxWorld(threads.slice(0, 30));
  const b = parse((await run(small, "find_conversations", { ...SEARCH, name: "Zelda" })).content);
  assertEquals([b.found, b.searched.all], [0, true]);
  assert(b.notes.some((n: string) => /No conversation under that name/.test(n)));
  w.done();
});

Deno.test("conversations: Customer Hub off and a lost page are the route's refusals, asked once", async () => {
  const hub = inboxWorld([thread(1)], { inbox: { refuse: { status: 403, error: "The Customer Hub is not part of your subscription - add it under Settings -> Billing." } } });
  assertEquals((await run(hub, "find_conversations", SEARCH)).content, SAID.noCrm);
  const own = inboxWorld([thread(1)], { inbox: { refuse: { status: 403, error: "Your access does not include Contacts. Ask an owner or admin." } } });
  assertEquals((await run(own, "find_conversations", SEARCH)).content, "Your access does not include Contacts. Ask an owner or admin.");
  const many = Array.from({ length: 120 }, (_, i) => thread(i));
  const first = inboxWorld(many, { inbox: { failOnPage: 1 } });
  assertEquals([(await run(first, "find_conversations", SEARCH)).content, first.calls.length], [SAID.readFailed, 1]);
  const second = inboxWorld(many, { inbox: { failOnPage: 2 } });
  const out = await run(second, "find_conversations", SEARCH);
  assertEquals([out.isError, out.content, second.calls.length], [true, SAID_LOOKUP.partial, 2]);
});

// ── Access, switches and the strict budget ──────────────────────────────────────────────────────────

const offeredNames = (w: ReturnType<typeof world>) => toolsFor(w.deps, w.s).map((d) => d.name).filter((n) => n === "look_at_billing" || n === "find_conversations");

Deno.test("access: billing needs Billing access and its own switch; conversations need contacts and the customers switch", async () => {
  assertEquals(offeredNames(billingWorld()), ["look_at_billing", "find_conversations"]);
  // View-as wearing a person: resolveTenant takes settings_billing away, so the tool isn't offered, and
  // a call to it anyway reads nothing.
  const wearing = billingWorld({ canRead: (a) => a !== "settings_billing", who: { clientId: "builder-a", userId: "u2", operatorEmail: "support@csmsynergy.test" } });
  assertEquals(offeredNames(wearing), ["find_conversations"]);
  assertEquals((await runTool(wearing.deps, wearing.s, "look_at_billing", OVERVIEW)).content, "That isn't available here right now.");
  assertEquals((await run(wearing, "look_at_billing", OVERVIEW)).content, SAID.noSee);
  assertEquals(wearing.calls.length, 0);
  const billingOff = billingWorld({ off: [BILLING_SWITCH] });
  assertEquals(offeredNames(billingOff), ["find_conversations"]);
  assertEquals((await run(billingOff, "look_at_billing", OVERVIEW)).content, SAID.switchedOff);
  const customersOff = billingWorld({ off: ["customers"] });
  assertEquals(offeredNames(customersOff), ["look_at_billing"]);
  assertEquals((await run(customersOff, "find_conversations", SEARCH)).content, SAID.switchedOff);
  const noContacts = billingWorld({ canRead: (a) => a !== "contacts" });
  assertEquals(offeredNames(noContacts), ["look_at_billing"]);
  assertEquals((await run(noContacts, "find_conversations", SEARCH)).content, SAID.noSee);
  for (const w of [wearing, billingOff, customersOff, noContacts]) {
    assertEquals(w.calls.length, 0);
    w.done();
  }
});

Deno.test("the budget: no strict tool, read names only, no cards, and customer words mark the turn", async () => {
  assertEquals(readsPiece.kinds, []);
  for (const t of readsPiece.tools) {
    assert(/^(look_|find_)/.test(t.def.name), t.def.name);
    assert(t.def.strict === undefined, `${t.def.name} is strict`);
    assert(!t.proposesChange, `${t.def.name} proposes a change`);
  }
  const offered = toolsFor(billingWorld().deps, billingWorld().s).filter((d) => d.name === "look_at_billing" || d.name === "find_conversations");
  assert(offered.every((d) => d.strict === undefined));
  assertEquals([tool("look_at_billing").customerWords, tool("find_conversations").customerWords], [undefined, true]);
  // Through the agent: a conversation search marks the turn, so no change tool follows it; billing doesn't.
  const w = world({ routes: { "portal-billing status": statusRoute(), "portal-settings crm_inbox": inboxRoute([thread(1, { name: "Ivy" })]) } });
  await runTool(w.deps, w.s, "look_at_billing", OVERVIEW);
  assertEquals(w.s.customerWordsRead, undefined);
  const out = await runTool(w.deps, w.s, "find_conversations", SEARCH);
  assert(!out.isError, out.content);
  assertEquals(w.s.customerWordsRead, true);
  w.done();
});
