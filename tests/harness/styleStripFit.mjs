// How many buildings fit in one row, and does the scrollbar tell the truth?
//
// Ahsan, 2026-09-22: "bigger than 27 inches the scroll bar should disappear and all the buildings
// should show in a single row if it fits; if it does not fit then show the scroll bar, but keep the
// card size same, so in the bigger screens you can add more buildings side by side in a single row."
//
// Before this change the tiles DIVIDED the strip's width between them, so a wider screen gave bigger
// tiles and never more of them -- which is why Carolyn's "I can't see all the buildings" survived the
// width cap. ssStripTileW fixes the tile width against a 1618px reference instead, and ssdFitStrip
// lets the strip alone run past the 1728px frame, so extra width buys extra TILES.
//
// The fixture has ELEVEN styles on purpose: more than perRow (8), so a laptop still overflows and the
// bar is still right to show, and few enough that a wide screen fits them all and the bar must vanish.
//
//   python -m http.server 8151 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8151 node tests/harness/styleStripFit.mjs
import { chromium } from "@playwright/test";
import { reporter, shotsDir } from "./lib.mjs";

const REF = "jzeamjbhdrsbygdnphbm";
const BASE = process.env.SS_BASE || "http://127.0.0.1:8131";
const CLIENT = "pw-demo-barns";
const CAP = 1728;          // the frame Carolyn asked for on 2026-09-17
const REF_TILE = 194;      // (1618 - 7*10) / 8, the tile width at the 1728px frame with perRow 8
const REF_STRIP_W = 1618;  // SS_STRIP_REF_W: where dividing-the-space stops and the fixed card takes over

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(p)}.c3R1Yg`;
const EXP = 4102444800;
const SESSION = {
  access_token: jwt({ sub: "00000000-0000-4000-8000-000000000001", role: "authenticated", email: "s@e.com", exp: EXP }),
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r",
  user: { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "s@e.com", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
};

const STYLES = ["Barnstead", "Deluxe", "Farmland", "Tri Home", "Utility", "Lofted Barn", "Greenhouse", "Studio", "Playhouse", "Garden Shed", "Cabin"];
const key = (s) => s.toLowerCase().replace(/\s+/g, "-");
const W = 14, L = 40, SIZE = `${W}x${L}`;

const CONFIG = {
  clientId: CLIENT,
  branding: { companyName: "PW Demo Barns", accentColor: "#3D3672", headerBg: "#FFFFFF", tagline: null, logo: null, stylesPerRow: 8 },
  contactFields: ["name", "email", "phone"],
  buildingStyles: STYLES.map((label, i) => ({ value: key(label), label, img: null, sizes: [SIZE, "10x12", "12x24"], sizeInclusions: {}, sizeInclusionQty: {}, roofTypes: i % 2 ? ["Metal", "Shingle"] : ["Shingle"] })),
  defaultSizes: [SIZE, "10x12", "12x24"],
  sizePricing: Object.fromEntries(STYLES.map((label) => [key(label), { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 18000 }, "10x12": { widthFt: 10, lengthFt: 12, basePrice: 4000 }, "12x24": { widthFt: 12, lengthFt: 24, basePrice: 9000 } }])),
  roofTypes: ["Shingle", "Metal"], roofPricing: { Shingle: 0, Metal: 600 },
  colors: [
    { label: "Barn Red", hex: "#7B1E1E", shingle: true, metal: true, body: true, trim: true },
    { label: "Evergreen", hex: "#2F5D3A", shingle: true, metal: true, body: true, trim: true },
    { label: "Charcoal", hex: "#3A3A3A", shingle: true, metal: true, body: true, trim: true },
  ],
  claddingOptions: [{ value: "lp", label: "LP SmartSide", price: 0 }, { value: "board", label: "Board & Batten", price: 450 }],
  wallHeightOptions: {}, wallHeightFt: 7, showPricing: true, view3d: true,
  options: [{ key: "paint", label: "Paint", type: "select", choices: [{ label: "Unpainted", price: 0 }, { label: "Painted", price: 500 }] }],
  layoutItems: {
    door: { icon: "🚪", color: "#8B5E3C", group: "exterior", label: "Door", width: 3, height: 0.5, wallOnly: true, wallSnap: true, shortLabel: "DOOR" },
    window: { icon: "🪟", color: "#5B8CC8", group: "exterior", label: "Window", width: 3, height: 0.5, wallOnly: true, wallSnap: true, shortLabel: "WIN" },
    loft: { icon: "🪜", color: "#A16207", group: "interior", label: "Loft Area", width: 4, height: 4, shortLabel: "LOFT" },
    shelf: { icon: "📚", color: "#D97706", group: "interior", label: "Shelving", width: 4, height: 1, depthIn: 24, wallSnap: true, shortLabel: "SHELF" },
  },
  layoutPricing: { door: { rate: 250, method: "each", byStyle: {} }, window: { rate: 180, method: "each", byStyle: {} }, loft: { rate: 40, method: "sq_ft", byStyle: {} }, shelf: { rate: 12, method: "lineal_ft", byStyle: {} } },
  layoutPrices: {}, delivery: { label: "Delivery", method: "flat", rate: 0, freeMiles: 0 },
  electrical: null, electricalItems: [], insulation: [], fixtures: [],
};

// Ahsan's own machine, measured live: 1920px screen at Windows 125%, so 100% zoom is 1536x695 at
// dpr 1.25. Browser zoom multiplies the dpr — see the note in stepRailStability.mjs.
const VIEWPORTS = [
  { zoom: "100%", width: 1536, height: 695, dsf: 1.25 },
  { zoom: "67%", width: 2293, height: 1038, dsf: 0.8375 },
  { zoom: "50%", width: 3072, height: 1390, dsf: 0.625 },
  { zoom: "33%", width: 4655, height: 2107, dsf: 0.4125 },
  { zoom: "32in-4K", width: 3840, height: 2000, dsf: 1 },
];

const AUDIT = `(() => {
  const frame = document.querySelector(".ssd-frame");
  const strip = frame.querySelector("[data-ss-style-strip]");
  const wrap = strip.parentElement;
  const tiles = [...strip.children];
  const t0 = tiles[0].getBoundingClientRect();
  const sr = strip.getBoundingClientRect();
  // A tile counts as ON SCREEN only if the whole card is inside the scroller's own box.
  const whole = tiles.filter((t) => { const b = t.getBoundingClientRect(); return b.left >= sr.left - 1 && b.right <= sr.right + 1; }).length;
  const host = document.querySelector(".ss-designer-host");
  const sc = host || document.scrollingElement;
  return {
    frameW: Math.round(frame.getBoundingClientRect().width),
    tileW: Math.round(t0.width),
    tiles: tiles.length,
    wrapW: Math.round(wrap.getBoundingClientRect().width),
    stripCw: strip.clientWidth,
    grew: wrap.style.getPropertyValue("--ssd-strip-w") || "",
    overflows: strip.scrollWidth > strip.clientWidth + 1,
    wholeOnScreen: whole,
    // A laid-out horizontal scrollbar eats height from the scroller's content box.
    barPx: strip.offsetHeight - strip.clientHeight,
    sbWidth: getComputedStyle(strip).scrollbarWidth || "auto",
    arrows: frame.querySelectorAll(".ssd-strip-arrow").length,
    sideways: sc ? sc.scrollWidth - sc.clientWidth : 0,
    needed: Math.round(tiles.length * t0.width + (tiles.length - 1) * 10 + 24),
    stripRight: Math.round(sr.right), scRight: sc ? Math.round(sc.getBoundingClientRect().left + sc.clientWidth) : 0,
  };
})()`;

function handler(json) {
  return async (route) => {
    const req = route.request(); const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch (_e) {}
    if (url.includes("/rest/v1/rpc/get_config")) return json(route, CONFIG);
    if (url.includes("/rest/v1/rpc/get_fixtures")) return json(route, []);
    if (url.includes("/rest/v1/rpc/")) return json(route, false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, SESSION.user);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) return json(route, { ok: true, entitlement: { granted: ["view_3d"], features: { view_3d: true }, status: "active" } });
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: "owner", settings: { business_name: "PW Demo Barns" }, config: { company_name: "PW Demo Barns", accent_color: "#3D3672" }, access: null, prefs: null });
      if (body.action === "catalog") return json(route, { ok: true, aiReady: false, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
    }
    return json(route, { ok: true });
  };
}

async function run(surface, v, shots, ok) {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL === "bundled" ? undefined : "chrome", headless: !process.env.HEADED, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.dsf });
  await ctx.addInitScript(([ref, s, id]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) {}
    try { localStorage.setItem("ss_gate_" + id, "1"); localStorage.setItem("ss_gate_name_" + id, "Smoke Test"); } catch (_e) {}
  }, [REF, SESSION, CLIENT]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  const h = handler(json);
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (rt) => (rt.request().method() === "GET" && /^https:\/\/esm\.sh\//.test(rt.request().url())) ? rt.continue() : rt.abort());
  await page.route(`**/${REF}.supabase.co/**`, h);
  await page.route(`**/${REF}.functions.supabase.co/**`, h);
  await page.route(`**/${REF}.storage.supabase.co/**`, h);

  let a = null;
  try {
    if (surface === "portal") {
      await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
      await page.getByText("Designer", { exact: true }).first().click();
      await page.waitForFunction(() => document.querySelector(".ss-designer-host .ssd-frame") !== null, null, { timeout: 60000 });
    } else {
      await page.goto(`${BASE}/?client=${CLIENT}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 60000 });
    }
    const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
    if (await sel.count()) await sel.first().selectOption({ label: SIZE });
    await page.waitForTimeout(2600);
    a = await page.evaluate(AUDIT);
    await page.screenshot({ path: `${shots}/${surface}-${v.zoom.replace(/[^A-Za-z0-9-]/g, "")}.png` });
  } catch (e) { a = { error: String((e && e.message) || e) }; }
  await browser.close();

  const tag = `${surface} ${v.zoom} (${v.width}px)`;
  if (a.error) { ok(`${tag} drove the designer`, false, a.error); return; }
  // A tile NEVER grows past the reference card, and once the strip has that much room it IS the
  // reference card -- below it the old divide-the-space rule still wins, which is what keeps every
  // laptop exactly as it was.
  ok(`${tag} a card never grows past the reference size`, a.tileW <= REF_TILE, `tile ${a.tileW}px`);
  if (a.stripCw >= REF_STRIP_W) ok(`${tag} at full width a card IS the reference size`, a.tileW === REF_TILE, `tile ${a.tileW}px`);
  ok(`${tag} the strip never spills past the scroller`, a.stripRight <= a.scRight + 1, `strip right ${a.stripRight} vs ${a.scRight}`);
  ok(`${tag} the page does not scroll sideways`, a.sideways <= 1, `${a.sideways}px`);
  // The whole of Ahsan's sentence, as one relationship: the bar and the arrows appear EXACTLY when
  // something is really hidden, and never otherwise. `fits` is measured from the tiles, not assumed
  // from the viewport -- at 2293px eleven 194px cards genuinely do not fit, and a bar there is right.
  const fits = a.needed <= a.stripCw;
  if (fits) {
    ok(`${tag} all ${a.tiles} buildings show in one row`, a.wholeOnScreen === a.tiles, `${a.wholeOnScreen} of ${a.tiles}`);
    ok(`${tag} nothing hidden, so no scrollbar`, !a.overflows && a.barPx === 0, `overflows ${a.overflows}, bar ${a.barPx}px`);
    ok(`${tag} nothing hidden, so no arrows`, a.arrows === 0, `${a.arrows} arrows`);
  } else {
    // Headless Chrome overlays its scrollbars no matter what ::-webkit-scrollbar asks for, so the
    // laid-out height is 0 here and cannot be the assertion. The thing 2026-09-17 actually changed,
    // and the thing Ahsan asked to have back, is whether the bar is SUPPRESSED -- so check that.
    ok(`${tag} it does not fit, so the scrollbar is not suppressed`, a.overflows && a.sbWidth !== "none", `overflows ${a.overflows}, scrollbar-width ${a.sbWidth}`);
    ok(`${tag} it does not fit, so an arrow shows`, a.arrows >= 1, `${a.arrows} arrows`);
  }
  // The product requirement itself: a screen bigger than 27" has to fit a normal catalog.
  // The product bar, on the device Ahsan means rather than on a zoomed-out laptop. 3840 is a 32" 4K
  // at 100%; the portal loses 240px of it to the side menu and the strip starts at the CENTRED
  // frame's left edge, so it has the right-hand gutter to grow into and nothing more. That is the
  // deliberate trade: the strip stays under its own section heading instead of reclaiming the left
  // gutter too. It costs about 550px, and at 3840 there is still room to spare.
  if (v.width >= 3800 && v.dsf >= 1) {
    ok(`${tag} a 32in 4K screen fits the whole catalog`, fits, `needs ${a.needed}px, strip has ${a.stripCw}px`);
    ok(`${tag} the strip really did grow past the frame`, a.wrapW > a.frameW, `strip ${a.wrapW} vs frame ${a.frameW}`);
  }
  ok(`${tag} no page or console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
}

async function main() {
  const shots = shotsDir("styleStripFit");
  const { ok, failed } = reporter();
  console.log(`BASE ${BASE}`);
  for (const surface of ["portal", "public"]) for (const v of VIEWPORTS) await run(surface, v, shots, ok);
  console.log(`\nSHOTS ${shots}`);
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL GREEN");
  process.exit(bad.length ? 1 : 0);
}
main();
