// The operator console's "Twilio account" card (Workstream 2, phase 9: AdmTwilioAccount in
// portal/07-admin.jsx), driven for real on the COMPILED portal as a platform operator on
// /portal/admin/account.
//
// What it proves, against admin-catalog answers stubbed at the network layer (no login, nothing
// leaves the machine; the supportConsoles.mjs shape):
//   A  no account yet, switch off: the card says so and offers "Create Twilio account"; pressing it
//      (after its confirm) sends twilio_account_provision with the builder's id as confirmClientId,
//      and the card then shows the active sub, its MASKED SID, its push credentials and the Suspend
//      and Close buttons;
//   B  a builder that stays on the parent (it already has a number there): no Create button, and
//      the reason is said;
//   C  an active sub missing push credentials: "Add the missing push credentials"; Close asks for
//      the builder's id, sends nothing for a wrong one, and sends twilio_account_close with it for
//      the right one; Check token asks twilio_account_get with check and shows the verdicts;
//   every scenario: no uncaught page error.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/twilioAccountCard.mjs        (exit 0 = every check held)
// SS_SHOT_DIR=<dir> also saves a picture of the card after each scenario.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");

const CLIENT = "harness-builder";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000007", aud: "authenticated", role: "authenticated", email: "operator@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

const NONE = { switchOn: false, kind: "none", status: null, step: null, lastError: null, lockedUntil: null, accountSid: null, apiKeySid: null, twimlAppSid: null,
  push: { apns_dev: false, apns_prod: false, fcm: false }, pushSkipped: [], sink: false, subscription: false, parentReason: null, liveNumbers: 0, createdAt: null, updatedAt: null };
const ACTIVE = { ...NONE, kind: "sub", status: "active", step: "done", accountSid: "AC…1a2b", apiKeySid: "SK…3c4d", twimlAppSid: "AP…5e6f",
  push: { apns_dev: true, apns_prod: true, fcm: true }, sink: true, subscription: true };

const { ok, failed, results } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

async function run(label, S) {
  const calls = [];
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s, client, promptAnswers]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    try { sessionStorage.setItem("ss.admin.clientId", client); } catch (_e) { /* storage blocked */ }
    window.__confirms = [];
    window.__prompts = [];
    window.confirm = (m) => { window.__confirms.push(String(m)); return true; };
    const answers = promptAnswers.slice();
    window.prompt = (m) => { window.__prompts.push(String(m)); return answers.length ? answers.shift() : null; };
  }, [REF, SESSION, CLIENT, S.prompts || []]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  let account = S.account;
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      if (rpc[1] === "is_operator") return json(route, true);
      if (rpc[1] === "is_support_operator") return json(route, false);
      if (rpc[1] === "can_open_projects") return json(route, false);
      return json(route, null);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: "harness-internal", role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: "harness-internal", role: "owner", access: {}, prefs: null, configured: false, branding: {} });
      return json(route, { ok: true });
    }
    if (url.includes("/admin-catalog")) {
      if (/[?&]warm=1/.test(url)) return json(route, { ok: true });
      calls.push(body);
      if (body.action === "list_clients") return json(route, { ok: true, clients: [{ client_id: CLIENT, company_name: "Harness Sheds" }], features: [] });
      if (body.action === "get_master") return json(route, { ok: true, layoutItemTypes: [] });
      if (body.action === "get_client_catalog") return json(route, { ok: true, styles: [], sizes: [], items: [] });
      if (body.action === "twilio_account_get") {
        return json(route, { ok: true, account: body.check ? { ...account, tokenCheck: { authToken: "ok", apiKey: "rejected" } } : account });
      }
      if (body.action === "twilio_account_provision") {
        account = { ...ACTIVE, pushSkipped: [] };
        return json(route, { ok: true, pushSkipped: [], account });
      }
      if (body.action === "twilio_account_close") {
        account = { ...account, status: "closed" };
        return json(route, { ok: true, status: "closed", account });
      }
      if (body.action === "twilio_account_suspend") {
        account = { ...account, status: "suspended" };
        return json(route, { ok: true, status: "suspended", account });
      }
      return json(route, { ok: true });
    }
    if (url.includes("/operator-portal")) return json(route, { ok: true, clients: [] });
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));

  await page.goto(`${BASE}/portal/admin/account`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  const card = page.locator("[data-adm-twilio-account]");
  await card.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector("[data-adm-twilio-account]").innerText.includes("Loading…"), null, { timeout: 15000 });
  const out = { label, calls, pageErrors, page, card, ctx };
  out.text = async () => (await card.innerText());
  out.button = (name) => card.getByRole("button", { name });
  return out;
}

