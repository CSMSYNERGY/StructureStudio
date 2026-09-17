// The PROJECTING PORCH and the PLATE BAND, measured off the scene graph.
//
// A projecting porch (roof.porchOutFt, 2026-09-17) is a deck, posts and a low roof of its own
// standing in front of one gable end; the plate band (roof.plateBand) is a trim board across both
// gable caps at the top of the wall, which that porch roof tucks under. The pure numbers are pinned
// by _shared/_test_stubs/porchGeom_test.ts. This script proves the SHIPPED compiled bundle builds
// them, in the real designer with a hand-written config, through __SS3D_DEBUG (window.__ss3dEngine):
//
//   1. the porch roof group sits in roofGroup; the deck is in root, NOT in roofGroup
//   2. the deck's top is the floor (y 0) and it projects D; the roof sheet reaches D + 0.25..0.45
//      and stays under H - 0.15
//   3. tuck-under: no main-roof mesh reaching into the porch's width past the wall face sits
//      below the porch roof's top
//   4. posts: model.porch.posts of them (3 at 16 ft, 4 on a 20 ft shed wall), all at D, measured
//      postH tall, 6'8" clear or pitch 0.05 flagged short; the header sits on them, under the roof
//      sheet, its ends inside the cheeks
//   5. the frame: the rafters (model.porch.nRaf) hang from the ceiling boards inside the cheeks,
//      the ledger's top is ceilWall + RAF_D on the wall, and a cheek each side runs from the wall
//      to the front board and from the post tops to the ceiling
//   6. no recessed set-back: the porch-end wall spans the footprint, flush with it
//   7. the ground label on the porch wall stands more than D + 2 out
//   8. a ramp on the porch wall starts at the deck's edge; a flood light there hangs under the
//      porch ceiling (ceilWall - 0.45)
//   9. the porch roof sheet shares the main roof's material (metal: with its sky); posts take
//      colors.wood, else the natural fallback
//  10. the plate band: 2 meshes with the porch (whose high edge is exactly H - 0.2), 1 on a recessed
//      porch's building (none on its porch end), and neither kind of porch group there. Where the
//      main roof pushes the porch roof lower, the band on the porch's end reaches down to it (H)
//  11. porchOutFt 0 draws no porch; look-inside hides the porch roof and keeps the deck
//  12. zero page errors
//
// The porch groups and bands are found by userData.ssPorch, and every member inside them by
// userData.ssPorchPart, never by size or draw order: a 16x24's porch sheet is as big as a main roof
// slab, and a member looked up by its size vanishes from the checks the moment it is built wrong.
//
//   python -m http.server 8125 --bind 127.0.0.1                  (repo root)
//   node tests/harness/porchProbe.mjs                            (SS_SHOTS=<dir> for the PNGs)
//   SS_CASES=A,E node tests/harness/porchProbe.mjs               (a subset)
//
// Exit 0 = every assertion held.
import { pathToFileURL } from "node:url";
import * as LIB from "./lib.mjs";

const { launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir } = LIB;

// The renderer's natural lumber when a style sets no colors.wood (D3_COLORS.wood).
const WOOD_FALLBACK = "#c4965a";
const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const COLORS = { body: "#eeebe0", trim: "#686c70", roof: "#5f6266" };
const GAMBREL = { type: "gambrel", pitch: 1.2, ridgeOffset: 0, overhang: 0.15, kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1, eave: "fascia" };
// A recessed porch with a king-post truss, as gableProbe's porch fixture has it.
const RECESSED = { type: "gable", pitch: 0.42, overhang: 0.8, eave: "fascia", ridgeOffset: 0, porchEnd: "front", porchTruss: true, porchDepthFt: 6 };

