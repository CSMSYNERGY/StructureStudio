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
//
//   python -m http.server 8143 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8143 node tests/harness/attach.mjs      (SS_SHOTS=<dir> for the PNGs)
//   SS_ATTACH_DIGEST=<file> ...                                       (only write the no-attach digests)
//   SS_CASES=lean,wings,panel                                         (a subset)
//
// Exit 0 = every assertion held.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, BASE } from "./lib.mjs";

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
  { id: "sHigh-none", roof: { ...SHED, ...LEAN("left", { leanToDropFt: 1 }) }, want: { u: -6, y: 8, y1: 7 } },
  { id: "sHigh-wall", roof: { ...SHED, ...LEAN("left", { leanToDropFt: 1, leanToAttach: "wall", leanToAttachFt: 0.5 }) }, want: { u: -6, y: 10.5, y1: 10 } },
  { id: "sHigh-roof", roof: { ...SHED, ...LEAN("left", { leanToDropFt: 1, leanToAttach: "roof", leanToAttachFt: 1 }) }, want: { u: -6, y: 11, y1: 10, noRoof: true } },
];

// The Tri Home Carolyn drew on (09-28): 37 across the front gable end, 22 deep, 12 ft wings both sides
// at 4:12, the centre's eave asked at 14 under an 8:12 gable with a 1 ft overhang.
const TRI = { type: "gable", front: "gable", pitch: 0.67, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 12, wingPitch: 0.333, centerEaveFt: 14 };
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
      if (c.roof.leanToAttach === "roof" && !w.noRoof && !w.cuts) {
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
        } else {
          const d = dAsk, uIn = u0 - g.side * (d / k), run = w + d / k, p = (14 + d - H) / run;
          ok(`${tag}: the ${side} wing roof runs up onto the centre's roof to ${f3(d)} above its eave: (${f3(uIn)}, ${f3(14 + d)})`, Math.abs(g.ya - (14 + d)) < 1e-9 && Math.abs(g.uIn - uIn) < 1e-9 && !g.clamped && !g.cuts, JSON.stringify(g));
          ok(`${tag}: the ${side} wing's pitch is worked out from it (${f3(p * 12)} in 12), flatter than the centre's eave`, Math.abs(g.pitch - p) < 1e-9 && p < k, f3(g.pitch));
          const s = m.wings.find((q) => q.side === g.side).slabEnd;
          ok(`${tag}: the ${side} wing slab lands on the centre's roof there`, s && Math.abs(s.u - uIn) < 0.05 && Math.abs(s.y - (14 + d)) < 0.05, JSON.stringify(s));
          const pr = m.wings.find((q) => q.side === g.side).prism;
          ok(`${tag}: the ${side} wing's body closes the gable end up to the landing`, pr && Math.abs(pr.mx[1] - (14 + d)) < 0.01 && Math.abs(pr.mn[1] - H) < 0.01, JSON.stringify(pr && { minY: pr.mn[1], maxY: pr.mx[1] }));
          const reach = g.side < 0 ? -m.centreReach.neg : m.centreReach.pos;
          ok(`${tag}: the centre's own roof stops at the ${side} landing (reaches ${f3(reach)} of ${f3(Math.abs(uIn))}), no eave of its own under the wing`, reach <= Math.abs(uIn) + 0.3, f3(reach));
        }
      }
      if (mode === "roof") ok(`${tag}: no clerestory: the wing roofs cover the centre's walls`, m.clerestory.length === 0, String(m.clerestory.length));
    }
    if (shots && /^tri10-(auto|wall|roof)$/.test(c.id)) {
      const mode = c.id.split("-")[1];
      await shot(page, join(shots, `trihome-${mode}-corner.png`), [-34, 21, 42], [-2, 10, 0]);
      await shot(page, join(shots, `trihome-${mode}-front.png`), [0, 13, 58], [0, 12, 0]);
    }
    ok(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally { await page.close(); }
}


