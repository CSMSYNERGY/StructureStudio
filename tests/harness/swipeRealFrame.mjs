// The card reader, driven into CardPointe's REAL UAT tokenizer iframe inside the COMPILED portal's
// Record-a-payment modal (2026-10-13; rewritten 2026-10-21 for the reader that arms itself).
//
// WHY THIS EXISTS. Every other payments harness stands a blank page in for the tokenizer and posts a
// token from inside it. So three defects that each lost every swipe were invisible to all of them:
// the swipe frame inherited the card rail's cardnumbernumericonly (CardPointe's own script cancelled
// every letter and Shift key the reader types), usecvv made every swipe post "CVV is Required" first,
// and focusing the iframe ELEMENT left the frame's activeElement on BODY so the keys went nowhere.
// Only the real iframe script shows any of that. Here the iframe URL is the one portal-payments
// serves: it is composed by running the shipped cpTokenizerUrl (supabase/functions/_shared/
// cardpointe.ts) under Deno, with the tokenizer base pointed at Fiserv's public UAT host.
//
// THE 2026-10-21 MODAL (Carolyn 2026-10-20): no "Ready to swipe" press, the reader's raw output never
// on screen, "**** **** **** 1234" once the card is read, and a refusal re-arms by itself.
//
// THE READER IS A USB KEYBOARD. It is simulated the way a HID keyboard types: Shift held DOWN for
// every uppercase letter and shifted symbol (keyboard.down("Shift") / press / up). Never
// keyboard.type: it sends "%" and "^" without Shift, which the numeric-only filter lets through,
// so a harness built on it would have passed against the broken URL.
//
//   S  the reader's frame is the swipe rail: the exact URL the server composes, one box whose
//      placeholder says "Swipe, insert or tap the card", no numeric-only / expiry / CVV, the served
//      height fits the box, and the box's TEXT IS WHITE on the real frame (Fiserv's css allow-list
//      kept `#ccnumfield{color:#FFFFFF}`), so what the reader types can't be seen
//   A  Card > Swipe arms the reader with NO Ready button: "Getting the card reader ready…" until the
//      new frame has loaded, then "Waiting for card — swipe, insert or tap" with the card box focused
//      INSIDE the frame; a ~460-character blob plus the reader's two Enters reaches CardSecure
//      byte-for-byte; "Reading card…" on the way; then "**** **** **** NNNN" (the token's last 4) and
//      "Charge $1,000.00 to **** NNNN"; no key reached the page, nothing of the blob is in the page;
//      the charge goes out with entry "swipe", amountCents = confirmChargeCents, no billing fields
//   B  "Use another card" after a token: the token and Charge are cleared, a NEW frame with an empty,
//      focused box loads, and the second blob arrives whole and is the one charged
//   C  a click on a blank part of the modal: the reader gets the focus back by itself (a new frame,
//      "Waiting for card") within ~2 s, and the swipe that follows is captured whole
//   P  the amount box while the reader waits: typed into at a person's pace, it takes the keys (the
//      old trap ate them for a minute) and the reader says "Click here…"; a SWIPE into it instead is a
//      reader burst: the box gets its old figure back, nothing reaches CardSecure, the page says the
//      card went to the page, and the reader is armed again; the next swipe is captured and Charge
//      carries the amount that was typed
//   F  a click on the reader's frame OFF its box (the blank band under it) lands on the page's cover:
//      it re-arms (a new frame, focus in its box), and the swipe is captured whole
//   G  after the card is read, an Enter and a Shift in the card box (the frame says "typing" again):
//      past the whole read window the card is still captured and Charge still on
//   H  a key in the card box (Caps Lock) and the swipe 6.5 s later: captured, no refusal sentence
//   I  a slow reader, 15 ms per character: captured whole, no refusal sentence
//   J  the Swipe button, already chosen, clicked while waiting: nothing is reset, the reader gets the
//      focus back by itself, and the swipe that follows is captured
//   M  an ID TECH CHIP read (EMV output, hex starting DFEE25): the frame classes it as a swipe, it
//      reaches CardSecure whole as devicedata, the card shows as **** NNNN and is charged as "swipe"
//   D  CardSecure refuses (the request is ABORTED): "Reading card…" and Cancel held while the read
//      window runs, then the refusal sentence, and the reader re-arms by itself ~1.5 s later with the
//      sentence still showing
//   L  the 1001 refusal (output that doesn't start like a swipe: the reader's "insert the chip"
//      code): CardPointe's code and words, plus "If the card has a chip, insert it chip-first.";
//      re-armed by itself three times in a row, then the fourth refusal stops at "Reset reader",
//      which arms it again
//   K  CardSecure refuses, and the operator switches to Bank / ACH at once and enters a bank
//      account: past the card read's window the bank token and Charge stand, and the card reader's
//      refusal sentence never reaches the bank screen
//   E  the published test card number typed slowly by hand into the swipe frame: tokenized as
//      "manual" (stub), refused with "That was typed, not read by the card reader…", Charge off, the
//      reader re-arms, and the refusal sentence does not follow it
//   N  the reader swiped on the Cash screen (no reader on screen): the amount box keeps its figure,
//      the keys are swallowed, nothing reaches CardSecure, and the page says how to take the card
//   X  no uncaught page errors; nothing left the machine but the tokenizer page and its script
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root, after npm run compile)
//   node tests/harness/swipeRealFrame.mjs          (exit 0 = every check held, or SKIPPED offline)
//   HEADED=1 node tests/harness/swipeRealFrame.mjs (a VISIBLE Chrome window: the focus checks are
//                                                    the ones a hidden window can't be trusted on)
//
// ⚠️ WHAT LEAVES THE MACHINE: GETs for the UAT tokenizer page and its own script, nothing else.
// EVERY request to /cardsecure/ (tokenize, retrievePublicKey) is answered here or aborted, so
// nothing is ever tokenized by Fiserv. Every Supabase host is answered here; every other request is
// aborted. The only things typed are random hex blobs, the published test card 4111111111111111 and
// the bank rail's own placeholder routing number with a made-up account number, and neither the
// blobs nor any keystroke is ever printed: checks report lengths, counts and booleans.
// Not run by preflight (it needs the network). When the UAT host cannot be reached it prints
// SKIPPED and exits 0.
//
// SS_UAT_TOKENIZER_BASE overrides the tokenizer page (it must be a UAT host); SS_PORTAL_ARTIFACT
// serves another portal.app.compiled.js, which is how to watch these checks fail on the old portal.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, reporter, shotsDir, BASE, REF } from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOK_BASE = process.env.SS_UAT_TOKENIZER_BASE || "https://isv-uat.cardconnect.com/itoke/ajax-tokenizer.html";
if (!/^https:\/\/[a-z0-9-]*uat[a-z0-9-]*\./i.test(TOK_BASE)) {
  console.error(`refusing: ${new URL(TOK_BASE).host} is not a UAT tokenizer. This harness never loads a live one.`);
  process.exit(1);
}

