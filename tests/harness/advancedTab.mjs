// THE ADVANCED PAGE (2026-09-28), driven for real on the COMPILED portal.
//
// Carolyn: "an advanced tab that is only available in Structure Studio for us yet", directly under
// Designer in the Workspace menu. Our own account is the one whose portal-billing entitlement says
// `reason: "internal"` (client_settings.internal_account); ssAdvancedOn in portal/01-core.jsx is
// the one rule, and nothing names the tenant's slug.
//
// What this proves, per scenario (one fresh browser context each, so nothing cached leaks):
//   A  OUR ACCOUNT, clicked. The item sits directly under Designer; clicking it opens the page; the
//      3D mounts beside the page's own form, in the Designer's frame (and none of the calibration's
//      own steps); Width/Length move the building; Lean-to width 8 puts ssLeanTo meshes in the scene;
//      the page stays mounted across a trip to another page; an empty name is refused without a
//      call; and Save posts create_style, then set_style_active false, then save_style_d3 with
//      the draft spec under the new key — in that order (hidden straight after it is made, review
//      2026-09-29), and nothing else is written. A saved building switches start point without
//      asking; a changed one asks first.
//   A2 OUR ACCOUNT, cold deep link to /portal/advanced with the entitlement held back 1.5 s. It
//      ENDS on the Advanced page, and the address bar never left /portal/advanced while waiting.
//   B  AN EXEMPT BUILDER (every grantable feature, view_3d included, but not internal), cold deep
//      link, entitlement held back. No Advanced item is ever drawn, the page is never drawn, the
//      topbar never says Advanced, and it ends on /portal/designer with the Designer mounted.
//   B2 A NEVER-PAID BUILDER behind the billing gate: same refusal, no item.
//   C  AN OPERATOR viewing our account (?view=), clicked: the item appears once the viewed
//      entitlement answers, the page opens, and Save carries targetClientId for the viewed tenant.
//   C2 The same operator's COLD /portal/advanced?view=<ours>: their own entitlement answers first
//      (not internal) and ?view= arms later, so the route is refused for a moment — it must still
//      END on the Advanced page.
//   C3 The same operator viewing another builder: no item.
//   D  A PHONE-WIDTH window (390 px): no sideways page scroll, the 3D is not docked (so it cannot
//      sit on top of the form), and "Preview in 3D" opens the full-screen viewer on the draft,
//      without the quote's controls (Add, Items, "Use this view in my quote").
//   Review fixes, 2026-09-29:
//   E  THE SAVE RACE. An operator saving on our account presses Back into another builder while
//      create_style is still out. All four calls (create, hide, the version read, the shape) still
//      go to OUR account — none to the builder they landed on.
//   F  STALE VIEW-AS ANSWER. From our account straight to another builder whose answer is slow:
//      the item and the page never appear for that builder while its answer is out.
//   G  BILLING FAILS. A cold /portal/advanced whose billing call errors ends on the Designer after
//      the hold's limit (shortened for the harness) — for our account and another builder — and the
//      topbar never names Advanced for the builder without it.
//   H  A MID-WIDTH WINDOW (1100 px, where the dock is on but two wrapping columns would not fit):
//      the 3D sits BESIDE the form, and scrolled down, the form is still what is under the mouse.
//   I  A TEAM MEMBER of our account (Designer access, not owner/admin): no item, and a cold
//      /portal/advanced ends on the Designer instead of a page that can only say no.
//   J  UNSAVED WORK AND ACCOUNT SWITCHES. An operator with a changed building is asked before Exit
//      or a switch throws it away (No keeps them there); after Save, Exit does not ask.
//   Review fixes, 2026-09-29 (second round):
//   A  also: the add-ons are shown one at a time (each reached through its tab, its switch turned
//      on); the end view's caption points at the number boxes and sliders, not the drawing; the success message names the
//      real control (Show); the save carries the ground's fall as two explicit nulls; and a name
//      already in use (a style's name or key, or a name saved here, trimmed and case-blind) is
//      refused before any call.
//   E  also: Back into another builder while the save is still going asks first (Yes goes).
//   K  BACK / FORWARD ACROSS A VIEW-AS SWITCH with a changed building asks first, in exitAccount's
//      words; No keeps the account, the address and the building; Yes leaves.
//   L  A SAVE THAT STOPS PART-WAY IS FINISHED, NEVER REPEATED. The hide fails: the message says the
//      style is showing to customers and how to hide it. The page is remounted by an account switch
//      and, back again, still says so. Saved again under ANOTHER name: no second create_style — the
//      same style is hidden, renamed (update_style) and shaped. A shape that fails is finished by
//      the next Save with one call.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine except the
// three.js module GETs to esm.sh, which the 3D needs). /portal/<page> is answered with
// portal.html's own bytes, as production's _redirects does. Service worker blocked.
//
//   python -m http.server 8144 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8144 SS_SHOTS=<dir> node tests/harness/advancedTab.mjs
//
// Exit 0 = every check held.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, collectErrors, shotsDir, BASE, REF, PASS_THROUGH_GET } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const SHOTS = shotsDir("advancedTab");

// Harness slugs only: the real internal tenant is never named in this repo.
const OURS = "harness-internal";
const OTHER = "harness-builder";
const OPS = "harness-ops";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000044", aud: "authenticated", role: "authenticated", email: "adv@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// What the designer instance loads (get_config). One style with a 3D look of its own, so
// "Start from → Copy of" has something to copy. Not econo/urban/northwood/farmland, which
// D3_STYLE_DEFAULTS would merge under.
const BARN_D3 = { roof: { type: "gambrel", kneeU: 0.5, kneeRise: 0.6, ridgeRise: 0.8, overhang: 0.5 }, siding: "batten", colors: { body: "#9B2F2F", trim: "#F4F1EA", roof: "#3E434A" }, wallHeightFt: 9 };
const CONFIG = {
  branding: { companyName: "Harness Internal", accentColor: "#3D3672", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  buildingStyles: [{ value: "hbarn", label: "Harness Barn", sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }], d3: BARN_D3 }],
  defaultSizes: [],
  options: [],
  layoutItems: { door: { label: "Door", icon: "D", color: "#8B4513", width: 40, height: 12, shortLabel: "D" } },
  wallHeightFt: 8,
};
const ent = (reason, extra = {}) => ({
  reason, status: "active", granted: ["view_3d"], features: { view_3d: true },
  ...(reason === "internal" || reason === "exempt" ? { exempt: true, state: "exempt" } : {}), ...extra,
});

