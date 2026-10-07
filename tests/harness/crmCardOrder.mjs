// Each person's order for the record cards (Settings → My Profile → Record card order), driven for
// real on the COMPILED portal (2026-10-05). Carolyn, 2026-08-28 @39:00: "they can put their cards
// in the order that they want them, and they can have a different order under a contact, and a
// different order under a deal."
//
//   A. a contact record draws its cards in the saved contact order (the cards that aren't showing,
//      like Sales tax with no deal picked, simply skipped), and a deal record in the saved deal
//      order, Sales tax included where it was put
//   B. with nothing saved, both records keep the usual order
//   C. view-as: the operator sees the usual order, never the order in the prefs the shell holds
//   D. My Profile lists both kinds in the saved order, every card a kind can show (Sales tax with
//      its note); ▲ moves a card at once and save_prefs carries the FULL list for that kind, the
//      other kind as it was, and the person's other preferences (emailSignature, designsView);
//      the screen says "Saved."; and the record opened afterwards in the same tab uses the new order
//   E. a run of presses while the server is slow: one save at a time, and the last one carries
//      the last arrangement; the Pipeline default switched in the middle of a run is still in the
//      run's last save (E6-E7)
//   F. Reset to default saves without that kind, keeps the other, and the list goes back to the
//      usual order
//   G. a server that drops cardOrder still answers ok: the screen says so instead of "Saved.", and
//      the list shows what was kept
//   H. by keyboard: Enter on a ▲ moves the card and focus stays on that ▲, at the top too, where
//      another Enter does nothing and saves nothing
//   I. at 390px the card fits and adds no sideways scroll; screenshots at 1440 and 390
//   Z. no page errors, and nothing on these screens sends an email or a text
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the stub shape
// is crmQuickSends.mjs's and replyToCard.mjs's. save_prefs is answered with the server's own
// cardOrder rule (both kinds, strings only, at most 40), so what the page reads back is what the
// real whitelist would keep.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/crmCardOrder.mjs             (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/crm-card-order (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an
// older portal.app.compiled.js> serves that file instead, which is how to prove the checks can
// fail: against the artifact before this change, A1 and A3 fail (the records ignore the saved
// order) and the run stops at D0 (My Profile has no card).
//
// Fixtures are obviously fake (example.test, 555 numbers, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "acme-sheds";
const VIEWED = "demo-builder";
const CONTACT_ID = "00000000-0000-4000-8000-0000000000c2";
const CODE = "SS-CARD0001";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000004", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER_ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders",
  "change_order_approve", "build_schedule", "delivery_schedule", "repairs", "commissions", "reports", "phone",
  "settings_structures", "settings_options", "settings_branding", "settings_crm", "settings_quickbooks",
  "settings_email", "settings_team", "settings_billing"].map((k) => [k, "edit"]));

// A StructureStudio quote, so the deal record shows its Sales tax card.
const DESIGN = {
  short_code: CODE, created_at: "2026-09-17T15:00:00Z", updated_at: "2026-09-17T15:00:00Z",
  status: "sent", selections: { style: "Utility", size: "10x12" }, expected_close_date: null,
  total_cents: 512300, ghl_estimate_number: null, image_url: null, ss_quote_number: "SSQ-2001",
  ss_quote_pdf_url: null, ss_invoice_sent_at: null, ss_invoice_requested_at: null,
  contact_id: CONTACT_ID, contact: { name: "Alex Tester", phone: "(555) 555-0142", email: "alex@example.test" },
};
const LIST_ROW = {
  short_code: CODE, created_at: DESIGN.created_at, updated_at: DESIGN.updated_at, status: "sent",
  contact: DESIGN.contact, sel_style: "utility", sel_size: "10x12", ghl_estimate_number: null, contact_id: CONTACT_ID,
};
const CONTACT = { id: CONTACT_ID, name: "Alex Tester", phone: "(555) 555-0142", email: "alex@example.test", phone_digits: "5555550142", owner_user_id: null, sms_opt_out_at: null, first_seen_at: "2026-09-01T12:00:00Z" };

