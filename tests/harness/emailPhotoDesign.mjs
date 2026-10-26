// The PHOTO-HEADER design in the email wording editor (Settings → Email Settings → Your wording →
// Design), driven for real on the COMPILED portal (2026-10-14). Carolyn: "I really want that
// template inside Structure Studio for sending out the quote. It has a nice truck on it."
//
//   P1. the estimate tabs open on Classic: no photo boxes, the opening line shows
//   P2. "Photo header" shows the top photo, heading, message, slogan, signature, banner and colours,
//       and hides the opening line; the invoice tab has no Design switch at all
//   P3. uploading a top photo calls email_upload_image (which: "hero") with the picture, and the
//       thumbnail shows the address that came back
//   P4. while that upload is in flight, Save and Preview wait (a save in between would say "Saved."
//       without the photo)
//   P5. Preview sends the photo design (layout, hero, words) and draws it: the photo, the heading with
//       the sample customer's first name, the slogan's script words, the signature name
//   P6. Save sends the same and says "Saved."; a colour picked comes back lowercase with no
//       "didn't keep" warning
//   P7. switching back to Classic hides the photo boxes and saves no layout, keeping the words
//   P8. at a phone's width, with every photo box open, the editor adds no sideways scroll
//   Z.  no uncaught page errors, and nothing on this screen sends an email
//
// The stub answers save and preview with the REAL rules and the REAL email (it imports
// _shared/emailTemplates.ts), and the upload with a made-up address in this builder's folder. Supabase
// is stubbed at the network layer; nothing leaves the machine and NOTHING IS SENT.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/emailPhotoDesign.mjs        (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead: against the portal
// before the photo design, P1-P7 fail. Fixtures are obviously fake (example.test, a made-up tenant).
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

