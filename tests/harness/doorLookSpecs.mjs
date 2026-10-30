// DOOR LOOKS (P2, 2026-10-27): a builder's own 3D door, drawn from its spec on the COMPILED public designer.
//
// A look is a small spec laid over one of the built door looks (its `base`, the row's door_style):
// get_fixtures sends it on a door row as `doorLook: { id, v, spec, thumbUrl }`, and the leaf builders draw
// it (doorLeaf, doorHardware in StructureStudio.jsx). Every design here is a saved one, loaded through the
// stubbed Supabase with made-up looks on made-up rows; nothing leaves the machine and NOTHING IS SAVED.
//
//   L. what a look draws: its parts (counted by userData.ssDoorPart, a free part by its index), its fills;
//      its hinges' type, count and heights, under a transom too; the mirroring rules (the hinge side
//      follows the row's operation; a double's second leaf is the first's mirror with no handle; a
//      single-leaf look on a double, a double's look on a single, a look photographed hinged left on a door
//      hung right); and which colour pick each part follows
//   F. a row whose look a designer cannot draw shows its base look: a spec that does not clean or whose
//      base is not the row's door_style, here; and with SS_BASE_OLD (a designer from before looks, e.g.
//      origin/beta served on another port), a row WITH a look draws there exactly as this build draws the
//      same row with none
//   W. the window rules read the look: the 3D and the estimate agree on every door's windows, and the door
//      picker offers the same (the Details rows price the estimate's own lines, ssDoorWindowLines, which
//      submitEstimateDoorWindowWiring_test carries a look through); glass of the look's own, or a brace
//      across the leaf, in its top panel refuses a panel window; a rail too high refuses a transom; the bases
//      that take one still do; and nothing of a look crosses a window it takes
//   S. a look never draws on a slide-up placement: the door is today's slide-up door, with and without a
//      photo on the row
//   NS. no see-through gap on a look's door either (block N's rays, doorShared.mjs), single and double,
//      with its own glass, a shopper's window, an overlap meet, and in partition walls
//   P. the white 7-panel door (door_looks 8d619c45, 2026-10-29): each raised panel one bevelled frustum, no
//      stiles or rails on a smooth face in one colour, and the photo's paint (spec.paint) until a Door pick
//
// THE RENDER ENTRY (for the door-look generator, P4/P7): one spec, pictured on a plain test building --
//   SS_DOOR_SPEC_FILE=<spec.json> SS_DOOR_SPEC_SIZE=<w>x<h> SS_SHOTS=<dir> node tests/harness/doorLookSpecs.mjs
// The file is a spec, or anything with one under `spec` (a truth file, a sim run record) and maybe `sizeIn`,
// which SS_DOOR_SPEC_SIZE (inches, width x height) overrides. A double when src.leaves is 2, else a single
// hung on the spec's own hinge side. Optional: SS_DOOR_SPEC_NAME (the pictures' prefix; default the file's
// name), SS_DOOR_SPEC_COLORS="door=#rrggbb,trim=#rrggbb" (the row's Door and Door trim picks; default none:
// a built look then wears the body and the building trim, a board door its brown). It saves
// <name>-front.png (straight on), -left35.png and -right35.png, and -inside.png, and prints one JSON line:
// the look drawn or not, its parts, and the see-through rays (block N's, 0 open cells is a pass).
// SS_DOOR_SPEC_DIR=<corpus dir> does the same for every *.truth.json in it that expects a draft, at its own
// sizeIn (SS_DOOR_SPEC_COLORS_FILE, a JSON { id: "door=..,trim=.." }, colours each), and writes sheet.html
// beside the pictures with each case's photo (the truth file's photo.file, relative to the corpus dir).
// Pictures of a corpus go OUTSIDE the repo (the catalog photos are offline only).
//
//   python -m http.server 8841 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8841 SS_SHOTS=<dir> node tests/harness/doorLookSpecs.mjs   (exit 0 = every check held)
//
// The tenant, styles, doors and looks are made up, per the public-repo rule.
import { join, basename, relative, dirname } from "node:path";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir, stubSupabase, collectErrors, openDesigner, readItems, buildingRect, svgPoint, revealTool, bypassGate } from "./lib.mjs";
import { pickStyle, openEditor } from "./gableProbe.mjs";
import { N_PAGE, doorMeshes, digestOf, countParts } from "./doorShared.mjs";

const { ok, failed } = reporter();
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const W = 20, L = 24, SIZE = `${W}x${L}`, WALL_H = 8;
const BODY = "#9aa3a8", TRIM = "#f2efe6", ROOF = "#3a3d42";
const D3 = {
  roof: { eave: "fascia", type: "gable", pitch: 0.42, overhang: 0.8, ridgeOffset: 0 },
  colors: { body: BODY, roof: ROOF, trim: TRIM },
  siding: "panel", foundation: "skids", roofMaterial: "metal", wallHeightFt: WALL_H,
};
const CONFIG = {
  clientId: "harness-door-look-specs",
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: [],
  buildingStyles: [{ value: "looks", label: "Look Test", img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3 }],
  defaultSizes: [SIZE],
  sizePricing: { looks: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } } },
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: true, layoutPricing: {}, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
  // Interior walls, offered (doorLooks.mjs's NCONFIG), so a partition's doors draw.
  layoutItems: { partitionWall: { label: "Partition Wall", icon: "🧱", color: "#57534E", width: 4, height: 0.375, shortLabel: "PART", wallOnly: false, wallSnap: false, group: "interior", modelKey: "partition" } },
  interiorWalls: { offered: true, standardStud: "2x4", method: "lineal_ft", standardHeight: "plate", allowRafters: true, allowRo: true, studs: { "2x4": { rate: 22 } }, coverings: [] },
};
CONFIG.layoutPricing = { partitionWall: { rate: 22, method: "lineal_ft" } };
const rowBase = { colorMode: "paint", hasTrimColor: true, imageUrl: null, opLeft: true, opRight: true, opDouble: true, opSlideUp: true, opDefault: "right",
  swingIn: false, swingOut: true, swingDefault: null, sillIn: null, sillMode: "fixed", sortOrder: 0, price: 500, category: "door" };
// A door row; with `spec`, carrying it as get_fixtures sends a ready look (its base is the row's door_style).
const doorRow = (id, name, wIn, hIn, style, spec, { thumbUrl = null, ...extra } = {}) => ({ ...rowBase, id, name, planLabel: name.slice(0, 4).toUpperCase(), widthIn: wIn, heightIn: hIn,
  ...(style ? { doorStyle: style } : {}), ...(spec ? { doorLook: { id: `look-${id}`, v: 1, spec, thumbUrl } } : {}), ...extra });
const winRow = (id, name, w, h, extra = {}) => ({ id, category: "window", name, planLabel: name.slice(0, 4).toUpperCase(), price: 95, widthIn: w, heightIn: h, sortOrder: 0,
  colorMode: "fixed", hasTrimColor: false, imageUrl: null, sillIn: null, sillMode: "fixed", inDoor: true, ...extra });
const NO_COLOR = { colorId: null, colorLabel: null, colorHex: null, trimColorId: null, trimColorLabel: null, trimColorHex: null };
const NO_WIN = { doorWindowId: null, doorWindowName: null, doorWindowWidthIn: null, doorWindowHeightIn: null, doorWindowPrice: null, doorWindowAt: null };
const LITE = { doorWindowId: "w-lite", doorWindowName: "Door lite", doorWindowWidthIn: 18, doorWindowHeightIn: 24, doorWindowPrice: 95, doorWindowAt: null };
const TOPW = { doorWindowId: "w-top", doorWindowName: "Transom Windows", doorWindowWidthIn: 29, doorWindowHeightIn: 10, doorWindowPrice: 81, doorWindowAt: "top" };
const WINDOWS = [winRow("w-lite", "Door lite", 18, 24), winRow("w-top", "Transom Windows", 29, 10, { price: 81, doorWindowAt: "top" }), winRow("w-tiny", "Tiny lite", 6, 6, { price: 40 })];
const paint = (door, trim) => ({ ...NO_COLOR, ...(door ? { colorId: "c-door", colorLabel: "Door", colorHex: door } : {}), ...(trim ? { trimColorId: "c-trim", trimColorLabel: "Trim", trimColorHex: trim } : {}) });

// Where a door stands on the plan: `at` ft along its wall (x across the width on north/south, z down the
// length on east/west), as the 3D reads the items.
function planPos(rect, wall, at) {
  const s = rect.w / W;
  return wall === "north" ? { x: rect.x + at * s, y: rect.y, rotation: 0 }
    : wall === "south" ? { x: rect.x + at * s, y: rect.y + rect.h, rotation: 0 }
    : wall === "west" ? { x: rect.x, y: rect.y + at * s, rotation: 90 }
    : { x: rect.x + rect.w, y: rect.y + at * s, rotation: 90 };
}
const doorItem = (rect, id, fx, wall, at, op, extra = {}) => ({ id, type: "fixtureDoor", ...planPos(rect, wall, at), wall, widthFt: fx.widthIn / 12, heightFt: 0.5,
  fixtureItemId: fx.id, doorName: fx.name, planLabel: fx.planLabel, price: fx.price, widthIn: fx.widthIn, heightIn: fx.heightIn, swing: "out", operation: op,
  ...NO_COLOR, sillMode: "fixed", ...NO_WIN, ...extra });

