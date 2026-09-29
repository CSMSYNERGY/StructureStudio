// WINGS — the raised-centre ("monitor") massing, measured off the scene graph.
//
// roof.wingSide / wingWidthFt / wingPitch / centerEaveFt (2026-09-24): a two-storey centre under
// the style's own gable, enclosed single-storey wings down its eave sides, each under its own
// single-slope roof falling away from the centre, the centre's side walls carried up above them.
// The pure numbers are pinned by _shared/_test_stubs/wingsMassing_test.ts. This script proves the
// SHIPPED compiled bundle builds them, in the real designer with a hand-written config, through
// __SS3D_DEBUG (window.__ss3dEngine):
//
//   1. the outer (wing) eave walls top out at H; the gable ends step up to Hc across the centre only
//   2. each clerestory wall runs from just under its wing roof (<= ya) up to Hc, and is ghosted
//      with the other walls in "look inside" (wallMat / battenMat), and nothing can be placed on it
//   3. the centre's roof: its prism peaks at Hc + (Sc/2)*pitch; it sits uc across the span
//   4. each wing: a prism from H up to the clerestory face, a slab whose inner end stops at the
//      clerestory (no wing mesh reaches inside the centre), an eave finish at the OUTER eave, no
//      ridge cap, every member tagged userData.ssWing
//   5. both / left / right put the wings where they say; wingWidthFt 0 builds EXACTLY the building
//      without wing keys (a scene-graph digest, mesh for mesh)
//   6. a centre porch: the clearance scan sees the wing roofs — its roof meets the centre wall just
//      under the wing roof's top, not at the wing's outer eave — and it spans the centre only; in
//      the new frame (roof.front "gable", the Tri Home at 28x20) the ridge runs front to back, the
//      porch stands on the SOUTH wall centred on the centre, 12 ft or porchWidthFt 16, roof and deck
//      measured where they really stand
//   7. doors and windows clamp to the LOCAL top: a 12 ft door on a wing's outer wall stops under H;
//      on the centre it stands to 12 ft; a window sat at 12 ft keeps its sill in the centre and is
//      pulled down under H on a wing's end wall
//   8. zero page errors
//
//   python -m http.server 8125 --bind 127.0.0.1                  (repo root)
//   node tests/harness/wings.mjs                                 (SS_SHOTS=<dir> for the PNGs)
//   SS_WINGS_DIGEST=<file> node tests/harness/wings.mjs          (only write the legacy digests)
//
// Exit 0 = every assertion held.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, buildingRect, BASE, purePorch } from "./lib.mjs";

const PURE = purePorch();

const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const COLORS = { body: "#3d4247", trim: "#2c3035", roof: "#2e3238", wood: "#a8703f" };
const T = 0.3;   // D3.WALL_T
// The Tri Home: 24 across the gable end, 28 deep, 9 ft outer walls, 8 ft wings at 3:12, the centre's
// eave at 17 ft under a 6:12 gable. A portrait footprint, so the gable ends are north/south today.
const TRI = { type: "gable", pitch: 0.5, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 8, wingPitch: 0.25, centerEaveFt: 17 };
const PLAIN = { type: "gable", pitch: 0.5, overhang: 1, eave: "fascia", porchOutFt: 6, porchEnd: "front" };

