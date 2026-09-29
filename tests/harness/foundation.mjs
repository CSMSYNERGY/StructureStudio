// A RAISED FLOOR ON BLOCKS OR PIERS (foundation "blocks" | "piers" + floorHeightFt, 2026-09-25),
// measured off the scene graph, and the calibration panel's controls for it driven with the SAVE
// PAYLOAD read off the wire.
//
// The floor stays at y = 0 and the GROUND goes down: d3GradeFt is how far below the floor's top the
// grass is drawn. This proves, in the real designer against the COMPILED bundle, through
// __SS3D_DEBUG (window.__ss3dEngine):
//
//   1. the grass, the ground labels and the shade under the building sit at -floorHeightFt; the
//      grass still receives shadows
//   2. the siding skirts down over the floor band, four boxes of the wall material, to half a foot
//      under the floor, and the corner boards run down with it
//   3. runners under the floor band (the skids' rule: along the long axis, one every 4 ft or less
//      across), and under every runner a row of supports one near each end and one every 7 ft or
//      less between: stacked 16x8 in concrete blocks, or 12 in round piers, each from the runner's
//      underside to the grass exactly (model.foundation says the same)
//   4. the projecting porch's deck is at the floor with its own supports, one under every post,
//      reaching the grass, and a second row on a deck more than 7 ft deep; its steps climb the whole
//      height with risers of 7.5 in or less and 11 in treads, landing on the grass
//   5. a customer's ramp runs from the floor to the grass: 3 ft as always while that is 1 in 4 or
//      gentler, 4 ft per foot of drop past it
//   6. the 3D editor's camera frames it all: the orbit target comes down with the ground, and the
//      grass under every corner and every support's foot projects inside the frame (the docked
//      panel's camera too, where it is mounted)
//   7. a slab, skids and no foundation at all are untouched: the grass at -0.35, no skirt, runners
//      under a deck or supports, corner boards on the floor, one porch step, a 3 ft ramp, and
//      model.foundation null
//   8. THE PANEL (?admin=1): "What it stands on" offers the four kinds; blocks and piers show a floor
//      height box whose blank says the default drawn; an untouched style saves no foundation key; the
//      height saves as typed, clamped to 0.3..6, and a cleared box deletes it; leaving blocks/piers
//      deletes the height; "Not set" deletes the foundation; a style storing piers saves them back
//      untouched; every save says frame "front"; the preview's ground moves with the height
//   9. zero page errors
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/foundation.mjs                  (SS_BASE=http://127.0.0.1:<port> to move it)
//   SS_CASES=B,P node tests/harness/foundation.mjs     (a subset; "panel" is the panel part)
//
// Exit 0 = every assertion held.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir, revealTool, BASE } from "./lib.mjs";

// The designer's own pure functions, lifted out of the component twin by the anchors
// raisedFloor_test lifts them by, so the scene is held against the numbers the code says.
function pure() {
  const src = readFileSync(new URL("../../structure-studio.component.js", import.meta.url), "utf8");
  const lift = (a, b) => {
    const i = src.indexOf(a), j = i < 0 ? -1 : src.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error(`foundation.mjs: the anchors ${a} .. ${b} moved; re-point them`);
    return src.slice(i, j);
  };
  const body = [
    ["const D3 = {", "// The casing reveal every opening"],
    ["function d3RoofAxes(", "function d3FtIn("],
  ].map(([a, b]) => lift(a, b)).join("\n");
  return new Function(`${body}; return { d3GradeFt, d3GradeLiftFt, d3FrameHeightFt };`)();
}
const PURE = pure();

const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const FARM_COLORS = { body: "#785f51", trim: "#f0f0ec", roof: "#383d44", corner: "#785f51", fascia: "#4b5359", wood: "#9a5f4a" };
const PLAIN = { body: "#eeebe0", trim: "#686c70", roof: "#5f6266", wood: "#c4965a" };
const FARM_ROOF = { type: "shed", highSide: "front", pitch: 0.22, overhang: 0.8, eave: "fascia", porchEnd: "front", porchOutFt: 4, porchAttachFt: 8, porchPosts: 4, porchPitch: 0.25, porchSteps: "center" };
const GABLE_PORCH = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, eave: "fascia", porchEnd: "front", porchOutFt: 6, porchSteps: "left" };

