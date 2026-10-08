// Moving a builder off GoHighLevel invoicing: the Quotes & Invoices card, driven for real (migration
// 280; Carolyn 2026-09-07, "All other builders will only have the option to invoice through SS").
//
// 280 changes the column default and nothing on this page. Each existing builder moves when the owner,
// or an operator viewing as them, saves Settings → CRM Connection → Estimates & Invoices with, if they
// have them, their own next estimate and invoice numbers: since migration 283 (Carolyn 2026-10-06) a
// blank number starts at 1000. The builder's tax rate is still required, and since 2026-10-09 it is
// SET on Company → Tax (save_company_tax): this card shows it as a read-only summary with a link there,
// and its save no longer posts it (portal-settings' guard reads the stored rate). This drives the
// COMPILED portal with Supabase stubbed at the network layer (no login, nothing leaves the machine)
// through the tenant shapes that move, and asserts what shows, what gets posted and what the page says
// back:
//
//   A. a grandfathered tenant (CRM mode on its row, no capability, no numbering, a rate on file): no
//      "through my CRM" checkbox, the numbering boxes in front of them (both read "1000" as the
//      placeholder), NO tax rate box but the summary of the stored rate with its link to Company →
//      Tax, no banner; the save posts invoiceInGhl false with exactly what was typed and NO tax key;
//      the success line says StructureStudio issues the paperwork now, and the card re-reads status
//   B. a tenant with NO settings row (status answers as portal-settings does for a missing row): the
//      same card; no rate on file, so the banner names Company → Tax and the save is refused with the
//      server's own sentence
//   C. a blank stored rate: the save posts no tax key and shows the server's sentence (not a generic
//      failure), and the banner's link opens Company → Tax in the same document
//   D. 0% on file is an answer: no banner, and the save goes through
//   E. the one tenant WITH the capability: the checkbox is there and on, no numbering is asked for, and
//      the save posts invoiceInGhl true and says the CRM keeps the paperwork
//   F. blank numbers with a tax rate (283): the help text says a blank starts at 1000, the previews
//      read 1000, the save posts "" for both starts and saves; the QuickBooks line shows only when
//      status says a QuickBooks company is connected
//   G. numbering already in use, boxes cleared: the previews name the counters the server keeps (a
//      blank never unsets a counter in use), not 1000
//
// The stub answers `save` with portal-settings' own refusal sentence (the tax rate, the one Estimates &
// Invoices guard left, copied from the handler) and judges it the way the handler does: by the rate in
// the body when one is sent, by the STORED rate when not. A page that only passes against a stub that
// says something the server never says would fail here.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/paperworkMove.mjs            (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<path to an older portal.app.compiled.js> serves that file instead, which is how to
// prove the checks can fire. Against the artifact from just before 283's card (ea0a0de0, the "e.g. 1041"
// placeholders and the three-part banner) A's banner and placeholder checks fail and the run stops at
// A's fill with no "1000" box to type into; F is the case that pins the new copy. Against the artifact
// from just before 217's capability (95e8351b~1, which shows every tenant the checkbox, on, with the
// numbering hidden behind it) A's first checks fail the same way. Against the artifact from just
// before the company rate moved to Company → Tax (2c203e02's), 14 checks fail: the summary, the
// banner's link and the "no tax key posted" checks in A, B, C, D and F.
//
// Tenants and numbers are made up. The repo is public.
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF } from "./lib.mjs";

const CLIENT = "harness-move-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// The SAVED row, as status reports it. `noRow` answers the way status does for a tenant with no
// client_settings row: CRM mode (anything but an explicit false), not allowed, nothing configured.
const S = { invoiceInGhl: true, allowed: false, crm: true, noRow: false, quoteNext: null, invoiceNext: null, taxPct: null, qbo: false };
const saves = [];
let statusReads = 0;

// portal-settings' one Quotes & Invoices refusal left since migration 283, word for word
// (supabase/functions/portal-settings/index.ts, the `save` action's guard). The two numbering
// refusals are gone: a blank start is stored NULL and allocated as 1000.
const NEED_TAX = "StructureStudio needs a sales tax rate before it can issue your invoices — set one so estimates can still be taxed if the delivery address can't be looked up. Enter 0% if you don't collect sales tax.";

