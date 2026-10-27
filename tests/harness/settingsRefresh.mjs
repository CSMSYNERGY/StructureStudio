// An OPEN designer picks up Settings saves (library plan step 2, 2026-10-27), driven on the COMPILED
// public designer.
//
// Carolyn on the 10-26 call: she set a door row to "American (built in 3D)" in Settings -> Doors,
// went back to the designer she had open in another tab, and got the plain slab that row drew
// before her save. The save had landed; the designer had fetched its catalog once, at mount, and
// never asked again (the portal keeps one designer mounted for the whole session). Now the portal
// announces every Settings write (01-core.jsx: the "ss:settings-saved" event and the "ss-settings"
// BroadcastChannel) and the designer's config loader re-reads its fixture rows in place.
//
//   A. a saved design with a double door whose row draws "auto" opens, and the docked 3D shows no
//      pickets on it
//   B. a save announced for ANOTHER tenant, from another tab, changes nothing and fetches nothing
//   C. the row is switched to "american" and the save announced from another tab (BroadcastChannel):
//      the designer re-reads get_fixtures once, holds the new look, and the docked 3D redraws the door
//      with pickets -- with the plan untouched (same items, nothing remounted)
//   D. the row is switched to "classic" and the save announced in the same tab (the window event):
//      the 3D redraws it with the Classic's diamond
//   E. a CONFIG change is offered, not applied: the line "Your settings changed..." appears, the plan
//      stays; "Not now" hides it; "Reload designer" reloads the config and the line goes
//   F. no page errors
//
// Supabase is stubbed at the network layer; nothing leaves the machine and NOTHING IS SAVED. The
// tenant and its doors are made up, per the public-repo rule.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/settingsRefresh.mjs        (exit 0 = every check held)
import { join } from "node:path";
import { launch, reporter, BASE, shotsDir, stubSupabase, collectErrors, openDesigner, readItems, buildingRect, bypassGate } from "./lib.mjs";
import { pickStyle } from "./gableProbe.mjs";

const { ok, failed } = reporter();
const shots = shotsDir("settings-refresh");
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const W = 12, L = 16, SIZE = `${W}x${L}`;
const D3 = {
  roof: { eave: "fascia", type: "gable", pitch: 0.42, overhang: 0.8, ridgeOffset: 0 },
  colors: { body: "#5b6770", roof: "#3a3d42", trim: "#efe6d2" },
  siding: "panel", foundation: "skids", roofMaterial: "metal", wallHeightFt: 8,
};
const CONFIG = {
  clientId: "harness-settings-refresh",
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: [],
  buildingStyles: [{ value: "utility", label: "Utility", img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3 }],
  defaultSizes: [SIZE],
  sizePricing: { utility: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 5000 } } },
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};
const DOOR = { id: "d-dbl", category: "door", name: "Double door", planLabel: "DD", price: 300, widthIn: 60, heightIn: 72, sortOrder: 0,
  colorMode: "paint", hasTrimColor: true, imageUrl: null, opLeft: false, opRight: false, opDouble: true, opSlideUp: false, opDefault: null,
  swingIn: false, swingOut: true, swingDefault: null, sillIn: null, sillMode: "fixed" };
const fixturesWith = (doorStyle) => ({ items: [{ ...DOOR, doorStyle }], windowColors: [], ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false } });

// What the stub serves right now, and how often each RPC was asked.
const live = { fixtures: fixturesWith("auto"), config: CONFIG };
const counts = { get_fixtures: 0, get_config: 0 };
async function routeLive(page) {
  const hdr = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
  for (const fn of ["get_fixtures", "get_config"]) {
    await page.route(`**/rest/v1/rpc/${fn}*`, (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: hdr, body: "" });
      counts[fn]++;
      return route.fulfill({ status: 200, contentType: "application/json", headers: hdr, body: JSON.stringify(fn === "get_fixtures" ? live.fixtures : live.config) });
    });
  }
}

// The designer's config, as StructureStudioInner holds it (no debug hook exists; the React fiber).
const innerFixtures = (page) => page.evaluate(() => {
  const root = document.getElementById("root");
  const k = Object.keys(root).find((x) => x.startsWith("__reactContainer"));
  const q = [root[k]]; let n = 0;
  while (q.length && n < 80000) {
    const f = q.shift(); n++; if (!f) continue;
    const nm = f.type && (f.type.name || f.type.displayName);
    if (nm === "StructureStudioInner") return (f.memoizedProps.config.fixtures || []).map((x) => `${x.id}:${x.doorStyle}`).join(",");
    if (f.child) q.push(f.child);
    if (f.sibling) q.push(f.sibling);
  }
  return null;
});
// The docked panel's parts for one door, by ssDoorPart.
const dockParts = (page, id) => page.evaluate((id) => {
  const P = window.__ss3dPanel;
  if (!P || !P.model) return null;
  const og = P.model.openingsGroup.children.find((g) => g.userData && g.userData.itemId === id);
  if (!og) return null;
  const o = {};
  og.traverse((m) => { const p = m.userData && m.userData.ssDoorPart; if (m.isMesh && p) o[p] = (o[p] || 0) + 1; });
  return o;
}, id);
const waitFor = async (fn, ms = 12000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 250)); } };

