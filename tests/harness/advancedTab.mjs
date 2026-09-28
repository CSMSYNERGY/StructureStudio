// THE ADVANCED PAGE (2026-09-28), driven for real on the COMPILED portal.
//
// Carolyn: "an advanced tab that is only available in Structure Studio for us yet", directly under
// Designer in the Workspace menu. Our own account is the one whose portal-billing entitlement says
// `reason: "internal"` (client_settings.internal_account); ssAdvancedOn in portal/01-core.jsx is
// the one rule, and nothing names the tenant's slug.
//
// What this proves, per scenario (one fresh browser context each, so nothing cached leaks):
//   A  OUR ACCOUNT, clicked. The item sits directly under Designer; clicking it opens the page; the
//      3D mounts beside the calibration panel's field grid (and none of the calibration's own
//      steps); Width/Length move the building; Lean-to width 8 puts ssLeanTo meshes in the scene;
//      the page stays mounted across a trip to another page; an empty name is refused without a
//      call; and Save posts create_style, then save_style_d3 with the draft spec under the new
//      key, then set_style_active false — in that order, and nothing else is written.
//   A2 OUR ACCOUNT, cold deep link to /portal/advanced with the entitlement held back 1.5 s. It
//      ENDS on the Advanced page, and the address bar never left /portal/advanced while waiting.
//   B  AN EXEMPT BUILDER (every grantable feature, view_3d included, but not internal), cold deep
//      link, entitlement held back. No Advanced item is ever drawn, the page is never drawn, and
//      it ends on /portal/designer with the Designer mounted (not a blank page).
//   B2 A NEVER-PAID BUILDER behind the billing gate: same refusal, no item.
//   C  AN OPERATOR viewing our account (?view=), clicked: the item appears once the viewed
//      entitlement answers, the page opens, and Save carries targetClientId for the viewed tenant.
//   C2 The same operator's COLD /portal/advanced?view=<ours>: their own entitlement answers first
//      (not internal) and ?view= arms later, so the route is refused for a moment — it must still
//      END on the Advanced page.
//   C3 The same operator viewing another builder: no item.
//   D  A PHONE-WIDTH window (390 px): no sideways page scroll, the 3D is not docked (so it cannot
//      sit on top of the form), and "Preview in 3D" opens the full-screen viewer on the draft.
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

