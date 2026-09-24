// THE NEW FRAME OF REFERENCE (roof.front / roof.highSide, 2026-09-24), measured off the scene graph.
//
// FRONT is the wall you walk up to, the SOUTH wall, W along x. A shed names its HIGH wall
// (roof.highSide) and a gable or gambrel says whether its front is a gable end or an eave wall
// (roof.front). With neither key every building is built by exactly the code it always was; this
// script proves what the keys build, in the real designer against the COMPILED bundle, through
// __SS3D_DEBUG (window.__ss3dEngine):
//
//   1. highSide front on a 16x10: the profile spans the 10 ft depth (model.frame), the tall wall is
//      the SOUTH 16 ft wall, and its top is H + 10 x pitch -- a real clad wall, every batten on it
//      running floor to that top in one piece (no seam at H), in phase with the wall's own origin
//   2. the high eave is FINISHED: a fascia and a level soffit (fascia eave) or rafter tails (open
//      eave) along the high wall, in colors.fascia; the rakes take colors.fascia too
//   3. the porch stands on the south EAVE wall under the high eave: model.porch.wall south, not on a
//      cap, 16 ft wide (or roof.porchWidthFt), its roof meeting the wall at porchAttachFt, its deck at
//      the floor, its posts D out, and nothing of the main roof hanging below its roof over it
//   4. highSide back / left / right put the tall wall on north / west / east, each H + span x pitch
//   5. front "gable" on a 28x20 runs the ridge along z (front to back); front "eave" along x
//   6. corner boards take colors.corner (the tall pair reach up the high wall, under the roof line)
//      and fascia/rakes colors.fascia; absent, both are the trim colour; a live body/trim swatch
//      moves each one by the role its key names (d3TrimKeyRole)
//   7. a porch recessed into an EAVE wall (front "eave") sets that wall back and stands posts along
//      the eave line; no truss
//   8. a projecting porch on a gable end honours porchWidthFt and porchAttachFt, even up in the gable
//   9. the old frame (no key) is untouched: a shed keeps its west porch and has no model.frame
//  10. the building's own ceiling over a porch (d3PorchCapFt, 2026-09-24 review): on a FLUSH roof an
//      attach height above the wall is held under the wall's outline (it floated over the eave, and
//      ran into the main roof on a shed's low wall); every porch sits at or under that ceiling, and
//      the panel's readout (d3PorchReadout) says what was built -- exactly, or "at most" where the
//      main roof reaches out over a gable-end porch
//  11. zero page errors
//
//   python -m http.server 8125 --bind 127.0.0.1                  (repo root)
//   node tests/harness/newFrame.mjs                              (SS_SHOTS=<dir> for the PNGs)
//   SS_CASES=A,E node tests/harness/newFrame.mjs                 (a subset)
//
// Exit 0 = every assertion held.
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, purePorch } from "./lib.mjs";

const PURE = purePorch();

const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
// Farmstand, as the video shows it: brown body and corners, white casings, charcoal fascia and roof.
const FARM_COLORS = { body: "#5a4535", trim: "#ffffff", corner: "#5a4535", fascia: "#2b2f33", roof: "#2b2f33", wood: "#8a5a3c" };
const PLAIN = { body: "#eeebe0", trim: "#686c70", roof: "#5f6266" };
const FARM_ROOF = { type: "shed", highSide: "front", pitch: 0.3, overhang: 1, eave: "fascia", porchOutFt: 5, porchEnd: "front", porchAttachFt: 8 };

