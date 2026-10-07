// A WING ALONG PART OF ITS WALL ON THE 2D PLAN (roof.wingList[i].lengthFt, 2026-10-07), driven through the SHIPPED
// compiled bundle with real clicks and drags. Carolyn, Q3: "yes, a wing can cover part of a side (e.g. 20 ft of a
// 40 ft wall)". The wing stays inside the size, so the building from above is an L or a T, with OPEN GROUND at the
// corners beside the wing (d3WingNotches). Every path that puts something on the plan must know it: a door in open
// ground prints on the quote's floor plan. Fixture: Acme Sheds, a 24 x 40 gable (front a gable end), the left
// wing 8 ft wide and 20 ft long, centred: open ground at x 0..8 over y 0..10 and 30..40 (plan feet).
//
//   N  THE PLAN draws the outline round the open ground (the wall line turns in, the corner says so), and the
//      Floorplan PDF image is the same: white in the open corner, the wall on its line
//   D  a door clicked on the left wall in the open stretch lands on the wing's own wall; one dragged along the
//      north wall into the open corner stops at the face it meets (clamped, never in the open)
//   W  a window dragged onto the left wall past the wing's end is held to the wing's stretch
//   F  a loft clicked across the open stretch, a bench dragged out there, a light placed there and a partition
//      crossing it are each refused with a sentence; the same loft and light from the 3D editor (place3) are
//      refused too, and a bench placed from 3D is held on the wing's stretch (the 3D drags are not driven here)
//   C  ⇔ Center puts a door at the middle of what is LEFT of its wall, and the Measure chips measure to its ends
//   P  a partition wall dragged across into the open stretch, or stretched out into it, is refused; shortened clear
//      of it, the same move is allowed
//   S  something saved out there (a design from before the wing was shortened) is left where it is, ringed in
//      red with one sentence under the plan that says it is still on the estimate, and its door is not built in 3D
//   E  the electrical package lays every outlet on what is left of its wall and hangs no light in the open ground
//   R  A SHORT WALL (12 x 24, the left wing 8 ft wide and 10 ft long, held toward the front: the north wall keeps
//      4 ft): a 6 ft rough opening is refused there from the door picker's tile and from 3D, never hung past the
//      corner; and a stored item added in 3D, whose drop point is open ground on this size, lands inside the walls
//   Each: zero page errors.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/partialWingPlan.mjs      (SS_BASE=http://127.0.0.1:<port>, SS_CASES=N,D, SS_SHOTS=<dir>)
//
// Exit 0 = every assertion held. NOTHING LEAVES THE MACHINE (lib.mjs stubSupabase). Made-up tenant and catalog.
import { join } from "node:path";
import {
  launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, revealTool, bypassGate, shotsDir, BASE,
} from "./lib.mjs";

const W = 24, L = 40, SIZE = `${W}x${L}`;
const CLIENT = "harness-part-wing";
const ROOF = { type: "gable", front: "gable", pitch: 0.5, overhang: 1, eave: "fascia", wingList: [{ wall: "left", widthFt: 8, lengthFt: 20 }] };
const D3_SPEC = { roof: ROOF, siding: "lap", colors: { body: "#e9e4d8", trim: "#5b5f63", roof: "#3b4a5c" }, wallHeightFt: 9, roofMaterial: "metal" };
const CONFIG = {
  clientId: CLIENT,
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: [],
  buildingStyles: [{ value: "pw", label: "Acme L Barn", img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3_SPEC }],
  defaultSizes: [SIZE],
  sizePricing: { pw: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } } },
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: true,
  layoutItems: {
    partitionWall: { label: "Partition Wall", icon: "🧱", color: "#57534E", width: 4, height: 0.375, shortLabel: "PART", wallOnly: false, wallSnap: false, group: "interior", modelKey: "partition" },
    loft: { label: "Loft", icon: "⬆️", color: "#7C3AED", width: 6, height: 4, shortLabel: "LF", wallOnly: false, wallSnap: false, group: "interior" },
    workbench: { label: "Workbench", icon: "🔧", color: "#8B5E3C", width: 4, height: 2, depthIn: 24, shortLabel: "WB", wallOnly: false, wallSnap: true, group: "interior", modelKey: "wallBench", heightOffFloorIn: 36 },
  },
  layoutPricing: { partitionWall: { rate: 22, method: "lineal_ft" }, loft: { rate: 6, method: "sqft_option" }, workbench: { rate: 12, method: "lineal_ft" } },
  layoutPrices: {},
  electrical: { label: "Electrical Package", price: 850, includePanel: false, outletItemId: "e-out", switchItemId: null, lightItemId: "e-lt",
    outletSpacingFt: 6, lightSpacingFt: 10, outletHeightIn: 18, switchHeightIn: 48, outletAboveBenchIn: 42 },
  electricalItems: [
    { id: "e-out", icon: "🔌", name: "Outlet", mount: "wall", withPackage: true, standalone: true, priceWithPackage: 45, priceStandalone: 60, heightOffFloorIn: 18 },
    { id: "e-lt", icon: "💡", name: "Light", mount: "ceiling", withPackage: true, standalone: true, priceWithPackage: 65, priceStandalone: 80, heightOffFloorIn: 96 },
  ],
  insulation: [],
};
const fx = (o) => ({ colorMode: "fixed", sortOrder: 0, imageUrl: null, opLeft: false, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right",
  swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false, sillIn: null, sillMode: "fixed", ...o });
