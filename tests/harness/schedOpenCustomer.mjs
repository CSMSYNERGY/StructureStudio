// A Build or Delivery Schedule row opens its CUSTOMER, driven for real on the COMPILED portal
// (2026-10-05). Carolyn, 2026-08-28 @39:00: "when I click this card here, it does the same thing as
// when I'm here, and I click the [contact] ... I think we'll do the same kind of structure from
// both the build schedule and the delivery schedule." Then: "We have a back button here. What
// happens when I hit the back button up here? I want to make sure that ... they function the
// same way."
//
//   A. Build Schedule, an owner with the CRM: a card click still opens the job popup; the
//      customer's name in its header is a link ("Alex Tester ›"); it lands on
//      /portal/contacts/c-<id> with that deal already picked (no "Pick a deal" hint); after a hop
//      away (the deal's Open in designer) the browser's Back reopens it on that deal, and the
//      record's own Back still goes to the schedule (B1)
//   B. the record's Back lands on /portal/build-schedule on the SAME week and view it left; the
//      browser's Back does too; from the Table view, Back comes back to the Table view
//   C. a job whose design is gone shows its name as plain text; a spec build has no link
//   D. a job whose design has no customer opens the design's record (/portal/designs/d-<code>)
//   E. unsaved edits in the popup: following the link asks first; "Cancel" stays put
//   F. the same customer opened from Contacts still shows the hint and Backs to Contacts (the
//      schedule's hand-off is spent, and A's "no hint" is not vacuous)
//   G. Delivery Schedule: the order stop and the sold unit's sale stop link, the shop-to-lot haul
//      and the repair stop do not; Loads view and Table view both; Back returns to the view left
//   P. the Pipeline's hand-off survives the same hop: a row opens the customer on its deal, and
//      Open in designer then the browser's Back reopens it on that deal
//   H. who gets what: a crew leader (designs, no contacts) lands on the design record; an office
//      staffer who can only VIEW the board still gets the link; a crew member gets none; an
//      account without the CRM gets the design record
//   I. at 390px the popup and the link fit, and the page doesn't scroll sideways; shots at
//      1440 and 390
//   Z. no page errors, and nothing here writes to the schedule or sends anything
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the stub shape
// is crmInbox.mjs's. portal-schedule's build_board / loads / pool are answered from fixed rows
// carrying customer_link the way the server now does.
//
//   python -m http.server 8148 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8148 node tests/harness/schedOpenCustomer.mjs   (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/sched-open-customer (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an
// older portal.app.compiled.js> serves that file instead, which is how to prove the checks can
// fail: against the artifact before this change the run stops at A2 (no link in the popup).
//
// Fixtures are obviously fake (example.test, 555 numbers, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "acme-sheds";
const id = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const C_ALEX = id(21), C_DREW = id(24);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000005", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const AREAS = ["designer", "designs", "contacts", "inventory", "orders", "change_orders", "change_order_approve", "build_schedule",
  "delivery_schedule", "repairs", "commissions", "reports", "phone", "settings_structures", "settings_options", "settings_branding",
  "settings_crm", "settings_quickbooks", "settings_email", "settings_team", "settings_billing"];
const map = (o) => Object.fromEntries(AREAS.map((k) => [k, o[k] || "none"]));
const OWNER_ACCESS = map(Object.fromEntries(AREAS.map((k) => [k, "edit"])));
// access.ts PRESETS, as the status call resolves them.
const CREW_LEADER = map({ build_schedule: "edit", repairs: "edit", designs: "view", inventory: "view", orders: "view" });
const OFFICE_STAFF = map({ designer: "edit", designs: "edit", contacts: "edit", inventory: "edit", orders: "edit", change_orders: "edit",
  build_schedule: "view", delivery_schedule: "view", repairs: "view", reports: "view", phone: "view", settings_branding: "edit", settings_quickbooks: "edit" });
const CREW_MEMBER = map({ build_schedule: "view", repairs: "view" });

// Next week, so stepping the calendar forward is part of what Back has to remember.
const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const NEXT = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return iso(d); })();

