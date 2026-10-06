// The bank rail's Routing and Checking boxes (Carolyn 2026-09-02), on BOTH surfaces that take a
// bank payment, driven for real: the customer's pay panel in my-quotes.html and the builder's
// Record-a-payment modal in the COMPILED portal.
//
// CardPointe's hosted tokenizer takes a bank account only as one "routing/account" string in one
// field. Both pages now draw their own two boxes and tokenize that string from the browser
// against CardSecure on the tokenizer's origin (achTokenize, in each file). Here that origin is
// https://tok.example.test, answered locally, so nothing leaves the machine and no real bank
// number is ever typed: the account below is synthetic, and the routing number is a bank's
// public ABA number, used for its check digit. (The repo is public. A pair that was really
// charged belongs in the private work log, for the beta check, not here.)
//
//   U  achTokenize lifted out of BOTH files and run with a stub fetch: a body read that fails
//      after the headers ANSWERS (never rejects, which left my-quotes stuck on "Checking…"),
//      and "NNNN::reason" inside a 200 is refused whether or not it is URL-encoded
//   M  my-quotes.html
//     M1 the Bank account tab shows two boxes, labelled, numeric, no autofill, and NO iframe; the
//        tokenizer's ACH iframe URL is never even requested
//     M2 031201361 fails the ABA check digit: a sentence says so, nothing is tokenized, Pay stays
//        off; a SHORT routing number that was left stays reported while the account is typed
//     M3 031201360 + the account tokenizes ONCE, with exactly "routing/account" in the body and no
//        query string, and arms Pay
//     M4 any edit disarms Pay at once; the new numbers are tokenized again and re-arm it; a
//        keystroke that changes no digit leaves the button armed (or re-arms it)
//     M5 a failed check shows OUR sentence — CardSecure's reply (which here echoes the numbers) is
//        never shown — and so does an encoded "NNNN::" failure inside a 200; leaving a box with
//        both numbers valid checks again
//     M6 a declined payment says so INSIDE the panel/modal, and the button comes back
//     M7 the charge carries the latest token and rail "ach", and neither number
//   P  the portal's Record-a-payment modal: the same, against portal-payments' charge, plus
//     P9 an account that can't charge online (pay_options refused) picking Bank / ACH lands on
//        Record payment with NO bank boxes, not on a dead Charge $0.00
//   X  across both: neither number in localStorage, sessionStorage, the URL, the console, the
//      error log (log_error) or any request other than the one tokenize POST
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/achBankBoxes.mjs            (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> and SS_MY_QUOTES=<an older my-quotes.html>
// serve those files instead, which is how to watch the checks fail against the single-field iframe.
//
// ⚠️ NOTHING LEAVES THE MACHINE: every Supabase host and the tokenizer origin are answered here,
// every other non-local request is aborted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, shotsDir, BASE, REF } from "./lib.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const CLIENT = "harness-ach-boxes";
const TOK_ORIGIN = "https://tok.example.test";
// A public ABA routing number (valid check digit) and a SYNTHETIC account. Test values only.
const ROUTING = "031201360", ROUTING_BAD = "031201361", ACCOUNT = "000987654321";
const SECRETS = [ROUTING, ROUTING_BAD, ACCOUNT, ACCOUNT.slice(0, 9)];   // the last: a 9-digit run of the account

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000a6", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const ORDER_ID = "11111111-2222-4333-8444-5555555555a6";
const TOKENIZER = {
  origin: TOK_ORIGIN,
  cardUrl: `${TOK_ORIGIN}/itoke/ajax-tokenizer.html?rail=card`,
  achUrl: `${TOK_ORIGIN}/itoke/ajax-tokenizer.html?rail=ach`,
  swipeUrl: `${TOK_ORIGIN}/itoke/ajax-tokenizer.html?rail=card&swipeonly=true`,
  cardHeight: 265, achHeight: 130,
};

// tokFail: false | "echo" (a 400 that echoes the numbers) | "encoded" (a 200 whose token is an
// URL-encoded "NNNN::reason"). declineOnce: the next charge is refused by the bank.
// refusePayOptions: pay_options answers as for an account without online payments (a 503).
const S = { tokFail: false, minted: 0, declineOnce: false, refusePayOptions: false };
const DECLINE = "The bank declined this payment.";
const ENCODED_FAIL = "0008%3A%3AInvalid+account";
const tokenizeCalls = [];   // { url, method, body }
const tokRequests = [];     // every request to the tokenizer origin
const fnCalls = [];         // { fn, body } for customer-pay / portal-payments
const logged = [];          // log_error bodies
const consoleLines = [];
const allRequests = [];     // { url, body } for every request the page made

const MQ_OVERRIDE = process.env.SS_MY_QUOTES ? readFileSync(process.env.SS_MY_QUOTES, "utf8") : null;
const PORTAL_OVERRIDE = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

const { ok, failed, results } = reporter();

// ── U: achTokenize itself, lifted out of BOTH shipped files and run against a stub fetch ──
// Two failures a browser run cannot stage: a body read that dies AFTER the headers arrived (a
// dropped connection, or the 15 s abort firing mid-body), and CardSecure's "NNNN::reason"
// failure arriving URL-encoded inside a 200. The lift is scripts/preflight.mjs's takeBlock.
{
  const takeBlock = (text, needle) => {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => l.includes(needle));
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) { if (ch === "{") depth++; else if (ch === "}") depth--; }
      if (depth === 0 && i > start) return lines.slice(start, i + 1).join("\n");
    }
    return null;
  };
  const answer = (body) => () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
  const realFetch = globalThis.fetch;
  for (const file of ["my-quotes.html", "portal/04-orders.jsx"]) {
    const src = readFileSync(join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
    const blocks = ["function achRoutingOk(", "function achAccountOk(", "function achTokenize("].map((n) => takeBlock(src, n));
    if (blocks.some((b) => !b)) { ok(`U ${file}: achRoutingOk / achAccountOk / achTokenize can be lifted out`, false); continue; }
    // eslint-disable-next-line no-new-func
    const achTokenize = new Function([...blocks, "return achTokenize;"].join("\n"))();
    const run = () => achTokenize(TOK_ORIGIN, ROUTING, ACCOUNT).then((v) => v, (e) => ({ rejected: String(e && e.message) }));
    try {
      globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.reject(new Error("body stream aborted")) });
      const r1 = await run();
      ok(`U ${file}: a body read that fails after the headers ANSWERS "Couldn't reach…", never rejects`,
        r1 && /^Couldn't reach the bank-details check\./.test(String(r1.error)) && !r1.rejected && !r1.token, JSON.stringify(r1));
      globalThis.fetch = answer({ message: "", errorcode: 0, token: ENCODED_FAIL });
      const r2 = await run();
      ok(`U ${file}: an URL-encoded "NNNN::" failure inside a 200 is refused`, r2 && r2.error && !r2.token, JSON.stringify(r2));
      globalThis.fetch = answer({ message: "", errorcode: 0, token: "0008::Invalid account" });
      const r3 = await run();
      ok(`U ${file}: a plain "NNNN::" failure inside a 200 is refused`, r3 && r3.error && !r3.token, JSON.stringify(r3));
      globalThis.fetch = answer({ message: "9999000000014321", errorcode: 0, token: "9999000000014321" });
      const r4 = await run();
      ok(`U ${file}: a real-looking token is taken`, r4 && r4.token === "9999000000014321", JSON.stringify(r4));
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

const { browser, ctx } = await launch({ width: 1280, height: 1000 });
await ctx.addInitScript(([ref, s, client]) => {
  try {
    localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s));
    localStorage.setItem("ssq_token_" + client, "harness-customer-token-0123456789abcdef");
    localStorage.setItem("ssq_name_" + client, "Pat Example");
  } catch (_e) { /* storage blocked */ }
}, [REF, SESSION, CLIENT]);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => consoleLines.push(m.text()));
page.on("request", (r) => allRequests.push({ url: r.url(), body: r.postData() || "" }));

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// Registered FIRST so the specific handlers below override it (Playwright runs routes in reverse).
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());