const CASES = [
  { id: "both", label: "Harness Tri Both", size: "24x28", H: 9, porch: true, place: true,
    d3: { roof: { ...TRI, porchOutFt: 6, porchEnd: "front" }, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "left", label: "Harness Tri Left", size: "24x28", H: 9,
    d3: { roof: { ...TRI, wingSide: "left" }, siding: "lap", colors: COLORS, wallHeightFt: 9, roofMaterial: "shingle" } },
  { id: "right", label: "Harness Tri Right", size: "20x28", H: 8,
    d3: { roof: { ...TRI, wingSide: "right", wingWidthFt: 6, eave: "open", centerEaveFt: 15 }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  { id: "gambrel", label: "Harness Monitor Gambrel", size: "24x32", H: 10,
    d3: { roof: { type: "gambrel", overhang: 0.6, wingSide: "both", wingWidthFt: 7, wingPitch: 0.3 }, siding: "batten", colors: COLORS, wallHeightFt: 10, roofMaterial: "metal" } },
  // A raised centre on a small footprint: the viewer's opening frame must hold all of it.
  { id: "tall", label: "Harness Tall Monitor", size: "12x14", H: 12, frame: true,
    d3: { roof: { type: "gable", pitch: 0.6, overhang: 0.5, wingSide: "both", wingWidthFt: 3, wingPitch: 0.3, centerEaveFt: 21 }, siding: "batten", colors: COLORS, wallHeightFt: 12, roofMaterial: "metal" } },
  // THE TRI HOME IN THE NEW FRAME (the merge of the two renderer branches, 2026-09-24): the front is
  // the centre's gable end (roof.front "gable"), so on a 28x20 the ridge runs along z, front to back,
  // and the wings are west and east. The projecting porch stands on the SOUTH wall in front of the
  // centre only (12 ft), its roof under the wing roofs; with porchWidthFt 16 it is 16 ft wide, still
  // centred on the centre section.
  { id: "trihome", label: "Harness Tri Home Front", size: "28x20", H: 9, porch: true, porchSpan: 12,
    d3: { roof: { type: "gable", front: "gable", pitch: 0.67, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 8, wingPitch: 0.2, centerEaveFt: 15, porchOutFt: 6, porchEnd: "front" }, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "trihome16", label: "Harness Tri Home Wide Porch", size: "28x20", H: 9, porch: true, porchSpan: 16,
    d3: { roof: { type: "gable", front: "gable", pitch: 0.67, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 8, wingPitch: 0.2, centerEaveFt: 15, porchOutFt: 6, porchEnd: "front", porchWidthFt: 16 }, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  // Off by width: must be the plain building, mesh for mesh.
  { id: "off", label: "Harness Tri Off", size: "24x28", H: 9, digestOf: "plain",
    d3: { roof: { ...PLAIN, wingSide: "both", wingWidthFt: 0, wingPitch: 0.25, centerEaveFt: 17 }, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "plain", label: "Harness Tri Plain", size: "24x28", H: 9, digest: true,
    d3: { roof: PLAIN, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
];
// Legacy styles (no wing keys) whose scene-graph digests are compared across bundles by hand:
// SS_WINGS_DIGEST=<file> writes them, run once against the old bundle and once against the new.
const LEGACY = [
  { id: "L1", label: "Legacy Gable", size: "12x16", d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, siding: "batten", colors: COLORS, wallHeightFt: 8 } },
  { id: "L2", label: "Legacy Gambrel Porch", size: "16x24", d3: { roof: { type: "gambrel", overhang: 0.4, porchOutFt: 6.5, plateBand: true }, siding: "lap", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" }, gableVent: true },
  { id: "L3", label: "Legacy Shed", size: "12x8", d3: { roof: { type: "shed", pitch: 0.23, overhang: 0.5, porchOutFt: 4 }, siding: "panel", colors: COLORS, wallHeightFt: 7 } },
  { id: "L4", label: "Legacy Recessed", size: "12x32", d3: { roof: { type: "gable", pitch: 0.42, overhang: 0.8, porchDepthFt: 6, porchTruss: true, porchEnd: "front", leanToWidthFt: 8, leanToSide: "left" }, siding: "batten", colors: COLORS, wallHeightFt: 7.5, gableVent: { widthFrac: 0.12 } } },
  { id: "L5", label: "Legacy Landscape Open", size: "24x14", d3: { roof: { type: "gable", pitch: 0.33, overhang: 1, eave: "open", dormerWidthFt: 6, dormerType: "transom" }, siding: "agpanel", colors: COLORS, wallHeightFt: 12, roofMaterial: "metal" } },
];

const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false },
  items: [
    { id: "d-tall", name: "Harness Tall Door", price: 1, widthIn: 36, heightIn: 144, category: "door", colorMode: "fixed", planLabel: "TD", sortOrder: 0, imageUrl: null,
      sillIn: null, sillMode: "fixed", opLeft: false, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right", swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false },
    { id: "w-high", name: "Harness High Window", price: 1, widthIn: 30, heightIn: 36, category: "window", colorMode: "fixed", planLabel: "HW", sortOrder: 1, imageUrl: null,
      sillIn: 144, sillMode: "fixed" },
  ],
  windowColors: [],
};

const configFor = (c) => {
  const [w, l] = c.size.split("x").map(Number);
  return {
    clientId: "harness-wings",
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "wings", label: c.label, img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: c.d3 }],
    defaultSizes: [c.size],
    sizePricing: { wings: { [c.size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { wings: CLADS }, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
  };
};

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const f3 = (v) => (v == null || !Number.isFinite(Number(v)) ? String(v) : Number(v).toFixed(3));

async function pickStyle(page, label) {
  await page.waitForFunction((lab) => {
    const want = lab.trim().toLowerCase();
    return [...document.querySelectorAll("div,span,p,strong,b")]
      .some((e) => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === want && e.offsetParent);
  }, label, { timeout: 30000 }).catch(() => {});
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
async function chooseSize(page, size) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: size }) });
  if (await sel.count()) await sel.first().selectOption({ label: size });
  const l = Number(size.split("x")[1]);
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), l, { timeout: 15000 });
  await settle(page, 600);
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

// A canonical, order-independent digest of everything drawn: per group, every mesh's world bbox
// (rounded to 1/1000 ft) and its material colour. Two builds with equal digests drew the same thing.
async function digest(page) {
  return page.evaluate(() => {
    const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const r3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);
    const out = [];
    [["roof", M.roofGroup], ["walls", M.wallsGroup], ["open", M.openingsGroup], ["interior", M.interiorGroup]].forEach(([name, grp]) => {
      grp.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox;
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
          const v = new V(x, y, z).applyMatrix4(o.matrixWorld);
          [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
        }
        const m = Array.isArray(o.material) ? o.material.map((q) => q.color && q.color.getHexString()).join("/") : (o.material && o.material.color && o.material.color.getHexString());
        out.push(`${name} ${o.geometry.type} ${mn.map(r3).join(",")} ${mx.map(r3).join(",")} ${m}`);
      });
    });
    return out.sort();
  });
}

async function measure(page, W, L) {
  return page.evaluate(({ W, L, T }) => {
    const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const bbOf = (o) => {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      o.traverse((q) => {
        if (!q.isMesh || !q.geometry) return;
        if (!q.geometry.boundingBox) q.geometry.computeBoundingBox();
        const b = q.geometry.boundingBox;
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
          const v = new V(x, y, z).applyMatrix4(q.matrixWorld);
          [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
        }
      });
      return { mn, mx };
    };
    const m = M.massing;
    const uOf = (v) => (m.uAxisIsX ? v.x : v.z);
    const out = { massing: JSON.parse(JSON.stringify(m)), walls: {}, clerestory: [], wing: { n: 0, nearestCentre: Infinity, maxY: -Infinity, byKind: {}, posts: [] }, porch: M.porch };
    M.wallsGroup.children.forEach((g) => {
      const b = bbOf(g);
      const mats = new Set();
      g.traverse((q) => { if (q.isMesh) mats.add(q.material === M.wallMat ? "wall" : q.material === M.battenMat ? "batten" : "other"); });
      if (g.userData && g.userData.wall) out.walls[g.userData.wall] = { minY: b.mn[1], maxY: b.mx[1] };
      else if (g.userData && g.userData.clerestory) out.clerestory.push({ side: g.userData.clerestory, minY: b.mn[1], maxY: b.mx[1], mats: [...mats], uMin: m.uAxisIsX ? b.mn[0] : b.mn[2], uMax: m.uAxisIsX ? b.mx[0] : b.mx[2] });
    });
    // The centre's prism: rg's one ExtrudeGeometry that is neither a wing nor a porch member.
    let centre = null;
    M.roofGroup.traverse((q) => {
      if (!q.isMesh || !q.geometry) return;
      const ud = q.userData || {};
      if (ud.ssWing) {
        // The clerestory's corner boards stand in roofGroup itself, on the corner, up to Hc.
        if (q.parent === M.roofGroup) { const b = bbOf(q); out.wing.posts.push({ minY: b.mn[1], maxY: b.mx[1] }); return; }
        out.wing.n++;
        const b = bbOf(q);
        // How close to the centre's middle any wing member reaches, in u. The clerestory's INNER face
        // is at Sc/2 - T/2 from it; nothing of a wing may cross that.
        const lo = uOf({ x: b.mn[0], z: b.mn[2] }) - m.uc, hi = uOf({ x: b.mx[0], z: b.mx[2] }) - m.uc;
        const near = lo <= 0 && hi >= 0 ? 0 : Math.min(Math.abs(lo), Math.abs(hi));
        if (near < out.wing.nearestCentre) out.wing.nearestWho = { type: q.geometry.type, params: q.geometry.parameters ? JSON.stringify(q.geometry.parameters).slice(0, 120) : null, mn: b.mn, mx: b.mx, trim: q.material === M.trimMat };
        out.wing.nearestCentre = Math.min(out.wing.nearestCentre, near);
        const kind = q.geometry.type + (q.material === M.trimMat ? ":trim" : "");
        out.wing.byKind[kind] = (out.wing.byKind[kind] || 0) + 1;
        out.wing.maxY = Math.max(out.wing.maxY, b.mx[1]);
        return;
      }
      if (q.geometry.type === "ExtrudeGeometry" && !ud.ssPorchPart && Array.isArray(q.material)) {
        const b = bbOf(q);
        if (!centre || b.mx[1] > centre.maxY) centre = { maxY: b.mx[1], minY: b.mn[1], uMid: (uOf({ x: b.mn[0], z: b.mn[2] }) + uOf({ x: b.mx[0], z: b.mx[2] })) / 2 };
      }
    });
    out.centre = centre;
    // Wing prisms, one per wing.
    out.wingPrisms = [];
    M.roofGroup.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssWing && q.geometry.type === "ExtrudeGeometry") { const b = bbOf(q); out.wingPrisms.push({ side: q.userData.ssWing, minY: b.mn[1], maxY: b.mx[1] }); } });
    // Openings, by the item they belong to.
    out.openings = M.openingsGroup.children.filter((g) => g.userData && g.userData.itemId != null).map((g) => { const b = bbOf(g); return { id: g.userData.itemId, wall: g.userData.wall, minY: b.mn[1], maxY: b.mx[1] }; });
    // The projecting porch's roof members and its deck, where they really stand in the world.
    const porchBox = (grp) => {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      grp.traverse((q) => {
        if (!q.isMesh || !q.userData || !q.userData.ssPorchPart) return;
        const b = bbOf(q);
        for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b.mn[k]); mx[k] = Math.max(mx[k], b.mx[k]); }
      });
      return Number.isFinite(mn[0]) ? { mn, mx } : null;
    };
    out.porchRoof = porchBox(M.roofGroup);
    const deckGrp = M.root.children.find((g) => g.userData && g.userData.ssPorch === "deck");
    out.porchDeck = deckGrp ? porchBox(deckGrp) : null;
    // The viewer's OPENING camera (nothing has moved it yet): every vertex of the roof and the walls
    // projects inside the frame. Not the ground or the sky.
    let worst = 0, worstAt = null, top = -Infinity;
    [M.roofGroup, M.wallsGroup].forEach((g) => g.traverse((q) => {
      if (!q.isMesh || !q.geometry || !q.geometry.attributes.position) return;
      const pos = q.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const w = new V().fromBufferAttribute(pos, i).applyMatrix4(q.matrixWorld);
        top = Math.max(top, w.y);
        const v = w.clone().project(E.camera);
        const e = Math.max(Math.abs(v.x), Math.abs(v.y));
        if (e > worst) { worst = e; worstAt = [w.x, w.y, w.z].map((c) => Math.round(c * 100) / 100); }
      }
    }));
    out.frame = { worst, worstAt, top, camY: E.camera.position.y, targetY: E.controls.target.y, aspect: E.camera.aspect };
    // Look inside: the walls ghost, the roof hides.
    E.interior = true; E.applyShellMode(E);
    out.inside = { roofVisible: M.roofGroup.visible, wallOpacity: M.wallMat.opacity, battenOpacity: M.battenMat.opacity };
    E.interior = false; E.applyShellMode(E);
    return out;
  }, { W, L, T });
}

