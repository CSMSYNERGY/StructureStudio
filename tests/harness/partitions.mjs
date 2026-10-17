// Partition walls (migration 278), driven for real on the COMPILED designer and the COMPILED portal,
// with every Supabase call answered locally.
//
// A builder asked for a wall inside the building that can hold a door or a window; until now they drew
// one with a Line and a Note. What is proved:
//
//   A. A DESIGN WITH NO PARTITION IS UNTOUCHED: the plan's svg markup and the Floorplan PDF image are
//      captured for a saved design with doors, a window, a loft, a workbench, a note and a line, on a
//      tenant that OFFERS partition walls. SS_PARTITIONS_SNAPSHOT=<file> writes them; with
//      SS_PARTITIONS_BASELINE=<file> (the same capture from the tree before this change) they must be
//      byte-identical. SS_PARTITIONS_ONLY_A=1 runs nothing else, for the baseline run on the old tree.
//      A1 also proves the public page offers the "Interior wall" button under Interior.
//   B. PLACE: the button, then a click inside the building, puts a wall ACROSS the short span, wall
//      to wall, at the click, at stud wall height, and selects it. No framing control for someone
//      without the price-override grant (B3).
//   C. MOVE: dragging the wall moves it across the building, to the inch.
//   D. STRETCH: an end grip shortens it; dragged near the wall again it lands on the wall.
//   E. HEIGHT: Custom gives it a height in inches; a typed height sticks; Stud wall height goes back.
//      Once a door is in it (after F), a typed height refused back to the one it has shows that
//      height (E4).
//   F. + DOOR: the door picker (floor-standing doors only: the loft door is not offered) puts the door
//      IN the wall, centred; it slides along the wall; Flip swing turns it; + Window adds a window at
//      the nearest free spot; a window dragged onto the door is refused, with a reason.
//   G. DETAILS: one row for the wall (12' long at the builder's per-foot rate) and one for the door at
//      its catalog price.
//   H. PDF: the Floorplan PDF draws the wall (its colour on the wall line, not beside it) and the door.
//   I. 3D: the editor builds the wall — one group, no itemId (the 3D editor cannot pick it), full height,
//      wall to wall — and does not offer it in the 3D palette. A "Look inside" shot.
//   J. QUOTE: Get Quote sends itemSummary.partitions with the length, the height and the door by its
//      catalog id, and floorPlanItems carries the wall with no `wall`.
//   K. THE PORTAL (312): Interior items no longer lists the wall and its Save never sends one; the
//      Interior walls tab shows the seeded 2x4 rate, sends the framing, the door/window and electrical
//      ticks and the ordered coverings on Save, and refuses a blank standard rate before sending.
//      Every catalog read asks for the unpriced items (withUnpriced).
//   M. INTERIOR WALLS V2 (2026-10-17), on a rep's designer (canOverridePrice): press-drag draws a wall
//      that snaps to 45 degrees; with Shift it keeps its own angle; a wall drawn up to another's body
//      lands on it (a T); every wall is two parallel lines turned to its angle on the plan, and the PDF
//      draws the diagonal along its own line; the rep sees "Framing 2x4 / 2x6" and 2x6 sticks.
//   N. TO THE RAFTERS under the style's gable: the 3D wall's top follows the roof's underside along
//      its whole length (no gap, no poke-through) and, under a loft on the plate, stops at the loft's
//      floor framing; its per-sq-ft Details row is the true face area.
//   O. DOORS AND WINDOWS IN THE PARTITION'S OWN THICKNESS (2026-10-17): a saved design with a diagonal
//      2x4 wall (a plank door, a Classic trim door and a window) and a straight 2x6 wall (a roll-up, a
//      double plank door and a window). In 3D every opening's door or window (leaf, hardware, sash,
//      glass) lies within the wall's thickness and is centred on its line, and its casing within the
//      thickness plus the casing's own reach; shots from both faces and from above.
//      SS_PARTITIONS_ONLY_O=1 runs only this (and L).
//   L. zero page errors.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/partitions.mjs        (SS_BASE=http://127.0.0.1:<port> to move it)
//
// Exit 0 = every assertion held. NOTHING LEAVES THE MACHINE (lib.mjs stubSupabase). Tenants and
// catalog rows are made up; the repo is public.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir, revealTool, BASE, REF,
} from "./lib.mjs";

const CLIENT = "harness-partitions";
const CODE = "SS-HARNESSPW1";
const W = 12, L = 32, SIZE = `${W}x${L}`, WALL_FT = 7.5;
const PARTITION_COLOR = "#57534E";
const D3_SPEC = {
  roof: { eave: "fascia", type: "gable", pitch: 0.42, overhang: 0.8, ridgeOffset: 0 },
  colors: { body: "#7a4a35", roof: "#5f6266", trim: "#efe9dc" }, siding: "batten", foundation: "skids", wallHeightFt: WALL_FT,
};
export const CONFIG = {
  clientId: CLIENT,
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  // [] unlocks Details and Get Quote with no typing (contactComplete short-circuits on an empty list).
  contactFields: [],
  buildingStyles: [{ value: "plain", label: "Gable Cabin", img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3_SPEC }],
  defaultSizes: [SIZE],
  sizePricing: { plain: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } } },
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: true,
  // As get_config sends them after migration 278, with the builder's partition rate set.
  layoutItems: {
    partitionWall: { label: "Partition Wall", icon: "🧱", color: PARTITION_COLOR, width: 4, height: 0.375, shortLabel: "PART", wallOnly: false, wallSnap: false, group: "interior", modelKey: "partition" },
    loft: { label: "Loft", icon: "⬆️", color: "#7C3AED", width: 6, height: 4, shortLabel: "LF", wallOnly: false, wallSnap: false, group: "interior" },
    workbench: { label: "Workbench", icon: "🔧", color: "#8B5E3C", width: 4, height: 2, shortLabel: "WB", wallOnly: false, wallSnap: true, group: "interior", modelKey: "wallBench", heightOffFloorIn: 36 },
  },
  layoutPricing: { partitionWall: { rate: 22, method: "lineal_ft" }, loft: { rate: 6, method: "sqft_option" }, workbench: { rate: 12, method: "lineal_ft" } },
  layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};
// The same tenant once the Interior walls tab exists: 2x4 the standard at the 278 row's $22 a foot,
// 2x6 offered at $28. B-J use it, so the framing control has two sizes to offer (and must still be
// hidden there: that designer has no price-override grant).
export const CONFIG_IW = {
  ...CONFIG,
  interiorWalls: { offered: true, standardStud: "2x4", method: "lineal_ft", standardHeight: "plate", allowRafters: true, allowRo: true,
    studs: { "2x4": { rate: 22 }, "2x6": { rate: 28 } }, coverings: [] },
};
const fx = (o) => ({ colorMode: "fixed", sortOrder: 0, imageUrl: null, opLeft: false, opRight: false, opDouble: false, opSlideUp: false, opDefault: null,
  swingIn: false, swingOut: false, swingDefault: null, hasTrimColor: false, sillIn: null, ...o });
export const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false },
  items: [
    fx({ id: "d-int", name: "Interior Door", category: "door", price: 300, widthIn: 36, heightIn: 80, planLabel: "INT", swingIn: true, swingOut: true, swingDefault: "out", opLeft: true, opRight: true, opDefault: "left" }),
    fx({ id: "d-loft", name: "Loft Door", category: "door", price: 260, widthIn: 36, heightIn: 48, planLabel: "LOFT", sillIn: 90 }),
    fx({ id: "w-23", name: "2x3 Window", category: "window", price: 120, widthIn: 24, heightIn: 36, planLabel: "W23", sillIn: 42 }),
  ],
  windowColors: [],
};

