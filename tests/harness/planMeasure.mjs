// THE PLAN'S MEASURE TOGGLE (Carolyn 2026-10-06, Q22: "a Measure feature you can turn on and off"),
// driven through the SHIPPED compiled bundle with real clicks and real drags. Measure brings back the
// two along-wall chips e44132fb took off the plan, behind a button in the Floorplan card's header that
// is OFF on every load:
//
//   A  off by default: the button is there, not pressed, and NOT in the plan toolbar; selecting a
//      workbench adds no chip and no feet-inches text to the plan (what tests/e2e/designer.spec.mjs
//      "draws no dimension chips" has pinned since 09-07)
//   B  on: a workbench placed on the north wall and selected gets exactly two chips, reading the
//      distance from each of its ends to the wall's ends, and the two plus its width are the wall
//   C  the e44132fb regression, with Measure on: the plan does not move by a tenth of a pixel when
//      the item is pressed and clicked, the stretch grips survive the click, and the far chip
//      follows a stretch LIVE, before the pointer is let go
//   D  ⇔ Center: both chips read the same, both turn green, and the bar says ✓ Centered
//   E  a window on the east wall: the chip text is upright (the item's own <g> is rotated there)
//   F  a loft, a note and a stored item draw no chips: they have no wall to measure along
//   G  the Floorplan PDF is the same image with Measure on as with it off (chips are screen-only)
//   H  turning Measure off hides the chips and keeps the selection
//   I  Measure on with nothing selected says what to do, in the one-line box "Selected: …" uses,
//      so selecting an item does not change the toolbar's height; at 768 with 3D on the hint still
//      fits that box (a longer one was clipped to nothing there)
//   J  the toolbar regression the button's first home caused: with 3D on and two vents, a catalog
//      door, a window and a workbench, pressing each at laptop and tablet widths, Measure off AND on,
//      must not change the toolbar's height or move the plan, and the item must end up selected. In
//      the toolbar the button wrapped the bar to a second line on the press (46 -> 81px), the plan
//      dropped 35px under the pointer and the item deselected. Only widths where the bar held
//      before Measure existed: below them it wraps on its own (door, window, bench 850+, vent 1020+).
//   Each: zero page errors.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/planMeasure.mjs       (SS_BASE=http://127.0.0.1:<port>, SS_CASES=B,C, SS_SHOTS=<dir>)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, revealTool, bypassGate, shotsDir, BASE } from "./lib.mjs";

const W = 10, L = 16, SIZE = `${W}x${L}`;
const CLIENT = "harness-plan-measure";
const CONFIG = {
  clientId: CLIENT,
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: [{ value: "utility", label: "Utility", img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {} }],
  defaultSizes: [SIZE],
  sizePricing: { utility: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } } },
  options: [], colors: [], claddingOptions: [], wallHeightOptions: {},
  showPricing: true, view3d: false,
  layoutItems: {
    workbench: { icon: "🔧", color: "#8B5E3C", group: "interior", label: "Workbench", width: 4, height: 2, depthIn: 24, modelKey: "wallBench", wallOnly: false, wallSnap: true, shortLabel: "WB", heightOffFloorIn: 36 },
    loft: { icon: "🪜", color: "#A16207", group: "interior", label: "Loft Area", width: 4, height: 4, shortLabel: "LOFT" },
  },
  layoutPricing: { workbench: { rate: 25, method: "lineal_ft", byStyle: {} }, loft: { rate: 40, method: "sqft_option", byStyle: {} } },
  layoutPrices: {}, electrical: null, electricalItems: [], insulation: [],
};
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: true, imageUrl: null, showImage: false }, items: [], windowColors: [] };
// Case J's: 3D on, and a catalog with a vent, doors and windows, so Swap shows and the bar is full.
const CONFIG_3D = { ...CONFIG, view3d: true };
const CAT = { colorMode: "fixed", imageUrl: null, opLeft: false, opRight: false, opDouble: false, opSlideUp: false, opDefault: null, swingIn: false, swingOut: false, swingDefault: null, hasTrimColor: false };
const FIXTURES_CAT = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, windowColors: [], items: [
  { ...CAT, id: "v-std", category: "vent", name: "Standard vent", planLabel: "SVNT", price: 0, widthIn: 12, heightIn: 8, sortOrder: 0 },
  { ...CAT, id: "d-std", category: "door", name: "Single door", planLabel: "SD", price: 300, widthIn: 36, heightIn: 76, sortOrder: 0, swingOut: true, opRight: true, sillIn: null, sillMode: "fixed" },
  { ...CAT, id: "d-dbl", category: "door", name: "Double door", planLabel: "DD", price: 500, widthIn: 60, heightIn: 76, sortOrder: 1, swingOut: true, opDouble: true, sillIn: null, sillMode: "fixed" },
  { ...CAT, id: "w-23", category: "window", name: "2x3 Window", planLabel: "W23", price: 120, widthIn: 24, heightIn: 36, sortOrder: 0, sillIn: 42 },
  { ...CAT, id: "w-34", category: "window", name: "3x4 Window", planLabel: "W34", price: 160, widthIn: 36, heightIn: 48, sortOrder: 1, sillIn: 36 },
] };

