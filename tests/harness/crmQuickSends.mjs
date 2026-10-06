// Quick sends in the contact record's Email and SMS boxes, driven for real on the COMPILED portal
// (2026-10-04). Carolyn 2026-09-30: "quick sends on text and email, both of them … so that they
// can easily just click and choose the list of things. And obviously putting in first name, last
// name". Her rule, from the app: "Inserting fills the box. Sending is yours."
//
//   A. the picker lists the person's quick sends (the stubbed quick_sends_list), with "All · N" and
//      each category in first-appearance order, each row filled in for THIS customer, "used N×"
//      and Insert; the list is read when the picker first opens, never when the record opens
//   B. Insert puts "Hey Alex,…" in the email BODY, after anything typed with one space, leaves the
//      subject exactly as typed, closes the picker and hands focus back to the box
//   C. quick_send_used is posted once per Insert, with that quick send's id
//   D. nothing calls crm_send_email before Send is pressed; Send then sends what is in the box
//   E. one that would run past the box (20,000 for an email, 1,600 for a text) is refused with the
//      app's sentence, the box unchanged and nothing counted
//   F. view-as (quickSendsOn=false): no Quick sends button, and the list is never asked for; the
//      line above the box doesn't tell the operator replies come back to them (the server never
//      puts an operator's address on a builder's email), while a builder's own record says where
//      a reply goes: the record, and the writer's inbox only if they switched reply copies on in
//      My Profile (2026-10-07; until the company sets up replies, the inbox either way, and all
//      three lines say so); with copies off it also says attached files aren't kept on the record
//   G. every phone-core case (tests/phone/quickSendCases.mjs) against the compiled
//      ssFillQuickSend / ssInsertIntoDraft (window.__ssQuickSends); and when the phone repo is
//      checked out beside this one (or SS_PHONE_CORE_DIR names its packages/phone-core), the
//      compiled copy against phone-core itself on a seeded corpus and on the starter set the
//      phone repo keeps (its wording is never printed or copied here: this repo is public)
//   H. the SMS box: the same picker over the same one read, Insert into the text box, too long refused
//   I. an empty list says where to add them; a server that doesn't know the action yet (or any
//      failure) hides the button with no banner; Escape and a click outside close the picker; at a
//      phone's width the picker fits on screen
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the stub shape
// and the view-as setup are mySynergyPhone.mjs's. NOTHING IS SENT: crm_send_email is answered by
// the stub.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/crmQuickSends.mjs            (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/crm-quick-sends (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an
// older portal.app.compiled.js> serves that file instead, which is how to prove the checks can
// fail: against the artifact before this change A, B and G fail (there is no button and no
// __ssQuickSends).
//
// Fixtures are obviously fake (example.test, 555 numbers, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";
import { FILL_CASES, FUZZ_FILLS, fuzzBodies, INSERT_CASES, TOO_LONG } from "../phone/quickSendCases.mjs";

const CLIENT = "acme-sheds";
const VIEWED = "demo-builder";
// Synthetic, like every id here: the repo is public, so no live row's id belongs in a fixture.
const CONTACT_ID = "00000000-0000-4000-8000-0000000000c1";
const QS1 = "3f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a61";
const QS2 = "3f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a62";
const QS3 = "3f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a63";
const QS4 = "3f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a64";
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

