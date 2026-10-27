// Settings → Text Messaging for a business with NO EIN (sole proprietor), driven for real on the
// COMPILED portal (2026-10-27). The route ships dark: portal-sms sends `soleProprietorAvailable`
// from client_settings.sms_sole_prop (migration 342), off for every builder until an operator
// flips it, and a builder with an EIN must see exactly the screens they saw before.
//
// What it proves, each against the artifact the browser actually loads:
//   A. Switch OFF, the builder answers No: today's refusal box, word for word, the old form under
//      it, no no-EIN form, and nothing is saved.
//   B. Switch ON, the builder answers No: the "Texting without an EIN" box (who qualifies, one
//      number, ~3,000 a day, 1,000 to T-Mobile, the YES text from +1 (915) 278-2000 within 24
//      hours), the no-EIN form (no EIN, business type, legal business name, job title or role;
//      website optional), the reworded "cannot check" card, and Save posts save_intake with
//      hasEin:false, legalBusinessName "First Last", the E.164 mobile and no EIN-only keys.
//   C. A reload of a registration already filed without an EIN opens on "No" and the no-EIN form
//      by itself; Submit sends the same clean intake on `advance`; and an operator switching the
//      route off brings back today's refusal box.
//   D. brand_pending, brand APPROVED, identity UNVERIFIED: the Reply-YES card (sender, 24 hours,
//      30 days), no "nothing for you to do" line; "Text me again" posts resend_otp once, is greyed
//      with the time during the cooldown, comes back on its own when it ends; VERIFIED, or a
//      brand still PENDING, shows no card.
//   E. A builder WITH an EIN: the intake, the hints and brand_pending look as before (EIN field
//      present, no no-EIN box, no Reply-YES card for an LVS brand), and a brand refused with 30701
//      or a campaign with 30914 shows Twilio's own description, not the no-EIN help. With
//      SS_LVS_BASELINE=<the portal.app.compiled.js from before this change>, it also renders a run
//      of LVS screens under both artifacts (those two refusals among them) and requires the Text
//      Messaging view's HTML to be identical, screen by screen.
//   F. A sole proprietor refused: 30701 on the status card and 30914 on the campaign card get the
//      no-EIN help (SOLE_PROP_ERROR_HELP), and the shared codes keep theirs.
//
// portal-sms and the rest of Supabase are STUBS at the network layer (no login, nothing leaves the
// machine): nothing is registered, nothing is bought, no text is sent, no Twilio call is made.
//
//   python -m http.server 8150 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8150 node tests/harness/smsSoleProp.mjs   (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/sms-sole-prop (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an older
// portal.app.compiled.js> serves that file instead, which is how to prove the checks can fail:
// against the artifact before this change, B, C, D and F fail (a "No" is always refused, the form
// forgets the answer on reload, there is no Reply-YES card and no no-EIN help), while A and E hold.
//
// Fixtures are made up ("Pat Example", example.test, 555-01xx), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "pat-example-sheds";
const COMPANY = "Pat Example Sheds";
const DISCLOSURE = `https://${REF}.supabase.co/functions/v1/sms-optin-disclosure?client=${CLIENT}`;
const PRIVACY = "https://pat.example.test/privacy";
const TERMS = "https://pat.example.test/terms";
const LIMITS = { numbers: 1, dailyTMobile: 1000, dailyTotalApprox: 3000, otpSender: "+19152782000", otpHours: 24, verifyWithinDays: 30 };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000003", aud: "authenticated", role: "authenticated", email: "pat@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const AREAS = ["designer", "designs", "contacts", "inventory", "orders", "change_orders", "change_order_approve", "build_schedule",
  "delivery_schedule", "repairs", "commissions", "reports", "phone", "settings_structures", "settings_options", "settings_branding",
  "settings_crm", "settings_quickbooks", "settings_email", "settings_team", "settings_billing"];
const OWNER_ACCESS = Object.fromEntries(AREAS.map((k) => [k, "edit"]));

