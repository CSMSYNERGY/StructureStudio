// My Profile's Meetings cards in VIEW-AS (2026-10-27), driven for real on the COMPILED portal. The
// own-portal half is myProfileMeetingsGate.mjs; this is the operator half it does not cover.
//
// In view-as featureOn reads generous until the viewed builder's plan (viewedCtx) lands, and the
// shell's crmPending was false there, so My Connections and My meetings mounted for that moment and
// asked portal-meetings for a builder without the CRM: a refused call, its red box for a moment,
// and an app_errors row each. crmPending now means "viewedCtx not loaded yet" in view-as.
//
//   E. an operator viewing a builder WITHOUT the CRM, its plan answering 1.5 s late: neither card,
//      no portal-meetings call for that builder, nothing refused. (The operator's own account may
//      be read in the moment before view-as starts; it has the CRM, so that answers.)
//   F. an operator viewing a builder WITH the CRM: both cards, the overview read, nothing refused
//
// The stub refuses exactly as the server does (crm_locked 403 without the CRM, the access gate's
// sentence without Meetings view) and counts every refusal. Supabase is stubbed at the network
// layer; nothing leaves the machine. Names are made up (public repo).
//
//   python -m http.server 8125 --bind 127.0.0.1    (repo root; SS_BASE overrides the address)
//   node tests/harness/myProfileMeetingsViewAs.mjs  (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/my-profile-meetings-view-as (SS_SHOTS overrides).
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead: a portal without
// the view-as line fails E. SS_GATE_SCENARIOS=E runs only the scenarios named (comma-separated).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, shotsDir, serveAppRoutes } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;
const TAG = ARTIFACT ? "-override" : "";

const CRM_CLIENT = "acme-sheds";
const BARE_CLIENT = "plain-barns";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000b8", aud: "authenticated", role: "authenticated", email: "pat@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const AREAS = ["designer", "designs", "contacts", "inventory", "orders", "change_orders", "change_order_approve", "build_schedule",
  "delivery_schedule", "repairs", "commissions", "reports", "projects", "phone", "meetings", "settings_structures", "settings_options",
  "settings_branding", "settings_crm", "settings_quickbooks", "settings_email", "settings_team", "settings_billing"];
const OWNER_ACCESS = Object.fromEntries(AREAS.map((k) => [k, "edit"]));
const CRM_LOCKED = "The built-in CRM isn't part of your subscription — add it under Settings → Billing.";
const NO_MEETINGS = "Your access does not let you view Meetings. Ask an owner or admin.";
const RED = [CRM_LOCKED.slice(0, 40), "does not let you view Meetings"];

const { ok, failed } = reporter();
const shots = shotsDir("my-profile-meetings-view-as");
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const LOCAL = /^https?:\/\/(127\.0\.0\.1|(?:[a-z0-9-]+\.)*localhost)(:\d+)?\//;
const crmOf = (clientId) => clientId === CRM_CLIENT;

/** One fresh context on /settings/myprofile. → { ctx, page, meetings, refused, errors }; `meetings` is
 *  every portal-meetings body the page posted, `refused` the ones the stub said no to. `viewAs`: the
 *  tenant an operator is viewing; `viewDelayMs` holds back that tenant's plan (portal-billing). */
