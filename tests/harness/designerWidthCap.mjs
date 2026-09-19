// The ultrawide width cap, measured on the real public designer (Carolyn 2026-09-17).
//
// She reported three things on a 32" screen: the designer "stretches forever", the images just get
// bigger, and "the scroll bar never goes away so I can't see all the buildings". The quote also
// "stops reading like an invoice at full width". This drives the COMPILED bundle at four viewports
// and measures what actually lands, rather than eyeballing a screenshot:
//
//   1. the page NEVER scrolls sideways (scrollWidth vs clientWidth on the scrolling element)
//   2. #root caps at 1728 and centres, so gutters appear ONLY above the cap and are even
//   3. the designer frame's measured breakpoint (data-ssd-bp) is the SAME "xl" at 1728 and above —
//      the cap must not push the frame into a different layout at some widths and not others
//   4. the canvas row stays well clear of SS_DOCK_MIN_ROW_W (960) at the cap, so the docked 3D
//      panel cannot oscillate (a flip tears down a WebGL context)
//   5. the style strip shows NO scrollbar, in a tenant with more styles than fit, and its arrows
//      are there instead — and with few styles there is neither
//   6. the style tiles stop growing at the cap (the "images just get bigger" complaint)
//   7. the quote card and the footer bar's content share one width and one centre line
//
//   python -m http.server 8125 --bind 127.0.0.1        (repo root)
//   node tests/harness/designerWidthCap.mjs             (exit 0 = every check held)
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir } from "./lib.mjs";
import { CONFIG as GABLE_CONFIG, FIXTURES } from "./gableProbe.mjs";

const CAP = 1728;           // index.html #root / portal 06-3d DesignerTab
const DOCK_MIN_ROW_W = 960; // SS_DOCK_MIN_ROW_W
const INVOICE_MAX = 960;    // --ssd-invoice-max

const base = GABLE_CONFIG.buildingStyles[0];
// Twelve styles against a stylesPerRow of 8: the strip genuinely overflows, which is the only
// state in which a scrollbar could show. contactFields [] unlocks the public Details section with
// no typing (contactComplete short-circuits on an empty required list), so the quote card renders.
const MANY = {
  ...GABLE_CONFIG,
  clientId: "harness-width-many",
  contactFields: [],
  branding: { ...(GABLE_CONFIG.branding || {}), stylesPerRow: 8 },
  buildingStyles: Array.from({ length: 12 }, (_, i) => ({ ...base, value: `s${i}`, label: `Style ${i + 1}` })),
  sizePricing: Object.fromEntries(Array.from({ length: 12 }, (_, i) =>
    [`s${i}`, GABLE_CONFIG.sizePricing[base.value]])),
  claddingOptions: Object.fromEntries(Array.from({ length: 12 }, (_, i) =>
    [`s${i}`, (GABLE_CONFIG.claddingOptions || {})[base.value] || []])),
};
// Three styles at the same stylesPerRow: nothing overflows, so nothing should be drawn along the
// bottom of the strip at all.
const FEW = {
  ...MANY,
  clientId: "harness-width-few",
  buildingStyles: MANY.buildingStyles.slice(0, 3),
};

