// Shared helpers for the smoke suite. Test tenants only - never point these at a paying
// builder's account: the public designer writes captured_leads / draft designs the moment
// the gate is passed or Details opens.
import { test as base, expect } from "@playwright/test";

export const SUPABASE_URL = "https://jzeamjbhdrsbygdnphbm.supabase.co";

// ── log_error NEVER LEAVES THE SUITE ─────────────────────────────────────────────────────────
// WHY. Every page logs to the ONE Supabase project that beta and production share, and this
// suite drives beta. Runs of it filed hundreds of app_errors rows against the test tenant, 4 of
// them boot_component_missing that read exactly like a live outage. log_error cannot tell them
// apart (the page URL is a real https beta URL; migration 243 only demotes data:, file: and
// loopback pages), so the suite answers log_error itself.
//
// Per BrowserContext:
//  1. An init script points every log_error fetch at the page's OWN origin
//     (/__e2e/rest/v1/rpc/log_error). The product sends these with keepalive, and a keepalive
//     request from a document that is going away cannot be held by page.route or context.route
//     when it is cross-origin: context.route lets it straight through to the live project (see
//     customer-login.spec's save_design redirect). Same-origin, a miss can only reach the static
//     host, never the database. Body and headers are the product's own.
//  2. context.route answers it 204 locally. A page.route that matches first still wins (page routes
//     run before context routes), so customer-login's stubBackend keeps recording and answering its
//     own log_error calls.
//  3. A context "request" listener records every body, including the ones a page.route answered.
// finish(testInfo) attaches the bodies to the report and THROWS when one carries a boot_* code:
// the page failed to load, so the run fails loudly instead of filing a row.
//
// The `test` exported below does this for the `context` (and so the `page`) fixture. A context the
// test makes itself (browser.newContext / browser.newPage) needs guardLogError(context) and a
// finish(testInfo) of its own.
const LOG_ERROR_URL = /\/rest\/v1\/rpc\/log_error(?:[?#]|$)/;
const LOG_ERROR_ATTACHMENT = "log_error calls (answered locally, never filed)";
const guards = new WeakMap();

export async function guardLogError(context) {
  if (guards.has(context)) return guards.get(context);
  const rows = [];
  const guard = {
    rows,
    attachmentName: LOG_ERROR_ATTACHMENT,
    // Takes the rows recorded so far, so a page shared across tests (portal-routes) can call it
    // once per test.
    async finish(testInfo) {
      const batch = rows.splice(0, rows.length);
      if (!batch.length) return;
      await testInfo.attach(LOG_ERROR_ATTACHMENT, { body: JSON.stringify(batch, null, 2), contentType: "application/json" });
      const boot = batch.filter((r) => /^boot_/.test(String((r.body && r.body.p_code) || "")));
      if (boot.length) {
        throw new Error("The page reported a boot failure: "
          + boot.map((r) => `${r.body.p_code} (${r.body.p_message})`).join("; ")
          + `. The log_error bodies are attached as "${LOG_ERROR_ATTACHMENT}"; nothing was filed in app_errors.`);
      }
    },
  };
  guards.set(context, guard);

  await context.addInitScript(() => {
    const realFetch = window.fetch;
    window.fetch = function (input, init) {
      const href = typeof input === "string" ? input : (input instanceof URL ? input.href : "");
      if (/^https?:$/.test(location.protocol) && /^https?:\/\/[^/]+\/rest\/v1\/rpc\/log_error(?:[?#]|$)/.test(href)) {
        return realFetch.call(window, "/__e2e/rest/v1/rpc/log_error", init);
      }
      return realFetch.apply(window, arguments);
    };
  });
  context.on("request", (req) => {
    if (req.method() !== "POST" || !LOG_ERROR_URL.test(req.url())) return;
    let body = null;
    try { body = req.postDataJSON(); } catch (_e) { body = req.postData(); }
    rows.push({ at: new Date().toISOString(), url: req.url(), body });
  });
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, prefer",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  await context.route(LOG_ERROR_URL, (route) => route.fulfill(route.request().method() === "OPTIONS"
    ? { status: 200, headers: cors, body: "ok" }
    : { status: 204, headers: cors })
    .catch(() => { /* the page closed while the call was in flight */ }));
  return guard;
}

export const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    const guard = await guardLogError(context);
    await use(context);
    await guard.finish(testInfo);
  },
});
// The public anon key is deliberately baked into every page (RLS makes it browser-safe); the
// suite reads it off the served index.html so it never has to be duplicated here.
export async function anonKey(page) {
  const html = await page.evaluate(async () => (await fetch("/index.html")).text());
  const m = html.match(/eyJ[A-Za-z0-9._-]{80,}/);
  if (!m) throw new Error("anon key not found in index.html");
  return m[0];
}

export const CLIENT = process.env.PW_CLIENT || "pw-demo-barns";

// Sign the portal in without a password: a one-time magic-link hashed_token minted outside
// the suite. verifyOtp writes the same sb-<ref>-auth-token localStorage key the portal reads.
export async function loginWithMagicToken(page) {
  const token = process.env.PW_MAGIC_TOKEN;
  if (!token) throw new Error("PW_MAGIC_TOKEN is not set (mint one with the Auth admin generate_link API for a test owner)");
  await page.goto("/portal");
  await page.waitForFunction(() => window.supabase && window.__ssAppBooted === true);
  const key = await anonKey(page);
  const result = await page.evaluate(async ({ url, key, token }) => {
    const c = window.supabase.createClient(url, key);
    const r = await c.auth.verifyOtp({ token_hash: token, type: "magiclink" });
    return { error: r.error ? r.error.message : null, email: r.data && r.data.user ? r.data.user.email : null };
  }, { url: SUPABASE_URL, key, token });
  expect(result.error, "magic link accepted").toBeNull();
  await page.reload();
  await page.waitForFunction(() => window.__ssAppBooted === true);
  // .first(): the portal renders THREE `.ss-nav` elements (main tabs, the sub-nav, and
  // the settings nav), so a bare locator is a strict-mode violation and every portal test
  // fails in this shared helper with an error that names the designer route it happened to
  // be running - reading exactly like a product bug. The assertion only means "the portal
  // chrome painted", and any one of the three proves that.
  await expect(page.locator(".ss-nav").first()).toBeVisible({ timeout: 30_000 });
  return result.email;
}

