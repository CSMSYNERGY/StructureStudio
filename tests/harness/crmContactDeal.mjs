// The contact record's deal rows, driven for real on the COMPILED portal (2026-09-20).
//
// Ahsan: "remove this own record arrow in there i want every thing in the contact page." Each
// deal row carried a third button titled "Open this deal's own record" that navigated away, and
// two things were reachable ONLY from the page it went to. This proves the button is gone and
// that nothing left with it.
//
//   A. a deal row carries exactly TWO buttons — the row itself and the ▸ expander — and nothing
//      anywhere on the page is titled "Open this deal's own record"
//   B. the ▸ expander opens the detail panel IN PLACE: the fields appear and the path does not move
//   C. with NO deal picked, the Invoice tab is absent. Unchanged by this work — a tab that files
//      against one deal stays shut until somebody says which one (the 2026-09-02 picker rule)
//   D. picking the deal brings the Invoice tab ONTO THE CONTACT PAGE, enabled. This is the half
//      that used to require the arrow, and it is the check that would have caught a plain delete
//   E. the Invoices history chip is on the contact page too — the other half
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the stub
// skeleton, the pushState navigation and the shots directory are all crmRecordSkeleton.mjs's.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/crmContactDeal.mjs          (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/crm-contact-deal (SS_SHOTS overrides).
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how to
// prove these checks can fail: against the artifact committed before this change A fails on the
// third button and D/E fail, because the tab and the chip are still gated on `kind === "design"`.
//
// ⚠️ EVERY CHECK IS GUARDED BY "the deal row rendered". An earlier draft of this file reported
// PASS on A and C while the page had not rendered at all — nothing to find is not the same as
// nothing there, and a harness that cannot tell the two apart is worse than no harness.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "harness-crm-deal";
const CODE = "SS-DEAL0001A";
const CONTACT_ID = "4512ed87-fb75-4645-81d6-9268eb73e305";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// ACCEPTED on purpose: that is the Invoice tab's own `enabled` condition, so a `sent` deal would
// let D pass for the wrong reason — offered, but greyed.
const DESIGN = {
  short_code: CODE, created_at: "2026-09-17T15:00:00Z", updated_at: "2026-09-17T15:00:00Z",
  status: "accepted", selections: { style: "Utility", size: "12x16" }, expected_close_date: null,
  total_cents: 812300, ghl_estimate_number: null, image_url: null, ss_quote_number: "SSQ-1041",
  ss_quote_pdf_url: null, ss_invoice_sent_at: null, ss_invoice_requested_at: null,
  contact_id: CONTACT_ID, contact: { name: "Pat Tester", phone: "+15125550142", email: "pat@example.test" },
};
const CONTACT = { id: CONTACT_ID, name: "Pat Tester", phone: "+15125550142", email: "pat@example.test", phone_digits: "15125550142", owner_user_id: null, sms_opt_out_at: null };

const { ok, failed } = reporter();
const shots = shotsDir("crm-contact-deal");
const { browser, ctx } = await launch({ width: 1400, height: 1000 });
await ctx.addInitScript(([ref, s]) => {
  try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
}, [REF, SESSION]);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  if (url.includes("/rest/v1/rpc/log_error")) return json(route, null);
  if (url.includes("/rest/v1/rpc/")) return json(route, false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
  if (url.includes("/rest/v1/")) {
    const table = (url.match(/\/rest\/v1\/([a-z_]+)/) || [])[1];
    const single = /vnd\.pgrst\.object/.test(req.headers()["accept"] || "");
    if (table === "designs") return single ? json(route, DESIGN) : json(route, [DESIGN]);
    return json(route, []);
  }
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null });
  }
  if (!url.includes("/portal-settings")) return json(route, { ok: true });
  switch (body.action) {
    case "status":
      return json(route, { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, invoiceInGhl: false,
        ghlInvoicingAllowed: false, ssQuoteNext: 1042, ssInvoiceNext: 2001, ssTaxRate: 6.5, ssTaxLabel: "Sales tax", businessAddress: {}, branding: {}, emailReady: true });
    case "crm_record":
      return json(route, {
        ok: true, kind: body.kind, clientId: CLIENT, contact: CONTACT, designs: [DESIGN],
        orders: [], feed: [], focus: [], team: [], people: [], followers: [],
        sms: { ready: false, from: null, optedOut: false, consented: false },
        build: [], stages: [], delivery: [], repairs: [], isDesign: body.kind === "design",
      });
    case "crm_contacts": return json(route, { ok: true, contacts: [CONTACT] });
    case "list_locations": return json(route, { ok: true, nextSerial: 100, locations: [] });
    case "tax_settings": return json(route, { ok: true, ssMode: true, lookupEnabled: false, configured: false, companyRatePct: 6.5, companyLabel: "Sales tax", dailyCap: 100, usage24h: 0, locations: [] });
    default: return json(route, { ok: true });
  }
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
if (process.env.SS_PORTAL_ARTIFACT) {
  const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
  await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
}

