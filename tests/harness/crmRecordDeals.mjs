// The contact record's ONE Deals section and its pipeline bar, driven for real on the COMPILED
// portal (Carolyn's 2026-10-12 call).
//
//   A. one Deals section; the Sales pipelines card is gone
//   B. each deal row shows its status ONCE, on its top line, inside the row (still two buttons);
//      a lead with no design is a row too
//   C. picking a deal names its pipeline in the top bar, draws THAT pipeline's stages and lights
//      the one it is in; never the old Qualified / Proposal Made ladder
//   D. picking a deal in another pipeline switches the bar to that pipeline; a lead does too
//   E. the opened deal keeps Expected close, Style, Size, Total, Colour and Open in designer, and
//      adds, beside it, a stage drop-down of its own pipeline's stages only and a move control
//      listing the other pipelines; no second status
//   F. changing the stage is one crm_deal_move to that stage, and the bar follows
//   G. moving to another pipeline is one crm_deal_move to that pipeline's first open stage; the
//      stage drop-down then lists the new pipeline's stages and the bar names it
//   H. a lost stage asks for the reason first and sends it
//   I. a design record (d-...) draws its card's pipeline too
//   J. the pipeline read failed (pipelineError, or a contact with no block): the designs are still
//      the rows, and a picked deal (or a design record) says "Couldn't load this deal's pipeline.
//      Refresh to try again." with NO ladder at all, never the old SALES one (2026-10-13). Against
//      the build before, J3, J5 and J6 fail: it drew the Qualified / Proposal Made ladder instead.
//   K. someone who can't edit contacts sees the stage, can't change it, and has no move or add
//   L. a card clicked on the Pipeline board opens the record ON that deal, the bar on its pipeline;
//      a lead card too, with the lead picked, its write tabs open and a note filed on the customer
//   M. the board's search and Status filter survive opening a card and coming Back (the record's
//      Back and the browser's), per pipeline, and a cleared one stays cleared
//   Z. no crm_deal_set_status from anywhere on the record, and no page errors
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the stub
// shape is crmContactDeal.mjs's.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/crmRecordDeals.mjs          (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/crm-record-deals (SS_SHOTS overrides), named U3-*.png.
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how to
// prove these checks can fail: against the artifact before this change the run stops at its first
// guard, because the old Deals rows carry none of this change's markers.
//
// Fixtures are obviously fake (example.test, 555 numbers, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir, serveAppRoutes } from "./lib.mjs";

const CLIENT = "harness-crm-record-deals";
const CONTACT_ID = "7d1f3a52-6c0b-4c8e-9a51-2f4e8b7c1d90";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000003", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

const design = (code, style, size, created, total, status = "sent") => ({
  short_code: code, created_at: created, updated_at: created, status,
  selections: { style, size, paint_colors: { body: "Painted" } }, expected_close_date: null,
  total_cents: total, ghl_estimate_number: null, image_url: null, ss_quote_number: null,
  ss_quote_pdf_url: null, ss_invoice_sent_at: null, ss_invoice_requested_at: null,
  contact_id: CONTACT_ID, contact: { name: "Pat Tester", phone: "+15125550177", email: "pat@example.test" },
});
const D_LOFT = design("SS-HARN0001", "lofted", "12x20", "2026-08-25T15:00:00Z", 929500);
const D_UTIL = design("SS-HARN0002", "utility", "14x20", "2026-07-20T15:00:00Z", 1180000, "accepted");
const D_DLX = design("SS-HARN0003", "deluxe", "10x24", "2026-06-11T15:00:00Z", 1120000);
const DESIGNS = [D_LOFT, D_UTIL, D_DLX];
const CONTACT = { id: CONTACT_ID, name: "Pat Tester", phone: "+15125550177", email: "pat@example.test", phone_digits: "15125550177", owner_user_id: null, sms_opt_out_at: null, first_seen_at: "2026-06-01T12:00:00Z" };