// The designer's own formatter, lifted from the twin the bundle is compiled from, so a chip is held
// to the exact spelling the 3D chips and the vent readout use (5'4.92", never 5'4.9200000001").
const SRC = readFileSync(new URL("../../structure-studio.component.js", import.meta.url), "utf8");
const lift = (a, b) => {
  const i = SRC.indexOf(a), j = i < 0 ? -1 : SRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error(`planMeasure: the anchors ${a} .. ${b} moved; re-point them`);
  return SRC.slice(i, j);
};
const { fmtDimFtIn } = new Function(`${lift("function fmtFtIn(", "// How far a placed item's two ends")}; return { fmtDimFtIn };`)();

const only = (process.env.SS_CASES || "").split(",").filter(Boolean);
const want = (id) => !only.length || only.includes(id);
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps;
const SHOTS = shotsDir("planMeasure");
const { ok, failed } = reporter();

const planReady = (page) => page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
async function chooseSize(page) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
  if (await sel.count()) await sel.first().selectOption({ label: SIZE });
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 15000 });
  await settle(page, 500);
}
async function geom(page) {
  const r = await buildingRect(page);
  const sc = r.w / W;
  return { r, sc, at: (xFt, yFt) => ({ x: r.x + xFt * sc, y: r.y + yFt * sc }), ftX: (x) => (x - r.x) / sc, ftY: (y) => (y - r.y) / sc };
}
async function clickSvg(page, p) { const s = await svgPoint(page, p.x, p.y); await page.mouse.click(s.x, s.y); await settle(page, 300); }

// Page coordinates for a spot in feet, from the formula the designer uses (as planCore.mjs has it).
function pageGeom(bw, bh) {
  const visibleH = 1100 - 340;
  const scale = Math.min((850 * 0.70) / bw, (visibleH * 0.70) / bh, (visibleH - 60) / (bh + 4));
  const pW = bw * scale, pH = bh * scale;
  return { scale, pW, pH, mgX: (850 - pW) / 2, mgY: 2 * scale + 30 };
}
const G = pageGeom(W, L);
const px = (xFt) => G.mgX + xFt * G.scale, py = (yFt) => G.mgY + yFt * G.scale;
// A 4 ft workbench on the north wall over 1..5 ft (off centre), 2 ft deep.
const BENCH = { id: 1, type: "workbench", x: px(3), y: G.mgY + 1 * G.scale, rotation: 0, wall: "north", widthFt: 4, heightFt: 2, depthIn: 24, heightOffFloorIn: 36 };
// Bare floor: clicking it with no tool armed deselects.
const EMPTY = { x: px(7), y: py(9) };

