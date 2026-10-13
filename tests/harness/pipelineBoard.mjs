// The Pipeline BOARD after Carolyn's 2026-10-12 call, driven for real on the COMPILED portal.
//
//   W. No scroll bar on the board, at 1280, 1440 and 1920 wide with an eight-stage pipeline (and a
//      phone): "This scroll bar is not going to be there. I am going to make this like the designer
//      where it can be as wide as it needs to be." The page has no sideways scroll, nothing inside
//      the board scrolls, every stage sits inside the board, the page's 1240px cap is lifted while
//      the board shows (and back on the Design list), the board fills the page's width, and when
//      the stages can't all go across, as many as fit do and the rest wrap below.
//   F. The status filter beside the search: show only one status, show only two, hide one, clear.
//      "I want to see all my estimates and want to see all my payments, a filter of one or many,
//      and also a filter to exclude."
//   R. Statuses are the system's: the card pill is a label (no <select>), the hint no longer says to
//      click a status, a drag moves the card's stage and keeps its status, and nothing on the board
//      ever calls crm_deal_set_status. A click on the pill opens the customer like the rest of the
//      card; the expected close date (now in the pill's row) still opens from the card on its own.
//   L. The Design list keeps the page's ordinary 1240px width.
//   Q. Refresh (2026-10-13): the board inside the Contacts hub has a visible "↻ Refresh", and a press
//      asks for the pipelines and the cards again and draws what came back (a card added since).
//      Against the build before, Q1 fails: the button showed only on a board that wasn't embedded,
//      and the hub's board always is ("Refresh does nothing").
//
// (The old board failing W and F is how this was checked: with SS_PORTAL_ARTIFACT set to the
// previous build, W finds the inner `overflow-x: auto` scroller and the 1240px cap, and F finds no
// status filter.)
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/pipelineBoard.mjs           (exit 0 = every check held)
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine). Every name,
// email and amount is made up, per the public-repo rule. SS_SHOTS=<dir> keeps the screenshots;
// SS_SHOT_PREFIX names them (default "board-"). SS_PORTAL_ARTIFACT=<an older
// portal.app.compiled.js> serves that file instead.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, shotsDir, collectErrors } from "./lib.mjs";

const OWN = "acme-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000021", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// The account's statuses and an eight-stage pipeline (the widest a builder has today).
const STATUS_NAMES = [["New Lead", "#64748B"], ["Appt Set", "#0EA5E9"], ["Estimate Sent", "#6366F1"], ["Accepted", "#16A34A"],
  ["Invoiced", "#F59E0B"], ["Payment Received", "#14B8A6"], ["Scheduling", "#F97316"], ["Delivered", "#8B5CF6"]];
