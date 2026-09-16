// Sales tax on a quote, an order and an acceptance — the Avalara stage's quote-side UI, driven for real.
//
// Drives the COMPILED portal and my-quotes.html with Supabase stubbed at the network layer (no login,
// nothing leaves the machine, and no call ever reaches Avalara — verify_tax is answered here) and
// asserts what shows, what gets called, and with which body:
//
//   A. an SS quote's record shows its tax line, which rate priced it, the total, the location picker
//      and — with lookups on and settings_crm edit — the billed-lookup warning and the button
//   B. dismissing the first confirm calls nothing
//   C. verify on an emailed quote: quote_sent → a second confirm naming the quote and the re-send →
//      the call repeats with confirmResend, and the screen takes its figures from the response
//   D. a failed lookup shows the server's sentence and leaves the tax line as it was
//   E. confirm_operator → a view-as confirm → the call repeats with confirmVerify
//   F. changing the sales location on an emailed quote: quote_sent names both totals → confirmResend
//   G. lookups switched off: no warning, no button
//   H. a CRM-mode (GHL) design shows no Sales tax card and reads nothing for one
//   I. an accepted quote is read-only
//   J. the order document: the basis line under the tax row, the tax frozen on the acceptance, and
//      send_invoice's tax check shown as a note beside the success message
//   K. the Pipeline's Send invoice shows a failed tax check as a note, not an error
//   L. my-quotes: Accept sends the total it showed; a "repriced" 409 shows the sentence and a Reload
//      button, keeps the customer signed in, and Reload lists the quotes again
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/quoteSalesTax.mjs            (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<path to an older portal.app.compiled.js> serves that file instead, which is how
// to prove the checks can fire: against 57ae592's artifact every A check that looks for the card
// fails, and the run then stops at B with nothing to press. (L drives my-quotes.html, which that
// variable does not swap.)
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF } from "./lib.mjs";

const CLIENT = "harness-quote-tax";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

const SS = "SS-TAXQUOTE1", GHL = "SS-GHLQUOTE1", ACC = "SS-ACCQUOTE1";
const CONTACT = { name: "Pat Tester", phone: "(478) 555-0100", email: "pat@example.test", street: "1 Main St", city: "Macon", state: "GA", zip: "31201" };
const LINES = [{ name: "Utility 10x12", qty: 1, amount: 9000, kind: "building" }];
const TAX_LOCATION = { rate: 0.0725, amount: 652.5, label: "Sales tax", source: "fallback", basis: "location", locationId: "L1", locationName: "Hwy 65 Display", verifiedAt: null, jurisdiction: null, address: { state: "GA", zip: "31201" } };
const TAX_VERIFIED = { rate: 0.081, amount: 729, label: "Sales tax", source: "avalara", basis: "avalara", locationId: null, locationName: null, verifiedAt: "2026-09-17T12:00:00Z", jurisdiction: "Bibb County, GA", address: { state: "GA", zip: "31201" } };
const TAX_COMPANY = { rate: 0.065, amount: 585, label: "Sales tax", source: "fallback", basis: "company", locationId: null, locationName: null, verifiedAt: null, jurisdiction: null };
const LOCS = [
  { id: "L1", name: "Hwy 65 Display", street: "9 Hwy 65", city: "Macon", state: "GA", zip: "31201", active: true, sort_order: 0, buildings: 2, taxRatePct: 7.25, taxLabel: null, taxReady: true },
  { id: "L2", name: "North Lot", street: null, city: "Warner Robins", state: "GA", zip: "31088", active: true, sort_order: 1, buildings: 0, taxRatePct: null, taxLabel: null, taxReady: true },
];
const design = (code, over = {}) => ({
  short_code: code, created_at: "2026-09-10T15:00:00Z", updated_at: "2026-09-16T15:00:00Z", status: "sent", accepted_at: null,
  total_cents: 965250, estimate_lines: { lines: LINES, discount: 0, tax: TAX_LOCATION }, ss_quote_number: "SST-1041",
  ss_quote_sent_at: "2026-09-16T15:00:00Z", ss_quote_pdf_url: null, ghl_estimate_number: null, contact: CONTACT, contact_id: null,
  selections: { style: "Utility", size: "10x12" }, sales_location_id: "L1", image_url: null, expected_close_date: null, ...over,
});

// Mutable per scenario.
const S = { lookupEnabled: true, designs: {}, verifyReplies: [], locationReplies: [], sendInvoiceReply: null, acceptReplies: [] };
const calls = [];     // { fn, body } for every portal-settings / customer-* call
const restReads = []; // every REST GET url
const dialogs = [];   // { message, accepted }
let dialogAnswers = [];   // true = accept, false = dismiss; empty = accept