const SHED = {
  id: "11111111-0000-4000-8000-000000000001", name: "Shed Deals", lostReasons: ["Price", "Timing"],
  stages: [
    ["New Incoming", "#64748B"], ["Attempting Contact", "#0EA5E9"], ["Nurturing - Cool", "#14B8A6"],
    ["Nurturing - Warm", "#F59E0B"], ["Nurturing - Hot", "#F97316"], ["Gone Cold Again", "#94A3B8"],
  ].map(([name, color], i) => ({ id: `22222222-0000-4000-8000-00000000000${i}`, name, color, kind: "open" })),
};
const SOLD = {
  id: "11111111-0000-4000-8000-000000000002", name: "Sold", lostReasons: ["Financing fell through"],
  stages: [
    { id: "33333333-0000-4000-8000-000000000000", name: "Signed", color: "#16A34A", kind: "open" },
    { id: "33333333-0000-4000-8000-000000000001", name: "Building", color: "#6366F1", kind: "open" },
    { id: "33333333-0000-4000-8000-000000000002", name: "Delivered", color: "#15803D", kind: "won" },
    { id: "33333333-0000-4000-8000-000000000003", name: "Lost", color: "#DC2626", kind: "lost" },
  ],
};
const STATUSES = [
  { id: "44444444-0000-4000-8000-000000000000", name: "New Lead", color: "#64748B" },
  { id: "44444444-0000-4000-8000-000000000001", name: "Estimate Sent", color: "#0EA5E9" },
  { id: "44444444-0000-4000-8000-000000000002", name: "Payment Received", color: "#16A34A" },
];
const deal = (id, pipe, stageIdx, statusIdx, code, created, extra = {}) => ({
  id, pipeline_id: pipe.id, stage_id: pipe.stages[stageIdx].id, status_id: STATUSES[statusIdx].id, contact_id: CONTACT_ID,
  short_code: code, title: null, value_cents: null, expected_close_date: null, lost_reason: null,
  stage_entered_at: created, created_at: created, ...extra,
});
const DEALS = () => [
  deal("55555555-0000-4000-8000-000000000001", SHED, 3, 1, D_LOFT.short_code, "2026-08-25T15:00:01Z"),
  deal("55555555-0000-4000-8000-000000000002", SOLD, 1, 2, D_UTIL.short_code, "2026-07-20T15:00:01Z"),
  deal("55555555-0000-4000-8000-000000000003", SHED, 1, 0, D_DLX.short_code, "2026-06-11T15:00:01Z"),
  // A lead with no design, added straight to a pipeline from the board.
  deal("55555555-0000-4000-8000-000000000004", SOLD, 0, 0, null, "2026-09-02T10:00:00Z", { title: "Second building", value_cents: 640000 }),
];
const LEAD_ID = "55555555-0000-4000-8000-000000000004";

const { ok, failed } = reporter();
const shots = shotsDir("crm-record-deals");
const shot = (page, name) => page.screenshot({ path: join(shots, `U3-${name}.png`) });

// An owner's resolved access map, and a reader who may look at contacts but not change them.
const EDIT_ACCESS = { designer: "edit", designs: "edit", contacts: "edit" };
const VIEW_ACCESS = { designer: "edit", designs: "edit", contacts: "view" };

