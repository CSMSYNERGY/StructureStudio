// "Call recording & AI transcripts" in My Profile (2026-10-14), driven for real on the COMPILED
// portal. Ahsan: "so people (Carolyn especially) can say yes or no on the web today, without
// waiting for the app updates." The same answer as the phone app and the extension, one per account.
//
//   A. never answered: the card says what happens to the business's calls (recorded by Twilio,
//      transcribed by Workers AI and summarized by Claude only with everyone's yes, voicemails by
//      Twilio), shows the WHOLE notice before the question, offers Allow and Don't allow (never
//      Stop), links the privacy policy, says the answer counts in the app and the extension, and
//      (an owner) points to Settings › Phone for the business-wide switch
//   B. Allow saves { answer: "allowed", version: 1 } and nothing else; "Saved." and the yes state
//      (with the date) only once the server's answer says allowed; the notice folds away and the
//      button is "Stop sending my calls"
//   C. Stop sending my calls saves "declined"; "Saved."; the no state; "Review and allow" opens the
//      notice again before Allow is offered
//   D. a failed save shows the server's sentence (a 500), our own sentence (a dropped connection),
//      or says nothing was kept (an ok that doesn't hold the answer); never "Saved.", and the card
//      keeps showing the answer that really is saved
//   E. operator view-as: the read carries targetClientId, the card says each person answers for
//      themselves, there are no buttons (also with the notice opened), and nothing is saved
//   F. the owner's "Settings › Phone" opens the Phone tab; a sales rep gets no owner line and still
//      answers for their own calls
//   G. at a phone's width the card adds no sideways scroll
//   H. a production host with the business's calling off shows no card; calling on shows it
//   I. a server before migration 307 says so, with no buttons
//   J. someone who said no before opens on the no state, the notice folded
//
// The stub answers ai_transcripts_save with the REAL rule (it imports _shared/aiConsent.ts; Node
// strips the types itself) and keeps the answer, so the card reads back what a server would hold.
// Supabase is stubbed at the network layer; nothing leaves the machine. Fixtures are made up
// (example.test, a made-up tenant), per the public-repo rule.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root; SS_BASE overrides the address)
//   node tests/harness/myProfileAiConsent.mjs      (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/my-profile-ai-consent (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an
// older portal.app.compiled.js> serves that file instead: before this change there is no card, so
// A0 fails and the run stops there.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, shotsDir, serveAppRoutes } from "./lib.mjs";
import { AI_NOTICE_VERSION, parseAiAnswer } from "../../supabase/functions/_shared/aiConsent.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

const CLIENT = "acme-sheds";
const VIEWED = "demo-builder";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000a7", aud: "authenticated", role: "authenticated", email: "sam@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const AREAS = ["designer", "designs", "contacts", "inventory", "orders", "change_orders", "change_order_approve", "build_schedule",
  "delivery_schedule", "repairs", "commissions", "reports", "projects", "phone", "settings_structures", "settings_options",
  "settings_branding", "settings_crm", "settings_quickbooks", "settings_email", "settings_team", "settings_billing"];
const OWNER_ACCESS = Object.fromEntries(AREAS.map((k) => [k, "edit"]));
// A sales rep with their own calls: no Settings area at all, phone 'own'.
const REP_ACCESS = Object.fromEntries(AREAS.map((k) => [k, ["designer", "designs", "contacts", "orders"].includes(k) ? "edit" : k === "phone" ? "own" : k === "inventory" ? "view" : "none"]));
const DB_FAIL = "Couldn't save your answer on AI transcripts. Please try again — if it keeps happening, tell CSM Synergy and mention \"save your answer on AI transcripts\".";

const { ok, failed } = reporter();
const shots = shotsDir("my-profile-ai-consent");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const LOCAL = /^https?:\/\/(127\.0\.0\.1|(?:[a-z0-9-]+\.)*localhost)(:\d+)?\//;

/**
 * One fresh browser context. → { page, calls, state, ctx }; `calls` is every portal-settings body
 * the page posted. `save`: "ok" (the real rule, kept), "fail" (500 with dbFail's sentence),
 * "drop" (ok, holding no answer), "abort" (the connection dies). `ready` false: a database before 307.
 */