// ── Offline is a SKIP, not a failure: preflight must never depend on the network. ──
try {
  const r = await fetch(TOK_BASE, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.log(`SKIPPED  swipeRealFrame: the UAT tokenizer (${new URL(TOK_BASE).host}) is unreachable: ${e.message}`);
  process.exit(0);
}

// ── The URLs portal-payments' pay_options would serve, from the SHIPPED cardpointe.ts. ──
function servedTokenizer() {
  const mod = pathToFileURL(join(ROOT, "supabase/functions/_shared/cardpointe.ts")).href;
  const code = `const cp = await import(${JSON.stringify(mod)}); const M = { env: "uat" };
    console.log(JSON.stringify({ origin: cp.cpTokenizerOrigin(M), cardUrl: cp.cpTokenizerUrl(M, "card"),
      achUrl: cp.cpTokenizerUrl(M, "ach"), swipeUrl: cp.cpTokenizerUrl(M, "swipe"), cardHeight: cp.cpTokenizerHeight("card"),
      achHeight: cp.cpTokenizerHeight("ach"), swipeHeight: cp.cpTokenizerHeight("swipe") }));`;
  const args = ["eval", "--quiet", "--node-modules-dir=none", code];
  const opts = { encoding: "utf8", env: { ...process.env, CARDPOINTE_TOKENIZER_BASE: TOK_BASE } };
  let r = spawnSync("deno", args, opts);
  // A scoop/npm-shim install is deno.cmd, which CreateProcess will not resolve (preflight's runDeno).
  if (r.error && r.error.code === "ENOENT") r = spawnSync("deno", args, { ...opts, shell: true });
  if (r.status !== 0) {
    console.error(`FAIL  could not compose the served tokenizer URLs with deno (deno is required): ${(r.stderr || r.error || "").toString().slice(0, 400)}`);
    process.exit(1);
  }
  return JSON.parse(r.stdout.trim().split("\n").pop());
}
const TOKENIZER = servedTokenizer();
const TOK_ORIGIN = TOKENIZER.origin;

const CLIENT = "harness-swipe-real-frame";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000d3", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const ORDER_ID = "11111111-2222-4333-8444-5555555555d3";
const PORTAL_OVERRIDE = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

// A synthetic reader blob, the shape itoke.js classes as an ID TECH swipe ("02" + hex … "03"):
// uppercase hex around a track-shaped run with % ^ ? ; = / and letters that are not hex. Random
// every run, never printed.
const hex = (n) => crypto.randomBytes(n).toString("hex").toUpperCase();
function makeBlob() {
  const track = `%B${hex(6)}^HARNESS/TEST^${hex(4)}?;${hex(6)}=${hex(4)}?`;
  const head = "02" + hex(9);
  const fill = 460 - head.length - track.length - 2;
  return head + track + hex(Math.ceil(fill / 2)).slice(0, fill) + "03";
}
// An ID TECH chip read through the reader's keyboard output: EMV TLV hex that itoke.js classes as a
// swipe because it starts "DFEE25" ("IDTech Augusta"). Fiserv's Desktop SDK guide shows the same
// opening (DFEE25020203DFEE26…). ~1,000 characters, all hex. Random, never printed.
const makeChipBlob = () => "DFEE25020203DFEE26" + hex(491);
// What the reader types for a card whose stripe says "chip" (MSR-to-chip fallback on): an error TLV
// in front of the read (DFEF61 … F220, "insert the card"), so the frame sees no swipe and answers
// 1001 "Invalid Account Number". All hex, so the 1001 comes from the shape, not a stray character.
const makeInsertChipBlob = () => "DFEF6103F22000" + hex(120);
const TEST_PAN = "4111111111111111";   // the published test card; never a real one

// cardsecure: "stub" answers tokenize with a fake token; "abort" refuses it like a network failure.
// pageDelayMs holds the swipe frame's page back, so "Getting the card reader ready…" can be seen.
const S = { cardsecure: "stub", pageDelayMs: 0, expect: null, minted: 0 };
const tokenizes = [];          // { kind, len, intact, at } — never the data itself
const net = { tokenizerGets: 0, cardsecureAnswered: 0, cardsecureAborted: 0 };
const fnCalls = [];
const offBox = [];
// The stub's tokens: 16 digits, the last 4 counting up (CardSecure tokens keep the card's last 4).
const tokenFor = (n) => `9418000000${String(4000 + n).padStart(6, "0")}`;
const last4Of = (t) => t.slice(-4);

const { ok, failed, results } = reporter();
const { browser, ctx } = await launch({ width: 1280, height: 1100 });
await ctx.addInitScript(([ref, s]) => {
  if (window.top !== window) return;           // never into the tokenizer's own frame
  try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  // Keydowns that reach the PORTAL's document (never the frame's), COUNTED ONLY: which key it was
  // is card data and is never read. `through` = got past the page's own handlers (the window's
  // bubble phase), i.e. NOT swallowed by the reader-burst guard.
  window.__harnessKeys = { parent: 0, through: 0, typing: 0 };
  window.addEventListener("keydown", () => { window.__harnessKeys.parent++; }, true);
  window.addEventListener("keydown", () => { window.__harnessKeys.through++; }, false);
  // How many times a frame said {cardTyping:true}: the trigger of the portal's read timer. Only
  // that flag is looked at, never any other field of any message.
  window.addEventListener("message", (e) => {
    try { if (JSON.parse(e.data).cardTyping === true) window.__harnessKeys.typing++; } catch (_e) { /* not JSON */ }
  }, true);
}, [REF, SESSION]);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Registered FIRST so the specific handlers below override it (Playwright runs routes in reverse).
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => { offBox.push(route.request().url().replace(/\?.*/, "")); return route.abort(); });

