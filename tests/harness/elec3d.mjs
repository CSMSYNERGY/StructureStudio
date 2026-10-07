// Electrical devices in the 3D: drawn where the plan says, and placed, picked, dragged and removed
// there like any other item.
//
// Carolyn, 2026-09-14, on the expo build: she added a Flood Light and a Ceiling Fan from "Add an
// electrical item", the floor plan showed them, and the full-screen 3D showed an empty building.
// buildShed3DModel's buildElectrical3D draws them now (plan step 1.8). On 2026-10-06 she answered
// "yes, customers add outlets, lights and fans in the 3D view", so the 3D editor has its own
// Electrical Items chooser. This drives the real designer, places every kind of device in 2D with
// real clicks, opens the 3D editor and measures the scene graph through __SS3D_DEBUG:
//
//   1. one ssElec group per electrical item, and every one whose tool exists carries itemId
//   2. outlet cover plates at 18in (world y 1.5) on the INTERIOR face; switch, 220V, breaker by size
//   3. flood lights wholly OUTSIDE the footprint and mounted on the building (eave wall capped
//      under the eave, gable end allowed into the gable)
//   4. ceiling light just under the plate, fan hub + 4 blades at H - 0.6
//   5. no device casts a shadow, before and after a scoped interior rebuild
//   6. a REAL click at an outlet, the fan and a flood light SELECTS it (footer "🗑 Remove <name>")
//      and moves nothing; the same click at the workbench still selects it
//   7. Look inside and exterior screenshots
//   8. a RAISED CENTRE (roof.wingSide, 2026-09-24 review): a flood light on the centre's own eave
//      wall, which stands above H, hangs 0.2-0.35 ft under THAT wall's eave finish, not in its
//      soffit at the wall top minus 0.75 (the wing's eave is feet lower and says nothing about it)
//   9. the 3D Add row has exactly ONE Electrical Items button ([data-ss-elec3d]) and still no
//      button per device. Matched by its attribute: /Electrical Items/ also matches the 2D palette
//      behind the modal.
//  10. the button opens "Pick an electrical item": a card per offered item, worded like the plan's
//      picker ("wall mounted · 18″ up", "ceiling"), with no price on any card
//  11. Outlet card, then a click on the south wall: ONE item, e-out at 18in on that wall, where it
//      was clicked; its plate drawn at world y 1.5 on the interior face; selected
//  12. Ceiling Fan and Light cards, then a click on the floor: no wall, stamped, hung where the
//      floor was clicked (fan hub at H - 0.6, light disc at H - 0.06)
//  13. hovering each of the three outlines it where it is DRAWN (the flood light too, in 6: under
//      the eave, not at the 120in it was asked for); screenshots of the three placed from 3D
//  14. a ceiling device clicked out on the lawn is refused with a sentence and adds nothing; the
//      button then disarms it
//  15. dragging the 3D-placed outlet along its wall moves it on the plan and keeps its 18in
//  16. Remove (the footer) takes it off the plan and out of the scene
//  17. PRICE PARITY, two fresh pages: one Outlet and one Ceiling Fan placed from the 2D picker, and
//      the same two placed from the 3D chooser, give the same elecItem quote rows (qty, unit,
//      amount), the same itemSummary.electricalItems in the submit payload, and items carrying
//      the same keys
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/elec3d.mjs                  (exit 0 = every check held)
import { pathToFileURL } from "node:url";
import { launch, stubSupabase, recordRefusals, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir, revealTool, REF } from "./lib.mjs";
import { CONFIG as BASE_CONFIG, chooseSize } from "./electrical.mjs";

const W = 12, L = 24, T = 0.3;
// The viewer imports exactly this specifier (loadThree, THREE_VERSION). The page's module map
// hands back the SAME instance, so a Raycaster built here raycasts the app's own objects.
const THREE_URL = "https://esm.sh/three@0.167.0";

// Two more wall devices so the size-by-name branches are exercised: a 220V receptacle and a
// breaker panel. Everything else (Outlet 18in in the package, Light Switch 48in, Light on the
// ceiling, Flood Light 120in, Ceiling Fan) comes from electrical.mjs.
export const CONFIG = {
  ...BASE_CONFIG,
  clientId: "harness-elec3d",
  electricalItems: [
    ...BASE_CONFIG.electricalItems,
    { id: "e-220", icon: "🔌", name: "220V Outlet", mount: "wall", withPackage: true, standalone: true, priceWithPackage: 95, priceStandalone: 140, heightOffFloorIn: 48 },
    { id: "e-brk", icon: "🧰", name: "Breaker Panel", mount: "wall", withPackage: true, standalone: true, priceWithPackage: 400, priceStandalone: 600, heightOffFloorIn: 48 },
  ],
};

// The same 12x24, as a raised centre: the front is the centre's gable end, a 4 ft wing down the WEST
// side, and the EAST wall is the centre's own eave wall, standing 10.5 ft to the wing's 8. A 10 ft
// flood light there is taller than that eave allows, so the cap is what decides where it hangs.
export const CONFIG_RAISED = {
  ...CONFIG,
  clientId: "harness-elec3d-raised",
  buildingStyles: CONFIG.buildingStyles.map((s) => ({ ...s, d3: {
    roof: { type: "gable", front: "gable", pitch: 0.67, overhang: 1, eave: "fascia", wingSide: "left", wingWidthFt: 4, wingPitch: 0.25, centerEaveFt: 10.5 },
    siding: "lap", colors: { body: "#eeebe0", trim: "#686c70", roof: "#5f6266" }, wallHeightFt: 8,
  } })),
};

// The price-parity pages (17): contactFields [] opens Details and Get Quote with no typing.
export const CONFIG_PARITY = { ...CONFIG, clientId: "harness-elec3d-parity", contactFields: [] };

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const f3 = (v) => (v == null ? "?" : Number(v).toFixed(3));

// Screen point just inside a wall, `alongFt` from its plan origin (west end / north end).
async function wallPoint(page, wall, alongFt) {
  const r = await buildingRect(page);
  const fx = r.w / W, fy = r.h / L, inset = 0.4;
  const p = wall === "north" ? [r.x + alongFt * fx, r.y + inset * fy]
    : wall === "south" ? [r.x + alongFt * fx, r.y + r.h - inset * fy]
    : wall === "west" ? [r.x + inset * fx, r.y + alongFt * fy]
    : [r.x + r.w - inset * fx, r.y + alongFt * fy];
  return svgPoint(page, p[0], p[1]);
}
async function insidePoint(page, xFt, yFt) {
  const r = await buildingRect(page);
  return svgPoint(page, r.x + xFt * (r.w / W), r.y + yFt * (r.h / L));
}

// Pick from "Add an electrical item", then click the plan. Returns the new item or null.
async function placeElec(page, name, type, pointFn) {
  if (await page.getByText("Add an electrical item").count()) await page.keyboard.press("Escape");
  const before = ((await readItems(page)) || []).filter((i) => i.type === type).length;
  await (await revealTool(page, /Electrical Items/)).click();
  await settle(page, 300);
  await page.getByText(name, { exact: true }).first().click();
  await settle(page, 300);
  const p = await pointFn();
  await page.mouse.click(p.x, p.y);
  await settle(page);
  const all = ((await readItems(page)) || []).filter((i) => i.type === type);
  return all.length > before ? all[all.length - 1] : null;
}

async function placeBench(page, alongFt) {
  if (await page.getByText("Add an electrical item").count()) await page.keyboard.press("Escape");
  await (await revealTool(page, /^📚/)).click();
  await settle(page, 300);
  await page.getByText("Workbench", { exact: true }).last().click();
  await settle(page, 300);
  const p = await wallPoint(page, "north", alongFt);
  await page.mouse.click(p.x, p.y);
  await settle(page);
  return ((await readItems(page)) || []).find((i) => i.type === "workbench") || null;
}

async function openEditor(page) {
  const edit = page.getByRole("button", { name: /Edit in 3D/ });
  if (!(await edit.count()) || !(await edit.first().isVisible())) {
    const show = page.getByRole("button", { name: /Show 3D/ });
    if (await show.count()) { await show.first().click(); await settle(page, 800); }
  }
  if ((await edit.count()) && (await edit.first().isVisible())) { await edit.first().click(); await settle(page, 800); }
  await page.waitForFunction(() => {
    const E = window.__ss3dEngine;
    return !!(E && E.model && E.model.interiorGroup && E.model.interiorGroup.children.some((g) => g.userData && g.userData.ssElec));
  }, null, { timeout: 90000 });
  await settle(page, 1200);
}
// The full-screen viewer's ✕ sits beside its "3D Preview" title.
async function closeEditor(page) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "✕" && x.previousElementSibling && /^3D Preview/.test(x.previousElementSibling.textContent.trim()));
    if (b) b.click();
  });
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].some((x) => x.textContent.trim() === "✕" && x.previousElementSibling && /^3D Preview/.test(x.previousElementSibling.textContent.trim())), null, { timeout: 20000 }).catch(() => {});
  await settle(page, 1000);
}

