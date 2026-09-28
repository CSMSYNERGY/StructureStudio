// GROUND THAT FALLS AWAY (top-level gradeFallFt / gradeFallToward, 2026-09-28), measured off the scene
// graph of the COMPILED designer, and the calibration panel's controls for it driven with the SAVE
// PAYLOAD read off the wire.
//
// Carolyn, 09-28: "these piers are, like, deeper here". floorHeightFt stays the height at the front
// (the uphill side); gradeFallFt is how much lower the ground is at the far side, toward back, left
// or right. This proves, through __SS3D_DEBUG (window.__ss3dEngine):
//
//   1. model.grade is still the front's depth and model.gradeFall says the fall; the grass is bent to
//      d3GradeAt: sampled off the drawn triangles it is the front grade along the uphill edge, the
//      grade plus the fall along the far edge, a straight line between, and level past the blend
//      either side; its faces look up
//   2. ⚠️ every support under the building stands ON the drawn grass at its own spot: its foot at the
//      lowest grass under it (the uphill edge bedded in, nothing floating), within half a foot's
//      slope of the grass under its centre; the downhill rows stand taller by the fall times their
//      share of the way across; tops at the runners' underside; block stacks a course per 8 in of
//      their own height (model.foundation.supports[].courses)
//   3. the porch deck's own supports, the porch steps' foot, a lean-to's posts and a customer's ramp
//      reach the drawn grass at their own spot; the steps climb it in risers of 7.5 in or less and
//      their count is the one the panel's readout says (d3PorchReadout)
//   4. d3PorchToRoot (pure) is where the deck really stands: it maps the porch's own frame onto the
//      placed deck's matrices on a gable end, an eave wall, and an old-frame end wall
//   5. the shade under the building and the deck, and the ground labels, lie on the grass
//   6. the 3D editor frames the grass under every support's foot, its orbit target down by the
//      DEEPEST ground (d3GradeLiftFt); and with no door placed, the 3D Views preset the direction
//      names (B, ← L, R →), clicked, looks at the side the ground falls to, old frame and new
//   7. ⚠️ LEVEL GROUND IS TODAY'S, BYTE FOR BYTE: a style with no fall, one whose fall is 0, and a slab
//      carrying a fall it cannot have, each build a scene (every node's matrix, every mesh's geometry
//      and material) identical to the one the designer at SS_LEVEL_BASE (default 5345037, the commit
//      before this) builds from the same style, and the same camera
//   8. THE PANEL (?admin=1): blocks and piers show "Ground falls away (ft)"; an untouched style saves
//      no fall keys, and a style storing a fall saves it back exactly; a typed fall saves, "Toward"
//      appears with its hint and saves its word; a cleared box deletes gradeFallFt; leaving blocks or
//      piers deletes both keys; the preview draws the typed fall
//   9. zero page errors
//
//   python -m http.server 8142 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8142 node tests/harness/gradeFall.mjs
//   SS_CASES=K,level,panel ...        (a subset)        SS_SHOTS=<dir>  (side views, before and after)
//
// Exit 0 = every assertion held.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir, revealTool, BASE } from "./lib.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

// The designer's own pure functions, lifted out of the component twin by the anchors raisedFloor_test
// and gradeFall_test lift them by, so the scene is held against the numbers the code says.
function pure() {
  const src = readFileSync(new URL("../../structure-studio.component.js", import.meta.url), "utf8");
  const lift = (a, b) => {
    const i = src.indexOf(a), j = i < 0 ? -1 : src.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error(`gradeFall.mjs: the anchors ${a} .. ${b} moved; re-point them`);
    return src.slice(i, j);
  };
  const body = [
    ["const D3 = {", "// The casing reveal every opening"],
    ["function d3RoofAxes(", "function d3FtIn("],
    ["function ssPorchTrussWall(", "// Where a vent sits in the gable above"],
    ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
    ["function d3PorchGeom(", "function d3PorchReadout("],
    ["function d3PorchReadout(", "// A dimensioned end-elevation of the style"],
  ].map(([a, b]) => lift(a, b)).join("\n");
  return new Function(`${body}; return { D3, d3GradeFt, d3GradeAt, d3GradeFall, d3GradeFallAxis, d3GradeFallBlendFt, d3GradeMaxFt, d3GradeLiftFt, d3FrameHeightFt, d3PorchToRoot, d3PorchReadout };`)();
}
const PURE = pure();

const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const PLAIN = { body: "#eeebe0", trim: "#686c70", roof: "#5f6266", wood: "#c4965a" };
const FARM_COLORS = { body: "#785f51", trim: "#f0f0ec", roof: "#383d44", corner: "#785f51", fascia: "#4b5359", wood: "#9a5f4a" };
// A Tri Home-like 16x24: its gable end is the front, a porch off one end with steps, a lean-to off the
// left (west) eave wall.
const TRI = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, eave: "fascia", porchOutFt: 6, leanToWidthFt: 8, leanToSide: "left" };
const FARM_ROOF = { type: "shed", highSide: "front", pitch: 0.22, overhang: 0.8, eave: "fascia", porchEnd: "front", porchOutFt: 4, porchAttachFt: 8, porchPosts: 4, porchPitch: 0.25, porchSteps: "center" };
const tri = (roof, extra) => ({ roof: { ...TRI, ...roof }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5, ...extra });

