// EACH WING SET ON ITS OWN (roof.wingSides, 2026-09-29), measured off the scene graph and driven on the
// Advanced page.
//
// Carolyn, 09-29, on the Advanced page: "I want this wing to be like this and this wing to be like this,
// and the same thing on the lean-tos". roof.wingSides = { left?, right?, front?, back? }, each
// { widthFt, pitch, attach "auto"|"roof"|"wall", attachFt }, overrides the shared wing keys for that one
// side; roof.wingSide still says which sides carry a wing. The pure numbers are pinned by
// _shared/_test_stubs/wingsMassing_test.ts. This script proves the SHIPPED compiled bundle builds them:
//
//   D  WITHOUT wingSides nothing moves: every wing style below (both sides, one side, on the wall, on
//      the roof, one that cannot reach the roof, a gambrel, the new frame with a porch, a lean-to off a
//      wing, a transom dormer, a footprint too narrow for the width asked, a front-eave building) builds
//      the same scene graph, mesh for mesh, as the bundle before this change.
//      SS_WINGSIDES_DIGEST=<file> writes the digests; SS_WINGSIDES_BASE=<file> compares against them.
//   S  with wingSides, each wing is built from its own numbers: two widths (the middle section moves
//      over, its walls stand on each wing's own line), two pitches, one wing on the wall and the other
//      Automatic (the automatic one still pushes the middle up to clear itself, the attached one follows
//      the middle), one on the roof and one on the wall, and a pair wider than the footprint leaves room
//      for (shrunk in proportion). Each wing's slab ends where its own massing says, each clerestory
//      stands on its own wing's line, from under its own wing roof up to the middle's eave.
//   A  THE ADVANCED PAGE (portal Workspace -> Advanced, Wings tab): one "Middle section wall height"
//      control, then a card per eave side, each with its own switch, width, "Meets the middle section"
//      and pitch. Driven: a 10 ft right wing beside a 4 ft left one on the wall builds two different
//      wings in the page's own 3D; turning the right wing off leaves the left; Save carries wingSides
//      and the shared keys equal to the first wing's.
//   R  THE REVIEW FIXES (2026-09-30): twin Automatic wings that push the middle up are named together;
//      a middle both under the 1 ft rule and pushed gives the push alone; a front/back building's cards
//      run Back then Front, as the End view draws them, and no "Auto draws" when no wing is drawn; at
//      390 px each card's "Meets the middle section" is one row of three.
//   cal the calibration panel keeps its wing controls and says each wing is set on the Advanced page.
//
//   python -m http.server 8311 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8311 node tests/harness/wingSides.mjs     (SS_SHOTS=<dir> for the PNGs)
//   SS_CASES=D,S,A,R,cal                                               (a subset)
//
// Exit 0 = every assertion held.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, BASE, REF, PASS_THROUGH_GET } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOF_T = 0.2, WALL_T = 0.3;
const COLORS = { body: "#e9e4d8", trim: "#5b5f63", roof: "#3b4a5c", wood: "#a8703f" };
const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };
const f3 = (v) => (v == null || !Number.isFinite(Number(v)) ? String(v) : Number(v).toFixed(3));
const settle = (page, ms = 400) => page.waitForTimeout(ms);
// The page keeps a number and its unit together with no-break spaces; the checks read plain ones.
const sp = (t) => String(t).replace(/ /g, " ");

// ── the cases ────────────────────────────────────────────────────────────────────────────────
// The Tri Home as wings.mjs draws it: 24 across the gable end, 28 deep, 9 ft outer walls, 8 ft wings at
// 3:12, the centre's eave at 17 ft under a 6:12 gable. A portrait footprint: the eave sides are west/east.
const TRI = { type: "gable", pitch: 0.5, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 8, wingPitch: 0.25, centerEaveFt: 17 };
// The Tri Home Carolyn drew on (attach.mjs): 37 across the front gable end, 22 deep, 12 ft wings at 4:12.
const TRI37 = { type: "gable", front: "gable", pitch: 0.67, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 12, wingPitch: 0.333, centerEaveFt: 14 };
const D = (id, size, H, roof, extra = {}) => ({ id, size, H, d3: { roof, siding: "batten", colors: COLORS, wallHeightFt: H, roofMaterial: "metal", ...extra } });
const DIGEST_CASES = [
  D("tri-both", "24x28", 9, TRI),
  D("tri-left", "24x28", 9, { ...TRI, wingSide: "left" }, { siding: "lap" }),
  D("tri-right-open", "20x28", 8, { ...TRI, wingSide: "right", wingWidthFt: 6, eave: "open", centerEaveFt: 15 }, { siding: "panel" }),
  D("tri-pushed", "24x28", 9, { ...TRI, centerEaveFt: 11.5 }),
  D("tri-wall", "24x28", 9, { ...TRI, wingPitch: 1.2, wingAttach: "wall", wingAttachFt: 2 }),
  D("tri-roof", "24x28", 9, { ...TRI, centerEaveFt: 11, wingAttach: "roof", wingAttachFt: 1 }),
  D("tri37-wall", "37x22", 10, { ...TRI37, wingAttach: "wall", wingAttachFt: 1.5 }),
  D("tri37-cannot", "37x22", 8, { ...TRI37, pitch: 5 / 12, wingAttach: "roof", wingAttachFt: 1 }),
  D("gambrel", "24x32", 10, { type: "gambrel", overhang: 0.6, wingSide: "both", wingWidthFt: 7, wingPitch: 0.3 }),
  D("front-porch", "28x20", 9, { type: "gable", front: "gable", pitch: 0.67, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 8, wingPitch: 0.2, centerEaveFt: 15, porchOutFt: 6, porchEnd: "front" }),
  D("lean-off-wing", "24x28", 9, { ...TRI, leanToWidthFt: 6, leanToDropFt: 1.5, leanToSide: "right", leanToAttach: "roof", leanToAttachFt: 0.5 }),
  D("dormer-roof", "37x22", 10, { ...TRI37, dormerWidthFt: 5, dormerType: "transom", dormerRiseFt: 1.5, dormerOffsetU: 0.6, wingAttach: "roof", wingAttachFt: 1 }),
  D("narrow", "16x20", 8, { ...TRI, wingWidthFt: 8, centerEaveFt: 14 }),
  D("front-eave", "28x20", 9, { type: "gable", front: "eave", pitch: 0.5, overhang: 1, eave: "fascia", wingSide: "back", wingWidthFt: 6, wingPitch: 0.25 }),
];

