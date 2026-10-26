// THE FRAMING VIEW (Carolyn, 2026-10-26 call; roadmap "Show interior 2x4 studs at 16" or 24" OC, set per
// building"), MEASURED on the COMPILED bundle.
//
// The 3D footer's Framing button takes the siding off: studs at the style's own 16" or 24" on centre (its
// building_styles.d3.framing.studOcIn), plates, every opening framed, the roof's rafters with a barn's or an
// A-frame's gussets and collar ties, 4x8 floor sheets, and the loft, workbench and shelves in wood. Built by
// buildFraming3D from the finished model, the first time the button is pressed, never in the estimate.
//
//   python -m http.server 8931 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8931 SS_SHOTS=<dir> node tests/harness/framing.mjs
//   SS_FRAMING_ONLY=<case,...>    runs those cases only
//
// RUN SERIALLY. Exit 0 = every check held. NOTHING LEAVES THE MACHINE (lib.mjs stubSupabase). The tenant
// is made up.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { launch, stubSupabase, collectErrors, bypassGate, reporter, shotsDir, BASE, REF, PASS_THROUGH_GET, serveAppRoutes } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = shotsDir("framing");
const { ok, failed } = reporter();
const settle = (page, ms = 400) => page.waitForTimeout(ms);

// The FRAMING LAYOUT block, lifted out of the component twin (what the bundle is compiled from) and run here,
// so the counts below are the layout's own and not a second copy of its rules.
const TWIN = readFileSync(join(ROOT, "structure-studio.component.js"), "utf8");
const LAYOUT = (() => {
  const a = TWIN.indexOf("// ── FRAMING LAYOUT ──"), b = TWIN.indexOf("// ── END FRAMING LAYOUT ──");
  if (a < 0 || b < 0) throw new Error("framing.mjs: the FRAMING LAYOUT markers moved");
  return new Function(`${TWIN.slice(a, b)}; return { ssFrameOcIn, ssFrameLayout, ssFrameWall, ssFrameFace, ssFrameTruss, ssFloorSheets, SS_FRAME_T, SS_FRAME_D };`)();
})();

const CLIENT = "harness-framing";
const CODE = "SS-HARNESSFR1";
const H = 8;
const COLORS = { body: "#8c5a3c", roof: "#4f555c", trim: "#efe9dc" };
const GABLE = { type: "gable", pitch: 0.4, overhang: 0.75, eave: "fascia" };
const BARN = { type: "gambrel", overhang: 0.6, kneeU: 0.55, kneeRise: 0.55, ridgeRise: 0.8 };
const FR = (oc) => ({ framing: { studOcIn: oc } });
const CASES = [
  { id: "gable16", label: "A-frame 16", size: "12x16", d3: { roof: GABLE, ...FR(16) } },
  { id: "gable24", label: "A-frame 24", size: "12x16", d3: { roof: GABLE, ...FR(24) } },
  { id: "barn16", label: "Barn 16", size: "12x16", d3: { roof: BARN, ...FR(16) } },
  { id: "barn24", label: "Barn 24", size: "12x16", d3: { roof: BARN, ...FR(24) } },
  { id: "plain", label: "No framing set", size: "12x16", d3: { roof: GABLE } },
  { id: "raised", label: "Raised seat", size: "12x16", d3: { roof: { ...GABLE, seat: "raised" }, ...FR(16) } },
  { id: "long", label: "16x40 A-frame", size: "16x40", d3: { roof: GABLE, ...FR(16) } },
  { id: "inside", label: "12x24 A-frame", size: "12x24", d3: { roof: { ...GABLE, pitch: 0.5 }, ...FR(16) } },
  { id: "porch", label: "Porch", size: "12x16", d3: { roof: { ...GABLE, porchOutFt: 6, porchEnd: "front" }, ...FR(16) } },
  { id: "recess", label: "Recessed porch", size: "12x16", d3: { roof: { ...GABLE, porchDepthFt: 4, porchEnd: "front", porchTruss: true }, ...FR(16) } },
  { id: "leanto", label: "Lean-to", size: "12x16", d3: { roof: { ...GABLE, leanToWidthFt: 6, leanToDropFt: 1, leanToSide: "right" }, ...FR(16) } },
  { id: "wings", label: "Wings", size: "24x16", d3: { roof: { type: "gable", pitch: 0.5, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 6, wingPitch: 0.25, centerEaveFt: 14 }, ...FR(16) } },
  { id: "shed", label: "Single slope", size: "12x16", d3: { roof: { type: "shed", pitch: 0.25, overhang: 0.6, eave: "fascia", highSide: "back" }, ...FR(16) } },
  { id: "dormer", label: "Dormer", size: "12x16", d3: { roof: { ...GABLE, dormerWidthFt: 5, dormerRiseFt: 1.5 }, ...FR(16) } },
  { id: "step", label: "Roof step", size: "12x16", d3: { roof: { ...GABLE, front: "gable", rearStepFt: 6, rearEaveRiseFt: 0.5 }, ...FR(16) } },
];
const sizeOf = (s) => s.split("x").map(Number);
const D3 = (c) => ({ siding: "batten", colors: COLORS, foundation: "slab", roofMaterial: "shingle", wallHeightFt: H, ...c.d3 });
const PLAN_ITEMS = {
  loft: { label: "Loft", icon: "⬆️", color: "#7C3AED", width: 6, height: 4, shortLabel: "LF", wallOnly: false, wallSnap: false, group: "interior" },
  workbench: { label: "Workbench", icon: "🔧", color: "#8B5E3C", width: 4, height: 2, depthIn: 24, shortLabel: "WB", wallOnly: false, wallSnap: true, group: "interior", modelKey: "wallBench", heightOffFloorIn: 36 },
  dshelf: { label: "Double Shelf", icon: "📚", color: "#D97706", width: 4, height: 1, depthIn: 16, shortLabel: "SHELF", wallOnly: false, wallSnap: true, group: "interior", modelKey: "wallShelfDouble", heightOffFloorIn: 30 },
  partitionWall: { label: "Partition Wall", icon: "🧱", color: "#57534E", width: 4, height: 0.375, shortLabel: "PART", wallOnly: false, wallSnap: false, group: "interior", modelKey: "partition" },
};
const STYLES = CASES.map((c) => ({ value: c.id, label: c.label, img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3(c) }));
const CONFIG = {
  clientId: CLIENT,
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: [],
  buildingStyles: STYLES,
  defaultSizes: [...new Set(CASES.map((c) => c.size))],
  sizePricing: Object.fromEntries(STYLES.map((s) => { const [w, l] = sizeOf(s.sizes[0]); return [s.value, { [s.sizes[0]]: { widthFt: w, lengthFt: l, basePrice: 9000 } }]; })),
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: true,
  layoutItems: PLAN_ITEMS,
  layoutPricing: { loft: { rate: 6, method: "sqft_option" }, workbench: { rate: 12, method: "lineal_ft" }, dshelf: { rate: 9, method: "lineal_ft" }, partitionWall: { rate: 22, method: "lineal_ft" } },
  layoutPrices: {},
  interiorWalls: { offered: true, standardStud: "2x4", method: "lineal_ft", standardHeight: "plate", allowRafters: true, allowRo: true, studs: { "2x4": { rate: 22 }, "2x6": { rate: 26 } }, coverings: [] },
  electrical: null, insulation: [], electricalItems: [],
};
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };

// The designer's page geometry (pageGeom) for W x L: what items[].x/y are measured in.
const PG = (W, L) => {
  const visibleH = 1100 - 340;
  const scale = Math.min((850 * 0.70) / W, (visibleH * 0.70) / L, (visibleH - 60) / (L + 4));
  return { scale, mgX: (850 - W * scale) / 2, mgY: 2 * scale + 30 };
};
// A 3 ft door in the front wall, a window in the right wall, a loft on the plate over the back 4 ft, a
// workbench in the back-left corner against the left wall, a double shelf on the right wall, and a 2x6
// interior wall across the building 9 ft from the back with a door in it.
const itemsFor = (W, L, set) => {
  const g = PG(W, L), px = (x) => g.mgX + x * g.scale, py = (y) => g.mgY + y * g.scale;
  const all = [
    { id: 101, type: "singleDoor", x: px(W / 2), y: py(L), rotation: 0, wall: "south", widthFt: 3, heightFt: 0.5 },
    { id: 102, type: "window", x: px(W), y: py(Math.min(12, L - 3)), rotation: 90, wall: "east", widthFt: 3, heightFt: 0.5 },
    { id: 103, type: "loft", x: px(W / 2), y: py(2), rotation: 0, wall: null, widthFt: W, heightFt: 4, onPlate: true },
    { id: 104, type: "workbench", x: px(1), y: py(6), rotation: 90, wall: "west", widthFt: 4, heightFt: 2 },
    { id: 105, type: "dshelf", x: px(W - 0.67), y: py(6.5), rotation: 90, wall: "east", widthFt: 4, heightFt: 1.33 },
    { id: 106, type: "partitionWall", wall: null, axis: "x", atFt: 9, fromFt: 0, toFt: W, heightIn: null, stud: "2x6",
      openings: [{ id: "pd1", kind: "door", atFt: W / 2 + 2.5, widthIn: 32, heightIn: 80, operation: "left" }] },
  ];
  return set ? all.filter((it) => set.includes(it.id)) : all;
};
const designRow = (c, set, items) => {
  const [W, L] = sizeOf(c.size);
  return {
    short_code: CODE, client_id: CLIENT, status: "draft", version: 1,
    selections: { style: c.id, size: c.size, roofType: "", roofColor: "", cladding: "" },
    items: items || itemsFor(W, L, set), paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
    contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100", street: "", city: "", state: "", zip: "" },
    bldg_w: W, bldg_h: L,
  };
};

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
  await page.evaluate(async () => {
    let last = window.__ss3dEngine.model, since = performance.now();
    while (performance.now() - since < 1500) {
      await new Promise((r) => setTimeout(r, 100));
      const m = window.__ss3dEngine.model;
      if (m !== last) { last = m; since = performance.now(); }
    }
  });
}