const COPY = {
  description: "Pat Example texts customers who asked for a quote, about their quote, the delivery day and the build.",
  messageFlow: "Customers tick an unticked, optional box on the quote form to agree to texts from Pat Example.",
  messageSamples: ["Pat Example: Hi [Name], your quote is ready. Reply STOP to opt out.", "Pat Example: Hi [Name], we deliver on [Date]. Reply STOP to opt out."],
};

// What portal-sms's view() sends, with the four keys the no-EIN route added (soleProprietorAvailable,
// identityStatus, otpResendAvailableAt, soleProprietorLimits). Defaults are a builder with an EIN and
// the switch off: every builder today.
function smsView(over = {}) {
  return {
    status: "none", brandTier: "low_volume_standard", needsAttention: false, attentionNote: null,
    brandStatus: null, campaignStatus: null, errors: [], brandUpdatesLeft: 3, campaignRetriesLeft: 3, mockBrand: false,
    intake: { legalBusinessName: "", einLast4: "", websiteUrl: "", privacyPolicyUrl: "", termsUrl: "" },
    copy: { description: "", messageFlow: "", messageSamples: ["", ""] }, suggestedCopy: null,
    aupAcceptedAt: null, aupText: "I confirm.", numbers: [],
    businessTypes: ["Limited Liability Corporation", "Corporation"], jobPositions: ["CEO", "Director"], configured: true,
    optInDisclosureUrl: DISCLOSURE, compliance: { checkedAt: null, checks: [] },
    soleProprietorAvailable: false, identityStatus: null, otpResendAvailableAt: null, soleProprietorLimits: LIMITS,
    ...over,
  };
}

const { ok, failed } = reporter();
const shots = shotsDir("sms-sole-prop");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

/** One fresh browser context per scenario. `state.sms` is what portal-sms answers; `state.on[action]`
 *  plays the server's side of an action before the answer (the stub never registers anything).
 *  `calls` is every portal-sms body. `artifact` overrides the compiled portal served. */
async function scenario(browser, { name, sms, on = {}, artifact = process.env.SS_PORTAL_ARTIFACT || null }) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  const calls = [];
  const state = { sms, on };
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (url.includes("/portal-sms")) {
      calls.push(body);
      const act = body.action || "status";
      if (typeof state.on[act] === "function") state.on[act](body, state);
      return json(route, { ok: true, ...state.sms });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    if (body.action === "status") {
      return json(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER_ACCESS, prefs: null,
        phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: COMPANY }, emailReady: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  if (artifact) {
    const src = readFileSync(artifact, "utf8");
    await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
  }
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(700);
  await page.evaluate((p) => { history.pushState({}, "", p + window.location.search); window.dispatchEvent(new PopStateEvent("popstate")); }, "/settings/sms");
  await page.waitForFunction(() => [...document.querySelectorAll("h3")].some((h) => /^Text messaging/.test(h.textContent || "")), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
  return { ctx, page, calls, state, dialogs };
}

const tap = (loc, opts = {}) => loc.click({ timeout: 5000, ...opts }).then(() => true, () => false);
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const refresh = async (page) => { await tap(page.locator("button").filter({ hasText: /^Refresh$/ }).first()); await page.waitForTimeout(900); };
const einBtn = (page, yes) => page.locator("button").filter({ hasText: yes ? /^Yes$/ : /^No$/ }).first();
// Which EIN answer is showing as chosen: the chosen button carries the 2px accent border.
const einChosen = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].filter((x) => /^(Yes|No)$/.test((x.textContent || "").trim()));
  const on = b.find((x) => getComputedStyle(x).borderTopWidth === "2px");
  return on ? on.textContent.trim() : null;
});
// Every form label on the Text Messaging view (SmsField: <label><div>Label</div>…</label>).
const labels = (page) => page.evaluate(() => [...document.querySelectorAll("label")]
  .map((l) => (l.firstElementChild && l.firstElementChild.tagName === "DIV" ? l.firstElementChild.textContent.trim() : ""))
  .filter(Boolean));
