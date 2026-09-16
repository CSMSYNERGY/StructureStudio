// Electrical devices are wall ITEMS, not workbenches — driven in the real designer.
//
// Carolyn, 2026-09-14, on the expo demo build: "the shelf can't pass the electrical", a flood
// light refused with "something else is already mounted there", and a light over a door refused.
// The unit tests (_shared/_test_stubs/wallSlab_test.ts, electricalLayout_test.ts) pin the rules;
// this proves the SHIPPED compiled bundle behaves, through real clicks and a real drag:
//
//   1. the electrical package lays out its outlets
//   2. a workbench DRAGGED across an outlet moves, with no refusal toast
//   3. a shelf clicked onto the wall above an outlet is placed
//   4. a flood light placed from the electrical picker over that workbench is placed
//   5. the selected-item toolbar says "Remove", not "Delete"
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/electrical.mjs              (exit 0 = every check held)
//
// The config is written here rather than read from a tenant, so the run needs no network and
// names no client: Outlet 18" (package), Light Switch 48", Light (ceiling), Flood Light 120"
// (wall), Ceiling Fan (ceiling), and the builder's shelving with a deliberately LONG shelf name.
import { pathToFileURL } from "node:url";
import { launch, stubSupabase, recordRefusals, refusalsSince, waitNoRefusal, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir, revealTool } from "./lib.mjs";

const CLIENT = "harness-electrical";
const W = 12, L = 24;
export const LONG_SHELF = "Heavy-Duty Single Shelf with Pegboard Back";

export const CONFIG = {
  clientId: CLIENT,
  branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: [{ value: "utility", label: "Utility", img: null, sizes: [`${W}x${L}`], sizeInclusions: {}, sizeInclusionQty: {} }],
  defaultSizes: [`${W}x${L}`],
  sizePricing: { utility: { [`${W}x${L}`]: { widthFt: W, lengthFt: L, basePrice: 9000 } } },
  options: [],
  colors: [],
  claddingOptions: [],
  wallHeightOptions: {},
  showPricing: true,
  view3d: true,
  layoutItems: {
    workbench: { icon: "🔧", color: "#8B5E3C", group: "interior", label: "Workbench", width: 4, height: 2, depthIn: 36, modelKey: "wallBench", wallOnly: false, wallSnap: true, shortLabel: "WB", heightOffFloorIn: 36 },
    shelf: { icon: "📚", color: "#D97706", group: "interior", label: LONG_SHELF, width: 4, height: 1, depthIn: 24, modelKey: "wallShelf", wallOnly: false, wallSnap: true, shortLabel: "SHELF", heightOffFloorIn: 48 },
  },
  layoutPricing: {
    workbench: { rate: 25, method: "lineal_ft", byStyle: {} },
    shelf: { rate: 12, method: "lineal_ft", byStyle: {} },
  },
  layoutPrices: {},
  electrical: {
    label: "Electrical Package", price: 850, includePanel: false,
    outletItemId: "e-out", switchItemId: "e-sw", lightItemId: "e-lt",
    outletSpacingFt: 6, lightSpacingFt: 10, outletHeightIn: 18, switchHeightIn: 48, outletAboveBenchIn: 42,
  },
  electricalItems: [
    { id: "e-out", icon: "🔌", name: "Outlet", mount: "wall", withPackage: true, standalone: false, priceWithPackage: 45, priceStandalone: null, heightOffFloorIn: 18 },
    { id: "e-sw", icon: "🎚️", name: "Light Switch", mount: "wall", withPackage: true, standalone: false, priceWithPackage: 35, priceStandalone: null, heightOffFloorIn: 48 },
    { id: "e-lt", icon: "💡", name: "Light", mount: "ceiling", withPackage: true, standalone: false, priceWithPackage: 65, priceStandalone: null, heightOffFloorIn: 96 },
    { id: "e-flood", icon: "🔦", name: "Flood Light", mount: "wall", withPackage: true, standalone: true, priceWithPackage: 120, priceStandalone: 185, heightOffFloorIn: 120 },
    { id: "e-fan", icon: "🌀", name: "Ceiling Fan", mount: "ceiling", withPackage: true, standalone: true, priceWithPackage: 285, priceStandalone: 395, heightOffFloorIn: 96 },
  ],
  insulation: [],
};