// `base` (optional) serves another build of the same files: the baseline part opens origin/beta's there.
async function render(browser, c, { set = null, viewport = { width: 1280, height: 900 }, base = BASE, items = null, fixtures = FIXTURES, routes = null } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: CONFIG, fixtures, rpc: { load_design: [designRow(c, set, items)] } });
  if (routes) await routes(page);
  await bypassGate(page, CLIENT);
  await page.goto(`${base}/?client=${CLIENT}&id=${CODE}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  const L = sizeOf(c.size)[1];
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 30000 });
  await settle(page, 1200);
  await openEditor(page);
  return { page, ctx, errors };
}

// The 3D footer's own buttons, clicked in the page (a 2D button of the same name sits under the modal).
const framingButton = (page) => page.getByRole("button", { name: /🪵 Framing/ });
const clickFooter = (page, re) => page.evaluate((src) => {
  const b = [...document.querySelectorAll("button")].filter((x) => new RegExp(src).test(x.textContent)).pop();
  if (b) b.click();
  return !!b;
}, re.source);
async function setFraming(page, on) {
  const isOn = await page.evaluate(() => !!window.__ss3dEngine.framing);
  if (isOn !== on) { await clickFooter(page, /🪵 Framing/); await settle(page, 600); }
}
async function setRoof(page, on) {
  const isOn = await page.evaluate(() => window.__ss3dEngine.roofOn !== false);
  if (isOn !== on) { await clickFooter(page, /⛺ Roof/); await settle(page, 400); }
}

async function shot(page, name, eye, at) {
  await page.evaluate(({ eye, at }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(eye[0], eye[1], eye[2]);
    E.controls.target.set(at[0], at[1], at[2]);
    E.camera.lookAt(at[0], at[1], at[2]);
    E.camera.updateProjectionMatrix();
    E.renderer.shadowMap.needsUpdate = true;
    E.render();
  }, { eye, at });
  const box = await page.evaluate(() => {
    const r = window.__ss3dEngine.renderer.domElement.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const path = join(SHOTS, name);
  await page.screenshot({ path, clip: box });
  return path;
}

// What the framing drew: per part, its vertices (a box is 24, a gusset plate 48) and whether it shows, and
// what of the finished building is still showing.
async function framingState(page) {
  return page.evaluate(() => {
    const E = window.__ss3dEngine, M = E.model, F = M.ssFraming;
    const parts = {};
    if (F) F.group.children.forEach((m) => {
      const k = m.userData.ssFramePart, mat = m.material.name || "";
      const name = k === "roof" && /osb/.test(mat) ? "gussets" : k === "floor" && /seam/.test(mat) ? "floorSeams" : k;
      parts[name] = parts[name] || { verts: 0, visible: m.visible && F.group.visible, meshes: 0, color: "#" + m.material.color.getHexString() };
      parts[name].verts += m.geometry.attributes.position.count; parts[name].meshes++;
    });
    let wood = 0, woodShown = 0, solidShown = 0;
    M.interiorGroup.traverse((o) => {
      if (o.userData && o.userData.ssFrameWood) { wood++; if (o.visible) woodShown++; }
      if (o.isMesh && o.userData && o.userData.ssFrameSolid) { let v = true; for (let p = o; p; p = p.parent) if (!p.visible) v = false; if (v) solidShown++; }
    });
    let skinsShown = 0;
    M.roofGroup.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.some((m) => M.skinMats.has(m)) && !(o.userData && (o.userData.ssLeanToPost || o.userData.ssFrameKeep))) skinsShown++;
    });
    let casingsShown = 0;
    M.openingsGroup.traverse((o) => { if (o.isMesh && o.userData && o.userData.ssCasing && o.visible) casingsShown++; });
    return { built: !!F, on: !!E.framing, groupVisible: !!(F && F.group.visible), wallsVisible: M.wallsGroup.visible, parts, wood, woodShown, solidShown, skinsShown, casingsShown };
  });
}
// The framing mesh of a part: its boxes as world bounding boxes (each box is 24 consecutive vertices).
async function boxesOf(page, part, material) {
  return page.evaluate(({ part, material }) => {
    const F = window.__ss3dEngine.model.ssFraming;
    const out = [];
    F.group.children.filter((m) => m.userData.ssFramePart === part && (material == null || (material === "osb") === /osb/.test(m.material.name || ""))).forEach((m) => {
      const p = m.geometry.attributes.position;
      for (let b = 0; b + 24 <= p.count; b += 24) {
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let i = b; i < b + 24; i++) { [p.getX(i), p.getY(i), p.getZ(i)].forEach((v, k) => { mn[k] = Math.min(mn[k], v); mx[k] = Math.max(mx[k], v); }); }
        out.push({ mn, mx });
      }
    });
    return out;
  }, { part, material });
}
// What the model recorded for the framing (frameData): every wall's frame and openings, every interior wall.
async function frameRecord(page) {
  return page.evaluate(() => {
    const M = window.__ss3dEngine.model, fd = M.frameData;
    const walls = Object.fromEntries(Object.entries(fd.walls).map(([k, w]) => [k, { wf: { O: w.wf.O, U: w.wf.U, N: w.wf.N, len: w.wf.len, start: w.wf.start || 0, bot: w.wf.bot || 0, tops: w.wf.tops || null, top: w.wf.top }, footprint: w.footprint, ops: w.ops }]));
    const parts = M.interiorGroup.children.filter((g) => g.userData && g.userData.ssFrameWall).map((g) => { const p = g.userData.ssFrameWall; return { len: p.len, studFt: p.studFt, top: p.top, tops: p.tops, ops: p.ops, wf: { O: p.wf.O, U: p.wf.U, N: p.wf.N } }; });
    return { walls, parts, H: fd.H, lift: fd.lift, T: fd.T, uAxisIsX: fd.uAxisIsX, rafterFt: fd.rafterFt, secs: fd.secs.map((s) => ({ dedup: s.dedup, Hr: s.Hr, z0: s.z0, z1: s.z1 })) };
  });
}
// The members buildFraming3D lays in the walls, from the record, by the rules its comment states: the four
// footprint walls along x run through a corner by T/2 with a corner stud at each end, the ones along z stop T/2
// short; an eave wall's top drops by a raised seat's lift. The count is ssFrameWall's own.
function expectedWallMembers(rec, ocIn) {
  let n = 0;
  Object.values(rec.walls).forEach((w) => {
    const along = Math.abs(w.wf.U[0]) > 0.5, four = !!w.footprint, ext = four ? (along ? rec.T / 2 : -rec.T / 2) : 0;
    const lift = rec.lift > 0 && along !== !!rec.uAxisIsX ? rec.lift : 0;
    n += LAYOUT.ssFrameWall({ a0: w.wf.start - ext, a1: w.wf.len + ext, bot: w.wf.bot, tops: w.wf.tops ? w.wf.tops.map((p) => [p[0], p[1], p[2] - lift]) : null,
      top: (w.wf.top != null ? w.wf.top : rec.H) - lift, ocIn, ops: w.ops, ends: four && along ? [1, 1] : [0, 0] }).length;
  });
  rec.parts.forEach((p) => { n += LAYOUT.ssFrameWall({ a0: 0, a1: p.len, bot: 0, tops: p.tops, top: p.top, ocIn, ops: p.ops }).length; });
  return n;
}
// Shoot straight down through the roof at (x, z): where the deck's underside is, and where the first rafter top
// under it is. Framing meshes opt out of picking, so the ray is cast with three's own Mesh raycast.
async function deckAndRafter(page, x, z) {
  return page.evaluate(({ x, z }) => {
    const E = window.__ss3dEngine, M = E.model, F = M.ssFraming;
    const meshProto = Object.getPrototypeOf(F.group.children[0]);
    const RC = E.camera.constructor;   // not used; three's classes come off instances below
    const V = E.camera.position.constructor;
    const orig = new V(x, 60, z), dir = new V(0, -1, 0);
    const hitsOn = (objs) => {
      const out = [];
      objs.forEach((m) => {
        const ray = { origin: orig, direction: dir };
        const geo = m.geometry, p = geo.attributes.position, ix = geo.index ? geo.index.array : null;
        m.updateMatrixWorld(true);
        const A = new V(), B = new V(), C = new V();
        const n = ix ? ix.length : p.count;
        for (let k = 0; k < n; k += 3) {
          const ia = ix ? ix[k] : k, ib = ix ? ix[k + 1] : k + 1, ic = ix ? ix[k + 2] : k + 2;
          A.fromBufferAttribute(p, ia).applyMatrix4(m.matrixWorld); B.fromBufferAttribute(p, ib).applyMatrix4(m.matrixWorld); C.fromBufferAttribute(p, ic).applyMatrix4(m.matrixWorld);
          // A vertical ray hits the triangle where (x, z) is inside its plan projection.
          const d = (P, Q, R) => (P.x - R.x) * (Q.z - R.z) - (Q.x - R.x) * (P.z - R.z);
          const q = { x, z }, d1 = d(q, A, B), d2 = d(q, B, C), d3 = d(q, C, A);
          const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
          if (neg && pos) continue;
          const den = (B.z - C.z) * (A.x - C.x) + (C.x - B.x) * (A.z - C.z);
          if (Math.abs(den) < 1e-12) continue;
          const wa = ((B.z - C.z) * (x - C.x) + (C.x - B.x) * (z - C.z)) / den, wb = ((C.z - A.z) * (x - C.x) + (A.x - C.x) * (z - C.z)) / den, wc = 1 - wa - wb;
          out.push(wa * A.y + wb * B.y + wc * C.y);
        }
      });
      return out.sort((a, b) => b - a);
    };
    const decks = [];
    M.roofGroup.traverse((o) => { if (o.isMesh && o.material === M.roofMat) { const bb = o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox); const sy = bb.max.y - bb.min.y; if (sy >= 0.1 && sy <= 0.35) decks.push(o); } });
    const raf = hitsOn(F.group.children.filter((m) => m.userData.ssFramePart === "roof" && !/osb/.test(m.material.name || "")));
    // The deck straight over the highest rafter top: the nearest deck face above it is that deck's underside
    // (a dormer's deck over the main roof's is further up, and is not the one this rafter carries).
    const over = raf.length ? hitsOn(decks).filter((y) => y >= raf[0] - 1e-3) : [];
    return { deckUnder: over.length ? Math.min(...over) : null, rafterTop: raf.length ? raf[0] : null };
  }, { x, z });
}

// A rafter station near the middle of the main ridge, in world feet along it (the ridge runs 0..L in its own
// frame, centred on the building).
const stationAt = (rec, oc) => {
  const sec = rec.secs[0], zs = LAYOUT.ssFrameLayout(sec.z0, sec.z1, oc);
  return zs[Math.floor(zs.length / 2)] - (sec.z0 + sec.z1) / 2;
};

// ── The cases ───────────────────────────────────────────────────────────────────────────────────────
const errs = [];
const done = async (r) => { errs.push(...r.errors.map((e) => `${r.tag}: ${e}`)); await r.ctx.close(); };

// 1. The A-frame at 16 and 24: the button, the swap, the counts, a door moved, the draw calls, the estimate.
async function caseGable(browser, id, shotName) {
  const c = CASES.find((q) => q.id === id);
  const [W, L] = sizeOf(c.size), oc = c.d3.framing.studOcIn;
  const r = await render(browser, c); r.tag = id;
  const { page } = r;
  ok(`${id}: the Framing button is in the footer`, await framingButton(page).count() > 0);
  const off = await page.evaluate(() => { const E = window.__ss3dEngine; E.render(); E.render(); return { calls: E.renderer.info.render.calls, built: !!E.model.ssFraming }; });
  ok(`${id}: nothing is framed before the button is pressed`, !off.built);
  // What shows, mesh by mesh, outside the framing's own lumber: Framing off must put back exactly this.
  const shown = () => page.evaluate(() => {
    const M = window.__ss3dEngine.model, out = [];
    M.root.traverse((o) => {
      if (!o.isMesh) return;
      for (let p = o; p; p = p.parent) if (p.userData && (p.userData.ssFraming || p.userData.ssFrameWood)) return;
      let v = true; for (let p = o; p && p !== M.root; p = p.parent) if (!p.visible) v = false;
      out.push(o.uuid + (v ? "+" : "-"));
    });
    return out.sort().join(",");
  });
  const before = await shown();
  await setFraming(page, true);
  await setFraming(page, false);
  ok(`${id}: Framing off puts back exactly what showed before, mesh for mesh`, (await shown()) === before);
  await setFraming(page, true);
  const st = await framingState(page);
  ok(`${id}: Framing on draws the framing and takes the siding, the roof skin and the casings off`,
    st.built && st.on && st.groupVisible && !st.wallsVisible && st.skinsShown === 0 && st.casingsShown === 0,
    JSON.stringify({ skins: st.skinsShown, casings: st.casingsShown, walls: st.wallsVisible }));
  ok(`${id}: the loft, the bench and the shelf are wood, their drawn look hidden`, st.wood === 3 && st.woodShown === 3 && st.solidShown === 0, `wood ${st.woodShown}/${st.wood}, drawn look showing ${st.solidShown}`);
  const rec = await frameRecord(page);
  const want = expectedWallMembers(rec, oc), got = (st.parts.walls ? st.parts.walls.verts : 0) / 24;
  ok(`${id}: the walls' lumber is exactly ssFrameWall's members (${oc}" OC, the interior wall included)`, want === got && got > 0, `${got} drawn, ${want} laid out`);
  // The 12 ft front wall at the layout: 10 marks at 16", 7 at 24" (the run is 12 ft plus the corners' T).
  ok(`${id}: a 12 ft run lays out ${oc === 16 ? 10 : 7} studs at ${oc}" (ssFrameLayout)`, LAYOUT.ssFrameLayout(0, 12, oc).length === (oc === 16 ? 10 : 7));
  // Trusses: every station of the main roof has its rafters, its collar tie and its peak gusset on both faces.
  const sec = rec.secs[0], stations = LAYOUT.ssFrameLayout(sec.z0, sec.z1, oc).length;
  const gus = (st.parts.gussets ? st.parts.gussets.verts : 0) / 48;
  ok(`${id}: ${stations} truss stations along the ${sec.z1 - sec.z0} ft ridge, a gusset on both faces of each`, gus === stations * 2, `${gus} gusset plates`);
  if (shotName) await shot(page, shotName, [W / 2 + 15, H + 7, L / 2 + 16], [0, H / 2, 0]);
  const on = await page.evaluate(() => { const E = window.__ss3dEngine; E.render(); E.render(); return E.renderer.info.render.calls; });
  ok(`${id}: Framing adds no more than 12 draw calls`, on - off.calls <= 12, `${off.calls} -> ${on}`);
  // No rafter top more than 1/4 in off the deck's underside, mid-slope on both sides at a station.
  const zMid = stationAt(rec, oc);
  const probes = rec.uAxisIsX ? [[-W / 4, zMid], [W / 4, zMid]] : [[zMid, -L / 4], [zMid, L / 4]];
  for (const [x, z] of probes) {
    const d = await deckAndRafter(page, x, z);
    ok(`${id}: the rafter's top sits on the deck's underside at (${x.toFixed(2)}, ${z.toFixed(2)})`, d.rafterTop != null && Math.abs(d.deckUnder - d.rafterTop) <= 0.25 / 12, `deck under ${d.deckUnder && d.deckUnder.toFixed(4)}, rafter top ${d.rafterTop && d.rafterTop.toFixed(4)}`);
  }
  if (id === "gable16") {
    // Look inside together with Framing: the rafters go with the roof, the walls' framing stays.
    await setRoof(page, false);
    const ro = await framingState(page);
    ok(`${id}: Roof off hides the rafters and trusses, keeps the walls' framing`, ro.parts.roof && !ro.parts.roof.visible && ro.parts.walls.visible);
    await shot(page, "07-floor-sheets-top.png", [0.01, 34, 0.01], [0, 0, 0]);
    await shot(page, "08-roof-off-looking-down.png", [W / 2 + 6, H + 14, L / 2 + 8], [0, 1, -1]);
    await setRoof(page, true);
    // The two walls with an opening, square on from outside.
    await shot(page, "06-door-wall.png", [0, 4.2, L / 2 + 13], [0, 4.2, L / 2]);
    await shot(page, "05-window-wall.png", [W / 2 + 12, 4.6, Math.min(12, L - 3) - L / 2], [W / 2, 4.6, Math.min(12, L - 3) - L / 2]);
    // The floor's sheets: rows 4 ft wide, 8 ft long, every other row 4 ft in.
    const sheets = LAYOUT.ssFloorSheets(W, L, null);
    const drawn = (await boxesOf(page, "floor", "osb")).length;
    ok(`${id}: ${sheets.length} floor sheets, the 4 ft rows staggered`, drawn === sheets.length && sheets.some((s) => s.z0 === 4 && s.z1 === 12), `${drawn} drawn`);
    // The 2x6 interior wall: its studs are 5.5 in deep, round its door.
    const p = rec.parts[0];
    ok(`${id}: the interior wall frames in 2x6 (5.5 in) with a framed door`, p && Math.abs(p.studFt - 5.5 / 12) < 1e-9 && p.ops.length === 1
      && LAYOUT.ssFrameWall({ a0: 0, a1: p.len, bot: 0, tops: p.tops, top: p.top, ocIn: oc, ops: p.ops }).filter((m) => m.kind === "king" || m.kind === "jack").length === 4);
    await shot(page, "11-interior-wall-2x6.png", [0.2, 4.4, 6.2], [-2.8, 3.4, 1]);
    await shot(page, "x-apex.png", [0, 10.6, L / 2 + 3.5], [0, 10.2, L / 2]);
    // A DOOR MOVED: the scoped rebuild a drag commits (rebuildWalls for that wall, then applyShellMode)
    // reframes its wall; no stud is left in the new opening.
    const after = await page.evaluate(({ W, L }) => {
      const E = window.__ss3dEngine, M = E.model;
      const visibleH = 1100 - 340, scale = Math.min((850 * 0.70) / W, (visibleH * 0.70) / L, (visibleH - 60) / (L + 4)), mgX = (850 - W * scale) / 2, mgY = 2 * scale + 30;
      const door = { id: 101, type: "singleDoor", x: mgX + 2.5 * scale, y: mgY + L * scale, rotation: 0, wall: "south", widthFt: 3, heightFt: 0.5 };
      M.rebuildWalls(["south"], [door]);
      E.applyShellMode(E); E.render();
      const ops = M.frameData.walls.south.ops;
      return { ops, x0: -W / 2 + ops[0].a0, x1: -W / 2 + ops[0].a1, y1: ops[0].y1 };
    }, { W, L });
    const south = (await boxesOf(page, "walls")).filter((b) => b.mn[2] > L / 2 - 0.3 && b.mx[2] < L / 2 + 0.3);
    const inDoor = south.filter((b) => b.mn[0] < after.x1 - 1e-3 && b.mx[0] > after.x0 + 1e-3 && b.mn[1] < after.y1 - 0.05 && b.mx[1] > 0.2);
    ok(`${id}: the door moved to 1 ft from the corner reframes its wall, no stud in the doorway`, after.ops.length === 1 && Math.abs(after.x0 - (-W / 2 + 1)) < 0.01 && inDoor.length === 0,
      `door ${after.x0.toFixed(2)}..${after.x1.toFixed(2)}, ${inDoor.length} pieces in it`);
    // THE ESTIMATE: "Use this view in my estimate" with Framing on reads a frame with the framing put away and
    // the finished building back, then brings the framing straight back.
    await page.evaluate(() => {
      const E = window.__ss3dEngine, c = E.renderer.domElement, M = () => window.__ss3dEngine.model;
      const real = c.toDataURL.bind(c);
      c.toDataURL = (...a) => {
        const F = M().ssFraming;
        let framingShown = 0;
        if (F) F.group.traverse((o) => { if (o.isMesh && o.visible && F.group.visible) framingShown++; });
        M().interiorGroup.traverse((o) => { if (o.userData && o.userData.ssFrameWood && o.visible) framingShown++; });
        const url = real(...a);
        window.__harnessShot = { framingShown, wallsVisible: M().wallsGroup.visible, url };
        return url;
      };
    });
    await shot(page, "x-before-estimate.png", [W / 2 + 15, H + 7, L / 2 + 16], [0, H / 2, 0]);
    await clickFooter(page, /Use this view in my estimate/);
    await page.waitForFunction(() => !!window.__harnessShot, null, { timeout: 15000 });
    const sh = await page.evaluate(() => ({ ...window.__harnessShot, after: !!window.__ss3dEngine.framing && window.__ss3dEngine.model.ssFraming.group.visible }));
    ok(`${id}: the estimate's picture is the finished building: no framing in the frame read back, the walls on`, sh.framingShown === 0 && sh.wallsVisible, `framing meshes showing ${sh.framingShown}`);
    ok(`${id}: and Framing is back on straight after`, sh.after);
    writeFileSync(join(SHOTS, "13-estimate-picture-no-framing.jpg"), Buffer.from(sh.url.split(",")[1], "base64"));
  }
  await done(r);
}

// 2. The barn: four rafters a station, gussets at both knees and the peak, a collar tie knee to knee.
async function caseBarn(browser, id) {
  const c = CASES.find((q) => q.id === id);
  const [W, L] = sizeOf(c.size), oc = c.d3.framing.studOcIn;
  const r = await render(browser, c); r.tag = id;
  const { page } = r;
  await setFraming(page, true);
  const st = await framingState(page), rec = await frameRecord(page);
  const sec = rec.secs[0], stations = LAYOUT.ssFrameLayout(sec.z0, sec.z1, oc).length;
  const tr = LAYOUT.ssFrameTruss(sec.dedup, sec.Hr);
  ok(`${id}: the barn truss has a gusset at both knees and the peak`, tr.gussets.length === 3 && tr.gussets.filter((g) => g.kind === "knee").length === 2 && tr.gussets.some((g) => g.kind === "peak"));
  ok(`${id}: every one of the ${stations} stations has its 3 gussets on both faces`, (st.parts.gussets ? st.parts.gussets.verts / 48 : 0) === stations * 6, `${st.parts.gussets && st.parts.gussets.verts / 48} plates`);
  ok(`${id}: a collar tie from knee to knee`, tr.ties.length === 1 && tr.ties[0].u1 - tr.ties[0].u0 > 2);
  if (id === "barn16") {
    await shot(page, "03-barn-front.png", [W / 2 + 14, H + 8, L / 2 + 15], [0, H / 2 + 1, 0]);
    await shot(page, "04-barn-end.png", [0, H / 2 + 2.5, L / 2 + 21], [0, H / 2 + 2.5, 0]);
  } else await shot(page, "03b-barn-24oc.png", [W / 2 + 14, H + 8, L / 2 + 15], [0, H / 2 + 1, 0]);
  await done(r);
}

// 3. No spacing set: no button, nothing built.
async function casePlain(browser) {
  const c = CASES.find((q) => q.id === "plain");
  const r = await render(browser, c); r.tag = "plain";
  ok("plain: a style with no spacing set has no Framing button", await framingButton(r.page).count() === 0);
  await done(r);
}

// 4. A raised seat: the eave wall's plate stands under the rafters, and the rafters still sit on the deck.
async function caseRaised(browser) {
  const c = CASES.find((q) => q.id === "raised");
  const [W, L] = sizeOf(c.size);
  const r = await render(browser, c); r.tag = "raised";
  const { page } = r;
  await setFraming(page, true);
  const rec = await frameRecord(page);
  ok("raised: the shell stands a 2x4 rafter (3.5 in) over the plate", Math.abs(rec.lift - 3.5 / 12) < 1e-9, `lift ${rec.lift}`);
  const want = expectedWallMembers(rec, 16), got = (await framingState(page)).parts.walls.verts / 24;
  ok("raised: the walls' lumber is ssFrameWall's, eave plates a rafter down", want === got, `${got} vs ${want}`);
  const zMid = stationAt(rec, 16), probe = rec.uAxisIsX ? [W / 4, zMid] : [zMid, L / 4];
  const d = await deckAndRafter(page, probe[0], probe[1]);
  ok("raised: the rafter's top sits on the deck's underside", d.rafterTop != null && Math.abs(d.deckUnder - d.rafterTop) <= 0.25 / 12, `${d.deckUnder} / ${d.rafterTop}`);
  const ex = rec.uAxisIsX ? W / 2 : 0, ez = rec.uAxisIsX ? 0 : L / 2;
  await shot(page, "09-raised-seat-heel.png", [ex + (rec.uAxisIsX ? 3.2 : 1.5), H + 0.9, ez + (rec.uAxisIsX ? 2.4 : 3.2)], [ex, H, ez - (rec.uAxisIsX ? 0.6 : 0)]);
  await done(r);
}

// 5. The 16x40 at 16": built inside the budget.
async function caseLong(browser) {
  const c = CASES.find((q) => q.id === "long");
  const r = await render(browser, c); r.tag = "long";
  const ms = await r.page.evaluate(() => {
    const E = window.__ss3dEngine;
    const t0 = performance.now();
    E.framing = true; E.applyShellMode(E);
    const t = performance.now() - t0;
    E.framing = false; E.applyShellMode(E);
    return t;
  });
  ok("long: Framing on a 16x40 at 16\" builds in under 60 ms", ms < 60, `${ms.toFixed(1)} ms`);
  await done(r);
}

// 6. The inside of a 12x24 A-frame: the loft, the bench and the double shelf in wood, beside the reference.
async function caseInside(browser) {
  const c = CASES.find((q) => q.id === "inside");
  const [W, L] = sizeOf(c.size);
  const r = await render(browser, c, { set: [101, 102, 103, 104, 105] }); r.tag = "inside";
  const { page } = r;
  await setFraming(page, true);
  const legs = await page.evaluate(() => { const g = window.__ss3dEngine.model.interiorGroup.children.find((x) => x.userData && x.userData.ssWood && x.userData.ssWood.kind === "bench"); return g ? g.userData.ssWood.legs.length : -1; });
  ok("inside: the bench against its wall keeps 2 front legs in wood", legs === 2, `${legs}`);
  await page.evaluate(() => { const E = window.__ss3dEngine; E.camera.fov = 62; E.camera.updateProjectionMatrix(); });
  await shot(page, "10-inside-loft-bench-shelf.png", [0.6, 5.4, L / 2 - 0.8], [0, 4.6, -L / 2]);
  await page.evaluate(() => { const E = window.__ss3dEngine; E.camera.fov = 34; E.camera.updateProjectionMatrix(); });
  await done(r);
}

// 7. Every other shape is framed by the same rules: rafters under every deck, studs in every clad face.
async function caseShape(browser, id, shotName, eyeFn) {
  const c = CASES.find((q) => q.id === id);
  const [W, L] = sizeOf(c.size);
  const r = await render(browser, c, { set: [101, 102] }); r.tag = id;
  const { page } = r;
  await setFraming(page, true);
  const st = await framingState(page);
  ok(`${id}: framed, nothing of the skin left showing`, st.built && st.groupVisible && st.skinsShown === 0 && st.parts.roof && st.parts.roof.verts > 0, JSON.stringify({ skins: st.skinsShown }));
  // Every deck has rafters under it (buildFraming3D's own list, one entry a deck) and the middle one's top is on the
  // deck's underside, measured by a vertical probe through both.
  const decks = await page.evaluate(() => window.__ss3dEngine.model.ssFraming.decks());
  let bare = 0, off = 0;
  for (const dk of decks) {
    if (!dk.rafters || !dk.at) { bare++; continue; }
    const d = await deckAndRafter(page, dk.at[0], dk.at[1]);
    if (!(d.rafterTop != null && d.deckUnder != null && Math.abs(d.deckUnder - d.rafterTop) <= 0.25 / 12)) off++;
  }
  ok(`${id}: every roof deck (${decks.length}) has rafters, seated on its underside`, decks.length > 0 && bare === 0 && off === 0, `${bare} without rafters, ${off} not seated`);
  await shot(page, shotName, ...eyeFn(W, L));
  if (id === "dormer") await shot(page, "19b-dormer-face.png", [-W / 2 - 13, H + 8, 7], [0, H + 1.5, 0]);
  if (id === "porch") await shot(page, "12b-porch-rafters-under.png", [W / 2 - 1, 3.2, L / 2 + 9], [0, H - 0.5, L / 2 + 2]);
  await done(r);
}

// 8. A phone: the button is on screen and works at 375 x 812.
async function casePhone(browser) {
  const c = CASES.find((q) => q.id === "gable16");
  // Opened at the desktop size (the designer's own 3D entry differs on a phone), then the window narrowed to a
  // phone's 375 x 812 with the viewer open: the viewer is one component at every width.
  const r = await render(browser, c); r.tag = "phone";
  const { page } = r;
  await page.setViewportSize({ width: 375, height: 812 });
  await settle(page, 800);
  const b = await page.evaluate(() => {
    const el = [...document.querySelectorAll("button")].filter((x) => /🪵 Framing/.test(x.textContent)).pop();
    if (!el) return null;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const q = el.getBoundingClientRect();
    return { x: q.x, y: q.y, w: q.width, h: q.height };
  });
  ok("phone: the Framing button is on screen at 375 x 812", b && b.x >= 0 && b.x + b.w <= 375 + 0.5 && b.y >= 0 && b.y + b.h <= 812 + 0.5, JSON.stringify(b));
  await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);
  await settle(page, 700);
  const st = await framingState(page);
  ok("phone: tapping it turns Framing on", st.on && st.groupVisible);
  await page.screenshot({ path: join(SHOTS, "14-phone-375.png") });
  await done(r);
}