// Every ssElec group in interiorGroup, measured in world space.
async function measure(page) {
  return page.evaluate(() => {
    const E = window.__ss3dEngine;
    const V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const worldBox = (o) => {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      [bb.min.x, bb.max.x].forEach((x) => [bb.min.y, bb.max.y].forEach((y) => [bb.min.z, bb.max.z].forEach((z) => {
        const v = new V(x, y, z).applyMatrix4(o.matrixWorld);
        [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
      })));
      return { min: mn, max: mx, ctr: mn.map((v, k) => (v + mx[k]) / 2) };
    };
    let wallTop = -Infinity;
    E.model.wallsGroup.traverse((o) => { if (o.isMesh && o.geometry) wallTop = Math.max(wallTop, worldBox(o).max[1]); });
    const groups = [];
    let benchPickable = false;
    E.model.interiorGroup.children.forEach((g) => {
      if (g.userData && g.userData.itemId && !g.userData.ssElec) benchPickable = true;
      if (!(g.userData && g.userData.ssElec)) return;
      let itemIdUp = false, q = g;
      while (q) { if (q.userData && q.userData.itemId) itemIdUp = true; q = q.parent; }
      const meshes = [];
      let itemIdDown = false;
      g.traverse((o) => {
        if (o !== g && o.userData && o.userData.itemId) itemIdDown = true;
        if (!o.isMesh) return;
        const p = o.geometry.parameters || {};
        const mm = Array.isArray(o.material) ? o.material[0] : o.material;
        meshes.push({
          geom: o.geometry.type,
          w: p.width, h: p.height, d: p.depth, r: p.radiusTop,
          castShadow: o.castShadow,
          emissive: !!(mm && mm.emissive && (mm.emissive.r + mm.emissive.g + mm.emissive.b) > 0.1),
          ...worldBox(o),
        });
      });
      groups.push({ ssElec: g.userData.ssElec, forId: g.userData.ssElecFor, itemId: itemIdUp || itemIdDown, ownItemId: g.userData.itemId || null, meshes });
    });
    return { wallTop, groups, benchPickable };
  });
}

// Aim, render synchronously. Returns the canvas rect.
async function aim(page, eye, at) {
  return page.evaluate(({ eye, at }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(eye[0], eye[1], eye[2]);
    E.controls.target.set(at[0], at[1], at[2]);
    E.camera.lookAt(at[0], at[1], at[2]);
    E.camera.updateProjectionMatrix();
    E.controls.update && E.controls.update();
    E.render();
    const c = E.renderer.domElement.getBoundingClientRect();
    return { x: c.x, y: c.y, width: c.width, height: c.height };
  }, { eye, at });
}
// The same WITHOUT OrbitControls.update(), which pushes the eye out to minDistance (about 22 ft on
// this building) and so out through a wall. Placement and drag clicks need the eye where it is put:
// pickWall3 takes the FIRST wall the ray meets.
async function aimRaw(page, eye, at) {
  return page.evaluate(({ eye, at }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(eye[0], eye[1], eye[2]);
    E.camera.lookAt(at[0], at[1], at[2]);
    E.camera.updateProjectionMatrix();
    E.camera.updateMatrixWorld(true);
    E.render();
    const c = E.renderer.domElement.getBoundingClientRect();
    return { x: c.x, y: c.y, width: c.width, height: c.height };
  }, { eye, at });
}
async function shot(page, path, eye, at, raw = false) {
  const clip = raw ? await aimRaw(page, eye, at) : await aim(page, eye, at);
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__ss3dEngine.render());
  await page.screenshot({ path, clip });
}
// A world point's client coordinates under the current camera.
async function clientOf(page, world) {
  return page.evaluate((w) => {
    const E = window.__ss3dEngine;
    const V = E.camera.position.constructor;
    E.camera.updateMatrixWorld(true);
    const v = new V(w[0], w[1], w[2]).project(E.camera);
    const rc = E.renderer.domElement.getBoundingClientRect();
    return { x: rc.left + ((v.x + 1) / 2) * rc.width, y: rc.top + ((1 - v.y) / 2) * rc.height, onScreen: v.z < 1 && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95 };
  }, world);
}

// Project a world point to the client, and report what the app's pick walk would find there:
// the FIRST hit among the groups pickItem3 raycasts (is it a device?), and the first hit that
// carries an itemId (what pickItem3 would select). Same module instance as the app's three.
async function probePoint(page, world) {
  return page.evaluate(async ({ world, url }) => {
    const THREE = await import(url);
    const E = window.__ss3dEngine;
    E.scene.updateMatrixWorld(true);
    const v = new THREE.Vector3(world[0], world[1], world[2]).project(E.camera);
    const rc = E.renderer.domElement.getBoundingClientRect();
    const client = { x: rc.left + ((v.x + 1) / 2) * rc.width, y: rc.top + ((1 - v.y) / 2) * rc.height };
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(v.x, v.y), E.camera);
    const hits = ray.intersectObjects([E.model.openingsGroup, E.model.interiorGroup], true);
    const tagOf = (o) => { let n = o; while (n) { if (n.userData && (n.userData.itemId || n.userData.ssElec)) return n.userData; n = n.parent; } return null; };
    const first = hits.length ? tagOf(hits[0].object) : null;
    let picked = null;
    for (const h of hits) { let n = h.object; while (n && !(n.userData && n.userData.itemId)) n = n.parent; if (n) { picked = n.userData.itemId; break; } }
    return { client, onScreen: v.z < 1 && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95, firstIsDevice: !!(first && first.ssElec), firstTag: first, picked };
  }, { world, url: THREE_URL });
}

async function footerRemove(page) {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((el) => (el.innerText || "").trim().startsWith("🗑 Remove ") && el.offsetParent);
    return b ? b.innerText.trim() : null;
  });
}
async function clickFooterRemove(page) {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((el) => (el.innerText || "").trim().startsWith("🗑 Remove ") && el.offsetParent);
    if (b) b.click();
    return !!b;
  });
}

// A real click at a world point. `expect` = the item it must select, by id, and the footer it must show.
async function clickCheck(page, ok, label, world, expect) {
  const before = JSON.stringify(await readItems(page));
  const pr = await probePoint(page, world);
  ok(`${label}: the pick ray at that point finds item ${expect.id}${expect.device ? ", and the device is the first thing under the pointer" : ""}`,
    pr.onScreen && pr.picked === expect.id && (!expect.device || pr.firstIsDevice), JSON.stringify({ onScreen: pr.onScreen, picked: pr.picked, first: pr.firstTag }));
  await page.mouse.click(pr.client.x, pr.client.y);
  await settle(page, 600);
  const footer = await footerRemove(page);
  const after = JSON.stringify(await readItems(page));
  ok(`${label}: a real click selects it (footer "${expect.footer}")`, footer === expect.footer, String(footer));
  ok(`${label}: and moves nothing`, before === after);
}

// Hover a device at `world` and report the amber outline (placeHighlight) against the device's DRAWN
// box: `inside` = the whole device is in the outline, `snug` = no side of it more than 1.2 ft away.
async function hoverOutline(page, id, world) {
  const c = await clientOf(page, world);
  if (!c.onScreen) return { found: false, onScreen: false };
  await page.mouse.move(c.x - 40, c.y - 40);
  await page.mouse.move(c.x, c.y, { steps: 4 });
  await settle(page, 350);
  return page.evaluate(async ({ id, url }) => {
    const THREE = await import(url);
    const E = window.__ss3dEngine;
    E.scene.updateMatrixWorld(true);
    const hl = E.scene.children.find((o) => o.isLineSegments && o.material && o.material.color && o.material.color.getHex() === 0xfbbf24);
    const g = E.model.interiorGroup.children.find((x) => x.userData && x.userData.ssElecFor === id);
    if (!hl || !g) return { found: false, hl: !!hl, g: !!g };
    const hb = new THREE.Box3().setFromObject(hl), gb = new THREE.Box3().setFromObject(g);
    const ks = ["x", "y", "z"];
    const r3 = (v) => v.toArray().map((n) => +n.toFixed(2));
    return {
      found: true, visible: hl.visible,
      inside: ks.every((k) => gb.min[k] >= hb.min[k] - 0.01 && gb.max[k] <= hb.max[k] + 0.01),
      snug: ks.every((k) => gb.min[k] - hb.min[k] <= 1.2 && hb.max[k] - gb.max[k] <= 1.2),
      hb: [r3(hb.min), r3(hb.max)], gb: [r3(gb.min), r3(gb.max)],
    };
  }, { id, url: THREE_URL });
}
const groupMid = (g) => [0, 1, 2].map((k) => (Math.min(...g.meshes.map((x) => x.min[k])) + Math.max(...g.meshes.map((x) => x.max[k]))) / 2);

