// The contact record's SMS box when the customer opted out, driven for real on the COMPILED portal
// (2026-10-13). Asked 2026-10-12: "Can we see if a customer has opted out?" crm_record's
// `sms.optedOut` now also reads the number's sms_opt_outs row, which holds opt-outs the team
// recorded and imports brought in, not only STOPs; `sms.optOutReason` says which, and the box
// says it truly:
//
//   A. stop (or a server without optOutReason): "This customer replied STOP, so we can't text
//      them." as before
//   B. team: "Your team recorded that this customer doesn't want texts, so we can't text them."
//   C. other: "This customer opted out of texts, so we can't text them."
//   every one ends "They can reply START to that same number to opt back in.", and none offers a
//   box to type in; and
//   D. not opted out: no banner, and the box is there.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the stub shape
// is crmQuickSends.mjs's. Nothing is sent.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/crmOptOutBanner.mjs          (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/crm-opt-out (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an older
// portal.app.compiled.js> serves that file instead, which is how to prove the checks can fail:
// against the artifact before this change B and C fail (every opt-out says STOP).
//
// Fixtures are obviously fake (example.test, 555 numbers, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "acme-sheds";
const CONTACT_ID = "00000000-0000-4000-8000-0000000000c1";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER_ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders",
  "change_order_approve", "build_schedule", "delivery_schedule", "repairs", "commissions", "reports", "phone",
  "settings_structures", "settings_options", "settings_branding", "settings_crm", "settings_quickbooks",
  "settings_email", "settings_team", "settings_billing"].map((k) => [k, "edit"]));

// One deal: the SMS tab files against a picked deal (the 2026-09-02 picker rule).
const DESIGN = {
  short_code: "SS-OPTOUT0001", created_at: "2026-09-17T15:00:00Z", updated_at: "2026-09-17T15:00:00Z",
  status: "sent", selections: { style: "Utility", size: "10x12" }, expected_close_date: null,
  total_cents: 512300, ghl_estimate_number: null, image_url: null, ss_quote_number: "SSQ-1001",
  ss_quote_pdf_url: null, ss_invoice_sent_at: null, ss_invoice_requested_at: null,
  contact_id: CONTACT_ID, contact: { name: "Alex Tester", phone: "(555) 555-0142", email: "alex@example.test" },
};
const LIST_ROW = {
  short_code: DESIGN.short_code, created_at: DESIGN.created_at, updated_at: DESIGN.updated_at, status: "sent",
  contact: DESIGN.contact, sel_style: "utility", sel_size: "10x12", ghl_estimate_number: null, contact_id: CONTACT_ID,
};
const CONTACT = { id: CONTACT_ID, name: "Alex Tester", phone: "(555) 555-0142", email: "alex@example.test", phone_digits: "5555550142", owner_user_id: null, sms_opt_out_at: null, first_seen_at: "2026-09-01T12:00:00Z" };

const START = "They can reply START to that same number to opt back in.";
const SAYS = {
  stop: "This customer replied STOP, so we can’t text them.",
  team: "Your team recorded that this customer doesn’t want texts, so we can’t text them.",
  other: "This customer opted out of texts, so we can’t text them.",
};

const { ok, failed } = reporter();
const shots = shotsDir("crm-opt-out");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

/** One fresh browser context per scenario, its crm_record answering with this `sms`. */
async function scenario(browser, name, sms) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/designs")) return json(route, [LIST_ROW]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER_ACCESS, prefs: null,
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "crm_record":
        return json(route, {
          ok: true, kind: body.kind, clientId: CLIENT, contact: CONTACT, designs: [DESIGN], orders: [], feed: [], focus: [], team: [], people: [], followers: [],
          sms, build: [], stages: [], delivery: [], repairs: [],
        });
      case "quick_sends_list": return json(route, { ok: true, quick_sends: [], my_name: "Jordan Lee" });
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  if (process.env.SS_PORTAL_ARTIFACT) {
    const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
    await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
  }
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/portal/contacts/c-${CONTACT_ID}`);
  await page.waitForFunction(() => document.body.innerText.includes("SUMMARY"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
  // Pick the deal, then the SMS tab.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Utility 10x12/.test(x.innerText || ""));
    if (b) b.click();
  });
  await page.waitForTimeout(400);
  await page.locator("button").filter({ hasText: /^SMS$/ }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, `${name}.png`) });
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const box = await page.locator('textarea[placeholder="Text this customer…"]').count();
  await ctx.close();
  return { text, box };
}

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  const base = { ready: true, from: "+15555550199", consented: false };
  for (const [label, reason, want] of [
    ["A stop", "stop", SAYS.stop],
    ["A' a server without optOutReason", undefined, SAYS.stop],
    ["B team", "team", SAYS.team],
    ["C other", "other", SAYS.other],
  ]) {
    const { text, box } = await scenario(browser, label.split(" ")[0].replace("'", "-old"), { ...base, optedOut: true, ...(reason ? { optOutReason: reason } : {}) });
    ok(`${label}: says why`, text.includes(`${want} ${START}`), (text.match(/[^.]*can’t text them[^.]*\.[^.]*\./) || [""])[0]);
    ok(`${label}: and nothing else's reason`, Object.values(SAYS).filter((s) => s !== want).every((s) => !text.includes(s)));
    ok(`${label}: no box to type in`, box === 0, `${box} boxes`);
  }
  const { text, box } = await scenario(browser, "D", { ...base, optedOut: false, optOutReason: null, consented: true });
  ok("D not opted out: no banner", Object.values(SAYS).every((s) => !text.includes(s)) && !text.includes(START));
  ok("D not opted out: the box is there", box === 1, `${box} boxes`);
  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.error(`\n${bad.length} check(s) failed`); process.exit(1); }
console.log("\nall checks held");
