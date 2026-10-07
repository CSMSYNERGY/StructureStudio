// THE ROOF RAISED BY THE RAFTER (roof.seat / roof.rafterDepthIn, 2026-10-06), MEASURED.
//
// Carolyn's Q28: "make it an option in the designer setup for each design: roof on the plate, or raised
// by the rafter height". "Raised" stands the whole shell, the walls and the roof together, one rafter
// above the wall plate (d3ShellFt in both twins). This drives the COMPILED bundle and proves:
//
//   a  absent, "plate" and a rafter height with no seat draw the SAME scene, mesh for mesh (the stored-
//      style digest's own lines), on every case below;
//   b  "raised" (a blank rafter: 3.5 in) moves the building together: every mesh keeps its plan extent;
//      everything of the roof above the walls is lifted exactly 3.5 in; every wall keeps its bottom and
//      gains 3.5 in at its top; nothing is left between the wall tops and the gable caps that was not
//      there before; and the inside (the partition wall, the loft, the ceiling light) does not move;
//      and a light stamped at 96 in on the right-hand wall, within 3 in of the 8 ft PLATE, stays the lamp
//      outside under the eave (never an inside cover plate up in the rafter band);
//   c  a 5.5 in rafter (a 2x6) lifts it 5.5 in;
//   d  a style with wings set to "raised" draws exactly as it does on the plate (v1);
//   e  the numbers Carolyn hears: where the eave's top edge and its underside end up against the wall
//      plate, at a 12 in overhang and 4.8:12, on the plate, on a 2x4 and on a 2x6;
//   f  the End view: the "wall" dimension still reads the plate, and the "rafter" dimension is drawn
//      only when raised; with a lean-to on the left its words cross no roof line and no other words;
//   g  Settings > Designer > 3D: the choice and the box, greyed with wings; "On the plate" removes
//      roof.seat from the save_style_d3 the stub answers, and a blank rafter box removes rafterDepthIn;
//      every save says seatAware: true (so the server lets those absences land); and the same on the
//      operator's ?admin=1 grid. (Its "What we drew" line only shows after a model's self-check, so
//      roofSeat_test pins its words instead.)
//
// Cases: a 12x16 gable at 4.8:12 with a 12 in overhang, extended and notched; an open eave; a gambrel; a
// shed in the new frame; a roof step; a projecting porch; a recessed porch; a lean-to; a winged style.
// A projecting porch's or a lean-to's own roof is outside the building and is REPORTED, not asserted: a
// porch roof that meets the wall a rafter higher may be steeper (its pitch solver has more room).
//
//   python -m http.server 8903 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8903 SS_SHOTS=<dir> node tests/harness/roofSeat.mjs
//   SS_ROOFSEAT_ONLY=designer | settings | grid      runs one part
//   SS_ROOFSEAT_CASES=ext,notch                      runs those cases of the designer part
//
// RUN SERIALLY (one browser, one page at a time). Exit 0 = every check held. NOTHING LEAVES THE
// MACHINE (lib.mjs stubSupabase; the portal part stubs the same way). The tenant is made up.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, BASE, REF, PASS_THROUGH_GET } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = shotsDir("roofSeat");
const { ok, failed } = reporter();
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const f4 = (n) => (n == null || !isFinite(n) ? "  (none)" : (n >= 0 ? " " : "") + n.toFixed(4));
const inch = (ft) => (ft == null || !isFinite(ft) ? "?" : `${ft >= 0 ? "+" : ""}${(ft * 12).toFixed(2)} in`);

const CLIENT = "harness-roof-seat";
const CODE = "SS-HARNESSRS1";
const H = 8, PITCH = 0.4, ROOF_T = 0.2;
const NY = Math.cos(Math.atan(PITCH));
const COLORS = { body: "#4a3327", roof: "#8a8f94", trim: "#b0a081" };
const GABLE = { type: "gable", pitch: PITCH, ridgeOffset: 0, eave: "fascia", overhang: 1.0 };
const CASES = [
  { id: "ext", label: "Gable extended", size: "12x16", roof: { ...GABLE, overhangStyle: "extended" }, eave: true },
  { id: "notch", label: "Gable notched", size: "12x16", roof: { ...GABLE, overhangStyle: "notched" }, eave: true, extra55: true },
  { id: "open", label: "Open eave", size: "12x16", roof: { ...GABLE, eave: "open", tailSpacingIn: 24 } },
  { id: "gambrel", label: "Gambrel barn", size: "12x16", roof: { type: "gambrel", overhang: 0.6, kneeU: 0.55, kneeRise: 0.55, ridgeRise: 0.8 } },
  { id: "shed", label: "Shed new frame", size: "12x16", roof: { type: "shed", pitch: 0.25, overhang: 0.6, eave: "fascia", highSide: "back" } },
  { id: "step", label: "Roof step", size: "12x16", roof: { ...GABLE, front: "gable", rearStepFt: 6, rearEaveRiseFt: 0.5 } },
  { id: "porch", label: "Projecting porch", size: "12x16", roof: { ...GABLE, porchOutFt: 6, porchEnd: "front" } },
  { id: "recess", label: "Recessed porch", size: "12x16", roof: { ...GABLE, porchDepthFt: 4, porchEnd: "front", porchTruss: true } },
  { id: "leanto", label: "Lean-to", size: "12x16", roof: { ...GABLE, leanToWidthFt: 6, leanToDropFt: 1, leanToSide: "right" } },
  { id: "wings", label: "Winged centre", size: "24x16", roof: { type: "gable", pitch: 0.5, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 6, wingPitch: 0.25, centerEaveFt: 14 } },
];
// Each case drawn: absent, "plate", a rafter alone, raised on a blank rafter (3.5), and on the notched
// gable raised on a 2x6 (5.5).
const VARIANTS = {
  absent: (r) => r,
  plate: (r) => ({ ...r, seat: "plate" }),
  rafterOnly: (r) => ({ ...r, rafterDepthIn: 5.5 }),
  raised: (r) => ({ ...r, seat: "raised" }),
  raised55: (r) => ({ ...r, seat: "raised", rafterDepthIn: 5.5 }),
};
const sizeOf = (s) => s.split("x").map(Number);
const styleValue = (c, v) => `${c.id}-${v}`;
const D3 = (roof) => ({ roof, siding: "panel", colors: COLORS, foundation: "slab", roofMaterial: "shingle", wallHeightFt: H });

