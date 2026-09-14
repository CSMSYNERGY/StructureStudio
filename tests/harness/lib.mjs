// Reusable local harness for driving the PUBLIC DESIGNER in a real browser with no Supabase
// account, no login and no writes to the shared project.
//
// WHY UNDER tests/ AND NOT dev/. dev/ uploads with the site (it is not in .assetsignore), so a
// harness there is a public download on every tenant's host. tests/ is excluded. Same technique
// as dev/verify-cal3d.mjs, which stubs Supabase at the NETWORK layer for the portal: every call
// the page makes is answered here, so the run exercises the COMPILED artifacts the browser
// really loads (structure-studio.component.compiled.js) against a config we control. A change
// that was never `npm run compile`d is invisible to it — that is the point, not a gap.
//
//   1. python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   2. node tests/harness/<script>.mjs
//
// ⚠️ NOTHING LEAVES THE MACHINE. Every Supabase host is fulfilled locally, and every other
// non-local request is aborted. capture-lead, save_design, submit-estimate and log_error would
// otherwise write rows into the one database beta AND production share.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bypassGate } from "../e2e/helpers.mjs";

export { bypassGate };
export const REF = "jzeamjbhdrsbygdnphbm";
export const BASE = process.env.SS_BASE || "http://127.0.0.1:8125";

// A tiny assertion log: every check prints, the exit code is the verdict.
export function reporter() {
  const results = [];
  const ok = (name, pass, note) => {
    results.push({ name, pass: !!pass, note });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? "   [" + note + "]" : ""}`);
    return !!pass;
  };
  const failed = () => results.filter((r) => !r.pass);
  return { ok, results, failed };
}

// channel: "chrome", for the reason playwright.config.mjs gives: `npx playwright install
// chromium` has failed repeatedly on this machine. SwiftShader so WebGL renders headless (the
// in-app browser pane starves requestAnimationFrame and cannot be used for 3D).
export async function launch({ width = 1280, height = 900 } = {}) {
  const browser = await chromium.launch({
    channel: process.env.PW_CHANNEL === "bundled" ? undefined : "chrome",
    headless: process.env.HEADED ? false : true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const ctx = await browser.newContext({ viewport: { width, height } });
  return { browser, ctx };
}

const JSON_HEADERS = { "access-control-allow-origin": "*" };
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", headers: JSON_HEADERS, body: JSON.stringify(body) });

// Answer every Supabase call the designer makes. Returns the call log so a script can assert on
// what the page TRIED to do (a write it attempted is a finding even though it went nowhere).
//
// ⚠️ ROUTE ORDER: Playwright runs matching routes in REVERSE registration order, so the
// catch-all abort is registered FIRST and the Supabase handlers after it override it. The other
// way round aborts get_config and the page sits on its loading screen, which reads exactly like
// a product regression.
//
// The one exception to "nothing leaves": GETs to the module CDN the 3D viewer imports three.js
// from (esm.sh). Aborting those is harmless for 2D and fatal for 3D — the panel shows "The 3D
// view couldn't load" and every 3D check fails for a reason that has nothing to do with the app.
export const PASS_THROUGH_GET = /^https:\/\/esm\.sh\//;
export async function stubSupabase(page, { config, fixtures = [], rpc = {} } = {}) {
  const calls = [];
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => {
    const req = route.request();
    if (req.method() === "GET" && PASS_THROUGH_GET.test(req.url())) return route.continue();
    calls.push({ method: req.method(), url: req.url(), aborted: true });
    return route.abort();
  });
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 200, headers: { ...JSON_HEADERS, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    }
    const path = new URL(url).pathname;
    let body = null;
    try { body = JSON.parse(req.postData() || "null"); } catch (_e) { body = req.postData(); }
    calls.push({ method: req.method(), url, path, body });
    const m = /\/rest\/v1\/rpc\/([A-Za-z0-9_]+)/.exec(path);
    if (m) {
      if (m[1] === "get_config") return json(route, config);
      if (m[1] === "get_fixtures") return json(route, fixtures);
      if (Object.prototype.hasOwnProperty.call(rpc, m[1])) return json(route, rpc[m[1]]);
      return json(route, null);
    }
    if (path.startsWith("/rest/v1/")) return json(route, []);
    if (path.startsWith("/functions/v1/")) return json(route, { ok: true });
    if (path.startsWith("/auth/v1/")) return json(route, {});
    return route.fulfill({ status: 404, headers: JSON_HEADERS, body: "" });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(`**/${REF}.storage.supabase.co/**`, handler);
  return calls;
}

// Every refusal the designer shows goes through setToast (2D) or flash3 (3D) and is gone again
// in 4-5 s. Recording them from a MutationObserver installed before the app boots means a check
// cannot miss one by looking a moment too late — "no refusal" is then a real statement.
export const REFUSAL_RE = /already mounted|already on that part|in the way at that height|is blocking this wall|Can't place here|Lofts can't overlap|Pick which one/;
export async function recordRefusals(page) {
  await page.addInitScript((src) => {
    const re = new RegExp(src);
    window.__harnessRefusals = [];
    const seen = new Set();
    const scan = (node) => {
      const t = (node && (node.nodeType === 3 ? node.nodeValue : node.textContent)) || "";
      if (!re.test(t)) return;
      const line = t.trim().slice(0, 200);
      if (seen.has(line)) return;
      seen.add(line);
      window.__harnessRefusals.push({ at: Date.now(), text: line });
      // De-duplicate only the SAME render (React can add the node and its text in one burst).
      // A longer window swallowed a second, identical refusal a few seconds later — the flood
      // light's "already mounted there" right after the shelf's — and passed that check blind.
      setTimeout(() => seen.delete(line), 250);
    };
    const mo = new MutationObserver((muts) => {
      for (const mu of muts) {
        mu.addedNodes.forEach(scan);
        if (mu.type === "characterData") scan(mu.target);
      }
    });
    // ⚠️ An init script runs BEFORE <html> exists, so observing document.documentElement there
    // throws — and a recorder that silently never started makes every "no refusal toast" check
    // pass vacuously (it did, on the first run of this harness). Attach once the root exists.
    const attach = () => {
      if (document.documentElement) { mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); window.__harnessRefusalsLive = true; return; }
      setTimeout(attach, 5);
    };
    attach();
  }, REFUSAL_RE.source);
}
// Wait for any refusal still on screen to clear before the next step. A toast showing the SAME
// text as the one about to be raised is not re-rendered — React leaves the node alone — so a
// second identical refusal inside the first one's 4-5 s is invisible to any DOM recorder. This
// hid a real refusal on the first baseline run; every step now starts from a clean screen.
export async function waitNoRefusal(page, timeout = 8000) {
  await page.waitForFunction((src) => !new RegExp(src).test(document.body.innerText), REFUSAL_RE.source, { timeout }).catch(() => {});
}
export const refusalsSince = (page, t0) =>
  page.evaluate((t) => (window.__harnessRefusals || []).filter((r) => r.at >= t).map((r) => r.text), t0);

export function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const t = msg.text();
    // Aborted third-party requests are this harness's own doing, not the app's.
    if (/net::ERR_FAILED|ERR_BLOCKED|Failed to load resource/.test(t)) return;
    errors.push(t);
  });
  return errors;
}

