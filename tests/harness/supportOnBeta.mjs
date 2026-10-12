// Support > New Features / Bug Fixes: entries still on beta say so (Carolyn 2026-10-12: "they're not
// saying on beta for testing"), driven for real on the COMPILED portal.
//
// Each release_notes row with status 'beta' carries the orange "On beta for testing" badge, and a tab
// with any such row gets one line under its heading saying what that means (live on beta now, and
// everyone gets it with the next release). A 'shipped' row carries no badge, and a tab with
// no beta row has no line.
//
//   A  New Features with two beta rows and one shipped: two badges on the right rows, the line with
//      "2 entries here are live on beta now", the shipped row bare;
//   B  Bug Fixes with one beta row: the line says "1 entry here is";
//   C  Roadmap (a requested entry, no beta): no line;
//   D  every tab holds at 390 px with no sideways scroll (the line wraps);
//   every scenario: no uncaught page error. Screenshots go to SS_SHOTS (when set).
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine), the shape
// bringYourNumber.mjs uses. The titles below are MADE UP; the repo is public.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/supportOnBeta.mjs           (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how to
// prove the checks can fail: against e4db8f41's artifact the three line checks (A, B, D) fail.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT) : null;
const SHOTS = process.env.SS_SHOTS || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const CLIENT = "demo-tenant";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const ACCESS = Object.fromEntries(["designer", "designs", "contacts", "orders", "settings_structures", "settings_team"].map((k) => [k, "edit"]));
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200, headers = {}) => route.fulfill({ status, contentType: "application/json", headers: { ...H, ...headers }, body: JSON.stringify(body) });

const NOTES = [
  { id: "n1", released_at: "2026-10-12T10:00:00Z", version: null, kind: "feature", title: "Pipeline cards show the estimate number again", detail: "Made-up detail for the harness.", status: "beta", sort_order: 0, section: "Contacts" },
  { id: "n2", released_at: "2026-10-11T10:00:00Z", version: null, kind: "feature", title: "Doors come in four looks you can pick from", detail: null, status: "beta", sort_order: 0, section: "Designer" },
  { id: "n3", released_at: "2026-10-05T10:00:00Z", version: null, kind: "feature", title: "Interior partition walls with their own doors", detail: null, status: "shipped", sort_order: 0, section: "Designer" },
  { id: "n4", released_at: "2026-10-12T09:00:00Z", version: null, kind: "fix", title: "The payment box scrolls on a smaller screen", detail: null, status: "beta", sort_order: 0, section: "Orders" },
  { id: "n5", released_at: "2026-10-04T09:00:00Z", version: null, kind: "fix", title: "Build Schedule month view no longer skips a month", detail: null, status: "shipped", sort_order: 0, section: "Build Schedule" },
  { id: "n6", released_at: "2026-08-31T09:00:00Z", version: null, kind: "requested", title: "Saved views on every board", detail: null, status: "roadmap", sort_order: 0, section: "" },
];

const { ok, failed } = reporter();
const { browser, ctx: unused } = await launch({ width: 1280, height: 900 });
await unused.close();

async function supportPage(label, sub, width = 1280) {
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* blocked */ } }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, false);
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/release_notes")) return json(route, NOTES);
    if (url.includes("/rest/v1/feedback_submissions")) return json(route, [], 200, { "content-range": "*/0" });
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    if (url.includes("/portal-setup")) return json(route, { items: [], counts: { total: 0, done: 0, open: 0 }, canEdit: true });
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    if (body.action === "status") {
      return json(route, { ok: true, clientId: CLIENT, role: "owner", access: ACCESS, prefs: null, configured: false, branding: { companyName: "Demo Tenant" }, emailReady: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: ARTIFACT }));
  await page.goto(`${BASE}/portal/support/${sub}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  await page.getByText("Support", { exact: true }).first().waitFor({ timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(600);
  return { label, page, ctx, pageErrors };
}

// Every entry row, as { title, badge } read off the page.
async function rows(page) {
  return page.evaluate(() => {
    const out = [];
    for (const span of document.querySelectorAll("span")) {
      if (span.style.fontWeight !== "700" || span.style.fontSize !== "14px") continue;
      const line = span.parentElement;
      const badge = [...line.querySelectorAll("span")].find((s) => /on beta for testing/i.test(s.textContent || ""));
      out.push({ title: span.textContent, badge: !!badge });
    }
    return out;
  });
}
const lineText = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll("span")].find((s) => /here (is|are) live on beta now/.test(s.textContent || ""));
  return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
});
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name), fullPage: false }); };

try {
  // ── A: New Features ──
  const A = await supportPage("A", "features");
  const a = await rows(A.page);
  ok("A: the three feature rows are drawn", a.length === 3, a.map((r) => r.title).join(" | "));
  ok("A: each beta row carries On beta for testing", a.filter((r) => r.badge).map((r) => r.title).join("|")
    === "Pipeline cards show the estimate number again|Doors come in four looks you can pick from");
  ok("A: the shipped row carries no badge", a.some((r) => r.title.startsWith("Interior partition") && !r.badge));
  const la = await lineText(A.page);
  ok("A: the line says what On beta means, with the count", la === "2 entries here are live on beta now and come to everyone with the next release.", la || "no line");
  ok("A: no page error", A.pageErrors.length === 0, A.pageErrors.join(" | "));
  await shot(A.page, "U6-support-features-1280.png");
  await A.ctx.close();

  // ── B: Bug Fixes ──
  const B = await supportPage("B", "fixes");
  const lb = await lineText(B.page);
  ok("B: one beta fix reads in the singular", lb === "1 entry here is live on beta now and comes to everyone with the next release.", lb || "no line");
  const b = await rows(B.page);
  ok("B: the beta fix is badged, the shipped one is not", b.length === 2 && b[0].badge && !b[1].badge, JSON.stringify(b));
  ok("B: no page error", B.pageErrors.length === 0, B.pageErrors.join(" | "));
  await shot(B.page, "U6-support-fixes-1280.png");
  await B.ctx.close();

  // ── C: Roadmap ──
  const C = await supportPage("C", "roadmap");
  ok("C: a tab with no beta entry has no line", (await lineText(C.page)) === null);
  ok("C: no page error", C.pageErrors.length === 0, C.pageErrors.join(" | "));
  await C.ctx.close();

  // ── D: a phone ──
  const D = await supportPage("D", "features", 390);
  const fit = await D.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ok("D: 390 px wide, no sideways scroll", fit.sw <= fit.cw, `scrollWidth ${fit.sw}, clientWidth ${fit.cw}`);
  ok("D: the line is still there", (await lineText(D.page)) !== null);
  ok("D: no page error", D.pageErrors.length === 0, D.pageErrors.join(" | "));
  await shot(D.page, "U6-support-features-390.png");
  await D.ctx.close();
} finally {
  await browser.close();
}

const f = failed();
console.log(f.length ? `\n${f.length} check(s) FAILED` : "\nevery check held");
process.exit(f.length ? 1 : 0);
