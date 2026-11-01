// LOST IS A STATUS, NOT A COLUMN — and the board opens on work in play (migration 352, Carolyn
// 2026-10-26), driven for real on the COMPILED portal.
//
// What she asked for, and what each check holds to:
//   A. There is no Won or Lost column. "We will not be using a column called lost ... it should be
//      a status", and "Won should also not be a stage ... Invoiced indicates a sold job." The stage
//      editor offers no kind at all, and a new pipeline is created with ONE stage.
//   B. The board opens on live work: "by default LOST and Payment received, scheduling and
//      delivered should be hidden." The three late statuses are excluded by default, the closed
//      Status control says so ("All but ..."), lost cards are not drawn, and the count says how
//      many of how many — nothing disappears silently.
//   C. Marking a card lost keeps its column. "LOST stays in the column it was when marking lost."
//      Mark lost asks why (the pipeline's own reasons), sends crm_deal_mark_lost and NOT a move,
//      the card leaves the board, and Show lost brings it back IN THE SAME STAGE wearing Lost
//      instead of its status, with the reason. Reopen puts it back in play.
//   D. A drag is only ever a move: it sends no lost reason, and dragging a lost card does not
//      quietly reopen it.
//   E. The appointment chip: a card whose customer has a booking shows it, one without shows
//      nothing, and it is not a status (the status pill is untouched).
//
// Against the build before 352, A2/B/C/E fail: the editor has a Kind drop-down, the board opens
// showing everything, Mark lost does not exist (lost was a drag into a column), and no card has an
// appointment.
//
//   node tests/harness/pipelineLostStatus.mjs      (exit 0 = every check held)
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine). Every name,
// email and amount is made up, per the public-repo rule. SS_SHOTS=<dir> keeps the screenshots.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, shotsDir, collectErrors, serveAppRoutes } from "./lib.mjs";

const OWN = "acme-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000031", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Carolyn's ladder as 352 seeds it: Contact Made in place of the unreachable Appt Set, and every
// rung carrying the EVENT that sets it — which is what the default view keys on, never the name.
const STATUS_DEFS = [
  ["New Lead", "#64748B", "design_submitted"], ["Contact Made", "#0EA5E9", "contact_made"],
  ["Estimate Sent", "#6366F1", "estimate_sent"], ["Accepted", "#16A34A", "estimate_accepted"],
  ["Invoiced", "#14B8A6", "invoiced"], ["Payment Received", "#84CC16", "paid_in_full"],
  ["Scheduling", "#F59E0B", "build_scheduled"], ["Delivered", "#0F766E", "delivered"],
];
const STATUSES = STATUS_DEFS.map(([name, color, triggerEvent], i) => ({ id: uuid(100 + i), name, color, position: (i + 1) * 1024, triggerEvent }));
const ST = Object.fromEntries(STATUSES.map((s) => [s.name, s.id]));
// THE THREE THE BOARD HIDES, by event. Renaming any of them must not change what is hidden.
const DONE = ["Payment Received", "Scheduling", "Delivered"];

// Four stages, all of them steps. No Won, no Lost: 352 made both impossible.
const STAGE_NAMES = ["New Incoming", "Attempting Contact", "Nurturing - Warm", "Quoted"];
const PIPE = {
  id: uuid(200), name: "Shed Deals", position: 1024, lostReasons: ["Price", "Went with a competitor", "Timing"],
  seedKind: "shed_deals", feedsDesigns: true, mirrorsStatuses: false,
  stages: STAGE_NAMES.map((name, i) => ({ id: uuid(300 + i), name, color: "#64748B", kind: "open", position: (i + 1) * 1024, statusId: null })),
};
const STAGE = Object.fromEntries(PIPE.stages.map((s) => [s.name, s.id]));

