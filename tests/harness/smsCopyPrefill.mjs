// Settings → Text Messaging fills in wording for a new builder, driven for real on the COMPILED
// portal (2026-10-05; Carolyn 2026-09-17: "I want it to basically prefill for them").
//
// What it proves, each against the artifact the browser actually loads:
//   P. A new builder at "Ready to submit" with nothing saved: the four boxes hold the suggestion
//      portal-sms sends (built here by the REAL suggestedCopyForRow), with the one-line note and
//      "Start blank" above them; the opt-in answer quotes the REAL tick-box sentence; both example
//      boxes are several lines and show the whole message; Submit is ready; "Add this link to my
//      answer" says the disclosure page is already in it; and nothing was sent anywhere but the
//      status read (it never submits by itself).
//   T. The builder's typing survives a refresh, and "Start blank" empties the boxes (asking first,
//      because they had edited) and they stay empty after another refresh; "Add this link" is back
//      and still works.
//   S. A builder with wording saved sees THEIR wording and no note, even from a server that also
//      sent a suggestion.
//   F. An untouched suggestion follows its facts: once the policy addresses are saved, the next
//      read fills them in; with the tick box switched off there is no suggestion at all.
//   R. Someone who can only view the page sees the saved (empty) boxes, never our wording.
//   C. The contact record's "how they gave it" note (recording a customer's permission by hand)
//      is two lines and still stops at 200 characters.
//
// portal-sms and the rest of Supabase are STUBS at the network layer (no login, nothing leaves the
// machine): no registration is submitted, nothing is bought, nothing is texted.
//
//   python -m http.server 8133 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8133 node tests/harness/smsCopyPrefill.mjs   (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/sms-copy-prefill (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an older
// portal.app.compiled.js> serves that file instead, which is how to prove the checks can fail:
// against the artifact before this change there is no note and the example boxes are one line.
//
// Fixtures are made up ("Acme Sheds", example.test, 555-01xx), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";
import { suggestedCopyForRow } from "../../supabase/functions/_shared/smsCopyTemplate.ts";
import { smsConsentSentence } from "../../supabase/functions/_shared/smsConsentText.ts";

const CLIENT = "acme-sheds";
const COMPANY = "Acme Sheds";
const CONTACT_ID = "4512ed87-fb75-4645-81d6-9268eb73e305";
const DESIGNER = `https://app.structurestudiosuite.com/?client=${CLIENT}`;
const DISCLOSURE = `https://${REF}.supabase.co/functions/v1/sms-optin-disclosure?client=${CLIENT}`;
const PRIVACY = "https://acme.example.test/privacy";
const TERMS = "https://acme.example.test/terms";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const AREAS = ["designer", "designs", "contacts", "inventory", "orders", "change_orders", "change_order_approve", "build_schedule",
  "delivery_schedule", "repairs", "commissions", "reports", "phone", "settings_structures", "settings_options", "settings_branding",
  "settings_crm", "settings_quickbooks", "settings_email", "settings_team", "settings_billing"];
const OWNER_ACCESS = Object.fromEntries(AREAS.map((k) => [k, "edit"]));
// A team member who may look at Text Messaging but not change it (settings_billing view).
const VIEWER_ACCESS = { ...Object.fromEntries(AREAS.map((k) => [k, "view"])), settings_billing: "view" };

const DESIGN = {
  short_code: "SS-TEST00001", created_at: "2026-09-17T15:00:00Z", updated_at: "2026-09-17T15:00:00Z",
  status: "sent", selections: { style: "Utility", size: "10x12" }, expected_close_date: null,
  total_cents: 512300, ghl_estimate_number: null, image_url: null, ss_quote_number: "SSQ-1001",
  ss_quote_pdf_url: null, ss_invoice_sent_at: null, ss_invoice_requested_at: null,
  contact_id: CONTACT_ID, contact: { name: "Pat Example", phone: "(555) 555-0142", email: "pat@example.test" },
};
const LIST_ROW = {
  short_code: DESIGN.short_code, created_at: DESIGN.created_at, updated_at: DESIGN.updated_at, status: "sent",
  contact: DESIGN.contact, sel_style: "utility", sel_size: "10x12", ghl_estimate_number: null, contact_id: CONTACT_ID,
};
const CONTACT = { id: CONTACT_ID, name: "Pat Example", phone: "(555) 555-0142", email: "pat@example.test", phone_digits: "5555550142", owner_user_id: null, sms_opt_out_at: null, first_seen_at: "2026-09-01T12:00:00Z" };

