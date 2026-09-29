// SWITCHING STYLE WHILE A GENERATION IS RUNNING — the draft must not land on the style the
// builder switched TO.
//
// One press now takes up to a couple of minutes (the paid call, an off-screen render, a free
// second call) behind a four-step progress card, which makes clicking away more likely, not
// less. The style tabs are the only way out of that wait, and `openCalEditor` replaces
// `adminCal` wholesale. `applyDraftedShape` is a functional `setAdminCal`, so a draft landing
// after a switch merged the FIRST building's roof, colours, wall height, foundation and roof
// material into the SECOND style's spec, under that style's key — and Save wrote it to
// `building_styles.d3`, which is what every customer of that style sees. One click and one
// press of a button whose own success line says "Preview it, adjust anything, then Save".
//
// What this drives, against the shipped compiled bundle with Supabase stubbed at the network
// layer (no account, no login, no writes, nothing leaves the machine):
//
//   1. the style tabs are reachable and ANSWER while a generation is running, rather than
//      silently opening another style or reading as a dead control
//   2. ⚠️ THE PANEL STAYS ON THE STYLE BEING GENERATED. The frames on screen, the tab that is
//      lit and the dimensions are still the first building's
//   3. ⚠️ THE DRAFT LANDS ON THE STYLE IT WAS GENERATED FOR, and Save writes it under that key
//   4. ⚠️ THE OTHER STYLE IS UNTOUCHED — opened afterwards, its roof, wall height, colours,
//      foundation and roof material are still its own, and a Save writes those
//   5. zero page errors
//
//   python -m http.server 8350 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/calStyleRace.mjs          (SS_BASE=http://127.0.0.1:<port> to move it)
//
// Exit 0 = every assertion held.
import { launch, reporter, collectErrors, REF, BASE, PASS_THROUGH_GET } from "./lib.mjs";

