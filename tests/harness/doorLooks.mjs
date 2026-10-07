// The DOOR GENERATOR's four built looks (migration 289), driven on the COMPILED public designer.
//
// A builder sells four hinged shed doors, each also as a double: American, Basic, Classic and
// Dutch. They share one build -- a trim-coloured frame (two stiles, top and bottom rails, a mid
// rail at 42% of the leaf), an infill of grooved siding in the door colour, black T-strap hinges,
// a header board over the opening and an aluminium threshold -- and differ only in what sits in
// the panels: nothing (Basic), pickets below the mid rail (American), an octagon and a
// diamond above it and an X below (Classic), a small dark louvred vent below (Dutch). A window
// the builder ticked "Can be used inside a door" may go in the upper panel of every leaf.
//
//   P. the door PICKER: a built look offers a Window row with the in-door windows that fit one
//      leaf (not a window too big for it, not a window that is not ticked for doors); the plank door
//      offers none; the pick is stamped on the placed door (all five fields) and a double's leaf is
//      measured, not the whole door
// One saved design, opened in the 3D editor with __SS3D_DEBUG, then carries a single and a double
// of each look, one board-and-batten door, and two doors with a window in them:
//   A. every door of a new look is drawn by the new leaf (its parts tagged ssDoorPart), with exactly
//      the parts each look is made of, per leaf, single and double
//   B. colours: the infill is the door colour and the frame its trim colour; a door with no colour of
//      its own takes the BODY colour for its infill and the building TRIM for its frame; the infill's
//      grooves are a texture of its own, never the walls'
//   C. the mid rail is centred at 42% of the leaf; a double hinges on its two outer stiles, and a
//      single on the side the plank door's rule names (same wall, same operation, same side)
//   D. a window in a door: one per leaf (two on a double), glass inside the upper panel, the Classic's
//      octagon and diamond gone; and on every built door nothing stands proud of the casing face but
//      the latch lever (and the header board, a drip cap ON the casing)
//   A2. the American's pickets: three on a 36 in leaf and two on a 60 in double's, the gaps between
//      them about 1.3 pickets wide, as on every frame of the real door
//   H. the header board: a thin drip cap (0.4 of a rail, not a whole one); dropped under a transom
//      and under a loft door stacked flush; stopped short of the corner board; and two doors 0.25 ft
//      apart do not share a header face
//   X. Details: the × on a window row reaches a window that is only in a door -- the door stays and
//      the window comes out of it -- and on a row with a wall window too, the pick-one mode offers the
//      door and taking it leaves the wall window
//   I. a size that includes the window: the window in a door counts as placed for the Included chip
//      and the submit gate, and declining it takes it out of the door
//   G. live paint: a body swatch moves the colourless door's panels with the walls and a trim swatch
//      its frame; a scoped rebuild after that (adding a window through recolorItems3, the 3D footer's
//      path) keeps the live colour and draws the window; the footer's Window row takes it out again
//   Q. the quote: Get Quote sends one windows[] line per leaf with inDoor, at the window's price
//   E. the board-and-batten door is UNCHANGED: its mesh digest equals the one recorded on a clean
//      origin/beta tree before this change (PLANK_DIGEST)
//   F. no page errors; screenshots of every door straight on, for holding up against the real doors
//
// SS_DOOR_BASELINE=1 prints only the board-and-batten door's digest and exits, which is how
// PLANK_DIGEST was recorded (on the tree before the generator, where the new looks draw as 'auto').
//
//   python -m http.server 8811 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8811 SS_SHOTS=<dir> node tests/harness/doorLooks.mjs   (exit 0 = every check held)
//
// Supabase is stubbed at the network layer; nothing leaves the machine and NOTHING IS SAVED. The
// tenant, styles and doors are made up, per the public-repo rule.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { launch, reporter, BASE, REF, shotsDir, stubSupabase, collectErrors, openDesigner, readItems, buildingRect, svgPoint, revealTool, bypassGate } from "./lib.mjs";
import { pickStyle, openEditor } from "./gableProbe.mjs";

const BASELINE = !!process.env.SS_DOOR_BASELINE;
// The board-and-batten door's mesh digest, recorded with SS_DOOR_BASELINE=1 on origin/beta before
// the generator (2026-10-07). If this moves, plankDoorLeaf's output moved.
const PLANK_DIGEST = "75c81cdcc8dbe28e";

const { ok, failed } = reporter();
const shots = shotsDir("door-looks");
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const W = 12, L = 32, SIZE = `${W}x${L}`, WALL_H = 8;
const BODY = "#5b6770", TRIM = "#efe6d2", ROOF = "#3a3d42";
const D3 = {
  roof: { eave: "fascia", type: "gable", pitch: 0.42, overhang: 0.8, ridgeOffset: 0 },
  colors: { body: BODY, roof: ROOF, trim: TRIM },
  siding: "panel", foundation: "skids", roofMaterial: "metal", wallHeightFt: WALL_H,
};
const CONFIG = {
  clientId: "harness-door-looks",
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  // [] unlocks Get Quote with no typing (contactComplete short-circuits on an empty list).
  contactFields: [],
  buildingStyles: [{ value: "doors", label: "Door Test", img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3 }],
  defaultSizes: [SIZE],
  sizePricing: { doors: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } } },
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};
const base = { colorMode: "paint", hasTrimColor: true, imageUrl: null, opLeft: false, opRight: false, opDouble: false, opSlideUp: false, opDefault: null,
  swingIn: false, swingOut: true, swingDefault: null, sillIn: null, sillMode: "fixed" };
const LOOKS = ["american", "basic", "classic", "dutch"];
const win = (id, name, w, h, price, inDoor) => ({ id, category: "window", name, planLabel: name.slice(0, 4).toUpperCase(), price, widthIn: w, heightIn: h, sortOrder: 0,
  colorMode: "fixed", hasTrimColor: false, imageUrl: null, sillIn: null, sillMode: "fixed", ...(inDoor ? { inDoor: true } : {}) });
