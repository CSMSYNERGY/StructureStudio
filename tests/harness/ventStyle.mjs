// A STYLE change and the gable vent, driven for real (review 2026-09-15, finding 1).
//
// Plan 1.9: a vent's gable zone comes off when a size OR a style change takes the gable away. Only
// the size change did it. Pick a single slant at the same size and a vent kept ventZone "gable": the
// 3D and the toolbar readout put it on the wall, while the placement rules, trusting the key, let a
// second vent be dropped right on top of it. This drives the COMPILED bundle with a customer's clicks:
//   1. a Standard Vent on the Gable Cabin's south end goes into the gable
//   2. picking the Slant Shed (same 12x32) brings it down to the wall, and a toast says why
//   3. picking the same size again leaves it there
//   4. a second vent clicked onto that spot is refused, not stacked
//   5. back to the Gable Cabin: the wall vent stays on the wall, and nothing is said
//   6. a design OPENED with a stale gable key keeps it exactly as saved (a load is never rewritten)
//   7. ...and the customer's next style picks re-fit it like any other vent
//
//   python -m http.server 8125 --bind 127.0.0.1        (repo root)
//   node tests/harness/ventStyle.mjs                    (SS_SHOTS=<dir> for the screenshots)
import { pathToFileURL } from "node:url";
import { launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir, bypassGate, BASE, armVent } from "./lib.mjs";
import { CONFIG as GABLE_CONFIG, FIXTURES, pickStyle, chooseCladding } from "./gableProbe.mjs";

const W = 12, L = 32, SIZE = `${W}x${L}`;
const plain = GABLE_CONFIG.buildingStyles.find((s) => s.value === "plain");
// The probe's config plus a single slant at the SAME size, so the style change is the only change.
const CONFIG = {
  ...GABLE_CONFIG,
  clientId: "harness-vent-style",
  buildingStyles: [...GABLE_CONFIG.buildingStyles,
    { ...plain, value: "slant", label: "Slant Shed", d3: { ...plain.d3, roof: { ...plain.d3.roof, type: "shed", pitch: 0.25 } } }],
  sizePricing: { ...GABLE_CONFIG.sizePricing, slant: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 8000 } } },
  claddingOptions: { ...GABLE_CONFIG.claddingOptions, slant: GABLE_CONFIG.claddingOptions.plain },
};
const DROPPED = "This style has no gable room for your vent";
const TAKEN = "Something's already there";
const CODE = "SS-HARN01";

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const heightKeys = (v) => v && { ventZone: v.ventZone, ventRiseFt: v.ventRiseFt, sillFt: v.sillFt, sillMode: v.sillMode, x: v.x };
const bodyHas = (page, text, timeout = 3000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout }).then(() => true, () => false);

async function chooseSizeLabel(page, label, lenFt) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: label }) });
  await sel.first().selectOption({ label });
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), lenFt, { timeout: 15000 });
  await settle(page, 500);
}
// A click just inside the south wall at `xSvg` (plan units), the spot a customer aims a vent at.
async function clickSouth(page, xSvg) {
  const r = await buildingRect(page);
  return svgPoint(page, xSvg, r.y + r.h - 0.4 * (r.h / L));
}
async function placeVentAt(page, xSvg) {
  const before = new Set(((await readItems(page)) || []).map((i) => i.id));
  await armVent(page, "Standard Vent");
  await settle(page, 250);
  const p = await clickSouth(page, xSvg);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  return ((await readItems(page)) || []).find((i) => !before.has(i.id)) || null;
}
const vents = async (page) => ((await readItems(page)) || []).filter((i) => i.isVent);

