// The ultrawide width cap on the PORTAL surface — the one builders actually work in.
//
// designerWidthCap.mjs drives index.html, the public customer page. That is NOT the surface
// Carolyn uses: she opens the designer inside the portal shell, where the frame is a tab beside
// a sidebar, `embedded` is set, and the portal floats a fixed "Feedback" pill in the viewport's
// bottom-right corner. The 1728 cap landed on BOTH wrappers (index.html #root and
// portal/06-3d.jsx DesignerTab) and only one of them was ever measured, so this exists.
//
// Two things here cannot be seen on the public page at all:
//
//   A. the embedded footer. `.ssd-frame.is-embedded .ssd-ft-btns` reserves 128px on the right so
//      the buttons never sit under the Feedback pill. The pill is position:fixed against the
//      VIEWPORT, while the footer content is now a 960px column centred in the frame — so once
//      the frame is wide the reservation is dead space that pulls the buttons off the quote
//      card's right edge. This measures the real gap between the buttons and the real pill.
//   B. the frame's own width. `.ss-designer-host` is full-bleed and flex:1 beside the sidebar, so
//      the designer's width is viewport minus sidebar, not the viewport — every breakpoint and
//      every cap has to be read off the frame, not off `window.innerWidth`.
//
// No login and no Supabase account: the session is injected into localStorage the way
// dev/verify-cal3d.mjs does it, and every Supabase call is answered locally. NOTHING LEAVES THE
// MACHINE — capture-lead, save_design and log_error would otherwise write into the one database
// beta and production share.
//
//   python -m http.server 8125 --bind 127.0.0.1        (repo root)
//   node tests/harness/designerWidthCapPortal.mjs      (exit 0 = every check held)
import { launch, stubSupabase, collectErrors, reporter, shotsDir, BASE, REF } from "./lib.mjs";
import { CONFIG as GABLE_CONFIG, FIXTURES } from "./gableProbe.mjs";

const CAP = 1728;           // portal/06-3d.jsx DesignerTab
const INVOICE_MAX = 960;    // --ssd-invoice-max
const CLIENT = "harness-portal-width";

const base = GABLE_CONFIG.buildingStyles[0];
// Same tenant shape designerWidthCap.mjs uses: twelve styles so the strip really overflows, and
// contactFields [] so Details unlocks with no typing and the quote card is in the page.
const CONFIG = {
  ...GABLE_CONFIG,
  clientId: CLIENT,
  contactFields: [],
  branding: { ...(GABLE_CONFIG.branding || {}), stylesPerRow: 8 },
  buildingStyles: Array.from({ length: 12 }, (_, i) => ({ ...base, value: `s${i}`, label: `Style ${i + 1}` })),
  sizePricing: Object.fromEntries(Array.from({ length: 12 }, (_, i) =>
    [`s${i}`, GABLE_CONFIG.sizePricing[base.value]])),
  claddingOptions: Object.fromEntries(Array.from({ length: 12 }, (_, i) =>
    [`s${i}`, (GABLE_CONFIG.claddingOptions || {})[base.value] || []])),
};

// A session in the shape supabase-js keeps in localStorage. The JWT is never verified — every
// call that would carry it is intercepted — but it has to PARSE, because the client decodes
// `exp` to decide whether to refresh mid-run.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(p)}.c3R1Yg`;
const EXP = 4102444800; // 2100-01-01
const UID = "00000000-0000-4000-8000-000000000001";
const SESSION = {
  access_token: jwt({ sub: UID, role: "authenticated", email: "s@e.com", exp: EXP }),
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "s@e.com", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
};