export async function openDesigner(page, clientId) {
  await bypassGate(page, clientId);
  await page.goto(`${BASE}/?client=${encodeURIComponent(clientId)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
}

// The designer's live items[] through the React fiber (no debug hook exists). Unlike
// tests/e2e/helpers.mjs's designerItems this returns the WHOLE item, because the checks here
// are about fields that one projects away (heightOffFloorIn, electricalItemId, elecAuto).
export async function readItems(page) {
  return page.evaluate(() => {
    const root = document.getElementById("root");
    const k = Object.keys(root).find((x) => x.startsWith("__reactContainer"));
    const q = [root[k]]; let n = 0;
    while (q.length && n < 80000) {
      const f = q.shift(); n++; if (!f) continue;
      const nm = f.type && (f.type.name || f.type.displayName);
      if (nm === "StructureStudioInner") {
        let h = f.memoizedState;
        while (h) {
          const v = h.memoizedState;
          if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "type" in v[0] && ("x" in v[0] || "wall" in v[0])) {
            return JSON.parse(JSON.stringify(v));
          }
          h = h.next;
        }
        return [];
      }
      if (f.child) q.push(f.child);
      if (f.sibling) q.push(f.sibling);
    }
    return null;
  });
}

// Screen point for a PLAN coordinate in SVG units (the space items[].x/y live in).
// Scrolls the plan into view first: page.mouse.* fires at raw viewport coordinates and never
// scrolls, so an off-screen point silently hits nothing (see planPoint in tests/e2e/helpers.mjs).
export async function svgPoint(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const svg = [...document.querySelectorAll("svg")].find((s) => [...s.querySelectorAll("rect")].some((r) => r.getAttribute("stroke") === "#1E293B"));
    svg.scrollIntoView({ block: "center", behavior: "instant" });
    const pt = svg.createSVGPoint(); pt.x = x; pt.y = y;
    const c = pt.matrixTransform(svg.getScreenCTM());
    return { x: c.x, y: c.y };
  }, { x, y });
}
// The building rectangle in SVG units: x/y are the plan margins, width/height the building in
// plan units, so feet convert with the size the test chose.
export async function buildingRect(page) {
  return page.evaluate(() => {
    const svg = [...document.querySelectorAll("svg")].find((s) => [...s.querySelectorAll("rect")].some((r) => r.getAttribute("stroke") === "#1E293B"));
    if (!svg) return null;
    const r = [...svg.querySelectorAll("rect")].find((el) => el.getAttribute("stroke") === "#1E293B");
    return { x: +r.getAttribute("x"), y: +r.getAttribute("y"), w: +r.getAttribute("width"), h: +r.getAttribute("height") };
  });
}

// Screenshots go to SS_SHOTS, else the OS temp dir — never into the checkout. test-results/ is
// kept off the web host by .assetsignore but is NOT in .gitignore, so a default inside the repo
// leaves untracked PNGs for the next `git status` (and a careless add) to find.
export function shotsDir(sub) {
  const dir = process.env.SS_SHOTS || join(tmpdir(), "ss-harness", sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}
