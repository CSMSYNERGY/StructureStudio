// Paying for 3D turns 3D on (2026-10-05, migration 270), driven through the SHIPPED portal-billing
// handler and pinned against the SHIPPED portal sources.
//
// WHY THIS EXISTS. Carolyn, on a live sign-up call (2026-09-16): a builder bought 3D View, Billing
// said Active, and the designer stayed locked until she switched 3D on by hand. The portal opened
// 3D off entitlement.granted alone, and a purchase never lands there. The fix has four parts, and
// each is held here:
//
//   1. portal-billing's entitlement gains `paid`: every feature whose featureState is usable (active;
//      past_due inside the 7-day grace; cancelled but inside the period already paid for), the Suite
//      expanded into what it includes. `granted` and `features` do not change.
//   2. ssView3dOn (01-core.jsx) is 3D's ONE rule: granted OR paid names view_3d, never `features`.
//      The shell's view3dUnlocked asks it in both branches (own portal, view-as).
//   3. One refetch counter: Billing's subscribe and cancel raise ssEntitlementChanged, and the shell
//      re-reads its own entitlement and, in view-as, the viewed tenant's, so no reload is needed.
//   4. The public designer's get_config asks the same question through ss_view3d_paid. Its rule is
//      a copy of featureState's; the constants it shares with featureCheck/portal-billing are pinned
//      at the bottom so a change to one fails the push until the other follows.
//      (tests/sql/migration270.test.cjs runs the SQL itself, against the real paidThroughOf.)
//
// HOW. walletTransactions_test's idiom: Deno.serve is stubbed while portal-billing/index.ts is
// imported, and the import map swaps supabase-js for supabase_stub.ts, whose stubDb hook routes
// every table read into the fake below. No --allow-net: nothing here can reach a real database, and
// nothing is bought (`status` is a read; subscribe is never called).
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE, as in walletTransactions_test: a literal one puts
// portal-billing in this file's type-checked graph against the stub's partial client type.
//
// Tenants, users and plans here are made up. The repo is public: no real client id belongs in a
// fixture.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";
import { BUNDLE_FEATURES } from "../featureCheck.ts";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const CORE = await read("../../../../portal/01-core.jsx");
const SHELL = await read("../../../../portal/12-shell.jsx");
const CATALOG = await read("../../../../portal/03-catalog.jsx");
const ADMIN = await read("../../../../portal/07-admin.jsx");
const DESIGNER = await read("../../../../portal/06-3d.jsx");
const SETTINGS_SHELL = await read("../../../../portal/08-integrations.jsx");
const BILLING = await read("../../portal-billing/index.ts");
const FEATURE_CHECK = await read("../featureCheck.ts");
const MIGRATION = await read("../../../migrations/270_paid_3d_unlock.sql");

function between(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`paid3dUnlock_test: could not find ${label} (start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`);
  }
  return src.slice(i, j);
}
/** Same, with whole-line comments dropped, so a comment naming a token cannot satisfy a check. */
const codeBetween = (src: string, start: string, end: string, label: string) =>
  between(src, start, end, label).split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
try {
  await import(new URL("../../portal-billing/index.ts", import.meta.url).href);
} finally {
  (Deno as any).serve = realServe;
}
if (!handler) throw new Error("portal-billing did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

// ─── The catalogue, in billing_plans' shape: 3D is grantable (as live), the rest is not ────────
const PLANS = [
  { id: "full_suite_annual", feature: "full_suite", billing_interval: "annual", required: false, operator_grantable: false, active: true },
  { id: "simple_layout_annual", feature: "simple_layout", billing_interval: "annual", required: true, operator_grantable: false, active: true },
  { id: "crm_annual", feature: "crm", billing_interval: "annual", required: false, operator_grantable: false, active: true },
  { id: "view_3d_monthly", feature: "view_3d", billing_interval: "monthly", required: false, operator_grantable: true, active: true },
  { id: "view_3d_annual", feature: "view_3d", billing_interval: "annual", required: false, operator_grantable: true, active: true },
  // A retired price point: a subscription on it is still a subscription (portal-billing planById).
  { id: "view_3d_old", feature: "view_3d", billing_interval: "annual", required: false, operator_grantable: true, active: false },
].map((p, i) => ({
  ...p, name: p.feature, price_cents: 10000, gateway_plan_id: `HARNESS_${p.id.toUpperCase()}`, setup_fee_cents: 0,
  availability: "available", sort_order: 100 - i, price_visible: true,
}));

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
type World = {
  tenant?: string;
  role?: "owner" | "user";
  settings?: Record<string, unknown>;
  subs?: Record<string, unknown>[];
  grants?: Record<string, unknown>[];
};
type Trace = { db: any[][]; errors: Record<string, unknown>[] };

const USER_ID = "00000000-0000-4000-8000-00000000f003";
const TENANT = "harness-builder";
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? [])[1];

