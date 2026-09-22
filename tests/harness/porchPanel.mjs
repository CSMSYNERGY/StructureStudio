// The calibration panel's PORCH controls, driven, with the SAVE PAYLOAD read off the wire.
//
// The panel picks None / Recessed / Projecting for a style (roof.porchDepthFt or roof.porchOutFt,
// 2026-09-17), sets one depth, a porch end, a timber truss for a recessed gable porch, the projecting
// porch's wood colour (colors.wood) and a plate band (roof.plateBand). What matters is what reaches
// the column, so every check below reads the body of the admin-save-settings call the page really
// sent after a real Save press, and the controls are the real ones, clicked and typed into:
//
//   1. Projecting at 6.5 ft with the band ticked, over a stored recessed porch with a truss, saves
//      porchOutFt 6.5 and plateBand true, with no porchDepthFt and no porchTruss; porchEnd is kept
//   2. switching to Recessed carries the depth: porchDepthFt 6.5 and no porchOutFt
//   3. None removes both depths and keeps porchEnd
//   4. unticking the band removes plateBand; it never saves plateBand false
//   5. typing a wood colour saves colors.wood; clearing the box removes the key
//   6. a style with no porch, opened and saved untouched, sends no porchOutFt, porchDepthFt,
//      plateBand or wood key
//   7. the projecting readout ("Posts ... clear") shows, and turns amber at 7 ft walls
//   8. the truss box shows only for a recessed porch on a gable roof; the wood box only for a
//      projecting porch
//   9. the BUILDER-ONLY cards stay off this surface: no step 1, no step 2, no Generate
//  10. zero page errors
//
// The public ?admin=1 operator page, with Supabase stubbed at the network layer (lib.mjs): no login,
// and nothing leaves the machine, so no save ever reaches a database. It exercises the COMPILED
// bundle, so a source change that was never `npm run compile`d is invisible here.
//
//   python -m http.server 8125 --bind 127.0.0.1                  (repo root)
//   node tests/harness/porchPanel.mjs
//
// Exit 0 = every assertion held.
import { pathToFileURL } from "node:url";
import { launch, stubSupabase, collectErrors, reporter, BASE } from "./lib.mjs";

