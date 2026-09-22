// Sales-tax settings UI reaches SS-mode tenants only, and degrades to nothing on an older function.
//
// Two review findings on the Avalara settings stage (2026-09-17), both about tenants who must see
// no change at all:
//   • The Sales tax box on CRM Connection keyed on the form's `ssMode`, which is true for a
//     grandfathered tenant without CRM invoicing whose row still says CRM mode. It called
//     tax_settings, and pointed them at a Locations tax section that the same answer hides.
//   • Against a portal-settings older than the page (the frontend deploys on push, functions
//     deploy separately), tax_settings answers 403 "Unrecognised action", and both surfaces
//     printed that refusal — on the Locations tab for CRM-mode tenants too.
// This drives the COMPILED portal with Supabase stubbed at the network layer (no login, nothing
// leaves the machine) through each tenant shape and asserts what shows and what gets called:
//
//   A. saved SS mode: box + location rates render
//   B. grandfathered (no capability, row says CRM): no call from CRM Connection, no tax text anywhere
//   C. SS tenant, older function: no box, no refusal, no Locations banner, lots still render
//   D. CRM-mode tenant WITH the capability, older function: no tax text anywhere
//   E. nothing (not even "Checking…") until the answer lands
//   F. an unsaved switch to CRM invoicing hides the box
//   G. a real 500: shown on CRM Connection (saved row is SS); silent on a first Locations read
//   H. a failed Locations RE-read after an SS answer shows its sentence
//   I. lookups on: the 24-hour usage line shows a counted number, and is left out when the ledger
//      could not be counted (usage24h null means unknown, not zero)
//
// list_locations answers the way the avalara-api branch does for a settings_crm reader: every lot
// carries taxRatePct / taxLabel / taxReady, whatever the mode (an older function omits them). So B
// and D also prove a CRM-mode tenant's Locations tab prints none of those rates.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/salesTaxModeGate.mjs         (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<path to an older portal.app.compiled.js> serves that file instead, which is
// how to prove a check still fires: against c5b2ec4's artifact, B, C, D, E and G fail; against
// 366b93b's, I's unreadable-ledger check fails.
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF } from "./lib.mjs";

const CLIENT = "harness-tax-barns";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// invoiceInGhl is the SAVED row, and tax_settings answers ssMode = !invoiceInGhl, as the server does.
// taxMode: "ok" | "old" (no GATES line: resolveTenant's 403) | "fail" (500).
const S = { invoiceInGhl: false, allowed: false, taxMode: "ok", taxDelayMs: 0, failAfterFirst: false, lookupEnabled: false, usage24h: 0 };
let taxCallsThisBoot = 0;
const calls = [];
const LOCS = [
  { id: "L1", name: "Hwy 65 Display", street: "1 Main", city: "Denver", state: "CO", zip: "80202", active: true, sort_order: 0, buildings: 3 },
  { id: "L2", name: "North Lot", street: null, city: "Boulder", state: "Colorado", zip: "80301", active: true, sort_order: 1, buildings: 1 },
];
const TAX = { L1: { taxRatePct: 7.25, taxLabel: "Local sales tax", taxReady: true }, L2: { taxRatePct: null, taxLabel: null, taxReady: true } };
// Every sentence the tax UI can put on screen, the refusals included.
const TAX_TEXT = /Verified lookups|Local rates:|Checking your sales tax|your local rate|Sales tax rates couldn't load|Unrecognised action|couldn't read your sales tax/i;