// The tokenizer's origin: its page and script are real; /cardsecure/ never leaves.
await page.route((u) => u.origin === TOK_ORIGIN, async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  if (u.pathname.includes("/cardsecure/")) {
    if (u.pathname.endsWith("/ccn/tokenize")) {
      let b = {};
      try { b = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
      tokenizes.push({ kind: b.devicedata ? "devicedata" : b.account ? "account" : "other", len: String(b.devicedata || "").length, intact: S.expect ? b.devicedata === S.expect : null, at: Date.now() });
      if (S.cardsecure === "abort") { net.cardsecureAborted++; return route.abort(); }
      net.cardsecureAnswered++;
      S.minted += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "No error", errorcode: 0, token: tokenFor(S.minted) }) });
    }
    // retrievePublicKey: refused, so a hand-typed number goes the no-key way (still to the stub above).
    net.cardsecureAnswered++;
    return route.fulfill({ status: 404, body: "" });
  }
  net.tokenizerGets++;
  if (S.pageDelayMs && u.searchParams.get("swipeonly") === "true") await sleep(S.pageDelayMs);
  return route.continue();
});

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
    return json(route, [{ id: ORDER_ID, client_id: CLIENT, order_no: 1093, short_code: null, ordered_at: "2026-10-01T15:00:00Z", total_cents: 100000, total_source: "manual", notes: "Counter sale" }]);
  }
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
      return json(route, { ok: true, canCharge: true, askCents: 100000, askKind: "balance", balanceCents: 100000, settledCents: 0, pendingCents: 0, depositCents: null, minCents: 100, maxCents: 5000000, billingPrefill: null, tokenizer: TOKENIZER });
    }
    if (body.action === "charge") return json(route, { ok: true, amountCents: body.amountCents || 100000, last4: String(body.payToken || "").slice(-4) });
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
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// The reader, as a USB HID keyboard types: Shift held for every capital and shifted symbol.
const SHIFTED = { "%": "Digit5", "^": "Digit6", "*": "Digit8", "?": "Slash" };
const PLAIN = { ";": "Semicolon", "=": "Equal", "/": "Slash", " ": "Space", ".": "Period" };
async function hidType(s, delay = 0) {
  for (const ch of s) {
    if (/[A-Z]/.test(ch)) { await page.keyboard.down("Shift"); await page.keyboard.press("Key" + ch); await page.keyboard.up("Shift"); }
    else if (/[0-9]/.test(ch)) await page.keyboard.press("Digit" + ch);
    else if (SHIFTED[ch]) { await page.keyboard.down("Shift"); await page.keyboard.press(SHIFTED[ch]); await page.keyboard.up("Shift"); }
    else if (PLAIN[ch]) await page.keyboard.press(PLAIN[ch]);
    else throw new Error("hidType: a character with no key mapping");   // never names the character
    if (delay) await page.waitForTimeout(delay);
  }
}
// A swipe: the blob, then the VP3350's default postfix (two carriage returns). msPerChar paces it
// on the wall clock (a slow reader); 0 is as fast as the browser takes the keys.
const swipe = async (blob, msPerChar = 0) => {
  S.expect = blob;
  if (!msPerChar) await hidType(blob);
  else {
    const t0 = Date.now();
    let i = 0;
    for (const ch of blob) { await hidType(ch); i++; const wait = t0 + i * msPerChar - Date.now(); if (wait > 0) await page.waitForTimeout(wait); }
  }
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
};
// The portal's read window (READ_WAIT_MS in portal/04-orders.jsx): from the frame's first
// "typing" to the Fiserv-refusal sentence.
const READ_WAIT = 20000;

let modal = null;
const recordBtn = page.getByRole("button", { name: "Record a payment" });
async function openModal() {
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Record a payment");
    return b && !b.disabled;
  }, null, { timeout: 15000 }).catch(() => {});
  await recordBtn.click();
  modal = page.locator("div[style*='z-index: 1200']").last();
  await modal.waitFor({ timeout: 10000 });
}
async function openSwipe() {
  await openModal();
  await modal.getByRole("button", { name: "Card", exact: true }).click();
  await modal.getByRole("button", { name: "Swipe", exact: true }).click();
  return await swipeFrame(30000);
}
/** The frame inside the modal's tokenizer iframe right now, once its card box exists. */
async function swipeFrame(timeout = 20000) {
  for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(150)) {
    const el = await modal.locator("iframe[title='Payment details']").elementHandle({ timeout: 1000 }).catch(() => null);
    const f = el && await el.contentFrame().catch(() => null);
    if (f && f.url().includes("swipeonly=true") && await f.$("#ccnumfield").catch(() => null)) return f;
  }
  return null;
}
// The reader panel (the words where the Ready button was): its state and its text.
const reader = () => page.evaluate(() => {
  const el = document.querySelector("[data-ss-reader-state]");
  return el ? { st: el.getAttribute("data-ss-reader-state"), text: el.textContent } : null;
});
const readerIs = (st, timeout = 20000) => until(async () => ((await reader()) || {}).st === st, timeout);
const readyButtonGone = () => page.evaluate(() => ![...document.querySelectorAll("button")].some((x) => /^(Ready to swipe|Ready — swipe the card now)/.test(x.textContent)));
const modalText = () => modal.innerText({ timeout: 1000 }).catch(() => "");
// The modal's words on one line, for a check's note (the card box is inside the frame, never in here).
const flat = async () => (await modalText()).replace(/\s*\n\s*/g, " | ").slice(0, 400);
const chargeBtn = () => modal.locator("[data-ss-charge='1']");
const chargeOff = () => chargeBtn().isDisabled({ timeout: 1000 }).catch(() => true);
const chargeLabel = () => chargeBtn().innerText({ timeout: 1000 }).catch(() => "");
const tokenErr = () => modal.locator("[data-ss-token-err='1']").innerText({ timeout: 500 }).catch(() => "");
const amountBox = () => modal.locator("[data-ss-amount='1']");
const frameState = (f) => f.evaluate(() => {
  const a = document.activeElement;
  const box = document.getElementById("ccnumfield");
  return { active: a ? (a.id || a.tagName) : null, len: box ? box.value.length : null };
}).catch(() => ({ active: null, len: null }));
const keys = () => page.evaluate(() => ({ ...window.__harnessKeys }));
// Does the page itself (outside the frame) hold any 12-character run of this blob? The reader's
// output must never be on screen, in the amount box or anywhere else.
const blobOnPage = (blob) => page.evaluate((b) => {
  const hay = document.body.innerText + " " + [...document.querySelectorAll("input,textarea")].map((i) => i.value).join(" ");
  for (let i = 0; i + 12 <= b.length; i += 6) if (hay.includes(b.slice(i, i + 12))) return true;
  return false;
}, blob);
// A real mouse click on the reader's frame: "band" is the frame's blank strip under its box, "box"
// the box itself. Returns whether the page's own cover took it (the frame never sees the click).
async function clickReader(where) {
  const bb = await modal.locator("iframe[title='Payment details']").boundingBox();
  const x = bb.x + bb.width * 0.9;
  const y = where === "band" ? bb.y + bb.height - 4 : bb.y + 26;
  const covered = await page.evaluate(([px, py]) => { const e = document.elementFromPoint(px, py); return !!(e && e.dataset && e.dataset.ssReaderCover === "1"); }, [x, y]);
  await page.mouse.click(x, y);
  return covered;
}
const cancel = () => modal.getByRole("button", { name: "Cancel", exact: true }).click({ timeout: 5000 }).catch(() => {});
const WAITING = "Waiting for card — swipe, insert or tap";
const WENT_TO_PAGE = "The card went to the page, not the card reader.";
const REFUSED = "That card didn't go through. Try it again, or key the card in.";
const TYPED = "That was typed, not read by the card reader. Swipe, insert or tap the card.";
const CHIP_HINT = "If the card has a chip, insert it chip-first.";

