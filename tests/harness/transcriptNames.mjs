// A call transcript on the contact record names the team member instead of "Team", driven for
// real on the COMPILED portal (Carolyn 2026-10-23, 24:13: "Customer" can stay). The timeline is
// built by the REAL crmFeed callFeedEvents from stubbed phone_calls rows, so `teamSpeaker` is the
// shipped rule's answer, and the transcript text is the phone-api Worker's shape
// ("Customer: ..." / "Team: ..." lines). What it proves, after pressing Show transcript:
//
//   A. an outbound call placed by one person: their name on our side's lines, "Customer" kept,
//      and a customer saying "Team: " mid-line is left as their words
//   B. an inbound call answered by one person: their name
//   C. a call handed on to a teammate (transferred_from): two of us spoke, so it stays "Team"
//   D. a call answered by someone no longer on the team: stays "Team", never "a former team member"
//   E. a line from a server before this change (no teamSpeaker): stays "Team", as before
//   and the line's own "Talked ... · by <name>" is unchanged.
//
// Supabase and the phone-api Worker are stubbed at the network layer (no login, nothing leaves
// the machine); the stub shape is crmOptOutBanner.mjs's. Nothing is played or sent.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/transcriptNames.mjs          (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/transcript-names (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an
// older portal.app.compiled.js> serves that file instead, which is how to prove the checks can
// fail: against the artifact before this change A and B fail (every line says "Team").
//
// Fixtures are obviously fake (example.test, 555 numbers, made-up people), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";
import { callFeedEvents } from "../../supabase/functions/_shared/crmFeed.ts";

const CLIENT = "acme-sheds";
const CONTACT_ID = "00000000-0000-4000-8000-0000000000c1";
const JORDAN = "00000000-0000-4000-8000-0000000000a1";
const SAM = "00000000-0000-4000-8000-0000000000a2";
const GONE = "00000000-0000-4000-8000-0000000000a4";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: JORDAN, aud: "authenticated", role: "authenticated", email: "jordan@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER_ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders",
  "change_order_approve", "build_schedule", "delivery_schedule", "repairs", "commissions", "reports", "phone",
  "settings_structures", "settings_options", "settings_branding", "settings_crm", "settings_quickbooks",
  "settings_email", "settings_team", "settings_billing"].map((k) => [k, "edit"]));

const DESIGN = {
  short_code: "SS-TALK00001", created_at: "2026-10-20T15:00:00Z", updated_at: "2026-10-20T15:00:00Z",
  status: "sent", selections: { style: "Utility", size: "10x12" }, expected_close_date: null,
  total_cents: 512300, ghl_estimate_number: null, image_url: null, ss_quote_number: "SSQ-1001",
  ss_quote_pdf_url: null, ss_invoice_sent_at: null, ss_invoice_requested_at: null,
  contact_id: CONTACT_ID, contact: { name: "Alex Tester", phone: "(555) 555-0142", email: "alex@example.test" },
};
const LIST_ROW = {
  short_code: DESIGN.short_code, created_at: DESIGN.created_at, updated_at: DESIGN.updated_at, status: "sent",
  contact: DESIGN.contact, sel_style: "utility", sel_size: "10x12", ghl_estimate_number: null, contact_id: CONTACT_ID,
};
const CONTACT = { id: CONTACT_ID, name: "Alex Tester", phone: "(555) 555-0142", email: "alex@example.test", phone_digits: "5555550142", owner_user_id: null, sms_opt_out_at: null, first_seen_at: "2026-09-01T12:00:00Z" };

// The calls as phone_calls rows (with the recording embed), and each one's transcript as the
// Worker serves it from GET /calls/:id/transcript.
const NAMES = { [JORDAN]: "Jordan Lee", [SAM]: "Sam Rivera" };
const rec = (n) => ({ id: `6a1b2c3d-4e5f-4061-8172-8394050000${n}0`, status: "completed", duration_s: 73, summary: `Call ${n} summary.`, transcript_status: "done", deleted_at: null });
const row = (n, over) => ({
  id: `7b2c3d4e-5f60-4172-8283-94a5b6c7d8e${n}`, direction: "in", status: "completed", from_e164: "+15555550142", to_e164: "+15555550199",
  started_at: `2026-10-2${n}T17:13:00Z`, answered_at: `2026-10-2${n}T17:13:04Z`, duration_s: 73,
  placed_by: null, answered_by: null, transferred_from: null, rang_user_ids: [JORDAN, SAM], phone_voicemails: null,
  phone_call_recordings: rec(n), ...over,
});
const ROWS = {
  A: row(1, { direction: "out", from_e164: "+15555550199", to_e164: "+15555550142", placed_by: JORDAN }),
  B: row(2, { answered_by: SAM }),
  C: row(3, { answered_by: SAM, transferred_from: JORDAN }),
  D: row(4, { answered_by: GONE }),
  E: row(5, { direction: "out", from_e164: "+15555550199", to_e164: "+15555550142", placed_by: SAM }),
};
const TRANSCRIPT = "Customer: Hi, I'm calling about a shed. Team: is that you?\nTeam: Sure, what size?\nCustomer: Ten by twelve.\nTeam: We have that one.";
const feedNow = callFeedEvents([ROWS.A, ROWS.B, ROWS.C, ROWS.D], (v) => NAMES[v] ?? "a former team member", (v) => NAMES[v] ?? null);
// E: the same kind of line as an older portal-settings sent it, with no speakerName (no teamSpeaker).
const feedOld = callFeedEvents([ROWS.E], (v) => NAMES[v] ?? "a former team member");
const FEED = [...feedNow, ...feedOld];

