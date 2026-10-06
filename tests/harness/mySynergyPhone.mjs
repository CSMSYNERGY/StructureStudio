// My Synergy Phone in the portal, driven for real on the COMPILED portal (2026-09-29).
//
// What it proves, each against the artifact the browser actually loads:
//   A. Call on a contact hands the number to the My Synergy Phone extension (chrome.runtime.sendMessage,
//      SPEC section 5) with all four fields, and the page does not move.
//   B. SMS on the same contact opens the thread in My Synergy Phone, with a way back to the composer.
//   C. No extension installed: Call shows the "Install My Synergy Phone" card; SMS keeps today's
//      composer with a small install tip.
//   D. The extension signed in as somebody else: Call says so in words; SMS falls back to the
//      composer and says why.
//   E. Operator view-as: Call AND SMS are greyed with the plan's hint, and nothing is sent.
//   F. Calling switched off for the account: Call is greyed and says so.
//   G. Settings → Phone renders the owner's one-time setup, and Save / the on-off switch /
//      "Sign out all devices" send what the server expects (validated by the REAL parseRoute).
//   H. The Calls page renders My and Team, Team with the whole-business line.
//   I. On a phone's browser, Call opens the My Synergy Phone app instead of messaging an extension.
//   J. Call on the contact LIST: the same four fields, the same greyed hints (view-as, calling
//      off) as the record page, and the page does not move.
//   K. A voicemail in the contact timeline plays from the phone-api Worker
//      (<PHONE_API_BASE>/voicemails/<id>/audio, the session in the Authorization header, played
//      from a blob: URL; review SSB-7), fetched only when Play is pressed, and not in view-as or
//      with calling off.
//   L. Settings -> Phone, plan phase 6: "Connect this number for calls", and the calling-only
//      number search + purchase (the purchase is a STUB here; nothing is bought). Who answers and
//      how, chosen before the first number exists, carries over to it (L8, L9).
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
//   P. Settings -> Phone, Call recording (migration 263): the owner turns it on with their own
//      wording through phone_recording_save (validated by the REAL parseRecording), a wording that
//      doesn't say "recorded" is refused before Save, the announcement can't be unticked; anyone
//      else sees the card read-only; before 263 the card says it is not available; with the
//      server's switch (the Worker's CALL_RECORDING rail) off, the owner's on reads "On, not
//      started yet" and never "Calls are recorded". Since migration 287: the standard sentence is
//      "This call may be recorded." ("... and transcribed" only with the CALL_TRANSCRIBE rail on,
//      and with it off the card says transcripts haven't started); a business no owner has saved
//      is on by default and the card says so, and its first save asks "Record calls?" (a stamped
//      choice doesn't ask again).
//   Q. A recorded call in the contact timeline: its summary shows, Play recording fetches
//      <PHONE_API_BASE>/recordings/<id>/audio only on the press (header, blob: URL), and "Show
//      transcript" reads /calls/<id>/transcript the same way; neither in view-as or with calling off.
//   R. Settings -> Phone, Your calls, "When my phone rings" (migration 264): Always or my own hours
//      in the business hours' weekly editor, in this browser's time zone; Save sends POST
//      <PHONE_API_BASE>/settings/me (the session in the header) and a stub Worker checks it with
//      the REAL _shared/phoneHours.ts rule; its refusals reach the screen; "no day at all" is
//      caught before asking; the team screen shows each person's own hours; a Worker that doesn't
//      keep hours shows no such section.
//   V. Settings -> Phone, Your calls, "Voicemail greeting" (migration 264): Record sends POST
//      <PHONE_API_BASE>/settings/me/greeting/record (the session in the header; the stub Worker
//      rings nothing) and says the phone will ring; the card notices the recording landing on its
//      own; Play fetches the audio with the header into a blob: URL; "Use the standard greeting"
//      clears it after a confirm; the Worker's refusal reaches the screen; the owner's link field
//      says it is for the shared number; a Worker that doesn't keep greetings shows no section.
//   X. Settings -> Phone with MORE THAN ONE NUMBER (migration 266, Carolyn 09-30): the list of
//      numbers with each one's name and whose it is; picking one opens its OWN settings (name,
//      person, who answers, hours, caller ID); Save, Connect and "Use this number for texting too"
//      send that number's id; someone who already has a number isn't offered a second; "Add another
//      number" buys one (a STUB) and opens it; a sales rep with their own number sees "Your number".
//      The stub checks every save with the REAL parseRoute / parseNumberLabel / parseAssignee /
//      pickNumber. Nothing is bought, connected or texted anywhere.
//   W. Who reaches Your calls: a sales rep (phone 'own', no settings area: the real title preset)
//      gets Settings with exactly Phone and My Profile, and the card, at /portal/settings/phone
//      (the apps' "Change in Structure Studio" link); and an older Worker, which answers GET
//      /settings/me with 405 (it routes only POST there), hides the card instead of showing a fault.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine) — the shape
// crmContactDeal.mjs uses. The extension is stubbed as window.chrome.runtime before the app
// boots, answering exactly the SPEC section 5 messages.
//
//   python -m http.server 8131 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8131 node tests/harness/mySynergyPhone.mjs   (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/my-synergy-phone (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an older
// portal.app.compiled.js> serves that file instead, which is how to prove the checks can fail:
// against the artifact before this change, A-I all fail (Call is the greyed "arrives with the
// phone integration" tab, and there is no Phone tab or Calls page).
//
// Fixtures are obviously fake (555-01xx numbers, example.test), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";
import { buildCallsReport, parseRecording, parseRoute, recordingView } from "../../supabase/functions/portal-settings/phone.ts";
import { MAX_NUMBERS, parseAssignee, parseNumberLabel, pickNumber, suggestedMembersFor } from "../../supabase/functions/portal-settings/phone.ts";
import { parseBusinessHours, RING_HOURS_WORDS, validTimeZone } from "../../supabase/functions/_shared/phoneHours.ts";
import { PRESETS } from "../../supabase/functions/_shared/access.ts";