// The lead gate stores its pass in localStorage; setting it lets the designer be driven
// without writing a captured_leads row for the tenant.
export async function bypassGate(page, clientId) {
  await page.addInitScript((id) => {
    try { localStorage.setItem("ss_gate_" + id, "1"); localStorage.setItem("ss_gate_name_" + id, "Smoke Test"); } catch (_e) {}
  }, clientId);
}

// Section 03's tools live on option tabs (Carolyn 2026-09-16): only each group's chosen tab is
// rendered, so a tool on a closed tab is not in the page at all. Open a tab by its key
// (data-ss-opt-tab); a no-op where there are no tabs, e.g. a locked plan.
export async function showOptTab(page, key) {
  const tab = page.locator(`[data-ss-opt-tab="${key}"]`).first();
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(150); }
}
// The tool button named `name` (a string or RegExp, matched like getByRole), after opening
// whichever option tab holds it. Tabs are role="tab", so they never match a tool's name.
export async function revealTool(page, name) {
  const btn = page.getByRole("button", { name }).first();
  if (await btn.isVisible().catch(() => false)) return btn;
  const keys = await page.locator("[data-ss-opt-tab]").evaluateAll((els) => els.map((e) => e.getAttribute("data-ss-opt-tab")));
  for (const k of keys) {
    await showOptTab(page, k);
    if (await btn.isVisible().catch(() => false)) return btn;
  }
  return btn;
}

// Collect console errors for the lifetime of a page; ignore third-party noise we do not own.
export function watchConsole(page) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/googleapis|gstatic|cdn-cgi\/rum|beacon\.min\.js/.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
  return errors;
}

// Read the designer's live items[] state through the React fiber (no debug hook exists).
export async function designerItems(page) {
  return page.evaluate(() => {
    const root = document.getElementById("root");
    const k = Object.keys(root).find((k) => k.startsWith("__reactContainer"));
    const q = [root[k]]; let n = 0;
    while (q.length && n < 60000) {
      const f = q.shift(); n++; if (!f) continue;
      const nm = f.type && (f.type.name || f.type.displayName);
      if (nm === "StructureStudioInner") {
        let h = f.memoizedState;
        while (h) {
          const v = h.memoizedState;
          if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "type" in v[0] && ("x" in v[0] || "wall" in v[0])) {
            // fixtureItemId is projected because a placed CATALOG window is a plain
            // type:"window" item (StructureStudio.jsx:611) — the id is the only thing that
            // tells it apart from the built-in window that used to exist, so without it a
            // test cannot assert the catalog path was the one that ran.
            // openingHeightFt / sillFt are projected because they are the ONLY thing that makes a
            // window rough opening different from a door one — the 3D hole, the drag highlight
            // and the printed elevation band all derive from that pair, so asserting the stamp is
            // asserting the geometry without reading a pixel.
            return v.map((i) => ({ type: i.type, wall: i.wall, x: Math.round(i.x), y: Math.round(i.y), fixtureItemId: i.fixtureItemId, openingHeightFt: i.openingHeightFt, sillFt: i.sillFt }));
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

// Client-space point for a plan coordinate in feet (building rect is the #1E293B-stroked rect).
// SCROLLS THE PLAN INTO VIEW FIRST, and that is not a nicety. Callers click these coordinates
// with page.mouse.click(), which fires at raw viewport coordinates and — unlike a locator click —
// does NOT scroll the target into view. At the default 1280x800 the lower half of the plan sits
// below the fold, so every click there landed outside the document: elementFromPoint returned
// null, nothing was placed, and NO refusal toast appeared. That reads in the report as "a window
// cannot be placed on the east wall", and it cost a long diagnosis to prove the product was fine
// (north y=0 and east y=3 placed; east y=6 and south y=12 were simply off-screen at y=867/1129).
export async function planPoint(page, fx, fy) {
  return page.evaluate(({ fx, fy }) => {
    const svg = [...document.querySelectorAll("svg")].find((s) => [...s.querySelectorAll("text")].some((t) => / ft$/.test(t.textContent)));
    // Instant, not smooth: the CTM is read on the next line and must reflect the final scroll.
    svg.scrollIntoView({ block: "center", behavior: "instant" });
    const r = [...svg.querySelectorAll("rect")].find((r) => r.getAttribute("stroke") === "#1E293B");
    const ft = [...svg.querySelectorAll("text")].map((t) => t.textContent.trim()).filter((t) => /^\d+ ft$/.test(t));
    const W = parseInt(ft[0] || "10", 10), H = parseInt(ft[2] || "12", 10);
    const px = +r.getAttribute("x") + fx / W * +r.getAttribute("width");
    const py = +r.getAttribute("y") + fy / H * +r.getAttribute("height");
    const pt = svg.createSVGPoint(); pt.x = px; pt.y = py;
    const c = pt.matrixTransform(svg.getScreenCTM());
    return { x: c.x, y: c.y };
  }, { fx, fy });
}
