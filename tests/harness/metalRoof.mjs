// Metal roof PROFILES and SURFACE, MEASURED: a metal roof draws AG Panel unless its style says
// "standingseam", a shingle roof is untouched by either, and painted metal no longer renders
// near-black.
//
// Carolyn asked for AG Panel roofs on 07-08, 09-11 and 09-15; every metal roof had drawn standing
// seam because the "metal" raster was the only one a roof had. The claim this script checks is not
// "it looks like AG Panel" but things that can be measured off the scene graph:
//   1. the default metal roof draws the "agroof" raster -- 4 fully drawn trapezoid ribs per tile,
//      tiled 3 ft along the ridge, so a major rib every 9 in
//   2. a style with roofProfile "standingseam" draws NO such ribs and tiles 6 ft: a seam every 18 in
//   3. a shingle style that also carries roofProfile ignores it completely
//   4. neither roof shares the AG Panel WALL's canvas (that raster only hints at ribs, because the
//      wall's ribs are geometry; a roof slab has none, which is why the roof draws its own)
// plus the cladding control naming the built-in "AG Panel" rather than "Metal".
//
// THE SURFACE (2026-09-17). Painted metal is a dielectric (metalness 0, roughness 0.45), and the
// metal ROOF alone reflects a small sky environment (a PMREM, envMap mapping 306 =
// CubeUVReflectionMapping, at envMapIntensity 0.4). The old recipe, metalness 0.35 with nothing to
// reflect, drew a mid-grey roof near-black. So on top of the profile checks:
//   5. both metal roofs carry that surface, in the full-screen viewer AND the docked panel; the
//      shingle roof has no environment map
//   6. the AG Panel WALL has metalness 0 and no environment map, so its paint reads like siding
//   7. THE BUG ITSELF, in pixels: in the wide shot the metal roof is not darker than the SAME hex
//      drawn as shingle. Roof pixels are found with an ID pass (the roof slab material swapped for
//      flat red, everything else black) and averaged as Rec.709 luma off the normal render.
//      Measured 0.80 before the fix and 1.21 after, on both profiles; the band 1.05-1.45 also
//      catches an over-bright regression.
//   8. a near-white metal roof does not blow out: at most 2% of its pixels at luma 250 or above.
//
//   python -m http.server 8125 --bind 127.0.0.1                  (repo root)
//   node tests/harness/metalRoof.mjs                             (SS_SHOTS=<dir> for the PNGs)
//
// Exit 0 = every assertion held.
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir } from "./lib.mjs";