const CLIENT = "pw-demo-barns";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(p)}.c3R1Yg`;
const EXP = 4102444800;
const USER_ID = "00000000-0000-4000-8000-000000000001";
const SESSION = {
  access_token: jwt({ sub: USER_ID, role: "authenticated", email: "s@e.com", exp: EXP }),
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r",
  user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "s@e.com", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
};

// TWO STYLES THAT DIFFER IN EVERY FIELD THE FIRST MERGE TOUCHES, so a contaminated cabin is
// unmistakable rather than a coincidence.
const BARN_SPEC = {
  roof: { type: "gambrel", pitch: 0.5, overhang: 0.6, kneeU: 0.55, kneeRise: 0.55, ridgeRise: 0.8 },
  siding: "panel", colors: { body: "#8B7355", trim: "#D8CBB5", roof: "#3A3A3A" },
  wallHeightFt: 7, roofMaterial: "metal", foundation: "skids",
};
const CABIN_SPEC = {
  roof: { type: "gable", pitch: 0.25, overhang: 0.25 },
  siding: "lap", colors: { body: "#2E5E4E", trim: "#FFFFFF", roof: "#6B7280" },
  wallHeightFt: 8, roofMaterial: "shingle", foundation: "slab",
};
const FRAMES = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `${BASE}/__stub/img-b${i}.png`);
const styleRow = (key, label, d3, frames) => ({
  id: key, key, label, code: key.slice(0, 3).toUpperCase(), image_url: null, active: true,
  updated_at: "2026-09-14T10:00:00.000+00:00", show_image_on_estimate: true, d3,
  d3_photos: [], d3_video_frames: frames,
  model_url: null, model_status: "none", model_uploaded_at: null, model_locked_at: null, model_meta: null, taxable: true,
});
const STYLES = [styleRow("barn", "Barn", BARN_SPEC, FRAMES), styleRow("cabin", "Cabin", CABIN_SPEC, [])];
const CONFIG = {
  branding: { companyName: "PW Demo Barns", accentColor: "#8B4513", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  // ⚠️ `d3` HAS TO BE HERE, not only on the catalog rows: openCalEditor resolves the editor's
  // spec with d3ResolveStyleSpec(styleCfg, …) off the config's own entry, and the catalog read
  // afterwards only restores photos, frames and scan status. A config entry with no d3 would
  // hand both styles the renderer's defaults and this harness would be comparing two blanks.
  buildingStyles: [
    { value: "barn", label: "Barn", d3: BARN_SPEC, sizes: [{ label: "16x24", w: 16, h: 24, price: 5000 }] },
    { value: "cabin", label: "Cabin", d3: CABIN_SPEC, sizes: [{ label: "12x20", w: 12, h: 20, price: 4000 }] },
  ],
  defaultSizes: [], options: [],
  layoutItems: { door: { label: "Door", icon: "D", color: "#8B4513", width: 40, height: 12, shortLabel: "D" } },
  wallHeightFt: 7,
};
// The barn's building: a different roof, a different colour, a different foundation and a
// different roof material from the cabin's, plus the wall height the builder typed.
const DRAFT = {
  roof: { type: "gambrel", pitch: 0.5, overhang: 1.0, kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1.0, porchOutFt: 6.5, porchEnd: "front" },
  wallHeightFt: 9, siding: null, colors: { body: "#7A6A55" }, roofMaterial: "metal", foundation: "skids",
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const genCalls = [];
const saveCalls = [];
// The paid call, held open the way a 20-110 s call is. `release` is filled in when the request
// arrives, so the script can do its work while the browser is genuinely mid-flight.
let holdNext = false;
let heldAt = 0;
let release = null;

async function main() {
  const r = reporter();
  const { browser, ctx } = await launch({ width: 1400, height: 1000 });
  await ctx.addInitScript(([ref, s]) => {
    try { window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) {}
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const errors = collectErrors(page);

  const json = (route, body, status = 200) => route.fulfill({
    status, contentType: "application/json",
    headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body),
  });

  // Route order: Playwright runs matching routes in REVERSE registration order, so the
  // catch-all abort goes first and everything real overrides it.
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => {
    const req = route.request();
    if (req.method() === "GET" && PASS_THROUGH_GET.test(req.url())) return route.continue();
    return route.abort();
  });

  const apiHandler = async (route) => {
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
    if (url.includes("/portal-billing")) {
      return json(route, { ok: true, entitlement: { granted: ["view_3d"], features: { view_3d: true }, status: "active" } });
    }
    if (url.includes("/portal-settings")) {
      const a = body.action;
      if (a === "status") {
        return json(route, {
          ok: true, clientId: CLIENT, role: "owner",
          settings: { business_name: "PW Demo Barns" },
          config: { company_name: "PW Demo Barns", accent_color: "#8B4513" },
          access: null, prefs: null,
        });
      }
      if (a === "catalog") return json(route, { ok: true, aiReady: true, styles: STYLES, sizes: [], layoutItems: [], fixtures: [], colors: [] });
      if (a === "calibrate_style_ai") {
        genCalls.push(body);
        if (holdNext) {
          holdNext = false;
          heldAt = Date.now();
          await new Promise((res) => { release = res; });
        }
        // No frameMap and no checkId: the self-check is out of scope here and settles
        // "skipped" at once, which keeps this harness about the FIRST merge.
        return json(route, {
          ok: true, d3: { ...DRAFT, wallHeightFt: body.dims ? body.dims.wallHeightFt : 9 },
          frames: (body.photoUrls || []).length, dropped: 0,
          observed: { roofNote: "Gambrel, read from the ground.", confidence: "medium" },
          balanceCents: 18000, dims: body.dims || null,
        });
      }
      if (a === "save_style_d3") { saveCalls.push(body); return json(route, { ok: true }); }
      return json(route, { ok: true });
    }
    return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" });
  };
  await page.route(`**/${REF}.supabase.co/**`, apiHandler);
  await page.route(`**/${REF}.functions.supabase.co/**`, apiHandler);
  await page.route(`**/${REF}.storage.supabase.co/**`, apiHandler);
  await page.route("**/__stub/img-*.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));

  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.innerText.includes("Loading your business"), { timeout: 40000 });
  await page.getByText("Settings", { exact: true }).last().click();
  await page.waitForTimeout(1500);
  await page.getByText("Designer", { exact: true }).last().click();
  await page.waitForFunction(() => document.body.innerText.includes("3D Style Calibration"), { timeout: 40000 });

  const dimIn = page.locator("input.ssc-dim-in");
  const gen = page.getByRole("button", { name: /Generate the 3D model/ });
  const tab = (label) => page.getByRole("button", { name: label, exact: true }).first();
  const text = () => page.evaluate(() => document.body.innerText);
  const saveNow = async (label) => {
    const n = saveCalls.length;
    await page.getByRole("button", { name: /^Save 3D look$/ }).first().click();
    for (let i = 0; i < 100 && saveCalls.length === n; i++) await page.waitForTimeout(100);
    r.ok(`${label}: the save reached the wire`, saveCalls.length === n + 1, `${saveCalls.length - n} calls`);
    return saveCalls[n] || null;
  };

  // ── the barn, measured and ready ─────────────────────────────────────────────────────────
  await tab("Barn").click();
  await page.waitForFunction((want) => {
    const got = Array.from(document.querySelectorAll('img[alt^="View "]')).map((i) => i.getAttribute("src"));
    return got.length === want.length && got.every((u, i) => u === want[i]);
  }, FRAMES, { timeout: 20000 });
  for (const [i, v] of [[0, 16], [1, 24], [2, 9]]) {
    await dimIn.nth(i).click();
    await dimIn.nth(i).fill(String(v));
    await dimIn.nth(i).blur();
    await page.waitForTimeout(120);
  }
  r.ok("the barn is ready to generate", !(await gen.first().isDisabled()));

  // ── press, and switch style while it is in flight ────────────────────────────────────────
  holdNext = true;
  await gen.first().click();
  for (let i = 0; i < 120 && !heldAt; i++) await page.waitForTimeout(100);
  r.ok("the paid call is on the wire and being held open", heldAt > 0, `${genCalls.length} call(s)`);

  const cabinTab = tab("Cabin");
  // SCROLLED TO FIRST (2026-09-24). Clicking Generate scrolls it into view, and once the
  // dimensions card grew (its labels now say what each number IS in the new frame) that pushed
  // the tabs above the top of this 1000 px window -- where elementFromPoint answers null and the
  // tab read as "covered". A builder scrolls; the question here is whether anything is ON TOP of
  // the tab or disables it, and that is measured with it in view.
  await cabinTab.scrollIntoViewIfNeeded();
  const reachable = await cabinTab.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { disabled: el.disabled, covered: !(at === el || el.contains(at)), onScreen: b.width > 0 && b.height > 0 };
  });
  r.ok("the other style's tab is a real, reachable control mid-generation", !reachable.covered && reachable.onScreen, JSON.stringify(reachable));
  await cabinTab.click({ force: true });
  await page.waitForTimeout(250);

  const midText = await text();
  r.ok("⚠️ CLICKING IT MID-GENERATION IS ANSWERED, not silently obeyed",
    /generation is still running/.test(midText), midText.split("\n").find((l) => /still running/.test(l)) || "no line");
  r.ok("⚠️ AND THE PANEL IS STILL ON THE BUILDING BEING GENERATED",
    (await dimIn.nth(0).inputValue()) === "16" && (await dimIn.nth(1).inputValue()) === "24",
    `${await dimIn.nth(0).inputValue()} x ${await dimIn.nth(1).inputValue()}`);
  const framesShown = await page.evaluate(() => Array.from(document.querySelectorAll('img[alt^="View "]')).length);
  r.ok("the walk-around on screen is still the barn's", framesShown === FRAMES.length, String(framesShown));

  // ── let it land ──────────────────────────────────────────────────────────────────────────
  if (release) release();
  await page.waitForFunction(() => /Read \d+ view/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => /Generate the 3D model/.test(x.textContent || ""));
    return Boolean(b) && !b.disabled;
  }, null, { timeout: 30000 }).catch(() => {});

  r.ok("exactly one generation was paid for", genCalls.length === 1, String(genCalls.length));
  r.ok("and it was the barn's", genCalls[0] && genCalls[0].styleValue === "barn", genCalls[0] && genCalls[0].styleValue);

  const sv1 = await saveNow("the style that was generated");
  r.ok("⚠️ THE DRAFT SAVED UNDER THE STYLE IT WAS GENERATED FOR", Boolean(sv1) && sv1.styleValue === "barn", sv1 && sv1.styleValue);
  r.ok("carrying the drafted roof", Boolean(sv1) && sv1.d3 && sv1.d3.roof.type === "gambrel" && sv1.d3.roof.porchOutFt === 6.5,
    JSON.stringify(sv1 && sv1.d3 && sv1.d3.roof));
  r.ok("and the wall height the builder typed", Boolean(sv1) && sv1.d3.wallHeightFt === 9, String(sv1 && sv1.d3 && sv1.d3.wallHeightFt));

  // ── the style that was clicked must be exactly as it was ─────────────────────────────────
  await tab("Cabin").click();
  await page.waitForTimeout(600);
  const sv2 = await saveNow("the style that was clicked");
  r.ok("⚠️ THE OTHER STYLE IS UNTOUCHED — its own roof", Boolean(sv2) && sv2.styleValue === "cabin" && sv2.d3.roof.type === "gable",
    JSON.stringify(sv2 && sv2.d3 && sv2.d3.roof));
  r.ok("its own wall height", Boolean(sv2) && sv2.d3.wallHeightFt === 8, String(sv2 && sv2.d3 && sv2.d3.wallHeightFt));
  r.ok("its own colour", Boolean(sv2) && sv2.d3.colors && sv2.d3.colors.body === "#2E5E4E", JSON.stringify(sv2 && sv2.d3 && sv2.d3.colors));
  r.ok("its own roof material and foundation",
    Boolean(sv2) && sv2.d3.roofMaterial === "shingle" && sv2.d3.foundation === "slab",
    `${sv2 && sv2.d3 && sv2.d3.roofMaterial} / ${sv2 && sv2.d3 && sv2.d3.foundation}`);
  r.ok("and no porch arrived from the other building", Boolean(sv2) && sv2.d3.roof.porchOutFt === undefined,
    JSON.stringify(sv2 && sv2.d3 && sv2.d3.roof));

  r.ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  const failed = r.failed();
  console.log(`\n${r.results.length - failed.length}/${r.results.length} assertions passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
