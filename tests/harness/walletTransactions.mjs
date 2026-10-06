// Billing → Wallet → Transactions (usage billing, migration 259), driven for real on the COMPILED
// portal.
//
// Carolyn 2026-10-02: every call minute and text comes out of the wallet, "each charge is its own
// line under Transactions, like GoHighLevel". The view is a table (Date, Description, Amount,
// Balance), chips All / Calls / Texts / Funds / Other, a date range, Load more and Export CSV.
// A call or text shows four decimal places ($0.0280); everything else two, except a balance,
// which shows four whenever it owes a fraction of a cent (a top-up after a text: $53.1404).
//
// Scenarios, one fresh browser context each:
//   a. desktop, an owner: the four column headings; the first 50 lines; a call reads −$0.0280
//      with a four-place balance, a top-up +$25.00; Load more appends the next 50 and then the
//      last 20 and disappears; the old "Recent activity" list is gone; the meter list says
//      "Billed per call minute" / "Billed per text" and never "No charge" for those two.
//   b. the chips and the date range: Calls asks portal-billing for filter "calls" and shows only
//      calls; a date range is sent as the builder's own local midnights (to = the day AFTER the
//      end date); an end before the start is refused on the page and sends nothing.
//   c. Export CSV: the request carries format csv, the chip, the range and the browser's time
//      zone; the download is the server's CSV behind a UTF-8 byte-order mark.
//   d. a phone (390 px): no horizontal scroll, no column-heading row, each line is description
//      over date and amount over balance.
//   e. a portal that ships ahead of portal-billing: the action is refused ("Unrecognised
//      action"), and the view falls back to status's ten-line list with a note instead of
//      going blank.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine), exactly as
// billingFounding.mjs does it; the ledger and its paging are answered from a fake 120-line
// ledger here, in the shape portal-billing's `wallet_transactions` returns
// (_shared/walletLedger.ts toLedgerRow).
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root; SS_BASE overrides the origin)
//   node tests/harness/walletTransactions.mjs       (exit 0 = every check held)
//
// Screenshots go to SS_SHOTS (else the OS temp dir; see lib.mjs shotsDir).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, shotsDir, BASE, REF } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const SHOTS = shotsDir("wallet-transactions");

const CLIENT = "harness-wallet";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000009", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// ── The ledger: 120 lines, oldest first by id, in toLedgerRow's shape ────────────────────────
const T0 = Date.parse("2026-09-20T15:00:00.000Z");
const LEDGER = [];
let bal = 0; // micros
for (let id = 1; id <= 120; id++) {
  const at = new Date(T0 + id * 3 * 3600_000).toISOString();
  let row;
  if (id % 40 === 1) {
    bal += 25_000_000;
    row = { kind: "topup", category: "funds", description: "Added funds", amount: 25_000_000, precise: false };
  } else if (id % 3 === 0) {
    const m = 16_600;
    bal -= m;
    row = { kind: "debit", category: "texts", description: `Text to (555) 010-${String(id).padStart(4, "0")} · 1 segment`, amount: -m, precise: true };
  } else if (id === 50) {
    bal -= 20_000_000;
    row = { kind: "debit", category: "other", description: "3D generation from a video", amount: -20_000_000, precise: false };
  } else {
    const m = 28_000;
    bal -= m;
    row = { kind: "debit", category: "calls", description: `Outbound call to (555) 010-${String(id).padStart(4, "0")} · 1 min`, amount: -m, precise: true };
  }
  LEDGER.push({
    id, created_at: at, description: row.description, kind: row.kind, category: row.category, pending: false,
    amount_cents: Math.trunc(row.amount / 10_000), amount_exact_micros: row.amount,
    // 259: the stored cents are the exact balance rounded UP; the sub-cent remainder is owed.
    balance_after_cents: Math.ceil(bal / 10_000), balance_after_exact_micros: bal, precise: row.precise,
  });
}
const NEWEST = [...LEDGER].reverse();
const ledgerPage = (body) => {
  let rows = NEWEST.filter((r) => !body.filter || body.filter === "all" || r.category === body.filter);
  if (body.from) rows = rows.filter((r) => r.created_at >= body.from);
  if (body.to) rows = rows.filter((r) => r.created_at < body.to);
  if (body.cursor) rows = rows.filter((r) => r.id < Number(body.cursor));
  const page = rows.slice(0, 50);
  return { rows: page, next_cursor: rows.length > 50 ? String(page[page.length - 1].id) : null };
};
const CSV = "Date,Description,Amount,Balance\r\n2026-10-04 09:00,Outbound call to (555) 010-0119 · 1 min,-0.0280,24.9172\r\n";

