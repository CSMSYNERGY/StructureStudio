// The amount in the portal's Record-a-payment modal is the builder's to choose (Carolyn 2026-10-20:
// "$5,000 of the balance"), driven in the COMPILED portal with every call answered here.
//
// Until 2026-10-21 picking Card or Bank / ACH swapped whatever was typed for the server's ask (the
// deposit, or the whole balance), and the charge box was a read-only figure: "it flips over". Now one
// box serves both modes. Held here, on a $10,450.70 order with a $2,000.00 deposit asked:
//
//   A  the box opens on the order's balance and takes the deposit once pay_options names it; the
//      chips are Deposit $2,000.00, Full balance and Half
//   B  "5000" typed, then Card: the box still says 5000 (no flip), and Charge it now charges it:
//      "Charge $5,000.00 to **** NNNN", sent as amountCents = confirmChargeCents = 500000
//   C  the chips fill the box (Full balance 10450.70, Half 5225.35, Deposit 2000.00), and a chip
//      the page did not pick is never replaced by a later pay_options
//   D  out of range, said on screen and Charge off: above the balance, below $1, empty, not a number
//   E  an emptied box gets the deposit when Charge it now is picked; a typed one never does, through
//      Card > Bank / ACH > Card and Already collected > Charge it now
//   F  the server's own refusal of an amount shows in the modal (a balance that moved meanwhile)
//   G  Already collected records the typed figure (a payments row of 75000 for "750")
//   X  no uncaught page errors; nothing left the machine
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root, after npm run compile)
//   node tests/harness/payAmount.mjs               (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that bundle instead, which is how to
// watch B and E fail on the page before 2026-10-21. Names are made up; no card number is typed (the
// tokenizer is a stub page that posts a token the way CardPointe's does). The repo is public.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, reporter, shotsDir, BASE, REF } from "./lib.mjs";

const CLIENT = "harness-pay-amount";
const TOK_ORIGIN = "https://tok.example.test";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000e1", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const ORDER_ID = "11111111-2222-4333-8444-5555555555e1";
const TOTAL = 1045070, DEPOSIT = 200000;
const TOKENIZER = {
  origin: TOK_ORIGIN,
  cardUrl: `${TOK_ORIGIN}/itoke/ajax-tokenizer.html?rail=card`,
  achUrl: `${TOK_ORIGIN}/itoke/ajax-tokenizer.html?rail=ach`,
  swipeUrl: `${TOK_ORIGIN}/itoke/ajax-tokenizer.html?rail=card&swipeonly=true`,
  cardHeight: 265, achHeight: 130, swipeHeight: 64,
};
const PORTAL_OVERRIDE = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

// chargeNext: the next `charge` gets this { status, body } once. payOptionsDelayMs: pay_options is
// held back, so a chip picked before it lands can be checked against it.
const S = { minted: 0, chargeNext: null, payOptionsDelayMs: 0 };
const fnCalls = [];
const inserts = [];
const offBox = [];

const { ok, failed, results } = reporter();
const { browser, ctx } = await launch({ width: 1280, height: 1100 });
await ctx.addInitScript(([ref, s]) => {
  try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
}, [REF, SESSION]);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => { offBox.push(new URL(route.request().url()).host); return route.abort(); });
await page.route((u) => u.href.startsWith(TOK_ORIGIN + "/"), (route) =>
  route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>tokenizer stub</title><input id=ccnumfield>" }));

const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
  if (url.includes("/rest/v1/orders")) {
    return json(route, [{ id: ORDER_ID, client_id: CLIENT, order_no: 1101, short_code: null, ordered_at: "2026-10-01T15:00:00Z", total_cents: TOTAL, total_source: "manual", notes: "Counter sale" }]);
  }
  if (url.includes("/rest/v1/payments") && req.method() === "POST") { inserts.push(Array.isArray(body) ? body[0] : body); return json(route, [], 201); }
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (/[?&]warm=1/.test(url)) return json(route, { ok: true });
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
  }
  if (url.includes("/portal-payments")) {
    fnCalls.push(body);
    if (body.action === "pay_options") {
      if (S.payOptionsDelayMs) await new Promise((r) => setTimeout(r, S.payOptionsDelayMs));
      return json(route, { ok: true, canCharge: true, askCents: DEPOSIT, askKind: "deposit", balanceCents: TOTAL, settledCents: 0, pendingCents: 0, depositCents: DEPOSIT, minCents: 100, maxCents: 5000000, billingPrefill: { name: "Pat Example", street: "12 Main St", zip: "65801" }, tokenizer: TOKENIZER });
    }
    if (body.action === "charge") {
      if (S.chargeNext) { const a = S.chargeNext; S.chargeNext = null; return json(route, a.body, a.status); }
      return json(route, { ok: true, amountCents: body.amountCents, last4: String(body.payToken || "").slice(-4) });
    }
    return json(route, { ok: true, applies: false, percent: null });
  }
  if (url.includes("/portal-settings")) {
    if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, invoiceInGhl: false, branding: {} });
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
const charges = () => fnCalls.filter((b) => b.action === "charge");
let modal = null;
const box = () => modal.locator("[data-ss-amount='1']");
const boxValue = () => box().inputValue({ timeout: 1000 }).catch(() => null);
const problem = () => modal.locator("[data-ss-amount-problem='1']").innerText({ timeout: 300 }).catch(() => "");
const chargeBtn = () => modal.locator("[data-ss-charge='1']");
const chargeLabel = () => chargeBtn().innerText({ timeout: 1000 }).catch(() => "");
const chargeOff = () => chargeBtn().isDisabled({ timeout: 1000 }).catch(() => true);
const chip = (name) => modal.getByRole("button", { name, exact: true });
const flat = async () => (await modal.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s*\n\s*/g, " | ").slice(0, 400);
const type = async (v) => { await box().fill(""); if (v) await box().pressSequentially(v, { delay: 60 }); };

