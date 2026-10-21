// What the two operator consoles say after "Delete builder" (2026-10-21, board item "delete_client
// leaves 7 per-tenant tables behind, including crm_contacts"), driven for real on the COMPILED
// pages against admin-catalog answers stubbed at the network layer (no login, nothing is deleted,
// nothing leaves the machine; the twilioAccountCard.mjs shape):
//   A  portal /console/account: the dialog describes the real scope (no "nine tables"; says some data
//      stays); a delete that left data behind flashes what was kept, what was left behind, the steps
//      by hand, the failed steps and the tables it could not check, and the message stays until
//      Dismiss;
//   B  portal: a clean delete flashes no report and clears itself as before;
//   C  /admin.html (the break-glass console): the same report after its own delete, sticky too, and
//      its dialog no longer says "all of its data";
//   every scenario: no uncaught page error.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/deleteClientReport.mjs       (exit 0 = every check held)
// SS_SHOT_DIR=<dir> also saves a picture of each result.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, serveAppRoutes } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");

const CLIENT = "harness-builder";
const PASSWORD = "harness-password";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000021", aud: "authenticated", role: "authenticated", email: "operator@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// The shape delete_client answers with since 10-21 (admin-catalog, from _shared/tenantTables.ts).
const MESSY = {
  ok: true, clientId: CLIENT,
  deleted: { designs: 3, client_configs: 1 },
  gateway: { subscriptionsCancelled: 0, vaultDeleted: false, alreadyGone: 0 },
  retained: { orders: 2, design_acceptances: 1 },
  leftBehind: { crm_contacts: 8, tenant_setup_items: 25 },
  files: { retained: ["signatures"], leftBehind: ["inventory-photos"] },
  cleanup: { byHand: ["resend_domain", "quickbooks"], failed: ["storage:branding", "logins:1"] },
  notCounted: ["sms_messages"],
};
const CLEAN = { ok: true, clientId: CLIENT, deleted: { designs: 1, client_configs: 1 }, gateway: { subscriptionsCancelled: 0, vaultDeleted: false, alreadyGone: 0 } };

const { ok, failed, results } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

async function open(path, deleteAnswer) {
  const calls = [];
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s, client]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    try { sessionStorage.setItem("ss.admin.clientId", client); } catch (_e) { /* storage blocked */ }
    window.confirm = () => true;
  }, [REF, SESSION, CLIENT]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  let deletedOnce = false;
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
      const clients = deletedOnce ? [] : [{ client_id: CLIENT, company_name: "Harness Sheds" }];
      if (body.action === "list_clients") return json(route, { ok: true, clients, features: [] });
      if (body.action === "get_master") return json(route, { ok: true, layoutItemTypes: [] });
      if (body.action === "get_client_catalog") return json(route, { ok: true, styles: [], sizes: [], items: [] });
      if (body.action === "twilio_account_get") return json(route, { error: "Unknown action: twilio_account_get" }, 400);
      if (body.action === "delete_client") { deletedOnce = true; return json(route, deleteAnswer); }
      return json(route, { ok: true });
    }
    if (url.includes("/operator-portal")) return json(route, { ok: true, clients: [] });
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  return { page, ctx, calls, pageErrors };
}

const flashText = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll("div")].find((d) => /^(Deleted “|Builder ")/.test(d.innerText || ""));
  return el ? el.innerText : "";
});

async function portalDelete(answer) {
  const s = await open("/console/account", answer);
  const { page } = s;
  await page.getByRole("button", { name: "Delete this builder…" }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Delete this builder…" }).click();
  const dialog = page.locator('[aria-labelledby="adm-del-ttl"]');
  await dialog.waitFor({ timeout: 10000 });
  s.dialogText = await dialog.innerText();
  await dialog.locator("input").first().fill(CLIENT);
  await dialog.locator('input[type="password"]').fill(PASSWORD);
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("div")].some((d) => /^Deleted “/.test(d.innerText || "")), null, { timeout: 15000 });
  s.flash = await flashText(page);
  return s;
}