const settle = (page, ms = 350) => page.waitForTimeout(ms);

// Screen point for a spot `alongFt` along the NORTH wall, just inside it.
async function northWall(page, alongFt) {
  const r = await buildingRect(page);
  return svgPoint(page, r.x + (alongFt / W) * r.w, r.y + 0.4 * (r.h / L));
}

// Shelving is ONE palette button that opens a picker (ShelfPicker). Matched by its 📚 icon, not
// its text: once a shelf type is armed the button RELABELS itself to that type ("Workbench
// wall"), so a /Shelving/ locator stops matching after the first placement.
async function armSlab(page, label) {
  if (await page.getByText("Add an electrical item").count()) await page.keyboard.press("Escape");
  await (await revealTool(page, /^📚/)).click();
  await settle(page, 300);
  await page.getByText(label, { exact: true }).last().click();
  await settle(page, 300);
}

// The style auto-selects (there is one), but the SIZE is a <select> that starts on "Select a
// size…" while the plan draws a 10x12 placeholder. Every wall coordinate below assumes 12x24,
// so choose it explicitly and wait for the dimension label to prove it took.
export async function chooseSize(page) {
  const label = `${W}x${L}`;
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: label }) });
  if (await sel.count()) await sel.first().selectOption({ label });
  else await page.getByText(label, { exact: true }).first().click();
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 15000 });
}

