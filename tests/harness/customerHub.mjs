// Settings → CUSTOMER HUB, and the CRM Connection → GHL Connection rename (Carolyn 2026-10-22:
// "I want to rename the CRM Connection to be called GHL Connection. Then I want a new tab in
// settings called Customer Hub for all the CRM Items in SS"), driven for real on the COMPILED
// portal.
//
// The split she chose is by WHOSE CRM it is: Customer Hub is the one we build (pipelines, card
// statuses, the customer's login code), GHL Connection stays its own rail item for somebody
// else's. What this proves:
//
//   A  THE RAIL: one "Customer Hub" item, no bare "Pipelines" item any more, and the connection
//      item reads "GHL Connection" with no "CRM Connection" left anywhere on the rail.
//   B  THE OLD SLUG STILL LANDS WHERE IT ALWAYS DID: /settings/pipelines renders the Pipelines
//      card, now inside the hub — its two tabs on screen, Pipelines & Statuses current, and the
//      rail highlighting Customer Hub (a hub tab must light its HUB, not fall through the clamp
//      to Structures). This is the check that matters most: that slug is in bookmarks and
//      contactsHub_test.ts pins it as a routable path.
//   C  THE SECOND TAB: clicking Customer login moves the address to /settings/customer-login and
//      renders the Customer login code card; the Text/Email toggle still saves, and posts ONLY
//      customerLoginDefault (the card kept its own narrow save, so moving it writes nothing
//      differently). A cold deep link to that slug renders the same card.
//   D  IT REALLY MOVED: the GHL Connection page no longer carries the Customer login card, and
//      its fields read GHL Location ID / GHL API Key / Disconnect GHL rather than CRM.
//   E  ACCESS IS UNCHANGED: both tabs were settings_crm where they came from and the hub carries
//      that area, so someone holding only settings_structures gets neither Customer Hub nor GHL
//      Connection — exactly what they got before, when the two screens were separate rail items.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the skeleton is
// crmPipelineSettings.mjs's.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root, after npm run compile)
//   node tests/harness/customerHub.mjs            (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/customer-hub (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an older
// portal.app.compiled.js> serves that file instead: against the artifact from before this change,
// A, B, C and D all fail.
//
// ⚠️ EVERY CHECK IS GUARDED BY "the thing rendered": nothing to find is not the same as nothing there.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir, serveAppRoutes } from "./lib.mjs";

const CLIENT = "harness-customer-hub";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STATUSES = [["New Lead", "design_submitted"], ["Estimate Sent", "estimate_sent"], ["Accepted", "estimate_accepted"]]
  .map(([name, triggerEvent], i) => ({ id: U(100 + i), name, color: "#64748B", position: (i + 1) * 1024, triggerEvent }));
const PIPELINES = [{
  id: U(1), name: "Shed Deals", position: 1024, lostReasons: [], seedKind: "shed_deals", feedsDesigns: true,
  stages: [{ id: U(200), name: "New Incoming", color: "#64748B", kind: "open", position: 1024 }],
}];

const { ok, failed } = reporter();
const shots = shotsDir("customer-hub");
const { browser, ctx } = await launch({ width: 1400, height: 1000 });
await ctx.addInitScript(([ref, s]) => {
  try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
}, [REF, SESSION]);
const pageErrors = [];
const sent = [];
// The access map `status` answers with, and the coarse role beside it. null + owner = unclamped;
// E swaps in a narrow map AND a non-admin role, because settingsIsAdmin (owner|admin) short-
// circuits the per-area filter before it ever reads the map.
let ACCESS = null;
let ROLE = "owner";
let loginDefault = "sms";

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

