// Settings → QuickBooks after a reconnect or a company switch (migration 265), driven for real.
//
// Drives the COMPILED portal with Supabase stubbed at the network layer (no login, nothing leaves
// the machine, nothing reaches Intuit) and checks what the owner reads:
//
//   A. landing from a company switch (?connected=1&reason=company_changed) says the old company's
//      mappings were cleared and to pick items, and the params are stripped from the address bar
//   A2. a takeover that also cleared this account's other-company mappings
//      (?connected=1&reason=displaced_company_changed) says both things
//   B. landing on item_map_stale says some leftover mappings could not be tidied up AND will not
//      be used, without speaking of an "old company" (a same-company reconnect can land there)
//   C. a plain reconnect (?connected=1) keeps the usual "QuickBooks connected" banner, and the
//      mapping grid renders from list_item_map
//   D. Retry on an invoice that already went into the company before a switch reads "already in
//      the QuickBooks company you were connected to before"; one already in THIS company keeps
//      "already in QuickBooks"; one that really pushes reads "Pushed to QuickBooks." D1's answer
//      is stubbed, and the real server gives it only to a list gone stale in an open tab (pushed,
//      then a switch, then Retry): qbo_pending lists invoices with no QuickBooks id, so a fresh
//      page never offers such a row. E is the standing answer.
//   E. after a switch, the connection card says how many earlier invoices stay in the company
//      connected before (qbo_status otherCompanyInvoices; the wiring test drives the count from
//      what the push and the callback record), and says nothing when there are none
//
// The server half (which rows count, what the callback clears, what retry answers) is driven in
// supabase/functions/_shared/_test_stubs/qboRealmWiring_test.ts. This only proves the page says it.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/qboReconnect.mjs              (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<path to an older portal.app.compiled.js> serves that file instead. Against
// the artifact before this change, A, A2, B, D's first check and E's first fail (company_changed and
// displaced_company_changed fall back to the plain banner, item_map_stale and Retry keep their old
// words, the card has no invoice line) and C still passes: an older page meeting the new callback
// degrades to "QuickBooks connected", never to an error.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, reporter, shotsDir, BASE, REF } from "./lib.mjs";

const CLIENT = "harness-qbo";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000004", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const PORTAL_HTML = readFileSync(new URL("../../portal.html", import.meta.url), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

const SAYS = {
  companyChanged: "Connected to a different QuickBooks company, so the item mappings for the old one were cleared. Pick your items below before sending an invoice.",
  displacedChanged: "Connected. This QuickBooks company was moved here from another StructureStudio account, so it no longer syncs there. The item mappings for the company you used before were cleared, so pick your items below before sending an invoice. If that wasn't intended, reconnect and choose a different company at Intuit.",
  stale: "Connected, but some leftover item mappings couldn't be tidied up. They won't be used. Check the mappings below before sending an invoice.",
  elsewhere: "2 earlier invoices stay in the QuickBooks company you were connected to before. They weren't copied into this one.",
  connected: "QuickBooks connected. Check the company name below is the right business.",
  otherCompany: "That invoice is already in the QuickBooks company you were connected to before.",
  already: "That invoice is already in QuickBooks.",
  pushed: "Pushed to QuickBooks.",
};