// fall: the style's gradeFallFt / toward. ramp: a door and a ramp on the EAST wall. wall: the porch's.
const CASES = [
  { id: "K", label: "Fall Back Piers", size: "16x24", kind: "piers", grade: 1.5, fall: 2, toward: "back", wall: "north", leanTo: true, ramp: true,
    d3: tri({ porchEnd: "back", porchSteps: "center" }, { gradeFallFt: 2, gradeFallToward: "back" }) },
  { id: "Lf", label: "Fall Left Piers", size: "16x24", kind: "piers", grade: 1.5, fall: 2, toward: "left", wall: "south", leanTo: true, ramp: true,
    d3: tri({ porchEnd: "front", porchSteps: "left" }, { gradeFallFt: 2, gradeFallToward: "left" }) },
  { id: "Rt", label: "Fall Right Piers", size: "16x24", kind: "piers", grade: 1.5, fall: 2, toward: "right", wall: "south", leanTo: true,
    d3: tri({ porchEnd: "front", porchSteps: "right" }, { gradeFallFt: 2, gradeFallToward: "right" }) },
  // An eave-wall porch (the new frame's shed, Farmstand) on blocks, the ground falling to its right.
  { id: "Bk", label: "Fall Farm Blocks", size: "16x10", kind: "blocks", grade: 1.1, fall: 1.5, toward: "right", wall: "south",
    d3: { roof: FARM_ROOF, siding: "batten", colors: FARM_COLORS, wallHeightFt: 7.3, roofMaterial: "metal", foundation: "blocks", floorHeightFt: 1.1, gradeFallFt: 1.5, gradeFallToward: "right" } },
  // The OLD frame: no roof.front, a landscape gable, so the "front" porch is on the WEST end wall,
  // which the presets call the left side; the ground falls toward it.
  { id: "O", label: "Fall Old Frame", size: "24x12", kind: "piers", grade: 1.5, fall: 2, toward: "left", wall: "west",
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6, porchOutFt: 5, porchSteps: "left" }, siding: "panel", colors: PLAIN, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 2, gradeFallToward: "left" } },
  // A left wing: the porch stands in front of the CENTRE section, off the wall's middle
  // (d3PorchSpan's centerU), and the ground falls across it.
  { id: "Wg", label: "Fall Wing Porch", size: "16x24", kind: "piers", grade: 1.5, fall: 2, toward: "left", wall: "south",
    d3: tri({ porchEnd: "front", porchSteps: "center", wingSide: "left", wingWidthFt: 4, leanToWidthFt: 0 }, { gradeFallFt: 2, gradeFallToward: "left" }) },
  // The front sits on the ground (a 0.3 ft floor is the floor band itself): no room for a support
  // there, but the far side still stands on piers, the runners bedded into the grade at the front.
  { id: "Th", label: "Fall Thin Front", size: "12x16", kind: "piers", grade: 0.35, fall: 2, toward: "back", wall: null, thin: true,
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, siding: "lap", colors: PLAIN, wallHeightFt: 8, foundation: "piers", floorHeightFt: 0.3, gradeFallFt: 2 } },
  // No direction given: the fall is toward the back.
  { id: "D", label: "Fall Default Toward", size: "12x16", kind: "piers", grade: 1.5, fall: 1, toward: "back", wall: null,
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, siding: "lap", colors: PLAIN, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 1 } },
];
// ── 7. LEVEL GROUND: each built by this designer and by the one at SS_LEVEL_BASE, from the same style.
const LEVEL = [
  { id: "LV1", label: "Level Piers", size: "16x24", ramp: true, d3: tri({ porchEnd: "back", porchSteps: "center" }) },
  { id: "LV2", label: "Level Piers Zero Fall", size: "16x24", d3: tri({ porchEnd: "back", porchSteps: "center" }, { gradeFallFt: 0, gradeFallToward: "left" }) },
  { id: "LV3", label: "Level Slab With Fall", size: "12x16", d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, porchOutFt: 6, porchSteps: "left" }, siding: "batten", colors: PLAIN, wallHeightFt: 8, foundation: "slab", gradeFallFt: 2, gradeFallToward: "back" } },
  { id: "LV4", label: "Level Farm Blocks", size: "16x10", d3: { roof: FARM_ROOF, siding: "batten", colors: FARM_COLORS, wallHeightFt: 7.3, roofMaterial: "metal", foundation: "blocks", floorHeightFt: 1.1 } },
];

const configFor = (c) => {
  const [w, l] = c.size.split("x").map(Number);
  return {
    clientId: "harness-gradefall",
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "fall", label: c.label, img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: c.d3 }],
    defaultSizes: [c.size],
    sizePricing: { fall: { [c.size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { fall: CLADS }, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
  };
};
const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: true, imageUrl: null, showImage: false },
  items: [{ id: "d-walk", name: "Harness Walk Door", price: 300, widthIn: 36, heightIn: 80, category: "door", colorMode: "fixed", planLabel: "WD", sortOrder: 0, imageUrl: null,
    sillIn: null, sillMode: "fixed", opLeft: false, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right", swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false }],
  windowColors: [],
};

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const f3 = (v) => (v == null || !Number.isFinite(Number(v)) ? String(v) : Number(v).toFixed(3));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

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
  await settle(page, 1200);
}
// A door and its ramp on the EAST wall, half way along, placed in 2D (foundation.mjs's).
async function placeRampEast(page, ok, tag, W, L) {
  const eastAt = async (alongFt) => {
    const r = await buildingRect(page);
    return svgPoint(page, r.x + r.w - 0.4 * (r.w / W), r.y + alongFt * (r.h / L));
  };
  await (await revealTool(page, /^Door wall$/)).click();
  await settle(page, 300);
  let p = await eastAt(L / 2);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  await page.getByText(FIXTURES.items[0].name, { exact: true }).first().click({ timeout: 10000 });
  await settle(page, 300);
  await page.getByRole("button", { name: "Place door" }).click();
  await settle(page, 600);
  await (await revealTool(page, /Ramp/)).click();
  await settle(page, 300);
  p = await eastAt(L / 2);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  const items = (await readItems(page)) || [];
  const ramp = items.find((i) => i.type === "ramp");
  ok(`${tag}: a ramp placed on the east wall`, ramp && ramp.wall === "east", JSON.stringify(ramp && { wall: ramp.wall }));
}
// The designer at SS_LEVEL_BASE: its compiled component, served in place of this checkout's.
function baseBundle() {
  const rev = process.env.SS_LEVEL_BASE || "5345037";
  try {
    return { rev, js: execFileSync("git", ["-C", REPO, "show", `${rev}:structure-studio.component.compiled.js`], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8") };
  } catch (_e) {
    return { rev, js: null };
  }
}

// Open the designer on a case's style and size (and its ramp), then the 3D editor.
async function openCase(ctx, c, ok, tag, bundle) {
  const [W, L] = c.size.split("x").map(Number);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: configFor(c), fixtures: FIXTURES });
  if (bundle) await page.route(/structure-studio\.component\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: bundle }));
  await openDesigner(page, "harness-gradefall");
  await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
  await pickStyle(page, c.label);
  await chooseSize(page, c.size);
  if (c.ramp) await placeRampEast(page, ok, tag, W, L);
  await openEditor(page);
  return { page, errors, W, L };
}

