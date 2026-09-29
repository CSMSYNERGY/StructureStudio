// THE ADVANCED PAGE'S SECTIONS, driven on the COMPILED portal.
//
// Carolyn, 09-28 @32:17: "think about the layout ... how are you going to organize all of the things
// there that have to do with roof". Ahsan, 09-29: "can you see the designer tab how organised and good
// looking it is i want same in the advance tab". Since 2026-09-29 the page is the Designer's own frame:
// numbered sections (Start from, Size & roof, Walls & foundation, Add-ons, Colors, Save) on the
// Designer's step rail, with the add-ons (Lean-to, Wings, Dormer, Porch & steps) one at a time on a
// Designer option tab strip. This proves:
//   0  the page is inside the Designer's frame (.ssd-frame); at a 1440 window the frame reaches xl and
//      shows the numbered step rail (and no progress bar), at 1100 the sticky progress bar instead,
//      stuck under the portal's topbar; the rail follows the scroll and a click on a step brings its
//      section up; the sticky 3D column is no scroll box of its own and all of it (3D, buttons on one
//      line, End view) is on screen above the portal's Feedback pill, at 1440 and at 1100;
//   1  the add-on strip: Lean-to, Wings, Dormer, Porch & steps, in that order, Lean-to first;
//   2  each add-on tab shows only its own controls (and none of another's anywhere), while the shape,
//      walls and colour sections are always on screen; a slider moves its box and lights the end view;
//   3  the three 3D asks of the same call work on one building: a lean-to that meets the ROOF 2 ft up,
//      a porch with FOUR steps, and piers on ground that falls 2 ft to the back;
//      3b: on Auto, the steps' and posts' −/+ step from the count Auto draws, and the posts' Auto chip
//      keeps saying what Auto draws once a number is typed;
//   4  a shed roof greys out Wings and Dormer (they need a ridge); 4b: at a phone's width the Save
//      footer spans the width and the add-on tabs stay one row with no sideways page scroll;
//   5  the calibration panel in Settings > Designer still shows every field at once and no tab strip;
//   6  the second review (2026-09-29): the End view's words are readable (11 px or more at 1440) and its
//      pitch is the Pitch box's own number; a click in the middle of a number box never changes the
//      building (Chrome's spinner is gone), and "click the steps box, type 4" builds 4 steps (in 3);
//      Corner boards' three choices are one row; Roof shape is not stretched to Roof finish's height;
//      the name box starts under the hint; every note is one line, with the rest behind an (i) that
//      opens on a click; "Not set" is on but quiet; a shed says in words why Wings and Dormer are off;
//      at 1366x640 the whole 3D column still ends above the Feedback pill; under the dock's width the
//      End view is in Size & roof and a "See in 3D" button stays on screen down the form.
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