function answer(world: World, trace: Trace, table: string, ops: any[][]): any {
  const tenant = world.tenant ?? TENANT;
  const one = (row: unknown) => ({ data: row ?? null, error: null });
  const mine = (rows: Record<string, unknown>[] | undefined) => (rows ?? []).filter((r) => (r.client_id ?? tenant) === tenant).map((r) => ({ ...r }));
  switch (table) {
    case "client_users":
      return { data: [{ client_id: tenant, role: world.role ?? "owner", title: null, access: null }], error: null };
    case "app_operators":
      return one(null);
    case "client_configs":
      return one({ client_id: tenant });
    case "admin_audit":
      return { data: null, error: null };
    case "app_errors":
      trace.errors.push(argOf(ops, "insert"));
      return { data: null, error: null };
    case "billing_plans":
      return { data: PLANS.map((p) => ({ ...p })), error: null };
    case "billing_subscriptions":
      return { data: mine(world.subs), error: null };
    case "client_feature_grants":
      return { data: mine(world.grants), error: null };
    case "billing_customers":
      return one(null);
    case "client_settings":
      return one(world.settings ?? { billing_exempt: false, internal_account: false, discount_percent: 0 });
    case "wallet_accounts":
      return one({ balance_cents: 0, held_cents: 0, metered_exempt: false, auto_topup_enabled: false });
    case "usage_prices":
    case "wallet_transactions":
      return { data: [], error: null };
  }
  throw new Error(`the fake database has no answer for ${table} ${JSON.stringify(ops)}`);
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "is", "in", "not", "or", "limit", "order", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    trace.db.push([table, ...ops]);
    return Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  };
  return q;
}

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

async function status(world: World = {}) {
  const trace: Trace = { db: [], errors: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`TEST FAILURE: unexpected fetch to ${url}`));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/portal-billing", {
      method: "POST",
      headers: { "authorization": "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action: "status" }),
    }));
    const body = await res.json();
    return { status: res.status, body, trace };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const DAY = 86400000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const sub = (id: string, plan_id: string, status: string, over: Record<string, unknown> = {}) =>
  ({ id, plan_id, status, price_cents: 10000, current_period_start: null, current_period_end: null, canceled_at: null, created_at: at(-400 * DAY), past_due_since: null, ...over });
const BASE = sub("s-base", "simple_layout_annual", "active", { current_period_end: at(300 * DAY) });

