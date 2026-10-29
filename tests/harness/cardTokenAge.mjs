// How long a card token may be held, on BOTH surfaces that take a card, driven for real with a fake
// clock: the customer's pay panel in my-quotes.html and the builder's Record-a-payment modal in the
// COMPILED portal.
//
// Fiserv (CardPointe integrations), 2026-10-14: the CVV stays linked to the CardSecure token for 2
// minutes. Both pages hold a card token for at most CARD_TOKEN_MAX_MS (100 s; scripts/preflight.mjs
// keeps the two copies equal) and treat it as spent once the gateway has seen it: the server says
// newCardNeeded, or answers 402 when it is older than that flag. page.clock moves Date.now() on
// without waiting two real minutes. The rest is cardBillingFields.mjs's setup: the tokenizer's origin
// is https://tok.example.test, answered locally, and a "token" is posted from inside that iframe the
// way the real tokenizer posts one, so nothing leaves the machine and no card number is ever typed.
//
//   M  my-quotes.html
//     M1 a card token 60 s old is charged, and it is that token
//     M2 at 101 s Pay sends nothing: the card frame is loaded again, the panel says card details are
//        only kept for 2 minutes, and Pay is off; the new frame's token then goes in one tap
//     M3 a pay answered 503 with newCardNeeded (not a 402, so the flag alone decides it): the card
//        frame is loaded again, the server's sentence shows with "Enter the card details again",
//        Pay is off and nothing more is sent; the next tap sends the NEW token, with no "The amount
//        to pay has changed" on the way
//     M4 the same for a bare 402 (a customer-pay older than newCardNeeded)
//     M5 a 429 (busy) and a 409 (a business rule), neither flagged nor a 402: they never reached
//        the gateway, so the same frame, Pay back on, and the next tap sends the same token
//     M6 the Bank account tab: a bank token 300 s old is still charged (bank tokens are not timed)
//     M7 the Bank account tab answered 402 with newCardNeeded: the flag is a card's, so the
//        Routing and Checking boxes keep what was typed, no card frame is loaded and Pay comes
//        back on
//   P  the portal's Record-a-payment modal
//     P1 keyed, 60 s: charged, with that token
//     P2 keyed, 101 s: no charge; the keyed frame is loaded again (empty), the modal says the
//        security code is only kept for 2 minutes, Charge is off; the new token is then charged
//     P3 keyed, a charge answered 503 with newCardNeeded (not a 402, so the flag alone decides
//        it): the frame is loaded again, the server's sentence shows with "Key the card in
//        again"; the new token is then charged
//     P4 swipe, 60 s: charged, entry swipe (Swipe arms the reader itself: no Ready press since
//        2026-10-21)
//     P5 swipe, 101 s: no charge; "That card read has expired. Swipe, insert or tap the card
//        again.", and a NEW reader frame loads by itself; a new swipe is then charged
//     P6 Card, then Swipe, then Bank / ACH, then Card: Key it in again; then Swipe and Bank / ACH,
//        and the bank charge, 300 s after its token, carries rail ach and NO entry
//     P8 swipe refused by the frame: the modal shows CardPointe's own code and words after "didn't get a
//        clean read" (the frame's 1001, with the chip hint, then CardSecure's NNNN), with card-like runs
//        cut and track-shaped words dropped, on screen and in the swipe_refused row (warn); 20 s of
//        silence after the reader starts typing files swipe_no_answer; a reader burst that reaches the
//        page is counted (swipe_missed_frame, keysOutsideFrame, armed), never kept, and arms the reader
//        again; nothing is charged
//     P7 keyed, a charge answered 429 with no flag: it never reached the gateway, so the keyed
//        frame is NOT loaded again and the server's sentence shows without "Key the card in
//        again"; that same frame's next token is then charged
//   R  a payment row's Refund (the Refund box since 348, partialRefund.mjs drives the rest of it)
//     R1 a bank payment still clearing whose void answers "already settled": no refund_payment is
//        sent, and the page's OWN sentence "This bank payment is still clearing. It can be
//        refunded once it clears." shows, not the void's "already settled" (the server's
//        refund_payment refusal has to match that wording; this check cannot see it)
//     R2 a card payment whose void answers "already settled": refunded, as before
//   X  no uncaught page errors; nothing went anywhere but the stubs
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root, after npm run compile)
//   node tests/harness/cardTokenAge.mjs            (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> and SS_MY_QUOTES=<an older my-quotes.html>
// serve those files instead, which is how to watch the checks fail against the pages before the age
// limit. Names and addresses are made up, and the bank numbers are a public ABA routing number and a
// synthetic account (the repo is public). No token or number is ever printed.
//
// ⚠️ NOTHING LEAVES THE MACHINE: every Supabase host and the tokenizer origin are answered here,
// every other non-local request is aborted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, reporter, shotsDir, BASE, REF } from "./lib.mjs";

const CLIENT = "harness-card-token-age";
const TOK_ORIGIN = "https://tok.example.test";
const NAME = "Pat Example";
const PREFILL = { name: NAME, street: "12 Main St", zip: "65801" };
const ROUTING = "031201360", ACCOUNT = "000987654321";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000c8", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const ORDER_ID = "11111111-2222-4333-8444-5555555555c8";
const TOKENIZER = {
  origin: TOK_ORIGIN,
  cardUrl: `${TOK_ORIGIN}/itoke/ajax-tokenizer.html?rail=card`,
  achUrl: `${TOK_ORIGIN}/itoke/ajax-tokenizer.html?rail=ach`,
  swipeUrl: `${TOK_ORIGIN}/itoke/ajax-tokenizer.html?rail=card&swipeonly=true`,
  cardHeight: 265, achHeight: 130,
};

// payNext / chargeNext: the next customer-pay `pay` / portal-payments `charge` gets this
// { status, body } once, instead of an approval. payments: the order's payment rows (R only).
const S = { minted: 0, payNext: null, chargeNext: null, payments: [] };
const fnCalls = [];         // { fn, body } for customer-pay / portal-payments
const loads = { card: 0, swipe: 0 };   // tokenizer frame loads: each one is a NEW frame
const logRows = [];                    // log_error bodies (P8 reads the swipe rows)
const offBox = [];          // non-local requests that were aborted

