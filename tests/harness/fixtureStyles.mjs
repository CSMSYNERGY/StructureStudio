// "Offered on": catalog items sold on some building styles only, driven for real on the COMPILED
// designer and the COMPILED portal (migration 272).
//
// Feature request 2026-10-02: "I need my louvered vents to only be for greenhouse style
// buildings." The builder's catalog here is that shape: a standard vent on every style, a louvered
// window vent and a louvered fan on the Greenhouse only, and a garage door on the Deluxe only
// (the same switch, on a door).
//
//   A. the Vent picker on the Greenhouse offers all three vents
//   B. on the Deluxe it offers only the standard vent: one vent, so the Vent button arms it
//      straight away and no picker opens; a click on the wall places the standard vent
//   C. the Door picker: the garage door on the Deluxe, not on the Greenhouse
//   D. a louvered vent placed on the Greenhouse comes OFF when the customer switches to the Deluxe
//      (a style pick keeps every placed item otherwise), with a toast saying why; the standard
//      vent stays; switching back puts nothing back and says nothing
//   E. a saved design OPENED on the Deluxe with a louvered vent keeps it exactly as saved (a
//      load is never rewritten); the customer's own next switch away and back takes it off
//   F. the 3D editor's Add row: LVNT and FAN on the Greenhouse, neither on the Deluxe
//   G. the same catalog with no "Offered on" ticks (every catalog today): every vent and door on
//      both styles, exactly as before
//   H. the portal's Vents list: the "Offered on" ticks in the edit panel, the summary line, all
//      ticked saving as null ("every style"), one unticked saving that list (the hidden style
//      carried through), none ticked refused; a line on every VISIBLE style but not the hidden one
//      keeps its list on a price edit and on Archive, never widening to "every style"
//   R. a garage door with a ramp on it, on the Deluxe: switching to the Greenhouse (same size)
//      takes off the door AND its ramp, and the toast says the ramp went with it
//   S. a style sold in one size of OTHER dimensions (Greenhouse 10x12, Deluxe 12x16): the switch
//      reflows the plan and still takes the louvered vent off, with the toast
//   T. a vent tool armed on the Greenhouse for the louvered vent is disarmed by the switch to the
//      Deluxe, where that tool no longer exists (armed, every plan click did nothing)
//
// Supabase is stubbed at the network layer; nothing leaves the machine and NOTHING IS SAVED.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/fixtureStyles.mjs          (exit 0 = every check held; SS_SKIP_3D=1 skips F)
//
// Shots land in %TEMP%/ss-harness/fixture-styles (SS_SHOTS overrides). Fixtures are made up (a
// made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, revealTool, bypassGate } from "./lib.mjs";
import { pickStyle, openEditor } from "./gableProbe.mjs";

const { ok, failed } = reporter();
const shots = shotsDir("fixture-styles");
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const W = 10, L = 12, SIZE = `${W}x${L}`;
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const CORS = { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" };

// ── The designer ──────────────────────────────────────────────────────────────────────────────
const D3 = {
  roof: { eave: "fascia", type: "gable", pitch: 0.42, overhang: 0.8, ridgeOffset: 0 },
  colors: { body: "#4a3327", roof: "#8a8f94", trim: "#b0a081" },
  siding: "panel", foundation: "skids", roofMaterial: "metal", wallHeightFt: 7.5,
};
const style = (value, label) => ({ value, label, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3 });
const CONFIG = {
  clientId: "harness-offered-on",
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: [style("greenhouse", "Greenhouse"), style("deluxe", "Deluxe")],
  defaultSizes: [SIZE],
  sizePricing: { greenhouse: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 6000 } }, deluxe: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 5000 } } },
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: !process.env.SS_SKIP_3D, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};
const base = { colorMode: "fixed", imageUrl: null, opLeft: false, opRight: false, opDouble: false, opSlideUp: false, opDefault: null,
  swingIn: false, swingOut: false, swingDefault: null, hasTrimColor: false };
