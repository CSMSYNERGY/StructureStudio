// The email wording editor (Settings → Email Settings → Your wording), driven for real on the
// COMPILED portal (2026-10-04, templates beyond the subject and opening line). Carolyn, 2026-08-21:
// "a template that they can edit, you know, for images and all of that stuff too". Her CRM quote
// email is a picture, the details, then a "View Shed Quote" button.
//
//   A. the editor shows Subject, Opening line, Closing message, Button text and "Show the building
//      photo" on the quote tab, the photo box is not on the invoice tab, and the hint lists {customer}
//   B. the boxes are filled from the saved wording email_status hands back (photo switch included)
//   C. Preview sends the open tab's wording (typed, unsaved) to email_preview_template, and draws the
//      answer in a frame with sandbox="" from srcdoc: the button's words, the closing, the photo and
//      the builder's own name; the subject shows above it; a link in it opens nothing
//   D. photo unticked: the preview has no picture; no usable style photo: a note says where to add one;
//      ticked photos that were copied from another account: a note says to upload them again
//   E. a switch of tab hides the other tab's preview
//   F. Save sends every tab's wording, says "Saved." and shows what the server kept
//   G. a server that drops fields it doesn't know (an older build) answers ok, and the screen says
//      which ones it didn't keep instead of "Saved.", keeping what was typed
//   H. markup is refused with the server's sentence, by Save and by Preview alike
//   I. an older server with no Preview at all gets a plain sentence, not "Unrecognised action"
//   J. nothing on this screen sends an email
//   K. at a phone's width the editor and the preview add no sideways scroll
//
// The stub answers email_save_template and email_preview_template with the REAL rules and the REAL
// email: it imports _shared/emailTemplates.ts (Node strips the types itself, 22.18+ / 23.6+) and
// runs cleanTemplateCopy and templatePreviewEmail, so what the frame shows is what the server would
// render. Supabase is stubbed at the network layer; nothing leaves the machine and NOTHING IS SENT.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/emailTemplateEditor.mjs     (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/email-template-editor (SS_SHOTS overrides); C-preview.png is the
// preview. SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how
// to prove the checks can fail: against the artifact before this change A, C and F fail.
//
// Fixtures are obviously fake (example.test, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";
import { cleanTemplateCopy, templatePreviewEmail } from "../../supabase/functions/_shared/emailTemplates.ts";

const CLIENT = "acme-sheds";
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

// The builder's own storage, served locally: a logo and a style photo, as the real ones would be.
const STORAGE = `https://${REF}.supabase.co/storage/v1/object/public`;
const LOGO = `${STORAGE}/branding/${CLIENT}/logo.svg`;
const PHOTO = `${STORAGE}/branding/${CLIENT}/style-lofted-barn.svg`;
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="90" viewBox="0 0 340 90"><rect width="340" height="90" rx="12" fill="#14532D"/><text x="170" y="57" font-family="Arial" font-size="34" font-weight="700" fill="#FFF" text-anchor="middle">ACME SHEDS</text></svg>`;
const PHOTO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1072" height="600" viewBox="0 0 1072 600"><rect width="1072" height="600" fill="#BFDBFE"/><rect y="470" width="1072" height="130" fill="#4D7C0F"/><polygon points="316,250 536,120 756,250" fill="#7F1D1D"/><rect x="336" y="250" width="400" height="230" fill="#B91C1C"/><rect x="486" y="330" width="100" height="150" fill="#FEF3C7"/><rect x="376" y="290" width="70" height="60" fill="#FEF3C7"/><rect x="626" y="290" width="70" height="60" fill="#FEF3C7"/><text x="536" y="560" font-family="Arial" font-size="34" fill="#FFF" text-anchor="middle">Lofted Barn (sample photo)</text></svg>`;

const BIZ = { business_name: "Acme Sheds", business_logo_url: LOGO, business_phone: "(555) 555-0100", business_website: "acmesheds.example.com", quote_terms: "Quote good for 30 days.\nPrices include delivery within 50 miles.", invoice_in_ghl: false };
const SAVED = { quote: { button: "View Shed Quote", picture: false }, invoice: { intro: "Thanks for your order, {customer}!" } };

