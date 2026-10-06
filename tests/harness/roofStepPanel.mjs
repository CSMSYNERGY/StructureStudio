// The calibration panel's two roof-step inputs (roof.rearStepFt / roof.rearEaveRiseFt, 2026-09-28),
// driven, with the SAVE PAYLOAD read off the wire, put through the REAL sanitiser
// (supabase/functions/_shared/styleD3.ts) to see what would be stored, and that stored spec then
// served back as the style's own and opened again: a round trip through Save.
//
//   1. a gable-front style shows both boxes, blank, and the line under them says blank is one roof;
//      saved untouched it sends back exactly the roof it stored, no step key
//   2. the step alone: the line says both numbers are needed, and the stored spec keeps neither
//   3. 12 ft and 7 in: sent as rearStepFt 12 and rearEaveRiseFt 7/12, stored as both, and the line
//      says what the preview draws (d3RoofStep's own answer at this size)
//   4. ROUND TRIP: that stored spec, served back as the style's d3, opens with the boxes reading
//      12 and 7
//   5. a rise typed negative is sent negative and said as lower; out-of-band numbers are held to
//      the sanitiser's bands (56 ft, 18 in)
//   6. clearing a box deletes its key, and the stored spec then keeps neither
//   7. offered only on a gable whose front is not a long side: gone on an "eave" front, back on
//      "Gable end", gone on a single slant and a gambrel, and switching the roof type to either
//      takes both keys off the spec
//   8. wings beside a step: the line says it is not drawn
//   9. zero page errors
//
// The public ?admin=1 operator page with Supabase stubbed at the network layer (lib.mjs), the
// calNewKeys.mjs technique: no login, nothing leaves the machine, the COMPILED bundle.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/roofStepPanel.mjs          (SS_BASE=http://127.0.0.1:<port> to move it)
//
// Exit 0 = every assertion held.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, reporter, shotsDir, BASE } from "./lib.mjs";

const { sanitizeD3Spec } = await import(new URL("../../supabase/functions/_shared/styleD3.ts", import.meta.url).href);