// Everything the checks read, in one page evaluation so all of it describes the same layout.
// Measured against the VIEWPORT, because that is the frame the Feedback pill is fixed to.
const measure = (page) => page.evaluate(() => {
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), mid: Math.round(r.left + r.width / 2) }; };
  const el = document.scrollingElement || document.documentElement;
  const frame = document.querySelector(".ssd-frame");
  const host = document.querySelector(".ss-designer-host");
  // The portal's own scroller: .ss-designer-host is overflow:auto, so the designer scrolls
  // INSIDE it and the document itself never does.
  const pill = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Feedback"));
  const main = document.querySelector(".ssd-frame .ssd-main:not(.ssd-foot)");
  const svg = document.querySelector(".ssd-frame svg");
  let rowW = null;
  for (let n = svg && svg.parentElement; n && n !== document.body; n = n.parentElement) {
    if (n.hasAttribute && n.hasAttribute("data-ss-canvas-row")) { rowW = n.clientWidth; break; }
  }
  return {
    vw: window.innerWidth,
    pageScrollW: el.scrollWidth,
    pageClientW: el.clientWidth,
    hostScrollW: host ? host.scrollWidth : null,
    hostClientW: host ? host.clientWidth : null,
    host: box(host),
    wrapper: box(host && host.firstElementChild),
    frame: box(frame),
    frameW: frame ? frame.clientWidth : null,
    embedded: frame ? frame.classList.contains("is-embedded") : null,
    bp: frame ? frame.getAttribute("data-ssd-bp") : null,
    rowW,
    main: box(main),
    // The section headers every other block on the page aligns to.
    heads: [...document.querySelectorAll(".ssd-sechead:not(.is-sub)")].map(box),
    dtHead: box(document.querySelector(".ssd-dt-head")),
    dt: box(document.querySelector(".ssd-dt")),
    ft: box(document.querySelector(".ssd-ft")),
    ftBtns: box(document.querySelector(".ssd-ft-btns")),
    // The LAST BUTTON, not its container. `.ssd-ft-btns` reserves the pill's column as its own
    // padding-right, so the container's right edge says nothing about where the buttons stop —
    // measuring the box instead of the button is how a 128px reservation reads as zero.
    ftLastBtn: box(document.querySelector(".ssd-ft-btns") && document.querySelector(".ssd-ft-btns").lastElementChild),
    pill: box(pill),
    tileW: (() => { const t = document.querySelector(".ssd-tile"); return t ? Math.round(t.getBoundingClientRect().width) : null; })(),
  };
});

