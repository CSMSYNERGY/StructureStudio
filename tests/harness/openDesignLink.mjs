// "Open design" is a real link, and Orders says why it isn't shown in view-as (2026-10-21), driven in
// the COMPILED portal with every call answered here.
//
// Carolyn 2026-10-20 opens things with the wheel ("I push the middle wheel so it opens up in a new
// tab"). "Open design" was a button holding the design in memory: a middle click did nothing, and a
// new tab or a reload of /designer showed an EMPTY designer ("this link does not work", "there is
// nothing in there"). And Orders in operator view-as showed a "Coming soon / Work in progress"
// teaser of example orders ("Why does it say work in progress?"). Held here:
//
//   L0 the order's "Open design" is an <a href="/designer?open=<code>">
//   L1 a MIDDLE click opens a new tab at the link's address, and that address, loaded cold, opens
//      THAT design (the designer's load_design asked for
//      the code), takes ?open= out of its address, and keeps the design in its history entry
//   L2 a reload of that tab opens the same design again
//   L3 a plain click opens it in place: no new tab, /designer, load_design for the code; a reload
//      of that entry opens it again
//   L4 Ctrl+click opens a new tab at the link's address too
//   L5 a cold /designer with no ?open= and no history opens nothing; and after an open, the next
//      page's address carries no ?open=
//   V  an operator viewing a builder: Orders says "Orders isn't shown while viewing as …" with an
//      "Exit view-as" button that leaves the account; no "Coming soon", no "Work in progress"
//   X  no uncaught page errors; nothing left the machine
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root, after npm run compile)
//   node tests/harness/openDesignLink.mjs          (exit 0 = every check held)
//
// The app's addresses (/orders/…, /designer) are answered from _redirects by serveAppRoutes, on the
// browser CONTEXT, so a tab the page opens gets them too. Names and codes are made up.
import { readFileSync } from "node:fs";
import { launch, reporter, serveAppRoutes, BASE, REF } from "./lib.mjs";
import { CONFIG as GABLE_CONFIG, FIXTURES } from "./gableProbe.mjs";

const CLIENT = "harness-open-design";
const OTHER = "other-sheds";
const CODE = "SS-HARNESSOD1";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000e2", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const ORDER_ID = "11111111-2222-4333-8444-5555555555e2";
const CONFIG = { ...GABLE_CONFIG, clientId: CLIENT };
const SIZE = GABLE_CONFIG.defaultSizes[0];
const DESIGN = {
  short_code: CODE, client_id: CLIENT, status: "sent", version: 1,
  selections: { style: "plain", size: SIZE, roofType: "", roofColor: "", cladding: "" },
  items: [], paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
  contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100", street: "", city: "", state: "", zip: "" },
  bldg_w: 12, bldg_h: 32,
};
const PORTAL_OVERRIDE = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

const S = { operator: false };
const loads = [];       // { page, code }: the designer's load_design calls
const offBox = [];