async function openPortal() {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/log_error")) return json(route, null);
    if (url.includes("/rest/v1/rpc/")) return json(route, false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: ROLE, user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    sent.push(body);
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: ROLE, access: ACCESS, prefs: null,
          // configured: a saved GHL connection, so D sees the connected copy and the Pipeline &
          // Stages card (which only renders once connected) is on the page too.
          configured: true, ghlLocationIdMasked: "sp58…Pe1z", hasApiKey: true,
          invoiceInGhl: false, ghlInvoicingAllowed: false, ssQuoteNext: 1042, ssInvoiceNext: 2001,
          ssTaxRate: 6.5, ssTaxLabel: "Sales tax", businessAddress: {}, branding: {}, emailReady: true,
          customerLoginDefault: loginDefault });
      case "save":
        if (typeof body.customerLoginDefault === "string") loginDefault = body.customerLoginDefault;
        return json(route, { ok: true });
      case "crm_pipelines_list":
        return json(route, { ok: true, pipelines: PIPELINES, statuses: STATUSES, team: [], canManage: true, canWrite: true, ownOnly: false, me: USER.id });
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  // The app's own addresses (/settings/<sub>), which the static server knows nothing about —
  // without this a cold deep link 404s and the rest of the run reads an error page.
  await serveAppRoutes(page);
  if (process.env.SS_DBG) page.on("response", (r) => { if (r.request().isNavigationRequest()) console.log("NAV", r.status(), r.url()); });
  if (process.env.SS_PORTAL_ARTIFACT) {
    const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
    await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
  }
  return page;
}

// The settings rail's labels, in rail order. ⚠️ BOTH rails are always in the markup — one
// <aside>, CSS picks which is shown — so this MUST be scoped to .ss-set-nav or it returns the
// workspace items as well (that mistake made this harness read 28 items and "pass" A by
// accident). Each item's text is its .lbl span.
const railLabels = (page) => page.locator("aside.ss-side-settings .ss-set-nav a .lbl").evaluateAll((els) => els.map((e) => e.textContent.trim()));
// The sub-tab row a hub renders, and which one is current.
// Links since 684a21d3 (right-click opens a new tab); buttons before it.
const subTabs = (page) => page.locator("a, button").evaluateAll((els) => els
  .filter((e) => e.style && e.style.borderBottom && /solid/.test(e.style.borderBottom))
  .map((e) => ({ label: e.textContent.trim(), current: e.getAttribute("aria-current") === "page" })));

// ── C (cold deep link) ──────────────────────────────────────────────────────────────────
// A REAL HTTP load of the new slug, not a pushState: proof that /settings/customer-login works
// from a bookmark and not only from a click inside the hub.
//
// ⚠️ IT HAS TO RUN FIRST, and that is a property of the HELPER, not of this feature.
// serveAppRoutes (tests/harness/lib.mjs) answers the app's own addresses, and it only takes
// effect for the FIRST PAGE'S FIRST NAVIGATION in a browser context — measured: a deep link as
// page 1's first navigation is served (200), the same deep link on a second page of the same
// context 404s, and so does one that follows any earlier navigation on the same page. That is
// why every other harness here reaches settings pages by pushState. Move this block down and it
// fails against a perfectly good build.
{
  const cold = await openPortal();
  try {
    await cold.goto(`${BASE}/settings/customer-login`, { waitUntil: "domcontentloaded" });
    await cold.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 })
      .catch(() => { /* the guard below reports it, with what the page is showing */ });
    await cold.waitForFunction(() => !!document.querySelector("[data-ss-login-default]"), null, { timeout: 20000 })
      .catch(() => { /* ditto */ });
    ok("C: a cold /settings/customer-login renders the Customer login card",
      await cold.locator("[data-ss-login-default]").count() > 0,
      `booted=${await cold.evaluate(() => window.__ssAppBooted)} path=${await cold.evaluate(() => location.pathname)} body=${(await cold.evaluate(() => document.body.innerText)).slice(0, 160)}`);
    const act = await cold.locator("aside.ss-side-settings .ss-set-nav a.active .lbl").allTextContents();
    ok("C: …and the cold load highlights Customer Hub", act.join("") === "Customer Hub", act.join(" | "));
    await cold.screenshot({ path: join(shots, "customer-hub-cold-login.png"), fullPage: true });
  } catch (e) {
    ok("C: the cold deep-link check ran", false, String(e && e.message).slice(0, 120));
  } finally { await cold.close(); }
}

