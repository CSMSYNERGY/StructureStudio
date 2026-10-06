// A BUILDER'S OWN LAP COURSE (migration 275), driven in the real designer against the COMPILED bundle
// and measured off the scene graph (__SS3D_DEBUG). And, since 2026-10-06, the lap renamed 7" LP Lap
// Siding with its drawing UNCHANGED, and 4.5" Vinyl Siding beside it as its own id (migration 285).
//
// A builder, on the portal 2026-10-03: "I will need an option for 4.5" vinyl siding". One of their
// styles sells the lap row renamed "Vinyl Siding"; the builder types 4.5 in its "Course (in)" box and
// get_config carries it as that entry's exposureIn. The style here is set up the same way: panel by
// default, lap offered as "Vinyl Siding", 7 ft walls. The course size is on the scale of the built-in
// names since 2026-10-06 (D3_LAP_NOMINAL_IN): blank or 7 is lap's own drawing, 4.5 is vinyl's.
//
//   A. NO SIZE (every builder today): the customer picks Vinyl Siding; the docked 3D draws lap
//      exactly as before the rename: 13 course lines up a 7 ft wall (14 boards), 0.5 ft apart, the
//      raster at 4 ft a tile (repeat 1/4). THIS IS THE PROOF THE LAP DRAWING DID NOT MOVE.
//   B. 4.5 IN: the same pick draws 4.5/7 of lap's course, 0.3214 ft: 21 lines up the same wall, the
//      raster at 18/7 ft a tile (repeat 7/18), so its boards land on the relief lines; rebuilt in place
//      in the dock. Picking Panel Siding or the builder's standard takes every lap line away; picking
//      Vinyl again brings 4.5 back. The full-screen viewer draws the same 21 lines.
//   C. a size the designer must ignore (2 in, outside 3..12): lap's own courses, as A.
//   G. 4.5" VINYL SIDING, the fifth id: a style offering both under our built-in names. The dropdown
//      shows 7" LP Lap Siding and 4.5" Vinyl Siding; vinyl draws B's 21 lines, and the full-screen
//      viewer's scene digest (every mesh's world box, material colour and raster repeat) is IDENTICAL
//      to B's; switched to 7" LP Lap Siding it draws A's 13, and in the viewer its scene is A's.
//   D. THE QUOTE: with the four-corner page on (276) and Vinyl picked, the submitted PDF is the plan
//      and the four-corner sheet; written to the shots folder as sample-quote-vinyl.pdf and
//      corner-sheet-vinyl.jpg (made-up "Acme Sheds" and "Pat Tester").
//   E. THE CALIBRATION PANEL (?admin=1): with Vinyl Siding at 4.5 in picked in the designer on the
//      same page, opening the style's 3D calibration and saving it untouched sends back NO
//      sidingExposureIn and no siding: the customer's pick is never frozen into building_styles.d3
//      (openCalEditor resolves the style without the 7th argument).
//   F. zero page errors.
//
// Wall close-ups at 6 in and at 4.5 in go to the shots folder too. Supabase is stubbed at the network
// layer; nothing leaves the machine and nothing is saved anywhere.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>   (after npm run compile)
//   node tests/harness/lapCourses.mjs           (SS_BASE=http://127.0.0.1:<port> to move it)
//   SS_SHOTS=<dir> for the shots and the sample quote.
//
// To prove the checks can fail, serve the tree before this change (git archive 135699d) as SS_BASE:
// 5 checks fail, B's three 4.5 in checks and E's first (it draws 0.5 ft courses whatever the config
// says) and D's sheet (no four-corner page before 276); A and C hold, as they should. Against the tree
// before the vinyl (git archive ea0a0de0): B's and E's 4.5 in checks fail (they draw 0.375 ft, true
// inches) and so does all of G (no vinyl in the dropdown); A and C hold, which is the point.
//
// Exit 0 = every assertion held.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, REF, BASE } from "./lib.mjs";

const CLIENT = "harness-lap-courses";
const SIZE = "10x12";
const W = 10, L = 12, H = 7;
const STYLE = "Harness Deluxe";
const COLORS = { body: "#E9E4D8", trim: "#5B5F63", roof: "#3B3F45" };
const D3 = { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, colors: COLORS, wallHeightFt: H, roofMaterial: "shingle" };
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };

const configFor = ({ exposureIn, corners, vinyl } = {}) => {
  const cfg = {
    clientId: CLIENT,
    branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "dlx", label: STYLE, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3 }],
    defaultSizes: [SIZE],
    sizePricing: { dlx: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } } },
    options: [], colors: [], wallHeightOptions: {},
    // As get_config emits it: the size is on the lap entry only when the builder typed one (275).
    // `vinyl`: the style offers lap and vinyl side by side under our built-in names (285).
    claddingOptions: { dlx: vinyl ? [
      { id: "panel", label: null, basis: "sqft_option", rate: 0, charged: false },
      { id: "lap", label: null, basis: "sqft_option", rate: 0, charged: false },
      { id: "vinyl", label: null, basis: "sqft_option", rate: 2, charged: true },
    ] : [
      { id: "panel", label: null, basis: "sqft_option", rate: 0, charged: false },
      { id: "lap", label: "Vinyl Siding", basis: "sqft_option", rate: 0, charged: false, ...(exposureIn !== undefined ? { exposureIn } : {}) },
    ] },
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
  };
  if (corners !== undefined) cfg.quoteCornerViews = corners;
  return cfg;
};

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

async function startDesign(page) {
  await openDesigner(page, CLIENT);
  await page.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 40000 });
  await page.locator("[data-ss-style]").first().click();
  await settle(page, 600);
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
  if (await sel.count()) await sel.first().selectOption({ label: SIZE });
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 20000 });
  await settle(page, 800);
}
const sidingSelect = (page) => page.locator("select").filter({ has: page.locator("option", { hasText: "Builder's standard" }) }).first();
async function pickSiding(page, label) {
  await sidingSelect(page).selectOption({ label });
  await settle(page, 700);
}
async function dock(page) {
  const show = page.getByRole("button", { name: /Show 3D|3D View/ });
  if (!(await page.evaluate(() => !!(window.__ss3dPanel && window.__ss3dPanel.model))) && await show.count()) await show.first().click();
  await page.waitForFunction(() => !!(window.__ss3dPanel && window.__ss3dPanel.model), null, { timeout: 60000 });
  await settle(page, 1000);
}
async function openViewer(page) {
  const edit = page.getByRole("button", { name: /Edit in 3D/ });
  await edit.first().waitFor({ state: "visible", timeout: 60000 });
  await page.evaluate(() => { window.__ss3dEngine = null; });
  await edit.first().click();
  await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length > 0); }, null, { timeout: 90000 });
  await settle(page, 1200);
}
async function closeViewer(page) {
  await page.getByRole("button", { name: "✕", exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector('div[style*="z-index: 1100"] canvas'), null, { timeout: 30000 }).catch(() => {});
  await settle(page, 800);
}

// The lap relief: every proud course line is a box 0.08 ft tall and 0.1 ft deep (buildOneWall's
// lap branch, and the gable and wing triangles' lines). Their heights, from the floor, in each wall
// group's own frame; and the wall raster's repeat (the material carrying a map AND a bump map).
async function measure(page, handle) {
  return page.evaluate(({ handle, H }) => {
    const E = window[handle], M = E.model;
    const ys = new Set();
    let strips = 0;
    M.root.traverse((q) => {
      if (!q.isMesh || !q.geometry || q.geometry.type !== "BoxGeometry") return;
      const p = q.geometry.parameters;
      if (Math.abs(p.height - 0.08) > 1e-6 || Math.abs(p.depth - 0.1) > 1e-6) return;
      strips++;
      ys.add(Math.round(q.position.y * 10000) / 10000);
    });
    const wall = [...ys].filter((y) => y > 0 && y < H).sort((a, b) => a - b);
    const gaps = wall.slice(1).map((y, i) => Math.round((y - wall[i]) * 10000) / 10000);
    let repeat = null;
    M.root.traverse((q) => {
      const m = q.isMesh && q.material;
      if (!repeat && m && m.map && m.bumpMap && m.map.repeat) repeat = [m.map.repeat.x, m.map.repeat.y];
    });
    return { strips, lines: wall.length, first: wall[0] ?? null, last: wall[wall.length - 1] ?? null, gaps: [...new Set(gaps)], repeat };
  }, { handle, H });
}
// A canonical, order-independent digest of everything the full-screen viewer drew (wings.mjs's, plus
// each textured material's raster repeat): two builds, or two picks, with equal digests drew the same
// thing.
async function digest(page) {
  return page.evaluate(() => {
    const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const r3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);
    const r6 = (v) => (Math.round(v * 1e6) / 1e6).toFixed(6);
    const out = [];
    [["roof", M.roofGroup], ["walls", M.wallsGroup], ["open", M.openingsGroup], ["interior", M.interiorGroup]].forEach(([name, grp]) => {
      if (!grp) return;
      grp.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox;
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
          const v = new V(x, y, z).applyMatrix4(o.matrixWorld);
          [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
        }
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const m = mats.map((q) => (q && q.color ? q.color.getHexString() : "-") + (q && q.map && q.map.repeat ? `@${r6(q.map.repeat.x)},${r6(q.map.repeat.y)}` : "")).join("/");
        out.push(`${name} ${o.geometry.type} ${mn.map(r3).join(",")} ${mx.map(r3).join(",")} ${m}`);
      });
    });
    return out.sort();
  });
}
const said = (m) => `${m.lines} lines, first ${m.first} last ${m.last}, gaps ${JSON.stringify(m.gaps)}, repeat ${JSON.stringify(m.repeat && m.repeat.map((v) => +v.toFixed(4)))}, ${m.strips} strips`;
// Every gap within 2e-4 ft of the course, not one distinct gap: the heights are rounded to 1e-4 ft,
// so a course of 0.32142857 ft rounds to gaps of 0.3214 and 0.3215 (0.5 ft rounded to one).
const isLap = (m, stepFt, lines) => m.lines === lines && m.gaps.length >= 1 && m.gaps.every((g) => near(g, stepFt, 2e-4)) && near(m.first, stepFt, 1e-4)
  && m.repeat && near(m.repeat[0], 1 / 8, 1e-9) && near(m.repeat[1], 0.5 / (4 * stepFt), 1e-9);

