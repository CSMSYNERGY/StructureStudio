// The "Quotes are good for … days" box (Settings → Company), driven for real on the COMPILED portal
// (2026-10-05). Carolyn, 2026-08-06 (Fathom 775681234, 1:00:07): the printed estimate should say
// "estimate good for X amount of days". The number is client_settings.quote_valid_days (migration
// 269), printed as "Valid until" on every quote PDF.
//
//   A. the box shows the tenant's number beside "days", says what it does in plain words, and the
//      logo box says an uploaded PNG or JPG also prints on the quote PDFs
//   B. a new number saves through the ordinary Save Settings, as a number, with the rest of the
//      form, and the screen says "Settings saved."
//   C. 0, 366, a fraction or words are refused at the box with one plain sentence, and nothing is
//      saved; a cleared box is not refused, it saves the 30 its placeholder shows
//   D. the box and the server agree: every value the box accepts, the server's own
//      parseQuoteValidDays stores as that same number (a blank as 30, on both sides); every value
//      the box refuses, the server refuses too
//   E. a server older than this page (no quoteValidDays in status) or a database without 269
//      (quoteValidDays: null) shows no box, and Save Settings sends no quoteValidDays at all
//   F. at a phone's width the box fits on screen
//   G. nothing on this screen sends an email or calls the CRM
//
// The stub answers `save` with the REAL rule: it imports _shared/quoteValidity.ts (Node strips the
// types itself, 22.18+ / 23.6+) and refuses exactly what portal-settings refuses. Supabase is stubbed
// at the network layer; nothing leaves the machine and NOTHING IS SAVED anywhere.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/quoteValidDays.mjs           (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/quote-valid-days (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an older
// portal.app.compiled.js> serves that file instead, which is how to prove the checks can fail:
// against the artifact before this change (4dc78fc) 6 fail, A1-A4, B-D and F1. The E checks hold
// there too, as they should: an older page never sent the field.
//
// Fixtures are made up (example.test, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";
import { parseQuoteValidDays } from "../../supabase/functions/_shared/quoteValidity.ts";

const CLIENT = "acme-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000005", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER_ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders",
  "change_order_approve", "build_schedule", "delivery_schedule", "repairs", "commissions", "reports", "phone",
  "settings_structures", "settings_options", "settings_branding", "settings_crm", "settings_quickbooks",
  "settings_email", "settings_team", "settings_billing"].map((k) => [k, "edit"]));
const REFUSED = "Estimates have to stay good for a whole number of days, from 1 to 365.";
const LOGO_HINT = "A PNG or JPG you upload here also prints at the top of your estimate PDFs.";
const TERMS_LABEL = "estimate terms";

const { ok, failed } = reporter();
const shots = shotsDir("quote-valid-days");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

/** `server`: "new" answers quoteValidDays; "old" predates the field; "no269" is a database without
 *  the column (status answers null). */
