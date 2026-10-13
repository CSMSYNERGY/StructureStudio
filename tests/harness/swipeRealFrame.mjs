// The card reader's swipe, driven into CardPointe's REAL UAT tokenizer iframe inside the COMPILED
// portal's Record-a-payment modal (2026-10-13).
//
// WHY THIS EXISTS. Every other payments harness stands a blank page in for the tokenizer and posts a
// token from inside it, and none of them pressed "Ready to swipe" or typed a key. So three defects
// that each lost every swipe were invisible to all of them: the swipe frame inherited the card
// rail's cardnumbernumericonly (CardPointe's own script cancelled every letter and Shift key the
// reader types), usecvv made every swipe post "CVV is Required" first, and "Ready" focused the
// iframe ELEMENT, which leaves the frame's activeElement on BODY so the keys went nowhere. Only the
// real iframe script shows any of that. Here the iframe URL is the one portal-payments serves: it
// is composed by running the shipped cpTokenizerUrl (supabase/functions/_shared/cardpointe.ts)
// under Deno, with the tokenizer base pointed at Fiserv's public UAT host.
//
// THE READER IS A USB KEYBOARD. It is simulated the way a HID keyboard types: Shift held DOWN for
// every uppercase letter and shifted symbol (keyboard.down("Shift") / press / up). Never
// keyboard.type: it sends "%" and "^" without Shift, which the numeric-only filter lets through,
// so a harness built on it would have passed against the broken URL.
//
//   S  the reader's frame is the swipe rail: the exact URL the server composes, one visible box,
//      no numeric-only / expiry / CVV, and short enough for the height the server serves
//   A  Card > Swipe > Ready: the label says "Getting the card box ready…" until the new frame has
//      loaded, then "Ready — swipe the card now" with the card box focused INSIDE the frame; a
//      ~460-character blob (uppercase hex with % ^ ? ; = and letters) plus the reader's two Enters
//      reaches CardSecure byte-for-byte, as devicedata of the same length; "Card captured ✓", no
//      "CVV is Required", no key reached the page; the charge goes out with entry "swipe" and no
//      billing fields
//   B  a second Ready after a token: the token, the "captured" line and Charge are cleared, a NEW
//      frame with an empty box loads, and the second blob arrives whole (no lost first character)
//      and is the one charged
//   C  Ready, then a click on a blank part of the modal, then a swipe: "didn't land", nothing sent
//      to CardSecure, every key of the burst swallowed while still armed, and Ready back within
//      ~2 s of the last key; Ready then takes a swipe normally
//   D  CardSecure refuses (the request is ABORTED): the Fiserv-refusal sentence within 10 s, no
//      "Card captured", and Ready usable again
//   E  the published test card number typed slowly by hand into the swipe frame: tokenized as
//      "manual" (stub), refused with "That was typed, not swiped…", no "Card captured", Charge off,
//      and the refusal sentence does not follow it
//   X  no uncaught page errors; nothing left the machine but the tokenizer page and its script
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root, after npm run compile)
//   node tests/harness/swipeRealFrame.mjs          (exit 0 = every check held, or SKIPPED offline)
//
// ⚠️ WHAT LEAVES THE MACHINE: GETs for the UAT tokenizer page and its own script, nothing else.
// EVERY request to /cardsecure/ (tokenize, retrievePublicKey) is answered here or aborted, so
// nothing is ever tokenized by Fiserv. Every Supabase host is answered here; every other request is
// aborted. The only things typed are random hex blobs and the published test card 4111111111111111,
// and neither the blobs nor any keystroke is ever printed: checks report lengths and booleans.
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
const TEST_PAN = "4111111111111111";   // the published test card; never a real one

// cardsecure: "stub" answers tokenize with a fake token; "abort" refuses it like a network failure.
// pageDelayMs holds the swipe frame's page back, so "Getting the card box ready…" can be seen.
const S = { cardsecure: "stub", pageDelayMs: 0, expect: null, minted: 0 };
const tokenizes = [];          // { kind, len, intact, at } — never the data itself
const net = { tokenizerGets: 0, cardsecureAnswered: 0, cardsecureAborted: 0 };
const fnCalls = [];
const offBox = [];