// pageGeom(12, 32): scale 16.625 px a foot, the building's corner at (325.25, 63.25).
const SC = 16.625, MX = 325.25, MY = 63.25;
const A_ITEMS = [
  { id: 101, type: "singleDoor", x: MX + 3 * SC, y: MY + L * SC, rotation: 0, wall: "south", widthFt: 3, heightFt: 0.5 },
  { id: 102, type: "fixtureDoor", x: MX + 6 * SC, y: MY, rotation: 0, wall: "north", widthFt: 3, heightFt: 0.5, fixtureItemId: "d-int", doorName: "Interior Door", planLabel: "INT",
    price: 300, widthIn: 36, heightIn: 80, swing: "out", operation: "right" },
  { id: 103, type: "window", x: MX + W * SC, y: MY + 10 * SC, rotation: 90, wall: "east", widthFt: 2, heightFt: 0.5, fixtureItemId: "w-23", windowName: "2x3 Window", planLabel: "W23",
    price: 120, widthIn: 24, heightIn: 36 },
  { id: 104, type: "loft", x: MX + 6 * SC, y: MY + 2 * SC, rotation: 0, wall: null, widthFt: 12, heightFt: 4 },
  { id: 105, type: "workbench", x: MX + SC, y: MY + 20 * SC, rotation: 90, wall: "west", widthFt: 4, heightFt: 2 },
  { id: 106, type: "textNote", x: 150, y: 300, rotation: 0, wall: null, widthPx: 160, heightPx: 40, text: "Tack room" },
  { id: 107, type: "line", wall: null, x1: 400, y1: 450, x2: 480, y2: 450 },
];
const designRow = (items) => ({
  short_code: CODE, client_id: CLIENT, status: "draft", version: 1,
  selections: { style: "plain", size: SIZE, roofType: "", roofColor: "", cladding: "" },
  items, paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
  contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100", street: "", city: "", state: "", zip: "" },
  bldg_w: W, bldg_h: L,
});

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const partitions = async (page) => ((await readItems(page)) || []).filter((i) => i.type === "partitionWall");

/** The plan svg's markup, and the Floorplan PDF's image (the export modal's PNG). */
async function captureAB(page) {
  const svg = await page.evaluate(() => {
    const s = [...document.querySelectorAll("svg")].find((el) => [...el.querySelectorAll("rect")].some((r) => r.getAttribute("stroke") === "#1E293B"));
    return s ? s.outerHTML : null;
  });
  await page.locator(".ssd-ft-pdf").first().click();
  const img = page.locator('img[alt="Floor Plan"]').first();
  await img.waitFor({ state: "visible", timeout: 30000 });
  const png = await img.getAttribute("src");
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator("h3").filter({ hasText: "Floorplan PDF" }).locator("xpath=..").locator("button").first().click().catch(() => {});
  await settle(page, 300);
  return { svg, png };
}

/** One pixel of a PNG data URL, at page coordinates (the export is drawn at 2x). */
async function pixelAt(page, dataUrl, x, y) {
  return page.evaluate(async ({ dataUrl, x, y }) => {
    const im = new Image(); im.src = dataUrl; await im.decode();
    const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
    const g = c.getContext("2d"); g.drawImage(im, 0, 0);
    return Array.from(g.getImageData(Math.round(x * 2), Math.round(y * 2), 1, 1).data.slice(0, 3));
  }, { dataUrl, x, y });
}
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const close = (a, b, tol = 24) => a.every((v, k) => Math.abs(v - b[k]) <= tol);
/** A wall drawn as two parallel lines: some pixel within 5 page px of (x, y), stepping along the
 *  normal (nx, ny), is the wall's colour. The pixel found, or null. */
async function lineNear(page, dataUrl, x, y, nx, ny, hex, tol = 40) {
  return page.evaluate(async ({ dataUrl, x, y, nx, ny, want, tol }) => {
    const im = new Image(); im.src = dataUrl; await im.decode();
    const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
    const g = c.getContext("2d"); g.drawImage(im, 0, 0);
    for (let k = -10; k <= 10; k++) {
      const px = Array.from(g.getImageData(Math.round((x + nx * k / 2) * 2), Math.round((y + ny * k / 2) * 2), 1, 1).data.slice(0, 3));
      if (px.every((v, i) => Math.abs(v - want[i]) <= tol)) return px;
    }
    return null;
  }, { dataUrl, x, y, nx, ny, want: hexRgb(hex), tol });
}

/** The portal's mount, minus the portal: the vendored libraries and the compiled component, the way
 *  portal.html loads them, and one <StructureStudio embedded …/> opening `CODE`. */
function embeddedPage(extra = {}) {
  const idx = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const buster = (/structure-studio\.component\.compiled\.js\?v=([a-f0-9]+)/.exec(idx) || [])[1] || "x";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0"><div id="root"></div>
<script src="/vendor/react-18.2.0.production.min.js"></script>
<script src="/vendor/react-dom-18.2.0.production.min.js"></script>
<script src="/vendor/supabase-js-2.112.1.umd.min.js"></script>
<script src="/structure-studio.component.compiled.js?v=${buster}"></script>
<script>
  window.__ssAppBooted = true;
  window.__SS3D_DEBUG = true;
  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(window.StructureStudio, {
    clientId: ${JSON.stringify(CLIENT)}, embedded: true, view3d: true,
    openDesign: { code: ${JSON.stringify(CODE)}, clientId: ${JSON.stringify(CLIENT)} }, ...${JSON.stringify(extra)},
  }));