const PLAN_ITEMS = {
  loft: { label: "Loft", icon: "⬆️", color: "#7C3AED", width: 6, height: 4, shortLabel: "LF", wallOnly: false, wallSnap: false, group: "interior" },
  partitionWall: { label: "Partition Wall", icon: "🧱", color: "#57534E", width: 4, height: 0.375, shortLabel: "PART", wallOnly: false, wallSnap: false, group: "interior", modelKey: "partition" },
};
const STYLES = [];
for (const c of CASES) for (const v of Object.keys(VARIANTS)) {
  if (v === "raised55" && !c.extra55) continue;
  STYLES.push({ value: styleValue(c, v), label: `${c.label} ${v}`, img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3(VARIANTS[v](c.roof)) });
}
const CONFIG = {
  clientId: CLIENT,
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: [],
  buildingStyles: STYLES,
  defaultSizes: [...new Set(CASES.map((c) => c.size))],
  sizePricing: Object.fromEntries(STYLES.map((s) => { const [w, l] = sizeOf(s.sizes[0]); return [s.value, { [s.sizes[0]]: { widthFt: w, lengthFt: l, basePrice: 9000 } }]; })),
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: true,
  layoutItems: PLAN_ITEMS, layoutPricing: { loft: { rate: 6, method: "sqft_option" }, partitionWall: { rate: 22, method: "lineal_ft" } }, layoutPrices: {},
  electrical: null, insulation: [],
  electricalItems: [
    { id: "e-lt", icon: "💡", name: "Light", mount: "ceiling", withPackage: false, standalone: true, priceWithPackage: null, priceStandalone: 65, heightOffFloorIn: 96 },
    // A wall light whose name says nothing of outdoors: it is the lamp under the eave only because it is
    // stamped within 3 in of the plate (buildElectrical3D's plate rule).
    { id: "e-wl", icon: "💡", name: "Barn Light", mount: "wall", withPackage: false, standalone: true, priceWithPackage: null, priceStandalone: 85, heightOffFloorIn: 96 },
  ],
};
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };

// The designer's page geometry (pageGeom) for W x L: what items[].x/y are measured in.
const PG = (W, L) => {
  const visibleH = 1100 - 340;
  const scale = Math.min((850 * 0.70) / W, (visibleH * 0.70) / L, (visibleH - 60) / (L + 4));
  return { scale, mgX: (850 - W * scale) / 2, mgY: 2 * scale + 30 };
};
// A door on the front, a window on the right wall, a full-height partition 9 ft from the back, a loft on the
// plate over the back 4 ft, a ceiling light in the middle of the front room, and the Barn Light at 96 in on
// the right-hand wall, 10.5 ft from the back (in front of the roof step's joint, behind a recessed porch).
const itemsFor = (W, L) => {
  const g = PG(W, L), px = (x) => g.mgX + x * g.scale, py = (y) => g.mgY + y * g.scale;
  return [
    { id: 101, type: "singleDoor", x: px(W / 2), y: py(L), rotation: 0, wall: "south", widthFt: 3, heightFt: 0.5 },
    { id: 102, type: "window", x: px(W), y: py(12), rotation: 90, wall: "east", widthFt: 2, heightFt: 0.5 },
    { id: 103, type: "partitionWall", wall: null, axis: "x", atFt: 9, fromFt: 0, toFt: W, heightIn: null, openings: [] },
    { id: 104, type: "loft", x: px(W / 2), y: py(2), rotation: 0, wall: null, widthFt: W, heightFt: 4, onPlate: true },
    { id: 105, type: "e-lt", x: px(W / 2), y: py(12.5), rotation: 0, wall: null, widthFt: 0.8, heightFt: 0.8, electricalItemId: "e-lt", heightOffFloorIn: 96 },
    { id: 106, type: "e-wl", x: px(W), y: py(10.5), rotation: 90, wall: "east", widthFt: 0.5, heightFt: 0.3, electricalItemId: "e-wl", heightOffFloorIn: 96 },
  ];
};
const designRow = (c, v) => {
  const [W, L] = sizeOf(c.size);
  return {
    short_code: CODE, client_id: CLIENT, status: "draft", version: 1,
    selections: { style: styleValue(c, v), size: c.size, roofType: "", roofColor: "", cladding: "" },
    items: itemsFor(W, L), paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
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
  // Settle: the model must stay the same object for 1.5 s (no queued rebuild still pending).
  await page.evaluate(async () => {
    let last = window.__ss3dEngine.model, since = performance.now();
    while (performance.now() - since < 1500) {
      await new Promise((r) => setTimeout(r, 100));
      const m = window.__ss3dEngine.model;
      if (m !== last) { last = m; since = performance.now(); }
    }
  });
}

// Every mesh, line and point set in the scene in traversal order: its model group, a digest line (the
// stored-style digest's own fields: bbox and a hash of the world-space vertices to 0.001 ft), its world
// bbox, its geometry and colour. Traversal order is the build order, the same for the same case.
async function sceneRecords(page) {
  return page.evaluate(() => {
    const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const q3 = (v) => { const r = Math.round(v * 1000); return Object.is(r, -0) ? 0 : r; };
    const hashInts = (arr) => { let h = 0x811c9dc5; for (let i = 0; i < arr.length; i++) { let x = arr[i] | 0; for (let k = 0; k < 4; k++) { h ^= x & 0xff; h = Math.imul(h, 0x01000193); x >>>= 8; } } return (h >>> 0).toString(16); };
    const groups = new Map([[M.roofGroup, "roof"], [M.wallsGroup, "walls"], [M.openingsGroup, "open"], [M.interiorGroup, "interior"], [M.envGroup, "env"], [M.root, "root"]]);
    const groupOf = (o) => { for (let p = o; p; p = p.parent) if (groups.has(p)) return groups.get(p); return "scene"; };
    const vis = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return 0; return 1; };
    // Which electrical device a mesh belongs to (buildElectrical3D's userData.ssElec), or null.
    const elecOf = (o) => { for (let p = o; p; p = p.parent) if (p.userData && p.userData.ssElec) return String(p.userData.ssElec); return null; };
    const out = [];
    const v = new V();
    E.scene.traverse((o) => {
      if (!(o.isMesh || o.isLine || o.isPoints) || !o.geometry) return;
      const pos = o.geometry.attributes && o.geometry.attributes.position;
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], ints = [];
      if (pos) for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); ints.push(q3(c)); });
      }
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const color = m && m.color ? "#" + m.color.getHexString() : null;
      const g = groupOf(o);
      out.push({ g, type: o.type, geom: o.geometry.type, color, vis: vis(o), min: mn, max: mx, elec: elecOf(o),
        line: [g, o.type, o.geometry.type, color, vis(o), mn.map(q3).join(","), mx.map(q3).join(","), pos ? pos.count : 0, hashInts(ints)].join("|") });
    });
    const loftElev = M.loftElevFt ? M.loftElevFt({ id: 104, type: "loft", x: 0, y: 0, widthFt: 1, heightFt: 1, onPlate: true }) : null;
    return { recs: out, loftElev };
  });
}