const { ok, failed, results } = reporter();
const { browser, ctx } = await launch({ width: 1280, height: 1100 });
await ctx.addInitScript(([ref, s]) => {
  if (window.top !== window) return;           // never into the tokenizer's own frame
  try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  // Keydowns that reach the PORTAL's document (never the frame's), COUNTED ONLY: which key it was
  // is card data and is never read. `unarmed` = arrived while Ready was clickable, i.e. not trapped.
  window.__harnessKeys = { parent: 0, unarmed: 0 };
  window.addEventListener("keydown", () => {
    window.__harnessKeys.parent++;
    const b = [...document.querySelectorAll("button")].find((x) => /^(Ready to swipe|Card read)/.test(x.textContent));
    if (b && !b.disabled) window.__harnessKeys.unarmed++;
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
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "No error", errorcode: 0, token: `94180000000${String(S.minted).padStart(5, "0")}` }) });
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
    if (body.action === "charge") return json(route, { ok: true, amountCents: 100000, last4: "1111" });
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
const PLAIN = { ";": "Semicolon", "=": "Equal", "/": "Slash", " ": "Space" };
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
// A swipe: the blob, then the VP3350's default postfix (two carriage returns).
const swipe = async (blob) => { S.expect = blob; await hidType(blob); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); };

let modal = null;
const recordBtn = page.getByRole("button", { name: "Record a payment" });
async function openSwipe() {
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Record a payment");
    return b && !b.disabled;
  }, null, { timeout: 15000 }).catch(() => {});
  await recordBtn.click();
  modal = page.locator("div[style*='z-index: 1200']").last();
  await modal.waitFor({ timeout: 10000 });
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
const readyBtn = () => page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /^(Ready to swipe|Ready — swipe the card now|Getting the card box ready…|Card read ✓ — swipe again)$/.test(x.textContent));
  return b ? { text: b.textContent, disabled: b.disabled } : null;
});
// A real mouse click, as a person presses it: the focus goes to the page first, and only the
// reloaded frame's own autofocus brings it back into the card box.
const pressReady = () => modal.getByRole("button", { name: /^(Ready to swipe|Card read ✓ — swipe again)$/ }).click({ timeout: 5000 }).then(() => true, () => false);
const waitSwipeNow = () => until(async () => ((await readyBtn()) || {}).text === "Ready — swipe the card now", 20000);
const modalText = () => modal.innerText({ timeout: 1000 }).catch(() => "");
// The modal's words on one line, for a check's note (the card box is inside the frame, never in here).
const flat = async () => (await modalText()).replace(/\s*\n\s*/g, " | ").slice(0, 400);
const chargeOff = () => modal.getByRole("button", { name: /^(Charge \$|Checking card fee)/ }).isDisabled({ timeout: 1000 }).catch(() => true);
const frameState = (f) => f.evaluate(() => {
  const a = document.activeElement;
  const box = document.getElementById("ccnumfield");
  return { active: a ? (a.id || a.tagName) : null, len: box ? box.value.length : null };
}).catch(() => ({ active: null, len: null }));
const keys = () => page.evaluate(() => ({ ...window.__harnessKeys }));
const DIDNT_LAND = "That swipe didn't land in the card box.";
const REFUSED = "The reader read the card, but Fiserv's card system didn't accept it.";
const TYPED = "That was typed, not swiped. Press Ready and swipe the card.";