const SIZE = "16x24";
const COLORS = { body: "#eeebe0", trim: "#686c70", roof: "#5f6266" };
// A recessed gable porch with a truss, on its BACK end: switching it to projecting must drop the depth
// and the truss and keep the end.
const PORCH_ROOF = { type: "gable", pitch: 0.4, overhang: 0.6, porchDepthFt: 4, porchTruss: true, porchEnd: "back" };
const PLAIN_ROOF = { type: "gambrel", pitch: 0.4, overhang: 0.5, kneeU: 0.6, kneeRise: 0.6, ridgeRise: 0.9 };
const STYLES = [
  { value: "porchbarn", label: "Harness Porch Barn", d3: { roof: PORCH_ROOF, siding: "lap", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { value: "plainbarn", label: "Harness Plain Barn", d3: { roof: PLAIN_ROOF, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "shingle" } },
].map((s) => ({ ...s, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {} }));
const CONFIG = {
  clientId: "harness-porch-panel",
  branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: STYLES,
  defaultSizes: [SIZE],
  sizePricing: Object.fromEntries(STYLES.map((s) => [s.value, { [SIZE]: { widthFt: 16, lengthFt: 24, basePrice: 9000 } }])),
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };
// The readout's two colours: the dormer readout's, #A16207 normal and #B45309 amber.
const NORMAL = "rgb(161, 98, 7)", AMBER = "rgb(180, 83, 9)";

const settle = (page, ms = 250) => page.waitForTimeout(ms);
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const keys = (o) => Object.keys(o || {}).sort().join(",");

// The calibration panel's controls, each found by the label it sits in.
const field = (page, text) => page.locator("label").filter({ hasText: text });
const porchSelect = (page) => page.locator("label").filter({ has: page.locator('option[value="projecting"]') }).locator("select");
const depthInput = (page) => field(page, /^Depth \(ft\)/).locator('input[type="number"]');
const bandBox = (page) => field(page, "Trim band across both gable ends at the top of the wall").locator('input[type="checkbox"]');
const trussBox = (page) => field(page, "Timber truss in the porch gable").locator('input[type="checkbox"]');
const woodInput = (page) => field(page, "Wood colour (posts, deck, ceiling)").locator('input[type="text"]');
const readout = (page) => page.locator("div").filter({ hasText: /^(Posts .* clear, porch roof meets the wall at |Walls this short leave )/ });

async function openAdmin(page) {
  await page.goto(`${BASE}/?client=${encodeURIComponent(CONFIG.clientId)}&admin=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
  await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
  // The operator save refuses without a password; the stub accepts anything.
  await page.getByPlaceholder("Admin password").fill("harness");
}
async function openStyle(page, label) {
  const btn = page.getByRole("button", { name: label, exact: true });
  await btn.first().waitFor({ state: "visible", timeout: 30000 });
  await btn.first().click();
  await porchSelect(page).waitFor({ state: "visible", timeout: 15000 });
  await settle(page);
}
// A number field typed into the way a builder does, then left, so its draft commits and clears.
async function typeNumber(page, input, value) {
  await input.click();
  await input.fill(String(value));
  await page.keyboard.press("Tab");
  await settle(page);
}
// Press Save and return the d3 of the admin-save-settings call it sent.
async function save(page, calls) {
  const saves = () => calls.filter((c) => c.path && c.path.endsWith("/functions/v1/admin-save-settings") && c.body && c.body.action === "save_style_d3");
  const before = saves().length;
  await page.getByRole("button", { name: "Save to config" }).click();
  const t0 = Date.now();
  while (saves().length === before) {
    if (Date.now() - t0 > 15000) throw new Error("Save sent no admin-save-settings call");
    await settle(page, 100);
  }
  await page.getByText("Saved — reload the page to see it live.").waitFor({ state: "visible", timeout: 15000 });
  return saves()[saves().length - 1].body;
}

export async function main() {
  const { ok, failed } = reporter();
  const { browser, ctx } = await launch({ width: 1280, height: 900 });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const calls = await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  try {
    await openAdmin(page);
    await openStyle(page, "Harness Porch Barn");

    // -- 9. WHAT AN OPERATOR IS NOT SHOWN --
    // This page has no `setup3d`, so it has no walk-around card and no Generate button. The
    // dimensions card was left ungated when it landed, which put a "Step 2 - The size of the
    // building you filmed" here, with an amber "required" badge that gated nothing, above a
    // step 3 and below no step 1 - and its width and length were pure local state that the
    // next style click silently discarded. The wall height already has its own field here.
    ok("the operator page has no Step 1 walk-around card",
      !(await page.getByText("Step 1 — Walk-around video").count()));
    ok("...and no Generate button", !(await page.getByRole("button", { name: /Generate the 3D model/ }).count()));
    ok("⚠️ ...so it must not show Step 2 either", !(await page.locator('[data-ssc-card="dims"]').count()));
    ok("...and still offers the wall height it CAN save",
      (await page.locator("label").filter({ hasText: "Wall height (ft)" }).count()) >= 1);
    // ⚠️ AND THE ONE CARD THAT DOES BELONG HERE CLAIMS NO STEP NUMBER. The photos card is
    // ungated on purpose -- pasting photo URLs still works on this surface -- so with steps 1
    // and 2 gated away it was the only card on the page, announcing itself as "Step 3". (It
    // said "Step 2" before the dimensions card took that number: the off-by-one is older than
    // this change and got wider.) The copy goes with the number: an operator filmed nothing.
    const stepHeads = await page.evaluate(() => (document.body.innerText.match(/Step \d+ —/g) || []));
    ok("⚠️ ...and no card announces a step number with no other steps on the page",
      stepHeads.length === 0, stepHeads.join(", "));
    ok("...the photos card is still here, under its own name",
      (await page.getByText("Photos of the same building").count()) >= 1);
    ok("...and it does not tell an operator about a building they filmed",
      !(await page.getByText("same building you filmed").count()));

    // ── The stored recessed porch reads as Recessed ──
    ok("a stored porchDepthFt reads as Recessed", (await porchSelect(page).inputValue()) === "recessed");
    ok("...its depth box shows the stored 4", (await depthInput(page).inputValue()) === "4");
    ok("...a recessed gable porch offers the truss box", (await trussBox(page).count()) === 1);
    ok("...and no wood box and no readout", (await woodInput(page).count()) === 0 && (await readout(page).count()) === 0);

    // ── 1. Projecting 6.5 ft with the band ──
    await porchSelect(page).selectOption("projecting");
    await settle(page);
    ok("Projecting carries the depth across (4)", (await depthInput(page).inputValue()) === "4");
    ok("...hides the truss box", (await trussBox(page).count()) === 0);
    ok("...shows the wood box, empty, with the natural placeholder",
      (await woodInput(page).count()) === 1 && (await woodInput(page).inputValue()) === "" && (await woodInput(page).getAttribute("placeholder")) === "#C4965A (natural)");
    await typeNumber(page, depthInput(page), 6.5);
    const r9 = readout(page);
    const r9text = (await r9.count()) ? (await r9.last().textContent()).trim() : "";
    const r9color = (await r9.count()) ? await r9.last().evaluate((el) => getComputedStyle(el).color) : "";
    ok("the readout says what a 9 ft wall builds: posts clear, the porch roof meeting the wall at 8' 10\"",
      /^Posts \d+' \d+" clear, porch roof meets the wall at 8' 10" on /.test(r9text), r9text);
    ok("...in the normal colour", r9color === NORMAL, r9color);
    ok("the band box starts unticked", !(await bandBox(page).isChecked()));
    await bandBox(page).check();
    await settle(page);
    let d3 = (await save(page, calls)).d3;
    ok("save 1: roof.porchOutFt 6.5", d3.roof.porchOutFt === 6.5, JSON.stringify(d3.roof));
    ok("save 1: no porchDepthFt and no porchTruss", !has(d3.roof, "porchDepthFt") && !has(d3.roof, "porchTruss"), keys(d3.roof));
    ok("save 1: plateBand true", d3.roof.plateBand === true);
    ok("save 1: porchEnd back is kept", d3.roof.porchEnd === "back");
    ok("save 1: nothing else in roof moved", keys(d3.roof) === "overhang,pitch,plateBand,porchEnd,porchOutFt,type"
      && d3.roof.type === "gable" && d3.roof.pitch === 0.4 && d3.roof.overhang === 0.6, keys(d3.roof));
    ok("save 1: no wood key until one is typed", !has(d3.colors, "wood"), keys(d3.colors));

    // ── 2. Recessed ──
    await porchSelect(page).selectOption("recessed");
    await settle(page);
    ok("Recessed carries the depth across (6.5)", (await depthInput(page).inputValue()) === "6.5");
    ok("...shows the truss box again, and hides the wood box and the readout",
      (await trussBox(page).count()) === 1 && (await woodInput(page).count()) === 0 && (await readout(page).count()) === 0);
    // The truss is a gable roof's: a gambrel hides the box, and gable brings it back.
    const roofType = field(page, /^Roof type/).locator("select");
    await roofType.selectOption("gambrel");
    await settle(page);
    ok("...a recessed porch on a gambrel shows no truss box", (await trussBox(page).count()) === 0);
    await roofType.selectOption("gable");
    await settle(page);
    d3 = (await save(page, calls)).d3;
    ok("save 2: porchDepthFt 6.5", d3.roof.porchDepthFt === 6.5, JSON.stringify(d3.roof));
    ok("save 2: no porchOutFt", !has(d3.roof, "porchOutFt"), keys(d3.roof));
    ok("save 2: the band stays on", d3.roof.plateBand === true);

    // ── 3. None ──
    await porchSelect(page).selectOption("none");
    await settle(page);
    ok("None hides the depth, end, truss and wood controls",
      (await depthInput(page).count()) === 0 && (await field(page, /^Porch end/).count()) === 0 && (await trussBox(page).count()) === 0 && (await woodInput(page).count()) === 0);
    d3 = (await save(page, calls)).d3;
    ok("save 3: no porchDepthFt and no porchOutFt", !has(d3.roof, "porchDepthFt") && !has(d3.roof, "porchOutFt"), keys(d3.roof));
    ok("save 3: porchEnd back is kept", d3.roof.porchEnd === "back");

    // ── 4. Band off ──
    await bandBox(page).uncheck();
    await settle(page);
    d3 = (await save(page, calls)).d3;
    ok("save 4: unticking the band removes plateBand (never false)", !has(d3.roof, "plateBand"), keys(d3.roof));

    // ── 5. Wood ──
    await porchSelect(page).selectOption("projecting");
    await settle(page);
    ok("Projecting from None starts at 6 ft", (await depthInput(page).inputValue()) === "6");
    await woodInput(page).click();
    await woodInput(page).pressSequentially("#C4965A", { delay: 20 });
    await settle(page);
    d3 = (await save(page, calls)).d3;
    ok("save 5: colors.wood #C4965A", d3.colors.wood === "#C4965A", JSON.stringify(d3.colors));
    ok("save 5: porchOutFt 6, the other colours untouched", d3.roof.porchOutFt === 6 && d3.colors.body === COLORS.body && d3.colors.trim === COLORS.trim && d3.colors.roof === COLORS.roof);
    await woodInput(page).fill("");
    await settle(page);
    d3 = (await save(page, calls)).d3;
    ok("save 6: clearing the wood box removes colors.wood", !has(d3.colors, "wood"), keys(d3.colors));

    // ── 7. The readout at 7 ft walls ──
    await typeNumber(page, field(page, /^Wall height \(ft\)/).locator('input[type="number"]'), 7);
    const r7 = readout(page);
    const r7text = (await r7.count()) ? (await r7.last().textContent()).trim() : "";
    const r7color = (await r7.count()) ? await r7.last().evaluate((el) => getComputedStyle(el).color) : "";
    ok("at 7 ft walls the readout warns and names the wall height a door needs",
      /^Walls this short leave \d+' \d+" under the porch beam\. About \d+' \d+" walls give a door's height at 2:12$/.test(r7text), r7text);
    ok("...in amber", r7color === AMBER, r7color);

    // ── 6. A style with no porch, saved untouched ──
    await openStyle(page, "Harness Plain Barn");
    ok("a style with no porch reads as None, with no depth box", (await porchSelect(page).inputValue()) === "none" && (await depthInput(page).count()) === 0);
    ok("...and its band box is unticked", !(await bandBox(page).isChecked()));
    d3 = (await save(page, calls)).d3;
    ok("save 7: no porchOutFt, porchDepthFt or plateBand key",
      !has(d3.roof, "porchOutFt") && !has(d3.roof, "porchDepthFt") && !has(d3.roof, "plateBand"), keys(d3.roof));
    ok("save 7: no wood key", !has(d3.colors, "wood"), keys(d3.colors));
    ok("save 7: the roof is exactly what was stored", JSON.stringify(d3.roof) === JSON.stringify(PLAIN_ROOF), JSON.stringify(d3.roof));
  } catch (e) {
    ok("ran to the end", false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    ok("no page errors", errors.length === 0, JSON.stringify(errors).slice(0, 300));
    await browser.close();
  }
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
  return bad.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((n) => process.exit(n ? 1 : 0), (e) => { console.error(e); process.exit(2); });
}