export async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("ventStyle");
  const { browser, ctx } = await launch({ width: 1440, height: 1000 });
  const allCalls = [];
  const allErrors = [];
  try {
    // ── 1-5: a customer's own plan ──────────────────────────────────────────────────────────────
    const page = await ctx.newPage();
    allErrors.push(collectErrors(page));
    allCalls.push(await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES }));
    await openDesigner(page, CONFIG.clientId);
    await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
    await pickStyle(page, "Gable Cabin");
    await chooseSizeLabel(page, SIZE, L);
    await chooseCladding(page, "batten");
    const r0 = await buildingRect(page);

    const A0 = await placeVentAt(page, r0.x + 6 * (r0.w / W));
    ok("1. a vent on the Gable Cabin's south end goes into the gable", !!A0 && A0.ventZone === "gable", JSON.stringify(heightKeys(A0)));
    if (!A0) throw new Error("no vent placed");

    await pickStyle(page, "Slant Shed");
    const toast2 = await bodyHas(page, DROPPED);
    const B = (await vents(page)).find((v) => v.id === A0.id);
    ok("2. the Slant Shed brings it down to the wall's top spot (zone and rise off, sill fixed)",
      !!B && B.wall === "south" && B.ventZone == null && B.ventRiseFt == null && B.sillFt == null && B.sillMode === "fixed", JSON.stringify(heightKeys(B)));
    ok("2. ...and says why", toast2);
    await page.screenshot({ path: `${shots}/2-slant-vent-on-wall.png` });

    await chooseSizeLabel(page, SIZE, L);
    const C = (await vents(page)).find((v) => v.id === A0.id);
    ok("3. picking the same size again leaves it on the wall", !!C && C.ventZone == null && C.x === B.x, JSON.stringify(heightKeys(C)));

    const countBefore = (await vents(page)).length;
    const D = await placeVentAt(page, C.x);
    const toast4 = await bodyHas(page, TAKEN);
    ok("4. a second vent clicked onto that spot is refused, not stacked on it", !D && (await vents(page)).length === countBefore, JSON.stringify(D && heightKeys(D)));
    ok("4. ...with the refusal toast", toast4);
    await page.screenshot({ path: `${shots}/4-second-vent-refused.png` });

    await page.waitForFunction((t) => !document.body.innerText.includes(t), DROPPED, { timeout: 8000 }).catch(() => {});
    await pickStyle(page, "Gable Cabin");
    const toast5 = await bodyHas(page, DROPPED, 1500);
    const E = (await vents(page)).find((v) => v.id === A0.id);
    ok("5. back on the Gable Cabin the wall vent stays on the wall, silently", !!E && E.ventZone == null && !toast5, JSON.stringify(heightKeys(E)));
    await page.close();

    // ── 6-7: a design opened with a stale gable key ─────────────────────────────────────────────
    // The vent as step 1 placed it, saved on the Slant Shed: the shape a design saved before this
    // fix can carry. Opening it must not rewrite it; picking a style afterwards must re-fit it.
    const stale = { ...A0, id: 1 };
    const row = {
      short_code: CODE, status: "draft", selections: { style: "slant", size: SIZE, cladding: "batten" },
      items: [stale], contact: { name: "", email: "", phone: "", street: "", city: "", state: "", zip: "" },
      paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
    };
    const p2 = await ctx.newPage();
    allErrors.push(collectErrors(p2));
    allCalls.push(await stubSupabase(p2, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [row] } }));
    await bypassGate(p2, CONFIG.clientId);
    await p2.goto(`${BASE}/?client=${encodeURIComponent(CONFIG.clientId)}&id=${CODE}`, { waitUntil: "domcontentloaded" });
    await p2.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
    let loaded = null;
    for (let k = 0; k < 60 && !(loaded && loaded.length); k++) { await settle(p2, 500); loaded = await vents(p2); }
    await settle(p2, 1500);
    const L6 = (await vents(p2))[0];
    ok("6. the opened design keeps its saved gable key (a load is never rewritten)", !!L6 && L6.ventZone === "gable" && L6.ventRiseFt === stale.ventRiseFt && L6.x === stale.x,
      JSON.stringify(heightKeys(L6)));
    ok("6. ...and says nothing", !(await bodyHas(p2, DROPPED, 500)));

    await pickStyle(p2, "Gable Cabin");
    const L7a = (await vents(p2))[0];
    ok("7. picking the Gable Cabin re-fits it into that gable, silently", !!L7a && L7a.ventZone === "gable" && !(await bodyHas(p2, DROPPED, 1000)), JSON.stringify(heightKeys(L7a)));
    await pickStyle(p2, "Slant Shed");
    const toast7 = await bodyHas(p2, DROPPED);
    const L7b = (await vents(p2))[0];
    ok("7. picking the Slant Shed brings it down, with the toast", !!L7b && L7b.ventZone == null && L7b.sillMode === "fixed" && toast7, JSON.stringify(heightKeys(L7b)));
    await p2.close();
  } catch (e) {
    ok("harness ran to the end", false, e && e.stack ? e.stack.split("\n").slice(0, 5).join(" / ") : String(e));
  } finally {
    const writes = allCalls.flat().filter((c) => !c.aborted && c.method !== "GET" && c.path && !/\/rpc\/(get_config|get_fixtures|load_design)$/.test(c.path));
    console.log(`stubbed non-config calls: ${writes.length}${writes.length ? " — " + [...new Set(writes.map((c) => c.path))].join(", ") : ""}`);
    const pageErrors = allErrors.flat().filter((x) => /^pageerror/.test(x));
    ok("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    await browser.close();
  }
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
  console.log(`shots in ${shots}`);
  return bad.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((n) => process.exit(n ? 1 : 0));
}
