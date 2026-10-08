// Name on card, billing street and ZIP (2026-10, Fiserv certification), on BOTH surfaces that take
// a keyed card, driven for real: the customer's pay panel in my-quotes.html and the builder's
// Record-a-payment modal in the COMPILED portal.
//
// The card's bank checks the street and ZIP (AVS), and until now no page sent either. The card
// number, expiry and CVV stay inside CardPointe's iframe; these three fields are ours. Here the
// tokenizer's origin is https://tok.example.test, answered locally, and a "token" is posted from
// inside that iframe the way the real tokenizer posts one, so nothing leaves the machine and no card
// number is ever typed. Names and addresses are made up (the repo is public).
//
//   M  my-quotes.html
//     M1 the Card tab shows Name on card (cc-name, prefilled with the customer's own name), the
//        "Billing address is my delivery address" box (unticked), Billing street address
//        (billing address-line1) and Billing ZIP code (billing postal-code, numeric)
//     M2 a token arms Pay and the surcharge probe goes out with NO ZIP while none is typed
//     M3 Pay with a field missing says which, INSIDE the panel, and sends nothing: no street, a
//        four-digit ZIP, no name
//     M4 a real ZIP asks the surcharge probe again, with that ZIP
//     M5 the charge carries name, address and postal, and no `billing` flag
//     M6 ticking the box hides the street and ZIP, asks the probe again with billing:"delivery"
//        and no ZIP, and the charge carries billing:"delivery" and the name, with NO address or ZIP
//        (the server fills them in; the page never holds the delivery address)
//     M7 the Bank account tab hides all of it
//   P  the portal's Record-a-payment modal
//     P1 Card → Key it in shows the three fields prefilled from pay_options' billingPrefill, with
//        autocomplete off (the builder's browser would offer the builder's own details)
//     P2 a token sends the surcharge probe with the prefilled ZIP; a new ZIP asks again
//     P3 Charge with the street cleared says so inside the modal and sends nothing
//     P4 the charge carries name, address and postal, entry "keyed"
//     P5 Swipe hides the fields, and its charge carries none of them (entry "swipe")
//     P6 Bank / ACH shows none of them
//     P7 no billingPrefill (an older portal-payments, or an operator): the fields start empty and
//        the hint does not claim a delivery address
//   X  no uncaught page errors; nothing went anywhere but the stubs
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/cardBillingFields.mjs       (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> and SS_MY_QUOTES=<an older my-quotes.html>
// serve those files instead, which is how to watch the checks fail against the pages before 2026-10.
//
// ⚠️ NOTHING LEAVES THE MACHINE: every Supabase host and the tokenizer origin are answered here,
// every other non-local request is aborted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, reporter, shotsDir, BASE, REF } from "./lib.mjs";

const CLIENT = "harness-card-billing";
const TOK_ORIGIN = "https://tok.example.test";
const NAME = "Pat Example";
const PREFILL = { name: NAME, street: "12 Main St", zip: "65801" };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000b7", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const ORDER_ID = "11111111-2222-4333-8444-5555555555b7";
const TOKENIZER = {
  origin: TOK_ORIGIN,
  cardUrl: `${TOK_ORIGIN}/itoke/ajax-tokenizer.html?rail=card`,
  achUrl: `${TOK_ORIGIN}/itoke/ajax-tokenizer.html?rail=ach`,
  swipeUrl: `${TOK_ORIGIN}/itoke/ajax-tokenizer.html?rail=card&swipeonly=true`,
  cardHeight: 265, achHeight: 130,
};

// prefill: what portal-payments' pay_options sends as billingPrefill (undefined = the key is absent).
const S = { prefill: PREFILL, minted: 0 };
const fnCalls = [];         // { fn, body } for customer-pay / portal-payments
const consoleLines = [];
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
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => consoleLines.push(m.text()));

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// Registered FIRST so the specific handlers below override it (Playwright runs routes in reverse).
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => { offBox.push(route.request().url()); return route.abort(); });

