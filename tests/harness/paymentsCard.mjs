// Settings → Company → Payments: the read-only "Structure Studio Payments" card (workstream 1
// phase 4), driven for real.
//
// Drives the COMPILED portal with Supabase stubbed at the network layer (no login, nothing leaves
// the machine) and asserts what shows, what gets called, and that nothing on the card can change
// anything:
//
//   A. an owner has a Payments tab in Company; the card is titled "Structure Studio Payments", says
//      the account is set up and managed by the Structure Studio team and is locked, and shows ON,
//      LIVE and the merchant id's last four, never more of it; there is no box, no button and no
//      select on the card; payments_status is called once and nothing else is posted
//   B. test mode, switched off: OFF, TEST, what "off" means for the builder's customers
//   C. no merchant id yet: "Not set up yet"
//   D. a portal-settings older than this page (403 "Unrecognised action"): who manages the account,
//      no status rows, no refusal sentence on screen
//   E. any other failure shows the server's own sentence and no status
//   F. a member without Branding (a Team-only grant) sees Company but no Payments tab, and
//      payments_status is never called; a member granted Branding:view sees the card
//   G. /portal/settings/payments opens straight on the card
//   H. the request copy tells the builder how to ask for a change (Feedback → Request a Feature,
//      Support → My Requests)
//
// The stub answers payments_status in the shape portal-settings does (paymentsStatusWiring_test pins
// the server side), from a client_settings row the scenario sets.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/paymentsCard.mjs             (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<path to an older portal.app.compiled.js> serves that file instead, which is how
// to prove the checks can fire: against the artifact committed before this card (origin/beta's
// portal.app.compiled.js) A's first check fails, there is no tab, and the run stops there.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF } from "./lib.mjs";

// A deep link like /portal/settings/payments is portal.html on the real hosts (`_redirects`); a plain
// static server 404s it, so the harness serves the page there itself (myProfileRoute.mjs's way).
const PORTAL_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "portal.html"), "utf8");

const CLIENT = "harness-payments";
const MID = "100200300400";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000005", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// Mutable per scenario. `row` is the builder's client_settings as payments_status reads it.
const S = { role: "owner", access: null, row: null, old: false, fail: null };
const calls = [];
const pageErrors = [];

// portal-settings payments_status, from the row: on only with a MID, live/test, last four only.
const statusAnswer = () => {
  const r = S.row || {};
  const mid = typeof r.cardpointe_merchid === "string" ? r.cardpointe_merchid.trim() : "";
  return {
    ok: true,
    enabled: r.payments_online_enabled === true && !!mid,
    env: r.cardpointe_env === "prod" ? "live" : "test",
    midLast4: mid.length >= 4 ? mid.slice(-4) : null,
    credentialsOnFile: false,
    brand: "Structure Studio Payments",
  };
};

const { ok, failed, results } = reporter();
const { browser } = await launch({ width: 1400, height: 1000 });
// serviceWorkers "block": portal.html registers sw.js, and a navigation the worker serves never
// reaches page.route, so G's deep link would hit the static server (a 404) instead of the page.
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ } }, [REF, SESSION]);
const page = await ctx.newPage();
page.on("pageerror", (e) => pageErrors.push(e.message));

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
// Catch-all abort FIRST: Playwright runs matching routes in reverse registration order.
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  if (url.includes("/rest/v1/rpc/log_error")) return json(route, null);
  if (url.includes("/rest/v1/rpc/")) return json(route, false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: S.role }]);
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
  }
  if (!url.includes("/portal-settings")) return json(route, { ok: true });
  const a = body.action;
  calls.push({ fn: "portal-settings", action: a, body });
  if (a === "status") {
    return json(route, {
      ok: true, clientId: CLIENT, role: S.role, access: S.access, prefs: null, configured: false,
      invoiceInGhl: false, ghlInvoicingAllowed: false, ssQuoteNext: 1041, ssInvoiceNext: 2001,
      ssTaxRate: 6.5, ssTaxLabel: "Sales tax", ssTaxDelivery: false, businessAddress: {}, branding: {}, emailReady: true,
    });
  }
  if (a === "payments_status") {
    if (S.old) return json(route, { error: `Unrecognised action "${a}".` }, 403);
    if (S.fail) return json(route, { error: S.fail, ref: "load your payment settings" }, 500);
    return json(route, statusAnswer());
  }
  if (a === "list_locations") return json(route, { ok: true, nextSerial: 100, locations: [] });
  return json(route, { ok: true });
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
if (process.env.SS_PORTAL_ARTIFACT) {
  const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
  await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
}

const text = () => page.evaluate(() => document.body.innerText);
const waitText = (s, timeout = 15000) => page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const callsOf = (action) => calls.filter((c) => c.action === action);
const tabButton = () => page.getByRole("button", { name: "Payments", exact: true });
const card = () => page.locator("[data-payments-card]");
const cardText = () => card().innerText().catch(() => "");
const LIVE_ON = { payments_online_enabled: true, cardpointe_merchid: MID, cardpointe_env: "prod" };

