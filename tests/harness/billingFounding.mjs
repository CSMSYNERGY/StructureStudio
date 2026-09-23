// Billing tab: our own account shows the prospect view, and founding pricing is yearly only
// (Carolyn 2026-09-24), driven for real on the COMPILED portal.
//
// Two asks, one tab:
//   1. Structure Studio's own login demos the Billing tab to prospects. Since 784be79 (09-21) every
//      billing_exempt account got the green "comped" banner, no Founding Price banner and an
//      "Included" veil over every tile. The internal account (portal-billing reports it as
//      entitlement.reason "internal") now sees what a new builder sees, but checkout can never
//      charge it: the button reads like a new builder's, and pressing it only shows a note.
//   2. While founding pricing is open, everybody pays yearly. Monthly still shows on every plan
//      tile, dimmed with a hover hint, and clicking it does nothing. The transition banner in the
//      shell quotes the yearly rate only.
//
// Scenarios, one fresh browser context each:
//   a. structure-studio (exempt, reason "internal", card on file): Founding banner, prices, tiles
//      that select, the new-builder button label; pressing it shows the demo note and sends NO
//      subscribe. Monthly is there with aria-disabled + the hover title and leaves the tile on /yr.
//   b. support-demo (exempt, reason "exempt"): still comped, exactly as before. Comped banner,
//      every tile veiled "Included", no cart, and no plan-tile interval toggle at all.
//   c. a new builder (reason "never_paid", no card, so the shell shows BillingGate with the
//      picker embedded): Founding banner, prices, checkout. The Monthly checks as in a. Pressing
//      checkout goes through the (stubbed) Collect.js lightbox and posts a subscribe whose plan
//      ids are all *_annual; the stub declines it and the page shows that.
//   d. a transition tenant with a 10% discount: the shell's banner quotes /yr only.
//
// Monthly checks only ever look at PLAN-TILE toggles (button[data-plan-interval]). The Synergy CRM
// card has its own Monthly/Yearly buttons; they are a display-only toggle beside an external
// sign-up link, deliberately untouched, and must never satisfy a check here.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the
// portal-billing `status` answer has the real function's full shape (portal-billing/index.ts,
// `if (action === "status")`). Every portal-billing request body is recorded. Collect.js is the
// one other stub: window.CollectJS is defined before the app boots and hands back a fixed token,
// because the real script is the gateway's (the checkout's collectJsUrl points at an .invalid
// host, which the catch-all aborts anyway). getPaymentToken uses window.CollectJS when it is
// already there, so the page's own code path runs unchanged up to the network.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/billingFounding.mjs          (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how to
// prove these checks can fail. Against origin/beta 2551500 (before this change), a fails (the
// comped view: no Founding banner, veiled tiles, no checkout), c fails its monthly checks (no
// data-plan-interval hook; the tile's own Monthly button switches it to /mo and the subscribe
// body carries *_monthly ids) and d fails (the banner quotes "/mo or /yr"). b passes on both.
//
// Screenshots of a and c go to SS_SHOTS (else the OS temp dir; see lib.mjs shotsDir).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, shotsDir, BASE, REF } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;
const SHOTS = shotsDir("billing-founding");
const SHOT_TAG = ARTIFACT ? "-override" : "";

