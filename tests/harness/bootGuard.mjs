// The dependency boot guard's failure paths, driven in a real browser (2026-09-17).
//
// What this proves, per page, by COUNTING navigations and log_error calls rather than reading code:
//   designer (index.html)
//     1. the component artifact arrives broken ONCE, then fine: exactly one self-heal reload,
//        the app mounts, no failure screen, nothing logged
//     2. the component is broken on EVERY load: exactly one reload, then the screen and ONE
//        boot_component_missing row whose context carries real diagnostics (scripts facts,
//        failedToLoad), and no further reloads however long we wait
//     2c. pressing the screen's Reload while it is still broken: one navigation (the user's),
//        the screen again, still no automatic reload
//     2d. pressing Reload once it is fixed: the app mounts and the retry latch is cleared, so
//        the NEXT failure in the tab gets its one free retry again
//     3. a healthy load: zero reloads, zero log calls
//   portal.html / admin.html (and index.html's own app artifact): the failure modes they
//   already had behave as before
//     4a  healthy (portal, admin): zero reloads, zero boot rows
//     4b  app artifact 404 on every load: one reload, then boot_app_missing, one row
//     4c  app artifact broken once: one reload, then the app boots, no row
//     4f  a vendored library missing: the screen at once, no reload, one boot_deps_missing row
//
//   node tests/harness/bootGuard.mjs                (SS_SHOTS=<dir> for the screenshots)
//
// SELF-CONTAINED: the script serves the checkout itself on an ephemeral 127.0.0.1 port, so
// there is no python server to start. It exercises the COMMITTED compiled artifacts.
//
// ⚠️ NOTHING LEAVES THE MACHINE, three ways over. stubSupabase answers every Supabase call and
// aborts every other non-local request; Chrome is started with a host-resolver rule that makes
// every name except the loopback server unresolvable, so a request the router somehow missed
// (keepalive is the usual suspect) still cannot reach the real project; and log_error bodies are
// counted IN THE PAGE, before the network, so a stub that went blind cannot make "zero rows" pass.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stubSupabase, reporter, shotsDir, bypassGate } from "./lib.mjs";
import { CONFIG as GABLE_CONFIG, FIXTURES } from "./gableProbe.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLIENT = "harness-boot";
const CONFIG = { ...GABLE_CONFIG, clientId: CLIENT };
const COMPONENT = "/structure-studio.component.compiled.js";
// Longer than the guard's 6 s reload backstop, so "no further reload" is a real statement.
const QUIET_MS = 8000;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };

function startServer() {
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/") path = "/index.html";
    const file = resolve(ROOT, "." + path);
    let body = null;
    try { if (file.startsWith(ROOT + sep) && statSync(file).isFile()) body = readFileSync(file); } catch (_e) { body = null; }
    if (!body) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// How a script request is answered. "ok" passes through to the local server; the rest are the
// ways a bundle has actually failed to run in the field (39e84b5): a body that stopped short,
// a 404, a dropped connection.
async function answer(route, how, file) {
  if (how === "ok") return route.continue();
  if (how === "abort") return route.abort("failed");
  if (how === "404") return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
  if (how === "truncated") {
    const full = readFileSync(join(ROOT, file));
    return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: full.subarray(0, Math.floor(full.length * 0.4)) });
  }
  throw new Error("unknown answer " + how);
}

