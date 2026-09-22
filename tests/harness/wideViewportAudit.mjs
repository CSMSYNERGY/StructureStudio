// Is the designer actually USABLE on a big screen? Objective checks, both surfaces, four widths.
//
// Ahsan, 2026-09-21: "at around 50% it starts to break and I cannot see properly", and "make the
// screen responsive for all this screens, so if the user opens this app on a 33 inch screen it's
// easier to read and easier to select everything". stepRailStability.mjs covers the page bouncing;
// this one covers the rest of that sentence, as things a machine can measure rather than opinions:
//
//   1. the designer frames itself instead of stretching to the monitor
//   2. nothing inside it overflows sideways
//   3. no single form field grows past a readable measure (the "label here, control over there"
//      problem is a WIDTH problem, and 960px is the invoice column the quote already uses)
//   4. every control a builder has to hit is still a real target
//   5. the stepper rail still shows words, not a bare numbered dot
//   6. section headings and their content start on the same left edge
//
//   python -m http.server 8131 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8131 node tests/harness/wideViewportAudit.mjs
import { chromium } from "@playwright/test";
import { reporter, shotsDir } from "./lib.mjs";

const REF = "jzeamjbhdrsbygdnphbm";
const BASE = process.env.SS_BASE || "http://127.0.0.1:8131";
const CLIENT = "pw-demo-barns";
const CAP = 1728;          // the frame Carolyn asked for on 2026-09-17
const FIELD_MAX = 1000;    // a shade over --ssd-invoice-max (960px), the widest a single control should read

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
];

const AUDIT = `(() => {
  const frame = document.querySelector(".ssd-frame");
  const r = (el) => el.getBoundingClientRect();
  const fr = r(frame);
  const seen = (el) => { const b = r(el); const cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };

  // 2. anything sticking out sideways of the frame. The style strip is the ONE sanctioned exception
  // (ssdFitStrip, 2026-09-22: a row of pictures wants the monitor, everything else wants the framed
  // reading measure) -- so it is excluded HERE and checked on its own terms below, rather than this
  // check being softened until it catches nothing.
  const stripWrap = (() => { const st = frame.querySelector("[data-ss-style-strip]"); return st ? st.parentElement : null; })();
  const inStrip = (el) => Boolean(stripWrap && (el === stripWrap || stripWrap.contains(el)));
  const overflow = [];
  for (const el of frame.querySelectorAll("*")) {
    if (!seen(el) || inStrip(el)) continue;
    const b = r(el);
    if (b.right > fr.right + 1 || b.left < fr.left - 1) {
      // a horizontally scrolling strip is allowed to have children outside it — it clips them
      let clipped = false;
      for (let p = el.parentElement; p && p !== frame; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") { clipped = true; break; }
      }
      if (!clipped) overflow.push((el.className || el.tagName || "").toString().slice(0, 46) + " w=" + Math.round(b.width));
    }
  }

  // 3. how wide a single form control gets
  const fields = [...frame.querySelectorAll("input, select, textarea")].filter(seen);
  const widest = fields.reduce((a, el) => { const w = r(el).width; return w > a.w ? { w, name: (el.className || el.name || el.tagName).toString().slice(0, 40) } : a; }, { w: 0, name: "" });

  // 4. hit targets
  const controls = [...frame.querySelectorAll("button, input, select, [role='tab'], a[href]")].filter(seen);
  const tiny = controls.filter((el) => { const b = r(el); return b.height < 16 || b.width < 16; })
    .map((el) => { const b = r(el); return (el.className || el.tagName).toString().slice(0, 34) + " " + Math.round(b.width) + "x" + Math.round(b.height); });

  // 5. the rail still says words
  const rails = [...frame.querySelectorAll(".ssd-step")].filter(seen);
  const wordless = rails.filter((b) => b.getAttribute("data-ssd-fit") === "none").length;

  // 6. section headings and their content share a left edge
  const heads = [...frame.querySelectorAll(".ssd-sechead")].filter(seen).map((h) => Math.round(r(h).left));
  const headSpread = heads.length ? Math.max(...heads) - Math.min(...heads) : 0;

  const host = document.querySelector(".ss-designer-host");
  const sc = host || document.scrollingElement;
  return {
    frameW: Math.round(fr.width),
    sideways: sc ? sc.scrollWidth - sc.clientWidth : 0,
    overflow: overflow.slice(0, 6), overflowCount: overflow.length,
    widestField: Math.round(widest.w), widestFieldName: widest.name,
    controls: controls.length, tiny: tiny.slice(0, 6), tinyCount: tiny.length,
    scRight: sc ? Math.round(sc.getBoundingClientRect().left + sc.clientWidth) : 0,
    rails: rails.length, wordless, headSpread, heads: heads.slice(0, 8),
    // The strip's own terms: it may leave the frame, it may NOT leave the scroller, and it must
    // still start on the same left edge as the section heading that labels it.
    stripRight: stripWrap ? Math.round(r(stripWrap).right) : 0,
    stripLeft: stripWrap ? Math.round(r(stripWrap).left) : 0,
    headLeft: heads.length ? Math.min(...heads) : 0,
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
    await page.screenshot({ path: `${shots}/${surface}-${v.zoom.replace("%", "")}.png` });
  } catch (e) { a = { error: String((e && e.message) || e) }; }
  await browser.close();

  const tag = `${surface} ${v.zoom} (${v.width}px)`;
  if (a.error) { ok(`${tag} drove the designer`, false, a.error); return; }
  ok(`${tag} the designer frames itself, not the monitor`, a.frameW <= CAP + 2, `frame ${a.frameW}px`);
  ok(`${tag} nothing overflows the frame sideways`, a.overflowCount === 0, a.overflow.join(" ; "));
  ok(`${tag} the page does not scroll sideways`, a.sideways <= 1, `${a.sideways}px`);
  ok(`${tag} no field grows past a readable measure`, a.widestField <= FIELD_MAX, `widest ${a.widestField}px (${a.widestFieldName})`);
  ok(`${tag} every control is still a real hit target`, a.tinyCount === 0, `${a.tinyCount}: ${a.tiny.join(" ; ")}`);
  ok(`${tag} every rail step still shows words`, a.wordless === 0, `${a.wordless} of ${a.rails} bare`);
  ok(`${tag} section headings share one left edge`, a.headSpread <= 1, `spread ${a.headSpread}px`);
  ok(`${tag} the strip may leave the frame but not the scroller`, a.stripRight <= a.scRight + 1, `strip right ${a.stripRight} vs scroller ${a.scRight}`);
  ok(`${tag} the strip still starts under its own heading`, Math.abs(a.stripLeft + 12 - a.headLeft) <= 1, `strip ${a.stripLeft} + 12 vs heading ${a.headLeft}`);
  ok(`${tag} no page or console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
}

async function main() {
  const shots = shotsDir("wideViewportAudit");
  const { ok, failed } = reporter();
  console.log(`BASE ${BASE}`);
  for (const surface of ["portal", "public"]) for (const v of VIEWPORTS) await run(surface, v, shots, ok);
  console.log(`\nSHOTS ${shots}`);
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL GREEN");
  process.exit(bad.length ? 1 : 0);
}
main();
