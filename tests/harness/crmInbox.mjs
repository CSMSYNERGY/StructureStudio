// The Conversations page (every customer's latest email, text or call), driven for real on the
// COMPILED portal (2026-10-05). Carolyn, 2026-08-21 @45:22: "I like the idea of a conversations
// tab ... I want that bar at the top that shows that I can sort and see just that." And @42:45:
// "I want to be able to see my calls."
//
//   A. with the CRM, the rail has Conversations directly under Contacts; the page shows a skeleton
//      while it loads, then one row per customer (an email in, a text out, a missed call) with the
//      channel, the direction, the preview, the time, and "Waiting on you" on the two that are;
//      the request is crm_inbox with channel "all" and Mine off
//   B. the filter bar narrows the rows, sends `channel`, and puts the filter in the address bar
//   C. Load more sends the cursor, adds the next page, and never lists a customer twice
//   D. Mine sends mine:true and is remembered across a reload (this tab's session)
//   E. a row opens /portal/contacts/c-<id> on the matching History chip (email → Emails, text →
//      Messages, call → Calls); the record's Back returns to Conversations on the same filter and
//      paints at once, with Load more waiting until the refresh lands; the browser's Back does
//      too; after a hop away and the browser's Back onto the record, the chip and the record's
//      Back are still Conversations'; the name is a real link (right-click / new tab) and Enter
//      on it opens the record
//   F. a server error is shown, with no rows and no endless skeleton
//   G. without the CRM: no Conversations in the rail, and a typed /portal/conversations shows the
//      CRM card and never asks the server
//   H. the filter offers: no Texts while the account can't text and has no texts; no Calls for
//      someone who can't see calls; on a production address with calling off, Calls only once
//      there are calls
//   I. view-as: the request carries the viewed builder, and a row opens that builder's record
//   J. at 390px the list is one column per row and fits: no sideways scroll, no clipped words;
//      screenshots at 1440 and 390
//   Z. no page errors, and nothing here sends an email or a text
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the stub shape
// is crmCardOrder.mjs's. crm_inbox is answered from a fixed list, filtered by `channel` and `mine`
// the way the server would.
//
//   python -m http.server 8147 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8147 node tests/harness/crmInbox.mjs   (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/crm-inbox (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an older
// portal.app.compiled.js> serves that file instead, which is how to prove the checks can fail:
// against the artifact before this change the run stops at A1 (no Conversations in the rail).
//
// Fixtures are obviously fake (example.test, 555 numbers, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { chromium } from "@playwright/test";
import { reporter, BASE, REF, shotsDir } from "./lib.mjs";

// H's production-address scenario needs a hostname that is not loopback (ssIsBetaHost is true on
// 127.0.0.1, which offers calling everywhere). Mapped to the same local server, and treated as a
// secure origin like 127.0.0.1 is. lib.mjs's launch() splits its extra flags on spaces and a
// resolver rule has spaces in it, so the browser is launched here, with launch()'s own options.
const PROD_HOST = "builder.example.test";
const PROD_BASE = BASE.replace(/127\.0\.0\.1|localhost/, PROD_HOST);
async function launch() {
  const browser = await chromium.launch({
    channel: process.env.PW_CHANNEL === "bundled" ? undefined : "chrome",
    headless: process.env.HEADED ? false : true,
    args: [`--host-resolver-rules=MAP ${PROD_HOST} 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${PROD_BASE}`,
      ...(process.env.HARNESS_CHROME_ARGS ? process.env.HARNESS_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])],
  });
  return { browser };
}

const CLIENT = "acme-sheds";
const VIEWED = "demo-builder";
const id = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const C_EMAIL = id(11), C_TEXT = id(12), C_CALL = id(13), C_OLD = id(14);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000004", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER_ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders",
  "change_order_approve", "build_schedule", "delivery_schedule", "repairs", "commissions", "reports", "phone",
  "settings_structures", "settings_options", "settings_branding", "settings_crm", "settings_quickbooks",
  "settings_email", "settings_team", "settings_billing"].map((k) => [k, "edit"]));