const STATUS = {
  configured: true,
  entitlement: { exempt: false, state: "active", locked: false, reason: "active", graceEndsAt: null, graceDays: 7, transitionEndsAt: null, requiredRate: { monthlyCents: 19500, annualCents: 195000, listMonthlyCents: 19500, listAnnualCents: 195000, discountPercent: 0 }, granted: [], features: { simple_layout: true } },
  wallet: {
    balanceCents: Math.ceil(bal / 10_000), heldCents: 0, exempt: false, minTopupCents: 2000, maxTopupCents: 500000,
    autoTopup: { enabled: false, thresholdCents: null, amountCents: null, lastAt: null, disabledReason: null },
    meters: [
      { kind: "sms_registration", label: "Text messaging setup", unitLabel: "one-time", priceCents: 4900 },
      { kind: "voice_minute", label: "Call minutes", unitLabel: "minute", priceCents: null, billedAs: "Billed per call minute" },
      { kind: "sms_segment", label: "Texts", unitLabel: "segment", priceCents: null, billedAs: "Billed per text" },
    ],
    // status's ten-line list, newest first, whole cents — what the fallback shows.
    transactions: NEWEST.slice(0, 10).map((r) => ({ id: r.id, label: r.description, amountCents: r.amount_cents, pending: false, at: r.created_at })),
  },
  upgradeCredits: {}, hasCard: true, discount: { percent: 0, features: [] },
  plans: [{ id: "simple_layout_annual", feature: "simple_layout", name: "Simple Layout", price_cents: 195000, billing_interval: "annual", setup_fee_cents: 0, availability: "available", required: true, sort_order: 100, price_visible: true, operator_grantable: false, charge_cents: 195000, discount_percent: 0 }],
  subscriptions: [{ id: "sub-1", plan_id: "simple_layout_annual", status: "active", price_cents: 195000, current_period_start: "2026-09-01T00:00:00Z", current_period_end: "2027-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" }],
  checkout: { tokenizationKey: "stub", collectJsUrl: "https://secure.example.invalid/token/Collect.js" },
};

const { ok, failed, results } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

async function open(label, { width = 1400, height = 1000, legacyBackend = false } = {}) {
  const billing = [];
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block", acceptDownloads: true, timezoneId: "America/Chicago" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/")) return json(route, false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      const warm = new URL(url).searchParams.has("warm");
      if (warm) return json(route, { ok: true });
      billing.push(body);
      if (body.action === "status") return json(route, STATUS);
      if (body.action === "wallet_transactions") {
        // An older portal-billing has no such action: resolveTenant's fail-closed 403.
        if (legacyBackend) return json(route, { error: `Unrecognised action "${body.action}".` }, 403);
        if (body.format === "csv") return json(route, { csv: CSV, rows: 1, truncated: false });
        return json(route, ledgerPage(body));
      }
      return json(route, { error: `Harness stub: unexpected portal-billing action ${body.action}` }, 400);
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, branding: {} });
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  await page.goto(`${BASE}/portal/settings/wallet`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForSelector('[data-wallet-tx="card"]', { timeout: 20000 });
  return { label, page, ctx, billing, pageErrors };
}

