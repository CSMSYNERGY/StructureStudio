// THE PLAN PAGE (renderExportCanvas): the Floorplan PDF preview and the plan page of the quote's PDF,
// driven on the COMPILED public designer (2026-10-21).
//
// Ahsan, on the beta Floorplan PDF preview: "i can not see properly when i clicked floor plan". A door's
// line in the list under the plan ran into the other column and off the page, and the wall labels
// ("5' TAD") were small and ran into each other. Every text the plan canvas draws is recorded (its
// string, font and transform, measured on the page), so the checks are numbers, not eyes:
//   B1 every line of the list stays in its own column and inside the page's margins
//   B2 no two texts of the band (name, contact, list) overlap
//   B3 the list ends above the page's bottom margin, however long it is
//   B4 a door with a transom says "with Transom Window" (and its pane count); a door with a panel
//      window says "with <window> in the upper panel"
//   L1 no two wall labels overlap, and none runs into the plan's dimension text
//   L2 the wall labels are drawn at 12px or more
//   P  the quote's PDF carries the plan page (its JPEG and the PDF itself are written out)
// Two designs: "normal" (two long-named doubles with transoms, a walk door with a panel window, a slider
// window flush in a corner beside a small window on the next wall, two more such, a loft, a bench, custom options) and "long"
// (the same plus 30 long custom options, which must lift the band, shrink it, or end on "+ N more").
// Pictures go to the shots folder as <TAG>-<design>-preview.png / -pdf-page.jpg / .pdf.
//
//   node tests/harness/planPage.mjs        (SS_BASE=http://127.0.0.1:<port>, SS_SHOTS=<dir>, TAG=<name>)
//
// Exit 0 = every check held. Supabase is stubbed at the network layer; nothing leaves the machine.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir, stubSupabase, collectErrors, readItems, buildingRect, bypassGate } from "./lib.mjs";
import { pickStyle } from "./gableProbe.mjs";

const { ok, failed } = reporter();
const shots = shotsDir("plan-page");
const TAG = process.env.TAG || "after";
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const W = 10, L = 12, SIZE = `${W}x${L}`, STYLE = "Plan Page Test";
const PAGE = { W: 850, H: 1100, TEXT_X: 36, TEXT_RIGHT: 814 };
const COL = (PAGE.TEXT_RIGHT - PAGE.TEXT_X) / 2;
const D3 = { roof: { type: "gable", pitch: 0.42, overhang: 0.8, eave: "fascia", ridgeOffset: 0 }, colors: { body: "#5b6770", roof: "#3a3d42", trim: "#efe6d2" },
  siding: "panel", foundation: "skids", roofMaterial: "metal", wallHeightFt: 8 };
const CONFIG = {
  clientId: "harness-plan-page",
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: [],
  buildingStyles: [{ value: "plan", label: STYLE, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3 }],
  defaultSizes: [SIZE],
  sizePricing: { plan: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } } },
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: false,
  layoutItems: {
    loft: { label: "Loft", icon: "⬆️", color: "#7C3AED", width: 6, height: 4, shortLabel: "LF", wallOnly: false, wallSnap: false, group: "interior" },
    workbench: { label: "Workbench", icon: "🔧", color: "#8B5E3C", width: 4, height: 2, depthIn: 24, shortLabel: "WB", wallOnly: false, wallSnap: true, group: "interior", modelKey: "wallBench", heightOffFloorIn: 36 },
  },
  layoutPricing: { loft: { rate: 6, method: "sqft_option" }, workbench: { rate: 12, method: "lineal_ft" } }, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};
const base = { category: "door", colorMode: "paint", hasTrimColor: true, imageUrl: null, opLeft: true, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right",
  swingIn: false, swingOut: true, swingDefault: null, sillIn: null, sillMode: "fixed", sortOrder: 0 };