// S: { own, role, operator, entFor: (targetClientId|null) => entitlement, billingDelayMs, viewport }
async function open(S, path) {
  const calls = [];   // { fn, action, body, at }
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport: S.viewport || { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    window.__SS3D_DEBUG = true;
    // Witnesses from the first render on: was the Advanced item or the Advanced page EVER drawn,
    // and every path the address bar showed.
    window.__advSeen = { nav: false, page: false, checking: false };
    window.__paths = [];
    const scan = () => {
      if (document.querySelector('.ss-nav a[href^="/portal/advanced"]:not(.ss-back)')) window.__advSeen.nav = true;
      const t = document.body ? document.body.innerText : "";
      if (t.includes("Every shape control on one building")) window.__advSeen.page = true;
      if (t.includes("Checking your account")) window.__advSeen.checking = true;
      const p = location.pathname;
      if (window.__paths[window.__paths.length - 1] !== p) window.__paths.push(p);
    };
    const attach = () => {
      if (!document.documentElement) { setTimeout(attach, 5); return; }
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      setInterval(scan, 20);
    };
    attach();
  }, [REF, SESSION]);
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
      if (S.billingDelayMs) await new Promise((r) => setTimeout(r, S.billingDelayMs));
      return json(route, { ok: true, configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, entitlement: S.entFor(body.targetClientId || null) });
    }
    if (url.includes("/portal-settings")) {
      const a = body.action;
      if (a === "status") {
        const cid = body.targetClientId || S.own;
        return json(route, { ok: true, clientId: cid, role: "owner", settings: { business_name: cid }, config: { company_name: cid, accent_color: "#3D3672" }, access: null, prefs: null });
      }
      if (a === "catalog") return json(route, { ok: true, aiReady: true, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      if (a === "create_style") {
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
const seen = (page) => page.evaluate(() => ({ ...window.__advSeen, paths: window.__paths.slice() }));
const here = (page) => page.evaluate(() => location.pathname);
const writes = (calls) => calls.filter((c) => c.fn === "portal-settings" && ["create_style", "save_style_d3", "set_style_active", "save_style_media", "save"].includes(c.action));

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
    const body = await page.locator('[data-ss-adv="fields"]').innerText();
    ok("A: the calibration field grid is there (roof, walls, lean-to, porch, colours)", /Roof type/.test(body) && /Lean-to width/.test(body) && /Wall height/i.test(body) && /Porch/i.test(body) && /Body/i.test(body));
    ok("A: …and none of calibration's own steps (style strip, video, photos, scan, Save 3D look)",
      !/3D Style Calibration|Walk-around video|Photos of the same building|Scan of a real building|Save 3D look|Save to config/.test(await page.locator(".ss-body").innerText()));
    ok("A: the end view sits beside the 3D, not inside the form", await page.locator('[data-ss-adv="view"] svg').count() >= 1 && await page.locator('[data-ss-adv="fields"] svg[viewBox="0 0 360 210"]').count() === 0);
    ok("A: the section-tabs TODO marker is in the source", readFileSync(join(ROOT, "structure-studio.component.js"), "utf8").includes("TODO(advanced-sections)"));

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
    const lean = page.getByLabel(/Lean-to width/);
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
    ok("A: Save says where the style went, in plain words", msg === "Saved as “Harness Custom Barn” — hidden from customers. Add its sizes and prices in Settings → Structures, then switch it on.", msg);
    const W3 = writes(calls);
    const seq = W3.map((c) => c.action);
    ok("A: Save posts create_style, then save_style_d3, then set_style_active — in that order, and nothing else", JSON.stringify(seq) === JSON.stringify(["create_style", "save_style_d3", "set_style_active"]), seq.join(" → "));
    const [cs, sd, sa] = W3;
    ok("A: create_style carries the typed name, for our own tenant (targetClientId null)", cs && cs.body.label === "Harness Custom Barn" && cs.body.targetClientId === null, cs && JSON.stringify(cs.body));
    ok("A: save_style_d3 goes to the NEW style's key", sd && sd.body.styleValue === "harness-custom-barn", sd && sd.body.styleValue);
    const d3 = sd && sd.body.d3;
    ok("A: …with the draft on screen: a gable, lean-to 8, 8 ft walls, the new frame",
      d3 && d3.roof && d3.roof.type === "gable" && d3.roof.leanToWidthFt === 8 && d3.wallHeightFt === 8 && sd.body.frame === "front", d3 && JSON.stringify(d3.roof));
    ok("A: …and no photos or video frames are claimed", sd && Array.isArray(sd.body.d3Photos) && sd.body.d3Photos.length === 0 && !("d3VideoFrames" in sd.body));
    ok("A: set_style_active hides that same new style", sa && sa.body.styleId === "00000000-0000-4000-8000-00000000a001" && sa.body.active === false && sa.body.targetClientId === null, sa && JSON.stringify(sa.body));
    ok("A: the name box is cleared for the next one", (await page.getByLabel("New style name").inputValue()) === "");

    // Start from a copy of a style: seeded from its look, confirm before losing work.
    let asked = null;
    page.once("dialog", (d) => { asked = d.message(); d.accept(); });
    await page.getByLabel("Start from").selectOption("hbarn");
    await settle(page, 1500);
    ok("A: switching the start point asks before throwing work away", asked === "Start again? The changes you made to this building will be lost.", String(asked));
    const typeSel = page.getByLabel("Roof type");
    const wall = await page.getByLabel("Wall height (ft)", { exact: true }).inputValue();
    ok("A: Copy of Harness Barn seeds that style's roof (gambrel), wall (9) and no lean-to", (await typeSel.inputValue()) === "gambrel" && wall === "9" && (await page.getByLabel(/Lean-to width/).inputValue()) === "0", `${await typeSel.inputValue()} / wall ${wall}`);
    await advPanel(page);
    await page.waitForFunction(() => { let n = 0; window.__ss3dPanel.model.root.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssLeanTo === true) n++; }); return n === 0; }, null, { timeout: 20000 }).catch(() => {});
    ok("A: …and the 3D follows (no lean-to left)", (await measure(page)).leanTo === 0);
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
    await page.getByLabel(/Lean-to width/).fill("6");
    await page.getByLabel(/Lean-to width/).blur();
    await page.getByRole("button", { name: /Preview in 3D/ }).click();
    await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length); }, null, { timeout: 90000 });
    await settle(page, 1200);
    const lt = await page.evaluate(() => { let n = 0; window.__ss3dEngine.model.root.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssLeanTo === true) n++; }); return n; });
    ok("D: Preview in 3D opens the full-screen viewer on the draft (lean-to 6 is in it)", lt > 0, `${lt} lean-to meshes`);
    await page.screenshot({ path: join(SHOTS, "advpage-phone-preview.png") });
    ok("D: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed   (shots: ${SHOTS})`);
process.exit(bad.length ? 1 : 0);