const SHOTS = shotsDir("qbo-reconnect");
const { ok, failed } = reporter();
const { browser } = await launch({ width: 1400, height: 1000 });
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// One fresh context per scenario. `retry` is what retry_qbo_push answers; `elsewhere` is
// qbo_status's otherCompanyInvoices.
async function open(query, { retry = null, elsewhere = 0 } = {}) {
  const calls = [];
  const logged = [];
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ } }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  // Catch-all abort FIRST: Playwright runs matching routes in reverse registration order.
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/log_error")) { logged.push(body); return json(route, null); }
    if (url.includes("/rest/v1/rpc/")) return json(route, false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null,
        entitlement: { granted: ["quickbooks_sync"], features: { quickbooks_sync: true }, status: "active" } });
    }
    if (url.includes("/admin-catalog")) return json(route, { ok: true, clients: [], features: [], layoutItemTypes: [] });
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    switch (body.action) {
      case "status": return json(route, { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, branding: {} });
      case "qbo_status": return json(route, {
        clientId: CLIENT, oauthReady: true, connected: true, companyName: "Harness Books B", realmIdMasked: "••••0002",
        connectedAt: "2026-10-04T12:00:00Z", broken: false, brokenReason: null, refreshTokenExpiresAt: null, disconnectReason: null, mappedCount: 1,
        otherCompanyInvoices: elsewhere,
      });
      case "list_item_map": return json(route, {
        clientId: CLIENT, styles: [], layoutItems: [],
        mappings: [{ id: "m1", line_kind: "building", item_key: "", style_id: null, qbo_item_id: "21", qbo_item_name: "Buildings" }],
      });
      case "list_qbo_items": return json(route, { clientId: CLIENT, items: [{ id: "21", name: "Buildings", type: "Service", fullName: "Buildings" }, { id: "29", name: "Options", type: "Service", fullName: "Options" }] });
      case "qbo_pending": return json(route, { ok: true, clientId: CLIENT, pending: retry ? [{ shortCode: "SS-HARNESS01", invoiceNumber: "INV-7", error: "unmapped: door (Single door) — map these under Settings → QuickBooks, then Retry", attempts: 1, at: "2026-10-04T12:00:00Z" }] : [] });
      case "retry_qbo_push": return json(route, retry ?? { error: "unexpected retry" }, retry ? 200 : 400);
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  // What _redirects does in production: every /portal/<page> is portal.html.
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));
  await page.goto(`${BASE}/portal/settings/quickbooks${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  return { page, ctx, calls, logged, pageErrors };
}
const waitText = (page, s, timeout = 15000) =>
  page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const clean = (S, label) => {
  ok(`${label}: no page errors`, S.pageErrors.length === 0, S.pageErrors.join(" | "));
  ok(`${label}: nothing filed in app_errors`, S.logged.length === 0, JSON.stringify(S.logged).slice(0, 200));
};

try {
  // ── A ──
  {
    const S = await open("?connected=1&reason=company_changed");
    ok("A: a company switch says the old mappings were cleared", await waitText(S.page, SAYS.companyChanged));
    ok("A: and not the plain connected banner", !(await S.page.evaluate(() => document.body.innerText)).includes(SAYS.connected));
    ok("A: the landing params are stripped from the address bar", new URL(S.page.url()).search === "", S.page.url());
    ok("A: the connection card names the new company", await waitText(S.page, "Connected to Harness Books B"));
    await S.page.screenshot({ path: join(SHOTS, "company-changed.png") }).catch(() => {});
    clean(S, "A");
    await S.ctx.close();
  }
  // ── A2 ──
  {
    const S = await open("?connected=1&reason=displaced_company_changed");
    ok("A2: a takeover that also cleared the old mappings says both", await waitText(S.page, SAYS.displacedChanged));
    clean(S, "A2");
    await S.ctx.close();
  }
  // ── B ──
  {
    const S = await open("?connected=1&reason=item_map_stale");
    ok("B: a failed tidy-up says the leftover mappings won't be used", await waitText(S.page, SAYS.stale));
    ok("B: and speaks of no old company", !(await S.page.evaluate(() => document.body.innerText)).includes("old company"));
    clean(S, "B");
    await S.ctx.close();
  }
  // ── C ──
  {
    const S = await open("?connected=1");
    ok("C: a plain reconnect keeps the usual banner", await waitText(S.page, SAYS.connected));
    ok("C: the mapping grid renders", await waitText(S.page, "Invoice item mappings") && await waitText(S.page, "Taller walls"));
    const picked = await S.page.locator("select").first().inputValue().catch(() => null);
    ok("C: the Building row shows the mapping list_item_map returned", picked === "21", String(picked));
    ok("C: no invoices elsewhere, so the card says nothing about them", !(await S.page.evaluate(() => document.body.innerText)).includes("earlier invoice"));
    clean(S, "C");
    await S.ctx.close();
  }
  // ── D ──
  for (const [label, answer, want] of [
    ["D1: an invoice in the company before a switch", { ok: true, alreadyPushed: true, otherCompany: true, qboInvoiceId: "501", clientId: CLIENT }, SAYS.otherCompany],
    ["D2: an invoice already in this company", { ok: true, alreadyPushed: true, otherCompany: false, qboInvoiceId: "601", clientId: CLIENT }, SAYS.already],
    ["D3: an invoice that really pushes", { ok: true, qboInvoiceId: "9001", qboDocNumber: "INV-7", error: null, clientId: CLIENT }, SAYS.pushed],
  ]) {
    const S = await open("", { retry: answer });
    ok(`${label}: the pending card shows`, await waitText(S.page, "1 invoice didn’t reach QuickBooks"));
    await S.page.getByRole("button", { name: "Retry", exact: true }).click();
    ok(`${label}: reads "${want}"`, await waitText(S.page, want));
    ok(`${label}: retry_qbo_push was asked for that invoice`, S.calls.some((c) => c.action === "retry_qbo_push" && c.shortCode === "SS-HARNESS01"));
    if (label.startsWith("D1")) await S.page.screenshot({ path: join(SHOTS, "retry-other-company.png") }).catch(() => {});
    clean(S, label.slice(0, 2));
    await S.ctx.close();
  }
  // ── E ──
  {
    const S = await open("", { elsewhere: 2 });
    ok("E: the card says the earlier invoices stay in the old company", await waitText(S.page, SAYS.elsewhere));
    await S.page.screenshot({ path: join(SHOTS, "invoices-elsewhere.png") }).catch(() => {});
    clean(S, "E");
    await S.ctx.close();
  }
} finally {
  await browser.close();
}

const bad = failed();
console.log(`screenshots: ${SHOTS}`);
console.log(bad.length ? `\n${bad.length} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(bad.length ? 1 : 0);
