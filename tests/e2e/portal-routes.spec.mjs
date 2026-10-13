// Every portal route renders for a signed-in test owner: no "Loading..." stall, no white
// screen, no console errors we own. Gated routes may show their upgrade card - that is a
// render, not a failure. Needs PW_MAGIC_TOKEN (see playwright.config.mjs).
//
// ROOT ADDRESSES (2026-10-13): the app lives at /<page>[/<sub>], no /portal (Carolyn 2026-10-12,
// "let's remove portal from anywhere"). Every route below is the canonical form, and the last
// tests prove each one's OLD /portal address still answers with a 301 to it. The same pairs are
// checked offline against _redirects and the router by scripts/redirects.test.mjs, which reads
// ROUTES from this file: keep it a flat array of "/…" string literals.
import { expect } from "@playwright/test";
// `test` comes from helpers: it answers log_error locally for every page and fails on a boot_* call.
import { test, guardLogError, loginWithMagicToken, watchConsole } from "./helpers.mjs";

const ROUTES = [
  "/designer",
  // The Contacts hub (2026-10-12): the tab, and each of its views by address. Without the CRM the
  // contact list and the board are the CRM card, which is a render.
  "/contacts", "/contacts/people", "/contacts/designs", "/contacts/pipeline",
  // LEGACY, every one of them: the separate Pipeline page (/designs, its /list and /pipeline
  // views and the merged era's /people and /deals), the Leads tab's board (/pipelines) and
  // the pre-09-02 Contacts address (/leads). ssCanonRoute lands each in the hub; delete it
  // and these turn red instead of a builder's bookmark landing nowhere.
  "/designs", "/designs/list", "/designs/pipeline", "/designs/people", "/designs/deals",
  "/pipelines", "/leads",
  "/inventory", "/orders", "/build-schedule", "/delivery-schedule", "/repairs",
  "/commissions", "/quickbooks", "/view-3d",
  // My Synergy Phone's Calls report. It resolves for anyone with phone access (owners always).
  "/calls",
  // Conversations (2026-10-05), and its three filters, which are subs the shell reads as state.
  // Behind the CRM: without it the page is the CRM card, which is a render.
  "/conversations", "/conversations/email", "/conversations/texts", "/conversations/calls",
  "/support", "/support/mine", "/support/features", "/support/fixes", "/support/roadmap",
  // Our own account only (ssAdvancedOn). For the test owner it must land on the Designer, which
  // is a render; tests/harness/advancedTab.mjs drives both sides of the gate.
  "/advanced",
  // The pre-2026-08-30 name. Kept deliberately: these are the LEGACY paths, still live in
  // bookmarks and in links the product hands out, and they must keep resolving through
  // SS_TAB_ALIASES. If someone deletes the alias, these five turn red rather than a builder
  // finding a dead link.
  "/releases", "/releases/mine", "/releases/setup",
  // ── Settings: every sub-page, because they are HUBS now (2026-09-11) ─────────────────
  // Settings used to be fourteen tabs on one shell. It is a rail plus four hubs — Company,
  // Colors, Billing and Options — each of which owns several slugs that are still flat
  // /settings/<slug> URLs. An unknown sub does not 404, it CLAMPS to the first tab, so
  // a hub that lost its render branch would land people on Structures rather than erroring.
  // That is invisible from the outside and exactly what this list is for: EVERY slug, or the
  // suite stops proving anything about the ones it skips.
  "/settings/structures", "/settings/designer", "/settings/connection", "/settings/pipelines",
  "/settings/quickbooks", "/settings/email", "/settings/sms",
  // My Synergy Phone's calling setup. Offered only where ssPhoneOffered says so (beta hosts, a tenant
  // with calling on, operators in view-as); elsewhere it CLAMPS to Structures, which is a render.
  "/settings/phone",
  // Company hub
  "/settings/company", "/settings/branding", "/settings/team",
  "/settings/commissions", "/settings/locations", "/settings/crews",
  "/settings/drivers", "/settings/tax", "/settings/payments",
  // Colors hub
  "/settings/colors", "/settings/shingles", "/settings/metal",
  // Billing hub
  "/settings/billing", "/settings/wallet",
  // Options hub — nine catalog editors, one tab each
  "/settings/options", "/settings/doors", "/settings/windows",
  "/settings/vents", "/settings/ramps", "/settings/cladding",
  "/settings/interior", "/settings/electrical", "/settings/insulation",
  "/settings/delivery", "/settings/foundation",
  // Your own settings
  "/settings/myprofile",
  // LEGACY, kept for the same reason as /releases above: "myview" was renamed to
  // "myprofile" on 2026-09-11 and only keeps working through SS_SETTINGS_SUB_ALIASES. Delete
  // the alias and this turns red instead of a builder's bookmark quietly landing on Structures.
  "/settings/myview",
  "/settings/not-a-real-slug",
];