async function shot(page, path, eye, at) {
  const clip = await page.evaluate(({ eye, at }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(eye[0], eye[1], eye[2]);
    E.controls.target.set(at[0], at[1], at[2]);
    E.camera.lookAt(at[0], at[1], at[2]);
    E.camera.updateProjectionMatrix();
    if (E.controls.update) E.controls.update();
    E.render();
    const c = E.renderer.domElement.getBoundingClientRect();
    return { x: c.x, y: c.y, width: c.width, height: c.height };
  }, { eye, at });
  await settle(page, 250);
  await page.evaluate(() => window.__ss3dEngine.render());
  await page.screenshot({ path, clip });
}

// Place a catalog fixture from the 3D viewer's own path, at a plan point on a wall.
async function place(page, r, fxId, type, wall, alongFt, W, L) {
  const pt = wall === "south" ? { x: r.x + alongFt * (r.w / W), y: r.y + r.h }
    : wall === "north" ? { x: r.x + alongFt * (r.w / W), y: r.y }
      : wall === "east" ? { x: r.x + r.w, y: r.y + alongFt * (r.h / L) } : { x: r.x, y: r.y + alongFt * (r.h / L) };
  const placed = await page.evaluate(({ fxId, type, pt, items }) => {
    const E = window.__ss3dEngine;
    const fx = items.find((f) => f.id === fxId);
    return E.place3Fixture(fx, type, pt.x, pt.y);
  }, { fxId, type, pt, items: FIXTURES.items });
  await settle(page, 900);
  return placed;
}

