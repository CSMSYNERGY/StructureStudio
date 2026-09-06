// Every portal route renders for a signed-in test owner: no "Loading..." stall, no white
// screen, no console errors we own. Gated routes may show their upgrade card - that is a
// render, not a failure. Needs PW_MAGIC_TOKEN (see playwright.config.mjs).
import { test, expect } from "@playwright/test";
import { loginWithMagicToken, watchConsole } from "./helpers.mjs";

const ROUTES = [
  "/portal/designer", "/portal/contacts", "/portal/designs", "/portal/designs/list", "/portal/designs/pipeline",
  "/portal/inventory", "/portal/orders", "/portal/build-schedule", "/portal/delivery-schedule", "/portal/repairs",
  "/portal/commissions", "/portal/quickbooks", "/portal/view-3d",
  "/portal/releases", "/portal/releases/mine", "/portal/releases/features", "/portal/releases/fixes", "/portal/releases/roadmap",
  "/portal/settings/structures", "/portal/settings/options", "/portal/settings/colors", "/portal/settings/designer",
  "/portal/settings/branding", "/portal/settings/connection", "/portal/settings/quickbooks", "/portal/settings/email",
  "/portal/settings/sms", "/portal/settings/commissions", "/portal/settings/team", "/portal/settings/billing", "/portal/settings/myview",
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
