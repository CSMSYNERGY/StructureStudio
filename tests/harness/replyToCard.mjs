// The "Where replies to your emails go" card (Settings → My Profile), driven for real on the
// COMPILED portal (2026-10-05, quote and invoice replies copied to the rep). Carolyn, 2026-09-04
// @35:06: "every user should be able to go in and say, when somebody replies to an email, send it
// here. But that should be in their profile."
//
//   A. the card says which emails it covers: messages, quotes, invoices and change orders, and that
//      a confirmation the customer set off goes to the person they're assigned to (if any); it
//      promises nothing it can't keep on every account: the record only once replies are set up,
//      and nothing for email the CRM sends
//   B. an address the server would drop before it reaches a mail header (a name in angle brackets,
//      a second address, a double dot, a space, no dot in the domain, non-ASCII) is refused at the
//      box with a plain sentence, and nothing is saved
//   C. the box and the server agree: every address in the corpus the box refuses, the server's own
//      cleanReplyAddress refuses too, and the one it saves, the server keeps
//   D. a good address saves through save_prefs with the person's other preferences carried along,
//      and the screen says "Saved."
//   E. clearing it saves without one and says replies go to the sign-in email
//   F. a server that drops the address answers ok, and the screen says so instead of "Saved."
//   G. at a phone's width the card adds no sideways scroll
//   H. nothing on this screen sends an email
//   K. reply copies (2026-10-07, opt-in per person): with no saved key "StructureStudio only" is
//      the choice shown; "StructureStudio and my inbox" saves replyCopy:true through save_prefs with
//      the person's other preferences carried along and says "Saved."; switching back sends false,
//      which the server drops (no key = off); a server build that drops the key says nothing has
//      changed instead of "Saved." (that build still copies everyone, so the message mustn't say
//      where replies go) and shows "StructureStudio only" again; only a saved `true` shows as on;
//      the two choices are never `disabled`; the off line says files aren't kept on the record;
//      and (K10) a failed save goes back to what the server last kept from ANY card's save, not
//      to an older answer another card's save has since overwritten
//
// The stub answers save_prefs with the REAL rule: it imports _shared/repReplyTo.ts (Node strips the
// types itself, 22.18+ / 23.6+) and keeps replyToEmail only when cleanReplyAddress does, and
// replyCopy only when it is exactly true, as portal-settings does. Supabase is stubbed at the
// network layer; nothing leaves the machine and NOTHING IS SENT.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/replyToCard.mjs              (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/reply-to-card (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an older
// portal.app.compiled.js> serves that file instead, which is how to prove the checks can fail:
// against the artifact before the 2026-10-05 change, A1, A2 and the B checks for the addresses the
// old box let through fail (10 checks: D1 and E1 follow, because the old box saved those
// addresses). Against the artifact before reply copies (2026-10-07), 13 checks fail: A1, A2, A4,
// A5 (the old wording), K0, K8, K10, K10b, the four K9 and G1 (there are no choices to press;
// K1–K7 are not run when K0 finds none). Against a build whose commit() doesn't record what the
// server kept (the first cut of reply copies), K10 and K10b fail: the card showed copies on after
// a failed save while the server held no key, and the next save put it back.
//
// Fixtures are obviously fake (example.test, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";
import { cleanReplyAddress } from "../../supabase/functions/_shared/repReplyTo.ts";

const CLIENT = "acme-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000003", aud: "authenticated", role: "authenticated", email: "rep@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER_ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders",
  "change_order_approve", "build_schedule", "delivery_schedule", "repairs", "commissions", "reports", "phone",
  "settings_structures", "settings_options", "settings_branding", "settings_crm", "settings_quickbooks",
  "settings_email", "settings_team", "settings_billing"].map((k) => [k, "edit"]));
const PREFS = { designsView: "pipeline", emailSignature: "Sam\nAcme Sheds" };

const { ok, failed } = reporter();
const shots = shotsDir("reply-to-card");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

/** save_prefs as portal-settings answers it: the whitelist, the reply address through the real
 *  cleanReplyAddress, replyCopy only when exactly true. `server: "old"` drops the reply address
 *  (and the switch) the way a build without either key did; `server: "noCopy"` keeps the address
 *  and drops the switch, the way the builds before 2026-10-07 do. */