// The server's timestamp shape (crmInbox canonAt): microseconds, Z.
const ago = (ms) => new Date(Date.now() - ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
const THREADS = [
  { contactId: C_EMAIL, name: "Alex Tester", channel: "email", direction: "in", preview: "Can the door go on the gable end?", at: ago(60 * 60 * 1000), awaitingReply: true },
  { contactId: C_TEXT, name: "Blair Example", channel: "sms", direction: "out", preview: "Your shed is on the truck this morning", at: ago(26 * 3600 * 1000), awaitingReply: false },
  { contactId: C_CALL, name: "Casey Sample", channel: "calls", direction: "in", preview: "Missed call", at: ago(3 * 86400 * 1000), awaitingReply: true },
];
// Page 2: one more customer, and Alex again (a page edge the browser must not show twice).
const PAGE2 = [
  { ...THREADS[0], at: ago(40 * 86400 * 1000), preview: "an older email" },
  { contactId: C_OLD, name: "Drew Older", channel: "email", direction: "out", preview: "Following up on your quote", at: ago(41 * 86400 * 1000), awaitingReply: false },
];
const CURSOR = "2026-09-01T00:00:00.000001Z";
const MINE = new Set([C_EMAIL, C_CALL]);
const PEOPLE = {
  [C_EMAIL]: { name: "Alex Tester", phone: "(555) 555-0111", email: "alex@example.test" },
  [C_TEXT]: { name: "Blair Example", phone: "(555) 555-0112", email: "blair@example.test" },
  [C_CALL]: { name: "Casey Sample", phone: "(555) 555-0113", email: "casey@example.test" },
  [C_OLD]: { name: "Drew Older", phone: "(555) 555-0114", email: "drew@example.test" },
};
// The record's history, with one of each kind the chips filter on.
const FEED = [
  { id: "in:1", type: "email_in", at: THREADS[0].at, title: "Can the door go on the gable end?", body: "Thanks!", actor: "alex@example.test", icon: "email_in", meta: { from: "alex@example.test", inbound: true, senderVerified: true } },
  { id: "sm:1", type: "sms", at: THREADS[1].at, title: "Text to +15555550112", body: "Your shed is on the truck this morning", icon: "sms", meta: { direction: "out", status: "delivered" } },
  { id: "pc:1", type: "call_missed", at: THREADS[2].at, title: "Missed call from +15555550113", body: "Nobody answered", icon: "call_missed" },
  { id: "n:1", type: "note", at: ago(5 * 86400 * 1000), title: "Note", body: "Wants a 10x12", icon: "note" },
];

const { ok, failed } = reporter();
const shots = shotsDir("crm-inbox");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SENDS = ["crm_send_email", "crm_send_sms", "email_send_test", "resend_quote_email", "send_invoice", "send_change_order"];
const LOCAL = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|${PROD_HOST.replace(/\./g, "\\.")})(:\\d+)?/`);

/** crm_inbox as the server answers it, from THREADS. */
function inbox(body, o) {
  const ch = body.channel || "all";
  const pick = (list) => list.filter((t) => (ch === "all" || t.channel === ch) && (!body.mine || MINE.has(t.contactId)));
  const meta = body.cursor ? {} : { smsReady: o.smsReady, hasTexts: o.hasTexts, hasCalls: o.hasCalls, seesCalls: o.seesCalls };
  if (body.cursor === CURSOR) return { ok: true, threads: pick(PAGE2), cursor: null };
  return { ok: true, threads: pick(THREADS), cursor: ch === "all" && !body.mine ? CURSOR : null, ...meta };
}

async function scenario(browser, { name, operator = false, crm = true, base = BASE, inboxDelay = 0, inboxFail = false,
  smsReady = true, hasTexts = true, hasCalls = true, seesCalls = true, phoneStatus = "off", viewport = { width: 1440, height: 1000 }, path = null }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const calls = [];
  await page.route((u) => !LOCAL.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, operator);
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm }, status: "active" }, wallet: null, clientId: body.targetClientId || CLIENT });
    }
    if (url.includes("/operator-portal")) return json(route, { ok: true, clientId: VIEWED, companyName: "Demo Builder", designs: [], versions: [], capturedLeads: [] });
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    const clientId = body.targetClientId || CLIENT;
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId, role: "owner", operatorMode: !!body.targetClientId, access: OWNER_ACCESS, prefs: null,
          phoneStatus, configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "crm_inbox": {
        if (inboxDelay) await new Promise((r) => setTimeout(r, inboxDelay));
        if (inboxFail) return json(route, { error: "Couldn't load your conversations. Please try again — if it keeps happening, tell CSM Synergy and mention \"load your conversations\".", ref: "load your conversations" }, 500);
        return json(route, inbox(body, { smsReady, hasTexts, hasCalls, seesCalls }));
      }
      case "crm_record": {
        const p = PEOPLE[body.id] || { name: "Someone", phone: "", email: "" };
        return json(route, {
          ok: true, kind: body.kind, clientId,
          contact: { id: body.id, ...p, phone_digits: "555555" + body.id.slice(-4), owner_user_id: null, sms_opt_out_at: null, first_seen_at: "2026-09-01T12:00:00Z" },
          designs: [], orders: [], feed: FEED, focus: [], team: [], people: [], followers: [],
          sms: { ready: true, from: "+15555550199", optedOut: false, consented: true },
          build: [], stages: [], delivery: [], repairs: [],
        });
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
  // Always portal.html: a static server has no /portal/* rewrite (the Worker's _redirects), so a
  // deep link is reached the way the app reaches one, through history.
  const boot = async () => {
    await page.goto(`${base}/portal.html${q}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
    await page.waitForTimeout(600);
  };
  const go = async (p) => {
    await page.evaluate((x) => { history.pushState({}, "", x + window.location.search); window.dispatchEvent(new PopStateEvent("popstate")); }, p);
    await page.waitForTimeout(500);
  };
  await boot();
  if (path) await go(path);
  return { ctx, page, calls, go, boot };
}

