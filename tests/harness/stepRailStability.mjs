// The stepper rail must be STILL when the customer is, and the page must not scroll itself.
//
// Ahsan, 2026-09-21, on the beta portal at 67% browser zoom: scrolled to the bottom of the Designer
// tab, "my screen fluctuates up and down" and the rail "toggles between three options constantly".
// Measured live on his own browser through the extension, the loop is:
//
//   scrollTop 659.1 (the exact bottom)  ->  SSStepWatcher: sMax - sTop = -0.1 < 2, so atEnd, so the
//   current step is `lastSeen` = "Get quote"  ->  the rail redraws (.ssd-step.is-current takes the
//   vertical label from 11.5px to 12.5px)  ->  Chrome's scroll anchoring had picked a node inside
//   that rail cell and compensates by scrolling the host up 19px  ->  scrollTop 640, sMax - sTop =
//   19, so NOT atEnd, so the step is `atLine` = "Options, openings & layout"  ->  the rail redraws
//   ->  anchoring scrolls back down  ->  round again every 500ms, forever.
//
// Nothing in the app scrolls: the scrollTop setter, scrollTo, scrollIntoView and focus were all
// instrumented on the live page and took 0 hits across 25 s of oscillation.
//
// This harness drives the SHIPPED compiled portal at the four viewport/zoom geometries that matter
// and asserts, at the bottom of each, that neither the scroll position nor the current step moves.
// It also nudges the scroller by the same 19px the anchoring did, and asserts the step SURVIVES it
// (the hysteresis), and that .ssd-rail is out of anchor selection.
//
//   python -m http.server 8131 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8131 node tests/harness/stepRailStability.mjs
//
// Point SS_BASE at an unpatched checkout and the "step is still at the bottom" checks FAIL — that
// is how this was shown to catch the bug rather than merely pass beside it.
import { chromium } from "@playwright/test";
import { reporter, shotsDir } from "./lib.mjs";