// The viewer's Electrical Items chooser sheet, as the customer reads it.
async function readSheet(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-ss-elec3d-card]")].filter((b) => b.offsetParent);
    const box = cards.length ? cards[0].parentElement.parentElement : null;
    const title = box ? box.querySelector("span") : null;
    return {
      title: title ? title.textContent.trim() : null,
      text: box ? box.innerText : "",
      cards: cards.map((b) => ({ key: b.getAttribute("data-ss-elec3d-card"), text: b.innerText.replace(/\s+/g, " ").trim() })),
    };
  });
}
const elecButton = (page) => page.locator("[data-ss-elec3d]").first();
const elecButtonText = async (page) => ((await elecButton(page).innerText().catch(() => "")) || "").trim();
// The footer's "← click …" hint, or null.
async function hint(page) {
  return page.evaluate(() => {
    const s = [...document.querySelectorAll("span")].find((el) => el.offsetParent && /^← /.test((el.textContent || "").trim()));
    return s ? s.textContent.trim() : null;
  });
}
// Open the chooser if it is closed, then pick the card for `key`.
async function pickCard(page, key) {
  if (!(await page.locator(`[data-ss-elec3d-card="${key}"]`).count())) {
    await elecButton(page).click();
    await settle(page, 350);
  }
  await page.locator(`[data-ss-elec3d-card="${key}"]`).click();
  await settle(page, 450);
}
const interiorOn = (page) => page.evaluate(() => !!(window.__ss3dEngine && window.__ss3dEngine.interior));
const newItems = async (page, ids) => ((await readItems(page)) || []).filter((i) => !ids.has(i.id));
const idSet = async (page) => new Set(((await readItems(page)) || []).map((i) => i.id));

// Place a wall device from the 3D: its card, then a click on `wall`'s INTERIOR face `alongFt` along,
// from an eye inside the building (the first wall the ray meets is the one aimed at).
async function place3dWall(page, key, wall, alongFt) {
  await pickCard(page, key);
  const armedHint = await hint(page);
  const ids = await idSet(page);
  const wx = alongFt - W / 2;
  const face = wall === "south" ? [wx, 2.5, L / 2 - T / 2 + 0.002] : [wx, 2.5, -L / 2 + T / 2 - 0.002];
  const eye = wall === "south" ? [wx, 4.5, L / 2 - 8] : [wx, 4.5, -L / 2 + 8];
  await aimRaw(page, eye, face);
  const c = await clientOf(page, face);
  await page.mouse.click(c.x, c.y);
  await settle(page, 800);
  return { armedHint, added: await newItems(page, ids) };
}
// Place a ceiling device from the 3D: its card, then a click on the FLOOR at world (x, 0, z).
async function place3dCeiling(page, key, at, H) {
  await pickCard(page, key);
  const armedHint = await hint(page);
  const ids = await idSet(page);
  await aimRaw(page, [at[0] + 1, H + 6, at[2] - 6], at);
  const c = await clientOf(page, at);
  await page.mouse.click(c.x, c.y);
  await settle(page, 800);
  return { armedHint, added: await newItems(page, ids) };
}

