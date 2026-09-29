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
//      below the porch roof's top (a lean-to by the part of it over the porch, not by its box)
//   4. posts: model.porch.posts of them (3 at 16 ft, 4 on a 20 ft shed wall), all at D, measured
//      postH tall, 6'8" clear or pitch 0.05 flagged short; the header sits on them, under the roof
//      sheet, its ends inside the cheeks
//   5. the frame: the rafters (model.porch.nRaf) hang from the ceiling boards inside the cheeks,
//      the ledger's top is ceilWall + RAF_D on the wall, and a cheek each side runs from the wall
//      to the front board and from the post tops to the ceiling; no rafter reaches a cheek's inner
//      face (flush, the two faces flickered as grey dots along the cheek)
//   6. the front corners: no cheek past the post's face below the front board (the light block),
//      and the step there is closed in wood from the post top to the board
//   7. no recessed set-back: the porch-end wall spans the footprint, flush with it
//   8. the ground label on the porch wall stands more than D + 2 out
//   9. a ramp on the porch wall starts at the deck's edge; a flood light there hangs under the
//      porch ceiling (ceilWall - 0.45)
//  10. the porch roof sheet shares the main roof's material (metal: with its sky); posts take
//      colors.wood, else the natural fallback
//  11. the plate band: 2 meshes with the porch (whose high edge is exactly H - 0.2), 1 on a recessed
//      porch's building (none on its porch end), and neither kind of porch group there. Where the
//      main roof pushes the porch roof lower, the band on the porch's end reaches down to it (H)
//  12. porchOutFt 0 draws no porch; look-inside hides the porch roof and keeps the deck
//  13. a lean-to on either long side leaves the porch exactly as the same building builds it without
//      one: high edge, pitch, posts and the band on the porch's end (cases I and J against I0)
//  14. the porch wall and the doors on it receive shadows (the porch roof shades them) and no other
//      wall does; without a projecting porch no wall does
//  15. zero page errors
//  16. steps (roof.porchSteps) and a customer's ramp on the porch wall never both show where they
//      overlap: centre steps under a ramp to a centred door are hidden (userData.ssHiddenBy "ramp"),
//      left steps beside it stay; centre steps with no porchPosts take a middle bay (4 posts at 16 ft)
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
import { launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir, revealTool } from "./lib.mjs";

