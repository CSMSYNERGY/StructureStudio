// Partial refunds on the Orders page (board card "Partial refunds", migration 349), driven for real
// in the COMPILED portal with Supabase answered locally. portal-payments here is a small stand-in that
// keeps the payments and the refund ledger the way the server does (amount_cents is what is LEFT,
// refunded_cents what went back, one refund per requestKey), so the page's reading of each answer is
// what is checked; the server's own rules are held by paymentsMerchantOfRecord_test.ts (section 8-9)
// and tests/sql/migration349.test.cjs.
//
//   R0  the payment rows: Refund on a card payment taken here, Refund AND Void on one recorded by
//       hand, "Refunded" with no control on one refunded in full, "Part refunded" with what went back
//   R1  the box opens with the amount at what is left and an "All" chip; a "Refund owed" chip when
//       the order is paid above its total; more than is left says so and Refund is off
//   R2  a partial card refund: refund_payment with that amountCents and a requestKey; the box closes,
//       the page says what went back and what is left, the row reads "Part refunded" with a refund line,
//       its amount is the net, and the balance moves by the refund
//   R3  a double click sends ONE refund
//   R4  an answer that never came: the page says it can't tell and it won't refund twice; pressing
//       again sends the SAME requestKey, and the server's replay closes the box
//   R5  a refusal: its sentence shows, and the next press is a NEW refund (a new requestKey)
//   R6  a card payment taken today, part of it: refused "not_settled"; "Cancel the whole … instead"
//       sends a void, not a refund
//   R7  a card payment taken today, all of it: the button reads "Cancel the whole payment" and sends a
//       void, never a refund
//   R8  a cash payment, part of it, paid back by check: refund_payment carries refundMethod and the
//       reference; the page says "Recorded a $75.00 refund by check"
//   R9  "refund_unconfirmed": its sentence shows and Refund stays off
//   R10 several partials down to nothing: the row reads "Refunded", struck through at what was taken
//   X   no uncaught page errors; nothing left the machine
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root, after npm run compile)
//   node tests/harness/partialRefund.mjs          (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how to watch
// the checks fail against the page before 349. Names, ids and card endings are made up (the repo is
// public). NOTHING LEAVES THE MACHINE: every Supabase host is answered here, every other non-local
// request is aborted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, reporter, shotsDir, BASE, REF } from "./lib.mjs";

const CLIENT = "harness-partial-refund";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000d1", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const ORDER_ID = "11111111-2222-4333-8444-5555555555d1";
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
const P = {
  card: "bbbbbbbb-0000-4000-8000-0000000000d1",     // $1,000 card taken here three days ago
  today: "bbbbbbbb-0000-4000-8000-0000000000d2",    // $200 card taken here an hour ago
  cash: "bbbbbbbb-0000-4000-8000-0000000000d3",     // $300 cash recorded by hand
  gone: "bbbbbbbb-0000-4000-8000-0000000000d4",     // $50 card refunded in full before
  today2: "bbbbbbbb-0000-4000-8000-0000000000d5",   // another $200 card taken here two hours ago
};
// Total $1,400 against $1,700 paid: the order is $300 over, so "Refund owed $300.00" applies.
const S = {
  total: 140000,
  payments: [
    { id: P.card, client_id: CLIENT, order_id: ORDER_ID, amount_cents: 100000, refunded_cents: 0, method: "card", gateway: "cardpointe", funding_state: "settled", received_at: ago(72), voided_at: null, reference: null, instrument_last4: "1111" },
    { id: P.today, client_id: CLIENT, order_id: ORDER_ID, amount_cents: 20000, refunded_cents: 0, method: "card", gateway: "cardpointe", funding_state: "settled", received_at: ago(1), voided_at: null, reference: null, instrument_last4: "4242" },
    { id: P.cash, client_id: CLIENT, order_id: ORDER_ID, amount_cents: 30000, refunded_cents: 0, method: "cash", gateway: null, funding_state: "settled", received_at: ago(48), voided_at: null, reference: null, instrument_last4: null },
    { id: P.gone, client_id: CLIENT, order_id: ORDER_ID, amount_cents: 0, refunded_cents: 5000, method: "card", gateway: "cardpointe", funding_state: "settled", received_at: ago(240), voided_at: ago(200), void_reason: "refunded $50.00", reference: null, instrument_last4: "0005" },
    { id: P.today2, client_id: CLIENT, order_id: ORDER_ID, amount_cents: 20000, refunded_cents: 0, method: "card", gateway: "cardpointe", funding_state: "settled", received_at: ago(2), voided_at: null, reference: null, instrument_last4: "4444" },
  ],
  refunds: [],
  byKey: new Map(),
  next: [],       // answers for the next refund_payment / void_payment calls: { status, body } | "abort" | { delay }
};
const fnCalls = [];
const offBox = [];