const { ok, failed, results } = reporter();
const { browser, ctx } = await launch({ width: 1400, height: 1000 });
await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ } }, [REF, SESSION]);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
// Catch-all abort FIRST: Playwright runs matching routes in reverse registration order.
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  if (url.includes("/rest/v1/rpc/log_error")) return json(route, null);
  if (url.includes("/rest/v1/rpc/")) return json(route, false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
  }
  if (!url.includes("/portal-settings")) return json(route, { ok: true });
  const a = body.action;
  if (a === "status") {
    statusReads += 1;
    return json(route, {
      ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null,
      configured: S.crm && !S.noRow, hasApiKey: S.crm && !S.noRow, ghlLocationIdMasked: S.crm && !S.noRow ? "loc-••••1234" : null,
      invoiceInGhl: S.noRow ? true : S.invoiceInGhl, ghlInvoicingAllowed: S.noRow ? false : S.allowed,
      ssQuoteNext: S.quoteNext, ssQuotePrefix: "", ssInvoiceNext: S.invoiceNext, ssInvoicePrefix: "",
      ssTaxRate: S.taxPct, ssTaxLabel: "Sales tax", ssTaxDelivery: false, qboConnected: S.qbo,
      businessAddress: {}, branding: {}, emailReady: false,
    });
  }
  if (a === "save" && "invoiceInGhl" in body) {
    saves.push(body);
    // The server's rule (217): a tenant without the capability can only be written false.
    const nextInGhl = S.allowed && !S.noRow && Boolean(body.invoiceInGhl);
    const blank = (v) => String(v ?? "").trim() === "";
    // The handler's merged-state guard: the rate in the body when one is sent, the STORED one when
    // not (this card has not sent one since 2026-10-09). A builder with no row has no stored rate.
    const nextRate = "ssTaxRate" in body ? (blank(body.ssTaxRate) ? null : Number(body.ssTaxRate)) : (S.noRow ? null : S.taxPct);
    if (!nextInGhl && nextRate == null) return json(route, { error: NEED_TAX }, 400);
    Object.assign(S, {
      noRow: false, invoiceInGhl: nextInGhl,
      // The server's rule (283): a blank start over a counter already in use keeps the counter.
      quoteNext: blank(body.ssQuoteNext) ? S.quoteNext : Number(body.ssQuoteNext),
      invoiceNext: blank(body.ssInvoiceNext) ? S.invoiceNext : Number(body.ssInvoiceNext),
      taxPct: nextRate,
    });
    return json(route, { ok: true });
  }
  if (a === "tax_settings") {
    return json(route, { ok: true, ssMode: !S.invoiceInGhl, lookupEnabled: false, configured: true, companyRatePct: S.taxPct, companyLabel: "Sales tax", dailyCap: 100, usage24h: 0, locations: [] });
  }
  if (a === "list_ghl_pipelines") return json(route, { ok: true, pipelines: [] });
  return json(route, { ok: true });
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
if (process.env.SS_PORTAL_ARTIFACT) {
  const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
  await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
}

