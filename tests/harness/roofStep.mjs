// THE ROOF STEP — two roof sections along the ridge, measured off the scene graph.
//
// roof.rearStepFt / roof.rearEaveRiseFt (2026-09-28): the rear section's roof starts at a joint
// rearStepFt from the BACK wall, its eave (wall plate and fascia) stands rearEaveRiseFt higher (or,
// negative, lower) than the front's, and the ridges stay level. The pure numbers are pinned by
// _shared/_test_stubs/roofStep_test.ts; this script proves the SHIPPED compiled bundle builds them,
// in the real designer with a hand-written config, through __SS3D_DEBUG (window.__ss3dEngine):
//
//   1. the long walls stand at the rear eave (H + rise) behind the joint and at H in front of it,
//      the back gable wall at H + rise end to end, the front wall at H; the back corner boards reach
//      the rear eave
//   2. the two prisms: the rear one from the back to the joint on the rear eave, the front one from
//      the joint to the front on H, and both peak at the SAME ridge, H + (S/2) x pitch
//   3. each section's eave fascia hangs where its own eave puts it, so the rear fascia's top is the
//      rise higher, less what its flatter pitch drops over the overhang; the ridge caps meet level
//   4. the wedge: one fascia-coloured board per long side at the joint, on the LOWER section's side,
//      deepest at the eave (at least the step between the two fascias, reaching from the lower
//      fascia's top to the higher one's), closing to under an inch at the ridge
//   5. a negative rise mirrors all of it: the rear walls are shorter and the wedge stands on the
//      rear side of the joint
//   6. an old-frame portrait style (no front) with an open eave, lap siding, a gable vent and a plate
//      band: the back cap's vent and band sit the rise higher, and no two rafter tails share a place
//      at the joint; a dormer over the joint is seated on the lower roof and draws, and a dormer
//      wholly behind the joint of a HIGHER rear section sits on the rear roof, not buried in it
//   7. ABSENT KEYS BUILD THE SAME BUILDING, mesh for mesh (positions, uvs, transforms, materials,
//      order): a step of 0, a rise of 0, either key alone, both keys on a landscape old-frame size
//      (its ridge runs side to side) and both keys beside wings
//   8. zero page errors
//
//   python -m http.server 8125 --bind 127.0.0.1                  (repo root)
//   node tests/harness/roofStep.mjs                              (SS_SHOTS=<dir> for the PNGs)
//
// Exit 0 = every assertion held.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir } from "./lib.mjs";

const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const COLORS = { body: "#3a3d3f", trim: "#2a2d30", roof: "#2c3036", corner: "#2a2d30", fascia: "#25292e", wood: "#7a3432" };
// THE BLACK CABIN, as measured off its walk-around: 14 ft wide by 40 ft deep, a gable front with a
// recessed 6 ft porch and a king-post truss, 5:12, a 1.3 ft fascia eave, 7.75 ft walls; the rear
// 14 ft has its own roof with its eave about 0.6 ft higher, and the ridges line up.
const CABIN = { type: "gable", front: "gable", pitch: 0.41, overhang: 1.3, eave: "fascia", porchDepthFt: 6, porchEnd: "front", porchTruss: true };
const STEP = { rearStepFt: 14, rearEaveRiseFt: 0.6 };
const cabin = (roof, more = {}) => ({ roof, siding: "batten", colors: COLORS, wallHeightFt: 7.75, roofMaterial: "metal", foundation: "skids", ...more });
const TRI = { type: "gable", front: "gable", pitch: 0.5, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 6, wingPitch: 0.25, centerEaveFt: 14 };
const OLD = { type: "gable", pitch: 0.45, overhang: 0.8, eave: "open", tailSpacingIn: 24, plateBand: true, dormerWidthFt: 6, dormerOffsetU: 0.5 };

