// THE ADVANCED MODE SWITCH (2026-10-05, migration 270), driven for real on the COMPILED portal.
//
// Carolyn, 09-28: the Advanced page is "only available in Structure Studio for us yet". Ahsan: when
// it launches, builders "just have to go into settings and ... turn on the advanced mode to access
// this tab, so everybody is not going to see." Carolyn: "Yep, yep, no, that's good." So Settings →
// Designer has an "Advanced mode" card (06-3d.jsx AdvancedModeCard): an owner or admin switches it,
// portal-settings save_advanced_mode stores client_settings.advanced_mode, portal-billing sends it
// back as entitlement.advancedMode, and the shell re-reads the entitlement so the menu follows.
//
// Scenarios, one fresh browser context each (nothing cached leaks between them):
//   A  AN OWNER WITH 3D, switch off: the card sits above the 3D card, off, and there is no Advanced
//      item. Turning it on sends save_advanced_mode {enabled: true} for their own account, the shell
//      asks portal-billing again, and the item appears directly under Designer, all without a reload.
//      "Open Advanced" opens the page. Turning it off takes the item away again the same way.
//   B  AN OWNER WITHOUT 3D: the switch is greyed with "Needs 3D" and points at Billing; pressing it
//      sends nothing.
//   C  A TEAM MEMBER who may see Settings → Designer: no card at all.
//   D  OUR OWN ACCOUNT: on and locked ("Always on for this account"); pressing it sends nothing.
//   E  VIEW-AS: an operator whose own account has Advanced views a builder who does not. The card
//      says off and there is no item (the operator's own answer does not leak in). Turning it on
//      writes the BUILDER (targetClientId), the builder's entitlement is re-read, and the item
//      appears, still in view-as.
//   F  A REFUSED SAVE (the server answers 500): the switch stays off, the reason is shown, no item,
//      and the shell is not asked to re-read anything.
//   G  A SERVER THAT PREDATES advancedMode: no card (a switch whose answer could never come back
//      would look broken), and the 3D card is still there.
//   H  UNSAVED WORK on the Advanced page: turning Advanced off asks first; No keeps it on and sends
//      nothing.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine except the
// three.js module GETs the 3D needs). Nothing is written anywhere: save_advanced_mode is answered by
// the stub, which flips its own copy of the entitlement the way the real functions would.
//
//   python -m http.server 8137 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8137 node tests/harness/advancedModeSwitch.mjs   (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, to prove these
// checks can fail. Against the artifact before this batch (86afa7a) there is no card: A, B, D, E, F
// and H fail (29 checks), C and G's "no card" pass, and G's 3D card fails too, because that artifact
// also predates `paid`.
// Screenshots go to SS_SHOTS (else the OS temp dir; see lib.mjs shotsDir).
//
// Tenants and users here are made up. The repo is public: no real client id belongs in a fixture.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, shotsDir, collectErrors, BASE, REF, PASS_THROUGH_GET } from "./lib.mjs";
import { CONFIG as GABLE_CONFIG, FIXTURES } from "./gableProbe.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;
const SHOTS = shotsDir("advanced-mode-switch");
const TAG = ARTIFACT ? "-override" : "";

const BUILDER = "harness-advmode";
const OURS = "harness-internal";
const OPS = "harness-ops";
const CONFIG = { ...GABLE_CONFIG, clientId: BUILDER };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000055", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// portal-billing `status`, in the real function's shape (the parts the shell reads).
// `adv` is the advancedMode field ("absent" = a server that predates it); `has3d` puts 3D in paid.
function statusAnswer({ adv = false, has3d = true, internal = false } = {}) {
  const entitlement = {
    exempt: internal, state: internal ? "exempt" : "active", locked: false, reason: internal ? "internal" : "active",
    graceEndsAt: null, graceDays: 7, transitionEndsAt: null,
    requiredRate: { monthlyCents: 19500, annualCents: 195000, listMonthlyCents: 19500, listAnnualCents: 195000, discountPercent: 0 },
    features: { simple_layout: true, view_3d: has3d },
    granted: internal ? ["view_3d"] : [],
    paid: has3d && !internal ? ["simple_layout", "view_3d"] : ["simple_layout"],
    ...(adv === "absent" ? {} : { advancedMode: internal || adv }),
  };
  return { configured: true, entitlement, plans: [], subscriptions: [], hasCard: false, wallet: null };
}