// ── 3. the panel ─────────────────────────────────────────────────────────────────────────────
const LEAN_PANEL_ROOF = { ...GABLE, leanToWidthFt: 8, leanToDropFt: 2, leanToSide: "left" };
const TRI_PANEL_ROOF = { ...TRI };
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
    d3 = await saveCal(page, calls);
    ok("panel: save roof, 1.5", d3.roof.leanToAttach === "roof" && d3.roof.leanToAttachFt === 1.5, JSON.stringify(d3.roof));
    await meet.selectOption("wall");
    await settle(page, 400);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: switching to the wall keeps the distance and says 'below the eave'", /meets the wall 1' 6" below the eave/.test(txt) && !/hangs into/.test(txt), txt);
    d3 = await saveCal(page, calls);
    ok("panel: save wall, 1.5", d3.roof.leanToAttach === "wall" && d3.roof.leanToAttachFt === 1.5, JSON.stringify(d3.roof));
    await typeNumber(page, far, 0.25);
    txt = flat(await field(page, "How far (ft)").innerText());
    ok("panel: too close under the eave says the roof edge hangs into it, and how far down to go", /roof edge above hangs into the lean-to — meet the wall at least \d+' \d+" below the eave/.test(txt), txt);
    if (shots) await field(page, "Lean-to meets the building").locator("xpath=..").screenshot({ path: join(shots, "panel-leanto-wall-warning.png") });
    await meet.selectOption("");
    await settle(page, 400);
    d3 = await saveCal(page, calls);
    ok("panel: ⚠️ 'At the eave' deletes both keys — the style is back to what it stored", !has(d3.roof, "leanToAttach") && !has(d3.roof, "leanToAttachFt") && sameRoof(d3.roof, LEAN_PANEL_ROOF), JSON.stringify(d3.roof));

    // ── the wings ──
    ok("panel (lean-to): no page errors", errors.length === 0, JSON.stringify(errors).slice(0, 300));
    await page.close();
    ({ page, errors, calls } = await openPanel(ctx, "tp", "Harness Tri Panel", "37x22", TRI_PANEL_ROOF, 10));
    const wmeet = field(page, "Wing roofs meet the centre").locator("select");
    await wmeet.waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 800);
    d3 = await saveCal(page, calls);
    ok("panel: a wings style saved untouched is exactly what it stored", sameRoof(d3.roof, TRI_PANEL_ROOF), JSON.stringify(d3.roof));
    const wopts = await wmeet.locator("option").allInnerTexts();
    ok("panel: 'Wing roofs meet the centre' offers Automatic / wall / roof, at Automatic", JSON.stringify(wopts) === JSON.stringify(["Automatic (raises the centre if needed)", "On the wall, below the centre eave", "On the roof, above the centre eave"]) && (await wmeet.inputValue()) === "", JSON.stringify(wopts));
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
    ok("panel: 'On the wall' makes the wing pitch a readout of what it builds", (await pitchField.locator("input").count()) === 0 && /Builds 2\.9 in 12/.test(ptxt) && /Set by where the wing roof meets the centre/.test(ptxt), ptxt);
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
    ok("panel: 'On the roof' reads back 'Meets the roof 1' 6\" above the centre eave' and its own slope", /Meets the roof 1' 6" above the centre eave/.test(txt) && /Builds [\d.]+ in 12/.test(ptxt) && !/Moved down|cuts/.test(txt), `${txt} | ${ptxt}`);
    if (shots) await field(page, "Wing roofs meet the centre").locator("xpath=..").screenshot({ path: join(shots, "panel-wings-roof.png") });
    wel = await elevationText(page);
    if (shots) { const svg = page.locator("svg").filter({ hasText: "centre eave" }).first(); if (await svg.count()) await svg.screenshot({ path: join(shots, "elevation-wings-roof.png") }); }
    ok("panel: the drawing says where it meets", /meets the roof 1' 6" up/.test(wel), wel.slice(0, 300));
    d3 = await saveCal(page, calls);
    ok("panel: save roof, 1.5", d3.roof.wingAttach === "roof" && d3.roof.wingAttachFt === 1.5, JSON.stringify(d3.roof));
    await wmeet.selectOption("");
    await settle(page, 400);
    d3 = await saveCal(page, calls);
    ok("panel: ⚠️ 'Automatic' deletes both keys — back to what it stored, pitch box back", !has(d3.roof, "wingAttach") && !has(d3.roof, "wingAttachFt") && sameRoof(d3.roof, TRI_PANEL_ROOF) && (await pitchField.locator("input").count()) === 1, JSON.stringify(d3.roof));
    await wmeet.selectOption("roof");
    await settle(page, 400);
    await typeNumber(page, field(page, "Lower wings, each (ft wide, 0 = none)").locator("input"), 0);
    d3 = await saveCal(page, calls);
    ok("panel: wings off (width 0) deletes the attach with every other wing key", !has(d3.roof, "wingAttach") && !has(d3.roof, "wingAttachFt") && !has(d3.roof, "wingWidthFt") && !has(d3.roof, "wingPitch"), keys(d3.roof));
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