const { ok, failed, results } = reporter();
const { browser, ctx } = await launch({ width: 1400, height: 1000 });
await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ } }, [REF, SESSION]);
const page = await ctx.newPage();
const pageErrors = [];
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
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
  }
  if (!url.includes("/portal-settings")) return json(route, { ok: true });
  const a = body.action;
  calls.push(a);
  if (a === "status") {
    return json(route, {
      ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false,
      invoiceInGhl: S.invoiceInGhl, ghlInvoicingAllowed: S.allowed,
      ssQuoteNext: 1041, ssInvoiceNext: 2001, ssTaxRate: 6.5, ssTaxLabel: "Sales tax", ssTaxDelivery: false,
      businessAddress: {}, branding: {}, emailReady: true,
    });
  }
  // The avalara-api branch adds taxRatePct / taxLabel / taxReady to every lot for a caller who can
  // read settings_crm (this owner can) — in CRM mode too, since that read does not ask the mode. So a
  // CRM-mode tenant's Locations tab receives rates it must not print; B and D check it doesn't. An
  // older function ("old") predates the fields.
  if (a === "list_locations") {
    return json(route, { ok: true, nextSerial: 100, locations: S.taxMode === "old" ? LOCS : LOCS.map((l) => ({ ...l, ...TAX[l.id] })) });
  }
  if (a === "tax_settings") {
    taxCallsThisBoot += 1;
    if (S.taxDelayMs) await new Promise((r) => setTimeout(r, S.taxDelayMs));
    const mode = S.failAfterFirst && taxCallsThisBoot > 1 ? "fail" : S.taxMode;
    if (mode === "old") return json(route, { error: `Unrecognised action "tax_settings".` }, 403);
    if (mode === "fail") return json(route, { error: "We couldn't read your sales tax settings." }, 500);
    return json(route, {
      ok: true, ssMode: !S.invoiceInGhl, lookupEnabled: S.lookupEnabled, configured: true,
      companyRatePct: 6.5, companyLabel: "Sales tax", dailyCap: 100, usage24h: S.usage24h,
      locations: LOCS.map((l) => ({ id: l.id, name: l.name, city: l.city, state: l.state, zip: l.zip, active: true, ...TAX[l.id] })),
    });
  }
  return json(route, { ok: true });
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
if (process.env.SS_PORTAL_ARTIFACT) {
  const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
  await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
}

const text = () => page.evaluate(() => document.body.innerText);
const waitText = (s, timeout = 20000) => page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const taxCalls = () => calls.filter((c) => c === "tax_settings").length;
const hit = (t) => (t.match(TAX_TEXT) || [""])[0];
const boot = async (shape) => {
  Object.assign(S, { taxDelayMs: 0, failAfterFirst: false, lookupEnabled: false, usage24h: 0 }, shape);
  taxCallsThisBoot = 0;
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.getByText("Settings", { exact: true }).last().click();
  await page.waitForTimeout(900);
};
// The label is uppercased by CSS, and innerText reports what is rendered.
const openCrm = async () => {
  await page.getByText("CRM Connection", { exact: true }).last().click();
  await waitText(S.allowed ? "Quote and invoice through my CRM" : "SALES TAX RATE (%)");
};
const openLocations = async () => {
  await page.getByText("Company", { exact: true }).last().click();
  await page.waitForTimeout(600);
  await page.getByText("Locations", { exact: true }).last().click();
  await waitText("Hwy 65 Display");
};

