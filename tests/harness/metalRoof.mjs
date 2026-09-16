// Metal roof PROFILES, MEASURED (2026-09-15): a metal roof draws AG Panel unless its style says
// "standingseam", and a shingle roof is untouched by either.
//
// Carolyn asked for AG Panel roofs on 07-08, 09-11 and 09-15; every metal roof had drawn standing
// seam because the "metal" raster was the only one a roof had. The claim this script checks is not
// "it looks like AG Panel" but things that can be measured off the scene graph:
//   1. the default metal roof draws the "agroof" raster -- 4 fully drawn trapezoid ribs per tile,
//      tiled 3 ft along the ridge, so a major rib every 9 in -- with a metal surface
//   2. a style with roofProfile "standingseam" draws NO such ribs and tiles 6 ft: a seam every 18 in
//   3. a shingle style that also carries roofProfile ignores it completely
//   4. neither roof shares the AG Panel WALL's canvas (that raster only hints at ribs, because the
//      wall's ribs are geometry; a roof slab has none, which is why the roof draws its own)
// plus the cladding control naming the built-in "AG Panel" rather than "Metal".
//
//   python -m http.server 8125 --bind 127.0.0.1                  (repo root)
//   node tests/harness/metalRoof.mjs                             (SS_SHOTS=<dir> for the PNGs)
//
// Exit 0 = every assertion held.
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir } from "./lib.mjs";

const W = 12, L = 24, SIZE = `${W}x${L}`, H = 8;
const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const spec = (extra) => ({
  roof: { type: "gable", pitch: 0.33, overhang: 0.6 },
  colors: { body: "#9AA3AB", roof: "#6B7078", trim: "#E5E7EB" },
  siding: "agpanel", foundation: "skids", wallHeightFt: H, ...extra,
});
const style = (value, label, d3) => ({ value, label, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3 });
// ribs: drawn trapezoid ribs across one tile of the roof's colour canvas; null = not measured
// (a shingle tab is a wide grey run and would count, which says nothing about metal).
const CASES = [
  // No roofProfile at all: every metal style saved before today.
  { st: style("shed", "AG Shed", spec({ roofMaterial: "metal" })), expect: { tileU: 3, tileV: 8, bump: 0.6, metal: 0.35, ribs: 4 } },
  { st: style("postframe", "Post Frame", spec({ roofMaterial: "metal", roofProfile: "standingseam" })), expect: { tileU: 6, tileV: 8, bump: 0.5, metal: 0.35, ribs: 0 } },
  { st: style("shingled", "Shingle Shed", spec({ roofMaterial: "shingle", roofProfile: "standingseam" })), expect: { tileU: 6, tileV: 4, bump: 0.35, metal: 0, ribs: null } },
];
const STYLES = CASES.map((c) => c.st);
export const CONFIG = {
  clientId: "harness-metal",
  branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: STYLES,
  defaultSizes: [SIZE],
  sizePricing: Object.fromEntries(STYLES.map((s) => [s.value, { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } }])),
  options: [], colors: [], claddingOptions: Object.fromEntries(STYLES.map((s) => [s.value, CLADS])), wallHeightOptions: {},
  showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

async function pickStyle(page, label) {
  const ok = await page.evaluate((lab) => {
    const want = lab.trim().toLowerCase();
    const el = [...document.querySelectorAll("div,span,p,strong,b")]
      .find((e) => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === want && e.offsetParent);
    if (!el) return false;
    el.click();
    return true;
  }, label);
  if (!ok) throw new Error(`no style tile labelled ${label}`);
  await settle(page, 500);
}
async function chooseSize(page) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
  await sel.first().selectOption({ label: SIZE });
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 15000 });
}
async function cladding(page, id) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: "Builder's standard" }) });
  if (!(await sel.count())) throw new Error("no Cladding control");
  await sel.first().selectOption(id);
  await settle(page, 300);
  return sel.first().evaluate((s, v) => { const o = [...s.options].find((x) => x.value === v); return o ? o.textContent.trim() : null; }, id);
}
async function openEditor(page) {
  const edit = page.getByRole("button", { name: /Edit in 3D/ });
  if (!(await edit.count()) || !(await edit.first().isVisible())) {
    const show = page.getByRole("button", { name: /Show 3D|3D View/ });
    if (await show.count()) { await show.first().click(); await settle(page, 800); }
  }
  await edit.first().waitFor({ state: "visible", timeout: 60000 });
  await edit.first().click();
  await page.waitForFunction(() => {
    const E = window.__ss3dEngine;
    return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length > 0);
  }, null, { timeout: 90000 });
  await settle(page, 1500);
}

