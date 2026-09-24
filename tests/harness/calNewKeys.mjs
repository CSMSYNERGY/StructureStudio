// The calibration panel's controls for the 2026-09-24 keys, driven, with the SAVE PAYLOAD read
// off the wire.
//
// Video → exact 3D v2 added ten keys a builder (and the generator) can set: which wall is the
// front (roof.front) or the high one (roof.highSide), where a projecting porch's roof meets the
// wall and how wide the porch is (roof.porchAttachFt / roof.porchWidthFt), lower wings
// (roof.wingSide / wingWidthFt / wingPitch / centerEaveFt) and the corner-board and fascia
// colours (colors.corner / colors.fascia). Every one of them MEANS something by being absent --
// the old frame of reference, a porch roof just under the eave, the whole wall, no wings, the
// trim colour -- so the rule these controls live by is the sanitiser's: never emit a default. A
// cleared control deletes its key, an untouched style saves exactly what it loaded, and a key
// the other kind of roof owns comes off when the roof type changes.
//
//   1. a style opened and saved untouched sends back exactly the roof and colours it stored
//   2. a single slant offers "High side" and not "Front wall"; front saves highSide "front", and
//      "Not set" deletes it
//   3. a projecting porch offers attach height and width; typed numbers save, an out-of-band one
//      saves clamped to the sanitiser's band, a cleared box deletes the key, and switching the
//      porch to recessed deletes both
//   4. corner and fascia: "Same as walls" / "Same as roof" store that hex, "Same as trim" deletes
//   5. switching to a gable drops highSide and offers "Front wall"; "Long side" saves front "eave"
//   6. wings: a width with no side says so; "Both sides" saves width and side and NOTHING else
//      (no pitch, no centre eave until typed); pitch is typed in 12ths; a side the roof cannot
//      take a wing on is named as not drawn; width 0 deletes every wing key
//   7. switching back to a single slant drops front and every wing key
//   8. zero page errors
//
// The public ?admin=1 operator page with Supabase stubbed at the network layer (lib.mjs), the
// porchPanel.mjs technique: no login, nothing leaves the machine, the COMPILED bundle.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/calNewKeys.mjs              (SS_BASE=http://127.0.0.1:<port> to move it)
//
// Exit 0 = every assertion held.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, reporter, shotsDir, BASE } from "./lib.mjs";