// ── Settings > Designer > 3D: the "Wall framing" control, on the compiled portal ─────────────────────
// The style's spacing in Walls & foundation (the Advanced page's own section, which this page shows): it opens on
// what the style stores, a pick saves { studOcIn }, "Not set" saves null (so it clears: carryForwardFraming keeps a
// spacing only over an older designer's silence), and on a locked style it is read-only.
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000027", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const P_STYLE = (value, label, oc) => ({ value, label, sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }],
  d3: { roof: GABLE, siding: "batten", colors: COLORS, wallHeightFt: H, ...(oc ? { framing: { studOcIn: oc } } : {}) } });
const P_CONFIG = {
  branding: { companyName: "Acme Sheds", accentColor: "#3D3672", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  buildingStyles: [P_STYLE("aframed", "Acme Framed Cabin", 24), P_STYLE("alocked", "Acme Locked Cabin", 16)],
  defaultSizes: [], options: [],
  layoutItems: { door: { label: "Door", icon: "D", color: "#8B4513", width: 40, height: 12, shortLabel: "D" } },
  wallHeightFt: H,
};
const ENT = { reason: "internal", status: "active", granted: ["view_3d"], features: { view_3d: true }, exempt: true, state: "exempt" };

async function partSettings(browser) {
  const saves = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    window.__SS3D_DEBUG = true;
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const HD = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
  const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: HD, body: JSON.stringify(body) });
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => {
    const req = route.request();
    if (req.method() === "GET" && PASS_THROUGH_GET.test(req.url())) return route.continue();
    return route.abort();
  });
  const handler = async (route) => {
    const req = route.request(), url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...HD, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) return json(route, rpc[1] === "get_config" ? P_CONFIG : rpc[1] === "get_fixtures" ? [] : rpc[1] === "log_error" ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) return json(route, { ok: true, configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, entitlement: ENT });
    if (url.includes("/portal-settings")) {
      if (body.action === "save_style_d3") saves.push(body);
      if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: "owner", settings: { business_name: "Acme Sheds" }, config: { company_name: "Acme Sheds", accent_color: "#3D3672" }, access: null, prefs: null });
      if (body.action === "catalog") return json(route, { ok: true, aiReady: true, styles: [{ key: "aframed", model_status: "none" }, { key: "alocked", model_status: "locked" }], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(`**/${REF}.storage.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);
  const tile = (v) => page.locator(`[data-ss-adv-f="framing"] [data-ss-adv-tile="${v}"]`).first();
  const save = async () => {
    const n0 = saves.length;
    await page.getByRole("button", { name: /^Save 3D look$/ }).click();
    for (let i = 0; i < 80 && saves.length === n0; i++) await settle(page, 100);
    return saves[n0];
  };
  try {
    await page.goto(`${BASE}/settings/designer`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && document.body.innerText.includes("3D Style Calibration"), null, { timeout: 60000 });
    await page.getByRole("button", { name: "Acme Framed Cabin", exact: true }).first().click();
    await page.waitForSelector('.ss-cal [data-ss-adv="sections"]', { timeout: 30000 });
    await settle(page, 1200);
    await page.locator('[data-ss-adv-f="framing"]').first().scrollIntoViewIfNeeded();
    ok("settings: Wall framing is in Walls & foundation, opening on the stored 24 in", (await tile(24).getAttribute("aria-checked")) === "true"
      && (await tile(16).getAttribute("aria-checked")) === "false" && (await tile("none").getAttribute("aria-checked")) === "false");
    await page.locator('[data-ss-adv-f="framing"]').first().screenshot({ path: join(SHOTS, "21-setting-wall-framing.png") });
    await tile(16).click();
    await settle(page, 300);
    let sv = await save();
    ok("settings: a 16 in pick saves d3.framing { studOcIn: 16 }", sv && sv.d3 && sv.d3.framing && sv.d3.framing.studOcIn === 16 && Object.keys(sv.d3.framing).length === 1, JSON.stringify(sv && sv.d3 && sv.d3.framing));
    await tile("none").click();
    await settle(page, 300);
    sv = await save();
    ok("settings: Not set saves framing: null, so the server clears it", sv && sv.d3 && "framing" in sv.d3 && sv.d3.framing === null, JSON.stringify(sv && sv.d3 && sv.d3.framing));
    await tile(24).click();
    await settle(page, 300);
    sv = await save();
    ok("settings: and 24 in back again saves { studOcIn: 24 }", sv && sv.d3 && sv.d3.framing && sv.d3.framing.studOcIn === 24);
    // A locked style: read-only, saying why.
    await page.getByRole("button", { name: "Acme Locked Cabin", exact: true }).first().click();
    await page.waitForSelector('.ss-cal [data-ss-adv="sections"]', { timeout: 30000 });
    await page.waitForFunction(() => {
      const f = document.querySelector('[data-ss-adv-f="framing"]');
      return !!f && /locked/i.test(f.textContent || "");
    }, null, { timeout: 15000 }).catch(() => {});
    await page.locator('[data-ss-adv-f="framing"]').first().scrollIntoViewIfNeeded();
    const lockedTiles = await page.locator('[data-ss-adv-f="framing"] [data-ss-adv-tile]').evaluateAll((els) => els.map((e) => ({ v: e.getAttribute("data-ss-adv-tile"), on: e.getAttribute("aria-checked"), dis: e.disabled })));
    const lockedNote = await page.locator('[data-ss-adv-f="framing"]').first().textContent();
    ok("settings: on a locked style the spacing shows, read-only, and says why", lockedTiles.length === 3 && lockedTiles.every((t) => t.dis) && (lockedTiles.find((t) => t.v === "16") || {}).on === "true" && /locked/i.test(lockedNote),
      JSON.stringify(lockedTiles));
    await page.locator('[data-ss-adv-f="framing"]').first().screenshot({ path: join(SHOTS, "22-setting-locked.png") });
    ok("settings: no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  } finally {
    await ctx.close();
  }
}


// ── NOTHING CHANGES FOR A STYLE WITHOUT A SPACING ─────────────────────────────────────────────────────
// Production builders use this designer, and almost none of their styles will set d3.framing. So every shape
// above, with no spacing, is drawn by this build and by the build it was made from (SS_BASE_OLD serves that
// checkout: origin/beta, compiled), and the two scenes must be the same mesh for mesh (each mesh's group, type,
// colour, whether it shows, its world bounding box and a hash of its world vertices to 0.001 ft), the same
// footer, and the same pixels from the same camera. The only difference allowed is invisible: userData tags.
const BASE_OLD = process.env.SS_BASE_OLD || null;
async function sceneLines(page) {
  return page.evaluate(() => {
    const E = window.__ss3dEngine, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const q3 = (v) => { const r = Math.round(v * 1000); return Object.is(r, -0) ? 0 : r; };
    const hashInts = (arr) => { let h = 0x811c9dc5; for (let i = 0; i < arr.length; i++) { let x = arr[i] | 0; for (let k = 0; k < 4; k++) { h ^= x & 0xff; h = Math.imul(h, 0x01000193); x >>>= 8; } } return (h >>> 0).toString(16); };
    const vis = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return 0; return 1; };
    const out = [], v = new V();
    E.scene.traverse((o) => {
      if (!(o.isMesh || o.isLine || o.isPoints) || !o.geometry) return;
      const pos = o.geometry.attributes && o.geometry.attributes.position;
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], ints = [];
      if (pos) for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); ints.push(q3(c)); });
      }
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const col = mats.map((m) => (m && m.color ? m.color.getHexString() : "-")).join("/");
      out.push([o.type, o.geometry.type, col, vis(o), mn.map(q3).join(","), mx.map(q3).join(","), pos ? pos.count : 0, hashInts(ints)].join("|"));
    });
    const footer = [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => /Roof|Landscape|Look inside|Framing|Items|Views/.test(t));
    return { lines: out.sort(), footer };
  });
}
async function partBaseline(browser) {
  if (!BASE_OLD) { console.log("SKIP  baseline: set SS_BASE_OLD to a server for the build this one was made from"); return; }
  const noFraming = (c) => ({ ...c, id: c.id + "-none", d3: { ...c.d3, framing: undefined } });
  const ids = ["gable16", "barn16", "raised", "porch", "recess", "leanto", "wings", "shed", "dormer", "step"];
  const extra = ids.map((id) => noFraming(CASES.find((q) => q.id === id)));
  // The baseline cases are styles of their own in the same made-up tenant: CONFIG gains them for both builds.
  extra.forEach((c) => {
    if (CONFIG.buildingStyles.some((s) => s.value === c.id)) return;
    const st = { value: c.id, label: c.label + " (none)", img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3(c) };
    delete st.d3.framing;
    CONFIG.buildingStyles.push(st);
    const [w, l] = sizeOf(c.size);
    CONFIG.sizePricing[c.id] = { [c.size]: { widthFt: w, lengthFt: l, basePrice: 9000 } };
  });
  for (const c of extra) {
    const got = {};
    for (const [tag, base] of [["old", BASE_OLD], ["new", BASE]]) {
      const r = await render(browser, c, { base }); r.tag = `baseline ${c.id} ${tag}`;
      const s = await sceneLines(r.page);
      const [W, L] = sizeOf(c.size);
      // Landscape off for the pixels: the grass is a fresh random texture on every load (it differs between two
      // loads of the SAME build), and the building is what is being compared.
      await clickFooter(r.page, /🌿 Landscape/);
      await settle(r.page, 500);
      const png = await shot(r.page, `baseline-${c.id}-${tag}.png`, [W / 2 + 15, H + 7, L / 2 + 16], [0, H / 2, 0]);
      got[tag] = { ...s, png: readFileSync(png) };
      await done(r);
    }
    const a = got.old, b = got.new;
    const diff = a.lines.filter((x) => !b.lines.includes(x)).length + b.lines.filter((x) => !a.lines.includes(x)).length;
    ok(`baseline ${c.id}: the scene is the same mesh for mesh as origin/beta's (${a.lines.length} meshes)`, diff === 0 && a.lines.length === b.lines.length, `${diff} lines differ`);
    ok(`baseline ${c.id}: the same footer, no Framing button`, JSON.stringify(a.footer) === JSON.stringify(b.footer) && !b.footer.some((t) => /Framing/.test(t)), JSON.stringify(b.footer));
    ok(`baseline ${c.id}: the same pixels from the same camera, landscape off`, Buffer.compare(a.png, b.png) === 0, `${a.png.length} vs ${b.png.length} bytes`);
  }
}


// ── DOORS AND WINDOWS STAY IN THE FRAMING VIEW ─────────────────────────────────────────────────────────
// Framing takes the siding off and keeps every door and window: only the casings go (they would stand in
// front of the studs), and the shallow room drawn behind a pane, since the real inside now shows through.
// Every door look (the eight door_style looks and the plain slab), single and double, a door shown by its
// photo, a catalog window and a built-in one, on one 30x60 building at 16": for each opening, every mesh that
// showed with Framing off still shows with it on, but for those two kinds, and each still draws its leaf or sash.
const DOOR_LOOKS = ["american", "basic", "classic", "dutch", "plank", "zbrace", "xbrace", "rollup", "auto"];
const DOOR_BASE = { colorMode: "paint", hasTrimColor: true, imageUrl: null, opLeft: true, opRight: true, opDouble: true, opSlideUp: true, opDefault: "right",
  swingIn: false, swingOut: true, swingDefault: null, sillIn: null, sillMode: "fixed", sortOrder: 0, price: 500 };
const PHOTO_URL = `https://${REF}.supabase.co/storage/v1/object/public/fixtures/harness-framing-photo.png`;
const doorRow = (id, name, look, wIn, extra = {}) => ({ ...DOOR_BASE, id, category: "door", name, planLabel: name.slice(0, 4).toUpperCase(), widthIn: wIn, heightIn: 80,
  ...(look === "auto" ? {} : { doorStyle: look }), ...extra });
const DOOR_FIX = [
  ...DOOR_LOOKS.flatMap((k) => [doorRow(`fd-${k}`, `${k} single`, k, 36), doorRow(`fd-${k}2`, `${k} double`, k, 72)]),
  doorRow("fd-photo", "photo single", "auto", 36, { imageUrl: PHOTO_URL }),
  { id: "fw-dh", category: "window", name: "Double hung", planLabel: "DH", price: 120, widthIn: 36, heightIn: 48, sortOrder: 0, colorMode: "fixed", hasTrimColor: false, imageUrl: null, sillIn: null, sillMode: "fixed" },
];
// A plain 48 x 96 door photo, drawn here (no file, no network).
function pngDoor() {
  const w = 48, h = 96, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const panel = x > 8 && x < 40 && ((y > 10 && y < 43) || (y > 53 && y < 86));
    raw.set(panel ? [150, 112, 74, 255] : [118, 86, 56, 255], y * (w * 4 + 1) + 1 + x * 4);
  }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = (crcT[(c ^ v) & 255] ^ (c >>> 8)) >>> 0; return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, "ascii"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
async function partDoors(browser) {
  const c = { id: "doorsFrame", label: "Doors framed", size: "30x60", d3: { roof: GABLE, ...FR(16) } };
  if (!CONFIG.buildingStyles.some((s) => s.value === c.id)) {
    CONFIG.buildingStyles.push({ value: c.id, label: c.label, img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3(c) });
    CONFIG.sizePricing[c.id] = { [c.size]: { widthFt: 30, lengthFt: 60, basePrice: 9000 } };
  }
  const W = 30, L = 60, g = PG(W, L), lens = { south: W, east: L, north: W, west: L }, walls = ["south", "east", "north", "west"];
  const pos = (wall, at) => wall === "north" ? { x: g.mgX + at * g.scale, y: g.mgY, rotation: 0 }
    : wall === "south" ? { x: g.mgX + at * g.scale, y: g.mgY + L * g.scale, rotation: 0 }
    : wall === "west" ? { x: g.mgX, y: g.mgY + at * g.scale, rotation: 90 } : { x: g.mgX + W * g.scale, y: g.mgY + at * g.scale, rotation: 90 };
  const list = [
    ...DOOR_LOOKS.flatMap((k) => [{ fx: `fd-${k}`, op: "right" }, { fx: `fd-${k}2`, op: "double" }]),
    { fx: "fd-photo", op: "right" }, { win: "fw-dh" }, { builtin: "window" }, { builtin: "singleDoor" },
  ];
  let wi = 0, at = 2;
  const items = list.map((d, i) => {
    const fx = d.fx ? DOOR_FIX.find((f) => f.id === d.fx) : d.win ? DOOR_FIX.find((f) => f.id === d.win) : null;
    const w = fx ? fx.widthIn / 12 : 3;
    while (at + w > lens[walls[wi]] - 2) { wi++; at = 2; }
    const wall = walls[wi], p = pos(wall, at + w / 2);
    at += w + 1.5;
    if (d.builtin) return { id: 800 + i, type: d.builtin, ...p, wall, widthFt: 3, heightFt: 0.5 };
    if (d.win) return { id: 800 + i, type: "window", ...p, wall, widthFt: w, heightFt: 0.5, fixtureItemId: fx.id, windowName: fx.name, price: fx.price, widthIn: fx.widthIn, heightIn: fx.heightIn, sillMode: "fixed", colorId: null, colorLabel: null, colorHex: null };
    return { id: 800 + i, type: "fixtureDoor", ...p, wall, widthFt: w, heightFt: 0.5, fixtureItemId: fx.id, doorName: fx.name, planLabel: fx.planLabel, price: fx.price,
      widthIn: fx.widthIn, heightIn: fx.heightIn, swing: "out", operation: d.op, colorId: null, colorLabel: null, colorHex: null, trimColorId: null, trimColorLabel: null, trimColorHex: null, sillMode: "fixed" };
  });
  const photo = pngDoor();
  const r = await render(browser, c, { items, fixtures: { ...FIXTURES, items: DOOR_FIX }, routes: (page) => page.route(PHOTO_URL, (route) => route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: photo })) });
  r.tag = "doors";
  const { page } = r;
  await settle(page, 1500);
  // Per opening: the meshes showing, by kind (a casing, the room behind a pane, or the door or window itself).
  const showing = () => page.evaluate(() => {
    const M = window.__ss3dEngine.model, out = {};
    M.openingsGroup.children.forEach((og) => {
      if (!og.userData || og.userData.itemId == null) return;
      const rec = { kept: [], casing: 0, room: 0 };
      og.traverse((o) => {
        if (!o.isMesh) return;
        let v = true; for (let p = o; p && p !== M.root; p = p.parent) if (!p.visible) v = false;
        if (!v) return;
        if (o.userData && (o.userData.ssCasing || o.userData.ssDoorPart === "header")) rec.casing++;
        else if (o.userData && o.userData.ssGlassRoom) rec.room++;
        else rec.kept.push(o.uuid);
      });
      out[og.userData.itemId] = rec;
    });
    return out;
  });
  const off = await showing();
  await shot(page, "23b-doors-front-finished.png", [0, 5, L / 2 + 30], [0, 4, L / 2]);
  await setFraming(page, true);
  const on = await showing();
  const name = (id) => { const it = items.find((x) => x.id === Number(id)); return it.doorName || it.windowName || it.type; };
  const ids = Object.keys(off);
  ok("doors: every placed door and window has its opening drawn", ids.length === items.length, `${ids.length} of ${items.length}`);
  const lost = ids.filter((id) => off[id].kept.some((u) => !on[id].kept.includes(u)));
  ok("doors: with Framing on every door and window keeps every part it showed (leaves, stiles, rails, hinges, glass, sash, photo), all 9 looks single and double, a photo door, two windows",
    lost.length === 0, lost.map(name).join(", "));
  ok("doors: and each still draws something (no opening left empty)", ids.every((id) => on[id].kept.length > 0), ids.filter((id) => !on[id].kept.length).map(name).join(", "));
  ok("doors: only the casings go (they would stand in front of the studs)", ids.every((id) => on[id].casing === 0) && ids.some((id) => off[id].casing > 0));
  ok("doors: and the rooms behind the glass (the real inside shows through now)", ids.every((id) => on[id].room === 0));
  const photoId = items.find((x) => x.fixtureItemId === "fd-photo").id;
  ok("doors: the photo door keeps its photo", on[photoId].kept.length > 0 && on[photoId].kept.length === off[photoId].kept.length);
  await shot(page, "23-doors-front.png", [0, 5, L / 2 + 30], [0, 4, L / 2]);
  await shot(page, "24-doors-right.png", [W / 2 + 34, 5, 0], [W / 2, 4, 0]);
  await shot(page, "25-doors-back.png", [0, 5, -L / 2 - 30], [0, 4, -L / 2]);
  await shot(page, "26-doors-left.png", [-W / 2 - 34, 5, 0], [-W / 2, 4, 0]);
  await done(r);
}