const text = () => page.evaluate(() => document.body.innerText);
const waitText = (s, timeout = 20000) => page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const CHECKBOX = "Estimates and invoices through my CRM";
const SAVE = "Save Estimate & Invoice Settings";
const boot = async (shape) => {
  Object.assign(S, { invoiceInGhl: true, allowed: false, crm: true, noRow: false, quoteNext: null, invoiceNext: null, taxPct: null, qbo: false }, shape);
  saves.length = 0;
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.getByText("Settings", { exact: true }).last().click();
  await page.waitForTimeout(900);
  await page.getByText("CRM Connection", { exact: true }).last().click();
  await waitText(SAVE);
  await page.waitForTimeout(400);
};
// The card's inputs, found by their placeholders (labels are siblings, not <label for>). Both number
// boxes read "1000" since 283: the quote box comes first in the card, the invoice box second.
const box = (placeholder) => page.locator(`input[placeholder="${placeholder}"]`).first();
const numberBoxes = () => page.locator('input[placeholder="1000"]');
const quoteBox = () => numberBoxes().nth(0);
const invoiceBox = () => numberBoxes().nth(1);
const fill = async ({ quote, invoice }) => {
  if (quote != null) await quoteBox().fill(quote);
  if (invoice != null) await invoiceBox().fill(invoice);
};
// The company rate is not a box on this card any more: a summary with a link to Company → Tax.
const summary = () => page.locator("[data-company-tax-summary]");
const TAX_KEYS = ["ssTaxRate", "ssTaxLabel", "ssTaxDelivery"];
const postsNoTax = (b) => !TAX_KEYS.some((k) => k in (b || {}));
const BANNER_TAX = "Before saving, set your sales tax rate in Company → Tax (0 counts).";
const QUOTE_HELP = "Pick up where your CRM or QuickBooks left off, or leave blank to start at 1000 (or carry on after your last estimate). Counts up by one per estimate.";
const INVOICE_HELP = "Invoices number separately from estimates. Leave blank to start at 1000 (or carry on after your last invoice).";
const QBO_HELP = "Connected to QuickBooks? Enter your next QuickBooks invoice number.";
const press = async () => {
  const before = statusReads;
  await page.getByRole("button", { name: SAVE }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Saving…"), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  return statusReads - before;
};
const SAVED_SS = "Saved — StructureStudio now issues your estimates and invoices.";
const SAVED_CRM = "Saved — your estimates and invoices are created in your CRM, exactly as before.";

try {
  // A — grandfathered, CRM-connected, no capability, no numbering, a rate on file (set on Company → Tax)
  await boot({ invoiceInGhl: true, allowed: false, crm: true, taxPct: 6.5 });
  let t = await text();
  ok("A: no \"through my CRM\" checkbox for a tenant without the capability", !t.includes(CHECKBOX));
  ok("A: the card says StructureStudio issues the paperwork", t.includes("StructureStudio issues your estimates and invoices."));
  ok("A: the numbering boxes (placeholder 1000) are in front of them", (await numberBoxes().count()) === 2);
  ok("A: there is no tax rate box on this card any more", (await box("e.g. 7.25").count()) === 0);
  const sumA = await summary().innerText().catch(() => "");
  ok("A: the stored rate is summarised", /6\.5%, shown on documents as “Sales tax”, not charged on delivery\./.test(sumA), sumA.replace(/\n/g, " | "));
  const hrefA = await summary().getByRole("link", { name: "Change it in Company → Tax" }).getAttribute("href").catch(() => null);
  ok("A: …with a link to Company → Tax", hrefA === "/portal/settings/tax", String(hrefA));
  ok("A: no banner while a rate is on file", !t.includes("Before saving, set"));
  ok("A: and none for numbers, nor a warning about restarting at 1", !/Before saving, set a starting/.test(t) && !/restarted at 1/.test(t));
  await fill({ quote: "3101", invoice: "7001" });
  let reread = await press();
  ok("A: one save was posted", saves.length === 1, `saves ${saves.length}`);
  const sa = saves[0] || {};
  ok("A: it asks for paperwork mode (invoiceInGhl false)", sa.invoiceInGhl === false, JSON.stringify(sa));
  ok("A: it carries exactly what was typed", sa.ssQuoteNext === "3101" && sa.ssInvoiceNext === "7001", JSON.stringify(sa));
  ok("A: and posts no tax key (the rate is Company → Tax's)", postsNoTax(sa), JSON.stringify(sa));
  ok("A: and names no CRM field (the connection is left alone)", !Object.keys(sa).some((k) => /^ghl/i.test(k)), Object.keys(sa).join(","));
  ok("A: the page says StructureStudio issues the paperwork now", await waitText(SAVED_SS, 5000));
  ok("A: the card re-reads status after the save", reread >= 1, `status reads ${reread}`);

  // B — no settings row at all
  await boot({ noRow: true, crm: false });
  t = await text();
  ok("B: no-row tenant: no checkbox", !t.includes(CHECKBOX));
  ok("B: no-row tenant: the numbering boxes are there, and the summary says no rate is set", (await numberBoxes().count()) === 2
    && (await summary().innerText().catch(() => "")).includes("Not set yet."));
  ok("B: no-row tenant: the banner names Company → Tax", t.includes(BANNER_TAX), (t.match(/Before saving[^\n]*/) || [""])[0]);
  await fill({ quote: "1", invoice: "1" });
  await press();
  const sb = saves[0] || {};
  ok("B: no-row tenant: the save posts paperwork mode with what was typed and no tax key", sb.invoiceInGhl === false && sb.ssQuoteNext === "1" && sb.ssInvoiceNext === "1" && postsNoTax(sb), JSON.stringify(sb));
  ok("B: no-row tenant: refused with the server's sentence until a rate is set", await waitText(NEED_TAX, 5000) && !(await text()).includes(SAVED_SS));

  // C — a blank stored rate: the server's sentence, no success; the banner's link
  await boot({ invoiceInGhl: true, allowed: false, crm: false });
  ok("C: blank stored rate: the banner shows", (await text()).includes(BANNER_TAX));
  await fill({ quote: "5001", invoice: "9001" });
  await press();
  ok("C: blank stored rate: the save was still posted, with no tax key (the server is the guard)", saves.length === 1 && postsNoTax(saves[0]), JSON.stringify(saves[0] || {}));
  ok("C: blank stored rate: the server's own sentence is shown", await waitText(NEED_TAX, 5000));
  t = await text();
  ok("C: blank stored rate: no success line, no generic failure text", !t.includes(SAVED_SS) && !/non-2xx/i.test(t));
  const bannerLink = page.locator("[data-company-tax-needed]").getByRole("link", { name: "Company → Tax" });
  ok("C: the banner links to Company → Tax", (await bannerLink.getAttribute("href").catch(() => null)) === "/portal/settings/tax");
  await page.evaluate(() => { window.__ssSameDoc = true; });
  await bannerLink.click().catch(() => {});
  ok("C: the link opens the Tax tab in the same document",
    await waitText("Tax — Your sales tax rate, and optional tax codes", 8000) && (await page.evaluate(() => window.__ssSameDoc === true))
      && new URL(page.url()).pathname === "/portal/settings/tax", page.url());

  // D — 0% on file is an answer
  await boot({ invoiceInGhl: true, allowed: false, crm: false, taxPct: 0 });
  ok("D: 0% on file: no banner, and the summary says 0%", !(await text()).includes("Before saving, set") && (await summary().innerText().catch(() => "")).includes("0%, shown on documents as"));
  await fill({ quote: "5001", invoice: "9001" });
  await press();
  ok("D: 0% on file: saved, with no tax key posted", saves.length === 1 && postsNoTax(saves[0]) && saves[0].invoiceInGhl === false && await waitText(SAVED_SS, 5000), JSON.stringify(saves[0] || {}));

  // E — the tenant with the capability keeps its choice
  await boot({ invoiceInGhl: true, allowed: true, crm: true });
  t = await text();
  ok("E: capable tenant: the checkbox is there", t.includes(CHECKBOX));
  ok("E: capable tenant: it is on", await page.getByRole("checkbox", { name: CHECKBOX }).isChecked());
  ok("E: capable tenant: no numbering asked for", (await numberBoxes().count()) === 0 && !t.includes("Before saving, set"));
  ok("E: capable tenant in CRM mode: no tax summary (the CRM works the tax out)", (await summary().count()) === 0);
  await press();
  ok("E: capable tenant: the save posts invoiceInGhl true", saves.length === 1 && saves[0].invoiceInGhl === true, JSON.stringify(saves[0] || {}));
  ok("E: capable tenant: the page says the CRM keeps the paperwork", await waitText(SAVED_CRM, 5000));

  // F — blank numbers, a tax rate on file: saved, and the card says what a blank means (283)
  await boot({ invoiceInGhl: true, allowed: false, crm: false, taxPct: 6 });
  t = await text();
  ok("F: the quote help says a blank starts at 1000", t.includes(QUOTE_HELP), (t.match(/Pick up where[^\n]*/) || [""])[0]);
  ok("F: the invoice help says a blank starts at 1000", t.includes(INVOICE_HELP), (t.match(/Invoices number separately[^\n]*/) || [""])[0]);
  ok("F: the previews read 1000 for both books", t.includes("Shows on the document as 1000.") && t.includes("Shows on the invoice as 1000."));
  ok("F: no QuickBooks line without a connected company", !t.includes(QBO_HELP));
  ok("F: with a rate on file and both numbers blank, no banner at all", !t.includes("Before saving, set"));
  await press();
  const sf = saves[0] || {};
  ok("F: the save posts \"\" for both starts, paperwork mode and no tax key", saves.length === 1 && sf.ssQuoteNext === "" && sf.ssInvoiceNext === "" && postsNoTax(sf) && sf.invoiceInGhl === false, JSON.stringify(sf));
  ok("F: and it saves", await waitText(SAVED_SS, 5000));
  // The same card for a tenant whose QuickBooks company is connected: the invoice help asks for the
  // next QuickBooks number (send_invoice refuses a blank start while the push would run).
  await boot({ invoiceInGhl: false, allowed: false, crm: false, taxPct: 6, qbo: true });
  t = await text();
  ok("F: QuickBooks connected: the invoice help asks for the next QuickBooks invoice number", t.includes(`${INVOICE_HELP} ${QBO_HELP}`), (t.match(/Invoices number separately[^\n]*/) || [""])[0]);
  ok("F: QuickBooks connected: the quote help is unchanged", t.includes(QUOTE_HELP));

  // G — numbering already in use, both boxes cleared: the previews show the numbers the server keeps
  // (a blank never unsets a counter in use, 283), never a 1000 that will not happen
  await boot({ invoiceInGhl: false, allowed: false, crm: false, taxPct: 6, quoteNext: 1043, invoiceNext: 2001 });
  ok("G: the boxes load the counters in use", (await quoteBox().inputValue()) === "1043" && (await invoiceBox().inputValue()) === "2001");
  await quoteBox().fill("");
  await invoiceBox().fill("");
  t = await text();
  ok("G: cleared, the previews show the counters kept, not 1000", t.includes("Shows on the document as 1043.") && t.includes("Shows on the invoice as 2001.") && !t.includes("Shows on the document as 1000."), (t.match(/Shows on the[^\n]*/g) || []).join(" | "));
  await press();
  ok("G: the save posts the blanks and saves", saves.length === 1 && saves[0].ssQuoteNext === "" && saves[0].ssInvoiceNext === "" && await waitText(SAVED_SS, 5000), JSON.stringify(saves[0] || {}));
  t = await text();
  ok("G: after the save the previews still name the kept counters", t.includes("Shows on the document as 1043.") && t.includes("Shows on the invoice as 2001."));

  ok("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