// The hint under a field, by its label.
const hintOf = (page, label) => page.evaluate((lbl) => {
  const l = [...document.querySelectorAll("label")].find((x) => x.firstElementChild && x.firstElementChild.textContent.trim() === lbl);
  if (!l) return null;
  const divs = [...l.children].filter((c) => c.tagName === "DIV");
  return divs.length > 1 ? divs[divs.length - 1].textContent.trim() : "";
}, label);
const field = (page, label, n = 0) => page.locator(`xpath=//label[div[1][normalize-space(.)="${label}"]]`).locator("input, select, textarea").nth(n);
const text = (page) => page.evaluate(() => document.body.innerText);
// Today's refusal box, read back as text (null when absent). Located by its heading, not by any
// attribute, because its markup must not change.
const refusalText = (page) => page.evaluate(() => {
  const h = [...document.querySelectorAll("div")].find((d) => d.children.length === 0 && (d.textContent || "").trim() === "We can’t set this up without an EIN yet");
  return h ? h.parentElement.innerText : null;
});
const REFUSAL = "We can’t set this up without an EIN yet Registering a business with no tax ID goes through a different carrier process, and we haven’t built it. If your business does have an EIN, answer “Yes” above. If it genuinely doesn’t, get in touch and we’ll tell you where it stands — please don’t fill the rest of this in, it won’t save.";
const NOTHING_TO_DO = /Nothing for you to do/;
const EIN_ONLY_LABELS = ["EIN", "Business type", "Legal business name", "Job title", "Role"];
const SOLE_LABELS = ["Legal first name", "Legal last name", "Email", "Your mobile number", "Street address", "City", "State / ZIP", "Website (optional)", "Privacy policy page", "Terms page"];
const smsActions = (calls) => calls.map((c) => c.action || "status");
// The status card's short list of carrier reasons (one <li> per error), read as text.
const errorItems = (page) => page.evaluate(() => [...document.querySelectorAll("ul li")].map((li) => (li.textContent || "").trim()));
// SOLE_PROP_ERROR_HELP's titles for 30701 and 30914 (portal/11-sms.jsx).
const SOLE_30701_TITLE = "Some of your details were not in a shape the carriers accept";
const SOLE_30914_TITLE = "Your texts have to go out under your own name";
const shot = (page, file) => page.screenshot({ path: join(shots, file), fullPage: true }).catch(() => {});