const CLIENT = "harness-billing";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000007", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// ── The plan list, monthly + annual PAIRS, in the shape `status` sends (gateway_plan_id and
// `active` stripped, charge_cents + discount_percent added). Yearly is 10x monthly, as live.
const FEATURES = [
  { feature: "full_suite",          name: "Structure Studio Suite",       mo: 79500, avail: "available",   sort: 110 },
  { feature: "simple_layout",       name: "Simple Layout",                mo: 19500, avail: "available",   sort: 100, required: true },
  { feature: "on_demand_pricing",   name: "RealTime Pricing",             mo: 7500,  avail: "available",   sort: 90 },
  { feature: "view_3d",             name: "3D View",                      mo: 27500, avail: "available",   sort: 80 },
  { feature: "schedule_builds",     name: "Schedule Builds and Delivery", mo: 25000, avail: "available",   sort: 70 },
  { feature: "quickbooks_sync",     name: "QuickBooks Sync",              mo: 15000, avail: "available",   sort: 65 },
  { feature: "crm",                 name: "Built-in CRM",                 mo: 20000, avail: "available",   sort: 62 },
  { feature: "self_serve_displays", name: "Self Serve Displays",          mo: 50000, avail: "coming_soon", sort: 60 },
];
const AVAILABLE_TILES = FEATURES.filter((f) => f.avail === "available").length;
function plansFor(discountPercent = 0) {
  const cut = (c) => Math.round(c * (100 - discountPercent) / 100);
  return FEATURES.flatMap((f) => ["monthly", "annual"].map((iv) => {
    const price = iv === "annual" ? f.mo * 10 : f.mo;
    return {
      id: `${f.feature}_${iv}`, feature: f.feature, name: f.name, price_cents: price, billing_interval: iv,
      setup_fee_cents: 0, availability: f.avail, required: !!f.required, sort_order: f.sort, price_visible: true,
      operator_grantable: false, charge_cents: cut(price), discount_percent: discountPercent,
    };
  }));
}
const allFeatures = (on) => Object.fromEntries(FEATURES.map((f) => [f.feature, on]));
const rateFor = (discountPercent) => {
  const cut = (c) => Math.round(c * (100 - discountPercent) / 100);
  return { monthlyCents: cut(19500), annualCents: cut(195000), listMonthlyCents: 19500, listAnnualCents: 195000, discountPercent };
};
const WALLET = {
  balanceCents: 0, heldCents: 0, exempt: false, minTopupCents: 2000, maxTopupCents: 500000,
  autoTopup: { enabled: false, thresholdCents: null, amountCents: null, lastAt: null, disabledReason: null },
  meters: [], transactions: [],
};
function statusAnswer({ entitlement, hasCard, discountPercent = 0 }) {
  return {
    configured: true,
    entitlement: { graceEndsAt: null, graceDays: 7, transitionEndsAt: null, requiredRate: rateFor(discountPercent), granted: [], ...entitlement },
    wallet: WALLET,
    upgradeCredits: {},
    hasCard,
    discount: { percent: discountPercent, features: [] },
    plans: plansFor(discountPercent),
    subscriptions: [],
    checkout: { tokenizationKey: "stub", collectJsUrl: "https://secure.example.invalid/token/Collect.js" },
  };
}

const TENANTS = {
  // structure-studio: internal_account, billing_exempt, a card on file, 0% discount.
  a: statusAnswer({ hasCard: true, entitlement: { exempt: true, state: "exempt", locked: false, reason: "internal", features: allFeatures(true) } }),
  // support-demo: billing_exempt only.
  b: statusAnswer({ hasCard: false, entitlement: { exempt: true, state: "exempt", locked: false, reason: "exempt", features: allFeatures(true) } }),
  // A brand-new builder: nothing paid, so the server reports locked / never_paid.
  c: statusAnswer({ hasCard: false, entitlement: { exempt: false, state: "locked", locked: true, reason: "never_paid", features: allFeatures(false) } }),
  // A dated free period with a 10% founding discount.
  d: statusAnswer({
    hasCard: false, discountPercent: 10,
    entitlement: {
      exempt: false, state: "transition", locked: false, reason: "transition", features: allFeatures(true),
      transitionEndsAt: new Date(Date.now() + 12 * 86400000).toISOString(),
    },
  }),
};
const DECLINE = "Harness stub: the card was declined, and nothing was charged.";