// Everything the checks read, in one page evaluation so all of it describes the same layout.
const measure = (page) => page.evaluate(({ capw }) => {
  const el = document.scrollingElement || document.documentElement;
  const root = document.getElementById("root");
  const frame = document.querySelector(".ssd-frame");
  const strip = document.querySelector("[data-ss-style-strip]");
  const tile = document.querySelector(".ssd-tile");
  const dt = document.querySelector(".ssd-dt");
  const ft = document.querySelector(".ssd-ft");
  const rootR = root && root.getBoundingClientRect();
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), mid: Math.round(r.left + r.width / 2) }; };
  // The canvas row is the element SS_DOCK_MIN_ROW_W is measured on: the plan svg's scrolling parent
  // inside the designer. Find it from the svg upward rather than by a class that could be renamed.
  const svg = document.querySelector(".ssd-frame svg");
  let rowW = null;
  for (let n = svg && svg.parentElement; n && n !== document.body; n = n.parentElement) {
    if (n.hasAttribute && n.hasAttribute("data-ss-canvas-row")) { rowW = n.clientWidth; break; }
  }
  if (rowW == null && svg) {
    // No explicit marker: the widest block ancestor inside the frame that still sits under .ssd-main.
    let n = svg.parentElement, best = null;
    while (n && n !== document.body) { if (n.classList && n.classList.contains("ssd-main")) { best = n; break; } n = n.parentElement; }
    rowW = best ? best.clientWidth : null;
  }
  const cs = strip && getComputedStyle(strip);
  return {
    vw: window.innerWidth,
    pageScrollW: el.scrollWidth,
    pageClientW: el.clientWidth,
    rootW: rootR ? Math.round(rootR.width) : null,
    gutterL: rootR ? Math.round(rootR.left) : null,
    gutterR: rootR ? Math.round(el.clientWidth - rootR.right) : null,
    bp: frame ? frame.getAttribute("data-ssd-bp") : null,
    frameW: frame ? frame.clientWidth : null,
    rowW,
    // A laid-out scrollbar costs the scroller height; an overlaid one does not. Both are covered
    // by also reading the computed scrollbar-width and the ::-webkit rule's effect.
    stripScrollbarPx: strip ? strip.offsetHeight - strip.clientHeight : null,
    stripOverflows: strip ? strip.scrollWidth - strip.clientWidth > 1 : null,
    stripScrollbarWidth: cs ? cs.scrollbarWidth : null,
    arrows: document.querySelectorAll("[data-ss-strip-arrow]").length,
    tileW: tile ? Math.round(tile.getBoundingClientRect().width) : null,
    dt: box(dt),
    ft: box(ft),
    capw,
  };
}, { capw: CAP });