export async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("elec3d");
  const { browser, ctx } = await launch({ width: 1440, height: 1000 });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const calls = await stubSupabase(page, { config: CONFIG });
  await recordRefusals(page);

  try {
    await openDesigner(page, CONFIG.clientId);
    await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
    await chooseSize(page);
    await settle(page, 600);

    // ── Place everything in 2D ────────────────────────────────────────────────
    await (await revealTool(page, /Electrical Package/)).click();
    await settle(page, 600);
    const bench = await placeBench(page, 6);
    ok("workbench placed on the north wall (the pick control)", bench && bench.wall === "north");
    const floodN = await placeElec(page, "Flood Light", "e-flood", () => wallPoint(page, "north", 3));
    ok("flood light placed on the north wall (a gable end on this 12x24)", floodN && floodN.wall === "north", JSON.stringify(floodN && { wall: floodN.wall }));
    const floodE = await placeElec(page, "Flood Light", "e-flood", () => wallPoint(page, "east", 12));
    ok("flood light placed on the east wall (an eave wall)", floodE && floodE.wall === "east", JSON.stringify(floodE && { wall: floodE.wall }));
    const heavy = await placeElec(page, "220V Outlet", "e-220", () => wallPoint(page, "west", 12));
    ok("220V outlet placed on the west wall", heavy && heavy.wall === "west", JSON.stringify(heavy && { wall: heavy.wall }));
    const brk = await placeElec(page, "Breaker Panel", "e-brk", () => wallPoint(page, "south", 8));
    ok("breaker panel placed on the south wall", brk && brk.wall === "south", JSON.stringify(brk && { wall: brk.wall }));
    const fan = await placeElec(page, "Ceiling Fan", "e-fan", () => insidePoint(page, 6, 12));
    ok("ceiling fan placed in the middle", !!fan && !fan.wall, JSON.stringify(fan && { wall: fan.wall }));
    if (await page.getByText("Add an electrical item").count()) await page.keyboard.press("Escape");
    await page.screenshot({ path: `${shots}/0-plan.png` });

    const items = (await readItems(page)) || [];
    const elec = items.filter((i) => i.electricalItemId);
    // The plan's frame, read now: the full-screen 3D editor takes the plan out of the page.
    const r = await buildingRect(page);
    const fx = r.w / W;
    // The plan is still a place devices are added: each of these five went in through the 2D
    // "Electrical Items" picker, and the 3D chooser must not have taken that path away.
    const picked2d = [floodN, floodE, heavy, brk, fan];
    ok("the 2D Electrical Items picker still places devices (5 of 5, each with its electricalItemId)",
      picked2d.every((it) => it && it.electricalItemId), picked2d.map((it) => (it ? it.type : "none")).join(" "));
    console.log("electrical items:", JSON.stringify(Object.entries(elec.reduce((m, i) => ((m[i.type] = (m[i.type] || 0) + 1), m), {}))));

    // ── Open the 3D and measure ───────────────────────────────────────────────
    await openEditor(page);
    let m = await measure(page);
    const H = m.wallTop;
    console.log(`wall top (H) ${f3(H)}; ssElec groups ${m.groups.length}`);
    ok("wall height read from the scene is sane", H > 6 && H < 12, f3(H));
    ok("one ssElec group per electrical item", m.groups.length === elec.length, `groups ${m.groups.length}, items ${elec.length}`);
    const forIds = m.groups.map((g) => g.forId).sort((a, b) => a - b).join(",");
    ok("every electrical item drawn exactly once", forIds === elec.map((i) => i.id).sort((a, b) => a - b).join(","), forIds);
    // 1. Every device here has its tool (the package is on and every item is offered with it), so
    // every group carries ITS OWN item's id, on the group itself, which is what pickItem3 walks to.
    ok("1 every device group carries its own itemId (pickItem3 can select it)",
      m.groups.length > 0 && m.groups.every((g) => g.ownItemId === g.forId), JSON.stringify(m.groups.filter((g) => g.ownItemId !== g.forId).map((g) => [g.ssElec, g.forId, g.ownItemId])));
    ok("the workbench's group still carries its itemId", m.benchPickable);
    ok("no device mesh casts a shadow", m.groups.every((g) => g.meshes.every((x) => x.castShadow === false)),
      String(m.groups.reduce((n, g) => n + g.meshes.filter((x) => x.castShadow).length, 0)));

    const inward = (it, ctr) => ({ north: ctr[2] + L / 2, south: L / 2 - ctr[2], west: ctr[0] + W / 2, east: W / 2 - ctr[0] }[it.wall]);
    const plateOf = (g) => g.meshes.filter((x) => x.geom === "BoxGeometry").sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const groupFor = (it) => m.groups.find((g) => g.forId === it.id);

    // Outlets: 18in, inside face.
    const outlets = elec.filter((i) => i.type === "e-out");
    const outRows = outlets.map((it) => { const p = plateOf(groupFor(it)); return { it, p, inw: inward(it, p.ctr) }; });
    ok(`all ${outlets.length} outlet plates centred at world y 1.5 (18in)`, outRows.length > 0 && outRows.every((r) => near(r.p.ctr[1], 1.5, 0.01)),
      [...new Set(outRows.map((r) => f3(r.p.ctr[1])))].join(" "));
    ok("outlet plates sit on the INTERIOR face (0.17 ft in from the wall mid-plane)", outRows.every((r) => near(r.inw, T / 2 + 0.02, 0.015)),
      [...new Set(outRows.map((r) => f3(r.inw)))].join(" "));
    ok("outlet plate is 0.23 x 0.37", outRows.every((r) => near(r.p.w, 0.23, 0.001) && near(r.p.h, 0.37, 0.001)));
    const sw = elec.find((i) => i.type === "e-sw");
    if (sw) { const p = plateOf(groupFor(sw)); ok("light switch plate at world y 4.0 (48in), inside", near(p.ctr[1], 4, 0.01) && near(inward(sw, p.ctr), 0.17, 0.015), `y ${f3(p.ctr[1])} in ${f3(inward(sw, p.ctr))}`); }
    else ok("the package placed a light switch", false);
    if (heavy) { const p = plateOf(groupFor(heavy)); ok("220V plate is the bigger 0.35 x 0.45, at 4.0, inside", near(p.w, 0.35, 0.001) && near(p.h, 0.45, 0.001) && near(p.ctr[1], 4, 0.01) && near(inward(heavy, p.ctr), 0.17, 0.015), `${p.w}x${p.h} y ${f3(p.ctr[1])}`); }
    if (brk) { const p = plateOf(groupFor(brk)); ok("breaker panel is a 1.0 x 1.4 box on the inside face", near(p.w, 1.0, 0.001) && near(p.h, 1.4, 0.001) && near(inward(brk, p.ctr), T / 2 + 0.125, 0.015), `${p.w}x${p.h} in ${f3(inward(brk, p.ctr))}`); }

    // Flood lights: wholly outside, mounted, height rule per wall kind.
    // "Outside" = beyond the bare wall face, less the 0.005 ft the base is deliberately embedded
    // so it never floats (a coplanar back face would flicker).
    const FACE = T / 2 - 0.006;
    const outside = (x) => x.max[0] < -W / 2 - FACE || x.min[0] > W / 2 + FACE || x.max[2] < -L / 2 - FACE || x.min[2] > L / 2 + FACE;
    const headOf = (g) => g.meshes.find((x) => x.geom === "BoxGeometry" && near(x.w, 0.6, 0.001));
    const baseOf = (g) => g.meshes.find((x) => x.geom === "BoxGeometry" && near(x.w, 0.42, 0.001));
    for (const [tag, it] of [["north (gable end)", floodN], ["east (eave wall)", floodE]]) {
      if (!it) continue;
      const g = groupFor(it);
      const head = headOf(g), base = baseOf(g);
      ok(`flood light ${tag}: every mesh is outside the wall face`, g.meshes.every(outside),
        g.meshes.map((x) => `x ${f3(x.min[0])}..${f3(x.max[0])} z ${f3(x.min[2])}..${f3(x.max[2])}`).join(" | "));
      ok(`flood light ${tag}: has a glowing lens`, g.meshes.some((x) => x.emissive));
      if (it === floodE) ok(`flood light ${tag}: 120in capped at or under H - 0.75`, head && head.ctr[1] <= H - 0.75 + 0.001, `head y ${f3(head && head.ctr[1])}, H ${f3(H)}`);
      else ok(`flood light ${tag}: rises into the gable, above the eave cap and no higher than 120in`, head && head.ctr[1] > H - 0.75 + 0.1 && head.ctr[1] <= 10 + 0.001, `head y ${f3(head && head.ctr[1])}`);
      const geo = await page.evaluate(async ({ url, wall, head, base }) => {
        const THREE = await import(url);
        const E = window.__ss3dEngine;
        E.scene.updateMatrixWorld(true);
        const N = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[wall];
        const grpOf = (o) => { let n = o; while (n) { if (n === E.model.wallsGroup) return "walls"; if (n === E.model.roofGroup) return "roof"; n = n.parent; } return null; };
        // Mounted: from just in front of the base, straight at the wall. It must meet the
        // building (eave wall -> the wall; gable end above the plate -> the gable cap) inside
        // the base's own depth. On a gable end this is also the proof the lamp is under the
        // roofline: above it the ray would miss the cap.
        const o1 = new THREE.Vector3(base.ctr[0] + N[0] * 0.6, base.ctr[1], base.ctr[2] + N[1] * 0.6);
        const r1 = new THREE.Raycaster(o1, new THREE.Vector3(-N[0], 0, -N[1]), 0, 2);
        const h1 = r1.intersectObjects([E.model.wallsGroup, E.model.roofGroup], true)[0];
        // Clear of the roof: vertical rays up through the head's footprint (centre + corners),
        // from just under the head to just over it. Any roof face inside that span -- a soffit,
        // a fascia, a slab -- is the roof cutting through the lamp.
        const cuts = [];
        [[0.5, 0.5], [0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98]].forEach(([fx, fz]) => {
          const x = head.min[0] + fx * (head.max[0] - head.min[0]), z = head.min[2] + fz * (head.max[2] - head.min[2]);
          const r = new THREE.Raycaster(new THREE.Vector3(x, head.min[1] - 0.01, z), new THREE.Vector3(0, 1, 0), 0, head.max[1] - head.min[1] + 0.02);
          r.intersectObjects([E.model.roofGroup], true).forEach((h) => cuts.push(+h.point.y.toFixed(3)));
        });
        // The eave fascia over this lamp, if any: the lowest roof mesh bottom above the head's
        // footprint, among axis-aligned boxes (fascia / rake boards), and the head's clearance.
        //
        // ⚠️ MATCHED ON THICKNESS ONLY, NOT ON HEIGHT (2026-09-19). This used to also require
        // height == D3_EAVE.FASCIA_H (0.4), which was safe for exactly as long as one eave
        // framing existed. roof.overhangStyle added a second: a NOTCHED tail is cut back to the
        // deck, so its fascia board is the remnant below the deck line — 0.203 ft at the shapes
        // overhangNotch.mjs measures — and 0.4 stopped matching anything. The failure mode is
        // the nasty one: the traverse simply never fires, fasciaBottom stays null, and the
        // clearance check below fails with "fascia bottom ?" as though the roof had lost its
        // fascia rather than the DETECTOR having gone blind. Nothing was wrong with the model.
        //
        // Thickness is the stable half of that signature: D3_EAVE.FASCIA_T is the board's own
        // 0.14 ft and is framing-independent, while the height is now derived from the pitch and
        // the overhang. Matching on it alone sees both framings, and the ±1 ft footprint filter
        // just below is what actually scopes this to the boards over THIS lamp.
        //
        // Verified rather than assumed: with the notched default this fixture now gets (the
        // stock 0.6 ft overhang derives "notched", D3.OVERHANG > 0.5), the flood light's head
        // top is 7.461 and the notched fascia bottom is 7.746 — a 0.285 ft gap, inside the
        // 0.2–0.35 band this check has always required. The lamp did not move and did not need
        // to; only the board above it got shorter.
        let fasciaBottom = null;
        E.model.roofGroup.traverse((o) => {
          if (!o.isMesh || o.geometry.type !== "BoxGeometry") return;
          const p = o.geometry.parameters;
          if (!(Math.abs(p.width - 0.14) < 0.001)) return;
          const bb = new THREE.Box3().setFromObject(o);
          if (bb.max.x < head.min[0] - 1 || bb.min.x > head.max[0] + 1 || bb.max.z < head.min[2] - 1 || bb.min.z > head.max[2] + 1) return;
          fasciaBottom = fasciaBottom == null ? bb.min.y : Math.min(fasciaBottom, bb.min.y);
        });
        return { mount: h1 ? { d: +(0.6 - h1.distance).toFixed(3), grp: grpOf(h1.object) } : null, cuts, fasciaBottom };
      }, { url: THREE_URL, wall: it.wall, head, base });
      const baseDepth = it.wall === "north" || it.wall === "south" ? base.max[2] - base.min[2] : base.max[0] - base.min[0];
      ok(`flood light ${tag}: mounted -- the ${it === floodE ? "wall" : "gable cap"} is right behind its base`,
        // d = how far the surface the ray meets lies from the base's centre (negative = behind it).
        // Mounted means that surface is inside the base's own depth: the base's back is embedded
        // in it, never standing off it.
        geo.mount && geo.mount.grp === (it === floodE ? "walls" : "roof") && Math.abs(geo.mount.d) <= baseDepth / 2 + 0.01,
        JSON.stringify({ ...geo.mount, halfBase: +(baseDepth / 2).toFixed(3) }));
      ok(`flood light ${tag}: no roof face cuts through the lamp head`, geo.cuts.length === 0, geo.cuts.join(" "));
      // Tucked under the eave: clear of the fascia by at least 0.2 ft (it is not hidden behind the
      // board from eye level), and within 0.35 ft of it (it has not slid halfway down the wall).
      if (it === floodE) ok(`flood light ${tag}: the head's top sits 0.2-0.35 ft under the eave fascia's bottom`,
        geo.fasciaBottom != null && head.max[1] <= geo.fasciaBottom - 0.2 && head.max[1] >= geo.fasciaBottom - 0.35,
        `head top ${f3(head.max[1])} fascia bottom ${f3(geo.fasciaBottom)} gap ${f3(geo.fasciaBottom != null ? geo.fasciaBottom - head.max[1] : null)}`);
    }

    // Ceiling.
    const lights = elec.filter((i) => i.type === "e-lt");
    ok(`${lights.length} ceiling light discs just under the plate (centre H - 0.06)`, lights.length > 0 && lights.every((it) => {
      const d = groupFor(it).meshes.find((x) => x.geom === "CylinderGeometry");
      return d && near(d.ctr[1], H - 0.06, 0.01) && d.emissive && !outside(d);
    }), lights.map((it) => { const d = groupFor(it).meshes.find((x) => x.geom === "CylinderGeometry"); return f3(d && d.ctr[1]); }).join(" "));
    if (fan) {
      const g = groupFor(fan);
      const hub = g.meshes.find((x) => x.geom === "CylinderGeometry" && near(x.r, 0.2, 0.001));
      const blades = g.meshes.filter((x) => x.geom === "BoxGeometry" && near(x.w, 1.6, 0.001));
      ok("fan hub at H - 0.6", hub && near(hub.ctr[1], H - 0.6, 0.01), `hub y ${f3(hub && hub.ctr[1])}`);
      // Blades run DIAGONAL to the walls, so a world-x span undersells them; measure each blade's
      // centre from the hub instead: 1.0 ft out (0.2 hub + half of 1.6), a quarter turn apart.
      const polar = hub ? blades.map((b) => ({ r: Math.hypot(b.ctr[0] - hub.ctr[0], b.ctr[2] - hub.ctr[2]), a: Math.atan2(b.ctr[2] - hub.ctr[2], b.ctr[0] - hub.ctr[0]) })) : [];
      const angs = polar.map((p) => ((p.a * 180) / Math.PI + 360) % 360).sort((a, b) => a - b);
      ok("fan has 4 blades at hub height, 1.0 ft out, a quarter turn apart",
        blades.length === 4 && blades.every((b) => near(b.ctr[1], H - 0.6, 0.02)) && polar.every((p) => near(p.r, 1.0, 0.02))
        && angs.every((a, k) => k === 0 || near(a - angs[k - 1], 90, 1)),
        `blades ${blades.length} r ${polar.map((p) => f3(p.r)).join(" ")} angles ${angs.map((a) => a.toFixed(0)).join(" ")}`);
      ok("fan centred where the plan put it (world 0, 0)", hub && near(hub.ctr[0], 0, 0.15) && near(hub.ctr[2], 0, 0.15), `hub ${f3(hub && hub.ctr[0])}, ${f3(hub && hub.ctr[2])}`);
    }

    // 9. ONE Electrical Items button in the Add row, and still none per device. The per-device
    // buttons would read "<icon> OUTLE" and so on (each tool's shortLabel).
    const elecButtons = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => b.offsetParent && /^\S+\s(OUTLE|FLOOD|CEILI|BREAK|220V|LIGHT)\b/.test((b.innerText || "").trim())).map((b) => b.innerText.trim()));
    ok("9 no per-device electrical buttons in the 3D Add row", elecButtons.length === 0, elecButtons.join(" | "));
    // The row is read by its own "Add" label, so a 2D button elsewhere on the page cannot answer for
    // it, and it must hold the tools that place from 3D (the workbench at least), so an empty or
    // missing row cannot pass vacuously.
    const addRow = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("span")]
        .filter((s) => s.offsetParent && (s.textContent || "").trim() === "Add" && s.parentElement && s.parentElement.querySelector(":scope > button"))
        .map((s) => [...s.parentElement.querySelectorAll(":scope > button")].map((b) => ({ text: (b.textContent || "").trim(), elec: b.hasAttribute("data-ss-elec3d") })));
      return rows.length === 1 ? rows[0] : { rows };
    });
    ok("9 the 3D Add row is on screen, once, with the workbench in it", Array.isArray(addRow) && addRow.some((b) => /\bWB\b|Workbench/i.test(b.text)), JSON.stringify(addRow));
    ok("9 ...holding exactly ONE [data-ss-elec3d] button, \"⚡ Electrical Items\", and no other electrical one",
      Array.isArray(addRow) && addRow.filter((b) => b.elec).length === 1 && addRow.find((b) => b.elec).text === "⚡ Electrical Items"
        && addRow.filter((b) => /electrical/i.test(b.text) || b.text.startsWith("⚡")).length === 1, JSON.stringify(addRow));
    ok("9 ...and it is the only [data-ss-elec3d] on the page", (await page.locator("[data-ss-elec3d]").count()) === 1);

    // ── A scoped interior rebuild keeps them, still shadowless ──────────────────
    await page.evaluate((its) => { const E = window.__ss3dEngine; E.model.rebuildInterior(its); E.render(); }, items);
    m = await measure(page);
    ok("after rebuildInterior: still one group per electrical item", m.groups.length === elec.length, `groups ${m.groups.length}`);
    ok("after rebuildInterior: still no shadows from any device", m.groups.every((g) => g.meshes.every((x) => x.castShadow === false)));

    // ── 6, outside: the flood light click selects it ──────────────────────────
    if (floodE) {
      const head = headOf(groupFor(floodE));
      await shot(page, `${shots}/5-exterior-east-flood.png`, [W / 2 + 9, H - 1.5, 4], [W / 2, H - 1.2, 0]);
      await shot(page, `${shots}/5b-exterior-east-flood-close.png`, [W / 2 + 3.2, H - 1.6, 1.8], [W / 2, H - 0.8, 0]);
      await aim(page, [head.ctr[0] + 5, head.ctr[1] - 1, head.ctr[2] + 1.5], head.ctr);
      await settle(page, 300);
      ok("nothing selected before the flood light click", (await footerRemove(page)) === null, String(await footerRemove(page)));
      // The outline is where the lamp is DRAWN, under the eave, not at the 120in it was asked for.
      const ho = await hoverOutline(page, floodE.id, head.ctr);
      ok("6 hovering the flood light outlines it where it is drawn (under the eave, not at 10 ft)", ho.found && ho.visible && ho.inside && ho.snug, JSON.stringify(ho));
      await clickCheck(page, ok, "6 flood light (exterior)", head.ctr, { id: floodE.id, footer: "🗑 Remove Flood Light", device: true });
    }
    if (floodN) await shot(page, `${shots}/6-exterior-north-gable-flood.png`, [-1, H + 1.5, -L / 2 - 9], [-3, H, -L / 2]);
    await shot(page, `${shots}/7-exterior-overview.png`, [W + 8, H + 8, -L / 2 - 8], [0, H / 2, -2]);

    // ── Look inside: screenshots, then real clicks ─────────────────────────────
    await page.getByRole("button", { name: /Look inside/ }).first().click();
    await settle(page, 600);
    await shot(page, `${shots}/1-look-inside-overview.png`, [W * 0.95, H + 10, L * 0.8], [0, 2, 0]);
    await shot(page, `${shots}/2-look-inside-west-wall.png`, [-0.5, 3.4, 5], [-W / 2, 2.6, 3]);
    await shot(page, `${shots}/3-look-inside-south-wall.png`, [-1, 3.6, 5.5], [-1, 2.6, L / 2]);
    await shot(page, `${shots}/4-look-inside-ceiling.png`, [3.5, 3.2, 5], [0, H - 0.8, -1]);

    // An outlet on the WEST wall far from everything (the 220V is at z 0, the bench is north).
    const westOut = outRows.filter((r) => r.it.wall === "west").sort((a, b) => b.p.ctr[2] - a.p.ctr[2])[0];
    if (westOut) {
      const c = westOut.p.ctr;
      await aim(page, [c[0] + 4, c[1] + 0.6, c[2]], c);
      await settle(page, 300);
      await clickCheck(page, ok, "6 outlet (look inside)", c, { id: westOut.it.id, footer: "🗑 Remove Outlet", device: true });
    } else ok("a west-wall outlet to click", false);
    if (fan) {
      const blade = groupFor(fan).meshes.filter((x) => x.geom === "BoxGeometry" && near(x.w, 1.6, 0.001))[0];
      await aim(page, [blade.ctr[0] + 2.5, 2.5, blade.ctr[2] + 2.5], blade.ctr);
      await settle(page, 300);
      await clickCheck(page, ok, "6 ceiling fan blade (look inside)", blade.ctr, { id: fan.id, footer: "🗑 Remove Ceiling Fan", device: true });
    }
    // The control: the SAME click path on the workbench still selects it.
    const benchNow = ((await readItems(page)) || []).find((i) => i.type === "workbench");
    if (benchNow) {
      const at = await page.evaluate((id) => {
        const E = window.__ss3dEngine;
        const g = E.model.interiorGroup.children.find((x) => x.userData && x.userData.itemId === id);
        return g ? [g.position.x, 2.9, g.position.z] : null;
      }, benchNow.id);
      if (at) {
        await aim(page, [at[0] + 1, at[1] + 3.5, at[2] + 4], at);
        await settle(page, 300);
        await clickCheck(page, ok, "6 workbench control (look inside)", at, { id: benchNow.id, footer: "🗑 Remove Workbench" });
      } else ok("workbench group found for the control", false);
    }

    // ── 10. The chooser ────────────────────────────────────────────────────────
    await elecButton(page).click();
    await settle(page, 400);
    const sheet = await readSheet(page);
    const offered = CONFIG.electricalItems.map((e) => e.id).sort();
    ok("10 the Electrical Items button opens \"Pick an electrical item\"", sheet.title === "Pick an electrical item", JSON.stringify(sheet.title));
    ok("10 ...with one card per offered item", JSON.stringify(sheet.cards.map((c) => c.key).sort()) === JSON.stringify(offered), JSON.stringify(sheet.cards.map((c) => c.key)));
    const cardText = (k) => (sheet.cards.find((c) => c.key === k) || { text: "" }).text;
    ok("10 ...worded as the plan's picker: an Outlet is \"wall mounted · 18″ up\", a Ceiling Fan \"ceiling\"",
      cardText("e-out").includes("Outlet") && cardText("e-out").includes("wall mounted · 18″ up") && cardText("e-fan").includes("Ceiling Fan") && cardText("e-fan").includes("ceiling"),
      JSON.stringify([cardText("e-out"), cardText("e-fan")]));
    ok("10 ...and no card shows a price", sheet.cards.length > 0 && !/\$|\d+\.\d\d/.test(sheet.text), sheet.text.replace(/\s+/g, " "));
    ok("10 ...and no rough-opening tile", (await page.locator("[data-ss-ro-tile3]").count()) === 0);
    await page.screenshot({ path: `${shots}/8-chooser.png` });

    // ── 11. An Outlet on the south wall, from 3D ───────────────────────────────
    const itemsBefore = (await readItems(page)) || [];
    // The widest stretch of the south wall between what is already on it.
    const marks = [0.6, ...itemsBefore.filter((i) => i.wall === "south").map((i) => (i.x - r.x) / fx), W - 0.6].sort((a, b) => a - b);
    let gap = [0, 0];
    for (let k = 0; k + 1 < marks.length; k++) if (marks[k + 1] - marks[k] > gap[1] - gap[0]) gap = [marks[k], marks[k + 1]];
    const gapMid = (gap[0] + gap[1]) / 2;
    const s0 = gapMid - 0.75;
    const w11 = await place3dWall(page, "e-out", "south", s0);
    const out3 = w11.added.find((i) => i.type === "e-out");
    ok("11 the Outlet card arms it: the hint says \"click a wall\"", w11.armedHint === "← click a wall", String(w11.armedHint));
    ok("11 ...and Look inside is on", await interiorOn(page));
    ok("11 one click on the south wall adds ONE outlet", w11.added.length === 1 && !!out3, JSON.stringify(w11.added.map((i) => i.type)));
    ok("11 ...stamped as the plan's click stamps it: e-out at the builder's 18in, on the south wall",
      !!out3 && out3.electricalItemId === "e-out" && out3.heightOffFloorIn === 18 && out3.wall === "south", JSON.stringify(out3));
    ok("11 ...where it was clicked along the wall", !!out3 && near((out3.x - r.x) / fx, s0, 0.25), out3 ? `${f3((out3.x - r.x) / fx)} vs ${f3(s0)}` : "none");
    m = await measure(page);
    if (out3) {
      const g = m.groups.find((x) => x.forId === out3.id);
      const p = g && plateOf(g);
      ok("11 its cover plate is drawn at world y 1.5 on the INTERIOR face, and it is pickable",
        !!p && g.ownItemId === out3.id && near(p.ctr[1], 1.5, 0.01) && near(inward(out3, p.ctr), T / 2 + 0.02, 0.015),
        p ? `y ${f3(p.ctr[1])} in ${f3(inward(out3, p.ctr))} itemId ${g.ownItemId}` : "no group");
      ok("11 ...and it is selected (footer \"🗑 Remove Outlet\")", (await footerRemove(page)) === "🗑 Remove Outlet", String(await footerRemove(page)));
    }

    // ── 12. A Ceiling Fan and a Light, from 3D ─────────────────────────────────
    const FAN_AT = [-3, 0, 7], LIGHT_AT = [3, 0, 7];
    const c12 = await place3dCeiling(page, "e-fan", FAN_AT, H);
    const fan3 = c12.added[0];
    ok("12 the Ceiling Fan card arms it: the hint says \"click the floor under where it hangs\"", c12.armedHint === "← click the floor under where it hangs", String(c12.armedHint));
    ok("12 one click on the floor adds ONE ceiling fan, on no wall, e-fan at the builder's 96in",
      c12.added.length === 1 && fan3.type === "e-fan" && fan3.wall === null && fan3.electricalItemId === "e-fan" && fan3.heightOffFloorIn === 96, JSON.stringify(c12.added));
    ok("12 ...on the plan where the floor was clicked", !!fan3 && near((fan3.x - r.x) / fx, FAN_AT[0] + W / 2, 0.1) && near((fan3.y - r.y) / (r.h / L), FAN_AT[2] + L / 2, 0.1),
      fan3 ? `${f3((fan3.x - r.x) / fx)}, ${f3((fan3.y - r.y) / (r.h / L))}` : "none");
    const c12b = await place3dCeiling(page, "e-lt", LIGHT_AT, H);
    const lt3 = c12b.added[0];
    ok("12 the same for a Light: ONE item, on no wall, e-lt at 96in",
      c12b.added.length === 1 && lt3.type === "e-lt" && lt3.wall === null && lt3.electricalItemId === "e-lt" && lt3.heightOffFloorIn === 96, JSON.stringify(c12b.added));
    m = await measure(page);
    if (fan3) {
      const g = m.groups.find((x) => x.forId === fan3.id);
      const hub = g && g.meshes.find((x) => x.geom === "CylinderGeometry" && near(x.r, 0.2, 0.001));
      ok("12 the fan's hub hangs at H - 0.6, within 0.3 ft of the floor point clicked, and it is pickable",
        !!hub && g.ownItemId === fan3.id && near(hub.ctr[1], H - 0.6, 0.01) && Math.hypot(hub.ctr[0] - FAN_AT[0], hub.ctr[2] - FAN_AT[2]) <= 0.3,
        hub ? `hub ${f3(hub.ctr[0])}, ${f3(hub.ctr[1])}, ${f3(hub.ctr[2])}` : "no hub");
    }
    if (lt3) {
      const g = m.groups.find((x) => x.forId === lt3.id);
      const d = g && g.meshes.find((x) => x.geom === "CylinderGeometry");
      ok("12 the light's disc is just under the plate (H - 0.06), over the floor point clicked",
        !!d && near(d.ctr[1], H - 0.06, 0.01) && d.emissive && Math.hypot(d.ctr[0] - LIGHT_AT[0], d.ctr[2] - LIGHT_AT[2]) <= 0.3,
        d ? `disc ${f3(d.ctr[0])}, ${f3(d.ctr[1])}, ${f3(d.ctr[2])}` : "no disc");
    }

    // ── 13. The three placed from 3D: hovered, outlined, on screen ─────────────
    await shot(page, `${shots}/9-placed-from-3d-outlet-light-fan.png`, [0, 2.2, -8], [0, 4.5, 9], true);
    m = await measure(page);
    for (const [label, it, file] of [["outlet", out3, "9a-hover-outlet"], ["light", lt3, "9b-hover-light"], ["ceiling fan", fan3, "9c-hover-fan"]]) {
      const g = it && m.groups.find((x) => x.forId === it.id);
      if (!g) { ok(`13 the 3D-placed ${label} is drawn`, false); continue; }
      const ho = await hoverOutline(page, it.id, groupMid(g));
      ok(`13 hovering the 3D-placed ${label} outlines it where it is drawn`, ho.found && ho.visible && ho.inside && ho.snug, JSON.stringify(ho));
      await page.screenshot({ path: `${shots}/${file}.png` });
    }
    await page.mouse.move(5, 5);

    // ── 14. Out on the lawn: refused, and the button disarms ───────────────────
    {
      await pickCard(page, "e-fan");
      const ids = await idSet(page);
      const LAWN = [W / 2 + 3, 0, 7];
      await aimRaw(page, [W / 2 + 4, H + 6, 1], LAWN);
      const c = await clientOf(page, LAWN);
      await page.mouse.click(c.x, c.y);
      await settle(page, 500);
      const said = await page.evaluate(() => document.body.innerText.includes("Click the floor inside the building, under where it should hang."));
      ok("14 a ceiling device clicked on the lawn is refused, saying where to click", said);
      ok("14 ...and adds nothing", (await newItems(page, ids)).length === 0);
      ok("14 ...and stays armed: the button carries its name", (await elecButtonText(page)) === "⚡ Ceiling Fan", await elecButtonText(page));
      await elecButton(page).click();
      await settle(page, 400);
      ok("14 the button disarms it again", (await elecButtonText(page)) === "⚡ Electrical Items" && (await hint(page)) === null, `${await elecButtonText(page)} / ${await hint(page)}`);
    }

    // ── 15. Drag the 3D-placed outlet along its wall ───────────────────────────
    if (out3) {
      const along0 = (out3.x - r.x) / fx;
      const target = along0 + 1.5;
      const wx0 = along0 - W / 2, wx1 = target - W / 2;
      await aimRaw(page, [(wx0 + wx1) / 2, 2.6, L / 2 - 7], [(wx0 + wx1) / 2, 1.5, L / 2 - T / 2]);
      m = await measure(page);
      const g0 = m.groups.find((x) => x.forId === out3.id);
      const p0 = plateOf(g0);
      const gy = (Math.min(...g0.meshes.map((x) => x.min[1])) + Math.max(...g0.meshes.map((x) => x.max[1]))) / 2;
      const from = await clientOf(page, p0.ctr);
      const to = await clientOf(page, [wx1, gy, p0.ctr[2]]);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 4, from.y, { steps: 2 });
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await settle(page, 300);
      await page.mouse.up();
      await settle(page, 800);
      const moved = ((await readItems(page)) || []).find((i) => i.id === out3.id);
      ok("15 dragging the 3D-placed outlet 1.5 ft along its wall moves it on the plan",
        !!moved && near((moved.x - r.x) / fx, target, 0.25), moved ? `${f3((moved.x - r.x) / fx)} vs ${f3(target)} (from ${f3(along0)})` : "gone");
      ok("15 ...still on the south wall, still e-out at 18in", !!moved && moved.wall === "south" && moved.electricalItemId === "e-out" && moved.heightOffFloorIn === 18, JSON.stringify(moved));
      m = await measure(page);
      const g1 = m.groups.find((x) => x.forId === out3.id);
      const p1 = g1 && plateOf(g1);
      ok("15 ...and the 3D re-draws its plate there, still at world y 1.5", !!p1 && near(p1.ctr[0], wx1, 0.25) && near(p1.ctr[1], 1.5, 0.01), p1 ? `x ${f3(p1.ctr[0])} y ${f3(p1.ctr[1])}` : "no group");
      await shot(page, `${shots}/10-outlet-dragged.png`, [(wx0 + wx1) / 2, 2.6, L / 2 - 7], [(wx0 + wx1) / 2, 1.5, L / 2 - T / 2], true);

      // ── 16. Remove it from the footer ────────────────────────────────────────
      ok("16 the dragged outlet is the selection (footer \"🗑 Remove Outlet\")", (await footerRemove(page)) === "🗑 Remove Outlet", String(await footerRemove(page)));
      await clickFooterRemove(page);
      await settle(page, 800);
      ok("16 Remove takes it off the plan", !((await readItems(page)) || []).some((i) => i.id === out3.id));
      m = await measure(page);
      ok("16 ...and out of the 3D", !m.groups.some((x) => x.forId === out3.id));
    }

    ok("no uncaught page errors", errors.filter((e) => /^pageerror/.test(e)).length === 0, errors.slice(0, 3).join(" | "));
    const writes = calls.filter((c) => !c.aborted && c.path && !/\/rpc\/(get_config|get_fixtures)$/.test(c.path));
    console.log("stubbed calls other than config:", JSON.stringify([...new Set(writes.map((c) => `${c.method} ${c.path}`))]));
  } catch (e) {
    ok("harness ran to the end", false, e && e.stack ? e.stack.split("\n").slice(0, 4).join(" / ") : String(e));
    await page.screenshot({ path: `${shots}/error.png` }).catch(() => {});
  }
  try {
    await raisedCentre(ctx, ok, shots);
    await priceParity(ctx, ok, shots);
  } finally {
    await browser.close();
  }
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
  console.log(`shots in ${shots}`);
  return bad.length;
}