// Every node of the model: its world matrix and, on a mesh, its geometry (type, parameters, a hash of
// every vertex) and material. Two builds with equal digests are the same scene.
async function digest(page) {
  return page.evaluate(() => {
    const E = window.__ss3dEngine, M = E.model;
    M.root.updateMatrixWorld(true);
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    const out = [];
    M.root.traverse((o) => {
      let s = `${o.type}|${o.matrixWorld.elements.map(r6).join(",")}|${o.visible}`;
      if (o.isMesh) {
        const g = o.geometry, pa = g.attributes.position;
        let h = 0;
        for (let i = 0; i < pa.array.length; i++) h = (h * 31 + Math.round(pa.array[i] * 1e5)) % 1000000007;
        const prm = g.type === "ExtrudeGeometry" ? "" : JSON.stringify(g.parameters || null);
        const m = o.material;
        s += `|${g.type}|${prm}|${pa.count}|${g.index ? g.index.count : -1}|${h}|${m && m.type}|${m && m.color ? m.color.getHexString() : ""}|${m && m.opacity}`;
      }
      out.push(s);
    });
    return { lines: out, cam: [...E.camera.position.toArray(), ...E.controls.target.toArray()].map(r6) };
  });
}

// Everything the fall assertions read, in world space, in one pass; `P` is what the pure functions say.
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
      return { mn, mx, cx: (mn[0] + mx[0]) / 2, cz: (mn[2] + mx[2]) / 2 };
    };
    const all = (pred) => { const a = []; M.root.traverse((q) => { if (q.isMesh && pred(q)) a.push(q); }); return a; };
    const under = (q, anc) => { let n = q; while (n) { if (n === anc) return true; n = n.parent; } return false; };
    // THE DRAWN GRASS, sampled off its own triangles (barycentric in x-z), never off d3GradeAt.
    const ground = all((q) => q.userData && q.userData.ssGround)[0];
    const pos = ground.geometry.attributes.position, idx = ground.geometry.index;
    const wv = [];
    for (let i = 0; i < pos.count; i++) wv.push(new V().fromBufferAttribute(pos, i).applyMatrix4(ground.matrixWorld));
    const tris = [];
    for (let t = 0; t < idx.count; t += 3) tris.push([wv[idx.getX(t)], wv[idx.getX(t + 1)], wv[idx.getX(t + 2)]]);
    let upFaces = 0, downFaces = 0;
    const grassAt = (x, z) => {
      for (const [a, b, c] of tris) {
        const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        if (Math.abs(d) < 1e-12) continue;
        const l1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
        const l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return l1 * a.y + l2 * b.y + l3 * c.y;
      }
      return NaN;
    };
    // Faces under and around the building look up (their world normal's y).
    for (const [a, b, c] of tris) {
      if (Math.max(Math.abs(a.x), Math.abs(a.z)) > Math.max(W, L)) continue;
      const n = new V().subVectors(b, a).cross(new V().subVectors(c, a));
      if (n.length() < 1e-9) continue;
      if (n.y > 0) upFaces++; else downFaces++;
    }
    const lowestGrass = (cx, cz, hx, hz) => Math.min(grassAt(cx - hx, cz - hz), grassAt(cx + hx, cz - hz), grassAt(cx - hx, cz + hz), grassAt(cx + hx, cz + hz));
    const out = { grade: M.grade, gradeFall: M.gradeFall || null, foundation: M.foundation || null, groundType: ground.geometry.type, upFaces, downFaces };
    // The grass along the fall's axis through the middle, and across it, for the profile checks.
    out.grassProbe = [];
    for (let k = -30; k <= 30; k++) {
      const s = k * 0.5;
      out.grassProbe.push({ s, alongX: grassAt(s, 0), alongZ: grassAt(0, s), offX: grassAt(s, 3.3), offZ: grassAt(2.7, s) });
    }
    // Supports under the building (not the deck's): one per stack, foot, top, the grass under them.
    const fpart = (name) => all((q) => q.userData && q.userData.ssFoundationPart === name);
    const inDeck = (q) => q.userData && q.userData.ssPorchPart === "deckSupport";
    const stacks = (list) => {
      const map = new Map();
      list.forEach((q) => {
        const b = bbOf(q), k = `${b.cx.toFixed(2)},${b.cz.toFixed(2)}`;
        const cur = map.get(k) || { cx: b.cx, cz: b.cz, bottom: Infinity, top: -Infinity, n: 0, hx: (b.mx[0] - b.mn[0]) / 2, hz: (b.mx[2] - b.mn[2]) / 2 };
        cur.bottom = Math.min(cur.bottom, b.mn[1]); cur.top = Math.max(cur.top, b.mx[1]); cur.n++;
        map.set(k, cur);
      });
      return [...map.values()].map((t) => ({ ...t, grassC: grassAt(t.cx, t.cz), grassLow: lowestGrass(t.cx, t.cz, t.hx, t.hz) }));
    };
    const kind = M.foundation && M.foundation.kind;
    out.supports = stacks(fpart(kind === "blocks" ? "block" : "pier").filter((q) => !inDeck(q)));
    out.deckSupports = stacks(all(inDeck));
    out.runnerBottom = Math.min(...fpart("runner").map((q) => bbOf(q).mn[1]));
    // The porch: deck frame (for d3PorchToRoot), rim, steps.
    const decks = []; M.root.traverse((q) => { if (q.userData && q.userData.ssPorch === "deck") decks.push(q); });
    const partsIn = (grp, name) => { const a = []; grp.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssPorchPart === name) a.push(q); }); return a; };
    if (decks.length) {
      const frame = decks[0].children[0];
      out.deckMap = [[0, 0], [1, 0], [0, 1], [2.5, 3]].map(([x, d]) => { const v = new V(x, 0, d).applyMatrix4(frame.matrixWorld); return { x, d, at: [v.x, v.z] }; });
      out.rimBottom = Math.min(...partsIn(decks[0], "rim").map((q) => bbOf(q).mn[1]));
    }
    out.steps = [];
    M.root.traverse((q) => {
      if (!(q.userData && q.userData.ssPorchPart === "steps")) return;
      const b = bbOf(q);
      const treads = partsIn(q, "stepTread").map((t) => bbOf(t));
      // The flight's footprint: the treads' union, and the grass under its four corners.
      const fx0 = Math.min(...treads.map((t) => t.mn[0])), fx1 = Math.max(...treads.map((t) => t.mx[0]));
      const fz0 = Math.min(...treads.map((t) => t.mn[2])), fz1 = Math.max(...treads.map((t) => t.mx[2]));
      const corners = [[fx0, fz0], [fx1, fz0], [fx0, fz1], [fx1, fz1]].map(([x, z]) => grassAt(x, z));
      out.steps.push({ bottom: b.mn[1], top: b.mx[1], treads: treads.length, risers: partsIn(q, "stepRiser").length, treadTops: treads.map((t) => t.mx[1]).sort((p, r) => p - r), grassMin: Math.min(...corners), grassMax: Math.max(...corners) });
    });
    // Lean-to posts.
    out.leanPosts = all((q) => q.userData && q.userData.ssLeanToPost).map((q) => { const b = bbOf(q); return { bottom: b.mn[1], grassLow: lowestGrass(b.cx, b.cz, 0.15, 0.15), grassC: grassAt(b.cx, b.cz) }; });
    // Ramps: the lowest point, its far end, and the grass under its two far corners.
    out.ramps = [];
    M.interiorGroup.children.forEach((g) => {
      if (!(g.userData && g.userData.ssRamp)) return;
      const b = bbOf(g), wall = g.userData.ssRamp;
      const N = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[wall];
      const farA = N[0] ? (N[0] > 0 ? b.mx[0] : b.mn[0]) : (N[1] > 0 ? b.mx[2] : b.mn[2]);
      const lat = N[0] ? [b.mn[2], b.mx[2]] : [b.mn[0], b.mx[0]];
      const inset = 0.02;
      const g1 = N[0] ? grassAt(farA - N[0] * inset, lat[0] + inset) : grassAt(lat[0] + inset, farA - N[1] * inset);
      const g2 = N[0] ? grassAt(farA - N[0] * inset, lat[1] - inset) : grassAt(lat[1] - inset, farA - N[1] * inset);
      out.ramps.push({ wall, bottom: b.mn[1], top: b.mx[1], out: Math.abs(farA - (N[0] ? Math.sign(N[0]) * W / 2 : Math.sign(N[1]) * L / 2)), grassFar: Math.min(g1, g2) });
    });
    // Sheets on the grass: every vertex of the shades and the labels, over the grass under it.
    const sheetGap = (q) => {
      const pa = q.geometry.attributes.position; const gaps = [];
      for (let i = 0; i < pa.count; i++) {
        const v = new V().fromBufferAttribute(pa, i).applyMatrix4(q.matrixWorld);
        const gy = grassAt(v.x, v.z);
        if (Number.isFinite(gy)) gaps.push(v.y - gy);
      }
      return { min: Math.min(...gaps), max: Math.max(...gaps), n: gaps.length };
    };
    out.shades = fpart("shade").map(sheetGap);
    out.labels = all((q) => under(q, M.envGroup) && q !== ground && !(q.userData && q.userData.ssFoundationPart)).map(sheetGap);
    // The camera: the orbit target, and every support's foot in the frame.
    const cam = E.camera; cam.updateMatrixWorld(true);
    out.target = [E.controls.target.x, E.controls.target.y, E.controls.target.z];
    out.framed = out.supports.concat(out.deckSupports).map((t) => { const v = new V(t.cx, t.bottom, t.cz).project(cam); return [v.x, v.y, v.z]; });
    return out;
  }, { W, L });
}