export async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("electrical");
  const { browser, ctx } = await launch({ width: 1280, height: 900 });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const calls = await stubSupabase(page, { config: CONFIG });
  await recordRefusals(page);

  try {
    await openDesigner(page, CLIENT);
    await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
    await chooseSize(page);
    await settle(page, 600);

    // ── 1. The package lays out its outlets ──────────────────────────────────
    await (await revealTool(page, /Electrical Package/)).click();
    await settle(page, 600);
    let items = await readItems(page);
    const outlets = () => items.filter((i) => i.type === "e-out");
    // 12x24: 72 ft of perimeter / 6 ft = 12.
    ok("package lays out 12 outlets on a 12x24", outlets().length === 12, `got ${outlets().length}`);
    ok("every outlet sits at the builder's 18in", outlets().every((i) => i.heightOffFloorIn === 18),
      JSON.stringify([...new Set(outlets().map((i) => i.heightOffFloorIn))]));
    const northOutlets = outlets().filter((i) => i.wall === "north").sort((a, b) => a.x - b.x);
    ok("two outlets on the north wall", northOutlets.length === 2, `got ${northOutlets.length}`);
    await page.screenshot({ path: `${shots}/1-package-on.png` });

    // ── 2. A workbench dragged across an outlet ──────────────────────────────
    // Placed between the two north outlets (3 ft and 9 ft) where it touches neither, then dragged
    // until its centre sits on the 3 ft outlet. Before 2026-09-15 the drag was refused with "A
    // workbench or shelf is in the way at that height", because every outlet was a legacy slab.
    await armSlab(page, "Workbench");
    const midP = await northWall(page, 6);
    await page.mouse.click(midP.x, midP.y);
    await settle(page);
    items = await readItems(page);
    const bench = items.find((i) => i.type === "workbench");
    ok("workbench placed on the north wall between the outlets", bench && bench.wall === "north", JSON.stringify(bench && { wall: bench.wall, x: bench.x }));
    if (bench) {
      const target = northOutlets[0];
      const from = await svgPoint(page, bench.x, bench.y);
      const to = await svgPoint(page, target.x, bench.y);
      await waitNoRefusal(page);
      const t0 = await page.evaluate(() => Date.now());
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x - 6, from.y, { steps: 3 });
      await page.mouse.move(to.x, to.y, { steps: 20 });
      await settle(page, 200);
      await page.screenshot({ path: `${shots}/2-bench-over-outlet-mid-drag.png` });
      await page.mouse.up();
      await settle(page, 500);
      items = await readItems(page);
      const moved = items.find((i) => i.id === bench.id);
      const refusals = await refusalsSince(page, t0);
      ok("the dragged workbench now sits over the outlet", moved && Math.abs(moved.x - target.x) < 6,
        `bench x ${moved && Math.round(moved.x)} vs outlet x ${Math.round(target.x)}`);
      ok("no refusal toast during the drag", refusals.length === 0, refusals.join(" | "));
      await page.screenshot({ path: `${shots}/2-bench-over-outlet.png` });
    }

    // ── 3. A shelf above an outlet ───────────────────────────────────────────
    // The 9 ft outlet (18in) under a 48in shelf. Before: "Something else is already mounted there."
    {
      await waitNoRefusal(page);
      const t0 = await page.evaluate(() => Date.now());
      await armSlab(page, LONG_SHELF);
      const p = await northWall(page, 9);
      await page.mouse.click(p.x, p.y);
      await settle(page);
      items = await readItems(page);
      const shelf = items.find((i) => i.type === "shelf");
      const refusals = await refusalsSince(page, t0);
      ok("shelf placed on the wall above the 9 ft outlet", shelf && shelf.wall === "north" && Math.abs(shelf.x - northOutlets[1].x) < 1.5 * ((await buildingRect(page)).w / W),
        JSON.stringify(shelf && { wall: shelf.wall, x: Math.round(shelf.x), outletX: Math.round(northOutlets[1].x) }));
      ok("no refusal toast placing the shelf", refusals.length === 0, refusals.join(" | "));
      await page.screenshot({ path: `${shots}/3-shelf-over-outlet.png` });
    }

    // ── 4. A flood light over the workbench ──────────────────────────────────
    // 120in clears the bench (0..36in) and the outlet under it. Before: refused, because the flood
    // light was itself a full-height legacy slab.
    {
      await waitNoRefusal(page);
      const t0 = await page.evaluate(() => Date.now());
      await (await revealTool(page, /Electrical Items/)).click();
      await settle(page, 300);
      await page.getByText("Flood Light", { exact: true }).first().click();
      await settle(page, 300);
      const p = await northWall(page, 3);
      await page.mouse.click(p.x, p.y);
      await settle(page);
      items = await readItems(page);
      const flood = items.find((i) => i.type === "e-flood");
      const refusals = await refusalsSince(page, t0);
      ok("flood light placed on the north wall over the workbench", flood && flood.wall === "north" && flood.heightOffFloorIn === 120,
        JSON.stringify(flood && { wall: flood.wall, h: flood.heightOffFloorIn }));
      ok("no refusal toast placing the flood light", refusals.length === 0, refusals.join(" | "));
      await page.screenshot({ path: `${shots}/4-flood-light.png` });
    }

    // ── 5. One word: Remove ──────────────────────────────────────────────────
    // Selects the WORKBENCH, the one item every build places (step 2's first click is never in
    // anyone's way). Selecting the shelf made this vacuous on an old bundle: no shelf, no
    // selection, no toolbar — and "no Delete button" passed for want of a toolbar.
    {
      const wb = items.find((i) => i.type === "workbench");
      ok("an item is selected for the toolbar check", !!wb);
      if (wb) {
        const p = await svgPoint(page, wb.x, wb.y);
        await page.mouse.click(p.x, p.y);
        await settle(page);
      }
      const removeBtn = page.getByRole("button", { name: "🗑 Remove", exact: true });
      ok("selected-item toolbar shows \"🗑 Remove\"", (await removeBtn.count()) === 1, `count ${await removeBtn.count()}`);
      // Only meaningful with the toolbar actually up: "no Delete" on a page with no toolbar at all
      // proves nothing (on an old bundle a still-armed tool swallows the selecting click).
      const rotateN = await page.getByRole("button", { name: /Rotate/ }).count();
      const deleteN = await page.getByRole("button", { name: /Delete/ }).count();
      ok("no \"Delete\" beside Rotate on the selected-item toolbar", rotateN === 1 && deleteN === 0, `rotate ${rotateN}, delete ${deleteN}`);
      await page.screenshot({ path: `${shots}/5-remove-toolbar.png` });
    }

    ok("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
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
  return bad.length;
}

// Run when invoked directly; stay quiet when another harness imports CONFIG from here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((n) => process.exit(n ? 1 : 0));
}