test.describe("portal routes", () => {
  test.describe.configure({ mode: "serial" });
  let page, errors, logs;

  // browser.newPage() makes its own context, which the fixture's log_error guard never sees, so
  // it is guarded here and checked after every test (a boot_* call fails the test it happened in).
  test.beforeAll(async ({ browser }, testInfo) => {
    page = await browser.newPage();
    logs = await guardLogError(page.context());
    errors = watchConsole(page);
    await loginWithMagicToken(page);
    await logs.finish(testInfo);
  });
  test.afterEach(async ({}, testInfo) => { await logs.finish(testInfo); });
  test.afterAll(async () => { await page.close(); });

  for (const route of ROUTES) {
    test(`${route} renders`, async () => {
      errors.length = 0;
      await page.goto(route);
      await page.waitForFunction(() => window.__ssAppBooted === true);
      const body = page.locator(".ss-body");
      await expect(body).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await body.innerText()).length, { timeout: 20_000 }).toBeGreaterThan(80);
      const text = await page.locator("body").innerText();
      expect(text, "no loading stall").not.toMatch(/Loading your business|Loading…\s*$/);
      expect(text, "no crash text").not.toMatch(/Something went wrong|Couldn't load the portal/);
      expect(errors, "console errors").toEqual([]);
    });
  }

  // The address bar follows: an old Pipeline or Leads address is rewritten into the hub, the Design
  // list's own address included, so a refresh or a copied link stays where the reader is.
  test("old Pipeline and Leads addresses land in the Contacts hub", async () => {
    for (const [route, want] of [
      ["/designs/list", /^\/contacts\/designs$/],
      ["/designs", /^\/contacts\/(designs|people|pipeline|p-[0-9a-f-]{36})$/],
      ["/designs/pipeline", /^\/contacts\/(designs|people|pipeline|p-[0-9a-f-]{36})$/],
      ["/pipelines", /^\/contacts\/(designs|people|pipeline|p-[0-9a-f-]{36})$/],
      ["/leads", /^\/contacts\//],
      // The same, from their /portal addresses: the host's 301, then the hub's own rewrite.
      ["/portal/designs/list", /^\/contacts\/designs$/],
      ["/portal/leads", /^\/contacts\//],
    ]) {
      await page.goto(route);
      await page.waitForFunction(() => window.__ssAppBooted === true);
      await expect.poll(() => page.evaluate(() => location.pathname), { timeout: 20_000 }).toMatch(want);
      await expect(page.locator("[data-ss-hub-tabs]")).toBeVisible({ timeout: 20_000 });
    }
  });

  test("operator-only routes are clamped for a tenant owner", async () => {
    // /console is the Admin page: /admin is admin.html, the standalone console, not the app.
    for (const route of ["/accounts", "/console", "/projects"]) {
      await page.goto(route);
      await page.waitForFunction(() => window.__ssAppBooted === true);
      await expect.poll(() => page.evaluate(() => location.pathname), { timeout: 20_000 }).not.toBe(route);
    }
  });

  // EVERY OLD /portal ADDRESS ANSWERS 301 WITH ITS ROOT FORM, the query string kept. Asked of the
  // host directly (no redirect followed, no page rendered), so one request per route: these are
  // the links in emails already sent, in the phone apps and in bookmarks.
  test("every route's old /portal address is a permanent redirect to it, query kept", async () => {
    const legacy = (route) => (route.startsWith("/console") ? "/portal/admin" + route.slice("/console".length) : "/portal" + route);
    const pairs = [...ROUTES.map((r) => [legacy(r), r]),
      ["/portal", "/login"], ["/portal/", "/login"], ["/portal/admin", "/console"], ["/portal/accounts", "/accounts"]];
    for (const [from, to] of pairs) {
      for (const q of ["", "?view=e2e-test"]) {
        const res = await page.request.get(from + q, { maxRedirects: 0 });
        expect(res.status(), `${from + q} status`).toBe(301);
        const loc = new URL(res.headers()["location"] || "", "https://x.invalid");
        expect(loc.pathname + loc.search, `${from + q} location`).toBe(to + q);
      }
    }
  });

  // And the redirect lands: the old address of a page and of a Settings hub open the app at the
  // new one, signed in, with the page drawn.
  test("old /portal addresses open the app at the root address", async () => {
    for (const [from, to] of [["/portal/orders", "/orders"], ["/portal/settings/colors", "/settings/colors"]]) {
      await page.goto(from);
      await page.waitForFunction(() => window.__ssAppBooted === true);
      await expect.poll(() => page.evaluate(() => location.pathname), { timeout: 20_000 }).toBe(to);
      await expect(page.locator(".ss-body")).toBeVisible({ timeout: 30_000 });
    }
  });

  // The public designer, the customer page and the standalone console are NOT the app: nothing
  // added for the app's root addresses may answer for them.
  test("/, /my-quotes and /admin are not the app", async () => {
    for (const path of ["/", "/my-quotes", "/admin"]) {
      const res = await page.request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
      expect(await res.text(), path).not.toContain("/portal.app.compiled.js");
    }
  });
});