const win = (id, name, planLabel, w, h, extra) => ({ id, category: "window", name, planLabel, price: 100, widthIn: w, heightIn: h, sortOrder: 0, colorMode: "fixed",
  hasTrimColor: false, imageUrl: null, sillIn: null, sillMode: "fixed", ...extra });
const FIX = [
  { ...base, id: "d-tad", name: "TEST 3D American Double", planLabel: "TAD", price: 900, widthIn: 60, heightIn: 72, opDouble: true, doorStyle: "american" },
  { ...base, id: "d-xwc", name: "Extra Wide Classic Double Door With A Long Name", planLabel: "XWC", price: 950, widthIn: 60, heightIn: 72, opDouble: true, doorStyle: "classic" },
  { ...base, id: "d-walk", name: "Classic Walk Door", planLabel: "CWD", price: 500, widthIn: 36, heightIn: 80, doorStyle: "classic" },
  win("w-top", "Transom", "TR", 24, 10, { inDoor: true, doorWindowAt: "top", panes: 3 }),
  win("w-lite", "Door lite", "DL", 18, 24, { inDoor: true, panes: 2 }),
  win("w-slider", "Slider Window", "SW", 48, 24),
  win("w-small", "Small Fixed Window", "SFW", 18, 18),
];
const FIXTURES = { items: FIX, windowColors: [], ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false } };
const fx = (id) => FIX.find((f) => f.id === id);
const stamp = (id) => { const w = fx(id); return { doorWindowId: w.id, doorWindowName: w.name, doorWindowWidthIn: w.widthIn, doorWindowHeightIn: w.heightIn, doorWindowPrice: w.price, doorWindowAt: w.doorWindowAt === "top" ? "top" : null }; };
const WHITE = { colorId: "c-white", colorLabel: "White", colorHex: "#ffffff", trimColorId: "c-white", trimColorLabel: "White", trimColorHex: "#ffffff" };
const OPTIONS = ["Ridge vent, full length", "Extra 2x4 floor joists at 12 in on centre", "Two coats of exterior paint on all trim", "Shelving, 3 ft deep, along the back wall"];
const MORE = Array.from({ length: 30 }, (_, i) => `Custom option ${i + 1}: a long builder-written line that names the work in plain words`);