const CASES = [
  { id: "A", label: "Frame Farmstand", size: "16x10", H: 7, high: "south", ux: false, tallNeg: false, porch: { wall: "south", onCap: false, span: 16, attach: 8 }, colors: FARM_COLORS, battens: true, eave: "fascia",
    d3: { roof: FARM_ROOF, siding: "batten", colors: FARM_COLORS, wallHeightFt: 7, roofMaterial: "metal" } },
  { id: "A2", label: "Frame Farmstand Open", size: "16x10", H: 7, high: "south", ux: false, tallNeg: false, porch: { wall: "south", onCap: false, span: 10, attach: 8 }, colors: FARM_COLORS, eave: "open",
    d3: { roof: { ...FARM_ROOF, eave: "open", porchWidthFt: 10 }, siding: "batten", colors: FARM_COLORS, wallHeightFt: 7, roofMaterial: "metal" } },
  { id: "B", label: "Frame High Back", size: "16x10", H: 8, high: "north", ux: false, tallNeg: true, porch: { wall: "south", onCap: false, span: 16, underLowEave: true }, colors: PLAIN,
    d3: { roof: { type: "shed", highSide: "back", pitch: 0.3, overhang: 1, eave: "fascia", porchOutFt: 5 }, siding: "lap", colors: PLAIN, wallHeightFt: 8 } },
  { id: "C", label: "Frame High Left", size: "16x10", H: 7, high: "west", ux: true, tallNeg: true, porch: { wall: "south", onCap: true, span: 16 }, colors: PLAIN,
    d3: { roof: { type: "shed", highSide: "left", pitch: 0.3, overhang: 1, eave: "fascia", porchOutFt: 5 }, siding: "panel", colors: PLAIN, wallHeightFt: 7 } },
  { id: "D", label: "Frame High Right", size: "16x10", H: 7, high: "east", ux: true, tallNeg: false, colors: PLAIN, eave: "open",
    d3: { roof: { type: "shed", highSide: "right", pitch: 0.3, overhang: 1, eave: "open" }, siding: "batten", colors: PLAIN, wallHeightFt: 7 } },
  { id: "E", label: "Frame Gable Front", size: "28x20", H: 10, ux: true, ridgeAlong: "z", colors: PLAIN,
    d3: { roof: { type: "gable", front: "gable", pitch: 0.47, overhang: 1 }, siding: "batten", colors: PLAIN, wallHeightFt: 10 } },
  { id: "F", label: "Frame Eave Front", size: "28x20", H: 10, ux: false, ridgeAlong: "x", colors: PLAIN,
    d3: { roof: { type: "gable", front: "eave", pitch: 0.47, overhang: 1 }, siding: "batten", colors: PLAIN, wallHeightFt: 10 } },
  { id: "G", label: "Frame Recessed Eave", size: "24x12", H: 8, ux: false, recessedEave: 4, colors: PLAIN,
    d3: { roof: { type: "gable", front: "eave", pitch: 0.4, overhang: 0.8, porchDepthFt: 4, porchTruss: true }, siding: "batten", colors: PLAIN, wallHeightFt: 8 } },
  // A porch RECESSED into the shed's high wall: that wall sets back and stops at H, and the roof
  // prism's clad face closes the opening over the header up to the high eave.
  { id: "H", label: "Frame Recessed High", size: "16x10", H: 7, ux: false, tallNeg: false, recessedEave: 4, recessedHigh: true, colors: FARM_COLORS,
    d3: { roof: { type: "shed", highSide: "front", pitch: 0.3, overhang: 1, eave: "fascia", porchDepthFt: 4 }, siding: "batten", colors: FARM_COLORS, wallHeightFt: 7 } },
  { id: "K", label: "Frame Gable Porch", size: "28x20", H: 10, ux: true, porch: { wall: "south", onCap: true, span: 12, attach: 9 }, colors: PLAIN,
    d3: { roof: { type: "gable", front: "gable", pitch: 0.47, overhang: 1, porchOutFt: 6, porchWidthFt: 12, porchAttachFt: 9 }, siding: "batten", colors: PLAIN, wallHeightFt: 10 } },
  // Hung up in the GABLE, above the plate: a sized porch is measured by what is really over it, so the
  // rakes at the eave corners, 8 ft to either side, do not hold it down at the plate.
  { id: "K2", label: "Frame Gable Porch High", size: "28x20", H: 10, ux: true, porch: { wall: "south", onCap: true, span: 12, attach: 11.5 }, colors: PLAIN,
    d3: { roof: { type: "gable", front: "gable", pitch: 0.47, overhang: 1, porchOutFt: 6, porchWidthFt: 12, porchAttachFt: 11.5 }, siding: "batten", colors: PLAIN, wallHeightFt: 10 } },
  // A FLUSH roof (overhang 0) with the porch roof asked for ABOVE the wall: nothing reaches past the
  // wall's face for the clearance scan to see, so it used to float 2 ft over the eaves across the whole
  // gable end. Held just under the wall's corners now (d3PorchCapFt), 10 - 0.2.
  { id: "L", label: "Frame Flush Gable Porch", size: "28x20", H: 10, ux: true, porch: { wall: "south", onCap: true, span: 28, capped: 9.8 }, colors: PLAIN,
    d3: { roof: { type: "gable", front: "gable", pitch: 0.5, overhang: 0, porchOutFt: 6, porchAttachFt: 12 }, siding: "panel", colors: PLAIN, wallHeightFt: 10 } },
  // The same on a shed's LOW wall: attach 8.5 on a 7 ft wall ran into the main roof slab.
  { id: "M", label: "Frame Flush Low Porch", size: "16x10", H: 7, ux: false, tallNeg: false, porch: { wall: "north", onCap: false, span: 16, capped: 6.8 }, colors: PLAIN,
    d3: { roof: { type: "shed", highSide: "front", pitch: 0.3, overhang: 0, eave: "fascia", porchOutFt: 5, porchEnd: "back", porchAttachFt: 8.5 }, siding: "panel", colors: PLAIN, wallHeightFt: 7 } },
  // An EAVE-WALL front under a deep overhang: the porch roof hangs under the eave finish (7.27), and
  // the panel said 7' 10" before the readout learned that ceiling.
  { id: "N", label: "Frame Eave Porch", size: "24x14", H: 8, ux: false, porch: { wall: "south", onCap: false, span: 24 }, colors: PLAIN,
    d3: { roof: { type: "gable", front: "eave", pitch: 0.5, overhang: 1.5, porchOutFt: 6 }, siding: "panel", colors: PLAIN, wallHeightFt: 8 } },
  // The control: no key, so today's rule -- a portrait shed's slope runs the long way and its porch
  // takes the WEST short wall (the old Farmstand, 10x16), with no frame.
  { id: "O", label: "Frame Old Shed", size: "10x16", H: 7, old: true, colors: PLAIN,
    d3: { roof: { type: "shed", pitch: 0.3, overhang: 1, porchOutFt: 5 }, siding: "batten", colors: PLAIN, wallHeightFt: 7 } },
];