// 8. A flood light on a raised centre's own eave wall (see CONFIG_RAISED).
async function raisedCentre(ctx, ok, shots) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: CONFIG_RAISED });
  try {
    await openDesigner(page, CONFIG_RAISED.clientId);
    await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
    // Picked by its card, so the style's own d3 (the wings) is the one the 3D draws.
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("div,span,p,strong,b")].find((e) => e.children.length === 0 && (e.textContent || "").trim() === "Utility" && e.offsetParent);
      if (el) el.click();
    });
    await settle(page, 600);
    await chooseSize(page);
    await settle(page, 600);
    await (await revealTool(page, /Electrical Package/)).click();
    await settle(page, 600);
    const flood = await placeElec(page, "Flood Light", "e-flood", () => wallPoint(page, "east", 12));
    ok("raised centre: flood light placed on the east wall (the centre's own eave wall)", flood && flood.wall === "east", JSON.stringify(flood && { wall: flood.wall }));
    if (await page.getByText("Add an electrical item").count()) await page.keyboard.press("Escape");
    if (!flood) return;
    await openEditor(page);
    const m = await measure(page);
    const g = m.groups.find((x) => x.forId === flood.id);
    const head = g && g.meshes.find((x) => x.geom === "BoxGeometry" && near(x.w, 0.6, 0.001));
    ok("raised centre: the flood light is drawn", !!head);
    if (!head) return;
    const geo = await page.evaluate(async ({ url, head }) => {
      const THREE = await import(url);
      const E = window.__ss3dEngine;
      E.scene.updateMatrixWorld(true);
      const cuts = [];
      [[0.5, 0.5], [0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98]].forEach(([fx, fz]) => {
        const x = head.min[0] + fx * (head.max[0] - head.min[0]), z = head.min[2] + fz * (head.max[2] - head.min[2]);
        const r = new THREE.Raycaster(new THREE.Vector3(x, head.min[1] - 0.01, z), new THREE.Vector3(0, 1, 0), 0, head.max[1] - head.min[1] + 0.02);
        r.intersectObjects([E.model.roofGroup], true).forEach((h) => cuts.push(+h.point.y.toFixed(3)));
      });
      // The eave finish over the lamp: the lowest bottom of the fascia boards (0.14 thick) and the
      // soffits (0.05 tall) whose footprint reaches over the head.
      let finish = null;
      E.model.roofGroup.traverse((o) => {
        if (!o.isMesh || o.geometry.type !== "BoxGeometry") return;
        const p = o.geometry.parameters;
        if (!(Math.abs(p.width - 0.14) < 0.001 || Math.abs(p.height - 0.05) < 0.001)) return;
        const bb = new THREE.Box3().setFromObject(o);
        if (bb.max.x < head.min[0] || bb.min.x > head.max[0] || bb.max.z < head.min[2] - 1 || bb.min.z > head.max[2] + 1) return;
        finish = finish == null ? bb.min.y : Math.min(finish, bb.min.y);
      });
      let top = -Infinity;
      E.model.wallsGroup.children.forEach((grp) => {
        if (!(grp.userData && grp.userData.wall === "east" && !grp.userData.gable)) return;
        top = Math.max(top, new THREE.Box3().setFromObject(grp).max.y);
      });
      return { cuts, finish, top };
    }, { url: THREE_URL, head });
    console.log(`raised centre: east wall top ${f3(geo.top)}, lamp head ${f3(head.min[1])}..${f3(head.max[1])}, eave finish bottom ${f3(geo.finish)}`);
    ok("raised centre: the east wall stands above H (the centre's own eave wall)", geo.top > 10, f3(geo.top));
    ok("raised centre: no roof face cuts through the lamp head (it is not in the soffit)", geo.cuts.length === 0, geo.cuts.join(" "));
    ok("raised centre: the head's top sits 0.2-0.35 ft under THAT eave's finish",
      geo.finish != null && head.max[1] <= geo.finish - 0.2 && head.max[1] >= geo.finish - 0.35,
      `head top ${f3(head.max[1])} finish bottom ${f3(geo.finish)} gap ${f3(geo.finish != null ? geo.finish - head.max[1] : null)}`);
    await shot(page, `${shots}/7-raised-centre-flood.png`, [W / 2 + 7, 9.5, 4], [W / 2, 9.2, 0]);
    ok("raised centre: no uncaught page errors", errors.filter((e) => /^pageerror/.test(e)).length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok("raised centre: ran to the end", false, e && e.stack ? e.stack.split("\n").slice(0, 4).join(" / ") : String(e));
  } finally {
    await page.close().catch(() => {});
  }
}