async function render(browser, c, v) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [designRow(c, v)] } });
  await openDesigner(page, CLIENT);
  await page.goto(`${BASE}/?client=${CLIENT}&id=${CODE}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  const L = sizeOf(c.size)[1];
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 30000 });
  await settle(page, 1200);
  await openEditor(page);
  const s = await sceneRecords(page);
  return { page, ctx, errors, ...s };
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
    const r = window.__ss3dEngine.renderer.domElement.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.screenshot({ path, clip: box });
}

// How one mesh moved from the plate drawing to the raised one: "same", "shift" (both ends up by the
// lift), "stretch" (the bottom stays, the top goes up by the lift), or "other". Plan extent must not move.
function moved(a, b, lift, eps = 1e-3) {
  const planSame = Math.abs(a.min[0] - b.min[0]) < eps && Math.abs(a.max[0] - b.max[0]) < eps && Math.abs(a.min[2] - b.min[2]) < eps && Math.abs(a.max[2] - b.max[2]) < eps;
  const d0 = b.min[1] - a.min[1], d1 = b.max[1] - a.max[1];
  const kind = Math.abs(d0) < eps && Math.abs(d1) < eps ? "same"
    : Math.abs(d0 - lift) < eps && Math.abs(d1 - lift) < eps ? "shift"
      : Math.abs(d0) < eps && Math.abs(d1 - lift) < eps ? "stretch" : "other";
  return { kind: planSame ? kind : "other", d0, d1, planSame };
}
// Inside the building's own box (its footprint plus the overhang and a little): a porch's or a lean-to's
// own roof reaches past it, and is reported rather than asserted.
const insideBox = (r, W, L, ov) => {
  const bx = W / 2 + ov + 0.6, bz = L / 2 + ov + 0.6;
  return r.min[0] >= -bx && r.max[0] <= bx && r.min[2] >= -bz && r.max[2] <= bz;
};

// The right-hand eave on a 12x16 gable (ridge along z): the deck slab, the fascia and the soffit.
function eave(recs, W) {
  const roof = recs.filter((m) => m.g === "roof" && m.geom === "BoxGeometry" && m.vis);
  const far = Math.max(...roof.map((m) => m.max[0]));
  const atEave = roof.filter((m) => m.max[0] > far - 1.0);
  const trim = atEave.filter((m) => m.color === COLORS.trim);
  const slab = atEave.filter((m) => m.color !== COLORS.trim).sort((a, b) => (b.max[2] - b.min[2]) - (a.max[2] - a.min[2]))[0] || null;
  const fascia = trim.filter((m) => m.max[1] - m.min[1] >= m.max[0] - m.min[0] && m.max[1] - m.min[1] < 1.0 && m.max[0] - m.min[0] < 0.5).sort((a, b) => b.max[0] - a.max[0])[0] || null;
  const deckUnder = slab ? slab.min[1] : null;
  return { deckOutX: slab ? slab.max[0] : null, deckUnder, deckTop: deckUnder == null ? null : deckUnder + ROOF_T * NY, finish: fascia ? fascia.min[1] : null, wallX: W / 2 };
}

async function partDesigner(browser) {
  const numbers = [];
  const only = process.env.SS_ROOFSEAT_CASES ? new Set(process.env.SS_ROOFSEAT_CASES.split(",")) : null;
  for (const c of CASES) {
    if (only && !only.has(c.id)) continue;
    const [W, L] = sizeOf(c.size);
    const ov = c.roof.overhang != null ? c.roof.overhang : 0.6;
    const got = {};
    for (const v of Object.keys(VARIANTS)) {
      if (v === "raised55" && !c.extra55) continue;
      const r = await render(browser, c, v);
      got[v] = { recs: r.recs, loftElev: r.loftElev, errors: r.errors.slice() };
      if (c.id === "notch" && (v === "absent" || v === "raised" || v === "raised55")) {
        await shot(r.page, join(SHOTS, `eave-12in-${v === "absent" ? "on-plate" : v === "raised" ? "raised-2x4" : "raised-2x6"}.png`), [W / 2 + 7.5, H + 0.4, 5.5], [W / 2 + 0.2, H - 0.1, 2]);
        await shot(r.page, join(SHOTS, `building-${v === "absent" ? "on-plate" : v === "raised" ? "raised-2x4" : "raised-2x6"}.png`), [W / 2 + 16, H + 5, L / 2 + 14], [0, H / 2, 0]);
        // Square on to the front gable end at the right-hand eave, the camera fixed: the corner, the eave
        // and the door's head, so the three drawings can be laid over each other.
        await shot(r.page, join(SHOTS, `end-12in-${v === "absent" ? "on-plate" : v === "raised" ? "raised-2x4" : "raised-2x6"}.png`), [W / 2 - 0.4, H - 0.6, L / 2 + 7], [W / 2 - 0.4, H - 0.6, L / 2]);
      }
      await r.ctx.close();
    }
    const A = got.absent;
    ok(`[${c.id}] no page errors`, Object.values(got).every((g) => g.errors.length === 0), Object.values(got).flatMap((g) => g.errors).join(" | ").slice(0, 300));

    // a ── absent, "plate" and a rafter alone are one drawing ───────────────────────────────────
    const lines = (g) => g.recs.map((m) => m.line).sort().join("\n");
    ok(`a [${c.id}] "plate" draws exactly what absent draws`, lines(got.plate) === lines(A), `${got.plate.recs.length} vs ${A.recs.length} meshes`);
    ok(`a [${c.id}] a rafter height with no seat draws exactly what absent draws`, lines(got.rafterOnly) === lines(A), `${got.rafterOnly.recs.length} vs ${A.recs.length} meshes`);

    // d ── a style with wings stays on the plate ──────────────────────────────────────────────
    if (c.id === "wings") {
      ok(`d [${c.id}] "raised" on a style with wings draws exactly what absent draws`, lines(got.raised) === lines(A), `${got.raised.recs.length} vs ${A.recs.length} meshes`);
      continue;
    }

    // b / c ── raised moves the building together ────────────────────────────────────────────
    for (const [v, lift] of [["raised", 3.5 / 12], ["raised55", 5.5 / 12]]) {
      const B = got[v];
      if (!B) continue;
      const tag = `${c.id} ${v === "raised" ? "2x4" : "2x6"}`;
      ok(`b [${tag}] the same meshes are drawn`, B.recs.length === A.recs.length, `${B.recs.length} vs ${A.recs.length}`);
      // The Barn Light at 96 in, within 3 in of the 8 ft PLATE: the dark lamp body and head outside, as on the
      // plate, and never the inside cover plate (#f1f0ea), which measured against the raised shell it became.
      // Before the mesh pairing below, which a lamp turned cover plate breaks (a different mesh count), so a
      // regression says why.
      const barn = (g) => g.recs.filter((m) => m.elec === "e-wl");
      const dark = (g) => barn(g).filter((m) => m.color === "#2b2f36").length, cover = (g) => barn(g).filter((m) => m.color === "#f1f0ea").length;
      ok(`b [${tag}] the Barn Light stamped at 96 in is still the lamp outside under the eave, not a cover plate inside`,
        dark(A) > 0 && dark(B) === dark(A) && cover(A) === 0 && cover(B) === 0,
        `lamp parts ${dark(A)} -> ${dark(B)}, inside cover plates ${cover(A)} -> ${cover(B)}`);
      if (B.recs.length !== A.recs.length) continue;
      const kinds = A.recs.map((a, i) => ({ a, b: B.recs[i], ...moved(a, B.recs[i], lift) }));
      const inside = kinds.filter((k) => insideBox(k.a, W, L, ov));
      const outside = kinds.filter((k) => !insideBox(k.a, W, L, ov));
      const odd = inside.filter((k) => k.kind === "other");
      ok(`b [${tag}] every mesh of the building keeps its plan extent and is the same, lifted ${(lift * 12).toFixed(1)} in, or ${(lift * 12).toFixed(1)} in taller`,
        odd.length === 0, odd.slice(0, 4).map((k) => `${k.a.g} ${k.a.geom} ${k.a.color} y ${f4(k.a.min[1])}..${f4(k.a.max[1])} -> ${f4(k.b.min[1])}..${f4(k.b.max[1])}${k.planSame ? "" : " (plan moved)"}`).join(" ; "));
      const roofUp = inside.filter((k) => k.a.g === "roof" && k.a.min[1] >= H - 1.0);
      ok(`b [${tag}] everything of the roof above the walls is lifted exactly ${(lift * 12).toFixed(1)} in`,
        roofUp.length > 0 && roofUp.every((k) => k.kind === "shift"), `${roofUp.filter((k) => k.kind === "shift").length}/${roofUp.length} lifted`);
      const walls = inside.filter((k) => k.a.g === "walls" && k.a.geom === "BoxGeometry" && k.a.min[1] <= 0.5 && k.a.max[1] >= H - 0.6);
      ok(`b [${tag}] every full wall keeps its bottom and its top goes up ${(lift * 12).toFixed(1)} in`,
        walls.length > 0 && walls.every((k) => k.kind === "stretch"), `${walls.filter((k) => k.kind === "stretch").length}/${walls.length} walls`);
      // The Barn Light hangs OUTSIDE under the eave (it moves with the eave), so it is not the inside.
      const inner = kinds.filter((k) => k.a.g === "interior" && k.a.elec !== "e-wl");
      ok(`b [${tag}] the inside does not move: the partition wall, the loft and the ceiling light`,
        inner.length > 0 && inner.every((k) => k.kind === "same") && Math.abs(B.loftElev - A.loftElev) < 1e-9,
        `${inner.filter((k) => k.kind === "same").length}/${inner.length} interior meshes; loft top ${f4(A.loftElev)} -> ${f4(B.loftElev)}`);
      ok(`b [${tag}] the ground does not move`, kinds.filter((k) => k.a.g === "env").every((k) => k.kind === "same"));
      // The seam between the walls and the gable caps: the cap's lowest point against the highest wall
      // top under it, the same gap (or overlap) raised as on the plate.
      const caps = kinds.filter((k) => k.a.g === "roof" && k.a.geom === "ExtrudeGeometry" && insideBox(k.a, W, L, ov));
      const wallTop = (recs) => Math.max(...recs.filter((m) => m.g === "walls" && m.geom === "BoxGeometry").map((m) => m.max[1]));
      const gapA = caps.length ? Math.min(...caps.map((k) => k.a.min[1])) - wallTop(A.recs) : 0;
      const gapB = caps.length ? Math.min(...caps.map((k) => k.b.min[1])) - wallTop(B.recs) : 0;
      ok(`b [${tag}] nothing opens between the wall tops and the gable caps`, Math.abs(gapB - gapA) < 1e-3, `cap - wall top ${f4(gapA)} on the plate, ${f4(gapB)} raised`);
      const moving = outside.filter((k) => k.kind === "other");
      if (moving.length) console.log(`  [${tag}] outside the building, reported only: ${moving.length} mesh(es) moved otherwise (a porch or lean-to roof meeting the wall a rafter higher), e.g. ${moving.slice(0, 2).map((k) => `${k.a.geom} y ${f4(k.a.min[1])}..${f4(k.a.max[1])} -> ${f4(k.b.min[1])}..${f4(k.b.max[1])}`).join(" ; ")}`);
    }

    // e ── the numbers ───────────────────────────────────────────────────────────────────────
    if (c.eave) {
      for (const v of ["absent", "raised", "raised55"]) {
        if (!got[v]) continue;
        const e = eave(got[v].recs, W);
        const lift = v === "absent" ? 0 : v === "raised" ? 3.5 / 12 : 5.5 / 12;
        numbers.push({ c: c.id, v, lift, ...e });
      }
    }
  }

  console.log(`\n  e: a 12 in overhang at 4.8:12, against the WALL PLATE (+ above it, - below it)`);
  console.log(`  framing    seat               deck top edge   deck underside   fascia bottom`);
  for (const n of numbers) {
    const seat = n.v === "absent" ? "on the plate" : n.v === "raised" ? "raised, 2x4 3.5\"" : "raised, 2x6 5.5\"";
    console.log(`  ${(n.c === "ext" ? "extended" : "notched").padEnd(10)} ${seat.padEnd(18)} ${inch(n.deckTop - H).padStart(12)}   ${inch(n.deckUnder - H).padStart(12)}   ${inch(n.finish - H).padStart(12)}`);
  }
  const plateTop = numbers.find((n) => n.c === "notch" && n.v === "absent"), r35 = numbers.find((n) => n.c === "notch" && n.v === "raised"), r55 = numbers.find((n) => n.c === "notch" && n.v === "raised55");
  ok("e on the plate, the deck's top edge ends 2 in below the plate (the 09-19 measurement)", plateTop && Math.abs((plateTop.deckTop - H) * 12 + 2) < 0.1, inch(plateTop && plateTop.deckTop - H));
  ok("e on a 2x4 it ends 1.5 in ABOVE the plate, and its underside is still under it", r35 && Math.abs((r35.deckTop - H) * 12 - 1.5) < 0.1 && r35.deckUnder < H, `${inch(r35 && r35.deckTop - H)}, underside ${inch(r35 && r35.deckUnder - H)}`);
  ok("e on a 2x6 both the top edge and the underside end above the plate", r55 && r55.deckTop > H && r55.deckUnder > H, `${inch(r55 && r55.deckTop - H)}, underside ${inch(r55 && r55.deckUnder - H)}`);
  return numbers;
}

// ── f / g: Settings > Designer > 3D, on the compiled portal ──────────────────────────────────────
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000047", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const P_CONFIG = {
  branding: { companyName: "Acme Sheds", accentColor: "#3D3672", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  buildingStyles: [{ value: "acabin", label: "Acme Cabin", sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }],
    d3: { roof: { type: "gable", pitch: PITCH, overhang: 1.0, eave: "fascia", seat: "raised", rafterDepthIn: 5.5 }, siding: "panel", colors: COLORS, wallHeightFt: H } },
  // Raised on a blank rafter with a lean-to on the LEFT eave, set on the wall half a foot down: the End view
  // stands its wall dimension inside the building, under the main roof's slope.
  { value: "alean", label: "Acme Lean Cabin", sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }],
    d3: { roof: { type: "gable", pitch: PITCH, overhang: 1.0, eave: "fascia", seat: "raised", leanToWidthFt: 6, leanToDropFt: 1, leanToSide: "left", leanToAttach: "wall", leanToAttachFt: 0.5 }, siding: "panel", colors: COLORS, wallHeightFt: H } }],
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
      if (body.action === "catalog") return json(route, { ok: true, aiReady: true, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(`**/${REF}.storage.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  try {
    await page.goto(`${BASE}/portal/settings/designer`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && document.body.innerText.includes("3D Style Calibration"), null, { timeout: 60000 });

    // f, A LEAN-TO ON THE LEFT (review, 2026-10-07): the wall dimension stands inside the building there, and
    // the rafter's words once sat above the shell top, where the main roof's slope ran straight through them.
    // Each word's box against every roof line drawn (the main roof and the lean-to's, the 2 px polylines),
    // sampled along each segment, and against every other word in the drawing.
    await page.getByRole("button", { name: "Acme Lean Cabin", exact: true }).first().click();
    await page.waitForSelector('.ss-cal [data-ss-adv="sections"]', { timeout: 30000 });
    await settle(page, 1200);
    const lean = await page.evaluate(() => {
      const svgs = [...document.querySelectorAll(".ss-cal svg")].filter((s) => [...s.querySelectorAll("text")].some((t) => t.textContent === "wall"));
      const s = svgs.find((x) => x.offsetParent !== null) || svgs[0];
      if (!s) return null;
      s.setAttribute("data-harness-lean", "1");
      const g = s.querySelector("[data-ss-elev-rafter]");
      if (!g) return { rafter: null };
      const bx = (t) => { const b = t.getBBox(); return [b.x, b.y, b.x + b.width, b.y + b.height]; };
      const mine = [...g.querySelectorAll("text")];
      const words = mine.map((t) => ({ t: t.textContent, b: bx(t) }));
      const others = [...s.querySelectorAll("text")].filter((t) => !mine.includes(t)).map((t) => ({ t: t.textContent, b: bx(t) }));
      const lines = [...s.querySelectorAll("polyline")].filter((p) => p.getAttribute("stroke-width") === "2")
        .map((p) => p.getAttribute("points").trim().split(/\s+/).map((q) => q.split(",").map(Number)));
      const inBox = (x, y, b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
      const crossed = words.filter((w) => lines.some((pts) => pts.slice(1).some((p, i) => {
        const a = pts[i];
        for (let k = 0; k <= 200; k++) { const f = k / 200; if (inBox(a[0] + (p[0] - a[0]) * f, a[1] + (p[1] - a[1]) * f, w.b)) return true; }
        return false;
      }))).map((w) => w.t);
      const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
      const touching = words.flatMap((w) => others.filter((o) => overlap(w.b, o.b)).map((o) => `${w.t}/${o.t}`));
      return { rafter: words.map((w) => w.t), crossed, touching, boxes: words.map((w) => w.b.map((v) => Math.round(v * 10) / 10)) };
    });
    ok("f a lean-to on the left: the End view still names the 3.5 in rafter", lean && lean.rafter && lean.rafter.join(" ") === "3.5\" rafter", JSON.stringify(lean));
    ok("f ...and no roof line runs through its words, and they touch no other words", lean && lean.crossed && lean.crossed.length === 0 && lean.touching.length === 0, JSON.stringify(lean));
    const leanSvg = page.locator('svg[data-harness-lean="1"]');
    if (await leanSvg.count()) { await leanSvg.scrollIntoViewIfNeeded(); await leanSvg.screenshot({ path: join(SHOTS, "end-view-lean-left-raised.png") }); }

    await page.getByRole("button", { name: "Acme Cabin", exact: true }).first().click();
    await page.waitForSelector('.ss-cal [data-ss-adv="sections"]', { timeout: 30000 });
    await settle(page, 1200);
    const seg = (name) => page.getByRole("group", { name: "Roof on the wall", exact: true }).getByRole("button", { name, exact: true });
    const box = page.getByRole("spinbutton", { name: "Rafter height", exact: true });
    // The End view: the svg with the "wall" dimension, and its rafter group.
    const endView = () => page.evaluate(() => {
      const svgs = [...document.querySelectorAll(".ss-cal svg")].filter((s) => [...s.querySelectorAll("text")].some((t) => t.textContent === "wall"));
      const s = svgs.find((x) => x.offsetParent !== null) || svgs[0];
      if (!s) return null;
      const texts = [...s.querySelectorAll("text")].map((t) => t.textContent);
      const wallAt = texts.indexOf("wall");
      const g = s.querySelector("[data-ss-elev-rafter]");
      return { wall: wallAt > 0 ? texts[wallAt - 1] : null, rafter: g ? [...g.querySelectorAll("text")].map((t) => t.textContent) : null, dashed: g ? !!g.querySelector("line[stroke-dasharray]") : false };
    });

    // The stored style: raised on a 2x6.
    await seg("Raised by the rafter height").scrollIntoViewIfNeeded();
    ok("g the choice opens on what the style stores: Raised by the rafter height", (await seg("Raised by the rafter height").getAttribute("aria-pressed")) === "true");
    ok("g the rafter box shows the stored 5.5, with the 2x4 / 2x6 / 2x8 chips", (await box.inputValue()) === "5.5"
      && (await page.getByRole("group", { name: "Rafter sizes", exact: true }).getByRole("button").count()) === 3);
    let ev = await endView();
    ok("f the End view's wall dimension still reads the PLATE (8' 0\")", ev && ev.wall === "8' 0\"", JSON.stringify(ev));
    ok("f ...and it names the 5.5 in rafter, over a dashed plate line", ev && ev.rafter && ev.rafter.join(" ") === "5.5\" rafter" && ev.dashed, JSON.stringify(ev));
    await page.locator('[data-ss-adv-f="seat"]').scrollIntoViewIfNeeded();
    await settle(page, 300);
    await page.screenshot({ path: join(SHOTS, "setup-control-raised-2x6.png"), fullPage: false });

    // A blank box: the rafter key goes, the drawing is a 2x4.
    await box.click();
    await box.fill("");
    await page.keyboard.press("Tab");
    await settle(page, 400);
    ev = await endView();
    ok("f a blank rafter box draws a 2x4: the End view says 3.5\"", ev && ev.rafter && ev.rafter[0] === "3.5\"", JSON.stringify(ev));
    let n0 = saves.length;
    await page.getByRole("button", { name: /^Save 3D look$/ }).click();
    for (let i = 0; i < 60 && saves.length === n0; i++) await settle(page, 100);
    let sv = saves[n0];
    ok("g Save with a blank rafter box sends seat \"raised\" and NO rafterDepthIn", !!sv && sv.d3 && sv.d3.roof.seat === "raised" && !("rafterDepthIn" in sv.d3.roof), JSON.stringify(sv && sv.d3 && sv.d3.roof));

    // "On the plate": the key goes, and so does the rafter dimension.
    await seg("On the plate").click();
    await settle(page, 400);
    ev = await endView();
    ok("f on the plate the End view draws no rafter dimension, and the wall still reads 8' 0\"", ev && ev.rafter === null && ev.wall === "8' 0\"", JSON.stringify(ev));
    ok("g the rafter box is gone on the plate", (await box.count()) === 0);
    n0 = saves.length;
    await page.getByRole("button", { name: /^Save 3D look$/ }).click();
    for (let i = 0; i < 60 && saves.length === n0; i++) await settle(page, 100);
    sv = saves[n0];
    ok("g Save on the plate sends NO seat key at all", !!sv && sv.d3 && !("seat" in sv.d3.roof), JSON.stringify(sv && sv.d3 && sv.d3.roof));
    await page.locator('[data-ss-adv-f="seat"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, "setup-control-on-plate.png"), fullPage: false });

    // Raised again on a blank box, then wings: greyed, with the reason.
    await seg("Raised by the rafter height").click();
    await settle(page, 300);
    ok("g raised again, the box comes back blank, a 2x4", (await box.count()) === 1 && (await box.inputValue()) === "");
    await page.locator('[data-ss-adv-sec="wings"]').first().click();
    await settle(page, 300);
    const sw = page.locator("[data-ss-adv-panel] .ss-adv-panel > button.ssd-tool").first();
    if ((await sw.getAttribute("aria-pressed")) !== "true") await sw.click();
    await settle(page, 600);
    const dis = await Promise.all(["On the plate", "Raised by the rafter height"].map(async (n) => [await seg(n).isDisabled(), await seg(n).getAttribute("title")]));
    ok("g with wings both choices are greyed, saying \"Not with wings\"", dis.every(([d, t]) => d && t === "Not with wings"), JSON.stringify(dis));
    ok("g ...and it shows the roof on the plate, which is what the 3D draws", (await seg("On the plate").getAttribute("aria-pressed")) === "true");
    ev = await endView();
    ok("f with wings the End view draws no rafter", ev && ev.rafter === null, JSON.stringify(ev));
    await page.locator('[data-ss-adv-f="seat"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, "setup-control-wings.png"), fullPage: false });
    // Without seatAware the server keeps a stored pair the roof left out (carryForwardRoofSeat), and "On the
    // plate" or a blank box would not land.
    ok("g every portal save says seatAware: true", saves.length >= 2 && saves.every((s) => s.seatAware === true), JSON.stringify(saves.map((s) => s.seatAware)));
    ok("f/g no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  } finally {
    await ctx.close();
  }
}

// ── g, the operator's grid: the public ?admin=1 calibration panel (the amber grid) ─────────────────────
async function partGrid(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const G_ROOF = { type: "gable", pitch: PITCH, overhang: 1.0, eave: "fascia" };
  const G_CONFIG = { ...CONFIG, buildingStyles: [{ value: "gcabin", label: "Acme Grid Cabin", img: null, sizes: ["12x16"], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3(G_ROOF) }],
    sizePricing: { gcabin: { "12x16": { widthFt: 12, lengthFt: 16, basePrice: 9000 } } }, defaultSizes: ["12x16"] };
  const calls = await stubSupabase(page, { config: G_CONFIG, fixtures: FIXTURES });
  const saves = () => calls.filter((c) => c.path && c.path.endsWith("/functions/v1/admin-save-settings") && c.body && c.body.action === "save_style_d3");
  const save = async () => {
    const before = saves().length;
    await page.getByRole("button", { name: "Save to config" }).click();
    for (let i = 0; i < 150 && saves().length === before; i++) await settle(page, 100);
    const s = saves();
    return s.length > before ? s[s.length - 1].body.d3 : null;
  };
  try {
    await page.goto(`${BASE}/?client=${CLIENT}&admin=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
    await page.getByPlaceholder("Admin password").fill("harness");
    await page.getByRole("button", { name: "Acme Grid Cabin", exact: true }).first().click();
    const seat = page.locator('select[data-ss-roof-seat="seat"]');
    await seat.waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 400);
    let d3 = await save();
    ok("g grid: a style saved untouched sends exactly the roof it stored, no seat", !!d3 && JSON.stringify(d3.roof) === JSON.stringify(G_ROOF), JSON.stringify(d3 && d3.roof));
    ok("g grid: the choice opens on the plate, with no rafter box", (await seat.inputValue()) === "plate" && (await page.locator('[data-ss-roof-seat="rafter"]').count()) === 0);
    await seat.selectOption("raised");
    await settle(page, 400);
    const rafter = page.locator('input[data-ss-roof-seat="rafter"]');
    ok("g grid: raised shows the rafter box, blank (a 2x4)", (await rafter.count()) === 1 && (await rafter.inputValue()) === "");
    await rafter.click(); await rafter.fill("7.25"); await page.keyboard.press("Tab"); await settle(page, 300);
    d3 = await save();
    ok("g grid: Save sends seat raised and the 7.25 in rafter", !!d3 && d3.roof.seat === "raised" && d3.roof.rafterDepthIn === 7.25, JSON.stringify(d3 && d3.roof));
    await rafter.click(); await rafter.fill(""); await page.keyboard.press("Tab"); await settle(page, 300);
    d3 = await save();
    ok("g grid: a cleared rafter box deletes the key", !!d3 && d3.roof.seat === "raised" && !("rafterDepthIn" in d3.roof), JSON.stringify(d3 && d3.roof));
    await seat.selectOption("plate");
    await settle(page, 300);
    d3 = await save();
    ok("g grid: On the plate deletes the seat key", !!d3 && !("seat" in d3.roof) && JSON.stringify(d3.roof) === JSON.stringify(G_ROOF), JSON.stringify(d3 && d3.roof));
    ok("g grid: every save says seatAware: true", saves().length >= 4 && saves().every((c) => c.body.seatAware === true), JSON.stringify(saves().map((c) => c.body.seatAware)));
    ok("g grid: no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  } finally {
    await ctx.close();
  }
}

const { browser, ctx: unused } = await launch({ width: 1280, height: 900 });
await unused.close();
try {
  if (!process.env.SS_ROOFSEAT_ONLY || process.env.SS_ROOFSEAT_ONLY === "designer") await partDesigner(browser);
  if (!process.env.SS_ROOFSEAT_ONLY || process.env.SS_ROOFSEAT_ONLY === "settings") await partSettings(browser);
  if (!process.env.SS_ROOFSEAT_ONLY || process.env.SS_ROOFSEAT_ONLY === "grid") await partGrid(browser);
} catch (e) {
  ok("the run finished", false, String(e && e.stack || e).slice(0, 600));
} finally {
  await browser.close();
}
console.log(`\nshots in ${SHOTS}`);
console.log(failed().length ? `${failed().length} FAILED` : "all checks passed");
process.exit(failed().length ? 1 : 0);