const MQ_OVERRIDE = process.env.SS_MY_QUOTES ? readFileSync(process.env.SS_MY_QUOTES, "utf8") : null;
const PORTAL_OVERRIDE = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

const { ok, failed, results } = reporter();

const { browser, ctx } = await launch({ width: 1280, height: 1100 });
await ctx.addInitScript(([ref, s, client, name]) => {
  try {
    localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s));
    localStorage.setItem("ssq_token_" + client, "harness-customer-token-0123456789abcdef");
    localStorage.setItem("ssq_name_" + client, name);
  } catch (_e) { /* storage blocked */ }
}, [REF, SESSION, CLIENT, NAME]);
const page = await ctx.newPage();
// The fake clock, before the first page loads. It keeps flowing at real speed (resume), so the pages'
// own timers (the fee wait, the bank check's 2 s pause) run as usual; fastForward is the only jump.
await page.clock.install();
await page.clock.resume();
const ff = (ms) => page.clock.fastForward(ms);
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("dialog", (d) => d.accept().catch(() => {}));

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// Registered FIRST so the specific handlers below override it (Playwright runs routes in reverse).
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => { offBox.push(new URL(route.request().url()).host); return route.abort(); });

// The tokenizer origin: a blank page standing in for CardPointe's iframe (each GET is a new frame),
// and CardSecure's tokenize for the bank boxes.
await page.route((u) => u.href.startsWith(TOK_ORIGIN + "/"), (route) => {
  const req = route.request();
  if (req.url().includes("/cardsecure/api/v1/ccn/tokenize")) {
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "Content-type", "access-control-allow-methods": "POST" }, body: "" });
    }
    S.minted += 1;
    const token = `9999000${String(S.minted).padStart(5, "0")}${ACCOUNT.slice(-4)}`;
    return json(route, { message: token, errorcode: 0, token });
  }
  if (req.url().includes("/itoke/")) loads[req.url().includes("swipeonly=true") ? "swipe" : "card"] += 1;
  return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>tokenizer stub</title><input id=ccnumfield>" });
});