async function scenario(browser, { name, server = "new", days = 14, viewport = { width: 1400, height: 1000 } }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const calls = [];
  const outside = [];
  const state = { days };
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => { outside.push(route.request().url()); return route.abort(); });
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
    if (url.includes("leadconnectorhq")) { outside.push(url); return route.abort(); }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    switch (body.action) {
      case "status": {
        const st = { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER_ACCESS, prefs: null,
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false,
          businessName: "Acme Sheds", businessPhone: "(555) 010-0100", businessAddress: {}, quoteTerms: "Deposit due at signing.",
          branding: { companyName: "Acme Sheds" }, emailReady: true };
        if (server === "new") st.quoteValidDays = state.days;
        if (server === "no269") st.quoteValidDays = null;
        return json(route, st);
      }
      case "save": {
        // portal-settings' rule, imported: refuse with its sentence, or store what it would store.
        if ("quoteValidDays" in body) {
          const d = parseQuoteValidDays(body.quoteValidDays);
          if (d == null) return json(route, { error: REFUSED }, 400);
          state.days = d;
        }
        return json(route, { ok: true });
      }
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
  await page.evaluate(() => { history.pushState({}, "", "/portal/settings/company"); window.dispatchEvent(new PopStateEvent("popstate")); });
  // Field labels are upper-cased by CSS (S.lbl), and innerText reports them that way.
  await page.waitForFunction((x) => document.body.innerText.toLowerCase().includes(x), TERMS_LABEL, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { ctx, page, calls, outside, state };
}

const box = (page) => page.locator("#ss-quote-valid-days");
const saveBtn = (page) => page.getByRole("button", { name: /^Save Settings$/ });
const saves = (s) => s.calls.filter((c) => c.action === "save");
const bodyText = (page) => page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
const waitText = (page, t, timeout = 6000) => page.waitForFunction((x) => document.body.innerText.includes(x), t, { timeout }).then(() => true, () => false);
async function typeAndSave(s, value) {
  await box(s.page).fill(value, { timeout: 3000 });
  const before = saves(s).length;
  await saveBtn(s.page).click({ timeout: 3000 });
  await s.page.waitForTimeout(500);
  return saves(s).slice(before);
}
const SENDS = ["email_send_test", "resend_quote_email", "send_invoice", "reissue_invoice", "crm_send_email"];

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  // ── A + B + C + D on a current server ──
  {
    const s = await scenario(browser, { name: "new" });
    const first = await bodyText(s.page);
    const rendered = first.toLowerCase().includes(TERMS_LABEL);
    const loaded = ok("A0 the Company settings rendered", rendered, rendered ? "" : first.slice(0, 600).replace(/\s+/g, " "));
    if (!loaded) throw new Error("the Company settings never rendered; refusing to report the rest as passes");
    ok("A1 the box shows the tenant's 14 days", (await box(s.page).count()) === 1 && (await box(s.page).inputValue()) === "14");
    const t = await bodyText(s.page);
    const label = await s.page.locator('label[for="ss-quote-valid-days"]').textContent({ timeout: 3000 }).catch(() => "");
    const unit = await box(s.page).locator("xpath=following-sibling::span[1]").textContent({ timeout: 3000 }).catch(() => "");
    ok("A2 it is labelled in plain words, with 'days' beside the box", label === "Estimates are good for" && unit === "days", `${label} / ${unit}`);
    ok("A3 it says what the number does", t.includes("Your estimates show a “Valid until” date this many days after the estimate date. Anywhere from 1 to 365 days."));
    ok("A4 the logo box says an uploaded PNG or JPG prints on the estimate PDFs", t.includes(LOGO_HINT));
    await s.page.locator("#ss-quote-valid-days").scrollIntoViewIfNeeded().catch(() => {});
    await s.page.screenshot({ path: join(shots, "A-company-card.png") }).catch(() => {});

    // B-D need the box. Without it (an older page) they are reported as failures, not skipped.
    const hasBox = (await box(s.page).count()) === 1;
    if (!hasBox) ok("B-D the box is missing, so saving a number cannot be checked", false);
    if (hasBox) {
      // B. a good number saves with the rest of the form
      let sent = await typeAndSave(s, "21");
      ok("B1 Save Settings sends quoteValidDays as the number 21", sent.length === 1 && sent[0].quoteValidDays === 21, JSON.stringify(sent));
      ok("B2 with the rest of the form (quote terms, business name)", sent.length === 1 && sent[0].quoteTerms === "Deposit due at signing." && sent[0].businessName === "Acme Sheds");
      ok("B3 the screen says Settings saved.", await waitText(s.page, "Settings saved."));
      ok("B4 the server stored 21", s.state.days === 21, String(s.state.days));

      // C. refused at the box, nothing saved
      for (const v of ["0", "366", "7.5", "two weeks", "-3"]) {
        sent = await typeAndSave(s, v);
        const said = (await bodyText(s.page)).includes(REFUSED);
        ok(`C ${JSON.stringify(v)} is refused at the box with the sentence, and nothing is saved`, said && sent.length === 0, `said=${said} saves=${JSON.stringify(sent)}`);
      }
      await s.page.screenshot({ path: join(shots, "C-refused.png") }).catch(() => {});
      ok("C9 the server still holds 21", s.state.days === 21, String(s.state.days));
      // A cleared box means the default its placeholder shows, as the server reads a blank, and it
      // must not hold up the rest of the form.
      sent = await typeAndSave(s, "");
      ok("C10 a cleared box saves 30, with the rest of the form, and no refusal",
        sent.length === 1 && sent[0].quoteValidDays === 30 && sent[0].businessName === "Acme Sheds" && !(await bodyText(s.page)).includes(REFUSED),
        JSON.stringify(sent));
      ok("C11 the server stored 30", s.state.days === 30, String(s.state.days));

      // D. the box and the server agree, value by value
      const corpus = ["1", "14", "30", "45", "365", " 60 ", "", "  ", "0", "366", "7.5", "1e2", "abc", "-1", "+5", "0x10"];
      for (const v of corpus) {
        const n = saves(s).length;
        await box(s.page).fill(v, { timeout: 3000 });
        await saveBtn(s.page).click({ timeout: 3000 });
        await s.page.waitForTimeout(350);
        const went = saves(s).slice(n);
        const server = parseQuoteValidDays(v);
        if (went.length) {
          ok(`D ${JSON.stringify(v)}: the box sent it and the server stores the same number`, server != null && went[0].quoteValidDays === server && s.state.days === server, `sent ${JSON.stringify(went[0].quoteValidDays)} server ${server}`);
        } else {
          ok(`D ${JSON.stringify(v)}: the box refused it, and so does the server`, server == null, `server would store ${server}`);
        }
      }
    }
    ok("G1 nothing on this screen emailed anyone or reached the CRM",
      !s.calls.some((c) => SENDS.includes(c.action)) && s.outside.every((u) => !u.includes("leadconnectorhq")), JSON.stringify(s.calls.map((c) => c.action)));
    await s.ctx.close();
  }

  // ── E. an older server, and a database without 269 ──
  for (const server of ["old", "no269"]) {
    const s = await scenario(browser, { name: server, server });
    ok(`E ${server}: the Company settings rendered`, (await bodyText(s.page)).toLowerCase().includes(TERMS_LABEL));
    ok(`E ${server}: no box`, (await box(s.page).count()) === 0);
    await saveBtn(s.page).click({ timeout: 3000 });
    await s.page.waitForTimeout(500);
    const sent = saves(s);
    ok(`E ${server}: Save Settings still saves, and sends no quoteValidDays`, sent.length === 1 && !("quoteValidDays" in sent[0]), JSON.stringify(sent));
    ok(`E ${server}: and says Settings saved.`, await waitText(s.page, "Settings saved."));
    await s.ctx.close();
  }

  // ── F. a phone ──
  {
    const s = await scenario(browser, { name: "phone", viewport: { width: 390, height: 844 } });
    await box(s.page).scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await s.page.waitForTimeout(300);
    const r = await s.page.evaluate(() => {
      const el = document.getElementById("ss-quote-valid-days");
      const row = el && el.parentElement;
      const b = row && row.getBoundingClientRect();
      return b ? { right: Math.round(b.right), vw: document.documentElement.clientWidth } : null;
    });
    ok("F1 the box and 'days' fit on a phone's screen", !!r && r.right <= r.vw, JSON.stringify(r));
    await s.page.screenshot({ path: join(shots, "F-phone.png") }).catch(() => {});
    await s.ctx.close();
  }
} finally {
  await browser.close();
}

ok("G2 no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
const f = failed();
console.log(f.length ? `\n${f.length} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(f.length ? 1 : 0);