// The registry (CRM_SECTIONS), per kind, as My Profile lists it.
const CONTACT_KEYS = ["summary", "details", "deals", "orders", "tax", "build", "delivery", "repairs", "overview"];
const DESIGN_KEYS = ["summary", "details", "person", "tax", "build", "delivery", "repairs", "overview"];
const TITLES = { summary: "Summary", details: "Details", deals: "Deals", orders: "Orders", person: "Person", tax: "Sales tax",
  build: "Build schedule", delivery: "Delivery schedule", repairs: "Repairs", overview: "Overview" };
// What shows on the record: no deal picked on the contact, so no Sales tax there.
const CONTACT_SHOWING = CONTACT_KEYS.filter((k) => k !== "tax");
const SAVED_CONTACT = CONTACT_KEYS.slice().reverse();
const SAVED_DESIGN = ["tax", "person", "summary", "details", "build", "delivery", "repairs", "overview"];
const PREFS = { designsView: "pipeline", emailSignature: "Sam\nAcme Sheds", cardOrder: { contact: SAVED_CONTACT, design: SAVED_DESIGN } };

const { ok, failed } = reporter();
const shots = shotsDir("crm-card-order");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SENDS = ["crm_send_email", "crm_send_sms", "email_send_test", "resend_quote_email", "send_invoice", "send_change_order"];

/** save_prefs as portal-settings answers it. `server: "old"` is a build that drops cardOrder. */
function savePrefs(raw, server) {
  const clean = {};
  if (raw.designsView === "list" || raw.designsView === "pipeline") clean.designsView = raw.designsView;
  if (typeof raw.emailSignature === "string" && raw.emailSignature.trim()) clean.emailSignature = raw.emailSignature.trim();
  const order = (raw.cardOrder && typeof raw.cardOrder === "object" && !Array.isArray(raw.cardOrder)) ? raw.cardOrder : null;
  if (order && server !== "old") {
    const co = {};
    for (const k of ["contact", "design"]) {
      if (Array.isArray(order[k])) co[k] = order[k].filter((s) => typeof s === "string").slice(0, 40).map((s) => s.slice(0, 40));
    }
    if (Object.keys(co).length) clean.cardOrder = co;
  }
  return Object.keys(clean).length ? clean : null;
}

