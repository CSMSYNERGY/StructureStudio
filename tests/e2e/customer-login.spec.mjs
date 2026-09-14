// Customer login on the public designer (plan 3.3, Carolyn 2026-09-14): the lead gate IS the
// login, a code never blocks designing (Ahsan 2026-09-15), and the header grows Log in /
// Enter your code / Signed in as · Quotes · Invoices · Sign out.
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
const pageErrors = (errors) => errors.filter((e) => !/^Failed to load resource: the server responded with a status of (400|401|503)\b/.test(e));

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
    }
    return route.fulfill({ status: res.status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(res.body) });
  });
  // Reads (get_config, get_catalog, …) pass through; anything else is a write and is stubbed.
  await page.route(/\/rest\/v1\/rpc\/(?!get_)[a-z0-9_]+/, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS, body: "ok" });
    let body = {};
    try { body = req.postDataJSON() || {}; } catch (_e) { /* not JSON */ }
    calls.push({ fn: "rpc:" + req.url().match(/\/rpc\/([a-z0-9_]+)/)[1], action: null, body });
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: "null" });
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
  await expect(page.getByRole("region", { name: "Your quotes" })).toContainText("You have 1 quote.");
  const listCall = calls.filter((c) => c.fn === "customer-quotes").pop();
  expect(listCall.body).toMatchObject({ action: "list", token: TOKEN, clientId: CLIENT });
  await page.getByRole("button", { name: "Invoices", exact: true }).click();
  await expect(page.getByRole("region", { name: "Your invoices" })).toContainText("You have 2 invoices.");
  await shot(page, "06-invoices-handoff");

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
