// Customer login on the public designer (plan 3.3, Carolyn 2026-09-14): the lead gate IS the
// login, a code never blocks designing (Ahsan 2026-09-15), and the header grows Log in /
// Enter your code / Signed in as · Quotes · Invoices · Sign out. The account panel (cards, Review &
// Accept, Sign invoice, deep links, saved designs) and the refresh-keeps-the-design autosave are
// covered below the login cases. The PORTAL side closes the file: Orders' "Invoice to approve"
// (Approve is send_invoice, Not now is dismiss_invoice_request), Settings' customer login-code
// choice, the {total} wording hint, every copy/QR link now opening the designer, and the portal
// success screen's "Texted a login link" line — all with Supabase answered locally, no login.
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
import { CLIENT, watchConsole, revealTool } from "./helpers.mjs";

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
  // ⚠️ THE UNLOAD DRAFT SAVE CANNOT BE STUBBED WHERE IT IS GOING (proven 2026-09-15). The designer
  // sends it as a keepalive fetch straight to <project>/rest/v1/rpc/save_design as the page
  // unloads. Chrome delivers that request — a local cross-origin server received it on a real
  // reload — but NEITHER page.route NOR context.route can hold a cross-origin request from a
  // document that is going away: page.route aborted it, and context.route let it straight past to
  // the network. Left alone, a reload test would write a draft to the LIVE project. So every
  // keepalive save_design is sent to a same-origin path instead: page.route does catch a
  // same-origin unload keepalive, the rpc stub below matches it (its pattern has no host), and a
  // miss can only reach the local static server. Only the destination changes; the body, headers
  // and timing are the product's own.
  await page.addInitScript(() => {
    const realFetch = window.fetch;
    window.fetch = function (u, opts) {
      if (opts && opts.keepalive && /\/rest\/v1\/rpc\/save_design$/.test(String(u))) return realFetch.call(this, "/__e2e/rest/v1/rpc/save_design", opts);
      return realFetch.apply(this, arguments);
    };
  });
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
  await (await revealTool(page, /Workbench|Loft Area|Window wall$/)).click();
}

// The test tenant's catalog is LIVE and moves under the suite: on 2026-09-15 pw-demo-barns went
// from several styles (Utility, sizes from 8x10) to one "Lofted Barn" (10x12–12x24), and every
// driver that clicked "Utility" or picked "8x10" timed out with the product working fine. So pick
// the FIRST style card under the heading and a size the select actually offers, never a name.
// The style bar is SSStyleStrip since the layout workstream (a scroller with arrow buttons around
// the tiles), so "the first child under the heading" is no longer a tile. Its tiles carry
// data-ss-style, the same hook designer.spec.mjs uses.
async function pickFirstStyle(page) {
  await page.locator("[data-ss-style-strip] [data-ss-style]").first().click();
}
const sizeSelectOf = (page) => page.locator("select").filter({ has: page.locator("option", { hasText: "Select a size…" }) });
const sizeValues = (page) => sizeSelectOf(page).evaluate((s) => [...s.options].map((o) => o.value).filter(Boolean));

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
  expect(await ls(page, "ss_gate_phone_" + CLIENT)).toBe(PHONE10);          // a reload keeps the contact

  // "Not you? Start over" (the shared expo tablet) lets go of the code still out as well: the
  // next person must not be greeted by "Enter your code" for the previous visitor's number.
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Not you? Start over" }).click()]);
  await page.waitForFunction(() => window.__ssAppBooted === true);
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter your code" })).toHaveCount(0);
  expect(await ls(page, "ss_gate_phone_" + CLIENT)).toBeNull();
  await expect(page.getByPlaceholder("Full Name")).toHaveValue("");
  expect(pageErrors(errors), "console errors").toEqual([]);
});

