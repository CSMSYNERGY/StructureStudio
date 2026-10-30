// My Synergy Phone's download pop-up on Settings pages (Ahsan 2026-10-30), driven for real on the
// COMPILED portal.
//
// A small card in the corner of every Settings page where the Phone tab is offered: the Apple and
// Android logos and one line. Clicking it opens the full-size card, a QR code for each store and a
// button to each store. The × hides the small card in this browser.
//
//   S  the small card: on a Settings page with phone offered, both logos and its line; inside the
//      window; above the Feedback pill, not on it
//   F  the full-size card: a modal dialog with its title; one QR code per store, each a real QR
//      symbol (17 + 4v modules a side, the three finder patterns, the timing rows); each store
//      button opens its store's page in a new tab; focus goes to Close
//   C  closing: Esc, the backdrop, and Close each shut it and give focus back to the small card;
//      a click inside the card does not; the page behind does not scroll while it is open
//   H  the × hides the small card, and it stays hidden after a reload
//   N  not shown: a production host where the Phone tab is not offered (phone off), a person with
//      no phone area (the app would refuse them), and a page that is not Settings
//   M  a phone (390 wide, an iPhone's browser): the small card fits and says tap, it steps aside
//      while the account menu is open, the full-size card fits with no sideways scroll, the two
//      stores stack, and on a short screen the card starts at its top with Close in view
//   I  the Phone tab's own install card: the iPhone and Android buttons go to their store pages now,
//      and the Chrome one still reads "coming soon" (its Web Store id is not in yet)
//   X  no uncaught page errors
//
// Supabase is stubbed at the network layer; nothing leaves the machine. Names are made up (public
// repo). 127.0.0.1 is a beta host to the portal (ssIsBetaHost), where phone is always offered, so N
// opens the app on acme.localhost, which the portal reads as a production host.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root; SS_BASE overrides the address)
//   node tests/harness/phoneAppPromo.mjs           (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead; before this change
// S1 fails. Shots land in %TEMP%/ss-harness/phone-app-promo (SS_SHOTS overrides).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, shotsDir, serveAppRoutes } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

const STORE = {
  ios: "https://apps.apple.com/app/id6819597681",
  android: "https://play.google.com/store/apps/details?id=com.mysynergyphone.app",
};
const CLIENT = "acme-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000c3", aud: "authenticated", role: "authenticated", email: "pat@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const AREAS = ["designer", "designs", "contacts", "inventory", "orders", "change_orders", "change_order_approve", "build_schedule",
  "delivery_schedule", "repairs", "commissions", "reports", "projects", "phone", "meetings", "settings_structures", "settings_options",
  "settings_branding", "settings_crm", "settings_quickbooks", "settings_email", "settings_team", "settings_billing"];
const OWNER = Object.fromEntries(AREAS.map((k) => [k, "edit"]));
// A driver: the delivery schedule only and no phone area, as access.ts's driver preset (phone: none).
const DRIVER = Object.fromEntries(AREAS.map((k) => [k, k === "delivery_schedule" ? "view" : "none"]));
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const { ok, failed } = reporter();
const shots = shotsDir("phone-app-promo");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const LOCAL = /^https?:\/\/(127\.0\.0\.1|(?:[a-z0-9-]+\.)*localhost)(:\d+)?\//;

