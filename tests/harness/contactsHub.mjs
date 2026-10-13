// The Contacts hub (Carolyn 2026-10-12), driven for real on the COMPILED portal.
//
// "Let's have one tab and we can have contacts, and we can have this instead of list is designs,
// and then we have pipelines." One sidebar item, Contacts; inside it a tab row: each pipeline in
// the account's order from the left, at most five pipeline positions (the fifth a drop-down for
// the rest), and Contacts | Design list as a rounded bubble at the far right (Ahsan 2026-10-13;
// Carolyn's 10-12 order had them first, on the left); never a scroll bar; a card opens its
// customer INSIDE Contacts and Back returns to the exact board. Replaces pipelineDefaultView.mjs, whose List | Pipeline toggle and
// "How the Pipeline tab opens" card this replaced; its scenarios carry on here.
//
//   A. CRM, nothing saved: /contacts opens on the FIRST pipeline, the address follows, one
//      sidebar item (no Pipeline), no pipeline <select>, the board's own controls still there.
//   B. 3 pipelines at 1280 and 1920: every one is a tab, in one line, no scroll bar anywhere.
//   C. 8 pipelines at 1280 and 1920: four tabs, the fifth is the drop-down wearing the fifth's name;
//      ▾ lists the rest; picking the seventh opens it in one click, and the fifth tab wears its name.
//   D. 8 pipelines in a narrow window: more fold into the drop-down, still one line, no scroll.
//   P. The bubble (Ahsan 2026-10-13): at 1440 and 1280, with 3 and 8 pipelines, it sits right of
//      the last pipeline tab on the same line, nothing overlaps or scrolls, and exactly one thing
//      looks picked (the open pipeline, or the open part of the bubble); arrow keys stay inside a
//      group; at 600px it has a line of its own above the pipelines, at the right; without the
//      CRM, 🔒 Contacts keeps its padlock inside it; a Crew Leader's holds the Design list alone.
//   E. No CRM: the Design list, with 🔒 Contacts and 🔒 Pipeline; the padlocked tabs sell the CRM.
//   F. A designs-only role (Crew Leader): the Design list and nothing else.
//   G. The CRM answer held ~1.5 s: the hub waits, and a MutationObserver watching from the first
//      render records that the Design list was NEVER drawn before the board.
//   H. A saved pick wins: contactsView "designs", contactsView "p-<second>", and the old Pipeline
//      tab's designsView "list" (the Design list).
//   I. Old addresses: /designs/list, /pipelines/<id>, /designs land in the
//      hub, and the address bar is rewritten to the hub's. The same from their OLD /portal
//      addresses (/portal/designs/list, /portal/contacts/p-…): the host's 301 (served here from
//      _redirects by serveAppRoutes), then the hub. And /portal.html itself heals to the root form.
//   J. A card opens its customer at /contacts/c-…, the sidebar stays on Contacts, and the
//      record's Back returns to the board it came from (the second pipeline, not the first).
//   K. My Profile: "How the Contacts tab opens" offers Contacts, Design list and every pipeline,
//      says the first pipeline applies, and a press saves contactsView (and designsView for the
//      older build) through save_prefs, and says "Saved." only when the answer keeps the choice: a
//      server build that drops contactsView gets a plain error line, and the card goes back to
//      what that server holds (K6-K8, 2026-10-13; against the build before, K6-K8 fail).
//   L. The entitlement call fails: the Design list, no hang.
//   M. "＋ Pipeline" on a board: the new pipeline joins the end of the row and opens.
//
// Every address is the ROOT one (no /portal since 2026-10-13); serveAppRoutes answers them from
// _redirects the way the host does, since a plain static server ignores that file.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root; SS_BASE overrides the address)
//   node tests/harness/contactsHub.mjs             (exit 0 = every check held)
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine). Fixtures are
// made up (example.test, a made-up tenant), per the public-repo rule. Shots land in
// %TEMP%/ss-harness/contacts-hub (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an older
// portal.app.compiled.js> serves that file instead: before this change every check fails (there
// is no tab row, and Pipeline is a sidebar item of its own).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, shotsDir, collectErrors, serveAppRoutes } from "./lib.mjs";