// Decision 2 with the builder's Settings default on Email (review 2026-09-15): the email is only
// where the code goes. Name + phone unlock the design and file the lead; the sheet then asks for
// the address, and pressing again files nothing twice.
test("an Email default never holds the gate: name and phone unlock and file the lead once, the email only routes the code", async ({ page }) => {
  const errors = watchConsole(page);
  const calls = await stubBackend(page, {
    loginOptions: { status: 200, body: { ok: true, channels: ["sms", "email"], defaultChannel: "email" } },
  });
  await boot(page);
  await armATool(page);
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("group", { name: "Send my code by" }).getByRole("button", { name: "Email" })).toHaveAttribute("aria-pressed", "true");
  await fillGateDetails(sheet);
  const logIn = sheet.getByRole("button", { name: "Log in →" });
  await expect(logIn).toBeEnabled();                                          // no email typed
  await logIn.click();
  await expect(sheet.getByRole("alert")).toHaveText("Add your email and we'll send your code there — your design is already unlocked.");
  expect(await ls(page, "ss_gate_" + CLIENT)).toBe("1");
  expect(calls.filter((c) => c.fn === "capture-lead")).toHaveLength(1);
  expect(authCall(calls, "request_code")).toBeFalsy();
  await shot(page, "07b-sheet-email-default-no-address");

  await logIn.click();                                                        // nothing changed: no second lead
  await sheet.getByPlaceholder("you@example.com").fill("pat@example.com");
  await logIn.click();
  await expect(sheet.getByText("We emailed a 6-digit code to pat@example.com.")).toBeVisible();
  expect(calls.filter((c) => c.fn === "capture-lead")).toHaveLength(1);
  expect(authCall(calls, "request_code").body).toMatchObject({ channel: "email", email: "pat@example.com" });
  await sheet.getByRole("button", { name: "Keep designing, I'll enter it later" }).click();
  await armATool(page);
  await page.waitForTimeout(300);
  await expect(page.getByRole("dialog")).toHaveCount(0);
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
    rpc: { list_design_versions: { status: 200, body: [] } },
  });
  let estimate = null;
  await page.route(/\/functions\/v1\/submit-estimate/, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS, body: "ok" });
    estimate = route.request().postDataJSON();
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(SUBMIT_OK.body) });
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

  // Get Quote never asks for a code (decision 5): a whole quote goes out on the unverified
  // contact — saved, submitted, "Quote Created!" — with no sheet and no verify_code anywhere.
  await fillQuoteForm(page);
  await page.getByRole("button", { name: "Get Quote", exact: true }).click();
  await expect(page.getByText("Quote Created!")).toBeVisible({ timeout: 45_000 });
  expect(estimate, "submit-estimate was called").toBeTruthy();
  expect(calls.some((c) => c.fn === "rpc:save_design")).toBe(true);
  expect(authCall(calls, "verify_code")).toBeFalsy();
  expect(calls.filter((c) => c.fn === "customer-auth" && c.action === "request_code")).toHaveLength(1);
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
  // Nothing typed: the gate's remembered name comes back on boot and the verified phone is locked
  // in, which is exactly what autosave needs (the name used to come back blank and stop it).
  await expect(page.getByPlaceholder("Full Name")).toHaveValue("Pat Tester");
  await pickFirstStyle(page);
  const [size] = await sizeValues(page);
  await sizeSelectOf(page).selectOption(size);
  await page.waitForTimeout(400);
  expect(calls.some((c) => c.fn === "rpc:save_design")).toBe(false);          // 20 s debounce: nothing yet
  // The tab goes to the background (what a phone does instead of pagehide): flush now.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => saved && saved.p_code).toMatch(/^SS-[A-Z0-9]{10}$/);
  expect(saved).toMatchObject({ p_client_id: CLIENT, p_status: "draft", p_image_url: null });
  expect(saved.p_selections.size).toBe(size);
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

// The review's two gaps, driven for real (2026-09-15): a SIGNED-OUT visitor, a reload with no
// faked visibility (the save has to leave WITH the page — keepalive), and a contact that comes
// back after a reload so autosave keeps going on its own 20 s timer.
test("signed out: the contact survives a reload, a reload straight after a change keeps it, and autosave carries on", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  const rows = new Map();
  const saves = [];
  const calls = await stubBackend(page, {
    requestCode: { status: 503, body: { error: "Sign-in by text isn't available yet." } },
    rpc: {
      save_design: (b) => { saves.push(b); rows.set(b.p_code, b); return { status: 200, body: null }; },
      load_design: (b) => {
        const s = rows.get(b.p_code);
        return { status: 200, body: s ? [{ short_code: s.p_code, client_id: CLIENT, status: "draft", selections: s.p_selections, items: s.p_items,
          paint_colors: s.p_paint_colors, custom_options: s.p_custom_options, ro_dimensions: s.p_ro_dimensions, contact: s.p_contact }] : [] };
      },
    },
  });
  const sizeSelect = page.locator("select").filter({ has: page.locator("option", { hasText: "Select a size…" }) });
  await boot(page);
  await armATool(page);
  const sheet = page.getByRole("dialog");
  await fillGateDetails(sheet);
  await sheet.getByRole("button", { name: "Log in →" }).click();
  await sheet.getByRole("button", { name: "Keep designing →" }).click();
  await expect(sheet).toHaveCount(0);

  // 1. A reload before anything is designed: no draft, but the contact comes back.
  await page.reload();
  await page.waitForFunction(() => window.__ssAppBooted === true);
  await expect(page.getByPlaceholder("Full Name")).toHaveValue("Pat Tester");
  await expect(page.locator('input[placeholder="(555) 555-5555"]')).toHaveValue(PHONE_SHOWN);
  expect(saves).toHaveLength(0);

  // 2. Change the design and reload AT ONCE — well inside the 20 s debounce.
  await pickFirstStyle(page);
  const [size] = await sizeValues(page);
  await sizeSelect.selectOption(size);
  await page.waitForTimeout(300);
  expect(saves).toHaveLength(0);
  await page.reload();
  await page.waitForFunction(() => window.__ssAppBooted === true);
  await expect.poll(() => saves.length).toBe(1);
  const first = saves[0];
  expect(first).toMatchObject({ p_client_id: CLIENT, p_status: "draft", p_image_url: null });
  expect(first.p_code).toMatch(/^SS-[A-Z0-9]{10}$/);
  expect(first.p_selections.size).toBe(size);
  expect(first.p_contact).toMatchObject({ name: "Pat Tester", phone: PHONE_SHOWN });
  expect(await ls(page, "ss_draft_" + CLIENT)).toBe(first.p_code);
  await expect(sizeSelect).toHaveValue(size);                                   // restored
  expect(calls.filter((c) => c.fn === "capture-lead")).toHaveLength(1);        // the gate's one lead, no more

  // 3. After the restore settles, a change saves on the ordinary timer, under the same code.
  await page.waitForTimeout(2000);
  expect(saves).toHaveLength(1);                                               // adopting wrote nothing back
  const other = (await sizeValues(page)).find((v) => v !== size);
  await sizeSelect.selectOption(other);
  await expect.poll(() => saves.length, { timeout: 35_000 }).toBe(2);
  expect(saves[1].p_code).toBe(first.p_code);
  expect(saves[1].p_selections.size).toBe(other);
  expect(saves[1].p_contact).toMatchObject({ name: "Pat Tester", phone: PHONE_SHOWN });
  expect(pageErrors(errors), "console errors").toEqual([]);
});