const boot = async (shape, path = "/portal.html") => {
  Object.assign(S, { role: "owner", access: null, row: LIVE_ON, old: false, fail: null }, shape);
  calls.length = 0;
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  const booted = await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 })
    .then(() => true, () => false);
  if (!booted) {
    // A finding, not a harness crash: say what is on screen instead.
    console.log(`boot(${path}) did not finish: ${await page.evaluate(() => `${location.pathname} | ${document.body.innerText.slice(0, 300)}`)}`);
    return false;
  }
  if (path !== "/portal.html") { await page.waitForTimeout(900); return true; }
  await page.getByText("Settings", { exact: true }).last().click();
  await page.waitForTimeout(700);
  const company = page.getByText("Company", { exact: true });
  if (!(await company.last().waitFor({ timeout: 8000 }).then(() => true, () => false))) return false;
  await company.last().click();
  await page.waitForTimeout(700);
  return true;
};
const openPayments = async () => {
  if (await tabButton().count()) await tabButton().click();
  return card().waitFor({ timeout: 10000 }).then(() => true, () => false);
};
const waitStatus = () => page.locator("[data-payments-status], [data-payments-soon], [data-payments-card] div[style*='FECACA']").first()
  .waitFor({ timeout: 10000 }).then(() => true, () => false);

try {
  // ── A ──
  await boot({});
  ok("A: an owner has a Payments tab in Company", (await tabButton().count()) === 1);
  ok("A: the card opens", await openPayments());
  ok("A: …and its status loads", await waitStatus());
  const tA = await cardText();
  ok("A: titled Structure Studio Payments", tA.startsWith("Structure Studio Payments"), tA.slice(0, 60));
  ok("A: locked, and managed by the Structure Studio team", /Managed for you/.test(tA) && /set up and managed by the Structure Studio team/.test(tA) && /locked here/.test(tA), tA);
  ok("A: ON", (await page.locator("[data-payments-onoff]").innerText()).includes("ON"));
  ok("A: LIVE", (await page.locator("[data-payments-mode]").innerText()).includes("LIVE"));
  ok("A: the last four of the merchant id", /ending in\s*0400/.test(await page.locator("[data-payments-mid]").innerText()));
  ok("A: never more of the merchant id than the last four", !(await text()).includes(MID.slice(0, 8)));
  ok("A: read-only: no box, no select and no button on the card",
    (await card().locator("input, select, textarea, button").count()) === 0);
  ok("A: no CSM Synergy branding on the card", !/CSM Synergy/i.test(tA), tA);
  ok("A: payments_status called once", callsOf("payments_status").length === 1, String(callsOf("payments_status").length));
  ok("A: and nothing that writes was posted", calls.every((c) => !/^(save|set|upload|delete|update|verify)/.test(String(c.action))),
    JSON.stringify(calls.map((c) => c.action)));

  // ── H ──
  const req = await page.locator("[data-payments-request]").innerText();
  ok("H: how to ask for a change", /Need a change\?/.test(req) && /Feedback/.test(req) && /Request a Feature/.test(req) && /Support → My Requests/.test(req), req);

  // ── B ──
  await boot({ row: { payments_online_enabled: false, cardpointe_merchid: MID, cardpointe_env: "uat" } });
  await openPayments();
  await waitStatus();
  ok("B: OFF", (await page.locator("[data-payments-onoff]").innerText()).includes("OFF"));
  ok("B: TEST, and what it means", (await page.locator("[data-payments-mode]").innerText()).includes("TEST") && /No real money moves/.test(await cardText()));
  ok("B: what off means for their customers", /your customers can't pay online/.test(await cardText()));

  // ── C ──
  await boot({ row: { payments_online_enabled: false, cardpointe_merchid: null, cardpointe_env: "uat" } });
  await openPayments();
  await waitStatus();
  ok("C: no merchant id: Not set up yet", (await page.locator("[data-payments-mid]").innerText()).includes("Not set up yet"));

  // ── D ──
  await boot({ old: true });
  await openPayments();
  ok("D: an older function: who manages the account", await waitText("The details of your account will show here soon."));
  ok("D: …no status rows", (await page.locator("[data-payments-status]").count()) === 0);
  ok("D: …and no refusal sentence on screen", !/Unrecognised action/.test(await text()));
  ok("D: …the title and the managed-for-you line still show", /^Structure Studio Payments/.test(await cardText()) && /Managed for you/.test(await cardText()));

  // ── E ──
  await boot({ fail: "Couldn't load your payment settings. Please try again." });
  await openPayments();
  ok("E: another failure shows the server's sentence", await waitText("Couldn't load your payment settings. Please try again."));
  ok("E: …and no status", (await page.locator("[data-payments-status]").count()) === 0);

  // ── F ──
  await boot({ role: "user", access: { settings_team: "view", settings_branding: "none", settings_crm: "none" } });
  await waitText("Locations", 8000);
  ok("F: a Team-only member sees the Company tabs", (await page.getByRole("button", { name: "Locations", exact: true }).count()) === 1);
  ok("F: …and no Payments tab", (await tabButton().count()) === 0);
  ok("F: …and payments_status is never called", callsOf("payments_status").length === 0);
  ok("F: a member granted Branding:view reaches the card", await boot({ role: "user", access: { settings_branding: "view" } }) && await openPayments() && await waitStatus());

  // ── G ──
  await boot({}, "/portal/settings/payments");
  ok("G: /portal/settings/payments opens on the card", await card().waitFor({ timeout: 10000 }).then(() => true, () => false));
  ok("G: …with the Payments tab current", (await page.locator('button[aria-current="page"]', { hasText: "Payments" }).count()) === 1);

  ok("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