// A close-up of the front-left corner in the full-screen viewer, so the courses can be counted by eye.
async function closeUp(page, path) {
  await page.evaluate(({ W, L }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(W * 1.5, 4.4, L * 1.45);
    E.controls.target.set(0, 3.0, 0);
    E.controls.update();
    E.render();
  }, { W, L });
  await settle(page, 300);
  await page.evaluate(() => window.__ss3dEngine.render());
  await page.locator("canvas").last().screenshot({ path });
}

const LAP_LOOK = { step: 0.5, lines: 13 };
const VINYL_LOOK = { step: 0.5 * 4.5 / 7, lines: 21 };
const DIGESTS = {};
async function runLook(ctx, tag, exposureIn, ok, shots, { full = false } = {}) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: configFor({ exposureIn }), fixtures: FIXTURES });
  const want = exposureIn === 4.5 ? VINYL_LOOK : LAP_LOOK;
  try {
    await startDesign(page);
    await dock(page);
    let m = await measure(page, "__ss3dPanel");
    ok(`${tag}: the style's own panel siding draws no lap lines`, m.strips === 0 && m.repeat && near(m.repeat[0], 1 / 4, 1e-9) && near(m.repeat[1], 1 / 8, 1e-9), said(m));
    await pickSiding(page, "Vinyl Siding");
    await page.waitForFunction(() => { let n = 0; window.__ss3dPanel.model.root.traverse((q) => { if (q.isMesh && q.geometry && q.geometry.type === "BoxGeometry" && Math.abs(q.geometry.parameters.height - 0.08) < 1e-6) n++; }); return n > 0; }, null, { timeout: 30000 }).catch(() => {});
    m = await measure(page, "__ss3dPanel");
    ok(`${tag}: Vinyl Siding in the dock: ${want.lines} lines ${want.step} ft apart up the ${H} ft wall, the raster on the same courses`, isLap(m, want.step, want.lines), said(m));
    if (full) {
      await pickSiding(page, "Panel Siding");
      await page.waitForFunction(() => { let n = 0; window.__ss3dPanel.model.root.traverse((q) => { if (q.isMesh && q.geometry && q.geometry.type === "BoxGeometry" && Math.abs(q.geometry.parameters.height - 0.08) < 1e-6) n++; }); return n === 0; }, null, { timeout: 30000 }).catch(() => {});
      m = await measure(page, "__ss3dPanel");
      ok(`${tag}: Panel Siding takes every lap line away (the size goes with the lap)`, m.strips === 0 && near(m.repeat[1], 1 / 8, 1e-9), said(m));
      await pickSiding(page, "Builder's standard");
      m = await measure(page, "__ss3dPanel");
      ok(`${tag}: so does the builder's standard (this style's own panel)`, m.strips === 0, said(m));
      await pickSiding(page, "Vinyl Siding");
      await page.waitForFunction(() => { let n = 0; window.__ss3dPanel.model.root.traverse((q) => { if (q.isMesh && q.geometry && q.geometry.type === "BoxGeometry" && Math.abs(q.geometry.parameters.height - 0.08) < 1e-6) n++; }); return n > 0; }, null, { timeout: 30000 }).catch(() => {});
      m = await measure(page, "__ss3dPanel");
      ok(`${tag}: Vinyl again: ${want.step} ft courses again`, isLap(m, want.step, want.lines), said(m));
    }
    await openViewer(page);
    const v = await measure(page, "__ss3dEngine");
    ok(`${tag}: the full-screen viewer draws the same ${want.lines} lines`, isLap(v, want.step, want.lines), said(v));
    DIGESTS[tag] = await digest(page);
    if (shots) await closeUp(page, join(shots, `${tag.replace(/\W+/g, "-")}-wall.png`));
    await closeViewer(page);
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
    if (shots) await page.screenshot({ path: join(shots, `${tag.replace(/\W+/g, "-")}-FAIL.png`) }).catch(() => {});
  } finally {
    await page.close();
  }
}