const txCalls = (S) => S.billing.filter((b) => b.action === "wallet_transactions");
const rowIds = (page) => page.$$eval("[data-wallet-tx-row]", (els) => els.map((e) => Number(e.getAttribute("data-wallet-tx-row"))));
const rowText = (page, id) => page.$eval(`[data-wallet-tx-row="${id}"]`, (e) => e.innerText.replace(/\s+/g, " ").trim());
const settle = (page) => page.waitForTimeout(400);
const waitRows = (page, n) => page.waitForFunction((k) => document.querySelectorAll("[data-wallet-tx-row]").length === k, n, { timeout: 10000 }).then(() => true, () => false);

try {
  // ── a: desktop ──
  {
    const S = await open("a");
    const P = "a (desktop)";
    ok(`${P}: the first page is 50 lines, newest first`, await waitRows(S.page, 50));
    const ids = await rowIds(S.page);
    ok(`${P}: lines are in the server's order`, ids[0] === 120 && ids[49] === 71, `${ids[0]}…${ids[49]}`);
    const card = await S.page.$eval('[data-wallet-tx="card"]', (e) => e.innerText);
    ok(`${P}: the column headings read Date / Description / Amount / Balance`, /DATE\s+DESCRIPTION\s+AMOUNT\s+BALANCE/i.test(card));
    const call = await rowText(S.page, 119);
    ok(`${P}: a call shows four places, amount and balance`, /Outbound call to \(555\) 010-0119 · 1 min −\$0\.0280 \$\d+\.\d{4}$/.test(call), call);
    const text = await rowText(S.page, 117);
    ok(`${P}: a text shows four places`, text.includes("−$0.0166"), text);
    const first = await txCalls(S)[0];
    ok(`${P}: the first request is the All chip with no cursor or dates`, first && first.filter === "all" && !first.cursor && !first.from && !first.to, JSON.stringify(first));
    const page = await S.page.evaluate(() => document.body.innerText);
    ok(`${P}: the old "Recent activity" list is gone`, !page.includes("Recent activity") && !page.includes("RECENT ACTIVITY"));
    ok(`${P}: the meter list describes calls and texts`, page.includes("Billed per call minute") && page.includes("Billed per text"));
    const meterLines = await S.page.evaluate(() => [...document.querySelectorAll("div")].filter((d) => /^(Call minutes|Texts)/.test(d.innerText) && d.children.length === 2).map((d) => d.innerText));
    ok(`${P}: neither of them says "No charge" or a dollar price`, meterLines.length === 2 && meterLines.every((t) => !/No charge|\$/.test(t)), JSON.stringify(meterLines));
    await S.page.screenshot({ path: join(SHOTS, "a-desktop.png"), fullPage: true });

    await S.page.click("[data-wallet-tx-more]");
    ok(`${P}: Load more appends the next 50`, await waitRows(S.page, 100));
    ok(`${P}: …asking for the page below the last id shown`, txCalls(S).at(-1).cursor === "71", JSON.stringify(txCalls(S).at(-1)));
    const top = await rowText(S.page, 81);
    // Its balance owes 400 micros, so it has four places like the CSV's, not the amount's two.
    ok(`${P}: a top-up shows two places, on a balance that keeps its fraction of a cent`, /Added funds \+\$25\.00 \$53\.1404$/.test(top), top);
    const threeD = await rowText(S.page, 50);
    ok(`${P}: a 3D generation shows two places`, threeD.includes("−$20.00"), threeD);
    await S.page.click("[data-wallet-tx-more]");
    ok(`${P}: the last page brings all 120 lines`, await waitRows(S.page, 120));
    const opening = await rowText(S.page, 1);
    ok(`${P}: a top-up on a whole-cent balance shows two places for both`, /Added funds \+\$25\.00 \$25\.00$/.test(opening), opening);
    ok(`${P}: and Load more is gone`, (await S.page.$$("[data-wallet-tx-more]")).length === 0);
    ok(`${P}: no page errors`, S.pageErrors.length === 0, S.pageErrors.join(" | "));
    await S.ctx.close();
  }

  // ── b: chips and dates ──
  {
    const S = await open("b");
    const P = "b (filters)";
    await waitRows(S.page, 50);
    await S.page.click('[data-wallet-tx-filter="calls"]');
    await S.page.waitForFunction(() => document.querySelector('[data-wallet-tx-filter="calls"]').getAttribute("aria-pressed") === "true");
    await settle(S.page);
    const last = txCalls(S).at(-1);
    ok(`${P}: Calls asks for filter "calls" from the top`, last.filter === "calls" && !last.cursor, JSON.stringify(last));
    const texts = await S.page.$$eval("[data-wallet-tx-row]", (els) => els.map((e) => e.innerText));
    ok(`${P}: only calls are shown`, texts.length > 0 && texts.every((t) => t.includes("Outbound call")), `${texts.length} lines`);
    await S.page.click('[data-wallet-tx-filter="all"]');
    await settle(S.page);
    const dates = S.page.locator('[data-wallet-tx="card"] input[type="date"]');
    await dates.nth(0).fill("2026-09-25");
    await dates.nth(1).fill("2026-09-30");
    await settle(S.page);
    const ranged = txCalls(S).at(-1);
    // Chicago is UTC−5 in September: local midnight of the 25th is 05:00Z; the end is the 1st.
    ok(`${P}: the range is sent as local midnights, the end exclusive`, ranged.from === "2026-09-25T05:00:00.000Z" && ranged.to === "2026-10-01T05:00:00.000Z", JSON.stringify(ranged));
    const shown = await S.page.$$eval("[data-wallet-tx-row]", (els) => els.length);
    ok(`${P}: the table narrows to the range`, shown > 0 && shown < 50, `${shown} lines`);
    const before = txCalls(S).length;
    await dates.nth(0).fill("2026-10-05");
    await settle(S.page);
    const cardText = await S.page.$eval('[data-wallet-tx="card"]', (e) => e.innerText);
    ok(`${P}: an end before the start is refused on the page`, cardText.includes("The start date is after the end date.") && (await rowIds(S.page)).length === 0);
    ok(`${P}: …and sends nothing`, txCalls(S).length === before, `${txCalls(S).length - before} extra request(s)`);
    await S.page.getByRole("button", { name: "Clear dates" }).click();
    ok(`${P}: Clear dates brings the full list back`, await waitRows(S.page, 50));
    await S.page.screenshot({ path: join(SHOTS, "b-filters.png"), fullPage: true });
    await S.ctx.close();
  }

  // ── c: export ──
  {
    const S = await open("c");
    const P = "c (export)";
    await waitRows(S.page, 50);
    await S.page.click('[data-wallet-tx-filter="texts"]');
    await settle(S.page);
    const [download] = await Promise.all([S.page.waitForEvent("download", { timeout: 10000 }), S.page.click("[data-wallet-tx-export]")]);
    const req = txCalls(S).at(-1);
    ok(`${P}: the request is format csv, with the chip and the browser's zone`, req.format === "csv" && req.filter === "texts" && req.tz === "America/Chicago", JSON.stringify(req));
    const file = await download.path();
    const bytes = readFileSync(file);
    ok(`${P}: the file starts with a UTF-8 byte-order mark`, bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF);
    ok(`${P}: the rest is the server's CSV, byte for byte`, bytes.subarray(3).toString("utf8") === CSV);
    ok(`${P}: the file is named for the chip and today`, /^wallet-transactions-texts-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), download.suggestedFilename());
    ok(`${P}: the card says what was downloaded`, (await S.page.$eval('[data-wallet-tx="card"]', (e) => e.innerText)).includes("Downloaded 1 line."));
    await S.ctx.close();
  }

  // ── d: a phone, and the narrowest one still sold ──
  for (const width of [390, 320]) {
    const S = await open("d", { width, height: 844 });
    const P = `d (phone ${width}px)`;
    ok(`${P}: the first page renders`, await waitRows(S.page, 50));
    const m = await S.page.evaluate(() => {
      const card = document.querySelector('[data-wallet-tx="card"]');
      const doc = document.scrollingElement;
      const row = card.querySelector('[data-wallet-tx-row="119"]');
      const kids = row ? [...row.children] : [];
      return {
        docOverflow: doc.scrollWidth - doc.clientWidth,
        cardOverflow: card.scrollWidth - card.clientWidth,
        heading: /DESCRIPTION/.test(card.innerText),
        rowCols: kids.length,
        left: kids[0] ? kids[0].innerText.split("\n") : [],
        right: kids[1] ? kids[1].innerText.split("\n") : [],
        rowRight: row ? row.getBoundingClientRect().right : 0,
        cardRight: card.getBoundingClientRect().right,
      };
    });
    ok(`${P}: no horizontal scroll on the page or the card`, m.docOverflow <= 0 && m.cardOverflow <= 0, `doc +${m.docOverflow}px, card +${m.cardOverflow}px`);
    ok(`${P}: no column-heading row`, !m.heading);
    ok(`${P}: a line is description over date, amount over balance`, m.rowCols === 2 && m.left.length === 2 && /^Outbound call/.test(m.left[0]) && /·/.test(m.left[1]) && /^−\$0\.0280$/.test(m.right[0]) && /^Balance \$\d+\.\d{4}$/.test(m.right[1]), JSON.stringify(m));
    ok(`${P}: lines stay inside the card`, m.rowRight <= m.cardRight + 0.5);
    // With a range set, the two date fields share the row and still fit.
    const dates = S.page.locator('[data-wallet-tx="card"] input[type="date"]');
    await dates.nth(0).fill("2026-09-25");
    await dates.nth(1).fill("2026-09-30");
    await settle(S.page);
    const f = await S.page.evaluate(() => {
      const card = document.querySelector('[data-wallet-tx="card"]');
      const inputs = [...card.querySelectorAll('input[type="date"]')].map((i) => i.getBoundingClientRect());
      const cs = getComputedStyle(card);
      const inner = card.getBoundingClientRect().right - parseFloat(cs.paddingRight);
      return { cardOverflow: card.scrollWidth - card.clientWidth, sameRow: Math.abs(inputs[0].top - inputs[1].top) < 2, fit: inputs.every((r) => r.right <= inner + 0.5), widths: inputs.map((r) => Math.round(r.width)) };
    });
    // Wide enough to read a whole date (about 110 px with the picker icon); side by side where
    // that fits, stacked on the narrowest card.
    ok(`${P}: with dates set, both fields fit inside the card and are wide enough to read`,
      f.cardOverflow <= 0 && f.fit && f.widths.every((w) => w >= 110) && (width === 390 ? f.sameRow : true), JSON.stringify(f));
    await S.page.$eval('[data-wallet-tx="card"]', (e) => e.scrollIntoView());
    await S.page.screenshot({ path: join(SHOTS, `d-phone-${width}.png`) });
    await S.ctx.close();
  }

  // ── e: the portal ahead of portal-billing ──
  {
    const S = await open("e", { legacyBackend: true });
    const P = "e (older backend)";
    ok(`${P}: falls back to status's ten lines`, await waitRows(S.page, 10));
    const card = await S.page.$eval('[data-wallet-tx="card"]', (e) => e.innerText);
    ok(`${P}: and says why`, card.includes("Showing your latest activity only.") && card.includes("Unrecognised action"), card.slice(0, 200));
    ok(`${P}: no Load more on the fallback`, (await S.page.$$("[data-wallet-tx-more]")).length === 0);
    await S.page.screenshot({ path: join(SHOTS, "e-fallback.png"), fullPage: true });
    await S.ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\nshots: ${SHOTS}`);
console.log(`${results.length - failed().length}/${results.length} checks held`);
process.exit(failed().length ? 1 : 0);