const CLIENT = "demo-tenant";
const VIEWED = "demo-builder";
const CONTACT_ID = "4512ed87-fb75-4645-81d6-9268eb73e305";
const VM_ID = "5f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5";
const REC_ID = "6a1b2c3d-4e5f-4061-8172-839405a6b7c8";
const REC_CALL = "7b2c3d4e-5f60-4172-8283-94a5b6c7d8e9";
const REC_SUMMARY = "Pat wants a quote for a 10x12 utility shed with a ramp.\nAction items:\n- Send the quote by Friday";
const REC_TRANSCRIPT = "Customer: Hi, I'm calling about a shed.\nTeam: Sure, what size?";
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
// picked deal (the 2026-09-02 picker rule), and that rule is untouched by My Synergy Phone.
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
  // A recorded call (migration 263): crmFeed's recordingMeta, ready to play, transcribed and summarised.
  { id: "pc:2", type: "call", at: "2026-09-28T16:00:00Z", title: "Call to +15555550142", body: "Talked 3m 12s · by Olive Owner", icon: "call",
    meta: { callId: REC_CALL, recordingId: REC_ID, recordingReady: true, recordingState: "ready", recordingDurationS: 192,
      recordingDeleted: false, summary: REC_SUMMARY, hasTranscript: true, transcriptPending: false } },
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
const shots = shotsDir("my-synergy-phone");
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
    // Call recording (P): the client_settings row's recording columns (null = before migration
    // 263), whether this caller may change them (the server's owner rule), and the server's
    // switches (portal-settings' copies of the Worker's CALL_RECORDING and CALL_TRANSCRIBE rails;
    // transcripts ship off).
    recordingRow = {}, canChangeRecording = true, recordingServerOn = true, transcribeServerOn = false,
    // Your calls (R): the signed-in person's own settings the stub Worker answers GET and POST
    // /settings/me with (null = the stub answers those paths as it always has), the team screen's
    // list, and the browser's time zone.
    my = null, team = TEAM, timezoneId = undefined,
    // Who reaches it (W): the signed-in person's tenant role and access map (the owner's by
    // default), and a Worker from before 264 (GET /settings/me answers 405, as the real one does).
    role = "owner", access = OWNER_ACCESS, oldWorker = false,
    // X (migration 266): the business's numbers in phone_settings_get's `numbers` shape; null =
    // a server from before 266 (`number` and `route` only), which every other scenario is.
    numbers = null, textingActive = false,
  } = opts;
  const ctx = await browser.newContext({ viewport, ...(timezoneId ? { timezoneId } : {}), ...(userAgent ? { userAgent, isMobile: true, hasTouch: true } : {}) });
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
  // Every confirm is accepted, and its words kept (P20/P21: which saves ask "Record calls?").
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  const calls = [];
  const state = {
    phoneStatus, route: null,
    callerId: { available: trustAvailable, shakenStir: { registered: false, status: null }, voiceIntegrity: { registered: false, status: null }, checkedAt: null },
    sms: smsStatus,
    recording: recordingRow ? recordingView(recordingRow, recordingServerOn, transcribeServerOn) : null,
    number: opts.noNumber ? null : (numberOverride ?? { id: "num-1", e164: "+15555550199", textingStatus: "registered", voiceReady: false, callingOnly: false }),
    my,
    numbers: numbers ? numbers.map((n) => ({ ...n })) : null,
  };
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  // THE phone-api WORKER's voicemail audio, stubbed (registered after the abort-everything route,
  // so it wins). Records every request so K can prove nothing is fetched before Play, and that
  // the token travels in the Authorization header and never in the URL.
  const vm = [];
  await page.route("https://phone.structurestudiosuite.com/**", (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors, body: "" });
    vm.push({ url: req.url(), method: req.method(), authorization: req.headers()["authorization"] || null, body: req.postData() || null });
    // R. Your calls: GET and POST /settings/me, and GET /team, when the scenario gives the person's
    // settings. A save is checked as the Worker does (routes/me.ts hoursPatch: the REAL rule, then
    // at least one day and a zone), and refused in the Worker's shape.
    const wpath = new URL(req.url()).pathname;
    const wjson = (body, status = 200) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
    // W. The Worker before 264 routes POST /settings/me only, so a GET there is index.ts
    // handleApp's method mismatch, not a 404.
    if (oldWorker && wpath === "/settings/me" && req.method() === "GET") {
      return wjson({ ok: false, error: { code: "bad_request", message: "That method isn't allowed here." } }, 405);
    }
    // V. Your voicemail greeting (routes/greeting.ts), when the scenario's settings carry `greeting`:
    // Record "rings" (nothing is placed) and the recording lands on the next GET /settings/me, the
    // way the real one shows up once the call ends; Play is audio; the standard greeting clears it.
    if (state.my && state.my.greeting && wpath === "/settings/me/greeting/record") {
      if (state.greetRefuse) return wjson({ ok: false, error: { code: "bad_request", message: state.greetRefuse } }, 429);
      state.greetPending = { set: true, updated_at: "2026-10-05T17:00:00Z" };
      return wjson({ ok: true, ringing: true });
    }
    if (state.my && state.my.greeting && wpath === "/settings/me/greeting/clear") {
      state.my = { ...state.my, greeting: { set: false, updated_at: null } };
      return wjson({ ok: true, settings: state.my });
    }
    if (state.my && state.my.greeting && wpath === "/settings/me/greeting/audio" && !state.my.greeting.set) {
      return wjson({ ok: false, error: { code: "not_found", message: "You haven't recorded a greeting." } }, 404);
    }
    if (state.my && wpath === "/settings/me") {
      if (req.method() === "GET" && state.greetPending) { state.my = { ...state.my, greeting: state.greetPending }; state.greetPending = null; }
      if (req.method() === "GET") return wjson({ ok: true, settings: state.my });
      const r = workerSaveSettings(state.my, JSON.parse(req.postData() || "{}"));
      if (r.error) return wjson({ ok: false, error: { code: "bad_request", message: r.error } }, 400);
      state.my = r.settings;
      return wjson({ ok: true, settings: state.my });
    }
    if (state.my && wpath === "/team") {
      return wjson({ ok: true, members: team.filter((t) => t.phoneLevel !== "none").map((t) => ({ user_id: t.userId, full_name: t.name, identity_base: "u_x_g1" })) });
    }
    // Q. A recorded call's whole transcript (GET /calls/:id/transcript) is JSON; audio is audio.
    if (/\/calls\/[^/]+\/transcript$/.test(new URL(req.url()).pathname)) {
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify({ ok: true, call_id: REC_CALL, recording_id: REC_ID, transcript: REC_TRANSCRIPT, summary: REC_SUMMARY }) });
    }
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
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role, user_id: USER.id }]);
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
        // What the server answers after adopting (My Synergy Phone phase 6): the number joins the
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
    // X. A server with migration 266: every number, each saved, connected and joined by its id.
    if (state.numbers) {
      const eligible = new Set(team.filter((t) => t.phoneLevel !== "none").map((t) => t.userId));
      const names = new Map(team.map((t) => [t.userId, t.name]));
      const pickedOf = () => pickNumber(state.numbers, body.numberId);
      switch (body.action) {
        case "phone_settings_get":
          if (access.phone !== "view" && access.phone !== "edit") {
            const mine = state.numbers.find((n) => n.assignedUserId === USER.id) || state.numbers[0];
            return json(route, { ok: true, available: true, scope: "own", phoneStatus: state.phoneStatus, level: "own", canEdit: false,
              number: mine ? { e164: mine.e164, label: mine.label, mine: mine.assignedUserId === USER.id } : null, recording: null });
          }
          return json(route, { ok: true, available: true, scope: "team", phoneStatus: state.phoneStatus, level: "edit", canEdit: true,
            number: state.numbers[0] || null, route: state.numbers[0] ? state.numbers[0].route : null,
            numbers: state.numbers, perNumber: true, maxNumbers: MAX_NUMBERS, textingActive,
            canBuyNumber: rolloutOpen, canJoinTexting: rolloutOpen, numbersForSale: true, voiceSetup: true, canSwitchOn: rolloutOpen, canConnect: rolloutOpen, selfServe: false,
            callerId: state.numbers[0] ? state.numbers[0].callerId : null, canManageCallerId: trustOperator,
            recording: state.recording, canChangeRecording: !!state.recording && canChangeRecording,
            team, suggestedMembers: null });
        case "phone_settings_save": {
          const pk = pickedOf();
          if (!pk.ok) return json(route, { error: pk.error }, 409);
          const n = pk.n;
          const l = Object.prototype.hasOwnProperty.call(body, "label") ? parseNumberLabel(body.label) : { ok: true, value: n.label };
          if (!l.ok) return json(route, { error: l.error }, 400);
          const a = Object.prototype.hasOwnProperty.call(body, "assignedUserId") ? parseAssignee(body.assignedUserId, eligible, names) : { ok: true, value: n.assignedUserId };
          if (!a.ok) return json(route, { error: a.error }, 400);
          // sms_numbers_one_per_person, as the database answers it.
          if (a.value && state.numbers.some((x) => x.id !== n.id && x.assignedUserId === a.value)) {
            return json(route, { error: "That person already has their own number. Make that one a team line first, or choose someone else." }, 409);
          }
          const r = parseRoute(body, eligible, names);
          if (!r.ok) return json(route, { error: r.error }, 400);
          const rt = {
            mode: r.row.mode, members: r.row.members, ringSeconds: r.row.ring_seconds, noAnswer: r.row.no_answer,
            forwardTo: r.row.forward_to, businessHours: r.row.business_hours, timeZone: r.row.time_zone,
            afterHours: r.row.after_hours, greetingUrl: r.row.greeting_url, updatedAt: new Date().toISOString(),
          };
          Object.assign(n, { label: l.value, assignedUserId: a.value, route: rt, suggestedMembers: null });
          return json(route, { ok: true, numberId: n.id, label: n.label, assignedUserId: n.assignedUserId, route: rt });
        }
        case "phone_enable_number": {
          const pk = pickedOf();
          if (!pk.ok) return json(route, { error: pk.error }, 409);
          if (state.phoneStatus !== "on") return json(route, { error: "Turn calling on first, then connect the number." }, 409);
          pk.n.voiceReady = true;
          return json(route, { ok: true, number: { id: pk.n.id, e164: pk.n.e164, voiceReady: true } });
        }
        case "phone_number_texting": {
          const pk = pickedOf();
          if (!pk.ok) return json(route, { error: pk.error }, 409);
          if (!textingActive) return json(route, { error: "Texting isn't on for this account yet." }, 409);
          pk.n.callingOnly = false;
          return json(route, { ok: true, number: { id: pk.n.id, callingOnly: false } });
        }
        case "phone_buy_number": {
          if (state.numbers.length >= MAX_NUMBERS) return json(route, { error: "This account has 10 numbers." }, 409);
          const id = `00000000-0000-4000-8000-00000000a00${state.numbers.length + 1}`;
          state.numbers.push({ id, e164: body.phoneNumber, label: null, assignedUserId: null, textingStatus: "pending_registration",
            voiceReady: state.phoneStatus === "on", callingOnly: !textingActive, main: false,
            callerId: { available: true, shakenStir: { registered: false, status: null }, voiceIntegrity: { registered: false, status: null }, checkedAt: null },
            route: null, suggestedMembers: suggestedMembersFor(null, team) });
          return json(route, { ok: true, number: { id, e164: body.phoneNumber, voiceReady: state.phoneStatus === "on", callingOnly: !textingActive } });
        }
        case "phone_trust_status":
          return json(route, { error: "Caller ID registration is set up by Structure Studio. Ask us and we'll register your number." }, 403);
        default: break;
      }
    }
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId, role, operatorMode: !!body.targetClientId, access, prefs: null,
          phoneStatus: state.phoneStatus, configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Demo Tenant" }, emailReady: true });
      case "crm_record":
        return json(route, {
          ok: true, kind: body.kind, clientId, contact: CONTACT, designs: [DESIGN], orders: [], feed: FEED, focus: [], team: [], people: [], followers: [],
          sms: { ready: true, from: "+15555550199", optedOut: false, consented: true },
          build: [], stages: [], delivery: [], repairs: [],
        });
      case "phone_settings_get":
        // An 'own' caller gets their own slice (portal-settings' ownPhoneOnly branch).
        if (access.phone !== "view" && access.phone !== "edit") {
          return json(route, { ok: true, available: true, scope: "own", phoneStatus: state.phoneStatus, level: "own", canEdit: false,
            number: state.number ? { e164: state.number.e164 } : null, recording: null });
        }
        return json(route, { ok: true, available: true, scope: "team", phoneStatus: state.phoneStatus, level: "edit", canEdit: true,
          number: state.number, canBuyNumber: rolloutOpen, numbersForSale: true, voiceSetup: true,
          canSwitchOn: rolloutOpen, canConnect: rolloutOpen, selfServe: false,
          callerId: state.callerId, canManageCallerId: trustOperator,
          recording: state.recording, canChangeRecording: !!state.recording && canChangeRecording,
          route: state.route, team, suggestedMembers: state.route ? null : [USER.id] });
      // P. Call recording: the owner only (the server's rule; the stub refuses the same way), and
      // the REAL parseRecording decides what is valid.
      case "phone_recording_save": {
        if (!canChangeRecording) return json(route, { error: "Only the business owner can change call recording." }, 403);
        if (!state.recording) return json(route, { error: "Call recording isn't set up on this server yet." }, 503);
        const r = parseRecording(body);
        if (!r.ok) return json(route, { error: r.error }, 400);
        state.recording = recordingView({ ...r.row, phone_recording_updated_at: new Date().toISOString(), phone_recording_updated_by: USER.id }, recordingServerOn, transcribeServerOn);
        return json(route, { ok: true, recording: state.recording });
      }
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
        if (body.on && !rolloutOpen) return json(route, { error: "My Synergy Phone isn't open to every builder yet. Structure Studio switches it on for your account when it's ready." }, 403);
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
  return { ctx, page, calls, go, sent, vm, state, dialogs };
}