try {
  // A
  await boot({ invoiceInGhl: false, allowed: false, taxMode: "ok" });
  await openCrm();
  ok("A: saved-SS tenant sees the Sales tax box", await waitText("Verified lookups:"));
  ok("A: local-rate count line", /Local rates:\s*1 of your sales locations has its own rate/.test(await text()));
  await openLocations();
  ok("A: saved-SS tenant sees location rates", await waitText("your local rate"));

  // B
  await boot({ invoiceInGhl: true, allowed: false, taxMode: "ok" });
  let before = taxCalls();
  await openCrm();
  await page.waitForTimeout(1500);
  let t = await text();
  ok("B: numbering + company-rate fields still show (unchanged)", t.toLowerCase().includes("sales tax rate (%)"));
  ok("B: CRM Connection makes no tax_settings call", taxCalls() === before, `calls ${taxCalls() - before}`);
  ok("B: CRM Connection shows no tax text", !TAX_TEXT.test(t), hit(t));
  await openLocations();
  await page.waitForTimeout(1500);
  t = await text();
  ok("B: Locations asks (the card cannot know the mode)", taxCalls() > before);
  ok("B: Locations shows no tax text (server says CRM mode)", !TAX_TEXT.test(t), hit(t));

  // C
  await boot({ invoiceInGhl: false, allowed: false, taxMode: "old" });
  before = taxCalls();
  await openCrm();
  await page.waitForTimeout(1500);
  t = await text();
  ok("C: older function: CRM Connection did ask", taxCalls() > before);
  ok("C: older function: no box, no refusal on CRM Connection", !TAX_TEXT.test(t), hit(t));
  await openLocations();
  await page.waitForTimeout(1500);
  t = await text();
  ok("C: older function: lots still render", t.includes("North Lot"));
  ok("C: older function: no banner, no tax text on Locations", !TAX_TEXT.test(t), hit(t));

  // D
  await boot({ invoiceInGhl: true, allowed: true, taxMode: "old" });
  before = taxCalls();
  await openCrm();
  await page.waitForTimeout(1500);
  t = await text();
  ok("D: CRM-mode tenant: no tax_settings call from CRM Connection", taxCalls() === before);
  ok("D: CRM-mode tenant: no tax text on CRM Connection", !TAX_TEXT.test(t), hit(t));
  await openLocations();
  await page.waitForTimeout(1500);
  t = await text();
  ok("D: CRM-mode tenant: no banner on Locations", !TAX_TEXT.test(t), hit(t));

  // E
  await boot({ invoiceInGhl: false, allowed: false, taxMode: "ok", taxDelayMs: 3000 });
  await openCrm();
  await page.waitForTimeout(700);
  ok("E: nothing rendered while the answer is in flight", !/Checking your sales tax|Verified lookups/.test(await text()));
  ok("E: box renders once the answer lands", await waitText("Verified lookups:", 10000));

  // F
  await boot({ invoiceInGhl: false, allowed: true, taxMode: "ok" });
  await openCrm();
  ok("F: capable saved-SS tenant sees the box", await waitText("Verified lookups:"));
  await page.getByText("Quote and invoice through my CRM", { exact: true }).click();
  await page.waitForTimeout(500);
  ok("F: an unsaved switch to CRM invoicing hides the box", !/Verified lookups/.test(await text()));

  // G
  await boot({ invoiceInGhl: false, allowed: false, taxMode: "fail" });
  await openCrm();
  ok("G: CRM Connection shows a real failure to a saved-SS tenant", await waitText("couldn't read your sales tax settings", 8000));
  await openLocations();
  await page.waitForTimeout(1500);
  ok("G: a first Locations read that fails is silent", !/Sales tax rates couldn't load/.test(await text()));

  // H
  await boot({ invoiceInGhl: false, allowed: false, taxMode: "ok", failAfterFirst: true });
  await openLocations();
  ok("H: first read shows rates", await waitText("your local rate"));
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByRole("button", { name: "Save location" }).click();
  ok("H: a failed re-read after an SS answer shows its sentence", await waitText("Sales tax rates couldn't load", 8000));

  // I
  await boot({ invoiceInGhl: false, allowed: false, taxMode: "ok", lookupEnabled: true, usage24h: 3 });
  await openCrm();
  ok("I: lookups on: a counted usage is shown", await waitText("3 of 100 used in the last 24 hours."));
  await boot({ invoiceInGhl: false, allowed: false, taxMode: "ok", lookupEnabled: true, usage24h: null });
  await openCrm();
  ok("I: lookups on, ledger unreadable: box renders", await waitText("Verified lookups:"));
  t = await text();
  ok("I: ledger unreadable: no usage line (not \"0 of 100\")", !/used in the last 24 hours/.test(t), (t.match(/Verified lookups:[^\n]*/) || [""])[0]);

  ok("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