try {
  // ── A ──
  const A = await portalDelete(MESSY);
  ok("A: the dialog no longer counts tables", !/nine tables/.test(A.dialogText), A.dialogText);
  ok("A: the dialog says some data stays, and what kind", /Some data stays/.test(A.dialogText) && /financial and signed records are kept on purpose/.test(A.dialogText)
    && /CRM\s+contacts, messages, calls and customer logins wait on a retention decision/.test(A.dialogText), A.dialogText);
  const del = A.calls.find((c) => c.action === "delete_client");
  ok("A: the delete was asked for with the typed id and the password", !!del && del.clientId === CLIENT && del.confirmClientId === CLIENT && del.adminPassword === PASSWORD, JSON.stringify(del));
  ok("A: kept on purpose, with counts and the signatures files",
    A.flash.includes("Kept on purpose (financial and signed records): 3 rows in 2 tables (orders 2, design_acceptances 1), plus files in signatures."), A.flash);
  ok("A: left behind, with counts and the files",
    A.flash.includes("Left behind (CRM, messages and customer logins wait on a retention decision; the rest is not removed yet): 33 rows in 2 tables (crm_contacts 8, tenant_setup_items 25), plus files in inventory-photos."), A.flash);
  ok("A: the steps by hand, in words", A.flash.includes("Still to do by hand: remove their sending domain at Resend; disconnect QuickBooks at Intuit."), A.flash);
  ok("A: the failed steps, in words", A.flash.includes("Did not finish: the file cleanup in branding; deleting 1 login."), A.flash);
  ok("A: what could not be checked", A.flash.includes("Could not check sms_messages."), A.flash);
  if (process.env.SS_SHOT_DIR) await A.page.screenshot({ path: join(process.env.SS_SHOT_DIR, "delete-report-portal.png") });
  await A.page.waitForTimeout(7000);
  ok("A: the report is still there after the six-second auto-clear", (await flashText(A.page)).includes("Left behind"));
  await A.page.getByRole("button", { name: "Dismiss" }).click();
  await A.page.waitForTimeout(300);
  ok("A: Dismiss clears it", (await flashText(A.page)) === "");
  ok("A: no uncaught page errors", A.pageErrors.length === 0, A.pageErrors.join(" | "));
  await A.ctx.close();

  // ── B ──
  const B = await portalDelete(CLEAN);
  ok("B: a clean delete says only what was deleted", /^Deleted “harness-builder” \(1 designs, 1 client_configs\)\.$/.test(B.flash.trim()), B.flash);
  ok("B: no Dismiss button", (await B.page.getByRole("button", { name: "Dismiss" }).count()) === 0);
  await B.page.waitForTimeout(6800);
  ok("B: and it clears itself as before", (await flashText(B.page)) === "");
  ok("B: no uncaught page errors", B.pageErrors.length === 0, B.pageErrors.join(" | "));
  await B.ctx.close();

  // ── C ──
  const C = await open("/admin.html", MESSY);
  await C.page.locator('input[type="password"]').first().fill(PASSWORD);
  await C.page.getByRole("button", { name: "Unlock" }).click();
  await C.page.locator("select").first().waitFor({ timeout: 15000 });
  await C.page.waitForFunction((id) => [...document.querySelectorAll("select option")].some((o) => o.value === id), CLIENT, { timeout: 15000 });
  await C.page.locator("select").first().selectOption(CLIENT);
  await C.page.getByRole("button", { name: "Delete builder" }).click();
  const cText = await C.page.evaluate(() => document.body.innerText);
  ok("C: the console's dialog no longer promises all of its data", !/and all of its data/.test(cText) && /Some data stays:/.test(cText), cText.slice(0, 400));
  await C.page.locator(`input[placeholder='Type "${CLIENT}" to confirm']`).fill(CLIENT);
  await C.page.locator(`input[placeholder='Type "${CLIENT}" to confirm']`).press("Enter");
  await C.page.waitForFunction(() => [...document.querySelectorAll("div")].some((d) => /^Builder "/.test(d.innerText || "")), null, { timeout: 15000 });
  const cFlash = await flashText(C.page);
  ok("C: the console shows the same report", cFlash.includes("Kept on purpose (financial and signed records): 3 rows in 2 tables")
    && cFlash.includes("Still to do by hand: remove their sending domain at Resend; disconnect QuickBooks at Intuit.")
    && cFlash.includes("Did not finish: the file cleanup in branding; deleting 1 login.") && cFlash.includes("Could not check sms_messages."), cFlash);
  if (process.env.SS_SHOT_DIR) await C.page.screenshot({ path: join(process.env.SS_SHOT_DIR, "delete-report-console.png") });
  await C.page.waitForTimeout(3200);
  ok("C: and keeps it past its 2.5-second auto-clear", (await flashText(C.page)).includes("Left behind"));
  ok("C: no uncaught page errors", C.pageErrors.length === 0, C.pageErrors.join(" | "));
  await C.ctx.close();
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
