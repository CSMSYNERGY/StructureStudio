// Customer login on the public designer (plan 3.3, Carolyn 2026-09-14): the lead gate IS the
// login, a code never blocks designing (Ahsan 2026-09-15), and the header grows Log in /
// Enter your code / Signed in as · Quotes · Invoices · Sign out. The account panel (cards, Review &
// Accept, Sign invoice, deep links, saved designs) and the refresh-keeps-the-design autosave are
// covered below the login cases.
//
// ⚠️ EVERY WRITE IS STUBBED with page.route — capture-lead, customer-auth, customer-quotes,
// every non-get_ RPC (save_design, log_error…) and storage uploads — so this runs against beta
// or a local static server without texting anyone, filing a lead, or writing a design. Only the
// config/catalog READS reach Supabase. Do not loosen the rpc filter below: a real customer-auth
// request_code sends an SMS.
//
//   PW_BASE_URL=http://localhost:8126 npx playwright test tests/e2e/customer-login.spec.mjs
//
// PW_SHOTS=<dir> also saves screenshots of each state (for Carolyn's review).
import { test, expect } from "@playwright/test";
import { CLIENT, watchConsole } from "./helpers.mjs";

// 555-01xx is reserved for fiction, so even a stub that leaked could never reach a person.
const PHONE10 = "5550104477";
const PHONE_SHOWN = "(555) 010-4477";
const TOKEN = "tok-e2e-customer-login";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
// The carrier-required disclosure, clause by clause (the company name varies by tenant).
const CONSENT_RE = /^By checking this box, you agree that .+ may send you text messages about your quote and your building\. Message frequency varies\. Message and data rates may apply\. Reply STOP to opt out at any time\.$/;

// Chrome logs EVERY non-2xx fetch as a console error. The refusals these tests stub on purpose
// (login_options' "Unknown action" 400, a wrong code's 401, texting's 503) are the scenario,
// not a fault, so only those resource lines are dropped — any script error still fails a test.
// net::ERR_FAILED is the aborted customer-designs call — how the browser sees that function
// before it is deployed (its CORS preflight 404s).
const pageErrors = (errors) => errors.filter((e) => !/^Failed to load resource: (the server responded with a status of (400|401|409|503)\b|net::ERR_FAILED)/.test(e));

async function shot(page, name) {
  if (!process.env.PW_SHOTS) return;
  await page.screenshot({ path: `${process.env.PW_SHOTS}/${name}.png` });
}

// Routes every backend write to a stub and records what the page sent. `o` overrides a
// response per action; a function receives the request body (and may await, to hold a
// request in flight).
async function stubBackend(page, o = {}) {
  const calls = [];
  const respond = async (spec, body) => (typeof spec === "function" ? spec(body) : spec);
  await page.route(/\/functions\/v1\/[a-z0-9-]+/, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS, body: "ok" });
    const fn = req.url().match(/\/functions\/v1\/([a-z0-9-]+)/)[1];
    let body = {};
    try { body = req.postDataJSON() || {}; } catch (_e) { /* not JSON */ }
    calls.push({ fn, action: body.action || null, body });
    let res = { status: 200, body: { ok: true } };
    if (fn === "customer-auth") {
      if (body.action === "login_options") res = await respond(o.loginOptions || { status: 400, body: { error: "Unknown action" } }, body);
      else if (body.action === "request_code") res = await respond(o.requestCode || { status: 200, body: { ok: true } }, body);
      else if (body.action === "verify_code") res = await respond(o.verifyCode || { status: 200, body: { ok: true, token: TOKEN, name: "Pat Tester" } }, body);
    } else if (fn === "customer-quotes") {
      res = await respond(o.quotes || { status: 200, body: { ok: true, quotes: [] } }, body);
    } else if (fn === "customer-accept") {
      res = await respond(o.accept || { status: 200, body: { ok: true } }, body);
    } else if (fn === "customer-designs") {
      // Not deployed yet by default: the browser's CORS preflight fails, which is an abort.
      if (!o.designs) return route.abort("failed");
      res = await respond(o.designs, body);
    }
    return route.fulfill({ status: res.status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(res.body) });
  });
  // Reads (get_config, get_catalog, …) pass through; anything else is a write and is stubbed.
  await page.route(/\/rest\/v1\/rpc\/(?!get_)[a-z0-9_]+/, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS, body: "ok" });
    let body = {};
    try { body = req.postDataJSON() || {}; } catch (_e) { /* not JSON */ }
    const name = req.url().match(/\/rpc\/([a-z0-9_]+)/)[1];
    calls.push({ fn: "rpc:" + name, action: null, body });
    const spec = o.rpc && o.rpc[name];
    const res = spec ? await respond(spec, body) : { status: 200, body: null };
    return route.fulfill({ status: res.status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(res.body) });
  });
  await page.route(/\/storage\/v1\/object\//, (route) =>
    route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ Key: "stub" }) }));
  return calls;
}

const authCall = (calls, action) => calls.find((c) => c.fn === "customer-auth" && c.action === action);
const ls = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

async function boot(page, path = `/?client=${CLIENT}`) {
  await page.goto(path);
  await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function");
  await expect(page.locator("svg").filter({ hasText: /ft/ }).first()).toBeVisible();
}

// Working the canvas is what pops the gate: arming any tool does it.
async function armATool(page) {
  await page.getByRole("button", { name: /Workbench|Loft Area|Window wall$/ }).first().click();
}

async function fillGateDetails(sheet) {
  await sheet.getByPlaceholder("Your name").fill("Pat Tester");
  await sheet.getByPlaceholder("(555) 555-5555").fill(PHONE10);
}