const { ok, failed, results } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// One fresh context per scenario: nothing the portal caches in storage can leak between them.
async function open(label, status, path = "/portal/settings/billing") {
  const billing = [];   // every portal-billing request body, in order
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    // Collect.js stand-in: records what the lightbox would have been told, then hands back a token.
    window.__collect = { configured: [], started: 0 };
    let cb = null;
    window.CollectJS = {
      configure(cfg) { cb = cfg.callback; window.__collect.configured.push({ price: cfg.price, buttonText: cfg.buttonText, instructionText: cfg.instructionText }); },
      startPaymentRequest() { window.__collect.started++; setTimeout(() => cb && cb({ token: "harness-token" }), 50); },
    };
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // Catch-all abort FIRST: Playwright runs matching routes in reverse registration order.
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/log_error")) return json(route, null);
    if (url.includes("/rest/v1/rpc/")) return json(route, false);   // is_operator, is_support_operator, can_open_projects, …
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      // ssWarmFn's cold-start ping (?warm=1, body {}) is recorded too, marked, so "what did the
      // page ask portal-billing for" can leave it out without hiding it.
      const warm = new URL(url).searchParams.has("warm");
      billing.push(warm ? { ...body, warm: true } : body);
      if (warm) return json(route, { ok: true });
      if (body.action === "status") return json(route, status);
      // Anything that would move money is answered with a refusal: nothing here is ever "bought".
      if (body.action === "subscribe") return json(route, { error: DECLINE }, 402);
      return json(route, { error: `Harness stub: unexpected portal-billing action ${body.action}` }, 400);
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, branding: {} });
      return json(route, { ok: true });
    }
    if (url.includes("/admin-catalog")) {
      if (body.action === "list_clients") return json(route, { ok: true, clients: [], features: [] });
      if (body.action === "get_master") return json(route, { ok: true, layoutItemTypes: [] });
      return json(route, { ok: true });
    }
    if (url.includes("/operator-portal")) return json(route, { ok: true, clients: [] });
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  // What _redirects does in production: every /portal/<page> is portal.html.
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));

  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  return { label, page, ctx, billing, pageErrors };
}

const text = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, s, timeout = 15000) =>
  page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const actions = (S, a) => S.billing.filter((b) => b.action === a);
const realCalls = (S) => S.billing.filter((b) => !b.warm);

// The plan tiles, read from the "Choose your features" / "Add features" card only. Tags each tile
// with data-harness-tile so a locator can reach it; React leaves an attribute it never set alone.
const tiles = (page) => page.evaluate(() => {
  const head = [...document.querySelectorAll("div")].find((d) => d.children.length === 0 && /^(Choose your features|Add features)$/.test(d.textContent.trim()));
  if (!head) return [];
  const grid = [...head.parentElement.children].find((c) => getComputedStyle(c).display === "grid");
  if (!grid) return [];
  return [...grid.children].map((t) => {
    const content = t.lastElementChild;
    const nameEl = content && content.querySelector("span");
    const name = nameEl ? nameEl.textContent.trim() : "";
    t.setAttribute("data-harness-tile", name);
    const toggles = [...t.querySelectorAll("button")].filter((b) => /^(Monthly|Yearly)$/.test(b.textContent.trim()));
    const yearly = toggles.find((b) => b.textContent.trim() === "Yearly");
    return {
      name,
      selected: getComputedStyle(t).borderTopWidth === "2px",
      overlay: t.children.length > 1 ? t.firstElementChild.innerText.trim() : null,
      price: ((content && content.innerText) || "").match(/\$[\d,.]+\/(yr|mo)/)?.[0] || null,
      toggleCount: toggles.length,
      // Which interval the tile's own toggle shows as chosen (the filled one). overlay is read
      // through innerText, so it arrives in the veil's text-transform: uppercase.
      yearlyOn: yearly ? getComputedStyle(yearly).color === "rgb(255, 255, 255)" : null,
    };
  });
});
const tile = async (page, name) => (await tiles(page)).find((t) => t.name === name) || null;
const tileLoc = (page, name) => page.locator(`[data-harness-tile="${name}"]`);
// The plan tile's Monthly button: the data-plan-interval hook, else (an artifact older than the
// hook) the tile's own button labelled Monthly. Both are scoped to ONE plan tile, so neither can
// reach the Synergy CRM card.
async function tileMonthly(page, name) {
  const t = tileLoc(page, name);
  const hooked = t.locator('button[data-plan-interval="monthly"]');
  if (await hooked.count()) return { loc: hooked.first(), hooked: true };
  const plain = t.getByRole("button", { name: "Monthly", exact: true });
  return { loc: (await plain.count()) ? plain.first() : null, hooked: false };
}
// force: an aria-disabled button fails Playwright's "enabled" actionability check, but a person
// can still click it, and that click is exactly what must do nothing.
async function clickMonthly(page, name) {
  const m = await tileMonthly(page, name);
  if (!m.loc) return false;
  await m.loc.scrollIntoViewIfNeeded();
  await m.loc.click({ force: true });
  await page.waitForTimeout(300);
  return true;
}
const selectTile = async (page, name) => {
  await tileLoc(page, name).scrollIntoViewIfNeeded();
  await tileLoc(page, name).click({ position: { x: 14, y: 14 } });
  await page.waitForTimeout(300);
};
// Every data-plan-interval button on the page, and whether it sits inside a plan tile.
const intervalHooks = (page) => page.evaluate(() => [...document.querySelectorAll("button[data-plan-interval]")].map((b) => ({
  k: b.getAttribute("data-plan-interval"),
  inTile: !!b.closest("[data-harness-tile]"),
  ariaDisabled: b.getAttribute("aria-disabled"),
  title: b.getAttribute("title"),
  cursor: b.style.cursor,
  opacity: b.style.opacity,
  disabledProp: b.disabled,
})));
const checkoutButton = (page) => page.getByRole("button", { name: /^(Continue to secure card entry|Subscribe .*with card on file|Working…)$/ });
const HOVER_TITLE = "Annual billing only during founding pricing";

