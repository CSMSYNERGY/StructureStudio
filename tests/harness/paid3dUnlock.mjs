// Paying for 3D turns 3D on (2026-10-05, migration 270), driven for real on the COMPILED portal.
//
// Carolyn, on a live sign-up call (2026-09-16): a builder bought 3D View, Billing said Active, and
// the designer stayed locked until she switched 3D on by hand. The shell opened 3D off
// entitlement.granted alone, and a purchase never lands there. Now portal-billing also sends
// entitlement.paid, ssView3dOn (01-core.jsx) opens 3D on granted OR paid, and Billing's subscribe
// tells the shell to re-read the entitlement, so 3D appears without a reload.
//
// Scenarios, one fresh browser context each (nothing cached leaks between them):
//   A  PAID, NO GRANT ({granted: [], paid: [..., "view_3d"]}): the Designer has its 3D button,
//      Settings > Designer shows the 3D Style Calibration (and not the "isn't on" line), and the
//      3D Design page is the status page, not the teaser.
//   B  NEITHER ({granted: [], paid: ["simple_layout"]}): no 3D button, Settings > Designer says to add
//      3D on Billing, and the 3D Design page is an "Available now" card whose button opens Billing.
//   C  A SERVER THAT PREDATES `paid` (a comp in granted, no paid key): 3D on, as before.
//   D  BUY IT, NO RELOAD. An owner with a card on file starts with no 3D, buys 3D View on the Billing
//      tab, and then, in the same page (a marker set before the purchase survives), the Designer
//      has its 3D button and Settings > Designer shows the calibration. The shell asked for the
//      entitlement again after the purchase.
//   E  THE SAME IN VIEW-AS. An operator (whose OWN account has 3D) views a builder without it: no
//      3D. They buy 3D View for the builder (the confirm naming the builder is accepted), and the
//      builder's portal, still on screen, gets 3D without a reload. Every billing call carried the
//      builder's id.
//   F  THE PAYWALL, A PARTIAL FAILURE. A never-paid owner on the paywall checks out Simple Layout +
//      3D View; the base goes through and 3D comes back failed with "Do NOT try again". The status
//      answer now says unlocked, but the message (and the paywall holding it) stays on screen
//      until Continue, because the re-read that lifts the gate unmounts the message with it. After
//      Continue the paywall is gone.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine, nothing is
// bought: subscribe is answered by the stub). The designer's get_config comes from gableProbe.mjs.
// portal-billing's `status` answer has the real function's shape.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/paid3dUnlock.mjs             (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how to
// prove these checks can fail. Against the artifact before this change (86afa7a), A, D and E fail
// (3D stays locked with paid set, and nothing re-reads the entitlement after a purchase: one status
// call after subscribe, Billing's own), B fails only its new wording, and C passes. Against the
// artifact before the paywall hold, F fails: the re-read lifts the paywall and the message goes.
//
// Screenshots go to SS_SHOTS (else the OS temp dir; see lib.mjs shotsDir).
//
// Tenants and users here are made up. The repo is public: no real client id belongs in a fixture.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, shotsDir, collectErrors, BASE, REF, PASS_THROUGH_GET } from "./lib.mjs";
import { CONFIG as GABLE_CONFIG, FIXTURES } from "./gableProbe.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;
const SHOTS = shotsDir("paid-3d-unlock");
const TAG = ARTIFACT ? "-override" : "";

