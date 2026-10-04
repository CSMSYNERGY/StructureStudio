// THE 2D PLAN'S PLACEMENT RULES, driven through the SHIPPED compiled bundle with real clicks and
// real drags (bug sweep 2026-10-04). Each case is a customer gesture the plan used to get wrong:
//
//   B  a simple ramp added in 2D to a 6 ft catalog double door is as wide as the door (it was
//      drawn 3 ft wide: the generic "fixtureDoor" config's width, never the door's own), the
//      same width the 3D viewer gives it
//   C  a 14 ft workbench dragged from a 16 ft wall onto a 10 ft one is refused and stays on its
//      wall (it used to land there hanging 4 ft past the corner, out through the building)
//   D  stretching the far end of a workbench that was dragged to a spot off the foot grid leaves
//      its near end where it is (it used to jump to the nearest whole foot, into the door beside it)
//   E  stretching a loft that was dragged off the foot grid does not slide its fixed edge into the
//      loft beside it, and a loft stretched toward another stops flush against it, not inside it
//   Each: zero page errors.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/planCore.mjs          (SS_BASE=http://127.0.0.1:<port>, SS_CASES=B,C)
import { launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, revealTool, bypassGate, BASE } from "./lib.mjs";

const W = 10, L = 16, SIZE = `${W}x${L}`;
const CLIENT = "harness-plan-core";
const CONFIG = {
  clientId: CLIENT,
  branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: [{ value: "utility", label: "Utility", img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {} },
    // 10 ft walls: what a vent's height is measured down from.
    { value: "tall", label: "Tall Utility", img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {},
      d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.5 }, siding: "panel", colors: { body: "#eeebe0", trim: "#686c70", roof: "#5f6266" }, wallHeightFt: 10 } }],
  defaultSizes: [SIZE],
  sizePricing: { utility: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } }, tall: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9500 } } },
  options: [], colors: [], claddingOptions: [], wallHeightOptions: {},
  showPricing: true, view3d: false,
  layoutItems: {
    workbench: { icon: "🔧", color: "#8B5E3C", group: "interior", label: "Workbench", width: 4, height: 2, depthIn: 24, modelKey: "wallBench", wallOnly: false, wallSnap: true, shortLabel: "WB", heightOffFloorIn: 36 },
    loft: { icon: "🪜", color: "#A16207", group: "interior", label: "Loft Area", width: 4, height: 4, shortLabel: "LOFT" },
  },
  layoutPricing: { workbench: { rate: 25, method: "lineal_ft", byStyle: {} }, loft: { rate: 40, method: "sqft_option", byStyle: {} } },
  layoutPrices: {}, electrical: null, electricalItems: [], insulation: [],
};
const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: true, imageUrl: null, showImage: false },
  items: [{ id: "d-dbl", name: "Harness Double Door", price: 600, widthIn: 72, heightIn: 80, category: "door", colorMode: "fixed", planLabel: "DD", sortOrder: 0, imageUrl: null,
    sillIn: null, sillMode: "fixed", opLeft: false, opRight: false, opDouble: true, opSlideUp: false, opDefault: "double", swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false },
  { id: "d-sgl", name: "Harness Single Door", price: 300, widthIn: 36, heightIn: 80, category: "door", colorMode: "fixed", planLabel: "SD", sortOrder: 1, imageUrl: null,
    sillIn: null, sillMode: "fixed", opLeft: false, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right", swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false },
  // A loft door: 90 in off the floor (doorSillStamps), the one door a ramp can never anchor to.
  { id: "d-loft", name: "Harness Loft Door", price: 400, widthIn: 36, heightIn: 48, category: "door", colorMode: "fixed", planLabel: "LD", sortOrder: 2, imageUrl: null,
    sillIn: 90, sillMode: "fixed", opLeft: false, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right", swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false }],
  windowColors: [],
};
const only = (process.env.SS_CASES || "").split(",").filter(Boolean);
const want = (id) => !only.length || only.includes(id);
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const { ok, failed } = reporter();

async function chooseSize(page) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
  if (await sel.count()) await sel.first().selectOption({ label: SIZE });
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 15000 });
  await settle(page, 500);
}
const planReady = (page) => page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });

// The plan geometry in feet: SVG x/y of a point `xFt, yFt` inside the building.
async function geom(page) {
  const r = await buildingRect(page);
  const sc = r.w / W;
  return { r, sc, at: (xFt, yFt) => ({ x: r.x + xFt * sc, y: r.y + yFt * sc }), ftX: (x) => (x - r.x) / sc, ftY: (y) => (y - r.y) / sc };
}
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

// A design opened from a share link: the only way to start from an exact layout, off the foot grid
// where a free drag leaves things.
async function openWith(ctx, items, style = "utility") {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const row = {
    short_code: "SS-HARNPC01", status: "draft", selections: { style, size: SIZE }, items,
    contact: { name: "", email: "", phone: "", street: "", city: "", state: "", zip: "" },
    paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
  };
  await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [row] } });
  await bypassGate(page, CLIENT);
  await page.goto(`${BASE}/?client=${encodeURIComponent(CLIENT)}&id=SS-HARNPC01`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  await planReady(page);
  for (let k = 0; k < 40; k++) { const it = await readItems(page); if (it && it.length === items.length) break; await settle(page, 250); }
  await settle(page, 600);
  return { page, errors };
}
// Page coordinates for an item at (xFt, yFt), from the same formula the designer uses (pageGeom).
function pageGeom(bw, bh) {
  const visibleH = 1100 - 340;
  const scale = Math.min((850 * 0.70) / bw, (visibleH * 0.70) / bh, (visibleH - 60) / (bh + 4));
  const pW = bw * scale, pH = bh * scale;
  return { scale, pW, pH, mgX: (850 - pW) / 2, mgY: 2 * scale + 30 };
}
const G = pageGeom(W, L);
const px = (xFt) => G.mgX + xFt * G.scale, py = (yFt) => G.mgY + yFt * G.scale;

