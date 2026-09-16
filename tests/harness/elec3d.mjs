// Electrical devices in the 3D: drawn where the plan says, and never picked.
//
// Carolyn, 2026-09-14, on the expo build: she added a Flood Light and a Ceiling Fan from "Add an
// electrical item", the floor plan showed them, and the full-screen 3D showed an empty building.
// buildShed3DModel's buildElectrical3D draws them now (plan step 1.8). This drives the real
// designer, places every kind of device in 2D with real clicks, opens the 3D editor and measures
// the scene graph through __SS3D_DEBUG:
//
//   1. one ssElec group per electrical item, none of them carrying an itemId
//   2. outlet cover plates at 18in (world y 1.5) on the INTERIOR face; switch, 220V, breaker by size
//   3. flood lights wholly OUTSIDE the footprint and mounted on the building (eave wall capped
//      under the eave, gable end allowed into the gable)
//   4. ceiling light just under the plate, fan hub + 4 blades at H - 0.6
//   5. no device casts a shadow, before and after a scoped interior rebuild
//   6. a REAL click at an outlet, the fan and a flood light selects nothing -- and the same
//      click at the workbench does select it (the control that keeps 6 from passing vacuously)
//   7. Look inside and exterior screenshots
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/elec3d.mjs                  (exit 0 = every check held)
import { pathToFileURL } from "node:url";
import { launch, stubSupabase, recordRefusals, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir, revealTool } from "./lib.mjs";
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
      if (g.userData && g.userData.itemId) benchPickable = true;
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
      groups.push({ ssElec: g.userData.ssElec, forId: g.userData.ssElecFor, itemId: itemIdUp || itemIdDown, meshes });
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
async function shot(page, path, eye, at) {
  const clip = await aim(page, eye, at);
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__ss3dEngine.render());
  await page.screenshot({ path, clip });
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
    return { client, onScreen: v.z < 1 && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95, firstIsDevice: !!(first && first.ssElec && !first.itemId), firstTag: first, picked };
  }, { world, url: THREE_URL });
}

async function footerRemove(page) {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((el) => (el.innerText || "").trim().startsWith("🗑 Remove ") && el.offsetParent);
    return b ? b.innerText.trim() : null;
  });
}

async function clickCheck(page, ok, label, world, { expectSelect } = {}) {
  const before = JSON.stringify(await readItems(page));
  const pr = await probePoint(page, world);
  if (expectSelect) ok(`${label}: the pick ray at that point finds item ${expectSelect.id}`, pr.onScreen && pr.picked === expectSelect.id, JSON.stringify({ onScreen: pr.onScreen, picked: pr.picked, first: pr.firstTag }));
  else ok(`${label}: the first thing under the pointer IS the device (the click is not vacuous)`, pr.onScreen && pr.firstIsDevice, JSON.stringify({ onScreen: pr.onScreen, first: pr.firstTag, picked: pr.picked }));
  await page.mouse.click(pr.client.x, pr.client.y);
  await settle(page, 600);
  const footer = await footerRemove(page);
  const after = JSON.stringify(await readItems(page));
  if (expectSelect) {
    ok(`${label}: a real click selects it (footer "${expectSelect.footer}")`, footer === expectSelect.footer, String(footer));
  } else {
    ok(`${label}: a real click selects nothing (no Remove in the footer)`, footer === null, String(footer));
    ok(`${label}: and moves nothing`, before === after);
  }
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
    const byId = new Map(items.map((i) => [i.id, i]));
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
    ok("no device group carries an itemId (pickItem3 cannot select it)", m.groups.every((g) => !g.itemId));
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
        let fasciaBottom = null;
        E.model.roofGroup.traverse((o) => {
          if (!o.isMesh || o.geometry.type !== "BoxGeometry") return;
          const p = o.geometry.parameters;
          if (!(Math.abs(p.width - 0.14) < 0.001 && Math.abs(p.height - 0.4) < 0.001)) return;
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

    // The 3D Add row stays free of electrical (place3 refuses it; the row leaves it out).
    const elecButtons = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => b.offsetParent && /^\S+\s(OUTLE|FLOOD|CEILI|BREAK|220V|LIGHT)\b/.test((b.innerText || "").trim())).map((b) => b.innerText.trim()));
    ok("no electrical buttons in the 3D Add row", elecButtons.length === 0, elecButtons.join(" | "));

    // ── A scoped interior rebuild keeps them, still shadowless ──────────────────
    await page.evaluate((its) => { const E = window.__ss3dEngine; E.model.rebuildInterior(its); E.render(); }, items);
    m = await measure(page);
    ok("after rebuildInterior: still one group per electrical item", m.groups.length === elec.length, `groups ${m.groups.length}`);
    ok("after rebuildInterior: still no shadows from any device", m.groups.every((g) => g.meshes.every((x) => x.castShadow === false)));

    // ── Exterior first: the flood light click ─────────────────────────────────
    // BEFORE the workbench control, on purpose: a 3D click on nothing never deselects (pickItem3
    // null -> orbit, not setSel3d(null)), so once the control has selected the bench, no later
    // click can prove "selects nothing" -- the footer keeps saying Remove Workbench regardless.
    if (floodE) {
      const head = headOf(groupFor(floodE));
      await shot(page, `${shots}/5-exterior-east-flood.png`, [W / 2 + 9, H - 1.5, 4], [W / 2, H - 1.2, 0]);
      await shot(page, `${shots}/5b-exterior-east-flood-close.png`, [W / 2 + 3.2, H - 1.6, 1.8], [W / 2, H - 0.8, 0]);
      await aim(page, [head.ctr[0] + 5, head.ctr[1] - 1, head.ctr[2] + 1.5], head.ctr);
      await settle(page, 300);
      ok("nothing selected before the flood light click", (await footerRemove(page)) === null, String(await footerRemove(page)));
      await clickCheck(page, ok, "flood light (exterior)", head.ctr);
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
      await clickCheck(page, ok, "outlet (look inside)", c);
    } else ok("a west-wall outlet to click", false);
    if (fan) {
      const blade = groupFor(fan).meshes.filter((x) => x.geom === "BoxGeometry" && near(x.w, 1.6, 0.001))[0];
      await aim(page, [blade.ctr[0] + 2.5, 2.5, blade.ctr[2] + 2.5], blade.ctr);
      await settle(page, 300);
      await clickCheck(page, ok, "ceiling fan blade (look inside)", blade.ctr);
    }
    // The control: the SAME click path on the workbench selects it.
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
        await clickCheck(page, ok, "workbench control (look inside)", at, { expectSelect: { id: benchNow.id, footer: "🗑 Remove Workbench" } });
      } else ok("workbench group found for the control", false);
    }

    ok("no uncaught page errors", errors.filter((e) => /^pageerror/.test(e)).length === 0, errors.slice(0, 3).join(" | "));
    const writes = calls.filter((c) => !c.aborted && c.path && !/\/rpc\/(get_config|get_fixtures)$/.test(c.path));
    console.log("stubbed calls other than config:", JSON.stringify([...new Set(writes.map((c) => `${c.method} ${c.path}`))]));
  } catch (e) {
    ok("harness ran to the end", false, e && e.stack ? e.stack.split("\n").slice(0, 4).join(" / ") : String(e));
    await page.screenshot({ path: `${shots}/error.png` }).catch(() => {});
  } finally {
    await browser.close();
  }
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
  console.log(`shots in ${shots}`);
  return bad.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((n) => process.exit(n ? 1 : 0));
}