const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  if (url.includes("/rest/v1/rpc/log_error")) { logRows.push(body); return json(route, null); }
  if (url.includes("/rest/v1/rpc/")) return json(route, false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
  if (url.includes("/rest/v1/orders")) {
    return json(route, [{ id: ORDER_ID, client_id: CLIENT, order_no: 1088, short_code: null, ordered_at: "2026-10-01T15:00:00Z", total_cents: 100000, total_source: "manual", notes: "Counter sale" }]);
  }
  if (/\/rest\/v1\/payments\?/.test(url) && req.method() === "GET") return json(route, S.payments);
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (/[?&]warm=1/.test(url)) return json(route, { ok: true });
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
  }
  if (url.includes("/customer-auth")) return json(route, { ok: true, channels: ["sms"], defaultChannel: "sms" });
  if (url.includes("/customer-quotes")) {
    return json(route, { ok: true, businessName: "Acme Sheds", name: NAME, quotes: [{
      quoteRef: "SS-TOKENAGE", estimateNumber: "AS-1088", status: "invoiced", total: 1000,
      invoice: { number: "SSI-1088", signedAt: "2026-10-01T15:00:00Z", pdfUrl: null },
    }] });
  }
  const payOptions = { ok: true, askCents: 100000, askKind: "balance", balanceCents: 100000, settledCents: 0, pendingCents: 0, depositCents: null, minCents: 100, maxCents: 5000000, tokenizer: TOKENIZER };
  if (url.includes("/customer-pay")) {
    fnCalls.push({ fn: "customer-pay", body });
    if (body.action === "pay_options") return json(route, { ...payOptions, canPay: true });
    if (body.action === "pay") {
      if (S.payNext) { const a = S.payNext; S.payNext = null; return json(route, a.body, a.status); }
      return json(route, body.rail === "ach"
        ? { ok: true, pending: true, amountCents: 100000, balanceCents: 100000 }
        : { ok: true, amountCents: 100000, balanceCents: 0, last4: "1111" });
    }
    return json(route, { ok: true, applies: false, percent: null, feeCents: null, chargeCents: 100000 });
  }
  if (url.includes("/portal-payments")) {
    fnCalls.push({ fn: "portal-payments", body });
    if (body.action === "pay_options") return json(route, { ...payOptions, canCharge: true, billingPrefill: PREFILL });
    if (body.action === "charge") {
      if (S.chargeNext) { const a = S.chargeNext; S.chargeNext = null; return json(route, a.body, a.status); }
      return json(route, body.rail === "ach" ? { ok: true, pending: true, amountCents: 100000 } : { ok: true, amountCents: 100000, last4: "1111" });
    }
    if (body.action === "void_payment") return json(route, { error: "That payment has already settled — refund it instead.", settled: true }, 409);
    if (body.action === "refund_payment") {
      const p = S.payments.find((x) => x.id === body.paymentId);
      return json(route, { ok: true, refunded: p ? p.amount_cents : 0 });
    }
    if (body.action === "reconcile") return json(route, { ok: true, updated: [] });
    return json(route, { ok: true, applies: false, percent: null });
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
const lastOf = (fn, action) => callsOf(fn, action).slice(-1)[0] || {};
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// What a body says about its token, without printing it.
const sent = (b, tok) => JSON.stringify({ rail: b.rail, entry: b.entry, hasEntry: has(b, "entry"), theToken: tok ? b.payToken === tok : undefined });
const textOf = (l) => l.innerText({ timeout: 1000 }).catch(() => "");
// The last of what a panel says, on one line, for a failing check's note.
const brief = async (l) => (await textOf(l)).replace(/[ \t\r\n]+/g, " ").slice(-180);
const offOf = (l) => l.isDisabled({ timeout: 1000 }).catch(() => false);
// A click that cannot wait 30 s and throw: against an older page the panel may already be gone
// (it charged where it should not have), and that is a FAIL to report, not a crash.
const tap = (l) => l.click({ timeout: 3000 }).catch(() => {});

/** Post a token from INSIDE the newest tokenizer iframe of that kind, the way CardPointe's own page
 *  does, so the listener's origin and source checks both pass. A frame that was replaced is gone
 *  from page.frames(), and a token posted from it would be refused by the page anyway. */
async function postToken(swipe = false) {
  S.minted += 1;
  const tok = `94139487802${String(S.minted).padStart(5, "0")}`;
  const frame = await (async () => {
    for (const end = Date.now() + 8000; Date.now() < end; await page.waitForTimeout(100)) {
      const f = page.frames().filter((x) => !x.isDetached() && x.url().startsWith(TOK_ORIGIN) && x.url().includes("swipeonly=true") === swipe).pop();
      if (f) return f;
    }
    return null;
  })();
  if (!frame) return null;
  await frame.waitForLoadState("domcontentloaded").catch(() => {});
  await frame.evaluate(([t, entry]) => window.parent.postMessage(JSON.stringify({ message: t, token: t, expiry: "203212", errorCode: "0", errorMessage: "", entry }), "*"), [tok, swipe ? "swipe" : "manual"]);
  return tok;
}

try {
  // ── M: my-quotes.html ──────────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/my-quotes.html?client=${CLIENT}`, { waitUntil: "domcontentloaded" });
  ok("M0: the quotes list renders", await waitText("AS-1088", 20000));
  const outerPay = () => page.getByRole("button", { name: "Pay $1,000.00" });
  // The pay panel, card tab, with the street and ZIP typed, so Pay has nothing else to ask for.
  const openPanel = async () => {
    await until(async () => (await outerPay().count()) > 0, 8000);
    await outerPay().first().click();
    const panel = page.locator(".sign-panel");
    await panel.waitFor({ timeout: 10000 });
    await panel.getByLabel("Billing street address").fill("1 Card Lane");
    await panel.getByLabel("Billing ZIP code").fill("65801");
    await panel.getByLabel("Billing ZIP code").blur();
    return panel;
  };
  // A token, and its fee answer on screen ("No card fee on this card."), so Pay goes in one tap.
  const cardReady = async (panel) => {
    await until(async () => loads.card > 0, 4000);
    const tok = await postToken();
    const fee = await until(async () => (await textOf(panel)).includes("No card fee on this card."), 5000);
    return fee ? tok : null;
  };
  const mqPay = (panel) => panel.getByRole("button", { name: /^(Pay \$|Checking card fee|Paying)/ });
  const EXPIRED = "For your security, card details are only kept for 2 minutes. Enter the card again, then tap Pay.";

  // M1: 60 s is inside the limit.
  let panel = await openPanel();
  let tok = await cardReady(panel);
  ok("M1: a token and its fee answer are in", !!tok);
  await ff(60_000);
  let pays = callsOf("customer-pay", "pay").length;
  await tap(mqPay(panel));
  ok("M1: 60 s on, Pay sends the charge, with that token",
    await until(() => callsOf("customer-pay", "pay").length > pays, 6000) && lastOf("customer-pay", "pay").payToken === tok,
    sent(lastOf("customer-pay", "pay"), tok));

  // M2: 101 s is past it.
  panel = await openPanel();
  tok = await cardReady(panel);
  let before = loads.card;
  pays = callsOf("customer-pay", "pay").length;
  await ff(101_000);
  await tap(mqPay(panel));
  ok("M2: 101 s on, the panel says the card details are only kept for 2 minutes",
    await until(async () => (await textOf(panel)).includes(EXPIRED), 4000), await brief(panel));
  ok("M2: …the card frame is loaded again", await until(async () => loads.card === before + 1, 4000), `${loads.card - before} new frame(s)`);
  await page.waitForTimeout(500);
  ok("M2: …nothing was sent, and Pay is off", callsOf("customer-pay", "pay").length === pays && await offOf(mqPay(panel)));
  await panel.screenshot({ path: join(shotsDir("cardTokenAge"), "M2-expired.png") }).catch(() => {});
  let tok2 = await postToken();
  ok("M2: the new frame's token re-arms Pay, and the fee is asked for it",
    !!tok2 && await until(async () => !(await offOf(mqPay(panel))) && (await textOf(panel)).includes("No card fee on this card."), 5000));
  await tap(mqPay(panel));
  ok("M2: …one tap sends the charge, with the NEW token",
    await until(() => callsOf("customer-pay", "pay").length > pays, 6000) && lastOf("customer-pay", "pay").payToken === tok2 && tok2 !== tok,
    sent(lastOf("customer-pay", "pay"), tok2));

  // M3 / M4: the gateway saw the card. newCardNeeded on a status that is NOT 402 (the page also
  // treats a bare 402 as spent, so a 402 here would pass with the flag ignored), then a bare 402
  // from an older server.
  for (const [tag, answer] of [
    ["M3", { status: 503, body: { error: "The card network did not finish this payment.", blocking: false, newCardNeeded: true } }],
    ["M4", { status: 402, body: { error: "Insufficient funds.", blocking: false } }],
  ]) {
    const why = answer.body.error;
    panel = await openPanel();
    tok = await cardReady(panel);
    before = loads.card;
    pays = callsOf("customer-pay", "pay").length;
    S.payNext = answer;
    await tap(mqPay(panel));
    ok(`${tag}: the declined pay went out with the token`,
      await until(() => callsOf("customer-pay", "pay").length > pays, 6000) && lastOf("customer-pay", "pay").payToken === tok);
    ok(`${tag}: the panel says why, and to enter the card again`,
      await until(async () => {
        const t = await textOf(panel);
        return t.includes(why) && t.includes("Enter the card details again");
      }, 4000), await brief(panel));
    ok(`${tag}: …the card frame is loaded again`, await until(async () => loads.card === before + 1, 4000), `${loads.card - before} new frame(s)`);
    await page.waitForTimeout(500);
    ok(`${tag}: …Pay is off, and nothing more was sent`, await offOf(mqPay(panel)) && callsOf("customer-pay", "pay").length === pays + 1);
    if (tag === "M3") await panel.screenshot({ path: join(shotsDir("cardTokenAge"), "M3-declined.png") }).catch(() => {});
    tok2 = await postToken();
    ok(`${tag}: the new token re-arms Pay`, !!tok2 && await until(async () => !(await offOf(mqPay(panel))) && (await textOf(panel)).includes("No card fee on this card."), 5000));
    await tap(mqPay(panel));
    ok(`${tag}: …and the next tap sends the NEW token, with no "amount has changed" on the way`,
      await until(() => callsOf("customer-pay", "pay").length > pays + 1, 6000)
      && lastOf("customer-pay", "pay").payToken === tok2 && tok2 !== tok && !(await textOf(panel)).includes("The amount to pay has changed"),
      sent(lastOf("customer-pay", "pay"), tok2));
  }

  // M5: a refusal before the gateway keeps the card as typed: busy, then a business rule.
  for (const answer of [
    { status: 429, body: { error: "The payment system is busy. Try again in a moment.", blocking: false } },
    { status: 409, body: { error: "This invoice is waiting on a change to be signed first.", blocking: false } },
  ]) {
    const tag = `M5 (${answer.status})`;
    panel = await openPanel();
    tok = await cardReady(panel);
    before = loads.card;
    pays = callsOf("customer-pay", "pay").length;
    S.payNext = answer;
    await tap(mqPay(panel));
    ok(`${tag}: it says so, and Pay comes back on`,
      await until(async () => (await textOf(panel)).includes(answer.body.error) && !(await offOf(mqPay(panel))), 5000), await brief(panel));
    ok(`${tag}: …the card frame is NOT loaded again, nor the card asked for`,
      loads.card === before && !(await textOf(panel)).includes("Enter the card details again"), `${loads.card - before} new frame(s)`);
    await tap(mqPay(panel));
    ok(`${tag}: …and the next tap sends the same token`,
      await until(() => callsOf("customer-pay", "pay").length > pays + 1, 6000) && lastOf("customer-pay", "pay").payToken === tok,
      sent(lastOf("customer-pay", "pay"), tok));
  }

  // M6: the bank tab is not timed.
  await until(async () => (await outerPay().count()) > 0, 8000);
  await outerPay().first().click();
  panel = page.locator(".sign-panel");
  await panel.waitFor({ timeout: 10000 });
  await panel.getByRole("button", { name: "Bank account" }).click();
  await panel.getByLabel("Routing number").fill(ROUTING);
  await panel.getByLabel("Checking account number").fill(ACCOUNT);
  ok("M6: the bank details are checked", await until(async () => (await textOf(panel)).includes("Bank details ready"), 8000));
  await ff(300_000);
  pays = callsOf("customer-pay", "pay").length;
  await tap(mqPay(panel));
  ok("M6: 300 s on, the bank payment still goes, rail ach",
    await until(() => callsOf("customer-pay", "pay").length > pays, 6000) && lastOf("customer-pay", "pay").rail === "ach" && !(await textOf(page.locator("body"))).includes(EXPIRED),
    sent(lastOf("customer-pay", "pay")));

  // M7: newCardNeeded on the bank tab is ignored: a new card frame would empty the bank boxes.
  await until(async () => (await outerPay().count()) > 0, 8000);
  await outerPay().first().click();
  panel = page.locator(".sign-panel");
  await panel.waitFor({ timeout: 10000 });
  await panel.getByRole("button", { name: "Bank account" }).click();
  await panel.getByLabel("Routing number").fill(ROUTING);
  await panel.getByLabel("Checking account number").fill(ACCOUNT);
  ok("M7: the bank details are checked", await until(async () => (await textOf(panel)).includes("Bank details ready"), 8000));
  before = loads.card;
  pays = callsOf("customer-pay", "pay").length;
  S.payNext = { status: 402, body: { error: "The bank turned this debit down.", blocking: false, newCardNeeded: true } };
  await tap(mqPay(panel));
  ok("M7: the declined bank pay went out, rail ach",
    await until(() => callsOf("customer-pay", "pay").length > pays, 6000) && lastOf("customer-pay", "pay").rail === "ach",
    sent(lastOf("customer-pay", "pay")));
  ok("M7: …the panel says why, Pay comes back on, and it does not ask for a card",
    await until(async () => (await textOf(panel)).includes("The bank turned this debit down.") && !(await offOf(mqPay(panel))), 5000)
    && !(await textOf(panel)).includes("Enter the card details again"), await brief(panel));
  // Compared as digits, never printed.
  const boxDigits = async (label) => (await panel.getByLabel(label).inputValue({ timeout: 1000 }).catch(() => "")).replace(/\D/g, "");
  ok("M7: …the Routing and Checking boxes still hold what was typed, and no card frame was loaded",
    await boxDigits("Routing number") === ROUTING && await boxDigits("Checking account number") === ACCOUNT && loads.card === before,
    `${loads.card - before} new frame(s)`);

  // ── P: the portal's Record-a-payment modal ────────────────────────────────────────────────────
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/orders/o-${ORDER_ID}`);
  const recordBtn = page.getByRole("button", { name: "Record a payment" });
  ok("P0: the order opens with Record a payment", await recordBtn.waitFor({ timeout: 20000 }).then(() => true, () => false));
  const openModal = async () => {
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Record a payment");
      return b && !b.disabled;
    }, null, { timeout: 15000 }).catch(() => {});
    await recordBtn.click();
    const modal = page.locator("div[style*='z-index: 1200']").last();
    await modal.waitFor({ timeout: 10000 });
    await modal.getByRole("button", { name: "Card", exact: true }).click();
    await waitText("Take a payment", 5000);
    return modal;
  };
  const chargeBtn = (modal) => modal.getByRole("button", { name: /^(Charge \$|Checking card fee|Charging)/ });
  // A card names its last 4 since 2026-10-21 ("Charge $1,000.00 to **** 0001"); a bank token doesn't.
  const armedCharge = (modal) => until(async () => /^Charge \$1,000\.00( to \*\*\*\* \d{4})?$/.test(await textOf(chargeBtn(modal))) && !(await offOf(chargeBtn(modal))), 5000);
  const KEYED_EXPIRED = "The card details expired: the security code is only kept for 2 minutes. Key the card in again, then press Charge.";
  const SWIPE_EXPIRED = "That card read has expired. Swipe, insert or tap the card again.";
  // The reader panel's state (data-ss-reader-state). This stub frame never takes the focus, so an
  // armed reader settles on "click" ("Click here, then swipe…"); a real one would say "waiting".
  const readerSt = () => page.evaluate(() => { const el = document.querySelector("[data-ss-reader-state]"); return el ? el.getAttribute("data-ss-reader-state") : null; });
  const readerArmed = () => until(async () => ["click", "waiting"].includes(await readerSt()), 6000);
  const noReadyButton = async (modal) => (await modal.getByRole("button", { name: /^Ready/ }).count()) === 0;

  // P1: keyed, 60 s.
  let modal = await openModal();
  tok = await postToken();
  ok("P1: a keyed token arms Charge", !!tok && await armedCharge(modal));
  await ff(60_000);
  let charges = callsOf("portal-payments", "charge").length;
  await tap(chargeBtn(modal));
  ok("P1: 60 s on, Charge sends it, with that token, entry keyed",
    await until(() => callsOf("portal-payments", "charge").length > charges, 6000)
    && lastOf("portal-payments", "charge").payToken === tok && lastOf("portal-payments", "charge").entry === "keyed",
    sent(lastOf("portal-payments", "charge"), tok));

  // P2: keyed, 101 s.
  modal = await openModal();
  tok = await postToken();
  ok("P2: a keyed token arms Charge", !!tok && await armedCharge(modal));
  before = loads.card;
  charges = callsOf("portal-payments", "charge").length;
  await ff(101_000);
  await tap(chargeBtn(modal));
  ok("P2: 101 s on, the modal says the security code is only kept for 2 minutes",
    await until(async () => (await textOf(modal)).includes(KEYED_EXPIRED), 4000), await brief(modal));
  ok("P2: …the keyed frame is loaded again (empty)", await until(async () => loads.card === before + 1, 4000), `${loads.card - before} new frame(s)`);
  await page.waitForTimeout(500);
  ok("P2: …nothing was charged, and Charge is off", callsOf("portal-payments", "charge").length === charges && await offOf(chargeBtn(modal)));
  await modal.screenshot({ path: join(shotsDir("cardTokenAge"), "P2-expired.png") }).catch(() => {});
  tok2 = await postToken();
  ok("P2: the new frame's token re-arms Charge", !!tok2 && await armedCharge(modal));
  await tap(chargeBtn(modal));
  ok("P2: …and Charge sends the NEW token",
    await until(() => callsOf("portal-payments", "charge").length > charges, 6000) && lastOf("portal-payments", "charge").payToken === tok2 && tok2 !== tok,
    sent(lastOf("portal-payments", "charge"), tok2));

  // P3: keyed, the gateway saw it. A 503, not a 402, so only newCardNeeded can say the card is spent.
  modal = await openModal();
  tok = await postToken();
  ok("P3: a keyed token arms Charge", !!tok && await armedCharge(modal));
  before = loads.card;
  charges = callsOf("portal-payments", "charge").length;
  S.chargeNext = { status: 503, body: { error: "The card network did not finish this payment.", blocking: false, newCardNeeded: true } };
  await tap(chargeBtn(modal));
  ok("P3: the failed charge went out with the token",
    await until(() => callsOf("portal-payments", "charge").length > charges, 6000) && lastOf("portal-payments", "charge").payToken === tok);
  ok("P3: the modal says why, and to key the card in again",
    await until(async () => (await textOf(modal)).includes("The card network did not finish this payment. Key the card in again, then press Charge."), 4000), await brief(modal));
  ok("P3: …the keyed frame is loaded again", await until(async () => loads.card === before + 1, 4000), `${loads.card - before} new frame(s)`);
  ok("P3: …and Charge is off", await offOf(chargeBtn(modal)));
  tok2 = await postToken();
  ok("P3: the new token re-arms Charge", !!tok2 && await armedCharge(modal));
  await tap(chargeBtn(modal));
  ok("P3: …and Charge sends the NEW token",
    await until(() => callsOf("portal-payments", "charge").length > charges + 1, 6000) && lastOf("portal-payments", "charge").payToken === tok2 && tok2 !== tok,
    sent(lastOf("portal-payments", "charge"), tok2));

  // P4: swipe, 60 s. Swipe arms the reader on its own; the token comes once that frame is up.
  modal = await openModal();
  await modal.getByRole("button", { name: "Swipe", exact: true }).click();
  ok("P4: choosing Swipe arms the reader, with no Ready button", await readerArmed() && await noReadyButton(modal), String(await readerSt()));
  tok = await postToken(true);
  ok("P4: a swipe token arms Charge", !!tok && await armedCharge(modal));
  await ff(60_000);
  charges = callsOf("portal-payments", "charge").length;
  await tap(chargeBtn(modal));
  ok("P4: 60 s on, Charge sends it, entry swipe",
    await until(() => callsOf("portal-payments", "charge").length > charges, 6000)
    && lastOf("portal-payments", "charge").payToken === tok && lastOf("portal-payments", "charge").entry === "swipe",
    sent(lastOf("portal-payments", "charge"), tok));

  // P5: swipe, 101 s.
  modal = await openModal();
  await modal.getByRole("button", { name: "Swipe", exact: true }).click();
  await readerArmed();
  tok = await postToken(true);
  ok("P5: a swipe token arms Charge", !!tok && await armedCharge(modal));
  charges = callsOf("portal-payments", "charge").length;
  before = loads.swipe;
  await ff(101_000);
  await tap(chargeBtn(modal));
  ok("P5: 101 s on, the modal says the card read has expired, and to swipe, insert or tap again",
    await until(async () => (await textOf(modal)).includes(SWIPE_EXPIRED), 4000), await brief(modal));
  await page.waitForTimeout(500);
  ok("P5: …nothing was charged, and Charge is off",
    callsOf("portal-payments", "charge").length === charges && await offOf(chargeBtn(modal)));
  ok("P5: …and a NEW reader frame is up by itself, with no Ready button",
    await until(async () => loads.swipe === before + 1, 4000) && await readerArmed() && await noReadyButton(modal),
    `${loads.swipe - before} new frame(s), ${await readerSt()}`);
  await modal.screenshot({ path: join(shotsDir("cardTokenAge"), "P5-swipe-expired.png") }).catch(() => {});
  tok2 = await postToken(true);
  ok("P5: a new swipe re-arms Charge", !!tok2 && await armedCharge(modal));
  await tap(chargeBtn(modal));
  ok("P5: …and Charge sends the NEW swipe",
    await until(() => callsOf("portal-payments", "charge").length > charges, 6000)
    && lastOf("portal-payments", "charge").payToken === tok2 && tok2 !== tok && lastOf("portal-payments", "charge").entry === "swipe",
    sent(lastOf("portal-payments", "charge"), tok2));

  // P6: Card, Swipe, Bank / ACH: no entry on a bank charge, and no age limit on a bank token.
  modal = await openModal();
  await modal.getByRole("button", { name: "Swipe", exact: true }).click();
  await modal.getByRole("button", { name: "Bank / ACH", exact: true }).click();
  await modal.getByRole("button", { name: "Card", exact: true }).click();
  ok("P6: Card, Swipe, Bank / ACH, then Card again starts on Key it in",
    await until(async () => /card details/i.test(await textOf(modal)) && !/card reader/i.test(await textOf(modal)), 3000), await brief(modal));
  await modal.getByRole("button", { name: "Swipe", exact: true }).click();
  await modal.getByRole("button", { name: "Bank / ACH", exact: true }).click();
  await modal.getByLabel("Routing number").fill(ROUTING);
  await modal.getByLabel("Checking account number").fill(ACCOUNT);
  ok("P6: the bank details are captured", await until(async () => (await textOf(modal)).includes("Bank details captured"), 8000));
  await ff(300_000);
  charges = callsOf("portal-payments", "charge").length;
  await modal.getByRole("button", { name: /^Charge \$/ }).click();
  ok("P6: 300 s on, the bank charge goes, rail ach, with NO entry",
    await until(() => callsOf("portal-payments", "charge").length > charges, 6000)
    && lastOf("portal-payments", "charge").rail === "ach" && !has(lastOf("portal-payments", "charge"), "entry"),
    sent(lastOf("portal-payments", "charge")));

  // P7: keyed, a 429 with no flag: refused before the gateway, so the keyed frame stays.
  modal = await openModal();
  tok = await postToken();
  ok("P7: a keyed token arms Charge", !!tok && await armedCharge(modal));
  before = loads.card;
  charges = callsOf("portal-payments", "charge").length;
  S.chargeNext = { status: 429, body: { error: "The payment system is busy. Try again in a moment.", blocking: false } };
  await tap(chargeBtn(modal));
  ok("P7: the refused charge went out with the token",
    await until(() => callsOf("portal-payments", "charge").length > charges, 6000) && lastOf("portal-payments", "charge").payToken === tok);
  ok("P7: the modal says why, and does not ask for the card to be keyed in again",
    await until(async () => (await textOf(modal)).includes("The payment system is busy."), 4000)
    && !(await textOf(modal)).includes("Key the card in again"), await brief(modal));
  await page.waitForTimeout(500);
  ok("P7: …the keyed frame is NOT loaded again", loads.card === before, `${loads.card - before} new frame(s)`);
  tok2 = await postToken();
  ok("P7: that same frame's next token re-arms Charge", !!tok2 && await armedCharge(modal));
  await tap(chargeBtn(modal));
  ok("P7: …and Charge sends it, still from the first frame",
    await until(() => callsOf("portal-payments", "charge").length > charges + 1, 6000)
    && lastOf("portal-payments", "charge").payToken === tok2 && tok2 !== tok && loads.card === before,
    sent(lastOf("portal-payments", "charge"), tok2));

  // P8: a swipe the frame refuses shows CardPointe's own reason, and files it without card data.
  {
    const postRaw = async (payload) => {
      let f = null;
      for (const end = Date.now() + 8000; !f && Date.now() < end; await page.waitForTimeout(100)) {
        f = page.frames().filter((x) => !x.isDetached() && x.url().startsWith(TOK_ORIGIN) && x.url().includes("swipeonly=true")).pop() || null;
      }
      if (!f) return false;
      await f.waitForLoadState("domcontentloaded").catch(() => {});
      await f.evaluate((m) => window.parent.postMessage(JSON.stringify(m), "*"), payload);
      return true;
    };
    const MISS = "The reader didn't get a clean read. Swipe, insert or tap the card again.";
    const CHIP_HINT = "If the card has a chip, insert it chip-first.";
    const rowsSince = (n, code) => logRows.slice(n).filter((r) => r.p_code === code);
    // Arming by hand (the reader box's own click target): a NEW frame, and a fresh run of the three
    // re-arms the page makes by itself, which this many refusals in a row would otherwise use up.
    const ready = async () => {
      const before = loads.swipe;
      await tap(modal.locator("[data-ss-reader-cover='1']"));
      await until(async () => loads.swipe > before, 4000);
      await readerArmed();
    };
    modal = await openModal();
    const swipeLoads = loads.swipe;
    await modal.getByRole("button", { name: "Swipe", exact: true }).click();
    await until(async () => loads.swipe > swipeLoads, 4000);
    await readerArmed();
    charges = callsOf("portal-payments", "charge").length;

    // The frame's own verdict, in the shape its script posts it: validationError, errorCode 1001, entry manual.
    let n = logRows.length;
    await postRaw({ validationError: "Invalid Account Number", errorCode: "1001", errorMessage: "Invalid Account Number", entry: "manual" });
    ok("P8: a validationError shows the frame's code and words after the clean-read sentence, and the chip hint (1001)",
      await until(async () => (await textOf(modal)).includes(MISS + " (CardPointe: code 1001, Invalid Account Number) " + CHIP_HINT), 4000), await brief(modal));
    const v = rowsSince(n, "swipe_refused")[0] || {};
    ok("P8: ...and files one swipe_refused row (warn, kind validation, code 1001, entry manual, the frame's host)",
      rowsSince(n, "swipe_refused").length === 1 && v.p_severity === "warn" && v.p_context && v.p_context.kind === "validation"
      && v.p_context.errorCode === "1001" && v.p_context.reason === "Invalid Account Number" && v.p_context.entry === "manual"
      && v.p_context.frame === new URL(TOK_ORIGIN).host, JSON.stringify(v.p_context || null));

    // CardSecure's answer (NNNN::words) with card-like numbers in the words: every run of 4+ digits goes.
    await ready();
    n = logRows.length;
    const SPACED = "4111 1111 1111 1111", DASHED = "4111-1111-1111-1111", SHORT = "4111111", HEXISH = "ABCDEF0123456789ABCDEF";
    await postRaw({ errorCode: "0007", errorMessage: "Unable to decrypt ref " + [SHORT, SPACED, DASHED, HEXISH].join(" "), entry: "swipe" });
    const shown = await until(async () => (await textOf(modal)).includes(MISS + " (CardPointe: code 0007, Unable to decrypt ref"), 4000);
    let txt = await textOf(modal);
    ok("P8: an errorCode shows the 4-digit code and the words", shown, await brief(modal));
    ok("P8: ...and no chip hint: that is the 1001's alone", !txt.includes(CHIP_HINT));
    ok("P8: ...with every 4+ digit run (plain, spaced, dashed) and the hex run cut from the screen",
      ![SHORT, SPACED, DASHED, HEXISH, "1111"].some((x) => txt.includes(x)));
    const e = rowsSince(n, "swipe_refused")[0] || {};
    // The fields that carry CardPointe's words (the test order id and url are 1111..., so not those).
    const eJson = JSON.stringify([e.p_message, e.p_context && e.p_context.reason, e.p_context && e.p_context.errorCode]);
    ok("P8: ...and from the swipe_refused row (kind error, code 0007)",
      !!e.p_context && e.p_context.kind === "error" && e.p_context.errorCode === "0007" && ![SHORT, SPACED, DASHED, HEXISH, "1111"].some((x) => eJson.includes(x)),
      JSON.stringify(e.p_context || null));

    // Words shaped like track data are dropped whole; only the code stays.
    await ready();
    n = logRows.length;
    await postRaw({ errorCode: "0008", errorMessage: "%*4111********1111^DOE/JOHN^2512*?", entry: "swipe" });
    const trackShown = await until(async () => (await textOf(modal)).includes(MISS + " (CardPointe: code 0008)"), 4000);
    txt = await textOf(modal);
    const t = rowsSince(n, "swipe_refused")[0] || {};
    ok("P8: words shaped like track data are dropped from the screen and the row; the code stays",
      trackShown && !txt.includes("DOE") && !!t.p_context && t.p_context.reason === null && t.p_context.errorCode === "0008"
      && !JSON.stringify(t).includes("DOE"), JSON.stringify(t.p_context || null));

    // Silence after the reader starts typing: the 20 s timer files swipe_no_answer.
    await ready();
    n = logRows.length;
    await postRaw({ cardTyping: true });
    await page.waitForTimeout(200);
    await ff(21_000);
    ok("P8: a read with no answer says it didn't go through",
      await until(async () => (await textOf(modal)).includes("That card didn't go through. Try it again, or key the card in."), 4000), await brief(modal));
    const s = rowsSince(n, "swipe_no_answer")[0] || {};
    ok("P8: ...and files one swipe_no_answer row (warn, waited 20 s)",
      rowsSince(n, "swipe_no_answer").length === 1 && s.p_severity === "warn" && s.p_context && s.p_context.waitedMs === 20000,
      JSON.stringify(s.p_context || null));

    // A swipe whose START reaches the page (focus outside the card box) and whose rest the frame
    // refuses: the page recognises a reader-speed burst (4 keys under 15 ms apart), counts it (never
    // the keys), files swipe_missed_frame once the keys stop, and the frame's swipe_refused row
    // carries the same count.
    await ready();
    await modal.getByText("Take a payment").first().click();
    n = logRows.length;
    const typedAt = Date.now();
    await page.keyboard.type("02AB");
    await postRaw({ validationError: "Invalid Account Number", errorCode: "1001", errorMessage: "Invalid Account Number", entry: "manual" });
    const filedFast = await until(async () => rowsSince(n, "swipe_refused").length > 0 && rowsSince(n, "swipe_missed_frame").length > 0, 1200);
    const filedIn = Date.now() - typedAt;
    const pr = rowsSince(n, "swipe_refused")[0] || {};
    const pm = rowsSince(n, "swipe_missed_frame")[0] || {};
    ok("P8: keys that reached the page are counted on the swipe_refused row (keysOutsideFrame 4)",
      !!pr.p_context && pr.p_context.keysOutsideFrame === 4, JSON.stringify(pr.p_context || null));
    ok("P8: ...swipe_missed_frame (warn, keys 4, armed) is filed as soon as the keys stop",
      filedFast && filedIn < 1400 && pm.p_severity === "warn" && pm.p_context && pm.p_context.keys === 4 && pm.p_context.armed === true,
      `${filedIn} ms ` + JSON.stringify(pm.p_context || null));
    ok("P8: ...neither row holds the keys",
      !JSON.stringify(pm).includes("02AB") && !JSON.stringify(pr).includes("02AB"));
    ok("P8: ...with the timings: arming to frame load, and frame load to the first key (ms)",
      !!pr.p_context && typeof pr.p_context.readyToLoadMs === "number" && pr.p_context.readyToLoadMs >= 0
      && typeof pr.p_context.loadToFirstKeyMs === "number" && typeof pm.p_context.loadToFirstKeyMs === "number"
      && pm.p_context.frameLoadedFirst === true, JSON.stringify(pm.p_context || null));
    await page.waitForTimeout(1800);
    ok("P8: ...and only one swipe_missed_frame row for that burst", rowsSince(n, "swipe_missed_frame").length === 1);

    // A second refusal from the frame, with no new burst: it starts from zero, not the first one's count.
    n = logRows.length;
    await readerArmed();
    await postRaw({ validationError: "Invalid Account Number", errorCode: "1001", errorMessage: "Invalid Account Number", entry: "manual" });
    await until(async () => rowsSince(n, "swipe_refused").length > 0, 4000);
    const p2 = rowsSince(n, "swipe_refused")[0] || {};
    ok("P8: a second refusal doesn't repeat the first one's count (keysOutsideFrame 0)",
      !!p2.p_context && p2.p_context.keysOutsideFrame === 0, JSON.stringify(p2.p_context || null));

    // The whole swipe reaches the page and the frame never answers: the burst's quiet ends it, and
    // the Shift that comes with a capital letter is swallowed but not counted.
    await ready();
    await modal.getByText("Take a payment").first().click();
    n = logRows.length;
    const loadsBurst = loads.swipe;
    await page.keyboard.type("02AB");
    await page.keyboard.down("Shift"); await page.keyboard.press("C"); await page.keyboard.up("Shift");
    await page.waitForTimeout(2000);
    const tm = rowsSince(n, "swipe_missed_frame");
    ok("P8: with no frame answer, one swipe_missed_frame row: 5 characters, Shift not counted",
      tm.length === 1 && tm[0].p_context && tm[0].p_context.keys === 5, JSON.stringify(tm.map((r) => r.p_context)));
    ok("P8: ...the modal says the card went to the page, and the reader is armed again by itself (no Ready button)",
      (await textOf(modal)).includes("The card went to the page, not the card reader.") && loads.swipe > loadsBurst && await readerArmed() && await noReadyButton(modal),
      await brief(modal));

    // An arming starts the count again.
    await ready();
    n = logRows.length;
    await postRaw({ validationError: "Invalid Account Number", errorCode: "1001", errorMessage: "Invalid Account Number", entry: "manual" });
    await until(async () => rowsSince(n, "swipe_refused").length > 0, 4000);
    const pz = rowsSince(n, "swipe_refused")[0] || {};
    ok("P8: an arming starts the count again (keysOutsideFrame 0)", !!pz.p_context && pz.p_context.keysOutsideFrame === 0, JSON.stringify(pz.p_context || null));

    // Two typed keys at a person's pace on the page: no burst, nothing swallowed, no row.
    await ready();
    await modal.getByText("Take a payment").first().click();
    n = logRows.length;
    await page.keyboard.press("KeyQ"); await page.waitForTimeout(120); await page.keyboard.press("KeyW");
    await page.waitForTimeout(800);
    ok("P8: a person's two keys on the page are not a reader burst: no swipe_missed_frame row", rowsSince(n, "swipe_missed_frame").length === 0);

    await page.waitForTimeout(300);
    ok("P8: nothing was charged and Charge is off", callsOf("portal-payments", "charge").length === charges && await offOf(chargeBtn(modal)));
    await modal.screenshot({ path: join(shotsDir("cardTokenAge"), "P8-swipe-refused.png") }).catch(() => {});
    await tap(modal.getByRole("button", { name: "Cancel" }));
  }

  // ── R: Refund on a payment row ────────────────────────────────────────────────────────────────
  const now = await page.evaluate(() => new Date().toISOString());
  S.payments = [
    { id: "aaaaaaaa-0000-4000-8000-0000000000c1", client_id: CLIENT, order_id: ORDER_ID, amount_cents: 10000, method: "ach",
      gateway: "cardpointe", funding_state: "pending", received_at: now, voided_at: null, reference: null, instrument_last4: null },
    { id: "aaaaaaaa-0000-4000-8000-0000000000c2", client_id: CLIENT, order_id: ORDER_ID, amount_cents: 5000, method: "card",
      gateway: "cardpointe", funding_state: "settled", received_at: now, voided_at: null, reference: null, instrument_last4: "1111" },
  ];
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/orders/o-${ORDER_ID}`);
  const refunds = page.getByRole("button", { name: "Refund", exact: true });
  ok("R0: both payments show a Refund", await until(async () => (await refunds.count()) === 2, 15000), String(await refunds.count()));
  let voids = callsOf("portal-payments", "void_payment").length;
  let refunded = callsOf("portal-payments", "refund_payment").length;
  // Taken today, so the box offers the whole payment cancelled (a void) first, as the old confirm did.
  const box = page.locator("[data-ss-refund-modal]");
  const cancelWhole = () => box.getByRole("button", { name: "Cancel the whole payment" });
  await refunds.nth(0).click();
  await tap(cancelWhole());
  ok("R1: a bank payment still clearing: the void is asked",
    await until(() => callsOf("portal-payments", "void_payment").length > voids, 6000) && lastOf("portal-payments", "void_payment").paymentId === S.payments[0].id);
  // The sentence is the PAGE's own (04-orders.jsx), not passed through from the server: the void
  // answers "already settled", and that must not be what shows.
  ok("R1: …its \"already settled\" is NOT chained into a refund, and the page's own \"still clearing\" sentence shows instead of it",
    await waitText("This bank payment is still clearing. It can be refunded once it clears.", 4000)
    && callsOf("portal-payments", "refund_payment").length === refunded
    && !(await page.evaluate(() => document.body.innerText.includes("That payment has already settled"))));
  voids = callsOf("portal-payments", "void_payment").length;
  refunded = callsOf("portal-payments", "refund_payment").length;   // an older page chained one in R1
  await tap(box.getByRole("button", { name: "Close" }));
  await refunds.nth(1).click();
  await tap(cancelWhole());
  ok("R2: a card payment whose void answers \"already settled\" is refunded, as before",
    await until(() => callsOf("portal-payments", "refund_payment").length > refunded, 6000)
    && lastOf("portal-payments", "refund_payment").paymentId === S.payments[1].id
    && callsOf("portal-payments", "void_payment").length === voids + 1 && await waitText("Refunded $50.00 to the customer (card ending 1111).", 4000));

  // ── X ──
  ok("X: no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  ok("X: nothing tried to leave the machine but blocked fonts or the like",
    offBox.every((h) => !/supabase|cardconnect|cardpointe/i.test(h)), [...new Set(offBox)].join(" | "));
} catch (e) {
  ok("X: the run reached the end", false, String(e && e.message).split(/\r?\n/)[0]);
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
