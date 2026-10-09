// Workstream 2, phases 6 and 8 on the COMPILED portal: Settings -> Phone's "Bring your number" card,
// the operator's "Adopt a moved number", the Caller ID card's CNAM row and business-profile form, and
// the operator console's Bring-your-number requests. Driven for real against portal-settings and
// admin-catalog answers stubbed at the network layer (no login, nothing leaves the machine). The
// stub runs the REAL rules (numberRequests.ts parsePortRequest / portRequestView / parseAdoptNumber,
// twilioTrustHub.ts parseCnamDisplayName / validateIntake), so what the page sends is what the server
// takes.
//
//   A  a builder (phone edit): the card is drawn under Caller ID; Send stays off until the request is
//      complete, and while a box holds a run of digits (a PIN or an account number), with a warning;
//      the request goes out as exactly the six fields (no PIN, password, account number or bill key)
//      and is accepted by the real parser; the list then shows it as "Sent to Structure Studio"; no
//      "Adopt a moved number" and no CNAM or profile buttons for a builder; CNAM reads "Not registered";
//   B  an operator: "Adopt a moved number" sends phone_adopt_number with the typed number; the CNAM name
//      form refuses "&" before anything is sent and sends product "cnam" with the name; the business
//      profile form sends phone_trust_profile with the details and the mobile in E.164;
//   C  a server older than phase 8 (no portRequests): no card, no error;
//   D  the operator console's Builders tab lists the open request with what booking the move needs,
//      and "Take it" sends number_request_set in_progress;
//   every scenario: no uncaught page error.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/bringYourNumber.mjs         (exit 0 = every check held)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF } from "./lib.mjs";
import { parseAdoptNumber, parsePortRequest, portRequestView } from "../../supabase/functions/portal-settings/numberRequests.ts";
import { parseCnamDisplayName, validateIntake } from "../../supabase/functions/_shared/twilioTrustHub.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const CLIENT = "demo-tenant";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders", "change_order_approve",
  "build_schedule", "delivery_schedule", "repairs", "commissions", "reports", "phone", "settings_structures", "settings_options",
  "settings_branding", "settings_crm", "settings_quickbooks", "settings_email", "settings_team", "settings_billing"].map((k) => [k, "edit"]));
const TEAM = [{ userId: USER.id, name: "Olive Owner", title: "owner", role: "owner", phoneLevel: "edit", devices: [] }];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const CALLER_ID = { available: true, shakenStir: { registered: false, status: null }, voiceIntegrity: { registered: false, status: null },
  cnam: { available: true, registered: false, status: null, displayName: null }, checkedAt: null };

const { ok, failed, results } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();
const tap = (loc) => loc.click({ timeout: 5000 }).then(() => true, () => false);