// The building's plan rectangle, as the 3D reads the items (doorLooks.mjs's way).
async function planRect(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await stubSupabase(page, { config: CONFIG, fixtures: { items: WINDOWS, windowColors: [], ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false } } });
  await openDesigner(page, CONFIG.clientId);
  await page.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 40000 });
  await pickStyle(page, "Look Test");
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 20000 });
  await settle(page, 500);
  const rect = await buildingRect(page);
  await ctx.close();
  return rect;
}
const fixturesOf = (rows) => ({ items: [...rows, ...WINDOWS], windowColors: [], ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false } });
// A saved design, opened in the 3D editor with __SS3D_DEBUG. `base` serves another designer (block F).
async function loadDesign(browser, { rows, items, code, base = BASE, routes = [] }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const row = {
    short_code: code, status: "draft", selections: { style: "looks", size: SIZE }, items,
    contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100", street: "", city: "", state: "", zip: "" },
    paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
  };
  const calls = await stubSupabase(page, { config: CONFIG, fixtures: fixturesOf(rows), rpc: { load_design: [row] } });
  // Get Estimate uploads the plan PDF first: answer storage as an upload that went in.
  await page.route(`**/${REF}.supabase.co/storage/v1/**`, (route) => {
    const hdr = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: hdr, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: hdr, body: JSON.stringify({ Key: "floor-plans/harness.pdf", Id: "1" }) });
  });
  for (const [url, fn] of routes) await page.route(url, fn);
  await bypassGate(page, CONFIG.clientId);
  await page.goto(`${base}/?client=${encodeURIComponent(CONFIG.clientId)}&id=${code}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  for (let k = 0; k < 60; k++) { await settle(page, 500); if ((((await readItems(page)) || []).length) >= items.length) break; }
  await openEditor(page);
  await page.waitForFunction(() => {
    let hidden = 0;
    window.__ss3dEngine.model.openingsGroup.traverse((o) => { const m = o.material; if (o.isMesh && m && m.isMeshBasicMaterial && m.alphaTest > 0 && !o.visible) hidden++; });
    return hidden === 0;
  }, null, { timeout: 20000 }).catch(() => {});
  await settle(page, 600);
  return { ctx, page, errors, calls };
}
// Is the door's group drawn in a look (doorLeaf marks it), and what it is made of.
const lookOf = (page, itemId) => page.evaluate((id) => {
  const g = window.__ss3dEngine.model.openingsGroup.children.find((o) => o.userData && o.userData.itemId === id);
  return g ? g.userData.ssDoorLook || null : undefined;
}, itemId);

// ── Pictures ─────────────────────────────────────────────────────────────────────────────────────
// A camera `dist` ft from the opening's middle, turned `deg` about the vertical from square on (negative
// `deg` toward the opening's a0 end), on its outward side or (inside) its inward one; the canvas pictured.
async function shoot(page, path, fr, { deg = 0, inside = false, pad = 1.3 } = {}) {
  const clip = await page.evaluate(({ fr, deg, inside, pad }) => {
    const E = window.__ss3dEngine;
    const fov = E.camera.fov || 45, dist = ((fr.y1 - fr.y0) * pad) / 2 / Math.tan((fov * Math.PI) / 360);
    const mid = (fr.a0 + fr.a1) / 2, ty = (fr.y0 + fr.y1) / 2, th = (deg * Math.PI) / 180, s = inside ? -1 : 1;
    const t = [fr.P0[0] + fr.U[0] * mid, ty, fr.P0[2] + fr.U[1] * mid];
    const dn = s * Math.cos(th) * dist, da = Math.sin(th) * dist;
    E.controls.minDistance = 0.2;
    E.camera.position.set(t[0] + fr.N[0] * dn + fr.U[0] * da, ty + 0.1, t[2] + fr.N[1] * dn + fr.U[1] * da);
    E.controls.target.set(...t); E.camera.lookAt(...t);
    E.camera.updateProjectionMatrix(); if (E.controls.update) E.controls.update(); E.render();
    const r = E.renderer.domElement.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, { fr, deg, inside, pad });
  await settle(page, 300);
  await page.evaluate(() => window.__ss3dEngine.render());
  await page.screenshot({ path, clip });
}
const RAY_YAWS = [0, 35, -35, 60, -60];
// One spec on a plain building: the door on the south wall, pictured four ways, its rays fired.
async function renderOne(browser, rect, { name, spec, sizeIn, colors, outDir }) {
  const dbl = spec && spec.src && spec.src.leaves === 2;
  const op = dbl ? "double" : spec && spec.src && spec.src.hinge === "right" ? "right" : "left";
  const fx = doorRow("r-door", name, sizeIn[0], sizeIn[1], spec && spec.base, spec);
  const item = doorItem(rect, 900, fx, "south", W / 2, op, colors || {});
  const { ctx, page, errors } = await loadDesign(browser, { rows: [fx], items: [item], code: "SS-HARNLOOKR" });
  const look = await lookOf(page, 900);
  const r = await page.evaluate(N_PAGE, { sel: { key: name, itemId: 900 }, yaws: RAY_YAWS, reach: 3 });
  const out = { name, sizeIn, op, look, errors: errors.slice(0, 3) };
  if (r.error) out.error = r.error;
  else {
    out.parts = countParts(r.meshes);
    out.rays = { cells: r.total, open: r.misses, inconsistent: r.incons, sample: r.sample };
    const files = [["front", {}], ["left35", { deg: -35 }], ["right35", { deg: 35 }], ["inside", { inside: true }]];
    for (const [k, o] of files) await shoot(page, join(outDir, `${name}-${k}.png`), r.frame, o);
  }
  await ctx.close();
  return out;
}
const sizeOf = (s) => { const m = /^\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(s || "")); return m ? [Number(m[1]), Number(m[2])] : null; };
const colorsOf = (s) => {
  const o = {};
  String(s || "").split(",").forEach((kv) => { const [k, v] = kv.split("=").map((x) => (x || "").trim()); if (/^#[0-9a-f]{6}$/i.test(v || "")) o[k] = v; });
  return paint(o.door || null, o.trim || null);
};
async function renderMode(browser) {
  const rect = await planRect(browser);
  if (process.env.SS_DOOR_SPEC_DIR) {
    const dir = process.env.SS_DOOR_SPEC_DIR;
    const outDir = process.env.SS_SHOTS || join(dir, "runs", "renders");
    mkdirSync(outDir, { recursive: true });
    const pal = process.env.SS_DOOR_SPEC_COLORS_FILE ? JSON.parse(readFileSync(process.env.SS_DOOR_SPEC_COLORS_FILE, "utf8")) : {};
    const rows = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".truth.json")).sort()) {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (t.expect !== "draft" || !t.spec) continue;
      const id = t.id || basename(f, ".truth.json");
      const res = await renderOne(browser, rect, { name: id, spec: t.spec, sizeIn: t.sizeIn, colors: colorsOf(pal[id]), outDir });
      res.photo = t.photo && t.photo.file ? relative(outDir, join(dir, t.photo.file)).split("\\").join("/") : null;
      console.log(JSON.stringify(res));
      rows.push(res);
    }
    const img = (src, cap) => `<figure><img src="${src}" loading="lazy"><figcaption>${cap}</figcaption></figure>`;
    const html = `<!doctype html><meta charset="utf-8"><title>Door looks: P2 renders</title>
<style>body{font:14px system-ui;margin:16px;background:#f4f4f2}section{background:#fff;margin:0 0 16px;padding:12px;border-radius:8px}
.row{display:flex;gap:8px;flex-wrap:wrap}figure{margin:0}img{height:260px;border:1px solid #ddd;background:#fff}figcaption{font-size:12px;color:#555}</style>
<h1>Door looks: P2 renders of the signed truth specs</h1>
${rows.map((r) => `<section><h2>${r.name} (${r.sizeIn.join(" x ")} in, ${r.op}${r.look ? `, drawn as a ${r.look} look` : ", NOT drawn as a look"})</h2>
<p>rays: ${r.rays ? `${r.rays.open} open of ${r.rays.cells}` : r.error}; parts ${r.parts ? Object.entries(r.parts).map(([k, v]) => `${k} ${v}`).join(", ") : ""}</p>
<div class="row">${r.photo ? img(encodeURI(r.photo), "photo") : ""}${["front", "left35", "right35", "inside"].map((k) => img(`${r.name}-${k}.png`, k)).join("")}</div></section>`).join("\n")}`;
    writeFileSync(join(outDir, "sheet.html"), html);
    const bad = rows.filter((r) => !r.look || r.error || (r.rays && (r.rays.open || r.rays.inconsistent)) || r.errors.length);
    console.log(`${rows.length} rendered; ${bad.length} with a problem${bad.length ? ": " + bad.map((r) => r.name).join(", ") : ""}`);
    return bad.length ? 1 : 0;
  }
  const file = process.env.SS_DOOR_SPEC_FILE;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const spec = raw && raw.spec && typeof raw.spec === "object" ? raw.spec : raw;
  const sizeIn = sizeOf(process.env.SS_DOOR_SPEC_SIZE) || (Array.isArray(raw.sizeIn) ? raw.sizeIn : null);
  if (!sizeIn) { console.error("SS_DOOR_SPEC_SIZE=<width>x<height> (inches) is needed: the file has no sizeIn"); return 2; }
  const outDir = process.env.SS_SHOTS || shotsDir("door-look-render");
  mkdirSync(outDir, { recursive: true });
  const name = process.env.SS_DOOR_SPEC_NAME || basename(file).replace(/(\.truth)?\.json$/i, "");
  const res = await renderOne(browser, rect, { name, spec, sizeIn, colors: colorsOf(process.env.SS_DOOR_SPEC_COLORS), outDir });
  console.log(JSON.stringify(res));
  return !res.look || res.error || (res.rays && (res.rays.open || res.rays.inconsistent)) || res.errors.length ? 1 : 0;
}

async function main() {
  const { browser } = await launch({ width: 1280, height: 900 });
  if (process.env.SS_DOOR_SPEC_FILE || process.env.SS_DOOR_SPEC_DIR) {
    const code = await renderMode(browser);
    await browser.close();
    process.exit(code);
  }
  const rect = await planRect(browser);
  await runBlocks(browser, rect);
  await browser.close();
  const fl = failed();
  console.log(fl.length ? `${fl.length} FAILED` : "ALL CHECKS PASSED");
  process.exit(fl.length ? 1 : 0);
}
// ── The looks the blocks draw (made up; the shapes of the corpus's doors) ────────────────────────────
const ZB = { v: 1, base: "zbrace", src: { leaves: 2, hinge: "right" }, frame: { fIn: 5.5, rails: [0.5] }, field: { dir: "v", pitchIn: 5.5 },
  brace: { t: "z", from: "hinge" }, panels: [{ fill: "none" }, { fill: "none" }],
  hinges: { type: "tstrap", count: 3, at: [0.12, 0.5, 0.88], lenIn: 16, finish: "black" }, handle: { type: "barn", v: "rail", finish: "black" },
  meet: { type: "overlap", wIn: 2 }, colors: { infill: "door", frame: "trim", members: "trim" } };
const STEEL = { v: 1, base: "basic", src: { leaves: 1, hinge: "left" }, frame: { rails: [] }, field: { dir: "smooth" }, panels: [{ fill: "none" }],
  parts: [{ t: "lite", u0: 0.18, v0: 0.48, u1: 0.79, v1: 0.93, rows: 3, cols: 3 }, { t: "raised", u0: 0.21, v0: 0.12, u1: 0.44, v1: 0.39 },
    { t: "raised", u0: 0.58, v0: 0.12, u1: 0.83, v1: 0.39 }], hinges: { type: "hidden", count: 0 }, handle: { v: 0.43, finish: "galv" }, colors: { infill: "door", frame: "door" } };
const SIX = { ...STEEL, parts: [0.05, 0.44, 0.82].flatMap((v) => [{ t: "raised", u0: 0.18, v0: v, u1: 0.43, v1: v + 0.12 + (v < 0.8 ? 0.18 : 0) },
  { t: "raised", u0: 0.57, v0: v, u1: 0.82, v1: v + 0.12 + (v < 0.8 ? 0.18 : 0) }]), hinges: { type: "butt", count: 3, at: [0.11, 0.5, 0.9], finish: "galv" } };
const CORNERS = { v: 1, base: "basic", src: { leaves: 2, hinge: "right" }, frame: { fIn: 1.5, railHIn: 2, rails: [0.505] }, field: { dir: "grooved" },
  parts: [{ t: "board", u0: 0.975, v0: 0.89, u1: 0.78, v1: 0.98, wIn: 2, role: "members" }, { t: "board", u0: 0.21, v0: 0.98, u1: 0.02, v1: 0.89, wIn: 2, role: "members" },
    { t: "board", u0: 0.975, v0: 0.11, u1: 0.81, v1: 0.02, wIn: 2, role: "members" }, { t: "board", u0: 0.19, v0: 0.02, u1: 0.02, v1: 0.11, wIn: 2, role: "members" }],
  hinges: { type: "butt", count: 2, at: [0.09, 0.92], finish: "galv" }, handle: { type: "lever", v: 0.56 }, meet: { type: "astragal", wIn: 1.5 },
  colors: { infill: "door", frame: "trim", members: "trim" } };
const look = (base, extra) => ({ v: 1, base, src: { leaves: 1, hinge: "left" }, ...extra });
const STRAP = look("basic", { hinges: { type: "strap", count: 2, lenIn: 10, finish: "bronze" }, handle: { type: "ring" } });
const SCROLL = look("plank", { hinges: { type: "scroll", count: 3, finish: "black" }, handle: { type: "thumb", v: 0.45 } });
const PINTLE = look("zbrace", { brace: { t: "z", from: "strike" }, hinges: { type: "pintle", count: 2, at: [0.2, 0.8] }, handle: { type: "pull", v: 0.5 } });
const FILLS = look("american", { frame: { rails: [0.3, 0.6] }, panels: [{ fill: "pickets", count: 4 }, { fill: "raised" }, { fill: "lite", rows: 2, cols: 3 }], handle: { type: "lever", v: 0.5 } });
const DUTCH = look("dutch", { parts: [{ t: "vent", u0: 0.3, v0: 0.62, u1: 0.7, v1: 0.82 }, { t: "split", v: 0.5 }] });
const CLASSIC_Z = look("classic", { panels: [{ fill: "z", zFrom: "strike" }, { fill: "diamond" }], colors: { frame: "#7C2D12", members: "door" } });
const VENT1 = look("basic", { src: { leaves: 1, hinge: "right" }, parts: [{ t: "vent", u0: 0.6, v0: 0.15, u1: 0.9, v1: 0.3 }] });
const ZLEFT = look("zbrace", { src: { leaves: 1, hinge: "left" } });
const TRANSOM_H = look("basic", { hinges: { count: 3, at: [0.1, 0.5, 0.95] } });
// Butt hinges at the table's outermost heights (0.01 / 0.99, 10-27): every piece must stay on the leaf.
const BUTT_ENDS = look("basic", { frame: { fIn: 1.5 }, hinges: { type: "butt", count: 2, at: [0.01, 0.99], finish: "galv" } });

// One door of a block: its row (with or without its look) and where it stands.
const L_DOORS = [
  { key: "zb2", spec: ZB, style: "zbrace", w: 72, h: 80, wall: "south", at: 4, op: "double", c: paint("#4b5563", "#efe6d2") },
  { key: "corners", spec: CORNERS, style: "basic", w: 72, h: 76, wall: "south", at: 11.5, op: "double", c: paint("#a3abb3", "#2d4f7c") },
  { key: "southRight", spec: look("basic", {}), style: "basic", w: 36, h: 80, wall: "south", at: 17, op: "right" },
  { key: "steel", spec: STEEL, style: "basic", w: 36, h: 80, wall: "north", at: 3, op: "left" },
  { key: "six", spec: SIX, style: "basic", w: 36, h: 81, wall: "north", at: 7.5, op: "right", c: paint("#eceff1", null) },
  { key: "strap", spec: STRAP, style: "basic", w: 36, h: 80, wall: "north", at: 12, op: "left" },
  { key: "scroll", spec: SCROLL, style: "plank", w: 36, h: 80, wall: "north", at: 16.5, op: "right" },
  { key: "pintle", spec: PINTLE, style: "zbrace", w: 36, h: 80, wall: "east", at: 3, op: "right" },
  { key: "fills", spec: FILLS, style: "american", w: 36, h: 80, wall: "east", at: 7.5, op: "left", c: paint("#5b636b", "#ebe5d3") },
  { key: "dutch", spec: DUTCH, style: "dutch", w: 36, h: 80, wall: "east", at: 12, op: "right", c: paint("#c8b192", "#1f2328") },
  { key: "classicZ", spec: CLASSIC_Z, style: "classic", w: 36, h: 80, wall: "east", at: 16.5, op: "left", c: paint("#8fcfa4", "#1f2328") },
  { key: "buttEnds", spec: BUTT_ENDS, style: "basic", w: 36, h: 80, wall: "east", at: 21, op: "right" },
  // The mirroring cases share the west wall, so their hinge sides compare in one frame.
  { key: "oneOnTwo", spec: VENT1, style: "basic", w: 72, h: 80, wall: "west", at: 4.25, op: "double" },
  { key: "twoOnOne", spec: ZB, style: "zbrace", w: 36, h: 80, wall: "west", at: 9.5, op: "right" },
  { key: "zLeft", spec: ZLEFT, style: "zbrace", w: 36, h: 80, wall: "west", at: 13.5, op: "left" },
  { key: "zRight", spec: ZLEFT, style: "zbrace", w: 36, h: 80, wall: "west", at: 17.5, op: "right" },
  { key: "transomH", spec: TRANSOM_H, style: "basic", w: 36, h: 80, wall: "west", at: 21.5, op: "right", dw: TOPW },
];
// Look doors in two partition walls across the building (ssPartitionPieces cuts them), seen from both rooms.
const P_DOORS = [
  { key: "part-steel", spec: STEEL, style: "basic", w: 36, h: 80, op: "right", y: 8, c: 3 },
  { key: "part-zb2", spec: ZB, style: "zbrace", w: 72, h: 80, op: "double", y: 8, c: 9.5 },
  { key: "part-classicZ", spec: CLASSIC_Z, style: "classic", w: 36, h: 80, op: "left", y: 8, c: 15 },
  { key: "part-corners", spec: CORNERS, style: "basic", w: 72, h: 76, op: "double", y: 16, c: 5 },
  { key: "part-scroll", spec: SCROLL, style: "plank", w: 36, h: 80, op: "right", y: 16, c: 12 },
];
const rowOf = (d, withLook = true, extra = {}) => doorRow(`d-${d.key}`, `${d.key} door`, d.w, d.h, d.style, withLook ? d.spec : null, extra);
function designOf(rect, doors, pdoors = [], { withLook = true, idBase = 1000 } = {}) {
  const rows = [], items = [];
  doors.forEach((d, i) => {
    const fx = rowOf(d, withLook, d.row || {});
    if (!rows.some((r) => r.id === fx.id)) rows.push(fx);
    d.itemId = idBase + i;
    items.push(doorItem(rect, d.itemId, fx, d.wall, d.at, d.op, { ...(d.c || {}), ...(d.dw || {}) }));
  });
  const walls = {};
  pdoors.forEach((d) => {
    const fx = rowOf(d, withLook);
    if (!rows.some((r) => r.id === fx.id)) rows.push(fx);
    (walls[d.y] = walls[d.y] || []).push(d);
  });
  Object.entries(walls).forEach(([y, ds], k) => {
    const openings = ds.map((d, j) => {
      const fx = rows.find((r) => r.id === `d-${d.key}`);
      // centerFt runs along the wall from its own start at x = 1; partAt is the world centre (x, z).
      d.partAt = [1 + (d.c - 1) - W / 2, Number(y) - L / 2];
      return { id: j + 1, kind: "door", fixtureItemId: fx.id, name: fx.name, planLabel: fx.planLabel, widthIn: fx.widthIn, heightIn: fx.heightIn,
        swing: "out", operation: d.op, price: fx.price, centerFt: d.c - 1 };
    });
    items.push({ id: idBase + 900 + k, type: "partitionWall", wall: null, x1Ft: 1, y1Ft: Number(y), x2Ft: W - 1, y2Ft: Number(y), heightMode: "plate",
      heightIn: null, stud: "2x4", covers: { a: null, b: null }, openings });
  });
  return { rows, items };
}
// Every mesh of a door's group, as the look checks read it: its tag and part index, its world bounds and
// centre, its own x axis in the world (a turned brace's direction) and its length, and its paint.
const LOOK_MESHES = (sel) => {
  const E = window.__ss3dEngine;
  E.scene.updateMatrixWorld(true);
  let og = null;
  if (sel.itemId != null) og = E.model.openingsGroup.children.find((g) => g.userData && g.userData.itemId === sel.itemId);
  else E.model.interiorGroup.traverse((o) => {
    if (og || !(o.userData && o.userData.ssPartitionOpening === "door")) return;
    const b = { mn: [Infinity, Infinity], mx: [-Infinity, -Infinity] };
    o.traverse((m) => {
      if (!m.isMesh) return;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
      b.mn = [Math.min(b.mn[0], bb.min.x), Math.min(b.mn[1], bb.min.z)]; b.mx = [Math.max(b.mx[0], bb.max.x), Math.max(b.mx[1], bb.max.z)];
    });
    if (Math.hypot((b.mn[0] + b.mx[0]) / 2 - sel.part[0], (b.mn[1] + b.mx[1]) / 2 - sel.part[1]) < 0.5) og = o;
  });
  if (!og) return null;
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const out = [];
  og.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    const m = Array.isArray(o.material) ? o.material[0] : o.material, p = o.geometry.parameters || {}, e = o.matrixWorld.elements;
    out.push({ part: (o.userData && o.userData.ssDoorPart) || null, ix: o.userData && o.userData.ssDoorPartIx != null ? o.userData.ssDoorPartIx : null,
      gap: (o.userData && o.userData.ssDoorGap) || null, geom: o.geometry.type, len: p.width != null ? r4(p.width) : null,
      min: [bb.min.x, bb.min.y, bb.min.z].map(r4), max: [bb.max.x, bb.max.y, bb.max.z].map(r4), c: [e[12], e[13], e[14]].map(r4), ax: [e[0], e[1], e[2]],
      color: m && m.color ? "#" + m.color.getHexString() : null, map: !!(m && m.map), transparent: !!(m && m.transparent) });
  });
  return { look: og.userData.ssDoorLook || null, meshes: out };
};
const along = (wall) => (wall === "east" || wall === "west" ? 2 : 0);
const ctrOf = (m, k) => (m.min[k] + m.max[k]) / 2;
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
// The door's centre along its wall, in world feet.
const doorMid = (d) => (along(d.wall) === 0 ? d.at - W / 2 : d.at - L / 2);
// A leaf's meshes (a double's split at its centre; side -1 the a-low leaf), and the leaf's own bounds off its slab.
const leafOf = (ms, d, side) => (d.op === "double" ? ms.filter((m) => Math.sign(ctrOf(m, along(d.wall)) - doorMid(d)) === side) : ms);
const leafBox = (ms) => {
  const s = ms.filter((m) => m.part === "infill");
  return { y0: Math.min(...s.map((m) => m.min[1])), y1: Math.max(...s.map((m) => m.max[1])) };
};
// A leaf's hinge rows: its hinge meshes grouped by height.
function hingeRows(ms) {
  const hs = ms.filter((m) => m.part === "hinge").sort((a, b) => ctrOf(a, 1) - ctrOf(b, 1));
  const rows = [];
  hs.forEach((m) => { const r = rows.find((q) => Math.abs(q.y - ctrOf(m, 1)) < 0.08); if (r) r.ms.push(m); else rows.push({ y: ctrOf(m, 1), ms: [m] }); });
  return rows;
}
// What one hinge row of each type is made of (doorHardware).
const HINGE_KIT = { tstrap: { BoxGeometry: 3 }, strap: { BoxGeometry: 2, CylinderGeometry: 1 }, scroll: { BoxGeometry: 2, CylinderGeometry: 1, TorusGeometry: 1 },
  pintle: { BoxGeometry: 3, CylinderGeometry: 2 }, butt: { BoxGeometry: 2, CylinderGeometry: 1 } };
const kitOf = (ms) => ms.reduce((o, m) => { o[m.geom] = (o[m.geom] || 0) + 1; return o; }, {});
const sameKit = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
// Distinct free parts by type: { "part-raised": 2, ... } (a double's leaves share their indices).
const freeParts = (ms) => {
  const seen = {};
  ms.filter((m) => m.ix != null && /^part-/.test(m.part) && !/Room$/.test(m.part)).forEach((m) => { (seen[m.part] = seen[m.part] || new Set()).add(m.ix); });
  return Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.size]));
};
const wantParts = (spec) => (spec.parts || []).reduce((o, q) => { o["part-" + q.t] = (o["part-" + q.t] || 0) + 1; return o; }, {});

// ── L. What a look draws ─────────────────────────────────────────────────────────────────────────
async function runL(browser, rect) {
  const { rows, items } = designOf(rect, L_DOORS, P_DOORS);
  const { ctx, page, errors } = await loadDesign(browser, { rows, items, code: "SS-HARNLOOKL" });
  const shots = shotsDir("door-look-specs");
  const got = {};
  for (const d of L_DOORS) got[d.key] = await page.evaluate(LOOK_MESHES, { itemId: d.itemId });
  // Every door here is drawn in its look.
  for (const d of L_DOORS) ok(`L ${d.key}: drawn in its look (${d.spec.base})`, !!got[d.key] && got[d.key].look === d.spec.base, JSON.stringify(got[d.key] && got[d.key].look));
  // L1. Free parts: each one the spec has, once (a double's two leaves share an index), as its own meshes.
  for (const d of L_DOORS.filter((x) => (x.spec.parts || []).length)) {
    const ms = got[d.key].meshes, fp = freeParts(ms), want = wantParts(d.spec);
    ok(`L1 ${d.key}: its free parts, each its own tagged meshes ${JSON.stringify(want)}`, JSON.stringify(Object.entries(fp).sort()) === JSON.stringify(Object.entries(want).sort()), JSON.stringify(fp));
    if (d.op === "double") {
      const per = [-1, 1].map((s) => freeParts(leafOf(ms, d, s)));
      ok(`L1 ${d.key}: both leaves of the double carry every part`, per.every((p) => JSON.stringify(Object.entries(p).sort()) === JSON.stringify(Object.entries(want).sort())), JSON.stringify(per));
    }
  }
  // L1b. Glass of a look's own: a hole in the slab with the room behind it (no slab across the pane).
  for (const key of ["steel", "fills"]) {
    const ms = got[key].meshes, glass = ms.filter((m) => m.transparent && /lite/.test(m.part || ""));
    const slabOver = ms.filter((m) => m.part === "infill" && glass.some((g) => m.min[1] < g.max[1] - 0.01 && m.max[1] > g.min[1] + 0.01
      && m.min[along(L_DOORS.find((x) => x.key === key).wall)] < g.max[along(L_DOORS.find((x) => x.key === key).wall)] - 0.01
      && m.max[along(L_DOORS.find((x) => x.key === key).wall)] > g.min[along(L_DOORS.find((x) => x.key === key).wall)] + 0.01));
    const rooms = ms.filter((m) => /Room$/.test(m.part || ""));
    ok(`L1 ${key}: its glass is a hole in the slab with the room behind it`, glass.length >= 1 && slabOver.length === 0 && rooms.length === glass.length, `${glass.length} panes, ${slabOver.length} slab pieces across them, ${rooms.length} rooms`);
  }
  // L2. Fills: a look's own counts and kinds, in the panels it names.
  {
    const ms = got.fills.meshes, n = (p) => ms.filter((m) => m.part === p).length;
    ok("L2 fills: four pickets (its own count), a raised panel (one bevelled frustum) and a 2 x 3 lite, between two mid rails", n("picket") === 4 && n("raised") === 1 && n("midRail") === 2
      && ms.filter((m) => m.part === "lite" && m.transparent).length === 1, JSON.stringify(countParts(ms.map((m) => ({ part: m.part })))));
    const cz = got.classicZ.meshes;
    ok("L2 classicZ: one Z in the lower panel and the octagon and diamond in the upper", cz.filter((m) => m.part === "z").length === 1 && cz.filter((m) => m.part === "octagon").length === 4
      && cz.filter((m) => m.part === "diamond").length === 1 && !cz.some((m) => m.part === "x"), JSON.stringify(countParts(cz.map((m) => ({ part: m.part })))));
    const yOf = (ms, p) => { const xs = ms.filter((m) => m.part === p && !m.transparent); return xs.length ? (Math.min(...xs.map((m) => m.min[1])) + Math.max(...xs.map((m) => m.max[1]))) / 2 : NaN; };
    const mz = got.classicZ.meshes, mids = mz.filter((m) => m.part === "midRail").map((m) => ctrOf(m, 1));
    ok("L2 classicZ: the Z below the mid rail, the diamond above it", yOf(mz, "z") < mids[0] && yOf(mz, "diamond") > mids[0], `${yOf(mz, "z").toFixed(2)} / ${mids[0] && mids[0].toFixed(2)} / ${yOf(mz, "diamond").toFixed(2)}`);
    ok("L2 fills: pickets in the bottom panel, the raised panel in the middle one, the glass on top", yOf(ms, "picket") < yOf(ms, "raised") && yOf(ms, "raised") < yOf(ms, "lite"),
      `${yOf(ms, "picket").toFixed(2)} < ${yOf(ms, "raised").toFixed(2)} < ${yOf(ms, "lite").toFixed(2)}`);
    const fd = L_DOORS.find((x) => x.key === "fills"), fk = along(fd.wall), lite = ms.filter((m) => m.part === "lite" && !m.transparent);
    const vb = lite.filter((m) => near(m.max[fk] - m.min[fk], 0.06, 0.003) && m.max[1] - m.min[1] > 0.2), hb = lite.filter((m) => near(m.max[1] - m.min[1], 0.06, 0.003) && m.max[fk] - m.min[fk] > 0.1);
    ok("L2 fills: its glass is the look's 2 rows of 3 (two bars up, one across)", vb.length === 2 && hb.length === 1, `${vb.length} up, ${hb.length} across`);
  }
  // L3. Hinges: type (what each row is made of), count and heights; under a transom, none above its rail.
  const hingeCases = [["zb2", "tstrap", 3, [0.12, 0.5, 0.88]], ["six", "butt", 3, [0.11, 0.5, 0.9]], ["corners", "butt", 2, [0.09, 0.92]],
    ["strap", "strap", 2, null], ["scroll", "scroll", 3, null], ["pintle", "pintle", 2, [0.2, 0.8]], ["steel", "hidden", 0, []]];
  for (const [key, type, count, at] of hingeCases) {
    const d = L_DOORS.find((x) => x.key === key);
    for (const side of d.op === "double" ? [-1, 1] : [0]) {
      const ms = side ? leafOf(got[key].meshes, d, side) : got[key].meshes, rows = hingeRows(ms), lb = leafBox(ms), h = lb.y1 - lb.y0;
      // Butt and strap rows are both two plates and a cylinder: a butt's is its knuckle, standing the hinge's
      // height; a strap's is the disc at its end, a strap's width. A pintle has both.
      const tall = (m) => m.max[1] - m.min[1] > 0.2;
      const cylOk = (r) => { const cs = r.ms.filter((m) => m.geom === "CylinderGeometry");
        return type === "butt" ? cs.every(tall) : type === "pintle" ? cs.filter(tall).length === 1 : cs.every((m) => !tall(m)); };
      const kitOk = type === "hidden" || rows.every((r) => sameKit(kitOf(r.ms), HINGE_KIT[type]) && cylOk(r));
      const atOk = !at || rows.every((r, i) => near((r.y - lb.y0) / h, at[i], 0.004));
      ok(`L3 ${key}${side ? (side < 0 ? " (a0 leaf)" : " (a1 leaf)") : ""}: ${count} ${type} hinge(s)${at && at.length ? ` at ${at.join("/")}` : ""}`, rows.length === count && kitOk && atOk,
        rows.map((r) => `${((r.y - lb.y0) / h).toFixed(3)}:${JSON.stringify(kitOf(r.ms))}`).join(" "));
    }
  }
  {
    // Each hinge in its finish; a look's strap as long as it says (pivot to tip, 16 in on zb2).
    const FIN = { zb2: "#23272e", six: "#9aa0a6", corners: "#9aa0a6", strap: "#5a4632", scroll: "#23272e", pintle: "#23272e" };
    for (const [key, hex] of Object.entries(FIN)) {
      const cs = [...new Set(got[key].meshes.filter((m) => m.part === "hinge").map((m) => m.color))];
      ok(`L3 ${key}: its hinges in their finish (${hex})`, cs.length === 1 && cs[0] === hex, JSON.stringify(cs));
    }
    const zd = L_DOORS.find((x) => x.key === "zb2"), k = along(zd.wall);
    const spans = [-1, 1].flatMap((s) => hingeRows(leafOf(got.zb2.meshes, zd, s)).map((r) => Math.max(...r.ms.map((m) => m.max[k])) - Math.min(...r.ms.map((m) => m.min[k]))));
    ok("L3 zb2: each T-strap is the look's 16 in from pivot to tip", spans.length === 6 && spans.every((x) => near(x, 16 / 12, 0.005)), spans.map((x) => (x * 12).toFixed(2)).join(","));
  }
  {
    // On a built look, a count with no heights sits on the rails: the bottom rail's middle and the top rail's.
    const ms = got.strap.meshes, rows = hingeRows(ms), rails = ms.filter((m) => m.part === "frame" && m.max[1] - m.min[1] < 1).sort((a, b) => a.min[1] - b.min[1]);
    ok("L3 strap: two hinges on the top and bottom rails (a built look's rule)", rows.length === 2 && rails.length >= 2 && near(rows[0].y, ctrOf(rails[0], 1), 0.01) && near(rows[1].y, ctrOf(rails[rails.length - 1], 1), 0.01),
      rows.map((r) => r.y.toFixed(3)).join(",") + " vs " + rails.map((m) => ctrOf(m, 1).toFixed(3)).join(","));
    const sc = got.scroll.meshes, srows = hingeRows(sc), mid = sc.filter((m) => m.part === "midRail")[0];
    ok("L3 scroll: a board door's three hinges, the middle one on its mid rail", srows.length === 3 && !!mid && near(srows[1].y, ctrOf(mid, 1), 0.01), srows.map((r) => r.y.toFixed(3)).join(","));
    // At 0.01 / 0.99 a butt hinge's plates and knuckle stay on the leaf: none below its foot or above its head.
    const be = got.buttEnds.meshes, blb = leafBox(be), bh = be.filter((m) => m.part === "hinge");
    ok("L3 buttEnds: butt hinges at 0.01 / 0.99 stay on the leaf (clamped by the knuckle's own height)", bh.length > 0 && bh.every((m) => m.min[1] >= blb.y0 - 1e-3 && m.max[1] <= blb.y1 + 1e-3),
      `leaf ${blb.y0.toFixed(3)}-${blb.y1.toFixed(3)}, hinges ${Math.min(...bh.map((m) => m.min[1])).toFixed(3)}-${Math.max(...bh.map((m) => m.max[1])).toFixed(3)}`);
    const th = got.transomH.meshes, rail = th.find((m) => m.part === "transomRail"), trows = hingeRows(th);
    ok("L3 transomH: under a transom no hinge goes above the transom rail's middle (a 95% hinge is brought down)", !!rail && trows.length === 3 && trows.every((r) => r.y <= ctrOf(rail, 1) + 1e-3)
      && near(trows[2].y, ctrOf(rail, 1), 0.01), trows.map((r) => r.y.toFixed(3)).join(",") + ` vs rail ${rail ? ctrOf(rail, 1).toFixed(3) : "none"}`);
  }
  // L4. The handle: on the latch leaf only, at the look's height, of its type.
  {
    // Each kind by its pieces: the barn latch's plate and 1 in lever; the lever's 2.4 in rose and its bar;
    // the pull's 8 in grip; the thumb latch's 7 in plate and grip; the ring's ring.
    const has = (hs, x) => hs.some((v) => near(v, x, 0.006));
    const HANDLE = { barn: (hs, g) => hs.length === 2 && has(hs, 0.09) && hs.every((v) => v < 0.31), lever: (hs) => hs.length === 2 && has(hs, 0.2) && has(hs, 0.064),
      pull: (hs) => hs.length === 3 && has(hs, 0.68), ring: (hs, g) => hs.length === 2 && g.includes("TorusGeometry"), thumb: (hs) => hs.length === 3 && has(hs, 0.6) && has(hs, 0.4) };
    for (const [key, type] of [["zb2", "barn"], ["corners", "lever"], ["strap", "ring"], ["scroll", "thumb"], ["pintle", "pull"], ["steel", "barn"]]) {
      const ms = got[key].meshes.filter((m) => m.part === "latch"), hs = ms.map((m) => m.max[1] - m.min[1]);
      ok(`L4 ${key}: a ${type} handle`, HANDLE[type](hs, ms.map((m) => m.geom)), JSON.stringify(ms.map((m) => [m.geom, +(m.max[1] - m.min[1]).toFixed(3)])));
    }
    const sh = [...new Set(got.steel.meshes.filter((m) => m.part === "latch").map((m) => m.color))];
    ok("L4 steel: its handle in its finish (galv)", sh.length === 1 && sh[0] === "#9aa0a6", JSON.stringify(sh));
    const d = L_DOORS.find((x) => x.key === "zb2"), lat = got.zb2.meshes.filter((m) => m.part === "latch");
    ok("L4 zb2: one handle, on one leaf of the double", lat.length > 0 && new Set(lat.map((m) => Math.sign(ctrOf(m, along(d.wall)) - doorMid(d)))).size === 1);
    const st = got.steel.meshes, lb = leafBox(st);
    const sl = st.filter((m) => m.part === "latch"), cy = sl.length ? (Math.min(...sl.map((m) => m.min[1])) + Math.max(...sl.map((m) => m.max[1]))) / 2 : -1;
    ok("L4 steel: the handle at the look's height (43% of the leaf)", near((cy - lb.y0) / (lb.y1 - lb.y0), 0.43, 0.01), ((cy - lb.y0) / (lb.y1 - lb.y0)).toFixed(3));
  }
  // L5. Mirroring. A single's hinge side follows the row's operation, whatever side the photo was hinged on;
  // a Z always rises from the hinge side; a double hinges on both outer edges with the handle on one leaf;
  // a single-leaf look on a double is mirrored onto the second leaf; a double's look on a single draws its
  // latch leaf, handle and all.
  const sideOf = (d, ms) => {
    const mid = doorMid(d), k = along(d.wall), hs = ms.filter((m) => m.part === "hinge");
    return hs.length ? Math.sign(hs.reduce((s, m) => s + ctrOf(m, k) - mid, 0)) : 0;
  };
  const braceLow = (d, ms) => {
    const b = ms.find((m) => m.part === "brace"), k = along(d.wall);
    if (!b) return 0;
    // The box's own x axis, its length: the end with the lower y is the low end.
    const half = b.len / 2, e0 = [b.c[0] - b.ax[0] * half, b.c[1] - b.ax[1] * half, b.c[2] - b.ax[2] * half], e1 = [b.c[0] + b.ax[0] * half, b.c[1] + b.ax[1] * half, b.c[2] + b.ax[2] * half];
    const lo = e0[1] < e1[1] ? e0 : e1;
    return Math.sign(lo[k] - doorMid(d));
  };
  {
    const zr = L_DOORS.find((x) => x.key === "zRight"), zl = L_DOORS.find((x) => x.key === "zLeft");
    const sr = sideOf(zr, got.zRight.meshes), sl = sideOf(zl, got.zLeft.meshes);
    ok("L5 one look photographed hinged left: hung right it hinges on the other end than hung left", sr !== 0 && sl === -sr, `right ${sr}, left ${sl}`);
    ok("L5 ...and its Z rises from the hinge side both ways (u starts at the hinge)", braceLow(zr, got.zRight.meshes) === sr && braceLow(zl, got.zLeft.meshes) === sl,
      `right: low end ${braceLow(zr, got.zRight.meshes)}; left: ${braceLow(zl, got.zLeft.meshes)}`);
    const pt = L_DOORS.find((x) => x.key === "pintle"), sp = sideOf(pt, got.pintle.meshes);
    ok("L5 a Z the look says rises from the strike side does", sp !== 0 && braceLow(pt, got.pintle.meshes) === -sp, `hinges ${sp}, low end ${braceLow(pt, got.pintle.meshes)}`);
    const czd = L_DOORS.find((x) => x.key === "classicZ"), czm = got.classicZ.meshes, zMesh = czm.find((m) => m.part === "z");
    const zLow = zMesh ? braceLow(czd, [{ ...zMesh, part: "brace" }]) : 0;
    ok("L5 a panel's Z that rises from the strike side does (classicZ)", zLow !== 0 && zLow === -sideOf(czd, czm), `low end ${zLow}, hinges ${sideOf(czd, czm)}`);
    const sRightSide = sr;   // which way "right" hangs on the west wall: its a1 end
    const sr2 = sideOf(L_DOORS.find((x) => x.key === "southRight"), got.southRight.meshes);   // ...and on the south wall
    for (const key of ["zb2", "corners", "oneOnTwo"]) {
      const d = L_DOORS.find((x) => x.key === key), ms = got[key].meshes, k = along(d.wall), a1 = d.wall === "west" ? sRightSide : sr2;
      // Each leaf's hinges against that leaf's OWN middle (its slab's): on its outer edge.
      const outer = [-1, 1].map((s) => {
        const lf = leafOf(ms, d, s), sl = lf.filter((m) => m.part === "infill"), mid = (Math.min(...sl.map((m) => m.min[k])) + Math.max(...sl.map((m) => m.max[k]))) / 2;
        const hs = lf.filter((m) => m.part === "hinge");
        return hs.length ? Math.sign(hs.reduce((t, m) => t + ctrOf(m, k) - mid, 0)) : 0;
      });
      const lat = ms.filter((m) => m.part === "latch"), latSide = [...new Set(lat.map((m) => Math.sign(ctrOf(m, k) - doorMid(d))))];
      ok(`L5 ${key}: a double hinges each leaf on its outer edge, with the handle on the a1 leaf only`, a1 !== 0 && outer[0] === -1 && outer[1] === 1 && latSide.length === 1 && latSide[0] === a1,
        `hinges ${outer.join("/")} of their leaves' middles, handle on ${latSide.join()} (a1 is ${a1})`);
      if (d.spec.meet && d.spec.meet.type === "overlap") {
        // The overlap strip runs from the latch leaf over the other: its middle is off the meeting line, away from the handle.
        const a = ms.find((m) => m.gap === "astragal");
        ok(`L5 ${key}: its overlap runs from the latch leaf over the other leaf`, !!a && Math.sign(ctrOf(a, k) - doorMid(d)) === -a1 && Math.abs(ctrOf(a, k) - doorMid(d)) > 0.02,
          a ? (ctrOf(a, k) - doorMid(d)).toFixed(4) : "none");
      }
      if (key === "oneOnTwo") {
        // The single-leaf look's vent (u 0.6-0.9, toward the latch edge) sits by the meeting line on BOTH leaves.
        const vs = ms.filter((m) => m.part === "part-vent" && m.geom === "BoxGeometry"), mid = doorMid(d), k = along(d.wall);
        const cs = [-1, 1].map((s) => vs.filter((m) => Math.sign(ctrOf(m, k) - mid) === s)).map((g) => g.length ? (Math.min(...g.map((m) => m.min[k])) + Math.max(...g.map((m) => m.max[k]))) / 2 - mid : null);
        ok("L5 oneOnTwo: a single-leaf look on a double is mirrored onto the second leaf (its vent by the meeting line on both)", cs[0] != null && cs[1] != null && near(cs[0], -cs[1], 0.01) && Math.abs(cs[0]) < 1.5,
          cs.map((x) => (x == null ? "none" : x.toFixed(3))).join(" | "));
      }
    }
    const tw = L_DOORS.find((x) => x.key === "twoOnOne"), tms = got.twoOnOne.meshes;
    ok("L5 twoOnOne: a double's look on a single draws its latch leaf, hinged as the row says, with the handle", sideOf(tw, tms) === sRightSide && tms.some((m) => m.part === "latch"), `side ${sideOf(tw, tms)}`);
  }
  // L6. Colours: each part follows the pick its role names.
  {
    const zb = got.zb2.meshes, uniq = (ms) => [...new Set(ms.map((m) => m.color))];
    ok("L6 zb2: the slab and boards wear the Door pick, the frame and brace the Door trim pick", uniq(zb.filter((m) => m.part === "infill" || m.part === "board")).join() === "#4b5563"
      && uniq(zb.filter((m) => m.part === "frame" || m.part === "midRail" || m.part === "brace")).join() === "#efe6d2", JSON.stringify(uniq(zb.filter((m) => m.part === "frame"))));
    const cz = got.classicZ.meshes;
    ok("L6 classicZ: a fixed colour for its frame, and its members follow the Door pick, plain (no siding grooves)", uniq(cz.filter((m) => m.part === "frame")).join() === "#7c2d12"
      && uniq(cz.filter((m) => ["z", "octagon", "diamond"].includes(m.part))).join() === "#8fcfa4" && cz.filter((m) => ["z", "octagon", "diamond", "frame"].includes(m.part)).every((m) => !m.map),
      JSON.stringify([uniq(cz.filter((m) => m.part === "frame")), uniq(cz.filter((m) => m.part === "z"))]));
    const co = got.corners.meshes;
    ok("L6 corners: its corner boards follow the Door trim pick", uniq(co.filter((m) => m.part === "part-board")).join() === "#2d4f7c", JSON.stringify(uniq(co.filter((m) => m.part === "part-board"))));
    // A look with no pick of its own on a built base: the body paint and the building trim, and live with them.
    const st0 = got.steel.meshes;
    ok("L6 steel (no picks): the slab (role door) wears the body colour", uniq(st0.filter((m) => m.part === "infill")).join() === BODY.toLowerCase(),
      JSON.stringify(uniq(st0.filter((m) => m.part === "infill"))));
    // A smooth face whose frame is its infill's colour is one flat face: no stiles or rails, whose edges
    // only ever showed as seams in the sun (2026-10-29). A frame in the trim's colour is still drawn.
    for (const key of ["steel", "six"]) {
      const fr = got[key].meshes.filter((m) => m.part === "frame" || m.part === "midRail");
      ok(`L6 ${key}: smooth and one colour, so no stiles or rails`, fr.length === 0, `${fr.length} frame meshes`);
    }
    ok("L6 zb2 and corners: a frame in the trim's colour is still drawn", ["zb2", "corners"].every((k) => got[k].meshes.some((m) => m.part === "frame")));
    await page.evaluate(() => window.__ss3dEngine.setLiveColors("Barn Red", "White"));
    const st1 = (await page.evaluate(LOOK_MESHES, { itemId: L_DOORS.find((x) => x.key === "steel").itemId })).meshes;
    ok("L6 steel: a body swatch moves its slab and the frame of its glass with the walls", uniq(st1.filter((m) => m.part === "infill" || m.part === "frame" || (m.part === "part-lite" && !m.transparent))).join() === "#8b2e2e",
      JSON.stringify(uniq(st1.filter((m) => m.part === "infill" || m.part === "frame" || m.part === "part-lite"))));
    await page.evaluate(() => window.__ss3dEngine.setLiveColors(null, null));
  }
  // L7. Partitions: each door drawn in its look; `door` is the brown every partition door wears; a partition's
  // glass shows the room really there, so no room box behind it.
  for (const d of P_DOORS) {
    const r = await page.evaluate(LOOK_MESHES, { part: d.partAt });
    ok(`L7 ${d.key}: drawn in its look (${d.spec.base})`, !!r && r.look === d.spec.base, JSON.stringify(r && r.look));
    if (!r) continue;
    if (d.key === "part-steel") ok("L7 part-steel: its glass is there, with no room box behind it", r.meshes.some((m) => m.part === "part-lite" && m.transparent) && !r.meshes.some((m) => /Room$/.test(m.part || "")));
    if (d.key === "part-classicZ") ok("L7 part-classicZ: its frame in its own colour, its members in the partition door's brown", [...new Set(r.meshes.filter((m) => m.part === "frame").map((m) => m.color))].join() === "#7c2d12"
      && [...new Set(r.meshes.filter((m) => ["z", "octagon", "diamond"].includes(m.part)).map((m) => m.color))].join() === "#77664c");
  }
  // NS. No see-through gap on a look's door: block N's rays, from both faces and at angles, through every
  // door above and the partition doors; and the closures each door gets.
  for (const d of [...L_DOORS, ...P_DOORS]) {
    const sel = d.partAt ? { key: d.key, part: d.partAt, hw: d.w / 24 } : { key: d.key, itemId: d.itemId };
    const r = await page.evaluate(N_PAGE, { sel, yaws: [0, 35, -35, 60, -60], reach: 3 });
    if (r.error) { ok(`NS ${d.key}: found in 3D`, false, r.error); continue; }
    ok(`NS1 ${d.key}: every line through the opening meets the door (${r.total} cells)`, r.misses === 0 && r.incons === 0,
      r.misses ? `${r.misses} open, ${JSON.stringify(r.byRegion)} e.g. ${r.sample.join(" ")}` : `${r.incons} inconsistent`);
    const gotC = r.gaps.reduce((o, g) => { o[g.kind] = (o[g.kind] || 0) + 1; return o; }, {});
    const trim = ["american", "basic", "classic", "dutch"].includes(d.spec.base);
    const want = { liner: 3, ...(trim ? {} : { sill: 1 }), ...(d.op === "double" ? { meet: 1, astragal: 1 } : {}) };
    ok(`NS2 ${d.key}: its gap closures ${JSON.stringify(want)}`, JSON.stringify(Object.entries(gotC).sort()) === JSON.stringify(Object.entries(want).sort()), JSON.stringify(gotC));
    // Each spans the whole of its gap, through the wall line (block N's N2), lies inside the slab's depth, and is in no room.
    const fr = r.frame, c = (fr.a0 + fr.a1) / 2, yb = fr.y0 + (trim ? 0.2 : 0.05), yt = fr.y1 - 0.05;
    const spans = [["liner", fr.a0, fr.a0 + 0.05, yb, yt], ["liner", fr.a1 - 0.05, fr.a1, yb, yt], ["liner", fr.a0, fr.a1, yt, fr.y1]]
      .concat(trim ? [] : [["sill", fr.a0, fr.a1, fr.y0, fr.y0 + 0.05]]).concat(d.op === "double" ? [["meet", c - 0.03, c + 0.03, yb, yt]] : []);
    const covers = (g, [kind, a0, a1, y0, y1]) => g.kind === kind && g.a[0] <= a0 + 1e-4 && g.a[1] >= a1 - 1e-4 && g.y[0] <= y0 + 1e-4 && g.y[1] >= y1 - 1e-4 && g.n[0] < 0 && g.n[1] > 0;
    const open = spans.filter((sp) => !r.gaps.some((g) => covers(g, sp)));
    ok(`NS2 ${d.key}: each closure spans its whole gap, inside the slab's depth, in no room`, open.length === 0
      && r.gaps.filter((g) => g.kind !== "astragal").every((g) => g.n[0] >= -0.08 - 1e-4 && g.n[1] <= 0.08 + 1e-4) && !r.gaps.some((g) => g.inRoom),
      `${open.map((sp) => sp[0]).join(",")} ${r.gaps.map((g) => `${g.kind} ${g.n[0].toFixed(3)}..${g.n[1].toFixed(3)}${g.inRoom ? " IN A ROOM" : ""}`).join(", ")}`);
    if (d.op === "double" && d.spec.meet && d.spec.meet.type === "overlap") {
      const a = r.gaps.find((g) => g.kind === "astragal"), mid = (r.frame.a0 + r.frame.a1) / 2;
      ok(`NS2 ${d.key}: an overlap meet is ${d.spec.meet.wIn} in wide and runs past the meeting line from the latch leaf`, !!a && near(a.a[1] - a.a[0], d.spec.meet.wIn / 12, 1e-3)
        && (near(a.a[1], mid + 1.5 / 24, 2e-3) || near(a.a[0], mid - 1.5 / 24, 2e-3)), a ? `${(a.a[0] - mid).toFixed(4)}..${(a.a[1] - mid).toFixed(4)}` : "none");
    }
  }
  // Pictures: every door square on and at an angle, and the partition doors from both rooms.
  for (const d of L_DOORS) {
    const r = await page.evaluate(N_PAGE, { sel: { key: d.key, itemId: d.itemId }, yaws: [0], reach: 3 });
    if (r.error) continue;
    await shoot(page, join(shots, `L-${d.key}-front.png`), r.frame);
    await shoot(page, join(shots, `L-${d.key}-angle.png`), r.frame, { deg: 35 });
  }
  for (const d of P_DOORS) {
    const r = await page.evaluate(N_PAGE, { sel: { key: d.key, part: d.partAt, hw: d.w / 24 }, yaws: [0], reach: 3 });
    if (r.error) continue;
    await shoot(page, join(shots, `NS-${d.key}-a.png`), r.frame);
    await shoot(page, join(shots, `NS-${d.key}-b.png`), r.frame, { inside: true });
  }
  ok("L no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

// ── F. A look a designer cannot draw shows its base look ─────────────────────────────────────────
async function digestsOf(browser, rect, doors, { withLook, code, base, rowsPatch }) {
  const { rows, items } = designOf(rect, doors, [], { withLook });
  const { ctx, page, errors } = await loadDesign(browser, { rows: rowsPatch ? rows.map(rowsPatch) : rows, items, code, base });
  const out = {};
  for (const d of doors) {
    const ms = await doorMeshes(page, d.itemId);
    out[d.key] = { digest: ms ? digestOf(ms) : null, n: ms ? ms.length : 0, look: await lookOf(page, d.itemId) };
  }
  await ctx.close();
  return { out, errors };
}
async function runF(browser, rect) {
  const doors = [
    { key: "fV2", spec: { ...STEEL, v: 2 }, style: "basic", w: 36, h: 80, wall: "south", at: 3, op: "left" },
    { key: "fBase", spec: CLASSIC_Z, style: "basic", w: 36, h: 80, wall: "south", at: 8, op: "right" },
    { key: "fJunk", spec: "not a spec", style: "zbrace", w: 36, h: 80, wall: "south", at: 13, op: "right" },
    { key: "fLeaves", spec: { ...ZB, src: { leaves: 3, hinge: "left" } }, style: "zbrace", w: 72, h: 80, wall: "north", at: 5, op: "double" },
    // The control: a look that cleans IS drawn, in this same design.
    { key: "fGood", spec: STEEL, style: "basic", w: 36, h: 80, wall: "south", at: 17.5, op: "left", good: true },
    // A look that says nothing (just its base) draws its base mesh for mesh (the digest leaves out the tags a look adds).
    ...["plank", "zbrace"].map((b, i) => ({ key: `fBare-${b}`, spec: look(b, {}), style: b, w: 36, h: 80, wall: "north", at: 11 + i * 4.5, op: "right", good: true, bare: true })),
    ...["xbrace", "american", "basic", "classic", "dutch"].map((b, i) => ({ key: `fBare-${b}`, spec: look(b, {}), style: b, w: 36, h: 80, wall: "east", at: 3 + i * 4.5, op: i % 2 ? "left" : "right", good: true, bare: true })),
  ];
  const a = await digestsOf(browser, rect, doors, { withLook: true, code: "SS-HARNLOOKF1" });
  const b = await digestsOf(browser, rect, doors, { withLook: false, code: "SS-HARNLOOKF2" });
  for (const d of doors.filter((x) => !x.good)) {
    ok(`F1 ${d.key}: a look that does not clean (or whose base is not the row's) draws the base look, byte for byte`, a.out[d.key].look === null && a.out[d.key].n > 0 && a.out[d.key].digest === b.out[d.key].digest,
      `${a.out[d.key].digest} vs ${b.out[d.key].digest} (look ${a.out[d.key].look})`);
  }
  ok("F1 ...while a look that cleans, in the same design, is drawn in its look", a.out.fGood.look === "basic" && a.out.fGood.digest !== b.out.fGood.digest, JSON.stringify(a.out.fGood));
  for (const d of doors.filter((x) => x.bare)) {
    ok(`F1 ${d.key}: a look that says nothing draws its base, mesh for mesh`, a.out[d.key].look === d.style && a.out[d.key].n > 0 && a.out[d.key].digest === b.out[d.key].digest,
      `${a.out[d.key].digest} vs ${b.out[d.key].digest} (look ${a.out[d.key].look})`);
  }
  ok("F1 no page errors", a.errors.length === 0 && b.errors.length === 0, [...a.errors, ...b.errors].slice(0, 3).join(" | "));
  // F2. A designer from before looks (SS_BASE_OLD) reads a row with a look as the row's door_style: exactly
  // what this build draws for the same row with no look.
  const OLD = process.env.SS_BASE_OLD;
  // Not run is not passed: without a designer from before looks there is no F2.
  if (!OLD) { ok("F2 needs SS_BASE_OLD: a designer from before looks (origin/beta's root served on another port)", false); return; }
  const good = L_DOORS.filter((d) => d.wall === "south" || d.wall === "north").map((d) => ({ ...d }));
  const o = await digestsOf(browser, rect, good, { withLook: true, code: "SS-HARNLOOKF3", base: OLD });
  const n = await digestsOf(browser, rect, good, { withLook: false, code: "SS-HARNLOOKF4" });
  for (const d of good) {
    ok(`F2 ${d.key}: the designer before looks draws a row with a look as its base (${d.style}), as this build draws the row with none`, o.out[d.key].n > 0 && o.out[d.key].digest === n.out[d.key].digest,
      `${o.out[d.key].digest} vs ${n.out[d.key].digest}`);
  }
  ok("F2 no page errors on the designer before looks", o.errors.length === 0, o.errors.slice(0, 3).join(" | "));
}

// ── W. The window rules read the look ────────────────────────────────────────────────────────────
// The tile get_fixtures sends with a ready look: our render, in the tenant's public fixtures bucket.
const W_THUMB_URL = `https://${REF}.supabase.co/storage/v1/object/public/fixtures/harness-look-tile.png`;
const W_DOORS = [
  { key: "wGlass", spec: look("american", { panels: [{ fill: "pickets" }, { fill: "lite", rows: 2, cols: 2 }] }), style: "american", w: 36, h: 80, wall: "south", at: 3, op: "right", dw: LITE, n: 0,
    row: { thumbUrl: "https://tiles.example.test/look.png" } },
  { key: "wHighRail", spec: look("basic", { frame: { rails: [0.8] } }), style: "basic", w: 36, h: 80, wall: "south", at: 8, op: "right", dw: TOPW, n: 0 },
  { key: "wPlain", spec: look("basic", { parts: [{ t: "raised", u0: 0.2, v0: 0.1, u1: 0.8, v1: 0.3 }] }), style: "basic", w: 36, h: 80, wall: "south", at: 13, op: "right", dw: LITE, n: 1,
    row: { thumbUrl: W_THUMB_URL } },
  { key: "wLowLite", spec: look("basic", { parts: [{ t: "lite", u0: 0.2, v0: 0.1, u1: 0.8, v1: 0.35, rows: 1, cols: 2 }] }), style: "basic", w: 36, h: 80, wall: "south", at: 17.5, op: "left", dw: LITE, n: 1 },
  { key: "wZb2", spec: ZB, style: "zbrace", w: 72, h: 80, wall: "north", at: 5, op: "double", dw: TOPW, n: 2 },
  { key: "wClassic", spec: CLASSIC_Z, style: "classic", w: 36, h: 80, wall: "north", at: 12, op: "right", dw: TOPW, n: 1 },
  { key: "wSteelTop", spec: STEEL, style: "basic", w: 36, h: 80, wall: "north", at: 16.5, op: "left", dw: TOPW, n: 0 },
  // A look's boards, split groove and long hinges beside a shopper's lite: the lite is drawn, and none of them crosses it.
  { key: "wBoards", spec: look("american", { field: { dir: "v" }, parts: [{ t: "split", v: 0.75 }], hinges: { count: 3, at: [0.1, 0.5, 0.75], lenIn: 30 }, handle: { v: 0.7 } }),
    style: "american", w: 36, h: 80, wall: "east", at: 4, op: "right", dw: LITE, n: 1 },
  // A brace across the whole leaf would cross the lite's glass: no lite.
  { key: "wBrace", spec: look("american", { brace: { t: "z" } }), style: "american", w: 36, h: 80, wall: "east", at: 9, op: "right", dw: LITE, n: 0 },
  // A rail high under a transom: the transom fits over it, and the rail stays, under the transom rail.
  { key: "wRailTop", spec: look("plank", { frame: { rails: [0.74] } }), style: "plank", w: 36, h: 80, wall: "east", at: 14, op: "right", dw: TOPW, n: 1 },
];
async function runW(browser, rect) {
  const { rows, items } = designOf(rect, W_DOORS);
  const { ctx, page, errors, calls } = await loadDesign(browser, { rows, items, code: "SS-HARNLOOKW" });
  const drawn = {};
  for (const d of W_DOORS) {
    const ms = (await page.evaluate(LOOK_MESHES, { itemId: d.itemId })).meshes;
    drawn[d.key] = ms.filter((m) => m.part === "window" && m.transparent).length;
    ok(`W ${d.key}: the 3D draws ${d.n} ${d.dw === TOPW ? "transom(s)" : "panel window(s)"}`, drawn[d.key] === d.n, String(drawn[d.key]));
  }
  {
    const ms = (await page.evaluate(LOOK_MESHES, { itemId: W_DOORS.find((d) => d.key === "wLowLite").itemId })).meshes;
    ok("W wLowLite: the look's own glass below the mid rail and the shopper's lite above it, both drawn", ms.some((m) => m.part === "part-lite" && m.transparent) && ms.some((m) => m.part === "window" && m.transparent));
    const wd = W_DOORS.find((d) => d.key === "wBoards"), k = along(wd.wall), bm = (await page.evaluate(LOOK_MESHES, { itemId: wd.itemId })).meshes;
    const glass = bm.find((m) => m.part === "window" && m.transparent), cs = 0.08;
    const across = glass ? bm.filter((m) => ["board", "part-split", "hinge", "latch"].includes(m.part) && m.max[k] > glass.min[k] - cs + 1e-3 && m.min[k] < glass.max[k] + cs - 1e-3
      && m.max[1] > glass.min[1] - cs + 1e-3 && m.min[1] < glass.max[1] + cs - 1e-3) : [];
    ok("W wBoards: the look's boards, split groove, hinges and handle all keep clear of the lite and its casing", !!glass && bm.some((m) => m.part === "board") && bm.some((m) => m.part === "part-split") && across.length === 0,
      across.map((m) => `${m.part} ${m.min[1].toFixed(2)}..${m.max[1].toFixed(2)}`).join(", "));
    const rd = W_DOORS.find((d) => d.key === "wRailTop"), rm = (await page.evaluate(LOOK_MESHES, { itemId: rd.itemId })).meshes;
    const tr = rm.find((m) => m.part === "transomRail"), mr = rm.filter((m) => m.part === "midRail");
    ok("W wRailTop: the look's high rail stays, under the transom rail", !!tr && mr.length === 1 && mr[0].max[1] <= tr.min[1] + 1e-3, `${mr.map((m) => m.max[1].toFixed(3))} vs ${tr ? tr.min[1].toFixed(3) : "none"}`);
  }
  // The estimate: one windows[] line per window drawn, naming its door.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "✕" && x.previousElementSibling && /^3D Preview/.test(x.previousElementSibling.textContent.trim()));
    if (b) b.click();
  });
  await settle(page, 1500);
  const before = calls.length;
  const submit = page.getByRole("button", { name: /^(Get Estimate|Resubmit for Updated Estimate)$/ }).last();
  let payload = null;
  if (await submit.count()) {
    await submit.click().catch(() => {});
    for (let i = 0; i < 60 && !payload; i++) {
      await settle(page, 250);
      const hit = calls.slice(before).find((cl) => cl.path && cl.path.endsWith("/functions/v1/submit-estimate"));
      if (hit) payload = hit.body;
    }
  }
  ok("W Get Estimate reached submit-estimate", !!payload);
  if (payload) {
    const dw = (payload.windows || []).filter((w) => w.inDoor);
    for (const d of W_DOORS) {
      const n = dw.filter((w) => w.doorName === `${d.key} door`).length;
      ok(`W ${d.key}: the estimate charges the ${d.n} window(s) the 3D draws`, n === d.n && n === drawn[d.key], `${n} lines`);
    }
  }
  ok("W no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
  // The door picker offers what the rules allow for each look row (a fresh design, the north wall).
  const pctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const pg = await pctx.newPage();
  const perr = collectErrors(pg);
  const pickRows = rows.concat([doorRow("d-wGlassBase", "wGlassBase door", 36, 80, "american", null), doorRow("d-wSteelBase", "wSteelBase door", 36, 80, "basic", null)]);
  await stubSupabase(pg, { config: CONFIG, fixtures: fixturesOf(pickRows) });
  await pg.route(W_THUMB_URL, (route) => route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: PNG_1x1 }));
  await openDesigner(pg, CONFIG.clientId);
  await pg.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 40000 });
  await pickStyle(pg, "Look Test");
  await pg.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 20000 });
  await settle(pg, 500);
  await (await revealTool(pg, /^Door wall$/)).click();
  await settle(pg, 300);
  const p = await svgPoint(pg, rect.x + rect.w / 2, rect.y + 0.4 * (rect.w / W));
  await pg.mouse.click(p.x, p.y);
  await pg.getByText("Choose a door").first().waitFor({ timeout: 5000 });
  await settle(pg, 300);
  // The tile: a look's own render in place of the row's photo or the emoji; never from another host.
  const tiles = await pg.locator("[data-ss-door-look-tile]").evaluateAll((xs) => xs.map((x) => x.getAttribute("src")));
  ok("W the picker: a look's door shows the look's tile", tiles.length === 1 && tiles[0] === W_THUMB_URL, JSON.stringify(tiles));
  // Each row here allows a slide-up, which the picker starts on (fixtureInitialOperation) and which takes no
  // window: hang it on hinges first.
  const rowText = async (name) => {
    await pg.getByText(name, { exact: true }).first().click();
    await settle(pg, 300);
    await pg.getByText("Right", { exact: true }).first().click();
    await settle(pg, 300);
    const r = pg.locator("[data-ss-door-window-row]");
    return (await r.count()) ? (await r.innerText()).replace(/\s+/g, " ") : "";
  };
  // Each refusal beside a control that offers on the same click path: the same base with no look, or a
  // window small enough for what the look leaves.
  let t = await rowText("wGlassBase door");
  ok("W the picker: the American with no look offers the lite (the control)", /Door lite/.test(t), t || "no row");
  t = await rowText("wGlass door");
  ok("W the picker: the same American with glass of its own up top offers no lite and no transom", !/Door lite|Tiny lite|Transom Windows/.test(t), t || "no row");
  t = await rowText("wHighRail door");
  ok("W the picker: a look whose rail is too high offers no transom, but the tiny lite that fits over the rail", !/Transom Windows/.test(t) && /Tiny lite/.test(t), t || "no row");
  t = await rowText("wPlain door");
  ok("W the picker: a plain look offers the lite and the transom its base takes", /Door lite/.test(t) && /Transom Windows/.test(t), t || "no row");
  t = await rowText("wSteelBase door");
  ok("W the picker: the Basic with no look offers the lite (the control)", /Door lite/.test(t), t || "no row");
  t = await rowText("wSteelTop door");
  ok("W the picker: a steel slab with its own glass up to the top offers no window at all", !/Door lite|Tiny lite|Transom Windows/.test(t), t || "no row");
  await pg.screenshot({ path: join(shotsDir("door-look-specs"), "W-picker.png") });
  ok("W no page errors (picker)", perr.length === 0, perr.slice(0, 3).join(" | "));
  await pctx.close();
}