const SIZE = "14x40";
const COLORS = { body: "#3a3d3f", trim: "#2a2d30", roof: "#2c3036" };
const CABIN_ROOF = { type: "gable", front: "gable", pitch: 0.41, overhang: 1.3, eave: "fascia", porchDepthFt: 6, porchEnd: "front" };
const configWith = (d3) => {
  const styles = [{ value: "cabin", label: "Harness Step Cabin", d3 }].map((s) => ({ ...s, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {} }));
  return {
    clientId: "harness-roof-step-panel",
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: styles,
    defaultSizes: [SIZE],
    sizePricing: { cabin: { [SIZE]: { widthFt: 14, lengthFt: 40, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
  };
};
const START = { roof: CABIN_ROOF, siding: "batten", colors: COLORS, wallHeightFt: 7.75, roofMaterial: "metal" };
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };

const settle = (page, ms = 250) => page.waitForTimeout(ms);
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const keys = (o) => Object.keys(o || {}).sort().join(",");
// The same keys and values, whatever their order (the panel's resolver puts type and pitch first).
const same = (a, b) => keys(a) === keys(b) && Object.keys(a).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
const field = (page, text) => page.locator("label").filter({ hasText: text });
const stepBox = (page) => page.locator('input[data-ss-roof-step="at"]');
const riseBox = (page) => page.locator('input[data-ss-roof-step="rise"]');
const why = async (page) => ((await page.locator('[data-ss-roof-step="why"]').first().innerText()) || "").replace(/\s+/g, " ");
const stored = (d3) => { const r = sanitizeD3Spec(d3); if (!r.ok) throw new Error(r.error); return r.d3; };

async function openAdmin(page, clientId) {
  await page.goto(`${BASE}/?client=${encodeURIComponent(clientId)}&admin=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
  await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
  await page.getByPlaceholder("Admin password").fill("harness");
  const btn = page.getByRole("button", { name: "Harness Step Cabin", exact: true });
  await btn.first().waitFor({ state: "visible", timeout: 30000 });
  await btn.first().click();
  await field(page, /^Roof type/).locator("select").waitFor({ state: "visible", timeout: 15000 });
  // The designer's own size: the panel's line reads the building the preview draws, at this size.
  const size = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
  if (await size.count()) await size.first().selectOption({ label: SIZE });
  await settle(page, 600);
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
  const shots = shotsDir("roofStepPanel");
  let page = await ctx.newPage();
  let errors = collectErrors(page);
  let calls = await stubSupabase(page, { config: configWith(START), fixtures: FIXTURES });
  let roundTrip = null;
  try {
    await openAdmin(page, "harness-roof-step-panel");

    // ── 1. offered on a gable front, blank ──
    ok("a gable-front style offers the roof step's two boxes", (await stepBox(page).count()) === 1 && (await riseBox(page).count()) === 1);
    ok("...labelled in the builder's words", (await field(page, "Roof step from back (ft)").count()) === 1 && (await field(page, "Rear roof edge higher by (in)").count()) === 1);
    ok("...both blank, saying what blank draws", (await stepBox(page).inputValue()) === "" && (await riseBox(page).inputValue()) === "" && /one roof from the front to the back/.test(await why(page)), await why(page));
    let d3 = await save(page, calls);
    ok("⚠️ SAVED UNTOUCHED, THE ROOF IS EXACTLY WHAT WAS STORED — no step key", same(d3.roof, CABIN_ROOF), JSON.stringify(d3.roof));

    // ── 2. one alone ──
    await typeNumber(page, stepBox(page), 12);
    ok("the step alone: the line says both numbers are needed", /Give both numbers/.test(await why(page)), await why(page));
    d3 = await save(page, calls);
    ok("...it is sent", d3.roof.rearStepFt === 12 && !has(d3.roof, "rearEaveRiseFt"), keys(d3.roof));
    ok("⚠️ ...and the server would store NEITHER (one without the other is dropped)", !has(stored(d3).roof, "rearStepFt") && !has(stored(d3).roof, "rearEaveRiseFt"), keys(stored(d3).roof));

    // ── 3. both ──
    await typeNumber(page, riseBox(page), 7);
    const line = await why(page);
    ok("12 ft and 7 in: the line says what the preview draws, from d3RoofStep", /Drawn: the back 12 ft has its own roof, its edge 7 in higher at [\d.]+ in 12, so the ridges line up\./.test(line), line);
    d3 = await save(page, calls);
    ok("save: rearStepFt 12 and rearEaveRiseFt 7/12 (the inches as feet)", d3.roof.rearStepFt === 12 && Math.abs(d3.roof.rearEaveRiseFt - 7 / 12) < 1e-12, JSON.stringify(d3.roof));
    const kept = stored(d3);
    ok("⚠️ ...and the server stores both, unchanged", kept.roof.rearStepFt === 12 && Math.abs(kept.roof.rearEaveRiseFt - 7 / 12) < 1e-12, JSON.stringify(kept.roof));
    roundTrip = kept;
    await field(page, "Rear roof edge higher by (in)").locator("xpath=..").screenshot({ path: join(shots, "roof-step-row.png") });

    // ── 5. lower, and the bands ──
    await typeNumber(page, riseBox(page), -4.5);
    ok("a lower rear edge is said as lower", /its edge 4\.5 in lower/.test(await why(page)), await why(page));
    d3 = await save(page, calls);
    ok("save: the rise is sent negative (-4.5 in)", Math.abs(d3.roof.rearEaveRiseFt + 4.5 / 12) < 1e-12, String(d3.roof.rearEaveRiseFt));
    await typeNumber(page, stepBox(page), 80);
    await typeNumber(page, riseBox(page), 30);
    d3 = await save(page, calls);
    ok("numbers past the bands are held to the sanitiser's (56 ft, 18 in)", d3.roof.rearStepFt === 56 && d3.roof.rearEaveRiseFt === 1.5, JSON.stringify(d3.roof));
    ok("...and the line says what THIS size draws: held to 4 ft of room in front of the porch", /the back 30 ft has its own roof/.test(await why(page)), await why(page));

    // ── 6. clearing ──
    await typeNumber(page, riseBox(page), "");
    d3 = await save(page, calls);
    ok("⚠️ CLEARING THE RISE DELETES ITS KEY", !has(d3.roof, "rearEaveRiseFt") && d3.roof.rearStepFt === 56, keys(d3.roof));
    ok("...and the server then keeps neither", !has(stored(d3).roof, "rearStepFt"), keys(stored(d3).roof));
    await typeNumber(page, stepBox(page), "");
    d3 = await save(page, calls);
    ok("⚠️ CLEARING BOTH SENDS THE ROOF IT STARTED WITH", same(d3.roof, CABIN_ROOF), JSON.stringify(d3.roof));

    // ── 7. only on a gable whose front is not a long side ──
    await typeNumber(page, stepBox(page), 10);
    await typeNumber(page, riseBox(page), 6);
    const front = field(page, "Front wall (main door side)").locator("select");
    await front.selectOption("eave");
    await settle(page);
    ok("an 'eave' front hides both boxes", (await stepBox(page).count()) === 0 && (await riseBox(page).count()) === 0);
    ok("⚠️ ...and what it would store keeps no step", !has(stored(await save(page, calls)).roof, "rearStepFt"));
    await front.selectOption("gable");
    await settle(page);
    ok("back on 'Gable end' the boxes come back with their numbers", (await stepBox(page).inputValue()) === "10" && (await riseBox(page).inputValue()) === "6", `${await stepBox(page).inputValue()} / ${await riseBox(page).inputValue()}`);
    await field(page, /^Lower wings, each/).locator("input").fill("6");
    await page.keyboard.press("Tab");
    await settle(page);
    ok("wings beside a step: the line says it is not drawn", /Not drawn with lower wings/.test(await why(page)), await why(page));
    await typeNumber(page, field(page, /^Lower wings, each/).locator("input"), 0);
    for (const type of ["shed", "gambrel"]) {
      await field(page, /^Roof type/).locator("select").selectOption("gable");
      await settle(page);
      await typeNumber(page, stepBox(page), 10);
      await typeNumber(page, riseBox(page), 6);
      await field(page, /^Roof type/).locator("select").selectOption(type);
      await settle(page);
      ok(`a ${type} offers neither box`, (await stepBox(page).count()) === 0 && (await riseBox(page).count()) === 0);
      d3 = await save(page, calls);
      ok(`⚠️ switching the roof to a ${type} takes both keys off`, !has(d3.roof, "rearStepFt") && !has(d3.roof, "rearEaveRiseFt"), keys(d3.roof));
    }
  } catch (e) {
    ok("ran to the end", false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    ok("no page errors", errors.length === 0, JSON.stringify(errors).slice(0, 300));
    await page.close();
  }

  // ── 4. ROUND TRIP: the stored spec, served back as the style's own ──
  if (roundTrip) {
    page = await ctx.newPage();
    errors = collectErrors(page);
    calls = await stubSupabase(page, { config: configWith(roundTrip), fixtures: FIXTURES });
    try {
      await openAdmin(page, "harness-roof-step-panel");
      ok("⚠️ ROUND TRIP: the stored spec opens with the boxes reading 12 and 7", (await stepBox(page).inputValue()) === "12" && (await riseBox(page).inputValue()) === "7", `${await stepBox(page).inputValue()} / ${await riseBox(page).inputValue()}`);
      ok("...and the line says it is drawn", /Drawn: the back 12 ft has its own roof, its edge 7 in higher/.test(await why(page)), await why(page));
      const d3 = await save(page, calls);
      ok("...and saving it untouched sends the same two numbers back", d3.roof.rearStepFt === 12 && Math.abs(d3.roof.rearEaveRiseFt - 7 / 12) < 1e-12, JSON.stringify(d3.roof));
    } catch (e) {
      ok("round trip ran to the end", false, e && e.message ? e.message.split("\n")[0] : String(e));
    } finally {
      ok("round trip: no page errors", errors.length === 0, JSON.stringify(errors).slice(0, 300));
    }
  }
  await browser.close();
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
  return bad.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((n) => process.exit(n ? 1 : 0), (e) => { console.error(e); process.exit(2); });
}