async function scenario(browser, { name, client = CRM_CLIENT, role = "owner", access = OWNER_ACCESS, viewAs = null, viewDelayMs = 0 }) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const meetings = [];
  const refused = [];
  await page.route((u) => !LOCAL.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, !!viewAs);
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: client, role, user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    const tenant = body.targetClientId || client;
    if (url.includes("/portal-billing")) {
      if (body.targetClientId && viewDelayMs) await new Promise((r) => setTimeout(r, viewDelayMs));
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, clientId: tenant,
        entitlement: { granted: [], features: crmOf(tenant) ? { crm: true } : {}, status: "active" } });
    }
    if (url.includes("/operator-portal")) return json(route, { ok: true, clientId: viewAs, companyName: "Viewed Builder", designs: [], versions: [], capturedLeads: [] });
    if (url.includes("/portal-meetings")) {
      meetings.push(body);
      // The server's own order: the CRM first (every action), then the access gate.
      if (!crmOf(tenant)) { refused.push(body); return json(route, { error: CRM_LOCKED, code: "crm_locked" }, 403); }
      const a = body.targetClientId ? OWNER_ACCESS : access;
      if (!["view", "edit", "own", "own_view"].includes(a.meetings)) { refused.push(body); return json(route, { error: NO_MEETINGS }, 403); }
      return json(route, { ok: true, types: [], hosts: [], myHost: null, connections: [], videoReady: { zoom: false }, settings: null, canManageBusiness: a.meetings === "edit" });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    const asOp = !!body.targetClientId;
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: tenant, role: asOp ? "operator" : role, operatorMode: asOp, access: asOp ? OWNER_ACCESS : access,
          prefs: null, phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "get_profile":
        return json(route, { fullName: "Pat Example", phone: "", role, email: USER.email, needsDetails: false, emailSignature: "" });
      case "ai_transcripts_get":
        return json(route, { ok: true, available: false });
      case "phone_settings_get":
        return json(route, { ok: true, available: false });
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));
  await page.goto(`${BASE}/settings/myprofile${viewAs ? `?view=${viewAs}` : ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes("How the Contacts tab opens"), null, { timeout: 20000 }).catch(() => {});
  // Long enough for the plan to land and for any card that is going to call portal-meetings to have
  // called it and drawn its answer.
  await page.waitForTimeout(2500 + viewDelayMs);
  return { ctx, page, meetings, refused, errors };
}

const body = (page) => page.evaluate(() => document.body.innerText);
const heads = async (page) => {
  const t = await body(page);
  return { connections: /(^|\n)My connections(\n|$)/.test(t), meetings: /(^|\n)My meetings(\n|$)/.test(t), contactsCard: t.includes("How the Contacts tab opens"), red: RED.filter((r) => t.includes(r)) };
};
const pageShot = async (page, file) => {
  const vp = page.viewportSize();
  await page.evaluate(() => window.scrollTo(0, 0));
  const h = await page.evaluate(() => Math.ceil(document.scrollingElement.scrollHeight));
  await page.setViewportSize({ width: vp.width, height: Math.min(h, 4000) });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, file) });
  await page.setViewportSize(vp);
};

async function shown(browser, id, label, opts) {
  const s = await scenario(browser, { name: id, ...opts });
  const h = await heads(s.page);
  ok(`${id}${TAG} ${label}: My connections is there`, h.connections);
  ok(`${id}${TAG} …and My meetings is there`, h.meetings);
  ok(`${id}${TAG} …the overview was read`, s.meetings.some((m) => m.action === "overview"), JSON.stringify(s.meetings.map((m) => m.action)));
  ok(`${id}${TAG} …no red error`, h.red.length === 0, h.red.join(" | "));
  ok(`${id}${TAG} …nothing was refused`, s.refused.length === 0, JSON.stringify(s.refused));
  ok(`${id}${TAG} …no page errors`, s.errors.length === 0, s.errors.join(" | "));
  await pageShot(s.page, `${id}-shown${TAG}.png`);
  await s.ctx.close();
}

async function hidden(browser, id, label, opts) {
  const s = await scenario(browser, { name: id, ...opts });
  const h = await heads(s.page);
  ok(`${id}${TAG} ${label}: the rest of My Profile is there`, h.contactsCard);
  ok(`${id}${TAG} …no My connections`, !h.connections);
  ok(`${id}${TAG} …no My meetings`, !h.meetings);
  const forThem = opts.viewAs ? s.meetings.filter((m) => m.targetClientId === opts.viewAs) : s.meetings;
  ok(`${id}${TAG} …portal-meetings was never called${opts.viewAs ? " for the viewed builder" : ""}`, forThem.length === 0, JSON.stringify(s.meetings));
  ok(`${id}${TAG} …nothing was refused, so no red box even for a moment`, s.refused.length === 0, JSON.stringify(s.refused));
  ok(`${id}${TAG} …no red error`, h.red.length === 0, h.red.join(" | "));
  ok(`${id}${TAG} …no page errors`, s.errors.length === 0, s.errors.join(" | "));
  await pageShot(s.page, `${id}-hidden${TAG}.png`);
  await s.ctx.close();
}

const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();
const ONLY = process.env.SS_GATE_SCENARIOS ? process.env.SS_GATE_SCENARIOS.split(",") : null;
const run = (id) => !ONLY || ONLY.includes(id);
try {
  if (run("E")) await hidden(browser, "E", "an operator viewing a builder without the CRM, its plan 1.5 s late", { client: CRM_CLIENT, viewAs: BARE_CLIENT, viewDelayMs: 1500 });
  if (run("F")) await shown(browser, "F", "an operator viewing a builder with the CRM", { client: BARE_CLIENT, viewAs: CRM_CLIENT });
} finally {
  await browser.close();
}
console.log(`\nshots: ${shots}`);
const f = failed();
console.log(`${f.length ? "FAILED" : "OK"} — ${f.length} failed`);
process.exit(f.length ? 1 : 0);