const ITEMS = [
  { ...base, id: "v-std", category: "vent", name: "Standard vent", planLabel: "SVNT", price: 0, widthIn: 11, heightIn: 8, sortOrder: 0 },
  { ...base, id: "v-lou", category: "vent", name: "Louvered window vent", planLabel: "LVNT", price: 45, widthIn: 16, heightIn: 24, sortOrder: 1, styleKeys: ["greenhouse"] },
  { ...base, id: "v-fan", category: "vent", name: "Louvered fan w/ thermostat", planLabel: "FAN", price: 150, widthIn: 12, heightIn: 12, sortOrder: 2, styleKeys: ["greenhouse"] },
  { ...base, id: "d-std", category: "door", name: "Single door", planLabel: "SD", price: 300, widthIn: 36, heightIn: 76, sortOrder: 0, swingOut: true, opRight: true, sillIn: null, sillMode: "fixed" },
  { ...base, id: "d-gar", category: "door", name: "Garage door", planLabel: "GAR", price: 900, widthIn: 96, heightIn: 84, sortOrder: 1, opSlideUp: true, sillIn: null, sillMode: "fixed", styleKeys: ["deluxe"] },
];
const fixtures = (items) => ({ items, windowColors: [], ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false } });
const RESTRICTED = fixtures(ITEMS);
const OPEN = fixtures(ITEMS.map(({ styleKeys: _k, ...f }) => f));   // today's catalog: no ticks anywhere

const OFF_DELUXE = "The Louvered window vent isn't offered on the Deluxe, so it was taken off your building.";
const bodyHas = (page, text, timeout = 3000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout }).then(() => true, () => false);
const vents = async (page) => ((await readItems(page)) || []).filter((i) => i.isVent);

async function open(page, fx, rpc, config = CONFIG) {
  await stubSupabase(page, { config, fixtures: fx, rpc });
  await openDesigner(page, config.clientId);
  await page.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 40000 });
}
// A style sold in one size takes that size with the click, so the plan is 10x12 straight away.
async function choose(page, label) {
  await pickStyle(page, label);
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 20000 });
  await settle(page, 500);
}
// The Vent button: [opened a picker?, the vent names it offers].
async function ventButton(page) {
  await (await revealTool(page, /^\W*Vent wall$/u)).click();
  await settle(page, 400);
  const cards = await page.locator("[data-ss-vent-card]").evaluateAll((els) => els.map((e) => e.getAttribute("data-ss-vent-card")));
  return { picker: cards.length > 0, cards };
}
async function closeModal(page) {
  await page.mouse.click(4, 4);
  await settle(page, 300);
}
// A click just inside the long east wall at `frac` of its length.
async function eastWall(page, frac) {
  const r = await buildingRect(page);
  return svgPoint(page, r.x + r.w - 0.4 * (r.w / W), r.y + frac * r.h);
}
async function placeVent(page, name, frac) {
  const before = new Set(((await readItems(page)) || []).map((i) => i.id));
  const b = await ventButton(page);
  if (b.picker) { await page.locator("[data-ss-vent-card]").filter({ hasText: name }).first().click(); await settle(page, 300); }
  const p = await eastWall(page, frac);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  return ((await readItems(page)) || []).find((i) => !before.has(i.id)) || null;
}
// The door names the Door picker offers, read from its modal after a wall click.
async function doorPicker(page) {
  await (await revealTool(page, /^Door wall$/)).click();
  await settle(page, 300);
  const p = await eastWall(page, 0.5);
  await page.mouse.click(p.x, p.y);
  await page.getByText("Choose a door").first().waitFor({ timeout: 5000 }).catch(() => {});
  const text = await page.locator("body").innerText();
  await closeModal(page);
  // Disarm the tool, so the next step starts from nothing armed.
  const btn = await revealTool(page, /^Door wall$/);
  if (await btn.evaluate((b) => b.classList.contains("is-armed")).catch(() => false)) await btn.click();
  return { open: text.includes("Choose a door"), single: text.includes("Single door"), garage: text.includes("Garage door") };
}