const configFor = (c) => {
  const [w, l] = c.size.split("x").map(Number);
  return {
    clientId: "harness-frame",
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "frame", label: c.label, img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: c.d3 }],
    defaultSizes: [c.size],
    sizePricing: { frame: { [c.size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { frame: CLADS }, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
  };
};
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const near = (a, b, tol = 0.02) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
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
  await settle(page, 900);
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
  await settle(page, 1200);
}

// Everything the assertions read, in world space, in one pass.
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
    const hex = (m) => { const mm = Array.isArray(m) ? m[0] : m; return mm && mm.color ? "#" + mm.color.getHexString() : null; };
    const under = (q, anc) => { let n = q; while (n) { if (n === anc) return true; n = n.parent; } return false; };
    const out = { frame: M.frame || null, porch: M.porch || null, trimHex: hex(M.trimMat), cornerHex: hex(M.cornerMat), fasciaHex: hex(M.fasciaMat), cornerRole: M.cornerRole, fasciaRole: M.fasciaRole };
    // Each wall group: its top, and the proud strips on it (relief boxes: 0.1 deep, under 0.2 wide).
    out.walls = {};
    M.wallsGroup.children.forEach((g) => {
      const w = g.userData && g.userData.wall;
      if (!w) return;
      const bb = bbOf(g);
      const strips = [];
      g.traverse((q) => {
        if (!q.isMesh || q.geometry.type !== "BoxGeometry") return;
        const pr = q.geometry.parameters;
        if (!(pr.depth <= 0.101 && pr.width <= 0.2)) return;
        const b = bbOf(q);
        strips.push({ y0: b.mn[1], y1: b.mx[1], at: (w === "north" || w === "south") ? (b.mn[0] + b.mx[0]) / 2 + W / 2 : (b.mn[2] + b.mx[2]) / 2 + L / 2 });
      });
      out.walls[w] = { top: bb.mx[1], mn: bb.mn, mx: bb.mx, strips };
    });
    // Tagged members of the roof.
    const tagged = (key) => { const a = []; M.root.traverse((q) => { if (q.isMesh && q.userData && q.userData[key]) a.push(q); }); return a; };
    out.highEave = tagged("ssHighEave").map((q) => ({ kind: q.userData.ssHighEave, ...bbOf(q), color: hex(q.material) }));
    out.recessedEave = tagged("ssRecessedEave").map((q) => ({ kind: q.userData.ssRecessedEave, ...bbOf(q) }));
    // Corner boards: roofGroup's own boxes standing at the four footprint corners.
    out.corners = [];
    out.rakes = [];
    out.ridgeCaps = [];
    M.roofGroup.traverse((q) => {
      if (!q.isMesh || q.geometry.type !== "BoxGeometry") return;
      const pr = q.geometry.parameters;
      if (q.parent === M.roofGroup && Math.abs(Math.abs(q.position.x) - W / 2) < 1e-6 && Math.abs(Math.abs(q.position.z) - L / 2) < 1e-6) {
        const b = bbOf(q);
        out.corners.push({ x: q.position.x, z: q.position.z, top: b.mx[1], bottom: b.mn[1], color: hex(q.material) });
      } else if (Math.abs(pr.height - 0.32) < 1e-9 && Math.abs(pr.depth - 0.1) < 1e-9 && !(q.userData && q.userData.ssPorchPart)) {
        out.rakes.push({ color: hex(q.material) });
      } else if (Math.abs(pr.width - 0.55) < 1e-9 && Math.abs(pr.height - 0.06) < 1e-9) {
        const b = bbOf(q);
        out.ridgeCaps.push({ dx: b.mx[0] - b.mn[0], dz: b.mx[2] - b.mn[2], top: b.mx[1] });
      }
    });
    // The porch, by its members' tags.
    const roofs = []; const decks = [];
    M.root.traverse((q) => { if (q.userData && q.userData.ssPorch === "roof") roofs.push(q); if (q.userData && q.userData.ssPorch === "deck") decks.push(q); });
    if (M.porch && roofs.length) {
      const P = M.porch, pg = roofs[0];
      const partsOf = (name) => { const a = []; pg.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssPorchPart === name) a.push(q); }); return a; };
      const outOn = (bb) => ({ south: bb.mx[2] - L / 2, north: -L / 2 - bb.mn[2], east: bb.mx[0] - W / 2, west: -W / 2 - bb.mn[0] })[P.wall];
      const across = (bb) => (P.wall === "south" || P.wall === "north") ? [bb.mn[0], bb.mx[0]] : [bb.mn[2], bb.mx[2]];
      const dOf = (v) => ({ south: v.z - L / 2, north: -L / 2 - v.z, east: v.x - W / 2, west: -W / 2 - v.x })[P.wall];
      const acrossOf = (v) => ((P.wall === "south" || P.wall === "north") ? v.x : v.z);
      const slab = partsOf("slab")[0];
      const sb = bbOf(slab);
      // The sheet's top where it meets the wall: its highest vertex, all of which sit near the wall.
      out.porchRoof = { top: sb.mx[1], across: across(sb), out: outOn(sb), color: hex(slab.material) };
      const posts = partsOf("post").map((q) => { const b = bbOf(q); return { across: across(b), out: outOn(b), top: b.mx[1], bottom: b.mn[1], color: hex(q.material) }; });
      out.posts = posts;
      out.porchRakes = partsOf("rake").map((q) => hex(q.material));
      out.drips = partsOf("drip").map((q) => hex(q.material));
      const db = bbOf(decks[0]);
      out.deck = { top: db.mx[1], out: outOn(db), across: across(db) };
      // Tuck-under: the lowest point of any main-roof member over the porch sheet's footprint, more
      // than 0.16 ft out from the wall -- its triangles clipped to that footprint, never its box.
      let lowest = Infinity; const who = [];
      M.roofGroup.traverse((q) => {
        if (!q.isMesh || under(q, pg)) return;
        const b = bbOf(q);
        if (b.mn[1] < 1) return;                          // corner boards stand on the ground beside the wall
        // Cladding relief on a gable cap (battens, ribs: 0.1 ft deep, under 0.2 wide) is the WALL the
        // porch roof is flashed against, not roof hanging over it; a porch hung up in the gable has
        // them behind it exactly as a porch under the plate has the wall's own.
        const gp = q.geometry.type === "BoxGeometry" ? q.geometry.parameters : null;
        if (gp && gp.width <= 0.2 && gp.depth <= 0.101) return;
        const pos = q.geometry.attributes.position, idx = q.geometry.index, n = idx ? idx.count : pos.count;
        const inside = [(v) => acrossOf(v) - out.porchRoof.across[0], (v) => out.porchRoof.across[1] - acrossOf(v), (v) => dOf(v) - 0.16];
        for (let t = 0; t + 2 < n; t += 3) {
          let poly = [0, 1, 2].map((k) => new V().fromBufferAttribute(pos, idx ? idx.getX(t + k) : t + k).applyMatrix4(q.matrixWorld));
          for (const f of inside) {
            const next = [];
            poly.forEach((a, i) => {
              const bq = poly[(i + 1) % poly.length], fa = f(a), fb = f(bq);
              if (fa >= 0) next.push(a);
              if ((fa >= 0) !== (fb >= 0)) next.push(a.clone().lerp(bq, fa / (fa - fb)));
            });
            poly = next;
            if (!poly.length) break;
          }
          poly.forEach((v) => { if (v.y < lowest) { lowest = v.y; } });
          if (poly.length && Math.min(...poly.map((v) => v.y)) < out.porchRoof.top - 0.005) who.push(q.geometry.type + ":" + JSON.stringify(q.userData || {}));
        }
      });
      out.overPorchLowest = lowest;
      out.overPorchClash = [...new Set(who)].slice(0, 5);
    }
    return out;
  }, { W, L });
}