// Eight cards. Two are already lost (one of them in the middle of the board, which is the whole
// point of C), three are at a late status the board hides, and one has an appointment.
const SOON = new Date(Date.now() + 3 * 86400000).toISOString();
const CARDS = [
  ["Avery Stone", "Nurturing - Warm", "Estimate Sent", null, null],
  ["Blake Rivers", "Attempting Contact", "Contact Made", null, SOON],
  ["Casey Dale", "Nurturing - Warm", "New Lead", null, null],
  ["Drew Brooks", "Quoted", "Accepted", null, null],
  ["Emery Lane", "Nurturing - Warm", "Estimate Sent", "Price", null],
  ["Finley Fields", "New Incoming", "New Lead", "Timing", null],
  ["Gray Hart", "Quoted", "Payment Received", null, null],
  ["Harper Woods", "Quoted", "Delivered", null, null],
];
const DEALS = CARDS.map(([name, stage, status, lost, appt], i) => ({
  id: uuid(400 + i), pipeline_id: PIPE.id, stage_id: STAGE[stage], status_id: ST[status],
  contact_id: uuid(500 + i), short_code: null, title: "Lead", custom: {},
  value_cents: 450000 + i * 10100, expected_close_date: null, next_follow_up_at: null,
  lost_reason: lost, lost_at: lost ? "2026-10-20T15:00:00Z" : null, won_at: null, source: "manual",
  stage_entered_at: new Date(Date.now() - (i % 9) * 86400000).toISOString(),
  created_at: "2026-09-20T15:00:00Z", updated_at: "2026-10-01T15:00:00Z",
  next_meeting: appt ? { startsAt: appt, endsAt: appt, typeName: "Site visit" } : null,
  contact: { id: uuid(500 + i), name, company: null, phone: null, email: `${name.split(" ")[0].toLowerCase()}@example.test`, ownerUserId: USER.id },
  design: null,
}));
const TEAM = [{ userId: USER.id, name: "Pat Owner", title: null }];
const nLost = DEALS.filter((d) => d.lost_at).length;
const nDone = DEALS.filter((d) => !d.lost_at && DONE.some((n) => ST[n] === d.status_id)).length;
const nOpen = DEALS.length - nLost - nDone;

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const { ok, failed } = reporter();
const shots = shotsDir("pipeline-lost-status");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;
const { browser, ctx: unused } = await launch({ width: 1440, height: 1100 });
await unused.close();

async function open(path) {
  const calls = [];       // every portal-settings action, in order
  const sent = [];        // the whole body of the writes this suite is about
  const live = DEALS.map((d) => ({ ...d }));   // the server's copy, which the writes change
  const made = [];        // crm_pipeline_save creates
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: "block" });
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
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { ok: true, configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, entitlement: { granted: [], paid: [], features: { crm: true }, status: "active", locked: false } });
    }
    if (url.includes("/portal-settings")) {
      calls.push(body.action);
      if (body.action === "status") {
        return json(route, { ok: true, clientId: OWN, role: "owner", operatorMode: false, access: null, prefs: null,
          phoneStatus: "off", configured: false, invoiceInGhl: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      }
      if (body.action === "get_profile") return json(route, { ok: true, fullName: "Pat Owner", phone: null, needsDetails: false });
      if (body.action === "crm_pipelines_list") {
        return json(route, { ok: true, pipelines: [PIPE], statuses: STATUSES, team: TEAM, canManage: true, canWrite: true, ownOnly: false, me: USER.id });
      }
      if (body.action === "crm_deals_list") return json(route, { ok: true, deals: live, capped: false });
      if (body.action === "crm_deal_mark_lost") {
        sent.push(body);
        const d = live.find((x) => x.id === body.id);
        if (d) { d.lost_at = new Date().toISOString(); d.lost_reason = body.lostReason; }
        return json(route, { ok: true, lost: true, lost_at: d ? d.lost_at : null, lost_reason: body.lostReason, stage_id: d ? d.stage_id : null });
      }
      if (body.action === "crm_deal_reopen") {
        sent.push(body);
        const d = live.find((x) => x.id === body.id);
        if (d) { d.lost_at = null; d.lost_reason = null; }
        return json(route, { ok: true, reopened: true, stage_id: d ? d.stage_id : null });
      }
      if (body.action === "crm_deal_move") {
        sent.push(body);
        const d = live.find((x) => x.id === body.id);
        if (d) d.stage_id = body.stageId;
        return json(route, { ok: true, moved: true, stage_entered_at: new Date().toISOString(), kind: "open", status_id: d ? d.status_id : null });
      }
      if (body.action === "crm_pipeline_save") { made.push(body); return json(route, { ok: true, id: uuid(900) }); }
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  const booted = await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 })
    .then(() => true, () => false);
  if (!booted) throw new Error(`the portal never booted on ${path}; refusing to report the rest as passes. ${errors.join(" | ")}`);
  return { ctx, page, errors, calls, sent, made, live };
}