async function fillSoleForm(page) {
  await field(page, "Legal first name").fill("Pat");
  await field(page, "Legal last name").fill("Example");
  await field(page, "Email").fill("pat@example.test");
  await field(page, "Your mobile number").fill("(555) 555-0142");
  await field(page, "Street address").fill("1 Example Road");
  await field(page, "City").fill("Springfield");
  await field(page, "State / ZIP", 0).fill("mo");
  await field(page, "State / ZIP", 1).fill("65801");
}

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  // ── A. Switch off, answer No ──────────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "A", sms: smsView() });
    ok("A0 an EIN builder opens on Yes, as before", (await einChosen(s.page)) === "Yes", await einChosen(s.page));
    await tap(einBtn(s.page, false));
    await s.page.waitForTimeout(300);
    const r = await refusalText(s.page);
    ok("A1 answering No shows today's refusal box, word for word", norm(r) === REFUSAL, norm(r).slice(0, 160));
    ok("A2 and no no-EIN box or form", (await s.page.locator("[data-ss-sms-sole-intro], [data-ss-sms-sole-form], [data-ss-sms-sole-cannot-check]").count()) === 0);
    const l = await labels(s.page);
    ok("A3 the old form stays under it: legal business name and job fields, EIN and business type hidden as before",
      l.includes("Legal business name") && l.includes("Job title") && l.includes("Role") && l.includes("Work email") && !l.includes("EIN") && !l.includes("Business type"), l.join(" | "));
    ok("A4 the old 'cannot check' card about the IRS letter is still there", /Your business name exactly as the IRS has it/.test(await text(s.page)));
    ok("A5 nothing was saved", smsActions(s.calls).every((a) => a === "status"), smsActions(s.calls).join(","));
    await shot(s.page, "A-switch-off-refusal.png");
    await s.ctx.close();
  }

  // ── B. Switch on, answer No, fill in and save ─────────────────────────────────────────────
  {
    const s = await scenario(browser, {
      name: "B", sms: smsView({ soleProprietorAvailable: true }),
      on: {
        // The server's save_intake for a sole proprietor: tier, the "First Last" echo, policy URLs.
        save_intake: (b, st) => {
          st.sms = smsView({ ...st.sms, status: "aup_pending", brandTier: b.hasEin ? "low_volume_standard" : "sole_proprietor",
            intake: { legalBusinessName: (b.intake && b.intake.legalBusinessName) || "", einLast4: "", websiteUrl: (b.intake && b.intake.websiteUrl) || "",
              privacyPolicyUrl: b.privacyPolicyUrl || "", termsUrl: b.termsUrl || "" } });
        },
      },
    });
    await tap(einBtn(s.page, false));
    await s.page.waitForTimeout(300);
    const intro = norm(await s.page.locator("[data-ss-sms-sole-intro]").innerText().catch(() => ""));
    const introShown = ok("B1 answering No shows the 'Texting without an EIN' box", /^Texting without an EIN/.test(intro), intro.slice(0, 80));
    ok("B2 it says who qualifies: no EIN, not an LLC or corporation, US or Canada",
      /no EIN/.test(intro) && /not an LLC or a corporation/.test(intro) && /US or Canada/.test(intro), intro.slice(0, 220));
    ok("B3 it gives the limits from the server: one number, about 3,000 a day, 1,000 a day to T-Mobile",
      /One phone number/.test(intro) && /about 3,000 texts a day/.test(intro) && /1,000 a day to T-Mobile/.test(intro));
    ok("B4 and the YES text: from +1 (915) 278-2000, reply within 24 hours, after the paid step",
      /After the paid step/.test(intro) && intro.includes("+1 (915) 278-2000") && /reply YES/.test(intro) && /within 24 hours/.test(intro));
    ok("B5 today's refusal box is gone", (await refusalText(s.page)) === null);
    const l = await labels(s.page);
    ok("B6 no EIN, business type, legal business name, job title or role fields", EIN_ONLY_LABELS.every((x) => !l.includes(x)), l.join(" | "));
    ok("B7 the no-EIN form has the person, mobile, address, optional website and both policy pages", SOLE_LABELS.every((x) => l.includes(x)),
      SOLE_LABELS.filter((x) => !l.includes(x)).join(", ") || "all present");
    const mob = await hintOf(s.page, "Your mobile number");
    ok("B8 the mobile hint says your own mobile, not Twilio/VoIP/Google Voice, and a YES text (not a code)",
      /own mobile/.test(mob || "") && /Twilio, VoIP or Google Voice/.test(mob || "") && /reply YES/.test(mob || "") && !/code/.test(mob || ""), mob);
    ok("B9 the email hint says a personal address is fine", /personal address is fine/.test((await hintOf(s.page, "Email")) || ""));
    const pageText = await text(s.page);
    ok("B10 the 'cannot check' card no longer talks about the IRS letter; it talks about having no EIN",
      !/IRS/.test(pageText) && (await s.page.locator("[data-ss-sms-sole-cannot-check]").count()) === 1 && /really has no EIN/.test(pageText));
    if (introShown) await shot(s.page, "B-sole-form.png");

    if (l.includes("Legal first name")) {
      await fillSoleForm(s.page);
      await field(s.page, "Privacy policy page").fill(PRIVACY);
      await field(s.page, "Terms page").fill(TERMS);
      await tap(s.page.locator("button").filter({ hasText: /^Save details$/ }).first());
      await s.page.waitForTimeout(1200);
    }
    const saves = s.calls.filter((c) => c.action === "save_intake");
    const sv = saves[0] || {};
    const it = sv.intake || {};
    ok("B11 Save posts exactly one save_intake with hasEin:false", saves.length === 1 && sv.hasEin === false, JSON.stringify(saves).slice(0, 200));
    ok("B12 legalBusinessName is the person, 'Pat Example', with the names, email and E.164 mobile",
      it.legalBusinessName === "Pat Example" && it.repFirstName === "Pat" && it.repLastName === "Example" && it.repEmail === "pat@example.test" && it.repPhone === "+15555550142",
      JSON.stringify(it));
    ok("B13 the address, country US and an empty (optional) website go with it",
      it.street === "1 Example Road" && it.city === "Springfield" && it.region === "MO" && it.postalCode === "65801" && it.isoCountry === "US" && it.websiteUrl === "");
    ok("B14 the policy pages ride at the top level, as save_intake reads them", sv.privacyPolicyUrl === PRIVACY && sv.termsUrl === TERMS);
    ok("B15 and no EIN-only key is sent at all (ein, businessType, job title, role)",
      saves.length === 1 && ["ein", "businessType", "repBusinessTitle", "repJobPosition"].every((k) => !(k in it)), Object.keys(it).join(","));
    ok("B16 after the save, the screen stays on the no-EIN form", (await s.page.locator("[data-ss-sms-sole-form]").count()) === 1 && (await einChosen(s.page)) === "No");
    await shot(s.page, "B-saved.png");
    await s.ctx.close();
  }

  // ── C. Reload of a registration filed without an EIN ──────────────────────────────────────
  {
    const s = await scenario(browser, {
      name: "C",
      sms: smsView({ status: "ready", brandTier: "sole_proprietor", soleProprietorAvailable: true, aupAcceptedAt: "2026-10-27T00:00:00Z",
        intake: { legalBusinessName: "Pat Example", einLast4: "", websiteUrl: "", privacyPolicyUrl: PRIVACY, termsUrl: TERMS }, copy: COPY }),
    });
    ok("C1 it opens on No by itself (seeded from brandTier)", (await einChosen(s.page)) === "No", await einChosen(s.page));
    const l = await labels(s.page);
    ok("C2 with the no-EIN box and form, and no EIN field", (await s.page.locator("[data-ss-sms-sole-intro]").count()) === 1
      && l.includes("Legal first name") && !l.includes("EIN") && !l.includes("Legal business name"), l.join(" | "));
    await shot(s.page, "C-reload-no-ein.png");
    if (l.includes("Legal first name")) await fillSoleForm(s.page);
    await tap(s.page.locator("button").filter({ hasText: /^Submit to the carriers$/ }).first());
    await s.page.waitForTimeout(1200);
    const adv = s.calls.find((c) => c.action === "advance") || {};
    const it = adv.intake || {};
    ok("C3 Submit sends the same clean intake on advance: 'Pat Example', E.164 mobile, no EIN keys",
      it.legalBusinessName === "Pat Example" && it.repPhone === "+15555550142" && ["ein", "businessType", "repBusinessTitle", "repJobPosition"].every((k) => !(k in it)),
      JSON.stringify(it).slice(0, 240));
    ok("C4 a status read after it does not flip the answer back", (await einChosen(s.page)) === "No");
    // An operator switches the route off for this builder: today's refusal comes back (the answer
    // was never pressed on this page, so it still follows the tier).
    s.state.sms = smsView({ ...s.state.sms, soleProprietorAvailable: false });
    await refresh(s.page);
    ok("C5 with the switch turned off, the refusal box is back and the no-EIN form is gone",
      norm(await refusalText(s.page)) === REFUSAL && (await s.page.locator("[data-ss-sms-sole-form]").count()) === 0);
    await s.ctx.close();
  }

  // ── D. Approved, waiting on the YES text ──────────────────────────────────────────────────
  {
    const s = await scenario(browser, {
      name: "D",
      sms: smsView({ status: "brand_pending", brandTier: "sole_proprietor", soleProprietorAvailable: true, brandStatus: "APPROVED", identityStatus: "UNVERIFIED",
        aupAcceptedAt: "2026-10-27T00:00:00Z", intake: { legalBusinessName: "Pat Example", einLast4: "", websiteUrl: "", privacyPolicyUrl: PRIVACY, termsUrl: TERMS }, copy: COPY }),
      on: { resend_otp: (_b, st) => { st.sms = { ...st.sms, otpResendAvailableAt: new Date(Date.now() + 10 * 60000).toISOString() }; } },
    });
    const card = norm(await s.page.locator("[data-ss-sms-otp]").innerText().catch(() => ""));
    const shown = ok("D1 the Reply-YES card is there", /^Reply YES to Twilio’s text/.test(card), card.slice(0, 60));
    ok("D2 with the sender, the 24-hour window and the 30-day line",
      card.includes("+1 (915) 278-2000") && /within 24 hours/.test(card) && /within 30 days of registering/.test(card), card.slice(0, 400));
    ok("D3 'nothing for you to do' is not shown: this one is the builder's move", !NOTHING_TO_DO.test(await text(s.page)));
    const btn = s.page.locator("[data-ss-sms-otp-resend]");
    ok("D4 'Text me again' is ready to press", (await btn.count()) === 1 && await btn.isEnabled());
    if (shown) await shot(s.page, "D-reply-yes.png");
    await tap(btn);
    await s.page.waitForTimeout(1200);
    const resends = s.calls.filter((c) => c.action === "resend_otp");
    ok("D5 pressing it posts resend_otp, once", resends.length === 1, smsActions(s.calls).join(","));
    ok("D6 during the cooldown the button is greyed and says when", (await btn.count()) === 1 && !(await btn.isEnabled())
      && /You can ask for another one at \d{1,2}:\d{2}/.test(norm(await s.page.locator("[data-ss-sms-otp-when]").innerText().catch(() => ""))));
    await tap(btn, { timeout: 1200 });
    ok("D7 a press during the cooldown sends nothing", s.calls.filter((c) => c.action === "resend_otp").length === 1);
    await shot(s.page, "D-cooldown.png");
    // The cooldown ending brings the button back without a refresh.
    s.state.sms = { ...s.state.sms, otpResendAvailableAt: new Date(Date.now() + 3000).toISOString() };
    await refresh(s.page);
    const greyed = (await btn.count()) === 1 && !(await btn.isEnabled());
    await s.page.waitForTimeout(4000);
    ok("D8 when the cooldown runs out the button comes back on its own", greyed && await btn.isEnabled().catch(() => false), `greyed first: ${greyed}`);
    s.state.sms = { ...s.state.sms, identityStatus: "VERIFIED" };
    await refresh(s.page);
    ok("D9 once VERIFIED, the card goes", shown && (await s.page.locator("[data-ss-sms-otp]").count()) === 0);
    s.state.sms = { ...s.state.sms, brandStatus: "PENDING", identityStatus: "UNVERIFIED" };
    await refresh(s.page);
    ok("D10 a brand still PENDING shows no card, and the 'nothing for you to do' line is back",
      (await s.page.locator("[data-ss-sms-otp]").count()) === 0 && NOTHING_TO_DO.test(await text(s.page)));
    await s.ctx.close();
  }

  // ── E. A builder with an EIN: as before ───────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "E", sms: smsView() });
    const l = await labels(s.page);
    ok("E1 the EIN form as before: legal business name, EIN, business type, work email, job title and role",
      ["Legal business name", "EIN", "Business type", "Website", "Work email", "Mobile number", "Job title", "Role"].every((x) => l.includes(x)), l.join(" | "));
    ok("E2 with the old hints", (await hintOf(s.page, "Mobile number")) === "In case the carriers need to reach you."
      && (await hintOf(s.page, "Legal business name")) === "Exactly as it appears on your IRS letter.");
    ok("E3 no no-EIN box, form or card", (await s.page.locator("[data-ss-sms-sole-intro], [data-ss-sms-sole-form], [data-ss-sms-sole-cannot-check], [data-ss-sms-otp]").count()) === 0);
    await shot(s.page, "E-ein-builder.png");
    // The switch on, but the builder has an EIN: still the old form.
    s.state.sms = smsView({ soleProprietorAvailable: true });
    await refresh(s.page);
    const l2 = await labels(s.page);
    ok("E4 with the switch on and the answer Yes, it is still the EIN form", (await einChosen(s.page)) === "Yes" && l2.includes("EIN")
      && (await s.page.locator("[data-ss-sms-sole-intro]").count()) === 0);
    // An LVS brand at brand_pending, even one reporting an unverified identity, is a wait as before.
    s.state.sms = smsView({ status: "brand_pending", brandStatus: "APPROVED", identityStatus: "UNVERIFIED", aupAcceptedAt: "2026-10-27T00:00:00Z" });
    await refresh(s.page);
    const t = await text(s.page);
    ok("E5 an EIN brand at brand_pending gets no Reply-YES card and the old wording",
      (await s.page.locator("[data-ss-sms-otp]").count()) === 0 && NOTHING_TO_DO.test(t) && /The phone carriers are checking your business/.test(t));
    // The four codes the no-EIN route has help for are read ONLY for a sole proprietor. 30701 is
    // Twilio's generic "invalid input" brand refusal, so an EIN brand can get it too: the status
    // card must show Twilio's own description, as it did before 2026-10-27.
    s.state.sms = smsView({ status: "brand_failed", brandStatus: "FAILED", errors: [{ error_code: 30701, description: "X" }], aupAcceptedAt: "2026-10-27T00:00:00Z" });
    await refresh(s.page);
    const li = await errorItems(s.page);
    ok("E6 an EIN brand refused with 30701 shows Twilio's description ('X'), not the no-EIN help", li.includes("X") && !li.includes(SOLE_30701_TITLE)
      && !(await text(s.page)).includes(SOLE_30701_TITLE), li.join(" | "));
    s.state.sms = smsView({ status: "campaign_failed", errors: [{ error_code: 30914, description: "Y", fields: ["MESSAGE_SAMPLES"] }], aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY });
    await refresh(s.page);
    const t2 = await text(s.page);
    ok("E7 an EIN campaign refused with 30914 reads Twilio's description and code, with no no-EIN help",
      t2.includes("Carrier code 30914 — Y") && !t2.includes(SOLE_30914_TITLE), t2.slice(t2.indexOf("turned this one down"), t2.indexOf("turned this one down") + 300));
    await s.ctx.close();
  }

  // ── F. A sole proprietor refused: the no-EIN help ─────────────────────────────────────────
  {
    const sole = { brandTier: "sole_proprietor", soleProprietorAvailable: true, aupAcceptedAt: "2026-10-27T00:00:00Z",
      intake: { legalBusinessName: "Pat Example", einLast4: "", websiteUrl: "", privacyPolicyUrl: PRIVACY, termsUrl: TERMS }, copy: COPY };
    const s = await scenario(browser, { name: "F", sms: smsView({ ...sole, status: "brand_failed", brandStatus: "FAILED", errors: [{ error_code: 30701, description: "X" }] }) });
    const li = await errorItems(s.page);
    ok("F1 a sole proprietor's brand refused with 30701 shows the no-EIN help title on the status card", li.includes(SOLE_30701_TITLE) && !li.includes("X"), li.join(" | "));
    await shot(s.page, "F-sole-brand-failed.png");
    s.state.sms = smsView({ ...sole, status: "campaign_failed", errors: [{ error_code: 30914, description: "Y", fields: ["MESSAGE_SAMPLES"] }, { error_code: 30896, description: "Opt-in" }] });
    await refresh(s.page);
    const t = await text(s.page);
    ok("F2 a sole proprietor's campaign refused with 30914 gets the help: title, what it means, what to change",
      t.includes(SOLE_30914_TITLE) && /What to change: Where the description and the examples say who is texting/.test(t) && t.includes("Carrier code 30914") && !t.includes("Carrier code 30914 — Y"),
      t.slice(t.indexOf("turned this one down"), t.indexOf("turned this one down") + 400));
    ok("F3 and the shared help still answers the codes every tier has (30896)", /They could not verify how customers agree to be texted/.test(t));
    await shot(s.page, "F-sole-campaign-failed.png");
    await s.ctx.close();
  }

  // ── E (baseline). The same EIN screens, HTML for HTML, against the artifact from before ───
  if (process.env.SS_LVS_BASELINE) {
    const STEPS = [
      ["none", smsView()],
      ["none, switch on", smsView({ soleProprietorAvailable: true })],
      ["aup_pending", smsView({ status: "aup_pending", intake: { legalBusinessName: "Pat Example Sheds LLC", einLast4: "6789", websiteUrl: "https://pat.example.test", privacyPolicyUrl: PRIVACY, termsUrl: TERMS } })],
      ["ready", smsView({ status: "ready", aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY, intake: { legalBusinessName: "Pat Example Sheds LLC", einLast4: "6789", websiteUrl: "https://pat.example.test", privacyPolicyUrl: PRIVACY, termsUrl: TERMS } })],
      ["ready, switch on", smsView({ status: "ready", soleProprietorAvailable: true, aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY })],
      ["profile_pending", smsView({ status: "profile_pending", aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY })],
      ["brand_pending", smsView({ status: "brand_pending", brandStatus: "PENDING", aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY })],
      ["brand_pending approved+unverified", smsView({ status: "brand_pending", brandStatus: "APPROVED", identityStatus: "UNVERIFIED", aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY })],
      // An error code with no help entry before or after.
      ["brand_failed", smsView({ status: "brand_failed", brandStatus: "FAILED", errors: [{ error_code: 30791, description: "Temporary failure" }], aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY })],
      // The four codes the no-EIN route added help for (30701, 30903, 30914, 30915) live in
      // SOLE_PROP_ERROR_HELP, read only for a sole proprietor, so an EIN builder sent any of them
      // sees exactly what the artifact before showed: Twilio's own description.
      ["brand_failed 30701", smsView({ status: "brand_failed", brandStatus: "FAILED", errors: [{ error_code: 30701, description: "X" }], aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY })],
      ["brand_approved", smsView({ status: "brand_approved", brandStatus: "APPROVED", aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY })],
      ["campaign_failed", smsView({ status: "campaign_failed", errors: [{ error_code: 30896, description: "Opt-in", fields: ["MESSAGE_FLOW"] }], aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY })],
      ["campaign_failed 30903/30914/30915", smsView({ status: "campaign_failed", errors: [{ error_code: 30903, description: "A" }, { error_code: 30914, description: "Y", fields: ["MESSAGE_SAMPLES"] }, { error_code: 30915, description: "B" }], aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY })],
      ["campaign_approved", smsView({ status: "campaign_approved", aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY })],
      ["active", smsView({ status: "active", aupAcceptedAt: "2026-10-27T00:00:00Z", copy: COPY, numbers: [{ phoneNumber: "+15555550199", registrationStatus: "registered", callingOnly: false, assigned: false }] })],
    ];
    const viewHtml = (page) => page.evaluate(() => {
      const h = [...document.querySelectorAll("h3")].find((x) => /^Text messaging/.test(x.textContent || ""));
      return h ? h.parentElement.parentElement.parentElement.innerHTML : null;
    });
    const run = async (artifact, label) => {
      const s = await scenario(browser, { name: `E-baseline ${label}`, sms: STEPS[0][1], artifact });
      const out = [];
      for (const [name, v] of STEPS) {
        s.state.sms = v;
        await refresh(s.page);
        out.push([name, await viewHtml(s.page)]);
      }
      // Last: an EIN builder (switch off) answering No.
      s.state.sms = smsView();
      await refresh(s.page);
      await tap(einBtn(s.page, false));
      await s.page.waitForTimeout(300);
      out.push(["none, answered No", await viewHtml(s.page)]);
      await s.ctx.close();
      return out;
    };
    const mine = await run(process.env.SS_PORTAL_ARTIFACT || null, "current");
    const before = await run(process.env.SS_LVS_BASELINE, "baseline");
    for (let i = 0; i < mine.length; i++) {
      const [name, html] = mine[i];
      const was = before[i] && before[i][1];
      let at = -1;
      if (html !== was && html && was) { at = 0; while (at < html.length && html[at] === was[at]) at++; }
      ok(`E-B${i + 1} EIN screen "${name}" is identical to the artifact before`, !!html && html === was,
        html === was ? `${(html || "").length} chars` : (at >= 0 ? `first difference at ${at}: now …${html.slice(Math.max(0, at - 60), at + 60)}… was …${was.slice(Math.max(0, at - 60), at + 60)}…` : "missing"));
    }
  } else {
    console.log("INFO  E-B (EIN screens HTML-identical to the artifact before) skipped: set SS_LVS_BASELINE=<old portal.app.compiled.js>");
  }

  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\nsmsSoleProp: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
