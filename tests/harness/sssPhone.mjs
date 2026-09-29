// SSS Phone in the portal, driven for real on the COMPILED portal (2026-09-29).
//
// What it proves, each against the artifact the browser actually loads:
//   A. Call on a contact hands the number to the SSS Phone extension (chrome.runtime.sendMessage,
//      SPEC section 5) with all four fields, and the page does not move.
//   B. SMS on the same contact opens the thread in SSS Phone, with a way back to the composer.
//   C. No extension installed: Call shows the "Install SSS Phone" card; SMS keeps today's
//      composer with a small install tip.
//   D. The extension signed in as somebody else: Call says so in words; SMS falls back to the
//      composer and says why.
//   E. Operator view-as: Call AND SMS are greyed with the plan's hint, and nothing is sent.
//   F. Calling switched off for the account: Call is greyed and says so.
//   G. Settings → Phone renders the owner's one-time setup, and Save / the on-off switch /
//      "Sign out all devices" send what the server expects (validated by the REAL parseRoute).
//   H. The Calls page renders My and Team, Team with the whole-business line.
//   I. On a phone's browser, Call opens the SSS Phone app instead of messaging an extension.
//   J. Call on the contact LIST: the same four fields, the same greyed hints (view-as, calling
//      off) as the record page, and the page does not move.
//   K. A voicemail in the contact timeline plays from the phone-api Worker
//      (<PHONE_API_BASE>/voicemails/<id>/audio, the session in the Authorization header, played
//      from a blob: URL; review SSB-7), fetched only when Play is pressed, and not in view-as or
//      with calling off.
//   L. Settings -> Phone, plan phase 6: "Connect this number for calls", and the calling-only
//      number search + purchase (the purchase is a STUB here; nothing is bought).
//   M. The rollout on the Phone tab (review SSB-1): an owner the server will not let switch
//      calling on sees no switch, no Connect and no Buy, and is told why; and turning calling off
//      with a connected number moves it to voicemail, with "Send calls to voicemail" when that
//      move did not finish (review SSB-2).
//   N. Settings -> Phone, Caller ID (plan section 14, phase 6): everyone on the team screen sees
//      where SHAKEN/STIR and Voice Integrity stand; only an operator (canManageCallerId) gets
//      Register / Check status, and they send phone_trust_setup / phone_trust_status (STUBS; no
//      Twilio). Before migration 255 the card says it is not available.
//   O. Settings -> Text Messaging at "pick your number" with a CALLING-ONLY number: it offers to
//      use that number instead of a search, and buy_number goes out with no number picked (the
//      server adopts it; portal-sms is a STUB here). At number_pending / active with the number
//      still calling-only (an adoption whose last write failed, review BE-5), it offers to FINISH.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine) — the shape
// crmContactDeal.mjs uses. The extension is stubbed as window.chrome.runtime before the app
// boots, answering exactly the SPEC section 5 messages.
//
//   python -m http.server 8131 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8131 node tests/harness/sssPhone.mjs   (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/sss-phone (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an older
// portal.app.compiled.js> serves that file instead, which is how to prove the checks can fail:
// against the artifact before this change, A-I all fail (Call is the greyed "arrives with the
// phone integration" tab, and there is no Phone tab or Calls page).
//
// Fixtures are obviously fake (555-01xx numbers, example.test), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";
import { buildCallsReport, parseRoute } from "../../supabase/functions/portal-settings/phone.ts";

const CLIENT = "demo-tenant";
const VIEWED = "demo-builder";
const CONTACT_ID = "4512ed87-fb75-4645-81d6-9268eb73e305";
const VM_ID = "5f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5";
const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const REP = "00000000-0000-4000-8000-00000000000b";
const CREW = "00000000-0000-4000-8000-00000000000c";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER_ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders",
  "change_order_approve", "build_schedule", "delivery_schedule", "repairs", "commissions", "reports", "phone",
  "settings_structures", "settings_options", "settings_branding", "settings_crm", "settings_quickbooks",
  "settings_email", "settings_team", "settings_billing"].map((k) => [k, "edit"]));

// One deal, so the contact's SMS tab can be used: texting from a contact record files against a
// picked deal (the 2026-09-02 picker rule), and that rule is untouched by SSS Phone.
const DESIGN = {
  short_code: "SS-TEST00001", created_at: "2026-09-17T15:00:00Z", updated_at: "2026-09-17T15:00:00Z",
  status: "sent", selections: { style: "Utility", size: "10x12" }, expected_close_date: null,
  total_cents: 512300, ghl_estimate_number: null, image_url: null, ss_quote_number: "SSQ-1001",
  ss_quote_pdf_url: null, ss_invoice_sent_at: null, ss_invoice_requested_at: null,
  contact_id: CONTACT_ID, contact: { name: "Pat Example", phone: "(555) 555-0142", email: "pat@example.test" },
};
// The same deal as the Contacts LIST reads it (LeadsTable: sb.from("designs"), SEL_LIST_COLS).
const LIST_ROW = {
  short_code: DESIGN.short_code, created_at: DESIGN.created_at, updated_at: DESIGN.updated_at, status: "sent",
  contact: DESIGN.contact, sel_style: "utility", sel_size: "10x12", ghl_estimate_number: null, contact_id: CONTACT_ID,
};
const CONTACT = { id: CONTACT_ID, name: "Pat Example", phone: "(555) 555-0142", email: "pat@example.test", phone_digits: "5555550142", owner_user_id: null, sms_opt_out_at: null, first_seen_at: "2026-09-01T12:00:00Z" };
const FEED = [
  { id: "pc:1", type: "call_missed", at: "2026-09-28T15:00:00Z", title: "Missed call from +15555550142", body: "Nobody answered", icon: "call_missed" },
  { id: "pc:2", type: "call", at: "2026-09-28T16:00:00Z", title: "Call to +15555550142", body: "Talked 3m 12s · by Olive Owner", icon: "call" },
  { id: "pc:3", type: "voicemail", at: "2026-09-27T16:00:00Z", title: "Voicemail from +15555550142", body: "42s message · not listened to yet", icon: "voicemail",
    meta: { callId: "call-3", voicemailId: VM_ID, voicemailDeleted: false, listened: false } },
];
const TEAM = [
  { userId: USER.id, name: "Olive Owner", title: "owner", role: "owner", phoneLevel: "edit", devices: [{ platform: "chrome", appVersion: "0.1.0", lastSeenAt: new Date(Date.now() - 86400000).toISOString() }] },
  { userId: REP, name: "Riley Rep", title: "sales_rep", role: "user", phoneLevel: "own", devices: [] },
  { userId: CREW, name: "Casey Crew", title: "crew_member", role: "user", phoneLevel: "none", devices: [] },
];
// Rows for the report, aggregated by the REAL buildCallsReport, so the numbers on screen are the
// shipped rules' numbers.
const CALLS = [
  { id: "c1", direction: "in", status: "missed", placed_by: null, answered_by: null, rang_user_ids: [USER.id, REP], duration_s: null, answered_at: null, contact_id: CONTACT_ID },
  { id: "c2", direction: "in", status: "completed", placed_by: null, answered_by: REP, rang_user_ids: [USER.id, REP], duration_s: 125, answered_at: "2026-09-28T15:00:00Z", contact_id: CONTACT_ID },
  { id: "c3", direction: "out", status: "completed", placed_by: USER.id, answered_by: null, rang_user_ids: [], duration_s: 192, answered_at: "2026-09-28T16:00:00Z", contact_id: CONTACT_ID },
];
const TEXTS = [{ direction: "out", sent_by: USER.id, contact_id: CONTACT_ID }, { direction: "in", sent_by: null, contact_id: CONTACT_ID }];

