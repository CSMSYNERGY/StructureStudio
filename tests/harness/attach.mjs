// WHERE A LEAN-TO AND THE LOWER WINGS MEET THE BUILDING, measured off the scene graph.
//
// roof.leanToAttach / leanToAttachFt and roof.wingAttach / wingAttachFt (2026-09-28, Carolyn's call):
// the builder says whether an appendage's roof meets the building ON THE WALL (d feet below the eave)
// or ON THE ROOF (d feet above it, up the roof's slope), and the renderer builds exactly that and never
// switches the one for the other. The pure numbers are pinned by
// _shared/_test_stubs/wingsMassing_test.ts; this script proves the SHIPPED compiled bundle builds them,
// in the real designer with a hand-written config, through __SS3D_DEBUG (window.__ss3dEngine):
//
//   1. LEAN-TO, 12x16 gable and a 12x16 single slant (both sides of it): the lean-to slab's inner
//      bottom edge stands where the mode says -- at the plate with no attach (today), d below the eave
//      on the wall, d above it and in by d / k up the roof, seated on the deck -- and its outer edge
//      is leanToDropFt below that wall's eave. The shed's HIGH side has no roof above it: "roof" meets
//      at the eave there, flagged, not switched.
//   2. WINGS, the Tri Home (37x22, front a gable end, 12 ft wings both sides at 4:12, centre eave 14,
//      8:12 centre): no attach builds today's centre (pushed where today pushes -- the 10 ft wall);
//      "wall" keeps the centre's eave at EXACTLY 14 and lands the wing roof on the centre wall d below
//      it, a clerestory above; "roof" keeps 14, runs the wing roof up onto the centre's roof to d above
//      its eave, draws no clerestory, and stops the centre's own slabs at the landing.
//   3. THE PANEL (?admin=1): "Lean-to meets the building" and "Wing roofs meet the centre" save the
//      word and a distance; the readouts say what gets built; while a wing attach is set the pitch box
//      is a readout and the drawing never says "centre, raised"; "At the eave" / "Automatic" delete
//      both keys; an untouched style saves exactly what it stored.
//   4. zero page errors
//   (review, 2026-09-29) a lean-to level with the roof lands unflagged; a wing roof up the roof of a
//   centre taller than H + k * w meets the centre's WALL (clerestory, flagged, still "roof") and one
//   level with it lands; a transom dormer stops 0.3 ft short of a landed wing roof; the panel names the
//   drop / width / distance / centre height that fixes each warning and each one does; the unset
//   lean-to option on a shed's high side says "At wall height"; the drawing's wall tick measures the wall.
//   (fixes, 2026-09-29) a wing roof that cannot reach the middle roof meets its wall at least the clearance
//   "On the wall" holds, so the wing slab stays under the middle section's soffit and its flashing under
//   the middle roof (every wing case measures both); a door no taller than the lean-to panel's "need to
//   stay under" clears a wall-attached lean-to's roof and a standard 6'8" door over it does not; the
//   panel says: that height, a dormer under a lean-to roof run up onto its roof (and where it clears), the
//   high side's roof edge on "On the roof", the distance BUILT (a flat ask, 0 as "at the eave"), a seeded
//   "On the wall" that builds a slope, the wings in "middle section" words, each wing where the two differ,
//   and the real blank middle height.
//
//   python -m http.server 8143 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8143 node tests/harness/attach.mjs      (SS_SHOTS=<dir> for the PNGs)
//   SS_ATTACH_DIGEST=<file> ...                                       (only write the no-attach digests)
//   SS_CASES=lean,wings,panel                                         (a subset)
//
// Exit 0 = every assertion held.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, BASE, revealTool, svgPoint, buildingRect, readItems } from "./lib.mjs";

const ROOF_T = 0.2, WALL_T = 0.3;
const COLORS = { body: "#e9e4d8", trim: "#5b5f63", roof: "#3b4a5c", wood: "#a8703f" };
const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };
const f3 = (v) => (v == null || !Number.isFinite(Number(v)) ? String(v) : Number(v).toFixed(3));
const settle = (page, ms = 400) => page.waitForTimeout(ms);

// ── the cases ────────────────────────────────────────────────────────────────────────────────
// A 12x16 gable: today's axes put the gable ends north/south (u = world x, S = 12), pitch 0.4, 8 ft
// walls, an 8 ft lean-to 1 ft below the eave at its outer edge.
const GABLE = { type: "gable", pitch: 0.4, overhang: 0.6 };
// A 12x16 single slant in the new frame, high side LEFT: u = world x, west (-u) is the high wall at
// 8 + 12 * 0.25 = 11, east the low one at 8.
const SHED = { type: "shed", highSide: "left", pitch: 0.25, overhang: 0.6 };
const LEAN = (side, extra = {}) => ({ leanToWidthFt: 8, leanToDropFt: 2, leanToSide: side, ...extra });
const seat = (k) => (ROOF_T + 0.02) * Math.sqrt(1 + k * k);
// Expected inner edge (u, y) and outer edge y1, in the building's own u (world x here). The gable's
// lean-to drops 2 ft (a 3:12 today), the single slant's 1 ft (its roof is only 3:12 itself).
const LEAN_CASES = [
  { id: "gL-none", roof: { ...GABLE, ...LEAN("left") }, want: { u: -6, y: 8, y1: 6 } },
  { id: "gL-wall", roof: { ...GABLE, ...LEAN("left", { leanToAttach: "wall", leanToAttachFt: 1 }) }, want: { u: -6, y: 7, y1: 6 } },
  { id: "gL-roof", roof: { ...GABLE, ...LEAN("left", { leanToAttach: "roof", leanToAttachFt: 1.5 }) }, want: { u: -(6 - 1.5 / 0.4), y: 9.5 + seat(0.4), y1: 6 } },
  { id: "gR-none", roof: { ...GABLE, ...LEAN("right") }, want: { u: 6, y: 8, y1: 6 } },
  { id: "gR-wall", roof: { ...GABLE, ...LEAN("right", { leanToAttach: "wall", leanToAttachFt: 0.75 }) }, want: { u: 6, y: 7.25, y1: 6 } },
  { id: "gR-roof", roof: { ...GABLE, ...LEAN("right", { leanToAttach: "roof", leanToAttachFt: 2 }) }, want: { u: 6 - 2 / 0.4, y: 10 + seat(0.4), y1: 6 } },
  // The single slant's LOW side (east, the roof rises inward at 0.25) and HIGH side (west, eave at 11).
  { id: "sLow-none", roof: { ...SHED, ...LEAN("right", { leanToDropFt: 1 }) }, want: { u: 6, y: 8, y1: 7 } },
  { id: "sLow-wall", roof: { ...SHED, ...LEAN("right", { leanToDropFt: 1, leanToAttach: "wall", leanToAttachFt: 0.5 }) }, want: { u: 6, y: 7.5, y1: 7 } },
  { id: "sLow-roof", roof: { ...SHED, ...LEAN("right", { leanToDropFt: 1, leanToAttach: "roof", leanToAttachFt: 1 }) }, want: { u: 6 - 1 / 0.25, y: 9 + seat(0.25), y1: 7 } },
  // A roof attach steeper than the roof it sits on: built as asked, the main eave through it, flagged.
  { id: "sLow-roofSteep", roof: { ...SHED, ...LEAN("right", { leanToAttach: "roof", leanToAttachFt: 1 }) }, want: { u: 6 - 1 / 0.25, y: 9 + seat(0.25), y1: 6, cuts: true } },
  // Level with the roof it sits on (drop = k * width - seat): one plane, NOT a cut (review, 2026-09-29).
  { id: "gL-roofLevel", roof: { ...GABLE, ...LEAN("left", { leanToDropFt: 0.4 * 8 - seat(0.4), leanToAttach: "roof", leanToAttachFt: 1 }) }, want: { u: -(6 - 1 / 0.4), y: 9 + seat(0.4), y1: 8 - (0.4 * 8 - seat(0.4)), level: true } },
  { id: "sHigh-none", roof: { ...SHED, ...LEAN("left", { leanToDropFt: 1 }) }, want: { u: -6, y: 8, y1: 7 } },
  { id: "sHigh-wall", roof: { ...SHED, ...LEAN("left", { leanToDropFt: 1, leanToAttach: "wall", leanToAttachFt: 0.5 }) }, want: { u: -6, y: 10.5, y1: 10 } },
  { id: "sHigh-roof", roof: { ...SHED, ...LEAN("left", { leanToDropFt: 1, leanToAttach: "roof", leanToAttachFt: 1 }) }, want: { u: -6, y: 11, y1: 10, noRoof: true } },
];