// What portal-sms's view() would say for a registration row, with the REAL shared rule deciding
// the suggestion. `row` is the sms_registrations row; `boxOn` is client_settings.lead_sms_consent_box.
function smsStatus({ status = "ready", row = {}, boxOn = true, forceSuggestion = null } = {}) {
  const samples = Array.isArray(row.campaign_message_samples) && row.campaign_message_samples.length >= 2 ? row.campaign_message_samples : ["", ""];
  return {
    status, brandTier: "low_volume_standard", needsAttention: false, attentionNote: null, brandStatus: null, campaignStatus: null,
    errors: [], brandUpdatesLeft: 3, campaignRetriesLeft: 3, mockBrand: false,
    intake: { legalBusinessName: "Acme Sheds LLC", einLast4: "6789", websiteUrl: "https://acme.example.test",
      privacyPolicyUrl: row.privacy_policy_url || "", termsUrl: row.terms_url || "" },
    copy: { description: row.campaign_description || "", messageFlow: row.campaign_message_flow || "", messageSamples: samples },
    suggestedCopy: forceSuggestion ?? suggestedCopyForRow(row, { companyName: COMPANY, consentBoxOn: boxOn, designerUrl: DESIGNER, disclosureUrl: DISCLOSURE }),
    aupAcceptedAt: "2026-10-01T00:00:00Z", aupText: "I confirm.", numbers: [],
    businessTypes: ["Limited Liability Corporation"], jobPositions: ["CEO"], configured: true,
    optInDisclosureUrl: DISCLOSURE, compliance: { checkedAt: null, checks: [] },
  };
}

const { ok, failed } = reporter();
const shots = shotsDir("sms-copy-prefill");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

/** One fresh browser context per scenario. `state.sms` is what portal-sms answers; change it
 *  between reads to play a server whose facts moved on. `calls` is every portal-sms body. */
