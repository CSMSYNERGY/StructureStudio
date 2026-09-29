// THE GROUND AT EACH CORNER ON THE ADVANCED PAGE (top-level gradeCornersFt, 2026-09-29), driven on the
// COMPILED portal, with the 3D measured off the docked panel's scene graph (window.__ss3dPanel).
//
// Carolyn, 09-29 (Fathom 187837290), drawing on the Advanced page: "we need to be able to put in where
// the zero is ... this is a zero, this is two ... put in four points ... which one is that zero, and then
// if it drops down like 18 inches, two feet, they put in four corners." This proves:
//   1  Walls & foundation → Foundation: on blocks or piers (only), "Ground at each corner" replaces the
//      fall's "Ground falls away" and "Toward": a top view of the footprint drawn to its width and length
//      (FRONT on its front edge, with the door mark, BACK at the top), a number box at each corner and a
//      readout under each ("level" on level ground); "Level ground" is off until there is a slope; the
//      one-line hint "0 is the highest corner. Floor height is measured there."
//   2  typed corners read out live ("highest", 1' 6" lower, 2' 0" lower); the plan shades the low ground
//      and its arrow points down the slope; the Floor height box says it is at the highest corner
//   3  ⚠️ the 3D beside it: model.gradeCorners is the typed corners; every pier's foot is at the ground
//      d3GradeAt puts under its lowest edge, and ON the drawn grass; the piers at the deepest corner are
//      the tallest, at the zero corners the shortest, by about the corner's drop
//   4  "Level ground" empties the boxes and the 3D is level again (model.gradeCorners null)
//   5  Save as a new style sends the four corners and the fall's keys as null (BC-1); saved level, it
//      sends gradeCornersFt null
//   6  a style storing a FALL, started from, opens with the fall's corners in the boxes; an edited corner
//      saves corners in place of the fall
//   7  at a phone's width the control fits: no sideways page scroll, the four boxes and the plan on screen
//   8  zero page errors
//
//   python -m http.server 8301 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8301 SS_SHOTS=<dir> node tests/harness/gradeCorners.mjs
//
// Exit 0 = every check held.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, collectErrors, shotsDir, BASE, REF, PASS_THROUGH_GET } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const SHOTS = shotsDir("gradeCorners");
const OURS = "harness-internal";

// The designer's own ground functions, lifted by the anchors gradeFall_test lifts them by.
const PURE = (() => {
  const src = readFileSync(join(ROOT, "structure-studio.component.js"), "utf8");
  const lift = (a, b) => {
    const i = src.indexOf(a), j = i < 0 ? -1 : src.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error(`gradeCorners.mjs: the anchors ${a} .. ${b} moved; re-point them`);
    return src.slice(i, j);
  };
  const body = [
    ["const D3 = {", "// The casing reveal every opening"],
    ["function d3RoofAxes(", "function d3FtIn("],
    ["function ssPorchTrussWall(", "// Where a vent sits in the gable above"],
    ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
    ["function d3PorchGeom(", "function d3PorchReadout("],
  ].map(([a, b]) => lift(a, b)).join("\n");
  return new Function(`${body}; return { d3GradeAt, d3GradeCorners };`)();
})();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000046", aud: "authenticated", role: "authenticated", email: "sec@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const COLORS = { body: "#9B2F2F", trim: "#F4F1EA", roof: "#3E434A" };
const CONFIG = {
  branding: { companyName: "Harness Internal", accentColor: "#3D3672", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  buildingStyles: [
    { value: "hcabin", label: "Harness Cabin", sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }],
      d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, siding: "batten", colors: COLORS, wallHeightFt: 8 } },
    // A style that stores the ground as a FALL (2026-09-28): 2 ft to the back.
    { value: "hfall", label: "Harness Hillside", sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }],
      d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6 }, siding: "batten", colors: COLORS, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 2, gradeFallToward: "back" } },
  ],
  defaultSizes: [],
  options: [],
  layoutItems: { door: { label: "Door", icon: "D", color: "#8B4513", width: 40, height: 12, shortLabel: "D" } },
  wallHeightFt: 8,
};
const ENT = { reason: "internal", status: "active", granted: ["view_3d"], features: { view_3d: true }, exempt: true, state: "exempt" };

