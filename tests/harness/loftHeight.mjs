// The loft's height (LOFT HEIGHT, 2026-10-07), driven for real on the COMPILED designer and the COMPILED
// portal mount, with every Supabase call answered locally.
//
// Carolyn, 2026-10-06: by default a loft sits on the top plate of the walls, following the design's own
// wall height, and a rep can change it per design. It used to be a fixed 5'6". What is proved:
//
//   A. A SAVED LOFT DOES NOT MOVE: a design with a loft stamped elevationFt 5.5 and one with no height at
//      all (both shapes are on live designs) draws both platforms with their tops at 5'6" in 3D, and the
//      plan's svg markup and the Floorplan PDF image are captured. SS_LOFT_SNAPSHOT=<file> writes them;
//      with SS_LOFT_BASELINE=<file> (the same capture from the tree before this change) they must be
//      byte-identical. SS_LOFT_ONLY_A=1 runs nothing else, for the baseline run on the old tree.
//   B. PLACE IN 2D (the portal's rep designer, 12 x 24 on 8 ft walls): the item carries onPlate: true and
//      no elevationFt, the 3D platform's top is the plate less the 0.02 ft drawing gap, and the toolbar
//      says "On the plate" and "Loft floor at 8' (top of the walls)".
//   C. A +12 in WALL UPGRADE: the same loft rebuilds on the 9 ft plate (8.98), and the readout follows.
//   D. THE TOOLBAR: Custom then 84 in gives elevationFt 7, a platform top of 7 and the field showing 84;
//      120 is over the walls: a toast, and the loft goes back on the plate; 30 is under 4 ft: a toast,
//      elevationFt 4, and the field shows 48 (what was applied, not what was typed).
//   E. THE PUBLIC PAGE has no loft height control at all, and a loft placed there is still on the plate.
//   F. THE 3D EDITOR: dragging the plate loft keeps it on the plate (no number written) at the plate's
//      height, and the yellow highlight box is centred on the platform; a loft placed from the 3D palette
//      carries onPlate and draws on the plate too.
//   G. THE ROOF: from outside, with the roof on, showing or hiding the lofts changes NO pixel at the eaves
//      or anywhere else (a platform whose underside sat on the plate comes out through both eaves; the
//      same check with the lofts lifted 0.5 ft does see them, so it can fail). In Look-inside, with the
//      ghosted wall made opaque, the wall tops over the loft's edges show no loft at all (a loft top AT
//      the plate z-fights there: the negative control lifts it 0.1 ft and the band sees it). Screenshots:
//      the loft on the plate in Look-inside, and the exterior.
//   I. A CEILING LIGHT UNDER A LOFT: a saved design with a plate loft over a Light and a Ceiling Fan, a
//      saved 5'6" loft over another Light, and a Light under no loft. The plate loft's devices hang under
//      its floor (the disc's top at or under the platform's bottom), not inside it; the other two are where
//      they always were (H - 0.06). A real click from below in Look-inside selects the Light ("Remove
//      Light"), not the loft; dragged out from under the loft it goes back up to H - 0.06; and a Light
//      placed from the 3D chooser under the loft hangs under it too.
//   H. zero page errors.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/loftHeight.mjs        (SS_BASE=http://127.0.0.1:<port> to move it)
//
// Exit 0 = every assertion held. NOTHING LEAVES THE MACHINE (lib.mjs stubSupabase). The tenant and
// everything in it are made up; the repo is public.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir, revealTool, showOptTab, bypassGate, BASE,
} from "./lib.mjs";

const CLIENT = "harness-loft-height";
const CODE = "SS-HARNESSLF1";
const W = 12, L = 24, SIZE = `${W}x${L}`, WALL_FT = 8, GAP = 0.02, LOFT_T = 0.35, WALL_T = 0.3;
const D3_SPEC = {
  roof: { eave: "fascia", type: "gable", pitch: 0.42, overhang: 0.8, ridgeOffset: 0 },
  colors: { body: "#7a4a35", roof: "#5f6266", trim: "#efe9dc" }, siding: "batten", foundation: "skids", wallHeightFt: WALL_FT,
};
const CONFIG = {
  clientId: CLIENT,
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  // [] unlocks Details and Get Quote with no typing (contactComplete short-circuits on an empty list).
  contactFields: [],
  buildingStyles: [{ value: "plain", label: "Gable Cabin", img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3_SPEC }],
  defaultSizes: [SIZE],
  sizePricing: { plain: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } } },
  options: [], colors: [], claddingOptions: {},
  // One priced +12 in increase on the 12 wide: Building > Wall height.
  wallHeightOptions: { plain: [{ deltaIn: 12, ratePerLf: 4.75, widthsFt: [12] }] },
  showPricing: true, view3d: true,
  layoutItems: {
    loft: { label: "Loft", icon: "⬆️", color: "#7C3AED", width: 6, height: 4, shortLabel: "LF", wallOnly: false, wallSnap: false, group: "interior" },
  },
  layoutPricing: { loft: { rate: 6, method: "sqft_option" } },
  layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};