// One deal: the Email and SMS tabs file against a picked deal (the 2026-09-02 picker rule).
const DESIGN = {
  short_code: "SS-QSEND0001", created_at: "2026-09-17T15:00:00Z", updated_at: "2026-09-17T15:00:00Z",
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

// The person's list, as quick_sends_list answers it. Neutral wording, not the starter set.
const LONG_BODY = ("Here is everything about getting your building delivered. " + "We check the site, the access and the ground. ".repeat(40)).trim();
const QUICK_SENDS = [
  { id: QS1, name: "Check in", body: "Hey {first_name}, just checking in on your building. {my_name}", category: "Follow-ups", sort_order: 0, usage_count: 2 },
  { id: QS2, name: "Thanks for stopping by", body: "Thanks for stopping by the lot, {first_name}!", category: "Openers", sort_order: 1, usage_count: 0 },
  { id: QS3, name: "Delivery details", body: LONG_BODY, category: "Follow-ups", sort_order: 2, usage_count: 0 },
  { id: QS4, name: "Sign-off", body: "Talk soon, {my_name}", category: null, sort_order: 3, usage_count: 7 },
];
const FILLED_1 = "Hey Alex, just checking in on your building. Jordan";
const FILLED_2 = "Thanks for stopping by the lot, Alex!";

const { ok, failed } = reporter();
const shots = shotsDir("crm-quick-sends");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

/**
 * One fresh browser context per scenario. → { page, calls, go }; `calls` is every portal-settings
 * body the page posted, in order.
 *   list: what quick_sends_list answers (an array), or "old" for a server that doesn't know it.
 */
async function scenario(browser, { name, operator = false, list = QUICK_SENDS, prefs = null, viewport = { width: 1400, height: 1000 } }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const calls = [];
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
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
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    const clientId = body.targetClientId || CLIENT;
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId, role: "owner", operatorMode: !!body.targetClientId, access: OWNER_ACCESS, prefs,
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "crm_record":
        return json(route, {
          ok: true, kind: body.kind, clientId, contact: CONTACT, designs: [DESIGN], orders: [], feed: [], focus: [], team: [], people: [], followers: [],
          sms: { ready: true, from: "+15555550199", optedOut: false, consented: true },
          build: [], stages: [], delivery: [], repairs: [],
        });
      case "quick_sends_list":
        // The server refuses an operator (QUICK_SENDS_VIEW_AS); the stub does too, so a list
        // asked for in view-as fails a check rather than passing quietly.
        if (body.targetClientId) return json(route, { error: "Quick sends belong to the person signed in, so they aren't available while you're viewing another account." }, 403);
        if (list === "old") return json(route, { error: `Unrecognised action "${body.action}".` }, 403);
        return json(route, { ok: true, quick_sends: list, my_name: "Jordan Lee" });
      case "quick_send_used":
        return QUICK_SENDS.some((q) => q.id === body.id) ? json(route, { ok: true }) : json(route, { error: "That quick send wasn't found." }, 404);
      case "crm_send_email":
      case "crm_send_sms":
        return json(route, { ok: true, messageId: "stub", id: "stub" });
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
  await page.waitForTimeout(600);
  const go = async (path) => {
    await page.evaluate((p) => { history.pushState({}, "", p + window.location.search); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
    await page.waitForTimeout(1200);
  };
  return { ctx, page, calls, go };
}

// A click that cannot abort the run: a missing control is a FAILED CHECK further down.
const tap = (loc, opts = {}) => loc.click({ timeout: 5000, ...opts }).then(() => true, () => false);
const tabBtn = (page, label) => page.locator("button").filter({ hasText: new RegExp(`^${label}$`) }).first();
const actions = (s, a) => s.calls.filter((c) => c.action === a);

async function openRecordTab(s, label) {
  await s.go(`/portal/contacts/c-${CONTACT_ID}`);
  await s.page.waitForFunction(() => document.body.innerText.includes("SUMMARY"), null, { timeout: 20000 }).catch(() => {});
  await s.page.waitForTimeout(300);
  // Pick the deal: the Email and SMS tabs file against one.
  await s.page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Utility 10x12/.test(x.innerText || ""));
    if (b) b.click();
  });
  await s.page.waitForTimeout(400);
  await tap(tabBtn(s.page, label));
  await s.page.waitForTimeout(400);
}
const picker = (page, ch) => page.locator(`[data-ss-quick-send-picker="${ch}"]`);
const rowNames = (page, ch) => page.evaluate((c) =>
  [...document.querySelectorAll(`[data-ss-quick-send-picker="${c}"] [data-ss-quick-send]`)].map((r) => ({
    id: r.getAttribute("data-ss-quick-send"),
    name: ((r.firstElementChild && r.firstElementChild.firstElementChild) || {}).innerText || "",
    preview: (r.querySelector("[data-ss-quick-send-preview]") || {}).textContent || "",
    text: r.innerText || "",
  })), ch);