const FIX = [
  { ...base, id: "d-plank", category: "door", name: "Barn door", planLabel: "BARN", price: 400, widthIn: 36, heightIn: 80, sortOrder: 0, opRight: true, opLeft: true, opDefault: "right", doorStyle: "plank" },
  ...LOOKS.flatMap((k, i) => [
    { ...base, id: `d-${k}`, category: "door", name: `${k} single`, planLabel: k.slice(0, 3).toUpperCase(), price: 500 + i, widthIn: 36, heightIn: 80, sortOrder: 1 + i, opRight: true, opLeft: true, opDefault: "right", doorStyle: k },
    { ...base, id: `d-${k}2`, category: "door", name: `${k} double`, planLabel: k.slice(0, 3).toUpperCase() + "2", price: 800 + i, widthIn: 60, heightIn: 80, sortOrder: 5 + i, opDouble: true, doorStyle: k },
  ]),
  win("w-door", "Door lite", 18, 24, 95, true),
  // Ticked for doors, but too big for the upper panel of any door here: never offered.
  win("w-big", "Big lite", 30, 40, 150, true),
  // A wall window the builder did not tick for doors: never offered in a door.
  win("w-wall", "Wall window", 18, 24, 120, false),
  // H: a shorter Basic under a transom, and a Basic walk door with a Basic loft door stacked flush over
  // it -- both sized to fit the 8 ft wall.
  { ...base, id: "d-basic76", category: "door", name: "basic 76", planLabel: "B76", price: 450, widthIn: 36, heightIn: 76, sortOrder: 9, opRight: true, opLeft: true, opDefault: "right", doorStyle: "basic" },
  { ...base, id: "d-basic72", category: "door", name: "basic 72", planLabel: "B72", price: 440, widthIn: 36, heightIn: 72, sortOrder: 10, opRight: true, opLeft: true, opDefault: "right", doorStyle: "basic" },
  { ...base, id: "d-loft", category: "door", name: "loft basic", planLabel: "LOFT", price: 300, widthIn: 36, heightIn: 18, sortOrder: 11, opRight: true, opLeft: true, opDefault: "right", sillIn: 72, doorStyle: "basic" },
  { ...win("w-transom", "Transom", 36, 12, 90, false), sillIn: 78 },
];
const FIXTURES = { items: FIX, windowColors: [], ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false } };
const fxOf = (id) => FIX.find((f) => f.id === id);

// The door colours a shopper picked, as the placement paths stamp them.
const SLATE = { colorId: "c-slate", colorLabel: "Slate", colorHex: "#4b5563" };
const GREEN = { colorId: "c-green", colorLabel: "Sage", colorHex: "#8fbf9a" };
const TAN = { colorId: "c-tan", colorLabel: "Tan", colorHex: "#c8a97e" };
const RED = { colorId: "c-red", colorLabel: "Barn red", colorHex: "#7c2d12" };
const CREAM = { trimColorId: "c-cream", trimColorLabel: "Cream", trimColorHex: "#efe6d2" };
const BLACK = { trimColorId: "c-black", trimColorLabel: "Black", trimColorHex: "#1f2328" };
const NO_COLOR = { colorId: null, colorLabel: null, colorHex: null, trimColorId: null, trimColorLabel: null, trimColorHex: null };
const NO_WIN = { doorWindowId: null, doorWindowName: null, doorWindowWidthIn: null, doorWindowHeightIn: null, doorWindowPrice: null };
const LITE = { doorWindowId: "w-door", doorWindowName: "Door lite", doorWindowWidthIn: 18, doorWindowHeightIn: 24, doorWindowPrice: 95 };
// Per door: fixture, wall, centre (ft along the wall), operation, colours, window.
const PLAN = [
  { key: "plank", fx: "d-plank", wall: "west", at: 3, op: "right", c: { ...NO_COLOR, ...RED } },
  { key: "american", fx: "d-american", wall: "west", at: 9, op: "right", c: { ...NO_COLOR, ...SLATE, ...CREAM } },
  { key: "basic", fx: "d-basic", wall: "west", at: 15, op: "left", c: { ...NO_COLOR } },   // no colour of its own: body + building trim
  { key: "classic", fx: "d-classic", wall: "west", at: 21, op: "right", c: { ...NO_COLOR, ...GREEN, ...BLACK } },
  { key: "dutch", fx: "d-dutch", wall: "west", at: 27, op: "left", c: { ...NO_COLOR, ...TAN, ...BLACK } },
  { key: "american2", fx: "d-american2", wall: "east", at: 4, op: "double", c: { ...NO_COLOR, ...SLATE, ...CREAM } },
  { key: "basic2", fx: "d-basic2", wall: "east", at: 11, op: "double", c: { ...NO_COLOR, ...TAN, ...BLACK } },
  { key: "classic2", fx: "d-classic2", wall: "east", at: 18, op: "double", c: { ...NO_COLOR, ...GREEN, ...BLACK } },
  { key: "dutch2", fx: "d-dutch2", wall: "east", at: 25, op: "double", c: { ...NO_COLOR, ...TAN, ...BLACK } },
  { key: "classicWin", fx: "d-classic", wall: "north", at: 6, op: "right", c: { ...NO_COLOR, ...GREEN, ...BLACK }, win: LITE },
  { key: "americanWin2", fx: "d-american2", wall: "south", at: 6, op: "double", c: { ...NO_COLOR, ...SLATE, ...CREAM }, win: LITE },
];
const lookOf = (d) => fxOf(d.fx).doorStyle;
const leavesOf = (d) => (d.op === "double" ? 2 : 1);