// I. Two ceiling devices offered without the package, so they have tools (and itemId) on a bare design.
const CONFIG_ELEC = {
  ...CONFIG,
  electricalItems: [
    { id: "e-lt", icon: "💡", name: "Light", mount: "ceiling", withPackage: false, standalone: true, priceWithPackage: null, priceStandalone: 65, heightOffFloorIn: 96 },
    { id: "e-fan", icon: "🌀", name: "Ceiling Fan", mount: "ceiling", withPackage: false, standalone: true, priceWithPackage: null, priceStandalone: 395, heightOffFloorIn: 96 },
  ],
};
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };

// The designer's page geometry for 12 x 24 (pageGeom): what items[].x/y are measured in.
const PG = (() => {
  const visibleH = 1100 - 340;
  const scale = Math.min((850 * 0.70) / W, (visibleH * 0.70) / L, (visibleH - 60) / (L + 4));
  const pW = W * scale;
  return { scale, mgX: (850 - pW) / 2, mgY: 2 * scale + 30 };
})();
const px = (xFt) => PG.mgX + xFt * PG.scale, py = (yFt) => PG.mgY + yFt * PG.scale;
// Two lofts as live designs hold them: one stamped 5.5 (08-20 .. 09-24), one with no height (before 08-21).
const A_ITEMS = [
  { id: 101, type: "loft", x: px(6), y: py(4), rotation: 0, wall: null, widthFt: 12, heightFt: 4, elevationFt: 5.5 },
  { id: 102, type: "loft", x: px(6), y: py(20), rotation: 0, wall: null, widthFt: 12, heightFt: 4 },
  { id: 103, type: "singleDoor", x: px(6), y: py(L), rotation: 0, wall: "south", widthFt: 3, heightFt: 0.5 },
];
// I. A plate loft over the north 6 ft with a Light and a Ceiling Fan under it, a saved loft (no height) over
// the south 6 ft with a Light under it, and a Light in the middle under no loft.
const dev = (id, type, xFt, yFt) => ({ id, type, x: px(xFt), y: py(yFt), rotation: 0, wall: null, widthFt: 0.8, heightFt: 0.8, electricalItemId: type, heightOffFloorIn: 96 });
const I_ITEMS = [
  { id: 201, type: "loft", x: px(6), y: py(3), rotation: 0, wall: null, widthFt: 12, heightFt: 6, onPlate: true },
  { id: 202, type: "loft", x: px(6), y: py(21), rotation: 0, wall: null, widthFt: 12, heightFt: 6 },
  dev(211, "e-lt", 3, 3), dev(212, "e-fan", 9, 3), dev(213, "e-lt", 3, 21), dev(214, "e-lt", 6, 12),
];
const designRow = (items) => ({
  short_code: CODE, client_id: CLIENT, status: "draft", version: 1,
  selections: { style: "plain", size: SIZE, roofType: "", roofColor: "", cladding: "" },
  items, paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
  contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100", street: "", city: "", state: "", zip: "" },
  bldg_w: W, bldg_h: L,
});

const settle = (page, ms = 400) => page.waitForTimeout(ms);
// The footer's "🗑 Remove <name>" for the selection, or null.
const footerRemove = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((el) => (el.innerText || "").trim().startsWith("🗑 Remove ") && el.offsetParent);
  return b ? b.innerText.trim() : null;
});
const near = (a, b, eps = 1e-3) => Math.abs(Number(a) - Number(b)) <= eps;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const lofts = async (page) => ((await readItems(page)) || []).filter((i) => i.type === "loft");
const debug = (page) => page.addInitScript(() => { window.__SS3D_DEBUG = true; });

/** The plan svg's markup, and the Floorplan PDF's image (the export modal's PNG). */
async function captureAB(page) {
  const svg = await page.evaluate(() => {
    const s = [...document.querySelectorAll("svg")].find((el) => [...el.querySelectorAll("rect")].some((r) => r.getAttribute("stroke") === "#1E293B"));
    return s ? s.outerHTML : null;
  });
  await page.locator(".ssd-ft-pdf").first().click();
  const img = page.locator('img[alt="Floor Plan"]').first();
  await img.waitFor({ state: "visible", timeout: 30000 });
  const png = await img.getAttribute("src");
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator("h3").filter({ hasText: "Floorplan PDF" }).locator("xpath=..").locator("button").first().click().catch(() => {});
  await settle(page, 300);
  return { svg, png };
}

/** The portal's mount, minus the portal: the compiled component, one <StructureStudio embedded …/>. */
function embeddedPage() {
  const idx = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const buster = (/structure-studio\.component\.compiled\.js\?v=([a-f0-9]+)/.exec(idx) || [])[1] || "x";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0"><div id="root"></div>
<script src="/vendor/react-18.2.0.production.min.js"></script>
<script src="/vendor/react-dom-18.2.0.production.min.js"></script>
<script src="/vendor/supabase-js-2.112.1.umd.min.js"></script>
<script src="/structure-studio.component.compiled.js?v=${buster}"></script>
<script>
  window.__ssAppBooted = true;
  window.__SS3D_DEBUG = true;
  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(window.StructureStudio, {
    clientId: ${JSON.stringify(CLIENT)}, embedded: true, view3d: true,
    openDesign: { code: ${JSON.stringify(CODE)}, clientId: ${JSON.stringify(CLIENT)} },
  }));
