// THE ADVANCED PAGE'S SECTIONS (2026-09-29), driven on the COMPILED portal.
//
// Carolyn, 09-28 @32:17: "think about the layout ... how are you going to organize all of the things
// there that have to do with roof". The Advanced page shows the calibration field grid one section at
// a time (CAL_ADV_SECTIONS, calAdvShow in both designer twins). This proves:
//   1  the tab strip: Roof, Walls & foundation, Lean-to, Wings, Dormer, Porch & steps, Colors, in
//      that order, Roof first and selected;
//   2  each tab shows its own fields and none of another's;
//   3  the three 3D asks of the same call work from their tabs on one building: a lean-to that meets
//      the ROOF 2 ft up, a porch with FOUR steps, and piers on ground that falls 2 ft to the back;
//   4  a shed roof greys out Wings and Dormer (they need a ridge);
//   5  the calibration panel in Settings > Designer still shows every field at once and no tab strip.
//
//   python -m http.server 8146 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8146 SS_SHOTS=<dir> node tests/harness/advancedSections.mjs
//
// Exit 0 = every check held.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, collectErrors, shotsDir, BASE, REF, PASS_THROUGH_GET } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const SHOTS = shotsDir("advancedSections");
const OURS = "harness-internal";   // a harness slug: the real internal tenant is never named here

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000046", aud: "authenticated", role: "authenticated", email: "sec@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const CONFIG = {
  branding: { companyName: "Harness Internal", accentColor: "#3D3672", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  buildingStyles: [{ value: "hcabin", label: "Harness Cabin", sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }],
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, siding: "batten", colors: { body: "#9B2F2F", trim: "#F4F1EA", roof: "#3E434A" }, wallHeightFt: 8 } }],
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