// H. Doors whose HEADER has to fit what is round it, and the openings round them. North wall (x across
// the 12 ft width): a Basic flush to the west corner, and a shorter Basic under a transom flush to the
// east one. South wall: an American 0.25 ft from americanWin2 (and 0.25 ft from the west corner), and
// a walk door with a loft door stacked flush over it.
const HPLAN = [
  { key: "hCorner", fx: "d-basic", wall: "north", at: 1.5, op: "right" },
  { key: "hTransom", fx: "d-basic76", wall: "north", at: 10.5, op: "left" },
  { key: "hTransomWin", win: "w-transom", wall: "north", at: 10.5, sillFt: 78 / 12 },
  { key: "hAdj", fx: "d-american", wall: "south", at: 1.75, op: "left", c: { ...NO_COLOR, ...BLACK } },
  { key: "hWalk", fx: "d-basic72", wall: "south", at: 10.5, op: "right" },
  { key: "hLoft", fx: "d-loft", wall: "south", at: 10.5, op: "right", sillFt: 72 / 12 },
];
function planPos(rect, d) {
  const s = rect.w / W, mgX = rect.x, mgY = rect.y, pW = rect.w, pH = rect.h;
  return d.wall === "north" ? { x: mgX + d.at * s, y: mgY, rotation: 0 }
    : d.wall === "south" ? { x: mgX + d.at * s, y: mgY + pH, rotation: 0 }
    : d.wall === "west" ? { x: mgX, y: mgY + d.at * s, rotation: 90 }
    : { x: mgX + pW, y: mgY + d.at * s, rotation: 90 };
}
function hItemsFor(rect, plan = HPLAN, idBase = 200) {
  return plan.map((d, i) => {
    const pos = planPos(rect, d);
    if (d.win) {
      const fx = fxOf(d.win);
      return { id: idBase + i, type: "window", ...pos, wall: d.wall, widthFt: fx.widthIn / 12, heightFt: 0.5, fixtureItemId: fx.id, windowName: fx.name,
        price: fx.price, widthIn: fx.widthIn, heightIn: fx.heightIn, sillFt: d.sillFt, sillMode: "fixed", colorId: null, colorLabel: null, colorHex: null };
    }
    const fx = fxOf(d.fx);
    return { id: idBase + i, type: "fixtureDoor", ...pos, wall: d.wall, widthFt: fx.widthIn / 12, heightFt: 0.5, fixtureItemId: fx.id, doorName: fx.name,
      planLabel: fx.planLabel, price: fx.price, widthIn: fx.widthIn, heightIn: fx.heightIn, swing: "out", operation: d.op, ...NO_COLOR, ...(d.c || {}),
      sillFt: d.sillFt, sillMode: "fixed", ...NO_WIN, ...(d.dw || {}) };
  });
}

function itemsFor(rect) {
  const s = rect.w / W, mgX = rect.x, mgY = rect.y, pW = rect.w, pH = rect.h;
  return PLAN.map((d, i) => {
    const fx = fxOf(d.fx);
    const pos = d.wall === "north" ? { x: mgX + d.at * s, y: mgY, rotation: 0 }
      : d.wall === "south" ? { x: mgX + d.at * s, y: mgY + pH, rotation: 0 }
      : d.wall === "west" ? { x: mgX, y: mgY + d.at * s, rotation: 90 }
      : { x: mgX + pW, y: mgY + d.at * s, rotation: 90 };
    return {
      id: 100 + i, type: "fixtureDoor", ...pos, wall: d.wall, widthFt: fx.widthIn / 12, heightFt: 0.5,
      fixtureItemId: fx.id, doorName: fx.name, planLabel: fx.planLabel, price: fx.price, widthIn: fx.widthIn, heightIn: fx.heightIn,
      swing: "out", operation: d.op, ...d.c, sillFt: undefined, sillMode: "fixed", ...(BASELINE ? {} : { ...NO_WIN, ...(d.win || {}) }),
    };
  });
}

// What each built door is made of, by ssDoorPart, from the look (trimDoorLeaf):
//   every leaf  infill 1 (4 round a window), frame 4, midRail 1, hinge 3 rows x 3 pieces;
//               a latch (2 pieces) on one leaf only
//   american    picket 3 per leaf on the 36 in single, 2 per leaf on the 60 in double (whose leaf is
//               about 29 in): the count whose gaps come nearest 1.3 pickets wide
//   classic     octagon 4 + diamond 1 per leaf (none where a window is), x 2 per leaf
//   dutch       vent 9 per leaf (4 frame + 1 field + 4 slats at these sizes)
//   window      windowCasing 4 + window 7 per leaf (sash 4, glass 1, a 2-pane grille: 2 bars)
//   every door  header 1, threshold 1
function expectedParts(d) {
  const n = leavesOf(d), look = lookOf(d), w = !!d.win;
  const e = { infill: (w ? 4 : 1) * n, frame: 4 * n, midRail: n, hinge: 9 * n, latch: 2, header: 1, threshold: 1 };
  if (look === "american") e.picket = (n === 2 ? 2 : 3) * n;
  if (look === "classic") { if (!w) { e.octagon = 4 * n; e.diamond = n; } e.x = 2 * n; }
  if (look === "dutch") e.vent = 9 * n;
  if (w) { e.windowCasing = 4 * n; e.window = 7 * n; }
  return e;
}

// Every mesh of one door's opening group: what it is, where, and in what.
async function doorMeshes(page, itemId) {
  return page.evaluate((id) => {
    const E = window.__ss3dEngine;
    E.scene.updateMatrixWorld(true);
    const og = E.model.openingsGroup.children.find((g) => g.userData && g.userData.itemId === id);
    if (!og) return null;
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const wallMap = E.model.wallMat && E.model.wallMat.map ? E.model.wallMat.map.uuid : null;
    const out = [];
    og.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const p = o.geometry.parameters || {};
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      out.push({
        geom: o.geometry.type, box: p.width != null ? [r4(p.width), r4(p.height), r4(p.depth)] : null,
        pos: [r4(o.position.x), r4(o.position.y), r4(o.position.z)], rot: [r4(o.rotation.x), r4(o.rotation.y), r4(o.rotation.z)],
        mat: m ? m.type : null, color: m && m.color ? "#" + m.color.getHexString() : null,
        rough: m && m.roughness != null ? r4(m.roughness) : null, metal: m && m.metalness != null ? r4(m.metalness) : null,
        transparent: !!(m && m.transparent), opacity: m && m.opacity != null ? r4(m.opacity) : null, map: !!(m && m.map), visible: o.visible,
        part: (o.userData && o.userData.ssDoorPart) || null, wallMap: !!(m && m.map && m.map.uuid === wallMap),
        min: [r4(bb.min.x), r4(bb.min.y), r4(bb.min.z)], max: [r4(bb.max.x), r4(bb.max.y), r4(bb.max.z)],
      });
    });
    return out;
  }, itemId);
}
const digestOf = (meshes) => createHash("sha256")
  .update(JSON.stringify(meshes.map(({ part: _p, min: _a, max: _b, wallMap: _w, ...m }) => m))).digest("hex").slice(0, 16);
const countParts = (meshes) => meshes.reduce((o, m) => { if (m.part) o[m.part] = (o[m.part] || 0) + 1; return o; }, {});
const sameCounts = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));