const CASES = [
  { id: "A", label: "Harness Barn", size: "16x24", H: 9, posts: 3, metal: true, wood: "#c4965a", place: true, bands: 2, bandUnderEdge: true,
    d3: { roof: { ...GAMBREL, porchOutFt: 6.5, porchEnd: "front", plateBand: true }, siding: null, colors: { ...COLORS, wood: "#C4965A" }, wallHeightFt: 9, roofMaterial: "metal", foundation: "skids" } },
  // Raw data holding both kinds: the projecting porch wins. Its own wood colour proves colors.wood is read.
  { id: "B", label: "Harness Both Porches", size: "12x24", H: 8, metal: true, wood: "#8b5a2b",
    d3: { roof: { ...RECESSED, porchOutFt: 6 }, siding: "batten", colors: { body: "#4a3327", trim: "#b0a081", roof: "#8a8f94", wood: "#8B5A2B" }, wallHeightFt: 8, roofMaterial: "metal" } },
  { id: "C", label: "Harness Open Eave", size: "14x20", H: 8, metal: false, wood: WOOD_FALLBACK,
    d3: { roof: { type: "gable", pitch: 0.33, overhang: 1, eave: "open", porchOutFt: 6 }, siding: "lap", colors: COLORS, wallHeightFt: 8, roofMaterial: "shingle" } },
  { id: "D", label: "Harness Studio", size: "12x20", H: 8, posts: 4, metal: true, wood: WOOD_FALLBACK,
    d3: { roof: { type: "shed", pitch: 0.25, overhang: 0.6, porchOutFt: 6 }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  { id: "E", label: "Harness Low Barn", size: "12x16", H: 7, metal: true, wood: WOOD_FALLBACK, short: true,
    d3: { roof: { ...GAMBREL, porchOutFt: 6, porchEnd: "back" }, siding: null, colors: COLORS, wallHeightFt: 7, roofMaterial: "metal" } },
  { id: "F", label: "Harness No Porch", size: "16x24", H: 9, off: true,
    d3: { roof: { ...GAMBREL, porchOutFt: 0 }, siding: null, colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "G", label: "Harness Recessed Band", size: "12x32", H: 7.5, off: true, bands: 1,
    d3: { roof: { ...RECESSED, plateBand: true }, siding: "batten", colors: { body: "#4a3327", trim: "#b0a081", roof: "#8a8f94" }, gableVent: { widthFrac: 0.12 }, foundation: "skids", roofMaterial: "metal", wallHeightFt: 7.5 } },
  // A deep overhang's rake pushes the porch roof under H - 0.2, with a plate band: the band on the
  // porch's end must come down to meet it, or bare siding shows between the two.
  { id: "H", label: "Harness Deep Rake", size: "12x16", H: 8, posts: 3, metal: true, wood: WOOD_FALLBACK, bands: 2, bandDrops: true,
    d3: { roof: { type: "gable", pitch: 0.33, overhang: 1, eave: "fascia", porchOutFt: 6, plateBand: true }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
];

const configFor = (c) => {
  const [w, l] = c.size.split("x").map(Number);
  return {
    clientId: "harness-porch",
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "porch", label: c.label, img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: c.d3 }],
    defaultSizes: [c.size],
    sizePricing: { porch: { [c.size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { porch: CLADS }, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    // A standalone flood light, the one exterior lamp the porch caps.
    electrical: null,
    electricalItems: [{ id: "e-flood", icon: "🔦", name: "Flood Light", mount: "wall", withPackage: false, standalone: true, priceWithPackage: null, priceStandalone: 185, heightOffFloorIn: 120 }],
    insulation: [],
  };
};
// One catalog door (the ramp tool needs a door) and the simple ramp.
const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: true, imageUrl: null, showImage: false },
  items: [{ id: "d-walk", name: "Harness Walk Door", price: 300, widthIn: 36, heightIn: 80, category: "door", colorMode: "fixed", planLabel: "WD", sortOrder: 0, imageUrl: null,
    sillIn: null, sillMode: "fixed", opLeft: false, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right", swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false }],
  windowColors: [],
};

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const f3 = (v) => (v == null || !Number.isFinite(Number(v)) ? String(v) : Number(v).toFixed(3));

// A palette tool. The designer's option tabs (ss/designer-options-tabs) hide tools until their tab
// is open, and bring lib.revealTool to open it; without that helper every tool is a plain button.
async function tool(page, name) {
  if (typeof LIB.revealTool === "function") return LIB.revealTool(page, name);
  return page.getByRole("button", { name }).first();
}
// Waits for the tile first: the tiles render only once get_config has answered, which can land
// after the app reports it booted.
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
// Screen point just inside the SOUTH wall, `alongFt` from its west end.
async function southWall(page, W, L, alongFt) {
  const r = await buildingRect(page);
  return svgPoint(page, r.x + alongFt * (r.w / W), r.y + r.h - 0.4 * (r.h / L));
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

// Case A only: a door, its ramp and a flood light on the porch wall (south), placed in 2D.
async function placeOnPorchWall(page, ok, W, L) {
  await (await tool(page, /^Door wall$/)).click();
  await settle(page, 300);
  let p = await southWall(page, W, L, 10.5);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  await page.getByText(FIXTURES.items[0].name, { exact: true }).first().click({ timeout: 10000 });
  await settle(page, 300);
  await page.getByRole("button", { name: "Place door" }).click();
  await settle(page, 600);
  await (await tool(page, /Ramp/)).click();
  await settle(page, 300);
  p = await southWall(page, W, L, 10.5);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  await (await tool(page, /Electrical Items/)).click();
  await settle(page, 300);
  await page.getByText("Flood Light", { exact: true }).first().click({ timeout: 10000 });
  await settle(page, 300);
  p = await southWall(page, W, L, 3);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  if (await page.getByText("Add an electrical item").count()) await page.keyboard.press("Escape");
  const items = (await readItems(page)) || [];
  const door = items.find((i) => i.type === "fixtureDoor");
  const ramp = items.find((i) => i.type === "ramp");
  const flood = items.find((i) => i.electricalItemId === "e-flood");
  ok("A: a door placed on the porch wall (south)", door && door.wall === "south", JSON.stringify(door && { type: door.type, wall: door.wall }));
  ok("A: a ramp on that door", ramp && ramp.wall === "south" && door && ramp.snapDoorId === door.id, JSON.stringify(ramp && { wall: ramp.wall, snap: ramp.snapDoorId }));
  ok("A: a flood light on the porch wall", flood && flood.wall === "south", JSON.stringify(flood && { wall: flood.wall }));
}

// Everything the assertions need, measured in world space in one pass.
async function measure(page, W, L) {
  return page.evaluate(({ W, L }) => {
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
    const tagged = (tag) => { const out = []; M.root.traverse((q) => { if (q.userData && q.userData.ssPorch === tag) out.push(q); }); return out; };
    const under = (q, anc) => { let n = q; while (n) { if (n === anc) return true; n = n.parent; } return false; };
    const hex = (m) => (m && m.color ? "#" + m.color.getHexString() : null);
    const roofs = tagged("roof"), decks = tagged("deck"), bands = tagged("band");
    let wallTop = -Infinity;
    M.wallsGroup.traverse((o) => { if (o.isMesh) wallTop = Math.max(wallTop, bbOf(o).mx[1]); });
    // Feet OUT from the porch wall's footprint line (the gable wall's mid-plane): the renderer's d.
    const outOn = (wall, bb) => ({ south: bb.mx[2] - L / 2, north: -L / 2 - bb.mn[2], east: bb.mx[0] - W / 2, west: -W / 2 - bb.mn[0] })[wall];
    const out = {
      porch: M.porch, H: wallTop, nRoof: roofs.length, nDeck: decks.length,
      roofInRoofGroup: roofs.length > 0 && roofs.every((g) => under(g, M.roofGroup)),
      deckInRoot: decks.length > 0 && decks.every((g) => under(g, M.root)),
      deckInRoofGroup: decks.some((g) => under(g, M.roofGroup)),
      // porchEnd: the band in front of the projecting porch's wall (the far one sits a length behind).
      bands: bands.map((b) => { const bb = bbOf(b); return { isMesh: !!b.isMesh, minY: bb.mn[1], maxY: bb.mx[1], inRoofGroup: under(b, M.roofGroup), porchEnd: !!M.porch && outOn(M.porch.wall, bb) > -1 }; }),
    };
    if (!roofs.length || !decks.length || !M.porch) return out;
    const P = M.porch, pg = roofs[0];
    const outDist = (bb) => outOn(P.wall, bb);
    const nearDist = (bb) => ({ south: bb.mn[2] - L / 2, north: -L / 2 - bb.mx[2], east: bb.mn[0] - W / 2, west: -W / 2 - bb.mx[0] })[P.wall];
    const across = (bb) => (P.wall === "south" || P.wall === "north") ? [bb.mn[0], bb.mx[0]] : [bb.mn[2], bb.mx[2]];
    // Every member by its tag, never by its size: a member built the wrong size must still be found.
    const partsOf = (name) => { const a = []; pg.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssPorchPart === name) a.push(q); }); return a; };
    const boxOf = (q) => { const b = bbOf(q); return { minY: b.mn[1], maxY: b.mx[1], near: nearDist(b), out: outDist(b), across: across(b), color: hex(Array.isArray(q.material) ? q.material[0] : q.material) }; };
    const db = bbOf(decks[0]);
    out.deck = { top: db.mx[1], out: outDist(db), visibleChain: true };
    const NAMES = ["slab", "ceiling", "rafter", "header", "post", "cheek", "rake", "board", "drip", "ledger"];
    out.parts = Object.fromEntries(NAMES.map((n) => [n, partsOf(n).map(boxOf)]));
    let untagged = 0;
    pg.traverse((q) => { if (q.isMesh && !(q.userData && q.userData.ssPorchPart)) untagged++; });
    out.untagged = untagged;
    // The sheet.
    const slab = partsOf("slab")[0];
    if (slab) {
      const sb = bbOf(slab);
      out.slab = { top: sb.mx[1], out: outDist(sb), across: across(sb), hasEnv: !!slab.material.envMap };
      // The main roof's slab material: a textured 0.2 ft slab at least as long as the short side
      // (the extrusion runs the long side on a gable, the short one on a shed).
      let mainMat = null;
      M.roofGroup.traverse((q) => {
        if (mainMat || !q.isMesh || under(q, pg)) return;
        const g = q.geometry.type === "BoxGeometry" ? q.geometry.parameters : null;
        if (g && Math.abs(g.height - 0.2) < 1e-9 && g.depth >= Math.min(W, L) - 0.01 && q.material && q.material.map) mainMat = q.material;
      });
      out.slabSharesRoofMat = !!mainMat && slab.material === mainMat;
      // Tuck-under: every main-roof mesh (bands included) past the wall face inside the porch's width.
      const clash = [];
      M.roofGroup.traverse((q) => {
        if (!q.isMesh || under(q, pg)) return;
        const b = bbOf(q), o = outDist(b), a = across(b);
        if (o <= 0.16 || a[1] < out.slab.across[0] || a[0] > out.slab.across[1]) return;
        if (b.mn[1] < 1) return;                   // corner boards stand on the ground beside the wall
        if (b.mn[1] < out.slab.top - 0.005) clash.push({ geom: q.geometry.type, minY: +b.mn[1].toFixed(3), out: +o.toFixed(3) });
      });
      out.clash = clash;
    }
    out.posts = out.parts.post;
    const hdr = out.parts.header[0];
    if (hdr) out.hdrU = Math.max(Math.abs(hdr.across[0]), Math.abs(hdr.across[1]));
    const wg = M.wallsGroup.children.find((g) => g.userData && g.userData.wall === P.wall);
    if (wg) { const b = bbOf(wg); out.wallAcross = across(b); out.wallOut = outDist(b); }
    // The ground label on the porch wall: an env holder on the wall's axis, beyond the footprint.
    const lbl = M.envGroup.children.find((h) => !h.isMesh && (
      P.wall === "south" ? Math.abs(h.position.x) < 1e-6 && h.position.z > L / 2
        : P.wall === "north" ? Math.abs(h.position.x) < 1e-6 && h.position.z < -L / 2
          : P.wall === "east" ? Math.abs(h.position.z) < 1e-6 && h.position.x > W / 2
            : Math.abs(h.position.z) < 1e-6 && h.position.x < -W / 2));
    out.lblOut = lbl ? ({ south: lbl.position.z - L / 2, north: -L / 2 - lbl.position.z, east: lbl.position.x - W / 2, west: -W / 2 - lbl.position.x })[P.wall] : null;
    // Ramps: interior groups outside the porch wall that are not electrical devices.
    out.ramps = [];
    out.floods = [];
    M.interiorGroup.children.forEach((g) => {
      const b = bbOf(g);
      if (!(outDist(b) > 0.1)) return;
      if (g.userData && g.userData.ssElec) {
        const head = g.children.find((q) => q.isMesh && q.geometry.type === "BoxGeometry" && Math.abs(q.geometry.parameters.width - 0.6) < 1e-9);
        out.floods.push({ topY: b.mx[1], headCtrY: head ? head.getWorldPosition(new V()).y : null });
      } else out.ramps.push({ near: nearDist(b), out: outDist(b) });
    });
    // Look inside: the roof (and the porch roof with it) hides, the deck stays.
    const chainVisible = (q) => { let n = q; while (n) { if (!n.visible) return false; n = n.parent; } return true; };
    E.interior = true; E.applyShellMode(E);
    out.inside = { roofVisible: M.roofGroup.visible, porchRoofVisible: chainVisible(pg), deckVisible: chainVisible(decks[0]) };
    E.interior = false; E.applyShellMode(E);
    return out;
  }, { W, L });
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

async function runCase(ctx, c, ok, shots) {
  const [W, L] = c.size.split("x").map(Number);
  const config = configFor(c);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config, fixtures: FIXTURES });
  const tag = `${c.id} ${c.label} ${c.size}`;
  try {
    await openDesigner(page, config.clientId);
    await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
    await pickStyle(page, c.label);
    await chooseSize(page, c.size);
    if (c.place) await placeOnPorchWall(page, ok, W, L);
    await openEditor(page);
    const m = await measure(page, W, L);
    const P = m.porch;
    ok(`${tag}: wall height read from the scene is ${c.H}`, Math.abs(m.H - c.H) < 0.02, f3(m.H));

    if (c.off) {
      ok(`${tag}: no porch roof or deck groups, and model.porch is null`, m.nRoof === 0 && m.nDeck === 0 && P === null, `roof ${m.nRoof} deck ${m.nDeck} porch ${JSON.stringify(P)}`);
    } else {
      ok(`${tag}: one porch roof group, inside roofGroup`, m.nRoof === 1 && m.roofInRoofGroup, `roof groups ${m.nRoof}`);
      ok(`${tag}: one deck group, reachable from root and NOT inside roofGroup`, m.nDeck === 1 && m.deckInRoot && !m.deckInRoofGroup);
      if (!P || !m.slab) { ok(`${tag}: model.porch and the porch roof sheet exist`, false, JSON.stringify({ porch: !!P, slab: !!m.slab })); return; }
      console.log(`   ${tag}: D ${P.D} wall ${P.wall} pitch ${f3(P.pitch)} yHigh ${f3(P.yHigh)} postH ${f3(P.postH)} ceilWall ${f3(P.ceilWall)} posts ${P.posts} short ${P.short}`);
      ok(`${tag}: the deck's top is the floor (y 0)`, Math.abs(m.deck.top) <= 0.005, f3(m.deck.top));
      ok(`${tag}: the deck projects D`, Math.abs(m.deck.out - P.D) <= 0.02, `out ${f3(m.deck.out)} D ${P.D}`);
      ok(`${tag}: the porch roof reaches D + 0.25..0.45`, m.slab.out > P.D + 0.25 && m.slab.out < P.D + 0.45, f3(m.slab.out));
      ok(`${tag}: the porch roof's top stays under H - 0.15`, m.slab.top < c.H - 0.15, `top ${f3(m.slab.top)} H ${c.H}`);
      ok(`${tag}: tucked under every main-roof mesh past the wall face`, m.clash.length === 0, JSON.stringify(m.clash).slice(0, 240));
      const Z = P.sizes, parts = m.parts, n = (k) => parts[k].length;
      // The porch roof's planes, from the pure numbers: its top, and the ceiling boards' underside.
      const sec = Math.sqrt(1 + P.pitch * P.pitch);
      const yTop = (d) => P.yHigh - P.pitch * (d - P.dWall);
      const yU = (d) => yTop(d) - (Z.PR_T + Z.SHEATH) * sec;
      const dC = P.dEnd - Z.FAS_T;
      ok(`${tag}: every porch member is tagged, and each is there`,
        m.untagged === 0 && n("slab") === 1 && n("ceiling") === 1 && n("header") === 1 && n("rafter") === P.nRaf && n("cheek") === 2 && n("rake") === 2 && n("board") === 1 && n("drip") === 1 && n("ledger") === 1,
        `untagged ${m.untagged} ${Object.entries(parts).map(([k, v]) => `${k} ${v.length}`).join(", ")} (nRaf ${P.nRaf})`);
      ok(`${tag}: post count is model.porch.posts${c.posts ? ` (${c.posts})` : ""}`, m.posts.length === P.posts && (!c.posts || P.posts === c.posts), `posts ${m.posts.length} model ${P.posts}`);
      ok(`${tag}: every post stands at D, from the floor to postH`, m.posts.length > 0 && m.posts.every((q) => Math.abs(q.out - P.D) <= 0.02 && Math.abs(q.minY) < 0.005 && Math.abs(q.maxY - P.postH) < 0.005),
        m.posts.map((q) => `${f3(q.out)}@${f3(q.maxY)}`).join(" "));
      const postTop = m.posts.length ? Math.min(...m.posts.map((q) => q.maxY)) : null;
      if (c.short) ok(`${tag}: a wall too short for 6'8" sits at pitch 0.05 and says short`, P.pitch === 0.05 && P.short === true, `pitch ${P.pitch} short ${P.short}`);
      else ok(`${tag}: 6'8" clear under the header (the drawn posts), or pitch 0.05 flagged short`, (postTop != null && postTop >= 6.66) || (P.pitch === 0.05 && P.short === true), `post tops ${f3(postTop)} pitch ${f3(P.pitch)}`);
      const H0 = parts.header[0];
      ok(`${tag}: the header sits on the posts and meets the ceiling boards (hdrTop)`, !!H0 && Math.abs(H0.minY - P.postH) < 0.005 && Math.abs(H0.maxY - P.hdrTop) < 0.005,
        H0 ? `${f3(H0.minY)}..${f3(H0.maxY)} want ${f3(P.postH)}..${f3(P.hdrTop)}` : "no header");
      ok(`${tag}: ...under the roof sheet's underside at its centre line`, !!H0 && H0.maxY <= yTop((H0.near + H0.out) / 2) - Z.PR_T * sec + 0.001,
        H0 ? `top ${f3(H0.maxY)} sheet underside ${f3(yTop((H0.near + H0.out) / 2) - Z.PR_T * sec)}` : "no header");
      ok(`${tag}: the header's ends stay inside the cheeks`, m.hdrU != null && m.hdrU <= P.side - Z.CHEEK_T + 0.011, `|u| ${f3(m.hdrU)} limit ${f3(P.side - Z.CHEEK_T + 0.011)}`);
      // A rafter lies on the slope, so its box's highest corner is its top inner edge, which sits
      // RAF_D * sin(slope) further out than the box's nearest corner (its bottom inner edge), and
      // its farthest corner is its top outer edge, (PR_T + SHEATH) * sin(slope) short of its end.
      const sinA = P.pitch / sec;
      const rBad = parts.rafter.filter((r) => !(Math.abs(r.maxY - yU(r.near + sinA * Z.RAF_D)) < 0.005 && Math.max(Math.abs(r.across[0]), Math.abs(r.across[1])) <= P.side - Z.CHEEK_T + 0.005
        && Math.abs(r.out + sinA * (Z.PR_T + Z.SHEATH) - dC) < 0.005));
      ok(`${tag}: the rafters hang from the ceiling boards, inside the cheeks, out to the front board`, parts.rafter.length === P.nRaf && rBad.length === 0,
        `rafters ${parts.rafter.length} off ${JSON.stringify(rBad.slice(0, 2).map((r) => ({ top: f3(r.maxY), ceil: f3(yU(r.near + sinA * Z.RAF_D)), u: r.across.map(f3), out: f3(r.out), dC: f3(dC) })))}`);
      const Lg = parts.ledger[0];
      ok(`${tag}: the ledger is on the wall with its top at ceilWall + RAF_D`, !!Lg && Math.abs(Lg.maxY - (P.ceilWall + Z.RAF_D)) < 0.005 && Math.abs(Lg.near) < 0.005,
        Lg ? `top ${f3(Lg.maxY)} want ${f3(P.ceilWall + Z.RAF_D)} near ${f3(Lg.near)}` : "no ledger");
      const ch = [...parts.cheek].sort((a, b) => (a.across[0] + a.across[1]) - (b.across[0] + b.across[1]));
      ok(`${tag}: a cheek each side, wall to front board, post tops to the ceiling, flush with the posts' outer faces`,
        ch.length === 2 && ch.every((q) => Math.abs(q.minY - P.postH) < 0.005 && Math.abs(q.maxY - yU(P.dWall)) < 0.01 && Math.abs(q.near - P.dWall) < 0.005 && Math.abs(q.out - dC) < 0.005 && Math.abs(q.across[1] - q.across[0] - Z.CHEEK_T) < 0.005)
          && Math.abs(Math.abs(ch[0].across[0]) - P.side) < 0.005 && Math.abs(Math.abs(ch[1].across[1]) - P.side) < 0.005,
        ch.map((q) => `y ${f3(q.minY)}..${f3(q.maxY)} d ${f3(q.near)}..${f3(q.out)} u ${q.across.map(f3)}`).join(" | "));
      ok(`${tag}: no recessed set-back: the porch-end wall spans the footprint, flush`,
        m.wallAcross && (m.wallAcross[1] - m.wallAcross[0]) > ((P.wall === "south" || P.wall === "north") ? W : L) - 0.05 && Math.abs(m.wallOut) < 0.3,
        `across ${m.wallAcross && m.wallAcross.map(f3)} out ${f3(m.wallOut)}`);
      if (m.lblOut != null || c.place) ok(`${tag}: the ground label on the porch wall stands more than D + 2 out`, m.lblOut != null && m.lblOut > P.D + 2, f3(m.lblOut));
      ok(`${tag}: the porch roof sheet shares the main roof's material`, m.slabSharesRoofMat);
      if (c.metal) ok(`${tag}: ...and on a metal roof, its sky`, m.slab.hasEnv);
      ok(`${tag}: posts take ${c.d3.colors.wood ? "colors.wood" : "the natural fallback wood"} (${c.wood})`, m.posts.length > 0 && m.posts.every((q) => q.color === c.wood), [...new Set(m.posts.map((q) => q.color))].join(" "));
      ok(`${tag}: look-inside hides the roof and the porch roof, and keeps the deck`, m.inside.roofVisible === false && m.inside.porchRoofVisible === false && m.inside.deckVisible === true, JSON.stringify(m.inside));
      if (c.place) {
        ok(`${tag}: the ramp on the porch wall starts at the deck's edge (D)`, m.ramps.length === 1 && Math.abs(m.ramps[0].near - P.D) <= 0.1, JSON.stringify(m.ramps));
        ok(`${tag}: the flood light hangs under the porch ceiling (head centre <= ceilWall - 0.45)`, m.floods.length === 1 && m.floods[0].headCtrY != null && m.floods[0].headCtrY <= P.ceilWall - 0.45 + 0.001,
          `head ${f3(m.floods[0] && m.floods[0].headCtrY)} cap ${f3(P.ceilWall - 0.45)}`);
        ok(`${tag}: ...and all of it below the ceiling`, m.floods.length === 1 && m.floods[0].topY < P.ceilWall, `top ${f3(m.floods[0] && m.floods[0].topY)} ceilWall ${f3(P.ceilWall)}`);
      }
      if (c.bandUnderEdge) ok(`${tag}: with a plate band the porch roof meets the wall at exactly H - 0.2`, Math.abs(P.yHigh - (c.H - 0.2)) < 1e-9, f3(P.yHigh));
      const out = { south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0] }[P.wall];
      const eye = [out[0] * (W / 2 + P.D + 14) + out[1] * 9, c.H + 3, out[1] * (L / 2 + P.D + 14) - out[0] * 9];
      await shot(page, `${shots}/${c.id}-porch.png`, eye, [out[0] * (W / 2 + P.D / 2), c.H * 0.45, out[1] * (L / 2 + P.D / 2)]);
    }
    if (c.bands != null) {
      ok(`${tag}: ${c.bands} plate band mesh(es), in roofGroup`, m.bands.length === c.bands && m.bands.every((b) => b.isMesh && b.inRoofGroup), `bands ${m.bands.length}`);
      // The top is always H + 0.1. The bottom is H - 0.2, except on a projecting porch's end, where
      // it comes down to the porch roof's high edge when the main roof pushed that edge lower.
      const bandBot = (b) => (b.porchEnd && P ? Math.min(c.H - 0.2, P.yHigh) : c.H - 0.2);
      ok(`${tag}: each band runs H - 0.2 (or the porch roof's high edge, on the porch's end) to H + 0.1`,
        m.bands.length > 0 && m.bands.every((b) => Math.abs(b.minY - bandBot(b)) < 0.005 && Math.abs(b.maxY - (c.H + 0.1)) < 0.005),
        m.bands.map((b) => `${b.porchEnd ? "porch end " : ""}${f3(b.minY)}..${f3(b.maxY)}`).join(" "));
      if (c.bandDrops) {
        const pb = m.bands.filter((b) => b.porchEnd);
        ok(`${tag}: the main roof really pushes the porch roof under H - 0.2 here`, !!P && P.yHigh < c.H - 0.3, P ? `yHigh ${f3(P.yHigh)}` : "no porch");
        ok(`${tag}: the band on the porch's end reaches down to the porch roof: no bare siding between them`, !!P && pb.length === 1 && pb[0].minY <= P.yHigh + 0.005,
          P ? `porch-end bands ${pb.length} bottom ${f3(pb[0] && pb[0].minY)} yHigh ${f3(P.yHigh)}` : "no porch");
      }
    } else ok(`${tag}: no plate band without roof.plateBand`, m.bands.length === 0, `bands ${m.bands.length}`);
    if (c.off && c.bands) await shot(page, `${shots}/${c.id}-band.png`, [W + 6, c.H + 4, -L / 2 - 12], [0, c.H * 0.6, -L / 2]);
    ok(`${tag}: no page errors`, errors.length === 0, JSON.stringify(errors).slice(0, 300));
  } catch (e) {
    ok(`${tag}: ran to the end`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    await page.close();
  }
}

export async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("porchProbe");
  const only = (process.env.SS_CASES || "").split(",").map((s) => s.trim()).filter(Boolean);
  const { browser, ctx } = await launch({ width: 1280, height: 900 });
  try {
    for (const c of CASES) {
      if (only.length && !only.includes(c.id)) continue;
      await runCase(ctx, c, ok, shots);
    }
  } finally {
    await browser.close();
  }
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
  console.log(`shots in ${shots}`);
  return bad.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((n) => process.exit(n ? 1 : 0), (e) => { console.error(e); process.exit(2); });
}