const only = process.env.SS_FRAMING_ONLY ? new Set(process.env.SS_FRAMING_ONLY.split(",")) : null;
const want = (k) => !only || only.has(k);
const { browser } = await launch();
try {
  if (want("gable16")) await caseGable(browser, "gable16", "01-a-frame-16oc.png");
  if (want("gable24")) await caseGable(browser, "gable24", "02-a-frame-24oc.png");
  if (want("barn16")) await caseBarn(browser, "barn16");
  if (want("barn24")) await caseBarn(browser, "barn24");
  if (want("plain")) await casePlain(browser);
  if (want("raised")) await caseRaised(browser);
  if (want("long")) await caseLong(browser);
  if (want("inside")) await caseInside(browser);
  const corner = (W, L) => [[W / 2 + 15, H + 8, L / 2 + 16], [0, H / 2, 0]];
  if (want("porch")) await caseShape(browser, "porch", "12-porch-framed.png", (W, L) => [[W / 2 + 14, H + 6, L / 2 + 20], [0, H / 2, 2]]);
  if (want("recess")) await caseShape(browser, "recess", "15-recessed-porch-framed.png", corner);
  if (want("leanto")) await caseShape(browser, "leanto", "16-lean-to-framed.png", (W, L) => [[W / 2 + 20, H + 7, L / 2 + 14], [3, H / 2, 0]]);
  if (want("wings")) await caseShape(browser, "wings", "17-wings-framed.png", (W, L) => [[W / 2 + 18, H + 10, L / 2 + 20], [0, H / 2 + 2, 0]]);
  if (want("shed")) await caseShape(browser, "shed", "18-single-slope-framed.png", corner);
  if (want("dormer")) await caseShape(browser, "dormer", "19-dormer-framed.png", (W, L) => [[W / 2 + 16, H + 9, 6], [0, H / 2 + 1, 0]]);
  if (want("step")) await caseShape(browser, "step", "20-roof-step-framed.png", corner);
  if (want("phone")) await casePhone(browser);
  if (want("settings")) await partSettings(browser);
  if (want("baseline")) await partBaseline(browser);
  if (want("doors")) await partDoors(browser);
  ok("no page errors", errs.length === 0, errs.join(" | ").slice(0, 400));
} finally {
  await browser.close();
}
console.log(`\n${failed().length ? "FAILED" : "ALL PASS"}  shots in ${SHOTS}`);
process.exit(failed().length ? 1 : 0);