// The wall's frame for one door: the axis it runs along, and its outward normal (axis + sign).
// Portrait footprint: x across the width, z along the length, south (+z) the front.
const frameOf = (wall) => (wall === "west" ? { along: 2, n: 0, s: -1 } : wall === "east" ? { along: 2, n: 0, s: 1 }
  : wall === "north" ? { along: 0, n: 2, s: -1 } : { along: 0, n: 2, s: 1 });
const outOf = (m, f, plane) => (f.s > 0 ? m.max[f.n] - plane : plane - m.min[f.n]);
const ctr = (m, k) => (m.min[k] + m.max[k]) / 2;
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// Straight-on camera at one door, framed on its own opening group.
async function aimAt(page, itemId, wall, pad = 1.35, skew = 0) {
  return page.evaluate(({ id, wall, pad, skew }) => {
    const E = window.__ss3dEngine;
    E.scene.updateMatrixWorld(true);
    const og = E.model.openingsGroup.children.find((g) => g.userData && g.userData.itemId === id);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    og.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      [[b.min.x, b.min.y, b.min.z], [b.max.x, b.max.y, b.max.z]].forEach((v) => v.forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); }));
    });
    const c = mn.map((v, k) => (v + mx[k]) / 2), h = mx[1] - mn[1];
    // Far enough that the door's height, padded, fills the camera's vertical field of view.
    const dist = (h * pad / 2) / Math.tan(((E.camera.fov || 45) * Math.PI) / 360);
    const n = wall === "west" ? [-1, 0, 0] : wall === "east" ? [1, 0, 0] : wall === "north" ? [0, 0, -1] : [0, 0, 1];
    // `skew` swings the eye along the wall for a three-quarter view (the depth ladder's shadows).
    const t = [n[2], 0, -n[0]];
    // The viewer keeps the orbit outside the building's radius; a close-up of one door needs to be nearer.
    E.controls.minDistance = 0.5;
    E.camera.position.set(c[0] + n[0] * dist + t[0] * skew * dist, c[1] + 0.2, c[2] + n[2] * dist + t[2] * skew * dist); E.controls.target.set(c[0], c[1], c[2]); E.camera.lookAt(c[0], c[1], c[2]);
    E.camera.updateProjectionMatrix(); if (E.controls.update) E.controls.update(); E.render();
    const r = E.renderer.domElement.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, { id: itemId, wall, pad, skew });
}

// P. The door picker, on a fresh design: open it on the east wall and read what it offers.
async function runPicker(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  await openDesigner(page, CONFIG.clientId);
  await page.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 40000 });
  await pickStyle(page, "Door Test");
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 20000 });
  await settle(page, 500);
  const rect = await buildingRect(page);
  if (BASELINE) { await ctx.close(); return rect; }
  const openPickerAt = async (frac) => {
    await (await revealTool(page, /^Door wall$/)).click();
    await settle(page, 300);
    const p = await svgPoint(page, rect.x + rect.w - 0.4 * (rect.w / W), rect.y + frac * rect.h);
    await page.mouse.click(p.x, p.y);
    await page.getByText("Choose a door").first().waitFor({ timeout: 5000 });
    await settle(page, 300);
  };
  const winRowText = async () => {
    const row = page.locator("[data-ss-door-window-row]");
    return (await row.count()) ? (await row.innerText()) : null;
  };
  // The plank door: no Window row.
  await openPickerAt(0.2);
  await page.getByText("Barn door", { exact: true }).first().click();
  await settle(page, 300);
  ok("P the board-and-batten door offers no Window row", (await winRowText()) === null);
  // The Classic single: the lite that fits, and nothing else.
  await page.getByText("classic single", { exact: true }).first().click();
  await settle(page, 300);
  let t = await winRowText();
  ok("P a Classic single offers No window and the in-door window that fits its leaf", !!t && /No window/.test(t) && /Door lite/.test(t), t || "no row");
  ok("P ...not the in-door window too big for it, nor a window not ticked for doors", !!t && !/Big lite/.test(t) && !/Wall window/.test(t), t || "");
  await page.getByText(/^Door lite/).first().click();
  await settle(page, 200);
  let before = new Set(((await readItems(page)) || []).map((i) => i.id));
  await page.getByRole("button", { name: "Place door" }).click();
  await settle(page, 700);
  let placed = ((await readItems(page)) || []).find((i) => !before.has(i.id));
  ok("P the placed Classic carries the window's five stamps", !!placed && placed.doorWindowId === "w-door" && placed.doorWindowName === "Door lite"
    && placed.doorWindowWidthIn === 18 && placed.doorWindowHeightIn === 24 && placed.doorWindowPrice === 95, JSON.stringify(placed && { id: placed.doorWindowId, n: placed.doorWindowName, w: placed.doorWindowWidthIn, h: placed.doorWindowHeightIn, p: placed.doorWindowPrice }));
  // The Dutch double: each leaf is ~29 in wide, so the 18 in lite still fits it, priced each.
  await openPickerAt(0.75);
  await page.getByText("dutch double", { exact: true }).first().click();
  await settle(page, 300);
  t = await winRowText();
  ok("P a Dutch double offers the lite for each leaf (+$95 each)", !!t && /Door lite/.test(t) && /\+\$95 each/.test(t) && !/Big lite/.test(t), t || "no row");
  // No window picked: the placed door's five fields are all null (never absent).
  before = new Set(((await readItems(page)) || []).map((i) => i.id));
  await page.getByRole("button", { name: "Place door" }).click();
  await settle(page, 700);
  placed = ((await readItems(page)) || []).find((i) => !before.has(i.id));
  ok("P a door placed with No window stamps all five fields null", !!placed && ["doorWindowId", "doorWindowName", "doorWindowWidthIn", "doorWindowHeightIn", "doorWindowPrice"].every((k) => k in placed && placed[k] === null),
    JSON.stringify(placed && Object.fromEntries(Object.entries(placed).filter(([k]) => k.startsWith("doorWindow")))));
  await page.screenshot({ path: join(shots, "picker-plan.png") });
  ok("P no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
  return rect;
}

