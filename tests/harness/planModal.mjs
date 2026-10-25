// THE FLOORPLAN PDF PREVIEW FITS THE SCREEN (2026-10-21), on the public designer (index.html) and the
// portal designer (portal.html, embedded), driven on the COMPILED bundles.
//
// Ahsan, on beta at 1920 x 1080: "i can not see the buttons it is flowing out of the screen the download
// buttons". The 8.5 x 11 page at the modal's 580px width stood ~690px tall on its own, so the Download
// PDF / PNG / Copy row fell below the screen. At every size here, after pressing Floorplan PDF:
//   M1 the modal is inside the viewport, top to bottom
//   M2 the close button and the three action buttons are wholly on screen
//   M3 the whole page preview shows above the buttons, at a readable size (desktop sizes)
//   M4 nothing scrolls the page sideways
//   M5 (portal) Back with the preview open (the browser's button, Android's gesture, Alt+Left) leaves the
//      designer AND closes the preview: it sits on document.body, so hiding the designer used to leave
//      it over the next page (2026-10-23 promotion review)
// Sizes: 1366x768, 1440x900, 1920x1080, 1920x945 (a 1080 screen less Chrome's own bars), 1536x730
// and 1280x620 (that screen at 125% / 150% scaling) on both surfaces, and 390x844 (a phone) on the
// public page. Each size is screenshotted as
// <TAG>-<surface>-<w>x<h>.png in the shots folder.
//
// The portal is opened without a login, the way designerWidthCapPortal.mjs does it: a session in
// localStorage and every Supabase call answered locally. NOTHING LEAVES THE MACHINE.
//
//   node tests/harness/planModal.mjs        (SS_BASE=http://127.0.0.1:<port>, SS_SHOTS=<dir>, TAG=<name>)
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, reporter, shotsDir, bypassGate, BASE, REF } from "./lib.mjs";
import { CONFIG as GABLE_CONFIG, FIXTURES } from "./gableProbe.mjs";