// Pre-signs the browser in, the way a verified code (or /my-quotes) leaves it.
async function seedSession(page, { phone = PHONE10, email = null } = {}) {
  await page.addInitScript(({ id, token, phone, email }) => {
    try {
      localStorage.setItem("ss_gate_" + id, "1");
      localStorage.setItem("ss_gate_name_" + id, "Pat Tester");
      localStorage.setItem("ssq_token_" + id, token);
      if (phone) localStorage.setItem("ssq_phone_" + id, phone);
      if (email) localStorage.setItem("ssq_email_" + id, email);
    } catch (_e) { /* storage blocked — the test will say so */ }
  }, { id: CLIENT, token: TOKEN, phone, email });
}

test("the gate is the login: design unlocks before the code, and the code can wait", async ({ page }) => {
  const errors = watchConsole(page);
  let release;
  const held = new Promise((r) => { release = r; });
  const calls = await stubBackend(page, {
    requestCode: async () => { await held; return { status: 200, body: { ok: true } }; },
  });
  await boot(page);
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  await shot(page, "01-header-signed-out");

  await armATool(page);
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Log in to design your building")).toBeVisible();
  await expect(sheet.getByText("We'll text you a code — keep designing while it arrives.")).toBeVisible();
  await expect(sheet.getByText(CONSENT_RE)).toBeVisible();
  await expect(sheet.getByRole("checkbox")).not.toBeChecked();   // TCPA: never pre-ticked
  // The live function predates login_options ("Unknown action") → text only, no choice shown.
  await expect.poll(() => Boolean(authCall(calls, "login_options"))).toBe(true);
  await expect(sheet.getByRole("group", { name: "Send my code by" })).toHaveCount(0);
  await fillGateDetails(sheet);
  await shot(page, "02-sheet-details");
  await sheet.getByRole("button", { name: "Log in →" }).click();

  // request_code is still held open, and the design is ALREADY unlocked.
  await expect.poll(() => Boolean(authCall(calls, "request_code"))).toBe(true);
  expect(await ls(page, "ss_gate_" + CLIENT)).toBe("1");
  const lead = calls.find((c) => c.fn === "capture-lead");
  expect(lead, "capture-lead fired").toBeTruthy();
  // The payload the gate always sent — no more, no less.
  expect(Object.keys(lead.body).sort()).toEqual(["clientId", "consentText", "consentUrl", "name", "phone", "smsConsent"]);
  expect(lead.body).toMatchObject({ clientId: CLIENT, name: "Pat Tester", smsConsent: false, consentText: null });
  expect(calls.indexOf(lead)).toBeLessThan(calls.indexOf(authCall(calls, "request_code")));
  expect(authCall(calls, "request_code").body).toMatchObject({ clientId: CLIENT, phone: "+1" + PHONE10, name: "Pat Tester" });
  expect(authCall(calls, "request_code").body.channel).toBeUndefined();

  release();
  await expect(sheet.getByText("Enter your code")).toBeVisible();
  await expect(sheet.getByText(`We texted a 6-digit code to ${PHONE_SHOWN}.`)).toBeVisible();
  await expect(sheet.locator("#ss-login-code")).toHaveAttribute("autocomplete", "one-time-code");
  await expect(sheet.getByRole("button", { name: /^Send again \(\d+s\)$/ })).toBeDisabled();
  await shot(page, "03-sheet-code");
  await sheet.getByRole("button", { name: "Keep designing, I'll enter it later" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enter your code" })).toBeVisible();
  await shot(page, "04-header-code-pending");

  // Designing is not blocked: arming a tool no longer opens anything.
  await armATool(page);
  await page.waitForTimeout(300);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(authCall(calls, "verify_code")).toBeFalsy();
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("entering the code signs in: header, read-only phone, Quotes/Invoices, Sign out", async ({ page }) => {
  const errors = watchConsole(page);
  const calls = await stubBackend(page, {
    quotes: { status: 200, body: { ok: true, quotes: [{ quoteRef: "SS-AAAA1111" }, { quoteRef: "SS-BBBB2222", invoice: { number: "INV-1" } }, { quoteRef: "SS-CCCC3333", invoiceRequest: { status: "pending" } }] } },
    verifyCode: (b) => (b.code === "123456"
      ? { status: 200, body: { ok: true, token: TOKEN, name: "Pat Tester" } }
      : { status: 401, body: { error: "That code didn't match — check and try again." } }),
  });
  await boot(page);
  await armATool(page);
  const sheet = page.getByRole("dialog");
  await fillGateDetails(sheet);
  await sheet.getByRole("button", { name: "Log in →" }).click();
  await sheet.getByRole("button", { name: "Keep designing, I'll enter it later" }).click();

  // Reopened from the pill, the sheet goes straight to the code — no second text.
  await page.getByRole("button", { name: "Enter your code" }).click();
  await expect(sheet.getByText(`We texted a 6-digit code to ${PHONE_SHOWN}.`)).toBeVisible();
  expect(calls.filter((c) => c.fn === "customer-auth" && c.action === "request_code")).toHaveLength(1);

  // A wrong code shows the SERVER's sentence (read off error.context) and is not "session expired".
  await sheet.locator("#ss-login-code").fill("111111");
  await expect(sheet.getByRole("alert")).toHaveText("That code didn't match — check and try again.");
  await expect(sheet.getByText(/session expired/i)).toHaveCount(0);

  // Six digits submit on their own.
  await sheet.locator("#ss-login-code").fill("123456");
  await expect(sheet).toHaveCount(0);
  const verified = calls.filter((c) => c.fn === "customer-auth" && c.action === "verify_code").pop();
  expect(verified.body).toMatchObject({ clientId: CLIENT, phone: "+1" + PHONE10, code: "123456" });

  await expect(page.getByText(`Signed in as ${PHONE_SHOWN}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Quotes", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invoices", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter your code" })).toHaveCount(0);
  expect(await ls(page, "ssq_token_" + CLIENT)).toBe(TOKEN);
  expect(await ls(page, "ssq_phone_" + CLIENT)).toBe(PHONE10);
  await shot(page, "05-header-signed-in");

  // Get Quote needs no code, but a verified phone is the contact and cannot be retyped.
  const phoneField = page.locator('input[type="tel"][readonly]');
  await expect(phoneField).toHaveCount(1);
  await expect(phoneField).toHaveValue(PHONE_SHOWN);
  await expect(page.getByText("Phone * ✓ verified")).toBeVisible();

  await page.getByRole("button", { name: "Quotes", exact: true }).click();
  const quotesPanel = page.getByRole("region", { name: "Your quotes" });
  await expect(quotesPanel.getByRole("button", { name: "Quotes · 1" })).toBeVisible();
  await expect(quotesPanel.locator("[data-ref]")).toHaveCount(1);
  const listCall = calls.filter((c) => c.fn === "customer-quotes").pop();
  expect(listCall.body).toMatchObject({ action: "list", token: TOKEN, clientId: CLIENT });
  await page.getByRole("button", { name: "Invoices", exact: true }).click();
  const invoicesPanel = page.getByRole("region", { name: "Your invoices" });
  await expect(invoicesPanel.getByRole("button", { name: "Invoices · 2" })).toBeVisible();
  await expect(invoicesPanel.locator("[data-ref]")).toHaveCount(2);
  await shot(page, "06-invoices-panel");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  await expect(page.getByText(/Signed in as/)).toHaveCount(0);
  expect(await ls(page, "ssq_token_" + CLIENT)).toBeNull();
  expect(await ls(page, "ssq_phone_" + CLIENT)).toBeNull();
  expect(await ls(page, "ss_gate_" + CLIENT)).toBeNull();
  expect(authCall(calls, "logout").body).toMatchObject({ token: TOKEN });
  await expect(page.locator('input[type="tel"][readonly]')).toHaveCount(0);
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("login_options offers Text | Email, and the email route sends the code by email", async ({ page }) => {
  const errors = watchConsole(page);
  const calls = await stubBackend(page, {
    loginOptions: { status: 200, body: { ok: true, channels: ["sms", "email"], defaultChannel: "sms" } },
  });
  await boot(page);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  const sheet = page.getByRole("dialog");
  const choice = sheet.getByRole("group", { name: "Send my code by" });
  await expect(choice).toBeVisible();
  await choice.getByRole("button", { name: "Email" }).click();
  await expect(sheet.getByText("We'll email you a code — keep designing while it arrives.")).toBeVisible();
  await fillGateDetails(sheet);                                   // the gate still takes the lead's phone
  await sheet.getByPlaceholder("you@example.com").fill("Pat@Example.com");
  await sheet.getByRole("checkbox").check();
  await shot(page, "07-sheet-email-choice");
  await sheet.getByRole("button", { name: "Log in →" }).click();
  await expect(sheet.getByText("We emailed a 6-digit code to pat@example.com.")).toBeVisible();

  const lead = calls.find((c) => c.fn === "capture-lead");
  expect(lead.body.smsConsent).toBe(true);
  expect(lead.body.consentText).toMatch(CONSENT_RE);              // the sentence, verbatim, as shown
  expect(lead.body.email).toBeUndefined();                        // payload unchanged
  expect(authCall(calls, "request_code").body).toMatchObject({ channel: "email", email: "pat@example.com" });
  expect(authCall(calls, "request_code").body.phone).toBeUndefined();

  await sheet.locator("#ss-login-code").fill("654321");
  await expect(page.getByText("Signed in as pat@example.com")).toBeVisible();
  expect(authCall(calls, "verify_code").body).toMatchObject({ channel: "email", email: "pat@example.com", code: "654321" });
  expect(await ls(page, "ssq_email_" + CLIENT)).toBe("pat@example.com");
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("texting unavailable (503) says so kindly, and Get Quote still works without a code", async ({ page }) => {
  const errors = watchConsole(page);
  const calls = await stubBackend(page, {
    requestCode: { status: 503, body: { error: "Sign-in by text isn't available yet." } },
  });
  await boot(page);
  await armATool(page);
  const sheet = page.getByRole("dialog");
  await fillGateDetails(sheet);
  await sheet.getByRole("button", { name: "Log in →" }).click();
  await expect(sheet.getByText("We couldn't text you a code right now — you can keep designing and still get your quote.")).toBeVisible();
  await shot(page, "08-sheet-unavailable");
  await sheet.getByRole("button", { name: "Keep designing →" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enter your code" })).toHaveCount(0);   // nothing was sent
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();

  // Get Quote runs its own checks (or saves) — it never asks for a code.
  const before = calls.length;
  await page.getByRole("button", { name: "Get Quote", exact: true }).click();
  await expect.poll(async () =>
    calls.slice(before).some((c) => c.fn === "rpc:save_design")
    || (await page.getByText(/^Please (fill in|select|place)/).count()) > 0,
  ).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("a 401 on a signed-in call clears the session and reopens the sheet", async ({ page }) => {
  const errors = watchConsole(page);
  await seedSession(page);
  const calls = await stubBackend(page, { quotes: { status: 401, body: { error: "Session expired — sign in again." } } });
  await boot(page);
  await expect(page.getByText(`Signed in as ${PHONE_SHOWN}`)).toBeVisible();
  await page.getByRole("button", { name: "Quotes", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Your session expired. Enter your number and we'll text you a new code.")).toBeVisible();
  await expect(sheet.getByText("Log in", { exact: true })).toBeVisible();   // login mode: the gate was already passed
  expect(calls.some((c) => c.fn === "customer-quotes" && c.body.token === TOKEN)).toBe(true);
  expect(await ls(page, "ssq_token_" + CLIENT)).toBeNull();
  await shot(page, "09-sheet-session-expired");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("a session carried over from /my-quotes learns who it is, and the phone header fits a phone", async ({ page }) => {
  const errors = watchConsole(page);
  await seedSession(page, { phone: null });        // /my-quotes stores the token only
  const calls = await stubBackend(page, { quotes: { status: 200, body: { ok: true, name: "Pat Tester", quotes: [], identity: { phone: PHONE10 } } } });
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await expect(page.getByText(`Signed in as ${PHONE_SHOWN}`)).toBeVisible();
  expect(calls.some((c) => c.fn === "customer-quotes" && c.body.action === "list")).toBe(true);
  expect(await ls(page, "ssq_phone_" + CLIENT)).toBe(PHONE10);
  // The HEADER must fit. Measured on the header alone, not the page: the Submit Bar's Get Quote
  // button already pokes 17px past a 390px viewport on beta before this change (min-width 160
  // beside Floorplan PDF), and that belongs to the layout work, not to the account corner.
  const headerOverflow = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const powered = [...document.querySelectorAll("div")].find((d) => d.textContent === "Powered by Structure Studio");
    const header = powered && powered.parentElement;
    if (!header) return 999;
    return Math.max(0, ...[...header.querySelectorAll("*")].map((el) => el.getBoundingClientRect().right - vw));
  });
  expect(headerOverflow, "the signed-in header fits a 390px phone").toBeLessThanOrEqual(1);
  await shot(page, "10-header-signed-in-390");
  expect(pageErrors(errors), "console errors").toEqual([]);
});

// ── The account panel (plan 3.3: CustomerAccount) ─────────────────────────────────────────────
// Fixtures shaped exactly like customer-quotes list (SS mode). The consent sentences are the
// SERVER's strings — the panel must print these, never compose its own.
const ACCEPT_SENTENCE = "I accept quote JB-1041 for $10,505.14 and understand that my builder will send me an invoice to sign.";
const SIGN_SENTENCE = "I agree that my electronic signature is as binding as a handwritten one, and I accept invoice INV-2001 for $8,200.00.";
const SS_BASE = { pdfUrl: null, acceptUrl: null, ssQuote: true, view3dImageUrl: null, changeOrders: [], invoice: null, invoiceRequest: null,
  canAccept: false, canSignInvoice: false, acceptedAt: null, acceptConsentText: null, signConsentText: null };
function quoteFixtures() {
  return [
    { ...SS_BASE, quoteRef: "SS-ACCEPT0001", estimateNumber: "JB-1041", style: "lofted barn", size: "12x20", status: "sent", createdAt: "2026-09-10T15:00:00Z",
      total: 10505.14, canAccept: true, acceptConsentText: ACCEPT_SENTENCE },
    { ...SS_BASE, quoteRef: "SS-INVOICE002", estimateNumber: "JB-1042", style: "utility", size: "10x12", status: "accepted", createdAt: "2026-09-01T15:00:00Z",
      total: 8200, acceptedAt: "2026-09-02T15:00:00Z", canSignInvoice: true, signConsentText: SIGN_SENTENCE,
      invoice: { number: "INV-2001", pdfUrl: null, sentAt: "2026-09-03T15:00:00Z", signedAt: null, stale: false, amountDue: 8200 } },
    { ...SS_BASE, quoteRef: "SS-PREPARE003", estimateNumber: "JB-1043", status: "accepted", createdAt: "2026-09-04T15:00:00Z", total: 5000,
      acceptedAt: "2026-09-05T15:00:00Z", invoiceRequest: { status: "pending", requestedAt: "2026-09-05T15:00:00Z" } },
    { ...SS_BASE, quoteRef: "SS-STALE00004", estimateNumber: "JB-1044", status: "accepted", createdAt: "2026-08-20T15:00:00Z", total: 5000,
      acceptedAt: "2026-08-21T15:00:00Z", invoice: { number: "INV-1990", pdfUrl: null, signedAt: null, stale: true, amountDue: 5150 } },
    { ...SS_BASE, quoteRef: "SS-DISMISS005", estimateNumber: "JB-1045", status: "accepted", createdAt: "2026-08-10T15:00:00Z", total: 3000,
      acceptedAt: "2026-08-11T15:00:00Z", invoiceRequest: { status: "dismissed", requestedAt: "2026-08-11T15:00:00Z" } },
    { ...SS_BASE, quoteRef: "SS-CHANGE0006", estimateNumber: "JB-1046", status: "invoiced", createdAt: "2026-07-10T15:00:00Z", total: 2800,
      acceptedAt: "2026-07-11T15:00:00Z", invoice: { number: "INV-1900", pdfUrl: null, signedAt: "2026-07-12T15:00:00Z", stale: false, amountDue: 2800 },
      changeOrders: [{ id: "0b8f6f0e-6a55-4c1e-9a8e-3b1f6d2a7c11", coNo: 3, description: "Add a window\nTotal: $2,800.00 -> $3,100.00", totalBefore: 2800, totalAfter: 3100,
        feeCents: 15000, feeTaxCents: 0, feeLabel: "Change order fee", newTotal: 3250, createdAt: "2026-07-20T15:00:00Z" }] },
  ];
}
const listBody = (quotes) => ({ status: 200, body: { ok: true, businessName: "Test Barns", name: "Pat Tester", ssMode: true, identity: { phone: PHONE10 }, quotes } });

test("Quotes and Invoices: cards, Review & Accept sends the click acceptance, every invoice state reads right", async ({ page }) => {
  const errors = watchConsole(page);
  await seedSession(page);
  let quotes = quoteFixtures();
  const calls = await stubBackend(page, {
    quotes: () => listBody(quotes),
    // Accepting flips the fixture the way the server would: accepted, an invoice request pending.
    accept: (b) => {
      if (b.action === "accept_quote") quotes = quotes.map((q) => (q.quoteRef === b.quoteRef
        ? { ...q, status: "accepted", canAccept: false, acceptedAt: "2026-09-15T12:00:00Z", invoiceRequest: { status: "pending", requestedAt: "2026-09-15T12:00:00Z" } } : q));
      return { status: 200, body: { ok: true, acceptedAt: "2026-09-15T12:00:00Z", invoiceRequested: true } };
    },
  });
  await boot(page);
  await page.getByRole("button", { name: "Quotes", exact: true }).click();
  const panel = page.getByRole("region", { name: "Your quotes" });
  await expect(panel.getByRole("button", { name: "Quotes · 1" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Invoices · 5" })).toBeVisible();
  const card = panel.locator('[data-ref="SS-ACCEPT0001"]');
  await expect(card).toContainText("JB-1041");
  await expect(card).toContainText("Lofted Barn · 12x20");
  await expect(card).toContainText("$10,505.14");
  await expect(card.getByRole("button", { name: "Open design" })).toBeVisible();
  // The function is not deployed: no Saved designs section, and nothing about it on screen.
  await expect.poll(() => calls.some((c) => c.fn === "customer-designs")).toBe(true);
  await expect(panel.getByText("Saved designs")).toHaveCount(0);

  await card.getByRole("button", { name: "Review & Accept" }).click();
  const accept = card.locator('[data-panel="accept"]');
  await expect(accept.getByText(ACCEPT_SENTENCE, { exact: true })).toBeVisible();   // the server's words
  await accept.getByRole("textbox", { name: "Your full name" }).fill("Pat Tester");
  await accept.getByRole("button", { name: "Accept Quote" }).click();
  await expect(accept.getByRole("alert")).toHaveText("Please tick the agreement box to accept.");
  expect(calls.some((c) => c.fn === "customer-accept")).toBe(false);
  await accept.getByRole("checkbox").check();
  await shot(page, "11-review-accept");
  const listsBefore = calls.filter((c) => c.fn === "customer-quotes").length;
  await accept.getByRole("button", { name: "Accept Quote" }).click();
  await expect.poll(() => calls.some((c) => c.fn === "customer-accept")).toBe(true);
  const acc = calls.find((c) => c.fn === "customer-accept");
  expect(acc.body).toEqual({ clientId: CLIENT, token: TOKEN, action: "accept_quote", quoteRef: "SS-ACCEPT0001", signerName: "Pat Tester", consent: true, method: "click" });
  // The list reloads and the accepted quote moves to Invoices with "being prepared".
  await expect.poll(() => calls.filter((c) => c.fn === "customer-quotes").length).toBeGreaterThan(listsBefore);
  await expect(panel.getByRole("button", { name: "Quotes · 0" })).toBeVisible();
  await expect(panel.getByText("No quotes yet — press Get Quote when your design is ready.")).toBeVisible();

  await panel.getByRole("button", { name: "Invoices · 6" }).click();
  const inv = page.getByRole("region", { name: "Your invoices" });
  await expect(page.getByRole("button", { name: "Invoices", exact: true })).toHaveAttribute("aria-pressed", "true");   // the header follows
  await expect(inv.locator('[data-ref="SS-ACCEPT0001"]')).toContainText("Your invoice is being prepared — you'll get it here to sign.");
  await expect(inv.locator('[data-ref="SS-ACCEPT0001"]')).toContainText("Accepted ✓");
  const ready = inv.locator('[data-ref="SS-INVOICE002"]');
  await expect(ready).toContainText("Invoice INV-2001 — ready for your signature");
  await expect(ready).toContainText("$8,200.00");
  await expect(ready.getByRole("button", { name: "Review & Sign Invoice" })).toBeVisible();
  const stale = inv.locator('[data-ref="SS-STALE00004"]');
  await expect(stale).toContainText("This invoice was issued before your latest approved change.");
  await expect(stale.getByRole("button", { name: "Review & Sign Invoice" })).toHaveCount(0);
  await expect(inv.locator('[data-ref="SS-DISMISS005"]')).toContainText("Your builder will be in touch about your invoice.");
  const co = inv.locator('[data-ref="SS-CHANGE0006"]');
  await expect(co).toContainText("Change order CO-3 — needs your approval");
  await expect(co).toContainText("+ Change order fee: $150.00");
  await expect(co).toContainText("New order total: $3,250.00");
  await expect(co.getByText(/^Total:/)).toHaveCount(0);   // the generated Total line is not printed twice
  await expect(co.getByRole("link", { name: "Review & sign the change ↗" })).toHaveAttribute("href", `/my-quotes?client=${CLIENT}&q=SS-CHANGE0006`);
  await expect(co.getByRole("link", { name: "Pay or see payments ↗" })).toHaveAttribute("href", `/my-quotes?client=${CLIENT}&q=SS-CHANGE0006`);
  await shot(page, "12-invoices-states");

  // Sign by typing: the body is sign_invoice with the typed name, and the server's sentence is shown.
  await ready.getByRole("button", { name: "Review & Sign Invoice" }).click();
  const sign = ready.locator('[data-panel="sign"]');
  await expect(sign.getByText(SIGN_SENTENCE, { exact: true })).toBeVisible();
  await sign.getByRole("button", { name: "Type my name" }).click();
  await sign.getByRole("textbox", { name: "Your full name", exact: true }).fill("Pat Tester");
  await sign.getByRole("checkbox").check();
  await sign.getByRole("button", { name: "Sign Invoice" }).click();
  await expect(sign.getByRole("alert")).toHaveText("Type your name to sign.");
  await sign.getByRole("textbox", { name: "Type your full name" }).fill("Pat Tester");
  await sign.getByRole("button", { name: "Sign Invoice" }).click();
  await expect.poll(() => calls.some((c) => c.fn === "customer-accept" && c.action === "sign_invoice")).toBe(true);
  expect(calls.find((c) => c.action === "sign_invoice").body).toEqual({ clientId: CLIENT, token: TOKEN, action: "sign_invoice", quoteRef: "SS-INVOICE002",
    signerName: "Pat Tester", consent: true, method: "typed", typedName: "Pat Tester" });
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("a deep link lands on its card and opens the panel; a drawn signature sends the PNG", async ({ page }) => {
  const errors = watchConsole(page);
  await seedSession(page);
  const calls = await stubBackend(page, { quotes: () => listBody(quoteFixtures()) });
  // account=quotes names the wrong tab on purpose: the card lives under Invoices, and the panel moves there.
  await boot(page, `/?client=${CLIENT}&account=quotes&q=SS-INVOICE002`);
  const inv = page.getByRole("region", { name: "Your invoices" });
  const ready = inv.locator('[data-ref="SS-INVOICE002"]');
  const sign = ready.locator('[data-panel="sign"]');
  await expect(sign).toBeVisible();
  await expect(sign.getByText(SIGN_SENTENCE, { exact: true })).toBeVisible();
  const pad = sign.getByLabel("Signature pad");
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 90, { steps: 8 });
  await page.mouse.move(box.x + 220, box.y + 50, { steps: 8 });
  await page.mouse.up();
  await sign.getByRole("textbox", { name: "Your full name", exact: true }).fill("Pat Tester");
  await sign.getByRole("checkbox").check();
  await shot(page, "13-deep-link-sign");
  await sign.getByRole("button", { name: "Sign Invoice" }).click();
  await expect.poll(() => calls.some((c) => c.action === "sign_invoice")).toBe(true);
  const body = calls.find((c) => c.action === "sign_invoice").body;
  expect(body).toMatchObject({ action: "sign_invoice", quoteRef: "SS-INVOICE002", method: "drawn", consent: true, signerName: "Pat Tester", token: TOKEN });
  expect(body.signatureDataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]{200,}$/);
  expect(body.typedName).toBeUndefined();

  // A bare ?q= opens Quotes and Review & Accept for that card.
  await boot(page, `/?client=${CLIENT}&q=SS-ACCEPT0001`);
  const quotes = page.getByRole("region", { name: "Your quotes" });
  await expect(quotes.locator('[data-ref="SS-ACCEPT0001"] [data-panel="accept"]')).toBeVisible();
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("a 401 while accepting signs out and reopens the sheet", async ({ page }) => {
  const errors = watchConsole(page);
  await seedSession(page);
  const calls = await stubBackend(page, {
    quotes: () => listBody(quoteFixtures()),
    accept: { status: 401, body: { error: "Session expired — sign in again." } },
  });
  await boot(page, `/?client=${CLIENT}&q=SS-ACCEPT0001`);
  const accept = page.getByRole("region", { name: "Your quotes" }).locator('[data-panel="accept"]');
  await accept.getByRole("textbox", { name: "Your full name" }).fill("Pat Tester");
  await accept.getByRole("checkbox").check();
  await accept.getByRole("button", { name: "Accept Quote" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Your session expired. Enter your number and we'll text you a new code.")).toBeVisible();
  expect(calls.find((c) => c.fn === "customer-accept").body.token).toBe(TOKEN);
  expect(await ls(page, "ssq_token_" + CLIENT)).toBeNull();
  await expect(page.getByRole("region", { name: "Your quotes" })).toHaveCount(0);
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("saved designs: listed under Quotes when the function exists, Open loads the draft, Remove hides it", async ({ page }) => {
  const errors = watchConsole(page);
  await seedSession(page);
  const DRAFT = "SS-SAVEDAB234";
  let hidden = false;
  const calls = await stubBackend(page, {
    quotes: () => listBody([]),
    designs: (b) => (b.action === "list"
      ? { status: 200, body: { ok: true, designs: hidden ? [] : [{ ref: DRAFT, style: "utility", size: "10x12", updatedAt: "2026-09-14T15:00:00Z" }] } }
      : { status: 200, body: { ok: true } }),
    rpc: { load_design: () => ({ status: 200, body: [{ short_code: DRAFT, client_id: CLIENT, status: "draft", selections: {}, items: [], paint_colors: {}, custom_options: [], ro_dimensions: {},
      contact: { name: "Pat Tester", phone: PHONE_SHOWN, email: "", street: "9 Saved Way", city: "", state: "", zip: "" } }] }) },
  });
  await boot(page);
  await page.getByRole("button", { name: "Quotes", exact: true }).click();
  const panel = page.getByRole("region", { name: "Your quotes" });
  const row = panel.locator(`[data-saved-ref="${DRAFT}"]`);
  await expect(panel.getByText("Saved designs")).toBeVisible();
  await expect(row).toContainText("Utility 10x12");
  expect(calls.find((c) => c.fn === "customer-designs").body).toMatchObject({ action: "list", clientId: CLIENT, token: TOKEN });
  await shot(page, "14-saved-designs");

  await row.getByRole("button", { name: "Open" }).click();
  await expect(panel).toHaveCount(0);                                       // the panel closes onto the canvas
  await expect(page.getByPlaceholder("123 Main St")).toHaveValue("9 Saved Way");
  expect(await ls(page, "ss_draft_" + CLIENT)).toBe(DRAFT);                 // a draft becomes the refresh pointer
  await expect(page.getByRole("status").filter({ hasText: "Your saved design is open" })).toBeVisible();

  await page.getByRole("button", { name: "Quotes", exact: true }).click();
  hidden = true;
  await panel.locator(`[data-saved-ref="${DRAFT}"]`).getByRole("button", { name: "Remove" }).click();
  await expect(panel.locator(`[data-saved-ref="${DRAFT}"]`)).toHaveCount(0);
  expect(calls.find((c) => c.fn === "customer-designs" && c.action === "hide").body).toMatchObject({ action: "hide", code: DRAFT, token: TOKEN, clientId: CLIENT });
  expect(pageErrors(errors), "console errors").toEqual([]);
});

// ── Refresh keeps the design (plan 3.3 autosave) ───────────────────────────────────────────────
test("autosave leaves a pointer on the way out, a reload restores that draft, and a sent one is let go", async ({ page }) => {
  const errors = watchConsole(page);
  await seedSession(page);
  let saved = null;
  let rowStatus = "draft";
  const calls = await stubBackend(page, {
    designs: { status: 200, body: { ok: true } },
    rpc: {
      save_design: (b) => { saved = b; return { status: 200, body: null }; },
      load_design: (b) => ({ status: 200, body: saved && b.p_code === saved.p_code
        ? [{ short_code: saved.p_code, client_id: CLIENT, status: rowStatus, selections: saved.p_selections, items: saved.p_items, paint_colors: saved.p_paint_colors,
          custom_options: saved.p_custom_options, ro_dimensions: saved.p_ro_dimensions, contact: { ...saved.p_contact, street: "12 Restore Lane" } }]
        : [] }),
    },
  });
  await boot(page);
  await page.getByPlaceholder("Full Name").fill("Pat Tester");
  await page.locator("select").filter({ has: page.locator("option", { hasText: "Select a size…" }) }).selectOption("8x10");
  await page.waitForTimeout(400);
  expect(calls.some((c) => c.fn === "rpc:save_design")).toBe(false);          // 20 s debounce: nothing yet
  // The tab goes to the background (what a phone does instead of pagehide): flush now.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => saved && saved.p_code).toMatch(/^SS-[A-Z0-9]{10}$/);
  expect(saved).toMatchObject({ p_client_id: CLIENT, p_status: "draft", p_image_url: null });
  expect(saved.p_selections.size).toBe("8x10");
  expect(saved.p_contact).toMatchObject({ name: "Pat Tester", phone: PHONE_SHOWN });   // the verified phone, locked
  await expect.poll(() => ls(page, "ss_draft_" + CLIENT)).toBe(saved.p_code);
  // Signed in, so the draft is linked to the login once (plan 3.6).
  await expect.poll(() => calls.filter((c) => c.fn === "customer-designs" && c.action === "link").length).toBe(1);
  expect(calls.find((c) => c.action === "link").body).toMatchObject({ code: saved.p_code, token: TOKEN, clientId: CLIENT });

  const saves = () => calls.filter((c) => c.fn === "rpc:save_design").length;
  await page.reload();
  await page.waitForFunction(() => window.__ssAppBooted === true);
  await expect(page.getByPlaceholder("123 Main St")).toHaveValue("12 Restore Lane");
  await expect(page.getByPlaceholder("Full Name")).toHaveValue("Pat Tester");
  expect(new URL(page.url()).searchParams.get("id")).toBeNull();               // a draft never takes the URL
  // Adopted as already saved: restoring writes nothing back.
  const afterRestore = saves();
  await page.waitForTimeout(2500);
  expect(saves()).toBe(afterRestore);
  await shot(page, "15-draft-restored");

  // Submitted meanwhile (another tab, the rep): the pointer goes and the page starts blank.
  rowStatus = "sent";
  await page.reload();
  await page.waitForFunction(() => window.__ssAppBooted === true);
  await expect.poll(() => ls(page, "ss_draft_" + CLIENT)).toBeNull();
  await expect(page.getByPlaceholder("123 Main St")).toHaveValue("");
  expect(pageErrors(errors), "console errors").toEqual([]);
});

// ── The success screen (public page) ─────────────────────────────────────────────────────────
// Drives a real Get Quote with submit-estimate, storage and save_design stubbed: the quote PDF is
// rendered and "uploaded" to the stub, and the SS-mode response is what the screen reacts to.
async function fillQuoteForm(page) {
  await page.getByText("Utility", { exact: true }).first().click();
  await page.locator("select").filter({ has: page.locator("option", { hasText: "Select a size…" }) }).selectOption({ index: 3 });
  await page.getByPlaceholder("Full Name").fill("Pat Tester");
  await page.getByPlaceholder("email@example.com").fill("pat@example.com");
  const phone = page.getByPlaceholder("(555) 555-5555");
  if (!(await phone.evaluate((el) => el.readOnly))) await phone.fill(PHONE10);
  await page.getByPlaceholder("123 Main St").fill("1 Test Way");
  await page.getByPlaceholder("City").fill("Kansas City");
  await page.locator("select").filter({ has: page.locator("option", { hasText: "Select state…" }) }).selectOption({ label: "Missouri" });
  await page.getByPlaceholder("00000").fill("64105");
  // Included items must be placed or declined before a quote goes out; decline them all.
  page.on("dialog", (d) => d.accept());
  const decline = page.locator('button[title^="Decline "]');
  for (let n = await decline.count(); n > 0; n--) {
    await decline.first().click();
    await expect(decline).toHaveCount(n - 1);
  }
}
const SUBMIT_OK = { status: 200, body: { ok: true, issuedBy: "structurestudio", quoteNumber: "JB-1050", estimateNumber: "JB-1050", quoteEmailed: true, quotePdfUrl: null } };

test("success screen: signed in, the new quote's Review & Accept is right there; Start New keeps the session", async ({ page }) => {
  const errors = watchConsole(page);
  await seedSession(page);
  let code = null;
  const calls = await stubBackend(page, {
    quotes: () => listBody(code ? [{ ...SS_BASE, quoteRef: code, estimateNumber: "JB-1050", status: "sent", total: 9000, canAccept: true,
      acceptConsentText: "I accept quote JB-1050 for $9,000.00 and understand that my builder will send me an invoice to sign." }] : []),
    rpc: { save_design: (b) => { if (b.p_image_url) code = b.p_code; return { status: 200, body: null }; }, list_design_versions: { status: 200, body: [] } },
  });
  await page.route(/\/functions\/v1\/submit-estimate/, (route) => route.request().method() === "OPTIONS"
    ? route.fulfill({ status: 200, headers: CORS, body: "ok" })
    : route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(SUBMIT_OK.body) }));
  await boot(page);
  await fillQuoteForm(page);
  await page.getByRole("button", { name: "Get Quote", exact: true }).click();
  await expect(page.getByText("Quote Created!")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("The quote has been emailed with a link to view and accept it.", { exact: false })).toBeVisible();
  const inline = page.getByRole("region", { name: "Your quote" });
  await expect(inline.locator(`[data-ref="${code}"] [data-panel="accept"]`)).toBeVisible();   // opened for them
  await expect(inline.getByText("I accept quote JB-1050 for $9,000.00", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy customer link" })).toHaveCount(0);      // the portal's button, not the shopper's
  expect(calls.find((c) => c.fn === "customer-quotes").body).toMatchObject({ action: "list", token: TOKEN });
  expect(await ls(page, "ss_draft_" + CLIENT)).toBeNull();                                  // a sent quote needs no pointer
  await inline.scrollIntoViewIfNeeded();
  await shot(page, "16-success-inline-accept");

  await page.getByRole("button", { name: "Start New Quote" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your quote JB-1050 is saved under Quotes." })).toBeVisible();
  await expect(page.getByText(`Signed in as ${PHONE_SHOWN}`)).toBeVisible();
  await expect(page.getByPlaceholder("Full Name")).toHaveValue("Pat Tester");                 // same person, new building
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("success screen: signed out, accepting asks for the code first", async ({ page }) => {
  const errors = watchConsole(page);
  await page.addInitScript((id) => { try { localStorage.setItem("ss_gate_" + id, "1"); localStorage.setItem("ss_gate_name_" + id, "Pat Tester"); } catch (_e) {} }, CLIENT);
  const calls = await stubBackend(page, { rpc: { list_design_versions: { status: 200, body: [] } } });
  await page.route(/\/functions\/v1\/submit-estimate/, (route) => route.request().method() === "OPTIONS"
    ? route.fulfill({ status: 200, headers: CORS, body: "ok" })
    : route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(SUBMIT_OK.body) }));
  await boot(page);
  await fillQuoteForm(page);
  await page.getByRole("button", { name: "Get Quote", exact: true }).click();
  await expect(page.getByText("Quote Created!")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Copy customer link" })).toHaveCount(0);
  await page.getByRole("button", { name: "Verify your phone to accept this quote" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Log in", { exact: true })).toBeVisible();
  await expect(sheet.getByPlaceholder("(555) 555-5555")).toHaveValue(PHONE_SHOWN);            // the number they just quoted with
  expect(calls.some((c) => c.fn === "customer-quotes")).toBe(false);                         // nothing account-shaped without a token
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("the account panel fits a 390px phone", async ({ page }) => {
  const errors = watchConsole(page);
  await seedSession(page);
  await stubBackend(page, { quotes: () => listBody(quoteFixtures()) });
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, `/?client=${CLIENT}&account=invoices&q=SS-INVOICE002`);
  const panel = page.getByRole("region", { name: "Your invoices" });
  await expect(panel.locator('[data-ref="SS-INVOICE002"] [data-panel="sign"]')).toBeVisible();
  const overflow = await panel.evaluate((root) => {
    const vw = document.documentElement.clientWidth;
    return Math.max(0, ...[root, ...root.querySelectorAll("*")].map((el) => el.getBoundingClientRect().right - vw));
  });
  expect(overflow, "no part of the account panel sticks out past a 390px viewport").toBeLessThanOrEqual(1);
  await shot(page, "17-account-panel-390");
  expect(pageErrors(errors), "console errors").toEqual([]);
});