// ── G. 4.5" Vinyl Siding, its own id, beside the 7" LP Lap Siding ──
async function runVinyl(ctx, ok, shots) {
  // Waits for the dock to have rebuilt with exactly `n` lap strips (4 walls' worth of course lines):
  // "any strips" would read the model the previous pick left behind.
  const waitStrips = (page, n) => page.waitForFunction((n) => {
    let k = 0;
    window.__ss3dPanel.model.root.traverse((q) => { if (q.isMesh && q.geometry && q.geometry.type === "BoxGeometry" && Math.abs(q.geometry.parameters.height - 0.08) < 1e-6) k++; });
    return k === n;
  }, n, { timeout: 30000 }).catch(() => {});
  const LAP_STRIPS = 52, VINYL_STRIPS = 84;

  // G1: both names offered; vinyl, then the lap, then vinyl again in the dock; vinyl in the viewer.
  {
    const tag = "G vinyl";
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
    await stubSupabase(page, { config: configFor({ vinyl: true }), fixtures: FIXTURES });
    try {
      await startDesign(page);
      const names = await sidingSelect(page).locator("option").allTextContents();
      ok(`${tag}: the dropdown offers both under our names, 7" LP Lap Siding and 4.5" Vinyl Siding`,
        JSON.stringify(names) === JSON.stringify(["Builder's standard", "Panel Siding", '7" LP Lap Siding', '4.5" Vinyl Siding']), JSON.stringify(names));
      await dock(page);
      await pickSiding(page, '4.5" Vinyl Siding');
      await waitStrips(page, VINYL_STRIPS);
      let m = await measure(page, "__ss3dPanel");
      ok(`${tag}: 4.5" Vinyl Siding in the dock: ${VINYL_LOOK.lines} lines ${VINYL_LOOK.step.toFixed(4)} ft apart, the raster on the same courses`, isLap(m, VINYL_LOOK.step, VINYL_LOOK.lines), said(m));
      await pickSiding(page, '7" LP Lap Siding');
      await waitStrips(page, LAP_STRIPS);
      m = await measure(page, "__ss3dPanel");
      ok(`${tag}: switched to 7" LP Lap Siding: ${LAP_LOOK.lines} lines ${LAP_LOOK.step} ft apart, lap's own drawing`, isLap(m, LAP_LOOK.step, LAP_LOOK.lines), said(m));
      await pickSiding(page, '4.5" Vinyl Siding');
      await waitStrips(page, VINYL_STRIPS);
      m = await measure(page, "__ss3dPanel");
      ok(`${tag}: and back to vinyl: ${VINYL_LOOK.lines} lines again`, isLap(m, VINYL_LOOK.step, VINYL_LOOK.lines), said(m));
      await openViewer(page);
      const v = await measure(page, "__ss3dEngine");
      ok(`${tag}: the full-screen viewer draws the same ${VINYL_LOOK.lines} lines`, isLap(v, VINYL_LOOK.step, VINYL_LOOK.lines), said(v));
      const d = await digest(page);
      const b = DIGESTS["B 4.5 in"];
      if (b) {
        const diff = d.filter((x, i) => x !== b[i]);
        ok(`${tag}: its scene is B's (a lap row at 4.5) mesh for mesh: the same drawing under its own id`, d.length === b.length && diff.length === 0,
          `${d.length} vs ${b.length} meshes, ${diff.length} differ: ${diff.slice(0, 2).join(" | ")}`);
      }
      if (shots) await closeUp(page, join(shots, "G-vinyl-4.5in-wall.png"));
      await closeViewer(page);
      ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
    } catch (e) {
      ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
      if (shots) await page.screenshot({ path: join(shots, "G-vinyl-FAIL.png") }).catch(() => {});
    } finally {
      await page.close();
    }
  }

  // G2: the 7" LP Lap Siding under our name, in the viewer: A's scene, mesh for mesh.
  {
    const tag = "G lap";
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
    await stubSupabase(page, { config: configFor({ vinyl: true }), fixtures: FIXTURES });
    try {
      await startDesign(page);
      await dock(page);
      await pickSiding(page, '7" LP Lap Siding');
      await waitStrips(page, LAP_STRIPS);
      await openViewer(page);
      const v = await measure(page, "__ss3dEngine");
      ok(`${tag}: 7" LP Lap Siding in the full-screen viewer: ${LAP_LOOK.lines} lines ${LAP_LOOK.step} ft apart`, isLap(v, LAP_LOOK.step, LAP_LOOK.lines), said(v));
      const d = await digest(page);
      const a = DIGESTS["A no size"];
      if (a) {
        const diff = d.filter((x, i) => x !== a[i]);
        ok(`${tag}: its scene is A's (the lap with no size) mesh for mesh`, d.length === a.length && diff.length === 0,
          `${d.length} vs ${a.length} meshes, ${diff.length} differ: ${diff.slice(0, 2).join(" | ")}`);
      }
      if (shots) await closeUp(page, join(shots, "G-lap-7in-wall.png"));
      await closeViewer(page);
      ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
    } catch (e) {
      ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
      if (shots) await page.screenshot({ path: join(shots, "G-lap-FAIL.png") }).catch(() => {});
    } finally {
      await page.close();
    }
  }
}