const CASES = [
  { id: "cabin", label: "Harness Step Cabin", size: "14x40", H: 7.75, d3: cabin({ ...CABIN, ...STEP }), shots: true },
  { id: "cabin-plain", label: "Harness Plain Cabin", size: "14x40", H: 7.75, d3: cabin(CABIN), shots: true, digest: true },
  { id: "cabin-lower", label: "Harness Lower Rear", size: "14x40", H: 7.75, d3: cabin({ ...CABIN, rearStepFt: 12, rearEaveRiseFt: -0.75 }) },
  { id: "old", label: "Harness Old Frame Step", size: "12x32", H: 8, d3: { roof: { ...OLD, rearStepFt: 14, rearEaveRiseFt: 0.5 }, siding: "lap", colors: COLORS, wallHeightFt: 8, gableVent: { widthFrac: 0.2 } } },
  // The dormer (13..19 ft from the back wall) wholly on a rear section that stands 0.5 ft higher.
  { id: "old-rear-dormer", label: "Harness Rear Dormer", size: "12x32", H: 8, d3: { roof: { ...OLD, rearStepFt: 24, rearEaveRiseFt: 0.5 }, siding: "lap", colors: COLORS, wallHeightFt: 8 } },
  // Absent keys: each of these must be the plain building, mesh for mesh.
  { id: "off-step0", label: "Harness Off Step Zero", size: "14x40", H: 7.75, d3: cabin({ ...CABIN, rearStepFt: 0, rearEaveRiseFt: 0.6 }), digestOf: "cabin-plain" },
  { id: "off-rise0", label: "Harness Off Rise Zero", size: "14x40", H: 7.75, d3: cabin({ ...CABIN, rearStepFt: 14, rearEaveRiseFt: 0 }), digestOf: "cabin-plain" },
  { id: "off-step-only", label: "Harness Off Step Only", size: "14x40", H: 7.75, d3: cabin({ ...CABIN, rearStepFt: 14 }), digestOf: "cabin-plain" },
  { id: "off-rise-only", label: "Harness Off Rise Only", size: "14x40", H: 7.75, d3: cabin({ ...CABIN, rearEaveRiseFt: 0.6 }), digestOf: "cabin-plain" },
  { id: "land-plain", label: "Harness Landscape Plain", size: "24x14", H: 8, d3: cabin({ type: "gable", pitch: 0.4, overhang: 0.6, porchDepthFt: 5 }), digest: true },
  { id: "land-keys", label: "Harness Landscape Keys", size: "24x14", H: 8, d3: cabin({ type: "gable", pitch: 0.4, overhang: 0.6, porchDepthFt: 5, ...STEP }), digestOf: "land-plain" },
  { id: "wings-plain", label: "Harness Wings Plain", size: "24x28", H: 9, d3: cabin(TRI, { wallHeightFt: 9 }), digest: true },
  { id: "wings-keys", label: "Harness Wings Keys", size: "24x28", H: 9, d3: cabin({ ...TRI, ...STEP }, { wallHeightFt: 9 }), digestOf: "wings-plain" },
];

const configFor = (c) => {
  const [w, l] = c.size.split("x").map(Number);
  return {
    clientId: "harness-roof-step",
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "step", label: c.label, img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: c.d3 }],
    defaultSizes: [c.size],
    sizePricing: { step: { [c.size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { step: CLADS }, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
  };
};
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const f3 = (v) => (v == null || !Number.isFinite(Number(v)) ? String(v) : Number(v).toFixed(3));

async function openCase(ctx, c) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: configFor(c), fixtures: FIXTURES });
  await openDesigner(page, "harness-roof-step");
  await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 40000 });
  const picked = await page.evaluate((lab) => {
    const el = [...document.querySelectorAll("div,span,p,strong,b")].find((e) => e.children.length === 0 && (e.textContent || "").trim() === lab && e.offsetParent);
    if (el) el.click();
    return !!el;
  }, c.label);
  if (!picked) throw new Error(`no style tile labelled ${c.label}`);
  await settle(page, 600);
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
  return { page, errors };
}