// The tokenizer origin: a blank page for the card iframe, and CardSecure's tokenize endpoint.
await page.route((u) => u.href.startsWith(TOK_ORIGIN + "/"), async (route) => {
  const req = route.request();
  tokRequests.push(`${req.method()} ${req.url()}`);
  if (req.url().includes("/cardsecure/api/v1/ccn/tokenize")) {
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "Content-type", "access-control-allow-methods": "POST" }, body: "" });
    }
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    tokenizeCalls.push({ url: req.url(), method: req.method(), body });
    if (S.tokFail === "encoded") {
      // A failure INSIDE a 200, spelled the way Fiserv's itoke.js decodes before testing.
      return json(route, { message: "", errorcode: 0, token: ENCODED_FAIL });
    }
    if (S.tokFail) {
      // A reply that ECHOES the numbers, so a page that showed CardSecure's message would leak them.
      return json(route, { message: `Invalid account ${body.account}`, errorcode: 14 }, 400);
    }
    S.minted += 1;
    const token = `9999000${String(S.minted).padStart(5, "0")}${ACCOUNT.slice(-4)}`;
    return json(route, { message: token, errorcode: 0, token });
  }
  return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>tokenizer stub</title><input id=ccnumfield>" });
});

const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  if (url.includes("/rest/v1/rpc/log_error")) { logged.push(req.postData() || ""); return json(route, null); }
  if (url.includes("/rest/v1/rpc/")) return json(route, false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
  if (url.includes("/rest/v1/orders")) {
    return json(route, [{ id: ORDER_ID, client_id: CLIENT, order_no: 1066, short_code: null, ordered_at: "2026-10-01T15:00:00Z", total_cents: 100000, total_source: "manual", notes: "Counter sale" }]);
  }
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (/[?&]warm=1/.test(url)) return json(route, { ok: true });
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
  }
  if (url.includes("/customer-auth")) return json(route, { ok: true, channels: ["sms"], defaultChannel: "sms" });
  if (url.includes("/customer-quotes")) {
    return json(route, { ok: true, businessName: "Acme Sheds", name: "Pat Example", quotes: [{
      quoteRef: "SS-ACHBOXES", estimateNumber: "AS-1066", status: "invoiced", total: 1000,
      invoice: { number: "SSI-1066", signedAt: "2026-10-01T15:00:00Z", pdfUrl: null },
    }] });
  }
  const payOptions = { ok: true, askCents: 100000, askKind: "balance", balanceCents: 100000, settledCents: 0, pendingCents: 0, depositCents: null, minCents: 100, maxCents: 5000000, tokenizer: TOKENIZER };
  if (url.includes("/customer-pay")) {
    fnCalls.push({ fn: "customer-pay", body });
    if (body.action === "pay_options") return json(route, { ...payOptions, canPay: true });
    if (body.action === "pay" && S.declineOnce) { S.declineOnce = false; return json(route, { error: DECLINE }, 400); }
    if (body.action === "pay") return json(route, { ok: true, pending: true, amountCents: 100000, balanceCents: 100000 });
    return json(route, { ok: true, applies: null, percent: null });
  }
  if (url.includes("/portal-payments")) {
    fnCalls.push({ fn: "portal-payments", body });
    if (body.action === "pay_options" && S.refusePayOptions) {
      await new Promise((r) => setTimeout(r, 1500));   // slow enough for a chip to be picked first
      return route.fulfill({ status: 503, contentType: "application/json", headers: { ...H, "x-ss-refusal": "1" }, body: JSON.stringify({ error: "Taking cards isn't switched on for this account yet." }) });
    }
    if (body.action === "pay_options") return json(route, { ...payOptions, canCharge: true });
    if (body.action === "charge" && S.declineOnce) { S.declineOnce = false; return json(route, { error: DECLINE }, 400); }
    if (body.action === "charge") return json(route, { ok: true, pending: true, amountCents: 100000 });
    return json(route, { ok: true, applies: null, percent: null });
  }
  if (url.includes("/portal-settings")) {
    if (body.action === "status") {
      return json(route, { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, invoiceInGhl: false, branding: {} });
    }
    if (body.action === "orders_designs") return json(route, { ok: true, designs: [] });
    return json(route, { ok: true });
  }
  return json(route, { ok: true });
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
if (MQ_OVERRIDE) await page.route(/\/my-quotes\.html/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: MQ_OVERRIDE }));
if (PORTAL_OVERRIDE) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: PORTAL_OVERRIDE }));