// ── D. The quote, with the four-corner page and the 4.5 in vinyl ──
const countPdfPages = (buf) => (Buffer.from(buf).toString("latin1").match(/\/Type\s*\/Page(?!s)/g) || []).length;
function pdfImages(buf) {
  const b = Buffer.from(buf);
  const s = b.toString("latin1");
  const re = /\/Subtype \/Image \/Width (\d+) \/Height (\d+) [^>]*\/Length (\d+) >>\nstream\n/g;
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    const at = m.index + m[0].length;
    out.push({ w: Number(m[1]), h: Number(m[2]), bytes: b.subarray(at, at + Number(m[3])) });
  }
  return out;
}
async function runQuote(ctx, ok, shots) {
  const tag = "D quote";
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const uploads = [], submits = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
  await stubSupabase(page, { config: configFor({ exposureIn: 4.5, corners: true }), fixtures: FIXTURES });
  await page.route(`**/${REF}.supabase.co/storage/v1/object/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: cors, body: "" });
    let bytes = null;
    try { bytes = req.postDataBuffer(); } catch (_e) { bytes = null; }
    uploads.push({ path: new URL(req.url()).pathname, bytes });
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ Key: "x" }) });
  });
  await page.route(`**/functions/v1/submit-estimate**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: cors, body: "" });
    try { submits.push(JSON.parse(req.postData() || "{}")); } catch (_e) { submits.push({}); }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, shortCode: "SS-TEST" }) });
  });
  try {
    await startDesign(page);
    await pickSiding(page, "Vinyl Siding");
    // 555-01xx is reserved for fiction, the same number the e2e suite uses.
    await page.getByPlaceholder("Full Name").fill("Pat Tester");
    await page.getByPlaceholder("email@example.com").fill("pat@example.com");
    await page.getByPlaceholder("(555) 555-5555").fill("5550104477");
    await settle(page, 600);
    const quote = page.locator("button.ssd-ft-cta.is-quote").first();
    await quote.scrollIntoViewIfNeeded();
    await quote.click();
    const t0 = Date.now();
    while (submits.length === 0 && Date.now() - t0 < 150000) await page.waitForTimeout(500);
    await settle(page, 500);
    const pdfs = uploads.filter((u) => u.path.endsWith(".pdf") && u.bytes);
    const pdf = pdfs.length ? pdfs[pdfs.length - 1].bytes : null;
    const imgs = pdf ? pdfImages(pdf) : [];
    const payload = submits[submits.length - 1] || {};
    ok(`${tag}: submitted, with one PDF`, submits.length === 1 && pdfs.length === 1, `submits ${submits.length}, pdfs ${pdfs.length}`);
    ok(`${tag}: the PDF is the plan and the four-corner sheet (1632 x 2112)`, pdf && countPdfPages(pdf) === 2 && imgs[1] && imgs[1].w === 1632 && imgs[1].h === 2112,
      pdf ? `${countPdfPages(pdf)} page(s), page 2 ${imgs[1] ? imgs[1].w + " x " + imgs[1].h : "none"}` : "no pdf");
    // claddingId is the stable id (the attribute block's own comment): the pick, not its label.
    const sent = JSON.stringify(payload);
    ok(`${tag}: submit-estimate is told the customer's cladding pick`, sent.includes('"claddingId":"lap"'), (sent.match(/"cladding[^,]*,"claddingId":"[^"]*"/) || ["no cladding in the payload"])[0]);
    if (pdf && shots) writeFileSync(join(shots, "sample-quote-vinyl.pdf"), Buffer.from(pdf));
    if (imgs[1] && shots) writeFileSync(join(shots, "corner-sheet-vinyl.jpg"), Buffer.from(imgs[1].bytes));
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
    if (shots) await page.screenshot({ path: join(shots, "D-quote-FAIL.png") }).catch(() => {});
  } finally {
    await page.close();
  }
}