</script></body></html>`;
}

// Every loft group's platform top, world feet: the highest point of its meshes (the ledgers and posts
// are all under the platform). `which` is "__ss3dPanel" (the docked view) or "__ss3dEngine" (the editor).
async function loftTops(page, which) {
  return page.evaluate(({ which, ids }) => {
    const E = window[which];
    if (!E || !E.model) return null;
    E.scene.updateMatrixWorld(true);
    const V = E.camera.position.constructor;
    const out = {};
    E.model.interiorGroup.children.forEach((g) => {
      const id = g.userData && g.userData.itemId;
      if (id == null || (ids && !ids.includes(id))) return;
      let top = -Infinity;
      g.traverse((o) => {
        if (!o.isMesh) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        [bb.min.x, bb.max.x].forEach((x) => [bb.min.y, bb.max.y].forEach((y) => [bb.min.z, bb.max.z].forEach((z) => {
          top = Math.max(top, new V(x, y, z).applyMatrix4(o.matrixWorld).y);
        })));
      });
      out[id] = top;
    });
    return out;
  }, { which, ids: null });
}
async function waitTop(page, which, id, want, timeout = 30000) {
  const t0 = Date.now();
  let got = null;
  while (Date.now() - t0 < timeout) {
    const tops = await loftTops(page, which);
    got = tops ? tops[id] : null;
    if (got != null && near(got, want)) return got;
    await settle(page, 250);
  }
  return got;
}
async function showPanel(page) {
  const edit = page.getByRole("button", { name: /Edit in 3D/ });
  if (!(await edit.count()) || !(await edit.first().isVisible().catch(() => false))) {
    const show = page.getByRole("button", { name: /Show 3D/ });
    if (await show.count()) { await show.first().click(); await settle(page, 800); }
  }
}
async function openEditor(page) {
  await showPanel(page);
  await page.getByRole("button", { name: /Edit in 3D/ }).first().click();
  await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.interiorGroup && E.renderer.domElement.isConnected); }, null, { timeout: 90000 });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /Look inside|Show exterior/.test(b.innerText) && !b.disabled), null, { timeout: 90000 });
  await settle(page, 1200);
}
async function closeEditor(page) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "✕" && x.previousElementSibling && /^3D Preview/.test(x.previousElementSibling.textContent.trim()));
    if (b) b.click();
  });
  await settle(page, 1200);
}
// Each loft platform's bottom and each device's world box (the light's disc on its own), in the editor.
const hangs = (page) => page.evaluate(() => {
  const E = window.__ss3dEngine;
  E.scene.updateMatrixWorld(true);
  const V = E.camera.position.constructor;
  const wb = (o) => {
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    [bb.min.x, bb.max.x].forEach((x) => [bb.min.y, bb.max.y].forEach((y) => [bb.min.z, bb.max.z].forEach((z) => {
      const v = new V(x, y, z).applyMatrix4(o.matrixWorld);
      [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
    })));
    return { min: mn, max: mx, ctr: mn.map((v, k) => (v + mx[k]) / 2) };
  };
  const out = { lofts: {}, devs: {} };
  E.model.interiorGroup.children.forEach((g) => {
    const u = g.userData || {};
    if (u.ssElecFor != null) {
      let lo = Infinity, hi = -Infinity, disc = null;
      g.traverse((o) => {
        if (!o.isMesh) return;
        const b = wb(o);
        lo = Math.min(lo, b.min[1]); hi = Math.max(hi, b.max[1]);
        if (o.geometry.type === "CylinderGeometry" && Math.abs((o.geometry.parameters || {}).radiusTop - 0.45) < 1e-6) disc = b;
      });
      out.devs[u.ssElecFor] = { lo, hi, disc, picks: u.itemId === u.ssElecFor };
    } else if (u.itemId != null) {
      let bottom = null;
      g.traverse((o) => {
        if (o.isMesh && o.geometry.type === "BoxGeometry" && Math.abs((o.geometry.parameters || {}).height - 0.35) < 1e-6) bottom = wb(o).min[1];
      });
      out.lofts[u.itemId] = { bottom };
    }
  });
  return out;
});
// The camera put exactly where asked (no OrbitControls clamp), so an eye under the loft stays under it.
const aimRaw = (page, pos, target) => page.evaluate(({ pos, target }) => {
  const E = window.__ss3dEngine;
  E.camera.position.set(pos[0], pos[1], pos[2]);
  E.camera.lookAt(target[0], target[1], target[2]);
  E.camera.updateProjectionMatrix();
  E.camera.updateMatrixWorld(true);
  E.render();
}, { pos, target });
// Aim the editor's camera (the window size stays put) and draw one frame.
const aim = (page, pos, target) => page.evaluate(({ pos, target }) => {
  const E = window.__ss3dEngine;
  E.controls.target.set(target[0], target[1], target[2]);
  E.camera.position.set(pos[0], pos[1], pos[2]);
  E.controls.update();
  E.camera.updateMatrixWorld(true);
  E.render();
}, { pos, target });
// A world point's page (client) coordinates on the editor's canvas.
const screenOf = (page, p) => page.evaluate((p) => {
  const E = window.__ss3dEngine;
  const v = new (E.camera.position.constructor)(p[0], p[1], p[2]).project(E.camera);
  const r = E.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}, p);
// Render the editor twice, the lofts shown and hidden (or lifted by `liftFt`), and count the pixels
// that differ, over the whole frame or inside `quad` (four world points, the band to look in).
const loftDiff = (page, ids, { quad = null, liftFt = 0, opaqueWalls = false } = {}) => page.evaluate(({ ids, quad, liftFt, opaqueWalls }) => {
  const E = window.__ss3dEngine;
  const gl = E.renderer.getContext();
  const groups = E.model.interiorGroup.children.filter((g) => g.userData && ids.includes(g.userData.itemId));
  const mats = [E.model.wallMat, E.model.gableMat, E.model.battenMat].filter(Boolean);
  const keep = mats.map((m) => m.opacity);
  if (opaqueWalls) mats.forEach((m) => { m.opacity = 1; });
  const read = () => {
    E.render();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { w, h, buf };
  };
  groups.forEach((g) => { g.position.y += liftFt; });
  const a = read();
  groups.forEach((g) => { g.visible = false; });
  const b = read();
  groups.forEach((g) => { g.visible = true; g.position.y -= liftFt; });
  if (opaqueWalls) mats.forEach((m, k) => { m.opacity = keep[k]; });
  E.render();
  // The band, in drawing-buffer pixels (origin bottom-left), shrunk 1.5 px toward its centre.
  let poly = null;
  if (quad) {
    const V = E.camera.position.constructor;
    poly = quad.map((p) => { const v = new V(p[0], p[1], p[2]).project(E.camera); return [(v.x + 1) / 2 * a.w, (v.y + 1) / 2 * a.h]; });
    const cx = poly.reduce((s, p) => s + p[0], 0) / 4, cy = poly.reduce((s, p) => s + p[1], 0) / 4;
    poly = poly.map(([x, y]) => { const d = Math.hypot(x - cx, y - cy) || 1; return [x + (cx - x) * 1.5 / d, y + (cy - y) * 1.5 / d]; });
  }
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  let diff = 0, area = 0;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      if (poly && !inside(x + 0.5, y + 0.5)) continue;
      area++;
      const k = (y * a.w + x) * 4;
      if (Math.abs(a.buf[k] - b.buf[k]) + Math.abs(a.buf[k + 1] - b.buf[k + 1]) + Math.abs(a.buf[k + 2] - b.buf[k + 2]) > 6) diff++;
    }
  }
  return { diff, area, groups: groups.length };
}, { ids, quad, liftFt, opaqueWalls });

const { ok, failed } = reporter();
const shots = shotsDir("loft-height");
const run = async () => {
  const { browser, ctx } = await launch({ width: 1440, height: 1100 });
  const allErrors = [];
  try {
    // ── A. Saved lofts from before the change ────────────────────────────────────────────────
    {
      const page = await ctx.newPage();
      const errors = collectErrors(page);
      await debug(page);
      await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [designRow(A_ITEMS)] } });
      await openDesigner(page, CLIENT);
      await page.goto(`${BASE}/?client=${CLIENT}&id=${CODE}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
      await page.waitForFunction(() => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === "24 ft"), null, { timeout: 30000 });
      await settle(page, 1500);
      const snap = await captureAB(page);
      ok("A0 the plan svg and the Floorplan PDF were captured", !!snap.svg && /^data:image\/png;base64,/.test(snap.png || ""));
      const out = { svgSha: sha(snap.svg || ""), pngSha: sha(snap.png || "") };
      if (process.env.SS_LOFT_SNAPSHOT) writeFileSync(process.env.SS_LOFT_SNAPSHOT, JSON.stringify(out));
      if (process.env.SS_LOFT_BASELINE) {
        const base = JSON.parse(readFileSync(process.env.SS_LOFT_BASELINE, "utf8"));
        ok("A1 saved lofts: the plan svg is byte-identical to the tree before this change", base.svgSha === out.svgSha, `${base.svgSha.slice(0, 12)} vs ${out.svgSha.slice(0, 12)}`);
        ok("A2 saved lofts: the Floorplan PDF image is byte-identical to the tree before this change", base.pngSha === out.pngSha, `${base.pngSha.slice(0, 12)} vs ${out.pngSha.slice(0, 12)}`);
      }
      const items = await lofts(page);
      ok("A3 the saved lofts open as saved: one at 5.5, one with no height, neither on the plate",
        items.length === 2 && items.find((i) => i.id === 101).elevationFt === 5.5 && !("elevationFt" in items.find((i) => i.id === 102)) && items.every((i) => !("onPlate" in i)), JSON.stringify(items));
      await openEditor(page);
      const tops = await loftTops(page, "__ss3dEngine");
      ok("A4 in 3D both saved lofts' platform tops are at 5'6\", where they always were", tops && near(tops[101], 5.5, 1e-6) && near(tops[102], 5.5, 1e-6), JSON.stringify(tops));
      allErrors.push(...errors.map((e) => "A: " + e));
      await page.close();
    }
    if (process.env.SS_LOFT_ONLY_A) return;

    // ── B-D, F, G. The portal's rep designer, a blank 12 x 24 on 8 ft walls ──────────────────
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [designRow([])] } });
    const url = `${BASE}/__harness_loft.html`;
    await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html", body: embeddedPage() }));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === "24 ft"), null, { timeout: 60000 });
    await settle(page, 1500);
    const r = await buildingRect(page);
    const sc = r.w / W;
    const at = (xFt, yFt) => svgPoint(page, r.x + xFt * sc, r.y + yFt * sc);
    const bar = () => page.locator(".ssd-tb").first().innerText().catch(() => "");
    const pressed = (name) => page.getByRole("button", { name, exact: true }).first().getAttribute("aria-pressed").catch(() => null);

    // B. place in 2D
    await (await revealTool(page, /Loft/)).click();
    await settle(page, 250);
    const p0 = await at(5, 12);
    await page.mouse.click(p0.x, p0.y);
    await settle(page);
    let ls = await lofts(page);
    ok("B1 a loft placed on the plan carries onPlate: true and no elevationFt",
      ls.length === 1 && ls[0].onPlate === true && !("elevationFt" in ls[0]) && ls[0].widthFt === W, JSON.stringify(ls[0]));
    const loftId = ls[0] && ls[0].id;
    await showPanel(page);
    let top = await waitTop(page, "__ss3dPanel", loftId, WALL_FT - GAP);
    ok("B2 in 3D its platform's top is on the 8 ft plate, 0.02 ft under it", near(top, WALL_FT - GAP), String(top));
    let tb = (await bar()).replace(/\s+/g, " ");
    ok("B3 the toolbar: On the plate, and where the floor is", (await pressed("On the plate")) === "true" && tb.includes("Loft floor at 8' (top of the walls)"), tb.slice(0, 240));
    await page.screenshot({ path: join(shots, "B-plan-loft-on-plate.png") });

    // C. a +12 in wall increase
    await showOptTab(page, "wallHeight");
    await page.locator("[data-ss-opt-panel] .ssd-seg button").filter({ hasText: /^\+12/ }).first().click();
    await settle(page, 600);
    top = await waitTop(page, "__ss3dPanel", loftId, WALL_FT + 1 - GAP);
    ok("C1 a +12 in wall upgrade: the plate loft rebuilds on the 9 ft plate", near(top, WALL_FT + 1 - GAP), String(top));
    ls = await lofts(page);
    ok("C2 ...and nothing was written into the item: it follows the walls", ls[0].onPlate === true && !("elevationFt" in ls[0]), JSON.stringify(ls[0]));
    const c0 = await at(6, 12);
    await page.mouse.click(c0.x, c0.y);
    await settle(page, 300);
    tb = (await bar()).replace(/\s+/g, " ");
    ok("C3 the readout follows the walls: 9'", tb.includes("Loft floor at 9' (top of the walls)"), tb.slice(0, 240));

    // D. the toolbar
    await page.getByRole("button", { name: "Custom", exact: true }).first().click();
    await settle(page, 300);
    ls = await lofts(page);
    ok("D1 Custom gives it a height a foot under the 9 ft plate (96 in)", ls[0].elevationFt === 8 && !("onPlate" in ls[0]) && (await page.locator("[data-ss-loft-height]").inputValue()) === "96", JSON.stringify(ls[0]));
    await page.locator("[data-ss-loft-height]").fill("84");
    await page.locator("[data-ss-loft-height]").press("Enter");
    await settle(page, 300);
    ls = await lofts(page);
    top = await waitTop(page, "__ss3dPanel", loftId, 7);
    tb = (await bar()).replace(/\s+/g, " ");
    ok("D2 84 in: elevationFt 7 in the item, 7 ft in 3D, and the field and readout say so",
      ls[0].elevationFt === 7 && !("onPlate" in ls[0]) && near(top, 7) && (await page.locator("[data-ss-loft-height]").inputValue()) === "84" && tb.includes("Loft floor at 7'") && !tb.includes("top of the walls"),
      `${JSON.stringify(ls[0])} top ${top} | ${tb.slice(0, 200)}`);
    await page.screenshot({ path: join(shots, "D-toolbar-custom-84in.png") });
    await page.locator("[data-ss-loft-height]").fill("120");
    await page.locator("[data-ss-loft-height]").press("Enter");
    await settle(page, 300);
    let body = await page.locator("body").innerText();
    ls = await lofts(page);
    ok("D3 120 in is over the walls: a toast says so, and the loft goes back on the plate",
      body.includes("The walls are 9' tall, so the loft sits on the plate.") && ls[0].onPlate === true && !("elevationFt" in ls[0]) && (await pressed("On the plate")) === "true"
        && !(await page.locator("[data-ss-loft-height]").count()), JSON.stringify(ls[0]));
    top = await waitTop(page, "__ss3dPanel", loftId, WALL_FT + 1 - GAP);
    ok("D3b ...and 3D draws it on the plate again", near(top, WALL_FT + 1 - GAP), String(top));
    await page.waitForFunction(() => !document.body.innerText.includes("so the loft sits on the plate."), null, { timeout: 8000 }).catch(() => {});
    await page.getByRole("button", { name: "Custom", exact: true }).first().click();
    await settle(page, 300);
    await page.locator("[data-ss-loft-height]").fill("30");
    await page.locator("[data-ss-loft-height]").press("Enter");
    await settle(page, 300);
    body = await page.locator("body").innerText();
    ls = await lofts(page);
    const shown = await page.locator("[data-ss-loft-height]").inputValue();
    top = await waitTop(page, "__ss3dPanel", loftId, 4);
    ok("D4 30 in is under 4 ft: a toast, elevationFt 4, and the field shows the 48 applied, not the 30 typed",
      body.includes("A loft floor is at least 4' off the floor.") && ls[0].elevationFt === 4 && shown === "48" && near(top, 4), `${JSON.stringify(ls[0])} field ${shown} top ${top}`);
    await page.getByRole("button", { name: "On the plate", exact: true }).first().click();
    await settle(page, 300);
    ls = await lofts(page);
    ok("D5 On the plate puts it back: onPlate, and the number is gone", ls[0].onPlate === true && !("elevationFt" in ls[0]), JSON.stringify(ls[0]));
    await page.screenshot({ path: join(shots, "D-toolbar-on-plate.png") });

    // F. the 3D editor: drag, highlight, palette
    await openEditor(page);
    const H = WALL_FT + 1;
    // Looking down on the building from above its middle, a little to the south, so the floor is in view.
    await aim(page, [0.4, 34, 9], [0, 0, 0]);
    await settle(page, 300);
    const from = await screenOf(page, [0, H - GAP, 12 - L / 2]);
    const to = await screenOf(page, [0, H - GAP, 6 - L / 2]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 2, from.y + 2, { steps: 2 });
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await settle(page, 300);
    // The yellow outline (a LineSegments straight under the scene), mid-drag.
    const hl = await page.evaluate(() => {
      const E = window.__ss3dEngine;
      const h = E.scene.children.find((o) => o.isLineSegments && o.material && o.material.color && o.material.color.getHex() === 0xfbbf24);
      return h ? { visible: h.visible, y: h.position.y, sy: h.scale.y } : null;
    });
    await page.mouse.up();
    await settle(page, 800);
    ls = await lofts(page);
    const moved = ls.find((i) => i.id === loftId);
    const cyFt = moved ? (moved.y - PG.mgY) / PG.scale : null;
    ok("F1 a 3D drag moves the loft and keeps it on the plate (no number written)", moved && moved.onPlate === true && !("elevationFt" in moved) && near(cyFt, 6, 0.6), `${JSON.stringify(moved)} centre ${cyFt}`);
    top = await waitTop(page, "__ss3dEngine", loftId, H - GAP);
    ok("F2 ...at the plate's height", near(top, H - GAP), String(top));
    ok("F3 the highlight box is centred on the platform while it is dragged", hl && hl.visible && near(hl.y, H - GAP - LOFT_T / 2) && near(hl.sy, LOFT_T + 0.3), JSON.stringify(hl));
    // The palette: arm the loft and click the floor near the north end... of what is free: 18..22.
    const before = ls.length;
    const lf = page.getByRole("button", { name: "⬆️ LF", exact: true });
    await lf.first().click();
    await settle(page, 400);
    await aim(page, [0.4, 34, 9], [0, 0, 0]);
    const fl = await screenOf(page, [0, 0, 20 - L / 2]);
    await page.mouse.click(fl.x, fl.y);
    await settle(page, 800);
    ls = await lofts(page);
    const placed3 = ls.find((i) => i.id !== loftId);
    ok("F4 a loft placed from the 3D palette carries onPlate: true and no elevationFt",
      ls.length === before + 1 && placed3 && placed3.onPlate === true && !("elevationFt" in placed3), JSON.stringify(placed3));
    top = placed3 ? await waitTop(page, "__ss3dEngine", placed3.id, H - GAP) : null;
    ok("F5 ...and draws on the plate", near(top, H - GAP), String(top));

    // G. the roof and the wall tops
    const ids = ls.map((i) => i.id);
    if (await page.getByRole("button", { name: /Show exterior/ }).count()) {
      await page.getByRole("button", { name: /Show exterior/ }).first().click();
      await settle(page, 600);
    }
    const views = [
      [[16, H + 1.5, 0], [0, H, 0]], [[-16, H + 1.5, 0], [0, H, 0]], [[16, H + 4, -14], [0, H, -6]],
      [[-16, H + 4, 14], [0, H, 6]], [[13, 14, 22], [0, 5, 0]], [[6.4, H + 0.3, -5], [6.4, H, 8]],
    ];
    let pokes = 0, liftedSeen = 0;
    for (const [pos, tgt] of views) {
      await aim(page, pos, tgt);
      const d = await loftDiff(page, ids);
      pokes += d.diff;
      const dl = await loftDiff(page, ids, { liftFt: 0.5 });
      liftedSeen += dl.diff;
    }
    ok("G1 from outside, roof on: showing or hiding the plate lofts changes no pixel (nothing comes through the roof)", pokes === 0, `${pokes} px over ${views.length} views`);
    ok("G2 ...and the same check DOES see a loft lifted 0.5 ft (its underside on the plate), so it can fail", liftedSeen > 0, `${liftedSeen} px`);
    await aim(page, [17, 12.5, 15], [0, 7, 0]);
    await page.screenshot({ path: join(shots, "G-exterior-eaves.png") });
    // Look-inside: the wall tops over the loft edges, the ghosted walls drawn opaque for the check.
    await page.getByRole("button", { name: /Look inside/ }).first().click();
    await settle(page, 600);
    const lo = (await lofts(page)).find((i) => i.id === loftId);
    const cz = (lo.y - PG.mgY) / PG.scale - L / 2;
    let band = 0, bandArea = 0, bandLifted = 0;
    for (const sx of [1, -1]) {
      const xIn = sx * (W / 2 - WALL_T / 2), xOut = sx * (W / 2);
      await aim(page, [sx * (W / 2 - 1.2), H + 3.2, cz + 0.6], [sx * (W / 2 - 0.1), H, cz]);
      const quad = [[xIn, H, cz - 1.9], [xOut, H, cz - 1.9], [xOut, H, cz + 1.9], [xIn, H, cz + 1.9]];
      const d = await loftDiff(page, [loftId], { quad, opaqueWalls: true });
      band += d.diff; bandArea += d.area;
      const dl = await loftDiff(page, [loftId], { quad, opaqueWalls: true, liftFt: 0.1 });
      bandLifted += dl.diff;
    }
    ok("G3 Look-inside: the wall tops over the loft's edges show none of the loft (no flicker band)", bandArea > 50 && band === 0, `${band} of ${bandArea} px`);
    ok("G4 ...and a loft 0.1 ft higher does show in that band, so it can fail", bandLifted > 0, `${bandLifted} px`);
    await aim(page, [9, 15, cz + 12], [0, H - 1.5, cz]);
    await settle(page, 300);
    await page.screenshot({ path: join(shots, "G-look-inside-loft-on-plate.png") });
    await closeEditor(page);
    allErrors.push(...errors.map((e) => "B-G: " + e));
    await page.close();

    // ── E. the public page ────────────────────────────────────────────────────────────────────
    {
      const pub = await ctx.newPage();
      const errs = collectErrors(pub);
      await stubSupabase(pub, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [designRow([])] } });
      await bypassGate(pub, CLIENT);
      await openDesigner(pub, CLIENT);
      await pub.goto(`${BASE}/?client=${CLIENT}&id=${CODE}`, { waitUntil: "domcontentloaded" });
      await pub.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
      await pub.waitForFunction(() => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === "24 ft"), null, { timeout: 30000 });
      await settle(pub, 1200);
      const rr = await buildingRect(pub);
      const s2 = rr.w / W;
      await (await revealTool(pub, /Loft/)).click();
      await settle(pub, 250);
      const q = await svgPoint(pub, rr.x + 5 * s2, rr.y + 12 * s2);
      await pub.mouse.click(q.x, q.y);
      await settle(pub);
      const pl = await lofts(pub);
      const tbp = (await pub.locator(".ssd-tb").first().innerText().catch(() => "")).replace(/\s+/g, " ");
      ok("E1 the public page places a loft on the plate too", pl.length === 1 && pl[0].onPlate === true && !("elevationFt" in pl[0]), JSON.stringify(pl[0]));
      ok("E2 ...and shows no loft height control", /Selected/i.test(tbp) && !(await pub.locator("[data-ss-loft-height]").count()) && !(await pub.locator("[data-ss-loft-readout]").count())
        && !(await pub.getByRole("button", { name: "On the plate", exact: true }).count()), tbp.slice(0, 200));
      await pub.screenshot({ path: join(shots, "E-public-loft.png") });
      allErrors.push(...errs.map((e) => "E: " + e));
      await pub.close();
    }

    // ── I. A ceiling light under a loft ───────────────────────────────────────────────────────────
    {
      const pg = await ctx.newPage();
      const errs = collectErrors(pg);
      await debug(pg);
      await stubSupabase(pg, { config: CONFIG_ELEC, fixtures: FIXTURES, rpc: { load_design: [designRow(I_ITEMS)] } });
      await openDesigner(pg, CLIENT);
      await pg.goto(`${BASE}/?client=${CLIENT}&id=${CODE}`, { waitUntil: "domcontentloaded" });
      await pg.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
      await pg.waitForFunction(() => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === "24 ft"), null, { timeout: 30000 });
      await settle(pg, 1500);
      await openEditor(pg);
      const H = WALL_FT, under = H - GAP - LOFT_T;
      let hg = await hangs(pg);
      const d = (id) => hg.devs[id] || {};
      ok("I1 the plate loft's platform runs from 7.63 to 7.98, and every device is drawn and pickable",
        near(hg.lofts[201] && hg.lofts[201].bottom, under) && [211, 212, 213, 214].every((id) => d(id).picks), JSON.stringify({ lofts: hg.lofts, picks: [211, 212, 213, 214].map((id) => d(id).picks) }));
      ok("I2 the Light under the plate loft hangs UNDER its floor: the disc's top is at or under the platform's bottom",
        !!d(211).disc && d(211).disc.max[1] <= under + 1e-6 && near(d(211).disc.max[1], under - 0.02), JSON.stringify(d(211).disc && d(211).disc.max[1]));
      ok("I3 ...and so does the Ceiling Fan: nothing of it reaches into the platform (its rod no longer runs through the floor)",
        d(212).hi <= under + 1e-6, String(d(212).hi));
      ok("I4 a Light under a saved 5'6\" loft, and one under no loft, are where they always were (H - 0.06)",
        !!d(213).disc && near(d(213).disc.ctr[1], H - 0.06) && !!d(214).disc && near(d(214).disc.ctr[1], H - 0.06),
        JSON.stringify([d(213).disc && d(213).disc.ctr[1], d(214).disc && d(214).disc.ctr[1]]));
      // Look-inside, from under the loft: a real click on the Light selects the Light, not the loft.
      await pg.getByRole("button", { name: /Look inside/ }).first().click();
      await settle(pg, 600);
      hg = await hangs(pg);
      const dc = d(211).disc.ctr;
      await aimRaw(pg, [dc[0] + 1.5, 3, dc[2] + 4], dc);
      await settle(pg, 300);
      const at0 = await screenOf(pg, dc);
      await pg.mouse.click(at0.x, at0.y);
      await settle(pg, 600);
      ok("I5 a real click on it from below (Look inside) selects the Light, not the loft", (await footerRemove(pg)) === "🗑 Remove Light", String(await footerRemove(pg)));
      await pg.screenshot({ path: join(shots, "I-look-inside-light-under-loft.png") });
      // Dragged out from under the loft (plan 3 ft south of its edge), it goes back up to the plate.
      const to = [dc[0], dc[1], 9 - L / 2];
      const a = await screenOf(pg, dc), b = await screenOf(pg, to);
      await pg.mouse.move(a.x, a.y);
      await pg.mouse.down();
      await pg.mouse.move(a.x + 2, a.y + 2, { steps: 2 });
      await pg.mouse.move(b.x, b.y, { steps: 14 });
      await settle(pg, 300);
      await pg.mouse.up();
      await settle(pg, 900);
      const lt = ((await readItems(pg)) || []).find((i) => i.id === 211);
      const ltZ = lt ? (lt.y - PG.mgY) / PG.scale : null;
      hg = await hangs(pg);
      ok("I6 dragged out from under the loft, the Light moves there on the plan and hangs at H - 0.06 again",
        near(ltZ, 9, 0.6) && !!d(211).disc && near(d(211).disc.ctr[1], H - 0.06), `plan z ${ltZ} disc y ${d(211).disc && d(211).disc.ctr[1]}`);
      // The flow the 3D chooser adds: a Light placed on the floor under the loft hangs under it.
      const ids = new Set(((await readItems(pg)) || []).map((i) => i.id));
      if (!(await pg.locator('[data-ss-elec3d-card="e-lt"]').count())) { await pg.locator("[data-ss-elec3d]").first().click(); await settle(pg, 350); }
      await pg.locator('[data-ss-elec3d-card="e-lt"]').click();
      await settle(pg, 450);
      const FLOOR = [0, 0, 1.5 - L / 2];
      await aimRaw(pg, [FLOOR[0] + 1, H + 6, FLOOR[2] + 6], FLOOR);
      const fp = await screenOf(pg, FLOOR);
      await pg.mouse.click(fp.x, fp.y);
      await settle(pg, 900);
      const added = ((await readItems(pg)) || []).filter((i) => !ids.has(i.id));
      hg = await hangs(pg);
      const nd = added[0] ? d(added[0].id) : {};
      ok("I7 a Light placed from the 3D chooser on the floor under the loft is added once, and hangs under the loft's floor",
        added.length === 1 && added[0].electricalItemId === "e-lt" && !!nd.disc && nd.disc.max[1] <= under + 1e-6, JSON.stringify({ added: added.map((i) => i.type), top: nd.disc && nd.disc.max[1] }));
      await aimRaw(pg, [-4, 3.2, 2], [0, H - 0.6, -9]);
      await settle(pg, 300);
      await pg.screenshot({ path: join(shots, "I-look-inside-lights-under-plate-loft.png") });
      await closeEditor(pg);
      allErrors.push(...errs.map((e) => "I: " + e));
      await pg.close();
    }

    ok("H zero page errors", allErrors.length === 0, allErrors.slice(0, 5).join(" | "));
  } finally {
    await browser.close();
  }
};

run().then(() => {
  const f = failed();
  console.log(f.length ? `\n${f.length} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  console.log(`shots: ${shots}`);
  process.exit(f.length ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
