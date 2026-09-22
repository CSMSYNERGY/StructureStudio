// The CRM record page's loading state, driven for real on the COMPILED portal.
//
// Ahsan, 2026-09-20, opening a contact and a deal: "it takes too much time to open this …
// add the skeleton card in here also." The page used to answer with the word "Loading…" on
// one empty card; it now answers with CrmRecordSkeleton. The whole point of that change is
// visible for exactly as long as crm_record is in flight, which is why this harness HOLDS
// the reply open rather than racing it — a screenshot taken after the data lands proves
// nothing about the state it replaced.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine), the same
// shape quoteSalesTax.mjs uses.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/crmRecordSkeleton.mjs       (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/crm-skeleton (SS_SHOTS overrides).
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how
// to prove these checks can fail: against the pre-change artifact every skeleton check fails
// and the "no Loading… word" check fails with it.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "harness-crm-skel";
const CODE = "SS-SKEL0001A";
const CONTACT_ID = "4512ed87-fb75-4645-81d6-9268eb73e305";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

const DESIGN = {
  short_code: CODE, created_at: "2026-09-18T15:00:00Z", updated_at: "2026-09-18T15:00:00Z",
  status: "sent", selections: { style: "Urban", size: "12x24" }, expected_close_date: null,
  total_cents: 965250, ghl_estimate_number: null, image_url: null, ss_quote_number: null,
  ss_quote_pdf_url: null, ss_invoice_sent_at: null, ss_invoice_requested_at: null,
  contact_id: CONTACT_ID, contact: { name: "Pat Tester", phone: "+15125550142", email: "pat@example.test" },
};
const CONTACT = { id: CONTACT_ID, name: "Pat Tester", phone: "+15125550142", email: "pat@example.test", phone_digits: "15125550142", owner_user_id: null, sms_opt_out_at: null };

// THE GATE. Every crm_record reply waits on this, so the skeleton is on screen for as long
// as the script wants it there — which is what makes a screenshot of it honest.
let release = null;
const held = () => new Promise((r) => { release = r; });
let gate = held();

const { ok, failed } = reporter();
const shots = shotsDir("crm-skeleton");
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
    case "crm_record": {
      await gate;
      const isDesign = body.kind === "design";
      return json(route, {
        ok: true, kind: body.kind, clientId: CLIENT, contact: CONTACT, designs: [DESIGN],
        orders: [], feed: [], focus: [], team: [], people: [], followers: [],
        sms: { ready: false, from: null, optedOut: false, consented: false },
        build: [], stages: [], delivery: [], repairs: [], isDesign,
      });
    }
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
  await page.waitForTimeout(900);
};
const bodyText = () => page.evaluate(() => document.body.innerText);
// The skeleton's own vocabulary, read off the DOM rather than off a screenshot: grey blocks
// carry SkelBar's #E2E8F0, and a chevron is the only thing on this page wearing a clip-path.
const shape = () => page.evaluate(() => {
  const all = [...document.querySelectorAll("div")];
  const grey = all.filter((d) => d.style.background === "rgb(226, 232, 240)" || d.style.backgroundColor === "rgb(226, 232, 240)");
  // ⚠️ CHEVRONS ARE COUNTED BY GEOMETRY, NOT BY COLOUR. The real rail's chevrons are ACCENT,
  // its idle ones #F1F5F9, and only the skeleton's are SkelBar grey — so a colour-keyed count
  // reads the loaded page as having no rail at all. That is what this line got wrong first.
  const chev = all.filter((d) => (d.style.clipPath || "").includes("polygon"));
  return {
    grey: grey.length,
    chevrons: chev.length,
    greyChevrons: chev.filter((d) => grey.includes(d)).length,
    backs: [...document.querySelectorAll("button")].filter((b) => b.innerText.trim() === "Back" && !b.disabled).length,
  };
});

try {
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);

  // ── A. A DEAL, while crm_record is still in flight ────────────────────────────────────
  await go(`/portal/designs/d-${CODE}`);
  const aText = await bodyText();
  const a = await shape();
  await page.screenshot({ path: join(shots, "design-skeleton.png") });
  ok("A1 deal: the word Loading is gone", !/Loading/.test(aText), aText.slice(0, 80).replace(/\s+/g, " "));
  ok("A2 deal: grey blocks are on screen", a.grey >= 20, `${a.grey} blocks`);
  ok("A3 deal: the chevron rail is drawn, in grey (6 stages)", a.chevrons === 6 && a.greyChevrons === 6, `${a.chevrons} chevrons, ${a.greyChevrons} grey`);
  ok("A4 deal: Back is a real, live button", a.backs === 1, `${a.backs} enabled Back buttons`);

  // ── B. Back WORKS before the data lands ───────────────────────────────────────────────
  await page.locator("button", { hasText: /^Back$/ }).first().click();
  await page.waitForTimeout(700);
  const leftIt = await page.evaluate(() => !location.pathname.includes("/d-"));
  ok("B1 Back leaves the record while it is still loading", leftIt, await page.evaluate(() => location.pathname));

  // ── C. A CONTACT, same held reply ─────────────────────────────────────────────────────
  await go(`/portal/contacts/c-${CONTACT_ID}`);
  const cText = await bodyText();
  const c = await shape();
  await page.screenshot({ path: join(shots, "contact-skeleton.png") });
  ok("C1 contact: the word Loading is gone", !/Loading/.test(cText), cText.slice(0, 80).replace(/\s+/g, " "));
  ok("C2 contact: grey blocks are on screen", c.grey >= 20, `${c.grey} blocks`);
  // Nothing is picked on a contact's first paint, so the real page draws NO rail. Claiming
  // one would promise a ladder that never arrives.
  ok("C3 contact: no chevron rail is claimed", c.chevrons === 0, `${c.chevrons} chevrons`);
  ok("C4 contact: Back is a real, live button", c.backs === 1, `${c.backs} enabled Back buttons`);

  // ── D. Release the reply: the real record replaces the skeleton ────────────────────────
  release();
  const landed = await page.waitForFunction(() => document.body.innerText.includes("SUMMARY"), null, { timeout: 20000 }).then(() => true, () => false);
  await page.waitForTimeout(500);
  const d = await shape();
  await page.screenshot({ path: join(shots, "contact-loaded.png") });
  ok("D1 contact: the real record renders once the reply lands", landed);
  ok("D2 contact: the skeleton's blocks are gone", d.grey <= 2, `${d.grey} blocks left`);

  // ── E. The deal again, this time answered immediately ─────────────────────────────────
  gate = Promise.resolve();
  await go(`/portal/designs/d-${CODE}`);
  const eLanded = await page.waitForFunction(() => document.body.innerText.includes("SUMMARY"), null, { timeout: 20000 }).then(() => true, () => false);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, "design-loaded.png") });
  const e = await shape();
  ok("E1 deal: the real record renders", eLanded);
  ok("E2 deal: the real chevron rail is the one on screen", e.chevrons === 6 && e.greyChevrons === 0, `${e.chevrons} chevrons, ${e.greyChevrons} grey`);

  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.error(`\n${bad.length} check(s) failed`); process.exit(1); }
console.log("\nall checks held");
