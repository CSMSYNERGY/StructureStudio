// WALL WINDOWS LOOK INTO THE BUILDING, AND THE ROOM THEY LOOK INTO STAYS INSIDE IT (glassRoom and
// windowRoomFit, 2026-10-21), driven on the COMPILED public designer.
//
// Ahsan, 2026-10-21: "give normal wall windows the same look-inside room behind the glass". Every wall's
// inside face wears the outside siding, so through a plain wall window the far wall read as siding right
// behind the glass. Behind each pane now sits a shallow inside-out box in an unfinished-wood tone, the
// room the customer looks into. It must never show anywhere but through its own glass, so it is cut to
// fit: inside the walls at the window's two ends (a corner, a porch set-back, a wing's notch), short of
// the opposite wall (a narrow building), clear of a wing's open ground, and under a roof that comes down
// going inward (a single-slope roof's high wall).
//
// Eight saved designs, each opened in the 3D editor with __SS3D_DEBUG:
//   corners  10 x 14 gable: a window at both ends of every wall, a 6 ft picture window, a window high in
//            a gable end over a loft, and a window with a photo
//   narrow   2 x 6 gable: a window on each long wall, 2 ft apart (sizes are whole feet, parseSize; nothing
//            narrower than 3 ft ever needs this limit, so it is a guard)
//   shed     10 x 12 single slope, high side front: a window high on every wall, a low one under the high
//            side and one across the plate on it
//   shedSide 10 x 12 single slope, high side left: on the high wall a window pushed up to its top and
//            one across the plate
//   step     12 x 16 gable with a roof step (the back 6 ft 1 ft higher): a window pushed up to the back
//            wall's top and one high on a long wall's rear section
//   porch    12 x 16 gable, a 4 ft recessed porch: windows at the set-back wall's corners and the side
//            walls' porch ends
//   wing     24 x 40 gable with an 8 ft wing along 20 ft of one side: a window at both ends and the middle
//            of every wall (the ones out in the open ground are not built)
//   many     12 x 32 gable with 24 windows, for the frame time
// and checks, per design:
//   R1 every built window has exactly one room, except the one with a photo (the photo is the look)
//   R2 every room lies inside the footprint's inner faces (porch set-back included), no deeper than 2.5 ft
//   R3 from the middle of the glass, just behind it and just in front of it, a straight line to each of
//      the room's far corners, and to the corners half-way in, meets nothing but the window itself: no
//      wall, roof, wing wall or floor in between (interior items, a loft or a partition, are inside the
//      building and may stand in it)
//   R4 the special cases: the narrow building's rooms stop short of the opposite wall (1.65 ft); on the
//      shed a high window's room is shallower under the falling roof and a low one keeps 2.5 ft; the
//      gable-end window's room stays under the wall top; a window pushed up to a tall wall's top keeps
//      a room whose ceiling comes down with the roof (shedSide, step)
//   R5 the rooms draw only for a camera outside their own wall, and hide in "look inside"
//   R6 the quote's four-corner sheet and its single 3D picture still render (corners, shed), written out
//   R7 on the sheds, the roof prism's tall band (in the high wall's mid-plane above the plate) has a hole
//      over each window above the plate and its flat bottom (the ceiling at the plate) one under the room
//      of a window across it; a scoped rebuild of that wall, as a drag makes, closes them with the
//      windows lowered under the plate and opens them again with the windows back up (shedBand,
//      2026-10-21)
// Shots and the corner sheet go to the shots folder, named by TAG (default "after"), so a run against
// the tree before the change gives the matching "before" set (its R checks fail there, as they should).
//
//   node tests/harness/windowRooms.mjs        (SS_BASE=http://127.0.0.1:<port>, SS_SHOTS=<dir>, TAG=<name>)
//
// Exit 0 = every check held. Supabase is stubbed at the network layer; nothing leaves the machine.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir, stubSupabase, collectErrors, readItems, buildingRect, bypassGate } from "./lib.mjs";
import { pickStyle, openEditor } from "./gableProbe.mjs";