async function scenario(browser, { name, sms, role = "owner", access = OWNER_ACCESS, smsConsented = true }) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    // No My Synergy Phone extension: the contact's SMS tab keeps the composer.
    try { if (window.chrome) delete window.chrome.runtime; } catch (_e) { /* read-only */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  const calls = [];
  const state = { sms };
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, false);
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role, user_id: USER.id }]);
    if (url.includes("/rest/v1/designs")) return json(route, [LIST_ROW]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (url.includes("/portal-sms")) {
      calls.push(body);
      // Every action answers with the current view; this stub never registers anything.
      return json(route, { ok: true, ...state.sms });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role, operatorMode: false, access, prefs: null,
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: COMPANY }, emailReady: true });
      case "crm_record":
        return json(route, {
          ok: true, kind: body.kind, clientId: CLIENT, contact: CONTACT, designs: [DESIGN], orders: [], feed: [], focus: [], team: [], people: [], followers: [],
          sms: { ready: true, from: "+15555550199", optedOut: false, consented: smsConsented },
          build: [], stages: [], delivery: [], repairs: [],
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
  await page.waitForTimeout(700);
  const go = async (path) => {
    await page.evaluate((p) => { history.pushState({}, "", p + window.location.search); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
    await page.waitForTimeout(1200);
  };
  return { ctx, page, calls, go, state, dialogs };
}

const tap = (loc, opts = {}) => loc.click({ timeout: 5000, ...opts }).then(() => true, () => false);
const tabBtn = (page, label) => page.locator("button").filter({ hasText: new RegExp(`^${label}$`) }).first();

// The four boxes of the copy form, by their labels.
async function readForm(page) {
  return page.evaluate(() => {
    const byLabel = (re) => {
      const l = [...document.querySelectorAll("label")].find((x) => re.test((x.firstElementChild && x.firstElementChild.textContent) || ""));
      const f = l && l.querySelector("textarea, input");
      return f ? { tag: f.tagName, value: f.value, rows: f.getAttribute("rows") } : null;
    };
    return {
      description: byLabel(/^In a sentence, what will you text customers about\?$/),
      messageFlow: byLabel(/^How do people agree to be texted\?$/),
      sample1: byLabel(/^Example message 1$/),
      sample2: byLabel(/^Example message 2$/),
    };
  });
}
// Every example box shows its whole text: nothing scrolled out of sight, sideways or down.
const samplesFit = (page) => page.evaluate(() => [...document.querySelectorAll("[data-ss-sms-sample]")].map((t) => ({
  tag: t.tagName, rows: t.getAttribute("rows"), fits: t.scrollHeight <= t.clientHeight + 1 && t.scrollWidth <= t.clientWidth + 1,
})));
const refresh = async (page) => { await tap(page.locator("button").filter({ hasText: /^Refresh$/ }).first()); await page.waitForTimeout(900); };
const NOTE = /We filled this in with wording carriers have approved before\. Check it describes your business and change anything that doesn.t\./;

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  const fullRow = { campaign_message_samples: [], privacy_policy_url: PRIVACY, terms_url: TERMS };
  const want = suggestedCopyForRow(fullRow, { companyName: COMPANY, consentBoxOn: true, designerUrl: DESIGNER, disclosureUrl: DISCLOSURE });

  // ── P + T. A new builder, nothing saved ────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "P", sms: smsStatus({ row: fullRow }) });
    await s.go("/portal/settings/sms");
    await s.page.waitForSelector("[data-ss-sms-copy-suggested]", { timeout: 15000 }).catch(() => {});
    const note = await s.page.locator("[data-ss-sms-copy-suggested]").innerText().catch(() => "");
    const shown = ok("P1 the form says the wording was filled in for them", NOTE.test(note.replace(/\s+/g, " ")), note.slice(0, 120));
    ok("P2 with a 'Start blank' link beside it", (await s.page.locator("[data-ss-sms-copy-blank]").count()) === 1);
    const f = await readForm(s.page);
    ok("P3 the four boxes hold the server's suggestion exactly",
      !!f.description && f.description.value === want.description && f.messageFlow.value === want.messageFlow
        && f.sample1.value === want.messageSamples[0] && f.sample2.value === want.messageSamples[1], JSON.stringify(f).slice(0, 200));
    ok("P4 the opt-in answer quotes the designer's tick-box sentence word for word",
      !!f.messageFlow && f.messageFlow.value.includes(`"${smsConsentSentence(COMPANY)}"`));
    ok("P5 both example messages start with the business and say how to stop",
      !!f.sample1 && [f.sample1.value, f.sample2.value].every((v) => v.startsWith(`${COMPANY}: `) && /\bSTOP\b/.test(v)));
    const fit = await samplesFit(s.page);
    ok("P6 both example boxes are several lines (textarea, 3 rows) and show the whole message",
      fit.length === 2 && fit.every((x) => x.tag === "TEXTAREA" && x.rows === "3" && x.fits), JSON.stringify(fit));
    const submit = s.page.locator("button").filter({ hasText: /^Submit to the carriers$/ }).first();
    ok("P7 Submit is ready to press (the suggestion passes the form's own checks)", (await submit.count()) === 1 && await submit.isEnabled());
    ok("P8 the 'Add this link' button says the disclosure page is already in the answer",
      (await s.page.locator('[data-ss-sms-optin-link="present"]').count()) === 1 && (await s.page.locator('[data-ss-sms-optin-link="add"]').count()) === 0);
    ok("P9 nothing was sent but the status read: it never submits by itself",
      s.calls.length > 0 && s.calls.every((c) => (c.action || "status") === "status"), JSON.stringify(s.calls.map((c) => c.action)));
    if (shown) {
      await s.page.locator("[data-ss-sms-copy-suggested]").scrollIntoViewIfNeeded().catch(() => {});
      await s.page.screenshot({ path: join(shots, "P-prefilled.png"), fullPage: true });
      const card = s.page.locator("[data-ss-sms-copy-suggested]").locator("xpath=ancestor::div[contains(@style,'border-radius: 12px')][1]");
      await card.screenshot({ path: join(shots, "P-prefilled-form.png") }).catch(() => {});
    }

    // T. Their typing wins over a refresh; then Start blank, which sticks.
    const mine = `${COMPANY}: Hi [Name], your shed is ready to pick up at the lot. Reply STOP to opt out.`;
    await s.page.locator('[data-ss-sms-sample="1"]').fill(mine).catch(() => {});
    await refresh(s.page);
    const t = await readForm(s.page);
    ok("T1 a refresh keeps what the builder typed", !!t.sample2 && t.sample2.value === mine && t.description.value === want.description, t.sample2 && t.sample2.value);
    await tap(s.page.locator("[data-ss-sms-copy-blank]"));
    await s.page.waitForTimeout(400);
    ok("T2 'Start blank' asked first, because they had changed our wording", s.dialogs.some((m) => /start with them empty/.test(m)), JSON.stringify(s.dialogs));
    const blank = await readForm(s.page);
    ok("T3 and emptied all four boxes, and the note went",
      !!blank.description && [blank.description, blank.messageFlow, blank.sample1, blank.sample2].every((x) => x.value === "")
        && (await s.page.locator("[data-ss-sms-copy-suggested]").count()) === 0);
    await refresh(s.page);
    const still = await readForm(s.page);
    ok("T4 they stay empty after another refresh", !!still.description && [still.description, still.messageFlow, still.sample1, still.sample2].every((x) => x.value === ""));
    ok("T5 Submit is greyed out again until they write their own", !(await s.page.locator("button").filter({ hasText: /^Submit to the carriers$/ }).first().isEnabled()));
    await s.page.screenshot({ path: join(shots, "T-start-blank.png"), fullPage: true });
    const add = s.page.locator('[data-ss-sms-optin-link="add"]');
    if (ok("T7 with the answer empty, 'Add this link to my answer' is back", (await add.count()) === 1)) {
      await tap(add);
      await s.page.waitForTimeout(300);
      const withLink = await readForm(s.page);
      ok("T8 and it still adds the disclosure page to the answer", !!withLink.messageFlow && withLink.messageFlow.value.includes(DISCLOSURE)
        && (await s.page.locator('[data-ss-sms-optin-link="present"]').count()) === 1, withLink.messageFlow && withLink.messageFlow.value);
    }
    ok("T9 still nothing sent but status reads", s.calls.every((c) => (c.action || "status") === "status"), JSON.stringify(s.calls.map((c) => c.action)));
    await s.ctx.close();
  }

  // ── S. A builder with wording saved ───────────────────────────────────────────────────────
  {
    const savedRow = {
      ...fullRow,
      campaign_description: "Acme Sheds texts customers who asked for a quote about their quote, delivery day and build.",
      campaign_message_flow: "Customers tick an unticked, optional box on our quote form to agree to texts from Acme Sheds.",
      campaign_message_samples: ["Acme Sheds: Hi [Name], your quote is ready. Reply STOP to opt out.", "Acme Sheds: Hi [Name], we deliver on [Date]. Reply STOP to opt out."],
    };
    // The real server sends no suggestion beside saved wording; this one does, to prove the form
    // would not take it anyway.
    const s = await scenario(browser, { name: "S", sms: smsStatus({ status: "brand_approved", row: savedRow, forceSuggestion: want }) });
    await s.go("/portal/settings/sms");
    await s.page.waitForSelector("[data-ss-sms-sample]", { timeout: 15000 }).catch(() => {});
    const f = await readForm(s.page);
    ok("S1 saved wording is what the form shows, untouched by any suggestion",
      !!f.description && f.description.value === savedRow.campaign_description && f.messageFlow.value === savedRow.campaign_message_flow
        && f.sample1.value === savedRow.campaign_message_samples[0] && f.sample2.value === savedRow.campaign_message_samples[1], JSON.stringify(f).slice(0, 200));
    ok("S2 and there is no 'we filled this in' note", (await s.page.locator("[data-ss-sms-copy-suggested]").count()) === 0);
    const sfit = await samplesFit(s.page);
    ok("S3 its example boxes are several lines too", sfit.length === 2 && sfit.every((x) => x.tag === "TEXTAREA" && x.rows === "3"), JSON.stringify(sfit));
    await s.page.screenshot({ path: join(shots, "S-saved-copy-not-overwritten.png"), fullPage: true });
    await s.ctx.close();
  }

  // ── F. The suggestion follows its facts ───────────────────────────────────────────────────
  {
    const early = { campaign_message_samples: [] };
    const s = await scenario(browser, { name: "F", sms: smsStatus({ row: early }) });
    await s.go("/portal/settings/sms");
    await s.page.waitForSelector("[data-ss-sms-copy-suggested]", { timeout: 15000 }).catch(() => {});
    const before = await readForm(s.page);
    ok("F1 with no policy addresses saved, the opt-in answer names none", !!before.messageFlow && !/Privacy Policy/.test(before.messageFlow.value), before.messageFlow && before.messageFlow.value.slice(-200));
    s.state.sms = smsStatus({ row: fullRow });
    await refresh(s.page);
    const after = await readForm(s.page);
    ok("F2 once they are saved, the next read fills them in (the boxes were untouched)",
      !!after.messageFlow && after.messageFlow.value === want.messageFlow && after.messageFlow.value.includes(PRIVACY) && after.messageFlow.value.includes(TERMS));
    // The tick box switched off: the real rule suggests nothing, and the untouched wording goes.
    s.state.sms = smsStatus({ row: fullRow, boxOn: false });
    await refresh(s.page);
    const off = await readForm(s.page);
    ok("F3 with the tick box switched off there is no suggestion, and the untouched one is cleared",
      s.state.sms.suggestedCopy === null && !!off.description && [off.description, off.messageFlow, off.sample1, off.sample2].every((x) => x.value === "")
        && (await s.page.locator("[data-ss-sms-copy-suggested]").count()) === 0);
    await s.ctx.close();
  }

  // ── R. Someone who can only look ──────────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "R", role: "user", access: VIEWER_ACCESS, sms: smsStatus({ row: fullRow }) });
    await s.go("/portal/settings/sms");
    await s.page.waitForSelector("[data-ss-sms-sample]", { timeout: 15000 }).catch(() => {});
    const f = await readForm(s.page);
    const drawn = ok("R0 a viewer reaches the read-only form", !!f.description, await s.page.evaluate(() => location.pathname));
    if (drawn) {
      ok("R1 they see the saved (empty) wording, not ours, and no note",
        [f.description, f.messageFlow, f.sample1, f.sample2].every((x) => x.value === "") && (await s.page.locator("[data-ss-sms-copy-suggested]").count()) === 0);
    }
    await s.ctx.close();
  }

  // ── C. The record page's consent note ─────────────────────────────────────────────────────
  {
    const s = await scenario(browser, { name: "C", sms: smsStatus(), smsConsented: false });
    await s.go(`/portal/contacts/c-${CONTACT_ID}`);
    await s.page.waitForFunction(() => document.body.innerText.includes("SUMMARY"), null, { timeout: 20000 }).catch(() => {});
    await s.page.waitForTimeout(400);
    await s.page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /Utility 10x12/.test(x.innerText || ""));
      if (b) b.click();
    });
    await s.page.waitForTimeout(500);
    await tap(tabBtn(s.page, "SMS"));
    await s.page.waitForTimeout(500);
    await tap(s.page.locator("button").filter({ hasText: /They already gave permission/ }).first());
    await s.page.waitForTimeout(300);
    const note = s.page.locator("[data-ss-consent-note]");
    const there = ok("C1 'record it' opens a note box", (await note.count()) === 1);
    if (there) {
      const a = await note.evaluate((t) => ({ tag: t.tagName, rows: t.getAttribute("rows"), max: t.getAttribute("maxlength") }));
      ok("C2 the 'how they gave it' note is two lines and still stops at 200 characters", a.tag === "TEXTAREA" && a.rows === "2" && a.max === "200", JSON.stringify(a));
      await note.fill("Asked us at the lot on 12 Aug while looking at the 10x12.\nWants texts about the delivery day.");
      const v = await note.inputValue();
      ok("C3 a two-line note keeps both lines", v.includes("\n") && v.length <= 200, JSON.stringify(v));
      await note.locator("xpath=..").screenshot({ path: join(shots, "C-consent-note.png") }).catch(() => {});
    }
    await s.ctx.close();
  }

  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\nsmsCopyPrefill: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