// The renderer's natural lumber when a style sets no colors.wood (D3_COLORS.wood).
const WOOD_FALLBACK = "#c4965a";
const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const COLORS = { body: "#eeebe0", trim: "#686c70", roof: "#5f6266" };
const GAMBREL = { type: "gambrel", pitch: 1.2, ridgeOffset: 0, overhang: 0.15, kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1, eave: "fascia" };
// A recessed porch with a king-post truss, as gableProbe's porch fixture has it.
const RECESSED = { type: "gable", pitch: 0.42, overhang: 0.8, eave: "fascia", ridgeOffset: 0, porchEnd: "front", porchTruss: true, porchDepthFt: 6 };
// The building cases I0, I and J share; I and J add a lean-to.
const LEAN_BASE = { type: "gable", pitch: 0.4, overhang: 0.5, eave: "fascia", porchOutFt: 6.5, porchEnd: "front", plateBand: true };

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
  // A LEAN-TO beside the porch. On a 0.5 ft overhang the lean-to's slab runs past the gable wall and
  // its box starts at the eave wall, inside the porch's width, so a box-based clearance scan read its
  // free edge, 8 to 10 ft out to the side, as hanging over the porch. Only its inner strip is. The
  // porch must build exactly as it does on the same building without a lean-to (I0).
  { id: "I0", label: "Harness Porch Gable", size: "16x24", H: 9, posts: 3, metal: true, wood: WOOD_FALLBACK, bands: 2,
    d3: { roof: LEAN_BASE, siding: "panel", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "I", label: "Harness Lean-To Left", size: "16x24", H: 9, posts: 3, metal: true, wood: WOOD_FALLBACK, bands: 2, sameAs: "I0",
    d3: { roof: { ...LEAN_BASE, leanToWidthFt: 8, leanToDropFt: 1.5, leanToSide: "left" }, siding: "panel", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "J", label: "Harness Lean-To Right", size: "16x24", H: 9, posts: 3, metal: true, wood: WOOD_FALLBACK, bands: 2, sameAs: "I0",
    d3: { roof: { ...LEAN_BASE, leanToWidthFt: 10, leanToDropFt: 3, leanToSide: "right" }, siding: "panel", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  // STEPS AND A RAMP (2026-09-25): case A's building, its door and ramp, and porch steps. K puts the
  // door and ramp in the MIDDLE of the porch wall (8 ft), where its centre steps stand, so the steps
  // are hidden; L keeps them at 10.5 ft with left steps in the left bay, clear of it, and they show.
  // K has no porchPosts, so its centre steps take a middle bay. (No "Ramp" in either label: the ramp
  // tool is found by that word.)
  { id: "K", label: "Harness Steps Centre", size: "16x24", H: 9, posts: 4, metal: true, wood: "#c4965a", place: true, at: 8, bands: 2, steps: "center", stepsHidden: true,
    d3: { roof: { ...GAMBREL, porchOutFt: 6.5, porchEnd: "front", plateBand: true, porchSteps: "center" }, siding: null, colors: { ...COLORS, wood: "#C4965A" }, wallHeightFt: 9, roofMaterial: "metal", foundation: "skids" } },
  { id: "L", label: "Harness Steps Left", size: "16x24", H: 9, posts: 3, metal: true, wood: "#c4965a", place: true, bands: 2, steps: "left", stepsHidden: false,
    d3: { roof: { ...GAMBREL, porchOutFt: 6.5, porchEnd: "front", plateBand: true, porchSteps: "left" }, siding: null, colors: { ...COLORS, wood: "#C4965A" }, wallHeightFt: 9, roofMaterial: "metal", foundation: "skids" } },
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

// Case A only: a door, its ramp and a flood light on the porch wall (south), placed in 2D. `at` is
// how far along the wall the door and ramp go (10.5 ft unless the case says).
async function placeOnPorchWall(page, ok, W, L, at = 10.5) {
  await (await revealTool(page, /^Door wall$/)).click();
  await settle(page, 300);
  let p = await southWall(page, W, L, at);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  await page.getByText(FIXTURES.items[0].name, { exact: true }).first().click({ timeout: 10000 });
  await settle(page, 300);
  await page.getByRole("button", { name: "Place door" }).click();
  await settle(page, 600);
  await (await revealTool(page, /Ramp/)).click();
  await settle(page, 300);
  p = await southWall(page, W, L, at);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  await (await revealTool(page, /Electrical Items/)).click();
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
    const bbOf = (o, skip) => {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      o.traverse((q) => {
        if (!q.isMesh || !q.geometry || (skip && skip(q))) return;
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
    // Shadow receivers among the walls and the openings on them, by wall.
    const recv = { porchWall: 0, porchWallNo: 0, porchOpen: 0, porchOpenNo: 0, other: 0 };
    [[M.wallsGroup, "Wall"], [M.openingsGroup, "Open"]].forEach(([grp, kind]) => grp.children.forEach((g) => g.traverse((q) => {
      if (!q.isMesh) return;
      const onPorch = !!M.porch && g.userData && g.userData.wall === M.porch.wall && !g.userData.gable;
      if (onPorch) recv[`porch${kind}${q.receiveShadow ? "" : "No"}`]++;
      else if (q.receiveShadow) recv.other++;
    })));
    const out = {
      porch: M.porch, H: wallTop, nRoof: roofs.length, nDeck: decks.length, recv,
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
    const dOf = (v) => ({ south: v.z - L / 2, north: -L / 2 - v.z, east: v.x - W / 2, west: -W / 2 - v.x })[P.wall];
    // Every member by its tag, never by its size: a member built the wrong size must still be found.
    const partsOf = (name) => { const a = []; pg.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssPorchPart === name) a.push(q); }); return a; };
    const boxOf = (q) => { const b = bbOf(q); return { minY: b.mn[1], maxY: b.mx[1], near: nearDist(b), out: outDist(b), across: across(b), color: hex(Array.isArray(q.material) ? q.material[0] : q.material) }; };
    // The deck's own box, without its steps (which run out past D by design).
    const inSteps = (q) => { let n = q; while (n) { if (n.userData && n.userData.ssPorchPart === "steps") return true; n = n.parent; } return false; };
    const db = bbOf(decks[0], inSteps);
    const chainShown = (q) => { let n = q; while (n) { if (!n.visible) return false; n = n.parent; } return true; };
    out.steps = [];
    decks[0].traverse((q) => {
      if (!(q.userData && q.userData.ssPorchPart === "steps")) return;
      const b = bbOf(q);
      out.steps.push({ where: q.userData.ssPorchSteps, visible: chainShown(q), hiddenBy: q.userData.ssHiddenBy || null, across: across(b), near: nearDist(b), out: outDist(b) });
    });
    out.deck = { top: db.mx[1], out: outDist(db), visibleChain: true };
    const NAMES = ["slab", "ceiling", "rafter", "header", "post", "cheek", "cornerFill", "rake", "board", "drip", "ledger"];
    out.parts = Object.fromEntries(NAMES.map((n) => [n, partsOf(n).map(boxOf)]));
    let untagged = 0;
    pg.traverse((q) => { if (q.isMesh && !(q.userData && q.userData.ssPorchPart)) untagged++; });
    out.untagged = untagged;
    // THE FRONT CORNERS: every cheek vertex out past the posts' face (d > D) that sits below the
    // front board's bottom. Each one is body-colour cheek showing under the board: the light block.
    const boards = partsOf("board");
    const boardBot = boards.length ? Math.min(...boards.map((q) => bbOf(q).mn[1])) : null;
    out.boardBot = boardBot;
    out.cheekStub = [];
    if (boardBot != null) partsOf("cheek").forEach((q) => {
      const pos = q.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const v = new V(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(q.matrixWorld);
        const d = dOf(v);
        if (d > P.D + 0.005 && v.y < boardBot - 0.005) out.cheekStub.push([+d.toFixed(3), +v.y.toFixed(3)]);
      }
    });
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
      // A lean-to (userData.ssLeanTo) counts by its lowest point OVER that footprint: its triangles
      // clipped to the porch sheet's width and to more than 0.16 ft out. Its box spans the whole slope
      // down to the free edge, which is nowhere near the porch.
      const acrossOf = (v) => ((P.wall === "south" || P.wall === "north") ? v.x : v.z);
      const lowestOver = (q) => {
        const pos = q.geometry.attributes.position, idx = q.geometry.index, n = idx ? idx.count : pos.count;
        const inside = [(v) => acrossOf(v) - out.slab.across[0], (v) => out.slab.across[1] - acrossOf(v), (v) => dOf(v) - 0.16];
        let lo = Infinity;
        for (let t = 0; t + 2 < n; t += 3) {
          let poly = [0, 1, 2].map((k) => new V().fromBufferAttribute(pos, idx ? idx.getX(t + k) : t + k).applyMatrix4(q.matrixWorld));
          for (const f of inside) {
            const next = [];
            poly.forEach((a, i) => {
              const b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
              if (fa >= 0) next.push(a);
              if ((fa >= 0) !== (fb >= 0)) next.push(a.clone().lerp(b, fa / (fa - fb)));
            });
            poly = next;
            if (!poly.length) break;
          }
          poly.forEach((v) => { lo = Math.min(lo, v.y); });
        }
        return lo;
      };
      const clash = [];
      out.leanTo = { n: 0, boxOver: false, lowestOver: null };
      M.roofGroup.traverse((q) => {
        if (!q.isMesh || under(q, pg)) return;
        const lean = !!(q.userData && q.userData.ssLeanTo);
        if (lean) out.leanTo.n++;
        const b = bbOf(q), o = outDist(b), a = across(b);
        if (o <= 0.16 || a[1] < out.slab.across[0] || a[0] > out.slab.across[1]) return;
        if (b.mn[1] < 1) return;                   // corner boards stand on the ground beside the wall
        let lowY = b.mn[1];
        if (lean) {
          lowY = lowestOver(q);
          if (b.mn[1] < out.slab.top - 0.005) out.leanTo.boxOver = true;
          out.leanTo.lowestOver = Math.min(out.leanTo.lowestOver == null ? Infinity : out.leanTo.lowestOver, lowY);
        }
        if (lowY < out.slab.top - 0.005) clash.push({ geom: q.geometry.type, minY: +lowY.toFixed(3), out: +o.toFixed(3), leanTo: lean });
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
      } else out.ramps.push({ near: nearDist(b), out: outDist(b), across: across(b), tagged: !!(g.userData && g.userData.ssRamp) });
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

// seen: what each finished case built, for the cases that must build the same porch (sameAs).
async function runCase(ctx, c, ok, shots, seen) {
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
    if (c.place) await placeOnPorchWall(page, ok, W, L, c.at);
    await openEditor(page);
    const m = await measure(page, W, L);
    const P = m.porch;
    ok(`${tag}: wall height read from the scene is ${c.H}`, Math.abs(m.H - c.H) < 0.02, f3(m.H));

    if (c.off) {
      ok(`${tag}: no porch roof or deck groups, and model.porch is null`, m.nRoof === 0 && m.nDeck === 0 && P === null, `roof ${m.nRoof} deck ${m.nDeck} porch ${JSON.stringify(P)}`);
      ok(`${tag}: ...and no wall receives shadows`, m.recv.other === 0, JSON.stringify(m.recv));
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
      // THE CHEEK STIPPLE. An outer rafter laid flush against a cheek put its face in the cheek's inner
      // plane, and faint grey single-pixel dots ran along both cheeks. Every rafter's across extent must
      // stop short of the nearer (inner) face of the cheeks as they are built, not of a number.
      const cheekInner = ch.length === 2 ? Math.min(...ch.map((q) => Math.min(Math.abs(q.across[0]), Math.abs(q.across[1])))) : null;
      const rafReach = parts.rafter.length ? Math.max(...parts.rafter.map((r) => Math.max(Math.abs(r.across[0]), Math.abs(r.across[1])))) : null;
      ok(`${tag}: no rafter reaches a cheek's inner face (the stipple)`, cheekInner != null && rafReach != null && rafReach <= cheekInner - 0.005,
        `rafters reach |u| ${f3(rafReach)}, cheek inner face |u| ${f3(cheekInner)}`);
      ok(`${tag}: no cheek shows below the front board past the posts' face (the corner block)`, m.boardBot != null && m.cheekStub.length === 0, `board bottom ${f3(m.boardBot)} stub ${JSON.stringify(m.cheekStub.slice(0, 4))}`);
      const fills = parts.cornerFill;
      ok(`${tag}: ...and each front corner is closed in wood from the post top to the board`,
        fills.length === 2 && m.boardBot > P.postH && fills.every((q) => Math.abs(q.minY - P.postH) < 0.005 && Math.abs(q.maxY - m.boardBot) < 0.005 && Math.abs(q.near - P.D) < 0.005 && Math.abs(q.out - dC) < 0.005 && q.color === c.wood),
        fills.map((q) => `y ${f3(q.minY)}..${f3(q.maxY)} d ${f3(q.near)}..${f3(q.out)} ${q.color}`).join(" | "));
      ok(`${tag}: no recessed set-back: the porch-end wall spans the footprint, flush`,
        m.wallAcross && (m.wallAcross[1] - m.wallAcross[0]) > ((P.wall === "south" || P.wall === "north") ? W : L) - 0.05 && Math.abs(m.wallOut) < 0.3,
        `across ${m.wallAcross && m.wallAcross.map(f3)} out ${f3(m.wallOut)}`);
      if (m.lblOut != null || c.place) ok(`${tag}: the ground label on the porch wall stands more than D + 2 out`, m.lblOut != null && m.lblOut > P.D + 2, f3(m.lblOut));
      ok(`${tag}: the porch roof sheet shares the main roof's material`, m.slabSharesRoofMat);
      if (c.metal) ok(`${tag}: ...and on a metal roof, its sky`, m.slab.hasEnv);
      ok(`${tag}: posts take ${c.d3.colors.wood ? "colors.wood" : "the natural fallback wood"} (${c.wood})`, m.posts.length > 0 && m.posts.every((q) => q.color === c.wood), [...new Set(m.posts.map((q) => q.color))].join(" "));
      ok(`${tag}: the porch wall receives the porch roof's shadow, and no other wall does`, m.recv.porchWall > 0 && m.recv.porchWallNo === 0 && m.recv.other === 0, JSON.stringify(m.recv));
      if (c.place) ok(`${tag}: ...and so does the door on it`, m.recv.porchOpen > 0 && m.recv.porchOpenNo === 0, JSON.stringify(m.recv));
      ok(`${tag}: look-inside hides the roof and the porch roof, and keeps the deck`, m.inside.roofVisible === false && m.inside.porchRoofVisible === false && m.inside.deckVisible === true, JSON.stringify(m.inside));
      if (c.place) {
        ok(`${tag}: the ramp on the porch wall starts at the deck's edge (D)`, m.ramps.length === 1 && Math.abs(m.ramps[0].near - P.D) <= 0.1, JSON.stringify(m.ramps));
        ok(`${tag}: the flood light hangs under the porch ceiling (head centre <= ceilWall - 0.45)`, m.floods.length === 1 && m.floods[0].headCtrY != null && m.floods[0].headCtrY <= P.ceilWall - 0.45 + 0.001,
          `head ${f3(m.floods[0] && m.floods[0].headCtrY)} cap ${f3(P.ceilWall - 0.45)}`);
        ok(`${tag}: ...and all of it below the ceiling`, m.floods.length === 1 && m.floods[0].topY < P.ceilWall, `top ${f3(m.floods[0] && m.floods[0].topY)} ceilWall ${f3(P.ceilWall)}`);
      }
      if (c.steps) {
        const st = m.steps[0], rp = m.ramps[0];
        ok(`${tag}: one step group, "${c.steps}"`, m.steps.length === 1 && st.where === c.steps, JSON.stringify(m.steps));
        const overlap = !!(st && rp && rp.across[0] < st.across[1] - 0.01 && rp.across[1] > st.across[0] + 0.01 && rp.near < st.out && rp.out > st.near);
        ok(`${tag}: the ramp ${c.stepsHidden ? "runs over" : "stands clear of"} the ${c.steps} steps`, !!rp && overlap === c.stepsHidden,
          `ramp across ${rp && rp.across.map(f3)} out ${rp && f3(rp.near)}..${rp && f3(rp.out)}, steps across ${st && st.across.map(f3)} out ${st && f3(st.near)}..${st && f3(st.out)}`);
        ok(`${tag}: ⚠️ STEPS AND A RAMP NEVER BOTH SHOW WHERE THEY OVERLAP`, !(overlap && st.visible), JSON.stringify({ overlap, visible: st && st.visible }));
        ok(`${tag}: the steps are ${c.stepsHidden ? "hidden, saying the ramp did it" : "drawn"}`,
          !!st && (c.stepsHidden ? st.visible === false && st.hiddenBy === "ramp" : st.visible === true && st.hiddenBy === null), JSON.stringify(st));
        ok(`${tag}: the ramp is tagged for the check`, !!rp && rp.tagged === true);
        if (c.stepsHidden) {
          // A LIVE DRAG rebuilds the interior alone (model.rebuildInterior), never the porch: the check
          // runs there too, so taking the ramp away brings the steps back, and putting it back hides them.
          const items = (await readItems(page)) || [];
          const shown = (list) => page.evaluate((list) => {
            const M = window.__ss3dEngine.model;
            M.rebuildInterior(list);
            let vis = null;
            M.root.traverse((q) => {
              if (!(q.userData && q.userData.ssPorchPart === "steps")) return;
              let n = q, v = true;
              while (n) { if (!n.visible) v = false; n = n.parent; }
              vis = v;
            });
            return vis;
          }, list);
          ok(`${tag}: a live rebuild without the ramp brings the steps back`, (await shown(items.filter((i) => i.type !== "ramp"))) === true);
          ok(`${tag}: ...and with it, hides them again`, (await shown(items)) === false);
        }
      }
      if (c.bandUnderEdge) ok(`${tag}: with a plate band the porch roof meets the wall at exactly H - 0.2`, Math.abs(P.yHigh - (c.H - 0.2)) < 1e-9, f3(P.yHigh));
      const porchEndBand = m.bands.filter((b) => b.porchEnd);
      seen[c.id] = { yHigh: P.yHigh, pitch: P.pitch, postH: P.postH, posts: P.posts, short: P.short, bandBot: porchEndBand.length === 1 ? porchEndBand[0].minY : null };
      if (c.sameAs) {
        const ref = seen[c.sameAs];
        ok(`${tag}: the lean-to's members are tagged userData.ssLeanTo`, m.leanTo.n >= 3, `tagged ${m.leanTo.n}`);
        ok(`${tag}: ...and its box reaches over the porch below the porch roof's top (what this case tests)`, m.leanTo.boxOver === true, `lowest point over the porch ${f3(m.leanTo.lowestOver)} slab top ${f3(m.slab.top)}`);
        ok(`${tag}: the porch builds exactly as without the lean-to (${c.sameAs}): high edge, pitch, post height, posts, short`,
          !!ref && Math.abs(P.yHigh - ref.yHigh) < 1e-9 && Math.abs(P.pitch - ref.pitch) < 1e-9 && Math.abs(P.postH - ref.postH) < 1e-9 && P.posts === ref.posts && P.short === ref.short,
          ref ? `yHigh ${f3(P.yHigh)}/${f3(ref.yHigh)} pitch ${f3(P.pitch)}/${f3(ref.pitch)} postH ${f3(P.postH)}/${f3(ref.postH)} posts ${P.posts}/${ref.posts} short ${P.short}/${ref.short}` : `${c.sameAs} did not measure`);
        ok(`${tag}: ...and the band on the porch's end comes down no further than without it`,
          !!ref && ref.bandBot != null && seen[c.id].bandBot != null && Math.abs(seen[c.id].bandBot - ref.bandBot) < 0.005,
          ref ? `bottom ${f3(seen[c.id].bandBot)} without ${f3(ref.bandBot)}` : `${c.sameAs} did not measure`);
      }
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
  // A case compared with another (sameAs) brings that one along, ahead of it in CASES.
  CASES.forEach((c) => { if (c.sameAs && only.includes(c.id) && !only.includes(c.sameAs)) only.push(c.sameAs); });
  const seen = {};
  const { browser, ctx } = await launch({ width: 1280, height: 900 });
  try {
    for (const c of CASES) {
      if (only.length && !only.includes(c.id)) continue;
      await runCase(ctx, c, ok, shots, seen);
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