try {
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/orders/o-${ORDER_ID}`);
  ok("0: the order opens with Record a payment", await recordBtn.waitFor({ timeout: 20000 }).then(() => true, () => false));

  // ── S: the frame is the swipe rail ─────────────────────────────────────────────────────────────
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
  const shown = await frame.evaluate(() => ({
    inputs: [...document.querySelectorAll("input")].filter((i) => i.type !== "hidden" && getComputedStyle(i).display !== "none").map((i) => i.id),
    height: document.documentElement.scrollHeight,
    placeholder: (document.getElementById("ccnumfield") || {}).placeholder,
  }));
  ok("S: one box, the card reader's, and no expiry or CVV boxes", shown.inputs.length === 1 && shown.inputs[0] === "ccnumfield" && shown.placeholder === "Swipe the card", JSON.stringify(shown));
  const drawn = await modal.locator("iframe[title='Payment details']").evaluate((el) => el.style.height);
  ok("S: the frame is drawn at the served swipe height, and its content fits", drawn === `${TOKENIZER.swipeHeight}px` && shown.height <= TOKENIZER.swipeHeight,
    `drawn ${drawn}, content ${shown.height}px, served ${TOKENIZER.swipeHeight}px`);

  // ── A: Ready, wait for the new frame, swipe, charge ─────────────────────────────────────────────
  S.pageDelayMs = 1500;
  const loadsBeforeA = net.tokenizerGets;
  ok("A: Ready is offered", ((await readyBtn()) || {}).text === "Ready to swipe", JSON.stringify(await readyBtn()));
  await pressReady();
  await page.waitForTimeout(250);
  ok("A: while the new frame loads the button says so, and does not invite the swipe",
    ((await readyBtn()) || {}).text === "Getting the card box ready…", JSON.stringify(await readyBtn()));
  ok("A: then \"Ready — swipe the card now\"", await waitSwipeNow(), JSON.stringify(await readyBtn()));
  S.pageDelayMs = 0;
  ok("A: Ready reloaded the frame", net.tokenizerGets > loadsBeforeA, `${loadsBeforeA} -> ${net.tokenizerGets}`);
  frame = await swipeFrame();
  ok("A: the card box INSIDE the frame has the focus, and it is empty", !!frame && (await frameState(frame)).active === "ccnumfield" && (await frameState(frame)).len === 0,
    frame ? JSON.stringify(await frameState(frame)) : "no frame");
  const keysA = await keys();
  const blobA = makeBlob();
  const tokA = tokenizes.length;
  await swipe(blobA);
  ok("A: CardSecure got ONE devicedata, the length typed, byte-for-byte (letters and symbols intact)",
    await until(() => tokenizes.length > tokA, 8000) && tokenizes.length === tokA + 1
      && tokenizes[tokA].kind === "devicedata" && tokenizes[tokA].len === blobA.length && tokenizes[tokA].intact === true,
    JSON.stringify({ typed: blobA.length, got: tokenizes.slice(tokA) }));
  ok("A: \"Card captured ✓\"", await until(async () => (await modalText()).includes("Card captured ✓"), 8000), await flat());
  ok("A: no \"CVV is Required\", no \"didn't land\"", !(await modalText()).includes("CVV is Required") && !(await modalText()).includes(DIDNT_LAND));
  const keysA2 = await keys();
  ok("A: not one key of the swipe reached the page", keysA2.parent === keysA.parent, JSON.stringify({ before: keysA, after: keysA2 }));
  ok("A: the button offers another swipe", ((await readyBtn()) || {}).text === "Card read ✓ — swipe again", JSON.stringify(await readyBtn()));
  await page.screenshot({ path: join(shotsDir("swipeRealFrame"), "A-captured.png") }).catch(() => {});
  const chargesA = charges().length;
  ok("A: Charge is on", await until(async () => !(await chargeOff()), 6000));
  await modal.getByRole("button", { name: /^Charge \$/ }).click();
  ok("A: the charge went out", await until(() => charges().length > chargesA, 6000));
  const chA = charges().slice(-1)[0] || {};
  ok("A: …marked entry \"swipe\", with the token the frame minted, and no name, address or postal",
    chA.entry === "swipe" && chA.payToken === `94180000000${String(S.minted).padStart(5, "0")}` && !has(chA, "name") && !has(chA, "address") && !has(chA, "postal"),
    JSON.stringify({ entry: chA.entry, rail: chA.rail, keys: Object.keys(chA) }));

  // ── B: a second Ready after a token ──────────────────────────────────────────────────────────
  frame = await openSwipe();
  await pressReady();
  await waitSwipeNow();
  await swipe(makeBlob());
  await until(async () => (await modalText()).includes("Card captured ✓"), 8000);
  const firstTok = `94180000000${String(S.minted).padStart(5, "0")}`;
  await modal.locator("iframe[title='Payment details']").evaluate((el) => { el.dataset.harnessOld = "1"; });
  ok("B: the first swipe is captured", (await modalText()).includes("Card captured ✓") && !(await chargeOff()));
  await pressReady();
  await page.waitForTimeout(150);
  ok("B: pressing Ready again clears the first card: no \"captured\", Charge off",
    !(await modalText()).includes("Card captured ✓") && await chargeOff(), await flat());
  ok("B: …and waits for the NEW frame", await waitSwipeNow());
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
  ok("B: \"Card captured ✓\" again", await until(async () => (await modalText()).includes("Card captured ✓"), 8000));
  const chargesB = charges().length;
  await until(async () => !(await chargeOff()), 6000);
  await modal.getByRole("button", { name: /^Charge \$/ }).click();
  await until(() => charges().length > chargesB, 6000);
  const chB = charges().slice(-1)[0] || {};
  ok("B: the charge carries the SECOND card's token", chB.payToken === `94180000000${String(S.minted).padStart(5, "0")}` && chB.payToken !== firstTok && chB.entry === "swipe",
    JSON.stringify({ entry: chB.entry, second: chB.payToken !== firstTok }));

  // ── C: Ready, a click on a blank part of the modal, then the swipe ───────────────────────────────
  frame = await openSwipe();
  await pressReady();
  await waitSwipeNow();
  await modal.getByText("Amount", { exact: true }).click();
  frame = await swipeFrame();
  ok("C: the click took the focus out of the card box", !!frame && (await frameState(frame)).active !== "ccnumfield", frame ? JSON.stringify(await frameState(frame)) : "no frame");
  const keysC = await keys();
  const tokC = tokenizes.length;
  await swipe(makeBlob());
  const lastKeyAt = Date.now();
  ok("C: \"didn't land\" is said", await until(async () => (await modalText()).includes(DIDNT_LAND), 3000), await flat());
  const keysC2 = await keys();
  ok("C: every key of the burst reached the page while still armed (all swallowed)",
    keysC2.parent - keysC.parent >= 460 && keysC2.unarmed === keysC.unarmed, JSON.stringify({ before: keysC, after: keysC2 }));
  ok("C: Ready is back within ~2 s of the last key",
    await until(async () => { const r = await readyBtn(); return !!r && !r.disabled && r.text === "Ready to swipe"; }, 4000) && Date.now() - lastKeyAt <= 2600,
    `${Date.now() - lastKeyAt} ms; ${JSON.stringify(await readyBtn())}`);
  ok("C: …and Cancel and the close button with it", !(await modal.getByRole("button", { name: "Cancel", exact: true }).isDisabled()));
  ok("C: nothing went to CardSecure, the box is still empty, nothing captured",
    tokenizes.length === tokC && (await frameState(frame)).len === 0 && !(await modalText()).includes("Card captured ✓"));
  await page.screenshot({ path: join(shotsDir("swipeRealFrame"), "C-didnt-land.png") }).catch(() => {});
  await pressReady();
  ok("C: Ready then takes a swipe normally", await waitSwipeNow());
  const blobC = makeBlob();
  await swipe(blobC);
  ok("C: …captured, whole", await until(async () => (await modalText()).includes("Card captured ✓"), 8000)
    && tokenizes.length === tokC + 1 && tokenizes[tokC].intact === true && !(await modalText()).includes(DIDNT_LAND));
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();

  // ── D: CardSecure refuses the read ───────────────────────────────────────────────────────────
  S.cardsecure = "abort";
  frame = await openSwipe();
  await pressReady();
  await waitSwipeNow();
  const tokD = tokenizes.length;
  await swipe(makeBlob());
  const lastKeyD = Date.now();
  ok("D: the read went to CardSecure (and was aborted here)", await until(() => tokenizes.length > tokD, 8000) && net.cardsecureAborted > 0);
  ok("D: the Fiserv-refusal sentence within 10 s of the swipe", await until(async () => (await modalText()).includes(REFUSED), 10000) && Date.now() - lastKeyD <= 10000,
    `${Date.now() - lastKeyD} ms`);
  ok("D: no \"Card captured\", Charge off", !(await modalText()).includes("Card captured ✓") && await chargeOff());
  ok("D: Ready usable again", await until(async () => { const r = await readyBtn(); return !!r && !r.disabled; }, 2000), JSON.stringify(await readyBtn()));
  await page.screenshot({ path: join(shotsDir("swipeRealFrame"), "D-refused.png") }).catch(() => {});
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  S.cardsecure = "stub";

  // ── E: a card number typed by hand into the swipe frame ─────────────────────────────────────────
  frame = await openSwipe();
  await pressReady();
  await waitSwipeNow();
  const tokE = tokenizes.length;
  const firstKeyE = Date.now();
  S.expect = null;
  await hidType(TEST_PAN, 150);
  ok("E: the frame tokenized it as a typed number (stub)", await until(() => tokenizes.length > tokE, 8000) && tokenizes[tokE].kind === "account",
    JSON.stringify(tokenizes.slice(tokE).map((t) => t.kind)));
  ok("E: refused: \"That was typed, not swiped…\"", await until(async () => (await modalText()).includes(TYPED), 4000), await flat());
  ok("E: no \"Card captured\", Charge off", !(await modalText()).includes("Card captured ✓") && await chargeOff());
  ok("E: Ready usable again", await until(async () => { const r = await readyBtn(); return !!r && !r.disabled; }, 2000));
  await page.waitForTimeout(Math.max(0, firstKeyE + 9500 - Date.now()));
  ok("E: the refusal timer was stopped by that answer: no Fiserv sentence 9.5 s on", !(await modalText()).includes(REFUSED) && (await modalText()).includes(TYPED), await flat());
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();

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