// R. The phone-api Worker's POST /settings/me for the person's own hours (routes/me.ts
// hoursPatch), with the REAL shared rule. Only the keys the Your calls card sends.
function workerSaveSettings(my, body) {
  const out = { ...my };
  if (body.dnd_cover_user_id !== undefined) out.dnd_cover_user_id = body.dnd_cover_user_id || null;
  let hoursSet = false;
  if (body.ring_hours !== undefined) {
    const h = parseBusinessHours(body.ring_hours, RING_HOURS_WORDS);
    if (!h.ok) return { error: h.error };
    if (h.value && !Object.keys(h.value).length) return { error: "Add hours to at least one day, or choose Always." };
    out.ring_hours = h.value;
    hoursSet = !!h.value;
  }
  if (body.ring_hours_tz !== undefined) {
    if (body.ring_hours_tz === null || body.ring_hours_tz === "") out.ring_hours_tz = null;
    else if (!validTimeZone(body.ring_hours_tz)) return { error: "That time zone isn't one we know. Pick it from the list." };
    else out.ring_hours_tz = body.ring_hours_tz;
  }
  if (hoursSet && !(body.ring_hours_tz && validTimeZone(body.ring_hours_tz))) return { error: "Choose the time zone your hours are in." };
  return { settings: out };
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
  // ── A + B. Owner, calling on, My Synergy Phone installed and signed in as them ──────────────
  {
    const s = await scenario(browser, { name: "A" });
    await openContact(s);
    const call = tabBtn(s.page, "Call");
    const rendered = ok("A0 the contact record rendered with a Call tab", (await call.count()) === 1);
    if (rendered) {
      ok("A1 Call is enabled", await call.isEnabled());
      const path0 = await s.page.evaluate(() => location.pathname);
      await tap(call);
      await s.page.waitForFunction(() => /Calling \(555\) 555-0142 in My Synergy Phone/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
      const msgs = await s.sent();
      const callMsg = msgs.find((m) => m.type === "sss.call");
      ok("A2 the portal pinged the extension first", msgs.length > 0 && msgs[0].type === "sss.ping", JSON.stringify(msgs.map((m) => m.type)));
      ok("A3 sss.call carries to_e164, contact_id, user_id and client_id",
        !!callMsg && callMsg.id === EXT_ID && callMsg.to_e164 === "+15555550142" && callMsg.contact_id === CONTACT_ID
          && callMsg.user_id === USER.id && callMsg.client_id === CLIENT, JSON.stringify(callMsg));
      const text = await s.page.locator('[data-ss-phone-panel="call"]').innerText().catch(() => "");
      ok("A4 the page says the call is running in My Synergy Phone", /Calling \(555\) 555-0142 in My Synergy Phone/.test(text), text.slice(0, 120));
      ok("A5 and the page did not move", (await s.page.evaluate(() => location.pathname)) === path0);
      await s.page.screenshot({ path: join(shots, "A-call-handed-off.png") });

      // B. SMS routes to the extension, with a way back.
      await pickDeal(s);
      await tap(tabBtn(s.page, "SMS"));
      await s.page.waitForFunction(() => document.body.innerText.includes("is open in My Synergy Phone"), null, { timeout: 8000 }).catch(() => {});
      const textMsg = (await s.sent()).find((m) => m.type === "sss.text");
      ok("B1 SMS sent sss.text with the same four fields",
        !!textMsg && textMsg.to_e164 === "+15555550142" && textMsg.contact_id === CONTACT_ID && textMsg.user_id === USER.id && textMsg.client_id === CLIENT,
        JSON.stringify(textMsg));
      ok("B2 the composer is replaced by 'open in My Synergy Phone'", (await s.page.locator('[data-ss-phone-panel="text"]').count()) === 1
        && (await s.page.locator('textarea[placeholder="Text this customer…"]').count()) === 0);
      await s.page.screenshot({ path: join(shots, "B-text-in-my-synergy-phone.png") });
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

      // Q. A recorded call (migration 263): its summary is on the line, and Play recording and
      // Show transcript ask the Worker only on the press, with the session in the header.
      const recLine = s.page.locator(`[data-ss-call-recording="${REC_CALL}"]`);
      ok("Q1 the recorded call's line shows its summary", (await recLine.count()) === 1
        && (await recLine.locator("[data-ss-call-summary]").innerText().catch(() => "")).includes("Pat wants a quote for a 10x12 utility shed"));
      const recPlay = s.page.locator(`[data-ss-recording-play="${REC_ID}"]`);
      ok("Q2 with Play recording and its length", (await recPlay.count()) === 1 && /Play recording · 3 min/.test(await recPlay.innerText().catch(() => "")),
        await recPlay.innerText().catch(() => "missing"));
      ok("Q3 nothing about the recording was fetched by opening the record", !s.vm.some((r) => /\/recordings\/|\/transcript$/.test(r.url)), JSON.stringify(s.vm));
      await recLine.scrollIntoViewIfNeeded().catch(() => {});
      await recLine.screenshot({ path: join(shots, "Q-recorded-call.png") }).catch(() => {});
      const before = s.vm.length;
      await tap(recPlay);
      const recAudio = s.page.locator(`audio[data-ss-recording="${REC_ID}"]`);
      await recAudio.waitFor({ timeout: 8000 }).catch(() => {});
      const gotRec = s.vm.slice(before).find((r) => r.method === "GET");
      ok("Q4 Play fetched <PHONE_API_BASE>/recordings/<id>/audio with the session in the header and none in the URL",
        !!gotRec && gotRec.url === `https://phone.structurestudiosuite.com/recordings/${REC_ID}/audio` && gotRec.authorization === `Bearer ${SESSION.access_token}`,
        JSON.stringify(gotRec));
      const recSrc = await recAudio.getAttribute("src").catch(() => null);
      ok("Q5 and plays it from a blob: URL", !!recSrc && recSrc.startsWith("blob:"), recSrc);
      const toggle = s.page.locator(`[data-ss-transcript-toggle="${REC_CALL}"]`);
      ok("Q6 Show transcript is offered", (await toggle.count()) === 1 && (await toggle.innerText().catch(() => "")) === "Show transcript");
      await tap(toggle);
      await s.page.locator("[data-ss-transcript]").waitFor({ timeout: 8000 }).catch(() => {});
      const gotT = s.vm.filter((r) => /\/transcript$/.test(r.url)).pop();
      ok("Q7 it read /calls/<id>/transcript with the session in the header",
        !!gotT && gotT.url === `https://phone.structurestudiosuite.com/calls/${REC_CALL}/transcript` && gotT.authorization === `Bearer ${SESSION.access_token}`,
        JSON.stringify(gotT));
      ok("Q8 and shows the speaker-labelled lines", (await s.page.locator("[data-ss-transcript]").innerText().catch(() => "")).includes("Team: Sure, what size?"));
      ok("Q9 no element anywhere carries the session token", !(await s.page.content()).includes(SESSION.access_token));
      await recLine.screenshot({ path: join(shots, "Q-recorded-call-open.png") }).catch(() => {});
    }

    // J. Call on the contact LIST.
    await s.go("/portal/contacts");
    const rowCall = s.page.locator(`[data-ss-list-call="${CONTACT_ID}"]`);
    await rowCall.waitFor({ timeout: 15000 }).catch(() => {});
    const listRendered = ok("J0 the contact list rendered a Call button on the row", (await rowCall.count()) === 1);
    if (listRendered) {
      ok("J1 it is enabled when calling is on and My Synergy Phone is this person's", await rowCall.isEnabled());
      const before = (await s.sent()).length;
      const path0 = await s.page.evaluate(() => location.pathname);
      await tap(rowCall);
      await s.page.waitForFunction(() => /Calling \(555\) 555-0142 in My Synergy Phone/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
      const msgs = (await s.sent()).slice(before);
      const callMsg = msgs.find((m) => m.type === "sss.call");
      ok("J2 the row's Call sends sss.call with the same four fields",
        !!callMsg && callMsg.id === EXT_ID && callMsg.to_e164 === "+15555550142" && callMsg.contact_id === CONTACT_ID
          && callMsg.user_id === USER.id && callMsg.client_id === CLIENT, JSON.stringify(msgs));
      const panel = await s.page.locator('[data-ss-phone-panel="list-call"]').innerText().catch(() => "");
      ok("J3 the row says the call is running in My Synergy Phone", /Calling \(555\) 555-0142 in My Synergy Phone/.test(panel), panel.slice(0, 120));
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
    ok("C1 Call with no extension shows the Install My Synergy Phone card", /Install My Synergy Phone to call from Structure Studio/.test(card), card.slice(0, 80));
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

  // ── D. My Synergy Phone signed in as somebody else ────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "D", who: { user_id: REP, client_id: CLIENT } });
    await openContact(s);
    await tap(tabBtn(s.page, "Call"));
    await s.page.waitForFunction(() => /signed in as/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
    const panel = await s.page.locator('[data-ss-phone-panel="call"]').innerText().catch(() => "");
    ok("D1 Call names who My Synergy Phone is signed in as", /signed in as Robin Example/.test(panel), panel.slice(0, 140));
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
      ok("Q10 in view-as a recorded call keeps its summary, with no Play recording or Show transcript",
        (await s.page.locator(`[data-ss-call-recording="${REC_CALL}"] [data-ss-call-summary]`).count()) === 1
          && (await s.page.locator("[data-ss-recording-play], [data-ss-transcript-toggle]").count()) === 0);
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
    ok("Q11 with calling off, a recorded call shows its summary but no Play recording or Show transcript",
      (await s.page.locator("[data-ss-call-summary]").count()) === 1
        && (await s.page.locator("[data-ss-recording-play], [data-ss-transcript-toggle]").count()) === 0);
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

      // L. Plan phase 6: a texting number that does not ring My Synergy Phone yet gets connected here.
      const connect = s.page.locator("[data-ss-phone-connect]");
      ok("L1 a number not yet connected offers 'Connect this number for calls'", (await connect.count()) === 1 && await connect.isEnabled());
      await tap(connect);
      await s.page.waitForSelector("[data-ss-phone-connected]", { timeout: 8000 }).catch(() => {});
      ok("L2 it sends phone_enable_number and the card says the number is connected",
        s.calls.some((c) => c.action === "phone_enable_number") && (await s.page.locator("[data-ss-phone-connected]").count()) === 1
          && /Calls to this number ring My Synergy Phone now/.test(await s.page.locator("body").innerText()));

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

  // ── P. Settings → Phone, Call recording (migration 263) ──────────────────────────────────
  {
    // An owner who turned recording OFF (a stamped choice, which 287 never overrides) turns it
    // back on with their own wording.
    const s = await scenario(browser, { name: "P", recordingRow: {
      phone_record_calls: false, phone_recording_updated_at: "2026-10-05T12:00:00Z", phone_recording_updated_by: USER.id } });
    await s.go("/portal/settings/phone");
    const card = s.page.locator("[data-ss-phone-recording]").first();
    await card.waitFor({ timeout: 15000 }).catch(() => {});
    const rendered = ok("P0 the Phone tab has a Call recording card, off as the owner left it", (await s.page.locator('[data-ss-phone-recording="off"]').count()) === 1
      && (await s.page.locator("[data-ss-phone-recording-default]").count()) === 0);
    if (rendered) {
      const save = s.page.locator("[data-ss-phone-recording-save]");
      const words = s.page.locator("[data-ss-phone-recording-notice]");
      ok("P1 its Save waits for a change", (await save.count()) === 1 && await save.isDisabled());
      const notice = s.page.locator('[data-ss-phone-recording-check="notice"]');
      ok("P2 the announcement is ticked and can't be unticked", (await notice.isChecked()) && (await notice.isDisabled()));
      ok("P3 the wording box shows the standard sentence, without \"and transcribed\" while transcripts haven't started",
        (await words.getAttribute("placeholder")) === "This call may be recorded."
          && /Leave it empty for the standard sentence: \u201cThis call may be recorded\.\u201d/.test(await card.innerText().catch(() => "")));
      ok("P3b the transcripts box is still there and ticked, and says transcripts haven't started on this account",
        (await s.page.locator('[data-ss-phone-recording-check="transcribe"]').isChecked())
          && /Transcripts haven\u2019t started on this account yet\. Your choice is saved and takes effect once they do\./.test(
            await s.page.locator("[data-ss-phone-recording-transcripts-waiting]").innerText().catch(() => "")));
      ok("P4 recordings are kept for a year unless the owner picks otherwise", (await s.page.locator("[data-ss-phone-recording-keep]").inputValue()) === "365");
      ok("P5 the legal note is on the card", (await s.page.locator("[data-ss-phone-recording-legal]").count()) === 1);
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await card.screenshot({ path: join(shots, "P-recording-off.png") }).catch(() => {});
      await tick(s.page.locator('[data-ss-phone-recording-check="on"]'));
      await words.fill("Hello and welcome to our shop.");
      ok("P6 wording that doesn't say the call is recorded is refused before Save",
        /has to tell callers the call is recorded/.test(await card.innerText()) && (await save.isDisabled()));
      const mine = "Thanks for calling Demo Builder. This call is recorded so we get your order right.";
      await words.fill(mine);
      await s.page.locator("[data-ss-phone-recording-keep]").selectOption("90");
      ok("P7 good wording lets it save", await save.isEnabled());
      await tap(save);
      await s.page.waitForSelector('[data-ss-phone-recording="on"]', { timeout: 8000 }).catch(() => {});
      const sent = s.calls.filter((c) => c.action === "phone_recording_save").pop();
      ok("P8 Save sent phone_recording_save with on, the wording, transcripts and the keep length, and never notice:false",
        !!sent && sent.on === true && sent.noticeText === mine && sent.transcribe === true && sent.retentionDays === 90 && !("notice" in sent),
        JSON.stringify(sent));
      const after = await card.innerText().catch(() => "");
      ok("P9 the real validator took it, and the card says calls are recorded",
        (await s.page.locator('[data-ss-phone-recording-status="on"]').innerText().catch(() => "")) === "Calls are recorded"
          && /Saved\. Calls are announced and recorded from the next call on\./.test(after), after.slice(0, 160));
      ok("P10 and who changed it, and when", /Last changed today by Olive Owner\./.test(after));
      ok("P11 the routing form's Save was never sent", !s.calls.some((c) => c.action === "phone_settings_save"));
      await card.screenshot({ path: join(shots, "P-recording-on.png") }).catch(() => {});
      const asked = s.dialogs.filter((m) => /^Record calls\?/.test(m)).length;
      await s.page.locator("[data-ss-phone-recording-keep]").selectOption("730");
      await tap(save);
      for (let i = 0; i < 80 && s.calls.filter((c) => c.action === "phone_recording_save").length < 2; i++) await s.page.waitForTimeout(100);
      const again = s.calls.filter((c) => c.action === "phone_recording_save");
      ok("P21 once the owner's own choice is stamped on, keeping recordings longer saves without asking \"Record calls?\" again",
        again.length === 2 && again[1].retentionDays === 730 && s.dialogs.filter((m) => /^Record calls\?/.test(m)).length === asked && asked === 1,
        JSON.stringify(s.dialogs));
    }
    await s.ctx.close();
  }
  {
    // Not the owner (an admin with phone edit, or an operator in view-as): read-only.
    const s = await scenario(browser, { name: "P-admin", canChangeRecording: false, recordingRow: { phone_record_calls: true, phone_recording_retention_days: 180 } });
    await s.go("/portal/settings/phone");
    const card = s.page.locator('[data-ss-phone-recording="on"]');
    await card.waitFor({ timeout: 15000 }).catch(() => {});
    const inputs = card.locator("input, select");
    let allOff = (await inputs.count()) > 0;
    for (let i = 0; i < await inputs.count(); i++) allOff = allOff && await inputs.nth(i).isDisabled();
    ok("P12 anyone but the owner sees the card read-only, and is told who can change it",
      (await card.count()) === 1 && allOff && (await s.page.locator("[data-ss-phone-recording-save]").count()) === 0
        && /Only the business owner can change call recording\./.test(await card.innerText().catch(() => ""))
        && (await s.page.locator("[data-ss-phone-recording-keep]").inputValue()) === "180");
    await card.screenshot({ path: join(shots, "P-recording-not-owner.png") }).catch(() => {});
    await s.ctx.close();
  }
  {
    // Migration 287: a business no owner has saved is ON by default. With the server recording,
    // the card says calls are recorded, and that it is the default rather than who changed it.
    const s = await scenario(browser, { name: "P-default-on", recordingRow: { phone_record_calls: true } });
    await s.go("/portal/settings/phone");
    const card = s.page.locator('[data-ss-phone-recording="on"]');
    await card.waitFor({ timeout: 15000 }).catch(() => {});
    const text = await card.innerText().catch(() => "");
    ok("P16 on by default: the card reads \"Calls are recorded\" and says it is on by default for every business",
      (await s.page.locator('[data-ss-phone-recording-status="on"]').innerText().catch(() => "")) === "Calls are recorded"
        && (await s.page.locator('[data-ss-phone-recording-check="on"]').isChecked())
        && /On by default for every business\. The business owner can turn it off\./.test(text) && !/Last changed/.test(text), text.slice(0, 200));
    ok("P17 the owner can still turn it off", await s.page.locator('[data-ss-phone-recording-check="on"]').isEnabled());
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await card.screenshot({ path: join(shots, "P-recording-default-on.png") }).catch(() => {});
    // Its first save stamps the owner as having chosen recording, so it asks first, even when
    // only the keep length changed (longer, so the shorter-keep confirm doesn't ask instead).
    await s.page.locator("[data-ss-phone-recording-keep]").selectOption("730");
    await tap(s.page.locator("[data-ss-phone-recording-save]"));
    await s.page.waitForFunction(() => /Saved\./.test(document.querySelector("[data-ss-phone-recording]")?.innerText || ""), null, { timeout: 8000 }).catch(() => {});
    const first = s.calls.filter((c) => c.action === "phone_recording_save").pop();
    ok("P20 the first save of a business on by default asks \"Record calls?\" before it stamps the owner's choice",
      s.dialogs.length === 1 && /^Record calls\? From your next call on, every call to and from your business number is announced and then recorded\./.test(s.dialogs[0])
        && !!first && first.on === true && first.retentionDays === 730,
      JSON.stringify({ dialogs: s.dialogs, first }));
    await s.ctx.close();
  }
  {
    // Between 287 and the rail (SETUP.md 7d steps 1-4): on by default, but nothing records yet.
    const s = await scenario(browser, { name: "P-default-waiting", recordingRow: { phone_record_calls: true }, recordingServerOn: false });
    await s.go("/portal/settings/phone");
    const card = s.page.locator('[data-ss-phone-recording="on"]');
    await card.waitFor({ timeout: 15000 }).catch(() => {});
    const text = await card.innerText().catch(() => "");
    ok("P19 on by default with the server's switch off: 'On, not started yet', never 'Calls are recorded'",
      (await s.page.locator('[data-ss-phone-recording-status="waiting"]').innerText().catch(() => "")) === "On, not started yet"
        && (await s.page.locator("[data-ss-phone-recording-waiting]").count()) === 1 && !/Calls are recorded/.test(text)
        && /On by default for every business\./.test(text), text.slice(0, 200));
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await card.screenshot({ path: join(shots, "P-recording-default-waiting.png") }).catch(() => {});
    await s.ctx.close();
  }
  {
    // The CALL_TRANSCRIBE rail on (not the case today): the standard sentence says "and
    // transcribed", and the "haven't started" note is gone.
    const s = await scenario(browser, { name: "P-transcribing", recordingRow: { phone_record_calls: true }, transcribeServerOn: true });
    await s.go("/portal/settings/phone");
    const card = s.page.locator("[data-ss-phone-recording]").first();
    await card.waitFor({ timeout: 15000 }).catch(() => {});
    ok("P18 with the transcripts rail on the placeholder becomes \"... and transcribed\" and the note is hidden",
      (await s.page.locator("[data-ss-phone-recording-notice]").getAttribute("placeholder")) === "This call may be recorded and transcribed."
        && (await s.page.locator("[data-ss-phone-recording-transcripts-waiting]").count()) === 0);
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await card.screenshot({ path: join(shots, "P-recording-transcribing.png") }).catch(() => {});
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "P-before-263", recordingRow: null });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector('[data-ss-phone-settings="team"]', { timeout: 15000 }).catch(() => {});
    ok("P13 before migration 263 the card says call recording isn't available, and offers nothing",
      (await s.page.locator('[data-ss-phone-recording="unavailable"]').count()) === 1 && (await s.page.locator("[data-ss-phone-recording-save]").count()) === 0);
    await s.ctx.close();
  }
  {
    // The server's switch is off (the Worker's CALL_RECORDING rail): the owner can still choose,
    // but the card never says calls are recorded, and the save says when it starts.
    const s = await scenario(browser, { name: "P-not-started", recordingServerOn: false });
    await s.go("/portal/settings/phone");
    const card = s.page.locator("[data-ss-phone-recording]").first();
    await card.waitFor({ timeout: 15000 }).catch(() => {});
    ok("P14 with the server's switch off the card says recording hasn't started on this account",
      (await s.page.locator("[data-ss-phone-recording-waiting]").count()) === 1);
    await tick(s.page.locator('[data-ss-phone-recording-check="on"]'));
    await tap(s.page.locator("[data-ss-phone-recording-save]"));
    await s.page.waitForSelector('[data-ss-phone-recording="on"]', { timeout: 8000 }).catch(() => {});
    const after = await card.innerText().catch(() => "");
    ok("P15 and after the owner turns it on: 'On, not started yet', never 'Calls are recorded'",
      (await s.page.locator('[data-ss-phone-recording-status="waiting"]').innerText().catch(() => "")) === "On, not started yet"
        && !/Calls are recorded/.test(after)
        && /Saved\. Calls will be announced and recorded once call recording starts on this account\./.test(after), after.slice(0, 200));
    await card.screenshot({ path: join(shots, "P-recording-not-started.png") }).catch(() => {});
    await s.ctx.close();
  }

  // ── L. Settings → Phone with NO number: the calling-only purchase (stubbed) ──────────────
  {
    const s = await scenario(browser, { name: "L", noNumber: true });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector("[data-ss-phone-buy]", { timeout: 15000 }).catch(() => {});
    const offered = ok("L3 an owner with no number is offered 'Get a number for calls'", (await s.page.locator("[data-ss-phone-buy]").count()) === 1);
    if (offered) {
      // Choices made BEFORE there is a number (the form is open; only its Save waits for one):
      // the rep ticked and one after another. They must still be there once the number arrives.
      const box = (id) => s.page.locator(`[data-ss-phone-member="${id}"] input[type=checkbox]`);
      const inOrder = s.page.locator("label", { hasText: "Ring one after another, in this order" }).locator("input");
      ok("L8a the answer list can be chosen before there is a number", (await tick(box(REP))) && (await tick(inOrder)));
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
      ok("L8 what was chosen before the number was bought is still chosen (the rep ticked, one after another)",
        (await box(USER.id).isChecked().catch(() => false)) && (await box(REP).isChecked().catch(() => false)) && (await inOrder.isChecked().catch(() => false)));
      await s.page.screenshot({ path: join(shots, "L-number-bought.png"), fullPage: true });
      await tap(s.page.locator("[data-ss-phone-save]"));
      await s.page.waitForFunction(() => document.body.innerText.includes("Saved. Calls to your number"), null, { timeout: 8000 }).catch(() => {});
      const saved = s.calls.filter((c) => c.action === "phone_settings_save").pop() || {};
      ok("L9 and Save sends them for the new number (checked by the real rules)",
        JSON.stringify(saved.members) === JSON.stringify([USER.id, REP]) && saved.mode === "in_order" && saved.numberId === "num-2", JSON.stringify(saved));
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
    ok("I1 Call on a phone says it is opening the My Synergy Phone app", /Opening the My Synergy Phone app to call \(555\) 555-0142/.test(panel), panel.slice(0, 100));
    ok("I2 with the app links (not the Chrome extension)", (await s.page.locator('[data-ss-phone-install="mobile"]').count()) === 1
      && !/Chrome extension/.test(await s.page.locator('[data-ss-phone-install="mobile"]').innerText()));
    const deep = navs.find((u) => u.startsWith("mysynergyphone://"));
    // SPEC section 7: the four fields, then `ts` (when the page made the link; the app drops one
    // more than a minute old).
    const want = `mysynergyphone://call?to=%2B15555550142&contact_id=${CONTACT_ID}&user_id=${USER.id}&client_id=${CLIENT}&ts=`;
    const ts = deep && deep.startsWith(want) ? Number(deep.slice(want.length)) : NaN;
    ok("I3 the app link carries the four fields and ts, the moment it was made", Number.isInteger(ts) && Math.abs(Date.now() - ts) < 60000,
      deep || `navigations seen: ${JSON.stringify(navs)}`);
    await s.page.screenshot({ path: join(shots, "I-phone-browser.png") });
    await s.ctx.close();
  }

  // ── R. Your calls: when my phone rings (migration 264) ──────────────────────────────────
  {
    const WEEKDAYS = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [["08:00", "17:00"]]]));
    const my = { dnd: false, dnd_until: null, forward_to_cell: null, dnd_cover_user_id: null, ring_hours: null, ring_hours_tz: null };
    const team = TEAM.map((t) => (t.userId === REP ? { ...t, ringHours: WEEKDAYS, ringHoursTz: "America/Chicago" } : { ...t, ringHours: null, ringHoursTz: null }));
    const s = await scenario(browser, { name: "R", my, team, timezoneId: "America/Denver" });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector("[data-ss-phone-my-hours]", { timeout: 15000 }).catch(() => {});
    const card = s.page.locator("[data-ss-phone-my-hours]");
    const radio = (label) => card.locator("label", { hasText: label }).locator("input");
    const said = () => card.innerText().catch(() => "");
    const posts = () => s.vm.filter((r) => r.method === "POST" && new URL(r.url).pathname === "/settings/me");
    const rendered = ok("R0 Your calls has 'When my phone rings', on Always (nothing saved yet)",
      (await card.count()) === 1 && await radio("Always, whenever the business is open").isChecked().catch(() => false), (await said()).slice(0, 120));
    if (rendered) {
      const repRow = await s.page.locator(`[data-ss-phone-member="${REP}"]`).innerText().catch(() => "");
      ok("R1 the team screen shows the rep's own hours, in their zone", /Their hours: Mon–Fri 8 AM–5 PM \(Central time\)/.test(repRow), repRow.replace(/\s+/g, " "));
      ok("R1b and nothing for someone who set none", !/Their hours/.test(await s.page.locator(`[data-ss-phone-member="${USER.id}"]`).innerText().catch(() => "")));
      await tick(radio("Only during my hours"));
      const day = (d) => card.locator(`[data-ss-phone-my-day="${d}"]`);
      ok("R2 'Only during my hours' opens the weekly editor: seven days, weekdays 8 to 5, in this browser's zone",
        (await card.locator("[data-ss-phone-my-day]").count()) === 7 && (await card.locator("select").inputValue()) === "America/Denver"
          && (await day("mon").locator("input[type=time]").first().inputValue()) === "08:00" && /Off/.test(await day("sat").innerText()),
        `${await card.locator("select").inputValue().catch(() => "?")}`);
      // Saturday morning as well.
      await tap(day("sat").locator("button", { hasText: "+ add hours" }));
      await day("sat").locator("input[type=time]").nth(0).fill("09:00");
      await day("sat").locator("input[type=time]").nth(1).fill("12:00");
      await tap(card.locator("[data-ss-phone-my-hours-save]"));
      await s.page.waitForFunction(() => document.body.innerText.includes("Saved. Your phone rings"), null, { timeout: 8000 }).catch(() => {});
      const p1 = posts().pop();
      const b1 = p1 ? JSON.parse(p1.body || "{}") : null;
      ok("R3 Save sent POST <PHONE_API_BASE>/settings/me with the hours and the zone, the session in the header and not the URL",
        !!b1 && b1.ring_hours_tz === "America/Denver" && JSON.stringify(b1.ring_hours.sat) === JSON.stringify([["09:00", "12:00"]])
          && JSON.stringify(b1.ring_hours.mon) === JSON.stringify([["08:00", "17:00"]]) && !b1.ring_hours.sun
          && p1.authorization === `Bearer ${SESSION.access_token}` && !p1.url.includes(SESSION.access_token), JSON.stringify(b1));
      ok("R4 the real rule accepted it, and the card says so in words",
        /Saved\. Your phone rings Mon–Fri 8 AM–5 PM; Sat 9 AM–12 PM \(Mountain time\)\./.test(await said()), (await said()).slice(-160));
      ok("R4b outside them, it says who rings (nobody chosen: the team, or voicemail)",
        /Outside your hours, calls skip you and ring your teammates, or go to voicemail\./.test(await said()));
      await s.page.screenshot({ path: join(shots, "R-your-hours.png"), fullPage: true });

      // A refusal from the rule reaches the screen in its words.
      await day("tue").locator("input[type=time]").nth(0).fill("18:00");
      await tap(card.locator("[data-ss-phone-my-hours-save]"));
      await s.page.waitForFunction(() => document.body.innerText.includes("closing time has to be after"), null, { timeout: 8000 }).catch(() => {});
      ok("R5 a closing time before the opening is refused with the rule's sentence",
        /On Tuesday, the closing time has to be after the opening time\./.test(await said()), (await said()).slice(-160));
      await tap(card.locator("button", { hasText: "Cancel" }));
      ok("R6 Cancel puts back what is saved", (await day("tue").locator("input[type=time]").nth(0).inputValue()) === "08:00");

      // No day at all is caught before anything is sent.
      const before = posts().length;
      await tick(radio("Only during my hours"));
      for (let i = 0; i < 12 && (await card.locator('button[title="Remove these hours"]').count()); i++) {
        await tap(card.locator('button[title="Remove these hours"]').first());
      }
      await tap(card.locator("[data-ss-phone-my-hours-save]"));
      await s.page.waitForTimeout(300);
      ok("R7 a week with no day at all is refused on the page, and nothing is sent",
        /Add hours to at least one day, or choose Always\./.test(await said()) && posts().length === before, `posts ${before} -> ${posts().length}`);

      // Always: clears them.
      await tick(radio("Always, whenever the business is open"));
      await tap(card.locator("[data-ss-phone-my-hours-save]"));
      await s.page.waitForFunction(() => document.body.innerText.includes("whenever the business is open."), null, { timeout: 8000 }).catch(() => {});
      const b2 = posts().length > before ? JSON.parse(posts().pop().body || "{}") : null;
      ok("R8 Always sends ring_hours null and says so", !!b2 && b2.ring_hours === null && !("ring_hours_tz" in b2)
        && /Saved\. Your phone rings whenever the business is open\./.test(await said()), JSON.stringify(b2));
    }
    await s.ctx.close();
  }
  {
    // A Worker that keeps covers but not hours: the card has no hours section.
    const s = await scenario(browser, { name: "R9", my: { dnd: false, dnd_until: null, forward_to_cell: null, dnd_cover_user_id: null } });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector("[data-ss-phone-cover]", { timeout: 15000 }).catch(() => {});
    ok("R9 a Worker that doesn't keep hours: the cover shows, 'When my phone rings' doesn't",
      (await s.page.locator("[data-ss-phone-cover]").count()) === 1 && (await s.page.locator("[data-ss-phone-my-hours]").count()) === 0);
    ok("V6 nor does a Worker that doesn't keep greetings show 'Voicemail greeting'", (await s.page.locator("[data-ss-phone-greeting]").count()) === 0);
    await s.ctx.close();
  }

  // ── V. Your calls: your own voicemail greeting, recorded by phone (migration 264) ────────────
  {
    const my = { dnd: false, dnd_until: null, forward_to_cell: null, dnd_cover_user_id: null, ring_hours: null, ring_hours_tz: null, greeting: { set: false, updated_at: null } };
    const s = await scenario(browser, { name: "V", my, timezoneId: "America/Denver" });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector("[data-ss-phone-greeting]", { timeout: 15000 }).catch(() => {});
    const sec = s.page.locator("[data-ss-phone-greeting]");
    const said = () => sec.innerText().catch(() => "");
    const reqs = (p, method) => s.vm.filter((r) => r.method === method && new URL(r.url).pathname === p);
    const rendered = ok("V0 Your calls has 'Voicemail greeting': none yet, Record only (no Play, no standard-greeting button)",
      (await sec.count()) === 1 && /You haven't recorded one, so callers hear the business's greeting\./.test(await said())
        && /Record my greeting/.test(await said()) && (await sec.locator("[data-ss-phone-greeting-play]").count()) === 0
        && (await sec.locator("[data-ss-phone-greeting-clear]").count()) === 0, (await said()).slice(0, 160));
    ok("V7 the owner's link field says it plays on the shared number, and that everyone records their own",
      /Plays on calls to the shared number that aren.t for one person\./.test(await s.page.innerText("body").catch(() => ""))
        && /Everyone can record their own greeting under Your calls\./.test(await s.page.innerText("body").catch(() => "")));
    if (rendered) {
      await tap(sec.locator("[data-ss-phone-greeting-record]"));
      await s.page.waitForFunction(() => document.body.innerText.includes("My Synergy Phone will ring now"), null, { timeout: 8000 }).catch(() => {});
      const rec = reqs("/settings/me/greeting/record", "POST").pop();
      ok("V1 Record sent POST <PHONE_API_BASE>/settings/me/greeting/record, the session in the header and not the URL, and says the phone will ring",
        !!rec && rec.authorization === `Bearer ${SESSION.access_token}` && !rec.url.includes(SESSION.access_token)
          && /My Synergy Phone will ring now\. Answer it and speak after the tone\./.test(await said()), (await said()).slice(-160));
      // The card looks for the new greeting every few seconds (PHONE_GREETING_POLL_MS).
      await s.page.waitForFunction(() => document.body.innerText.includes("Your new greeting is saved."), null, { timeout: 15000 }).catch(() => {});
      ok("V2 once the recording lands it says so, and when it was recorded",
        /Your new greeting is saved\./.test(await said()) && /Your own greeting, recorded Oct 5\./.test(await said())
          && /Record a new greeting/.test(await said()), (await said()).slice(0, 200));
      await tap(sec.locator("[data-ss-phone-greeting-play]"));
      await s.page.waitForSelector("[data-ss-phone-greeting-audio]", { timeout: 8000 }).catch(() => {});
      const audio = reqs("/settings/me/greeting/audio", "GET").pop();
      const src = await sec.locator("[data-ss-phone-greeting-audio]").getAttribute("src").catch(() => "");
      ok("V3 Play fetches GET <PHONE_API_BASE>/settings/me/greeting/audio with the session in the header, and plays a blob: URL",
        !!audio && audio.authorization === `Bearer ${SESSION.access_token}` && !audio.url.includes(SESSION.access_token) && /^blob:/.test(src || ""), src || "no <audio>");
      await s.page.screenshot({ path: join(shots, "V-your-greeting.png"), fullPage: true });
      await tap(sec.locator("[data-ss-phone-greeting-clear]"));
      await s.page.waitForFunction(() => document.body.innerText.includes("Done. Callers hear the business's greeting."), null, { timeout: 8000 }).catch(() => {});
      ok("V4 'Use the standard greeting' (after a confirm) sends POST .../greeting/clear and the card goes back to none",
        reqs("/settings/me/greeting/clear", "POST").length === 1 && /You haven't recorded one/.test(await said())
          && (await sec.locator("[data-ss-phone-greeting-audio]").count()) === 0, (await said()).slice(0, 200));
      s.state.greetRefuse = "Your phone is already ringing for your greeting. Try again in half a minute.";
      await tap(sec.locator("[data-ss-phone-greeting-record]"));
      await s.page.waitForFunction(() => document.body.innerText.includes("already ringing for your greeting"), null, { timeout: 8000 }).catch(() => {});
      ok("V5 a refusal reaches the screen in the Worker's own words, and nothing waits on it",
        /Your phone is already ringing for your greeting\. Try again in half a minute\./.test(await said()) && /Record my greeting/.test(await said()), (await said()).slice(-160));
    }
    await s.ctx.close();
  }

  // ── X. More than one number (migration 266) ───────────────────────────────────────────────
  {
    const CID = { available: true, shakenStir: { registered: false, status: null }, voiceIntegrity: { registered: false, status: null }, checkedAt: null };
    const MAIN = { id: "00000000-0000-4000-8000-00000000a001", e164: "+15555550199", label: null, assignedUserId: null, textingStatus: "registered",
      voiceReady: true, callingOnly: false, main: true, callerId: CID,
      route: { mode: "all_at_once", members: [USER.id], ringSeconds: 20, noAnswer: "voicemail", forwardTo: null, businessHours: null, timeZone: "America/Chicago", afterHours: "voicemail", greetingUrl: null, updatedAt: null },
      suggestedMembers: null };
    const RILEY = { id: "00000000-0000-4000-8000-00000000a002", e164: "+15555550198", label: "Riley cell", assignedUserId: REP, textingStatus: "pending_registration",
      voiceReady: false, callingOnly: true, main: false, callerId: CID, route: null, suggestedMembers: [REP] };
    const s = await scenario(browser, { name: "X", numbers: [MAIN, RILEY], textingActive: true });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector("[data-ss-phone-number-list]", { timeout: 15000 }).catch(() => {});
    const rows = await s.page.locator("[data-ss-phone-number-row]").allInnerTexts();
    ok("X1 two numbers are listed, each with its name and whose it is",
      rows.length === 2 && /Main number/.test(rows[0]) && /\(555\) 555-0199/.test(rows[0]) && /Team line/.test(rows[0])
        && /Riley cell/.test(rows[1]) && /\(555\) 555-0198/.test(rows[1]) && /Riley Rep/.test(rows[1]), JSON.stringify(rows));
    ok("X2 the first number is open: its own answer list (the owner ticked) and its Save",
      (await s.page.locator('[data-ss-phone-number-row="+15555550199"][aria-pressed="true"]').count()) === 1
        && (await s.page.locator(`[data-ss-phone-member="${USER.id}"] input[type=checkbox]`).isChecked().catch(() => false)));
    await s.page.screenshot({ path: join(shots, "X-two-numbers.png"), fullPage: true });

    // Open Riley's number: its own name, person, answer list (just Riley, nothing saved yet), Connect.
    await tap(s.page.locator('[data-ss-phone-number-row="+15555550198"]'));
    await s.page.waitForTimeout(300);
    ok("X3 picking Riley's number opens ITS settings: name, Riley as the person, Riley ticked, Connect and Use for texting",
      (await s.page.locator("[data-ss-phone-number-label]").inputValue().catch(() => "")) === "Riley cell"
        && (await s.page.locator("[data-ss-phone-number-owner-select]").inputValue().catch(() => "")) === REP
        && (await s.page.locator(`[data-ss-phone-member="${REP}"] input[type=checkbox]`).isChecked().catch(() => false))
        && !(await s.page.locator(`[data-ss-phone-member="${USER.id}"] input[type=checkbox]`).isChecked().catch(() => true))
        && (await s.page.locator("[data-ss-phone-connect]").count()) === 1 && (await s.page.locator("[data-ss-phone-texting-join-button]").count()) === 1);
    await s.page.screenshot({ path: join(shots, "X-riley-number-open.png"), fullPage: true });

    await s.page.locator("[data-ss-phone-number-label]").fill("Riley's line", { timeout: 5000 }).catch(() => {});
    await tap(s.page.locator("[data-ss-phone-save]"));
    await s.page.waitForTimeout(600);
    const saved = s.calls.filter((c) => c.action === "phone_settings_save").pop() || {};
    ok("X4 Save sends THIS number's id, name, person and answer list (checked by the real rules)",
      saved.numberId === RILEY.id && saved.label === "Riley's line" && saved.assignedUserId === REP && JSON.stringify(saved.members) === JSON.stringify([REP]),
      JSON.stringify(saved));
    ok("X5 the list shows the new name", /Riley's line/.test(await s.page.locator('[data-ss-phone-number-row="+15555550198"]').innerText().catch(() => "")));

    await tap(s.page.locator("[data-ss-phone-connect]"));
    await s.page.waitForTimeout(400);
    await tap(s.page.locator("[data-ss-phone-texting-join-button]"));
    await s.page.waitForTimeout(400);
    const enable = s.calls.filter((c) => c.action === "phone_enable_number").pop() || {};
    const join_ = s.calls.filter((c) => c.action === "phone_number_texting").pop() || {};
    ok("X6 Connect and \"Use this number for texting too\" each name Riley's number",
      enable.numberId === RILEY.id && join_.numberId === RILEY.id && (await s.page.locator("[data-ss-phone-texting-join-button]").count()) === 0
        && (await s.page.locator("[data-ss-phone-connected]").count()) === 1, JSON.stringify({ enable, join_ }));

    // Back to the main number: its settings are its own, untouched; Riley can't be given a second number.
    await tap(s.page.locator('[data-ss-phone-number-row="+15555550199"]'));
    await s.page.waitForTimeout(300);
    const x7 = await s.page.evaluate(([rep, me]) => {
      const sel = document.querySelector("[data-ss-phone-number-owner-select]");
      const opt = sel && [...sel.options].find((o) => o.value === rep);
      const box = document.querySelector(`[data-ss-phone-member="${me}"] input[type=checkbox]`);
      return { owner: sel ? sel.value : "x", rileyDisabled: !!(opt && opt.disabled), rileyText: opt ? opt.textContent : null, ownerTicked: !!(box && box.checked) };
    }, [REP, USER.id]);
    ok("X7 the main number's form is its own (owner ticked, team line), and Riley is shown as having their own number",
      x7.ownerTicked && x7.owner === "" && x7.rileyDisabled && /has their own number/.test(x7.rileyText || ""), JSON.stringify(x7));

    // Add a third number (a STUB purchase): it is listed and opened, as a team line ringing the owner.
    await tap(s.page.locator("[data-ss-phone-add]"));
    await tap(s.page.locator("[data-ss-phone-search]"));
    await s.page.waitForSelector('[data-ss-phone-result="+15555550101"]', { timeout: 5000 }).catch(() => {});
    await tap(s.page.locator('[data-ss-phone-result="+15555550101"] button'));
    await s.page.waitForTimeout(1200);
    const bought = s.calls.filter((c) => c.action === "phone_buy_number").pop() || {};
    ok("X8 Add another number buys the picked one (stub) and opens it, listed third",
      bought.phoneNumber === "+15555550101" && (await s.page.locator("[data-ss-phone-number-row]").count()) === 3
        && (await s.page.locator('[data-ss-phone-number-row="+15555550101"][aria-pressed="true"]').count()) === 1
        && /Number 3/.test(await s.page.locator('[data-ss-phone-number-row="+15555550101"]').innerText().catch(() => "")), JSON.stringify(bought));
    await s.page.screenshot({ path: join(shots, "X-third-number-added.png"), fullPage: true });
    await s.ctx.close();
  }
  {
    // A sales rep whose own number it is: "Your number", the one their calls show.
    const RILEY_OWN = { id: "00000000-0000-4000-8000-00000000a002", e164: "+15555550198", label: "Riley cell", assignedUserId: USER.id };
    const s = await scenario(browser, { name: "X9", role: "user", access: PRESETS.sales_rep, numbers: [{ id: "00000000-0000-4000-8000-00000000a001", e164: "+15555550199", label: null, assignedUserId: null }, RILEY_OWN] });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector('[data-ss-phone-settings="own"]', { timeout: 15000 }).catch(() => {});
    const card = await s.page.locator('[data-ss-phone-numbers]').first().innerText().catch(() => "");
    ok("X9 a sales rep with their own number is shown it as \"Your number\"", /Your number/.test(card) && /\(555\) 555-0198/.test(card) && /Riley cell/.test(card), card);
    await s.page.screenshot({ path: join(shots, "X-sales-rep-own-number.png"), fullPage: true });
    await s.ctx.close();
  }

  // ── W. Who reaches Your calls ─────────────────────────────────────────────────────────────
  {
    // A sales rep: phone 'own' and no settings area at all (the real preset). The apps' "Change in
    // Structure Studio" button opens /portal/settings/phone; before Phone joined SETTINGS_AREAS
    // that clamped them to Designs, with no Settings anywhere.
    const my = { dnd: false, dnd_until: null, forward_to_cell: null, dnd_cover_user_id: null, ring_hours: null, ring_hours_tz: null, greeting: { set: false, updated_at: null } };
    const s = await scenario(browser, { name: "W", role: "user", access: PRESETS.sales_rep, my, timezoneId: "America/Denver" });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector("[data-ss-phone-my-hours]", { timeout: 15000 }).catch(() => {});
    const path = await s.page.evaluate(() => location.pathname);
    const rail = await s.page.evaluate(() => [...document.querySelectorAll(".ss-side.ss-side-settings .ss-nav a")]
      .map((a) => new URL(a.href).pathname).filter((p) => p.startsWith("/portal/settings/")));
    ok("W1 a sales rep's /portal/settings/phone stays put (not their fallback page)", path === "/portal/settings/phone", path);
    ok("W2 their Settings rail is exactly Phone and My Profile", JSON.stringify(rail) === JSON.stringify(["/portal/settings/phone", "/portal/settings/myprofile"]), JSON.stringify(rail));
    ok("W3 the Phone tab is their own view, with Your calls: who covers, their hours and their greeting",
      (await s.page.locator('[data-ss-phone-settings="own"]').count()) === 1 && (await s.page.locator("[data-ss-phone-cover]").count()) === 1
        && (await s.page.locator("[data-ss-phone-my-hours]").count()) === 1 && (await s.page.locator("[data-ss-phone-greeting]").count()) === 1);
    await s.page.screenshot({ path: join(shots, "W-sales-rep-your-calls.png"), fullPage: true });
    await s.go("/portal/settings");
    ok("W4 a bare /portal/settings is Settings for them too, landing on Phone", (await s.page.evaluate(() => location.pathname)).startsWith("/portal/settings")
      && (await s.page.locator("[data-ss-phone-yours]").count()) === 1, await s.page.evaluate(() => location.pathname));
    await s.ctx.close();
  }
  {
    // A Worker from before 264: GET /settings/me is 405 "That method isn't allowed here."
    const s = await scenario(browser, { name: "W5", my: { dnd: false, dnd_until: null, forward_to_cell: null, dnd_cover_user_id: null }, oldWorker: true });
    await s.go("/portal/settings/phone");
    await s.page.waitForSelector('[data-ss-phone-settings="team"]', { timeout: 15000 }).catch(() => {});
    await s.page.waitForTimeout(800);
    const body = await s.page.innerText("body").catch(() => "");
    ok("W5 an older Worker (405 on GET /settings/me): the Phone tab renders, with no Your calls card and no fault on screen",
      (await s.page.locator('[data-ss-phone-settings="team"]').count()) === 1 && (await s.page.locator("[data-ss-phone-yours]").count()) === 0
        && !/isn't allowed/.test(body), (body.match(/.{0,60}isn't allowed.{0,20}/) || [""])[0]);
    await s.ctx.close();
  }

  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\nmySynergyPhone: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
