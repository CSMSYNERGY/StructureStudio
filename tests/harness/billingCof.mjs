// Billing tab: the stored-card agreements and the operator's "on the phone?" choice (migration
// 317, the Visa/Mastercard stored-credential rules), driven for real on the COMPILED portal.
//
// portal-billing refuses a first card entry, a first top-up, every new subscription, switching
// automatic top-ups on and a card replacement unless the request carries the ticked agreement
// (`consent: { version, accepted: true }`), and refuses an operator's charge unless they say
// whether the owner asked on the phone (`cardholderPresent`). This proves the page asks for both,
// shows the sentence the server will record, and sends what the server needs:
//
//   a. a new builder at checkout: the subscription sentence, filled with today's charge and the
//      yearly renewal; checkout held until the box is ticked; the subscribe body carries the
//      consent, the token, and the card's last 4 + type off Collect.js's masked number.
//   b. a builder whose card a subscription saved (no top-up yet): the card line names it, the
//      first top-up needs the box (sentence names the card and amount), and automatic top-ups
//      say to add funds once first.
//   c. a builder past their first top-up: no box on Add funds, and none in its body; switching
//      automatic top-ups on shows the sentence with the typed amounts and the daily limit, Save
//      held until ticked; Replace card opens the card-update sentence and posts update_card.
//   d. an operator viewing a builder with no top-up agreement: the two phone answers, "not asked"
//      unavailable, Add funds held until one is chosen; the body says cardholderPresent: true.
//   e. an operator viewing a builder WITH one: "not asked" is allowed, the dialog says a receipt
//      goes out, and the body says cardholderPresent: false. No agreement box for an operator.
//   f. an auto top-up switched off by the server shows its sentence as written.
//
// The sentences come from _shared/cofConsent.ts itself (Node strips its types), so this checks
// the page against the one copy, not against a string pasted here.
//
// Supabase is stubbed at the network layer and Collect.js is a stand-in (billingFounding's
// idiom); nothing leaves the machine and no card exists.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root; SS_BASE overrides the address)
//   node tests/harness/billingCof.mjs              (exit 0 = every check held)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, shotsDir, BASE, REF, serveAppRoutes } from "./lib.mjs";
import {
  AUTO_TOPUP_DAILY_MAX, COF_CONSENT_TEMPLATES, COF_CONSENT_VERSION,
} from "../../supabase/functions/_shared/cofConsent.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const SHOTS = shotsDir("billing-cof");

const CLIENT = "harness-cof";
const OPS_CLIENT = "harness-ops";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000c0f07", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

const PLANS = ["monthly", "annual"].flatMap((iv) => [
  { feature: "simple_layout", name: "Simple Layout", mo: 19500, required: true, sort: 100 },
  { feature: "crm", name: "Built-in CRM", mo: 20000, required: false, sort: 62 },
].map((f) => {
  const price = iv === "annual" ? f.mo * 10 : f.mo;
  return {
    id: `${f.feature}_${iv}`, feature: f.feature, name: f.name, price_cents: price, billing_interval: iv, setup_fee_cents: 0,
    availability: "available", required: f.required, sort_order: f.sort, price_visible: true, operator_grantable: false,
    charge_cents: price, discount_percent: 0,
  };
}));
const COF = { version: COF_CONSENT_VERSION, templates: COF_CONSENT_TEMPLATES, autoTopupDailyMax: AUTO_TOPUP_DAILY_MAX };
const features = (on) => ({ simple_layout: on, crm: on });
const BASE_SUB = { id: "sub-1", plan_id: "simple_layout_annual", status: "active", price_cents: 195000, current_period_start: "2026-08-01T00:00:00Z", current_period_end: "2027-08-01T00:00:00Z", canceled_at: null, created_at: "2026-08-01T00:00:00Z", past_due_since: null };

function status({ hasCard, card = null, initial = false, auto = {}, active = false, operatorTopupAllowed = false }) {
  return {
    configured: true,
    entitlement: active
      ? { exempt: false, state: "active", locked: false, reason: "active", features: features(true), graceEndsAt: null, graceDays: 7, transitionEndsAt: null, granted: [] }
      : { exempt: false, state: "locked", locked: true, reason: "never_paid", features: features(false), graceEndsAt: null, graceDays: 7, transitionEndsAt: null, granted: [] },
    wallet: {
      balanceCents: 0, heldCents: 0, exempt: false, minTopupCents: 2000, maxTopupCents: 500000,
      autoTopup: { enabled: false, thresholdCents: null, amountCents: null, lastAt: null, disabledReason: null, ready: initial, agreed: false, dailyMax: AUTO_TOPUP_DAILY_MAX, ...auto },
      meters: [], transactions: [],
    },
    upgradeCredits: {},
    hasCard,
    card,
    cof: { ...COF, topupNeedsAgreement: !initial, operatorTopupAllowed },
    discount: { percent: 0, features: [] },
    plans: PLANS,
    subscriptions: active ? [BASE_SUB] : [],
    checkout: { tokenizationKey: "stub", collectJsUrl: "https://secure.example.invalid/token/Collect.js" },
  };
}