const { ok, failed } = reporter();
const shots = shotsDir("sss-phone");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

/**
 * One fresh browser context per scenario. Returns { page, calls, sent() }:
 *   calls — every portal-settings body the page posted, in order;
 *   sent() — every message the page handed the (stub) extension.
 */
async function scenario(browser, opts) {
  const {
    operator = false, phoneStatus = "on", extension = "signed_in", who = { user_id: USER.id, client_id: CLIENT },
    userAgent = null, viewport = { width: 1400, height: 1000 },
    // What the server's rollout check lets this caller do (phone_settings_get canSwitchOn /
    // canConnect / canBuyNumber). true = an operator, or after builder launch.
    rolloutOpen = true, numberOverride = null, moveFails = false,
    // Caller ID (N): whether phone_settings_get says this caller may register (an operator), and
    // whether migration 255 is there (callerId.available).
    trustOperator = false, trustAvailable = true,
    // Text Messaging (O): the portal-sms status the SMS tab loads, or null for the default stub.
    smsStatus = null,
  } = opts;
  const ctx = await browser.newContext({ viewport, ...(userAgent ? { userAgent, isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  // THE EXTENSION STUB. "none" = no chrome.runtime at all (Safari, Firefox, Chrome with no
  // extension exposing itself); "absent" = chrome.runtime exists but nothing answers this ID
  // (lastError); "signed_in" / "signed_out" answer SPEC section 5 the way the extension does.
  await ctx.addInitScript((cfg) => {
    window.__sssSent = [];
    window.SS_PHONE_EXTENSION_IDS = [cfg.extId];
    if (cfg.extension === "none") { try { if (window.chrome) delete window.chrome.runtime; } catch (_e) { /* read-only */ } return; }
    const rt = { lastError: undefined };
    rt.sendMessage = (id, msg, cb) => {
      window.__sssSent.push({ id, msg });
      setTimeout(() => {
        if (cfg.extension === "absent" || id !== cfg.extId) {
          rt.lastError = { message: "Could not establish connection. Receiving end does not exist." };
          try { cb(undefined); } finally { rt.lastError = undefined; }
          return;
        }
        const w = cfg.extension === "signed_in" ? cfg.who : null;
        if (msg.type === "sss.ping") { cb({ ok: true, version: "0.1.0", user_id: w ? w.user_id : null, client_id: w ? w.client_id : null }); return; }
        if (!w) { cb({ ok: false, error: "signed_out" }); return; }
        if (msg.user_id !== w.user_id || msg.client_id !== w.client_id) { cb({ ok: false, error: "wrong_user", signed_in_as: "Robin Example" }); return; }
        cb({ ok: true });
      }, 5);
    };
    window.chrome = window.chrome || {};
    try { window.chrome.runtime = rt; } catch (_e) { Object.defineProperty(window, "chrome", { value: { runtime: rt }, configurable: true }); }
  }, { extId: EXT_ID, extension, who });

  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${opts.name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const calls = [];
  const state = {
    phoneStatus, route: null,
    callerId: { available: trustAvailable, shakenStir: { registered: false, status: null }, voiceIntegrity: { registered: false, status: null }, checkedAt: null },
    sms: smsStatus,
    number: opts.noNumber ? null : (numberOverride ?? { id: "num-1", e164: "+15555550199", textingStatus: "registered", voiceReady: false, callingOnly: false }),
  };
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  // THE phone-api WORKER's voicemail audio, stubbed (registered after the abort-everything route,
  // so it wins). Records every request so K can prove nothing is fetched before Play, and that
  // the token travels in the Authorization header and never in the URL.
  const vm = [];
  await page.route("https://phone.structurestudiosuite.com/**", (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization", "access-control-allow-methods": "GET, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors, body: "" });
    vm.push({ url: req.url(), method: req.method(), authorization: req.headers()["authorization"] || null });
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "audio/mpeg" }, body: Buffer.from([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0, 0, 0]) });
  });
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, operator);
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/designs")) return json(route, [LIST_ROW]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: body.targetClientId || CLIENT });
    }
    if (url.includes("/operator-portal")) return json(route, { ok: true, clientId: VIEWED, companyName: "Demo Builder", designs: [{ ...LIST_ROW, selections: DESIGN.selections }], versions: [], capturedLeads: [] });
    if (url.includes("/portal-sms")) {
      if (!state.sms) return json(route, { ok: true });
      calls.push({ fn: "portal-sms", ...body });
      if (body.action === "buy_number") {
        // What the server answers after adopting (SSS Phone phase 6): the number joins the
        // Messaging Service, the registration moves to number_pending. A STUB: nothing at Twilio.
        if (body.phoneNumber) return json(route, { error: "This stub only adopts." }, 400);
        state.sms = { ...state.sms, status: "number_pending", numbers: state.sms.numbers.map((n) => ({ ...n, callingOnly: false })) };
        return json(route, { ok: true, adopted: true, ...state.sms });
      }
      return json(route, { ok: true, ...state.sms });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    const clientId = body.targetClientId || CLIENT;
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId, role: "owner", operatorMode: !!body.targetClientId, access: OWNER_ACCESS, prefs: null,
          phoneStatus: state.phoneStatus, configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Demo Tenant" }, emailReady: true });
      case "crm_record":
        return json(route, {
          ok: true, kind: body.kind, clientId, contact: CONTACT, designs: [DESIGN], orders: [], feed: FEED, focus: [], team: [], people: [], followers: [],
          sms: { ready: true, from: "+15555550199", optedOut: false, consented: true },
          build: [], stages: [], delivery: [], repairs: [],
        });
      case "phone_settings_get":
        return json(route, { ok: true, available: true, scope: "team", phoneStatus: state.phoneStatus, level: "edit", canEdit: true,
          number: state.number, canBuyNumber: rolloutOpen, numbersForSale: true, voiceSetup: true,
          canSwitchOn: rolloutOpen, canConnect: rolloutOpen, selfServe: false,
          callerId: state.callerId, canManageCallerId: trustOperator,
          route: state.route, team: TEAM, suggestedMembers: state.route ? null : [USER.id] });
      // Plan phase 6, caller ID. STUBS: nothing reaches Twilio. The server refuses non-operators;
      // the stub does too, so a button shown to the wrong person would fail a check.
      case "phone_trust_setup": {
        if (!trustOperator) return json(route, { error: "Caller ID registration is set up by Structure Studio. Ask us and we'll register your number." }, 403);
        const key = body.product === "voice_integrity" ? "voiceIntegrity" : "shakenStir";
        state.callerId = { ...state.callerId, [key]: { registered: true, status: "pending-review" }, checkedAt: new Date().toISOString() };
        return json(route, { ok: true, product: body.product || "shaken_stir", status: "pending-review", submitted: true, created: true, profile: "secondary", callerId: state.callerId });
      }
      case "phone_trust_status": {
        if (!trustOperator) return json(route, { error: "Caller ID registration is set up by Structure Studio. Ask us and we'll register your number." }, 403);
        const approve = (x) => (x.registered ? { registered: true, status: "twilio-approved" } : x);
        state.callerId = { ...state.callerId, shakenStir: approve(state.callerId.shakenStir), voiceIntegrity: approve(state.callerId.voiceIntegrity), checkedAt: new Date().toISOString() };
        return json(route, { ok: true, callerId: state.callerId, errorCodes: { shakenStir: [], voiceIntegrity: [] } });
      }
      // Plan phase 6. STUBS: nothing is searched, bought or configured anywhere.
      case "phone_enable_number":
        if (state.phoneStatus !== "on") return json(route, { error: "Turn calling on first, then connect the number." }, 409);
        state.number = { ...state.number, voiceReady: true };
        return json(route, { ok: true, number: { id: state.number.id, e164: state.number.e164, voiceReady: true } });
      case "phone_search_numbers":
        return json(route, { ok: true, numbers: [
          { e164: "+15555550101", locality: "Example City", region: "MO" },
          { e164: "+15555550102", locality: null, region: "MO" },
        ] });
      case "phone_buy_number":
        if (state.number) return json(route, { error: "This account already has a number." }, 409);
        state.number = { id: "num-2", e164: body.phoneNumber, textingStatus: "pending_registration", voiceReady: state.phoneStatus === "on", callingOnly: true };
        return json(route, { ok: true, number: { id: "num-2", e164: body.phoneNumber, voiceReady: state.number.voiceReady } });
      case "phone_settings_save": {
        // The REAL validator, with the same eligibility rule the handler computes.
        const eligible = new Set(TEAM.filter((t) => t.phoneLevel !== "none").map((t) => t.userId));
        const r = parseRoute(body, eligible, new Map(TEAM.map((t) => [t.userId, t.name])));
        if (!r.ok) return json(route, { error: r.error }, 400);
        state.route = {
          mode: r.row.mode, members: r.row.members, ringSeconds: r.row.ring_seconds, noAnswer: r.row.no_answer,
          forwardTo: r.row.forward_to, businessHours: r.row.business_hours, timeZone: r.row.time_zone,
          afterHours: r.row.after_hours, greetingUrl: r.row.greeting_url, updatedAt: new Date().toISOString(),
        };
        return json(route, { ok: true, route: state.route });
      }
      case "phone_status_set": {
        // The server's rollout check (SSB-1): ON is refused unless the rollout is open to them.
        if (body.on && !rolloutOpen) return json(route, { error: "SSS Phone isn't open to every builder yet. Structure Studio switches it on for your account when it's ready." }, 403);
        state.phoneStatus = body.on ? "on" : "off";
        // SSB-2: OFF moves a connected number to voicemail (or says it could not).
        let warning = null;
        if (!body.on && state.number && state.number.voiceReady) {
          if (moveFails) warning = "Calling is off, but your number couldn't be moved to voicemail just now, so callers hear that it can't take calls. Press \"Send calls to voicemail\" to try again.";
          else state.number = { ...state.number, voiceReady: false };
        }
        return json(route, { ok: true, phoneStatus: state.phoneStatus, number: state.number ? { voiceReady: state.number.voiceReady } : null, ...(warning ? { warning } : {}) });
      }
      case "phone_signout_user":
        return json(route, { ok: true, generation: 2, sessionsEnded: false, name: "Riley Rep" });
      case "phone_calls_report": {
        const team = body.scope === "team";
        const people = team ? TEAM.filter((t) => t.phoneLevel !== "none").map((t) => ({ userId: t.userId, name: t.name })) : [{ userId: USER.id, name: "Olive Owner" }];
        const mine = (c) => c.placed_by === USER.id || c.answered_by === USER.id || (c.rang_user_ids || []).includes(USER.id);
        const rep = buildCallsReport({
          calls: team ? CALLS : CALLS.filter(mine), texts: TEXTS, voicemailCallIds: new Set(),
          contactOwner: new Map([[CONTACT_ID, USER.id]]), people, includeOthers: team, nameOf: () => "Former team member",
        });
        return json(route, { ok: true, available: true, scope: team ? "team" : "mine", days: body.days, lines: rep.lines, totals: team ? rep.totals : rep.lines[0], truncated: false, narrowed: false });
      }
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  if (process.env.SS_PORTAL_ARTIFACT) {
    const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
    await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
  }
  const q = operator ? `?view=${VIEWED}` : "";
  await page.goto(`${BASE}/portal.html${q}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(700);
  const go = async (path) => {
    await page.evaluate((p) => { history.pushState({}, "", p + window.location.search); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
    await page.waitForTimeout(1200);
  };
  const sent = () => page.evaluate(() => (window.__sssSent || []).map((s) => ({ id: s.id, ...s.msg })));
  return { ctx, page, calls, go, sent, vm };
}

// A click that cannot abort the run: a control that is missing or disabled is a FAILED CHECK
// further down, reported as such, rather than a 30 s timeout that hides every check after it.
const tap = (loc, opts = {}) => loc.click({ timeout: 5000, ...opts }).then(() => true, () => false);
const tick = (loc) => loc.check({ timeout: 5000 }).then(() => true, () => false);

// The action-bar tab by its exact label.
const tabBtn = (page, label) => page.locator("button").filter({ hasText: new RegExp(`^${label}$`) }).first();
async function openContact(s) {
  await s.go(`/portal/contacts/c-${CONTACT_ID}`);
  await s.page.waitForFunction(() => document.body.innerText.includes("SUMMARY"), null, { timeout: 20000 });
  await s.page.waitForTimeout(400);
}
// Pick the deal (the row button), which is what opens the contact's SMS tab.
async function pickDeal(s) {
  await s.page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Utility 10x12/.test(x.innerText || ""));
    if (b) b.click();
  });
  await s.page.waitForTimeout(500);
}

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  // ── A + B. Owner, calling on, SSS Phone installed and signed in as them ─────────────────────
  {
    const s = await scenario(browser, { name: "A" });
    await openContact(s);
    const call = tabBtn(s.page, "Call");
    const rendered = ok("A0 the contact record rendered with a Call tab", (await call.count()) === 1);
    if (rendered) {
      ok("A1 Call is enabled", await call.isEnabled());
      const path0 = await s.page.evaluate(() => location.pathname);
      await tap(call);
      await s.page.waitForFunction(() => /Calling \(555\) 555-0142 in SSS Phone/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
      const msgs = await s.sent();
      const callMsg = msgs.find((m) => m.type === "sss.call");
      ok("A2 the portal pinged the extension first", msgs.length > 0 && msgs[0].type === "sss.ping", JSON.stringify(msgs.map((m) => m.type)));
      ok("A3 sss.call carries to_e164, contact_id, user_id and client_id",
        !!callMsg && callMsg.id === EXT_ID && callMsg.to_e164 === "+15555550142" && callMsg.contact_id === CONTACT_ID
          && callMsg.user_id === USER.id && callMsg.client_id === CLIENT, JSON.stringify(callMsg));
      const text = await s.page.locator('[data-ss-phone-panel="call"]').innerText().catch(() => "");
      ok("A4 the page says the call is running in SSS Phone", /Calling \(555\) 555-0142 in SSS Phone/.test(text), text.slice(0, 120));
      ok("A5 and the page did not move", (await s.page.evaluate(() => location.pathname)) === path0);
      await s.page.screenshot({ path: join(shots, "A-call-handed-off.png") });

      // B. SMS routes to the extension, with a way back.
      await pickDeal(s);
      await tap(tabBtn(s.page, "SMS"));
      await s.page.waitForFunction(() => document.body.innerText.includes("is open in SSS Phone"), null, { timeout: 8000 }).catch(() => {});
      const textMsg = (await s.sent()).find((m) => m.type === "sss.text");
      ok("B1 SMS sent sss.text with the same four fields",
        !!textMsg && textMsg.to_e164 === "+15555550142" && textMsg.contact_id === CONTACT_ID && textMsg.user_id === USER.id && textMsg.client_id === CLIENT,
        JSON.stringify(textMsg));
      ok("B2 the composer is replaced by 'open in SSS Phone'", (await s.page.locator('[data-ss-phone-panel="text"]').count()) === 1
        && (await s.page.locator('textarea[placeholder="Text this customer…"]').count()) === 0);
      await s.page.screenshot({ path: join(shots, "B-text-in-sss-phone.png") });
      await tap(s.page.locator("button", { hasText: "Write it here instead" }));
      await s.page.waitForTimeout(300);
      ok("B3 'Write it here instead' brings today's composer back", (await s.page.locator('textarea[placeholder="Text this customer…"]').count()) === 1);
      // The Calls chip and the three call types in the timeline.
      const chip = await s.page.locator("button", { hasText: /^Calls \(\d+\)$/ }).first().innerText().catch(() => "");
      ok("B4 the History has a Calls chip counting the call events", chip === "Calls (3)", chip);

      // K. The voicemail plays from the Worker, with this person's session in a HEADER (SSB-7),
      // and nothing is fetched until Play is pressed.
      const play = s.page.locator(`[data-ss-voicemail-play="${VM_ID}"]`);
      ok("K1 the voicemail in the timeline has a Play button", (await play.count()) === 1);
      ok("K2 and nothing was fetched just by opening the record (the Worker marks it heard on its first stream)", s.vm.length === 0, JSON.stringify(s.vm));
      await s.page.screenshot({ path: join(shots, "K-voicemail-player.png") });
      await tap(play);
      const audio = s.page.locator(`audio[data-ss-voicemail="${VM_ID}"]`);
      await audio.waitFor({ timeout: 8000 }).catch(() => {});
      const got = s.vm.find((r) => r.method === "GET");
      ok("K3 Play fetched <PHONE_API_BASE>/voicemails/<id>/audio with NO token in the URL",
        !!got && got.url === `https://phone.structurestudiosuite.com/voicemails/${VM_ID}/audio`, JSON.stringify(s.vm));
      ok("K4 the session went in the Authorization header", !!got && got.authorization === `Bearer ${SESSION.access_token}`, got ? String(got.authorization).slice(0, 20) : "no request");
      const src = await audio.getAttribute("src").catch(() => null);
      ok("K5 and the player plays it from a blob: URL", !!src && src.startsWith("blob:"), src);
      ok("K6 no element anywhere carries the session token", !(await s.page.content()).includes(SESSION.access_token));
      await s.page.screenshot({ path: join(shots, "K-voicemail-playing.png") });
    }

    // J. Call on the contact LIST.
    await s.go("/portal/contacts");
    const rowCall = s.page.locator(`[data-ss-list-call="${CONTACT_ID}"]`);
    await rowCall.waitFor({ timeout: 15000 }).catch(() => {});
    const listRendered = ok("J0 the contact list rendered a Call button on the row", (await rowCall.count()) === 1);
    if (listRendered) {
      ok("J1 it is enabled when calling is on and SSS Phone is this person's", await rowCall.isEnabled());
      const before = (await s.sent()).length;
      const path0 = await s.page.evaluate(() => location.pathname);
      await tap(rowCall);
      await s.page.waitForFunction(() => /Calling \(555\) 555-0142 in SSS Phone/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
      const msgs = (await s.sent()).slice(before);
      const callMsg = msgs.find((m) => m.type === "sss.call");
      ok("J2 the row's Call sends sss.call with the same four fields",
        !!callMsg && callMsg.id === EXT_ID && callMsg.to_e164 === "+15555550142" && callMsg.contact_id === CONTACT_ID
          && callMsg.user_id === USER.id && callMsg.client_id === CLIENT, JSON.stringify(msgs));
      const panel = await s.page.locator('[data-ss-phone-panel="list-call"]').innerText().catch(() => "");
      ok("J3 the row says the call is running in SSS Phone", /Calling \(555\) 555-0142 in SSS Phone/.test(panel), panel.slice(0, 120));
      ok("J4 and the list did not move", (await s.page.evaluate(() => location.pathname)) === path0);
      await s.page.screenshot({ path: join(shots, "J-list-call.png") });
    }
    await s.ctx.close();
  }

  // ── C. No extension anywhere ──────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "C", extension: "absent" });
    await openContact(s);
    await tap(tabBtn(s.page, "Call"));
    await s.page.waitForSelector('[data-ss-phone-install="full"]', { timeout: 8000 }).catch(() => {});
    const card = await s.page.locator('[data-ss-phone-install="full"]').innerText().catch(() => "");
    ok("C1 Call with no extension shows the Install SSS Phone card", /Install SSS Phone to call from Structure Studio/.test(card), card.slice(0, 80));
    ok("C2 the store link is a placeholder, so it reads 'coming soon' rather than linking nowhere", /link coming soon/.test(card)
      && (await s.page.locator('[data-ss-phone-install="full"] a').count()) === 0);
    ok("C3 nothing but a ping was attempted", (await s.sent()).every((m) => m.type === "sss.ping"));
    await s.page.screenshot({ path: join(shots, "C-install-card.png") });
    await pickDeal(s);
    await tap(tabBtn(s.page, "SMS"));
    await s.page.waitForTimeout(500);
    ok("C4 SMS keeps today's composer", (await s.page.locator('textarea[placeholder="Text this customer…"]').count()) === 1);
    ok("C5 with a one-line install tip above it", (await s.page.locator('[data-ss-phone-install="compact"]').count()) === 1);
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "C-none", extension: "none" });
    await openContact(s);
    await tap(tabBtn(s.page, "Call"));
    await s.page.waitForSelector('[data-ss-phone-install="full"]', { timeout: 8000 }).catch(() => {});
    ok("C6 a browser with no chrome.runtime at all also gets the install card", (await s.page.locator('[data-ss-phone-install="full"]').count()) === 1);
    await s.ctx.close();
  }

  // ── D. SSS Phone signed in as somebody else ───────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "D", who: { user_id: REP, client_id: CLIENT } });
    await openContact(s);
    await tap(tabBtn(s.page, "Call"));
    await s.page.waitForFunction(() => /signed in as/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
    const panel = await s.page.locator('[data-ss-phone-panel="call"]').innerText().catch(() => "");
    ok("D1 Call names who SSS Phone is signed in as", /signed in as Robin Example/.test(panel), panel.slice(0, 140));
    await pickDeal(s);
    await tap(tabBtn(s.page, "SMS"));
    await s.page.waitForTimeout(500);
    ok("D2 SMS falls back to the composer and says why", (await s.page.locator('textarea[placeholder="Text this customer…"]').count()) === 1
      && /signed in as someone else, so this text goes from here/.test(await s.page.locator("body").innerText()));
    ok("D3 no sss.text was sent for the wrong person", !(await s.sent()).some((m) => m.type === "sss.text"));
    await s.ctx.close();
  }

  // ── E. Operator viewing another builder ───────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "E", operator: true });
    await openContact(s);
    const call = tabBtn(s.page, "Call");
    const sms = tabBtn(s.page, "SMS");
    const rendered = ok("E0 the viewed builder's contact record rendered", (await call.count()) === 1);
    if (rendered) {
      ok("E1 Call is disabled in view-as", !(await call.isEnabled()));
      ok("E2 with the plan's hint", (await call.getAttribute("title")) === "Calling isn't available while viewing another account.", await call.getAttribute("title"));
      ok("E3 SMS is disabled too", !(await sms.isEnabled()));
      ok("E4 and says why", (await sms.getAttribute("title")) === "Texting isn't available while viewing another account.", await sms.getAttribute("title"));
      await call.click({ force: true }).catch(() => {});
      await s.page.waitForTimeout(300);
      ok("E5 nothing was handed to the extension", (await s.sent()).length === 0);
      const rec = s.calls.find((c) => c.action === "crm_record");
      ok("E6 the record read was the VIEWED builder's (targetClientId injected)", !!rec && rec.targetClientId === VIEWED, JSON.stringify(rec));
      ok("E7 no voicemail player in view-as (the operator's token is not on this builder's team)",
        (await s.page.locator("audio[data-ss-voicemail], [data-ss-voicemail-play]").count()) === 0 && s.vm.length === 0);
      await s.page.screenshot({ path: join(shots, "E-view-as-disabled.png") });
    }
    await s.go("/portal/contacts");
    const rowCall = s.page.locator(`[data-ss-list-call="${CONTACT_ID}"]`);
    await rowCall.waitFor({ timeout: 15000 }).catch(() => {});
    ok("E8 the list's Call is greyed in view-as with the record's hint", (await rowCall.count()) === 1 && !(await rowCall.isEnabled())
      && (await rowCall.getAttribute("title")) === "Calling isn't available while viewing another account.", await rowCall.getAttribute("title").catch(() => "missing"));
    ok("E9 and nothing was handed to the extension", (await s.sent()).length === 0);
    await s.ctx.close();
  }

  // ── F. Calling switched off for the account ───────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "F", phoneStatus: "off" });
    await openContact(s);
    const call = tabBtn(s.page, "Call");
    ok("F1 Call is greyed while calling is off", (await call.count()) === 1 && !(await call.isEnabled()));
    ok("F2 and says so", (await call.getAttribute("title")) === "Calling isn't switched on for this account yet.", await call.getAttribute("title"));
    ok("F3 the Calls chip still shows, because this record HAS call history", (await s.page.locator("button", { hasText: /^Calls \(3\)$/ }).count()) === 1);
    ok("F4 no voicemail player while calling is off (the Worker would refuse it)",
      (await s.page.locator("audio[data-ss-voicemail], [data-ss-voicemail-play]").count()) === 0 && s.vm.length === 0);
    await s.go("/portal/contacts");
    const rowCall = s.page.locator(`[data-ss-list-call="${CONTACT_ID}"]`);
    await rowCall.waitFor({ timeout: 15000 }).catch(() => {});
    ok("F5 the list's Call is greyed and says calling is off, like the record", (await rowCall.count()) === 1 && !(await rowCall.isEnabled())
      && (await rowCall.getAttribute("title")) === "Calling isn't switched on for this account yet.", await rowCall.getAttribute("title").catch(() => "missing"));
    await s.ctx.close();
  }

  // ── G. Settings → Phone ──────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "G" });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector('[data-ss-phone-settings="team"]', { timeout: 15000 }).catch(() => {});
    const body = await s.page.locator('[data-ss-phone-settings]').innerText().catch(() => "");
    const rendered = ok("G0 the Phone tab rendered the owner's setup", (await s.page.locator('[data-ss-phone-settings="team"]').count()) === 1, body.slice(0, 80));
    ok("G1 the Settings rail lists Phone", (await s.page.locator('.ss-set-nav a[href*="/portal/settings/phone"]').count()) === 1);
    if (rendered) {
      ok("G2 it shows the builder's number from the texting setup", (await s.page.locator("[data-ss-phone-number]").innerText()) === "(555) 555-0199");
      ok("G3 and the switch state", (await s.page.locator('[data-ss-phone-status="on"]').count()) === 1);
      const box = (id) => s.page.locator(`[data-ss-phone-member="${id}"] input[type=checkbox]`);
      ok("G4 the owner is pre-ticked on first setup", await box(USER.id).isChecked());
      ok("G5 somebody with no phone access cannot be ticked", await box(CREW).isDisabled());
      ok("G6 install links are on the tab", (await s.page.locator('[data-ss-phone-install="full"]').count()) === 1);
      await s.page.screenshot({ path: join(shots, "G-phone-settings.png"), fullPage: true });

      // L. Plan phase 6: a texting number that does not ring SSS Phone yet gets connected here.
      const connect = s.page.locator("[data-ss-phone-connect]");
      ok("L1 a number not yet connected offers 'Connect this number for calls'", (await connect.count()) === 1 && await connect.isEnabled());
      await tap(connect);
      await s.page.waitForSelector("[data-ss-phone-connected]", { timeout: 8000 }).catch(() => {});
      ok("L2 it sends phone_enable_number and the card says the number is connected",
        s.calls.some((c) => c.action === "phone_enable_number") && (await s.page.locator("[data-ss-phone-connected]").count()) === 1
          && /Calls to this number ring SSS Phone now/.test(await s.page.locator("body").innerText()));

      // Setup: add the rep, ring in order, business hours on, save.
      await tick(box(REP));
      await tick(s.page.locator("label", { hasText: "Ring one after another, in this order" }).locator("input"));
      await tick(s.page.locator("label", { hasText: "Only during these hours" }).locator("input"));
      await tap(s.page.locator("[data-ss-phone-save]"));
      await s.page.waitForFunction(() => document.body.innerText.includes("Saved. Calls to your number"), null, { timeout: 8000 }).catch(() => {});
      const save = s.calls.filter((c) => c.action === "phone_settings_save").pop();
      ok("G7 Save sent the ordered members, the mode and the hours",
        !!save && JSON.stringify(save.members) === JSON.stringify([USER.id, REP]) && save.mode === "in_order"
          && save.businessHours && JSON.stringify(save.businessHours.mon) === JSON.stringify([["08:00", "17:00"]]) && !save.businessHours.sat
          && save.ringSeconds === 20 && save.noAnswer === "voicemail", JSON.stringify(save));
      ok("G8 and the real validator accepted it", /Saved\. Calls to your number/.test(await s.page.locator("body").innerText()));

      // A refusal from the real validator reaches the screen in words.
      await tick(s.page.locator("label", { hasText: "Forward to a cell phone" }).locator("input"));
      await tap(s.page.locator("[data-ss-phone-save]"));
      await s.page.waitForFunction(() => document.body.innerText.includes("Add the cell number calls should forward to."), null, { timeout: 8000 }).catch(() => {});
      ok("G9 forwarding with no number is refused with the validator's sentence", /Add the cell number calls should forward to\./.test(await s.page.locator("body").innerText()));

      // The switch.
      await tap(s.page.locator("[data-ss-phone-switch]"));
      await s.page.waitForSelector('[data-ss-phone-status="off"]', { timeout: 8000 }).catch(() => {});
      const sw = s.calls.filter((c) => c.action === "phone_status_set").pop();
      ok("G10 the switch sent phone_status_set { on: false } and the chip followed", !!sw && sw.on === false && (await s.page.locator('[data-ss-phone-status="off"]').count()) === 1, JSON.stringify(sw));
      // SSB-2: the number was connected (L2), so turning calling off moved it to voicemail.
      ok("G10b turning calling off says the number's calls now go to voicemail, and the card shows it is no longer connected",
        /Calling is off\. Calls to your number go to voicemail\./.test(await s.page.locator("body").innerText())
          && (await s.page.locator("[data-ss-phone-connected]").count()) === 0 && (await s.page.locator("[data-ss-phone-stuck]").count()) === 0);

      // Sign out all devices.
      await tap(s.page.locator(`[data-ss-phone-signout="${REP}"]`));
      await s.page.waitForFunction(() => document.body.innerText.includes("disconnected from calls"), null, { timeout: 8000 }).catch(() => {});
      const so = s.calls.filter((c) => c.action === "phone_signout_user").pop();
      ok("G11 'Sign out all devices' sent that person's id", !!so && so.userId === REP, JSON.stringify(so));
      ok("G12 and the result is said plainly, including what it did not do", /disconnected from calls/.test(await s.page.locator("body").innerText()));
      await s.page.screenshot({ path: join(shots, "G-phone-settings-after.png"), fullPage: true });
    }
    await s.ctx.close();
  }

  // ── L. Settings → Phone with NO number: the calling-only purchase (stubbed) ──────────────
  {
    const s = await scenario(browser, { name: "L", noNumber: true });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector("[data-ss-phone-buy]", { timeout: 15000 }).catch(() => {});
    const offered = ok("L3 an owner with no number is offered 'Get a number for calls'", (await s.page.locator("[data-ss-phone-buy]").count()) === 1);
    if (offered) {
      await s.page.locator("[data-ss-phone-areacode]").fill("555");
      await tap(s.page.locator("[data-ss-phone-search]"));
      await s.page.waitForSelector('[data-ss-phone-result="+15555550101"]', { timeout: 8000 }).catch(() => {});
      const search = s.calls.filter((c) => c.action === "phone_search_numbers").pop();
      ok("L4 Search sends the area code and lists what came back", !!search && search.areaCode === "555"
        && (await s.page.locator("[data-ss-phone-result]").count()) === 2, JSON.stringify(search));
      await s.page.screenshot({ path: join(shots, "L-number-search.png"), fullPage: true });
      await tap(s.page.locator('[data-ss-phone-result="+15555550101"] button'));
      await s.page.waitForFunction(() => /\(555\) 555-0101/.test((document.querySelector("[data-ss-phone-number]") || {}).textContent || ""), null, { timeout: 8000 }).catch(() => {});
      const buy = s.calls.filter((c) => c.action === "phone_buy_number").pop();
      ok("L5 'Get this number' buys exactly the number picked (a stub; nothing is bought)", !!buy && buy.phoneNumber === "+15555550101", JSON.stringify(buy));
      ok("L6 the card now shows the number, calls-only, and connected because calling is on",
        (await s.page.locator("[data-ss-phone-number]").innerText().catch(() => "")) === "(555) 555-0101"
          && /Calls only for now/.test(await s.page.locator("body").innerText())
          && (await s.page.locator("[data-ss-phone-connected]").count()) === 1);
      ok("L7 and the purchase is no longer offered", (await s.page.locator("[data-ss-phone-buy]").count()) === 0);
      await s.page.screenshot({ path: join(shots, "L-number-bought.png"), fullPage: true });
    }
    await s.ctx.close();
  }

  // ── M. The rollout, on the Phone tab (SSB-1), and a switch-off whose move failed (SSB-2) ──
  {
    const s = await scenario(browser, { name: "M1", phoneStatus: "off", rolloutOpen: false, noNumber: true });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector('[data-ss-phone-settings="team"]', { timeout: 15000 }).catch(() => {});
    const rendered = ok("M1 the Phone tab rendered for an owner the rollout does not include", (await s.page.locator('[data-ss-phone-settings="team"]').count()) === 1);
    if (rendered) {
      ok("M2 there is no 'Turn calling on' (the server would refuse it)", (await s.page.locator("[data-ss-phone-switch]").count()) === 0);
      ok("M3 and it says why", (await s.page.locator("[data-ss-phone-rollout]").count()) === 1
        && /isn.t open to every builder yet/.test(await s.page.locator("[data-ss-phone-rollout]").innerText()));
      ok("M4 no number purchase is offered", (await s.page.locator("[data-ss-phone-buy]").count()) === 0);
      await s.page.screenshot({ path: join(shots, "M-rollout-closed.png"), fullPage: true });
    }
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "M5", phoneStatus: "off", rolloutOpen: false });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector('[data-ss-phone-settings="team"]', { timeout: 15000 }).catch(() => {});
    ok("M5 a number not connected shows no Connect button for an owner the rollout does not include",
      (await s.page.locator("[data-ss-phone-connect-card]").count()) === 1 && (await s.page.locator("[data-ss-phone-connect]").count()) === 0);
    await s.ctx.close();
  }
  {
    // Calling is on, the number is connected, and the move to voicemail fails when it is turned off.
    const s = await scenario(browser, { name: "M6", moveFails: true,
      numberOverride: { id: "num-1", e164: "+15555550199", textingStatus: "registered", voiceReady: true, callingOnly: false } });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector("[data-ss-phone-switch]", { timeout: 15000 }).catch(() => {});
    await tap(s.page.locator("[data-ss-phone-switch]"));
    await s.page.waitForSelector("[data-ss-phone-stuck]", { timeout: 8000 }).catch(() => {});
    ok("M6 the switch still turned calling off", (await s.page.locator('[data-ss-phone-status="off"]').count()) === 1);
    ok("M7 and the tab says callers still hear 'can't take calls', with 'Send calls to voicemail'",
      (await s.page.locator("[data-ss-phone-stuck]").count()) === 1 && (await s.page.locator("[data-ss-phone-to-voicemail]").count()) === 1
        && /couldn.t be moved to voicemail/.test(await s.page.locator("body").innerText()));
    await s.page.screenshot({ path: join(shots, "M-move-failed.png"), fullPage: true });
    const before = s.calls.filter((c) => c.action === "phone_status_set").length;
    await tap(s.page.locator("[data-ss-phone-to-voicemail]"));
    await s.page.waitForTimeout(600);
    const retry = s.calls.filter((c) => c.action === "phone_status_set");
    ok("M8 'Send calls to voicemail' asks the switch to move it again (phone_status_set { on: false })",
      retry.length === before + 1 && retry[retry.length - 1].on === false, JSON.stringify(retry));
    await s.ctx.close();
  }

  // ── N. Caller ID on the Phone tab (plan §14, phase 6; STUBS, nothing reaches Twilio) ────────
  {
    const s = await scenario(browser, { name: "N1", trustOperator: true });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector("[data-ss-phone-callerid]", { timeout: 15000 }).catch(() => {});
    const card = s.page.locator("[data-ss-phone-callerid]");
    const shown = ok("N1 the Caller ID card is on the team screen, under the number", (await card.count()) === 1);
    if (shown) {
      ok("N2 both registrations read 'Not registered' at first",
        (await s.page.locator('[data-ss-phone-trust-status="none"]').count()) === 2, await card.innerText());
      await tap(s.page.locator('[data-ss-phone-trust-register="shaken_stir"]'));
      await s.page.waitForSelector('[data-ss-phone-trust="shaken_stir"] [data-ss-phone-trust-status="pending-review"]', { timeout: 8000 }).catch(() => {});
      const setup = s.calls.filter((c) => c.action === "phone_trust_setup").pop();
      ok("N3 an operator's Register sends phone_trust_setup for SHAKEN/STIR", !!setup && setup.product === "shaken_stir" && !("voiceIntegrity" in setup), JSON.stringify(setup));
      ok("N4 and the row now reads 'Waiting for Twilio'", /Waiting for Twilio/.test(await s.page.locator('[data-ss-phone-trust="shaken_stir"]').innerText()));
      // Voice Integrity asks its questions first; the button stays off until they are answered.
      await tap(s.page.locator('[data-ss-phone-trust-register="voice_integrity"]'));
      await s.page.waitForSelector("[data-ss-phone-vi-form]", { timeout: 5000 }).catch(() => {});
      ok("N5 Voice Integrity opens its questions, and cannot be sent empty",
        (await s.page.locator("[data-ss-phone-vi-form]").count()) === 1 && await s.page.locator("[data-ss-phone-vi-submit]").isDisabled());
      await s.page.locator("[data-ss-phone-vi-employees]").fill("6");
      await s.page.locator("[data-ss-phone-vi-calls]").fill("40");
      await s.page.screenshot({ path: join(shots, "N-caller-id-form.png"), fullPage: true });
      await tap(s.page.locator("[data-ss-phone-vi-submit]"));
      await s.page.waitForSelector('[data-ss-phone-trust="voice_integrity"] [data-ss-phone-trust-status="pending-review"]', { timeout: 8000 }).catch(() => {});
      const vi = s.calls.filter((c) => c.action === "phone_trust_setup").pop();
      ok("N6 it sends the product and the answers", !!vi && vi.product === "voice_integrity" && vi.voiceIntegrity
        && vi.voiceIntegrity.useCase === "Customer Support" && vi.voiceIntegrity.employeeCount === "6" && vi.voiceIntegrity.averageDailyCalls === "40", JSON.stringify(vi));
      await tap(s.page.locator("[data-ss-phone-trust-check]"));
      await s.page.waitForSelector('[data-ss-phone-trust-status="twilio-approved"]', { timeout: 8000 }).catch(() => {});
      ok("N7 Check status asks phone_trust_status and shows what Twilio said",
        s.calls.some((c) => c.action === "phone_trust_status") && (await s.page.locator('[data-ss-phone-trust-status="twilio-approved"]').count()) === 2);
      ok("N8 once approved, there is nothing to Register", (await s.page.locator("[data-ss-phone-trust-register]").count()) === 0);
      await s.page.screenshot({ path: join(shots, "N-caller-id-operator.png"), fullPage: true });
    }
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "N9", trustOperator: false });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector("[data-ss-phone-callerid]", { timeout: 15000 }).catch(() => {});
    const text = await s.page.locator("[data-ss-phone-callerid]").innerText().catch(() => "");
    ok("N9 a builder's owner sees where it stands, and no buttons", /Not registered/.test(text)
      && (await s.page.locator("[data-ss-phone-trust-register], [data-ss-phone-trust-check]").count()) === 0
      && /Structure Studio registers your number/.test(text), text.slice(0, 200));
    ok("N10 and nothing was sent to the caller-ID actions", !s.calls.some((c) => /^phone_trust_/.test(c.action || "")));
    await s.page.screenshot({ path: join(shots, "N-caller-id-owner.png"), fullPage: true });
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "N11", trustOperator: true, trustAvailable: false });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector("[data-ss-phone-callerid]", { timeout: 15000 }).catch(() => {});
    ok("N11 before migration 255 the card says it isn't available, with no buttons",
      /isn.t available on this account yet/.test(await s.page.locator("[data-ss-phone-callerid]").innerText().catch(() => ""))
        && (await s.page.locator("[data-ss-phone-trust-register]").count()) === 0);
    await s.ctx.close();
  }

  // ── O. Text Messaging adopts the calling-only number (portal-sms is a STUB) ───────────────
  {
    const smsStatus = {
      status: "campaign_approved", brandTier: "low_volume_standard", needsAttention: false, attentionNote: null,
      brandStatus: "APPROVED", campaignStatus: "APPROVED", errors: [], brandUpdatesLeft: 3, campaignRetriesLeft: 3, mockBrand: false,
      intake: { legalBusinessName: "Demo Tenant LLC", einLast4: "6789", websiteUrl: "https://demo.example.test", privacyPolicyUrl: "https://demo.example.test/privacy", termsUrl: "https://demo.example.test/terms" },
      copy: { description: "", messageFlow: "", messageSamples: ["", ""] }, aupAcceptedAt: "2026-09-01T00:00:00Z", aupText: "I confirm.",
      numbers: [{ phoneNumber: "+15555550199", registrationStatus: "pending_registration", purchasedAt: "2026-09-20T00:00:00Z", callingOnly: true }],
      businessTypes: ["Limited Liability Corporation"], jobPositions: ["CEO"], configured: true,
      optInDisclosureUrl: "https://demo.example.test/opt-in", compliance: { checkedAt: null, checks: [] },
    };
    const s = await scenario(browser, { name: "O", smsStatus });
    await s.go("/portal/settings/sms");
    await s.page.waitForSelector("[data-ss-sms-adopt]", { timeout: 15000 }).catch(() => {});
    const offered = ok("O1 at 'pick your number' with a calling-only number, the tab offers to use it", (await s.page.locator("[data-ss-sms-adopt]").count()) === 1
      && /\+15555550199/.test(await s.page.locator("[data-ss-sms-adopt]").innerText()));
    if (offered) {
      ok("O2 and no number search is offered beside it", !/Choose your number/.test(await s.page.locator("body").innerText()));
      await s.page.screenshot({ path: join(shots, "O-sms-adopt.png"), fullPage: true });
      await tap(s.page.locator("[data-ss-sms-adopt-button]"));
      await s.page.waitForFunction(() => !document.querySelector("[data-ss-sms-adopt]"), null, { timeout: 8000 }).catch(() => {});
      const buy = s.calls.filter((c) => c.fn === "portal-sms" && c.action === "buy_number").pop();
      ok("O3 'Use this number for texting' sends buy_number with NO number picked (the server adopts)", !!buy && !("phoneNumber" in buy), JSON.stringify(buy));
      ok("O4 the tab moves on to connecting the number", (await s.page.locator("[data-ss-sms-adopt]").count()) === 0
        && /Being connected/.test(await s.page.locator("body").innerText()));
    }
    await s.ctx.close();

    // Review BE-5: an adoption whose LAST write failed left the registration at number_pending
    // with the row still calling-only. After a reload the press must still be there (the server
    // accepts it in number_pending and active), offered as a finish.
    for (const st of ["number_pending", "active"]) {
      const s2 = await scenario(browser, { name: `O5-${st}`, smsStatus: { ...smsStatus, status: st } });
      await s2.go("/portal/settings/sms");
      await s2.page.waitForSelector("[data-ss-sms-adopt]", { timeout: 15000 }).catch(() => {});
      const card = s2.page.locator('[data-ss-sms-adopt="finish"]');
      const offered2 = ok(`O5 at ${st} with a calling-only number still on the account, the tab offers to FINISH connecting it`,
        (await card.count()) === 1 && /Finish connecting/.test(await card.innerText()) && /\+15555550199/.test(await card.innerText()),
        (await s2.page.locator("body").innerText()).slice(0, 300));
      if (offered2) {
        ok(`O5 at ${st}, and the status card does not say there is nothing to do`,
          !/Nothing for you to do/.test(await s2.page.locator("body").innerText()));
        if (st === "number_pending") await s2.page.screenshot({ path: join(shots, "O5-sms-adopt-finish.png"), fullPage: true });
        await tap(s2.page.locator("[data-ss-sms-adopt-button]"));
        await s2.page.waitForFunction(() => !document.querySelector("[data-ss-sms-adopt]"), null, { timeout: 8000 }).catch(() => {});
        const buy2 = s2.calls.filter((c) => c.fn === "portal-sms" && c.action === "buy_number").pop();
        ok(`O6 at ${st}, the finish sends buy_number with NO number picked, and the card goes once the row is adopted`,
          !!buy2 && !("phoneNumber" in buy2) && (await s2.page.locator("[data-ss-sms-adopt]").count()) === 0, JSON.stringify(buy2));
      }
      await s2.ctx.close();
    }
  }

  // ── H. The Calls page ────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "H" });
    ok("H1 the rail has a Calls item", (await s.page.locator('.ss-ws-nav a[href$="/portal/calls"]').count()) === 1);
    await s.go("/portal/calls");
    await s.page.waitForSelector("[data-ss-calls-report] table", { timeout: 15000 }).catch(() => {});
    const mine = s.calls.filter((c) => c.action === "phone_calls_report").pop();
    ok("H2 My calls is the default", !!mine && mine.scope === "mine" && mine.days === 30, JSON.stringify(mine));
    const row = await s.page.locator(`[data-ss-calls-line="${USER.id}"]`).innerText().catch(() => "");
    // Olive: rang on c1 (missed) and c2 (Riley answered) → 2 in, 0 answered, 1 missed; placed c3
    // (3:12) → 1 out, average 3:12; 1 text sent; 1 received on her assigned customer.
    ok("H3 the numbers are the shipped rules' numbers", row.replace(/\s+/g, " ").trim() === "Olive Owner 2 1 0 1 3:12 0 1 1", row.replace(/\s+/g, " "));
    await tap(s.page.locator('[data-ss-calls-scope="team"]'));
    await s.page.waitForSelector('[data-ss-calls-line="totals"]', { timeout: 8000 }).catch(() => {});
    const team = s.calls.filter((c) => c.action === "phone_calls_report").pop();
    ok("H4 Team asks for the team", team && team.scope === "team");
    const rep = await s.page.locator(`[data-ss-calls-line="${REP}"]`).innerText().catch(() => "");
    ok("H5 the rep's line counts the call they answered and the miss that rang them", rep.replace(/\s+/g, " ").trim() === "Riley Rep 2 0 1 1 2:05 0 0 0", rep.replace(/\s+/g, " "));
    const totals = await s.page.locator('[data-ss-calls-line="totals"]').innerText().catch(() => "");
    ok("H6 the whole-business line counts the missed call once", totals.replace(/\s+/g, " ").trim() === "Whole business 2 1 1 1 2:39 0 1 1", totals.replace(/\s+/g, " "));
    await s.page.screenshot({ path: join(shots, "H-calls-report.png"), fullPage: true });
    await s.ctx.close();
  }

  // ── I. A phone's browser ─────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, {
      name: "I", extension: "none",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      viewport: { width: 390, height: 844 },
    });
    // Catch the app link the page asks the browser to open. An unknown scheme never becomes a
    // network request, so it is read off Chrome's own navigation event.
    const cdp = await s.ctx.newCDPSession(s.page);
    await cdp.send("Page.enable");
    const navs = [];
    cdp.on("Page.frameRequestedNavigation", (e) => navs.push(e.url));
    await openContact(s);
    await tap(tabBtn(s.page, "Call"));
    await s.page.waitForSelector('[data-ss-phone-install="mobile"]', { timeout: 8000 }).catch(() => {});
    await s.page.waitForTimeout(500);
    const panel = await s.page.locator('[data-ss-phone-panel="call"]').innerText().catch(() => "");
    ok("I1 Call on a phone says it is opening the SSS Phone app", /Opening the SSS Phone app to call \(555\) 555-0142/.test(panel), panel.slice(0, 100));
    ok("I2 with the app links (not the Chrome extension)", (await s.page.locator('[data-ss-phone-install="mobile"]').count()) === 1
      && !/Chrome extension/.test(await s.page.locator('[data-ss-phone-install="mobile"]').innerText()));
    const deep = navs.find((u) => u.startsWith("sssphone://"));
    // SPEC section 7: the four fields, then `ts` (when the page made the link; the app drops one
    // more than a minute old).
    const want = `sssphone://call?to=%2B15555550142&contact_id=${CONTACT_ID}&user_id=${USER.id}&client_id=${CLIENT}&ts=`;
    const ts = deep && deep.startsWith(want) ? Number(deep.slice(want.length)) : NaN;
    ok("I3 the app link carries the four fields and ts, the moment it was made", Number.isInteger(ts) && Math.abs(Date.now() - ts) < 60000,
      deep || `navigations seen: ${JSON.stringify(navs)}`);
    await s.page.screenshot({ path: join(shots, "I-phone-browser.png") });
    await s.ctx.close();
  }

  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\nsssPhone: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