const { ok, failed, results } = reporter();
const { browser, ctx } = await launch({ width: 1400, height: 1000 });
await ctx.addInitScript(([ref, s, client]) => {
  try {
    localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s));
    localStorage.setItem("ssq_token_" + client, "harness-customer-token-0123456789abcdef");
    localStorage.setItem("ssq_name_" + client, "Pat Tester");
  } catch (_e) { /* storage blocked */ }
}, [REF, SESSION, CLIENT]);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("dialog", async (d) => {
  const answer = dialogAnswers.length ? dialogAnswers.shift() : true;
  dialogs.push({ message: d.message(), accepted: answer });
  if (answer) await d.accept(); else await d.dismiss();
});

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  if (url.includes("/rest/v1/rpc/log_error")) return json(route, null);
  if (url.includes("/rest/v1/rpc/")) return json(route, false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
  if (url.includes("/rest/v1/")) {
    if (req.method() === "GET") restReads.push(decodeURIComponent(url));
    const table = (url.match(/\/rest\/v1\/([a-z_]+)/) || [])[1];
    const single = /vnd\.pgrst\.object/.test(req.headers()["accept"] || "");
    if (table === "designs") {
      const m = decodeURIComponent(url).match(/short_code=eq\.([A-Z0-9-]+)/);
      if (m) {
        const row = S.designs[m[1]] || null;
        return single ? (row ? json(route, row) : json(route, { message: "no rows" }, 406)) : json(route, row ? [row] : []);
      }
      return json(route, Object.values(S.designs));
    }
    if (table === "orders") return json(route, S.orders || []);
    if (table === "design_acceptances") return json(route, S.acceptances || []);
    return json(route, []);
  }
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null });
  }
  if (url.includes("/customer-auth")) return json(route, { ok: true, channels: ["sms"], defaultChannel: "sms" });
  if (url.includes("/customer-quotes")) {
    calls.push({ fn: "customer-quotes", body });
    return json(route, { ok: true, businessName: "Harness Barns", name: "Pat Tester", quotes: [{
      quoteRef: SS, estimateNumber: "SST-1041", status: "sent", canAccept: true, total: 9652.5, taxable: 9000, nonTaxable: 0,
      tax: 652.5, taxRate: 0.0725, taxLabel: "Sales tax", createdAt: "2026-09-16T15:00:00Z",
    }] });
  }
  if (url.includes("/customer-accept")) {
    calls.push({ fn: "customer-accept", body });
    const r = S.acceptReplies.shift() || { status: 200, body: { ok: true } };
    return json(route, r.body, r.status);
  }
  if (!url.includes("/portal-settings")) return json(route, { ok: true });
  const a = body.action;
  calls.push({ fn: "portal-settings", body });
  const nextOf = (queue, fallback) => { const r = queue.shift() || fallback; return json(route, r.body, r.status || 200); };
  switch (a) {
    case "status":
      return json(route, { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, invoiceInGhl: false,
        ghlInvoicingAllowed: false, ssQuoteNext: 1042, ssInvoiceNext: 2001, ssTaxRate: 6.5, ssTaxLabel: "Sales tax", businessAddress: {}, branding: {}, emailReady: true });
    case "crm_record": {
      const d = S.designs[body.id];
      if (!d) return json(route, { error: "That design no longer exists." }, 404);
      return json(route, { ok: true, clientId: CLIENT, designs: [d], contact: { id: null, name: CONTACT.name, phone: CONTACT.phone, email: CONTACT.email }, feed: [], team: [], orders: [] });
    }
    case "list_locations": return json(route, { ok: true, nextSerial: 100, locations: LOCS });
    case "tax_settings":
      return json(route, { ok: true, ssMode: true, lookupEnabled: S.lookupEnabled, configured: true, companyRatePct: 6.5, companyLabel: "Sales tax", dailyCap: 100, usage24h: 3, locations: LOCS });
    case "verify_tax": return nextOf(S.verifyReplies, { status: 500, body: { error: "unexpected verify_tax call" } });
    case "set_design_sales_location": return nextOf(S.locationReplies, { status: 500, body: { error: "unexpected set_design_sales_location call" } });
    case "orders_designs": {
      const rows = (body.shortCodes || []).map((c) => S.designs[c]).filter(Boolean);
      return json(route, { ok: true, designs: rows });
    }
    case "order_paperwork": return json(route, { ok: true, business: { name: "Harness Barns" }, colors: [], cladding: [], invoice: null });
    case "amendment_status": return json(route, { ok: true, gate: { open: false, signed: false } });
    case "send_invoice": return json(route, S.sendInvoiceReply || { ok: true, sent: true, invoiceNumber: "SSI-2001" });
    default: return json(route, { ok: true });
  }
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
if (process.env.SS_PORTAL_ARTIFACT) {
  const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
  await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
}