const { ok, failed } = reporter();
const shots = shotsDir("email-template-editor");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

/**
 * One fresh browser context per scenario. → { page, calls, go }; `calls` is every portal-settings
 * body the page posted, in order.
 *   server: "new" (this build), "old-save" (drops closing/button/picture like the old whitelist),
 *           or "old" (no Preview action at all, and the old save)
 *   photo:  whether the builder has a style photo switched on for quotes (true / false), or
 *           "not_own": ticked photos, but all in another account's folder (a copied catalog)
 */
async function scenario(browser, { name, server = "new", photo = true, saved = SAVED, viewport = { width: 1400, height: 1000 } }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const popups = [];
  page.on("popup", (p) => popups.push(p.url()));
  const calls = [];
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    if (url === LOGO) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: LOGO_SVG });
    if (url === PHOTO) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: PHOTO_SVG });
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
        return json(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER_ACCESS, prefs: null,
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "email_status":
        return json(route, {
          clientId: CLIENT, platformReady: true, templateCopy: saved, domainStatus: "verified", domain: "acmesheds.example.com",
          fromName: "Acme Sheds", fromLocal: "info", fromAddress: "info@acmesheds.example.com", verifiedAt: "2026-09-01T12:00:00Z",
          lastError: null, active: true,
          dnsRecords: [
            { type: "TXT", host: "resend._domainkey.acmesheds.example.com", value: "p=MIGfMA0GCSq", verified: true },
            { type: "MX", host: "send.acmesheds.example.com", value: "feedback-smtp.example.test", verified: true },
          ],
          inbound: { status: "off", domain: null, dnsRecords: [], verifiedAt: null, lastError: null, replyExample: null },
          recentSends: [],
        });
      case "email_save_template": {
        if (server !== "new") {
          // The whitelist before 2026-10-04: subject and opening line only, everything else
          // dropped, and still ok.
          const raw = body.copy || {};
          const kept = {};
          for (const k of ["estimate", "quote", "invoice"]) {
            const v = raw[k] || {};
            const s = typeof v.subject === "string" ? v.subject.replace(/\s+/g, " ").trim() : "";
            const i = typeof v.intro === "string" ? v.intro.replace(/\s+/g, " ").trim() : "";
            if (s || i) kept[k] = { ...(s ? { subject: s } : {}), ...(i ? { intro: i } : {}) };
          }
          return json(route, { ok: true, copy: kept });
        }
        const r = cleanTemplateCopy(body.copy);
        return "error" in r ? json(route, { error: r.error }, 400) : json(route, { ok: true, copy: r.copy });
      }
      case "email_preview_template": {
        if (server === "old") return json(route, { error: `Unrecognised action "${body.action}".` }, 403);
        const kind = body.kind;
        const r = cleanTemplateCopy({ [kind]: body.copy || {} });
        if ("error" in r) return json(route, { error: r.error }, 400);
        const copy = r.copy[kind] || {};
        const off = kind !== "invoice" && copy.picture === false;
        const pic = kind !== "invoice" && !off && photo === true ? PHOTO : null;
        const out = templatePreviewEmail({
          kind, copy, businessName: BIZ.business_name, logoUrl: BIZ.business_logo_url, phone: BIZ.business_phone,
          website: BIZ.business_website, quoteTerms: BIZ.quote_terms, pictureUrl: pic, styleLabel: pic ? "Lofted Barn" : null,
          invoiceToSign: BIZ.invoice_in_ghl === false,
        });
        return json(route, { ok: true, clientId: CLIENT, kind, subject: out.subject, html: out.html, photo: kind === "invoice" ? null : off ? "off" : pic ? "shown" : photo === "not_own" ? "not_own" : "none" });
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
  await page.evaluate(() => { history.pushState({}, "", "/portal/settings/email"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await page.waitForFunction(() => document.body.innerText.includes("Send a test email"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { ctx, page, calls, popups };
}

// A click that cannot abort the run: a missing control is a FAILED CHECK further down.
const tap = (loc, opts = {}) => loc.click({ timeout: 5000, ...opts }).then(() => true, () => false);
const actions = (s, a) => s.calls.filter((c) => c.action === a);
// Reads and writes on a box that may not exist (an older build): a short wait, then null/false, so a
// missing box is a FAILED CHECK rather than a 30-second stall that aborts the run.
const val = (loc) => loc.inputValue({ timeout: 3000 }).catch(() => null);
const checked = (loc) => loc.isChecked({ timeout: 3000 }).catch(() => null);
const fill = (loc, v) => loc.fill(v, { timeout: 3000 }).then(() => true, () => false);
const setCheck = (loc, on) => (on ? loc.check({ timeout: 3000 }) : loc.uncheck({ timeout: 3000 })).then(() => true, () => false);
const field = (page, f) => page.locator(`[data-ss-wording="${f}"]`);
const kindTab = (page, label) => page.locator("[data-ss-email-wording] button").filter({ hasText: new RegExp(`^${label}$`) }).first();
const btn = (page, label) => page.locator("[data-ss-email-wording] button").filter({ hasText: new RegExp(`^${label}$`) }).first();
const wordingText = (page) => page.locator("[data-ss-email-wording]").innerText().catch(() => "");
// A picture of one part of the page, centred first so the portal's sticky header can't sit on it.
async function shotOf(page, selector, file) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, innerWidth), height: Math.min(r.height, innerHeight - Math.max(0, r.y)) };
  }, selector);
  if (box && box.width > 0 && box.height > 0) await page.screenshot({ path: join(shots, file), clip: box });
}
const SENDS = ["email_send_test", "resend_quote_email", "send_invoice", "reissue_invoice", "crm_send_email", "send_change_order"];

// Chrome gives a sandboxed frame a process of its own (IsolateSandboxedIframes), and Playwright's
// routes never see that process's requests: the preview's logo and photo then never reach the stub,
// and C5 fails for the harness's reason, not the page's. Keep the frame in the page's process; the
// sandbox itself is unchanged (C7 still finds the frame's document out of reach).
{
  const own = "IsolateSandboxedIframes";
  const args = (process.env.HARNESS_CHROME_ARGS || "").split(/\s+/).filter(Boolean);
  const i = args.findIndex((a) => a.startsWith("--disable-features="));
  if (i >= 0) args[i] += `,${own}`;
  else args.push(`--disable-features=${own}`);
  process.env.HARNESS_CHROME_ARGS = args.join(" ");
}

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  // ── A–F, H, J. This build's server ─────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "main" });
    // The section itself, found by its heading (which older builds have too), so a run against an
    // older artifact reports every check below as the failure it is rather than stopping here.
    const rendered = ok("A0 the Your wording section rendered on Email Settings", /YOUR WORDING|Your wording/.test(await s.page.locator("body").innerText()));
    if (!rendered) throw new Error("the Email Settings screen never rendered; refusing to report the rest as passes");
    await tap(kindTab(s.page, "Quote"));
    await s.page.waitForTimeout(200);
    const have = {};
    for (const f of ["subject", "intro", "closing", "button", "picture"]) have[f] = await field(s.page, f).count();
    ok("A1 the quote tab has subject, opening line, closing message, button text and the photo box",
      Object.values(have).every((n) => n === 1), JSON.stringify(have));
    const txt = await wordingText(s.page);
    ok("A2 with plain labels", /Closing message/.test(txt) && /Button text/.test(txt) && /Show the building photo/.test(txt));
    ok("A3 the hint lists {customer}", /\{customer\} \(the customer's name\)/.test(txt), txt.slice(0, 200));

    // ── B. Seeded from the saved wording ──
    ok("B1 the saved button text is in its box", (await val(field(s.page, "button"))) === "View Shed Quote");
    ok("B2 the photo box is unticked, as saved", (await checked(field(s.page, "picture"))) === false);
    await tap(kindTab(s.page, "Invoice"));
    await s.page.waitForTimeout(200);
    ok("A4 the invoice tab has no photo box", (await field(s.page, "picture").count()) === 0 && (await field(s.page, "closing").count()) === 1);
    ok("B3 the saved invoice opening line is in its box", (await val(field(s.page, "intro"))) === "Thanks for your order, {customer}!");

    // ── C. Preview the quote, typed and unsaved ──
    await tap(kindTab(s.page, "Quote"));
    await s.page.waitForTimeout(200);
    await fill(field(s.page, "subject"), "Your shed quote {number} from {business}");
    await fill(field(s.page, "intro"), "Hi {customer}, thanks for designing your {building} with us!");
    await fill(field(s.page, "closing"), "Questions? Just reply to this email.\nWe deliver Monday to Saturday.");
    await setCheck(field(s.page, "picture"), true);
    await tap(btn(s.page, "Preview"));
    await s.page.locator("[data-ss-email-preview] iframe").waitFor({ timeout: 8000 }).catch(() => {});
    await s.page.waitForTimeout(600);
    const pv = actions(s, "email_preview_template");
    ok("C1 Preview sends the quote tab's typed wording, once", pv.length === 1 && pv[0].kind === "quote" &&
      pv[0].copy.button === "View Shed Quote" && /reply to this email\.\nWe deliver/.test(pv[0].copy.closing || "") && pv[0].copy.picture === true,
      JSON.stringify(pv));
    const frame = await s.page.evaluate(() => {
      const f = document.querySelector("[data-ss-email-preview] iframe");
      return f ? { sandbox: f.getAttribute("sandbox"), hasSrcdoc: f.hasAttribute("srcdoc"), src: f.getAttribute("src") } : null;
    });
    ok("C2 drawn in a frame with sandbox=\"\" from srcdoc", !!frame && frame.sandbox === "" && frame.hasSrcdoc && !frame.src, JSON.stringify(frame));
    const inner = s.page.frameLocator("[data-ss-email-preview] iframe");
    const innerText = await inner.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    ok("C3 the frame shows the builder's button words and closing", /View Shed Quote/.test(innerText) && /Questions\? Just reply to this email\.\s*We deliver Monday to Saturday\./.test(innerText),
      innerText.slice(0, 300));
    ok("C4 and their own business name, terms and a sample customer", /Acme Sheds/.test(innerText) && /Quote good for 30 days\./.test(innerText) && /Hi Alex Smith, thanks for designing your Lofted Barn - 12x24 with us!/.test(innerText),
      innerText.slice(0, 300));
    const img = await inner.locator(`img[src="${PHOTO}"]`).evaluate((el) => ({ w: el.naturalWidth, shown: el.getBoundingClientRect().width })).catch(() => null);
    ok("C5 the building photo is in it, loaded", !!img && img.w > 0 && img.shown > 100, JSON.stringify(img));
    ok("C6 the subject shows above it, filled", (await s.page.locator("[data-ss-preview-subject]").innerText().catch(() => "")) === "Your shed quote 1001 from Acme Sheds");
    ok("C7 the sandbox runs no script in it", !!frame && (await inner.locator("script").count()) === 0 &&
      (await s.page.evaluate(() => { try { return !!document.querySelector("[data-ss-email-preview] iframe").contentDocument; } catch (_e) { return false; } })) === false);
    await shotOf(s.page, "[data-ss-email-preview]", "C-preview.png");
    // The whole email as the preview frame holds it, drawn on a page of its own (same stubbed
    // storage, so the logo and the photo load): what a customer would see, top to bottom.
    {
      const html = await s.page.evaluate(() => { const f = document.querySelector("[data-ss-email-preview] iframe"); return f && f.getAttribute("srcdoc"); });
      if (html) {
        const p2 = await s.ctx.newPage();
        await p2.setViewportSize({ width: 700, height: 900 });
        await p2.setContent(html, { waitUntil: "load" });
        await p2.screenshot({ path: join(shots, "C-email-full.png"), fullPage: true });
        await p2.close();
      }
    }
    const urlBefore = s.page.url();
    await inner.locator("a", { hasText: "View Shed Quote" }).click({ timeout: 3000 }).catch(() => {});
    await s.page.waitForTimeout(500);
    ok("C8 a link in the preview opens nothing", s.popups.length === 0 && s.page.url() === urlBefore, JSON.stringify(s.popups));

    // ── D. Photo off, then no photo at all ──
    await setCheck(field(s.page, "picture"), false);
    await tap(btn(s.page, "Preview"));
    await s.page.waitForTimeout(800);
    const pv2 = actions(s, "email_preview_template");
    ok("D1 unticked, Preview sends picture: false and the frame has no picture", pv2.length === 2 && pv2[1].copy.picture === false &&
      (await inner.locator("img[width='536']").count()) === 0, JSON.stringify(pv2[1] && pv2[1].copy));
    ok("D2 the button's words are still there", /View Shed Quote/.test(await inner.locator("body").innerText().catch(() => "")));

    // ── E. Another tab hides this tab's preview ──
    await tap(kindTab(s.page, "Estimate"));
    await s.page.waitForTimeout(200);
    ok("E1 switching tab hides the quote's preview", (await s.page.locator("[data-ss-email-preview]").count()) === 0);
    await tap(kindTab(s.page, "Invoice"));
    await s.page.waitForTimeout(200);
    await fill(field(s.page, "button"), "Sign Invoice {number}");
    await tap(btn(s.page, "Preview"));
    await s.page.waitForTimeout(800);
    const invText = await inner.locator("body").innerText().catch(() => "");
    ok("E2 the invoice preview signs, with their button words and the saved opening line filled",
      /Sign Invoice 1001/.test(invText) && /Thanks for your order, Alex Smith!/.test(invText), invText.slice(0, 300));
    await shotOf(s.page, "[data-ss-email-preview]", "E-invoice-preview.png");

    // ── H. Markup is refused, by Preview and by Save ──
    await fill(field(s.page, "closing"), "Pay <b>today</b>");
    await tap(btn(s.page, "Preview"));
    await s.page.waitForTimeout(600);
    const refusal = "Remove the < > characters from the invoice closing message — this is plain text, not HTML.";
    ok("H1 Preview refuses markup with the server's sentence", (await s.page.locator("[data-ss-email-preview]").innerText().catch(() => "")).includes(refusal));
    await tap(btn(s.page, "Save wording"));
    await s.page.waitForTimeout(600);
    ok("H2 and so does Save", (await wordingText(s.page)).includes(refusal));
    await fill(field(s.page, "closing"), "Thank you,\nThe Acme Sheds team");

    // ── F. Save ──
    await tap(kindTab(s.page, "Quote"));
    await fill(field(s.page, "button"), "  View   Shed Quote  ");
    await tap(btn(s.page, "Save wording"));
    await s.page.waitForTimeout(700);
    const saves = actions(s, "email_save_template");
    const last = saves[saves.length - 1] || {};
    ok("F1 Save sends every tab's wording", !!last.copy && !!last.copy.quote && !!last.copy.invoice &&
      last.copy.quote.closing === "Questions? Just reply to this email.\nWe deliver Monday to Saturday." && last.copy.quote.picture === false &&
      last.copy.invoice.button === "Sign Invoice {number}" && last.copy.invoice.closing === "Thank you,\nThe Acme Sheds team", JSON.stringify(last.copy));
    ok("F2 and says Saved.", /\bSaved\.$/m.test(await wordingText(s.page)) || (await wordingText(s.page)).includes("Saved."));
    ok("F3 the boxes show what the server kept (spaces tidied)", (await val(field(s.page, "button"))) === "View Shed Quote", await val(field(s.page, "button")));
    ok("F4 the closing keeps its line break", (await val(field(s.page, "closing"))) === "Questions? Just reply to this email.\nWe deliver Monday to Saturday.");
    await shotOf(s.page, "[data-ss-email-wording]", "F-saved.png");

    ok("J1 nothing on this screen sent an email", SENDS.every((a) => actions(s, a).length === 0), JSON.stringify(s.calls.map((c) => c.action)));
    await s.ctx.close();
  }

  // ── D3. No style photo switched on for quotes ─────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "no-photo", photo: false, saved: null });
    await tap(kindTab(s.page, "Quote"));
    await tap(btn(s.page, "Preview"));
    await s.page.waitForTimeout(800);
    const t = await s.page.locator("[data-ss-email-preview]").innerText().catch(() => "");
    ok("D3 no usable style photo: the preview says where to add one", /none of your styles has a photo with “Image on estimate” ticked/.test(t) && /Settings → Structures/.test(t), t.slice(0, 200));
    ok("B4 with nothing saved, every box is empty and the photo box ticked",
      (await val(field(s.page, "button"))) === "" && (await val(field(s.page, "closing"))) === "" && (await checked(field(s.page, "picture"))));
    await s.ctx.close();
  }

  // ── D4. Ticked style photos, all copied from another account ─────────────────────────────────
  {
    const s = await scenario(browser, { name: "not-own-photo", photo: "not_own", saved: null });
    await tap(kindTab(s.page, "Quote"));
    await tap(btn(s.page, "Preview"));
    await s.page.waitForTimeout(800);
    const t = await s.page.locator("[data-ss-email-preview]").innerText().catch(() => "");
    ok("D4 photos copied from another account: the preview says to upload them again, not that none is ticked",
      /your style photos were copied from another account, so they can't go in emails\. Upload them again under Settings → Structures\./.test(t)
        && !/none of your styles has a photo/.test(t), t.slice(0, 240));
    await s.ctx.close();
  }

  // ── G. An older server's save drops the new fields and still says ok ──────────────────────────
  {
    const s = await scenario(browser, { name: "old-save", server: "old-save", saved: null });
    await tap(kindTab(s.page, "Quote"));
    await fill(field(s.page, "subject"), "Your quote {number}");
    await fill(field(s.page, "closing"), "See you soon.");
    await fill(field(s.page, "button"), "View Shed Quote");
    await setCheck(field(s.page, "picture"), false);
    await tap(btn(s.page, "Save wording"));
    await s.page.waitForTimeout(700);
    const t = await wordingText(s.page);
    ok("G1 it says which fields weren't kept, not \"Saved.\"",
      t.includes("Saved, but this server build didn't keep your closing message, button text and photo setting, so your emails use ours there for now. Tell CSM Synergy.") && !/(^|\n)Saved\.(\n|$)/.test(t), t.slice(-300));
    ok("G2 and leaves what was typed in the boxes", (await val(field(s.page, "closing"))) === "See you soon." && (await val(field(s.page, "button"))) === "View Shed Quote");
    await shotOf(s.page, "[data-ss-email-wording]", "G-old-server-save.png");
    await s.ctx.close();
  }

  // ── I. An older server with no Preview ────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "old", server: "old" });
    await tap(btn(s.page, "Preview"));
    await s.page.waitForTimeout(700);
    const t = await s.page.locator("[data-ss-email-preview]").innerText().catch(() => "");
    ok("I1 an older server's \"Unrecognised action\" becomes a plain sentence", t.includes("Preview isn't available on this server yet. Tell CSM Synergy.") && !/Unrecognised/.test(t), t);
    await s.ctx.close();
  }

  // ── K. A phone's width ────────────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "narrow", viewport: { width: 390, height: 844 } });
    const before = await s.page.evaluate(() => document.documentElement.scrollWidth);
    await tap(kindTab(s.page, "Quote"));
    await setCheck(field(s.page, "picture"), true);
    await tap(btn(s.page, "Preview"));
    await s.page.locator("[data-ss-email-preview] iframe").waitFor({ timeout: 8000 }).catch(() => {});
    await s.page.waitForTimeout(600);
    const fit = await s.page.evaluate(() => {
      const ed = document.querySelector("[data-ss-email-wording]");
      const f = document.querySelector("[data-ss-email-preview] iframe");
      if (!ed || !f) return null;
      const r = ed.getBoundingClientRect(), fr = f.getBoundingClientRect();
      return { edRight: r.right, frameRight: fr.right, vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth };
    });
    ok("K1 at 390px the editor and the preview fit, and add no sideways scroll",
      !!fit && fit.frameRight <= fit.vw && fit.edRight <= fit.vw && fit.sw <= Math.max(before, fit.vw), JSON.stringify({ ...fit, before }));
    await s.page.locator("[data-ss-email-preview]").scrollIntoViewIfNeeded().catch(() => {});
    await s.page.screenshot({ path: join(shots, "K-narrow.png") });
    await s.ctx.close();
  }

  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\nemailTemplateEditor: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
