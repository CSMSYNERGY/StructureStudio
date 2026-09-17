// The log_error guard in helpers.mjs, proven with NO network. Pages are served from the repo on
// a *.localhost origin by page.route (no server listens there), every other host is aborted, and
// anything aimed at Supabase is recorded as a leak and aborted too. So even a broken guard cannot
// file a row. Needs no token and never touches beta:
//
//   npx playwright test tests/e2e/log-error-guard.spec.mjs
import { expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test, guardLogError, SUPABASE_URL } from "./helpers.mjs";

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const ORIGIN = "http://ss-e2e-guard.localhost";
const REWRITTEN = `${ORIGIN}/__e2e/rest/v1/rpc/log_error`;

// Trace off for this file only. With the config's retain-on-failure trace, ANY failure on a page
// served this way (a plain throw in the test body included) hung for the full 90 s timeout before
// reporting (checked 2026-09-17), so a regression here would read as a hang, not as its message.
test.use({ trace: "off" });

// Serves the repo root on ORIGIN. The guard's rewritten log_error falls through to the guard's own
// context route; everything else off ORIGIN is aborted, and Supabase-bound requests are returned
// as leaks.
async function serveRepo(page, { notFound = null } = {}) {
  const leaked = [];
  await page.route(() => true, (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin !== ORIGIN) {
      if (/(^|\.)supabase\.co$/.test(u.hostname)) leaked.push(`${req.method()} ${u.href}`);
      return route.abort();
    }
    if (/\/rest\/v1\/rpc\/log_error$/.test(u.pathname)) return route.fallback();
    if (u.pathname === "/__probe") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>probe</title>" });
    if (notFound && notFound.test(u.pathname)) return route.fulfill({ status: 404, body: "" });
    const file = normalize(join(ROOT, decodeURIComponent(u.pathname)));
    if (!file.startsWith(ROOT + sep) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ path: file });
  });
  return leaked;
}

test("the page fixture's log_error is answered on the page's own origin and recorded; nothing reaches Supabase", async ({ page, context }) => {
  const leaked = await serveRepo(page);
  await page.goto(`${ORIGIN}/__probe`);
  // Shaped like the product's call (keepalive, JSON body), aimed at the real project URL. The
  // guard must move it to this origin before it leaves; the apikey is not a key either way.
  const res = await page.evaluate(async (url) => {
    const r = await fetch(url + "/rest/v1/rpc/log_error", {
      method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json", apikey: "not-a-key" },
      body: JSON.stringify({ p_source: "e2e-guard", p_message: "probe", p_code: "e2e_guard_probe", p_severity: "info" }),
    });
    return { status: r.status, url: r.url };
  }, SUPABASE_URL);
  expect(res).toEqual({ status: 204, url: REWRITTEN });
  // The fixture installed the guard before the test ran; this returns that same guard.
  const guard = await guardLogError(context);
  await expect.poll(() => guard.rows.length).toBe(1);
  expect(guard.rows[0]).toMatchObject({ url: REWRITTEN, body: { p_code: "e2e_guard_probe" } });
  expect(leaked, "requests that tried to reach Supabase").toEqual([]);
});

// The real failure path: index.html with the component artifact answering 404, the way the
// 2026-09-07 beta runs failed. The boot guard's own log_error must be captured, attached, and
// fail the test, instead of filing boot_component_missing against a test tenant.
test("a designer that cannot load its component is caught: boot_component_missing is recorded and fails the test", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext();
  const guard = await guardLogError(ctx);
  try {
    const page = await ctx.newPage();
    const leaked = await serveRepo(page, { notFound: /^\/structure-studio\.component\.compiled\.js$/ });
    await page.goto(`${ORIGIN}/index.html?client=e2e-guard-selftest`);
    await expect.poll(() => guard.rows.map((r) => r.body && r.body.p_code)).toContain("boot_component_missing");
    const row = guard.rows.find((r) => r.body && r.body.p_code === "boot_component_missing");
    expect(row.url).toBe(REWRITTEN);
    expect(row.body).toMatchObject({ p_source: "boot", p_context: { missing: ["structure-studio.component.compiled.js"] } });
    expect(leaked, "requests that tried to reach Supabase").toEqual([]);
    // What the fixture's teardown does with these rows: attach them, then throw.
    await expect(guard.finish(testInfo)).rejects.toThrow(/boot failure: boot_component_missing/);
    expect(testInfo.attachments.map((a) => a.name)).toContain(guard.attachmentName);
    expect(guard.rows, "finish() takes the rows it reported").toEqual([]);
  } finally {
    await ctx.close();
  }
});