async function rectOf(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  await bypassGate(page, CONFIG.clientId);
  await page.goto(`${BASE}/?client=${CONFIG.clientId}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 40000 });
  await pickStyle(page, STYLE);
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 20000 });
  await settle(page, 500);
  const rect = await buildingRect(page);
  await ctx.close();
  return rect;
}

function itemsFor(rect) {
  const s = rect.w / W, px = (ft) => rect.x + ft * s, py = (ft) => rect.y + ft * s;
  const pos = (wall, at) => wall === "north" ? { x: px(at), y: rect.y, rotation: 0 } : wall === "south" ? { x: px(at), y: rect.y + rect.h, rotation: 0 }
    : wall === "west" ? { x: rect.x, y: py(at), rotation: 90 } : { x: rect.x + rect.w, y: py(at), rotation: 90 };
  const door = (id, fxId, wall, at, op, glass) => { const f = fx(fxId);
    return { id, type: "fixtureDoor", ...pos(wall, at), wall, widthFt: f.widthIn / 12, heightFt: 0.5, fixtureItemId: f.id, doorName: f.name, planLabel: f.planLabel, price: f.price,
      widthIn: f.widthIn, heightIn: f.heightIn, swing: "out", operation: op, ...WHITE, sillMode: "fixed", ...stamp(glass) }; };
  const window = (id, fxId, wall, at) => { const f = fx(fxId);
    return { id, type: "window", ...pos(wall, at), wall, widthFt: f.widthIn / 12, heightFt: 0.5, fixtureItemId: f.id, windowName: f.name, planLabel: f.planLabel, price: f.price,
      widthIn: f.widthIn, heightIn: f.heightIn, sillFt: 3.5, sillMode: "fixed", colorId: "c-white", colorLabel: "White", colorHex: "#ffffff" }; };
  // Two corners where the labels of the two walls meet: a small window flush in the north-west corner
  // on each wall, and the slider flush in the south-east corner beside a small window on the front.
  return [
    door(801, "d-tad", "south", 2.5, "double", "w-top"),
    door(802, "d-xwc", "north", 5, "double", "w-top"),
    door(803, "d-walk", "west", 6, "right", "w-lite"),
    window(804, "w-slider", "east", 10),
    window(805, "w-small", "north", 0.75),
    window(806, "w-small", "west", 0.75),
    window(807, "w-small", "south", 9.25),
    { id: 808, type: "loft", x: px(5), y: py(5.5), rotation: 0, wall: null, widthFt: 10, heightFt: 4 },
    { id: 809, type: "workbench", x: px(6), y: py(10), rotation: 0, wall: null, widthFt: 4, heightFt: 2 },
  ];
}

// Every text the plan canvas (850 x 1100 at 2x) draws, with its font, alignment and transform; the quote's
// plan page as the browser encodes it; the PDF as it is uploaded.
const INIT = () => {
  window.__SS3D_DEBUG = true;
  window.__ssText = [];
  window.__ssPlanJpeg = null;
  const fill = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (t, x, y, ...rest) {
    if (this.canvas && this.canvas.width === 1700 && this.canvas.height === 2200) {
      const m = this.getTransform();
      window.__ssText.push({ t: String(t), x, y, font: this.font, align: this.textAlign, base: this.textBaseline, w: this.measureText(String(t)).width, m: [m.a, m.b, m.c, m.d, m.e, m.f] });
    }
    return fill.call(this, t, x, y, ...rest);
  };
  const enc = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...a) {
    const r = enc.apply(this, a);
    if (this.width === 1700 && this.height === 2200 && /jpeg/.test(String(a[0] || ""))) window.__ssPlanJpeg = r;
    return r;
  };
};

// A recorded text's box on the page (page px; the canvas draws at 2x).
function boxOf(r) {
  const px = Number((/(\d+(?:\.\d+)?)px/.exec(r.font) || [])[1]) || 10;
  const x0 = r.align === "center" ? r.x - r.w / 2 : r.align === "right" || r.align === "end" ? r.x - r.w : r.x;
  const [y0, y1] = r.base === "middle" ? [r.y - 0.5 * px, r.y + 0.5 * px] : r.base === "top" ? [r.y, r.y + px] : [r.y - 0.74 * px, r.y + 0.22 * px];
  const [a, b, c, d, e, f] = r.m;
  const pts = [[x0, y0], [x0 + r.w, y0], [x0, y1], [x0 + r.w, y1]].map(([x, y]) => [(a * x + c * y + e) / 2, (b * x + d * y + f) / 2]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { t: r.t, px, bold: /bold|700/.test(r.font), x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}
const overlap = (p, q, pad = 0.5) => p.x0 < q.x1 - pad && q.x0 < p.x1 - pad && p.y0 < q.y1 - pad && q.y0 < p.y1 - pad;

async function runDesign(browser, rect, key, extraOptions) {
  const items = itemsFor(rect);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(INIT);
  const code = `SS-HARNPP${key.toUpperCase().slice(0, 4)}`;
  const row = {
    short_code: code, status: "draft", selections: { style: "plan", size: SIZE, paint: "Painted", roofType: "Metal", roofColor: "Charcoal" }, items,
    contact: { name: "Pat Example", company: "Example Long Business Name Storage Buildings and Supply LLC", email: "pat.example@example.test", phone: "5550100100",
      street: "1234 Long Country Road", city: "Springfield", state: "OH", zip: "45501" },
    paint_colors: { body: "Barn Red", trim: "White" }, custom_options: OPTIONS.concat(extraOptions).map((name) => ({ name, qty: "" })), ro_dimensions: {},
  };
  const uploads = [];
  await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [row] } });
  await page.route(`**/${REF}.supabase.co/storage/v1/**`, (route) => {
    const req = route.request(), hdr = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: hdr, body: "" });
    let bytes = null;
    try { bytes = req.postDataBuffer(); } catch (_e) { bytes = null; }
    uploads.push({ path: new URL(req.url()).pathname, bytes });
    return route.fulfill({ status: 200, contentType: "application/json", headers: hdr, body: JSON.stringify({ Key: "floor-plans/harness.pdf", Id: "1" }) });
  });
  await bypassGate(page, CONFIG.clientId);
  await page.goto(`${BASE}/?client=${CONFIG.clientId}&id=${code}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  for (let k = 0; k < 60; k++) { await settle(page, 500); if ((((await readItems(page)) || []).length) >= items.length) break; }
  await settle(page, 800);
  const tag = `${key}:`;

  // The Floorplan PDF preview.
  await page.evaluate(() => { window.__ssText = []; });
  await page.locator("button.ssd-ft-pdf").first().click();
  const img = page.locator('img[alt="Floor Plan"]').first();
  await img.waitFor({ state: "visible", timeout: 30000 });
  const src = await img.getAttribute("src");
  if (src && src.startsWith("data:image/png;base64,")) writeFileSync(join(shots, `${TAG}-${key}-preview.png`), Buffer.from(src.split(",")[1], "base64"));
  await page.screenshot({ path: join(shots, `${TAG}-${key}-preview-modal.png`) });
  const recs = await page.evaluate(() => window.__ssText);
  const boxes = recs.map(boxOf);

  // The band: from its first text (the customer's name, or the size + style on its right) to the end.
  const sizeStyle = `${W}×${L}  plan`;
  const first = boxes.findIndex((b) => b.t === sizeStyle || b.t.startsWith("Example Long"));
  const band = first >= 0 ? boxes.slice(first) : [];
  const list = band.filter((b) => !b.bold && b.px <= 13 && b.y0 > band[0].y1 + 30 && b.t !== "•");
  const out = list.filter((b) => (b.x0 < PAGE.TEXT_X + COL - 2 ? b.x1 > PAGE.TEXT_X + COL - 2 : b.x1 > PAGE.TEXT_RIGHT + 1) || b.x0 < PAGE.TEXT_X - 1);
  ok(`B1 ${tag} every line of the list stays in its column (${list.length} lines)`, list.length > 0 && out.length === 0,
    out.slice(0, 3).map((b) => `"${b.t.slice(0, 40)}…" ${b.x0.toFixed(0)}..${b.x1.toFixed(0)}`).join(" | "));
  const clash = [];
  band.forEach((p, i) => band.slice(i + 1).forEach((q) => { if (overlap(p, q)) clash.push(`"${p.t.slice(0, 24)}" × "${q.t.slice(0, 24)}"`); }));
  ok(`B2 ${tag} no two texts of the band overlap`, band.length > 0 && clash.length === 0, clash.slice(0, 3).join(" | "));
  const lowest = Math.max(...band.map((b) => b.y1)), offPage = boxes.filter((b) => b.x0 < 0 || b.x1 > PAGE.W || b.y0 < 0 || b.y1 > PAGE.H);
  ok(`B3 ${tag} the list ends above the page's bottom margin (${lowest.toFixed(0)} of ${PAGE.H}), nothing past the page's edge`, lowest <= PAGE.H - 8 && offPage.length === 0,
    offPage.slice(0, 3).map((b) => `"${b.t.slice(0, 30)}"`).join(" | "));
  // Joined back into whole bullets: a wrapped bullet's later lines follow its first.
  const text = list.map((b) => b.t).join(" ");
  ok(`B4 ${tag} the transom doors say "with Transom Window, 3 panes"; the walk door "with Door lite in the upper panel, 2 panes"`,
    (text.match(/with Transom Window, 3 panes/g) || []).length === 2 && /with Door lite in the upper panel, 2 panes/.test(text), text.slice(0, 400));
  if (key === "long") {
    const more = list.find((b) => /^\+ \d+ more$/.test(b.t));
    const sep = band[0].y0 - 24;
    console.log(`  long: band top ~${sep.toFixed(0)} (normally 760), list font ${list[0] ? list[0].px : "?"}px, ${more ? more.t : "every line shown"}`);
  }
  // The wall items' own labels: the width, then the plan label ("5' TAD", `1'6" SFW @ 3'6"`).
  const labels = boxes.filter((b) => /^\d+'(\d+")? (TAD|XWC|CWD|SW|SFW)\b/.test(b.t));
  // ...each whole, inside the plan's outline: the side dimensions ("12 ft", turned) stand 20 px left of
  // the west wall and 24 px right of the east wall (renderExportCanvas).
  const sides = boxes.filter((b) => /^\d+ ft$/.test(b.t) && b.y1 - b.y0 > b.x1 - b.x0).map((b) => (b.x0 + b.x1) / 2).sort((p, q) => p - q);
  const wx0 = sides.length === 2 ? sides[0] + 20 : 0, wx1 = sides.length === 2 ? sides[1] - 24 : PAGE.W;
  const cut = labels.filter((b) => b.x0 < wx0 + 1 || b.x1 > wx1 - 1);
  ok(`L3 ${tag} every wall label sits inside the plan's outline (none runs over an end wall)`, sides.length === 2 && labels.length > 0 && cut.length === 0,
    cut.map((b) => `"${b.t}" ${b.x0.toFixed(0)}..${b.x1.toFixed(0)} vs walls ${wx0.toFixed(0)}..${wx1.toFixed(0)}`).join(" | "));
  const dims = boxes.filter((b) => /^\d+ ft$/.test(b.t));
  const lc = [];
  labels.forEach((p, i) => labels.slice(i + 1).concat(dims).forEach((q) => { if (overlap(p, q)) lc.push(`"${p.t}" × "${q.t}"`); }));
  ok(`L1 ${tag} no two wall labels overlap, nor the dimensions (${labels.length} labels)`, labels.length >= 7 && lc.length === 0, lc.slice(0, 4).join(" | "));
  ok(`L2 ${tag} the wall labels are 12px or more`, labels.length > 0 && labels.every((b) => b.px >= 12), [...new Set(labels.map((b) => b.px))].join(","));

  // The quote's PDF.
  await page.locator("h3").filter({ hasText: "Floorplan PDF" }).locator("xpath=..").locator("button").first().click().catch(() => {});
  await settle(page, 600);
  const submit = page.getByRole("button", { name: /^(Get Estimate|Resubmit for Updated Estimate)$/ }).last();
  if (await submit.count()) await submit.click().catch(() => {});
  let jpeg = null;
  for (let k = 0; k < 120 && !(jpeg && uploads.some((u) => u.path.endsWith(".pdf"))); k++) { await settle(page, 500); jpeg = await page.evaluate(() => window.__ssPlanJpeg); }
  const pdf = uploads.filter((u) => u.path.endsWith(".pdf") && u.bytes).pop();
  if (jpeg) writeFileSync(join(shots, `${TAG}-${key}-pdf-page.jpg`), Buffer.from(jpeg.split(",")[1], "base64"));
  if (pdf) writeFileSync(join(shots, `${TAG}-${key}.pdf`), pdf.bytes);
  ok(`P ${tag} the quote's PDF went up with the plan page in it`, !!jpeg && !!pdf && pdf.bytes.length > 20000, `${jpeg ? jpeg.length : 0} / ${pdf ? pdf.bytes.length : 0}`);
  ok(`${tag} no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

async function main() {
  const { browser } = await launch({ width: 1280, height: 900 });
  const rect = await rectOf(browser);
  await runDesign(browser, rect, "normal", []);
  await runDesign(browser, rect, "long", MORE);
  await browser.close();
  const fl = failed();
  console.log(fl.length ? `${fl.length} FAILED` : "ALL CHECKS PASSED");
  process.exit(fl.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