// The tokenizer origin: a blank page standing in for CardPointe's iframe.
await page.route((u) => u.href.startsWith(TOK_ORIGIN + "/"), (route) =>
  route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>tokenizer stub</title><input id=ccnumfield>" }));

const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  if (url.includes("/rest/v1/rpc/log_error")) return json(route, null);
  if (url.includes("/rest/v1/rpc/")) return json(route, false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
  if (url.includes("/rest/v1/orders")) {
    return json(route, [{ id: ORDER_ID, client_id: CLIENT, order_no: 1077, short_code: null, ordered_at: "2026-10-01T15:00:00Z", total_cents: 100000, total_source: "manual", notes: "Counter sale" }]);
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
    return json(route, { ok: true, businessName: "Acme Sheds", name: NAME, quotes: [{
      quoteRef: "SS-CARDBILL", estimateNumber: "AS-1077", status: "invoiced", total: 1000,
      invoice: { number: "SSI-1077", signedAt: "2026-10-01T15:00:00Z", pdfUrl: null },
    }] });
  }
  const payOptions = { ok: true, askCents: 100000, askKind: "balance", balanceCents: 100000, settledCents: 0, pendingCents: 0, depositCents: null, minCents: 100, maxCents: 5000000, tokenizer: TOKENIZER };
  if (url.includes("/customer-pay")) {
    fnCalls.push({ fn: "customer-pay", body });
    if (body.action === "pay_options") return json(route, { ...payOptions, canPay: true });
    if (body.action === "pay") return json(route, { ok: true, amountCents: 100000, balanceCents: 0, last4: "1111" });
    return json(route, { ok: true, applies: false, percent: null, feeCents: null, chargeCents: 100000 });
  }
  if (url.includes("/portal-payments")) {
    fnCalls.push({ fn: "portal-payments", body });
    if (body.action === "pay_options") {
      return json(route, { ...payOptions, canCharge: true, ...(S.prefill === undefined ? {} : { billingPrefill: S.prefill }) });
    }
    if (body.action === "charge") return json(route, { ok: true, amountCents: 100000, last4: "1111" });
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

/** Post a token from INSIDE the tokenizer iframe, the way CardPointe's own page does, so the
 *  listener's origin and source checks both pass. `swipe` picks the swipe-only frame. */
async function postToken(swipe = false) {
  S.minted += 1;
  const tok = `94139487802${String(S.minted).padStart(5, "0")}`;
  const frame = await (async () => {
    for (const end = Date.now() + 8000; Date.now() < end; await page.waitForTimeout(100)) {
      const f = page.frames().find((x) => x.url().startsWith(TOK_ORIGIN) && x.url().includes("swipeonly=true") === swipe);
      if (f) return f;
    }
    return null;
  })();
  if (!frame) return null;
  await frame.evaluate((t) => window.parent.postMessage(JSON.stringify({ message: t, token: t, expiry: "203212", errorCode: "0" }), "*"), tok);
  return tok;
}
const attrs = (l) => l.evaluate((el) => ({ ac: el.getAttribute("autocomplete"), mode: el.getAttribute("inputmode"), type: el.type, value: el.value, max: el.maxLength }));
const visible = async (l) => (await l.count()) === 1 && await l.isVisible();

try {
  // ── M: my-quotes.html ──────────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/my-quotes.html?client=${CLIENT}`, { waitUntil: "domcontentloaded" });
  ok("M0: the quotes list renders", await waitText("AS-1077", 20000));
  const openPanel = async () => {
    await page.getByRole("button", { name: "Pay $1,000.00" }).first().click();
    const panel = page.locator(".sign-panel");
    await panel.waitFor({ timeout: 10000 });
    return panel;
  };
  let panel = await openPanel();
  const mqName = () => panel.getByLabel("Name on card");
  const mqStreet = () => panel.getByLabel("Billing street address");
  const mqZip = () => panel.getByLabel("Billing ZIP code");
  const mqSame = () => panel.getByLabel("Billing address is my delivery address");
  const mqPay = () => panel.getByRole("button", { name: /^Pay \$/ });

  // M1
  ok("M1: Name on card, Billing street address and Billing ZIP code are on the Card tab",
    (await mqName().count()) === 1 && (await mqStreet().count()) === 1 && (await mqZip().count()) === 1);
  if ((await mqName().count()) !== 1) {
    ok("M: the fields exist, so the rest of M can run", false);
  } else {
    const n = await attrs(mqName()), st = await attrs(mqStreet()), z = await attrs(mqZip());
    ok("M1: Name on card is cc-name and starts as the customer's own name", n.ac === "cc-name" && n.value === NAME, JSON.stringify(n));
    ok("M1: the street is billing address-line1", st.ac === "billing address-line1" && st.value === "", JSON.stringify(st));
    ok("M1: the ZIP is billing postal-code, numeric", z.ac === "billing postal-code" && z.mode === "numeric", JSON.stringify(z));
    ok("M1: the delivery box is there, unticked", (await mqSame().count()) === 1 && !(await mqSame().isChecked()));
    await panel.screenshot({ path: join(shotsDir("cardBillingFields"), "M-card-tab.png") }).catch(() => {});

    // M2
    const probesBefore = callsOf("customer-pay", "surcharge_probe").length;
    const tok1 = await postToken();
    ok("M2: a token arms Pay", !!tok1 && await until(async () => !(await mqPay().isDisabled()), 4000));
    ok("M2: the probe goes out, with NO ZIP while none is typed",
      await until(() => callsOf("customer-pay", "surcharge_probe").length > probesBefore, 4000)
      && !has(lastOf("customer-pay", "surcharge_probe"), "postal") && !has(lastOf("customer-pay", "surcharge_probe"), "billing"),
      JSON.stringify(lastOf("customer-pay", "surcharge_probe")));

    // M3
    const paysBefore = callsOf("customer-pay", "pay").length;
    await mqPay().click();
    ok("M3: no street: the panel says so", await until(async () => (await panel.innerText()).includes("Enter the card's billing street address."), 3000));
    await mqStreet().fill("1 Card Lane");
    await mqZip().fill("1234");
    await mqPay().click();
    ok("M3: a four-digit ZIP: the panel says so", await until(async () => (await panel.innerText()).includes("Enter the card's billing ZIP code (5 digits)."), 3000));
    await mqName().fill("");
    await mqPay().click();
    ok("M3: no name: the panel says so", await until(async () => (await panel.innerText()).includes("Enter the name on the card."), 3000));
    ok("M3: and nothing was charged", callsOf("customer-pay", "pay").length === paysBefore);
    await mqName().fill(NAME);

    // M4
    const probesM4 = callsOf("customer-pay", "surcharge_probe").length;
    await mqZip().fill("65801");
    await mqZip().blur();
    ok("M4: a real ZIP asks the probe again, with that ZIP",
      await until(() => callsOf("customer-pay", "surcharge_probe").length > probesM4, 4000)
      && lastOf("customer-pay", "surcharge_probe").postal === "65801", JSON.stringify(lastOf("customer-pay", "surcharge_probe")));

    // M5
    await mqPay().click();
    ok("M5: the charge went out", await until(() => callsOf("customer-pay", "pay").length > paysBefore, 6000));
    const pay1 = lastOf("customer-pay", "pay");
    ok("M5: it carries name, address and postal", pay1.name === NAME && pay1.address === "1 Card Lane" && pay1.postal === "65801", JSON.stringify(pay1));
    ok("M5: …no billing flag, the latest token, rail card", !has(pay1, "billing") && pay1.payToken === tok1 && pay1.rail === "card", JSON.stringify(pay1));

    // M6: the delivery box
    await until(async () => (await page.getByRole("button", { name: "Pay $1,000.00" }).count()) > 0, 6000);
    panel = await openPanel();
    const tok2 = await postToken();
    await until(async () => !(await mqPay().isDisabled()), 4000);
    const probesM6 = callsOf("customer-pay", "surcharge_probe").length;
    await mqSame().check();
    ok("M6: ticking the box hides the street and the ZIP", !(await visible(mqStreet())) && !(await visible(mqZip())));
    ok("M6: the probe is asked again with billing:\"delivery\" and no ZIP",
      await until(() => callsOf("customer-pay", "surcharge_probe").length > probesM6, 4000)
      && lastOf("customer-pay", "surcharge_probe").billing === "delivery" && !has(lastOf("customer-pay", "surcharge_probe"), "postal"),
      JSON.stringify(lastOf("customer-pay", "surcharge_probe")));
    await panel.screenshot({ path: join(shotsDir("cardBillingFields"), "M-delivery.png") }).catch(() => {});
    const paysM6 = callsOf("customer-pay", "pay").length;
    await mqPay().click();
    ok("M6: the charge went out", await until(() => callsOf("customer-pay", "pay").length > paysM6, 6000));
    const pay2 = lastOf("customer-pay", "pay");
    ok("M6: it carries billing:\"delivery\" and the name", pay2.billing === "delivery" && pay2.name === NAME && pay2.payToken === tok2, JSON.stringify(pay2));
    ok("M6: …and NO address or ZIP (the server fills them in)", !has(pay2, "address") && !has(pay2, "postal"), JSON.stringify(pay2));

    // M7: the bank tab
    await until(async () => (await page.getByRole("button", { name: "Pay $1,000.00" }).count()) > 0, 6000);
    panel = await openPanel();
    await panel.getByRole("button", { name: "Bank account" }).click();
    await page.waitForTimeout(300);
    ok("M7: the Bank account tab hides the name, the box, the street and the ZIP",
      !(await visible(mqName())) && !(await visible(mqSame())) && !(await visible(mqStreet())) && !(await visible(mqZip())));
    await panel.getByRole("button", { name: "Card", exact: true }).click();
    await page.waitForTimeout(300);
    ok("M7: …and Card brings them back", await visible(mqName()) && await visible(mqStreet()));
  }

  // ── P: the portal's Record-a-payment modal ────────────────────────────────────────────────────
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/portal/orders/o-${ORDER_ID}`);
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
    return modal;
  };
  let modal = await openModal();
  await modal.getByRole("button", { name: "Card", exact: true }).click();
  ok("P0: picking Card lands on Take a payment", await waitText("Take a payment", 5000));
  const pName = () => modal.getByLabel("Name on card");
  const pStreet = () => modal.getByLabel("Billing street address");
  const pZip = () => modal.getByLabel("Billing ZIP code");
  const pCharge = () => modal.getByRole("button", { name: /^Charge \$/ });

  // P1
  ok("P1: the three fields are there on Key it in", await until(async () => (await pName().count()) === 1, 5000) && (await pStreet().count()) === 1 && (await pZip().count()) === 1);
  if ((await pName().count()) !== 1) {
    ok("P: the fields exist, so the rest of P can run", false);
  } else {
    const pn = await attrs(pName()), ps = await attrs(pStreet()), pz = await attrs(pZip());
    ok("P1: prefilled from billingPrefill", pn.value === PREFILL.name && ps.value === PREFILL.street && pz.value === PREFILL.zip, JSON.stringify([pn.value, ps.value, pz.value]));
    ok("P1: autocomplete off on all three; the ZIP numeric", [pn, ps, pz].every((a) => a.ac === "off") && pz.mode === "numeric", JSON.stringify([pn, ps, pz]));
    ok("P1: the hint says where the prefill came from", await waitText("Filled in from the delivery address.", 3000));
    await modal.screenshot({ path: join(shotsDir("cardBillingFields"), "P-keyed.png") }).catch(() => {});

    // P2
    const probesP = callsOf("portal-payments", "surcharge_probe").length;
    const ptok = await postToken();
    ok("P2: a token arms Charge", !!ptok && await until(async () => !(await pCharge().isDisabled()), 4000));
    ok("P2: the probe goes out with the prefilled ZIP",
      await until(() => callsOf("portal-payments", "surcharge_probe").length > probesP, 4000)
      && lastOf("portal-payments", "surcharge_probe").postal === "65801", JSON.stringify(lastOf("portal-payments", "surcharge_probe")));
    const probesP2 = callsOf("portal-payments", "surcharge_probe").length;
    await pZip().fill("10001");
    ok("P2: a new ZIP asks again, with it",
      await until(() => callsOf("portal-payments", "surcharge_probe").length > probesP2 && lastOf("portal-payments", "surcharge_probe").postal === "10001", 4000),
      JSON.stringify(lastOf("portal-payments", "surcharge_probe")));

    // P3
    const chargesBefore = callsOf("portal-payments", "charge").length;
    await pStreet().fill("");
    await pCharge().click();
    ok("P3: the street cleared: the modal says so", await until(async () => (await modal.innerText()).includes("Enter the card's billing street address."), 3000));
    ok("P3: and nothing was charged", callsOf("portal-payments", "charge").length === chargesBefore);

    // P4
    await pStreet().fill("1 Card Lane");
    await pCharge().click();
    ok("P4: the charge went out", await until(() => callsOf("portal-payments", "charge").length > chargesBefore, 6000));
    const ch = lastOf("portal-payments", "charge");
    ok("P4: it carries name, address and postal, entry keyed",
      ch.name === NAME && ch.address === "1 Card Lane" && ch.postal === "10001" && ch.entry === "keyed" && ch.payToken === ptok, JSON.stringify(ch));

    // P5: swipe
    modal = await openModal();
    await modal.getByRole("button", { name: "Card", exact: true }).click();
    await modal.getByRole("button", { name: "Swipe", exact: true }).click();
    await page.waitForTimeout(300);
    ok("P5: Swipe hides the billing fields", (await pName().count()) === 0 && (await pStreet().count()) === 0 && (await pZip().count()) === 0);
    const stok = await postToken(true);
    ok("P5: a swipe token arms Charge", !!stok && await until(async () => !(await pCharge().isDisabled()), 4000));
    const chargesP5 = callsOf("portal-payments", "charge").length;
    await pCharge().click();
    ok("P5: the swipe charge went out", await until(() => callsOf("portal-payments", "charge").length > chargesP5, 6000));
    const sw = lastOf("portal-payments", "charge");
    ok("P5: …with entry swipe and no name, address or postal",
      sw.entry === "swipe" && !has(sw, "name") && !has(sw, "address") && !has(sw, "postal") && sw.payToken === stok, JSON.stringify(sw));

    // P6: bank
    modal = await openModal();
    await modal.getByRole("button", { name: "Bank / ACH", exact: true }).click();
    await page.waitForTimeout(300);
    ok("P6: Bank / ACH shows none of them", (await pName().count()) === 0 && (await pStreet().count()) === 0 && (await pZip().count()) === 0);
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();

    // P7: no prefill
    S.prefill = null;
    modal = await openModal();
    await modal.getByRole("button", { name: "Card", exact: true }).click();
    ok("P7: no billingPrefill: the fields are there, empty",
      await until(async () => (await pName().count()) === 1, 5000)
      && (await attrs(pName())).value === "" && (await attrs(pStreet())).value === "" && (await attrs(pZip())).value === "");
    ok("P7: …and the hint does not claim a delivery address",
      !(await modal.innerText()).includes("Filled in from the delivery address") && (await modal.innerText()).includes("Where the card's statement goes."));
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    S.prefill = PREFILL;
  }

  // ── X ──
  ok("X: no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  ok("X: nothing tried to leave the machine but blocked fonts or the like",
    offBox.every((u) => !/supabase|cardconnect|cardpointe/i.test(u)), offBox.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