// A design opened from a share link: the only way to start from an exact layout.
async function openWith(ctx, items, { config = CONFIG, fixtures = FIXTURES } = {}) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const row = {
    short_code: "SS-HARNPM01", status: "draft", selections: { style: "utility", size: SIZE }, items,
    contact: { name: "", email: "", phone: "", street: "", city: "", state: "", zip: "" },
    paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
  };
  await stubSupabase(page, { config, fixtures, rpc: { load_design: [row] } });
  await bypassGate(page, CLIENT);
  await page.goto(`${BASE}/?client=${encodeURIComponent(CLIENT)}&id=SS-HARNPM01`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  await planReady(page);
  for (let k = 0; k < 40; k++) { const it = await readItems(page); if (it && it.length === items.length) break; await settle(page, 250); }
  await settle(page, 600);
  return { page, errors };
}
async function openFresh(ctx) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  await openDesigner(page, CLIENT);
  await planReady(page);
  await chooseSize(page);
  return { page, errors };
}

// The toggle, found by its words and its pressed state, in the Floorplan card's header.
const measureBtn = (page) => page.locator(".ssd-plan-head button[aria-pressed]").filter({ hasText: /^\W*Measure$/u });
async function setMeasure(page, on) {
  const b = measureBtn(page);
  if ((await b.getAttribute("aria-pressed")) !== String(on)) { await b.click(); await settle(page, 250); }
}
// The chips on the plan: which end, the text, the chip's fill, and whether the text is upright on screen.
const chips = (page) => page.evaluate(() => [...document.querySelectorAll("svg [data-ss-measure]")].map((g) => {
  const t = g.querySelector("text"), r = g.querySelector("rect"), m = t && t.getScreenCTM();
  return { which: g.getAttribute("data-ss-measure"), text: t ? t.textContent : null, fill: r ? r.getAttribute("fill") : null, b: m ? m.b : null, c: m ? m.c : null };
}));
const selText = (page) => page.locator(".ssd-tb-sel").first().textContent({ timeout: 2000 }).catch(() => "");
const planBox = (page) => page.evaluate(() => {
  const svg = [...document.querySelectorAll("svg")].find((s) => [...s.querySelectorAll("rect")].some((r) => r.getAttribute("stroke") === "#1E293B"));
  const b = svg.getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
});
const sameBox = (a, b) => near(a.x, b.x, 0.1) && near(a.y, b.y, 0.1) && near(a.w, b.w, 0.1) && near(a.h, b.h, 0.1);
const grips = (page) => page.evaluate(() => [...document.querySelectorAll("svg text")].filter((t) => /^[◄►]$/.test(t.textContent.trim())).length);
const planFtIn = (page) => page.evaluate(() => {
  const svg = [...document.querySelectorAll("svg")].find((s) => [...s.querySelectorAll("rect")].some((r) => r.getAttribute("stroke") === "#1E293B"));
  return [...svg.querySelectorAll("text")].map((t) => t.textContent.trim()).filter((t) => t.indexOf("'") > 0 || /\d"$/.test(t)).sort();
});
// What a wall item's chips must read, worked out here from where it is (never from the chips).
async function expected(page, it) {
  const g = await geom(page);
  const horiz = it.wall === "north" || it.wall === "south";
  const wallLen = horiz ? W : L;
  const pos = horiz ? g.ftX(it.x) : g.ftY(it.y);
  const before = pos - it.widthFt / 2, after = wallLen - (pos + it.widthFt / 2);
  return { before, after, wallLen, label: { before: fmtDimFtIn(before), after: fmtDimFtIn(after) } };
}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name) }).catch(() => {});
// The plan and its toolbar in one picture.
async function shotPlan(page, name) {
  const box = await page.evaluate(() => {
    const tb = document.querySelector(".ssd-tb"), svg = [...document.querySelectorAll("svg")].find((s) => [...s.querySelectorAll("rect")].some((r) => r.getAttribute("stroke") === "#1E293B"));
    const a = tb.getBoundingClientRect(), b = svg.getBoundingClientRect();
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x: Math.max(0, x - 8), y: Math.max(0, y - 8), width: Math.max(a.right, b.right) - x + 16, height: Math.max(a.bottom, b.bottom) - y + 16 };
  });
  await page.screenshot({ path: join(SHOTS, name), clip: box }).catch(() => shot(page, name));
}