async function openModal() {
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Record a payment");
    return b && !b.disabled;
  }, null, { timeout: 15000 }).catch(() => {});
  await page.getByRole("button", { name: "Record a payment" }).click();
  modal = page.locator("div[style*='z-index: 1200']").last();
  await modal.waitFor({ timeout: 10000 });
}
const closeModal = () => modal.getByRole("button", { name: "Cancel", exact: true }).click({ timeout: 3000 }).catch(() => {});
/** A token from inside the newest card frame, the way CardPointe's page posts one. */
async function postToken() {
  S.minted += 1;
  const tok = `941394878020${String(4200 + S.minted).padStart(4, "0")}`;
  let f = null;
  for (const end = Date.now() + 8000; !f && Date.now() < end; await page.waitForTimeout(100)) {
    f = page.frames().filter((x) => !x.isDetached() && x.url().startsWith(TOK_ORIGIN) && !x.url().includes("swipeonly")).pop() || null;
  }
  if (!f) return null;
  await f.waitForLoadState("domcontentloaded").catch(() => {});
  await f.evaluate((t) => window.parent.postMessage(JSON.stringify({ message: t, token: t, expiry: "203212", errorCode: "0", errorMessage: "", entry: "manual" }), "*"), tok);
  return tok;
}

try {
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/orders/o-${ORDER_ID}`);
  ok("0: the order opens with Record a payment", await page.getByRole("button", { name: "Record a payment" }).waitFor({ timeout: 20000 }).then(() => true, () => false));

  // ── A ──
  S.payOptionsDelayMs = 1200;
  await openModal();
  ok("A: the box opens on the order's balance", (await boxValue()) === "10450.70", String(await boxValue()));
  ok("A: …and takes the deposit once pay_options names it", await until(async () => (await boxValue()) === "2000.00", 6000), String(await boxValue()));
  S.payOptionsDelayMs = 0;
  ok("A: the chips: Deposit $2,000.00, Full balance, Half",
    await chip("Deposit $2,000.00").isVisible() && await chip("Full balance").isVisible() && await chip("Half").isVisible(), await flat());
  await closeModal();

  // ── B ──
  await openModal();
  await until(async () => (await boxValue()) === "2000.00", 6000);
  await type("5000");
  await chip("Card").click();
  ok("B: Card keeps the typed 5000 (no flip to the deposit)", (await boxValue()) === "5000", String(await boxValue()));
  ok("B: …and the modal is on Charge it now", (await flat()).includes("Take a payment"));
  await page.waitForTimeout(300);
  ok("B: the box is still typeable on Charge it now", await box().isEditable());
  const tokB = await postToken();
  ok("B: Charge names the typed amount and the card: \"Charge $5,000.00 to **** NNNN\"",
    await until(async () => (await chargeLabel()) === `Charge $5,000.00 to **** ${tokB.slice(-4)}` && !(await chargeOff()), 6000), await chargeLabel());
  const nB = charges().length;
  await chargeBtn().click();
  ok("B: the charge sends amountCents = confirmChargeCents = 500000",
    await until(() => charges().length > nB, 6000) && charges().slice(-1)[0].amountCents === 500000 && charges().slice(-1)[0].confirmChargeCents === 500000,
    JSON.stringify(charges().slice(-1).map((c) => ({ a: c.amountCents, c: c.confirmChargeCents }))));
  ok("B: …and says so", await until(async () => (await page.locator("body").innerText()).includes("Charged $5,000.00"), 4000));

  // ── C ──
  await openModal();
  await until(async () => (await boxValue()) === "2000.00", 6000);
  await chip("Full balance").click();
  ok("C: Full balance fills 10450.70", (await boxValue()) === "10450.70", String(await boxValue()));
  await chip("Half").click();
  ok("C: Half fills 5225.35", (await boxValue()) === "5225.35", String(await boxValue()));
  await chip("Deposit $2,000.00").click();
  ok("C: Deposit fills 2000.00", (await boxValue()) === "2000.00", String(await boxValue()));
  await closeModal();
  // A chip picked BEFORE pay_options answers is the builder's choice: the late answer leaves it.
  S.payOptionsDelayMs = 1500;
  await openModal();
  await chip("Half").click();
  const halfBefore = await boxValue();
  await page.waitForTimeout(2200);
  ok("C: a chip picked before pay_options answers is not replaced by the deposit", (await boxValue()) === halfBefore && halfBefore === "5225.35", `${halfBefore} -> ${await boxValue()}`);
  S.payOptionsDelayMs = 0;
  await closeModal();

  // ── D ──
  await openModal();
  await until(async () => (await boxValue()) === "2000.00", 6000);
  await chip("Card").click();
  await postToken();
  for (const [v, want] of [
    ["10450.71", "That's more than the $10,450.70 still owed."],
    ["0.50", "The smallest payment is $1.00."],
    ["", "Enter the amount to charge."],
    ["abc", "Enter the amount to charge."],
  ]) {
    await type(v);
    ok(`D: "${v}" is refused on screen, and Charge is off`, await until(async () => (await problem()) === want && await chargeOff(), 3000), `${await problem()} | ${await chargeLabel()}`);
  }
  await type("10450.70");
  ok("D: the whole balance is allowed again", await until(async () => !(await problem()) && !(await chargeOff()), 3000), `${await problem()} | ${await chargeLabel()}`);
  await closeModal();

  // ── E ──
  await openModal();
  await until(async () => (await boxValue()) === "2000.00", 6000);
  await type("");
  await chip("Card").click();
  ok("E: an EMPTY box gets the deposit when Charge it now is picked", (await boxValue()) === "2000.00", String(await boxValue()));
  await type("1234.56");
  await chip("Bank / ACH").click();
  await chip("Card").click();
  ok("E: a typed figure survives Card > Bank / ACH > Card", (await boxValue()) === "1234.56", String(await boxValue()));
  await chip("Already collected").click();
  await chip("Charge it now").click();
  ok("E: …and Already collected > Charge it now", (await boxValue()) === "1234.56", String(await boxValue()));
  await closeModal();

  // ── F ──
  await openModal();
  await until(async () => (await boxValue()) === "2000.00", 6000);
  await type("3000");
  await chip("Card").click();
  await postToken();
  await until(async () => !(await chargeOff()), 6000);
  S.chargeNext = { status: 400, body: { error: "That's more than the $2,500.00 still owed on this order.", maxCents: 250000 } };
  await chargeBtn().click();
  const fullText = () => modal.innerText({ timeout: 1000 }).catch(() => "");
  ok("F: the server's refusal of the amount shows in the modal", await until(async () => (await fullText()).includes("That's more than the $2,500.00 still owed on this order."), 4000), await flat());
  ok("F: …and nothing is said to have been charged", !(await page.locator("body").innerText()).includes("Charged $"));
  await page.screenshot({ path: join(shotsDir("payAmount"), "F-refused.png") }).catch(() => {});
  await closeModal();

  // ── G ──
  await openModal();
  await until(async () => (await boxValue()) === "2000.00", 6000);
  // The modal keeps the last method it was closed on (Card, from F): Cash is picked here.
  await chip("Cash").click();
  await type("750");
  const nG = inserts.length;
  await modal.getByRole("button", { name: "Record payment", exact: true }).click();
  ok("G: Already collected records the typed figure (75000 cents, cash)",
    await until(() => inserts.length > nG, 6000) && inserts.slice(-1)[0].amount_cents === 75000 && inserts.slice(-1)[0].method === "cash",
    JSON.stringify(inserts.slice(-1).map((r) => ({ a: r.amount_cents, m: r.method }))));

  ok("X: no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  ok("X: nothing tried to leave the machine but blocked fonts or the like",
    offBox.every((h) => !/supabase|cardconnect|cardpointe/i.test(h)), [...new Set(offBox)].join(" | "));
} catch (e) {
  ok(`harness: ${String(e && e.message || e).split(/\r?\n/)[0].slice(0, 300)}`, false);
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