const { ok, failed } = reporter();
const { browser, ctx: unused } = await launch({ width: 1440, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// S: { own, role?, access?, operator?, statusFor(target) → answer, onSave?(target, body) → {status, body} | null }
async function open(S, path) {
  const calls = [];   // { fn, action, target, body, at }
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    window.__SS3D_DEBUG = true;
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); (S.dialogAnswer === true ? d.accept() : d.dismiss()); });

  // Catch-all abort FIRST: Playwright runs matching routes in reverse registration order.
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
      const name = rpc[1];
      if (name === "get_config") return json(route, CONFIG);
      if (name === "get_fixtures") return json(route, FIXTURES);
      if (name === "is_operator") return json(route, !!S.operator);
      return json(route, false);   // is_support_operator, can_open_projects, log_error, …
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: S.own, role: S.role || "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    const fn = /\/(?:functions\/v1\/)?(portal-[a-z]+|operator-portal)(?:[/?]|$)/.exec(new URL(url).pathname);
    if (fn && new URL(url).searchParams.has("warm")) return json(route, { ok: true });
    const target = body.targetClientId || null;
    if (fn) calls.push({ fn: fn[1], action: body.action, target, body, at: Date.now() - t0 });
    if (url.includes("/portal-billing")) {
      if (body.action === "status") return json(route, S.statusFor(target));
      return json(route, { error: `Harness stub: unexpected portal-billing action ${body.action}` }, 400);
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") {
        const cid = target || S.own;
        return json(route, { ok: true, clientId: cid, role: target ? "operator" : (S.role || "owner"), settings: { business_name: cid }, config: { company_name: cid, accent_color: "#3D3672" }, access: (!target && S.access) || null, prefs: null });
      }
      if (body.action === "catalog") return json(route, { ok: true, aiReady: false, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      if (body.action === "save_advanced_mode") {
        const r = S.onSave ? S.onSave(target, body) : null;
        if (r) return json(route, r.body, r.status);
        return json(route, { ok: true, advancedMode: body.enabled === true });
      }
      if (body.action === "save_style_d3") return json(route, { ok: true, updatedAt: "2026-10-05T10:00:00.000+00:00" });
      return json(route, { ok: true });
    }
    if (url.includes("/operator-portal")) {
      if (body.action === "get_portal") return json(route, { ok: true, clientId: body.clientId, companyName: "Acme Sheds", designs: [], versions: [], capturedLeads: [] });
      return json(route, { ok: true, clients: [{ clientId: BUILDER, companyName: "Acme Sheds" }] });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(`**/${REF}.storage.supabase.co/**`, handler);
  // What _redirects does in production: every /portal/<page> is portal.html.
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));

  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  return { ctx, page, calls, errors, dialogs };
}