// grade: the ground's depth under the floor top. kind: the support, or null at grade.
// ramp: place a door and a ramp on the EAST wall. deep: the porch deck takes a middle row.
const CASES = [
  { id: "B", label: "Found Farm Blocks", size: "16x10", grade: 1.1, kind: "blocks", porch: true, steps: 2, ramp: true,
    d3: { roof: FARM_ROOF, siding: "batten", colors: FARM_COLORS, wallHeightFt: 7.3, roofMaterial: "metal", foundation: "blocks", floorHeightFt: 1.1 } },
  { id: "P", label: "Found Tri Piers", size: "12x16", grade: 1.5, kind: "piers", porch: true, steps: 3,
    d3: { roof: GABLE_PORCH, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  { id: "D", label: "Found Blocks Default", size: "12x12", grade: 1.0, kind: "blocks",
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, siding: "lap", colors: PLAIN, wallHeightFt: 8, foundation: "blocks" } },
  { id: "T", label: "Found Tall Piers", size: "12x12", grade: 4, kind: "piers", porch: true, steps: 7, deep: true, ramp: true,
    d3: { roof: { ...GABLE_PORCH, porchOutFt: 8, porchSteps: "center" }, siding: "panel", colors: PLAIN, wallHeightFt: 8, foundation: "piers", floorHeightFt: 4 } },
  // At grade: exactly what these styles have always drawn.
  { id: "S", label: "Found Skids", size: "12x16", grade: 0.35, kind: null, porch: true, steps: 1, ramp: true, skids: true,
    d3: { roof: GABLE_PORCH, siding: "batten", colors: PLAIN, wallHeightFt: 8, foundation: "skids", floorHeightFt: 2 } },
  { id: "N", label: "Found No Foundation", size: "12x16", grade: 0.35, kind: null, porch: true, steps: 1,
    d3: { roof: GABLE_PORCH, siding: "batten", colors: PLAIN, wallHeightFt: 8 } },
];

const configFor = (c) => {
  const [w, l] = c.size.split("x").map(Number);
  return {
    clientId: "harness-foundation",
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "found", label: c.label, img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: c.d3 }],
    defaultSizes: [c.size],
    sizePricing: { found: { [c.size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { found: CLADS }, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
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
// A door and its ramp on the EAST wall, half way along, placed in 2D.
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

// Everything the assertions read, in world space, in one pass.
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
    const under = (q, anc) => { let n = q; while (n) { if (n === anc) return true; n = n.parent; } return false; };
    const all = (pred) => { const a = []; M.root.traverse((q) => { if (q.isMesh && pred(q)) a.push(q); }); return a; };
    const fpart = (name) => all((q) => q.userData && q.userData.ssFoundationPart === name);
    // The grass: the envGroup's CircleGeometry.
    const ground = all((q) => under(q, M.envGroup) && q.geometry.type === "CircleGeometry")[0];
    ground.updateMatrixWorld(true);
    const labels = all((q) => under(q, M.envGroup) && q !== ground && !(q.userData && q.userData.ssFoundationPart));
    const out = {
      grade: M.grade, foundation: M.foundation || null, porch: M.porch || null,
      groundY: ground ? new V().setFromMatrixPosition(ground.matrixWorld).y : null,
      groundReceives: ground ? ground.receiveShadow : null,
      labelYs: labels.map((q) => bbOf(q).mn[1]),
      wallMatUsed: 0,
    };
    const box = (q) => { const b = bbOf(q); return { mn: b.mn, mx: b.mx, geo: q.geometry.type, r: q.geometry.parameters && q.geometry.parameters.radiusTop, cast: q.castShadow, mat: q.material === M.wallMat ? "wall" : (q.material && q.material.color ? "#" + q.material.color.getHexString() : null) }; };
    out.skirt = fpart("skirt").map(box);
    out.runners = fpart("runner").map(box);
    // Supports: every block or pier, split into the building's and the porch deck's.
    const inDeck = (q) => q.userData && q.userData.ssPorchPart === "deckSupport";
    out.blocks = fpart("block").filter((q) => !inDeck(q)).map(box);
    out.piers = fpart("pier").filter((q) => !inDeck(q)).map(box);
    out.deckSupports = all(inDeck).map(box);
    out.shades = fpart("shade").map((q) => ({ y: new V().setFromMatrixPosition(q.matrixWorld).y, inEnv: under(q, M.envGroup), transparent: !!q.material.transparent }));
    out.anyFoundationPart = all((q) => q.userData && q.userData.ssFoundationPart).length;
    // Corner boards: the roofGroup's tall thin boxes standing on the footprint's corners.
    out.corners = [];
    M.roofGroup.children.forEach((q) => {
      if (!q.isMesh || q.material !== M.cornerMat) return;
      const b = bbOf(q), cx = (b.mn[0] + b.mx[0]) / 2, cz = (b.mn[2] + b.mx[2]) / 2;
      if (Math.abs(Math.abs(cx) - W / 2) < 0.05 && Math.abs(Math.abs(cz) - L / 2) < 0.05) out.corners.push({ bottom: b.mn[1], top: b.mx[1] });
    });
    // Porch steps, deck, rim and posts.
    const decks = []; M.root.traverse((q) => { if (q.userData && q.userData.ssPorch === "deck") decks.push(q); });
    const partsIn = (grp, name) => { const a = []; grp.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssPorchPart === name) a.push(q); }); return a; };
    out.steps = [];
    M.root.traverse((q) => {
      if (!(q.userData && q.userData.ssPorchPart === "steps")) return;
      const b = bbOf(q);
      out.steps.push({ bottom: b.mn[1], top: b.mx[1], treads: partsIn(q, "stepTread").map((t) => { const tb = bbOf(t); return { top: tb.mx[1] }; }), risers: partsIn(q, "stepRiser").length, visible: q.visible });
    });
    if (decks.length) {
      const boards = partsIn(decks[0], "deckBoard"), rims = partsIn(decks[0], "rim");
      out.deckTop = Math.max(...boards.map((q) => bbOf(q).mx[1]));
      out.rimBottom = Math.min(...rims.map((q) => bbOf(q).mn[1]));
      const pg = []; M.root.traverse((q) => { if (q.userData && q.userData.ssPorch === "roof") pg.push(q); });
      out.posts = pg.length ? partsIn(pg[0], "post").map((q) => { const b = bbOf(q); return [(b.mn[0] + b.mx[0]) / 2, (b.mn[2] + b.mx[2]) / 2, b.mn[1]]; }) : [];
    }
    // Ramps: interior groups tagged ssRamp.
    out.ramps = [];
    M.interiorGroup.children.forEach((g) => { if (g.userData && g.userData.ssRamp) { const b = bbOf(g); out.ramps.push({ wall: g.userData.ssRamp, mn: b.mn, mx: b.mx }); } });
    // The camera: the orbit target, and where the grass under the corners and every support's foot
    // land in the frame (normalised device coordinates, in frame within [-1, 1]).
    const cam = E.camera; cam.updateMatrixWorld(true);
    const ndc = (x, y, z) => { const v = new V(x, y, z).project(cam); return [v.x, v.y, v.z]; };
    out.target = E.controls ? [E.controls.target.x, E.controls.target.y, E.controls.target.z] : null;
    out.eyeY = cam.position.y;
    const pts = [];
    for (const x of [-W / 2, W / 2]) for (const z of [-L / 2, L / 2]) pts.push([x, -M.grade, z]);
    fpart("block").concat(fpart("pier")).forEach((q) => { const b = bbOf(q); pts.push([(b.mn[0] + b.mx[0]) / 2, b.mn[1], (b.mn[2] + b.mx[2]) / 2]); });
    out.framed = pts.map((p) => ndc(...p));
    return out;
  }, { W, L });
}
// The designer's DOCKED panel, measured while it is on screen (the 3D editor unmounts it): its
// ground, its orbit target, and where every mesh of the building -- its supports, skirt, porch deck
// and posts -- and the grass under the corners land on its own camera's frame. Not the porch STEPS
// or a customer's RAMP: the dock frames the footprint (half its longer side, as it always has), and
// a porch sticking out toward the frame's side with a long stair or ramp beyond it can run past a
// portrait panel's edge at grade too. The 3D editor's wider frame is held to all of it above.
async function measureDock(page, W, L) {
  const show = page.getByRole("button", { name: /Show 3D|3D View/ });
  if (!(await page.evaluate(() => !!(window.__ss3dPanel && window.__ss3dPanel.model))) && await show.count()) await show.first().click();
  await page.waitForFunction(() => !!(window.__ss3dPanel && window.__ss3dPanel.model), null, { timeout: 60000 });
  await settle(page, 1200);
  return page.evaluate(({ W, L }) => {
    const P = window.__ss3dPanel, V = P.camera.position.constructor;
    P.scene.updateMatrixWorld(true);
    P.camera.updateMatrixWorld(true);
    const under = (q, anc) => { let n = q; while (n) { if (n === anc) return true; n = n.parent; } return false; };
    const pts = [];
    for (const x of [-W / 2, W / 2]) for (const z of [-L / 2, L / 2]) pts.push([x, -P.model.grade, z]);
    const inSteps = (q) => { let n = q; while (n) { if (n.userData && n.userData.ssPorchPart === "steps") return true; n = n.parent; } return false; };
    P.model.root.traverse((q) => {
      if (!q.isMesh || !q.geometry || under(q, P.model.envGroup) || under(q, P.model.interiorGroup) || inSteps(q) || !q.visible) return;
      if (!q.geometry.boundingBox) q.geometry.computeBoundingBox();
      const b = q.geometry.boundingBox;
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const v = new V(x, y, z).applyMatrix4(q.matrixWorld);
        pts.push([v.x, v.y, v.z]);
      }
    });
    return { grade: P.model.grade, target: P.controls.target.y, framed: pts.map((p) => { const v = new V(...p).project(P.camera); return [v.x, v.y, v.z]; }) };
  }, { W, L });
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
    if (c.ramp) await placeRampEast(page, ok, tag, W, L);
    const dock = await measureDock(page, W, L);
    await openEditor(page);
    const m = await measure(page, W, L);
    const g = c.grade;
    ok(`${tag}: model.grade ${g}`, near(m.grade, g, 1e-9), f3(m.grade));
    ok(`${tag}: the grass is at -${g}, and still takes shadows`, near(m.groundY, -g, 1e-6) && m.groundReceives === true, f3(m.groundY));
    ok(`${tag}: the ground labels lie on it`, m.labelYs.length >= 2 && m.labelYs.every((y) => near(y, -g + 0.04, 0.01)), m.labelYs.map(f3).join(" "));

    if (!c.kind) {
      // ── 7. at grade: untouched ──
      ok(`${tag}: no skirt, no supports, no shade; model.foundation null`, m.anyFoundationPart === 0 && m.foundation === null, `${m.anyFoundationPart} parts`);
      ok(`${tag}: the corner boards stand on the floor`, m.corners.length === 4 && m.corners.every((q) => near(q.bottom, 0, 1e-6)), m.corners.map((q) => f3(q.bottom)).join(" "));
      ok(`${tag}: the orbit target is the old 0.45 of the frame height, in the editor and the dock`, m.target && near(m.target[1], PURE.d3FrameHeightFt(c.d3, W, L) * 0.45, 1e-6)
        && near(dock.target, Math.max(8, PURE.d3FrameHeightFt(c.d3, W, L)) * 0.45, 1e-6), m.target && `${f3(m.target[1])} dock ${f3(dock.target)}`);
    } else {
      const F = m.foundation;
      const alongX = W >= L, across = alongX ? L : W, len = alongX ? W : L;
      const nRun = Math.max(2, Math.round(across / 4)), nSup = Math.max(2, Math.ceil((len - 1.2) / 7 - 1e-9) + 1);
      ok(`${tag}: model.foundation is the ${c.kind}`, F && F.kind === c.kind && near(F.grade, g, 1e-9), JSON.stringify(F && { kind: F.kind, grade: F.grade }));
      // ── 2. the skirt and the corners ──
      const skirt = F ? F.skirt : NaN;
      ok(`${tag}: four skirt boxes of the wall material, from ${f3(skirt)} under the floor up to it`,
        m.skirt.length === 4 && m.skirt.every((s) => s.mat === "wall" && near(s.mn[1], -skirt, 1e-6) && near(s.mx[1], 0, 1e-6)) && near(skirt, Math.min(0.5, Math.max(0.35, g - 0.1)), 1e-9),
        m.skirt.map((s) => `${f3(s.mn[1])}..${f3(s.mx[1])} ${s.mat}`).join(" | "));
      ok(`${tag}: the skirt runs round the footprint, on the walls' plane`,
        m.skirt.every((s) => Math.max(Math.abs(s.mn[0]), Math.abs(s.mx[0])) <= W / 2 + 0.151 && Math.max(Math.abs(s.mn[2]), Math.abs(s.mx[2])) <= L / 2 + 0.151));
      ok(`${tag}: the corner boards run down over it`, m.corners.length === 4 && m.corners.every((q) => near(q.bottom, -skirt, 1e-6)), m.corners.map((q) => f3(q.bottom)).join(" "));
      // ── 3. runners and supports ──
      const rb = -0.35 - (F ? F.runnerH : 0);
      ok(`${tag}: ${nRun} runners along the ${alongX ? "x" : "z"} axis, under the floor band`,
        m.runners.length === nRun && m.runners.every((r) => near(r.mx[1], -0.35, 1e-6) && near(r.mn[1], rb, 1e-6) && (alongX ? r.mx[0] - r.mn[0] > len : r.mx[2] - r.mn[2] > len)),
        `${m.runners.length} runners ${m.runners.map((r) => f3(r.mn[1])).join(" ")}`);
      const sup = c.kind === "blocks" ? m.blocks : m.piers;
      // Blocks stack in courses: the foot of each stack is its lowest block.
      const stacks = new Map();
      sup.forEach((s) => {
        const k = `${((s.mn[0] + s.mx[0]) / 2).toFixed(2)},${((s.mn[2] + s.mx[2]) / 2).toFixed(2)}`;
        const cur = stacks.get(k) || { bottom: Infinity, top: -Infinity, n: 0, s };
        cur.bottom = Math.min(cur.bottom, s.mn[1]); cur.top = Math.max(cur.top, s.mx[1]); cur.n++;
        stacks.set(k, cur);
      });
      ok(`${tag}: ${nRun * nSup} supports, ${nSup} under each runner (every 7 ft or less)`, stacks.size === nRun * nSup && F && F.supports.length === nRun * nSup, `${stacks.size} built, model ${F && F.supports.length}`);
      ok(`${tag}: ⚠️ EVERY SUPPORT REACHES THE GRASS AND THE RUNNER EXACTLY`, [...stacks.values()].every((t) => near(t.bottom, -g, 0.002) && near(t.top, rb, 0.002)),
        [...stacks.values()].slice(0, 4).map((t) => `${f3(t.bottom)}..${f3(t.top)}`).join(" "));
      const alongs = [...new Set([...stacks.values()].map((t) => (alongX ? (t.s.mn[0] + t.s.mx[0]) / 2 : (t.s.mn[2] + t.s.mx[2]) / 2).toFixed(2)))].map(Number).sort((a, b) => a - b);
      ok(`${tag}: spaced 7 ft or less, the end ones near the ends`, alongs.length === nSup && alongs.slice(1).every((v, i) => v - alongs[i] <= 7 + 1e-6) && near(alongs[0], -len / 2 + 0.6, 0.01),
        alongs.map(f3).join(" "));
      if (c.kind === "blocks") {
        const courses = F ? F.courses : 0;
        ok(`${tag}: 16x8 in blocks, their long side across the runner, ${courses} course(s) a stack`,
          courses >= 1 && [...stacks.values()].every((t) => t.n === courses) && sup.every((s) => {
            const dx = s.mx[0] - s.mn[0], dz = s.mx[2] - s.mn[2];
            return alongX ? near(dx, 8 / 12, 0.002) && near(dz, 16 / 12, 0.002) : near(dx, 16 / 12, 0.002) && near(dz, 8 / 12, 0.002);
          }), `courses ${courses}`);
      } else {
        ok(`${tag}: round piers, 12 in across`, sup.every((s) => s.geo === "CylinderGeometry" && near(s.r, 0.5, 1e-9)));
      }
      ok(`${tag}: supports and runners cast shadows`, sup.every((s) => s.cast) && m.runners.every((r) => r.cast));
      ok(`${tag}: a shade on the grass under the building${c.porch ? " and the deck" : ""}, with the grass`,
        m.shades.length === (c.porch ? 2 : 1) && m.shades.every((s) => near(s.y, -g + 0.02, 1e-6) && s.inEnv && s.transparent), JSON.stringify(m.shades));
      // ── 6. the camera ──
      const lift = g - 0.35, fH = PURE.d3FrameHeightFt(c.d3, W, L);
      ok(`${tag}: the orbit target comes down with the ground (${f3(fH * 0.45 - lift)})`, m.target && near(m.target[1], fH * 0.45 - lift, 1e-6), m.target && f3(m.target[1]));
      const inNdc = (p) => Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1 && p[2] < 1;
      ok(`${tag}: ⚠️ THE 3D EDITOR FRAMES THE GRASS UNDER EVERY CORNER AND EVERY SUPPORT'S FOOT`, m.framed.every(inNdc),
        m.framed.filter((p) => !inNdc(p)).slice(0, 3).map((p) => p.map(f3).join(",")).join(" | "));
      ok(`${tag}: ⚠️ ...AND THE DOCKED PANEL FRAMES ALL OF IT, ITS TARGET DOWN BY THE LIFT TOO`,
        near(dock.grade, g, 1e-9) && near(dock.target, Math.max(8, fH) * 0.45 - lift, 1e-6) && dock.framed.every(inNdc),
        `target ${f3(dock.target)} ` + dock.framed.filter((p) => !inNdc(p)).slice(0, 3).map((p) => p.map(f3).join(",")).join(" | "));
    }
    // ── 4. the porch ──
    if (c.porch) {
      ok(`${tag}: the deck is at the floor`, near(m.deckTop, 0, 0.002), f3(m.deckTop));
      const st = m.steps[0];
      const count = c.steps, rise = g / (count + 1);
      ok(`${tag}: ${count} step(s), each riser ${f3(rise * 12)} in (7.5 in or less)`, st && st.treads.length === count && st.risers === count && rise <= 7.5 / 12 + 1e-9,
        st && `${st.treads.length} treads, ${st.risers} risers`);
      ok(`${tag}: the steps land on the grass and climb to one riser under the deck`, st && near(st.bottom, -g, 0.002) && near(st.top, -g + count * rise, 0.002),
        st && `${f3(st.bottom)}..${f3(st.top)}`);
      const tops = st ? st.treads.map((t) => t.top).sort((a, b) => a - b) : [];
      ok(`${tag}: the treads rise evenly`, tops.length === count && tops.every((t, i) => near(t, -g + (i + 1) * rise, 0.002)), tops.map(f3).join(" "));
      if (c.kind) {
        const n = m.posts.length, rows = c.deep ? 2 : 1;
        const stacks = new Map();
        m.deckSupports.forEach((s) => {
          const k = `${((s.mn[0] + s.mx[0]) / 2).toFixed(2)},${((s.mn[2] + s.mx[2]) / 2).toFixed(2)}`;
          const cur = stacks.get(k) || { bottom: Infinity, top: -Infinity, cx: (s.mn[0] + s.mx[0]) / 2, cz: (s.mn[2] + s.mx[2]) / 2 };
          cur.bottom = Math.min(cur.bottom, s.mn[1]); cur.top = Math.max(cur.top, s.mx[1]);
          stacks.set(k, cur);
        });
        ok(`${tag}: the deck has its own supports, ${rows} row(s) of ${n} (one under every post)`, stacks.size === n * rows, `${stacks.size} for ${n} posts`);
        ok(`${tag}: ⚠️ EACH ONE FROM THE RIM'S UNDERSIDE TO THE GRASS`, [...stacks.values()].every((t) => near(t.bottom, -g, 0.002) && near(t.top, m.rimBottom, 0.002)),
          [...stacks.values()].slice(0, 3).map((t) => `${f3(t.bottom)}..${f3(t.top)}`).join(" ") + ` rim ${f3(m.rimBottom)}`);
        const front = [...stacks.values()].filter((t) => m.posts.some((p) => near(p[0], t.cx, 0.02) || near(p[1], t.cz, 0.02)));
        ok(`${tag}: under the posts`, front.length >= n, `${front.length}`);
      } else {
        ok(`${tag}: no deck supports at grade`, m.deckSupports.length === 0);
      }
    }
    // ── 5. the ramp ──
    if (c.ramp) {
      const r = m.ramps.find((q) => q.wall === "east");
      const run = Math.max(3, 4 * g);
      ok(`${tag}: the ramp runs from the floor down to the grass`, r && near(r.mn[1], -g, 0.08) && r.mx[1] <= 0.13, r && `${f3(r.mn[1])}..${f3(r.mx[1])}`);
      ok(`${tag}: ${f3(run)} ft out from the wall (${g > 0.75 ? "4 ft per foot of drop" : "3 ft, as always"})`, r && near(r.mx[0] - (W / 2 + 0.15), run, 0.1), r && f3(r.mx[0] - W / 2 - 0.15));
    }
    if (shots) {
      const R = Math.max(W, L);
      await page.evaluate(({ R, g }) => {
        const E = window.__ss3dEngine;
        E.camera.position.set(R * 0.9, 4 - g, R * 1.1);
        E.controls.target.set(0, 2 - g, 0);
        E.controls.update();
        E.render();
      }, { R, g });
      await settle(page, 300);
      await page.evaluate(() => window.__ss3dEngine.render());
      const canvas = page.locator("canvas").last();
      await canvas.screenshot({ path: join(shots, `${c.id}-corner.png`) });
    }
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    await page.close();
  }
}