try {
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/orders/o-${ORDER_ID}`);
  ok("0: the order opens with Record a payment", await recordBtn.waitFor({ timeout: 20000 }).then(() => true, () => false));

  // ── S: the frame is the swipe rail, and its text is white ───────────────────────────────────────
  let frame = await openSwipe();
  ok("S: CardPointe's real swipe frame loads in the modal", !!frame, `tokenizer page/script GETs so far: ${net.tokenizerGets}`);
  if (!frame) throw new Error("no swipe frame: the rest cannot run (if curl reaches the host but Chrome does not, try HARNESS_CHROME_ARGS)");
  const q = new URL(frame.url()).searchParams;
  // Compared as the browser holds it: Chrome percent-encodes the css parameter's quotes.
  const servedHref = new URL(TOKENIZER.swipeUrl).href;
  ok("S: it is exactly the URL the server composes for the swipe rail", frame.url() === servedHref,
    frame.url() === servedHref ? "" : `first difference at character ${[...servedHref].findIndex((c, i) => c !== frame.url()[i])}`);
  ok("S: autofocus, invalidinputevent, sendcardtypingevent, swipeonly on",
    ["autofocus", "invalidinputevent", "sendcardtypingevent", "swipeonly"].every((p) => q.get(p) === "true"), [...q.keys()].join(","));
  ok("S: no numeric-only, format, expiry or CVV parameter",
    ["cardnumbernumericonly", "formatinput", "useexpiry", "useexpiryfield", "usecvv", "invalidcreditcardevent", "invalidexpiryevent", "invalidcvvevent"].every((p) => !q.has(p)));
  // Measured once the served CSS is in (itoke fetches it after load; before that the box is small).
  await frame.waitForFunction(() => { const i = document.getElementById("ccnumfield"); return !!i && getComputedStyle(i).paddingTop === "10px"; }, null, { timeout: 15000 }).catch(() => {});
  const shown = await frame.evaluate(() => {
    const box = document.getElementById("ccnumfield");
    const r = box ? box.getBoundingClientRect() : { bottom: 0 };
    const form = document.getElementById("tokenform");
    const cs = box ? getComputedStyle(box) : null;
    return {
      inputs: [...document.querySelectorAll("input")].filter((i) => i.type !== "hidden" && getComputedStyle(i).display !== "none").map((i) => i.id),
      styled: !!box && cs.paddingTop === "10px",
      // The box with its own bottom margin, or the form, whichever ends lower. NOT scrollHeight:
      // it never reads below the frame's own height, so it cannot see an over-tall frame.
      content: Math.ceil(Math.max(r.bottom + (box ? parseFloat(cs.marginBottom) || 0 : 0), form ? form.getBoundingClientRect().bottom : 0)),
      placeholder: box ? box.placeholder : null,
      color: cs ? cs.color : null,
      background: cs ? cs.backgroundColor : null,
      caret: cs ? cs.caretColor : null,
    };
  });
  ok("S: one box, the card reader's, \"Swipe, insert or tap the card\", no expiry or CVV boxes",
    shown.inputs.length === 1 && shown.inputs[0] === "ccnumfield" && shown.placeholder === "Swipe, insert or tap the card", JSON.stringify(shown));
  // THE ALLOW-LIST CHECK on Fiserv's real frame: the colour rule survived, so the reader's output
  // is white on the box's white and never shows (Carolyn 2026-10-20).
  ok("S: the box's text is WHITE on a white box (Fiserv's css kept the rule)",
    shown.color === "rgb(255, 255, 255)" && /^rgba?\(255, 255, 255/.test(String(shown.background)),
    JSON.stringify({ color: shown.color, background: shown.background, caret: shown.caret }));
  ok("S: …and so is the caret (it follows the text colour)", shown.caret === "rgb(255, 255, 255)" || shown.caret === "auto", String(shown.caret));
  const drawn = await modal.locator("iframe[title='Payment details']").evaluate((el) => el.style.height);
  ok("S: the frame is drawn at the served swipe height", drawn === `${TOKENIZER.swipeHeight}px`, `drawn ${drawn}, served ${TOKENIZER.swipeHeight}px`);
  ok("S: the box fits the frame, with at most 16px of the frame's blank page under it",
    shown.styled && shown.content <= TOKENIZER.swipeHeight && TOKENIZER.swipeHeight - shown.content <= 16,
    `content ends at ${shown.content}px (css in: ${shown.styled}), served ${TOKENIZER.swipeHeight}px`);
  await cancel();

  // ── A: Card > Swipe arms itself; swipe; charge ───────────────────────────────────────────────────
  S.pageDelayMs = 1500;
  const loadsBeforeA = net.tokenizerGets;
  await openModal();
  await modal.getByRole("button", { name: "Card", exact: true }).click();
  await modal.getByRole("button", { name: "Swipe", exact: true }).click();
  await page.waitForTimeout(300);
  ok("A: no Ready button anywhere", await readyButtonGone());
  ok("A: while the frame loads the reader says so, and does not invite the swipe",
    ((await reader()) || {}).st === "loading" && ((await reader()) || {}).text === "Getting the card reader ready…", JSON.stringify(await reader()));
  ok("A: then \"Waiting for card — swipe, insert or tap\", with no click", await readerIs("waiting") && ((await reader()) || {}).text.includes(WAITING), JSON.stringify(await reader()));
  S.pageDelayMs = 0;
  ok("A: choosing Swipe loaded a reader frame", net.tokenizerGets > loadsBeforeA, `${loadsBeforeA} -> ${net.tokenizerGets}`);
  frame = await swipeFrame();
  ok("A: the card box INSIDE the frame has the focus, and it is empty", !!frame && (await frameState(frame)).active === "ccnumfield" && (await frameState(frame)).len === 0,
    frame ? JSON.stringify(await frameState(frame)) : "no frame");
  await page.screenshot({ path: join(shotsDir("swipeRealFrame"), "A-waiting.png") }).catch(() => {});
  const keysA = await keys();
  const blobA = makeBlob();
  const tokA = tokenizes.length;
  // Watch for "Reading card…" while the read is in flight (it can be brief with the stub).
  const sawReading = page.evaluate(() => new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const el = document.querySelector("[data-ss-reader-state]");
      if (el && el.getAttribute("data-ss-reader-state") === "reading" && el.textContent.includes("Reading card…")) return res(true);
      if (Date.now() - t0 > 15000) return res(false);
      setTimeout(tick, 20);
    };
    tick();
  }));
  await swipe(blobA);
  ok("A: \"Reading card…\" while the read is in flight", await sawReading);
  ok("A: CardSecure got ONE devicedata, the length typed, byte-for-byte (letters and symbols intact)",
    await until(() => tokenizes.length > tokA, 8000) && tokenizes.length === tokA + 1
      && tokenizes[tokA].kind === "devicedata" && tokenizes[tokA].len === blobA.length && tokenizes[tokA].intact === true,
    JSON.stringify({ typed: blobA.length, got: tokenizes.slice(tokA) }));
  const tokenA = tokenFor(S.minted);
  ok("A: the card shows as \"**** **** **** NNNN\", the token's last 4", await readerIs("card", 8000)
    && ((await reader()) || {}).text.includes("**** **** **** " + last4Of(tokenA)), JSON.stringify(await reader()));
  ok("A: Charge says the amount and the card: \"Charge $1,000.00 to **** NNNN\"",
    await until(async () => (await chargeLabel()) === `Charge $1,000.00 to **** ${last4Of(tokenA)}`, 6000), await chargeLabel());
  ok("A: no \"CVV is Required\", no refusal", !(await modalText()).includes("CVV is Required") && !(await tokenErr()));
  const keysA2 = await keys();
  ok("A: not one key of the swipe reached the page", keysA2.parent === keysA.parent, JSON.stringify({ before: keysA, after: keysA2 }));
  ok("A: nothing of the reader's output is on the page", !(await blobOnPage(blobA)));
  await page.screenshot({ path: join(shotsDir("swipeRealFrame"), "A-captured.png") }).catch(() => {});
  const chargesA = charges().length;
  ok("A: Charge is on", await until(async () => !(await chargeOff()), 6000));
  await chargeBtn().click();
  ok("A: the charge went out", await until(() => charges().length > chargesA, 6000));
  const chA = charges().slice(-1)[0] || {};
  ok("A: …marked entry \"swipe\", with the token the frame minted, the amount on screen echoed, and no name, address or postal",
    chA.entry === "swipe" && chA.payToken === tokenA && chA.amountCents === 100000 && chA.confirmChargeCents === 100000
      && !has(chA, "name") && !has(chA, "address") && !has(chA, "postal"),
    JSON.stringify({ entry: chA.entry, amountCents: chA.amountCents, confirm: chA.confirmChargeCents, keys: Object.keys(chA) }));

  // ── B: "Use another card" after a token ─────────────────────────────────────────────────────────
  frame = await openSwipe();
  await readerIs("waiting");
  await swipe(makeBlob());
  await readerIs("card", 8000);
  const firstTok = tokenFor(S.minted);
  await modal.locator("iframe[title='Payment details']").evaluate((el) => { el.dataset.harnessOld = "1"; });
  ok("B: the first swipe is captured", ((await reader()) || {}).st === "card" && !(await chargeOff()));
  await modal.getByRole("button", { name: "Use another card", exact: true }).click();
  await page.waitForTimeout(150);
  ok("B: \"Use another card\" clears the first card: no **** NNNN, Charge off",
    ((await reader()) || {}).st !== "card" && await chargeOff(), JSON.stringify(await reader()));
  ok("B: …and waits for the NEW frame", await readerIs("waiting"));
  ok("B: it is a new iframe element", (await modal.locator("iframe[title='Payment details']").getAttribute("data-harness-old")) === null);
  frame = await swipeFrame();
  ok("B: the new card box is empty and focused", !!frame && (await frameState(frame)).len === 0 && (await frameState(frame)).active === "ccnumfield",
    frame ? JSON.stringify(await frameState(frame)) : "no frame");
  const blobB = makeBlob();
  const tokB = tokenizes.length;
  await swipe(blobB);
  ok("B: the second blob arrives whole: first character included, same length",
    await until(() => tokenizes.length > tokB, 8000) && tokenizes[tokB].intact === true && tokenizes[tokB].len === blobB.length,
    JSON.stringify({ typed: blobB.length, got: tokenizes.slice(tokB) }));
  ok("B: the card is read again", await readerIs("card", 8000));
  const chargesB = charges().length;
  await until(async () => !(await chargeOff()), 6000);
  await chargeBtn().click();
  await until(() => charges().length > chargesB, 6000);
  const chB = charges().slice(-1)[0] || {};
  ok("B: the charge carries the SECOND card's token", chB.payToken === tokenFor(S.minted) && chB.payToken !== firstTok && chB.entry === "swipe",
    JSON.stringify({ entry: chB.entry, second: chB.payToken !== firstTok }));

  // ── C: a click on a blank part of the modal: the reader takes the focus back by itself ─────────
  frame = await openSwipe();
  await readerIs("waiting");
  const loadsC = net.tokenizerGets;
  const clickedAt = Date.now();
  await modal.getByText("Amount", { exact: true }).click();
  frame = await swipeFrame();
  ok("C: the click took the focus out of the card box", !!frame && (await frameState(frame)).active !== "ccnumfield", frame ? JSON.stringify(await frameState(frame)) : "no frame");
  ok("C: within ~2.5 s the reader is armed again by itself: a NEW frame, waiting, focus in its box",
    await until(async () => net.tokenizerGets > loadsC && ((await reader()) || {}).st === "waiting"
      && !!(frame = await swipeFrame(1000)) && (await frameState(frame)).active === "ccnumfield", 4000) && Date.now() - clickedAt <= 4000,
    `${Date.now() - clickedAt} ms; ${JSON.stringify(await reader())}`);
  const blobC = makeBlob();
  const tokC = tokenizes.length;
  await swipe(blobC);
  ok("C: …and the swipe is captured, whole", await readerIs("card", 8000) && tokenizes.length === tokC + 1 && tokenizes[tokC].intact === true,
    JSON.stringify(tokenizes.slice(tokC)));
  await cancel();

  // ── P: the amount box while the reader waits ───────────────────────────────────────────────────
  frame = await openSwipe();
  await readerIs("waiting");
  await amountBox().click();
  await amountBox().press("Control+a");
  const throughP = (await keys()).through;
  await amountBox().pressSequentially("250", { delay: 90 });
  ok("P: a person's typing reaches the amount box while the reader waits (nothing swallowed)",
    (await amountBox().inputValue()) === "250" && (await keys()).through - throughP === 3, JSON.stringify({ value: await amountBox().inputValue(), keys: await keys() }));
  ok("P: the reader says to click it, since the box has the focus", await readerIs("click", 3000)
    && ((await reader()) || {}).text === "Click here, then swipe, insert or tap the card", JSON.stringify(await reader()));
  // A person reaches for the card after typing: the guard follows a burst back through keys under
  // 0.15 s apart, and the harness alone could swipe sooner than that after the last digit.
  await page.waitForTimeout(600);
  const tokP = tokenizes.length;
  const keysP = await keys();
  const loadsP = net.tokenizerGets;
  const blobP = makeBlob();
  await swipe(blobP);
  ok("P: a SWIPE into the amount box: it keeps \"250\", nothing of the read in it", (await amountBox().inputValue()) === "250", "value length " + (await amountBox().inputValue()).length);
  // The keys before the burst is recognised (4 characters in 50 ms, and the Shift keys that come
  // with their capitals) reach the box, and the guard then puts its old value back (checked above).
  // Playwright types a capital as three round trips, so recognition takes a few more keys here
  // than behind a real reader (~1.2 ms a character); at least 90% of the ~650 keydowns are swallowed.
  ok("P: …the burst is swallowed (only the handful of keys before it was recognised got past)",
    (await keys()).parent - keysP.parent >= 460 && (await keys()).through - keysP.through <= 45, JSON.stringify({ before: keysP, after: await keys() }));
  ok("P: …the page says the card went to the page", await until(async () => (await tokenErr()).includes(WENT_TO_PAGE), 3000), await flat());
  ok("P: …nothing went to CardSecure", tokenizes.length === tokP);
  ok("P: …and the reader is armed again (a new frame, waiting, focus in its box)",
    await until(async () => net.tokenizerGets > loadsP && ((await reader()) || {}).st === "waiting"
      && !!(frame = await swipeFrame(1000)) && (await frameState(frame)).active === "ccnumfield", 5000), JSON.stringify(await reader()));
  ok("P: nothing of the reader's output is on the page", !(await blobOnPage(blobP)));
  await swipe(makeBlob());
  ok("P: the next swipe is captured", await readerIs("card", 8000));
  ok("P: Charge carries the TYPED amount: \"Charge $250.00 to **** NNNN\"", (await chargeLabel()) === `Charge $250.00 to **** ${last4Of(tokenFor(S.minted))}`, await chargeLabel());
  const chargesP = charges().length;
  await chargeBtn().click();
  await until(() => charges().length > chargesP, 6000);
  const chP = charges().slice(-1)[0] || {};
  ok("P: …and sends it: amountCents = confirmChargeCents = 25000", chP.amountCents === 25000 && chP.confirmChargeCents === 25000, JSON.stringify({ a: chP.amountCents, c: chP.confirmChargeCents }));

  // ── F: a click on the reader's frame OFF its box ──────────────────────────────────────────────
  frame = await openSwipe();
  ok("F: armed", await readerIs("waiting"));
  const loadsF = net.tokenizerGets;
  const keysF = await keys();
  ok("F: the click on the frame's blank strip lands on the page's cover, not the frame", await clickReader("band"));
  ok("F: …which re-arms: a NEW frame, waiting once it has loaded", await until(async () => net.tokenizerGets > loadsF && ((await reader()) || {}).st === "waiting", 20000),
    `${loadsF} -> ${net.tokenizerGets}; ${JSON.stringify(await reader())}`);
  frame = await swipeFrame();
  ok("F: the focus is in the card box, not on the frame's body", !!frame && (await frameState(frame)).active === "ccnumfield", frame ? JSON.stringify(await frameState(frame)) : "no frame");
  const blobF = makeBlob();
  const tokF = tokenizes.length;
  await swipe(blobF);
  ok("F: the swipe is captured, whole, and not one key reached the page",
    await readerIs("card", 8000) && tokenizes.length === tokF + 1 && tokenizes[tokF].intact === true
      && (await keys()).parent === keysF.parent, JSON.stringify({ got: tokenizes.slice(tokF), keys: await keys() }));
  const tokenF = tokenFor(S.minted);

  // ── G: a key in the card box after the card is captured ──────────────────────────────────────
  await until(async () => !(await chargeOff()), 6000);
  frame = await swipeFrame();
  ok("G: the focus is still in the card box after the token", !!frame && (await frameState(frame)).active === "ccnumfield", frame ? JSON.stringify(await frameState(frame)) : "no frame");
  const typG = (await keys()).typing;
  const keyAtG = Date.now();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift");
  ok("G: an Enter and a Shift in the box: the frame says \"typing\" again", await until(async () => (await keys()).typing > typG, 3000), JSON.stringify(await keys()));
  await page.waitForTimeout(Math.max(0, keyAtG + READ_WAIT + 1500 - Date.now()));
  ok("G: past the whole read window the card is still captured, Charge on, no refusal sentence",
    ((await reader()) || {}).st === "card" && !(await chargeOff()) && !(await modalText()).includes(REFUSED), await flat());
  const chargesG = charges().length;
  await chargeBtn().click();
  await until(() => charges().length > chargesG, 6000);
  const chG = charges().slice(-1)[0] || {};
  ok("G: …and Charge sends that card", chG.payToken === tokenF && chG.entry === "swipe", JSON.stringify({ entry: chG.entry, same: chG.payToken === tokenF }));

  // ── H: a key in the card box, and the swipe 6.5 s later ─────────────────────────────────────────
  frame = await openSwipe();
  await readerIs("waiting");
  const typH = (await keys()).typing;
  await page.keyboard.press("CapsLock");
  await page.keyboard.press("CapsLock");
  ok("H: the frame says \"typing\" at that key, so the read window starts there", await until(async () => (await keys()).typing > typH, 3000), JSON.stringify(await keys()));
  await page.waitForTimeout(6500);
  const blobH = makeBlob();
  const tokH = tokenizes.length;
  let refusedH = false;
  let capturedH = false;
  await swipe(blobH);
  for (const end = Date.now() + 12000; Date.now() < end && !capturedH; await page.waitForTimeout(200)) {
    refusedH = refusedH || (await modalText()).includes(REFUSED);
    capturedH = ((await reader()) || {}).st === "card";
  }
  ok("H: captured, whole", capturedH && tokenizes.length === tokH + 1 && tokenizes[tokH].intact === true, JSON.stringify(tokenizes.slice(tokH)));
  ok("H: and the refusal sentence never showed on the way", !refusedH && !(await modalText()).includes(REFUSED), await flat());
  await cancel();

  // ── I: a slow reader, 15 ms per character ──────────────────────────────────────────────────────
  frame = await openSwipe();
  await readerIs("waiting");
  const blobI = makeBlob();
  const tokI = tokenizes.length;
  const firstKeyI = Date.now();
  await swipe(blobI, 15);
  const typedMsI = Date.now() - firstKeyI;
  let refusedI = false;
  let capturedI = false;
  for (const end = Date.now() + 12000; Date.now() < end && !capturedI; await page.waitForTimeout(200)) {
    refusedI = refusedI || (await modalText()).includes(REFUSED);
    capturedI = ((await reader()) || {}).st === "card";
  }
  ok("I: a 15 ms-per-character read is captured, whole", capturedI && tokenizes.length === tokI + 1 && tokenizes[tokI].intact === true,
    `${blobI.length} characters in ${typedMsI} ms; captured ${Date.now() - firstKeyI} ms after the first key`);
  ok("I: and the refusal sentence never showed while the reader typed", !refusedI && !(await modalText()).includes(REFUSED), await flat());
  await cancel();

  // ── J: the Swipe button, already chosen, clicked while waiting ─────────────────────────────────
  frame = await openSwipe();
  await readerIs("waiting");
  await modal.getByRole("button", { name: "Swipe", exact: true }).click();
  ok("J: clicking the Swipe button already chosen resets nothing: no refusal, no card dropped",
    !(await tokenErr()) && ["waiting", "click", "loading"].includes(((await reader()) || {}).st), JSON.stringify(await reader()));
  ok("J: the reader takes the focus back by itself (the button had it)",
    await until(async () => ((await reader()) || {}).st === "waiting" && !!(frame = await swipeFrame(1000)) && (await frameState(frame)).active === "ccnumfield", 5000),
    JSON.stringify(await reader()));
  const tokJ = tokenizes.length;
  await swipe(makeBlob());
  ok("J: the swipe that follows is captured", await readerIs("card", 8000) && tokenizes.length === tokJ + 1);
  await cancel();

  // ── M: an ID TECH chip read (DFEE25…) ──────────────────────────────────────────────────────────
  frame = await openSwipe();
  await readerIs("waiting");
  const chip = makeChipBlob();
  const tokM = tokenizes.length;
  await swipe(chip);
  ok("M: the chip read reaches CardSecure whole, as devicedata (the frame classes DFEE25 as a swipe)",
    await until(() => tokenizes.length > tokM, 10000) && tokenizes[tokM].kind === "devicedata" && tokenizes[tokM].len === chip.length && tokenizes[tokM].intact === true,
    JSON.stringify({ typed: chip.length, got: tokenizes.slice(tokM) }));
  const tokenM = tokenFor(S.minted);
  ok("M: the card shows as **** NNNN, no refusal", await readerIs("card", 8000) && ((await reader()) || {}).text.includes(last4Of(tokenM)) && !(await tokenErr()), JSON.stringify(await reader()));
  ok("M: nothing of the chip read is on the page", !(await blobOnPage(chip)));
  const chargesM = charges().length;
  await until(async () => !(await chargeOff()), 6000);
  await chargeBtn().click();
  await until(() => charges().length > chargesM, 6000);
  const chM = charges().slice(-1)[0] || {};
  ok("M: charged as entry \"swipe\" with that token", chM.entry === "swipe" && chM.payToken === tokenM, JSON.stringify({ entry: chM.entry, same: chM.payToken === tokenM }));

  // ── D: CardSecure refuses the read ───────────────────────────────────────────────────────────
  S.cardsecure = "abort";
  frame = await openSwipe();
  await readerIs("waiting");
  const tokD = tokenizes.length;
  const firstKeyD = Date.now();
  await swipe(makeBlob());
  ok("D: the read went to CardSecure (and was aborted here)", await until(() => tokenizes.length > tokD, 8000) && net.cardsecureAborted > 0);
  await page.waitForTimeout(Math.max(0, firstKeyD + READ_WAIT - 3000 - Date.now()));
  ok("D: while the read window runs: \"Reading card…\", nothing said, and Cancel held (closing mid-read loses the read)",
    ((await reader()) || {}).st === "reading" && !(await tokenErr()) && await modal.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), JSON.stringify(await reader()));
  ok("D: then the refusal sentence, once the window is over", await until(async () => (await tokenErr()) === REFUSED, 7000) && Date.now() - firstKeyD <= READ_WAIT + 4000,
    `${Date.now() - firstKeyD} ms after the first key; ${await tokenErr()}`);
  const refusedAtD = Date.now();
  ok("D: no card, Charge off", ((await reader()) || {}).st !== "card" && await chargeOff());
  ok("D: the reader re-arms by itself ~1.5 s later, the sentence still showing",
    await until(async () => ((await reader()) || {}).st === "waiting", 6000) && Date.now() - refusedAtD >= 1200 && (await tokenErr()) === REFUSED,
    `${Date.now() - refusedAtD} ms; ${JSON.stringify(await reader())}`);
  ok("D: Cancel usable again", !(await modal.getByRole("button", { name: "Cancel", exact: true }).isDisabled()));
  await page.screenshot({ path: join(shotsDir("swipeRealFrame"), "D-refused.png") }).catch(() => {});
  await cancel();
  S.cardsecure = "stub";

  // ── L: the 1001 refusal, four in a row, then Reset reader ──────────────────────────────────────
  frame = await openSwipe();
  await readerIs("waiting");
  const tokL = tokenizes.length;
  for (let n = 1; n <= 4; n++) {
    await readerIs("waiting", 8000);
    await swipe(makeInsertChipBlob());
    const said = await until(async () => (await tokenErr()).includes("code 1001") && (await tokenErr()).includes(CHIP_HINT), 8000);
    if (n === 1) {
      ok("L: a 1001 refusal shows CardPointe's code and words, and the chip hint", said, await tokenErr());
      ok("L: …nothing went to CardSecure (the frame refused it itself)", tokenizes.length === tokL);
    }
    if (n < 4) {
      ok(`L: refusal ${n}: the reader re-arms by itself`, await until(async () => ((await reader()) || {}).st === "waiting", 6000), JSON.stringify(await reader()));
    }
  }
  ok("L: the 4th refusal in a row stops at \"Reset reader\"", await readerIs("stuck", 6000) && await modal.getByRole("button", { name: "Reset reader", exact: true }).isVisible(),
    JSON.stringify(await reader()));
  await page.waitForTimeout(2500);
  ok("L: …and stays there (no fifth re-arm)", ((await reader()) || {}).st === "stuck");
  await page.screenshot({ path: join(shotsDir("swipeRealFrame"), "L-reset-reader.png") }).catch(() => {});
  await modal.getByRole("button", { name: "Reset reader", exact: true }).click();
  ok("L: Reset reader arms it again, the old sentence cleared", await readerIs("waiting") && !(await tokenErr()), JSON.stringify(await reader()));
  await swipe(makeBlob());
  ok("L: …and a good swipe is captured", await readerIs("card", 8000));
  await cancel();

  // ── K: a refused read in flight, and the operator switches to Bank / ACH ──────────────────────
  S.cardsecure = "abort";
  frame = await openSwipe();
  await readerIs("waiting");
  const typK = (await keys()).typing;
  const firstKeyK = Date.now();
  await swipe(makeBlob());
  ok("K: the read started (the frame said \"typing\")", (await keys()).typing > typK);
  await modal.getByRole("button", { name: "Bank / ACH", exact: true }).click();
  S.cardsecure = "stub";
  await modal.getByLabel("Routing number").fill("031201360");
  await modal.getByLabel("Checking account number").fill("000987654321");
  ok("K: the bank details are captured", await until(async () => (await modalText()).includes("Bank details captured ✓"), 8000), await flat());
  await page.waitForTimeout(Math.max(0, firstKeyK + READ_WAIT + 1500 - Date.now()));
  ok("K: past the card read's window the bank token stands: \"Bank details captured ✓\", Charge on",
    (await modalText()).includes("Bank details captured ✓") && !(await chargeOff()), await flat());
  ok("K: and the card reader's refusal sentence is not on the bank screen", !(await modalText()).includes(REFUSED), await flat());
  await cancel();

  // ── E: a card number typed by hand into the swipe frame ─────────────────────────────────────────
  frame = await openSwipe();
  await readerIs("waiting");
  const tokE = tokenizes.length;
  const firstKeyE = Date.now();
  S.expect = null;
  await hidType(TEST_PAN, 150);
  ok("E: the frame tokenized it as a typed number (stub)", await until(() => tokenizes.length > tokE, 8000) && tokenizes[tokE].kind === "account",
    JSON.stringify(tokenizes.slice(tokE).map((t) => t.kind)));
  ok("E: refused: \"That was typed, not read by the card reader…\"", await until(async () => (await tokenErr()) === TYPED, 4000), await flat());
  ok("E: no card, Charge off", ((await reader()) || {}).st !== "card" && await chargeOff());
  ok("E: the reader re-arms by itself", await readerIs("waiting", 6000));
  await page.waitForTimeout(Math.max(0, firstKeyE + READ_WAIT + 1500 - Date.now()));
  ok("E: the refusal timer was stopped by that answer: no Fiserv sentence past the read window", !(await modalText()).includes(REFUSED) && (await tokenErr()) === TYPED, await flat());
  await cancel();

  // ── N: the reader swiped on the Cash screen ────────────────────────────────────────────────────
  await openModal();
  await until(async () => (await amountBox().inputValue()) === "1000.00", 6000);
  await amountBox().focus();
  const tokN = tokenizes.length;
  const keysN = await keys();
  const blobN = makeBlob();
  await swipe(blobN);
  ok("N: the amount box keeps its figure (\"1000.00\"), nothing of the read in it", (await amountBox().inputValue()) === "1000.00", "value length " + (await amountBox().inputValue()).length);
  ok("N: the burst is swallowed", (await keys()).parent - keysN.parent >= 460 && (await keys()).through - keysN.through <= 45, JSON.stringify({ before: keysN, after: await keys() }));
  ok("N: the page says how to take the card", await until(async () => (await modalText()).includes("That looked like the card reader. To take the card, choose Card, then Charge it now, then Swipe."), 3000), await flat());
  ok("N: nothing went to CardSecure, nothing of the read on the page", tokenizes.length === tokN && !(await blobOnPage(blobN)));
  await cancel();

  // ── X ──
  ok("X: no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  ok("X: nothing tried to leave the machine but blocked fonts or the like",
    offBox.every((u) => !/supabase|cardconnect|cardpointe/i.test(u)), offBox.join(" | "));
  ok("X: every CardSecure request was answered here or aborted", tokenizes.length > 0 && net.cardsecureAnswered + net.cardsecureAborted >= tokenizes.length,
    JSON.stringify(net));
} catch (e) {
  ok(`harness: ${String(e && e.message || e).slice(0, 300)}`, false);
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