const OWN = "acme-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000021", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const CONTACT_ID = "4512ed87-fb75-4645-81d6-9268eb73e3a1";
const CODE = "SS-HUBAAA0001";
const designRow = (code, name, status) => ({
  short_code: code, created_at: "2026-09-20T15:00:00Z", updated_at: "2026-09-20T15:00:00Z", status,
  contact: { name, email: `${name.split(" ")[0].toLowerCase()}@example.test` }, contact_id: null,
  sel_style: "Utility", sel_size: "10x12", ghl_estimate_number: null, inventory_unit_id: null, image_url: null,
  ss_quote_number: status === "draft" ? null : `AS-${code.slice(-4)}`, ss_quote_pdf_url: null, ss_invoice_sent_at: null,
  total_cents: 900000, expected_close_date: null,
});
const ROWS = [designRow("SS-PIPEAAA001", "Avery Stone", "sent"), designRow("SS-PIPEBBB002", "Blake Rivers", "accepted"), designRow(CODE, "Pat Tester", "accepted")];
const NAMES = ["Shed Deals", "Manufacturer Outreach", "Sold", "Reputation", "Repairs Follow-up", "Dealer Recruiting", "Lot Walk-ins", "Fall Promo"];
const pipeId = (i) => `0f7c4b2e-8a1d-4c3b-9e6f-2a5d7c8b9e${String(10 + i).padStart(2, "0")}`;
const stageId = (i, s) => `5a5a5a5a-0000-4000-8000-0000000${String(i).padStart(2, "0")}${String(s).padStart(3, "0")}`;
const pipelines = (n) => NAMES.slice(0, n).map((name, i) => ({
  id: pipeId(i), name, position: i, lostReasons: [], seedKind: null, feedsDesigns: i === 0, mirrorsStatuses: false,
  stages: ["New Incoming", "Attempting Contact", "Nurturing - Cool"].map((s, j) => ({ id: stageId(i, j), name: s, color: "#64748B", kind: "open", position: j, statusId: null })),
}));
const deals = (pid) => {
  const i = Number(pid.slice(-2)) - 10;
  return [{
    id: `7d7d7d7d-0000-4000-8000-0000000000${String(10 + i).padStart(2, "0")}`, pipeline_id: pid, stage_id: stageId(i, 1), status_id: null,
    contact_id: CONTACT_ID, short_code: CODE, value_cents: 812300, title: null, lost_reason: null, expected_close_date: null,
    stage_entered_at: "2026-10-10T15:00:00Z", created_at: "2026-10-01T15:00:00Z", updated_at: "2026-10-10T15:00:00Z", next_follow_up_at: null,
    contact: { name: "Pat Tester", company: null, phone: "+15125550142", email: "pat@example.test", ownerUserId: null },
    design: { style: "Utility", size: "12x16", status: "accepted", estimateNumber: "AS-0001", createdAt: "2026-10-01T15:00:00Z", updatedAt: "2026-10-10T15:00:00Z" },
  }];
};
const CONTACT = { id: CONTACT_ID, name: "Pat Tester", phone: "+15125550142", email: "pat@example.test", phone_digits: "15125550142", owner_user_id: null, sms_opt_out_at: null };
const DESIGN = { ...ROWS[2], selections: { style: "Utility", size: "12x16" }, contact_id: CONTACT_ID };
const ent = (crm) => ({ granted: [], paid: [], features: crm ? { crm: true } : {}, status: "active", locked: false });
const CREW_LEADER = { build_schedule: "edit", repairs: "edit", designs: "view", inventory: "view", orders: "view" };

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const { ok, failed } = reporter();
const shots = shotsDir("contacts-hub");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;
const { browser, ctx: unused } = await launch({ width: 1280, height: 900 });
await unused.close();

/**
 * S: { crm, n (pipelines), prefs, access, role, billingDelayMs, billingFail, width, height }. Opens
 * `path`; returns the page, the save_prefs bodies, and every hub view drawn, in order, from the
 * first render (window.__hubViews).
 */