// Shots for the eye (SS_SHOTS): the building seen ACROSS the fall, so the rows of supports read short
// to tall; and from the corner on the downhill side, where the tall supports stand. `lift` is about
// the middle of the ground's depth.
async function aim(page, file, eye, at) {
  await page.evaluate(({ eye, at }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(...eye);
    E.controls.target.set(...at);
    E.controls.update();
    E.render();
  }, { eye, at });
  await settle(page, 300);
  await page.evaluate(() => window.__ss3dEngine.render());
  await page.locator("canvas").last().screenshot({ path: file });
}
function sideShot(page, file, W, L, toward, lift) {
  const R = Math.max(W, L), side = toward === "back" ? [1, 0] : [0, 1];
  return aim(page, file, [side[0] * R * 2.1, 3.2 - lift, side[1] * R * 2.1], [0, 0.6 - lift, 0]);
}
function cornerShot(page, file, W, L, toward, lift) {
  const R = Math.max(W, L), ax = PURE.d3GradeFallAxis(toward, W, L), perp = [Math.abs(ax.dir[1]), Math.abs(ax.dir[0])];
  const dx = ax.dir[0] * 1.2 + perp[0], dz = ax.dir[1] * 1.2 + perp[1], n = Math.hypot(dx, dz);
  return aim(page, file, [(dx / n) * R * 2, 7 - lift, (dz / n) * R * 2], [0, 1.2 - lift, 0]);
}

