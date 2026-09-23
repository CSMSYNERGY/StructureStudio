// A support operator's OWN portal offers no Admin or Projects console (2026-09-23), driven for
// real on the COMPILED portal.
//
// app_errors caught it: pairs of admin-catalog get_master + list_clients 403s ("Operator access
// required.") and portal-projects list_boards 403s ("Support accounts can't open Projects"), at a
// bare /portal/admin and /portal/projects with no ?view=, on 2026-09-16 (beta AND production)
// and 09-18. The server refusals were right. The shell drew both consoles anyway, because every
// gate read `!supportView`, which is false on the support account's own portal by design.
//
// The fix has two halves and this drives the browser half of both:
//   ADMIN    the shell draws the nav item and mounts AdminShell only on a real
//            is_support_operator = false, and the route clamps refuse /portal/admin once it is
//            true. The case that matters is a RELOAD on /portal/admin, where is_operator can
//            answer before is_support_operator does. So the stub holds is_support_operator back,
//            and the checks are "never", not "not at the end".
//   PROJECTS migration 250 makes can_open_projects() answer false for a support operator, and the
//            stub answers it the way the migrated database does. The shell ALSO waits for
//            is_support_operator = false before drawing or mounting Projects (projectsOpen), which
//            E checks with the pre-250 answer. G checks the other direction: when the rpc fails
//            twice, a CSM team member with the Projects area still gets the board.
//
// Cold deep links are real here. /portal/<page> is answered with portal.html's own bytes, which
// is what the production _redirects rule does, so ssParsePath sees the path on first render. The
// service worker is blocked: it answers navigations itself, and page.route never sees those.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine), the same
// shape taxCodesTab.mjs uses.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/supportConsoles.mjs          (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how to
// prove these checks can fail. Against the artifact before this fix (16b02f6) 12 checks fail, and
// A reproduces the incident exactly: the Admin item is drawn, list_clients + get_master go out
// ~340 ms in (before is_support_operator has answered), and the address bar stays on
// /portal/admin. B's Admin check, C's "only after the answer", D and E fail with it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

const CLIENT = "harness-internal";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000005", aud: "authenticated", role: "authenticated", email: "support@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
// The live support accounts are plain members ('user') of the internal tenant.
const ACCESS = { designs: "edit", contacts: "edit", orders: "view" };

const { ok, failed, results } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// One fresh context per scenario: nothing the portal caches in storage can leak between them.
async function run(label, S, path) {
  const calls = [];   // { fn, action, at }
  const pageErrors = [];
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    // "Never drawn" needs a witness from the first render on, not a look at the end.
    window.__navSeen = { admin: false, projects: false, accounts: false };
    const scan = () => {
      for (const k of ["admin", "projects", "accounts"]) {
        // Not .ss-back: the Settings rail is always in the markup (hidden by CSS on workspace
        // pages) and its "Back to Workspace" link just mirrors the current tab, so on a cold
        // /portal/projects it points there for the first render. It is not a way into a console.
        if (document.querySelector(`a[href^="/portal/${k}"]:not(.ss-back)`)) window.__navSeen[k] = true;
      }
    };
    const attach = () => {
      if (!document.documentElement) { setTimeout(attach, 5); return; }
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    };
    attach();
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
      const name = rpc[1];
      if (name === "log_error") return json(route, null);
      if (name === "is_support_operator") {
        if (S.supportDelayMs) await new Promise((r) => setTimeout(r, S.supportDelayMs));
        calls.push({ fn: "rpc", action: name, at: Date.now() - t0 });
        if (S.supportFails) return json(route, { message: "stubbed failure" }, 500);
        return json(route, S.support);
      }
      calls.push({ fn: "rpc", action: name, at: Date.now() - t0 });
      if (name === "is_operator") return json(route, S.operator);
      if (name === "can_open_projects") return json(route, S.canProjects);
      return json(route, false);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "user" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    const fn = /\/functions\/v1\/([a-z0-9-]+)/.exec(url);
    if (fn) calls.push({ fn: fn[1], action: body.action, at: Date.now() - t0 });
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: "user", access: ACCESS, prefs: null, configured: false, branding: {} });
      return json(route, { ok: true });
    }
    if (url.includes("/admin-catalog")) {
      if (body.action === "list_clients") return json(route, { ok: true, clients: [], features: [] });
      if (body.action === "get_master") return json(route, { ok: true, layoutItemTypes: [] });
      return json(route, { ok: true });
    }
    if (url.includes("/operator-portal")) return json(route, { ok: true, clients: [] });
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  // What _redirects does in production: every /portal/<page> is portal.html.
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));

  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  // Past the held rpc, then long enough for anything it unblocks (a mount, its first calls, the
  // URL rewrite) to have happened.
  await page.waitForTimeout((S.supportDelayMs || 0) + 2500);
  const out = {
    label, calls, pageErrors,
    seen: await page.evaluate(() => window.__navSeen),
    nav: await page.evaluate(() => ({
      admin: !!document.querySelector('a[href^="/portal/admin"]:not(.ss-back)'),
      projects: !!document.querySelector('a[href^="/portal/projects"]:not(.ss-back)'),
      accounts: !!document.querySelector('a[href^="/portal/accounts"]'),
    })),
    path: await page.evaluate(() => location.pathname),
    bodyText: await page.evaluate(() => (document.querySelector(".ss-body") || document.body).innerText),
  };
  await ctx.close();
  return out;
}
const sent = (r, fn, action) => r.calls.filter((c) => c.fn === fn && (!action || c.action === action));
const answeredAt = (r) => { const c = sent(r, "rpc", "is_support_operator")[0]; return c ? c.at : null; };