const { browser, ctx } = await launch({ width: 1280, height: 1000 });
try {
  if (want("A")) {
    const { page, errors } = await openFresh(ctx);
    const b = measureBtn(page);
    ok("A: the Floorplan card has a Measure button", (await b.count()) === 1, `count ${await b.count()}`);
    ok("A: ...and it starts OFF", (await b.getAttribute("aria-pressed")) === "false");
    ok("A: ...and the plan toolbar has none (there it wrapped the bar on a press, case J)", (await page.locator(".ssd-tb button", { hasText: /Measure/ }).count()) === 0);
    ok("A: with it off, the hint slot is empty while nothing is selected", (await page.locator(".ssd-tb-selw").count()) === 0);
    const g = await geom(page);
    await (await revealTool(page, /Workbench/)).click();
    await settle(page, 300);
    await clickSvg(page, g.at(5, 0.3));
    const it = ((await readItems(page)) || []).find((i) => i.type === "workbench");
    ok("A: a workbench is placed on the north wall", !!it && it.wall === "north", JSON.stringify(it && { wall: it.wall, w: it.widthFt }));
    await clickSvg(page, EMPTY);
    ok("A: ...and nothing is selected", !/Workbench/.test(await selText(page)), await selText(page));
    const unselected = await planFtIn(page);
    await clickSvg(page, { x: it.x, y: it.y });
    ok("A: the workbench is selected", /Workbench/.test(await selText(page)), await selText(page));
    ok("A: selecting it with Measure off draws no measure chips", (await page.locator("svg [data-ss-measure]").count()) === 0);
    ok("A: ...and adds no feet-inches text to the plan", JSON.stringify(await planFtIn(page)) === JSON.stringify(unselected), JSON.stringify(await planFtIn(page)));
    await shotPlan(page, "A-measure-off-selected.png");
    ok("A: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("B")) {
    const { page, errors } = await openFresh(ctx);
    await setMeasure(page, true);
    ok("B: clicking Measure turns it on", (await measureBtn(page).getAttribute("aria-pressed")) === "true");
    ok("B: ...in the on look an option chip has", /\bis-on\b/.test(await measureBtn(page).getAttribute("class")));
    const g = await geom(page);
    await (await revealTool(page, /Workbench/)).click();
    await settle(page, 300);
    await clickSvg(page, g.at(3, 0.3));
    const it = ((await readItems(page)) || []).find((i) => i.type === "workbench");
    ok("B: a workbench is placed on the north wall", !!it && it.wall === "north", JSON.stringify(it && { wall: it.wall, w: it.widthFt }));
    if (!/Workbench/.test(await selText(page))) await clickSvg(page, { x: it.x, y: it.y });
    const c = await chips(page);
    const e = await expected(page, it);
    ok("B: selecting it draws exactly two chips, one to each end of the wall", c.length === 2 && c.some((x) => x.which === "before") && c.some((x) => x.which === "after"), JSON.stringify(c));
    const cb = c.find((x) => x.which === "before"), ca = c.find((x) => x.which === "after");
    ok("B: the near chip reads the gap to the wall's start", cb && cb.text === e.label.before, `${cb && cb.text} vs ${e.label.before}`);
    ok("B: the far chip reads the gap to the wall's end", ca && ca.text === e.label.after, `${ca && ca.text} vs ${e.label.after}`);
    ok("B: before + width + after is the whole wall", near(e.before + it.widthFt + e.after, e.wallLen), `${e.before.toFixed(3)} + ${it.widthFt} + ${e.after.toFixed(3)} on a ${e.wallLen} ft wall`);
    ok("B: off centre, both chips are the dark ink", c.every((x) => x.fill === "#1E293B"), c.map((x) => x.fill).join(","));
    await shotPlan(page, "B-measure-on-workbench.png");
    ok("B: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("C")) {
    const { page, errors } = await openWith(ctx, [BENCH]);
    await setMeasure(page, true);
    const b0 = ((await readItems(page)) || [])[0];
    const p = await svgPoint(page, b0.x, b0.y);
    const box0 = await planBox(page);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await settle(page, 250);
    const box1 = await planBox(page);
    const chipsDown = (await chips(page)).length;
    await page.mouse.up();
    await settle(page, 400);
    const box2 = await planBox(page);
    ok("C: the plan does not move when the item is pressed (x, y, width, height to 0.1px)", sameBox(box0, box1), `${JSON.stringify(box0)} -> ${JSON.stringify(box1)}`);
    ok("C: ...or when the click completes", sameBox(box0, box2), `${JSON.stringify(box0)} -> ${JSON.stringify(box2)}`);
    ok("C: the chips are there from the press on", chipsDown === 2, `chips on mousedown ${chipsDown}`);
    ok("C: the item is still selected after the click, with its two stretch grips", (await grips(page)) === 2 && /Workbench/.test(await selText(page)), `grips ${await grips(page)}`);
    // Stretch the far end 70px in 12 steps; the far chip must change BEFORE the pointer is let go.
    const afterBefore = ((await chips(page)).find((x) => x.which === "after") || {}).text;
    const grip = await page.evaluate(() => {
      const t = [...document.querySelectorAll("svg text")].find((el) => el.textContent.trim() === "►");
      const r = t.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + 70, grip.y, { steps: 12 });
    await settle(page, 200);
    const afterLive = ((await chips(page)).find((x) => x.which === "after") || {}).text;
    const live = ((await readItems(page)) || [])[0];
    const eLive = await expected(page, live);
    await page.mouse.up();
    await settle(page, 400);
    const b1 = ((await readItems(page)) || [])[0];
    ok("C: the stretch changes the bench's length", b1.widthFt !== b0.widthFt, `${b0.widthFt} -> ${b1.widthFt} ft`);
    ok("C: the far chip follows the stretch live, before the pointer is let go", !!afterLive && afterLive !== afterBefore && afterLive === eLive.label.after, `${afterBefore} -> ${afterLive} (expected ${eLive.label.after})`);
    ok("C: the plan still has not moved", sameBox(box0, await planBox(page)), JSON.stringify(await planBox(page)));
    ok("C: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("D")) {
    const { page, errors } = await openWith(ctx, [BENCH]);
    await setMeasure(page, true);
    await clickSvg(page, { x: BENCH.x, y: BENCH.y });
    await page.locator(".ssd-tb button", { hasText: "⇔ Center" }).click();
    await settle(page, 400);
    const c = await chips(page);
    const it = ((await readItems(page)) || [])[0];
    const e = await expected(page, it);
    ok("D: after ⇔ Center both chips read the same", c.length === 2 && c[0].text === c[1].text && c[0].text === e.label.before, c.map((x) => x.text).join(" | "));
    ok("D: ...and both are the centred green", c.length === 2 && c.every((x) => x.fill === "#059669"), c.map((x) => x.fill).join(","));
    ok("D: the toolbar says ✓ Centered", (await page.locator(".ssd-tb", { hasText: "✓ Centered" }).count()) === 1);
    await shotPlan(page, "D-measure-on-centred.png");
    ok("D: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("E")) {
    // A 2 ft window on the 16 ft east wall, centred 5 ft down it. Its <g> is rotated 90.
    const win = { id: 1, type: "window", x: G.mgX + G.pW, y: py(5), rotation: 90, wall: "east", widthFt: 2, heightFt: 0.5 };
    const { page, errors } = await openWith(ctx, [win]);
    await setMeasure(page, true);
    await clickSvg(page, { x: win.x - 2, y: win.y });
    const c = await chips(page);
    const it = ((await readItems(page)) || [])[0];
    const e = await expected(page, it);
    ok("E: a window on the east wall gets its two chips", c.length === 2, JSON.stringify(c));
    ok("E: the chip text is upright, not turned with the wall (CTM b and c are 0)", c.length === 2 && c.every((x) => Math.abs(x.b) < 1e-6 && Math.abs(x.c) < 1e-6), c.map((x) => `b=${x.b} c=${x.c}`).join(" | "));
    ok("E: the chips read the gaps to the east wall's two ends", c.length === 2 && c.find((x) => x.which === "before").text === e.label.before && c.find((x) => x.which === "after").text === e.label.after,
      `${c.map((x) => x.text).join(" | ")} vs ${e.label.before} | ${e.label.after}`);
    ok("E: before + width + after is the 16 ft wall", near(e.before + it.widthFt + e.after, 16), `${e.before.toFixed(3)} + ${it.widthFt} + ${e.after.toFixed(3)}`);
    await shotPlan(page, "E-measure-on-east-window.png");
    ok("E: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("F")) {
    const loft = { id: 1, type: "loft", x: px(5), y: py(12), rotation: 0, wall: null, widthFt: 10, heightFt: 4 };
    const note = { id: 2, type: "textNote", x: px(5), y: py(6), rotation: 0, wall: null, widthPx: 120, heightPx: 34, text: "Tack room" };
    const prop = { id: 3, type: "prop", propKind: "bike", x: px(0.35), y: py(3), rotation: 0, wall: null, widthFt: 0.7, heightFt: 5.6 };
    const { page, errors } = await openWith(ctx, [loft, note, prop]);
    await setMeasure(page, true);
    for (const [it, re] of [[loft, /Loft/], [note, /Note/], [prop, /Stored item/]]) {
      await clickSvg(page, EMPTY);
      await clickSvg(page, { x: it.x, y: it.y });
      const s = await selText(page);
      ok(`F: ${it.type} is selected`, re.test(s), s);
      ok(`F: ...and draws no chips (no wall to measure along)`, (await page.locator("svg [data-ss-measure]").count()) === 0);
    }
    ok("F: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("G")) {
    const { page, errors } = await openWith(ctx, [BENCH]);
    await clickSvg(page, { x: BENCH.x, y: BENCH.y });
    const pdfSrc = async () => {
      await page.locator("button.ssd-ft-pdf").click();
      const img = page.locator('img[alt="Floor Plan"]');
      await img.waitFor({ timeout: 10000 });
      const src = await img.getAttribute("src");
      const dl = page.waitForEvent("download", { timeout: 10000 });
      await page.getByRole("button", { name: /Download PDF/ }).click();
      const file = await (await dl).path();
      const pdf = readFileSync(file);
      await page.locator("button", { hasText: "✕" }).last().click();
      await settle(page, 300);
      return { src, pdf };
    };
    const off = await pdfSrc();
    ok("G: the workbench is still selected after the PDF preview closes", /Workbench/.test(await selText(page)), await selText(page));
    await setMeasure(page, true);
    ok("G: with Measure on the chips are showing", (await page.locator("svg [data-ss-measure]").count()) === 2);
    const on = await pdfSrc();
    ok("G: the Floorplan PDF preview is the same image with Measure on as off", !!off.src && off.src === on.src, `${off.src && off.src.length} vs ${on.src && on.src.length} chars`);
    ok("G: ...and the downloaded PDF is byte-identical", off.pdf.length > 0 && Buffer.compare(off.pdf, on.pdf) === 0, `${off.pdf.length} vs ${on.pdf.length} bytes`);
    ok("G: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("H")) {
    const { page, errors } = await openWith(ctx, [BENCH]);
    await setMeasure(page, true);
    await clickSvg(page, { x: BENCH.x, y: BENCH.y });
    ok("H: on, the selected workbench has its chips", (await page.locator("svg [data-ss-measure]").count()) === 2);
    await setMeasure(page, false);
    ok("H: turning Measure off removes them", (await page.locator("svg [data-ss-measure]").count()) === 0);
    ok("H: ...and keeps the selection (name in the bar, grips on the plan)", /Workbench/.test(await selText(page)) && (await grips(page)) === 2, `${await selText(page)} grips ${await grips(page)}`);
    await shotPlan(page, "H-measure-off-again.png");
    ok("H: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("I")) {
    const { page, errors } = await openWith(ctx, [BENCH]);
    const tbH = () => page.evaluate(() => document.querySelector(".ssd-tb").getBoundingClientRect().height);
    await setMeasure(page, true);
    const hint = page.locator(".ssd-tb-selw .ssd-tb-sel");
    ok("I: on with nothing selected, the bar says what to do, in the one-line selection box", (await hint.count()) === 1 && (await hint.textContent()) === "Select a wall item to measure", await hint.textContent().catch(() => ""));
    // Scroll the plan into view FIRST (svgPoint does), or the click below scrolls it and the "move" is the page.
    const at = await svgPoint(page, BENCH.x, BENCH.y);
    await shotPlan(page, "I-measure-on-hint.png");
    const h0 = await tbH(), box0 = await planBox(page);
    await page.mouse.click(at.x, at.y);
    await settle(page, 300);
    const h1 = await tbH(), box1 = await planBox(page);
    ok("I: selecting an item swaps the text in that box", /Workbench/.test(await selText(page)) && (await page.locator(".ssd-tb-selw").count()) === 1, await selText(page));
    ok("I: ...and the toolbar keeps its height", near(h0, h1, 0.1), `${h0} -> ${h1}`);
    ok("I: ...so the plan does not move", sameBox(box0, box1), `${JSON.stringify(box0)} -> ${JSON.stringify(box1)}`);
    ok("I: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
    // A tablet-width designer with 3D on: the toolbar row is at its fullest with nothing selected,
    // and the box is what that row leaves over. The hint has to be inside it, not on the hidden line.
    const t = await openWith(ctx, [BENCH], { config: CONFIG_3D });
    await t.page.setViewportSize({ width: 768, height: 1000 });
    await settle(t.page, 700);
    await setMeasure(t.page, true);
    const fit = await t.page.evaluate(() => {
      const w = document.querySelector(".ssd-tb-selw"), h = w && w.querySelector(".ssd-tb-sel");
      if (!w || !h) return null;
      const a = w.getBoundingClientRect(), c = h.getBoundingClientRect();
      return { bp: document.querySelector(".ssd-frame").getAttribute("data-ssd-bp"), inside: c.top >= a.top - 0.5 && c.bottom <= a.bottom + 0.5 && c.width > 0, clipped: h.scrollWidth > h.clientWidth, box: Math.round(a.width), text: Math.round(c.width) };
    });
    ok("I: at 768 with 3D on, the hint sits inside its box, whole", !!fit && fit.inside && !fit.clipped, JSON.stringify(fit));
    ok("I: ...zero page errors there too", t.errors.length === 0, t.errors.join(" | ").slice(0, 300));
    await t.page.close();
  }

  if (want("J")) {
    const nv = { isVent: true, fixtureItemId: "v-std", windowName: "Standard vent", planLabel: "SVNT", widthIn: 12, heightIn: 8, sillFt: null, sillMode: "fixed" };
    const ITEMS = [
      { ...BENCH, id: 1 },
      { id: 2, type: "window", x: px(8), y: G.mgY, rotation: 0, wall: "north", widthFt: 1, heightFt: 0.5, ...nv },
      { id: 3, type: "window", x: G.mgX + G.pW, y: py(4), rotation: 90, wall: "east", widthFt: 1, heightFt: 0.5, ...nv },
      { id: 4, type: "fixtureDoor", x: px(3), y: G.mgY + G.pH, rotation: 0, wall: "south", widthFt: 3, heightFt: 0.5, fixtureItemId: "d-std", doorName: "Single door", planLabel: "SD", price: 300, widthIn: 36, heightIn: 76, swing: "out", operation: "right" },
      { id: 5, type: "window", x: G.mgX + G.pW, y: py(10), rotation: 90, wall: "east", widthFt: 2, heightFt: 0.5, fixtureItemId: "w-23", windowName: "2x3 Window", planLabel: "W23", price: 120, widthIn: 24, heightIn: 36 },
    ];
    // Where to press: just inside the wall line, so the press lands on the item and not on the wall.
    const pressAt = (it) => ({ x: it.wall === "east" ? it.x - 2 : it.x, y: it.wall === "north" && it.type === "window" ? it.y + 2 : it.wall === "south" ? it.y - 2 : it.y });
    const { page, errors } = await openWith(ctx, ITEMS, { config: CONFIG_3D, fixtures: FIXTURES_CAT });
    const read = () => page.evaluate(() => {
      const svg = [...document.querySelectorAll("svg")].find((s) => [...s.querySelectorAll("rect")].some((r) => r.getAttribute("stroke") === "#1E293B"));
      const b = svg.getBoundingClientRect();
      return { box: { x: b.x, y: b.y, w: b.width, h: b.height }, tbH: document.querySelector(".ssd-tb").getBoundingClientRect().height };
    });
    const bad = [];
    let presses = 0;
    for (const w of [850, 900, 1000, 1040, 1100, 1180]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await settle(page, 700);
      for (const on of [false, true]) {
        await setMeasure(page, on);
        for (const it of ITEMS) {
          if (it.isVent && w < 1020) continue;
          await clickSvg(page, EMPTY);
          const cur = ((await readItems(page)) || []).find((i) => i.id === it.id);
          const p = pressAt(cur);
          const at = await svgPoint(page, p.x, p.y);
          const r0 = await read();
          await page.mouse.move(at.x, at.y);
          await page.mouse.down();
          await settle(page, 200);
          const r1 = await read();
          await page.mouse.up();
          await settle(page, 300);
          const r2 = await read();
          const sel = (await selText(page)).trim();
          const name = it.windowName || it.doorName || "Workbench";
          presses++;
          if (!(near(r0.tbH, r1.tbH, 0.5) && near(r0.tbH, r2.tbH, 0.5) && sameBox(r0.box, r1.box) && sameBox(r0.box, r2.box) && sel === `Selected: ${name}`)) {
            bad.push(`${w}px ${on ? "on" : "off"} ${name} (${cur.wall}): bar ${Math.round(r0.tbH)}/${Math.round(r1.tbH)}/${Math.round(r2.tbH)}, plan y ${r0.box.y.toFixed(1)}/${r1.box.y.toFixed(1)}/${r2.box.y.toFixed(1)}, "${sel}"`);
            if (bad.length === 1) await shotPlan(page, `J-fail-${w}-${it.id}.png`);
          }
        }
      }
    }
    ok(`J: pressing a wall item never changes the toolbar's height, moves the plan or loses the selection (${presses} presses, 850-1180px, Measure off and on)`, presses > 0 && bad.length === 0, bad.slice(0, 6).join(" | "));
    ok("J: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }
} finally { await browser.close(); }
console.log(`shots: ${SHOTS}`);
process.exit(failed().length ? 1 : 0);