// The rep's Copy customer link / sign-on-phone QR lands on the CUSTOMER's own phone, signed out
// and with no gate on that device (review 2026-09-15). It is a login to see a quote or sign an
// invoice — not the lead gate: no "design your building", no name demanded, no consent box, no
// second capture-lead. The verified code then opens both the account and the design.
test("the rep's account link, opened signed out on a new phone: a phone-only login, no lead filed, then Invoices", async ({ page }) => {
  const errors = watchConsole(page);
  const calls = await stubBackend(page, { quotes: () => listBody(quoteFixtures()) });
  await boot(page, `/?client=${CLIENT}&account=invoices&q=SS-INVOICE002`);
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Log in to see your quotes and invoices")).toBeVisible();
  await expect(sheet.getByText("Log in to design your building")).toHaveCount(0);
  await expect(sheet.getByText("We'll text you a code to open your quotes and invoices.")).toBeVisible();
  await expect(sheet.getByRole("checkbox")).toHaveCount(0);
  await expect(sheet.getByText("Name (optional)")).toBeVisible();
  await sheet.getByPlaceholder("(555) 555-5555").fill(PHONE10);
  await shot(page, "18-account-link-signed-out");
  await sheet.getByRole("button", { name: "Log in →" }).click();
  await expect(sheet.getByText(`We texted a 6-digit code to ${PHONE_SHOWN}.`)).toBeVisible();
  expect(calls.some((c) => c.fn === "capture-lead")).toBe(false);
  expect(await ls(page, "ss_gate_" + CLIENT)).toBeNull();                      // typing a phone unlocks nothing
  await sheet.locator("#ss-login-code").fill("123456");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Your invoices" }).locator('[data-ref="SS-INVOICE002"]')).toBeVisible();
  expect(await ls(page, "ss_gate_" + CLIENT)).toBe("1");                       // the code opened the gate too
  await armATool(page);
  await page.waitForTimeout(300);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(calls.some((c) => c.fn === "capture-lead")).toBe(false);
  expect(pageErrors(errors), "console errors").toEqual([]);
});

// ── The success screen (public page) ─────────────────────────────────────────────────────────
// Drives a real Get Quote with submit-estimate, storage and save_design stubbed: the quote PDF is
// rendered and "uploaded" to the stub, and the SS-mode response is what the screen reacts to.
async function fillQuoteForm(page) {
  await pickFirstStyle(page);
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
// quoteTexted rides along on purpose: the public page must ignore it (the line is the rep's).
const SUBMIT_OK = { status: 200, body: { ok: true, issuedBy: "structurestudio", quoteNumber: "JB-1050", estimateNumber: "JB-1050", quoteEmailed: true, quotePdfUrl: null, quoteTexted: true, quoteTextReason: null } };

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
  await expect(page.locator("[data-quote-texted]")).toHaveCount(0);                          // the rep's line, never the shopper's
  await page.getByRole("button", { name: "Verify your phone to accept this quote" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Log in", { exact: true })).toBeVisible();
  await expect(sheet.getByPlaceholder("(555) 555-5555")).toHaveValue(PHONE_SHOWN);            // the number they just quoted with
  expect(calls.some((c) => c.fn === "customer-quotes")).toBe(false);                         // nothing account-shaped without a token
  expect(pageErrors(errors), "console errors").toEqual([]);
});

// ── A refused Get Quote (2026-09-15) ─────────────────────────────────────────────────────────
// submit-estimate can REFUSE without issuing anything: a 400 carrying a sentence for a person
// (SS-TRJNVZJW5Z got "no user to assign it to"). Nothing went out, so the design is still a draft:
// the refresh pointer stays and autosave keeps saving it as a draft. The refusal is still logged,
// because submit-estimate files no row for its own 4xx and the designer's row is the only record,
// but as severity info with the status as its code. A 500 or a dropped connection is a fault and
// stays error, and it also drops the draft state (review 2026-09-15): the server may have issued
// the quote before the answer was lost, so no draft save may touch the row after it. Every write
// is stubbed by stubBackend, log_error included.
const NO_USER = "Can't create the estimate: this business's CRM location has no user to assign it to. Add a user to the location, then resubmit.";
const FAULT = "We couldn't create this estimate in the business's CRM just now. Please try again in a few minutes.";
// The page's own console.error for the failed submit, and Chrome's line for the stubbed 500.
const quoteErrors = (errors) => pageErrors(errors).filter((e) => !/^Submit error:|status of 500\b/.test(e));
const logRows = (calls) => calls.filter((c) => c.fn === "rpc:log_error").map((c) => c.body);
async function routeSubmit(page, status, body) {
  await page.route(/\/functions\/v1\/submit-estimate/, (route) => route.request().method() === "OPTIONS"
    ? route.fulfill({ status: 200, headers: CORS, body: "ok" })
    : route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) }));
}
// The tab goes to the background, so autosave flushes now instead of in 20 s. It is visible again
// straight after, so the Get Quote that follows never runs in a page that thinks it is hidden.
async function flushDraft(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
}