const STORAGE = `https://${REF}.supabase.co/storage/v1/object/public`;
const LOGO = `${STORAGE}/branding/${CLIENT}/logo.svg`;
const HERO = `${STORAGE}/branding/${CLIENT}/email-hero-00000000-0000-4000-8000-0000000000aa.png`;
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="90"><rect width="340" height="90" rx="12" fill="#14532D"/><text x="170" y="57" font-family="Arial" font-size="34" font-weight="700" fill="#FFF" text-anchor="middle">ACME SHEDS</text></svg>`;
// A 1x1 PNG, the picture the "builder" picks.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const BIZ = { business_name: "Acme Sheds", business_logo_url: LOGO, business_phone: "5555550100", business_website: "https://acmesheds.example.com/", quote_terms: "Good for 30 days.", invoice_in_ghl: false };
const ADDRESS = { addressLine1: "1 Barn Way", city: "Springfield", state: "MO", postalCode: "65801" };

const { ok, failed } = reporter();
const shots = shotsDir("email-photo-design");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const SENDS = ["email_send_test", "resend_quote_email", "send_invoice", "reissue_invoice", "crm_send_email", "send_change_order"];

async function scenario(browser, { name, viewport = { width: 1400, height: 1000 }, uploadDelayMs = 0 }) {
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
    if (url === LOGO) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: LOGO_SVG });
    if (url === HERO) return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
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
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: ADDRESS, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "email_status":
        return json(route, {
          clientId: CLIENT, platformReady: true, templateCopy: null, domainStatus: "verified", domain: "acmesheds.example.com",
          fromName: "Acme Sheds", fromLocal: "info", fromAddress: "info@acmesheds.example.com", verifiedAt: "2026-09-01T12:00:00Z",
          lastError: null, active: true, dnsRecords: [],
          inbound: { status: "off", domain: null, dnsRecords: [], verifiedAt: null, lastError: null, replyExample: null },
          recentSends: [],
        });
      case "email_upload_image": {
        if (uploadDelayMs) await new Promise((r) => setTimeout(r, uploadDelayMs));
        const okBody = typeof body.imageBase64 === "string" && body.imageBase64.startsWith("data:image/png;base64,") && body.which === "hero";
        return okBody ? json(route, { ok: true, url: HERO }) : json(route, { error: "bad upload body" }, 400);
      }
      case "email_save_template": {
        const r = cleanTemplateCopy(body.copy);
        return "error" in r ? json(route, { error: r.error }, 400) : json(route, { ok: true, copy: r.copy });
      }
      case "email_preview_template": {
        const kind = body.kind;
        const r = cleanTemplateCopy({ [kind]: body.copy || {} });
        if ("error" in r) return json(route, { error: r.error }, 400);
        const copy = r.copy[kind] || {};
        const out = templatePreviewEmail({
          kind, copy, businessName: BIZ.business_name, logoUrl: BIZ.business_logo_url, phone: BIZ.business_phone,
          website: BIZ.business_website, quoteTerms: BIZ.quote_terms, pictureUrl: null, styleLabel: null,
          invoiceToSign: true, address: ADDRESS,
        });
        return json(route, { ok: true, clientId: CLIENT, kind, subject: out.subject, html: out.html, photo: "none" });
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
  await page.evaluate(() => { history.pushState({}, "", "/settings/email"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await page.waitForFunction(() => document.body.innerText.includes("Send a test email"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { ctx, page, calls };
}

const tap = (loc) => loc.click({ timeout: 5000 }).then(() => true, () => false);
const fill = (loc, v) => loc.fill(v, { timeout: 3000 }).then(() => true, () => false);
const field = (page, f) => page.locator(`[data-ss-wording="${f}"]`);
const visible = (loc) => loc.first().isVisible({ timeout: 1500 }).catch(() => false);
const kindTab = (page, label) => page.locator("[data-ss-email-wording] button").filter({ hasText: new RegExp(`^${label}$`) }).first();
const btn = (page, label) => page.locator("[data-ss-email-wording] button").filter({ hasText: new RegExp(`^${label}$`) }).first();
const layoutBtn = (page, v) => page.locator(`[data-ss-wording-layout="${v}"]`).first();
const wordingText = (page) => page.locator("[data-ss-email-wording]").innerText().catch(() => "");
const actions = (s, a) => s.calls.filter((c) => c.action === a);
const PHOTO_BOXES = ["heading", "message", "tagline", "signName", "signTitle", "accent", "buttonColor"];

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
  // ── P1-P7 on a desktop ─────────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "desktop", uploadDelayMs: 2500 });
    const { page } = s;
    await tap(kindTab(page, "Estimate"));
    await page.waitForTimeout(300);
    const classicOn = await layoutBtn(page, "classic").evaluate((b) => getComputedStyle(b).color === "rgb(255, 255, 255)").catch(() => false);
    const noPhotoBoxes = !(await visible(field(page, "heading"))) && !(await visible(page.locator("[data-ss-email-image]")));
    ok("P1 the Estimate tab opens on Classic, with no photo boxes and the opening line showing",
      classicOn && noPhotoBoxes && await visible(field(page, "intro")), `classicOn=${classicOn} noPhotoBoxes=${noPhotoBoxes}`);

    await tap(layoutBtn(page, "photo"));
    await page.waitForTimeout(300);
    const shown = [];
    for (const f of PHOTO_BOXES) if (await visible(field(page, f))) shown.push(f);
    const images = await page.locator("[data-ss-email-image]").evaluateAll((els) => els.map((e) => e.getAttribute("data-ss-email-image"))).catch(() => []);
    ok("P2 Photo header shows the top photo, heading, message, slogan, signature, banner and both colours, and hides the opening line",
      shown.length === PHOTO_BOXES.length && images.join(",") === "hero,footer" && !(await visible(field(page, "intro"))),
      `shown=${shown.join(",")} images=${images.join(",")}`);

    // P3/P4: pick a picture; while the (delayed) upload runs, Save and Preview wait.
    const input = page.locator('[data-ss-email-image="hero"] input[type="file"]');
    await input.setInputFiles({ name: "truck.png", mimeType: "image/png", buffer: PNG }).catch(() => {});
    await page.waitForTimeout(600);
    const saveBusy = await page.locator("[data-ss-email-wording] button").filter({ hasText: /Uploading picture/ }).first().isDisabled({ timeout: 1500 }).catch(() => false);
    const previewBusy = await btn(page, "Preview").isDisabled({ timeout: 1500 }).catch(() => false);
    ok("P4 while the picture uploads, Save and Preview wait", saveBusy && previewBusy, `saveBusy=${saveBusy} previewBusy=${previewBusy}`);
    await page.waitForFunction((u) => [...document.querySelectorAll('[data-ss-email-image="hero"] img')].some((i) => i.src === u), HERO, { timeout: 8000 }).catch(() => {});
    const up = actions(s, "email_upload_image");
    const thumb = await page.locator('[data-ss-email-image="hero"] img').first().getAttribute("src", { timeout: 2000 }).catch(() => null);
    ok("P3 the upload went to email_upload_image as the top photo, and the thumbnail shows what came back",
      up.length === 1 && up[0].which === "hero" && thumb === HERO, `uploads=${up.length} which=${up[0]?.which} thumb=${thumb}`);

    await fill(field(page, "heading"), "We're getting closer, {first}");
    await fill(field(page, "message"), "Hi {first},\n\nHere is the estimate for your new shed!\n\n**Click Accept to move this order forward!**");
    await fill(field(page, "button"), "VIEW SHED ESTIMATE");
    await fill(field(page, "tagline"), "EVERYONE NEEDS *a little space* IN THEIR LIFE");
    await fill(field(page, "signName"), "Pat Miller");
    await fill(field(page, "signTitle"), "Owner/Manager");
    // What the browser's colour picker does: set the value, then fire input (React's onChange).
    await field(page, "accent").evaluate((el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, "#1e40af").catch(() => {});
    await page.waitForTimeout(200);

    await tap(btn(page, "Preview"));
    await page.waitForFunction(() => !!document.querySelector("[data-ss-email-preview] iframe"), null, { timeout: 10000 }).catch(() => {});
    const pv = actions(s, "email_preview_template").pop() || {};
    const srcdoc = await page.locator("[data-ss-email-preview] iframe").first().getAttribute("srcdoc").catch(() => "") || "";
    ok("P5 Preview sends the photo design and draws it: the photo, the heading with the first name, the slogan, the signature",
      pv.copy?.layout === "photo" && pv.copy?.hero === HERO && srcdoc.includes(`src="${HERO}"`)
        && srcdoc.includes("We&#39;re getting closer, Alex</h2>") && srcdoc.includes(">a little space</span>")
        && srcdoc.includes(">Pat Miller</p>") && srcdoc.includes(">VIEW SHED ESTIMATE</a>") && srcdoc.includes("1 Barn Way, Springfield, MO 65801"),
      `layout=${pv.copy?.layout} hero=${pv.copy?.hero === HERO}`);
    const pvText = await page.locator("[data-ss-email-preview]").first().innerText().catch(() => "");
    ok("P5b with a top photo of its own, the preview says nothing about a missing building photo",
      !/No building photo/.test(pvText), pvText.slice(0, 160));
    const frame = page.locator("[data-ss-email-preview]").first();
    await frame.scrollIntoViewIfNeeded().catch(() => {});
    await frame.screenshot({ path: join(shots, "P5-preview.png") }).catch(() => {});

    await tap(btn(page, "Save wording"));
    await page.waitForFunction(() => document.querySelector("[data-ss-email-wording]")?.innerText.includes("Saved."), null, { timeout: 8000 }).catch(() => {});
    const sv = actions(s, "email_save_template").pop() || {};
    const q = sv.copy?.quote || {};
    const t = await wordingText(page);
    const accentNow = await field(page, "accent").inputValue({ timeout: 2000 }).catch(() => null);
    ok("P6 Save sends the photo design and says Saved., with the picked colour kept (no \"didn't keep\")",
      q.layout === "photo" && q.hero === HERO && q.signName === "Pat Miller" && /Saved\./.test(t) && !/didn't keep/.test(t) && accentNow === "#1e40af",
      `layout=${q.layout} accent sent=${q.accent} shown=${accentNow} msg=${/Saved\./.test(t)}`);
    await page.locator("[data-ss-email-wording]").first().screenshot({ path: join(shots, "P6-editor.png") }).catch(() => {});

    await tap(layoutBtn(page, "classic"));
    await page.waitForTimeout(300);
    const hidden = !(await visible(field(page, "heading"))) && await visible(field(page, "intro"));
    await tap(btn(page, "Save wording"));
    await page.waitForTimeout(800);
    const sv2 = actions(s, "email_save_template").pop() || {};
    ok("P7 back to Classic: the photo boxes hide, no layout is saved, and the words are kept",
      hidden && sv2.copy?.quote?.layout === "" && /Saved\./.test(await wordingText(page)),
      `hidden=${hidden} layout sent=${JSON.stringify(sv2.copy?.quote?.layout)}`);

    await tap(kindTab(page, "Invoice"));
    await page.waitForTimeout(300);
    ok("P2b the invoice tab has no Design switch", !(await visible(page.locator("[data-ss-email-design]"))));
    ok("Z1 nothing on this screen sent an email", !s.calls.some((c) => SENDS.includes(c.action)), JSON.stringify(s.calls.map((c) => c.action)));
    await s.ctx.close();
  }

  // ── P8 at a phone's width, every photo box open ──────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "phone", viewport: { width: 390, height: 844 } });
    const { page } = s;
    await tap(kindTab(page, "Estimate"));
    await tap(layoutBtn(page, "photo"));
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: innerWidth }));
    ok("P8 at 390px the photo boxes add no sideways scroll", m.sw <= m.vw, JSON.stringify(m));
    await page.screenshot({ path: join(shots, "P8-phone.png"), fullPage: false }).catch(() => {});
    await s.ctx.close();
  }
  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}
console.log(`\nshots: ${shots}`);
if (failed().length) { console.log("SOME CHECKS FAILED"); process.exit(1); }
console.log("all checks held");