try {
  // ── A: support operator, own portal, reload on /portal/admin, is_support_operator held back ──
  const A = await run("A", { operator: true, support: true, supportDelayMs: 1500, canProjects: false }, "/portal/admin");
  ok("A: is_support_operator answered (the stub held it 1.5 s)", answeredAt(A) !== null, `at ${answeredAt(A)} ms`);
  ok("A: the Admin item is never drawn, not even before is_support_operator answers", !A.seen.admin);
  ok("A: AdminShell never mounts: no get_master", sent(A, "admin-catalog", "get_master").length === 0, JSON.stringify(sent(A, "admin-catalog")));
  ok("A: …and no list_clients", sent(A, "admin-catalog", "list_clients").length === 0);
  ok("A: no admin-catalog call of any kind", sent(A, "admin-catalog").length === 0);
  ok("A: the address bar leaves /portal/admin", A.path !== "/portal/admin", A.path);
  ok("A: the Accounts switcher is still offered", A.nav.accounts);
  ok("A: no Projects item (can_open_projects answers false after migration 250)", !A.seen.projects);
  ok("A: no portal-projects call", sent(A, "portal-projects").length === 0);
  ok("A: no uncaught page errors", A.pageErrors.length === 0, A.pageErrors.join(" | "));

  // ── B: support operator, own portal, reload on /portal/projects ──
  const B = await run("B", { operator: true, support: true, supportDelayMs: 800, canProjects: false }, "/portal/projects");
  ok("B: the Projects item is never drawn", !B.seen.projects);
  ok("B: ProjectsTab never mounts: no list_boards", sent(B, "portal-projects", "list_boards").length === 0, JSON.stringify(sent(B, "portal-projects")));
  ok("B: the address bar leaves /portal/projects", B.path !== "/portal/projects", B.path);
  ok("B: no Admin item and no admin-catalog call", !B.seen.admin && sent(B, "admin-catalog").length === 0);
  ok("B: no uncaught page errors", B.pageErrors.length === 0, B.pageErrors.join(" | "));

  // ── C: a platform operator, same reload, same held rpc, still gets Admin ──
  const C = await run("C", { operator: true, support: false, supportDelayMs: 1500, canProjects: true }, "/portal/admin");
  const firstAdmin = sent(C, "admin-catalog")[0];
  ok("C: the Admin item is drawn", C.nav.admin);
  ok("C: AdminShell mounts: get_master and list_clients are sent", sent(C, "admin-catalog", "get_master").length > 0 && sent(C, "admin-catalog", "list_clients").length > 0,
    JSON.stringify(sent(C, "admin-catalog").map((c) => c.action)));
  ok("C: …but only after is_support_operator answered false", !!firstAdmin && answeredAt(C) !== null && firstAdmin.at >= answeredAt(C),
    `first admin-catalog at ${firstAdmin && firstAdmin.at} ms, rpc answered at ${answeredAt(C)} ms`);
  ok("C: the deep link survives the wait (still /portal/admin)", C.path === "/portal/admin", C.path);
  ok("C: Projects and Accounts are drawn too", C.nav.projects && C.nav.accounts);
  ok("C: no uncaught page errors", C.pageErrors.length === 0, C.pageErrors.join(" | "));

  // ── D: a platform operator whose is_support_operator call FAILS ──
  // The documented trade-off (the same posture as canProjects): unknown keeps the console shut
  // until the next token asks again, rather than guessing "not support".
  const D = await run("D", { operator: true, support: false, supportFails: true, canProjects: true }, "/portal/admin");
  ok("D: a failed is_support_operator keeps Admin shut (fails closed)", !D.seen.admin && sent(D, "admin-catalog").length === 0);
  ok("D: …and the Accounts switcher still shows", D.nav.accounts);
  ok("D: /portal/admin says access could not be confirmed instead of rendering blank", /Couldn't confirm your access/.test(D.bodyText), D.bodyText.slice(0, 120));
  ok("D: the failed rpc is asked once more before giving up", sent(D, "rpc", "is_support_operator").length >= 2, String(sent(D, "rpc", "is_support_operator").length));
  ok("D: no uncaught page errors", D.pageErrors.length === 0, D.pageErrors.join(" | "));

  // ── E: the frontend alone, before migration 250 is applied ──
  // can_open_projects still answers true for a support account here, as the live database did
  // before 250. The shell's own projectsOpen gate (isSupportOp === false) must close it anyway.
  const E = await run("E", { operator: true, support: true, supportDelayMs: 800, canProjects: true }, "/portal/projects");
  ok("E: pre-250 rpc: the Projects item is never drawn", !E.seen.projects);
  ok("E: pre-250 rpc: ProjectsTab never mounts: no list_boards", sent(E, "portal-projects", "list_boards").length === 0, JSON.stringify(sent(E, "portal-projects")));
  ok("E: no uncaught page errors", E.pageErrors.length === 0, E.pageErrors.join(" | "));

  // ── G: a CSM team member with the Projects area (not an operator), is_support_operator FAILS ──
  // Team members never depended on this rpc before; a blip must not cost them the board.
  const G = await run("G", { operator: false, support: false, supportFails: true, canProjects: true }, "/portal/projects");
  ok("G: the Projects item is drawn once the rpc gives up", G.nav.projects);
  ok("G: ProjectsTab mounts: list_boards is sent", sent(G, "portal-projects", "list_boards").length > 0, JSON.stringify(sent(G, "portal-projects")));
  ok("G: the deep link survives (still /portal/projects)", G.path === "/portal/projects", G.path);
  ok("G: no Admin item for a non-operator", !G.seen.admin);
  ok("G: no uncaught page errors", G.pageErrors.length === 0, G.pageErrors.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