// ── E. The calibration panel never takes the customer's size ──
async function runCalibration(ctx, ok, shots) {
  const tag = "E calibration";
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const calls = await stubSupabase(page, { config: configFor({ exposureIn: 4.5 }), fixtures: FIXTURES });
  try {
    await page.goto(`${BASE}/?client=${encodeURIComponent(CLIENT)}&admin=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
    await page.getByPlaceholder("Admin password").fill("harness");
    // The customer's side of the same page: the style, the size, Vinyl Siding at 4.5 in, drawn.
    await page.locator("[data-ss-style]").first().click();
    await settle(page, 600);
    const sizeSel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
    if (await sizeSel.count()) await sizeSel.first().selectOption({ label: SIZE });
    await settle(page, 800);
    await pickSiding(page, "Vinyl Siding");
    await dock(page);
    const m = await measure(page, "__ss3dPanel");
    ok(`${tag}: the customer's side draws Vinyl at 4.5 in on this page`, isLap(m, VINYL_LOOK.step, VINYL_LOOK.lines), said(m));
    // The builder's side: open this style's calibration and save it untouched.
    const btn = page.getByRole("button", { name: STYLE, exact: true });
    await btn.first().waitFor({ state: "visible", timeout: 30000 });
    await btn.first().click();
    await page.getByRole("button", { name: "Save to config" }).waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 500);
    const saves = () => calls.filter((c) => c.path && c.path.endsWith("/functions/v1/admin-save-settings") && c.body && c.body.action === "save_style_d3");
    await page.getByRole("button", { name: "Save to config" }).click();
    const t0 = Date.now();
    while (saves().length === 0 && Date.now() - t0 < 15000) await settle(page, 100);
    const d3 = saves().length ? saves()[saves().length - 1].body.d3 : null;
    ok(`${tag}: saved untouched, the style sends no sidingExposureIn`, d3 && !Object.prototype.hasOwnProperty.call(d3, "sidingExposureIn"), d3 ? Object.keys(d3).join(",") : "no save sent");
    ok(`${tag}: and no siding (the style stores none; the customer's lap is not frozen into it)`, d3 && (d3.siding == null), d3 ? JSON.stringify(d3.siding) : "no save sent");
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
    if (shots) await page.screenshot({ path: join(shots, "E-calibration-FAIL.png") }).catch(() => {});
  } finally {
    await page.close();
  }
}

async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("lapCourses");
  const { browser, ctx } = await launch({ width: 1440, height: 1000 });
  const only = (process.env.SS_CASES || "A,B,C,G,D,E").split(",");
  if (only.includes("A")) await runLook(ctx, "A no size", undefined, ok, shots);
  if (only.includes("B")) await runLook(ctx, "B 4.5 in", 4.5, ok, shots, { full: true });
  if (only.includes("C")) await runLook(ctx, "C size out of range", 2, ok, shots);
  if (only.includes("G")) await runVinyl(ctx, ok, shots);
  if (only.includes("D")) await runQuote(ctx, ok, shots);
  if (only.includes("E")) await runCalibration(ctx, ok, shots);
  await browser.close();
  console.log(`\nSHOTS ${shots}`);
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL GREEN");
  process.exit(bad.length ? 1 : 0);
}
main();