async function scenario(browser, {
  name, role = "owner", access = OWNER_ACCESS, operator = false, answer = null, at = null, save = "ok", ready = true,
  phoneStatus = "on", base = BASE, viewport = { width: 1400, height: 1000 },
}) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const calls = [];
  const state = { answer, at };
  await page.route((u) => !LOCAL.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, operator);
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role, user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: body.targetClientId || CLIENT });
    }
    if (url.includes("/operator-portal")) return json(route, { ok: true, clientId: VIEWED, companyName: "Demo Builder", designs: [], versions: [], capturedLeads: [] });
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    const viewAs = !!body.targetClientId;
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: body.targetClientId || CLIENT, role: viewAs ? "operator" : role, operatorMode: viewAs, access: viewAs ? OWNER_ACCESS : access,
          prefs: null, phoneStatus, configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "get_profile":
        return json(route, { fullName: "Sam Rep", phone: "", role, email: USER.email, needsDetails: false, emailSignature: "" });
      case "ai_transcripts_get":
        if (!ready) return json(route, { ok: true, available: false, error: "Choosing AI transcripts isn't set up on this server yet." });
        return json(route, {
          ok: true, available: true, viewAs, noticeVersion: AI_NOTICE_VERSION,
          answer: viewAs ? null : state.answer, version: viewAs || !state.answer ? null : AI_NOTICE_VERSION, at: viewAs ? null : state.at,
          callRecording: true, businessTranscribes: true,
          canChangeRecording: !viewAs && role === "owner", phoneAccess: true,
        });
      case "ai_transcripts_save": {
        if (viewAs) return json(route, { error: "Your answer on AI transcripts belongs to the person signed in, so it can't be changed while you're viewing another account." }, 403);
        if (save === "abort") return route.abort();
        if (save === "fail") return json(route, { error: DB_FAIL, ref: "save your answer on AI transcripts" }, 500);
        const parsed = parseAiAnswer(body);
        if (!parsed.ok) return json(route, { error: parsed.error }, 400);
        if (save === "drop") return json(route, { ok: true, answer: null, version: null, at: null });
        state.answer = parsed.choice;
        state.at = "2026-10-14T15:30:00.000Z";
        return json(route, { ok: true, answer: state.answer, version: parsed.version, at: state.at });
      }
      case "phone_settings_get":
        return json(route, { ok: true, available: false });
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));
  const q = operator ? `?view=${VIEWED}` : "";
  await page.goto(`${base}/settings/myprofile${q}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes("How the Contacts tab opens"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => { const c = document.querySelector("[data-ss-ai-card]"); return !c || c.getAttribute("data-ss-ai-card") !== "loading"; }, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { ctx, page, calls, state };
}

const card = (page) => page.locator("[data-ss-ai-card]");
const text = (page) => card(page).innerText({ timeout: 3000 }).catch(() => "");
const choices = (page) => page.locator("[data-ss-ai-choice]");
const choiceLabels = async (page) => (await choices(page).allInnerTexts()).map((t) => t.trim());
const press = (loc) => loc.click({ timeout: 3000 }).then(() => true, () => false);
const saves = (s) => s.calls.filter((c) => c.action === "ai_transcripts_save");
const gets = (s) => s.calls.filter((c) => c.action === "ai_transcripts_get");
// The card, whole and clear of the fixed top bar: the window is made tall enough to hold it at the
// top of the page (scrolled to 0), shot, and put back, so nothing on screen moves under the bar.
const snap = async (page, file) => {
  const vp = page.viewportSize();
  await page.evaluate(() => window.scrollTo(0, 0));
  const bottom = await page.evaluate(() => { const c = document.querySelector("[data-ss-ai-card]"); return c ? Math.ceil(c.getBoundingClientRect().bottom + window.scrollY) : 0; });
  if (bottom + 24 > vp.height) { await page.setViewportSize({ width: vp.width, height: bottom + 24 }); await page.waitForTimeout(250); }
  await card(page).screenshot({ path: join(shots, file) }).catch(() => {});
  if (bottom + 24 > vp.height) await page.setViewportSize(vp);
};
/** The whole My Profile page as a person sees it: a window tall enough for all of it (a fullPage shot
 *  of this layout draws the fixed rail and top bar once, part way down). */
const pageShot = async (page, file) => {
  const vp = page.viewportSize();
  await page.evaluate(() => window.scrollTo(0, 0));
  const h = await page.evaluate(() => Math.ceil(document.scrollingElement.scrollHeight));
  await page.setViewportSize({ width: vp.width, height: Math.min(h, 4000) });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, file) });
  await page.setViewportSize(vp);
};
const SAVED = /(^|\n)Saved\.(\n|$)/;
const HEADINGS = ["What's sent, and to whom", "Why", "Who sees them", "How long they're kept", "Your choice"];

const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();
try {
  // ── A, B, C: one owner, never answered ─────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "owner" });
    const rendered = ok("A0 the card renders on My Profile", (await card(s.page).count()) === 1);
    if (!rendered) throw new Error("My Profile never rendered the AI transcripts card; refusing to report the rest as passes");
    const t = await text(s.page);
    ok("A1 titled Call recording & AI transcripts", t.startsWith("Call recording & AI transcripts"), t.slice(0, 60));
    ok("A2 calls are recorded by Twilio unless the owner turns it off", t.includes("recorded by Twilio, our calling provider, unless the business owner turns recording off"));
    ok("A3 transcribed by Workers AI and summarized by Claude, only with everyone's yes",
      t.includes("Recorded calls are transcribed by Cloudflare Workers AI and summarized by Anthropic's Claude, but only when everyone from your team on the call allowed it."));
    ok("A4 voicemails are turned into text by Twilio", t.includes("Voicemails are turned into text by Twilio."));
    ok("A5 the answer line: not chosen yet", t.includes("You haven't chosen yet. Until you allow it, calls you're on aren't sent"));
    const notice = s.page.locator("[data-ss-ai-notice]");
    const nt = await notice.innerText({ timeout: 2000 }).catch(() => "");
    ok("A6 the whole notice shows before the first answer (all five parts)", HEADINGS.every((h) => nt.toLowerCase().includes(h.toLowerCase())), nt.slice(0, 120));
    ok("A7 …naming Twilio, Workers AI, Anthropic's Claude and no model training",
      ["Twilio", "Cloudflare Workers AI", "Anthropic, whose Claude AI writes a short summary", "don't train AI models"].every((w) => nt.includes(w)));
    ok("A8 the buttons are Allow and Don't allow (no Stop yet)", JSON.stringify(await choiceLabels(s.page)) === JSON.stringify(["Allow", "Don't allow"]), JSON.stringify(await choiceLabels(s.page)));
    const href = await s.page.locator("[data-ss-ai-privacy]").getAttribute("href").catch(() => null);
    const tgt = await s.page.locator("[data-ss-ai-privacy]").getAttribute("target").catch(() => null);
    ok("A9 the privacy policy link", href === "https://csmsynergy.com/my-synergy-phone/privacy" && tgt === "_blank", `${href} ${tgt}`);
    ok("A10 the same answer counts in the phone app and the Chrome extension",
      t.includes("The same answer counts in the My Synergy Phone app and the Chrome extension"));
    ok("A11 an owner is pointed to Settings › Phone for the business-wide switch",
      /You.re the business owner, so you can also turn call transcripts off for everyone, under\s*Settings › Phone\./.test(t));
    const g = gets(s)[0];
    ok("A12 the read names nobody (no user id, no tenant)", !!g && Object.keys(g).join(",") === "action", JSON.stringify(g));
    ok("A13 it sits right after \"How the Contacts tab opens\"", await s.page.evaluate(() => {
      const c = document.querySelector("[data-ss-ai-card]");
      const prev = c && c.previousElementSibling;
      return !!prev && /How the Contacts tab opens/.test(prev.innerText);
    }));
    await snap(s.page, "A-no-answer.png");
    await pageShot(s.page, "A-my-profile-page.png");

    // B: Allow
    await press(s.page.locator('[data-ss-ai-choice="allowed"]'));
    await s.page.waitForFunction(() => /Saved\./.test((document.querySelector("[data-ss-ai-msg]") || {}).innerText || ""), null, { timeout: 5000 }).catch(() => {});
    const b = saves(s);
    ok("B1 Allow saves { answer: allowed, version } and nothing else", b.length === 1
      && JSON.stringify(b[0]) === JSON.stringify({ action: "ai_transcripts_save", answer: "allowed", version: AI_NOTICE_VERSION }), JSON.stringify(b));
    const tb = await text(s.page);
    ok("B2 \"Saved.\"", SAVED.test(tb));
    ok("B3 the yes state, with the date it was given", /You allowed it\. Calls you.re on are sent for transcripts and summaries, and the phone app and the Chrome extension show them\. \(since Oct 14, 2026\)/.test(tb), tb.slice(0, 600));
    ok("B4 the notice folds away and the button is \"Stop sending my calls\"",
      (await s.page.locator("[data-ss-ai-notice]").count()) === 0 && JSON.stringify(await choiceLabels(s.page)) === JSON.stringify(["Stop sending my calls"]), JSON.stringify(await choiceLabels(s.page)));
    await snap(s.page, "B-allowed-saved.png");

    // C: Stop sending my calls
    await press(s.page.locator('[data-ss-ai-choice="declined"]'));
    await s.page.waitForFunction(() => /You said no/.test((document.querySelector("[data-ss-ai-answer]") || {}).innerText || ""), null, { timeout: 5000 }).catch(() => {});
    const c = saves(s);
    ok("C1 Stop sending my calls saves { answer: declined }", c.length === 2 && c[1].answer === "declined" && c[1].version === AI_NOTICE_VERSION, JSON.stringify(c[1]));
    const tc = await text(s.page);
    ok("C2 \"Saved.\" and the no state", SAVED.test(tc) && tc.includes("You said no. Calls you're on aren't sent, and transcripts and summaries are hidden in the phone app and the Chrome extension."));
    ok("C3 no choice buttons; \"Review and allow\" instead", (await choices(s.page).count()) === 0 && (await s.page.locator("[data-ss-ai-review]").innerText().catch(() => "")) === "Review and allow");
    await snap(s.page, "C-declined-saved.png");
    await press(s.page.locator("[data-ss-ai-review]"));
    await s.page.waitForTimeout(200);
    ok("C4 \"Review and allow\" opens the notice before offering Allow",
      (await s.page.locator("[data-ss-ai-notice]").count()) === 1 && JSON.stringify(await choiceLabels(s.page)) === JSON.stringify(["Allow", "Don't allow"]));
    await snap(s.page, "C-review-and-allow.png");
    await s.ctx.close();
  }

  // ── D: failed saves ────────────────────────────────────────────────────────────────────────
  for (const [mode, want, label] of [
    ["fail", DB_FAIL, "D1 a 500 shows the server's own sentence"],
    ["abort", "Your answer couldn't be saved. Check your connection and try again.", "D2 a dropped connection shows our sentence"],
    ["drop", "The server didn't keep your answer, so nothing has changed. Try again, or tell CSM Synergy.", "D3 an ok that holds no answer is not \"Saved.\""],
  ]) {
    const s = await scenario(browser, { name: `fail-${mode}`, save: mode });
    await press(s.page.locator('[data-ss-ai-choice="allowed"]'));
    await s.page.waitForFunction(() => !!document.querySelector('[data-ss-ai-msg="err"]'), null, { timeout: 8000 }).catch(() => {});
    const t = await text(s.page);
    const msg = await s.page.locator("[data-ss-ai-msg]").innerText().catch(() => "");
    ok(label, msg === want && (await s.page.locator('[data-ss-ai-msg="err"]').count()) === 1, msg);
    ok(`${label.slice(0, 2)}b …never "Saved.", and the card still shows the answer really saved (none)`,
      !SAVED.test(t) && t.includes("You haven't chosen yet") && JSON.stringify(await choiceLabels(s.page)) === JSON.stringify(["Allow", "Don't allow"]));
    if (mode === "fail") await snap(s.page, "D-save-failed.png");
    await s.ctx.close();
  }

  // ── E: operator view-as ────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "view-as", operator: true });
    const t = await text(s.page);
    ok("E0 the card renders in view-as", (await card(s.page).count()) === 1, t.slice(0, 80));
    ok("E1 the read is the viewed builder's (targetClientId), for the business's facts", gets(s).length >= 1 && gets(s).every((g) => g.targetClientId === VIEWED), JSON.stringify(gets(s)));
    ok("E2 it says each person answers for themselves", t.includes("Each person answers this for themselves in My Profile, signed in as themselves"));
    ok("E3 no buttons, no answer line", (await choices(s.page).count()) === 0 && (await s.page.locator("[data-ss-ai-review], [data-ss-ai-answer]").count()) === 0);
    await snap(s.page, "E-view-as.png");
    await press(s.page.locator("[data-ss-ai-toggle]"));
    await s.page.waitForTimeout(200);
    ok("E4 the notice can be read, still without buttons", (await s.page.locator("[data-ss-ai-notice]").count()) === 1 && (await choices(s.page).count()) === 0);
    ok("E5 nothing was saved", saves(s).length === 0);
    await s.ctx.close();
  }

  // ── F: the owner's pointer; a sales rep ────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "owner-phone-link" });
    await press(s.page.locator("[data-ss-ai-owner] button"));
    await s.page.waitForTimeout(800);
    ok("F1 the owner's \"Settings › Phone\" opens the Phone tab", (await s.page.evaluate(() => location.pathname)) === "/settings/phone", await s.page.evaluate(() => location.pathname));
    await s.ctx.close();
    const r = await scenario(browser, { name: "rep", role: "user", access: REP_ACCESS });
    ok("F2 a sales rep gets the card with no owner line", (await card(r.page).count()) === 1 && (await r.page.locator("[data-ss-ai-owner]").count()) === 0);
    await press(r.page.locator('[data-ss-ai-choice="declined"]'));
    await r.page.waitForFunction(() => /You said no/.test((document.querySelector("[data-ss-ai-answer]") || {}).innerText || ""), null, { timeout: 5000 }).catch(() => {});
    ok("F3 …and answers for their own calls (Don't allow saved)", saves(r).length === 1 && saves(r)[0].answer === "declined" && SAVED.test(await text(r.page)));
    await r.ctx.close();
  }

  // ── G: a phone's width ─────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "phone-width", viewport: { width: 390, height: 844 } });
    const m = await s.page.evaluate(() => {
      const se = document.scrollingElement;
      const c = document.querySelector("[data-ss-ai-card]");
      const r = c ? c.getBoundingClientRect() : null;
      return { sw: se.scrollWidth, cw: se.clientWidth, right: r ? Math.round(r.right) : null };
    });
    ok("G1 no sideways scroll at 390px, and the card fits", (await card(s.page).count()) === 1 && m.sw <= m.cw && m.right !== null && m.right <= m.cw, JSON.stringify(m));
    await snap(s.page, "G-phone-width.png");
    await s.ctx.close();
  }

  // ── H: only where the Phone tab is offered ────────────────────────────────────────────────
  {
    const prod = BASE.replace("127.0.0.1", "app.localhost");
    const off = await scenario(browser, { name: "prod-off", base: prod, phoneStatus: "off" });
    const offBooted = (await off.page.evaluate(() => document.body.innerText)).includes("How the Contacts tab opens");
    ok("H1 a production host with calling off: My Profile, and no card", offBooted && (await card(off.page).count()) === 0 && gets(off).length === 0,
      `profile=${offBooted} card=${await card(off.page).count()}`);
    await off.ctx.close();
    const on = await scenario(browser, { name: "prod-on", base: prod, phoneStatus: "on" });
    ok("H2 the same host with calling on: the card", (await card(on.page).count()) === 1);
    await on.ctx.close();
  }

  // ── I: a database before 307 ──────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "not-ready", ready: false });
    const t = await text(s.page);
    ok("I1 says it isn't set up yet, with no buttons", t.includes("Choosing AI transcripts isn't set up on this server yet.") && (await choices(s.page).count()) === 0, t);
    await s.ctx.close();
  }

  // ── J: someone who said no before ──────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "returning-no", answer: "declined", at: "2026-10-13T09:00:00.000Z" });
    const t = await text(s.page);
    ok("J1 opens on the no state with its date, the notice folded", t.includes("You said no.") && /\(since Oct 1[23], 2026\)/.test(t)
      && (await s.page.locator("[data-ss-ai-notice]").count()) === 0 && (await s.page.locator("[data-ss-ai-review]").count()) === 1, t.slice(0, 400));
    await s.ctx.close();
  }

  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}
console.log(`\nshots: ${shots}`);
const f = failed();
console.log(`${f.length ? "FAILED" : "OK"} — ${f.length} failed`);
process.exit(f.length ? 1 : 0);