async function runCase(ctx, c, ok, shots) {
  const tag = `${c.id} ${c.label} ${c.size} (${c.fall} ft ${c.toward})`;
  let page = null;
  try {
    const o = await openCase(ctx, c, ok, tag, null);
    page = o.page;
    const { W, L, errors } = o;
    const m = await measure(page, W, L);
    const g = c.grade, fall = c.fall;
    const ax = PURE.d3GradeFallAxis(c.toward, W, L), D = ax.ext, B = PURE.d3GradeFallBlendFt(fall, D);
    // ── 1. the model and the grass ──
    ok(`${tag}: model.grade is the front's ${g}; model.gradeFall ${fall} ft toward the ${c.toward}`,
      near(m.grade, g, 1e-9) && m.gradeFall && near(m.gradeFall.fallFt, fall, 1e-9) && m.gradeFall.toward === c.toward, JSON.stringify(m.gradeFall));
    ok(`${tag}: the grass is bent (not the level disc), every face under and round the building looking up`,
      m.groundType !== "CircleGeometry" && m.upFaces > 50 && m.downFaces === 0, `${m.groundType} up ${m.upFaces} down ${m.downFaces}`);
    // Along the fall's axis through the middle (and a line off it, since it is the same across):
    // a(s) is the distance down the fall of the probe point.
    const probe = m.grassProbe.map((p) => {
      const onX = ax.dir[0] !== 0;
      const a = onX ? p.s * ax.dir[0] : p.s * ax.dir[1];
      return { a, y: onX ? p.alongX : p.alongZ, yOff: onX ? p.offX : p.offZ, want: -PURE.d3GradeAt(c.d3, W, L, onX ? p.s : 0, onX ? 0 : p.s) };
    });
    const bad = probe.filter((p) => !(near(p.y, p.want, 0.003) && near(p.yOff, p.want, 0.003)));
    ok(`${tag}: ⚠️ THE DRAWN GRASS IS d3GradeAt (along the fall and off to one side, within 0.003 ft)`, bad.length === 0,
      bad.slice(0, 3).map((p) => `a ${f3(p.a)}: ${f3(p.y)}/${f3(p.yOff)} want ${f3(p.want)}`).join(" | "));
    const at = (a) => -PURE.d3GradeAt(c.d3, W, L, a * ax.dir[0], a * ax.dir[1]);
    ok(`${tag}: front grade ${g} along the uphill edge, ${g + fall} along the far edge, straight between`,
      near(at(-D / 2), -g, 1e-12) && near(at(D / 2), -(g + fall), 1e-12) && near(at(0), -(g + fall / 2), 1e-12) && near(at(D / 4), -(g + 0.75 * fall), 1e-12));
    ok(`${tag}: level past the blend either side (${f3(B)} ft), the ease under 3 in`,
      near(at(-D / 2 - B - 5), at(-D / 2 - B - 0.01), 1e-9) && near(at(D / 2 + B + 5), at(D / 2 + B + 0.01), 1e-9)
      && Math.abs(at(-D / 2 - B - 5) + g) <= 0.25 + 1e-9 && Math.abs(at(D / 2 + B + 5) + g + fall) <= 0.25 + 1e-9);
    // ── 2. the supports under the building ──
    const S = m.supports;
    const slope = fall / D, half = c.kind === "piers" ? 0.5 : null;
    const footBad = S.filter((t) => !(near(t.bottom, t.grassLow, 0.01) && t.bottom <= t.grassC + 0.01));
    ok(`${tag}: ⚠️ EVERY SUPPORT'S FOOT IS ON THE DRAWN GRASS: at the lowest grass under it, never above the grass at its centre (${S.length})`,
      S.length > 0 && footBad.length === 0, footBad.slice(0, 3).map((t) => `(${f3(t.cx)},${f3(t.cz)}) foot ${f3(t.bottom)} low ${f3(t.grassLow)} centre ${f3(t.grassC)}`).join(" | "));
    const centreGap = Math.max(...S.map((t) => Math.abs(t.bottom - t.grassC)));
    ok(`${tag}: ...within half its width's slope of the grass at its own x,z (${f3(centreGap)} ft; the uphill side bedded in)`,
      centreGap <= (half != null ? half : 8 / 12) * slope + 0.01 && (slope > 0.1 || centreGap <= 0.05), f3(centreGap));
    ok(`${tag}: every support tops out at the runners' underside`, S.every((t) => near(t.top, m.runnerBottom, 0.002)), f3(m.runnerBottom));
    if (c.thin) {
      ok(`${tag}: no support where there is no room (the front), piers where the ground has fallen away`,
        S.length >= m.foundation.runners.length && S.every((t) => t.top - t.bottom >= 0.04 && t.cx * ax.dir[0] + t.cz * ax.dir[1] + D / 2 > 1) && near(m.foundation.runnerH, 0.15, 1e-9),
        `${S.length} piers, runner ${f3(m.foundation.runnerH)}`);
    }
    // Heights against the distance down the fall: height = runner underside + depth at (a + half).
    const hOf = (t) => t.top - t.bottom;
    const aOf = (t) => t.cx * ax.dir[0] + t.cz * ax.dir[1];
    // Its foot is at the ground under its downhill edge: half its size further down the fall.
    const depthA = (a) => PURE.d3GradeAt(c.d3, W, L, a * ax.dir[0], a * ax.dir[1]);
    const expectH = (t) => m.runnerBottom + depthA(aOf(t) + (c.kind === "piers" ? 0.5 : (ax.dir[0] ? t.hx : t.hz)));
    const hBad = S.filter((t) => !near(hOf(t), expectH(t), 0.005));
    const rows = [...new Set(S.map((t) => aOf(t).toFixed(2)))].map(Number).sort((p, q) => p - q);
    const rowH = (a) => S.filter((t) => near(aOf(t), a, 0.01)).map(hOf);
    const up = Math.max(...rowH(rows[0])), downRow = Math.min(...rowH(rows[rows.length - 1]));
    ok(`${tag}: ⚠️ THE DOWNHILL ROW STANDS TALLER BY THE FALL TIMES ITS SHARE OF THE WAY ACROSS (${f3(up)} → ${f3(downRow)} ft over ${f3(rows[rows.length - 1] - rows[0])} ft)`,
      hBad.length === 0 && rows.length >= 2 && near(downRow - up, (fall * (rows[rows.length - 1] - rows[0])) / D, 0.005),
      hBad.slice(0, 3).map((t) => `(${f3(t.cx)},${f3(t.cz)}) ${f3(hOf(t))} want ${f3(expectH(t))}`).join(" | "));
    if (c.kind === "blocks") {
      // n is the nearest whole number of 8 in courses to the stack's own height (at least 1), and
      // model.foundation.supports records it for the support standing there.
      const sup = m.foundation.supports || [];
      const rec = (t) => sup.find((s) => near(s.x, t.cx, 0.01) && near(s.z, t.cz, 0.01));
      ok(`${tag}: block stacks a course per 8 in of their own height, recorded per support`,
        sup.length === S.length && S.every((t) => (t.n === 1 ? hOf(t) < 1 + 1e-6 : Math.abs(hOf(t) / (8 / 12) - t.n) <= 0.5 + 1e-6) && rec(t) && rec(t).courses === t.n)
        && new Set(S.map((t) => t.n)).size >= 2,
        S.map((t) => `${t.n}@${f3(hOf(t))}`).join(" "));
    }
    ok(`${tag}: model.foundation.supports say the foot each stands on`, (m.foundation.supports || []).every((s) => S.some((t) => near(t.cx, s.x, 0.01) && near(t.cz, s.z, 0.01) && near(t.bottom, s.y0, 0.002))));
    // ── 3. the porch, the lean-to, the ramp ──
    if (c.wall) {
      const DS = m.deckSupports;
      const dBad = DS.filter((t) => !(near(t.bottom, t.grassLow, 0.01) && t.bottom <= t.grassC + 0.01 && near(t.top, m.rimBottom, 0.002)));
      ok(`${tag}: ⚠️ THE DECK'S SUPPORTS REACH THE DRAWN GRASS AT THEIR OWN SPOT, FROM THE RIM (${DS.length})`, DS.length >= 2 && dBad.length === 0,
        dBad.slice(0, 3).map((t) => `(${f3(t.cx)},${f3(t.cz)}) ${f3(t.bottom)}..${f3(t.top)} grass ${f3(t.grassLow)}`).join(" | "));
      const st = m.steps[0];
      const rd = PURE.d3PorchReadout(c.d3, c.size);
      const count = st ? st.treads : 0, h = st ? -st.bottom : NaN, rise = h / (count + 1);
      ok(`${tag}: ⚠️ THE STEPS' FOOT IS ON THE GRASS: at the lowest grass under the flight, nothing floating`,
        st && near(st.bottom, st.grassMin, 0.01) && st.bottom <= st.grassMax + 0.01, st && `foot ${f3(st.bottom)} grass ${f3(st.grassMin)}..${f3(st.grassMax)}`);
      ok(`${tag}: ${count} steps, risers of ${f3(rise * 12)} in (7.5 in or less), treads rising evenly`,
        st && count >= 1 && st.risers === count && rise <= 7.5 / 12 + 1e-9 && st.treadTops.every((y, i) => near(y, -h + (i + 1) * rise, 0.003)), st && st.treadTops.map(f3).join(" "));
      // The readout builds its porch on panel cladding (its trimFace), so steps at a porch's side sit a
      // hair across from the drawn ones: the count is the same, the ground under them within 0.02 ft.
      ok(`${tag}: the panel's readout counts the same steps (d3PorchReadout ${rd && rd.steps && rd.steps.count})`, rd && rd.steps && rd.steps.count === count && near(-rd.steps.grade, h, 0.02),
        rd && rd.steps && `${rd.steps.count} at ${f3(-rd.steps.grade)}`);
      // ── 4. d3PorchToRoot is where the deck stands ──
      const toRoot = PURE.d3PorchToRoot(c.d3.roof, W, L);
      const mapBad = (m.deckMap || []).filter((p) => { const q = toRoot(p.x, p.d); return !(near(q[0], p.at[0], 1e-6) && near(q[1], p.at[1], 1e-6)); });
      ok(`${tag}: d3PorchToRoot maps the porch's frame onto the placed deck (${c.wall} wall)`, m.deckMap && mapBad.length === 0,
        mapBad.slice(0, 2).map((p) => `(${p.x},${p.d}) drawn ${p.at.map(f3)} pure ${toRoot(p.x, p.d).map(f3)}`).join(" | "));
    }
    if (c.leanTo) {
      const lp = m.leanPosts;
      ok(`${tag}: ⚠️ THE LEAN-TO'S POSTS STAND ON THE DRAWN GRASS AT THEIR OWN FOOT (${lp.length})`, lp.length >= 2 && lp.every((q) => near(q.bottom, q.grassLow, 0.01) && q.bottom <= q.grassC + 0.01),
        lp.map((q) => `${f3(q.bottom)}/${f3(q.grassLow)}`).join(" "));
    }
    if (c.ramp) {
      const r = m.ramps.find((q) => q.wall === "east");
      ok(`${tag}: ⚠️ THE RAMP RUNS FROM THE FLOOR TO THE DRAWN GRASS AT ITS FOOT`, r && near(r.bottom, r.grassFar, 0.08) && r.top <= 0.13, r && `${f3(r.bottom)} grass ${f3(r.grassFar)}`);
      const drop = r ? -r.grassFar : NaN;
      ok(`${tag}: ...1 in 4 or gentler (${f3(r && r.out)} ft out for a ${f3(drop)} ft drop)`, r && r.out >= Math.max(3, 4 * drop) - 0.15, r && f3(r.out));
    }
    // ── 5. sheets on the grass ──
    ok(`${tag}: the shade under the building${c.wall ? " and the deck" : ""} lies 0.02 over the grass everywhere`,
      m.shades.length === (c.wall ? 2 : 1) && m.shades.every((s) => s.n > 4 && s.min >= 0.012 && s.max <= 0.028), m.shades.map((s) => `${f3(s.min)}..${f3(s.max)}`).join(" "));
    ok(`${tag}: the ground labels lie on it`, m.labels.length >= 2 && m.labels.every((s) => s.n > 4 && s.min >= 0.03 && s.max <= 0.05), m.labels.map((s) => `${f3(s.min)}..${f3(s.max)}`).join(" "));
    // ── 6. the camera ──
    const maxLift = PURE.d3GradeLiftFt(c.d3), fH = PURE.d3FrameHeightFt(c.d3, W, L);
    ok(`${tag}: d3GradeLiftFt frames from the deepest ground (${f3(maxLift)} = ${g} + ${fall} - 0.35)`, near(maxLift, g + fall - 0.35, 1e-9));
    ok(`${tag}: the orbit target comes down with it (${f3(fH * 0.45 - maxLift)})`, near(m.target[1], fH * 0.45 - maxLift, 1e-6), f3(m.target[1]));
    const inNdc = (p) => Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1 && p[2] < 1;
    ok(`${tag}: the 3D editor frames every support's foot`, m.framed.every(inNdc), m.framed.filter((p) => !inNdc(p)).slice(0, 3).map((p) => p.map(f3).join(",")).join(" | "));
    // ── the directions are the ones the customer's 3D Views presets name ──
    // With no door placed the front is the south wall, and B, ← L and R → look at the back, left and
    // right. (A case with a door on another wall re-homes the presets; the ground stays put.)
    if (!c.ramp) {
      const preset = { back: "B", left: "← L", right: "R →" }[c.toward];
      await page.getByRole("button", { name: /Views/ }).first().click();
      await page.getByRole("button", { name: preset, exact: true }).first().click();
      await settle(page, 300);
      const cam = await page.evaluate(() => { const E = window.__ss3dEngine; return [E.camera.position.x - E.controls.target.x, E.camera.position.z - E.controls.target.z]; });
      const along = cam[0] * ax.dir[0] + cam[1] * ax.dir[1], across = Math.abs(cam[0] * ax.dir[1] - cam[1] * ax.dir[0]);
      ok(`${tag}: ⚠️ THE 3D VIEWS PRESET "${preset}" LOOKS AT THE SIDE THE GROUND FALLS TO`, along > 5 && across < 0.01 * along, `camera offset ${cam.map(f3)}`);
      if (shots) {
        await page.evaluate(() => window.__ss3dEngine.render());
        await page.locator("canvas").last().screenshot({ path: join(shots, `${c.id}-${c.toward}-preset.png`) });
      }
    }
    if (shots) {
      await cornerShot(page, join(shots, `${c.id}-${c.toward}-corner.png`), W, L, c.toward, g + fall / 2);
      await sideShot(page, join(shots, `${c.id}-${c.toward}-side.png`), W, L, c.toward, g + fall / 2);
    }
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    if (page) await page.close();
  }
}