async function scenario(browser, { name, path = "/settings/myprofile", phone = "on", host = null, mobile = false, height = 844, role = "owner", access = OWNER, ctx: reuse = null }) {
  const ctx = reuse || await browser.newContext({
    viewport: mobile ? { width: 390, height } : { width: 1400, height: 900 },
    serviceWorkers: "block",
    ...(mobile ? { userAgent: IPHONE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  if (!reuse) {
    await ctx.addInitScript(([ref, s]) => {
      try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    }, [REF, SESSION]);
  }
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  await page.route((u) => !LOCAL.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role, user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: false }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (url.includes("/support-agent")) return json(route, { ok: true, enabled: false });
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role, operatorMode: false, access, prefs: null, phoneStatus: phone, configured: false,
          invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "get_profile":
        return json(route, { fullName: "Pat Example", phone: "5550100100", role, email: USER.email, needsDetails: false, emailSignature: "" });
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));
  const base = host ? BASE.replace(/\/\/[^/:]+/, `//${host}`) : BASE;
  await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  return { ctx, page };
}

const SMALL = '[data-ss-app-promo="small"]';
const FULL = '[data-ss-app-promo="full"]';
const opener = (page) => page.locator(`${SMALL} button[aria-haspopup="dialog"]`);
const box = (page, sel) => page.locator(sel).first().boundingBox().catch(() => null);
// The full-size card grows in (.ss-app-promo-pop); measure and shoot it once it has.
const settled = (page) => page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== "running"), null, { timeout: 5000 }).catch(() => {});
const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// A drawn QR code back to its module grid, then the parts every QR symbol has: 17 + 4v modules a
// side, a finder pattern in three corners with a light separator, and the two timing rows.
async function qrCheck(page, which) {
  const q = await page.locator(`${FULL} [data-ss-app-qr="${which}"]`).evaluate((svg) => ({
    viewBox: svg.getAttribute("viewBox"), d: svg.querySelector("path").getAttribute("d"),
  })).catch(() => null);
  if (!q) return { ok: false, why: "no code drawn" };
  const n = Number(q.viewBox.split(/\s+/)[2]) - 8;
  const v = (n - 17) / 4;
  if (!(Number.isInteger(v) && v >= 1 && v <= 40)) return { ok: false, why: `side ${n}` };
  const grid = Array.from({ length: n }, () => new Array(n).fill(false));
  const re = /M(\d+) (\d+)h(\d+)v1h-\3z/g;
  let m, runs = 0, used = 0;
  while ((m = re.exec(q.d))) {
    runs++; used += m[0].length;
    for (let x = +m[1]; x < +m[1] + +m[3]; x++) grid[+m[2]][x] = true;
  }
  if (used !== q.d.length) return { ok: false, why: "path has parts that are not module runs" };
  const finder = (ox, oy) => {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      if (grid[oy + y][ox + x] !== (ring !== 2)) return false;
    }
    return true;
  };
  const sepLight = (ox, oy) => {
    for (let i = -1; i <= 7; i++) for (const [x, y] of [[ox + i, oy - 1], [ox + i, oy + 7], [ox - 1, oy + i], [ox + 7, oy + i]]) {
      if (x >= 0 && y >= 0 && x < n && y < n && grid[y][x]) return false;
    }
    return true;
  };
  const corners = [[0, 0], [n - 7, 0], [0, n - 7]].every(([x, y]) => finder(x, y) && sepLight(x, y));
  let timing = true;
  for (let i = 8; i < n - 8; i++) if (grid[6][i] !== (i % 2 === 0) || grid[i][6] !== (i % 2 === 0)) timing = false;
  return { ok: corners && timing, why: `version ${v}, ${n}x${n}, ${runs} runs, finders ${corners}, timing ${timing}` };
}