const { ok, failed, results } = reporter();
const { browser, ctx: plainCtx } = await launch({ width: 1280, height: 1000 });
// ⚠️ SERVICE WORKERS BLOCKED. Once the portal's sw.js is installed it answers the next navigation
// (a new tab, a reload) itself, and Playwright's routes never see it: /designer then went to the
// plain static server, which knows nothing of _redirects, and 404'd. The cold loads ARE the test.
await plainCtx.close();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
await ctx.addInitScript(([ref, s]) => {
  try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
}, [REF, SESSION]);
const pages = [];
const pageErrors = [];
ctx.on("page", (p) => { pages.push(p); p.on("pageerror", (e) => pageErrors.push(e.message)); });

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// Context-wide, first registered so everything below overrides it (Playwright runs routes in reverse).
await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => {
  const u = route.request().url();
  if (/^https:\/\/esm\.sh\//.test(u) && route.request().method() === "GET") return route.continue();
  offBox.push(new URL(u).host);
  return route.abort();
});
await serveAppRoutes(ctx);
const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  const rpc = /\/rest\/v1\/rpc\/([A-Za-z0-9_]+)/.exec(new URL(url).pathname);
  if (rpc) {
    const fn = rpc[1];
    if (fn === "get_config") return json(route, CONFIG);
    if (fn === "get_fixtures") return json(route, FIXTURES);
    if (fn === "load_design") {
      let p = null;
      try { p = req.frame().page(); } catch (_e) { /* a worker */ }
      loads.push({ page: pages.indexOf(p), code: body.p_code });
      return json(route, body.p_code === CODE ? [DESIGN] : []);
    }
    if (fn === "is_operator") return json(route, S.operator);
    if (fn === "is_support_operator") return json(route, false);
    if (fn === "log_error") return json(route, null);
    return json(route, false);
  }
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
  if (url.includes("/rest/v1/orders")) {
    return json(route, [{ id: ORDER_ID, client_id: CLIENT, order_no: 1102, short_code: CODE, ordered_at: "2026-10-01T15:00:00Z", total_cents: 900000, total_source: "manual", notes: null }]);
  }
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (/[?&]warm=1/.test(url)) return json(route, { ok: true });
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
  }
  if (url.includes("/operator-portal")) {
    if (body.action === "get_portal") return json(route, { ok: true, clientId: OTHER, companyName: "Other Sheds", designs: [], versions: [], capturedLeads: [], crmContacts: [], crmContactsTotal: 0 });
    if (body.action === "list_clients") return json(route, { ok: true, clients: [{ clientId: OTHER, companyName: "Other Sheds" }] });
    return json(route, { ok: true });
  }
  if (url.includes("/portal-payments")) return json(route, { ok: true, canCharge: false });
  if (url.includes("/portal-settings")) {
    if (body.action === "status") return json(route, { ok: true, clientId: body.targetClientId || CLIENT, role: "owner", access: null, prefs: null, configured: true, invoiceInGhl: false, branding: {} });
    // Orders lists only StructureStudio orders: a design code needs its design, with an estimate number.
    if (body.action === "orders_designs") {
      return json(route, { ok: true, designs: [{ ...DESIGN, ss_quote_number: "HO-1102", status: "accepted", estimate_lines: [], image_url: null, updated_at: "2026-10-01T15:00:00Z" }] });
    }
    return json(route, { ok: true });
  }
  return json(route, { ok: true });
};
await ctx.route(`**/${REF}.supabase.co/**`, handler);
await ctx.route(`**/${REF}.functions.supabase.co/**`, handler);
if (PORTAL_OVERRIDE) await ctx.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: PORTAL_OVERRIDE }));

const until = async (fn, timeout = 8000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await fn()) return true;
  return !!(await fn());
};
const booted = (p) => p.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
const pathOf = (p) => { const u = new URL(p.url()); return u.pathname + u.search; };
const stateOpen = (p) => p.evaluate(() => (window.history.state && window.history.state.open) || null).catch(() => null);
const loadsOf = (p, code = CODE) => loads.filter((l) => l.page === pages.indexOf(p) && l.code === code).length;