// The Tri Home Carolyn drew on (09-28): 37 across the front gable end, 22 deep, 12 ft wings both sides
// at 4:12, the centre's eave asked at 14 under an 8:12 gable with a 1 ft overhang.
const TRI = { type: "gable", front: "gable", pitch: 0.67, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 12, wingPitch: 0.333, centerEaveFt: 14 };
const DORMER = { dormerType: "transom", dormerWidthFt: 6, dormerRiseFt: 2.5, dormerOffsetU: 0.45 };
const WING_CASES = [
  { id: "tri8-auto", H: 8, roof: TRI },
  { id: "tri8-wall", H: 8, roof: { ...TRI, wingAttach: "wall", wingAttachFt: 1 } },
  { id: "tri8-roof", H: 8, roof: { ...TRI, wingAttach: "roof", wingAttachFt: 1 } },
  // At 10 ft walls today's rule PUSHES the centre (wing top 14 + 1 = 15 over the 14 asked): her complaint.
  { id: "tri10-auto", H: 10, roof: TRI },
  { id: "tri10-wall", H: 10, roof: { ...TRI, wingAttach: "wall", wingAttachFt: 1.5 } },
  { id: "tri10-roof", H: 10, roof: { ...TRI, wingAttach: "roof", wingAttachFt: 1 } },
  // A wall attach closer than the centre's fascia allows is moved down to it, and flagged.
  { id: "tri10-wallTight", H: 10, roof: { ...TRI, wingAttach: "wall", wingAttachFt: 0.25 } },
  // (review, 2026-09-29) Up the roof, the wing roof reaches the centre's roof only while the centre stands
  // no more than k * w over the walls, WHATEVER the distance: 14 over 8 ft walls with 12 ft wings needs 6:12.
  // At 5:12 it cannot: built as asked, meeting the centre's WALL under its eave, clerestory and all, flagged.
  { id: "tri8-roofCannot", H: 8, roof: { ...TRI, pitch: 5 / 12, wingAttach: "roof", wingAttachFt: 1 }, cannot: true },
  // At exactly 6:12 the wing roof and the centre's roof are one plane: it lands, and is not flagged.
  { id: "tri8-roofLevel", H: 8, roof: { ...TRI, pitch: 0.5, wingAttach: "roof", wingAttachFt: 1 }, level: true },
  // (fixes, 2026-09-29) ...and at 0, where its own line met the centre's wall AT the eave.
  { id: "tri8-roofCannot0", H: 8, roof: { ...TRI, pitch: 5 / 12, wingAttach: "roof", wingAttachFt: 0 }, cannot: true },
  // A transom dormer on the centre, running out toward the east wing: up the roof, the wing roof covers the
  // centre's eave from its wall in to the landing, so the dormer stops 0.3 ft short of it.
  { id: "tri10-autoDormer", H: 10, roof: { ...TRI, ...DORMER } },
  { id: "tri10-roofDormer", H: 10, roof: { ...TRI, ...DORMER, wingAttach: "roof", wingAttachFt: 1 } },
];

const configFor = (label, size, d3) => {
  const [w, l] = size.split("x").map(Number);
  return {
    clientId: "harness-attach",
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "att", label, img: null, sizes: [size], sizeInclusions: {}, sizeInclusionQty: {}, d3 }],
    defaultSizes: [size],
    sizePricing: { att: { [size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { att: CLADS }, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
  };
};

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
async function openCase(ctx, label, size, d3) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: configFor(label, size, d3), fixtures: FIXTURES });
  await openDesigner(page, "harness-attach");
  await pickStyle(page, label);
  await chooseSize(page, size);
  await openEditor(page);
  return { page, errors };
}

// The wings.mjs digest: every mesh's world bbox (1/1000 ft) and material colour, order-independent.
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

// Everything measured, in the building's own profile u (world x when uAxisIsX, else world z).
async function measure(page) {
  return page.evaluate(({ ROOF_T }) => {
    const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const m = M.massing, L = m.L;
    const uOf = (v) => (m.uAxisIsX ? v.x : v.z);
    const bbOf = (q) => {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      q.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox;
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
          const v = new V(x, y, z).applyMatrix4(o.matrixWorld);
          [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
        }
      });
      return { mn, mx, uMin: Math.min(uOf({ x: mn[0], z: mn[2] }), uOf({ x: mx[0], z: mx[2] })), uMax: Math.max(uOf({ x: mn[0], z: mn[2] }), uOf({ x: mx[0], z: mx[2] })) };
    };
    // A sloped slab's INNER END: the two corners of its end face nearest the building's middle (uc),
    // the lower of them is where its underside meets the building.
    const slabEnd = (q, towardU) => {
      const p = q.geometry.parameters;
      const pts = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) pts.push(new V(sx * p.width / 2, sy * p.height / 2, 0).applyMatrix4(q.matrixWorld));
      pts.sort((a, b) => Math.abs(uOf(a) - towardU) - Math.abs(uOf(b) - towardU));
      const end = pts.slice(0, 2).sort((a, b) => a.y - b.y);
      return { u: uOf(end[0]), y: end[0].y, uTop: uOf(end[1]), yTop: end[1].y };
    };
    const out = { massing: JSON.parse(JSON.stringify(m)), leanTo: M.leanTo ? JSON.parse(JSON.stringify(M.leanTo)) : null };
    // The lean-to: its slab is the ssLeanTo box far wider than a post or the header.
    const lean = [];
    M.roofGroup.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssLeanTo) lean.push(q); });
    const lslab = lean.filter((q) => q.geometry.type === "BoxGeometry").sort((a, b) => b.geometry.parameters.width - a.geometry.parameters.width)[0];
    if (lslab) {
      out.leanSlab = slabEnd(lslab, m.uc);
      const hdr = lean.find((q) => q !== lslab && q.geometry.parameters && Math.abs(q.geometry.parameters.width - 0.35) < 1e-6);
      out.leanHeaderTop = hdr ? bbOf(hdr).mx[1] : null;
    }
    // Wings: each wing's own slab (the widest roofMat box tagged ssWing), its prism, the clerestory walls.
    out.wings = m.wings.map((g) => {
      const tagged = [];
      M.roofGroup.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssWing === g.side) tagged.push(q); });
      const slab = tagged.filter((q) => q.geometry.type === "BoxGeometry" && Math.abs(q.geometry.parameters.height - ROOF_T) < 1e-9 && q.geometry.parameters.width > 3)
        .sort((a, b) => b.geometry.parameters.width - a.geometry.parameters.width)[0];
      const prism = tagged.find((q) => q.geometry.type === "ExtrudeGeometry");
      return { side: g.side, slabEnd: slab ? slabEnd(slab, m.uc) : null, prism: prism ? bbOf(prism) : null, n: tagged.length };
    });
    out.clerestory = [];
    M.wallsGroup.children.forEach((g) => { if (g.userData && g.userData.clerestory) { const b = bbOf(g); out.clerestory.push({ side: g.userData.clerestory, minY: b.mn[1], maxY: b.mx[1] }); } });
    out.gableTops = {};
    M.wallsGroup.children.forEach((g) => { if (g.userData && g.userData.wall) out.gableTops[g.userData.wall] = bbOf(g).mx[1]; });
    // The centre's roof prism (rg's ExtrudeGeometry with two materials that is no wing's), and how far
    // out toward each wing any of the centre's own roof members above H + 0.5 reaches.
    let centre = null;
    const reach = { neg: 0, pos: 0 };
    M.roofGroup.traverse((q) => {
      if (!q.isMesh || !q.geometry || (q.userData && (q.userData.ssWing || q.userData.ssLeanTo || q.userData.ssPorchPart))) return;
      const b = bbOf(q);
      if (q.geometry.type === "ExtrudeGeometry" && Array.isArray(q.material) && (!centre || b.mx[1] > centre.maxY)) centre = { minY: b.mn[1], maxY: b.mx[1] };
      // Slabs, fascias, soffits and ridge caps run the building's length; rake boards are 0.32 x 0.1.
      const p = q.geometry.type === "BoxGeometry" ? q.geometry.parameters : null;
      const along = p && (p.depth >= L - 1e-6 || (Math.abs(p.height - 0.32) < 1e-9 && Math.abs(p.depth - 0.1) < 1e-9));
      if (along && b.mn[1] > m.H + 0.5) { reach.neg = Math.min(reach.neg, b.uMin - m.uc); reach.pos = Math.max(reach.pos, b.uMax - m.uc); }
    });
    out.centre = centre;
    out.centreReach = reach;
    // A transom dormer's two cheeks: the short extrusions (the wall's thickness deep) on the centre's roof,
    // in the building's own u. Their outer end is the dormer's face.
    const cheeks = [];
    M.roofGroup.traverse((q) => {
      if (!q.isMesh || !q.geometry || q.geometry.type !== "ExtrudeGeometry" || (q.userData && (q.userData.ssWing || q.userData.ssLeanTo))) return;
      const o = q.geometry.parameters && q.geometry.parameters.options;
      if (o && o.depth < 1) cheeks.push(bbOf(q));
    });
    out.dormer = cheeks.length ? { n: cheeks.length, uMin: Math.min(...cheeks.map((b) => b.uMin)), uMax: Math.max(...cheeks.map((b) => b.uMax)) } : null;
    // (fixes, 2026-09-29) WHERE A WING ROOF MEETS THE CENTRE'S WALL: exact vertical sections through every
    // roof box, every 0.05 ft out from the centre wall line across the centre's overhang. The worst of the
    // wing slab's top over the centre's soffit's bottom, and of the flashing's top over the centre deck's
    // underside (null where the centre has no eave on that side: a wing roof that lands on its roof).
    const boxesY = (u) => {
      const x = m.uAxisIsX ? u : 0.3, z = m.uAxisIsX ? 0.3 : u;
      const hits = [];
      M.roofGroup.traverse((o) => {
        if (!o.isMesh || !o.geometry || o.geometry.type !== "BoxGeometry") return;
        const inv = o.matrixWorld.clone().invert();
        const p0 = new V(x, 0, z).applyMatrix4(inv), d = new V(x, 1, z).applyMatrix4(inv).sub(p0);
        const P = o.geometry.parameters, h = [P.width / 2, P.height / 2, P.depth / 2];
        let t0 = -Infinity, t1 = Infinity;
        for (let i = 0; i < 3; i++) {
          const a = p0.getComponent(i), b = d.getComponent(i);
          if (Math.abs(b) < 1e-12) { if (Math.abs(a) > h[i]) return; continue; }
          let ta = (-h[i] - a) / b, tb = (h[i] - a) / b;
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        }
        if (t0 <= t1) hits.push({ ud: o.userData || {}, w: P.width, h: P.height, y0: t0, y1: t1 });
      });
      return hits;
    };
    out.joint = m.wings.map((g) => {
      let wingOverSoffit = null, flashOverDeck = null;
      for (let i = 1; i <= 24; i++) {
        const hits = boxesY(g.u0 + g.side * i * 0.05);
        const plain = hits.filter((q) => !q.ud.ssWing && !q.ud.ssLeanTo && !q.ud.ssPorchPart);
        const soffit = plain.find((q) => Math.abs(q.h - 0.05) < 1e-6);
        const deck = plain.filter((q) => Math.abs(q.h - ROOF_T) < 1e-6 && q.w > 3).sort((a, b) => a.y0 - b.y0)[0];
        const wslab = hits.find((q) => q.ud.ssWing === g.side && Math.abs(q.h - ROOF_T) < 1e-6 && q.w > 3);
        const flash = hits.find((q) => q.ud.ssWing === g.side && Math.abs(q.h - 0.38) < 1e-6);
        if (soffit && wslab) wingOverSoffit = Math.max(wingOverSoffit == null ? -Infinity : wingOverSoffit, wslab.y1 - soffit.y0);
        if (deck && flash) flashOverDeck = Math.max(flashOverDeck == null ? -Infinity : flashOverDeck, flash.y1 - deck.y0);
      }
      return { side: g.side, wingOverSoffit, flashOverDeck };
    });
    return out;
  }, { ROOF_T });
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