const { ok, failed } = reporter();
const { browser, ctx: unused } = await launch({ width: 1440, height: 1000 });
await unused.close();
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const settle = (page, ms = 300) => page.waitForTimeout(ms);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f3 = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(3) : String(v));

async function open(path, viewport = { width: 1440, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    window.__SS3D_DEBUG = true;
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const calls = [];
  let made = 0;
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => {
    const req = route.request();
    if (req.method() === "GET" && PASS_THROUGH_GET.test(req.url())) return route.continue();
    return route.abort();
  });
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      if (rpc[1] === "get_config") return json(route, CONFIG);
      if (rpc[1] === "get_fixtures") return json(route, []);
      return json(route, rpc[1] === "log_error" ? null : false);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: OURS, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) return json(route, { ok: true, configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, entitlement: ENT });
    if (url.includes("/portal-settings")) {
      calls.push({ action: body.action, body });
      if (body.action === "status") return json(route, { ok: true, clientId: OURS, role: "owner", settings: { business_name: OURS }, config: { company_name: OURS, accent_color: "#3D3672" }, access: null, prefs: null });
      if (body.action === "catalog") return json(route, { ok: true, aiReady: true, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      if (body.action === "create_style") {
        made++;
        const key = String(body.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "style";
        return json(route, { ok: true, styleId: `00000000-0000-4000-8000-00000000c${String(made).padStart(3, "0")}`, key });
      }
      if (body.action === "save_style_d3") return json(route, { ok: true, updatedAt: "2026-09-29T10:00:00.000+00:00" });
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(`**/${REF}.storage.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForSelector('[data-ss-adv="sections"]', { timeout: 60000 });
  await settle(page, 600);
  return { ctx, page, errors, calls };
}

const radio = (page, group, name) => page.getByRole("radiogroup", { name: group, exact: true }).getByRole("radio", { name, exact: true });
const field = (page) => page.locator('[data-ss-adv-f="gradeCornersFt"]');
const NAMES = { fl: "front left", fr: "front right", bl: "back left", br: "back right" };
const box = (page, k) => page.getByLabel(`Ground at the ${NAMES[k]} corner (ft lower)`, { exact: true });
const nb = (s) => String(s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
const says = async (page) => {
  const o = {};
  for (const k of ["fl", "fr", "bl", "br"]) o[k] = nb(await page.locator(`[data-ss-adv-corner-say="${k}"]`).innerText());
  return o;
};
const values = async (page) => { const o = {}; for (const k of ["fl", "fr", "bl", "br"]) o[k] = await box(page, k).inputValue(); return o; };
const type = async (page, k, v) => { await box(page, k).fill(String(v)); await page.keyboard.press("Tab"); await settle(page, 250); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function panelModel(page, test, timeout = 60000) {
  await page.waitForFunction((src) => {
    const P = window.__ss3dPanel;
    if (!(P && P.model && P.renderer && P.renderer.domElement.isConnected && P.renderer.domElement.closest('[data-ss-adv="view"]'))) return false;
    return new Function("M", `return (${src})(M);`)(P.model);
  }, test.toString(), { timeout });
}
// The docked 3D: every pier (its foot, its top, its centre) and the drawn grass under each foot's corners.
async function piers(page) {
  return page.evaluate(() => {
    const P = window.__ss3dPanel, M = P.model, V = P.camera.position.constructor;
    P.scene.updateMatrixWorld(true);
    let ground = null;
    M.root.traverse((q) => { if (!ground && q.isMesh && q.userData && q.userData.ssGround) ground = q; });
    const pos = ground.geometry.attributes.position, idx = ground.geometry.index;
    const wv = [];
    for (let i = 0; i < pos.count; i++) wv.push(new V().fromBufferAttribute(pos, i).applyMatrix4(ground.matrixWorld));
    const grassAt = (x, z) => {
      if (!idx) return NaN;
      for (let t = 0; t < idx.count; t += 3) {
        const a = wv[idx.getX(t)], b = wv[idx.getX(t + 1)], c = wv[idx.getX(t + 2)];
        const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        if (Math.abs(d) < 1e-12) continue;
        const l1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
        const l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return l1 * a.y + l2 * b.y + l3 * c.y;
      }
      return NaN;
    };
    const out = [];
    M.root.traverse((q) => {
      if (!(q.isMesh && q.userData && q.userData.ssFoundationPart === "pier" && !(q.userData.ssPorchPart))) return;
      q.geometry.computeBoundingBox();
      const b = q.geometry.boundingBox;
      const lo = new V(0, b.min.y, 0).applyMatrix4(q.matrixWorld), hi = new V(0, b.max.y, 0).applyMatrix4(q.matrixWorld);
      const cx = lo.x, cz = lo.z;
      const g = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(([dx, dz]) => grassAt(cx + dx, cz + dz));
      out.push({ cx, cz, bottom: lo.y, top: hi.y, grassLow: Math.min(...g) });
    });
    return { piers: out, gc: M.gradeCorners, grade: M.grade };
  });
}
const aimPanel = (page, eye, at) => page.evaluate(({ eye, at }) => {
  const P = window.__ss3dPanel;
  P.camera.position.set(...eye); P.controls.target.set(...at); P.controls.update(); P.render();
}, { eye, at });

try {
  const { ctx, page, errors, calls } = await open("/portal/advanced");
  const W = 12, L = 16;

  // 1 ── the control, on raised floors only ──
  await page.locator("#ss-step-adv-walls").scrollIntoViewIfNeeded();
  ok("1: on a slab there is no corner control", (await field(page).count()) === 0);
  await radio(page, "What it stands on", "Piers").click();
  await settle(page, 300);
  const f = await page.evaluate(() => {
    const el = document.querySelector('[data-ss-adv-f="gradeCornersFt"]');
    const svg = el && el.querySelector("svg[data-ss-adv-corner-plan]");
    const rects = svg ? [...svg.querySelectorAll("rect")] : [];
    const outline = rects.find((r) => (r.style.stroke || "").includes("--ss-ink"));
    return {
      head: el ? el.querySelector(".ss-adv-fh .ssd-fld-l").textContent : "",
      boxes: el ? el.querySelectorAll("[data-ss-adv-corner] input").length : 0,
      words: svg ? [...svg.querySelectorAll("text")].map((t) => t.textContent) : [],
      ratio: outline ? Number(outline.getAttribute("width")) / Number(outline.getAttribute("height")) : null,
      note: el ? el.querySelector(".ss-adv-note").firstChild.textContent : "",
      level: el ? el.querySelector('[data-ss-adv-f="groundLevel"]').disabled : null,
      fall: !!document.querySelector('[data-ss-adv-f="gradeFallFt"],[data-ss-adv-f="gradeFallToward"]'),
    };
  });
  ok("1: piers show 'Ground at each corner' with a box at each of the four corners", f.head === "Ground at each corner" && f.boxes === 4, JSON.stringify(f));
  ok("1: ...around a top view drawn to the footprint (12 x 16), FRONT on its front edge and BACK at the top", near(f.ratio, W / L, 1e-6) && f.words.includes("FRONT") && f.words.includes("BACK"), JSON.stringify(f));
  ok("1: ...the one-line hint, and 'Level ground' off while the ground is level", f.note === "0 is the highest corner." && f.level === true, JSON.stringify(f));
  ok("1: ...every corner reads 'level' and no box has a number; the fall's two controls are gone",
    same(await says(page), { fl: "level", fr: "level", bl: "level", br: "level" }) && same(await values(page), { fl: "", fr: "", bl: "", br: "" }) && !f.fall);

  // 2 ── typed corners read out live ──
  await type(page, "bl", 1.5);
  await type(page, "br", 2);
  ok("2: back-left 1.5 and back-right 2 read 1' 6\" lower and 2' 0\" lower, the front two 'highest'",
    same(await says(page), { fl: "highest", fr: "highest", bl: "1' 6\" lower", br: "2' 0\" lower" }), JSON.stringify(await says(page)));
  const plan = await page.evaluate(() => {
    const svg = document.querySelector("svg[data-ss-adv-corner-plan]");
    const line = svg.querySelector("[data-ss-adv-corner-arrow] line");
    const cells = [...svg.querySelectorAll("rect[fill-opacity]")].map((r) => ({ x: Number(r.getAttribute("x")), y: Number(r.getAttribute("y")), o: Number(r.getAttribute("fill-opacity")) }));
    const at = (fx, fy) => cells.reduce((a, c) => (Math.hypot(c.x - fx, c.y - fy) < Math.hypot(a.x - fx, a.y - fy) ? c : a));
    const xs = cells.map((c) => c.x), ys = cells.map((c) => c.y);
    return line ? { x1: +line.getAttribute("x1"), y1: +line.getAttribute("y1"), x2: +line.getAttribute("x2"), y2: +line.getAttribute("y2"),
      shadeBackRight: at(Math.max(...xs), Math.min(...ys)).o, shadeFrontLeft: at(Math.min(...xs), Math.max(...ys)).o } : null;
  });
  ok("2: the plan's arrow points down the slope (to the back, a little to the right) and the low corner is shaded darker",
    plan && plan.y2 < plan.y1 && plan.x2 > plan.x1 && plan.shadeBackRight > plan.shadeFrontLeft + 0.2, JSON.stringify(plan));
  const fhLabel = await page.locator('[data-ss-adv-f="floorHeightFt"] .ssd-fld-l').innerText();
  ok("2: the Floor height box says it is at the highest corner", fhLabel === "Floor height at the highest corner (ft)", fhLabel);
  const lvlOn = await page.locator('[data-ss-adv-f="groundLevel"]').isEnabled();
  ok("2: ...and 'Level ground' is on", lvlOn);

  // 3 ── the 3D beside it ──
  await panelModel(page, (M) => !!(M.gradeCorners && M.gradeCorners.bl === 1.5 && M.gradeCorners.br === 2 && M.gradeCorners.fl === 0 && M.gradeCorners.fr === 0));
  const spec = { foundation: "piers", gradeCornersFt: { fl: 0, fr: 0, bl: 1.5, br: 2 } };
  const m = await piers(page);
  const depth = (x, z) => PURE.d3GradeAt(spec, W, L, x, z);
  const want = (t) => -Math.max(depth(t.cx - 0.5, t.cz - 0.5), depth(t.cx + 0.5, t.cz - 0.5), depth(t.cx - 0.5, t.cz + 0.5), depth(t.cx + 0.5, t.cz + 0.5));
  const bad = m.piers.filter((t) => !(near(t.bottom, want(t), 0.003) && near(t.bottom, t.grassLow, 0.015)));
  ok(`3: ⚠️ EVERY PIER'S FOOT IS ON THE GROUND UNDER ITS LOWEST EDGE, ON THE DRAWN GRASS (${m.piers.length} piers)`,
    m.piers.length >= 6 && bad.length === 0, bad.slice(0, 3).map((t) => `(${f3(t.cx)},${f3(t.cz)}) ${f3(t.bottom)} want ${f3(want(t))} grass ${f3(t.grassLow)}`).join(" | "));
  const h = (t) => t.top - t.bottom;
  const nearest = (x, z) => m.piers.reduce((a, t) => (Math.hypot(t.cx - x, t.cz - z) < Math.hypot(a.cx - x, a.cz - z) ? t : a));
  const deep = nearest(W / 2, -L / 2), zeroL = nearest(-W / 2, L / 2), zeroR = nearest(W / 2, L / 2);
  const tall = Math.max(...m.piers.map(h)), short = Math.min(...m.piers.map(h));
  ok(`3: ⚠️ THE PIERS AT THE DEEPEST CORNER (back right) ARE THE TALLEST (${f3(h(deep))} ft), AT THE ZERO CORNERS THE SHORTEST (${f3(h(zeroL))}, ${f3(h(zeroR))} ft)`,
    near(h(deep), tall, 0.005) && near(Math.min(h(zeroL), h(zeroR)), short, 0.005) && h(deep) - short > 1.2, `tallest ${f3(tall)} shortest ${f3(short)}`);
  ok("3: model.grade is the floor height at the highest corner (piers' 1.5 ft)", near(m.grade, 1.5, 1e-9), String(m.grade));
  // The shot Carolyn asked for: the Advanced page with the corners typed and the 3D looking at the low corner.
  await page.locator("#ss-step-adv-walls").scrollIntoViewIfNeeded();
  await page.evaluate(() => { const el = document.querySelector('[data-ss-adv-f="gradeCornersFt"]'); window.scrollBy(0, el.getBoundingClientRect().top - 330); });
  await settle(page, 500);
  await aimPanel(page, [24, 9, -29], [0, 1, -1]);
  await settle(page, 300);
  await page.screenshot({ path: join(SHOTS, "advanced-corners-1440.png") });
  await aimPanel(page, [42, 2.2, 1], [0, 1.2, 0]);
  await settle(page, 300);
  await page.screenshot({ path: join(SHOTS, "advanced-corners-side-1440.png") });
  await field(page).screenshot({ path: join(SHOTS, "advanced-corners-control.png") });

  // 5 ── Save as a new style: the four corners, and the fall's keys as null ──
  await page.getByLabel("New style name").fill("Harness Hill Cabin");
  await page.getByRole("button", { name: "Save as a new style" }).click();
  await page.waitForFunction(() => { const x = document.querySelector('[data-ss-adv="msg"]'); return x && /Saved as|failed|Couldn|isn't/.test(x.innerText); }, null, { timeout: 60000 });
  let sd = calls.filter((c) => c.action === "save_style_d3").pop();
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  ok("5: ⚠️ Save sends the four corners, and the fall's keys as an explicit null",
    sd && same(sd.body.d3.gradeCornersFt, { fl: 0, fr: 0, bl: 1.5, br: 2 }) && has(sd.body.d3, "gradeFallFt") && sd.body.d3.gradeFallFt === null && sd.body.d3.gradeFallToward === null && sd.body.d3.foundation === "piers",
    sd && JSON.stringify({ c: sd.body.d3.gradeCornersFt, f: sd.body.d3.gradeFallFt, t: sd.body.d3.gradeFallToward }));

  // 4 ── Level ground ──
  await page.locator('[data-ss-adv-f="groundLevel"]').click();
  await settle(page, 300);
  ok("4: 'Level ground' empties the four boxes, each reads 'level', and it turns itself off",
    same(await values(page), { fl: "", fr: "", bl: "", br: "" }) && same(await says(page), { fl: "level", fr: "level", bl: "level", br: "level" }) && !(await page.locator('[data-ss-adv-f="groundLevel"]').isEnabled()));
  await panelModel(page, (M) => M.gradeCorners === null && M.foundation && M.foundation.kind === "piers");
  const lv = await piers(page);
  ok("4: ...and the 3D is level again: every pier the same height", lv.gc === null && lv.piers.length > 0 && Math.max(...lv.piers.map(h)) - Math.min(...lv.piers.map(h)) < 1e-6, JSON.stringify(lv.gc));
  await page.getByLabel("New style name").fill("Harness Flat Cabin");
  await page.getByRole("button", { name: "Save as a new style" }).click();
  await settle(page, 1500);
  sd = calls.filter((c) => c.action === "save_style_d3").pop();
  ok("5: saved level, it sends gradeCornersFt as an explicit null", sd && has(sd.body.d3, "gradeCornersFt") && sd.body.d3.gradeCornersFt === null, sd && JSON.stringify(sd.body.d3.gradeCornersFt));

  // 6 ── a style storing a fall ──
  await page.locator('[data-ss-adv="start"] [data-ss-style="hfall"]').click();
  await settle(page, 1200);
  await page.locator("#ss-step-adv-walls").scrollIntoViewIfNeeded();
  ok("6: a style storing a 2 ft fall to the back opens with it as corners: both back corners 2",
    same(await values(page), { fl: "", fr: "", bl: "2", br: "2" }) && same(await says(page), { fl: "highest", fr: "highest", bl: "2' 0\" lower", br: "2' 0\" lower" }), JSON.stringify(await values(page)));
  await panelModel(page, (M) => !!(M.gradeCorners && M.gradeCorners.bl === 2 && M.gradeCorners.br === 2 && M.gradeFall && M.gradeFall.fallFt === 2));
  await type(page, "fr", 0.5);
  await panelModel(page, (M) => !!(M.gradeCorners && M.gradeCorners.fr === 0.5 && M.gradeFall === null));
  ok("6: an edited corner draws corners in place of the fall (model.gradeFall null)", true);
  await page.getByLabel("New style name").fill("Harness Hillside Two");
  await page.getByRole("button", { name: "Save as a new style" }).click();
  await settle(page, 2500);
  sd = calls.filter((c) => c.action === "save_style_d3").pop();
  ok("6: ⚠️ ...and saves the four corners with the fall's keys null",
    sd && same(sd.body.d3.gradeCornersFt, { fl: 0, fr: 0.5, bl: 2, br: 2 }) && sd.body.d3.gradeFallFt === null && sd.body.d3.gradeFallToward === null,
    sd && JSON.stringify({ c: sd.body.d3.gradeCornersFt, f: sd.body.d3.gradeFallFt, t: sd.body.d3.gradeFallToward }));
  ok("8: zero page errors (1440)", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();

  // 7 ── a phone's width ──
  const ph = await open("/portal/advanced", { width: 390, height: 844 });
  await ph.page.locator("#ss-step-adv-walls").scrollIntoViewIfNeeded();
  await radio(ph.page, "What it stands on", "Piers").click();
  await settle(ph.page, 300);
  await type(ph.page, "fl", 0);
  await type(ph.page, "fr", 2);
  await type(ph.page, "bl", 1.5);
  await type(ph.page, "br", 2);
  await field(ph.page).scrollIntoViewIfNeeded();
  const fit = await ph.page.evaluate(() => {
    const el = document.querySelector('[data-ss-adv-f="gradeCornersFt"]');
    const r = el.getBoundingClientRect();
    const parts = [...el.querySelectorAll("[data-ss-adv-corner] input, svg[data-ss-adv-corner-plan]")].map((q) => q.getBoundingClientRect());
    return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, left: r.left, right: r.right,
      inside: parts.every((p) => p.left >= r.left - 1 && p.right <= r.right + 1 && p.width > 20), planW: Math.round(el.querySelector("svg[data-ss-adv-corner-plan]").getBoundingClientRect().width) };
  });
  ok("7: at 390 px the control fits: no sideways page scroll, the four boxes and the plan inside the card", fit.sw <= fit.cw && fit.inside && fit.planW >= 100, JSON.stringify(fit));
  ok("7: ...Carolyn's 0 and 2 read 'highest' and 2' 0\" lower", same(await says(ph.page), { fl: "highest", fr: "2' 0\" lower", bl: "1' 6\" lower", br: "2' 0\" lower" }), JSON.stringify(await says(ph.page)));
  await ph.page.evaluate(() => { const el = document.querySelector('[data-ss-adv-f="gradeCornersFt"]'); window.scrollBy(0, el.getBoundingClientRect().top - 150); });
  await settle(ph.page, 400);
  await ph.page.screenshot({ path: join(SHOTS, "advanced-corners-390.png") });
  ok("8: zero page errors (390)", ph.errors.length === 0, ph.errors.slice(0, 3).join(" | "));
  await ph.ctx.close();
} catch (e) {
  ok("ran to the end", false, e && e.message ? e.message.split("\n")[0] : String(e));
} finally {
  await browser.close();
}
const bad = failed();
console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL PASS");
process.exit(bad.length ? 1 : 0);
