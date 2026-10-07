// THE METAL ROOF PROFILE, PER DESIGN (2026-10-06), driven in the real designer against the COMPILED
// bundle and measured off the scene graph (__SS3D_DEBUG).
//
// Carolyn, 10-06: "there is no standard it is per individual design". A rep picks AG Panel or Standing
// Seam on each design in the portal Designer's Roof options card; the style's own value is where a
// design starts; the public page never offers the choice but draws what a rep picked. What is proved:
//
//   P. THE PORTAL (portal.html, the Designer tab, view_3d granted), a style that says nothing (AG Panel):
//      1. Roof Type Shingle shows no Profile field (the card holds 2 fields); Metal shows it between Type
//         and Color (3 fields), at the style's starting value, AG Panel, and the docked 3D draws AG
//         Panel: a 3 ft tile with 4 drawn ribs.
//      2. Standing Seam redraws the dock in place: a 6 ft tile, no drawn ribs; the note says no charge
//         is added and, this session holding no "Override prices" (the stub's access map is empty),
//         sends the rep to an owner or admin to adjust it; Details' Roof row reads
//         "Metal (Standing Seam) — Charcoal" at the same price.
//      3. The full-screen viewer draws the same 6 ft pans (close-up to the shots folder).
//      4. Shingle takes the field away and draws shingle; Metal again finds Standing Seam still picked.
//      5. The submit carries roofProfile "standingseam" to submit-estimate and in save_design's
//         selections, beside roofType/roofColor.
//   Q. THE PORTAL, other directions: a fresh Metal design with no pick submits roofProfile "" (the key is
//      always there, so "" is a real clear); a Standing Seam STYLE starts the field at Standing Seam and
//      draws 6 ft pans with no pick, and picking AG Panel draws the 3 ft sheet and submits "agpanel".
//   R. SAVE AND RELOAD: the design P saved, reopened in the embedded designer (load_design answered with
//      exactly the selections P's save_design sent), shows Standing Seam in the field and draws 6 ft pans.
//      That mount passes canOverridePrice, so its note tells the rep to adjust the price themselves.
//   S. THE PUBLIC PAGE: the same saved design opened by its link draws Standing Seam and quotes
//      "Metal (Standing Seam) — Charcoal", and no Profile field is anywhere on the page, before or after
//      the customer picks Metal again.
//   E. THE CALIBRATION PANEL (?admin=1) with that design open on the same page: opening the style's 3D
//      calibration and saving it untouched sends the style's own profile (none), never the design's
//      Standing Seam (openCalEditor resolves the style without the 8th argument).
//   F. zero page errors.
//
// Supabase is stubbed at the network layer; nothing leaves the machine and nothing is saved anywhere.
// Builders and people are made up ("Acme Sheds", "Pat Example"). The repo is public.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>   (after npm run compile)
//   node tests/harness/roofProfilePick.mjs      (SS_BASE=http://127.0.0.1:<port>, SS_SHOTS=<dir>,
//                                                SS_CASES=P,Q,R,S,E to run some)
//
// To prove the checks can fail, serve the tree before this change (git archive ea0a0de0) as SS_BASE
// (run 2026-10-07): every Profile-field check fails (P1b on, Q1, Q2, R), S1/S2 and E1 fail (that
// designer draws the style's AG Panel and quotes "Metal — Charcoal" whatever the design says), and E2
// fails on the old label; P1a, S3, S4 and E3 hold, as they must on a designer that never had the field.
//
// Exit 0 = every assertion held.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, BASE, REF } from "./lib.mjs";

