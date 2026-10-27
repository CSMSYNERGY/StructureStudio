// My Profile's "My connections" and "My meetings", and Customer Hub → Meetings, only where meetings
// are the person's to use (release review, 2026-10-27), driven for real on the COMPILED portal.
//
// Before: both My Profile cards asked portal-meetings for everyone, and portal-meetings refuses a
// builder without the built-in CRM (crm_locked) and a person without the meetings area. Each card
// shows a refusal as a red box, so every user at a builder without the CRM met two red boxes on the
// page the name-and-phone nudge sends them to. A rep there had a Customer Hub whose only tab,
// Meetings, was the same red box.
//
//   N  a builder WITHOUT the CRM: the owner's and a rep's My Profile show neither card, no CRM
//      refusal and no access refusal, and portal-meetings is never asked; Your details and "How the
//      Contacts tab opens" still render
//   T  ...and the owner's Customer Hub → Meetings is the CRM teaser, not a red box, and asks
//      nothing; a rep (no Settings area) sent to /settings/meetings meets no refusal either
//   C  a builder WITH the CRM: the owner and a rep holding meetings 'own' see both cards, and
//      overview is asked
//   W  ...a crew member there with no meetings area sees neither card and no access refusal
//   X  no uncaught page errors
//
// portal-meetings is stubbed with the server's real refusal sentences, so a card that still asks is
// caught by its text as well as by the call count. Supabase is stubbed at the network layer; nothing
// leaves the machine. Names are made up (public repo).
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root; SS_BASE overrides the address)
//   node tests/harness/myProfileMeetingsGate.mjs   (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead; before this change
// N1 to N3 fail. Shots land in %TEMP%/ss-harness/my-profile-meetings-gate (SS_SHOTS overrides).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, shotsDir, serveAppRoutes } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

const CLIENT = "acme-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000b8", aud: "authenticated", role: "authenticated", email: "pat@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const AREAS = ["designer", "designs", "contacts", "inventory", "orders", "change_orders", "change_order_approve", "build_schedule",
  "delivery_schedule", "repairs", "commissions", "reports", "projects", "phone", "meetings", "settings_structures", "settings_options",
  "settings_branding", "settings_crm", "settings_quickbooks", "settings_email", "settings_team", "settings_billing"];
const OWNER = Object.fromEntries(AREAS.map((k) => [k, "edit"]));
// A sales rep: their own customers and their own meetings, no Settings area at all.
const REP = Object.fromEntries(AREAS.map((k) => [k, ["designer", "designs", "contacts", "orders"].includes(k) ? "edit" : k === "meetings" ? "own" : "none"]));
// A crew member: the build schedule only, no meetings area.
const CREW = Object.fromEntries(AREAS.map((k) => [k, k === "build_schedule" ? "view" : "none"]));
// portal-meetings' own sentences (index.ts: the crm_locked refusal, and resolveTenant's area gate).
const CRM_LOCKED = "The built-in CRM isn't part of your subscription — add it under Settings → Billing.";
const NO_AREA = "Your access does not let you view Meetings. Ask an owner or admin.";

const { ok, failed } = reporter();
const shots = shotsDir("my-profile-meetings-gate");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const LOCAL = /^https?:\/\/(127\.0\.0\.1|(?:[a-z0-9-]+\.)*localhost)(:\d+)?\//;

async function scenario(browser, { name, path = "/settings/myprofile", role = "owner", access = OWNER, crm = false }) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  const meetings = [];
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
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (url.includes("/portal-meetings")) {
      meetings.push(body.action || "overview");
      if (!crm) return json(route, { error: CRM_LOCKED, code: "crm_locked" }, 403);
      if (!access.meetings || access.meetings === "none") return json(route, { error: NO_AREA }, 403);
      return json(route, { ok: true, settings: null, types: [], myHost: null, team: [], connections: [], videoReady: { zoom: false }, overrides: [], canManageBusiness: access.meetings === "edit", viewing: false });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role, operatorMode: false, access, prefs: null, phoneStatus: "off", configured: false,
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
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  if (path.endsWith("myprofile")) await page.waitForFunction(() => document.body.innerText.includes("How the Contacts tab opens"), null, { timeout: 20000 }).catch(() => {});
  // Long enough for portal-billing's answer to land and for any card to ask and show its refusal.
  await page.waitForTimeout(2500);
  return { ctx, page, meetings, text: async () => page.locator("main, #root").first().innerText().catch(() => "") };
}

