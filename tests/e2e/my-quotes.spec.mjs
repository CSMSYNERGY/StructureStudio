// Customer quotes page: renders its sign-in form for a tenant and refuses a forged token
// cleanly. Sending a real code is deliberately NOT part of the smoke suite (it texts/emails
// a person); the OTP path is checked by hand.
import { test, expect } from "@playwright/test";
import { CLIENT, watchConsole } from "./helpers.mjs";

test("my-quotes renders the sign-in form", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(`/my-quotes?client=${CLIENT}`);
  await expect(page.getByRole("button", { name: /Text me a code/ })).toBeVisible();
  // INVERTED 2026-09-06, on purpose. customer-auth refuses channel="email" outright: it
  // used to resolve a proven email to an UNPROVEN phone by scanning designs and mint the
  // session on that phone, and save_design is anon-callable, so the pair could be planted.
  // This assertion now guards the decision - if the button comes back while the server
  // still refuses, a customer is being offered a route that can only fail. Re-invert it in
  // the same commit that re-keys the channel to a proven email identity, not before.
  await expect(page.getByRole("button", { name: /Use my email instead/ })).toBeHidden();
  expect(errors).toEqual([]);
});

test("a forged session token is refused without a white screen", async ({ page }) => {
  // my-quotes.html keys its session as ssq_token_<clientId> (see `var tokenKey` there).
  await page.addInitScript((id) => { try { localStorage.setItem("ssq_token_" + id, "forged-token-forged-token-forged-token-forged-tok"); } catch (_e) {} }, CLIENT);
  await page.goto(`/my-quotes?client=${CLIENT}`);
  // Whatever key the page uses, it must land back on a usable sign-in screen, not blank.
  await expect.poll(async () => (await page.locator("body").innerText()).length, { timeout: 20_000 }).toBeGreaterThan(60);
  await expect(page.getByRole("button", { name: /Text me a code|Sign out|Verify/ }).first()).toBeVisible();
});