const STATUSES = STATUS_NAMES.map(([name, color], i) => ({ id: uuid(100 + i), name, color, position: i, triggerEvent: null }));
const ST = Object.fromEntries(STATUSES.map((s) => [s.name, s.id]));
const STAGE_NAMES = ["New Incoming", "Attempting Contact", "Nurturing - Cool", "Nurturing - Warm", "Nurturing - Hot", "Gone Cold Again", "Won", "Lost"];
const PIPE = {
  id: uuid(200), name: "Shed Deals", position: 0, lostReasons: ["Price", "Timing"], seedKind: null, feedsDesigns: true, mirrorsStatuses: false,
  stages: STAGE_NAMES.map((name, i) => ({ id: uuid(300 + i), name, color: ["#64748B", "#0EA5E9", "#14B8A6", "#6366F1", "#8B5CF6", "#94A3B8", "#16A34A", "#DC2626"][i],
    kind: name === "Won" ? "won" : name === "Lost" ? "lost" : "open", position: i, statusId: null })),
};
const TEAM = [{ userId: USER.id, name: "Pat Owner", title: null }, { userId: uuid(22), name: "Sam Seller", title: null }];
const FIRST = ["Avery", "Blake", "Casey", "Drew", "Emery", "Finley", "Gray", "Harper", "Indy", "Jordan", "Kai", "Logan", "Morgan"];
const LAST = ["Stone", "Rivers", "Dale", "Brooks", "Lane", "Fields", "Hart", "Woods"];
const STATUS_CYCLE = ["Estimate Sent", "Estimate Sent", "Payment Received", "New Lead", "Accepted", "Scheduling", "Estimate Sent", "Invoiced", "Accepted", "Payment Received"];
// 26 cards, most of them in the three Nurturing stages like the real board, a few elsewhere.
const STAGE_OF = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 1, 6, 7];
const DEALS = STAGE_OF.map((si, i) => {
  const name = `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`;
  const design = i % 4 !== 3;
  return {
    id: uuid(400 + i), pipeline_id: PIPE.id, stage_id: PIPE.stages[si].id, status_id: ST[STATUS_CYCLE[i % STATUS_CYCLE.length]],
    contact_id: uuid(500 + i), short_code: design ? `SS-HARN${String(i).padStart(4, "0")}` : null, title: design ? null : "Lead",
    value_cents: 500000 + i * 12300, expected_close_date: i % 5 === 0 ? "2026-11-20" : null, next_follow_up_at: null,
    lost_reason: si === 7 ? "Timing" : null, source: design ? "design" : "manual",
    stage_entered_at: new Date(Date.now() - (i % 12) * 86400000).toISOString(), won_at: null, lost_at: null,
    created_at: "2026-09-20T15:00:00Z", updated_at: "2026-10-01T15:00:00Z",
    contact: { id: uuid(500 + i), name, company: null, phone: null, email: `${name.split(" ")[0].toLowerCase()}@example.test`, ownerUserId: i % 3 ? USER.id : uuid(22) },
    design: design ? { status: i % 2 ? "sent" : "accepted", estimateNumber: `AS-${1000 + i}`, style: "Utility", size: "10x12", createdAt: "2026-09-20T15:00:00Z", updatedAt: "2026-10-01T15:00:00Z" } : null,
  };
});
const ROWS = DEALS.filter((d) => d.short_code).slice(0, 4).map((d) => ({
  short_code: d.short_code, created_at: d.created_at, updated_at: d.updated_at, status: "sent",
  contact: { name: d.contact.name, email: d.contact.email }, contact_id: null, sel_style: "Utility", sel_size: "10x12",
  ghl_estimate_number: null, inventory_unit_id: null, image_url: null, ss_quote_number: d.design.estimateNumber, ss_quote_pdf_url: null,
  ss_invoice_sent_at: null, total_cents: d.value_cents, expected_close_date: null,
}));

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const { ok, failed } = reporter();
const shots = shotsDir("pipeline-board");
const PREFIX = process.env.SS_SHOT_PREFIX || "board-";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;
const { browser, ctx: unused } = await launch({ width: 1440, height: 1000 });
await unused.close();

// `world.deals`, when set, is what crm_deals_list answers instead of DEALS (Q changes it mid-run).
async function open(path, viewport, world = {}) {
  const calls = [];
  const moves = [];
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) return json(route, rpc[1] === "log_error" ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: OWN, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/designs")) return json(route, ROWS);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { ok: true, configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, entitlement: { granted: [], paid: [], features: { crm: true }, status: "active", locked: false } });
    }
    if (url.includes("/portal-settings")) {
      calls.push(body.action);
      if (body.action === "crm_deal_move") moves.push(body);
      if (body.action === "status") {
        return json(route, { ok: true, clientId: OWN, role: "owner", operatorMode: false, access: null, prefs: null,
          phoneStatus: "off", configured: false, invoiceInGhl: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      }
      if (body.action === "get_profile") return json(route, { ok: true, fullName: "Pat Owner", phone: null, needsDetails: false });
      if (body.action === "crm_pipelines_list") {
        return json(route, { ok: true, pipelines: [PIPE], statuses: STATUSES, team: TEAM, canManage: true, canWrite: true, ownOnly: false, me: USER.id });
      }
      if (body.action === "crm_deals_list") return json(route, { ok: true, deals: world.deals || DEALS, capped: false });
      if (body.action === "crm_deal_move") {
        const d = DEALS.find((x) => x.id === body.id);
        return json(route, { ok: true, moved: true, stage_entered_at: new Date().toISOString(), kind: "open", status_id: d ? d.status_id : null });
      }
      if (body.action === "crm_deal_set_status") return json(route, { error: "Statuses are set automatically." }, 409);
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  const booted = await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 })
    .then(() => true, () => false);
  if (!booted) throw new Error(`the portal never booted on ${path}; refusing to report the rest as passes. ${errors.join(" | ")}`);
  return { ctx, page, errors, calls, moves };
}