const CLIENT = "harness-roof-profile";
const CODE = "SS-HARNESSRF1";
const SIZE = "12x24";
const W = 12, L = 24, H = 8;
const COLORS = { body: "#9AA3AB", roof: "#6B7078", trim: "#E5E7EB" };
const d3 = (extra) => ({ roof: { type: "gable", pitch: 0.33, overhang: 0.6 }, colors: COLORS, siding: "agpanel", foundation: "skids", wallHeightFt: H, ...extra });
const style = (value, label, extra) => ({ value, label, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: d3(extra) });
// Barn says nothing about its metal (every style on the platform today): AG Panel. Post Frame starts
// its designs on Standing Seam.
const STYLES = [style("barn", "Harness Barn", { roofMaterial: "metal" }), style("pf", "Harness Post Frame", { roofMaterial: "metal", roofProfile: "standingseam" })];
const CLADS = ["panel", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
export const CONFIG = {
  clientId: CLIENT,
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  // [] unlocks Details and the submit with no typing (contactComplete short-circuits on an empty list).
  contactFields: [],
  buildingStyles: STYLES,
  defaultSizes: [SIZE],
  sizePricing: Object.fromEntries(STYLES.map((s) => [s.value, { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } }])),
  options: [],
  // Two metal colours and a shingle, so the Roof options card offers both types. Charcoal is $2.50 a sq ft.
  colors: [
    { id: "m1", label: "Charcoal", hex: "#5A6068", metal: true, shingle: false, siding: false, trim: false, rate: 2.5, pricingMethod: "sqft_building", isDefault: true },
    { id: "m2", label: "Galvalume", hex: "#B8BCC0", metal: true, shingle: false, siding: false, trim: false, rate: 0 },
    { id: "s1", label: "Weathered Wood", hex: "#6E6A64", metal: false, shingle: true, siding: false, trim: false, rate: 150, pricingMethod: "each", isDefault: true },
  ],
  claddingOptions: Object.fromEntries(STYLES.map((s) => [s.value, CLADS])), wallHeightOptions: {},
  showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };

// ── The portal shell (designerWidthCapPortal.mjs's): a session in localStorage, every call answered ──
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(p)}.c3R1Yg`;
const EXP = 4102444800;
const UID = "00000000-0000-4000-8000-000000000001";
const SESSION = {
  access_token: jwt({ sub: UID, role: "authenticated", email: "owner@example.test", exp: EXP }),
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
};

/** The portal, signed in as an owner whose tenant holds a view_3d grant. Returns the call log. */
async function openPortal(ctx) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(([ref, s]) => {
    window.__SS3D_DEBUG = true;
    try { window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* private mode */ }
  }, [REF, SESSION]);
  const calls = await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
  const shell = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: cors, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    calls.push({ method: req.method(), url, path: new URL(url).pathname, body });
    if (url.includes("/rest/v1/rpc/get_config")) return json(route, CONFIG);
    if (url.includes("/rest/v1/rpc/get_fixtures")) return json(route, FIXTURES);
    if (url.includes("/rest/v1/rpc/")) return json(route, null);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/storage/v1/")) return json(route, { Key: "floor-plans/harness.pdf", Id: "1" });
    if (url.includes("/auth/v1/user")) return json(route, SESSION.user);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) return json(route, { ok: true, entitlement: { granted: ["view_3d"], paid: [], features: {}, status: "active" } });
    if (url.includes("/portal-settings")) {
      if (body.action === "status") {
        return json(route, { ok: true, clientId: CLIENT, role: "owner", settings: { business_name: "Acme Sheds" }, config: { company_name: "Acme Sheds", accent_color: "#1D4ED8" }, access: null, prefs: null });
      }
      if (body.action === "catalog") return json(route, { ok: true, aiReady: false, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      return json(route, { ok: true });
    }
    if (url.includes("/functions/v1/submit-estimate")) return json(route, { ok: true, shortCode: CODE });
    if (url.includes("/functions/v1/")) return json(route, { ok: true });
    return json(route, {});
  };
  // ⚠️ REGISTERED AFTER stubSupabase, so these WIN (Playwright runs matching routes in reverse order).
  await page.route(`**/${REF}.supabase.co/**`, shell);
  await page.route(`**/${REF}.functions.supabase.co/**`, shell);
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.getByText("Designer", { exact: true }).first().click();
  await page.waitForSelector(".ssd-frame.is-embedded", { timeout: 60000 });
  await settle(page, 1200);
  return { page, errors, calls };
}

/** The portal's mount, minus the portal (priceOverride.mjs's): the vendored libraries and the compiled
 *  component as portal.html loads them, one <StructureStudio embedded view3d openDesign …/>. */