try {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/orders/o-${ORDER_ID}`, { waitUntil: "domcontentloaded" });
  await booted(page);
  const link = page.locator("a[data-ss-open-design='1']").first();
  ok("L0: the order shows Open design", await link.waitFor({ timeout: 20000 }).then(() => true, () => false),
    `${pathOf(page)} | ${(await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300)}`);
  ok("L0: …as a real link to /designer?open=<code>", (await link.getAttribute("href")) === `/designer?open=${CODE}`, String(await link.getAttribute("href")));

  // ── L1 / L2: the wheel, then a reload ──
  const before = pages.length;
  const tabP = ctx.waitForEvent("page", { timeout: 10000 }).catch(() => null);
  await link.click({ button: "middle" });
  const tab = await tabP;
  ok("L1: a middle click opens a new tab", !!tab && pages.length === before + 1);
  if (tab) {
    // ⚠️ A tab Chrome opens for a middle or Ctrl click sends its FIRST request before Playwright's
    // routes are attached to it, so that one load reaches the plain static server (no _redirects:
    // a 404 here; the real host serves the app at /designer). So: the tab must be at the link's
    // address, and that address is then loaded in it again, cold, through the routes.
    ok("L1: …at the link's address, /designer?open=<code>", await until(() => pathOf(tab) === `/designer?open=${CODE}`, 5000), pathOf(tab));
    await tab.goto(`${BASE}/designer?open=${CODE}`, { waitUntil: "domcontentloaded" });
    await booted(tab).catch(() => {});
    ok("L1: the new tab loads THAT design (the designer asked for its code)", await until(() => loadsOf(tab) >= 1, 20000),
      `${JSON.stringify(loads)} | ${(await tab.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300)} | errors: ${pageErrors.join(" / ").slice(0, 300)}`);
    ok("L1: …its address is /designer, ?open= gone", await until(() => pathOf(tab) === "/designer", 5000), pathOf(tab));
    ok("L1: …and its history entry keeps the design", ((await stateOpen(tab)) || {}).code === CODE, JSON.stringify(await stateOpen(tab)));
    ok("L1: the first tab stayed on the order", pathOf(page) === `/orders/o-${ORDER_ID}`, pathOf(page));
    const n = loadsOf(tab);
    await tab.reload({ waitUntil: "domcontentloaded" });
    await booted(tab).catch(() => {});
    ok("L2: a reload of that tab opens the same design again", await until(() => loadsOf(tab) > n, 20000), JSON.stringify(loads));
    ok("L2: …still at /designer", pathOf(tab) === "/designer", pathOf(tab));
    await tab.close();
  }

  // ── L4: Ctrl+click ──
  const tab2P = ctx.waitForEvent("page", { timeout: 10000 }).catch(() => null);
  await link.click({ modifiers: ["Control"] });
  const tab2 = await tab2P;
  ok("L4: Ctrl+click opens a new tab too, at the link's address", !!tab2 && await until(() => pathOf(tab2) === `/designer?open=${CODE}`, 5000), tab2 ? pathOf(tab2) : "no tab");
  if (tab2) await tab2.close();

  // ── L3: a plain click, then a reload ──
  const pagesBefore = pages.length;
  const n3 = loadsOf(page);
  await link.click();
  ok("L3: a plain click opens it in place: no new tab, /designer", await until(() => pathOf(page) === "/designer", 5000) && pages.length === pagesBefore, pathOf(page));
  ok("L3: …the designer loads that design", await until(() => loadsOf(page) > n3, 20000), JSON.stringify(loads));
  ok("L3: …and the entry keeps it", ((await stateOpen(page)) || {}).code === CODE, JSON.stringify(await stateOpen(page)));
  const n3r = loadsOf(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await booted(page);
  ok("L3: a reload of it opens the same design again", await until(() => loadsOf(page) > n3r, 20000), JSON.stringify(loads));

  // ── L5 ──
  await page.getByRole("link", { name: "Orders", exact: true }).first().click();
  ok("L5: the next page's address carries no ?open=", await until(() => pathOf(page).startsWith("/orders"), 5000) && !pathOf(page).includes("open="), pathOf(page));
  const cold = await ctx.newPage();
  await cold.goto(`${BASE}/designer`, { waitUntil: "domcontentloaded" });
  await booted(cold);
  await cold.waitForTimeout(4000);
  ok("L5: a cold /designer with no ?open= and no history opens nothing", loads.filter((l) => l.page === pages.indexOf(cold)).length === 0, JSON.stringify(loads));
  await cold.close();

  // ── V: Orders in operator view-as ──
  S.operator = true;
  const op = await ctx.newPage();
  await op.goto(`${BASE}/orders?view=${OTHER}`, { waitUntil: "domcontentloaded" });
  await booted(op);
  const notice = op.locator("[data-ss-orders-not-shown='view-as']");
  ok("V: Orders in view-as says why it isn't shown", await notice.waitFor({ timeout: 20000 }).then(() => true, () => false)
    && /Orders isn't shown while viewing as (Other Sheds|other-sheds)\./.test(await notice.innerText()), await notice.innerText().catch(() => ""));
  // The teaser's own words (the sidebar's "Coming soon" GROUP is a different thing and stays).
  const body = await op.locator("body").innerText();
  ok("V: …and no teaser: no \"Work in progress\", no \"example data\", no example orders",
    !/Work in progress|example data|Dale Hostetler|Orders & payments/i.test(body));
  await op.getByRole("button", { name: "Exit view-as", exact: true }).click();
  ok("V: \"Exit view-as\" leaves the account", await until(() => pathOf(op) === "/accounts", 5000) && !(await op.locator("[data-ss-orders-not-shown]").count()), pathOf(op));
  await op.close();

  ok("X: no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  ok("X: nothing tried to leave the machine but blocked fonts or the like",
    offBox.every((h) => !/supabase|cardconnect|cardpointe/i.test(h)), [...new Set(offBox)].join(" | "));
} catch (e) {
  ok(`harness: ${String(e && e.message || e).split(/\r?\n/)[0].slice(0, 300)}`, false);
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