const byLabel = (page, name) => page.getByLabel(name, { exact: true });
const tab = (page, k) => page.locator(`[data-ss-adv-sec="${k}"]`);
const radio = (page, group, name) => page.getByRole("radiogroup", { name: group, exact: true }).getByRole("radio", { name, exact: true });
const segBtn = (page, group, name) => page.getByRole("group", { name: group, exact: true }).getByRole("button", { name, exact: true });
// The add-on panel's own switch ("Add a lean-to" / "✓ Lean-to on").
const addOnSwitch = (page) => page.locator("[data-ss-adv-panel] .ss-adv-panel > button.ssd-tool").first();
async function switchOn(page) {
  if (await addOnSwitch(page).getAttribute("aria-pressed") !== "true") await addOnSwitch(page).click();
  await page.waitForTimeout(150);
}
const fieldsIn = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-ss-adv-f]`)].filter((e) => e.offsetParent !== null).map((e) => e.dataset.ssAdvF), sel);
async function panelModel(page, test, timeout = 60000) {
  await page.waitForFunction((src) => {
    const P = window.__ss3dPanel;
    if (!(P && P.model && P.renderer && P.renderer.domElement.isConnected && P.renderer.domElement.closest('[data-ss-adv="view"]'))) return false;
    return new Function("M", `return (${src})(M);`)(P.model);
  }, test.toString(), { timeout });
}
const shot = async (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: false });
const railCur = (page) => page.evaluate(() => { const b = document.querySelector(".ss-adv .ssd-rail .ssd-step.is-current"); return b ? b.getAttribute("aria-label") : ""; });

try {
  const { ctx, page, errors } = await open("/portal/advanced");
  await page.waitForSelector('[data-ss-adv="sections"]', { timeout: 60000 });
  await page.waitForTimeout(600);

  // 0 ── the Designer's frame, rail and progress bar ────────────────────────────────────────────
  const fr = await page.evaluate(() => {
    const f = document.querySelector('[data-ss-adv="fields"]').closest(".ssd-frame");
    const vis = (el) => !!el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;
    return {
      inFrame: !!f, bp: f && f.getAttribute("data-ssd-bp"), view: !!document.querySelector('[data-ss-adv="view"]').closest(".ssd-frame"),
      rail: f ? [...f.querySelectorAll(".ssd-rail .ssd-step")].filter(vis).map((b) => b.getAttribute("aria-label")) : [],
      bar: f ? vis(f.querySelector(".ssd-progress")) : null,
    };
  });
  ok("0: the page is inside the Designer's frame (.ssd-frame), the 3D column too", fr.inFrame && fr.view, JSON.stringify(fr));
  ok("0: at a 1440 window the frame is at xl and shows the numbered step rail (six steps)", fr.bp === "xl" && fr.rail.length === 6, JSON.stringify(fr));
  ok("0: …Start from first, Save last", /^Step 1 of 6: Start from/.test(fr.rail[0] || "") && /^Step 6 of 6: Name & save/.test(fr.rail[5] || ""), JSON.stringify(fr.rail));
  ok("0: …and no progress bar at xl", fr.bar === false);
  await page.locator('.ss-adv .ssd-rail .ssd-step[aria-label^="Step 3 of 6"]').click();
  await page.waitForTimeout(1200);
  const went = await page.evaluate(() => Math.round(document.getElementById("ss-step-adv-walls").getBoundingClientRect().top));
  const cur3 = await railCur(page);
  ok("0: a click on the rail's Walls step brings that section up under the topbar and marks it current", went >= 55 && went <= 80 && /^Step 3 of 6: Walls & foundation/.test(cur3), `${went} ${cur3}`);
  await shot(page, "frame-rail-1440.png");
  // The 3D column is not a scroll box of its own (a second scrollbar on Windows), and all of it -- the
  // 3D, its toolbar and the End view -- is on screen above the portal's Feedback pill.
  const col = async () => page.evaluate(() => {
    const v = document.querySelector('[data-ss-adv="view"]');
    const plan = v.querySelector(".ssd-plan").getBoundingClientRect();
    const fb = [...document.querySelectorAll("button,a")].find((b) => /Feedback/.test(b.innerText || ""));
    const pill = fb ? fb.getBoundingClientRect() : null;
    const cs = getComputedStyle(v);
    return { scrollBox: /auto|scroll/.test(cs.overflowY) || v.scrollHeight > v.clientHeight + 1, planBottom: Math.round(plan.bottom),
      pillTop: pill ? Math.round(pill.top) : null, vh: innerHeight, has3d: !!v.querySelector("canvas"),
      oneLine: new Set([...v.querySelectorAll(".ssd-tb button")].map((b) => Math.round(b.getBoundingClientRect().top))).size === 1 };
  });
  const c1440 = await col();
  ok("0: the 3D column has no scroll of its own", !c1440.scrollBox, JSON.stringify(c1440));
  ok("0: …the 3D, its buttons (on one line) and the End view all sit above the Feedback pill", c1440.has3d && c1440.oneLine && c1440.pillTop != null && c1440.planBottom <= c1440.pillTop, JSON.stringify(c1440));
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, -6000);
  await page.waitForTimeout(1200);
  const cur1 = await railCur(page);
  ok("0: scrolled back to the top, the rail follows (Start from is current)", /^Step 1 of 6: Start from/.test(cur1), cur1);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(700);
  const md = await page.evaluate(() => {
    const f = document.querySelector(".ss-adv .ssd-frame");
    const bar = f.querySelector(".ssd-progress");
    return { bp: f.getAttribute("data-ssd-bp"), bar: bar.offsetParent !== null && bar.getBoundingClientRect().height > 0, rail: [...f.querySelectorAll(".ssd-rail")].some((r) => r.getBoundingClientRect().width > 0) };
  });
  ok("0: at 1100 the rail gives way to the sticky progress bar, like the Designer", md.bp !== "xl" && md.bar && !md.rail, JSON.stringify(md));
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(900);
  const barTop = await page.evaluate(() => Math.round(document.querySelector(".ss-adv .ssd-progress").getBoundingClientRect().top));
  ok("0: …and scrolled, the bar sticks just under the portal's topbar", barTop >= 58 && barTop <= 64, String(barTop));
  const c1100 = await col();
  ok("0: at 1100 too, the whole 3D column is on screen above the Feedback pill, with no scroll of its own",
    !c1100.scrollBox && c1100.oneLine && c1100.pillTop != null && c1100.planBottom <= c1100.pillTop, JSON.stringify(c1100));
  await page.screenshot({ path: join(SHOTS, "progress-1100.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.mouse.wheel(0, -6000);
  await page.waitForTimeout(700);

  // 1 ── the add-on strip ─────────────────────────────────────────────────────────────────────
  const tabs = await page.$$eval('[data-ss-adv="sections"] [data-ss-adv-sec]', (b) => b.map((x) => [x.dataset.ssAdvSec, x.innerText.trim(), x.getAttribute("aria-selected")]));
  ok("1: four add-on tabs, in order", JSON.stringify(tabs.map((t) => t[1])) === JSON.stringify(["Lean-to", "Wings", "Dormer", "Porch & steps"]), JSON.stringify(tabs));
  ok("1: Lean-to is selected first", tabs[0] && tabs[0][2] === "true" && tabs.slice(1).every((t) => t[2] === "false"));

  // 2 ── each add-on tab shows only its own controls; the rest of the page is always there ─────────
  const OWN = {
    leanto: ["leanToOn", "leanToWidthFt", "leanToDropFt", "leanToSide", "leanToAttach", "leanToAttachFt"],
    wings: ["wingsOn", "wingWidthFt", "wingSide", "wingAttach", "wingAttachFt", "wingPitch", "centerEaveFt"],
    dormer: ["dormerOn", "dormerType", "dormerWidthFt", "dormerRiseFt", "dormerOffsetU"],
    porch: ["porchKind", "porchDepth", "porchEnd", "porchTruss", "porchWidthFt", "porchAttachFt", "porchPitch", "porchPosts", "porchSteps", "porchStepCount", "wood"],
  };
  const MUST = { leanto: ["leanToWidthFt", "leanToSide"], wings: ["wingWidthFt", "wingSide"], dormer: ["dormerWidthFt", "dormerType"], porch: ["porchKind"] };
  const others = (k) => Object.entries(OWN).filter(([o]) => o !== k).flatMap(([, v]) => v);
  for (const k of Object.keys(OWN)) {
    await tab(page, k).click();
    await page.waitForTimeout(150);
    if (k !== "porch") await switchOn(page);
    const inPanel = await fieldsIn(page, "[data-ss-adv-panel]");
    const all = await fieldsIn(page, ".ss-adv");
    ok(`2: ${k} shows its own controls`, MUST[k].every((f) => inPanel.includes(f)), JSON.stringify(inPanel));
    ok(`2: ${k} shows nothing but its own controls, and no other add-on's anywhere`, inPanel.every((f) => OWN[k].includes(f)) && !all.some((f) => others(k).includes(f)), JSON.stringify(inPanel));
    ok(`2: ${k} is the selected tab`, await tab(page, k).getAttribute("aria-selected") === "true");
    ok(`2: ${k}: the shape, walls and colour sections are still on screen`, ["roofType", "wallHeightFt", "foundation", "siding", "color-body", "color-trim", "color-roof"].every((f) => all.includes(f)), JSON.stringify(all));
    await page.locator("#ss-step-adv-addons").scrollIntoViewIfNeeded();
    await shot(page, `sec-${k}.png`);
    // Off again, so the next tab starts from the building as it was.
    if (k !== "porch") await addOnSwitch(page).click();
  }
  // A slider: arrow keys on the pitch slider move the box and light the end view's pitch label
  // (D3ElevationSVG draws the focused measurement in its highlight colour, #B45309).
  const hl = () => page.evaluate(() => [...document.querySelectorAll('[data-ss-adv="view"] svg text')]
    .filter((t) => /^[\d.]+:12$/.test(t.textContent.trim())).map((t) => getComputedStyle(t).fill).join(","));
  const pitchBox = byLabel(page, "Pitch");
  await pitchBox.fill("5");
  await pitchBox.blur();
  await page.waitForTimeout(200);
  const hl0 = await hl();
  const p0 = Number(await pitchBox.inputValue());
  await page.getByLabel("Pitch, slider", { exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  const p1 = Number(await pitchBox.inputValue());
  const hl1 = await hl();
  ok("2: two steps of the pitch slider make it 1 in 12 steeper, in the box beside it", Math.abs(p1 - p0 - 1) < 1e-6, `${p0} → ${p1}`);
  ok("2: …and while the slider is held, the end view lights the pitch", /180, 83, 9/.test(hl1) && !/180, 83, 9/.test(hl0), `${hl0} → ${hl1}`);
  const pitchText = await page.evaluate(() => [...document.querySelectorAll('[data-ss-adv="view"] svg text')].map((t) => t.textContent.trim()).filter((x) => /:12$/.test(x)));
  ok("6: the End view writes the pitch as the box has it (a half step shows, not rounded to a whole number)", pitchText.length === 1 && pitchText[0] === `${p1}:12`, `${JSON.stringify(pitchText)} vs box ${p1}`);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await pitchBox.focus();
  await pitchBox.blur();

  // 3 ── the three 3D asks ────────────────────────────────────────────────────────────────────
  await tab(page, "leanto").click();
  await switchOn(page);
  await byLabel(page, "Lean-to width (ft)").fill("8");
  await segBtn(page, "Meets the building", "On the roof").click();
  await byLabel(page, "How far up the roof (ft)").fill("2");
  await page.keyboard.press("Tab");
  await panelModel(page, (M) => !!(M.leanTo && M.leanTo.mode === "roof" && Math.abs(M.leanTo.d - 2) < 1e-6));
  const lt = await page.evaluate(() => { const L = window.__ss3dPanel.model.leanTo; return { mode: L.mode, d: L.d, ya: L.ya, E: L.E }; });
  ok("3: the lean-to meets the roof 2 ft above the eave", lt.mode === "roof" && Math.abs(lt.d - 2) < 1e-6 && lt.ya > lt.E + 2, JSON.stringify(lt));
  const ltSay = await page.locator('[data-ss-adv-readout="leanTo"]').innerText().catch(() => "");
  ok("3: …and the panel reads it back (Builds x in 12 · meets the roof 2' 0\" above the eave)", /^Builds [\d.]+ in 12 · meets the roof 2' 0" above the eave$/.test(ltSay.trim()), JSON.stringify(ltSay));
  // …with its measurements held together by no-break spaces, so "2' 0"" and "in 12" never split across a line.
  await page.locator("#ss-step-adv-addons").scrollIntoViewIfNeeded();
  await shot(page, "ask-leanto-roof.png");

  await tab(page, "porch").click();
  await radio(page, "Porch", "Projecting").click();
  await segBtn(page, "Porch steps", "Center").click();
  // With a real mouse, in the middle of the box, as anyone starts typing into it: Chrome's spinner used to
  // sit there and the click wrote 1, so "type 4" made 14, held to 12 (review 2026-09-29).
  const stepsBox = byLabel(page, "Number of steps");
  await stepsBox.scrollIntoViewIfNeeded();
  const sbb = await stepsBox.boundingBox();
  await page.mouse.click(sbb.x + sbb.width / 2 + 6, sbb.y + sbb.height / 2);
  await page.waitForTimeout(200);
  const afterClick = await stepsBox.inputValue();
  ok("6: a click in the middle of the Auto 'Number of steps' box leaves it on Auto", afterClick === "", JSON.stringify(afterClick));
  await page.keyboard.type("4");
  await page.keyboard.press("Tab");
  await panelModel(page, (M) => { let n = 0; M.root.traverse((q) => { if (q.userData && q.userData.ssPorchPart === "stepTread") n++; }); return n === 4; });
  ok("3: the porch has the four steps typed", true);
  await page.locator("#ss-step-adv-addons").scrollIntoViewIfNeeded();
  await shot(page, "ask-porch-4-steps.png");

  await radio(page, "What it stands on", "Piers").click();
  await byLabel(page, "Ground falls away (ft)").fill("2");
  await page.keyboard.press("Tab");
  await segBtn(page, "Toward", "Back").click();
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
  await page.locator("#ss-step-adv-walls").scrollIntoViewIfNeeded();
  await shot(page, "ask-piers-falling-ground.png");

  // 3b ── on Auto, −/+ step from the count Auto draws (review 2026-09-29: they stepped from the bottom of
  // the band, so "one more" could LOWER it), and the posts' Auto chip keeps reading what Auto draws once a
  // number is typed. Auto is the same .ssd-chip as "Whole wall".
  const autoChip = (f) => page.locator(`[data-ss-adv-f="${f}"] button.ssd-chip`);
  const autoOf = async (f) => Number((/\((\d+)\)/.exec(await autoChip(f).innerText()) || [])[1]);
  await page.locator('[data-ss-adv-f="porchStepCount"]').scrollIntoViewIfNeeded();
  await autoChip("porchStepCount").click();
  await page.waitForTimeout(150);
  const autoSteps = await autoOf("porchStepCount");
  await page.getByRole("button", { name: "Number of steps: one more", exact: true }).click();
  await page.waitForTimeout(150);
  const stepsUp = Number(await byLabel(page, "Number of steps").inputValue());
  await autoChip("porchStepCount").click();
  await page.waitForTimeout(150);
  await page.getByRole("button", { name: "Number of steps: one fewer", exact: true }).click();
  await page.waitForTimeout(150);
  const stepsDown = Number(await byLabel(page, "Number of steps").inputValue());
  ok("3b: from Auto, + gives one step more than Auto draws and − one fewer",
    autoSteps >= 2 && stepsUp === Math.min(12, autoSteps + 1) && stepsDown === Math.min(12, autoSteps - 1), `Auto ${autoSteps} → + ${stepsUp}, − ${stepsDown}`);
  await autoChip("porchStepCount").click();
  await autoChip("porchPosts").click();
  await page.waitForTimeout(150);
  const autoPosts = await autoOf("porchPosts");
  await page.getByRole("button", { name: "Porch posts: one more", exact: true }).click();
  await page.waitForTimeout(150);
  const postsUp = Number(await byLabel(page, "Porch posts").inputValue());
  const postsChip = await autoChip("porchPosts").innerText();
  ok("3b: from Auto, + gives one post more than Auto draws", autoPosts >= 2 && postsUp === Math.min(8, autoPosts + 1), `Auto ${autoPosts} → ${postsUp}`);
  ok("3b: …and the chip still says what Auto draws, not the number typed", postsChip.trim() === `Auto (${autoPosts})` && await autoChip("porchPosts").getAttribute("aria-pressed") === "false", postsChip);
  await autoChip("porchPosts").click();

  // 4 ── a shed greys out Wings and Dormer ─────────────────────────────────────────────────────
  await radio(page, "Roof type", "One slant").click();
  await page.waitForTimeout(150);
  ok("4: on a shed, Wings is unavailable", await tab(page, "wings").isDisabled());
  ok("4: on a shed, Dormer is unavailable", await tab(page, "dormer").isDisabled());
  ok("4: …and says why", (await tab(page, "wings").getAttribute("title")) === "Needs a two-slope or barn roof");
  ok("4: …and Lean-to is not", !(await tab(page, "leanto").isDisabled()));
  ok("6: …and the reason is on the page in words, not only in a hover title", await page.locator('[data-ss-adv="shed-note"]').isVisible()
    && /Wings and dormers need a two-slope or barn roof/.test(await page.locator('[data-ss-adv="shed-note"]').innerText()));
  await radio(page, "Roof type", "Two slopes").click();
  await page.waitForTimeout(150);
  ok("4: back on a gable, Wings is available again", !(await tab(page, "wings").isDisabled()));

  // 4b ── a phone's width: the Save footer uses the whole width (no 128 px pill clearance), and the add-on
  // tabs stay on one line (scrolling sideways) instead of leaving one alone on a second line.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  const xs = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
    const ft = r(".ss-adv-foot .ssd-ft"), nm = r(".ss-adv-name input"), cta = r(".ss-adv-foot .ssd-ft-cta");
    const tabs = [...document.querySelectorAll("[data-ss-adv-sec]")].map((t) => Math.round(t.getBoundingClientRect().top));
    const strip = document.querySelector('[data-ss-adv="sections"]');
    return { bp: document.querySelector(".ss-adv .ssd-frame").getAttribute("data-ssd-bp"), ft: ft && Math.round(ft.width), nm: nm && Math.round(nm.width), cta: cta && Math.round(cta.width),
      tabRows: new Set(tabs).size, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      strip: strip && [strip.scrollWidth, strip.clientWidth] };
  });
  ok("4b: at a phone's width the name box and the Save button span the footer", xs.bp === "xs" && xs.nm >= xs.ft - 2 && xs.cta >= xs.ft - 2, JSON.stringify(xs));
  ok("4b: …the add-on tabs are one row, and the page never scrolls sideways", xs.tabRows === 1 && !xs.sideways, JSON.stringify(xs));
  ok("6: …and all four tabs fit the strip, none cut off at an edge", xs.strip && xs.strip[0] <= xs.strip[1], JSON.stringify(xs.strip));
  await page.screenshot({ path: join(SHOTS, "phone-footer-390.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(500);

  // 6 ── the second review's fixes ──────────────────────────────────────────────────────────────
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  // The End view's words, in screen pixels (font size times the drawing's scale).
  const ev = await page.evaluate(() => {
    const svg = document.querySelector('[data-ss-adv="view"] [data-ss-adv="end"] svg');
    const k = svg.getBoundingClientRect().width / 360;
    const px = [...svg.querySelectorAll("text")].map((t) => ({ w: getComputedStyle(t).fontWeight, px: parseFloat(getComputedStyle(t).fontSize) * k }));
    const main = px.filter((p) => Number(p.w) >= 700).map((p) => p.px), sub = px.filter((p) => Number(p.w) < 700).map((p) => p.px);
    return { w: Math.round(svg.getBoundingClientRect().width), main: Math.min(...main), sub: Math.min(...sub) };
  });
  ok("6: at 1440 the End view is drawn wide enough to read: its measurements 11 px or more, its sub-labels 9 px or more", ev.main >= 11 && ev.sub >= 9, JSON.stringify(ev));
  // A click in the middle of the Width box selects it and changes nothing.
  await page.locator("#ss-step-adv-shape").scrollIntoViewIfNeeded();
  const wBox = byLabel(page, "Width (ft)");
  const wbb = await wBox.boundingBox();
  const meta0 = await page.locator('[data-ss-adv="bar"] .ssd-plan-meta').innerText();
  for (const dx of [0, 4, 8]) await page.mouse.click(wbb.x + wbb.width / 2 + dx, wbb.y + wbb.height / 2);
  await page.waitForTimeout(300);
  ok("6: clicks in the middle of the Width box change nothing (no spinner under the digits)",
    (await wBox.inputValue()) === "12" && (await page.locator('[data-ss-adv="bar"] .ssd-plan-meta').innerText()) === meta0, `${await wBox.inputValue()} · ${meta0}`);
  await page.keyboard.press("Tab");
  const lay = await page.evaluate(() => {
    const r = (e) => e && e.getBoundingClientRect();
    const corner = document.querySelector('[data-ss-adv-f="corner-mode"] .ssd-seg');
    const shape = [...document.querySelectorAll('#ss-step-adv-shape .ssd-card')].find((c) => c.querySelector('[data-ss-adv-f="roofType"]'));
    const ctl = shape && [...shape.querySelectorAll("[data-ss-adv-f]")].filter((e) => e.offsetParent).pop();
    const inFinish = !!document.querySelector('#ss-step-adv-shape .ssd-card [data-ss-adv-f="more"]');
    return { cornerRows: corner ? new Set([...corner.children].map((b) => Math.round(r(b).top))).size : 0,
      shapeSlack: shape && ctl ? Math.round(r(shape).bottom - r(ctl).bottom) : null, moreInACard: inFinish,
      hintL: Math.round(r(document.querySelector(".ss-adv-foot .ssd-ft-hint")).left), nameL: Math.round(r(document.querySelector(".ss-adv-name input")).left) };
  });
  ok("6: Corner boards' three choices sit on one row", lay.cornerRows === 1, JSON.stringify(lay));
  ok("6: Roof shape is as tall as its own controls (no stretched empty panel), and More roof settings is a row of its own",
    lay.shapeSlack != null && lay.shapeSlack <= 24 && !lay.moreInACard, JSON.stringify(lay));
  ok("6: the New style name box starts under the footer's hint", Math.abs(lay.hintL - lay.nameL) <= 2, JSON.stringify(lay));
  // Every note is one line (the page's own subtitle aside), and the rest of a long one is behind an (i).
  const tall = await page.evaluate(() => [...document.querySelectorAll('.ss-adv [data-ss-adv="fields"] .ss-adv-note, .ss-adv [data-ss-adv="view"] .ss-adv-note')]
    .filter((n) => n.offsetParent && n.innerText.trim() && !n.closest("details:not([open])")).map((n) => ({ h: Math.round(n.getBoundingClientRect().height), t: n.innerText.slice(0, 50) })).filter((n) => n.h > 20));
  ok("6: every note on the page (piers on falling ground, the porch, the lean-to) is one line", tall.length === 0, JSON.stringify(tall));
  const why = page.locator('[data-ss-adv-f="floorHeightFt"] .ss-adv-why');
  await why.locator("summary").scrollIntoViewIfNeeded();
  const whyHidden = !(await why.locator(".ss-adv-why-t").isVisible());
  await why.locator("summary").click();
  await page.waitForTimeout(200);
  ok("6: Floor height's (i) opens the rest of its note on a click", whyHidden && await why.locator(".ss-adv-why-t").isVisible() && /A door is 6/.test(await why.locator(".ss-adv-why-t").innerText()));
  await why.locator("summary").click();
  // "Not set" is on, but in the quiet style, not the accent fill.
  const unset = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-ss-adv-f="roofMaterial"] .ssd-seg-b')].find((x) => x.textContent === "Not set");
    const on = [...document.querySelectorAll('[data-ss-adv-f="eave"] .ssd-seg-b.is-on')][0];
    return { cls: b && b.className, bg: b && getComputedStyle(b).backgroundColor, onBg: on && getComputedStyle(on).backgroundColor };
  });
  ok("6: Material's 'Not set' is on but quiet (not the filled accent a real choice gets)", /is-on/.test(unset.cls) && /is-unset/.test(unset.cls) && unset.bg !== unset.onBg, JSON.stringify(unset));
  // A 1366x640 laptop window: the 3D column still fits, End view and all, above the Feedback pill.
  await page.setViewportSize({ width: 1366, height: 640 });
  await page.waitForTimeout(700);
  await page.evaluate(() => { const el = document.getElementById("ss-step-adv-walls"); window.scrollBy(0, el.getBoundingClientRect().top - 70); });
  await page.waitForTimeout(700);
  const c1366 = await col();
  ok("6: at 1366x640 the whole 3D column, End view included, ends on screen above the Feedback pill",
    c1366.has3d && !c1366.scrollBox && c1366.pillTop != null && c1366.planBottom <= c1366.pillTop && c1366.planBottom <= c1366.vh, JSON.stringify(c1366));
  // Under the dock's width (a 768 window): the End view is at the end of Size & roof, and "See in 3D"
  // stays on screen at the bottom, clear of the Feedback pill, all the way down to Colors.
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.waitForTimeout(900);
  await page.evaluate(() => { const el = document.getElementById("ss-step-adv-colors"); window.scrollBy(0, el.getBoundingClientRect().top - 120); });
  await page.waitForTimeout(700);
  const st = await page.evaluate(() => {
    const b = document.querySelector('[data-ss-adv="float"] button');
    const fb = [...document.querySelectorAll("button,a")].find((x) => /Feedback/.test(x.innerText || ""));
    const r = (e) => e && e.getBoundingClientRect();
    const br = r(b), pr = r(fb);
    return { stacked: document.querySelector(".ss-adv-cols").classList.contains("is-stacked"),
      endInShape: !!document.querySelector('#ss-step-adv-shape [data-ss-adv="end"]'), endInView: !!document.querySelector('[data-ss-adv="view"] [data-ss-adv="end"]'),
      btn: br && [Math.round(br.left), Math.round(br.top), Math.round(br.right), Math.round(br.bottom)], vh: innerHeight,
      clear: !!(br && pr && (br.right <= pr.left || br.bottom <= pr.top)) };
  });
  ok("6: under the dock's width the End view is at the end of Size & roof, not in the 3D column", st.stacked && st.endInShape && !st.endInView, JSON.stringify(st));
  ok("6: …and scrolled down to Colors, 'See in 3D' is on screen, clear of the Feedback pill", !!st.btn && st.btn[3] <= st.vh && st.btn[1] >= 0 && st.clear, JSON.stringify(st));
  await page.screenshot({ path: join(SHOTS, "stacked-768-colors.png") });
  await page.getByRole("button", { name: "🧊 See in 3D", exact: true }).click();
  await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length); }, null, { timeout: 90000 });
  ok("6: …and it opens the full-screen 3D", true);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(500);

  ok("no page errors on the Advanced page", errors.length === 0, errors.join(" | "));
  await ctx.close();

  // 5 ── the calibration panel keeps every field at once ──────────────────────────────────────
  {
    const { ctx: c2, page: p2, errors: e2 } = await open("/portal/settings/designer");
    await p2.waitForFunction(() => document.body.innerText.includes("3D Style Calibration"), null, { timeout: 60000 });
    await p2.getByRole("button", { name: "Harness Cabin", exact: true }).first().click().catch(() => {});
    await p2.waitForFunction(() => [...document.querySelectorAll("label")].some((l) => /^Roof type/.test(l.innerText.trim())), null, { timeout: 30000 });
    const labels = await p2.evaluate(() => [...document.querySelectorAll("body label")].filter((l) => l.offsetParent !== null).map((l) => l.innerText.trim().split("\n")[0].trim()));
    const has = (re) => labels.some((t) => re.test(t));
    ok("5: the calibration panel still shows roof, walls, lean-to, dormer, porch and colours together",
      [/^Roof type/, /^Wall height/, /^Lean-to width/, /^Dormer width/, /^Porch$/, /^Body Color/].every(has), JSON.stringify(labels));
    ok("5: …and no section tabs", await p2.locator('[data-ss-adv="sections"]').count() === 0);
    ok("5: …and none of the Advanced page's frame", await p2.locator(".ss-adv").count() === 0);
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