const { browser } = await launch();
try {
  // The plan's building rectangle, from a fresh designer of the same size.
  const ctx0 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const p0 = await ctx0.newPage();
  await stubSupabase(p0, { config: CONFIG, fixtures: live.fixtures });
  await openDesigner(p0, CONFIG.clientId);
  await p0.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 40000 });
  await pickStyle(p0, "Utility");
  await settle(p0, 600);
  const rect = await buildingRect(p0);
  await ctx0.close();

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const CODE = "SS-HARNREFRSH";
  const door = { id: 501, type: "fixtureDoor", x: rect.x + 6 * (rect.w / W), y: rect.y + rect.h, rotation: 0, wall: "south", widthFt: 5, heightFt: 0.5,
    fixtureItemId: "d-dbl", doorName: "Double door", planLabel: "DD", price: 300, widthIn: 60, heightIn: 72, swing: "out", operation: "double",
    colorId: null, colorLabel: null, colorHex: null, trimColorId: null, trimColorLabel: null, trimColorHex: null, sillMode: "fixed" };
  const row = { short_code: CODE, status: "draft", selections: { style: "utility", size: SIZE }, items: [door],
    contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100", street: "", city: "", state: "", zip: "" },
    paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {} };
  await stubSupabase(page, { config: CONFIG, fixtures: live.fixtures, rpc: { load_design: [row] } });
  await routeLive(page);   // registered after the stub, so it answers first
  await bypassGate(page, CONFIG.clientId);
  await page.goto(`${BASE}/?client=${encodeURIComponent(CONFIG.clientId)}&id=${CODE}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  const loaded = await waitFor(async () => ((await readItems(page)) || []).some((i) => i.id === 501), 30000);
  ok("A the saved design opens with its double door", !!loaded);
  const show = page.getByRole("button", { name: /Show 3D/ });
  if (await show.count()) await show.first().click();
  const p1 = await waitFor(() => dockParts(page, 501), 90000);
  ok("A the docked 3D draws the door as its row says (auto: no pickets)", !!p1 && !p1.picket, JSON.stringify(p1));
  ok("A the designer holds the row as auto", (await innerFixtures(page)) === "d-dbl:auto", await innerFixtures(page));
  await page.screenshot({ path: join(shots, "a-auto.png") });
  const itemsBefore = JSON.stringify(await readItems(page));
  const fx0 = counts.get_fixtures;

  // Another tab of the same browser, on the same origin.
  const other = await ctx.newPage();
  await other.goto(`${BASE}/vendor/`, { waitUntil: "domcontentloaded" });
  const announce = (clientId) => other.evaluate((cid) => { const bc = new BroadcastChannel("ss-settings"); bc.postMessage({ clientId: cid, at: Date.now() }); bc.close(); }, clientId);

  live.fixtures = fixturesWith("american");
  await announce("some-other-tenant");
  await settle(page, 1500);
  ok("B a save on another tenant fetches nothing", counts.get_fixtures === fx0, `${counts.get_fixtures - fx0} fetches`);
  ok("B ...and changes nothing", (await innerFixtures(page)) === "d-dbl:auto", await innerFixtures(page));

  await announce(CONFIG.clientId);
  const got = await waitFor(async () => (await innerFixtures(page)) === "d-dbl:american", 8000);
  ok("C a save announced from another tab: the designer holds the new look", !!got, await innerFixtures(page));
  ok("C ...after exactly one get_fixtures", counts.get_fixtures === fx0 + 1, `${counts.get_fixtures - fx0}`);
  const p2 = await waitFor(async () => { const p = await dockParts(page, 501); return p && p.picket ? p : null; }, 10000);
  ok("C the docked 3D redraws the door as American (pickets)", !!p2, JSON.stringify(await dockParts(page, 501)));
  ok("C the plan is untouched", JSON.stringify(await readItems(page)) === itemsBefore);
  await page.screenshot({ path: join(shots, "c-american.png") });

  live.fixtures = fixturesWith("classic");
  await page.evaluate((cid) => window.dispatchEvent(new CustomEvent("ss:settings-saved", { detail: { clientId: cid } })), CONFIG.clientId);
  const p3 = await waitFor(async () => { const p = await dockParts(page, 501); return p && p.diamond ? p : null; }, 10000);
  ok("D a save in the same tab: the 3D redraws the door as Classic (diamond)", !!p3, JSON.stringify(await dockParts(page, 501)));
  ok("D the plan is still untouched", JSON.stringify(await readItems(page)) === itemsBefore);
  await page.screenshot({ path: join(shots, "d-classic.png") });

  const LINE = /Your settings changed after this designer opened/;
  ok("E no line while the config is the same", !LINE.test(await page.innerText("body")));
  live.config = { ...CONFIG, branding: { ...CONFIG.branding, companyName: "Acme Sheds and Barns" } };
  await announce(CONFIG.clientId);
  const lineUp = await waitFor(async () => LINE.test(await page.innerText("body")), 8000);
  ok("E a changed config is offered: the line appears", !!lineUp);
  ok("E ...and the plan stays as it was", JSON.stringify(await readItems(page)) === itemsBefore);
  await page.screenshot({ path: join(shots, "e-line.png") });
  await page.getByRole("button", { name: "Not now" }).click();
  await settle(page, 300);
  ok("E Not now hides it", !LINE.test(await page.innerText("body")));
  await announce(CONFIG.clientId);
  await waitFor(async () => LINE.test(await page.innerText("body")), 8000);
  const cfg0 = counts.get_config;
  await page.getByRole("button", { name: "Reload designer" }).click();
  const reloaded = await waitFor(async () => counts.get_config > cfg0 && !LINE.test(await page.innerText("body")) && (await innerFixtures(page)) === "d-dbl:classic", 20000);
  ok("E Reload designer reloads the config and the line goes", !!reloaded, `${counts.get_config - cfg0} config reads`);
  ok("F no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} finally {
  await browser.close();
}
process.exit(failed().length ? 1 : 0);