function embeddedPage(canOverridePrice = false) {
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
  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(window.StructureStudio, {
    clientId: ${JSON.stringify(CLIENT)}, embedded: true, view3d: true, canOverridePrice: ${canOverridePrice ? "true" : "false"},
    openDesign: { code: ${JSON.stringify(CODE)}, clientId: ${JSON.stringify(CLIENT)} },
  }));
</script></body></html>`;
}

// ── The designer's controls ─────────────────────────────────────────────────────────────────────
async function pickStyleAndSize(page, value) {
  await page.locator(`[data-ss-style="${value}"]`).first().click();
  await settle(page, 600);
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
  await sel.first().selectOption({ label: SIZE });
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 20000 });
  await settle(page, 600);
}
const roofCard = (page) => page.locator(".ssd-card").filter({ has: page.locator(".ssd-card-t", { hasText: "Roof options" }) }).first();
const typeSelect = (page) => roofCard(page).locator("select").first();
const profileSelect = (page) => page.locator("select[data-ss-roof-profile]");
async function roofType(page, t) {
  await typeSelect(page).selectOption(t);
  await settle(page, 700);
}
async function profile(page, id) {
  await profileSelect(page).first().selectOption(id);
  await settle(page, 900);
}
async function cardState(page) {
  return roofCard(page).evaluate((card) => ({
    n: card.style.getPropertyValue("--ssd-n"),
    labels: [...card.querySelectorAll(".ssd-fld-l")].map((l) => l.textContent.trim()),
    note: (card.querySelector(".ssd-dlv-note") || {}).textContent || null,
  }));
}

// The docked panel opens by itself on a wide screen; the button is the fallback. A remount leaves the
// old engine on window.__ss3dPanel, so only one whose canvas is still in the page counts.
async function dock(page) {
  const live = () => page.waitForFunction(() => {
    const P = window.__ss3dPanel;
    return !!(P && P.renderer && P.renderer.domElement.isConnected && P.model && P.model.roofGroup && P.model.roofGroup.children.length > 0);
  }, null, { timeout: 60000 });
  try { await live(); } catch (_e) {
    const show = page.getByRole("button", { name: /Show 3D|3D View/ });
    if (await show.count()) { await show.first().click(); await settle(page, 800); }
    await live();
  }
  await settle(page, 1000);
}
async function openViewer(page) {
  const edit = page.getByRole("button", { name: /Edit in 3D/ });
  await edit.first().waitFor({ state: "visible", timeout: 60000 });
  await page.evaluate(() => { window.__ss3dEngine = null; });
  await edit.first().click();
  await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length > 0); }, null, { timeout: 90000 });
  await settle(page, 1200);
}
async function closeViewer(page) {
  await page.getByRole("button", { name: "✕", exact: true }).first().click();
  await settle(page, 800);
}
// The roof SLAB's material, metalRoof.mjs's measure: the widest textured BoxGeometry in the roof group;
// its raster's repeat, bump, and the drawn ribs across one tile of its canvas (a run of 6+ dark px).
async function measure(page, engine) {
  return page.evaluate((engine) => {
    const E = window[engine];
    let slab = null, area = 0;
    E.model.roofGroup.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material) || !o.material.map) return;
      const p = o.geometry && o.geometry.parameters;
      if (!p || p.width == null || p.depth == null) return;
      if (p.width * p.depth > area) { area = p.width * p.depth; slab = o; }
    });
    if (!slab) return null;
    const m = slab.material;
    let ribs = null;
    const img = m.map.image;
    if (img && img.getContext) {
      const d = img.getContext("2d").getImageData(0, 0, img.width, 1).data;
      let run = 0; ribs = 0;
      for (let x = 0; x < img.width; x++) {
        const lum = (d[x * 4] + d[x * 4 + 1] + d[x * 4 + 2]) / 3;
        if (lum < 200) run++; else { if (run >= 6) ribs++; run = 0; }
      }
      if (run >= 6) ribs++;
    }
    return { repeat: [m.map.repeat.x, m.map.repeat.y], bump: m.bumpScale, ribs, metalness: m.metalness, roughness: m.roughness };
  }, engine);
}
const AG = { tileU: 3, tileV: 8, bump: 0.6, ribs: 4 };
const SS = { tileU: 6, tileV: 8, bump: 0.5, ribs: 0 };
const SHINGLE = { tileU: 6, tileV: 4, bump: 0.35, ribs: null };
const looks = (m, e) => !!m && near(m.repeat[0], 1 / e.tileU) && near(m.repeat[1], 1 / e.tileV) && near(m.bump, e.bump) && (e.ribs === null || m.ribs === e.ribs);
const said = (m) => (m ? `tile ${+(1 / m.repeat[0]).toFixed(3)} x ${+(1 / m.repeat[1]).toFixed(3)} ft, bump ${m.bump}, ribs ${m.ribs}` : "no roof slab");

async function openDetails(page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator(".ssd-dt").count()) return;
    const cta = page.locator(".ssd-dt-cta").first();
    if (await cta.count() && await cta.isVisible().catch(() => false)) { await cta.click(); await settle(page); continue; }
    const tog = page.locator(".ssd-dt-tog").first();
    if (await tog.count() && await tog.isVisible().catch(() => false)) { await tog.click(); await settle(page); continue; }
    await settle(page, 800);
  }
}
const detailsText = async (page) => { await openDetails(page); return (await page.locator(".ssd-dt").first().innerText()).replace(/\s+/g, " "); };
/** Press the footer's submit and wait for submit-estimate. Returns { body, save } (save_design's args). */
async function submit(page, calls) {
  const before = calls.length;
  const btn = page.locator("button.ssd-ft-cta.is-quote").first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const t0 = Date.now();
  let hit = null;
  while (!hit && Date.now() - t0 < 150000) {
    await settle(page, 400);
    hit = calls.slice(before).find((c) => c.path && c.path.endsWith("/functions/v1/submit-estimate") && c.body && c.body.selections);
  }
  const save = calls.slice(before).filter((c) => c.path && c.path.endsWith("/rest/v1/rpc/save_design")).pop();
  return { body: hit ? hit.body : null, save: save ? save.body : null };
}
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

let SAVED = null; // P's save_design selections, for R, S and E.
let P_RAN = false; // when P is not run (SS_CASES), they use FALLBACK_SAVED, the same shape.
const designRow = (selections) => ({
  short_code: CODE, client_id: CLIENT, status: "sent", version: 1, selections,
  items: [], paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
  contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100", street: "", city: "", state: "", zip: "" },
  bldg_w: W, bldg_h: L,
});
const FALLBACK_SAVED = { style: "barn", size: SIZE, roofType: "Metal", roofColor: "Charcoal", roofProfile: "standingseam", cladding: "" };

// ── P ──────────────────────────────────────────────────────────────────────────────────────────
async function runP(ctx, ok, shots) {
  P_RAN = true;
  const { page, errors, calls } = await openPortal(ctx);
  try {
    await pickStyleAndSize(page, "barn");
    await roofType(page, "Shingle");
    let c = await cardState(page);
    ok("P1a portal, Shingle: no Profile field; the card holds 2 fields", (await profileSelect(page).count()) === 0 && c.n === "2", JSON.stringify(c));
    await roofType(page, "Metal");
    c = await cardState(page);
    ok("P1b portal, Metal: Profile between Type and Color; the card holds 3 fields",
      c.n === "3" && JSON.stringify(c.labels) === JSON.stringify(["Roof Type", "Roof Profile", "Roof Color"]), JSON.stringify(c));
    const opts = await profileSelect(page).first().evaluate((s) => ({ value: s.value, options: [...s.options].map((o) => [o.value, o.textContent.trim()]) }));
    ok("P1c ...at the style's starting value, AG Panel, offering AG Panel and Standing Seam",
      opts.value === "agpanel" && JSON.stringify(opts.options) === JSON.stringify([["agpanel", "AG Panel"], ["standingseam", "Standing Seam"]]), JSON.stringify(opts));
    ok("P1d ...and no charge note on AG Panel", c.note === null, String(c.note));
    await dock(page);
    let m = await measure(page, "__ss3dPanel");
    ok("P1e the dock draws AG Panel: a 3 ft tile, 4 drawn ribs", looks(m, AG), said(m));
    const detailsAg = await detailsText(page);
    ok("P1f Details: the Roof row reads Metal — Charcoal", detailsAg.includes("Metal — Charcoal") && !detailsAg.includes("Standing Seam"), detailsAg.slice(0, 400));

    await profile(page, "standingseam");
    await dock(page);
    m = await measure(page, "__ss3dPanel");
    ok("P2a Standing Seam redraws the dock: a 6 ft tile, no drawn ribs", looks(m, SS), said(m));
    c = await cardState(page);
    // This portal session holds no "Override prices" (the stub's access map is empty), so the rep is
    // sent to someone who can adjust the price, never told to adjust one they cannot (review 2026-10-07).
    ok("P2b the note says no charge is added, and sends a rep without price-override access to an owner or admin",
      c.note === "No extra charge is added; ask an owner or admin to adjust the price if needed.", String(c.note));
    const detailsSs = await detailsText(page);
    ok("P2c Details: the Roof row reads Metal (Standing Seam) — Charcoal, at the same $720.00",
      detailsSs.includes("Metal (Standing Seam) — Charcoal") && (detailsAg.match(/\$720\.00/g) || []).length === (detailsSs.match(/\$720\.00/g) || []).length
        && detailsSs.includes("$720.00"), detailsSs.slice(0, 400));
    await roofCard(page).scrollIntoViewIfNeeded();
    if (shots) {
      await roofCard(page).screenshot({ path: join(shots, "P-roof-card-standing-seam.png") });
      await page.screenshot({ path: join(shots, "P-portal-designer-standing-seam.png") });
    }

    await openViewer(page);
    m = await measure(page, "__ss3dEngine");
    ok("P3 the full-screen viewer draws Standing Seam: 6 ft pans, no drawn ribs", looks(m, SS), said(m));
    if (shots) await closeUp(page, join(shots, "P-viewer-standing-seam-roof.png"));
    await closeViewer(page);

    await roofType(page, "Shingle");
    await dock(page);
    m = await measure(page, "__ss3dPanel");
    ok("P4a Shingle: the field goes and the dock draws shingle", (await profileSelect(page).count()) === 0 && looks(m, SHINGLE) && m.metalness === 0 && near(m.roughness, 0.95), said(m));
    await roofType(page, "Metal");
    const back = await profileSelect(page).first().inputValue().catch(() => null);
    await dock(page);
    m = await measure(page, "__ss3dPanel");
    ok("P4b Metal again: Standing Seam is still picked and drawn", back === "standingseam" && looks(m, SS), `${back}; ${said(m)}`);

    const { body, save } = await submit(page, calls);
    const s = body && body.selections;
    ok("P5a the submit tells submit-estimate the pick", !!s && s.roofType === "Metal" && s.roofColor === "Charcoal" && s.roofProfile === "standingseam", JSON.stringify(s));
    const ps = save && save.p_selections;
    ok("P5b ...and save_design stores it in the design's selections", !!ps && ps.roofProfile === "standingseam" && ps.roofType === "Metal", JSON.stringify(ps));
    if (ps) SAVED = ps;
    ok("P zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok("P ran", false, e && e.message ? e.message.split("\n")[0] : String(e));
    if (shots) await page.screenshot({ path: join(shots, "P-FAIL.png") }).catch(() => {});
  } finally {
    await page.close();
  }
}

// A close-up of the roof from the front corner in the full-screen viewer, for the eye.
async function closeUp(page, path) {
  await page.evaluate(({ W, L, H }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(W * 0.9, H + 7.5, L * 0.55);
    E.controls.target.set(0, H + 1.2, 0);
    E.camera.lookAt(0, H + 1.2, 0);
    E.camera.updateProjectionMatrix();
    E.render();
  }, { W, L, H });
  await settle(page, 300);
  await page.evaluate(() => window.__ss3dEngine.render());
  const box = await page.evaluate(() => {
    const c = window.__ss3dEngine.renderer.domElement.getBoundingClientRect();
    return { x: c.x, y: c.y, width: c.width, height: c.height };
  });
  await page.screenshot({ path, clip: box });
}

// ── Q ──────────────────────────────────────────────────────────────────────────────────────────
async function runQ(ctx, ok, shots) {
  {
    const { page, errors, calls } = await openPortal(ctx);
    try {
      await pickStyleAndSize(page, "barn");
      await roofType(page, "Metal");
      const { body } = await submit(page, calls);
      const s = body && body.selections;
      ok("Q1 a Metal design with no pick submits roofProfile \"\": the key is always there", has(s, "roofProfile") && s.roofProfile === "", JSON.stringify(s));
      ok("Q1 zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    } catch (e) {
      ok("Q1 ran", false, e && e.message ? e.message.split("\n")[0] : String(e));
    } finally {
      await page.close();
    }
  }
  {
    const { page, errors, calls } = await openPortal(ctx);
    try {
      await pickStyleAndSize(page, "pf");
      await roofType(page, "Metal");
      const v = await profileSelect(page).first().inputValue();
      await dock(page);
      let m = await measure(page, "__ss3dPanel");
      ok("Q2a a Standing Seam style starts the field at Standing Seam and draws 6 ft pans with no pick", v === "standingseam" && looks(m, SS), `${v}; ${said(m)}`);
      const d1 = await detailsText(page);
      ok("Q2b ...and Details names it from the style", d1.includes("Metal (Standing Seam) — Charcoal"), d1.slice(0, 300));
      await profile(page, "agpanel");
      await dock(page);
      m = await measure(page, "__ss3dPanel");
      ok("Q2c picking AG Panel over it draws the 3 ft sheet with its 4 ribs", looks(m, AG), said(m));
      const d2 = await detailsText(page);
      ok("Q2d ...and Details reads Metal — Charcoal", d2.includes("Metal — Charcoal") && !d2.includes("Standing Seam"), d2.slice(0, 300));
      if (shots) {
        await openViewer(page);
        await closeUp(page, join(shots, "Q-viewer-ag-panel-roof.png"));
        await closeViewer(page);
      }
      const { body } = await submit(page, calls);
      ok("Q2e ...and submits \"agpanel\"", !!body && body.selections.roofProfile === "agpanel", JSON.stringify(body && body.selections));
      ok("Q2 zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    } catch (e) {
      ok("Q2 ran", false, e && e.message ? e.message.split("\n")[0] : String(e));
      if (shots) await page.screenshot({ path: join(shots, "Q-FAIL.png") }).catch(() => {});
    } finally {
      await page.close();
    }
  }
}

// ── R ──────────────────────────────────────────────────────────────────────────────────────────
async function runR(ctx, ok, shots) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const sel = SAVED || FALLBACK_SAVED;
  try {
    await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
    await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [designRow(sel)] } });
    const url = `${BASE}/__harness_roof_profile.html`;
    await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html", body: embeddedPage(true) }));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".ssd-frame") != null, null, { timeout: 60000 });
    await page.locator("select[data-ss-roof-profile]").first().waitFor({ state: "visible", timeout: 30000 });
    const v = await profileSelect(page).first().inputValue();
    await dock(page);
    const m = await measure(page, "__ss3dPanel");
    ok("R the saved design reopens in the designer with Standing Seam picked and drawn", (!!SAVED || !P_RAN) && v === "standingseam" && looks(m, SS),
      `${SAVED ? "" : P_RAN ? "P saved nothing; " : "(P not run: the fallback row) "}${v}; ${said(m)}`);
    if (shots) await page.screenshot({ path: join(shots, "R-reopened-in-designer.png") });
    // This mount passes canOverridePrice (owners, admins, reps ticked for "Override prices"): the note
    // tells them to adjust the price themselves (P2b is the wording for everyone else).
    const note = (await cardState(page)).note;
    ok("R2 with price-override access, the note says to adjust the price if needed",
      note === "No extra charge is added; adjust the price if needed.", String(note));
    ok("R zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok("R ran", false, e && e.message ? e.message.split("\n")[0] : String(e));
    if (shots) await page.screenshot({ path: join(shots, "R-FAIL.png") }).catch(() => {});
  } finally {
    await page.close();
  }
}

// ── S ──────────────────────────────────────────────────────────────────────────────────────────
async function runS(ctx, ok, shots) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  try {
    await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
    await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [designRow(SAVED || FALLBACK_SAVED)] } });
    await openDesigner(page, CLIENT);
    await page.goto(`${BASE}/?client=${CLIENT}&id=${CODE}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
    await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 30000 });
    await settle(page, 1200);
    await dock(page);
    const m = await measure(page, "__ss3dPanel");
    ok("S1 the public page draws the design's Standing Seam", looks(m, SS), said(m));
    const d = await detailsText(page);
    ok("S2 ...and its Details read Metal (Standing Seam) — Charcoal", d.includes("Metal (Standing Seam) — Charcoal"), d.slice(0, 300));
    ok("S3 no Profile field on the public page", (await profileSelect(page).count()) === 0 && !(await page.locator("body").innerText()).includes("Roof Profile"));
    await roofType(page, "Shingle");
    await roofType(page, "Metal");
    ok("S4 ...nor after the customer picks Metal again", (await profileSelect(page).count()) === 0);
    if (shots) await page.screenshot({ path: join(shots, "S-public-page.png") });
    ok("S zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok("S ran", false, e && e.message ? e.message.split("\n")[0] : String(e));
    if (shots) await page.screenshot({ path: join(shots, "S-FAIL.png") }).catch(() => {});
  } finally {
    await page.close();
  }
}