const { browser, ctx: unused } = await launch({ width: 1400, height: 900 });
await unused.close();
try {
  {
    const s = await scenario(browser, { name: "S" });
    const page = s.page;
    const shown = ok("S1 the small card shows on a Settings page where phone is offered", await page.locator(SMALL).count() === 1);
    if (!shown) throw new Error("no small card; refusing to report the rest as passes");
    const small = await page.locator(SMALL).innerText();
    ok("S2 ...with its line, and the Apple and Android logos", /Get the phone app/.test(small) && /iPhone and Android/.test(small)
      && await page.locator(`${SMALL} svg path`).count() === 2, small.replace(/\n/g, " / "));
    const name = await opener(page).evaluate((b) => b.getAttribute("aria-label") || b.textContent);
    ok("S2b the card is named by its own words (what a voice user sees is what they say)", /^Get the phone app/.test(name || ""), name);
    const sb = await box(page, SMALL), vp = page.viewportSize();
    ok("S3 ...inside the window, in the bottom-right corner", !!sb && sb.x >= 0 && sb.y >= 0 && sb.x + sb.width <= vp.width && sb.y + sb.height <= vp.height
      && sb.x + sb.width > vp.width - 40 && sb.y + sb.height > vp.height - 120, JSON.stringify(sb));
    const pill = await box(page, 'button[aria-label="Send feedback"]');
    ok("S4 ...above the Feedback pill, not on it", !!pill && !overlaps(sb, pill) && sb.y + sb.height <= pill.y, `card ${JSON.stringify(sb)} pill ${JSON.stringify(pill)}`);
    await page.screenshot({ path: join(shots, "S-small-card.png") });

    await opener(page).click();
    await page.waitForSelector(FULL, { timeout: 5000 }).catch(() => {});
    await settled(page);
    const dlg = page.locator(`[role="dialog"]${FULL}`);
    ok("F1 a click opens the full-size card: a modal dialog titled for the app", await dlg.count() === 1
      && await dlg.getAttribute("aria-modal") === "true" && /Get My Synergy Phone on your phone/.test(await dlg.innerText()));
    ok("F2 ...the small card says it is expanded", await opener(page).getAttribute("aria-expanded") === "true");
    for (const which of ["ios", "android"]) {
      const r = await qrCheck(page, which);
      ok(`F3 ${which}: a real QR symbol is drawn`, r.ok, r.why);
      const label = await page.locator(`${FULL} [data-ss-app-qr="${which}"]`).getAttribute("aria-label").catch(() => "");
      ok(`F4 ${which}: the code is labelled for a screen reader`, /QR code: My Synergy Phone on (the App Store|Google Play)/.test(label || ""), label);
      const a = page.locator(`${FULL} [data-ss-app-store="${which}"] a`);
      ok(`F5 ${which}: its button opens the store page in a new tab`, await a.count() === 1 && await a.getAttribute("href") === STORE[which]
        && await a.getAttribute("target") === "_blank" && /noopener/.test(await a.getAttribute("rel") || ""), await a.getAttribute("href").catch(() => ""));
    }
    ok("F6 focus is on Close", await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("aria-label")) === "Close");
    ok("C1 the page behind does not scroll while it is open", await page.evaluate(() => getComputedStyle(document.body).overflow) === "hidden");
    await page.screenshot({ path: join(shots, "F-full-card.png") });
    await page.locator(FULL).screenshot({ path: join(shots, "F-full-card-only.png") });

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    ok("C2 Esc shuts it and gives focus back to the small card", await page.locator(FULL).count() === 0
      && await page.evaluate(() => !!document.activeElement && document.activeElement.getAttribute("aria-haspopup") === "dialog"));
    ok("C3 ...and the page scrolls again", await page.evaluate(() => getComputedStyle(document.body).overflow) !== "hidden");
    await opener(page).click();
    await page.locator(`${FULL} [data-ss-app-store="ios"]`).click({ position: { x: 5, y: 5 } });
    ok("C4 a click inside the card leaves it open", await page.locator(FULL).count() === 1);
    await page.mouse.click(8, 8);
    await page.waitForTimeout(200);
    ok("C5 a click on the backdrop shuts it", await page.locator(FULL).count() === 0);
    await opener(page).click();
    await page.locator(`${FULL} button[aria-label="Close"]`).click();
    await page.waitForTimeout(200);
    ok("C6 Close shuts it and gives focus back", await page.locator(FULL).count() === 0
      && await page.evaluate(() => !!document.activeElement && document.activeElement.getAttribute("aria-haspopup") === "dialog"));

    await page.locator(`${SMALL} button[aria-label="Hide the phone app card"]`).click();
    await page.waitForTimeout(200);
    ok("H1 the × hides the small card", await page.locator(SMALL).count() === 0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
    await page.waitForTimeout(2000);
    ok("H2 ...and it stays hidden after a reload", await page.locator(SMALL).count() === 0
      && await page.evaluate(() => localStorage.getItem("ss.phoneAppPromo.hidden")) === "1");
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "N off", phone: "off", host: "acme.localhost" });
    const rendered = await s.page.evaluate(() => document.body.innerText.includes("Your details"));
    ok("N1 on a production host with phone off, Settings shows no card", rendered && await s.page.locator(SMALL).count() === 0, rendered ? "" : "Settings never rendered");
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "N driver", role: "driver", access: DRIVER });
    const rendered = await s.page.evaluate(() => document.body.innerText.includes("Your details"));
    ok("N3 a person with no phone area sees no card on My Profile", rendered && await s.page.locator(SMALL).count() === 0, rendered ? "" : "My Profile never rendered");
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "N other page", path: "/orders" });
    ok("N2 a page that is not Settings shows no card", await s.page.locator(SMALL).count() === 0);
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "M", mobile: true });
    const page = s.page;
    const vp = page.viewportSize();
    const sb = await box(page, SMALL);
    ok("M1 on a phone the small card fits the screen", !!sb && sb.x >= 0 && sb.x + sb.width <= vp.width, JSON.stringify(sb));
    ok("M1b ...and says tap, not scan, on the phone in hand", /tap to install/.test(await page.locator(SMALL).innerText()));
    await page.screenshot({ path: join(shots, "M-small-card.png") });
    await page.locator(".ss-user").first().focus();
    await page.waitForTimeout(200);
    const menu = await page.evaluate(() => {
      const card = document.querySelector('[data-ss-app-promo="small"]');
      const rows = [...document.querySelectorAll(".ss-user-menu [role=menuitem], .ss-user-menu button, .ss-user-menu a")].filter((r) => r.getBoundingClientRect().height > 0);
      const hit = rows.map((r) => { const b = r.getBoundingClientRect(); const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!el && r.contains(el); });
      return { hidden: !!card && getComputedStyle(card).visibility === "hidden", rows: rows.length, hit };
    });
    ok("M1c while the account menu is open the card steps aside, and every menu row takes its own tap", menu.hidden && menu.rows > 0 && menu.hit.every(Boolean), JSON.stringify(menu));
    await page.screenshot({ path: join(shots, "M-account-menu.png") });
    await page.locator("main, .ss-body").first().click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.waitForTimeout(200);
    await opener(page).click();
    await page.waitForSelector(FULL, { timeout: 5000 }).catch(() => {});
    await settled(page);
    const fb = await box(page, FULL);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    ok("M2 the full-size card fits the width, with no sideways scroll", !!fb && fb.x >= 0 && fb.x + fb.width <= vp.width && !sideways, JSON.stringify(fb));
    const a = await box(page, `${FULL} [data-ss-app-store="ios"]`), b = await box(page, `${FULL} [data-ss-app-store="android"]`);
    ok("M3 the two stores stack, the iPhone's first on an iPhone", !!a && !!b && b.y >= a.y + a.height, `${JSON.stringify(a)} ${JSON.stringify(b)}`);
    ok("M4 a phone's browser is told to tap its store", /Tap your store below/.test(await page.locator(FULL).innerText()));
    await page.screenshot({ path: join(shots, "M-full-card.png") });
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "M short", mobile: true, height: 560 });
    const page = s.page;
    await opener(page).click();
    await page.waitForSelector(FULL, { timeout: 5000 }).catch(() => {});
    await settled(page);
    const fb = await box(page, FULL), close = await box(page, `${FULL} button[aria-label="Close"]`);
    ok("M5 on a short screen the card starts at its top, with Close in view", !!fb && fb.y >= 0 && !!close && close.y >= 0 && close.y + close.height <= 560, `${JSON.stringify(fb)} ${JSON.stringify(close)}`);
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(300);
    const last = await box(page, `${FULL} [data-ss-app-store="android"] a`);
    ok("M6 ...and scrolls down to the last store button", !!last && last.y >= 0 && last.y + last.height <= 560, JSON.stringify(last));
    await page.screenshot({ path: join(shots, "M-short-screen.png") });
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "I", path: "/settings/phone" });
    await s.page.waitForSelector('[data-ss-phone-install="full"]', { timeout: 15000 }).catch(() => {});
    const card = await s.page.locator('[data-ss-phone-install="full"]').first().innerText().catch(() => "");
    const hrefs = await s.page.locator('[data-ss-phone-install="full"] a').evaluateAll((as) => as.map((a) => a.getAttribute("href"))).catch(() => []);
    ok("I1 Settings › Phone's install card links the iPhone and Android stores", hrefs.length === 2 && hrefs.includes(STORE.ios) && hrefs.includes(STORE.android), hrefs.join(" ") || card.slice(0, 80));
    ok("I2 ...and its Chrome link still reads 'coming soon'", /Chrome extension: link coming soon/.test(card), card.replace(/\n/g, " / ").slice(0, 160));
    await s.page.screenshot({ path: join(shots, "I-phone-tab.png") });
    await s.ctx.close();
  }
  ok("X no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  ok("harness ran to the end", false, String(e && e.message || e));
} finally {
  await browser.close();
}
console.log(`\nshots: ${shots}`);
process.exitCode = failed().length ? 1 : 0;