// ── 8. THE PANEL ────────────────────────────────────────────────────────────────────────────
const PANEL_STYLES = [
  { value: "cabin", label: "Harness Found Cabin", d3: { roof: { type: "shed", highSide: "front", pitch: 0.22, overhang: 0.8, eave: "fascia" }, siding: "batten", colors: PLAIN, wallHeightFt: 7.3, roofMaterial: "metal" } },
  { value: "tri", label: "Harness Found Tri", d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 1 }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
].map((s) => ({ ...s, img: null, sizes: ["16x10"], sizeInclusions: {}, sizeInclusionQty: {} }));
const PANEL_CONFIG = {
  clientId: "harness-foundation-panel",
  branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: PANEL_STYLES,
  defaultSizes: ["16x10"],
  sizePricing: Object.fromEntries(PANEL_STYLES.map((s) => [s.value, { "16x10": { widthFt: 16, lengthFt: 10, basePrice: 9000 } }])),
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
  const height = () => page.locator('input[data-ss-floor-height="ss-grid"]');
  const typeHeight = async (v) => {
    await height().click();
    await height().fill(String(v));
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
    await openStyle("Harness Found Cabin");
    const opts = await select().locator("option").evaluateAll((os) => os.map((o) => o.value));
    ok("panel: 'What it stands on' offers not set, slab, skids, blocks and piers", JSON.stringify(opts) === JSON.stringify(["", "slab", "skids", "blocks", "piers"]), JSON.stringify(opts));
    ok("panel: no floor height box without blocks or piers", (await height().count()) === 0);
    let body = await save();
    ok("panel: ⚠️ SAVED UNTOUCHED, NO FOUNDATION KEY AND NO HEIGHT", !has(body.d3, "foundation") || body.d3.foundation === null, JSON.stringify({ f: body.d3.foundation, h: body.d3.floorHeightFt }));
    ok("panel: ...and no floorHeightFt", !has(body.d3, "floorHeightFt"));
    ok("panel: every save says frame \"front\"", body.frame === "front", String(body.frame));

    await select().selectOption("blocks");
    await settle(page);
    ok("panel: blocks shows the floor height box, blank, saying the 1 ft it draws", (await height().count()) === 1 && (await height().inputValue()) === "" && (await height().getAttribute("placeholder")) === "1 ft");
    const hint = (await height().locator("xpath=..").innerText()).replace(/\s+/g, " ");
    ok("panel: ...and that ramps are drawn to reach the ground", /reaches the ground/.test(hint) && /Porch steps climb/.test(hint), hint.slice(0, 200));
    body = await save();
    ok("panel: blocks with a blank height saves blocks and no height", body.d3.foundation === "blocks" && !has(body.d3, "floorHeightFt"), JSON.stringify(body.d3.foundation));
    await typeHeight(1.1);
    body = await save();
    ok("panel: a typed 1.1 saves floorHeightFt 1.1", body.d3.floorHeightFt === 1.1, String(body.d3.floorHeightFt));
    await typeHeight(9);
    body = await save();
    ok("panel: past the band it saves at the top, 6", body.d3.floorHeightFt === 6, String(body.d3.floorHeightFt));
    await typeHeight("");
    body = await save();
    ok("panel: ⚠️ A CLEARED HEIGHT DELETES THE KEY", body.d3.foundation === "blocks" && !has(body.d3, "floorHeightFt"), JSON.stringify(body.d3));
    await typeHeight(2);
    await select().selectOption("skids");
    await settle(page);
    ok("panel: skids hides the height box", (await height().count()) === 0);
    body = await save();
    ok("panel: ⚠️ LEAVING BLOCKS DELETES THE HEIGHT", body.d3.foundation === "skids" && !has(body.d3, "floorHeightFt"), JSON.stringify({ f: body.d3.foundation, h: body.d3.floorHeightFt }));
    await select().selectOption("");
    await settle(page);
    body = await save();
    ok("panel: 'Not set' deletes the foundation", !has(body.d3, "foundation"), JSON.stringify(body.d3.foundation));
    if (shots) await select().locator("xpath=../..").screenshot({ path: join(shots, "panel-row.png") }).catch(() => {});

    await openStyle("Harness Found Tri");
    ok("panel: a style storing piers opens on piers, its height shown", (await select().inputValue()) === "piers" && (await height().inputValue()) === "1.5");
    body = await save();
    ok("panel: ...and saves them back untouched", body.d3.foundation === "piers" && body.d3.floorHeightFt === 1.5, JSON.stringify({ f: body.d3.foundation, h: body.d3.floorHeightFt }));
    // The preview draws the DRAFT: a typed 2 ft puts its grass 2 ft down and its target with it.
    await typeHeight(2);
    await page.getByRole("button", { name: /Preview in 3D/ }).first().click();
    await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.grade > 1.9); }, null, { timeout: 60000 });
    await settle(page, 800);
    const pv = await page.evaluate(() => { const E = window.__ss3dEngine; return { grade: E.model.grade, target: E.controls.target.y }; });
    const spec2 = { ...PANEL_STYLES[1].d3, floorHeightFt: 2 };
    ok("panel: the 3D preview draws the typed height, its orbit target lowered with the grass",
      Math.abs(pv.grade - 2) < 1e-9 && Math.abs(pv.target - (PURE.d3FrameHeightFt(spec2, 16, 10) * 0.45 - 1.65)) < 1e-6, JSON.stringify(pv));
    if (shots) await page.locator("canvas").last().screenshot({ path: join(shots, "panel-preview.png") }).catch(() => {});
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
const shots = process.env.SS_SHOTS ? shotsDir("foundation") : null;
const { browser, ctx } = await launch({ width: 1280, height: 900 });
try {
  const N = Number(process.env.SS_CONC || 3);
  const q = todo.slice();
  const jobs = Array.from({ length: N }, async () => { while (q.length) await runCase(ctx, q.shift(), ok, shots); });
  if (!only || only.includes("panel")) jobs.push(runPanel(ctx, ok, shots));
  await Promise.all(jobs);
} finally {
  await browser.close();
}
const bad = failed();
console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL PASS");
process.exit(bad.length ? 1 : 0);