// ── E ──────────────────────────────────────────────────────────────────────────────────────────
async function runE(ctx, ok, shots) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  try {
    await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
    const calls = await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [designRow(SAVED || FALLBACK_SAVED)] } });
    await openDesigner(page, CLIENT);
    await page.goto(`${BASE}/?client=${CLIENT}&id=${CODE}&admin=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
    await page.getByPlaceholder("Admin password").fill("harness");
    // The customer's side of the same page: the design, with its Standing Seam, drawn.
    await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 30000 });
    await dock(page);
    const m = await measure(page, "__ss3dPanel");
    ok("E1 the design's Standing Seam is drawn on this page", looks(m, SS), said(m));
    // The builder's side: open the style's calibration and save it untouched.
    const btn = page.getByRole("button", { name: "Harness Barn", exact: true });
    await btn.first().waitFor({ state: "visible", timeout: 30000 });
    await btn.first().click();
    await page.getByRole("button", { name: "Save to config" }).waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 500);
    const shown = await page.locator("label", { hasText: "Default metal roof profile" }).locator("select").first().inputValue().catch(() => null);
    ok("E2 the calibration shows the style's own default, AG Panel, under its new label", shown === "agpanel", String(shown));
    const saves = () => calls.filter((c) => c.path && c.path.endsWith("/functions/v1/admin-save-settings") && c.body && c.body.action === "save_style_d3");
    await page.getByRole("button", { name: "Save to config" }).click();
    const t0 = Date.now();
    while (saves().length === 0 && Date.now() - t0 < 15000) await settle(page, 100);
    const sent = saves().length ? saves()[saves().length - 1].body.d3 : null;
    ok("E3 saved untouched, the style sends its own profile (none), never the design's Standing Seam",
      !!sent && sent.roofProfile == null && !JSON.stringify(sent).includes("standingseam"), sent ? JSON.stringify(sent.roofProfile) : "no save sent");
    ok("E zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok("E ran", false, e && e.message ? e.message.split("\n")[0] : String(e));
    if (shots) await page.screenshot({ path: join(shots, "E-FAIL.png") }).catch(() => {});
  } finally {
    await page.close();
  }
}

async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("roofProfilePick");
  const { browser, ctx } = await launch({ width: 1500, height: 1000 });
  // The portal registers its service worker on this origin, and a page the worker controls fetches
  // past page.route: R's harness-served page then 404s. So R, S and E get a context of their own.
  const pages = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: "block" });
  const only = (process.env.SS_CASES || "P,Q,R,S,E").split(",");
  if (only.includes("P")) await runP(ctx, ok, shots);
  if (only.includes("Q")) await runQ(ctx, ok, shots);
  if (only.includes("R")) await runR(pages, ok, shots);
  if (only.includes("S")) await runS(pages, ok, shots);
  if (only.includes("E")) await runE(pages, ok, shots);
  await browser.close();
  console.log(`\nSHOTS ${shots}`);
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL CHECKS PASSED");
  process.exit(bad.length ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(2); });