// The roof SLAB's material: the widest textured BoxGeometry in the roof group. Gable caps wear the
// wall material and are extrusions; rake boards and corner posts carry no map.
async function measure(page) {
  return page.evaluate(() => {
    const E = window.__ss3dEngine;
    let slab = null, area = 0, wallMat = null;
    E.model.roofGroup.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material) || !o.material.map) return;
      const p = o.geometry && o.geometry.parameters;
      if (!p || p.width == null || p.depth == null) return;
      if (p.width * p.depth > area) { area = p.width * p.depth; slab = o; }
    });
    E.model.wallsGroup.traverse((o) => {
      if (!wallMat && o.isMesh && o.material && !Array.isArray(o.material) && o.material.map && o.material.bumpMap) wallMat = o.material;
    });
    if (!slab) return null;
    const m = slab.material;
    // A drawn rib's shadow face is a run of clearly dark columns several pixels wide (about 10 px on
    // "agroof"). Standing seam's seam shadow is 3 px and the wall raster's 4 px, so neither counts.
    let ribs = null;
    const img = m.map.image;
    if (img && img.getContext) {
      const d = img.getContext("2d").getImageData(0, 0, img.width, 1).data;
      let run = 0; ribs = 0;
      for (let x = 0; x < img.width; x++) {
        const lum = (d[x * 4] + d[x * 4 + 1] + d[x * 4 + 2]) / 3;
        if (lum < 200) run++; else { if (run >= 6) ribs++; run = 0; }
      }
      if (run >= 6) ribs++;
    }
    return {
      repeat: [m.map.repeat.x, m.map.repeat.y], bump: m.bumpScale, metalness: m.metalness, ribs,
      sameSheetAsWall: !!(wallMat && m.map.image === wallMat.map.image), wallTextured: !!wallMat,
    };
  });
}

async function shot(page, path, eye, at) {
  await page.evaluate(({ eye, at }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(eye[0], eye[1], eye[2]);
    E.controls.target.set(at[0], at[1], at[2]);
    E.camera.lookAt(at[0], at[1], at[2]);
    E.camera.updateProjectionMatrix();
    E.render();
  }, { eye, at });
  const box = await page.evaluate(() => {
    const c = window.__ss3dEngine.renderer.domElement.getBoundingClientRect();
    return { x: c.x, y: c.y, width: c.width, height: c.height };
  });
  await page.screenshot({ path, clip: box });
}

async function main() {
  const R = reporter();
  const dir = shotsDir("metal-roof");
  const { browser, ctx } = await launch({ width: 1400, height: 1000 });
  try {
    for (const c of CASES) {
      const page = await ctx.newPage();
      const errors = collectErrors(page);
      await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
      await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
      await openDesigner(page, CONFIG.clientId);
      await pickStyle(page, c.st.label);
      await chooseSize(page);
      const label = await cladding(page, "agpanel");
      R.ok(`${c.st.label}: the cladding control names the built-in AG Panel`, label === "AG Panel", String(label));
      await openEditor(page);
      const m = await measure(page);
      const e = c.expect;
      R.ok(`${c.st.label}: roof slab found, walls textured`, !!m && m.wallTextured, JSON.stringify(m));
      if (m) {
        R.ok(`${c.st.label}: tile ${e.tileU} ft along the ridge`, near(m.repeat[0], 1 / e.tileU), `repeat.x ${m.repeat[0]}`);
        R.ok(`${c.st.label}: tile ${e.tileV} ft down the slope`, near(m.repeat[1], 1 / e.tileV), `repeat.y ${m.repeat[1]}`);
        R.ok(`${c.st.label}: bump ${e.bump}`, near(m.bump, e.bump), String(m.bump));
        R.ok(`${c.st.label}: metalness ${e.metal}`, near(m.metalness, e.metal), String(m.metalness));
        if (e.ribs !== null) R.ok(`${c.st.label}: ${e.ribs} drawn ribs per tile`, m.ribs === e.ribs, String(m.ribs));
        R.ok(`${c.st.label}: roof does not borrow the AG Panel wall's canvas`, m.sameSheetAsWall === false, String(m.sameSheetAsWall));
      }
      const tag = c.st.value;
      await shot(page, `${dir}/${tag}-wide.png`, [W * 1.35, H + 11, L * 0.95], [0, H * 0.7, 0]);
      await shot(page, `${dir}/${tag}-roof-close.png`, [W * 0.55, H + 6.5, L * 0.18], [0, H + 1.4, 0]);
      R.ok(`${c.st.label}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\nshots: ${dir}`);
  const bad = R.failed();
  console.log(bad.length ? `\n${bad.length} FAILED` : "\nall passed");
  process.exit(bad.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