const run = async () => {
  const { ok, failed } = reporter();
  const { browser, ctx } = await launch({ width: 1500, height: 1000 });
  const shots = shotsDir("designerWidthCapPortal");
  try {
    await ctx.addInitScript(([ref, s]) => {
      try { window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* private mode */ }
    }, [REF, SESSION]);
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    // lib.mjs answers everything the DESIGNER asks for (get_config, get_fixtures, writes).
    await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
    // ⚠️ REGISTERED AFTER, so it WINS: Playwright runs matching routes in reverse registration
    // order. These are the calls the portal SHELL makes, which the designer never does.
    const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    const shell = async (route) => {
      const req = route.request();
      const url = req.url();
      if (req.method() === "OPTIONS") {
        return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
      }
      let body = {};
      try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
      if (url.includes("/rest/v1/rpc/get_config")) return json(route, CONFIG);
      if (url.includes("/rest/v1/rpc/get_fixtures")) return json(route, FIXTURES);
      if (url.includes("/rest/v1/rpc/")) return json(route, false);
      if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
      if (url.includes("/rest/v1/")) return json(route, []);
      if (url.includes("/auth/v1/user")) return json(route, SESSION.user);
      if (url.includes("/auth/v1/")) return json(route, SESSION);
      if (url.includes("/portal-billing")) return json(route, { ok: true, entitlement: { granted: [], features: {}, status: "active" } });
      if (url.includes("/portal-settings")) {
        if (body.action === "status") {
          return json(route, { ok: true, clientId: CLIENT, role: "owner", settings: { business_name: "Harness Barns" }, config: { company_name: "Harness Barns", accent_color: "#8B4513" }, access: null, prefs: null });
        }
        if (body.action === "catalog") return json(route, { ok: true, aiReady: false, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
        return json(route, { ok: true });
      }
      if (url.includes("/functions/v1/")) return json(route, { ok: true });
      return json(route, {});
    };
    await page.route(`**/${REF}.supabase.co/**`, shell);
    await page.route(`**/${REF}.functions.supabase.co/**`, shell);

    // CLICKED, not deep-linked: python -m http.server serves files, so /portal/designer 404s
    // here even though it is a real URL on the live site (the app owns that path client-side).
    await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
    // Designer is the FIRST nav item; the Settings sub-page of the same name is the last.
    await page.getByText("Designer", { exact: true }).first().click();
    await page.waitForSelector(".ssd-frame.is-embedded", { timeout: 60000 });
    await page.waitForTimeout(1200);

    const openDetails = async () => {
      const cta = page.locator(".ssd-dt-cta").first();
      if (await cta.count() && await cta.isVisible().catch(() => false)) { await cta.click(); await page.waitForTimeout(400); }
      const tog = page.getByRole("button", { name: /Show details/ }).first();
      if (await tog.count() && await tog.isVisible().catch(() => false)) { await tog.click(); await page.waitForTimeout(400); }
    };

    const seen = {};
    // 1440 / 1416 are the BOUNDARY PAIR, and they are in the list because a breakpoint-scoped fix for the
    // pill reservation passed at all four canonical widths and collided at 1420. 1416 puts the frame at
    // 1176 (lg, no stepper rail), 1440 at 1200 (xl, rail in) — the two sides of the widest-laptop case.
    for (const w of [3440, 2560, 1728, 1440, 1416, 414]) {
      await page.setViewportSize({ width: w, height: w < 500 ? 900 : 1200 });
      await page.waitForTimeout(700);
      await openDetails();
      await page.waitForTimeout(400);
      const m = await measure(page);
      seen[w] = m;
      const tag = `${w}px`;
      console.log(`      ${tag} ${JSON.stringify({ host: m.host && m.host.w, frame: m.frameW, bp: m.bp, row: m.rowW, tile: m.tileW, dt: m.dt && m.dt.w, ft: m.ft && m.ft.w })}`);

      // 0. this really is the embedded surface, not index.html again
      ok(`${tag} the portal designer is the embedded frame`, m.embedded === true, `is-embedded ${m.embedded}`);

      // 1. nothing scrolls sideways — the document, or the designer's own scroller
      ok(`${tag} no horizontal scroll`, m.pageScrollW <= m.pageClientW + 1 && (m.hostScrollW == null || m.hostScrollW <= m.hostClientW + 1),
        `page ${m.pageScrollW}/${m.pageClientW} host ${m.hostScrollW}/${m.hostClientW}`);

      // 2. the cap, on the wrapper that carries it. The host is full-bleed beside the sidebar,
      //    so above the cap the wrapper is 1728 and centred INSIDE the host, not the viewport.
      if (m.host && m.host.w > CAP) {
        ok(`${tag} designer wrapper capped at ${CAP}`, m.wrapper.w === CAP, `wrapper ${m.wrapper.w} in host ${m.host.w}`);
        ok(`${tag} wrapper centred in the host`, Math.abs((m.wrapper.left - m.host.left) - (m.host.right - m.wrapper.right)) <= 1,
          `left gap ${m.wrapper.left - m.host.left} right gap ${m.host.right - m.wrapper.right}`);
      } else if (m.host) {
        ok(`${tag} wrapper fills the host below the cap`, m.wrapper.w >= m.host.w - 1, `wrapper ${m.wrapper.w} host ${m.host.w}`);
      }

      // 3. the quote card and the footer content share the invoice column
      if (m.dt && m.ft) {
        ok(`${tag} quote card capped at ${INVOICE_MAX}`, m.dt.w <= INVOICE_MAX + 1, `dt ${m.dt.w}`);
        ok(`${tag} quote card and footer share a width`, Math.abs(m.dt.w - m.ft.w) <= 1, `dt ${m.dt.w} ft ${m.ft.w}`);
      } else {
        ok(`${tag} quote card and footer are in the page`, false, "not rendered");
      }

      // 4. ALIGNMENT. Every block in a section starts at the section's left edge — the section
      //    header, the cards above, the quote card and the footer content. A centred card under
      //    a full-width header was the mismatch this check exists to stop coming back.
      if (m.dt && m.dtHead && m.heads.length) {
        const headLefts = m.heads.map((h) => h.left);
        ok(`${tag} every section header starts on one left edge`, new Set(headLefts).size === 1, `lefts ${headLefts.join(",")}`);
        ok(`${tag} quote card starts at its section header's left edge`, Math.abs(m.dt.left - m.dtHead.left) <= 1,
          `dt ${m.dt.left} head ${m.dtHead.left}`);
      }
      if (m.ft && m.heads.length) {
        ok(`${tag} footer content starts on the page's left edge`, Math.abs(m.ft.left - m.heads[0].left) <= 1,
          `ft ${m.ft.left} header ${m.heads[0].left}`);
      }

      // 5. THE FEEDBACK PILL. The buttons must clear it — and must not reserve room they do not
      //    need. Both halves are measured against the real pill's real rectangle, and on the last
      //    BUTTON rather than its container, whose right edge is the reservation itself.
      if (m.ftLastBtn && m.pill && m.ft) {
        ok(`${tag} footer buttons clear the Feedback pill`, m.ftLastBtn.right <= m.pill.left - 8,
          `last button right ${m.ftLastBtn.right} pill left ${m.pill.left}`);
        // The reservation is how far the buttons stop short of the column they live in: they are
        // margin-left:auto inside .ssd-ft, so with nothing reserved they end ON the column's edge.
        const dead = m.ft.right - m.ftLastBtn.right;
        const clear = m.pill.left - m.ft.right;   // how far the COLUMN already clears the pill
        ok(`${tag} reservation never exceeds the old flat 128px`, dead <= 128, `reserved ${dead}px`);
        // The finding: 128px held on a frame where the column ends 500px clear of the pill. Where the
        // column is comfortably clear, NOTHING may be reserved. Inside 40px the exact figure is a
        // judgement call (the rule over-reserves by up to 8px, deliberately), so it is not asserted.
        if (clear >= 40) {
          ok(`${tag} nothing reserved where the pill is nowhere near`, dead === 0,
            `reserved ${dead}px, column clears the pill by ${clear}px`);
        } else {
          ok(`${tag} reservation is doing real work here`, dead > 0 || m.ftLastBtn.right <= m.pill.left - 8,
            `reserved ${dead}px, column clears the pill by ${clear}px`);
        }
      }
      await page.screenshot({ path: `${shots}/portal-${w}.png`, fullPage: false });
      // A second shot with the quote card and the footer actually on screen. The measurements
      // above are the verdict, but the alignment they assert is the kind a human should be able
      // to look at, and the first shot is the top of the page.
      await page.evaluate(() => { const n = document.querySelector(".ssd-dt"); if (n) n.scrollIntoView({ block: "end" }); });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/portal-details-${w}.png`, fullPage: false });
      await page.evaluate(() => { const h = document.querySelector(".ss-designer-host"); if (h) h.scrollTop = 0; });
    }

    // 6. one breakpoint from the cap upward, read off the FRAME (never the viewport)
    const bps = [3440, 2560, 1728].map((w) => seen[w].bp);
    ok(`same breakpoint at 1728 / 2560 / 3440`, new Set(bps).size === 1 && bps[0] === "xl", `bps ${bps.join(",")}`);

    // 7. the tiles stop growing once the wrapper is capped
    ok(`style tiles stop growing above the cap`, seen[3440].tileW === seen[2560].tileW,
      `2560 ${seen[2560].tileW} / 3440 ${seen[3440].tileW}`);

    ok("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await page.close();

    const bad = failed();
    console.log(bad.length ? `\n${bad.length} check(s) failed` : "\nall checks passed");
    console.log(`shots in ${shots}`);
    process.exitCode = bad.length ? 1 : 0;
  } finally {
    await browser.close();
  }
};

run().catch((e) => { console.error(e); process.exitCode = 1; });