// Every mesh, in scene order, down to its vertices, uvs, transform and material colours: two builds
// with the same digest built the same building. snap.mjs's digest, the one the legacy snapshot uses.
async function digest(page) {
  const rows = await page.evaluate(() => {
    const M = window.__ss3dEngine.model;
    M.root.updateMatrixWorld(true);
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    const out = [];
    const walk = (o, path) => {
      if (o.isMesh) {
        const g = o.geometry, attr = (a) => (a ? Array.from(a.array, r6).join(",") : "");
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        out.push([path, g.type, attr(g.attributes.position), attr(g.attributes.uv), g.index ? Array.from(g.index.array).join(",") : "",
          JSON.stringify(g.groups || []), Array.from(o.matrixWorld.elements, r6).join(","),
          ms.map((m) => (m && m.color ? m.color.getHexString() : "-")).join("|"), JSON.stringify(o.userData || {}), o.visible].join(" "));
      }
      o.children.forEach((ch, i) => walk(ch, path + "/" + i));
    };
    walk(M.root, "r");
    return out;
  });
  return { n: rows.length, hash: createHash("sha256").update(rows.join("\n")).digest("hex"), rows };
}

async function measure(page) {
  return page.evaluate(() => {
    const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const bb = (q) => {
      if (!q.geometry.boundingBox) q.geometry.computeBoundingBox();
      const b = q.geometry.boundingBox, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const v = new V(x, y, z).applyMatrix4(q.matrixWorld);
        [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
      }
      return { mn, mx };
    };
    const verts = (q) => {
      const p = q.geometry.attributes.position, out = [];
      for (let i = 0; i < p.count; i++) { const v = new V().fromBufferAttribute(p, i).applyMatrix4(q.matrixWorld); out.push([v.x, v.y, v.z]); }
      return out;
    };
    const out = { step: M.roofStep || null, walls: {}, prisms: [], wedges: [], fascias: [], caps: [], corners: [], louvers: [], bands: [], tails: [], dormers: [] };
    M.wallsGroup.children.forEach((g) => {
      if (!g.userData || !g.userData.wall) return;
      const pieces = [];
      g.traverse((q) => { if (q.isMesh && q.material === M.wallMat && q.geometry.type === "BoxGeometry") pieces.push(bb(q)); });
      out.walls[g.userData.wall] = pieces;
    });
    M.roofGroup.traverse((q) => {
      if (!q.isMesh || !q.geometry) return;
      const ud = q.userData || {}, g = q.geometry, pr = g.parameters || {};
      if (ud.ssRoofStep === "wedge") { out.wedges.push({ side: ud.ssRoofStepSide, ...bb(q), v: verts(q), fascia: q.material === M.fasciaMat }); return; }
      if (g.type === "ExtrudeGeometry" && Array.isArray(q.material) && !ud.ssPorchPart && !ud.ssWing) { out.prisms.push({ rear: ud.ssRoofStep === "rear", ...bb(q) }); return; }
      if (g.type !== "BoxGeometry") return;
      const b = bb(q);
      if (q.material === M.fasciaMat && b.mx[0] - b.mn[0] < 0.2 && b.mx[2] - b.mn[2] > 2) out.fascias.push(b);
      else if (Math.abs(pr.width - 0.55) < 1e-9 && Math.abs(pr.height - 0.06) < 1e-9) out.caps.push(b);
      else if (q.parent === M.roofGroup && q.material === M.cornerMat) out.corners.push(b);
      else if (ud.ssPorch === "band") out.bands.push(b);
      else if (q.material && q.material.color && q.material.color.getHexString() === "2a2e33" && q.material.map) out.louvers.push(b);
      else if (Math.abs(pr.height - 0.34) < 1e-9 && Math.abs(pr.depth - 0.125) < 1e-9) out.tails.push(b);
      else if (Math.abs(pr.width - 2) < 1e-9) out.dormers.push(b);
    });
    return out;
  });
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

// The fascia's top over an eave at plate height `plate` under pitch `p` with an overhang `ov`:
// buildSlope's eaveY (the plate less the overhang's drop along the slope), plus the board's lift off
// the slope line (edgeY) and 0.06 (fasTop). The same whichever way the overhang is framed.
const fasciaTop = (plate, p, ov) => { const th = Math.atan(p); return plate - ov * Math.sin(th) + 0.12 * Math.cos(th) + 0.06; };

async function runCase(ctx, c, ok, shots, digests) {
  const [W, L] = c.size.split("x").map(Number);
  const tag = `${c.id} ${c.size}`;
  const { page, errors } = await openCase(ctx, c);
  try {
    if (c.digest || c.digestOf) digests[c.id] = await digest(page);
    const m = await measure(page);
    if (c.digest || c.digestOf) {
      ok(`${tag}: no step is built`, !m.step && m.wedges.length === 0 && !m.prisms.some((p) => p.rear), JSON.stringify(m.step));
    } else {
      const roof = c.d3.roof, H = c.H, st = m.step;
      ok(`${tag}: the model built a step (${st && `${st.stepFt} ft, rise ${st.rise}`})`, !!st && st.stepFt === roof.rearStepFt && Math.abs(st.rise - roof.rearEaveRiseFt) < 1e-9, JSON.stringify(st));
      if (!st) return;
      const rise = st.rise, Hb = H + rise, zJ = -L / 2 + st.stepFt, S = W, pitch = roof.pitch, pitchB = st.pitchB;
      const ridge = H + (S / 2) * pitch;
      ok(`${tag}: the rear pitch brings its ridge level: pitch - rise / half-span`, Math.abs(pitchB - (pitch - rise / (S / 2))) < 1e-12 && Math.abs(Hb + (S / 2) * pitchB - ridge) < 1e-9, `pitchB ${f3(pitchB)}`);
      // 1. walls
      // The wall's top where it stands, a foot either side of the joint: the tallest piece there.
      const topAt = (pieces, z) => pieces.filter((b) => b.mn[2] <= z && b.mx[2] >= z).reduce((a, b) => Math.max(a, b.mx[1]), -Infinity);
      // The wall's own panels (a wall thick; not the battens or lap courses on them): one plane, above
      // the joint's step and below it.
      const panels = (pieces) => pieces.filter((b) => b.mx[0] - b.mn[0] > 0.29);
      for (const wall of ["west", "east"]) {
        const P = m.walls[wall], tr = topAt(P, zJ - 1), tf = topAt(P, zJ + 1), tBack = topAt(P, -L / 2 + 0.5);
        ok(`${tag}: the ${wall} wall stands at the rear eave (${f3(Hb)}) behind the joint and at H (${H}) in front, one plane`,
          Math.abs(tr - Hb) < 1e-6 && Math.abs(tBack - Hb) < 1e-6 && Math.abs(tf - H) < 1e-6
            && panels(P).every((q) => Math.abs(q.mx[0] - panels(P)[0].mx[0]) < 1e-6 && Math.abs(q.mn[0] - panels(P)[0].mn[0]) < 1e-6),
          `behind ${f3(tr)} front ${f3(tf)} back end ${f3(tBack)}`);
      }
      const north = m.walls.north.reduce((a, b) => Math.max(a, b.mx[1]), -Infinity), south = m.walls.south.reduce((a, b) => Math.max(a, b.mx[1]), -Infinity);
      ok(`${tag}: the back gable wall stands at the rear eave, the front at H`, Math.abs(north - Hb) < 1e-6 && Math.abs(south - H) < 1e-6, `north ${f3(north)} south ${f3(south)}`);
      const backCorners = m.corners.filter((b) => b.mx[2] < 0), frontCorners = m.corners.filter((b) => b.mn[2] > 0);
      ok(`${tag}: the back corner boards reach the rear eave, the front ones H`,
        backCorners.length === 2 && backCorners.every((b) => Math.abs(b.mx[1] - Hb) < 1e-6) && frontCorners.every((b) => Math.abs(b.mx[1] - H) < 1e-6),
        JSON.stringify(m.corners.map((b) => [f3(b.mx[2]), f3(b.mx[1])])));
      // 2. prisms
      const rearP = m.prisms.find((p) => p.rear), frontP = m.prisms.find((p) => !p.rear);
      ok(`${tag}: two prisms, the rear one from the back to the joint on the rear eave, the front one from the joint on H`,
        m.prisms.length === 2 && rearP && frontP && Math.abs(rearP.mx[2] - zJ) < 1e-6 && Math.abs(frontP.mn[2] - zJ) < 1e-6
          && Math.abs(rearP.mn[1] - Hb) < 1e-6 && Math.abs(frontP.mn[1] - H) < 1e-6,
        JSON.stringify(m.prisms.map((p) => ({ rear: p.rear, z: [f3(p.mn[2]), f3(p.mx[2])], y: [f3(p.mn[1]), f3(p.mx[1])] }))));
      ok(`${tag}: ⚠️ THE RIDGES ARE LEVEL: both prisms peak at ${f3(ridge)}`, rearP && frontP && Math.abs(rearP.mx[1] - ridge) < 1e-6 && Math.abs(frontP.mx[1] - ridge) < 1e-6, `${f3(rearP && rearP.mx[1])} / ${f3(frontP && frontP.mx[1])}`);
      const capsR = m.caps.filter((b) => b.mx[2] <= zJ + 1e-6), capsF = m.caps.filter((b) => b.mn[2] >= zJ - 1e-6);
      const capTop = (list) => list.reduce((a, b) => Math.max(a, b.mx[1]), -Infinity);
      ok(`${tag}: the ridge caps meet level across the joint (within half an inch)`, capsR.length === 2 && capsF.length === 2 && Math.abs(capTop(capsR) - capTop(capsF)) < 0.04, `${f3(capTop(capsR))} / ${f3(capTop(capsF))}`);
      // 3. the eave fascia of each section
      const ov = roof.overhang;
      if (roof.eave !== "open") {
        for (const s of [-1, 1]) {
          const side = m.fascias.filter((b) => Math.sign(b.mn[0]) === s);
          const fr = side.find((b) => b.mn[2] >= zJ - 1e-6), rr = side.find((b) => b.mx[2] <= zJ + 1e-6);
          const wantF = fasciaTop(H, pitch, ov), wantR = fasciaTop(Hb, pitchB, ov);
          ok(`${tag}: the ${s < 0 ? "west" : "east"} fascias follow their sections: front top ${f3(wantF)}, rear top ${f3(wantR)} (${f3((wantR - wantF) * 12)} in apart)`,
            fr && rr && Math.abs(fr.mx[1] - wantF) < 1e-4 && Math.abs(rr.mx[1] - wantR) < 1e-4 && Math.abs(rr.mx[2] - zJ) < 1e-6 && Math.abs(fr.mn[2] - zJ) < 1e-6,
            JSON.stringify({ front: fr && [f3(fr.mx[1]), f3(fr.mn[2])], rear: rr && [f3(rr.mx[1]), f3(rr.mx[2])] }));
        }
      }
      // 4. the wedge
      ok(`${tag}: one fascia-coloured wedge per long side`, m.wedges.length === 2 && m.wedges.every((w) => w.fascia) && new Set(m.wedges.map((w) => w.side)).size === 2, String(m.wedges.length));
      for (const w of m.wedges) {
        const u = (v) => Math.abs(v[0]);
        const uOut = Math.max(...w.v.map(u)), uIn = Math.min(...w.v.map(u));
        const at = (uu) => w.v.filter((v) => Math.abs(u(v) - uu) < 1e-6).map((v) => v[1]);
        const outer = at(uOut), inner = at(uIn);
        const outerSpan = Math.max(...outer) - Math.min(...outer), innerSpan = Math.max(...inner) - Math.min(...inner);
        const side = w.side < 0 ? "west" : "east";
        ok(`${tag}: the ${side} wedge stands on the LOWER section's side of the joint, 0.06 ft thick`,
          rise > 0 ? Math.abs(w.mn[2] - zJ) < 1e-6 && Math.abs(w.mx[2] - zJ - 0.06) < 1e-6 : Math.abs(w.mx[2] - zJ) < 1e-6 && Math.abs(w.mn[2] - zJ + 0.06) < 1e-6,
          `${f3(w.mn[2])}..${f3(w.mx[2])} joint ${f3(zJ)}`);
        ok(`${tag}: the ${side} wedge is deepest at the eave (${f3(outerSpan)} ft, the rise ${f3(Math.abs(rise))} or more) and closes at the ridge (${f3(innerSpan)} ft)`,
          outerSpan >= Math.abs(rise) && innerSpan < 0.06 && uIn < 1, `inner u ${f3(uIn)} outer u ${f3(uOut)}`);
        if (roof.eave !== "open") {
          const sideF = m.fascias.filter((b) => Math.sign(b.mn[0]) === w.side);
          const lo = rise > 0 ? sideF.find((b) => b.mn[2] >= zJ - 1e-6) : sideF.find((b) => b.mx[2] <= zJ + 1e-6);
          const hi = rise > 0 ? sideF.find((b) => b.mx[2] <= zJ + 1e-6) : sideF.find((b) => b.mn[2] >= zJ - 1e-6);
          ok(`${tag}: ⚠️ NO GAP at the ${side} eave: the wedge runs from the lower fascia's top up to the higher fascia's, and out to its face`,
            lo && hi && Math.min(...outer) <= lo.mx[1] + 0.03 && Math.max(...outer) >= hi.mx[1] - 0.03 && uOut >= Math.max(Math.abs(hi.mn[0]), Math.abs(hi.mx[0])) - 1e-6,
            JSON.stringify({ wedge: [f3(Math.min(...outer)), f3(Math.max(...outer)), f3(uOut)], lo: lo && f3(lo.mx[1]), hi: hi && [f3(hi.mx[1]), f3(Math.max(Math.abs(hi.mn[0]), Math.abs(hi.mx[0])))] }));
        }
      }
      // 6. the old-frame style's vents, band, tails and dormer
      if (c.id === "old") {
        const back = m.louvers.filter((b) => b.mx[2] < 0), front = m.louvers.filter((b) => b.mn[2] > 0);
        ok(`${tag}: a vent on each cap, the back one sitting the rise higher (its own gable)`,
          back.length === 1 && front.length === 1 && Math.abs((back[0].mn[1] - front[0].mn[1]) - rise) < 1e-6, JSON.stringify({ back: back.map((b) => f3(b.mn[1])), front: front.map((b) => f3(b.mn[1])) }));
        const bb = m.bands.filter((b) => b.mx[2] < 0), fb = m.bands.filter((b) => b.mn[2] > 0);
        ok(`${tag}: the plate band on the back cap stands on the rear eave`, bb.length === 1 && fb.length === 1 && Math.abs((bb[0].mx[1] - fb[0].mx[1]) - rise) < 1e-6, JSON.stringify({ back: bb.map((b) => f3(b.mx[1])), front: fb.map((b) => f3(b.mx[1])) }));
        const zs = {};
        let dup = 0;
        for (const t of m.tails) { const k = `${Math.sign(t.mn[0] + t.mx[0])}:${((t.mn[2] + t.mx[2]) / 2).toFixed(3)}`; if (zs[k]) dup++; zs[k] = 1; }
        const rearT = m.tails.filter((t) => t.mx[2] < zJ - 0.05).length, frontT = m.tails.filter((t) => t.mn[2] > zJ - 0.1).length;
        ok(`${tag}: rafter tails under both sections, and no two of them in one place at the joint`, dup === 0 && rearT > 4 && frontT > 4, `dup ${dup} rear ${rearT} front ${frontT}`);
        // It reaches over the joint (6 ft wide at mid-length, the joint 2 ft behind its middle), so it is
        // seated on the LOWER roof under it, the front one here: its base on the front slope at dU.
        const dU = (S / 2) * roof.dormerOffsetU, seat = H + (S / 2 - dU) * pitch;
        ok(`${tag}: a dormer over the joint is seated on the lower roof under it (${f3(seat)}), not floating`,
          m.dormers.length === 1 && Math.abs(m.dormers[0].mn[1] - seat) < 0.05 && m.dormers[0].mn[2] < zJ && m.dormers[0].mx[2] > zJ, JSON.stringify(m.dormers.map((b) => [f3(b.mn[1]), f3(b.mn[2]), f3(b.mx[2])])));
      }
      // A dormer wholly behind the joint sits on the REAR roof: its base on the rear slope at dU, the
      // rear eave Hb plus the rest of the half-span at the rear pitch. The front plane there is
      // lower, and a dormer seated on it stood buried in the higher rear roof.
      if (c.id === "old-rear-dormer") {
        const dU = (S / 2) * roof.dormerOffsetU, seat = Hb + (S / 2 - dU) * pitchB, frontSeat = H + (S / 2 - dU) * pitch;
        ok(`${tag}: ⚠️ a dormer wholly behind the joint sits on the higher rear roof (${f3(seat)}), not on the front plane (${f3(frontSeat)})`,
          m.dormers.length === 1 && Math.abs(m.dormers[0].mn[1] - seat) < 0.05 && Math.abs(m.dormers[0].mn[1] - frontSeat) > 0.2 && m.dormers[0].mx[2] < zJ,
          JSON.stringify(m.dormers.map((b) => [f3(b.mn[1]), f3(b.mn[2]), f3(b.mx[2])])));
      }
    }
    if (shots && c.shots) {
      const name = c.id === "cabin" ? "cabin-step" : "cabin-nostep";
      await shot(page, join(shots, `${name}-side.png`), [54, 7.5, 0], [0, 6, 0]);
      await shot(page, join(shots, `${name}-front.png`), [0, 6.5, 48], [0, 6.5, 0]);
      await shot(page, join(shots, `${name}-front34.png`), [26, 13, 40], [0, 6, 2]);
      await shot(page, join(shots, `${name}-back34.png`), [-24, 13, -40], [0, 6, -4]);
      await shot(page, join(shots, `${name}-joint.png`), [13, 10.5, -1], [6.5, 8.2, -7]);
    }
    if (shots && c.id === "cabin-lower") await shot(page, join(shots, "cabin-lower-rear-back34.png"), [-24, 13, -40], [0, 6, -4]);
    if (shots && c.id === "old") await shot(page, join(shots, "old-frame-step-back34.png"), [-20, 12, -34], [0, 6, -3]);
    ok(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await page.close();
  }
}

const { browser, ctx } = await launch({ width: 1400, height: 1000 });
const { ok, failed } = reporter();
try {
  const shots = process.env.SS_SHOTS ? shotsDir("roofStep") : null;
  const digests = {};
  const only = process.env.SS_CASES ? process.env.SS_CASES.split(",") : null;
  for (const c of CASES) {
    if (only && !only.includes(c.id)) continue;
    try { await runCase(ctx, c, ok, shots, digests); } catch (e) { ok(`${c.id}: ran`, false, e && e.message); }
  }
  // 7. absent keys: the same building, mesh for mesh.
  for (const c of CASES.filter((q) => q.digestOf)) {
    const a = digests[c.id], b = digests[c.digestOf];
    if (!a || !b) continue;
    const diff = a.rows.filter((r, i) => r !== b.rows[i]);
    ok(`⚠️ ${c.id} builds EXACTLY ${c.digestOf} (${b.n} meshes: vertices, uvs, transforms, materials, order)`, a.hash === b.hash && a.n === b.n, `${a.n} vs ${b.n}, ${diff.length} differ: ${diff.slice(0, 1).join(" | ").slice(0, 200)}`);
  }
} finally {
  await browser.close();
}
const f = failed();
console.log(f.length ? `\n${f.length} check(s) FAILED` : "\nall checks passed");
process.exitCode = f.length ? 1 : 0;