async function runPickers(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  try {
    await open(page, RESTRICTED);
    await choose(page, "Greenhouse");
    let v = await ventButton(page);
    ok("A the Vent picker on the Greenhouse offers all three vents",
      v.picker && JSON.stringify(v.cards) === JSON.stringify(["v-std", "v-lou", "v-fan"]), JSON.stringify(v.cards));
    await page.screenshot({ path: join(shots, "A-greenhouse-vent-picker.png") });
    await closeModal(page);

    let d = await doorPicker(page);
    ok("C the Door picker on the Greenhouse has the single door and NOT the garage door", d.open && d.single && !d.garage, JSON.stringify(d));

    await choose(page, "Deluxe");
    v = await ventButton(page);
    const armed = await (await revealTool(page, /^\W*Vent wall$/u)).evaluate((b) => b.classList.contains("is-armed"));
    ok("B on the Deluxe only the standard vent is offered, so the Vent button arms it with no picker",
      !v.picker && armed, JSON.stringify({ picker: v.picker, cards: v.cards, armed }));
    await page.screenshot({ path: join(shots, "B-deluxe-vent-armed-no-picker.png") });
    const p = await eastWall(page, 0.5);
    await page.mouse.click(p.x, p.y);
    await settle(page, 600);
    const placed = await vents(page);
    ok("B a wall click places the standard vent", placed.length === 1 && placed[0].windowName === "Standard vent" && placed[0].fixtureItemId === "v-std",
      JSON.stringify(placed.map((i) => [i.windowName, i.fixtureItemId])));

    d = await doorPicker(page);
    ok("C the Door picker on the Deluxe has both doors", d.open && d.single && d.garage, JSON.stringify(d));
    ok("A-C no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

async function runCarryOver(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  try {
    await open(page, RESTRICTED);
    await choose(page, "Greenhouse");
    const lou = await placeVent(page, "Louvered window vent", 0.3);
    const std = await placeVent(page, "Standard vent", 0.7);
    ok("D a louvered and a standard vent go onto the Greenhouse",
      !!lou && lou.fixtureItemId === "v-lou" && !!std && std.fixtureItemId === "v-std", JSON.stringify([lou && lou.windowName, std && std.windowName]));
    await page.screenshot({ path: join(shots, "D1-greenhouse-two-vents.png") });

    await choose(page, "Deluxe");
    const toast = await bodyHas(page, OFF_DELUXE);
    const left = await vents(page);
    ok("D switching to the Deluxe takes the louvered vent off and keeps the standard one",
      left.length === 1 && left[0].fixtureItemId === "v-std" && left[0].id === (std && std.id), JSON.stringify(left.map((i) => [i.id, i.windowName])));
    ok("D ...and the toast says why, in plain words", toast);
    await page.screenshot({ path: join(shots, "D2-deluxe-louvered-taken-off.png") });

    await page.waitForFunction((t) => !document.body.innerText.includes(t), OFF_DELUXE, { timeout: 8000 }).catch(() => {});
    await choose(page, "Greenhouse");
    const back = await vents(page);
    ok("D back on the Greenhouse nothing is put back, and nothing is said",
      back.length === 1 && back[0].fixtureItemId === "v-std" && !(await bodyHas(page, "isn't offered on", 1500)), JSON.stringify(back.map((i) => i.windowName)));
    ok("D no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    return lou;
  } finally {
    await ctx.close();
  }
}

async function runLoad(browser, lou) {
  const CODE = "SS-HARN72";
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  try {
    // A design saved on the Deluxe with a louvered vent on it: the shape a design carries
    // when the builder ticks "Offered on" after it was saved.
    const row = {
      short_code: CODE, status: "draft", selections: { style: "deluxe", size: SIZE },
      items: [{ ...lou, id: 1 }], contact: { name: "", email: "", phone: "", street: "", city: "", state: "", zip: "" },
      paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
    };
    await stubSupabase(page, { config: CONFIG, fixtures: RESTRICTED, rpc: { load_design: [row] } });
    await bypassGate(page, CONFIG.clientId);
    await page.goto(`${BASE}/?client=${encodeURIComponent(CONFIG.clientId)}&id=${CODE}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
    let loaded = [];
    for (let k = 0; k < 60 && !loaded.length; k++) { await settle(page, 500); loaded = await vents(page); }
    await settle(page, 1500);
    loaded = await vents(page);
    ok("E an opened design keeps its louvered vent exactly as saved (a load is never rewritten)",
      loaded.length === 1 && loaded[0].fixtureItemId === "v-lou" && loaded[0].x === lou.x && loaded[0].y === lou.y, JSON.stringify(loaded.map((i) => [i.windowName, i.x, i.y])));
    ok("E ...and says nothing", !(await bodyHas(page, "isn't offered on", 800)));
    await choose(page, "Greenhouse");
    ok("E the customer's switch to the Greenhouse keeps it (offered there)", (await vents(page)).length === 1 && !(await bodyHas(page, "isn't offered on", 800)));
    await choose(page, "Deluxe");
    const toast = await bodyHas(page, OFF_DELUXE);
    ok("E ...and the switch back to the Deluxe takes it off, with the toast", (await vents(page)).length === 0 && toast);
    ok("E no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

// ── R/S/T. What goes with a switch: a door's ramp, a size of other dimensions, an armed tool ──
// The same catalog with the simple ramp switched on, so a ramp can sit on the garage door.
const RAMPED = { ...RESTRICTED, ramp: { ...RESTRICTED.ramp, enabled: true, price: 125 } };
// The Greenhouse at 10x12 and the Deluxe at 12x16, one size each: the style click takes that size
// in the same commit, so the size effect reflows the plan before the style effect runs.
const sized = (value, label, w, l) => ({ ...style(value, label), sizes: [`${w}x${l}`] });
const CONFIG_SIZED = {
  ...CONFIG,
  buildingStyles: [sized("greenhouse", "Greenhouse", 10, 12), sized("deluxe", "Deluxe", 12, 16)],
  defaultSizes: ["10x12", "12x16"],
  sizePricing: { greenhouse: { "10x12": { widthFt: 10, lengthFt: 12, basePrice: 6000 } }, deluxe: { "12x16": { widthFt: 12, lengthFt: 16, basePrice: 5000 } } },
};
const armedHint = (page) => page.locator(".ssd-tb-hint").filter({ hasText: "← Click" }).count();

async function runRamp(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  try {
    await open(page, RAMPED);
    await choose(page, "Deluxe");
    await (await revealTool(page, /^Door wall$/)).click();
    await settle(page, 300);
    let p = await eastWall(page, 0.5);
    await page.mouse.click(p.x, p.y);
    await settle(page, 600);
    await page.getByText("Garage door", { exact: true }).first().click({ timeout: 10000 });
    await settle(page, 300);
    await page.getByRole("button", { name: "Place door" }).click();
    await settle(page, 600);
    await (await revealTool(page, /Ramp/)).click();
    await settle(page, 300);
    p = await eastWall(page, 0.5);
    await page.mouse.click(p.x, p.y);
    await settle(page, 600);
    let items = (await readItems(page)) || [];
    const door = items.find((i) => i.fixtureItemId === "d-gar");
    const ramp = items.find((i) => i.type === "ramp");
    ok("R a garage door on the Deluxe, with a ramp on it", !!door && !!ramp && ramp.snapDoorId === door.id,
      JSON.stringify(items.map((i) => [i.type, i.fixtureItemId || null, i.snapDoorId || null])));
    await page.screenshot({ path: join(shots, "R1-deluxe-garage-door-ramp.png") });

    await choose(page, "Greenhouse");
    const said = "The Garage door isn't offered on the Greenhouse, so it was taken off your building. The ramp on the Garage door was taken off with it.";
    const toast = await bodyHas(page, said);
    items = (await readItems(page)) || [];
    ok("R switching to the Greenhouse (same size) takes off the door AND its ramp",
      !items.some((i) => i.fixtureItemId === "d-gar") && !items.some((i) => i.type === "ramp"),
      JSON.stringify(items.map((i) => [i.type, i.fixtureItemId || null, i.snapDoorId || null])));
    ok("R ...and the toast says the ramp went with it", toast);
    await page.screenshot({ path: join(shots, "R2-greenhouse-door-and-ramp-off.png") });
    ok("R no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

async function runSized(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const lengthShown = (l) => page.waitForFunction((n) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${n} ft`), l, { timeout: 20000 });
  try {
    await open(page, RESTRICTED, undefined, CONFIG_SIZED);
    await pickStyle(page, "Greenhouse");
    await lengthShown(12);
    await settle(page, 500);
    const lou = await placeVent(page, "Louvered window vent", 0.3);
    ok("S a louvered vent on the Greenhouse at 10x12", !!lou && lou.fixtureItemId === "v-lou", JSON.stringify(lou && lou.windowName));

    await pickStyle(page, "Deluxe");
    await lengthShown(16);
    await settle(page, 500);
    const toast = await bodyHas(page, OFF_DELUXE);
    const left = await vents(page);
    ok("S the switch to the Deluxe at 12x16 reflows the plan AND takes the louvered vent off",
      !left.some((i) => i.fixtureItemId === "v-lou"), JSON.stringify(left.map((i) => [i.windowName, i.x, i.y])));
    ok("S ...with the toast", toast);
    await page.screenshot({ path: join(shots, "S-deluxe-12x16-louvered-off.png") });

    // T. Back on the Greenhouse, arm the louvered vent, then switch with it armed.
    await page.waitForFunction((t) => !document.body.innerText.includes(t), OFF_DELUXE, { timeout: 8000 }).catch(() => {});
    await pickStyle(page, "Greenhouse");
    await lengthShown(12);
    await settle(page, 500);
    const b = await ventButton(page);
    if (b.picker) { await page.locator('[data-ss-vent-card="v-lou"]').first().click(); await settle(page, 300); }
    ok("T the louvered vent tool is armed on the Greenhouse", b.picker && (await armedHint(page)) === 1);
    await pickStyle(page, "Deluxe");
    await lengthShown(16);
    await settle(page, 500);
    ok("T the switch to the Deluxe disarms it (the tool no longer exists there)", (await armedHint(page)) === 0);
    await page.screenshot({ path: join(shots, "T-deluxe-tool-disarmed.png") });
    ok("S-T no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

async function runAddRow(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  // The 3D engine is published for a harness only when this is set before the viewer opens.
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const errors = collectErrors(page);
  try {
    await open(page, RESTRICTED);
    await choose(page, label);
    await openEditor(page);
    const btns = await page.locator("button").evaluateAll((els) => els.map((b) => b.innerText.replace(/\s+/g, " ").trim()).filter((t) => /^\S+ (SVNT|LVNT|FAN)$/u.test(t)));
    await page.screenshot({ path: join(shots, `F-add-row-${label.replace(/\s+/g, "-").toLowerCase()}.png`) });
    return { btns: btns.map((t) => t.split(" ").pop()), errors };
  } finally {
    await ctx.close();
  }
}

async function runOpenCatalog(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  try {
    await open(page, OPEN);
    for (const label of ["Greenhouse", "Deluxe"]) {
      await choose(page, label);
      const v = await ventButton(page);
      ok(`G with no ticks, the Vent picker on the ${label} offers all three vents (as today)`,
        v.picker && JSON.stringify(v.cards) === JSON.stringify(["v-std", "v-lou", "v-fan"]), JSON.stringify(v.cards));
      await closeModal(page);
      const d = await doorPicker(page);
      ok(`G ...and the Door picker both doors`, d.open && d.single && d.garage, JSON.stringify(d));
    }
    ok("G no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

// ── H. The portal's Vents list ────────────────────────────────────────────────────────────────
const CLIENT = "acme-sheds";
const GH = "00000000-0000-4000-8000-0000000000a1";
const DX = "00000000-0000-4000-8000-0000000000a2";
const HIDDEN = "00000000-0000-4000-8000-0000000000a3";
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
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const ventRow = (id, name, styleIds, sort) => ({ id, category: "vent", name, plan_label: null, width_in: 11, height_in: 8, price: 0,
  swing_in: false, swing_out: false, swing_default: null, op_right: false, op_left: false, op_double: false, op_slideup: false, op_default: null,
  color_mode: "fixed", has_trim_color: false, fixed_color_id: null, window_color_ids: null, style_ids: styleIds, sill_in: null, sill_mode: "fixed",
  door_style: "auto", image_url: null, show_image_on_estimate: true, sort_order: sort, active: true, archived: false, internal_only: false, taxable: true });

async function portalRun(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const saves = [];
  const outside = [];
  const stored = [ventRow("00000000-0000-4000-8000-0000000000b1", "Standard vent", null, 0), ventRow("00000000-0000-4000-8000-0000000000b2", "Louvered window vent", [GH], 1),
    // On both VISIBLE styles but not the hidden one: "every style" must not swallow it on a save.
    ventRow("00000000-0000-4000-8000-0000000000b3", "Ridge vent", [GH, DX], 2)];
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => { outside.push(route.request().url()); return route.abort(); });
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, false);
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER_ACCESS, prefs: null,
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false,
          businessName: "Acme Sheds", businessPhone: "(555) 010-0100", businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "catalog":
        return json(route, { ok: true, clientId: CLIENT, sizes: [], items: [], inclusions: [], layoutPricing: [], colors: [], windowColors: [], wallHeights: [], insulation: [],
          styles: [{ id: GH, key: "greenhouse", label: "Greenhouse", active: true }, { id: DX, key: "deluxe", label: "Deluxe", active: true },
            { id: HIDDEN, key: "retired", label: "Retired Style", active: false }],
          fixtures: stored });
      case "save_fixture": {
        saves.push(body);
        // save_fixture's answer: an update in place, the row as the server would now read it.
        const at = stored.findIndex((r) => r.id === body.id);
        if (at >= 0 && Object.prototype.hasOwnProperty.call(body, "styleIds")) stored[at] = { ...stored[at], style_ids: body.styleIds };
        return json(route, { ok: true, id: body.id });
      }
      default: return json(route, { ok: true });
    }
  };
  await ctx.route(`**/${REF}.supabase.co/**`, handler);
  await ctx.route(`**/${REF}.functions.supabase.co/**`, handler);
  try {
    await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
    await settle(page, 600);
    await page.evaluate(() => { history.pushState({}, "", "/portal/settings/vents"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await page.waitForFunction(() => document.body.innerText.includes("Louvered window vent"), null, { timeout: 20000 }).catch(() => {});
    await settle(page, 600);
    const rowOf = (name) => page.locator("[draggable]").filter({ has: page.getByText(name, { exact: true }) }).first();
    const loaded = ok("H0 the Vents list rendered", await rowOf("Louvered window vent").count() > 0);
    if (!loaded) throw new Error("the list never rendered; refusing to report the rest as passes");

    const sumLou = (await rowOf("Louvered window vent").innerText()).replace(/\s+/g, " ");
    const sumStd = (await rowOf("Standard vent").innerText()).replace(/\s+/g, " ");
    ok("H1 the louvered vent's line says \"only on Greenhouse\"; the standard vent's says nothing of styles",
      sumLou.includes("only on Greenhouse") && !sumStd.includes("only on"), `${sumLou} | ${sumStd}`);
    ok("H1 the Vents help says where the switch is",
      (await page.locator("body").innerText()).replace(/\s+/g, " ").includes("To sell a vent on some building styles only, click Edit and untick the others under Offered on."));

    await rowOf("Standard vent").getByRole("button", { name: "Edit" }).click();
    await settle(page, 300);
    const boxes = page.locator("[data-ss-offered-on]");
    const keys = await boxes.evaluateAll((els) => els.map((e) => [e.getAttribute("data-ss-offered-on"), e.querySelector("input").checked]));
    ok("H2 the edit panel has an Offered on tick per style the builder sells (the hidden one left out), all ticked",
      JSON.stringify(keys) === JSON.stringify([["greenhouse", true], ["deluxe", true]]), JSON.stringify(keys));
    ok("H2 ...and says it is offered on every style", (await page.locator("body").innerText()).includes("Offered on every style, and on any style you add later."));
    await page.screenshot({ path: join(shots, "H2-offered-on-all.png") });

    await page.locator('[data-ss-offered-on="deluxe"] input').uncheck();
    await settle(page, 200);
    ok("H3 unticking the Deluxe says customers of other styles won't see it",
      (await page.locator("body").innerText()).includes("Customers designing any other style won't see this vent."));
    let n = saves.length;
    await page.getByRole("button", { name: "Save vent" }).click();
    for (let i = 0; i < 20 && saves.length === n; i++) await settle(page, 200);
    await settle(page, 400);
    // "Every style" included the hidden one, so unticking the Deluxe keeps it: [Greenhouse, hidden].
    ok("H3 the save sends styleIds [Greenhouse, the hidden style] for the vent", saves.length === n + 1 && saves[n].category === "vent"
      && JSON.stringify(saves[n].styleIds) === JSON.stringify([GH, HIDDEN]), JSON.stringify(saves[n] && { category: saves[n].category, styleIds: saves[n].styleIds }));
    const sumStd2 = (await rowOf("Standard vent").innerText()).replace(/\s+/g, " ");
    ok("H3 ...and its line now says \"only on Greenhouse\"", sumStd2.includes("only on Greenhouse"), sumStd2);
    await page.screenshot({ path: join(shots, "H3-saved-greenhouse-only.png") });

    await rowOf("Standard vent").getByRole("button", { name: "Edit" }).click();
    await settle(page, 300);
    await page.locator('[data-ss-offered-on="greenhouse"] input').uncheck();
    await settle(page, 200);
    const save = page.getByRole("button", { name: "Save vent" });
    ok("H4 with no style ticked the panel says so and Save waits",
      (await page.locator("body").innerText()).includes("Tick at least one style. To stop offering this vent everywhere, untick Active instead.") && await save.isDisabled());
    await page.screenshot({ path: join(shots, "H4-none-ticked.png") });
    await page.locator('[data-ss-offered-on="greenhouse"] input').check();
    await page.locator('[data-ss-offered-on="deluxe"] input').check();
    await settle(page, 200);
    n = saves.length;
    await save.click();
    for (let i = 0; i < 20 && saves.length === n; i++) await settle(page, 200);
    await settle(page, 400);
    ok("H5 every style ticked saves as null (\"every style\", and any added later)",
      saves.length === n + 1 && saves[n].styleIds === null, JSON.stringify(saves[n] && saves[n].styleIds));
    ok("H5 ...and the line says nothing of styles again", !(await rowOf("Standard vent").innerText()).includes("only on"));

    // H6/H7. Ticked on every VISIBLE style, not on the hidden one. A price edit and Archive both
    // send the line's list; judged against the visible ticks alone it went over as null, every
    // style, and the vent came back on the hidden style when it was shown again.
    const sumRidge = (await rowOf("Ridge vent").innerText()).replace(/\s+/g, " ");
    ok("H6 a line on both visible styles (not the hidden one) says so", sumRidge.includes("only on Greenhouse, Deluxe"), sumRidge);
    await rowOf("Ridge vent").getByRole("button", { name: "Edit" }).click();
    await settle(page, 300);
    ok("H6 ...and its panel does not claim every style",
      !(await page.locator("body").innerText()).includes("Offered on every style, and on any style you add later."));
    await page.locator('input[type="number"][placeholder="0"]').first().fill("35");
    n = saves.length;
    await page.getByRole("button", { name: "Save vent" }).click();
    for (let i = 0; i < 20 && saves.length === n; i++) await settle(page, 200);
    await settle(page, 400);
    ok("H6 a price-only save keeps styleIds [Greenhouse, Deluxe], never null",
      saves.length === n + 1 && String(saves[n].price) === "35" && JSON.stringify(saves[n].styleIds) === JSON.stringify([GH, DX]),
      JSON.stringify(saves[n] && { price: saves[n].price, styleIds: saves[n].styleIds }));
    n = saves.length;
    await rowOf("Ridge vent").getByRole("button", { name: "Archive" }).click();
    for (let i = 0; i < 20 && saves.length === n; i++) await settle(page, 200);
    await settle(page, 400);
    ok("H7 Archive keeps styleIds [Greenhouse, Deluxe] too",
      saves.length === n + 1 && saves[n].archived === true && JSON.stringify(saves[n].styleIds) === JSON.stringify([GH, DX]),
      JSON.stringify(saves[n] && { archived: saves[n].archived, styleIds: saves[n].styleIds }));

    ok("H nothing but the web-font stylesheet tried to leave (and it was aborted)",
      outside.every((u) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)), outside.slice(0, 3).join(" "));
    ok("H no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

const { browser } = await launch({ width: 1440, height: 1000 });
try {
  // Each run reports on its own, so one that stops early does not hide the others.
  try { await runPickers(browser); } catch (e) { ok("A-C ran to the end", false, String(e.message).split("\n")[0]); }
  let lou = null;
  try { lou = await runCarryOver(browser); } catch (e) { ok("D ran to the end", false, String(e.message).split("\n")[0]); }
  if (lou) {
    try { await runLoad(browser, lou); } catch (e) { ok("E ran to the end", false, String(e.message).split("\n")[0]); }
  } else ok("E has a louvered vent to save", false, "D placed none");
  if (!process.env.SS_SKIP_3D) {
    try {
      const gh = await runAddRow(browser, "Greenhouse");
      const dx = await runAddRow(browser, "Deluxe");
      ok("F the 3D Add row on the Greenhouse has SVNT, LVNT and FAN", JSON.stringify(gh.btns) === JSON.stringify(["SVNT", "LVNT", "FAN"]), JSON.stringify(gh.btns));
      ok("F ...and on the Deluxe only SVNT", JSON.stringify(dx.btns) === JSON.stringify(["SVNT"]), JSON.stringify(dx.btns));
      ok("F no page errors", gh.errors.length === 0 && dx.errors.length === 0, [...gh.errors, ...dx.errors].slice(0, 3).join(" | "));
    } catch (e) { ok("F ran to the end", false, String(e.message).split("\n")[0]); }
  }
  try { await runOpenCatalog(browser); } catch (e) { ok("G ran to the end", false, String(e.message).split("\n")[0]); }
  try { await runRamp(browser); } catch (e) { ok("R ran to the end", false, String(e.message).split("\n")[0]); }
  try { await runSized(browser); } catch (e) { ok("S-T ran to the end", false, String(e.message).split("\n")[0]); }
  try { await portalRun(browser); } catch (e) { ok("H ran to the end", false, String(e.message).split("\n")[0]); }
} finally {
  await browser.close();
}
const bad = failed();
console.log(bad.length ? `\n${bad.length} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
console.log(`shots: ${shots}`);
process.exit(bad.length ? 1 : 0);