// ── 7. LEVEL GROUND IS TODAY'S ──
async function runLevel(ctx, c, ok, base, shots) {
  const tag = `${c.id} ${c.label} ${c.size}`;
  const pages = [];
  try {
    const now = await openCase(ctx, c, ok, `${tag} (this build)`, null);
    pages.push(now.page);
    const a = await digest(now.page);
    const then = await openCase(ctx, c, ok, `${tag} (${base.rev})`, base.js);
    pages.push(then.page);
    const b = await digest(then.page);
    // Proof the two pages ran different designers: only this one's model says gradeFall (null here).
    const marks = await Promise.all([now.page, then.page].map((pg) => pg.evaluate(() => ("gradeFall" in window.__ss3dEngine.model ? window.__ss3dEngine.model.gradeFall : "absent"))));
    ok(`${tag}: this build says gradeFall null, the ${base.rev} designer has no such field (it really is the old bundle)`, marks[0] === null && marks[1] === "absent", JSON.stringify(marks));
    const i = a.lines.findIndex((l, k) => l !== b.lines[k]);
    ok(`${tag}: ⚠️ THE SCENE IS ${base.rev}'S, NODE FOR NODE (${a.lines.length} nodes: matrices, geometry, materials)`,
      a.lines.length === b.lines.length && i < 0, i >= 0 ? `node ${i}: now ${a.lines[i] && a.lines[i].slice(0, 160)} | then ${b.lines[i] && b.lines[i].slice(0, 160)}` : `${a.lines.length} vs ${b.lines.length}`);
    ok(`${tag}: ...and the camera and its target`, JSON.stringify(a.cam) === JSON.stringify(b.cam), `${JSON.stringify(a.cam)} vs ${JSON.stringify(b.cam)}`);
    if (shots && c.id === "LV1") {
      const [W, L] = c.size.split("x").map(Number);
      await cornerShot(now.page, join(shots, "K-back-corner-BEFORE-level.png"), W, L, "back", 1.5 + 1);
      await sideShot(now.page, join(shots, "K-back-side-BEFORE-level.png"), W, L, "back", 1.5 + 1);
    }
    ok(`${tag}: zero page errors`, now.errors.length === 0 && then.errors.length === 0, [...now.errors, ...then.errors].slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    for (const p of pages) await p.close();
  }
}

// ── 8. THE PANEL ────────────────────────────────────────────────────────────────────────────
const PANEL_STYLES = [
  { value: "cabin", label: "Harness Fall Cabin", d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 0.8 }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  { value: "tri", label: "Harness Fall Tri", d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 1 }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 2, gradeFallToward: "left" } },
].map((s) => ({ ...s, img: null, sizes: ["16x24"], sizeInclusions: {}, sizeInclusionQty: {} }));
const PANEL_CONFIG = {
  clientId: "harness-gradefall-panel",
  branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: PANEL_STYLES,
  defaultSizes: ["16x24"],
  sizePricing: Object.fromEntries(PANEL_STYLES.map((s) => [s.value, { "16x24": { widthFt: 16, lengthFt: 24, basePrice: 9000 } }])),
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};