async function scenario(browser, { withPipeline = true, pipelineError = false, access = EDIT_ACCESS }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const pageErrors = [];
  const calls = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  let deals = DEALS();

  const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: "owner", access, prefs: null, configured: false, invoiceInGhl: false,
          ghlInvoicingAllowed: false, ssQuoteNext: 1042, ssInvoiceNext: 2001, ssTaxRate: 6.5, ssTaxLabel: "Sales tax", businessAddress: {}, branding: {}, emailReady: true });
      case "crm_record": {
        const isDesign = body.kind === "design";
        const ds = isDesign ? DESIGNS.filter((d) => d.short_code === body.id) : DESIGNS;
        const pipeline = withPipeline ? {
          pipelines: [SHED, SOLD], statuses: STATUSES,
          deals: isDesign ? deals.filter((d) => d.short_code === body.id) : deals,
        } : undefined;
        return json(route, {
          ok: true, kind: body.kind, contact: CONTACT, designs: ds,
          orders: [], feed: [], focus: [], team: [], people: [], followers: [],
          sms: { ready: false, from: null, optedOut: false, consented: false },
          build: [], stages: [], delivery: [], repairs: [], pipeline,
          ...(pipelineError ? { pipelineError: true } : {}),
        });
      }
      case "crm_deal_move": {
        const stage = [...SHED.stages, ...SOLD.stages].find((s) => s.id === body.stageId);
        const owner = [SHED, SOLD].find((p) => p.stages.includes(stage));
        deals = deals.map((d) => (d.id === body.id ? { ...d, stage_id: stage.id, pipeline_id: owner.id, lost_reason: body.lostReason || null } : d));
        const now = deals.find((d) => d.id === body.id);
        return json(route, { ok: true, moved: true, kind: stage.kind, status_id: now.status_id });
      }
      // The Pipeline board (check L): its pipelines, and one pipeline's cards as crm_deals_list
      // shapes them (contact and design attached).
      case "crm_pipelines_list":
        return json(route, { ok: true, pipelines: [SHED, SOLD], statuses: STATUSES, team: [], canManage: true, canWrite: true, ownOnly: false, me: USER.id });
      case "crm_deals_list":
        return json(route, { ok: true, deals: deals.filter((d) => d.pipeline_id === body.pipelineId).map((d) => {
          const g = DESIGNS.find((x) => x.short_code === d.short_code);
          return { ...d, value_cents: g ? g.total_cents : d.value_cents,
            contact: { id: CONTACT_ID, name: CONTACT.name, company: null, phone: CONTACT.phone, email: CONTACT.email, ownerUserId: null },
            design: g ? { status: g.status, estimateNumber: null, style: g.selections.style, size: g.selections.size, createdAt: g.created_at, updatedAt: g.updated_at } : null };
        }) });
      case "crm_contacts": return json(route, { ok: true, contacts: [CONTACT] });
      case "list_locations": return json(route, { ok: true, nextSerial: 100, locations: [] });
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  if (process.env.SS_PORTAL_ARTIFACT) {
    const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
    await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
  }
  // The app at its root address (/login, the bare one), answered from _redirects as the host does.
  await serveAppRoutes(page);
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 90000 });
  await page.waitForTimeout(600);
  const go = async (path) => {
    await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
    await page.waitForTimeout(1200);
  };
  return { ctx, page, pageErrors, calls, go };
}

// The bar's first row: its label, its chevrons, and which one is lit (white text).
const barRow = (page) => page.evaluate(() => {
  const label = document.querySelector('[data-ss-stage-label="sales"]');
  if (!label) return null;
  const rail = label.nextElementSibling;
  const chevrons = rail ? [...rail.children] : [];
  const lit = chevrons.filter((c) => getComputedStyle(c).color === "rgb(255, 255, 255)").map((c) => c.innerText.trim());
  // The label is uppercased by CSS; its title is the name as the builder wrote it.
  return { label: label.getAttribute("title"), shown: label.innerText.trim(), stages: chevrons.map((c) => c.innerText.trim()), lit };
});
const rowEl = (code) => `[data-ss-deal-row="${code}"]`;
const clickRow = async (page, key) => {
  await page.locator(`${rowEl(key)} button[aria-pressed]`).click();
  await page.waitForTimeout(400);
};
const moves = (calls) => calls.filter((c) => c.action === "crm_deal_move");