async function scenario(browser, { name, operator = false, prefs = PREFS, server = "new", saveDelay = 0, viewport = { width: 1440, height: 1000 } }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const calls = [];
  const flight = { now: 0, max: 0 };
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, operator);
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/designs")) return json(route, [LIST_ROW]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: body.targetClientId || CLIENT });
    }
    if (url.includes("/operator-portal")) return json(route, { ok: true, clientId: VIEWED, companyName: "Demo Builder", designs: [{ ...LIST_ROW, selections: DESIGN.selections }], versions: [], capturedLeads: [] });
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    const clientId = body.targetClientId || CLIENT;
    switch (body.action) {
      case "status":
        // The prefs come back in view-as too, so C proves the RECORD ignores them there, not that
        // they happened to be missing.
        return json(route, { ok: true, clientId, role: "owner", operatorMode: !!body.targetClientId, access: OWNER_ACCESS, prefs,
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "crm_record":
        return json(route, {
          ok: true, kind: body.kind, clientId, contact: CONTACT, designs: [DESIGN], orders: [], feed: [], focus: [], team: [], people: [], followers: [],
          sms: { ready: true, from: "+15555550199", optedOut: false, consented: true },
          build: [], stages: [], delivery: [], repairs: [],
        });
      case "save_prefs": {
        flight.now++; flight.max = Math.max(flight.max, flight.now);
        if (saveDelay) await new Promise((r) => setTimeout(r, saveDelay));
        flight.now--;
        return json(route, { ok: true, prefs: savePrefs(body.prefs || {}, server) });
      }
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  if (process.env.SS_PORTAL_ARTIFACT) {
    const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
    await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
  }
  const q = operator ? `?view=${VIEWED}` : "";
  await page.goto(`${BASE}/portal.html${q}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  const go = async (path) => {
    await page.evaluate((p) => { history.pushState({}, "", p + window.location.search); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
    await page.waitForTimeout(800);
  };
  return { ctx, page, calls, flight, go };
}

const tap = (loc) => loc.click({ timeout: 5000 }).then(() => true, () => false);
const saves = (s) => s.calls.filter((c) => c.action === "save_prefs");
const lastSave = (s) => { const v = saves(s); return (v[v.length - 1] || {}).prefs || {}; };

/** The record's section cards, top to bottom: { keys, titles }. A build without the
 *  data-ss-crm-section tags (SS_PORTAL_ARTIFACT) is read off the cards' uppercase titles instead,
 *  so the order checks run, and fail, against it rather than stopping at "no cards". */
async function openRecord(s, path) {
  await s.go(path);
  await s.page.waitForFunction(() => document.querySelectorAll("[data-ss-crm-section]").length > 0
    || /OVERVIEW/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  await s.page.waitForTimeout(300);
  return s.page.evaluate((titles) => {
    const tagged = [...document.querySelectorAll("[data-ss-crm-section]")];
    if (tagged.length) {
      return { keys: tagged.map((c) => c.getAttribute("data-ss-crm-section")), titles: tagged.map((c) => (c.firstElementChild || {}).textContent || "") };
    }
    const byTitle = Object.fromEntries(Object.entries(titles).map(([k, t]) => [t, k]));
    const heads = [...document.querySelectorAll("div")].filter((d) => !d.children.length && byTitle[d.textContent]
      && getComputedStyle(d).textTransform === "uppercase");
    return { keys: heads.map((d) => byTitle[d.textContent]), titles: heads.map((d) => d.textContent) };
  }, TITLES);
}
const contactPath = `/portal/contacts/c-${CONTACT_ID}`;
const designPath = `/portal/designs/d-${CODE}`;

async function openProfile(s) {
  await s.go("/portal/settings/myprofile");
  await s.page.waitForFunction(() => !!document.querySelector('[data-ss-card-order="contact"]'), null, { timeout: 20000 }).catch(() => {});
  await s.page.waitForTimeout(300);
}
const listKeys = (page, kind) => page.evaluate((k) =>
  [...document.querySelectorAll(`[data-ss-card-order="${k}"] [data-ss-card-order-row]`)].map((r) => r.getAttribute("data-ss-card-order-row")), kind);
const arrow = (page, kind, title, word) => page.locator(`[data-ss-card-order="${kind}"] button[aria-label="Move ${title} ${word}"]`);
const orderCard = (page) => page.locator("div").filter({ has: page.locator("div", { hasText: /^Record card order$/ }) }).last();
const cardText = (page) => orderCard(page).innerText({ timeout: 3000 }).catch(() => "");
const settle = (page) => page.waitForFunction(() => !/Saving…/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});

const { browser } = await launch({ width: 1440, height: 1000 });
try {
  // ── A, D. The owner on their own account, with an order saved ───────────────────────────────
  {
    const s = await scenario(browser, { name: "main" });
    const rec = await openRecord(s, contactPath);
    const rendered = ok("A0 the contact record rendered its cards", rec.keys.length > 0, JSON.stringify(rec.keys));
    if (!rendered) throw new Error("the contact record never rendered; refusing to report the rest as passes");
    ok("A1 the contact record's cards are in the saved contact order (Sales tax, not showing, skipped)",
      same(rec.keys, SAVED_CONTACT.filter((k) => k !== "tax")), JSON.stringify(rec.keys));
    ok("A2 the titles on screen follow the same order", same(rec.titles, rec.keys.map((k) => TITLES[k])), JSON.stringify(rec.titles));
    await s.page.screenshot({ path: join(shots, "A-contact-1440.png"), fullPage: true });

    const deal = await openRecord(s, designPath);
    ok("A3 the deal record's cards are in the saved deal order, Sales tax first where it was put",
      same(deal.keys, SAVED_DESIGN), JSON.stringify(deal.keys));
    await s.page.screenshot({ path: join(shots, "A-deal-1440.png"), fullPage: true });

    // ── D. My Profile ──
    await openProfile(s);
    const hasCard = ok("D0 My Profile shows the Record card order card", (await orderCard(s.page).count()) > 0 && /On a contact/.test(await cardText(s.page)) && /On a deal/.test(await cardText(s.page)));
    if (!hasCard) throw new Error("My Profile has no Record card order card; refusing to report the rest as passes");
    ok("D1 both lists hold every card the kind can show, in the saved order",
      same(await listKeys(s.page, "contact"), SAVED_CONTACT) && same(await listKeys(s.page, "design"), SAVED_DESIGN),
      JSON.stringify({ contact: await listKeys(s.page, "contact"), design: await listKeys(s.page, "design") }));
    ok("D2 Sales tax says when it shows", /Shows for a deal with a StructureStudio estimate/.test(await cardText(s.page)));
    await orderCard(s.page).scrollIntoViewIfNeeded().catch(() => {});
    await s.page.screenshot({ path: join(shots, "D-profile-1440.png") });

    const before = saves(s).length;
    await tap(arrow(s.page, "contact", "Summary", "up"));
    const moved = await listKeys(s.page, "contact");
    const WANT = ["overview", "repairs", "delivery", "build", "tax", "orders", "deals", "summary", "details"];
    ok("D3 ▲ moves the card at once", same(moved, WANT), JSON.stringify(moved));
    await settle(s.page);
    const sent = lastSave(s);
    ok("D4 save_prefs is posted once, with the FULL contact list in the new order", saves(s).length === before + 1 && sent.cardOrder && same(sent.cardOrder.contact, WANT),
      JSON.stringify(sent.cardOrder));
    ok("D5 the deal list rides along as it was", sent.cardOrder && same(sent.cardOrder.design, SAVED_DESIGN), JSON.stringify(sent.cardOrder));
    ok("D6 and so do the person's other preferences", sent.emailSignature === "Sam\nAcme Sheds" && sent.designsView === "pipeline", JSON.stringify(sent));
    ok("D7 the screen says Saved.", /(^|\n)Saved\.(\n|$)/.test(await cardText(s.page)), (await cardText(s.page)).split("\n").pop());
    await orderCard(s.page).screenshot({ path: join(shots, "D-saved.png") }).catch(() => {});

    const after = await openRecord(s, contactPath);
    ok("D8 the contact record opened afterwards in the same tab uses the new order",
      same(after.keys, WANT.filter((k) => k !== "tax")), JSON.stringify(after.keys));
    ok("Z1 nothing here sent an email or a text", SENDS.every((a) => s.calls.every((c) => c.action !== a)), JSON.stringify(s.calls.map((c) => c.action)));
    await s.ctx.close();
  }

  // ── B. Nothing saved: the usual order ────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "no-order", prefs: { designsView: "list" } });
    const rec = await openRecord(s, contactPath);
    ok("B1 with nothing saved, the contact record keeps the usual order", same(rec.keys, CONTACT_SHOWING), JSON.stringify(rec.keys));
    const deal = await openRecord(s, designPath);
    ok("B2 and so does the deal record", same(deal.keys, DESIGN_KEYS), JSON.stringify(deal.keys));
    await openProfile(s);
    ok("B3 My Profile lists the usual order", same(await listKeys(s.page, "contact"), CONTACT_KEYS) && same(await listKeys(s.page, "design"), DESIGN_KEYS));
    // F. Reset with nothing saved is a no-op, not a save.
    const n = saves(s).length;
    await tap(s.page.locator('[data-ss-card-order="design"] button', { hasText: "Reset to default" }));
    await s.page.waitForTimeout(400);
    ok("F0 Reset to default with nothing saved saves nothing", saves(s).length === n);
    await s.ctx.close();
  }

  // ── C. View-as: the operator sees the usual order ────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "view-as", operator: true });
    const rec = await openRecord(s, contactPath);
    const viewed = s.calls.find((c) => c.action === "crm_record");
    ok("C0 (it is the VIEWED builder's record)", !!viewed && viewed.targetClientId === VIEWED, JSON.stringify(viewed));
    ok("C1 in view-as the record keeps the usual order, whatever prefs the shell holds", same(rec.keys, CONTACT_SHOWING), JSON.stringify(rec.keys));
    await s.page.screenshot({ path: join(shots, "C-view-as.png") });
    await s.ctx.close();
  }

  // ── E. A run of presses against a slow server ────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "slow", saveDelay: 900 });
    await openProfile(s);
    // Overview is first in the saved contact list; three ▼ in a row.
    for (let i = 0; i < 3; i++) { await tap(arrow(s.page, "contact", "Overview", "down")); await s.page.waitForTimeout(60); }
    const shown = await listKeys(s.page, "contact");
    const WANT = ["repairs", "delivery", "build", "overview", "tax", "orders", "deals", "details", "summary"];
    ok("E1 three presses move the card three places on screen straight away", same(shown, WANT), JSON.stringify(shown));
    ok("E2 the card says it is saving", /Saving…/.test(await cardText(s.page)));
    await settle(s.page);
    const sv = saves(s);
    ok("E3 one save at a time", s.flight.max === 1, `max in flight ${s.flight.max}`);
    ok("E4 fewer saves than presses, and the last carries the last arrangement",
      sv.length >= 1 && sv.length < 3 && same(lastSave(s).cardOrder && lastSave(s).cardOrder.contact, WANT), JSON.stringify(sv.map((x) => x.prefs.cardOrder.contact)));
    ok("E5 then Saved.", /(^|\n)Saved\.(\n|$)/.test(await cardText(s.page)));

    // ── F. Reset the deal list ──
    await tap(s.page.locator('[data-ss-card-order="design"] button', { hasText: "Reset to default" }));
    ok("F1 Reset to default puts the deal list back at once", same(await listKeys(s.page, "design"), DESIGN_KEYS), JSON.stringify(await listKeys(s.page, "design")));
    await settle(s.page);
    const r = lastSave(s);
    ok("F2 and saves without a deal order, the contact order kept", !!r.cardOrder && !("design" in r.cardOrder) && same(r.cardOrder.contact, WANT), JSON.stringify(r.cardOrder));
    await s.ctx.close();
  }

  // ── E6. Another card saved in the middle of a run (review 2026-10-05) ────────────────────────
  // The queued order save used to send the prefs from the render the run started in, so the
  // Pipeline default switched mid-run went back to the old one on the server while its card said
  // "Saved.". Every save here takes the same 900 ms, so the last one sent is the last one to land.
  {
    const s = await scenario(browser, { name: "slow-mixed", saveDelay: 900 });
    await openProfile(s);
    for (let i = 0; i < 2; i++) { await tap(arrow(s.page, "contact", "Overview", "down")); await s.page.waitForTimeout(60); }
    // The first order save is out and the second is queued: switch the Pipeline default now.
    await tap(s.page.getByRole("button", { name: "List", exact: true }));
    await settle(s.page);
    await s.page.waitForTimeout(1500);
    const WANT2 = ["repairs", "delivery", "overview", "build", "tax", "orders", "deals", "details", "summary"];
    const sv = saves(s).map((x) => x.prefs);
    const last = sv[sv.length - 1] || {};
    ok("E6 a Pipeline default saved mid-run rides along: the run's last save still says List",
      sv.length >= 3 && last.designsView === "list" && same(last.cardOrder && last.cardOrder.contact, WANT2),
      JSON.stringify(sv.map((p) => [p.designsView, p.cardOrder && p.cardOrder.contact && p.cardOrder.contact.slice(0, 3)])));
    ok("E7 and the person's other preferences with it", last.emailSignature === "Sam\nAcme Sheds" && same(last.cardOrder && last.cardOrder.design, SAVED_DESIGN), JSON.stringify(last));
    await s.ctx.close();
  }

  // ── G. A server that drops cardOrder ─────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "old-server", server: "old", prefs: { designsView: "list", emailSignature: "Sam" } });
    await openProfile(s);
    await tap(arrow(s.page, "contact", "Overview", "up"));
    await settle(s.page);
    const t = await cardText(s.page);
    ok("G1 the screen says the order wasn't kept, not \"Saved.\"",
      t.includes("Saved, but this server build didn't keep the order") && !/(^|\n)Saved\.(\n|$)/.test(t), t.split("\n").pop());
    ok("G2 and the list shows what was kept (the usual order)", same(await listKeys(s.page, "contact"), CONTACT_KEYS), JSON.stringify(await listKeys(s.page, "contact")));
    await s.ctx.close();
  }

  // ── H. By keyboard ───────────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "keyboard", prefs: { designsView: "list" } });
    await openProfile(s);
    // Details is second in the usual deal list: one Enter takes it to the top.
    await arrow(s.page, "design", "Details", "up").focus();
    await s.page.keyboard.press("Enter");
    await settle(s.page);
    const focused = () => s.page.evaluate(() => (document.activeElement && document.activeElement.getAttribute("aria-label")) || null);
    ok("H1 Enter on ▲ moves the card", (await listKeys(s.page, "design"))[0] === "details", JSON.stringify(await listKeys(s.page, "design")));
    ok("H2 and focus stays on that ▲, now at the top", (await focused()) === "Move Details up", await focused());
    const n = saves(s).length;
    await s.page.keyboard.press("Enter");
    await s.page.waitForTimeout(500);
    ok("H3 another Enter at the top does nothing and saves nothing", (await listKeys(s.page, "design"))[0] === "details" && saves(s).length === n);
    ok("H4 focus still there", (await focused()) === "Move Details up", await focused());
    await s.ctx.close();
  }

  // ── I. A phone's width ───────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "narrow", viewport: { width: 390, height: 844 } });
    await openProfile(s);
    const before = await s.page.evaluate(() => document.documentElement.scrollWidth);
    await orderCard(s.page).scrollIntoViewIfNeeded().catch(() => {});
    const fit = await s.page.evaluate(() => {
      const h = [...document.querySelectorAll("div")].find((d) => d.textContent === "Record card order");
      const c = h && h.parentElement;
      if (!c) return null;
      const r = c.getBoundingClientRect();
      const arrows = [...c.querySelectorAll("button[aria-label^='Move ']")].map((b) => b.getBoundingClientRect().right);
      return { right: r.right, arrowsRight: Math.max(...arrows), vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth };
    });
    ok("I1 at 390px the card and every arrow fit, and add no sideways scroll",
      !!fit && fit.right <= fit.vw && fit.arrowsRight <= fit.vw && fit.sw <= Math.max(before, fit.vw), JSON.stringify({ ...fit, before }));
    await s.page.screenshot({ path: join(shots, "I-profile-390.png") });
    await orderCard(s.page).screenshot({ path: join(shots, "I-card-390.png") }).catch(() => {});
    const rec = await openRecord(s, contactPath);
    ok("I2 at 390px the contact record still draws the saved order", same(rec.keys, SAVED_CONTACT.filter((k) => k !== "tax")), JSON.stringify(rec.keys));
    await s.page.screenshot({ path: join(shots, "I-contact-390.png"), fullPage: true });
    await s.ctx.close();
  }

  ok("Z2 no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\ncrmCardOrder: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