test("a refused Get Quote (400) shows the reason, logs as info, and the design stays a draft autosave keeps saving", async ({ page }) => {
  test.setTimeout(180_000);   // a whole quote PDF is rendered; the baseline run came close to 90 s
  const errors = watchConsole(page);
  await seedSession(page);
  const saves = [];
  const calls = await stubBackend(page, {
    rpc: { save_design: (b) => { saves.push(b); return { status: 200, body: null }; }, list_design_versions: { status: 200, body: [] } },
  });
  await routeSubmit(page, 400, { error: NO_USER });
  await boot(page);
  await fillQuoteForm(page);
  await flushDraft(page);
  await expect.poll(() => ls(page, "ss_draft_" + CLIENT)).toMatch(/^SS-[A-Z0-9]{10}$/);
  const code = await ls(page, "ss_draft_" + CLIENT);
  expect(saves.filter((s) => s.p_code === code && s.p_status === "draft").length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Get Quote", exact: true }).click();
  await expect(page.getByText(NO_USER)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Quote Created!")).toHaveCount(0);
  expect(saves.find((s) => s.p_image_url).p_code).toBe(code);                  // the submit saved the same row
  await shot(page, "19-quote-refused");

  // Still a draft: the pointer survives, and the next autosave saves the same code as a draft.
  // Asserted BEFORE the log row, so a build that drops the draft on a refusal fails here and not on
  // the log body (review 2026-09-15: on origin/beta this test stopped at the log row first).
  expect(await ls(page, "ss_draft_" + CLIENT)).toBe(code);
  await page.getByPlaceholder("City").fill("Independence");
  await flushDraft(page);
  await expect.poll(() => saves.filter((s) => s.p_contact && s.p_contact.city === "Independence").length).toBe(1);
  expect(saves.find((s) => s.p_contact && s.p_contact.city === "Independence")).toMatchObject({ p_code: code, p_status: "draft", p_image_url: null });

  await expect.poll(() => logRows(calls).length).toBe(1);
  expect(logRows(calls)[0]).toMatchObject({
    p_source: "designer", p_message: NO_USER, p_code: "http_400", p_severity: "info",
    p_context: { phase: "submitQuote", status: 400, fn: "submit-estimate", embedded: false, designCode: code },
  });
  expect(quoteErrors(errors), "console errors").toEqual([]);
});

// A failure that is not a definite refusal can come AFTER the server issued the quote: the answer
// was lost on a dropped connection, or a 5xx landed after the promote. The designer cannot tell,
// so it lets go of the draft exactly as a success does, and no draft save may rewrite what may now
// be a sent quote. A reload re-derives the truth: the URL already carries ?id=, and load_design
// sets the draft flag from the row's status. Before this, the branch kept the draft here.
for (const mode of [
  { name: "a submit-estimate 500", status: 500, code: "http_500", message: FAULT },
  { name: "a dropped connection to submit-estimate", status: null, code: null, message: "Failed to send a request to the Edge Function" },
]) {
  test(`${mode.name} is a fault: the reason shows, the row logs as error, and the draft is let go`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watchConsole(page);
    await seedSession(page);
    const saves = [];
    const calls = await stubBackend(page, {
      rpc: { save_design: (b) => { saves.push(b); return { status: 200, body: null }; }, list_design_versions: { status: 200, body: [] } },
    });
    if (mode.status) await routeSubmit(page, mode.status, { error: mode.message });
    else await page.route(/\/functions\/v1\/submit-estimate/, (route) => route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 200, headers: CORS, body: "ok" })
      : route.abort("failed"));
    await boot(page);
    await fillQuoteForm(page);
    await flushDraft(page);
    await expect.poll(() => ls(page, "ss_draft_" + CLIENT)).toMatch(/^SS-[A-Z0-9]{10}$/);
    const code = await ls(page, "ss_draft_" + CLIENT);

    await page.getByRole("button", { name: "Get Quote", exact: true }).click();
    await expect(page.getByText(mode.message)).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Quote Created!")).toHaveCount(0);
    expect(saves.find((s) => s.p_image_url).p_code).toBe(code);
    expect(await ls(page, "ss_draft_" + CLIENT), "the refresh pointer goes").toBeNull();
    const after = saves.length;
    await page.getByPlaceholder("City").fill("Independence");
    await flushDraft(page);
    await page.waitForTimeout(1500);
    expect(saves.slice(after), "no draft save over a quote that may have been issued").toEqual([]);

    await expect.poll(() => logRows(calls).length).toBe(1);
    expect(logRows(calls)[0]).toMatchObject({
      p_source: "designer", p_message: mode.message, p_code: mode.code, p_severity: "error",
      p_context: { phase: "submitQuote", status: mode.status, fn: "submit-estimate", designCode: code },
    });
    expect(quoteErrors(errors), "console errors").toEqual([]);
  });
}