const { ok, failed, results } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, st = 200) => route.fulfill({ status: st, contentType: "application/json", headers: H, body: JSON.stringify(body) });

async function open(label, st, path, { operator = false, acceptDialogs = false } = {}) {
  const billing = [];
  const pageErrors = [];
  const dialogs = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    window.__collect = { started: 0 };
    let cb = null;
    window.CollectJS = {
      configure(cfg) { cb = cfg.callback; },
      // Collect.js hands back a token and a MASKED card: the page keeps only the last 4 and type.
      startPaymentRequest() { window.__collect.started++; setTimeout(() => cb && cb({ token: "harness-token", card: { number: "411111******4242", type: "visa", exp: "1230" } }), 50); },
    };
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("dialog", (d) => { dialogs.push(d.message()); (acceptDialogs ? d.accept() : d.dismiss()).catch(() => {}); });
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, !!operator);
    if (url.includes("/rest/v1/rpc/")) return json(route, false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: operator ? OPS_CLIENT : CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      if (new URL(url).searchParams.has("warm")) return json(route, { ok: true });
      billing.push(body);
      if (body.action === "status") {
        if (operator && !body.targetClientId) return json(route, { ...status({ hasCard: true, active: true }), entitlement: { exempt: true, state: "exempt", locked: false, reason: "internal", features: features(true) } });
        return json(route, st);
      }
      if (body.action === "wallet_transactions") return json(route, { rows: [], next_cursor: null });
      // Nothing is charged: every money action is answered as a stubbed success, and recorded.
      return json(route, { ok: true, balanceCents: 10000, created: [], failed: [], card: { last4: "4242", brand: "visa" } });
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, branding: {} });
      return json(route, { ok: true });
    }
    if (url.includes("/admin-catalog")) {
      if (body.action === "list_clients") return json(route, { ok: true, clients: [], features: [] });
      return json(route, { ok: true });
    }
    if (url.includes("/operator-portal")) {
      if (body.action === "get_portal") return json(route, { ok: true, clientId: body.clientId, companyName: body.clientId, designs: [], versions: [], capturedLeads: [] });
      return json(route, { ok: true, clients: [] });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  return { label, page, ctx, billing, pageErrors, dialogs };
}

const text = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, s, timeout = 15000) => page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const acts = (S, a) => S.billing.filter((b) => b.action === a);
const box = (page, id) => page.locator(`[data-cof-consent="${id}"]`);
const boxText = async (page, id) => ((await box(page, id).count()) ? (await box(page, id).first().innerText()).trim() : null);
const render = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const CONSENT = { version: COF_CONSENT_VERSION, accepted: true };
const shot = (S, name) => S.page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }).catch(() => {});