const go = async (path) => {
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
  await page.waitForTimeout(1200);
};
// Buttons by visible text, trimmed — the tab strip and the history chips are both <button>.
const buttonTexts = () => page.evaluate(() =>
  [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()));
// The deal row's siblings: the row button's PARENT is the bordered box holding every button
// for that one deal, which is the thing the arrow used to be a third member of.
const dealRowButtons = () => page.evaluate(() => {
  const row = [...document.querySelectorAll("button")].find((b) => /Utility 12x16/.test(b.innerText || ""));
  if (!row || !row.parentElement) return null;
  return [...row.parentElement.querySelectorAll(":scope > button")]
    .map((b) => ({ title: b.getAttribute("title") || "", text: (b.innerText || "").trim().slice(0, 30) }));
});

try {
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);

  await go(`/portal/contacts/c-${CONTACT_ID}`);
  await page.waitForFunction(() => document.body.innerText.includes("SUMMARY"), null, { timeout: 20000 });
  await page.waitForTimeout(500);

  // THE GUARD. Everything below is only meaningful if the deal actually drew.
  const rows = await dealRowButtons();
  const rendered = ok("the deal row rendered on the contact page", !!rows,
    rows ? `${rows.length} buttons` : "no row found — every check below would be vacuous");
  if (!rendered) throw new Error("deal row never rendered; refusing to report the rest as passes");

  await page.screenshot({ path: join(shots, "contact-deal-row.png") });

  // ── A. the arrow is gone ──────────────────────────────────────────────────────────────
  const ownRecord = await page.locator('[title="Open this deal\'s own record"]').count();
  ok("A1 nothing is titled \"Open this deal's own record\"", ownRecord === 0, `${ownRecord} found`);
  ok("A2 the deal row has exactly two buttons (row + expander)", rows.length === 2, JSON.stringify(rows));
  ok("A3 neither of them leaves the record", rows.every((b) => !/own record/i.test(b.title)), JSON.stringify(rows.map((b) => b.title)));

  // ── B. the expander still opens, in place ─────────────────────────────────────────────
  const pathBefore = await page.evaluate(() => location.pathname);
  await page.locator("button[aria-expanded]").first().click();
  await page.waitForTimeout(700);
  const opened = await page.evaluate(() => document.body.innerText.includes("EXPECTED CLOSE"));
  ok("B1 the ▸ expander opens the detail panel", opened);
  ok("B2 and the path did not move", (await page.evaluate(() => location.pathname)) === pathBefore, pathBefore);

  // ── C. nothing picked yet ─────────────────────────────────────────────────────────────
  const unpicked = await buttonTexts();
  ok("C1 with no deal picked, no Invoice tab", !unpicked.includes("Invoice"),
    JSON.stringify(unpicked.filter((t) => /^invoice/i.test(t))));

  // ── D + E. pick the deal ──────────────────────────────────────────────────────────────
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Utility 12x16/.test(x.innerText || ""));
    if (b) b.click();
  });
  await page.waitForTimeout(900);
  const picked = await buttonTexts();
  await page.screenshot({ path: join(shots, "contact-deal-picked.png") });
  ok("D1 picking the deal brings the Invoice tab onto the CONTACT page", picked.includes("Invoice"),
    JSON.stringify(picked.slice(0, 20)));
  const invoiceEnabled = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").trim() === "Invoice");
    return b ? !b.disabled : null;
  });
  ok("D2 and it is enabled — owner, and the deal is accepted", invoiceEnabled === true, `enabled=${invoiceEnabled}`);
  // The chip carries its own count — "Invoices (0)" — so this matches the prefix. Matching the
  // bare word fails against the real DOM, and the tab is an exact "Invoice", so the two cannot
  // be confused by a prefix test that anchors on the plural.
  ok("E1 the Invoices history chip is on the contact page", picked.some((t) => /^Invoices\b/.test(t)),
    JSON.stringify(picked.filter((t) => /^invoice/i.test(t))));

  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\ncrmContactDeal: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