const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false },
  items: [fx({ id: "d-std", name: "Acme Door", category: "door", price: 300, widthIn: 36, heightIn: 80, planLabel: "DR" }),
    fx({ id: "w-std", name: "Acme Window", category: "window", price: 120, widthIn: 24, heightIn: 36, planLabel: "WN", sillIn: 42 })],
  windowColors: [],
};
// The designer's own page geometry (pageGeom) for 24 x 40.
function pageGeom(bw, bh) {
  const visibleH = 1100 - 340;
  const scale = Math.min((850 * 0.70) / bw, (visibleH * 0.70) / bh, (visibleH - 60) / (bh + 4));
  const pW = bw * scale, pH = bh * scale;
  return { scale, pW, pH, mgX: (850 - pW) / 2, mgY: 2 * scale + 30 };
}
const G = pageGeom(W, L);
const px = (xFt) => G.mgX + xFt * G.scale, py = (yFt) => G.mgY + yFt * G.scale;
const ft = (it) => ({ x: (it.x - G.mgX) / G.scale, y: (it.y - G.mgY) / G.scale });
const OPEN = [[0, 8, 0, 10], [0, 8, 30, 40]];                          // the open ground, plan feet
const inOpen = (x0, y0, x1, y1) => OPEN.some((n) => Math.min(x1, n[1]) - Math.max(x0, n[0]) > 0.01 && Math.min(y1, n[3]) - Math.max(y0, n[2]) > 0.01);
const near = (a, b, e = 0.02) => Math.abs(Number(a) - Number(b)) <= e;
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const only = (process.env.SS_CASES || "").split(",").filter(Boolean);
const want = (id) => !only.length || only.includes(id);
const { ok, failed } = reporter();
const shots = process.env.SS_SHOTS ? shotsDir("partialWingPlan") : null;

const planReady = (page) => page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
async function drag(page, from, to, steps = 20) {
  const a = await svgPoint(page, from.x, from.y), b = await svgPoint(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 3, a.y + 3, { steps: 2 });
  await page.mouse.move(b.x, b.y, { steps });
  await settle(page, 150);
  await page.mouse.up();
  await settle(page, 400);
}
async function clickSvg(page, p) { const s = await svgPoint(page, p.x, p.y); await page.mouse.click(s.x, s.y); await settle(page, 300); }
const toastText = (page) => page.evaluate(() => document.body.innerText);
async function openWith(ctx, items) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const row = {
    short_code: "SS-HARNPW01", status: "draft", selections: { style: "pw", size: SIZE }, items,
    contact: { name: "", email: "", phone: "", street: "", city: "", state: "", zip: "" },
    paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
  };
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [row] } });
  await bypassGate(page, CLIENT);
  await page.goto(`${BASE}/?client=${encodeURIComponent(CLIENT)}&id=SS-HARNPW01`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  await planReady(page);
  for (let k = 0; k < 40; k++) { const it = await readItems(page); if (it && it.length === items.length) break; await settle(page, 250); }
  await settle(page, 600);
  return { page, errors };
}
// The style tile, then the size (wingList.mjs's pickStyle / chooseSize): the plan is the default size until then.
async function pickStyleAndSize(page, config = CONFIG, size = SIZE, len = L) {
  const label = config.buildingStyles[0].label;
  await page.waitForFunction((lab) => [...document.querySelectorAll("div,span,p,strong,b")].some((e) => e.children.length === 0 && (e.textContent || "").trim() === lab && e.offsetParent), label, { timeout: 30000 }).catch(() => {});
  await page.evaluate((lab) => {
    const el = [...document.querySelectorAll("div,span,p,strong,b")].find((e) => e.children.length === 0 && (e.textContent || "").trim() === lab && e.offsetParent);
    if (el) el.click();
  }, label);
  await settle(page, 500);
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: size }) });
  if (await sel.count()) await sel.first().selectOption({ label: size });
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), len, { timeout: 15000 });
  await settle(page, 600);
}
async function openFresh(ctx, config = CONFIG, size = SIZE, len = L) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config, fixtures: FIXTURES });
  await openDesigner(page, CLIENT);
  await planReady(page);
  await pickStyleAndSize(page, config, size, len);
  return { page, errors };
}
async function captureAB(page) {
  await page.locator(".ssd-ft-pdf").first().click();
  const img = page.locator('img[alt="Floor Plan"]').first();
  await img.waitFor({ state: "visible", timeout: 30000 });
  const png = await img.getAttribute("src");
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator("h3").filter({ hasText: "Floorplan PDF" }).locator("xpath=..").locator("button").first().click().catch(() => {});
  await settle(page, 300);
  return png;
}
async function pixelAt(page, dataUrl, x, y) {
  return page.evaluate(async ({ dataUrl, x, y }) => {
    const im = new Image(); im.src = dataUrl; await im.decode();
    const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
    const g = c.getContext("2d"); g.drawImage(im, 0, 0);
    return Array.from(g.getImageData(Math.round(x * 2), Math.round(y * 2), 1, 1).data.slice(0, 3));
  }, { dataUrl, x, y });
}
async function open3D(page) {
  const edit = page.getByRole("button", { name: /Edit in 3D/ });
  if (!(await edit.count()) || !(await edit.first().isVisible().catch(() => false))) {
    const show = page.getByRole("button", { name: /Show 3D|3D View/ });
    if (await show.count()) { await show.first().click(); await settle(page, 800); }
  }
  await edit.first().waitFor({ state: "visible", timeout: 60000 });
  await edit.first().click();
  await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length > 0); }, null, { timeout: 90000 });
  await settle(page, 1200);
}