/** The whole page as a person sees it: a window tall enough for all of it. */
const pageShot = async (page, file) => {
  const vp = page.viewportSize();
  const h = await page.evaluate(() => Math.ceil(document.scrollingElement.scrollHeight));
  await page.setViewportSize({ width: vp.width, height: Math.min(Math.max(h, 600), 4000) });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, file) });
  await page.setViewportSize(vp);
};
const hasConn = (t) => /(^|\n)My connections(\n|$)/.test(t);
const hasMine = (t) => /(^|\n)My meetings(\n|$)/.test(t);

const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();
try {
  for (const [who, role, access] of [["owner", "owner", OWNER], ["rep", "sales", REP]]) {
    const s = await scenario(browser, { name: `no-crm ${who}`, role, access, crm: false });
    const t = await s.text();
    const rendered = ok(`N0 ${who}: My Profile rendered (Your details and How the Contacts tab opens)`, t.includes("How the Contacts tab opens"), t.slice(0, 80));
    if (!rendered) throw new Error("My Profile never rendered; refusing to report the rest as passes");
    ok(`N1 ${who} at a builder without the CRM: no My connections, no My meetings`, !hasConn(t) && !hasMine(t));
    ok(`N2 ${who}: no CRM refusal and no access refusal on the page`, !t.includes("isn't part of your subscription") && !t.includes("does not let you view Meetings"));
    ok(`N3 ${who}: portal-meetings was never asked`, s.meetings.length === 0, s.meetings.join(","));
    await pageShot(s.page, `no-crm-${who}-myprofile.png`);
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "no-crm owner hub", path: "/settings/meetings", role: "owner", access: OWNER, crm: false });
    const t = await s.text();
    ok("T1 the owner's Customer Hub → Meetings is the CRM teaser", t.includes("Meeting types and booking pages are part of the built-in CRM. Add it under Settings → Billing."), t.slice(0, 160));
    ok("T2 ...not a red refusal, and portal-meetings was never asked", !t.includes("isn't part of your subscription") && s.meetings.length === 0, s.meetings.join(","));
    await pageShot(s.page, "no-crm-owner-hub-meetings.png");
    await s.ctx.close();
  }
  {
    // A rep holds no Settings area, so /settings/meetings sends them on; whatever they land on
    // must not be a refusal either.
    const s = await scenario(browser, { name: "no-crm rep hub", path: "/settings/meetings", role: "sales", access: REP, crm: false });
    const t = await s.text();
    ok("T3 a rep's /settings/meetings shows no refusal and asks portal-meetings nothing", !t.includes("isn't part of your subscription") && !t.includes("does not let you view Meetings") && s.meetings.length === 0, s.meetings.join(","));
    await s.ctx.close();
  }
  for (const [who, role, access] of [["owner", "owner", OWNER], ["rep", "sales", REP]]) {
    const s = await scenario(browser, { name: `crm ${who}`, role, access, crm: true });
    const t = await s.text();
    ok(`C1 ${who} at a builder with the CRM: My connections and My meetings show`, hasConn(t) && hasMine(t));
    ok(`C2 ${who}: overview was asked, and no refusal shows`, s.meetings.includes("overview") && !t.includes("isn't part of your subscription") && !t.includes("does not let you view Meetings"), s.meetings.join(","));
    await pageShot(s.page, `crm-${who}-myprofile.png`);
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "crm crew", role: "crew_member", access: CREW, crm: true });
    const t = await s.text();
    ok("W1 a crew member with no meetings area: My Profile renders, with neither card", t.includes("Your details") && !hasConn(t) && !hasMine(t), t.slice(0, 80));
    ok("W2 ...no access refusal, and portal-meetings was never asked", !t.includes("does not let you view Meetings") && s.meetings.length === 0, s.meetings.join(","));
    await pageShot(s.page, "crm-crew-myprofile.png");
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
