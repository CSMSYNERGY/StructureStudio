// Every portal route renders for a signed-in test owner: no "Loading..." stall, no white
// screen, no console errors we own. Gated routes may show their upgrade card - that is a
// render, not a failure. Needs PW_MAGIC_TOKEN (see playwright.config.mjs).
import { test, expect } from "@playwright/test";
import { loginWithMagicToken, watchConsole } from "./helpers.mjs";

const ROUTES = [
  "/portal/designer", "/portal/contacts", "/portal/designs", "/portal/designs/list", "/portal/designs/pipeline",
  "/portal/inventory", "/portal/orders", "/portal/build-schedule", "/portal/delivery-schedule", "/portal/repairs",
  "/portal/commissions", "/portal/quickbooks", "/portal/view-3d",
  "/portal/support", "/portal/support/mine", "/portal/support/features", "/portal/support/fixes", "/portal/support/roadmap",
  // The pre-2026-08-30 name. Kept deliberately: these are the LEGACY paths, still live in
  // bookmarks and in links the product hands out, and they must keep resolving through
  // SS_TAB_ALIASES. If someone deletes the alias, these five turn red rather than a builder
  // finding a dead link.
  "/portal/releases", "/portal/releases/mine", "/portal/releases/setup",
  // ── Settings: every sub-page, because they are HUBS now (2026-09-11) ─────────────────
  // Settings used to be fourteen tabs on one shell. It is a rail plus four hubs — Company,
  // Colors, Billing and Options — each of which owns several slugs that are still flat
  // /portal/settings/<slug> URLs. An unknown sub does not 404, it CLAMPS to the first tab, so
  // a hub that lost its render branch would land people on Structures rather than erroring.
  // That is invisible from the outside and exactly what this list is for: EVERY slug, or the
  // suite stops proving anything about the ones it skips.
  "/portal/settings/structures", "/portal/settings/designer", "/portal/settings/connection",
  "/portal/settings/quickbooks", "/portal/settings/email", "/portal/settings/sms",
  // Company hub
  "/portal/settings/company", "/portal/settings/branding", "/portal/settings/team",
  "/portal/settings/commissions", "/portal/settings/locations", "/portal/settings/crews",
  "/portal/settings/drivers",
  // Colors hub
  "/portal/settings/colors", "/portal/settings/shingles", "/portal/settings/metal",
  // Billing hub
  "/portal/settings/billing", "/portal/settings/wallet",
  // Options hub — nine catalog editors, one tab each
  "/portal/settings/options", "/portal/settings/doors", "/portal/settings/windows",
  "/portal/settings/vents", "/portal/settings/ramps", "/portal/settings/cladding",
  "/portal/settings/interior", "/portal/settings/electrical", "/portal/settings/insulation",
  // Your own settings
  "/portal/settings/myprofile",
  // LEGACY, kept for the same reason as /portal/releases above: "myview" was renamed to
  // "myprofile" on 2026-09-11 and only keeps working through SS_SETTINGS_SUB_ALIASES. Delete
  // the alias and this turns red instead of a builder's bookmark quietly landing on Structures.
  "/portal/settings/myview",
  "/portal/settings/not-a-real-slug",
];

test.describe("portal routes", () => {
  test.describe.configure({ mode: "serial" });
  let page, errors;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    errors = watchConsole(page);
    await loginWithMagicToken(page);
  });
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

  test("operator-only routes are clamped for a tenant owner", async () => {
    for (const route of ["/portal/accounts", "/portal/admin", "/portal/projects"]) {
      await page.goto(route);
      await page.waitForFunction(() => window.__ssAppBooted === true);
      await expect.poll(() => page.evaluate(() => location.pathname), { timeout: 20_000 }).not.toBe(route);
    }
  });
});