</script></body></html>`;
}

async function drag(page, from, to, steps = 10) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  await settle(page, 350);
}
const centerOf = async (loc) => { const b = await loc.boundingBox(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; };

const { ok, failed } = reporter();
const shots = shotsDir("partitions");
const run = async () => {
  const { browser, ctx } = await launch({ width: 1440, height: 1100 });
  const allErrors = [];
  try {
    // ── A. A design with no partition, on a tenant that offers them ───────────────────────────
    {
      const page = await ctx.newPage();
      const errors = collectErrors(page);
      await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [designRow(A_ITEMS)] } });
      await openDesigner(page, CLIENT);
      await page.goto(`${BASE}/?client=${CLIENT}&id=${CODE}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
      await page.waitForFunction(() => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === "32 ft"), null, { timeout: 30000 });
      await settle(page, 1500);
      const snap = await captureAB(page);
      ok("A0 the plan svg and the Floorplan PDF were captured", !!snap.svg && /^data:image\/png;base64,/.test(snap.png || ""));
      const out = { svgSha: sha(snap.svg || ""), pngSha: sha(snap.png || ""), svg: snap.svg };
      if (process.env.SS_PARTITIONS_SNAPSHOT) writeFileSync(process.env.SS_PARTITIONS_SNAPSHOT, JSON.stringify(out));
      if (process.env.SS_PARTITIONS_BASELINE) {
        const base = JSON.parse(readFileSync(process.env.SS_PARTITIONS_BASELINE, "utf8"));
        ok("A2 no partition: the plan svg is byte-identical to the tree before this change", base.svgSha === out.svgSha, `${base.svgSha.slice(0, 12)} vs ${out.svgSha.slice(0, 12)}`);
        ok("A3 no partition: the Floorplan PDF image is byte-identical to the tree before this change", base.pngSha === out.pngSha, `${base.pngSha.slice(0, 12)} vs ${out.pngSha.slice(0, 12)}`);
      }
      if (!process.env.SS_PARTITIONS_ONLY_A) {
        const btn = await revealTool(page, /Interior wall/);
        ok("A1 the public designer offers the Interior wall button (under Interior)", await btn.isVisible().catch(() => false));
      }
      allErrors.push(...errors.map((e) => "A: " + e));
      await page.close();
    }
    if (process.env.SS_PARTITIONS_ONLY_A) return;
    if (process.env.SS_PARTITIONS_ONLY_O) { await openingsRun(ctx, ok, shots, allErrors); ok("L zero page errors", allErrors.length === 0, allErrors.slice(0, 5).join(" | ")); return; }

    // ── B-J. The portal's designer, a blank 12 x 32 ──────────────────────────────────────────
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    const calls = await stubSupabase(page, { config: CONFIG_IW, fixtures: FIXTURES, rpc: { load_design: [designRow([])] } });
    await page.route(`**/${REF}.supabase.co/storage/v1/**`, (route) => {
      const hdr = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: hdr, body: "" });
      return route.fulfill({ status: 200, contentType: "application/json", headers: hdr, body: JSON.stringify({ Key: "floor-plans/harness.pdf", Id: "1" }) });
    });
    const url = `${BASE}/__harness_partitions.html`;
    await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html", body: embeddedPage() }));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === "32 ft"), null, { timeout: 60000 });
    await settle(page, 1500);
    const r = await buildingRect(page);
    const sc = r.w / W;
    const at = (xFt, yFt) => svgPoint(page, r.x + xFt * sc, r.y + yFt * sc);

    // B. place
    await (await revealTool(page, /Interior wall/)).click();
    await settle(page, 250);
    const hint = await page.locator(".ssd-tb-hint").first().innerText().catch(() => "");
    ok("B0 the armed tool says where to click", /inside the building/.test(hint), hint);
    const p0 = await at(5, 12.04);
    await page.mouse.click(p0.x, p0.y);
    await settle(page);
    let ps = await partitions(page);
    ok("B1 one partition, across the short span, wall to wall, at the click to the inch, at stud wall height",
      ps.length === 1 && ps[0].x1Ft === 0 && near(ps[0].y1Ft, 12) && ps[0].x2Ft === 12 && near(ps[0].y2Ft, 12) && ps[0].heightMode === "plate"
        && ps[0].heightIn === null && ps[0].stud === null && ps[0].wall === null,
      JSON.stringify(ps[0]));
    const selTxt = await page.locator(".ssd-tb").first().innerText().catch(() => "");
    ok("B2 ...and it is selected, with its controls in the toolbar", /Selected: Interior wall/i.test(selTxt) && /Stud wall height/.test(selTxt) && /To the rafters/.test(selTxt) && /\+ Door/.test(selTxt), selTxt.replace(/\s+/g, " ").slice(0, 200));
    ok("B3 ...and no framing control: this designer has no price-override grant (a customer never sees it)",
      (await page.locator("[data-ss-partition-stud]").count()) === 0 && !/Framing 2x6/.test(selTxt));

    // C. move it across the building
    await drag(page, await at(1, 12), await at(1, 16.5));
    ps = await partitions(page);
    ok("C1 dragging the wall moves it across the building, to the inch", near(ps[0].y1Ft, 16.5, 1 / 12 + 1e-6) && ps[0].y2Ft === ps[0].y1Ft && ps[0].x1Ft === 0 && ps[0].x2Ft === 12, JSON.stringify(ps[0]));
    const atFt = ps[0].y1Ft;

    // D. stretch
    await drag(page, await centerOf(page.locator('[data-ss-partition-end="to"]').first()), await at(8, atFt));
    ps = await partitions(page);
    ok("D1 the end grip shortens it", near(ps[0].x2Ft, 8, 1 / 12 + 1e-6) && ps[0].y2Ft === atFt, `${ps[0].x2Ft}, ${ps[0].y2Ft}`);
    await drag(page, await centerOf(page.locator('[data-ss-partition-end="to"]').first()), await at(11.7, atFt));
    ps = await partitions(page);
    ok("D2 dragged back near the wall it lands ON the wall", ps[0].x2Ft === 12 && ps[0].y2Ft === atFt, `${ps[0].x2Ft}, ${ps[0].y2Ft}`);

    // E. height
    await page.getByRole("button", { name: "Custom" }).first().click();
    await settle(page, 300);
    ps = await partitions(page);
    ok("E1 Custom gives it a height in inches (a foot under the 7'6\" wall)", ps[0].heightMode === "custom" && ps[0].heightIn === 78, String(ps[0].heightIn));
    await page.locator("[data-ss-partition-height]").fill("84");
    await page.locator("[data-ss-partition-height]").press("Enter");
    await settle(page, 300);
    ps = await partitions(page);
    ok("E2 a typed height sticks", ps[0].heightIn === 84, String(ps[0].heightIn));
    await page.getByRole("button", { name: "Stud wall height" }).first().click();
    await settle(page, 300);
    ps = await partitions(page);
    ok("E3 Stud wall height goes back to the wall's own height", ps[0].heightMode === "plate" && ps[0].heightIn === null, `${ps[0].heightMode} ${ps[0].heightIn}`);

    // F. + Door, slide, flip, + Window, overlap refused
    await page.getByRole("button", { name: "+ Door" }).first().click();
    await settle(page, 400);
    const picker = await page.locator("body").innerText();
    ok("F0 the door picker offers floor-standing doors only (no loft door)", picker.includes("Interior Door") && !picker.includes("Loft Door"));
    await page.getByRole("button", { name: "Place door" }).click();
    await settle(page, 400);
    ps = await partitions(page);
    const d0 = ps[0].openings && ps[0].openings[0];
    ok("F1 the door is IN the wall, centred, by its catalog id, with its price snapshot",
      ps[0].openings.length === 1 && d0.kind === "door" && d0.fixtureItemId === "d-int" && d0.centerFt === 6 && d0.price === 300 && d0.widthIn === 36, JSON.stringify(d0));
    ok("F1b ...and no door item was placed on any wall", ((await readItems(page)) || []).every((i) => i.type !== "fixtureDoor"));
    await drag(page, await at(6, atFt), await at(8.5, atFt));
    ps = await partitions(page);
    ok("F2 the door slides along the wall, to the inch", near(ps[0].openings[0].centerFt, 8.5, 1 / 12 + 1e-6), String(ps[0].openings[0].centerFt));
    const swing0 = ps[0].openings[0].swing;
    await page.getByRole("button", { name: /Flip swing/ }).first().click();
    await settle(page, 300);
    ps = await partitions(page);
    ok("F3 Flip swing turns the door into the other room", ps[0].openings[0].swing !== swing0 && ["in", "out"].includes(ps[0].openings[0].swing), `${swing0} -> ${ps[0].openings[0].swing}`);
    await page.screenshot({ path: join(shots, "F-plan-partition-door.png") });
    await page.locator("svg").filter({ has: page.locator('rect[stroke="#1E293B"]') }).first().screenshot({ path: join(shots, "F-plan-only.png") });
    await page.getByRole("button", { name: "+ Window" }).first().click();
    await settle(page, 400);
    await page.getByRole("button", { name: "Place window" }).click();
    await settle(page, 400);
    ps = await partitions(page);
    const win = ps[0].openings.find((o) => o.kind === "window");
    // The middle (6 ft) is 2'6" from the door at 8'6"; a 2 ft window and a 3 ft door need 2'10½" between
    // centres (half of each plus 4½ in for two casings), so the nearest free spot on the inch is 5'7".
    ok("F4 the window goes in at the free spot nearest the middle", !!win && near(win.centerFt, 6 - 5 / 12, 1e-6) && win.fixtureItemId === "w-23", JSON.stringify(win));
    const winAt = win ? win.centerFt : 0;
    await drag(page, await at(winAt, atFt), await at(8.5, atFt));
    const toast = await page.locator("body").innerText();
    ps = await partitions(page);
    ok("F5 a window dragged onto the door is refused, and says why",
      toast.includes("can't overlap") && ps[0].openings.find((o) => o.kind === "window").centerFt <= 8.5 - 2.875 + 1e-6, `window at ${ps[0].openings.find((o) => o.kind === "window").centerFt}`);
    ok("F5b ...it stopped short of the door, not on it", ps[0].openings.find((o) => o.kind === "window").centerFt >= winAt);

    // E4. A height refused back to the one the wall already has. Custom, with an 80 in door in the wall,
    // lands on 83 in (the door plus a 3 in header); 70 typed is refused and clamped to the same 83,
    // which changes nothing on the plan, so the field must show 83 again rather than keep the 70.
    await page.getByRole("button", { name: "Custom" }).first().click();
    await settle(page, 300);
    ps = await partitions(page);
    const keptIn = ps[0].heightIn;
    await page.locator("[data-ss-partition-height]").fill("70");
    await page.locator("[data-ss-partition-height]").press("Enter");
    await settle(page, 300);
    ps = await partitions(page);
    const shownIn = await page.locator("[data-ss-partition-height]").inputValue();
    ok("E4 a refused height clamped to the one it has: the field shows the height kept, not the one typed",
      keptIn === 83 && ps[0].heightIn === 83 && shownIn === "83", `${keptIn} / ${ps[0].heightIn} / field ${shownIn}`);
    await page.getByRole("button", { name: "Stud wall height" }).first().click();
    await settle(page, 300);

    // G. Details
    const dtTog = page.locator(".ssd-dt-tog").first();
    if (!(await page.locator(".ssd-dt").count()) && await dtTog.count()) { await dtTog.click(); await settle(page, 400); }
    const dt = (await page.locator(".ssd-dt").first().innerText().catch(() => "")).replace(/\s+/g, " ");
    ok("G1 Details: the wall at 12 ft x $22.00 / ft (the 2x4 rate) = $264.00", dt.includes("Interior wall") && dt.includes("12' long, stud wall height (7'6\")") && dt.includes("2x4 framing") && dt.includes("$264.00"), dt.slice(0, 400));
    ok("G2 Details: the door and the window in it at their catalog prices", dt.includes("Interior Door (in interior wall)") && dt.includes("$300.00") && dt.includes("2x3 Window (in interior wall)") && dt.includes("$120.00"));

    // H. the Floorplan PDF
    const shot = await captureAB(page);
    const pyFt = r.y + atFt * sc;
    const onWall = await lineNear(page, shot.png, r.x + 1.5 * sc, pyFt, 0, 1, PARTITION_COLOR);
    const offWall = await pixelAt(page, shot.png, r.x + 1.5 * sc, pyFt + 0.75 * sc);
    const onDoor = await pixelAt(page, shot.png, r.x + 8.5 * sc, pyFt);
    ok("H1 the PDF draws the partition's two lines on its line", !!onWall, JSON.stringify(onWall));
    ok("H2 ...and not beside it", !close(offWall, hexRgb(PARTITION_COLOR), 40), JSON.stringify(offWall));
    ok("H3 ...and the door in it", close(onDoor, hexRgb("#D97706"), 40), JSON.stringify(onDoor));

    // I. the 3D
    const editBtn = page.getByRole("button", { name: /Edit in 3D/ });
    if (!(await editBtn.count()) || !(await editBtn.first().isVisible().catch(() => false))) {
      const show = page.getByRole("button", { name: /Show 3D/ });
      if (await show.count()) { await show.first().click(); await settle(page, 800); }
    }
    const before3d = await page.getByRole("button", { name: /Interior wall/ }).count();
    await editBtn.first().click();
    await page.waitForFunction(() => {
      const E = window.__ss3dEngine;
      return !!(E && E.model && E.model.interiorGroup && E.model.interiorGroup.children.some((g) => g.userData && g.userData.partition));
    }, null, { timeout: 90000 });
    await settle(page, 1500);
    const m = await page.evaluate(() => {
      const E = window.__ss3dEngine;
      E.scene.updateMatrixWorld(true);
      const groups = E.model.interiorGroup.children.filter((g) => g.userData && g.userData.partition);
      const V = E.camera.position.constructor;
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      let meshes = 0;
      groups.forEach((g) => g.traverse((o) => {
        if (!o.isMesh) return; meshes++;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        [bb.min.x, bb.max.x].forEach((x) => [bb.min.y, bb.max.y].forEach((y) => [bb.min.z, bb.max.z].forEach((z) => {
          const v = new V(x, y, z).applyMatrix4(o.matrixWorld);
          [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
        })));
      }));
      return { groups: groups.length, itemIds: groups.map((g) => g.userData.itemId || null), meshes, mn, mx };
    });
    ok("I1 the 3D builds one partition, which the 3D editor cannot pick up (no itemId)", m.groups === 1 && m.itemIds.every((x) => x == null), JSON.stringify(m.itemIds));
    ok("I2 ...wall to wall across the 12 ft width, full height, with its door and window", near(m.mn[0], -W / 2, 0.25) && near(m.mx[0], W / 2, 0.25)
      && near(m.mx[1], WALL_FT, 0.3) && m.meshes > 20, `x ${m.mn[0].toFixed(2)}..${m.mx[0].toFixed(2)} top ${m.mx[1].toFixed(2)} meshes ${m.meshes}`);
    ok("I3 ...where the plan has it", near((m.mn[2] + m.mx[2]) / 2, atFt - L / 2, 0.3), `${((m.mn[2] + m.mx[2]) / 2).toFixed(2)} vs ${(atFt - L / 2).toFixed(2)}`);
    ok("I4 the 3D palette does not offer it (placed on the plan only)", (await page.getByRole("button", { name: /Interior wall/ }).count()) <= before3d);
    const inside = page.getByRole("button", { name: /Look inside/ });
    if (await inside.count()) { await inside.first().click(); await settle(page, 1500); }
    // Aim the camera at the partition (the window size stays put), from the door's swing side.
    await page.evaluate((z) => {
      const E = window.__ss3dEngine;
      E.controls.target.set(0, 3.2, z);
      E.camera.position.set(9, 11, z + 13);
      E.controls.update();
      E.render();
    }, atFt - L / 2);
    await settle(page, 600);
    await page.screenshot({ path: join(shots, "I-3d-look-inside.png") });
    // The full-screen viewer's ✕ sits beside its "3D Preview" title.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "✕" && x.previousElementSibling && /^3D Preview/.test(x.previousElementSibling.textContent.trim()));
      if (b) b.click();
    });
    await page.waitForFunction(() => !window.__ss3dEngine || ![...document.querySelectorAll("button")].some((x) => x.textContent.trim() === "✕" && x.previousElementSibling && /^3D Preview/.test(x.previousElementSibling.textContent.trim())), null, { timeout: 20000 }).catch(() => {});
    await settle(page, 1200);

    // J. the quote
    const before = calls.length;
    const submit = page.getByRole("button", { name: /^(Get Estimate|Resubmit Quote|Resubmit)$/ }).last();
    let payload = null;
    if (await submit.count()) {
      await submit.click().catch(() => {});
      for (let i = 0; i < 60 && !payload; i++) {
        await settle(page, 250);
        const hit = calls.slice(before).find((c) => c.path && c.path.endsWith("/functions/v1/submit-estimate"));
        if (hit) payload = hit.body;
      }
    }
    ok("J0 Get Quote reached submit-estimate", !!payload);
    if (payload) {
      const parts = payload.itemSummary && payload.itemSummary.partitions;
      ok("J1 itemSummary.partitions: the ends, the length, stud wall height, and the door and window by catalog id",
        Array.isArray(parts) && parts.length === 1 && parts[0].lengthFt === 12 && parts[0].x1Ft === 0 && parts[0].x2Ft === 12 && near(parts[0].y1Ft, atFt, 1e-3)
          && parts[0].heightMode === "plate" && parts[0].heightIn === null && parts[0].heightFt === WALL_FT && parts[0].stud === null && parts[0].faceAreaSqFt === 90
          && parts[0].openings.map((o) => `${o.kind}:${o.fixtureItemId}`).join(",") === "door:d-int,window:w-23", JSON.stringify(parts));
      const fpi = (payload.floorPlanItems || []).filter((i) => i.type === "partitionWall");
      ok("J2 floorPlanItems carries the wall, with no `wall`", fpi.length === 1 && fpi[0].wall === null && fpi[0].lengthFt === 12, JSON.stringify(fpi));
      ok("J3 no door item reached the doors[] schedule", Array.isArray(payload.doors) && payload.doors.length === 0, JSON.stringify(payload.doors));
    }
    allErrors.push(...errors.map((e) => "B-J: " + e));
    await page.close();

    // ── M, N. Interior walls v2 on a rep's designer ─────────────────────────────────────────────
    await v2Run(ctx, ok, shots, allErrors);

    // ── O. Doors and windows centred in a partition's own thickness ────────────────────────────
    await openingsRun(ctx, ok, shots, allErrors);

    // ── K. The portal's Interior items card and Interior walls tab ───────────────────────────────────────────────────
    await portalRun(browser, ok, shots, allErrors);

    ok("L zero page errors", allErrors.length === 0, allErrors.slice(0, 5).join(" | "));
  } finally {
    await browser.close();
  }
};