// The Monthly checks a and c share.
async function monthlyChecks(p, S, names) {
  const hooks = await intervalHooks(S.page);
  const monthly = hooks.filter((h) => h.k === "monthly");
  ok(`${p}: monthly: every available plan tile has a Monthly toggle with the data-plan-interval hook`, monthly.length === AVAILABLE_TILES,
    `${monthly.length} hooked Monthly buttons, ${AVAILABLE_TILES} available tiles`);
  ok(`${p}: monthly: every one is aria-disabled with the hover title, dimmed, not-allowed, and not \`disabled\``,
    monthly.length > 0 && monthly.every((h) => h.ariaDisabled === "true" && h.title === HOVER_TITLE && h.cursor === "not-allowed" && Number(h.opacity) < 1 && !h.disabledProp),
    JSON.stringify(monthly[0] || null));
  ok(`${p}: monthly: the Yearly toggles carry no such marking`, hooks.filter((h) => h.k === "annual").every((h) => h.ariaDisabled !== "true" && !h.title));
  ok(`${p}: monthly: the hook is on plan tiles only (never the Synergy CRM card)`, hooks.length > 0 && hooks.every((h) => h.inTile));
  const copy = await text(S.page);
  ok(`${p}: monthly: the tile copy says founding members pay yearly`, copy.includes("Founding members pay yearly"));
  for (const name of names.click) {
    const before = await tile(S.page, name);
    const clicked = await clickMonthly(S.page, name);
    const after = await tile(S.page, name);
    ok(`${p}: monthly: clicking Monthly on "${name}" leaves the tile on /yr`,
      clicked && !!after && /\/yr$/.test(after.price || "") && after.yearlyOn === true && after.selected === before.selected,
      `clicked=${clicked} price ${before && before.price} -> ${after && after.price}, yearly filled ${after && after.yearlyOn}`);
  }
  ok(`${p}: monthly: no "Monthly total" line in the cart`, !(await text(S.page)).includes("Monthly total"));
}