const BUILDER = "harness-paid3d";
const OPS = "harness-ops";
const CONFIG = { ...GABLE_CONFIG, clientId: BUILDER };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000033", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// ── portal-billing `status`, in the real function's shape ─────────────────────────────────────
const FEATURES = [
  { feature: "full_suite", name: "Structure Studio Suite", mo: 79500, sort: 110 },
  { feature: "simple_layout", name: "Simple Layout", mo: 19500, sort: 100, required: true },
  { feature: "view_3d", name: "3D View", mo: 25000, sort: 80, grantable: true },
  { feature: "crm", name: "Built-in CRM", mo: 20000, sort: 62 },
];
const PLANS = FEATURES.flatMap((f) => ["monthly", "annual"].map((iv) => {
  const price = iv === "annual" ? f.mo * 10 : f.mo;
  return {
    id: `${f.feature}_${iv}`, feature: f.feature, name: f.name, price_cents: price, billing_interval: iv,
    setup_fee_cents: 0, availability: "available", required: !!f.required, sort_order: f.sort, price_visible: true,
    operator_grantable: !!f.grantable, charge_cents: price, discount_percent: 0,
  };
}));
const SUB = (feature) => ({
  id: `sub-${feature}`, plan_id: `${feature}_annual`, status: "active", price_cents: 0,
  current_period_start: "2026-09-01T00:00:00Z", current_period_end: "2027-09-01T00:00:00Z", canceled_at: null,
  created_at: "2026-09-01T00:00:00Z", past_due_since: null,
});
// `ent` overrides the entitlement; `bought3d` adds the 3D subscription row.
function statusAnswer({ granted = [], paid = ["simple_layout"], noPaid = false, bought3d = false, extra = {} } = {}) {
  const entitlement = {
    exempt: false, state: "active", locked: false, reason: "active", graceEndsAt: null, graceDays: 7, transitionEndsAt: null,
    requiredRate: { monthlyCents: 19500, annualCents: 195000, listMonthlyCents: 19500, listAnnualCents: 195000, discountPercent: 0 },
    features: { full_suite: false, simple_layout: true, view_3d: granted.includes("view_3d") || paid.includes("view_3d"), crm: false },
    granted, ...(noPaid ? {} : { paid }), ...extra,
  };
  return {
    configured: true, entitlement,
    wallet: { balanceCents: 0, heldCents: 0, exempt: false, minTopupCents: 2000, maxTopupCents: 500000, autoTopup: { enabled: false, thresholdCents: null, amountCents: null, lastAt: null, disabledReason: null }, meters: [], transactions: [] },
    upgradeCredits: {}, hasCard: true, discount: { percent: 0, features: [] }, plans: PLANS,
    subscriptions: [SUB("simple_layout"), ...(bought3d ? [SUB("view_3d")] : [])],
    checkout: { tokenizationKey: "stub", collectJsUrl: "https://secure.example.invalid/token/Collect.js" },
  };
}

const { ok, failed } = reporter();
const { browser, ctx: unused } = await launch({ width: 1440, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// S: { own, operator?, statusFor(target) → answer, onSubscribe?(target) }
async function open(S, path) {
  const calls = [];   // every portal-billing request: { action, target, at }
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });

  // Catch-all abort FIRST: Playwright runs matching routes in reverse registration order.
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => {
    const req = route.request();
    if (req.method() === "GET" && PASS_THROUGH_GET.test(req.url())) return route.continue();
    return route.abort();
  });
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      const name = rpc[1];
      if (name === "get_config") return json(route, CONFIG);
      if (name === "get_fixtures") return json(route, FIXTURES);
      if (name === "is_operator") return json(route, !!S.operator);
      return json(route, false);   // is_support_operator, can_open_projects, log_error, …
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: S.own, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      if (new URL(url).searchParams.has("warm")) return json(route, { ok: true });
      const target = body.targetClientId || null;
      calls.push({ action: body.action, target, at: Date.now() - t0 });
      if (body.action === "status") return json(route, S.statusFor(target));
      if (body.action === "subscribe") {
        // Nothing is bought: the stub records the cart and answers as the server does on success.
        calls[calls.length - 1].planIds = body.planIds;
        if (S.onSubscribe) S.onSubscribe(target, body);
        return json(route, S.subscribeAnswer ? S.subscribeAnswer(target, body) : { ok: true, failed: [] });
      }
      return json(route, { error: `Harness stub: unexpected portal-billing action ${body.action}` }, 400);
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") {
        const cid = body.targetClientId || S.own;
        return json(route, { ok: true, clientId: cid, role: "owner", settings: { business_name: cid }, config: { company_name: cid, accent_color: "#3D3672" }, access: null, prefs: null });
      }
      if (body.action === "catalog") return json(route, { ok: true, aiReady: false, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      return json(route, { ok: true });
    }
    if (url.includes("/operator-portal")) {
      if (body.action === "get_portal") return json(route, { ok: true, clientId: body.clientId, companyName: "Acme Sheds", designs: [], versions: [], capturedLeads: [] });
      return json(route, { ok: true, clients: [{ clientId: BUILDER, companyName: "Acme Sheds" }] });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(`**/${REF}.storage.supabase.co/**`, handler);
  // What _redirects does in production: every /portal/<page> is portal.html.
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));

  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  return { ctx, page, calls, errors, dialogs };
}