// ── S. Never on a slide-up ───────────────────────────────────────────────────────────────────────
const S_PHOTO_URL = `https://${REF}.supabase.co/storage/v1/object/public/fixtures/harness-look-photo.png`;
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
async function runS(browser, rect) {
  const doors = [
    { key: "sUp", spec: STEEL, style: "basic", w: 36, h: 80, wall: "south", at: 4, op: "slideup" },
    { key: "sUpPhoto", spec: CORNERS, style: "basic", w: 72, h: 76, wall: "south", at: 12, op: "slideup", row: { imageUrl: S_PHOTO_URL } },
    { key: "sUpBoard", spec: ZB, style: "zbrace", w: 72, h: 80, wall: "north", at: 5, op: "slideup" },
    { key: "sHinged", spec: STEEL, style: "basic", w: 36, h: 80, wall: "north", at: 14, op: "right" },
  ];
  const routes = [[S_PHOTO_URL, (route) => route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: PNG_1x1 })]];
  const one = async (withLook, code) => {
    const { rows, items } = designOf(rect, doors, [], { withLook });
    const { ctx, page, errors } = await loadDesign(browser, { rows, items, code, routes });
    const out = {};
    for (const d of doors) { const ms = await doorMeshes(page, d.itemId); out[d.key] = { digest: ms ? digestOf(ms) : null, look: await lookOf(page, d.itemId), photo: !!(ms && ms.some((m) => m.mat === "MeshBasicMaterial" && m.map)) }; }
    if (withLook) {
      for (const d of doors.filter((x) => x.op === "slideup")) {
        const r = await page.evaluate(N_PAGE, { sel: { key: d.key, itemId: d.itemId }, yaws: [0], reach: 3 });
        if (!r.error) await shoot(page, join(shotsDir("door-look-specs"), `S-${d.key}.png`), r.frame);
      }
    }
    await ctx.close();
    return { out, errors };
  };
  const a = await one(true, "SS-HARNLOOKS1"), b = await one(false, "SS-HARNLOOKS2");
  for (const d of doors.filter((x) => x.op === "slideup")) {
    ok(`S ${d.key}: a look on a slide-up placement draws today's slide-up door${d.row ? " (with the row's photo)" : ""}, byte for byte`,
      a.out[d.key].look === null && a.out[d.key].digest && a.out[d.key].digest === b.out[d.key].digest && (!d.row || a.out[d.key].photo), `${a.out[d.key].digest} vs ${b.out[d.key].digest}`);
  }
  ok("S ...while the same look hung on hinges draws the look", a.out.sHinged.look === "basic" && a.out.sHinged.digest !== b.out.sHinged.digest);
  ok("S no page errors", a.errors.length === 0 && b.errors.length === 0, [...a.errors, ...b.errors].slice(0, 3).join(" | "));
}