const PORTAL_OVERRIDE = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;
const { ok, failed, results } = reporter();
const { browser, ctx } = await launch({ width: 1280, height: 1000 });
await ctx.addInitScript(([ref, s]) => {
  try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
}, [REF, SESSION]);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("dialog", (d) => d.accept().catch(() => {}));

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => { offBox.push(new URL(route.request().url()).host); return route.abort(); });

// The server's refund, as portal-payments does it: the payment keeps its net, the ledger gets a row,
// a repeated key is the first answer again.
function applyRefund(body) {
  const p = S.payments.find((x) => x.id === body.paymentId);
  if (!p) return { status: 404, body: { error: "Payment not found." } };
  const key = body.requestKey;
  if (key && S.byKey.has(key)) return { status: 200, body: { ...S.byKey.get(key), replay: true } };
  if (p.voided_at) return { status: 200, body: { ok: true, already: true } };
  const left = p.amount_cents;
  const cents = body.amountCents == null ? left : body.amountCents;
  if (!Number.isInteger(cents) || cents <= 0 || cents > left) {
    return { status: 400, body: { error: `Enter a refund amount up to $${(left / 100).toFixed(2)}, what's left of this payment.`, reason: "amount", refundableCents: left } };
  }
  p.amount_cents = left - cents;
  p.refunded_cents = (p.refunded_cents || 0) + cents;
  if (p.amount_cents === 0) { p.voided_at = new Date().toISOString(); p.void_reason = `refunded $${(p.refunded_cents / 100).toFixed(2)}`; }
  const byHand = !p.gateway;
  S.refunds.push({ id: S.refunds.length + 1, payment_id: p.id, order_id: ORDER_ID, amount_cents: cents, kind: byHand ? "manual" : "gateway", state: "done",
    method: byHand ? (body.refundMethod || p.method) : p.method, reference: body.reference || null, created_at: new Date().toISOString(), completed_at: new Date().toISOString() });
  const out = { ok: true, refunded: cents, retref: byHand ? null : `rf-${S.refunds.length}`, leftCents: p.amount_cents, refundedCents: p.refunded_cents, fullyRefunded: !!p.voided_at, ...(byHand ? { byHand: true } : {}) };
  if (key) S.byKey.set(key, out);
  return { status: 200, body: out };
}

const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  if (url.includes("/rest/v1/rpc/")) return json(route, false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
  if (url.includes("/rest/v1/orders")) {
    return json(route, [{ id: ORDER_ID, client_id: CLIENT, order_no: 2077, short_code: null, ordered_at: "2026-10-01T15:00:00Z", total_cents: S.total, total_source: "manual", notes: "Counter sale" }]);
  }
  if (/\/rest\/v1\/payments\?/.test(url) && req.method() === "GET") return json(route, S.payments);
  if (/\/rest\/v1\/payment_refunds\?/.test(url) && req.method() === "GET") return json(route, S.refunds);
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (/[?&]warm=1/.test(url)) return json(route, { ok: true });
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
  }
  if (url.includes("/portal-payments")) {
    fnCalls.push({ body, at: Date.now() });
    if (body.action === "refund_payment" || body.action === "void_payment") {
      const n = S.next.shift();
      if (n === "abort") return route.abort("failed");
      if (n && n.delay) await new Promise((r) => setTimeout(r, n.delay));
      if (n && n.status) return json(route, n.body, n.status);
      if (body.action === "void_payment") {
        const p = S.payments.find((x) => x.id === body.paymentId);
        if (p) { p.voided_at = new Date().toISOString(); p.void_reason = "voided at the card network"; }
        return json(route, { ok: true, voided: true });
      }
      const a = applyRefund(body);
      return json(route, a.body, a.status);
    }
    if (body.action === "reconcile") return json(route, { ok: true, updated: [], refunds: [] });
    return json(route, { ok: true });
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
if (PORTAL_OVERRIDE) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: PORTAL_OVERRIDE }));