// Waits for every card to be on the board.
async function boardReady(page) {
  await page.waitForFunction((n) => document.querySelectorAll("[data-ss-deal]").length >= n, DEALS.length, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
}

// Everything the "no scroll bar" claim rests on, measured in the page.
const measure = (page) => page.evaluate(() => {
  const de = document.documentElement;
  const board = document.querySelector("[data-ss-board-wide]");
  const inner = document.querySelector(".ss-inner");
  const br = board ? board.getBoundingClientRect() : null;
  const stages = [...document.querySelectorAll("[data-ss-stage]")].map((el) => el.getBoundingClientRect());
  // Anything inside the board section that scrolls, or could: overflow auto/scroll AND more
  // content than room. A clipped ellipsis (overflow hidden) is not a scroll bar.
  const scrollers = [];
  const root = document.querySelector("[data-ss-sales-pipelines]");
  (root ? [root, ...root.querySelectorAll("*")] : []).forEach((el) => {
    const cs = getComputedStyle(el);
    const can = /(auto|scroll)/.test(cs.overflowX + " " + cs.overflowY);
    if (can && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) scrollers.push(el.tagName + "." + (el.getAttribute("style") || "").slice(0, 60));
  });
  const rows = [...new Set(stages.map((r) => Math.round(r.top)))].length;
  const narrowest = stages.length ? Math.min(...stages.map((r) => r.width)) : 0;
  return {
    docScroll: de.scrollWidth, docClient: de.clientWidth,
    boardScroll: board ? board.scrollWidth : -1, boardClient: board ? board.clientWidth : -1,
    stagesInside: !!br && stages.every((r) => r.left >= br.left - 1 && r.right <= br.right + 1),
    stageCount: stages.length, rows, narrowest: Math.round(narrowest),
    cols: board ? Number(board.getAttribute("data-ss-board-cols")) : null,
    innerMax: inner ? getComputedStyle(inner).maxWidth : null,
    boardWidth: br ? Math.round(br.width) : 0,
    innerWidth: inner ? Math.round(inner.getBoundingClientRect().width) : 0,
    // What .ss-inner could be at most: its parent's content box.
    bodyContent: inner ? (() => { const b = inner.parentElement, cs = getComputedStyle(b);
      return Math.round(b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)); })() : 0,
    scrollers,
  };
});
const visibleStatuses = (page) => page.evaluate(() => [...document.querySelectorAll("[data-ss-deal] [data-ss-status-pill]")].map((el) => el.textContent.trim()));
const cardCount = (page) => page.evaluate(() => {
  const t = [...document.querySelectorAll("[data-ss-sales-pipelines] span")].map((s) => s.textContent.trim()).find((s) => /\bcards?$/.test(s));
  return t || null;
});

