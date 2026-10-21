// Admin → Billing → "Sales tax lookups" (2026-10-21, migration 319), driven for real on the
// COMPILED portal: the read-only card that shows every builder's Avalara lookups and what each was
// charged, from admin-catalog tax_usage_get.
//
// Scenarios, one fresh browser context each:
//   a. the report: the card asks tax_usage_get for this UTC month (from the 1st to today); each
//      builder's row shows its switch (On / Off), Verify and invoice counts, failures, charged and
//      the amount; the meters say off; the charge-error warning names the replay; pings are counted
//      apart; changing the start date asks again with the new range; the card has no button that
//      changes anything (it is read-only).
//   b. an operator without can_bill: the server's sentence, nothing else.
//   c. a database without migration 319: the card says charges aren't recorded per lookup yet.
// Supabase is stubbed at the network layer (no login, nothing leaves the machine), as
// twilioAccountCard.mjs does it.
//
//   node <a static server for the repo root on 127.0.0.1:8125>   (SS_BASE overrides the origin)
//   node tests/harness/taxLookupsCard.mjs                          (exit 0 = every check held)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, serveAppRoutes } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000007", aud: "authenticated", role: "authenticated", email: "operator@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

const T0 = { clientId: "", companyName: "All builders", lookupEnabled: false, ssMode: false, billingExempt: false, calls: 0, verify: 0, invoice: 0, ok: 0, failed: 0, inFlight: 0, failures: {}, charged: 0, chargedCents: 0, exempt: 0, inactive: 0, unpriced: 0, noRate: 0, pending: 0, errors: 0, unstated: 0 };
const ACME = { ...T0, clientId: "acme-sheds", companyName: "Acme Sheds", lookupEnabled: true, ssMode: true, calls: 9, verify: 4, invoice: 5, ok: 8, failed: 1, failures: { timeout: 1 }, charged: 6, chargedCents: 60, inactive: 1, noRate: 1, errors: 1 };
const QUIET = { ...T0, clientId: "quiet-barns", companyName: "Quiet Barns", lookupEnabled: false, ssMode: false };
const REPORT = (range, extra = {}) => ({
  ok: true, range, rowCount: 10, truncated: false, chargesUnknown: false,
  meters: [{ kind: "tax_lookup", exists: true, active: false, priceCents: 0, armed: false }, { kind: "tax_invoice", exists: true, active: false, priceCents: 10, armed: false }],
  tenants: [ACME, QUIET], totals: { ...ACME, clientId: "", companyName: "All builders" }, platform: { pings: 2, pingsFailed: 0 }, ...extra,
});

const { ok, failed } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

async function run(S) {
  const calls = [];
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
      if (rpc[1] === "is_operator") return json(route, true);
      if (rpc[1] === "is_support_operator") return json(route, false);
      return json(route, null);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: "harness-internal", role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: "harness-internal", role: "owner", access: {}, prefs: null, configured: false, branding: {} });
      return json(route, { ok: true });
    }
    if (url.includes("/admin-catalog")) {
      if (/[?&]warm=1/.test(url)) return json(route, { ok: true });
      calls.push(body);
      if (body.action === "list_clients") return json(route, { ok: true, clients: [{ client_id: "acme-sheds", company_name: "Acme Sheds" }], features: [] });
      if (body.action === "get_master") return json(route, { ok: true, layoutItemTypes: [] });
      if (body.action === "tax_usage_get") {
        if (S.noBill) return json(route, { error: "This operator account cannot see or change sales tax billing." }, 403);
        return json(route, REPORT({ from: body.from, to: body.to, days: 1 }, S.extra || {}));
      }
      // The other Billing cards are not under test: they say they could not load.
      return json(route, { error: "not in this harness" }, 403);
    }
    if (url.includes("/operator-portal")) return json(route, { ok: true, clients: [] });
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);
  await page.goto(`${BASE}/console/billing`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  const card = page.locator("[data-adm-tax-lookups]");
  await card.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => {
    const el = document.querySelector("[data-adm-tax-lookups]");
    return el && (el.querySelector("table") || /cannot|isn't applied|No builder/.test(el.innerText));
  }, null, { timeout: 15000 });
  return { calls, pageErrors, page, card, ctx };
}

const today = new Date().toISOString().slice(0, 10);
const first = today.slice(0, 8) + "01";

// ── a ──
{
  const P = "a";
  const S = await run({});
  const asks = S.calls.filter((c) => c.action === "tax_usage_get");
  ok(`${P}: the card asks for this UTC month so far`, asks.length >= 1 && asks[0].from === first && asks[0].to === today, JSON.stringify(asks));
  const text = await S.card.innerText();
  ok(`${P}: the heading`, /Sales tax lookups/.test(text));
  ok(`${P}: both meters say off`, /Tax verification \(Verify button\): off, so nothing is charged/.test(text) && /Invoice tax check: off, so nothing is charged \(price set: \$0\.10\)/.test(text), text.slice(0, 400));
  const acme = await S.card.locator('[data-tax-usage-row="acme-sheds"]').innerText();
  ok(`${P}: Acme's row: name, switch on, 4 Verify, 5 invoice, 1 failed, 6 charged, $0.60, 1 error`,
    /Acme Sheds/.test(acme) && /\bOn\b/.test(acme) && /\b4\b[\s\S]*\b5\b[\s\S]*\b1\b[\s\S]*\b6\b[\s\S]*\$0\.60/.test(acme), acme);
  const quiet = await S.card.locator('[data-tax-usage-row="quiet-barns"]').innerText();
  ok(`${P}: a builder with lookups off says Off and CRM paperwork`, /\bOff\b/.test(quiet) && /CRM paperwork/.test(quiet), quiet);
  ok(`${P}: the charge-error warning names the replay`, /1 charge failed and was not taken/.test(text) && /tax_charge_retry/.test(text), text);
  ok(`${P}: pings are counted apart`, /Plus 2 credential checks from this console/.test(text));
  ok(`${P}: the tiles add up`, /\$0\.60/.test(text) && /4 Verify · 5 invoice/.test(text));
  const buttons = (await S.card.getByRole("button").allInnerTexts()).map((b) => b.trim());
  ok(`${P}: read-only — the only button is Refresh`, buttons.length === 1 && buttons[0] === "Refresh", JSON.stringify(buttons));
  await S.card.locator('input[type="date"]').first().fill(today.slice(0, 5) + "01-01");
  await S.page.waitForTimeout(400);
  const last = S.calls.filter((c) => c.action === "tax_usage_get").pop();
  ok(`${P}: a new start date asks again with the new range`, last && last.from === today.slice(0, 5) + "01-01" && last.to === today, JSON.stringify(last));
  ok(`${P}: no page errors`, S.pageErrors.length === 0, S.pageErrors.join(" | "));
  await S.ctx.close();
}

// ── b ──
{
  const S = await run({ noBill: true });
  const text = await S.card.innerText();
  ok("b: without can_bill, the server's sentence and no table", /cannot see or change sales tax billing/.test(text) && !(await S.card.locator("table").count()), text);
  ok("b: no page errors", S.pageErrors.length === 0, S.pageErrors.join(" | "));
  await S.ctx.close();
}

// ── c ──
{
  const S = await run({ extra: { chargesUnknown: true } });
  const text = await S.card.innerText();
  ok("c: before 319, the card says charges aren't recorded per lookup yet", /migration 319 isn't applied/.test(text), text);
  await S.ctx.close();
}

await browser.close();
console.log(`${failed().length ? failed().length + " check(s) FAILED" : "all checks held"}`);
process.exit(failed().length ? 1 : 0);