const card = () => page.locator("[data-quote-sales-tax]");
const cardText = async () => ((await card().count()) ? await card().first().innerText() : "");
const waitText = (s, timeout = 15000) => page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const actionCalls = (action) => calls.filter((c) => c.fn === "portal-settings" && c.body.action === action).map((c) => c.body);
const bootPortal = async () => {
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
};
const go = async (path) => {
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
};
const openRecord = async (code) => {
  await go(`/portal/designs/d-${code}`);
  await page.waitForFunction(() => document.body.innerText.includes("SUMMARY"), null, { timeout: 20000 }).catch(() => {});
};
const resetCalls = () => { calls.length = 0; restReads.length = 0; dialogs.length = 0; dialogAnswers = []; };

try {
  S.designs = { [SS]: design(SS), [GHL]: design(GHL, { ss_quote_number: null, ghl_estimate_number: 5012, estimate_lines: { lines: LINES, discount: 0 } }), [ACC]: design(ACC, { status: "accepted", accepted_at: "2026-09-16T18:00:00Z", ss_quote_number: "SST-1040" }) };
  await bootPortal();

  // A
  await openRecord(SS);
  ok("A: the Sales tax card renders on an SS quote", await page.waitForSelector("[data-quote-sales-tax]", { timeout: 20000 }).then(() => true, () => false));
  let t = await cardText();
  ok("A: tax line with rate and amount", /Sales tax \(7\.25%\)\s*\$652\.50/.test(t), t.slice(0, 120));
  ok("A: basis says the location's rate", t.includes("Hwy 65 Display rate"));
  ok("A: quote total from the design", /Quote total\s*\$9,652\.50/.test(t));
  ok("A: location picker shows the stored location", (await card().locator("select").inputValue().catch(() => "")) === "L1");
  ok("A: billed-lookup warning", t.includes("Avalara bills each verification"));
  ok("A: verify button", (await card().getByRole("button", { name: "Verify tax for the delivery address" }).count()) === 1);
  ok("A: no price anywhere in the card", !/\d+\s*(¢|cents)|\$0\.\d\d each/i.test(t));

  // B
  resetCalls();
  dialogAnswers = [false];
  await card().getByRole("button", { name: "Verify tax for the delivery address" }).click();
  await page.waitForTimeout(700);
  ok("B: first confirm names the cost and the address", dialogs[0] && /Avalara bills each verification/.test(dialogs[0].message) && dialogs[0].message.includes("1 Main St"), dialogs[0] && dialogs[0].message);
  ok("B: dismissing it calls nothing", actionCalls("verify_tax").length === 0);

  // C
  resetCalls();
  S.verifyReplies = [
    { status: 409, body: { error: "Quote SST-1041 has already been emailed.", reason: "quote_sent", quoteNumber: "SST-1041", totalCents: 965250 } },
    { status: 200, body: { ok: true, tax: TAX_VERIFIED, totalCents: 972900, previousTotalCents: 965250, resent: true, charged: false } },
  ];
  await card().getByRole("button", { name: "Verify tax for the delivery address" }).click();
  ok("C: success message with the totals from the response", await waitText("The quote total changed from $9,652.50 to $9,729.00. The updated quote was re-sent to the customer."));
  const vc = actionCalls("verify_tax");
  ok("C: two calls, the second with confirmResend", vc.length === 2 && !vc[0].confirmResend && vc[1].confirmResend === true && vc[1].shortCode === SS, JSON.stringify(vc));
  ok("C: second confirm names the quote and the re-send", dialogs.length === 2 && dialogs[1].message.includes("SST-1041") && /re-sends it to them/.test(dialogs[1].message), dialogs[1] && dialogs[1].message);
  t = await cardText();
  ok("C: tax line now the verified one", /Sales tax \(8\.1%\)\s*\$729\.00/.test(t), t.slice(0, 120));
  ok("C: basis says verified, with jurisdiction and date", t.includes("Verified for Bibb County, GA on Sep 17, 2026"));
  ok("C: quote total from the response", /Quote total\s*\$9,729\.00/.test(t));

  // D
  resetCalls();
  S.verifyReplies = [{ status: 502, body: { error: "The tax lookup failed — the tax service couldn't be reached. The quote is unchanged.", reason: "lookup_failed", failure: "network" } }];
  await card().getByRole("button", { name: "Verify tax for the delivery address" }).click();
  ok("D: the server's sentence is shown", await waitText("The tax lookup failed — the tax service couldn't be reached. The quote is unchanged."));
  t = await cardText();
  ok("D: tax line unchanged", /Sales tax \(8\.1%\)\s*\$729\.00/.test(t) && /Quote total\s*\$9,729\.00/.test(t));
  ok("D: no ask-an-admin suffix on the refusal", !/ask an owner or admin/.test(t));

  // E
  resetCalls();
  S.verifyReplies = [
    { status: 409, body: { error: "Confirm you want to run a billed lookup as this builder.", reason: "confirm_operator" } },
    { status: 200, body: { ok: true, tax: TAX_VERIFIED, totalCents: 972900, previousTotalCents: 972900, resent: false, charged: false } },
  ];
  await card().getByRole("button", { name: "Verify tax for the delivery address" }).click();
  ok("E: success after the operator confirm", await waitText("The quote total didn't change."));
  const ec = actionCalls("verify_tax");
  ok("E: second call carries confirmVerify", ec.length === 2 && !ec[0].confirmVerify && ec[1].confirmVerify === true, JSON.stringify(ec));
  ok("E: the operator confirm says AS", dialogs.length === 2 && /You are doing this AS/.test(dialogs[1].message));

  // F
  resetCalls();
  S.locationReplies = [
    { status: 409, body: { error: "Quote SST-1041 has already been emailed.", reason: "quote_sent", quoteNumber: "SST-1041", totalCents: 972900, newTotalCents: 958500 } },
    { status: 200, body: { ok: true, salesLocationId: "L2", tax: TAX_COMPANY, totalCents: 958500, resent: true } },
  ];
  await card().locator("select").selectOption("L2");
  ok("F: success message", await waitText("Sales location set to North Lot — quote total $9,585.00. The updated quote was re-sent to the customer."));
  const fc = actionCalls("set_design_sales_location");
  ok("F: two calls, locationId L2, the second with confirmResend", fc.length === 2 && fc[0].locationId === "L2" && !fc[0].confirmResend && fc[1].confirmResend === true, JSON.stringify(fc));
  ok("F: confirm names both totals", dialogs.length === 1 && dialogs[0].message.includes("from $9,729.00 to $9,585.00") && dialogs[0].message.includes("SST-1041"), dialogs[0] && dialogs[0].message);
  t = await cardText();
  ok("F: basis and total from the response", t.includes("Company rate") && /Quote total\s*\$9,585\.00/.test(t));
  ok("F: picker now on North Lot", (await card().locator("select").inputValue()) === "L2");

  // G
  S.lookupEnabled = false;
  await go("/portal/designs");
  await page.waitForTimeout(500);
  await openRecord(SS);
  await page.waitForSelector("[data-quote-sales-tax]", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  t = await cardText();
  ok("G: card still renders", t.includes("Quote total"));
  ok("G: lookups off: no warning, no button", !t.includes("Avalara bills") && !t.includes("Verify tax"), t);
  S.lookupEnabled = true;

  // H
  resetCalls();
  await go("/portal/designs");
  await page.waitForTimeout(500);
  await openRecord(GHL);
  await page.waitForTimeout(2000);
  const bodyText = await page.evaluate(() => document.body.innerText);
  ok("H: CRM-mode design record opened", bodyText.includes("SUMMARY"));
  ok("H: no Sales tax card", (await card().count()) === 0 && !bodyText.includes("SALES TAX"));
  ok("H: no tax read for it", !restReads.some((u) => u.includes("estimate_lines")) && actionCalls("tax_settings").length === 0, restReads.join(" | "));

  // I
  await go("/portal/designs");
  await page.waitForTimeout(500);
  await openRecord(ACC);
  await page.waitForSelector("[data-quote-sales-tax]", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  t = await cardText();
  ok("I: accepted quote says it keeps the agreed tax", t.includes("Accepted — this quote keeps the tax the customer agreed to."));
  ok("I: no picker, no verify", (await card().locator("select").count()) === 0 && !t.includes("Verify tax"));

  // J
  resetCalls();
  S.designs[ACC] = design(ACC, { status: "accepted", accepted_at: "2026-09-16T18:00:00Z", ss_quote_number: "SST-1040", estimate_lines: { lines: LINES, discount: 0, tax: TAX_VERIFIED }, total_cents: 972900, paint_colors: {} });
  S.orders = [{ id: "11111111-2222-4333-8444-555555555555", client_id: CLIENT, order_no: 1050, short_code: ACC, ordered_at: "2026-09-16T18:00:00Z", total_cents: 972900, total_source: "ss" }];
  S.acceptances = [{ subject: "quote", revision: 0, signer_name: "Pat Tester", accepted_at: "2026-09-16T18:00:00Z", total: 9729, method: "click", recorded_by_name: null,
    tax_rate: 0.081, tax_amount: 729, tax_jurisdiction: "Bibb County, GA", tax_source: "avalara" }];
  S.sendInvoiceReply = { ok: true, sent: true, invoiceNumber: "SSI-2001", issuedBy: "structurestudio",
    taxCheck: { status: "differs", verifiedRatePct: 8.35, agreedRatePct: 8.1, jurisdiction: "Bibb County, GA" } };
  await go("/portal/orders");
  await waitText("#1050", 20000);
  await page.locator("tbody").getByText("#1050").first().click();
  ok("J: order document basis line", await waitText("Verified for Bibb County, GA on Sep 17, 2026", 20000));
  ok("J: acceptance row reads the frozen tax columns", restReads.some((u) => u.includes("design_acceptances") && u.includes("tax_rate") && u.includes("tax_amount") && u.includes("tax_jurisdiction") && u.includes("tax_source")));
  ok("J: trail shows the tax inside the accepted total", await waitText("incl. $729.00 sales tax · 8.1% · Bibb County, GA · verified"));
  ok("J: paper trail shows the accepted tax", await waitText("$729.00 sales tax · 8.1% · Bibb County, GA · verified"));
  await page.getByRole("button", { name: "Create & send invoice" }).click();
  ok("J: invoice success message unchanged", await waitText("Invoice SSI-2001 sent — awaiting the customer's signature."));
  ok("J: tax check note beside it", await waitText("Tax check: Avalara's rate for the delivery address (Bibb County, GA) is 8.35%. The invoice keeps the rate the customer agreed to of 8.1% — nothing on it was changed."));
  ok("J: send_invoice body unchanged", JSON.stringify(actionCalls("send_invoice")) === JSON.stringify([{ action: "send_invoice", shortCode: ACC }]), JSON.stringify(actionCalls("send_invoice")));

  // K
  resetCalls();
  S.orders = [];
  S.sendInvoiceReply = { ok: true, sent: true, invoiceNumber: "SSI-2002", issuedBy: "structurestudio", taxCheck: { status: "failed", failure: "timeout" } };
  await go("/portal/designs/list");
  await waitText("SST-1040", 20000);
  const accRow = page.locator("tr", { hasText: "SST-1040" }).first();
  await accRow.getByRole("button", { name: "More actions" }).click();
  await page.getByText("Send invoice", { exact: true }).click();
  ok("K: Pipeline invoice success message", await waitText("Invoice SSI-2002 sent — SST-1040 is awaiting the customer's signature."));
  ok("K: failed tax check is a note", await waitText("Tax check: the rate for the delivery address couldn't be verified — the tax service didn't answer in time. The invoice keeps the rate the customer agreed to; nothing on it was changed."));

  // L
  resetCalls();
  S.acceptReplies = [{ status: 409, body: { error: "This quote was updated. Reload to see the current total before signing.", reason: "repriced", totalCents: 972900 } }];
  await page.goto(`${BASE}/my-quotes.html?client=${CLIENT}`, { waitUntil: "domcontentloaded" });
  ok("L: quotes list renders", await waitText("SST-1041", 20000));
  await page.getByRole("button", { name: "Review & Accept" }).click();
  await page.locator(".sign-panel input[type=text]").fill("Pat Tester");
  await page.locator(".sign-panel input[type=checkbox]").check();
  await page.getByRole("button", { name: "Accept Quote" }).click();
  ok("L: the server's sentence is shown", await waitText("This quote was updated. Reload to see the current total before signing."));
  const ac = calls.filter((c) => c.fn === "customer-accept").map((c) => c.body);
  ok("L: accept sent the total it displayed", ac.length === 1 && ac[0].expectedTotalCents === 965250 && ac[0].action === "accept_quote", JSON.stringify(ac));
  ok("L: still signed in (not bounced to the phone screen)", await page.evaluate(() => !document.getElementById("screen-quotes").hidden && document.getElementById("screen-phone").hidden));
  ok("L: Accept stays disabled", await page.getByRole("button", { name: "Accept Quote" }).isDisabled());
  const listsBefore = calls.filter((c) => c.fn === "customer-quotes").length;
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page.waitForTimeout(800);
  ok("L: Reload lists the quotes again", calls.filter((c) => c.fn === "customer-quotes").length === listsBefore + 1);

  ok("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