const { ok, failed } = reporter();
const shots = shotsDir("window-rooms");
const TAG = process.env.TAG || "after";
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const T = 0.3, ROOM_FT = 2.5;
const THREE_URL = "https://esm.sh/three@0.167.0";
const PHOTO_URL = `https://${REF}.supabase.co/storage/v1/object/public/fixtures/harness-window.png`;
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8+P9/PQAJYwPMpB6HxwAAAABJRU5ErkJggg==", "base64");
const COLORS = { body: "#5b6770", roof: "#3a3d42", trim: "#efe6d2" };
const gable = (extra = {}) => ({ roof: { type: "gable", pitch: 0.42, overhang: 0.8, eave: "fascia", ridgeOffset: 0, ...extra }, colors: COLORS, siding: "panel", foundation: "skids", roofMaterial: "metal", wallHeightFt: 8 });
const win = (id, name, w, h, extra) => ({ id, category: "window", name, planLabel: "W", price: 100, widthIn: w, heightIn: h, sortOrder: 0, colorMode: "fixed", hasTrimColor: false, imageUrl: null, sillIn: null, sillMode: "fixed", ...extra });
const FIX = [
  win("w-2436", "Window 24x36", 24, 36),
  win("w-1824", "Window 18x24", 18, 24),
  win("w-pic", "Picture window", 72, 36),
  win("w-photo", "Photo window", 24, 36, { imageUrl: PHOTO_URL }),
];
const FIXTURES = { items: FIX, windowColors: [], ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false } };
const fxOf = (id) => FIX.find((f) => f.id === id);
// [wall, along (ft from its west or north end), fixture, sill ft, key]
const ends = (W, L, fx = "w-2436", sill = 3.5) => [["north", 1, fx, sill, "nW"], ["north", W - 1, fx, sill, "nE"], ["south", 1, fx, sill, "sW"], ["south", W - 1, fx, sill, "sE"],
  ["west", 1, fx, sill, "wN"], ["west", L - 1, fx, sill, "wS"], ["east", 1, fx, sill, "eN"], ["east", L - 1, fx, sill, "eS"]];
const DESIGNS = [
  { key: "corners", label: "Rooms Corners", W: 10, L: 14, d3: gable(), corners: true,
    wins: [...ends(10, 14), ["west", 7, "w-pic", 3, "picture"], ["north", 5, "w-1824", 6.5, "gableHigh"], ["east", 7, "w-photo", 3.5, "photo"]],
    extra: (px, py) => [{ id: 690, type: "loft", x: px(5), y: py(2), rotation: 0, wall: null, widthFt: 10, heightFt: 4, elevationFt: 5.5 }] },
  { key: "narrow", label: "Rooms Narrow", W: 2, L: 6, d3: gable(), wins: [["west", 3, "w-1824", 3.5, "w"], ["east", 3, "w-1824", 3.5, "e"]] },
  { key: "shed", label: "Rooms Shed", W: 10, L: 12, d3: { ...gable(), roof: { type: "shed", highSide: "front", pitch: 0.25, overhang: 0.6, eave: "fascia" } }, quote: true,
    band: { wall: "south", keys: ["sHigh", "sMid"] },
    wins: [["north", 5, "w-1824", 7.5, "nHigh"], ["south", 5, "w-1824", 8.5, "sHigh"], ["south", 2, "w-1824", 3.5, "sLow"], ["west", 6, "w-1824", 7.5, "wHigh"], ["east", 6, "w-1824", 7.5, "eHigh"],
      ["south", 8, "w-2436", 7.5, "sMid"]] },
  { key: "shedSide", label: "Rooms Shed Side", W: 10, L: 12, d3: { ...gable(), roof: { type: "shed", highSide: "left", pitch: 0.25, overhang: 0.6, eave: "fascia" } },
    band: { wall: "west", keys: ["wTop", "wMid"] },
    wins: [["west", 3, "w-1824", 8.5, "wTop"], ["west", 8.5, "w-2436", 7.5, "wMid"], ["east", 6, "w-1824", 3.5, "eLow"]] },
  { key: "step", label: "Rooms Step", W: 12, L: 16, d3: gable({ rearStepFt: 6, rearEaveRiseFt: 1 }),
    wins: [["north", 6, "w-1824", 7.5, "nTop"], ["west", 3, "w-1824", 7.5, "wRear"], ["east", 12, "w-1824", 3.5, "eFront"]] },
  { key: "porch", label: "Rooms Porch", W: 12, L: 16, d3: gable({ porchDepthFt: 4 }), porch: { wall: "south", depth: 4 },
    wins: [["south", 1, "w-2436", 3.5, "sW"], ["south", 11, "w-2436", 3.5, "sE"], ["west", 11, "w-2436", 3.5, "wS"], ["east", 11, "w-2436", 3.5, "eS"], ["north", 6, "w-2436", 3.5, "n"]] },
  { key: "wing", label: "Rooms Wing", W: 24, L: 40, d3: { ...gable({ front: "gable", pitch: 0.5, overhang: 1, wingList: [{ wall: "left", widthFt: 8, lengthFt: 20 }] }), siding: "lap", wallHeightFt: 9 },
    wins: [...ends(24, 40), ["north", 12, "w-2436", 3.5, "nMid"], ["south", 12, "w-2436", 3.5, "sMid"], ["west", 20, "w-2436", 3.5, "wMid"], ["east", 20, "w-2436", 3.5, "eMid"],
      ["north", 9, "w-2436", 3.5, "nNotch"], ["south", 9, "w-2436", 3.5, "sNotch"], ["north", 15, "w-2436", 3.5, "nNotch2"], ["south", 15, "w-2436", 3.5, "sNotch2"]] },
  { key: "many", label: "Rooms Many", W: 12, L: 32, d3: gable(),
    wins: [...[2, 6, 10, 14, 18, 22, 26, 30].flatMap((a, i) => [["west", a, "w-2436", 3.5, `w${i}`], ["east", a, "w-2436", 3.5, `e${i}`]]),
      ...[2, 6, 10].flatMap((a, i) => [["north", a, "w-1824", 3.5, `n${i}`], ["south", a, "w-1824", 3.5, `s${i}`]]), ["north", 6, "w-1824", 6, "nTop"], ["south", 6, "w-1824", 6, "sTop"]] },
];
const ONLY = process.env.WR_ONLY ? process.env.WR_ONLY.split(",") : null;
const CONFIG = {
  clientId: "harness-window-rooms",
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: [],
  buildingStyles: DESIGNS.map((d) => ({ value: d.key, label: d.label, img: null, sizes: [`${d.W}x${d.L}`], sizeInclusions: {}, sizeInclusionQty: {}, d3: d.d3 })),
  defaultSizes: DESIGNS.map((d) => `${d.W}x${d.L}`),
  sizePricing: Object.fromEntries(DESIGNS.map((d) => [d.key, { [`${d.W}x${d.L}`]: { widthFt: d.W, lengthFt: d.L, basePrice: 9000 } }])),
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: true, quoteCornerViews: true,
  layoutItems: { loft: { label: "Loft", icon: "⬆️", color: "#7C3AED", width: 6, height: 4, shortLabel: "LF", wallOnly: false, wallSnap: false, group: "interior" } },
  layoutPricing: { loft: { rate: 6, method: "sqft_option" } }, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};