const STAGES = [
  { id: "st-q", name: "Queue", kind: "queue", color: "#94A3B8", sort_order: 0 },
  { id: "st-d", name: "Built", kind: "done", color: "#22C55E", sort_order: 1 },
];
const job = (n, extra) => ({ id: `job-${n}`, client_id: CLIENT, stage_id: "st-q", position: n, source: "order", serial: null, title: null,
  width_ft: null, length_ft: null, due_date: NEXT, scheduled_start: NEXT, crew_id: null, notes: null, updated_at: "2026-10-01T12:00:00Z", valueCents: null, ...extra });
const JOBS = [
  job(1, { design_short_code: "SS-ALEX0001", customer_name: "Alex Tester", building_label: "Gable Shed 10x12", customer_link: { code: "SS-ALEX0001", contactId: C_ALEX } }),
  job(2, { design_short_code: "SS-GONE0002", customer_name: "Blair Example", building_label: "Lofted Barn 12x24" }),          // design deleted: no link
  job(3, { design_short_code: "SS-CASE0003", customer_name: "Casey Sample", building_label: "Utility Shed 8x10", customer_link: { code: "SS-CASE0003", contactId: null } }),
  job(4, { source: "inventory", design_short_code: null, inventory_unit_id: id(90), customer_name: null, building_label: "Cabin 12x20" }),
];
const LOAD = { id: id(70), client_id: CLIENT, load_no: 7, load_date: NEXT, status: "planned", driver_id: null, driver_user_id: null, deck_length_ft: null, route_label: "North", is_wide: false };
const stop = (n, extra) => ({ id: id(80 + n), client_id: CLIENT, load_id: LOAD.id, stop_order: n, build_job_id: null, inventory_unit_id: null, repair_id: null,
  serial: null, customer_phone: null, width_ft: 10, length_ft: 12, dest_street: null, dest_city: "Springfield", territory_id: null, leg_miles: null,
  time_window: null, site_notes: null, delivered_at: null, ...extra });
const STOPS = [
  stop(1, { source: "order", design_short_code: "SS-ALEX0001", customer_name: "Alex Tester", building_label: "Gable Shed 10x12", customer_link: { code: "SS-ALEX0001", contactId: C_ALEX } }),
  stop(2, { source: "inventory", design_short_code: "SS-DREW0004", inventory_unit_id: id(91), serial: "1001", customer_name: "Drew Buyer", building_label: "Cabin 12x20", customer_link: { code: "SS-DREW0004", contactId: C_DREW } }),
  stop(3, { source: "inventory", design_short_code: null, inventory_unit_id: id(92), serial: "1002", customer_name: null, building_label: "Lot building to Main St" }),
  stop(4, { source: "repair", design_short_code: null, repair_id: id(93), customer_name: "Evan Repair", building_label: "Repair R-12" }),
];
const PEOPLE = {
  [C_ALEX]: { name: "Alex Tester", phone: "(555) 555-0121", email: "alex@example.test", code: "SS-ALEX0001" },
  [C_DREW]: { name: "Drew Buyer", phone: "(555) 555-0124", email: "drew@example.test", code: "SS-DREW0004" },
};
const designRow = (code, contactId) => ({
  short_code: code, created_at: "2026-09-20T15:00:00Z", updated_at: "2026-09-20T15:00:00Z", status: "invoiced",
  selections: { style: "Gable", size: "10x12" }, expected_close_date: null, total_cents: 812300, ghl_estimate_number: null, image_url: null,
  ss_quote_number: "SSQ-1041", ss_quote_pdf_url: null, ss_invoice_sent_at: "2026-09-21T15:00:00Z", ss_invoice_requested_at: null,
  contact_id: contactId, contact: { name: "Casey Sample", phone: "+15555550123", email: "casey@example.test" },
});

// The Pipeline list's row for Alex's deal (P), in the shape the list reads.
const PIPE_ROW = {
  short_code: "SS-ALEX0001", created_at: "2026-09-20T15:00:00Z", updated_at: "2026-09-20T15:00:00Z", status: "invoiced",
  contact: { name: "Alex Tester", phone: "(555) 555-0121", email: "alex@example.test" }, sel_style: "gable", sel_size: "10x12",
  ghl_estimate_number: null, contact_id: C_ALEX,
};

