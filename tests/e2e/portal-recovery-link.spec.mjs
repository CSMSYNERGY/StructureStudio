// A dead email link landing on the portal (2026-09-17). When a reset or invite link has already
// been used, was superseded, or is past its expiry, Supabase's /verify redirects to
// /portal#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired
// (AUTH_PORTAL_URL is still /portal: production keeps its old routing until main is promoted).
// Since 2026-10-13 the host 301s /portal to /login and the browser keeps the fragment, so the app
// reads it at /login. The portal must explain it on the login form (with "Forgot password?" right
// there), scrub the error out of the URL, and log the landing. otp_expired is Supabase correctly
// REFUSING the link, so its row is severity info. Anything unexplained (server_error, …) is still
// an error.
//
// No login and nothing reaches the project: EVERY supabase.co request is answered here and
// log_error bodies are captured, so no app_errors row is written. Runs against a local static
// server (or beta):
//
//   PW_BASE_URL=http://127.0.0.1:8123 npx playwright test tests/e2e/portal-recovery-link.spec.mjs
//
// The /portal# case needs a host that serves _redirects (beta, or `wrangler dev`); on a plain
// static server, which ignores that file, it skips itself.
import { test, expect } from "@playwright/test";
import { watchConsole } from "./helpers.mjs";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

async function stubSupabase(page) {
  const logs = [];
  // ssLogError sends a keepalive fetch. page.route cannot hold a cross-origin keepalive from a
  // document that is going away (see customer-login.spec.mjs), so a row fired as the test closes
  // the page could reach the LIVE project. Every keepalive log_error goes to a same-origin path
  // instead: the route below catches it, and a miss can only reach the static server. Only the
  // destination changes; the body is the product's own.
  await page.addInitScript(() => {
    const realFetch = window.fetch;
    window.fetch = function (u, opts) {
      if (opts && opts.keepalive && /\/rest\/v1\/rpc\/log_error$/.test(String(u))) return realFetch.call(this, "/__e2e/rest/v1/rpc/log_error", opts);
      return realFetch.apply(this, arguments);
    };
  });
  await page.route(/^https:\/\/jzeamjbhdrsbygdnphbm\.supabase\.co\//, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS, body: "ok" });
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: "{}" });
  });
  // Registered last, so it wins for log_error on either destination.
  await page.route(/\/rest\/v1\/rpc\/log_error$/, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS, body: "ok" });
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (_e) { /* not JSON */ }
    logs.push(body);
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: "null" });
  });
  return logs;
}

const linkRows = (logs) => logs.filter((b) => /^recovery link rejected/.test(String(b.p_message || "")));

async function land(page, fragment) {
  await page.goto("/portal.html#" + fragment);
  await page.waitForFunction(() => window.__ssAppBooted === true);
}

test("an expired/used email link: sign-in notice, Forgot password?, URL scrubbed, logged as info", async ({ page }) => {
  const errors = watchConsole(page);
  const logs = await stubSupabase(page);
  await land(page, "error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");

  await expect(page.getByText("That sign-in link has expired or was already used.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Forgot password?" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  expect(page.url()).not.toMatch(/error|otp_expired/);

  await expect.poll(() => linkRows(logs).length).toBe(1);
  const row = linkRows(logs)[0];
  expect(row).toMatchObject({
    p_source: "portal",
    p_message: "recovery link rejected: Email link is invalid or has expired",
    p_code: "otp_expired",
    p_context: { expired: true },
    p_severity: "info",
  });
  expect(row.p_url).not.toContain("#");
  expect(errors, "console errors").toEqual([]);
});

// The address Supabase really sends the link to: AUTH_PORTAL_URL, /portal, which the host 301s to
// /login. The fragment never reaches the host; the browser carries it across the redirect, and the
// app must read it at /login exactly as above. This is every reset and invite email already sent,
// the shipped mobile app's password-reset redirect, and every new one until the flip to /login.
test("an expired link sent to the old /portal address: 301 to /login, fragment kept, same notice", async ({ page }) => {
  const head = await page.request.get("/portal", { maxRedirects: 0 });
  const loc = new URL(head.headers()["location"] || "/", "https://x.invalid").pathname;
  test.skip(head.status() !== 301 || loc !== "/login", `this host answers /portal with ${head.status()} ${loc}: it does not serve _redirects (plain static server)`);

  const errors = watchConsole(page);
  const logs = await stubSupabase(page);
  await page.goto("/portal#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
  await page.waitForFunction(() => window.__ssAppBooted === true);

  await expect(page.getByText("That sign-in link has expired or was already used.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Forgot password?" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/login");
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  expect(page.url()).not.toMatch(/error|otp_expired/);

  await expect.poll(() => linkRows(logs).length).toBe(1);
  expect(linkRows(logs)[0]).toMatchObject({ p_code: "otp_expired", p_context: { expired: true }, p_severity: "info" });
  expect(errors, "console errors").toEqual([]);
});

test("an email link refused for an unexplained reason (server_error) still logs as error", async ({ page }) => {
  const errors = watchConsole(page);
  const logs = await stubSupabase(page);
  await land(page, "error=server_error&error_description=boom");

  await expect(page.getByText("That sign-in link is no longer valid.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Forgot password?" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");

  await expect.poll(() => linkRows(logs).length).toBe(1);
  expect(linkRows(logs)[0]).toMatchObject({
    p_message: "recovery link rejected: boom",
    p_code: "server_error",
    p_context: { expired: false },
    p_severity: "error",
  });
  expect(errors, "console errors").toEqual([]);
});