try {
  // ── a: structure-studio — the prospect view, with checkout switched off ──
  {
    const S = await open("a", TENANTS.a);
    const loaded = await waitText(S.page, "Choose your features");
    ok("a: the Billing tab loads its plan list", loaded);
    const t0 = await text(S.page);
    ok("a: the Founding Price banner shows", t0.includes("Founding Price") && t0.includes("Only for the first 15 builders"));
    ok("a: the comped banner does not", !t0.includes("Your account is comped"));
    const ts = await tiles(S.page);
    ok("a: no tile is veiled \"Included\"", ts.length > 0 && ts.every((t) => !/^included$/i.test(t.overlay || "")), JSON.stringify(ts.map((t) => t.overlay)));
    const base = ts.find((t) => t.name === "Simple Layout");
    ok("a: prices show (Simple Layout $1,950/yr, preselected)", !!base && base.price === "$1,950/yr" && base.selected, JSON.stringify(base));
    const sched0 = await tile(S.page, "Schedule Builds and Delivery");
    if (sched0 && !sched0.overlay) await selectTile(S.page, "Schedule Builds and Delivery");
    const sched1 = await tile(S.page, "Schedule Builds and Delivery");
    ok("a: a non-required tile selects on click", !!sched0 && !sched0.selected && !!sched1 && sched1.selected, `${sched0 && sched0.selected} -> ${sched1 && sched1.selected}`);
    ok("a: the cart counts it", (await text(S.page)).includes("Selected features: 2"));

    await monthlyChecks("a", S, { click: ["Schedule Builds and Delivery", "Simple Layout"] });

    const btn = checkoutButton(S.page);
    const label = (await btn.count()) ? (await btn.first().innerText()).trim() : null;
    ok("a: the checkout button reads \"Continue to secure card entry\" (a new builder's label, not the card-on-file one)", label === "Continue to secure card entry", String(label));
    if (label) {
      await btn.first().scrollIntoViewIfNeeded();
      await btn.first().click();
    }
    const noted = await waitText(S.page, "Demo account. Checkout is off", 5000);
    ok("a: pressing it shows the demo note", noted);
    await S.page.waitForTimeout(1500);   // anything the press set off has had time to go out
    ok("a: …and NO subscribe request was sent", actions(S, "subscribe").length === 0, JSON.stringify(actions(S, "subscribe")));
    ok("a: …and the Collect.js lightbox never opened", (await S.page.evaluate(() => window.__collect.started)) === 0);
    ok("a: the only portal-billing calls are status reads (plus the warm-up ping)", realCalls(S).length > 0 && realCalls(S).every((b) => b.action === "status"),
      S.billing.map((b) => (b.warm ? "warm" : b.action)).join(","));
    ok("a: the button is not left stuck on Working…", label ? (await btn.first().innerText()).trim() === "Continue to secure card entry" : false);
    await S.page.evaluate(() => window.scrollTo(0, 0));
    await S.page.screenshot({ path: join(SHOTS, `billing-a-structure-studio${SHOT_TAG}.png`), fullPage: true });
    ok("a: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // ── b: support-demo — still comped, exactly as before ──
  {
    const S = await open("b", TENANTS.b);
    const loaded = await waitText(S.page, "Choose your features");
    ok("b: the Billing tab loads its plan list", loaded);
    const t0 = await text(S.page);
    ok("b: the comped banner shows", t0.includes("Your account is comped"));
    ok("b: the Founding Price banner does not", !t0.includes("Only for the first 15 builders"));
    const ts = await tiles(S.page);
    ok("b: every tile is veiled \"Included\"", ts.length === FEATURES.length && ts.every((t) => /^included$/i.test(t.overlay || "")), JSON.stringify(ts.map((t) => t.overlay)));
    ok("b: no cart and no checkout button", !t0.includes("Selected features:") && (await checkoutButton(S.page).count()) === 0);
    ok("b: no plan-tile interval toggle renders (no data-plan-interval button)", (await intervalHooks(S.page)).length === 0);
    ok("b: …and no Monthly/Yearly button inside any plan tile", ts.every((t) => t.toggleCount === 0), JSON.stringify(ts.map((t) => t.toggleCount)));
    await selectTile(S.page, "Schedule Builds and Delivery");
    const sched = await tile(S.page, "Schedule Builds and Delivery");
    ok("b: clicking a tile selects nothing", !!sched && !sched.selected);
    ok("b: no subscribe request", actions(S, "subscribe").length === 0);
    ok("b: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // ── c: a brand-new builder — yearly only, all the way to the request ──
  {
    const S = await open("c", TENANTS.c);
    const loaded = await waitText(S.page, "Choose your features");
    ok("c: the plan picker loads (BillingGate, never_paid)", loaded && (await text(S.page)).includes("Activate your account"));
    const t0 = await text(S.page);
    ok("c: the Founding Price banner shows", t0.includes("Only for the first 15 builders"));
    ok("c: the comped banner does not", !t0.includes("Your account is comped"));
    const base = await tile(S.page, "Simple Layout");
    ok("c: prices show (Simple Layout $1,950/yr, preselected)", !!base && base.price === "$1,950/yr" && base.selected, JSON.stringify(base));
    await selectTile(S.page, "Schedule Builds and Delivery");
    const sched = await tile(S.page, "Schedule Builds and Delivery");
    ok("c: a non-required tile selects on click", !!sched && sched.selected);

    await monthlyChecks("c", S, { click: ["Simple Layout", "Schedule Builds and Delivery"] });

    const btn = checkoutButton(S.page);
    const label = (await btn.count()) ? (await btn.first().innerText()).trim() : null;
    ok("c: checkout shows, labelled \"Continue to secure card entry\"", label === "Continue to secure card entry", String(label));
    const dueText = (await text(S.page)).match(/Due today: \$[\d,.]+/)?.[0] || null;
    if (label) {
      await btn.first().scrollIntoViewIfNeeded();
      await btn.first().click();
    }
    const declined = await waitText(S.page, DECLINE, 10000);
    const subs = actions(S, "subscribe");
    const body = subs[0] || null;
    const ids = (body && body.planIds) || [];
    ok("c: pressing checkout sends exactly one subscribe", subs.length === 1, JSON.stringify(subs));
    ok("c: monthly: every plan id in it is *_annual", ids.length > 0 && ids.every((id) => /_annual$/.test(id)), JSON.stringify(ids));
    ok("c: monthly: it carries the two chosen features, yearly", ids.length === 2 && ids.includes("simple_layout_annual") && ids.includes("schedule_builds_annual"), JSON.stringify(ids));
    ok("c: monthly: confirmChargeCents is the yearly total ($4,450) and matches Due today", !!body && body.confirmChargeCents === 445000 && dueText === "Due today: $4,450",
      `${body && body.confirmChargeCents} / ${dueText}`);
    const collect = await S.page.evaluate(() => window.__collect);
    ok("c: monthly: the card lightbox was asked for the same yearly amount", collect.started === 1 && collect.configured.length === 1 && collect.configured[0].price === "4450.00", JSON.stringify(collect));
    ok("c: the request carries the lightbox's token", !!body && body.paymentToken === "harness-token");
    ok("c: the stubbed decline ends it, and the page says so", declined);
    ok("c: the button is usable again afterwards", label ? (await btn.first().innerText()).trim() === "Continue to secure card entry" : false);
    await S.page.evaluate(() => window.scrollTo(0, 0));
    await S.page.screenshot({ path: join(SHOTS, `billing-c-new-builder${SHOT_TAG}.png`), fullPage: true });
    ok("c: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // ── d: a transition tenant with a founding discount — the shell's banner is yearly only ──
  {
    const S = await open("d", TENANTS.d);
    const shown = await waitText(S.page, "Your account moves to a paid plan");
    ok("d: the transition banner shows", shown);
    const banner = shown
      ? await S.page.locator("span", { hasText: "Your account moves to a paid plan" }).last().innerText()
      : "";
    ok("d: it quotes the discounted yearly rate ($1,755/yr)", banner.includes("$1,755/yr"), banner);
    ok("d: …and no /mo figure", !banner.includes("/mo"), banner);
    ok("d: …with the discount", banner.includes("10% off for life"), banner);
    ok("d: no uncaught page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
console.log(`screenshots: ${SHOTS}`);
process.exit(bad.length ? 1 : 0);