const until = async (fn, timeout = 6000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(100)) if (await fn()) return true;
  return !!(await fn());
};
const waitText = (s, timeout = 8000) => page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const calls = (action) => fnCalls.filter((c) => c.body.action === action).map((c) => c.body);
const last = (action) => calls(action).slice(-1)[0] || {};
const textOf = (l) => l.innerText({ timeout: 1000 }).catch(() => "");
const brief = async (l) => (await textOf(l)).replace(/[ \t\r\n]+/g, " ").slice(0, 220);
const tap = (l) => l.click({ timeout: 3000 }).catch(() => {});
const row = (id) => page.locator(`[data-ss-payment-row="${id}"]`);
const box = page.locator("[data-ss-refund-modal]");
const amountBox = box.locator("[data-ss-refund-amount]");
const submit = box.locator("[data-ss-refund-submit]");
const off = (l) => l.isDisabled({ timeout: 1000 }).catch(() => false);
const openRefund = async (id) => {
  await tap(row(id).locator(`[data-ss-refund-open="${id}"]`));
  return await until(async () => (await box.count()) === 1, 4000);
};
const shots = shotsDir("partialRefund");

try {
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/orders/o-${ORDER_ID}`);

  // ── R0 ──
  ok("R0: the five payments render", await until(async () => (await page.locator("[data-ss-payment-row]").count()) === 5, 20000), String(await page.locator("[data-ss-payment-row]").count()));
  ok("R0: a card payment taken here has Refund", (await row(P.card).locator(`[data-ss-refund-open="${P.card}"]`).count()) === 1);
  const cashText = await textOf(row(P.cash));
  ok("R0: a payment recorded by hand has Refund AND Void", /Refund/.test(cashText) && /Void/.test(cashText), cashText.replace(/\s+/g, " "));
  const goneText = await textOf(row(P.gone));
  ok("R0: a payment refunded in full reads Refunded, shows what was taken ($50.00), and has no control",
    /Refunded/i.test(goneText) &&/\$50\.00/.test(goneText) && (await row(P.gone).locator("button").count()) === 0, goneText.replace(/\s+/g, " "));
  ok("R0: the order reads $300.00 over its total (Refund owed)", await waitText("Refund owed", 4000));

  // ── R1 ──
  ok("R1: Refund opens the box", await openRefund(P.card));
  ok("R1: the amount starts at what is left (1000.00)", (await amountBox.inputValue().catch(() => "")) === "1000.00", await amountBox.inputValue().catch(() => "?"));
  const chips = await textOf(box);
  ok("R1: an All chip, and a Refund owed $300.00 chip", chips.includes("All $1,000.00") && chips.includes("Refund owed $300.00"), await brief(box));
  await tap(box.locator('[data-ss-refund-chip^="Refund owed"]'));
  ok("R1: the Refund owed chip sets 300.00", (await amountBox.inputValue().catch(() => "")) === "300.00");
  await amountBox.fill("1000.01");
  ok("R1: more than is left says so, and Refund is off", (await textOf(box)).includes("more than the $1,000.00 left") && await off(submit), await brief(box));
  await amountBox.fill("250");
  ok("R1: 250 reads Refund $250.00", (await textOf(submit)).includes("Refund $250.00"), await textOf(submit));
  await box.screenshot({ path: join(shots, "R1-box.png") }).catch(() => {});

  // ── R2 ──
  let n = calls("refund_payment").length;
  await tap(submit);
  ok("R2: one refund_payment, 25000 cents, with a requestKey",
    await until(() => calls("refund_payment").length === n + 1, 5000) && last("refund_payment").amountCents === 25000
    && last("refund_payment").paymentId === P.card && /^[A-Za-z0-9_-]{8,100}$/.test(String(last("refund_payment").requestKey || "")),
    JSON.stringify({ ...last("refund_payment"), requestKey: last("refund_payment").requestKey ? "(set)" : null }));
  ok("R2: the box closes and the page says what went back and what is left",
    await until(async () => (await box.count()) === 0, 4000) && await waitText("Refunded $250.00 to the customer (card ending 1111). $750.00 of this payment is left.", 4000));
  ok("R2: the row reads Part refunded, $250.00 of $1,000.00 refunded, a refund line, and the net $750.00",
    await until(async () => {
      const t = await textOf(row(P.card));
      return /Part refunded/i.test(t) && t.includes("$250.00 of $1,000.00 refunded") && t.includes("↩ $250.00 refunded") && t.includes("$750.00");
    }, 5000), await brief(row(P.card)));
  ok("R2: the order is now $50.00 over (the balance moved by the refund)", await waitText("$50.00", 3000));
  await page.locator("[data-ss-payment-row]").first().locator("xpath=ancestor::div[1]").screenshot({ path: join(shots, "R2-rows.png") }).catch(() => {});

  // ── R3: a double click ──
  await openRefund(P.card);
  await amountBox.fill("10");
  n = calls("refund_payment").length;
  S.next.push({ delay: 700 });
  await submit.dblclick({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1200);
  ok("R3: a double click sends ONE refund", calls("refund_payment").length === n + 1, `${calls("refund_payment").length - n} sent`);
  await until(async () => (await box.count()) === 0, 3000);

  // ── R4: the answer never came ──
  await openRefund(P.card);
  await amountBox.fill("20");
  n = calls("refund_payment").length;
  S.next.push("abort");
  await tap(submit);
  ok("R4: no answer: the page can't tell, and says it won't refund twice",
    await until(async () => (await textOf(box)).includes("it won't refund twice"), 5000), await brief(box));
  const firstKey = last("refund_payment").requestKey;
  await tap(submit);
  ok("R4: pressing again sends the SAME requestKey", await until(() => calls("refund_payment").length === n + 2, 4000) && last("refund_payment").requestKey === firstKey && !!firstKey);
  ok("R4: …and the answer to it closes the box", await until(async () => (await box.count()) === 0, 4000) && await waitText("Refunded $20.00", 3000));

  // ── R5: refused, then a new refund ──
  await openRefund(P.card);
  await amountBox.fill("5");
  n = calls("refund_payment").length;
  S.next.push({ status: 409, body: { error: "The card network refused that refund (\"Declined\"). Nothing was refunded.", reason: "refund_declined" } });
  await tap(submit);
  ok("R5: a refusal shows its sentence", await until(async () => (await textOf(box)).includes("Nothing was refunded."), 4000), await brief(box));
  const refusedKey = last("refund_payment").requestKey;
  await tap(submit);
  ok("R5: the next press is a NEW refund (a new requestKey)", await until(() => calls("refund_payment").length === n + 2, 4000) && last("refund_payment").requestKey !== refusedKey);
  await until(async () => (await box.count()) === 0, 3000);

  // ── R6: taken today, part of it ──
  await openRefund(P.today);
  ok("R6: taken today, the box says a part may be refused until it settles",
    (await textOf(box)).includes("Card payments settle overnight") || (await textOf(box)).includes("hasn't settled yet"), await brief(box));
  await amountBox.fill("50");
  S.next.push({ status: 409, body: { error: "This payment hasn't settled at the card network yet (that happens overnight). Until it does, only the whole payment can be cancelled, not $50.00 of it. Try the partial refund again tomorrow.", reason: "not_settled" } });
  n = calls("refund_payment").length;
  const voids = calls("void_payment").length;
  await tap(submit);
  ok("R6: refused not_settled, with the cancel-the-whole offer",
    await until(async () => (await box.locator("[data-ss-refund-cancel-whole]").count()) === 1, 4000) && (await textOf(box)).includes("Cancel the whole $200.00 instead"), await brief(box));
  await box.screenshot({ path: join(shots, "R6-not-settled.png") }).catch(() => {});
  await tap(box.locator("[data-ss-refund-cancel-whole]"));
  ok("R6: …which sends a VOID of that payment, and no second refund",
    await until(() => calls("void_payment").length === voids + 1, 4000) && last("void_payment").paymentId === P.today && calls("refund_payment").length === n + 1);
  ok("R6: …and the page says it was cancelled", await waitText("Payment cancelled at the card network.", 4000));

  // ── R7: taken today, all of it ──
  await openRefund(P.today2);
  ok("R7: the whole of a payment taken today reads Cancel the whole payment", (await textOf(submit)).includes("Cancel the whole payment"), await textOf(submit));
  n = calls("refund_payment").length;
  const v7 = calls("void_payment").length;
  await tap(submit);
  ok("R7: …and sends a void, never a refund", await until(() => calls("void_payment").length === v7 + 1, 4000) && calls("refund_payment").length === n);
  await until(async () => (await box.count()) === 0, 3000);

  // ── R8: cash, paid back by check ──
  await openRefund(P.cash);
  ok("R8: a payment recorded by hand asks how it was paid back", (await box.locator("[data-ss-refund-method]").count()) === 1);
  await amountBox.fill("75");
  await box.locator("[data-ss-refund-method]").selectOption("check");
  await box.locator("[data-ss-refund-ref]").fill("chk 1043");
  ok("R8: the button reads Record refund of $75.00", (await textOf(submit)).includes("Record refund of $75.00"), await textOf(submit));
  n = calls("refund_payment").length;
  await tap(submit);
  ok("R8: refund_payment carries 7500, refundMethod check and the reference",
    await until(() => calls("refund_payment").length === n + 1, 4000)
    && last("refund_payment").amountCents === 7500 && last("refund_payment").refundMethod === "check" && last("refund_payment").reference === "chk 1043",
    JSON.stringify({ ...last("refund_payment"), requestKey: "(…)" }));
  ok("R8: the page says it was recorded, by check, with what is left",
    await waitText("Recorded a $75.00 refund by check. $225.00 of this payment is left.", 4000));
  ok("R8: the row shows the refund line by check with the reference",
    await until(async () => (await textOf(row(P.cash))).includes("refunded by check") && (await textOf(row(P.cash))).includes("chk 1043"), 4000), await brief(row(P.cash)));

  // ── R9: unconfirmed ──
  await openRefund(P.card);
  await amountBox.fill("1");
  S.next.push({ status: 409, body: { error: "We couldn't confirm the last refund on this payment with the card network, so we can't tell yet whether it went through. Don't refund it again for now — we've been told and will check it.", reason: "refund_unconfirmed" } });
  await tap(submit);
  ok("R9: refund_unconfirmed shows its sentence and Refund stays off",
    await until(async () => (await textOf(box)).includes("Don't refund it again") && await off(submit), 4000), await brief(box));
  await tap(box.getByRole("button", { name: "Close" }));

  // ── R10: down to nothing ──
  const leftNow = S.payments.find((x) => x.id === P.card).amount_cents;
  await openRefund(P.card);
  ok("R10: the box starts at what is left now", (await amountBox.inputValue().catch(() => "")) === (leftNow / 100).toFixed(2), `${await amountBox.inputValue().catch(() => "?")} vs ${leftNow}`);
  await tap(submit);
  ok("R10: refunding the rest leaves the row Refunded, struck at the $1,000.00 taken, with no Refund",
    await until(async () => {
      const t = await textOf(row(P.card));
      return /Refunded/i.test(t) && !/Part refunded/i.test(t) && t.includes("$1,000.00") && (await row(P.card).locator(`[data-ss-refund-open="${P.card}"]`).count()) === 0;
    }, 5000), await brief(row(P.card)));

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