const run = async () => {
  const { ok, failed } = reporter();
  const { browser, ctx } = await launch({ width: 1280, height: 900 });
  const shots = shotsDir("designerWidthCap");
  try {
    // ── A. the many-styles tenant, at four viewports ──────────────────────────────────────
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    await stubSupabase(page, { config: MANY, fixtures: FIXTURES });
    await openDesigner(page, MANY.clientId);
    // Open Details so the quote card is really in the page (contactFields [] leaves it unlocked).
    const openDetails = async () => {
      const cta = page.locator(".ssd-dt-cta").first();
      if (await cta.count() && await cta.isVisible().catch(() => false)) { await cta.click(); await page.waitForTimeout(400); }
    };

    const seen = {};
    for (const w of [3440, 2560, 1728, 414]) {
      await page.setViewportSize({ width: w, height: w < 500 ? 900 : 1200 });
      await page.waitForTimeout(600);
      await openDetails();
      await page.waitForTimeout(400);
      const m = await measure(page);
      seen[w] = m;
      const tag = `${w}px`;
      const note = JSON.stringify({ root: m.rootW, gutters: [m.gutterL, m.gutterR], bp: m.bp, row: m.rowW, tile: m.tileW, dt: m.dt && m.dt.w, ft: m.ft && m.ft.w });

      // 1. no horizontal PAGE scroll, at any width
      ok(`${tag} no horizontal page scroll`, m.pageScrollW <= m.pageClientW + 1,
        `scrollWidth ${m.pageScrollW} vs clientWidth ${m.pageClientW}`);

      // 2. the cap, and even gutters only above it
      if (w > CAP) {
        ok(`${tag} #root capped at ${CAP}`, m.rootW === CAP, `root ${m.rootW}`);
        ok(`${tag} gutters even and non-zero`, m.gutterL > 0 && Math.abs(m.gutterL - m.gutterR) <= 1,
          `left ${m.gutterL} right ${m.gutterR}`);
      } else {
        ok(`${tag} no gutters at or below the cap`, m.gutterL <= 1 && m.gutterR <= 1,
          `left ${m.gutterL} right ${m.gutterR}`);
        ok(`${tag} #root fills the viewport`, m.rootW >= m.pageClientW - 1, `root ${m.rootW} vs ${m.pageClientW}`);
      }

      // 4. the docked 3D panel's threshold, with its 40px hysteresis band
      if (w >= 1000) {
        ok(`${tag} canvas row clear of the dock threshold`, m.rowW != null && m.rowW >= DOCK_MIN_ROW_W + 40,
          `row ${m.rowW} vs ${DOCK_MIN_ROW_W} (+40 band)`);
      }

      // 5. the strip scrolls but draws no bar
      ok(`${tag} style strip shows no scrollbar`,
        m.stripScrollbarWidth === "none" && (m.stripScrollbarPx === 0 || m.stripScrollbarPx === null),
        `scrollbar-width ${m.stripScrollbarWidth}, gutter ${m.stripScrollbarPx}px`);

      // 7. the invoice column
      if (m.dt && m.ft) {
        ok(`${tag} quote card capped at ${INVOICE_MAX}`, m.dt.w <= INVOICE_MAX + 1, `dt ${m.dt.w}`);
        ok(`${tag} quote card and footer share a width`, Math.abs(m.dt.w - m.ft.w) <= 1, `dt ${m.dt.w} ft ${m.ft.w}`);
        ok(`${tag} quote card and footer share a centre line`, Math.abs(m.dt.mid - m.ft.mid) <= 1,
          `dt mid ${m.dt.mid} ft mid ${m.ft.mid}`);
      } else {
        ok(`${tag} quote card and footer are in the page`, false, note);
      }
      await page.screenshot({ path: `${shots}/width-${w}.png`, fullPage: false });
      console.log(`      ${tag} ${note}`);
    }

    // 3. one breakpoint from the cap upward — the cap must not change which layout ships
    const bps = [3440, 2560, 1728].map((w) => seen[w].bp);
    ok(`same breakpoint at 1728 / 2560 / 3440`, new Set(bps).size === 1 && bps[0] === "xl", `bps ${bps.join(",")}`);
    ok(`the phone still lands on a small breakpoint`, seen[414].bp === "xs", `bp ${seen[414].bp}`);

    // 6. the tiles stop growing at the cap
    ok(`style tiles stop growing above the cap`,
      seen[3440].tileW === seen[CAP].tileW && seen[2560].tileW === seen[CAP].tileW,
      `1728 ${seen[CAP].tileW} / 2560 ${seen[2560].tileW} / 3440 ${seen[3440].tileW}`);

    // 5b. with the strip overflowing, the arrows are the affordance the scrollbar used to be
    ok(`overflowing strip offers arrows instead of a bar`,
      seen[CAP].stripOverflows === true && seen[CAP].arrows >= 1,
      `overflows ${seen[CAP].stripOverflows}, arrows ${seen[CAP].arrows}`);
    await page.close();

    // ── B. a tenant whose styles all fit: nothing along the bottom at all ─────────────────
    const few = await ctx.newPage();
    const fewErrors = collectErrors(few);
    await stubSupabase(few, { config: FEW, fixtures: FIXTURES });
    await openDesigner(few, FEW.clientId);
    await few.setViewportSize({ width: 2560, height: 1200 });
    await few.waitForTimeout(600);
    const fm = await measure(few);
    ok(`few styles: the strip does not overflow`, fm.stripOverflows === false, `scroll gap ${fm.stripOverflows}`);
    ok(`few styles: no arrows and no bar`, fm.arrows === 0 && fm.stripScrollbarWidth === "none",
      `arrows ${fm.arrows}, scrollbar-width ${fm.stripScrollbarWidth}`);
    await few.screenshot({ path: `${shots}/few-styles-2560.png` });
    await few.close();

    const allErrors = [...errors, ...fewErrors];
    ok("no uncaught page errors", allErrors.length === 0, allErrors.slice(0, 3).join(" | "));

    const bad = failed();
    console.log(bad.length ? `\n${bad.length} check(s) failed` : "\nall checks passed");
    console.log(`shots in ${shots}`);
    process.exitCode = bad.length ? 1 : 0;
  } finally {
    await browser.close();
  }
};

run().catch((e) => { console.error(e); process.exitCode = 1; });