const { browser } = await launch({ width: 1440, height: 1000 });
try {
  // ════ The pipeline block present (the new server) ════
  {
    const { ctx, page, pageErrors, calls, go } = await scenario(browser, { withPipeline: true });
    await go(`/contacts/c-${CONTACT_ID}`);
    await page.waitForFunction(() => !!document.querySelector("[data-ss-deal-row]"), null, { timeout: 30000 }).catch(() => {});
    const rendered = ok("the Deals rows rendered", (await page.locator("[data-ss-deal-row]").count()) > 0);
    if (!rendered) throw new Error("no deal rows; every check below would be vacuous");
    await shot(page, "contact-deals");

    // ── A ──
    const sections = await page.evaluate(() => [...document.querySelectorAll("[data-ss-crm-section]")].map((e) => e.getAttribute("data-ss-crm-section")));
    ok("A1 one Deals section", sections.filter((s) => s === "deals").length === 1, JSON.stringify(sections));
    ok("A2 no Sales pipelines section", !sections.includes("salesPipelines") && (await page.locator("[data-ss-contact-deals]").count()) === 0);
    ok("A3 nothing on the page says SALES PIPELINES", !/sales pipelines/i.test(await page.evaluate(() => document.body.innerText)));

    // ── B ──
    const rows = await page.evaluate(() => [...document.querySelectorAll("[data-ss-deal-row]")].map((r) => {
      const head = r.firstElementChild;
      const btns = [...head.querySelectorAll(":scope > button")];
      return { key: r.getAttribute("data-ss-deal-row"), buttons: btns.length,
        pillsInRow: btns[0] ? btns[0].querySelectorAll("[data-ss-deal-status]").length : -1,
        pills: r.querySelectorAll("[data-ss-deal-status]").length,
        pill: (r.querySelector("[data-ss-deal-status]") || {}).innerText || null,
        text: (btns[0] && btns[0].innerText) || "" };
    }));
    ok("B1 four rows: three designs and the lead", rows.length === 4, JSON.stringify(rows.map((r) => r.key)));
    ok("B2 every row has exactly two buttons (row + expander)", rows.every((r) => r.buttons === 2), JSON.stringify(rows.map((r) => r.buttons)));
    ok("B3 every row shows its status once, inside its top line", rows.every((r) => r.pills === 1 && r.pillsInRow === 1), JSON.stringify(rows.map((r) => [r.key, r.pills, r.pillsInRow])));
    const loftRow = rows.find((r) => r.key === D_LOFT.short_code);
    ok("B4 the status is the card's own", loftRow && loftRow.pill === "Estimate Sent", loftRow && loftRow.pill);
    const leadRow = rows.find((r) => r.key === LEAD_ID);
    ok("B5 the lead is a row, named by its title", !!leadRow && /Second building/.test(leadRow.text), leadRow && leadRow.text);
    ok("B6 the status pill is not a control", (await page.locator("[data-ss-deal-row] select[aria-label='Status']").count()) === 0);

    // ── C ──
    ok("C0 nothing picked: no pipeline bar", (await barRow(page)) === null);
    await clickRow(page, D_LOFT.short_code);
    const shed = await barRow(page);
    ok("C1 the bar names the deal's pipeline", shed && shed.label === "Shed Deals", JSON.stringify(shed));
    ok("C2 and draws that pipeline's stages", shed && JSON.stringify(shed.stages) === JSON.stringify(SHED.stages.map((s) => s.name)), shed && shed.stages.join(" | "));
    ok("C3 with the one it is in lit, and only that one", shed && JSON.stringify(shed.lit) === JSON.stringify(["Nurturing - Warm"]), shed && JSON.stringify(shed.lit));
    ok("C4 never the old ladder", !/Qualified|Proposal Made|Contract Signed/.test(await page.evaluate(() => document.body.innerText)));
    await shot(page, "bar-shed-deals");

    // ── D ──
    await clickRow(page, D_UTIL.short_code);
    const sold = await barRow(page);
    ok("D1 picking a deal in another pipeline switches the bar", sold && sold.label === "Sold" && sold.lit.join() === "Building", JSON.stringify(sold));
    await shot(page, "bar-sold");
    await clickRow(page, LEAD_ID);
    const lead = await barRow(page);
    ok("D2 a lead with no design switches it too", lead && lead.label === "Sold" && lead.lit.join() === "Signed", JSON.stringify(lead));
    ok("D3 a lead pick leaves the pick hint off", !(await page.evaluate(() => document.body.innerText.includes("Pick a deal to see its stages"))));

    // ── E ──
    await clickRow(page, D_LOFT.short_code);
    await page.locator(`${rowEl(D_LOFT.short_code)} button[aria-expanded]`).click();
    await page.waitForTimeout(500);
    const panel = `[data-ss-deal-panel="${D_LOFT.short_code}"]`;
    const ptext = await page.locator(panel).innerText();
    ok("E1 the opened deal keeps its fields", ["EXPECTED CLOSE", "STYLE", "SIZE", "TOTAL", "COLOUR", "Open in designer"].every((w) => ptext.includes(w)), ptext.replace(/\s+/g, " ").slice(0, 160));
    const stageOpts = await page.locator(`${panel} select[aria-label="Stage"] option`).allInnerTexts();
    ok("E2 the stage drop-down lists only this pipeline's stages", JSON.stringify(stageOpts) === JSON.stringify(SHED.stages.map((s) => s.name)), stageOpts.join(" | "));
    ok("E3 with no groups of other pipelines", (await page.locator(`${panel} select[aria-label="Stage"] optgroup`).count()) === 0);
    const moveOpts = await page.locator(`${panel} select[aria-label="Move to another pipeline"] option`).allInnerTexts();
    ok("E4 the move control lists the other pipeline", JSON.stringify(moveOpts) === JSON.stringify(["Move to pipeline…", "Sold"]), moveOpts.join(" | "));
    ok("E5 no second status inside the opened deal", (await page.locator(`${panel} [data-ss-deal-status]`).count()) === 0);
    // The controls sit at the bottom right, beside Open in designer.
    const geo = await page.evaluate((sel) => {
      const p = document.querySelector(sel);
      const r = (el) => el && el.getBoundingClientRect();
      const open = [...p.querySelectorAll("button")].find((b) => b.innerText.includes("Open in designer"));
      const stage = p.querySelector('select[aria-label="Stage"]');
      return { panel: r(p), open: r(open), stage: r(stage) };
    }, panel);
    ok("E6 the stage control is right of Open in designer, at the panel's right edge",
      geo.stage.left > geo.open.right - 1 && Math.abs(geo.panel.right - geo.stage.right) < 16 && geo.stage.top >= geo.open.top - 4,
      JSON.stringify({ openRight: Math.round(geo.open.right), stageLeft: Math.round(geo.stage.left), stageRight: Math.round(geo.stage.right), panelRight: Math.round(geo.panel.right) }));
    await page.locator(panel).scrollIntoViewIfNeeded();
    await shot(page, "deal-expanded");

    // ── F ──
    const hot = SHED.stages[4];
    await page.locator(`${panel} select[aria-label="Stage"]`).selectOption(hot.id);
    await page.waitForTimeout(700);
    const m1 = moves(calls);
    ok("F1 a stage change is one crm_deal_move to that stage", m1.length === 1 && m1[0].stageId === hot.id && m1[0].id === DEALS()[0].id, JSON.stringify(m1));
    const afterF = await barRow(page);
    ok("F2 and the bar follows", afterF && afterF.lit.join() === "Nurturing - Hot", JSON.stringify(afterF));

    // ── G ──
    await page.locator(`${panel} select[aria-label="Move to another pipeline"]`).selectOption(SOLD.id);
    await page.waitForTimeout(800);
    const m2 = moves(calls);
    ok("G1 a move is one crm_deal_move to the new pipeline's first open stage", m2.length === 2 && m2[1].stageId === SOLD.stages[0].id, JSON.stringify(m2[1]));
    const stageOpts2 = await page.locator(`${panel} select[aria-label="Stage"] option`).allInnerTexts();
    ok("G2 the stage drop-down now lists the new pipeline's stages", JSON.stringify(stageOpts2) === JSON.stringify(SOLD.stages.map((s) => s.name)), stageOpts2.join(" | "));
    const afterG = await barRow(page);
    ok("G3 the bar names the new pipeline", afterG && afterG.label === "Sold" && afterG.lit.join() === "Signed", JSON.stringify(afterG));
    const moveOpts2 = await page.locator(`${panel} select[aria-label="Move to another pipeline"] option`).allInnerTexts();
    ok("G4 and the move control now offers the old one", JSON.stringify(moveOpts2) === JSON.stringify(["Move to pipeline…", "Shed Deals"]), moveOpts2.join(" | "));
    await shot(page, "moved-to-sold");

    // ── H ──
    await page.locator(`${panel} select[aria-label="Stage"]`).selectOption(SOLD.stages[3].id);
    await page.waitForTimeout(500);
    const dialog = page.locator('[role="dialog"]');
    ok("H1 a lost stage asks for the reason first", (await dialog.count()) === 1 && moves(calls).length === 2);
    await shot(page, "lost-reason");
    // The pipeline's first reason is picked to begin with (SsLostReasonDialog).
    await dialog.locator("button", { hasText: "Mark lost" }).click();
    await page.waitForTimeout(700);
    const m3 = moves(calls);
    ok("H2 then moves with that reason", m3.length === 3 && m3[2].stageId === SOLD.stages[3].id && m3[2].lostReason === "Financing fell through", JSON.stringify(m3[2]));

    // ── I ──
    await go(`/designs/d-${D_DLX.short_code}`);
    await page.waitForFunction(() => !!document.querySelector('[data-ss-stage-label="sales"]'), null, { timeout: 20000 }).catch(() => {});
    const dRow = await barRow(page);
    ok("I1 a design record draws its card's pipeline", dRow && dRow.label === "Shed Deals" && dRow.lit.join() === "Attempting Contact", JSON.stringify(dRow));
    ok("I2 and not the old ladder", !/Qualified|Proposal Made|Contract Signed/.test(await page.evaluate(() => document.body.innerText)));
    await shot(page, "design-record");

    // ── L ──
    await go("/designs/pipeline");
    const card = page.locator(`[data-ss-deal="${DEALS()[2].id}"]`);
    await card.waitFor({ timeout: 20000 }).catch(() => {});
    const onBoard = ok("L0 the deluxe card is on the Shed Deals board", (await card.count()) === 1);
    if (onBoard) {
      await card.click();
      await page.waitForFunction(() => !!document.querySelector('[data-ss-stage-label="sales"]'), null, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(400);
      const opened = await barRow(page);
      const picked = await page.locator(`${rowEl(D_DLX.short_code)} button[aria-pressed="true"]`).count();
      ok("L1 the card opens the record on that deal", picked === 1 && /\/contacts\/c-/.test(await page.evaluate(() => location.pathname)),
        await page.evaluate(() => location.pathname));
      ok("L2 with the bar on its pipeline and stage", opened && opened.label === "Shed Deals" && opened.lit.join() === "Attempting Contact", JSON.stringify(opened));
      await shot(page, "opened-from-board");
    }
    // A LEAD card (no design, so no short code) opens its customer with that deal picked (C22).
    await go(`/contacts/p-${SOLD.id}`);
    const leadCard = page.locator(`[data-ss-deal="${LEAD_ID}"]`);
    await leadCard.waitFor({ timeout: 20000 }).catch(() => {});
    if (ok("L3 the lead card is on the Sold board", (await leadCard.count()) === 1)) {
      await leadCard.click();
      await page.waitForFunction(() => !!document.querySelector('[data-ss-stage-label="sales"]'), null, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(400);
      const leadOpened = await barRow(page);
      const leadPicked = await page.locator(`${rowEl(LEAD_ID)} button[aria-pressed="true"]`).count();
      ok("L4 a lead card opens its customer with that lead picked", leadPicked === 1 && /\/contacts\/c-/.test(await page.evaluate(() => location.pathname)),
        await page.evaluate(() => location.pathname));
      ok("L5 and the bar on the lead's pipeline and stage", leadOpened && leadOpened.label === "Sold" && leadOpened.lit.join() === "Signed", JSON.stringify(leadOpened));
      await shot(page, "lead-opened-from-board");

      // The lead is PICKED, so the write tabs are open: a lead has no design, and what is written
      // on it is filed against the customer alone (integration review 2026-10-13).
      const tabsOff = await page.evaluate(() => Object.fromEntries(["Write Note", "Create Task", "Send Email", "Upload File"].map((name) => {
        const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === name);
        return [name, b ? b.disabled : "missing"];
      })));
      const tabsOpen = ok("L6 with a lead picked, Notes, Activity, Email and Uploads are open", Object.values(tabsOff).every((v) => v === false), JSON.stringify(tabsOff));
      const bodyText = await page.evaluate(() => document.body.innerText);
      ok("L7 nothing says to pick a deal, and the rails say the lead has no design yet",
        !/Pick a deal/.test(bodyText) && /This lead has no design yet, so it has no build schedule\./.test(bodyText),
        (bodyText.match(/[^\n]*(Pick a deal|This lead has no design)[^\n]*/g) || []).join(" | "));
      const before = calls.length;
      if (tabsOpen) {
        await page.locator("button", { hasText: /^Notes$/ }).click();
        await page.locator('textarea[placeholder="Click here to add a note…"]').fill("Called about the second building");
        await page.locator("button", { hasText: "Save note" }).click();
        await page.waitForTimeout(700);
      }
      const saved = calls.slice(before).filter((c) => c.action === "crm_save_note");
      ok("L8 a note on the lead is one crm_save_note on the customer, with no design code",
        saved.length === 1 && saved[0].contactId === CONTACT_ID && !saved[0].shortCode && saved[0].body === "Called about the second building",
        JSON.stringify(saved));
      await shot(page, "lead-note-saved");
    }

    // ── M: the board's search and Status filter survive opening a card and coming Back (C22 + C42) ──
    // Carolyn, 2026-10-12: "wait where what was I". The board unmounts while a record is open.
    const shownCards = () => page.evaluate(() => [...document.querySelectorAll("[data-ss-deal]")].map((e) => e.getAttribute("data-ss-deal")).sort());
    const boardState = async () => ({
      path: await page.evaluate(() => location.pathname),
      cards: await shownCards(),
      // The button's label, without its ▾.
      filter: ((await page.locator("[data-ss-status-filter-button]").innerText().catch(() => "")) || "").replace(/\s*▾\s*$/, "").trim(),
      search: await page.getByPlaceholder("Search: company, name, phone, email…").inputValue().catch(() => null),
    });
    const UTIL_DEAL = DEALS()[1].id;
    await go(`/contacts/p-${SOLD.id}`);
    await page.locator(`[data-ss-deal="${UTIL_DEAL}"]`).waitFor({ timeout: 20000 }).catch(() => {});
    const unfiltered = await shownCards();
    ok("M0 the Sold board shows three cards before any filter", unfiltered.length === 3, JSON.stringify(unfiltered));
    await page.locator("[data-ss-status-filter-button]").click();
    await page.locator(`[data-ss-status-option="${STATUSES[2].id}"] input[type="checkbox"]`).check();
    await page.locator("[data-ss-status-filter-menu] button", { hasText: "Done" }).click();
    await page.getByPlaceholder("Search: company, name, phone, email…").fill("util");
    await page.waitForTimeout(400);
    const filtered = await boardState();
    ok("M1 filtered to Payment Received and searched: one card", JSON.stringify(filtered.cards) === JSON.stringify([UTIL_DEAL]) && filtered.filter === "Payment Received", JSON.stringify(filtered));
    await shot(page, "board-filtered");
    // Open the card, then the record's own Back.
    await page.locator(`[data-ss-deal="${UTIL_DEAL}"]`).click();
    await page.waitForFunction(() => /\/contacts\/c-/.test(location.pathname), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    ok("M2 the card opened its customer", /\/contacts\/c-/.test(await page.evaluate(() => location.pathname)));
    await page.getByRole("button", { name: "Back", exact: true }).first().click();
    await page.locator(`[data-ss-deal="${UTIL_DEAL}"]`).waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    const afterBack = await boardState();
    ok("M3 the record's Back lands on the same board, still searched and filtered",
      afterBack.path === `/contacts/p-${SOLD.id}` && JSON.stringify(afterBack.cards) === JSON.stringify([UTIL_DEAL]) && afterBack.filter === "Payment Received" && afterBack.search === "util",
      JSON.stringify(afterBack));
    await shot(page, "board-after-record-back");
    // And the browser's Back.
    await page.locator(`[data-ss-deal="${UTIL_DEAL}"]`).click();
    await page.waitForFunction(() => /\/contacts\/c-/.test(location.pathname), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.goBack();
    await page.locator(`[data-ss-deal="${UTIL_DEAL}"]`).waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    const afterBrowserBack = await boardState();
    ok("M4 the browser's Back does the same",
      afterBrowserBack.path === `/contacts/p-${SOLD.id}` && JSON.stringify(afterBrowserBack.cards) === JSON.stringify([UTIL_DEAL]) && afterBrowserBack.filter === "Payment Received" && afterBrowserBack.search === "util",
      JSON.stringify(afterBrowserBack));
    // Another pipeline keeps its own view: Shed Deals is not filtered by Sold's.
    await go(`/contacts/p-${SHED.id}`);
    await page.waitForTimeout(400);
    const shedView = await boardState();
    ok("M5 another pipeline's board is not filtered by this one's view", shedView.filter === "All statuses" && shedView.search === "", JSON.stringify(shedView));
    // Cleared, it stays cleared: × on the filter, × on the search, open a card, Back.
    await go(`/contacts/p-${SOLD.id}`);
    await page.locator(`[data-ss-deal="${UTIL_DEAL}"]`).waitFor({ timeout: 20000 }).catch(() => {});
    await page.getByRole("button", { name: "Clear the status filter" }).click();
    await page.getByRole("button", { name: "Clear search" }).click();
    await page.waitForTimeout(300);
    await page.locator(`[data-ss-deal="${UTIL_DEAL}"]`).click();
    await page.waitForFunction(() => /\/contacts\/c-/.test(location.pathname), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.goBack();
    await page.locator(`[data-ss-deal="${UTIL_DEAL}"]`).waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    const cleared = await boardState();
    ok("M6 a cleared filter and search stay cleared after a round trip", cleared.cards.length === 3 && cleared.filter === "All statuses" && cleared.search === "", JSON.stringify(cleared));

    ok("Z1 nothing on the record set a status", !calls.some((c) => c.action === "crm_deal_set_status"), JSON.stringify(calls.map((c) => c.action)));
    ok("Z2 no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
    await ctx.close();
  }

  // ════ K: a reader who can't edit contacts ════
  {
    const { ctx, page, pageErrors, calls, go } = await scenario(browser, { withPipeline: true, access: VIEW_ACCESS });
    await go(`/contacts/c-${CONTACT_ID}`);
    await page.waitForFunction(() => !!document.querySelector("[data-ss-deal-row]"), null, { timeout: 30000 }).catch(() => {});
    await page.locator(`${rowEl(D_LOFT.short_code)} button[aria-expanded]`).click();
    await page.waitForTimeout(500);
    const panel = `[data-ss-deal-panel="${D_LOFT.short_code}"]`;
    ok("K1 the stage is shown, and can't be changed", (await page.locator(`${panel} select[aria-label="Stage"]`).isDisabled()) === true);
    ok("K2 no move control", (await page.locator(`${panel} select[aria-label="Move to another pipeline"]`).count()) === 0);
    ok("K3 no + Add to a pipeline", !(await page.evaluate(() => document.body.innerText.includes("Add to a pipeline"))));
    ok("K4 nothing was written", moves(calls).length === 0 && !calls.some((c) => c.action === "crm_deal_set_status"));
    ok("K5 no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
    await ctx.close();
  }

  // ════ J: the pipeline read failed ════
  const PIPE_ERR = "Couldn't load this deal's pipeline. Refresh to try again.";
  const OLD_LADDER = /Qualified|Demo Scheduled|Proposal Made|Contract Signed/;
  const pipeErr = (page) => page.evaluate(() => [...document.querySelectorAll("[data-ss-pipe-error]")].map((e) => e.innerText.trim()));
  for (const [label, opts] of [["crm_record says pipelineError", { withPipeline: false, pipelineError: true }],
    ["a contact's record with no pipeline block", { withPipeline: false }]]) {
    const { ctx, page, pageErrors, go } = await scenario(browser, opts);
    await go(`/contacts/c-${CONTACT_ID}`);
    await page.waitForFunction(() => !!document.querySelector("[data-ss-deal-row]"), null, { timeout: 30000 }).catch(() => {});
    const keys = await page.evaluate(() => [...document.querySelectorAll("[data-ss-deal-row]")].map((r) => r.getAttribute("data-ss-deal-row")));
    const first = opts.pipelineError;
    if (first) {
      ok("J1 the designs are still the Deals rows", JSON.stringify(keys) === JSON.stringify(DESIGNS.map((d) => d.short_code)), JSON.stringify(keys));
      ok("J2 no status pills or pipeline controls", (await page.locator("[data-ss-deal-status]").count()) === 0);
      ok("J2b nothing picked: no error line yet, and no bar", (await pipeErr(page)).length === 0 && (await barRow(page)) === null);
    }
    await clickRow(page, D_LOFT.short_code);
    const bar = await barRow(page);
    const errs = await pipeErr(page);
    const text = await page.evaluate(() => document.body.innerText);
    ok(`${first ? "J3" : "J5"} ${label}: a picked deal says it couldn't load the pipeline, and draws no ladder (never the old SALES one)`,
      bar === null && errs.length === 1 && errs[0] === PIPE_ERR && !OLD_LADDER.test(text), JSON.stringify({ bar, errs, old: (text.match(OLD_LADDER) || [null])[0] }));
    if (first) await shot(page, "pipeline-read-failed");
    ok(`${first ? "J4" : "J5b"} no uncaught page errors`, pageErrors.length === 0, pageErrors.join(" | "));
    await ctx.close();
  }
  {
    // A design record whose pipeline read failed: the same line, and not the status ladder either.
    const { ctx, page, pageErrors, go } = await scenario(browser, { withPipeline: false, pipelineError: true });
    await go(`/designs/d-${D_UTIL.short_code}`);
    await page.waitForFunction(() => document.body.innerText.includes("Open in designer"), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(500);
    const errs = await pipeErr(page);
    const text = await page.evaluate(() => document.body.innerText);
    ok("J6 a design record whose pipeline read failed says so, with no ladder", errs.length === 1 && errs[0] === PIPE_ERR && !OLD_LADDER.test(text) && (await barRow(page)) === null,
      JSON.stringify({ errs, old: (text.match(OLD_LADDER) || [null])[0] }));
    ok("J7 no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\ncrmRecordDeals: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