// ── M, N ──────────────────────────────────────────────────────────────────────────────────────
// A rep's designer (embedded, canOverridePrice) on the Interior walls tab's tenant, priced per square
// foot of wall so a wall to the rafters is charged its face: $2 (2x4), $3 (2x6). One loft on the plate
// across the north end (y 2..6). The roof is D3_SPEC's gable: across the 12 ft width, 7'6" at the walls
// and 7'6" + 6 x 0.42 = 10.02 ft at the ridge down the middle.
const CONFIG_SQFT = { ...CONFIG_IW, interiorWalls: { ...CONFIG_IW.interiorWalls, method: "sqft_option", studs: { "2x4": { rate: 2 }, "2x6": { rate: 3 } } } };
const LOFT = { id: 201, type: "loft", x: MX + 6 * SC, y: MY + 4 * SC, rotation: 0, wall: null, widthFt: 12, heightFt: 4, onPlate: true };
const ROOF_AT = (xPlan) => WALL_FT + 0.42 * (6 - Math.abs(xPlan - 6));
const LOFT_BOTTOM = WALL_FT - 0.02 - 0.35;   // D3_LOFT_PLATE_GAP, D3.LOFT_T
async function v2Run(ctx, ok, shots, allErrors) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await stubSupabase(page, { config: CONFIG_SQFT, fixtures: FIXTURES, rpc: { load_design: [designRow([LOFT])] } });
  const url = `${BASE}/__harness_partitions_v2.html`;
  await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html", body: embeddedPage({ canOverridePrice: true }) }));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === "32 ft"), null, { timeout: 60000 });
    await settle(page, 1500);
    const r = await buildingRect(page);
    const sc = r.w / W;
    const at = (xFt, yFt) => svgPoint(page, r.x + xFt * sc, r.y + yFt * sc);
    const arm = async () => { await (await revealTool(page, /Interior wall/)).click(); await settle(page, 250); };
    const newest = async (n0) => { const ps = await partitions(page); return ps.length > n0 ? ps[ps.length - 1] : null; };

    // M1. Press-drag draws a wall, and 44 degrees is 45.
    await arm();
    await drag(page, await at(2, 14), await at(8.1, 19.9), 12);
    const d45 = await newest(0);
    ok("M1 press-drag draws a wall from the press point, and an angle within 5 degrees of 45 snaps to it",
      !!d45 && near(d45.x1Ft, 2, 1 / 12 + 1e-6) && near(d45.y1Ft, 14, 1 / 12 + 1e-6) && near(d45.x2Ft - d45.x1Ft, d45.y2Ft - d45.y1Ft, 1e-9) && near(d45.x2Ft, 8, 2 / 12 + 1e-6), JSON.stringify(d45));
    const g45 = d45 ? await page.evaluate((id) => {
      const g = document.querySelector(`[data-ss-partition="${id}"] > g`);
      return g ? { t: g.getAttribute("transform"), lines: [...g.querySelectorAll("line")].filter((l) => l.getAttribute("stroke") === "#57534E").length } : null;
    }, d45.id) : null;
    ok("M2 the plan draws it as two parallel lines, turned to its 45 degrees", !!g45 && near(Number((/rotate\(([-\d.e]+)\)/.exec(g45.t) || [])[1]), 45, 1e-6) && g45.lines >= 4, JSON.stringify(g45));

    // M3. Shift keeps the angle it is dragged to (133 degrees would snap to 135 without it).
    await arm();
    await page.keyboard.down("Shift");
    await drag(page, await at(10, 22), await at(5.2, 27.1), 12);
    await page.keyboard.up("Shift");
    const free = await newest(1);
    ok("M3 with Shift held, a wall keeps its own angle", !!free && !near(Math.abs(free.x2Ft - free.x1Ft), Math.abs(free.y2Ft - free.y1Ft), 0.05), JSON.stringify(free));

    // M4. A click still places today's short-span wall; a wall drawn up to its body lands on it (a T).
    await arm();
    const c24 = await at(3, 24);
    await page.mouse.click(c24.x, c24.y);
    await settle(page);
    const across = await newest(2);
    ok("M4 a click still places the short-span wall", !!across && across.x1Ft === 0 && across.x2Ft === 12 && near(across.y1Ft, 24, 1 / 12 + 1e-6) && across.y2Ft === across.y1Ft, JSON.stringify(across));
    await arm();
    await drag(page, await at(6, 29), await at(6.1, 24.3), 12);
    const stem = await newest(3);
    ok("M5 a wall drawn up to another's body lands on it: a T, and no clash", !!stem && near(stem.x1Ft, 6, 1 / 12 + 1e-6) && stem.x2Ft === stem.x1Ft && near(stem.y2Ft, across.y1Ft, 1e-9) && (await partitions(page)).length === 4, JSON.stringify(stem));

    // M6. The rep's framing control: shown here, and 2x6 sticks.
    const mid45 = await at(5, 17);
    await page.mouse.click(mid45.x, mid45.y);
    await settle(page, 300);
    const studBtns = await page.locator("[data-ss-partition-stud] button").allTextContents();
    ok("M6 a rep sees the framing control, with the sizes the builder offers", JSON.stringify(studBtns) === JSON.stringify(["Framing 2x4", "Framing 2x6"]), JSON.stringify(studBtns));
    await page.getByRole("button", { name: "Framing 2x6" }).first().click();
    await settle(page, 300);
    const d6 = (await partitions(page)).find((p) => p.id === d45.id);
    const lbl = await page.evaluate((id) => [...document.querySelectorAll(`[data-ss-partition="${id}"] text`)].map((t) => t.textContent).join(" | "), d45.id);
    ok("M7 ...2x6 sticks, and the plan's label says so", !!d6 && d6.stud === "2x6" && /INTERIOR .* · 2x6 · 7'6" tall/.test(lbl), `${d6 && d6.stud} ${lbl}`);
    await page.locator("svg").filter({ has: page.locator('rect[stroke="#1E293B"]') }).first().screenshot({ path: join(shots, "M-plan-v2.png") });

    // M8. The Floorplan PDF draws the diagonal along its own line.
    const shot = await captureAB(page);
    const n = [Math.SQRT1_2, -Math.SQRT1_2];
    // 2 ft along it from end 1, clear of its label (which stands off side a at the middle).
    const px45 = 2 + 2 * Math.SQRT1_2, py45 = 14 + 2 * Math.SQRT1_2;
    const on45 = await lineNear(page, shot.png, r.x + px45 * sc, r.y + py45 * sc, n[0], n[1], PARTITION_COLOR);
    const off45 = await pixelAt(page, shot.png, r.x + (px45 - 0.9 * n[0]) * sc, r.y + (py45 - 0.9 * n[1]) * sc);
    ok("M8 the PDF draws the 45 degree wall on its line, and not beside it", !!on45 && !close(off45, hexRgb(PARTITION_COLOR), 40), `${JSON.stringify(on45)} / ${JSON.stringify(off45)}`);

    // N1. To the rafters: the wall across the width, and a wall running north under the loft. (The PDF
    // modal moved the page, so the point is asked for again.)
    const c24b = await at(3, across.y1Ft);
    await page.mouse.click(c24b.x, c24b.y);
    await settle(page, 300);
    await page.getByRole("button", { name: "To the rafters" }).first().click();
    await settle(page, 300);
    await arm();
    await drag(page, await at(3, 9), await at(3.05, 1.3), 12);
    const under = await newest(4);
    await page.getByRole("button", { name: "To the rafters" }).first().click();
    await settle(page, 300);
    const ps = await partitions(page);
    ok("N1 To the rafters sticks on both walls", ps.find((p) => p.id === across.id).heightMode === "rafters" && !!under && ps.find((p) => p.id === under.id).heightMode === "rafters",
      JSON.stringify(ps.map((p) => [p.id, p.heightMode])));
    // N2. Details: the wall across the gable is its true face, 12 x 7'6" plus the gable's triangle.
    const dtTog = page.locator(".ssd-dt-tog").first();
    if (!(await page.locator(".ssd-dt").count()) && await dtTog.count()) { await dtTog.click(); await settle(page, 400); }
    const dt = (await page.locator(".ssd-dt").first().innerText().catch(() => "")).replace(/\s+/g, " ");
    ok("N2 Details prices the wall to the rafters per sq ft of its true face: 12 x 7.5 + 12 x 2.52 / 2 = 105.12 sq ft at $2 = $210.24",
      dt.includes("12' long, to the rafters") && dt.includes("$210.24"), dt.slice(0, 600));
    // N3-N4. The 3D: every top vertex of each wall to the rafters on the roof's underside, or the loft's floor.
    const editBtn = page.getByRole("button", { name: /Edit in 3D/ });
    if (!(await editBtn.count()) || !(await editBtn.first().isVisible().catch(() => false))) {
      const show = page.getByRole("button", { name: /Show 3D/ });
      if (await show.count()) { await show.first().click(); await settle(page, 800); }
    }
    await editBtn.first().click();
    await page.waitForFunction(() => {
      const E = window.__ss3dEngine;
      return !!(E && E.model && E.model.interiorGroup && E.model.interiorGroup.children.filter((g) => g.userData && g.userData.partition).length >= 4);
    }, null, { timeout: 90000 });
    await settle(page, 1500);
    const tops = await page.evaluate(() => {
      const E = window.__ss3dEngine;
      E.scene.updateMatrixWorld(true);
      const V = E.camera.position.constructor;
      return E.model.interiorGroup.children.filter((g) => g.userData && g.userData.partition).map((g) => {
        const pts = [];
        let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        g.traverse((o) => {
          if (!o.isMesh) return;
          const pos = o.geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            const v = new V(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
            [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
            if (v.y > 6) pts.push([v.x, v.y, v.z]);
          }
        });
        return { mn, mx, pts };
      });
    });
    // Which group is which: the across wall stands at z = 24 - 16, the stem under the loft at x = 3 - 6.
    const acr = tops.find((t) => Math.abs((t.mn[2] + t.mx[2]) / 2 - 8) < 0.5 && t.mx[0] - t.mn[0] > 11);
    const und = tops.find((t) => Math.abs((t.mn[0] + t.mx[0]) / 2 + 3) < 0.5 && t.mx[2] < -6);
    // Each top vertex against the roof's underside (or the loft's floor) right above it: [poke, gap], the
    // worst amount it stands above it and the worst it stops short. Each face follows the roof over it,
    // so both are nil. A want of null skips the point (the loft's edge, where the top steps down between
    // two samples).
    const worst = (t, want) => t ? t.pts.reduce((m, p) => {
      const w = want(p);
      return w == null ? m : [Math.max(m[0], p[1] - w), Math.max(m[1], w - p[1])];
    }, [0, 0]) : [Infinity, Infinity];
    const acc = worst(acr, (p) => ROOF_AT(p[0] + W / 2));
    ok("N3 3D: the wall across the gable meets the roof's underside all along it (no gap, no poke-through), peaked at the ridge",
      !!acr && acc[0] < 0.01 && acc[1] < 0.02 && near(acr.mx[1], ROOF_AT(6), 0.05), `poke ${acc[0].toFixed(3)} gap ${acc[1].toFixed(3)} top ${acr && acr.mx[1].toFixed(3)}`);
    const und2 = worst(und, (p) => {
      const yPlan = p[2] + L / 2;
      if (Math.abs(yPlan - 2) < 0.1 || Math.abs(yPlan - 6) < 0.1) return null;
      return yPlan > 2 && yPlan < 6 ? LOFT_BOTTOM : ROOF_AT(p[0] + W / 2);
    });
    ok("N4 3D: under the loft it stops at the loft's floor framing, and past the loft it meets the roof (no gap, no poke-through)",
      !!und && und2[0] < 0.01 && und2[1] < 0.02, `poke ${und2[0].toFixed(3)} gap ${und2[1].toFixed(3)}`);
    const inside = page.getByRole("button", { name: /Look inside/ });
    if (await inside.count()) { await inside.first().click(); await settle(page, 1500); }
    await page.evaluate(() => {
      const E = window.__ss3dEngine;
      E.controls.target.set(0, 4, 0);
      E.camera.position.set(14, 12, 18);
      E.controls.update();
      E.render();
    });
    await settle(page, 600);
    await page.screenshot({ path: join(shots, "N-3d-rafters.png") });
  } finally {
    allErrors.push(...errors.map((e) => "M-N: " + e));
    await page.close();
  }
}