try {
  // ── A ──
  const A = await run("A", { account: NONE });
  let t = await A.text();
  ok("A: the switch is shown as off", /TWILIO_SUBACCOUNTS off/.test(t), t.slice(0, 200));
  ok("A: no account yet is said", /None yet/.test(t));
  ok("A: Create is offered; Suspend and Close are not", await A.button("Create Twilio account").count() === 1
    && await A.button("Suspend").count() === 0 && await A.button("Close…").count() === 0);
  await A.button("Create Twilio account").click();
  await A.page.waitForFunction(() => /AC…1a2b/.test(document.querySelector("[data-adm-twilio-account]").innerText), null, { timeout: 10000 });
  const prov = A.calls.find((c) => c.action === "twilio_account_provision");
  ok("A: Create sends twilio_account_provision with the builder's id typed in", !!prov && prov.clientId === CLIENT && prov.confirmClientId === CLIENT, JSON.stringify(prov));
  const confirms = await A.page.evaluate(() => window.__confirms);
  ok("A: it asked first, and said this is a TEST account while the switch is off", confirms.length === 1 && /TEST account/.test(confirms[0]), JSON.stringify(confirms));
  t = await A.text();
  ok("A: the card now shows the active sub with its masked SID", /active/.test(t) && /AC…1a2b/.test(t), t.slice(0, 300));
  ok("A: its push credentials and event stream", /iPhone dev/.test(t) && /Android/.test(t) && /subscription/.test(t));
  ok("A: Suspend and Close are now offered, Create is not", await A.button("Suspend").count() === 1 && await A.button("Close…").count() === 1
    && await A.button("Create Twilio account").count() === 0);
  ok("A: no uncaught page errors", A.pageErrors.length === 0, A.pageErrors.join(" | "));
  if (process.env.SS_SHOT_DIR) await A.card.screenshot({ path: join(process.env.SS_SHOT_DIR, "twilio-card-active.png") });
  await A.ctx.close();

  // ── B ──
  const B = await run("B", { account: { ...NONE, parentReason: "a live number" } });
  t = await B.text();
  ok("B: a builder on the parent is told why", /Stays on our main account: it has a live number\./.test(t), t.slice(0, 200));
  ok("B: and offered no Create", await B.button("Create Twilio account").count() === 0);
  ok("B: no uncaught page errors", B.pageErrors.length === 0, B.pageErrors.join(" | "));
  if (process.env.SS_SHOT_DIR) await B.card.screenshot({ path: join(process.env.SS_SHOT_DIR, "twilio-card-parent.png") });
  await B.ctx.close();

  // ── C ──
  const C = await run("C", { account: { ...ACTIVE, switchOn: true, push: { apns_dev: false, apns_prod: true, fcm: true }, pushSkipped: ["apns_dev"] }, prompts: ["someone-else", CLIENT] });
  t = await C.text();
  ok("C: an active sub missing a push credential offers to add it", await C.button("Add the missing push credentials").count() === 1, t.slice(0, 300));
  ok("C: the missing one is shown as none", /iPhone dev: none/.test(t));
  await C.button("Check token").click();
  await C.page.waitForFunction(() => /accepted/.test(document.querySelector("[data-adm-twilio-account]").innerText), null, { timeout: 10000 });
  ok("C: Check token asks twilio_account_get with check", C.calls.some((c) => c.action === "twilio_account_get" && c.check === true));
  t = await C.text();
  ok("C: and shows each verdict", /auth token\s*accepted/.test(t) && /rejected/.test(t), t);
  await C.button("Close…").click();
  await C.page.waitForTimeout(400);
  ok("C: a wrong id closes nothing", !C.calls.some((c) => c.action === "twilio_account_close"));
  await C.button("Close…").click();
  await C.page.waitForFunction(() => /closed/.test(document.querySelector("[data-adm-twilio-account]").innerText), null, { timeout: 10000 });
  const close = C.calls.find((c) => c.action === "twilio_account_close");
  ok("C: the right id sends twilio_account_close with it", !!close && close.confirmClientId === CLIENT, JSON.stringify(close));
  const prompts = await C.page.evaluate(() => window.__prompts);
  ok("C: the prompt says it is for good and names the numbers", prompts.length === 2 && /for good/.test(prompts[0]) && /numbers/.test(prompts[0]), JSON.stringify(prompts));
  ok("C: a closed sub offers no more buttons but Create is not back", await C.button("Close…").count() === 0 && await C.button("Suspend").count() === 0);
  ok("C: no uncaught page errors", C.pageErrors.length === 0, C.pageErrors.join(" | "));
  await C.ctx.close();
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