const tap = (loc) => loc.click({ timeout: 5000 }).then(() => true, () => false);
const inboxCalls = (s) => s.calls.filter((c) => c.action === "crm_inbox");
const lastInbox = (s) => { const v = inboxCalls(s); return v[v.length - 1] || null; };
const rowIds = (page) => page.evaluate(() => [...document.querySelectorAll("[data-ss-inbox-row]")].map((r) => r.getAttribute("data-ss-inbox-row")));
const rowsReady = (page) => page.waitForFunction(() => document.querySelectorAll("[data-ss-inbox-row]").length > 0
  || !!document.querySelector("[data-ss-inbox-empty]"), null, { timeout: 15000 }).catch(() => {});
const filters = (page) => page.evaluate(() => [...document.querySelectorAll("[data-ss-inbox-filter]")].map((b) => b.getAttribute("data-ss-inbox-filter")));
const pressed = (page, sel) => page.evaluate((s) => { const b = document.querySelector(s); return b ? b.getAttribute("aria-pressed") : null; }, sel);
const path = (page) => page.evaluate(() => window.location.pathname);
const navLabels = (page) => page.evaluate(() => [...document.querySelectorAll(".ss-ws-nav .ss-nav a .lbl")].map((l) => l.textContent));
const activeChip = (page) => page.evaluate(() => { const b = document.querySelector("[data-ss-crm-chip][aria-pressed='true']"); return b ? b.getAttribute("data-ss-crm-chip") : null; });
async function openRow(s, contactId) {
  await tap(s.page.locator(`[data-ss-inbox-row="${contactId}"] td`).nth(1));
  await s.page.waitForFunction(() => !!document.querySelector("[data-ss-crm-chip]"), null, { timeout: 20000 }).catch(() => {});
  await s.page.waitForTimeout(300);
}
async function recordBack(s) {
  await tap(s.page.locator("button", { hasText: /^Back$/ }).first());
  await s.page.waitForTimeout(150);
}