try {
  // ── a: a new builder at checkout ──
  {
    const S = await open("a", status({ hasCard: false }), "/settings/billing");
    await waitText(S.page, "Choose your features");
    const want = render(COF_CONSENT_TEMPLATES.subscription, { card: "this card", today: "$1,950 today", recurring: "$1,950 a year" });
    ok("a: the subscription sentence is shown, filled with today's charge and the yearly renewal", (await boxText(S.page, "subscription")) === want, String(await boxText(S.page, "subscription")));
    const btn = S.page.getByRole("button", { name: "Continue to secure card entry" });
    ok("a: checkout is held until the box is ticked", (await btn.count()) > 0 && await btn.first().isDisabled());
    await box(S.page, "subscription").locator("input").check();
    ok("a: …and opens once it is", !(await btn.first().isDisabled()));
    await shot(S, "a-checkout");
    await btn.first().click();
    await S.page.waitForTimeout(1200);
    const sub = acts(S, "subscribe")[0] || {};
    ok("a: the subscribe carries the agreement", JSON.stringify(sub.consent) === JSON.stringify(CONSENT), JSON.stringify(sub));
    ok("a: …and the tab marker portal-billing tells this tab from the pre-317 one by", sub.cofTab === COF_CONSENT_VERSION, JSON.stringify(sub));
    ok("a: …the token, and the card's last 4 and type (nothing else of the card)", sub.paymentToken === "harness-token" && JSON.stringify(sub.card) === JSON.stringify({ last4: "4242", brand: "visa" }), JSON.stringify(sub));
    ok("a: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // ── b: a builder whose card a subscription saved, before any top-up ──
  {
    const S = await open("b", status({ hasCard: true, card: { last4: "1881", brand: "visa" }, active: true }), "/settings/wallet");
    await waitText(S.page, "Add funds");
    ok("b: the card on file is named", (await text(S.page)).includes("Card on file: Visa ending 1881"));
    await S.page.getByRole("button", { name: "$100", exact: true }).first().click();
    const want = render(COF_CONSENT_TEMPLATES.topup, { card: "my card ending 1881", amount: "$100" });
    ok("b: the first top-up shows the top-up sentence, naming the card and the amount", (await boxText(S.page, "topup")) === want, String(await boxText(S.page, "topup")));
    const add = S.page.getByRole("button", { name: "Add $100", exact: true });
    ok("b: Add funds is held until the box is ticked", await add.first().isDisabled());
    await box(S.page, "topup").locator("input").check();
    await add.first().click();
    await S.page.waitForTimeout(800);
    const t = acts(S, "topup")[0] || {};
    ok("b: the top-up carries the agreement and no card entry (the card is on file)", JSON.stringify(t.consent) === JSON.stringify(CONSENT) && !t.paymentToken && t.amountCents === 10000, JSON.stringify(t));
    ok("b: automatic top-ups say to add funds once first", (await text(S.page)).includes("Add funds once yourself, then you can turn on automatic top-ups."));
    ok("b: …and offer no switch yet", (await S.page.getByText("Top up automatically", { exact: true }).count()) === 0);
    ok("b: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // ── c: a builder past their first top-up ──
  {
    const S = await open("c", status({ hasCard: true, card: { last4: "1881", brand: "visa" }, initial: true, active: true }), "/settings/wallet");
    await waitText(S.page, "Add funds");
    await S.page.getByRole("button", { name: "$100", exact: true }).first().click();
    ok("c: a later top-up asks for no agreement", (await box(S.page, "topup").count()) === 0);
    await S.page.getByRole("button", { name: "Add $100", exact: true }).first().click();
    await S.page.waitForTimeout(800);
    const t = acts(S, "topup")[0] || {};
    ok("c: …and sends none", t.amountCents === 10000 && !("consent" in t), JSON.stringify(t));

    await S.page.getByText("Top up automatically", { exact: true }).click();
    const inputs = S.page.locator('input[type="number"]');
    const n = await inputs.count();
    await inputs.nth(n - 2).fill("100");
    await inputs.nth(n - 1).fill("250");
    const want = render(COF_CONSENT_TEMPLATES.autoTopup, { card: "my card ending 1881", amount: "$250", threshold: "$100", dailyMax: String(AUTO_TOPUP_DAILY_MAX) });
    ok("c: switching automatic top-ups on shows the sentence with the typed amounts and the daily limit", (await boxText(S.page, "auto-topup")) === want, String(await boxText(S.page, "auto-topup")));
    const save = S.page.getByRole("button", { name: "Save", exact: true });
    ok("c: Save is held until it is ticked", await save.first().isDisabled());
    await box(S.page, "auto-topup").locator("input").check();
    await shot(S, "c-auto-topup");
    await save.first().click();
    await S.page.waitForTimeout(800);
    const set = acts(S, "topup_settings")[0] || {};
    ok("c: topup_settings carries the amounts and the agreement", set.enabled === true && set.thresholdCents === 10000 && set.amountCents === 25000 && JSON.stringify(set.consent) === JSON.stringify(CONSENT), JSON.stringify(set));

    await S.page.getByRole("button", { name: "Replace card", exact: true }).click();
    ok("c: Replace card shows the card-update sentence", (await boxText(S.page, "card-update")) === COF_CONSENT_TEMPLATES.cardUpdate, String(await boxText(S.page, "card-update")));
    const enter = S.page.getByRole("button", { name: "Enter the new card", exact: true });
    ok("c: …held until ticked", await enter.first().isDisabled());
    await box(S.page, "card-update").locator("input").check();
    await enter.first().click();
    await S.page.waitForTimeout(1200);
    const up = acts(S, "update_card")[0] || {};
    ok("c: update_card carries the token, the new card's last 4 and the agreement", up.paymentToken === "harness-token" && up.card?.last4 === "4242" && JSON.stringify(up.consent) === JSON.stringify(CONSENT), JSON.stringify(up));
    ok("c: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // ── d: an operator, builder with no top-up agreement ──
  {
    const S = await open("d", status({ hasCard: true, card: { last4: "1881", brand: "visa" }, active: true }), `/settings/wallet?view=${CLIENT}`, { operator: true, acceptDialogs: true });
    await waitText(S.page, "Add funds", 20000);
    await S.page.getByRole("button", { name: "$100", exact: true }).first().click();
    const radios = S.page.locator('[data-cof-phone="1"] input[type="radio"]');
    ok("d: the operator is asked whether the owner is on the phone", (await radios.count()) === 2);
    ok("d: …'not asked' is unavailable until the owner's own agreement covers it", await radios.nth(1).isDisabled());
    ok("d: no agreement box for an operator", (await box(S.page, "topup").count()) === 0);
    const add = S.page.getByRole("button", { name: "Add $100", exact: true });
    ok("d: Add funds is held until they answer", await add.first().isDisabled());
    await radios.nth(0).check();
    await add.first().click();
    await S.page.waitForTimeout(800);
    const t = acts(S, "topup")[0] || {};
    ok("d: the top-up says the owner asked on the phone", t.cardholderPresent === true && !("consent" in t) && t.cofTab === COF_CONSENT_VERSION, JSON.stringify(t));
    ok("d: no Replace card for an operator", (await S.page.getByRole("button", { name: "Replace card" }).count()) === 0);
    ok("d: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // ── e: an operator, builder with a top-up agreement ──
  {
    const S = await open("e", status({ hasCard: true, card: { last4: "1881", brand: "visa" }, initial: true, active: true, operatorTopupAllowed: true }), `/settings/wallet?view=${CLIENT}`, { operator: true, acceptDialogs: true });
    await waitText(S.page, "Add funds", 20000);
    await S.page.getByRole("button", { name: "$100", exact: true }).first().click();
    const radios = S.page.locator('[data-cof-phone="1"] input[type="radio"]');
    ok("e: 'not asked' is allowed once the owner has their own first top-up", !(await radios.nth(1).isDisabled()));
    await radios.nth(1).check();
    await S.page.getByRole("button", { name: "Add $100", exact: true }).first().click();
    await S.page.waitForTimeout(800);
    ok("e: the confirm says the owner will be emailed a receipt", S.dialogs.some((m) => m.includes("emailed a receipt")), JSON.stringify(S.dialogs));
    const t = acts(S, "topup")[0] || {};
    ok("e: the top-up says the owner did not ask", t.cardholderPresent === false, JSON.stringify(t));
    ok("e: an operator cannot switch automatic top-ups on", (await text(S.page)).includes("Only the owner can switch automatic top-ups on"));
    ok("e: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // ── f: switched off by the server ──
  {
    const reason = "Automatic top-ups now need your agreement and one top-up you make yourself. Add funds once, then switch them back on and tick the box.";
    const S = await open("f", status({ hasCard: true, card: { last4: "1881", brand: "visa" }, active: true, auto: { disabledReason: reason } }), "/settings/wallet");
    ok("f: the reason is shown as written", await waitText(S.page, `Automatic top-ups are off. ${reason}`));
    ok("f: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // ── After the review (2026-10-20) ─────────────────────────────────────────────────────────

  // g: an operator's "on the phone" answer is for ONE charge: a dismissed dialog clears it.
  {
    const S = await open("g", status({ hasCard: true, card: { last4: "1881", brand: "visa" }, initial: true, active: true, operatorTopupAllowed: true }), `/settings/wallet?view=${CLIENT}`, { operator: true, acceptDialogs: false });
    await waitText(S.page, "Add funds", 20000);
    await S.page.getByRole("button", { name: "$100", exact: true }).first().click();
    const radios = S.page.locator('[data-cof-phone="1"] input[type="radio"]');
    await radios.nth(0).check();
    await S.page.getByRole("button", { name: "Add $100", exact: true }).first().click();
    await S.page.waitForTimeout(600);
    ok("g: the dialog was shown and dismissed, so nothing was sent", S.dialogs.length === 1 && acts(S, "topup").length === 0, JSON.stringify(S.dialogs));
    ok("g: …and the answer is cleared: the next charge must be answered again", !(await radios.nth(0).isChecked()) && !(await radios.nth(1).isChecked()));
    ok("g: Add funds is held again until it is", await S.page.getByRole("button", { name: "Add $100", exact: true }).first().isDisabled());
    ok("g: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // h: an operator subscribing reads the owner the sentence and ticks that they agreed.
  {
    const S = await open("h", status({ hasCard: true, card: { last4: "1881", brand: "visa" }, active: true }), `/settings/billing?view=${CLIENT}`, { operator: true, acceptDialogs: true });
    await waitText(S.page, "Add features", 20000);
    // Put the CRM feature in the cart: a click on its name reaches the tile's own handler.
    await S.page.getByText("Built-in CRM", { exact: true }).first().click();
    const want = `The owner is on the phone, I read them this and they agreed: "${render(COF_CONSENT_TEMPLATES.subscription, { card: "my card ending 1881", today: "$2,000 today", recurring: "$2,000 a year" })}"`;
    ok("h: the operator is shown the sentence to read out, filled for this cart", (await boxText(S.page, "subscription-operator")) === want, String(await boxText(S.page, "subscription-operator")));
    ok("h: no builder box for an operator", (await box(S.page, "subscription").count()) === 0);
    const btn = S.page.getByRole("button", { name: `Subscribe ${CLIENT} with card on file` });
    ok("h: checkout is held until it is ticked", await btn.first().isDisabled());
    await box(S.page, "subscription-operator").locator("input").check();
    await btn.first().click();
    await S.page.waitForTimeout(1000);
    const sub = acts(S, "subscribe")[0] || {};
    ok("h: the subscribe says the owner is on the phone, carries the agreement and the tab marker", sub.cardholderPresent === true && JSON.stringify(sub.consent) === JSON.stringify(CONSENT) && sub.cofTab === COF_CONSENT_VERSION, JSON.stringify(sub));
    ok("h: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // i: an operator on a tenant whose automatic top-ups are on can only switch them off.
  {
    const S = await open("i", status({ hasCard: true, card: { last4: "1881", brand: "visa" }, initial: true, active: true, auto: { enabled: true, thresholdCents: 10000, amountCents: 25000, agreed: true } }), `/settings/wallet?view=${CLIENT}`, { operator: true });
    await waitText(S.page, "Top up automatically", 20000);
    await S.page.getByRole("button", { name: "Save", exact: true }).first().click();
    ok("i: Save with it still on says only the owner can change it (no box it cannot tick)", await waitText(S.page, "Only the owner can switch on or change automatic top-ups"));
    ok("i: …and sends nothing", acts(S, "topup_settings").length === 0);
    await S.page.getByText("Top up automatically", { exact: true }).click();
    await S.page.getByRole("button", { name: "Save", exact: true }).first().click();
    await S.page.waitForTimeout(800);
    const off = acts(S, "topup_settings")[0] || {};
    ok("i: switching it off goes through, with the tab marker and no agreement", off.enabled === false && off.cofTab === COF_CONSENT_VERSION && !("consent" in off), JSON.stringify(off));
    ok("i: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // j: an operator on a tenant with no card at all is told why Add funds is held.
  {
    const S = await open("j", status({ hasCard: false, active: true }), `/settings/wallet?view=${CLIENT}`, { operator: true });
    await waitText(S.page, "Add funds", 20000);
    await S.page.getByRole("button", { name: "$100", exact: true }).first().click();
    ok("j: the reason is on the page", (await text(S.page)).includes(`${CLIENT} has no card on file. The owner has to add funds once themselves.`));
    ok("j: and Add funds stays held", await S.page.getByRole("button", { name: "Add $100", exact: true }).first().isDisabled());
    await S.ctx.close();
  }

  // k: the daily cap the agreement names is shown when it is reached.
  {
    const S = await open("k", status({ hasCard: true, card: { last4: "1881", brand: "visa" }, initial: true, active: true, auto: { enabled: true, thresholdCents: 10000, amountCents: 25000, agreed: true, chargesLast24h: AUTO_TOPUP_DAILY_MAX } }), "/settings/wallet");
    ok("k: 'daily limit reached' is shown, not a silent switched-on auto top-up", await waitText(S.page, `Daily limit reached: ${AUTO_TOPUP_DAILY_MAX} automatic top-ups in the last 24 hours.`));
    await S.ctx.close();
  }
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
console.log(`screenshots: ${SHOTS}`);
process.exit(bad.length ? 1 : 0);