// Each wing on its own. `want` is worked out by hand from the rules (d3Massing's header), in the
// building's own u (world x here: a portrait footprint), per side: w, pitch, u0 (the centre wall line),
// ya (where its roof meets the middle), uIn (where it ends: u0 unless it lands on the roof).
const SIDE_CASES = [
  // Two widths and two pitches, both Automatic. The steeper right wing (ya 14) pushes the middle from the
  // 14.5 asked up to 15 (ya + 1); the left wing's own clearance (11.5) would not have.
  { id: "widths", size: "24x28", H: 9, roof: { ...TRI, centerEaveFt: 14.5, wingSides: { left: { widthFt: 6 }, right: { widthFt: 10, pitch: 0.5 } } },
    want: { Hc: 15, hcRaised: true, Sc: 8, uc: -2, wings: { "-1": { w: 6, pitch: 0.25, u0: -6, ya: 10.5 }, "1": { w: 10, pitch: 0.5, u0: 2, ya: 14 } } } },
  // One wing on the wall, the other Automatic at 9:12 (ya 13.5): the automatic one pushes the middle to
  // 14.5, and the attached one meets its wall 1 ft under THAT eave (13.5), its pitch worked out: 4.5 / 8.
  { id: "mixed", size: "24x28", H: 9, roof: { ...TRI, centerEaveFt: 14, wingSides: { left: { widthFt: 8, attach: "wall", attachFt: 1 }, right: { widthFt: 6, pitch: 0.75, attach: "auto" } } },
    want: { Hc: 14.5, hcRaised: true, Sc: 10, uc: 1, wings: { "-1": { w: 8, pitch: 4.5 / 8, u0: -4, ya: 13.5, attach: "wall" }, "1": { w: 6, pitch: 0.75, u0: 6, ya: 13.5 } } } },
  // One on the roof, one on the wall, the middle exactly as asked (12). Left: 7 ft, lands 1 ft up the
  // 6:12 roof, 2 ft in from its wall; right: 8 ft, 1 ft under the eave.
  { id: "roofwall", size: "24x28", H: 9, roof: { ...TRI, centerEaveFt: 12, wingSides: { left: { widthFt: 7, attach: "roof", attachFt: 1 }, right: { widthFt: 8, attach: "wall", attachFt: 1 } } },
    want: { Hc: 12, hcRaised: false, Sc: 9, uc: -0.5, wings: { "-1": { w: 7, pitch: 4 / 9, u0: -5, ya: 13, uIn: -3, attach: "roof" }, "1": { w: 8, pitch: 2 / 8, u0: 4, ya: 11, attach: "wall" } } } },
  // A pair wider than the footprint leaves room for: 12 + 8 on a 16 ft span, which keeps 4 ft of middle,
  // shrinks both in proportion (7.2 and 4.8). Automatic, the middle as asked.
  { id: "shrunk", size: "16x20", H: 8, roof: { ...TRI, centerEaveFt: 14, wingSides: { left: { widthFt: 12 }, right: { widthFt: 8 } } },
    want: { Hc: 14, hcRaised: false, Sc: 4, uc: 1.2, wings: { "-1": { w: 7.2, pitch: 0.25, u0: -0.8, ya: 9.8 }, "1": { w: 4.8, pitch: 0.25, u0: 3.2, ya: 9.2 } } } },
];

const configFor = (label, size, d3) => {
  const [w, l] = size.split("x").map(Number);
  return {
    clientId: "harness-wingsides",
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "wsd", label, img: null, sizes: [size], sizeInclusions: {}, sizeInclusionQty: {}, d3 }],
    defaultSizes: [size],
    sizePricing: { wsd: { [size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { wsd: CLADS }, wallHeightOptions: {},
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
  await openDesigner(page, "harness-wingsides");
  await pickStyle(page, label);
  await chooseSize(page, size);
  await openEditor(page);
  return { page, errors };
}

// The wings.mjs / attach.mjs digest: every mesh's world bbox (1/1000 ft) and material colour, order-independent.
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

// Each wing as built, in the building's own profile u: its slab's inner end (the corner of the slab's
// underside nearest the middle), its body's u reach, its clerestory's u, foot and top, and the massing.
async function measure(page, getEngine) {
  return page.evaluate(({ ROOF_T, getEngine }) => {
    const E = new Function(`return (${getEngine})();`)();
    const M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const m = M.massing;
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
      const a = uOf({ x: mn[0], z: mn[2] }), b = uOf({ x: mx[0], z: mx[2] });
      return { mn, mx, uMin: Math.min(a, b), uMax: Math.max(a, b) };
    };
    const slabEnd = (q, towardU) => {
      const p = q.geometry.parameters;
      const pts = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) pts.push(new V(sx * p.width / 2, sy * p.height / 2, 0).applyMatrix4(q.matrixWorld));
      pts.sort((a, b) => Math.abs(uOf(a) - towardU) - Math.abs(uOf(b) - towardU));
      const end = pts.slice(0, 2).sort((a, b) => a.y - b.y);
      return { u: uOf(end[0]), y: end[0].y };
    };
    const wings = m.wings.map((g) => {
      const tagged = [];
      M.roofGroup.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssWing === g.side) tagged.push(q); });
      const slab = tagged.filter((q) => q.geometry.type === "BoxGeometry" && Math.abs(q.geometry.parameters.height - ROOF_T) < 1e-9 && q.geometry.parameters.width > 3)
        .sort((a, b) => b.geometry.parameters.width - a.geometry.parameters.width)[0];
      const body = tagged.find((q) => q.geometry.type === "ExtrudeGeometry");
      // The slab's pitch as built: its rotation about the length.
      const pitch = slab ? Math.abs(Math.tan(slab.rotation.z)) : null;
      return { side: g.side, slabEnd: slab ? slabEnd(slab, m.uc) : null, slabPitch: pitch, body: body ? bbOf(body) : null, n: tagged.length };
    });
    const clerestory = [];
    M.wallsGroup.children.forEach((q) => { if (q.userData && q.userData.clerestory) { const b = bbOf(q); clerestory.push({ side: q.userData.clerestory, uMid: (b.uMin + b.uMax) / 2, minY: b.mn[1], maxY: b.mx[1] }); } });
    return { massing: JSON.parse(JSON.stringify(m)), wings, clerestory };
  }, { ROOF_T, getEngine: getEngine.toString() });
}
const viewerEngine = () => window.__ss3dEngine;
const panelEngine = () => window.__ss3dPanel;

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