// X and I. The money side of a window in a door, on the real Details panel and the real chips.
/** Open Details if it is closed (the public page shows a call-to-action bar; the portal a toggle). */
async function openDetails(page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator(".ssd-dt").count()) return;
    const cta = page.locator(".ssd-dt-cta").first();
    if (await cta.count() && await cta.isVisible().catch(() => false)) { await cta.click(); await settle(page); continue; }
    const tog = page.locator(".ssd-dt-tog").first();
    if (await tog.count() && await tog.isVisible().catch(() => false)) { await tog.click(); await settle(page); continue; }
    await settle(page, 800);
  }
}
async function openSaved(browser, items, config) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const code = "SS-HARNDOORM";
  const row = {
    short_code: code, status: "draft", selections: { style: "doors", size: SIZE }, items,
    contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100", street: "", city: "", state: "", zip: "" },
    paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
  };
  const calls = await stubSupabase(page, { config, fixtures: FIXTURES, rpc: { load_design: [row] } });
  await page.route(`**/${REF}.supabase.co/storage/v1/**`, (route) => {
    const hdr = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: hdr, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: hdr, body: JSON.stringify({ Key: "floor-plans/harness.pdf", Id: "1" }) });
  });
  await bypassGate(page, config.clientId);
  await page.goto(`${BASE}/?client=${encodeURIComponent(config.clientId)}&id=${code}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  for (let k = 0; k < 60; k++) { await settle(page, 500); if ((((await readItems(page)) || []).length) >= items.length) break; }
  await settle(page, 800);
  return { ctx, page, errors, calls };
}
const dtRow = (page, label) => page.locator(".ssd-dt-row").filter({ has: page.locator(".ssd-dt-n", { hasText: label }) });
const brief = (its) => JSON.stringify(its.map((i) => [i.id, i.type, i.doorWindowId || null]));
async function runMoney(browser, rect) {
  const LITE_DOOR = { key: "x-door", fx: "d-classic", wall: "north", at: 6, op: "right", dw: LITE };
  const WALL_LITE = { key: "x-wall", win: "w-door", wall: "west", at: 10, sillFt: 4 };
  // X1. The only Door lite on the plan is in a door: the row's × takes it out of the door.
  {
    const items = hItemsFor(rect, [LITE_DOOR], 300);
    const { ctx, page, errors } = await openSaved(browser, items, CONFIG);
    await openDetails(page);
    const r = dtRow(page, /^Door lite/);
    ok("X a window that is only in a door has its Details row, with a ×", (await r.count()) === 1 && (await r.locator(".ssd-dt-x").count()) === 1, String(await r.count()));
    if (await r.count()) await r.locator(".ssd-dt-x").first().click();
    await settle(page, 800);
    const after = (await readItems(page)) || [];
    const dd = after.find((i) => i.id === items[0].id);
    ok("X ...and the × keeps the door and takes the window out of it", !!dd && dd.type === "fixtureDoor" && dd.doorWindowId === null && dd.doorWindowPrice === null, brief(after));
    ok("X ...and the row is gone", (await dtRow(page, /^Door lite/).count()) === 0);
    await page.screenshot({ path: join(shots, "x-details.png") });
    ok("X no page errors (the ×)", errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
  // X2. One Door lite on a wall and one in a door: the row's × asks which, and the door can be picked.
  {
    const items = hItemsFor(rect, [LITE_DOOR, WALL_LITE], 300);
    const { ctx, page, errors } = await openSaved(browser, items, CONFIG);
    await openDetails(page);
    const r = dtRow(page, /^Door lite/);
    if (await r.count()) await r.locator(".ssd-dt-x").first().click();
    await settle(page, 600);
    const rings = page.locator('svg rect[stroke="#DC2626"]');
    const n = await rings.count();
    ok("X with a wall lite too, the × asks which one: both are offered", n === 2, `${n} rings`);
    const doorIt = ((await readItems(page)) || []).find((i) => i.id === items[0].id);
    const cs = await rings.evaluateAll((rs) => rs.map((q) => ({ x: +q.getAttribute("x") + +q.getAttribute("width") / 2, y: +q.getAttribute("y") + +q.getAttribute("height") / 2 })));
    const dist = (c) => (doorIt ? Math.hypot(c.x - doorIt.x, c.y - doorIt.y) : 0);
    const k = cs.reduce((best, c, i) => (dist(c) < dist(cs[best]) ? i : best), 0);
    if (n) await rings.nth(k).click({ force: true });
    await settle(page, 800);
    let after = (await readItems(page)) || [];
    const dd = after.find((i) => i.id === items[0].id), ww = after.find((i) => i.id === items[1].id);
    ok("X ...picking the door keeps the door, takes its window out, and leaves the wall lite", !!dd && dd.doorWindowId === null && !!ww && ww.type === "window", brief(after));
    const r2 = dtRow(page, /^Door lite/);
    if (await r2.count()) await r2.locator(".ssd-dt-x").first().click();
    await settle(page, 800);
    after = (await readItems(page)) || [];
    ok("X ...and the row's × then removes the wall lite", !after.some((i) => i.id === items[1].id) && after.some((i) => i.id === items[0].id), brief(after));
    ok("X no page errors (pick one)", errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
  // I. The size includes one Door lite, and the customer put it in a door.
  const INCL = { ...CONFIG, buildingStyles: CONFIG.buildingStyles.map((st) => ({ ...st, sizeInclusionQty: { [SIZE]: { "w-door": 1 } } })) };
  {
    const items = hItemsFor(rect, [LITE_DOOR], 300);
    const { ctx, page, errors, calls } = await openSaved(browser, items, INCL);
    const chip = page.locator(".ssd-incl-chip").filter({ hasText: "Door lite" });
    const cls = (await chip.count()) ? ((await chip.first().getAttribute("class")) || "") : "no chip";
    ok("I the Included chip counts the window in the door as placed", /is-placed/.test(cls), cls);
    await page.screenshot({ path: join(shots, "i-chip.png") });
    const before = calls.length;
    const submit = page.getByRole("button", { name: /^(Get Quote|Resubmit Quote|Resubmit)$/ }).last();
    let payload = null;
    if (await submit.count()) {
      await submit.click().catch(() => {});
      for (let i = 0; i < 60 && !payload; i++) {
        await settle(page, 250);
        const hit = calls.slice(before).find((cl) => cl.path && cl.path.endsWith("/functions/v1/submit-estimate"));
        if (hit) payload = hit.body;
      }
    }
    const gateMsg = await page.getByText(/Please place all included items/).count();
    ok("I ...and the submit gate lets the quote through, with nothing declined", !!payload && gateMsg === 0 && !(payload.declinedItems || []).length
      && (payload.windows || []).filter((w) => w.inDoor && w.fixtureItemId === "w-door").length === 1, payload ? JSON.stringify(payload.declinedItems) : `no payload; gate message ${gateMsg}`);
    ok("I no page errors (submit)", errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
  {
    const items = hItemsFor(rect, [LITE_DOOR], 300);
    const { ctx, page, errors } = await openSaved(browser, items, INCL);
    const x = page.getByRole("button", { name: "Decline Door lite" });
    if (await x.count()) await x.first().click();
    await settle(page, 800);
    const after = (await readItems(page)) || [];
    const dd = after.find((i) => i.id === items[0].id);
    ok("I declining it takes the window out of the door and keeps the door", !!dd && dd.doorWindowId === null, brief(after));
    ok("I ...and the chip reads declined", (await page.locator(".ssd-incl-chip.is-declined").filter({ hasText: "Door lite" }).count()) === 1);
    ok("I no page errors (decline)", errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
}

async function main() {
  const { browser } = await launch({ width: 1280, height: 900 });
  const rect = await runPicker(browser);
  const items = itemsFor(rect);
  // H's doors and the openings round them ride in the same design (not in BASELINE: PLANK_DIGEST was
  // recorded on a design without them).
  const hItems = BASELINE ? [] : hItemsFor(rect);
  const nDoors = items.length + hItems.filter((i) => i.type === "fixtureDoor").length;
  const CODE = "SS-HARNDOOR";
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const row = {
    short_code: CODE, status: "draft", selections: { style: "doors", size: SIZE }, items: items.concat(hItems),
    contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100", street: "", city: "", state: "", zip: "" },
    paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
  };
  const calls = await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [row] } });
  // The submit uploads the plan PDF and its pictures first; answer storage as an upload that went in.
  await page.route(`**/${REF}.supabase.co/storage/v1/**`, (route) => {
    const hdr = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: hdr, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: hdr, body: JSON.stringify({ Key: "floor-plans/harness.pdf", Id: "1" }) });
  });
  await bypassGate(page, CONFIG.clientId);
  await page.goto(`${BASE}/?client=${encodeURIComponent(CONFIG.clientId)}&id=${CODE}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  let loaded = [];
  for (let k = 0; k < 60 && loaded.length < nDoors; k++) { await settle(page, 500); loaded = ((await readItems(page)) || []).filter((i) => i.type === "fixtureDoor"); }
  ok("the saved design opens with every door", loaded.length === nDoors, `${loaded.length}/${nDoors}`);
  await openEditor(page);

  const byKey = {};
  for (let i = 0; i < PLAN.length; i++) byKey[PLAN[i].key] = await doorMeshes(page, items[i].id);
  const plankDigest = digestOf(byKey.plank || []);
  console.log(`plank door: ${byKey.plank ? byKey.plank.length : 0} meshes, digest ${plankDigest}`);
  if (BASELINE) {
    await browser.close();
    process.exit(byKey.plank && byKey.plank.length ? 0 : 1);
  }
  ok("E the board-and-batten door is byte-identical to origin/beta (mesh digest)", plankDigest === PLANK_DIGEST, `${plankDigest} vs ${PLANK_DIGEST}`);
  ok("E ...and carries no generator part", (byKey.plank || []).every((m) => !m.part));

  // The plank door's hinge side on the west wall, for C: the jamb plates are the 0.11 ft iron pieces.
  const jambs = (meshes, f) => meshes.filter((m) => (m.color === "#23272e") && near(m.max[f.along] - m.min[f.along], 0.11, 0.002));
  const doorCentre = (meshes, f) => { const c = meshes.filter((m) => !m.part && m.geom === "BoxGeometry"); const lo = Math.min(...c.map((m) => m.min[f.along])), hi = Math.max(...c.map((m) => m.max[f.along])); return (lo + hi) / 2; };
  const sideOf = (meshes, f) => { const c = doorCentre(meshes, f); const js = jambs(meshes, f); return js.length ? Math.sign(js.reduce((s, m) => s + ctr(m, f.along) - c, 0)) : 0; };
  const plankSide = sideOf(byKey.plank || [], frameOf("west"));

  for (let i = 0; i < PLAN.length; i++) {
    const d = PLAN[i];
    if (d.key === "plank") continue;
    const ms = byKey[d.key] || [];
    const f = frameOf(d.wall);
    // A. parts
    const got = countParts(ms), want = expectedParts(d);
    ok(`A ${d.key}: the parts of a ${lookOf(d)} ${leavesOf(d) === 2 ? "double" : "single"}${d.win ? " with a window" : ""}`, sameCounts(got, want), `${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
    // B. colours
    const infill = ms.filter((m) => m.part === "infill"), frame = ms.filter((m) => m.part === "frame" || m.part === "midRail");
    const wantInfill = (d.c.colorHex || BODY).toLowerCase(), wantFrame = (d.c.trimColorHex || TRIM).toLowerCase();
    ok(`B ${d.key}: infill ${wantInfill}${d.c.colorHex ? "" : " (the body colour)"}`, infill.length && infill.every((m) => m.color === wantInfill), [...new Set(infill.map((m) => m.color))].join(","));
    ok(`B ${d.key}: frame ${wantFrame}${d.c.trimColorHex ? "" : " (the building trim)"}`, frame.length && frame.every((m) => m.color === wantFrame), [...new Set(frame.map((m) => m.color))].join(","));
    ok(`B ${d.key}: the infill has grooves of its own, not the walls' texture`, infill.every((m) => m.map && !m.wallMap));
    // C. mid rail at 42% of each leaf; hinge side
    const stiles = ms.filter((m) => m.part === "frame" && m.max[1] - m.min[1] > 3);
    const leafLo = Math.min(...stiles.map((m) => m.min[1])), leafHi = Math.max(...stiles.map((m) => m.max[1]));
    const mids = ms.filter((m) => m.part === "midRail");
    ok(`C ${d.key}: the mid rail is centred at 42% of the leaf`, mids.length && mids.every((m) => near((ctr(m, 1) - leafLo) / (leafHi - leafLo), 0.42, 0.002)),
      mids.map((m) => ((ctr(m, 1) - leafLo) / (leafHi - leafLo)).toFixed(4)).join(","));
    const c = doorCentre(ms, f), js = jambs(ms, f);
    if (d.op === "double") {
      const half = (Number(fxOf(d.fx).widthIn) / 12) / 2;
      ok(`C ${d.key}: hinges on both OUTER stiles`, js.length === 6 && js.filter((m) => ctr(m, f.along) < c).length === 3 && js.every((m) => Math.abs(ctr(m, f.along) - c) > half - 0.25),
        js.map((m) => (ctr(m, f.along) - c).toFixed(2)).join(","));
    } else if (d.wall === "west") {
      const want = d.op === "right" ? plankSide : -plankSide;
      ok(`C ${d.key}: hinged on the side the plank door's rule names (${d.op})`, plankSide !== 0 && sideOf(ms, f) === want, `side ${sideOf(ms, f)} vs ${want}`);
    }
    // D. nothing proud of the casing face but the latch lever (and the header, a cap ON the casing)
    const casing = ms.filter((m) => !m.part && m.geom === "BoxGeometry" && m.max[1] - m.min[1] > 3);
    const plane = casing.length ? ctr(casing[0], f.n) : 0, face = casing.length ? Math.max(...casing.map((m) => outOf(m, f, plane))) : 0;
    const proud = ms.filter((m) => m.part && m.part !== "header" && outOf(m, f, plane) > face + 1e-3);
    ok(`D ${d.key}: nothing past the casing face but the latch lever`, casing.length >= 2 && proud.length === 1 && proud[0].part === "latch",
      `face ${face.toFixed(3)}; proud: ${proud.map((m) => m.part + "@" + outOf(m, f, plane).toFixed(3)).join(",")}`);
    // H0. The header is a thin drip cap: 0.4 of a rail (the real doors' is a third to a half of one).
    const rails = ms.filter((m) => m.part === "frame" && m.max[1] - m.min[1] < 1), hdrs = ms.filter((m) => m.part === "header");
    const railH = rails.length ? rails[0].max[1] - rails[0].min[1] : 0, hdrH = hdrs.length ? hdrs[0].max[1] - hdrs[0].min[1] : 0;
    ok(`H ${d.key}: the header is 0.4 of a rail tall`, railH > 0 && near(hdrH / railH, 0.4, 0.01), `${hdrH.toFixed(3)} / ${railH.toFixed(3)}`);
    // A2. The American's pickets: gaps about 1.3 pickets wide, leaf by leaf (a double's split at its centre).
    if (lookOf(d) === "american") {
      const pks = ms.filter((m) => m.part === "picket");
      const leaves = d.op === "double" ? [pks.filter((m) => ctr(m, f.along) < c), pks.filter((m) => ctr(m, f.along) > c)] : [pks];
      const ratios = leaves.map((lf) => {
        const sorted = lf.slice().sort((a, b) => a.min[f.along] - b.min[f.along]);
        const pw = sorted.reduce((sum, m) => sum + (m.max[f.along] - m.min[f.along]), 0) / Math.max(1, sorted.length);
        const gaps = sorted.slice(1).map((m, k) => m.min[f.along] - sorted[k].max[f.along]);
        return gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length / pw : 0;
      });
      ok(`A2 ${d.key}: the pickets' gaps are about 1.3 pickets wide`, ratios.every((r) => r >= 1.1 && r <= 1.6), ratios.map((r) => r.toFixed(2)).join(","));
    }
    if (d.win) {
      const glass = ms.filter((m) => m.part === "window" && m.transparent);
      const ups = mids.map((m) => m.max[1]);
      const ok1 = glass.length === leavesOf(d) && glass.every((g) => g.min[1] > Math.min(...ups) + 0.1 && g.max[1] < leafHi - 0.2);
      ok(`D ${d.key}: one pane of glass per leaf, inside the upper panel`, ok1, glass.map((g) => `${g.min[1].toFixed(2)}..${g.max[1].toFixed(2)}`).join(" "));
    }
  }

  // H. The header fitted to what is round it.
  const hMs = {};
  for (let i = 0; i < HPLAN.length; i++) if (HPLAN[i].fx) hMs[HPLAN[i].key] = await doorMeshes(page, hItems[i].id);
  const hdrOf = (ms) => (ms || []).filter((m) => m.part === "header");
  // The corner boards stand centred on the footprint's corners, max(T/2 + 0.07, trimFace) = 0.22 ft
  // each side on panel siding; the walls here run along x (north, south).
  const cornerIn = -W / 2 + 0.22;
  {
    const h = hdrOf(hMs.hCorner);
    ok("H a door flush to the corner: its header stops at the corner board's inner edge", h.length === 1 && h[0].min[0] >= cornerIn - 1e-3,
      h.length ? `header x ${h[0].min[0].toFixed(3)}..${h[0].max[0].toFixed(3)}, corner board to ${cornerIn.toFixed(3)}` : "no header");
    const t = hMs.hTransom || [];
    ok("H a door under a transom draws no header over the transom's sill", hdrOf(t).length === 0 && t.some((m) => m.part === "threshold"), JSON.stringify(countParts(t)));
    ok("H a walk door with a loft door stacked flush over it draws no header over the loft door", hdrOf(hMs.hWalk).length === 0, JSON.stringify(countParts(hMs.hWalk || [])));
    const a = hdrOf(hMs.hAdj), b = hdrOf(byKey.americanWin2);
    ok("H two doors 0.25 ft apart: their headers do not overlap", a.length === 1 && b.length === 1 && a[0].max[0] <= b[0].min[0] + 1e-4,
      a.length && b.length ? `${a[0].min[0].toFixed(3)}..${a[0].max[0].toFixed(3)} | ${b[0].min[0].toFixed(3)}..${b[0].max[0].toFixed(3)}` : "missing");
    ok("H ...and the nearer one stops at the corner board too", a.length === 1 && a[0].min[0] >= cornerIn - 1e-3, a.length ? a[0].min[0].toFixed(3) : "");
  }
  for (const key of ["hTransom", "hWalk", "hAdj", "hCorner"]) {
    const i = HPLAN.findIndex((d) => d.key === key);
    const clip = await aimAt(page, hItems[i].id, HPLAN[i].wall, 2.2);
    await settle(page, 200);
    await page.evaluate(() => window.__ss3dEngine.render());
    await page.screenshot({ path: join(shots, `header-${key}.png`), clip });
  }

  // F. Screenshots: every door straight on.
  for (let i = 0; i < PLAN.length; i++) {
    const clip = await aimAt(page, items[i].id, PLAN[i].wall);
    await settle(page, 200);
    await page.evaluate(() => window.__ss3dEngine.render());
    await page.screenshot({ path: join(shots, `door-${PLAN[i].key}.png`), clip });
  }
  // Three-quarter views of two of them, where the depth ladder's shadow lines show.
  for (const key of ["american2", "classicWin"]) {
    const i = PLAN.findIndex((d) => d.key === key);
    const clip = await aimAt(page, items[i].id, PLAN[i].wall, 1.35, 0.6);
    await settle(page, 200);
    await page.evaluate(() => window.__ss3dEngine.render());
    await page.screenshot({ path: join(shots, `door-${key}-angle.png`), clip });
  }

  // G. Live paint, then a scoped rebuild that adds a window, then the footer's row takes it out.
  const basicIdx = PLAN.findIndex((d) => d.key === "basic"), basicId = items[basicIdx].id;
  await page.evaluate(() => window.__ss3dEngine.setLiveColors("Barn Red", "White"));
  let ms = await doorMeshes(page, basicId);
  ok("G a body swatch moves the colourless door's panels with the walls", ms.filter((m) => m.part === "infill").every((m) => m.color === "#8b2e2e"), [...new Set(ms.filter((m) => m.part === "infill").map((m) => m.color))].join(","));
  ok("G ...and a trim swatch its frame", ms.filter((m) => m.part === "frame").every((m) => m.color === "#f2f1ea"), [...new Set(ms.filter((m) => m.part === "frame").map((m) => m.color))].join(","));
  ok("G ...while a door with its own colours keeps them", (await doorMeshes(page, items[PLAN.findIndex((d) => d.key === "american")].id)).filter((m) => m.part === "infill").every((m) => m.color === SLATE.colorHex));
  await page.evaluate(({ id, patch }) => window.__ss3dEngine.recolorItems3([{ id, patch }]), { id: basicId, patch: LITE });
  for (let k = 0; k < 20; k++) { await settle(page, 250); ms = await doorMeshes(page, basicId); if (ms && ms.some((m) => m.part === "window")) break; }
  ok("G a window added through recolorItems3 (the footer's path) is drawn after the scoped rebuild", !!ms && countParts(ms).window === 7 && countParts(ms).windowCasing === 4, JSON.stringify(ms && countParts(ms)));
  ok("G ...and the rebuilt door keeps the LIVE body colour", !!ms && ms.filter((m) => m.part === "infill").every((m) => m.color === "#8b2e2e"), ms && [...new Set(ms.filter((m) => m.part === "infill").map((m) => m.color))].join(","));
  const stamped = ((await readItems(page)) || []).find((i) => i.id === basicId);
  ok("G ...and the design carries the stamps", !!stamped && stamped.doorWindowId === "w-door" && stamped.doorWindowPrice === 95);
  // The footer row: select the basic door by clicking it, then "None".
  const clip = await aimAt(page, basicId, "west");
  await settle(page, 300);
  await page.mouse.click(clip.x + clip.width / 2, clip.y + clip.height * 0.45);
  await settle(page, 600);
  const row3 = page.locator("[data-ss-door-window-3d]");
  const rowText = (await row3.count()) ? await row3.innerText() : "";
  ok("G the 3D footer shows a Window-in-door row for the selected door", /Door lite/.test(rowText) && /None/.test(rowText) && !/Big lite|Wall window/.test(rowText), rowText.replace(/\s+/g, " ") || "no row");
  await page.screenshot({ path: join(shots, "footer-row.png") });
  if (await row3.count()) {
    await row3.getByRole("button", { name: "None" }).click();
    for (let k = 0; k < 20; k++) { await settle(page, 250); ms = await doorMeshes(page, basicId); if (ms && !ms.some((m) => m.part === "window")) break; }
    const after = ((await readItems(page)) || []).find((i) => i.id === basicId);
    ok("G None takes the window out of the door and off the design", !!ms && !ms.some((m) => m.part === "window") && !!after && after.doorWindowId === null, JSON.stringify(ms && countParts(ms)));
  }
  await page.evaluate(() => window.__ss3dEngine.setLiveColors(null, null));

  // Q. The quote.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "✕" && x.previousElementSibling && /^3D Preview/.test(x.previousElementSibling.textContent.trim()));
    if (b) b.click();
  });
  await settle(page, 1500);
  const before = calls.length;
  const submit = page.getByRole("button", { name: /^(Get Quote|Resubmit Quote|Resubmit)$/ }).last();
  let payload = null;
  if (await submit.count()) {
    await submit.click().catch(() => {});
    for (let i = 0; i < 60 && !payload; i++) {
      await settle(page, 250);
      const hit = calls.slice(before).find((cl) => cl.path && cl.path.endsWith("/functions/v1/submit-estimate"));
      if (hit) payload = hit.body;
    }
  }
  ok("Q Get Quote reached submit-estimate", !!payload);
  if (payload) {
    const dw = (payload.windows || []).filter((w) => w.inDoor);
    ok("Q one windows[] line per leaf of each door with a window (1 + 2), inDoor, at the window's price",
      dw.length === 3 && dw.every((w) => w.fixtureItemId === "w-door" && w.price === 95 && w.name === "Door lite" && w.widthIn === 18 && w.heightIn === 24),
      JSON.stringify(dw.map((w) => [w.name, w.price, w.doorName, w.wall])));
    ok("Q ...each naming its door", dw.filter((w) => w.doorName === "classic single").length === 1 && dw.filter((w) => w.doorName === "american double").length === 2);
    ok("Q ...and the doors' own lines are unchanged (no window folded in)", (payload.doors || []).length === nDoors && (payload.doors || []).every((dd) => !("doorWindowId" in dd)));
  }
  ok("F no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
  await runMoney(browser, rect);
  await browser.close();
  const fl = failed();
  console.log(fl.length ? `${fl.length} FAILED` : "ALL CHECKS PASSED");
  process.exit(fl.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