let page = await openPortal();
try {
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  const go = async (path) => {
    await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
    await page.waitForTimeout(1200);
  };

  // ── B first: the old slug, which is the check that matters most ──
  await go("/settings/pipelines");
  await page.waitForFunction(() => !!document.querySelector("[data-ss-pipeline-settings]"), null, { timeout: 20000 })
    .catch(() => { /* the guard below reports it */ });
  await page.waitForTimeout(400);

  // ── A: THE RAIL ──
  const rail = await railLabels(page);
  ok("A: the settings rail rendered", rail.length > 3, `${rail.length} items`);
  if (rail.length > 3) {
    ok("A: it carries ONE Customer Hub item", rail.filter((l) => l === "Customer Hub").length === 1, rail.join(" | "));
    ok("A: the bare Pipelines item is gone", !rail.includes("Pipelines"), rail.join(" | "));
    ok("A: the connection item reads GHL Connection", rail.includes("GHL Connection"), rail.join(" | "));
    ok("A: nothing on the rail still says CRM Connection", !rail.includes("CRM Connection"), rail.join(" | "));
    ok("A: Customer Hub sits directly above GHL Connection",
      rail.indexOf("GHL Connection") === rail.indexOf("Customer Hub") + 1, rail.join(" | "));
  }

  // ── B: /settings/pipelines lands inside the hub, on the page it always opened ──
  const pipeCard = page.locator("[data-ss-pipeline-settings]");
  ok("B: /settings/pipelines still renders the Pipelines card", await pipeCard.count() > 0);
  if (await pipeCard.count() > 0) {
    const tabs = await subTabs(page);
    const labels = tabs.map((t) => t.label);
    ok("B: the hub's two tabs are on screen",
      labels.includes("Pipelines & Statuses") && labels.includes("Customer login"), labels.join(" | "));
    ok("B: Pipelines & Statuses is the current tab",
      tabs.some((t) => t.label === "Pipelines & Statuses" && t.current), JSON.stringify(tabs));
    ok("B: the address is untouched", await page.evaluate(() => location.pathname) === "/settings/pipelines");
    // A hub tab must light its HUB in the rail. Before the hub existed this slug lit its own
    // item; falling through the clamp instead would light Structures, on a perfectly valid URL.
    const active = await page.locator("aside.ss-side-settings .ss-set-nav a.active .lbl").allTextContents();
    ok("B: the settings rail highlights Customer Hub, and only that",
      active.length === 1 && active[0] === "Customer Hub", active.join(" | "));
    // The failure this guards is specific: a hub tab the rail does not recognise falls through
    // the clamp and lights Structures instead, on a perfectly valid URL.
    ok("B: …not Structures", !active.includes("Sheds"), active.join(" | "));
    await page.screenshot({ path: join(shots, "customer-hub-pipelines.png"), fullPage: true });
  }

  // ── C: the second tab ──
  const loginTab = page.getByRole("link", { name: "Customer login", exact: true }).or(page.getByRole("button", { name: "Customer login", exact: true }));
  ok("C: the Customer login tab is clickable", await loginTab.count() > 0);
  if (await loginTab.count() > 0) {
    await loginTab.first().click();
    await page.waitForTimeout(1200);
    ok("C: it moves the address to /settings/customer-login",
      await page.evaluate(() => location.pathname) === "/settings/customer-login",
      await page.evaluate(() => location.pathname));
    const grp = page.locator("[data-ss-login-default]");
    ok("C: the Customer login code card rendered", await grp.count() > 0);
    if (await grp.count() > 0) {
      ok("C: it opens on the saved choice", await grp.first().getAttribute("data-ss-login-default") === "sms");
      ok("C: the Pipelines card is NOT also on screen (one tab at a time)",
        await page.locator("[data-ss-pipeline-settings]").count() === 0);
      const before = sent.length;
      await page.getByRole("button", { name: "Email", exact: true }).first().click();
      await page.waitForTimeout(1500);
      const saves = sent.slice(before).filter((b) => b.action === "save");
      ok("C: the toggle saves", saves.length === 1, JSON.stringify(saves));
      // The card kept its own narrow save. A card that had started posting the whole form from
      // its new home would write back every other field as it was when the tab opened.
      ok("C: and posts ONLY customerLoginDefault",
        saves.length === 1 && Object.keys(saves[0]).sort().join(",") === "action,customerLoginDefault",
        JSON.stringify(saves[0] || null));
      ok("C: the card shows the new choice", await grp.first().getAttribute("data-ss-login-default") === "email");
      await page.screenshot({ path: join(shots, "customer-hub-login.png"), fullPage: true });
    }
  }

  // A cold deep link to the new slug, not just a click from inside the hub.
  // ── D: it really moved, and the page reads GHL ──
  await go("/settings/connection");
  await page.waitForFunction(() => /GHL Connection|CRM Connection/.test(document.body.innerText), null, { timeout: 20000 })
    .catch(() => { /* the guard below reports it */ });
  const conn = await page.evaluate(() => document.body.innerText);
  ok("D: the connection page rendered", /Estimates & Invoices|Estimates &amp; Invoices/.test(conn), conn.slice(0, 120));
  if (/Estimates/.test(conn)) {
    ok("D: its heading reads GHL Connection", conn.includes("GHL Connection"));
    ok("D: nothing on it still says CRM Connection", !conn.includes("CRM Connection"));
    // ⚠️ CASE-INSENSITIVE: S.lbl uppercases with CSS and innerText returns the TRANSFORMED text,
    // so the labels read "GHL LOCATION ID" on screen however they are written in the source.
    const labels = conn.toUpperCase();
    ok("D: the fields read GHL", labels.includes("GHL LOCATION ID") && labels.includes("GHL API KEY"),
      `labels seen: ${(conn.match(/(GHL|CRM) (LOCATION ID|API KEY)/gi) || ["none"]).join(" | ")}`);
    ok("D: Disconnect reads GHL", conn.includes("Disconnect GHL") && !conn.includes("Disconnect CRM"));
    ok("D: the Customer login card is NO LONGER here", !conn.includes("Customer login code"), conn.slice(conn.indexOf("Customer login") - 40, conn.indexOf("Customer login") + 60));
    // It is still the GHL page: the stage mapping stayed behind with the credentials.
    ok("D: Pipeline & Stages stayed on it", /Pipeline & Stages|Pipeline &amp; Stages/.test(conn));
    await page.screenshot({ path: join(shots, "ghl-connection.png"), fullPage: true });
  }

  // ── E: access is unchanged ──
  // settings_structures only: no settings_crm, so neither screen is theirs — which is exactly
  // what they had before, when Pipelines and the connection page were two separate rail items.
  ACCESS = { settings_structures: "edit" };
  ROLE = "staff";
  await page.close();
  page = await openPortal();
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.evaluate(() => { history.pushState({}, "", "/settings"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await page.waitForTimeout(1500);
  const narrow = await railLabels(page);
  ok("E: the narrow rail rendered", narrow.length > 0, narrow.join(" | "));
  if (narrow.length) {
    ok("E: no Customer Hub for someone without settings_crm", !narrow.includes("Customer Hub"), narrow.join(" | "));
    ok("E: no GHL Connection either", !narrow.includes("GHL Connection"), narrow.join(" | "));
    ok("E: and they still have the areas they do hold", narrow.includes("Sheds") && narrow.includes("My Profile"), narrow.join(" | "));
  }

  ok("Z: no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
  ok("Z: the run reached the end", false, String(e && e.message).split(/\r?\n/)[0]);
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${bad.length ? "FAILED" : "all checks held"} — ${bad.length} failed`);
console.log(`shots: ${shots}`);
process.exit(bad.length ? 1 : 0);