test("a Get Quote that issues drops the draft: the pointer goes, nothing is logged, and autosave stops", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  await seedSession(page);
  const saves = [];
  const calls = await stubBackend(page, {
    rpc: { save_design: (b) => { saves.push(b); return { status: 200, body: null }; }, list_design_versions: { status: 200, body: [] } },
  });
  await routeSubmit(page, 200, SUBMIT_OK.body);
  await boot(page);
  await fillQuoteForm(page);
  await flushDraft(page);
  await expect.poll(() => ls(page, "ss_draft_" + CLIENT)).toMatch(/^SS-[A-Z0-9]{10}$/);
  const code = await ls(page, "ss_draft_" + CLIENT);
  await page.getByRole("button", { name: "Get Quote", exact: true }).click();
  await expect(page.getByText("Quote Created!")).toBeVisible({ timeout: 45_000 });
  expect(await ls(page, "ss_draft_" + CLIENT)).toBeNull();                      // a sent quote needs no pointer
  expect(saves.find((s) => s.p_image_url).p_code).toBe(code);
  // Leave the success screen and change something. While it is up, `submitted` alone keeps the
  // timer and the unload flush quiet, so a check there passes even without the success path's
  // draft release (review 2026-09-15). Back on the canvas only that release stops a draft save.
  await page.getByRole("button", { name: "Review to make additional changes" }).click();
  const after = saves.length;
  await page.getByPlaceholder("City").fill("Independence");
  await flushDraft(page);
  await page.waitForTimeout(1500);
  expect(saves.slice(after), "no draft save after the quote was issued").toEqual([]);
  expect(logRows(calls)).toEqual([]);
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

// ── The portal ───────────────────────────────────────────────────────────────────────────────
// No login and nothing reaches the project: a fake supabase-js session sits in storage and EVERY
// supabase.co request is answered here (the recipe from the 2026-09-09 portal checks). The shell
// needs client_users (else "No business linked"), portal-billing and portal-settings status;
// portal-settings dispatches on `action`, REST GETs on the table name. Routes load as
// /portal.html + pushState, which works on a static server with no _redirects and on beta.
const PORTAL_USER = { id: "00000000-0000-4000-8000-0000000000e2", aud: "authenticated", role: "authenticated", email: "portal-e2e@example.invalid", app_metadata: {}, user_metadata: {}, created_at: "2026-09-15T00:00:00Z" };
const PORTAL_STATUS = { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, businessName: "Test Barns", branding: { companyName: "Test Barns" }, invoiceInGhl: false };

// Copy buttons write here, so a test reads what was copied without a clipboard permission.
async function captureClipboard(page) {
  await page.addInitScript(() => {
    try { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } }); } catch (_e) { /* the test will say so */ }
  });
}

