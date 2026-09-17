// Customer quotes page: renders its sign-in form for a tenant and refuses a forged token
// cleanly. Sending a real code is deliberately NOT part of the smoke suite (it texts/emails
// a person); the OTP path is checked by hand.
import { expect } from "@playwright/test";
// `test` comes from helpers: it answers log_error locally for every page and fails on a boot_* call.
import { test, CLIENT, watchConsole } from "./helpers.mjs";

// /my-quotes is a pretty URL the Workers host resolves. A local `python -m http.server` has no
// such rewrite and answers 404 — every test here then fails exactly like a broken page. Locally:
// PW_MY_QUOTES_PATH=/my-quotes.html.
const MQ_PATH = process.env.PW_MY_QUOTES_PATH || "/my-quotes";

// login_options is answered locally in both cases below, so the email button's visibility is
// the page's decision under test, not whatever the live deployment happens to offer today.
async function stubLoginOptions(page, body, status = 200) {
  await page.route(/\/functions\/v1\/customer-auth/, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: cors, body: "ok" });
    let b = {};
    try { b = req.postDataJSON() || {}; } catch (_e) { /* not JSON */ }
    // Only login_options is answered; any other customer-auth call would text or email a person.
    if (b.action !== "login_options") return route.abort("blockedbyclient");
    return route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
  });
}

test("my-quotes renders the sign-in form", async ({ page }) => {
  const errors = watchConsole(page);
  await stubLoginOptions(page, { error: "Unknown action" }, 400);
  await page.goto(`${MQ_PATH}?client=${CLIENT}`);
  await expect(page.getByRole("button", { name: /Text me a code/ })).toBeVisible();
  // Re-inverted 2026-09-15, with the channel re-keyed to a proven email identity (migration
  // 230). The button is now the SERVER's call: a function that cannot say email is available
  // ("Unknown action" here) must still leave it hidden — offering a route that can only fail
  // is the thing the 2026-09-06 inversion guarded against, and it still is.
  await expect(page.getByRole("button", { name: /Use my email instead/ })).toBeHidden();
  expect(errors.filter((e) => !/status of 400/.test(e))).toEqual([]);
});

test("my-quotes offers the email route when login_options lists it", async ({ page }) => {
  await stubLoginOptions(page, { ok: true, channels: ["sms", "email"], defaultChannel: "sms" });
  await page.goto(`${MQ_PATH}?client=${CLIENT}`);
  const useEmail = page.getByRole("button", { name: /Use my email instead/ });
  await expect(useEmail).toBeVisible();
  await useEmail.click();
  await expect(page.getByRole("button", { name: /Email me a code/ })).toBeVisible();
  await expect(page.getByLabel("Email address")).toBeVisible();
});

test("my-quotes opens on email when that is the builder's default", async ({ page }) => {
  await stubLoginOptions(page, { ok: true, channels: ["sms", "email"], defaultChannel: "email" });
  await page.goto(`${MQ_PATH}?client=${CLIENT}`);
  await expect(page.getByRole("button", { name: /Email me a code/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Use my phone number instead/ })).toBeVisible();
});

test("a forged session token is refused without a white screen", async ({ page }) => {
  // my-quotes.html keys its session as ssq_token_<clientId> (see `var tokenKey` there).
  await page.addInitScript((id) => { try { localStorage.setItem("ssq_token_" + id, "forged-token-forged-token-forged-token-forged-tok"); } catch (_e) {} }, CLIENT);
  await page.goto(`${MQ_PATH}?client=${CLIENT}`);
  // Whatever key the page uses, it must land back on a usable sign-in screen, not blank.
  await expect.poll(async () => (await page.locator("body").innerText()).length, { timeout: 20_000 }).toBeGreaterThan(60);
  await expect(page.getByRole("button", { name: /Text me a code|Sign out|Verify/ }).first()).toBeVisible();
});
