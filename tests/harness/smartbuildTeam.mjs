// The Team screen of a builder WITHOUT the shed product (migration 364), driven for real on the
// COMPILED portal. Nobody can see it otherwise: in operator view-as Team shows "aren't editable
// from view-as", and the first such builder has no login yet.
//
//   node tests/harness/smartbuildTeam.mjs           (exit 0 = every check held)
//
// What a sheds-off owner is offered: no shed access areas, no Scheduler / Crew Leader / Crew
// Member / Driver title (someone who already holds one keeps it in their own grid), and the three
// settings switches named for the pages they open here. A sheds-on owner is the control: the same
// stubbed team shows every area and title, under the server's names.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine), the shape
// myProfileRoute.mjs uses. The access metadata is the REAL accessMetadata(), read through deno, so
// a renamed area fails here instead of passing against a copy.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, serveAppRoutes } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const META = JSON.parse(execFileSync("deno", ["eval", "--quiet",
  'import { accessMetadata } from "./supabase/functions/_shared/access.ts"; console.log(JSON.stringify(accessMetadata()));'],
{ cwd: ROOT, encoding: "utf8" }));

const CLIENT = "harness-builder";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER = Object.fromEntries(META.areas.map((a) => [a.key, "edit"]));
const member = (n, name, title, role) => ({
  userId: `00000000-0000-4000-8000-00000000000${n}`, fullName: name, email: `${title}@example.test`,
  title, role, effective: title === "owner" ? OWNER : { ...(META.presets[title] || {}) },
  commissionPercent: null, lastSignIn: null,
});
const MEMBERS = [member(1, "Olive Owner", "owner", "owner"), member(2, "Sam Rep", "sales_rep", "user"), member(3, "Dan Driver", "driver", "user")];

const SHED_LABELS = ["Shed Designer", "Override prices", "Designs", "Inventory", "Orders", "Change Orders", "Approve Changes",
  "Build Schedule", "Delivery Schedule", "Repairs", "Sheds", "Options & Colors"];
const SHED_TITLES = ["Scheduler", "Crew Leader", "Crew Member", "Driver"];

const { ok, failed } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

async function run(shedsOn) {
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
    if (rpc) return json(route, rpc[1] === "log_error" ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null,
        entitlement: { granted: [], features: { crm: true }, status: "active", shedsOn } });
    }
    if (url.includes("/portal-commissions") && body.action === "list") {
      return json(route, { members: MEMBERS, canSeeRates: true, isOwner: true, role: "owner", canManageTeam: true, meta: META, myAccess: OWNER });
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: "owner", access: OWNER, prefs: null, configured: false, branding: {} });
      if (body.action === "get_profile") return json(route, { ok: true, fullName: "Olive Owner", phone: null, needsDetails: false });
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);

  await page.goto(`${BASE}/settings/team`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && document.body.innerText.includes("Sam Rep"), null, { timeout: 60000 });
  await page.waitForTimeout(1000);

  const optionsOf = () => page.evaluate(() => [...document.querySelectorAll("select")]
    .map((s) => [...s.options].map((o) => o.textContent.trim()))
    .filter((opts) => opts.includes("Sales Rep")));
  // The grid offers titles as buttons, not a select.
  const titleButtons = () => page.evaluate((labels) => [...document.querySelectorAll("button")]
    .map((b) => b.textContent.trim()).filter((t) => labels.includes(t)), META.titles.map((t) => t.label));
  const lines = () => page.evaluate(() => (document.querySelector(".ss-body") || document.body).innerText.split("\n").map((l) => l.trim()).filter(Boolean));
  const clickIn = (rowText, label) => page.evaluate(([rowText, label]) => {
    const row = [...document.querySelectorAll("tr")].find((tr) => tr.innerText.includes(rowText));
    const b = row && [...row.querySelectorAll("button")].find((x) => x.textContent.trim() === label);
    if (b) b.click();
    return !!b;
  }, [rowText, label]);

  const out = { pageErrors, path: await page.evaluate(() => location.pathname) };
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "+ Add person"); if (b) b.click(); });
  await page.waitForTimeout(500);
  out.addTitles = (await optionsOf())[0] || [];
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Cancel"); if (b) b.click(); });
  await page.waitForTimeout(300);

  out.samOpened = await clickIn("Sam Rep", "Edit");
  await page.waitForTimeout(800);
  out.samLines = await lines();
  out.samTitles = await titleButtons();
  await clickIn("Sam Rep", "Close");
  await page.waitForTimeout(300);

  out.danOpened = await clickIn("Dan Driver", "Edit");
  await page.waitForTimeout(800);
  out.danTitles = await titleButtons();
  await ctx.close();
  return out;
}

try {
  const A = await run(false);
  ok("A: a sheds-off owner's /settings/team stays put", A.path === "/settings/team", A.path);
  ok("A: no uncaught page errors", A.pageErrors.length === 0, A.pageErrors.join(" | "));
  ok("A: + Add person offers titles", A.addTitles.includes("Sales Rep") && A.addTitles.includes("Office Staff"), A.addTitles.join(", "));
  ok("A: …and none of the four shed titles", SHED_TITLES.every((t) => !A.addTitles.includes(t)), A.addTitles.join(", "));
  ok("A: Sam's access grid opens", A.samOpened && A.samLines.includes("Contacts"));
  const leaked = SHED_LABELS.filter((l) => A.samLines.includes(l));
  ok("A: …with no shed access area", leaked.length === 0, leaked.join(", "));
  ok("A: …and the settings switches named for this builder's pages",
    ["Business Details", "Customer Hub settings", "Email Settings"].every((l) => A.samLines.includes(l))
      && !A.samLines.includes("Branding & Estimates") && !A.samLines.includes("CRM Connection"));
  ok("A: Sam's title picker has no shed title", A.samTitles.length > 0 && SHED_TITLES.every((t) => !A.samTitles.includes(t)), A.samTitles.join(", "));
  ok("A: a Driver added before the switch keeps Driver in their own grid", A.danOpened && A.danTitles.includes("Driver"), A.danTitles.join(", "));
  ok("A: …but is not offered the other three", ["Scheduler", "Crew Leader", "Crew Member"].every((t) => !A.danTitles.includes(t)), A.danTitles.join(", "));

  const B = await run(true);
  ok("B (control): a shed builder is offered all four shed titles", SHED_TITLES.every((t) => B.addTitles.includes(t)), B.addTitles.join(", "));
  ok("B (control): …and every shed area, under the server's names",
    SHED_LABELS.every((l) => B.samLines.includes(l)) && B.samLines.includes("Branding & Estimates") && B.samLines.includes("CRM Connection"),
    SHED_LABELS.filter((l) => !B.samLines.includes(l)).join(", "));
  ok("B (control): no uncaught page errors", B.pageErrors.length === 0, B.pageErrors.join(" | "));
} finally {
  await browser.close();
}
const f = failed();
console.log(`\n${f.length ? "FAILED" : "OK"} — ${f.length} failed`);
process.exit(f.length ? 1 : 0);