const { browser, ctx } = await launch({ width: 1280, height: 1000 });
try {
  if (want("B")) {
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
    await openDesigner(page, CLIENT);
    await planReady(page);
    await chooseSize(page);
    const g = await geom(page);
    await (await revealTool(page, /^Door wall$/)).click();
    await settle(page, 300);
    await clickSvg(page, g.at(W / 2, L - 0.3));
    await page.getByText(FIXTURES.items[0].name, { exact: true }).first().click({ timeout: 10000 });
    await settle(page, 300);
    await page.getByRole("button", { name: "Place door" }).click();
    await settle(page, 600);
    await (await revealTool(page, /Ramp/)).click();
    await settle(page, 300);
    await clickSvg(page, g.at(W / 2, L + 0.5));
    const items = (await readItems(page)) || [];
    const door = items.find((i) => i.type === "fixtureDoor"), ramp = items.find((i) => i.type === "ramp");
    ok("B: a 6 ft double door and a simple ramp are on the plan", !!door && !!ramp && Math.abs(door.widthFt - 6) < 1e-6, JSON.stringify({ door: door && door.widthFt, ramp: ramp && ramp.widthFt }));
    ok("B: the ramp is as wide as its 6 ft door (the 3D viewer's width for the same click)", !!ramp && Math.abs(ramp.widthFt - 6) < 1e-6, `ramp widthFt ${ramp && ramp.widthFt}`);
    // Swap the door for the 3 ft one: the simple ramp follows the door's width as well as its spot.
    if (door) {
      // Clicking the door's bar selects the DOOR, which is drawn on top of its ramp — not the ramp.
      await clickSvg(page, { x: door.x, y: door.y });
      const selTxt = await page.locator(".ssd-tb-sel").first().textContent().catch(() => "");
      ok("B: clicking the door (drawn over its ramp) selects the door, not the ramp", /Harness Double Door/.test(selTxt || ""), selTxt);
      // ...and clicking the ramp's own body, out past the door bar, still selects the ramp.
      await clickSvg(page, ramp ? { x: ramp.x, y: ramp.y + 0.6 * (await geom(page)).sc } : { x: 0, y: 0 });
      const selRamp = await page.locator(".ssd-tb-sel").first().textContent().catch(() => "");
      ok("B: clicking the ramp's body still selects the ramp", /Ramp/.test(selRamp || ""), selRamp);
      await clickSvg(page, { x: door.x, y: door.y });
      await page.getByRole("button", { name: /Swap/ }).first().click();
      await settle(page, 300);
      await page.getByText(FIXTURES.items[1].name, { exact: true }).first().click({ timeout: 10000 });
      await settle(page, 300);
      await page.getByRole("button", { name: "Place door" }).click();
      await settle(page, 600);
      const it2 = (await readItems(page)) || [];
      const d2 = it2.find((i) => i.type === "fixtureDoor"), r2 = it2.find((i) => i.type === "ramp");
      ok("B: after swapping to the 3 ft door its simple ramp is 3 ft wide too", !!d2 && !!r2 && Math.abs(d2.widthFt - 3) < 1e-6 && Math.abs(r2.widthFt - 3) < 1e-6,
        JSON.stringify({ door: d2 && d2.widthFt, ramp: r2 && r2.widthFt }));
      // G: swapping that ramped walk door for a LOFT door (7'6" up) is refused: no ramp under a raised door.
      if (d2) {
        await clickSvg(page, { x: d2.x, y: d2.y });
        await page.getByRole("button", { name: /Swap/ }).first().click();
        await settle(page, 300);
        await page.getByText(FIXTURES.items[2].name, { exact: true }).first().click({ timeout: 10000 });
        await settle(page, 300);
        await page.getByRole("button", { name: "Place door" }).click();
        await settle(page, 600);
        const it3 = (await readItems(page)) || [];
        const d3 = it3.find((i) => i.type === "fixtureDoor"), r3 = it3.find((i) => i.type === "ramp");
        const said = await page.evaluate(() => document.body.innerText.includes("remove the ramp first"));
        ok("G: a ramped walk door is not swapped for a loft door (the ramp would stand under a raised door)",
          !!d3 && d3.fixtureItemId === "d-sgl" && !d3.sillFt && !!r3 && r3.snapDoorId === d3.id, JSON.stringify({ door: d3 && d3.fixtureItemId, sill: d3 && d3.sillFt, ramp: !!r3 }));
        ok("G: ...and the refusal says why", said);
      }
    }
    ok("B: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("C")) {
    // A 14 ft bench centred on the 16 ft east wall, dragged to the middle of the 10 ft north wall.
    const bench = { id: 1, type: "workbench", x: G.mgX + G.pW - 1 * G.scale, y: py(8), rotation: 90, wall: "east", widthFt: 14, heightFt: 2, depthIn: 24, heightOffFloorIn: 36 };
    const { page, errors } = await openWith(ctx, [bench]);
    const before = ((await readItems(page)) || [])[0];
    ok("C: the 14 ft bench opens on the 16 ft east wall", before && before.wall === "east" && before.widthFt === 14, JSON.stringify(before && { wall: before.wall, w: before.widthFt }));
    await drag(page, { x: before.x, y: before.y }, { x: px(5), y: py(0.6) });
    const after = ((await readItems(page)) || [])[0];
    const g = await geom(page);
    const span = after && (after.wall === "north" || after.wall === "south")
      ? [g.ftX(after.x) - after.widthFt / 2, g.ftX(after.x) + after.widthFt / 2] : [g.ftY(after.y) - after.widthFt / 2, g.ftY(after.y) + after.widthFt / 2];
    const wallLen = after && (after.wall === "north" || after.wall === "south") ? W : L;
    ok("C: the bench never ends up hanging past a corner", span[0] > -0.01 && span[1] < wallLen + 0.01, `${after && after.wall} ${span.map((v) => v.toFixed(2)).join("..")} on a ${wallLen} ft wall`);
    ok("C: it stays on the east wall", after && after.wall === "east", after && after.wall);
    ok("C: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("D")) {
    // North wall: a 3 ft door over 1.2..4.2 ft and a 4 ft bench over 4.4..8.4 ft, 0.2 ft apart.
    const door = { id: 1, type: "fixtureDoor", x: px(2.7), y: G.mgY, rotation: 0, wall: "north", widthFt: 3, heightFt: 0.5, fixtureItemId: "d-dbl", doorName: "Harness Door", widthIn: 36, heightIn: 80, swing: "out", operation: "right" };
    const bench = { id: 2, type: "workbench", x: px(6.4), y: G.mgY + 1 * G.scale, rotation: 0, wall: "north", widthFt: 4, heightFt: 2, depthIn: 24, heightOffFloorIn: 36 };
    const { page, errors } = await openWith(ctx, [door, bench]);
    const g = await geom(page);
    const b0 = ((await readItems(page)) || []).find((i) => i.type === "workbench");
    const left0 = g.ftX(b0.x) - b0.widthFt / 2;
    ok("D: the bench opens 0.2 ft clear of the door", Math.abs(left0 - 4.4) < 0.02, `left ${left0.toFixed(3)}`);
    await clickSvg(page, { x: b0.x, y: b0.y });          // select it so its stretch grips show
    const iw = b0.widthFt * g.sc, endZ = Math.min(Math.max(iw / 4, 16), 30, iw * 0.45);
    const grip = { x: b0.x + iw / 2 - endZ / 2, y: b0.y };
    await drag(page, grip, { x: px(9.2), y: b0.y });
    const b1 = ((await readItems(page)) || []).find((i) => i.type === "workbench");
    const left1 = g.ftX(b1.x) - b1.widthFt / 2, right1 = g.ftX(b1.x) + b1.widthFt / 2;
    ok("D: stretching the far end leaves the near end where it was", Math.abs(left1 - left0) < 0.02, `near end ${left0.toFixed(3)} -> ${left1.toFixed(3)}`);
    ok("D: ...so it is still clear of the door (door ends at 4.2 ft)", left1 > 4.2, `near end ${left1.toFixed(3)}`);
    ok("D: the length still steps by whole feet", Math.abs(b1.widthFt - Math.round(b1.widthFt)) < 1e-9 && b1.widthFt > b0.widthFt, `width ${b1.widthFt}`);
    ok("D: and the far end stays on the wall", right1 <= W + 0.01, `far end ${right1.toFixed(3)}`);
    ok("D: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }

  if (want("E")) {
    // Two wall-to-wall lofts, dragged off the grid so they touch at 8.4 ft: A over 4.4..8.4, B over 8.4..12.4.
    const A = { id: 1, type: "loft", x: px(5), y: py(6.4), rotation: 0, wall: null, widthFt: 10, heightFt: 4, elevationFt: 7 };
    const B = { id: 2, type: "loft", x: px(5), y: py(10.4), rotation: 0, wall: null, widthFt: 10, heightFt: 4, elevationFt: 7 };
    const { page, errors } = await openWith(ctx, [A, B]);
    const g = await geom(page);
    const edges = (it) => ({ t: g.ftY(it.y) - it.heightFt / 2, b: g.ftY(it.y) + it.heightFt / 2 });
    const get = async (id) => ((await readItems(page)) || []).find((i) => i.id === id);
    const B0 = await get(2);
    ok("E: loft B opens touching loft A at 8.4 ft", Math.abs(edges(B0).t - 8.4) < 0.02, JSON.stringify(edges(B0)));
    // 1. Stretch B's BOTTOM edge down a foot: its top must stay at 8.4.
    await clickSvg(page, { x: B0.x, y: B0.y });
    let ih = B0.heightFt * g.sc, iw = B0.widthFt * g.sc;
    let hz = Math.min(Math.max(ih / 3, 22), 36, ih * 0.5);
    await drag(page, { x: B0.x, y: B0.y + ih / 2 - hz / 4 }, { x: B0.x, y: py(13.4) });
    const B1 = await get(2);
    ok("E: stretching B's bottom leaves its top on A's edge (no slide into A)", Math.abs(edges(B1).t - 8.4) < 0.02, JSON.stringify(edges(B1)));
    // 2. Push B's TOP edge up into A: it must stop flush at 8.4, never inside A.
    ih = B1.heightFt * g.sc;
    hz = Math.min(Math.max(ih / 3, 22), 36, ih * 0.5);
    await clickSvg(page, { x: B1.x, y: B1.y });
    await drag(page, { x: B1.x, y: B1.y - ih / 2 + hz / 4 }, { x: B1.x, y: py(6) });
    const B2 = await get(2), A2 = await get(1);
    ok("E: B's top pushed up into A stops flush, not inside it", edges(B2).t >= edges(A2).b - 0.1 && Math.abs(edges(B2).t - edges(A2).b) < 0.31, `A bottom ${edges(A2).b.toFixed(3)} B top ${edges(B2).t.toFixed(3)}`);
    void iw;
    ok("E: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }
  if (want("F")) {
    // 10 ft walls. A vent at its top spot on the north wall (8'8"..9'8" off the floor), and a 4 ft
    // tall catalog window (3'6"..7'6") further along the same wall, dragged in under the vent.
    const vent = { id: 1, type: "window", x: px(7), y: G.mgY, rotation: 0, wall: "north", widthFt: 1, heightFt: 0.5, isVent: true,
      fixtureItemId: "v-std", windowName: "Harness Vent", planLabel: "VENT", widthIn: 12, heightIn: 12, sillFt: null, sillMode: "fixed" };
    const win = { id: 2, type: "window", x: px(2), y: G.mgY, rotation: 0, wall: "north", widthFt: 3, heightFt: 0.5,
      fixtureItemId: "w-48", windowName: "Harness Tall Window", planLabel: "W48", widthIn: 36, heightIn: 48 };
    const { page, errors } = await openWith(ctx, [vent, win], "tall");
    const w0 = ((await readItems(page)) || []).find((i) => i.id === 2);
    await drag(page, { x: w0.x, y: w0.y }, { x: px(7), y: w0.y });
    const w1 = ((await readItems(page)) || []).find((i) => i.id === 2);
    const g = await geom(page);
    ok("F: on a 10 ft wall a 4 ft window drags in under a top-spot vent (as the 3D allows)", w1 && Math.abs(g.ftX(w1.x) - 7) < 0.15, `window centre ${w1 && g.ftX(w1.x).toFixed(2)} ft`);
    ok("F: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }
  if (want("H")) {
    // The electrical package on a 12x24 (12 outlets, 2 lights, 1 switch), then the customer picks
    // 10x12, whose standard is 7 outlets, 1 light, 1 switch. Every device is charged at
    // max(0, placed - covered), so whatever is left on the plan past the new standard is billed.
    const BIG = "12x24", SMALL = "10x12";
    const ELEC = {
      ...CONFIG, clientId: "harness-plan-elec",
      buildingStyles: [{ value: "utility", label: "Utility", img: null, sizes: [BIG, SMALL], sizeInclusions: {}, sizeInclusionQty: {} }],
      defaultSizes: [BIG, SMALL],
      sizePricing: { utility: { [BIG]: { widthFt: 12, lengthFt: 24, basePrice: 9000 }, [SMALL]: { widthFt: 10, lengthFt: 12, basePrice: 6000 } } },
      electrical: { label: "Electrical Package", price: 850, includePanel: false, outletItemId: "e-out", switchItemId: "e-sw", lightItemId: "e-lt",
        outletSpacingFt: 6, lightSpacingFt: 10, outletHeightIn: 18, switchHeightIn: 48, outletAboveBenchIn: 42 },
      electricalItems: [
        { id: "e-out", icon: "🔌", name: "Outlet", mount: "wall", withPackage: true, standalone: false, priceWithPackage: 45, priceStandalone: null, heightOffFloorIn: 18 },
        { id: "e-sw", icon: "🎚️", name: "Light Switch", mount: "wall", withPackage: true, standalone: false, priceWithPackage: 35, priceStandalone: null, heightOffFloorIn: 48 },
        { id: "e-lt", icon: "💡", name: "Light", mount: "ceiling", withPackage: true, standalone: false, priceWithPackage: 65, priceStandalone: null, heightOffFloorIn: 96 },
      ],
    };
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    await stubSupabase(page, { config: ELEC, fixtures: FIXTURES });
    await openDesigner(page, ELEC.clientId);
    await planReady(page);
    const pickSize = async (label, lenFt) => {
      const sel = page.locator("select").filter({ has: page.locator("option", { hasText: label }) });
      await sel.first().selectOption({ label });
      await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), lenFt, { timeout: 15000 });
      await settle(page, 600);
    };
    await pickSize(BIG, 24);
    await (await revealTool(page, /Electrical Package/)).click();
    await settle(page, 600);
    const count = async () => {
      const its = (await readItems(page)) || [];
      const n = (id) => its.filter((i) => i.electricalItemId === id).length;
      return { outlet: n("e-out"), light: n("e-lt"), sw: n("e-sw") };
    };
    const big = await count();
    ok("H: the package lays out 12 outlets, 2 lights and a switch on the 12x24", big.outlet === 12 && big.light === 2 && big.sw === 1, JSON.stringify(big));
    await pickSize(SMALL, 12);
    const small = await count();
    ok("H: after picking 10x12 nothing is left on the plan past the new standard (7 outlets, 1 light, 1 switch)",
      small.outlet <= 7 && small.light <= 1 && small.sw <= 1, JSON.stringify(small));
    ok("H: ...and the 10x12 standard is laid out in full", small.outlet === 7 && small.light === 1 && small.sw === 1, JSON.stringify(small));
    ok("H: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  }
} finally { await browser.close(); }
process.exit(failed().length ? 1 : 0);