// One scenario = one fresh context (so sessionStorage, where the retry latch lives, starts empty).
// `plan` maps a pathname to a function (nth script request, 1-based) -> answer. Only requests the
// PARSER makes (resourceType "script") consume the plan; the guard's cache:"reload" re-fetches
// ("fetch") are recorded and passed through, exactly as a CDN would answer them.
async function scenario(browser, { path, plan = {}, storage = "normal" }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const logs = [];
  const nav = [];
  const refetch = [];
  const bundleFetches = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.exposeFunction("__harnessLogError", (body) => { logs.push(body); });
  await page.exposeFunction("__harnessBundleFetch", (rec) => { bundleFetches.push(rec); });
  await page.addInitScript(() => {
    const orig = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.indexOf("/rest/v1/rpc/log_error") !== -1) {
          let body = null;
          try { body = JSON.parse((init && init.body) || "null"); } catch (_e) { body = null; }
          window.__harnessLogError(body);
        }
        // The cache MODE the guard asked for. Playwright does not report the no-cache header
        // Chrome adds for cache:"reload" (it is set below the interception layer), so read the
        // request the page made rather than the one the router saw.
        if (url.indexOf(".compiled.js") !== -1) window.__harnessBundleFetch({ url, cache: (init && init.cache) || null });
      } catch (_e) { /* the harness must not change what the page does */ }
      return orig.apply(this, arguments);
    };
  });
  // HOSTILE STORAGE: the retry latch lives in sessionStorage, so these are the environments where
  // a latch that is written but not kept would turn "retry once" into "reload forever".
  //   drop  - setItem silently keeps nothing (getItem stays null)
  //   throw - touching sessionStorage throws (blocked storage, some embedded frames)
  if (storage !== "normal") {
    await page.addInitScript((mode) => {
      if (mode === "drop") {
        const real = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) { if (this === window.sessionStorage) return; return real.call(this, k, v); };
      } else if (mode === "throw") {
        Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
      }
    }, storage);
  }
  await bypassGate(page, CLIENT);
  const calls = await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  const seen = {};
  for (const [pathname, pick] of Object.entries(plan)) {
    await page.route((u) => u.pathname === pathname, (route) => {
      const req = route.request();
      if (req.resourceType() !== "script") {
        refetch.push({ path: pathname, headers: req.headers() });
        return route.continue();
      }
      seen[pathname] = (seen[pathname] || 0) + 1;
      return answer(route, pick(seen[pathname]), pathname);
    });
  }
  page.on("request", (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) nav.push(Date.now()); });

  const state = () => page.evaluate(() => ({
    booted: window.__ssAppBooted === true,
    component: typeof window.StructureStudio,
    screen: !!document.getElementById("ss-boot-reload"),
    blocked: window.__ssBootBlocked === true,
    latch: (() => { try { return sessionStorage.getItem("ss_boot_retry"); } catch (_e) { return "unreadable"; } })(),
    noindex: !!document.querySelector('meta[name="robots"][content="noindex"]'),
    rootText: ((document.getElementById("root") || document.body).innerText || "").length,
  }));

  // Poll until the page settles (a screen, or a mounted app) and then stays settled with no
  // navigation for QUIET_MS. Evaluations that race a reload throw; that is expected, retry.
  async function settle(timeout = 45000) {
    const t0 = Date.now();
    let last = null;
    let quietFrom = null;
    let navCount = nav.length;
    while (Date.now() - t0 < timeout) {
      await page.waitForTimeout(250);
      let s = null;
      try { s = await state(); } catch (_e) { s = null; }
      if (nav.length !== navCount) { navCount = nav.length; quietFrom = null; continue; }
      const done = s && (s.screen || (s.booted && !s.blocked && s.rootText > 0));
      if (!done) { quietFrom = null; continue; }
      last = s;
      if (quietFrom === null) quietFrom = Date.now();
      if (Date.now() - quietFrom >= QUIET_MS) return last;
    }
    return last;
  }
  return { ctx, page, logs, nav, refetch, bundleFetches, calls, pageErrors, settle, state, seen };
}

const bootLogs = (logs) => logs.filter((b) => b && b.p_source === "boot");
const netLogs = (calls) => calls.filter((c) => c.path && /\/rpc\/log_error$/.test(c.path));
const short = (o) => JSON.stringify(o).slice(0, 400);