const { browser, ctx } = await launch({ width: 1280, height: 1000 });
try {
  if (want("N")) {
    const { page, errors } = await openFresh(ctx);
    const r = await buildingRect(page);
    ok("N0: the plan is 24 x 40 at the page geometry this test computes", r && near(r.w, G.pW, 0.5) && near(r.h, G.pH, 0.5), JSON.stringify(r));
    const notches = await page.evaluate(() => [...document.querySelectorAll("[data-ss-notch]")].map((g) => {
      const rc = g.querySelector("rect"), pl = g.querySelector("polyline");
      return { i: g.getAttribute("data-ss-notch"), x: +rc.getAttribute("x"), y: +rc.getAttribute("y"), w: +rc.getAttribute("width"), h: +rc.getAttribute("height"),
        line: pl.getAttribute("points"), words: [...g.querySelectorAll("text")].map((t) => t.textContent).join(" ") };
    }));
    ok("N1: the plan draws two open corners beside the wing", notches.length === 2 && notches.every((n) => n.i === "0"), JSON.stringify(notches));
    const n0 = notches[0];
    ok("N2: the first covers x 0..8, y 0..10 (out past the outline's stroke on its outer sides)", !!n0 && n0.x < px(0) && near(n0.x + n0.w, px(8), 0.5) && n0.y < py(0) && near(n0.y + n0.h, py(10), 0.5), JSON.stringify(n0));
    const pts = n0 ? n0.line.split(" ").map((q) => q.split(",").map(Number)) : [];
    ok("N3: the wall turns in round it: from the west line along y 10 to x 8, then up x 8 to the north line", pts.length === 3
      && near(pts[0][0], px(0), 0.5) && near(pts[0][1], py(10), 0.5) && near(pts[1][0], px(8), 0.5) && near(pts[1][1], py(10), 0.5) && near(pts[2][0], px(8), 0.5) && near(pts[2][1], py(0), 0.5), n0 && n0.line);
    ok("N4: and says what it is", notches.every((n) => /Open/.test(n.words)), notches.map((n) => n.words).join(" | "));
    if (shots && notches.length) await page.locator("svg").filter({ has: page.locator("[data-ss-notch]") }).first().screenshot({ path: join(shots, "plan-notch.png") });
    const png = await captureAB(page);
    const hexRgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
    const close = (a, b, tol = 24) => a.every((v, k) => Math.abs(v - b[k]) <= tol);
    const openPx = await pixelAt(page, png, px(4), py(5));
    const wallPx = await pixelAt(page, png, px(8), py(5)), westPx = await pixelAt(page, png, px(0), py(5));
    ok("N5: the Floorplan PDF is white in the open corner", close(openPx, [255, 255, 255], 6), JSON.stringify(openPx));
    ok("N6: ...draws the wall facing it on its line", close(wallPx, hexRgb("#1E293B"), 40), JSON.stringify(wallPx));
    ok("N7: ...and no west wall out there (where the plain building's would be)", close(westPx, [255, 255, 255], 6), JSON.stringify(westPx));
    ok("N: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("D") || want("W")) {
    const { page, errors } = await openFresh(ctx);
    // D1: the door picker clicked on the left wall at y 5 (open stretch): it lands on the wing's own wall, 10..30.
    await (await revealTool(page, /^Door wall$/)).click();
    await settle(page, 300);
    await clickSvg(page, { x: px(0), y: py(5) });
    await page.getByText("Acme Door", { exact: true }).first().click({ timeout: 10000 });
    await settle(page, 300);
    await page.getByRole("button", { name: "Place door" }).click();
    await settle(page, 600);
    let items = (await readItems(page)) || [];
    const d1 = items.find((i) => i.type === "fixtureDoor");
    const d1f = d1 && ft(d1);
    ok("D1: a door clicked on the left wall beside the open corner lands on the wing's stretch, never in the open", !!d1 && (d1.wall === "west" ? d1f.y - 1.5 >= 10 - 0.01 && d1f.y + 1.5 <= 30 + 0.01 : !inOpen(d1f.x - 1.5, d1f.y - 0.1, d1f.x + 1.5, d1f.y + 0.1)),
      JSON.stringify(d1 && { wall: d1.wall, ...d1f }));
    // D2: dragged along the north wall toward the open corner, it stops at x 8 + its half width.
    if (d1) {
      await drag(page, { x: d1.x, y: d1.y }, { x: px(14), y: py(0) });
      await drag(page, { x: px(14), y: py(0) }, { x: px(2), y: py(0) });
      items = (await readItems(page)) || [];
      const d2 = items.find((i) => i.id === d1.id), f2 = d2 && ft(d2);
      ok("D2: dragged along the north wall into the open corner, it stops against the face it meets (x 9.5), never past it",
        !!d2 && d2.wall === "north" && near(f2.x, 9.5, 0.05), JSON.stringify(d2 && { wall: d2.wall, ...f2 }));
      // W: the same door dragged down the left wall past the wing's south end: held at 30 - 1.5.
      await drag(page, { x: d2.x, y: d2.y }, { x: px(0), y: py(20) });
      await drag(page, { x: px(0), y: py(20) }, { x: px(0), y: py(37) });
      items = (await readItems(page)) || [];
      const d3 = items.find((i) => i.id === d1.id), f3 = d3 && ft(d3);
      ok("W1: dragged down the left wall past the wing's end, it is held on the wing's wall (y 28.5)", !!d3 && d3.wall === "west" && near(f3.y, 28.5, 0.05), JSON.stringify(d3 && { wall: d3.wall, ...f3 }));
    }
    ok("D: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("F")) {
    const { page, errors } = await openFresh(ctx);
    const before = ((await readItems(page)) || []).length;
    // F1: a loft clicked at y 5 would span the building wall to wall, over the open corner: refused.
    await (await revealTool(page, /Loft$/)).click();
    await settle(page, 300);
    await clickSvg(page, { x: px(16), y: py(5) });
    let items = (await readItems(page)) || [];
    ok("F1: a loft clicked across the open stretch is refused", !items.some((i) => i.type === "loft"), JSON.stringify(items.map((i) => i.type)));
    ok("F1: ...and says why", /open ground beside the wing/i.test(await toastText(page)));
    // F2: one clicked at y 20 (the wing's stretch, full width) is placed. A refusal leaves the tool armed.
    await settle(page, 4200);
    await clickSvg(page, { x: px(16), y: py(20) });
    items = (await readItems(page)) || [];
    const loft = items.find((i) => i.type === "loft");
    ok("F2: a loft across the wing's stretch is placed", !!loft, JSON.stringify(items.map((i) => i.type)));
    // F3: a partition clicked at y 5 crosses the open ground: refused; at y 20 it is placed.
    await settle(page, 4200);
    await (await revealTool(page, /Partition Wall/)).click();
    await settle(page, 300);
    await clickSvg(page, { x: px(16), y: py(5) });
    items = (await readItems(page)) || [];
    ok("F3: a partition across the open stretch is refused", !items.some((i) => i.type === "partitionWall"), JSON.stringify(items.map((i) => i.type)));
    ok("F3: ...and says why", /cross the open ground beside the wing/i.test(await toastText(page)));
    // F4: a bench placed on the north wall, dragged to the west wall's open stretch: held on the wing's stretch.
    await settle(page, 4200);
    await (await revealTool(page, /Workbench wall$/)).click();
    await settle(page, 300);
    await clickSvg(page, { x: px(16), y: py(0.5) });
    items = (await readItems(page)) || [];
    const bench = items.find((i) => i.type === "workbench");
    ok("F4: a bench on the north wall is placed clear of the open corner", !!bench && bench.wall === "north" && ft(bench).x - 2 >= 8 - 0.01, JSON.stringify(bench && { wall: bench.wall, ...ft(bench) }));
    if (bench) {
      await drag(page, { x: bench.x, y: bench.y }, { x: px(0.6), y: py(4) });
      items = (await readItems(page)) || [];
      const b2 = items.find((i) => i.id === bench.id), f = b2 && ft(b2);
      const b2Rect = b2 && (b2.wall === "west" ? [f.x - 1, f.y - 2, f.x + 1, f.y + 2] : [f.x - 2, f.y - 1, f.x + 2, f.y + 1]);
      ok("F4: dragged toward the open corner it never lands in it", !!b2 && !inOpen(...b2Rect), JSON.stringify(b2 && { wall: b2.wall, ...f }));
    }
    // F5: a ceiling light placed in the open corner: refused.
    await settle(page, 4200);
    await (await revealTool(page, /Electrical Items/)).click();
    await settle(page, 300);
    await page.getByText("Light", { exact: true }).first().click();
    await settle(page, 300);
    const nBefore = ((await readItems(page)) || []).length;
    await clickSvg(page, { x: px(4), y: py(5) });
    items = (await readItems(page)) || [];
    ok("F5: a light clicked in the open corner is refused", items.length === nBefore && !items.some((i) => i.electricalItemId === "e-lt"), JSON.stringify(items.map((i) => i.type)));
    ok("F5: ...with the open-ground sentence", /open ground beside the wing, outside the building/i.test(await toastText(page)));
    // F6: the 3D editor's place3: a loft across the open stretch and a light in it are refused there too.
    await open3D(page);
    const n0 = ((await readItems(page)) || []).length;
    await page.evaluate(({ x, y }) => window.__ss3dEngine.place3Wall("loft", x, y), { x: px(16), y: py(36) });
    await settle(page, 600);
    let it3 = (await readItems(page)) || [];
    ok("F6: place3 refuses a loft across the open stretch", !it3.some((i) => i.type === "loft" && ft(i).y > 33), JSON.stringify(it3.filter((i) => i.type === "loft").map(ft)));
    const flash = await page.evaluate(() => document.body.innerText);
    ok("F6: ...with a sentence", /open ground beside the wing/i.test(flash));
    const placedLight = await page.evaluate(({ x, y }) => (window.__ss3dEngine.place3Wall("e-lt", x, y), true), { x: px(4), y: py(35) });
    await settle(page, 600);
    it3 = (await readItems(page)) || [];
    ok("F7: place3 refuses a light in the open corner", placedLight && !it3.some((i) => i.electricalItemId === "e-lt" && inOpen(ft(i).x - 0.4, ft(i).y - 0.4, ft(i).x + 0.4, ft(i).y + 0.4)), String(it3.length - n0));
    // F8: the bench placed from 3D on the left wall in the open stretch is held on the wing's stretch.
    await page.evaluate(({ x, y }) => window.__ss3dEngine.place3Wall("workbench", x, y), { x: px(0.4), y: py(36) });
    await settle(page, 600);
    it3 = (await readItems(page)) || [];
    const benches = it3.filter((i) => i.type === "workbench");
    ok("F8: every bench placed from 3D stands clear of the open ground", benches.every((b) => {
      const f = ft(b);
      return !inOpen(...(b.wall === "west" || b.wall === "east" ? [f.x - 1, f.y - 2, f.x + 1, f.y + 2] : [f.x - 2, f.y - 1, f.x + 2, f.y + 1]));
    }), JSON.stringify(benches.map((b) => ({ wall: b.wall, ...ft(b) }))));
    ok("F: nothing anywhere stands in the open ground", ((await readItems(page)) || []).every((i) => {
      if (!i.x && i.x !== 0) return true;
      const f = ft(i), w = (i.widthFt || 1) / 2, h = (i.heightFt || 0.5) / 2;
      return i.type === "partitionWall" || !inOpen(f.x - w + 0.05, f.y - h + 0.05, f.x + w - 0.05, f.y + h - 0.05) || i.wall;
    }));
    ok("F: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    void before;
    await page.close();
  }

  if (want("C")) {
    // A door on the west wall at y 14: the wall is the wing's 10..30, so ⇔ Center puts it at 20.
    const door = { id: 1, type: "fixtureDoor", x: px(0), y: py(14), rotation: 90, wall: "west", widthFt: 3, heightFt: 0.5, fixtureItemId: "d-std", doorName: "Acme Door", planLabel: "DR",
      price: 300, widthIn: 36, heightIn: 80, swing: "out", operation: "right" };
    const north = { id: 2, type: "fixtureDoor", x: px(12), y: py(0), rotation: 0, wall: "north", widthFt: 3, heightFt: 0.5, fixtureItemId: "d-std", doorName: "Acme Door", planLabel: "DR",
      price: 300, widthIn: 36, heightIn: 80, swing: "out", operation: "right" };
    const { page, errors } = await openWith(ctx, [door, north]);
    await clickSvg(page, { x: door.x, y: door.y });
    const measure = page.getByRole("button", { name: /Measure/ }).first();
    if (await measure.count()) { await measure.click(); await settle(page, 300); }
    const chips = await page.evaluate(() => [...document.querySelectorAll("[data-ss-measure]")].map((g) => ({ k: g.getAttribute("data-ss-measure"), t: g.textContent })));
    ok("C1: the Measure chips read to the wing's ends (10 ft to 12'6\", then 14'6\" to 30 ft)", chips.length === 2 && chips.some((c) => c.k === "before" && c.t === "2'6\"") && chips.some((c) => c.k === "after" && c.t === "14'6\""), JSON.stringify(chips));
    await page.getByRole("button", { name: /Center/ }).first().click();
    await settle(page, 500);
    let items = (await readItems(page)) || [];
    const d1 = items.find((i) => i.id === 1);
    ok("C2: ⇔ Center puts it at the middle of the wing's wall (y 20)", !!d1 && near(ft(d1).y, 20, 0.02), JSON.stringify(d1 && ft(d1)));
    await clickSvg(page, { x: north.x, y: north.y });
    await page.getByRole("button", { name: /Center/ }).first().click();
    await settle(page, 500);
    items = (await readItems(page)) || [];
    const d2 = items.find((i) => i.id === 2);
    ok("C3: on the north wall, what is left is 8..24: centred at x 16, not the building's 12", !!d2 && near(ft(d2).x, 16, 0.02), JSON.stringify(d2 && ft(d2)));
    const centred = await page.evaluate(() => document.body.innerText.includes("✓ Centered"));
    ok("C3: ...and reads Centered there", centred);
    ok("C: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("P")) {
    // A partition wall across the wing's stretch (y 20, wall to wall), moved and stretched toward the open ground.
    const part = { id: 21, type: "partitionWall", axis: "x", atFt: 20, fromFt: 0, toFt: 24, heightIn: null, openings: [], wall: null, x: 0, y: 0 };
    const { page, errors } = await openWith(ctx, [part]);
    const pt = async () => ((await readItems(page)) || []).find((i) => i.id === 21);
    await clickSvg(page, { x: px(16), y: py(20) });
    await drag(page, { x: px(16), y: py(20) }, { x: px(16), y: py(5) });
    let p1 = await pt();
    // The drag follows the pointer up to the open stretch's edge and is refused past it: never in it.
    ok("P1: a wall-to-wall partition dragged across toward the open stretch stops at its edge, never in it", !!p1 && Number(p1.atFt) - 0.1875 >= 10 - 0.01 && Number(p1.atFt) < 20 && Number(p1.fromFt) === 0, JSON.stringify(p1 && [p1.atFt, p1.fromFt, p1.toFt]));
    ok("P1: ...and says why", /can't cross the open ground beside the wing/i.test(await toastText(page)));
    const end = page.locator('[data-ss-partition-end="from"]').first();
    if (await end.count()) {
      const b = await end.boundingBox(), to = await svgPoint(page, px(8), py(20));
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up(); await settle(page, 400);
    }
    p1 = await pt();
    ok("P2: its end pulled in to the face beside the open ground (x 8) is kept", !!p1 && near(Number(p1.fromFt), 8, 0.1), JSON.stringify(p1 && [p1.atFt, p1.fromFt, p1.toFt]));
    await clickSvg(page, { x: px(16), y: py(Number(p1.atFt)) });
    await drag(page, { x: px(16), y: py(Number(p1.atFt)) }, { x: px(16), y: py(5) });
    p1 = await pt();
    ok("P3: shortened clear of it, the same move across is allowed", !!p1 && near(Number(p1.atFt), 5, 0.6), JSON.stringify(p1 && [p1.atFt, p1.fromFt, p1.toFt]));
    const end2 = page.locator('[data-ss-partition-end="from"]').first();
    if (await end2.count()) {
      const b = await end2.boundingBox(), to = await svgPoint(page, px(2), py(Number(p1.atFt)));
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up(); await settle(page, 400);
    }
    const p4 = await pt();
    ok("P4: stretched back out into the open ground, its end is refused and stays at x 8", !!p4 && near(Number(p4.fromFt), 8, 0.1), JSON.stringify(p4 && [p4.atFt, p4.fromFt, p4.toFt]));
    ok("P: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("S")) {
    // Saved before the wing was shortened: a window on the west wall at y 4 and a loft in the open corner.
    const win = { id: 11, type: "window", x: px(0), y: py(4), rotation: 90, wall: "west", widthFt: 2, heightFt: 0.5, fixtureItemId: "w-std", windowName: "Acme Window", planLabel: "WN", price: 120, widthIn: 24, heightIn: 36 };
    const loft = { id: 12, type: "loft", x: px(4), y: py(35), rotation: 0, wall: null, widthFt: 8, heightFt: 4 };
    const keep = { id: 13, type: "window", x: px(24), y: py(20), rotation: 90, wall: "east", widthFt: 2, heightFt: 0.5, fixtureItemId: "w-std", windowName: "Acme Window", planLabel: "WN", price: 120, widthIn: 24, heightIn: 36 };
    const { page, errors } = await openWith(ctx, [win, loft, keep]);
    const items = (await readItems(page)) || [];
    ok("S1: nothing is moved", [win, loft, keep].every((o) => { const it = items.find((i) => i.id === o.id); return it && near(it.x, o.x, 0.01) && near(it.y, o.y, 0.01) && it.wall === o.wall; }), JSON.stringify(items.map((i) => [i.id, i.x, i.y])));
    const rings = await page.evaluate(() => [...document.querySelectorAll("[data-ss-open-item]")].map((r) => r.getAttribute("data-ss-open-item")).sort());
    ok("S2: the window and the loft out there are ringed, the east window is not", JSON.stringify(rings) === JSON.stringify(["11", "12"]), JSON.stringify(rings));
    const note = await page.locator("[data-ss-open-note]").first().innerText().catch(() => "");
    ok("S3: one sentence under the plan names them, says they are still on the estimate and the floor plan, and what to do",
      /Acme Window and Loft/.test(note) && /still on your estimate and your floor plan/.test(note) && /move them inside the walls or remove them/.test(note) && !/nothing is built/.test(note), note);
    await open3D(page);
    const built = await page.evaluate(() => window.__ss3dEngine.model.openingsGroup.children.filter((g) => g.userData && g.userData.itemId != null).map((g) => g.userData.itemId).sort());
    ok("S4: the window out in the open is not built in 3D; the east one is", JSON.stringify(built) === JSON.stringify([13]), JSON.stringify(built));
    ok("S: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("E")) {
    // The electrical package on the 24 x 40: every outlet it lays out stands on what is left of its wall, and every
    // light it hangs is over the floor, never out in the open ground (electricalAutoItems' o.notches).
    const { page, errors } = await openFresh(ctx);
    await (await revealTool(page, /Electrical Package/)).click();
    await settle(page, 800);
    const items = (await readItems(page)) || [];
    const isDev = (i, id) => i.type === id || i.electricalItemId === id;
    const outs = items.filter((i) => isDev(i, "e-out")), lights = items.filter((i) => isDev(i, "e-lt"));
    const SPAN = { north: [8, 24], south: [8, 24], west: [10, 30], east: [0, 40] };
    const offSpan = outs.filter((o) => { const f = ft(o), a = o.wall === "north" || o.wall === "south" ? f.x : f.y, s = SPAN[o.wall]; return !s || a < s[0] - 0.01 || a > s[1] + 0.01; });
    ok("E1: the package lays out outlets, every one on what is left of its wall", outs.length > 0 && offSpan.length === 0,
      JSON.stringify({ n: outs.length, off: offSpan.map((o) => ({ wall: o.wall, ...ft(o) })) }));
    ok("E2: ...and hangs its lights over the floor, none in the open ground", lights.length > 0 && lights.every((l) => { const f = ft(l); return !inOpen(f.x - 0.4, f.y - 0.4, f.x + 0.4, f.y + 0.4); }),
      JSON.stringify(lights.map(ft)));
    const ringed = await page.$$eval("[data-ss-open-item]", (r) => r.length);
    ok("E3: so nothing is ringed as outside the walls", ringed === 0, String(ringed));
    ok("E: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("R")) {
    // A 12 x 24 whose 8 ft left wing runs 10 ft, held 7 ft toward the front: the wing is y 14..24 and the open ground
    // x 0..8 over y 0..14, so the north wall keeps x 8..12 (4 ft) and the size's middle (6, 12) is open ground. The
    // builder's door rough opening is 6 ft wide.
    const W2 = 12, L2 = 24, SIZE2 = `${W2}x${L2}`, G2 = pageGeom(W2, L2);
    const px2 = (xFt) => G2.mgX + xFt * G2.scale, py2 = (yFt) => G2.mgY + yFt * G2.scale;
    const ft2 = (it) => ({ x: (it.x - G2.mgX) / G2.scale, y: (it.y - G2.mgY) / G2.scale });
    const inOpen2 = (x0, y0, x1, y1) => Math.min(x1, 8) - Math.max(x0, 0) > 0.01 && Math.min(y1, 14) - Math.max(y0, 0) > 0.01;
    const cfg2 = {
      ...CONFIG,
      buildingStyles: [{ ...CONFIG.buildingStyles[0], sizes: [SIZE2], d3: { ...D3_SPEC, roof: { ...ROOF, wingList: [{ wall: "left", widthFt: 8, lengthFt: 10, offsetFt: 7 }] } } }],
      defaultSizes: [SIZE2],
      sizePricing: { pw: { [SIZE2]: { widthFt: W2, lengthFt: L2, basePrice: 9000 } } },
      layoutItems: { ...CONFIG.layoutItems,
        roughOpeningDoor: { label: "Rough Opening (Door)", icon: "⬜", color: "#000000", width: 6, height: 0.5, shortLabel: "RO-D", wallOnly: true, wallSnap: false, group: "doors" } },
    };
    const { page, errors } = await openFresh(ctx, cfg2, SIZE2, L2);
    const notches = await page.$$eval("[data-ss-notch]", (g) => g.length);
    ok("R0: the plan draws the one open corner", notches === 1, String(notches));
    // R1: the Door tool on the north wall, the picker's Rough opening tile: 6 ft on a 4 ft wall is refused.
    await (await revealTool(page, /^Door wall$/)).click();
    await settle(page, 300);
    await clickSvg(page, { x: px2(10), y: py2(0) });
    await page.locator('[data-ss-ro-tile="door"]').click({ timeout: 10000 });
    await page.getByRole("button", { name: "Place rough opening" }).click();
    await settle(page, 500);
    let items = (await readItems(page)) || [];
    ok("R1: a 6 ft rough opening on the 4 ft north wall is refused from the door picker", !items.some((i) => i.type === "roughOpeningDoor"),
      JSON.stringify(items.map((i) => ({ type: i.type, wall: i.wall, ...ft2(i) }))));
    ok("R1: ...and says why", /wider than this wall/i.test(await toastText(page)));
    // R2: the same from the 3D editor (place3's wall built-ins).
    await settle(page, 4200);
    await open3D(page);
    await page.evaluate(({ x, y }) => window.__ss3dEngine.place3Wall("roughOpeningDoor", x, y), { x: px2(10), y: py2(0) });
    await settle(page, 600);
    items = (await readItems(page)) || [];
    ok("R2: place3 refuses it too", !items.some((i) => i.type === "roughOpeningDoor"), JSON.stringify(items.map((i) => ({ type: i.type, wall: i.wall, ...ft2(i) }))));
    ok("R2: ...with the sentence", /wider than this wall/i.test(await page.evaluate(() => document.body.innerText)));
    // R3: a stored item: its drop point (the size's middle, nudged) is open ground here, so it lands on the floor.
    await page.evaluate(() => window.__ss3dEngine.placeProp3("lawnmower"));
    await settle(page, 600);
    items = (await readItems(page)) || [];
    const prop = items.find((i) => i.type === "prop");
    const pf = prop && ft2(prop), hw = prop ? prop.widthFt / 2 : 0, hd = prop ? prop.heightFt / 2 : 0;
    ok("R3: a stored item added in 3D lands inside the walls, clear of the open ground",
      !!prop && !inOpen2(pf.x - hw, pf.y - hd, pf.x + hw, pf.y + hd) && pf.x - hw >= -0.01 && pf.x + hw <= W2 + 0.01 && pf.y - hd >= -0.01 && pf.y + hd <= L2 + 0.01,
      JSON.stringify(prop && { ...pf, w: prop.widthFt, d: prop.heightFt }));
    const ringed = await page.$$eval("[data-ss-open-item]", (r) => r.length);
    ok("R3: ...so the plan rings nothing", ringed === 0, String(ringed));
    ok("R: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(failed().length ? 1 : 0);