function savePrefs(raw, server) {
  const clean = {};
  if (raw.designsView === "list" || raw.designsView === "pipeline") clean.designsView = raw.designsView;
  if (server !== "old") {
    const addr = cleanReplyAddress(raw.replyToEmail);
    if (addr) clean.replyToEmail = addr;
  }
  if (server === "new" && raw.replyCopy === true) clean.replyCopy = true;
  if (typeof raw.emailSignature === "string" && raw.emailSignature.trim()) clean.emailSignature = raw.emailSignature.trim();
  return clean;
}

/** `failFirstSave` (ms): the FIRST save_prefs is held that long and then answered 502, every later
 *  one is answered at once. That is how K10 lands another card's save while the first is out. */
async function scenario(browser, { name, server = "new", prefs = PREFS, failFirstSave = 0, viewport = { width: 1400, height: 1000 } }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const calls = [];
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
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
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER_ACCESS, prefs,
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "save_prefs":
        if (failFirstSave && calls.filter((c) => c.action === "save_prefs").length === 1) {
          await new Promise((r) => setTimeout(r, failFirstSave));
          return json(route, { error: "Bad gateway" }, 502);
        }
        return json(route, { ok: true, prefs: savePrefs(body.prefs || {}, server) });
      default: return json(route, { ok: true });
    }
  };
  await ctx.route(`**/${REF}.supabase.co/**`, handler);
  await ctx.route(`**/${REF}.functions.supabase.co/**`, handler);
  if (process.env.SS_PORTAL_ARTIFACT) {
    const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
    await ctx.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
  }
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => { history.pushState({}, "", "/portal/settings/myprofile"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await page.waitForFunction(() => document.body.innerText.includes("Where replies to your emails go"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { ctx, page, calls };
}

// The card, found by its heading. Everything below reads and types inside it only.
const card = (page) => page.locator("div").filter({ has: page.locator("div", { hasText: /^Where replies to your emails go$/ }) }).last();
const box = (page) => card(page).locator('input[type="email"]');
const saveBtn = (page) => card(page).locator("button", { hasText: /^Save$/ });
const cardText = (page) => card(page).innerText({ timeout: 3000 }).catch(() => "");
const fill = (loc, v) => loc.fill(v, { timeout: 3000 }).then(() => true, () => false);
const tap = (loc) => loc.click({ timeout: 3000 }).then(() => true, () => false);
const saves = (s) => s.calls.filter((c) => c.action === "save_prefs");
const choice = (page, which) => card(page).locator(`[data-ss-reply-copy="${which}"]`);
const pressed = (page, which) => choice(page, which).getAttribute("aria-pressed", { timeout: 3000 }).catch(() => null);
const SAVED_LINE = /(^|\n)Saved\.(\n|$)/;
const ONLY_HERE = "Replies show on the customer's record in StructureStudio only.";
const NO_FILES = "Files a customer attaches aren't kept there yet, so pick \"StructureStudio and my inbox\" if you need them.";
const AND_INBOX = "Replies show on the customer's record, and a copy comes to your own inbox too.";
const SENDS = ["email_send_test", "resend_quote_email", "send_invoice", "reissue_invoice", "crm_send_email", "send_change_order"];
const REFUSED = "That doesn't look like an email address.";

// Each of these is dropped by the server before it could reach a Reply-To header. The ones marked
// `old` were let through by the box before this change (its rule was "something@something.something"),
// so the server would quietly drop them after the person had been told "Saved, but…".
const BAD = [
  { v: "Sam <sam@acme-sheds.example.test>", why: "a name in angle brackets" },
  { v: "<sam@acme-sheds.example.test>", why: "angle brackets", old: true },
  { v: "sam@acme-sheds.example.test,boss@acme-sheds.example.test", why: "two addresses" },
  { v: "sam,boss@acme-sheds.example.test", why: "a comma (a list separator in the header)", old: true },
  { v: "sam;boss@acme-sheds.example.test", why: "a semicolon", old: true },
  { v: "sam@acme-sheds..example.test", why: "a double dot", old: true },
  { v: "sam smith@acme-sheds.example.test", why: "a space" },
  { v: "sam@acme-sheds", why: "no dot in the domain" },
  { v: "josé@acme-sheds.example.test", why: "non-ASCII", old: true },
  { v: "\"sam\"@acme-sheds.example.test", why: "quotes", old: true },
];
const GOOD = "Sam.Quotes+sheds@acme-sheds.example.test";

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  {
    const s = await scenario(browser, { name: "main" });
    const rendered = ok("A0 the card rendered on My Profile", (await card(s.page).count()) > 0 && (await box(s.page).count()) === 1);
    if (!rendered) throw new Error("My Profile never rendered the reply card; refusing to report the rest as passes");
    const t = await cardText(s.page);
    ok("A1 the card says it covers messages, estimates, invoices and change orders, and that replies land on the record",
      /a message, an estimate, an invoice or a change order, their reply shows on that\s+customer's\s+record here/.test(t), t.slice(0, 400));
    ok("A2 and where a reply to a confirmation the customer set off goes",
      /When a customer replies to the confirmation they get after\s+accepting an estimate or signing an invoice, the copy goes to the person that customer is\s+assigned to, if they have one and they've switched this on\./.test(t), t.slice(-500));
    ok("A4 it says replies reach the inbox until replies are set up, and nothing for the CRM's own email",
      /Until your company sets up replies under Settings → Email Settings, StructureStudio can't\s+receive them, so replies come to your inbox whichever you pick\./.test(t)
        && /An estimate or invoice your CRM sends for you\s+follows the CRM's own settings/.test(t), t.slice(0, 900));
    ok("A5 it says estimate, never quote", !/\bquotes?\b/i.test(t), (t.match(/.{0,40}\bquotes?\b.{0,40}/i) || [""])[0]);
    await card(s.page).scrollIntoViewIfNeeded().catch(() => {});
    await card(s.page).screenshot({ path: join(shots, "A-card.png") }).catch(() => {});

    // ── B + C. Refused at the box, and the server agrees ──
    for (const [i, b] of BAD.entries()) {
      await fill(box(s.page), b.v);
      const before = saves(s).length;
      await tap(saveBtn(s.page));
      await s.page.waitForTimeout(250);
      const said = await cardText(s.page);
      ok(`B${i + 1} refused at the box: ${b.why}${b.old ? " (the old box let this through)" : ""}`,
        said.includes(REFUSED) && saves(s).length === before, JSON.stringify({ v: b.v, saves: saves(s).length - before }));
      ok(`C${i + 1} and the server would drop it too`, cleanReplyAddress(b.v) === null, b.v);
    }
    await card(s.page).screenshot({ path: join(shots, "B-refused.png") }).catch(() => {});

    // ── D. A good address saves, carrying the person's other preferences ──
    await fill(box(s.page), `  ${GOOD} `);
    await tap(saveBtn(s.page));
    await s.page.waitForTimeout(600);
    const sv = saves(s);
    const last = (sv[sv.length - 1] || {}).prefs || {};
    ok("D1 save_prefs is posted once, with the address as typed (trimmed)", sv.length === 1 && last.replyToEmail === GOOD, JSON.stringify(sv));
    ok("D2 carrying the other preferences", last.designsView === "pipeline" && last.emailSignature === "Sam\nAcme Sheds", JSON.stringify(last));
    ok("D3 and the screen says Saved.", /(^|\n)Saved\.(\n|$)/.test(await cardText(s.page)), (await cardText(s.page)).slice(-200));
    ok("C0 the server keeps the address the box saved", cleanReplyAddress(GOOD) === GOOD);
    await card(s.page).screenshot({ path: join(shots, "D-saved.png") }).catch(() => {});

    // ── E. Clearing it ──
    await fill(box(s.page), "");
    await tap(saveBtn(s.page));
    await s.page.waitForTimeout(600);
    const sv2 = saves(s);
    const cleared = (sv2[sv2.length - 1] || {}).prefs || {};
    ok("E1 clearing saves an empty address", sv2.length === 2 && cleared.replyToEmail === "", JSON.stringify(cleared));
    ok("E2 and says replies go to the sign-in email", (await cardText(s.page)).includes("Cleared — replies go to your login email."));

    ok("H1 nothing on this screen sent an email", SENDS.every((a) => s.calls.every((c) => c.action !== a)), JSON.stringify(s.calls.map((c) => c.action)));
    await s.ctx.close();
  }

  // ── F. A server that drops the address still says ok ────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "old-server", server: "old" });
    await fill(box(s.page), GOOD);
    await tap(saveBtn(s.page));
    await s.page.waitForTimeout(600);
    const t = await cardText(s.page);
    ok("F1 the screen says the address wasn't kept, not \"Saved.\"",
      t.includes("Saved, but this server build didn't keep the address") && !/(^|\n)Saved\.(\n|$)/.test(t), t.slice(-300));
    ok("F2 and leaves what was typed in the box", (await box(s.page).inputValue().catch(() => null)) === GOOD);
    await s.ctx.close();
  }

  // ── A3. A saved address is shown in the box ─────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "seeded", prefs: { ...PREFS, replyToEmail: GOOD } });
    ok("A3 a saved address is in the box, and Save waits for a change",
      (await box(s.page).inputValue().catch(() => null)) === GOOD && (await saveBtn(s.page).isDisabled().catch(() => false)));
    await s.ctx.close();
  }

  // ── K. Reply copies: off by default, on and off again through save_prefs ─────────────────────
  {
    const s = await scenario(browser, { name: "copies", prefs: { ...PREFS, replyToEmail: GOOD } });
    const rendered = ok("K0 the two choices rendered", (await choice(s.page, "off").count()) === 1 && (await choice(s.page, "on").count()) === 1);
    if (rendered) {
      let t = await cardText(s.page);
      ok("K1 with no saved key, \"StructureStudio only\" is the choice shown, and the card says what it means",
        (await pressed(s.page, "off")) === "true" && (await pressed(s.page, "on")) === "false" && t.includes(ONLY_HERE) && !t.includes(AND_INBOX), t.slice(0, 600));
      ok("K1b and that a customer's attached files aren't kept on the record, so the inbox choice is the way to get them",
        t.includes(NO_FILES), t.slice(0, 800));
      ok("K2 the choices are never disabled",
        (await choice(s.page, "off").getAttribute("disabled")) === null && (await choice(s.page, "on").getAttribute("disabled")) === null);
      await card(s.page).screenshot({ path: join(shots, "K-off.png") }).catch(() => {});

      await tap(choice(s.page, "on"));
      await s.page.waitForTimeout(600);
      let sv = saves(s);
      let last = (sv[sv.length - 1] || {}).prefs || {};
      ok("K3 \"StructureStudio and my inbox\" posts save_prefs once with replyCopy:true",
        sv.length === 1 && last.replyCopy === true, JSON.stringify(sv));
      ok("K4 carrying the address, the Pipeline default and the signature along",
        last.replyToEmail === GOOD && last.designsView === "pipeline" && last.emailSignature === "Sam\nAcme Sheds", JSON.stringify(last));
      t = await cardText(s.page);
      ok("K5 and the screen says Saved., with the inbox choice shown",
        SAVED_LINE.test(t) && (await pressed(s.page, "on")) === "true" && t.includes(AND_INBOX), t.slice(-400));
      await card(s.page).screenshot({ path: join(shots, "K-on.png") }).catch(() => {});

      await tap(choice(s.page, "off"));
      await s.page.waitForTimeout(600);
      sv = saves(s);
      last = (sv[sv.length - 1] || {}).prefs || {};
      const kept = savePrefs(last, "new");
      ok("K6 switching back sends replyCopy:false, which the server drops (no key = off)",
        sv.length === 2 && last.replyCopy === false && !("replyCopy" in kept) && kept.replyToEmail === GOOD && kept.designsView === "pipeline", JSON.stringify({ last, kept }));
      t = await cardText(s.page);
      ok("K7 and the screen says Saved., with StructureStudio only shown",
        SAVED_LINE.test(t) && (await pressed(s.page, "off")) === "true" && t.includes(ONLY_HERE), t.slice(-400));
    }
    ok("H2 nothing on this screen sent an email", SENDS.every((a) => s.calls.every((c) => c.action !== a)), JSON.stringify(s.calls.map((c) => c.action)));
    await s.ctx.close();
  }

  // ── K8. A server build that doesn't know the key says so ────────────────────────────────────
  {
    const s = await scenario(browser, { name: "copies-old-server", server: "noCopy" });
    await tap(choice(s.page, "on"));
    await s.page.waitForTimeout(600);
    const t = await cardText(s.page);
    ok("K8 a server that drops replyCopy says nothing has changed, not \"Saved.\" and not where replies go, and StructureStudio only is shown again",
      t.includes("Saved, but this server build didn't keep it, so nothing has changed yet. Tell CSM Synergy.")
        && !/for now/.test(t) && !SAVED_LINE.test(t) && (await pressed(s.page, "off")) === "true" && t.includes(ONLY_HERE), t.slice(-500));
    await card(s.page).screenshot({ path: join(shots, "K-old-server.png") }).catch(() => {});
    await s.ctx.close();
  }

  // ── K10. A failed save goes back to what the server holds NOW ───────────────────────────────
  // Copies on. "StructureStudio only" is pressed and that save hangs; meanwhile the Pipeline
  // default is changed, and that save (carrying replyCopy:false) lands, so the server holds no key.
  // Then the first save fails. The card must show "StructureStudio only", the truth, and the next
  // save must carry false; going back to the seeded "on" would show copies no email gets.
  {
    const s = await scenario(browser, { name: "copies-failed-save", prefs: { ...PREFS, replyCopy: true }, failFirstSave: 1500 });
    const started = (await pressed(s.page, "on")) === "true";
    await tap(choice(s.page, "off"));
    await s.page.waitForTimeout(150);
    await tap(s.page.locator("button", { hasText: /^List$/ }).first());
    await s.page.waitForTimeout(2200);
    let sv = saves(s);
    const second = (sv[1] || {}).prefs || {};
    const held = savePrefs(second, "new");
    const t = await cardText(s.page);
    ok("K10 a failed save goes back to what the server last kept, even when another card's save changed it",
      started && sv.length === 2 && second.replyCopy === false && !("replyCopy" in held)
        && (await pressed(s.page, "off")) === "true" && (await pressed(s.page, "on")) === "false" && t.includes(ONLY_HERE) && !SAVED_LINE.test(t),
      JSON.stringify({ started, saves: sv.map((c) => c.prefs && c.prefs.replyCopy), on: await pressed(s.page, "on"), tail: t.slice(-300) }));
    await tap(s.page.locator("button", { hasText: /^Pipeline board$/ }).first());
    await s.page.waitForTimeout(600);
    sv = saves(s);
    ok("K10b and the next save from any card carries what the screen shows",
      sv.length === 3 && ((sv[2] || {}).prefs || {}).replyCopy === false, JSON.stringify(sv.map((c) => c.prefs && c.prefs.replyCopy)));
    await s.ctx.close();
  }

  // ── K9. Only a saved `true` shows as on ─────────────────────────────────────────────────────
  for (const [v, want] of [[true, "on"], ["true", "off"], [1, "off"], [false, "off"]]) {
    const s = await scenario(browser, { name: `copies-seeded-${JSON.stringify(v)}`, prefs: { ...PREFS, replyCopy: v } });
    ok(`K9 saved replyCopy ${JSON.stringify(v)} shows "${want === "on" ? "StructureStudio and my inbox" : "StructureStudio only"}"`,
      (await pressed(s.page, want)) === "true" && (await pressed(s.page, want === "on" ? "off" : "on")) === "false");
    await s.ctx.close();
  }

  // ── G. A phone's width ──────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "narrow", viewport: { width: 390, height: 844 } });
    // The page's own width before the card is touched, so a sideways scroll some other part of
    // Settings already has is not blamed on this card.
    const before = await s.page.evaluate(() => document.documentElement.scrollWidth);
    await card(s.page).scrollIntoViewIfNeeded().catch(() => {});
    await fill(box(s.page), "Sam <sam@acme-sheds.example.test>");
    await tap(saveBtn(s.page));
    await s.page.waitForTimeout(300);
    const fit = await s.page.evaluate(() => {
      const h = [...document.querySelectorAll("div")].find((d) => d.textContent === "Where replies to your emails go");
      const c = h && h.parentElement;
      if (!c) return null;
      const r = c.getBoundingClientRect();
      const inp = c.querySelector('input[type="email"]').getBoundingClientRect();
      const choices = [...c.querySelectorAll("[data-ss-reply-copy]")].map((b) => b.getBoundingClientRect().right);
      return { right: r.right, inputRight: inp.right, choicesRight: Math.max(0, ...choices), choices: choices.length, vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth };
    });
    ok("G1 at 390px the card, its choices, its box and its message fit, and add no sideways scroll",
      !!fit && fit.choices === 2 && fit.right <= fit.vw && fit.choicesRight <= fit.vw && fit.inputRight <= fit.vw && fit.sw <= Math.max(before, fit.vw), JSON.stringify({ ...fit, before }));
    await s.page.screenshot({ path: join(shots, "G-narrow.png") });
    await s.ctx.close();
  }

  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\nreplyToCard: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