const { ok, failed } = reporter();
const shots = shotsDir("sched-open-customer");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const SCHED_READS = new Set(["build_board", "loads", "pool", "job_activity", "schedule_links"]);
const SENDS = ["crm_send_email", "crm_send_sms", "email_send_test", "resend_quote_email", "send_invoice", "send_change_order"];

async function scenario(browser, { name, role = "owner", access = OWNER_ACCESS, crm = true, pipeline = false, viewport = { width: 1440, height: 1000 } }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  const dialogs = [];
  let answer = true;                         // what the next confirm() gets
  page.on("dialog", (d) => { dialogs.push(d.message()); (answer ? d.accept() : d.dismiss()).catch(() => {}); });
  const calls = [];
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role, user_id: USER.id }]);
    if (pipeline && url.includes("/rest/v1/designs")) return json(route, [PIPE_ROW]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm, schedule_builds: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (url.includes("/portal-schedule")) {
      if (/[?&]warm=1/.test(url)) return json(route, { ok: true });     // the boot's warm-up ping, no body
      calls.push({ fn: "portal-schedule", ...body });
      switch (body.action) {
        case "build_board": return json(route, { stages: STAGES, jobs: JOBS, stopByJob: {}, tray: { orders: [], inventory: [], repairs: [] }, team: [], crews: [] });
        case "loads": return json(route, { loads: [LOAD], stops: STOPS, buildByJob: {}, unitLifecycle: {}, drivers: [], territories: [], team: [] });
        case "pool": return json(route, { jobs: [], inventory: [], repairs: [], unitLifecycle: {} });
        case "job_activity": return json(route, { activity: [] });
        default: return json(route, { ok: true });
      }
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push({ fn: "portal-settings", ...body });
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role, access, prefs: null, phoneStatus: "off", configured: false, invoiceInGhl: false,
          ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "crm_record": {
        if (body.kind === "design") {
          return json(route, { ok: true, kind: "design", clientId: CLIENT, contact: null, designs: [designRow(body.id, null)], orders: [], feed: [], focus: [],
            team: [], people: [], followers: [], sms: { ready: false, from: null, optedOut: false, consented: false }, build: [], stages: [], delivery: [], repairs: [], isDesign: true });
        }
        const p = PEOPLE[body.id] || { name: "Someone", phone: "", email: "", code: "SS-NONE0000" };
        return json(route, {
          ok: true, kind: "contact", clientId: CLIENT,
          contact: { id: body.id, name: p.name, phone: p.phone, email: p.email, phone_digits: "555555" + body.id.slice(-4), owner_user_id: null, sms_opt_out_at: null, first_seen_at: "2026-09-01T12:00:00Z" },
          designs: [designRow(p.code, body.id)], orders: [], feed: [], focus: [], team: [], people: [], followers: [],
          sms: { ready: false, from: null, optedOut: false, consented: false }, build: [], stages: [], delivery: [], repairs: [],
        });
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
  // Always portal.html: a static server has no /portal/* rewrite, so a deep link is reached the
  // way the app reaches one, through history.
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  const go = async (p) => {
    await page.evaluate((x) => { history.pushState({}, "", x); window.dispatchEvent(new PopStateEvent("popstate")); }, p);
    await page.waitForTimeout(500);
  };
  return { ctx, page, calls, go, dialogs, setAnswer: (v) => { answer = v; } };
}

const tap = (loc) => loc.click({ timeout: 5000 }).then(() => true, () => false);
const path = (page) => page.evaluate(() => window.location.pathname);
const boardReady = (page, text) => page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: 15000 }).then(() => true, () => false);
const weekLabel = (page) => page.evaluate(() => {
  const prev = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "‹");
  return prev && prev.nextElementSibling ? prev.nextElementSibling.textContent.trim() : null;
});
// Which of a tab's view buttons is lit (the active one is the brand colour).
const activeView = (page, labels) => page.evaluate((ls) => {
  const b = [...document.querySelectorAll("button")].find((x) => ls.includes(x.textContent.trim()) && getComputedStyle(x).color === "rgb(61, 54, 114)");
  return b ? b.textContent.trim() : null;
}, labels);
const popup = (page) => page.locator('[role="dialog"][aria-label="Job details"]');
async function openCard(page, building) {
  await tap(page.locator('[role="button"][aria-expanded]', { hasText: building }).first());
  await popup(page).waitFor({ timeout: 5000 }).catch(() => {});
}
async function openTableRow(page, building) {
  await tap(page.locator("tr", { hasText: building }).first());
  await popup(page).waitFor({ timeout: 5000 }).catch(() => {});
}
const recordReady = (page) => page.waitForFunction(() => !!document.querySelector("[data-ss-crm-chip]"), null, { timeout: 20000 }).then(() => true, () => false);
const PICK_HINT = "Pick a deal or order on the left first";
// Whether the record opened ON a deal. The action tabs that file against one deal (Activity, Notes,
// Text, Email) are disabled until one is picked, and say why in their title; Notes is the one an
// owner always has. Null when the tab isn't there at all, so a vacuous pass is impossible.
const dealPicked = (page) => page.evaluate((h) => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Notes");
  if (!b) return null;
  if (!b.disabled) return true;
  return (b.getAttribute("title") || "").includes(h) ? false : null;
}, PICK_HINT);
async function recordBack(page) {
  await tap(page.locator("button", { hasText: /^Back$/ }).first());
  await page.waitForTimeout(400);
}
const lastRecord = (s) => s.calls.filter((c) => c.action === "crm_record").pop() || {};
// The deal's ▸, then its "Open in designer": a page change out of the record that isn't its Back.
async function hopToDesigner(page) {
  await tap(page.locator(`button[title="Show this deal's details"]`).first());
  await tap(page.locator("button", { hasText: /^Open in designer$/ }).first());
  await page.waitForFunction(() => window.location.pathname === "/portal/designer", null, { timeout: 10000 }).catch(() => {});
}