async function phonePage(label, S) {
  const calls = [];
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* blocked */ } }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("dialog", (d) => d.accept());
  const state = { portRequests: S.portRequests === undefined ? [] : S.portRequests, callerId: { ...CALLER_ID }, businessProfile: S.businessProfile ?? null };
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, false);
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: "owner", access: ACCESS, prefs: null, phoneStatus: "on", configured: false, branding: { companyName: "Demo Tenant" }, emailReady: true });
      case "phone_settings_get":
        return json(route, {
          ok: true, available: true, scope: "team", phoneStatus: "on", level: "edit", canEdit: true,
          number: { id: "num-1", e164: "+15555550199", textingStatus: "registered", voiceReady: true, callingOnly: true },
          canBuyNumber: true, numbersForSale: true, voiceSetup: true, canSwitchOn: true, canConnect: true, selfServe: false,
          callerId: state.callerId, canManageCallerId: !!S.operator, recording: null, canChangeRecording: false,
          route: null, team: TEAM, suggestedMembers: [USER.id],
          businessProfile: S.operator ? state.businessProfile : null,
          ...(S.old ? {} : { portRequests: state.portRequests, canAdoptNumber: !!S.operator }),
        });
      case "phone_port_request": {
        const p = parsePortRequest(body.request);
        if (!p.ok) return json(route, { error: p.error }, 400);
        const row = { id: "00000000-0000-4000-8000-0000000000a1", numbers: p.value.numbers, current_carrier: p.value.currentCarrier,
          is_lc_phone: p.value.isLcPhone, contact_name: p.value.contactName, contact_email: p.value.contactEmail,
          cutover_window: p.value.cutoverWindow, status: "new", created_at: new Date().toISOString(), handled_at: null };
        state.portRequests = [portRequestView(row), ...state.portRequests];
        return json(route, { ok: true, request: portRequestView(row) });
      }
      case "phone_adopt_number": {
        const e = parseAdoptNumber(body.phoneNumber);
        if (!e) return json(route, { error: "Enter the moved number." }, 400);
        return json(route, { ok: true, number: { id: "num-1", e164: e, voiceReady: true, callingOnly: true } });
      }
      case "phone_trust_setup": {
        if (body.product === "cnam") {
          const n = parseCnamDisplayName(body.cnam && body.cnam.displayName);
          if (!n.ok) return json(route, { error: n.error }, 400);
          state.callerId = { ...state.callerId, cnam: { available: true, registered: true, status: "pending-review", displayName: n.name } };
        }
        return json(route, { ok: true, product: body.product, status: "pending-review", submitted: true, created: true, callerId: state.callerId });
      }
      case "phone_trust_profile": {
        const problems = validateIntake(body.intake || {}, true);
        if (problems.length) return json(route, { error: problems[0], problems }, 400);
        state.businessProfile = { exists: true, legalBusinessName: body.intake.legalBusinessName, websiteUrl: body.intake.websiteUrl, einLast4: "6789" };
        return json(route, { ok: true, created: true, finished: false, businessProfile: state.businessProfile });
      }
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  await page.goto(`${BASE}/portal/settings/phone`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
  await page.waitForSelector("[data-ss-phone-callerid]", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(300);
  return { label, page, ctx, calls, pageErrors, state };
}

try {
  // ── A: a builder ──
  const A = await phonePage("A", { operator: false });
  const card = A.page.locator("[data-ss-phone-bring]");
  ok("A1 the Bring your number card is drawn for a builder with phone edit", (await card.count()) === 1);
  ok("A1b it sits under the Caller ID card", await A.page.evaluate(() => {
    const c = document.querySelector("[data-ss-phone-callerid]"), b = document.querySelector("[data-ss-phone-bring]");
    return !!c && !!b && !!(c.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  await tap(A.page.locator("[data-ss-phone-bring-open]"));
  const send = A.page.locator("[data-ss-phone-bring-send]");
  ok("A2 Send is off until the request is filled in", await send.isDisabled());
  await A.page.fill("[data-ss-phone-bring-numbers]", "(816) 555-0123, 816-555-0124");
  await A.page.fill("[data-ss-phone-bring-carrier]", "Verizon");
  await A.page.selectOption("[data-ss-phone-bring-lc]", "no");
  await A.page.fill("[data-ss-phone-bring-name]", "Pat Example");
  await A.page.fill("[data-ss-phone-bring-email]", "pat@builder.example.test");
  await A.page.fill("[data-ss-phone-bring-window]", "PIN is 482913");
  ok("A3 a run of digits (a PIN) turns Send off and says why", await send.isDisabled()
    && /looks like an account number or a PIN/.test(await A.page.locator("[data-ss-phone-bring-nosecrets]").innerText()));
  await A.page.fill("[data-ss-phone-bring-window]", "Weekday evenings after the 20th");
  ok("A4 with it gone, Send is on", !(await send.isDisabled()));
  await tap(send);
  await A.page.waitForSelector('[data-ss-phone-bring-request="new"]', { timeout: 8000 }).catch(() => {});
  const sentReq = A.calls.filter((c) => c.action === "phone_port_request").pop();
  const keys = sentReq ? Object.keys(sentReq.request).sort() : [];
  ok("A5 the request is exactly the six fields", JSON.stringify(keys) === JSON.stringify(["contactEmail", "contactName", "currentCarrier", "cutoverWindow", "isLcPhone", "numbers"]), JSON.stringify(sentReq));
  ok("A6 no key or value carries a PIN, password, account number or bill", !!sentReq && !/pin|password|account|bill|\d{5,}/i.test(JSON.stringify({ ...sentReq.request, numbers: [] })), JSON.stringify(sentReq));
  ok("A7 the numbers as typed, GoHighLevel answered no", !!sentReq && sentReq.request.numbers.length === 2 && sentReq.request.isLcPhone === false);
  const t = await card.innerText();
  ok("A8 the list shows the request as sent, with both numbers", /\(816\) 555-0123, \(816\) 555-0124/.test(t) && /Sent to Structure Studio/.test(t), t);
  ok("A9 and says how long a carrier move takes", /at least a week/.test(t), t);
  ok("A10 a builder gets no Adopt a moved number", (await A.page.locator("[data-ss-phone-adopt]").count()) === 0);
  ok("A11 CNAM reads Not registered, with no Register button for a builder",
    /Caller name \(CNAM\)/.test(await A.page.locator('[data-ss-phone-trust="cnam"]').innerText())
      && (await A.page.locator('[data-ss-phone-trust-register="cnam"]').count()) === 0);
  ok("A12 no business-profile form for a builder", (await A.page.locator("[data-ss-phone-business-profile]").count()) === 0);
  ok("A13 no uncaught page errors", A.pageErrors.length === 0, A.pageErrors.join(" | "));
  await A.ctx.close();

  // ── B: an operator ──
  const B = await phonePage("B", { operator: true, businessProfile: { exists: false, legalBusinessName: "Demo Builder LLC", websiteUrl: "https://builder.example.test", einLast4: "" } });
  ok("B1 an operator gets Adopt a moved number", (await B.page.locator("[data-ss-phone-adopt]").count()) === 1);
  await B.page.fill("[data-ss-phone-adopt-number]", "(816) 555-0123");
  await tap(B.page.locator("[data-ss-phone-adopt-send]"));
  await B.page.waitForTimeout(800);
  const adopt = B.calls.filter((c) => c.action === "phone_adopt_number").pop();
  ok("B2 it sends phone_adopt_number with the typed number", !!adopt && adopt.phoneNumber === "(816) 555-0123", JSON.stringify(adopt));
  ok("B3 and says it was added", /Added/.test(await B.page.locator("[data-ss-phone-adopt]").innerText()));
  await tap(B.page.locator('[data-ss-phone-trust-register="cnam"]'));
  await B.page.fill("[data-ss-phone-cnam-input]", "Acme & Sons");
  ok("B4 a name with '&' is refused before anything is sent", await B.page.locator("[data-ss-phone-cnam-submit]").isDisabled()
    && !B.calls.some((c) => c.action === "phone_trust_setup"));
  await B.page.fill("[data-ss-phone-cnam-input]", "Acme Barns");
  await tap(B.page.locator("[data-ss-phone-cnam-submit]"));
  await B.page.waitForSelector('[data-ss-phone-cnam-name]', { timeout: 8000 }).catch(() => {});
  const cnam = B.calls.filter((c) => c.action === "phone_trust_setup").pop();
  ok("B5 CNAM sends product cnam with the name", !!cnam && cnam.product === "cnam" && cnam.cnam && cnam.cnam.displayName === "Acme Barns", JSON.stringify(cnam));
  ok("B6 and the row shows the name and Waiting for Twilio", /Acme Barns/.test(await B.page.locator('[data-ss-phone-trust="cnam"]').innerText())
    && /Waiting for Twilio/.test(await B.page.locator('[data-ss-phone-trust="cnam"]').innerText()));
  await tap(B.page.locator("[data-ss-phone-business-profile-open]"));
  const fill = async (k, v) => B.page.fill(`[data-ss-phone-bp="${k}"]`, v);
  ok("B7 the profile form starts from the saved name and website",
    (await B.page.inputValue('[data-ss-phone-bp="legalBusinessName"]')) === "Demo Builder LLC" && (await B.page.inputValue('[data-ss-phone-bp="websiteUrl"]')) === "https://builder.example.test");
  await fill("ein", "12-3456789"); await fill("street", "1 Test Way"); await fill("city", "Testville"); await fill("region", "mo");
  await fill("postalCode", "64101"); await fill("repFirstName", "Pat"); await fill("repLastName", "Example");
  await fill("repEmail", "pat@builder.example.test"); await fill("repPhone", "5555550100");
  await tap(B.page.locator("[data-ss-phone-business-profile-submit]"));
  await B.page.waitForTimeout(800);
  const prof = B.calls.filter((c) => c.action === "phone_trust_profile").pop();
  ok("B8 the form sends phone_trust_profile with the details, the state upper-case and the mobile in E.164",
    !!prof && prof.intake.repPhone === "+15555550100" && prof.intake.region === "MO" && prof.intake.ein === "12-3456789", JSON.stringify(prof && { ...prof.intake, ein: "…" }));
  ok("B9 accepted by the real rules, the form closes", (await B.page.locator("[data-ss-phone-business-profile]").count()) === 0);
  ok("B10 no uncaught page errors", B.pageErrors.length === 0, B.pageErrors.join(" | "));
  await B.ctx.close();

  // ── C: an older server ──
  const C = await phonePage("C", { operator: false, old: true });
  ok("C1 a server without phase 8 draws no Bring your number card", (await C.page.locator("[data-ss-phone-bring]").count()) === 0);
  ok("C2 no uncaught page errors", C.pageErrors.length === 0, C.pageErrors.join(" | "));
  await C.ctx.close();

  // ── D: the operator console ──
  {
    const calls = [];
    const pageErrors = [];
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
    await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* blocked */ } }, [REF, SESSION]);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    let status = "new";
    await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
    const handler = async (route) => {
      const req = route.request();
      const url = req.url();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
      let body = {};
      try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
      const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
      if (rpc) return json(route, rpc[1] === "is_operator" ? true : rpc[1] === "log_error" ? null : false);
      if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: "harness-internal", role: "owner" }]);
      if (url.includes("/rest/v1/")) return json(route, []);
      if (url.includes("/auth/v1/user")) return json(route, USER);
      if (url.includes("/auth/v1/")) return json(route, SESSION);
      if (url.includes("/portal-billing")) return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
      if (url.includes("/portal-settings")) {
        if (body.action === "status") return json(route, { ok: true, clientId: "harness-internal", role: "owner", access: {}, prefs: null, configured: false, branding: {} });
        return json(route, { ok: true });
      }
      if (url.includes("/admin-catalog")) {
        if (/[?&]warm=1/.test(url)) return json(route, { ok: true });
        calls.push(body);
        if (body.action === "list_clients") return json(route, { ok: true, clients: [{ client_id: "demo-builder", company_name: "Demo Builder" }], features: [] });
        if (body.action === "get_master") return json(route, { ok: true, layoutItemTypes: [] });
        if (body.action === "number_requests_list") {
          return json(route, { ok: true, installed: true, requests: [{ id: "00000000-0000-4000-8000-0000000000a1", clientId: "demo-builder", companyName: "Demo Builder",
            numbers: ["+18165550123"], currentCarrier: "Verizon", isLcPhone: false, contactName: "Pat Example", contactEmail: "pat@builder.example.test",
            cutoverWindow: "after the 20th", status, createdAt: new Date().toISOString(), handledAt: null }] });
        }
        if (body.action === "number_request_set") { status = body.status; return json(route, { ok: true, id: body.id, status }); }
        return json(route, { ok: true });
      }
      return json(route, { ok: true });
    };
    await page.route(`**/${REF}.supabase.co/**`, handler);
    await page.route(`**/${REF}.functions.supabase.co/**`, handler);
    await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
    await page.goto(`${BASE}/portal/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
    const reqCard = page.locator("[data-adm-number-requests]");
    await reqCard.waitFor({ timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(300);
    const t2 = await reqCard.innerText().catch(() => "");
    ok("D1 the Builders tab lists the open request: builder, number, what booking it needs, who approves", /Demo Builder/.test(t2) && /\+18165550123/.test(t2)
      && /Verizon: a Twilio Port In/.test(t2) && /Pat Example/.test(t2) && /\(1 open\)/.test(t2), t2.slice(0, 500));
    await tap(reqCard.getByRole("button", { name: "Take it" }));
    await page.waitForTimeout(600);
    const set = calls.filter((c) => c.action === "number_request_set").pop();
    ok("D2 Take it sends number_request_set in_progress", !!set && set.status === "in_progress" && set.id === "00000000-0000-4000-8000-0000000000a1", JSON.stringify(set));
    ok("D3 and the request reads Being moved", /Being moved/.test(await reqCard.innerText()));
    ok("D4 no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
