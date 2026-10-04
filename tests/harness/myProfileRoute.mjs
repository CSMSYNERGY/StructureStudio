// My Profile reaches EVERY role (2026-10-04), driven for real on the COMPILED portal.
//
// The account menu offers My Profile to everyone and the needsDetails nudge's "Add details"
// sends people there; its two actions (save_prefs / save_profile) are "self" on the server. But
// the route clamp asked for a settings_* area, which a sales rep, dealer, scheduler, crew member
// or driver holds none of — so /portal/settings/myprofile bounced them to their fallback page and
// rewrote the address bar, and both controls did nothing at all.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/myProfileRoute.mjs           (exit 0 = every check held)
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine), the shape
// supportConsoles.mjs uses. SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file
// instead — against the artifact before this fix, A, B and C fail (the address bar ends on
// /portal/designs and "How the Pipeline tab opens" never renders).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

const CLIENT = "harness-builder";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000007", aud: "authenticated", role: "authenticated", email: "rep@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
// The sales_rep preset as effectiveAccess resolves it: every settings_* area is "none".
const SALES_REP = {
  designer: "edit", designs: "edit", contacts: "edit", phone: "own", inventory: "view", orders: "edit", commissions: "own",
  change_orders: "none", change_order_approve: "none", build_schedule: "none", delivery_schedule: "none", repairs: "none",
  reports: "none", projects: "none", settings_structures: "none", settings_options: "none", settings_branding: "none",
  settings_crm: "none", settings_quickbooks: "none", settings_email: "none", settings_team: "none", settings_billing: "none",
};
const OWNER = Object.fromEntries(Object.keys(SALES_REP).map((k) => [k, k === "settings_billing" ? "edit" : "edit"]));

const { ok, failed } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

async function run(S, path, act) {
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      if (rpc[1] === "log_error") return json(route, null);
      return json(route, false);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: S.role }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: S.role, access: S.access, prefs: null, configured: false, branding: {} });
      if (body.action === "get_profile") return json(route, { ok: true, fullName: S.fullName === undefined ? "Pat Rep" : S.fullName, phone: null, needsDetails: S.fullName === null });
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));

  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  if (act) { await act(page); await page.waitForTimeout(2000); }
  const out = {
    pageErrors,
    path: await page.evaluate(() => location.pathname),
    body: await page.evaluate(() => (document.querySelector(".ss-body") || document.body).innerText),
    settingsNav: await page.evaluate(() => !!document.querySelector('.ss-nav a[href="/portal/settings"]')),
  };
  await ctx.close();
  return out;
}

const PROFILE_MARK = "How the Pipeline tab opens";
try {
  // A: a sales rep's cold deep link.
  const A = await run({ role: "user", access: SALES_REP }, "/portal/settings/myprofile");
  ok("A: a sales rep's /portal/settings/myprofile stays put", A.path === "/portal/settings/myprofile", A.path);
  ok("A: …and renders My Profile", A.body.includes(PROFILE_MARK));
  ok("A: no Settings item appears in the workspace rail", !A.settingsNav);
  ok("A: no uncaught page errors", A.pageErrors.length === 0, A.pageErrors.join(" | "));

  // B: the account menu's My Profile, from the rep's landing page.
  const B = await run({ role: "user", access: SALES_REP }, "/portal/designs", async (page) => {
    await page.evaluate(() => { const a = document.querySelector('.ss-user-menu a[href="/portal/settings/myprofile"]'); if (a) a.click(); });
  });
  ok("B: the account menu's My Profile opens it", B.path === "/portal/settings/myprofile" && B.body.includes(PROFILE_MARK), B.path);

  // C: the needsDetails nudge's "Add details" (no name on file).
  const C = await run({ role: "user", access: SALES_REP, fullName: null }, "/portal/designs", async (page) => {
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Add details"); if (b) b.click(); });
  });
  ok("C: \"Add details\" lands on My Profile", C.path === "/portal/settings/myprofile" && C.body.includes(PROFILE_MARK), C.path);

  // D: the rest of Settings is still refused to the rep.
  const D = await run({ role: "user", access: SALES_REP }, "/portal/settings/team");
  ok("D: /portal/settings/team still bounces a sales rep", D.path !== "/portal/settings/team" && !D.path.startsWith("/portal/settings"), D.path);

  // E: an owner is unchanged.
  const E = await run({ role: "owner", access: OWNER }, "/portal/settings/myprofile");
  ok("E: an owner's My Profile is unchanged", E.path === "/portal/settings/myprofile" && E.body.includes(PROFILE_MARK), E.path);
} finally {
  await browser.close();
}
const f = failed();
console.log(`\n${f.length ? "FAILED" : "OK"} — ${f.length} failed`);
process.exit(f.length ? 1 : 0);