// ── 17. PRICE PARITY ────────────────────────────────────────────────────────────────────────────
// The quote's elecItem rows as the customer sees them, by their React key (ssPriceRowKey).
async function elecRows(page) {
  return page.evaluate(() => [...document.querySelectorAll(".ssd-dt-row")].map((el) => {
    const fk = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    const key = fk && el[fk] ? el[fk].key : null;
    const txt = (sel) => { const n = el.querySelector(sel); return n ? n.innerText.replace(/\s+/g, " ").trim() : null; };
    return { key, name: txt(".ssd-dt-n"), unit: txt(".ssd-dt-d"), qty: txt(".ssd-dt-qty"), amount: txt(".ssd-dt-amt") };
  }).filter((r) => r.key && r.key.indexOf("elecItem:") === 0).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
}
async function openDetails(page) {
  for (let i = 0; i < 4; i++) {
    if (await page.locator(".ssd-dt-row").count()) return;
    const cta = page.locator(".ssd-dt-cta").first();
    if (await cta.count() && await cta.isVisible().catch(() => false)) { await cta.click(); await settle(page); continue; }
    const tog = page.getByRole("button", { name: /Show details/ }).first();
    if (await tog.count() && await tog.isVisible().catch(() => false)) { await tog.click(); await settle(page); continue; }
    await settle(page, 800);
  }
}

// One page: the package on, then one Outlet on the south wall 4.5 ft along and one Ceiling Fan at
// plan (3 ft, 19 ft), from the 2D picker ("2d") or the 3D chooser ("3d"). Then the quote's rows and
// the submit payload.
const PARITY_ALONG = 4.5, PARITY_FAN = [3, 19];
async function parityRun(ctx, mode, shots) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const calls = await stubSupabase(page, { config: CONFIG_PARITY });
  // The submit uploads the plan PDF and its pictures first; answer storage the way it answers a
  // successful upload. Registered AFTER stubSupabase, so it wins (Playwright runs routes in reverse).
  await page.route(`**/${REF}.supabase.co/storage/v1/**`, (route) => {
    const hdr = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: hdr, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: hdr, body: JSON.stringify({ Key: "floor-plans/harness.pdf", Id: "1" }) });
  });
  const out = { mode, errors, outlet: null, fan: null, rows: [], payload: null };
  try {
    await openDesigner(page, CONFIG_PARITY.clientId);
    await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
    // The style picked by its card: with no style the quote has no size row, so the package covers
    // nothing, and Get Quote refuses ("Please select a Building Style and Size.").
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("div,span,p,strong,b")].find((e) => e.children.length === 0 && (e.textContent || "").trim() === "Utility" && e.offsetParent);
      if (el) el.click();
    });
    await settle(page, 600);
    await chooseSize(page);
    await settle(page, 600);
    await (await revealTool(page, /Electrical Package/)).click();
    await settle(page, 600);
    if (mode === "2d") {
      out.outlet = await placeElec(page, "Outlet", "e-out", () => wallPoint(page, "south", PARITY_ALONG));
      out.fan = await placeElec(page, "Ceiling Fan", "e-fan", () => insidePoint(page, PARITY_FAN[0], PARITY_FAN[1]));
      if (await page.getByText("Add an electrical item").count()) await page.keyboard.press("Escape");
    } else {
      await openEditor(page);
      const H = (await measure(page)).wallTop;
      const w = await place3dWall(page, "e-out", "south", PARITY_ALONG);
      out.outlet = w.added.find((i) => i.type === "e-out") || null;
      const c = await place3dCeiling(page, "e-fan", [PARITY_FAN[0] - W / 2, 0, PARITY_FAN[1] - L / 2], H);
      out.fan = c.added.find((i) => i.type === "e-fan") || null;
      await shot(page, `${shots}/11-parity-3d-placed.png`, [0, 3, -6], [0, 4.5, 9], true);
      await closeEditor(page);
    }
    await openDetails(page);
    await settle(page, 600);
    out.rows = await elecRows(page);
    await page.screenshot({ path: `${shots}/11-parity-${mode}-details.png`, fullPage: false });
    const before = calls.length;
    const submit = page.getByRole("button", { name: /^(Get Estimate|Resubmit Quote|Resubmit)$/ }).last();
    if (await submit.count()) {
      await submit.click().catch(() => {});
      for (let i = 0; i < 80 && !out.payload; i++) {
        await settle(page, 250);
        const hit = calls.slice(before).find((cl) => cl.path && cl.path.endsWith("/functions/v1/submit-estimate"));
        if (hit) out.payload = hit.body;
      }
    }
  } catch (e) {
    out.error = e && e.stack ? e.stack.split("\n").slice(0, 4).join(" / ") : String(e);
    await page.screenshot({ path: `${shots}/error-parity-${mode}.png` }).catch(() => {});
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

async function priceParity(ctx, ok, shots) {
  const a = await parityRun(ctx, "2d", shots);
  const b = await parityRun(ctx, "3d", shots);
  ok("17 both parity pages ran to the end", !a.error && !b.error, [a.error, b.error].filter(Boolean).join(" | "));
  ok("17 2D picker: one Outlet on the south wall and one Ceiling Fan placed", !!(a.outlet && a.outlet.wall === "south" && a.fan && a.fan.wall === null), JSON.stringify([a.outlet, a.fan]));
  ok("17 3D chooser: the same two placed", !!(b.outlet && b.outlet.wall === "south" && b.fan && b.fan.wall === null), JSON.stringify([b.outlet, b.fan]));
  // Not vacuous: the rows are there, and they charge the two extras (12 outlets are in the package).
  const row = (rows, k) => rows.find((r) => r.key === k) || null;
  ok("17 the 2D quote charges one Outlet beyond the package ($45.00) and the Ceiling Fan ($285.00)",
    !!row(a.rows, "elecItem:e-out") && row(a.rows, "elecItem:e-out").qty === "1" && row(a.rows, "elecItem:e-out").amount === "$45.00"
      && !!row(a.rows, "elecItem:e-fan") && row(a.rows, "elecItem:e-fan").qty === "1" && row(a.rows, "elecItem:e-fan").amount === "$285.00", JSON.stringify(a.rows));
  ok("17 PRICE PARITY: the elecItem rows (qty, unit, amount) are identical, 2D vs 3D", JSON.stringify(a.rows) === JSON.stringify(b.rows),
    `2d ${JSON.stringify(a.rows)} | 3d ${JSON.stringify(b.rows)}`);
  const counts = (p) => (p && p.itemSummary && Array.isArray(p.itemSummary.electricalItems) ? p.itemSummary.electricalItems.slice().sort((x, y) => (x.id < y.id ? -1 : 1)) : null);
  ok("17 both submits reached submit-estimate", !!a.payload && !!b.payload);
  ok("17 PRICE PARITY: itemSummary.electricalItems in the submit payload is identical, 2D vs 3D",
    !!counts(a.payload) && JSON.stringify(counts(a.payload)) === JSON.stringify(counts(b.payload)),
    `2d ${JSON.stringify(counts(a.payload))} | 3d ${JSON.stringify(counts(b.payload))}`);
  // The placed items themselves: the same keys, so nothing downstream can tell them apart.
  const keys = (it) => (it ? Object.keys(it).filter((k) => k !== "id").sort().join(",") : null);
  ok("17 a 3D-placed outlet and fan carry exactly the keys the 2D-placed ones do",
    !!a.outlet && keys(a.outlet) === keys(b.outlet) && keys(a.fan) === keys(b.fan), `${keys(a.outlet)} | ${keys(b.outlet)} || ${keys(a.fan)} | ${keys(b.fan)}`);
  ok("17 ...with the same stamps and size", !!a.outlet && !!b.outlet && !!a.fan && !!b.fan
    && ["type", "wall", "electricalItemId", "heightOffFloorIn", "widthFt", "heightFt", "rotation"].every((k) => a.outlet[k] === b.outlet[k] && a.fan[k] === b.fan[k]),
    JSON.stringify([a.outlet, b.outlet, a.fan, b.fan]));
  ok("17 no uncaught page errors on either page", [...a.errors, ...b.errors].filter((e) => /^pageerror/.test(e)).length === 0, [...a.errors, ...b.errors].slice(0, 3).join(" | "));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((n) => process.exit(n ? 1 : 0));
}