// ── P. The white 7-panel door (door_looks 8d619c45, ai_door_calls 000f707b, 2026-10-29) ─────────────────
// Read right on every count and drawn grey, flat and seamed. Its saved spec as it is; with the paint a press
// now keeps (spec.paint, the photo's white); and that with a Door pick, which wins as on every look.
const SEVEN = { v: 1, src: { hinge: "left", leaves: 1 }, base: "basic", brace: { t: "none" }, field: { dir: "smooth" },
  frame: { fIn: 8, rails: [0.387, 0.497, 0.763], railHIn: 2.5 },
  parts: [[0.213, 0.454, 0.781, 0.885], [0.548, 0.787, 0.781, 0.885], [0.213, 0.454, 0.513, 0.746], [0.548, 0.787, 0.513, 0.746], [0.213, 0.787, 0.401, 0.482],
    [0.216, 0.458, 0.117, 0.371], [0.551, 0.793, 0.117, 0.371]].map(([u0, u1, v0, v1]) => ({ t: "raised", u0, u1, v0, v1 })),
  colors: { frame: "door", infill: "door" }, handle: { v: 0.449, type: "lever", finish: "galv" },
  hinges: { at: [], type: "hidden", count: 0, finish: "black" }, panels: [{ fill: "none" }, { fill: "none" }, { fill: "none" }, { fill: "none" }] };