async function open(S, path) {
  const saves = [];
  const ctx = await browser.newContext({ viewport: { width: S.width || 1280, height: S.height || 900 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    window.__hubViews = [];
    const scan = () => {
      const v = document.querySelector("[data-ss-hub-view]");
      const val = v ? v.getAttribute("data-ss-hub-view") : null;
      if (val && window.__hubViews[window.__hubViews.length - 1] !== val) window.__hubViews.push(val);
    };
    const attach = () => {
      if (!document.documentElement) { setTimeout(attach, 5); return; }
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    };
    attach();
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
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: OWN, role: S.role || "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/designs")) {
      const single = /vnd\.pgrst\.object/.test(req.headers()["accept"] || "");
      return single ? json(route, DESIGN) : json(route, ROWS);
    }
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      if (S.billingDelayMs) await new Promise((r) => setTimeout(r, S.billingDelayMs));
      if (S.billingFail) return json(route, { error: "billing is down" }, 500);
      return json(route, { ok: true, configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, entitlement: ent(S.crm) });
    }
    if (url.includes("/portal-settings")) {
      switch (body.action) {
        case "status":
          return json(route, { ok: true, clientId: OWN, role: S.role || "owner", operatorMode: false, access: S.access || null,
            prefs: S.prefs || null, phoneStatus: "off", configured: false, invoiceInGhl: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
        case "get_profile": return json(route, { ok: true, fullName: "Pat Owner", phone: null, needsDetails: false });
        case "crm_pipelines_list":
          return json(route, { ok: true, pipelines: pipelines(S.n ?? 3), statuses: [], team: [], canManage: true, canWrite: true, ownOnly: false, me: USER.id });
        // "＋ Pipeline" (M): the new one is the next name in NAMES, and every later list holds it.
        case "crm_pipeline_save":
          if (!body.id && body.name) { S.n = (S.n ?? 3) + 1; return json(route, { ok: true, id: pipeId(S.n - 1) }); }
          return json(route, { ok: true });
        case "crm_deals_list": return json(route, { ok: true, deals: deals(body.pipelineId), capped: false });
        case "crm_record":
          return json(route, { ok: true, kind: body.kind, clientId: OWN, contact: CONTACT, designs: [DESIGN], orders: [], feed: [], focus: [], team: [],
            people: [], followers: [], sms: { ready: false, from: null, optedOut: false, consented: false }, build: [], stages: [], delivery: [], repairs: [], isDesign: body.kind === "design" });
        case "save_prefs": {
          saves.push(body.prefs);
          // S.oldServer: a build from before contactsView (production's), which keeps designsView
          // alone and still answers ok.
          if (!S.oldServer) return json(route, { ok: true, prefs: body.prefs });
          const p = body.prefs || {};
          const kept = (p.designsView === "list" || p.designsView === "pipeline") ? { designsView: p.designsView } : null;
          return json(route, { ok: true, prefs: kept });
        }
        default: return json(route, { ok: true });
      }
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
  if (!booted) {
    const seen = await page.evaluate(() => `${location.pathname}: ${document.body.innerText.slice(0, 300)}`).catch(() => "");
    throw new Error(`the portal never booted on ${path}; refusing to report the rest as passes. ${seen} ${errors.join(" | ")}`);
  }
  return { ctx, page, errors, saves };
}

// Waits for the hub to settle on a view other than "loading", then reads the row and the page.
async function settled(page, want = null, timeout = 15000) {
  await page.waitForFunction((w) => {
    const v = document.querySelector("[data-ss-hub-view]");
    const val = v && v.getAttribute("data-ss-hub-view");
    return val && val !== "loading" && (!w || val === w);
  }, want, { timeout }).catch(() => {});
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const v = document.querySelector("[data-ss-hub-view]");
    const row = document.querySelector("[data-ss-hub-tabs]");
    // Two groups since 2026-10-13: the pipelines' underline tabs, and the Contacts | Design list
    // bubble at the right. `tabs` lists the bubble's first, then the pipelines', so the checks
    // written for one row (Contacts, Design list, then each pipeline) still read the same.
    const pipeTabs = row ? [...row.querySelectorAll("[data-ss-hub-pipes] a[role=tab]")] : [];
    const listTabs = row ? [...row.querySelectorAll("[data-ss-hub-lists] a[role=tab]")] : [];
    const tabs = [...listTabs, ...pipeTabs];
    const bubble = row ? row.querySelector("[data-ss-hub-lists]") : null;
    const more = row ? row.querySelector("[data-ss-hub-more]") : null;
    const tops = pipeTabs.map((t) => Math.round(t.getBoundingClientRect().top));
    // One line: every pipeline tab on the same line, and the bubble on that line too.
    const b = bubble ? bubble.getBoundingClientRect() : null;
    const p0 = pipeTabs[0] ? pipeTabs[0].getBoundingClientRect() : null;
    const bubbleOnLine = !b || !p0 || (b.top < p0.bottom && b.bottom > p0.top);
    const nav = [...document.querySelectorAll(".ss-ws-nav .ss-nav a")].map((a) => a.textContent.trim());
    return {
      view: v ? v.getAttribute("data-ss-hub-view") : null,
      path: location.pathname,
      tabs: tabs.map((t) => t.textContent.trim()),
      pipes: pipeTabs.map((t) => t.textContent.trim()),
      lists: listTabs.map((t) => t.textContent.trim()),
      stacked: !!row && row.hasAttribute("data-ss-hub-stacked"),
      active: tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent.trim()),
      more: more ? more.textContent.trim() : null,
      oneLine: (tops.length > 0 || listTabs.length > 0) && tops.every((t) => t === tops[0]) && bubbleOnLine,
      rowScroll: row ? row.scrollWidth - row.clientWidth : null,
      pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      nav,
      activeNav: [...document.querySelectorAll(".ss-ws-nav .ss-nav a.active")].map((a) => a.textContent.trim()),
      select: !!document.querySelector('select[aria-label="Pipeline"]'),
      controls: ["Edit stages", "＋ Pipeline", "＋ Add lead"].filter((t) => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === t)),
      designsList: !!document.querySelector('[data-ss-designs-view="list"]'),
      views: window.__hubViews.slice(),
    };
  });
}
const shot = (page, name) => page.screenshot({ path: join(shots, name) });