export async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("boot-guard");
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    channel: process.env.PW_CHANNEL === "bundled" ? undefined : "chrome",
    headless: process.env.HEADED ? false : true,
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  const designer = `${base}/?client=${CLIENT}`;
  try {
    // ── 1. the component broken once, then fine ─────────────────────────────────────────────
    {
      const s = await scenario(browser, { path: designer, plan: { [COMPONENT]: (n) => (n === 1 ? "truncated" : "ok") } });
      await s.page.goto(designer, { waitUntil: "domcontentloaded" });
      const end = await s.settle();
      ok("1. component truncated once: exactly one reload", s.nav.length === 2, `navigations=${s.nav.length}`);
      ok("1. ...the app mounts on the second load, no failure screen", !!end && end.booted && end.component === "function" && !end.screen && !end.blocked, short(end));
      ok("1. ...nothing is logged", bootLogs(s.logs).length === 0 && netLogs(s.calls).length === 0, short(s.logs));
      ok("1. ...the retry latch is cleared by the boot that worked", !!end && end.latch === null, `latch=${end && end.latch}`);
      ok("1. ...and the component was re-fetched past the HTTP cache (cache:\"reload\") before the reload",
        s.refetch.some((r) => r.path === COMPONENT) && s.bundleFetches.some((b) => b.url.indexOf(COMPONENT) !== -1 && b.cache === "reload"), short(s.bundleFetches));
      ok("1. ...and no noindex tag on the healed page", !!end && !end.noindex);
      await s.page.screenshot({ path: join(shots, "1-healed.png") });
      await s.ctx.close();
    }
    // ── 1b. a dropped connection once ──────────────────────────────────────────────────────
    {
      const s = await scenario(browser, { path: designer, plan: { [COMPONENT]: (n) => (n === 1 ? "abort" : "ok") } });
      await s.page.goto(designer, { waitUntil: "domcontentloaded" });
      const end = await s.settle();
      ok("1b. component download dropped once: exactly one reload, app mounts, nothing logged",
        s.nav.length === 2 && !!end && end.booted && !end.screen && bootLogs(s.logs).length === 0, `navigations=${s.nav.length} ${short(end)}`);
      await s.ctx.close();
    }
    // ── 2. the component broken on every load ───────────────────────────────────────────────
    for (const how of ["truncated", "404"]) {
      let fixed = false;
      const s = await scenario(browser, { path: designer, plan: { [COMPONENT]: () => (fixed ? "ok" : how) } });
      await s.page.goto(designer, { waitUntil: "domcontentloaded" });
      const end = await s.settle();
      const rows = bootLogs(s.logs);
      const ctx0 = rows[0] && rows[0].p_context;
      ok(`2 (${how}). always broken: exactly one reload, then the screen`, s.nav.length === 2 && !!end && end.screen, `navigations=${s.nav.length} ${short(end)}`);
      ok(`2 (${how}). ...exactly one boot_component_missing row`, rows.length === 1 && rows[0].p_code === "boot_component_missing", short(rows));
      ok(`2 (${how}). ...the network saw that one row too (stubbed)`, netLogs(s.calls).length === 1, `network log_error calls=${netLogs(s.calls).length}`);
      ok(`2 (${how}). ...with real diagnostics: scripts facts and failedToLoad are arrays, retried=true`,
        !!ctx0 && Array.isArray(ctx0.scripts) && ctx0.scripts.length > 0 && Array.isArray(ctx0.failedToLoad) && ctx0.retried === true,
        short(ctx0));
      ok(`2 (${how}). ...scripts facts name the component`, !!ctx0 && Array.isArray(ctx0.scripts) && ctx0.scripts.some((x) => x.indexOf("structure-studio.component.compiled.js") === 0), short(ctx0 && ctx0.scripts));
      if (how === "404") {
        ok("2 (404). ...failedToLoad carries the component URL (onerror measured it)",
          !!ctx0 && Array.isArray(ctx0.failedToLoad) && ctx0.failedToLoad.some((u) => String(u).indexOf(COMPONENT) !== -1), short(ctx0 && ctx0.failedToLoad));
      } else {
        ok("2 (truncated). ...the first error is recorded (a throw, not a failed download)",
          !!ctx0 && ctx0.error && typeof ctx0.error.message === "string" && ctx0.error.message.length > 0, short(ctx0 && ctx0.error));
      }
      ok(`2 (${how}). ...the screen carries noindex and the latch stays set`, !!end && end.noindex && end.latch === "1", short(end));
      await s.page.screenshot({ path: join(shots, `2-${how}-screen.png`) });

      if (how === "truncated") {
        // 2c. the visitor presses Reload while it is still broken
        const before = s.nav.length;
        await s.page.click("#ss-boot-reload");
        const end2 = await s.settle();
        ok("2c. Reload while still broken: one navigation (the click's), the screen again, no automatic reload",
          s.nav.length === before + 1 && !!end2 && end2.screen, `navigations=${s.nav.length - before} ${short(end2)}`);
        ok("2c. ...one more row, no more", bootLogs(s.logs).length === 2, `rows=${bootLogs(s.logs).length}`);
        // 2d. fixed now: the click lands on a working app and the latch is released
        fixed = true;
        const before2 = s.nav.length;
        await s.page.click("#ss-boot-reload");
        const end3 = await s.settle();
        ok("2d. Reload once fixed: one navigation, the app mounts, latch cleared",
          s.nav.length === before2 + 1 && !!end3 && end3.booted && !end3.screen && end3.latch === null, `navigations=${s.nav.length - before2} ${short(end3)}`);
        ok("2d. ...no row for the load that worked", bootLogs(s.logs).length === 2, `rows=${bootLogs(s.logs).length}`);
      }
      await s.ctx.close();
    }
    // ── 2e/2f. storage that cannot hold the latch: no retry at all, never a loop ─────────────
    for (const storage of ["drop", "throw"]) {
      for (const target of [{ name: "designer component", url: designer, file: COMPONENT, code: "boot_component_missing" },
                            { name: "portal app script", url: `${base}/portal.html`, file: "/portal.app.compiled.js", code: "boot_app_missing" }]) {
        const s = await scenario(browser, { path: target.url, plan: { [target.file]: () => "404" }, storage });
        await s.page.goto(target.url, { waitUntil: "domcontentloaded" });
        const end = await s.settle(30000);
        const rows = bootLogs(s.logs);
        ok(`2${storage === "drop" ? "e" : "f"}. ${target.name} always broken, sessionStorage ${storage === "drop" ? "drops writes" : "throws"}: zero reloads, the screen at once`,
          s.nav.length === 1 && !!end && end.screen, `navigations=${s.nav.length} ${short(end)}`);
        ok(`2${storage === "drop" ? "e" : "f"}. ${target.name} ...exactly one ${target.code} row`, rows.length === 1 && rows[0].p_code === target.code, short(rows.map((r) => r.p_code)));
        await s.ctx.close();
      }
    }
    // ── 3. healthy designer ────────────────────────────────────────────────────────────────
    {
      const s = await scenario(browser, { path: designer });
      await s.page.goto(designer, { waitUntil: "domcontentloaded" });
      const end = await s.settle();
      ok("3. healthy designer: zero reloads", s.nav.length === 1, `navigations=${s.nav.length}`);
      ok("3. ...mounts, no screen, latch empty", !!end && end.booted && end.component === "function" && !end.screen && end.latch === null, short(end));
      ok("3. ...zero log calls", s.logs.length === 0 && netLogs(s.calls).length === 0, short(s.logs));
      ok("3. ...no uncaught page errors", s.pageErrors.length === 0, s.pageErrors.slice(0, 3).join(" | "));
      await s.page.screenshot({ path: join(shots, "3-healthy.png") });
      await s.ctx.close();
    }
    // ── 4. the failure modes portal, admin and index's own app script already had ─────────
    const pages = [
      { name: "portal", url: `${base}/portal.html`, app: "/portal.app.compiled.js" },
      { name: "admin", url: `${base}/admin.html`, app: "/admin.app.compiled.js" },
      { name: "designer", url: designer, app: "/index.mount.compiled.js" },
    ];
    for (const p of pages) {
      if (p.name !== "designer") {
        const s = await scenario(browser, { path: p.url });
        await s.page.goto(p.url, { waitUntil: "domcontentloaded" });
        const end = await s.settle();
        ok(`4a. ${p.name} healthy: zero reloads, boots, no screen, no boot row`,
          s.nav.length === 1 && !!end && end.booted && !end.screen && bootLogs(s.logs).length === 0, `navigations=${s.nav.length} ${short(end)} logs=${short(s.logs)}`);
        await s.ctx.close();
      }
      {
        const s = await scenario(browser, { path: p.url, plan: { [p.app]: () => "404" } });
        await s.page.goto(p.url, { waitUntil: "domcontentloaded" });
        const end = await s.settle();
        const rows = bootLogs(s.logs);
        const c = rows[0] && rows[0].p_context;
        ok(`4b. ${p.name} app script 404 every load: one reload, then the screen`, s.nav.length === 2 && !!end && end.screen, `navigations=${s.nav.length} ${short(end)}`);
        ok(`4b. ${p.name} ...one boot_app_missing row, measured failedToLoad, retried`,
          rows.length === 1 && rows[0].p_code === "boot_app_missing" && !!c && c.retried === true && Array.isArray(c.failedToLoad) && c.failedToLoad.some((u) => u.indexOf(p.app.slice(1)) !== -1), short(rows));
        await s.page.screenshot({ path: join(shots, `4b-${p.name.replace(/ /g, "-")}.png`) });
        await s.ctx.close();
      }
      {
        const s = await scenario(browser, { path: p.url, plan: { [p.app]: (n) => (n === 1 ? "truncated" : "ok") } });
        await s.page.goto(p.url, { waitUntil: "domcontentloaded" });
        const end = await s.settle();
        ok(`4c. ${p.name} app script broken once: one reload, boots, no boot row, latch cleared`,
          s.nav.length === 2 && !!end && end.booted && !end.screen && bootLogs(s.logs).length === 0 && end.latch === null, `navigations=${s.nav.length} ${short(end)}`);
        await s.ctx.close();
      }
      {
        const s = await scenario(browser, { path: p.url, plan: { "/vendor/react-dom-18.2.0.production.min.js": () => "404" } });
        await s.page.goto(p.url, { waitUntil: "domcontentloaded" });
        const end = await s.settle();
        const rows = bootLogs(s.logs);
        ok(`4f. ${p.name} vendored library missing: the screen at once, no reload`, s.nav.length === 1 && !!end && end.screen, `navigations=${s.nav.length} ${short(end)}`);
        ok(`4f. ${p.name} ...one boot_deps_missing row naming react-dom, detail keys null as before`,
          rows.length === 1 && rows[0].p_code === "boot_deps_missing" && rows[0].p_context.missing.join() === "react-dom"
          && rows[0].p_context.scripts === null && rows[0].p_context.failedToLoad === null && rows[0].p_context.retried === false, short(rows));
        await s.ctx.close();
      }
    }
  } catch (e) {
    ok("harness ran to the end", false, e && e.stack ? e.stack.split("\n").slice(0, 5).join(" / ") : String(e));
  } finally {
    await browser.close();
    server.close();
  }
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
  console.log(`shots in ${shots}`);
  return bad.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((n) => process.exit(n ? 1 : 0));
}