// ─── 1. The paid list, case by case ────────────────────────────────────────────────────────────
// The same cases, by the same names, as migration270.test.cjs runs against ss_view3d_paid: the two
// readers of "has this builder paid for 3D" must give one answer.
const CASES: [string, Record<string, unknown>, boolean][] = [
  ["active 3D, monthly", sub("s", "view_3d_monthly", "active", { current_period_end: at(10 * DAY) }), true],
  ["active 3D with no period end at all", sub("s", "view_3d_annual", "active"), true],
  ["active Suite", sub("s", "full_suite_annual", "active", { current_period_end: at(100 * DAY) }), true],
  ["active 3D on a RETIRED plan row", sub("s", "view_3d_old", "active", { current_period_end: at(100 * DAY) }), true],
  ["past_due 3 days (inside the 7-day grace)", sub("s", "view_3d_annual", "past_due", { past_due_since: at(-3 * DAY) }), true],
  ["past_due 6 days 23 hours", sub("s", "view_3d_annual", "past_due", { past_due_since: at(-7 * DAY + 3600000) }), true],
  ["past_due 7 days 1 minute (grace over)", sub("s", "view_3d_annual", "past_due", { past_due_since: at(-7 * DAY - 60000) }), false],
  ["past_due 30 days", sub("s", "view_3d_monthly", "past_due", { past_due_since: at(-30 * DAY) }), false],
  ["past_due with no timestamp (grace from now)", sub("s", "view_3d_monthly", "past_due"), true],
  ["cancelled, period end still ahead", sub("s", "view_3d_annual", "cancelled", { current_period_end: at(40 * DAY), canceled_at: at(-2 * DAY) }), true],
  ["cancelled before its first period ended, now past", sub("s", "view_3d_annual", "cancelled", { current_period_end: at(-2 * DAY), canceled_at: at(-40 * DAY) }), false],
  ["cancelled monthly: renewed once, then cancelled", sub("s", "view_3d_monthly", "cancelled", { current_period_end: at(-40 * DAY), canceled_at: at(-5 * DAY) }), true],
  ["cancelled monthly: renewed, cancelled, period over", sub("s", "view_3d_monthly", "cancelled", { current_period_end: at(-100 * DAY), canceled_at: at(-60 * DAY) }), false],
  ["cancelled annual: renewed once, still paid up", sub("s", "view_3d_annual", "cancelled", { current_period_end: at(-400 * DAY), canceled_at: at(-10 * DAY) }), true],
  ["cancelled Suite inside its paid year", sub("s", "full_suite_annual", "cancelled", { current_period_end: at(200 * DAY), canceled_at: at(-1 * DAY) }), true],
  ["cancelled, no period end (bill-in-arrears row)", sub("s", "view_3d_annual", "cancelled", { canceled_at: at(-1 * DAY) }), false],
  ["paused", sub("s", "view_3d_annual", "paused", { current_period_end: at(100 * DAY) }), false],
];

for (const [name, s, want] of CASES) {
  Deno.test(`paid: ${name} → 3D ${want ? "on" : "off"}`, async () => {
    const r = await status({ subs: [BASE, s] });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const e = r.body.entitlement;
    assert(Array.isArray(e.paid), "entitlement.paid is missing");
    assertEquals(e.paid.includes("view_3d"), want, `paid = ${JSON.stringify(e.paid)}`);
    // `granted` is grants (and exempt comps) only: a purchase never shows up there.
    assertEquals(e.granted, [], "a purchase leaked into granted");
    // features.view_3d (grantable: grant OR usable subscription) agrees, for an ordinary tenant.
    assertEquals(e.features.view_3d, want, "features.view_3d disagrees with paid");
    assertEquals(r.trace.errors, []);
  });
}

Deno.test("paid: the Suite is expanded into what it includes, and the list is sorted", async () => {
  const r = await status({ subs: [sub("s", "full_suite_annual", "active", { current_period_end: at(100 * DAY) })] });
  const want = ["full_suite", ...BUNDLE_FEATURES.full_suite].sort();
  assertEquals(r.body.entitlement.paid, want);
});

Deno.test("paid: another tenant's subscription confers nothing", async () => {
  const r = await status({ subs: [BASE, { ...sub("s", "view_3d_annual", "active"), client_id: "someone-else" }] });
  assertEquals(r.body.entitlement.paid, ["simple_layout"]);
});

// ─── 2. granted stays exactly what it was ──────────────────────────────────────────────────────
Deno.test("the live shape: paid AND a hand grant — both lists name 3D, granted unchanged", async () => {
  const r = await status({ subs: [BASE, sub("s", "view_3d_annual", "active", { current_period_end: at(300 * DAY) })], grants: [{ feature: "view_3d", expires_at: null }] });
  assertEquals(r.body.entitlement.granted, ["view_3d"]);
  assertEquals(r.body.entitlement.paid, ["simple_layout", "view_3d"]);
});

Deno.test("a comp alone: granted names 3D, paid does not", async () => {
  const r = await status({ subs: [BASE], grants: [{ feature: "view_3d", expires_at: null }] });
  assertEquals(r.body.entitlement.granted, ["view_3d"]);
  assertEquals(r.body.entitlement.paid, ["simple_layout"]);
});