// Checks one wing against its expected numbers, off the massing the model was built from and the meshes.
function checkWings(tag, got, want, ok) {
  const m = got.massing;
  ok(`${tag}: the middle's eave is ${f3(want.Hc)}${want.hcRaised ? ", pushed up by an automatic wing" : ", as asked"}`,
    Math.abs(m.Hc - want.Hc) < 1e-6 && !!m.hcRaised === want.hcRaised, `${f3(m.Hc)} raised=${m.hcRaised}`);
  ok(`${tag}: the middle section is ${f3(want.Sc)} wide, its middle ${f3(want.uc)} across`, Math.abs(m.Sc - want.Sc) < 1e-6 && Math.abs(m.uc - want.uc) < 1e-6, `${f3(m.Sc)} ${f3(m.uc)}`);
  for (const [side, w] of Object.entries(want.wings)) {
    const s = Number(side), name = s < 0 ? "left" : "right";
    const g = m.wings.find((q) => q.side === s);
    const b = got.wings.find((q) => q.side === s);
    const c = got.clerestory.find((q) => q.side === s);
    ok(`${tag}: the ${name} wing is ${f3(w.w)} wide at ${f3(w.pitch * 12)} in 12, meeting the middle at ${f3(w.ya)}`,
      g && Math.abs(g.w - w.w) < 1e-6 && Math.abs(g.pitch - w.pitch) < 1e-6 && Math.abs(g.u0 - w.u0) < 1e-6 && Math.abs(g.ya - w.ya) < 1e-6
      && (w.attach ? g.attach === w.attach : g.attach === undefined), JSON.stringify(g));
    // The slab, as built: its pitch and where its inner end stops.
    ok(`${tag}: the ${name} wing's roof slab is built at its own pitch (${f3(b && b.slabPitch * 12)} in 12)`, b && b.slabPitch != null && Math.abs(b.slabPitch - w.pitch) < 1e-6, JSON.stringify(b && b.slabPitch));
    const uIn = w.uIn != null ? w.uIn : w.u0 + s * WALL_T / 2;
    // Landed, the slab stops square where it lands; at a wall its underside runs a hair past the
    // clerestory's outer face into the wall (attach.mjs's tolerance), on the wing's own line.
    const endOk = b && b.slabEnd && (w.uIn != null ? Math.abs(b.slabEnd.u - uIn) < 0.05 && Math.abs(b.slabEnd.y - w.ya) < 0.05
      : (uIn - b.slabEnd.u) * s >= -0.01 && (uIn - b.slabEnd.u) * s <= 0.15 && Math.abs(b.slabEnd.y - (m.H + Math.abs(b.slabEnd.u - s * m.S / 2) * w.pitch)) < 0.04);
    ok(`${tag}: …and ends at u ${f3(uIn)}, ${w.uIn != null ? "up on the middle's roof" : "at its own clerestory's face"}`, endOk, JSON.stringify(b && b.slabEnd));
    ok(`${tag}: …its body reaches from the outer wall (${f3(s * (m.S / 2))}) in to it`, b && b.body && Math.abs((s < 0 ? b.body.uMin : b.body.uMax) - s * m.S / 2) < 0.05
      && Math.abs((s < 0 ? b.body.uMax : b.body.uMin) - uIn) < 0.05, JSON.stringify(b && b.body && [b.body.uMin, b.body.uMax]));
    if (w.uIn == null) {
      ok(`${tag}: the ${name} clerestory stands on its own wing's line (${f3(w.u0)}), from under its roof (${f3(w.ya)}) to the middle's eave`,
        c && Math.abs(c.uMid - w.u0) < 0.1 && c.minY <= w.ya + 1e-6 && Math.abs(c.maxY - want.Hc) < 0.15, JSON.stringify(c));
    } else {
      ok(`${tag}: a wing that lands on the middle's roof leaves no clerestory on that side`, !c, JSON.stringify(c));
    }
  }
}