const REF = "jzeamjbhdrsbygdnphbm";
const BASE = process.env.SS_BASE || "http://127.0.0.1:8131";
const CLIENT = "pw-demo-barns";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(p)}.c3R1Yg`;
const EXP = 4102444800;
const SESSION = {
  access_token: jwt({ sub: "00000000-0000-4000-8000-000000000001", role: "authenticated", email: "s@e.com", exp: EXP }),
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r",
  user: { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "s@e.com", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
};

// Eleven styles and a big building, because the loop needs section 03 (the plan + the docked 3D
// panel) to be TALLER than 35% of the viewport at the bottom of the page — that is what makes
// `atLine` disagree with `lastSeen` and gives the watcher two answers to flip between. Ahsan's own
// tenant has eleven styles; a two-style fixture agrees with itself and proves nothing.
const STYLES = ["Barnstead", "Deluxe", "Farmland", "Tri Home", "Utility", "Lofted Barn", "Greenhouse", "Studio", "Playhouse", "Garden Shed", "Cabin"];
const key = (s) => s.toLowerCase().replace(/\s+/g, "-");
const W = 14, L = 40;
const SIZE = `${W}x${L}`;

const CONFIG = {
  clientId: CLIENT,
  branding: { companyName: "PW Demo Barns", accentColor: "#3D3672", headerBg: "#FFFFFF", tagline: null, logo: null, stylesPerRow: 8 },
  contactFields: ["name", "email", "phone"],
  buildingStyles: STYLES.map((label, i) => ({
    value: key(label), label, img: null, sizes: [SIZE, "10x12", "12x24"],
    sizeInclusions: {}, sizeInclusionQty: {}, roofTypes: i % 2 ? ["Metal", "Shingle"] : ["Shingle"],
  })),
  defaultSizes: [SIZE, "10x12", "12x24"],
  sizePricing: Object.fromEntries(STYLES.map((label) => [key(label), {
    [SIZE]: { widthFt: W, lengthFt: L, basePrice: 18000 },
    "10x12": { widthFt: 10, lengthFt: 12, basePrice: 4000 },
    "12x24": { widthFt: 12, lengthFt: 24, basePrice: 9000 },
  }])),
  roofTypes: ["Shingle", "Metal"],
  roofPricing: { Shingle: 0, Metal: 600 },
  colors: [
    { label: "Barn Red", hex: "#7B1E1E", shingle: true, metal: true, body: true, trim: true },
    { label: "Evergreen", hex: "#2F5D3A", shingle: true, metal: true, body: true, trim: true },
    { label: "Charcoal", hex: "#3A3A3A", shingle: true, metal: true, body: true, trim: true },
    { label: "Buckskin", hex: "#C8A96A", shingle: false, metal: true, body: true, trim: true },
  ],
  claddingOptions: [
    { value: "lp", label: "LP SmartSide", price: 0 },
    { value: "board", label: "Board & Batten", price: 450 },
    { value: "metal", label: "Metal", price: 300 },
  ],
  wallHeightOptions: {}, wallHeightFt: 7, showPricing: true, view3d: true,
  options: [
    { key: "paint", label: "Paint", type: "select", choices: [{ label: "Unpainted", price: 0 }, { label: "Painted", price: 500 }] },
    { key: "floor", label: "Floor upgrade", type: "select", choices: [{ label: "Standard", price: 0 }, { label: "Treated", price: 350 }] },
  ],
  layoutItems: {
    door: { icon: "🚪", color: "#8B5E3C", group: "exterior", label: "Door", width: 3, height: 0.5, wallOnly: true, wallSnap: true, shortLabel: "DOOR" },
    window: { icon: "🪟", color: "#5B8CC8", group: "exterior", label: "Window", width: 3, height: 0.5, wallOnly: true, wallSnap: true, shortLabel: "WIN" },
    ramp: { icon: "📐", color: "#9A7B4F", group: "exterior", label: "Ramp", width: 4, height: 3, shortLabel: "RAMP" },
    loft: { icon: "🪜", color: "#A16207", group: "interior", label: "Loft Area", width: 4, height: 4, shortLabel: "LOFT" },
    shelf: { icon: "📚", color: "#D97706", group: "interior", label: "Shelving", width: 4, height: 1, depthIn: 24, wallSnap: true, shortLabel: "SHELF" },
    workbench: { icon: "🔧", color: "#8B5E3C", group: "interior", label: "Workbench", width: 4, height: 2, depthIn: 36, wallSnap: true, shortLabel: "WB" },
  },
  layoutPricing: {
    door: { rate: 250, method: "each", byStyle: {} }, window: { rate: 180, method: "each", byStyle: {} },
    ramp: { rate: 200, method: "each", byStyle: {} }, loft: { rate: 40, method: "sq_ft", byStyle: {} },
    shelf: { rate: 12, method: "lineal_ft", byStyle: {} }, workbench: { rate: 25, method: "lineal_ft", byStyle: {} },
  },
  layoutPrices: {}, delivery: { label: "Delivery", method: "flat", rate: 0, freeMiles: 0 },
  electrical: null, electricalItems: [], insulation: [], fixtures: [],
};

// Ahsan's machine: a 1920px screen at Windows 125% scaling, so at 100% browser zoom innerWidth is
// 1536 and devicePixelRatio 1.25 (both measured live). Browser zoom z MULTIPLIES the device pixel
// ratio, so the faithful emulation is viewport (1536/z x 695/z) at deviceScaleFactor 1.25*z — not a
// wider viewport at dsf 1. The fractional device pixels that come with a fractional zoom are the
// whole reason the old `< 2` end test sat on a knife edge.
const VIEWPORTS = [
  { zoom: "100%", width: 1536, height: 695, dsf: 1.25 },
  { zoom: "80%", width: 1920, height: 869, dsf: 1 },
  { zoom: "67%", width: 2293, height: 1038, dsf: 0.8375 },
  { zoom: "50%", width: 3072, height: 1390, dsf: 0.625 },
];

// Headless Chrome overlays its scrollbars; Windows Chrome lays a classic one out and the portal host
// really does lose ~15px of width to it (measured live: offsetWidth 1296 against clientWidth 1281).
// Styling ::-webkit-scrollbar at all is what makes Chrome fall back to a laid-out bar.
const CLASSIC_SCROLLBARS = `
  .ss-designer-host::-webkit-scrollbar{width:15px;height:15px}
  .ss-designer-host::-webkit-scrollbar-thumb{background:#C1C1C1}
  .ss-designer-host::-webkit-scrollbar-track{background:#F1F1F1}
`;

function handler(json) {
  return async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    }
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) {}
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

// Parks at the bottom the way a customer does — from ABOVE, so the watcher has really just changed
// its answer and the rail has really just redrawn. Setting scrollTop straight to the maximum on a
// page that already says "Get quote" changes nothing and cannot arm the loop.
const ARM_AND_SAMPLE = `(async () => {
  const host = document.querySelector(".ss-designer-host");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const stepNow = () => { const c = host.querySelector(".ssd-step.is-current"); return c ? (c.getAttribute("aria-label") || "").slice(0, 34) : null; };
  host.scrollTop = Math.max(0, host.scrollHeight * 0.45);
  await wait(900);
  host.scrollTop = host.scrollHeight;
  await wait(900);
  const tops = [], steps = [];
  for (let i = 0; i < 24; i++) { tops.push(Math.round(host.scrollTop * 100) / 100); steps.push(stepNow()); await wait(250); }
  // The nudge: exactly what Chrome's anchoring did on the live page. The step must survive it.
  const atBottom = stepNow();
  host.scrollTop = host.scrollTop - 19;
  await wait(1400);
  const afterNudge = stepNow();
  const rail = host.querySelector(".ssd-rail");
  return {
    tops: [...new Set(tops)], steps: [...new Set(steps)],
    topChanges: tops.filter((v, i) => i && v !== tops[i - 1]).length,
    stepChanges: steps.filter((v, i) => i && v !== steps[i - 1]).length,
    atBottom, afterNudge,
    railAnchor: rail ? getComputedStyle(rail).overflowAnchor : null,
    sh: host.scrollHeight, ch: host.clientHeight, cw: host.clientWidth, ow: host.offsetWidth,
  };
})()`;

async function run(v, shots, ok) {
  const browser = await chromium.launch({
    channel: process.env.PW_CHANNEL === "bundled" ? undefined : "chrome",
    headless: process.env.HEADED ? false : true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.dsf });
  await ctx.addInitScript(([ref, s, css]) => {
    try { window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) {}
    const add = () => { const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st); };
    if (document.head) add(); else document.addEventListener("DOMContentLoaded", add);
  }, [REF, SESSION, CLASSIC_SCROLLBARS]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  const h = handler(json);
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => {
    if (route.request().method() === "GET" && /^https:\/\/esm\.sh\//.test(route.request().url())) return route.continue();
    return route.abort();
  });
  await page.route(`**/${REF}.supabase.co/**`, h);
  await page.route(`**/${REF}.functions.supabase.co/**`, h);
  await page.route(`**/${REF}.storage.supabase.co/**`, h);

  let r = null;
  try {
    await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
    await page.getByText("Designer", { exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector(".ss-designer-host .ssd-frame") !== null, null, { timeout: 60000 });
    const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
    if (await sel.count()) await sel.first().selectOption({ label: SIZE });
    await page.waitForTimeout(2600);
    r = await page.evaluate(ARM_AND_SAMPLE);
    await page.screenshot({ path: `${shots}/rail-${v.zoom.replace("%", "")}.png` });
  } catch (e) {
    r = { error: String((e && e.message) || e) };
  }
  await browser.close();

  const tag = `${v.zoom} (${v.width}x${v.height} @dsf ${v.dsf})`;
  if (r.error) { ok(`${tag} drove the designer`, false, r.error); return; }
  ok(`${tag} the page does not scroll itself at the bottom`, r.topChanges === 0, `scrollTop values ${JSON.stringify(r.tops)}`);
  ok(`${tag} the rail's current step is still at the bottom`, r.stepChanges === 0, `steps ${JSON.stringify(r.steps)}`);
  ok(`${tag} a 19px nudge off the bottom does not change the step`, r.atBottom === r.afterNudge, `${r.atBottom} -> ${r.afterNudge}`);
  ok(`${tag} the rail is out of scroll-anchor selection`, r.railAnchor === "none", `overflow-anchor: ${r.railAnchor}`);
  ok(`${tag} no page or console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
}

async function main() {
  const shots = shotsDir("stepRailStability");
  const { ok, failed } = reporter();
  console.log(`BASE ${BASE}`);
  for (const v of VIEWPORTS) await run(v, shots, ok);
  console.log(`\nSHOTS ${shots}`);
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL GREEN");
  process.exit(bad.length ? 1 : 0);
}
main();