const routePhoto = (page) => page.route(PHOTO_URL, (route) => route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: PNG_1x1 }));

async function rectOf(browser, d) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  await bypassGate(page, CONFIG.clientId);
  await page.goto(`${BASE}/?client=${CONFIG.clientId}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 40000 });
  await pickStyle(page, d.label);
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), d.L, { timeout: 20000 });
  await settle(page, 500);
  const rect = await buildingRect(page);
  await ctx.close();
  return rect;
}

// Every opening group with what the checks need: the wall, the glass's middle, the room's box (world).
const readRooms = (page) => page.evaluate(() => {
  const E = window.__ss3dEngine;
  E.scene.updateMatrixWorld(true);
  const box = (o) => { o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] }; };
  return E.model.openingsGroup.children.filter((g) => g.userData && g.userData.itemId != null).map((g) => {
    const rooms = [], glass = [];
    g.traverse((o) => {
      if (!o.isMesh) return;
      if (o.userData && o.userData.ssGlassRoom) {
        // `drop`: how far the far top edge comes down under the near one (a ceiling that follows the roof).
        const pa = o.geometry.attributes.position;
        const ys = [...new Set(Array.from({ length: pa.count }, (_, i) => +pa.getY(i).toFixed(4)))].sort((p, q) => p - q);
        rooms.push({ ...box(o), depth: o.geometry.parameters.depth, drawn: o.geometry.drawRange.count > 0, visible: o.visible,
          drop: ys.length > 2 ? +(ys[ys.length - 1] - ys[ys.length - 2]).toFixed(3) : 0 });
      }
      else if ((Array.isArray(o.material) ? o.material[0] : o.material).transparent) glass.push(box(o));
    });
    return { id: g.userData.itemId, wall: g.userData.wall, rooms, glass };
  });
});

// R3: segments from just behind the glass, and from just in front of it, to the room's far and half-way
// corners, against everything opaque in the scene but the window's own group, the rooms, and the
// interior (lofts, partitions). From in front is what meets anything standing in the pane's own plane:
// a single-slope roof's tall band, over a window above the plate (shedBand, 2026-10-21).
const rayCheck = (page) => page.evaluate(async (url) => {
  const THREE = await import(url);
  const E = window.__ss3dEngine;
  E.scene.updateMatrixWorld(true);
  const NRM = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
  const under = (o, root) => { for (let n = o; n; n = n.parent) if (n === root) return true; return false; };
  const solid = [];
  E.scene.traverseVisible((o) => {
    if (!o.isMesh || (o.userData && o.userData.ssGlassRoom)) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || m.transparent || under(o, E.model.interiorGroup)) return;
    solid.push(o);
  });
  // Both faces of everything count: a roof panel is met from underneath.
  const sides = new Map();
  solid.forEach((o) => [].concat(o.material).forEach((m) => { if (!sides.has(m)) { sides.set(m, m.side); m.side = THREE.DoubleSide; } }));
  const ray = new THREE.Raycaster();
  const out = [];
  try {
    E.model.openingsGroup.children.forEach((g) => {
      if (!(g.userData && g.userData.itemId != null)) return;
      let room = null, glass = null;
      g.traverse((o) => { if (!o.isMesh) return; if (o.userData && o.userData.ssGlassRoom) room = o; else if ([].concat(o.material)[0].transparent) glass = o; });
      if (!room || !glass) return;
      const n = NRM[g.userData.wall];
      const rb = new THREE.Box3().setFromObject(room), gb = new THREE.Box3().setFromObject(glass);
      const c = rb.getCenter(new THREE.Vector3());
      const froms = [-0.03, 0.03].map((s) => gb.getCenter(new THREE.Vector3()).addScaledVector(new THREE.Vector3(...n), s));
      // The room's own corners (a ceiling that follows the roof is lower at the far face than the box
      // round it): the far face's, and half-way between each and the near face's at the same end and level.
      const pa = room.geometry.attributes.position, uniq = new Map();
      for (let i = 0; i < pa.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(room.matrixWorld); uniq.set(v.toArray().map((q) => q.toFixed(4)).join(","), v); }
      const ax = n[0] ? 0 : 2, ox = ax === 0 ? 2 : 0, inw = (v) => -v.getComponent(ax) * n[ax];
      const corners = [...uniq.values()], dFar = Math.max(...corners.map(inw)), dNear = Math.min(...corners.map(inw));
      const at = (vs, a) => vs.filter((v) => Math.abs(v.getComponent(ox) - a) < 1e-3).sort((p, q) => p.y - q.y);
      const far = corners.filter((v) => inw(v) > dFar - 1e-3), near = corners.filter((v) => inw(v) < dNear + 1e-3), targets = [];
      [rb.min.getComponent(ox), rb.max.getComponent(ox)].forEach((a) => {
        const nr = at(near, a);
        at(far, a).forEach((f, k) => { targets.push(f.clone()); if (nr[k]) targets.push(f.clone().lerp(nr[k], 0.5)); });
      });
      targets.forEach((t) => t.lerp(c, 0.02 / Math.max(0.05, t.distanceTo(c))));
      const own = new Set(); g.traverse((o) => own.add(o));
      const blocked = [];
      froms.forEach((from) => targets.forEach((t) => {
        const dir = t.clone().sub(from), len = dir.length();
        ray.set(from, dir.normalize()); ray.near = 0; ray.far = len;
        const hit = ray.intersectObjects(solid, false).find((h) => !own.has(h.object));
        if (hit) {
          let tag = hit.object.name || hit.object.geometry.type;
          for (let p = hit.object.parent; p && !hit.object.name; p = p.parent) if (p.name) { tag = p.name + "/" + tag; break; }
          blocked.push(`${tag}@${hit.distance.toFixed(2)}/${len.toFixed(2)}`);
        }
      }));
      out.push({ id: g.userData.itemId, wall: g.userData.wall, blocked });
    });
  } finally { sides.forEach((s, m) => { m.side = s; }); }
  return out;
}, THREE_URL);

async function shoot(page, name, { id, dist = 6, skew = 0, lift = 0.6, target = null, cam = null }) {
  const clip = await page.evaluate(({ id, dist, skew, lift, target, cam }) => {
    const E = window.__ss3dEngine;
    E.scene.updateMatrixWorld(true);
    E.controls.minDistance = 0.5;
    let c = target, p = cam;
    if (id != null) {
      const g = E.model.openingsGroup.children.find((x) => x.userData && x.userData.itemId === id);
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      g.traverse((o) => { if (!o.isMesh || (o.userData && o.userData.ssGlassRoom)) return; o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
        [[b.min.x, b.min.y, b.min.z], [b.max.x, b.max.y, b.max.z]].forEach((v) => v.forEach((q, k) => { mn[k] = Math.min(mn[k], q); mx[k] = Math.max(mx[k], q); })); });
      c = mn.map((v, k) => (v + mx[k]) / 2);
      const w = g.userData.wall, n = w === "west" ? [-1, 0, 0] : w === "east" ? [1, 0, 0] : w === "north" ? [0, 0, -1] : [0, 0, 1], t = [n[2], 0, -n[0]];
      p = [c[0] + n[0] * dist + t[0] * skew * dist, c[1] + lift, c[2] + n[2] * dist + t[2] * skew * dist];
    }
    E.camera.position.set(...p); E.controls.target.set(...c); E.camera.lookAt(...c);
    E.camera.updateProjectionMatrix(); if (E.controls.update) E.controls.update(); E.render();
    const r = E.renderer.domElement.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, { id, dist, skew, lift, target, cam });
  await settle(page, 250);
  await page.evaluate(() => window.__ss3dEngine.render());
  await page.screenshot({ path: join(shots, `${TAG}-${name}.png`), clip });
}

const frameTime = (page) => page.evaluate(() => {
  const E = window.__ss3dEngine;
  E.camera.position.set(22, 10, 26); E.controls.target.set(0, 3, 0); E.camera.lookAt(0, 3, 0); E.camera.updateProjectionMatrix();
  for (let i = 0; i < 5; i++) E.render();
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) E.render();
  const ms = (performance.now() - t0) / 40;
  const info = E.renderer.info.render;
  return { ms: +ms.toFixed(2), calls: info.calls, triangles: info.triangles };
});

// One saved design, opened on the public designer (the 3D editor not yet open).
async function openDesign(browser, d, items) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    window.__SS3D_DEBUG = true;
    // The quote's pictures as the browser encodes them: the four-corner sheet and the single view.
    window.__ssCaps = { all: [] };
    const orig = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...a) {
      const r = orig.apply(this, a);
      window.__ssCaps.all.push(`${this.width}x${this.height}`);
      if (this.width === 1632 && this.height === 2112) window.__ssCaps.sheet = r;
      else if (this.width === 1200 && this.height === 900) window.__ssCaps.single = r;
      return r;
    };
  });
  const code = `SS-HARNWR${d.key.toUpperCase().slice(0, 4)}`;
  const row = { short_code: code, status: "draft", selections: { style: d.key, size: `${d.W}x${d.L}` }, items,
    contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100", street: "", city: "", state: "", zip: "" },
    paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {} };
  await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [row] } });
  await page.route(`**/${REF}.supabase.co/storage/v1/**`, (route) => {
    const hdr = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: hdr, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: hdr, body: JSON.stringify({ Key: "floor-plans/harness.pdf", Id: "1" }) });
  });
  await routePhoto(page);
  await bypassGate(page, CONFIG.clientId);
  await page.goto(`${BASE}/?client=${CONFIG.clientId}&id=${code}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  for (let k = 0; k < 60; k++) { await settle(page, 500); if ((((await readItems(page)) || []).length) >= items.length) break; }
  return { ctx, page, errors };
}
// R6: the quote's pictures, from a fresh page with the 3D editor never opened, so the single picture
// is the default 3D shot (renderDefault3DShot, 1200 x 900) and page 2 the four-corner sheet
// (renderQuoteCornerSheet: four 800 x 600 corner shots on one 1632 x 2112 sheet).
async function runQuote(browser, d, items) {
  const { ctx, page, errors } = await openDesign(browser, d, items);
  const tag = `${d.key}:`;
  await settle(page, 1500);
  const submit = page.getByRole("button", { name: /^(Get Estimate|Resubmit for Updated Estimate)$/ }).last();
  if (await submit.count()) await submit.click().catch(() => {});
  let caps = null;
  for (let k = 0; k < 240; k++) { await settle(page, 500); caps = await page.evaluate(() => window.__ssCaps); if (caps && caps.sheet && caps.single) break; }
  const corners = caps ? caps.all.filter((x) => x === "800x600").length : 0;
  ok(`R6 ${tag} the quote's default 3D shot and its four-corner sheet (four corner shots) rendered`, !!(caps && caps.sheet && caps.single && caps.sheet.length > 50000 && corners === 4),
    caps ? `sheet ${(caps.sheet || "").length} / single ${(caps.single || "").length}; encoded ${caps.all.join(",")}` : "none");
  const save = (url, name) => { if (url) writeFileSync(join(shots, `${TAG}-${name}`), Buffer.from(url.split(",")[1], "base64")); };
  const pre = d.corners ? "" : `${d.key}-`;
  if (caps) { save(caps.sheet, `${pre}corner-sheet.jpg`); save(caps.single, `${pre}quote-3d.jpg`); }
  ok(`R6 ${tag} no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

async function runDesign(browser, d) {
  const rect = await rectOf(browser, d);
  const s = rect.w / d.W, px = (ft) => rect.x + ft * s, py = (ft) => rect.y + ft * s;
  const items = d.wins.map(([wall, at, fxId, sill], i) => {
    const fx = fxOf(fxId);
    const pos = wall === "north" ? { x: px(at), y: rect.y, rotation: 0 } : wall === "south" ? { x: px(at), y: rect.y + rect.h, rotation: 0 }
      : wall === "west" ? { x: rect.x, y: py(at), rotation: 90 } : { x: rect.x + rect.w, y: py(at), rotation: 90 };
    return { id: 700 + i, type: "window", ...pos, wall, widthFt: fx.widthIn / 12, heightFt: 0.5, fixtureItemId: fx.id, windowName: fx.name, price: fx.price,
      widthIn: fx.widthIn, heightIn: fx.heightIn, sillFt: sill, sillMode: "fixed", colorId: null, colorLabel: null, colorHex: null };
  }).concat(d.extra ? d.extra(px, py) : []);
  const keyOf = (id) => (d.wins[id - 700] || [])[4];
  const idOf = (key) => 700 + d.wins.findIndex((w) => w[4] === key);
  const { ctx, page, errors } = await openDesign(browser, d, items);
  await openEditor(page);

  const groups = await readRooms(page);
  const wins = groups.filter((g) => g.id >= 700 && g.id < 700 + d.wins.length);
  const tag = `${d.key}:`;
  // R1
  const photoId = d.wins.findIndex((w) => w[2] === "w-photo");
  const wrong = wins.filter((g) => g.rooms.length !== (g.id - 700 === photoId ? 0 : 1));
  ok(`R1 ${tag} ${wins.length} window(s) built, one room behind each${photoId >= 0 ? ", none behind the photo window" : ""}`,
    wins.length > 0 && wrong.length === 0, wrong.map((g) => `${keyOf(g.id)}=${g.rooms.length}`).join(" "));
  // R2
  const pz = d.porch || {};
  const lim = { x0: -d.W / 2 + T / 2 + (pz.wall === "west" ? pz.depth : 0), x1: d.W / 2 - T / 2 - (pz.wall === "east" ? pz.depth : 0),
    z0: -d.L / 2 + T / 2 + (pz.wall === "north" ? pz.depth : 0), z1: d.L / 2 - T / 2 - (pz.wall === "south" ? pz.depth : 0) };
  const out = wins.flatMap((g) => g.rooms.filter((r) => r.min[0] < lim.x0 - 0.005 || r.max[0] > lim.x1 + 0.005 || r.min[2] < lim.z0 - 0.005 || r.max[2] > lim.z1 + 0.005 || r.depth > ROOM_FT + 1e-6)
    .map((r) => `${keyOf(g.id)} x ${r.min[0].toFixed(2)}..${r.max[0].toFixed(2)} z ${r.min[2].toFixed(2)}..${r.max[2].toFixed(2)} d ${r.depth.toFixed(2)}`));
  ok(`R2 ${tag} every room inside the walls' inner faces, at most ${ROOM_FT} ft deep`, out.length === 0, out.join(" | "));
  // R3
  const rays = await rayCheck(page);
  const hit = rays.filter((r) => r.blocked.length);
  ok(`R3 ${tag} from each pane, nothing but the window between the glass and its room's corners`, rays.length === wins.filter((g) => g.rooms.length).length && hit.length === 0,
    `${rays.length} rooms; ` + hit.map((r) => `${keyOf(r.id)}: ${r.blocked.slice(0, 2).join(", ")}`).join(" | "));
  const depthOf = (key) => { const g = wins.find((x) => x.id === idOf(key)); return g && g.rooms[0] ? +g.rooms[0].depth.toFixed(3) : null; };
  console.log(`  ${d.key} depths: ${d.wins.map((w) => `${w[4]}=${depthOf(w[4])}`).join(" ")}`);
  // R4
  if (d.key === "narrow") ok(`R4 ${tag} both rooms stop short of the opposite wall (2 - 0.3 - 0.05 = 1.65 ft)`, depthOf("w") === 1.65 && depthOf("e") === 1.65, `${depthOf("w")} ${depthOf("e")}`);
  if (d.key === "shed") {
    const highs = ["nHigh", "sHigh", "wHigh", "eHigh"].map(depthOf);
    ok(`R4 ${tag} under the falling roof a high window's room is shallower (and still there); the low one under the high side keeps 2.5 ft`,
      highs.every((v) => v != null && v >= 0.4) && highs.some((v) => v < ROOM_FT - 0.01) && depthOf("sLow") === ROOM_FT, `${highs.join(",")} low ${depthOf("sLow")}`);
  }
  // R4: a window pushed up to a tall wall's top keeps a room, its ceiling coming down with the roof.
  if (d.key === "shedSide" || d.key === "step") {
    const g = wins.find((x) => x.id === idOf(d.key === "step" ? "nTop" : "wTop")), r = g && g.rooms[0];
    ok(`R4 ${tag} the window pushed up to the tall wall's top keeps a room whose ceiling comes down with the roof`, !!(r && r.drop > 0.01 && r.depth >= 0.4),
      r ? `depth ${r.depth.toFixed(2)}, ceiling down ${r.drop} ft at the far face` : "no room");
  }
  // R7: the pieces round the holes (ssShedBand: the band's triangles in its first group, the bottom's in
  // its second) and the prism's own drawn triangles (its groups' counts).
  if (d.band) {
    const band = () => page.evaluate(() => {
      let pieces = 0, tris = 0, bandTris = 0, floorTris = 0;
      window.__ss3dEngine.model.roofGroup.traverse((o) => {
        if (!o.isMesh) return;
        if (o.userData && o.userData.ssShedBand) { pieces++; bandTris += o.geometry.groups[0].count / 3; floorTris += o.geometry.groups[1].count / 3; }
        else if (o.geometry.type === "ExtrudeGeometry") tris += o.geometry.groups.reduce((s, g) => s + g.count, 0) / 3;
      });
      return { pieces, tris, bandTris, floorTris };
    });
    const live = await readItems(page), ids = d.band.keys.map(idOf);
    const rebuildAt = (low) => page.evaluate(({ live, ids, wall, low }) => {
      const E = window.__ss3dEngine;
      E.model.rebuildWalls([wall], low ? live.map((it) => (ids.includes(it.id) ? { ...it, sillFt: 3.5 } : it)) : live);
      E.render();
    }, { live, ids, wall: d.band.wall, low });
    const s0 = await band();
    await rebuildAt(true);
    const s1 = await band();
    await rebuildAt(false);
    const s2 = await band();
    const back = (await rayCheck(page)).filter((r) => ids.includes(r.id)), blocked = back.reduce((n, r) => n + r.blocked.length, 0);
    ok(`R7 ${tag} holes in the tall band over the windows above the plate and in the prism's bottom under the room across it; a scoped rebuild closes them and opens them again`,
      s0.pieces === 1 && s0.bandTris > 0 && s0.floorTris > 0 && s1.pieces === 0 && s1.tris > s0.tris && JSON.stringify(s2) === JSON.stringify(s0) && back.length === ids.length && blocked === 0,
      `pieces ${s0.pieces}/${s1.pieces}/${s2.pieces}, band + bottom pieces ${s0.bandTris} + ${s0.floorTris} triangles, prism ${s0.tris}/${s1.tris}/${s2.tris}, rays ${blocked} blocked`);
  }
  if (d.key === "corners") {
    const g = wins.find((x) => x.id === idOf("gableHigh"));
    ok(`R4 ${tag} the window high in the gable end: its room stays under the 8 ft wall top`, !!(g && g.rooms[0] && g.rooms[0].max[1] <= 8 + 1e-3), g && g.rooms[0] ? g.rooms[0].max[1].toFixed(3) : "no room");
  }
  // R5: from outside the south wall (corners and many), the south rooms draw and the north ones do not;
  // in look inside, none shows.
  if (d.key === "corners" || d.key === "many") {
    await page.evaluate(() => { const E = window.__ss3dEngine; E.camera.position.set(2, 5, 30); E.controls.target.set(0, 4, 0); E.camera.lookAt(0, 4, 0); E.camera.updateProjectionMatrix(); E.render(); });
    const g2 = await readRooms(page);
    const drawn = (wall) => g2.filter((g) => g.wall === wall).flatMap((g) => g.rooms).filter((r) => r.drawn && r.visible).length;
    const all = (wall) => g2.filter((g) => g.wall === wall).flatMap((g) => g.rooms).length;
    ok(`R5 ${tag} from the south the south rooms draw (${drawn("south")}/${all("south")}) and the north ones do not (${drawn("north")})`, all("south") > 0 && drawn("south") === all("south") && drawn("north") === 0);
    if (d.key === "corners") {
      await shoot(page, `${d.key}-front`, { cam: [9, 6.5, 22], target: [0, 4, 0] });
      // Look inside: the viewer's own toggle, where it has one.
      const li = page.getByRole("button", { name: /Look inside/i });
      if (await li.count()) {
        // Its label changes once pressed; press the same button again to come back out.
        const btn = await li.first().elementHandle();
        await btn.click();
        await settle(page, 600);
        await page.evaluate(() => window.__ss3dEngine.render());
        const g3 = await readRooms(page);
        const vis = g3.flatMap((g) => g.rooms).filter((r) => r.visible).length;
        ok(`R5 ${tag} in look inside no room shows`, vis === 0, `${vis} visible`);
        await btn.click();
        await settle(page, 600);
      }
    }
  }
  // Pictures.
  const SHOTS = {
    corners: [["corner", { id: idOf("nE"), dist: 5, skew: 0.9 }], ["corner-straight", { id: idOf("nE"), dist: 5 }], ["picture-straight", { id: idOf("picture"), dist: 8 }],
      ["picture-angle", { id: idOf("picture"), dist: 7, skew: 0.8 }], ["gable-loft", { id: idOf("gableHigh"), dist: 5, skew: 0.45, lift: -0.8 }], ["photo", { id: idOf("photo"), dist: 5, skew: 0.4 }]],
    narrow: [["narrow-angle", { id: idOf("w"), dist: 5, skew: 0.7 }]],
    shed: [["shed-high", { id: idOf("sHigh"), dist: 5, skew: 0.6, lift: -1 }], ["shed-high-straight", { id: idOf("sHigh"), dist: 5, lift: 0 }],
      ["shed-high-wall", { id: idOf("sHigh"), dist: 13, skew: 0.45, lift: -3.5 }], ["shed-mid-low", { id: idOf("sMid"), dist: 5, skew: 0.3, lift: -3 }]],
    shedSide: [["shed-side-top", { id: idOf("wTop"), dist: 5, skew: 0.5, lift: -1 }], ["shed-side-mid", { id: idOf("wMid"), dist: 5, skew: -0.4, lift: -2.5 }],
      ["shed-side-wall", { id: idOf("wMid"), dist: 13, skew: -0.4, lift: -3.5 }]],
    step: [["step-top", { id: idOf("nTop"), dist: 5, skew: 0.4, lift: -0.8 }]],
    porch: [["porch-angle", { id: idOf("sE"), dist: 5, skew: -0.7 }]],
    wing: [["wing-notch", { id: idOf("nNotch2"), dist: 6, skew: 0.6 }]],
    many: [["many-straight", { id: idOf("e3"), dist: 9 }], ["many-angle", { id: idOf("e3"), dist: 8, skew: 0.8 }]],
  }[d.key] || [];
  for (const [name, o] of SHOTS) if (o.id >= 700) await shoot(page, name, o);
  const ft = await frameTime(page);
  console.log(`  ${d.key} frame: ${ft.ms} ms, ${ft.calls} draw calls, ${ft.triangles} triangles (${TAG})`);
  ok(`${tag} no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
  if (d.corners || d.quote) await runQuote(browser, d, items);
}

async function main() {
  const { browser } = await launch({ width: 1280, height: 900 });
  for (const d of DESIGNS) if (!ONLY || ONLY.includes(d.key)) await runDesign(browser, d);
  await browser.close();
  const fl = failed();
  console.log(fl.length ? `${fl.length} FAILED` : "ALL CHECKS PASSED");
  process.exit(fl.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