// A live swatch: the viewer's own setLiveColors, with hex values standing in for swatch labels.
async function liveRecolour(page, body, trim) {
  return page.evaluate(({ body, trim }) => {
    const E = window.__ss3dEngine, M = E.model;
    E.setLiveColors(body, trim);
    const hex = (m) => (m && m.color ? "#" + m.color.getHexString() : null);
    return { corner: hex(M.cornerMat), fascia: hex(M.fasciaMat), trim: hex(M.trimMat), wall: hex(M.wallMat) };
  }, { body, trim });
}

async function shoot(page, dir, name, eye, at) {
  await page.evaluate(({ eye, at }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(eye[0], eye[1], eye[2]);
    if (E.controls) E.controls.target.set(at[0], at[1], at[2]);
    E.camera.lookAt(at[0], at[1], at[2]);
    E.camera.updateProjectionMatrix();
    E.render();
  }, { eye, at });
  await settle(page, 200);
  const clip = await page.evaluate(() => { const r = window.__ss3dEngine.renderer.domElement.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await page.screenshot({ path: `${dir}/${name}.png`, clip });
}

async function runCase(ctx, c, ok, dir) {
  const [W, L] = c.size.split("x").map(Number);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: configFor(c), fixtures: FIXTURES });
  try {
    await openDesigner(page, "harness-frame");
    await pickStyle(page, c.label);
    await chooseSize(page, c.size);
    await openEditor(page);
    const m = await measure(page, W, L);
    const id = c.id;
    const H = c.H;
    const pitch = c.d3.roof.pitch;

    if (c.old) {
      ok(`${id}: no key, no frame (model.frame absent)`, m.frame == null, JSON.stringify(m.frame));
      ok(`${id}: no key, the shed porch keeps today's WEST wall`, m.porch && m.porch.wall === "west", m.porch && m.porch.wall);
      ok(`${id}: no key, the model.porch carries no new fields`, m.porch && !("span" in m.porch) && !("onCap" in m.porch));
      ok(`${id}: no key, no high-eave finish`, m.highEave.length === 0, String(m.highEave.length));
      ok(`${id}: no key, every wall stops at H`, Object.values(m.walls).every((w) => near(w.top, H, 0.011)), JSON.stringify(Object.fromEntries(Object.entries(m.walls).map(([k, w]) => [k, f3(w.top)]))));
      ok(`${id}: no key, corner boards and fascia are the trim colour`, m.cornerHex === c.colors.trim && m.fasciaHex === c.colors.trim && m.corners.every((k) => k.color === c.colors.trim), `${m.cornerHex} ${m.fasciaHex}`);
    } else {
      ok(`${id}: the new frame is on (model.frame)`, !!m.frame, JSON.stringify(m.frame));
      if (m.frame) ok(`${id}: axes uAxisIsX ${c.ux}${c.tallNeg != null ? ", tallNeg " + c.tallNeg : ""}`,
        m.frame.uAxisIsX === c.ux && (c.tallNeg == null || m.frame.tallNeg === c.tallNeg), `ux ${m.frame.uAxisIsX} tallNeg ${m.frame.tallNeg} S ${m.frame.S} L ${m.frame.L}`);
    }

    // ── the shed's high wall ──
    if (c.high) {
      const S = c.ux ? W : L;
      const topWant = H + S * pitch;
      const tall = m.walls[c.high];
      ok(`${id}: the ${c.high} wall is the tall one, top at H + ${S} x ${pitch} = ${f3(topWant)}`, tall && near(tall.top, topWant, 0.011), tall && f3(tall.top));
      const others = Object.entries(m.walls).filter(([k]) => k !== c.high);
      ok(`${id}: the other three walls stop at H`, others.every(([, w]) => near(w.top, H, 0.011)), others.map(([k, w]) => k + " " + f3(w.top)).join(", "));
      if (m.frame) ok(`${id}: model.frame.tops agrees`, near(m.frame.tops[c.high], topWant, 1e-9), f3(m.frame.tops[c.high]));
      if (c.d3.siding === "batten") {
        const st = tall ? tall.strips : [];
        const full = st.filter((s) => near(s.y0, 0, 0.011) && near(s.y1, topWant, 0.011));
        ok(`${id}: every batten on the tall wall runs floor to its top in one piece (no seam at H)`, st.length > 3 && full.length === st.length, `${full.length}/${st.length}`);
        const step = 1.5;           // clad.stepFt for batten: in phase with the wall origin
        const phased = st.every((s) => Math.abs(s.at / step - Math.round(s.at / step)) < 0.02);
        ok(`${id}: the battens stand on the wall's own 18 in rhythm from its origin`, phased, st.slice(0, 4).map((s) => f3(s.at)).join(" "));
      }
      // The high eave finish, along the high wall.
      if (c.eave === "open") {
        const tails = m.highEave.filter((e) => e.kind === "tail");
        ok(`${id}: open high eave: rafter tails along the high wall`, tails.length >= Math.round((c.ux ? L : W) / 2), String(tails.length));
      } else {
        const fas = m.highEave.find((e) => e.kind === "fascia"), sof = m.highEave.find((e) => e.kind === "soffit");
        ok(`${id}: fascia high eave: a fascia and a level soffit`, !!fas && !!sof, m.highEave.map((e) => e.kind).join(","));
        if (fas && sof) {
          ok(`${id}: the soffit is LEVEL at the top of the high wall`, near(sof.mx[1], topWant - 0.005, 0.01) && near(sof.mx[1] - sof.mn[1], 0.05, 0.005), `${f3(sof.mn[1])}..${f3(sof.mx[1])}`);
          ok(`${id}: the fascia hangs from the slab's end down to the soffit`, near(fas.mn[1], sof.mn[1], 0.01) && fas.mx[1] > topWant + pitch * c.d3.roof.overhang, `${f3(fas.mn[1])}..${f3(fas.mx[1])}`);
          ok(`${id}: high fascia and soffit take the fascia colour`, fas.color === m.fasciaHex && sof.color === m.fasciaHex, `${fas.color} ${sof.color}`);
        }
      }
      // Corner boards: the pair on the tall wall run up it, under the roof line.
      const tallCorners = m.corners.filter((k) => ({ south: k.z > 0, north: k.z < 0, east: k.x > 0, west: k.x < 0 })[c.high]);
      const lowCorners = m.corners.filter((k) => !tallCorners.includes(k));
      ok(`${id}: the two corner boards on the tall wall reach within ${f3(0.3 * pitch + 0.01)} ft of its top`, tallCorners.length === 2 && tallCorners.every((k) => k.top <= topWant + 1e-6 && k.top > topWant - 0.3 * pitch - 0.01), tallCorners.map((k) => f3(k.top)).join(" "));
      ok(`${id}: the other two stop at H`, lowCorners.length === 2 && lowCorners.every((k) => near(k.top, H, 1e-6)), lowCorners.map((k) => f3(k.top)).join(" "));
    }

    // ── gable axes ──
    if (c.ridgeAlong) {
      const caps = m.ridgeCaps;
      const along = caps.length && caps.every((r) => (c.ridgeAlong === "z" ? r.dz > (c.ux ? L : W) && r.dx < 1 : r.dx > W && r.dz < 1));
      ok(`${id}: the ridge runs along ${c.ridgeAlong}`, caps.length === 2 && along, caps.map((r) => `dx ${f3(r.dx)} dz ${f3(r.dz)}`).join("; "));
    }

    // ── colours ──
    if (!c.old) {
      const wantCorner = c.colors.corner || c.colors.trim, wantFascia = c.colors.fascia || c.colors.trim;
      ok(`${id}: corner boards are ${wantCorner}`, m.corners.length === 4 && m.corners.every((k) => k.color === wantCorner), m.corners.map((k) => k.color).join(" "));
      ok(`${id}: rake boards are ${wantFascia}`, m.rakes.length >= 2 && m.rakes.every((r) => r.color === wantFascia), m.rakes.map((r) => r.color).join(" "));
      ok(`${id}: the trim material (casings) keeps the trim colour`, m.trimHex === c.colors.trim, m.trimHex);
    }

    // ── the porch ──
    if (c.porch) {
      const P = m.porch;
      ok(`${id}: porch on the ${c.porch.wall} wall`, P && P.wall === c.porch.wall, P && P.wall);
      if (P && m.frame) ok(`${id}: porch ${c.porch.onCap ? "on a cap end" : "on an EAVE wall"}, ${c.porch.span} ft wide`, P.onCap === c.porch.onCap && near(P.span, c.porch.span, 1e-9), `onCap ${P.onCap} span ${P.span}`);
      if (P && m.porchRoof) {
        if (c.porch.attach != null) ok(`${id}: the porch roof meets the wall at porchAttachFt ${c.porch.attach}`, near(P.yHigh, c.porch.attach, 1e-9) && near(m.porchRoof.top, c.porch.attach, 0.03), `yHigh ${f3(P.yHigh)} sheet top ${f3(m.porchRoof.top)}`);
        if (c.porch.underLowEave) ok(`${id}: on the LOW wall the porch roof tucks under the low eave`, P.yHigh < H - 0.2 + 1e-9, f3(P.yHigh));
        if (c.porch.capped != null) ok(`${id}: a flush roof holds the porch roof under the wall's own outline, at ${c.porch.capped}, not at porchAttachFt ${c.d3.roof.porchAttachFt}`, near(P.yHigh, c.porch.capped, 1e-9) && m.porchRoof.top < c.porch.capped + 0.03, `yHigh ${f3(P.yHigh)} sheet top ${f3(m.porchRoof.top)}`);
        // THE CEILING AND THE READOUT (d3PorchCapFt, d3PorchReadout from the twin): the porch never
        // sits above the ceiling the building sets over it, measured with the renderer's own trim; and
        // the panel's line is what was built, to a fiftieth of a foot (the panel reads it with panel
        // cladding's trim), or, where it says "at most", never below what was built.
        const trimR = P.side - P.span / 2;
        const capR = PURE.d3PorchCapFt(c.d3.roof, W, L, H, trimR);
        ok(`${id}: the porch roof is at or under the building's own ceiling over it (${f3(capR)})`, P.yHigh <= capR + 1e-9, `yHigh ${f3(P.yHigh)}`);
        const RD = PURE.d3PorchReadout(c.d3, c.size);
        ok(`${id}: the panel's porch readout says what was built (${f3(RD.yHigh)}${RD.atMost ? ", at most" : ""})`, RD.atMost ? P.yHigh <= RD.yHigh + 0.02 : Math.abs(P.yHigh - RD.yHigh) < 0.02, `built ${f3(P.yHigh)}`);
        const spanAcross = (a) => a[1] - a[0];
        const posts = m.posts || [];
        const ext = posts.length ? [Math.min(...posts.map((q) => q.across[0])), Math.max(...posts.map((q) => q.across[1]))] : [0, 0];
        ok(`${id}: posts span the porch width (outer faces ${f3(spanAcross(ext))} = span + 2 x trimFace)`, posts.length === P.posts && spanAcross(ext) > c.porch.span && spanAcross(ext) < c.porch.span + 0.6, `${posts.length} posts, ${f3(ext[0])}..${f3(ext[1])}`);
        ok(`${id}: posts stand D out, on the deck, up to the header`, posts.every((q) => near(q.out, P.D, 0.01) && near(q.bottom, 0, 0.005) && near(q.top, P.postH, 0.005)), posts.map((q) => f3(q.out)).join(" "));
        ok(`${id}: the deck is at the floor and projects D`, near(m.deck.top, 0, 0.005) && near(m.deck.out, P.D, 0.01), `top ${f3(m.deck.top)} out ${f3(m.deck.out)}`);
        ok(`${id}: the porch is centred on its wall`, near((ext[0] + ext[1]) / 2, 0, 0.01), f3((ext[0] + ext[1]) / 2));
        ok(`${id}: nothing of the main roof hangs below the porch roof over it`, m.overPorchClash.length === 0 && m.overPorchLowest >= m.porchRoof.top - 0.005, `lowest ${f3(m.overPorchLowest)} vs ${f3(m.porchRoof.top)} ${m.overPorchClash.join(" | ")}`);
        ok(`${id}: porch rake and drip take the fascia colour`, m.porchRakes.length === 2 && m.porchRakes.concat(m.drips).every((h) => h === m.fasciaHex), m.porchRakes.concat(m.drips).join(" "));
        if (c.porch.wall === "south" && !c.porch.onCap && c.high === "south") {
          const fas = m.highEave.find((e) => e.kind === "fascia" || e.kind === "tail");
          ok(`${id}: the porch stands UNDER the high eave: siding shows between its roof and the eave finish`, fas && fas.mn[1] > P.yHigh + 1, fas && `eave bottom ${f3(fas.mn[1])} porch ${f3(P.yHigh)}`);
        }
      }
    }

    // ── a porch recessed into an eave wall ──
    if (c.recessedEave) {
      const s = m.walls.south;
      // Its face (0.15) or its battens (0.23) stand that far out from the set-back line.
      ok(`${id}: the south (eave) wall is set back ${c.recessedEave} ft under the roof`, s && s.mx[2] > L / 2 - c.recessedEave + 0.14 && s.mx[2] < L / 2 - c.recessedEave + 0.27, s && f3(s.mx[2]));
      const posts = m.recessedEave.filter((e) => e.kind === "post"), hdr = m.recessedEave.filter((e) => e.kind === "header");
      ok(`${id}: posts stand along the eave line with a header over them`, posts.length === Math.ceil((c.ux ? L : W) / 10) + 1 && hdr.length === 1 && posts.every((q) => near((q.mn[2] + q.mx[2]) / 2, L / 2 - 0.21, 0.01)), `${posts.length} posts, ${hdr.length} header`);
      if (c.recessedHigh) {
        ok(`${id}: the set-back high wall stops at H, under the roof`, near(s.top, H, 0.011) && m.frame && m.frame.tops.south === H, `${f3(s.top)} frame ${m.frame && m.frame.tops.south}`);
        ok(`${id}: the high eave keeps its finish over the opening`, m.highEave.some((e) => e.kind === "fascia"), m.highEave.map((e) => e.kind).join(","));
      }
    }

    // ── live recolour (Farmstand): the corner follows the body, the fascia (roof role) stays put ──
    if (id === "A") {
      const r = await liveRecolour(page, "#aa0000", "#00aa00");
      ok(`${id}: live body swatch moves the corner boards (their key is the body colour)`, r.corner === "#aa0000" && r.wall === "#aa0000", JSON.stringify(r));
      ok(`${id}: the fascia (the roof's colour) stays put under a trim swatch`, r.fascia === c.colors.fascia && r.trim === "#00aa00", JSON.stringify(r));
    }
    if (id === "C") {
      const r = await liveRecolour(page, "#aa0000", "#00aa00");
      ok(`${id}: absent keys follow the trim swatch live`, r.corner === "#00aa00" && r.fascia === "#00aa00", JSON.stringify(r));
    }

    if (dir) {
      const R = Math.max(W, L);
      await shoot(page, dir, `${id}-front`, [0.2 * R, 6, R * 1.35], [0, H * 0.6, 0]);
      await shoot(page, dir, `${id}-corner`, [R * 1.0, 7, R * 1.0], [0, H * 0.6, 0]);
    }
    ok(`${id}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${c.id}: ran`, false, e && e.message);
  } finally {
    await page.close();
  }
}

const { ok, failed } = reporter();
const only = process.env.SS_CASES ? process.env.SS_CASES.split(",") : null;
const todo = CASES.filter((c) => !only || only.includes(c.id));
const dir = process.env.SS_SHOTS ? shotsDir("newFrame") : null;
const { browser, ctx } = await launch({ width: 1280, height: 900 });
try {
  const N = Number(process.env.SS_CONC || 3);
  const q = todo.slice();
  await Promise.all(Array.from({ length: N }, async () => { while (q.length) await runCase(ctx, q.shift(), ok, dir); }));
} finally {
  await browser.close();
}
const bad = failed();
console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL PASS");
process.exit(bad.length ? 1 : 0);