const settle = (page, ms) => page.waitForTimeout(ms);
// The app's own client-side routing: a history entry plus the popstate the shell listens to. No
// navigation, so the page (and every marker set on window) survives it.
const go = (page, pathname) => page.evaluate((p) => {
  history.pushState({}, "", p + location.search);
  dispatchEvent(new PopStateEvent("popstate", { state: {} }));
}, pathname);
const navOrder = (page) => page.evaluate(() => [...document.querySelectorAll(".ss-ws-nav .ss-nav a")].map((a) => new URL(a.href).pathname));
const advItem = (page) => page.locator('.ss-nav a[href^="/portal/advanced"]:not(.ss-back)');
const sw = (page) => page.getByRole("switch", { name: "Advanced mode", exact: true });
// Null when there is no switch at all (an older artifact), so a missing card fails its checks
// instead of stalling the run on a locator timeout.
const checked = async (page) => ((await sw(page).count()) ? sw(page).getAttribute("aria-checked") : null);
const swEnabled = async (page) => ((await sw(page).count()) ? sw(page).isEnabled() : null);
const press = async (page, force = false) => { if (await sw(page).count()) await sw(page).click(force ? { force: true } : {}).catch(() => {}); };
const card = (page) => page.locator("[data-ss-adv-mode]");
const saves = (calls) => calls.filter((c) => c.fn === "portal-settings" && c.action === "save_advanced_mode");
const statusReads = (calls, after) => calls.filter((c) => c.fn === "portal-billing" && c.action === "status" && c.at >= after);
const itemUnderDesigner = async (page) => {
  const o = await navOrder(page);
  return o.indexOf("/portal/advanced") > 0 && o.indexOf("/portal/advanced") === o.indexOf("/portal/designer") + 1;
};
// Settings → Designer, with whichever 3D answer it draws given time to draw.
async function settingsDesigner(page) {
  await go(page, "/portal/settings/designer");
  await page.waitForFunction(() => document.body.innerText.includes("Give each building style its own 3D look"), null, { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => {
    const t = document.body.innerText;
    return t.includes("3D Style Calibration") || t.includes("3D isn't on for this account yet") || t.includes("3D is on for this account");
  }, null, { timeout: 60000 }).catch(() => {});
}
// Is the Advanced mode card above the 3D card? With 3D on, the 3D card is the calibration page itself
// since 2026-10-05 (06-3d.jsx data-ss-cal-page, the Advanced page's form); without it, the "3D" card.
const cardAbove3d = (page) => page.evaluate(() => {
  const c = document.querySelector("[data-ss-adv-mode]");
  const t = document.querySelector("[data-ss-cal-page]") || [...document.querySelectorAll("div")].find((d) => d.children.length === 0 && d.textContent.trim() === "3D");
  return !!(c && t && (c.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING));
});
const waitFor = (page, fnBody, arg, timeout = 15000) => page.waitForFunction(fnBody, arg, { timeout }).then(() => true, () => false);

try {
  // ── A: an owner with 3D turns it on, opens it, and turns it off ───────────────────────────
  {
    let adv = false;
    const S = { own: BUILDER, statusFor: () => statusAnswer({ adv }), onSave: (_t, body) => { adv = body.enabled === true; return null; } };
    const { ctx, page, calls, errors } = await open(S, "/portal/designs");
    await settingsDesigner(page);
    ok(`A${TAG}: Settings → Designer has the Advanced mode card`, (await card(page).count()) === 1);
    ok(`A${TAG}: …above the 3D card`, await cardAbove3d(page));
    ok(`A${TAG}: …with the words agreed for it`, await page.getByText("Adds an Advanced page under Designer for designing a building from scratch with every shape control.").count() === 1);
    ok(`A${TAG}: …switched off, and pressable`, (await checked(page)) === "false" && (await swEnabled(page)) === true);
    ok(`A${TAG}: no Advanced item while it is off`, (await advItem(page).count()) === 0);
    await card(page).screenshot({ path: join(SHOTS, `A-card-off${TAG}.png`) }).catch(() => {});
    await page.evaluate(() => { window.__harnessSamePage = "still here"; });
    await press(page);
    const sent = await waitFor(page, () => !!document.querySelector('.ss-nav a[href^="/portal/advanced"]'), null);
    const s1 = saves(calls);
    ok(`A${TAG}: pressing it sends save_advanced_mode {enabled: true} for their own account`,
      s1.length === 1 && s1[0].body.enabled === true && s1[0].body.targetClientId === null, JSON.stringify(s1.map((c) => c.body)));
    ok(`A${TAG}: the shell asked portal-billing again after the save`, s1.length === 1 && statusReads(calls, s1[0].at).length >= 1, `${s1.length && statusReads(calls, s1[0].at).length} status read(s) after`);
    ok(`A${TAG}: the Advanced item appears, directly under Designer`, sent && await itemUnderDesigner(page), (await navOrder(page)).join(" "));
    ok(`A${TAG}: the switch now says on`, (await checked(page)) === "true");
    ok(`A${TAG}: …and the card says where to find it`, await page.getByText("Advanced is on. You'll find it in the menu, right under Designer.").count() === 1);
    ok(`A${TAG}: all without a reload`, (await page.evaluate(() => window.__harnessSamePage)) === "still here");
    await page.screenshot({ path: join(SHOTS, `A-switched-on${TAG}.png`) });
    await page.locator("aside.ss-side").screenshot({ path: join(SHOTS, `A-sidebar-on${TAG}.png`) }).catch(() => {});
    // Open it from the card.
    const openBtn = page.getByRole("button", { name: "Open Advanced" });
    ok(`A${TAG}: "Open Advanced" is offered`, (await openBtn.count()) === 1);
    if (await openBtn.count()) {
      await openBtn.click();
      const opened = await waitFor(page, () => location.pathname === "/portal/advanced" && document.body.innerText.includes("Every shape control on one building"), null, 60000);
      ok(`A${TAG}: …and opens the Advanced page`, opened, await page.evaluate(() => location.pathname));
      await page.screenshot({ path: join(SHOTS, `A-advanced-page${TAG}.png`) });
    }
    // Turn it off again.
    await settingsDesigner(page);
    await press(page);
    const gone = await waitFor(page, () => !document.querySelector('.ss-nav a[href^="/portal/advanced"]'), null);
    const s2 = saves(calls);
    ok(`A${TAG}: turning it off sends {enabled: false}`, s2.length === 2 && s2[1].body.enabled === false, JSON.stringify(s2.map((c) => c.body)));
    ok(`A${TAG}: …and the item goes away, without a reload`, gone && (await page.evaluate(() => window.__harnessSamePage)) === "still here");
    ok(`A${TAG}: …and the switch says off`, (await checked(page)) === "false");
    ok(`A${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── B: no 3D ────────────────────────────────────────────────────────────────────────────
  {
    const S = { own: BUILDER, statusFor: () => statusAnswer({ adv: false, has3d: false }) };
    const { ctx, page, calls, errors } = await open(S, "/portal/designs");
    await settingsDesigner(page);
    ok(`B${TAG}: without 3D the card is there`, (await card(page).count()) === 1);
    ok(`B${TAG}: …the switch is off and greyed`, (await checked(page)) === "false" && (await swEnabled(page)) === false);
    ok(`B${TAG}: …it says "Needs 3D" and points at Billing`, await page.getByText("Needs 3D", { exact: true }).count() === 1
      && await page.getByText("Advanced builds on 3D. Add 3D on the Billing page, then turn this on.").count() === 1);
    await card(page).screenshot({ path: join(SHOTS, `B-needs-3d${TAG}.png`) }).catch(() => {});
    await press(page, true);
    await settle(page, 800);
    ok(`B${TAG}: pressing it sends nothing`, saves(calls).length === 0);
    ok(`B${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── C: a team member ────────────────────────────────────────────────────────────────────
  {
    const S = { own: BUILDER, role: "user", access: { designer: "edit", designs: "edit", settings_structures: "edit" }, statusFor: () => statusAnswer({ adv: false }) };
    const { ctx, page, errors } = await open(S, "/portal/designs");
    await settingsDesigner(page);
    ok(`C${TAG}: a team member reaches Settings → Designer`, await page.getByText("Give each building style its own 3D look").count() === 1);
    ok(`C${TAG}: …and gets no Advanced mode card`, (await card(page).count()) === 0);
    ok(`C${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── D: our own account ──────────────────────────────────────────────────────────────────
  {
    const S = { own: OURS, statusFor: () => statusAnswer({ internal: true, adv: false }) };
    const { ctx, page, calls, errors } = await open(S, "/portal/designs");
    await settingsDesigner(page);
    ok(`D${TAG}: our own account: the switch is on and locked`, (await card(page).count()) === 1
      && (await checked(page)) === "true" && (await swEnabled(page)) === false);
    ok(`D${TAG}: …"Always on for this account"`, await page.getByText("Always on for this account.").count() === 1);
    ok(`D${TAG}: …and the Advanced item is there`, await itemUnderDesigner(page));
    await press(page, true);
    await settle(page, 800);
    ok(`D${TAG}: pressing it sends nothing`, saves(calls).length === 0);
    await card(page).screenshot({ path: join(SHOTS, `D-ours-locked${TAG}.png`) }).catch(() => {});
    ok(`D${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── E: view-as ──────────────────────────────────────────────────────────────────────────
  {
    let adv = false;
    const S = {
      own: OPS, operator: true,
      // The operator's own account has Advanced on; the viewed builder does not, until switched.
      statusFor: (target) => (target === BUILDER ? statusAnswer({ adv }) : statusAnswer({ adv: true })),
      onSave: (target, body) => { if (target === BUILDER) adv = body.enabled === true; return null; },
    };
    const { ctx, page, calls, errors } = await open(S, `/portal/designs?view=${BUILDER}`);
    await page.waitForFunction(() => /Viewing|Exit/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
    await settingsDesigner(page);
    ok(`E${TAG}: viewing a builder without it: the card says off`, (await card(page).count()) === 1 && (await checked(page)) === "false");
    ok(`E${TAG}: …and there is no Advanced item (the operator's own "on" does not leak in)`, (await advItem(page).count()) === 0);
    await page.evaluate(() => { window.__harnessSamePage = "still here"; });
    await press(page);
    const appeared = await waitFor(page, () => !!document.querySelector('.ss-nav a[href^="/portal/advanced"]'), null);
    const s = saves(calls);
    ok(`E${TAG}: the save is for the BUILDER`, s.length === 1 && s[0].body.targetClientId === BUILDER && s[0].body.enabled === true, JSON.stringify(s.map((c) => c.body)));
    const after = s.length ? statusReads(calls, s[0].at) : [];
    ok(`E${TAG}: the builder's entitlement was read again (and only the builder's)`, after.length >= 1 && after.every((c) => c.target === BUILDER), JSON.stringify(after.map((c) => c.target)));
    ok(`E${TAG}: the item appears for the builder, under Designer`, appeared && await itemUnderDesigner(page));
    ok(`E${TAG}: still in view-as, no reload`, (await page.evaluate(() => [window.__harnessSamePage, new URLSearchParams(location.search).get("view")])).join() === `still here,${BUILDER}`);
    await page.screenshot({ path: join(SHOTS, `E-viewas-switched-on${TAG}.png`) });
    ok(`E${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── F: a refused save ───────────────────────────────────────────────────────────────────
  {
    const S = { own: BUILDER, statusFor: () => statusAnswer({ adv: false }), onSave: () => ({ status: 500, body: { error: "Couldn't turn Advanced mode on. Please try again." } }) };
    const { ctx, page, calls } = await open(S, "/portal/designs");
    await settingsDesigner(page);
    await press(page);
    const shown = await waitFor(page, () => !!document.querySelector('[data-ss-adv-mode] [role="alert"]'), null);
    const s = saves(calls);
    ok(`F${TAG}: the save was sent`, s.length === 1);
    ok(`F${TAG}: a refused save says why`, shown && /Couldn't turn Advanced mode on/.test(await page.locator('[data-ss-adv-mode] [role="alert"]').innerText()));
    ok(`F${TAG}: …the switch stays off`, (await checked(page)) === "false");
    await settle(page, 800);
    ok(`F${TAG}: …no item, and the shell was not asked to re-read anything`, (await advItem(page).count()) === 0 && s.length === 1 && statusReads(calls, s[0].at).length === 0);
    await card(page).screenshot({ path: join(SHOTS, `F-refused${TAG}.png`) }).catch(() => {});
    await ctx.close();
  }

  // ── G: a server that predates advancedMode ────────────────────────────────────────────────
  {
    const S = { own: BUILDER, statusFor: () => statusAnswer({ adv: "absent" }) };
    const { ctx, page, errors } = await open(S, "/portal/designs");
    await settingsDesigner(page);
    ok(`G${TAG}: no advancedMode from the server: no card`, (await card(page).count()) === 0);
    ok(`G${TAG}: …and the 3D card is still there`, await page.getByText("3D Style Calibration").count() >= 1);
    ok(`G${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ── H: unsaved work on the Advanced page ──────────────────────────────────────────────────
  {
    const S = { own: BUILDER, statusFor: () => statusAnswer({ adv: true }), dialogAnswer: false };
    const { ctx, page, calls, errors, dialogs } = await open(S, "/portal/advanced");
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
    await settle(page, 1000);
    // A change: a lean-to, 6 ft wide (advancedTab.mjs's leanWidth).
    // Bounded waits: on an artifact without the switch the page never opens, and that must fail
    // the checks below rather than stall the run.
    try {
      await page.locator('[data-ss-adv-sec="leanto"]').click({ timeout: 10000 });
      if (!(await page.locator("[data-ss-adv-lt]").count())) await page.locator('[data-ss-adv-f="leanToAdd"]').click({ timeout: 10000 });
      const box = page.getByLabel("Lean-to 1 width (ft)", { exact: true });
      await box.fill("6", { timeout: 10000 });
      await box.blur();
    } catch (_e) { /* the checks below say what is missing */ }
    await settle(page, 400);
    await settingsDesigner(page);
    await press(page);
    await settle(page, 800);
    ok(`H${TAG}: turning Advanced off with unsaved work asks first`,
      dialogs[0] === "Turning Advanced off will discard the building you haven't saved on the Advanced page. Continue?", String(dialogs[0]));
    ok(`H${TAG}: …No sends nothing and keeps it on`, saves(calls).length === 0 && (await checked(page)) === "true" && (await advItem(page).count()) === 1);
    await go(page, "/portal/advanced");
    await settle(page, 600);
    ok(`H${TAG}: …and the building is still there`, (await page.getByLabel("Lean-to 1 width (ft)", { exact: true }).inputValue({ timeout: 10000 }).catch(() => "")) === "6");
    ok(`H${TAG}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
}

const bad = failed();
console.log(bad.length ? `\n${bad.length} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
console.log(`screenshots: ${SHOTS}`);
process.exitCode = bad.length ? 1 : 0;