try {
  // ── W ── width, at the three desktop sizes and a phone
  for (const [w, h] of [[1280, 900], [1440, 900], [1920, 1080], [390, 844]]) {
    const { ctx, page, errors } = await open("/portal/designs/pipeline", { width: w, height: h });
    await boardReady(page);
    const m = await measure(page);
    const tag = `W${w}`;
    ok(`${tag}a all eight stages and ${DEALS.length} cards are on the board`, m.stageCount === 8 && (await page.locator("[data-ss-deal]").count()) === DEALS.length, JSON.stringify({ stages: m.stageCount }));
    ok(`${tag}b the page has no sideways scroll`, m.docScroll <= m.docClient, `${m.docScroll} <= ${m.docClient}`);
    ok(`${tag}c the board has no sideways scroll`, m.boardScroll <= m.boardClient, `${m.boardScroll} <= ${m.boardClient}`);
    ok(`${tag}d nothing inside the board scrolls (no inner scroll bar, sideways or down)`, m.scrollers.length === 0, m.scrollers.join(" | "));
    ok(`${tag}e every stage sits inside the board`, m.stagesInside, JSON.stringify(m));
    if (w >= 1280) {
      ok(`${tag}f the page's 1240px cap is lifted while the board shows`, m.innerMax === "none", `${m.innerMax}, board ${m.boardWidth}px`);
      ok(`${tag}g the page fills the width it has and the board fills the page's card`, m.innerWidth >= m.bodyContent - 1 && m.boardWidth >= m.innerWidth - 44,
        `inner ${m.innerWidth} of ${m.bodyContent}, board ${m.boardWidth}`);
      if (w >= 1600) ok(`${tag}g2 so at ${w} the board is wider than the old 1240px box`, m.boardWidth > 1240, `${m.boardWidth}px`);
    }
    ok(`${tag}h as many stages go across as fit at 140px, the rest wrap below (cols ${m.cols}, rows ${m.rows}, narrowest ${m.narrowest}px)`,
      m.cols === Math.min(8, Math.floor((m.boardWidth + 8) / 148)) && m.rows === Math.ceil(8 / m.cols) && m.narrowest >= (w < 600 ? 100 : 140),
      JSON.stringify({ cols: m.cols, rows: m.rows, narrowest: m.narrowest, board: m.boardWidth }));
    if (w === 1920) ok(`${tag}i at 1920 all eight stages go across in one row`, m.rows === 1, `${m.rows} rows`);
    ok(`${tag}z no page errors`, errors.length === 0, errors.join(" | "));
    await page.screenshot({ path: join(shots, `${PREFIX}${w}.png`), fullPage: true });
    await ctx.close();
  }

  // ── F ── the status filter, and R ── read-only statuses, at 1440
  {
    const { ctx, page, errors, calls, moves } = await open("/portal/designs/pipeline", { width: 1440, height: 1000 });
    await boardReady(page);
    const all = await visibleStatuses(page);
    // The control sits beside the search, before Owner.
    const order = await page.evaluate(() => {
      const x = (el) => (el ? el.getBoundingClientRect().left : -1);
      return { search: x(document.querySelector('[data-ss-sales-pipelines] input[placeholder^="Search"]')), status: x(document.querySelector("[data-ss-status-filter-button]")),
        owner: x([...document.querySelectorAll("[data-ss-sales-pipelines] select")].find((s) => [...s.options].some((o) => o.text === "Everyone"))) };
    });
    ok("F0 the status filter sits right of the search and left of Owner", order.search >= 0 && order.status > order.search && order.owner > order.status, JSON.stringify(order));
    ok("F1 closed and unfiltered it says All statuses", (await page.locator("[data-ss-status-filter-button]").innerText()).includes("All statuses"));

    await page.locator("[data-ss-status-filter-button]").click();
    await page.locator(`[data-ss-status-option="${ST["Estimate Sent"]}"] input`).check();
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(shots, `${PREFIX}filter-menu.png`) });
    let s = await visibleStatuses(page);
    const nEst = all.filter((x) => x === "Estimate Sent").length;
    ok("F2 show only Estimate Sent: every card left is Estimate Sent", s.length === nEst && s.every((x) => x === "Estimate Sent"), `${s.length} cards: ${[...new Set(s)].join(", ")}`);
    ok("F3 the count says how many of how many", (await cardCount(page)) === `${nEst} of ${DEALS.length} cards`, String(await cardCount(page)));

    await page.locator(`[data-ss-status-option="${ST["Payment Received"]}"] input`).check();
    await page.waitForTimeout(200);
    s = await visibleStatuses(page);
    const nPaid = all.filter((x) => x === "Payment Received").length;
    ok("F4 one or many: Estimate Sent and Payment Received together", s.length === nEst + nPaid && s.every((x) => x === "Estimate Sent" || x === "Payment Received"), `${s.length} cards`);
    ok("F5 the closed control names the first and counts the rest", (await page.locator("[data-ss-status-filter-button]").innerText()).trim().startsWith("Estimate Sent +1"));

    await page.getByRole("button", { name: "Hide", exact: true }).click();
    await page.waitForTimeout(200);
    s = await visibleStatuses(page);
    ok("F6 hide: the same two statuses are left out and everything else stays", s.length === DEALS.length - nEst - nPaid && !s.includes("Estimate Sent") && !s.includes("Payment Received"), `${s.length} cards`);
    ok("F7 the closed control says what it hides", (await page.locator("[data-ss-status-filter-button]").innerText()).trim().startsWith("All but Estimate Sent"));
    await page.screenshot({ path: join(shots, `${PREFIX}filter-hide.png`) });

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Clear the status filter" }).click();
    await page.waitForTimeout(200);
    s = await visibleStatuses(page);
    ok("F8 the × clears it: every card is back", s.length === DEALS.length, `${s.length} cards`);
    ok("F9 and the count is the plain total again", (await cardCount(page)) === `${DEALS.length} cards`, String(await cardCount(page)));

    // ── R ──
    const pills = await page.evaluate(() => ({
      selects: document.querySelectorAll('[data-ss-sales-pipelines] select[aria-label="Status"]').length,
      spans: document.querySelectorAll("[data-ss-deal] span[data-ss-status-pill]").length,
      hint: (([...document.querySelectorAll("[data-ss-sales-pipelines] p")].find((p) => /Drag a card/.test(p.textContent)) || {}).textContent) || "",
    }));
    ok("R1 the card status pill is a label, not a control", pills.selects === 0 && pills.spans === DEALS.length, JSON.stringify({ selects: pills.selects, spans: pills.spans }));
    ok("R2 the hint no longer says to click a status, and says they're automatic", !/click its status/i.test(pills.hint) && /Statuses are set automatically/.test(pills.hint), pills.hint);

    // A drag moves the stage and keeps the status.
    const deal = DEALS[0];
    const before = await page.locator(`[data-ss-deal="${deal.id}"] [data-ss-status-pill]`).innerText();
    const target = PIPE.stages[3];   // first row at every desktop width
    // Dropped near the TOP of the target column, which is on screen: aimed at the middle of a tall
    // column, Playwright scrolls mid-drag and the drag starts on whichever card slid under the pointer.
    await page.locator(`[data-ss-deal="${deal.id}"]`).dragTo(page.locator(`[data-ss-stage="${target.id}"]`), { targetPosition: { x: 30, y: 12 } });
    await page.waitForTimeout(500);
    const inTarget = await page.locator(`[data-ss-stage="${target.id}"] [data-ss-deal="${deal.id}"]`).count();
    const landed = await page.evaluate((id) => { const c = document.querySelector(`[data-ss-deal="${id}"]`); const st = c && c.closest("[data-ss-stage]"); return st ? st.getAttribute("data-ss-stage") : null; }, deal.id);
    const after = await page.locator(`[data-ss-deal="${deal.id}"] [data-ss-status-pill]`).innerText();
    ok("R3 dragging a card to another stage still works (the move is saved)", inTarget === 1 && moves.length === 1 && moves[0].stageId === target.id && moves[0].id === deal.id,
      `in target ${inTarget}; landed in ${landed}; target ${target.id}; moves ${JSON.stringify(moves)}`);
    ok("R4 and the card keeps its status", after === before, `${before} -> ${after}`);
    ok("R5 nothing on the board asked to set a status", !calls.includes("crm_deal_set_status"), calls.join(","));

    // The expected close date still opens from the card (it moved into the status row), and its
    // click is its own: it does not open the customer.
    const at = await page.evaluate(() => location.pathname);
    await page.locator(`[data-ss-deal="${DEALS[2].id}"] button[title="Set an expected close date"]`).click();
    await page.waitForTimeout(200);
    const dateOpen = await page.locator(`[data-ss-deal="${DEALS[2].id}"] input[type="date"]`).count();
    const stayed = (await page.evaluate(() => location.pathname)) === at;
    const dragOff = await page.locator(`[data-ss-deal="${DEALS[2].id}"]`).getAttribute("draggable");
    ok("R7 '+ close' opens the date field on the card, and not the customer", dateOpen === 1 && stayed, `date field ${dateOpen}, stayed ${stayed}`);
    ok("R8 and the card is not draggable while its date is being typed", dragOff === "false", String(dragOff));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    ok("R9 no page errors on the board", errors.length === 0, errors.join(" | "));
    // A click on the pill opens the customer, like any other part of the card. (The record page it
    // lands on is fed nothing here, so its errors are not this harness's business.)
    await page.locator(`[data-ss-deal="${DEALS[11].id}"] [data-ss-status-pill]`).click();
    await page.waitForTimeout(600);
    const path = await page.evaluate(() => location.pathname);
    ok("R6 a click on the pill opens the customer", /\/contacts\/c-/.test(path), path);
    await ctx.close();
  }

  // ── Q ── Refresh on the hub's board
  {
    const world = {};
    const { ctx, page, errors, calls } = await open("/portal/contacts", { width: 1440, height: 1000 }, world);
    await boardReady(page);
    const count = (a) => calls.filter((x) => x === a).length;
    const btn = page.locator("[data-ss-contacts-hub] [data-ss-sales-pipelines] [data-ss-board-refresh]");
    const shown = (await btn.count()) === 1 && (await btn.isVisible());
    ok("Q1 the board inside the Contacts hub has a visible Refresh", shown, `count ${await btn.count()}`);
    if (shown) {
      const before = { deals: count("crm_deals_list"), pipes: count("crm_pipelines_list") };
      // A card added since the board loaded (someone else's new lead).
      const NEW = { ...DEALS[0], id: uuid(499), short_code: null, title: "Lead", stage_id: PIPE.stages[0].id,
        contact: { ...DEALS[0].contact, id: uuid(599), name: "Quinn Fresh", email: "quinn@example.test" }, design: null };
      world.deals = [...DEALS, NEW];
      await btn.click();
      await page.waitForFunction((id) => !!document.querySelector(`[data-ss-deal="${id}"]`), NEW.id, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(300);
      const after = { deals: count("crm_deals_list"), pipes: count("crm_pipelines_list") };
      ok("Q2 a press asks for this board's cards again, and for the pipelines", after.deals === before.deals + 1 && after.pipes === before.pipes + 1,
        JSON.stringify({ before, after }));
      const fresh = await page.locator(`[data-ss-deal="${NEW.id}"]`).count();
      ok("Q3 and draws what came back: the new card is on the board, with every card it had", fresh === 1 && (await page.locator("[data-ss-deal]").count()) === DEALS.length + 1
        && (await page.locator(`[data-ss-stage="${PIPE.stages[0].id}"] [data-ss-deal="${NEW.id}"]`).count()) === 1, `new ${fresh}`);
      await page.screenshot({ path: join(shots, `${PREFIX}refresh.png`) });
    }
    ok("Q4 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── The Design list keeps the page's ordinary width ──
  {
    const { ctx, page } = await open("/portal/designs/list", { width: 1920, height: 1000 });
    await page.waitForFunction(() => document.querySelector('[data-ss-designs-view="list"]'), null, { timeout: 20000 }).catch(() => {});
    const max = await page.evaluate(() => getComputedStyle(document.querySelector(".ss-inner")).maxWidth);
    ok("L1 the Design list keeps the 1240px cap", max === "1240px", max);
    await ctx.close();
  }
} finally {
  await browser.close();
}
const bad = failed();
console.log(bad.length ? `\n${bad.length} check(s) failed` : "\nall checks passed");
process.exit(bad.length ? 1 : 0);