try {
  // ── A + B: 3 pipelines, 1280 and 1920 ──
  for (const width of [1280, 1920]) {
    const { ctx, page, errors } = await open({ crm: true, n: 3, width }, "/contacts");
    const r = await settled(page, "pipe");
    if (width === 1280) {
      ok("A1 CRM, nothing saved: Contacts opens on the FIRST pipeline, and the address says so", r.view === "pipe" && r.path === `/contacts/p-${pipeId(0)}` && r.active[0] === "Shed Deals", JSON.stringify(r));
      ok("A2 the pipelines read in order from the left, and Contacts | Design list is the bubble at the right (Ahsan 2026-10-13)",
        JSON.stringify(r.pipes) === JSON.stringify(["Shed Deals", "Manufacturer Outreach", "Sold"]) && JSON.stringify(r.lists) === JSON.stringify(["Contacts", "Design list"]) && !r.stacked,
        `pipelines: ${r.pipes.join(" | ")} / bubble: ${r.lists.join(" | ")}`);
      ok("A3 one sidebar item: Contacts, no Pipeline", r.nav.includes("Contacts") && !r.nav.includes("Pipeline") && r.activeNav.join() === "Contacts", r.nav.join(", "));
      ok("A4 no pipeline drop-down picker; the board's own controls are still there", !r.select && r.controls.length === 3, `select ${r.select}; ${r.controls.join(", ")}`);
      ok("A5 no page errors", errors.length === 0, errors.join(" | "));
    }
    ok(`B1 ${width}: three pipelines, every one a tab, in one line, no drop-down`, r.tabs.length === 5 && r.oneLine && r.more === null, JSON.stringify(r.tabs));
    ok(`B2 ${width}: no scroll bar on the row or the page`, r.rowScroll <= 0 && r.pageScroll <= 0, `row ${r.rowScroll}, page ${r.pageScroll}`);
    await shot(page, `U1-${width}-3pipes.png`);
    // Tab clicks: Design list, then Contacts, each one click, each its own address.
    if (width === 1280) {
      await page.locator('[data-ss-hub-tab="designs"]').click();
      const d = await settled(page, "designs");
      ok("B3 one click on Design list shows the Design list at /contacts/designs", d.view === "designs" && d.designsList && d.path === "/contacts/designs", JSON.stringify({ view: d.view, path: d.path }));
      await page.locator('[data-ss-hub-tab="people"]').click();
      const p = await settled(page, "people");
      ok("B4 one click on Contacts shows the contact list at /contacts/people", p.view === "people" && p.path === "/contacts/people", JSON.stringify({ view: p.view, path: p.path }));
      await page.goBack();
      const back = await settled(page, "designs");
      ok("B5 the browser's Back walks between the tabs", back.view === "designs" && back.path === "/contacts/designs", JSON.stringify({ view: back.view, path: back.path }));
    }
    await ctx.close();
  }

  // ── C: 8 pipelines, 1280 and 1920 ──
  for (const width of [1280, 1920]) {
    const { ctx, page, errors } = await open({ crm: true, n: 8, width }, "/contacts");
    const r = await settled(page, "pipe");
    ok(`C1 ${width}: eight pipelines: four tabs, and the fifth is the drop-down wearing the fifth's name`,
      JSON.stringify(r.tabs) === JSON.stringify(["Contacts", "Design list", ...NAMES.slice(0, 5)]) && r.more && r.more.startsWith(NAMES[4]) && r.oneLine,
      `${r.tabs.join(" | ")} / more: ${r.more}`);
    ok(`C2 ${width}: no scroll bar on the row or the page`, r.rowScroll <= 0 && r.pageScroll <= 0, `row ${r.rowScroll}, page ${r.pageScroll}`);
    await shot(page, `U1-${width}-8pipes.png`);
    await page.locator("[data-ss-hub-more] button[aria-haspopup=menu]").click();
    await page.waitForTimeout(300);
    const items = await page.evaluate(() => [...document.querySelectorAll("[data-ss-hub-menu] a")].map((a) => a.textContent.trim()));
    ok(`C3 ${width}: ▾ lists the rest`, JSON.stringify(items) === JSON.stringify(NAMES.slice(4)), items.join(" | "));
    await shot(page, `U1-${width}-8pipes-menu.png`);
    await page.locator("[data-ss-hub-menu] a", { hasText: NAMES[6] }).click();
    const s = await settled(page, "pipe");
    ok(`C4 ${width}: picking the seventh opens it, and the fifth tab now wears its name`,
      s.path === `/contacts/p-${pipeId(6)}` && s.more && s.more.startsWith(NAMES[6]) && s.active.includes(NAMES[6]) && s.oneLine,
      `${s.path} / more: ${s.more} / active: ${s.active}`);
    await shot(page, `U1-${width}-8pipes-seventh-open.png`);
    ok(`C5 ${width}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── D: narrow ──
  {
    const { ctx, page, errors } = await open({ crm: true, n: 8, width: 1000 }, "/contacts");
    const r = await settled(page, "pipe");
    const inlinePipes = r.tabs.length - 2 - 1;   // minus Contacts, Design list and the drop-down's own
    ok("D1 a narrow window folds more into the drop-down, still one line", inlinePipes < 4 && r.more && r.oneLine, `${r.tabs.join(" | ")} / more: ${r.more}`);
    ok("D2 and never a scroll bar", r.rowScroll <= 0 && r.pageScroll <= 0, `row ${r.rowScroll}, page ${r.pageScroll}`);
    ok("D3 no page errors", errors.length === 0, errors.join(" | "));
    await shot(page, "U1-1000-8pipes.png");
    await ctx.close();
  }
  {
    // A phone: the rail is icons, and everything that does not fit goes in the drop-down. The row
    // may wrap as a last resort; it never scrolls, and neither does the page.
    const { ctx, page, errors } = await open({ crm: true, n: 8, width: 400, height: 800 }, "/contacts");
    const r = await settled(page, "pipe");
    ok("D4 at 400px: the drop-down holds the rest, and nothing scrolls sideways", !!r.more && r.rowScroll <= 0 && r.pageScroll <= 0,
      `${r.tabs.join(" | ")} / more: ${r.more} / row ${r.rowScroll}, page ${r.pageScroll}`);
    ok("D5 no page errors", errors.length === 0, errors.join(" | "));
    await shot(page, "U1-400-8pipes.png");
    await ctx.close();
  }

  // ── P: the bubble (Ahsan 2026-10-13) ──
  // Contacts | Design list left the underline row for a rounded bubble at its far right. Checked
  // where it sits, that nothing overlaps or scrolls, that exactly one thing looks picked, that the
  // arrow keys stay inside a group, and that a narrow window puts the bubble on its own line.
  {
    const HUB = "/portal/contacts";
    const ACC = "rgb(61, 54, 114)";
    // The row's geometry and looks, in the page. `units` are what a person sees as one thing each:
    // a pipeline tab, the drop-down (its tab and ▾ together), one part of the bubble.
    const geo = (page) => page.evaluate((acc) => {
      const row = document.querySelector("[data-ss-hub-tabs]");
      const pipesBox = row.querySelector("[data-ss-hub-pipes]");
      const bubble = row.querySelector("[data-ss-hub-lists]");
      const R = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
      const pipeItems = [...pipesBox.querySelectorAll(":scope > a[role=tab], :scope > [data-ss-hub-more]")];
      const segs = bubble ? [...bubble.querySelectorAll("a[role=tab]")] : [];
      const parts = [...pipesBox.querySelectorAll("a[role=tab], button"), ...segs];
      const overlaps = [];
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          if (parts[i].contains(parts[j]) || parts[j].contains(parts[i])) continue;
          const a = R(parts[i]); const c = R(parts[j]);
          const w = Math.min(a.r, c.r) - Math.max(a.l, c.l); const h = Math.min(a.b, c.b) - Math.max(a.t, c.t);
          if (w > 0.5 && h > 0.5) overlaps.push(`${parts[i].textContent.trim()} × ${parts[j].textContent.trim()}`);
        }
      }
      const looks = (el) => {
        const cs = getComputedStyle(el);
        return (parseFloat(cs.borderBottomWidth) >= 2 && cs.borderBottomStyle !== "none" && cs.borderBottomColor === acc)
          || cs.backgroundColor === "rgb(255, 255, 255)" || cs.color === acc;
      };
      const units = [...pipeItems, ...segs];
      const picked = units.filter((u) => looks(u) || [...u.querySelectorAll("a, button")].some(looks)).map((u) => u.textContent.trim());
      const bs = bubble ? getComputedStyle(bubble) : null;
      const tabCs = pipeItems[0] ? getComputedStyle(pipeItems[0].matches("a") ? pipeItems[0] : pipeItems[0].querySelector("a")) : null;
      return {
        row: R(row), bubble: bubble ? R(bubble) : null, last: pipeItems.length ? R(pipeItems[pipeItems.length - 1]) : null,
        pipeTop: pipeItems.length ? Math.min(...pipeItems.map((x) => R(x).t)) : null,
        stacked: row.hasAttribute("data-ss-hub-stacked"),
        overlaps, picked, selected: [...row.querySelectorAll("[aria-selected=true]")].map((x) => x.textContent.trim()),
        rowScroll: row.scrollWidth - row.clientWidth, pipesScroll: pipesBox.scrollWidth - pipesBox.clientWidth,
        pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bubbleLook: bs ? { radius: parseFloat(bs.borderTopLeftRadius), bg: bs.backgroundColor, border: bs.borderTopWidth } : null,
        tabLook: tabCs ? { radius: parseFloat(tabCs.borderTopLeftRadius), bg: tabCs.backgroundColor } : null,
      };
    }, ACC);
    const focused = (page) => page.evaluate(() => (document.activeElement ? document.activeElement.textContent.trim() : ""));

    for (const width of [1440, 1280]) {
      for (const n of [3, 8]) {
        const { ctx, page, errors } = await open({ crm: true, n, width }, HUB);
        await settled(page, "pipe");
        const g = await geo(page);
        ok(`P1 ${width}, ${n} pipelines: the bubble sits right of the last pipeline tab, on its line, at the row's right edge`,
          g.bubble && g.last && !g.stacked && g.bubble.l >= g.last.r + 4 && Math.abs(g.row.r - g.bubble.r) <= 1.5
            && g.bubble.t < g.last.b && g.bubble.b > g.last.t,
          JSON.stringify({ bubble: g.bubble, last: g.last, row: g.row }));
        ok(`P2 ${width}, ${n} pipelines: nothing in the row overlaps`, g.overlaps.length === 0, g.overlaps.join("; "));
        ok(`P3 ${width}, ${n} pipelines: nothing scrolls sideways`, g.rowScroll <= 0 && g.pipesScroll <= 0 && g.pageScroll <= 0,
          `row ${g.rowScroll}, pipelines ${g.pipesScroll}, page ${g.pageScroll}`);
        ok(`P4 ${width}, ${n} pipelines: one thing looks picked, the open pipeline`,
          g.picked.length === 1 && g.picked[0].startsWith("Shed Deals") && JSON.stringify(g.selected) === JSON.stringify(["Shed Deals"]),
          `looks picked: ${g.picked.join(" | ")} / aria-selected: ${g.selected.join(" | ")}`);
        if (width === 1280 && n === 8) {
          ok("P5 the bubble looks unlike the tabs: a rounded, filled pill against bare underline tabs",
            g.bubbleLook && g.bubbleLook.radius >= 16 && g.bubbleLook.bg === "rgb(241, 245, 249)" && g.bubbleLook.border === "1px"
              && g.tabLook && g.tabLook.radius === 0 && g.tabLook.bg === "rgba(0, 0, 0, 0)",
            JSON.stringify({ bubble: g.bubbleLook, tab: g.tabLook }));
          for (const [id, label] of [["people", "Contacts"], ["designs", "Design list"]]) {
            await page.locator(`[data-ss-hub-tab="${id}"]`).click();
            await settled(page, id);
            const s = await geo(page);
            ok(`P6 with ${label} open, it is the one thing that looks picked (its part of the bubble), and no pipeline does`,
              JSON.stringify(s.picked) === JSON.stringify([label]) && JSON.stringify(s.selected) === JSON.stringify([label]),
              `looks picked: ${s.picked.join(" | ")} / aria-selected: ${s.selected.join(" | ")}`);
            await shot(page, `P-1280-8pipes-${id}.png`);
          }
          // Arrow keys: along the pipelines (wrapping, Home/End), and along the bubble without leaving it.
          await page.locator("[data-ss-hub-pipes] a[role=tab]").first().focus();
          await page.keyboard.press("ArrowRight");
          const k1 = await focused(page);
          await page.keyboard.press("End");
          const k2 = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("aria-haspopup"));
          await page.keyboard.press("ArrowRight");
          const k3 = await focused(page);
          await page.locator('[data-ss-hub-tab="people"]').focus();
          await page.keyboard.press("ArrowRight");
          const k4 = await focused(page);
          await page.keyboard.press("ArrowRight");
          const k5 = await focused(page);
          await page.keyboard.press("ArrowLeft");
          const k6 = await focused(page);
          ok("P7 arrow keys walk one group: the pipelines (End is the ▾, then wraps), and the bubble stays in the bubble",
            k1 === NAMES[1] && k2 === "menu" && k3 === NAMES[0] && k4 === "Design list" && k5 === "Contacts" && k6 === "Design list",
            JSON.stringify([k1, k2, k3, k4, k5, k6]));
          const fv = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`; });
          ok("P8 a keyboard-focused part of the bubble shows its focus ring (the brand teal)", fv === "solid 2px rgb(27, 120, 149)", fv);
        }
        ok(`P9 ${width}, ${n} pipelines: no page errors`, errors.length === 0, errors.join(" | "));
        await shot(page, `P-${width}-${n}pipes.png`);
        await ctx.close();
      }
    }
    // A narrow window: the bubble on a line of its own above the pipelines, still at the right.
    {
      const { ctx, page, errors } = await open({ crm: true, n: 8, width: 600, height: 800 }, HUB);
      const r = await settled(page, "pipe");
      const g = await geo(page);
      ok("P10 at 600px the bubble has its own line, above the pipelines and at the right",
        g.stacked && g.bubble && g.pipeTop !== null && g.bubble.b <= g.pipeTop + 0.5 && Math.abs(g.row.r - g.bubble.r) <= 1.5,
        JSON.stringify({ stacked: g.stacked, bubble: g.bubble, pipeTop: g.pipeTop, row: g.row }));
      ok("P11 at 600px the pipelines still fold into the drop-down, nothing overlaps, nothing scrolls",
        !!r.more && g.overlaps.length === 0 && g.rowScroll <= 0 && g.pipesScroll <= 0 && g.pageScroll <= 0 && g.picked.length === 1,
        `${r.pipes.join(" | ")} / more: ${r.more} / overlaps: ${g.overlaps.join("; ")} / row ${g.rowScroll}, page ${g.pageScroll} / picked: ${g.picked.join(" | ")}`);
      ok("P12 no page errors", errors.length === 0, errors.join(" | "));
      await shot(page, "P-600-8pipes.png");
      await ctx.close();
    }
    // No CRM: the padlocked Contacts keeps its padlock in the bubble, and the Design list is the one picked.
    {
      const { ctx, page, errors } = await open({ crm: false, n: 3, width: 1280 }, HUB);
      const r = await settled(page, "designs");
      const g = await geo(page);
      ok("P13 no CRM: 🔒 Contacts sits in the bubble, 🔒 Pipeline on the left, and only Design list looks picked",
        JSON.stringify(r.lists) === JSON.stringify(["🔒Contacts", "Design list"]) && JSON.stringify(r.pipes) === JSON.stringify(["🔒Pipeline"])
          && JSON.stringify(g.picked) === JSON.stringify(["Design list"]) && g.overlaps.length === 0,
        `bubble: ${r.lists.join(" | ")} / pipelines: ${r.pipes.join(" | ")} / picked: ${g.picked.join(" | ")}`);
      ok("P14 no page errors", errors.length === 0, errors.join(" | "));
      await shot(page, "P-1280-no-crm.png");
      await ctx.close();
    }
    // A designs-only role: the bubble holds the Design list alone, still at the right, named for
    // what it holds; and with no pipeline tab, never lifted onto a line of its own, even narrow.
    for (const width of [1280, 600]) {
      const { ctx, page, errors } = await open({ crm: true, n: 3, role: "user", access: CREW_LEADER, width }, HUB);
      const r = await settled(page, "designs");
      const g = await geo(page);
      const label = await page.locator("[data-ss-hub-lists]").getAttribute("aria-label").catch(() => null);
      ok(`P15 ${width}: a Crew Leader's bubble is the Design list alone, at the right, labelled for it, not stacked`,
        JSON.stringify(r.lists) === JSON.stringify(["Design list"]) && r.pipes.length === 0 && label === "Design list"
          && !g.stacked && g.bubble && Math.abs(g.row.r - g.bubble.r) <= 1.5 && g.rowScroll <= 0 && g.pageScroll <= 0,
        JSON.stringify({ lists: r.lists, pipes: r.pipes, label, stacked: g.stacked, bubble: g.bubble, row: g.row }));
      ok(`P16 ${width}: no page errors`, errors.length === 0, errors.join(" | "));
      await ctx.close();
    }
  }

  // ── E: no CRM ──
  {
    const { ctx, page, errors } = await open({ crm: false, n: 3 }, "/contacts");
    const r = await settled(page, "designs");
    ok("E1 no CRM: Contacts opens on the Design list (C14)", r.view === "designs" && r.designsList && r.path === "/contacts/designs", JSON.stringify(r));
    ok("E2 Contacts and Pipeline stay, padlocked, to sell the CRM", JSON.stringify(r.tabs) === JSON.stringify(["🔒Contacts", "Design list", "🔒Pipeline"]), r.tabs.join(" | "));
    ok("E3 the Design list was the only thing drawn", JSON.stringify(r.views) === JSON.stringify(["designs"]), r.views.join(" → "));
    await shot(page, "U1-1280-no-crm.png");
    await page.locator('[data-ss-hub-tab="people"]').click();
    const l = await settled(page, "locked");
    ok("E4 the padlocked Contacts tab opens the card that sells the CRM", l.view === "locked" && (await page.evaluate(() => document.body.innerText.includes("Add the CRM"))), JSON.stringify({ view: l.view, path: l.path }));
    ok("E5 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── F: a designs-only role ──
  {
    const { ctx, page, errors } = await open({ crm: true, n: 3, role: "user", access: CREW_LEADER }, "/contacts");
    const r = await settled(page, "designs");
    ok("F1 a Crew Leader (designs only) lands on the Design list", r.view === "designs" && r.path === "/contacts/designs", JSON.stringify(r));
    ok("F2 and is shown nothing else: no Contacts tab, no boards", JSON.stringify(r.tabs) === JSON.stringify(["Design list"]), r.tabs.join(" | "));
    ok("F3 the sidebar still calls it Contacts", r.nav.includes("Contacts") && !r.nav.includes("Pipeline"), r.nav.join(", "));
    await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/contacts/p-${pipeId(0)}`);
    const t = await settled(page, "designs");
    ok("F4 a typed board address puts them back on the Design list", t.view === "designs" && t.path === "/contacts/designs", JSON.stringify({ view: t.view, path: t.path }));
    ok("F5 no page errors", errors.length === 0, errors.join(" | "));
    await shot(page, "U1-1280-crew-leader.png");
    await ctx.close();
  }

  // ── G: the CRM answer held ──
  {
    const { ctx, page, errors } = await open({ crm: true, n: 3, billingDelayMs: 1500 }, "/contacts");
    const r = await settled(page, "pipe", 20000);
    ok("G1 with the CRM answer held, the board still arrives", r.view === "pipe" && r.path === `/contacts/p-${pipeId(0)}`, JSON.stringify(r));
    ok("G2 the MutationObserver never saw the Design list (or anything but the wait) before the board",
      !r.views.includes("designs") && r.views[r.views.length - 1] === "pipe", r.views.join(" → "));
    ok("G3 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── H: saved picks ──
  for (const [label, prefs, view, path] of [
    ["contactsView \"designs\"", { contactsView: "designs" }, "designs", "/contacts/designs"],
    ["contactsView of the second pipeline", { contactsView: `p-${pipeId(1)}` }, "pipe", `/contacts/p-${pipeId(1)}`],
    ["the old Pipeline tab's designsView \"list\"", { designsView: "list" }, "designs", "/contacts/designs"],
    ["contactsView \"people\"", { contactsView: "people" }, "people", "/contacts/people"],
  ]) {
    const { ctx, page } = await open({ crm: true, n: 3, prefs }, "/contacts");
    const r = await settled(page, view);
    ok(`H a saved pick wins: ${label}`, r.view === view && r.path === path && JSON.stringify(r.views) === JSON.stringify([view]), JSON.stringify({ view: r.view, path: r.path, views: r.views }));
    await ctx.close();
  }

  // ── I: old addresses ──
  for (const [from, view, path] of [
    ["/designs/list", "designs", "/contacts/designs"],
    [`/pipelines/${pipeId(2)}`, "pipe", `/contacts/p-${pipeId(2)}`],
    ["/designs", "pipe", `/contacts/p-${pipeId(0)}`],
    ["/designs/pipeline", "pipe", `/contacts/p-${pipeId(0)}`],
    ["/leads", "pipe", `/contacts/p-${pipeId(0)}`],
    // The OLD /portal addresses: links already sent, bookmarks, the phone apps.
    ["/portal/designs/list", "designs", "/contacts/designs"],
    [`/portal/contacts/p-${pipeId(1)}`, "pipe", `/contacts/p-${pipeId(1)}`],
    ["/portal/contacts", "pipe", `/contacts/p-${pipeId(0)}`],
    ["/portal/leads", "pipe", `/contacts/p-${pipeId(0)}`],
  ]) {
    const { ctx, page, errors } = await open({ crm: true, n: 3 }, from);
    const r = await settled(page, view);
    ok(`I ${from} lands in the hub at ${path}`, r.view === view && r.path === path && errors.length === 0, JSON.stringify({ view: r.view, path: r.path, errors }));
    await ctx.close();
  }

  // An old /portal address keeps its query through the host's 301, and /portal.html itself (the
  // file, which no rule redirects) is rewritten in the address bar to the root form.
  {
    const { ctx, page, errors } = await open({ crm: true, n: 3 }, "/portal/contacts/designs?tab=keep");
    const r = await settled(page, "designs");
    const search = await page.evaluate(() => location.search);
    ok("I the query string rides through the 301", r.path === "/contacts/designs" && search === "?tab=keep" && errors.length === 0, JSON.stringify({ path: r.path, search, errors }));
    await shot(page, "PP-legacy-portal-address-healed.png");
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open({ crm: true, n: 3 }, "/portal.html");
    const r = await settled(page, "pipe");
    ok("I /portal.html opens the app and the address becomes the root form", r.path === `/contacts/p-${pipeId(0)}` && errors.length === 0, JSON.stringify({ path: r.path, errors }));
    await ctx.close();
  }

  // ── J: a card opens its customer inside Contacts; Back returns to that board ──
  {
    const { ctx, page, errors } = await open({ crm: true, n: 3 }, `/contacts/p-${pipeId(1)}`);
    await settled(page, "pipe");
    await page.waitForFunction(() => document.querySelector("[data-ss-deal]"), null, { timeout: 15000 }).catch(() => {});
    await page.locator("[data-ss-deal]").first().click();
    await page.waitForFunction(() => document.body.innerText.includes("SUMMARY"), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    const rec = await page.evaluate(() => ({
      path: location.pathname,
      activeNav: [...document.querySelectorAll(".ss-ws-nav .ss-nav a.active")].map((a) => a.textContent.trim()),
      summary: document.body.innerText.includes("SUMMARY"),
    }));
    ok("J1 a card opens its customer at /contacts/c-…", rec.path === `/contacts/c-${CONTACT_ID}` && rec.summary, JSON.stringify(rec));
    ok("J2 and the sidebar stays on Contacts (C22)", rec.activeNav.join() === "Contacts", rec.activeNav.join());
    await shot(page, "U1-1280-record-inside-contacts.png");
    await page.getByRole("button", { name: "Back", exact: true }).first().click();
    const r = await settled(page, "pipe");
    ok("J3 the record's Back returns to the board it came from — the second pipeline, not the first", r.path === `/contacts/p-${pipeId(1)}` && r.active.includes(NAMES[1]), JSON.stringify({ path: r.path, active: r.active }));
    ok("J4 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── K: My Profile ──
  {
    const { ctx, page, errors, saves } = await open({ crm: true, n: 3 }, "/settings/myprofile");
    await page.waitForFunction(() => document.body.innerText.includes("How the Contacts tab opens"), null, { timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() => /your first pipeline/.test((document.querySelector("[data-ss-view-default]") || {}).textContent || ""), null, { timeout: 10000 }).catch(() => {});
    const read = () => page.evaluate(() => ({
      note: ((document.querySelector("[data-ss-view-default]") || {}).textContent || "").trim(),
      picks: [...document.querySelectorAll("[data-ss-view-pick]")].map((b) => [b.textContent.trim(), b.getAttribute("aria-pressed")]),
    }));
    const k = await read();
    ok("K1 it offers Contacts, Design list and every pipeline", JSON.stringify(k.picks.map((p) => p[0])) === JSON.stringify(["Contacts", "Design list", "Shed Deals", "Manufacturer Outreach", "Sold"]), JSON.stringify(k.picks));
    ok("K2 with nothing picked it says the first pipeline applies, and lights it", /opens on Shed Deals, your first pipeline/.test(k.note) && k.picks[2][1] === "true", JSON.stringify(k));
    await page.locator('[data-ss-view-pick="designs"]').click();
    await page.waitForTimeout(800);
    const after = await read();
    const last = saves[saves.length - 1] || {};
    ok("K3 a press saves contactsView, with designsView for the older build", last.contactsView === "designs" && last.designsView === "list", JSON.stringify(last));
    ok("K4 and the card says so", /opens on the Design list \(your choice\)/.test(after.note), after.note);
    const said = await page.locator("[data-ss-view-default]").locator("xpath=..").innerText().catch(() => "");
    ok("K4b and says Saved., because the server kept it", /(^|\n)Saved\.(\n|$)/.test(said) && !/didn't keep/.test(said), said.slice(-300));
    await page.locator("[data-ss-view-default]").locator("xpath=..").screenshot({ path: join(shots, "U1-myprofile-contacts-default.png") }).catch(() => {});
    ok("K5 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── K6-K8: a server build that drops contactsView ──
  {
    const { ctx, page, errors, saves } = await open({ crm: true, n: 3, oldServer: true }, "/settings/myprofile");
    await page.waitForFunction(() => /your first pipeline/.test((document.querySelector("[data-ss-view-default]") || {}).textContent || ""), null, { timeout: 20000 }).catch(() => {});
    await page.locator('[data-ss-view-pick="people"]').click();
    await page.waitForTimeout(800);
    const card = await page.locator("[data-ss-view-default]").locator("xpath=..").innerText().catch(() => "");
    const note = ((await page.locator("[data-ss-view-default]").textContent().catch(() => "")) || "").trim();
    const pressed = await page.locator('[data-ss-view-pick="people"]').getAttribute("aria-pressed").catch(() => null);
    ok("K6 the save went out with contactsView people", (saves[saves.length - 1] || {}).contactsView === "people", JSON.stringify(saves));
    ok("K7 a server that drops it gets an error line, not Saved.",
      card.includes("Saved, but this server build didn't keep that choice, so the Contacts tab still opens as the line above says. Tell CSM Synergy.")
        && !/(^|\n)Saved\.(\n|$)/.test(card), card.slice(-400));
    ok("K8 and the card goes back to what that server holds: nothing picked, the first pipeline, Contacts not lit",
      /You haven't picked one, so the Contacts tab opens on Shed Deals, your first pipeline\./.test(note) && pressed === "false", JSON.stringify({ note, pressed }));
    await page.locator("[data-ss-view-default]").locator("xpath=..").screenshot({ path: join(shots, "U1-myprofile-old-server.png") }).catch(() => {});
    ok("K9 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── M: "＋ Pipeline" makes a tab of its own and opens on it ──
  {
    const S = { crm: true, n: 3 };
    const { ctx, page, errors } = await open(S, `/contacts/p-${pipeId(1)}`);
    await settled(page, "pipe");
    await page.getByRole("button", { name: "＋ Pipeline", exact: true }).click();
    await page.getByPlaceholder("Dealer recruiting").fill(NAMES[3]);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForFunction((id) => location.pathname.endsWith(id), `p-${pipeId(3)}`, { timeout: 15000 }).catch(() => {});
    const r = await settled(page, "pipe");
    ok("M1 a pipeline made with ＋ Pipeline joins the row at the end, and opens", r.tabs[r.tabs.length - 1] === NAMES[3]
      && r.active.includes(NAMES[3]) && r.path === `/contacts/p-${pipeId(3)}`, `${r.tabs.join(" | ")} / ${r.path}`);
    ok("M2 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── L: the entitlement call fails ──
  {
    const { ctx, page, errors } = await open({ crm: true, n: 3, billingFail: true }, "/contacts");
    const r = await settled(page, "designs", 12000);
    ok("L1 a failed entitlement call ends the wait on the Design list (no hang)", r.view === "designs", JSON.stringify({ view: r.view, path: r.path }));
    ok("L2 no page errors we own", errors.filter((e) => !/500|Failed to load/.test(e)).length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
}
const f = failed();
console.log(`\n${f.length ? "FAILED" : "OK"} — ${f.length} failed; shots in ${shots}`);
process.exit(f.length ? 1 : 0);