const ready = async (page, n = 1) => {
  await page.waitForFunction((k) => document.querySelectorAll("[data-ss-deal]").length >= k, n, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
};
// Which card is in which column, by the customer's name: { "Avery Stone": "Nurturing - Warm", … }
const layout = (page) => page.evaluate(() => {
  const out = {};
  document.querySelectorAll("[data-ss-stage]").forEach((col) => {
    const stage = (col.querySelector("span") || {}).textContent || "";
    col.querySelectorAll("[data-ss-deal]").forEach((card) => {
      const head = card.querySelector("span");
      if (head) out[head.textContent.trim()] = stage.trim();
    });
  });
  return out;
});
const statusText = (page) => page.evaluate(() => (document.querySelector("[data-ss-status-filter-button]") || {}).innerText || "");
const countText = (page) => page.evaluate(() => {
  const t = [...document.querySelectorAll("[data-ss-sales-pipelines] span")].map((s) => s.textContent.trim()).find((s) => /\bcards?$/.test(s));
  return t || null;
});
const pillOf = (page, name) => page.evaluate((who) => {
  const card = [...document.querySelectorAll("[data-ss-deal]")].find((c) => (c.querySelector("span") || {}).textContent.trim() === who);
  if (!card) return null;
  const lost = card.querySelector("[data-ss-lost-pill]");
  const status = card.querySelector("[data-ss-status-pill]");
  return { lost: lost ? lost.textContent.trim() : null, lostTitle: lost ? lost.getAttribute("title") : null,
           status: status ? status.textContent.trim() : null,
           appt: (card.querySelector("[data-ss-deal-appt]") || {}).textContent || null,
           apptTitle: (card.querySelector("[data-ss-deal-appt]") || {}).title || null };
}, name);

const HUB = "/contacts?view=p-" + PIPE.id.slice(0, 8);

try {
  // ── B. WHAT THE BOARD OPENS ON ───────────────────────────────────────────────────────────
  {
    const { ctx, page, errors } = await open("/contacts");
    await ready(page, nOpen);
    const seen = await layout(page);
    const names = Object.keys(seen);
    ok(`B1 the board opens on work in play: ${nOpen} of ${DEALS.length} cards`,
      names.length === nOpen, `${names.length} cards: ${names.join(", ")}`);
    ok("B2 a lost card is not drawn", !names.includes("Emery Lane") && !names.includes("Finley Fields"), names.join(", "));
    ok("B3 nor is one that is paid, scheduled or delivered", !names.includes("Gray Hart") && !names.includes("Harper Woods"), names.join(", "));
    const t = await statusText(page);
    ok("B4 and the Status control SAYS it is hiding them, rather than hiding them quietly",
      /^All but /.test(t.trim()) && /\+2/.test(t), JSON.stringify(t));
    ok("B5 the count says how many of how many", (await countText(page)) === `${nOpen} of ${DEALS.length} cards`, String(await countText(page)));
    const lostBox = await page.locator("[data-ss-show-lost]").count();
    ok("B6 there is a Show lost control, and it knows how many there are", lostBox === 1
      && (await page.evaluate(() => document.querySelector("[data-ss-show-lost]").parentElement.textContent)).includes(`(${nLost})`),
      await page.evaluate(() => document.querySelector("[data-ss-show-lost]") ? document.querySelector("[data-ss-show-lost]").parentElement.textContent : "absent"));
    ok("B7 no Won or Lost column exists", !Object.values(seen).some((s) => /^(WON|LOST)$/i.test(s)) && (await page.locator("[data-ss-stage]").count()) === STAGE_NAMES.length,
      JSON.stringify([...new Set(Object.values(seen))]));
    await page.screenshot({ path: join(shots, "lost-01-default.png"), fullPage: true }).catch(() => {});
    ok("B8 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── C. SHOW LOST, MARK LOST, REOPEN ──────────────────────────────────────────────────────
  {
    const { ctx, page, errors, calls, sent } = await open("/contacts");
    await ready(page, nOpen);

    // Show lost: the two lost cards come back WHERE THEY DIED.
    await page.locator("[data-ss-show-lost]").check();
    await page.waitForTimeout(400);
    const withLost = await layout(page);
    ok("C1 Show lost brings a lost card back in the stage it was marked in",
      withLost["Emery Lane"] === "Nurturing - Warm" && withLost["Finley Fields"] === "New Incoming",
      JSON.stringify({ emery: withLost["Emery Lane"], finley: withLost["Finley Fields"] }));
    const p = await pillOf(page, "Emery Lane");
    ok("C2 a lost card wears Lost with its reason, and NOT its status as well",
      p && /^Lost/.test(p.lost || "") && /Price/.test(p.lost || "") && p.status === null, JSON.stringify(p));

    // Mark lost: the reason is asked for, and the card does not move.
    const before = (await layout(page))["Avery Stone"];
    await page.locator('[data-ss-card-lost="' + uuid(400) + '"]').click();
    await page.waitForTimeout(300);
    const asked = await page.evaluate(() => document.body.innerText.includes("Why was it lost?"));
    const reasons = await page.evaluate(() => [...document.querySelectorAll('input[name="ss-lost"]')].length);
    ok("C3 Mark lost asks why, offering the pipeline's own reasons plus Other", asked && reasons === PIPE.lostReasons.length + 1,
      JSON.stringify({ asked, reasons }));
    await page.screenshot({ path: join(shots, "lost-02-why.png") }).catch(() => {});
    await page.evaluate(() => {
      const r = [...document.querySelectorAll('input[name="ss-lost"]')][1];
      if (r) r.click();
    });
    await page.locator("button", { hasText: "Mark lost" }).last().click();
    await page.waitForTimeout(500);
    const write = sent.filter((x) => x.action === "crm_deal_mark_lost");
    ok("C4 it sends crm_deal_mark_lost with the reason — and no move",
      write.length === 1 && write[0].id === uuid(400) && write[0].lostReason === PIPE.lostReasons[1]
      && !sent.some((x) => x.action === "crm_deal_move"), JSON.stringify(sent));
    const after = await layout(page);
    ok("C5 the card STAYS IN ITS COLUMN and now reads Lost", after["Avery Stone"] === before
      && /^Lost/.test(((await pillOf(page, "Avery Stone")) || {}).lost || ""),
      JSON.stringify({ before, after: after["Avery Stone"], pill: await pillOf(page, "Avery Stone") }));

    // Untick Show lost and it goes; tick it and it is back in the same place.
    await page.locator("[data-ss-show-lost]").uncheck();
    await page.waitForTimeout(400);
    ok("C6 with Show lost off, the card just marked lost leaves the board",
      !Object.keys(await layout(page)).includes("Avery Stone"), Object.keys(await layout(page)).join(", "));
    await page.locator("[data-ss-show-lost]").check();
    await page.waitForTimeout(400);

    // Reopen.
    await page.locator('[data-ss-card-reopen="' + uuid(400) + '"]').click();
    await page.waitForTimeout(500);
    const re = sent.filter((x) => x.action === "crm_deal_reopen");
    const back = await pillOf(page, "Avery Stone");
    ok("C7 Reopen sends crm_deal_reopen and the card wears its status again, in the same column",
      re.length === 1 && re[0].id === uuid(400) && back && back.lost === null && back.status === "Estimate Sent"
      && (await layout(page))["Avery Stone"] === before,
      JSON.stringify({ re, back, where: (await layout(page))["Avery Stone"] }));
    ok("C8 nothing on the board asked to set a status by hand", !calls.includes("crm_deal_set_status"), calls.join(","));
    ok("C9 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── D. A DRAG IS ONLY EVER A MOVE ────────────────────────────────────────────────────────
  {
    const { ctx, page, errors, sent } = await open("/contacts");
    await ready(page, nOpen);
    await page.locator("[data-ss-show-lost]").check();
    await page.waitForTimeout(400);
    const card = page.locator('[data-ss-deal="' + uuid(404) + '"]');       // Emery Lane, lost
    const target = page.locator('[data-ss-stage="' + STAGE["Quoted"] + '"]');
    await card.hover();
    await page.mouse.down();
    await target.hover();
    await page.mouse.up();
    await page.waitForTimeout(500);
    const moves = sent.filter((x) => x.action === "crm_deal_move");
    ok("D1 a drag sends the stage and NO lost reason",
      moves.length === 1 && moves[0].stageId === STAGE["Quoted"] && !("lostReason" in moves[0]), JSON.stringify(moves));
    const p = await pillOf(page, "Emery Lane");
    ok("D2 and dragging a lost card does not quietly reopen it", p && /^Lost/.test(p.lost || ""), JSON.stringify(p));
    ok("D3 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── E. THE APPOINTMENT CHIP ──────────────────────────────────────────────────────────────
  {
    const { ctx, page, errors } = await open("/contacts");
    await ready(page, nOpen);
    const withAppt = await pillOf(page, "Blake Rivers");
    const without = await pillOf(page, "Casey Dale");
    ok("E1 a card whose customer has a booking shows it", withAppt && /\d/.test(withAppt.appt || ""), JSON.stringify(withAppt));
    ok("E2 and says what and when in full", withAppt && /Site visit/.test(withAppt.apptTitle || ""), JSON.stringify(withAppt && withAppt.apptTitle));
    ok("E3 a card without one shows nothing", without && without.appt === null, JSON.stringify(without));
    ok("E4 an appointment is NOT a status: the card keeps the status it had",
      withAppt && withAppt.status === "Contact Made", JSON.stringify(withAppt));
    await page.screenshot({ path: join(shots, "lost-03-appt.png"), fullPage: true }).catch(() => {});
    ok("E5 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── A. NO STAGE IS AN OUTCOME ANY MORE ───────────────────────────────────────────────────
  {
    const { ctx, page, errors, made } = await open("/contacts");
    await ready(page, nOpen);
    await page.locator("button", { hasText: "Edit stages" }).first().click();
    await page.waitForTimeout(400);
    const kinds = await page.evaluate(() => [...document.querySelectorAll('select[aria-label="Kind"]')].length);
    const rows = await page.evaluate(() => [...document.querySelectorAll('input[aria-label="Stage name"]')].length);
    ok("A1 the stage editor lists every stage", rows === STAGE_NAMES.length, `${rows} rows`);
    ok("A2 and offers no Kind at all — a stage is a step, never Won or Lost", kinds === 0, `${kinds} kind controls`);
    const reasons = await page.evaluate(() => {
      const el = [...document.querySelectorAll("textarea")].pop();
      return el ? el.value : null;
    });
    ok("A3 the pipeline keeps its lost reasons, which Mark lost offers", (reasons || "").includes("Price"), JSON.stringify(reasons));
    await page.screenshot({ path: join(shots, "lost-04-editor.png") }).catch(() => {});
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    await page.locator("button", { hasText: "Pipeline" }).first().click();
    await page.waitForTimeout(300);
    const blurb = await page.evaluate(() => document.body.innerText);
    ok("A4 a new pipeline is described as starting with ONE stage, not New/Won/Lost",
      /starts with one stage/i.test(blurb) && !/Won and Lost/i.test(blurb), JSON.stringify((/It starts[^.]*\./.exec(blurb) || [])[0] || null));
    ok("A5 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
}

const bad = failed();
console.log(bad.length ? `\n${bad.length} check(s) failed` : "\nall checks passed");
process.exit(bad.length ? 1 : 0);