const { browser } = await launch({ width: 1440, height: 1000 });
try {
  // ── A–F. Build Schedule, an owner with the CRM ─────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "owner" });
    await s.go("/portal/build-schedule");
    await boardReady(s.page, "Build Schedule");
    await tap(s.page.locator("button", { hasText: /^›$/ }).first());
    await boardReady(s.page, "Gable Shed");
    const week = await weekLabel(s.page);
    const ready = ok("A0 next week's jobs are on the calendar", (await s.page.locator('[role="button"][aria-expanded]', { hasText: "Gable Shed" }).count()) > 0, week);
    if (!ready) throw new Error("the board never showed the fixture jobs — every check below would be vacuous");
    await openCard(s.page, "Gable Shed");
    ok("A1 a card click still opens the job popup", (await popup(s.page).count()) === 1);
    const link = popup(s.page).locator('[data-ss-sched-customer="SS-ALEX0001"]');
    const linkText = (await link.count()) ? (await link.innerText()).trim() : null;
    if (!ok("A2 the customer's name in the popup is a link", linkText === "Alex Tester ›", String(linkText))) {
      throw new Error("no customer link in the popup — stopping (expected against an older artifact)");
    }
    ok("A3 titled for what it does", (await link.getAttribute("title")) === "Open the customer's record");
    await s.page.screenshot({ path: join(shots, "A-build-popup-1440.png") });
    await tap(link);
    await recordReady(s.page);
    ok("A4 it lands on the customer's record", (await path(s.page)) === `/portal/contacts/c-${C_ALEX}`, await path(s.page));
    const rec = lastRecord(s);
    ok("A5 (that customer's contact record)", rec.kind === "contact" && rec.id === C_ALEX, JSON.stringify(rec));
    await s.page.waitForTimeout(500);
    ok("A6 with the job's deal already picked (Notes open, no 'Pick a deal' hint)", (await dealPicked(s.page)) === true, String(await dealPicked(s.page)));
    await s.page.screenshot({ path: join(shots, "A-record-1440.png") });

    // ── A7–A8. A hop away, then the browser's Back onto the record (review 2026-10-05). The deal
    // and the record's Back used to be spent the moment the address moved, so this came back on
    // "Pick a deal" with a Back to Contacts while the browser's Back still went to the schedule.
    await hopToDesigner(s.page);
    ok("A7 the deal's Open in designer leaves the record", (await path(s.page)) === "/portal/designer", await path(s.page));
    await s.page.goBack();
    await recordReady(s.page);
    await s.page.waitForTimeout(500);
    ok("A8 the browser's Back reopens the record on the same deal", (await path(s.page)) === `/portal/contacts/c-${C_ALEX}` && (await dealPicked(s.page)) === true,
      `${await path(s.page)} ${await dealPicked(s.page)}`);

    // ── B. Back ──
    await recordBack(s.page);
    await boardReady(s.page, "Gable Shed");
    ok("B1 the record's Back (after that hop) lands on the Build Schedule", (await path(s.page)) === "/portal/build-schedule", await path(s.page));
    ok("B2 on the same week it left", (await weekLabel(s.page)) === week, `${await weekLabel(s.page)} vs ${week}`);
    ok("B3 and the same view (Calendar)", (await activeView(s.page, ["Calendar", "Table", "Board"])) === "Calendar", await activeView(s.page, ["Calendar", "Table", "Board"]));
    await openCard(s.page, "Gable Shed");
    await tap(popup(s.page).locator('[data-ss-sched-customer="SS-ALEX0001"]'));
    await recordReady(s.page);
    await s.page.goBack();
    await boardReady(s.page, "Gable Shed");
    ok("B4 the browser's Back does the same: Build Schedule, same week", (await path(s.page)) === "/portal/build-schedule" && (await weekLabel(s.page)) === week,
      `${await path(s.page)} ${await weekLabel(s.page)}`);
    await tap(s.page.locator("button", { hasText: /^Table$/ }).first());
    await boardReady(s.page, "Utility Shed");
    await openTableRow(s.page, "Gable Shed");
    await tap(popup(s.page).locator('[data-ss-sched-customer="SS-ALEX0001"]'));
    await recordReady(s.page);
    await recordBack(s.page);
    await boardReady(s.page, "Gable Shed");
    ok("B5 from the Table view, Back comes back to the Table view", (await activeView(s.page, ["Calendar", "Table", "Board"])) === "Table" && (await path(s.page)) === "/portal/build-schedule",
      `${await activeView(s.page, ["Calendar", "Table", "Board"])} ${await path(s.page)}`);

    // ── C. No link where there is no customer to open ──
    await openTableRow(s.page, "Lofted Barn");
    const gone = await popup(s.page).evaluate((d) => ({ links: d.querySelectorAll("[data-ss-sched-customer]").length, text: d.innerText }));
    ok("C1 a job whose design is gone: the name is plain text", gone.links === 0 && gone.text.includes("Blair Example"), JSON.stringify({ links: gone.links }));
    await tap(popup(s.page).locator('button[aria-label="Close details"]'));
    await openTableRow(s.page, "Cabin 12x20");
    ok("C2 a spec build for the lot: no link", (await popup(s.page).locator("[data-ss-sched-customer]").count()) === 0);
    await tap(popup(s.page).locator('button[aria-label="Close details"]'));

    // ── D. No customer behind the design: the design's own record ──
    await openTableRow(s.page, "Utility Shed");
    await tap(popup(s.page).locator('[data-ss-sched-customer="SS-CASE0003"]'));
    await recordReady(s.page);
    ok("D1 a design with no customer opens the design's record", (await path(s.page)) === "/portal/designs/d-SS-CASE0003", await path(s.page));
    ok("D2 (asked as a design record)", lastRecord(s).kind === "design" && lastRecord(s).id === "SS-CASE0003", JSON.stringify(lastRecord(s)));
    await recordBack(s.page);
    ok("D3 and its Back returns to the Build Schedule", (await path(s.page)) === "/portal/build-schedule", await path(s.page));
    await boardReady(s.page, "Gable Shed");

    // ── E. Unsaved edits ask first ──
    await openTableRow(s.page, "Gable Shed");
    await popup(s.page).locator('input[placeholder^="Standing note"]').fill("Bring the long ladder");
    s.setAnswer(false);
    const before = s.dialogs.length;
    await tap(popup(s.page).locator('[data-ss-sched-customer="SS-ALEX0001"]'));
    await s.page.waitForTimeout(400);
    ok("E1 following the link with an unsaved edit asks first", s.dialogs.length === before + 1 && /not saved/.test(s.dialogs[s.dialogs.length - 1] || ""), s.dialogs.slice(-1)[0]);
    ok("E2 Cancel stays on the job, edit intact", (await path(s.page)) === "/portal/build-schedule"
      && (await popup(s.page).locator('input[placeholder^="Standing note"]').inputValue()) === "Bring the long ladder", await path(s.page));
    s.setAnswer(true);
    await tap(popup(s.page).locator('[data-ss-sched-customer="SS-ALEX0001"]'));
    await recordReady(s.page);
    ok("E3 OK leaves for the record", (await path(s.page)) === `/portal/contacts/c-${C_ALEX}`, await path(s.page));
    await recordBack(s.page);
    await boardReady(s.page, "Gable Shed");
    await openTableRow(s.page, "Gable Shed");
    const quiet = s.dialogs.length;
    await tap(popup(s.page).locator('[data-ss-sched-customer="SS-ALEX0001"]'));
    await recordReady(s.page);
    ok("E4 with nothing changed it doesn't ask", s.dialogs.length === quiet && (await path(s.page)) === `/portal/contacts/c-${C_ALEX}`);

    // ── F. The same customer opened another way ──
    await s.go("/portal/contacts");
    await s.go(`/portal/contacts/c-${C_ALEX}`);
    await recordReady(s.page);
    await s.page.waitForTimeout(500);
    ok("F1 opened from Contacts, the record asks for a deal (so A6 means something)", (await dealPicked(s.page)) === false, String(await dealPicked(s.page)));
    await recordBack(s.page);
    ok("F2 and its Back goes to Contacts, not the schedule", (await path(s.page)) === "/portal/contacts", await path(s.page));

    // ── G. Delivery Schedule ──
    await s.go("/portal/delivery-schedule");
    await boardReady(s.page, "Lot building to Main St");
    const links = await s.page.evaluate(() => [...document.querySelectorAll("[data-ss-sched-customer]")].map((b) => [b.getAttribute("data-ss-sched-customer"), b.innerText.trim()]));
    ok("G1 Loads view: the order stop and the sale stop link, the haul and the repair don't",
      JSON.stringify(links) === JSON.stringify([["SS-ALEX0001", "Alex Tester ›"], ["SS-DREW0004", "Drew Buyer ›"]])
      && (await s.page.evaluate(() => document.body.innerText.includes("Evan Repair"))), JSON.stringify(links));
    await s.page.screenshot({ path: join(shots, "G-delivery-loads-1440.png") });
    await tap(s.page.locator('[data-ss-sched-customer="SS-ALEX0001"]').first());
    await recordReady(s.page);
    await s.page.waitForTimeout(400);
    ok("G2 a stop's link opens the customer's record on that deal", (await path(s.page)) === `/portal/contacts/c-${C_ALEX}`
      && (await dealPicked(s.page)) === true, `${await path(s.page)} ${await dealPicked(s.page)}`);
    await recordBack(s.page);
    await boardReady(s.page, "Lot building to Main St");
    ok("G3 Back returns to the Delivery Schedule's Loads view", (await path(s.page)) === "/portal/delivery-schedule"
      && (await activeView(s.page, ["Loads", "Table", "Calendar"])) === "Loads", `${await path(s.page)} ${await activeView(s.page, ["Loads", "Table", "Calendar"])}`);
    await tap(s.page.locator("button", { hasText: /^Table$/ }).first());
    await s.page.waitForTimeout(300);
    await tap(s.page.locator('[data-ss-sched-customer="SS-DREW0004"]').first());
    await recordReady(s.page);
    ok("G4 Table view: the sale stop opens the buyer's record", (await path(s.page)) === `/portal/contacts/c-${C_DREW}` && lastRecord(s).id === C_DREW, await path(s.page));
    await recordBack(s.page);
    await boardReady(s.page, "Lot building to Main St");
    ok("G5 and Back comes back to the Table view", (await activeView(s.page, ["Loads", "Table", "Calendar"])) === "Table", await activeView(s.page, ["Loads", "Table", "Calendar"]));

    const writes = s.calls.filter((c) => c.fn === "portal-schedule" && !SCHED_READS.has(c.action));
    ok("Z1 nothing here wrote to the schedule or sent anything", writes.length === 0 && !s.calls.some((c) => SENDS.includes(c.action)),
      JSON.stringify(writes.map((c) => c.action)));
    await s.ctx.close();
  }

  // ── P. The Pipeline's own hand-off ───────────────────────────────────────────────────────────
  // Not a schedule, but the same record context: the deal a Pipeline row opens its customer on
  // (Carolyn 2026-09-02) used to be lost to a hop away and the browser's Back too (review 2026-10-05).
  {
    const s = await scenario(browser, { name: "pipeline", pipeline: true });
    await s.go("/portal/designs/list");
    const row = s.page.locator('button[title="Open Alex Tester"]').first();
    await row.waitFor({ timeout: 15000 }).catch(() => {});
    if (!ok("P0 the Pipeline lists the customer's deal", (await row.count()) > 0)) {
      throw new Error("no Pipeline row — every check below would be vacuous");
    }
    await tap(row);
    await recordReady(s.page);
    await s.page.waitForTimeout(500);
    ok("P1 a Pipeline row opens the customer's record on that deal", (await path(s.page)) === `/portal/contacts/c-${C_ALEX}` && (await dealPicked(s.page)) === true,
      `${await path(s.page)} ${await dealPicked(s.page)}`);
    await hopToDesigner(s.page);
    ok("P2 Open in designer leaves the record", (await path(s.page)) === "/portal/designer", await path(s.page));
    await s.page.goBack();
    await recordReady(s.page);
    await s.page.waitForTimeout(500);
    ok("P3 the browser's Back reopens it on the same deal", (await path(s.page)) === `/portal/contacts/c-${C_ALEX}` && (await dealPicked(s.page)) === true,
      `${await path(s.page)} ${await dealPicked(s.page)}`);
    await recordBack(s.page);
    ok("P4 and its own Back still goes to Contacts, as before", (await path(s.page)) === "/portal/contacts", await path(s.page));
    await s.ctx.close();
  }

  // ── H. Who gets what ─────────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "crew-leader", role: "user", access: CREW_LEADER });
    await s.go("/portal/build-schedule");
    await boardReady(s.page, "Build Schedule");
    await tap(s.page.locator("button", { hasText: /^Table$/ }).first());
    await boardReady(s.page, "Gable Shed");
    await openTableRow(s.page, "Gable Shed");
    await tap(popup(s.page).locator('[data-ss-sched-customer="SS-ALEX0001"]'));
    await recordReady(s.page);
    ok("H1 a crew leader (designs, no contacts) lands on the design's record", (await path(s.page)) === "/portal/designs/d-SS-ALEX0001"
      && lastRecord(s).kind === "design", `${await path(s.page)} ${JSON.stringify(lastRecord(s))}`);
    await recordBack(s.page);
    ok("H2 and Back returns to the Build Schedule", (await path(s.page)) === "/portal/build-schedule", await path(s.page));
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "office-staff", role: "user", access: OFFICE_STAFF });
    await s.go("/portal/build-schedule");
    await boardReady(s.page, "Build Schedule");
    await tap(s.page.locator("button", { hasText: /^Table$/ }).first());
    await boardReady(s.page, "Gable Shed");
    await openTableRow(s.page, "Gable Shed");
    const viewOnly = await popup(s.page).evaluate((d) => ({ save: [...d.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save"), link: !!d.querySelector('[data-ss-sched-customer="SS-ALEX0001"]') }));
    ok("H3 someone who can only VIEW the board gets no editor, and still gets the link", !viewOnly.save && viewOnly.link, JSON.stringify(viewOnly));
    await tap(popup(s.page).locator('[data-ss-sched-customer="SS-ALEX0001"]'));
    await recordReady(s.page);
    ok("H4 (to the customer's record)", (await path(s.page)) === `/portal/contacts/c-${C_ALEX}`, await path(s.page));
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "crew-member", role: "user", access: CREW_MEMBER });
    await s.go("/portal/build-schedule");
    await boardReady(s.page, "Build Schedule");
    await tap(s.page.locator("button", { hasText: /^Table$/ }).first());
    await boardReady(s.page, "Gable Shed");
    await openTableRow(s.page, "Gable Shed");
    const m = await popup(s.page).evaluate((d) => ({ links: d.querySelectorAll("[data-ss-sched-customer]").length, name: d.innerText.includes("Alex Tester") }));
    ok("H5 a crew member (neither record) gets the name as plain text, no link", m.links === 0 && m.name, JSON.stringify(m));
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "no-crm", crm: false });
    await s.go("/portal/build-schedule");
    await boardReady(s.page, "Build Schedule");
    await tap(s.page.locator("button", { hasText: /^Table$/ }).first());
    await boardReady(s.page, "Gable Shed");
    await openTableRow(s.page, "Gable Shed");
    await tap(popup(s.page).locator('[data-ss-sched-customer="SS-ALEX0001"]'));
    await recordReady(s.page);
    ok("H6 without the CRM, the design's record (not the CRM sales card)", (await path(s.page)) === "/portal/designs/d-SS-ALEX0001", await path(s.page));
    await s.ctx.close();
  }

  // ── I. A phone's width ───────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "narrow", viewport: { width: 390, height: 844 } });
    await s.go("/portal/build-schedule");
    await boardReady(s.page, "Build Schedule");
    await tap(s.page.locator("button", { hasText: /^Table$/ }).first());
    await boardReady(s.page, "Gable Shed");
    const swBefore = await s.page.evaluate(() => document.documentElement.scrollWidth);
    await openTableRow(s.page, "Gable Shed");
    const fit = await s.page.evaluate(() => {
      const d = document.querySelector('[role="dialog"][aria-label="Job details"] > div');
      const l = document.querySelector('[data-ss-sched-customer="SS-ALEX0001"]');
      const r = d ? d.getBoundingClientRect() : null, lr = l ? l.getBoundingClientRect() : null;
      return { vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, card: r && [r.left, r.right], link: lr && [lr.left, lr.right] };
    });
    // The page is already wider than 390 before the popup opens: the schedule's own toolbar
    // (Calendar/Table/Board, Refresh, Edit stages, + Add job) does not wrap. That predates this
    // change (same width on the artifact before it); the claim here is that the popup and the
    // link fit on screen and add nothing to it.
    ok("I1 at 390px the popup and its link fit on screen, and add no width to the page",
      fit.card && fit.link && fit.card[0] >= 0 && fit.card[1] <= fit.vw && fit.link[0] >= fit.card[0] && fit.link[1] <= fit.card[1] && fit.sw <= swBefore,
      JSON.stringify({ ...fit, swBefore }));
    await s.page.screenshot({ path: join(shots, "I-build-popup-390.png") });
    await tap(popup(s.page).locator('[data-ss-sched-customer="SS-ALEX0001"]'));
    await recordReady(s.page);
    ok("I2 the link still works", (await path(s.page)) === `/portal/contacts/c-${C_ALEX}`, await path(s.page));
    await s.page.screenshot({ path: join(shots, "I-record-390.png"), fullPage: true });
    await s.go("/portal/delivery-schedule");
    await boardReady(s.page, "Lot building to Main St");
    const dfit = await s.page.evaluate(() => {
      const l = document.querySelector('[data-ss-sched-customer="SS-ALEX0001"]');
      const lr = l ? l.getBoundingClientRect() : null;
      // The toolbar's last button is the widest thing on the page before this change (see I1).
      const tb = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "+ New load");
      return { vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, link: lr && [lr.left, lr.right],
        toolbar: tb ? Math.ceil(tb.getBoundingClientRect().right) : null };
    });
    ok("I3 the delivery stop's link is on screen, and nothing but the old toolbar widens the page",
      dfit.link && dfit.link[0] >= 0 && dfit.link[1] <= dfit.vw && dfit.toolbar !== null && dfit.sw <= dfit.toolbar + 1, JSON.stringify(dfit));
    await s.page.screenshot({ path: join(shots, "I-delivery-390.png"), fullPage: true });
    await s.ctx.close();
  }

  ok("Z2 no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
  ok("harness ran to the end", false, e.message);
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\nschedOpenCustomer: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