const waitText = (page, s, timeout = 20000) =>
  page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
// The app's own client-side routing: a history entry plus the popstate the shell listens to. No
// navigation, so the page (and every marker set on window) survives it.
const go = (page, pathname) => page.evaluate((p) => {
  history.pushState({}, "", p + location.search);
  dispatchEvent(new PopStateEvent("popstate", { state: {} }));
}, pathname);
// The designer's 3D button (toolbar): "🧊 Show 3D", "🧊 Hide 3D" (docked) or "🧊 3D ✓".
const threeDButton = (page) => page.locator(".ssd-tb-btn").filter({ hasText: /🧊 (Show 3D|Hide 3D|3D ✓)/u });
async function designerHas3D(page, { expect }) {
  await go(page, "/portal/designer");
  await page.waitForSelector(".ssd-frame.is-embedded", { timeout: 60000 });
  // The designer's toolbar exists either way; the 3D button is in it or not. When it should be
  // there, wait for it; when it should not, give the page time to draw one before saying no.
  if (expect) return threeDButton(page).first().waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
  await page.waitForTimeout(2500);
  return (await threeDButton(page).count()) > 0;
}
async function settingsDesigner(page) {
  await go(page, "/portal/settings/designer");
  await waitText(page, "Give each building style its own 3D look");
  // The section loads the designer module; give whichever answer it draws time to draw.
  await page.waitForFunction(() => {
    const t = document.body.innerText;
    return t.includes("3D Style Calibration") || t.includes("3D isn't on for this account yet") || t.includes("3D is on for this account");
  }, null, { timeout: 60000 }).catch(() => {});
  const t = await page.evaluate(() => document.body.innerText);
  return { calibration: t.includes("3D Style Calibration"), teaser: t.includes("3D isn't on for this account yet. Add 3D on the Billing page") };
}
async function view3dPage(page) {
  await go(page, "/portal/view-3d");
  await page.waitForFunction(() => /Customers can spin their design in 3D|Let a shopper turn their floor plan/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  return page.evaluate(() => {
    const t = document.body.innerText;
    // The card's own badge only: the sidebar has a "Coming Soon" group of its own on a beta host.
    const badge = [...document.querySelectorAll("span")]
      .filter((s) => /^(available now|coming soon)$/i.test(s.textContent.trim()) && s.parentElement && s.parentElement.textContent.includes("3D Design"))
      .map((s) => s.textContent.trim().toLowerCase());
    return {
      status: t.includes("Customers can spin their design in 3D"), teaser: t.includes("Let a shopper turn their floor plan"),
      available: badge.includes("available now"), comingSoon: badge.includes("coming soon"),
    };
  });
}
// The plan tiles of the Billing tab (billingFounding.mjs's reader): tag each with its name.
const tagTiles = (page) => page.evaluate(() => {
  const head = [...document.querySelectorAll("div")].find((d) => d.children.length === 0 && /^(Choose your features|Add features)$/.test(d.textContent.trim()));
  if (!head) return [];
  const grid = [...head.parentElement.children].find((c) => getComputedStyle(c).display === "grid");
  if (!grid) return [];
  return [...grid.children].map((t) => {
    const content = t.lastElementChild;
    const nameEl = content && content.querySelector("span");
    const name = nameEl ? nameEl.textContent.trim() : "";
    t.setAttribute("data-harness-tile", name);
    return name;
  });
});
async function buy3d(page) {
  await go(page, "/portal/settings/billing");
  await page.waitForFunction(() => /Add features|Choose your features/.test(document.body.innerText), null, { timeout: 30000 });
  const names = await tagTiles(page);
  const tile = page.locator('[data-harness-tile="3D View"]');
  if (!(await tile.count())) return { ok: false, why: `no 3D View tile in ${JSON.stringify(names)}` };
  await tile.scrollIntoViewIfNeeded();
  await tile.click({ position: { x: 14, y: 14 } });
  await page.waitForTimeout(300);
  const btn = page.getByRole("button", { name: /^Subscribe .*with card on file$/ });
  if (!(await btn.count())) return { ok: false, why: "no checkout button" };
  await btn.first().click();
  const done = await waitText(page, "You're subscribed");
  return { ok: done, why: done ? "" : "no success message" };
}

try {
  // ── A: paid, no grant ─────────────────────────────────────────────────────────────────────
  {
    const S = { own: BUILDER, statusFor: () => statusAnswer({ granted: [], paid: ["simple_layout", "view_3d"], bought3d: true }) };
    const { ctx, page, errors } = await open(S, "/portal/designs");
    ok(`A${TAG}: paid 3D, no grant: the Designer has its 3D button`, await designerHas3D(page, { expect: true }));
    await page.screenshot({ path: join(SHOTS, `A-designer${TAG}.png`) });
    const sd = await settingsDesigner(page);
    ok(`A${TAG}: Settings > Designer shows the 3D Style Calibration`, sd.calibration, JSON.stringify(sd));
    ok(`A${TAG}: …and not the "isn't on" line`, !sd.teaser, JSON.stringify(sd));
    await page.screenshot({ path: join(SHOTS, `A-settings-designer${TAG}.png`) });
    const v = await view3dPage(page);
    ok(`A${TAG}: the 3D Design page is the status page, not the teaser`, v.status && !v.teaser, JSON.stringify(v));
    ok(`A${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── B: neither ────────────────────────────────────────────────────────────────────────────
  {
    const S = { own: BUILDER, statusFor: () => statusAnswer({ granted: [], paid: ["simple_layout"] }) };
    const { ctx, page, errors } = await open(S, "/portal/designs");
    ok(`B${TAG}: no grant, nothing paid: no 3D button`, !(await designerHas3D(page, { expect: false })));
    const sd = await settingsDesigner(page);
    ok(`B${TAG}: Settings > Designer says to add 3D on Billing, with no calibration`, sd.teaser && !sd.calibration, JSON.stringify(sd));
    await page.screenshot({ path: join(SHOTS, `B-settings-designer${TAG}.png`) });
    const v = await view3dPage(page);
    ok(`B${TAG}: the 3D Design page is the teaser`, v.teaser && !v.status, JSON.stringify(v));
    if (!ARTIFACT) {
      ok("B: …an \"Available now\" card, not \"Coming soon\"", v.available && !v.comingSoon, JSON.stringify(v));
      const cta = page.getByRole("button", { name: "Add 3D — see Billing" });
      ok("B: …with an Add 3D button for the owner", (await cta.count()) === 1);
      await page.screenshot({ path: join(SHOTS, "B-view3d.png") });
      if (await cta.count()) {
        await cta.click();
        await page.waitForFunction(() => location.pathname === "/portal/settings/billing", null, { timeout: 10000 }).catch(() => {});
        ok("B: …which opens Billing", (await page.evaluate(() => location.pathname)) === "/portal/settings/billing");
      }
    }
    ok(`B${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── C: a server that predates `paid` ─────────────────────────────────────────────────────
  {
    const S = { own: BUILDER, statusFor: () => statusAnswer({ granted: ["view_3d"], noPaid: true }) };
    const { ctx, page, errors } = await open(S, "/portal/designs");
    ok(`C${TAG}: a comp from a server with no paid field: 3D on, as before`, await designerHas3D(page, { expect: true }));
    ok(`C${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── D: buy it, no reload ─────────────────────────────────────────────────────────────────
  {
    let bought = false;
    const S = {
      own: BUILDER,
      statusFor: () => statusAnswer(bought ? { paid: ["simple_layout", "view_3d"], bought3d: true } : { paid: ["simple_layout"] }),
      onSubscribe: (_t, body) => { if ((body.planIds || []).includes("view_3d_annual")) bought = true; },
    };
    const { ctx, page, calls, errors } = await open(S, "/portal/designs");
    ok(`D${TAG}: before buying: no 3D button`, !(await designerHas3D(page, { expect: false })));
    await page.evaluate(() => { window.__harnessSamePage = "still here"; });
    const r = await buy3d(page);
    ok(`D${TAG}: bought 3D View on the Billing tab (stubbed; nothing charged)`, r.ok && bought, r.why);
    const sub = calls.find((c) => c.action === "subscribe");
    ok(`D${TAG}: …the cart was the annual 3D plan`, !!sub && JSON.stringify(sub.planIds) === JSON.stringify(["view_3d_annual"]), JSON.stringify(sub));
    await page.waitForTimeout(800);
    const after = calls.filter((c) => c.action === "status" && sub && c.at >= sub.at);
    // One is Billing's own refresh of its plan list; the shell's re-read is the second.
    ok(`D${TAG}: the shell asked for the entitlement again after the purchase`, after.length >= 2, `${after.length} status call(s) after subscribe`);
    ok(`D${TAG}: the Designer now has its 3D button`, await designerHas3D(page, { expect: true }));
    await page.screenshot({ path: join(SHOTS, `D-designer-after-buying${TAG}.png`) });
    const sd = await settingsDesigner(page);
    ok(`D${TAG}: Settings > Designer now shows the calibration`, sd.calibration && !sd.teaser, JSON.stringify(sd));
    ok(`D${TAG}: all without a reload`, (await page.evaluate(() => window.__harnessSamePage)) === "still here");
    ok(`D${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── E: the same, in view-as ──────────────────────────────────────────────────────────────
  {
    let bought = false;
    const S = {
      own: OPS, operator: true,
      // The operator's own account has 3D (a comp); the viewed builder does not, until bought.
      statusFor: (target) => (target === BUILDER
        ? statusAnswer(bought ? { paid: ["simple_layout", "view_3d"], bought3d: true } : { paid: ["simple_layout"] })
        : statusAnswer({ granted: ["view_3d"], paid: ["simple_layout"] })),
      onSubscribe: (target, body) => { if (target === BUILDER && (body.planIds || []).includes("view_3d_annual")) bought = true; },
    };
    const { ctx, page, calls, errors, dialogs } = await open(S, `/portal/designs?view=${BUILDER}`);
    await page.waitForFunction(() => /Viewing|Exit/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
    ok(`E${TAG}: viewing a builder without 3D: no 3D button (the operator's own comp does not leak in)`, !(await designerHas3D(page, { expect: false })));
    await page.evaluate(() => { window.__harnessSamePage = "still here"; });
    const r = await buy3d(page);
    ok(`E${TAG}: bought 3D View for the builder (stubbed; nothing charged)`, r.ok && bought, r.why);
    ok(`E${TAG}: …after the confirm that names the builder`, dialogs.some((d) => /Subscribe .* to 1 feature/.test(d)), dialogs.join(" | "));
    const sub = calls.find((c) => c.action === "subscribe");
    ok(`E${TAG}: …and the purchase was for the builder, not the operator's own account`, !!sub && sub.target === BUILDER, JSON.stringify(sub));
    await page.waitForTimeout(800);
    ok(`E${TAG}: the builder's portal now has the 3D button`, await designerHas3D(page, { expect: true }));
    await page.screenshot({ path: join(SHOTS, `E-viewas-after-buying${TAG}.png`) });
    ok(`E${TAG}: all without a reload, still in view-as`, (await page.evaluate(() => [window.__harnessSamePage, new URLSearchParams(location.search).get("view")])).join() === `still here,${BUILDER}`);
    const afterStatus = calls.filter((c) => c.action === "status" && sub && c.at >= sub.at);
    ok(`E${TAG}: every billing read after the purchase was for the builder`, afterStatus.length >= 2 && afterStatus.every((c) => c.target === BUILDER), JSON.stringify(afterStatus));
    ok(`E${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── F: the paywall keeps a partial failure on screen until Continue ──────────────────────
  {
    const DO_NOT_RETRY = "We could not confirm whether your card was charged. Do NOT try again - contact us so we can check it for you.";
    let started = false;
    const never = () => {
      const a = statusAnswer({ paid: [], extra: { locked: true, state: "locked", reason: "never_paid" } });
      return { ...a, entitlement: { ...a.entitlement, features: { full_suite: false, simple_layout: false, view_3d: false, crm: false } }, subscriptions: [] };
    };
    const S = {
      own: BUILDER,
      // Locked until the checkout; after it the base is live, so the server says unlocked.
      statusFor: () => (started ? statusAnswer({ paid: ["simple_layout"] }) : never()),
      onSubscribe: () => { started = true; },
      subscribeAnswer: () => ({ ok: true, created: [{ planId: "simple_layout_annual" }], failed: [{ planId: "view_3d_annual", error: DO_NOT_RETRY }] }),
    };
    const { ctx, page, calls, errors } = await open(S, "/portal/designs");
    ok(`F${TAG}: a never-paid owner is on the paywall`, await waitText(page, "Activate your account"));
    await page.waitForFunction(() => /Choose your features|Add features/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
    const names = await tagTiles(page);
    const tile = page.locator('[data-harness-tile="3D View"]');
    let bought = false;
    if (await tile.count()) {
      await tile.scrollIntoViewIfNeeded();
      await tile.click({ position: { x: 14, y: 14 } });
      await page.waitForTimeout(300);
      const btn = page.getByRole("button", { name: /^Subscribe .*with card on file$/ });
      if (await btn.count()) { await btn.first().click(); bought = true; }
    }
    ok(`F${TAG}: checked out Simple Layout + 3D View on the paywall (stubbed; nothing charged)`, bought, JSON.stringify(names));
    const sub = calls.find((c) => c.action === "subscribe");
    ok(`F${TAG}: …the cart was the base and 3D`, !!sub && JSON.stringify([...(sub.planIds || [])].sort()) === JSON.stringify(["simple_layout_annual", "view_3d_annual"]), JSON.stringify(sub));
    ok(`F${TAG}: the "Do NOT try again" message appears`, await waitText(page, "Do NOT try again"));
    await page.waitForTimeout(3000);
    const held = await page.evaluate((m) => {
      const t = document.body.innerText;
      return { message: t.includes(m), paywall: t.includes("Activate your account") };
    }, DO_NOT_RETRY);
    ok(`F${TAG}: 3 s later the message is still on screen`, held.message, JSON.stringify(held));
    ok(`F${TAG}: …and so is the paywall that holds it (the shell has not re-read yet)`, held.paywall, JSON.stringify(held));
    if (held.message) await page.getByText("Do NOT try again").first().scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: join(SHOTS, `F-paywall-partial-failure${TAG}.png`) });
    const cont = page.getByRole("button", { name: "Continue", exact: true });
    ok(`F${TAG}: a Continue button sits with the message`, (await cont.count()) === 1);
    if (await cont.count()) {
      await cont.first().click();
      const lifted = await page.waitForFunction(() => !document.body.innerText.includes("Activate your account"), null, { timeout: 20000 }).then(() => true, () => false);
      ok(`F${TAG}: Continue re-reads the entitlement and the paywall is gone`, lifted);
      await page.screenshot({ path: join(SHOTS, `F-after-continue${TAG}.png`) });
    }
    ok(`F${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
}

const bad = failed();
console.log(bad.length ? `\n${bad.length} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
console.log(`screenshots: ${SHOTS}`);
process.exitCode = bad.length ? 1 : 0;