const { ok, failed } = reporter();
const shots = shotsDir("plan-modal");
const TAG = process.env.TAG || "after";
const CLIENT = "harness-plan-modal";
const CONFIG = { ...GABLE_CONFIG, clientId: CLIENT, contactFields: [] };
// 1536x730 and 1280x620 are a 1920x1080 screen at Windows display scaling 125% and 150% (the laptop
// defaults), less Chrome's bars: what a "1920x1080" screenshot of the portal usually is.
const DESK = [[1366, 768], [1440, 900], [1920, 1080], [1920, 945], [1536, 730], [1280, 620]];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(p)}.c3R1Yg`;
const EXP = 4102444800;
const UID = "00000000-0000-4000-8000-000000000001";
const SESSION = {
  access_token: jwt({ sub: UID, role: "authenticated", email: "s@e.com", exp: EXP }),
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "s@e.com", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
};

const measure = (page) => page.evaluate(() => {
  const h3 = [...document.querySelectorAll("h3")].find((h) => /Floorplan PDF/.test(h.textContent || ""));
  const modal = h3 && h3.parentElement && h3.parentElement.parentElement;
  if (!modal) return null;
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height }; };
  const img = modal.querySelector('img[alt="Floor Plan"]');
  const btns = [...modal.querySelectorAll("button")].filter((b) => /Download PDF|Download PNG|Copy|✕/.test(b.textContent || ""));
  const el = document.scrollingElement || document.documentElement;
  return { vw: window.innerWidth, vh: window.innerHeight, modal: r(modal), img: img ? { ...r(img), nat: img.naturalWidth } : null,
    btns: btns.map((b) => ({ t: (b.textContent || "").trim(), ...r(b) })), sideScroll: el.scrollWidth > el.clientWidth + 1 };
});

async function checkSize(page, surface, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(700);
  const pdf = page.locator("button.ssd-ft-pdf").first();
  await pdf.scrollIntoViewIfNeeded().catch(() => {});
  await pdf.click();
  await page.waitForFunction(() => { const i = document.querySelector('img[alt="Floor Plan"]'); return !!(i && i.complete && i.naturalWidth > 0); }, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  const m = await measure(page);
  const tag = `${surface} ${w}x${h}:`;
  await page.screenshot({ path: join(shots, `${TAG}-${surface}-${w}x${h}.png`) });
  if (!m) { ok(`${tag} the preview opened`, false); return; }
  ok(`M1 ${tag} the modal is inside the viewport`, m.modal.top >= -0.5 && m.modal.bottom <= m.vh + 0.5, `${m.modal.top.toFixed(0)}..${m.modal.bottom.toFixed(0)} of ${m.vh}`);
  const off = m.btns.filter((b) => b.top < -0.5 || b.bottom > m.vh + 0.5 || b.left < -0.5 || b.right > m.vw + 0.5);
  ok(`M2 ${tag} close and the three action buttons are on screen (${m.btns.length})`, m.btns.length === 4 && off.length === 0,
    off.map((b) => `${b.t} ${b.top.toFixed(0)}..${b.bottom.toFixed(0)}`).join(" | "));
  if (w >= 1000) {
    const actTop = Math.min(...m.btns.filter((b) => b.t !== "✕").map((b) => b.top));
    ok(`M3 ${tag} the whole page shows above the buttons, at least 300px tall`, !!m.img && m.img.bottom <= actTop + 0.5 && m.img.top >= m.modal.top && m.img.h >= 300,
      m.img ? `page ${m.img.top.toFixed(0)}..${m.img.bottom.toFixed(0)} (${m.img.w.toFixed(0)}x${m.img.h.toFixed(0)}), buttons at ${actTop.toFixed(0)}` : "no page");
  }
  ok(`M4 ${tag} nothing scrolls the page sideways`, !m.sideScroll);
  // Close it: its own button, or (where an older modal put that button off screen) the dark backdrop.
  await page.locator("h3").filter({ hasText: "Floorplan PDF" }).locator("xpath=..").locator("button").first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  if (await page.locator('img[alt="Floor Plan"]').count()) { await page.mouse.click(4, Math.round(h / 2)); await page.waitForTimeout(300); }
}

async function publicRun(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  await bypassGate(page, CLIENT);
  await page.goto(`${BASE}/?client=${CLIENT}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 40000 });
  await page.locator("[data-ss-style]").first().click();
  await page.waitForTimeout(1200);
  for (const [w, h] of DESK.concat([[390, 844]])) await checkSize(page, "public", w, h);
  ok("public: no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

async function portalRun(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.addInitScript(([ref, s]) => { try { window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* private mode */ } }, [REF, SESSION]);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  const shell = async (route) => {
    const req = route.request(), url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/get_config")) return json(route, CONFIG);
    if (url.includes("/rest/v1/rpc/get_fixtures")) return json(route, FIXTURES);
    if (url.includes("/rest/v1/rpc/")) return json(route, false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, SESSION.user);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) return json(route, { ok: true, entitlement: { granted: [], features: {}, status: "active" } });
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: "owner", settings: { business_name: "Harness Barns" }, config: { company_name: "Harness Barns", accent_color: "#8B4513" }, access: null, prefs: null });
      if (body.action === "catalog") return json(route, { ok: true, aiReady: false, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      return json(route, { ok: true });
    }
    if (url.includes("/functions/v1/")) return json(route, { ok: true });
    return json(route, {});
  };
  await page.route(`**/${REF}.supabase.co/**`, shell);
  await page.route(`**/${REF}.functions.supabase.co/**`, shell);
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.getByText("Sheds", { exact: true }).first().click();
  await page.waitForSelector(".ssd-frame.is-embedded", { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.locator("[data-ss-style]").first().click().catch(() => {});
  await page.waitForTimeout(1200);
  for (const [w, h] of DESK) await checkSize(page, "portal", w, h);
  // M5
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.locator("button.ssd-ft-pdf").first().click();
  const planOpen = () => page.evaluate(() => [...document.querySelectorAll("h3")].some((h) => /Floorplan PDF/.test(h.textContent || "")));
  await page.waitForFunction(() => [...document.querySelectorAll("h3")].some((h) => /Floorplan PDF/.test(h.textContent || "")), null, { timeout: 30000 });
  await page.evaluate(() => history.back());
  await page.waitForTimeout(1000);
  const stillOpen = await planOpen();
  const designerHidden = await page.evaluate(() => { const fr = document.querySelector(".ssd-frame.is-embedded"); return !fr || fr.offsetParent === null; });
  ok("M5 portal: Back with the preview open leaves the designer and closes the preview with it", designerHidden && !stillOpen,
    `designer ${designerHidden ? "hidden" : "still shown"}, preview ${stillOpen ? "still open" : "closed"}`);
  ok("portal: no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

async function main() {
  const { browser } = await launch({ width: 1366, height: 768 });
  await publicRun(browser);
  await portalRun(browser);
  await browser.close();
  const fl = failed();
  console.log(fl.length ? `${fl.length} FAILED` : "ALL CHECKS PASSED");
  process.exit(fl.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