// ── O ───────────────────────────────────────────────────────────────────────────────────────
// A saved design, so the walls and their openings are exact: a diagonal 2x4 wall from (1, 10) to
// (11, 20) holding a plank door, a Classic trim door and a window, and a straight 2x6 wall across at
// y = 26 holding a roll-up, a double plank door and a window. Thickness: 3.5 in and 5.5 in, bare.
const FIXTURES_O = {
  ...FIXTURES,
  items: [...FIXTURES.items,
    fx({ id: "d-classic", name: "Classic Door", category: "door", price: 450, widthIn: 36, heightIn: 80, planLabel: "CL", doorStyle: "classic", opLeft: true, opRight: true, opDefault: "left" }),
    fx({ id: "d-roll", name: "Roll-up 4x6", category: "door", price: 700, widthIn: 48, heightIn: 72, planLabel: "RU", doorStyle: "rollup", opSlideUp: true, opDefault: "slideup" }),
  ],
};
const O_DOOR = (id, fxId, name, centerFt, extra = {}) => ({ id, kind: "door", fixtureItemId: fxId, name, planLabel: name.slice(0, 4).toUpperCase(), widthIn: 36, heightIn: 80, swing: "out", operation: "left", price: 300, centerFt, ...extra });
const O_WIN = (id, centerFt) => ({ id, kind: "window", fixtureItemId: "w-23", name: "2x3 Window", planLabel: "W23", widthIn: 24, heightIn: 36, sillIn: 42, price: 120, centerFt });
const O_WALLS = [
  { id: 301, type: "partitionWall", wall: null, x1Ft: 1, y1Ft: 10, x2Ft: 11, y2Ft: 20, heightMode: "plate", heightIn: null, stud: "2x4", covers: { a: null, b: null },
    openings: [O_DOOR(1, "d-int", "Interior Door", 3), O_DOOR(2, "d-classic", "Classic Door", 7.25, { operation: "right" }), O_WIN(3, 11.25)] },
  { id: 302, type: "partitionWall", wall: null, x1Ft: 0, y1Ft: 26, x2Ft: 12, y2Ft: 26, heightMode: "plate", heightIn: null, stud: "2x6", covers: { a: null, b: null },
    openings: [O_DOOR(1, "d-roll", "Roll-up 4x6", 2.75, { widthIn: 48, heightIn: 72, operation: "slideup" }), O_DOOR(2, "d-int", "Interior Door", 6.75, { operation: "double" }), O_WIN(3, 10.25)] },
];
const O_T = { 301: 3.5 / 12, 302: 5.5 / 12 };
async function openingsRun(ctx, ok, shots, allErrors) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await stubSupabase(page, { config: CONFIG_IW, fixtures: FIXTURES_O, rpc: { load_design: [designRow(O_WALLS)] } });
  const url = `${BASE}/__harness_partitions_o.html`;
  await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html", body: embeddedPage() }));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === "32 ft"), null, { timeout: 60000 });
    await settle(page, 1500);
    const editBtn = page.getByRole("button", { name: /Edit in 3D/ });
    if (!(await editBtn.count()) || !(await editBtn.first().isVisible().catch(() => false))) {
      const show = page.getByRole("button", { name: /Show 3D/ });
      if (await show.count()) { await show.first().click(); await settle(page, 800); }
    }
    await editBtn.first().click();
    await page.waitForFunction(() => {
      const E = window.__ss3dEngine;
      return !!(E && E.model && E.model.interiorGroup && E.model.interiorGroup.children.filter((g) => g.userData && g.userData.partition).length >= 2);
    }, null, { timeout: 90000 });
    await settle(page, 1500);
    // Every mesh's box corners, as offsets across each wall's line (its normal) from the wall's centre
    // line: per opening group (the door or window) and per trim piece, beside the bare wall's own.
    const walls = O_WALLS.map((w) => {
      const len = Math.hypot(w.x2Ft - w.x1Ft, w.y2Ft - w.y1Ft), ux = (w.x2Ft - w.x1Ft) / len, uy = (w.y2Ft - w.y1Ft) / len;
      return { id: w.id, O: [w.x1Ft - W / 2, w.y1Ft - L / 2], U: [ux, uy], N: [-uy, ux], len };
    });
    const got = await page.evaluate((walls) => {
      const E = window.__ss3dEngine;
      E.scene.updateMatrixWorld(true);
      const V = E.camera.position.constructor;
      const groups = E.model.interiorGroup.children.filter((g) => g.userData && g.userData.partition);
      return walls.map((w) => {
        // Which group is this wall: the one whose wall meshes' centres lie on its line.
        const span = (objs) => {
          let lo = Infinity, hi = -Infinity, alo = Infinity, ahi = -Infinity;
          objs.forEach((o) => {
            if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
            const b = o.geometry.boundingBox;
            for (let k = 0; k < 8; k++) {
              const v = new V(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z).applyMatrix4(o.matrixWorld);
              const n = (v.x - w.O[0]) * w.N[0] + (v.z - w.O[1]) * w.N[1], a = (v.x - w.O[0]) * w.U[0] + (v.z - w.O[1]) * w.U[1];
              lo = Math.min(lo, n); hi = Math.max(hi, n); alo = Math.min(alo, a); ahi = Math.max(ahi, a);
            }
          });
          return { lo, hi, alo, ahi };
        };
        const meshesOf = (g) => { const out = []; g.traverse((o) => { if (o.isMesh) out.push(o); }); return out; };
        const g = groups.find((gr) => { const s = span(meshesOf(gr)); return Math.abs(s.lo + s.hi) < 0.6 && s.ahi - s.alo > w.len - 0.6 && s.ahi - s.alo < w.len + 0.8; });
        if (!g) return { id: w.id, found: false };
        const ops = g.children.filter((c) => c.userData && c.userData.ssPartitionOpening).map((c) => ({ kind: c.userData.ssPartitionOpening, oid: c.userData.oid, meshes: meshesOf(c).length, ...span(meshesOf(c)) }));
        const trim = meshesOf(g).filter((o) => o.userData && o.userData.ssPartitionTrim);
        return { id: w.id, found: true, ops, trim: trim.length ? span(trim) : null };
      });
    }, walls);
    for (const w of got) {
      const T = O_T[w.id], name = w.id === 301 ? "the diagonal 2x4 wall" : "the straight 2x6 wall";
      ok(`O1 ${name}: three openings each built in a group of their own`, w.found && w.ops.length === 3 && w.ops.every((o) => o.meshes > 0), JSON.stringify(w.ops && w.ops.map((o) => [o.kind, o.oid, o.meshes])));
      for (const o of (w.ops || [])) {
        ok(`O2 ${name}: opening ${o.oid} (${o.kind}) lies within the wall's ${(T * 12).toFixed(1)} in thickness, centred on its line`,
          o.lo >= -T / 2 - 0.005 && o.hi <= T / 2 + 0.005 && Math.abs((o.lo + o.hi) / 2) <= 0.01,
          `across ${o.lo.toFixed(3)}..${o.hi.toFixed(3)} ft vs ±${(T / 2).toFixed(3)}`);
      }
      ok(`O3 ${name}: the casings, sill and stool stand the same on both faces, a casing's reach past them`,
        !!w.trim && Math.abs(w.trim.lo + w.trim.hi) <= 0.01 && w.trim.hi <= T / 2 + 0.065 && w.trim.hi >= T / 2,
        w.trim ? `${w.trim.lo.toFixed(3)}..${w.trim.hi.toFixed(3)}` : "none");
    }
    // Shots: each wall from side a, from side b and from above, close on its openings.
    const inside = page.getByRole("button", { name: /Look inside/ });
    if (await inside.count()) { await inside.first().click(); await settle(page, 1500); }
    const aim = async (file, target, cam) => {
      await page.evaluate(({ target, cam }) => {
        const E = window.__ss3dEngine;
        E.controls.minDistance = 0.5;   // the viewer keeps an orbit outside the building; these are close-ups
        E.camera.fov = 62; E.camera.updateProjectionMatrix();
        E.controls.target.set(...target);
        E.camera.position.set(...cam);
        E.controls.update();
        E.render();
      }, { target, cam });
      await settle(page, 700);
      await page.screenshot({ path: join(shots, file) });
    };
    for (const w of walls) {
      const tag = w.id === 301 ? "diag-2x4" : "straight-2x6";
      const wall = O_WALLS.find((x) => x.id === w.id);
      for (const o of wall.openings) {
        const c = [w.O[0] + w.U[0] * o.centerFt, w.O[1] + w.U[1] * o.centerFt];
        const what = `${tag}-${o.kind}${o.id}`;
        const hw = o.widthIn / 24, at = (k, n) => [c[0] + w.U[0] * k + w.N[0] * n, c[1] + w.U[1] * k + w.N[1] * n];
        const t = at(0, 0), ya = at(1.5, 5.5), yb = at(-1.5, -5.5), ty = o.kind === "window" ? 5 : 3.4;
        await aim(`O-${what}-side-a.png`, [t[0], ty, t[1]], [ya[0], ty + 1.6, ya[1]]);
        await aim(`O-${what}-side-b.png`, [t[0], ty, t[1]], [yb[0], ty + 1.6, yb[1]]);
        // Down the opening at a slant from beyond one end, from each face: the far jamb's return shows
        // how deep the leaf (or sash) sits behind each face of the wall.
        const ja = at(-hw + 0.2, 0), ca = at(hw + 3.2, 1.6), cb = at(hw + 3.2, -1.6);
        await aim(`O-${what}-jamb-a.png`, [ja[0], ty, ja[1]], [ca[0], ty + 0.8, ca[1]]);
        await aim(`O-${what}-jamb-b.png`, [ja[0], ty, ja[1]], [cb[0], ty + 0.8, cb[1]]);
      }
    }
  } finally {
    allErrors.push(...errors.map((e) => "O: " + e));
    await page.close();
  }
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000005", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER_ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders",
  "change_order_approve", "build_schedule", "delivery_schedule", "repairs", "commissions", "reports", "phone",
  "settings_structures", "settings_options", "settings_branding", "settings_crm", "settings_quickbooks",
  "settings_email", "settings_team", "settings_billing"].map((k) => [k, "edit"]));
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const CORS = { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
const jsonR = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

async function portalRun(browser, ok, shots, allErrors) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => allErrors.push("K: " + e.message));
  const saves = [];
  const catalogs = [];
  // As portal-settings' catalog answers after 312: the partition wall is still an item (priced, so it
  // is listed), but the Interior items card leaves it out; the Interior walls tab reads its own row,
  // seeded from the 278 price ($35 per foot, 2x4), one covering, a door, a window and two electrical items.
  const lp = [{ item_key: "shelf", pricing_method: "lineal_ft", rate: 18, image_url: null }, { item_key: "partitionWall", pricing_method: "lineal_ft", rate: 35, image_url: null }];
  const items = () => [
    { key: "workbench", label: "Workbench", archived: false, internalOnly: false, taxable: true, wallSnap: true, depthIn: null, heightOffFloorIn: 36, hiddenUntilPriced: false },
    { key: "shelf", label: "Single Shelf", archived: false, internalOnly: false, taxable: true, wallSnap: true, depthIn: 12, heightOffFloorIn: 48, hiddenUntilPriced: true },
    { key: "partitionWall", label: "Partition Wall", archived: false, internalOnly: false, taxable: true, wallSnap: false, depthIn: null, heightOffFloorIn: null, hiddenUntilPriced: true },
  ];
  const iw = { standard_stud: "2x4", pricing_method: "lineal_ft", rate_2x4: 35, rate_2x6: null, standard_height: "plate", allow_rafters: true, allow_rough_openings: true, taxable: true, internal_only: false };
  const covers = [{ id: "00000000-0000-4000-8000-0000000000c1", name: "Drywall", pricing_method: "sqft_option", rate: 2.5, taxable: true, internal_only: false, active: true, sort_order: 10 }];
  const fixtures = [
    { id: "00000000-0000-4000-8000-0000000000d1", category: "door", name: "Walk door", in_partition: true, archived: false },
    { id: "00000000-0000-4000-8000-0000000000a1", category: "window", name: "Slider window", in_partition: true, archived: false },
  ];
  const elec = [
    { id: "00000000-0000-4000-8000-0000000000f1", name: "Ceiling fan", icon: "F", interior_wall_ok: true },
    { id: "00000000-0000-4000-8000-0000000000f2", name: "Outlet", icon: "O", interior_wall_ok: true },
  ];
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return jsonR(route, false);
    if (url.includes("/rest/v1/rpc/")) return jsonR(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return jsonR(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return jsonR(route, []);
    if (url.includes("/auth/v1/user")) return jsonR(route, USER);
    if (url.includes("/auth/v1/")) return jsonR(route, SESSION);
    if (url.includes("/portal-billing")) {
      return jsonR(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (!url.includes("/portal-settings")) return jsonR(route, { ok: true });
    switch (body.action) {
      case "status":
        return jsonR(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER_ACCESS, prefs: null,
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false,
          businessName: "Acme Sheds", businessPhone: "(555) 010-0100", businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "catalog":
        catalogs.push(body);
        return jsonR(route, { ok: true, clientId: CLIENT, styles: [], sizes: [], items: items(), inclusions: [], layoutPricing: lp,
          colors: [], fixtures, wallHeights: [], insulation: [], insulationEnabled: false, electricalItems: elec,
          interiorWalls: iw, interiorWallCoverings: covers });
      case "save_layout_pricing":
      case "save_interior_walls":
      case "save_interior_wall_coverings":
        saves.push(body);
        return jsonR(route, { ok: true, saved: (body.rows || []).length, skipped: [] });
      default: return jsonR(route, { ok: true });
    }
  };
  await ctx.route(`**/${REF}.supabase.co/**`, handler);
  await ctx.route(`**/${REF}.functions.supabase.co/**`, handler);
  const go = async (path) => {
    await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
  };
  try {
    await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
    await settle(page, 600);
    // K0-K1: Interior items no longer lists the wall; its Save never sends one.
    await go("/settings/interior");
    await page.waitForFunction(() => !!document.querySelector('[data-ss-lp-item="shelf"]'), null, { timeout: 20000 }).catch(() => {});
    await settle(page, 600);
    ok("K0 the Interior items card lists the shelf but no longer the interior wall",
      await page.locator('[data-ss-lp-item="shelf"]').count() > 0 && await page.locator('[data-ss-lp-item="partitionWall"]').count() === 0);
    await page.getByRole("button", { name: "Save prices" }).click();
    for (let i = 0; i < 20 && saves.length < 1; i++) await settle(page, 200);
    const lpSave = saves.find((b) => b.action === "save_layout_pricing");
    ok("K1 its Save sends no partition row and no partitionAware flag", !!lpSave && !lpSave.rows.some((r) => r.item_key === "partitionWall") && !("partitionAware" in lpSave), JSON.stringify(lpSave));

    // K2-K8: the Interior walls tab.
    await go("/settings/interior-walls");
    await page.waitForFunction(() => document.body.innerText.includes("Framing & price"), null, { timeout: 20000 }).catch(() => {});
    await settle(page, 600);
    const text = await page.locator("body").innerText();
    ok("K2 the Interior walls tab opens on its four cards",
      ["Framing & price", "Wall coverings", "Doors allowed in interior walls", "Allowed on interior walls", "Save interior walls"].every((t) => text.toLowerCase().includes(t.toLowerCase())));
    const rate4 = page.locator('input[type="number"]').nth(0);
    const rate6 = page.locator('input[type="number"]').nth(1);
    ok("K3 the seeded 2x4 rate shows; 2x6 is blank (not offered)", (await rate4.inputValue()) === "35" && (await rate6.inputValue()) === "" && (await rate6.getAttribute("placeholder")) === "not offered");
    await page.screenshot({ path: join(shots, "K-interior-walls.png"), fullPage: true });
    // Offer 2x6 at $42, untick the door and the fan, add OSB included, and save.
    await rate6.fill("42");
    await page.getByLabel("Walk door").uncheck();
    await page.getByLabel("Ceiling fan").uncheck();
    await page.getByRole("button", { name: "+ Add a covering" }).click();
    const newName = page.locator("tbody tr").filter({ has: page.locator("input:not([type])") }).last().locator("input").first();
    await newName.fill("OSB");
    const newRate = page.locator("tbody tr").last().locator('input[type="number"]').first();
    await newRate.fill("0");
    const before = saves.length;
    await page.getByRole("button", { name: "Save interior walls" }).click();
    for (let i = 0; i < 25 && saves.length < before + 2; i++) await settle(page, 200);
    const w = saves.find((b) => b.action === "save_interior_walls");
    const c = saves.find((b) => b.action === "save_interior_wall_coverings");
    ok("K4 Save sends the framing: 2x4 standard at 35, 2x6 at 42, per foot, plate height",
      !!w && w.standardStud === "2x4" && w.rate2x4 === "35" && w.rate2x6 === "42" && w.method === "lineal_ft" && w.standardHeight === "plate" && w.allowRafters === true, JSON.stringify(w));
    ok("K5 ...and the ticks as id → yes/no for every door, window and electrical item",
      !!w && w.inPartition["00000000-0000-4000-8000-0000000000d1"] === false && w.inPartition["00000000-0000-4000-8000-0000000000a1"] === true
      && w.interiorWallOk["00000000-0000-4000-8000-0000000000f1"] === false && w.interiorWallOk["00000000-0000-4000-8000-0000000000f2"] === true, JSON.stringify(w && [w.inPartition, w.interiorWallOk]));
    ok("K6 the coverings go in their order, the new one included at $0",
      !!c && JSON.stringify(c.rows.map((r) => [r.name, r.rate, r.sortOrder])) === JSON.stringify([["Drywall", "2.5", 10], ["OSB", "0", 20]]), JSON.stringify(c && c.rows));
    // A blank standard rate is refused in the page, before anything is sent.
    await rate4.fill("");
    const n = saves.length;
    await page.getByRole("button", { name: "Save interior walls" }).click();
    await settle(page, 600);
    ok("K7 a blank standard rate is refused before anything is sent", saves.length === n && (await page.locator("body").innerText()).includes("Enter a rate for a 2x4 wall"));
    ok("K8 every catalog read asks for the unpriced items (withUnpriced)", catalogs.length > 0 && catalogs.every((b) => b.withUnpriced === true), JSON.stringify(catalogs.map((b) => b.withUnpriced)));
  } finally {
    await ctx.close();
  }
}

run().then(() => {
  const f = failed();
  console.log(f.length ? `\n${f.length} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  console.log(`shots: ${shots}`);
  process.exit(f.length ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