const W = 12, L = 24, SIZE = `${W}x${L}`, H = 8;
const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const COLORS = { body: "#9AA3AB", roof: "#6B7078", trim: "#E5E7EB" };
const spec = (extra) => ({
  roof: { type: "gable", pitch: 0.33, overhang: 0.6 },
  colors: COLORS,
  siding: "agpanel", foundation: "skids", wallHeightFt: H, ...extra,
});
const style = (value, label, d3) => ({ value, label, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3 });
// The painted-metal surface every metal roof must carry, and the shingle one.
const METAL = { metalness: 0, roughness: 0.45, env: true, envMapping: 306, envI: 0.4 };
const SHINGLE = { metalness: 0, roughness: 0.95, env: false };
// ribs: drawn trapezoid ribs across one tile of the roof's colour canvas; null = not measured
// (a shingle tab is a wide grey run and would count, which says nothing about metal).
// clip: the near-white roof whose highlight must not blow out.
const CASES = [
  // No roofProfile at all: every metal style saved before 2026-09-15.
  { st: style("shed", "AG Shed", spec({ roofMaterial: "metal" })), expect: { tileU: 3, tileV: 8, bump: 0.6, surface: METAL, ribs: 4 } },
  { st: style("postframe", "Post Frame", spec({ roofMaterial: "metal", roofProfile: "standingseam" })), expect: { tileU: 6, tileV: 8, bump: 0.5, surface: METAL, ribs: 0 } },
  { st: style("shingled", "Shingle Shed", spec({ roofMaterial: "shingle", roofProfile: "standingseam" })), expect: { tileU: 6, tileV: 4, bump: 0.35, surface: SHINGLE, ribs: null } },
  { st: style("whiteroof", "White Roof Shed", spec({ roofMaterial: "metal", colors: { ...COLORS, roof: "#F5F3EE" } })), expect: { tileU: 3, tileV: 8, bump: 0.6, surface: METAL, ribs: null, clip: true } },
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
// The metal/shingle luma ratio in the wide shot, and the most of a near-white roof allowed at 250+.
const RATIO_BAND = [1.05, 1.45];
const CLIP_MAX = 0.02;

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
// The docked panel opens by itself on a wide screen; the button is the fallback. Its engine is
// published as window.__ss3dPanel on every mount, and a remount (a size change) leaves the old
// one there, so only an engine whose canvas is still in the page counts.
async function openDock(page) {
  const live = () => page.waitForFunction(() => {
    const P = window.__ss3dPanel;
    return !!(P && P.renderer && P.renderer.domElement.isConnected && P.model && P.model.roofGroup && P.model.roofGroup.children.length > 0);
  }, null, { timeout: 60000 });
  try {
    await live();
  } catch (_e) {
    const show = page.getByRole("button", { name: /Show 3D|3D View/ });
    if (await show.count()) { await show.first().click(); await settle(page, 800); }
    await live();
  }
  await settle(page, 1200);
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
// wall material and are extrusions; rake boards and corner posts carry no map. `engine` names the
// window global: __ss3dEngine (full-screen viewer) or __ss3dPanel (docked panel).
async function measure(page, engine = "__ss3dEngine") {
  return page.evaluate((engine) => {
    const E = window[engine];
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
      repeat: [m.map.repeat.x, m.map.repeat.y], bump: m.bumpScale, ribs,
      metalness: m.metalness, roughness: m.roughness, env: !!m.envMap,
      envMapping: m.envMap ? m.envMap.mapping : null, envI: m.envMapIntensity,
      sameSheetAsWall: !!(wallMat && m.map.image === wallMat.map.image), wallTextured: !!wallMat,
      wallMetalness: wallMat ? wallMat.metalness : null, wallEnv: !!(wallMat && wallMat.envMap),
    };
  }, engine);
}

// Roof pixels from the viewer's CURRENT camera: one normal render, then an ID render with the roof
// slab's material as flat red and every other mesh, the sky dome included, flat black on a black
// background with sprites hidden; both read straight back off the drawing buffer. Returns the roof pixels' mean Rec.709 luma and
// the share of them at luma 250 or above. Everything swapped is put back and the view re-rendered.
async function roofPixels(page) {
  return page.evaluate(() => {
    const E = window.__ss3dEngine, R = E.renderer, S = E.scene, gl = R.getContext();
    let slab = null, area = 0;
    E.model.roofGroup.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material) || !o.material.map) return;
      const p = o.geometry && o.geometry.parameters;
      if (!p || p.width == null || p.depth == null) return;
      if (p.width * p.depth > area) { area = p.width * p.depth; slab = o; }
    });
    if (!slab) return null;
    const roofMat = slab.material;
    // The sky dome is the scene's one MeshBasicMaterial that is always there; borrow its class
    // rather than importing a second copy of three.
    const Basic = E.sky && E.sky.material && E.sky.material.isMeshBasicMaterial ? E.sky.material.constructor : null;
    if (!Basic) return null;
    const read = () => {
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    R.render(S, E.camera);
    const beauty = read();
    const red = new Basic({ color: 0xff0000, toneMapped: false, fog: false });
    const black = new Basic({ color: 0x000000, toneMapped: false, fog: false });
    const swapped = [], hidden = [], bg = S.background;
    S.traverse((o) => {
      if (o.isMesh) {
        swapped.push([o, o.material]);
        o.material = Array.isArray(o.material) ? o.material.map((m) => (m === roofMat ? red : black)) : (o.material === roofMat ? red : black);
      } else if ((o.isSprite || o.isLine || o.isPoints) && o.visible) {
        hidden.push(o); o.visible = false;
      }
    });
    S.background = bg && bg.isColor ? bg.clone().setRGB(0, 0, 0) : null;
    R.render(S, E.camera);
    const ids = read();
    swapped.forEach(([o, m]) => { o.material = m; });
    hidden.forEach((o) => { o.visible = true; });
    S.background = bg;
    red.dispose(); black.dispose();
    let n = 0, sum = 0, hot = 0;
    for (let i = 0; i < ids.length; i += 4) {
      if (!(ids[i] > 250 && ids[i + 1] < 5 && ids[i + 2] < 5)) continue;
      const y = 0.2126 * beauty[i] + 0.7152 * beauty[i + 1] + 0.0722 * beauty[i + 2];
      n++; sum += y; if (y >= 250) hot++;
    }
    E.render();
    return { n, luma: n ? sum / n : null, clip: n ? hot / n : null };
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

function checkSurface(R, name, m, s) {
  R.ok(`${name}: metalness ${s.metalness}`, near(m.metalness, s.metalness), String(m.metalness));
  R.ok(`${name}: roughness ${s.roughness}`, near(m.roughness, s.roughness), String(m.roughness));
  if (s.env) {
    R.ok(`${name}: roof reflects the sky environment (mapping ${s.envMapping}, intensity ${s.envI})`,
      m.env && m.envMapping === s.envMapping && near(m.envI, s.envI), `env ${m.env} mapping ${m.envMapping} intensity ${m.envI}`);
  } else {
    R.ok(`${name}: shingle has no environment map`, m.env === false, `env ${m.env}`);
  }
}

async function main() {
  const R = reporter();
  const dir = shotsDir("metal-roof");
  const wide = {};
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
      const e = c.expect;

      // The docked panel is its own renderer with its own environment, so it is checked on its own.
      await openDock(page);
      const pm = await measure(page, "__ss3dPanel");
      R.ok(`${c.st.label} (docked panel): roof slab found`, !!pm, JSON.stringify(pm));
      if (pm) checkSurface(R, `${c.st.label} (docked panel)`, pm, e.surface);

      await openEditor(page);
      const m = await measure(page);
      R.ok(`${c.st.label}: roof slab found, walls textured`, !!m && m.wallTextured, JSON.stringify(m));
      if (m) {
        R.ok(`${c.st.label}: tile ${e.tileU} ft along the ridge`, near(m.repeat[0], 1 / e.tileU), `repeat.x ${m.repeat[0]}`);
        R.ok(`${c.st.label}: tile ${e.tileV} ft down the slope`, near(m.repeat[1], 1 / e.tileV), `repeat.y ${m.repeat[1]}`);
        R.ok(`${c.st.label}: bump ${e.bump}`, near(m.bump, e.bump), String(m.bump));
        checkSurface(R, c.st.label, m, e.surface);
        if (e.ribs !== null) R.ok(`${c.st.label}: ${e.ribs} drawn ribs per tile`, m.ribs === e.ribs, String(m.ribs));
        R.ok(`${c.st.label}: roof does not borrow the AG Panel wall's canvas`, m.sameSheetAsWall === false, String(m.sameSheetAsWall));
        R.ok(`${c.st.label}: AG Panel wall has metalness 0 and no environment map`, m.wallMetalness === 0 && m.wallEnv === false,
          `metalness ${m.wallMetalness} env ${m.wallEnv}`);
      }
      const tag = c.st.value;
      await shot(page, `${dir}/${tag}-wide.png`, [W * 1.35, H + 11, L * 0.95], [0, H * 0.7, 0]);
      const px = await roofPixels(page);
      R.ok(`${c.st.label}: roof pixels found in the wide shot`, !!px && px.n > 2000, JSON.stringify(px));
      if (px) {
        wide[tag] = px;
        console.log(`      ${c.st.label}: wide-shot roof luma ${px.luma && px.luma.toFixed(1)} over ${px.n} px, ${(100 * px.clip).toFixed(2)}% at 250+`);
      }
      if (e.clip && px) {
        R.ok(`${c.st.label}: a near-white metal roof does not blow out (at most ${CLIP_MAX * 100}% of its pixels at luma 250+)`,
          px.clip <= CLIP_MAX, `${(100 * px.clip).toFixed(2)}%`);
      }
      await shot(page, `${dir}/${tag}-roof-close.png`, [W * 0.55, H + 6.5, L * 0.18], [0, H + 1.4, 0]);
      R.ok(`${c.st.label}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  // The bug itself: the same hex, lit the same way, must not come out darker as metal than as
  // shingle. Both profiles share the surface, so both are held to it (each measured 0.80 before
  // the fix and 1.21-1.22 after).
  const shingle = wide.shingled;
  for (const [tag, label] of [["shed", "AG Shed (AG Panel)"], ["postframe", "Post Frame (standing seam)"]]) {
    const metal = wide[tag];
    const ratio = metal && shingle && metal.luma && shingle.luma ? metal.luma / shingle.luma : null;
    R.ok(`${label} metal roof vs the same hex as shingle, wide shot: luma ratio within ${RATIO_BAND.join("-")}`,
      ratio !== null && ratio >= RATIO_BAND[0] && ratio <= RATIO_BAND[1], ratio === null ? "not measured" : ratio.toFixed(3));
  }
  console.log(`\nshots: ${dir}`);
  const bad = R.failed();
  console.log(bad.length ? `\n${bad.length} FAILED` : "\nall passed");
  process.exit(bad.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