const insertBtn = (page, ch, name) => page.locator(`[data-ss-quick-send-picker="${ch}"] button[aria-label="Insert ${name}"]`);

// ── phone-core itself, when the phone repo is here (G) ─────────────────────────────────────────
// Node strips the types from a .ts import itself (22.18+ / 23.6+), and phone-core's quickSends.ts
// imports nothing, so it loads as it is.
function phoneCoreDir() {
  if (process.env.SS_PHONE_CORE_DIR) return process.env.SS_PHONE_CORE_DIR;
  return fileURLToPath(new URL("../../../structure-studio-phone/packages/phone-core", import.meta.url));
}
async function phoneCore() {
  const file = join(phoneCoreDir(), "src", "quickSends.ts");
  if (!existsSync(file)) return null;
  try { return await import(pathToFileURL(file).href); } catch (e) { console.log(`(phone-core found but not loadable: ${e.message})`); return null; }
}
// The starter set's bodies, read the way phone-core's own test reads them, from the phone repo's
// docs/sql/quick_send_defaults.sql. Bodies only, and never printed.
function starterBodies() {
  const file = join(phoneCoreDir(), "..", "..", "docs", "sql", "quick_send_defaults.sql");
  if (!existsSync(file)) return null;
  const sql = readFileSync(file, "utf8");
  const s = "'((?:[^']|'')*)'";
  const row = new RegExp(`\\(${s}, ${s}, ${s}, (\\d+)\\)`, "g");
  return [...sql.matchAll(row)].map((m) => m[2].replace(/''/g, "'"));
}

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  // ── A–E. The owner on their own account, the Email box ───────────────────────────────────────
  {
    const s = await scenario(browser, { name: "main" });
    await openRecordTab(s, "Email");
    const subject = s.page.locator('input[placeholder="Subject"]');
    const bodyBox = s.page.locator('textarea[placeholder="Write to this customer…"]');
    const rendered = ok("A0 the Email box rendered on the contact record", (await subject.count()) === 1 && (await bodyBox.count()) === 1);
    if (!rendered) throw new Error("the Email box never rendered; refusing to report the rest as passes");
    const bodyText = await s.page.locator("body").innerText();
    ok("F5 (outside view-as, with reply copies off, the line says replies come back to the record, the inbox only until replies are set up, and files aren't kept on the record)",
      /To alex@example\.test — replies come back to this record \(your inbox until your company sets up replies\)\. Files a customer attaches aren't kept on the record yet: switch on reply copies in My Profile if you need them\./.test(bodyText)
        && !/replies come back here and to your inbox/.test(bodyText), bodyText.match(/To alex@example\.test.{0,260}/)?.[0]);
    ok("A1 the list is not read when the record opens", actions(s, "quick_sends_list").length === 0,
      JSON.stringify(s.calls.map((c) => c.action)));
    const btn = s.page.locator('[data-ss-quick-sends="email"]');
    ok("A2 a Quick sends button sits in the Email row", (await btn.count()) === 1 && /Quick sends/.test(await btn.innerText().catch(() => "")));

    await subject.fill("About your building");
    await tap(btn);
    await picker(s.page, "email").waitFor({ timeout: 5000 }).catch(() => {});
    await s.page.waitForTimeout(300);
    ok("A3 opening it reads the list, once", actions(s, "quick_sends_list").length === 1);
    const rows = await rowNames(s.page, "email");
    ok("A4 it lists the person's quick sends, in their order", JSON.stringify(rows.map((r) => r.id)) === JSON.stringify([QS1, QS2, QS3, QS4]),
      JSON.stringify(rows.map((r) => r.name)));
    const chips = await s.page.locator('[data-ss-quick-send-picker="email"] [data-ss-quick-send-chip]').allInnerTexts();
    ok("A5 chips: All · N, then each category in first-appearance order", JSON.stringify(chips.map((c) => c.trim())) === JSON.stringify(["All · 4", "Follow-ups", "Openers"]),
      JSON.stringify(chips));
    ok("A6 each row is filled in for this customer and this person", rows[0] && rows[0].preview === FILLED_1 && rows[3] && rows[3].preview === "Talk soon, Jordan",
      rows[0] && rows[0].preview);
    ok("A7 with how often each was used", rows[0] && /used 2×/.test(rows[0].text) && rows[3] && /used 7×/.test(rows[3].text));
    ok("A8 and Carolyn's line", /Inserting fills the box\. Sending is yours\./.test(await picker(s.page, "email").innerText().catch(() => "")));
    await tap(s.page.locator('[data-ss-quick-send-picker="email"] [data-ss-quick-send-chip="Openers"]'));
    await s.page.waitForTimeout(200);
    const openers = await rowNames(s.page, "email");
    ok("A9 a category chip shows just its own", JSON.stringify(openers.map((r) => r.id)) === JSON.stringify([QS2]), JSON.stringify(openers.map((r) => r.name)));
    await tap(s.page.locator('[data-ss-quick-send-picker="email"] [data-ss-quick-send-chip=""]'));
    await s.page.waitForTimeout(200);
    await s.page.screenshot({ path: join(shots, "A-email-picker.png") });

    // ── B + C. Insert ──
    await tap(insertBtn(s.page, "email", "Check in"));
    await s.page.waitForTimeout(400);
    ok("B1 Insert puts \"Hey Alex,…\" in the email body", (await bodyBox.inputValue()) === FILLED_1, JSON.stringify(await bodyBox.inputValue()));
    ok("B2 and leaves the subject exactly as typed", (await subject.inputValue()) === "About your building", await subject.inputValue());
    ok("B3 the picker closes", (await picker(s.page, "email").count()) === 0);
    const focus = await s.page.evaluate(() => {
      const el = document.activeElement;
      return { box: !!el && el.tagName === "TEXTAREA" && el.getAttribute("placeholder") === "Write to this customer…", caret: el && el.selectionStart, len: el && el.value.length };
    });
    ok("B4 focus is back in the body, at the end", focus.box && focus.caret === focus.len, JSON.stringify(focus));
    await s.page.waitForTimeout(400);
    const used1 = actions(s, "quick_send_used");
    ok("C1 quick_send_used is posted once, with that id", used1.length === 1 && used1[0].id === QS1, JSON.stringify(used1));
    ok("D1 nothing has called crm_send_email", actions(s, "crm_send_email").length === 0);

    // A second Insert goes after what is there, with one space, and the count shows the first.
    await tap(s.page.locator('[data-ss-quick-sends="email"]'));
    await s.page.waitForTimeout(300);
    const again = await rowNames(s.page, "email");
    ok("C2 the list is not read again, and the first Insert shows as used 3×", actions(s, "quick_sends_list").length === 1 && again[0] && /used 3×/.test(again[0].text),
      again[0] && again[0].text);
    await tap(insertBtn(s.page, "email", "Thanks for stopping by"));
    await s.page.waitForTimeout(400);
    ok("B5 a second Insert goes after the first, with one space", (await bodyBox.inputValue()) === `${FILLED_1} ${FILLED_2}`, JSON.stringify(await bodyBox.inputValue()));
    const used2 = actions(s, "quick_send_used");
    ok("C3 and is counted once, with its own id", used2.length === 2 && used2[1].id === QS2, JSON.stringify(used2));
    ok("D2 still nothing has called crm_send_email", actions(s, "crm_send_email").length === 0);
    await s.page.screenshot({ path: join(shots, "B-email-inserted.png") });

    // ── D. Send is the person's own press, and sends what is in the box ──
    await tap(s.page.locator("button").filter({ hasText: /^Send email$/ }));
    await s.page.waitForTimeout(700);
    const sent = actions(s, "crm_send_email");
    ok("D3 Send email sends exactly once, with the box's words and the typed subject",
      sent.length === 1 && sent[0].body === `${FILLED_1} ${FILLED_2}` && sent[0].subject === "About your building", JSON.stringify(sent));

    // ── E. Too long for an email ──
    const big = "y".repeat(19000);
    await bodyBox.fill(big);
    const usedBefore = actions(s, "quick_send_used").length;
    await tap(s.page.locator('[data-ss-quick-sends="email"]'));
    await s.page.waitForTimeout(300);
    await tap(insertBtn(s.page, "email", "Delivery details"));
    await s.page.waitForTimeout(400);
    ok("E1 one that would pass 20,000 characters is refused, the box unchanged", (await bodyBox.inputValue()) === big, `${(await bodyBox.inputValue()).length} chars`);
    ok("E2 with the app's sentence", (await s.page.locator("body").innerText()).includes(TOO_LONG.email));
    await s.page.waitForTimeout(300);
    ok("E3 and nothing is counted", actions(s, "quick_send_used").length === usedBefore);
    ok("E4 and nothing is sent", actions(s, "crm_send_email").length === 1);
    await s.page.screenshot({ path: join(shots, "E-email-too-long.png") });

    // ── I. Escape and a click outside close it ──
    await bodyBox.fill("");
    await tap(s.page.locator('[data-ss-quick-sends="email"]'));
    await s.page.waitForTimeout(200);
    await s.page.keyboard.press("Escape");
    await s.page.waitForTimeout(200);
    const escClosed = (await picker(s.page, "email").count()) === 0;
    const backOnButton = await s.page.evaluate(() => !!document.activeElement && document.activeElement.getAttribute("data-ss-quick-sends") === "email");
    ok("I1 Escape closes the picker and hands focus back to the button", escClosed && backOnButton);
    await tap(s.page.locator('[data-ss-quick-sends="email"]'));
    await s.page.waitForTimeout(200);
    await s.page.mouse.click(5, 5);
    await s.page.waitForTimeout(200);
    ok("I2 a click outside closes it", (await picker(s.page, "email").count()) === 0);

    // ── H. The SMS box: the same picker, the same one read ──
    await tap(tabBtn(s.page, "SMS"));
    await s.page.waitForTimeout(400);
    const smsBox = s.page.locator('textarea[placeholder="Text this customer…"]');
    const smsBtn = s.page.locator('[data-ss-quick-sends="sms"]');
    ok("H1 the SMS box has a Quick sends button too", (await smsBox.count()) === 1 && (await smsBtn.count()) === 1);
    await tap(smsBtn);
    await picker(s.page, "sms").waitFor({ timeout: 5000 }).catch(() => {});
    ok("H2 it lists the same quick sends without reading them again", (await rowNames(s.page, "sms")).length === 4 && actions(s, "quick_sends_list").length === 1);
    await tap(insertBtn(s.page, "sms", "Check in"));
    await s.page.waitForTimeout(400);
    ok("H3 Insert fills the text box", (await smsBox.inputValue()) === FILLED_1, JSON.stringify(await smsBox.inputValue()));
    ok("H4 counted once more, and no text was sent", actions(s, "quick_send_used").length === usedBefore + 1 && actions(s, "crm_send_sms").length === 0);
    const smsBig = "z".repeat(1000);
    await smsBox.fill(smsBig);
    await tap(smsBtn);
    await s.page.waitForTimeout(300);
    await tap(insertBtn(s.page, "sms", "Delivery details"));
    await s.page.waitForTimeout(400);
    ok("H5 one that would pass 1,600 characters is refused, the box unchanged", (await smsBox.inputValue()) === smsBig);
    ok("H6 with the app's sentence for a text", (await s.page.locator("body").innerText()).includes(TOO_LONG.sms));
    await s.page.screenshot({ path: join(shots, "H-sms-too-long.png") });

    // ── G. phone-core's cases against the COMPILED helpers ──
    const g = await s.page.evaluate(({ fills, inserts }) => {
      const api = window.__ssQuickSends;
      if (!api) return null;
      return {
        fill: fills.map(([, body, fill]) => api.fill(body, fill)),
        insert: inserts.map(([draft, text]) => api.insertIntoDraft(draft, text)),
      };
    }, { fills: FILL_CASES, inserts: INSERT_CASES });
    ok("G1 the compiled portal publishes its two phone-core ports", !!g);
    if (g) {
      const badFill = FILL_CASES.filter((c, i) => g.fill[i] !== c[3]).map((c) => c[0]);
      ok(`G2 every phone-core fill case holds in the compiled portal (${FILL_CASES.length})`, badFill.length === 0, badFill.join(" | "));
      const badIns = INSERT_CASES.filter((c, i) => g.insert[i] !== c[2]).map((c) => JSON.stringify(c));
      ok(`G3 every phone-core insert case holds in the compiled portal (${INSERT_CASES.length})`, badIns.length === 0, badIns.join(" | "));
    }
    const pc = await phoneCore();
    if (!pc) {
      console.log("SKIP  G4-G5 phone-core is not checked out beside this repo (set SS_PHONE_CORE_DIR to its packages/phone-core to run them)");
    } else {
      const pairs = [];
      for (const body of fuzzBodies()) for (const fill of FUZZ_FILLS) pairs.push([body, fill]);
      const starter = starterBodies();
      const starterPairs = [];
      const starterFills = [{ contactName: "Alex Smith", myName: "Jordan Lee" }, { contactName: null, myName: "Jordan Lee" }, { contactName: "", myName: null },
        { contactName: "(555) 555-0147", myName: "Jordan Lee" }, { contactName: "+15555550147", myName: "Jordan Lee" }];
      for (const body of starter || []) for (const fill of starterFills) starterPairs.push([body, fill]);
      const got = await s.page.evaluate((all) => all.map(([b, f]) => (window.__ssQuickSends ? window.__ssQuickSends.fill(b, f) : null)), [...pairs, ...starterPairs]);
      const want = [...pairs, ...starterPairs].map(([b, f]) => pc.fillQuickSend(b, f));
      const diffAt = got.findIndex((v, i) => v !== want[i]);
      ok(`G4 the compiled portal fills exactly as phone-core does on a seeded corpus (${pairs.length} pairs)`,
        diffAt === -1 || diffAt >= pairs.length, diffAt === -1 || diffAt >= pairs.length ? "" : JSON.stringify({ input: pairs[diffAt], portal: got[diffAt], phoneCore: want[diffAt] }));
      if (!starter) console.log("SKIP  G5 the phone repo's starter set (docs/sql/quick_send_defaults.sql) is not here");
      else ok(`G5 and on the phone repo's starter set (${starter.length} messages × ${starterFills.length} fills; wording not shown)`,
        starter.length > 0 && got.slice(pairs.length).every((v, i) => v === want[pairs.length + i]));
    }
    await s.ctx.close();
  }

  // ── I. An empty list says where to add them ──────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "empty", list: [] });
    await openRecordTab(s, "Email");
    await tap(s.page.locator('[data-ss-quick-sends="email"]'));
    await s.page.waitForTimeout(400);
    const text = await picker(s.page, "email").innerText().catch(() => "");
    ok("I3 an empty list says where to add them", /No quick sends yet\. Add them in My Synergy Phone, under Settings → Quick sends\./.test(text), text);
    ok("I4 with no rows", (await rowNames(s.page, "email")).length === 0);
    await s.page.screenshot({ path: join(shots, "I-empty.png") });
    await s.ctx.close();
  }

  // ── I. A server that doesn't know the action yet: the button goes, with no banner ────────────
  {
    const s = await scenario(browser, { name: "old-server", list: "old" });
    await openRecordTab(s, "Email");
    const had = (await s.page.locator('[data-ss-quick-sends="email"]').count()) === 1;
    await tap(s.page.locator('[data-ss-quick-sends="email"]'));
    await s.page.waitForTimeout(600);
    const body = await s.page.locator("body").innerText();
    ok("I5 a failed read hides the button", had && (await s.page.locator('[data-ss-quick-sends="email"]').count()) === 0 && actions(s, "quick_sends_list").length === 1);
    ok("I6 with no banner", !/Unrecognised action|quick send/i.test(body), body.match(/.{0,40}(Unrecognised|quick send).{0,40}/i)?.[0]);
    ok("I7 and the box still works", (await s.page.locator('textarea[placeholder="Write to this customer…"]').count()) === 1);
    await s.ctx.close();
  }

  // ── F6. Reply copies switched on in My Profile: the line says the inbox too ──────────────────
  {
    const s = await scenario(browser, { name: "copies-on", prefs: { replyCopy: true } });
    await openRecordTab(s, "Email");
    const t = await s.page.locator("body").innerText();
    ok("F6 with reply copies on, the line says replies come back here and to the writer's inbox (just the inbox until replies are set up), with no files caveat",
      /To alex@example\.test — replies come back here and to your inbox \(just your inbox until your company sets up replies\)\./.test(t)
        && !/aren't kept on the record/.test(t), t.match(/To alex@example\.test.{0,200}/)?.[0]);
    await s.ctx.close();
  }

  // ── F. View-as: no button, and the list is never asked for ────────────────────────────────────
  {
    const s = await scenario(browser, { name: "view-as", operator: true });
    await openRecordTab(s, "Email");
    const rendered = ok("F0 the viewed builder's Email box rendered", (await s.page.locator('input[placeholder="Subject"]').count()) === 1);
    if (rendered) {
      ok("F1 in view-as there is no Quick sends button", (await s.page.locator("[data-ss-quick-sends]").count()) === 0);
      const rec = s.calls.find((c) => c.action === "crm_record");
      ok("F2 (it is the VIEWED builder's record)", !!rec && rec.targetClientId === VIEWED, JSON.stringify(rec));
      const t = await s.page.locator("body").innerText();
      ok("F4 the line above the box says replies won't come to the operator, and where they go",
        /To alex@example\.test — you're viewing as Demo Builder, so replies won't come to you\. They come back to this record, and to this customer's assigned rep if they've switched reply copies on \(until this company sets up replies, to the rep only\)\./.test(t)
          && !/replies come back (to you|here and to your inbox)/.test(t), t.match(/To alex@example\.test.{0,260}/)?.[0]);
    }
    ok("F3 and the list is never asked for", actions(s, "quick_sends_list").length === 0);
    await s.page.screenshot({ path: join(shots, "F-view-as.png") });
    await s.ctx.close();
  }

  // ── I. At a phone's width the picker fits on screen ───────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "narrow", viewport: { width: 390, height: 844 } });
    await openRecordTab(s, "Email");
    // The record page's own width at 390px, before the picker opens: what opening it must not add to.
    const before = await s.page.evaluate(() => document.documentElement.scrollWidth);
    await tap(s.page.locator('[data-ss-quick-sends="email"]'));
    await s.page.waitForTimeout(400);
    const fit = await s.page.evaluate(() => {
      const p = document.querySelector('[data-ss-quick-send-picker="email"]');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return { left: r.left, right: r.right, vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth };
    });
    ok("I8 at 390px the picker opens inside the screen, and opening it adds no sideways scroll",
      !!fit && fit.left >= 0 && fit.right <= fit.vw && fit.sw <= Math.max(before, fit.vw), JSON.stringify({ ...fit, before }));
    await s.page.screenshot({ path: join(shots, "I-narrow.png") });
    await s.ctx.close();
  }

  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\ncrmQuickSends: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