Deno.test("an expired comp and no purchase: 3D is off in both lists", async () => {
  const r = await status({ subs: [BASE], grants: [{ feature: "view_3d", expires_at: at(-DAY) }] });
  assertEquals(r.body.entitlement.granted, []);
  assertEquals(r.body.entitlement.paid, ["simple_layout"]);
  assertEquals(r.body.entitlement.features.view_3d, false);
});

Deno.test("a non-billable account: comps in granted as before, and NO blanket in paid", async () => {
  const r = await status({ settings: { billing_exempt: true, internal_account: false, discount_percent: 0 } });
  assertEquals(r.body.entitlement.granted, ["view_3d"], "exempt accounts get grantable features as comps (migration 228)");
  assertEquals(r.body.entitlement.paid, [], "paid lists only what is paid for");
  assertEquals(r.body.entitlement.features.crm, true, "features keeps its blanket, untouched");
});

Deno.test("someone without Billing still gets paid (it rides on the entitlement, not the commercial detail)", async () => {
  const r = await status({ role: "user", subs: [BASE, sub("s", "view_3d_annual", "active", { current_period_end: at(30 * DAY) })] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.entitlement.paid, ["simple_layout", "view_3d"]);
  assertEquals(r.body.plans, [], "the commercial half is still withheld");
  assertEquals(r.body.subscriptions, []);
});

// ─── 3. The portal: one rule, both branches, and a refetch without a reload ───────────────────
const CLAMP_FREE = between(CORE, "function ssView3dOn(", "\n}\n", "ssView3dOn in 01-core.jsx") + "\n}\n";
const ssView3dOn = new Function(`${CLAMP_FREE}; return ssView3dOn;`)() as (e: unknown) => boolean;

Deno.test("ssView3dOn: granted OR paid names view_3d; features never counts; no answer is off", () => {
  assertEquals(ssView3dOn(null), false);
  assertEquals(ssView3dOn(undefined), false);
  assertEquals(ssView3dOn({}), false, "an entitlement with neither list (an older server) is off");
  assertEquals(ssView3dOn({ granted: ["view_3d"] }), true, "a comp, from a server that predates `paid`");
  assertEquals(ssView3dOn({ granted: [], paid: ["view_3d"] }), true, "a purchase");
  assertEquals(ssView3dOn({ granted: ["view_3d"], paid: ["view_3d"] }), true);
  assertEquals(ssView3dOn({ granted: [], paid: ["full_suite", "simple_layout", "view_3d"] }), true, "the Suite, expanded by the server");
  assertEquals(ssView3dOn({ granted: [], paid: ["full_suite"] }), false, "the browser does not expand bundles; the server does");
  assertEquals(ssView3dOn({ granted: [], paid: [], features: { view_3d: true } }), false, "the features blanket must never open 3D");
  assertEquals(ssView3dOn({ granted: "view_3d", paid: "view_3d" }), false, "only real lists count");
});

Deno.test("view3dUnlocked asks ssView3dOn in BOTH branches, with no operator blanket", () => {
  const block = codeBetween(SHELL, "const view3dUnlocked =", "const effClientId =", "view3dUnlocked");
  assert(block.includes("? (!viewedCtx || ssView3dOn(viewedCtx.entitlement))"), "view-as must read the VIEWED tenant through ssView3dOn");
  assert(block.includes(": ssView3dOn(entitlement);"), "your own portal must read your own entitlement through ssView3dOn");
  assert(!/granted\.indexOf|\.features/.test(block), "view3dUnlocked reads a list directly again");
  assert(!/isOperator\s*\|\|/.test(block), "view3dUnlocked has grown an `isOperator ||` blanket again");
});

Deno.test("one refetch counter: declared above both entitlement reads, in both their deps, bumped by the event", () => {
  const decl = SHELL.indexOf("const [entitlementRev, setEntitlementRev] = useState(0);");
  assert(decl > 0, "entitlementRev is gone");
  const own = SHELL.indexOf("}, [session.access_token, viewing, entitlementRev]);");
  const viewed = SHELL.indexOf("}, [mirrorView, viewing && viewing.clientId, session.access_token, entitlementRev]);");
  assert(own > decl, "your own entitlement effect does not refetch on the counter (or sits above its declaration)");
  assert(viewed > decl, "the view-as entitlement effect does not refetch on the counter (or sits above its declaration)");
  const listen = codeBetween(SHELL, "const [entitlementRev, setEntitlementRev] = useState(0);", "// Fetches the entitlement declared above", "the listener");
  assert(listen.includes("window.addEventListener(SS_ENTITLEMENT_CHANGED, bump);"));
  assert(listen.includes("window.removeEventListener(SS_ENTITLEMENT_CHANGED, bump);"));
  assert(listen.includes("setEntitlementRev((n) => n + 1)"));
  // The viewed tenant's effect really is the one that reads portal-billing for view-as.
  const viewedEffect = codeBetween(SHELL, "const [viewedCtx, setViewedCtx] = useState(null);", "}, [mirrorView, viewing && viewing.clientId, session.access_token, entitlementRev]);", "viewedCtx effect");
  assert(viewedEffect.includes(`sb.functions.invoke("portal-billing", { body: { action: "status" } })`));
});

Deno.test("the event: 01-core raises it on window, and Billing raises it after subscribe and after cancel", () => {
  const fire = codeBetween(CORE, "const SS_ENTITLEMENT_CHANGED =", "\n}\n", "ssEntitlementChanged");
  assert(fire.includes("window.dispatchEvent(new Event(SS_ENTITLEMENT_CHANGED))"));
  const subscribe = codeBetween(CATALOG, "const subscribe = async () => {", "const cancel = async (s) => {", "BillingView subscribe");
  const call = subscribe.indexOf(`await sb.functions.invoke("portal-billing", { body });`);
  const raise = subscribe.indexOf("ssEntitlementChanged();");
  assert(call > 0 && raise > call, "subscribe must raise ssEntitlementChanged once the server has answered");
  assert(subscribe.indexOf("if (e) {") > raise, "raise it BEFORE the error branch: a partial success still changed the entitlement");
  assert(subscribe.indexOf("if (demoView)") < call, "the demo account still stops before anything is sent");
  const cancel = codeBetween(CATALOG, "const cancel = async (s) => {", "const SUB_BADGE = {", "BillingView cancel");
  assert(cancel.indexOf("ssEntitlementChanged();") > cancel.indexOf(`action: "cancel"`), "cancel must raise ssEntitlementChanged after the server answers");
});

Deno.test("on the PAYWALL, a checkout short of a clean success keeps its message until Continue", () => {
  // The re-read that lifts the gate unmounts BillingGate and the BillingView in it, message and all,
  // and a partial failure's message can be "do NOT try again" or a charge reference.
  assert(/\? <BillingView paywall \/>/.test(ADMIN), "BillingGate must mount its BillingView with `paywall`");
  assert(CATALOG.includes(`function BillingView({ viewingLabel = null, section = "all", paywall = false }) {`), "BillingView lost its paywall prop");
  const subscribe = codeBetween(CATALOG, "const subscribe = async () => {", "const cancel = async (s) => {", "BillingView subscribe");
  assert(subscribe.includes("const clean = !e && r && !r.error && !(r.failed && r.failed.length);"), "the clean-success test changed");
  assert(subscribe.includes("if (paywall && !clean) setHoldSignal(true); else ssEntitlementChanged();"), "the paywall hold is gone");
  assert(subscribe.indexOf("setHoldSignal(false)") < subscribe.indexOf(`await sb.functions.invoke("portal-billing", { body });`), "a new checkout must clear an old hold first");
  // The Continue button: only while held, and it is what raises the signal then.
  const view = codeBetween(CATALOG, "function BillingView(", "\nfunction ", "BillingView");
  const btn = view.indexOf("{holdSignal ? (<>");
  assert(btn > 0 && view.indexOf("onClick={() => { setHoldSignal(false); ssEntitlementChanged(); }}", btn) > btn, "the Continue button must clear the hold and raise the signal");
  assert(view.indexOf("{msg && msg.err && (") < btn, "Continue sits in the error message, where the outcome is read");
  // Not held, the box is the bare sentence it always was (billingFounding e reads it whole).
  assert(view.includes("</>) : msg.err}"), "outside a hold the error box must stay the bare sentence");
});

Deno.test("Settings → Designer points at Billing only for someone who can open it", () => {
  const ds = codeBetween(DESIGNER, "function DesignerSettings(", "\nfunction DesignerTab(", "DesignerSettings");
  assert(DESIGNER.includes("function DesignerSettings({ clientId, setup3d = null, view3d = false, canBill = false, advanced = null }) {"), "canBill must default to false (no pointer)");
  const yes = ds.indexOf(`"3D isn't on for this account yet. Add 3D on the Billing page and it switches on right away. "`);
  const no = ds.indexOf(`"3D isn't on for this account yet. Ask your account owner to add 3D on the Billing page. "`);
  assert(ds.includes("{canBill") && yes > ds.indexOf("{canBill") && no > yes, "both branches, keyed on canBill: the pointer for a biller, ask-the-owner for everyone else");
  assert(/sub === "designer" && <DesignerSettings [^>]*canBill=\{canBill\}/.test(SETTINGS_SHELL), "SettingsShell must pass canBill through");
  assert(/canBill=\{billingActor\}/.test(SHELL), "the shell's canBill is billingActor, the paywall's own test");
});

Deno.test("3D is buyable in the setup checklist's words", () => {
  assert(/view_3d:\s*\{ label: "3D",\s*buyable: true \}/.test(CORE), "SS_FEATURE_LABELS.view_3d must be buyable: the plans are on sale");
});

// ─── 4. Never a grant on purchase, and the SQL copy of the rule keeps step ─────────────────────
Deno.test("portal-billing never writes a grant: paying is enough, and hand grants are Carolyn's to manage", () => {
  const code = BILLING.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const grantOps = [...code.matchAll(/from\("client_feature_grants"\)([^;]*)/g)].map((m) => m[1]);
  assert(grantOps.length >= 1, "the grant read moved; re-point this check");
  for (const op of grantOps) assert(!/\.(insert|upsert|update|delete)\(/.test(op), `portal-billing writes client_feature_grants: ${op.slice(0, 120)}`);
  assert(code.includes("paid: [...featureState].filter(([, st]) => st.usable).map(([f]) => f).sort(),"), "the paid list is no longer featureState's usable set");
});

Deno.test("ss_view3d_paid keeps featureCheck's and portal-billing's constants", () => {
  const graceOf = (src: string, label: string) => {
    const m = src.match(/const GRACE_DAYS = (\d+);/);
    if (!m) throw new Error(`could not read GRACE_DAYS from ${label}`);
    return Number(m[1]);
  };
  const grace = graceOf(FEATURE_CHECK, "featureCheck.ts");
  assertEquals(graceOf(BILLING, "portal-billing"), grace, "portal-billing and featureCheck disagree on the grace period");
  assert(MIGRATION.includes(`coalesce(r.past_due_since, now()) + interval '${grace * 24} hours' > now()`),
    `ss_view3d_paid's grace is not GRACE_DAYS (${grace}) * 24 hours`);
  // Which plan features confer 3D: the feature itself and every bundle that includes it.
  const conferring = ["view_3d", ...Object.keys(BUNDLE_FEATURES).filter((b) => BUNDLE_FEATURES[b].includes("view_3d"))];
  const sqlList = conferring.map((f) => `'${f}'`).join(", ");
  assert(MIGRATION.includes(`and p.feature in (${sqlList})`), `ss_view3d_paid must count exactly ${sqlList}`);
  const billingBundle = BILLING.match(/full_suite: \[([^\]]*)\]/);
  assert(billingBundle && billingBundle[1] === FEATURE_CHECK.match(/full_suite: \[([^\]]*)\]/)![1], "portal-billing and featureCheck list different Suite members");
  // Paid-through: billingPeriods' 240-step cap and yearly test.
  assert(MIGRATION.includes("while v_i < 240 and v_end <= v_until loop"), "the roll-forward lost paidThroughOf's 240 cap or its <=");
  assert(MIGRATION.includes("lower(coalesce(r.billing_interval, '')) ~ '^(year|annual)'"), "the yearly test drifted from addInterval's /^(year|annual)/");
});