const { browser } = await launch();
try {
  // ── A–E. The owner on their own account, with the CRM ──────────────────────────────────────
  {
    const s = await scenario(browser, { name: "main", inboxDelay: 900 });
    const labels = await navLabels(s.page);
    const ci = labels.indexOf("Contacts");
    if (!ok("A1 the rail has Conversations directly under Contacts", ci >= 0 && labels[ci + 1] === "Conversations", JSON.stringify(labels))) {
      throw new Error("no Conversations in the rail — stopping (expected against an older artifact)");
    }
    await tap(s.page.locator(".ss-ws-nav .ss-nav a", { hasText: "Conversations" }));
    await s.page.waitForTimeout(250);
    const skel = await s.page.evaluate(() => {
      const card = document.querySelector("[data-ss-inbox]");
      return !!card && !card.querySelector("[data-ss-inbox-row]") && card.querySelectorAll("tbody tr").length >= 3;
    });
    ok("A2 a skeleton shows while it loads", skel);
    ok("A3 the address is /portal/conversations", (await path(s.page)) === "/portal/conversations", await path(s.page));
    await rowsReady(s.page);
    ok("A4 one row per customer, newest first", same(await rowIds(s.page), [C_EMAIL, C_TEXT, C_CALL]), JSON.stringify(await rowIds(s.page)));
    const cells = await s.page.evaluate(() => [...document.querySelectorAll("[data-ss-inbox-row]")].map((r) => ({
      text: r.innerText.replace(/\s+/g, " ").trim(), waiting: !!r.querySelector("[data-ss-inbox-waiting]"),
      href: (r.querySelector("a") || {}).getAttribute ? r.querySelector("a").getAttribute("href") : null,
    })));
    ok("A5 each row: the name, the channel, the direction and the preview",
      /Alex Tester/.test(cells[0].text) && /Email Received Can the door go on the gable end\?/.test(cells[0].text)
      && /Blair Example/.test(cells[1].text) && /Text Sent Your shed is on the truck/.test(cells[1].text)
      && /Casey Sample/.test(cells[2].text) && /Call Incoming Missed call/.test(cells[2].text), JSON.stringify(cells.map((c) => c.text)));
    ok("A6 the time: today's as a time, yesterday's as Yesterday, three days ago as a weekday",
      /\d:\d\d [AP]M$/.test(cells[0].text) && /Yesterday$/.test(cells[1].text) && /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(cells[2].text), JSON.stringify(cells.map((c) => c.text.slice(-12))));
    ok("A7 Waiting on you on the email from them and the missed call, not on the text we sent",
      same(cells.map((c) => c.waiting), [true, false, true]));
    const first = inboxCalls(s)[0] || {};
    ok("A8 the request: crm_inbox, channel all, Mine off, no cursor", first.channel === "all" && first.mine === false && !("cursor" in first), JSON.stringify(first));
    ok("A9 the name is a real link to the record", cells[0].href === `/portal/contacts/c-${C_EMAIL}`, cells[0].href);
    ok("A10 the filters on offer: All, Email, Texts, Calls", same(await filters(s.page), ["all", "email", "sms", "calls"]), JSON.stringify(await filters(s.page)));
    const wide = await s.page.evaluate(() => ({
      narrow: (document.querySelector("[data-ss-inbox]") || { getAttribute: () => null }).getAttribute("data-ss-inbox-narrow"),
      heads: [...document.querySelectorAll("[data-ss-inbox] thead th")].map((h) => h.textContent),
    }));
    ok("A11 at 1440 the list has its three columns", wide.narrow === "0" && same(wide.heads, ["Customer", "Latest", "When"]), JSON.stringify(wide));
    await s.page.screenshot({ path: join(shots, "A-inbox-1440.png") });

    // ── B. The filter bar ──
    for (const [ch, slug, want] of [["email", "email", [C_EMAIL]], ["sms", "texts", [C_TEXT]], ["calls", "calls", [C_CALL]]]) {
      await tap(s.page.locator(`[data-ss-inbox-filter="${ch}"]`));
      await rowsReady(s.page);
      await s.page.waitForFunction((w) => [...document.querySelectorAll("[data-ss-inbox-row]")].map((r) => r.getAttribute("data-ss-inbox-row")).join() === w.join(), want, { timeout: 8000 }).catch(() => {});
      ok(`B ${ch}: narrows the rows, sends channel "${ch}", and the address says /${slug}`,
        same(await rowIds(s.page), want) && (lastInbox(s) || {}).channel === ch && (await path(s.page)) === `/portal/conversations/${slug}`
        && (await pressed(s.page, `[data-ss-inbox-filter="${ch}"]`)) === "true",
        JSON.stringify({ rows: await rowIds(s.page), sent: (lastInbox(s) || {}).channel, at: await path(s.page) }));
    }
    await tap(s.page.locator('[data-ss-inbox-filter="all"]'));
    await rowsReady(s.page);
    await s.page.waitForTimeout(300);
    ok("B all: back to everyone, at /portal/conversations", same(await rowIds(s.page), [C_EMAIL, C_TEXT, C_CALL]) && (await path(s.page)) === "/portal/conversations", await path(s.page));

    // ── C. Load more ──
    const more = s.page.locator("[data-ss-inbox-more]");
    ok("C1 more to read: a Load more button", (await more.count()) === 1);
    await tap(more);
    await s.page.waitForFunction(() => document.querySelectorAll("[data-ss-inbox-row]").length >= 4, null, { timeout: 8000 }).catch(() => {});
    const paged = lastInbox(s) || {};
    ok("C2 Load more sends the cursor the first page gave", paged.cursor === CURSOR && paged.channel === "all", JSON.stringify(paged));
    ok("C3 the next customer is added, and Alex (on both pages) is listed once", same(await rowIds(s.page), [C_EMAIL, C_TEXT, C_CALL, C_OLD]), JSON.stringify(await rowIds(s.page)));
    ok("C4 nothing more: the button goes", (await more.count()) === 0);

    // ── E. Into a record and back ──
    await openRow(s, C_EMAIL);
    ok("E1 an email row opens the contact's record", (await path(s.page)) === `/portal/contacts/c-${C_EMAIL}`, await path(s.page));
    const rec = s.calls.filter((c) => c.action === "crm_record").pop() || {};
    ok("E2 (that customer's record)", rec.kind === "contact" && rec.id === C_EMAIL, JSON.stringify(rec));
    ok("E3 on the Emails chip", (await activeChip(s.page)) === "emails", await activeChip(s.page));
    const histOnEmails = await s.page.evaluate(() => document.body.innerText.includes("Wants a 10x12"));
    ok("E4 (and the history really is filtered: the note isn't listed)", !histOnEmails);
    await s.page.screenshot({ path: join(shots, "E-record-emails-1440.png") });
    const before = inboxCalls(s).length;
    await recordBack(s);
    const painted = await s.page.evaluate(() => document.querySelectorAll("[data-ss-inbox-row]").length);
    ok("E5 the record's Back returns to Conversations", (await path(s.page)) === "/portal/conversations", await path(s.page));
    ok("E6 and paints the list at once, from the last load", painted >= 3, `rows ${painted}`);
    // Load more against the cached rows would mix them into the fresh page (review 2026-10-05).
    const moreState = () => s.page.evaluate(() => { const b = document.querySelector("[data-ss-inbox-more]"); return b ? { off: b.disabled, text: b.textContent } : null; });
    const busyMore = await moreState();
    ok("E6b while it refreshes, Load more waits", !!busyMore && busyMore.off === true && busyMore.text === "Loading…", JSON.stringify(busyMore));
    await rowsReady(s.page);
    await s.page.waitForTimeout(1200);
    ok("E7 then refreshes it behind", inboxCalls(s).length > before);
    const freeMore = await moreState();
    ok("E7b and Load more is back once the list is fresh", !!freeMore && freeMore.off === false && freeMore.text === "Load more", JSON.stringify(freeMore));

    await tap(s.page.locator('[data-ss-inbox-filter="sms"]'));
    await rowsReady(s.page);
    await s.page.waitForTimeout(300);
    await openRow(s, C_TEXT);
    ok("E8 a text row opens the record on the Messages chip", (await activeChip(s.page)) === "messages" && (await path(s.page)) === `/portal/contacts/c-${C_TEXT}`, await activeChip(s.page));
    // A hop away by the rail, then the browser's Back onto the record (review 2026-10-05): the chip
    // and the record's Back used to be spent the moment the address moved, so it came back on All
    // with a Back to Contacts while the browser's Back still went to Conversations.
    await tap(s.page.locator(".ss-ws-nav .ss-nav a", { hasText: "Pipeline" }));
    await s.page.waitForTimeout(400);
    ok("E8b the rail leaves the record", (await path(s.page)) === "/portal/designs", await path(s.page));
    await s.page.goBack();
    await s.page.waitForFunction(() => !!document.querySelector("[data-ss-crm-chip]"), null, { timeout: 20000 }).catch(() => {});
    await s.page.waitForTimeout(300);
    ok("E8c the browser's Back reopens the record on Messages", (await path(s.page)) === `/portal/contacts/c-${C_TEXT}` && (await activeChip(s.page)) === "messages",
      `${await path(s.page)} ${await activeChip(s.page)}`);
    await recordBack(s);
    ok("E9 and the record's Back (after that hop) returns to the Texts filter", (await path(s.page)) === "/portal/conversations/texts", await path(s.page));
    await rowsReady(s.page);
    ok("E10 (the Texts filter is on)", (await pressed(s.page, '[data-ss-inbox-filter="sms"]')) === "true");

    await tap(s.page.locator('[data-ss-inbox-filter="calls"]'));
    await rowsReady(s.page);
    await s.page.waitForTimeout(300);
    await openRow(s, C_CALL);
    ok("E11 a call row opens the record on the Calls chip", (await activeChip(s.page)) === "calls", await activeChip(s.page));
    await s.page.goBack();
    await s.page.waitForTimeout(500);
    ok("E12 the browser's Back returns to the Calls filter too", (await path(s.page)) === "/portal/conversations/calls", await path(s.page));
    await rowsReady(s.page);

    // A record opened another way keeps its old Back (Contacts) and its All chip.
    await s.go(`/portal/contacts/c-${C_CALL}`);
    await s.page.waitForFunction(() => !!document.querySelector("[data-ss-crm-chip]"), null, { timeout: 20000 }).catch(() => {});
    ok("E13 a record opened from elsewhere opens on All", (await activeChip(s.page)) === "all", await activeChip(s.page));
    await recordBack(s);
    ok("E14 and its Back still goes to Contacts", (await path(s.page)) === "/portal/contacts", await path(s.page));

    // Keyboard: Enter on a name opens the record.
    await s.go("/portal/conversations/email");
    await rowsReady(s.page);
    await s.page.locator(`[data-ss-inbox-row="${C_EMAIL}"] a`).focus();
    await s.page.keyboard.press("Enter");
    await s.page.waitForFunction(() => !!document.querySelector("[data-ss-crm-chip]"), null, { timeout: 20000 }).catch(() => {});
    ok("E15 Enter on a customer's name opens their record, on Emails", (await path(s.page)) === `/portal/contacts/c-${C_EMAIL}` && (await activeChip(s.page)) === "emails",
      `${await path(s.page)} ${await activeChip(s.page)}`);

    // ── D. Mine ──
    await s.go("/portal/conversations");
    await rowsReady(s.page);
    await tap(s.page.locator('[data-ss-inbox-mine="1"]'));
    await s.page.waitForTimeout(400);
    await rowsReady(s.page);
    ok("D1 Mine sends mine:true and narrows the list", (lastInbox(s) || {}).mine === true && same(await rowIds(s.page), [C_EMAIL, C_CALL]), JSON.stringify(await rowIds(s.page)));
    await s.boot();                              // a fresh load, in the same tab
    await s.go("/portal/conversations");
    await rowsReady(s.page);
    ok("D2 and is remembered across a reload", (await pressed(s.page, '[data-ss-inbox-mine="1"]')) === "true" && (lastInbox(s) || {}).mine === true);
    await tap(s.page.locator('[data-ss-inbox-mine="0"]'));
    await s.page.waitForTimeout(400);
    ok("D3 Everyone puts it back", (lastInbox(s) || {}).mine === false);

    ok("Z1 nothing on these screens sent an email or a text", !s.calls.some((c) => SENDS.includes(c.action)), JSON.stringify(s.calls.map((c) => c.action)));
    await s.ctx.close();
  }

  // ── F. A server error ────────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "error", inboxFail: true, path: "/portal/conversations" });
    await s.page.waitForFunction(() => /load your conversations/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    const t = await s.page.evaluate(() => (document.querySelector("[data-ss-inbox]") || {}).innerText || "");
    ok("F1 the error is shown, with no rows and no skeleton left spinning",
      /Couldn't load your conversations/.test(t) && !(await s.page.locator("[data-ss-inbox-row]").count())
      && !(await s.page.evaluate(() => document.querySelectorAll("[data-ss-inbox] tbody tr").length)), t.slice(0, 160));
    await s.ctx.close();
  }

  // ── G. Without the CRM ───────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "no-crm", crm: false });
    const labels = await navLabels(s.page);
    ok("G1 no Conversations in the rail (Contacts stays, to sell the CRM)", !labels.includes("Conversations") && labels.includes("Contacts"), JSON.stringify(labels));
    await s.go("/portal/conversations");
    await s.page.waitForTimeout(500);
    const t = await s.page.evaluate(() => document.body.innerText);
    ok("G2 a typed /portal/conversations shows the CRM card", /Every email, text and call with your customers in one list/.test(t) && /Add the CRM/.test(t), t.slice(0, 120));
    ok("G3 and never asks the server", inboxCalls(s).length === 0, `${inboxCalls(s).length} calls`);
    await s.page.screenshot({ path: join(shots, "G-no-crm-1440.png") });
    await s.ctx.close();
  }

  // ── H. Which filters are offered ─────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "offers-local", smsReady: false, hasTexts: false, seesCalls: false, hasCalls: false, path: "/portal/conversations" });
    await rowsReady(s.page);
    ok("H1 can't text and no texts, can't see calls: All and Email only", same(await filters(s.page), ["all", "email"]), JSON.stringify(await filters(s.page)));
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "offers-texts", smsReady: false, hasTexts: true, seesCalls: true, hasCalls: false, path: "/portal/conversations" });
    await rowsReady(s.page);
    ok("H2 texting off but texts on file: Texts is offered (history never hides)", (await filters(s.page)).includes("sms"), JSON.stringify(await filters(s.page)));
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "offers-prod", base: PROD_BASE, phoneStatus: "off", seesCalls: true, hasCalls: false, path: "/portal/conversations" });
    await rowsReady(s.page);
    ok("H3 a production address with calling off and no calls: no Calls filter", !(await filters(s.page)).includes("calls"), JSON.stringify(await filters(s.page)));
    await s.ctx.close();
  }
  {
    const s = await scenario(browser, { name: "offers-prod-calls", base: PROD_BASE, phoneStatus: "off", seesCalls: true, hasCalls: true, path: "/portal/conversations" });
    await rowsReady(s.page);
    ok("H4 the same with calls on file: Calls is offered", (await filters(s.page)).includes("calls"), JSON.stringify(await filters(s.page)));
    await s.ctx.close();
  }

  // ── I. View-as ───────────────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "view-as", operator: true });
    await s.go("/portal/conversations");
    await rowsReady(s.page);
    const req = inboxCalls(s).pop() || {};
    ok("I1 the request carries the viewed builder", req.targetClientId === VIEWED, JSON.stringify(req));
    await openRow(s, C_TEXT);
    const rec = s.calls.filter((c) => c.action === "crm_record").pop() || {};
    ok("I2 a row opens that builder's record, on Messages", rec.targetClientId === VIEWED && rec.id === C_TEXT && (await activeChip(s.page)) === "messages", JSON.stringify(rec));
    ok("I3 and the address keeps ?view=", await s.page.evaluate((v) => window.location.search === `?view=${v}`, VIEWED));
    await s.ctx.close();
  }

  // ── J. A phone's width ───────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "narrow", viewport: { width: 390, height: 844 }, path: "/portal/conversations" });
    await rowsReady(s.page);
    await s.page.waitForTimeout(300);
    const fit = await s.page.evaluate(() => {
      const card = document.querySelector("[data-ss-inbox]");
      const r = card ? card.getBoundingClientRect() : null;
      const btns = [...document.querySelectorAll("[data-ss-inbox-filter], [data-ss-inbox-mine]")].map((b) => b.getBoundingClientRect().right);
      const table = card ? card.querySelector("table") : null;
      const wrap = table ? table.parentElement : null;
      // Every piece of text in a row, by its own right edge: a cell's box can fit while the words
      // in it run past it (the time, which never wraps), and the scroll box then clips them.
      const texts = [...document.querySelectorAll("[data-ss-inbox-row] td, [data-ss-inbox-row] td *")]
        .filter((el) => el.childElementCount === 0 && el.textContent.trim())
        .map((el) => { const g = document.createRange(); g.selectNodeContents(el); return g.getBoundingClientRect().right; });
      return { narrow: card ? card.getAttribute("data-ss-inbox-narrow") : null, right: r ? r.right : null, btns: Math.max(...btns),
        table: table ? table.getBoundingClientRect().right : null, wrapRight: wrap ? wrap.getBoundingClientRect().right : null,
        wrapScroll: wrap ? wrap.scrollWidth - wrap.clientWidth : null, text: Math.max(...texts),
        vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth };
    });
    ok("J1 at 390px the list switches to one column per row", fit.narrow === "1", JSON.stringify(fit));
    ok("J2 the card, the filters and the list fit, with no sideways scroll and no clipped words",
      fit.right !== null && fit.right <= fit.vw && fit.btns <= fit.vw && fit.table <= fit.vw && fit.sw <= fit.vw
      && fit.wrapScroll === 0 && fit.text <= fit.wrapRight + 0.5, JSON.stringify(fit));
    await s.page.screenshot({ path: join(shots, "J-inbox-390.png"), fullPage: true });
    await openRow(s, C_EMAIL);
    ok("J3 a row still opens the record on Emails", (await activeChip(s.page)) === "emails", await activeChip(s.page));
    await s.page.screenshot({ path: join(shots, "J-record-390.png"), fullPage: true });
    await s.ctx.close();
  }

  ok("Z2 no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
  ok("harness ran to the end", false, e.message);
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\ncrmInbox: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