async function openCase(ctx, c) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: configFor(c), fixtures: FIXTURES });
  await openDesigner(page, "harness-wings");
  await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
  await pickStyle(page, c.label);
  await chooseSize(page, c.size);
  // The plan's building rectangle, read BEFORE the 3D editor covers the plan: placement points are
  // plan coordinates.
  const rect = await buildingRect(page);
  await openEditor(page);
  return { page, errors, rect };
}

async function runCase(ctx, c, ok, shots, digests) {
  const [W, L] = c.size.split("x").map(Number);
  const tag = `${c.id} ${c.size}`;
  const { page, errors, rect } = await openCase(ctx, c);
  try {
    if (c.digest || c.digestOf) digests[c.id] = await digest(page);
    const m = await measure(page, W, L);
    const ms = m.massing, H = c.H;
    if (c.digestOf) {
      ok(`${tag}: wingWidthFt 0 draws no wing and no clerestory`, ms.wings.length === 0 && m.clerestory.length === 0 && m.wing.n === 0, `wings ${ms.wings.length} cl ${m.clerestory.length} tagged ${m.wing.n}`);
      return;
    }
    if (c.digest) return;
    const pitch = c.d3.roof.pitch != null ? c.d3.roof.pitch : null;
    console.log(`   ${tag}: S ${ms.S} Sc ${f3(ms.Sc)} uc ${f3(ms.uc)} Hc ${f3(ms.Hc)} ya ${f3(ms.ya)} wings ${ms.wings.map((g) => g.wall).join("+")}`);
    if (c.frame) ok(`${tag}: the viewer opens with the whole raised building in frame (NDC ${f3(m.frame.worst)})`, m.frame.worst <= 1, JSON.stringify(m.frame));
    const want = { both: ["west", "east"], left: ["west"], right: ["east"], gambrel: ["west", "east"], tall: ["west", "east"], trihome: ["west", "east"], trihome16: ["west", "east"] }[c.id];
    if (c.id.startsWith("trihome")) ok(`${tag}: the front is the centre's gable end, so the ridge runs front to back (along z)`, ms.uAxisIsX === true && ms.S === W && ms.L === L, `uAxisIsX ${ms.uAxisIsX} S ${ms.S} L ${ms.L}`);
    ok(`${tag}: the wings are on ${want.join(" and ")}`, JSON.stringify(ms.wings.map((g) => g.wall)) === JSON.stringify(want), JSON.stringify(ms.wings.map((g) => g.wall)));
    // 1. walls
    for (const g of ms.wings) ok(`${tag}: the ${g.wall} wing's outer wall tops out at H (${H})`, Math.abs(m.walls[g.wall].maxY - H) < 0.01, f3(m.walls[g.wall].maxY));
    for (const wall of ["north", "south"]) ok(`${tag}: the ${wall} gable end steps up to Hc across the centre`, Math.abs(m.walls[wall].maxY - ms.Hc) < 0.01, `${f3(m.walls[wall].maxY)} vs ${f3(ms.Hc)}`);
    const bare = ["west", "east"].filter((w) => !ms.wings.some((g) => g.wall === w));
    for (const wall of bare) ok(`${tag}: the eave side with no wing is the centre's own wall, Hc tall`, Math.abs(m.walls[wall].maxY - ms.Hc) < 0.01, f3(m.walls[wall].maxY));
    // 2. clerestory
    ok(`${tag}: one clerestory wall per wing`, m.clerestory.length === ms.wings.length, String(m.clerestory.length));
    for (const cl of m.clerestory) {
      const g = ms.wings.find((q) => q.side === cl.side);
      ok(`${tag}: the ${g.wall} clerestory runs from under its wing roof (<= ya ${f3(g.ya)}) to Hc`, cl.minY <= g.ya + 1e-6 && cl.minY >= H - 1e-6 && Math.abs(cl.maxY - ms.Hc) < 0.01, `${f3(cl.minY)}..${f3(cl.maxY)}`);
      ok(`${tag}: the ${g.wall} clerestory is clad with the wall materials (ghosts with the walls)`, cl.mats.every((k) => k === "wall" || k === "batten"), cl.mats.join(","));
    }
    // 3. the centre's roof
    const ridge = ms.prof.reduce((a, p) => Math.max(a, p[1]), -Infinity);
    if (pitch != null) ok(`${tag}: the centre ridge is Hc + (Sc/2)*pitch`, Math.abs(ridge - (ms.Hc + (ms.Sc / 2) * pitch)) < 1e-6, `${f3(ridge)} vs ${f3(ms.Hc + (ms.Sc / 2) * pitch)}`);
    ok(`${tag}: the centre's prism peaks at the ridge and stands on Hc`, m.centre && Math.abs(m.centre.maxY - ridge) < 0.01 && Math.abs(m.centre.minY - ms.Hc) < 0.01, JSON.stringify(m.centre));
    ok(`${tag}: the centre sits uc across the span`, m.centre && Math.abs(m.centre.uMid - ms.uc) < 0.01, `${f3(m.centre && m.centre.uMid)} vs ${f3(ms.uc)}`);
    // 4. the wings
    ok(`${tag}: a prism per wing, from H up toward ya`, m.wingPrisms.length === ms.wings.length && m.wingPrisms.every((p) => { const g = ms.wings.find((q) => q.side === p.side); return Math.abs(p.minY - H) < 0.01 && p.maxY < g.ya + 1e-6 && p.maxY > g.ya - 0.2; }), JSON.stringify(m.wingPrisms));
    // A wing's slab and rakes end AT the clerestory's outer face (their lower corners bury a few
    // hundredths in the wall); nothing of a wing crosses the centre wall's line into the centre.
    ok(`${tag}: no wing member crosses the centre wall's line into the centre`, m.wing.nearestCentre >= ms.Sc / 2 - 1e-3 && m.wing.nearestCentre <= ms.Sc / 2 + T / 2 + 1e-3, `${f3(m.wing.nearestCentre)} vs line ${f3(ms.Sc / 2)} ${JSON.stringify(m.wing.nearestWho)}`);
    ok(`${tag}: every wing member is tagged (slab, finish, rakes, prism, flashing, strips)`, m.wing.n >= ms.wings.length * 5, `${m.wing.n} ${JSON.stringify(m.wing.byKind)}`);
    ok(`${tag}: a corner board at both ends of every clerestory, from the wing roof up to Hc`, m.wing.posts.length === 2 * ms.wings.length && m.wing.posts.every((p) => Math.abs(p.maxY - ms.Hc) < 0.01 && p.minY < ms.ya + 0.3 && p.minY > H), JSON.stringify(m.wing.posts));
    const topWing = Math.max(...ms.wings.map((g) => g.ya));
    ok(`${tag}: no wing member stands up at a ridge (no ridge cap on a wing)`, m.wing.maxY < topWing + 0.75, `${f3(m.wing.maxY)} vs ya ${f3(topWing)}`);
    // Look inside
    ok(`${tag}: look inside hides the roof and ghosts the walls, the clerestory with them`, !m.inside.roofVisible && m.inside.wallOpacity < 0.5, JSON.stringify(m.inside));
    // 6. the porch
    if (c.porch) {
      const P = m.porch;
      const ya = Math.max(...ms.wings.map((g) => g.ya));
      ok(`${tag}: a centre porch was built`, !!P, JSON.stringify(P && { yHigh: P.yHigh }));
      if (P) {
        console.log(`   ${tag}: porch yHigh ${f3(P.yHigh)} postH ${f3(P.postH)} side ${f3(P.side)} (ya ${f3(ya)}, H ${H})`);
        // The building's own ceiling over the porch (d3PorchCapFt) and the panel's readout, from the
        // twin (2026-09-24 review): the readout said 14' 10" here while the 3D hung the porch under
        // the wing roofs. Read with the renderer's trim, the ceiling binds exactly; the panel's line
        // (panel trim) is within a fiftieth of a foot, or says "at most" and is never below it.
        const trimR = P.side - P.span / 2;
        const capR = PURE.d3PorchCapFt(c.d3.roof, W, L, H, trimR);
        ok(`${tag}: the porch roof is at or under the building's own ceiling over it (${f3(capR)})`, P.yHigh <= capR + 1e-9, `yHigh ${f3(P.yHigh)}`);
        const RD = PURE.d3PorchReadout(c.d3, c.size);
        ok(`${tag}: the panel's porch readout says what was built (${f3(RD.yHigh)}${RD.atMost ? ", at most" : ""})`, RD.atMost ? P.yHigh <= RD.yHigh + 0.02 : Math.abs(P.yHigh - RD.yHigh) < 0.02, `built ${f3(P.yHigh)}`);
        if (!c.porchSpan || c.porchSpan <= ms.Sc + 1e-6) {
          ok(`${tag}: the porch roof meets the centre wall just under the wing roof, not at the wing's outer eave`, P.yHigh < ya && P.yHigh > ya - 0.6 && P.yHigh > H, `yHigh ${f3(P.yHigh)} ya ${f3(ya)}`);
          ok(`${tag}: the porch spans the centre only`, P.side < ms.Sc / 2 + 0.5, `side ${f3(P.side)} Sc/2 ${f3(ms.Sc / 2)}`);
        } else {
          ok(`${tag}: a porch wider than the centre still meets the wall under the wing roofs`, P.yHigh < ya && P.yHigh > H, `yHigh ${f3(P.yHigh)} ya ${f3(ya)}`);
        }
        if (c.porchSpan) {
          ok(`${tag}: the porch is ${c.porchSpan} ft wide (d3PorchSpan), on the south wall`, Math.abs(P.span - c.porchSpan) < 1e-6 && P.wall === "south" && P.onCap === true, JSON.stringify({ span: P.span, wall: P.wall, onCap: P.onCap, centerU: P.centerU }));
          const R = m.porchRoof, D = m.porchDeck;
          ok(`${tag}: its roof stands out from the SOUTH wall, centred on the centre section`, R && R.mn[2] > L / 2 - 0.2 && Math.abs((R.mn[0] + R.mx[0]) / 2 - ms.uc) < 0.05 && Math.abs((R.mx[0] - R.mn[0]) - (c.porchSpan + 2 * (P.side - c.porchSpan / 2) + 2 * P.sizes.SIDE_OV)) < 0.2, JSON.stringify(R));
          ok(`${tag}: ...and its roof's top is under the wing roofs' top (ya ${f3(ya)})`, R && R.mx[1] < ya, R && f3(R.mx[1]));
          ok(`${tag}: its deck is on the ground in front of the south wall, as wide as the porch`, D && D.mn[2] > L / 2 - 0.2 && Math.abs(D.mx[1]) < 0.05 && Math.abs((D.mx[0] - D.mn[0]) - 2 * P.side) < 0.05 && Math.abs((D.mn[0] + D.mx[0]) / 2 - ms.uc) < 0.05, JSON.stringify(D));
        }
      }
    }
    if (shots) {
      const dz = L / 2 + Math.max(W, L) * 1.1;
      await shot(page, join(shots, `${c.id}-corner.png`), [-W * 1.1, 6, dz], [0, H, 0]);
      await shot(page, join(shots, `${c.id}-front.png`), [0.5, 6, dz + 4], [0, H, 0]);
      await shot(page, join(shots, `${c.id}-back.png`), [W * 0.4, 6, -dz], [0, H, 0]);
    }
    // 7. openings clamp to the local top
    if (c.place) {
      const Hc = ms.Hc;
      const before = new Set(m.openings.map((o) => o.id));
      const placedIds = [];
      const put = async (fx, type, wall, along) => {
        const okPlace = await place(page, rect, fx, type, wall, along, W, L);
        const now = await measure(page, W, L);
        const o = now.openings.find((q) => !before.has(q.id) && !placedIds.includes(q.id));
        if (o) placedIds.push(o.id);
        return { okPlace, o };
      };
      const eastDoor = await put("d-tall", "fixtureDoor", "east", 14);
      ok(`${tag}: a 12 ft door on a wing's outer wall is placed and stops under H`, eastDoor.okPlace && eastDoor.o && eastDoor.o.maxY <= H + 1e-6, JSON.stringify(eastDoor));
      const centreDoor = await put("d-tall", "fixtureDoor", "south", 12);
      ok(`${tag}: the same door on the centre stands to its 12 ft (the centre's top is Hc)`, centreDoor.okPlace && centreDoor.o && centreDoor.o.maxY > 12 && centreDoor.o.maxY <= Hc, JSON.stringify(centreDoor));
      const centreWin = await put("w-high", "window", "north", 12);
      ok(`${tag}: a window sat at 12 ft keeps its sill on the centre`, centreWin.okPlace && centreWin.o && centreWin.o.minY > 11.5 && centreWin.o.maxY <= Hc, JSON.stringify(centreWin));
      const wingWin = await put("w-high", "window", "north", 3);
      ok(`${tag}: ...and is pulled down under H on a wing's end wall`, wingWin.okPlace && wingWin.o && wingWin.o.maxY <= H + 1e-6, JSON.stringify(wingWin));
      if (shots) await shot(page, join(shots, `${c.id}-openings.png`), [W * 0.3, 7, -(L / 2 + 30)], [0, H, 0]);
    }
    ok(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await page.close();
  }
}

// 9. THE CALIBRATION PANEL'S END ELEVATION draws the stepped outline from the same massing: the
// operator page (?admin=1) with a wings style open shows the centre's eave and the wing's pitch,
// and a style without wings still shows the plain drawing.
async function elevationCheck(ctx, ok, shots) {
  const style = (value, label, roof) => ({ value, label, img: null, sizes: ["24x28"], sizeInclusions: {}, sizeInclusionQty: {}, d3: { roof, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } });
  const config = { ...configFor(CASES[0]), buildingStyles: [style("tri", "Harness Tri Elevation", TRI), style("plainel", "Harness Plain Elevation", PLAIN)],
    sizePricing: { tri: { "24x28": { widthFt: 24, lengthFt: 28, basePrice: 1 } }, plainel: { "24x28": { widthFt: 24, lengthFt: 28, basePrice: 1 } } } };
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await stubSupabase(page, { config, fixtures: FIXTURES });
  try {
    await page.goto(`${BASE}/?client=harness-wings&admin=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
    const svgTexts = () => page.evaluate(() => [...document.querySelectorAll("svg")].map((s) => [...s.querySelectorAll("text")].map((t) => t.textContent).join("|")).filter((t) => /span/.test(t)));
    await page.getByRole("button", { name: "Harness Tri Elevation", exact: true }).first().click();
    await settle(page, 1200);
    const tri = await svgTexts();
    ok("the panel's end elevation draws the wings: the centre's eave, the wing's width and pitch", tri.some((t) => /centre eave/.test(t) && /wing, 3:12/.test(t) && /17' 0"/.test(t)), tri.join(" / ").slice(0, 300));
    if (shots) {
      const el = page.locator("svg").filter({ hasText: "centre eave" }).first();
      if (await el.count()) await el.screenshot({ path: join(shots, "elevation-wings.png") });
    }
    await page.getByRole("button", { name: "Harness Plain Elevation", exact: true }).first().click();
    await settle(page, 1200);
    const plain = await svgTexts();
    ok("...and a style without wings keeps the plain drawing", plain.some((t) => /pitch/.test(t)) && !plain.some((t) => /centre eave/.test(t)), plain.join(" / ").slice(0, 300));
    ok("the panel: no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally { await page.close(); }
}

async function runDigests(ctx, file) {
  const out = {};
  for (const c of LEGACY) {
    const { page, errors } = await openCase(ctx, c);
    try {
      out[c.id] = { digest: await digest(page), errors };
      console.log(`digest ${c.id}: ${out[c.id].digest.length} meshes, ${errors.length} errors`);
    } finally { await page.close(); }
  }
  writeFileSync(file, JSON.stringify(out, null, 1));
}

const { browser, ctx } = await launch({ width: 1280, height: 900 });
const { ok, failed } = reporter();
try {
  if (process.env.SS_WINGS_DIGEST) {
    await runDigests(ctx, process.env.SS_WINGS_DIGEST);
  } else {
    const shots = process.env.SS_SHOTS ? shotsDir("wings") : null;
    const digests = {};
    const only = process.env.SS_CASES ? process.env.SS_CASES.split(",") : null;
    for (const c of CASES) {
      if (only && !only.includes(c.id)) continue;
      try { await runCase(ctx, c, ok, shots, digests); } catch (e) { ok(`${c.id}: ran`, false, e && e.message); }
    }
    if (!only || only.includes("elevation")) {
      try { await elevationCheck(ctx, ok, shots); } catch (e) { ok("elevation: ran", false, e && e.message); }
    }
    if (digests.off && digests.plain) {
      const a = digests.off, b = digests.plain;
      const diff = a.filter((x, i) => x !== b[i]);
      ok("wingWidthFt 0 builds EXACTLY the building without wing keys (every mesh)", a.length === b.length && diff.length === 0, `${a.length} vs ${b.length} meshes, ${diff.length} differ: ${diff.slice(0, 2).join(" | ")}`);
    }
  }
} finally {
  await browser.close();
}
const f = failed();
if (!process.env.SS_WINGS_DIGEST) console.log(f.length ? `\n${f.length} check(s) FAILED` : "\nall checks passed");
process.exitCode = f.length ? 1 : 0;