const waitText = (s, timeout = 15000) => page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const until = async (fn, timeout = 6000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(100)) if (await fn()) return true;
  return !!(await fn());
};
const callsOf = (fn, action) => fnCalls.filter((c) => c.fn === fn && c.body.action === action).map((c) => c.body);
const hasSecret = (text) => SECRETS.some((s) => String(text).includes(s));
const lastToken = () => `9999000${String(S.minted).padStart(5, "0")}${ACCOUNT.slice(-4)}`;

// One surface's run. `scope` is the panel/modal locator, `payBtn` the button that takes the money.
async function exercise(tag, { scope, payBtn, chargeFn, chargeAction, routingLabel, accountLabel, errorText }) {
  const routing = scope.getByLabel(routingLabel);
  const account = scope.getByLabel(accountLabel);

  // 1: two boxes, no iframe, and the ACH iframe URL never requested
  ok(`${tag}1: a Routing box and a Checking box`, (await routing.count()) === 1 && (await account.count()) === 1);
  ok(`${tag}1: no tokenizer iframe on the bank rail`, (await scope.locator("iframe").count()) === 0);
  ok(`${tag}1: the single-field ACH iframe URL was never requested`, !tokRequests.some((u) => u.includes("rail=ach")), tokRequests.join(" | "));
  // Against an old page there is nothing below to drive; say so and move to the next surface.
  if ((await routing.count()) !== 1 || (await account.count()) !== 1) {
    ok(`${tag}: the two boxes exist, so the rest of ${tag} can run`, false);
    return;
  }
  const attrs = async (l) => l.evaluate((el) => ({ mode: el.getAttribute("inputmode"), ac: el.getAttribute("autocomplete"), type: el.type, name: el.name || "" }));
  const ra = await attrs(routing), aa = await attrs(account);
  ok(`${tag}1: both boxes numeric, autofill off, plain text, unnamed`,
    [ra, aa].every((a) => a.mode === "numeric" && a.ac === "off" && a.type === "text" && !a.name), JSON.stringify([ra, aa]));
  ok(`${tag}1: the hint says where to find them`, await waitText("Find both at the bottom of a check."));
  ok(`${tag}1: the pay button starts disabled`, await payBtn().isDisabled());

  // 2: a bad check digit
  const before = tokenizeCalls.length;
  await routing.fill(ROUTING_BAD);
  await account.fill(ACCOUNT);
  await page.waitForTimeout(1200);
  ok(`${tag}2: 031201361 fails the ABA check — a sentence says so`, await waitText("That routing number doesn't look right", 3000));
  ok(`${tag}2: nothing was tokenized`, tokenizeCalls.length === before, String(tokenizeCalls.length - before));
  ok(`${tag}2: the pay button stays disabled`, await payBtn().isDisabled());
  await scope.screenshot({ path: join(shotsDir("achBankBoxes"), `${tag}-bad-routing.png`) }).catch(() => {});
  // A routing number one digit short, left, and then the account typed in full: the sentence
  // must survive the typing in the OTHER box (it used to vanish on the first account digit,
  // leaving a grey pay button and no reason).
  await routing.fill(ROUTING.slice(0, 8));
  await account.focus();
  await account.fill("");
  await account.pressSequentially(ACCOUNT);
  await account.blur();
  await page.waitForTimeout(300);
  ok(`${tag}2: a short routing number that was left is still reported after the account is typed`,
    await waitText("A routing number is 9 digits.", 3000));
  ok(`${tag}2: …nothing was tokenized, and the pay button stays disabled`,
    tokenizeCalls.length === before && await payBtn().isDisabled(), String(tokenizeCalls.length - before));

  // 3: the valid pair tokenizes once and arms the button
  await routing.fill(ROUTING);
  ok(`${tag}3: tokenized exactly once`, await until(() => tokenizeCalls.length === before + 1, 4000) && (await page.waitForTimeout(800), tokenizeCalls.length === before + 1),
    String(tokenizeCalls.length - before));
  const tc = tokenizeCalls[tokenizeCalls.length - 1] || { body: {} };
  ok(`${tag}3: the body is exactly "routing/account"`, tc.body.account === `${ROUTING}/${ACCOUNT}` && tc.method === "POST", JSON.stringify(tc.body));
  ok(`${tag}3: POSTed to the tokenize path with no query string`, tc.url === `${TOK_ORIGIN}/cardsecure/api/v1/ccn/tokenize`, tc.url);
  ok(`${tag}3: the pay button arms`, await until(async () => !(await payBtn().isDisabled()), 3000));
  // The armed state, for a person to look at (SS_SHOTS=<dir>, or a temp dir).
  await scope.screenshot({ path: join(shotsDir("achBankBoxes"), `${tag}-armed.png`) }).catch(() => {});
  const armedToken1 = lastToken();

  // 4: any edit disarms at once, then the new numbers re-arm it
  await account.press("End");
  await account.press("7");
  ok(`${tag}4: an edit disarms the button at once`, await payBtn().isDisabled());
  await account.press("Backspace");
  ok(`${tag}4: still disarmed straight after the second edit`, await payBtn().isDisabled());
  await page.waitForTimeout(1500);
  ok(`${tag}4: the restored numbers re-arm it`, await until(async () => !(await payBtn().isDisabled()), 3000));
  ok(`${tag}4: …with a NEW token`, lastToken() !== armedToken1, `${armedToken1} -> ${lastToken()}`);
  // A keystroke that changes no digit is not an edit. The portal used to clear the token and
  // then, the numbers being unchanged, never check them again: a dead Charge, nothing said.
  await account.press("End");
  await account.press("a");
  ok(`${tag}4: a non-digit keystroke leaves the number as it was`, (await account.inputValue()) === ACCOUNT);
  ok(`${tag}4: …and the pay button is (or is again) armed`, await until(async () => !(await payBtn().isDisabled()), 5000));

  // 5: a failed check shows our sentence, never CardSecure's reply; leaving a box retries
  S.tokFail = true;
  await account.fill(ACCOUNT.slice(0, -1));
  await account.fill(ACCOUNT);
  ok(`${tag}5: a failed check shows our sentence`, await waitText(errorText, 4000));
  const shown = await page.evaluate(() => document.body.innerText);
  ok(`${tag}5: CardSecure's reply (which echoes the numbers) is not on screen`, !hasSecret(shown) && !shown.includes("Invalid account"));
  ok(`${tag}5: the pay button stays disabled`, await payBtn().isDisabled());
  S.tokFail = false;
  const beforeRetry = tokenizeCalls.length;
  await routing.focus();
  await routing.blur();
  await account.focus();
  await account.blur();
  ok(`${tag}5: leaving a box with both numbers valid checks again and re-arms`,
    await until(() => tokenizeCalls.length > beforeRetry, 4000) && await until(async () => !(await payBtn().isDisabled()), 3000));
  // The same failure spelled the way Fiserv's own itoke.js decodes it: URL-encoded, in a 200.
  S.tokFail = "encoded";
  const beforeEnc = tokenizeCalls.length;
  await account.fill(ACCOUNT.slice(0, -1));
  await account.fill(ACCOUNT);
  ok(`${tag}5: an encoded "NNNN::" failure inside a 200 shows our sentence`,
    await until(() => tokenizeCalls.length > beforeEnc, 5000) && await waitText(errorText, 3000));
  ok(`${tag}5: …and does not arm the pay button`, await payBtn().isDisabled());
  S.tokFail = false;
  const beforeEncRetry = tokenizeCalls.length;
  await routing.focus();
  await routing.blur();
  await account.focus();
  await account.blur();
  ok(`${tag}5: …and leaving a box checks again and re-arms`,
    await until(() => tokenizeCalls.length > beforeEncRetry, 4000) && await until(async () => !(await payBtn().isDisabled()), 3000));

  // 6: a declined payment says so where the person is looking, and the button comes back
  const chargesBeforeDecline = callsOf(chargeFn, chargeAction).length;
  S.declineOnce = true;
  await payBtn().click();
  ok(`${tag}6: the declined attempt was sent`, await until(() => callsOf(chargeFn, chargeAction).length > chargesBeforeDecline, 6000));
  ok(`${tag}6: the decline is said INSIDE the ${tag === "M" ? "pay panel" : "modal"}`,
    await until(async () => (await scope.innerText()).includes(DECLINE), 6000));
  await routing.focus();
  await routing.blur();
  await account.focus();
  await account.blur();
  ok(`${tag}6: …and the pay button comes back`, await until(async () => !(await payBtn().isDisabled()), 5000));

  // 7: the charge carries the latest token, rail ach, and neither number
  const finalToken = lastToken();
  const chargesBefore = callsOf(chargeFn, chargeAction).length;
  await payBtn().click();
  ok(`${tag}7: the charge was sent`, await until(() => callsOf(chargeFn, chargeAction).length > chargesBefore, 6000));
  const charge = callsOf(chargeFn, chargeAction).slice(-1)[0] || {};
  ok(`${tag}7: it carries the latest token`, charge.payToken === finalToken, `${charge.payToken} vs ${finalToken}`);
  ok(`${tag}7: rail ach, no expiry`, charge.rail === "ach" && charge.expiry === undefined, JSON.stringify({ rail: charge.rail, expiry: charge.expiry }));
  ok(`${tag}7: the charge body holds neither number`, !hasSecret(JSON.stringify(charge)), JSON.stringify(charge));
}