// ── D. without wingSides, nothing moves ─────────────────────────────────────────────────────
async function digestCase(ctx, c, ok, digests, base) {
  const { page, errors } = await openCase(ctx, `Harness WS ${c.id}`, c.size, c.d3);
  try {
    const dg = await digest(page);
    if (digests) digests[c.id] = dg;
    if (base) {
      const b = base[c.id];
      const same = b && b.length === dg.length && b.every((x, i) => x === dg[i]);
      const diff = b ? dg.filter((x) => !b.includes(x)).slice(0, 3).concat(b.filter((x) => !dg.includes(x)).slice(0, 3)) : ["no base digest"];
      ok(`D ${c.id}: no wingSides, the same scene graph as before (${dg.length} meshes)`, same, JSON.stringify(diff));
    }
    ok(`D ${c.id}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally { await page.close(); }
}

// ── S. each wing from its own numbers ────────────────────────────────────────────────────────
async function sideCase(ctx, c, ok, shots) {
  const tag = `S ${c.id}`;
  const d3 = { roof: c.roof, siding: "batten", colors: COLORS, wallHeightFt: c.H, roofMaterial: "metal" };
  const { page, errors } = await openCase(ctx, `Harness WS ${c.id}`, c.size, d3);
  try {
    const got = await measure(page, viewerEngine);
    console.log(`   ${tag}: Hc ${f3(got.massing.Hc)} Sc ${f3(got.massing.Sc)} uc ${f3(got.massing.uc)}; ` + got.massing.wings.map((g) => `${g.side < 0 ? "L" : "R"} w ${f3(g.w)} p ${f3(g.pitch)} ya ${f3(g.ya)} ${g.attach || "auto"}`).join("; "));
    checkWings(tag, got, c.want, ok);
    if (shots) {
      const [W] = c.size.split("x").map(Number);
      await shot(page, join(shots, `3d-${c.id}-end.png`), [0, c.want.Hc * 0.6, W * 1.9], [0, c.want.Hc * 0.55, 0]);
      await shot(page, join(shots, `3d-${c.id}-corner.png`), [-W * 1.2, c.want.Hc * 1.1, W * 1.5], [0, c.want.Hc * 0.5, 0]);
    }
    ok(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally { await page.close(); }
}

// ── A. the Advanced page ─────────────────────────────────────────────────────────────────────
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const OURS = "harness-internal";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000047", aud: "authenticated", role: "authenticated", email: "ws@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const ADV_CONFIG = {
  branding: { companyName: "Harness Internal", accentColor: "#3D3672", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  buildingStyles: [{ value: "hcabin", label: "Harness Cabin", sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }],
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, siding: "batten", colors: { body: "#9B2F2F", trim: "#F4F1EA", roof: "#3E434A" }, wallHeightFt: 8 } }],
  defaultSizes: [], options: [],
  layoutItems: { door: { label: "Door", icon: "D", color: "#8B4513", width: 40, height: 12, shortLabel: "D" } },
  wallHeightFt: 8,
};
const ENT = { reason: "internal", status: "active", granted: ["view_3d"], features: { view_3d: true }, exempt: true, state: "exempt" };
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

async function openAdvanced(browser, viewport = { width: 1440, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    window.__SS3D_DEBUG = true;
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const calls = [];
  let made = 0;
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => {
    const req = route.request();
    if (req.method() === "GET" && PASS_THROUGH_GET.test(req.url())) return route.continue();
    return route.abort();
  });
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      if (rpc[1] === "get_config") return json(route, ADV_CONFIG);
      if (rpc[1] === "get_fixtures") return json(route, []);
      return json(route, rpc[1] === "log_error" ? null : false);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: OURS, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) return json(route, { ok: true, configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, entitlement: ENT });
    if (url.includes("/portal-settings")) {
      calls.push({ action: body.action, body });
      if (body.action === "status") return json(route, { ok: true, clientId: OURS, role: "owner", settings: { business_name: OURS }, config: { company_name: OURS, accent_color: "#3D3672" }, access: null, prefs: null });
      if (body.action === "catalog") return json(route, { ok: true, aiReady: true, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      if (body.action === "create_style") { made++; return json(route, { ok: true, styleId: `00000000-0000-4000-8000-00000000b${String(made).padStart(3, "0")}`, key: "harness-wing-sides" }); }
      if (body.action === "save_style_d3") return json(route, { ok: true, updatedAt: "2026-09-29T10:00:00.000+00:00" });
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(`**/${REF}.storage.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  await page.goto(`${BASE}/portal/advanced`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForSelector('[data-ss-adv="sections"]', { timeout: 60000 });
  return { ctx, page, errors, calls };
}
async function advModel(page, test, timeout = 60000) {
  await page.waitForFunction((src) => {
    const P = window.__ss3dPanel;
    if (!(P && P.model && P.model.massing && P.renderer && P.renderer.domElement.isConnected && P.renderer.domElement.closest('[data-ss-adv="view"]'))) return false;
    return new Function("M", `return (${src})(M);`)(P.model);
  }, test.toString(), { timeout });
}
const fieldsIn = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-ss-adv-f]`)].filter((e) => e.offsetParent !== null).map((e) => e.dataset.ssAdvF), sel);
const card = (page, side) => page.locator(`[data-ss-adv-wing="${side}"]`);
const boxIn = (page, side, f) => page.locator(`[data-ss-adv-f="${f}-${side}"] input[type="number"]`);
async function typeBox(page, loc, v) {
  await loc.click();
  await loc.fill(String(v));
  await loc.blur();
  await settle(page, 350);
}
async function advShot(page, name, shots, view = "end") {
  if (!shots) return;
  // The page's own docked 3D, framed on the building from the gable end (where the two wings' roofs show
  // side by side) or from a corner, and rendered now: a docked panel's rAF may be starved.
  const cam = await page.evaluate((view) => {
    const P = window.__ss3dPanel;
    const m = P.model.massing;
    const W = m.uAxisIsX ? m.S : m.L, L = m.uAxisIsX ? m.L : m.S;
    const top = Math.max(m.Hc, ...m.prof.map((p) => p[1]));
    const eye = view === "end" ? [-W * 0.3, top * 0.8, L / 2 + W * 2.4] : [-W * 1.7, top * 1.9, L / 2 + W * 1.9];
    P.controls.target.set(0, top * 0.45, 0);
    P.camera.position.set(eye[0], eye[1], eye[2]);
    P.camera.lookAt(0, top * 0.45, 0);
    P.camera.updateProjectionMatrix();
    P.controls.update();
    P.render();
    return P.camera.position.toArray().map((v) => Math.round(v * 10) / 10);
  }, view);
  await settle(page, 250);
  await page.evaluate(() => window.__ss3dPanel.render());
  console.log(`   shot ${name}: camera ${JSON.stringify(cam)}`);
  await page.screenshot({ path: join(shots, name), fullPage: false });
}

async function advancedCheck(browser, ok, shots) {
  const { ctx, page, errors, calls } = await openAdvanced(browser);
  try {
    // A 24 x 28 building, so two wings of different widths have room.
    for (const [lab, v] of [["Width (ft)", 24], ["Length (ft)", 28]]) {
      const b = page.getByLabel(lab, { exact: true }).first();
      await b.fill(String(v)); await b.blur(); await settle(page, 300);
    }
    await page.locator('[data-ss-adv-sec="wings"]').click();
    await settle(page, 300);
    const sw = page.locator('[data-ss-adv-f="wingsOn"]');
    if (await sw.getAttribute("aria-pressed") !== "true") await sw.click();
    await settle(page, 500);
    await advModel(page, (M) => M.massing.wings.length === 2);
    // The layout: one shared middle height at the top, then a card per eave side.
    const flds = await fieldsIn(page, "[data-ss-adv-panel]");
    console.log(`   A: fields ${JSON.stringify(flds)}`);
    const cards = await page.$$eval("[data-ss-adv-wing]", (c) => c.map((x) => [x.dataset.ssAdvWing, (x.querySelector(".ssd-card-t") || {}).textContent]));
    ok("A: the Wings tab has one card per eave side, left then right", JSON.stringify(cards.map((c) => c[0])) === JSON.stringify(["left", "right"]), JSON.stringify(cards));
    ok("A: …each named in plain words", cards.every(([s, t]) => new RegExp(`${s} wing`, "i").test(t || "")), JSON.stringify(cards));
    const iHc = flds.indexOf("centerEaveFt"), iCard = flds.findIndex((f) => /-left$|-right$/.test(f));
    ok("A: one shared \"Middle section wall height\", above the cards", iHc >= 0 && flds.filter((f) => f === "centerEaveFt").length === 1 && iHc < iCard, JSON.stringify(flds));
    for (const s of ["left", "right"]) {
      const own = ["wingOn", "wingWidthFt", "wingAttach", "wingPitch"].map((f) => `${f}-${s}`);
      ok(`A: the ${s} card has its own switch, width, "Meets the middle section" and pitch`, own.every((f) => flds.includes(f)), JSON.stringify(flds));
      ok(`A: …its switch says the ${s} wing is on`, (await card(page, s).locator(`[data-ss-adv-f="wingOn-${s}"]`).innerText()).includes(`${s[0].toUpperCase()}${s.slice(1)} wing on`));
    }
    ok("A: …and each box is named for its own wing", (await page.getByLabel("Left wing width (ft)", { exact: true }).count()) === 1 && (await page.getByLabel("Right wing width (ft)", { exact: true }).count()) === 1);

    // Carolyn's "this wing like this and this wing like this": an 8 ft left wing meeting the middle section
    // on its wall 1 ft down, a 10 ft right wing left Automatic at 4 in 12, the middle's walls 14 ft.
    await typeBox(page, boxIn(page, "right", "wingWidthFt"), 10);
    await advModel(page, (M) => M.massing.wings.some((g) => g.side > 0 && Math.abs(g.w - 10) < 1e-6));
    await typeBox(page, boxIn(page, "left", "wingWidthFt"), 8);
    await card(page, "left").getByRole("button", { name: "On the wall", exact: true }).click();
    await settle(page, 400);
    await typeBox(page, page.getByLabel("Middle section wall height (ft)", { exact: true }), 14);
    await typeBox(page, boxIn(page, "right", "wingPitch"), 4);
    await advModel(page, (M) => M.massing.wings.some((g) => g.side < 0 && g.attach === "wall" && Math.abs(g.w - 8) < 1e-6) && Math.abs(M.massing.Hc - 14) < 1e-6
      && M.massing.wings.some((g) => g.side > 0 && Math.abs(g.pitch - 1 / 3) < 1e-6));
    const got = await measure(page, panelEngine);
    const L = got.massing.wings.find((g) => g.side < 0), R = got.massing.wings.find((g) => g.side > 0);
    console.log(`   A: Hc ${f3(got.massing.Hc)}; L w ${f3(L && L.w)} ${L && L.attach} ya ${f3(L && L.ya)} p ${f3(L && L.pitch)}; R w ${f3(R && R.w)} ${R && R.attach} p ${f3(R && R.pitch)} ya ${f3(R && R.ya)}`);
    ok("A: the page's own 3D builds an 8 ft left wing on the wall 1 ft under a 14 ft middle, its pitch worked out (7.5 in 12)",
      L && Math.abs(L.w - 8) < 1e-6 && L.attach === "wall" && Math.abs(L.ya - 13) < 1e-6 && Math.abs(L.pitch - 5 / 8) < 1e-6, JSON.stringify(L));
    ok("A: …and a 10 ft Automatic right wing at its own 4 in 12", R && Math.abs(R.w - 10) < 1e-6 && R.attach === undefined && Math.abs(R.pitch - 1 / 3) < 1e-6, JSON.stringify(R));
    ok("A: …the middle section 14 ft tall as asked, 6 ft wide, 1 ft left of centre", Math.abs(got.massing.Hc - 14) < 1e-6 && !got.massing.hcRaised
      && Math.abs(got.massing.Sc - 6) < 1e-6 && Math.abs(got.massing.uc - (-1)) < 1e-6, `${got.massing.Hc} ${got.massing.Sc} ${got.massing.uc}`);
    const bl = got.wings.find((q) => q.side < 0), br = got.wings.find((q) => q.side > 0);
    // Each slab's underside runs a hair past its own clerestory's outer face into the wall, never short of it.
    const pastFace = (b, face, s) => b && b.slabEnd && (face - b.slabEnd.u) * s >= -0.01 && (face - b.slabEnd.u) * s <= 0.25;
    ok("A: …the two slabs, at their own pitches, stop at their own clerestories (u -4 and +2)", pastFace(bl, -4 - WALL_T / 2, -1) && pastFace(br, 2 + WALL_T / 2, 1)
      && Math.abs(bl.slabPitch - 5 / 8) < 1e-6 && Math.abs(br.slabPitch - 1 / 3) < 1e-6, JSON.stringify([bl && bl.slabEnd, br && br.slabEnd, bl && bl.slabPitch, br && br.slabPitch]));
    const lSay = await card(page, "left").locator('[data-ss-adv-readout="wing-left"]').innerText().then(sp).catch(() => "");
    ok("A: the left card says where its roof meets the middle section", /meets the wall 1' 0" below the middle section's eave/i.test(lSay), lSay);
    ok("A: the right card, Automatic, keeps its own pitch box", (await boxIn(page, "right", "wingPitch").count()) === 1);
    const lPitch = await card(page, "left").locator('[data-ss-adv-f="wingPitch-left"]').innerText().then(sp);
    ok("A: the left card, on the wall, shows the pitch that builds", /Builds 7\.5 in 12/.test(lPitch), lPitch);
    const elev = await page.evaluate(() => [...document.querySelectorAll('[data-ss-adv="view"] svg text')].map((t) => t.textContent.trim()));
    ok("A: the End view dimensions each wing: 8' 0\" at 7.5 in 12 and 10' 0\" at 4:12", elev.includes("8' 0\"") && elev.includes("10' 0\"") && elev.includes("wing, 7.5 in 12") && elev.includes("wing, 4:12"), JSON.stringify(elev));
    await advShot(page, "adv-wings-left8-wall-right10-auto-end.png", shots, "end");
    await advShot(page, "adv-wings-left8-wall-right10-auto-corner.png", shots, "corner");
    if (shots) {
      await page.locator("[data-ss-adv-panel]").scrollIntoViewIfNeeded();
      await settle(page, 300);
      await page.locator("[data-ss-adv-panel]").screenshot({ path: join(shots, "adv-wings-cards.png") }).catch(() => {});
    }

    // The right wing steeper, 9 in 12, still Automatic: it pushes the middle up to clear itself (15.5 + 1),
    // the page says so, and the left wing, on the wall, follows the middle up.
    await typeBox(page, boxIn(page, "right", "wingPitch"), 9);
    await advModel(page, (M) => M.massing.wings.some((g) => g.side > 0 && Math.abs(g.pitch - 0.75) < 1e-6));
    const got2 = await measure(page, panelEngine);
    const R2 = got2.massing.wings.find((g) => g.side > 0), L2 = got2.massing.wings.find((g) => g.side < 0);
    ok("A: a 9 in 12 Automatic right wing pushes the middle up to 16' 6\"; the left one still meets it 1 ft down",
      Math.abs(got2.massing.Hc - 16.5) < 1e-6 && got2.massing.hcRaised && R2 && Math.abs(R2.pitch - 0.75) < 1e-6 && L2 && L2.attach === "wall" && Math.abs(L2.ya - 15.5) < 1e-6, JSON.stringify({ Hc: got2.massing.Hc, L2, R2 }));
    const push = await page.locator('[data-ss-adv-readout="wings-push"]').innerText().then(sp).catch(() => "");
    ok("A: …and says which wing pushed it", /right wing's roof, set to Automatic, pushes it up/.test(push) && /16' 6"/.test(push), push);
    await typeBox(page, boxIn(page, "right", "wingPitch"), 4);
    await advModel(page, (M) => Math.abs(M.massing.Hc - 14) < 1e-6);

    // Save: wingSides carries both sides; the shared keys are the first (left) wing's.
    await page.getByLabel("New style name").fill("Harness Wing Sides");
    await page.getByRole("button", { name: "Save as a new style" }).click();
    await page.waitForFunction(() => { const m = document.querySelector('[data-ss-adv="msg"]'); return m && /Saved as|failed|Couldn|isn't/.test(m.innerText); }, null, { timeout: 60000 });
    const sd = calls.filter((c) => c.action === "save_style_d3").pop();
    const roof = sd && sd.body.d3 && sd.body.d3.roof;
    console.log(`   A: saved roof ${JSON.stringify(roof)}`);
    ok("A: Save carries wingSides with each side's own numbers", roof && roof.wingSides && roof.wingSides.left && roof.wingSides.right
      && roof.wingSides.left.widthFt === 8 && roof.wingSides.left.attach === "wall" && roof.wingSides.left.attachFt === 1
      && roof.wingSides.right.widthFt === 10 && roof.wingSides.right.attach === "auto" && Math.abs(roof.wingSides.right.pitch - 1 / 3) < 1e-9, JSON.stringify(roof && roof.wingSides));
    ok("A: …and the shared keys equal the first wing's, for an older designer", roof && roof.wingSide === "both" && roof.wingWidthFt === 8 && roof.wingAttach === "wall" && roof.wingAttachFt === 1 && roof.centerEaveFt === 14, JSON.stringify(roof));

    // The right wing off: only the left one is left, and wingSide says so.
    await card(page, "right").locator('[data-ss-adv-f="wingOn-right"]').click();
    await settle(page, 400);
    await advModel(page, (M) => M.massing.wings.length === 1 && M.massing.wings[0].side < 0);
    ok("A: turning the right wing off leaves the left one", (await card(page, "right").locator('[data-ss-adv-f="wingOn-right"]').innerText()).includes("Add a right wing")
      && (await card(page, "left").locator('[data-ss-adv-f="wingOn-left"]').getAttribute("aria-pressed")) === "true");
    const L3 = (await measure(page, panelEngine)).massing.wings[0];
    ok("A: …8 ft, on the wall", L3 && Math.abs(L3.w - 8) < 1e-6 && L3.attach === "wall", JSON.stringify(L3));
    await advShot(page, "adv-wings-left-only.png", shots, "end");
    // …and back on: it comes back with its own 10 ft and 4 in 12.
    await card(page, "right").locator('[data-ss-adv-f="wingOn-right"]').click();
    await settle(page, 400);
    await advModel(page, (M) => M.massing.wings.length === 2);
    const R4 = (await measure(page, panelEngine)).massing.wings.find((g) => g.side > 0);
    ok("A: turned back on, the right wing remembers its 10 ft and 4 in 12", R4 && Math.abs(R4.w - 10) < 1e-6 && Math.abs(R4.pitch - 1 / 3) < 1e-6, JSON.stringify(R4));
    // Both off: the wings are off, every wing key gone (the master switch says "Add lower wings").
    await card(page, "right").locator('[data-ss-adv-f="wingOn-right"]').click();
    await settle(page, 300);
    await card(page, "left").locator('[data-ss-adv-f="wingOn-left"]').click();
    await settle(page, 400);
    await advModel(page, (M) => M.massing.wings.length === 0);
    ok("A: turning the last wing off turns the wings off", (await page.locator('[data-ss-adv-f="wingsOn"]').getAttribute("aria-pressed")) === "false");
    ok("A: no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally { await ctx.close(); }
}

// THE REVIEW FIXES (2026-09-30), on the page itself.
//   R1 twin Automatic wings pushing the middle up: the page says "the wing roofs", not one of them.
//   R2 one wing on the wall with the middle asked under walls + 1 ft, the other Automatic and pushing: ONE
//      warning, the push, naming the Automatic wing -- not the 1 ft rule as well, which gave the wrong reason.
//   R3 a building whose front is a long side (28 x 20): the cards run Back then Front, the way the End view
//      beside them draws the walls; and with the wing on a side the roof no longer has, the middle-height
//      note does not claim what Auto draws.
//   R4 at phone width the wing card's "Meets the middle section" is ONE row of three buttons.
const setSize = async (page, W, L) => {
  for (const [lab, v] of [["Width (ft)", W], ["Length (ft)", L]]) {
    const b = page.getByLabel(lab, { exact: true }).first();
    await b.fill(String(v)); await b.blur(); await settle(page, 300);
  }
};
const wingsOn = async (page) => {
  await page.locator('[data-ss-adv-sec="wings"]').click();
  await settle(page, 300);
  const sw = page.locator('[data-ss-adv-f="wingsOn"]');
  if (await sw.getAttribute("aria-pressed") !== "true") await sw.click();
  await settle(page, 500);
};
const hcText = (page) => page.locator('[data-ss-adv-f="centerEaveFt"]').innerText().then(sp).catch(() => "");
const pushText = (page) => page.locator('[data-ss-adv-readout="wings-push"]').innerText().then(sp).catch(() => "");
async function reviewCheck(browser, ok, shots) {
  {
    const { ctx, page, errors } = await openAdvanced(browser);
    try {
      await setSize(page, 24, 28);
      await wingsOn(page);
      await advModel(page, (M) => M.massing.wings.length === 2);
      // R1: two 4 ft Automatic wings at 3:12 under a middle asked at 6 ft: both push it up alike.
      await typeBox(page, page.getByLabel("Middle section wall height (ft)", { exact: true }), 6);
      await advModel(page, (M) => M.massing.hcRaised === true && M.massing.wings.length === 2);
      const m1 = (await measure(page, panelEngine)).massing;
      const p1 = await pushText(page);
      console.log(`   R1: Hc ${f3(m1.Hc)} raised ${m1.hcRaised}; "${p1}"`);
      ok("R1: twin Automatic wings push the middle up together, and the page says \"the wing roofs\"",
        m1.hcRaised && /the wing roofs, set to Automatic, push it up to fit/.test(p1) && !/left wing|right wing/.test(p1), p1);
      await advShot(page, "adv-review-twin-push-end.png", shots, "end");
      // R2: the left wing on the wall; the right one, Automatic, still pushes over the 1 ft floor.
      await card(page, "left").getByRole("button", { name: "On the wall", exact: true }).click();
      await settle(page, 400);
      await advModel(page, (M) => M.massing.wings.some((g) => g.side < 0 && g.attach === "wall") && M.massing.hcRaised === true);
      const m2 = (await measure(page, panelEngine)).massing;
      const t2 = await hcText(page), p2 = await pushText(page);
      console.log(`   R2: Hc ${f3(m2.Hc)} low ${m2.hcLow} raised ${m2.hcRaised}; "${p2}"`);
      ok("R2: one wing on the wall under a 6 ft middle, the other Automatic: the massing is both low and pushed", m2.hcLow === true && m2.hcRaised === true, JSON.stringify({ Hc: m2.Hc, low: m2.hcLow, raised: m2.hcRaised }));
      ok("R2: …the page gives the push, naming the right wing", /the right wing's roof, set to Automatic, pushes it up to fit/.test(p2), p2);
      ok("R2: …and not the 1 ft rule as well", !/must stand at least 1 ft above the outside walls/.test(t2), t2);
      // R3: only the left wing on, then the footprint turned so the long sides are front and back.
      await card(page, "right").locator('[data-ss-adv-f="wingOn-right"]').click();
      await settle(page, 400);
      await advModel(page, (M) => M.massing.wings.length === 1);
      await setSize(page, 28, 20);
      await advModel(page, (M) => M.massing.wings.length === 0);
      const ax = await page.evaluate(() => window.__ss3dPanel.model.massing.uAxisIsX);
      const order = await page.$$eval("[data-ss-adv-wing]", (c) => c.map((x) => x.dataset.ssAdvWing));
      const t3 = await hcText(page);
      console.log(`   R3: uAxisIsX ${ax}; cards ${JSON.stringify(order)}; "${t3.slice(0, 160)}"`);
      ok("R3: on a 28 x 20 the long sides are the eave walls, and the cards run Back then Front, as the End view draws them",
        ax === false && JSON.stringify(order) === JSON.stringify(["back", "front"]), `${ax} ${JSON.stringify(order)}`);
      ok("R3: …with the left wing on a side this roof has no wing on, no \"Auto draws\" for a middle that is not drawn", !/Auto draws/.test(t3) && /not drawn/.test(await page.locator("[data-ss-adv-panel]").innerText()), t3);
      // Both on: two wings along the front and back, and the note is back.
      await card(page, "back").locator('[data-ss-adv-f="wingOn-back"]').click();
      await settle(page, 400);
      await card(page, "front").locator('[data-ss-adv-f="wingOn-front"]').click();
      await settle(page, 400);
      await typeBox(page, boxIn(page, "front", "wingWidthFt"), 6);
      await advModel(page, (M) => M.massing.wings.length === 2 && M.massing.wings.some((g) => g.wall === "south" && Math.abs(g.w - 6) < 1e-6));
      const m3 = (await measure(page, panelEngine)).massing;
      ok("R3: …both on, the back wing stands on the north wall and the 6 ft front wing on the south", m3.wings.map((g) => g.wall).join() === "north,south"
        && Math.abs(m3.wings.find((g) => g.wall === "south").w - 6) < 1e-6, JSON.stringify(m3.wings.map((g) => [g.wall, g.w])));
      ok("R3: …and the middle-height note says what Auto draws again", /Auto draws/.test(await hcText(page)));
      // The middle back on Auto, so the shot shows it standing over both wings.
      await page.locator('[data-ss-adv-f="centerEaveFt"]').getByRole("button", { name: "Auto", exact: true }).click();
      await settle(page, 400);
      await advModel(page, (M) => M.massing.Hc > 12);
      await advShot(page, "adv-review-back-front-end.png", shots, "end");
      await advShot(page, "adv-review-back-front-corner.png", shots, "corner");
      if (shots) {
        await page.locator("[data-ss-adv-panel]").scrollIntoViewIfNeeded();
        await settle(page, 300);
        await page.locator("[data-ss-adv-panel]").screenshot({ path: join(shots, "adv-review-back-front-cards.png") }).catch(() => {});
      }
      ok("R1-3: no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    } finally { await ctx.close(); }
  }
  {
    // R4: a phone.
    const { ctx, page, errors } = await openAdvanced(browser, { width: 390, height: 844 });
    try {
      await setSize(page, 24, 28);
      await wingsOn(page);
      // A phone has no docked 3D (the page offers it full screen): the cards are what this measures.
      await page.waitForFunction(() => document.querySelectorAll("[data-ss-adv-wing] .ssd-seg").length === 2, null, { timeout: 30000 });
      const segs = await page.evaluate(() => ({
        bp: (document.querySelector(".ssd-frame") || { dataset: {} }).dataset.ssdBp,
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        segs: [...document.querySelectorAll("[data-ss-adv-wing] .ssd-seg")].map((s) => {
          const r = s.getBoundingClientRect();
          const bs = [...s.querySelectorAll("button")];
          return { w: Math.round(r.width), h: Math.round(r.height), tops: new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size, n: bs.length,
            clipped: bs.some((b) => b.scrollWidth > b.clientWidth + 1) };
        }),
      }));
      console.log(`   R4: ${JSON.stringify(segs)}`);
      ok("R4: at 390 px each wing card's \"Meets the middle section\" is one row of three buttons", segs.segs.length === 2 && segs.segs.every((x) => x.n === 3 && x.tops === 1 && !x.clipped), JSON.stringify(segs.segs));
      ok("R4: …and the page does not scroll sideways", segs.sw <= segs.cw, `${segs.sw} / ${segs.cw}`);
      if (shots) {
        await card(page, "left").scrollIntoViewIfNeeded();
        await settle(page, 300);
        await page.screenshot({ path: join(shots, "adv-review-phone-390-cards.png"), fullPage: false });
        await page.locator("[data-ss-adv-panel]").screenshot({ path: join(shots, "adv-review-phone-390-panel.png") }).catch(() => {});
      }
      ok("R4: no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    } finally { await ctx.close(); }
  }
}

// The calibration panel (?admin=1) keeps its own controls, and says the wings are set on the Advanced page.
async function calNote(ctx, ok) {
  const roof = { ...TRI, wingSides: { left: { widthFt: 6 }, right: { widthFt: 10 } } };
  const d3 = { roof, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" };
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  try {
    await stubSupabase(page, { config: configFor("Harness WS cal", "24x28", d3), fixtures: FIXTURES });
    await page.addInitScript(() => { try { localStorage.setItem("ss_gate_harness-wingsides", "1"); } catch (_e) { /* storage */ } });
    await page.goto(`${BASE}/?client=harness-wingsides&admin=1`);
    await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
    await page.getByText("Harness WS cal", { exact: true }).first().click({ timeout: 30000 });
    await page.waitForFunction(() => /Lower wings, each/.test(document.body.innerText), null, { timeout: 30000 });
    const txt = await page.evaluate(() => document.body.innerText);
    ok("cal: the calibration panel keeps its wing controls", /Lower wings, each/.test(txt) && /Wing side/.test(txt));
    ok("cal: …and says each wing is set on the Advanced page", txt.includes("Each wing is set separately on the Advanced page."));
    ok("cal: no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally { await page.close(); }
}

const { browser, ctx } = await launch({ width: 1280, height: 900 });
const { ok, failed } = reporter();
const only = process.env.SS_CASES ? process.env.SS_CASES.split(",") : null;
const want = (k) => !only || only.includes(k);
try {
  const digests = process.env.SS_WINGSIDES_DIGEST ? {} : null;
  const baseFile = process.env.SS_WINGSIDES_BASE;
  const base = baseFile && existsSync(baseFile) ? JSON.parse(readFileSync(baseFile, "utf8")) : null;
  const shots = process.env.SS_SHOTS ? shotsDir("wingSides") : null;
  if (want("D") && (digests || base)) for (const c of DIGEST_CASES) {
    try { await digestCase(ctx, c, ok, digests, base); } catch (e) { ok(`D ${c.id}: ran`, false, e && e.message); }
  }
  if (!digests) {
    if (want("S")) for (const c of SIDE_CASES) {
      try { await sideCase(ctx, c, ok, shots); } catch (e) { ok(`S ${c.id}: ran`, false, e && e.message); }
    }
    if (want("A")) { try { await advancedCheck(browser, ok, shots); } catch (e) { ok("A: ran", false, e && e.message); } }
    if (want("cal")) { try { await calNote(ctx, ok); } catch (e) { ok("cal: ran", false, e && e.message); } }
    if (want("R")) { try { await reviewCheck(browser, ok, shots); } catch (e) { ok("R: ran", false, e && e.message); } }
  }
  if (digests) writeFileSync(process.env.SS_WINGSIDES_DIGEST, JSON.stringify(digests, null, 1));
} finally {
  await browser.close();
}
const f = failed();
console.log(f.length ? `\n${f.length} check(s) FAILED` : "\nall checks passed");
process.exitCode = f.length ? 1 : 0;