// ── 1. the lean-to ───────────────────────────────────────────────────────────────────────────
async function leanCase(ctx, c, ok, shots, digests) {
  const tag = `lean ${c.id}`;
  const d3 = { roof: c.roof, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" };
  const { page, errors } = await openCase(ctx, `Harness Lean ${c.id}`, "12x16", d3);
  try {
    if (digests && !c.roof.leanToAttach) digests[c.id] = await digest(page);
    const m = await measure(page);
    const w = c.want;
    const at = m.leanSlab;
    console.log(`   ${tag}: slab inner edge u ${f3(at && at.u)} y ${f3(at && at.y)} (want ${f3(w.u)}, ${f3(w.y)}); header top ${f3(m.leanHeaderTop)} (want ${f3(w.y1)})`);
    ok(`${tag}: the lean-to's roof meets the building at u ${f3(w.u)}, ${f3(w.y)} ft up`, at && Math.abs(at.u - w.u) < 0.05 && Math.abs(at.y - w.y) < 0.03, JSON.stringify(at));
    ok(`${tag}: its outer edge is leanToDropFt under that wall's eave (${f3(w.y1)})`, m.leanHeaderTop != null && Math.abs(m.leanHeaderTop - w.y1) < 0.01, f3(m.leanHeaderTop));
    if (c.roof.leanToAttach) {
      const L = m.leanTo;
      ok(`${tag}: the model's own numbers are the ones built (d3LeanToGeom)`, L && L.mode === c.roof.leanToAttach && Math.abs(L.ua - w.u) < 1e-6 && Math.abs(L.ya - w.y) < 1e-6 && Math.abs(L.y1 - w.y1) < 1e-6, JSON.stringify(L));
      ok(`${tag}: never switched: the mode built is the one asked`, L && L.mode === c.roof.leanToAttach, L && L.mode);
      if (w.noRoof) ok(`${tag}: the high side has no roof above it: it meets at the eave, and says so`, L && L.noRoof === true && L.clamped === true && !L.cuts, JSON.stringify(L));
      else if (w.cuts) ok(`${tag}: steeper than the roof it sits on: built as asked, and flagged (cuts)`, L && L.cuts === true && !L.clamped && L.pitch >= c.roof.pitch, JSON.stringify(L));
      else ok(`${tag}: nothing clamped or flagged`, L && !L.noRoof && !L.clamped && !L.flat && !L.cuts, JSON.stringify(L));
      if (w.level) {
        ok(`${tag}: level with the roof it sits on (${f3(L.pitch * 12)} in 12): one plane, not flagged as a cut`, Math.abs(L.pitch - c.roof.pitch) < 1e-9 && !L.cuts, f3(L.pitch));
        // Its slab lies on the main deck from where it meets out past the main eave: its underside at the
        // wall line is the deck's top face there.
        const s = m.leanSlab;
        ok(`${tag}: its slab's underside runs on the main deck's top face`, s && Math.abs(s.y - w.y) < 0.03, JSON.stringify(s));
      } else if (c.roof.leanToAttach === "roof" && !w.noRoof && !w.cuts) {
        // Up the roof it is steeper than hung at the eave with the same drop, and flatter than the roof it sits on.
        const today = c.roof.leanToDropFt / c.roof.leanToWidthFt;
        ok(`${tag}: its pitch (${f3(L.pitch * 12)} in 12) is steeper than at the eave (${f3(today * 12)}) and flatter than the roof it sits on`, L.pitch > today && L.pitch < c.roof.pitch, f3(L.pitch));
      }
    } else {
      ok(`${tag}: no attach: the model carries no attach numbers (today's lean-to)`, m.leanTo === null, JSON.stringify(m.leanTo));
    }
    if (shots && /^gL-/.test(c.id)) {
      await shot(page, join(shots, `leanto-${c.id.slice(3)}-corner.png`), [-26, 13, 21], [-5, 6.5, 0]);
      await shot(page, join(shots, `leanto-${c.id.slice(3)}-end.png`), [-5, 8.5, 34], [-5, 7.5, 0]);
    }
    if (shots && /^sLow-|^sHigh-/.test(c.id)) await shot(page, join(shots, `leanto-shed-${c.id}.png`), [c.id.startsWith("sHigh") ? -6 : 6, 9, 34], [c.id.startsWith("sHigh") ? -6 : 6, 8, 0]);
    ok(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally { await page.close(); }
}

// ── 1b. a door under a wall-attached lean-to (fixes, 2026-09-29) ──────────────────────────────
// On the wall the lean-to's roof meets the wall BELOW the eave, and the panel says how high doors and
// windows on that wall can go: 0.2 ft under that line, to the inch -- the header the designer holds under
// any wall's top. A door that tall, placed through the real 2D "Door wall" tool, clears the lean-to's roof;
// the standard 6'8" door over it runs into it, which is exactly why the panel says so.
const DOOR_ROOF = { ...GABLE, ...LEAN("right", { leanToAttach: "wall", leanToAttachFt: 1.5 }) };
const DOOR_CASES = [{ id: "gR-wall15-door75", heightIn: 75, clears: true }, { id: "gR-wall15-door80", heightIn: 80, clears: false }];
async function doorCase(ctx, c, ok, shots) {
  const tag = `lean ${c.id}`;
  const fixtures = { ...FIXTURES, items: [{ id: "d-walk", name: "Harness Walk Door", price: 300, widthIn: 36, heightIn: c.heightIn, category: "door", colorMode: "fixed", planLabel: "WD", sortOrder: 0, imageUrl: null,
    sillIn: null, sillMode: "fixed", opLeft: false, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right", swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false }] };
  const label = `Harness Lean ${c.id}`;
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  try {
    await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
    await stubSupabase(page, { config: configFor(label, "12x16", { roof: DOOR_ROOF, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" }), fixtures });
    await openDesigner(page, "harness-attach");
    await pickStyle(page, label);
    await chooseSize(page, "12x16");
    const r = await buildingRect(page);
    const pt = await svgPoint(page, r.x + r.w - 0.4 * (r.w / 12), r.y + 8 * (r.h / 16));
    await (await revealTool(page, /^Door wall$/)).click();
    await settle(page, 300);
    await page.mouse.click(pt.x, pt.y);
    await settle(page, 600);
    await page.getByText("Harness Walk Door", { exact: true }).first().click({ timeout: 10000 });
    await settle(page, 300);
    await page.getByRole("button", { name: "Place door" }).click();
    await settle(page, 600);
    const door = ((await readItems(page)) || []).find((i) => /door/i.test(String(i.type)));
    ok(`${tag}: a ${c.heightIn} in walk door is on the east wall, under the lean-to`, door && door.wall === "east", JSON.stringify(door && { type: door.type, wall: door.wall }));
    await openEditor(page);
    const got = await page.evaluate(() => {
      const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
      E.scene.updateMatrixWorld(true);
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      M.openingsGroup.children.forEach((g) => {
        if (!(g.userData && g.userData.itemId != null)) return;
        g.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
          const b = o.geometry.boundingBox;
          for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
            const v = new V(x, y, z).applyMatrix4(o.matrixWorld);
            [v.x, v.y, v.z].forEach((q, k) => { mn[k] = Math.min(mn[k], q); mx[k] = Math.max(mx[k], q); });
          }
        });
      });
      if (!isFinite(mx[1])) return null;
      // The lean-to slab's underside straight over the door's outer face, where its casing stands proudest.
      const x = mx[0] - 0.01, z = (mn[2] + mx[2]) / 2;
      let under = null;
      M.roofGroup.traverse((o) => {
        if (!o.isMesh || !o.userData || !o.userData.ssLeanTo || o.geometry.type !== "BoxGeometry" || o.geometry.parameters.width < 3) return;
        const inv = o.matrixWorld.clone().invert();
        const p0 = new V(x, 0, z).applyMatrix4(inv), d = new V(x, 1, z).applyMatrix4(inv).sub(p0);
        const P = o.geometry.parameters, h = [P.width / 2, P.height / 2, P.depth / 2];
        let t0 = -Infinity, t1 = Infinity;
        for (let i = 0; i < 3; i++) {
          const a = p0.getComponent(i), b = d.getComponent(i);
          if (Math.abs(b) < 1e-12) { if (Math.abs(a) > h[i]) return; continue; }
          let ta = (-h[i] - a) / b, tb = (h[i] - a) / b;
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        }
        if (t0 <= t1) under = under == null ? t0 : Math.min(under, t0);
      });
      return { top: mx[1], faceX: mx[0], under, ya: M.leanTo && M.leanTo.ya };
    });
    // The panel's number, the way the panel works it out: 0.2 under the lean-to's line on the wall, to the inch.
    const limitIn = got && got.ya != null ? Math.floor((got.ya - 0.2) * 12 + 1e-6) : null;
    console.log(`   ${tag}: casing top ${f3(got && got.top)}, lean-to underside over it ${f3(got && got.under)}, panel says under ${limitIn} in`);
    ok(`${tag}: the panel's height for this wall is 6' 3" (75 in)`, limitIn === 75, String(limitIn));
    if (c.clears) ok(`${tag}: a door as tall as the panel says clears the lean-to's roof, casing and all`, got && got.under != null && got.top <= got.under + 1e-6 && c.heightIn <= limitIn, JSON.stringify(got));
    else ok(`${tag}: a standard door taller than the panel says runs into the lean-to's roof (what the panel warns of)`, got && got.under != null && got.top > got.under && c.heightIn > limitIn, JSON.stringify(got));
    if (shots) await shot(page, join(shots, `leanto-${c.id}.png`), [13, 7.6, 5], [6, 6.3, 0]);
    ok(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally { await page.close(); }
}

// ── 2. the wings ─────────────────────────────────────────────────────────────────────────────
async function wingCase(ctx, c, ok, shots, digests) {
  const tag = `wings ${c.id}`;
  const d3 = { roof: c.roof, siding: "batten", colors: COLORS, wallHeightFt: c.H, roofMaterial: "metal" };
  const { page, errors } = await openCase(ctx, `Harness Tri ${c.id}`, "37x22", d3);
  try {
    if (digests && !c.roof.wingAttach) digests[c.id] = await digest(page);
    const m = await measure(page);
    const ms = m.massing, H = c.H, k = c.roof.pitch;
    const w = 12, ov = 1, T = WALL_T;
    console.log(`   ${tag}: Hc ${f3(ms.Hc)} raised ${ms.hcRaised} attach ${ms.attach || "-"} wings ${ms.wings.map((g) => `${g.side}: ya ${f3(g.ya)} pitch ${f3(g.pitch)} uIn ${f3(g.uIn)} d ${f3(g.attachFt)}${g.clamped ? " clamped" : ""}${g.cuts ? " cuts" : ""}`).join(" | ")}`);
    ok(`${tag}: two wings, west and east, across the 37 ft front`, ms.wings.length === 2 && ms.S === 37 && ms.uAxisIsX === true, JSON.stringify({ n: ms.wings.length, S: ms.S }));
    ok(`${tag}: the centre's roof prism stands on its eave (${f3(ms.Hc)})`, m.centre && Math.abs(m.centre.minY - ms.Hc) < 0.01, JSON.stringify(m.centre));
    for (const wall of ["north", "south"]) ok(`${tag}: the ${wall} gable end steps up to the centre's eave`, Math.abs(m.gableTops[wall] - ms.Hc) < 0.01, f3(m.gableTops[wall]));
    const ya0 = H + w * 0.333;
    if (!c.roof.wingAttach) {
      // Today's rule, push and all: never under the wing top + 1, and the centre's fascia clears.
      const minHc = ya0 + Math.max(1, ROOF_T + 0.43 + Math.max(0, k - 0.333) * ov);
      const want = Math.max(14, minHc);
      ok(`${tag}: no attach is today's centre: ${f3(want)} (${want > 14 ? "PUSHED up from the 14 asked" : "the 14 asked"})`, Math.abs(ms.Hc - want) < 1e-9 && ms.hcRaised === (want > 14 + 1e-9), `Hc ${f3(ms.Hc)} raised ${ms.hcRaised}`);
      ok(`${tag}: ...its wing roofs at the stored 4:12, meeting the centre wall at ${f3(ya0)}`, ms.wings.every((g) => Math.abs(g.pitch - 0.333) < 1e-9 && Math.abs(g.ya - ya0) < 1e-9 && g.uIn === undefined), JSON.stringify(ms.wings.map((g) => [g.pitch, g.ya])));
      ok(`${tag}: ...and a clerestory above each`, m.clerestory.length === 2, String(m.clerestory.length));
    } else {
      const mode = c.roof.wingAttach, dAsk = c.roof.wingAttachFt;
      ok(`${tag}: the centre's eave is EXACTLY the 14 asked, never pushed`, ms.Hc === 14 && ms.hcRaised === false, `Hc ${ms.Hc} raised ${ms.hcRaised}`);
      ok(`${tag}: never switched: every wing meets the centre ${mode === "roof" ? "on the roof" : "on the wall"}`, ms.attach === mode && ms.wings.every((g) => g.attach === mode), JSON.stringify(ms.wings.map((g) => g.attach)));
      for (const g of ms.wings) {
        const side = g.side < 0 ? "west" : "east";
        const u0 = g.side * (37 / 2 - w);
        if (mode === "wall") {
          const a = ROOF_T + 0.43;
          const need = Math.max(a, (a + k * ov - ov * (14 - H) / w) / (1 - ov / w));
          const d = Math.max(dAsk, need);
          ok(`${tag}: the ${side} wing roof meets the centre wall ${f3(d)} below its eave, at ${f3(14 - d)}${d > dAsk ? " (moved down so the centre's eave clears it)" : ""}`, Math.abs(g.ya - (14 - d)) < 1e-9 && Math.abs(g.uIn - u0) < 1e-9 && g.clamped === (d > dAsk + 1e-9), JSON.stringify(g));
          ok(`${tag}: the ${side} wing's pitch is worked out from it (${f3(((14 - d - H) / w) * 12)} in 12; wingPitch unread)`, Math.abs(g.pitch - (14 - d - H) / w) < 1e-9, f3(g.pitch));
          const face = u0 + g.side * T / 2;
          const s = m.wings.find((q) => q.side === g.side).slabEnd;
          // Its underside runs a hair past the clerestory's outer face into the wall, on the wing line.
          ok(`${tag}: the ${side} wing slab's underside reaches the centre wall's face on the wing line (${f3(H + (w - T / 2) * g.pitch)} there)`, s && (face - s.u) * g.side >= -0.01 && (face - s.u) * g.side <= 0.15 && Math.abs(s.y - (H + Math.abs(s.u - g.side * 37 / 2) * g.pitch)) < 0.04, JSON.stringify(s));
          const cl = m.clerestory.find((q) => q.side === g.side);
          ok(`${tag}: a clerestory above the ${side} wing, from under its roof up to 14`, cl && cl.minY <= g.ya + 1e-6 && Math.abs(cl.maxY - 14) < 0.01, JSON.stringify(cl));
        } else if (c.cannot) {
          // Up the roof, but the centre stands more than k * w over the walls: at ANY distance the wing line
          // runs in under the centre's eave. Built as far as it shows, to the centre's wall, and flagged --
          // meeting that wall no higher than the clearance "On the wall" holds (fixes, 2026-09-29): on its own
          // line it met 2 in under the eave, burying the centre's soffit, its flashing up through the roof.
          const a = ROOF_T + 0.43, need = Math.max(a, (a + k * ov - ov * (14 - H) / w) / (1 - ov / w));
          const p0 = (14 + dAsk - H) / (w + dAsk / k), ya = Math.max(H, Math.min(H + w * p0, 14 - need)), p = (ya - H) / w;
          ok(`${tag}: the ${side} wing roof cannot reach the centre's roof (14 over ${H} ft walls needs ${f3(((14 - H) / w) * 12)} in 12 there, it is ${f3(k * 12)}): flagged, still "roof", meeting the centre's wall at ${f3(ya)}, ${f3(14 - ya)} under its eave (its own line would meet ${f3(14 - H - w * p0)} under)`,
            g.cuts === true && g.attach === "roof" && g.attachFt === dAsk && g.meets === "wall" && Math.abs(g.ya - ya) < 1e-9 && Math.abs(g.pitch - p) < 1e-9 && Math.abs(g.uIn - u0) < 1e-9 && Math.abs(g.meetFt - (14 - ya)) < 1e-9 && 14 - ya >= need - 1e-9, JSON.stringify(g));
          const face = u0 + g.side * T / 2;
          const s = m.wings.find((q) => q.side === g.side).slabEnd;
          ok(`${tag}: the ${side} wing slab stops at the centre wall's face on its own line, under the centre's eave`, s && (face - s.u) * g.side >= -0.01 && (face - s.u) * g.side <= 0.15 && Math.abs(s.y - (H + Math.abs(s.u - g.side * 37 / 2) * p)) < 0.04 && s.y < 14, JSON.stringify(s));
          const cl = m.clerestory.find((q) => q.side === g.side);
          ok(`${tag}: a clerestory above the ${side} wing, from under its roof up to 14`, cl && cl.minY <= ya + 1e-6 && Math.abs(cl.maxY - 14) < 0.01, JSON.stringify(cl));
          const reach = g.side < 0 ? -m.centreReach.neg : m.centreReach.pos;
          ok(`${tag}: the centre's own roof keeps its ${side} eave (reaches ${f3(reach)})`, reach >= 37 / 2 - w + ov - 0.3, f3(reach));
        } else {
          const d = dAsk, uIn = u0 - g.side * (d / k), run = w + d / k, p = (14 + d - H) / run;
          ok(`${tag}: the ${side} wing roof runs up onto the centre's roof to ${f3(d)} above its eave: (${f3(uIn)}, ${f3(14 + d)})`, Math.abs(g.ya - (14 + d)) < 1e-9 && Math.abs(g.uIn - uIn) < 1e-9 && !g.clamped && !g.cuts && g.meets === "roof", JSON.stringify(g));
          if (c.level) ok(`${tag}: the ${side} wing roof is level with the centre's (${f3(p * 12)} in 12): one plane, it lands, not flagged`, Math.abs(g.pitch - k) < 1e-9 && Math.abs(p - k) < 1e-9 && !g.cuts, f3(g.pitch));
          else ok(`${tag}: the ${side} wing's pitch is worked out from it (${f3(p * 12)} in 12), flatter than the centre's eave`, Math.abs(g.pitch - p) < 1e-9 && p < k, f3(g.pitch));
          const s = m.wings.find((q) => q.side === g.side).slabEnd;
          ok(`${tag}: the ${side} wing slab lands on the centre's roof there`, s && Math.abs(s.u - uIn) < 0.05 && Math.abs(s.y - (14 + d)) < 0.05, JSON.stringify(s));
          const pr = m.wings.find((q) => q.side === g.side).prism;
          ok(`${tag}: the ${side} wing's body closes the gable end up to the landing`, pr && Math.abs(pr.mx[1] - (14 + d)) < 0.01 && Math.abs(pr.mn[1] - H) < 0.01, JSON.stringify(pr && { minY: pr.mn[1], maxY: pr.mx[1] }));
          const reach = g.side < 0 ? -m.centreReach.neg : m.centreReach.pos;
          ok(`${tag}: the centre's own roof stops at the ${side} landing (reaches ${f3(reach)} of ${f3(Math.abs(uIn))}), no eave of its own under the wing`, reach <= Math.abs(uIn) + 0.3, f3(reach));
        }
      }
      if (mode === "roof" && !c.cannot) ok(`${tag}: no clerestory: the wing roofs cover the centre's walls`, m.clerestory.length === 0, String(m.clerestory.length));
      if (c.cannot) ok(`${tag}: a clerestory above each wing: the centre's walls show over the wing roofs`, m.clerestory.length === 2, String(m.clerestory.length));
    }
    // (fixes, 2026-09-29) Wherever the centre keeps its eave over a wing, measured in sections: the wing slab
    // stays under the centre's soffit and the flashing under the centre's deck.
    for (const j of m.joint) {
      const side = j.side < 0 ? "west" : "east";
      if (j.wingOverSoffit != null) ok(`${tag}: the ${side} wing slab stays under the centre's soffit (${f3(-j.wingOverSoffit)} ft clear at the tightest)`, j.wingOverSoffit <= 0.005, f3(j.wingOverSoffit));
      if (j.flashOverDeck != null) ok(`${tag}: the ${side} wing's flashing stays under the centre's roof deck (${f3(-j.flashOverDeck)} ft clear)`, j.flashOverDeck <= 0.005, f3(j.flashOverDeck));
    }
    if (c.cannot) ok(`${tag}: ...both measured on both sides`, m.joint.length === 2 && m.joint.every((j) => j.wingOverSoffit != null && j.flashOverDeck != null), JSON.stringify(m.joint));
    if (c.roof.dormerType) {
      // The transom dormer runs toward the east eave. Bare roof: to 0.3 ft short of the centre's own eave
      // line (today). With the east wing roof landed on the centre's roof: to 0.3 ft short of the landing.
      const gE = ms.wings.find((g) => g.side > 0);
      const landed = gE.attach === "roof" && !gE.cuts;
      const edge = landed ? gE.uIn - 0.3 : (37 / 2 - w) - 0.3;
      ok(`${tag}: the transom dormer's face stands at ${f3(edge)}, ${landed ? `0.3 ft short of where the wing roof lands (${f3(gE.uIn)})` : "0.3 ft short of the centre's eave, as today"}`,
        m.dormer && m.dormer.n === 2 && Math.abs(m.dormer.uMax - edge) < 0.01, JSON.stringify(m.dormer));
    }
    if (shots && /^tri10-(auto|wall|roof)$/.test(c.id)) {
      const mode = c.id.split("-")[1];
      await shot(page, join(shots, `trihome-${mode}-corner.png`), [-34, 21, 42], [-2, 10, 0]);
      await shot(page, join(shots, `trihome-${mode}-front.png`), [0, 13, 58], [0, 12, 0]);
    }
    if (shots && /^tri8-roof(Cannot|Level)$/.test(c.id)) await shot(page, join(shots, `trihome-${c.id.slice(5)}-front.png`), [0, 13, 58], [0, 12, 0]);
    if (shots && c.roof.dormerType) await shot(page, join(shots, `dormer-${c.roof.wingAttach || "auto"}-side.png`), [34, 22, 30], [8, 13, 0]);
    ok(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally { await page.close(); }
}


// ── 3. the panel ─────────────────────────────────────────────────────────────────────────────
const LEAN_PANEL_ROOF = { ...GABLE, leanToWidthFt: 8, leanToDropFt: 2, leanToSide: "left" };
const TRI_PANEL_ROOF = { ...TRI };
// (fixes, 2026-09-29) A lean-to with the default 1 ft drop and a dormer out toward it; two wings an off-centre
// ridge lands differently.
const LEAN_SEED_ROOF = { ...GABLE, leanToWidthFt: 8, leanToSide: "right", dormerWidthFt: 4 };
const ODD_WINGS_ROOF = { type: "gable", pitch: 0.5, ridgeOffset: -0.3, wingSide: "both", wingWidthFt: 6, centerEaveFt: 10, wingAttach: "roof", wingAttachFt: 2.5 };
const panelStyle = (value, label, size, roof, H) => ({ value, label, img: null, sizes: [size], sizeInclusions: {}, sizeInclusionQty: {},
  d3: { roof, siding: "batten", colors: COLORS, wallHeightFt: H, roofMaterial: "metal" } });
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const keys = (o) => Object.keys(o || {}).sort().join(",");
const field = (page, text) => page.locator("label").filter({ hasText: text });
async function typeNumber(page, input, value) {
  await input.click();
  await input.fill(String(value));
  await page.keyboard.press("Tab");
  await settle(page, 300);
}
async function saveCal(page, calls) {
  const saves = () => calls.filter((c) => c.path && c.path.endsWith("/functions/v1/admin-save-settings") && c.body && c.body.action === "save_style_d3");
  const before = saves().length;
  await page.getByRole("button", { name: "Save to config" }).click();
  const t0 = Date.now();
  while (saves().length === before) {
    if (Date.now() - t0 > 15000) throw new Error("Save sent no admin-save-settings call");
    await settle(page, 100);
  }
  await page.getByText("Saved — reload the page to see it live.").waitFor({ state: "visible", timeout: 15000 });
  return saves()[saves().length - 1].body.d3;
}
const elevationText = (page) => page.evaluate(() => [...document.querySelectorAll("svg")].map((s) => [...s.querySelectorAll("text")].map((t) => t.textContent).join("|")).filter((t) => /span/.test(t)).join(" / "));
const flat = (t) => t.replace(/\s+/g, " ");

// The same roof, whatever order the panel spreads its keys in (d3ResolveStyleSpec puts type and pitch first).
const sameRoof = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));
// One operator page per style, so the panel works at that style's own size (it reads the designer's pick).
async function openPanel(ctx, value, label, size, roof, H) {
  const [w, l] = size.split("x").map(Number);
  const config = { ...configFor(label, size, {}), buildingStyles: [panelStyle(value, label, size, roof, H)], defaultSizes: [size],
    sizePricing: { [value]: { [size]: { widthFt: w, lengthFt: l, basePrice: 1 } } } };
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const calls = await stubSupabase(page, { config, fixtures: FIXTURES });
  await page.goto(`${BASE}/?client=harness-attach&admin=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
  await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
  // The panel reads and draws at the designer's own pick (sel.size), so the style and its size are
  // picked in the designer first, as a builder calibrating a 37x22 would have it on screen.
  await pickStyle(page, label);
  await chooseSize(page, size);
  await page.getByPlaceholder("Admin password").fill("harness");
  await page.getByRole("button", { name: label, exact: true }).first().click();
  return { page, errors, calls };
}

async function panelCheck(ctx, ok, shots) {
  let { page, errors, calls } = await openPanel(ctx, "lp", "Harness Lean Panel", "12x16", LEAN_PANEL_ROOF, 8);
  try {
    // ── the lean-to ──
    const meet = field(page, "Lean-to meets the building").locator("select");
    await meet.waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 600);
    let d3 = await saveCal(page, calls);
    ok("panel: a lean-to style saved untouched is exactly what it stored (no attach written)", sameRoof(d3.roof, LEAN_PANEL_ROOF), JSON.stringify(d3.roof));
    const opts = await meet.locator("option").allInnerTexts();
    ok("panel: 'Lean-to meets the building' offers At the eave / On the wall / On the roof, at the eave", JSON.stringify(opts) === JSON.stringify(["At the eave", "On the wall, below the eave", "On the roof, above the eave"]) && (await meet.inputValue()) === "", JSON.stringify(opts));
    ok("panel: no distance box until a place is picked", (await field(page, "How far (ft)").count()) === 0);
    await meet.selectOption("roof");
    await settle(page, 500);
    const far = field(page, "How far (ft)").locator("input");
    let txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: picking 'On the roof' starts at 1 ft and reads back what it builds", (await far.inputValue()) === "1" && /Builds [\d.]+ in 12 · meets the roof 1' 0" above the eave/.test(txt), txt);
    d3 = await saveCal(page, calls);
    ok("panel: save carries the word and the number (roof, 1)", d3.roof.leanToAttach === "roof" && d3.roof.leanToAttachFt === 1, JSON.stringify(d3.roof));
    const el = await elevationText(page);
    ok("panel: the drawing shows the lean-to where it meets", /1' 0" up the roof/.test(el) && /lean-to, [\d.]+ in 12/.test(el), el.slice(0, 300));
    await typeNumber(page, far, 1.5);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: 1.5 ft up the roof reads 1' 6\" and a slope of about 3.8 in 12", /Builds 3\.8 in 12 · meets the roof 1' 6" above the eave/.test(txt), txt);
    if (shots) await field(page, "Lean-to meets the building").locator("xpath=..").screenshot({ path: join(shots, "panel-leanto-roof.png") });
    if (shots) { const svg = page.locator("svg").filter({ hasText: "up the roof" }).first(); if (await svg.count()) await svg.screenshot({ path: join(shots, "elevation-leanto-roof.png") }); }
    // With the lean-to drawn on the left, the wall-height dimension measures the building's own wall:
    // it stands inside that wall, not out beside the lean-to's shorter posts.
    const tick = await page.evaluate(() => {
      const svg = [...document.querySelectorAll("svg")].find((s) => /up the roof/.test(s.textContent));
      if (!svg) return null;
      const wall = svg.querySelector("rect");
      const lab = [...svg.querySelectorAll("text")].find((t) => t.textContent === "wall");
      return wall && lab ? { rx: Number(wall.getAttribute("x")), rw: Number(wall.getAttribute("width")), tx: Number(lab.getAttribute("x")) } : null;
    });
    ok("panel: the drawing's wall height sits against the building's wall, not the lean-to's posts", tick && tick.tx > tick.rx && tick.tx < tick.rx + tick.rw / 2, JSON.stringify(tick));
    d3 = await saveCal(page, calls);
    ok("panel: save roof, 1.5", d3.roof.leanToAttach === "roof" && d3.roof.leanToAttachFt === 1.5, JSON.stringify(d3.roof));
    // A 3.5 ft drop makes it steeper than the 4.8:12 it sits on, wherever it meets: the warning names the
    // drop and the width that cure it (moving it up the roof never does), and each one does.
    const drop = field(page, "Lean-to drop (ft)").locator("input");
    await typeNumber(page, drop, 3.5);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: steeper than the roof: says so, and the drop or width that fixes it", /steeper than the roof it sits on, so the main roof's edge pokes through it\. Set the lean-to drop to 2' 11" or less, or make it at least 9' 5" wide\./.test(txt), txt);
    if (shots) await field(page, "Lean-to meets the building").locator("xpath=..").screenshot({ path: join(shots, "panel-leanto-cut.png") });
    await typeNumber(page, far, 2.5);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: ...and further up the roof it is still cut (the distance does not cure it)", /steeper than the roof it sits on/.test(txt), txt);
    await typeNumber(page, drop, 2.9);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: ...a 2.9 ft drop (under the 2' 11\" named) clears it", !/steeper than the roof/.test(txt), txt);
    await typeNumber(page, drop, 2);
    await typeNumber(page, far, 1.5);
    await meet.selectOption("wall");
    await settle(page, 400);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: switching to the wall keeps the distance and says 'below the eave'", /meets the wall 1' 6" below the eave/.test(txt) && !/hangs into/.test(txt), txt);
    // (fixes, 2026-09-29) Its roof now meets the wall under the eave: how high doors and windows there can go.
    ok("panel: on the wall it says how high doors and windows on that wall can go (6' 3\", 0.2 under where it meets)", /Doors and windows on the left wall need to stay under 6' 3" from the floor, or the lean-to roof crosses them\./.test(txt), txt);
    d3 = await saveCal(page, calls);
    ok("panel: save wall, 1.5", d3.roof.leanToAttach === "wall" && d3.roof.leanToAttachFt === 1.5, JSON.stringify(d3.roof));
    await typeNumber(page, far, 0.25);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: too close under the eave says the roof edge hangs into it, and how far down to go (0' 5\", solved)", /roof edge above hangs into the lean-to — meet the wall at least 0' 5" below the eave/.test(txt), txt);
    if (shots) await field(page, "Lean-to meets the building").locator("xpath=..").screenshot({ path: join(shots, "panel-leanto-wall-warning.png") });
    await typeNumber(page, far, 0.42);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: ...and meeting the wall that far down clears it", /meets the wall 0' 5" below the eave/.test(txt) && !/hangs into/.test(txt), txt);
    // (fixes, 2026-09-29) 0 is "at the eave", in the readout and the drawing, never 0' 0".
    await typeNumber(page, far, 0);
    txt = flat(await field(page, "How far (ft)").innerText());
    const el0 = await elevationText(page);
    ok("panel: on the wall at 0 it reads 'meets at the eave', and the drawing says 'at the eave'", /Builds [\d.]+ in 12 · meets at the eave/.test(txt) && !/0' 0"/.test(txt) && !/Doors and windows/.test(txt) && /at the eave\|lean-to/.test(el0) && !/0' 0" down/.test(el0), `${txt} | ${el0.slice(0, 200)}`);
    await meet.selectOption("");
    await settle(page, 400);
    d3 = await saveCal(page, calls);
    ok("panel: ⚠️ 'At the eave' deletes both keys — the style is back to what it stored", !has(d3.roof, "leanToAttach") && !has(d3.roof, "leanToAttachFt") && sameRoof(d3.roof, LEAN_PANEL_ROOF), JSON.stringify(d3.roof));

    // ── the wings ──
    ok("panel (lean-to): no page errors", errors.length === 0, JSON.stringify(errors).slice(0, 300));
    await page.close();
    // On a shed's HIGH side the unset lean-to hangs at the outside walls' height, 3 ft under that eave:
    // the option says so instead of promising the eave (review, 2026-09-29).
    ({ page, errors, calls } = await openPanel(ctx, "sp", "Harness Shed Panel", "12x16", { ...SHED, ...LEAN("left", { leanToDropFt: 1 }) }, 8));
    const smeet = field(page, "Lean-to meets the building").locator("select");
    await smeet.waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 600);
    const sopts = await smeet.locator("option").allInnerTexts();
    ok("panel: on a shed's high side the unset option reads 'At wall height, 3' 0\" below the eave'", sopts[0] === `At wall height, 3' 0" below the eave`, JSON.stringify(sopts));
    await smeet.selectOption("roof");
    await settle(page, 400);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: ...and 'On the roof' there says there is no roof above it to meet", /Builds [\d.]+ in 12 · meets at the eave/.test(txt) && /high side, with no roof above it to meet, so it meets at the eave/.test(txt), txt);
    // (fixes, 2026-09-29) ...built at the eave, the wall's 0, where the high eave's edge hangs into it: said,
    // as "On the wall" at 0 says it, with the distance that clears -- never switched.
    ok("panel: ...and that the high eave's roof edge hangs into it, and how far down the wall clears it", /The roof edge above hangs into the lean-to — pick "On the wall" and meet it at least 0' 4" below the eave\./.test(txt), txt);
    if (shots) await field(page, "Lean-to meets the building").locator("xpath=..").screenshot({ path: join(shots, "panel-leanto-high-roof.png") });
    await smeet.selectOption("wall");
    await settle(page, 400);
    await typeNumber(page, field(page, "How far (ft)").locator("input"), 0.34);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: ...and on the wall 0' 4\" down it clears", /meets the wall 0' 4" below the eave/.test(txt) && !/hangs into/.test(txt), txt);
    ok("panel (shed): no page errors", errors.length === 0, JSON.stringify(errors).slice(0, 300));
    await page.close();
    // ── (fixes, 2026-09-29) "On the wall" from nothing, the distance BUILT, a dormer under the lean-to ──
    ({ page, errors, calls } = await openPanel(ctx, "ls", "Harness Lean Seed", "12x16", LEAN_SEED_ROOF, 8));
    const lmeet = field(page, "Lean-to meets the building").locator("select");
    await lmeet.waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 600);
    await lmeet.selectOption("wall");
    await settle(page, 500);
    const lfar = field(page, "How far (ft)").locator("input");
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: 'On the wall' under the default 1 ft drop starts at half of it (0.5), a real slope and no warning", (await lfar.inputValue()) === "0.5" && /Builds 0\.8 in 12 · meets the wall 0' 6" below the eave/.test(txt) && !/slope back|nearly flat|hangs into/.test(txt) && /on the right wall need to stay under 7' 3"/.test(txt), txt);
    if (shots) await field(page, "Lean-to meets the building").locator("xpath=..").screenshot({ path: join(shots, "panel-leanto-wall-seed.png") });
    await typeNumber(page, lfar, 3);
    txt = flat(await field(page, "How far (ft)").innerText());
    const lel = await elevationText(page);
    ok("panel: 3 ft under a 1 ft drop reads back the 0' 11\" it is BUILT at, and says why", /Builds 0\.1 in 12 · meets the wall 0' 11" below the eave/.test(txt) && /Its outer edge is only 1' 0" below the eave, so it can't meet the wall lower than 0' 11" — drawn there, nearly flat\. Give it more drop or meet the wall higher\./.test(txt) && !/3' 0"/.test(txt), txt);
    ok("panel: ...and the drawing labels the 0' 11\" it draws, not the 3' 0\" asked", /0' 11" down the wall/.test(lel) && !/3' 0" down the wall/.test(lel), lel.slice(0, 300));
    if (shots) { const svg = page.locator("svg").filter({ hasText: "down the wall" }).first(); if (await svg.count()) await svg.screenshot({ path: join(shots, "elevation-leanto-wall-flat.png") }); }
    // Up the roof 1 ft, the lean-to lands 3.5 ft out; the gable dormer at the default 0.45 faces it at 3.7.
    await lmeet.selectOption("roof");
    await settle(page, 400);
    await typeNumber(page, lfar, 1);
    txt = flat(await field(page, "How far (ft)").innerText());
    let dtxt = flat(await field(page, /^Dormer position/).innerText());
    ok("panel: a dormer under the lean-to's roof is said in the lean-to's readout, with the position that clears it", /The dormer is under this roof\. Move it up the roof with Dormer position \(between 0 and 0\.35\), or pick "On the wall"\./.test(txt), txt);
    ok("panel: ...and in the dormer's own fields", /The dormer's window wall is under the lean-to's roof\. Move it up the roof with Dormer position \(between 0 and 0\.35\), or set the lean-to to "On the wall"\./.test(dtxt), dtxt);
    if (shots) await field(page, /^Dormer position/).screenshot({ path: join(shots, "panel-dormer-covered.png") });
    d3 = await saveCal(page, calls);
    ok("panel: ⚠️ said, never moved: the saved style keeps the builder's dormer (no position written) and the lean-to on the roof, 1 ft", !has(d3.roof, "dormerOffsetU") && d3.roof.leanToAttach === "roof" && d3.roof.leanToAttachFt === 1 && d3.roof.dormerWidthFt === 4, JSON.stringify(d3.roof));
    await typeNumber(page, field(page, /^Dormer position/).locator("input"), 0.35);
    txt = flat(await field(page, "How far (ft)").innerText());
    dtxt = flat(await field(page, /^Dormer position/).innerText());
    ok("panel: ...at the position it names, both lines go", !/dormer/i.test(txt) && !/under the lean-to's roof/.test(dtxt), `${txt} | ${dtxt}`);
    ok("panel (lean-to seed): no page errors", errors.length === 0, JSON.stringify(errors).slice(0, 300));
    await page.close();
    ({ page, errors, calls } = await openPanel(ctx, "tp", "Harness Tri Panel", "37x22", TRI_PANEL_ROOF, 10));
    const wmeet = field(page, "Wing roofs meet the middle section").locator("select");
    await wmeet.waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 800);
    d3 = await saveCal(page, calls);
    ok("panel: a wings style saved untouched is exactly what it stored", sameRoof(d3.roof, TRI_PANEL_ROOF), JSON.stringify(d3.roof));
    const wopts = await wmeet.locator("option").allInnerTexts();
    ok("panel: 'Wing roofs meet the middle section' offers Automatic / wall / roof, at Automatic, in the middle section's words", JSON.stringify(wopts) === JSON.stringify(["Automatic (raises the middle section if needed)", "On the wall, below its eave", "On the roof, above its eave"]) && (await wmeet.inputValue()) === "", JSON.stringify(wopts));
    let wel = await elevationText(page);
    ok("panel: today (Automatic) the 10 ft walls push the centre, and the drawing says 'centre, raised'", /centre, raised/.test(wel), wel.slice(0, 300));
    ok("panel: ...and the wing pitch is a box to type in", (await field(page, "Wing roof pitch (rise in 12)").locator("input").count()) === 1);
    if (shots) { const svg = page.locator("svg").filter({ hasText: "centre, raised" }).first(); if (await svg.count()) await svg.screenshot({ path: join(shots, "elevation-wings-auto.png") }); }
    await wmeet.selectOption("wall");
    await settle(page, 500);
    const wfar = field(page, "How far (ft)").locator("input");
    const pitchField = field(page, "Wing roof pitch (rise in 12)");
    let ptxt = flat(await pitchField.innerText());
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: 'On the wall' makes the wing pitch a readout of what it builds", (await pitchField.locator("input").count()) === 0 && /Builds 2\.9 in 12/.test(ptxt) && /Set by where the wing roof meets the middle section/.test(ptxt), ptxt);
    ok("panel: 1 ft is closer than the centre's eave allows: moved down, and said", /Moved down to 1' 1" so the middle roof's edge clears the wing roof/.test(txt), txt);
    wel = await elevationText(page);
    ok("panel: ⚠️ with an attach the drawing never says 'centre, raised' — the centre is the 14 ft asked", !/centre, raised/.test(wel) && /centre eave/.test(wel) && /14' 0"/.test(wel) && /meets the wall 1' 1" down/.test(wel), wel.slice(0, 300));
    if (shots) { const svg = page.locator("svg").filter({ hasText: "centre eave" }).first(); if (await svg.count()) await svg.screenshot({ path: join(shots, "elevation-wings-wall.png") }); }
    d3 = await saveCal(page, calls);
    ok("panel: save wall, 1 (the builder's number, not the clamped one), wingPitch kept", d3.roof.wingAttach === "wall" && d3.roof.wingAttachFt === 1 && d3.roof.wingPitch === 0.333, JSON.stringify(d3.roof));
    await typeNumber(page, wfar, 1.5);
    ptxt = flat(await pitchField.innerText());
    ok("panel: 1.5 ft down builds 2.5 in 12", /Builds 2\.5 in 12/.test(ptxt), ptxt);
    await wmeet.selectOption("roof");
    await settle(page, 500);
    txt = flat(await field(page, "How far (ft)").innerText());
    ptxt = flat(await pitchField.innerText());
    ok("panel: 'On the roof' reads back 'Meets the roof 1' 6\" above the middle section's eave' and its own slope", /Meets the roof 1' 6" above the middle section's eave/.test(txt) && /Builds [\d.]+ in 12/.test(ptxt) && !/Moved down|cuts/.test(txt), `${txt} | ${ptxt}`);
    if (shots) await field(page, "Wing roofs meet the middle section").locator("xpath=..").screenshot({ path: join(shots, "panel-wings-roof.png") });
    wel = await elevationText(page);
    if (shots) { const svg = page.locator("svg").filter({ hasText: "centre eave" }).first(); if (await svg.count()) await svg.screenshot({ path: join(shots, "elevation-wings-roof.png") }); }
    ok("panel: the drawing says where it meets", /meets the roof 1' 6" up/.test(wel), wel.slice(0, 300));
    d3 = await saveCal(page, calls);
    ok("panel: save roof, 1.5", d3.roof.wingAttach === "roof" && d3.roof.wingAttachFt === 1.5, JSON.stringify(d3.roof));
    // A centre taller than 10 + 8:12 x 12 = 18.04 cannot be reached from its roof at ANY distance: the
    // warning names the height that works, and the readout says where the wing roof really meets.
    const centreH = field(page, "Middle section's wall height (ft)").locator("input");
    await typeNumber(page, centreH, 19);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: a centre too tall to reach: says so, names 18' 0\", and reads back that it meets the wall", /too tall for the wing roofs to reach its roof, so they meet its wall\. Bring its walls down to 18' 0" or lower, or pick "On the wall"\./.test(txt) && /Meets the wall 0' \d+" below the middle section's eave/.test(txt), txt);
    if (shots) await field(page, "Wing roofs meet the middle section").locator("xpath=..").screenshot({ path: join(shots, "panel-wings-cannot.png") });
    wel = await elevationText(page);
    ok("panel: ...and the drawing says it meets the wall", /meets the wall 0' \d+" down/.test(wel), wel.slice(0, 300));
    await typeNumber(page, centreH, 18);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: ...at 18 ft it lands on the roof", /Meets the roof 1' 6" above the middle section's eave/.test(txt) && !/too tall/.test(txt), txt);
    // Asked under 1 ft over the walls, the centre is held there: the panel says so and the drawing's label
    // says "min.", never "raised".
    await typeNumber(page, centreH, 10.5);
    txt = flat(await field(page, "How far (ft)").innerText());
    wel = await elevationText(page);
    ok("panel: a centre asked at 10.5 over 10 ft walls is held at 11 and says so", /at least 1 ft above the outside walls, so it is drawn at 11' 0"/.test(txt) && /11' 0"\|centre, min\./.test(wel) && !/centre, raised/.test(wel), `${txt} | ${wel.slice(0, 300)}`);
    // (fixes, 2026-09-29) Blank, the middle stands 3 ft over a default 3:12 wing roof while an attach is set --
    // the stored 4:12 (hidden, its box a readout) no longer moves it -- and the placeholder prints that height.
    await centreH.click();
    await centreH.fill("");
    await page.keyboard.press("Tab");
    await settle(page, 400);
    wel = await elevationText(page);
    ok("panel: blank middle height with an attach: the placeholder says the 16' 0\" it builds (10 + 12 x 3:12 + 3), not the stored pitch's 17' 0\"", (await centreH.getAttribute("placeholder")) === `blank = 16' 0"` && /16' 0"\|centre eave/.test(wel), `${await centreH.getAttribute("placeholder")} | ${wel.slice(0, 200)}`);
    await typeNumber(page, centreH, 14);
    await wmeet.selectOption("");
    await settle(page, 400);
    d3 = await saveCal(page, calls);
    ok("panel: ⚠️ 'Automatic' deletes both keys — back to what it stored, pitch box back", !has(d3.roof, "wingAttach") && !has(d3.roof, "wingAttachFt") && sameRoof(d3.roof, TRI_PANEL_ROOF) && (await pitchField.locator("input").count()) === 1, JSON.stringify(d3.roof));
    await wmeet.selectOption("roof");
    await settle(page, 400);
    await typeNumber(page, field(page, "Lower wings, each (ft wide, 0 = none)").locator("input"), 0);
    d3 = await saveCal(page, calls);
    ok("panel: wings off (width 0) deletes the attach with every other wing key", !has(d3.roof, "wingAttach") && !has(d3.roof, "wingAttachFt") && !has(d3.roof, "wingWidthFt") && !has(d3.roof, "wingPitch"), keys(d3.roof));
    ok("panel (wings): no page errors", errors.length === 0, JSON.stringify(errors).slice(0, 300));
    await page.close();
    // ── (fixes, 2026-09-29) two wings an off-centre ridge lands differently: each said by its side ──
    ({ page, errors, calls } = await openPanel(ctx, "ow", "Harness Odd Wings", "24x30", ODD_WINGS_ROOF, 8));
    await field(page, "Wing roofs meet the middle section").locator("select").waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 800);
    txt = flat(await field(page, "How far (ft)").innerText());
    let optxt = flat(await field(page, "Wing roof pitch (rise in 12)").innerText());
    let owel = await elevationText(page);
    ok("panel: two wings that meet differently are read back side by side", /Left wing meets the roof 2' 6" above the middle section's eave; right wing meets the wall 0' 8" below the middle section's eave/.test(txt), txt);
    ok("panel: ...the warning names the one wing it is about", /too tall for the right wing roof to reach its roof, so it meets its wall\. Bring its walls down to 9' 10" or lower/.test(txt) && !/wing roofs/.test(txt), txt);
    ok("panel: ...the two slopes are labelled by side", /Builds left 6\.8 \/ right 2\.6 in 12/.test(optxt), optxt);
    ok("panel: ...and the drawing says each", /meets the roof 2' 6" up/.test(owel) && /meets the wall 0' 8" down/.test(owel), owel.slice(0, 300));
    if (shots) await field(page, "Wing roofs meet the middle section").locator("xpath=..").screenshot({ path: join(shots, "panel-wings-each.png") });
    await typeNumber(page, field(page, "How far (ft)").locator("input"), 0);
    txt = flat(await field(page, "How far (ft)").innerText());
    owel = await elevationText(page);
    ok("panel: on the roof at 0 the wing roof meets the middle section AT its eave, said so, never 0' 0\"", /Left wing meets the middle section at its eave; right wing meets the wall 0' 8" below/.test(txt) && !/0' 0"/.test(txt) && /meets at the eave/.test(owel), `${txt} | ${owel.slice(0, 200)}`);
  } catch (e) {
    ok("panel: ran to the end", false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    ok("panel: no page errors", errors.length === 0, JSON.stringify(errors).slice(0, 300));
    await page.close();
  }
}

const { browser, ctx } = await launch({ width: 1280, height: 900 });
const { ok, failed } = reporter();
const only = process.env.SS_CASES ? process.env.SS_CASES.split(",") : null;
const want = (k) => !only || only.includes(k);
try {
  const digests = process.env.SS_ATTACH_DIGEST ? {} : null;
  const shots = process.env.SS_SHOTS ? shotsDir("attach") : null;
  if (want("lean")) for (const c of LEAN_CASES) {
    if (digests && c.roof.leanToAttach) continue;
    try { await leanCase(ctx, c, ok, digests ? null : shots, digests); } catch (e) { ok(`lean ${c.id}: ran`, false, e && e.message); }
  }
  if (want("lean") && !digests) for (const c of DOOR_CASES) {
    try { await doorCase(ctx, c, ok, shots); } catch (e) { ok(`lean ${c.id}: ran`, false, e && e.message); }
  }
  if (want("wings")) for (const c of WING_CASES) {
    if (digests && c.roof.wingAttach) continue;
    try { await wingCase(ctx, c, ok, digests ? null : shots, digests); } catch (e) { ok(`wings ${c.id}: ran`, false, e && e.message); }
  }
  if (!digests && want("panel")) {
    try { await panelCheck(ctx, ok, shots); } catch (e) { ok("panel: ran", false, e && e.message); }
  }
  if (digests) writeFileSync(process.env.SS_ATTACH_DIGEST, JSON.stringify(digests, null, 1));
} finally {
  await browser.close();
}
const f = failed();
console.log(f.length ? `\n${f.length} check(s) FAILED` : "\nall checks passed");
process.exitCode = f.length ? 1 : 0;