async function stubPortal(page, actions = {}, tables = {}) {
  const calls = [];
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const session = { access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: PORTAL_USER.id, role: "authenticated", exp, aud: "authenticated" })}.sig`,
    refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: exp, user: PORTAL_USER };
  await page.addInitScript((s) => { try { localStorage.setItem("sb-jzeamjbhdrsbygdnphbm-auth-token", JSON.stringify(s)); } catch (_e) {} }, session);
  await captureClipboard(page);
  await page.route(/^https:\/\/jzeamjbhdrsbygdnphbm\.supabase\.co\//, async (route) => {
    const req = route.request();
    const u = req.url();
    const reply = (body, status = 200) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS, body: "ok" });
    if (/\/auth\/v1\/user/.test(u)) return reply(PORTAL_USER);
    if (/\/rest\/v1\/client_users/.test(u)) return reply([{ client_id: CLIENT, role: "owner", user_id: PORTAL_USER.id }]);
    if (/\/functions\/v1\/portal-billing/.test(u)) return reply({ entitlements: { features: { crm: true } }, features: { crm: true }, plan: "pro", status: "active" });
    if (/\/rest\/v1\/rpc\/can_open_projects/.test(u)) return reply(true);
    if (/\/functions\/v1\/portal-settings/.test(u)) {
      let body = {};
      try { body = req.postDataJSON() || {}; } catch (_e) { /* not JSON */ }
      calls.push(body);
      const spec = actions[body.action];
      if (spec) {
        const r = typeof spec === "function" ? await spec(body) : spec;
        return reply(r.body, r.status || 200);
      }
      if (body.action === "status") return reply(PORTAL_STATUS);
      return reply({ ok: true });
    }
    if (req.method() === "GET" && /\/rest\/v1\/[a-z_]+/.test(u)) {
      const spec = tables[u.match(/\/rest\/v1\/([a-z_]+)/)[1]];
      return reply(spec ? (typeof spec === "function" ? spec() : spec) : []);
    }
    return reply({});
  });
  return calls;
}

async function openPortal(page, path) {
  await page.goto("/portal.html");
  await page.waitForFunction(() => window.__ssAppBooted === true);
  await expect(page.locator(".ss-nav").first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
}

const ORDER_CODE = "SS-APPROVE01";
function orderFixtures() {
  const contact = { name: "Pat Tester", phone: PHONE_SHOWN, email: "pat@example.com" };
  return {
    order: { id: "11111111-2222-4333-8444-555555555555", client_id: CLIENT, order_no: 1050, short_code: ORDER_CODE, ordered_at: "2026-09-14T15:00:00Z", total_cents: 900000, customer_name: "Pat Tester" },
    list: { short_code: ORDER_CODE, contact_id: null, contact, selections: { style: "utility", size: "10x12" }, status: "accepted", image_url: null, ghl_estimate_number: null,
      ss_quote_number: "JB-1050", ss_quote_pdf_url: null, ss_invoice_sent_at: null, ss_invoice_requested_at: null },
    detail: { short_code: ORDER_CODE, contact_id: null, status: "accepted", accepted_at: "2026-09-15T14:00:00Z", ss_quote_number: "JB-1050", ss_quote_pdf_url: null, ss_quote_sent_at: "2026-09-14T15:00:00Z",
      image_url: null, plan_image_url: null, view3d_image_url: null, estimate_lines: { lines: [{ name: "Utility 10x12", qty: 1, unit: 9000, total: 9000 }], discount: 0 },
      selections: { style: "utility", size: "10x12" }, paint_colors: {}, contact },
  };
}

test("portal Orders: a customer's Accept waits as Invoice to approve; Approve is send_invoice, Not now sets it aside", async ({ page }) => {
  const errors = watchConsole(page);
  const f = orderFixtures();
  const state = { requestedAt: "2026-09-15T14:00:00Z", dismissReplies: [{ status: 409, body: { error: "That invoice has already been issued." } }] };
  const calls = await stubPortal(page, {
    orders_designs: (b) => ({ body: { ok: true, designs: [b.detail ? f.detail : { ...f.list, ss_invoice_requested_at: state.requestedAt }] } }),
    order_paperwork: { body: { ok: true, business: { name: "Test Barns" }, colors: [], cladding: [], invoice: null } },
    send_invoice: { body: { ok: true, sent: true, invoiceNumber: "SSI-2001" } },
    dismiss_invoice_request: () => {
      const next = state.dismissReplies.shift();
      if (next) return next;
      state.requestedAt = null;   // what the server does: the stamp the tab reads is cleared
      return { body: { ok: true, status: "dismissed" } };
    },
  }, { orders: [f.order] });
  page.on("dialog", (d) => d.accept());   // send_invoice's "Create invoice for …?" confirm
  await openPortal(page, "/portal/orders");

  await expect(page.getByText("customer accepted — approve to issue")).toBeVisible();          // the tile
  await expect(page.getByRole("button", { name: "Invoice to approve", exact: true })).toBeVisible();   // the chip
  const table = page.locator("tbody");
  await expect(table.getByText("Invoice to approve", { exact: true })).toBeVisible();          // the row's status
  await shot(page, "18-orders-invoice-to-approve-list");

  await table.getByText("#1050").click();
  const card = page.locator('[data-invoice-request="pending"]');
  await expect(card).toContainText(/Customer accepted .+\. Approve to issue the invoice \(it takes the next number\)\./);
  await expect(page.getByRole("button", { name: "Create & send invoice" })).toHaveCount(0);   // one offer, the approval
  await card.scrollIntoViewIfNeeded();
  await shot(page, "19-orders-invoice-to-approve-card");

  // A refusal is the server's own sentence, not "non-2xx status code".
  await card.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText("That invoice has already been issued.", { exact: true })).toBeVisible();

  // Approve IS send_invoice: exactly the body "Create & send invoice" has always sent.
  await card.getByRole("button", { name: "Approve & send invoice" }).click();
  await expect(page.getByText("Invoice SSI-2001 sent — awaiting the customer's signature.")).toBeVisible();
  expect(calls.filter((c) => c.action === "send_invoice")).toEqual([{ action: "send_invoice", shortCode: ORDER_CODE }]);

  // The customer link opens the designer's account panel on this order.
  await page.getByRole("button", { name: "Copy customer link" }).click();
  const origin = await page.evaluate(() => location.origin);
  await expect.poll(() => page.evaluate(() => window.__copied)).toBe(`${origin}/?client=${CLIENT}&account=quotes&q=${ORDER_CODE}`);

  // Not now: the request is set aside and the order is back to the plain invoice button.
  await page.locator('[data-invoice-request="pending"]').getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText("Set aside — JB-1050 is back under Needs invoice. Create the invoice whenever you're ready.")).toBeVisible();
  expect(calls.filter((c) => c.action === "dismiss_invoice_request").at(-1)).toEqual({ action: "dismiss_invoice_request", shortCode: ORDER_CODE });
  await expect(page.locator("[data-invoice-request]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create & send invoice" })).toBeVisible();
  await page.getByText("← All orders").click();
  await expect(page.locator("tbody").getByText("Needs invoice", { exact: true })).toBeVisible();
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("portal Orders: with the invoice out, the customer link and the sign-on-phone QR open the designer's Invoices", async ({ page }) => {
  const errors = watchConsole(page);
  const f = orderFixtures();
  await stubPortal(page, {
    orders_designs: (b) => ({ body: { ok: true, designs: [b.detail ? f.detail : { ...f.list, ss_invoice_sent_at: "2026-09-15T15:00:00Z" }] } }),
    order_paperwork: { body: { ok: true, business: { name: "Test Barns" }, colors: [], cladding: [],
      invoice: { issued_by: "structurestudio", invoice_number: "SSI-2001", invoice_pdf_url: "https://jzeamjbhdrsbygdnphbm.supabase.co/storage/v1/object/public/documents/SSI-2001.pdf" } } },
  }, { orders: [f.order] });
  await openPortal(page, "/portal/orders");
  await page.locator("tbody").getByText("#1050").click();
  await expect(page.getByText(/Invoice SSI-2001 sent/)).toBeVisible();
  const origin = await page.evaluate(() => location.origin);
  const link = `${origin}/?client=${CLIENT}&account=invoices&q=${ORDER_CODE}`;
  await page.getByRole("button", { name: "Copy customer link" }).click();
  await expect.poll(() => page.evaluate(() => window.__copied)).toBe(link);
  await page.getByRole("button", { name: "Sign on their phone" }).click();
  await expect(page.getByText(link, { exact: true })).toBeVisible();                 // printed under the QR
  await expect(page.getByRole("img", { name: "Signing link QR code" })).toBeVisible(); // still fits a QR
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("portal Settings: Customer login code shows the saved choice, saves on its own, and a refusal puts it back", async ({ page }) => {
  const errors = watchConsole(page);
  const saves = [];
  let refuse = false;
  await stubPortal(page, {
    status: { body: { ...PORTAL_STATUS, customerLoginDefault: "email" } },
    save: (b) => {
      saves.push(b);
      return refuse ? { status: 400, body: { error: "The customer login code can be sent by text or by email." } } : { body: { ok: true } };
    },
  });
  await openPortal(page, "/portal/settings/connection");
  const group = page.getByRole("group", { name: "Customer login code" });
  await expect(group).toHaveAttribute("data-ss-login-default", "email");
  await expect(group.getByRole("button", { name: "Email" })).toHaveAttribute("aria-pressed", "true");
  await group.scrollIntoViewIfNeeded();
  await shot(page, "20-settings-login-code");

  await group.getByRole("button", { name: "Text" }).click();
  await expect(page.getByText("Saved — customers are offered a texted code first.")).toBeVisible();
  expect(saves).toEqual([{ action: "save", customerLoginDefault: "sms" }]);   // one key: nothing else on the page is touched
  await expect(group).toHaveAttribute("data-ss-login-default", "sms");
  await group.getByRole("button", { name: "Text" }).click();                    // already chosen: no second save
  expect(saves.length).toBe(1);

  refuse = true;
  await group.getByRole("button", { name: "Email" }).click();
  await expect(page.getByText("The customer login code can be sent by text or by email.")).toBeVisible();
  await expect(group).toHaveAttribute("data-ss-login-default", "sms");        // put back
  expect(saves.length).toBe(2);
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("portal Settings: a status without the login-code key reads as Text", async ({ page }) => {
  await stubPortal(page);
  await openPortal(page, "/portal/settings/connection");
  await expect(page.getByRole("group", { name: "Customer login code" })).toHaveAttribute("data-ss-login-default", "sms");
});

test("portal email wording: {total} is marked not recommended on the Quote wording only", async ({ page }) => {
  const errors = watchConsole(page);
  await stubPortal(page, {
    email_status: { body: { platformReady: true, domainStatus: "verified", domain: "testbarns.example", fromName: "Test Barns", fromLocal: "info",
      fromAddress: "info@testbarns.example", verifiedAt: "2026-09-01T00:00:00Z", active: true, dnsRecords: [], recentSends: [], templateCopy: {} } },
  });
  await openPortal(page, "/portal/settings/email");
  const hint = page.locator('[data-token-hint="total"]');
  const kind = (name) => page.getByRole("button", { name, exact: true });
  await expect(kind("Quote")).toBeVisible();
  await expect(hint).toHaveCount(0);                                               // Estimate is the first tab
  await kind("Quote").click();
  await expect(hint).toHaveText("{total} is not recommended for quotes — the quote email leaves the price out, so the customer sees it when they open the quote.");
  await expect(page.getByPlaceholder("Opening line — e.g. Thanks for designing with {business}! Your quote {number} is ready.")).toBeVisible();
  await hint.scrollIntoViewIfNeeded();
  await shot(page, "21-wording-total-hint");
  await kind("Invoice").click();
  await expect(hint).toHaveCount(0);
  expect(pageErrors(errors), "console errors").toEqual([]);
});

test("portal Designs: a quote row's Copy link opens the designer on that quote", async ({ page }) => {
  const errors = watchConsole(page);
  await stubPortal(page, {}, {
    designs: [{ short_code: "SS-QUOTE0042", created_at: "2026-09-14T15:00:00Z", updated_at: "2026-09-14T15:00:00Z", status: "sent",
      contact: { name: "Pat Tester", phone: PHONE_SHOWN, email: "pat@example.com" }, contact_id: null, sel_style: "utility", sel_size: "10x12",
      ghl_estimate_number: null, image_url: null, inventory_unit_id: null, ss_quote_number: "JB-1050", ss_quote_pdf_url: null, total_cents: 900000, expected_close_date: null }],
  });
  await openPortal(page, "/portal/designs/list");
  await page.getByRole("button", { name: "More actions for Pat Tester" }).click();
  await page.getByText("Copy link", { exact: true }).click();
  const origin = await page.evaluate(() => location.origin);
  await expect.poll(() => page.evaluate(() => window.__copied)).toBe(`${origin}/?client=${CLIENT}&account=quotes&q=SS-QUOTE0042`);
  expect(pageErrors(errors), "console errors").toEqual([]);
});

// The PORTAL's designer is this same component mounted with `embedded` (portal/06-3d.jsx
// DesignerTab). Swapping index.html's thin mount for one that renders it that way exercises the
// compiled component that ships, without stubbing the whole shell around the Designer tab.
async function mountEmbedded(page) {
  await page.route(/\/index\.mount\.compiled\.js/, (route) => route.fulfill({
    status: 200,
    headers: { "content-type": "application/javascript" },
    body: `(function(){var r=ReactDOM.createRoot(document.getElementById("root"));`
      + `r.render(React.createElement(window.StructureStudio,{clientId:${JSON.stringify(CLIENT)},embedded:true}));window.__ssAppBooted=true;})();`,
  }));
}

for (const c of [
  { name: "texted", res: { quoteTexted: true, quoteTextReason: null }, line: `Texted a login link to ${PHONE_SHOWN}.`, shot: "22-portal-success-texted" },
  { name: "not texted", res: { quoteTexted: false, quoteTextReason: "not_active" }, line: "Not texted — texting isn't switched on for your business yet." },
  { name: "a resubmit", res: { quoteTexted: false, quoteTextReason: "not_first_issue" }, line: null },
]) {
  test(`portal success screen, ${c.name}: the login-text line, and Copy customer link opens the designer`, async ({ page }) => {
    const errors = watchConsole(page);
    let code = null;
    await mountEmbedded(page);
    await captureClipboard(page);
    await stubBackend(page, { rpc: { save_design: (b) => { if (b.p_image_url) code = b.p_code; return { status: 200, body: null }; }, list_design_versions: { status: 200, body: [] } } });
    await page.route(/\/functions\/v1\/submit-estimate/, (route) => route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 200, headers: CORS, body: "ok" })
      : route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ ...SUBMIT_OK.body, ...c.res }) }));
    await boot(page);
    await fillQuoteForm(page);
    await page.getByRole("button", { name: "Get Quote", exact: true }).click();
    await expect(page.getByText("Quote Created!")).toBeVisible({ timeout: 45_000 });
    const line = page.locator("[data-quote-texted]");
    if (c.line) await expect(line).toHaveText(c.line);
    else await expect(line).toHaveCount(0);
    if (c.shot) { await page.getByText("Quote Created!").scrollIntoViewIfNeeded(); await shot(page, c.shot); }
    expect(code).toMatch(/^SS-[A-Z0-9]{10}$/);
    await page.getByRole("button", { name: "Copy customer link" }).click();
    const origin = await page.evaluate(() => location.origin);
    await expect.poll(() => page.evaluate(() => window.__copied)).toBe(`${origin}/?client=${CLIENT}&account=quotes&q=${code}`);
    expect(pageErrors(errors), "console errors").toEqual([]);
  });
}