const WHITE = "#F2F1EA";
async function runP(browser, rect) {
  const doors = [
    { key: "seven", spec: SEVEN, style: "basic", w: 48, h: 84, wall: "south", at: 3.5, op: "left" },
    { key: "sevenPaint", spec: { ...SEVEN, paint: { hex: WHITE } }, style: "basic", w: 48, h: 84, wall: "south", at: 9.5, op: "left" },
    { key: "sevenPick", spec: { ...SEVEN, paint: { hex: WHITE } }, style: "basic", w: 48, h: 84, wall: "south", at: 15.5, op: "left", c: paint("#7a2e2e", null) },
  ];
  const { rows, items } = designOf(rect, doors);
  const { ctx, page, errors } = await loadDesign(browser, { rows, items, code: "SS-HARNLOOKP" });
  const got = {};
  for (const d of doors) got[d.key] = await page.evaluate(LOOK_MESHES, { itemId: d.itemId });
  const uniq = (ms) => [...new Set(ms.map((m) => m.color))].sort().join();
  const face = (ms) => ms.filter((m) => m.part === "infill" || m.part === "part-raised");
  for (const d of doors) {
    const ms = got[d.key] ? got[d.key].meshes : [], raised = ms.filter((m) => m.part === "part-raised");
    ok(`P ${d.key}: drawn in its look (basic)`, !!got[d.key] && got[d.key].look === "basic", JSON.stringify(got[d.key] && got[d.key].look));
    // Each raised panel is ONE mesh, a frustum 0.05 ft deep (the slab's face at 0.08 to its field at 0.13).
    const k = along(d.wall) === 0 ? 2 : 0, deep = raised.map((m) => Math.round((m.max[k] - m.min[k]) * 1000) / 1000);
    ok(`P ${d.key}: seven raised panels, each one bevelled frustum 0.05 ft deep`, raised.length === 7 && new Set(raised.map((m) => m.ix)).size === 7
      && raised.every((m) => m.geom === "BufferGeometry") && deep.every((x) => near(x, 0.05, 0.002)), JSON.stringify({ n: raised.length, deep }));
    const fr = ms.filter((m) => m.part === "frame" || m.part === "midRail");
    ok(`P ${d.key}: a smooth face in one colour, so no stiles or rails (no seams)`, fr.length === 0, `${fr.length} frame meshes`);
  }
  ok("P seven (its saved spec, no paint): the slab and panels wear the body colour, as before", uniq(face(got.seven.meshes)) === BODY.toLowerCase(), uniq(face(got.seven.meshes)));
  ok("P sevenPaint: the slab and panels wear the photo's paint, with no grain", uniq(face(got.sevenPaint.meshes)) === WHITE.toLowerCase() && face(got.sevenPaint.meshes).every((m) => !m.map),
    uniq(face(got.sevenPaint.meshes)));
  ok("P sevenPick: a Door pick wins over the photo's paint", uniq(face(got.sevenPick.meshes)) === "#7a2e2e", uniq(face(got.sevenPick.meshes)));
  ok("P no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

async function runBlocks(browser, rect) {
  const only = (process.env.SS_LOOK_BLOCKS || "L,F,W,S,P").split(",").map((s) => s.trim().toUpperCase());
  if (only.includes("L")) await runL(browser, rect);
  if (only.includes("F")) await runF(browser, rect);
  if (only.includes("W")) await runW(browser, rect);
  if (only.includes("S")) await runS(browser, rect);
  if (only.includes("P")) await runP(browser, rect);
}
main().catch((e) => { console.error(e); process.exit(2); });