async function runPanel(ctx, ok, shots) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const calls = await stubSupabase(page, { config: PANEL_CONFIG, fixtures: { ramp: FIXTURES.ramp, items: [], windowColors: [] } });
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const saves = () => calls.filter((c) => c.path && c.path.endsWith("/functions/v1/admin-save-settings") && c.body && c.body.action === "save_style_d3");
  const save = async () => {
    const before = saves().length;
    await page.getByRole("button", { name: "Save to config" }).click();
    const t0 = Date.now();
    while (saves().length === before) {
      if (Date.now() - t0 > 15000) throw new Error("Save sent no admin-save-settings call");
      await settle(page, 100);
    }
    await page.getByText("Saved — reload the page to see it live.").waitFor({ state: "visible", timeout: 15000 });
    return saves()[saves().length - 1].body;
  };
  const select = () => page.locator('select[data-ss-foundation="ss-grid"]');
  const fallBox = () => page.locator('input[data-ss-grade-fall="ss-grid"]');
  const toward = () => page.locator('select[data-ss-grade-fall-toward="ss-grid"]');
  const typeFall = async (v) => {
    await fallBox().click();
    await fallBox().fill(String(v));
    await page.keyboard.press("Tab");
    await settle(page, 300);
  };
  const openStyle = async (label) => {
    const btn = page.getByRole("button", { name: label, exact: true });
    await btn.first().waitFor({ state: "visible", timeout: 30000 });
    await btn.first().click();
    await select().waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 400);
  };
  try {
    await page.goto(`${BASE}/?client=${encodeURIComponent(PANEL_CONFIG.clientId)}&admin=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
    await page.getByPlaceholder("Admin password").fill("harness");
    await openStyle("Harness Fall Cabin");
    ok("panel: piers show 'Ground falls away (ft)', blank = level, and no 'Toward' without a fall",
      (await fallBox().count()) === 1 && (await fallBox().inputValue()) === "" && (await fallBox().getAttribute("placeholder")) === "blank = level" && (await toward().count()) === 0);
    const label = (await fallBox().locator("xpath=..").innerText()).replace(/\s+/g, " ").trim();
    ok("panel: ...labelled in plain words", /^Ground falls away \(ft\)/.test(label), label);
    let body = await save();
    ok("panel: ⚠️ AN UNTOUCHED STYLE SAVES NO FALL KEYS", !has(body.d3, "gradeFallFt") && !has(body.d3, "gradeFallToward") && body.d3.foundation === "piers" && body.d3.floorHeightFt === 1.5,
      JSON.stringify({ f: body.d3.gradeFallFt, t: body.d3.gradeFallToward }));
    await typeFall(2);
    ok("panel: a typed fall shows 'Toward', on Back", (await toward().count()) === 1 && (await toward().inputValue()) === "back");
    const opts = await toward().locator("option").evaluateAll((os) => os.map((o) => o.textContent));
    ok("panel: ...offering Back, Left and Right", JSON.stringify(opts) === JSON.stringify(["Back", "Left", "Right"]), JSON.stringify(opts));
    const hint = (await toward().locator("xpath=..").innerText()).replace(/\s+/g, " ");
    ok("panel: ...with the hint: floor height at the front, the far side's piers this much taller",
      hint.includes("Floor height is measured at the front. The far side's piers stand this much taller."), hint);
    body = await save();
    ok("panel: a typed 2 saves gradeFallFt 2 and no direction (back is what absent draws)", body.d3.gradeFallFt === 2 && !has(body.d3, "gradeFallToward"), JSON.stringify({ f: body.d3.gradeFallFt, t: body.d3.gradeFallToward }));
    await toward().selectOption("left");
    await settle(page);
    const hintL = (await toward().locator("xpath=..").innerText()).replace(/\s+/g, " ");
    ok("panel: Left says the floor height is taken on the right side and the left side's piers grow",
      hintL.includes("Floor height is measured on the right side. The left side's piers stand this much taller."), hintL);
    const fhLabel = (await page.locator('input[data-ss-floor-height="ss-grid"]').locator("xpath=..").innerText()).replace(/\s+/g, " ");
    ok("panel: ...and the floor height box says on the right side", /^Floor height off the ground, on the right side \(ft\)/.test(fhLabel), fhLabel.slice(0, 60));
    body = await save();
    ok("panel: Left saves gradeFallToward \"left\"", body.d3.gradeFallFt === 2 && body.d3.gradeFallToward === "left", JSON.stringify({ f: body.d3.gradeFallFt, t: body.d3.gradeFallToward }));
    await typeFall(9);
    body = await save();
    ok("panel: past the band it saves at the top, 6", body.d3.gradeFallFt === 6, String(body.d3.gradeFallFt));
    await typeFall("");
    ok("panel: a cleared box hides 'Toward'", (await toward().count()) === 0);
    body = await save();
    ok("panel: ⚠️ A CLEARED BOX DELETES gradeFallFt (the direction is remembered, as the sanitiser does)", !has(body.d3, "gradeFallFt") && body.d3.gradeFallToward === "left", JSON.stringify({ f: body.d3.gradeFallFt, t: body.d3.gradeFallToward }));
    await typeFall(0);
    body = await save();
    ok("panel: 0 is level too: no gradeFallFt", !has(body.d3, "gradeFallFt"), String(body.d3.gradeFallFt));
    await typeFall(1.5);
    await select().selectOption("skids");
    await settle(page);
    ok("panel: skids hides the fall box", (await fallBox().count()) === 0 && (await toward().count()) === 0);
    body = await save();
    ok("panel: ⚠️ LEAVING PIERS DELETES BOTH FALL KEYS", body.d3.foundation === "skids" && !has(body.d3, "gradeFallFt") && !has(body.d3, "gradeFallToward"), JSON.stringify({ f: body.d3.gradeFallFt, t: body.d3.gradeFallToward }));

    await openStyle("Harness Fall Tri");
    ok("panel: a style storing a fall opens with it: 2 ft, toward Left", (await fallBox().inputValue()) === "2" && (await toward().inputValue()) === "left");
    body = await save();
    ok("panel: ⚠️ ...AND SAVES IT BACK EXACTLY", body.d3.gradeFallFt === 2 && body.d3.gradeFallToward === "left" && body.frame === "front", JSON.stringify({ f: body.d3.gradeFallFt, t: body.d3.gradeFallToward, frame: body.frame }));
    if (shots) await select().locator("xpath=../..").screenshot({ path: join(shots, "panel-fields.png") }).catch(() => {});
    // The preview draws the DRAFT: a typed 3 ft fall.
    await typeFall(3);
    await page.getByRole("button", { name: /Preview in 3D/ }).first().click();
    await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.gradeFall && E.model.gradeFall.fallFt > 2.9); }, null, { timeout: 60000 });
    await settle(page, 800);
    const pv = await page.evaluate(() => { const E = window.__ss3dEngine; return { grade: E.model.grade, fall: E.model.gradeFall, target: E.controls.target.y }; });
    const spec3 = { ...PANEL_STYLES[1].d3, gradeFallFt: 3 };
    ok("panel: the 3D preview draws the typed fall, its orbit target down by the deepest ground",
      Math.abs(pv.grade - 1.5) < 1e-9 && pv.fall && pv.fall.fallFt === 3 && pv.fall.toward === "left"
      && Math.abs(pv.target - (PURE.d3FrameHeightFt(spec3, 16, 24) * 0.45 - PURE.d3GradeLiftFt(spec3))) < 1e-6, JSON.stringify(pv));
    if (shots) {
      await cornerShot(page, join(shots, "panel-preview-left.png"), 16, 24, "left", 1.5 + 1.5);
    }
    ok("panel: zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok("panel: ran to the end", false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    await page.close();
  }
}

const { ok, failed } = reporter();
const only = process.env.SS_CASES ? process.env.SS_CASES.split(",") : null;
const todo = CASES.filter((c) => !only || only.includes(c.id));
const shots = process.env.SS_SHOTS ? shotsDir("gradeFall") : null;
const base = baseBundle();
const { browser, ctx } = await launch({ width: 1280, height: 900 });
try {
  const N = Number(process.env.SS_CONC || 3);
  const q = todo.map((c) => () => runCase(ctx, c, ok, shots));
  if (!only || only.includes("level")) {
    if (base.js) LEVEL.forEach((c) => q.push(() => runLevel(ctx, c, ok, base, shots)));
    else console.log(`SKIP  level ground against ${base.rev}: that revision is not in this repository (set SS_LEVEL_BASE)`);
  }
  if (!only || only.includes("panel")) q.push(() => runPanel(ctx, ok, shots));
  await Promise.all(Array.from({ length: N }, async () => { while (q.length) await q.shift()(); }));
} finally {
  await browser.close();
}
const bad = failed();
console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL PASS");
process.exit(bad.length ? 1 : 0);