const { ok, failed, results } = reporter();
const { browser, ctx: unused } = await launch({ width: 1440, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const settle = (page, ms) => page.waitForTimeout(ms);

// S: { own, role, operator, access, entFor: (targetClientId|null) => entitlement,
//      billingDelayMs (number, or (targetClientId|null) => ms), billingFail: (targetClientId|null) => bool,
//      createDelayMs, holdMs, viewport }
async function open(S, path) {
  const calls = [];   // { fn, action, body, at }
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport: S.viewport || { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s, holdMs]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    window.__SS3D_DEBUG = true;
    if (holdMs) window.__ssAdvancedHoldMs = holdMs;
    // Witnesses from the first render on: was the Advanced item or the Advanced page EVER drawn,
    // did the topbar ever name it, and every path the address bar showed.
    window.__advSeen = { nav: false, page: false, checking: false, title: false };
    window.__paths = [];
    const scan = () => {
      if (document.querySelector('.ss-nav a[href^="/portal/advanced"]:not(.ss-back)')) window.__advSeen.nav = true;
      const t = document.body ? document.body.innerText : "";
      if (t.includes("Every shape control on one building")) window.__advSeen.page = true;
      if (t.includes("Checking your account")) window.__advSeen.checking = true;
      const ttl = document.querySelector(".ss-topbar .ttl");
      if (ttl && /^Advanced/.test(ttl.innerText.trim())) window.__advSeen.title = true;
      const p = location.pathname;
      if (window.__paths[window.__paths.length - 1] !== p) window.__paths.push(p);
    };
    const attach = () => {
      if (!document.documentElement) { setTimeout(attach, 5); return; }
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      setInterval(scan, 20);
    };
    attach();
  }, [REF, SESSION, S.holdMs || 0]);
  const page = await ctx.newPage();
  const errors = collectErrors(page);

  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => {
    const req = route.request();
    if (req.method() === "GET" && PASS_THROUGH_GET.test(req.url())) return route.continue();
    return route.abort();
  });
  let made = 0;
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      const name = rpc[1];
      if (name === "log_error") return json(route, null);
      calls.push({ fn: "rpc", action: name, at: Date.now() - t0 });
      if (name === "get_config") return json(route, CONFIG);
      if (name === "get_fixtures") return json(route, []);
      if (name === "is_operator") return json(route, !!S.operator);
      if (name === "is_support_operator") return json(route, false);
      if (name === "can_open_projects") return json(route, false);
      return json(route, false);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: S.own, role: S.role || "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    const fn = /\/(?:functions\/v1\/)?(portal-[a-z]+|operator-portal|admin-catalog)(?:[/?]|$)/.exec(new URL(url).pathname);
    if (fn) calls.push({ fn: fn[1], action: body.action, body, at: Date.now() - t0 });
    if (url.includes("/portal-billing")) {
      const tgt = body.targetClientId || null;
      const dly = typeof S.billingDelayMs === "function" ? S.billingDelayMs(tgt) : S.billingDelayMs;
      if (dly) await new Promise((r) => setTimeout(r, dly));
      if (S.billingFail && S.billingFail(tgt)) return json(route, { error: "billing is down" }, 500);
      return json(route, { ok: true, configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, entitlement: S.entFor(tgt) });
    }
    if (url.includes("/portal-settings")) {
      const a = body.action;
      if (a === "status") {
        const cid = body.targetClientId || S.own;
        return json(route, { ok: true, clientId: cid, role: "owner", settings: { business_name: cid }, config: { company_name: cid, accent_color: "#3D3672" }, access: (!body.targetClientId && S.access) || null, prefs: null });
      }
      if (a === "catalog") return json(route, { ok: true, aiReady: true, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      if (S.failOnce && S.failOnce[a] > 0) {
        S.failOnce[a]--;
        return json(route, { error: "Something went wrong on our side." }, 500);
      }
      if (a === "create_style") {
        if (S.createDelayMs) await new Promise((r) => setTimeout(r, S.createDelayMs));
        made++;
        const key = String(body.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "style";
        return json(route, { ok: true, styleId: `00000000-0000-4000-8000-00000000a${String(made).padStart(3, "0")}`, key });
      }
      if (a === "save_style_d3") return json(route, { ok: true, updatedAt: "2026-09-29T10:00:00.000+00:00" });
      return json(route, { ok: true });
    }
    if (url.includes("/operator-portal")) {
      if (body.action === "get_portal") return json(route, { ok: true, clientId: body.clientId, companyName: body.clientId, designs: [], versions: [], capturedLeads: [] });
      return json(route, { ok: true, clients: [{ clientId: OURS, companyName: "Harness Internal" }, { clientId: OTHER, companyName: "Harness Builder" }] });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(`**/${REF}.storage.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));

  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  return { ctx, page, calls, errors };
}

const navOrder = (page) => page.evaluate(() => [...document.querySelectorAll(".ss-ws-nav .ss-nav a")].map((a) => new URL(a.href).pathname));
// The Advanced page (rebuilt in the Designer's look, 2026-09-29) shows Size & roof, Walls & foundation
// and Colors all at once, and the add-ons (Lean-to, Wings, Dormer, Porch & steps) one at a time on a tab
// strip: an add-on's controls are reached by clicking its tab, and a lean-to's by turning it on.
const sec = async (page, k) => { if (["leanto", "wings", "dormer", "porch"].includes(k)) await page.locator(`[data-ss-adv-sec="${k}"]`).click(); };
const leanBox = (page) => page.getByLabel("Lean-to width (ft)", { exact: true });
const leanSwitch = (page) => page.locator('[data-ss-adv-f="leanToOn"]');
async function leanWidth(page, v) {
  await sec(page, "leanto");
  if (await leanSwitch(page).getAttribute("aria-pressed") !== "true") await leanSwitch(page).click();
  await leanBox(page).fill(v);
  await leanBox(page).blur();
}
// Start from is the Designer's style strip: a "Blank building" tile ("") and one per style.
const startFrom = (page, v) => page.locator(`[data-ss-adv="start"] [data-ss-style="${v}"]`).click();
// Roof type is a group of picture tiles (role radio); the picked one's data-ss-adv-tile is the type.
const roofType = (page) => page.getByRole("radiogroup", { name: "Roof type", exact: true }).locator('[aria-checked="true"]').getAttribute("data-ss-adv-tile");
const seen = (page) => page.evaluate(() => ({ ...window.__advSeen, paths: window.__paths.slice() }));
const here = (page) => page.evaluate(() => location.pathname);
const writes = (calls) => calls.filter((c) => c.fn === "portal-settings" && ["create_style", "save_style_d3", "set_style_active", "update_style", "save_style_media", "save"].includes(c.action));

// The Advanced page's own docked 3D: the published panel whose canvas is inside the page's view
// column (the Designer page's dock publishes the same global).
async function advPanel(page, timeout = 90000) {
  await page.waitForFunction(() => {
    const P = window.__ss3dPanel;
    return !!(P && P.renderer && P.renderer.domElement.isConnected && P.renderer.domElement.closest('[data-ss-adv="view"]')
      && P.model && P.model.roofGroup && P.model.roofGroup.children.length > 0);
  }, null, { timeout });
}
const measure = (page) => page.evaluate(() => {
  const P = window.__ss3dPanel, M = P.model, V = P.camera.position.constructor;
  P.scene.updateMatrixWorld(true);
  const bb = (o) => {
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    o.traverse((q) => {
      if (!q.isMesh || !q.geometry) return;
      if (!q.geometry.boundingBox) q.geometry.computeBoundingBox();
      const b = q.geometry.boundingBox;
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const v = new V(x, y, z).applyMatrix4(q.matrixWorld);
        [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
      }
    });
    return { mn, mx };
  };
  let leanTo = 0;
  const ltBoxes = [];
  M.root.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssLeanTo === true) { leanTo++; ltBoxes.push(bb(q)); } });
  const ltBox = ltBoxes.length ? { mn: [0, 1, 2].map((k) => Math.min(...ltBoxes.map((b) => b.mn[k]))), mx: [0, 1, 2].map((k) => Math.max(...ltBoxes.map((b) => b.mx[k]))) } : null;
  return { leanTo, ltBox, walls: bb(M.wallsGroup), roofKids: M.roofGroup.children.length, inPage: !!P.renderer.domElement.closest('[data-ss-adv="view"]') };
});
const aim = (page, pos, target) => page.evaluate(({ pos, target }) => {
  const P = window.__ss3dPanel;
  P.camera.position.set(...pos); P.controls.target.set(...target); P.controls.update(); P.render();
}, { pos, target });

try {
  // ── A: our own account, clicked ──────────────────────────────────────────────────────────
  {
    const { ctx, page, calls, errors } = await open({ own: OURS, entFor: () => ent("internal") }, "/portal/designs");
    await page.waitForFunction(() => !!document.querySelector('.ss-nav a[href^="/portal/advanced"]'), null, { timeout: 20000 }).catch(() => {});
    const order = await navOrder(page);
    const iD = order.indexOf("/portal/designer"), iA = order.indexOf("/portal/advanced");
    ok("A: the Advanced item is drawn for our own account", iA >= 0, order.join(" "));
    ok("A: …directly under Designer", iD >= 0 && iA === iD + 1, `designer #${iD}, advanced #${iA}`);
    ok("A: …with its layers glyph", await page.locator('.ss-nav a[href^="/portal/advanced"] svg').count() === 1);
    await page.locator("aside.ss-side").screenshot({ path: join(SHOTS, "advpage-sidebar.png") });

    await page.locator('.ss-nav a[href^="/portal/advanced"]').click();
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 });
    ok("A: clicking it opens the Advanced page at /portal/advanced", (await here(page)) === "/portal/advanced", await here(page));
    ok("A: the topbar names the page", (await page.locator(".ss-topbar .ttl").innerText()).startsWith("Advanced"));
    await advPanel(page);
    const m0 = await measure(page);
    ok("A: the 3D mounts beside the form, on a blank building", m0.inPage && m0.roofKids > 0 && m0.leanTo === 0, JSON.stringify({ roofKids: m0.roofKids, leanTo: m0.leanTo }));
    ok("A: the blank building is 12 ft wide and 16 ft long", Math.abs((m0.walls.mx[0] - m0.walls.mn[0]) - 12) < 0.8 && Math.abs((m0.walls.mx[2] - m0.walls.mn[2]) - 16) < 0.8,
      `${(m0.walls.mx[0] - m0.walls.mn[0]).toFixed(2)} x ${(m0.walls.mx[2] - m0.walls.mn[2]).toFixed(2)}`);
    // One section at a time since 2026-09-29: each section's own fields, reached through its tab.
    // advancedSections.mjs holds every tab to its own fields and none of another's.
    const grid = {
      frame: await page.locator('[data-ss-adv="fields"]').evaluate((el) => !!el.closest(".ssd-frame")),
      roof: await page.getByRole("radiogroup", { name: "Roof type", exact: true }).count() === 1,
      walls: await page.getByLabel("Wall height (ft)", { exact: true }).count() === 1 && await page.getByRole("radiogroup", { name: "What it stands on", exact: true }).count() === 1,
      colors: /Body color/i.test(await page.locator('[data-ss-adv="fields"]').innerText()),
    };
    await sec(page, "leanto");
    grid.leanto = await leanSwitch(page).count() === 1;
    await sec(page, "porch");
    grid.porch = await page.getByRole("radiogroup", { name: "Porch", exact: true }).count() === 1;
    await sec(page, "leanto");
    ok("A: the form is there, in the Designer's frame: roof, walls, colors, and the lean-to and porch tabs", Object.values(grid).every(Boolean), JSON.stringify(grid));
    ok("A: …and none of calibration's own steps (style strip, video, photos, scan, Save 3D look)",
      !/3D Style Calibration|Walk-around video|Photos of the same building|Scan of a real building|Save 3D look|Save to config/.test(await page.locator(".ss-body").innerText()));
    ok("A: the end view sits beside the 3D, not inside the form", await page.locator('[data-ss-adv="view"] svg').count() >= 1 && await page.locator('[data-ss-adv="fields"] svg[viewBox="0 0 360 210"]').count() === 0);
    // The drawing has no click handler: only a number box lights a measurement (review UX6).
    const cap = await page.locator('[data-ss-adv="view"]').innerText();
    // One line since the review of 2026-09-29: the size is the card's header (12 × 16 ft), not the caption.
    ok("A: the end view's caption points at the sliders and number boxes, not at the drawing, under a header with the size",
      /Move a slider or click a box: its measurement lights up here\./.test(cap) && /END VIEW|End view/.test(cap) && /12 × 16 ft/.test(cap) && !/Click a number and/.test(cap),
      cap.split("\n").filter((l) => /End view|END VIEW|lights up/.test(l)).join(" "));

    // Width / Length move the building.
    const w = page.getByLabel("Width (ft)", { exact: true }), l = page.getByLabel("Length (ft)", { exact: true });
    await w.fill("16"); await l.fill("24"); await l.blur();
    await page.waitForFunction(() => { const P = window.__ss3dPanel; return !!(P && P.renderer.domElement.isConnected && P.model && P.model.roofGroup.children.length); }, null, { timeout: 60000 });
    await settle(page, 1500);
    await advPanel(page);
    const m1 = await measure(page);
    ok("A: Width 16 and Length 24 make a 16 x 24 building", Math.abs((m1.walls.mx[0] - m1.walls.mn[0]) - 16) < 0.8 && Math.abs((m1.walls.mx[2] - m1.walls.mn[2]) - 24) < 0.8,
      `${(m1.walls.mx[0] - m1.walls.mn[0]).toFixed(2)} x ${(m1.walls.mx[2] - m1.walls.mn[2]).toFixed(2)}`);
    await w.fill("3");
    ok("A: a width out of 6..60 is flagged in plain words and not used", await page.getByText("Width and length are whole feet, from 6 to 60.").isVisible());
    await w.blur();
    ok("A: …and leaving the box puts the size in use back", (await w.inputValue()) === "16", await w.inputValue());

    // Lean-to width 8 → ssLeanTo meshes.
    await sec(page, "leanto");
    await leanSwitch(page).click();
    const lean = leanBox(page);
    await lean.fill("8");
    await page.waitForFunction(() => { let n = 0; window.__ss3dPanel.model.root.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssLeanTo === true) n++; }); return n > 0; }, null, { timeout: 30000 }).catch(() => {});
    const m2 = await measure(page);
    ok("A: Lean-to width 8 puts a lean-to in the 3D (ssLeanTo meshes)", m2.leanTo > 0, `${m2.leanTo} meshes`);
    ok("A: …on the side the panel says (Right eave = +x, outside the 16 ft wall)", !!m2.ltBox && m2.ltBox.mn[0] >= 8 - 0.5 && m2.ltBox.mx[0] <= 8 + 8 + 1.5, JSON.stringify(m2.ltBox && [m2.ltBox.mn[0].toFixed(2), m2.ltBox.mx[0].toFixed(2)]));
    await lean.blur();
    // Aimed at the lean-to's side, far enough back to frame the whole building.
    const sx = m2.ltBox && (m2.ltBox.mn[0] + m2.ltBox.mx[0]) / 2 < 0 ? -1 : 1;
    await aim(page, [sx * 42, 17, 36], [sx * 4, 2.5, 0]);
    await settle(page, 500);
    await page.screenshot({ path: join(SHOTS, "advpage-page-leanto.png"), fullPage: true });

    // Kept mounted: another page and back keeps the building.
    await page.locator('.ss-nav a[href^="/portal/designs"]').click();
    await settle(page, 800);
    ok("A: another page hides it", !(await page.getByText("Every shape control on one building").first().isVisible()));
    await page.locator('.ss-nav a[href^="/portal/advanced"]').click();
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 20000 });
    ok("A: coming back finds the same building (lean-to 8, 16 x 24)", (await lean.inputValue()) === "8" && (await w.inputValue()) === "16" && (await l.inputValue()) === "24",
      `${await lean.inputValue()} / ${await w.inputValue()} x ${await l.inputValue()}`);

    // Save: an empty name is refused with no call.
    const before = writes(calls).length;
    await page.getByRole("button", { name: "Save as a new style" }).click();
    await settle(page, 400);
    ok("A: an empty name is refused, in words, with no call", (await page.locator('[data-ss-adv="msg"]').innerText()).includes("Give the new style a name first") && writes(calls).length === before);
    await page.getByLabel("New style name").fill("Harness Custom Barn");
    await page.getByRole("button", { name: "Save as a new style" }).click();
    await page.waitForFunction(() => { const m = document.querySelector('[data-ss-adv="msg"]'); return m && /Saved as|failed|Couldn|isn't/.test(m.innerText); }, null, { timeout: 60000 });
    const msg = await page.locator('[data-ss-adv="msg"]').innerText();
    // Settings → Structures has no switch: a hidden style there has a Show button (review UX10).
    ok("A: Save says where the style went, in plain words, naming the real button (Show)", msg === "Saved as “Harness Custom Barn”. Hidden from customers — add its sizes and prices in Settings → Structures, then press Show.", msg);
    const W3 = writes(calls);
    const seq = W3.map((c) => c.action);
    // Hidden straight after it is made (review 2026-09-29): create_style makes a style visible,
    // so the hide goes before the shape, and a shopper's window is one round trip.
    ok("A: Save posts create_style, then set_style_active, then save_style_d3 — in that order, and nothing else", JSON.stringify(seq) === JSON.stringify(["create_style", "set_style_active", "save_style_d3"]), seq.join(" → "));
    const [cs, sa, sd] = W3;
    ok("A: create_style carries the typed name, for our own tenant (targetClientId null)", cs && cs.body.label === "Harness Custom Barn" && cs.body.targetClientId === null, cs && JSON.stringify(cs.body));
    ok("A: save_style_d3 goes to the NEW style's key", sd && sd.body.styleValue === "harness-custom-barn", sd && sd.body.styleValue);
    const d3 = sd && sd.body.d3;
    ok("A: …with the draft on screen: a gable, lean-to 8, 8 ft walls, the new frame",
      d3 && d3.roof && d3.roof.type === "gable" && d3.roof.leanToWidthFt === 8 && d3.wallHeightFt === 8 && sd.body.frame === "front", d3 && JSON.stringify(d3.roof));
    ok("A: …and no photos or video frames are claimed", sd && Array.isArray(sd.body.d3Photos) && sd.body.d3Photos.length === 0 && !("d3VideoFrames" in sd.body));
    // Review BC-1: the server carries a stored fall over any save that OMITS it, so this panel says
    // "no fall" out loud. The sanitiser drops the null; nothing stores it.
    ok("A: …and the ground's fall goes as two explicit nulls (level ground, said out loud)",
      d3 && Object.prototype.hasOwnProperty.call(d3, "gradeFallFt") && d3.gradeFallFt === null && Object.prototype.hasOwnProperty.call(d3, "gradeFallToward") && d3.gradeFallToward === null,
      d3 && JSON.stringify({ f: d3.gradeFallFt, t: d3.gradeFallToward }));
    ok("A: set_style_active hides that same new style", sa && sa.body.styleId === "00000000-0000-4000-8000-00000000a001" && sa.body.active === false && sa.body.targetClientId === null, sa && JSON.stringify(sa.body));
    ok("A: the name box is cleared for the next one", (await page.getByLabel("New style name").inputValue()) === "");
    // A name already in use is refused before any call (review ADV-2): the pricing import rejects a
    // row two styles answer to. A style in the config by its name or its key, and a name saved here,
    // trimmed and case-blind.
    for (const taken of ["  harness custom BARN ", "Harness Barn", "HBARN"]) {
      const n0 = writes(calls).length;
      await page.getByLabel("New style name").fill(taken);
      await page.getByRole("button", { name: "Save as a new style" }).click();
      await settle(page, 400);
      const m = await page.locator('[data-ss-adv="msg"]').innerText();
      ok(`A: "${taken}" is refused as a name already in use, in words, with no call`,
        m === `There's already a style called “${taken.trim()}”. Give this one a different name.` && writes(calls).length === n0, m);
      if (taken === "Harness Barn") await page.locator('[data-ss-adv="save"]').screenshot({ path: join(SHOTS, "advpage-name-in-use.png") }).catch(() => {});
    }
    await page.getByLabel("New style name").fill("");

    // Start from a copy of a style: seeded from its look. The building on screen was just saved,
    // so nothing is lost and nothing is asked.
    let asked = null;
    const onDialog = (d) => { asked = d.message(); d.accept(); };
    page.on("dialog", onDialog);
    await startFrom(page, "hbarn");
    await settle(page, 1500);
    ok("A: right after a save, switching the start point does not ask (nothing is unsaved)", asked === null, String(asked));
    ok("A: …and the Harness Barn tile is the one picked", await page.locator('[data-ss-adv="start"] [data-ss-style="hbarn"]').getAttribute("aria-pressed") === "true");
    const wall = await page.getByLabel("Wall height (ft)", { exact: true }).inputValue();
    await sec(page, "leanto");
    const ltv = await leanSwitch(page).getAttribute("aria-pressed");
    const tv = await roofType(page);
    ok("A: Copy of Harness Barn seeds that style's roof (gambrel), wall (9) and no lean-to", tv === "gambrel" && wall === "9" && ltv === "false", `${tv} / wall ${wall} / lean-to on ${ltv}`);
    await advPanel(page);
    await page.waitForFunction(() => { let n = 0; window.__ss3dPanel.model.root.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssLeanTo === true) n++; }); return n === 0; }, null, { timeout: 20000 }).catch(() => {});
    ok("A: …and the 3D follows (no lean-to left)", (await measure(page)).leanTo === 0);
    // A change, then a new start point: asked first.
    await leanWidth(page, "4");
    await startFrom(page, "");
    await settle(page, 1000);
    ok("A: after a change, switching the start point asks before throwing work away", asked === "Start again? The changes you made to this building will be lost.", String(asked));
    ok("A: …and Blank building is a gable again", (await roofType(page)) === "gable", await roofType(page));
    page.off("dialog", onDialog);
    ok("A: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── A2: our own account, COLD /portal/advanced, entitlement held back ──────────────────────
  {
    const { ctx, page, errors } = await open({ own: OURS, entFor: () => ent("internal"), billingDelayMs: 1500 }, "/portal/advanced");
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
    await advPanel(page).catch(() => {});
    await settle(page, 1200);
    const s = await seen(page);
    ok("A2: a cold /portal/advanced ENDS on the Advanced page", (await here(page)) === "/portal/advanced" && await page.getByText("Every shape control on one building").first().isVisible(), await here(page));
    ok("A2: …after saying it was checking, not bouncing", s.checking && !s.paths.includes("/portal/designer"), s.paths.join(" → "));
    ok("A2: …with the 3D up", await page.evaluate(() => !!(window.__ss3dPanel && window.__ss3dPanel.renderer.domElement.closest('[data-ss-adv="view"]'))));
    await aim(page, [20, 12, 24], [0, 3.5, 0]).catch(() => {});
    await settle(page, 400);
    await page.screenshot({ path: join(SHOTS, "advpage-cold-deeplink.png") });
    ok("A2: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── B / B2: builders without it ─────────────────────────────────────────────────────────
  for (const [tag, e] of [["B (exempt)", ent("exempt")], ["B2 (never paid, locked)", ent("never_paid", { exempt: false, state: "never_paid", locked: true, granted: [], features: {} })]]) {
    const { ctx, page, calls, errors } = await open({ own: OTHER, entFor: () => e, billingDelayMs: 1200 }, "/portal/advanced");
    await settle(page, 3500);
    const s = await seen(page);
    ok(`${tag}: the Advanced item is never drawn`, !s.nav);
    ok(`${tag}: the Advanced page is never drawn`, !s.page);
    ok(`${tag}: the topbar never names Advanced, not even while the route is held`, !s.title);
    ok(`${tag}: a cold /portal/advanced ends on /portal/designer`, (await here(page)) === "/portal/designer", s.paths.join(" → "));
    if (!e.locked) {
      await page.locator(".ss-designer-host").waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
      ok(`${tag}: …with the Designer actually mounted and showing (not a blank page)`, await page.locator(".ss-designer-host").isVisible());
      ok(`${tag}: …and the topbar says Designer`, (await page.locator(".ss-topbar .ttl").innerText()).startsWith("Designer"));
    }
    ok(`${tag}: nothing was written`, writes(calls).length === 0);
    ok(`${tag}: no page errors`, errors.length === 0, errors.join(" | "));
    if (tag.startsWith("B ")) await page.locator("aside.ss-side").screenshot({ path: join(SHOTS, "advpage-sidebar-other-builder.png") });
    await ctx.close();
  }

  // ── C: an operator viewing our account ─────────────────────────────────────────────────
  {
    const entFor = (t) => (t === OURS ? ent("internal") : ent("exempt"));
    const { ctx, page, calls, errors } = await open({ own: OPS, operator: true, entFor }, `/portal/designs?view=${OURS}`);
    await page.waitForFunction(() => !!document.querySelector('.ss-nav a[href^="/portal/advanced"]'), null, { timeout: 30000 }).catch(() => {});
    const order = await navOrder(page);
    ok("C: viewing our account, the item is there, under Designer", order.indexOf("/portal/advanced") === order.indexOf("/portal/designer") + 1 && order.indexOf("/portal/advanced") > 0, order.join(" "));
    await page.locator('.ss-nav a[href^="/portal/advanced"]').click();
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 });
    await advPanel(page);
    ok("C: the page opens, with the 3D, and keeps ?view=", (await page.evaluate(() => location.pathname + location.search)) === `/portal/advanced?view=${OURS}`);
    await page.getByLabel("New style name").fill("Viewed Style");
    await page.getByRole("button", { name: "Save as a new style" }).click();
    await page.waitForFunction(() => { const m = document.querySelector('[data-ss-adv="msg"]'); return m && m.innerText.length > 0; }, null, { timeout: 60000 });
    const W3 = writes(calls);
    ok("C: all three saves carry the VIEWED tenant", W3.length === 3 && W3.every((c) => c.body.targetClientId === OURS), W3.map((c) => `${c.action}:${c.body.targetClientId}`).join(" "));
    ok("C: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  {
    const entFor = (t) => (t === OURS ? ent("internal") : ent("exempt"));
    const { ctx, page, errors } = await open({ own: OPS, operator: true, entFor }, `/portal/advanced?view=${OURS}`);
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
    await settle(page, 1500);
    const s = await seen(page);
    ok("C2: an operator's cold /portal/advanced?view=<ours> ends on the Advanced page", (await here(page)) === "/portal/advanced" && await page.getByText("Every shape control on one building").first().isVisible(), s.paths.join(" → "));
    ok("C2: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  {
    const entFor = (t) => (t === OURS ? ent("internal") : ent("exempt"));
    const { ctx, page, errors } = await open({ own: OPS, operator: true, entFor }, `/portal/designs?view=${OTHER}`);
    await settle(page, 3000);
    const s = await seen(page);
    ok("C3: viewing another builder, no Advanced item", !s.nav);
    ok("C3: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // ── D: phone width ────────────────────────────────────────────────────────────────────
  {
    const { ctx, page, errors } = await open({ own: OURS, entFor: () => ent("internal"), viewport: { width: 390, height: 844 } }, "/portal/advanced");
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 });
    await settle(page, 1200);
    const wide = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    ok("D: no sideways page scroll at 390 px", wide.sw <= wide.cw + 1, `${wide.sw} vs ${wide.cw}`);
    ok("D: the 3D is not docked beside (or on top of) the form", await page.evaluate(() => !(window.__ss3dPanel && window.__ss3dPanel.renderer.domElement.isConnected)));
    ok("D: the view column is not sticky", await page.locator('[data-ss-adv="view"]').evaluate((el) => getComputedStyle(el).position !== "sticky"));
    await leanWidth(page, "6");
    await page.getByRole("button", { name: /Preview in 3D/ }).click();
    await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length); }, null, { timeout: 90000 });
    await settle(page, 1200);
    const lt = await page.evaluate(() => { let n = 0; window.__ss3dEngine.model.root.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssLeanTo === true) n++; }); return n; });
    ok("D: Preview in 3D opens the full-screen viewer on the draft (lean-to 6 is in it)", lt > 0, `${lt} lean-to meshes`);
    // A style draft is not a quote (review 2026-09-29): no Add row, no Items, no "Use this view
    // in my quote". The viewer's own view controls stay.
    // Read inside the viewer only: its fixed overlay, found from its own canvas.
    const vw = await page.evaluate(() => {
      let el = window.__ss3dEngine.renderer.domElement;
      while (el && el !== document.body && getComputedStyle(el).position !== "fixed") el = el.parentElement;
      const root = el || document.body;
      return { text: root.innerText, addLabel: [...root.querySelectorAll("span")].some((s) => s.textContent === "Add") };
    });
    ok("D: …without the quote's controls (Add, Items, Use this view in my quote)",
      !/Use this view in my quote/.test(vw.text) && !/Items/.test(vw.text) && !vw.addLabel && /Views/.test(vw.text) && /Look inside/.test(vw.text),
      vw.text.split("\n").filter((l) => /Items|quote|Add|Views|Look inside/i.test(l)).join(" | ").slice(0, 200));
    await page.screenshot({ path: join(SHOTS, "advpage-phone-preview.png") });
    ok("D: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── E: the save race — Back into another builder while create_style is out ────────────────
  {
    const entFor = (t) => (t === OURS ? ent("internal") : ent("exempt"));
    const { ctx, page, calls, errors } = await open({ own: OPS, operator: true, entFor, createDelayMs: 2500 }, `/portal/advanced?view=${OURS}`);
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 });
    await settle(page, 1000);
    // History: another builder's Pipeline, then this page again — so Back lands in that builder.
    await page.evaluate(([o, u]) => { history.pushState({}, "", "/portal/designs?view=" + o); history.pushState({}, "", "/portal/advanced?view=" + u); }, [OTHER, OURS]);
    const from = calls.length;
    const eAsked = [];
    page.on("dialog", (d) => { eAsked.push(d.message()); d.accept(); });
    await page.getByLabel("New style name").fill("Race Style");
    await page.getByRole("button", { name: "Save as a new style" }).click();
    await settle(page, 600);
    await page.evaluate(() => history.back());
    for (let i = 0; i < 80 && writes(calls.slice(from)).length < 3; i++) await settle(page, 250);
    await settle(page, 800);
    const W = writes(calls.slice(from));
    const landed = await page.evaluate(() => location.pathname + location.search);
    ok("E: Back into another builder mid-save asks first — a save still going is unsaved work (review ADV-3)",
      eAsked.length === 1 && eAsked[0] === "Opening another account will discard the building you haven't saved on the Advanced page. Continue?", JSON.stringify(eAsked));
    ok("E: …and on Yes, Back really did land in the other builder mid-save", landed === `/portal/designs?view=${OTHER}`, landed);
    ok("E: create, hide and shape ALL went to our account — none to the builder on screen",
      W.length === 3 && W.every((c) => c.body.targetClientId === OURS), W.map((c) => `${c.action}:${c.body.targetClientId}`).join(" "));
    ok("E: …in the order create → hide → shape, on the style that was made",
      W.map((c) => c.action).join(",") === "create_style,set_style_active,save_style_d3" && W[1].body.active === false && W[2].body.styleValue === "race-style",
      W.map((c) => c.action).join(","));
    const hideAt = W[1] ? W[1].at : Infinity, shapeAt = W[2] ? W[2].at : -Infinity;
    const versionRead = calls.slice(from).filter((c) => c.fn === "portal-settings" && c.action === "catalog" && c.at >= hideAt && c.at <= shapeAt);
    ok("E: the style's version read before the shape went to our account too",
      versionRead.length >= 1 && versionRead.every((c) => c.body.targetClientId === OURS), versionRead.map((c) => c.body.targetClientId).join(" "));
    ok("E: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── F: straight from our account to another builder whose answer is slow ──────────────────
  {
    const entFor = (t) => (t === OURS ? ent("internal") : ent("exempt"));
    const { ctx, page, errors } = await open({ own: OPS, operator: true, entFor, billingDelayMs: (t) => (t === OTHER ? 2500 : 0) }, `/portal/designs?view=${OURS}`);
    await page.waitForFunction(() => !!document.querySelector('.ss-nav a[href^="/portal/advanced"]'), null, { timeout: 30000 });
    await page.locator('.ss-nav a[href^="/portal/advanced"]').click();
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 });
    await page.locator('.ss-nav a[href^="/portal/designs"]').click();
    await settle(page, 500);
    await page.evaluate(([o, u]) => { history.pushState({}, "", "/portal/designs?view=" + o); history.pushState({}, "", "/portal/designs?view=" + u); }, [OTHER, OURS]);
    await page.evaluate(() => history.back());
    const samples = [];
    for (let k = 0; k < 14; k++) {
      await settle(page, 250);
      samples.push(await page.evaluate(() => ({ url: location.pathname + location.search, nav: !!document.querySelector('.ss-nav a[href^="/portal/advanced"]'), hosts: document.querySelectorAll('[data-ss-adv="bar"]').length })));
    }
    const there = samples.filter((s) => s.url.endsWith(`view=${OTHER}`));
    const bad = there.filter((s) => s.nav || s.hosts > 0);
    ok("F: in the other builder, the item and the page never appear — not even while its answer is out",
      there.length === samples.length && bad.length === 0, `${there.length}/${samples.length} samples there; bad: ${JSON.stringify(bad.slice(0, 2))}`);
    await page.evaluate(() => history.forward());
    await page.waitForFunction(() => !!document.querySelector('.ss-nav a[href^="/portal/advanced"]'), null, { timeout: 20000 }).catch(() => {});
    ok("F: back in our account, it is there again", await page.locator('.ss-nav a[href^="/portal/advanced"]').count() === 1);
    ok("F: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── G: the billing call fails — the hold has a limit ─────────────────────────────────────
  for (const [tag, own, e] of [["G (our account)", OURS, ent("internal")], ["G2 (another builder)", OTHER, ent("exempt")]]) {
    const { ctx, page, errors } = await open({ own, entFor: () => e, billingFail: () => true, holdMs: 2500 }, "/portal/advanced");
    await settle(page, 1000);
    const mid = { path: await here(page), body: await page.locator(".ss-body").innerText(), title: (await page.locator(".ss-topbar .ttl").innerText()).trim() };
    ok(`${tag}: while held, the page says it is checking and the topbar does not name Advanced`,
      mid.path === "/portal/advanced" && mid.body.includes("Checking your account") && !/^Advanced/.test(mid.title), JSON.stringify({ path: mid.path, title: mid.title.slice(0, 40) }));
    await page.waitForFunction(() => location.pathname === "/portal/designer", null, { timeout: 15000 }).catch(() => {});
    await page.locator(".ss-designer-host").waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    const s = await seen(page);
    ok(`${tag}: a failed billing call ends on the Designer after the hold's limit (not "Checking…" for ever)`,
      (await here(page)) === "/portal/designer" && await page.locator(".ss-designer-host").isVisible() && !(await page.locator(".ss-body").innerText()).includes("Checking your account"), s.paths.join(" → "));
    ok(`${tag}: no item, no page, and the topbar never said Advanced`, !s.nav && !s.page && !s.title, JSON.stringify(s));
    ok(`${tag}: no page errors`, errors.length === 0, errors.join(" | "));
    if (tag.startsWith("G2")) await page.screenshot({ path: join(SHOTS, "advpage-billing-failed-other.png") });
    await ctx.close();
  }

  // ── H: 1100 px — the dock is on, but two wrapping columns would not fit ─────────────────────
  {
    const { ctx, page, errors } = await open({ own: OURS, entFor: () => ent("internal"), viewport: { width: 1100, height: 800 } }, "/portal/advanced");
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 });
    await advPanel(page);
    await settle(page, 1200);
    const g = await page.evaluate(() => {
      const v = document.querySelector('[data-ss-adv="view"]'), f = document.querySelector('[data-ss-adv="fields"]');
      const vr = v.getBoundingClientRect(), fr = f.getBoundingClientRect();
      return { rowW: v.parentElement.clientWidth, pos: getComputedStyle(v).position, v: [vr.left, vr.right, vr.top], f: [fr.left, fr.right, fr.top], sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
    });
    ok("H: at 1100 px the row is in the band that used to wrap (dock on, under ~872 px), and the 3D is docked",
      g.rowW >= 720 && g.rowW < 872 && g.pos === "sticky", JSON.stringify({ rowW: g.rowW, pos: g.pos }));
    ok("H: …BESIDE the form (to its right, same top), not above it", g.v[0] >= g.f[1] - 1 && Math.abs(g.v[2] - g.f[2]) < 2, JSON.stringify({ v: g.v.map(Math.round), f: g.f.map(Math.round) }));
    ok("H: no sideways page scroll", g.sw <= g.cw + 1, `${g.sw} vs ${g.cw}`);
    await leanWidth(page, "8");
    // Scrolled down the WINDOW (the page scrolls under the portal's topbar) until the Lean-to width
    // field sits mid-screen.
    await page.evaluate(() => {
      const f = document.querySelector('[data-ss-adv-f="leanToWidthFt"]');
      window.scrollBy(0, f.getBoundingClientRect().top - 400);
    });
    await settle(page, 800);
    const hit = await page.evaluate(() => {
      const card = document.querySelector('[data-ss-adv="view"] .ss-adv-3d').getBoundingClientRect();
      const bar = document.querySelector(".ss-adv .ssd-progress").getBoundingClientRect();
      const lr = document.querySelector('[data-ss-adv-f="leanToWidthFt"]').getBoundingClientRect();
      const el = document.elementFromPoint(lr.left + 20, lr.top + lr.height / 2);
      return { card3dTop: Math.round(card.top), barBottom: Math.round(bar.bottom), fieldY: Math.round(lr.top), scrolled: Math.round(window.scrollY), formUnder: !!(el && el.closest('[data-ss-adv="fields"]')) };
    });
    ok("H: scrolled down, the form is what is under the mouse at its Lean-to field (the 3D does not cover it)", hit.formUnder && hit.scrolled > 300, JSON.stringify(hit));
    ok("H: …and the 3D has stayed in view beside it, just under the sticky progress bar", hit.card3dTop >= hit.barBottom && hit.card3dTop <= hit.barBottom + 24, JSON.stringify(hit));
    await aim(page, [40, 19, 38], [4, 2.5, 0]).catch(() => {});
    await settle(page, 400);
    await page.screenshot({ path: join(SHOTS, "advpage-1100-scrolled-after.png") });
    ok("H: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── I: a team member of our own account ─────────────────────────────────────────────────
  {
    const { ctx, page, calls, errors } = await open({ own: OURS, role: "user", access: { designer: "edit", designs: "view" }, entFor: () => ent("internal"), billingDelayMs: 800, holdMs: 3000 }, "/portal/advanced");
    await page.waitForFunction(() => location.pathname === "/portal/designer", null, { timeout: 15000 }).catch(() => {});
    await settle(page, 1500);
    const s = await seen(page);
    ok("I: a team member (Designer access, not owner/admin) has the Designer item", await page.locator('.ss-nav a[href^="/portal/designer"]').count() === 1);
    ok("I: …but no Advanced item, and the page is never drawn", !s.nav && !s.page, JSON.stringify(s));
    ok("I: a cold /portal/advanced ends on /portal/designer", (await here(page)) === "/portal/designer", s.paths.join(" → "));
    ok("I: nothing was written", writes(calls).length === 0);
    ok("I: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── J: unsaved work and account switches ───────────────────────────────────────────────
  {
    const entFor = (t) => (t === OURS ? ent("internal") : ent("exempt"));
    const { ctx, page, errors } = await open({ own: OPS, operator: true, entFor }, `/portal/advanced?view=${OURS}`);
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 });
    await settle(page, 1000);
    const dialogs = [];
    page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
    await leanWidth(page, "6");
    await settle(page, 400);
    await page.locator(".ss-topbar button", { hasText: "Exit" }).click();
    await settle(page, 600);
    const where = () => page.evaluate(() => location.pathname + location.search);
    ok("J: Exit with a changed building asks first, naming the Advanced page",
      dialogs[0] === "Leaving this account will discard the building you haven't saved on the Advanced page. Continue?", String(dialogs[0]));
    ok("J: …and No keeps you in the account with the building", (await where()) === `/portal/advanced?view=${OURS}` && (await leanBox(page).inputValue()) === "6", await where());
    await page.locator(".ss-switch").click();
    await page.locator('.ss-switch-menu button[role="option"]', { hasText: "Harness Builder" }).click();
    await settle(page, 600);
    ok("J: switching account asks too, naming the Advanced page", !!dialogs[1] && dialogs[1].startsWith("Opening another account will discard") && dialogs[1].includes("the building you haven't saved on the Advanced page"), String(dialogs[1]));
    ok("J: …and No keeps you there", (await where()) === `/portal/advanced?view=${OURS}`, await where());
    await page.getByLabel("New style name").fill("J Style");
    await page.getByRole("button", { name: "Save as a new style" }).click();
    await page.waitForFunction(() => /Saved as/.test((document.querySelector('[data-ss-adv="msg"]') || {}).innerText || ""), null, { timeout: 60000 });
    await settle(page, 300);
    const n = dialogs.length;
    await page.locator(".ss-topbar button", { hasText: "Exit" }).click();
    await settle(page, 1000);
    ok("J: after Save, Exit does not ask (nothing unsaved) and leaves", dialogs.length === n && (await here(page)) === "/portal/accounts", `${dialogs.length - n} new dialogs; at ${await here(page)}`);
    ok("J: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── K: Back / Forward across a view-as switch with a changed building (review ADV-3) ───────────
  {
    const entFor = (t) => (t === OURS ? ent("internal") : ent("exempt"));
    const { ctx, page, errors } = await open({ own: OPS, operator: true, entFor }, "/portal/designer");
    const dialogs = [];
    let answer = true;
    page.on("dialog", (d) => { dialogs.push(d.message()); if (answer) d.accept(); else d.dismiss(); });
    const where = () => page.evaluate(() => location.pathname + location.search);
    await settle(page, 1500);
    await page.locator('.ss-nav a[href^="/portal/designs"]').first().click();
    await settle(page, 800);
    await page.locator(".ss-switch").click();
    await page.locator('.ss-switch-menu button[role="option"]', { hasText: "Harness Internal" }).click();
    await page.waitForFunction(() => !!document.querySelector('.ss-nav a[href^="/portal/advanced"]'), null, { timeout: 30000 });
    await page.locator('.ss-nav a[href^="/portal/advanced"]').first().click();
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 });
    await leanWidth(page, "6");
    await settle(page, 400);
    const n0 = dialogs.length;
    await page.goBack();
    await settle(page, 800);
    ok("K: Back inside the viewed account (Advanced → Designs) does not ask", dialogs.length === n0 && (await where()) === `/portal/designs?view=${OURS}`, `${await where()}; ${dialogs.length - n0} dialogs`);
    answer = false;
    await page.goBack();
    await settle(page, 1200);
    ok("K: Back out of the viewed account with a changed building asks first, in Exit's words",
      dialogs.length === n0 + 1 && dialogs[n0] === "Leaving this account will discard the building you haven't saved on the Advanced page. Continue?", JSON.stringify(dialogs.slice(n0)));
    ok("K: …and No keeps the account and puts the address back", (await where()) === `/portal/designs?view=${OURS}`, await where());
    await page.locator('.ss-nav a[href^="/portal/advanced"]').first().click();
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 20000 });
    ok("K: …with the building still there (lean-to 6)", (await leanBox(page).inputValue()) === "6", await leanBox(page).inputValue());
    await page.screenshot({ path: join(SHOTS, "advpage-back-said-no.png") });
    answer = true;
    await page.goBack();
    await settle(page, 800);
    await page.goBack();
    await settle(page, 1500);
    ok("K: asked again, Yes leaves the account", dialogs.length === n0 + 2 && (await where()) === "/portal/designer", `${await where()}; ${JSON.stringify(dialogs.slice(n0))}`);
    ok("K: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── L: a Save that stops part-way is finished, never repeated (review ADV-1) ──────────────────
  {
    const entFor = (t) => (t === OURS ? ent("internal") : ent("exempt"));
    // A long entitlement hold (review 2026-09-29): under load the default 8 s could run out, the cold
    // /portal/advanced fell back to the Designer, and the account switch then asked to discard a design.
    const S = { own: OPS, operator: true, entFor, failOnce: { set_style_active: 1 }, holdMs: 60000 };
    const { ctx, page, calls, errors } = await open(S, `/portal/advanced?view=${OURS}`);
    const dialogs = [];
    page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 });
    await settle(page, 800);
    const msgIs = (re) => page.waitForFunction((src) => new RegExp(src).test((document.querySelector('[data-ss-adv="msg"]') || {}).innerText || ""), re.source, { timeout: 60000 });
    const save = async (name) => {
      await page.getByLabel("New style name").fill(name);
      await page.getByRole("button", { name: "Save as a new style" }).click();
    };
    // 1. The hide fails: the style is showing, and the message says so and how to hide it.
    let from = calls.length;
    await save("Tri Home");
    await msgIs(/customers can see it now|Saved as/);
    let msg = await page.locator('[data-ss-adv="msg"]').innerText();
    ok("L: a hide that fails says the style is showing to customers, and how to hide it",
      msg === "“Tri Home” was made, but hiding it didn't work, so customers can see it now. Press Save again to hide it and finish it, or hide it yourself: Settings → Structures → Hide. (Something went wrong on our side.)", msg);
    ok("L: …after one create and the failed hide", writes(calls.slice(from)).map((c) => c.action).join(",") === "create_style,set_style_active", writes(calls.slice(from)).map((c) => c.action).join(","));
    await page.locator('[data-ss-adv="save"]').screenshot({ path: join(SHOTS, "advpage-hide-failed.png") }).catch(() => {});
    // 2. An account switch remounts the page; back again, it still knows.
    await page.locator(".ss-switch").click();
    await page.locator('.ss-switch-menu button[role="option"]', { hasText: "Harness Builder" }).click();
    await settle(page, 1500);
    await page.locator(".ss-switch").click();
    await page.locator('.ss-switch-menu button[role="option"]', { hasText: "Harness Internal" }).click();
    await page.waitForFunction(() => !!document.querySelector('.ss-nav a[href^="/portal/advanced"]'), null, { timeout: 30000 });
    await page.locator('.ss-nav a[href^="/portal/advanced"]').first().click();
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 });
    await settle(page, 600);
    msg = await page.locator('[data-ss-adv="msg"]').innerText().catch(() => "(no message)");
    ok("L: switched away and back (the page remounted), it still says the style is showing and how to hide it",
      msg === "“Tri Home” was made, but hiding it didn't work, so customers can see it now. Press Save again to hide it and finish it, or hide it yourself: Settings → Structures → Hide.", msg);
    await page.locator('[data-ss-adv="save"]').screenshot({ path: join(SHOTS, "advpage-hide-failed-after-remount.png") }).catch(() => {});
    // …and says it at the TOP of the page as well, where a builder coming back sees it without scrolling
    // 2,000 px down to Save.
    const top = await page.locator('[data-ss-adv="msg-top"]').innerText().catch(() => "(none)");
    const topY = await page.locator('[data-ss-adv="msg-top"]').evaluate((e) => e.getBoundingClientRect().top + scrollY).catch(() => 1e9);
    ok("L: …also at the top of the page, under Start from", top === msg && topY < 400, `${Math.round(topY)} ${top}`);
    // 3. Saved again under ANOTHER name: the same style is hidden, renamed and shaped; nothing is created.
    from = calls.length;
    await save("Tri Home 2");
    await msgIs(/Saved as|didn't/);
    msg = await page.locator('[data-ss-adv="msg"]').innerText();
    const W1 = writes(calls.slice(from));
    ok("L: the next Save, under another name, finishes THAT style: hide, rename, shape — no second create_style",
      W1.map((c) => c.action).join(",") === "set_style_active,update_style,save_style_d3", W1.map((c) => c.action).join(","));
    const sid = "00000000-0000-4000-8000-00000000a001";
    ok("L: …the hide and the rename are the first style's, the shape goes to its key, all on our account",
      W1.length === 3 && W1[0].body.styleId === sid && W1[0].body.active === false && W1[1].body.styleId === sid && W1[1].body.label === "Tri Home 2"
      && Object.keys(W1[1].body).sort().join(",") === "action,label,styleId,targetClientId" && W1[2].body.styleValue === "tri-home" && W1.every((c) => c.body.targetClientId === OURS),
      W1.map((c) => JSON.stringify(c.body).slice(0, 120)).join(" | "));
    ok("L: …and it says it saved under the new name", msg === "Saved as “Tri Home 2”. Hidden from customers — add its sizes and prices in Settings → Structures, then press Show.", msg);
    // 4. The shape fails: the next Save finishes it with one call.
    S.failOnce.save_style_d3 = 1;
    from = calls.length;
    await save("Shed B");
    await msgIs(/didn't save onto it|Saved as/);
    msg = await page.locator('[data-ss-adv="msg"]').innerText();
    ok("L: a shape that fails says the style is made and hidden, and that Save again won't make another",
      msg === "“Shed B” is made and hidden from customers, but this building didn't save onto it. Press Save again to finish it. That won't make another style. (Something went wrong on our side.)", msg);
    const mid = writes(calls.slice(from)).length;
    await page.getByRole("button", { name: "Save as a new style" }).click();
    await msgIs(/^Saved as/);
    const W2 = writes(calls.slice(from)).slice(mid);
    ok("L: …and the next Save is just the shape, onto that style", W2.map((c) => c.action).join(",") === "save_style_d3" && W2[0].body.styleValue === "shed-b", W2.map((c) => `${c.action}:${c.body.styleValue || ""}`).join(","));
    ok("L: two styles made in all, for three Saves that each stopped or finished", calls.filter((c) => c.fn === "portal-settings" && c.action === "create_style").length === 2);
    // 5. A name this page saved is taken now, whatever the case.
    await save("tri home 2");
    await settle(page, 400);
    ok("L: a name this page saved is refused afterwards", (await page.locator('[data-ss-adv="msg"]').innerText()) === "There's already a style called “tri home 2”. Give this one a different name.");
    ok("L: no dialogs were needed (nothing was unsaved at the switches)", dialogs.length === 0, JSON.stringify(dialogs));
    ok("L: no page errors", errors.filter((e) => !/status of 500/.test(e)).length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed   (shots: ${SHOTS})`);
process.exit(bad.length ? 1 : 0);