const { ok, failed } = reporter();
const shots = shotsDir("transcript-names");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  // THE phone-api WORKER: GET /calls/:id/transcript answers each call's transcript (registered
  // after the abort-everything route, so it wins).
  const asked = [];
  await page.route("https://phone.structurestudiosuite.com/**", (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors, body: "" });
    const m = new URL(req.url()).pathname.match(/^\/calls\/([^/]+)\/transcript$/);
    if (!m) return route.fulfill({ status: 404, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ ok: false, error: { code: "not_found", message: "Not here." } }) });
    asked.push(m[1]);
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({ ok: true, call_id: m[1], recording_id: "r", transcript: TRANSCRIPT, summary: null }) });
  });
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/designs")) return json(route, [LIST_ROW]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER_ACCESS, prefs: null,
          phoneStatus: "on", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "crm_record":
        return json(route, {
          ok: true, kind: body.kind, clientId: CLIENT, contact: CONTACT, designs: [DESIGN], orders: [], feed: FEED, focus: [], team: [], people: [], followers: [],
          sms: { ready: true, from: "+15555550199", optedOut: false, consented: true }, build: [], stages: [], delivery: [], repairs: [],
        });
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  if (process.env.SS_PORTAL_ARTIFACT) {
    const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
    await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
  }
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/contacts/c-${CONTACT_ID}`);
  await page.waitForFunction(() => document.querySelectorAll("[data-ss-transcript-toggle]").length >= 5, null, { timeout: 20000 }).catch(() => {});

  // Open every call's transcript, then read each one.
  const read = {};
  for (const [k, r] of Object.entries(ROWS)) {
    const toggle = page.locator(`[data-ss-transcript-toggle="${r.id}"]`);
    if (!(await toggle.count())) { read[k] = null; continue; }
    await toggle.scrollIntoViewIfNeeded().catch(() => {});
    await toggle.click({ timeout: 5000 }).catch(() => {});
    const box = page.locator(`[data-ss-call-recording="${r.id}"] [data-ss-transcript]`);
    await box.waitFor({ timeout: 8000 }).catch(() => {});
    read[k] = await box.innerText().catch(() => null);
  }
  ok("0 every recorded call offers Show transcript, and each one was read from the Worker on the press",
    Object.values(read).every((t) => typeof t === "string") && Object.values(ROWS).every((r) => asked.includes(r.id)), JSON.stringify(Object.keys(read).filter((k) => read[k] == null)));

  const lines = (t) => String(t || "").split("\n");
  const named = (name) => [
    "Customer: Hi, I'm calling about a shed. Team: is that you?",
    `${name}: Sure, what size?`,
    "Customer: Ten by twelve.",
    `${name}: We have that one.`,
  ];
  ok("A outbound, placed by one person: their name on our lines, the customer's lines (and words) untouched",
    JSON.stringify(lines(read.A)) === JSON.stringify(named("Jordan Lee")), JSON.stringify(lines(read.A)));
  ok("B inbound, answered by one person: their name", JSON.stringify(lines(read.B)) === JSON.stringify(named("Sam Rivera")), JSON.stringify(lines(read.B)));
  ok("C handed on to a teammate: stays \"Team\"", read.C === TRANSCRIPT, JSON.stringify(read.C));
  ok("D answered by someone no longer on the team: stays \"Team\"", read.D === TRANSCRIPT && !/former team member/i.test(read.D || ""), JSON.stringify(read.D));
  ok("E a line from a server before this change (no teamSpeaker): stays \"Team\"", read.E === TRANSCRIPT, JSON.stringify(read.E));
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  ok("F the call lines still say who, as before", body.includes("Talked 1m 13s · by Jordan Lee") && body.includes("Answered by Sam Rivera · talked 1m 13s"),
    (body.match(/(Talked|Answered)[^·]*·[^·]*?(?=\s[A-Z][a-z]{2} \d)/g) || []).join(" | ").slice(0, 300));

  // The whole timeline line (title, "Talked ... · by ...", summary, transcript), centred so the
  // sticky header doesn't cover it.
  for (const [k, file] of [["A", "A-outbound-named.png"], ["C", "C-handed-on-team.png"]]) {
    const line = page.locator(`[data-ss-call-recording="${ROWS[k].id}"]`).locator("xpath=..");
    await line.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
    await page.waitForTimeout(150);
    await line.screenshot({ path: join(shots, file) }).catch(() => {});
  }
  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
  await ctx.close();
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.error(`\n${bad.length} check(s) failed`); process.exit(1); }
console.log("\nall checks held");