try {
  // ── M: my-quotes.html ──
  await page.goto(`${BASE}/my-quotes.html?client=${CLIENT}`, { waitUntil: "domcontentloaded" });
  ok("M0: the quotes list renders", await waitText("AS-1066", 20000));
  await page.getByRole("button", { name: "Pay $1,000.00" }).first().click();
  const panel = page.locator(".sign-panel");
  await panel.waitFor({ timeout: 10000 });
  ok("M0: the panel opens on Card, with the card iframe", (await panel.locator("iframe").count()) === 1);
  await panel.getByRole("button", { name: "Bank account" }).click();
  await page.waitForTimeout(300);
  await exercise("M", {
    scope: panel,
    payBtn: () => panel.getByRole("button", { name: /^Pay \$/ }),
    chargeFn: "customer-pay", chargeAction: "pay",
    routingLabel: "Routing number", accountLabel: "Checking account number",
    errorText: "We couldn't check those bank details. Check both numbers and try again.",
  });
  ok("M8: a paid panel re-renders the list, and the boxes are gone with it",
    await until(async () => (await page.locator("#quotes-list input[inputmode=numeric]").count()) === 0, 4000));

  // ── P: the portal's Record-a-payment modal ──
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/portal/orders/o-${ORDER_ID}`);
  const recordBtn = page.getByRole("button", { name: "Record a payment" });
  ok("P0: the order opens with Record a payment", await recordBtn.waitFor({ timeout: 20000 }).then(() => true, () => false));
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Record a payment");
    return b && !b.disabled;
  }, null, { timeout: 15000 }).catch(() => {});
  await recordBtn.click();
  const modal = page.locator("div[style*='z-index: 1200']").last();
  await modal.waitFor({ timeout: 10000 });
  await modal.getByRole("button", { name: "Bank / ACH", exact: true }).click();
  ok("P0: picking Bank lands on Take it now", await waitText("Take a payment", 5000));
  await page.waitForTimeout(300);
  await exercise("P", {
    scope: modal,
    payBtn: () => modal.getByRole("button", { name: /^Charge \$/ }),
    chargeFn: "portal-payments", chargeAction: "charge",
    routingLabel: "Routing number", accountLabel: "Checking account number",
    errorText: "Those bank details couldn't be checked. Check both numbers and try again.",
  });
  ok("P8: the modal closes on success, and the boxes go with it",
    await waitText("Bank payment submitted", 6000) && (await page.locator("input[inputmode=numeric][autocomplete=off]").count()) === 0);

  // P9: an account WITHOUT online payments (every tenant until it is switched on): pay_options is
  // a 503 refusal, so there is no toggle back from "Take it now". Bank / ACH is picked while the
  // refusal is still on its way, then Card after it landed; both must end on Record payment,
  // with no bank boxes asking for numbers nothing would use.
  S.refusePayOptions = true;
  const optsBefore = callsOf("portal-payments", "pay_options").length;
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Record a payment");
    return b && !b.disabled;
  }, null, { timeout: 15000 }).catch(() => {});
  await recordBtn.click();
  const modal2 = page.locator("div[style*='z-index: 1200']").last();
  await modal2.waitFor({ timeout: 10000 });
  await modal2.getByRole("button", { name: "Bank / ACH", exact: true }).click();
  await until(() => callsOf("portal-payments", "pay_options").length > optsBefore, 6000);
  await page.waitForTimeout(2500);   // the refusal is held 1.5 s by the stub; let it land and render
  const recordingOnly = async () => (await modal2.getByLabel("Routing number").count()) === 0
    && (await modal2.getByLabel("Checking account number").count()) === 0
    && (await modal2.getByRole("button", { name: "Record payment", exact: true }).count()) === 1
    && (await modal2.getByRole("button", { name: /^Charge \$/ }).count()) === 0;
  ok("P9: Bank / ACH picked before the refusal landed ends on Record payment, with no bank boxes", await recordingOnly());
  await modal2.screenshot({ path: join(shotsDir("achBankBoxes"), "P-no-online-payments.png") }).catch(() => {});
  await modal2.getByRole("button", { name: "Card", exact: true }).click();
  await page.waitForTimeout(300);
  ok("P9: Card picked after the refusal lands on Record payment too", await recordingOnly());
  await modal2.getByRole("button", { name: "Cancel", exact: true }).click();
  S.refusePayOptions = false;

  // ── X: nowhere else, on either surface ──
  const storage = await page.evaluate(() => {
    const out = [];
    for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) out.push(s.key(i) + "=" + s.getItem(s.key(i)));
    return out.join("\n");
  });
  ok("X: neither number in localStorage or sessionStorage", !hasSecret(storage));
  ok("X: neither number in the URL", !hasSecret(page.url()), page.url());
  ok("X: neither number in the console", !consoleLines.some(hasSecret), consoleLines.filter(hasSecret).join(" | "));
  ok("X: neither number in the error log", !logged.some(hasSecret), logged.filter(hasSecret).join(" | "));
  const leaks = allRequests.filter((r) => (hasSecret(r.url) || hasSecret(r.body)) && !r.url.startsWith(`${TOK_ORIGIN}/cardsecure/api/v1/ccn/tokenize`));
  ok("X: the tokenize POST is the ONLY request that ever carried them", leaks.length === 0, leaks.map((r) => r.url).join(" | "));
  ok("X: no tokenize request ever carried a query string", tokenizeCalls.every((c) => !c.url.includes("?")));
  ok("X: no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