const SIZE = "16x24";
const COLORS = { body: "#4a3b30", trim: "#ffffff", roof: "#2b2f33" };
const CABIN_ROOF = { type: "shed", pitch: 0.23, overhang: 1, eave: "open", tailSpacingIn: 24 };
const STYLES = [
  { value: "cabin", label: "Harness Cabin", d3: { roof: CABIN_ROOF, siding: "batten", colors: COLORS, wallHeightFt: 7, roofMaterial: "metal" } },
].map((s) => ({ ...s, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {} }));
const CONFIG = {
  clientId: "harness-new-keys",
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

const settle = (page, ms = 250) => page.waitForTimeout(ms);
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const keys = (o) => Object.keys(o || {}).sort().join(",");
const field = (page, text) => page.locator("label").filter({ hasText: text });
const porchSelect = (page) => page.locator("label").filter({ has: page.locator('option[value="projecting"]') }).locator("select");

async function openAdmin(page) {
  await page.goto(`${BASE}/?client=${encodeURIComponent(CONFIG.clientId)}&admin=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
  await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
  await page.getByPlaceholder("Admin password").fill("harness");
}
async function openStyle(page, label) {
  const btn = page.getByRole("button", { name: label, exact: true });
  await btn.first().waitFor({ state: "visible", timeout: 30000 });
  await btn.first().click();
  await porchSelect(page).waitFor({ state: "visible", timeout: 15000 });
  await settle(page);
}
async function typeNumber(page, input, value) {
  await input.click();
  await input.fill(String(value));
  await page.keyboard.press("Tab");
  await settle(page);
}
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
  return saves()[saves().length - 1].body.d3;
}

export async function main() {
  const { ok, failed } = reporter();
  const { browser, ctx } = await launch({ width: 1280, height: 900 });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const calls = await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  const shots = shotsDir("calNewKeys");
  try {
    await openAdmin(page);
    await openStyle(page, "Harness Cabin");

    // ── 1. untouched is untouched ──
    let d3 = await save(page, calls);
    ok("⚠️ SAVED UNTOUCHED, THE ROOF IS EXACTLY WHAT WAS STORED — no new key, no default",
      JSON.stringify(d3.roof) === JSON.stringify(CABIN_ROOF), JSON.stringify(d3.roof));
    ok("...and so are the colours", JSON.stringify(d3.colors) === JSON.stringify(COLORS), JSON.stringify(d3.colors));

    // ── 2. the high side ──
    const highSide = field(page, "High side (single slant)").locator("select");
    ok("a single slant offers the high side", (await highSide.count()) === 1);
    ok("...and not the front-wall choice, which is a gable's", (await field(page, "Front wall (porch or door side)").count()) === 0);
    ok("...starting at Not set", (await highSide.inputValue()) === "");
    await highSide.selectOption("front");
    await settle(page);
    d3 = await save(page, calls);
    ok("save: highSide front", d3.roof.highSide === "front", JSON.stringify(d3.roof));
    await highSide.selectOption("");
    await settle(page);
    d3 = await save(page, calls);
    ok("⚠️ 'Not set' DELETES the key rather than storing a default", !has(d3.roof, "highSide"), keys(d3.roof));
    await highSide.selectOption("front");
    await settle(page);

    // ── 3. the porch's attach height and width ──
    await porchSelect(page).selectOption("projecting");
    await settle(page);
    const attach = field(page, "Porch roof meets the wall at (ft up)").locator("input");
    const width = field(page, "Porch width (ft)").locator("input");
    ok("a projecting porch offers where its roof meets the wall, and its width",
      (await attach.count()) === 1 && (await width.count()) === 1);
    ok("...both blank until typed, saying what blank draws",
      (await attach.inputValue()) === "" && /just under the eave/.test((await attach.getAttribute("placeholder")) || "")
        && (await width.inputValue()) === "" && /whole wall/.test((await width.getAttribute("placeholder")) || ""));
    d3 = await save(page, calls);
    ok("⚠️ a projecting porch saved with both blank sends neither key",
      !has(d3.roof, "porchAttachFt") && !has(d3.roof, "porchWidthFt") && d3.roof.porchOutFt === 6, keys(d3.roof));
    await typeNumber(page, attach, 7.5);
    await typeNumber(page, width, 16);
    d3 = await save(page, calls);
    ok("save: porchAttachFt 7.5 and porchWidthFt 16", d3.roof.porchAttachFt === 7.5 && d3.roof.porchWidthFt === 16, JSON.stringify(d3.roof));
    await typeNumber(page, attach, 30);
    d3 = await save(page, calls);
    ok("an attach height past the band saves at its top (24), what the sanitiser would store", d3.roof.porchAttachFt === 24, String(d3.roof.porchAttachFt));
    await typeNumber(page, attach, "");
    d3 = await save(page, calls);
    ok("⚠️ CLEARING THE BOX DELETES THE KEY", !has(d3.roof, "porchAttachFt") && d3.roof.porchWidthFt === 16, keys(d3.roof));
    await typeNumber(page, attach, 7.5);
    await porchSelect(page).selectOption("recessed");
    await settle(page);
    ok("a recessed porch offers neither", (await field(page, "Porch roof meets the wall at (ft up)").count()) === 0 && (await field(page, "Porch width (ft)").count()) === 0);
    d3 = await save(page, calls);
    ok("⚠️ AND SAVES NEITHER — they belong to a projecting porch only",
      !has(d3.roof, "porchAttachFt") && !has(d3.roof, "porchWidthFt") && d3.roof.porchDepthFt === 6, keys(d3.roof));
    const porchEnd = field(page, /^Porch end/).locator("select");
    ok("in the new frame the porch end names a WALL, not a gable end",
      (await porchEnd.locator("option").allTextContents()).join("|") === "Front wall|Back wall",
      (await porchEnd.locator("option").allTextContents()).join("|"));
    await porchSelect(page).selectOption("none");
    await settle(page);

    // ── 4. corner boards and fascia ──
    const corner = field(page, "Corner boards");
    const fascia = field(page, "Fascia and rake boards");
    ok("corner boards and fascia each have a colour box, blank = same as trim",
      (await corner.locator('input[type="text"]').inputValue()) === "" && (await fascia.locator('input[type="text"]').inputValue()) === ""
        && /same as trim/.test((await corner.locator('input[type="text"]').getAttribute("placeholder")) || ""));
    await corner.getByRole("button", { name: "Same as walls" }).click();
    await fascia.getByRole("button", { name: "Same as roof" }).click();
    await settle(page);
    d3 = await save(page, calls);
    await corner.locator("xpath=..").screenshot({ path: join(shots, "03-colours-row.png") });
    ok("save: corner boards in the wall colour, fascia in the roof colour (Farmstand)",
      d3.colors.corner === COLORS.body && d3.colors.fascia === COLORS.roof, JSON.stringify(d3.colors));
    ok("...and the three it had are untouched", d3.colors.body === COLORS.body && d3.colors.trim === COLORS.trim && d3.colors.roof === COLORS.roof);
    await corner.getByRole("button", { name: "Same as trim" }).click();
    await fascia.getByRole("button", { name: "Same as trim" }).click();
    await settle(page);
    d3 = await save(page, calls);
    ok("⚠️ 'SAME AS TRIM' DELETES THE KEY — absent is what draws the trim colour",
      !has(d3.colors, "corner") && !has(d3.colors, "fascia"), keys(d3.colors));

    // ── 5. a gable, facing a long side ──
    await field(page, /^Roof type/).locator("select").selectOption("gable");
    await settle(page);
    d3 = await save(page, calls);
    ok("⚠️ SWITCHING TO A GABLE DROPS THE SHED'S HIGH SIDE", !has(d3.roof, "highSide"), keys(d3.roof));
    const front = field(page, "Front wall (porch or door side)").locator("select");
    ok("a gable offers the front-wall choice, at Not set", (await front.count()) === 1 && (await front.inputValue()) === "");
    ok("...and no high side", (await field(page, "High side (single slant)").count()) === 0);
    await front.selectOption("eave");
    await settle(page);
    d3 = await save(page, calls);
    ok("save: front eave", d3.roof.front === "eave", JSON.stringify(d3.roof));
    // The wings below are on a GABLE-END front, where the eave sides are left and right both by
    // the old portrait rule on this 16 x 24 and in the new frame (roof.front "gable" puts the
    // ridge front to back). So "a wing on the front is not drawn" holds before and after the
    // renderer learns roof.front.
    await front.selectOption("gable");
    await settle(page);

    // ── 6. wings ──
    const wingW = field(page, "Lower wings, each (ft wide, 0 = none)").locator("input");
    ok("a gable offers lower wings, off", (await wingW.count()) === 1 && (await field(page, /^Wing side/).count()) === 0);
    await typeNumber(page, wingW, 8);
    const wingSide = field(page, /^Wing side/);
    ok("a width with no side asks for the side, in amber",
      (await wingSide.count()) === 1 && /Pick the side the wing is on/.test(await wingSide.innerText()));
    await wingSide.locator("select").selectOption("both");
    await settle(page);
    d3 = await save(page, calls);
    ok("save: wingWidthFt 8 and wingSide both", d3.roof.wingWidthFt === 8 && d3.roof.wingSide === "both", JSON.stringify(d3.roof));
    ok("⚠️ AND NOTHING THE BUILDER DID NOT TYPE — no pitch, no centre eave", !has(d3.roof, "wingPitch") && !has(d3.roof, "centerEaveFt"), keys(d3.roof));
    await typeNumber(page, field(page, "Wing roof pitch (rise in 12)").locator("input"), 3);
    await typeNumber(page, field(page, "Middle section's wall height (ft)").locator("input"), 16);
    d3 = await save(page, calls);
    ok("save: the pitch typed in 12ths is stored as the rise/run (3 in 12 = 0.25)", d3.roof.wingPitch === 0.25, String(d3.roof.wingPitch));
    ok("save: centerEaveFt 16", d3.roof.centerEaveFt === 16, String(d3.roof.centerEaveFt));
    await wingW.locator("xpath=../..").screenshot({ path: join(shots, "01-wings-row.png") });
    await field(page, "Front wall (porch or door side)").locator("xpath=..").screenshot({ path: join(shots, "02-roof-row.png") });
    await wingSide.locator("select").selectOption("front");
    await settle(page);
    const lostText = await field(page, /^Wing side/).innerText();
    ok("⚠️ A SIDE THIS ROOF CANNOT TAKE A WING ON IS NAMED AS NOT DRAWN",
      /is not drawn/.test(lostText) && /under the roof edge/.test(lostText), lostText.replace(/\s+/g, " ").slice(0, 160));
    await wingSide.locator("select").selectOption("both");
    await settle(page);
    await typeNumber(page, wingW, 0);
    d3 = await save(page, calls);
    ok("⚠️ WIDTH 0 IS OFF, AND DELETES EVERY WING KEY",
      !has(d3.roof, "wingWidthFt") && !has(d3.roof, "wingSide") && !has(d3.roof, "wingPitch") && !has(d3.roof, "centerEaveFt"), keys(d3.roof));

    // ── 7. back to a single slant ──
    await typeNumber(page, wingW, 6);
    await field(page, /^Wing side/).locator("select").selectOption("left");
    await settle(page);
    await field(page, /^Roof type/).locator("select").selectOption("shed");
    await settle(page);
    d3 = await save(page, calls);
    ok("⚠️ A SINGLE SLANT DROPS THE FRONT-WALL CHOICE AND EVERY WING KEY",
      !has(d3.roof, "front") && !has(d3.roof, "wingWidthFt") && !has(d3.roof, "wingSide"), keys(d3.roof));
    ok("...and offers no wings", (await field(page, "Lower wings, each (ft wide, 0 = none)").count()) === 0);
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