async function open(path) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    window.__SS3D_DEBUG = true;
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
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
      if (body.action === "status") return json(route, { ok: true, clientId: OURS, role: "owner", settings: { business_name: OURS }, config: { company_name: OURS, accent_color: "#3D3672" }, access: null, prefs: null });
      if (body.action === "catalog") return json(route, { ok: true, aiReady: true, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(`**/${REF}.storage.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  return { ctx, page, errors };
}

const FIELDS = '[data-ss-adv="fields"]';
// Which of the grid's field labels are on screen, by their first line of text.
const shownLabels = (page, root) => page.evaluate((root) => [...document.querySelectorAll(`${root} label`)]
  .filter((l) => l.offsetParent !== null)
  .map((l) => l.innerText.trim().split("\n")[0].trim()), root);
const has = (labels, re) => labels.some((t) => re.test(t));
// The grid label whose FIRST visible line matches: a label's text also holds its options and hints.
async function field(page, re) {
  const i = await page.evaluate(({ root, src, flags }) => {
    const rx = new RegExp(src, flags);
    return [...document.querySelectorAll(`${root} label`)].findIndex((l) => l.offsetParent !== null && rx.test(l.innerText.trim().split("\n")[0].trim()));
  }, { root: FIELDS, src: re.source, flags: re.flags });
  if (i < 0) throw new Error(`no field ${re} on screen`);
  return page.locator(`${FIELDS} label`).nth(i);
}
const tab = (page, k) => page.locator(`[data-ss-adv-sec="${k}"]`);
async function panelModel(page, test, timeout = 60000) {
  await page.waitForFunction((src) => {
    const P = window.__ss3dPanel;
    if (!(P && P.model && P.renderer && P.renderer.domElement.isConnected && P.renderer.domElement.closest('[data-ss-adv="view"]'))) return false;
    return new Function("M", `return (${src})(M);`)(P.model);
  }, test.toString(), { timeout });
}
const shot = async (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: false });

try {
  const { ctx, page, errors } = await open("/portal/advanced");
  await page.waitForSelector('[data-ss-adv="sections"]', { timeout: 60000 });

  // 1 ── the strip ────────────────────────────────────────────────────────────────────────────
  const tabs = await page.$$eval('[data-ss-adv="sections"] [data-ss-adv-sec]', (b) => b.map((x) => [x.dataset.ssAdvSec, x.innerText.trim(), x.getAttribute("aria-selected")]));
  ok("1: seven section tabs, in the grid's order",
    JSON.stringify(tabs.map((t) => t[1])) === JSON.stringify(["Roof", "Walls & foundation", "Lean-to", "Wings", "Dormer", "Porch & steps", "Colors"]), JSON.stringify(tabs));
  // US spelling, as the fields under it say ("Body Color"), review 2026-09-29.
  ok("1: no tab says Colours", !tabs.some((t) => /Colours/.test(t[1])), JSON.stringify(tabs));
  ok("1: Roof is selected first", tabs[0] && tabs[0][2] === "true" && tabs.slice(1).every((t) => t[2] === "false"));

  // 2 ── each tab shows its own fields ──────────────────────────────────────────────────────────
  const EXPECT = {
    roof: { must: [/^Roof type/, /^Pitch/, /^Overhang \(ft\)/], never: [/^Wall height/, /^Lean-to width/, /^Lower wings/, /^Dormer width/, /^Porch$/, /^Body Color/] },
    walls: { must: [/^Wall height/, /^Siding/, /^What it stands on/], never: [/^Roof type/, /^Pitch/, /^Lean-to width/, /^Body Color/] },
    leanto: { must: [/^Lean-to width/], never: [/^Roof type/, /^Wall height/, /^Lower wings/, /^Dormer width/] },
    wings: { must: [/^Lower wings/], never: [/^Roof type/, /^Lean-to width/, /^Dormer width/] },
    dormer: { must: [/^Dormer width/], never: [/^Roof type/, /^Lean-to width/, /^Lower wings/] },
    porch: { must: [/^Porch$/], never: [/^Roof type/, /^Lean-to width/, /^Dormer width/, /^Body Color/] },
    colours: { must: [/^Body Color/, /^Trim Color/, /^Roof Color/], never: [/^Roof type/, /^Lean-to width/, /^Wall height/] },
  };
  for (const [k, e] of Object.entries(EXPECT)) {
    await tab(page, k).click();
    await page.waitForTimeout(150);
    const labels = await shownLabels(page, FIELDS);
    ok(`2: ${k} shows its own fields`, e.must.every((re) => has(labels, re)), JSON.stringify(labels));
    ok(`2: ${k} shows none of another section's`, !e.never.some((re) => has(labels, re)), JSON.stringify(labels));
    ok(`2: ${k} is the selected tab`, await tab(page, k).getAttribute("aria-selected") === "true");
    await shot(page, `sec-${k}.png`);
  }

  // 3 ── the three 3D asks, each from its own tab ──────────────────────────────────────────────
  await tab(page, "leanto").click();
  await (await field(page, /^Lean-to width/)).locator("input").fill("8");
  await (await field(page, /^Lean-to meets the building/)).locator("select").selectOption("roof");
  await (await field(page, /^How far \(ft\)/)).locator("input").fill("2");
  await page.keyboard.press("Tab");
  await panelModel(page, (M) => !!(M.leanTo && M.leanTo.mode === "roof" && Math.abs(M.leanTo.d - 2) < 1e-6));
  const lt = await page.evaluate(() => { const L = window.__ss3dPanel.model.leanTo; return { mode: L.mode, d: L.d, ya: L.ya, E: L.E }; });
  ok("3: the lean-to meets the roof 2 ft above the eave", lt.mode === "roof" && Math.abs(lt.d - 2) < 1e-6 && lt.ya > lt.E + 2, JSON.stringify(lt));
  await shot(page, "ask-leanto-roof.png");

  await tab(page, "porch").click();
  {
    const porch = (await field(page, /^Porch$/)).locator("select");
    const opts = await porch.locator("option").allInnerTexts();
    await porch.selectOption({ label: opts.find((o) => /Projecting/.test(o)) });
  }
  await (await field(page, /^Porch steps/)).locator("select").selectOption("center");
  await (await field(page, /^Number of steps/)).locator("input").fill("4");
  await panelModel(page, (M) => { let n = 0; M.root.traverse((q) => { if (q.userData && q.userData.ssPorchPart === "stepTread") n++; }); return n === 4; });
  ok("3: the porch has the four steps typed", true);
  await shot(page, "ask-porch-4-steps.png");

  await tab(page, "walls").click();
  await (await field(page, /^What it stands on/)).locator("select").selectOption("piers");
  await (await field(page, /^Ground falls away/)).locator("input").fill("2");
  await (await field(page, /^Toward/)).locator("select").selectOption("back");
  await panelModel(page, (M) => !!(M.gradeFall && M.gradeFall.fallFt === 2 && M.gradeFall.toward === "back" && M.foundation && M.foundation.kind === "piers"));
  const pier = await page.evaluate(() => {
    const P = window.__ss3dPanel, M = P.model, V = P.camera.position.constructor;
    P.scene.updateMatrixWorld(true);
    const rows = [];
    M.root.traverse((q) => {
      if (!(q.isMesh && q.userData && q.userData.ssFoundationPart === "pier")) return;
      q.geometry.computeBoundingBox();
      const b = q.geometry.boundingBox, lo = new V(0, b.min.y, 0).applyMatrix4(q.matrixWorld), hi = new V(0, b.max.y, 0).applyMatrix4(q.matrixWorld);
      const c = new V(0, 0, 0).applyMatrix4(q.matrixWorld);
      rows.push({ z: c.z, h: hi.y - lo.y });
    });
    rows.sort((a, b) => a.z - b.z);
    return { n: rows.length, back: rows[0], front: rows[rows.length - 1] };
  });
  ok("3: piers stand under the building", pier.n > 0, JSON.stringify(pier));
  ok("3: the back row stands taller than the front row (the ground falls to the back)", pier.n > 0 && pier.back.h > pier.front.h + 1, JSON.stringify(pier));
  await page.evaluate(() => { const P = window.__ss3dPanel; P.camera.position.set(26, 2, 0); P.controls.target.set(0, 1, 0); P.controls.update(); P.render(); });
  await page.waitForTimeout(200);
  await shot(page, "ask-piers-falling-ground.png");

  // 4 ── a shed greys out Wings and Dormer ─────────────────────────────────────────────────────
  await tab(page, "roof").click();
  await (await field(page, /^Roof type/)).locator("select").selectOption("shed");
  await page.waitForTimeout(150);
  ok("4: on a shed, Wings is unavailable", await tab(page, "wings").isDisabled());
  ok("4: on a shed, Dormer is unavailable", await tab(page, "dormer").isDisabled());
  ok("4: …and Lean-to is not", !(await tab(page, "leanto").isDisabled()));
  await (await field(page, /^Roof type/)).locator("select").selectOption("gable");
  await page.waitForTimeout(150);
  ok("4: back on a gable, Wings is available again", !(await tab(page, "wings").isDisabled()));

  ok("no page errors on the Advanced page", errors.length === 0, errors.join(" | "));
  await ctx.close();

  // 5 ── the calibration panel keeps every field at once ──────────────────────────────────────
  {
    const { ctx: c2, page: p2, errors: e2 } = await open("/portal/settings/designer");
    await p2.waitForFunction(() => document.body.innerText.includes("3D Style Calibration"), null, { timeout: 60000 });
    await p2.getByRole("button", { name: "Harness Cabin", exact: true }).first().click().catch(() => {});
    await p2.waitForFunction(() => [...document.querySelectorAll("label")].some((l) => /^Roof type/.test(l.innerText.trim())), null, { timeout: 30000 });
    const labels = await shownLabels(p2, "body");
    ok("5: the calibration panel still shows roof, walls, lean-to, dormer, porch and colours together",
      [/^Roof type/, /^Wall height/, /^Lean-to width/, /^Dormer width/, /^Porch$/, /^Body Color/].every((re) => has(labels, re)), JSON.stringify(labels));
    ok("5: …and no section tabs", await p2.locator('[data-ss-adv="sections"]').count() === 0);
    ok("5: no page errors", e2.length === 0, e2.join(" | "));
    await c2.close();
  }
} catch (e) {
  ok("the run finished", false, String(e && e.stack || e));
} finally {
  await browser.close();
}
console.log(failed().length ? `${failed().length} FAILED` : "all checks passed");
process.exit(failed().length ? 1 : 0);
